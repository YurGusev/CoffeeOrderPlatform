import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import pg from "pg";
import test from "node:test";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { canonicalCatalogJson } from "../../apps/aroma-gateway/dist/application/catalog-export.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  createHttpAromaBindingClient,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";
import { signServiceDelegation } from "../../packages/platform-security/dist/index.js";
import {
  registerAromaBindingRoutes,
  registerAromaCartSnapshotRoute,
} from "../../apps/aroma-gateway/dist/transport/http/index.js";
import { ProviderError } from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import { OfferBindingStore } from "../../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";

const body = {
  offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  supplierRef: "sup_00000000000000000000000001",
  snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FB0",
  sourceIdentityScheme: "hmac-sha256-v1",
  sourceOfferKeyHash:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const response = {
  offerRef: body.offerRef,
  supplierRef: body.supplierRef,
  sourceIdentityScheme: body.sourceIdentityScheme,
  sourceOfferKeyHash: body.sourceOfferKeyHash,
  firstSnapshotRef: body.snapshotRef,
  state: "Bound",
};

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const now = () => Math.floor(Date.now() / 1000);
const token = (overrides = {}) => {
  const iat = now();
  return signServiceDelegation(
    {
      iss: "api-internal",
      aud: "aroma-gateway",
      originalCaller: "catalog-activation-worker",
      operationId: "registerAromaOfferBinding",
      correlationId: "corr",
      traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
      iat,
      exp: iat + 30,
      jti: `jti-${Math.random()}`,
      kid: "test",
      ...overrides,
    },
    privateKey,
  );
};

async function runtime(t, adapters) {
  const app = await createRuntime({
    name: "binding-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
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
    verifyCallerDelegation: () => {
      throw new Error("must not be used");
    },
    signDelegation: ({ originalCaller, operationId }) =>
      `signed:${originalCaller}:${operationId}`,
    customer: {
      orderInput: async () => {
        throw new Error("must not be used");
      },
    },
    binding: {
      register: async (request, _context, delegation) => {
        calls++;
        forwarded = { request, delegation };
        return { status: 200, body: response };
      },
    },
  });
  const success = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/offer-bindings",
    payload: body,
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), response);
  assert.deepEqual(forwarded, {
    request: body,
    delegation: "signed:catalog-activation-worker:registerAromaOfferBinding",
  });
  assert.equal(calls, 1);
  transportCaller = "orders-service";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        payload: body,
      })
    ).statusCode,
    401,
  );
  assert.equal(calls, 1);
  transportCaller = "catalog-activation-worker";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        headers: { "x-service-delegation": "forged" },
        payload: body,
      })
    ).statusCode,
    403,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        payload: { ...body, rawProviderOfferId: "secret" },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 1);
});

