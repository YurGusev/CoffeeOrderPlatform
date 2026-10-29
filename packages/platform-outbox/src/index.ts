import {
  canonicalJson,
  canonicalRequestHash,
  type JsonValue,
} from "@coffee-platform/idempotency";
import {
  withTransaction,
  quoteIdentifier,
  type Database,
  type QueryResult,
  type SqlScalar,
  type Transaction,
} from "@coffee-platform/database";
import { defineStatement } from "@coffee-platform/database/owner";
import { toInstant } from "@coffee-platform/platform-time";
import {
  context,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type MeterProvider,
  type ObservableGauge,
} from "@opentelemetry/api";

export type OutboxMessage = Readonly<{
  messageId: string;
  messageType: string;
  topic: string;
  aggregateRef: string;
  aggregateSequence: number | bigint;
  ownerVersion: string;
  partitionKey: string;
  schemaVersion: string;
  envelope: JsonValue;
  payload: JsonValue;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  traceparent: string;
}>;

export type OutboxState =
  "Pending" | "Publishing" | "Published" | "Quarantined";

export type OutboxClaim = Readonly<{
  message: OutboxMessage;
  payloadHash: string;
  state: "Publishing";
  attempt: number;
  leaseOwner: string;
  leaseToken: bigint;
  leaseUntilMs: number;
  nextAttemptAtMs: number;
  lastError?: string;
}>;

export type OutboxErrorCode =
  | "OUTBOX_INVALID"
  | "OUTBOX_CONFLICT"
  | "OUTBOX_NOT_ACQUIRED"
  | "OUTBOX_LEASE_INVALID"
  | "OUTBOX_SEQUENCE_INVALID"
  | "OUTBOX_RECORD_INVALID";

export class OutboxError extends Error {
  public readonly code: OutboxErrorCode;

  public constructor(code: OutboxErrorCode, message: string = code) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
  }
}

export type OutboxStore = Readonly<{
  enqueue(
    transaction: Transaction,
    message: OutboxMessage,
  ): Promise<"created" | "duplicate" | "conflict">;
  claim(
    transaction: Transaction,
    nowMs: number,
    leaseOwner: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly OutboxClaim[]>;
  finalize(
    transaction: Transaction,
    messageId: string,
    leaseOwner: string,
    leaseToken: bigint | number,
  ): Promise<void>;
  fail(
    transaction: Transaction,
    messageId: string,
    leaseOwner: string,
    leaseToken: bigint | number,
    nextAttemptAtMs: number,
    lastError: string,
    permanent: boolean,
  ): Promise<OutboxState>;
  oldestUnpublishedAgesMs?(
    transaction: Transaction,
    nowMs: number,
  ): Promise<readonly Readonly<{ topic: string; ageMs: number }>[] | null>;
}>;

const outboxAgeValues = new Map<
  string,
  Readonly<{ owner: string; topic: string; ageMs: number }>
>();
const outboxAgeGenerations = new Map<string, number>();
const outboxAgeScopesInFlight = new Set<string>();
const outboxAgeStoresInFlight = new WeakSet<object>();
let outboxMetricProvider: MeterProvider | undefined;
let outboxAgeGauge: ObservableGauge | undefined;

function initializeOutboxMetrics(): void {
  const provider = metrics.getMeterProvider();
  if (provider === outboxMetricProvider) return;
  outboxAgeValues.clear();
  outboxAgeGenerations.clear();
  outboxMetricProvider = provider;
  outboxAgeGauge = provider
    .getMeter("coffee-platform.outbox")
    .createObservableGauge("messaging.outbox.oldest_unpublished.age", {
      unit: "ms",
    });
  outboxAgeGauge.addCallback((observer) => {
    for (const value of outboxAgeValues.values())
      observer.observe(value.ageMs, {
        "db.owner": value.owner,
        "messaging.destination.name": value.topic,
      });
  });
}

function outboxMetricScope(owner: string, topics: readonly string[]): string {
  return `${owner}\u0000${JSON.stringify(topics)}`;
}

type OutboxRow = Readonly<{
  envelope_bytes?: unknown;
  envelope_hash?: unknown;
  message_id: unknown;
  message_type: unknown;
  topic: unknown;
  aggregate_ref: unknown;
  aggregate_sequence: unknown;
  owner_version: unknown;
  partition_key: unknown;
  schema_version: unknown;
  envelope: unknown;
  payload: unknown;
  payload_hash: unknown;
  occurred_at: unknown;
  correlation_id: unknown;
  causation_id: unknown;
  traceparent: unknown;
  state: unknown;
  lease_owner: unknown;
  lease_token: unknown;
  lease_until_ms: unknown;
  attempt: unknown;
  next_attempt_at_ms: unknown;
  last_error: unknown;
}>;

type ExistingMessageRow = Readonly<{
  envelope_bytes?: unknown;
  envelope_hash?: unknown;
  payload_hash: unknown;
  message_type: unknown;
  topic: unknown;
  aggregate_ref: unknown;
  aggregate_sequence: unknown;
  owner_version: unknown;
  partition_key: unknown;
  schema_version: unknown;
  envelope: unknown;
}>;

function invalid(message: string = "некорректные параметры Outbox"): never {
  throw new OutboxError("OUTBOX_INVALID", message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`Outbox ${field} должен быть непустой строкой`);
  return value;
}

function boundedString(value: unknown, field: string, max: number): string {
  const result = requiredString(value, field);
  if (result.length > max) invalid(`Outbox ${field} слишком длинный`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid(`Outbox ${field} должен быть положительным целым числом`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`Outbox ${field} должен быть неотрицательным целым числом`);
  return value;
}

function sequenceValue(value: number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    invalid("Outbox aggregateSequence должен быть safe integer");
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result <= 0n)
    invalid("Outbox aggregateSequence должен быть положительным");
  return result;
}

function numberValue(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      `некорректное поле Outbox ${field}`,
    );
  return result;
}

