import { nowInstant, toInstant } from "@coffee-platform/platform-time";
import {
  relayOutboxBatch,
  type OutboxStore,
  type OutboxRelayResult,
} from "@coffee-platform/outbox";
import {
  createNativeProducer,
  createNativeConsumer,
  NativeKafkaError,
  type NativeProducerPort,
  type NativeConsumerPort,
  type NativeRebalanceEvent,
} from "./native.js";
import { createHash } from "node:crypto";
import {
  withTransaction,
  type Database,
  type Transaction,
} from "@coffee-platform/database";
import {
  canonicalJson,
  canonicalRequestHash,
  type JsonValue,
} from "@coffee-platform/idempotency";
import { consumeOnce, type InboxStore } from "@coffee-platform/inbox";
import {
  parseKafkaConfig,
  validateKafkaServiceConfig,
  RUNTIME_NAMES,
  type RuntimeName,
  type KafkaConfig,
  type KafkaServiceConfig,
} from "@coffee-platform/config";
import { isTraceparent } from "@coffee-platform/observability";

export type KafkaHeaders = Readonly<Record<string, string | null>>;
export type KafkaEnvelope<Payload = unknown> = Readonly<{
  envelopeVersion: "1";
  messageId: string;
  messageType: string;
  occurredAt: string;
  producer: string;
  correlationId: string;
  causationId: string | null;
  traceparent: string;
  aggregate: Readonly<{ type: string; ref: string; version: string }>;
  payload: Payload;
}>;
export type KafkaRecord = Readonly<{
  topic: string;
  partition: number;
  offset: string;
  key: string;
  value: unknown;
  headers: KafkaHeaders;
}>;
export type KafkaErrorCode =
  | "KAFKA_CONFIG_INVALID"
  | "KAFKA_ENVELOPE_INVALID"
  | "KAFKA_HANDLER_FAILED"
  | "KAFKA_SEND_OUTCOME_UNKNOWN"
  | "OFFSET_COMMIT_OUTCOME_UNKNOWN"
  | "KAFKA_CONNECTION_FAILED"
  | "KAFKA_QUEUE_FULL"
  | "KAFKA_REVOKED"
  | "KAFKA_STOPPED"
  | "KAFKA_SHUTDOWN_TIMEOUT";
export class KafkaRuntimeError extends Error {
  public readonly code: KafkaErrorCode;
  public constructor(code: KafkaErrorCode) {
    super(code);
    this.name = "KafkaRuntimeError";
    this.code = code;
  }
}
export type PayloadParser<Payload> = (value: unknown) => Payload;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    // Transport identifiers must not contain control characters.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f]/.test(value)
  )
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  return value;
}
export function parseEnvelope<Payload>(
  value: unknown,
  parsePayload: PayloadParser<Payload>,
): KafkaEnvelope<Payload> {
  if (!object(value)) throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  const expected = [
    "envelopeVersion",
    "messageId",
    "messageType",
    "occurredAt",
    "producer",
    "correlationId",
    "causationId",
    "traceparent",
    "aggregate",
    "payload",
  ];
  const aggregate = value["aggregate"];
  if (
    Object.keys(value).some((key) => !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key)) ||
    value["envelopeVersion"] !== "1" ||
    !object(aggregate) ||
    Object.keys(aggregate).some(
      (key) => !["type", "ref", "version"].includes(key),
    )
  )
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  const occurredAt = stringField(value, "occurredAt");
  const traceparent = stringField(value, "traceparent");
  try {
    toInstant(occurredAt);
  } catch {
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  }
  if (!isTraceparent(traceparent))
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  return Object.freeze({
    envelopeVersion: "1",
    messageId: stringField(value, "messageId"),
    messageType: stringField(value, "messageType"),
    occurredAt,
    producer: stringField(value, "producer"),
    correlationId: stringField(value, "correlationId"),
    causationId:
      value["causationId"] === null ? null : stringField(value, "causationId"),
    traceparent,
    aggregate: Object.freeze({
      type: stringField(aggregate, "type"),
      ref: stringField(aggregate, "ref"),
      version: stringField(aggregate, "version"),
    }),
    payload: parsePayload(value["payload"]),
  });
}
function partitionKey(
  record: Pick<KafkaRecord, "topic" | "partition">,
): string {
  if (
    !/^[A-Za-z0-9._-]{1,249}$/.test(record.topic) ||
    !Number.isSafeInteger(record.partition) ||
    record.partition < 0
  )
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  return `${record.topic}:${record.partition}`;
}
export function validateTransport(
  record: KafkaRecord,
  envelope: KafkaEnvelope,
): void {
  partitionKey(record);
  if (
    !/^(0|[1-9][0-9]*)$/.test(record.offset) ||
    typeof record.key !== "string" ||
    record.key.length === 0 ||
    record.key.length > 256
  )
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  for (const field of [
    "messageId",
    "correlationId",
    "causationId",
    "traceparent",
  ] as const) {
    if (
      record.headers[field] !== undefined &&
      (record.headers[field] === null ||
        record.headers[field] !== envelope[field])
    )
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  }
}

