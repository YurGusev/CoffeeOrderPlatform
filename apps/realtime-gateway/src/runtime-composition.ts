import {createPublicKey, type KeyObject} from "node:crypto";
import {monitorEventLoopDelay} from "node:perf_hooks";
import {setTimeout as delay} from "node:timers/promises";
import {Temporal} from "@js-temporal/polyfill";
import type {RuntimeComposition, RuntimeCompositionContext} from "@coffee-platform/runtime";
import {isActorContextTimeValid, verifyActorContextWithKeySet, type ActorContextClaims} from "@coffee-platform/security";
import {clientV1Schemas} from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import {RealtimeCapacityError, RealtimeHub} from "./hub.js";
import {REALTIME_GROUP, REALTIME_TOPIC} from "./contract.js";


// Derive route types from the runtime's Fastify surface, without another HTTP framework.
type Admission=NonNullable<RuntimeComposition["admissionResponse"]>;
type RealtimeRequest=Parameters<Admission>[0];
type RealtimeReply=Parameters<Admission>[1];
export type ActorVerifier=(token:string,correlationId:string,traceparent:string|undefined)=>ActorContextClaims;
export function createRealtimeActorVerifier(publicKeys:readonly KeyObject[],now:()=>number=()=>Math.floor(Temporal.Now.instant().epochMilliseconds/1000)):ActorVerifier {
  if(publicKeys.length===0 || publicKeys.some(key=>key.type!=="public"||key.asymmetricKeyType!=="ed25519"))throw new Error("REALTIME_ACTOR_VERIFICATION_KEYS_INVALID");
  return (token,correlationId,traceparent)=>{
    const claims=verifyActorContextWithKeySet(token,{publicKeys,issuer:"edge-gateway",audience:"realtime-gateway",nowEpochSeconds:now(),clockSkewSeconds:5});
    // The existing Edge signer encodes an absent HTTP trace as this sentinel.
    const expectedTrace=traceparent??"00-00000000000000000000000000000000-0000000000000000-00";
    if(claims.originalIssuer!=="edge-gateway" || claims.operationId!=="streamOrderInvalidations" ||
      !claims.permissions.includes("orders:read:any") || claims.correlationId!==correlationId || claims.traceparent!==expectedTrace ||
      !/^\S{1,128}$/u.test(claims.sub) || Array.from(claims.sub).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127) || claims.exp-claims.iat>60 ||
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u.test(correlationId) ||
      (traceparent!==undefined && (!/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(traceparent) ||
      traceparent.startsWith("ff-") || /^[0-9a-f]{2}-0{32}-/u.test(traceparent) || /^[0-9a-f]{2}-[0-9a-f]{32}-0{16}-/u.test(traceparent))))throw new Error("ACTOR_CONTEXT_INVALID");
    return claims;
  };
}
export function configuredRealtimeActorVerifier(context:RuntimeCompositionContext):ActorVerifier {
  const security=context.secrets["security"];
  const material=security!==null&&typeof security==="object"&&!Array.isArray(security)?(security as Record<string,unknown>)["actorContextEdgeVerificationPublicKeys"]:undefined;
  if(material===null||typeof material!=="object"||Array.isArray(material))throw new Error("REALTIME_ACTOR_VERIFICATION_KEYS_MISSING");
  const active=(material as Record<string,unknown>)["active"],previous=(material as Record<string,unknown>)["previous"];
  if(typeof active!=="string"||active.length===0||typeof previous!=="string"||previous.length===0)throw new Error("REALTIME_ACTOR_VERIFICATION_KEYS_INVALID");
  return createRealtimeActorVerifier([createPublicKey(active),createPublicKey(previous)]);
}
export function realtimeProblem(reply:RealtimeReply,status:400|401|403|503,code:string,correlationId:string):void {
  void reply.code(status).type("application/problem+json").header("Cache-Control","no-store").send({
    type:"about:blank",title:code,status,code,detail:code,instance:"/events",correlationId,errors:[],
  });
}
function onceHeader(request:RealtimeRequest,name:string):string|undefined {
  const values=request.raw.rawHeaders.filter((_,i,all)=>i%2===1&&all[i-1]?.toLowerCase()===name);
  const value=request.headers[name];
  if(values.length>1||typeof value!=="string")return undefined;
  return value;
}
export function authenticateRealtimeRequest(request:RealtimeRequest,environment:string,verify:ActorVerifier):Readonly<{token:string;claims:ActorContextClaims}> {
  const context=request.runtimeContext;
  if(context?.transportIdentity?.runtime!=="edge-nginx"||context.transportIdentity.environment!==environment)throw new Error("AUTHENTICATION_REQUIRED");
  context.signal.throwIfAborted();
  const token=onceHeader(request,"x-actor-context");
  const correlationId=onceHeader(request,"x-correlation-id");
  const traceparent=onceHeader(request,"traceparent");
  if(token===undefined)throw new Error("AUTHENTICATION_REQUIRED");
  if(correlationId!==context.correlationId||traceparent!==context.traceparent||
    (request.headers["traceparent"]!==undefined&&traceparent===undefined))throw new Error("ACTOR_CONTEXT_INVALID");
  return {token,claims:verify(token,correlationId,traceparent)};
}
/** Explicit sole composition root, no DB/owner GET/session or signing secrets. */
export function createRealtimeComposition():RuntimeComposition & Readonly<{hub:()=>RealtimeHub|undefined}> {
  const eventLoop=monitorEventLoopDelay({resolution:20});
  let eventLoopP95Ms=0;
  let eventLoopSamples=0;
  let hub:RealtimeHub|undefined;
  let alive=false;
  let assigned=()=>false;
  let subscriptionReady:(signal:AbortSignal)=>Promise<boolean>=async()=>false;
  let shutdown:Promise<void>|undefined;
  return {
    hub:()=>hub,
    metrics:()=>{
      const count=eventLoop.count;
      if(count>0){eventLoopP95Ms=eventLoop.percentile(95)/1e6;eventLoopSamples+=count;eventLoop.reset();}
      return [...(hub?.metrics()??[]),`coffee_realtime_event_loop_delay_p95_ms ${eventLoopP95Ms}`,`coffee_realtime_event_loop_delay_samples ${eventLoopSamples}`];
    },
    admissionResponse:(request,reply)=>{
      if(request.method!=="GET"||request.routeOptions.url!=="/events")return false;
      realtimeProblem(reply,503,"REALTIME_CAPACITY_EXCEEDED",request.correlationContext!.correlationId);return true;
    },
    // appendOwnedComposition already checks Kafka health and its fetch boundary.
    // This fanout check must not duplicate the blocking metadata RPC per probe.
    readinessChecks:[{name:"realtime-fanout",check:()=>alive&&hub!==undefined&&assigned()}],
    resources:[{name:"realtime-fanout",start:async(signal)=>{
      if(hub===undefined)throw new Error("REALTIME_NOT_CONFIGURED");
      // The owned Kafka resource starts first. Its metadata connection is not
      // the latest-offset subscription boundary; do not admit SSE before assignment.
      while(!assigned()||!(await subscriptionReady(signal)))await delay(25,undefined,{signal});
      signal.throwIfAborted();eventLoop.enable();alive=true;
    },
      stop:async()=>{alive=false;eventLoop.disable();shutdown??=hub?.shutdown();await shutdown;},destroy:()=>{alive=false;eventLoop.disable();hub?.destroy();}}],
    configure:(app,processSignal,database,kafka,context)=>{
      if(database!==undefined||kafka===undefined||context===undefined)throw new Error("REALTIME_DEPENDENCIES_INVALID");
      const service=context.config.services["realtime-gateway"],config=service.realtime;
      if(config===undefined||service.database!==null||service.dbPool!==null||service.replicas!==1||service.transportMode!=="mtls"||
        service.kafka.consumers.length!==1||service.kafka.consumers[0]?.groupId!==REALTIME_GROUP||
        service.kafka.consumers[0]?.processing!=="realtime"||service.kafka.consumers[0]?.topics.length!==1||service.kafka.consumers[0]?.topics[0]!==REALTIME_TOPIC)throw new Error("REALTIME_CONFIG_INVALID");
      const verify=configuredRealtimeActorVerifier(context);
      const partitions=Object.values(context.config.kafka.topics).find(topic=>topic.name===REALTIME_TOPIC)?.partitions;
      if(partitions===undefined)throw new Error("REALTIME_CONFIG_INVALID");
      assigned=()=>kafka.metrics().assigned===partitions;
      subscriptionReady=async signal=>Boolean(await kafka.readiness.check(signal));
      const owned=new RealtimeHub(config);hub=owned;kafka.bind(REALTIME_GROUP,owned.binding);
      const drain=()=>{alive=false;eventLoop.disable();shutdown??=owned.shutdown();};
      processSignal.addEventListener("abort",drain,{once:true});
      app.addHook("onClose",()=>{processSignal.removeEventListener("abort",drain);});
      app.get("/events",{
        attachValidation:true,
        config:{runtimeDeadlineProfile:"defaultMs"},
        schema:{querystring:{type:"object",additionalProperties:false,maxProperties:0},
          headers:{type:"object",properties:{"x-actor-context":{type:"string",maxLength:8192},"last-event-id":{type:"string"}}},
          response:{200:{type:"string"},400:clientV1Schemas["ProblemDetails"],401:clientV1Schemas["ProblemDetails"],403:clientV1Schemas["ProblemDetails"],503:clientV1Schemas["ProblemDetails"]},
        },
      },(request,reply)=>{
        const correlationId=request.correlationContext!.correlationId;
        if(request.validationError!==undefined||request.raw.url?.includes("?")||request.raw.headers["content-length"]!==undefined||request.raw.headers["transfer-encoding"]!==undefined){
          realtimeProblem(reply,400,"VALIDATION_FAILED",correlationId);return;
        }
        let auth:Readonly<{token:string;claims:ActorContextClaims}>;
        try {auth=authenticateRealtimeRequest(request,context.config.environment,verify);}
        catch(error){const code=error instanceof Error&&error.message==="AUTHENTICATION_REQUIRED"?"AUTHENTICATION_REQUIRED":"ACTOR_CONTEXT_INVALID";
          realtimeProblem(reply,code==="AUTHENTICATION_REQUIRED"?401:403,code,correlationId);return;}
        if(!owned.hasCapacity()){realtimeProblem(reply,503,"REALTIME_CAPACITY_EXCEEDED",correlationId);return;}
        const streamSignal=request.runtimeContext!.signal;
        // No asynchronous gap between auth/admission and registration.
        const lastEventId=onceHeader(request,"last-event-id");
        const duplicateCursor=request.raw.rawHeaders.filter((_,i,all)=>i%2===1&&all[i-1]?.toLowerCase()==="last-event-id").length>1;
        reply.hijack();
        reply.raw.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no","X-Correlation-ID":correlationId});
        const streamSocket=reply.raw.socket;
        reply.raw.once("finish",()=>streamSocket?.end());
        try {owned.open(reply.raw,{signal:streamSignal,...(lastEventId===undefined&&!duplicateCursor?{}:{lastEventId:duplicateCursor?"":lastEventId!}),
          validateActor:()=>isActorContextTimeValid(auth.claims,Math.floor(Temporal.Now.instant().epochMilliseconds/1000),5),
        });}
        catch(error){reply.raw.destroy();if(!(error instanceof RealtimeCapacityError)&&!streamSignal.aborted)throw error;}
      });
    },
  };
}
