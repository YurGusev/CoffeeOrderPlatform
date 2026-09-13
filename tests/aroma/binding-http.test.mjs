import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {createHttpAromaBindingClient, registerInternalRoutes} from "../../apps/api-internal/dist/index.js";
import {signServiceDelegation} from "../../packages/platform-security/dist/index.js";
import {registerAromaBindingRoutes, registerAromaCartSnapshotRoute} from "../../apps/aroma-gateway/dist/transport/http/index.js";
import {ProviderError} from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import {OfferBindingStore} from "../../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";

const body = {
  offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  supplierRef: "sup_00000000000000000000000001",
  snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FB0",
  sourceIdentityScheme: "hmac-sha256-v1",
  sourceOfferKeyHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const response = {offerRef: body.offerRef, supplierRef: body.supplierRef, sourceIdentityScheme: body.sourceIdentityScheme, sourceOfferKeyHash: body.sourceOfferKeyHash, firstSnapshotRef: body.snapshotRef, state: "Bound"};

const {privateKey, publicKey} = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({type: "spki", format: "pem"}).toString();
const now = () => Math.floor(Date.now() / 1000);
const token = (overrides = {}) => {
  const iat = now();
  return signServiceDelegation({
    iss: "api-internal", aud: "aroma-gateway", originalCaller: "catalog-activation-worker", operationId: "registerAromaOfferBinding",
    correlationId: "corr", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat, exp: iat + 30, jti: `jti-${Math.random()}`, kid: "test", ...overrides,
  }, privateKey);
};


async function runtime(t, adapters) {
  const app = await createRuntime({name: "binding-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  registerInternalRoutes(app, adapters);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

void test("binding route accepts only catalog activation transport and forwards a fixed delegation", async (t) => {
  let transportCaller = "catalog-activation-worker";
  let calls = 0;
  let forwarded;
  const app = await runtime(t, {
    verifyTransport: (_request, expected) => transportCaller === expected,
    verifyCallerDelegation: () => { throw new Error("must not be used"); },
    signDelegation: ({originalCaller, operationId}) => `signed:${originalCaller}:${operationId}`,
    customer: {orderInput: async () => { throw new Error("must not be used"); }},
    binding: {register: async (request, _context, delegation) => { calls++; forwarded = {request, delegation}; return {status: 200, body: response}; }},
  });
  const success = await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", payload: body});
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), response);
  assert.deepEqual(forwarded, {request: body, delegation: "signed:catalog-activation-worker:registerAromaOfferBinding"});
  assert.equal(calls, 1);
  transportCaller = "orders-service";
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", payload: body})).statusCode, 401);
  assert.equal(calls, 1);
  transportCaller = "catalog-activation-worker";
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: {"x-service-delegation": "forged"}, payload: body})).statusCode, 403);
  assert.equal(calls, 1);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", payload: {...body, rawProviderOfferId: "secret"}})).statusCode, 400);
  assert.equal(calls, 1);
});

void test("binding client bounds and validates the Gateway response", async () => {
  let request;
  const client = createHttpAromaBindingClient({fetch: async (path, options) => {
    request = {path, options};
    return new Response(JSON.stringify(response), {status: 200, headers: {"content-type": "application/json"}});
  }});
  const result = await client.register(body, {correlationId: "corr", signal: new AbortController().signal}, "signed");
  assert.deepEqual(result, {status: 200, body: response});
  assert.equal(request.path, "/api/internal-v1/aroma/offer-bindings");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-service-delegation"], "signed");
  assert.equal(request.options.headers["x-actor-ref"], undefined);
});

void test("Gateway binding verifies signed delegation before store and rejects claim/transport variants", async (t) => {
  let transport = "api-internal";
  let calls = 0;
  const app = await createRuntime({name: "gateway-binding-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {runtime: transport, environment: "test", san: `spiffe://test/${transport}`};
  });
  t.mock.method(OfferBindingStore.prototype, "register", async () => { calls++; return response; });
  registerAromaBindingRoutes(app, {}, {secrets: {security: {delegationVerificationKeys: {"api-internal": {active: publicPem, previous: publicPem}}}}});
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const headers = () => ({"x-service-delegation": token()});
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: headers(), payload: body})).statusCode, 200);
  const malformed = await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: {...headers(), "content-type": "application/json"}, payload: "{"});
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.headers["content-type"].startsWith("application/problem+json"), true);
  assert.equal(malformed.json().code, "VALIDATION_FAILED");
  assert.equal(calls, 1);
  const empty = await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: {...headers(), "content-type": "application/json"}, payload: ""});
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.headers["content-type"].startsWith("application/problem+json"), true);
  assert.equal(empty.json().code, "VALIDATION_FAILED");
  assert.equal(calls, 1);
  for (const claims of [
    {aud: "wrong-audience"},
    {operationId: "wrongOperation"},
    {originalCaller: "orders-service"},
    {exp: now() - 30, iat: now() - 60},
  ]) {
    assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: {"x-service-delegation": token(claims)}, payload: body})).statusCode, 403);
  }
  const tampered = `${token().slice(0, -2)}xx`;
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: {"x-service-delegation": tampered}, payload: body})).statusCode, 403);
  transport = "orders-service";
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers: headers(), payload: body})).statusCode, 401);
  assert.equal(calls, 1);
});

void test("Gateway cart snapshot route verifies delegation, returns only the contract DTO, and sanitizes provider failures", async (t) => {
  let transport = "api-internal";
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: "aroma-gateway:cart-body-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capturedAt: "2026-09-12T16:20:00Z",
    cartFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lines: [{offerRef: body.offerRef, quantity: "1"}],
  };
  let failure = false;
  const app = await createRuntime({name: "gateway-cart-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000, cartMs: 5_000}});
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {runtime: transport, environment: "test", san: `spiffe://test/${transport}`};
  });
  registerAromaCartSnapshotRoute(app, {read: async () => {
    if (failure) throw new ProviderError("ProviderReadIncomplete", true);
    return snapshot;
  }}, {secrets: {security: {delegationVerificationKeys: {"api-internal": {active: publicPem, previous: publicPem}}}}});
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const cartToken = (overrides = {}) => {
    const iat = now();
    return signServiceDelegation({
      iss: "api-internal", aud: "aroma-gateway", originalCaller: "aroma-observer", operationId: "readAromaCartSnapshot",
      correlationId: "corr", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat, exp: iat + 30, jti: `jti-cart-${Math.random()}`, kid: "test", ...overrides,
    }, privateKey);
  };
  const headers = () => ({"x-service-delegation": cartToken()});
  const success = await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: headers(), payload: {cartScopeRef: "aroma-primary"}});
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), snapshot);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: headers(), payload: {}})).statusCode, 400);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: {"x-service-delegation": cartToken({originalCaller: "aroma-convergence"})}, payload: {cartScopeRef: "aroma-primary"}})).statusCode, 200);
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: {"x-service-delegation": cartToken({originalCaller: "orders-service"})}, payload: {cartScopeRef: "aroma-primary"}})).statusCode, 403);
  failure = true;
  const failed = await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: headers(), payload: {cartScopeRef: "aroma-primary"}});
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "AROMA_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(failed.body, /ProviderReadIncomplete/u);
  transport = "aroma-observer";
  assert.equal((await app.inject({method: "POST", url: "/api/internal-v1/aroma/cart-snapshots:read", headers: headers(), payload: {cartScopeRef: "aroma-primary"}})).statusCode, 401);
});