void test("binding client bounds and validates the Gateway response", async () => {
  let request;
  const client = createHttpAromaBindingClient({
    fetch: async (path, options) => {
      request = { path, options };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.register(
    body,
    { correlationId: "corr", signal: new AbortController().signal },
    "signed",
  );
  assert.deepEqual(result, { status: 200, body: response });
  assert.equal(request.path, "/api/internal-v1/aroma/offer-bindings");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-service-delegation"], "signed");
  assert.equal(request.options.headers["x-actor-ref"], undefined);
});

void test("Gateway binding verifies signed delegation before store and rejects claim/transport variants", async (t) => {
  let transport = "api-internal";
  let calls = 0;
  const app = await createRuntime({
    name: "gateway-binding-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {
      runtime: transport,
      environment: "test",
      san: `spiffe://test/${transport}`,
    };
  });
  t.mock.method(OfferBindingStore.prototype, "register", async () => {
    calls++;
    return response;
  });
  registerAromaBindingRoutes(
    app,
    {},
    {
      secrets: {
        security: {
          delegationVerificationKeys: {
            "api-internal": { active: publicPem, previous: publicPem },
          },
        },
      },
    },
  );
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const headers = () => ({ "x-service-delegation": token() });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        headers: headers(),
        payload: body,
      })
    ).statusCode,
    200,
  );
  const spoofedActor = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/offer-bindings",
    headers: { ...headers(), "x-actor-ref": "forged-actor" },
    payload: body,
  });
  assert.equal(spoofedActor.statusCode, 401);
  assert.equal(spoofedActor.json().code, "SERVICE_AUTHENTICATION_REQUIRED");
  assert.equal(calls, 1);
  const malformed = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/offer-bindings",
    headers: {
      ...headers(),
      "content-type": "application/json",
      "x-correlation-id": "00000000-0000-4000-8000-000000000031",
    },
    payload: '{"privateCanary":"gateway-body-private-canary',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(
    malformed.headers["content-type"].startsWith("application/problem+json"),
    true,
  );
  assert.equal(malformed.headers["cache-control"], "no-store");
  assert.equal(
    malformed.headers["x-correlation-id"],
    "00000000-0000-4000-8000-000000000031",
  );
  const malformedProblem = malformed.json();
  assert.deepEqual(
    {
      type: malformedProblem.type,
      title: malformedProblem.title,
      status: malformedProblem.status,
      code: malformedProblem.code,
      detail: malformedProblem.detail,
      correlationId: malformedProblem.correlationId,
    },
    {
      type: "about:blank",
      title: "VALIDATION_FAILED",
      status: 400,
      code: "VALIDATION_FAILED",
      detail: "Request validation failed",
      correlationId: "00000000-0000-4000-8000-000000000031",
    },
  );
  assert.doesNotMatch(malformed.body, /gateway-body-private-canary/u);
  assert.equal(calls, 1);

  const overflowCorrelation = "00000000-0000-4000-8000-000000000032";
  const oversizedPayload = JSON.stringify(body) + " ".repeat(64 * 1024);
  assert.ok(Buffer.byteLength(oversizedPayload) > 64 * 1024);
  const overflow = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/offer-bindings",
    headers: {
      ...headers(),
      "content-type": "application/json",
      "x-correlation-id": overflowCorrelation,
    },
    payload: oversizedPayload,
  });
  assert.equal(overflow.statusCode, 400);
  assert.equal(
    overflow.headers["content-type"].startsWith("application/problem+json"),
    true,
  );
  assert.equal(overflow.headers["cache-control"], "no-store");
  assert.equal(overflow.headers["x-correlation-id"], overflowCorrelation);
  const overflowProblem = overflow.json();
  assert.deepEqual(
    {
      type: overflowProblem.type,
      title: overflowProblem.title,
      status: overflowProblem.status,
      code: overflowProblem.code,
      detail: overflowProblem.detail,
      correlationId: overflowProblem.correlationId,
    },
    {
      type: "about:blank",
      title: "VALIDATION_FAILED",
      status: 400,
      code: "VALIDATION_FAILED",
      detail: "Request validation failed",
      correlationId: overflowCorrelation,
    },
  );
  assert.doesNotMatch(overflow.body, /gateway-body-private-canary/u);
  assert.equal(calls, 1);
  const empty = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/offer-bindings",
    headers: { ...headers(), "content-type": "application/json" },
    payload: "",
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(
    empty.headers["content-type"].startsWith("application/problem+json"),
    true,
  );
  assert.equal(empty.json().code, "VALIDATION_FAILED");
  assert.equal(calls, 1);
  for (const claims of [
    { aud: "wrong-audience" },
    { operationId: "wrongOperation" },
    { originalCaller: "orders-service" },
    { exp: now() - 30, iat: now() - 60 },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/internal-v1/aroma/offer-bindings",
          headers: { "x-service-delegation": token(claims) },
          payload: body,
        })
      ).statusCode,
      403,
    );
  }
  const tampered = `${token().slice(0, -2)}xx`;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        headers: { "x-service-delegation": tampered },
        payload: body,
      })
    ).statusCode,
    403,
  );
  transport = "orders-service";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/offer-bindings",
        headers: headers(),
        payload: body,
      })
    ).statusCode,
    401,
  );
  assert.equal(calls, 1);
});