function bigintValue(value: unknown, field: string): bigint {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      `некорректное поле Outbox ${field}`,
    );
  }
}

function stringValue(
  value: unknown,
  field: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0))
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      `некорректное поле Outbox ${field}`,
    );
  return value;
}

function instantValue(value: unknown, field: string): string {
  const text = requiredString(value, field);
  try {
    return toInstant(text).toString();
  } catch {
    invalid(`Outbox ${field} должен быть RFC3339 timestamp`);
  }
}

function rowInstantValue(value: unknown, field: string): string {
  const text = stringValue(value, field);
  try {
    return toInstant(text.replace(" ", "T")).toString();
  } catch {
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      `некорректное поле Outbox ${field}`,
    );
  }
}

function validateMessage(message: OutboxMessage): string {
  for (const [value, field] of [
    [message.messageId, "messageId"],
    [message.messageType, "messageType"],
    [message.topic, "topic"],
    [message.aggregateRef, "aggregateRef"],
    [message.ownerVersion, "ownerVersion"],
    [message.partitionKey, "partitionKey"],
    [message.schemaVersion, "schemaVersion"],
    [message.occurredAt, "occurredAt"],
    [message.correlationId, "correlationId"],
  ] as const)
    requiredString(value, field);
  const occurredAt = instantValue(message.occurredAt, "occurredAt");
  sequenceValue(message.aggregateSequence);
  if (message.causationId !== undefined)
    requiredString(message.causationId, "causationId");
  const traceparent = requiredString(message.traceparent, "traceparent");
  try {
    const envelope = message.envelope;
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      Array.isArray(envelope)
    )
      invalid("Outbox envelope должен быть plain object");
    const envelopeObject = envelope as {
      readonly [key: string]: JsonValue | undefined;
    };
    const envelopeKeys = [
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
    if (
      Object.keys(envelopeObject).length !== envelopeKeys.length ||
      Object.keys(envelopeObject).some((key) => !envelopeKeys.includes(key))
    )
      invalid("Outbox envelope имеет неверный набор полей");
    if (
      envelopeObject["envelopeVersion"] !== "1" ||
      message.schemaVersion !== "1"
    )
      invalid("Outbox envelopeVersion должен быть '1'");
    if (envelopeObject["messageId"] !== message.messageId)
      invalid("Outbox envelope messageId должен совпадать с messageId");
    if (envelopeObject["messageType"] !== message.messageType)
      invalid("Outbox envelope messageType должен совпадать с messageType");
    if (
      instantValue(envelopeObject["occurredAt"], "envelope.occurredAt") !==
      occurredAt
    )
      invalid("Outbox envelope occurredAt должен совпадать с occurredAt");
    requiredString(envelopeObject["producer"], "envelope.producer");
    if (envelopeObject["correlationId"] !== message.correlationId)
      invalid("Outbox envelope correlationId должен совпадать с correlationId");
    const envelopeCausationId = envelopeObject["causationId"];
    if (
      envelopeCausationId !== (message.causationId ?? null) ||
      (envelopeCausationId !== null && typeof envelopeCausationId !== "string")
    )
      invalid("Outbox envelope causationId должен совпадать с causationId");
    if (envelopeCausationId !== null)
      requiredString(envelopeCausationId, "envelope.causationId");
    if (envelopeObject["traceparent"] !== traceparent)
      invalid("Outbox envelope traceparent должен совпадать с traceparent");
    const aggregate = envelopeObject["aggregate"];
    if (
      aggregate === null ||
      typeof aggregate !== "object" ||
      Array.isArray(aggregate)
    )
      invalid("Outbox envelope aggregate должен быть plain object");
    const aggregateObject = aggregate as {
      readonly [key: string]: JsonValue | undefined;
    };
    const aggregateKeys = ["type", "ref", "version"];
    if (
      Object.keys(aggregateObject).length !== aggregateKeys.length ||
      Object.keys(aggregateObject).some((key) => !aggregateKeys.includes(key))
    )
      invalid("Outbox envelope aggregate имеет неверный набор полей");
    requiredString(aggregateObject["type"], "envelope.aggregate.type");
    requiredString(aggregateObject["ref"], "envelope.aggregate.ref");
    requiredString(aggregateObject["version"], "envelope.aggregate.version");
    if (aggregateObject["ref"] !== message.aggregateRef)
      invalid("Outbox envelope aggregate.ref должен совпадать с aggregateRef");
    if (aggregateObject["version"] !== message.ownerVersion)
      invalid(
        "Outbox envelope aggregate.version должен совпадать с ownerVersion",
      );
    const envelopePayload = envelopeObject["payload"];
    if (
      envelopePayload === undefined ||
      canonicalJson(envelopePayload) !== canonicalJson(message.payload)
    )
      invalid("Outbox envelope payload должен совпадать с payload");
    canonicalJson(envelope);
    return canonicalRequestHash(message.envelope);
  } catch {
    invalid("Outbox envelope или payload не является canonical JSON");
  }
}

