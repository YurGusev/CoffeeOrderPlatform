import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import pg from "pg";
import {createRuntime} from "../../platform-runtime/dist/index.js";
import {
  RUNTIME_NAMES,
  parsePlatformConfig,
  PlatformConfigError,
} from "../../platform-config/src/index.ts";
import {
  correlationHeaders,
  createCorrelationContext,
  createLogger,
  isTraceparent,
  redactLogFields,
  withCorrelationFields,
} from "../../platform-observability/src/index.ts";
import {
  signActorContext,
  verifyActorContext,
} from "../../platform-security/src/index.ts";
import {withTransaction, createDatabase, DatabaseTransactionError} from "../../platform-database/dist/index.js";
import {defineStatement, defineCopy} from "../../platform-database/dist/owner.js";
import {createSqlIdempotencyStore, canonicalRequestHash} from "../../platform-idempotency/dist/index.js";
import {applyMigrations, migrationChecksum} from "../../platform-migrations/dist/index.js";


import { InMemoryOutboxStore } from "../../platform-outbox/src/index.ts";
import {
  consumeOnce,
  InboxProcessingError,
  InMemoryInboxStore,
} from "../../platform-inbox/src/index.ts";
import {
  parseEnvelope,
  processKafkaRecord,
  validateKafkaRuntimeConfig,
} from "../../platform-kafka-runtime/src/index.ts";
import { createTestClock } from "../src/index.ts";

function runtimeConfig() {
  return {
    replicas: 1,
    listen: { host: "0.0.0.0", port: 4000 },
    health: {
      livePath: "/health/live",
      readyPath: "/health/ready",
      metricsPath: "/metrics",
      intervalMs: 5000,
      timeoutMs: 1000,
      startupGraceMs: 30000,
      failureThreshold: 3,
      successThreshold: 1,
    },
    deadlineMs: 5000,
    deadlineProfiles: { defaultMs: 5000 },
    concurrency: 1,
    dbPool: null,
    database: null,
    secretRefs: [],
    outbound: [],
    kafka: { mode: "none", topics: [], groups: [] },
    permissions: {
      manifest: "config/permissions/test.json",
      net: [],
      fsRead: [],
      fsWrite: [],
      childProcess: false,
      workers: false,
    },
    mutationCapability: false,
  };
}

void test("config rejects unknown keys and requires the exact runtime set", () => {
  const services = Object.fromEntries(
    RUNTIME_NAMES.map((name) => [name, runtimeConfig()]),
  );
  const parsed = parsePlatformConfig({
    $schema: "./platform.schema.json",
    schemaVersion: 1,
    environment: "development",
    toolchainRef: "config/toolchain-versions.json",
    platform: {shutdownGraceMs: 30000},
    postgres: {host: "coffee_postgres", port: 5432, sslMode: "prefer", maxConnections: 96, reservedConnections: 32, rolloutReplicas: 1},
    kafka: {},
    aroma: {},
    security: {},
    services,
  });
  assert.equal(Object.keys(parsed.services).length, 15);
  assert.throws(
    () => parsePlatformConfig({ ...parsed, unknown: true }),
    PlatformConfigError,
  );
});

void test("observability redacts nested secret fields", () => {
  assert.deepEqual(
    redactLogFields({ actor: { token: "secret", value: "ok" } }),
    { actor: { token: "[REDACTED]", value: "ok" } },
  );
  const records = [];
  createLogger((record) => records.push(record), { runtime: "test" }).info(
    "hello",
    { password: "never-log" },
  );
  assert.equal(records[0].fields.password, "[REDACTED]");
});

