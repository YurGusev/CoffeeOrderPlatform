import {canonicalJson, canonicalRequestHash, type JsonValue} from "@coffee-platform/idempotency";
import {quoteIdentifier, type Database, type QueryResult, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {context, metrics, SpanKind, SpanStatusCode, trace, type Histogram, type MeterProvider} from "@opentelemetry/api";
import {toInstant} from "@coffee-platform/platform-time";

let inboxMetricProvider: MeterProvider | undefined;
let inboxReceivedAge: Histogram | undefined;

function initializeInboxMetrics(): void {
  const provider = metrics.getMeterProvider();
  if (provider === inboxMetricProvider) return;
  inboxMetricProvider = provider;
  inboxReceivedAge = provider.getMeter("coffee-platform.inbox").createHistogram("messaging.inbox.received.age", {unit: "ms"});
}

export type InboxMessage = Readonly<{
  messageId: string;
  messageType: string;
  receivedAt: string;
  payloadHash: string;
  payload: JsonValue;
}>;

export type InboxState = "Processing" | "Processed" | "Quarantined";

export type InboxRecord = Readonly<{
  message: InboxMessage;
  payloadHash: string;
  state: InboxState;
  leaseOwner: string;
  leaseUntilMs: number;
  attempt: number;
  processedAt?: string;
  quarantineReason?: string;
}>;

export type InboxBeginResult =
  | Readonly<{kind: "acquired"; record: InboxRecord}>
  | Readonly<{kind: "duplicate"; state: "Processed" | "Quarantined"}>
  | Readonly<{kind: "conflict"; reason: "payload_hash_mismatch"}>
  | Readonly<{kind: "in_progress"; leaseUntilMs: number}>;

export type InboxQuarantineRecord = Readonly<{
  topic: string;
  partition: number;
  offset: string;
  messageId?: string;
  messageType?: string;
  payloadHash?: string;
  envelope?: JsonValue;
  reason: string;
}>;

export type InboxQuarantineResult = "created" | "duplicate" | "conflict";

export type InboxErrorCode =
  | "INBOX_INVALID"
  | "INBOX_NOT_ACQUIRED"
  | "INBOX_LEASE_INVALID"
  | "INBOX_RECORD_INVALID";

export class InboxError extends Error {
  public readonly code: InboxErrorCode;

  public constructor(code: InboxErrorCode, message: string = code) {
    super(message);
    this.name = "InboxError";
    this.code = code;
  }
}

export type InboxFailure = Readonly<{
  kind: "invalid" | "permanent" | "transient";
  reason: string;
}>;

export class InboxProcessingError extends Error {
  public readonly failure: InboxFailure;

  public constructor(failure: InboxFailure) {
    super(failure.reason);
    this.name = "InboxProcessingError";
    this.failure = failure;
  }
}

export type InboxStore = Readonly<{
  begin(transaction: Transaction, message: InboxMessage, leaseOwner: string, nowMs: number, leaseMs: number): Promise<InboxBeginResult>;
  markProcessed(transaction: Transaction, messageId: string, leaseOwner: string, processedAt: string): Promise<void>;
  quarantine(transaction: Transaction, messageId: string, leaseOwner: string, reason: string): Promise<void>;
  release(transaction: Transaction, messageId: string, leaseOwner: string): Promise<void>;
  quarantineRecord(transaction: Transaction, record: InboxQuarantineRecord, nowMs: number): Promise<InboxQuarantineResult>;
}>;

type InboxRow = Readonly<{
  message_id: unknown;
  message_type: unknown;
  received_at: unknown;
  payload: unknown;
  payload_hash: unknown;
  state: unknown;
  lease_owner: unknown;
  lease_until_ms: unknown;
  attempt: unknown;
  processed_at: unknown;
  quarantine_reason: unknown;
}>;

type QuarantineRow = Readonly<{payload_hash: unknown}>;

function invalid(message: string = "некорректные параметры Inbox"): never {
  throw new InboxError("INBOX_INVALID", message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(`Inbox ${field} должен быть непустой строкой`);
  return value;
}

function safePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(`Inbox ${field} должен быть положительным целым числом`);
  return value;
}

function safeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`Inbox ${field} должен быть неотрицательным целым числом`);
  return value;
}

