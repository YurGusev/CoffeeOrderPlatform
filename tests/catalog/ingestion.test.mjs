import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  canonicalCatalogJson,
  catalogBatchHash,
  catalogContentHash,
  isAromaCatalogExportRecord,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { defineTemporaryTable } from "../../packages/platform-database/dist/owner.js";
import { createHash } from "node:crypto";
import * as hashes from "../../packages/contracts/aroma-v1/dist/index.js";

const VECTOR = JSON.parse(
  await readFile(
    new URL("./fixtures/hash-vectors.json", import.meta.url),
    "utf8",
  ),
);
const ITEM = Object.freeze(VECTOR.items[0]);

void test("incremental content hash preserves binary concatenation, ordering, validation and finalization", () => {
  const values = ["01".repeat(32), "fe".repeat(32), "ab".repeat(32)];
  const expected = createHash("sha256")
    .update(Buffer.concat(values.map((value) => Buffer.from(value, "hex"))))
    .digest("hex");
  const accumulator = hashes.createCatalogContentHash();
  for (const value of values) accumulator.update(value);
  assert.equal(accumulator.digest(), expected);
  assert.equal(catalogContentHash(values), expected);
  assert.notEqual(catalogContentHash([...values].reverse()), expected);
  assert.throws(() => accumulator.update(values[0]));
  assert.throws(() => accumulator.digest());
  assert.equal(
    hashes.createCatalogContentHash().digest(),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  const golden = hashes.createCatalogContentHash();
  golden.update(VECTOR.batchHash);
  assert.equal(golden.digest(), VECTOR.contentHash);
  const validated = hashes.createCatalogContentHash();
  for (const invalid of [
    "",
    "0".repeat(63),
    "0".repeat(65),
    "AB".repeat(32),
    "gg".repeat(32),
  ]) {
    assert.throws(
      () => validated.update(invalid),
      /batch hash must be lowercase SHA-256 hex/u,
    );
    assert.throws(
      () => catalogContentHash([invalid]),
      /batch hash must be lowercase SHA-256 hex/u,
    );
  }
  validated.update(values[0]);
  assert.equal(
    validated.digest(),
    catalogContentHash([values[0]]),
    "invalid input must not alter the hash state",
  );
});

void test("shared canonical/hash contract preserves optional presence and golden vector", () => {
  const reordered = { b: [ITEM], a: { z: 2, y: 1 } };
  assert.equal(
    canonicalCatalogJson(reordered),
    canonicalCatalogJson({ a: { y: 1, z: 2 }, b: [ITEM] }),
  );
  const { grindOptions: _removed, ...withoutGrinds } = ITEM;
  assert.notEqual(catalogBatchHash([withoutGrinds]), catalogBatchHash([ITEM]));
  const reversed = {
    ...ITEM,
    grindOptions: [
      { sourceGrindKeyHash: "4".repeat(64), displayName: "A" },
      { sourceGrindKeyHash: "5".repeat(64), displayName: "B" },
    ],
  };
  assert.notEqual(
    catalogBatchHash([reversed]),
    catalogBatchHash([
      { ...reversed, grindOptions: [...reversed.grindOptions].reverse() },
    ]),
  );
  assert.equal(catalogBatchHash(VECTOR.items), VECTOR.batchHash);
  assert.equal(catalogContentHash([VECTOR.batchHash]), VECTOR.contentHash);
});

void test("generated record guard accepts only the four typed variants", () => {
  assert.equal(
    isAromaCatalogExportRecord({
      streamVersion: "1",
      recordType: "snapshot-started",
      snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      supplierRef: "sup_00000000000000000000000001",
      providerSnapshotRef: "provider-1",
      startedAt: "2026-09-20T00:00:00Z",
    }),
    true,
  );
  assert.equal(isAromaCatalogExportRecord({ recordType: "other" }), false);
  for (const money of [
    "1.0",
    "01",
    "+1",
    "1e2",
    " 1",
    1,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ]) {
    assert.equal(
      isAromaCatalogExportRecord({
        streamVersion: "1",
        recordType: "snapshot-batch",
        snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        batchNumber: 0,
        offerCount: 1,
        uncompressedBytes: 100,
        batchHash: VECTOR.batchHash,
        previousBatchHash: null,
        items: [{ ...ITEM, supplierUnitMinor: money }],
      }),
      false,
      `invalid money ${String(money)}`,
    );
  }
});

void test("Catalog rejects negative money before acquiring a transaction", async () => {
  const { createCatalogImportStore } =
    await import("../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js");
  const items = [{ ...ITEM, supplierUnitMinor: "-1" }];
  const record = {
    streamVersion: "1",
    recordType: "snapshot-batch",
    snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    batchNumber: 0,
    offerCount: 1,
    uncompressedBytes: hashes.catalogBatchBytes(items),
    batchHash: catalogBatchHash(items),
    previousBatchHash: null,
    items,
  };
  // The shared Money scalar is signed; Catalog supplier prices are not.
  assert.equal(isAromaCatalogExportRecord(record), true);
  await assert.rejects(
    () => createCatalogImportStore({}).recordBatch(record),
    (error) => error.code === "INVALID_STREAM_SCHEMA",
  );
});

void test("reject accepts only closed durable codes even from untyped callers", async () => {
  const { createCatalogImportStore } =
    await import("../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js");
  const store = createCatalogImportStore({});
  for (const code of [
    "SECRET_SQL",
    "SNAPSHOT_NOT_FOUND",
    "TERMINAL_REPLAY_CONFLICT",
    "BATCH_REPLAY_CONFLICT",
  ]) {
    await assert.rejects(
      () => store.reject("snp_01ARZ3NDEKTSV4RRFFQ69G5FAV", code),
      (error) => error.code === "INVALID_FAILURE_CODE",
    );
  }
});

void test("TEMP table owner capability rejects runtime type injection", () => {
  assert.throws(
    () =>
      defineTemporaryTable({}, "safe_temp", [
        {
          name: "value",
          type: "integer); CREATE TABLE public.out_of_scope(x text); --",
        },
      ]),
    (error) => error?.code === "DB_INVALID_CONFIGURATION",
  );
});

void test("Compose recovery proof applies Catalog migrations before runtime startup", async () => {
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  for (const migration of [
    "0001_supplier_snapshots",
    "0002_snapshot_batches",
    "0003_snapshot_staging",
  ]) {
    assert.match(source, new RegExp(`"${migration}"`, "u"));
  }
  const migrations = source.indexOf("await applyCatalogMigrations(");
  const startup =
    source.match(
      /runTrackedRollbackCompose\(\s*"runtime-stack-up",\s*projectName,\s*secretsDir,\s*upArguments/u,
    )?.index ?? -1;
  assert.notEqual(
    migrations,
    -1,
    "recovery proof must apply Catalog migrations",
  );
  assert.notEqual(startup, -1, "tracked Compose startup boundary is missing");
  assert.ok(
    migrations < startup,
    "Catalog migrations must precede Compose runtime startup",
  );
});

void test("Compose Kafka recreation removes anonymous volumes from the replaced container", async () => {
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\["rm", "--force", "--stop", "--volumes", "kafka"\]/u,
    "Kafka recreation must remove anonymous image volumes while preserving the named log volume",
  );
});

void test("Compose recovery proof routes startup export only to the local provider fixture", async () => {
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /options\.aromaCartProof \|\| options\.recoveryProof/u,
    "recovery proof must attach the local provider fixture instead of real provider egress",
  );
  assert.match(
    source,
    /writeScopedComposeOverride\(projectName, \{[^}]*recoveryProof: options\.recoveryProof/u,
    "recovery proof flag must reach the generated Compose override",
  );
  assert.match(
    source,
    /network === "coffee_provider_egress" &&\s*\(options\.aromaCartProof \|\| options\.recoveryProof\)[\s\S]*?\? \["    internal: true"\]/u,
    "recovery provider network must be internal so public egress is impossible",
  );
  assert.match(
    source,
    /request\.method === "GET" && request\.url\?\.startsWith\("\/api\/v1\/catalog\/wholesale\/products\?"\)/u,
    "local provider fixture must handle Catalog startup traversal",
  );
  assert.match(
    source,
    /data: \[\], meta: \{current_page: page, total: 0, last_page: 1, per_page: perPage\}/u,
    "local Catalog fixture response must be a complete bounded empty page",
  );
  assert.match(
    source,
    /counts\.catalog \+= 1; await persist\(\)/u,
    "local fixture must persist observed Catalog requests",
  );
  assert.match(
    source,
    /assert\.ok\(\s*providerFixtureCalls\.catalog >= 1,\s*"recovery proof did not reach the local provider fixture for Catalog traversal",?\s*\)/u,
    "recovery proof must reject a run that did not reach the local Catalog fixture",
  );
  assert.match(
    source,
    /recoveryProof:[\s\S]*providerFixture: recoveryProviderFixtureCalls/u,
    "recovery evidence must report the observed local fixture call counts",
  );
});