void test("observability preserves valid correlation and W3C trace context only", () => {
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const context = createCorrelationContext({
    "x-correlation-id": correlationId,
    traceparent,
    "x-causation-id": "msg_1",
  });
  assert.deepEqual(context, {
    correlationId,
    traceparent,
    causationId: "msg_1",
  });
  assert.deepEqual(correlationHeaders(context), {
    "x-correlation-id": correlationId,
    traceparent,
  });
  assert.deepEqual(withCorrelationFields(context), {
    correlationId,
    traceparent,
    causationId: "msg_1",
  });
  assert.equal(isTraceparent(traceparent), true);
  assert.equal(
    isTraceparent(`00-${"0".repeat(32)}-bbbbbbbbbbbbbbbb-01`),
    false,
  );
  assert.equal(
    isTraceparent(`00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${"0".repeat(16)}-01`),
    false,
  );
  const generated = createCorrelationContext({
    "x-correlation-id": "invalid",
    traceparent: "invalid",
  });
  assert.match(generated.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(generated.traceparent, undefined);
});

void test("security signs and verifies actor context claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = {
    iss: "edge-gateway",
    aud: "api-public",
    originalIssuer: "edge-gateway",
    sub: "actor",
    permissions: ["orders:read:any"],
    operationId: "op",
    correlationId: "corr",
    traceparent: "00-abc-def-01",
    iat: 100,
    exp: 160,
    jti: "jti",
    kid: "active",
  };
  const token = signActorContext(claims, privateKey);
  assert.deepEqual(
    verifyActorContext(token, {
      publicKey,
      issuer: "edge-gateway",
      audience: "api-public",
      nowEpochSeconds: 120,
      clockSkewSeconds: 5,
    }),
    claims,
  );
  assert.throws(
    () =>
      verifyActorContext(token, {
        publicKey,
        issuer: "edge-gateway",
        audience: "api-internal",
        nowEpochSeconds: 120,
        clockSkewSeconds: 5,
      }),
    { code: "SERVICE_AUDIENCE_FORBIDDEN" },
  );
});

const poolConfig = {
  max: 2, checkoutTimeoutMs: 50, lockTimeoutMs: 40,
  interactiveStatementTimeoutMs: 100, backgroundStatementTimeoutMs: 200,
  terminalTimeoutMs: 40, transactionTimeoutMs: 300, idleTimeoutMs: 1000, maxLifetimeMs: 1000,
};
function mockDatabase(t, hook = () => undefined, ssl = false) {
  const statements = [], releases = [];
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === 'string' ? query : query.text;
    statements.push(sql);
    const override = hook(sql, typeof query === 'string' ? [] : query.values);
    return override ?? {rows: [], rowCount: 0, command: sql.split(' ')[0]};
  };
  connection.release = destroy => { releases.push(destroy); };
  t.mock.method(pg.Pool.prototype, 'connect', async () => connection);
  t.mock.method(pg.Pool.prototype, 'end', async () => {});
  const options = {owner: 'test', database: 'owner', allowedDatabase: 'owner',
    host: 'localhost', port: 5432, user: 'owner', password: 'test-only', ssl, pool: poolConfig, shutdownGraceMs: 1000};
  const database = createDatabase(options);
  t.after(() => database.resource.destroy());
  return {database, statements, releases, connection, options};
}

void test('database opaque transaction: states, budgets, owner identity and terminal use', async t => {
  const {database, statements, releases, options} = mockDatabase(t);
  const query = defineStatement(database, 'SELECT $1::integer AS value');
  let saved;
  assert.equal(await withTransaction(database, {mode: 'interactive'}, async tx => {
    saved = tx;
    assert.equal(tx.state(), 'Active');
    assert.deepEqual(Object.keys(tx), ['state']);
    assert.equal(tx.query, undefined);
    await query(tx, [1]);
    return 'known';
  }), 'known');
  assert.equal(saved.state(), 'Committed');
  assert.ok(statements.includes("SET LOCAL statement_timeout = '100ms'"));
  assert.deepEqual(releases, [false]);
  await assert.rejects(query(saved, [2]), {code: 'DB_INVALID_TRANSITION'});
  await assert.rejects(query({}, [2]), {code: 'DB_INVALID_TRANSITION'});
  assert.throws(() => defineStatement(database, 'COMMIT'), {code: 'DB_INVALID_CONFIGURATION'});
  assert.throws(() => createDatabase({owner: 'test', database: 'other', allowedDatabase: 'owner'}), {code: 'DB_INVALID_CONFIGURATION'});
  for (const invalid of [{...options, shutdownGraceMs: 0}, {...options, ssl: 'invalid'}, {...options, host: {}}, {...options, pool: {...poolConfig, terminalTimeoutMs: 0}}]) assert.throws(() => createDatabase(invalid), {code: 'DB_INVALID_CONFIGURATION'});
  const failure = new DatabaseTransactionError('DB_QUERY_FAILED', {correlationId: 'safe'});
  await assert.rejects(withTransaction(database, {mode: 'background'}, async tx => {
    saved = tx;
    throw failure;
  }), error => error === failure);
  assert.equal(saved.state(), 'RolledBack');
  assert.ok(statements.includes("SET LOCAL statement_timeout = '200ms'"));
  assert.deepEqual(releases, [false, false]);
});

