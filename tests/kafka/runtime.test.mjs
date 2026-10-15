import assert from "node:assert/strict";
import test from "node:test";
import {registerHooks} from "node:module";
import {EventEmitter} from "node:events";
import {readFileSync} from "node:fs";
import {load as parseYaml} from "js-yaml";
import {createNativeConsumer} from "../../packages/platform-kafka-runtime/dist/native.js";
import {KafkaRuntimeError, createKafkaRuntime, processKafkaRecord} from "../../packages/platform-kafka-runtime/dist/index.js";
import {parsePlatformConfig} from "../../packages/platform-config/src/index.ts";
import {metrics, trace} from "@opentelemetry/api";
const subject = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const value = {envelopeVersion:"1",messageId:"msg_01ARZ3NDEKTSV4RRFFQ69G5FB1",messageType:"RealtimeInvalidated.v1",occurredAt:"2026-09-05T10:06:00Z",producer:"orders-service",correlationId:"77777777-7777-4777-8777-777777777777",causationId:null,traceparent:"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",aggregate:{type:"Order",ref:subject,version:"19"},payload:{subjectType:"order",subjectRef:subject,ownerVersion:"19",reason:"OrderChanged"}};
const record = {topic:"coffee.realtime.invalidate.v1",partition:0,offset:"1",key:subject,value:JSON.stringify(value),headers:{}};
void test("runtime bounds realtime DLQ wire and falls back from invalid transport keys",{timeout:10000},async()=>{
 const config=parsePlatformConfig(parseYaml(readFileSync(new URL("../../config/platform.yaml",import.meta.url),"utf8")));
 const topic=config.kafka.topics.realtimeInvalidate.name;
 const observed=[],ages=[];let observeLag;
 assert.equal(metrics.setGlobalMeterProvider({getMeter(){return {createHistogram(name){return {record(value,attributes){if(name==="messaging.kafka.event.age")ages.push({value,attributes});}};},createObservableGauge(name){return {addCallback(callback){if(name==="messaging.kafka.consumer.lag")observeLag=callback;}};}};}}),true);
 const inputs=[
  {label:"near-limit wire",topic,value:Buffer.from("x".repeat(config.kafka.delivery.maxMessageBytes-256)),key:subject},
  {label:"oversized raw wire",topic,value:Buffer.from("x".repeat(config.kafka.delivery.maxMessageBytes+1)),key:subject},
  {label:"long key",topic,value:Buffer.from("invalid"),key:"k".repeat(257)},
 ];
 const events=[];let consumed=0,latestConsumer;
 class Producer extends EventEmitter {
  isConnected(){return true;}
  connect(_options,callback){callback(null);}
  produce(topic,_partition,value,key,_timestamp,opaque){
   const envelope=JSON.parse(Buffer.from(value).toString("utf8"));
   events.push({kind:"dlq",topic,key,envelope});
   queueMicrotask(()=>this.emit("delivery-report",null,{topic,partition:0,offset:9,opaque}));
  }
  disconnect(callback){callback(null);}
 }
 class Consumer extends EventEmitter {
  constructor(config){super();this.config=config;this.watermarks=new Map();latestConsumer=this;}
  setDefaultConsumeTimeout(){}
  setDefaultIsTimeoutOnlyForFirstMessage(){}
  isConnected(){return true;}
  getMetadata(_options,callback){callback(this.failMetadata?Error("metadata failed"):null,{});}
  getWatermarkOffsets(topic,partition){if(this.throwWatermark)throw Error("watermark failed");return this.watermarks.get(`${topic}:${partition}`)??null;}
  connect(_options,callback){callback(null);}
  subscribe(){this.config.rebalance_cb(null,[{topic,partition:0}]);}
  consume(_limit,callback){setTimeout(()=>{const input=inputs[consumed++];callback(null,input?[{topic,partition:0,offset:consumed,key:Buffer.from(input.key),value:input.value,headers:{}}]:[]);},1);}
  commitCb(offsets,callback){events.push({kind:"offset",offsets});this.emit("offset.commit",null,offsets);callback(null);}
  assign(){}
  unassign(){}
  pause(){}
  resume(){}
  disconnect(callback){callback(null);}
 }
 const nativeKey=Symbol.for("coffee.kafka-dlq-regression");globalThis[nativeKey]={Producer,KafkaConsumer:Consumer};
 const url=`data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.kafka-dlq-regression")];export default {RdKafka};')}`;
 const hook=registerHooks({resolve(specifier,context,next){return specifier==="@confluentinc/kafka-javascript"?{url,shortCircuit:true}:next(specifier,context);}});
 const runtime=createKafkaRuntime({runtime:"realtime-gateway",config:config.kafka,service:config.services["realtime-gateway"].kafka,credentials:{username:"u",password:"p"}});
 try{
  runtime.bind("realtime-gateway-v1",{processing:"realtime",decode:()=>{throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");},enqueue:async()=>assert.fail("enqueue")});
  await runtime.resource.start(AbortSignal.timeout(5000));
  latestConsumer.emit("event.stats",{message:JSON.stringify({topics:{[topic]:{partitions:{"0":{consumer_lag:7},"1":{consumer_lag:0},"24":{consumer_lag:999}}},"canary.topic":{partitions:{"0":{consumer_lag:999}}}}})});
  observeLag({observe(metricValue,attributes){observed.push({value:metricValue,attributes});}});
  assert.deepEqual(observed,[
   {value:7,attributes:{"messaging.consumer.group":"realtime-gateway-v1","messaging.destination.name":topic,"messaging.destination.partition.id":"0"}},
   {value:0,attributes:{"messaging.consumer.group":"realtime-gateway-v1","messaging.destination.name":topic,"messaging.destination.partition.id":"1"}},
  ]);
  latestConsumer.emit("event.stats",{message:JSON.stringify({topics:{[topic]:{partitions:{"0":{consumer_lag:-1},"1":{consumer_lag:0}}}}})});
  observed.length=0;observeLag({observe(metricValue,attributes){observed.push({value:metricValue,attributes});}});
  assert.deepEqual(observed,[{value:0,attributes:{"messaging.consumer.group":"realtime-gateway-v1","messaging.destination.name":topic,"messaging.destination.partition.id":"1"}}]);
  const deadline=Date.now()+3000;
  while(events.filter((event)=>event.kind==="offset").length<inputs.length&&Date.now()<deadline)await new Promise((resolve)=>setTimeout(resolve,1));
  assert.deepEqual(events.filter((event)=>event.kind==="dlq"||event.kind==="offset").map((event)=>event.kind),inputs.flatMap(()=>["dlq","offset"]));
  const dlqs=events.filter((event)=>event.kind==="dlq");
  for(const dlq of dlqs){assert.equal(dlq.topic,config.kafka.topics.realtimeInvalidate.dlq);assert.ok(Buffer.byteLength(JSON.stringify(dlq.envelope))<=config.kafka.delivery.maxMessageBytes);}
  assert.equal(dlqs[0].envelope.payload.wire.digest!==undefined,true);
  assert.equal(dlqs[0].envelope.payload.wire.byteLength,inputs[0].value.byteLength);
  assert.equal(dlqs[1].envelope.payload.wire.digest!==undefined,true);
  assert.equal(dlqs[1].envelope.payload.wire.byteLength,inputs[1].value.byteLength);
  assert.equal(dlqs[2].key,dlqs[2].envelope.messageId);
  const nativeOptions={brokers:["fixture:9092"],clientId:"latest-health-regression",protocol:"PLAINTEXT",maxPending:32,maxMessageBytes:2048,sendTimeoutMs:5000,receiveTimeoutMs:1000,commitTimeoutMs:5000,shutdownTimeoutMs:20000,groupId:"realtime-gateway-v1",topics:[topic],autoOffsetReset:"latest"};
  const latest=await createNativeConsumer(nativeOptions,()=>{});
  try{
   await latest.connect();assert.equal(await latest.health(),false,"latest requires an assignment");
   const client=latestConsumer;client.config.rebalance_cb(null,[{topic,partition:0},{topic,partition:1}]);
   assert.equal(await latest.health(),false,"latest requires fetched high watermarks");
   client.watermarks.set(`${topic}:0`,{highOffset:12});client.watermarks.set(`${topic}:1`,{highOffset:8});
   assert.equal(await latest.health(),true,"all assigned partitions have fetched watermarks");
   client.failMetadata=true;assert.equal(await latest.health(),false,"metadata errors fail closed");client.failMetadata=false;
   client.throwWatermark=true;assert.equal(await latest.health(),false,"watermark errors fail closed");
   client.throwWatermark=false;client.watermarks.set(`${topic}:1`,{highOffset:-1});assert.equal(await latest.health(),false,"invalid watermarks fail closed");
  }finally{await latest.close();}
  const earliest=await createNativeConsumer({...nativeOptions,clientId:"earliest-health-regression",autoOffsetReset:"error"},()=>{});
  try{await earliest.connect();assert.equal(await earliest.health(),true,"non-latest reset keeps metadata-only health");}
  finally{await earliest.close();}
 }finally{
  await runtime.resource.stop(AbortSignal.timeout(5000)).catch(()=>runtime.resource.destroy());hook.deregister();delete globalThis[nativeKey];
 }
 await processKafkaRecord(record,options());
 assert.equal(ages.length,1);assert.equal(ages[0].attributes["messaging.destination.name"],record.topic);assert.equal(ages[0].attributes["messaging.consumer.group"],"realtime-gateway-v1");
 observed.length=0;observeLag({observe(metricValue,attributes){observed.push({value:metricValue,attributes});}});assert.deepEqual(observed,[]);
 metrics.disable();
});

void test("native consumer bounds idle Fetch wait without changing receive/commit budgets or auto commit",async()=>{
 const capture={};globalThis[Symbol.for("coffee.native-config-capture")]=capture;
 class Consumer extends EventEmitter {constructor(config){super();capture.config=config;capture.instance=this;}setDefaultConsumeTimeout(ms){capture.consumeTimeout=ms;}setDefaultIsTimeoutOnlyForFirstMessage(value){assert.equal(value,true);}commitCb(){}}
 const key=Symbol.for("coffee.native-config-regression");globalThis[key]={Producer:class {},KafkaConsumer:Consumer};
 const url=`data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.native-config-regression")];export default {RdKafka};')}`;
 const hook=registerHooks({resolve(specifier,context,next){return specifier==="@confluentinc/kafka-javascript"?{url,shortCircuit:true}:next(specifier,context);}});
 try{
  for(const receiveTimeoutMs of [1,50,1000]){
   const options={brokers:["fixture:9092"],clientId:"native-config-regression",protocol:"PLAINTEXT",maxPending:32,maxMessageBytes:2048,sendTimeoutMs:5000,receiveTimeoutMs,commitTimeoutMs:5000,shutdownTimeoutMs:20000,groupId:"realtime-gateway-v1",topics:[record.topic],autoOffsetReset:"latest"};
   const stats=[];await createNativeConsumer(options,()=>{},value=>stats.push(value));
   const {config:captured,consumeTimeout}=capture;
   assert.equal(captured["fetch.wait.max.ms"],Math.min(100,receiveTimeoutMs));assert.equal(captured["request.timeout.ms"],receiveTimeoutMs);assert.equal(captured["enable.auto.commit"],false);assert.equal(captured["enable.auto.offset.store"],false);assert.equal(captured["allow.auto.create.topics"],false);assert.equal(captured["offset_commit_cb"],true);assert.equal(captured["statistics.interval.ms"],receiveTimeoutMs);assert.ok(consumeTimeout>=1&&consumeTimeout<=10);
   const snapshot={topics:{[record.topic]:{partitions:{"0":{consumer_lag:12}}}}};
   capture.instance.emit("event.stats",{message:JSON.stringify(snapshot)});assert.deepEqual(stats,[snapshot]);
   for(const malformed of [snapshot,{message:"{"},{message:JSON.stringify([])},{message:JSON.stringify(null)}])
    assert.doesNotThrow(()=>capture.instance.emit("event.stats",malformed));
   assert.deepEqual(stats,[snapshot]);
  }
 }finally{hook.deregister();delete globalThis[key];delete globalThis[Symbol.for("coffee.native-config-capture")];}
});
function options(overrides={}) {
 const seen=[];
 return {seen,runtime:"realtime-gateway",groupId:"realtime-gateway-v1",topics:[record.topic],leaseMs:30000,maxMessageBytes:1048576,signal:new AbortController().signal,
 binding:{processing:"realtime",decode:(v,r)=>{assert.equal(r, record);return v;},enqueue:async()=>{seen.push("enqueue");}},quarantine:async()=>{seen.push("quarantine");},commit:async()=>{seen.push("offset");},...overrides};
}
void test("realtime decode receives the actual transport record before enqueue and offset",async()=>{
 const o=options();await processKafkaRecord(record,o);assert.deepEqual(o.seen,["enqueue","offset"]);
});
void test("realtime decoder programming failures are not permanent rejection",async()=>{
 const o=options({binding:{processing:"realtime",decode:()=>{throw new Error("synthetic programming error");},enqueue:async()=>assert.fail("enqueue")}});
 await assert.rejects(processKafkaRecord(record,o),/synthetic programming error/);assert.deepEqual(o.seen,[]);
});
void test("invalid realtime record commits only after quarantine ACK; failure or revoke cannot commit",async()=>{
 for(const mode of ["ok","failed","revoked"]){
  const controller=new AbortController();const o=options({signal:controller.signal,binding:{processing:"realtime",decode:()=>{throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");},enqueue:async()=>assert.fail("enqueue")}});
  o.quarantine=async()=>{o.seen.push("quarantine");if(mode==="failed")throw Error("lost ACK");if(mode==="revoked")controller.abort();};
  if(mode==="ok"){await processKafkaRecord(record,o);assert.deepEqual(o.seen,["quarantine","offset"]);}
  else{await assert.rejects(processKafkaRecord(record,o));assert.deepEqual(o.seen,["quarantine"]);}
 }
});
void test("consumer span follows the validated envelope parent and ends after commit failure",async()=>{
 const ended=[];
 assert.equal(trace.setGlobalTracerProvider({getTracer(){return {startSpan(name,options,parent){const span={name,attributes:{...options.attributes},parentSpanContext:trace.getSpanContext(parent),setAttribute(key,value){this.attributes[key]=value;},setStatus(){},end(){ended.push(this);}};return span;}};}}),true);
 const o=options({commit:async()=>{throw Error("synthetic offset failure");}});
 await assert.rejects(processKafkaRecord(record,o),{code:"OFFSET_COMMIT_OUTCOME_UNKNOWN"});
 assert.equal(ended.length,1);
 const span=ended[0];
 assert.equal(span.name,"Kafka.consume");
 assert.equal(span.parentSpanContext.traceId,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
 assert.equal(span.parentSpanContext.spanId,"bbbbbbbbbbbbbbbb");
 assert.equal(span.attributes["messaging.kafka.result"],"failed");
 assert.equal(span.attributes["messaging.destination.name"],record.topic);
 assert.equal(Object.keys(span.attributes).some(key=>/message|key|offset|partition|order|error.message/i.test(key)),false);
 trace.disable();
});
