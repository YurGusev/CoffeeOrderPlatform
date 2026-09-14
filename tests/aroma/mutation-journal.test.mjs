import assert from "node:assert/strict";
import {readFile, readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {openBlackholeProxy, runLiveProof} from "../../scripts/db-live-proof.mjs";
import {isAromaProblem} from "../../packages/contracts/aroma-v1/dist/index.js";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {applyMigrations, migrationChecksum} from "../../packages/platform-migrations/dist/index.js";
import {
  GatewayMutationExecutor,
  canonicalMutationRequest,
  canonicalMutationRequestHash,
  typedResponseHash,
} from "../../apps/aroma-gateway/dist/domain/mutation-journal.js";
import {ProviderMutationJournalStore} from "../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js";
import {ProviderCartMutator} from "../../apps/aroma-gateway/dist/application/provider-cart-mutator.js";

const MIGRATIONS = fileURLToPath(new URL("../../apps/aroma-gateway/migrations/", import.meta.url));
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
  return Buffer.from(JSON.stringify({
    operationRef: requestValue.operationRef,
    cartScopeRef: requestValue.cartScopeRef,
    offerRef: requestValue.offerRef,
    state: "Acknowledged",
  }));
}

const ACK_BYTES = acknowledgedBytes(request(3));
const rejectionBody = Object.freeze({
  type: "about:blank",
  title: "AROMA_PROVIDER_REJECTED",
  status: 409,
  code: "AROMA_PROVIDER_REJECTED",
  detail: "The typed gateway mutation was rejected.",
  instance: "/api/internal-v1/aroma/cart-lines",
  correlationId: CORRELATION,
  errors: [],
});
const rejectionBytes = (overrides = {}) => Buffer.from(JSON.stringify({...rejectionBody, ...overrides}));
const REJECT_BYTES = rejectionBytes();
const LIVE_POOL = {max: 3, checkoutTimeoutMs: 150, lockTimeoutMs: 3000, interactiveStatementTimeoutMs: 2000, backgroundStatementTimeoutMs: 2000, terminalTimeoutMs: 500, transactionTimeoutMs: 3000, idleTimeoutMs: 30000, maxLifetimeMs: 1800000};
const LIVE_RESERVATION_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function liveDatabase(owner, databaseName, role, password, port) {
  return createDatabase({owner, database: databaseName, allowedDatabase: databaseName, host: "127.0.0.1", port, user: role, password, pool: LIVE_POOL, shutdownGraceMs: 8000});
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

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function terminal(record, replayed) {
  const result = {
    state: record.state,
    statusCode: record.statusCode,
    responseBodyBytes: new Uint8Array(record.responseBodyBytes),
    replayed,
  };
  if (record.failureCode !== undefined) result.failureCode = record.failureCode;
  return result;
}

function unknown(record, replayed) {
  return {state: "UnknownOutcome", failureCode: record.failureCode ?? "AROMA_PROVIDER_OUTCOME_UNKNOWN", replayed};
}

class SharedJournal {
  constructor() {
    this.records = new Map();
    this.events = [];
    this.reserveCalls = 0;
    this.acceptedReservations = 0;
    this.dispatchCalls = 0;
  }
}

class MemoryJournal {
  constructor(shared, reservationOwner, leaseMs = 30_000) {
    this.shared = shared;
    this.reservationOwner = reservationOwner;
    this.leaseMs = leaseMs;
  }

  async reserve(requestValue, delegationValue) {
    this.shared.reserveCalls++;
    const hash = canonicalMutationRequestHash(requestValue, delegationValue);
    const key = canonicalMutationRequest(requestValue, delegationValue);
    let record = this.shared.records.get(requestValue.operationRef);
    if (record === undefined) {
      record = {
        operationRef: requestValue.operationRef,
        requestHash: hash,
        requestKey: key,
        state: "Reserved",
        reservationOwner: this.reservationOwner,
        leaseUntil: Date.now() + this.leaseMs,
        dispatchedAt: undefined,
        responseBodyBytes: undefined,
        statusCode: undefined,
        failureCode: undefined,
      };
      this.shared.records.set(requestValue.operationRef, record);
      this.shared.acceptedReservations++;
      this.shared.events.push("reserved-committed");
      return {kind: "Reserved", reservation: this.reservation(record)};
    }
    if (record.requestHash !== hash || record.requestKey !== key) throw codedError("AROMA_OPERATION_REF_CONFLICT");
    if (record.state === "Acknowledged" || record.state === "Rejected") return {kind: "Replay", outcome: terminal(record, true)};
    if (record.state === "UnknownOutcome" || record.state === "Dispatched") return {kind: "UnknownOutcome", outcome: unknown(record, true)};
    if (record.leaseUntil <= Date.now()) {
      record.reservationOwner = this.reservationOwner;
      record.leaseUntil = Date.now() + this.leaseMs;
      this.shared.acceptedReservations++;
      this.shared.events.push("reserved-takeover-committed");
      return {kind: "Reserved", reservation: this.reservation(record)};
    }
    return {kind: "InProgress", state: "Reserved", operationRef: record.operationRef};
  }

  async markDispatched(reservationValue) {
    this.shared.dispatchCalls++;
    const record = this.shared.records.get(reservationValue.operationRef);
    if (record === undefined) throw codedError("AROMA_JOURNAL_CORRUPT");
    if (record.requestHash !== reservationValue.requestHash || record.reservationOwner !== reservationValue.reservationOwner) {
      throw codedError("AROMA_RESERVATION_LOST");
    }
    if (record.state === "Reserved" && record.leaseUntil > Date.now()) {
      record.state = "Dispatched";
      record.dispatchedAt = Date.now();
      this.shared.events.push("dispatched-committed");
      return {kind: "DispatchPermitted", permit: this.permit(record)};
    }
    if (record.state === "Acknowledged" || record.state === "Rejected") return {kind: "Replay", outcome: terminal(record, true)};
    if (record.state === "UnknownOutcome" || record.state === "Dispatched") return {kind: "UnknownOutcome", outcome: unknown(record, true)};
    return {kind: "InProgress", state: "Reserved", operationRef: record.operationRef};
  }

  async rejectReservation(reservationValue, result) {
    const record = this.current(reservationValue);
    if (record.state === "Acknowledged" || record.state === "Rejected") return terminal(record, true);
    if (record.state !== "Reserved") throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Rejected";
    record.statusCode = result.statusCode;
    record.failureCode = result.failureCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    this.shared.events.push("rejected-before-dispatch");
    return terminal(record, false);
  }

  async acknowledge(permitValue, result) {
    const record = this.current(permitValue);
    if (record.state === "Acknowledged" || record.state === "Rejected") return terminal(record, true);
    if (record.state !== "Dispatched") throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Acknowledged";
    record.statusCode = result.statusCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    return terminal(record, false);
  }

  async reject(permitValue, result) {
    const record = this.current(permitValue);
    if (record.state === "Acknowledged" || record.state === "Rejected") return terminal(record, true);
    if (record.state !== "Dispatched") throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Rejected";
    record.statusCode = result.statusCode;
    record.failureCode = result.failureCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    return terminal(record, false);
  }

  async markUnknown(permitValue, failureCode) {
    const record = this.current(permitValue);
    if (record.state === "UnknownOutcome") return unknown(record, true);
    if (record.state === "Acknowledged" || record.state === "Rejected") return terminal(record, true);
    if (record.state !== "Dispatched") throw codedError("AROMA_RESERVATION_LOST");
    record.state = "UnknownOutcome";
    record.failureCode = failureCode;
    record.completedAt = Date.now();
    return unknown(record, false);
  }

  async recoverAfterRestart(cutoff = Date.now()) {
    let recovered = 0;
    for (const record of this.shared.records.values()) {
      if (record.state === "Dispatched" && record.dispatchedAt < cutoff) {
        record.state = "UnknownOutcome";
        record.failureCode = "AROMA_PROVIDER_OUTCOME_UNKNOWN";
        record.completedAt = Date.now();
        recovered++;
      }
    }
    return recovered;
  }

  reservation(record) {
    return {
      operationRef: record.operationRef,
      requestHash: record.requestHash,
      reservationOwner: record.reservationOwner,
      leaseUntil: new Date(record.leaseUntil).toISOString(),
    };
  }

  permit(record) {
    return {
      operationRef: record.operationRef,
      requestHash: record.requestHash,
      reservationOwner: record.reservationOwner,
    };
  }

  current(permitValue) {
    const record = this.shared.records.get(permitValue.operationRef);
    if (record === undefined || record.requestHash !== permitValue.requestHash || record.reservationOwner !== permitValue.reservationOwner) throw codedError("AROMA_RESERVATION_LOST");
    return record;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for test seam");
}

function acknowledgeMutator(shared, calls, bytes) {
  return async (requestValue, _permit, _signal) => {
    calls.value++;
    assert.equal(shared.events.at(-1), "dispatched-committed");
    return {state: "Acknowledged", statusCode: 200, responseBodyBytes: bytes ?? acknowledgedBytes(requestValue)};
  };
}

async function journalLiveProof({port, roleMap, rolePasswords}) {
  const database = roleMap.databases.find((entry) => entry.name === "coffee_platform_integration");
  const runtime = database.runtimeRoles.find((entry) => entry.runtime === "aroma-gateway");
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
  try {
    migrator = liveDatabase("aroma-journal-live-migrator", database.name, database.migratorRole, rolePasswords[database.migratorRole], port);
    await migrator.resource.start(AbortSignal.timeout(1000));
    const sql = await readFile(`${MIGRATIONS}/0002_provider_mutation_journal.sql`, "utf8");
    await applyMigrations(migrator, [{id: "0002_provider_mutation_journal", sql, checksum: migrationChecksum(sql)}], {schema: "integration", ledgerTable: "platform_schema_migrations", lockKey: "issue10-mutation-journal"});
    await migrator.resource.stop(AbortSignal.timeout(1000));

    direct = liveDatabase("aroma-journal-live-direct", database.name, runtime.role, rolePasswords[runtime.role], port);
    await direct.resource.start(AbortSignal.timeout(1000));
    const directStore = new ProviderMutationJournalStore(direct, {reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000});

    const originalRequest = request(34);
    const conflictingRequest = {...request(35), operationRef: originalRequest.operationRef, quantityMilli: "4"};
    conflictingReserveProxy = await openBlackholeProxy(port, "COMMIT", {
      dropCommandOnce: true,
      blockExtendedQuery: "SELECT OPERATION_REF",
    });
    assert.equal(typeof conflictingReserveProxy.waitForPeerClosed, "function");
    assert.equal(typeof conflictingReserveProxy.waitForQueryBlocked, "function");
    assert.equal(typeof conflictingReserveProxy.releaseBlockedQuery, "function");
    conflictingReserveDatabase = liveDatabase("aroma-journal-live-reserve-conflict", database.name, runtime.role, rolePasswords[runtime.role], conflictingReserveProxy.port);
    await conflictingReserveDatabase.resource.start(AbortSignal.timeout(1000));
    const closedPeersBeforeOriginalReserve = conflictingReserveProxy.closedPeers;
    const recoveringReserveStore = new ProviderMutationJournalStore(conflictingReserveDatabase, {reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000});
    let originalProviderMutatorCalls = 0;
    const originalPromise = new GatewayMutationExecutor(recoveringReserveStore, async () => {
      originalProviderMutatorCalls += 1;
      throw new Error("original provider mutator must not run after reserve conflict");
    }).execute(originalRequest, delegation());
    const expectedConflict = assert.rejects(originalPromise, {code: "AROMA_OPERATION_REF_CONFLICT"});
    await conflictingReserveProxy.waitForCommand("COMMIT");
    await conflictingReserveProxy.waitForPeerClosed(closedPeersBeforeOriginalReserve);
    await conflictingReserveProxy.waitForQueryBlocked();
    assert.equal(await directStore.get(originalRequest.operationRef), undefined);
    let conflictingMutatorCalls = 0;
    const competingResult = await new GatewayMutationExecutor(directStore, async (requestValue) => {
      conflictingMutatorCalls += 1;
      return {state: "Acknowledged", statusCode: 200, responseBodyBytes: acknowledgedBytes(requestValue)};
    }).execute(conflictingRequest, delegation());
    assert.equal(competingResult.state, "Acknowledged");
    assert.equal(competingResult.replayed, false);
    assert.equal(conflictingMutatorCalls, 1);
    const conflictingRow = await directStore.get(originalRequest.operationRef);
    assert.ok(conflictingRow);
    assert.notEqual(conflictingRow.offerRef, originalRequest.offerRef);
    assert.equal(conflictingRow.offerRef, conflictingRequest.offerRef);
    assert.equal(conflictingRow.quantityMilli, conflictingRequest.quantityMilli);
    assert.equal(conflictingRow.state, "Acknowledged");
    conflictingReserveProxy.releaseBlockedQuery();
    await expectedConflict;
    assert.equal(originalProviderMutatorCalls, 0);

    const unknownRequest = request(31);
    const unknownReservation = await directStore.reserve(unknownRequest, delegation());
    assert.equal(unknownReservation.kind, "Reserved");
    unknownProxy = await openBlackholeProxy(port, "COMMIT", {dropOnce: true});
    unknownDatabase = liveDatabase("aroma-journal-live-unknown", database.name, runtime.role, rolePasswords[runtime.role], unknownProxy.port);
    await unknownDatabase.resource.start(AbortSignal.timeout(1000));
    const unknownStore = new ProviderMutationJournalStore(unknownDatabase, {reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000});
    const unknownDispatch = await unknownStore.markDispatched(unknownReservation.reservation);
    await unknownProxy.waitForReplyDropped();
    assert.deepEqual(unknownDispatch, {
      kind: "UnknownOutcome",
      outcome: {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN", replayed: true},
    });
    const unknownRow = await directStore.get(unknownRequest.operationRef);
    assert.equal(unknownRow.state, "Dispatched");
    let unsafeDispatchCalls = 0;
    const safeUnknown = await new GatewayMutationExecutor(unknownStore, async () => {
      unsafeDispatchCalls++;
      throw new Error("unsafe provider dispatch must not be repeated after unknown commit");
    }).execute(unknownRequest, delegation());
    assert.equal(safeUnknown.state, "UnknownOutcome");
    assert.equal(unsafeDispatchCalls, 0);

    const terminalRequest = request(32);
    const terminalReservation = await directStore.reserve(terminalRequest, delegation());
    assert.equal(terminalReservation.kind, "Reserved");
    const terminalDispatch = await directStore.markDispatched(terminalReservation.reservation);
    assert.equal(terminalDispatch.kind, "DispatchPermitted");
    terminalProxy = await openBlackholeProxy(port, "COMMIT", {dropOnce: true});
    terminalDatabase = liveDatabase("aroma-journal-live-terminal", database.name, runtime.role, rolePasswords[runtime.role], terminalProxy.port);
    await terminalDatabase.resource.start(AbortSignal.timeout(1000));
    const terminalStore = new ProviderMutationJournalStore(terminalDatabase, {reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000});
    await assert.rejects(terminalStore.acknowledge(terminalDispatch.permit, {state: "Acknowledged", statusCode: 200, responseBodyBytes: Buffer.from("not JSON")}), {code: "AROMA_MUTATION_INVALID"});
    const nonTerminalRow = await directStore.get(terminalRequest.operationRef);
    assert.equal(nonTerminalRow.state, "Dispatched");
    const terminalBytes = acknowledgedBytes(terminalRequest);
    const recoveredTerminal = await terminalStore.acknowledge(terminalDispatch.permit, {state: "Acknowledged", statusCode: 200, responseBodyBytes: terminalBytes});
    await terminalProxy.waitForReplyDropped();
    assert.equal(recoveredTerminal.state, "Acknowledged");
    assert.equal(recoveredTerminal.replayed, true);
    assert.deepEqual(Buffer.from(recoveredTerminal.responseBodyBytes), terminalBytes);
    const terminalRow = await directStore.get(terminalRequest.operationRef);
    assert.equal(terminalRow.state, "Acknowledged");
    let replayProviderCalls = 0;
    const replay = await new GatewayMutationExecutor(terminalStore, async () => {
      replayProviderCalls++;
      throw new Error("terminal replay must not dispatch the provider");
    }).execute(terminalRequest, delegation());
    assert.equal(replay.state, "Acknowledged");
    assert.equal(replay.replayed, true);
    assert.equal(replayProviderCalls, 0);

    const missingTerminalRequest = request(33);
    missingTerminalProxy = await openBlackholeProxy(port, "COMMIT", {dropCommandOnce: true, dropCommandAt: 3});
    missingTerminalDatabase = liveDatabase("aroma-journal-live-missing-terminal", database.name, runtime.role, rolePasswords[runtime.role], missingTerminalProxy.port);
    await missingTerminalDatabase.resource.start(AbortSignal.timeout(1000));
    const missingTerminalStore = new ProviderMutationJournalStore(missingTerminalDatabase, {reservationOwner: LIVE_RESERVATION_OWNER, leaseMs: 30_000});
    let missingTerminalMutatorCalls = 0;
    const missingTerminalExecutor = new GatewayMutationExecutor(missingTerminalStore, async (requestValue) => {
      missingTerminalMutatorCalls += 1;
      return {state: "Acknowledged", statusCode: 200, responseBodyBytes: acknowledgedBytes(requestValue)};
    });
    const missingTerminalOutcome = await missingTerminalExecutor.execute(missingTerminalRequest, delegation());
    await missingTerminalProxy.waitForCommand("COMMIT");
    assert.deepEqual(missingTerminalOutcome, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN", replayed: true});
    assert.equal(missingTerminalMutatorCalls, 1);
    const missingTerminalRow = await directStore.get(missingTerminalRequest.operationRef);
    assert.equal(missingTerminalRow.state, "Dispatched");
    assert.equal(missingTerminalRow.responseStatus, null);
    const missingTerminalReplay = await new GatewayMutationExecutor(missingTerminalStore, async () => {
      missingTerminalMutatorCalls += 1;
      throw new Error("unsafe provider dispatch must not repeat after missing terminal recovery");
    }).execute(missingTerminalRequest, delegation());
    assert.deepEqual(missingTerminalReplay, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_OUTCOME_UNKNOWN", replayed: true});
    assert.equal(missingTerminalMutatorCalls, 1);

    return {migration: "0002_provider_mutation_journal", reserveConflictAfterUnknownCommit: true, conflictingRow: "Acknowledged", conflictingMutatorCalls, originalProviderMutatorCalls, terminalCommitReplay: true, terminalRow: "Acknowledged", unknownCommitWithoutTerminal: true, unknownRow: "Dispatched", terminalCommitWithoutTerminal: true, missingTerminalRow: "Dispatched", missingTerminalMutatorCalls, unsafeDispatchCalls, replayProviderCalls};
  } finally {
    await Promise.allSettled([conflictingReserveProxy?.close(), unknownProxy?.close(), terminalProxy?.close(), missingTerminalProxy?.close()]);
    for (const databaseHandle of [missingTerminalDatabase, terminalDatabase, unknownDatabase, conflictingReserveDatabase, direct, migrator]) databaseHandle?.resource.destroy();
  }
}

void test("LIVE: ProviderMutationJournalStore recovers unknown COMMIT without unsafe redispatch", {skip: process.env.COFFEE_DB_LIVE_PROOF !== "1"}, async () => {
  const result = await runLiveProof({runId: `issue10journal${Date.now().toString(36)}`, bindingProof: journalLiveProof});
  assert.deepEqual(result.binding, {migration: "0002_provider_mutation_journal", reserveConflictAfterUnknownCommit: true, conflictingRow: "Acknowledged", conflictingMutatorCalls: 1, originalProviderMutatorCalls: 0, terminalCommitReplay: true, terminalRow: "Acknowledged", unknownCommitWithoutTerminal: true, unknownRow: "Dispatched", terminalCommitWithoutTerminal: true, missingTerminalRow: "Dispatched", missingTerminalMutatorCalls: 1, unsafeDispatchCalls: 0, replayProviderCalls: 0});
  assert.equal(result.cleanup.containerRemoved, true);
});

void test("production composition mounts the typed mutation bridge without a test fallback", async () => {
  const main = await readFile(fileURLToPath(new URL("../../apps/aroma-gateway/src/main.ts", import.meta.url)), "utf8");
  assert.match(main, /registerAromaBindingRoutes/);
  assert.match(main, /registerAromaMutationRoutes/);
  assert.match(main, /GatewayMutationExecutor/);
  assert.match(main, /ProviderMutationJournalStore/);
  assert.match(main, /ProviderCartMutator/);
  assert.doesNotMatch(main, /TestOnlyUnsafeProviderMutator/);
});

void test("journal migration is ordered, Integration-owned, constrained, and does not define provider/session payload storage", async () => {
  const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(files, ["0001_provider_sessions.sql", "0002_provider_mutation_journal.sql", "0003_offer_bindings.sql", "0004_provider_offer_identity.sql", "0005_catalog_export_attempts.sql"]);
  const sessionSql = await readFile(`${MIGRATIONS}/0001_provider_sessions.sql`, "utf8");
  assert.match(sessionSql, /CREATE TABLE integration\.provider_sessions/);
  assert.match(sessionSql, /encrypted_cookie_material bytea/);
  assert.match(sessionSql, /ON TABLE integration\.provider_sessions TO coffee_aroma_gateway_rw/);
  assert.doesNotMatch(sessionSql, /password|plaintext|provider_body|request_body|PII/i);
  const sql = await readFile(`${MIGRATIONS}/0002_provider_mutation_journal.sql`, "utf8");
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS integration/);
  assert.match(sql, /CREATE TABLE integration\.provider_mutation_journal/);
  assert.match(sql, /state IN \('Reserved', 'Dispatched', 'Acknowledged', 'Rejected', 'UnknownOutcome'\)/);
  assert.match(sql, /ON TABLE integration\.provider_mutation_journal TO coffee_aroma_gateway_rw/);
  assert.match(sql, /response_body_bytes bytea/);
  assert.match(sql, /CHECK \(quantity_milli IS NULL OR quantity_milli > 0\)/);
  assert.match(sql, /operation_kind = 'SetLineQuantity' AND quantity_milli IS NOT NULL/);
  assert.doesNotMatch(sql, /password|cookie|secret|provider_body|request_body|plaintext|PII/i);
});

void test("concurrent calls produce one durable reservation and one dispatch permit", async () => {
  const shared = new SharedJournal();
  const firstJournal = new MemoryJournal(shared, "owner-a");
  const secondJournal = new MemoryJournal(shared, "owner-b");
  const firstCalls = {value: 0};
  const secondCalls = {value: 0};
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = new GatewayMutationExecutor(firstJournal, async (...args) => {
    firstCalls.value++;
    assert.equal(shared.events.at(-1), "dispatched-committed");
    await blocked;
    return acknowledgeMutator(shared, {value: 0})(...args);
  });
  const second = new GatewayMutationExecutor(secondJournal, async () => {
    secondCalls.value++;
    throw new Error("duplicate dispatch");
  });
  const req = request(1);
  const firstPromise = first.execute(req, delegation());
  await waitFor(() => firstCalls.value === 1);
  const secondResult = await second.execute(req, delegation({correlationId: "22222222-2222-4222-8222-222222222222"}));
  assert.equal(secondResult.state, "UnknownOutcome");
  release();
  const firstResult = await firstPromise;
  assert.equal(firstResult.state, "Acknowledged");
  assert.equal(shared.acceptedReservations, 1);
  assert.equal(shared.dispatchCalls, 1);
  assert.equal(firstCalls.value, 1);
  assert.equal(secondCalls.value, 0);
});

void test("safe preparation finishes before the dispatch permit and known preparation failure is terminal before dispatch", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const requestValue = request(40);
  const preparationEvents = [];
  let unsafeCalls = 0;
  const executor = new GatewayMutationExecutor(
    journal,
    async requestValue2 => {
      unsafeCalls++;
      preparationEvents.push("unsafe");
      assert.equal(shared.records.get(requestValue2.operationRef).state, "Dispatched");
      return {state: "Acknowledged", statusCode: 200, responseBodyBytes: acknowledgedBytes(requestValue2)};
    },
    async () => {
      preparationEvents.push("prepared");
      return {safeCart: true};
    },
  );
  const acknowledged = await executor.execute(requestValue, delegation());
  assert.equal(acknowledged.state, "Acknowledged");
  assert.deepEqual(preparationEvents, ["prepared", "unsafe"]);
  assert.deepEqual(shared.events.slice(0, 2), ["reserved-committed", "dispatched-committed"]);
  assert.equal(unsafeCalls, 1);

  const failedRequest = request(41);
  const failed = await new GatewayMutationExecutor(
    new MemoryJournal(shared, "owner-b"),
    async () => { throw new Error("unsafe preparation failure must not reach provider"); },
    async () => { throw codedError("ProviderSessionUnavailable"); },
  ).execute(failedRequest, delegation());
  assert.equal(failed.state, "Rejected");
  assert.equal(failed.statusCode, 503);
  assert.equal(shared.records.get(failedRequest.operationRef).state, "Rejected");
  assert.equal(shared.dispatchCalls, 1);
});

void test("delegation is rejected before reserve and a changed request conflicts on operationRef", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const calls = {value: 0};
  const executor = new GatewayMutationExecutor(journal, acknowledgeMutator(shared, calls));
  await assert.rejects(executor.execute(request(2), delegation({transportCaller: "aroma-convergence"})), {code: "SERVICE_DELEGATION_INVALID"});
  assert.equal(shared.reserveCalls, 0);
  await executor.execute(request(2), delegation());
  await assert.rejects(executor.execute({...request(2), quantityMilli: "4"}, delegation()), {code: "AROMA_OPERATION_REF_CONFLICT"});
  assert.equal(calls.value, 1);
  assert.equal(shared.reserveCalls, 2);
});

void test("SetLineQuantity rejects null and zero before reserve while RemoveLine keeps null", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const executor = new GatewayMutationExecutor(journal, acknowledgeMutator(shared, {value: 0}));
  await assert.rejects(executor.execute({...request(22), quantityMilli: null}, delegation()), {code: "AROMA_MUTATION_INVALID"});
  assert.equal(shared.reserveCalls, 0);
  await assert.rejects(executor.execute({...request(22), quantityMilli: "0"}, delegation()), {code: "AROMA_MUTATION_INVALID"});
  assert.equal(shared.reserveCalls, 0);

  const removeCalls = {value: 0};
  const removeResult = await new GatewayMutationExecutor(journal, acknowledgeMutator(shared, removeCalls)).execute(
    request(23, "RemoveLine"),
    delegation({operationId: "removeAromaCartLine"}),
  );
  assert.equal(removeResult.state, "Acknowledged");
  assert.equal(removeCalls.value, 1);
  assert.equal(shared.reserveCalls, 1);
});

void test("invalid typed response bytes are unknown before acknowledge and use the invalid-response failure code", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const originalAcknowledge = journal.acknowledge.bind(journal);
  const originalMarkUnknown = journal.markUnknown.bind(journal);
  let acknowledgeCalls = 0;
  let markUnknownFailureCode;
  journal.acknowledge = async (...args) => {
    acknowledgeCalls++;
    return originalAcknowledge(...args);
  };
  journal.markUnknown = async (...args) => {
    markUnknownFailureCode = args[1];
    return originalMarkUnknown(...args);
  };

  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Acknowledged",
    statusCode: 200,
    responseBodyBytes: Buffer.from("not JSON"),
  })).execute(request(24), delegation());

  assert.deepEqual(result, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_INVALID_RESPONSE", replayed: false});
  assert.equal(acknowledgeCalls, 0);
  assert.equal(markUnknownFailureCode, "AROMA_PROVIDER_INVALID_RESPONSE");
  assert.equal(shared.records.get(request(24).operationRef).state, "UnknownOutcome");
});