void test('database COMMIT blackhole: finite unknown, destroy, no rollback, native promise settled on close', async t => {
  let rejectCommit;
  const {database, statements, releases, connection} = mockDatabase(t, sql => sql === 'COMMIT' ? new Promise((_, reject) => {rejectCommit = reject;}) : undefined);
  connection.release = destroy => {releases.push(destroy); rejectCommit?.(new Error('socket closed'));};
  let saved;
  const started = performance.now();
  await assert.rejects(withTransaction(database, {mode: 'interactive', correlationId: 'corr'}, async tx => {saved = tx;}), error => {
    assert.equal(error.code, 'TRANSACTION_OUTCOME_UNKNOWN');
    assert.deepEqual(error.metadata, {correlationId: 'corr'});
    assert.equal(error.message, 'TRANSACTION_OUTCOME_UNKNOWN');
    return true;
  });
  assert.ok(performance.now() - started < 500);
  assert.equal(saved.state(), 'Unknown');
  assert.equal(statements.includes('ROLLBACK'), false);
  assert.deepEqual(releases, [true]);
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().active, 0);
  assert.equal(database.metrics().pending, 0);
});

void test('database interruption rollback blackhole destroys in finite time', async t => {
  let rejectRollback;
  const {database, statements, releases, connection} = mockDatabase(t, sql => sql === 'ROLLBACK' ? new Promise((_, reject) => {rejectRollback = reject;}) : undefined);
  connection.release = destroy => {releases.push(destroy); rejectRollback?.(new Error('socket closed'));};
  const abort = new AbortController();
  const started = performance.now();
  await assert.rejects(withTransaction(database, {mode: 'interactive', signal: abort.signal}, async () => {abort.abort();}), {code: 'DB_ROLLBACK_FAILED'});
  assert.ok(performance.now() - started < 500);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(statements.includes('COMMIT'), false);
  assert.deepEqual(releases, [true]);
  await database.resource.stop(new AbortController().signal);
});

void test('database known COMMIT ignores disconnect after commit starts; pre-commit abort rolls back', async t => {
  const abort = new AbortController();
  const {database, statements, releases} = mockDatabase(t, sql => {
    if (sql === 'COMMIT') {abort.abort(); return {command: 'COMMIT', rows: [], rowCount: 0};}
    return undefined;
  });
  assert.equal(await withTransaction(database, {mode: 'interactive', signal: abort.signal}, async () => 'accepted'), 'accepted');
  assert.equal(statements.includes('ROLLBACK'), false);
  assert.deepEqual(releases, [false]);
  const pre = new AbortController();
  await assert.rejects(withTransaction(database, {mode: 'interactive', signal: pre.signal}, async () => {pre.abort();}), {code: 'DB_INTERRUPTED'});
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.deepEqual(releases, [false, false]);
});