function sameEnvelopeBytes(
  row: Readonly<{ envelope_bytes?: unknown; envelope_hash?: unknown }>,
  envelope: JsonValue,
  hash: string,
): boolean {
  return (
    row.envelope_hash === hash &&
    row.envelope_bytes instanceof Uint8Array &&
    Buffer.from(row.envelope_bytes).equals(Buffer.from(canonicalJson(envelope)))
  );
}

function rowMessage(row: OutboxRow, envelopeBytes = false): OutboxClaim {
  const state = stringValue(row.state, "state");
  if (state !== "Publishing")
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      "claim вернул не Publishing row",
    );
  const payloadHash = stringValue(row.payload_hash, "payload_hash");
  if (!/^[0-9a-f]{64}$/.test(payloadHash))
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      "некорректный payload_hash Outbox",
    );
  const message: OutboxMessage = {
    messageId: stringValue(row.message_id, "message_id"),
    messageType: stringValue(row.message_type, "message_type"),
    topic: stringValue(row.topic, "topic"),
    aggregateRef: stringValue(row.aggregate_ref, "aggregate_ref"),
    aggregateSequence: bigintValue(
      row.aggregate_sequence,
      "aggregate_sequence",
    ),
    ownerVersion: stringValue(row.owner_version, "owner_version"),
    partitionKey: stringValue(row.partition_key, "partition_key"),
    schemaVersion: stringValue(row.schema_version, "schema_version"),
    envelope: row.envelope as JsonValue,
    payload: row.payload as JsonValue,
    occurredAt: rowInstantValue(row.occurred_at, "occurred_at"),
    correlationId: stringValue(row.correlation_id, "correlation_id"),
    ...(row.causation_id === null || row.causation_id === undefined
      ? {}
      : { causationId: stringValue(row.causation_id, "causation_id") }),
    traceparent: stringValue(row.traceparent, "traceparent"),
  };
  let computedHash: string;
  try {
    computedHash = validateMessage(message);
  } catch {
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      "claim вернул некорректное сообщение",
    );
  }
  if (computedHash !== payloadHash)
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      "claim payload_hash не совпадает с envelope",
    );
  if (envelopeBytes && !sameEnvelopeBytes(row, message.envelope, computedHash))
    throw new OutboxError(
      "OUTBOX_RECORD_INVALID",
      "claim immutable bytes/hash не совпадают с envelope",
    );
  return {
    message,
    payloadHash,
    state: "Publishing",
    attempt: positiveInteger(numberValue(row.attempt, "attempt"), "attempt"),
    leaseOwner: stringValue(row.lease_owner, "lease_owner"),
    leaseToken: bigintValue(row.lease_token, "lease_token"),
    leaseUntilMs: numberValue(row.lease_until_ms, "lease_until_ms"),
    nextAttemptAtMs: numberValue(row.next_attempt_at_ms, "next_attempt_at_ms"),
    ...(row.last_error === null || row.last_error === undefined
      ? {}
      : { lastError: stringValue(row.last_error, "last_error") }),
  };
}