void test("ProviderCartMutator malformed response becomes durable UnknownOutcome and replays without a provider call", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const requestValue = request(27);
  const identity = {
    offerRef: requestValue.offerRef,
    supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "a".repeat(64),
    rawProviderOfferId: "300000",
    rawProviderProductId: "300001",
    rawProviderVariantId: "300000",
    packing: "Aroma",
    grindId: null,
    cartLineId: "300001",
  };
  const cart = quantity => ({products: [{id: 300001, offer: {id: 300000, price: 852.6}, quantity, packing: "Aroma", grind_id: null}], prices: {categories: [], weights: [], discounts: [], prices: [], total: {default: 0, promo: 0}}});
  let reads = 0;
  let providerCalls = 0;
  const session = {
    read: async function* () { yield Buffer.from(JSON.stringify(cart(reads++ === 0 ? 1 : 3))); },
    mutate: async () => { providerCalls++; return {statusCode: 200, body: Buffer.from("{not-json", "utf8")}; },
  };
  const mutator = new ProviderCartMutator({
    sessions: {acquire: async () => session},
    credentials: {scopeRef: "aroma-primary", email: "canonical@example.test", password: "test-only"},
    bindings: {resolveProviderOffer: async () => identity},
  });
  const executor = new GatewayMutationExecutor(journal, mutator.execute.bind(mutator));
  const first = await executor.execute(requestValue, delegation());
  assert.deepEqual(first, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_INVALID_RESPONSE", replayed: false});
  const replay = await executor.execute(requestValue, delegation());
  assert.deepEqual(replay, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_INVALID_RESPONSE", replayed: true});
  assert.equal(providerCalls, 1);
});

void test("invalid ProblemDetails URI-reference becomes UnknownOutcome before reject", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const invalidReferences = ["1:abc", ":abc", "/[::1]", "http://[", "/has space", "\\evil.com", "%", "\0", "foo[bar", "foo]bar", "\"foo", "%GG"];
  const validReferences = ["./1:abc", "/a:b", "//[::1]/", "http://[::1]/", "HTTP://EXAMPLE.COM/problem", "urn:example:test", "/relative/path", "../a?b#c", "a%20b"];
  for (const field of ["type", "instance"]) {
    for (const value of invalidReferences)
      assert.equal(isAromaProblem({...rejectionBody, [field]: value}), false, `${field}: ${JSON.stringify(value)}`);
    for (const value of validReferences)
      assert.equal(isAromaProblem({...rejectionBody, [field]: value}), true, `${field}: ${JSON.stringify(value)}`);
  }
  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: rejectionBytes({instance: "http://["}),
  })).execute(request(25), delegation());
  assert.deepEqual(result, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_INVALID_RESPONSE", replayed: false});
  assert.equal(shared.records.get(request(25).operationRef).state, "UnknownOutcome");
});

