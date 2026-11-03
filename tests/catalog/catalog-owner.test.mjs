import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import pg from "pg";
import test from "node:test";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  CatalogOwnerError,
  createCatalogCursorSigner,
  searchCatalog,
} from "../../apps/catalog-service/dist/application/search-catalog.js";
import { CatalogStore } from "../../apps/catalog-service/dist/infrastructure/postgres/catalog-store.js";

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

void test("catalog browse omits the query filter and binds its cursor to the same availability", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey, {
    nowEpochSeconds: () => 1_000,
  });
  const rows = [
    row(),
    row({
      productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      displayName: "Coffee Robusta",
      displayNameSortKey: "coffee robusta",
    }),
  ];
  const seen = [];
  const store = {
    search: async (input) => {
      seen.push(input);
      const start = input.after === null ? 0 : 1;
      return {
        snapshotRevision: "17",
        cursorValid:
          input.after === null || input.after.productRef === rows[0].productRef,
        rows: rows.slice(start, start + input.limit),
      };
    },
  };
  const first = await searchCatalog(
    store,
    { availability: "Available", limit: 1 },
    signer,
  );
  assert.equal(seen[0].query, "");
  assert.ok(first.nextCursor);
  const second = await searchCatalog(
    store,
    { availability: "Available", limit: 1, cursor: first.nextCursor },
    signer,
  );
  assert.deepEqual(
    second.items.map((item) => item.displayName),
    ["Coffee Robusta"],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(seen[1].query, "");
  assert.ok(seen[1].after);
});

void test("catalog search preserves request cancellation metadata and supported optional fields", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const signal = new AbortController().signal;
  let seen;
  const result = await searchCatalog(
    {
      search: async (input) => {
        seen = input;
        return {
          snapshotRevision: "17",
          cursorValid: false,
          rows: [
            row({
              imageUrl: "https://catalog.example.test/coffee.png",
              grindOptions: [
                { sourceGrindKeyHash: "a".repeat(64), displayName: "Espresso" },
              ],
            }),
          ],
        };
      },
    },
    {
      query: "coffee",
      limit: 1,
      signal,
      correlationId: "catalog-search-context",
    },
    signer,
  );

  assert.equal(seen.signal, signal);
  assert.equal(seen.correlationId, "catalog-search-context");
  assert.equal(seen.limit, 2);
  assert.deepEqual(result.items[0].grindOptions, [
    { sourceGrindKeyHash: "a".repeat(64), displayName: "Espresso" },
  ]);
  assert.equal(
    result.items[0].imageUrl,
    "https://catalog.example.test/coffee.png",
  );
});

void test("catalog search fails closed on malformed signed cursor claims", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey, {
    nowEpochSeconds: () => 1_000,
  });
  const valid = {
    v: 1,
    kid: "catalog-v1",
    iat: 1_000,
    exp: 2_000,
    snapshotRevision: "17",
    filterHash: createHash("sha256")
      .update(JSON.stringify(["coffee", null]))
      .digest("base64url"),
    sortKeyHash: "a".repeat(64),
    productRef,
    variantRef,
  };
  const invalidPayloads = [
    null,
    [],
    { ...valid, v: 2 },
    { ...valid, kid: "retired-key" },
    { ...valid, iat: "1000" },
    { ...valid, exp: 995 },
    { ...valid, iat: 1_006 },
    { ...valid, exp: 1_000 },
    { ...valid, exp: 87_406 },
    { ...valid, snapshotRevision: "0" },
    { ...valid, filterHash: "different-query" },
    { ...valid, sortKeyHash: "not-a-hash" },
    { ...valid, productRef: "unknown-product" },
    { ...valid, variantRef: "unknown-variant" },
  ];
  const store = {
    search: async () => {
      throw new Error("invalid cursor reached the Catalog store");
    },
  };
  const signedCursor = (payload) => {
    const bytes = Buffer.from(JSON.stringify(payload), "utf8");
    return `${bytes.toString("base64url")}${sign(null, bytes, keys.privateKey).toString("base64url")}`;
  };

  for (const cursor of ["!", "A".repeat(86), "A".repeat(513)]) {
    await assert.rejects(
      () => searchCatalog(store, { query: "coffee", cursor }, signer),
      { code: "INVALID_CURSOR" },
    );
  }
  for (const payload of invalidPayloads) {
    await assert.rejects(
      () =>
        searchCatalog(
          store,
          { query: "coffee", cursor: signedCursor(payload) },
          signer,
        ),
      { code: "INVALID_CURSOR" },
    );
  }
});