type PartitionBudget = {
  active: number;
  owned: number;
  maxInFlight: number;
  queueCapacity: number;
  wake: Set<() => void>;
};
type Partition = {
  queue: KafkaRecord[];
  busy: boolean;
  failed: boolean;
  lastOffset?: bigint;
};
/** Один serial worker на assignment; общий cap включает queued и in-flight records. */
export class PartitionWorkers {
  private readonly partitions = new Map<string, Partition>();
  private readonly pending = new Set<Promise<void>>();
  private readonly abortController = new AbortController();
  private accepting = true;
  private owned = 0;
  private active = 0;
  private readonly budget: PartitionBudget;
  private readonly wake = (): void => this.dispatch();
  private rejected = 0;
  private readonly limits: Readonly<{
    maxPartitions: number;
    maxInFlight: number;
    queueCapacity: number;
  }>;
  private readonly process: (
    record: KafkaRecord,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly onFailure: (error: unknown, record: KafkaRecord) => void;
  public constructor(
    limits: Readonly<{
      maxPartitions: number;
      maxInFlight: number;
      queueCapacity: number;
    }>,
    process: (record: KafkaRecord, signal: AbortSignal) => Promise<void>,
    onFailure: (error: unknown, record: KafkaRecord) => void,
    budget?: PartitionBudget,
  ) {
    this.budget = budget ?? {
      active: 0,
      owned: 0,
      maxInFlight: limits.maxInFlight,
      queueCapacity: limits.queueCapacity,
      wake: new Set(),
    };
    this.budget.wake.add(this.wake);
    this.limits = limits;
    this.process = process;
    this.onFailure = onFailure;
    if (
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value <= 0,
      ) ||
      limits.maxInFlight > limits.queueCapacity
    )
      throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
  }
  public assign(
    assignments: readonly Pick<KafkaRecord, "topic" | "partition">[],
  ): void {
    if (
      !this.accepting ||
      this.owned > 0 ||
      assignments.length > this.limits.maxPartitions
    )
      throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
    this.partitions.clear();
    for (const assignment of assignments) {
      const key = partitionKey(assignment);
      if (this.partitions.has(key))
        throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
      this.partitions.set(key, { queue: [], busy: false, failed: false });
    }
  }
  public enqueue(record: KafkaRecord): void {
    const partition = this.partitions.get(partitionKey(record));
    if (!this.accepting || !partition || partition.failed)
      throw new KafkaRuntimeError("KAFKA_REVOKED");
    if (this.budget.owned >= this.budget.queueCapacity) {
      this.rejected++;
      throw new KafkaRuntimeError("KAFKA_QUEUE_FULL");
    }
    if (!/^(0|[1-9][0-9]*)$/.test(record.offset))
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
    const offset = BigInt(record.offset);
    if (partition.lastOffset !== undefined && offset <= partition.lastOffset)
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
    partition.lastOffset = offset;
    partition.queue.push(record);
    this.owned++;
    this.budget.owned++;
    this.dispatch();
  }
  private dispatch(): void {
    if (!this.accepting) return;
    for (const partition of this.partitions.values()) {
      if (this.budget.active >= this.budget.maxInFlight) break;
      if (partition.busy || partition.failed) continue;
      const record = partition.queue.shift();
      if (!record) continue;
      partition.busy = true;
      this.active++;
      this.budget.active++;
      const task = Promise.resolve()
        .then(() => this.process(record, this.abortController.signal))
        .catch((error: unknown) => {
          partition.failed = true;
          this.owned -= partition.queue.length;
          this.budget.owned -= partition.queue.length;
          partition.queue.length = 0;
          this.onFailure(error, record);
        })
        .finally(() => {
          partition.busy = false;
          this.active--;
          this.owned--;
          this.budget.active--;
          this.budget.owned--;
          this.pending.delete(task);
          for (const wake of this.budget.wake) wake();
        });
      this.pending.add(task);
    }
  }
  public stopIntake(): void {
    this.accepting = false;
    this.budget.wake.delete(this.wake);
    for (const partition of this.partitions.values()) {
      this.owned -= partition.queue.length;
      this.budget.owned -= partition.queue.length;
      partition.queue.length = 0;
    }
  }
  public abort(): void {
    this.stopIntake();
    this.abortController.abort();
  }
  public async drain(): Promise<void> {
    this.stopIntake();
    await Promise.allSettled(this.pending);
  }
  public resetAssignment(): void {
    if (
      this.owned !== 0 ||
      this.pending.size !== 0 ||
      this.abortController.signal.aborted
    )
      throw new KafkaRuntimeError("KAFKA_REVOKED");
    this.partitions.clear();
    this.accepting = true;
    this.budget.wake.add(this.wake);
  }
  public metrics(): Readonly<{
    assigned: number;
    active: number;
    queued: number;
    pending: number;
    capacity: number;
    saturationTotal: number;
  }> {
    return {
      assigned: this.partitions.size,
      active: this.active,
      queued: this.owned - this.active,
      pending: this.pending.size,
      capacity: this.budget.queueCapacity - this.budget.owned,
      saturationTotal: this.rejected,
    };
  }
}

