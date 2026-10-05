import {randomUUID} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {createHttpClient,type HttpClient} from "@coffee-platform/platform-http";
import type {RuntimeComposition} from "@coffee-platform/runtime";
import {parseServiceTransportMaterial} from "@coffee-platform/security";
import {createSqlOutboxStore} from "@coffee-platform/outbox";
import {createSqlInboxStore} from "@coffee-platform/inbox";
import {decodeAromaConvergenceEnvelope} from "./application/messages.js";
import {AromaConvergenceGatewayClient} from "./gateway-client.js";
import {createAromaConvergenceStore} from "./infrastructure/convergence-store.js";
import {AromaConvergenceTelemetry} from "./observability.js";

/** Scoped transport и bounded supervisor; network остаётся вне owner transaction. */
export function createAromaConvergenceComposition(): RuntimeComposition {
  let alive=false,recovered=false,workFailed=false,relayFailed=false;
  let controller:AbortController|undefined;
  let loop:Promise<void>|undefined;
  let http:HttpClient|undefined;
  let cycle:((signal:AbortSignal)=>Promise<void>)|undefined;
  let pollIntervalMs=0;
  const telemetry=new AromaConvergenceTelemetry();
  return {
    readinessChecks:[{name:"aroma-convergence-supervisor",check:()=>alive&&recovered&&!workFailed&&!relayFailed&&telemetry.ready},
      {name:"aroma-convergence-internal-api",check:async signal=>{
        if(http===undefined||signal.aborted)return false;
        const response=await http.fetch("/health/ready",{method:"GET",signal,redirect:"error"});
        void response.body?.cancel().catch(()=>undefined);return response.status===200;
      }}],
    configure:(app,processSignal,database,kafka,context)=>{
      if(database===undefined||kafka===undefined||context===undefined)throw new Error("AROMA_CONVERGENCE_DEPENDENCIES_MISSING");
      const service=context.config.services["aroma-convergence"];const config=service.aromaConvergence;
      if(config===undefined)throw new Error("AROMA_CONVERGENCE_CONFIG_MISSING");
      const {maxResponseBytes,...storeConfig}=config;
      const target=service.outbound.find(entry=>entry.startsWith("api-internal:"));
      if(target===undefined)throw new Error("AROMA_INTERNAL_API_ORIGIN_MISSING");
      const security=context.secrets["security"];
      const transports=security!==null&&typeof security==="object"&&!Array.isArray(security)?(security as Record<string,unknown>)["serviceTransportKeys"]:undefined;
      const secret=transports!==null&&typeof transports==="object"&&!Array.isArray(transports)?(transports as Record<string,unknown>)["aroma-convergence"]:undefined;
      const material=parseServiceTransportMaterial(secret,context.config.environment,"aroma-convergence");
      http=createHttpClient({origin:`https://${target}`,tls:{material,targetEnvironment:context.config.environment,targetRuntime:"api-internal"},connections:1,pipelining:1});
      const gateway=new AromaConvergenceGatewayClient(http,{deadlineMs:config.providerDeadlineMs,maxResponseBytes});
      const store=createAromaConvergenceStore(database,{ownerInstanceId:randomUUID(),mutationsEnabled:service.mutationsEnabled===true,...storeConfig},telemetry);
      for(const consumer of service.kafka.consumers){
        if(consumer.processing!=="durable")throw new Error("AROMA_CONVERGENCE_CONSUMER_INVALID");
        kafka.bind(consumer.groupId,{processing:"durable",database,
          inbox:createSqlInboxStore(database,{schema:"orders",consumerName:consumer.groupId}),
          decode:decodeAromaConvergenceEnvelope,
          handle:(tx,envelope,_record,signal)=>store.handleWake(tx,envelope,signal)});
      }
      const outbox=createSqlOutboxStore(database,{schema:"orders",envelopeBytes:true,topics:service.kafka.producers});
      pollIntervalMs=config.pollIntervalMs;controller=new AbortController();const owned=controller;
      if(processSignal.aborted)owned.abort(processSignal.reason);
      else processSignal.addEventListener("abort",()=>owned.abort(processSignal.reason),{once:true});
      cycle=async signal=>{
        try{if(!recovered){await store.recover(signal);recovered=true;}await store.runOnce(gateway,signal);workFailed=false;}
        catch(error){workFailed=true;if(!signal.aborted)app.log.error({event:"aroma.convergence.failed",reason:error instanceof Error?error.name:"UNKNOWN"});}
        // Relay уже committed фактов независим от нового provider failure.
        try{await kafka.relay(outbox,database,signal);relayFailed=false;}
        catch(error){relayFailed=true;if(!signal.aborted)app.log.error({event:"aroma.convergence.relay_failed",reason:error instanceof Error?error.name:"UNKNOWN"});}
      };
    },
    resources:[{
      name:"aroma-convergence-supervisor",
      start:()=>{
        if(controller===undefined||cycle===undefined)throw new Error("AROMA_CONVERGENCE_NOT_CONFIGURED");
        const owned=controller;const run=cycle;alive=true;
        loop=(async()=>{
          try{while(!owned.signal.aborted){await run(owned.signal);try{await sleep(pollIntervalMs,undefined,{signal:owned.signal});}catch(error){if(!owned.signal.aborted)throw error;}}}
          finally{alive=false;}
        })();
      },
      stop:async()=>{alive=false;controller?.abort();try{await loop;}finally{await http?.close();}},
      destroy:()=>{alive=false;controller?.abort();void http?.close();},
    }],
    metrics:()=>[...telemetry.render(),"# TYPE coffee_aroma_convergence_ready gauge",`coffee_aroma_convergence_ready ${alive&&recovered&&!workFailed&&!relayFailed&&telemetry.ready?1:0}`],
  };
}
