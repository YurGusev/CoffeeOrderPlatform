import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import pg from "pg";
import {runLiveProof} from "../../scripts/db-live-proof.mjs";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {defineStatement} from "../../packages/platform-database/dist/owner.js";
import {applyMigrations, migrationChecksum} from "../../packages/platform-migrations/dist/index.js";
import {OfferBindingRepository, OfferBindingStore} from "../../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";

const {Client} = pg;
const SCHEME = "hmac-sha256-v1";
const pool = {max: 4, checkoutTimeoutMs: 150, lockTimeoutMs: 3000, interactiveStatementTimeoutMs: 2000, backgroundStatementTimeoutMs: 2000, terminalTimeoutMs: 500, transactionTimeoutMs: 3000, idleTimeoutMs: 30000, maxLifetimeMs: 1800000};
const id = (prefix, n) => `${prefix}_${String(n).padStart(26, "0")}`;
const hash = (n) => String(n).padStart(64, "0");
const req = (offerRef, supplierRef, snapshotRef, sourceOfferKeyHash) => ({offerRef, supplierRef, snapshotRef, sourceIdentityScheme: SCHEME, sourceOfferKeyHash});
const errorCode = async (promise) => { try { await promise; return undefined; } catch (error) { return error?.code; } };

async function proof({adminUrl, port, roleMap, rolePasswords}) {
  const database = roleMap.databases.find((entry) => entry.name === "coffee_platform_integration");
  const runtime = database.runtimeRoles.find((entry) => entry.runtime === "aroma-gateway");
  let migrator;
  let a;
  let b;
  let restarted;
  let admin;
  try {
    migrator = createDatabase({owner: "issue10-binding-migrator", database: database.name, allowedDatabase: database.name, host: "127.0.0.1", port, user: database.migratorRole, password: rolePasswords[database.migratorRole], pool, shutdownGraceMs: 8000});
  const runtimeDb = (owner) => createDatabase({owner, database: database.name, allowedDatabase: database.name, host: "127.0.0.1", port, user: runtime.role, password: rolePasswords[runtime.role], pool, shutdownGraceMs: 8000});
  const bindingSql = await readFile(resolve("apps/aroma-gateway/migrations/0003_offer_bindings.sql"), "utf8");
  const identitySql = await readFile(resolve("apps/aroma-gateway/migrations/0004_provider_offer_identity.sql"), "utf8");
  await migrator.resource.start(AbortSignal.timeout(1000));
  await applyMigrations(migrator, [
    {id: "0003_offer_bindings", sql: bindingSql, checksum: migrationChecksum(bindingSql)},
    {id: "0004_provider_offer_identity", sql: identitySql, checksum: migrationChecksum(identitySql)},
  ], {schema: "integration", ledgerTable: "platform_schema_migrations", lockKey: "issue10-binding"});
  await migrator.resource.stop(AbortSignal.timeout(1000));
  a = runtimeDb("issue10-binding-a");
  b = runtimeDb("issue10-binding-b");
  await Promise.all([a.resource.start(AbortSignal.timeout(1000)), b.resource.start(AbortSignal.timeout(1000))]);
  const storeA = new OfferBindingStore(a);
  const storeB = new OfferBindingStore(b);
  const supplier = id("sup", 1), foreignSupplier = id("sup", 2);
  const snapshot1 = id("snp", 1), snapshot2 = id("snp", 2), incomplete = id("snp", 3);
  const source1 = hash(1), source2 = hash(2), source3 = hash(3), source4 = hash(4), source5 = hash(5);
  const offer1 = id("off", 1), offer2 = id("off", 2), offer3 = id("off", 3), offer4 = id("off", 4), offer5 = id("off", 5);
  const raw1 = "provider-raw-canary-1";
  const setup = async (store, snapshot, identities, complete = true, supplierRef = supplier) => {
    await store.beginExport(snapshot, supplierRef);
    const completeIdentities = identities.map((identity) => ({...identity, rawProviderProductId: identity.rawProviderProductId ?? identity.rawProviderOfferId, rawProviderVariantId: identity.rawProviderVariantId ?? identity.rawProviderOfferId}));
    if (completeIdentities.length) await store.recordBatch(snapshot, supplierRef, completeIdentities);
    if (complete) await store.completeExport(snapshot, hash(Number(snapshot.slice(-1)) + 100));
  };
  await setup(storeA, snapshot1, [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source1, rawProviderOfferId: raw1}, {supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source2, rawProviderOfferId: "provider-raw-2"}]);
  const snapshot1Hash = hash(101);
  await storeA.completeExport(snapshot1, snapshot1Hash);
  assert.equal(await errorCode(storeA.completeExport(snapshot1, hash(999))), "AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  await setup(storeA, snapshot2, [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source1, rawProviderOfferId: raw1}]);
  await setup(storeA, incomplete, [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source3, rawProviderOfferId: "provider-raw-3"}], false);
  const first = await storeA.register(req(offer1, supplier, snapshot1, source1));
  assert.equal(first.firstSnapshotRef, snapshot1);
  assert.deepEqual(await storeA.register(req(offer1, supplier, snapshot2, source1)), first);
  assert.equal(await errorCode(storeA.register(req(id("off", 9), supplier, snapshot1, hash(9)))), "AROMA_BINDING_SOURCE_NOT_FOUND");
  assert.equal(await errorCode(storeA.register(req(id("off", 10), supplier, snapshot2, source2))), "AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  assert.equal(await errorCode(storeA.register(req(id("off", 11), supplier, incomplete, source3))), "AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  assert.equal(await errorCode(storeA.register(req(id("off", 12), foreignSupplier, snapshot1, source1))), "AROMA_BINDING_SOURCE_NOT_FOUND");
  assert.equal(await errorCode(storeA.register({...req(id("off", 13), supplier, snapshot1, source1), sourceIdentityScheme: "bad-scheme"})), "AROMA_BINDING_CONFLICT");
  assert.equal(await errorCode(storeA.register(req(offer1, supplier, snapshot1, source2))), "AROMA_BINDING_CONFLICT");
  assert.equal(await errorCode(storeA.register(req(offer2, supplier, snapshot1, source1))), "AROMA_BINDING_CONFLICT");
  await setup(storeA, id("snp", 4), [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source3, rawProviderOfferId: "provider-raw-3"}, {supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source4, rawProviderOfferId: "provider-raw-4"}, {supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: source5, rawProviderOfferId: "provider-raw-5"}]);
  const identityConflictSnapshot = id("snp", 7);
  const sourceIdentity = (n, facts = {}) => ({supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: hash(n), rawProviderOfferId: `provider-identity-${n}`, rawProviderProductId: `provider-product-${n}`, rawProviderVariantId: `provider-variant-${n}`, ...facts});
  const identityBases = [
    sourceIdentity(10, {packing: "bag", grindId: "fine"}),
    sourceIdentity(11, {packing: "bag", grindId: "fine"}),
    sourceIdentity(12, {packing: "bag", grindId: "fine"}),
    sourceIdentity(13, {packing: "bag", grindId: "fine"}),
    sourceIdentity(14),
    sourceIdentity(15, {packing: null, grindId: null}),
  ];
  await setup(storeA, identityConflictSnapshot, identityBases);
  const identityConflictReplaySnapshot = id("snp", 8);
  await storeA.beginExport(identityConflictReplaySnapshot, supplier);
  await storeA.recordBatch(identityConflictReplaySnapshot, supplier, identityBases);
  const absentToNull = {...identityBases[4], packing: null, grindId: null};
  const nullToAbsent = {...identityBases[5]};
  delete nullToAbsent.packing;
  delete nullToAbsent.grindId;
  const identityConflicts = [
    {...identityBases[0], rawProviderProductId: "provider-product-drift"},
    {...identityBases[1], rawProviderVariantId: "provider-variant-drift"},
    {...identityBases[2], packing: "box"},
    {...identityBases[3], grindId: "coarse"},
    absentToNull,
    nullToAbsent,
  ];
  for (const conflict of identityConflicts) assert.equal(await errorCode(storeA.recordBatch(identityConflictReplaySnapshot, supplier, [conflict])), "AROMA_BINDING_CONFLICT");
  await storeA.completeExport(identityConflictReplaySnapshot, hash(108));
  await storeA.register(req(id("off", 6), supplier, identityConflictReplaySnapshot, hash(14)));
  await storeA.register(req(id("off", 7), supplier, identityConflictReplaySnapshot, hash(15)));
  const absentFacts = await storeA.resolveProviderOffer(id("off", 6), supplier);
  const nullFacts = await storeA.resolveProviderOffer(id("off", 7), supplier);
  assert.equal(absentFacts?.packing, undefined);
  assert.equal(absentFacts?.grindId, undefined);
  assert.equal(Object.hasOwn(absentFacts ?? {}, "packing"), false);
  assert.equal(Object.hasOwn(absentFacts ?? {}, "grindId"), false);
  assert.equal(nullFacts?.packing, null);
  assert.equal(nullFacts?.grindId, null);
  assert.equal(Object.hasOwn(nullFacts ?? {}, "packing"), true);
  assert.equal(Object.hasOwn(nullFacts ?? {}, "grindId"), true);
  admin = new Client({connectionString: adminUrl.replace(/\/postgres$/, `/${database.name}`), connectionTimeoutMillis: 1000});
  await admin.connect();
  const waitForLock = async (applicationName) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND state = 'active' LIMIT 1", [applicationName]);
      if (result.rowCount === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`expected ${applicationName} to wait for export row lock`);
  };
  const repositoryA = new OfferBindingRepository(a);
  const lockExportRow = defineStatement(a, "SELECT snapshot_ref FROM integration.provider_catalog_exports WHERE snapshot_ref = $1 FOR UPDATE");
  const snapshotRace = id("snp", 5), sourceRace = hash(6), rawRace = "provider-raw-race-6";
  await storeA.beginExport(snapshotRace, supplier);
  let releaseBatch;
  const batchHeld = new Promise((resolve) => { releaseBatch = resolve; });
  let batchLockReadyResolve;
  let batchLockReadyReject;
  const batchLockReady = new Promise((resolve, reject) => { batchLockReadyResolve = resolve; batchLockReadyReject = reject; });
  let batchAError;
  const batchA = withTransaction(a, {mode: "interactive"}, async (transaction) => {
    await lockExportRow(transaction, [snapshotRace]);
    batchLockReadyResolve();
    await repositoryA.recordBatch(transaction, snapshotRace, supplier, [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: sourceRace, rawProviderOfferId: rawRace, rawProviderProductId: "provider-product-race-6", rawProviderVariantId: "provider-variant-race-6"}]);
    await batchHeld;
  }).catch((error) => { batchLockReadyReject(error); batchAError = error; });
  let completeBError;
  let completeB;
  try {
    await batchLockReady;
    completeB = storeB.completeExport(snapshotRace, hash(105)).catch((error) => { completeBError = error; });
    await waitForLock("issue10-binding-b");
  } finally {
    releaseBatch();
    await Promise.allSettled([batchA, completeB]);
  }
  await batchA;
  assert.equal(batchAError, undefined);
  await completeB;
  assert.equal(completeBError, undefined);
  const snapshotReverse = id("snp", 6), sourceReverse = hash(7);
  await storeA.beginExport(snapshotReverse, supplier);
  let releaseComplete;
  const completeHeld = new Promise((resolve) => { releaseComplete = resolve; });
  let completeLockReadyResolve;
  let completeLockReadyReject;
  const completeLockReady = new Promise((resolve, reject) => { completeLockReadyResolve = resolve; completeLockReadyReject = reject; });
  let completeAError;
  const completeA = withTransaction(a, {mode: "interactive"}, async (transaction) => {
    await lockExportRow(transaction, [snapshotReverse]);
    completeLockReadyResolve();
    await repositoryA.completeExport(transaction, snapshotReverse, hash(106));
    await completeHeld;
  }).catch((error) => { completeLockReadyReject(error); completeAError = error; });
  let batchB;
  try {
    await completeLockReady;
    batchB = storeB.recordBatch(snapshotReverse, supplier, [{supplierRef: supplier, sourceIdentityScheme: SCHEME, sourceOfferKeyHash: sourceReverse, rawProviderOfferId: "provider-raw-race-7", rawProviderProductId: "provider-product-race-7", rawProviderVariantId: "provider-variant-race-7"}]);
    await waitForLock("issue10-binding-b");
  } finally {
    releaseComplete();
    await Promise.allSettled([completeA, batchB]);
  }
  await completeA;
  assert.equal(completeAError, undefined);
  assert.equal(await errorCode(batchB), "AROMA_BINDING_SNAPSHOT_INCOMPLETE");
  const same = await Promise.all([storeA.register(req(offer3, supplier, id("snp", 4), source3)), storeB.register(req(offer3, supplier, id("snp", 4), source3))]);
  assert.deepEqual(same[0], same[1]);
  const race = await Promise.all([storeA.register(req(offer4, supplier, id("snp", 4), source4)).then(() => "bound", (e) => e.code), storeB.register(req(offer4, supplier, id("snp", 4), source3)).then(() => "bound", (e) => e.code)]);
  assert.equal(race.filter((value) => value === "bound").length, 1);
  assert.equal(race.filter((value) => value === "AROMA_BINDING_CONFLICT").length, 1);
  const lost = await storeA.register(req(offer5, supplier, id("snp", 4), source5));
  assert.deepEqual(await storeB.register(req(offer5, supplier, id("snp", 4), source5)), lost);
  await a.resource.stop(AbortSignal.timeout(1000));
  restarted = runtimeDb("issue10-binding-restart");
  await restarted.resource.start(AbortSignal.timeout(1000));
  const restartStore = new OfferBindingStore(restarted);
  assert.deepEqual(await restartStore.register(req(offer1, supplier, snapshot2, source1)), first);
  assert.deepEqual(await restartStore.resolve(supplier, source1), first);
  assert.equal(await restartStore.resolve(foreignSupplier, source1), undefined);
  assert.equal((await restartStore.resolve(supplier, hash(99))), undefined);
  const raw = await admin.query("SELECT raw_provider_offer_id FROM integration.provider_source_offers WHERE source_offer_key_hash = $1", [source1]);
  assert.equal(raw.rows[0].raw_provider_offer_id, raw1);
  for (const table of ["provider_source_offers", "provider_export_offers", "provider_offer_bindings"]) {
    const privileges = await admin.query(`SELECT has_table_privilege($1, 'integration.${table}', 'UPDATE') AS update, has_table_privilege($1, 'integration.${table}', 'DELETE') AS delete`, [runtime.role]);
    assert.equal(privileges.rows[0].update, false, `${table} UPDATE must be denied`);
    assert.equal(privileges.rows[0].delete, false, `${table} DELETE must be denied`);
  }
  const exportPrivileges = await admin.query("SELECT has_table_privilege($1, 'integration.provider_catalog_exports', 'UPDATE') AS update", [runtime.role]);
  assert.equal(exportPrivileges.rows[0].update, true);
  const completedCheck = await admin.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'integration.provider_catalog_exports'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%state%Completed%content_hash%'");
  assert.equal(completedCheck.rowCount, 1, "Completed export must require content_hash");
  await admin.end();
  await Promise.all([b.resource.stop(AbortSignal.timeout(1000)), restarted.resource.stop(AbortSignal.timeout(1000))]);
  return {migration: "0003_offer_bindings", registered: 5, negativeCases: 6, identityConflictCases: identityConflicts.length, concurrentSamePair: "one-binding", conflictingRace: "one-winner", restartReplay: true, lostAnswerReplay: true, rawIdRetained: true, unresolvedSupplierReturnsUndefined: true, rawId: undefined};
  } finally {
    await Promise.allSettled([admin?.end()]);
    for (const databaseHandle of [migrator, a, b, restarted]) databaseHandle?.resource.destroy();
  }
}

void test("issue 10 binding store: PostgreSQL idempotency, races, restart and grants", async () => {
  const result = await runLiveProof({runId: `issue10${Date.now().toString(36)}`, bindingProof: proof});
  assert.equal(result.binding.concurrentSamePair, "one-binding");
  assert.equal(result.binding.identityConflictCases, 6);
  assert.equal(result.binding.rawId, undefined);
});
