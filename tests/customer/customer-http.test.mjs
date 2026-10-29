import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { loadPlatformConfig } from "../../packages/platform-config/dist/index.js";
import { isCustomerProblem } from "../../packages/contracts/customer-v1/dist/index.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  signActorContext,
  verifyActorContextWithKeySet,
  verifyServiceDelegationWithKeySet,
} from "../../packages/platform-security/dist/index.js";
import {
  createEd25519CustomerCursorSigner,
  decodeCustomerCursor,
  encodeCustomerCursor,
  searchCustomers,
} from "../../apps/customer-service/dist/application/search-customers.js";
import {
  normalizeCustomerCreate,
  normalizeSearchQuery,
} from "../../apps/customer-service/dist/domain/customer.js";
import {
  createCustomerOwner,
  createUnavailableCustomerAdapters,
  registerCustomerRoutes,
} from "../../apps/customer-service/dist/http/index.js";
import {
  createConfiguredPublicAdapters,
  createHttpCustomerClient,
  registerPublicRoutes,
} from "../../apps/api-public/dist/index.js";
import {
  createConfiguredInternalAdapters,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";

const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const timestamp = "2026-09-05T00:00:00Z";

function response() {
  return {
    customerRef,
    version: "1",
    displayName: "Test Customer",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function claims(
  operationId,
  permissions = ["customer:create", "customer:read"],
) {
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
  const app = await createRuntime({
    name: "customer-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  register(app);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function customerAdapters(
  calls,
  permissions = ["customer:create", "customer:read"],
  create = async () => ({ status: 201, body: response() }),
) {
  return {
    verifyTransport: () => true,
    verifyPublicDelegation: (_token, operationId) =>
      claims(operationId, permissions),
    verifyInternalDelegation: () => ({
      ...claims("getCustomerOrderInput", []),
      iss: "api-internal",
      aud: "customer-service",
      originalCaller: "orders-service",
    }),
    owner: {
      create: async (input) => {
        calls.create += 1;
        return create(input);
      },
      search: async () => ({
        status: 200,
        body: { items: [], nextCursor: null },
      }),
      orderInput: async () => ({
        status: 200,
        body: {
          customerRef,
          customerVersion: "1",
          displayName: "Test Customer",
          state: "Active",
        },
      }),
      replay: async () => {
        calls.replay += 1;
        return {
          kind: "completed",
          response: { status: 201, body: response() },
        };
      },
    },
  };
}

function publicClaims(
  operationId,
  permissions = ["customer:create", "customer:read"],
) {
  return {
    ...claims(operationId, permissions),
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
  };
}

void test("api-public requires edge-nginx transport identity for browser ingress", async (t) => {
  const calls = { create: 0, transportCaller: undefined };
  const app = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      expectedIngressCaller: "edge-nginx",
      verifyTransport: (_request, caller) => {
        calls.transportCaller = caller;
        return caller === "edge-nginx";
      },
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: {
        create: async () => {
          calls.create += 1;
          return { status: 201, body: response() };
        },
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
      catalog: {
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
    }),
  );
  const result = await app.inject({
    method: "GET",
    url: "/api/client-v1/customers?query=test",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(calls.transportCaller, "edge-nginx");
  assert.equal(result.statusCode, 200);
  assert.equal(calls.create, 0);
});

void test("api-public defaults to sole nginx ingress and rejects legacy transport", async (t) => {
  let expectedCaller;
  const app = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: (_request, caller) => {
        expectedCaller = caller;
        return caller === "edge-gateway";
      },
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: {
        create: async () => ({ status: 201, body: response() }),
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
      catalog: {
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
    }),
  );
  const result = await app.inject({
    method: "GET",
    url: "/api/client-v1/customers?query=test",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(expectedCaller, "edge-nginx");
  assert.equal(result.statusCode, 401);
});

void test("configured api-public verifies nginx peer and Edge signature, audience, operation and correlated request", async (t) => {
  const active = generateKeyPairSync("ed25519");
  const previous = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519");
  const publicPem = (pair) =>
    pair.publicKey.export({ type: "spki", format: "pem" });
  const context = {
    config: await loadPlatformConfig(
      fileURLToPath(new URL("../../config/platform.yaml", import.meta.url)),
      parseYaml,
    ),
    secrets: {
      security: {
        apiPublicDelegationSigningPrivateKey: active.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
        actorContextEdgeVerificationPublicKeys: {
          active: publicPem(active),
          previous: publicPem(previous),
        },
      },
    },
  };
  assert.equal(Object.hasOwn(context.config.services, "edge-nginx"), false);
  const ownerRequests = [];
  let returnPrivateOwnerProblem = false;
  let returnInvalidCustomerSearch = false;
  let customerSearchStatus = 200;
  const adapters = createConfiguredPublicAdapters(context, {
    fetch: async (path, options) => {
      ownerRequests.push({ path, options });
      if (returnInvalidCustomerSearch)
        return new Response(
          JSON.stringify({
            items: [{ privateOwnerRecord: "PRIVATE_OWNER_DTO_CANARY" }],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-owner-private-canary": "PRIVATE_OWNER_HEADER_CANARY",
            },
          },
        );
      if (returnPrivateOwnerProblem)
        return new Response(
          JSON.stringify({
            type: "about:blank",
            title: "PRIVATE_OWNER_TITLE_CANARY",
            status: 502,
            code: "PRIVATE_OWNER_CODE_CANARY",
            detail: "PRIVATE_OWNER_DETAIL_CANARY",
            instance: "/internal/customer/private-record",
            correlationId,
            errors: [],
          }),
          {
            status: 502,
            headers: { "content-type": "application/problem+json" },
          },
        );
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: customerSearchStatus,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(adapters.expectedIngressCaller, "edge-nginx");
  assert.equal(
    adapters.verifyTransport(
      { runtimeContext: { transportIdentity: { runtime: "edge-nginx" } } },
      "edge-nginx",
    ),
    true,
  );
  assert.equal(
    adapters.verifyTransport(
      { runtimeContext: { transportIdentity: { runtime: "edge-gateway" } } },
      "edge-nginx",
    ),
    false,
  );
  assert.equal(
    adapters.verifyTransport({ runtimeContext: {} }, "edge-nginx"),
    false,
  );

  const correlationId = randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  const proof = {
    ...publicClaims("searchCatalogProducts", ["catalog:read"]),
    correlationId,
    iat: now,
    exp: now + 45,
    kid: "edge-actor-context-v1",
  };
  const signal = new AbortController().signal;
  const verify = (token, expectedCorrelationId = correlationId) =>
    adapters.verifyActor(
      token,
      "searchCatalogProducts",
      signal,
      expectedCorrelationId,
    );
  assert.equal(
    verify(signActorContext(proof, active.privateKey)).sub,
    proof.sub,
  );
  assert.equal(
    verify(signActorContext(proof, previous.privateKey)).sub,
    proof.sub,
    "previous key is accepted during rotation",
  );
  for (const malformed of [
    signActorContext(proof, other.privateKey),
    signActorContext({ ...proof, iss: "untrusted" }, active.privateKey),
    signActorContext({ ...proof, aud: "other-service" }, active.privateKey),
    signActorContext(
      { ...proof, operationId: "createCustomer" },
      active.privateKey,
    ),
    signActorContext({ ...proof, exp: now + 61 }, active.privateKey),
    signActorContext(
      { ...proof, exp: now - 1, iat: now - 100 },
      active.privateKey,
    ),
  ])
    assert.throws(() => verify(malformed));
  assert.throws(
    () => verify(signActorContext(proof, active.privateKey), randomUUID()),
    "assertion correlation must match the nginx-forwarded request",
  );
  assert.throws(() =>
    verify(`${signActorContext(proof, active.privateKey)}tampered`),
  );
  const app = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      ...adapters,
      // The configured peer check is tested above; injection has no mTLS socket identity.
      verifyTransport: () => true,
    }),
  );
  const route = "/api/client-v1/customers?query=test";
  assertProblem(
    await app.inject({ method: "GET", url: route }),
    401,
    "AUTHENTICATION_REQUIRED",
  );
  assertProblem(
    await app.inject({
      method: "GET",
      url: route,
      headers: { "x-actor-context": "forged" },
    }),
    403,
    "ACTOR_CONTEXT_INVALID",
  );
  const customerProof = signActorContext(
    {
      ...proof,
      operationId: "searchCustomers",
      permissions: ["customer:read"],
    },
    active.privateKey,
  );
  assertProblem(
    await app.inject({
      method: "GET",
      url: route,
      headers: {
        "x-actor-context": customerProof,
        "x-correlation-id": randomUUID(),
      },
    }),
    403,
    "ACTOR_CONTEXT_INVALID",
  );
  assert.equal(
    ownerRequests.length,
    0,
    "caller identity alone or an unmatched signed assertion cannot invoke the owner",
  );
  const response = await app.inject({
    method: "GET",
    url: route,
    headers: {
      "x-actor-context": customerProof,
      "x-correlation-id": correlationId,
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], nextCursor: null });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(ownerRequests.length, 1);
  assert.equal(
    ownerRequests[0].path,
    "/api/client-v1/customers?query=test&limit=20",
  );
  assert.equal(ownerRequests[0].options.method, "GET");
  assert.equal(
    ownerRequests[0].options.headers["x-correlation-id"],
    correlationId,
  );
  assert.equal(ownerRequests[0].options.headers["idempotency-key"], undefined);
  assert.ok(ownerRequests[0].options.signal instanceof AbortSignal);
  const delegated = verifyActorContextWithKeySet(
    ownerRequests[0].options.headers["x-actor-context"],
    {
      publicKeys: [active.publicKey],
      issuer: "api-public",
      audience: "customer-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(delegated.originalIssuer, "edge-gateway");
  assert.equal(delegated.sub, "usr_test");
  assert.equal(delegated.operationId, "searchCustomers");
  assert.equal(delegated.correlationId, correlationId);
  assert.deepEqual(delegated.permissions, ["customer:read"]);

  returnPrivateOwnerProblem = true;
  const failedResponse = await app.inject({
    method: "GET",
    url: route,
    headers: {
      "x-actor-context": customerProof,
      "x-correlation-id": correlationId,
    },
  });
  assertProblem(failedResponse, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(failedResponse.json().detail, "Customer service is unavailable");
  assert.equal(failedResponse.json().instance, "/api/client-v1/customers");
  assert.doesNotMatch(
    failedResponse.body,
    /PRIVATE_OWNER_(?:TITLE|CODE|DETAIL)_CANARY|private-record/u,
  );
  assert.equal(ownerRequests.length, 2);
  assert.equal(
    ownerRequests[1].options.headers["x-correlation-id"],
    correlationId,
  );
  assert.equal(
    verifyActorContextWithKeySet(
      ownerRequests[1].options.headers["x-actor-context"],
      {
        publicKeys: [active.publicKey],
        issuer: "api-public",
        audience: "customer-service",
        nowEpochSeconds: Math.floor(Date.now() / 1_000),
        clockSkewSeconds: 5,
      },
    ).sub,
    "usr_test",
  );

  returnInvalidCustomerSearch = true;
  const invalidSearchResponse = await app.inject({
    method: "GET",
    url: route,
    headers: {
      "x-actor-context": customerProof,
      "x-correlation-id": correlationId,
    },
  });
  assertProblem(invalidSearchResponse, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(invalidSearchResponse.headers["cache-control"], "no-store");
  assert.equal(invalidSearchResponse.json().correlationId, correlationId);
  assert.equal(
    Object.hasOwn(invalidSearchResponse.headers, "x-owner-private-canary"),
    false,
  );
  assert.doesNotMatch(
    invalidSearchResponse.body,
    /PRIVATE_OWNER_(?:DTO|HEADER)_CANARY/u,
  );
  assert.equal(ownerRequests.length, 3);
  assert.equal(
    ownerRequests[2].options.headers["x-correlation-id"],
    correlationId,
  );

  returnPrivateOwnerProblem = false;
  returnInvalidCustomerSearch = false;
  customerSearchStatus = 201;
  const wrongSearchStatusResponse = await app.inject({
    method: "GET",
    url: route,
    headers: {
      "x-actor-context": customerProof,
      "x-correlation-id": correlationId,
    },
  });
  assertProblem(wrongSearchStatusResponse, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(wrongSearchStatusResponse.headers["cache-control"], "no-store");
  assert.equal(wrongSearchStatusResponse.json().correlationId, correlationId);
  assert.equal(ownerRequests.length, 4);
  assert.equal(
    ownerRequests[3].options.headers["x-correlation-id"],
    correlationId,
  );
});

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
  const active = generateKeyPairSync("ed25519");
  const previous = generateKeyPairSync("ed25519");
  let now = 1_000;
  const policy = {
    activeKid: "active",
    previousKid: "previous",
    maxAgeSeconds: 300,
    clockSkewSeconds: 5,
    overlapSeconds: 60,
    previousKeyTrustUntilEpochSeconds: 1_060,
    nowEpochSeconds: () => now,
  };
  const signer = createEd25519CustomerCursorSigner(
    active.privateKey,
    [active.publicKey, previous.publicKey],
    policy,
  );
  const cursor = {
    v: 1,
    queryHash: search.queryHash,
    name: "test customer",
    customerRef,
  };
  const encoded = encodeCustomerCursor(cursor, signer);
  assert.deepEqual(decodeCustomerCursor(encoded, search, signer), cursor);
  const unsigned = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  assert.throws(
    () => decodeCustomerCursor(unsigned, search, signer),
    /cursor is invalid/,
  );
  assert.throws(
    () => decodeCustomerCursor("a".repeat(2_049), search, signer),
    /cursor is invalid/,
  );
  const payload = encoded.slice(0, -86);
  const signature = encoded.slice(-86);
  const forgedPayload = Buffer.from(
    Buffer.from(payload, "base64url")
      .toString("utf8")
      .replace(customerRef, "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    "utf8",
  ).toString("base64url");
  const forged = `${forgedPayload}${signature}`;
  assert.match(forged, /^[A-Za-z0-9_-]+$/u);
  assert.throws(
    () => decodeCustomerCursor(forged, search, signer),
    /cursor is invalid/,
  );

  now = 1_306;
  assert.throws(
    () => decodeCustomerCursor(encoded, search, signer),
    /cursor is invalid/,
  );
  now = 1_000;
  const previousSigner = createEd25519CustomerCursorSigner(
    previous.privateKey,
    [previous.publicKey, active.publicKey],
    { ...policy, activeKid: "previous", previousKid: "active" },
  );
  const previousCursor = encodeCustomerCursor(cursor, previousSigner);
  assert.deepEqual(
    decodeCustomerCursor(previousCursor, search, signer),
    cursor,
  );
  now = 1_060;
  assert.throws(
    () => decodeCustomerCursor(previousCursor, search, signer),
    /cursor is invalid/,
  );
  now = 1_061;
  const latePreviousCursor = encodeCustomerCursor(cursor, previousSigner);
  assert.throws(
    () => decodeCustomerCursor(latePreviousCursor, search, signer),
    /cursor is invalid/,
  );
  now = 1_000;
  const unknownSigner = createEd25519CustomerCursorSigner(
    active.privateKey,
    active.publicKey,
    { ...policy, activeKid: "unknown" },
  );
  assert.throws(
    () =>
      decodeCustomerCursor(
        encodeCustomerCursor(cursor, unknownSigner),
        search,
        signer,
      ),
    /cursor is invalid/,
  );
});

void test("Customer search decodes limits and paginates a Unicode cursor through real Ed25519 HTTP", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = createEd25519CustomerCursorSigner(privateKey, publicKey);
  const searchQuery = "客户";
  const firstName =
    searchQuery +
    Array.from({ length: 198 }, (_, index) =>
      String.fromCodePoint(0x4e00 + ((index * 7919 + 1237) % 20000)),
    ).join("");
  assert.equal(
    normalizeCustomerCreate({ displayName: firstName, phone: "+79991234567" })
      .displayName,
    firstName,
  );
  const secondRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const rows = [
    {
      customerRef,
      version: "1",
      displayName: firstName,
      name: firstName.toLowerCase(),
      phoneE164: "+79991234567",
      emailNormalized: "alice@example.test",
    },
    {
      customerRef: secondRef,
      version: "1",
      displayName: firstName,
      name: firstName.toLowerCase(),
      phoneE164: null,
      emailNormalized: null,
    },
  ];
  const store = {
    search: async (_search, cursor, limit) => {
      const found =
        cursor === null
          ? 0
          : rows.findIndex(
              (row) =>
                row.name > cursor.name ||
                (row.name === cursor.name &&
                  row.customerRef > cursor.customerRef),
            );
      const start = found === -1 ? rows.length : found;
      return rows.slice(start, start + limit);
    },
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, {
      verifyTransport: () => true,
      verifyPublicDelegation: (_token, operationId) => claims(operationId),
      verifyInternalDelegation: () => ({
        ...claims("getCustomerOrderInput"),
        iss: "api-internal",
        aud: "customer-service",
        originalCaller: "orders-service",
      }),
      owner: {
        create: async () => ({ status: 201, body: response() }),
        search: async ({ query, limit, cursor: nextCursor }) => ({
          status: 200,
          body: await searchCustomers(
            store,
            {
              query,
              limit,
              ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
            },
            signer,
          ),
        }),
        orderInput: async () => ({
          status: 200,
          body: {
            customerRef,
            customerVersion: "1",
            displayName: "Test Customer",
            state: "Active",
          },
        }),
        replay: async () => ({ kind: "not_retained" }),
      },
    }),
  );

  const first = await app.inject({
    method: "GET",
    url: `/api/client-v1/customers?query=${encodeURIComponent(searchQuery)}&limit=1`,
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(first.statusCode, 200);
  const firstBody = first.json();
  assert.equal(firstBody.items[0].displayName, firstName);
  assert.equal(firstBody.items[0].phone, "+7******4567");
  assert.equal(firstBody.items[0].email, "a***@example.test");
  assert.equal(JSON.stringify(firstBody).includes("+79991234567"), false);
  assert.equal(JSON.stringify(firstBody).includes("alice@example.test"), false);
  assert.equal(typeof firstBody.nextCursor, "string");
  assert.ok(firstBody.nextCursor.length > 512);
  assert.ok(firstBody.nextCursor.length <= 2_048);
  const decodedFirstCursor = decodeCustomerCursor(
    firstBody.nextCursor,
    normalizeSearchQuery(searchQuery),
    signer,
  );
  assert.equal(decodedFirstCursor.name, firstName.toLowerCase());
  assert.equal(decodedFirstCursor.customerRef, customerRef);

  const second = await app.inject({
    method: "GET",
    url: `/api/client-v1/customers?query=${encodeURIComponent(searchQuery)}&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(second.statusCode, 200);
  const secondBody = second.json();
  assert.equal(secondBody.items[0].customerRef, secondRef);
  assert.equal(Object.hasOwn(secondBody.items[0], "phone"), false);
  assert.equal(Object.hasOwn(secondBody.items[0], "email"), false);
  assert.equal(secondBody.nextCursor, null);
});

void test("Customer and api-public decode default/explicit limits and reject duplicate or out-of-range values", async (t) => {
  const customerLimits = [];
  const customerApp = await runtime(t, (value) =>
    registerCustomerRoutes(value, {
      ...customerAdapters({ create: 0, replay: 0 }),
      owner: {
        ...customerAdapters({ create: 0, replay: 0 }).owner,
        search: async ({ limit }) => {
          customerLimits.push(limit);
          return { status: 200, body: { items: [], nextCursor: null } };
        },
      },
    }),
  );
  assert.equal(
    (
      await customerApp.inject({
        method: "GET",
        url: "/api/client-v1/customers?query=test",
        headers: { "x-actor-context": "signed-test" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await customerApp.inject({
        method: "GET",
        url: "/api/client-v1/customers?query=test&limit=20",
        headers: { "x-actor-context": "signed-test" },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(customerLimits, [20, 20]);
  assertProblem(
    await customerApp.inject({
      method: "GET",
      url: "/api/client-v1/customers?query=test&limit=20&limit=21",
      headers: { "x-actor-context": "signed-test" },
    }),
    400,
    "VALIDATION_FAILED",
  );
  assertProblem(
    await customerApp.inject({
      method: "GET",
      url: "/api/client-v1/customers?query=test&limit=51",
      headers: { "x-actor-context": "signed-test" },
    }),
    400,
    "VALIDATION_FAILED",
  );
  assertProblem(
    await customerApp.inject({
      method: "GET",
      url: `/api/client-v1/customers?query=test&cursor=${"a".repeat(8 * 1024)}`,
      headers: { "x-actor-context": "signed-test" },
    }),
    400,
    "VALIDATION_FAILED",
  );

  for (const cursor of ["invalid!", "a".repeat(2_049)]) {
    assertProblem(
      await customerApp.inject({
        method: "GET",
        url: `/api/client-v1/customers?query=test&cursor=${encodeURIComponent(cursor)}`,
        headers: { "x-actor-context": "signed-test" },
      }),
      400,
      "INVALID_CURSOR",
    );
  }

  const forwarded = [];
  const client = createHttpCustomerClient(
    {
      fetch: async (path) => {
        forwarded.push(path);
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
    () => "signed-owner-context",
  );
  const publicApp = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: client,
    }),
  );
  assert.equal(
    (
      await publicApp.inject({
        method: "GET",
        url: "/api/client-v1/customers?query=test",
        headers: { "x-actor-context": "signed-edge-context" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await publicApp.inject({
        method: "GET",
        url: "/api/client-v1/customers?query=test&limit=20",
        headers: { "x-actor-context": "signed-edge-context" },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(forwarded, [
    "/api/client-v1/customers?query=test&limit=20",
    "/api/client-v1/customers?query=test&limit=20",
  ]);
  assertProblem(
    await publicApp.inject({
      method: "GET",
      url: "/api/client-v1/customers?query=test&limit=20&limit=21",
      headers: { "x-actor-context": "signed-edge-context" },
    }),
    400,
    "VALIDATION_FAILED",
  );
  assertProblem(
    await publicApp.inject({
      method: "GET",
      url: `/api/client-v1/customers?query=test&cursor=${"a".repeat(8 * 1024)}`,
      headers: { "x-actor-context": "signed-edge-context" },
    }),
    400,
    "VALIDATION_FAILED",
  );
  for (const cursor of ["invalid!", "a".repeat(2_049)]) {
    assertProblem(
      await publicApp.inject({
        method: "GET",
        url: `/api/client-v1/customers?query=test&cursor=${encodeURIComponent(cursor)}`,
        headers: { "x-actor-context": "signed-edge-context" },
      }),
      400,
      "INVALID_CURSOR",
    );
  }
});

void test("api-public forwards allowlisted Customer problems and sanitizes malformed owner failures", async (t) => {
  const privateDetail = "private customer index: phone +79990000000";
  const privateInstance = "/internal/customers/private-record-42";
  let malformedOwnerJson = false;
  let ownerHttpStatus;
  let ownerProblem = {
    type: "about:blank",
    title: "CUSTOMER_PHONE_CONFLICT",
    status: 409,
    code: "CUSTOMER_PHONE_CONFLICT",
    detail: privateDetail,
    instance: privateInstance,
    correlationId: randomUUID(),
    errors: [],
  };
  const client = createHttpCustomerClient(
    {
      fetch: async () =>
        malformedOwnerJson
          ? new Response("private upstream JSON canary", {
              status: 503,
              headers: { "content-type": "application/json" },
            })
          : new Response(JSON.stringify(ownerProblem), {
              status: ownerHttpStatus ?? ownerProblem.status,
              headers: { "content-type": "application/problem+json" },
            }),
    },
    () => "signed-owner-context",
  );
  const app = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: client,
    }),
  );
  const request = () =>
    app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: {
        "x-actor-context": "signed-edge-context",
        "idempotency-key": randomUUID(),
      },
      payload: { displayName: "Test", phone: "+79991234567" },
    });

  const mapped = await request();
  assertProblem(mapped, 409, "CUSTOMER_PHONE_CONFLICT");
  assert.equal(mapped.json().detail, "The phone is already registered");
  assert.equal(mapped.json().instance, "/api/client-v1/customers");
  assert.doesNotMatch(mapped.body, /private customer index|private-record-42/u);

  for (const [httpStatus, bodyStatus, code, expectedStatus, expectedCode] of [
    [400, 400, "VALIDATION_FAILED", 400, "VALIDATION_FAILED"],
    [503, 503, "CUSTOMER_UNAVAILABLE", 503, "CUSTOMER_UNAVAILABLE"],
    [503, 400, "VALIDATION_FAILED", 503, "CUSTOMER_UNAVAILABLE"],
    [400, 503, "CUSTOMER_UNAVAILABLE", 503, "CUSTOMER_UNAVAILABLE"],
  ]) {
    ownerHttpStatus = httpStatus;
    ownerProblem = { ...ownerProblem, status: bodyStatus, title: code, code };
    for (const operation of [
      request,
      () =>
        app.inject({
          method: "GET",
          url: "/api/client-v1/customers?query=test",
          headers: { "x-actor-context": "signed-edge-context" },
        }),
    ]) {
      const result = await operation();
      assertProblem(result, expectedStatus, expectedCode);
      assert.doesNotMatch(
        result.body,
        /private customer index|private-record-42/u,
      );
    }
  }
  ownerHttpStatus = undefined;
  ownerProblem = {
    ...ownerProblem,
    title: "INTERNAL_OWNER_FAILURE",
    status: 500,
    code: "INTERNAL_OWNER_FAILURE",
  };
  const fallback = await request();
  assertProblem(fallback, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(fallback.json().detail, "Customer service is unavailable");
  assert.equal(fallback.json().instance, "/api/client-v1/customers");
  assert.doesNotMatch(
    fallback.body,
    /private customer index|private-record-42/u,
  );

  malformedOwnerJson = true;
  const malformed = await request();
  assertProblem(malformed, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(malformed.json().detail, "Customer service is unavailable");
  assert.equal(malformed.json().instance, "/api/client-v1/customers");
  assert.doesNotMatch(malformed.body, /private upstream JSON canary/u);
});

void test("Customer and api-public map JSON parser and body-limit failures to Problem Details", async (t) => {
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
    "content-type": "application/json",
  };
  const customerOwnerCalls = { create: 0, replay: 0 };
  const customerApp = await runtime(t, (value) =>
    registerCustomerRoutes(value, customerAdapters(customerOwnerCalls)),
  );
  assertProblem(
    await customerApp.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers,
      payload: "{bad",
    }),
    400,
    "VALIDATION_FAILED",
  );
  assertProblem(
    await customerApp.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: JSON.stringify({
        displayName: "Test",
        phone: "+79991234567",
        padding: "x".repeat(17_000),
      }),
    }),
    400,
    "VALIDATION_FAILED",
  );

  const publicOwnerCalls = { create: 0, search: 0 };
  const publicApp = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: {
        create: async () => {
          publicOwnerCalls.create += 1;
          return { status: 201, body: response() };
        },
        search: async () => {
          publicOwnerCalls.search += 1;
          return { status: 200, body: { items: [], nextCursor: null } };
        },
      },
    }),
  );
  assertProblem(
    await publicApp.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: "{bad",
    }),
    400,
    "VALIDATION_FAILED",
  );
  const publicEmptyJson = await publicApp.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: "",
  });
  assertProblem(publicEmptyJson, 400, "VALIDATION_FAILED");
  assert.equal(publicEmptyJson.headers["cache-control"], "no-store");
  assert.deepEqual(publicOwnerCalls, { create: 0, search: 0 });
  const customerEmptyJson = await customerApp.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: "",
  });
  assertProblem(customerEmptyJson, 400, "VALIDATION_FAILED");
  assert.equal(customerEmptyJson.headers["cache-control"], "no-store");
  assert.deepEqual(customerOwnerCalls, { create: 0, replay: 0 });
  const unsupportedMimeCanary = "unsupported-mime-input-private-canary";
  const unsupportedMime = await publicApp.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: {
      ...headers,
      "idempotency-key": randomUUID(),
      "content-type": "application/xml",
    },
    payload: JSON.stringify({
      displayName: unsupportedMimeCanary,
      phone: "+79991234567",
    }),
  });
  assertProblem(unsupportedMime, 400, "VALIDATION_FAILED");
  assert.equal(unsupportedMime.headers["cache-control"], "no-store");
  assert.equal(unsupportedMime.body.includes(unsupportedMimeCanary), false);
  assert.deepEqual(publicOwnerCalls, { create: 0, search: 0 });
  assertProblem(
    await publicApp.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: JSON.stringify({
        displayName: "Test",
        phone: "+79991234567",
        padding: "x".repeat(17_000),
      }),
    }),
    400,
    "VALIDATION_FAILED",
  );
});

void test("Customer owner adapter forwards the Store replay marker only on the second command", async (t) => {
  const completed = new Set();
  const store = {
    create: async (command) => {
      const replayed = completed.has(command.idempotencyKey);
      completed.add(command.idempotencyKey);
      return { status: 201, body: response(), replayed };
    },
    search: async () => [],
    getOrderInput: async () => null,
    replay: async () => ({ kind: "not_retained" }),
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, {
      verifyTransport: () => true,
      verifyPublicDelegation: (_token, operationId) => claims(operationId),
      verifyInternalDelegation: () => ({
        ...claims("getCustomerOrderInput"),
        iss: "api-internal",
        aud: "customer-service",
        originalCaller: "orders-service",
      }),
      owner: createCustomerOwner(store),
    }),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
  };
  const first = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers,
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(first.statusCode, 201);
  assert.equal(first.headers["idempotency-replayed"], undefined);
  const second = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers,
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(second.statusCode, 201);
  assert.equal(second.headers["idempotency-replayed"], "true");
});

void test("Customer owner adapter preserves search paging and request context across Store calls", async () => {
  const pair = generateKeyPairSync("ed25519");
  const signer = createEd25519CustomerCursorSigner(
    pair.privateKey,
    pair.publicKey,
  );
  const calls = [];
  const store = {
    create: async () => ({ status: 201, body: response(), replayed: false }),
    search: async (...args) => {
      calls.push(["search", ...args]);
      const rows = [
        {
          customerRef,
          version: "3",
          displayName: "Test Customer",
          name: "test customer",
          phoneE164: "+79991234567",
          emailNormalized: null,
        },
        {
          customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          version: "2",
          displayName: "Test Customer Two",
          name: "test customer two",
          phoneE164: null,
          emailNormalized: "alice@example.test",
        },
      ];
      return args[1] === null ? rows : rows.slice(1);
    },
    getOrderInput: async (...args) => {
      calls.push(["orderInput", ...args]);
      return {
        customerRef,
        customerVersion: "3",
        displayName: "Test Customer",
        state: "Active",
      };
    },
    replay: async (...args) => {
      calls.push(["replay", ...args]);
      return { kind: "not_retained" };
    },
  };
  const owner = createCustomerOwner(store, signer);
  const controller = new AbortController();
  const context = {
    actorRef: "orders-service",
    correlationId: "00000000-0000-4000-8000-000000000040",
    signal: controller.signal,
  };
  const identity = {
    actorRef: "usr_test",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000041",
  };

  const page = await owner.search({
    query: "test customer",
    limit: 1,
    context,
  });
  assert.equal(page.status, 200);
  assert.equal(page.body.items.length, 1);
  assert.equal(page.body.items[0].phone, "+7******4567");
  assert.equal(typeof page.body.nextCursor, "string");
  assert.deepEqual(
    decodeCustomerCursor(
      page.body.nextCursor,
      normalizeSearchQuery("test customer"),
      signer,
    ),
    {
      v: 1,
      queryHash: normalizeSearchQuery("test customer").queryHash,
      name: "test customer",
      customerRef,
    },
  );
  assert.equal(calls[0][0], "search");
  assert.deepEqual(calls[0][1], normalizeSearchQuery("test customer"));
  assert.equal(calls[0][2], null);
  assert.equal(calls[0][3], 2);
  assert.equal(calls[0][4], controller.signal);

  const nextPage = await owner.search({
    query: "test customer",
    limit: 1,
    cursor: page.body.nextCursor,
    context,
  });
  assert.equal(
    nextPage.body.items[0].customerRef,
    "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  );
  assert.equal(nextPage.body.nextCursor, null);
  assert.deepEqual(calls[1][2], {
    v: 1,
    queryHash: normalizeSearchQuery("test customer").queryHash,
    name: "test customer",
    customerRef,
  });
  assert.equal(calls[1][3], 2);
  assert.equal(calls[1][4], controller.signal);

  const orderInput = await owner.orderInput({ customerRef, context });
  assert.equal(orderInput.body.customerVersion, "3");
  assert.deepEqual(calls[2], ["orderInput", customerRef, controller.signal]);
  assert.deepEqual(await owner.replay({ identity, context }), {
    kind: "not_retained",
  });
  assert.equal(calls[3][0], "replay");
  assert.deepEqual(calls[3][1], identity);
  assert.equal(calls[3][2], controller.signal);
  assert.equal(calls[3][3], context.correlationId);
});

void test("Customer unavailable adapters reject every unconfigured trust and owner operation", async () => {
  const adapters = createUnavailableCustomerAdapters();
  const signal = new AbortController().signal;
  const request = { headers: {}, runtimeContext: { signal }, id: "request" };

  assert.equal(adapters.verifyTransport(request, "api-public"), false);
  assert.throws(
    () => adapters.verifyPublicDelegation("token", "createCustomer", signal),
    {
      message: "CUSTOMER_HTTP_SECURITY_NOT_CONFIGURED",
    },
  );
  assert.throws(
    () =>
      adapters.verifyInternalDelegation(
        "token",
        "getCustomerOrderInput",
        signal,
      ),
    {
      message: "CUSTOMER_HTTP_SECURITY_NOT_CONFIGURED",
    },
  );
  await assert.rejects(adapters.owner.create({}), {
    message: "CUSTOMER_HTTP_OWNER_NOT_CONFIGURED",
  });
  await assert.rejects(adapters.owner.search({}), {
    message: "CUSTOMER_HTTP_OWNER_NOT_CONFIGURED",
  });
  await assert.rejects(adapters.owner.orderInput({}), {
    message: "CUSTOMER_HTTP_OWNER_NOT_CONFIGURED",
  });
  await assert.rejects(adapters.owner.replay({}), {
    message: "CUSTOMER_HTTP_OWNER_NOT_CONFIGURED",
  });
});

void test("Customer normal command requires a body, while bodyless replay is authorized and recovered", async (t) => {
  const calls = { create: 0, replay: 0 };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, customerAdapters(calls)),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
  };

  const missingBody = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers,
  });
  assert.equal(missingBody.statusCode, 400);
  assert.equal(missingBody.json().code, "VALIDATION_FAILED");
  assert.equal(calls.create, 0);

  const replay = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-replay-only": "true" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(calls.replay, 1);
});

void test("Customer replay-only requires current create permission before owner lookup", async (t) => {
  const calls = { create: 0, replay: 0 };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, customerAdapters(calls, ["customer:read"])),
  );
  const denied = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: {
      "x-actor-context": "signed-test",
      "idempotency-key": randomUUID(),
      "idempotency-replay-only": "true",
    },
  });

  assertProblem(denied, 403, "ACTOR_CONTEXT_INVALID");
  assert.equal(calls.replay, 0);
  assert.equal(calls.create, 0);
});

void test("Customer replay-only rejects a body or conditional version before owner lookup", async (t) => {
  const calls = { create: 0, replay: 0 };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, customerAdapters(calls)),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
    "idempotency-replay-only": "true",
  };

  for (const request of [
    {
      headers,
      payload: { displayName: "Test", phone: "+79991234567" },
    },
    { headers: { ...headers, "if-match-version": "1" } },
  ]) {
    const rejected = await app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      ...request,
    });
    assertProblem(rejected, 400, "VALIDATION_FAILED");
  }

  assert.equal(calls.replay, 0);
  assert.equal(calls.create, 0);
});

void test("Customer bodyless replay reports terminal lookup outcomes without creating", async (t) => {
  const calls = { create: 0, replay: 0 };
  let replayResult;
  const adapters = customerAdapters(calls);
  adapters.owner.replay = async () => {
    calls.replay += 1;
    if (replayResult instanceof Error) throw replayResult;
    return replayResult;
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, adapters),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
    "idempotency-replay-only": "true",
  };

  for (const [result, status, code] of [
    [{ kind: "in_progress" }, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS"],
    [{ kind: "not_retained" }, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED"],
    [{ kind: "unavailable" }, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
    [{ kind: "invalid" }, 500, "IDEMPOTENCY_RESULT_INVALID"],
    [
      { kind: "completed", response: { status: 201, body: {} } },
      500,
      "IDEMPOTENCY_RESULT_INVALID",
    ],
  ]) {
    replayResult = result;
    const response = await app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
    });
    assertProblem(response, status, code);
    assert.equal(response.headers["cache-control"], "no-store");
  }

  replayResult = Object.assign(new Error("secret-canary"), {
    code: "DB_QUERY_FAILED",
  });
  const failed = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
  });
  assertProblem(failed, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.json()).includes("secret-canary"), false);

  for (const code of [
    "IDEMPOTENCY_RECORD_INVALID",
    "IDEMPOTENCY_NOT_ACQUIRED",
  ]) {
    replayResult = Object.assign(new Error("invalid-record-canary"), { code });
    const invalidRecord = await app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
    });
    assertProblem(invalidRecord, 500, "IDEMPOTENCY_RESULT_INVALID");
    assert.equal(
      JSON.stringify(invalidRecord.json()).includes("invalid-record-canary"),
      false,
    );
  }
  replayResult = Object.assign(new Error("unknown-replay-canary"), {
    code: "UNCLASSIFIED_REPLAY_FAILURE",
  });
  const unknownFailure = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
  });
  assertProblem(unknownFailure, 500, "INTERNAL_ERROR");
  assert.equal(
    JSON.stringify(unknownFailure.json()).includes("unknown-replay-canary"),
    false,
  );
  assert.equal(calls.create, 0);
  assert.equal(calls.replay, 9);
});

void test("Customer maps owner uniqueness conflicts and rejects malformed search rows", async (t) => {
  const calls = { create: 0, replay: 0 };
  let ownerFailure;
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(
      value,
      customerAdapters(calls, undefined, async () => {
        throw ownerFailure;
      }),
    ),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
  };

  for (const code of [
    "CUSTOMER_PHONE_CONFLICT",
    "CUSTOMER_EMAIL_CONFLICT",
    "IDEMPOTENCY_CONFLICT",
  ]) {
    ownerFailure = Object.assign(new Error("owner-secret-canary"), { code });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { displayName: "Test", phone: "+79991234567" },
    });
    assertProblem(conflict, 409, code);
    assert.equal(
      JSON.stringify(conflict.json()).includes("owner-secret-canary"),
      false,
    );
  }
  assert.equal(calls.create, 3);

  const invalidSearch = await runtime(t, (value) =>
    registerCustomerRoutes(value, {
      ...customerAdapters({ create: 0, replay: 0 }),
      owner: {
        ...customerAdapters({ create: 0, replay: 0 }).owner,
        search: async () => ({
          status: 200,
          body: {
            items: [
              {
                customerRef: "invalid-customer-reference",
                displayName: "untrusted-row-canary",
                version: "1",
              },
            ],
            nextCursor: null,
          },
        }),
      },
    }),
  );
  const rejectedRow = await invalidSearch.inject({
    method: "GET",
    url: "/api/client-v1/customers?query=test",
    headers: { "x-actor-context": "signed-test" },
  });
  assertProblem(rejectedRow, 500, "INTERNAL_ERROR");
  assert.equal(rejectedRow.headers["cache-control"], "no-store");
  assert.equal(
    JSON.stringify(rejectedRow.json()).includes("untrusted-row-canary"),
    false,
  );
});

void test("Customer rejects revoked permission before owner calls and does not expose owner canaries", async (t) => {
  const calls = { create: 0, replay: 0 };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, customerAdapters(calls, [])),
  );
  const denied = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: {
      "x-actor-context": "signed-test",
      "idempotency-key": randomUUID(),
    },
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.create, 0);
  assert.equal(calls.replay, 0);

  const canaryApp = await runtime(t, (value) =>
    registerCustomerRoutes(
      value,
      customerAdapters(
        { create: 0, replay: 0 },
        ["customer:create"],
        async () => {
          const error = new Error("secret-canary");
          error.code = "DB_QUERY_FAILED";
          throw error;
        },
      ),
    ),
  );
  const failed = await canaryApp.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: {
      "x-actor-context": "signed-test",
      "idempotency-key": randomUUID(),
    },
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "CUSTOMER_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.json()).includes("secret-canary"), false);
});

void test("Customer accepts only owner problems whose code and status match the public contract", async (t) => {
  const calls = { create: 0, replay: 0 };
  const problemResult = (code, status) => ({
    type: "about:blank",
    title: code,
    status,
    code,
    detail: "untrusted owner detail",
    instance: "/owner/internal-path",
    correlationId: randomUUID(),
    errors: [],
  });
  let ownerResult = {
    status: 409,
    body: problemResult("CUSTOMER_PHONE_CONFLICT", 409),
  };
  const adapters = customerAdapters(calls, undefined, async () => ownerResult);
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, adapters),
  );
  const request = () =>
    app.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: {
        "x-actor-context": "signed-test",
        "idempotency-key": randomUUID(),
      },
      payload: { displayName: "Test", phone: "+79991234567" },
    });

  const matching = await request();
  assertProblem(matching, 409, "CUSTOMER_PHONE_CONFLICT");
  assert.equal(matching.json().detail, "The phone is already registered");
  assert.equal(matching.json().instance, "/api/client-v1/customers");

  ownerResult = {
    status: 409,
    body: problemResult("CUSTOMER_NOT_FOUND", 404),
  };
  const mismatched = await request();
  assertProblem(mismatched, 500, "INTERNAL_ERROR");
  assert.equal(mismatched.json().detail, "An unexpected error occurred");
  assert.equal(
    JSON.stringify(mismatched.json()).includes("owner/internal-path"),
    false,
  );

  ownerResult = {
    status: 201,
    body: { customerRef: "untrusted-owner-response-canary" },
  };
  const malformed = await request();
  assertProblem(malformed, 500, "INTERNAL_ERROR");
  assert.equal(
    JSON.stringify(malformed.json()).includes(
      "untrusted-owner-response-canary",
    ),
    false,
  );
  assert.equal(calls.create, 3);
});

void test("Customer internal order-input reads only a validated customer for orders-service", async (t) => {
  const calls = [];
  const adapters = customerAdapters({ create: 0, replay: 0 });
  const validClaims = {
    ...claims("getCustomerOrderInput", []),
    iss: "api-internal",
    aud: "customer-service",
    originalCaller: "orders-service",
  };
  let internalClaims = validClaims;
  let orderInputResult = {
    status: 200,
    body: {
      customerRef,
      customerVersion: "3",
      displayName: "Test Customer",
      state: "Active",
    },
  };
  adapters.verifyTransport = (_request, expectedCaller) =>
    expectedCaller === "api-internal";
  adapters.verifyInternalDelegation = () => internalClaims;
  adapters.owner.orderInput = async (input) => {
    calls.push(input);
    return orderInputResult;
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, adapters),
  );

  const result = await app.inject({
    method: "GET",
    url: `/api/internal-v1/customers/${customerRef}/order-input`,
    headers: { "x-service-delegation": "signed-service-test" },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.deepEqual(result.json(), {
    customerRef,
    customerVersion: "3",
    displayName: "Test Customer",
    state: "Active",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].customerRef, customerRef);
  assert.equal(calls[0].context.actorRef, "orders-service");
  assert.ok(calls[0].context.signal instanceof AbortSignal);

  const invalidRef = await app.inject({
    method: "GET",
    url: "/api/internal-v1/customers/invalid/order-input",
    headers: { "x-service-delegation": "signed-service-test" },
  });
  assertProblem(invalidRef, 400, "VALIDATION_FAILED");
  assert.equal(calls.length, 1, "invalid references must not reach the owner");

  for (const invalid of [
    { iss: "api-public" },
    { aud: "api-internal" },
    { originalCaller: "customer-service" },
    { operationId: "createCustomer" },
  ]) {
    internalClaims = { ...validClaims, ...invalid };
    const denied = await app.inject({
      method: "GET",
      url: `/api/internal-v1/customers/${customerRef}/order-input`,
      headers: { "x-service-delegation": "signed-service-test" },
    });
    assertProblem(denied, 403, "SERVICE_DELEGATION_INVALID");
    assert.equal(calls.length, 1, "untrusted claims must not reach the owner");
  }

  orderInputResult = {
    status: 404,
    body: {
      type: "about:blank",
      title: "CUSTOMER_NOT_FOUND",
      status: 404,
      code: "CUSTOMER_NOT_FOUND",
      detail: "Customer does not exist",
      instance: "/api/internal-v1/customers/:customerRef/order-input",
      correlationId: "customer-order-input-missing",
      errors: [],
    },
  };
  internalClaims = validClaims;
  const missing = await app.inject({
    method: "GET",
    url: `/api/internal-v1/customers/${customerRef}/order-input`,
    headers: { "x-service-delegation": "signed-service-test" },
  });
  assertProblem(missing, 404, "CUSTOMER_NOT_FOUND");
  assert.equal(missing.json().detail, "Customer does not exist");
  assert.equal(missing.headers["cache-control"], "no-store");
  assert.equal(calls.length, 2);
});

void test("api-internal configured Customer client forwards and validates order-input safely", async (t) => {
  const orders = generateKeyPairSync("ed25519");
  const pricing = generateKeyPairSync("ed25519");
  const apiInternal = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  const context = {
    config: { environment: "development" },
    secrets: {
      security: {
        apiInternalDelegationSigningPrivateKey: pem(
          apiInternal.privateKey,
          "pkcs8",
        ),
        serviceVerificationKeys: {
          "orders-service": {
            active: pem(orders.publicKey, "spki"),
            previous: pem(orders.publicKey, "spki"),
          },
          "pricing-service": {
            active: pem(pricing.publicKey, "spki"),
            previous: pem(pricing.publicKey, "spki"),
          },
        },
      },
    },
  };
  const calls = [];
  let ownerResponse = {
    status: 200,
    body: {
      customerRef,
      customerVersion: "3",
      displayName: "Test Customer",
      state: "Active",
    },
  };
  let abortOwnerCall = false;
  const configured = createConfiguredInternalAdapters(context, {
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (abortOwnerCall)
        throw new DOMException("private customer detail", "AbortError");
      return new Response(JSON.stringify(ownerResponse.body), {
        status: ownerResponse.status,
        headers: {
          "content-type":
            ownerResponse.status === 200
              ? "application/json"
              : "application/problem+json",
        },
      });
    },
  });
  const app = await runtime(t, (value) =>
    registerInternalRoutes(value, {
      ...configured,
      verifyTransport: (_request, caller) => caller === "orders-service",
      verifyCallerDelegation: (_token, _request, operationId) => ({
        iss: "orders-service",
        aud: "api-internal",
        originalCaller: "orders-service",
        operationId,
      }),
    }),
  );
  const orderInputUrl = `/api/internal-v1/customers/${customerRef}/order-input`;
  const requestOwnerInput = () =>
    app.inject({
      method: "GET",
      url: orderInputUrl,
      headers: { "x-service-delegation": "signed-orders" },
    });

  const ok = await requestOwnerInput();
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), ownerResponse.body);
  assert.equal(calls[0].path, orderInputUrl);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.body, undefined);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.headers["content-type"], undefined);
  assert.equal(calls[0].options.headers.accept, undefined);
  assert.equal(typeof calls[0].options.headers["x-correlation-id"], "string");
  const delegation = verifyServiceDelegationWithKeySet(
    calls[0].options.headers["x-service-delegation"],
    {
      publicKeys: [apiInternal.publicKey],
      issuer: "api-internal",
      audience: "customer-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(delegation.originalCaller, "orders-service");
  assert.equal(delegation.operationId, "getCustomerOrderInput");
  assert.equal(
    delegation.correlationId,
    calls[0].options.headers["x-correlation-id"],
  );

  ownerResponse = {
    status: 200,
    body: {
      customerRef,
      customerVersion: "3",
      displayName: "PRIVATE",
      secret: "PRIVATE",
    },
  };
  const malformedDto = await requestOwnerInput();
  assertProblem(malformedDto, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(malformedDto.body.includes("PRIVATE"), false);

  ownerResponse = {
    status: 404,
    body: {
      type: "about:blank",
      title: "CUSTOMER_NOT_FOUND",
      status: 404,
      code: "CUSTOMER_NOT_FOUND",
      detail: "private customer record detail",
      instance: orderInputUrl,
      correlationId: randomUUID(),
      errors: [],
    },
  };
  const typedProblem = await requestOwnerInput();
  assertProblem(typedProblem, 404, "CUSTOMER_NOT_FOUND");
  assert.equal(typedProblem.body.includes("private customer"), false);

  ownerResponse = {
    status: 404,
    body: {
      type: "about:blank",
      title: "CUSTOMER_NOT_FOUND",
      status: 500,
      code: "CUSTOMER_NOT_FOUND",
      detail: "private customer record detail",
      instance: orderInputUrl,
      correlationId: randomUUID(),
      errors: [],
    },
  };
  const malformedProblem = await requestOwnerInput();
  assertProblem(malformedProblem, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(malformedProblem.body.includes("private customer"), false);

  abortOwnerCall = true;
  const aborted = await requestOwnerInput();
  assertProblem(aborted, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(aborted.body.includes("private customer detail"), false);
  assert.equal(calls.length, 5);
});

void test("Customer internal order-input rejects spoofed service identity before owner access", async (t) => {
  const calls = { create: 0, replay: 0, orderInput: 0 };
  const adapters = customerAdapters(calls);
  adapters.owner.orderInput = async () => {
    calls.orderInput += 1;
    return { status: 200, body: { customerRef } };
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, adapters),
  );
  const denied = await app.inject({
    method: "GET",
    url: `/api/internal-v1/customers/${customerRef}/order-input`,
    headers: {
      "x-service-delegation": "signed-service-test",
      "x-service-identity": "orders-service",
    },
  });

  assertProblem(denied, 403, "SERVICE_DELEGATION_INVALID");
  assert.equal(calls.orderInput, 0);
});

void test("Customer routes deny missing transport identity and delegation before owner access", async (t) => {
  const calls = {
    create: 0,
    replay: 0,
    orderInput: 0,
    publicVerify: 0,
    internalVerify: 0,
  };
  let transportAllowed = false;
  const adapters = customerAdapters(calls);
  adapters.verifyTransport = () => transportAllowed;
  adapters.verifyPublicDelegation = () => {
    calls.publicVerify++;
    return claims("createCustomer");
  };
  adapters.verifyInternalDelegation = () => {
    calls.internalVerify++;
    return {
      ...claims("getCustomerOrderInput"),
      iss: "api-internal",
      aud: "customer-service",
      originalCaller: "orders-service",
    };
  };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(value, adapters),
  );
  const requests = [
    {
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { "idempotency-key": randomUUID() },
      payload: { displayName: "Test", phone: "+79991234567" },
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    },
    {
      method: "GET",
      url: "/api/client-v1/customers?query=test",
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    },
    {
      method: "GET",
      url: `/api/internal-v1/customers/${customerRef}/order-input`,
      status: 401,
      code: "SERVICE_AUTHENTICATION_REQUIRED",
    },
  ];
  for (const request of requests) {
    assertProblem(await app.inject(request), request.status, request.code);
  }
  assert.deepEqual(calls, {
    create: 0,
    replay: 0,
    orderInput: 0,
    publicVerify: 0,
    internalVerify: 0,
  });

  transportAllowed = true;
  for (const request of requests) {
    assertProblem(await app.inject(request), request.status, request.code);
  }
  assert.equal(
    calls.publicVerify,
    0,
    "missing public proof must not be verified",
  );
  assert.equal(
    calls.internalVerify,
    0,
    "missing service proof must not be verified",
  );
  assert.equal(calls.create, 0);
  assert.equal(calls.replay, 0);
  assert.equal(calls.orderInput, 0);
});

void test("Customer unknown transaction outcome is unavailable and never leaks owner details", async (t) => {
  const calls = { create: 0, replay: 0 };
  const app = await runtime(t, (value) =>
    registerCustomerRoutes(
      value,
      customerAdapters(calls, undefined, async () => {
        throw Object.assign(new Error("transaction-outcome-secret"), {
          code: "TRANSACTION_OUTCOME_UNKNOWN",
        });
      }),
    ),
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: {
      "x-actor-context": "signed-test",
      "idempotency-key": randomUUID(),
    },
    payload: { displayName: "Test", phone: "+79991234567" },
  });

  assertProblem(response, 503, "CUSTOMER_UNAVAILABLE");
  assert.equal(
    JSON.stringify(response.json()).includes("transaction-outcome-secret"),
    false,
  );
  assert.equal(calls.create, 1);
});

void test("api-public applies the same body, permission and error rules before forwarding", async (t) => {
  const calls = { create: 0 };
  const app = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: {
        create: async () => {
          calls.create += 1;
          return { status: 201, body: response(), replayed: true };
        },
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
    }),
  );
  const headers = {
    "x-actor-context": "signed-test",
    "idempotency-key": randomUUID(),
  };
  const missingBody = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers,
  });
  assert.equal(missingBody.statusCode, 400);
  assert.equal(calls.create, 0);

  const replay = await app.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-replay-only": "true" },
  });
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(calls.create, 1);

  const denied = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId, []),
      customer: {
        create: async () => {
          throw new Error("secret-canary");
        },
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
    }),
  );
  const deniedResponse = await denied.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(
    JSON.stringify(deniedResponse.json()).includes("secret-canary"),
    false,
  );

  const failedApp = await runtime(t, (value) =>
    registerPublicRoutes(value, {
      verifyTransport: () => true,
      verifyActor: (_token, operationId) => publicClaims(operationId),
      customer: {
        create: async () => {
          throw new Error("secret-canary");
        },
        search: async () => ({
          status: 200,
          body: { items: [], nextCursor: null },
        }),
      },
    }),
  );
  const failed = await failedApp.inject({
    method: "POST",
    url: "/api/client-v1/customers",
    headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { displayName: "Test", phone: "+79991234567" },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "CUSTOMER_UNAVAILABLE");
  assert.equal(JSON.stringify(failed.json()).includes("secret-canary"), false);
  const malformedOwnerResponses = [
    {
      name: "wrong success status",
      result: { status: 200, body: response(), replayed: true },
    },
    {
      name: "invalid success DTO",
      result: {
        status: 201,
        body: {
          ...response(),
          privateCanary: "PRIVATE_OWNER_SUCCESS_DTO_CANARY",
        },
        replayed: true,
      },
    },
  ];
  for (const { name, result } of malformedOwnerResponses) {
    const ownerCalls = { create: 0 };
    const malformedOwnerApp = await runtime(t, (value) =>
      registerPublicRoutes(value, {
        verifyTransport: () => true,
        verifyActor: (_token, operationId) => publicClaims(operationId),
        customer: {
          create: async () => {
            ownerCalls.create += 1;
            return result;
          },
          search: async () => ({
            status: 200,
            body: { items: [], nextCursor: null },
          }),
        },
      }),
    );
    const malformed = await malformedOwnerApp.inject({
      method: "POST",
      url: "/api/client-v1/customers",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: { displayName: "Test", phone: "+79991234567" },
    });
    assertProblem(malformed, 503, "CUSTOMER_UNAVAILABLE");
    assert.equal(malformed.headers["cache-control"], "no-store", name);
    assert.equal(malformed.headers["idempotency-replayed"], undefined, name);
    assert.equal(
      JSON.stringify(malformed.json()).includes(
        "PRIVATE_OWNER_SUCCESS_DTO_CANARY",
      ),
      false,
      name,
    );
    assert.equal(ownerCalls.create, 1, name);
  }
});