function validateMessage(message: InboxMessage): string {
  requiredString(message.messageId, "messageId");
  requiredString(message.messageType, "messageType");
  instantValue(message.receivedAt, "receivedAt");
  if (!/^[0-9a-f]{64}$/.test(message.payloadHash)) invalid("Inbox payloadHash некорректен");
  try {
    const computed = canonicalRequestHash(message.payload);
    if (computed !== message.payloadHash) invalid("Inbox payloadHash не совпадает с canonical payload");
    return computed;
  } catch {
    invalid("Inbox payload не является canonical JSON");
  }
}

function numberValue(value: unknown, field: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new InboxError("INBOX_RECORD_INVALID", `некорректное поле Inbox ${field}`);
  return number;
}

function stringValue(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new InboxError("INBOX_RECORD_INVALID", `некорректное поле Inbox ${field}`);
  return value;
}

function instantValue(value: unknown, field: string): string {
  const text = requiredString(value, field);
  try { return toInstant(text).toString(); } catch { invalid(`Inbox ${field} должен быть RFC3339 timestamp`); }
}

function rowInstantValue(value: unknown, field: string): string {
  const text = stringValue(value, field);
  try { return toInstant(text.replace(" ", "T")).toString(); } catch { throw new InboxError("INBOX_RECORD_INVALID", `некорректное поле Inbox ${field}`); }
}

function rowRecord(row: InboxRow): InboxRecord {
  const state = stringValue(row.state, "state");
  if (state !== "Processing" && state !== "Processed" && state !== "Quarantined") throw new InboxError("INBOX_RECORD_INVALID", "неизвестное состояние Inbox");
  const payloadHash = stringValue(row.payload_hash, "payload_hash");
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new InboxError("INBOX_RECORD_INVALID", "некорректный payload_hash Inbox");
  const messageId = stringValue(row.message_id, "message_id");
  const messageType = stringValue(row.message_type, "message_type");
  const receivedAt = rowInstantValue(row.received_at, "received_at");
  const payload = row.payload as JsonValue;
  return {
    message: {messageId, messageType, receivedAt, payloadHash, payload},
    payloadHash,
    state,
    leaseOwner: stringValue(row.lease_owner, "lease_owner", true),
    leaseUntilMs: numberValue(row.lease_until_ms, "lease_until_ms"),
    attempt: safePositiveInteger(numberValue(row.attempt, "attempt"), "attempt"),
    ...(row.processed_at === null || row.processed_at === undefined ? {} : {processedAt: stringValue(row.processed_at, "processed_at")}),
    ...(row.quarantine_reason === null || row.quarantine_reason === undefined ? {} : {quarantineReason: stringValue(row.quarantine_reason, "quarantine_reason")}),
  };
}

const rowProjection = `message_id, message_type, received_at::text AS received_at, payload,
  payload_hash, state, lease_owner,
  (extract(epoch from lease_until) * 1000)::bigint AS lease_until_ms,
  attempt, processed_at::text AS processed_at, quarantine_reason`;

// Consumer mode accepts the full envelope carried by processKafkaRecord, without
// depending on the Kafka package (which itself imports Inbox).
type ConsumerEnvelope = Readonly<{
  value: JsonValue;
  payload: JsonValue;
  messageId: string;
  messageType: string;
  partitionKey: string;
  schemaVersion: string;
  ownerVersion: string;
}>;

function consumerEnvelope(value: JsonValue, messageId?: string, messageType?: string): ConsumerEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Inbox требует full envelope");
  const envelope = value as Readonly<Record<string, JsonValue>>;
  const keys = ["envelopeVersion", "messageId", "messageType", "occurredAt", "producer", "correlationId", "causationId", "traceparent", "aggregate", "payload"];
  const aggregate = envelope["aggregate"];
  if (Object.keys(envelope).length !== keys.length || keys.some(key => !Object.hasOwn(envelope, key)) ||
      envelope["envelopeVersion"] !== "1" || aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate)) invalid("Inbox envelope некорректен");
  const owner = aggregate as Readonly<Record<string, JsonValue>>;
  if (Object.keys(owner).length !== 3 || ["type", "ref", "version"].some(key => !Object.hasOwn(owner, key))) invalid("Inbox aggregate некорректен");
  const identifier = (source: Readonly<Record<string, JsonValue>>, key: string): string => {
    const text = requiredString(source[key], key);
    // Transport identifiers must not contain control characters.
    // eslint-disable-next-line no-control-regex
    if (text.length > 256 || /[\u0000-\u001f]/u.test(text)) invalid("Inbox envelope identifier некорректен");
    return text;
  };
  const id = identifier(envelope, "messageId");
  const type = identifier(envelope, "messageType");
  if ((messageId !== undefined && id !== messageId) || (messageType !== undefined && type !== messageType)) invalid("Inbox envelope identity не совпадает");
  identifier(envelope, "producer");
  identifier(envelope, "correlationId");
  if (envelope["causationId"] !== null) identifier(envelope, "causationId");
  instantValue(envelope["occurredAt"], "occurredAt");
  const trace = identifier(envelope, "traceparent");
  if (!/^(?!ff)[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(trace) || trace.slice(3, 35) === "0".repeat(32) || trace.slice(36, 52) === "0".repeat(16)) invalid("Inbox traceparent некорректен");
  identifier(owner, "type");
  const partitionKey = identifier(owner, "ref");
  const ownerVersion = identifier(owner, "version");
  if (!/^[1-9][0-9]{0,18}$/u.test(ownerVersion) || BigInt(ownerVersion) > 9223372036854775807n) invalid("Inbox ownerVersion вне bigint");
  return {value, payload: envelope["payload"] as JsonValue, messageId: id, messageType: type, partitionKey, schemaVersion: "1", ownerVersion};
}

