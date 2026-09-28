import {canonicalRequestHash} from "@coffee-platform/idempotency";
import type {OrderStore,ReconciliationCommandResult} from "../infrastructure/database/order-store.js";
import {observe} from "../observability.js";
import {failure,lookupReplay,precheckCommand,type CommandContext,type CommandOutcome} from "./create-draft.js";

export async function requestAromaReconciliation(store:Pick<OrderStore,"replay"|"precheck"|"requestReconciliation">,input:CommandContext&Readonly<{orderRef:string;expectedVersion:string|undefined;reason:string|undefined}>):Promise<CommandOutcome<ReconciliationCommandResult>> {
  return observe("orders.use_case.reconcile",async()=>{
    if(input.replayOnly)return lookupReplay(store,input);
    if(input.expectedVersion===undefined||input.reason===undefined)throw failure("VALIDATION_FAILED");
    const hash=canonicalRequestHash({orderRef:input.orderRef,expectedVersion:input.expectedVersion,reason:input.reason});
    const checked=await precheckCommand(store,input,hash);
    if(checked.kind!=="proceed")return checked;
    return store.requestReconciliation({actorRef:input.actorRef,identity:input.identity,correlationId:input.correlationId,signal:input.signal,...(input.traceparent===undefined?{}:{traceparent:input.traceparent}),orderRef:input.orderRef,expectedVersion:input.expectedVersion,reason:input.reason});
  },input.signal);
}
