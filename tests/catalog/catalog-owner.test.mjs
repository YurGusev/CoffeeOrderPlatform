import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import {
  createCatalogCursorSigner,
  searchCatalog,
} from "../../apps/catalog-service/dist/application/search-catalog.js";

const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function row(overrides = {}) {
  return {
    snapshotRevision: "17",
    productRef,
    variantRef,
    displayName: "Coffee Arabica",
    displayNameSortKey: "coffee arabica",
    unit: "gram",
    availability: "Available",
    mappingAvailable: true,
    imageUrl: null,
    offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    supplierUnitMinor: "1200",
    currency: "RUB",
    mappingRevision: "2",
    ...overrides,
  };
}

async function runtime(t, register) {
  const app = await createRuntime({
    name: "catalog-owner-test",
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

function claims(operationId) {
  return {
    iss: "api-public",
    aud: "catalog-service",
    originalIssuer: "edge-gateway",
    sub: "usr_test",
    permissions: ["catalog:read"],
    operationId,
    correlationId: "correlation-test",
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
    iat: 1_000,
    exp: 2_000,
    jti: "jti-test",
    kid: "test",
  };
}

function adapters(owner, counters = { verify: 0 }, overrides = {}) {
  return {
    verifyTransport:
      overrides.verifyTransport ??
      ((_request, expected) =>
        expected === "api-public" || expected === "api-internal"),
    verifyPublicDelegation:
      overrides.verifyPublicDelegation ??
      ((_token, operationId) => {
        counters.verify += 1;
        return claims(operationId);
      }),
    verifyInternalDelegation:
      overrides.verifyInternalDelegation ??
      ((_token, operationId) => ({
        iss: "api-internal",
        aud: "catalog-service",
        originalCaller: "pricing-service",
        operationId,
        correlationId: "correlation-test",
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat: 1_000,
        exp: 2_000,
        jti: "jti-test",
        kid: "test",
      })),
    ...(overrides.snapshotProofMaxAgeMs === undefined
      ? {}
      : { snapshotProofMaxAgeMs: overrides.snapshotProofMaxAgeMs }),
    owner,
  };
}

void test("catalog search normalizes query and binds signed keyset cursor to revision and filters", async () => {
  const active = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(
    active.privateKey,
    active.publicKey,
    { nowEpochSeconds: () => 1_000 },
  );
  const rows = [
    row(),
    row({
      productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      displayName: "Coffee Robusta",
      displayNameSortKey: "coffee robusta",
    }),
  ];
  const store = {
    search: async (input) => {
      assert.equal(input.query, "coffee");
      const start =
        input.after === null
          ? 0
          : rows.findIndex(
              (item) =>
                createHash("sha256")
                  .update(item.displayNameSortKey)
                  .digest("hex") === input.after.sortKeyHash &&
                item.productRef === input.after.productRef &&
                item.variantRef === input.after.variantRef,
            ) + 1;
      return {
        snapshotRevision: "17",
        cursorValid: input.after === null || start > 0,
        rows: rows.slice(start, start + input.limit),
      };
    },
  };
  const first = await searchCatalog(
    store,
    { query: "  ＣＯＦＦＥＥ ", availability: "Available", limit: 1 },
    signer,
  );
  assert.equal(first.snapshotRevision, "17");
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].displayName, "Coffee Arabica");
  assert.equal("offerRef" in first.items[0], false);
  assert.equal("supplierUnitMinor" in first.items[0], false);
  assert.ok(first.nextCursor);
  assert.ok(first.nextCursor.length <= 512);
  const second = await searchCatalog(
    store,
    {
      query: "coffee",
      availability: "Available",
      limit: 1,
      cursor: first.nextCursor,
    },
    signer,
  );
  assert.equal(second.items[0].displayName, "Coffee Robusta");
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    () =>
      searchCatalog(
        {
          search: async () => ({
            snapshotRevision: "17",
            cursorValid: false,
            rows: [],
          }),
        },
        {
          query: "coffee",
          availability: "Available",
          limit: 1,
          cursor: first.nextCursor,
        },
        signer,
      ),
    { code: "INVALID_CURSOR" },
  );
  await assert.rejects(
    () =>
      searchCatalog(
        store,
        {
          query: "coffee",
          availability: "Stopped",
          limit: 1,
          cursor: first.nextCursor,
        },
        signer,
      ),
    { code: "INVALID_CURSOR" },
  );
  const alteredCursor = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("A") ? "B" : "A"}`;
  await assert.rejects(
    () =>
      searchCatalog(
        store,
        {
          query: "coffee",
          availability: "Available",
          limit: 1,
          cursor: alteredCursor,
        },
        signer,
      ),
    { code: "INVALID_CURSOR" },
  );
  const changedRevisionStore = {
    search: async () => ({ snapshotRevision: "18", rows: [] }),
  };
  await assert.rejects(
    () =>
      searchCatalog(
        changedRevisionStore,
        {
          query: "coffee",
          availability: "Available",
          limit: 1,
          cursor: first.nextCursor,
        },
        signer,
      ),
    { code: "INVALID_CURSOR" },
  );
  const expiredSigner = createCatalogCursorSigner(
    active.privateKey,
    active.publicKey,
    { activeKid: "catalog-v1", nowEpochSeconds: () => 100_000 },
  );
  await assert.rejects(
    () =>
      searchCatalog(
        store,
        {
          query: "coffee",
          availability: "Available",
          limit: 1,
          cursor: first.nextCursor,
        },
        expiredSigner,
      ),
    { code: "INVALID_CURSOR" },
  );
});

void test("Catalog exposes only complete persisted grind options and rejects duplicate hashes", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const option = {
    sourceGrindKeyHash: "a".repeat(64),
    displayName: "Средний помол",
  };
  const store = {
    search: async () => ({
      snapshotRevision: "17",
      cursorValid: true,
      rows: [row({ grindOptions: [option] })],
    }),
  };
  const page = await searchCatalog(store, { query: "coffee" }, signer);
  assert.deepEqual(page.items[0].grindOptions, [option]);
  assert.equal("offerRef" in page.items[0], false);
  for (const options of [
    [option, option],
    [{ ...option, displayName: "" }],
    [{ ...option, sourceGrindKeyHash: "raw-id" }],
  ]) {
    await assert.rejects(
      searchCatalog(
        {
          search: async () => ({
            snapshotRevision: "17",
            rows: [row({ grindOptions: options })],
          }),
        },
        { query: "coffee" },
        signer,
      ),
      { code: "CATALOG_UNAVAILABLE" },
    );
  }
});

void test("keyset drains equal display names by product and variant refs without duplicates", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const rows = [
    row(),
    row({ variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAW" }),
    row({
      productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAX",
    }),
  ];
  const store = {
    search: async ({ after, limit }) => {
      const index =
        after === null
          ? 0
          : rows.findIndex(
              (item) =>
                item.productRef === after.productRef &&
                item.variantRef === after.variantRef,
            );
      const cursorValid =
        after === null ||
        (index >= 0 &&
          createHash("sha256")
            .update(rows[index].displayNameSortKey)
            .digest("hex") === after.sortKeyHash);
      return {
        snapshotRevision: "17",
        cursorValid,
        rows: rows.slice(
          after === null ? 0 : index + 1,
          (after === null ? 0 : index + 1) + limit,
        ),
      };
    },
  };
  const seen = [];
  let cursor;
  do {
    const page = await searchCatalog(
      store,
      {
        query: "coffee",
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      },
      signer,
    );
    seen.push(...page.items.map((item) => [item.productRef, item.variantRef]));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  assert.deepEqual(
    seen,
    rows.map((item) => [item.productRef, item.variantRef]),
  );
});

void test("signed Catalog cursor remains within 512 bytes for an incompressible 200-codepoint sort key", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const name = Array.from({ length: 200 }, (_, index) =>
    String.fromCodePoint(0x0410 + (index % 64)),
  ).join("");
  const sortKey = name.toLowerCase();
  const first = row({ displayName: name, displayNameSortKey: sortKey });
  const second = row({
    displayName: name,
    displayNameSortKey: sortKey,
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  });
  const store = {
    search: async ({ after }) => ({
      snapshotRevision: "17",
      cursorValid: true,
      rows: after === null ? [first, second] : [second],
    }),
  };
  const page = await searchCatalog(store, { query: "кофе", limit: 1 }, signer);
  assert.ok(page.nextCursor && page.nextCursor.length <= 512);
  assert.equal(
    (
      await searchCatalog(
        store,
        { query: "кофе", limit: 1, cursor: page.nextCursor },
        signer,
      )
    ).items[0].variantRef,
    second.variantRef,
  );
});

void test("catalog search validates query length after trim/NFKC/case", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const seen = [];
  const store = {
    search: async (input) => {
      seen.push(input.query);
      return { snapshotRevision: "17", rows: [] };
    },
  };
  await searchCatalog(store, { query: "  Ab  " }, signer);
  await searchCatalog(store, { query: "ﬃ" }, signer);
  await searchCatalog(store, { query: `${"x".repeat(200)} ` }, signer);
  assert.deepEqual(seen, ["ab", "ffi", "x".repeat(200)]);
  for (const query of ["x", "  ", "x".repeat(201)]) {
    await assert.rejects(() => searchCatalog(store, { query }, signer), {
      code: "VALIDATION_FAILED",
    });
  }
});

void test("catalog owner reads only active views in one parameterized SELECT and fails incomplete snapshots", async () => {
  const { createCatalogOwner } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const repository = await readFile(
    new URL(
      "../../apps/catalog-service/src/infrastructure/postgres/catalog-repository.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    (repository.match(/const (?:SEARCH|PRICING)_SQL = `WITH metadata/g) ?? [])
      .length,
    2,
  );
  assert.match(repository, /catalog\.active_snapshot_metadata/u);
  assert.match(
    repository,
    /lower\(normalize\(product\.display_name, NFKC\)\)/u,
  );
  assert.match(
    repository,
    /ORDER BY product\.display_name_sort_key, product\.product_ref, variant\.variant_ref/u,
  );
  assert.doesNotMatch(
    repository,
    /catalog\.(?:catalog_state|products|variants|offer_mappings|availability|snapshot_[a-z_]+)/u,
  );
  const signerKeys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(
    signerKeys.privateKey,
    signerKeys.publicKey,
  );
  const seen = [];
  const store = {
    search: async (input) => {
      seen.push(input);
      return { snapshotRevision: "17", rows: [row()] };
    },
    pricingInput: async () => row(),
  };
  const owner = createCatalogOwner(store, signer);
  const result = await owner.search({
    query: "coffee",
    limit: 20,
    context: { signal: new AbortController().signal, correlationId: "test" },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.items[0], {
    productRef,
    variantRef,
    displayName: "Coffee Arabica",
    unit: "gram",
    availability: "Available",
    mappingAvailable: true,
  });
  assert.deepEqual(seen[0].after, null);
  const incomplete = createCatalogOwner(
    {
      search: async () => ({ snapshotRevision: null, rows: [] }),
      pricingInput: async () => null,
    },
    signer,
  );
  await assert.rejects(
    () =>
      incomplete.search({
        query: "coffee",
        limit: 20,
        context: {
          signal: new AbortController().signal,
          correlationId: "test",
        },
      }),
    { code: "CATALOG_SNAPSHOT_INCOMPLETE" },
  );
  const stale = createCatalogOwner({
    search: async () => ({ snapshotRevision: "17", rows: [] }),
    pricingInput: async () => ({ ...row(), snapshotFresh: false }),
  });
  await assert.rejects(
    () =>
      stale.pricingInput({
        productRef,
        variantRef,
        maxSnapshotAgeMs: 60_000,
        context: {
          signal: new AbortController().signal,
          correlationId: "test",
        },
      }),
    { code: "CATALOG_UNAVAILABLE" },
  );
  const missing = createCatalogOwner({
    search: async () => ({ snapshotRevision: null, rows: [] }),
    pricingInput: async () => undefined,
  });
  await assert.rejects(
    () =>
      missing.pricingInput({
        productRef,
        variantRef,
        maxSnapshotAgeMs: 60_000,
        context: {
          signal: new AbortController().signal,
          correlationId: "test",
        },
      }),
    { code: "CATALOG_UNAVAILABLE" },
  );
});

