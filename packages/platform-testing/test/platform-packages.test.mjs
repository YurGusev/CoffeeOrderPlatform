import { strict as assert } from "node:assert";
import {readFileSync} from "node:fs";
import {load as parseYaml} from "js-yaml";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {EventEmitter} from "node:events";
import {Readable} from "node:stream";
import pg from "pg";
import {createRuntime} from "../../platform-runtime/dist/index.js";
import {
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
import {consumeOnce, createSqlInboxStore} from "../../platform-inbox/dist/index.js";
import {createSqlOutboxStore, relayOutboxBatch} from "../../platform-outbox/dist/index.js";
import {applyMigrations, migrationChecksum} from "../../platform-migrations/dist/index.js";


import {createKafkaRuntime, parseEnvelope, processKafkaRecord, validateKafkaRuntimeConfig, PartitionWorkers} from "../../platform-kafka-runtime/dist/index.js";
import { createTestClock } from "../src/index.ts";

void test("config rejects unknown keys and requires the exact runtime set", () => {
  const parsed = parsePlatformConfig(parseYaml(readFileSync(new URL("../../../config/platform.yaml", import.meta.url), "utf8")));
  assert.equal(Object.keys(parsed.services).length, 15);
  assert.throws(() => parsePlatformConfig({...parsed, unknown: true}), PlatformConfigError);
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

const kafkaEnvelope = (messageId = "m1") => ({
  envelopeVersion: "1", messageId, messageType: "OrderConfirmed",
  occurredAt: "2026-01-01T00:00:00Z", producer: "orders-service", correlationId: "c1", causationId: null,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  aggregate: {type: "Order", ref: "ord_1", version: "1"}, payload: {x: 1},
});
const kafkaRecord = (partition = 0, offset = "0") => ({topic: "coffee.orders.lifecycle.v1", partition, offset, key: "ord_1", value: kafkaEnvelope(), headers: {}});
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

void test("Kafka partition workers preserve offset order, one handler per partition and a shared bounded cap", async () => {
  const seen = [], gates = [], active = new Map(); let total = 0, peak = 0;
  const workers = new PartitionWorkers({maxPartitions: 2, maxInFlight: 2, queueCapacity: 4}, async record => {
    assert.equal(active.get(record.partition) ?? 0, 0);
    active.set(record.partition, 1); peak = Math.max(peak, ++total);
    seen.push([record.partition, record.offset]);
    await new Promise(resolve => gates.push(resolve));
    total--; active.set(record.partition, 0);
  }, error => {throw error;});
  workers.assign([{topic: kafkaRecord().topic, partition: 0}, {topic: kafkaRecord().topic, partition: 1}]);
  workers.enqueue(kafkaRecord(0, "0")); workers.enqueue(kafkaRecord(0, "1"));
  workers.enqueue(kafkaRecord(1, "0")); workers.enqueue(kafkaRecord(1, "1"));
  assert.throws(() => workers.enqueue(kafkaRecord(1, "2")), {code: "KAFKA_QUEUE_FULL"});
  await nextTurn(); assert.deepEqual(seen, [[0,"0"],[1,"0"]]);
  assert.throws(() => workers.resetAssignment(), {code: "KAFKA_REVOKED"});
  gates[0](); await nextTurn(); assert.deepEqual(seen, [[0,"0"],[1,"0"],[0,"1"]]);
  gates[1](); await nextTurn(); assert.deepEqual(seen.at(-1), [1,"1"]);
  gates[2](); gates[3](); await nextTurn();
  assert.equal(peak, 2); assert.equal(workers.metrics().saturationTotal, 1);
  assert.throws(() => workers.enqueue(kafkaRecord(0,"0")), {code: "KAFKA_ENVELOPE_INVALID"});
  await workers.drain(); assert.equal(workers.metrics().pending, 0);
  workers.resetAssignment();
  workers.assign([{topic: kafkaRecord().topic, partition: 0}]);
  workers.enqueue(kafkaRecord(0, "0"));
  await nextTurn(); assert.deepEqual(seen.at(-1), [0, "0"]);
  gates[4](); await workers.drain();
});

void test("Kafka partition failure freezes its queue; revoke stops intake and non-cooperative work forces fail-stop", async () => {
  let release; const failures = [];
  const workers = new PartitionWorkers({maxPartitions: 1,maxInFlight: 1,queueCapacity: 2}, async () => new Promise(resolve => {release=resolve;}), error=>failures.push(error));
  workers.assign([{topic:kafkaRecord().topic,partition:0}]); workers.enqueue(kafkaRecord()); workers.enqueue(kafkaRecord(0,"1"));
  await nextTurn();
  const app=await createRuntime({name:"kafka-proof",host:"127.0.0.1",port:0,shutdownGraceMs:40,resources:[{name:"kafka",stop:()=>workers.drain(),destroy:()=>workers.abort()}]});
  await app.runtimeController.start();
  const outcome=await app.runtimeController.closeRuntime();
  assert.equal(outcome.status,"fail-stop"); assert.ok(outcome.pending.includes("stop:kafka"));
  assert.throws(()=>workers.enqueue(kafkaRecord(0,"2")),{code:"KAFKA_REVOKED"});
  release(); await workers.drain(); assert.equal(workers.metrics().pending,0); assert.equal(failures.length,0);
  assert.throws(() => workers.resetAssignment(), {code: "KAFKA_REVOKED"});
  let runs=0;
  const failed=new PartitionWorkers({maxPartitions:1,maxInFlight:1,queueCapacity:2},async()=>{runs++;throw Error("owner failure");},e=>failures.push(e));
  failed.assign([{topic:kafkaRecord().topic,partition:0}]); failed.enqueue(kafkaRecord());failed.enqueue(kafkaRecord(0,"1"));
  await nextTurn(); assert.equal(runs,1); assert.equal(failures.length,1);assert.equal(failed.metrics().queued,0);await failed.drain();
});

void test("Kafka partition workers share a bounded maxInFlight budget across groups", async () => {
  const gates = []; const seen = [];
  const budget = {active: 0, owned: 0, maxInFlight: 4, queueCapacity: 8, wake: new Set()};
  const process = async record => {seen.push(record.partition); await new Promise(resolve => gates.push(resolve));};
  const onFailure = error => {throw error;};
  const first = new PartitionWorkers({maxPartitions: 2, maxInFlight: 4, queueCapacity: 8}, process, onFailure, budget);
  const second = new PartitionWorkers({maxPartitions: 2, maxInFlight: 4, queueCapacity: 8}, process, onFailure, budget);
  first.assign([{topic: kafkaRecord().topic, partition: 0}, {topic: kafkaRecord().topic, partition: 1}]);
  second.assign([{topic: kafkaRecord().topic, partition: 2}, {topic: kafkaRecord().topic, partition: 3}]);
  first.enqueue(kafkaRecord(0)); first.enqueue(kafkaRecord(1));
  second.enqueue(kafkaRecord(2)); second.enqueue(kafkaRecord(3));
  // The two workers share four active slots; later records remain queued until a slot is released.
  first.enqueue(kafkaRecord(0, "1")); first.enqueue(kafkaRecord(1, "1"));
  second.enqueue(kafkaRecord(2, "1")); second.enqueue(kafkaRecord(3, "1"));
  await nextTurn();
  assert.deepEqual(seen.sort((left, right) => left - right), [0, 1, 2, 3]);
  assert.equal(budget.active, 4);
  assert.equal(first.metrics().queued + second.metrics().queued, 4);
  for (const release of gates.splice(0)) release();
  await nextTurn();
  for (const release of gates.splice(0)) release();
  await Promise.all([first.drain(), second.drain()]);
  assert.deepEqual(seen.sort((left, right) => left - right), [0, 0, 1, 1, 2, 2, 3, 3]);
});

void test("Kafka decode precedes Inbox; only known DB commit permits offset, duplicate/conflict skip owner", async t => {
  const order=[]; let decision="acquired", tag="COMMIT", commits=0;
  const {database}=mockDatabase(t,sql=>{if(sql==="COMMIT"){order.push("db-commit");return{rows:[],rowCount:0,command:tag};}});
  const binding={processing:"durable",database,inbox:{
    begin:async(_tx, message)=>{const envelope=kafkaEnvelope();assert.deepEqual(message.payload,envelope);assert.equal(message.payloadHash,canonicalRequestHash(envelope));assert.notEqual(message.payloadHash,canonicalRequestHash(envelope.payload));order.push("inbox");return{kind:decision};},
    markProcessed:async()=>{order.push("processed");},
    quarantineRecord:async()=>{order.push("quarantine");return "created";},
  },decode:value=>{order.push("decode");return parseEnvelope(value,p=>p);},handle:async tx=>{assert.equal(tx.state(),"Active");order.push("owner+outbox");}};
  const options={runtime:"orders-aroma-preparation",groupId:"orders-aroma-preparation-v1",topics:[kafkaRecord().topic],binding,leaseMs:30000,maxMessageBytes:1048576,signal:new AbortController().signal,commit:async()=>{commits++;order.push("offset");}};
  await processKafkaRecord(kafkaRecord(),options);
  assert.deepEqual(order,["decode","inbox","owner+outbox","processed","db-commit","offset"]);
  for(const kind of ["duplicate","conflict"]){decision=kind;order.length=0;await processKafkaRecord(kafkaRecord(),options);assert.ok(!order.includes("owner+outbox"));assert.equal(order.includes("quarantine"),kind==="conflict");}
  order.length=0; await processKafkaRecord({...kafkaRecord(),value:"broken JSON"},options);
  assert.ok(!order.includes("inbox"));assert.ok(order.includes("quarantine"));
  const malformedUtf8 = Uint8Array.from([
    ...Buffer.from('{"envelopeVersion":"1","messageId":"m1","messageType":"OrderConfirmed","occurredAt":"2026-01-01T00:00:00Z","producer":"orders-service","correlationId":"c1","causationId":null,"traceparent":"00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01","aggregate":{"type":"Order","ref":"ord_1","version":"1"},"payload":"'),
    0xff,
    ...Buffer.from('"}'),
  ]);
  order.length = 0;
  await processKafkaRecord({...kafkaRecord(), value: malformedUtf8}, options);
  assert.ok(!order.includes("inbox")); assert.ok(order.includes("quarantine"));
  for (const messageId of [null, "wrong-id"]) {
    order.length = 0;
    await processKafkaRecord({...kafkaRecord(), headers: {messageId}}, options);
    assert.deepEqual(order, ["decode", "quarantine", "db-commit", "offset"]);
  }
  const quarantine = t.mock.method(binding.inbox, "quarantineRecord", async () => {throw Error("quarantine unavailable");});
  const beforeQuarantineFailure = commits;
  await assert.rejects(processKafkaRecord({...kafkaRecord(), value: "broken JSON"}, options));
  assert.equal(commits, beforeQuarantineFailure);
  quarantine.mock.restore();
  decision="acquired";tag="ROLLBACK";const before=commits;
  await assert.rejects(processKafkaRecord(kafkaRecord(),options),{code:"DB_TRANSACTION_ROLLED_BACK"});assert.equal(commits,before);
  tag="COMMIT";decision="in_progress";await assert.rejects(processKafkaRecord(kafkaRecord(),options),{code:"KAFKA_HANDLER_FAILED"});assert.equal(commits,before);
  decision="acquired";await assert.rejects(processKafkaRecord(kafkaRecord(),{...options,commit:async()=>{throw Error("lost ack");}}),{code:"OFFSET_COMMIT_OUTCOME_UNKNOWN"});
  await database.resource.stop(new AbortController().signal);
});

void test("Kafka directional config and realtime bypass fail closed before native connect", async () => {
  const config=parsePlatformConfig(parseYaml(readFileSync(new URL("../../../config/platform.yaml",import.meta.url),"utf8")));
  const options={runtime:"orders-service",config:config.kafka,service:config.services["orders-service"].kafka,credentials:{username:"u",password:"p",caPem:"test-ca"}};
  assert.equal(validateKafkaRuntimeConfig(options).config.autoTopicCreation,false);
  assert.deepEqual(validateKafkaRuntimeConfig({...options, credentials: {username: "u", password: "p"}}).credentials, {username: "u", password: "p"});
  assert.throws(() => validateKafkaRuntimeConfig({...options, credentials: {username: "u", password: "p", caPem: ""}}), {code: "KAFKA_CONFIG_INVALID"});
  assert.throws(()=>validateKafkaRuntimeConfig({...options,config:{...config.kafka,autoTopicCreation:true}}),{code:"KAFKA_CONFIG_INVALID"});
  assert.throws(()=>validateKafkaRuntimeConfig({...options,service:{producers:[],consumers:[{groupId:"g",topics:[kafkaRecord().topic],processing:"realtime"}]}}),{code:"KAFKA_CONFIG_INVALID"});
  let runs=0;
  await assert.rejects(processKafkaRecord(kafkaRecord(),{runtime:"orders-service",groupId:"g",topics:[kafkaRecord().topic],binding:{processing:"realtime",decode:v=>v,enqueue:async()=>{runs++;}},signal:new AbortController().signal,leaseMs:30000,maxMessageBytes:10000,commit:async()=>{runs++;}}),{code:"KAFKA_CONFIG_INVALID"});
  assert.equal(runs,0);
  const runtime = createKafkaRuntime(options);
  await assert.rejects(runtime.relay({}, {}), {code:"KAFKA_STOPPED"});
  runtime.resource.destroy();
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

function cloneDeliveryState(state) {
  const cloneRows = rows => new Map([...rows].map(([key, row]) => [key, {...row}]));
  return {inbox: cloneRows(state.inbox), quarantine: cloneRows(state.quarantine), outbox: cloneRows(state.outbox)};
}

function deliverySqlDatabase(t) {
  let durable = {inbox: new Map(), quarantine: new Map(), outbox: new Map()};
  let working;
  let clockMs = 0;
  const result = (rows = [], rowCount = rows.length, command = null) => ({rows, rowCount, ...(command === null ? {} : {command})});
  const cloneJson = value => value === null ? null : JSON.parse(value);
  const sameSequence = (left, right) => String(left) === String(right);
  const database = mockDatabase(t, (sql, values) => {
    if (sql === "BEGIN") {working = cloneDeliveryState(durable); return result([], 0, "BEGIN");}
    if (sql === "COMMIT") {durable = cloneDeliveryState(working); working = undefined; return result([], 0, "COMMIT");}
    if (sql === "ROLLBACK") {working = undefined; return result([], 0, "ROLLBACK");}
    if (working === undefined) return undefined;

    if (sql.includes('"inbox_quarantine"')) {
      const key = `${values[0]}\u0000${values[1]}\u0000${values[2]}`;
      if (sql.startsWith("INSERT")) {
        if (working.quarantine.has(key)) return result();
        working.quarantine.set(key, {topic: values[0], partition: values[1], offset: values[2], message_id: values[3], message_type: values[4], payload_hash: values[5], envelope: cloneJson(values[6]), reason: values[7]});
        return result([{topic: values[0]}]);
      }
      const row = working.quarantine.get(key);
      return result(row === undefined ? [] : [row]);
    }
    if (sql.includes('"inbox_messages"')) {
      const messageId = String(values[0]);
      if (sql.startsWith("INSERT")) {
        if (working.inbox.has(messageId)) return result();
        clockMs = Number(values[6]) - 1;
        working.inbox.set(messageId, {message_id: values[0], message_type: values[1], received_at: String(values[2]).replace("T", " ").replace(/Z$/, "+00"), payload: cloneJson(values[3]), payload_hash: values[4], state: "Processing", lease_owner: values[5], lease_until_ms: Number(values[6]), attempt: 1, processed_at: null, quarantine_reason: null});
        return result([{message_id: values[0]}]);
      }
      if (sql.startsWith("SELECT")) {
        const row = working.inbox.get(messageId);
        return result(row === undefined ? [] : [row]);
      }
      const row = working.inbox.get(messageId);
      if (row === undefined) return result();
      if (sql.includes("SET lease_owner")) {
        if (row.state !== "Processing" || row.lease_until_ms > clockMs) return result();
        Object.assign(row, {lease_owner: values[1], lease_until_ms: Number(values[2]), attempt: row.attempt + 1});
        return result([row]);
      }
      if (sql.includes("SET state = 'Processed'")) {
        if (row.state !== "Processing" || row.lease_owner !== values[1] || row.lease_until_ms <= clockMs) return result();
        Object.assign(row, {state: "Processed", lease_owner: "", processed_at: values[2]});
        return result([{message_id: values[0]}]);
      }
      if (sql.includes("SET state = 'Quarantined'")) {
        if (row.state !== "Processing" || row.lease_owner !== values[1] || row.lease_until_ms <= clockMs) return result();
        Object.assign(row, {state: "Quarantined", lease_owner: "", quarantine_reason: values[2]});
        return result([{message_id: values[0]}]);
      }
      if (sql.startsWith("DELETE")) {
        if (row.state !== "Processing" || row.lease_owner !== values[1] || row.lease_until_ms <= clockMs) return result();
        working.inbox.delete(messageId);
        return result([{message_id: values[0]}]);
      }
      return undefined;
    }
    if (sql.includes('"outbox_messages"')) {
      if (sql.startsWith("SELECT")) {
        if (sql.includes("WHERE message_id")) {
          const row = working.outbox.get(String(values[0]));
          if (row === undefined) return result();
          return result([{payload_hash: row.payload_hash, message_type: row.message_type, topic: row.topic, aggregate_ref: row.aggregate_ref, aggregate_sequence: row.aggregate_sequence, owner_version: row.owner_version, envelope: row.envelope, partition_key: row.partition_key, schema_version: row.schema_version}]);
        }
        const rows = [...working.outbox.values()].filter(row => row.aggregate_ref === values[0]).sort((left, right) => Number(right.aggregate_sequence) - Number(left.aggregate_sequence));
        return result(rows.length === 0 ? [] : [{aggregate_sequence: rows[0].aggregate_sequence}]);
      }
      if (sql.startsWith("INSERT")) {
        const messageId = String(values[0]);
        const conflict = working.outbox.has(messageId) || [...working.outbox.values()].some(row => row.aggregate_ref === values[3] && sameSequence(row.aggregate_sequence, values[4]));
        if (conflict) return result();
        working.outbox.set(messageId, {message_id: values[0], message_type: values[1], topic: values[2], aggregate_ref: values[3], aggregate_sequence: values[4], owner_version: values[5], partition_key: values[6], schema_version: values[7], envelope: cloneJson(values[8]), payload: cloneJson(values[9]), payload_hash: values[10], occurred_at: String(values[11]).replace("T", " ").replace(/Z$/, "+00"), correlation_id: values[12], causation_id: values[13], traceparent: values[14], state: "Pending", lease_owner: "", lease_token: 0n, lease_until_ms: 0, attempt: 0, next_attempt_at_ms: 0, last_error: null});
        return result([{message_id: values[0]}]);
      }
      if (sql.startsWith("WITH")) {
        const nowMs = Number(values[0]);
        const leaseUntilMs = Number(values[1]);
        const leaseOwner = values[2];
        const limit = Number(values[3]);
        clockMs = nowMs;
        const candidates = [...working.outbox.values()].filter(row => (row.state === "Pending" || (row.state === "Publishing" && row.lease_until_ms <= nowMs)) && row.next_attempt_at_ms <= nowMs && ![...working.outbox.values()].some(predecessor => predecessor.aggregate_ref === row.aggregate_ref && Number(predecessor.aggregate_sequence) < Number(row.aggregate_sequence) && predecessor.state !== "Published")).sort((left, right) => Number(left.next_attempt_at_ms) - Number(right.next_attempt_at_ms) || String(left.aggregate_ref).localeCompare(String(right.aggregate_ref)) || Number(left.aggregate_sequence) - Number(right.aggregate_sequence) || String(left.message_id).localeCompare(String(right.message_id))).slice(0, limit);
        for (const row of candidates) Object.assign(row, {state: "Publishing", lease_owner: leaseOwner, lease_token: BigInt(row.attempt + 1), lease_until_ms: leaseUntilMs, attempt: row.attempt + 1});
        return result(candidates);
      }
      const messageId = String(values[0]);
      const row = working.outbox.get(messageId);
      if (row === undefined) return result();
      if (sql.includes("SET state = 'Published'")) {
        if (row.state !== "Publishing" || row.lease_owner !== values[1] || String(row.lease_token) !== String(values[2]) || row.lease_until_ms <= clockMs) return result();
        Object.assign(row, {state: "Published", lease_owner: ""});
        return result([{message_id: values[0]}]);
      }
      if (sql.includes("SET state = CASE")) {
        if (row.state !== "Publishing" || row.lease_owner !== values[1] || String(row.lease_token) !== String(values[2]) || row.lease_until_ms <= clockMs) return result();
        const permanent = values[5] === true;
        Object.assign(row, {state: permanent ? "Quarantined" : "Pending", lease_owner: "", next_attempt_at_ms: Number(values[4]), last_error: values[3]});
        return result([{state: row.state}]);
      }
      return undefined;
    }
    return undefined;
  }).database;
  return {database, snapshot: () => cloneDeliveryState(durable)};
}

function outboxFixture(messageId, aggregateRef, aggregateSequence, payload = {value: messageId}) {
  const messageType = "Issue63.TestEvent";
  const occurredAt = "2026-01-01T00:00:00.123456789Z";
  const correlationId = `correlation-${messageId}`;
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const ownerVersion = "1";
  return {messageId, messageType, topic: "coffee.issue63.test.v1", aggregateRef, aggregateSequence, ownerVersion, partitionKey: aggregateRef, schemaVersion: "1", envelope: {envelopeVersion: "1", messageId, messageType, occurredAt, producer: "platform-testing", correlationId, causationId: null, traceparent, aggregate: {type: "Issue63Aggregate", ref: aggregateRef, version: ownerVersion}, payload}, payload, occurredAt, correlationId, traceparent};
}

function inboxFixture(message) {
  return {messageId: message.messageId, messageType: message.messageType, receivedAt: message.occurredAt, payloadHash: canonicalRequestHash(message.envelope), payload: message.envelope};
}

void test("SQL Outbox keeps one aggregate ordered while independent aggregates progress", async t => {
  const {database, snapshot} = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);
  const messages = [
    outboxFixture("aggregate-a-1", "aggregate-a", 1),
    outboxFixture("aggregate-a-2", "aggregate-a", 2),
    outboxFixture("aggregate-b-1", "aggregate-b", 1),
    outboxFixture("aggregate-b-2", "aggregate-b", 2),
  ];
  await withTransaction(database, {mode: "interactive"}, async transaction => {
    for (const message of messages) assert.equal(await store.enqueue(transaction, message), "created");
  });
  const first = await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 100, "publisher-a", 2, 1_000));
  assert.deepEqual(first.map(claim => claim.message.messageId).sort(), ["aggregate-a-1", "aggregate-b-1"]);
  const blocked = await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 100, "publisher-b", 2, 1_000));
  assert.deepEqual(blocked, []);
  const firstById = new Map(first.map(claim => [claim.message.messageId, claim]));
  await withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, "aggregate-b-1", firstById.get("aggregate-b-1").leaseOwner, firstById.get("aggregate-b-1").leaseToken));
  const independent = await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 100, "publisher-b", 2, 1_000));
  assert.deepEqual(independent.map(claim => claim.message.messageId), ["aggregate-b-2"]);
  await withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, "aggregate-b-2", independent[0].leaseOwner, independent[0].leaseToken));
  await withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, "aggregate-a-1", firstById.get("aggregate-a-1").leaseOwner, firstById.get("aggregate-a-1").leaseToken));
  const ordered = await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 100, "publisher-a", 2, 1_000));
  assert.deepEqual(ordered.map(claim => claim.message.messageId), ["aggregate-a-2"]);
  await withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, "aggregate-a-2", ordered[0].leaseOwner, ordered[0].leaseToken));
  assert.deepEqual([...snapshot().outbox.values()].map(row => row.state), ["Published", "Published", "Published", "Published"]);
});

