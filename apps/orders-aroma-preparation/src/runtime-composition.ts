import {setTimeout as sleep} from "node:timers/promises";
import type {RuntimeComposition} from "@coffee-platform/runtime";
import {DatabaseTransactionError} from "@coffee-platform/database";
import {createSqlInboxStore} from "@coffee-platform/inbox";
import {createSqlOutboxStore} from "@coffee-platform/outbox";
import {createAromaPreparationStore} from "./infrastructure/preparation-store.js";
import {decodeAromaPreparationEnvelope} from "./application/messages.js";
import {AromaPreparationTelemetry} from "./observability.js";

/** Один process-owned supervisor; бизнес-эффекты и recovery остаются в store. */
export function createAromaPreparationComposition(): RuntimeComposition {
  let alive=false, recovered=false, workFailed=false, relayFailed=false;
  let controller:AbortController|undefined;
  let loop:Promise<void>|undefined;
  let cycle:((signal:AbortSignal)=>Promise<void>)|undefined;
  let pollIntervalMs=0;
  const telemetry=new AromaPreparationTelemetry();
  return {
    readinessChecks:[{name:"aroma-preparation-supervisor",check:()=>alive&&recovered&&!workFailed&&!relayFailed}],
    configure:(app,processSignal,database,kafka,context)=>{
      if(database===undefined||kafka===undefined||context===undefined)throw new Error("AROMA_PREPARATION_DEPENDENCIES_MISSING");
      const service=context.config.services["orders-aroma-preparation"];
      const config=service.aromaPreparation;
      if(config===undefined)throw new Error("AROMA_PREPARATION_CONFIG_MISSING");
      const verification=context.config.services["aroma-convergence"].aromaConvergence;
      if(verification===undefined)throw new Error("AROMA_VERIFICATION_CONFIG_MISSING");
      const store=createAromaPreparationStore(database,{...config,maxSnapshotAgeMs:verification.maxSnapshotAgeMs},telemetry);
      for(const consumer of service.kafka.consumers){
        if(consumer.processing!=="durable")throw new Error("AROMA_PREPARATION_CONSUMER_INVALID");
        kafka.bind(consumer.groupId,{processing:"durable",database,
          inbox:createSqlInboxStore(database,{schema:"orders",consumerName:consumer.groupId}),
          decode:decodeAromaPreparationEnvelope,
          handle:(tx,envelope,record,signal)=>store.handle(tx,envelope,record,signal)});
      }
      const outbox=createSqlOutboxStore(database,{schema:"orders",envelopeBytes:true,topics:service.kafka.producers});
      pollIntervalMs=config.pollIntervalMs;
      controller=new AbortController();
      const owned=controller;
      if(processSignal.aborted)owned.abort(processSignal.reason);
      else processSignal.addEventListener("abort",()=>owned.abort(processSignal.reason),{once:true});
      cycle=async signal=>{
        let stage:"recover"|"runOnce"=recovered?"runOnce":"recover";
        try {
          if(!recovered){await store.recover(signal);recovered=true;}
          stage="runOnce";
          await store.runOnce(signal);workFailed=false;
        }catch(error){workFailed=true;if(!signal.aborted)app.log.error({event:"aroma.preparation.failed",stage,reason:error instanceof Error?error.name:"UNKNOWN",...(error instanceof DatabaseTransactionError?{code:error.code,...(error.sqlState!==undefined&&/^[0-9A-Z]{5}$/.test(error.sqlState)?{sqlState:error.sqlState}:{})}:{})});}
        // Уже committed Outbox не должен голодать при ошибке нового recompute.
        try{await kafka.relay(outbox,database,signal);relayFailed=false;}
        catch(error){relayFailed=true;if(!signal.aborted)app.log.error({event:"aroma.preparation.relay_failed",reason:error instanceof Error?error.name:"UNKNOWN"});}
      };
    },
    resources:[{
      name:"aroma-preparation-supervisor",
      start:()=>{
        if(controller===undefined||cycle===undefined)throw new Error("AROMA_PREPARATION_NOT_CONFIGURED");
        const owned=controller;const run=cycle;alive=true;
        loop=(async()=>{
          try{while(!owned.signal.aborted){await run(owned.signal);try{await sleep(pollIntervalMs,undefined,{signal:owned.signal});}catch(error){if(!owned.signal.aborted)throw error;}}}
          finally{alive=false;}
        })();
      },
      stop:async()=>{alive=false;controller?.abort();await loop;},
      destroy:()=>{alive=false;controller?.abort();},
    }],
    metrics:()=>[...telemetry.render(),"# TYPE coffee_aroma_preparation_ready gauge",`coffee_aroma_preparation_ready ${alive&&recovered&&!workFailed&&!relayFailed?1:0}`],
  };
}