void test("Catalog rejects malformed persisted search rows before exposing them", async () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  for (const malformed of [
    { unit: "unknown-unit" },
    { availability: "unknown-state" },
    { mappingAvailable: null },
    { displayNameSortKey: undefined },
    { grindOptions: [null] },
    { grindOptions: Array.from({ length: 101 }, () => ({})) },
  ]) {
    await assert.rejects(
      () =>
        searchCatalog(
          {
            search: async () => ({
              snapshotRevision: "17",
              rows: [row(malformed)],
            }),
          },
          { query: "coffee" },
          signer,
        ),
      { code: "CATALOG_UNAVAILABLE" },
    );
  }
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

void test("Catalog pricing refuses unavailable and non-RUB offer mappings", async () => {
  const { createCatalogOwner } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const complete = { ...row(), snapshotFresh: true };
  for (const unavailable of [
    { ...complete, mappingAvailable: false },
    { ...complete, currency: "USD" },
  ]) {
    const owner = createCatalogOwner({
      search: async () => ({ snapshotRevision: "17", rows: [] }),
      pricingInput: async () => unavailable,
    });
    await assert.rejects(
      () =>
        owner.pricingInput({
          productRef,
          variantRef,
          context: {
            signal: new AbortController().signal,
            correlationId: "catalog-pricing-context",
          },
        }),
      { code: "CATALOG_PRODUCT_NOT_FOUND" },
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

void test("CatalogStore calls its repository with exact search and pricing parameters and handles empty active metadata", async (t) => {
  const searchRow = row({
    snapshotRevision: "42",
    displayName: "Coffee Arabica",
  });
  const searchCalls = [];
  const pricingCalls = [];
  let searchRows = [
    { ...searchRow, cursorValid: true },
    { ...searchRow, productRef: null, variantRef: null, cursorValid: true },
  ];
  let pricingRows = [{ ...searchRow, snapshotFresh: true }];
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    const values = typeof query === "string" ? [] : query.values;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      return { rows: [], rowCount: 0, command: sql };
    if (sql.startsWith("SET LOCAL "))
      return { rows: [], rowCount: 0, command: "SET" };
    if (sql.includes("FROM metadata LEFT JOIN candidates")) {
      searchCalls.push({ sql, values });
      return {
        rows: searchRows,
        rowCount: searchRows.length,
        command: "SELECT",
      };
    }
    if (
      sql.includes("FROM metadata") &&
      sql.includes("LEFT JOIN catalog.active_products")
    ) {
      pricingCalls.push({ sql, values });
      return {
        rows: pricingRows,
        rowCount: pricingRows.length,
        command: "SELECT",
      };
    }
    throw new Error(`unexpected CatalogStore SQL: ${sql}`);
  };
  connection.release = () => {};
  t.mock.method(pg.Pool.prototype, "connect", async () => connection);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const database = createDatabase({
    owner: "catalog-service",
    database: "coffee_platform_catalog",
    allowedDatabase: "coffee_platform_catalog",
    host: "127.0.0.1",
    port: 5432,
    user: "catalog-unit",
    password: "catalog-unit-only",
    ssl: false,
    pool: {
      max: 2,
      checkoutTimeoutMs: 100,
      lockTimeoutMs: 100,
      interactiveStatementTimeoutMs: 1000,
      backgroundStatementTimeoutMs: 1000,
      terminalTimeoutMs: 100,
      transactionTimeoutMs: 2000,
      idleTimeoutMs: 5000,
      maxLifetimeMs: 10_000,
    },
    shutdownGraceMs: 5000,
  });
  t.after(() => database.resource.destroy());
  await database.resource.start(new AbortController().signal);
  const store = new CatalogStore(database);
  const after = { sortKeyHash: "a".repeat(64), productRef, variantRef };
  const page = await store.search({
    query: "coffee",
    availability: "Available",
    after,
    limit: 5,
    signal: new AbortController().signal,
    correlationId: "catalog-store-unit",
  });
  assert.deepEqual(page, {
    snapshotRevision: "42",
    cursorValid: true,
    rows: [{ ...searchRow, cursorValid: true }],
  });
  assert.deepEqual(searchCalls[0].values, [
    "coffee",
    "Available",
    after.sortKeyHash,
    productRef,
    variantRef,
    5,
  ]);
  assert.match(searchCalls[0].sql, /catalog\.active_snapshot_metadata/u);
  assert.match(searchCalls[0].sql, /catalog\.active_offer_mappings/u);
  assert.doesNotMatch(
    searchCalls[0].sql,
    /catalog\.(?:catalog_state|offer_mappings|snapshot_[a-z_]+)/u,
  );

  const { createCatalogAdapters } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const keys = generateKeyPairSync("ed25519");
  const signer = createCatalogCursorSigner(keys.privateKey, keys.publicKey);
  const security = {
    verifyTransport: () => true,
    verifyPublicDelegation: () => claims("searchCatalogProducts"),
    verifyInternalDelegation: () => ({
      iss: "api-internal",
      aud: "catalog-service",
      originalCaller: "pricing-service",
      operationId: "getCatalogPricingInput",
    }),
  };
  const adapters = createCatalogAdapters(database, security, signer, 60_000);
  assert.equal(adapters.verifyTransport, security.verifyTransport);
  assert.equal(
    adapters.verifyPublicDelegation,
    security.verifyPublicDelegation,
  );
  assert.equal(
    adapters.verifyInternalDelegation,
    security.verifyInternalDelegation,
  );
  assert.equal(adapters.snapshotProofMaxAgeMs, 60_000);
  const adaptedSearch = await adapters.owner.search({
    query: "Coffee",
    availability: "Available",
    limit: 3,
    context: {
      signal: new AbortController().signal,
      correlationId: "catalog-adapter-search",
    },
  });
  assert.equal(adaptedSearch.status, 200);
  assert.equal(adaptedSearch.body.items[0].productRef, productRef);
  assert.equal(
    searchCalls.length,
    2,
    "the adapter must use its real CatalogStore",
  );
  assert.deepEqual(searchCalls[1].values, [
    "coffee",
    "Available",
    null,
    null,
    null,
    4,
  ]);

  searchRows = [];
  assert.deepEqual(
    await store.search({
      query: "coffee",
      availability: null,
      after: null,
      limit: 5,
    }),
    { snapshotRevision: null, cursorValid: false, rows: [] },
  );
  const pricing = await store.pricingInput(
    productRef,
    variantRef,
    undefined,
    "catalog-pricing-unit",
    60_000,
  );
  assert.deepEqual(pricing, pricingRows[0]);
  assert.deepEqual(pricingCalls[0].values, [productRef, variantRef, 60_000]);
  assert.match(pricingCalls[0].sql, /catalog\.active_snapshot_metadata/u);
  assert.match(pricingCalls[0].sql, /snapshotFresh/u);
  const adaptedPricing = await adapters.owner.pricingInput({
    productRef,
    variantRef,
    maxSnapshotAgeMs: 60_000,
    context: {
      signal: new AbortController().signal,
      correlationId: "catalog-adapter-pricing",
    },
  });
  assert.equal(adaptedPricing.status, 200);
  assert.equal(adaptedPricing.body.offerRef, searchRow.offerRef);
  assert.deepEqual(pricingCalls[1].values, [productRef, variantRef, 60_000]);
  pricingRows = [];
  assert.equal(await store.pricingInput(productRef, variantRef), undefined);
});

void test("catalog routes enforce verified public and pricing audiences before owner calls", async (t) => {
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const calls = { search: 0, searchQuery: undefined, pricingInput: 0 };
  const owner = {
    search: async (input) => {
      calls.search += 1;
      calls.searchQuery = input.query;
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
  const browseResult = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products",
    headers: { "x-actor-context": "signed-test" },
  });
  assert.equal(browseResult.statusCode, 200);
  assert.equal(calls.searchQuery, undefined);
  const pricingResult = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });
  assert.equal(pricingResult.statusCode, 200);
  assert.equal(pricingResult.json().offerRef, row().offerRef);
  assert.equal(calls.search, 2);
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

void test("catalog framework rejects invalid pricing params before transport or owner access", async (t) => {
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  let transportChecks = 0;
  let delegationChecks = 0;
  let ownerCalls = 0;
  const owner = {
    search: async () => {
      ownerCalls++;
      return {
        status: 200,
        body: { snapshotRevision: "17", items: [], nextCursor: null },
      };
    },
    pricingInput: async () => {
      ownerCalls++;
      return { status: 200, body: {} };
    },
  };
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyTransport: () => {
          transportChecks++;
          return true;
        },
        verifyInternalDelegation: (_token, operationId) => {
          delegationChecks++;
          return {
            iss: "api-internal",
            aud: "catalog-service",
            originalCaller: "pricing-service",
            operationId,
          };
        },
      }),
    ),
  );
  const result = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/not-a-product/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().code, "VALIDATION_FAILED");
  assert.equal(result.json().detail, "request is invalid");
  assert.equal(transportChecks, 0);
  assert.equal(delegationChecks, 0);
  assert.equal(ownerCalls, 0);
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

void test("Catalog search maps typed owner failures to safe public problems", async (t) => {
  const cases = [
    ["VALIDATION_FAILED", 400],
    ["INVALID_CURSOR", 400],
    ["CATALOG_SNAPSHOT_INCOMPLETE", 503],
    ["CATALOG_PRODUCT_NOT_FOUND", 404],
  ];
  let failure;
  const owner = {
    search: async () => {
      throw failure;
    },
    pricingInput: async () => ({ status: 200, body: {} }),
  };
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );

  for (const [code, status] of cases) {
    failure = new CatalogOwnerError(code);
    const result = await app.inject({
      method: "GET",
      url: "/api/client-v1/catalog/products?query=coffee",
      headers: { "x-actor-context": "signed-test" },
    });
    assert.equal(result.statusCode, status, code);
    assert.equal(result.json().code, code, code);
    assert.equal(result.json().detail.includes(code), false, code);
  }
});

