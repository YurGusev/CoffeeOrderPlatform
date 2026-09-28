import assert from "node:assert/strict";
import {AsyncLocalStorage} from "node:async_hooks";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {ROOT_CONTEXT, context, metrics, trace, SpanStatusCode} from "@opentelemetry/api";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {observe} from "../../apps/orders-service/dist/observability.js";
import {confirmOrder} from "../../apps/orders-service/dist/application/confirm-order.js";
import {registerOrdersRoutes} from "../../apps/orders-service/dist/http/index.js";
import {createCustomerOrderInputClient} from "../../apps/orders-service/dist/infrastructure/customer-client.js";

// Deliberately an in-process probe, not a production provider or exporter.
const storage = new AsyncLocalStorage();
const manager = {
  active: () => storage.getStore() ?? ROOT_CONTEXT,
  with: (value, fn, self, ...args) => storage.run(value, () => fn.apply(self, args)),
  bind: (value, target) => (...args) => storage.run(value, () => target(...args)),
  enable() { return this; },
  disable() { storage.disable(); return this; },
};
assert.equal(context.setGlobalContextManager(manager), true);
const spans = [];
let nextTrace = 0;
assert.equal(trace.setGlobalTracerProvider({getTracer(name) {
  assert.equal(name, "coffee-platform.orders-service");
  return {startSpan(spanName, options) {
    const parent = trace.getSpan(context.active());
    const spanContext = {traceId: parent?.spanContext().traceId ?? String(++nextTrace).padStart(32, "0"), spanId: String(spans.length + 1).padStart(16, "0"), traceFlags: 1};
    const span = {name: spanName, options, parent, attributes: {}, status: undefined, ends: 0,
      spanContext: () => spanContext,
      setAttribute(key, value) { this.attributes[key] = value; return this; },
      setStatus(value) { this.status = value; return this; },
      end() { this.ends++; },
    };
    spans.push(span);
    return span;
  }};
}}), true);
const measurements = [];
assert.equal(metrics.setGlobalMeterProvider({getMeter(name) {
  assert.equal(name, "coffee-platform.orders-service");
  return {
    createCounter(instrument) {return {add(value, attributes) {measurements.push({instrument, value, attributes});}};},
    createHistogram(instrument) {return {record(value, attributes) {measurements.push({instrument, value, attributes});}};},
  };
}}), true);

void test("Orders records bounded operation/result/state metrics without request identifiers or error data", async () => {
  measurements.length = 0;
  const canary = "metric-private-customer-and-error-canary";
  await observe("orders.transaction.confirm", async () => ({body:{aroma:{state:"PendingObservation"},customer:canary}}));
  await observe("orders.http.get", async () => ({statusCode:404, requestBody:canary}), undefined, result => result.statusCode >= 400);
  await assert.rejects(observe("orders.pricing.verify", async () => {throw new Error(canary);}), {message:canary});
  const counters = measurements.filter(entry => entry.instrument === "orders.operation.total");
  const durations = measurements.filter(entry => entry.instrument === "orders.operation.duration_ms");
  assert.equal(counters.length, 3);
  assert.equal(durations.length, 3);
  assert.deepEqual(counters.map(entry => entry.attributes), [
    {"orders.operation":"orders.transaction.confirm", "orders.result":"success", "orders.state":"PendingObservation"},
    {"orders.operation":"orders.http.get", "orders.result":"error", "orders.state":"unknown"},
    {"orders.operation":"orders.pricing.verify", "orders.result":"error", "orders.state":"unknown"},
  ]);
  assert.ok(counters.every(entry => entry.value === 1));
  assert.ok(durations.every(entry => Number.isFinite(entry.value) && entry.value >= 0));
  assert.ok(!JSON.stringify(measurements).includes(canary));
});

void test("Orders use-case metrics classify returned idempotency rejections without leaking command data", async () => {
  measurements.length = 0;
  spans.length = 0;
  const input = {orderRef:"ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",expectedVersion:"1",replayOnly:false,signal:new AbortController().signal};
  for (const kind of ["conflict","in_progress","invalid","not_retained"]) {
    const result = await confirmOrder({precheck:async () => ({kind}),confirm:async () => {throw Error("must not confirm");}},input);
    assert.equal(result.kind,kind);
  }
  const replay = await confirmOrder({replay:async () => ({kind:"invalid"})},{...input,replayOnly:true});
  assert.equal(replay.kind,"invalid");
  const result = await confirmOrder({precheck:async () => ({kind:"completed",response:{status:200,body:{}}}),confirm:async () => {throw Error("must not confirm");}},input);
  assert.equal(result.kind,"completed");
  const counters = measurements.filter(entry => entry.instrument === "orders.operation.total");
  assert.deepEqual(counters.map(entry => entry.attributes), [
    ...Array.from({length:5}, () => ({"orders.operation":"orders.use_case.confirm","orders.result":"error","orders.state":"unknown"})),
    {"orders.operation":"orders.use_case.confirm","orders.result":"success","orders.state":"unknown"},
  ]);
  assert.deepEqual(spans.map(span => span.attributes["orders.outcome"]),["error","error","error","error","error","success"]);
  assert.ok(measurements.every(entry => !JSON.stringify(entry).includes(input.orderRef)));
});