void test('database caught SQL failure + COMMIT ROLLBACK tag is never a known commit', async t => {
  const {database, releases} = mockDatabase(t, sql => {
    if (sql === 'SELECT 1/0') throw Object.assign(new Error('sensitive parameters'), {code: '22012'});
    if (sql === 'COMMIT') return {command: 'ROLLBACK', rows: [], rowCount: 0};
    return undefined;
  });
  const query = defineStatement(database, 'SELECT 1/0');
  let saved;
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, async tx => {
    saved = tx;
    await assert.rejects(query(tx, []), {code: 'DB_QUERY_FAILED', sqlState: '22012', message: 'DB_QUERY_FAILED'});
    return 'must not escape';
  }), {code: 'DB_TRANSACTION_ROLLED_BACK'});
  assert.equal(saved.state(), 'RolledBack');
  assert.deepEqual(releases, [false]);
});

void test('database classifies query timeout and broken connections without leaking SQL', async t => {
  let state = '57014';
  const {database, releases} = mockDatabase(t, sql => {
    if (sql.startsWith('SELECT $1')) throw Object.assign(new Error('password/payload'), {code: state});
    return undefined;
  });
  const query = defineStatement(database, 'SELECT $1');
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, tx => query(tx, ['private'])), {code: 'DB_QUERY_TIMEOUT', message: 'DB_QUERY_TIMEOUT'});
  state = 'ECONNRESET';
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, tx => query(tx, ['private'])), {code: 'DB_CONNECTION_LOST', message: 'DB_CONNECTION_LOST'});
  assert.deepEqual(releases, [false, true]);
});

void test('database pool cap preserves healthy readiness and recovers admission', async t => {
  const {database} = mockDatabase(t);
  assert.equal(await database.readiness.check(new AbortController().signal), true);
  let releaseWork;
  const work = new Promise(resolve => {releaseWork = resolve;});
  const first = withTransaction(database, {mode: 'interactive'}, async () => work);
  const second = withTransaction(database, {mode: 'interactive'}, async () => work);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, async () => {}), {code: 'DB_POOL_EXHAUSTED'});
  assert.equal(database.metrics().saturationTotal, 1);
  assert.equal(await database.readiness.check(new AbortController().signal), true);
  releaseWork();
  await Promise.all([first, second]);
  await withTransaction(database, {mode: 'interactive'}, async () => {});
  assert.equal(database.metrics().active, 0);
});

void test('database non-cooperative callback remains owned for runtime fail-stop', async t => {
  const {database} = mockDatabase(t);
  let settle;
  const never = new Promise(resolve => {settle = resolve;});
  const abort = new AbortController();
  const work = withTransaction(database, {mode: 'interactive', signal: abort.signal}, async () => {
    abort.abort();
    return never;
  });
  await assert.rejects(work, {code: 'DB_INTERRUPTED'});
  assert.equal(database.metrics().active, 0);
  assert.equal(database.metrics().pending, 1);
  const app = await createRuntime({name: 'db-proof', host: '127.0.0.1', port: 0, shutdownGraceMs: 40, resources: [database.resource]});
  await app.runtimeController.start();
  const result = await app.runtimeController.closeRuntime();
  assert.equal(result.status, 'fail-stop');
  assert.ok(result.pending.includes('stop:database'));
  settle();
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().pending, 0);
});

void test("outbox claims are leased and duplicate aggregate versions are ignored", async () => {
  const store = new InMemoryOutboxStore();
  const message = {
    messageId: "m1",
    messageType: "OrderConfirmed",
    aggregateRef: "ord_1",
    aggregateVersion: "1",
    partitionKey: "ord_1",
    schemaVersion: "1",
    payload: {},
    occurredAt: "2026-01-01T00:00:00Z",
    correlationId: "c1",
  };
  assert.equal(await store.enqueue(message), "created");
  assert.equal(
    await store.enqueue({ ...message, messageId: "m2" }),
    "duplicate",
  );
  const claims = await store.claim(0, "worker", 1, 30000);
  assert.equal(claims.length, 1);
  await store.markPublished("m1", "worker");
  assert.deepEqual(await store.claim(1, "worker", 1, 30000), []);
});