const claimProjection = `current.message_id, current.message_type, current.topic, current.aggregate_ref, current.aggregate_sequence,
  current.owner_version, current.partition_key, current.schema_version, current.envelope, current.payload, current.payload_hash,
  current.envelope ->> 'occurredAt' AS occurred_at, current.correlation_id, current.causation_id, current.traceparent,
  current.state, current.lease_owner, current.lease_token,
  (extract(epoch from current.lease_until) * 1000)::bigint AS lease_until_ms,
  current.attempt, (extract(epoch from current.next_attempt_at) * 1000)::bigint AS next_attempt_at_ms, current.last_error`;

// Opt-in для owner schemas с обязательными immutable envelope_bytes/envelope_hash.
// Generic JSON layout остаётся совместимым с существующими callers.
export type SqlOutboxStoreOptions = Readonly<{
  schema?: string;
  table?: string;
  envelopeBytes?: boolean;
  topics?: readonly string[];
}>;

export class SqlOutboxStore implements OutboxStore {
  private readonly envelopeBytes: boolean;
  private readonly claimTopics: string | undefined;
  public readonly metricOwner: string;
  public readonly metricTopics: readonly string[] | undefined;
  private readonly insert: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<Readonly<{ message_id: string }>>>;
  private readonly readById: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<ExistingMessageRow>>;
  private readonly readSequence: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<Readonly<{ aggregate_sequence: unknown }>>>;
  private readonly claimStatement: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<OutboxRow>>;
  private readonly finalizeStatement: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<Readonly<{ message_id: string }>>>;
  private readonly failStatement: (
    transaction: Transaction,
    parameters: readonly SqlScalar[],
  ) => Promise<QueryResult<Readonly<{ state: string }>>>;
  private readonly oldestUnpublishedAgesStatement:
    | ((
        transaction: Transaction,
        parameters: readonly SqlScalar[],
      ) => Promise<QueryResult<Readonly<{ topic: string; age_ms: unknown }>>>)
    | undefined;