export type DurableBinding = Readonly<{
  processing: "durable";
  database: Database;
  inbox: InboxStore;
  decode: (value: unknown) => KafkaEnvelope;
  handle: (
    transaction: Transaction,
    envelope: KafkaEnvelope,
    record: KafkaRecord,
    signal: AbortSignal,
  ) => Promise<void>;
}>;
export type RealtimeBinding = Readonly<{
  processing: "realtime";
  decode: (value: unknown) => KafkaEnvelope;
  enqueue: (envelope: KafkaEnvelope, signal: AbortSignal) => Promise<void>;
}>;
export type KafkaBinding = DurableBinding | RealtimeBinding;
export type ProcessRecordOptions = Readonly<{
  runtime: string;
  groupId: string;
  topics: readonly string[];
  binding: KafkaBinding;
  leaseMs: number;
  maxMessageBytes: number;
  signal: AbortSignal;
  commit: (record: KafkaRecord) => Promise<void>;
  quarantine?: (
    record: KafkaRecord,
    reason: string,
    wire: JsonValue,
  ) => Promise<void>;
}>;
function recordValue(
  record: KafkaRecord,
  maxBytes: number,
): Readonly<{ wire: JsonValue; decoded: unknown }> {
  const value: unknown =
    record.value instanceof Uint8Array
      ? new TextDecoder("utf-8", { fatal: true }).decode(record.value)
      : record.value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > maxBytes)
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
    try {
      return { wire: value, decoded: JSON.parse(value) as unknown };
    } catch {
      return { wire: value, decoded: undefined };
    }
  }
  const canonical = canonicalJson(value as JsonValue);
  if (Buffer.byteLength(canonical) > maxBytes)
    throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
  return { wire: JSON.parse(canonical) as JsonValue, decoded: value };
}
/** Decode precedes Inbox; offset follows only a resolved known owner COMMIT. */
export async function processKafkaRecord(
  record: KafkaRecord,
  options: ProcessRecordOptions,
): Promise<void> {
  if (!options.topics.includes(record.topic))
    throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
  if (
    options.binding.processing === "realtime" &&
    (options.runtime !== "realtime-gateway" ||
      options.groupId !== "realtime-gateway-v1" ||
      options.topics.length !== 1 ||
      record.topic !== "coffee.realtime.invalidate.v1")
  )
    throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
  let wire: JsonValue | undefined;
  let envelope: KafkaEnvelope | undefined;
  try {
    const value = recordValue(record, options.maxMessageBytes);
    wire = value.wire;
    envelope = parseEnvelope(
      options.binding.decode(value.decoded),
      (payload) => payload,
    );
    validateTransport(record, envelope);
  } catch {
    envelope = undefined;
    // Oversized/non-JSON inputs keep only a digest in quarantine; raw data is never an error label.
    wire ??= {
      digest: createHash("sha256")
        .update(
          typeof record.value === "string"
            ? record.value
            : record.value instanceof Uint8Array
              ? record.value
              : String(record.value),
        )
        .digest("hex"),
    };
  }
  const receivedAt = nowInstant();
  const now = receivedAt.epochMilliseconds;
  if (options.binding.processing === "durable") {
    const binding = options.binding;
    await withTransaction(
      binding.database,
      {
        mode: "background",
        signal: options.signal,
        ...(envelope
          ? {
              correlationId: envelope.correlationId,
              ...(envelope.causationId === null
                ? {}
                : { causationId: envelope.causationId }),
              traceparent: envelope.traceparent,
            }
          : {}),
      },
      async (transaction) => {
        if (!envelope) {
          await binding.inbox.quarantineRecord(
            transaction,
            {
              topic: record.topic,
              partition: record.partition,
              offset: record.offset,
              envelope: wire ?? null,
              reason: "KAFKA_ENVELOPE_INVALID",
            },
            now,
          );
          return;
        }
        const payload = JSON.parse(
          canonicalJson(envelope as unknown as JsonValue),
        ) as JsonValue;
        const begin = await consumeOnce(
          binding.inbox,
          transaction,
          {
            messageId: envelope.messageId,
            messageType: envelope.messageType,
            receivedAt: receivedAt.toString(),
            payloadHash: canonicalRequestHash(payload),
            payload,
          },
          options.groupId,
          now,
          options.leaseMs,
          (tx) =>
            binding.handle(
              tx,
              envelope as KafkaEnvelope,
              record,
              options.signal,
            ),
          nowInstant().toString(),
        );
        if (begin.kind === "in_progress")
          throw new KafkaRuntimeError("KAFKA_HANDLER_FAILED");
        if (begin.kind === "conflict") {
          await binding.inbox.quarantineRecord(
            transaction,
            {
              topic: record.topic,
              partition: record.partition,
              offset: record.offset,
              messageId: envelope.messageId,
              payloadHash: canonicalRequestHash(payload),
              envelope: payload,
              reason: "INBOX_HASH_CONFLICT",
            },
            now,
          );
          return;
        }
        if (begin.kind === "duplicate") return;
      },
    );
  } else if (envelope) {
    await options.binding.enqueue(envelope, options.signal);
  } else {
    if (!options.quarantine)
      throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
    await options.quarantine(record, "KAFKA_ENVELOPE_INVALID", wire ?? null);
  }
  if (options.signal.aborted) throw new KafkaRuntimeError("KAFKA_REVOKED");
  try {
    await options.commit(record);
  } catch (error) {
    if (error instanceof KafkaRuntimeError && error.code === "KAFKA_REVOKED")
      throw error;
    throw new KafkaRuntimeError("OFFSET_COMMIT_OUTCOME_UNKNOWN");
  }
}