void test("inbox quarantines invalid messages and does not run them twice", async () => {
  const store = new InMemoryInboxStore();
  const message = {
    messageId: "m1",
    messageType: "OrderConfirmed",
    receivedAt: "2026-01-01T00:00:00Z",
  };
  let runs = 0;
  assert.equal(
    (
      await consumeOnce(
        store,
        message,
        "worker",
        0,
        30000,
        message.receivedAt,
        async () => {
          runs += 1;
          throw new InboxProcessingError({ kind: "invalid", reason: "schema" });
        },
      )
    ).kind,
    "quarantined",
  );
  assert.equal(
    (
      await consumeOnce(
        store,
        message,
        "worker",
        1,
        30000,
        message.receivedAt,
        async () => {
          runs += 1;
        },
      )
    ).kind,
    "quarantined",
  );
  assert.equal(runs, 1);
});

void test("Kafka config disables auto topic creation and commits after durable handler", async () => {
  assert.equal(
    validateKafkaRuntimeConfig({
      brokers: ["kafka:9092"],
      clientId: "orders",
      autoTopicCreation: false,
      maxInFlight: 4,
    }).autoTopicCreation,
    false,
  );
  assert.throws(
    () =>
      validateKafkaRuntimeConfig({
        brokers: ["kafka:9092"],
        clientId: "orders",
        autoTopicCreation: true,
        maxInFlight: 4,
      }),
    { code: "KAFKA_CONFIG_INVALID" },
  );
  const message = parseEnvelope(
    {
      messageId: "m1",
      messageType: "OrderConfirmed",
      schemaVersion: "1",
      aggregateRef: "ord_1",
      occurredAt: "2026-01-01T00:00:00Z",
      correlationId: "c1",
      traceparent: "00-a-b-01",
      payload: { x: 1 },
    },
    (value) => value,
  );
  const order = [];
  await processKafkaRecord(
    {
      topic: "orders",
      partition: 0,
      offset: "1",
      key: "ord_1",
      value: message,
      headers: {},
    },
    async (value) => value,
    async () => {
      order.push("handler");
    },
    async () => {
      order.push("commit");
    },
  );
  assert.deepEqual(order, ["handler", "commit"]);
});

void test("testing clock is explicit and deterministic", () => {
  const clock = createTestClock(100);
  clock.advanceMs(50);
  assert.equal(clock.nowMs(), 150);
  clock.setMs(0);
  assert.equal(clock.nowMs(), 0);
});

function idempotencyDatabase(t) {
  let durable = new Map(), working, aborted = false;
  return mockDatabase(t, (sql, values) => {
    if (sql === 'BEGIN') {working = structuredClone(durable); aborted = false;}
    if (sql === 'COMMIT') {
      if (!aborted) durable = structuredClone(working);
      return {command: aborted ? 'ROLLBACK' : 'COMMIT', rows: [], rowCount: 0};
    }
    if (sql === 'SELECT 1/0') {aborted = true; throw Object.assign(new Error('division'), {code: '22012'});}
    if (!sql.includes('idempotency_records')) return undefined;
    const key = JSON.stringify(values.slice(0, 3));
    const row = working.get(key);
    if (sql.startsWith('INSERT')) {
      if (row) return {rows: [], rowCount: 0};
      working.set(key, {actor_ref: values[0], scope: values[1], idempotency_key: values[2], request_hash: values[3],
        state: 'Acquired', lease_owner: values[4], lease_until_ms: values[5], expires_at_ms: values[7],
        response_status: null, response_body: null, resource_ref: null});
      return {rows: [{idempotency_key: values[2]}], rowCount: 1};
    }
    if (sql.startsWith('SELECT')) return {rows: row ? [row] : [], rowCount: row ? 1 : 0};
    if (sql.startsWith('UPDATE') && row?.lease_owner === values[3] && row.state === 'Acquired') {
      Object.assign(row, {state: 'Completed', response_status: values[4], response_body: JSON.parse(values[5]), resource_ref: values[6]});
      return {rows: [{idempotency_key: values[2]}], rowCount: 1};
    }
    return {rows: [], rowCount: 0};
  });
}

