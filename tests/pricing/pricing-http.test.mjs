import assert from "node:assert/strict";
import test from "node:test";
import {randomUUID} from "node:crypto";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {isPricingProblem} from "../../packages/contracts/pricing-v1/dist/index.js";
import {registerPricingRoutes} from "../../apps/pricing-service/dist/http/index.js";

const ref = prefix => `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FAV`;
const CREATE = "/api/client-v1/pricing/quotes";
const VERIFY = "/api/internal-v1/pricing/quotes:verify";
const request = {customerRef:ref("cus"),lines:[{productRef:ref("prd"),variantRef:ref("var"),quantity:"2.5"}]};
const quote = {quoteRef:ref("prq"),policyVersionRef:ref("pvr"),catalogSnapshotRevision:"1",customerRef:ref("cus"),createdAt:"2026-09-26T01:00:00.000Z",expiresAt:"2026-09-26T01:15:00.000Z",currency:"RUB",lines:[{lineNumber:1,productRef:ref("prd"),variantRef:ref("var"),productDisplayName:"Coffee",quantity:"2.5",unit:"piece",unitMinor:"130",lineTotalMinor:"325"}],totalMinor:"325",hash:"a".repeat(64)};
const verifyRequest = {quoteRef:quote.quoteRef,hash:quote.hash,customerRef:quote.customerRef,lines:request.lines};
const verified = {valid:true,quoteRef:quote.quoteRef,policyVersionRef:quote.policyVersionRef,catalogSnapshotRevision:"1",customerRef:quote.customerRef,expiresAt:quote.expiresAt,currency:"RUB",totalMinor:"325",lines:[{...quote.lines[0],currency:"RUB",offerRef:ref("off"),mappingRevision:"1",supplierUnitMinor:"100",internalProofHash:"b".repeat(64)}]};
function adapters(calls, changes={}) {
  return {
    verifyTransport:(_request,caller)=>{calls.transport.push(caller); return changes.transport !== false;},
    verifyPublicDelegation:(_token,operation)=>({iss:"api-public",aud:"pricing-service",originalIssuer:"edge-gateway",sub:"usr_test",permissions:changes.permissions ?? ["pricing:create"],operationId:operation,correlationId:calls.correlationId, ...changes.publicClaims}),
    verifyInternalDelegation:(_token,operation)=>({iss:"api-internal",aud:"pricing-service",originalCaller:"orders-service",operationId:operation,correlationId:calls.correlationId, ...changes.internalClaims}),
    signCatalogDelegation:()=>"signed",
    owner:{
      async create(input){calls.create.push(input);if(changes.createError)throw changes.createError;return changes.createResult ?? {status:201,body:quote,replayed:false};},
      async replay(identity,signal){calls.replay.push({identity,signal});return changes.replayResult ?? {kind:"completed",status:201,body:quote,replayed:true};},
      async verify(body,context){calls.verify.push({body,context});return changes.verifyResult ?? verified;},
    },
  };
}
async function setup(t,changes={}) {
  const calls={transport:[],create:[],replay:[],verify:[],correlationId:randomUUID()};
  const app=await createRuntime({name:"pricing-http-test",host:"127.0.0.1",port:0,shutdownGraceMs:500,deadlineMs:5_000,deadlineProfiles:{defaultMs:5_000}});
  registerPricingRoutes(app,adapters(calls,changes));
  await app.runtimeController.start();
  t.after(()=>app.runtimeController.closeRuntime("SIGTERM"));
  const client=(body=request,headers={})=>app.inject({method:"POST",url:CREATE,headers:{"x-correlation-id":calls.correlationId,"x-actor-context":"signed","idempotency-key":randomUUID(),...headers},...(body===false?{}:{payload:body})});
  const internal=(body=verifyRequest,headers={})=>app.inject({method:"POST",url:VERIFY,headers:{"x-correlation-id":calls.correlationId,"x-service-delegation":"signed",...headers},payload:body});
  return {app,calls,client,internal};
}
function problem(response,status,code){assert.equal(response.statusCode,status,response.body);assert.equal(response.json().code,code);assert.equal(isPricingProblem(response.json()),true);assert.match(response.headers["content-type"],/^application\/problem\+json/);}