void test("catalog routes enforce verified public and pricing audiences before owner calls", async (t) => {
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const calls = { search: 0, pricingInput: 0 };
  const owner = {
    search: async () => {
      calls.search += 1;
      return {
        status: 200,
        body: {
          snapshotRevision: "17",
          items: [
            {
              productRef,
              variantRef,
              displayName: "Coffee Arabica",
              unit: "gram",
              availability: "Available",
              mappingAvailable: true,
            },
          ],
          nextCursor: null,
        },
      };
    },
    pricingInput: async () => {
      calls.pricingInput += 1;
      return {
        status: 200,
        body: {
          productRef,
          variantRef,
          offerRef: row().offerRef,
          snapshotRevision: "17",
          supplierUnitMinor: "1200",
          currency: "RUB",
          unit: "gram",
          availability: "Available",
          mappingRevision: "2",
          displayName: "Coffee Arabica",
        },
      };
    },
  };
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );
  const noActor = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
  });
  assert.equal(noActor.statusCode, 401);
  const badTransport = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, { verifyTransport: () => false }),
    ),
  );
  assert.equal(
    (
      await badTransport.inject({
        method: "GET",
        url: "/api/client-v1/catalog/products?query=coffee",
        headers: { "x-actor-context": "signed-test" },
      })
    ).statusCode,
    401,
  );
  const publicResult = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(
    publicResult.statusCode,
    200,
    JSON.stringify(publicResult.json()),
  );
  const publicBody = publicResult.json();
  assert.equal("offerRef" in publicBody.items[0], false);
  assert.equal("supplierUnitMinor" in publicBody.items[0], false);
  const pricingResult = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });
  assert.equal(pricingResult.statusCode, 200);
  assert.equal(pricingResult.json().offerRef, row().offerRef);
  assert.equal(calls.search, 1);
  assert.equal(calls.pricingInput, 1);
  const wrongCaller = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyInternalDelegation: (_token, operationId) => ({
          iss: "api-internal",
          aud: "catalog-service",
          originalCaller: "catalog-supplier-sync",
          operationId,
        }),
      }),
    ),
  );
  assert.equal(
    (
      await wrongCaller.inject({
        method: "GET",
        url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
        headers: { "x-service-delegation": "signed-test" },
      })
    ).statusCode,
    403,
  );
  assert.equal(calls.pricingInput, 1);
});

