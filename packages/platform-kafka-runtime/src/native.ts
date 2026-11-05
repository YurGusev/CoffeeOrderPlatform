import { Buffer } from "node:buffer";
import {
  launchKafkaLogicalTopic,
  launchKafkaPhysicalName,
  type LaunchKafkaTarget,
} from "@coffee-platform/config";

const ASSIGN_PARTITIONS = -175;
const REVOKE_PARTITIONS = -174;
const TIMED_OUT = -185;
const TIMED_OUT_QUEUE = -166;
const QUEUE_FULL = -184;
const INVALID_ARG = -186;
const INVALID_MSG_SIZE = 4;
const MSG_SIZE_TOO_LARGE = 10;
const MAX_SAFE_OFFSET = Number.MAX_SAFE_INTEGER;

export type NativeKafkaProtocol = "SASL_SSL" | "PLAINTEXT";

export type NativePartition = Readonly<{
  topic: string;
  partition: number;
}>;

export type NativeKafkaRecord = Readonly<{
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: Uint8Array | null;
  headers: Readonly<Record<string, string | null>>;
}>;

export type NativeProducerDelivery = Readonly<{
  topic: string;
  partition: number;
  offset: string;
}>;

export type NativeRebalanceEvent =
  | Readonly<{ type: "assigned"; partitions: readonly NativePartition[] }>
  | Readonly<{ type: "revoked"; partitions: readonly NativePartition[] }>
  | Readonly<{
      type: "failed";
      partitions: readonly NativePartition[];
      error: NativeKafkaError;
    }>;

export type NativeKafkaErrorCode =
  | "NATIVE_LOAD_FAILED"
  | "NATIVE_CONFIG_INVALID"
  | "NATIVE_CONNECT_FAILED"
  | "NATIVE_NOT_CONNECTED"
  | "NATIVE_CLIENT_CLOSED"
  | "NATIVE_QUEUE_FULL"
  | "NATIVE_OPERATION_TIMEOUT"
  | "NATIVE_OPERATION_ABORTED"
  | "NATIVE_OPERATION_FAILED"
  | "NATIVE_DELIVERY_FAILED"
  | "NATIVE_RECORD_INVALID"
  | "NATIVE_OFFSET_INVALID"
  | "NATIVE_REBALANCE_FAILED";

export class NativeKafkaError extends Error {
  public readonly code: NativeKafkaErrorCode;

  public constructor(code: NativeKafkaErrorCode) {
    super(code);
    this.name = "NativeKafkaError";
    this.code = code;
  }
}

type NativeCommonOptions = Readonly<{
  brokers: readonly string[];
  clientId: string;
  protocol: NativeKafkaProtocol;
  username?: string;
  password?: string;
  sslCaPem?: string;
  maxPending: number;
  maxMessageBytes: number;
  sendTimeoutMs: number;
  receiveTimeoutMs: number;
  commitTimeoutMs: number;
  shutdownTimeoutMs: number;
  physicalTargets?: LaunchKafkaTarget;
}>;

export type NativeProducerOptions = NativeCommonOptions &
  Readonly<{
    producerRetries: number;
  }>;

export type NativeConsumerOptions = NativeCommonOptions &
  Readonly<{
    groupId: string;
    topics: readonly string[];
    autoOffsetReset: "error" | "latest";
  }>;

