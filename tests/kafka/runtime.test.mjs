import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import pg from "pg";
import { load as parseYaml } from "js-yaml";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { InboxProcessingError } from "../../packages/platform-inbox/dist/index.js";
import {
  createNativeConsumer,
  createNativeProducer,
} from "../../packages/platform-kafka-runtime/dist/native.js";
import {
  KafkaRuntimeError,
  PartitionWorkers,
  createKafkaRuntime,
  parseEnvelope,
  processKafkaRecord,
  validateKafkaRuntimeConfig,
  validateTransport,
} from "../../packages/platform-kafka-runtime/dist/index.js";
import { parsePlatformConfig } from "../../packages/platform-config/dist/index.js";
import { deriveRuntimeKafkaTarget } from "../../packages/platform-config/dist/index.js";
import { metrics, trace } from "@opentelemetry/api";
const subject = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const value = {
  envelopeVersion: "1",
  messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB1",
  messageType: "RealtimeInvalidated.v1",
  occurredAt: "2026-09-05T10:06:00Z",
  producer: "orders-service",
  correlationId: "77777777-7777-4777-8777-777777777777",
  causationId: null,
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  aggregate: { type: "Order", ref: subject, version: "19" },
  payload: {
    subjectType: "order",
    subjectRef: subject,
    ownerVersion: "19",
    reason: "OrderChanged",
  },
};
const record = {
  topic: "coffee.realtime.invalidate.v1",
  partition: 0,
  offset: "1",
  key: subject,
  value: JSON.stringify(value),
  headers: {},
};

void test("Kafka envelope and transport validation reject each malformed field", () => {
  const envelope = parseEnvelope(value, (payload) => payload);
  assert.deepEqual(envelope, value, "valid envelope is the positive baseline");
  const invalidEnvelopes = [
    ["non-object envelope", null],
    ["missing field", (({ producer: _producer, ...rest }) => rest)(value)],
    ["extra field", { ...value, unexpected: true }],
    ["wrong version", { ...value, envelopeVersion: "2" }],
    ["non-object aggregate", { ...value, aggregate: null }],
    [
      "extra aggregate field",
      { ...value, aggregate: { ...value.aggregate, id: "x" } },
    ],
    ["invalid timestamp", { ...value, occurredAt: "yesterday" }],
    ["invalid traceparent", { ...value, traceparent: "00-invalid" }],
    ...[
      "messageId",
      "messageType",
      "occurredAt",
      "producer",
      "correlationId",
      "traceparent",
    ].flatMap((field) => [
      [`${field} empty`, { ...value, [field]: "" }],
      [`${field} control character`, { ...value, [field]: "bad\u0001value" }],
      [`${field} too long`, { ...value, [field]: "x".repeat(257) }],
    ]),
    ["causation id empty", { ...value, causationId: "" }],
    [
      "aggregate type invalid",
      { ...value, aggregate: { ...value.aggregate, type: 1 } },
    ],
  ];
  for (const [label, invalid] of invalidEnvelopes)
    assert.throws(
      () => parseEnvelope(invalid, (payload) => payload),
      { code: "KAFKA_ENVELOPE_INVALID" },
      label,
    );

  const transport = { ...record, offset: "0", key: subject };
  assert.doesNotThrow(
    () => validateTransport(transport, envelope),
    "valid transport is the positive baseline",
  );
  for (const [label, invalidRecord] of [
    ["topic characters", { ...transport, topic: "bad topic" }],
    ["negative partition", { ...transport, partition: -1 }],
    ["fractional partition", { ...transport, partition: 0.5 }],
    ["non-canonical offset", { ...transport, offset: "00" }],
    ["empty key", { ...transport, key: "" }],
    ["oversized key", { ...transport, key: "x".repeat(257) }],
    ["null message header", { ...transport, headers: { messageId: null } }],
    [
      "conflicting correlation header",
      { ...transport, headers: { correlationId: "other" } },
    ],
  ])
    assert.throws(
      () => validateTransport(invalidRecord, envelope),
      { code: "KAFKA_ENVELOPE_INVALID" },
      label,
    );
});