void test("Catalog routes reject forged identities and under-scoped claims before owner access", async (t) => {
  let ownerCalls = 0;
  let delegationChecks = 0;
  const owner = {
    search: async () => {
      ownerCalls += 1;
      return {
        status: 200,
        body: { snapshotRevision: "17", items: [], nextCursor: null },
      };
    },
    pricingInput: async () => {
      ownerCalls += 1;
      return { status: 200, body: {} };
    },
  };
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(
      value,
      adapters(owner, undefined, {
        verifyPublicDelegation: (_token, operationId) => {
          delegationChecks += 1;
          return { ...claims(operationId), permissions: [] };
        },
      }),
    ),
  );

  for (const header of ["x-original-caller", "x-service-delegation"]) {
    const result = await app.inject({
      method: "GET",
      url: "/api/client-v1/catalog/products?query=coffee",
      headers: {
        "x-actor-context": "signed-test",
        [header]: "forged-canary",
      },
    });
    assert.equal(result.statusCode, 403);
    assert.equal(result.json().code, "ACTOR_CONTEXT_INVALID");
  }
  const underScoped = await app.inject({
    method: "GET",
    url: "/api/client-v1/catalog/products?query=coffee",
    headers: { "x-actor-context": "missing-catalog-permission" },
  });
  assert.equal(delegationChecks, 1);
  assert.equal(ownerCalls, 0);
  assert.equal(underScoped.statusCode, 403);
  assert.equal(underScoped.json().code, "ACTOR_CONTEXT_INVALID");
});

