import assert from "node:assert/strict";
import {generateKeyPairSync, randomUUID} from "node:crypto";
import test from "node:test";
import {isCustomerProblem} from "../../packages/contracts/customer-v1/dist/index.js";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {createEd25519CustomerCursorSigner, decodeCustomerCursor, encodeCustomerCursor, searchCustomers} from "../../apps/customer-service/dist/application/search-customers.js";
import {normalizeCustomerCreate, normalizeSearchQuery} from "../../apps/customer-service/dist/domain/customer.js";
import {createCustomerOwner, registerCustomerRoutes} from "../../apps/customer-service/dist/http/index.js";
import {createHttpCustomerClient, registerPublicRoutes} from "../../apps/api-public/dist/index.js";

const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const timestamp = "2026-09-05T00:00:00Z";

function response() {
  return {customerRef, version: "1", displayName: "Test Customer", createdAt: timestamp, updatedAt: timestamp};
}

function claims(operationId, permissions = ["customer:create", "customer:read"]) {
  return {
    iss: "api-public",
    aud: "customer-service",
    originalIssuer: "edge-gateway",
    sub: "usr_test",
    permissions,
    operationId,
    correlationId: randomUUID(),
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat: 1_000,
    exp: 2_000,
    jti: randomUUID(),
    kid: "test",
  };
}