void test("Gateway cart snapshot route verifies delegation, returns only the contract DTO, and sanitizes provider failures", async (t) => {
  let transport = "api-internal";
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef:
      "aroma-gateway:cart-body-sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capturedAt: "2026-09-12T16:20:00Z",
    cartFingerprint:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    lines: [{ offerRef: body.offerRef, quantity: "1" }],
  };
  let failure = false;
  const app = await createRuntime({
    name: "gateway-cart-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000, cartMs: 5_000 },
  });
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {
      runtime: transport,
      environment: "test",
      san: `spiffe://test/${transport}`,
    };
  });
  registerAromaCartSnapshotRoute(
    app,
    {
      read: async () => {
        if (failure) throw new ProviderError("ProviderReadIncomplete", true);
        return snapshot;
      },
    },
    {
      secrets: {
        security: {
          delegationVerificationKeys: {
            "api-internal": { active: publicPem, previous: publicPem },
          },
        },
      },
    },
  );
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const cartToken = (overrides = {}) => {
    const iat = now();
    return signServiceDelegation(
      {
        iss: "api-internal",
        aud: "aroma-gateway",
        originalCaller: "aroma-observer",
        operationId: "readAromaCartSnapshot",
        correlationId: "corr",
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + 30,
        jti: `jti-cart-${Math.random()}`,
        kid: "test",
        ...overrides,
      },
      privateKey,
    );
  };
  const headers = () => ({ "x-service-delegation": cartToken() });
  const success = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/cart-snapshots:read",
    headers: headers(),
    payload: { cartScopeRef: "aroma-primary" },
  });
  assert.equal(success.statusCode, 200);
  assert.deepEqual(success.json(), snapshot);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        headers: headers(),
        payload: {},
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        headers: {
          "x-service-delegation": cartToken({
            originalCaller: "aroma-convergence",
          }),
        },
        payload: { cartScopeRef: "aroma-primary" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        headers: {
          "x-service-delegation": cartToken({
            originalCaller: "orders-service",
          }),
        },
        payload: { cartScopeRef: "aroma-primary" },
      })
    ).statusCode,
    403,
  );
  failure = true;
  const failed = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/cart-snapshots:read",
    headers: headers(),
    payload: { cartScopeRef: "aroma-primary" },
  });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "AROMA_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(failed.body, /ProviderReadIncomplete/u);
  transport = "aroma-observer";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        headers: headers(),
        payload: { cartScopeRef: "aroma-primary" },
      })
    ).statusCode,
    401,
  );
});