  public constructor(database: Database, options: SqlOutboxStoreOptions = {}) {
    const qualified = `${quoteIdentifier(options.schema ?? "public")}.${quoteIdentifier(options.table ?? "outbox_messages")}`;
    this.envelopeBytes = options.envelopeBytes === true;
    this.metricOwner = options.schema ?? "public";
    this.metricTopics =
      options.topics === undefined
        ? undefined
        : Object.freeze([...options.topics]);
    if (options.topics !== undefined) {
      if (
        !Array.isArray(options.topics) ||
        options.topics.length === 0 ||
        new Set(options.topics).size !== options.topics.length
      )
        invalid("Outbox topics некорректны");
      for (const topic of options.topics) boundedString(topic, "topic", 255);
    }
    this.claimTopics =
      options.topics === undefined ? undefined : JSON.stringify(options.topics);
    this.oldestUnpublishedAgesStatement =
      this.claimTopics === undefined
        ? undefined
        : defineStatement(
            database,
            `SELECT configured.topic,
        COALESCE((extract(epoch FROM (to_timestamp($1 / 1000.0) - min(outbox.occurred_at))) * 1000)::bigint, 0) AS age_ms
      FROM jsonb_array_elements_text($2::jsonb) AS configured(topic)
      LEFT JOIN ${qualified} AS outbox ON outbox.topic = configured.topic AND outbox.state IN ('Pending', 'Publishing')
      GROUP BY configured.topic`,
          );
    const byteColumns = this.envelopeBytes
      ? ", envelope_bytes, envelope_hash"
      : "";
    const byteValues = this.envelopeBytes ? ", $16::bytea, $17::char(64)" : "";
    this.insert = defineStatement(
      database,
      `INSERT INTO ${qualified}
      (message_id, message_type, topic, aggregate_ref, aggregate_sequence, owner_version,
       partition_key, schema_version, envelope, payload, payload_hash, occurred_at,
       correlation_id, causation_id, traceparent, state, lease_owner, lease_token,
       lease_until, attempt, next_attempt_at${byteColumns})
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::timestamptz,
       $13, $14, $15, 'Pending', '', 0, clock_timestamp(), 0, clock_timestamp()${byteValues})
      ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
    );
    this.readById = defineStatement(
      database,
      `SELECT payload_hash, message_type, topic, aggregate_ref, aggregate_sequence, owner_version, partition_key, schema_version, envelope${byteColumns}
      FROM ${qualified} WHERE message_id = $1 FOR UPDATE`,
    );
    this.readSequence = defineStatement(
      database,
      `SELECT aggregate_sequence FROM ${qualified}
      WHERE aggregate_ref = $1 ORDER BY aggregate_sequence DESC LIMIT 1 FOR UPDATE`,
    );
    this.claimStatement = defineStatement(
      database,
      `WITH candidates AS (
      SELECT current.message_id FROM ${qualified} AS current
      WHERE current.next_attempt_at <= to_timestamp($1 / 1000.0)
        ${this.claimTopics === undefined ? "" : "AND current.topic IN (SELECT jsonb_array_elements_text($5::jsonb))"}
        AND (current.state = 'Pending' OR (current.state = 'Publishing' AND current.lease_until <= clock_timestamp()))
        AND NOT EXISTS (
          SELECT 1 FROM ${qualified} AS predecessor
          WHERE predecessor.aggregate_ref = current.aggregate_ref
            AND predecessor.aggregate_sequence < current.aggregate_sequence
            AND predecessor.state <> 'Published'
        )
      ORDER BY current.next_attempt_at, current.aggregate_ref, current.aggregate_sequence, current.message_id
      FOR UPDATE SKIP LOCKED LIMIT $4
    )
    UPDATE ${qualified} AS current
      SET state = 'Publishing', lease_owner = $3, lease_token = current.attempt + 1,
          lease_until = to_timestamp($2 / 1000.0), attempt = current.attempt + 1
    FROM candidates
    WHERE current.message_id = candidates.message_id
    RETURNING ${claimProjection}${this.envelopeBytes ? ", current.envelope_bytes, current.envelope_hash" : ""}`,
    );
    this.finalizeStatement = defineStatement(
      database,
      `UPDATE ${qualified}
      SET state = 'Published', lease_owner = '', lease_until = clock_timestamp(), published_at = clock_timestamp()
      WHERE message_id = $1 AND state = 'Publishing' AND lease_owner = $2
        AND lease_token = $3 AND lease_until > clock_timestamp() RETURNING message_id`,
    );
    this.failStatement = defineStatement(
      database,
      `UPDATE ${qualified}
      SET state = CASE WHEN $6 THEN 'Quarantined' ELSE 'Pending' END,
          lease_owner = '', lease_until = clock_timestamp(), next_attempt_at = to_timestamp($5 / 1000.0),
          last_error = $4,
          quarantined_at = CASE WHEN $6 THEN clock_timestamp() ELSE quarantined_at END
      WHERE message_id = $1 AND state = 'Publishing' AND lease_owner = $2
        AND lease_token = $3 AND lease_until > clock_timestamp() RETURNING state`,
    );
  }

  public async enqueue(
    transaction: Transaction,
    message: OutboxMessage,
  ): Promise<"created" | "duplicate" | "conflict"> {
    const payloadHash = validateMessage(message);
    const sequence = sequenceValue(message.aggregateSequence);
    const existing = await this.readById(transaction, [message.messageId]);
    const existingRow = existing.rows[0];
    if (existingRow !== undefined)
      return sameMessage(existingRow, message, payloadHash) &&
        (!this.envelopeBytes ||
          sameEnvelopeBytes(existingRow, message.envelope, payloadHash))
        ? "duplicate"
        : "conflict";
    const sequenceRows = await this.readSequence(transaction, [
      message.aggregateRef,
    ]);
    const latest = sequenceRows.rows[0];
    const expected =
      latest === undefined
        ? 1n
        : bigintValue(latest.aggregate_sequence, "aggregate_sequence") + 1n;
    if (sequence !== expected)
      throw new OutboxError(
        "OUTBOX_SEQUENCE_INVALID",
        "aggregateSequence должен быть непрерывным",
      );
    const envelope = canonicalJson(message.envelope);
    const inserted = await this.insert(transaction, [
      message.messageId,
      message.messageType,
      message.topic,
      message.aggregateRef,
      sequence,
      message.ownerVersion,
      message.partitionKey,
      message.schemaVersion,
      envelope,
      canonicalJson(message.payload),
      payloadHash,
      message.occurredAt,
      message.correlationId,
      message.causationId ?? null,
      message.traceparent ?? null,
      ...(this.envelopeBytes ? [Buffer.from(envelope), payloadHash] : []),
    ]);
    if (inserted.rowCount === 1) return "created";
    const raced = await this.readById(transaction, [message.messageId]);
    const racedRow = raced.rows[0];
    return racedRow !== undefined &&
      sameMessage(racedRow, message, payloadHash) &&
      (!this.envelopeBytes ||
        sameEnvelopeBytes(racedRow, message.envelope, payloadHash))
      ? "duplicate"
      : "conflict";
  }

  public async claim(
    transaction: Transaction,
    nowMs: number,
    leaseOwner: string,
    limit: number,
    leaseMs: number,
  ): Promise<readonly OutboxClaim[]> {
    nonNegativeInteger(nowMs, "nowMs");
    requiredString(leaseOwner, "leaseOwner");
    positiveInteger(limit, "limit");
    positiveInteger(leaseMs, "leaseMs");
    if (nowMs + leaseMs > Number.MAX_SAFE_INTEGER)
      invalid("Outbox lease выходит за пределы safe integer");
    const result = await this.claimStatement(transaction, [
      nowMs,
      nowMs + leaseMs,
      leaseOwner,
      limit,
      ...(this.claimTopics === undefined ? [] : [this.claimTopics]),
    ]);
    return result.rows.map((row) => rowMessage(row, this.envelopeBytes));
  }

  public async finalize(
    transaction: Transaction,
    messageId: string,
    leaseOwner: string,
    leaseToken: bigint | number,
  ): Promise<void> {
    const result = await this.finalizeStatement(transaction, [
      requiredString(messageId, "messageId"),
      requiredString(leaseOwner, "leaseOwner"),
      sequenceValue(leaseToken),
    ]);
    if (result.rowCount !== 1)
      throw new OutboxError(
        "OUTBOX_LEASE_INVALID",
        "Outbox lease недействителен, истёк или fence token устарел",
      );
  }

  public async fail(
    transaction: Transaction,
    messageId: string,
    leaseOwner: string,
    leaseToken: bigint | number,
    nextAttemptAtMs: number,
    lastError: string,
    permanent: boolean,
  ): Promise<OutboxState> {
    nonNegativeInteger(nextAttemptAtMs, "nextAttemptAtMs");
    boundedString(lastError, "lastError", 512);
    if (typeof permanent !== "boolean")
      invalid("Outbox permanent должен быть boolean");
    const result = await this.failStatement(transaction, [
      requiredString(messageId, "messageId"),
      requiredString(leaseOwner, "leaseOwner"),
      sequenceValue(leaseToken),
      lastError,
      nextAttemptAtMs,
      permanent,
    ]);
    const state = result.rows[0]?.state;
    if (
      result.rowCount !== 1 ||
      (state !== "Pending" && state !== "Quarantined")
    )
      throw new OutboxError(
        "OUTBOX_LEASE_INVALID",
        "Outbox lease недействителен, истёк или fence token устарел",
      );
    return state;
  }

  public async oldestUnpublishedAgesMs(
    transaction: Transaction,
    nowMs: number,
  ): Promise<readonly Readonly<{ topic: string; ageMs: number }>[] | null> {
    nonNegativeInteger(nowMs, "nowMs");
    // An unscoped store cannot prove which topic series are known and stays unknown.
    if (
      this.oldestUnpublishedAgesStatement === undefined ||
      this.claimTopics === undefined
    )
      return null;
    const result = await this.oldestUnpublishedAgesStatement(transaction, [
      nowMs,
      this.claimTopics,
    ]);
    return result.rows.map((row) => {
      const ageMs = Number(row.age_ms);
      if (!Number.isSafeInteger(ageMs) || ageMs < 0)
        throw new OutboxError(
          "OUTBOX_RECORD_INVALID",
          "некорректное поле Outbox age_ms",
        );
      return { topic: row.topic, ageMs };
    });
  }
}

function sameMessage(
  row: ExistingMessageRow,
  message: OutboxMessage,
  payloadHash: string,
): boolean {
  let envelopeHash: string;
  try {
    envelopeHash = canonicalRequestHash(row.envelope as JsonValue);
  } catch {
    return false;
  }
  return (
    row.payload_hash === payloadHash &&
    envelopeHash === payloadHash &&
    row.message_type === message.messageType &&
    row.topic === message.topic &&
    row.aggregate_ref === message.aggregateRef &&
    String(row.aggregate_sequence) ===
      String(sequenceValue(message.aggregateSequence)) &&
    row.owner_version === message.ownerVersion &&
    row.partition_key === message.partitionKey &&
    row.schema_version === message.schemaVersion
  );
}

export function createSqlOutboxStore(
  database: Database,
  options: SqlOutboxStoreOptions = {},
): SqlOutboxStore {
  return new SqlOutboxStore(database, options);
}

export type OutboxSendResult =
  | Readonly<{ kind: "ack" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "failed"; permanent?: boolean; error?: string }>;

export type OutboxSender = (
  claim: OutboxClaim,
  signal: AbortSignal,
) => Promise<OutboxSendResult>;
export type OutboxRelayOptions = Readonly<{
  nowMs: number;
  leaseOwner: string;
  policy: Readonly<{
    leaseMs: number;
    sendTimeoutMs: number;
    maxInFlight: number;
    retry: Readonly<{ baseMs: number; maxMs: number; maxAttempts: number }>;
  }>;
  signal?: AbortSignal;
}>;
export type OutboxRelayResult = Readonly<{
  claimed: number;
  published: number;
  failed: number;
  unknown: number;
  quarantined: number;
}>;

export async function relayOutboxBatch(
  store: OutboxStore,
  database: Database,
  send: OutboxSender,
  options: OutboxRelayOptions,
): Promise<OutboxRelayResult> {
  nonNegativeInteger(options.nowMs, "nowMs");
  requiredString(options.leaseOwner, "leaseOwner");
  positiveInteger(options.policy.leaseMs, "policy.leaseMs");
  positiveInteger(options.policy.sendTimeoutMs, "policy.sendTimeoutMs");
  positiveInteger(options.policy.maxInFlight, "policy.maxInFlight");
  positiveInteger(options.policy.retry.baseMs, "policy.retry.baseMs");
  positiveInteger(options.policy.retry.maxMs, "policy.retry.maxMs");
  positiveInteger(options.policy.retry.maxAttempts, "policy.retry.maxAttempts");
  if (options.policy.retry.baseMs > options.policy.retry.maxMs)
    invalid("policy.retry baseMs должен быть не больше maxMs");
  const span = trace
    .getTracer("coffee-platform.outbox")
    .startSpan("Outbox.poll", { kind: SpanKind.INTERNAL });
  try {
    const txOptions = {
      mode: "background" as const,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    initializeOutboxMetrics();
    const collectOldestAge = (): void => {
      if (store.oldestUnpublishedAgesMs === undefined) {
        span.setAttribute(
          "messaging.outbox.oldest_unpublished_age.result",
          "unknown",
        );
        return;
      }
      const owner =
        store instanceof SqlOutboxStore ? store.metricOwner : "unknown";
      const topics =
        store instanceof SqlOutboxStore ? store.metricTopics : undefined;
      if (store instanceof SqlOutboxStore && topics === undefined) {
        span.setAttribute(
          "messaging.outbox.oldest_unpublished_age.result",
          "unknown",
        );
        return;
      }
      const scope =
        topics === undefined ? undefined : outboxMetricScope(owner, topics);
      if (
        scope === undefined
          ? outboxAgeStoresInFlight.has(store)
          : outboxAgeScopesInFlight.has(scope)
      ) {
        span.setAttribute(
          "messaging.outbox.oldest_unpublished_age.result",
          "in_flight",
        );
        return;
      }
      if (scope === undefined) outboxAgeStoresInFlight.add(store);
      else outboxAgeScopesInFlight.add(scope);
      const generation =
        scope === undefined
          ? undefined
          : (outboxAgeGenerations.get(scope) ?? 0) + 1;
      if (scope !== undefined && generation !== undefined) {
        outboxAgeGenerations.set(scope, generation);
        for (const topic of topics ?? [])
          outboxAgeValues.delete(`${owner}\u0000${topic}`);
      }
      const ageSpan = trace
        .getTracer("coffee-platform.outbox")
        .startSpan("Outbox.oldest_unpublished_age", {
          kind: SpanKind.INTERNAL,
        });
      span.setAttribute(
        "messaging.outbox.oldest_unpublished_age.result",
        "scheduled",
      );
      void withTransaction(database, txOptions, (transaction) =>
        store.oldestUnpublishedAgesMs!(transaction, options.nowMs),
      )
        .then((ages) => {
          if (
            ages !== null &&
            scope !== undefined &&
            generation !== undefined &&
            outboxAgeGenerations.get(scope) === generation
          ) {
            for (const { topic, ageMs } of ages)
              outboxAgeValues.set(`${owner}\u0000${topic}`, {
                owner,
                topic,
                ageMs,
              });
            ageSpan.setAttribute(
              "messaging.outbox.oldest_unpublished_age.result",
              "recorded",
            );
          } else
            ageSpan.setAttribute(
              "messaging.outbox.oldest_unpublished_age.result",
              "unknown",
            );
        })
        .catch(() => {
          // A diagnostic query must not change the relay outcome.
          if (
            scope !== undefined &&
            generation !== undefined &&
            outboxAgeGenerations.get(scope) === generation
          ) {
            for (const topic of topics ?? [])
              outboxAgeValues.delete(`${owner}\u0000${topic}`);
          }
          ageSpan.setAttribute(
            "messaging.outbox.oldest_unpublished_age.result",
            "unknown",
          );
        })
        .finally(() => {
          if (scope === undefined) outboxAgeStoresInFlight.delete(store);
          else outboxAgeScopesInFlight.delete(scope);
          ageSpan.end();
        })
        .catch(() => {});
    };
    let claims: readonly OutboxClaim[];
    try {
      claims = await withTransaction(database, txOptions, (transaction) =>
        store.claim(
          transaction,
          options.nowMs,
          options.leaseOwner,
          options.policy.maxInFlight,
          options.policy.leaseMs,
        ),
      );
    } catch (error) {
      collectOldestAge();
      throw error;
    }
    const processClaim = async (
      claim: OutboxClaim,
    ): Promise<OutboxRelayResult> => {
      const carrier = claim.message.traceparent;
      let parent = context.active();
      if (
        /^(?!ff)[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(
          carrier,
        ) &&
        carrier.slice(3, 35) !== "0".repeat(32) &&
        carrier.slice(36, 52) !== "0".repeat(16)
      ) {
        parent = trace.setSpanContext(parent, {
          traceId: carrier.slice(3, 35),
          spanId: carrier.slice(36, 52),
          traceFlags: Number.parseInt(carrier.slice(53), 16),
          isRemote: true,
        });
      }
      const delivery = trace
        .getTracer("coffee-platform.outbox")
        .startSpan(
          "Outbox.relay",
          {
            kind: SpanKind.PRODUCER,
            attributes: { "messaging.destination.name": claim.message.topic },
          },
          parent,
        );
      try {
        return await context.with(trace.setSpan(parent, delivery), async () => {
          if (options.signal?.aborted)
            return {
              claimed: 0,
              published: 0,
              failed: 0,
              unknown: 0,
              quarantined: 0,
            };
          const timeout = new AbortController();
          const signal =
            options.signal === undefined
              ? timeout.signal
              : AbortSignal.any([options.signal, timeout.signal]);
          const sendPromise = Promise.resolve()
            .then(() => send(claim, signal))
            .catch((): OutboxSendResult => ({ kind: "unknown" }));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<OutboxSendResult>((resolve) => {
            timer = setTimeout(() => {
              timeout.abort();
              resolve({ kind: "unknown" });
            }, options.policy.sendTimeoutMs);
          });
          const outcome = await Promise.race([sendPromise, timeoutPromise]);
          if (timer !== undefined) clearTimeout(timer);
          delivery.setAttribute("messaging.outbox.result", outcome.kind);
          if (outcome.kind !== "ack")
            delivery.setStatus({ code: SpanStatusCode.ERROR });
          if (outcome.kind === "ack") {
            await withTransaction(database, txOptions, (transaction) =>
              store.finalize(
                transaction,
                claim.message.messageId,
                claim.leaseOwner,
                claim.leaseToken,
              ),
            );
            return {
              claimed: 0,
              published: 1,
              failed: 0,
              unknown: 0,
              quarantined: 0,
            };
          }
          if (outcome.kind === "unknown")
            return {
              claimed: 0,
              published: 0,
              failed: 0,
              unknown: 1,
              quarantined: 0,
            };
          const exponent = Math.min(30, Math.max(0, claim.attempt - 1));
          const delay = Math.min(
            options.policy.retry.maxMs,
            options.policy.retry.baseMs * 2 ** exponent,
          );
          const permanent =
            outcome.permanent === true ||
            claim.attempt >= options.policy.retry.maxAttempts;
          const error =
            outcome.error === undefined
              ? "outbox send failed"
              : outcome.error.slice(0, 512);
          const state = await withTransaction(
            database,
            txOptions,
            (transaction) =>
              store.fail(
                transaction,
                claim.message.messageId,
                claim.leaseOwner,
                claim.leaseToken,
                options.nowMs + delay,
                error,
                permanent,
              ),
          );
          return {
            claimed: 0,
            published: 0,
            failed: 1,
            unknown: 0,
            quarantined: state === "Quarantined" ? 1 : 0,
          };
        });
      } catch (error) {
        delivery.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        delivery.end();
      }
    };
    const settled = await Promise.allSettled(claims.map(processClaim));
    const result = settled.reduce(
      (total, result) => {
        if (result.status === "fulfilled")
          return {
            claimed: total.claimed,
            published: total.published + result.value.published,
            failed: total.failed + result.value.failed,
            unknown: total.unknown + result.value.unknown,
            quarantined: total.quarantined + result.value.quarantined,
          };
        return { ...total, unknown: total.unknown + 1 };
      },
      {
        claimed: claims.length,
        published: 0,
        failed: 0,
        unknown: 0,
        quarantined: 0,
      },
    );
    collectOldestAge();
    span.setAttributes({
      "messaging.outbox.claimed": result.claimed,
      "messaging.outbox.published": result.published,
      "messaging.outbox.failed": result.failed,
      "messaging.outbox.unknown": result.unknown,
      "messaging.outbox.quarantined": result.quarantined,
    });
    span.setAttribute(
      "messaging.outbox.result",
      result.unknown > 0
        ? "unknown"
        : result.failed > 0
          ? "failed"
          : "completed",
    );
    if (result.unknown > 0 || result.failed > 0)
      span.setStatus({ code: SpanStatusCode.ERROR });
    return result;
  } catch (error) {
    span.setAttribute("messaging.outbox.result", "failed");
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