async function runtime(t, register) {
  const app = await createRuntime({name: "customer-http-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000, deadlineProfiles: {defaultMs: 5_000}});
  register(app);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function customerAdapters(calls, permissions = ["customer:create", "customer:read"], create = async () => ({status: 201, body: response()})) {
  return {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId) => claims(operationId, permissions),
    verifyInternalDelegation: () => ({...claims("getCustomerOrderInput", []), iss: "api-internal", aud: "customer-service", originalCaller: "orders-service"}),
    owner: {
      create: async (input) => { calls.create += 1; return create(input); },
      search: async () => ({status: 200, body: {items: [], nextCursor: null}}),
      orderInput: async () => ({status: 200, body: {customerRef, customerVersion: "1", displayName: "Test Customer", state: "Active"}}),
      replay: async () => { calls.replay += 1; return {kind: "completed", response: {status: 201, body: response()}}; },
    },
  };
}

function publicClaims(operationId, permissions = ["customer:create", "customer:read"]) {
  return {...claims(operationId, permissions), iss: "edge-gateway", aud: "api-public", originalIssuer: "edge-gateway"};
}

function assertProblem(result, status, code) {
  const body = result.json();
  assert.equal(result.statusCode, status);
  assert.match(result.headers["content-type"], /^application\/problem\+json/u);
  assert.equal(isCustomerProblem(body), true);
  assert.equal(body.status, status);
  assert.equal(body.code, code);
  assert.deepEqual(body.errors, []);
}

void test("Customer cursors require a signer and reject payload tampering", () => {
  const search = normalizeSearchQuery("test");
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const signer = createEd25519CustomerCursorSigner(privateKey, publicKey);
  const cursor = {v: 1, queryHash: search.queryHash, name: "test customer", customerRef};
  const encoded = encodeCustomerCursor(cursor, signer);
  assert.deepEqual(decodeCustomerCursor(encoded, search, signer), cursor);
  const unsigned = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  assert.throws(() => decodeCustomerCursor(unsigned, search, signer), /cursor is invalid/);
  assert.throws(() => decodeCustomerCursor("a".repeat(2_049), search, signer), /cursor is invalid/);
  const payload = encoded.slice(0, -86);
  const signature = encoded.slice(-86);
  const forgedPayload = Buffer.from(Buffer.from(payload, "base64url").toString("utf8").replace(customerRef, "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW"), "utf8").toString("base64url");
  const forged = `${forgedPayload}${signature}`;
  assert.match(forged, /^[A-Za-z0-9_-]+$/u);
  assert.throws(() => decodeCustomerCursor(forged, search, signer), /cursor is invalid/);
});

void test("Customer search decodes limits and paginates a Unicode cursor through real Ed25519 HTTP", async (t) => {
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const signer = createEd25519CustomerCursorSigner(privateKey, publicKey);
  const searchQuery = "客户";
  const firstName = searchQuery + Array.from({length: 198}, (_, index) => String.fromCodePoint(0x4e00 + ((index * 7919 + 1237) % 20000))).join("");
  assert.equal(normalizeCustomerCreate({displayName: firstName, phone: "+79991234567"}).displayName, firstName);
  const secondRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const rows = [
    {customerRef, version: "1", displayName: firstName, name: firstName.toLowerCase(), phoneE164: null, emailNormalized: null},
    {customerRef: secondRef, version: "1", displayName: firstName, name: firstName.toLowerCase(), phoneE164: null, emailNormalized: null},
  ];
  const store = {
    search: async (_search, cursor, limit) => {
      const found = cursor === null ? 0 : rows.findIndex((row) => row.name > cursor.name || (row.name === cursor.name && row.customerRef > cursor.customerRef));
      const start = found === -1 ? rows.length : found;
      return rows.slice(start, start + limit);
    },
  };
  const app = await runtime(t, (value) => registerCustomerRoutes(value, {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId) => claims(operationId),
    verifyInternalDelegation: () => ({...claims("getCustomerOrderInput"), iss: "api-internal", aud: "customer-service", originalCaller: "orders-service"}),
    owner: {
      create: async () => ({status: 201, body: response()}),
      search: async ({query, limit, cursor: nextCursor}) => ({status: 200, body: await searchCustomers(store, {query, limit, ...(nextCursor === undefined ? {} : {cursor: nextCursor})}, signer)}),
      orderInput: async () => ({status: 200, body: {customerRef, customerVersion: "1", displayName: "Test Customer", state: "Active"}}),
      replay: async () => ({kind: "not_retained"}),
    },
  }));

  const first = await app.inject({method: "GET", url: `/api/client-v1/customers?query=${encodeURIComponent(searchQuery)}&limit=1`, headers: {"x-actor-context": "signed-test"}});
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.items[0].displayName, firstName);
  assert.equal(typeof firstBody.nextCursor, "string");
  assert.ok(firstBody.nextCursor.length > 512);
  assert.ok(firstBody.nextCursor.length <= 2_048);
  const decodedFirstCursor = decodeCustomerCursor(firstBody.nextCursor, normalizeSearchQuery(searchQuery), signer);
  assert.equal(decodedFirstCursor.name, firstName.toLowerCase());
  assert.equal(decodedFirstCursor.customerRef, customerRef);

  const second = await app.inject({method: "GET", url: `/api/client-v1/customers?query=${encodeURIComponent(searchQuery)}&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`, headers: {"x-actor-context": "signed-test"}});
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.items[0].customerRef, secondRef);
  assert.equal(secondBody.nextCursor, null);
});