void test("binding store rejects corrupt mappings and unproven export recovery", async (t) => {
  const binding = {
    offer_ref: body.offerRef,
    supplier_ref: body.supplierRef,
    source_identity_scheme: body.sourceIdentityScheme,
    source_offer_key_hash: body.sourceOfferKeyHash,
    first_snapshot_ref: body.snapshotRef,
    state: "Bound",
  };
  const provider = {
    ...binding,
    raw_provider_offer_id: "provider-offer",
    raw_provider_product_id: "provider-product",
    raw_provider_variant_id: "provider-variant",
    provider_packing: "",
    provider_grind_id: null,
  };
  const identity = { offerId: "provider-offer", packing: null, grindId: null };
  const queryLog = [];
  let matches = [];
  let membership = {
    source_exists: true,
    snapshot_state: "Completed",
    member: true,
  };
  let exportRow;
  let batchRow;
  let batchOffers = [];
  let sourceRow;
  let lostCommit;
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    const values = typeof query === "string" ? [] : query.values;
    queryLog.push({ sql, values });
    if (sql === "COMMIT" && lostCommit !== undefined) {
      exportRow = lostCommit.row;
      if (lostCommit.batchOffers !== undefined)
        batchOffers = lostCommit.batchOffers;
      lostCommit = undefined;
      return { rows: [], rowCount: 0, command: "UNKNOWN" };
    }
    if (sql.includes("AS source_exists"))
      return { rows: [membership], rowCount: 1 };
    if (
      sql.includes(
        "FROM integration.provider_export_batches WHERE snapshot_ref",
      ) &&
      sql.includes("batch_number = $2")
    )
      return {
        rows: batchRow === undefined ? [] : [batchRow],
        rowCount: Number(batchRow !== undefined),
      };
    if (
      sql.includes(
        "FROM integration.provider_export_batch_offers WHERE snapshot_ref",
      ) &&
      sql.includes("ORDER BY ordinal")
    )
      return { rows: batchOffers, rowCount: batchOffers.length };
    if (
      sql.includes("FROM integration.provider_source_offers WHERE supplier_ref")
    )
      return {
        rows: sourceRow === undefined ? [] : [sourceRow],
        rowCount: Number(sourceRow !== undefined),
      };
    if (
      sql.includes(
        "FROM integration.provider_catalog_exports WHERE snapshot_ref",
      )
    )
      return {
        rows: exportRow === undefined ? [] : [exportRow],
        rowCount: Number(exportRow !== undefined),
      };
    if (
      (sql.includes("integration.provider_offer_bindings") &&
        sql.startsWith("SELECT")) ||
      sql.startsWith("WITH requested")
    )
      return { rows: matches, rowCount: matches.length };
    return { rows: [], rowCount: 0, command: sql.split(" ")[0] };
  };
  connection.release = () => {};
  t.mock.method(pg.Pool.prototype, "connect", async () => connection);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const database = createDatabase({
    owner: "binding-unit",
    database: "owner",
    allowedDatabase: "owner",
    host: "localhost",
    port: 5432,
    user: "owner",
    password: "test-only",
    ssl: false,
    pool: {
      max: 2,
      checkoutTimeoutMs: 50,
      lockTimeoutMs: 40,
      interactiveStatementTimeoutMs: 100,
      backgroundStatementTimeoutMs: 200,
      terminalTimeoutMs: 40,
      transactionTimeoutMs: 300,
      idleTimeoutMs: 1000,
      maxLifetimeMs: 1000,
    },
    shutdownGraceMs: 1000,
  });
  t.after(() => database.resource.destroy());
  const store = new OfferBindingStore(database);
  assert.equal(
    await store.resolve(body.supplierRef, body.sourceOfferKeyHash),
    undefined,
  );
  matches = [binding];
  assert.deepEqual(
    await store.resolve(body.supplierRef, body.sourceOfferKeyHash),
    response,
  );
  for (const invalid of [
    { offer_ref: null },
    { supplier_ref: 7 },
    { source_identity_scheme: "wrong" },
    { source_offer_key_hash: null },
    { first_snapshot_ref: null },
    { state: "Stopped" },
  ]) {
    matches = [{ ...binding, ...invalid }];
    await assert.rejects(
      store.resolve(body.supplierRef, body.sourceOfferKeyHash),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  }
  matches = [];
  assert.equal(
    await store.resolveProviderOffer(body.offerRef, body.supplierRef),
    undefined,
  );
  matches = [provider];
  const resolved = await store.resolveProviderOffer(
    body.offerRef,
    body.supplierRef,
  );
  assert.equal(resolved.packing, null);
  assert.equal("grindId" in resolved, false);
  for (const invalid of [
    { offer_ref: null },
    { supplier_ref: null },
    { source_offer_key_hash: null },
    { raw_provider_offer_id: null },
    { raw_provider_product_id: null },
    { raw_provider_variant_id: null },
    { provider_packing: 1 },
    { provider_grind_id: 1 },
  ]) {
    matches = [{ ...provider, ...invalid }];
    await assert.rejects(
      store.resolveProviderOffer(body.offerRef, body.supplierRef),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  }
  matches = [provider, provider];
  await assert.rejects(
    store.resolveProviderOffer(body.offerRef, body.supplierRef),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  for (const invalid of ["", "id\0private"])
    await assert.rejects(
      store.resolveByRawProviderOfferId(invalid, body.supplierRef),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  matches = [binding, binding];
  await assert.rejects(
    store.resolveByRawProviderOfferId("provider-offer", body.supplierRef),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  await assert.rejects(
    store.resolveByProviderIdentity(identity, body.supplierRef),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  matches = [];
  assert.equal(
    await store.resolveByProviderIdentity(identity, body.supplierRef),
    undefined,
  );
  matches = [binding];
  assert.deepEqual(
    (await store.resolveByProviderIdentity(identity, body.supplierRef))
      .providerIdentity,
    identity,
  );

  const identities = [
    identity,
    { offerId: "missing", packing: "pack", grindId: null },
  ];
  matches = [{ ...binding, ordinal: 0 }];
  const bulk = await store.resolveByProviderIdentities(
    identities,
    body.supplierRef,
  );
  assert.deepEqual(bulk[0].providerIdentity, identity);
  assert.equal(bulk[1], undefined);
  const bulkQuery = queryLog.findLast(({ sql }) =>
    sql.startsWith("WITH requested"),
  );
  assert.deepEqual(JSON.parse(bulkQuery.values[2]), [
    { offer_id: "provider-offer", packing: "", grind_id: "" },
    { offer_id: "missing", packing: "pack", grind_id: "" },
  ]);
  for (const rows of [
    [{ ...binding, ordinal: -1 }],
    [{ ...binding, ordinal: 2 }],
    [
      { ...binding, ordinal: 0 },
      { ...binding, ordinal: 0 },
    ],
    [{ ...binding, ordinal: "not-a-number" }],
  ]) {
    matches = rows;
    await assert.rejects(
      store.resolveByProviderIdentities(identities, body.supplierRef),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  }
  await assert.rejects(
    store.resolveByProviderIdentities(
      Array(10001).fill(identity),
      body.supplierRef,
    ),
    { code: "AROMA_BINDING_CONFLICT" },
  );

  for (const [candidate, code] of [
    [
      { source_exists: false, snapshot_state: "Completed", member: true },
      "AROMA_BINDING_SOURCE_NOT_FOUND",
    ],
    [
      { source_exists: true, snapshot_state: "Exporting", member: true },
      "AROMA_BINDING_SNAPSHOT_INCOMPLETE",
    ],
    [
      { source_exists: true, snapshot_state: "Completed", member: false },
      "AROMA_BINDING_SNAPSHOT_INCOMPLETE",
    ],
  ]) {
    membership = candidate;
    const before = queryLog.length;
    await assert.rejects(store.register(body), { code });
    assert.equal(
      queryLog
        .slice(before)
        .some(({ sql }) =>
          sql.startsWith("INSERT INTO integration.provider_offer_bindings"),
        ),
      false,
    );
  }

  const sourceIdentity = {
    supplierRef: body.supplierRef,
    sourceIdentityScheme: body.sourceIdentityScheme,
    sourceOfferKeyHash: body.sourceOfferKeyHash,
    sourceProductKeyHash: "b".repeat(64),
    sourceVariantKeyHash: "c".repeat(64),
    rawProviderOfferId: "provider-offer",
    rawProviderProductId: "provider-product",
    rawProviderVariantId: "provider-variant",
    packing: null,
    grindId: "fine",
  };
  const items = [
    {
      sourceOfferKeyHash: sourceIdentity.sourceOfferKeyHash,
      sourceProductKeyHash: sourceIdentity.sourceProductKeyHash,
      sourceVariantKeyHash: sourceIdentity.sourceVariantKeyHash,
    },
  ];
  const itemBytes = Buffer.from(canonicalCatalogJson(items));
  const batchHash = createHash("sha256").update(itemBytes).digest("hex");
  const batch = {
    streamVersion: "1",
    recordType: "snapshot-batch",
    snapshotRef: body.snapshotRef,
    batchNumber: 0,
    offerCount: 1,
    uncompressedBytes: itemBytes.length,
    batchHash,
    previousBatchHash: null,
    items,
  };
  exportRow = {
    supplier_ref: body.supplierRef,
    source_identity_scheme: body.sourceIdentityScheme,
    state: "Exporting",
    next_batch_number: 1,
    last_batch_hash: batchHash,
  };
  batchRow = {
    batch_number: 0,
    offer_count: 1,
    uncompressed_bytes: itemBytes.length,
    batch_hash: batchHash,
    previous_batch_hash: null,
  };
  batchOffers = [
    { ordinal: 0, source_offer_key_hash: sourceIdentity.sourceOfferKeyHash },
  ];
  sourceRow = {
    supplier_ref: sourceIdentity.supplierRef,
    source_identity_scheme: sourceIdentity.sourceIdentityScheme,
    source_offer_key_hash: sourceIdentity.sourceOfferKeyHash,
    source_product_key_hash: sourceIdentity.sourceProductKeyHash,
    source_variant_key_hash: sourceIdentity.sourceVariantKeyHash,
    raw_provider_offer_id: sourceIdentity.rawProviderOfferId,
    raw_provider_product_id: sourceIdentity.rawProviderProductId,
    raw_provider_variant_id: sourceIdentity.rawProviderVariantId,
    provider_packing: "",
    provider_grind_id: "fine",
  };
  const batchStart = queryLog.length;
  await store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
    sourceIdentity,
  ]);
  assert.equal(
    queryLog
      .slice(batchStart)
      .some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/u.test(sql)),
    false,
  );
  for (const invalid of [
    { ...batch, batchHash: "0".repeat(64) },
    { ...batch, offerCount: 2 },
    { ...batch, uncompressedBytes: 0 },
    { ...batch, snapshotRef: "wrong" },
  ]) {
    await assert.rejects(
      store.recordBatch(body.snapshotRef, body.supplierRef, invalid, [
        sourceIdentity,
      ]),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  }
  for (const changes of [
    { offer_count: 2 },
    { uncompressed_bytes: 0 },
    { batch_hash: "0".repeat(64) },
    { previous_batch_hash: "1".repeat(64) },
  ]) {
    batchRow = {
      batch_number: 0,
      offer_count: 1,
      uncompressed_bytes: itemBytes.length,
      batch_hash: batchHash,
      previous_batch_hash: null,
      ...changes,
    };
    await assert.rejects(
      store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
        sourceIdentity,
      ]),
      { code: "AROMA_BINDING_CONFLICT" },
    );
  }
  batchRow = {
    batch_number: 0,
    offer_count: 1,
    uncompressed_bytes: itemBytes.length,
    batch_hash: batchHash,
    previous_batch_hash: null,
  };
  batchOffers = [
    { ordinal: 1, source_offer_key_hash: sourceIdentity.sourceOfferKeyHash },
  ];
  await assert.rejects(
    store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
      sourceIdentity,
    ]),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  batchOffers = [
    { ordinal: 0, source_offer_key_hash: sourceIdentity.sourceOfferKeyHash },
  ];
  sourceRow = { ...sourceRow, raw_provider_offer_id: "different" };
  await assert.rejects(
    store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
      sourceIdentity,
    ]),
    { code: "AROMA_BINDING_CONFLICT" },
  );
  sourceRow = {
    ...sourceRow,
    raw_provider_offer_id: sourceIdentity.rawProviderOfferId,
  };
  lostCommit = { row: exportRow };
  await store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
    sourceIdentity,
  ]);
  lostCommit = { row: exportRow, batchOffers: [] };
  await assert.rejects(
    store.recordBatch(body.snapshotRef, body.supplierRef, batch, [
      sourceIdentity,
    ]),
    { code: "TRANSACTION_OUTCOME_UNKNOWN" },
  );

  const digest = createHash("sha256").update("completed").digest("hex");
  const summary = {
    snapshotRef: body.snapshotRef,
    supplierRef: body.supplierRef,
    batchCount: 1,
    productCount: 1,
    variantCount: 1,
    offerCount: 1,
    contentHash: digest,
  };
  const complete = {
    snapshot_ref: body.snapshotRef,
    supplier_ref: body.supplierRef,
    source_identity_scheme: body.sourceIdentityScheme,
    state: "Completed",
    content_hash: digest,
    batch_count: 1,
    product_count: 1,
    variant_count: 1,
    offer_count: 1,
  };
  exportRow = complete;
  lostCommit = { row: complete };
  await store.completeExport(summary);
  exportRow = complete;
  lostCommit = { row: { ...complete, offer_count: 2 } };
  await assert.rejects(store.completeExport(summary), {
    code: "TRANSACTION_OUTCOME_UNKNOWN",
  });
  exportRow = complete;
  lostCommit = { row: { ...complete, offer_count: "bad" } };
  await assert.rejects(store.completeExport(summary), {
    code: "TRANSACTION_OUTCOME_UNKNOWN",
  });
});
