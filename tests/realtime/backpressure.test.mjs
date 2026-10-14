import assert from "node:assert/strict";
import test from "node:test";
import {RealtimeHub,RealtimeCapacityError} from "../../apps/realtime-gateway/dist/index.js";
import {config,Sink,turn,sleep,until,envelope,record} from "./helpers.mjs";
const options=(signal=new AbortController().signal)=>({signal,validateActor:()=>true});
const publish=(hub,e)=>hub.binding.enqueue(hub.binding.decode(e,record(e)),new AbortController().signal);
void test("live fanout yields to other I/O across clients before finishing the entire cohort",async t=>{
 const hub=new RealtimeHub({...config,coalesceMs:5});t.after(()=>hub.destroy());
 const sinks=[],observed=[],buffers=[];let writes=0;
 for(let n=0;n<128;n++){
  const sink=new Sink(),write=sink.write.bind(sink);
  sink.write=(chunk,callback)=>{
   if(chunk.includes("event: resource-invalidated.v1")){
    writes++;buffers.push(chunk);if(writes===1)setImmediate(()=>observed.push(writes));
   }
   return write(chunk,callback);
  };
  sinks.push(sink);hub.open(sink,options());
 }
 await until(()=>sinks.every(sink=>sink.frames.some(frame=>frame.includes("stream-ready.v1"))));
 for(let n=1;n<=6;n++)await publish(hub,envelope(n,String(n),`ord_${String(n).padStart(26,"0")}`));
 await until(()=>writes===sinks.length&&observed.length===1);
 assert.ok(observed[0]>0&&observed[0]<sinks.length,"other I/O must run before every client's TLS write is initiated");
 assert.equal(buffers.length,128);for(const buffer of buffers)assert.strictEqual(buffer,buffers[0]);
 const expected=[1,2,3,4,5,6].map(n=>`id: ${envelope(n,String(n),`ord_${String(n).padStart(26,"0")}`).messageId}\n`).join("");
 assert.equal(buffers[0].toString("utf8").match(/^event: resource-invalidated.v1$/gm)?.length,6);
 assert.equal([...buffers[0].toString("utf8").matchAll(/^id: (.+)$/gm)].map(match=>`${match[0]}\n`).join(""),expected);
 assert.equal(Buffer.byteLength(buffers[0].toString("utf8"),"utf8"),buffers[0].byteLength);
 for(const sink of sinks)assert.equal((sink.frames.join("").match(/^event: resource-invalidated.v1$/gm)??[]).length,6);
 await until(()=>hub.stats().queuedRecords===0);assert.equal(hub.stats().queuedBytes,0);
 await hub.shutdown();
});
void test("replacing a queued live hint preserves selected Kafka order and the newest reconnect cursor",async t=>{
 const hub=new RealtimeHub({...config,coalesceMs:5});t.after(()=>hub.destroy());const callbacks=[];
 const sink=new Sink();sink.write=(chunk,callback)=>{sink.frames.push(Buffer.isBuffer(chunk)?chunk.toString("utf8"):chunk);callbacks.push(callback);return true;};
 hub.open(sink,options());await turn();
 const a=`ord_${String(1).padStart(26,"0")}`,b=`ord_${String(2).padStart(26,"0")}`;
 await publish(hub,envelope(1,"1",a));await publish(hub,envelope(2,"1",b));await sleep(15);
 await publish(hub,envelope(3,"2",a));await sleep(15);
 assert.equal(hub.stats().queuedRecords,3,"ready and two selected hints remain bounded");
 callbacks.shift()();await turn();
 const ids=[...sink.frames.at(-1).matchAll(/^id: (.+)$/gm)].map(m=>m[1]);
 assert.deepEqual(ids,[envelope(2,"1",b).messageId,envelope(3,"2",a).messageId]);
 callbacks.shift()();await turn();assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
});
void test("queued live hints share one bounded write; all in-flight frames remain immutable until its callback",async t=>{
 const hub=new RealtimeHub({...config,coalesceMs:5});t.after(()=>hub.destroy());const callbacks=[],buffers=[];
 const sink=new Sink();sink.write=(chunk,callback)=>{buffers.push(chunk);sink.frames.push(Buffer.isBuffer(chunk)?chunk.toString("utf8"):chunk);callbacks.push(callback);return true;};
 hub.open(sink,options());await turn();callbacks.shift()();await turn();
 const refs=[1,2,3].map(n=>`ord_${String(n).padStart(26,"0")}`);
 for(let n=0;n<refs.length;n++)await publish(hub,envelope(n+1,String(n+1),refs[n]));
 await until(()=>sink.frames.at(-1).includes("event: resource-invalidated.v1"));assert.equal((sink.frames.at(-1).match(/^event: resource-invalidated.v1$/gm)??[]).length,3);
 const inFlight=buffers.at(-1),inFlightBytes=Buffer.from(inFlight);
 assert.equal(hub.stats().queuedRecords,3);
 await publish(hub,envelope(4,"4",refs[2]));await until(()=>hub.stats().queuedRecords===4);assert.equal(hub.stats().queuedRecords,4,"pending replacement cannot overwrite any in-flight batch member");
 assert.deepEqual(inFlight,inFlightBytes,"replacing a queued hint must not mutate an in-flight Buffer");
 callbacks.shift()();await turn();assert.equal(hub.stats().queuedRecords,1);assert.match(sink.frames.at(-1),/"ownerVersion":"4"/);
 callbacks.shift()();await turn();assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
 const connection=[...hub.connections][0];
 const first={text:"first\n",bytes:6},middleA={text:"mid-a\n",bytes:6},middleB={text:"mid-b\n",bytes:6},last={text:"last\n",bytes:5};
 for(const entry of [first,middleA,last])assert.equal(connection.enqueue(entry),true);
 await turn();const edgeBatch=buffers.at(-1);assert.equal(edgeBatch.toString("utf8"),"first\nmid-a\nlast\n");callbacks.shift()();await turn();
 for(const entry of [first,middleB,last])assert.equal(connection.enqueue(entry),true);
 await turn();const differentInteriorBatch=buffers.at(-1);assert.notStrictEqual(differentInteriorBatch,edgeBatch,"same first/last frames must not reuse a batch with a different interior frame");
 assert.equal(differentInteriorBatch.toString("utf8"),"first\nmid-b\nlast\n");callbacks.shift()();await turn();
});
void test("stalled write callback and false-without-drain both hit deadline; fast peer remains independent",async()=>{
 for(const mode of ["callback","drain"]){
  const hub=new RealtimeHub({...config,writeTimeoutMs:20,coalesceMs:5});const slow=new Sink();slow.callbackBlocked=mode==="callback";slow.blocked=mode==="drain";
  hub.open(slow,options());const fast=new Sink();hub.open(fast,options());await turn();await publish(hub,envelope());await sleep(45);
  assert.equal(slow.destroyed,true);assert.equal(fast.destroyed,false);assert.match(fast.frames.join(""),/resource-invalidated.v1/);assert.equal(hub.stats().connections,1);assert.equal(hub.stats().queuedBytes,0);await hub.shutdown();
 }
});
void test("per-connection record and UTF8 serialized byte budgets close overflow immediately",async()=>{
 for(const limits of [{queueMaxRecords:1},{queueMaxBytes:250}]){
  const hub=new RealtimeHub({...config,...limits,coalesceMs:2,writeTimeoutMs:500});const sink=new Sink();sink.callbackBlocked=true;hub.open(sink,options());await turn();
  await publish(hub,envelope());await sleep(10);assert.equal(sink.destroyed,true);assert.equal(hub.stats().connections,0);assert.equal(hub.stats().queuedBytes,0);assert.equal(hub.stats().queuedRecords,0);await hub.shutdown();
 }
});
void test("process-wide records/bytes bound aggregate queued state across independently bounded clients",async()=>{
 for(const limits of [{totalQueueMaxRecords:3},{totalQueueMaxBytes:700}]){
  const hub=new RealtimeHub({...config,...limits,coalesceMs:2,writeTimeoutMs:500});const a=new Sink(),b=new Sink();a.callbackBlocked=b.callbackBlocked=true;
  hub.open(a,options());hub.open(b,options());await turn();await publish(hub,envelope());await sleep(10);
  const s=hub.stats();assert.ok(s.queuedRecords<=hubLimit(limits,"totalQueueMaxRecords"));assert.ok(s.queuedBytes<=hubLimit(limits,"totalQueueMaxBytes"));assert.ok(a.destroyed||b.destroyed);await hub.shutdown();
 }
});
function hubLimit(limits,key){return limits[key]??config[key];}
void test("evicting a pending live hint sends reset instead of silent loss",async()=>{
 for(const limit of ["records","age"]){
  let now=0;
  const hub=new RealtimeHub({...config,ringMaxRecords:2,ringMaxAgeMs:100,coalesceMs:30},()=>now);
  const sink=new Sink();hub.open(sink,options());await turn();
  const first=envelope(1,"1",`ord_${String(1).padStart(26,"0")}`);
  await publish(hub,first);
  if(limit==="records"){
   for(const n of [2,3]){
    await publish(hub,envelope(n,String(n),`ord_${String(n).padStart(26,"0")}`));
   }
  }else{now=100;hub.stats();}
  await sleep(45);
  const wire=sink.frames.join("");
  assert.ok(wire.includes(`id: ${first.messageId}\n`)||wire.includes("event: stream-reset.v1\n"),"a healthy stream must receive its live hint or an explicit owner-refetch reset");
  assert.equal(sink.destroyed,false);assert.equal(hub.stats().pendingRecords,0);
  await hub.shutdown();
 }
});
void test("active maxConnections rejection leaves stream untouched and permits replacement after cleanup",async()=>{
 const hub=new RealtimeHub({...config,maxConnections:1});const a=new Sink();const stream=hub.open(a,options());const denied=new Sink();
 assert.throws(()=>hub.open(denied,options()),RealtimeCapacityError);assert.equal(denied.frames.length,0);assert.equal(hub.stats().connections,1);
 stream.close();assert.equal(hub.stats().connections,0);hub.open(new Sink(),options());await hub.shutdown();
});
void test("abort/socket error/close and auth expiry free ownership/listeners/timers; heartbeat is comment only",async()=>{
 for(const action of ["abort","error","close","auth"]){
  const hub=new RealtimeHub({...config,heartbeatMs:5,authCheckMs:10});const controller=new AbortController();const sink=new Sink();let valid=true;
  hub.open(sink,{signal:controller.signal,validateActor:()=>valid});await turn();
  if(action==="abort")controller.abort();else if(action==="error")sink.emit("error",new Error("synthetic socket"));else if(action==="close")sink.destroy();else {valid=false;await sleep(20);}
  assert.equal(sink.destroyed,true);assert.equal(hub.stats().connections,0);assert.equal(hub.stats().queuedRecords,0);assert.equal(sink.listenerCount("close"),0);assert.equal(sink.listenerCount("drain"),0);assert.equal(sink.listenerCount("error"),0);
  const count=sink.frames.length;await sleep(15);assert.equal(sink.frames.length,count);await hub.shutdown();
 }
 const hub=new RealtimeHub({...config,heartbeatMs:5});const sink=new Sink();hub.open(sink,options());await sleep(12);const heartbeat=sink.frames.find(f=>f.startsWith(": heartbeat "));assert.match(heartbeat,/^: heartbeat .*Z\n\n$/);assert.doesNotMatch(heartbeat,/^id:|^event:/m);await hub.shutdown();
});
void test("shutdown emits canonical reset and closes before completion; stopped hub admits nothing",async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const sink=new Sink();hub.open(sink,options());await turn();
 let unrelatedTimerFired=false;const unrelated=setTimeout(()=>{unrelatedTimerFired=true;},250);t.after(()=>clearTimeout(unrelated));
 const first=hub.shutdown(),second=hub.shutdown();assert.equal(first,second);await first;
 assert.equal(unrelatedTimerFired,false,"pending reset work must progress without waiting for an unrelated referenced timer");
 assert.equal(sink.destroyed,true);assert.match(sink.frames.at(-1),/^event: stream-reset.v1/);assert.equal(hub.stats().queuedBytes,0);assert.equal(hub.stats().ringRecords,0);assert.throws(()=>hub.open(new Sink(),options()),RealtimeCapacityError);
});
void test("shutdown completes on successful terminal write finish even when the sink stays open",async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const sink=new Sink();
 sink.end=function(){this.writableFinished=true;this.emit("finish");};
 hub.open(sink,options());await turn();
 let settled=false;const shutdown=hub.shutdown().then(()=>{settled=true;});
 await until(()=>sink.writableFinished);await turn();
 assert.equal(settled,true,"a successfully finished reset must release shutdown without waiting for close");
 await shutdown;
 assert.match(sink.frames.at(-1),/^event: stream-reset.v1/);
 assert.equal(hub.stats().connections,0);assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
 for(const event of ["close","finish","error","drain"])assert.equal(sink.listenerCount(event),0);
});
void test("exact 64 records retain ownership until the 65th selected hint closes and cleans the stalled stream",async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const sink=new Sink();sink.callbackBlocked=true;
 hub.open(sink,options());await turn();
 for(let n=1;n<=63;n++)await publish(hub,envelope(n,String(n),`ord_${String(n).padStart(26,"0")}`));
 await sleep(config.coalesceMs+30);
 assert.equal(hub.stats().queuedRecords,64);assert.equal(sink.destroyed,false);
 await publish(hub,envelope(64,"64",`ord_${String(64).padStart(26,"0")}`));await sleep(config.coalesceMs+30);
 assert.equal(sink.destroyed,true);assert.equal(hub.stats().connections,0);assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
 for(const event of ["close","finish","error","drain"])assert.equal(sink.listenerCount(event),0);
});
void test("exact 262144 UTF8 queued bytes are admitted and the next byte cleans ownership",async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const sink=new Sink(),callbacks=[];
 sink.write=(chunk,callback)=>{sink.frames.push(Buffer.isBuffer(chunk)?chunk.toString("utf8"):chunk);callbacks.push(callback);return true;};
 hub.open(sink,options());let state=hub.stats();assert.deepEqual([state.scheduledConnections,state.writingConnections,state.writingRecords],[1,0,0]);
 assert.ok(hub.metrics().includes("coffee_realtime_scheduled_connections 1"));
 await turn();state=hub.stats();assert.deepEqual([state.scheduledConnections,state.writingConnections,state.writingRecords],[0,1,1]);
 assert.ok(hub.metrics().includes("coffee_realtime_writing_connections 1"));assert.ok(hub.metrics().includes("coffee_realtime_writing_records 1"));
 callbacks.shift()();await turn();
 // Valid metadata with 64 records cannot reach 256KiB. Exercise the existing
 // internal queue seam independently, without changing production limits/API.
 const connection=[...hub.connections][0],remaining=config.queueMaxBytes-hub.stats().queuedBytes;
 const text="я".repeat(Math.floor(remaining/2))+"x".repeat(remaining%2);
 assert.ok(text.length<Buffer.byteLength(text,"utf8"));
 assert.equal(connection.enqueue({text,bytes:Buffer.byteLength(text,"utf8")}),true);
 state=hub.stats();assert.deepEqual([state.scheduledConnections,state.writingConnections,state.writingRecords],[1,0,0]);
 assert.ok(hub.metrics().includes("coffee_realtime_scheduled_connections 1"));
 await turn();state=hub.stats();assert.deepEqual([state.scheduledConnections,state.writingConnections,state.writingRecords],[0,1,1]);
 assert.ok(hub.metrics().includes("coffee_realtime_writing_connections 1"));assert.ok(hub.metrics().includes("coffee_realtime_writing_records 1"));
 assert.equal(hub.stats().queuedBytes,262144);assert.equal(sink.destroyed,false);
 assert.equal(connection.enqueue({text:"x",bytes:1}),false);
 state=hub.stats();assert.deepEqual([state.scheduledConnections,state.writingConnections,state.writingRecords],[0,0,0]);
 assert.ok(hub.metrics().includes("coffee_realtime_scheduled_connections 0"));assert.ok(hub.metrics().includes("coffee_realtime_writing_connections 0"));assert.ok(hub.metrics().includes("coffee_realtime_writing_records 0"));
 assert.equal(sink.destroyed,true);assert.equal(hub.stats().queuedBytes,0);assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().connections,0);
});
void test("actual 5s write stall closes callback and drain waiters without blocking a healthy peer",{timeout:8000},async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const callback=new Sink(),drain=new Sink(),fast=new Sink();
 callback.callbackBlocked=true;drain.blocked=true;
 const start=performance.now();hub.open(callback,options());hub.open(drain,options());hub.open(fast,options());await turn();
 await publish(hub,envelope());await sleep(config.coalesceMs+30);
 assert.match(fast.frames.join(""),/resource-invalidated.v1/);assert.equal(fast.destroyed,false);
 await sleep(Math.max(0,4800-(performance.now()-start)));assert.equal(callback.destroyed,false);assert.equal(drain.destroyed,false);
 while(!callback.destroyed||!drain.destroyed){assert.ok(performance.now()-start<6500);await sleep(10);}
 assert.ok(performance.now()-start>=5000);assert.equal(hub.stats().connections,1);assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
 for(const sink of [callback,drain])for(const event of ["close","finish","error","drain"])assert.equal(sink.listenerCount(event),0);
 await hub.shutdown();
});
void test("exact 512 local streams refuse 513 before any write and drain within the 20s budget",{timeout:25000},async t=>{
 const hub=new RealtimeHub(config);t.after(()=>hub.destroy());const sinks=Array.from({length:512},()=>new Sink());
 for(const sink of sinks)hub.open(sink,options());await turn();
 assert.equal(hub.stats().connections,512);const denied=new Sink();assert.throws(()=>hub.open(denied,options()),RealtimeCapacityError);assert.equal(denied.frames.length,0);
 const start=performance.now();await hub.shutdown();assert.ok(performance.now()-start<=config.shutdownGraceMs);
 assert.ok(sinks.every(sink=>sink.destroyed&&sink.frames.at(-1).startsWith("event: stream-reset.v1")));
 assert.equal(hub.stats().connections,0);assert.equal(hub.stats().queuedRecords,0);assert.equal(hub.stats().queuedBytes,0);
});