export type SqlInboxStoreOptions = Readonly<{schema?: string; table?: string; quarantineTable?: string; consumerName?: string}>;

export class SqlInboxStore implements InboxStore {
  private readonly consumerName: string | undefined;
  private readonly permits = new WeakMap<Transaction, Set<string>>();
  private readonly insert: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly readForUpdate: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<InboxRow>>;
  private readonly reclaim: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<InboxRow>>;
  private readonly markProcessedStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly quarantineStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly releaseStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly quarantineInsert: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{topic: string}>>>;
  private readonly quarantineRead: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<QuarantineRow>>;

  public constructor(database: Database, options: SqlInboxStoreOptions = {}) {
    const schema = quoteIdentifier(options.schema ?? "public");
    const table = quoteIdentifier(options.table ?? "inbox_messages");
    const quarantine = quoteIdentifier(options.quarantineTable ?? "inbox_quarantine");
    const qualified = `${schema}.${table}`;
    const quarantineQualified = `${schema}.${quarantine}`;
    this.consumerName = options.consumerName;
    if (this.consumerName !== undefined) {
      requiredString(this.consumerName, "consumerName");
      if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(this.consumerName) || this.consumerName.length > 64) invalid("Inbox consumerName некорректен");
      // Alias the full envelope/hash into the existing InboxRecord contract.
      const projection = rowProjection.replace("received_at, payload,", "received_at, envelope AS payload,").replace("payload_hash, state", "envelope_hash AS payload_hash, state");
      this.insert = defineStatement(database, `INSERT INTO ${qualified}
        (message_id, message_type, envelope, envelope_hash, lease_owner, lease_until, consumer_name,
         payload, payload_hash, partition_key, schema_version, owner_version)
        VALUES ($1, $2, $3::jsonb, $4, $5, clock_timestamp() + $6 * interval '1 millisecond', $7,
          $8::jsonb, $9, $10, $11, $12::bigint)
        ON CONFLICT (consumer_name, message_id) DO NOTHING RETURNING message_id`);
      this.readForUpdate = defineStatement(database, `SELECT ${projection} FROM ${qualified}
        WHERE message_id = $1 AND consumer_name = $2 FOR UPDATE`);
      this.reclaim = defineStatement(database, `UPDATE ${qualified}
        SET lease_owner = $2, lease_until = clock_timestamp() + $3 * interval '1 millisecond', attempt = attempt + 1
        WHERE message_id = $1 AND consumer_name = $4 AND state = 'Processing' AND lease_until <= clock_timestamp()
        RETURNING ${projection}`);
      this.markProcessedStatement = defineStatement(database, `UPDATE ${qualified}
        SET state = 'Processed', lease_owner = '', lease_until = clock_timestamp(), processed_at = clock_timestamp(),
          outcome = 'Processed', result = '{"kind":"Processed"}'::jsonb
        WHERE message_id = $1 AND consumer_name = $3 AND state = 'Processing' AND lease_owner = $2
          AND lease_until > clock_timestamp() RETURNING message_id`);
      this.quarantineStatement = defineStatement(database, `UPDATE ${qualified}
        SET state = 'Quarantined', lease_owner = '', lease_until = clock_timestamp(),
          quarantine_reason = $3, quarantined_at = clock_timestamp(), outcome = 'Quarantined', result = '{"kind":"Quarantined"}'::jsonb
        WHERE message_id = $1 AND consumer_name = $4 AND state = 'Processing' AND lease_owner = $2
          AND lease_until > clock_timestamp() RETURNING message_id`);
      this.releaseStatement = defineStatement(database, `UPDATE ${qualified} SET lease_until = clock_timestamp()
        WHERE message_id = $1 AND consumer_name = $3 AND state = 'Processing' AND lease_owner = $2
          AND lease_until > clock_timestamp() RETURNING message_id`);
      this.quarantineInsert = defineStatement(database, `INSERT INTO ${quarantineQualified}
        (consumer_name, topic, "partition", "offset", message_id, message_type, partition_key, schema_version,
          payload_hash, envelope_hash, envelope, reason)
        VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
        ON CONFLICT (consumer_name, topic, "partition", "offset") DO NOTHING RETURNING topic`);
      this.quarantineRead = defineStatement(database, `SELECT envelope_hash AS payload_hash FROM ${quarantineQualified}
        WHERE topic = $1 AND "partition" = $2 AND "offset" = $3::bigint AND consumer_name = $4`);
      return;
    }
    this.insert = defineStatement(database, `INSERT INTO ${qualified}
      (message_id, message_type, received_at, payload, payload_hash, state, lease_owner, lease_until, attempt)
      VALUES ($1, $2, $3::timestamptz, $4::jsonb, $5, 'Processing', $6, to_timestamp($7 / 1000.0), 1)
      ON CONFLICT (message_id) DO NOTHING RETURNING message_id`);
    this.readForUpdate = defineStatement(database, `SELECT ${rowProjection} FROM ${qualified}
      WHERE message_id = $1 FOR UPDATE`);
    this.reclaim = defineStatement(database, `UPDATE ${qualified}
      SET lease_owner = $2, lease_until = to_timestamp($3 / 1000.0), attempt = attempt + 1
      WHERE message_id = $1 AND state = 'Processing' AND lease_until <= clock_timestamp()
      RETURNING ${rowProjection}`);
    this.markProcessedStatement = defineStatement(database, `UPDATE ${qualified}
      SET state = 'Processed', lease_owner = '', lease_until = clock_timestamp(), processed_at = $3::timestamptz
      WHERE message_id = $1 AND state = 'Processing' AND lease_owner = $2
        AND lease_until > clock_timestamp() RETURNING message_id`);
    this.quarantineStatement = defineStatement(database, `UPDATE ${qualified}
      SET state = 'Quarantined', lease_owner = '', lease_until = clock_timestamp(),
        quarantine_reason = $3, quarantined_at = clock_timestamp()
      WHERE message_id = $1 AND state = 'Processing' AND lease_owner = $2
        AND lease_until > clock_timestamp() RETURNING message_id`);
    this.releaseStatement = defineStatement(database, `DELETE FROM ${qualified}
      WHERE message_id = $1 AND state = 'Processing' AND lease_owner = $2
        AND lease_until > clock_timestamp() RETURNING message_id`);
    this.quarantineInsert = defineStatement(database, `INSERT INTO ${quarantineQualified}
      (topic, "partition", "offset", message_id, message_type, payload_hash, envelope, reason, quarantined_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, to_timestamp($9 / 1000.0))
      ON CONFLICT (topic, "partition", "offset") DO NOTHING RETURNING topic`);
    this.quarantineRead = defineStatement(database, `SELECT payload_hash FROM ${quarantineQualified}
      WHERE topic = $1 AND "partition" = $2 AND "offset" = $3 FOR UPDATE`);
  }

  public async begin(transaction: Transaction, message: InboxMessage, leaseOwner: string, nowMs: number, leaseMs: number): Promise<InboxBeginResult> {
    const payloadHash = validateMessage(message);
    requiredString(leaseOwner, "leaseOwner");
    safeNonNegativeInteger(nowMs, "nowMs");
    safePositiveInteger(leaseMs, "leaseMs");
    if (nowMs + leaseMs > Number.MAX_SAFE_INTEGER) invalid("Inbox lease выходит за пределы safe integer");
    const leaseUntilMs = nowMs + leaseMs;
    const envelope = this.consumerName === undefined ? undefined : consumerEnvelope(message.payload, message.messageId, message.messageType);
    const inserted = await this.insert(transaction, envelope === undefined
      ? [message.messageId, message.messageType, message.receivedAt, canonicalJson(message.payload), payloadHash, leaseOwner, leaseUntilMs]
      : [message.messageId, message.messageType, canonicalJson(envelope.value), payloadHash, leaseOwner, leaseMs,
        this.consumerName as string, canonicalJson(envelope.payload), canonicalRequestHash(envelope.payload), envelope.partitionKey, envelope.schemaVersion, envelope.ownerVersion]);
    const result = await this.readForUpdate(transaction, this.consumerName === undefined ? [message.messageId] : [message.messageId, this.consumerName]);
    let row = result.rows[0];
    if (row === undefined) throw new InboxError("INBOX_RECORD_INVALID", "Inbox acquire не вернул запись");
    if (String(row.payload_hash) !== payloadHash) return {kind: "conflict", reason: "payload_hash_mismatch"};
    const state = String(row.state);
    if (state === "Processed" || state === "Quarantined") return {kind: "duplicate", state};
    if (state !== "Processing") throw new InboxError("INBOX_RECORD_INVALID", "неизвестное состояние Inbox");
    if (inserted.rowCount !== 1) {
      const reclaimed = await this.reclaim(transaction, this.consumerName === undefined ? [message.messageId, leaseOwner, leaseUntilMs] : [message.messageId, leaseOwner, leaseMs, this.consumerName]);
      if (reclaimed.rowCount === 1) {
        row = reclaimed.rows[0];
        if (row === undefined) throw new InboxError("INBOX_RECORD_INVALID", "Inbox reclaim не вернул запись");
      } else {
        const leaseUntil = numberValue(row.lease_until_ms, "lease_until_ms");
        return {kind: "in_progress", leaseUntilMs: leaseUntil};
      }
    }
    const record = rowRecord(row);
    let permits = this.permits.get(transaction);
    if (permits === undefined) {
      permits = new Set<string>();
      this.permits.set(transaction, permits);
    }
    permits.add(`${message.messageId}\u0000${leaseOwner}`);
    return {kind: "acquired", record};
  }

  public async markProcessed(transaction: Transaction, messageId: string, leaseOwner: string, processedAt: string): Promise<void> {
    this.requirePermit(transaction, messageId, leaseOwner);
    requiredString(processedAt, "processedAt");
    if (this.consumerName !== undefined) instantValue(processedAt, "processedAt");
    const result = await this.markProcessedStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), this.consumerName ?? processedAt]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async quarantine(transaction: Transaction, messageId: string, leaseOwner: string, reason: string): Promise<void> {
    this.requirePermit(transaction, messageId, leaseOwner);
    validateReason(reason);
    const result = await this.quarantineStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), reason, ...(this.consumerName === undefined ? [] : [this.consumerName])]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async release(transaction: Transaction, messageId: string, leaseOwner: string): Promise<void> {
    this.requirePermit(transaction, messageId, leaseOwner);
    const result = await this.releaseStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), ...(this.consumerName === undefined ? [] : [this.consumerName])]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async quarantineRecord(transaction: Transaction, record: InboxQuarantineRecord, nowMs: number): Promise<InboxQuarantineResult> {
    validateQuarantineRecord(record);
    safeNonNegativeInteger(nowMs, "nowMs");
    if (this.consumerName !== undefined) {
      if (!/^(0|[1-9][0-9]{0,18})$/u.test(record.offset) || BigInt(record.offset) > 9223372036854775807n) invalid("Inbox offset вне bigint");
      const envelopeHash = record.envelope === undefined ? null : canonicalRequestHash(record.envelope);
      if (record.payloadHash !== undefined && record.payloadHash !== envelopeHash) invalid("Inbox envelope hash не совпадает");
      let parsed: ConsumerEnvelope | undefined;
      if (record.envelope !== undefined) {
        try { parsed = consumerEnvelope(record.envelope, record.messageId, record.messageType); }
        catch (error) { if (!(error instanceof InboxError)) throw error; }
      }
      const inserted = await this.quarantineInsert(transaction, [this.consumerName, record.topic, record.partition, record.offset,
        record.messageId ?? parsed?.messageId ?? null, record.messageType ?? parsed?.messageType ?? null,
        parsed?.partitionKey ?? null, parsed?.schemaVersion ?? null, parsed === undefined ? null : canonicalRequestHash(parsed.payload),
        envelopeHash, record.envelope === undefined ? null : canonicalJson(record.envelope),
        record.reason === "INBOX_HASH_CONFLICT" ? "MESSAGE_ID_PAYLOAD_CONFLICT" : record.reason]);
      if (inserted.rowCount === 1) return "created";
      const existing = await this.quarantineRead(transaction, [record.topic, record.partition, record.offset, this.consumerName]);
      const row = existing.rows[0];
      if (row === undefined) throw new InboxError("INBOX_RECORD_INVALID", "Inbox quarantine не вернул запись");
      return row.payload_hash === envelopeHash ? "duplicate" : "conflict";
    }
    const payloadHash = record.payloadHash ?? (record.envelope === undefined ? null : canonicalRequestHash(record.envelope));
    const envelope = record.envelope === undefined ? null : canonicalJson(record.envelope);
    const inserted = await this.quarantineInsert(transaction, [record.topic, record.partition, record.offset, record.messageId ?? null, record.messageType ?? null, payloadHash, envelope, record.reason, nowMs]);
    if (inserted.rowCount === 1) return "created";
    const existing = await this.quarantineRead(transaction, [record.topic, record.partition, record.offset]);
    const row = existing.rows[0];
    if (row === undefined) throw new InboxError("INBOX_RECORD_INVALID", "Inbox quarantine не вернул запись");
    return row.payload_hash === payloadHash ? "duplicate" : "conflict";
  }

  private requirePermit(transaction: Transaction, messageId: string, leaseOwner: string): void {
    requiredString(messageId, "messageId");
    requiredString(leaseOwner, "leaseOwner");
    if (!this.permits.get(transaction)?.has(`${messageId}\u0000${leaseOwner}`)) throw new InboxError("INBOX_NOT_ACQUIRED", "Inbox transaction не владеет lease");
  }
}