void test('idempotency canonical request hash preserves JSON identity without prototype collisions', () => {
  assert.equal(canonicalRequestHash({b: [1, {z: false, a: null}], a: 'x'}), canonicalRequestHash({a: 'x', b: [1, {a: null, z: false}]}));
  assert.notEqual(canonicalRequestHash(JSON.parse('{"__proto__":{"a":1}}')), canonicalRequestHash({}));
  const cyclic = {}; cyclic.self = cyclic;
  for (const invalid of [undefined, {key: undefined}, NaN, Infinity, cyclic, new Map(), Array(2)]) {
    assert.throws(() => canonicalRequestHash(invalid), TypeError);
  }
});

void test('idempotency SQL decisions, tx-bound complete, expiry never reacquires, JSON null/string replay', async t => {
  const {database} = idempotencyDatabase(t);
  const store = createSqlIdempotencyStore(database);
  const identity = {actorRef: 'actor', scope: 'owner:create', key: 'same'};
  const hash = canonicalRequestHash({name: 'coffee'});
  for (const [index, body] of [null, 'plain string'].entries()) {
    const id = {...identity, key: String(index)};
    await withTransaction(database, {mode: 'interactive'}, async tx => {
      assert.equal((await store.acquire(tx, id, hash, 'lease', 1000, 30000, 60000)).kind, 'acquired');
      assert.equal((await store.acquire(tx, id, hash, 'lease', 1000, 30000, 60000)).kind, 'in_progress');
      await store.complete(tx, id, 'lease', {status: 201, body});
      await assert.rejects(store.complete(tx, id, 'lease', {status: 201, body}), {code: 'IDEMPOTENCY_NOT_ACQUIRED'});
    });
    await withTransaction(database, {mode: 'interactive'}, async tx => {
      assert.deepEqual(await store.acquire(tx, id, hash, 'other', 1001, 30000, 60000), {kind: 'replay', response: {status: 201, body}});
      assert.equal((await store.acquire(tx, id, canonicalRequestHash({different: true}), 'other', 1001, 30000, 60000)).kind, 'conflict');
    });
  }
  await withTransaction(database, {mode: 'interactive'}, async tx => {
    assert.equal((await store.acquire(tx, identity, hash, 'lease', 1000, 30000, 60000)).kind, 'acquired');
  });
  await withTransaction(database, {mode: 'interactive'}, async tx => {
    assert.equal((await store.acquire(tx, identity, hash, 'lease', 100000, 30000, 60000)).kind, 'in_progress');
    await assert.rejects(store.complete(tx, identity, 'lease', {status: 200, body: null}), {code: 'IDEMPOTENCY_NOT_ACQUIRED'});
  });
});

void test('idempotency caught SQL error -> COMMIT ROLLBACK never publishes Completed or false Replay', async t => {
  const {database, releases} = idempotencyDatabase(t);
  const store = createSqlIdempotencyStore(database);
  const failSql = defineStatement(database, 'SELECT 1/0');
  const identity = {actorRef: 'actor', scope: 'owner:create', key: 'rolled-back'};
  const hash = canonicalRequestHash({request: 1});
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, async tx => {
    assert.equal((await store.acquire(tx, identity, hash, 'lease', 1000, 30000, 60000)).kind, 'acquired');
    await store.complete(tx, identity, 'lease', {status: 201, body: {id: 1}});
    await assert.rejects(failSql(tx, []), {code: 'DB_QUERY_FAILED'});
  }), {code: 'DB_TRANSACTION_ROLLED_BACK'});
  await withTransaction(database, {mode: 'interactive'}, async tx => {
    assert.equal(await store.get(tx, identity), undefined);
    assert.equal((await store.acquire(tx, identity, hash, 'retry-after-known-rollback', 1001, 30000, 60000)).kind, 'acquired');
    await store.complete(tx, identity, 'retry-after-known-rollback', {status: 201, body: {id: 2}});
  });
  assert.deepEqual(releases, [false, false]);
});