void test("fixed Orders spans preserve async parentage across parallel requests and do not leak caller facts", async () => {
  spans.length = 0;
  const gates = Array.from({length:2}, () => Promise.withResolvers());
  let sequence = 0;
  const canary = "private-order-customer-canary";
  const client = createCustomerOrderInputClient({fetch: async () => {
    const n = sequence++;
    await gates[n].promise;
    return new Response(JSON.stringify({customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",customerVersion:"1",displayName:canary,state:"Active"}), {status:200,headers:{"content-type":"application/json"}});
  }});
  const request = () => ({customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",delegation:canary,correlationId:randomUUID(),signal:new AbortController().signal});
  const run = () => observe("orders.http.create", async () => {
    await Promise.resolve();
    return client.getOrderInput(request());
  });
  const first = run(), second = run();
  await Promise.resolve();
  gates[1].resolve(); gates[0].resolve();
  const result = await Promise.all([first, second]);
  assert.equal(result[0].displayName, canary);
  assert.equal(result[1].displayName, canary);
  const roots = spans.filter(span => span.name === "orders.http.create");
  const children = spans.filter(span => span.name === "orders.customer.order_input");
  assert.equal(roots.length, 2);
  assert.equal(children.length, 2);
  assert.equal(children[0].parent, roots[0]);
  assert.equal(children[1].parent, roots[1]);
  assert.notEqual(roots[0].spanContext().traceId, roots[1].spanContext().traceId);
  assert.ok(spans.every(span => span.ends === 1 && span.options === undefined));
  assert.ok(spans.every(span => !JSON.stringify({name:span.name,attributes:span.attributes,status:span.status}).includes(canary)));
  await assert.rejects(observe(`orders.http.create.${canary}`, async () => "no"), TypeError);
});

void test("failure and abort end the same span exactly once and rethrow the same object without recording it", async () => {
  spans.length = 0;
  const canary = "private-error-canary";
  const failure = new Error(canary);
  await assert.rejects(observe("orders.transaction.confirm", async () => {throw failure;}), error => error === failure);
  const controller = new AbortController();
  const pending = observe("orders.pricing.verify", async () => {
    controller.abort(failure);
    controller.signal.throwIfAborted();
  }, controller.signal);
  await assert.rejects(pending, error => error === failure);
  assert.deepEqual(spans.map(span => span.ends), [1, 1]);
  assert.deepEqual(spans.map(span => span.status), [{code:SpanStatusCode.ERROR}, {code:SpanStatusCode.ERROR}]);
  assert.deepEqual(spans.map(span => span.attributes["orders.outcome"]), ["error", "aborted"]);
  assert.ok(!JSON.stringify(spans.map(({name,attributes,status}) => ({name,attributes,status}))).includes(canary));
});

void test("Orders real HTTP route spans cover successful, rejected, and parallel requests without body or path attributes", async t => {
  spans.length = 0;
  const app = await createRuntime({name:"orders-otel-test",host:"127.0.0.1",port:0,shutdownGraceMs:500,deadlineMs:5000,deadlineProfiles:{defaultMs:500}});
  const cid = randomUUID();
  const ref = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const card = {orderRef:ref,version:"1",projectionVersion:"1",status:"Draft",customer:{customerRef:"cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",displayName:"Ada"},items:[],pricing:null,aroma:{state:"NotRequested",desiredRevision:"1",observedRevision:"1",blockers:[]},allowedActions:[]};
  registerOrdersRoutes(app,{verifyTransport:()=>true,
    verifyPublicDelegation:(_token,operation)=>({iss:"api-public",aud:"orders-service",originalIssuer:"edge-gateway",sub:"actor-a",permissions:["orders:read:any","orders:create"],operationId:operation,correlationId:cid}),
    signInternalDelegation:()=>"signed",
    owner:{store:{async getCard(){await Promise.resolve();return card;},async precheck(){return {kind:"proceed"};},async createDraft(){return {status:201,body:card,replayed:false};}},
      customer:createCustomerOrderInputClient({fetch:async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({customerRef:card.customer.customerRef,customerVersion:"1",displayName:"Ada",state:"Active"}), {status:200,headers:{"content-type":"application/json"}});
      }}),pricing:{}}});
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const headers = {"x-correlation-id":cid,"x-actor-context":"canary-secret"};
  const [ok,notFound] = await Promise.all([
    app.inject({method:"GET",url:`/api/client-v1/orders/${ref}`,headers}),
    app.inject({method:"GET",url:"/api/client-v1/orders/invalid-secret",headers}),
  ]);
  assert.equal(ok.statusCode,200);
  assert.equal(notFound.statusCode,400);
  const routes = spans.filter(span => span.name === "orders.http.get");
  assert.equal(routes.length,2);
  assert.deepEqual(routes.map(span => span.ends),[1,1]);
  assert.deepEqual(new Set(routes.map(span => span.attributes["orders.outcome"])),new Set(["success","error"]));
  const [createdA,createdB] = await Promise.all(Array.from({length:2}, () => app.inject({method:"POST",url:"/api/client-v1/orders/drafts",headers:{...headers,"idempotency-key":randomUUID()},payload:{customerRef:card.customer.customerRef}})));
  assert.deepEqual([createdA.statusCode,createdB.statusCode],[201,201]);
  const creates = spans.filter(span => span.name === "orders.http.create");
  const useCases = spans.filter(span => span.name === "orders.use_case.create");
  const customerReads = spans.filter(span => span.name === "orders.customer.order_input");
  assert.equal(creates.length,2);
  assert.equal(useCases.length,2);
  assert.equal(customerReads.length,2);
  assert.deepEqual(useCases.map(span => span.parent),creates);
  assert.deepEqual(customerReads.map(span => span.parent),useCases);
  assert.notEqual(creates[0].spanContext().traceId,creates[1].spanContext().traceId);
  assert.ok([...creates,...customerReads].every(span => span.ends === 1 && span.attributes["orders.outcome"] === "success"));
  assert.ok(!JSON.stringify(routes.map(({name,attributes}) => ({name,attributes}))).includes("canary-secret"));
});