void test("SQL Outbox preserves stable messageId, recovers expired lease and fences stale finalize", async t => {
  const {database, snapshot} = deliverySqlDatabase(t);
  const store = createSqlOutboxStore(database);
  const leaseMessage = outboxFixture("stable-lease-id", "aggregate-lease", 1);
  await withTransaction(database, {mode: "background"}, transaction => store.enqueue(transaction, leaseMessage));
  await withTransaction(database, {mode: "background"}, async transaction => assert.equal(await store.enqueue(transaction, leaseMessage), "duplicate"));
  const reorderedEnvelope = {payload: leaseMessage.payload, aggregate: leaseMessage.envelope.aggregate, traceparent: leaseMessage.traceparent, causationId: null, correlationId: leaseMessage.correlationId, producer: "platform-testing", occurredAt: leaseMessage.occurredAt, messageType: leaseMessage.messageType, messageId: leaseMessage.messageId, envelopeVersion: "1"};
  await withTransaction(database, {mode: "background"}, async transaction => assert.equal(await store.enqueue(transaction, {...leaseMessage, envelope: reorderedEnvelope}), "duplicate"));
  const changedEnvelope = {...leaseMessage, envelope: {...leaseMessage.envelope, producer: "other-producer"}};
  await withTransaction(database, {mode: "background"}, async transaction => assert.equal(await store.enqueue(transaction, changedEnvelope), "conflict"));
  const changedPayload = {...leaseMessage, envelope: {...leaseMessage.envelope, payload: {value: "different"}}};
  await assert.rejects(withTransaction(database, {mode: "background"}, transaction => store.enqueue(transaction, changedPayload)), {code: "OUTBOX_INVALID"});
  const changedCorrelation = {...leaseMessage, envelope: {...leaseMessage.envelope, correlationId: "other-correlation"}};
  await assert.rejects(withTransaction(database, {mode: "background"}, transaction => store.enqueue(transaction, changedCorrelation)), {code: "OUTBOX_INVALID"});
  const oldClaim = (await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 100, "publisher-old", 1, 10)))[0];
  assert.equal(oldClaim.message.messageId, leaseMessage.messageId);
  const recovered = (await withTransaction(database, {mode: "background"}, transaction => store.claim(transaction, 111, "publisher-new", 1, 100)))[0];
  assert.equal(recovered.message.messageId, leaseMessage.messageId);
  assert.equal(recovered.attempt, oldClaim.attempt + 1);
  assert.notEqual(recovered.leaseToken, oldClaim.leaseToken);
  await assert.rejects(withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, oldClaim.message.messageId, oldClaim.leaseOwner, oldClaim.leaseToken)), {code: "OUTBOX_LEASE_INVALID"});
  await withTransaction(database, {mode: "background"}, transaction => store.finalize(transaction, recovered.message.messageId, recovered.leaseOwner, recovered.leaseToken));

  const relayMessage = outboxFixture("relay-stable-id", "aggregate-relay", 1);
  await withTransaction(database, {mode: "background"}, transaction => store.enqueue(transaction, relayMessage));
  const sent = [];
  const relayResult = await relayOutboxBatch(store, database, async (claim, signal) => {
    assert.equal(signal.aborted, false);
    sent.push({messageId: claim.message.messageId, envelopeMessageId: claim.message.envelope.messageId, occurredAt: claim.message.envelope.occurredAt, causationId: claim.message.envelope.causationId});
    return {kind: "ack"};
  }, {nowMs: 200, leaseOwner: "publisher-relay", policy: {leaseMs: 100, sendTimeoutMs: 50, maxInFlight: 2, retry: {baseMs: 1, maxMs: 10, maxAttempts: 3}}});
  assert.deepEqual(sent, [{messageId: relayMessage.messageId, envelopeMessageId: relayMessage.messageId, occurredAt: relayMessage.occurredAt, causationId: null}]);
  assert.deepEqual(relayResult, {claimed: 1, published: 1, failed: 0, unknown: 0, quarantined: 0});
  assert.equal(snapshot().outbox.get(relayMessage.messageId).state, "Published");

  // A batch cannot start more native sends than maxInFlight, even with more ready rows.
  for (const id of ["bounded-a", "bounded-b", "bounded-c"]) {
    await withTransaction(database, {mode: "background"}, transaction => store.enqueue(transaction, outboxFixture(id, id, 1)));
  }
  const {promise: sendGate, resolve: releaseSends} = Promise.withResolvers();
  let activeSends = 0;
  const boundedBatch = relayOutboxBatch(store, database, async () => {
    activeSends++;
    await sendGate;
    activeSends--;
    return {kind: "unknown"};
  }, {nowMs: 300, leaseOwner: "publisher-bounded", policy: {leaseMs: 100, sendTimeoutMs: 1_000, maxInFlight: 2, retry: {baseMs: 1, maxMs: 10, maxAttempts: 3}}});
  try {
    for (let tick = 0; tick < 20 && activeSends < 2; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeSends, 2);
    assert.equal([...snapshot().outbox.values()].filter(row => row.state === "Pending").length, 1);
  } finally {
    releaseSends();
  }
  assert.deepEqual(await boundedBatch, {claimed: 2, published: 0, failed: 0, unknown: 2, quarantined: 0});
  assert.equal(activeSends, 0);
});

