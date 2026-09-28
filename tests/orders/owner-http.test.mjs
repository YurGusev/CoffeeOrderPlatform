import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {registerOrdersRoutes} from "../../apps/orders-service/dist/http/index.js";
import {createDraft} from "../../apps/orders-service/dist/application/create-draft.js";
import {upsertItem} from "../../apps/orders-service/dist/application/upsert-item.js";
import {deleteItem} from "../../apps/orders-service/dist/application/delete-item.js";
import {confirmOrder} from "../../apps/orders-service/dist/application/confirm-order.js";
import {getOrderCard} from "../../apps/orders-service/dist/application/get-order-card.js";
import {requestAromaReconciliation} from "../../apps/orders-service/dist/application/request-aroma-reconciliation.js";
import {checkInternalApiReady} from "../../apps/orders-service/dist/infrastructure/internal-api-readiness.js";

const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const cid = randomUUID();
const card = {orderRef,version:"1",projectionVersion:"1",status:"Draft",customer:{customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",displayName:"Ada"},items:[],pricing:null,aroma:{state:"NotRequested",desiredRevision:"1",observedRevision:"1",blockers:[]},allowedActions:[]};
function setup(t, permission="orders:create", overrides={}) {
  const calls=[];
  const appPromise=createRuntime({name:"orders-http-test",host:"127.0.0.1",port:0,shutdownGraceMs:500,deadlineMs:5000,deadlineProfiles:{defaultMs:500}});
  return appPromise.then(async app=>{
    registerOrdersRoutes(app,{
      verifyTransport:(_r,c)=>c==="api-public",
      verifyPublicDelegation:(_token,operation)=>({iss:"api-public",aud:"orders-service",originalIssuer:"edge-gateway",sub:"actor-a",permissions:Array.isArray(permission)?permission:[permission],operationId:operation,correlationId:cid}),
      signInternalDelegation:()=>"fixture-delegation",
      owner:{
        store:{async precheck(...args){calls.push(["precheck",...args]);return overrides.precheckResult??{kind:"proceed"};},async replay(...args){calls.push(["replay",...args]);return overrides.replayResult??{kind:"not_retained"};},async getCard(...args){calls.push(["getCard",...args]);if(overrides.getCardError)throw overrides.getCardError;return card;},async createDraft(...args){calls.push(["createDraft",...args]);return {status:201,body:card,replayed:false};},async putItem(...args){calls.push(["putItem",...args]);return {status:200,body:card,replayed:false};},async deleteItem(...args){calls.push(["deleteItem",...args]);return {status:200,body:card,replayed:false};},async confirm(...args){calls.push(["confirm",...args]);if(overrides.confirmError)throw overrides.confirmError;return {status:200,body:card,replayed:false};},async requestReconciliation(...args){calls.push(["requestReconciliation",...args]);throw Object.assign(new Error("no owner-local projection"),{code:"AROMA_RECONCILIATION_NOT_ALLOWED"});}},
        customer:{async getOrderInput(...args){calls.push(["customer",...args]);return {customerRef:card.customer.customerRef,customerVersion:"1",displayName:"Ada",state:"Active"};}},
        pricing:{async verify(...args){calls.push(["pricing",...args]);if(overrides.pricingResult)return overrides.pricingResult;throw new Error("unexpected");}},
      },
    });
    await app.runtimeController.start();
    t.after(()=>app.runtimeController.closeRuntime("SIGTERM"));
    return {app,calls};
  });
}
const headers=()=>({"x-correlation-id":cid,"x-actor-context":"signed","idempotency-key":randomUUID()});
void test("Orders readiness fails closed when required InternalApi is down and recovers", async t => {
  let reachable = false;
  let status = 503;
  const requests = [];
  const client = {async fetch(path, options) {
    requests.push({path, method: options.method, signal: options.signal, redirect: options.redirect});
    if (!reachable) throw new Error("INTERNAL_API_DOWN");
    return new Response("ok", {status});
  }};
  const app = await createRuntime({
    name: "orders-internal-api-readiness", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5000,
    readinessChecks: [{name: "orders-internal-api", check: signal => checkInternalApiReady(client, signal)}],
  });
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  assert.equal((await app.inject("/health/ready")).statusCode, 503);
  reachable = true;
  assert.equal((await app.inject("/health/ready")).statusCode, 503);
  status = 200;
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(request => request.path === "/health/ready" && request.method === "GET" && request.redirect === "error" && request.signal instanceof AbortSignal));
});
void test("six application workflows run without Fastify and preserve the owner call boundary",async()=>{
  const calls=[];
  const context={actorRef:"actor-a",permissions:["orders:create","orders:edit:any","orders:confirm:any"],identity:{actorRef:"actor-a",scope:"a".repeat(64),key:randomUUID()},correlationId:cid,signal:new AbortController().signal,deadlineUtc:null,replayOnly:false};
  const store={
    async precheck(){calls.push("precheck");return {kind:"proceed"};},
    async replay(){calls.push("replay");return {kind:"not_retained"};},
    async getCard(){calls.push("getCard");return card;},
    async createDraft(){calls.push("createDraft");return {status:201,body:card,replayed:false};},
    async putItem(){calls.push("putItem");return {status:200,body:card,replayed:false};},
    async deleteItem(){calls.push("deleteItem");return {status:200,body:card,replayed:false};},
    async confirm(){calls.push("confirm");return {status:200,body:card,replayed:false};},
    async requestReconciliation(){calls.push("requestReconciliation");return {status:202,body:{orderRef,orderVersion:"2",requestedAt:"2026-09-27T00:00:00Z",aromaState:"PendingObservation"},replayed:false};},
  };
  const customer={async getOrderInput(){calls.push("customer");return {customerRef:card.customer.customerRef,customerVersion:"1",displayName:"Ada",state:"Active"};}};
  const line={lineNumber:1,productRef:"prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",variantRef:"var_01ARZ3NDEKTSV4RRFFQ69G5FAV",productDisplayName:"Coffee",offerRef:"off_01ARZ3NDEKTSV4RRFFQ69G5FAV",mappingRevision:"1",quantity:"2",unit:"piece",supplierUnitMinor:"100",unitMinor:"150",lineTotalMinor:"300",currency:"RUB",internalProofHash:"b".repeat(64)};
  const quoteRef="prq_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const pricing={async verify(){calls.push("pricing");return {valid:true,quoteRef,policyVersionRef:"pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",catalogSnapshotRevision:"1",customerRef:card.customer.customerRef,expiresAt:new Date(Date.now()+60_000).toISOString(),currency:"RUB",line};}};
  const signInternalDelegation=()=>"fixture-delegation";
  assert.equal((await createDraft({store,customer,signInternalDelegation},{...context,customerRef:card.customer.customerRef})).status,201);
  assert.deepEqual(calls,["precheck","customer","createDraft"]);
  calls.length=0;
  const request={expectedVersion:"1",productRef:line.productRef,variantRef:line.variantRef,quantity:line.quantity,quoteRef,quoteLineNumber:1,quoteHash:"a".repeat(64)};
  assert.equal((await upsertItem({store,pricing,signInternalDelegation},{...context,orderRef,itemRef,request})).status,200);
  assert.deepEqual(calls,["precheck","getCard","pricing","putItem"]);
  calls.length=0;
  assert.equal((await deleteItem(store,{...context,orderRef,itemRef,expectedVersion:"1"})).status,200);
  assert.deepEqual(calls,["precheck","deleteItem"]);
  calls.length=0;
  assert.equal((await confirmOrder(store,{...context,orderRef,expectedVersion:"1"})).status,200);
  assert.deepEqual(calls,["precheck","confirm"]);
  calls.length=0;
  assert.equal((await getOrderCard(store,{orderRef,permissions:context.permissions,correlationId:cid,signal:context.signal})).orderRef,orderRef);
  assert.deepEqual(calls,["getCard"]);
  calls.length=0;
  assert.equal((await requestAromaReconciliation(store,{...context,orderRef,expectedVersion:"1",reason:"operator-request"})).status,202);
  assert.deepEqual(calls,["precheck","requestReconciliation"]);
  calls.length=0;
  assert.equal((await confirmOrder(store,{...context,replayOnly:true,orderRef,expectedVersion:undefined})).kind,"not_retained");
  assert.deepEqual(calls,["replay"]);
});
void test("orders owner independently authorizes before create precheck and Customer read",async t=>{
  const {app,calls}=await setup(t,"orders:read:any");
  const response=await app.inject({method:"POST",url:"/api/client-v1/orders/drafts",headers:headers(),payload:{customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV"}});
  assert.equal(response.statusCode,403);
  assert.equal(calls.length,0);
});
void test("bodyless create replay authorizes first and never calls Customer or command",async t=>{
  const {app,calls}=await setup(t);
  const response=await app.inject({method:"POST",url:"/api/client-v1/orders/drafts",headers:{...headers(),"idempotency-replay-only":"true"}});
  assert.equal(response.statusCode,410);
  assert.deepEqual(calls.map(x=>x[0]),["replay"]);
});
void test("bodyless DELETE replays the exact stored card without If-Match-Version",async t=>{
  const saved={...card,allowedActions:["edit-items"]};
  const {app,calls}=await setup(t,"orders:edit:any",{replayResult:{kind:"completed",response:{status:200,body:saved}}});
  const response=await app.inject({method:"DELETE",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:{...headers(),"idempotency-replay-only":"true"}});
  assert.equal(response.statusCode,200);
  assert.equal(response.headers["idempotency-replayed"],"true");
  assert.deepEqual(response.json(),saved);
  assert.deepEqual(calls.map(x=>x[0]),["replay"]);
});
void test("Card replay rejects a stored status from another command before responding",async t=>{
  for (const {method,url,permission,wrongStatus} of [
    {method:"POST",url:"/api/client-v1/orders/drafts",permission:"orders:create",wrongStatus:200},
    {method:"PUT",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,permission:"orders:edit:any",wrongStatus:201},
    {method:"DELETE",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,permission:"orders:edit:any",wrongStatus:201},
    {method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/confirm`,permission:"orders:confirm:any",wrongStatus:201},
  ]) {
    const {app,calls}=await setup(t,permission,{replayResult:{kind:"completed",response:{status:wrongStatus,body:card}}});
    const response=await app.inject({method,url,headers:{...headers(),"idempotency-replay-only":"true"}});
    assert.equal(response.statusCode,500,`${method} ${url}`);
    assert.equal(response.json().code,"IDEMPOTENCY_RESULT_INVALID",`${method} ${url}`);
    assert.deepEqual(calls.map(x=>x[0]),["replay"]);
  }
});
void test("DELETE validates version only for normal commands and rejects replay-only version",async t=>{
  const {app,calls}=await setup(t,"orders:edit:any");
  const url=`/api/client-v1/orders/${orderRef}/items/${itemRef}`;
  const missing=await app.inject({method:"DELETE",url,headers:headers()});
  assert.equal(missing.statusCode,400);
  assert.deepEqual(calls,[]);
  const replayWithVersion=await app.inject({method:"DELETE",url,headers:{...headers(),"idempotency-replay-only":"true","if-match-version":"1"}});
  assert.equal(replayWithVersion.statusCode,400);
  assert.deepEqual(calls,[]);
  const normal=await app.inject({method:"DELETE",url,headers:{...headers(),"if-match-version":"1"}});
  assert.equal(normal.statusCode,200);
  assert.deepEqual(calls.map(x=>x[0]),["precheck","deleteItem"]);
  assert.equal(calls[1][1].expectedVersion,"1");
});
void test("different actor permission failure cannot reach bodyless replay lookup",async t=>{
  const {app,calls}=await setup(t,"orders:read:any");
  const response=await app.inject({method:"POST",url:"/api/client-v1/orders/drafts",headers:{...headers(),"idempotency-replay-only":"true"}});
  assert.equal(response.statusCode,403);
  assert.equal(calls.length,0);
});

void test("all mutating routes reject missing permission before bodyless replay",async t=>{
  const {app,calls}=await setup(t,"orders:read:any");
  const base={...headers(),"idempotency-replay-only":"true"};
  const requests=[
    {method:"POST",url:"/api/client-v1/orders/drafts",headers:base},
    {method:"PUT",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:base},
    {method:"DELETE",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:base},
    {method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/confirm`,headers:base},
    {method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,headers:base},
  ];
  for(const request of requests)assert.equal((await app.inject(request)).statusCode,403,request.url);
  assert.equal(calls.length,0);
});

void test("draft hash precheck conflict stops before Customer network read",async t=>{
  const {app,calls}=await setup(t,"orders:create",{precheckResult:{kind:"conflict"}});
  const response=await app.inject({method:"POST",url:"/api/client-v1/orders/drafts",headers:headers(),payload:{customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV"}});
  assert.equal(response.statusCode,409);
  assert.deepEqual(calls.map(x=>x[0]),["precheck"]);
});

void test("item hash precheck conflict stops before Order lookup and Pricing network read",async t=>{
  const {app,calls}=await setup(t,"orders:edit:any",{precheckResult:{kind:"conflict"}});
  const response=await app.inject({method:"PUT",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:headers(),payload:{expectedVersion:"1",productRef:"prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",variantRef:"var_01ARZ3NDEKTSV4RRFFQ69G5FAV",quantity:"2",quoteRef:"prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",quoteLineNumber:1,quoteHash:"a".repeat(64)}});
  assert.equal(response.statusCode,409);
  assert.deepEqual(calls.map(x=>x[0]),["precheck"]);
});

void test("GET independently requires read permission and performs only the owner read",async t=>{
  const denied=await setup(t,"orders:create");
  const deniedResponse=await denied.app.inject({method:"GET",url:`/api/client-v1/orders/${orderRef}`,headers:headers()});
  assert.equal(deniedResponse.statusCode,403);
  assert.equal(denied.calls.length,0);
  const allowed=await setup(t,"orders:read:any");
  const response=await allowed.app.inject({method:"GET",url:`/api/client-v1/orders/${orderRef}`,headers:headers()});
  assert.equal(response.statusCode,200);
  assert.deepEqual(allowed.calls.map(x=>x[0]),["getCard"]);
});

void test("Confirm uses persisted store facts only and makes no Customer or Pricing call",async t=>{
  const {app,calls}=await setup(t,"orders:confirm:any");
  const response=await app.inject({method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/confirm`,headers:headers(),payload:{expectedVersion:"1"}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(calls.map(x=>x[0]),["precheck","confirm"]);
});

void test("four owner mutations forward verified current card permissions",async t=>{
  const granted=["orders:create","orders:edit:any","orders:confirm:any"];
  const line={lineNumber:1,productRef:"prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",variantRef:"var_01ARZ3NDEKTSV4RRFFQ69G5FAV",productDisplayName:"Coffee",offerRef:"off_01ARZ3NDEKTSV4RRFFQ69G5FAV",mappingRevision:"1",quantity:"2",unit:"piece",supplierUnitMinor:"100",unitMinor:"150",lineTotalMinor:"300",currency:"RUB",internalProofHash:"b".repeat(64)};
  const pricingResult={valid:true,quoteRef:"prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",policyVersionRef:"pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",catalogSnapshotRevision:"1",customerRef:card.customer.customerRef,expiresAt:new Date(Date.now()+60_000).toISOString(),currency:"RUB",line};
  const {app,calls}=await setup(t,granted,{pricingResult});
  const requests=[
    {method:"POST",url:"/api/client-v1/orders/drafts",headers:headers(),payload:{customerRef:card.customer.customerRef},command:"createDraft"},
    {method:"PUT",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:headers(),payload:{expectedVersion:"1",productRef:line.productRef,variantRef:line.variantRef,quantity:line.quantity,quoteRef:pricingResult.quoteRef,quoteLineNumber:line.lineNumber,quoteHash:"a".repeat(64)},command:"putItem"},
    {method:"DELETE",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:{...headers(),"if-match-version":"1"},command:"deleteItem"},
    {method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/confirm`,headers:headers(),payload:{expectedVersion:"1"},command:"confirm"},
  ];
  for(const {command,...request} of requests){
    const response=await app.inject(request);
    assert.equal(response.statusCode,command==="createDraft"?201:200,command);
    const call=calls.findLast(x=>x[0]===command);
    assert.ok(call,`${command} must reach owner`);
    assert.deepEqual(call[1].cardPermissions,granted,command);
  }
});
void test("pre-#11 reconciliation refuses without claiming a durable 202",async t=>{
  const {app,calls}=await setup(t,"orders:reconcile:any");
  const response=await app.inject({method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,headers:headers(),payload:{expectedVersion:"1",reason:"operator-request"}});
  assert.equal(response.statusCode,409);
  assert.equal(response.json().code,"AROMA_RECONCILIATION_NOT_ALLOWED");
  assert.deepEqual(calls.map(x=>x[0]),["precheck","requestReconciliation"]);
});

void test("owner errors preserve public Order not-found and optimistic conflict codes",async t=>{
  const missing=await setup(t,"orders:read:any",{getCardError:Object.assign(new Error("missing"),{code:"ORDER_NOT_FOUND"})});
  const get=await missing.app.inject({method:"GET",url:`/api/client-v1/orders/${orderRef}`,headers:headers()});
  assert.equal(get.statusCode,404);
  assert.equal(get.json().code,"ORDER_NOT_FOUND");
  const conflict=await setup(t,"orders:confirm:any",{confirmError:Object.assign(new Error("stale"),{code:"ORDER_VERSION_CONFLICT"})});
  const confirm=await conflict.app.inject({method:"POST",url:`/api/client-v1/orders/${orderRef}/commands/confirm`,headers:headers(),payload:{expectedVersion:"1"}});
  assert.equal(confirm.statusCode,409);
  assert.equal(confirm.json().code,"ORDER_VERSION_CONFLICT");
});

void test("selected Pricing line scope mismatch returns the exact code before item persistence",async t=>{
  const wrongLine={lineNumber:1,productRef:"prd_01ARZ3NDEKTSV4RRFFQ69G5FAY",variantRef:"var_01ARZ3NDEKTSV4RRFFQ69G5FAV",productDisplayName:"Coffee",offerRef:"off_01ARZ3NDEKTSV4RRFFQ69G5FAV",mappingRevision:"1",quantity:"2",unit:"piece",supplierUnitMinor:"100",unitMinor:"150",lineTotalMinor:"300",currency:"RUB",internalProofHash:"b".repeat(64)};
  const pricingResult={valid:true,quoteRef:"prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",policyVersionRef:"pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",catalogSnapshotRevision:"1",customerRef:card.customer.customerRef,expiresAt:new Date(Date.now()+60_000).toISOString(),currency:"RUB",line:wrongLine};
  const {app,calls}=await setup(t,"orders:edit:any",{pricingResult});
  const body={expectedVersion:"1",productRef:"prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",variantRef:wrongLine.variantRef,quantity:"2",quoteRef:pricingResult.quoteRef,quoteLineNumber:1,quoteHash:"a".repeat(64)};
  const response=await app.inject({method:"PUT",url:`/api/client-v1/orders/${orderRef}/items/${itemRef}`,headers:headers(),payload:body});
  assert.equal(response.statusCode,409);
  assert.equal(response.json().code,"ORDER_QUOTE_SCOPE_MISMATCH");
  assert.deepEqual(calls.map(x=>x[0]),["precheck","getCard","pricing"]);
});