void test("Catalog pricing-input accepts exact convergence delegation only from api-internal mTLS", async (t) => {
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  let reads = 0;
  let freshnessThreshold;
  const owner = {
    search: async () => ({
      status: 200,
      body: { snapshotRevision: "17", items: [], nextCursor: null },
    }),
    pricingInput: async (input) => {
      reads += 1;
      freshnessThreshold = input.maxSnapshotAgeMs;
      return {
        status: 200,
        body: {
          productRef,
          variantRef,
          offerRef: row().offerRef,
          snapshotRevision: "17",
          supplierUnitMinor: "1200",
          currency: "RUB",
          unit: "gram",
          availability: "Available",
          mappingRevision: "2",
          displayName: "Coffee Arabica",
        },
      };
    },
  };
  const path = `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
  const unconfigured = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyInternalDelegation: (_token, operationId) => ({
          iss: "api-internal",
          aud: "catalog-service",
          originalCaller: "aroma-convergence",
          operationId,
        }),
      }),
    ),
  );
  assert.equal(
    (
      await unconfigured.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "signed-convergence" },
      })
    ).statusCode,
    503,
  );
  assert.equal(reads, 0);
  const convergence = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        snapshotProofMaxAgeMs: 60_000,
        verifyInternalDelegation: (_token, operationId) => ({
          iss: "api-internal",
          aud: "catalog-service",
          originalCaller: "aroma-convergence",
          operationId,
        }),
      }),
    ),
  );
  assert.equal(
    (
      await convergence.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "signed-convergence" },
      })
    ).statusCode,
    200,
  );
  assert.equal(freshnessThreshold, 60_000);
  const observer = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyInternalDelegation: (_token, operationId) => ({
          iss: "api-internal",
          aud: "catalog-service",
          originalCaller: "aroma-observer",
          operationId,
        }),
      }),
    ),
  );
  assert.equal(
    (
      await observer.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "signed-observer" },
      })
    ).statusCode,
    403,
  );
  const forged = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyInternalDelegation: (_token, operationId) => ({
          iss: "pricing-service",
          aud: "catalog-service",
          originalCaller: "aroma-convergence",
          operationId,
        }),
      }),
    ),
  );
  assert.equal(
    (
      await forged.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "forged-issuer" },
      })
    ).statusCode,
    403,
  );
  const noCertificate = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, { verifyTransport: () => false }),
    ),
  );
  assert.equal(
    (
      await noCertificate.inject({
        method: "GET",
        url: path,
        headers: { "x-service-delegation": "signed-convergence" },
      })
    ).statusCode,
    401,
  );
  assert.equal(reads, 1);
});

void test("catalog owner maps database failures without leaking details", async (t) => {
  const { createCatalogOwner, registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const owner = createCatalogOwner({
    search: async () => {
      const error = new Error("private-canary");
      error.code = "DB_QUERY_FAILED";
      throw error;
    },
    pricingInput: async () => null,
  });
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );
  const result = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(result.json()).includes("private-canary"), false);
});

void test("catalog owner rejects error codes outside the operation contract", async (t) => {
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const invalid = {
    status: 503,
    body: {
      type: "about:blank",
      title: "CATALOG_PRODUCT_NOT_FOUND",
      status: 503,
      code: "CATALOG_PRODUCT_NOT_FOUND",
      detail: "private-canary",
      instance: "/",
      correlationId: "11111111-1111-4111-8111-111111111111",
      errors: [],
    },
  };
  const owner = {
    search: async () => invalid,
    pricingInput: async () => invalid,
  };
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );
  const search = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(search.statusCode, 503);
  assert.equal(search.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(JSON.stringify(search.json()).includes("private-canary"), false);
  const pricing = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });
  assert.equal(pricing.statusCode, 503);
  assert.equal(pricing.json().code, "CATALOG_UNAVAILABLE");
});
