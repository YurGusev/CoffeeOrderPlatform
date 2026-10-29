import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  openBlackholeProxy,
  runLiveProof,
} from "../../scripts/db-live-proof.mjs";
import {
  createDatabase,
  withTransaction,
} from "../../packages/platform-database/dist/index.js";
import { defineStatement } from "../../packages/platform-database/dist/owner.js";
import {
  applyMigrations,
  migrationChecksum,
} from "../../packages/platform-migrations/dist/index.js";
import { GatewayMutationExecutor } from "../../apps/aroma-gateway/dist/domain/mutation-journal.js";
import { ProviderMutationJournalStore } from "../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js";

const MIGRATIONS = fileURLToPath(
  new URL("../../apps/aroma-gateway/migrations/", import.meta.url),
);
const TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
const CORRELATION = "11111111-1111-4111-8111-111111111111";

function request(number, operationKind = "SetLineQuantity") {
  const suffix = String(number).padStart(26, "0");
  return {
    operationRef: `op_${suffix}`,
    cartScopeRef: "aroma-primary",
    operationKind,
    offerRef: `off_${suffix}`,
    quantityMilli: operationKind === "SetLineQuantity" ? "3" : null,
  };
}

function acknowledgedBytes(requestValue) {
  return Buffer.from(
    JSON.stringify({
      operationRef: requestValue.operationRef,
      cartScopeRef: requestValue.cartScopeRef,
      offerRef: requestValue.offerRef,
      ...(requestValue.sourceGrindKeyHash === undefined
        ? {}
        : { sourceGrindKeyHash: requestValue.sourceGrindKeyHash }),
      state: "Acknowledged",
    }),
  );
}

const LIVE_POOL = {
  max: 3,
  checkoutTimeoutMs: 150,
  lockTimeoutMs: 3000,
  interactiveStatementTimeoutMs: 2000,
  backgroundStatementTimeoutMs: 2000,
  terminalTimeoutMs: 500,
  transactionTimeoutMs: 3000,
  idleTimeoutMs: 30000,
  maxLifetimeMs: 1800000,
};
const LIVE_RESERVATION_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function liveDatabase(owner, databaseName, role, password, port) {
  return createDatabase({
    owner,
    database: databaseName,
    allowedDatabase: databaseName,
    host: "127.0.0.1",
    port,
    user: role,
    password,
    pool: LIVE_POOL,
    shutdownGraceMs: 8000,
  });
}

function delegation(overrides = {}) {
  return {
    transportCaller: "api-internal",
    issuer: "api-internal",
    audience: "aroma-gateway",
    originalCaller: "aroma-convergence",
    operationId: "setAromaCartLineQuantity",
    callerIdentity: "api-internal",
    correlationId: CORRELATION,
    traceparent: TRACEPARENT,
    ...overrides,
  };
}