void test("partition workers preserve serial ownership and fail closed on invalid assignments", async () => {
  const processed = [];
  const failures = [];
  const workers = new PartitionWorkers(
    { maxPartitions: 1, maxInFlight: 1, queueCapacity: 1 },
    async (entry) => processed.push(entry.offset),
    (error, entry) => failures.push({ error, offset: entry.offset }),
  );
  workers.assign([{ topic: record.topic, partition: 0 }]);
  workers.enqueue({ ...record, offset: "1" });
  await workers.drain();
  assert.deepEqual(processed, ["1"], "valid assigned work completes once");
  assert.deepEqual(workers.metrics(), {
    assigned: 1,
    active: 0,
    queued: 0,
    pending: 0,
    capacity: 1,
    saturationTotal: 0,
  });
  assert.deepEqual(failures, []);

  assert.throws(
    () => workers.enqueue({ ...record, offset: "2" }),
    { code: "KAFKA_REVOKED" },
    "drain stops intake",
  );
  workers.resetAssignment();
  workers.assign([{ topic: record.topic, partition: 1 }]);
  workers.enqueue({ ...record, partition: 1, offset: "2" });
  await workers.drain();
  assert.deepEqual(processed, ["1", "2"], "a drained assignment can reset");

  const duplicate = new PartitionWorkers(
    { maxPartitions: 2, maxInFlight: 1, queueCapacity: 2 },
    async () => {},
    () => {},
  );
  assert.throws(
    () =>
      duplicate.assign([
        { topic: record.topic, partition: 0 },
        { topic: record.topic, partition: 0 },
      ]),
    { code: "KAFKA_CONFIG_INVALID" },
    "duplicate assignment is rejected",
  );

  const blocked = new Promise(() => {});
  const queued = new PartitionWorkers(
    { maxPartitions: 1, maxInFlight: 1, queueCapacity: 1 },
    async () => blocked,
    () => {},
  );
  queued.assign([{ topic: record.topic, partition: 0 }]);
  queued.enqueue({ ...record, offset: "1" });
  assert.throws(
    () => queued.resetAssignment(),
    { code: "KAFKA_REVOKED" },
    "an assignment cannot reset while it owns in-flight work",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(
    () => queued.assign([{ topic: record.topic, partition: 1 }]),
    { code: "KAFKA_CONFIG_INVALID" },
    "assignment cannot replace owned work",
  );
  assert.throws(
    () => queued.enqueue({ ...record, offset: "2" }),
    { code: "KAFKA_QUEUE_FULL" },
    "capacity rejects additional owned work",
  );
  assert.equal(queued.metrics().saturationTotal, 1);
  queued.abort();
});

void test("native Kafka configuration accepts a valid baseline and rejects each invalid field", async () => {
  const nativeKey = Symbol.for("coffee.native-config-mutation-regression");
  globalThis[nativeKey] = {
    Producer: class extends EventEmitter {
      disconnect(callback) {
        callback(null);
      }
    },
    KafkaConsumer: class extends EventEmitter {
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      commitCb(_offsets, callback) {
        callback(null);
      }
      disconnect(callback) {
        callback(null);
      }
    },
  };
  const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.native-config-mutation-regression")];export default {RdKafka};')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "@confluentinc/kafka-javascript"
        ? { url, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const common = {
    brokers: ["fixture:9092"],
    clientId: "native-config-mutation-regression",
    protocol: "PLAINTEXT",
    maxPending: 4,
    maxMessageBytes: 2048,
    sendTimeoutMs: 1000,
    receiveTimeoutMs: 1000,
    commitTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  };
  const assertInvalid = async (
    label,
    overrides,
    create = createNativeProducer,
  ) => {
    await assert.rejects(
      create({ ...common, producerRetries: 1, ...overrides }),
      { code: "NATIVE_CONFIG_INVALID" },
      label,
    );
  };
  try {
    const producer = await createNativeProducer({
      ...common,
      producerRetries: 1,
      protocol: "SASL_SSL",
      username: "fixture-user",
      password: "fixture-password",
      sslCaPem: "fixture-ca",
    });
    await producer.close();
    const consumer = await createNativeConsumer(
      {
        ...common,
        groupId: "fixture-group",
        topics: [record.topic],
        autoOffsetReset: "latest",
      },
      () => {},
    );
    await consumer.close();

    for (const [label, overrides] of [
      ["missing brokers", { brokers: [] }],
      ["malformed broker", { brokers: [""] }],
      ["empty client id", { clientId: "" }],
      ["unsupported protocol", { protocol: "PLAINTEXTS" }],
      ["username without password", { username: "user" }],
      ["empty CA", { sslCaPem: "" }],
      ["invalid max pending", { maxPending: 0 }],
      [
        "invalid max message size",
        { maxMessageBytes: Number.MAX_SAFE_INTEGER + 1 },
      ],
      ["invalid send timeout", { sendTimeoutMs: 0 }],
      ["invalid receive timeout", { receiveTimeoutMs: 0 }],
      ["invalid commit timeout", { commitTimeoutMs: 0 }],
      ["invalid shutdown timeout", { shutdownTimeoutMs: 0 }],
      [
        "queue byte budget overflow",
        {
          maxPending: Number.MAX_SAFE_INTEGER,
          maxMessageBytes: Number.MAX_SAFE_INTEGER,
        },
      ],
      ["invalid producer retry count", { producerRetries: 0 }],
      ["SASL_SSL without credentials", { protocol: "SASL_SSL" }],
    ])
      await assertInvalid(label, overrides);

    for (const [label, overrides] of [
      ["empty group id", { groupId: "" }],
      ["empty topics", { topics: [] }],
      ["malformed topic", { topics: [""] }],
      ["unsupported offset reset", { autoOffsetReset: "earliest" }],
    ])
      await assertInvalid(
        label,
        {
          groupId: "fixture-group",
          topics: [record.topic],
          autoOffsetReset: "latest",
          ...overrides,
        },
        (options) => createNativeConsumer(options, () => {}),
      );
  } finally {
    hook.deregister();
    delete globalThis[nativeKey];
  }
});

void test("Kafka runtime configuration freezes credentials and rejects invalid options", () => {
  const config = parsePlatformConfig(
    parseYaml(
      readFileSync(
        new URL("../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const input = {
    runtime: "realtime-gateway",
    config: config.kafka,
    service: config.services["realtime-gateway"].kafka,
    credentials: { username: "unit-user", password: "unit-password" },
  };
  const validated = validateKafkaRuntimeConfig(input);
  assert.deepEqual(validated.credentials, input.credentials);
  assert.notEqual(validated.credentials, input.credentials);
  assert.equal(Object.isFrozen(validated.credentials), true);

  for (const [label, overrides] of [
    ["unsupported runtime", { runtime: "unknown-service" }],
    [
      "invalid Kafka config",
      { config: { ...input.config, clientProtocol: "PLAINTEXT" } },
    ],
    [
      "mismatched service config",
      { service: config.services["orders-service"].kafka },
    ],
    ["missing credentials", { credentials: null }],
    ["empty username", { credentials: { ...input.credentials, username: "" } }],
    ["empty password", { credentials: { ...input.credentials, password: "" } }],
    ["empty CA material", { credentials: { ...input.credentials, caPem: "" } }],
  ])
    assert.throws(
      () => validateKafkaRuntimeConfig({ ...input, ...overrides }),
      { code: "KAFKA_CONFIG_INVALID" },
      label,
    );
});

void test("realtime transport quarantines malformed and oversized wire before commit", async () => {
  const baseline = options();
  await processKafkaRecord(record, baseline);
  assert.deepEqual(baseline.seen, ["enqueue", "offset"]);

  const cases = [
    ["invalid utf8", Buffer.from([0xff]), 1024],
    ["oversized bytes", Buffer.alloc(1025, 0x61), 1024],
    ["oversized string", "x".repeat(1025), 1024],
    ["oversized object", value, 5],
    ["malformed json", "{", 1024],
  ];
  for (const [label, wire, maxMessageBytes] of cases) {
    const effects = [];
    let quarantined;
    await processKafkaRecord(
      { ...record, value: wire },
      options({
        maxMessageBytes,
        binding: {
          processing: "realtime",
          decode: (decoded) => decoded,
          enqueue: async () => assert.fail("invalid record must not enqueue"),
        },
        quarantine: async (entry, reason, storedWire) => {
          quarantined = { entry, reason, storedWire };
          effects.push("quarantine");
        },
        commit: async () => effects.push("offset"),
      }),
    );
    assert.deepEqual(effects, ["quarantine", "offset"], "record ACK order");
    assert.equal(quarantined.reason, "KAFKA_ENVELOPE_INVALID", label);
    if (label.startsWith("oversized") || label === "invalid utf8") {
      assert.deepEqual(Object.keys(quarantined.storedWire), ["digest"]);
      assert.match(quarantined.storedWire.digest, /^[0-9a-f]{64}$/u);
      assert.equal(
        JSON.stringify(quarantined.storedWire).includes("x".repeat(20)),
        false,
      );
    }
  }
});

void test("Kafka runtime reports stopped and empty-service readiness correctly", async () => {
  const config = parsePlatformConfig(
    parseYaml(
      readFileSync(
        new URL("../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    ),
  );
  const empty = createKafkaRuntime({
    runtime: "api-public",
    config: config.kafka,
    service: config.services["api-public"].kafka,
    credentials: { username: "unit-user", password: "unit-password" },
  });
  assert.equal(await empty.readiness.check(AbortSignal.timeout(1000)), false);
  await empty.resource.start(AbortSignal.timeout(1000));
  assert.equal(await empty.readiness.check(AbortSignal.timeout(1000)), false);
  await assert.rejects(empty.resource.start(AbortSignal.timeout(1000)), {
    code: "KAFKA_STOPPED",
  });
  await empty.resource.stop(AbortSignal.timeout(1000));
  assert.equal(await empty.readiness.check(AbortSignal.timeout(1000)), false);

  const orders = createKafkaRuntime({
    runtime: "orders-service",
    config: config.kafka,
    service: config.services["orders-service"].kafka,
    credentials: { username: "unit-user", password: "unit-password" },
  });
  await assert.rejects(
    orders.send(
      config.services["orders-service"].kafka.producers[0],
      subject,
      value,
    ),
    { code: "KAFKA_STOPPED" },
    "an authorized send still requires the producer resource to start",
  );
  await assert.rejects(orders.relay({}, {}, AbortSignal.timeout(1000)), {
    code: "KAFKA_STOPPED",
  });
  orders.resource.destroy();
});

void test("durable Kafka records commit only after confirmed Inbox outcomes", async (t) => {
  const timeline = [];
  const connection = () => {
    const client = new EventEmitter();
    client.query = async (statement) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(statement))
        timeline.push(`sql:${statement}`);
      return { command: statement.split(/\s/u, 1)[0] };
    };
    client.release = () => {};
    return client;
  };
  t.mock.method(pg.Pool.prototype, "connect", async () => connection());
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const database = createDatabase({
    owner: "orders-service",
    database: "coffee_verify_orders",
    allowedDatabase: "coffee_verify_orders",
    host: "127.0.0.1",
    port: 5432,
    user: "orders-unit",
    password: "orders-unit-only",
    ssl: false,
    pool: {
      max: 1,
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

  const effect = (name) => timeline.push(`effect:${name}`);
  let beginResult = { kind: "acquired" };
  let handle = async () => effect("handle");
  const inbox = {
    begin: async () => {
      effect("begin");
      return beginResult;
    },
    markProcessed: async () => effect("processed"),
    quarantine: async (_transaction, _id, _group, reason) =>
      effect(`quarantine:${reason}`),
    quarantineRecord: async (_transaction, entry) => {
      effect(`record:${entry.reason}`);
      return "inserted";
    },
  };
  const durable = () => ({
    runtime: "orders-service",
    groupId: "orders-service-v1",
    topics: [record.topic],
    binding: {
      processing: "durable",
      database,
      inbox,
      decode: (decoded) => decoded,
      handle: async (transaction, envelope, kafkaRecord, signal) =>
        handle(transaction, envelope, kafkaRecord, signal),
    },
    leaseMs: 30_000,
    maxMessageBytes: 1024,
    signal: new AbortController().signal,
    commit: async () => effect("offset"),
  });

  await processKafkaRecord(record, durable());
  const successTimeline = [
    "sql:BEGIN",
    "effect:begin",
    "effect:handle",
    "effect:processed",
    "sql:COMMIT",
    "effect:offset",
  ];
  assert.deepEqual(timeline, successTimeline, "offset ACK follows DB COMMIT");
  assert.throws(
    () =>
      assert.deepEqual(
        [
          "sql:BEGIN",
          "effect:begin",
          "effect:handle",
          "effect:processed",
          "effect:offset",
          "sql:COMMIT",
        ],
        successTimeline,
      ),
    { name: "AssertionError" },
    "a mutant that ACKs before COMMIT fails the ordered assertion",
  );

  timeline.length = 0;
  beginResult = { kind: "duplicate", state: "Processed" };
  await processKafkaRecord(record, durable());
  assert.deepEqual(
    timeline,
    ["sql:BEGIN", "effect:begin", "sql:COMMIT", "effect:offset"],
    "duplicates skip owner work and ACK follows DB COMMIT",
  );

  timeline.length = 0;
  beginResult = { kind: "conflict" };
  await processKafkaRecord(record, durable());
  assert.deepEqual(timeline, [
    "sql:BEGIN",
    "effect:begin",
    "effect:record:INBOX_HASH_CONFLICT",
    "sql:COMMIT",
    "effect:offset",
  ]);

  timeline.length = 0;
  beginResult = { kind: "in_progress" };
  await assert.rejects(processKafkaRecord(record, durable()), {
    code: "KAFKA_HANDLER_FAILED",
  });
  assert.deepEqual(timeline, ["sql:BEGIN", "effect:begin", "sql:ROLLBACK"]);

  timeline.length = 0;
  beginResult = { kind: "acquired" };
  handle = async () => {
    effect("handle");
    throw new InboxProcessingError({
      kind: "permanent",
      reason: "OWNER_REVISION_CONFLICT",
    });
  };
  await processKafkaRecord(record, durable());
  assert.deepEqual(timeline, [
    "sql:BEGIN",
    "effect:begin",
    "effect:handle",
    "sql:ROLLBACK",
    "sql:BEGIN",
    "effect:begin",
    "effect:quarantine:OWNER_REVISION_CONFLICT",
    "effect:record:OWNER_REVISION_CONFLICT",
    "sql:COMMIT",
    "effect:offset",
  ]);

  timeline.length = 0;
  handle = async () => {
    effect("handle");
    throw new InboxProcessingError({ kind: "transient", reason: "TEMPORARY" });
  };
  await assert.rejects(processKafkaRecord(record, durable()), {
    name: "InboxProcessingError",
  });
  assert.deepEqual(timeline, [
    "sql:BEGIN",
    "effect:begin",
    "effect:handle",
    "sql:ROLLBACK",
  ]);
});
void test("native Kafka maps broker delivery and commit codes to stable errors", async () => {
  const nativeKey = Symbol.for("coffee.native-error-code-regression");
  const clients = {};
  globalThis[nativeKey] = {
    Producer: class extends EventEmitter {
      constructor() {
        super();
        clients.producer = this;
      }
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      produce(topic, _partition, _value, key, _timestamp, opaque) {
        const code = clients.deliveryCodes.get(key);
        queueMicrotask(() =>
          this.emit("delivery-report", code === undefined ? null : { code }, {
            topic,
            partition: 0,
            offset: 7,
            opaque,
          }),
        );
      }
      disconnect(callback) {
        callback(null);
      }
    },
    KafkaConsumer: class extends EventEmitter {
      constructor() {
        super();
        clients.consumer = this;
      }
      isConnected() {
        return true;
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      connect(_options, callback) {
        callback(null);
      }
      commitCb(_offsets, callback) {
        callback(
          this.failureCode === undefined ? null : { code: this.failureCode },
        );
      }
      disconnect(callback) {
        callback(null);
      }
    },
  };
  clients.deliveryCodes = new Map();
  const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.native-error-code-regression")];export default {RdKafka};')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "@confluentinc/kafka-javascript"
        ? { url, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const common = {
    brokers: ["fixture:9092"],
    clientId: "native-error-code-regression",
    protocol: "PLAINTEXT",
    maxPending: 8,
    maxMessageBytes: 2048,
    sendTimeoutMs: 1000,
    receiveTimeoutMs: 1000,
    commitTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
  };
  const producer = await createNativeProducer({
    ...common,
    producerRetries: 1,
  });
  const consumer = await createNativeConsumer(
    {
      ...common,
      groupId: "fixture-group",
      topics: [record.topic],
      autoOffsetReset: "latest",
    },
    () => {},
  );
  try {
    await producer.connect();
    await consumer.connect();
    assert.deepEqual(
      await producer.send(record.topic, "success", "{}", {}),
      { topic: record.topic, partition: 0, offset: "7" },
      "valid delivery ACK is the positive baseline",
    );
    for (const [label, nativeCode, expected] of [
      ["queue full", -184, "NATIVE_QUEUE_FULL"],
      ["invalid message size", 4, "NATIVE_CONFIG_INVALID"],
      ["oversized message", 10, "NATIVE_CONFIG_INVALID"],
      ["invalid argument", -186, "NATIVE_CONFIG_INVALID"],
      ["other broker error", -999, "NATIVE_DELIVERY_FAILED"],
    ]) {
      clients.deliveryCodes.set(label, nativeCode);
      await assert.rejects(
        producer.send(record.topic, label, "{}", {}),
        { code: expected },
        label,
      );
    }

    for (const [nativeCode, expected] of [
      [-184, "NATIVE_QUEUE_FULL"],
      [4, "NATIVE_CONFIG_INVALID"],
      [10, "NATIVE_CONFIG_INVALID"],
      [-186, "NATIVE_CONFIG_INVALID"],
      [-185, "NATIVE_OPERATION_TIMEOUT"],
      [-166, "NATIVE_OPERATION_TIMEOUT"],
      [-999, "NATIVE_OPERATION_FAILED"],
    ]) {
      clients.consumer.failureCode = nativeCode;
      await assert.rejects(
        consumer.commit(record.topic, 0, String(nativeCode + 1000)),
        { code: expected },
        `commit native code ${nativeCode}`,
      );
    }
  } finally {
    await Promise.all([producer.close(), consumer.close()]);
    hook.deregister();
    delete globalThis[nativeKey];
  }
});

void test(
  "runtime bounds realtime DLQ wire and falls back from invalid transport keys",
  { timeout: 10000 },
  async () => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = config.kafka.topics.realtimeInvalidate.name;
    const identity = {
      schemaVersion: 1,
      runId: "20261024T123456Z-1234567",
      candidateSha: `1234567${"0".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    };
    const physicalTargets = deriveRuntimeKafkaTarget({
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      enabled: true,
      environment: config.environment,
      launchIdentity: identity,
    });
    const physicalTopic = physicalTargets.topics[topic];
    const observed = [],
      ages = [];
    let observeLag;
    assert.equal(
      metrics.setGlobalMeterProvider({
        getMeter() {
          return {
            createHistogram(name) {
              return {
                record(value, attributes) {
                  if (name === "messaging.kafka.event.age")
                    ages.push({ value, attributes });
                },
              };
            },
            createObservableGauge(name) {
              return {
                addCallback(callback) {
                  if (name === "messaging.kafka.consumer.lag")
                    observeLag = callback;
                },
              };
            },
          };
        },
      }),
      true,
    );
    const inputs = [
      {
        label: "near-limit wire",
        topic,
        value: Buffer.from(
          "x".repeat(config.kafka.delivery.maxMessageBytes - 256),
        ),
        key: subject,
      },
      {
        label: "oversized raw wire",
        topic,
        value: Buffer.from(
          "x".repeat(config.kafka.delivery.maxMessageBytes + 1),
        ),
        key: subject,
      },
      {
        label: "long key",
        topic,
        value: Buffer.from("invalid"),
        key: "k".repeat(257),
      },
    ];
    const events = [];
    let consumed = 0,
      latestConsumer,
      latestProducer;
    class Producer extends EventEmitter {
      constructor() {
        super();
        latestProducer = this;
      }
      isConnected() {
        return true;
      }
      getMetadata(_options, callback) {
        callback(this.failMetadata ? Error("metadata failed") : null, {});
      }
      connect(_options, callback) {
        callback(null);
      }
      produce(topic, _partition, value, key, _timestamp, opaque) {
        const envelope = JSON.parse(Buffer.from(value).toString("utf8"));
        events.push({ kind: "dlq", topic, key, envelope });
        queueMicrotask(() =>
          this.emit("delivery-report", null, {
            topic,
            partition: 0,
            offset: 9,
            opaque,
          }),
        );
      }
      disconnect(callback) {
        callback(null);
      }
    }
    class Consumer extends EventEmitter {
      constructor(config) {
        super();
        this.config = config;
        this.watermarks = new Map();
        latestConsumer = this;
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      isConnected() {
        return true;
      }
      getMetadata(_options, callback) {
        callback(this.failMetadata ? Error("metadata failed") : null, {});
      }
      getWatermarkOffsets(topic, partition) {
        if (this.throwWatermark) throw Error("watermark failed");
        return this.watermarks.get(`${topic}:${partition}`) ?? null;
      }
      connect(_options, callback) {
        callback(null);
      }
      subscribe(topics) {
        events.push({ kind: "subscribe", topics });
        this.config.rebalance_cb(null, [
          { topic: physicalTopic, partition: 0 },
        ]);
      }
      consume(_limit, callback) {
        setTimeout(() => {
          const input = inputs[consumed++];
          callback(
            null,
            input
              ? [
                  {
                    topic: physicalTopic,
                    partition: 0,
                    offset: consumed,
                    key: Buffer.from(input.key),
                    value: input.value,
                    headers: {},
                  },
                ]
              : [],
          );
        }, 1);
      }
      commitCb(offsets, callback) {
        events.push({ kind: "offset", offsets });
        this.emit("offset.commit", null, offsets);
        callback(null);
      }
      assign() {}
      unassign() {
        this.unassigned = (this.unassigned ?? 0) + 1;
      }
      pause() {}
      resume() {}
      disconnect(callback) {
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.kafka-dlq-regression");
    globalThis[nativeKey] = { Producer, KafkaConsumer: Consumer };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.kafka-dlq-regression")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });
    const runtime = createKafkaRuntime({
      runtime: "realtime-gateway",
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      credentials: { username: "u", password: "p" },
      physicalTargets,
    });
    try {
      runtime.bind("realtime-gateway-v1", {
        processing: "realtime",
        decode: () => {
          throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
        },
        enqueue: async () => assert.fail("enqueue"),
      });
      await runtime.resource.start(AbortSignal.timeout(5000));
      latestConsumer.watermarks.set(`${physicalTopic}:0`, { highOffset: 1 });
      assert.equal(
        runtime.metrics().assigned,
        1,
        "aggregate assignment metrics reflect the live worker",
      );
      assert.equal(
        await runtime.readiness.check(AbortSignal.timeout(1000)),
        true,
        "runtime readiness checks the connected producer and assigned consumer",
      );
      latestProducer.failMetadata = true;
      assert.equal(
        await runtime.readiness.check(AbortSignal.timeout(1000)),
        false,
        "a producer metadata failure makes aggregate readiness fail closed",
      );
      latestProducer.failMetadata = false;
      assert.equal(
        latestConsumer.config["group.id"],
        physicalTargets.groups["realtime-gateway-v1"],
      );
      assert.deepEqual(
        events.find((event) => event.kind === "subscribe").topics,
        [physicalTopic],
      );
      latestConsumer.emit("event.stats", {
        message: JSON.stringify({
          topics: {
            [physicalTopic]: {
              partitions: {
                0: { consumer_lag: 7 },
                1: { consumer_lag: 0 },
                24: { consumer_lag: 999 },
              },
            },
            "canary.topic": { partitions: { 0: { consumer_lag: 999 } } },
          },
        }),
      });
      observeLag({
        observe(metricValue, attributes) {
          observed.push({ value: metricValue, attributes });
        },
      });
      assert.deepEqual(observed, [
        {
          value: 7,
          attributes: {
            "messaging.consumer.group": "realtime-gateway-v1",
            "messaging.destination.name": topic,
            "messaging.destination.partition.id": "0",
          },
        },
        {
          value: 0,
          attributes: {
            "messaging.consumer.group": "realtime-gateway-v1",
            "messaging.destination.name": topic,
            "messaging.destination.partition.id": "1",
          },
        },
      ]);
      latestConsumer.emit("event.stats", {
        message: JSON.stringify({
          topics: {
            [physicalTopic]: {
              partitions: { 0: { consumer_lag: -1 }, 1: { consumer_lag: 0 } },
            },
          },
        }),
      });
      observed.length = 0;
      observeLag({
        observe(metricValue, attributes) {
          observed.push({ value: metricValue, attributes });
        },
      });
      assert.deepEqual(observed, [
        {
          value: 0,
          attributes: {
            "messaging.consumer.group": "realtime-gateway-v1",
            "messaging.destination.name": topic,
            "messaging.destination.partition.id": "1",
          },
        },
      ]);
      const deadline = Date.now() + 3000;
      while (
        events.filter((event) => event.kind === "offset").length <
          inputs.length &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.deepEqual(
        events
          .filter((event) => event.kind === "dlq" || event.kind === "offset")
          .map((event) => event.kind),
        inputs.flatMap(() => ["dlq", "offset"]),
      );
      const dlqs = events.filter((event) => event.kind === "dlq");
      for (const dlq of dlqs) {
        assert.equal(
          dlq.topic,
          physicalTargets.topics[config.kafka.topics.realtimeInvalidate.dlq],
        );
        assert.ok(
          Buffer.byteLength(JSON.stringify(dlq.envelope)) <=
            config.kafka.delivery.maxMessageBytes,
        );
      }
      assert.equal(
        latestConsumer.config["group.id"],
        physicalTargets.groups["realtime-gateway-v1"],
      );
      assert.equal(dlqs[0].envelope.payload.wire.digest !== undefined, true);
      assert.equal(
        dlqs[0].envelope.payload.wire.byteLength,
        inputs[0].value.byteLength,
      );
      assert.equal(dlqs[1].envelope.payload.wire.digest !== undefined, true);
      assert.equal(
        dlqs[1].envelope.payload.wire.byteLength,
        inputs[1].value.byteLength,
      );
      assert.equal(dlqs[2].key, dlqs[2].envelope.messageId);
      const nativeOptions = {
        brokers: ["fixture:9092"],
        clientId: "latest-health-regression",
        protocol: "PLAINTEXT",
        maxPending: 32,
        maxMessageBytes: 2048,
        sendTimeoutMs: 5000,
        receiveTimeoutMs: 1000,
        commitTimeoutMs: 5000,
        shutdownTimeoutMs: 20000,
        groupId: "realtime-gateway-v1",
        topics: [topic],
        autoOffsetReset: "latest",
        physicalTargets,
      };
      const rejectedRebalances = [];
      const latest = await createNativeConsumer(nativeOptions, (event) =>
        rejectedRebalances.push(event),
      );
      try {
        await latest.connect();
        assert.equal(
          await latest.health(),
          false,
          "latest requires an assignment",
        );
        const client = latestConsumer;
        client.config.rebalance_cb(null, [
          { topic: physicalTopic, partition: 0 },
          { topic: physicalTopic, partition: 1 },
        ]);
        client.config.rebalance_cb(null, [
          { topic: `untrusted.${topic}`, partition: 0 },
        ]);
        assert.equal(
          rejectedRebalances.at(-1)?.type,
          "failed",
          "unknown physical topic must not be mapped by stripping an arbitrary prefix",
        );
        client.config.rebalance_cb(null, [
          { topic: physicalTopic, partition: 0 },
          { topic: physicalTopic, partition: 1 },
        ]);
        assert.equal(
          await latest.health(),
          false,
          "latest requires fetched high watermarks",
        );
        client.watermarks.set(`${physicalTopic}:0`, { highOffset: 12 });
        client.watermarks.set(`${physicalTopic}:1`, { highOffset: 8 });
        assert.equal(
          await latest.health(),
          true,
          "all assigned partitions have fetched watermarks",
        );
        await latest.unassign();
        assert.equal(
          client.unassigned,
          1,
          "unassign reaches the native client",
        );
        assert.equal(
          await latest.health(),
          false,
          "unassign clears readiness for the previous assignment",
        );
        client.config.rebalance_cb(null, [
          { topic: physicalTopic, partition: 0 },
          { topic: physicalTopic, partition: 1 },
        ]);
        client.watermarks.set(`${physicalTopic}:0`, { highOffset: 12 });
        client.watermarks.set(`${physicalTopic}:1`, { highOffset: 8 });
        assert.equal(
          await latest.health(),
          true,
          "a later accepted assignment can become ready again",
        );
        client.failMetadata = true;
        assert.equal(
          await latest.health(),
          false,
          "metadata errors fail closed",
        );
        client.failMetadata = false;
        client.throwWatermark = true;
        assert.equal(
          await latest.health(),
          false,
          "watermark errors fail closed",
        );
        client.throwWatermark = false;
        client.watermarks.set(`${physicalTopic}:1`, { highOffset: -1 });
        assert.equal(
          await latest.health(),
          false,
          "invalid watermarks fail closed",
        );
      } finally {
        await latest.close();
      }
      const earliest = await createNativeConsumer(
        {
          ...nativeOptions,
          clientId: "earliest-health-regression",
          autoOffsetReset: "error",
        },
        () => {},
      );
      try {
        await earliest.connect();
        assert.equal(
          await earliest.health(),
          true,
          "non-latest reset keeps metadata-only health",
        );
      } finally {
        await earliest.close();
      }
    } finally {
      await runtime.resource
        .stop(AbortSignal.timeout(5000))
        .catch(() => runtime.resource.destroy());
      hook.deregister();
      delete globalThis[nativeKey];
    }
    assert.equal(
      await runtime.readiness.check(AbortSignal.timeout(1000)),
      false,
      "stopped runtime is not ready",
    );
    await processKafkaRecord(record, options());
    assert.equal(ages.length, 1);
    assert.equal(
      ages[0].attributes["messaging.destination.name"],
      record.topic,
    );
    assert.equal(
      ages[0].attributes["messaging.consumer.group"],
      "realtime-gateway-v1",
    );
    observed.length = 0;
    observeLag({
      observe(metricValue, attributes) {
        observed.push({ value: metricValue, attributes });
      },
    });
    assert.deepEqual(observed, []);
    metrics.disable();
  },
);

void test(
  "native Kafka namespace maps producer ACKs and consumer transport controls without accepting foreign names",
  { timeout: 10000 },
  async () => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = config.kafka.topics.realtimeInvalidate.name;
    const groupId = "realtime-gateway-v1";
    const identity = {
      schemaVersion: 1,
      runId: "20261024T123456Z-1234567",
      candidateSha: `1234567${"0".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    };
    const physicalTargets = deriveRuntimeKafkaTarget({
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      enabled: true,
      environment: config.environment,
      launchIdentity: identity,
    });
    const physicalTopic = physicalTargets.topics[topic];
    const clients = {};
    class Producer extends EventEmitter {
      constructor() {
        super();
        clients.producer = this;
        this.produced = [];
        this.disconnected = 0;
      }
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      poll() {}
      produce(nativeTopic, _partition, _value, key, _timestamp, opaque) {
        this.produced.push({ topic: nativeTopic, key });
        const reportTopic =
          key === "foreign-ack"
            ? `${identity.runId}.coffee.untrusted.v1`
            : nativeTopic;
        queueMicrotask(() =>
          this.emit("delivery-report", null, {
            topic: reportTopic,
            partition: 2,
            offset: 11,
            opaque,
          }),
        );
      }
      disconnect(callback) {
        this.disconnected++;
        callback(null);
      }
    }
    class Consumer extends EventEmitter {
      constructor() {
        super();
        clients.consumer = this;
        this.subscribed = [];
        this.commits = [];
        this.assigned = [];
        this.paused = [];
        this.resumed = [];
        this.disconnected = 0;
        this.nextTopic = physicalTopic;
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      subscribe(topics) {
        this.subscribed.push(...topics);
      }
      consume(_limit, callback) {
        callback(null, [
          {
            topic: this.nextTopic,
            partition: 2,
            offset: 10,
            key: Buffer.from("key"),
            value: Buffer.from("payload"),
            headers: {},
          },
        ]);
      }
      commitCb(offsets, callback) {
        this.commits.push(offsets);
        this.pendingCommitOffsets = offsets;
        this.emit("offset.commit", null, [
          { ...offsets[0], topic: `${identity.runId}.coffee.untrusted.v1` },
        ]);
        callback(null);
      }
      assign(partitions) {
        this.assigned = partitions;
      }
      unassign() {}
      pause(partitions) {
        this.paused = partitions;
      }
      resume(partitions) {
        this.resumed = partitions;
      }
      getMetadata(_options, callback) {
        callback(null, {});
      }
      disconnect(callback) {
        this.disconnected++;
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.kafka-namespace-adapter-regression");
    globalThis[nativeKey] = { Producer, KafkaConsumer: Consumer };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.kafka-namespace-adapter-regression")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });
    const common = {
      brokers: ["fixture:9092"],
      protocol: "PLAINTEXT",
      maxPending: 4,
      maxMessageBytes: 2048,
      sendTimeoutMs: 1000,
      receiveTimeoutMs: 1000,
      commitTimeoutMs: 1000,
      shutdownTimeoutMs: 1000,
      physicalTargets,
    };
    const producer = await createNativeProducer({
      ...common,
      clientId: "namespace-producer",
      producerRetries: 1,
    });
    const consumer = await createNativeConsumer(
      {
        ...common,
        clientId: "namespace-consumer",
        groupId,
        topics: [topic],
        autoOffsetReset: "error",
      },
      () => {},
    );
    try {
      await producer.connect();
      const ack = await producer.send(topic, "valid-key", "payload", {});
      assert.deepEqual(clients.producer.produced[0], {
        topic: physicalTopic,
        key: "valid-key",
      });
      assert.deepEqual(
        ack,
        { topic, partition: 2, offset: "11" },
        "broker delivery report is projected to the logical topic",
      );
      await assert.rejects(producer.send("", "valid-key", "payload", {}), {
        code: "NATIVE_CONFIG_INVALID",
      });
      await assert.rejects(producer.send(topic, 7, "payload", {}), {
        code: "NATIVE_CONFIG_INVALID",
      });
      await assert.rejects(
        producer.send(topic, "valid-key", "x".repeat(2049), {}),
        { code: "NATIVE_CONFIG_INVALID" },
      );
      await assert.rejects(
        producer.send(topic, "valid-key", "payload", { "": "bad" }),
        { code: "NATIVE_CONFIG_INVALID" },
      );
      await assert.rejects(
        producer.send(topic, "valid-key", "payload", { invalid: 7 }),
        { code: "NATIVE_CONFIG_INVALID" },
      );
      await assert.rejects(
        producer.send(topic, "foreign-ack", "payload", {}),
        { code: "NATIVE_DELIVERY_FAILED" },
        "foreign physical delivery report must not become a successful ACK",
      );

      await consumer.connect();
      await assert.rejects(consumer.subscribe([]), {
        code: "NATIVE_CONFIG_INVALID",
      });
      await consumer.subscribe([topic]);
      assert.deepEqual(clients.consumer.subscribed, [physicalTopic]);
      const [received] = await consumer.poll(1);
      assert.equal(
        received.topic,
        topic,
        "physical broker record is returned as the logical topic",
      );
      assert.equal(received.offset, "10");
      for (const limit of [0, common.maxPending + 1])
        await assert.rejects(consumer.poll(limit), {
          code: "NATIVE_QUEUE_FULL",
        });
      await assert.rejects(consumer.commit("", 0, "1"), {
        code: "NATIVE_CONFIG_INVALID",
      });
      await assert.rejects(consumer.commit(topic, 0, "00"), {
        code: "NATIVE_OFFSET_INVALID",
      });
      await assert.rejects(consumer.assign([{ topic: "", partition: 0 }]), {
        code: "NATIVE_RECORD_INVALID",
      });
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(consumer.pause(undefined, aborted.signal), {
        code: "NATIVE_OPERATION_ABORTED",
      });
      await consumer.assign([{ topic, partition: 2 }]);
      await consumer.pause();
      await consumer.resume();
      assert.deepEqual(clients.consumer.assigned, [
        { topic: physicalTopic, partition: 2 },
      ]);
      assert.deepEqual(clients.consumer.paused, [
        { topic: physicalTopic, partition: 2 },
      ]);
      assert.deepEqual(clients.consumer.resumed, [
        { topic: physicalTopic, partition: 2 },
      ]);
      let commitSettled = false;
      const commit = consumer.commit(topic, 2, "11").then(() => {
        commitSettled = true;
      });
      assert.equal(
        commitSettled,
        false,
        "a foreign physical offset report cannot acknowledge the logical commit",
      );
      clients.consumer.emit(
        "offset.commit",
        null,
        clients.consumer.pendingCommitOffsets,
      );
      await commit;
      assert.deepEqual(clients.consumer.commits, [
        [{ topic: physicalTopic, partition: 2, offset: 11 }],
      ]);
      clients.consumer.nextTopic = `${identity.runId}.coffee.untrusted.v1`;
      await assert.rejects(
        consumer.poll(1),
        /RUNTIME_KAFKA_TARGET_INVALID/u,
        "foreign physical record fails closed",
      );
    } finally {
      await Promise.all([producer.close(), consumer.close()]);
      hook.deregister();
      delete globalThis[nativeKey];
    }
    assert.equal(clients.producer.disconnected, 1);
    assert.equal(clients.consumer.disconnected, 1);
    await assert.rejects(producer.send(topic, "closed", "payload", {}), {
      code: "NATIVE_CLIENT_CLOSED",
    });
    await assert.rejects(consumer.poll(1), { code: "NATIVE_CLIENT_CLOSED" });
  },
);

void test(
  "native Kafka bounds producer and commit waiters across abort, late ACK, timeout, broker failure, and close",
  { timeout: 10000 },
  async () => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = config.kafka.topics.realtimeInvalidate.name;
    const groupId = "realtime-gateway-v1";
    const identity = {
      schemaVersion: 1,
      runId: "20261024T123456Z-1234567",
      candidateSha: `1234567${"0".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    };
    const physicalTargets = deriveRuntimeKafkaTarget({
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      enabled: true,
      environment: config.environment,
      launchIdentity: identity,
    });
    const physicalTopic = physicalTargets.topics[topic];
    const clients = {};
    class Producer extends EventEmitter {
      constructor() {
        super();
        clients.producer = this;
        this.produced = [];
        this.disconnected = 0;
      }
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      poll() {}
      produce(nativeTopic, _partition, _value, key, _timestamp, opaque) {
        if (this.throwProduce) throw Error("synchronous producer failure");
        this.produced.push({ topic: nativeTopic, key, opaque });
      }
      disconnect(callback) {
        this.disconnected++;
        this.emit("disconnected");
        callback(null);
      }
    }
    class Consumer extends EventEmitter {
      constructor() {
        super();
        clients.consumer = this;
        this.commits = [];
        this.disconnected = 0;
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      commitCb(offsets, callback) {
        if (this.throwCommit) throw Error("synchronous commit failure");
        this.commits.push({ offsets, callback });
      }
      disconnect(callback) {
        this.disconnected++;
        this.emit("disconnected");
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.kafka-pending-waiter-regression");
    globalThis[nativeKey] = { Producer, KafkaConsumer: Consumer };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.kafka-pending-waiter-regression")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });
    const common = {
      brokers: ["fixture:9092"],
      protocol: "PLAINTEXT",
      maxPending: 1,
      maxMessageBytes: 2048,
      sendTimeoutMs: 200,
      receiveTimeoutMs: 1000,
      commitTimeoutMs: 200,
      shutdownTimeoutMs: 1000,
      physicalTargets,
    };
    const producer = await createNativeProducer({
      ...common,
      clientId: "pending-producer",
      producerRetries: 1,
    });
    const consumer = await createNativeConsumer(
      {
        ...common,
        clientId: "pending-consumer",
        groupId,
        topics: [topic],
        autoOffsetReset: "error",
      },
      () => {},
    );
    const trackAbortListeners = (controller) => {
      const signal = controller.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      let count = 0;
      signal.addEventListener = (type, listener, options) => {
        if (type === "abort") count++;
        return add(type, listener, options);
      };
      signal.removeEventListener = (type, listener, options) => {
        if (type === "abort") count--;
        return remove(type, listener, options);
      };
      return () => count;
    };
    try {
      await producer.connect();
      const preAbortedSend = new AbortController();
      preAbortedSend.abort();
      await assert.rejects(
        producer.send(
          topic,
          "pre-aborted",
          "payload",
          {},
          preAbortedSend.signal,
        ),
        { code: "NATIVE_OPERATION_ABORTED" },
      );
      assert.equal(
        clients.producer.produced.length,
        0,
        "pre-aborted sends never reach the native client",
      );

      const sendAbort = new AbortController();
      const sendAbortListeners = trackAbortListeners(sendAbort);
      let abortSendSettled = false;
      const abortSend = producer
        .send(topic, "abort-during-delivery", "payload", {}, sendAbort.signal)
        .then(
          () => {
            abortSendSettled = true;
            return "resolved";
          },
          (cause) => {
            abortSendSettled = true;
            return cause.code;
          },
        );
      const abortReport = clients.producer.produced.at(-1);
      assert.equal(
        sendAbortListeners(),
        1,
        "a pending delivery owns one abort listener",
      );
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 20,
        opaque: { foreign: true },
      });
      assert.equal(
        abortSendSettled,
        false,
        "a foreign producer ACK cannot settle another send",
      );
      sendAbort.abort();
      assert.equal(await abortSend, "NATIVE_OPERATION_ABORTED");
      assert.equal(
        sendAbortListeners(),
        0,
        "aborted delivery removes its abort listener",
      );
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 21,
        opaque: abortReport.opaque,
      });

      let failedSendSettled = false;
      const failedSend = producer
        .send(topic, "broker-failure", "payload", {})
        .then(
          () => {
            failedSendSettled = true;
            return "resolved";
          },
          (cause) => {
            failedSendSettled = true;
            return cause.code;
          },
        );
      const failedReport = clients.producer.produced.at(-1);
      assert.equal(
        failedSendSettled,
        false,
        "producer failure remains pending until a broker report arrives",
      );
      clients.producer.emit(
        "delivery-report",
        { code: 999 },
        {
          topic: physicalTopic,
          partition: 0,
          offset: 22,
          opaque: failedReport.opaque,
        },
      );
      assert.equal(await failedSend, "NATIVE_DELIVERY_FAILED");

      clients.producer.throwProduce = true;
      await assert.rejects(
        producer.send(topic, "sync-failure", "payload", {}),
        { code: "NATIVE_OPERATION_FAILED" },
      );
      clients.producer.throwProduce = false;
      const recoveredSend = producer
        .send(topic, "sync-retry", "payload", {})
        .then(
          (value) => value,
          (cause) => cause.code,
        );
      const recoveredReport = clients.producer.produced.at(-1);
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 24,
        opaque: recoveredReport.opaque,
      });
      assert.deepEqual(await recoveredSend, {
        topic,
        partition: 0,
        offset: "24",
      });

      const sendTimeoutController = new AbortController();
      const sendTimeoutListeners = trackAbortListeners(sendTimeoutController);
      const timedOutSend = producer
        .send(
          topic,
          "delivery-timeout",
          "payload",
          {},
          sendTimeoutController.signal,
        )
        .then(
          () => "resolved",
          (cause) => cause.code,
        );
      const timeoutReport = clients.producer.produced.at(-1);
      assert.equal(await timedOutSend, "NATIVE_OPERATION_TIMEOUT");
      assert.equal(sendTimeoutListeners(), 0);
      assert.equal(
        await producer.send(topic, "fenced-slot", "payload", {}).then(
          () => "resolved",
          (cause) => cause.code,
        ),
        "NATIVE_QUEUE_FULL",
        "an uncertain delivery retains its native slot until a late report",
      );
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 25,
        opaque: timeoutReport.opaque,
      });
      assert.equal(await timedOutSend, "NATIVE_OPERATION_TIMEOUT");
      const afterTimeout = producer
        .send(topic, "after-timeout", "payload", {})
        .then(
          (value) => value,
          (cause) => cause.code,
        );
      const afterTimeoutReport = clients.producer.produced.at(-1);
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 26,
        opaque: afterTimeoutReport.opaque,
      });
      assert.deepEqual(await afterTimeout, {
        topic,
        partition: 0,
        offset: "26",
      });

      const sendCloseController = new AbortController();
      const sendCloseListeners = trackAbortListeners(sendCloseController);
      const closeReportPromise = producer
        .send(topic, "close-pending", "payload", {}, sendCloseController.signal)
        .then(
          () => "resolved",
          (cause) => cause.code,
        );
      const closeReport = clients.producer.produced.at(-1);
      assert.equal(sendCloseListeners(), 1);
      await producer.close();
      assert.equal(await closeReportPromise, "NATIVE_CLIENT_CLOSED");
      assert.equal(
        sendCloseListeners(),
        0,
        "close removes pending producer abort listeners",
      );
      clients.producer.emit("delivery-report", null, {
        topic: physicalTopic,
        partition: 0,
        offset: 23,
        opaque: closeReport.opaque,
      });

      await consumer.connect();
      const preAbortedCommit = new AbortController();
      preAbortedCommit.abort();
      await assert.rejects(
        consumer.commit(topic, 2, "31", preAbortedCommit.signal),
        { code: "NATIVE_OPERATION_ABORTED" },
      );
      assert.equal(
        clients.consumer.commits.length,
        0,
        "pre-aborted commits never reach the native client",
      );

      const commitAbort = new AbortController();
      const commitAbortListeners = trackAbortListeners(commitAbort);
      const abortCommit = consumer
        .commit(topic, 2, "32", commitAbort.signal)
        .then(
          () => "resolved",
          (cause) => cause.code,
        );
      const commitAbortEntry = clients.consumer.commits.at(-1);
      assert.equal(
        commitAbortListeners(),
        1,
        "a pending commit owns one abort listener",
      );
      clients.consumer.emit("offset.commit", null, [
        {
          ...commitAbortEntry.offsets[0],
          topic: `${identity.runId}.coffee.untrusted.v1`,
        },
      ]);
      clients.consumer.emit("offset.commit", null, [
        { topic: physicalTopic, partition: 2, offset: "not-an-offset" },
      ]);
      assert.equal(
        await consumer.commit(topic, 2, "32").then(
          () => "resolved",
          (cause) => cause.code,
        ),
        "NATIVE_QUEUE_FULL",
        "foreign or invalid ACKs cannot release another pending commit",
      );
      commitAbort.abort();
      assert.equal(await abortCommit, "NATIVE_OPERATION_ABORTED");
      assert.equal(
        commitAbortListeners(),
        0,
        "aborted commit removes its abort listener",
      );
      clients.consumer.emit("offset.commit", null, commitAbortEntry.offsets);

      const failedCommit = consumer.commit(topic, 2, "33").then(
        () => "resolved",
        (cause) => cause.code,
      );
      const failedCommitEntry = clients.consumer.commits.at(-1);
      failedCommitEntry.callback({ code: 999 });
      assert.equal(
        await failedCommit,
        "NATIVE_OPERATION_FAILED",
        "native commit callback errors reject the waiter",
      );

      clients.consumer.throwCommit = true;
      await assert.rejects(consumer.commit(topic, 2, "34"), {
        code: "NATIVE_OPERATION_FAILED",
      });
      clients.consumer.throwCommit = false;
      const recoveredCommit = consumer.commit(topic, 2, "34").then(
        () => "resolved",
        (cause) => cause.code,
      );
      const recoveredCommitEntry = clients.consumer.commits.at(-1);
      clients.consumer.emit(
        "offset.commit",
        null,
        recoveredCommitEntry.offsets,
      );
      assert.equal(await recoveredCommit, "resolved");

      const failedEventCommit = consumer.commit(topic, 2, "37").then(
        () => "resolved",
        (cause) => cause.code,
      );
      const failedEventEntry = clients.consumer.commits.at(-1);
      clients.consumer.emit(
        "offset.commit",
        { code: -185 },
        failedEventEntry.offsets,
      );
      assert.equal(await failedEventCommit, "NATIVE_OPERATION_TIMEOUT");
      const afterFailedEventCommit = consumer.commit(topic, 2, "37").then(
        () => "resolved",
        (cause) => cause.code,
      );
      const afterFailedEventEntry = clients.consumer.commits.at(-1);
      clients.consumer.emit(
        "offset.commit",
        null,
        afterFailedEventEntry.offsets,
      );
      assert.equal(await afterFailedEventCommit, "resolved");

      const commitTimeoutController = new AbortController();
      const commitTimeoutListeners = trackAbortListeners(
        commitTimeoutController,
      );
      const timedOutCommit = consumer
        .commit(topic, 2, "35", commitTimeoutController.signal)
        .then(
          () => "resolved",
          (cause) => cause.code,
        );
      const timeoutCommitEntry = clients.consumer.commits.at(-1);
      assert.equal(await timedOutCommit, "NATIVE_OPERATION_TIMEOUT");
      assert.equal(commitTimeoutListeners(), 0);
      assert.equal(
        await consumer.commit(topic, 2, "35").then(
          () => "resolved",
          (cause) => cause.code,
        ),
        "NATIVE_QUEUE_FULL",
        "an unknown offset commit remains fenced until its broker event",
      );
      clients.consumer.emit("offset.commit", null, timeoutCommitEntry.offsets);
      assert.equal(await timedOutCommit, "NATIVE_OPERATION_TIMEOUT");
      const afterTimeoutCommit = consumer.commit(topic, 2, "35").then(
        () => "resolved",
        (cause) => cause.code,
      );
      const afterTimeoutCommitEntry = clients.consumer.commits.at(-1);
      clients.consumer.emit(
        "offset.commit",
        null,
        afterTimeoutCommitEntry.offsets,
      );
      assert.equal(await afterTimeoutCommit, "resolved");

      const closeCommitController = new AbortController();
      const closeCommitListeners = trackAbortListeners(closeCommitController);
      const closeCommit = consumer
        .commit(topic, 2, "36", closeCommitController.signal)
        .then(
          () => "resolved",
          (cause) => cause.code,
        );
      const closeCommitEntry = clients.consumer.commits.at(-1);
      assert.equal(closeCommitListeners(), 1);
      await consumer.close();
      assert.equal(await closeCommit, "NATIVE_CLIENT_CLOSED");
      assert.equal(
        closeCommitListeners(),
        0,
        "close removes pending consumer abort listeners",
      );
      clients.consumer.emit("offset.commit", null, closeCommitEntry.offsets);
    } finally {
      await Promise.all([producer.close(), consumer.close()]);
      hook.deregister();
      delete globalThis[nativeKey];
    }
    assert.equal(clients.producer.disconnected, 1);
    assert.equal(clients.consumer.disconnected, 1);
  },
);

void test("native consumer bounds idle Fetch wait without changing receive/commit budgets or auto commit", async () => {
  const capture = {};
  globalThis[Symbol.for("coffee.native-config-capture")] = capture;
  class Consumer extends EventEmitter {
    constructor(config) {
      super();
      capture.config = config;
      capture.instance = this;
    }
    setDefaultConsumeTimeout(ms) {
      capture.consumeTimeout = ms;
    }
    setDefaultIsTimeoutOnlyForFirstMessage(value) {
      assert.equal(value, true);
    }
    commitCb() {}
  }
  const key = Symbol.for("coffee.native-config-regression");
  globalThis[key] = { Producer: class {}, KafkaConsumer: Consumer };
  const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.native-config-regression")];export default {RdKafka};')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "@confluentinc/kafka-javascript"
        ? { url, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    for (const receiveTimeoutMs of [1, 50, 1000]) {
      const options = {
        brokers: ["fixture:9092"],
        clientId: "native-config-regression",
        protocol: "PLAINTEXT",
        maxPending: 32,
        maxMessageBytes: 2048,
        sendTimeoutMs: 5000,
        receiveTimeoutMs,
        commitTimeoutMs: 5000,
        shutdownTimeoutMs: 20000,
        groupId: "realtime-gateway-v1",
        topics: [record.topic],
        autoOffsetReset: "latest",
      };
      const stats = [];
      await createNativeConsumer(
        options,
        () => {},
        (value) => stats.push(value),
      );
      const { config: captured, consumeTimeout } = capture;
      assert.equal(
        captured["fetch.wait.max.ms"],
        Math.min(100, receiveTimeoutMs),
      );
      assert.equal(captured["request.timeout.ms"], receiveTimeoutMs);
      assert.equal(captured["enable.auto.commit"], false);
      assert.equal(captured["enable.auto.offset.store"], false);
      assert.equal(captured["allow.auto.create.topics"], false);
      assert.equal(captured["offset_commit_cb"], true);
      assert.equal(captured["statistics.interval.ms"], receiveTimeoutMs);
      assert.ok(consumeTimeout >= 1 && consumeTimeout <= 10);
      const snapshot = {
        topics: { [record.topic]: { partitions: { 0: { consumer_lag: 12 } } } },
      };
      capture.instance.emit("event.stats", {
        message: JSON.stringify(snapshot),
      });
      assert.deepEqual(stats, [snapshot]);
      for (const malformed of [
        snapshot,
        { message: "{" },
        { message: JSON.stringify([]) },
        { message: JSON.stringify(null) },
      ])
        assert.doesNotThrow(() =>
          capture.instance.emit("event.stats", malformed),
        );
      assert.deepEqual(stats, [snapshot]);
    }
  } finally {
    hook.deregister();
    delete globalThis[key];
    delete globalThis[Symbol.for("coffee.native-config-capture")];
  }
});
function options(overrides = {}) {
  const seen = [];
  return {
    seen,
    runtime: "realtime-gateway",
    groupId: "realtime-gateway-v1",
    topics: [record.topic],
    leaseMs: 30000,
    maxMessageBytes: 1048576,
    signal: new AbortController().signal,
    binding: {
      processing: "realtime",
      decode: (v, r) => {
        assert.equal(r, record);
        return v;
      },
      enqueue: async () => {
        seen.push("enqueue");
      },
    },
    quarantine: async () => {
      seen.push("quarantine");
    },
    commit: async () => {
      seen.push("offset");
    },
    ...overrides,
  };
}
void test("realtime decode receives the actual transport record before enqueue and offset", async () => {
  const o = options();
  await processKafkaRecord(record, o);
  assert.deepEqual(o.seen, ["enqueue", "offset"]);
});
void test("realtime decoder programming failures are not permanent rejection", async () => {
  const o = options({
    binding: {
      processing: "realtime",
      decode: () => {
        throw new Error("synthetic programming error");
      },
      enqueue: async () => assert.fail("enqueue"),
    },
  });
  await assert.rejects(
    processKafkaRecord(record, o),
    /synthetic programming error/,
  );
  assert.deepEqual(o.seen, []);
});
void test("invalid realtime record commits only after quarantine ACK; failure or revoke cannot commit", async () => {
  for (const mode of ["ok", "failed", "revoked"]) {
    const controller = new AbortController();
    const o = options({
      signal: controller.signal,
      binding: {
        processing: "realtime",
        decode: () => {
          throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
        },
        enqueue: async () => assert.fail("enqueue"),
      },
    });
    o.quarantine = async () => {
      o.seen.push("quarantine");
      if (mode === "failed") throw Error("lost ACK");
      if (mode === "revoked") controller.abort();
    };
    if (mode === "ok") {
      await processKafkaRecord(record, o);
      assert.deepEqual(o.seen, ["quarantine", "offset"]);
    } else {
      await assert.rejects(processKafkaRecord(record, o));
      assert.deepEqual(o.seen, ["quarantine"]);
    }
  }
});
void test("consumer span follows the validated envelope parent and ends after commit failure", async () => {
  const ended = [];
  assert.equal(
    trace.setGlobalTracerProvider({
      getTracer() {
        return {
          startSpan(name, options, parent) {
            const span = {
              name,
              attributes: { ...options.attributes },
              parentSpanContext: trace.getSpanContext(parent),
              setAttribute(key, value) {
                this.attributes[key] = value;
              },
              setStatus() {},
              end() {
                ended.push(this);
              },
            };
            return span;
          },
        };
      },
    }),
    true,
  );
  const o = options({
    commit: async () => {
      throw Error("synthetic offset failure");
    },
  });
  await assert.rejects(processKafkaRecord(record, o), {
    code: "OFFSET_COMMIT_OUTCOME_UNKNOWN",
  });
  assert.equal(ended.length, 1);
  const span = ended[0];
  assert.equal(span.name, "Kafka.consume");
  assert.equal(
    span.parentSpanContext.traceId,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(span.parentSpanContext.spanId, "bbbbbbbbbbbbbbbb");
  assert.equal(span.attributes["messaging.kafka.result"], "failed");
  assert.equal(span.attributes["messaging.destination.name"], record.topic);
  assert.equal(
    Object.keys(span.attributes).some((key) =>
      /message|key|offset|partition|order|error.message/i.test(key),
    ),
    false,
  );
  trace.disable();
});

void test(
  "native consumer rejects malformed records and quarantines ambiguous duplicate transport headers",
  { timeout: 10000 },
  async () => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = config.kafka.topics.realtimeInvalidate.name;
    const identity = {
      schemaVersion: 1,
      runId: "20261024T123456Z-1234567",
      candidateSha: `1234567${"0".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    };
    const physicalTargets = deriveRuntimeKafkaTarget({
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      enabled: true,
      environment: config.environment,
      launchIdentity: identity,
    });
    let client;
    class Consumer extends EventEmitter {
      constructor() {
        super();
        client = this;
        this.nextRecord = undefined;
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      subscribe() {}
      consume(_limit, callback) {
        callback(null, [this.nextRecord]);
      }
      commitCb(offsets, callback) {
        this.emit("offset.commit", null, offsets);
        callback(null);
      }
      disconnect(callback) {
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.native-malformed-records-regression");
    globalThis[nativeKey] = { Producer: class {}, KafkaConsumer: Consumer };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.native-malformed-records-regression")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });
    const consumer = await createNativeConsumer(
      {
        brokers: ["fixture:9092"],
        clientId: "malformed-record-regression",
        protocol: "PLAINTEXT",
        maxPending: 4,
        maxMessageBytes: 2048,
        sendTimeoutMs: 1000,
        receiveTimeoutMs: 1000,
        commitTimeoutMs: 1000,
        shutdownTimeoutMs: 1000,
        groupId: "realtime-gateway-v1",
        topics: [topic],
        autoOffsetReset: "latest",
        physicalTargets,
      },
      () => {},
    );
    try {
      await consumer.connect();
      await consumer.subscribe([topic]);
      const base = {
        topic: physicalTargets.topics[topic],
        partition: 0,
        offset: 1,
        key: Buffer.from(subject),
        value: Buffer.from(JSON.stringify(value)),
        headers: {},
      };
      for (const [label, malformed] of [
        ["empty topic", { topic: "" }],
        ["negative partition", { partition: -1 }],
        ["fractional partition", { partition: 0.5 }],
        ["key shape", { key: { value: subject } }],
        ["value shape", { value: JSON.stringify(value) }],
        ["empty header name", { headers: [{ "": "invalid" }] }],
        ["header entry shape", { headers: [null] }],
        ["header value shape", { headers: { traceparent: 7 } }],
      ]) {
        client.nextRecord = { ...base, ...malformed };
        await assert.rejects(
          consumer.poll(1),
          {
            code: "NATIVE_RECORD_INVALID",
          },
          label,
        );
      }

      client.nextRecord = { ...base, offset: "00" };
      await assert.rejects(consumer.poll(1), {
        code: "NATIVE_OFFSET_INVALID",
      });

      client.nextRecord = {
        ...base,
        headers: [
          { traceparent: value.traceparent },
          { traceparent: value.traceparent },
        ],
      };
      const [ambiguous] = await consumer.poll(1);
      assert.equal(
        ambiguous.headers.traceparent,
        null,
        "the native adapter preserves duplicate-header ambiguity",
      );
      const seen = [];
      await processKafkaRecord(
        ambiguous,
        options({
          binding: {
            processing: "realtime",
            decode: (decoded) => decoded,
            enqueue: async () =>
              assert.fail("ambiguous transport was enqueued"),
          },
          quarantine: async () => seen.push("quarantine"),
          commit: async () => seen.push("offset"),
        }),
      );
      assert.deepEqual(
        seen,
        ["quarantine", "offset"],
        "an ambiguous known transport header advances only after quarantine",
      );
    } finally {
      await consumer.close();
      hook.deregister();
      delete globalThis[nativeKey];
    }
  },
);

void test(
  "runtime drains normal rebalance and recovers from reassignment failure",
  { timeout: 10000 },
  async () => {
    const config = parsePlatformConfig(
      parseYaml(
        readFileSync(
          new URL("../../config/platform.yaml", import.meta.url),
          "utf8",
        ),
      ),
    );
    const topic = config.kafka.topics.realtimeInvalidate.name;
    const identity = {
      schemaVersion: 1,
      runId: "20261024T123456Z-1234567",
      candidateSha: `1234567${"0".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    };
    const physicalTargets = deriveRuntimeKafkaTarget({
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      enabled: true,
      environment: config.environment,
      launchIdentity: identity,
    });
    const events = [];
    const clients = [];
    let releaseHandler;
    let markHandlerStarted;
    const handlerStarted = new Promise((resolve) => {
      markHandlerStarted = resolve;
    });
    const handlerGate = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    const validRecord = {
      topic: physicalTargets.topics[topic],
      partition: 0,
      offset: 1,
      key: Buffer.from(subject),
      value: Buffer.from(JSON.stringify(value)),
      headers: {},
    };
    class Producer extends EventEmitter {
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      getMetadata(_options, callback) {
        callback(null, {});
      }
      disconnect(callback) {
        callback(null);
      }
    }
    class Consumer extends EventEmitter {
      constructor(config) {
        super();
        this.config = config;
        this.number = clients.length + 1;
        this.sent = 0;
        this.polls = 0;
        this.pauses = 0;
        this.resumes = 0;
        events.push(`open:${this.number}`);
        clients.push(this);
      }
      setDefaultConsumeTimeout() {}
      setDefaultIsTimeoutOnlyForFirstMessage() {}
      isConnected() {
        return true;
      }
      connect(_options, callback) {
        callback(null);
      }
      subscribe() {
        this.config.rebalance_cb(null, [
          { topic: physicalTargets.topics[topic], partition: 0 },
        ]);
      }
      consume(limit, callback) {
        this.polls++;
        const batch =
          this.number === 1 && this.polls >= 20
            ? Array.from(
                {
                  length: Math.min(
                    limit,
                    config.kafka.delivery.queueCapacity - this.sent,
                  ),
                },
                () => ({ ...validRecord, offset: ++this.sent }),
              )
            : [];
        setTimeout(() => callback(null, batch), 1);
      }
      assign() {
        this.assignments = (this.assignments ?? 0) + 1;
        events.push(`assign:${this.number}:${this.assignments}`);
        if (this.number === 1 && this.assignments === 3)
          throw Error("synthetic reassignment failure");
      }
      unassign() {
        events.push("unassign");
      }
      pause() {
        this.pauses++;
      }
      resume() {
        this.resumes++;
      }
      commitCb(offsets, callback) {
        this.emit("offset.commit", null, offsets);
        callback(null);
      }
      disconnect(callback) {
        events.push(`close:${this.number}`);
        callback(null);
      }
    }
    const nativeKey = Symbol.for("coffee.runtime-rebalance-drain-regression");
    globalThis[nativeKey] = { Producer, KafkaConsumer: Consumer };
    const url = `data:text/javascript,${encodeURIComponent('export const RdKafka=globalThis[Symbol.for("coffee.runtime-rebalance-drain-regression")];export default {RdKafka};')}`;
    const hook = registerHooks({
      resolve(specifier, context, next) {
        return specifier === "@confluentinc/kafka-javascript"
          ? { url, shortCircuit: true }
          : next(specifier, context);
      },
    });
    const runtime = createKafkaRuntime({
      runtime: "realtime-gateway",
      config: config.kafka,
      service: config.services["realtime-gateway"].kafka,
      credentials: { username: "u", password: "p" },
      physicalTargets,
    });
    try {
      runtime.bind("realtime-gateway-v1", {
        processing: "realtime",
        decode: (decoded) => decoded,
        enqueue: async () => {
          events.push("handler-start");
          markHandlerStarted();
          await handlerGate;
          events.push("handler-finish");
        },
      });
      await runtime.resource.start(AbortSignal.timeout(5000));
      await handlerStarted;
      const original = clients[0];
      assert.equal(
        original.resumes,
        1,
        "empty polls do not repeat native resume",
      );
      const pauseDeadline = Date.now() + 3000;
      while (original.polls < 32 && Date.now() < pauseDeadline)
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.ok(original.polls >= 32, "paused intake keeps polling callbacks");
      assert.equal(
        original.pauses,
        1,
        "full capacity pauses native intake once",
      );
      assert.equal(original.resumes, 1, "full capacity does not resume intake");
      original.config.rebalance_cb({ code: -174 }, [
        { topic: physicalTargets.topics[topic], partition: 0 },
      ]);
      original.config.rebalance_cb({ code: -175 }, [
        { topic: physicalTargets.topics[topic], partition: 1 },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        events.includes("unassign"),
        false,
        "native assignment remains owned while revoked work is unresolved",
      );
      releaseHandler();
      const deadline = Date.now() + 3000;
      while (
        (!events.includes("assign:1:2") || original.resumes < 2) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.ok(
        events.indexOf("handler-finish") < events.indexOf("unassign"),
        "the revoked handler drains before native unassign",
      );
      assert.ok(
        events.indexOf("unassign") < events.indexOf("assign:1:2"),
        "native unassign precedes the accepted replacement assignment",
      );
      assert.equal(
        clients.length,
        1,
        "normal rebalance keeps the existing group member",
      );
      assert.equal(
        original.resumes,
        2,
        "a new assignment resumes paused intake",
      );
      original.config.rebalance_cb({ code: -174 }, [
        { topic: physicalTargets.topics[topic], partition: 1 },
      ]);
      original.config.rebalance_cb({ code: -175 }, [
        { topic: physicalTargets.topics[topic], partition: 2 },
      ]);
      const recoveryDeadline = Date.now() + 3000;
      while (
        (!events.includes("assign:2:1") || clients[1]?.polls < 5) &&
        Date.now() < recoveryDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      assert.equal(
        events.filter((event) => event === "handler-start").length,
        1,
        "reassignment recovery does not replay the completed owner handler",
      );
      assert.ok(
        events.indexOf("unassign", events.indexOf("assign:1:2")) <
          events.indexOf("assign:1:3"),
        "failed assignment follows its revoke unassign",
      );
      assert.ok(
        events.indexOf("close:1") < events.indexOf("open:2") &&
          events.indexOf("open:2") < events.indexOf("assign:2:1"),
        "the failed consumer closes before its replacement is assigned",
      );
      assert.ok(
        events.includes("assign:1:3"),
        "the injected old-consumer assignment failed",
      );
      assert.equal(clients[1].resumes, 1, "replacement idle polls resume once");
    } finally {
      releaseHandler();
      await runtime.resource
        .stop(AbortSignal.timeout(5000))
        .catch(() => runtime.resource.destroy());
      hook.deregister();
      delete globalThis[nativeKey];
    }
  },
);
