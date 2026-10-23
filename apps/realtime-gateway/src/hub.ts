import {createHash, randomUUID} from "node:crypto";
import {Temporal} from "@js-temporal/polyfill";
import {trace} from "@opentelemetry/api";
import type {EventEmitter} from "node:events";
import type {RealtimeConfig} from "@coffee-platform/config";
import type {KafkaEnvelope, RealtimeBinding} from "@coffee-platform/kafka-runtime";
import {decodeRealtimeEnvelope, invalidationFrame, invalidRealtimeRecord, type RealtimeEnvelope} from "./contract.js";

export type RealtimeSink = Pick<EventEmitter,"on"|"once"|"removeListener"> & {
  readonly destroyed: boolean;
  write: (frame:string|Buffer, callback:(error?:Error|null)=>void) => boolean;
  end: () => unknown;
  destroy: () => unknown;
};
export type StreamOptions = Readonly<{
  signal: AbortSignal;
  lastEventId?: string;
  /** Проверяет время claims, полностью проверенных при открытии потока. */
  validateActor: () => boolean;
}>;
type Frame = Readonly<{text:string;bytes:number;terminal?:true;subject?:string;ready?:true;sequence?:number}>;
type Retained = Readonly<{id:string;subject:string;version:bigint;digest:string;dataDigest:string;frame:Frame;at:number;sequence:number}> & {supersededSequence?:number};
type Connection = {
  sink:RealtimeSink; queue:Frame[]; bytes:number; closed:boolean; writing:number;
  transported:WeakSet<Frame>;
  cleanup:()=>void; close:()=>void; drain:()=>void; pump:()=>void; enqueue:(frame:Frame,schedule?:boolean)=>boolean;
};
export class RealtimeCapacityError extends Error {
  public constructor(){super("REALTIME_CAPACITY_EXCEEDED");}
}
function frame(text:string,terminal?:true):Frame {
  return {text,bytes:Buffer.byteLength(text,"utf8"),...(terminal===undefined?{}:{terminal})};
}
function digest(value:unknown):string {
  // Kafka canonicalizes the raw object before decode. Stable key ordering also
  // makes direct composed ingress use the same content identity.
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v!==null&&typeof v==="object"?
    Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
/** One replica, metadata only. Ring, dedup/version indexes and coalescing all
 * share retained ownership; nothing here is an authoritative owner snapshot. */
export class RealtimeHub {
  public readonly binding:RealtimeBinding;
  private readonly connections=new Set<Connection>();
  private readonly pumps=new Set<Connection>();
  private pumpTimer:ReturnType<typeof setImmediate>|undefined;
  private readonly ring:Retained[]=[];
  private readonly ids=new Map<string,Retained>();
  private readonly latest=new Map<string,Retained>();
  private readonly pending=new Map<string,Retained>();
  private ringBytes=0;
  private queueBytes=0;
  private queueRecords=0;
  private sequence=0;
  private stopped=false;
  private shutdownWork:Promise<void>|undefined;
  private encodedBatchFrames:readonly Frame[]|undefined;
  private encodedBatchBuffer:Buffer|undefined;
  private coalesceTimer:ReturnType<typeof setTimeout>|undefined;
  private evictions=0;
  private slowCloses=0;
  private authCloses=0;
  private invalidationAttempts=0;
  private invalidationDropped=0;
  private readonly now:()=>number;
  private readonly config:RealtimeConfig;
  public constructor(config:RealtimeConfig, now:()=>number=()=>performance.now()) {
    if(Object.values(config).some(value=>!Number.isSafeInteger(value)||value<=0))throw new Error("REALTIME_LIMITS_INVALID");
    this.config=config;this.now=now;
    this.binding={processing:"realtime",
      decode:(value,record)=>{
        const envelope=decodeRealtimeEnvelope(value,record,config.maxEventDataBytes);
        this.check(envelope);return envelope;
      },
      enqueue:async(envelope,signal)=>{signal.throwIfAborted();this.accept(envelope);},
    };
  }
  public stats(){this.prune();let writingConnections=0,writingRecords=0;for(const connection of this.connections)if(!connection.closed&&connection.writing>0){writingConnections++;writingRecords+=connection.writing;}return {connections:this.connections.size,scheduledConnections:this.pumps.size,writingConnections,writingRecords,queuedRecords:this.queueRecords,queuedBytes:this.queueBytes,
    ringRecords:this.ring.length,ringBytes:this.ringBytes,dedupEntries:this.ids.size,versionEntries:this.latest.size,pendingRecords:this.pending.size,slowCloses:this.slowCloses,authCloses:this.authCloses,evictions:this.evictions,invalidationAttempts:this.invalidationAttempts,invalidationDropped:this.invalidationDropped};}
  public metrics():readonly string[]{const s=this.stats();return [
    `coffee_realtime_connections ${s.connections}`,`coffee_realtime_scheduled_connections ${s.scheduledConnections}`,`coffee_realtime_writing_connections ${s.writingConnections}`,`coffee_realtime_writing_records ${s.writingRecords}`,
    `coffee_realtime_queue_records ${s.queuedRecords}`,`coffee_realtime_queue_bytes ${s.queuedBytes}`,
    `coffee_realtime_ring_records ${s.ringRecords}`,`coffee_realtime_ring_bytes ${s.ringBytes}`,`coffee_realtime_slow_close_total ${s.slowCloses}`,`coffee_realtime_ring_evictions_total ${s.evictions}`,
    `coffee_realtime_auth_close_total ${s.authCloses}`,`coffee_realtime_invalidation_attempts_total ${s.invalidationAttempts}`,`coffee_realtime_invalidation_dropped_total ${s.invalidationDropped}`,
  ];}
  public hasCapacity():boolean{return !this.stopped&&this.connections.size<this.config.maxConnections&&
    this.queueRecords+2<=this.config.totalQueueMaxRecords&&this.queueBytes+512<=this.config.totalQueueMaxBytes;}
  private schedulePump(connection:Connection):void {
    if(connection.closed||connection.writing||connection.queue.length===0)return;
    this.pumps.add(connection);
    if(this.pumpTimer!==undefined)return;
    this.pumpTimer=setImmediate(()=>{
      this.pumpTimer=undefined;
      const batch:Connection[]=[];
      for(const next of this.pumps){batch.push(next);if(batch.length===64)break;}
      // Bound TLS writes across the whole cohort, so Kafka and other I/O progress.
      for(const next of batch){this.pumps.delete(next);next.pump();}
      const next=this.pumps.values().next().value;if(next!==undefined)this.schedulePump(next);
    });
  }
  private encodeBatch(batch:readonly Frame[]):Buffer {
    if(this.encodedBatchFrames?.length===batch.length&&this.encodedBatchBuffer!==undefined&&
      batch.every((entry,index)=>this.encodedBatchFrames![index]===entry))return this.encodedBatchBuffer;
    const encoded=Buffer.from(batch.map(entry=>entry.text).join(""),"utf8");
    this.encodedBatchFrames=batch.slice();this.encodedBatchBuffer=encoded;return encoded;
  }
  private clearEncodedBatch():void {this.encodedBatchFrames=undefined;this.encodedBatchBuffer=undefined;}
  private prune():void {
    let lostPendingSequence=0;
    while(this.ring.length>0 && (this.ring.length>this.config.ringMaxRecords || this.ringBytes>this.config.ringMaxBytes ||
      this.now()-this.ring[0]!.at>=this.config.ringMaxAgeMs)) {
      const record=this.ring.shift()!;this.ringBytes-=record.frame.bytes;this.ids.delete(record.id);
      if(this.latest.get(record.subject)===record)this.latest.delete(record.subject);
      if(this.pending.get(record.subject)===record){this.pending.delete(record.subject);lostPendingSequence=Math.max(lostPendingSequence,record.sequence);}
      this.evictions++;
    }
    // Replay retention must not silently discard a live hint before coalescing.
    // One bounded reset covers all lost subjects; subscribers after the boundary
    // already refetch on ready and do not need an extra reset.
    if(lostPendingSequence>0)for(const connection of this.connections){
      if(lostPendingSequence>(boundaries.get(connection)??0))connection.enqueue(frame(`event: stream-reset.v1\nretry: 3000\ndata: {"reason":"REPLAY_UNAVAILABLE"}\n\n`));
    }
  }
  private check(envelope:RealtimeEnvelope):"new"|"ignored" {
    this.prune();
    const old=this.ids.get(envelope.messageId);
    if(old!==undefined){if(old.digest!==digest(envelope))invalidRealtimeRecord();return "ignored";}
    const latest=this.latest.get(envelope.payload.subjectRef);
    if(latest!==undefined){
      const version=BigInt(envelope.payload.ownerVersion);
      if(version<latest.version)return "ignored";
      if(version===latest.version){if(latest.dataDigest!==digest(envelope.payload))invalidRealtimeRecord();return "ignored";}
    }
    return "new";
  }
  private accept(value:KafkaEnvelope):void {
    if(this.stopped)throw new Error("REALTIME_HUB_STOPPED");
    // This is the validated Kafka binding, not an untyped public publish API.
    const envelope=value as RealtimeEnvelope;
    if(this.check(envelope)==="ignored")return;
    const record:Retained={id:envelope.messageId,subject:envelope.payload.subjectRef,version:BigInt(envelope.payload.ownerVersion),
      digest:digest(envelope),dataDigest:digest(envelope.payload),frame:frame(invalidationFrame(envelope)),at:this.now(),sequence:++this.sequence};
    if(record.frame.bytes>this.config.ringMaxBytes)throw new Error("REALTIME_RING_FRAME_EXCEEDS_CAPACITY");
    this.ring.push(record);this.ringBytes+=record.frame.bytes;this.ids.set(record.id,record);this.latest.set(record.subject,record);
    // Share the live window's selection with replay, without removing raw IDs.
    // A numeric successor stays bounded by the ring and cannot retain objects.
    const previous=this.pending.get(record.subject);
    if(previous!==undefined)previous.supersededSequence=record.sequence;
    this.pending.set(record.subject,record);this.prune();
    if(this.coalesceTimer===undefined){this.coalesceTimer=setTimeout(()=>{
      this.coalesceTimer=undefined;const fanout=trace.getTracer("coffee-platform.realtime-gateway").startSpan("realtime.sse.fanout");fanout.setAttribute("phase","fanout");this.prune();const pending=[...this.pending.values()].sort((a,b)=>a.sequence-b.sequence);this.pending.clear();
      const selected=pending.map(event=>({sequence:event.sequence,frame:{...event.frame,subject:event.subject,sequence:event.sequence}}));
      let saturated=false;
      for(const connection of this.connections){
        if(connection.closed)continue;
        const boundary=boundaries.get(connection)??0;let scheduled=false;
        for(const event of selected){
          if(event.sequence<=boundary)continue;
          if(!connection.enqueue(event.frame,false)){saturated=true;if(connection.closed)break;continue;}
          scheduled=true;
        }
        if(scheduled&&!connection.closed)this.schedulePump(connection);
      }
      fanout.setAttribute("result",saturated?"saturated":selected.length===0?"empty":"queued");fanout.end();
    },this.config.coalesceMs);this.coalesceTimer.unref();}
  }
  public open(sink:RealtimeSink, options:StreamOptions):Readonly<{close:()=>void}> {
    options.signal.throwIfAborted();
    if(!this.hasCapacity())throw new RealtimeCapacityError();
    if(!options.validateActor())throw new Error("REALTIME_ACTOR_INVALID");
    this.prune();
    const cursor=options.lastEventId===undefined?undefined:this.ids.get(options.lastEventId);
    const boundary=this.sequence;
    let replayCursor=cursor?.sequence;
    const invalidCursor=options.lastEventId!==undefined && cursor===undefined;
    let heartbeat:ReturnType<typeof setInterval>|undefined;
    let auth:ReturnType<typeof setInterval>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    let drainListener:(()=>void)|undefined;
    const handshake=trace.getTracer("coffee-platform.realtime-gateway").startSpan("realtime.sse.handshake");handshake.setAttribute("phase","handshake");
    const connection:Connection={sink,queue:[],bytes:0,closed:false,writing:0,transported:new WeakSet(),cleanup:()=>{},close:()=>{},drain:()=>{},pump:()=>{},enqueue:()=>false};
    const clearWrite=()=>{clearTimeout(deadline);deadline=undefined;if(drainListener!==undefined)sink.removeListener("drain",drainListener);drainListener=undefined;};
    const cleanup=()=>{
      if(connection.closed)return;connection.closed=true;clearWrite();clearInterval(heartbeat);clearInterval(auth);
      this.pumps.delete(connection);
      options.signal.removeEventListener("abort",close);sink.removeListener("close",cleanup);sink.removeListener("error",close);sink.removeListener("finish",cleanup);
      for(const entry of connection.queue)if(entry.sequence!==undefined&&!connection.transported.has(entry))this.invalidationDropped=Math.min(Number.MAX_SAFE_INTEGER,this.invalidationDropped+1);
      this.queueBytes-=connection.bytes;this.queueRecords-=connection.queue.length;connection.queue=[];connection.bytes=0;
      this.connections.delete(connection);boundaries.delete(connection);
      if(this.connections.size===0)this.clearEncodedBatch();
    };
    const close=()=>{cleanup();if(!sink.destroyed)sink.destroy();};
    const slowClose=()=>{this.slowCloses++;close();};
    const pump=()=>{
      if(connection.closed||connection.writing||connection.queue.length===0)return;
      if(connection.queue[0]?.ready===true && replayCursor!==undefined) {
        if(replayCursor<boundary) {
          this.prune();
          // Accepted sequences are contiguous and pruning only shifts the
          // oldest prefix. Lookup must not scan 10k records per replay frame.
          const first=this.ring[0]?.sequence;
          const next=first===undefined?undefined:this.ring[replayCursor+1-first];
          const replays:Frame[]=[];let replayBytes=0;
          // Leave most per-client record capacity for ready/control/live hints.
          const limit=Math.max(1,Math.floor(this.config.queueMaxRecords/4));
          for(let n=0;replays.length<limit&&replayCursor+n<boundary;n++) {
            const event=first===undefined?undefined:this.ring[replayCursor+1+n-first];
            // Only successors inside this snapshot supersede a replay hint.
            // A reentrant later live record must not change the frozen replay.
            if(event?.supersededSequence!==undefined&&event.supersededSequence<=boundary)continue;
            const replay=event===undefined?frame(`event: stream-reset.v1\nretry: 3000\ndata: {"reason":"REPLAY_UNAVAILABLE"}\n\n`):{...event.frame,sequence:event.sequence};
            if(connection.queue.length+replays.length+1>this.config.queueMaxRecords||connection.bytes+replayBytes+replay.bytes>this.config.queueMaxBytes||
              this.queueRecords+replays.length+1>this.config.totalQueueMaxRecords||this.queueBytes+replayBytes+replay.bytes>this.config.totalQueueMaxBytes)break;
            replays.push(replay);if(replay.sequence!==undefined)this.invalidationAttempts=Math.min(Number.MAX_SAFE_INTEGER,this.invalidationAttempts+1);replayBytes+=replay.bytes;if(event===undefined){replayCursor=undefined;break;}
          }
          if(replays.length===0){slowClose();return;}
          if(next===undefined)replayCursor=undefined;
          connection.queue.unshift(...replays);connection.bytes+=replayBytes;this.queueBytes+=replayBytes;this.queueRecords+=replays.length;
        } else replayCursor=undefined;
      }
      const head=connection.queue[0]!;
      const control=(entry:Frame)=>entry.ready===true||entry.terminal===true;
      const batchEnd=control(head)?1:connection.queue.findIndex(entry=>control(entry)||(entry.sequence===undefined)!==(head.sequence===undefined));
      const batch=connection.queue.slice(0,Math.min(batchEnd<0?connection.queue.length:batchEnd,64));
      const bytes=batch.reduce((sum,entry)=>sum+entry.bytes,0);connection.writing=batch.length;
      let callbackDone=false,drained=false,returned=false;
      const advance=()=>{
        if(!returned||!callbackDone||!drained||connection.closed)return;
        clearWrite();connection.writing=0;
        for(const entry of batch)connection.transported.delete(entry);
        connection.queue.splice(0,batch.length);connection.bytes-=bytes;this.queueBytes-=bytes;this.queueRecords-=batch.length;
        const last=batch.at(-1)!;if(last.sequence!==undefined)replayCursor=last.sequence;
        if(head.terminal===true){cleanup();if(!sink.destroyed)sink.end();return;}
        this.schedulePump(connection);
      };
      drainListener=()=>{drained=true;advance();};sink.once("drain",drainListener);
      deadline=setTimeout(slowClose,this.config.writeTimeoutMs);deadline.unref();
      try {
        const writable=sink.write(this.encodeBatch(batch),error=>{if(error!==undefined&&error!==null){close();return;}for(const entry of batch)if(entry.sequence!==undefined)connection.transported.add(entry);callbackDone=true;advance();});
        drained=drained||writable;
        returned=true;advance();
      } catch {close();}
    };
    const enqueue=(next:Frame,schedule=true)=>{
      if(connection.closed)return false;
      if(next.sequence!==undefined)this.invalidationAttempts=Math.min(Number.MAX_SAFE_INTEGER,this.invalidationAttempts+1);
      // Coalesce only a not-yet-written notification, never a control or cursor.
      const index=next.subject===undefined?-1:connection.queue.findIndex((entry,i)=>i>=connection.writing&&entry.subject===next.subject);
      const previous=index<0?undefined:connection.queue[index];
      const extra=next.bytes-(previous?.bytes??0);
      const records=previous===undefined?1:0;
      if(connection.queue.length+records>this.config.queueMaxRecords || connection.bytes+extra>this.config.queueMaxBytes ||
        this.queueRecords+records>this.config.totalQueueMaxRecords || this.queueBytes+extra>this.config.totalQueueMaxBytes){if(next.sequence!==undefined)this.invalidationDropped=Math.min(Number.MAX_SAFE_INTEGER,this.invalidationDropped+1);slowClose();return false;}
      // The selected hint is newer than the remaining queued live hints. Keep
      // its cursor last rather than replacing an older position in the wire.
      if(index>=0)connection.queue.splice(index,1);
      connection.queue.push(next);
      connection.bytes+=extra;this.queueBytes+=extra;this.queueRecords+=records;
      // Deferred pumping keeps ready/snapshot registration atomic with live fanout.
      if(schedule)this.schedulePump(connection);return true;
    };
    connection.cleanup=cleanup;connection.close=close;connection.pump=pump;connection.enqueue=enqueue;
    connection.drain=()=>{
      replayCursor=undefined;clearInterval(heartbeat);clearInterval(auth);
      const remaining=connection.queue.slice(0,connection.writing);const bytes=remaining.reduce((sum,entry)=>sum+entry.bytes,0);
      for(const entry of connection.queue.slice(connection.writing))if(entry.sequence!==undefined)this.invalidationDropped=Math.min(Number.MAX_SAFE_INTEGER,this.invalidationDropped+1);
      this.queueRecords-=connection.queue.length-remaining.length;this.queueBytes-=connection.bytes-bytes;
      connection.queue=remaining;connection.bytes=bytes;
      enqueue(frame(`event: stream-reset.v1\nretry: 3000\ndata: {"reason":"REPLAY_UNAVAILABLE"}\n\n`,true));
    };
    this.connections.add(connection);boundaries.set(connection,this.sequence);
    options.signal.addEventListener("abort",close,{once:true});sink.once("close",cleanup);sink.once("finish",cleanup);sink.on("error",close);
    if(invalidCursor)enqueue(frame(`event: stream-reset.v1\nretry: 3000\ndata: {"reason":"REPLAY_UNAVAILABLE"}\n\n`));
    if(!connection.closed) {
      enqueue({...frame(`event: stream-ready.v1\nretry: 3000\ndata: ${JSON.stringify({connectionId:randomUUID(),connectedAt:Temporal.Now.instant().toString()})}\n\n`),ready:true});
    }
    if(!connection.closed) {
      heartbeat=setInterval(()=>enqueue(frame(`: heartbeat ${Temporal.Now.instant().toString()}\n\n`)),this.config.heartbeatMs);heartbeat.unref();
      auth=setInterval(()=>{
        if(connection.closed)return;
        let valid=false;try{valid=options.validateActor();}catch{this.authCloses++;close();return;}
        if(!valid){this.authCloses++;close();}
      },this.config.authCheckMs);auth.unref();
    }
    handshake.setAttribute("result","accepted");handshake.end();return {close};
  }
  public shutdown():Promise<void> {
    if(this.shutdownWork!==undefined)return this.shutdownWork;
    if(this.stopped)return Promise.resolve();this.stopped=true;this.clearEncodedBatch();clearTimeout(this.coalesceTimer);this.coalesceTimer=undefined;this.pending.clear();
    const closed=[...this.connections].map(connection=>new Promise<void>(resolve=>{
      const sink=connection.sink;
      const finished=()=>{sink.removeListener("close",finished);sink.removeListener("finish",finished);resolve();};
      sink.once("close",finished);sink.once("finish",finished);
      connection.drain();
    }));
    this.ring.length=0;this.ringBytes=0;this.ids.clear();this.latest.clear();
    this.shutdownWork=Promise.all(closed).then(()=>{this.clearEncodedBatch();});return this.shutdownWork;
  }
  public destroy():void {
    this.stopped=true;this.clearEncodedBatch();clearTimeout(this.coalesceTimer);this.coalesceTimer=undefined;this.pending.clear();
    for(const connection of this.connections)connection.close();
    clearImmediate(this.pumpTimer);this.pumpTimer=undefined;this.pumps.clear();
    this.ring.length=0;this.ringBytes=0;this.ids.clear();this.latest.clear();
  }
}
// Weak ownership; never a process-global per-subject or durable cursor index.
const boundaries=new WeakMap<Connection,number>();