async function journalLiveProof({ port, roleMap, rolePasswords }) {
  const database = roleMap.databases.find(
    (entry) => entry.name === "coffee_platform_integration",
  );
  const runtime = database.runtimeRoles.find(
    (entry) => entry.runtime === "aroma-gateway",
  );
  let migrator;
  let direct;
  let unknownDatabase;
  let conflictingReserveDatabase;
  let terminalDatabase;
  let missingTerminalDatabase;
  let unknownProxy;
  let conflictingReserveProxy;
  let terminalProxy;
  let missingTerminalProxy;
  let proofStage = "bootstrap";
  try {
    proofStage = "apply-migrations";
    migrator = liveDatabase(
      "aroma-journal-live-migrator",
      database.name,
      database.migratorRole,
      rolePasswords[database.migratorRole],
      port,
    );
    await migrator.resource.start(AbortSignal.timeout(1000));
    const sql = await readFile(
      `${MIGRATIONS}/0002_provider_mutation_journal.sql`,
      "utf8",
    );
    const retentionSql = await readFile(
      `${MIGRATIONS}/0006_provider_mutation_retention.sql`,
      "utf8",
    );
    const grindSql = await readFile(
      `${MIGRATIONS}/0007_provider_mutation_grind.sql`,
      "utf8",
    );
    await applyMigrations(
      migrator,
      [
        {
          id: "0002_provider_mutation_journal",
          sql,
          checksum: migrationChecksum(sql),
        },
        {
          id: "0006_provider_mutation_retention",
          sql: retentionSql,
          checksum: migrationChecksum(retentionSql),
        },
        {
          id: "0007_provider_mutation_grind",
          sql: grindSql,
          checksum: migrationChecksum(grindSql),
        },
      ],
      {
        schema: "integration",
        ledgerTable: "platform_schema_migrations",
        lockKey: "issue10-mutation-journal",
      },
    );
    await migrator.resource.stop(AbortSignal.timeout(1000));

    direct = liveDatabase(
      "aroma-journal-live-direct",
      database.name,
      runtime.role,
      rolePasswords[runtime.role],
      port,
    );
    await direct.resource.start(AbortSignal.timeout(1000));
    const directStore = new ProviderMutationJournalStore(direct, {
      reservationOwner: LIVE_RESERVATION_OWNER,
      leaseMs: 30_000,
    });

    const takeoverRequest = {
      ...request(30),
      sourceGrindKeyHash: "c".repeat(64),
    };
    const shortLeaseStore = new ProviderMutationJournalStore(direct, {
      reservationOwner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      leaseMs: 5,
    });
    const initialTakeover = await shortLeaseStore.reserve(
      takeoverRequest,
      delegation(),
    );
    assert.equal(initialTakeover.kind, "Reserved");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const takeover = await directStore.reserve(takeoverRequest, delegation());
    assert.equal(takeover.kind, "Reserved");
    const takeoverRow = await directStore.get(takeoverRequest.operationRef);
    assert.equal(
      takeoverRow?.sourceGrindKeyHash,
      takeoverRequest.sourceGrindKeyHash,
    );
    const takeoverDispatch = await directStore.markDispatched(
      takeover.reservation,
    );
    assert.equal(takeoverDispatch.kind, "DispatchPermitted");
    let selectedProviderCalls = 1;
    const selectedAck = await directStore.acknowledge(takeoverDispatch.permit, {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: acknowledgedBytes(takeoverRequest),
    });
    assert.equal(selectedAck.state, "Acknowledged");
    const selectedReplay = await new GatewayMutationExecutor(
      directStore,
      async () => {
        selectedProviderCalls++;
        throw new Error("selected grind replay must not dispatch provider");
      },
    ).execute(takeoverRequest, delegation());
    assert.equal(selectedReplay.state, "Acknowledged");
    assert.equal(selectedReplay.replayed, true);
    assert.equal(
      Buffer.from(selectedReplay.responseBodyBytes).toString("hex"),
      Buffer.from(selectedAck.responseBodyBytes).toString("hex"),
    );
    assert.equal(selectedProviderCalls, 1);

    proofStage = "reserve-conflict-after-unknown-commit";
    const originalRequest = request(34);
    const conflictingRequest = {
      ...request(35),
      operationRef: originalRequest.operationRef,
      quantityMilli: "4",
    };
    conflictingReserveProxy = await openBlackholeProxy(port, "COMMIT", {
      dropCommandOnce: true,
      blockExtendedQuery: "SELECT OPERATION_REF",
    });
    assert.equal(typeof conflictingReserveProxy.waitForPeerClosed, "function");
    assert.equal(
      typeof conflictingReserveProxy.waitForQueryBlocked,
      "function",
    );
    assert.equal(
      typeof conflictingReserveProxy.releaseBlockedQuery,
      "function",
    );
    conflictingReserveDatabase = liveDatabase(
      "aroma-journal-live-reserve-conflict",
      database.name,
      runtime.role,
      rolePasswords[runtime.role],
      conflictingReserveProxy.port,
    );
    await conflictingReserveDatabase.resource.start(AbortSignal.timeout(1000));
    const closedPeersBeforeOriginalReserve =
      conflictingReserveProxy.closedPeers;
    const recoveringReserveStore = new ProviderMutationJournalStore(
      conflictingReserveDatabase,
      { reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000 },
    );
    let originalProviderMutatorCalls = 0;
    const originalPromise = new GatewayMutationExecutor(
      recoveringReserveStore,
      async () => {
        originalProviderMutatorCalls += 1;
        throw new Error(
          "original provider mutator must not run after reserve conflict",
        );
      },
    ).execute(originalRequest, delegation());
    const expectedConflict = assert.rejects(originalPromise, {
      code: "AROMA_OPERATION_REF_CONFLICT",
    });
    await conflictingReserveProxy.waitForCommand("COMMIT");
    await conflictingReserveProxy.waitForPeerClosed(
      closedPeersBeforeOriginalReserve,
    );
    await conflictingReserveProxy.waitForQueryBlocked();
    assert.equal(
      await directStore.get(originalRequest.operationRef),
      undefined,
    );
    let conflictingMutatorCalls = 0;
    const competingResult = await new GatewayMutationExecutor(
      directStore,
      async (requestValue) => {
        conflictingMutatorCalls += 1;
        return {
          state: "Acknowledged",
          statusCode: 200,
          responseBodyBytes: acknowledgedBytes(requestValue),
        };
      },
    ).execute(conflictingRequest, delegation());
    assert.equal(competingResult.state, "Acknowledged");
    assert.equal(competingResult.replayed, false);
    assert.equal(conflictingMutatorCalls, 1);
    const conflictingRow = await directStore.get(originalRequest.operationRef);
    assert.ok(conflictingRow);
    assert.notEqual(conflictingRow.offerRef, originalRequest.offerRef);
    assert.equal(conflictingRow.offerRef, conflictingRequest.offerRef);
    assert.equal(
      conflictingRow.quantityMilli,
      conflictingRequest.quantityMilli,
    );
    assert.equal(conflictingRow.state, "Acknowledged");
    conflictingReserveProxy.releaseBlockedQuery();
    await expectedConflict;
    assert.equal(originalProviderMutatorCalls, 0);

    proofStage = "dispatch-unknown-commit";
    const unknownRequest = request(31);
    const unknownReservation = await directStore.reserve(
      unknownRequest,
      delegation(),
    );
    assert.equal(unknownReservation.kind, "Reserved");
    unknownProxy = await openBlackholeProxy(port, "COMMIT", { dropOnce: true });
    unknownDatabase = liveDatabase(
      "aroma-journal-live-unknown",
      database.name,
      runtime.role,
      rolePasswords[runtime.role],
      unknownProxy.port,
    );
    await unknownDatabase.resource.start(AbortSignal.timeout(1000));
    const unknownStore = new ProviderMutationJournalStore(unknownDatabase, {
      reservationOwner: LIVE_RESERVATION_OWNER,
      leaseMs: 30_000,
    });
    const unknownDispatch = await unknownStore.markDispatched(
      unknownReservation.reservation,
    );
    await unknownProxy.waitForReplyDropped();
    assert.deepEqual(unknownDispatch, {
      kind: "UnknownOutcome",
      outcome: {
        state: "UnknownOutcome",
        failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN",
        replayed: true,
      },
    });
    const unknownRow = await directStore.get(unknownRequest.operationRef);
    assert.equal(unknownRow.state, "Dispatched");
    let unsafeDispatchCalls = 0;
    const safeUnknown = await new GatewayMutationExecutor(
      unknownStore,
      async () => {
        unsafeDispatchCalls++;
        throw new Error(
          "unsafe provider dispatch must not be repeated after unknown commit",
        );
      },
    ).execute(unknownRequest, delegation());
    assert.equal(safeUnknown.state, "UnknownOutcome");
    assert.equal(unsafeDispatchCalls, 0);

    proofStage = "terminal-commit-recovery";
    const terminalRequest = request(32);
    const terminalReservation = await directStore.reserve(
      terminalRequest,
      delegation(),
    );
    assert.equal(terminalReservation.kind, "Reserved");
    const terminalDispatch = await directStore.markDispatched(
      terminalReservation.reservation,
    );
    assert.equal(terminalDispatch.kind, "DispatchPermitted");
    terminalProxy = await openBlackholeProxy(port, "COMMIT", {
      dropOnce: true,
    });
    terminalDatabase = liveDatabase(
      "aroma-journal-live-terminal",
      database.name,
      runtime.role,
      rolePasswords[runtime.role],
      terminalProxy.port,
    );
    await terminalDatabase.resource.start(AbortSignal.timeout(1000));
    const terminalStore = new ProviderMutationJournalStore(terminalDatabase, {
      reservationOwner: LIVE_RESERVATION_OWNER,
      leaseMs: 30_000,
    });
    await assert.rejects(
      terminalStore.acknowledge(terminalDispatch.permit, {
        state: "Acknowledged",
        statusCode: 200,
        responseBodyBytes: Buffer.from("not JSON"),
      }),
      { code: "AROMA_MUTATION_INVALID" },
    );
    const nonTerminalRow = await directStore.get(terminalRequest.operationRef);
    assert.equal(nonTerminalRow.state, "Dispatched");
    const terminalBytes = acknowledgedBytes(terminalRequest);
    const recoveredTerminal = await terminalStore.acknowledge(
      terminalDispatch.permit,
      {
        state: "Acknowledged",
        statusCode: 200,
        responseBodyBytes: terminalBytes,
      },
    );
    await terminalProxy.waitForReplyDropped();
    assert.equal(recoveredTerminal.state, "Acknowledged");
    assert.equal(recoveredTerminal.replayed, true);
    assert.deepEqual(
      Buffer.from(recoveredTerminal.responseBodyBytes),
      terminalBytes,
    );
    const terminalRow = await directStore.get(terminalRequest.operationRef);
    assert.equal(terminalRow.state, "Acknowledged");
    let replayProviderCalls = 0;
    const replay = await new GatewayMutationExecutor(
      terminalStore,
      async () => {
        replayProviderCalls++;
        throw new Error("terminal replay must not dispatch the provider");
      },
    ).execute(terminalRequest, delegation());
    assert.equal(replay.state, "Acknowledged");
    assert.equal(replay.replayed, true);
    assert.equal(replayProviderCalls, 0);

    proofStage = "missing-terminal-recovery";
    const missingTerminalRequest = request(33);
    missingTerminalProxy = await openBlackholeProxy(port, "COMMIT", {
      dropCommandOnce: true,
      dropCommandAt: 3,
    });
    missingTerminalDatabase = liveDatabase(
      "aroma-journal-live-missing-terminal",
      database.name,
      runtime.role,
      rolePasswords[runtime.role],
      missingTerminalProxy.port,
    );
    await missingTerminalDatabase.resource.start(AbortSignal.timeout(1000));
    const missingTerminalStore = new ProviderMutationJournalStore(
      missingTerminalDatabase,
      { reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000 },
    );
    let missingTerminalMutatorCalls = 0;
    const missingTerminalExecutor = new GatewayMutationExecutor(
      missingTerminalStore,
      async (requestValue) => {
        missingTerminalMutatorCalls += 1;
        return {
          state: "Acknowledged",
          statusCode: 200,
          responseBodyBytes: acknowledgedBytes(requestValue),
        };
      },
    );
    const missingTerminalOutcome = await missingTerminalExecutor.execute(
      missingTerminalRequest,
      delegation(),
    );
    await missingTerminalProxy.waitForCommand("COMMIT");
    assert.deepEqual(missingTerminalOutcome, {
      state: "UnknownOutcome",
      failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN",
      replayed: true,
    });
    assert.equal(missingTerminalMutatorCalls, 1);
    const missingTerminalRow = await directStore.get(
      missingTerminalRequest.operationRef,
    );
    assert.equal(missingTerminalRow.state, "Dispatched");
    assert.equal(missingTerminalRow.responseStatus, null);
    const missingTerminalReplay = await new GatewayMutationExecutor(
      missingTerminalStore,
      async () => {
        missingTerminalMutatorCalls += 1;
        throw new Error(
          "unsafe provider dispatch must not repeat after missing terminal recovery",
        );
      },
    ).execute(missingTerminalRequest, delegation());
    assert.deepEqual(missingTerminalReplay, {
      state: "UnknownOutcome",
      failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN",
      replayed: true,
    });
    assert.equal(missingTerminalMutatorCalls, 1);

    proofStage = "retention-cleanup";
    const cleanupTerminalRequest = request(36);
    const cleanupTerminalReservation = await directStore.reserve(
      cleanupTerminalRequest,
      delegation(),
    );
    assert.equal(cleanupTerminalReservation.kind, "Reserved");
    const cleanupTerminalDispatch = await directStore.markDispatched(
      cleanupTerminalReservation.reservation,
    );
    assert.equal(cleanupTerminalDispatch.kind, "DispatchPermitted");
    await directStore.acknowledge(cleanupTerminalDispatch.permit, {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: acknowledgedBytes(cleanupTerminalRequest),
    });
    const cleanupReservedRequest = request(37);
    const cleanupReserved = await directStore.reserve(
      cleanupReservedRequest,
      delegation(),
    );
    assert.equal(cleanupReserved.kind, "Reserved");
    const ageRows = defineStatement(
      direct,
      `UPDATE integration.provider_mutation_journal
      SET created_at = clock_timestamp() - INTERVAL '91 days',
          retention_until = clock_timestamp() - INTERVAL '1 day',
          completed_at = CASE WHEN operation_ref = $1 THEN clock_timestamp() - INTERVAL '91 days' ELSE completed_at END
      WHERE operation_ref IN ($1, $2)`,
    );
    await withTransaction(direct, { mode: "background" }, (transaction) =>
      ageRows(transaction, [
        cleanupTerminalRequest.operationRef,
        cleanupReservedRequest.operationRef,
      ]),
    );
    assert.equal(await directStore.cleanupTerminal(1), 1);
    assert.equal(
      await directStore.get(cleanupTerminalRequest.operationRef),
      undefined,
    );
    const retainedReserved = await directStore.get(
      cleanupReservedRequest.operationRef,
    );
    assert.ok(retainedReserved);
    assert.equal(retainedReserved.state, "Reserved");
    assert.equal(await directStore.cleanupTerminal(100), 0);

    return {
      migration: "0007_provider_mutation_grind",
      expiredReservationTakeoverWithGrind: true,
      reserveConflictAfterUnknownCommit: true,
      conflictingRow: "Acknowledged",
      conflictingMutatorCalls,
      originalProviderMutatorCalls,
      terminalCommitReplay: true,
      terminalRow: "Acknowledged",
      unknownCommitWithoutTerminal: true,
      unknownRow: "Dispatched",
      terminalCommitWithoutTerminal: true,
      missingTerminalRow: "Dispatched",
      missingTerminalMutatorCalls,
      cleanupTerminalVsReserved: true,
      unsafeDispatchCalls,
      replayProviderCalls,
    };
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    const sqlState =
      error &&
      typeof error === "object" &&
      "sqlState" in error &&
      typeof error.sqlState === "string"
        ? error.sqlState
        : "none";
    throw new Error(
      `journal-live-proof stage=${proofStage} code=${code} sqlState=${sqlState}`,
    );
  } finally {
    await Promise.allSettled([
      conflictingReserveProxy?.close(),
      unknownProxy?.close(),
      terminalProxy?.close(),
      missingTerminalProxy?.close(),
    ]);
    for (const databaseHandle of [
      missingTerminalDatabase,
      terminalDatabase,
      unknownDatabase,
      conflictingReserveDatabase,
      direct,
      migrator,
    ])
      databaseHandle?.resource.destroy();
  }
}