export type NativeProducerPort = Readonly<{
  connect(): Promise<void>;
  send(
    topic: string,
    key: string,
    serializedEnvelope: string | Uint8Array,
    headers: Readonly<Record<string, string | Buffer>>,
    signal?: AbortSignal,
  ): Promise<NativeProducerDelivery>;
  health(signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}>;

export type NativeConsumerPort = Readonly<{
  connect(): Promise<void>;
  subscribe(topics: readonly string[]): Promise<void>;
  poll(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly NativeKafkaRecord[]>;
  setConsumeTimeout(timeoutMs: number): void;
  commit(
    topic: string,
    partition: number,
    nextOffset: string,
    signal?: AbortSignal,
  ): Promise<void>;
  pause(
    partitions?: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void>;
  resume(
    partitions?: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void>;
  assign(
    partitions: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void>;
  unassign(signal?: AbortSignal): Promise<void>;
  health(signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}>;

type NativeConfig = Record<string, unknown>;
type Callback<T> = (error?: unknown, value?: T) => void;

type ProducerClient = Readonly<{
  connect(
    metadataOptions: Readonly<Record<string, number | boolean>>,
    callback: Callback<unknown>,
  ): unknown;
  disconnect(
    timeoutOrCallback: number | Callback<unknown>,
    callback?: Callback<unknown>,
  ): unknown;
  getMetadata(
    options: Readonly<Record<string, number | boolean>>,
    callback: Callback<unknown>,
  ): unknown;
  isConnected(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  poll(): unknown;
  produce(
    topic: string,
    partition: number | null,
    message: Uint8Array | null,
    key: string | null,
    timestamp: number | null,
    opaque: object,
    headers: readonly Readonly<Record<string, string | Buffer>>[],
  ): unknown;
}>;

type ConsumerClient = Readonly<{
  connect(
    metadataOptions: Readonly<Record<string, number | boolean>>,
    callback: Callback<unknown>,
  ): unknown;
  disconnect(callback: Callback<unknown>): unknown;
  getMetadata(
    options: Readonly<Record<string, number | boolean>>,
    callback: Callback<unknown>,
  ): unknown;
  isConnected(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  subscribe(topics: readonly string[]): unknown;
  consume(
    limit: number,
    callback: (error?: unknown, messages?: readonly unknown[]) => void,
  ): unknown;
  setDefaultConsumeTimeout(timeoutMs: number): void;
  setDefaultIsTimeoutOnlyForFirstMessage(value: boolean): void;
  pause(partitions: readonly NativePartition[]): unknown;
  resume(partitions: readonly NativePartition[]): unknown;
  assign(partitions: readonly NativePartition[]): unknown;
  unassign(): unknown;
  assignments(): readonly NativePartition[];
  getWatermarkOffsets(topic: string, partition: number): unknown;
}>;

type ConsumerWithCommitCallback = ConsumerClient &
  Readonly<{
    commitCb(
      toppars: readonly NativeOffset[],
      callback: Callback<unknown>,
    ): unknown;
  }>;

type NativeOffset = NativePartition & Readonly<{ offset: number }>;

type PortState =
  "new" | "connecting" | "connected" | "failed" | "closing" | "closed";

type PendingDelivery = Readonly<{
  resolve: (delivery: NativeProducerDelivery) => void;
  reject: (reason: NativeKafkaError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  abort: () => void;
  settled: { value: boolean };
}>;

type PendingCommit = Readonly<{
  resolve: () => void;
  reject: (reason: NativeKafkaError) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  signal: AbortSignal | undefined;
  abort: () => void;
  settled: { value: boolean };
}>;

function error(code: NativeKafkaErrorCode): NativeKafkaError {
  return new NativeKafkaError(code);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateCommonOptions(options: NativeCommonOptions): void {
  if (
    !Array.isArray(options.brokers) ||
    options.brokers.length === 0 ||
    options.brokers.some(
      (broker) => typeof broker !== "string" || broker.length === 0,
    )
  ) {
    throw error("NATIVE_CONFIG_INVALID");
  }
  if (typeof options.clientId !== "string" || options.clientId.length === 0)
    throw error("NATIVE_CONFIG_INVALID");
  if (options.protocol !== "SASL_SSL" && options.protocol !== "PLAINTEXT")
    throw error("NATIVE_CONFIG_INVALID");
  if ((options.username === undefined) !== (options.password === undefined))
    throw error("NATIVE_CONFIG_INVALID");
  if (
    options.protocol === "SASL_SSL" &&
    (options.username === undefined || options.password === undefined)
  ) {
    throw error("NATIVE_CONFIG_INVALID");
  }
  if (
    options.sslCaPem !== undefined &&
    (typeof options.sslCaPem !== "string" || options.sslCaPem.length === 0)
  ) {
    throw error("NATIVE_CONFIG_INVALID");
  }
  for (const value of [
    options.maxPending,
    options.maxMessageBytes,
    options.sendTimeoutMs,
    options.receiveTimeoutMs,
    options.commitTimeoutMs,
    options.shutdownTimeoutMs,
  ]) {
    if (!positiveSafeInteger(value)) throw error("NATIVE_CONFIG_INVALID");
  }
}

function validateConsumerOptions(options: NativeConsumerOptions): void {
  validateCommonOptions(options);
  if (typeof options.groupId !== "string" || options.groupId.length === 0)
    throw error("NATIVE_CONFIG_INVALID");
  if (
    !Array.isArray(options.topics) ||
    options.topics.length === 0 ||
    options.topics.some(
      (topic) => typeof topic !== "string" || topic.length === 0,
    )
  ) {
    throw error("NATIVE_CONFIG_INVALID");
  }
  if (
    options.autoOffsetReset !== "error" &&
    options.autoOffsetReset !== "latest"
  ) {
    throw error("NATIVE_CONFIG_INVALID");
  }
}

function queueBytes(options: NativeCommonOptions): number {
  const total = options.maxMessageBytes * options.maxPending;
  if (!Number.isSafeInteger(total) || total < 1)
    throw error("NATIVE_CONFIG_INVALID");
  return Math.max(1, Math.ceil(total / 1024));
}

function baseConfig(options: NativeCommonOptions): NativeConfig {
  const config: NativeConfig = {
    "bootstrap.servers": options.brokers.join(","),
    "client.id": options.clientId,
    "security.protocol":
      options.protocol === "SASL_SSL" ? "sasl_ssl" : "plaintext",
    "allow.auto.create.topics": false,
    "socket.timeout.ms": Math.max(
      options.sendTimeoutMs,
      options.receiveTimeoutMs,
    ),
  };
  if (options.protocol === "SASL_SSL") {
    config["sasl.mechanisms"] = "PLAIN";
    config["sasl.username"] = options.username as string;
    config["sasl.password"] = options.password as string;
    if (options.sslCaPem !== undefined) config["ssl.ca.pem"] = options.sslCaPem;
  }
  return config;
}

function brokerTopic(options: NativeCommonOptions, topic: string): string {
  return options.physicalTargets
    ? launchKafkaPhysicalName(options.physicalTargets, topic)
    : topic;
}

function runtimeTopic(options: NativeCommonOptions, topic: string): string {
  return options.physicalTargets
    ? launchKafkaLogicalTopic(options.physicalTargets, topic)
    : topic;
}

function producerConfig(options: NativeProducerOptions): NativeConfig {
  return {
    ...baseConfig(options),
    "message.max.bytes": options.maxMessageBytes,
    "enable.idempotence": true,
    "max.in.flight.requests.per.connection": 1,
    "message.send.max.retries": options.producerRetries,
    "request.required.acks": -1,
    "delivery.report.only.error": false,
    dr_msg_cb: true,
    "queue.buffering.max.messages": options.maxPending,
    "queue.buffering.max.kbytes": queueBytes(options),
    "message.timeout.ms": options.sendTimeoutMs,
    "request.timeout.ms": options.sendTimeoutMs,
  };
}

export const MAX_IDLE_CONSUMER_POLL_TIMEOUT_MS = 250;

export function consumerPollTimeout(receiveTimeoutMs: number): number {
  return Math.max(1, Math.min(10, Math.floor(receiveTimeoutMs / 2)));
}

function consumerConfig(options: NativeConsumerOptions): NativeConfig {
  return {
    ...baseConfig(options),
    "group.id": options.physicalTargets
      ? launchKafkaPhysicalName(options.physicalTargets, options.groupId)
      : options.groupId,
    "enable.auto.commit": false,
    "enable.auto.offset.store": false,
    "queued.min.messages": 1,
    "queued.max.messages.kbytes": queueBytes(options),
    "fetch.queue.backoff.ms": consumerPollTimeout(options.receiveTimeoutMs),
    offset_commit_cb: true,
    "statistics.interval.ms": options.receiveTimeoutMs,
    // An idle Fetch must not hold broker health traffic for the whole receive
    // deadline. Keep that deadline and broker-confirmed commit ACK unchanged.
    "fetch.wait.max.ms": Math.min(100, options.receiveTimeoutMs),
    "request.timeout.ms": options.receiveTimeoutMs,
  };
}

function toOffset(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SAFE_OFFSET
  ) {
    throw error("NATIVE_OFFSET_INVALID");
  }
  return value;
}

function fromOffset(value: unknown): string {
  return String(toOffset(value));
}

function parseOffset(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw error("NATIVE_OFFSET_INVALID");
  const offset = Number(value);
  return toOffset(offset);
}

function partition(value: unknown): NativePartition {
  if (value === null || typeof value !== "object")
    throw error("NATIVE_RECORD_INVALID");
  const source = value as Record<string, unknown>;
  if (typeof source["topic"] !== "string" || source["topic"].length === 0)
    throw error("NATIVE_RECORD_INVALID");
  if (
    typeof source["partition"] !== "number" ||
    !Number.isSafeInteger(source["partition"]) ||
    source["partition"] < 0
  ) {
    throw error("NATIVE_RECORD_INVALID");
  }
  return Object.freeze({
    topic: source["topic"],
    partition: source["partition"],
  });
}

function partitions(value: unknown): readonly NativePartition[] {
  if (!Array.isArray(value)) throw error("NATIVE_REBALANCE_FAILED");
  return Object.freeze(value.map((entry) => partition(entry)));
}

function nativeHeaders(
  value: unknown,
): Readonly<Record<string, string | null>> {
  if (value === null || typeof value !== "object")
    throw error("NATIVE_RECORD_INVALID");
  const result: Record<string, string | null> = Object.create(null) as Record<
    string,
    string | null
  >;
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw error("NATIVE_RECORD_INVALID");
    for (const [key, header] of Object.entries(entry)) {
      if (key.length === 0) throw error("NATIVE_RECORD_INVALID");
      if (Object.hasOwn(result, key)) {
        // A map cannot represent duplicate Kafka headers. Preserve the fact
        // that the value was ambiguous so transport validation quarantines a
        // known header instead of silently accepting the last occurrence.
        result[key] = null;
      } else if (typeof header === "string") result[key] = header;
      else if (Buffer.isBuffer(header)) result[key] = header.toString("utf8");
      else if (header === null) result[key] = null;
      else throw error("NATIVE_RECORD_INVALID");
    }
  }
  return Object.freeze(result);
}

function encodeHeaders(
  headers: Readonly<Record<string, string | Buffer>>,
): readonly Readonly<Record<string, string | Buffer>>[] {
  return Object.freeze(
    Object.entries(headers).map(([key, value]) => {
      if (
        key.length === 0 ||
        (typeof value !== "string" && !Buffer.isBuffer(value))
      )
        throw error("NATIVE_CONFIG_INVALID");
      return Object.freeze({ [key]: value });
    }),
  );
}

function record(value: unknown): NativeKafkaRecord {
  if (value === null || typeof value !== "object")
    throw error("NATIVE_RECORD_INVALID");
  const source = value as Record<string, unknown>;
  const location = partition(source);
  const rawKey = source["key"];
  const key =
    rawKey === undefined || rawKey === null
      ? null
      : Buffer.isBuffer(rawKey)
        ? rawKey.toString("utf8")
        : typeof rawKey === "string"
          ? rawKey
          : null;
  if (rawKey !== undefined && rawKey !== null && key === null)
    throw error("NATIVE_RECORD_INVALID");
  const rawValue = source["value"];
  const valueBytes =
    rawValue === undefined || rawValue === null
      ? null
      : Buffer.isBuffer(rawValue)
        ? new Uint8Array(rawValue)
        : null;
  if (rawValue !== undefined && rawValue !== null && valueBytes === null)
    throw error("NATIVE_RECORD_INVALID");
  return Object.freeze({
    ...location,
    offset: fromOffset(source["offset"]),
    key,
    value: valueBytes,
    headers:
      source["headers"] === undefined || source["headers"] === null
        ? Object.freeze(Object.create(null) as Record<string, string | null>)
        : nativeHeaders(source["headers"]),
  });
}

function delivery(value: unknown): NativeProducerDelivery {
  if (value === null || typeof value !== "object")
    throw error("NATIVE_DELIVERY_FAILED");
  const source = value as Record<string, unknown>;
  const location = partition(source);
  return Object.freeze({ ...location, offset: fromOffset(source["offset"]) });
}

function invoke<T>(
  start: (callback: Callback<T>) => void,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failureCode: NativeKafkaErrorCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | NativeKafkaError, failed: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failed) reject(value as NativeKafkaError);
      else resolve(value as T);
    };
    const abort = (): void => finish(error("NATIVE_OPERATION_ABORTED"), true);
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    timer = setTimeout(
      () => finish(error("NATIVE_OPERATION_TIMEOUT"), true),
      timeoutMs,
    );
    timer.unref?.();
    if (signal?.aborted) {
      finish(error("NATIVE_OPERATION_ABORTED"), true);
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      start((nativeError, value) => {
        if (nativeError !== undefined && nativeError !== null) {
          finish(error(failureCode), true);
        } else if (value === undefined) {
          finish(undefined as T, false);
        } else {
          finish(value, false);
        }
      });
    } catch {
      finish(error(failureCode), true);
    }
  });
}

function invokeUntilCallback<T>(
  start: (callback: Callback<T>) => void,
  failureCode: NativeKafkaErrorCode,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (value: T | NativeKafkaError, failed: boolean): void => {
      if (settled) return;
      settled = true;
      if (failed) reject(value as NativeKafkaError);
      else resolve(value as T);
    };
    try {
      start((nativeError, value) => {
        if (nativeError !== undefined && nativeError !== null)
          finish(error(failureCode), true);
        else finish(value as T, false);
      });
    } catch {
      finish(error(failureCode), true);
    }
  });
}

async function loadNative(): Promise<{
  Producer: new (config: NativeConfig, topicConfig?: NativeConfig) => unknown;
  KafkaConsumer: new (
    config: NativeConfig,
    topicConfig?: NativeConfig,
  ) => unknown;
}> {
  try {
    const module = await import("@confluentinc/kafka-javascript");
    const candidate = module as unknown as {
      RdKafka?: Readonly<{
        Producer?: unknown;
        KafkaConsumer?: unknown;
      }>;
      default?: Readonly<{
        RdKafka?: Readonly<{
          Producer?: unknown;
          KafkaConsumer?: unknown;
        }>;
      }>;
    };
    const rdKafka = candidate.RdKafka ?? candidate.default?.RdKafka;
    const Producer = rdKafka?.Producer as
      | (new (config: NativeConfig, topicConfig?: NativeConfig) => unknown)
      | undefined;
    const KafkaConsumer = rdKafka?.KafkaConsumer as
      | (new (config: NativeConfig, topicConfig?: NativeConfig) => unknown)
      | undefined;
    if (typeof Producer !== "function" || typeof KafkaConsumer !== "function") {
      throw error("NATIVE_LOAD_FAILED");
    }
    return { Producer, KafkaConsumer };
  } catch (cause) {
    if (cause instanceof NativeKafkaError) throw cause;
    throw error("NATIVE_LOAD_FAILED");
  }
}

function nativeConnected(client: ProducerClient | ConsumerClient): boolean {
  try {
    return client.isConnected();
  } catch {
    return false;
  }
}

function nativeCode(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const code = (value as Record<string, unknown>)["code"];
  return typeof code === "number" ? code : undefined;
}

function producerFailureCode(value: unknown): NativeKafkaErrorCode {
  switch (nativeCode(value)) {
    case QUEUE_FULL:
      return "NATIVE_QUEUE_FULL";
    case INVALID_MSG_SIZE:
    case MSG_SIZE_TOO_LARGE:
    case INVALID_ARG:
      return "NATIVE_CONFIG_INVALID";
    default:
      return "NATIVE_DELIVERY_FAILED";
  }
}

function consumerCommitFailureCode(value: unknown): NativeKafkaErrorCode {
  switch (nativeCode(value)) {
    case QUEUE_FULL:
      return "NATIVE_QUEUE_FULL";
    case INVALID_MSG_SIZE:
    case MSG_SIZE_TOO_LARGE:
    case INVALID_ARG:
      return "NATIVE_CONFIG_INVALID";
    case TIMED_OUT:
    case TIMED_OUT_QUEUE:
      return "NATIVE_OPERATION_TIMEOUT";
    default:
      return "NATIVE_OPERATION_FAILED";
  }
}

function commitKey(
  topic: string,
  partitionNumber: number,
  offset: string,
): string {
  return `${topic}\u0000${partitionNumber}\u0000${offset}`;
}

function samePartitions(
  value: readonly NativePartition[],
): readonly NativePartition[] {
  return Object.freeze(value.map((entry) => partition(entry)));
}

export async function createNativeProducer(
  options: NativeProducerOptions,
): Promise<NativeProducerPort> {
  validateCommonOptions(options);
  if (!positiveSafeInteger(options.producerRetries))
    throw error("NATIVE_CONFIG_INVALID");
  const module = await loadNative();
  let client: ProducerClient;
  try {
    client = new module.Producer(producerConfig(options), {}) as ProducerClient;
  } catch {
    throw error("NATIVE_CONFIG_INVALID");
  }

  let state: PortState = "new";
  let connectPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const pending = new Map<object, PendingDelivery>();

  client.on("disconnected", () => {
    if (state !== "closing" && state !== "closed") state = "failed";
  });
  client.on("delivery-report", (nativeError, report) => {
    if (report === null || typeof report !== "object") return;
    const opaque = (report as Record<string, unknown>)["opaque"];
    if (opaque === null || typeof opaque !== "object") return;
    const request = pending.get(opaque);
    if (request === undefined) return;
    pending.delete(opaque);
    if (request.timer !== undefined) clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.abort);
    if (request.settled.value) return;
    request.settled.value = true;
    if (nativeError !== undefined && nativeError !== null)
      request.reject(error(producerFailureCode(nativeError)));
    else {
      try {
        const delivered = delivery(report);
        request.resolve(
          Object.freeze({
            ...delivered,
            topic: runtimeTopic(options, delivered.topic),
          }),
        );
      } catch {
        request.reject(error("NATIVE_DELIVERY_FAILED"));
      }
    }
  });

  const startPolling = (): void => {
    if (pollTimer !== undefined) return;
    pollTimer = setInterval(
      () => {
        if (state !== "connected" || !nativeConnected(client)) return;
        try {
          client.poll();
        } catch {
          state = "failed";
        }
      },
      Math.max(10, Math.min(250, Math.floor(options.sendTimeoutMs / 4))),
    );
    pollTimer.unref?.();
  };

  const stopPolling = (): void => {
    if (pollTimer === undefined) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const connect = (): Promise<void> => {
    if (state === "connected") return Promise.resolve();
    if (state === "failed")
      return Promise.reject(error("NATIVE_CONNECT_FAILED"));
    if (state === "closing" || state === "closed")
      return Promise.reject(error("NATIVE_CLIENT_CLOSED"));
    if (connectPromise !== undefined) return connectPromise;
    state = "connecting";
    connectPromise = invoke<void>(
      (callback) => {
        client.connect(
          { allTopics: false, timeout: options.sendTimeoutMs },
          callback as Callback<unknown>,
        );
      },
      options.sendTimeoutMs,
      undefined,
      "NATIVE_CONNECT_FAILED",
    )
      .then(() => {
        if (state !== "connecting") throw error("NATIVE_CLIENT_CLOSED");
        state = "connected";
        startPolling();
      })
      .catch((cause) => {
        state = "failed";
        throw cause;
      });
    return connectPromise;
  };

  const send = (
    topic: string,
    key: string,
    serializedEnvelope: string | Uint8Array,
    headers: Readonly<Record<string, string | Buffer>>,
    signal?: AbortSignal,
  ): Promise<NativeProducerDelivery> => {
    if (state !== "connected" || !nativeConnected(client))
      return Promise.reject(
        error(
          state === "closing" || state === "closed"
            ? "NATIVE_CLIENT_CLOSED"
            : "NATIVE_NOT_CONNECTED",
        ),
      );
    if (
      typeof topic !== "string" ||
      topic.length === 0 ||
      typeof key !== "string"
    )
      return Promise.reject(error("NATIVE_CONFIG_INVALID"));
    const bytes =
      typeof serializedEnvelope === "string"
        ? Buffer.from(serializedEnvelope, "utf8")
        : Buffer.from(serializedEnvelope);
    if (bytes.byteLength > options.maxMessageBytes)
      return Promise.reject(error("NATIVE_CONFIG_INVALID"));
    if (pending.size >= options.maxPending)
      return Promise.reject(error("NATIVE_QUEUE_FULL"));
    if (signal?.aborted)
      return Promise.reject(error("NATIVE_OPERATION_ABORTED"));
    let nativeHeaders: readonly Readonly<Record<string, string | Buffer>>[];
    try {
      nativeHeaders = encodeHeaders(headers);
    } catch (cause) {
      return Promise.reject(cause);
    }
    const opaque = Object.freeze({ correlation: Symbol("kafka-delivery") });
    let timer: ReturnType<typeof setTimeout>;
    let abort = (): void => undefined;
    const promise = new Promise<NativeProducerDelivery>((resolve, reject) => {
      const settled = { value: false };
      const finish = (reason: NativeKafkaError, remove: boolean): void => {
        if (settled.value) return;
        settled.value = true;
        if (remove) pending.delete(opaque);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(reason);
      };
      timer = setTimeout(
        () => finish(error("NATIVE_OPERATION_TIMEOUT"), false),
        options.sendTimeoutMs,
      );
      timer.unref?.();
      abort = (): void => finish(error("NATIVE_OPERATION_ABORTED"), false);
      signal?.addEventListener("abort", abort, { once: true });
      pending.set(opaque, { resolve, reject, timer, signal, abort, settled });
      try {
        client.produce(
          brokerTopic(options, topic),
          null,
          bytes,
          key,
          null,
          opaque,
          nativeHeaders,
        );
      } catch (cause) {
        const failure = producerFailureCode(cause);
        finish(
          error(
            failure === "NATIVE_DELIVERY_FAILED"
              ? "NATIVE_OPERATION_FAILED"
              : failure,
          ),
          true,
        );
      }
    });
    return promise;
  };

  const health = (signal?: AbortSignal): Promise<boolean> => {
    if (state !== "connected" || !nativeConnected(client))
      return Promise.resolve(false);
    return invoke<unknown>(
      (callback) =>
        client.getMetadata(
          { allTopics: false, timeout: options.receiveTimeoutMs },
          callback,
        ),
      options.receiveTimeoutMs,
      signal,
      "NATIVE_OPERATION_FAILED",
    )
      .then(() => {
        return true;
      })
      .catch(() => false);
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    state = "closing";
    stopPolling();
    for (const request of pending.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.signal?.removeEventListener("abort", request.abort);
      if (!request.settled.value) {
        request.settled.value = true;
        request.reject(error("NATIVE_CLIENT_CLOSED"));
      }
    }
    pending.clear();
    closePromise = invokeUntilCallback<unknown>(
      (callback) => client.disconnect(callback),
      "NATIVE_OPERATION_FAILED",
    )
      .then(() => undefined)
      .finally(() => {
        state = "closed";
      });
    return closePromise;
  };

  return Object.freeze({ connect, send, health, close });
}

export async function createNativeConsumer(
  options: NativeConsumerOptions,
  onRebalance: (event: NativeRebalanceEvent) => void,
  onStatistics?: (event: unknown) => void,
): Promise<NativeConsumerPort> {
  validateConsumerOptions(options);
  const module = await loadNative();
  let state: PortState = "new";
  let assigned: readonly NativePartition[] = Object.freeze([]);
  const nativeRebalance = (
    nativeError: unknown,
    rawAssignments: unknown,
  ): void => {
    if (state === "closing" || state === "closed") {
      try {
        client.unassign();
      } catch {
        // Disconnect still owns the final native cleanup path.
      }
      assigned = Object.freeze([]);
      return;
    }
    let current: readonly NativePartition[] = Object.freeze([]);
    try {
      current = Object.freeze(
        partitions(rawAssignments).map((entry) =>
          Object.freeze({
            ...entry,
            topic: runtimeTopic(options, entry.topic),
          }),
        ),
      );
      const code =
        nativeError === null || nativeError === undefined
          ? undefined
          : (nativeError as Record<string, unknown>)["code"];
      const event: NativeRebalanceEvent =
        code === REVOKE_PARTITIONS
          ? Object.freeze({ type: "revoked", partitions: current })
          : code === ASSIGN_PARTITIONS || code === undefined
            ? Object.freeze({ type: "assigned", partitions: current })
            : Object.freeze({
                type: "failed",
                partitions: current,
                error: error("NATIVE_REBALANCE_FAILED"),
              });
      assigned = current;
      try {
        onRebalance(event);
      } catch {
        state = "failed";
      }
    } catch {
      const event = Object.freeze({
        type: "failed",
        partitions: current,
        error: error("NATIVE_REBALANCE_FAILED"),
      });
      try {
        onRebalance(event);
      } catch {
        state = "failed";
      }
    }
  };
  let client: ConsumerClient;
  try {
    client = new module.KafkaConsumer(
      { ...consumerConfig(options), rebalance_cb: nativeRebalance },
      { "auto.offset.reset": options.autoOffsetReset },
    ) as ConsumerClient;
    // Polls also dispatch commit/rebalance callbacks while intake is paused.
    // A receive-budget-sized empty poll would hold the available worker slots
    // behind those callbacks. Keep it short, still below the outer deadline.
    client.setDefaultConsumeTimeout(
      consumerPollTimeout(options.receiveTimeoutMs),
    );
    // One batch has one receive budget, not one timeout per requested record.
    client.setDefaultIsTimeoutOnlyForFirstMessage(true);
  } catch {
    throw error("NATIVE_CONFIG_INVALID");
  }
  const commitClient = client as ConsumerWithCommitCallback;
  if (typeof commitClient.commitCb !== "function")
    throw error("NATIVE_LOAD_FAILED");
  let connectPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let pollInFlight = false;
  const pendingCommits = new Map<string, PendingCommit>();

  client.on("offset.commit", (...args: unknown[]) => {
    const nativeError = args[0];
    const rawOffsets = args[1];
    if (!Array.isArray(rawOffsets)) return;
    for (const rawOffset of rawOffsets) {
      if (rawOffset === null || typeof rawOffset !== "object") continue;
      const source = rawOffset as Record<string, unknown>;
      try {
        const location = partition(source);
        const offset = fromOffset(source["offset"]);
        const key = commitKey(location.topic, location.partition, offset);
        const request = pendingCommits.get(key);
        if (request === undefined) continue;
        pendingCommits.delete(key);
        if (request.timer !== undefined) clearTimeout(request.timer);
        request.signal?.removeEventListener("abort", request.abort);
        if (request.settled.value) continue;
        request.settled.value = true;
        if (nativeError !== undefined && nativeError !== null)
          request.reject(error(consumerCommitFailureCode(nativeError)));
        else request.resolve();
      } catch {
        // Ignore unrelated or logical offset events. A pending commit remains
        // bounded until its own callback, timeout, abort, or close.
      }
    }
  });

  client.on("disconnected", () => {
    if (state !== "closing" && state !== "closed") state = "failed";
  });
  if (onStatistics !== undefined)
    client.on("event.stats", (event: unknown) => {
      if (event === null || typeof event !== "object" || Array.isArray(event))
        return;
      const message = (event as Record<string, unknown>)["message"];
      if (typeof message !== "string") return;
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(message) as unknown;
      } catch {
        return;
      }
      if (
        snapshot === null ||
        typeof snapshot !== "object" ||
        Array.isArray(snapshot)
      )
        return;
      const source = snapshot as Record<string, unknown>;
      const sourceTopics = source["topics"];
      if (
        onStatistics !== undefined &&
        options.physicalTargets &&
        sourceTopics !== null &&
        typeof sourceTopics === "object" &&
        !Array.isArray(sourceTopics)
      ) {
        const topics: Record<string, unknown> = Object.create(null) as Record<
          string,
          unknown
        >;
        for (const [topic, value] of Object.entries(sourceTopics)) {
          try {
            topics[runtimeTopic(options, topic)] = value;
          } catch {
            /* ignore unrelated broker statistics */
          }
        }
        onStatistics({ ...source, topics });
      } else onStatistics?.(snapshot);
    });
  const connect = (): Promise<void> => {
    if (state === "connected") return Promise.resolve();
    if (state === "failed")
      return Promise.reject(error("NATIVE_CONNECT_FAILED"));
    if (state === "closing" || state === "closed")
      return Promise.reject(error("NATIVE_CLIENT_CLOSED"));
    if (connectPromise !== undefined) return connectPromise;
    state = "connecting";
    connectPromise = invoke<void>(
      (callback) => {
        client.connect(
          { allTopics: false, timeout: options.receiveTimeoutMs },
          callback as Callback<unknown>,
        );
      },
      options.receiveTimeoutMs,
      undefined,
      "NATIVE_CONNECT_FAILED",
    )
      .then(() => {
        if (state !== "connecting") throw error("NATIVE_CLIENT_CLOSED");
        state = "connected";
      })
      .catch((cause) => {
        state = "failed";
        throw cause;
      });
    return connectPromise;
  };

  const requireConnected = (): void => {
    if (state !== "connected" || !nativeConnected(client))
      throw error(
        state === "closing" || state === "closed"
          ? "NATIVE_CLIENT_CLOSED"
          : "NATIVE_NOT_CONNECTED",
      );
  };

  const subscribe = (topics: readonly string[]): Promise<void> => {
    try {
      requireConnected();
      if (
        topics.length === 0 ||
        topics.some((topic) => typeof topic !== "string" || topic.length === 0)
      )
        throw error("NATIVE_CONFIG_INVALID");
      client.subscribe(topics.map((topic) => brokerTopic(options, topic)));
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(
        cause instanceof NativeKafkaError
          ? cause
          : error("NATIVE_OPERATION_FAILED"),
      );
    }
  };

  const poll = (
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly NativeKafkaRecord[]> => {
    if (!positiveSafeInteger(limit) || limit > options.maxPending)
      return Promise.reject(error("NATIVE_QUEUE_FULL"));
    if (pollInFlight) return Promise.reject(error("NATIVE_QUEUE_FULL"));
    if (signal?.aborted)
      return Promise.reject(error("NATIVE_OPERATION_ABORTED"));
    try {
      requireConnected();
    } catch (cause) {
      return Promise.reject(cause);
    }
    pollInFlight = true;
    return invoke<readonly unknown[]>(
      (callback) => {
        try {
          client.consume(limit, (nativeError, messages) => {
            pollInFlight = false;
            const code =
              nativeError === null || nativeError === undefined
                ? undefined
                : (nativeError as Record<string, unknown>)["code"];
            callback(
              code === TIMED_OUT || code === TIMED_OUT_QUEUE
                ? undefined
                : nativeError,
              messages ?? [],
            );
          });
        } catch (cause) {
          pollInFlight = false;
          throw cause;
        }
      },
      options.receiveTimeoutMs,
      signal,
      "NATIVE_OPERATION_FAILED",
    ).then((messages) =>
      Object.freeze(
        messages.map((message) => {
          const received = record(message);
          return Object.freeze({
            ...received,
            topic: runtimeTopic(options, received.topic),
          });
        }),
      ),
    );
  };

  const commit = (
    topic: string,
    partitionNumber: number,
    nextOffset: string,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (
      typeof topic !== "string" ||
      topic.length === 0 ||
      !Number.isSafeInteger(partitionNumber) ||
      partitionNumber < 0
    )
      return Promise.reject(error("NATIVE_CONFIG_INVALID"));
    let offset: number;
    try {
      offset = parseOffset(nextOffset);
      requireConnected();
    } catch (cause) {
      return Promise.reject(cause);
    }
    const nativeTopic = brokerTopic(options, topic);
    const key = commitKey(nativeTopic, partitionNumber, nextOffset);
    if (pendingCommits.size >= options.maxPending || pendingCommits.has(key))
      return Promise.reject(error("NATIVE_QUEUE_FULL"));
    if (signal?.aborted)
      return Promise.reject(error("NATIVE_OPERATION_ABORTED"));
    let timer: ReturnType<typeof setTimeout>;
    let abort = (): void => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      const settled = { value: false };
      const finish = (reason: NativeKafkaError, remove: boolean): void => {
        if (settled.value) return;
        settled.value = true;
        if (remove) pendingCommits.delete(key);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(reason);
      };
      timer = setTimeout(
        () => finish(error("NATIVE_OPERATION_TIMEOUT"), false),
        options.commitTimeoutMs,
      );
      timer.unref?.();
      abort = (): void => finish(error("NATIVE_OPERATION_ABORTED"), false);
      signal?.addEventListener("abort", abort, { once: true });
      pendingCommits.set(key, {
        resolve,
        reject,
        timer,
        signal,
        abort,
        settled,
      });
      try {
        commitClient.commitCb(
          [{ topic: nativeTopic, partition: partitionNumber, offset }],
          (nativeError) => {
            const request = pendingCommits.get(key);
            if (request === undefined) return;
            if (nativeError === undefined || nativeError === null) return;
            pendingCommits.delete(key);
            if (request.timer !== undefined) clearTimeout(request.timer);
            request.signal?.removeEventListener("abort", request.abort);
            if (!request.settled.value) {
              request.settled.value = true;
              request.reject(error(consumerCommitFailureCode(nativeError)));
            }
          },
        );
      } catch (cause) {
        finish(
          cause instanceof NativeKafkaError
            ? cause
            : error(consumerCommitFailureCode(cause)),
          true,
        );
      }
    });
    return promise;
  };

  const control = (
    operation: (partitions: readonly NativePartition[]) => unknown,
    value: readonly NativePartition[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    try {
      requireConnected();
      if (signal?.aborted) throw error("NATIVE_OPERATION_ABORTED");
      const target = value === undefined ? assigned : samePartitions(value);
      operation(target);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(
        cause instanceof NativeKafkaError
          ? cause
          : error("NATIVE_OPERATION_FAILED"),
      );
    }
  };

  const brokerPartitions = (
    target: readonly NativePartition[],
  ): readonly NativePartition[] =>
    Object.freeze(
      target.map((entry) =>
        Object.freeze({ ...entry, topic: brokerTopic(options, entry.topic) }),
      ),
    );
  const pause = (
    value?: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void> =>
    control((target) => client.pause(brokerPartitions(target)), value, signal);
  const resume = (
    value?: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void> =>
    control((target) => client.resume(brokerPartitions(target)), value, signal);
  const assign = (
    value: readonly NativePartition[],
    signal?: AbortSignal,
  ): Promise<void> =>
    control(
      (target) => {
        client.assign(brokerPartitions(target));
        assigned = target;
      },
      value,
      signal,
    );
  const unassign = (signal?: AbortSignal): Promise<void> => {
    try {
      requireConnected();
      if (signal?.aborted) throw error("NATIVE_OPERATION_ABORTED");
      client.unassign();
      assigned = Object.freeze([]);
      return Promise.resolve();
    } catch (cause) {
      return Promise.reject(
        cause instanceof NativeKafkaError
          ? cause
          : error("NATIVE_OPERATION_FAILED"),
      );
    }
  };

  const health = (signal?: AbortSignal): Promise<boolean> => {
    if (state !== "connected" || !nativeConnected(client))
      return Promise.resolve(false);
    return invoke<unknown>(
      (callback) =>
        client.getMetadata(
          { allTopics: false, timeout: options.receiveTimeoutMs },
          callback,
        ),
      options.receiveTimeoutMs,
      signal,
      "NATIVE_OPERATION_FAILED",
    )
      .then(() => {
        if (options.autoOffsetReset === "latest") {
          // Assignment precedes asynchronous latest-offset resolution. A
          // cached high watermark follows a real Fetch response: readiness
          // before this boundary could silently skip the first live hint.
          return (
            assigned.length > 0 &&
            assigned.every((target) => {
              const offsets = client.getWatermarkOffsets(
                brokerTopic(options, target.topic),
                target.partition,
              );
              if (offsets === null || typeof offsets !== "object") return false;
              const high = (offsets as Record<string, unknown>)["highOffset"];
              return (
                typeof high === "number" &&
                Number.isSafeInteger(high) &&
                high >= 0
              );
            })
          );
        }
        return true;
      })
      .catch(() => false);
  };

  const setConsumeTimeout = (timeoutMs: number): void => {
    if (!positiveSafeInteger(timeoutMs) || timeoutMs > options.receiveTimeoutMs)
      throw error("NATIVE_CONFIG_INVALID");
    client.setDefaultConsumeTimeout(timeoutMs);
  };

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    state = "closing";
    for (const request of pendingCommits.values()) {
      if (request.timer !== undefined) clearTimeout(request.timer);
      request.signal?.removeEventListener("abort", request.abort);
      if (!request.settled.value) {
        request.settled.value = true;
        request.reject(error("NATIVE_CLIENT_CLOSED"));
      }
    }
    pendingCommits.clear();
    closePromise = invokeUntilCallback<unknown>(
      (callback) => client.disconnect(callback),
      "NATIVE_OPERATION_FAILED",
    )
      .then(() => undefined)
      .finally(() => {
        state = "closed";
        assigned = Object.freeze([]);
      });
    return closePromise;
  };

  return Object.freeze({
    connect,
    subscribe,
    poll,
    setConsumeTimeout,
    commit,
    pause,
    resume,
    assign,
    unassign,
    health,
    close,
  });
}