void test("Customer and api-public decode default/explicit limits and reject duplicate or out-of-range values", async (t) => {
  const customerLimits = [];
  const customerApp = await runtime(t, (value) => registerCustomerRoutes(value, {
    ...customerAdapters({create: 0, replay: 0}),
    owner: {
      ...customerAdapters({create: 0, replay: 0}).owner,
      search: async ({limit}) => { customerLimits.push(limit); return {status: 200, body: {items: [], nextCursor: null}}; },
    },
  }));
  assert.equal((await customerApp.inject({method: "GET", url: "/api/client-v1/customers?query=test", headers: {"x-actor-context": "signed-test"}})).statusCode, 200);
  assert.equal((await customerApp.inject({method: "GET", url: "/api/client-v1/customers?query=test&limit=20", headers: {"x-actor-context": "signed-test"}})).statusCode, 200);
  assert.deepEqual(customerLimits, [20, 20]);
  assertProblem(await customerApp.inject({method: "GET", url: "/api/client-v1/customers?query=test&limit=20&limit=21", headers: {"x-actor-context": "signed-test"}}), 400, "VALIDATION_FAILED");
  assertProblem(await customerApp.inject({method: "GET", url: "/api/client-v1/customers?query=test&limit=51", headers: {"x-actor-context": "signed-test"}}), 400, "VALIDATION_FAILED");
  assertProblem(await customerApp.inject({method: "GET", url: `/api/client-v1/customers?query=test&cursor=${"a".repeat(8 * 1024)}`, headers: {"x-actor-context": "signed-test"}}), 400, "VALIDATION_FAILED");

  const forwarded = [];
  const client = createHttpCustomerClient({
    fetch: async (path) => {
      forwarded.push(path);
      return new Response(JSON.stringify({items: [], nextCursor: null}), {status: 200, headers: {"content-type": "application/json"}});
    },
  }, () => "signed-owner-context");
  const publicApp = await runtime(t, (value) => registerPublicRoutes(value, {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => publicClaims(operationId),
    customer: client,
  }));
  assert.equal((await publicApp.inject({method: "GET", url: "/api/client-v1/customers?query=test", headers: {"x-actor-context": "signed-edge-context"}})).statusCode, 200);
  assert.equal((await publicApp.inject({method: "GET", url: "/api/client-v1/customers?query=test&limit=20", headers: {"x-actor-context": "signed-edge-context"}})).statusCode, 200);
  assert.deepEqual(forwarded, ["/api/client-v1/customers?query=test&limit=20", "/api/client-v1/customers?query=test&limit=20"]);
  assertProblem(await publicApp.inject({method: "GET", url: "/api/client-v1/customers?query=test&limit=20&limit=21", headers: {"x-actor-context": "signed-edge-context"}}), 400, "VALIDATION_FAILED");
  assertProblem(await publicApp.inject({method: "GET", url: `/api/client-v1/customers?query=test&cursor=${"a".repeat(8 * 1024)}`, headers: {"x-actor-context": "signed-edge-context"}}), 400, "VALIDATION_FAILED");
});