void test("contract-valid ProblemDetails counts Unicode title by schema semantics", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const title = "😀".repeat(101);
  const body = {...rejectionBody, title};
  assert.equal(isAromaProblem(body), true);
  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: rejectionBytes({title}),
  })).execute(request(26), delegation());
  assert.equal(result.state, "Rejected");
  assert.equal(shared.records.get(request(26).operationRef).state, "Rejected");
});

void test("acknowledged and rejected terminal rows replay exact typed bytes without HTTP", async () => {
  const ackShared = new SharedJournal();
  const ackJournal = new MemoryJournal(ackShared, "owner-a");
  const ackCalls = {value: 0};
  const ackExecutor = new GatewayMutationExecutor(ackJournal, acknowledgeMutator(ackShared, ackCalls, ACK_BYTES));
  const ackRequest = request(3);
  const ackFirst = await ackExecutor.execute(ackRequest, delegation());
  const ackReplay = await new GatewayMutationExecutor(ackJournal, async () => { throw new Error("HTTP must not run"); }).execute(ackRequest, delegation());
  assert.equal(ackReplay.state, "Acknowledged");
  assert.equal(ackReplay.replayed, true);
  assert.deepEqual(Buffer.from(ackReplay.responseBodyBytes), Buffer.from(ackFirst.responseBodyBytes));
  assert.equal(typedResponseHash(ackReplay.responseBodyBytes), typedResponseHash(ACK_BYTES));
  assert.equal(ackCalls.value, 1);

  const rejectShared = new SharedJournal();
  const rejectJournal = new MemoryJournal(rejectShared, "owner-a");
  let rejectCalls = 0;
  const rejectExecutor = new GatewayMutationExecutor(rejectJournal, async () => {
    rejectCalls++;
    return {state: "Rejected", statusCode: 409, failureCode: "AROMA_PROVIDER_REJECTED", responseBodyBytes: REJECT_BYTES};
  });
  const rejectRequest = request(4);
  const rejectFirst = await rejectExecutor.execute(rejectRequest, delegation());
  const rejectReplay = await new GatewayMutationExecutor(rejectJournal, async () => { throw new Error("HTTP must not run"); }).execute(rejectRequest, delegation());
  assert.equal(rejectReplay.state, "Rejected");
  assert.equal(rejectReplay.replayed, true);
  assert.deepEqual(Buffer.from(rejectReplay.responseBodyBytes), Buffer.from(rejectFirst.responseBodyBytes));
  assert.equal(rejectCalls, 1);
});

