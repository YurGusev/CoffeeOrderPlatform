import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import {
  catalogBatchBytes,
  catalogBatchHash,
  catalogContentHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { createCatalogImportStore } from "../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js";
import { runCatalogImport } from "../../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import { readNdjson } from "../../apps/catalog-supplier-sync/dist/ndjson-reader.js";
import { createCatalogActivationStore } from "../../apps/catalog-activation-worker/dist/infrastructure/activation-store.js";
import { createCatalogCursorSigner } from "../../apps/catalog-service/dist/application/search-catalog.js";
import {
  createCatalogAdapters,
  registerCatalogRoutes,
} from "../../apps/catalog-service/dist/http/index.js";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";

const SUPPLIER = "sup_00000000000000000000000001";
const CORRELATION = "11111111-1111-4111-8111-111111111111";
const POOL = {
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 25_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};
const REF = (n) => `snp_${String(n).padStart(26, "0")}`;
const hash = (n) => n.toString(16).padStart(64, "0");

function item(n, name) {
  return {
    sourceProductKeyHash: hash(n),
    sourceVariantKeyHash: hash(n + 100),
    sourceOfferKeyHash: hash(n + 200),
    displayName: name,
    ...(n === 1007
      ? { categoryName: "Чай" }
      : n === 1008
        ? { categoryName: "Кофе" }
        : {}),
    unit: "piece",
    supplierUnitMinor: "123",
    currency: "RUB",
    availability: "Available",
    imageUrl: null,
    supplierPromotions: [],
    grindOptions: [],
    sourceIdentityScheme: "hmac-sha256-v1",
  };
}
function records(snapshotRef, name, mode = "ok", sourceItems) {
  const value = item(Number(snapshotRef.slice(-4)), name);
  const values =
    sourceItems ??
    (mode === "category-conflict"
      ? [
          value,
          {
            ...item(Number(snapshotRef.slice(-4)) + 1000, name),
            sourceProductKeyHash: value.sourceProductKeyHash,
            categoryName: "Кофе",
          },
        ]
      : mode === "multi"
        ? [
            value,
            item(Number(snapshotRef.slice(-4)) + 1000, `${name} alternate`),
          ]
        : [value]);
  const batch = {
    streamVersion: "1",
    recordType: "snapshot-batch",
    snapshotRef,
    batchNumber: 0,
    uncompressedBytes: catalogBatchBytes(values),
    batchHash: catalogBatchHash(values),
    previousBatchHash: null,
    items: values,
    offerCount: values.length,
  };
  const started = {
    streamVersion: "1",
    recordType: "snapshot-started",
    snapshotRef,
    supplierRef: SUPPLIER,
    providerSnapshotRef: `provider-${snapshotRef}`,
    startedAt: "2026-09-24T00:00:00Z",
  };
  const completed = {
    streamVersion: "1",
    recordType: "snapshot-completed",
    snapshotRef,
    batchCount: 1,
    productCount: values.length,
    variantCount: values.length,
    offerCount: values.length,
    contentHash: catalogContentHash([batch.batchHash]),
    completedAt: "2026-09-24T00:00:01Z",
  };
  if (mode === "order")
    return [started, { ...batch, batchNumber: 1 }, completed];
  if (mode === "missing")
    return [
      started,
      batch,
      {
        ...completed,
        batchCount: 2,
        contentHash: catalogContentHash([batch.batchHash, batch.batchHash]),
      },
    ];
  if (mode === "conflict") {
    const changed = { ...value, displayName: `${name} changed` };
    return [
      started,
      batch,
      {
        ...batch,
        items: [changed],
        uncompressedBytes: catalogBatchBytes([changed]),
        batchHash: catalogBatchHash([changed]),
      },
      completed,
    ];
  }
  if (mode === "replay") return [started, batch, { ...batch }, completed];
  if (mode === "no-terminal") return [started, batch];
  return [started, batch, completed];
}
function ndjsonSource(recordsOrBytes) {
  const chunks = (async function* () {
    for (const record of recordsOrBytes)
      yield typeof record === "string"
        ? `${record}\n`
        : `${JSON.stringify(record)}\n`;
  })();
  return readNdjson(Readable.from(chunks, { highWaterMark: 1 }));
}
async function migrate(adminClient) {
  for (const name of [
    "0004_catalog_active",
    "0005_catalog_identity",
    "0006_catalog_outbox",
    "0007_catalog_grants",
    "0008_catalog_active_read",
    "0009_active_snapshot_freshness",
    "0011_active_catalog_category",
    "0012_active_supplier_promotions",
  ])
    await adminClient.query(
      await readFile(
        resolve("apps/catalog-service/migrations", `${name}.sql`),
        "utf8",
      ),
    );
}
function binding(request) {
  return {
    state: "Bound",
    offerRef: request.offerRef,
    supplierRef: request.supplierRef,
    sourceIdentityScheme: request.sourceIdentityScheme,
    sourceOfferKeyHash: request.sourceOfferKeyHash,
    firstSnapshotRef: request.snapshotRef,
  };
}

void test(
  "fake AROMA NDJSON importer failure matrix preserves live Catalog/API until an atomic activation",
  {
    timeout: 300_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "set COFFEE_DB_LIVE_PROOF=1 for disposable PostgreSQL proof"
        : false,
  },
  async (t) => {
    await withCatalogPostgres(
      async ({ adminClient, port, databaseName, database }) => {
        await adminClient.query(
          "CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'",
        );
        await adminClient.query(
          "CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'",
        );
        await migrate(adminClient);
        const activationDb = createDatabase({
          owner: "catalog-activation-worker",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          port,
          user: "coffee_catalog_activate_rw",
          password: "activate-proof",
          ssl: false,
          pool: POOL,
          shutdownGraceMs: 40_000,
        });
        const apiDb = createDatabase({
          owner: "catalog-service",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          port,
          user: "coffee_catalog_api_ro",
          password: "api-proof",
          ssl: false,
          pool: POOL,
          shutdownGraceMs: 40_000,
        });
        await activationDb.resource.start(new AbortController().signal);
        await apiDb.resource.start(new AbortController().signal);
        const signerKeys = generateKeyPairSync("ed25519");
        const signer = createCatalogCursorSigner(
          signerKeys.privateKey,
          signerKeys.publicKey,
        );
        const adapters = createCatalogAdapters(
          apiDb,
          {
            verifyTransport: (_request, expected) =>
              expected === "api-public" || expected === "api-internal",
            verifyPublicDelegation: (_token, operationId) => ({
              iss: "api-public",
              aud: "catalog-service",
              originalIssuer: "edge-gateway",
              sub: "proof",
              permissions: ["catalog:read"],
              operationId,
              correlationId: CORRELATION,
              traceparent:
                "00-00000000000000000000000000000000-0000000000000000-00",
            }),
            verifyInternalDelegation: (_token, operationId) => ({
              iss: "api-internal",
              aud: "catalog-service",
              originalCaller: "pricing-service",
              operationId,
              correlationId: CORRELATION,
              traceparent:
                "00-00000000000000000000000000000000-0000000000000000-00",
            }),
          },
          signer,
        );
        const app = await createRuntime({
          name: "catalog-pipeline-live",
          host: "127.0.0.1",
          port: 0,
          shutdownGraceMs: 2_000,
          deadlineMs: 5_000,
          deadlineProfiles: { defaultMs: 5_000 },
        });
        registerCatalogRoutes(app, adapters);
        await app.runtimeController.start();
        t.after(async () => {
          await app.runtimeController.closeRuntime("SIGTERM");
          await Promise.all([
            apiDb.resource.stop(AbortSignal.timeout(5_000)),
            activationDb.resource.stop(AbortSignal.timeout(5_000)),
          ]);
        });
        const search = async () =>
          app.inject({
            method: "GET",
            url: "/api/client-v1/catalog/products?query=coffee&limit=20",
            headers: { "x-actor-context": "deterministic-test-token" },
          });
        const searchRevision = async (name) => {
          const response = await search();
          assert.equal(response.statusCode, 200, response.body);
          const body = JSON.parse(response.body);
          assert.ok(
            body.items.some((row) => row.displayName === name),
            JSON.stringify(body),
          );
          return body.snapshotRevision;
        };
        const importStore = createCatalogImportStore(database);
        const activation = createCatalogActivationStore(activationDb);
        const importOne = async (n, name, mode = "ok", options = {}) =>
          runCatalogImport({
            store: importStore,
            supplierRef: SUPPLIER,
            context: { correlationId: CORRELATION },
            signal: options.signal ?? new AbortController().signal,
            ...(options.deadlineMs === undefined
              ? {}
              : { deadlineMs: options.deadlineMs }),
            snapshotRef: REF(n),
            exportCatalog: ({ snapshotRef }) =>
              options.exportCatalog
                ? options.exportCatalog(snapshotRef)
                : ndjsonSource(records(snapshotRef, name, mode)),
          });
        const activated = async (snapshotRef) =>
          activation.runSnapshot(snapshotRef, binding);

        const baseRef = REF(1001);
        assert.equal(await importOne(1001, "Coffee old"), baseRef);
        assert.deepEqual(await activated(baseRef), {
          kind: "activated",
          snapshotRef: baseRef,
          snapshotRevision: "1",
        });
        const oldRevision = await searchRevision("Coffee old");
        assert.equal(oldRevision, "1");
        assert.equal(
          Object.hasOwn((await search()).json().items[0], "categoryName"),
          false,
        );

        const failed = [
          {
            n: 1012,
            name: "Coffee inconsistent category",
            mode: "category-conflict",
            code: "SOURCE_IDENTITY_COLLISION",
          },
          {
            n: 1002,
            name: "Coffee order",
            mode: "order",
            code: "BATCH_SEQUENCE_CONFLICT",
          },
          {
            n: 1003,
            name: "Coffee missing",
            mode: "missing",
            code: "TERMINAL_COUNT_MISMATCH",
          },
          {
            n: 1004,
            name: "Coffee conflict",
            mode: "conflict",
            code: "BATCH_REPLAY_CONFLICT",
            failureCode: "BATCH_HASH_CONFLICT",
          },
          {
            n: 1005,
            name: "Coffee malformed",
            source: true,
            code: "CATALOG_STREAM_INVALID_JSON",
          },
          {
            n: 1006,
            name: "Coffee close",
            mode: "no-terminal",
            code: "INVALID_STREAM_MISSING_TERMINAL",
          },
          {
            n: 1011,
            name: "Coffee abnormal close",
            source: true,
            abnormal: true,
            code: "INVALID_STREAM",
          },
        ];
        for (const scenario of failed) {
          const args = scenario.source
            ? {
                exportCatalog: (snapshotRef) => {
                  if (scenario.abnormal)
                    return readNdjson(
                      Readable.from(
                        (async function* () {
                          for (const record of records(
                            snapshotRef,
                            scenario.name,
                          ).slice(0, 2))
                            yield Buffer.from(`${JSON.stringify(record)}\n`);
                          throw new Error(
                            "provider transport closed unexpectedly",
                          );
                        })(),
                        { highWaterMark: 1 },
                      ),
                    );
                  const started = records(snapshotRef, scenario.name)[0];
                  return readNdjson(
                    Readable.from(
                      [
                        Buffer.from(JSON.stringify(started)),
                        Buffer.from([10]),
                        Buffer.from("not-json"),
                        Buffer.from([10]),
                      ],
                      { highWaterMark: 1 },
                    ),
                  );
                },
              }
            : {};
          await assert.rejects(
            () =>
              importOne(scenario.n, scenario.name, scenario.mode ?? "ok", args),
            (error) =>
              error.code === scenario.code ||
              (scenario.abnormal &&
                error.message === "provider transport closed unexpectedly"),
            `scenario ${scenario.name}`,
          );
          assert.equal(
            await searchRevision("Coffee old"),
            oldRevision,
            `${scenario.name} changed public active rows`,
          );
          const state = (
            await adminClient.query(
              "SELECT state,failure_code FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
              [REF(scenario.n)],
            )
          ).rows[0];
          assert.equal(state.state, "Rejected", scenario.name);
          assert.equal(
            state.failure_code,
            scenario.failureCode ?? scenario.code,
            scenario.name,
          );
          assert.deepEqual(
            await activated(REF(scenario.n)),
            { kind: "idle" },
            `${scenario.name} must not activate`,
          );
        }

        // Same-hash replay is consumed by the importer as an idempotent no-op and still activates once.
        const replayRef = REF(1007);
        assert.equal(
          await importOne(1007, "Coffee replay", "replay"),
          replayRef,
        );
        const replayBatch = (
          await adminClient.query(
            "SELECT count(*)::int AS n FROM catalog.snapshot_batches WHERE snapshot_ref=$1",
            [replayRef],
          )
        ).rows[0].n;
        assert.equal(
          replayBatch,
          1,
          "same-hash replay duplicated durable batch",
        );
        assert.deepEqual(await activated(replayRef), {
          kind: "activated",
          snapshotRef: replayRef,
          snapshotRevision: "2",
        });
        assert.equal(await searchRevision("Coffee replay"), "2");
        assert.equal(
          (await search())
            .json()
            .items.find((row) => row.displayName === "Coffee replay")
            .categoryName,
          "Чай",
        );
        assert.deepEqual(
          (
            await adminClient.query(
              "SELECT category_name FROM catalog.snapshot_products WHERE snapshot_ref=$1",
              [replayRef],
            )
          ).rows,
          [{ category_name: "Чай" }],
        );

        // Keep querying the real Fastify/API + PostgreSQL path while activation switches the pointer.
        const nextRef = REF(1008);
        assert.equal(await importOne(1008, "Coffee new", "multi"), nextRef);
        const observed = [];
        let reading = true;
        const reader = (async () => {
          while (reading) {
            const response = await search();
            assert.equal(response.statusCode, 200, response.body);
            const body = JSON.parse(response.body);
            assert.ok(
              ["2", "3"].includes(body.snapshotRevision),
              `unexpected revision ${body.snapshotRevision}`,
            );
            const names = body.items.map((row) => row.displayName).sort();
            const expected =
              body.snapshotRevision === "2"
                ? ["Coffee old", "Coffee replay"]
                : [
                    "Coffee old",
                    "Coffee replay",
                    "Coffee new",
                    "Coffee new alternate",
                  ];
            assert.deepEqual(
              names,
              expected.sort(),
              "one API response mixed or omitted products across active revisions",
            );
            observed.push(body.snapshotRevision);
          }
        })();
        let switched;
        try {
          switched = await activated(nextRef);
          const afterSwitch = await search();
          assert.equal(afterSwitch.statusCode, 200, afterSwitch.body);
          const finalPage = JSON.parse(afterSwitch.body);
          assert.equal(finalPage.snapshotRevision, "3");
          for (const row of finalPage.items) {
            const expectedCategory =
              row.displayName === "Coffee replay"
                ? "Чай"
                : row.displayName === "Coffee new"
                  ? "Кофе"
                  : undefined;
            assert.equal(row.categoryName, expectedCategory);
            assert.equal(
              Object.hasOwn(row, "categoryName"),
              expectedCategory !== undefined,
            );
          }
          assert.equal(
            (
              await adminClient.query(
                "SELECT category_name FROM catalog.active_products WHERE display_name='Coffee new'",
              )
            ).rows[0].category_name,
            "Кофе",
          );
          assert.deepEqual(
            finalPage.items.map((row) => row.displayName).sort(),
            [
              "Coffee old",
              "Coffee replay",
              "Coffee new",
              "Coffee new alternate",
            ].sort(),
          );
          observed.push(finalPage.snapshotRevision);
        } finally {
          reading = false;
          await reader;
        }
        assert.deepEqual(switched, {
          kind: "activated",
          snapshotRef: nextRef,
          snapshotRevision: "3",
        });
        assert.ok(
          observed.includes("2") && observed.includes("3"),
          "API reader must observe both sides of the activation",
        );
        assert.equal(await searchRevision("Coffee new"), "3");

        // Deadline and caller cancellation interrupt the source after snapshot-started; neither may switch active state.
        const timeoutRef = REF(1009);
        await assert.rejects(() =>
          importOne(1009, "Coffee timeout", "ok", {
            deadlineMs: 25,
            exportCatalog: async function* (snapshotRef) {
              yield records(snapshotRef, "Coffee timeout")[0];
              await new Promise((resolve) => setTimeout(resolve, 100));
              yield records(snapshotRef, "Coffee timeout")[1];
            },
          }),
        );
        assert.equal(
          (
            await adminClient.query(
              "SELECT state,failure_code FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
              [timeoutRef],
            )
          ).rows[0].failure_code,
          "IMPORT_DEADLINE_EXCEEDED",
        );
        assert.equal(await searchRevision("Coffee new"), "3");

        const cancelRef = REF(1010);
        const controller = new AbortController();
        let startedResolve;
        const startedSeen = new Promise((resolve) => {
          startedResolve = resolve;
        });
        let cancelSourceResolve;
        const cancelSource = new Promise((resolve) => {
          cancelSourceResolve = resolve;
        });
        const cancelled = importOne(1010, "Coffee cancelled", "ok", {
          signal: controller.signal,
          exportCatalog: async function* (snapshotRef) {
            yield records(snapshotRef, "Coffee cancelled")[0];
            startedResolve();
            await cancelSource;
            controller.signal.throwIfAborted();
            yield records(snapshotRef, "Coffee cancelled")[1];
          },
        });
        await startedSeen;
        controller.abort(new Error("deterministic cancellation"));
        cancelSourceResolve();
        await assert.rejects(() => cancelled);
        assert.equal(
          (
            await adminClient.query(
              "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",
              [cancelRef],
            )
          ).rows[0].state,
          "Receiving",
        );
        assert.equal(await searchRevision("Coffee new"), "3");
        // Synthetic rules exercise display/filter semantics, not provider price applicability.
        const promotion = (discountBasisPoints, minimumWeightRaw = "0") => ({
          discountBasisPoints,
          minimumWeightRaw,
          providerCreatedAt: "2026-09-14T04:55:24Z",
          providerUpdatedAt: "2026-09-14T04:55:24Z",
        });
        const legacyItem = item(3005, "Coffee promo E");
        delete legacyItem.supplierPromotions;
        const promotionalItems = [
          {
            ...item(3001, "Coffee promo A"),
            supplierPromotions: [promotion(3500)],
          },
          item(3002, "Coffee promo B"),
          {
            ...item(3003, "Coffee promo C"),
            supplierPromotions: [promotion(1000, "0.25")],
          },
          {
            ...item(3004, "Coffee promo D"),
            supplierPromotions: [promotion(1000), promotion(3500)],
          },
          legacyItem,
        ];
        const promotionsRef = REF(1100);
        await importOne(1100, "promotions", "ok", {
          exportCatalog: (snapshotRef) =>
            ndjsonSource(
              records(snapshotRef, "promotions", "ok", promotionalItems),
            ),
        });
        assert.equal((await activated(promotionsRef)).kind, "activated");
        const promotionPage = async (query = "") => {
          const response = await app.inject({
            method: "GET",
            url: `/api/client-v1/catalog/products?query=coffee%20promo${query}`,
            headers: { "x-actor-context": "deterministic-test-token" },
          });
          assert.equal(response.statusCode, 200, response.body);
          return response.json();
        };
        const allPromotions = await promotionPage();
        assert.deepEqual(
          allPromotions.items.map((row) => row.displayName),
          promotionalItems.map((row) => row.displayName),
        );
        assert.deepEqual(allPromotions.items[0].supplierPromotions, [
          promotion(3500),
        ]);
        assert.deepEqual(allPromotions.items[1].supplierPromotions, []);
        assert.equal(
          Object.hasOwn(allPromotions.items[4], "supplierPromotions"),
          false,
        );
        const firstPromotionPage = await promotionPage(
          "&supplierDiscountBasisPoints=3500&limit=1",
        );
        assert.equal(firstPromotionPage.items[0].displayName, "Coffee promo A");
        assert.ok(firstPromotionPage.nextCursor);
        const secondPromotionPage = await promotionPage(
          `&supplierDiscountBasisPoints=3500&limit=1&cursor=${firstPromotionPage.nextCursor}`,
        );
        assert.deepEqual(
          secondPromotionPage.items.map((row) => row.displayName),
          ["Coffee promo D"],
        );
        assert.equal(secondPromotionPage.nextCursor, null);
        assert.deepEqual(
          (await promotionPage("&supplierDiscountBasisPoints=1000")).items.map(
            (row) => row.displayName,
          ),
          ["Coffee promo C", "Coffee promo D"],
        );
        for (const changedFilter of ["", "&supplierDiscountBasisPoints=1000"]) {
          const mismatch = await app.inject({
            method: "GET",
            url: `/api/client-v1/catalog/products?query=coffee%20promo${changedFilter}&cursor=${firstPromotionPage.nextCursor}`,
            headers: { "x-actor-context": "deterministic-test-token" },
          });
          assert.equal(mismatch.statusCode, 400, mismatch.body);
          assert.equal(mismatch.json().code, "INVALID_CURSOR");
        }
        const replacementItems = promotionalItems
          .filter((row) => row.displayName !== "Coffee promo D")
          .map((row) =>
            row.displayName === "Coffee promo A"
              ? { ...row, supplierPromotions: [] }
              : row,
          );
        await importOne(1101, "promotions removed", "ok", {
          exportCatalog: (snapshotRef) =>
            ndjsonSource(
              records(
                snapshotRef,
                "promotions removed",
                "ok",
                replacementItems,
              ),
            ),
        });
        assert.equal((await activated(REF(1101))).kind, "activated");
        assert.deepEqual(
          (await promotionPage("&supplierDiscountBasisPoints=3500")).items,
          [],
        );
        assert.deepEqual(
          (await promotionPage("&supplierDiscountBasisPoints=1000")).items.map(
            (row) => row.displayName,
          ),
          ["Coffee promo C"],
        );
        const afterRemoval = await promotionPage();
        assert.deepEqual(
          afterRemoval.items.find((row) => row.displayName === "Coffee promo A")
            .supplierPromotions,
          [],
        );
        const missing = afterRemoval.items.find(
          (row) => row.displayName === "Coffee promo D",
        );
        assert.equal(missing.availability, "Unavailable");
        assert.equal(Object.hasOwn(missing, "supplierPromotions"), false);
        t.diagnostic(
          JSON.stringify({
            livePostgres: true,
            scenarios: failed.map((row) => ({
              name: row.name,
              code: row.code,
              state: "Rejected",
            })),
            replayBatchCount: replayBatch,
            activeRevisionAfterFailures: oldRevision,
            concurrentApiRevisions: [...new Set(observed)],
            finalActiveRevision: "5",
            supplierPromotionFilterBeforePagination: true,
            removedAndMissingPromotionsCleared: true,
            timeoutRejected: true,
            cancellationState: "Receiving",
          }),
        );
      },
    );
  },
);