void test("transport, delegation, permission and spoofed headers fail closed",async t=>{
  const {calls,client,internal}=await setup(t);
  problem(await client(request,{"x-actor-context":""}),403,"ACTOR_CONTEXT_INVALID");
  problem(await client(request,{"x-original-caller":"orders-service"}),403,"ACTOR_CONTEXT_INVALID");
  problem(await internal(verifyRequest,{"x-actor-context":"forged"}),403,"SERVICE_DELEGATION_INVALID");
  problem(await internal(verifyRequest,{"x-service-delegation":""}),403,"SERVICE_DELEGATION_INVALID");
  assert.equal(calls.create.length+calls.verify.length,0);
  const noPeer=await setup(t,{transport:false});
  problem(await noPeer.client(),401,"AUTHENTICATION_REQUIRED");
  problem(await noPeer.internal(),401,"SERVICE_AUTHENTICATION_REQUIRED");
  assert.deepEqual(noPeer.calls.transport,["api-public","api-internal"]);
});
void test("create accepts only validated request, UUID and verified pricing:create identity",async t=>{
  const {calls,client}=await setup(t);
  const result=await client();
  assert.equal(result.statusCode,201,result.body);
  assert.deepEqual(result.json(),quote);
  assert.equal(result.headers["cache-control"],"no-store");
  assert.equal(calls.create[0].identity.actorRef,"usr_test");
  assert.match(calls.create[0].identity.scope,/^[0-9a-f]{64}$/);
  assert.equal(calls.create[0].context.signal instanceof AbortSignal,true);
  problem(await client(request,{"idempotency-key":"not-uuid"}),400,"VALIDATION_FAILED");
  problem(await client({...request,privateCost:"secret"}),400,"VALIDATION_FAILED");
  assert.equal(calls.create.length,1);
});
void test("bodyless replay reads only owner precheck, never creates",async t=>{
  const {calls,client}=await setup(t);
  const response=await client(false,{"idempotency-replay-only":"true"});
  assert.equal(response.statusCode,201,response.body);
  assert.equal(response.headers["idempotency-replayed"],"true");
  assert.equal(calls.replay.length,1);
  assert.equal(calls.create.length,0);
  problem(await client(request,{"idempotency-replay-only":"true"}),400,"VALIDATION_FAILED");
  problem(await client(false),400,"VALIDATION_FAILED");
  const unavailable=await setup(t,{replayResult:{kind:"not_retained"}});
  problem(await unavailable.client(false,{"idempotency-replay-only":"true"}),410,"IDEMPOTENCY_RESULT_NOT_RETAINED");
  assert.equal(unavailable.calls.create.length,0);
});
void test("verify accepts orders-service only and keeps audit owner operation",async t=>{
  const {calls,internal}=await setup(t);
  const result=await internal();
  assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json(),verified);
  assert.equal(calls.verify.length,1);
  assert.equal(calls.verify[0].context.signal instanceof AbortSignal,true);
  problem(await internal(verifyRequest,{"idempotency-key":randomUUID()}),403,"SERVICE_DELEGATION_INVALID");
});
void test("invalid audience, permissions, payloads and owner responses reject without private data",async t=>{
  const denied=await setup(t,{publicClaims:{aud:"orders-service"},internalClaims:{originalCaller:"api-public"}});
  problem(await denied.client(),403,"ACTOR_CONTEXT_INVALID");
  problem(await denied.internal(),403,"SERVICE_DELEGATION_INVALID");
  assert.equal(denied.calls.create.length+denied.calls.verify.length,0);
  const missing=await setup(t,{permissions:[]});
  problem(await missing.client(),403,"ACTOR_CONTEXT_INVALID");
  const malformed=await setup(t,{createResult:{status:201,body:{...quote,supplierUnitMinor:"SECRET"},replayed:false},verifyResult:{...verified,lines:[{...verified.lines[0],internalProofHash:"bad"}]}});
  problem(await malformed.client(),500,"INTERNAL_ERROR");
  problem(await malformed.internal(),500,"INTERNAL_ERROR");
  problem(await malformed.internal({...verifyRequest,hash:"bad"}),400,"VALIDATION_FAILED");
  assert.equal(malformed.calls.verify.length,1);
  assert.doesNotMatch(JSON.stringify(malformed.calls.create[0].request),/SECRET/);
});
void test("missing policy returns the typed public 503; unknown commit never becomes a Catalog error",async t=>{
  const missing=await setup(t,{createError:{code:"PRICING_POLICY_UNAVAILABLE"}});
  problem(await missing.client(),503,"PRICING_POLICY_UNAVAILABLE");
  const uncertain=await setup(t,{createError:{code:"TRANSACTION_OUTCOME_UNKNOWN"}});
  problem(await uncertain.client(),500,"INTERNAL_ERROR");
  assert.equal(uncertain.calls.create.length,1);
});