void test("lost response or timeout becomes UnknownOutcome and never dispatches again", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  let calls = 0;
  const executor = new GatewayMutationExecutor(journal, async () => {
    calls++;
    throw codedError("AROMA_PROVIDER_TIMEOUT");
  });
  const req = request(5);
  const first = await executor.execute(req, delegation());
  const replay = await new GatewayMutationExecutor(journal, async () => {
    calls++;
    throw new Error("duplicate dispatch");
  }).execute(req, delegation());
  assert.deepEqual(first, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_TIMEOUT", replayed: false});
  assert.deepEqual(replay, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_TIMEOUT", replayed: true});
  assert.equal(calls, 1);
});

void test("aborted provider timeout is durably marked UnknownOutcome with a terminal journal signal", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const originalMarkUnknown = journal.markUnknown.bind(journal);
  journal.markUnknown = async (...args) => {
    assert.equal(args[2]?.aborted, false);
    return originalMarkUnknown(...args);
  };
  const controller = new AbortController();
  const executor = new GatewayMutationExecutor(journal, async (_request, _permit, signal) => {
    controller.abort();
    assert.equal(signal.aborted, true);
    throw Object.assign(new Error("provider timeout"), {name: "TimeoutError"});
  });
  const result = await executor.execute(request(21), delegation(), controller.signal);
  assert.deepEqual(result, {state: "UnknownOutcome", failureCode: "AROMA_PROVIDER_TIMEOUT", replayed: false});
});

