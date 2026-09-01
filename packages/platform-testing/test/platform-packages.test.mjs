import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
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
import { withTransaction } from "../../platform-database/src/index.ts";
import {
  applyMigrations,
  migrationChecksum,
} from "../../platform-migrations/src/index.ts";
import { InMemoryIdempotencyStore } from "../../platform-idempotency/src/index.ts";
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
    platform: {},
    postgres: {},
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

void test("database transaction commits and rolls back with release", async () => {
  const statements = [];
  let released = 0;
  const connection = {
    query: async (text) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released += 1;
    },
  };
  const pool = { connect: async () => connection };
  await withTransaction(
    pool,
    {
      lockTimeoutMs: 250,
      statementTimeoutMs: 1500,
      idleInTransactionSessionTimeoutMs: 30000,
    },
    async () => "ok",
  );
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(released, 1);
  await assert.rejects(
    withTransaction(
      pool,
      {
        lockTimeoutMs: 250,
        statementTimeoutMs: 1500,
        idleInTransactionSessionTimeoutMs: 30000,
      },
      async () => {
        throw new Error("boom");
      },
    ),
  );
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(released, 2);
});

void test("migrations validate checksums and apply only pending entries", async () => {
  const migration = {
    id: "0001_initial",
    sql: "CREATE TABLE test();",
    checksum: migrationChecksum("CREATE TABLE test();"),
  };
  const applied = [];
  const store = {
    readApplied: async () => [],
    apply: async (entry) => {
      applied.push(entry.id);
    },
  };
  assert.deepEqual(await applyMigrations(store, [migration]), ["0001_initial"]);
  assert.deepEqual(applied, ["0001_initial"]);
});

void test("idempotency replays completed requests and rejects hash conflicts", async () => {
  const store = new InMemoryIdempotencyStore();
  const identity = { actorRef: "actor", scope: "customers:create", key: "key" };
  assert.equal(
    (await store.acquire(identity, "hash", "lease-1", 0, 30000, 86400000)).kind,
    "acquired",
  );
  await store.complete(identity, "lease-1", {
    status: 201,
    body: { resource: "cus_1" },
  });
  assert.equal(
    (await store.acquire(identity, "hash", "lease-2", 1, 30000, 86400000)).kind,
    "replay",
  );
  assert.equal(
    (await store.acquire(identity, "other", "lease-2", 1, 30000, 86400000))
      .kind,
    "conflict",
  );
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