void test(
  "LIVE: ProviderMutationJournalStore recovers unknown COMMIT without unsafe redispatch",
  { skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" },
  async () => {
    const result = await runLiveProof({
      runId: `issue10journal${Date.now().toString(36)}`,
      bindingProof: journalLiveProof,
    });
    assert.deepEqual(result.binding, {
      migration: "0007_provider_mutation_grind",
      expiredReservationTakeoverWithGrind: true,
      reserveConflictAfterUnknownCommit: true,
      conflictingRow: "Acknowledged",
      conflictingMutatorCalls: 1,
      originalProviderMutatorCalls: 0,
      terminalCommitReplay: true,
      terminalRow: "Acknowledged",
      unknownCommitWithoutTerminal: true,
      unknownRow: "Dispatched",
      terminalCommitWithoutTerminal: true,
      missingTerminalRow: "Dispatched",
      missingTerminalMutatorCalls: 1,
      cleanupTerminalVsReserved: true,
      unsafeDispatchCalls: 0,
      replayProviderCalls: 0,
    });
    assert.equal(result.cleanup.containerRemoved, true);
  },
);

void test("production composition mounts the typed mutation bridge without a test fallback", async () => {
  const main = await readFile(
    fileURLToPath(
      new URL("../../apps/aroma-gateway/src/main.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.match(main, /registerAromaBindingRoutes/);
  assert.match(main, /registerAromaMutationRoutes/);
  assert.match(main, /GatewayMutationExecutor/);
  assert.match(main, /ProviderMutationJournalStore/);
  assert.match(main, /ProviderCartMutator/);
  assert.doesNotMatch(main, /TestOnlyUnsafeProviderMutator/);
});

void test("journal migration is ordered, Integration-owned, constrained, and does not define provider/session payload storage", async () => {
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(files, [
    "0001_provider_sessions.sql",
    "0002_provider_mutation_journal.sql",
    "0003_offer_bindings.sql",
    "0004_provider_offer_identity.sql",
    "0005_catalog_export_attempts.sql",
    "0006_provider_mutation_retention.sql",
    "0007_provider_mutation_grind.sql",
  ]);
  const sessionSql = await readFile(
    `${MIGRATIONS}/0001_provider_sessions.sql`,
    "utf8",
  );
  assert.match(sessionSql, /CREATE TABLE integration\.provider_sessions/);
  assert.match(sessionSql, /encrypted_cookie_material bytea/);
  assert.match(
    sessionSql,
    /ON TABLE integration\.provider_sessions TO coffee_aroma_gateway_rw/,
  );
  assert.doesNotMatch(
    sessionSql,
    /password|plaintext|provider_body|request_body|PII/i,
  );
  const sql = await readFile(
    `${MIGRATIONS}/0002_provider_mutation_journal.sql`,
    "utf8",
  );
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS integration/);
  assert.match(sql, /CREATE TABLE integration\.provider_mutation_journal/);
  assert.match(
    sql,
    /state IN \('Reserved', 'Dispatched', 'Acknowledged', 'Rejected', 'UnknownOutcome'\)/,
  );
  assert.match(
    sql,
    /ON TABLE integration\.provider_mutation_journal TO coffee_aroma_gateway_rw/,
  );
  assert.match(sql, /response_body_bytes bytea/);
  assert.match(sql, /CHECK \(quantity_milli IS NULL OR quantity_milli > 0\)/);
  assert.match(
    sql,
    /operation_kind = 'SetLineQuantity' AND quantity_milli IS NOT NULL/,
  );
  assert.doesNotMatch(
    sql,
    /password|cookie|secret|provider_body|request_body|plaintext|PII/i,
  );
  const retentionSql = await readFile(
    `${MIGRATIONS}/0006_provider_mutation_retention.sql`,
    "utf8",
  );
  assert.match(
    retentionSql,
    /SET retention_until = COALESCE\(completed_at, created_at\) \+ INTERVAL '90 days'/,
  );
  assert.match(
    retentionSql,
    /SET DEFAULT \(CURRENT_TIMESTAMP \+ INTERVAL '90 days'\)/,
  );
  assert.match(retentionSql, /ALTER COLUMN retention_until SET NOT NULL/);
  assert.match(
    retentionSql,
    /state IN \('Acknowledged', 'Rejected', 'UnknownOutcome'\)/,
  );
  assert.match(
    retentionSql,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE integration\.provider_mutation_journal/,
  );
  const grindSql = await readFile(
    `${MIGRATIONS}/0007_provider_mutation_grind.sql`,
    "utf8",
  );
  assert.match(grindSql, /source_grind_key_hash/);
  const storeSql = await readFile(
    fileURLToPath(
      new URL(
        "../../apps/aroma-gateway/src/infrastructure/database/provider-mutation-journal.ts",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  assert.match(storeSql, /cleanupTerminal/);
  assert.match(storeSql, /DELETE FROM integration\.provider_mutation_journal/);
  assert.match(storeSql, /FOR UPDATE SKIP LOCKED/);
  assert.equal(
    (
      storeSql.match(
        /retention_until = clock_timestamp\(\) \+ INTERVAL '90 days'/g,
      ) ?? []
    ).length,
    5,
  );
  assert.doesNotMatch(storeSql, /\borders\b|orders_/i);
  const composeSmoke = await readFile(
    fileURLToPath(new URL("../../tools/compose-smoke.mjs", import.meta.url)),
    "utf8",
  );
  assert.match(composeSmoke, /"0006_provider_mutation_retention"/);
});