function validateReason(reason: string): void {
  requiredString(reason, "reason");
  if (reason.length > 512) invalid("Inbox reason слишком длинный");
}

function validateQuarantineRecord(record: InboxQuarantineRecord): void {
  requiredString(record.topic, "topic");
  safeNonNegativeInteger(record.partition, "partition");
  requiredString(record.offset, "offset");
  if (record.messageId !== undefined) requiredString(record.messageId, "messageId");
  if (record.messageType !== undefined) requiredString(record.messageType, "messageType");
  if (record.payloadHash !== undefined && !/^[0-9a-f]{64}$/.test(record.payloadHash)) invalid("Inbox payloadHash некорректен");
  validateReason(record.reason);
  if (record.envelope !== undefined) {
    try { canonicalJson(record.envelope); } catch { invalid("Inbox envelope не является canonical JSON"); }
  }
}

export type ConsumeResult = Readonly<{kind: "processed" | "duplicate" | "in_progress" | "quarantined" | "conflict"}>;

/** Выполняется внутри уже открытой withTransaction. Любая ошибка handler должна
 * откатить внешнюю transaction; permanent disposition фиксирует coordinator
 * отдельной transaction только после подтверждённого rollback owner effects. */
export async function consumeOnce(
  store: InboxStore,
  transaction: Transaction,
  message: InboxMessage,
  leaseOwner: string,
  nowMs: number,
  leaseMs: number,
  handler: (transaction: Transaction) => Promise<void>,
  processedAt: string,
): Promise<ConsumeResult> {
  const span = trace.getTracer("coffee-platform.inbox").startSpan("Inbox.consumeOnce", {kind: SpanKind.INTERNAL});
  try {
  const begin = await store.begin(transaction, message, leaseOwner, nowMs, leaseMs);
  initializeInboxMetrics();
  const receivedAgeMs = toInstant(processedAt).epochMilliseconds - toInstant(message.receivedAt).epochMilliseconds;
  if (Number.isSafeInteger(receivedAgeMs) && receivedAgeMs >= 0)
    inboxReceivedAge?.record(receivedAgeMs, {"messaging.consumer.group": leaseOwner});
  if (begin.kind === "duplicate") {
    const result = {kind: begin.state === "Quarantined" ? "quarantined" : "duplicate"} as const;
    span.setAttribute("messaging.inbox.result", result.kind);
    return result;
  }
  if (begin.kind === "conflict" || begin.kind === "in_progress") {
    span.setAttribute("messaging.inbox.result", begin.kind);
    return begin;
  }
  await context.with(trace.setSpan(context.active(), span), () => handler(transaction));
  await store.markProcessed(transaction, message.messageId, leaseOwner, processedAt);
  span.setAttribute("messaging.inbox.result", "processed");
  return {kind: "processed"};
  } catch (error) {
    span.setAttribute("messaging.inbox.result", "failed");
    span.setStatus({code: SpanStatusCode.ERROR});
    throw error;
  } finally {
    span.end();
  }
}

export function createSqlInboxStore(database: Database, options: SqlInboxStoreOptions = {}): SqlInboxStore {
  return new SqlInboxStore(database, options);
}