export type KafkaCredentials = Readonly<{
  username: string;
  password: string;
  caPem?: string;
}>;
export type KafkaRuntimeOptions = Readonly<{
  runtime: string;
  config: KafkaConfig;
  service: KafkaServiceConfig;
  credentials: KafkaCredentials;
}>;
export type KafkaSendAck = Readonly<{
  kind: "ack";
  topic: string;
  partition: number;
  offset: string;
}>;
export type KafkaRuntime = Readonly<{
  whenFailed: Promise<KafkaRuntimeError>;
  relay: (
    store: OutboxStore,
    database: Database,
    signal?: AbortSignal,
  ) => Promise<OutboxRelayResult>;
  bind: (groupId: string, binding: KafkaBinding) => void;
  send: (
    topic: string,
    key: string,
    envelope: KafkaEnvelope,
    signal?: AbortSignal,
  ) => Promise<KafkaSendAck>;
  resource: Readonly<{
    name: string;
    start: (signal: AbortSignal) => Promise<void>;
    stop: (signal: AbortSignal) => Promise<void>;
    destroy: () => void;
  }>;
  readiness: Readonly<{
    name: string;
    check: (signal: AbortSignal) => Promise<boolean>;
  }>;
  metrics: () => Readonly<{
    active: number;
    queued: number;
    pending: number;
    assigned: number;
    saturationTotal: number;
    unknownCommitTotal: number;
    recoveryTotal: number;
    lastCode: KafkaErrorCode | null;
  }>;
}>;
function deadline<T>(
  promise: Promise<T>,
  ms: number,
  code: KafkaErrorCode,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (): void => finish(() => reject(new KafkaRuntimeError(code)));
    const timer = setTimeout(fail, ms);
    const finish = (done: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      done();
    };
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}
export function validateKafkaRuntimeConfig(
  options: KafkaRuntimeOptions,
): KafkaRuntimeOptions {
  try {
    if (!(RUNTIME_NAMES as readonly string[]).includes(options.runtime))
      throw new Error();
    const config = parseKafkaConfig(options.config);
    const service = validateKafkaServiceConfig(
      options.service,
      options.runtime as RuntimeName,
    );
    const credentials = options.credentials;
    if (
      !credentials ||
      [credentials.username, credentials.password].some(
        (value) => typeof value !== "string" || value.length === 0,
      ) ||
      (credentials.caPem !== undefined &&
        (typeof credentials.caPem !== "string" ||
          credentials.caPem.length === 0))
    )
      throw new Error();
    return {
      ...options,
      config,
      service,
      credentials: Object.freeze({ ...credentials }),
    };
  } catch {
    throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
  }
}

