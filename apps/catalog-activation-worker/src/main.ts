import {randomUUID} from "node:crypto";
import {setTimeout as sleep} from "node:timers/promises";
import {startConfiguredRuntime, type RuntimeComposition, type RuntimeCompositionContext} from "@coffee-platform/runtime";
import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {parseServiceTransportMaterial} from "@coffee-platform/security";
import {createSqlOutboxStore} from "@coffee-platform/outbox";
import {createCatalogActivationStore} from "./infrastructure/activation-store.js";
import {CatalogActivationBindingClient} from "./gateway-binding-client.js";

function transportSecret(context:RuntimeCompositionContext):unknown {
  const keys=context.secrets["security"];
  if (keys===undefined || keys===null || typeof keys!=="object" || Array.isArray(keys)) throw new Error("CATALOG_TRANSPORT_SECRET_MISSING");
  const transports=(keys as Record<string,unknown>)["serviceTransportKeys"];
  if (transports===undefined || transports===null || typeof transports!=="object" || Array.isArray(transports)) throw new Error("CATALOG_TRANSPORT_SECRET_MISSING");
  return (transports as Record<string,unknown>)["catalog-activation-worker"];
}

let alive=false;
let recovered=false;
let failure=false;
let controller:AbortController|undefined;
let loop:Promise<void>|undefined;
let http:HttpClient|undefined;
let runCycle:(signal:AbortSignal)=>Promise<void>;
const composition:RuntimeComposition={
  readinessChecks:[{name:"catalog-activation-supervisor",check:()=>alive&&recovered&&!failure}],
  configure:(app,processSignal,database,kafka,context)=>{
    if (database===undefined || kafka===undefined || context===undefined) throw new Error("CATALOG_ACTIVATION_DEPENDENCIES_MISSING");
    const target=context.config.services["catalog-activation-worker"].outbound.find(entry=>entry.startsWith("api-internal:"));
    if (target===undefined) throw new Error("CATALOG_INTERNAL_API_ORIGIN_NOT_CONFIGURED");
    const material=parseServiceTransportMaterial(transportSecret(context),context.config.environment,"catalog-activation-worker");
    http=createHttpClient({origin:`https://${target}`,tls:{material,targetEnvironment:context.config.environment,targetRuntime:"api-internal"},connections:1,pipelining:1});
    const binder=new CatalogActivationBindingClient(http);
    const store=createCatalogActivationStore(database);
    const outbox=createSqlOutboxStore(database,{schema:"catalog",topics:context.config.services["catalog-activation-worker"].kafka.producers});
    controller=new AbortController();
    processSignal.addEventListener("abort",()=>controller?.abort(processSignal.reason),{once:true});
    runCycle=async signal=>{
      let activationError:unknown;
      try {await store.runOnce(request=>binder.register(request,{correlationId:randomUUID(),signal}),signal);}
      catch (error) {activationError=error;}
      // Existing committed events must still relay when a new Gateway binding is unavailable.
      await kafka.relay(outbox,database,signal);
      if (activationError!==undefined) throw activationError;
    };
    loop=undefined;
    app.log.info("catalog activation configured");
  },
  resources:[{
    name:"catalog-activation-supervisor",
    start:()=>{
      if (controller===undefined || runCycle===undefined) throw new Error("CATALOG_ACTIVATION_NOT_CONFIGURED");
      alive=true;
      loop=(async()=>{
        while (!controller!.signal.aborted) {
          try {await runCycle(controller!.signal); recovered=true; failure=false;}
          catch (error) {if (!controller!.signal.aborted) {failure=true; console.error("catalog activation cycle failed",error instanceof Error?error.name:"UNKNOWN");}}
          try {await sleep(1_000,undefined,{signal:controller!.signal});}
          catch (error) {if (!controller!.signal.aborted) throw error;}
        }
      })().finally(()=>{alive=false;});
    },
    stop:async()=>{alive=false;controller?.abort();try {await loop;} finally {await http?.close();}},
    destroy:()=>{alive=false;controller?.abort();},
  }],
  metrics:()=>[
    "# TYPE coffee_catalog_activation_supervisor_up gauge",
    `coffee_catalog_activation_supervisor_up ${alive?1:0}`,
    "# TYPE coffee_catalog_activation_cycle_failed gauge",
    `coffee_catalog_activation_cycle_failed ${failure?1:0}`,
  ],
};
await startConfiguredRuntime("catalog-activation-worker",composition);
