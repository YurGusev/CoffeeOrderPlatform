import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fixture,login,request,until,nativeProducer,envelopeValidator} from './transport.mjs';
import {createDatabase} from '../../../packages/platform-database/dist/index.js';
import {createSqlOutboxStore} from '../../../packages/platform-outbox/dist/index.js';
import {createKafkaRuntime} from '../../../packages/platform-kafka-runtime/dist/index.js';
import {createNativeProducer} from '../../../packages/platform-kafka-runtime/dist/native.js';
import {canonicalJson} from '../../../packages/platform-idempotency/dist/index.js';

// A pinned native sender for the real owner Outbox, not a synthetic envelope source.
const action=process.argv[2];
if(action==='login'){
  await until(async()=>{for(const service of ['edge-gateway','api-public','realtime-gateway']){const r=await request(service,fixture.config.services[service].listen.port,'/health/ready',{timeout:1000});assert.equal(r.status,200);}return true;},{timeout:45000,label:'actual scoped composition readiness'});
  console.log(await login());
}else if(action==='replay-original'){
  let input='';for await(const chunk of process.stdin){input+=chunk;assert.ok(Buffer.byteLength(input)<=16384,'bounded persisted replay input');}
  const record=JSON.parse(input),envelope=record.envelope;
  assert.equal(record.topic,fixture.config.kafka.topics.realtimeInvalidate.name);assert.equal(record.partition_key,envelope.aggregate.ref);
  (await envelopeValidator())(envelope);
  const producer=await nativeProducer();let cleanupFailure,ack;
  try{ack=await producer.send(record.topic,record.partition_key,JSON.stringify(envelope),{messageId:envelope.messageId,messageType:envelope.messageType,correlationId:envelope.correlationId,traceparent:envelope.traceparent},AbortSignal.timeout(5000));}
  finally{await producer.close().catch(error=>{cleanupFailure=error;});}
  if(cleanupFailure)throw cleanupFailure;
  console.log(JSON.stringify({...ack,messageId:envelope.messageId}));
}else if(action==='publish-orders'){
  let input='';for await(const chunk of process.stdin){input+=chunk;assert.ok(Buffer.byteLength(input)<=1_048_576,'bounded source event input');}
  const events=JSON.parse(input);assert.ok(Array.isArray(events)&&events.length>0&&events.length<=4,'bounded synthetic Orders source events');
  const topics={'CatalogMappingChanged.v2':fixture.config.kafka.topics.catalogMapping.name,'OrderConfirmed.v1':fixture.config.kafka.topics.ordersLifecycle.name,'AromaObservationChanged.v1':fixture.config.kafka.topics.aromaEvents.name};
  const producer=await createNativeProducer({brokers:fixture.config.kafka.brokers,protocol:'SASL_SSL',username:fixture.credentials.orders.username,password:fixture.credentials.orders.password,sslCaPem:fixture.credentials.orders.caPem,clientId:`g14-orders-source-${process.pid}`,maxPending:16,maxMessageBytes:1048576,sendTimeoutMs:5000,receiveTimeoutMs:5000,commitTimeoutMs:5000,shutdownTimeoutMs:10000,producerRetries:3});
  const receipts=[];let cleanupFailure;
  try{
    await producer.connect();
    for(const event of events){
      const topic=topics[event?.messageType];assert.ok(topic,'source event has a configured actual Orders consumer topic');
      assert.equal(typeof event.messageId,'string');assert.equal(typeof event.correlationId,'string');
      const ack=await producer.send(topic,event.aggregate.ref,canonicalJson(event),{messageId:event.messageId,messageType:event.messageType,correlationId:event.correlationId,traceparent:event.traceparent},AbortSignal.timeout(10000));
      receipts.push({topic,partition:ack.partition,offset:ack.offset,messageIdSha256:createHash('sha256').update(event.messageId).digest('hex')});
    }
  }finally{await producer.close().catch(error=>{cleanupFailure=error;});}
  if(cleanupFailure)throw cleanupFailure;
  console.log(JSON.stringify(receipts));
}else if(action==='relay'){
  const runtime='orders-aroma-preparation';
  const connection=JSON.parse(await readFile('/owner-publisher.json','utf8'));
  const database=createDatabase(connection);
  const service=fixture.config.services[runtime].kafka;
  const kafka=createKafkaRuntime({runtime,config:fixture.config.kafka,service,credentials:fixture.credentials.publisher});
  const signal=AbortSignal.timeout(30000);
  let cleanupFailure;
  try{
    await database.resource.start(signal);await kafka.resource.start(signal);
    assert.equal(await kafka.readiness.check(signal),true,'native publisher must be broker-ready before claiming owner Outbox');
    // Only the owning realtime topic; provider commands are outside this proof.
    const topics=[fixture.config.kafka.topics.realtimeInvalidate.name];
    const outbox=createSqlOutboxStore(database,{schema:'orders',envelopeBytes:true,topics});
    const totals={claimed:0,published:0,failed:0,unknown:0,quarantined:0};let drained=false;
    for(let cycle=0;cycle<100;cycle++){
      const result=await kafka.relay(outbox,database,signal);
      const receipt=JSON.stringify({action,result,metrics:kafka.metrics()});
      assert.equal(result.failed,0,receipt);assert.equal(result.unknown,0,receipt);assert.equal(result.quarantined,0,receipt);
      for(const key of Object.keys(totals))totals[key]+=result[key];
      if(result.claimed===0){drained=true;break;}
    }
    assert.equal(drained,true,'bounded owner Outbox drain');assert.ok(totals.published>0);
    console.log(JSON.stringify(totals));
  }finally{
    const cleanup=await Promise.allSettled([kafka.resource.stop(AbortSignal.timeout(10000)),database.resource.stop(AbortSignal.timeout(10000))]);
    cleanupFailure=cleanup.find(result=>result.status==='rejected');
  }
  if(cleanupFailure)throw cleanupFailure.reason;
}else throw new Error('OWNER_PROOF_ACTION_INVALID');