void test("Inbox consumeOnce rollback leaves no partial Inbox/Outbox mark and permits retry", async t => {
  const {database, snapshot} = deliverySqlDatabase(t);
  const inbox = createSqlInboxStore(database);
  const outbox = createSqlOutboxStore(database);
  const message = outboxFixture("rollback-handler", "aggregate-rollback", 1);
  const inboxMessage = inboxFixture(message);
  let handlers = 0;
  await assert.rejects(withTransaction(database, {mode: "interactive"}, transaction => consumeOnce(inbox, transaction, inboxMessage, "consumer-a", 1_000, 10_000, async tx => {
    handlers += 1;
    assert.equal(await outbox.enqueue(tx, message), "created");
    throw new Error("handler failed before durable mark");
  }, "2026-01-01T00:00:00Z")), /handler failed before durable mark/);
  assert.equal(handlers, 1);
  assert.equal(snapshot().inbox.size, 0);
  assert.equal(snapshot().outbox.size, 0);

  const result = await withTransaction(database, {mode: "interactive"}, transaction => consumeOnce(inbox, transaction, inboxMessage, "consumer-retry", 1_000, 10_000, async tx => {
    assert.equal(await outbox.enqueue(tx, message), "created");
  }, "2026-01-01T00:00:00Z"));
  assert.deepEqual(result, {kind: "processed"});
  assert.equal(snapshot().inbox.get(message.messageId).state, "Processed");
  assert.equal(snapshot().outbox.get(message.messageId).state, "Pending");
});

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