void test("Catalog pricing forwards a typed not-found result without leaking owner details", async (t) => {
  const owner = {
    search: async () => ({
      status: 200,
      body: { snapshotRevision: "17", items: [], nextCursor: null },
    }),
    pricingInput: async () => ({
      status: 404,
      body: {
        type: "about:blank",
        title: "CATALOG_PRODUCT_NOT_FOUND",
        status: 404,
        code: "CATALOG_PRODUCT_NOT_FOUND",
        detail: "supplier-secret-canary",
        instance: "/internal-source",
        correlationId: "11111111-1111-4111-8111-111111111111",
        errors: [],
      },
    }),
  };
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );
  const result = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });

  assert.equal(result.statusCode, 404);
  assert.equal(result.json().code, "CATALOG_PRODUCT_NOT_FOUND");
  assert.equal(result.json().detail, "catalog request failed");
  assert.equal(
    JSON.stringify(result.json()).includes("supplier-secret-canary"),
    false,
  );
  assert.equal(result.headers["cache-control"], "no-store");
});

void test("Catalog pricing rejects malformed successful owner DTOs", async (t) => {
  const owner = {
    search: async () => ({
      status: 200,
      body: { snapshotRevision: "17", items: [], nextCursor: null },
    }),
    pricingInput: async () => ({
      status: 200,
      body: { offerRef: "private-owner-payload" },
    }),
  };
  const { registerCatalogRoutes } =
    await import("../../apps/catalog-service/dist/http/index.js");
  const app = await runtime(t, (value) =>
    registerCatalogRoutes(value, adapters(owner)),
  );
  const result = await app.inject({
    method: "GET",
    url: `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
    headers: { "x-service-delegation": "signed-test" },
  });

  assert.equal(result.statusCode, 503);
  assert.equal(result.json().code, "CATALOG_UNAVAILABLE");
  assert.equal(
    JSON.stringify(result.json()).includes("private-owner-payload"),
    false,
  );
});