export function createKafkaRuntime(input: KafkaRuntimeOptions): KafkaRuntime {
  const options = validateKafkaRuntimeConfig(input);
  const policy = options.config.delivery;
  type GroupState = {
    restart: boolean;
    current: boolean;
    revoked?: boolean;
    assignment?: readonly Pick<KafkaRecord, "topic" | "partition">[];
  };
  const bindings = new Map<string, KafkaBinding>();
  const fatal = Promise.withResolvers<KafkaRuntimeError>();
  const pending = new Set<Promise<unknown>>();
  const ports = new Set<NativeConsumerPort>();
  const workers = new Set<PartitionWorkers>();
  const shutdown = new AbortController();
  const budget: PartitionBudget = {
    active: 0,
    owned: 0,
    maxInFlight: policy.maxInFlight,
    queueCapacity: policy.queueCapacity,
    wake: new Set(),
  };
  let producer: NativeProducerPort | undefined;
  let relaying = false;
  let started = false;
  let stopping = false;
  let failed = false;
  let unknownCommitTotal = 0;
  let recoveryTotal = 0;
  let lastCode: KafkaErrorCode | null = null;
  const nativeOptions = {
    brokers: options.config.brokers,
    clientId: options.runtime,
    protocol: options.config.clientProtocol,
    username: options.credentials.username,
    password: options.credentials.password,
    ...(options.credentials.caPem === undefined
      ? {}
      : { sslCaPem: options.credentials.caPem }),
    producerRetries: policy.producerRetries,
    maxPending: policy.queueCapacity,
    maxMessageBytes: policy.maxMessageBytes,
    sendTimeoutMs: policy.sendTimeoutMs,
    receiveTimeoutMs: policy.receiveTimeoutMs,
    commitTimeoutMs: policy.commitTimeoutMs,
    shutdownTimeoutMs: policy.shutdownTimeoutMs,
  } as const;
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  async function send(
    topic: string,
    key: string,
    envelope: KafkaEnvelope,
    signal?: AbortSignal,
    quarantine = false,
  ): Promise<KafkaSendAck> {
    const dlqs = Object.values(options.config.topics)
      .filter((topicConfig) =>
        options.service.consumers.some(
          (consumer) =>
            consumer.processing === "realtime" &&
            consumer.topics.includes(topicConfig.name),
        ),
      )
      .map((topicConfig) => topicConfig.dlq);
    if (
      !(quarantine
        ? dlqs.includes(topic)
        : (options.service.producers as readonly string[]).includes(topic))
    )
      throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
    if (!producer || stopping || shutdown.signal.aborted)
      throw new KafkaRuntimeError("KAFKA_STOPPED");
    const validated = parseEnvelope(envelope, (value) => value);
    let serialized: string;
    try {
      serialized = canonicalJson(validated as unknown as JsonValue);
    } catch {
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
    }
    if (
      Buffer.byteLength(serialized) > policy.maxMessageBytes ||
      key.length === 0 ||
      key.length > 256
    )
      throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
    try {
      const ack = await deadline(
        track(
          producer.send(
            topic,
            key,
            serialized,
            {
              messageId: envelope.messageId,
              correlationId: envelope.correlationId,
              traceparent: envelope.traceparent,
              ...(envelope.causationId === null
                ? {}
                : { causationId: envelope.causationId }),
            },
            signal,
          ),
        ),
        policy.sendTimeoutMs,
        "KAFKA_SEND_OUTCOME_UNKNOWN",
        signal,
      );
      return { kind: "ack", ...ack };
    } catch (error) {
      if (
        error instanceof NativeKafkaError &&
        error.code === "NATIVE_QUEUE_FULL"
      )
        throw new KafkaRuntimeError("KAFKA_QUEUE_FULL");
      if (
        error instanceof NativeKafkaError &&
        error.code === "NATIVE_CONFIG_INVALID"
      )
        throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
      lastCode = "KAFKA_SEND_OUTCOME_UNKNOWN";
      throw new KafkaRuntimeError(lastCode);
    }
  }
  async function realtimeQuarantine(
    record: KafkaRecord,
    reason: string,
    wire: JsonValue,
  ): Promise<void> {
    const topic = Object.values(options.config.topics).find(
      (topicConfig) => topicConfig.name === record.topic,
    );
    if (!topic) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
    const id = createHash("sha256")
      .update(`${record.topic}:${record.partition}:${record.offset}`)
      .digest("hex");
    await send(
      topic.dlq,
      record.key || id,
      {
        messageId: id,
        messageType: "QuarantinedTransportRecord",
        envelopeVersion: "1",
        producer: options.runtime,
        causationId: null,
        aggregate: {
          type: "QuarantinedTransportRecord",
          ref: id,
          version: "1",
        },
        occurredAt: nowInstant().toString(),
        correlationId: id,
        traceparent: `00-${id.slice(0, 32)}-${id.slice(32, 48)}-01`,
        payload: {
          topic: record.topic,
          partition: record.partition,
          offset: record.offset,
          reason,
          wire,
        },
      },
      shutdown.signal,
      true,
    );
  }
  async function drainGroup(
    port: NativeConsumerPort,
    executor: PartitionWorkers,
  ): Promise<void> {
    const drained = track(executor.drain());
    if (executor.metrics().pending > 0) {
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(policy.revokeTimeoutMs),
      ]);
      try {
        await track(port.pause());
        // librdkafka serves offset_commit_cb through consumer polling, including during drain.
        while (executor.metrics().pending > 0)
          await track(port.poll(1, signal));
      } catch (error) {
        if (executor.metrics().pending > 0) throw error;
      }
    }
    await drained;
  }
  async function runGroup(
    group: KafkaServiceConfig["consumers"][number],
    initial: NativeConsumerPort,
    initialWorkers: PartitionWorkers,
    state: GroupState,
  ): Promise<void> {
    let port = initial;
    let executor = initialWorkers;
    let recoveries = 0;
    while (!stopping) {
      try {
        while (!stopping && !state.restart) {
          const capacity = executor.metrics().capacity;
          if (capacity === 0) await track(port.pause());
          else await track(port.resume());
          const records = await track(
            port.poll(
              Math.max(1, Math.min(capacity, policy.maxInFlight)),
              shutdown.signal,
            ),
          );
          if (state.restart || stopping) break;
          for (const record of records)
            executor.enqueue({ ...record, key: record.key ?? "" });
        }
      } catch (error) {
        if (!stopping) {
          lastCode =
            error instanceof KafkaRuntimeError
              ? error.code
              : "KAFKA_CONNECTION_FAILED";
          state.restart = true;
          delete state.revoked;
        }
      }
      state.current = false;
      executor.stopIntake();
      try {
        await deadline(
          track(drainGroup(port, executor)),
          policy.revokeTimeoutMs,
          "KAFKA_SHUTDOWN_TIMEOUT",
        );
      } catch {
        executor.abort();
        failed = true;
        lastCode = "KAFKA_SHUTDOWN_TIMEOUT";
        throw new KafkaRuntimeError(lastCode);
      }
      if (state.revoked && !stopping) {
        // A normal rebalance keeps its group member; reconnecting would trigger another rebalance.
        await track(port.unassign());
        executor.resetAssignment();
        state.current = true;
        state.restart = false;
        delete state.revoked;
        if (state.assignment) {
          executor.assign(state.assignment);
          await track(port.assign(state.assignment));
          delete state.assignment;
        }
        continue;
      }
      await deadline(
        track(port.close()),
        policy.shutdownTimeoutMs,
        "KAFKA_SHUTDOWN_TIMEOUT",
      );
      ports.delete(port);
      workers.delete(executor);
      if (stopping) return;
      // Revoke/reconnect is a fresh assignment, never a retry inside the unsafe owner handler.
      if (++recoveries > policy.retry.maxAttempts)
        throw new KafkaRuntimeError("KAFKA_CONNECTION_FAILED");
      recoveryTotal++;
      const replacement = await openGroup(group);
      port = replacement.port;
      executor = replacement.executor;
      state = replacement.state;
    }
  }
  async function openGroup(
    group: KafkaServiceConfig["consumers"][number],
  ): Promise<{
    port: NativeConsumerPort;
    executor: PartitionWorkers;
    state: GroupState;
  }> {
    const state: GroupState = { restart: false, current: true };
    let port: NativeConsumerPort;
    const binding = bindings.get(group.groupId);
    const executor = new PartitionWorkers(
      {
        maxPartitions: policy.maxPartitions,
        maxInFlight: policy.maxInFlight,
        queueCapacity: policy.queueCapacity,
      },
      async (record, signal) => {
        if (!binding) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
        await processKafkaRecord(record, {
          runtime: options.runtime,
          groupId: group.groupId,
          topics: group.topics,
          binding,
          leaseMs: policy.leaseMs,
          maxMessageBytes: policy.maxMessageBytes,
          signal,
          commit: async (processed) => {
            if (!state.current) throw new KafkaRuntimeError("KAFKA_REVOKED");
            await deadline(
              track(
                port.commit(
                  processed.topic,
                  processed.partition,
                  (BigInt(processed.offset) + 1n).toString(),
                ),
              ),
              policy.commitTimeoutMs,
              "OFFSET_COMMIT_OUTCOME_UNKNOWN",
            );
          },
          quarantine: realtimeQuarantine,
        });
      },
      (error: unknown) => {
        lastCode =
          error instanceof KafkaRuntimeError
            ? error.code
            : "KAFKA_HANDLER_FAILED";
        if (lastCode === "OFFSET_COMMIT_OUTCOME_UNKNOWN") unknownCommitTotal++;
        if (lastCode !== "KAFKA_REVOKED") delete state.revoked;
        state.current = false;
        state.restart = true;
        executor.stopIntake();
      },
      budget,
    );
    workers.add(executor);
    const rebalance = (event: NativeRebalanceEvent): void => {
      if (stopping) return;
      if (event.type === "revoked") {
        state.current = false;
        state.restart = true;
        state.revoked = true;
        executor.stopIntake();
        return;
      }
      if (event.type === "assigned" && state.revoked) {
        state.assignment = event.partitions;
        return;
      }
      if (
        event.type !== "assigned" ||
        !state.current ||
        executor.metrics().active !== 0
      ) {
        delete state.revoked;
        state.current = false;
        state.restart = true;
        executor.stopIntake();
        return;
      }
      try {
        executor.assign(event.partitions);
        void track(port.assign(event.partitions)).catch(() => {
          state.current = false;
          state.restart = true;
          executor.stopIntake();
        });
      } catch {
        state.current = false;
        state.restart = true;
        executor.stopIntake();
      }
    };
    port = await track(
      createNativeConsumer(
        {
          ...nativeOptions,
          clientId: `${options.runtime}:${group.groupId}`,
          groupId: group.groupId,
          topics: group.topics,
          autoOffsetReset: group.processing === "realtime" ? "latest" : "error",
        },
        rebalance,
      ),
    );
    ports.add(port);
    if (stopping || shutdown.signal.aborted) {
      await track(port.close());
      ports.delete(port);
      workers.delete(executor);
      throw new KafkaRuntimeError("KAFKA_STOPPED");
    }
    await deadline(
      track(port.connect()),
      policy.shutdownTimeoutMs,
      "KAFKA_CONNECTION_FAILED",
      shutdown.signal,
    );
    if (binding) await track(port.subscribe(group.topics));
    return { port, executor, state };
  }
  async function closePorts(): Promise<void> {
    const results = await Promise.allSettled(
      [...ports, ...(producer ? [producer] : [])].map((port) =>
        track(port.close()),
      ),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new KafkaRuntimeError("KAFKA_SHUTDOWN_TIMEOUT");
  }
  const destroy = (): void => {
    stopping = true;
    shutdown.abort();
    for (const worker of workers) worker.abort();
    void track(closePorts()).catch(() => {
      failed = true;
    });
  };
  return Object.freeze({
    whenFailed: fatal.promise,
    relay: async (
      store: OutboxStore,
      database: Database,
      signal?: AbortSignal,
    ): Promise<OutboxRelayResult> => {
      if (!started || stopping) throw new KafkaRuntimeError("KAFKA_STOPPED");
      if (relaying) throw new KafkaRuntimeError("KAFKA_QUEUE_FULL");
      relaying = true;
      try {
        return await track(
          relayOutboxBatch(
            store,
            database,
            async (claim, sendSignal) => {
              try {
                return await send(
                  claim.message.topic,
                  claim.message.partitionKey,
                  claim.message.envelope as KafkaEnvelope,
                  sendSignal,
                );
              } catch (error) {
                if (
                  error instanceof KafkaRuntimeError &&
                  (error.code === "KAFKA_CONFIG_INVALID" ||
                    error.code === "KAFKA_ENVELOPE_INVALID")
                )
                  return { kind: "failed", permanent: true, error: error.code };
                if (
                  error instanceof KafkaRuntimeError &&
                  error.code === "KAFKA_QUEUE_FULL"
                )
                  return { kind: "failed", error: error.code };
                return { kind: "unknown" };
              }
            },
            {
              nowMs: nowInstant().epochMilliseconds,
              leaseOwner: options.runtime,
              policy,
              ...(signal === undefined ? {} : { signal }),
            },
          ),
        );
      } finally {
        relaying = false;
      }
    },
    bind: (groupId: string, binding: KafkaBinding): void => {
      const group = options.service.consumers.find(
        (consumer) => consumer.groupId === groupId,
      );
      if (
        started ||
        !group ||
        bindings.has(groupId) ||
        binding.processing !== group.processing
      )
        throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID");
      bindings.set(groupId, binding);
    },
    send: (
      topic: string,
      key: string,
      envelope: KafkaEnvelope,
      signal?: AbortSignal,
    ): Promise<KafkaSendAck> => send(topic, key, envelope, signal),
    resource: {
      name: "kafka",
      start: async (signal: AbortSignal): Promise<void> => {
        if (started || stopping) throw new KafkaRuntimeError("KAFKA_STOPPED");
        started = true;
        const startup = async (): Promise<void> => {
          if (
            options.service.producers.length > 0 ||
            options.service.consumers.some(
              (consumer) => consumer.processing === "realtime",
            )
          ) {
            producer = await track(createNativeProducer(nativeOptions));
            if (stopping || shutdown.signal.aborted) {
              await track(producer.close());
              throw new KafkaRuntimeError("KAFKA_STOPPED");
            }
            await track(producer.connect());
          }
          for (const group of options.service.consumers) {
            const opened = await openGroup(group);
            if (bindings.has(group.groupId))
              void track(
                runGroup(group, opened.port, opened.executor, opened.state),
              ).catch(() => {
                failed = true;
                lastCode ??= "KAFKA_CONNECTION_FAILED";
                fatal.resolve(new KafkaRuntimeError(lastCode));
              });
          }
        };
        try {
          await deadline(
            track(startup()),
            policy.shutdownTimeoutMs,
            "KAFKA_CONNECTION_FAILED",
            signal,
          );
        } catch {
          failed = true;
          destroy();
          throw new KafkaRuntimeError("KAFKA_CONNECTION_FAILED");
        }
      },
      stop: async (signal: AbortSignal): Promise<void> => {
        stopping = true;
        for (const worker of workers) worker.stopIntake();
        try {
          await deadline(
            track(Promise.all([...workers].map((worker) => worker.drain()))),
            policy.revokeTimeoutMs,
            "KAFKA_SHUTDOWN_TIMEOUT",
            signal,
          );
          shutdown.abort();
          await deadline(
            track(closePorts()),
            policy.shutdownTimeoutMs,
            "KAFKA_SHUTDOWN_TIMEOUT",
            signal,
          );
          while (pending.size > 0)
            await deadline(
              Promise.allSettled(pending),
              policy.shutdownTimeoutMs,
              "KAFKA_SHUTDOWN_TIMEOUT",
              signal,
            );
          if (failed)
            throw new KafkaRuntimeError(lastCode ?? "KAFKA_SHUTDOWN_TIMEOUT");
        } catch {
          destroy();
          throw new KafkaRuntimeError("KAFKA_SHUTDOWN_TIMEOUT");
        }
      },
      destroy,
    },
    readiness: {
      name: "kafka",
      check: async (signal: AbortSignal): Promise<boolean> => {
        if (!started || stopping || failed) return false;
        try {
          const health = await deadline(
            track(
              Promise.all([
                ...(producer ? [producer.health(signal)] : []),
                ...[...ports].map((port) => port.health(signal)),
              ]),
            ),
            policy.receiveTimeoutMs,
            "KAFKA_CONNECTION_FAILED",
            signal,
          );
          return health.length > 0 && health.every(Boolean);
        } catch {
          return false;
        }
      },
    },
    metrics: () => ({
      active: budget.active,
      queued: budget.owned - budget.active,
      pending: pending.size,
      assigned: [...workers].reduce(
        (sum, worker) => sum + worker.metrics().assigned,
        0,
      ),
      saturationTotal: [...workers].reduce(
        (sum, worker) => sum + worker.metrics().saturationTotal,
        0,
      ),
      unknownCommitTotal,
      recoveryTotal,
      lastCode,
    }),
  });
}