void test("Customer and api-public map JSON parser and body-limit failures to Problem Details", async (t) => {
  const headers = {"x-actor-context": "signed-test", "idempotency-key": randomUUID(), "content-type": "application/json"};
  const customerApp = await runtime(t, (value) => registerCustomerRoutes(value, customerAdapters({create: 0, replay: 0})));
  assertProblem(await customerApp.inject({method: "POST", url: "/api/client-v1/customers", headers, payload: "{bad"}), 400, "VALIDATION_FAILED");
  assertProblem(await customerApp.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-key": randomUUID()}, payload: JSON.stringify({displayName: "Test", phone: "+79991234567", padding: "x".repeat(17_000)})}), 400, "VALIDATION_FAILED");

  const publicApp = await runtime(t, (value) => registerPublicRoutes(value, {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => publicClaims(operationId),
    customer: {
      create: async () => ({status: 201, body: response()}),
      search: async () => ({status: 200, body: {items: [], nextCursor: null}}),
    },
  }));
  assertProblem(await publicApp.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-key": randomUUID()}, payload: "{bad"}), 400, "VALIDATION_FAILED");
  assertProblem(await publicApp.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-key": randomUUID()}, payload: JSON.stringify({displayName: "Test", phone: "+79991234567", padding: "x".repeat(17_000)})}), 400, "VALIDATION_FAILED");
});

void test("Customer owner adapter forwards the Store replay marker only on the second command", async (t) => {
  const completed = new Set();
  const store = {
    create: async (command) => {
      const replayed = completed.has(command.idempotencyKey);
      completed.add(command.idempotencyKey);
      return {status: 201, body: response(), replayed};
    },
    search: async () => [],
    getOrderInput: async () => null,
    replay: async () => ({kind: "not_retained"}),
  };
  const app = await runtime(t, (value) => registerCustomerRoutes(value, {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId) => claims(operationId),
    verifyInternalDelegation: () => ({...claims("getCustomerOrderInput"), iss: "api-internal", aud: "customer-service", originalCaller: "orders-service"}),
    owner: createCustomerOwner(store),
  }));
  const headers = {"x-actor-context": "signed-test", "idempotency-key": randomUUID()};
  const first = await app.inject({method: "POST", url: "/api/client-v1/customers", headers, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(first.statusCode, 201);
  assert.equal(first.headers["idempotency-replayed"], undefined);
  const second = await app.inject({method: "POST", url: "/api/client-v1/customers", headers, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(second.statusCode, 201);
  assert.equal(second.headers["idempotency-replayed"], "true");
});

void test("Customer normal command requires a body, while bodyless replay is authorized and recovered", async (t) => {
  const calls = {create: 0, replay: 0};
  const app = await runtime(t, (value) => registerCustomerRoutes(value, customerAdapters(calls)));
  const headers = {"x-actor-context": "signed-test", "idempotency-key": randomUUID()};

  const missingBody = await app.inject({method: "POST", url: "/api/client-v1/customers", headers});
  assert.equal(missingBody.statusCode, 400);
  assert.equal(missingBody.json().code, "VALIDATION_FAILED");
  assert.equal(calls.create, 0);

  const replay = await app.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-replay-only": "true"}});
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(calls.replay, 1);
});

void test("Customer rejects revoked permission before owner calls and does not expose owner canaries", async (t) => {
  const calls = {create: 0, replay: 0};
  const app = await runtime(t, (value) => registerCustomerRoutes(value, customerAdapters(calls, [])));
  const denied = await app.inject({method: "POST", url: "/api/client-v1/customers", headers: {"x-actor-context": "signed-test", "idempotency-key": randomUUID()}, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.create, 0);
  assert.equal(calls.replay, 0);

  const canaryApp = await runtime(t, (value) => registerCustomerRoutes(value, customerAdapters({create: 0, replay: 0}, ["customer:create"], async () => {
    const error = new Error("secret-canary");
    error.code = "DB_QUERY_FAILED";
    throw error;
  })));
  const failed = await canaryApp.inject({method: "POST", url: "/api/client-v1/customers", headers: {"x-actor-context": "signed-test", "idempotency-key": randomUUID()}, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "CUSTOMER_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.json()).includes("secret-canary"), false);
});

void test("api-public applies the same body, permission and error rules before forwarding", async (t) => {
  const calls = {create: 0};
  const app = await runtime(t, (value) => registerPublicRoutes(value, {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => publicClaims(operationId),
    customer: {
      create: async () => { calls.create += 1; return {status: 201, body: response(), replayed: true}; },
      search: async () => ({status: 200, body: {items: [], nextCursor: null}}),
    },
  }));
  const headers = {"x-actor-context": "signed-test", "idempotency-key": randomUUID()};
  const missingBody = await app.inject({method: "POST", url: "/api/client-v1/customers", headers});
  assert.equal(missingBody.statusCode, 400);
  assert.equal(calls.create, 0);

  const replay = await app.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-replay-only": "true"}});
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(calls.create, 1);

  const denied = await runtime(t, (value) => registerPublicRoutes(value, {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => publicClaims(operationId, []),
    customer: {
      create: async () => { throw new Error("secret-canary"); },
      search: async () => ({status: 200, body: {items: [], nextCursor: null}}),
    },
  }));
  const deniedResponse = await denied.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-key": randomUUID()}, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(JSON.stringify(deniedResponse.json()).includes("secret-canary"), false);

  const failedApp = await runtime(t, (value) => registerPublicRoutes(value, {
    verifyTransport: () => true,
    verifyActor: (_token, operationId) => publicClaims(operationId),
    customer: {
      create: async () => { throw new Error("secret-canary"); },
      search: async () => ({status: 200, body: {items: [], nextCursor: null}}),
    },
  }));
  const failed = await failedApp.inject({method: "POST", url: "/api/client-v1/customers", headers: {...headers, "idempotency-key": randomUUID()}, payload: {displayName: "Test", phone: "+79991234567"}});
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "CUSTOMER_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.json()).includes("secret-canary"), false);
});