void test("restart recovery fences stale Dispatched rows as UnknownOutcome", async () => {
  const shared = new SharedJournal();
  const oldJournal = new MemoryJournal(shared, "owner-a");
  const req = request(6);
  const reserved = await oldJournal.reserve(req, delegation());
  assert.equal(reserved.kind, "Reserved");
  const dispatched = await oldJournal.markDispatched(reserved.reservation);
  assert.equal(dispatched.kind, "DispatchPermitted");
  shared.records.get(req.operationRef).dispatchedAt = 0;
  const restarted = new MemoryJournal(shared, "owner-b");
  assert.equal(await restarted.recoverAfterRestart(Date.now()), 1);
  let calls = 0;
  const result = await new GatewayMutationExecutor(restarted, async () => {
    calls++;
    throw new Error("restart must not retry");
  }).execute(req, delegation());
  assert.equal(result.state, "UnknownOutcome");
  assert.equal(result.replayed, true);
  assert.equal(calls, 0);
});

void test("expired Reserved lease is taken over by one new owner before its first dispatch", async () => {
  const shared = new SharedJournal();
  const oldJournal = new MemoryJournal(shared, "owner-a", 1);
  const req = request(7);
  const reserved = await oldJournal.reserve(req, delegation());
  assert.equal(reserved.kind, "Reserved");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newJournal = new MemoryJournal(shared, "owner-b", 30_000);
  const calls = {value: 0};
  const result = await new GatewayMutationExecutor(newJournal, acknowledgeMutator(shared, calls)).execute(req, delegation());
  assert.equal(result.state, "Acknowledged");
  assert.equal(calls.value, 1);
  assert.equal(shared.acceptedReservations, 2);
  assert.equal(shared.dispatchCalls, 1);
  assert.equal(shared.records.get(req.operationRef).reservationOwner, "owner-b");
});

void test("canonical hash excludes per-request correlation while binding trusted caller and operation", () => {
  const req = request(8);
  const first = delegation();
  const second = delegation({correlationId: "22222222-2222-4222-8222-222222222222"});
  assert.equal(canonicalMutationRequestHash(req, first), canonicalMutationRequestHash(req, second));
  assert.notEqual(canonicalMutationRequestHash(req, first), canonicalMutationRequestHash(req, delegation({operationId: "removeAromaCartLine"})));
});