void test('migrations checksum ledger is an immutable applied prefix in one owner transaction', async t => {
  const first = {id: '0001_first', sql: 'CREATE TABLE proof (id integer)'};
  first.checksum = migrationChecksum(first.sql);
  const second = {id: '0002_second', sql: 'ALTER TABLE proof ADD COLUMN name text'};
  second.checksum = migrationChecksum(second.sql);
  let ledger = [];
  const {database, statements} = mockDatabase(t, sql => sql.startsWith('SELECT id, checksum') ? {rows: ledger, rowCount: ledger.length} : undefined);
  assert.deepEqual(await applyMigrations(database, [first, second]), [first.id, second.id]);
  assert.equal(statements.filter(sql => sql === 'BEGIN').length, 1);
  assert.equal(statements.at(-1), 'COMMIT');
  ledger = [first, second];
  assert.deepEqual(await applyMigrations(database, [first, second]), []);
  for (const [rows, code] of [
    [[{...first, checksum: '0'.repeat(64)}], 'MIGRATION_CHECKSUM_DRIFT'],
    [[{...first, checksum: ''}], 'MIGRATION_MISSING_CHECKSUM'],
    [[second], 'MIGRATION_NON_PREFIX'],
    [[first, second, {id: '0003_unknown', checksum: first.checksum}], 'MIGRATION_ORPHAN'],
  ]) {
    ledger = rows;
    await assert.rejects(applyMigrations(database, [first, second]), {code});
    assert.equal(statements.at(-1), 'ROLLBACK');
  }
  await assert.rejects(applyMigrations(database, [{...first, checksum: ''}]), {code: 'MIGRATION_MISSING_CHECKSUM'});
});

void test('database does not reuse a connection with an unsettled native query after interruption', async t => {
  let rejectQuery;
  const abort = new AbortController();
  const {database, releases, connection} = mockDatabase(t, sql => {
    if (sql === 'SELECT pg_sleep(10)') return new Promise((_, reject) => {
      rejectQuery = reject;
      abort.abort();
    });
    return undefined;
  });
  connection.release = destroy => {releases.push(destroy); rejectQuery?.(new Error('socket closed'));};
  const query = defineStatement(database, 'SELECT pg_sleep(10)');
  await assert.rejects(withTransaction(database, {mode: 'interactive', signal: abort.signal}, tx => query(tx, [])), {code: 'DB_INTERRUPTED'});
  assert.deepEqual(releases, [true]);
  await database.resource.stop(new AbortController().signal);
  assert.equal(database.metrics().pending, 0);
});

void test('database COPY synchronous driver failure is typed and releases a destroyed connection', async t => {
  const {database, releases, connection} = mockDatabase(t);
  connection.query = query => {
    if (typeof query !== 'string') throw Object.assign(new Error('private connection info'), {code: 'ECONNRESET'});
    return Promise.resolve({rows: [], rowCount: 0, command: query.split(' ')[0]});
  };
  const copy = defineCopy(database, 'records', ['id'], 'owner');
  const source = Readable.from(['1\n']);
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, tx => copy(tx, source)), {code: 'DB_CONNECTION_LOST', message: 'DB_CONNECTION_LOST'});
  assert.deepEqual(releases, [true]);
  assert.equal(source.destroyed, true);
  assert.equal(database.metrics().pending, 0);
});

void test('database ssl prefer falls back only before authentication on explicit server refusal', async t => {
  const {database, connection} = mockDatabase(t, undefined, 'prefer');
  const observed = [];
  t.mock.method(pg.Pool.prototype, 'connect', async function () {
    observed.push(this.options.ssl);
    if (this.options.ssl) throw new Error('The server does not support SSL connections');
    return connection;
  });
  await withTransaction(database, {mode: 'interactive'}, async () => {});
  assert.deepEqual(observed, [true, false]);
  t.mock.method(pg.Pool.prototype, 'connect', async () => {
    observed.push('certificate failure');
    throw new Error('certificate verify failed');
  });
  await assert.rejects(withTransaction(database, {mode: 'interactive'}, async () => {}), {code: 'DB_CONNECTION_LOST'});
  assert.equal(observed.filter(value => value === 'certificate failure').length, 1);
});
