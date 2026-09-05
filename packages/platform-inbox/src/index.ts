import {canonicalJson, canonicalRequestHash, type JsonValue} from "@coffee-platform/idempotency";
import {quoteIdentifier, type Database, type QueryResult, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {toInstant} from "@coffee-platform/platform-time";

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

export type SqlInboxStoreOptions = Readonly<{schema?: string; table?: string; quarantineTable?: string}>;

export class SqlInboxStore implements InboxStore {
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
    const inserted = await this.insert(transaction, [message.messageId, message.messageType, message.receivedAt, canonicalJson(message.payload), payloadHash, leaseOwner, leaseUntilMs]);
    let result = await this.readForUpdate(transaction, [message.messageId]);
    let row = result.rows[0];
    if (row === undefined) throw new InboxError("INBOX_RECORD_INVALID", "Inbox acquire не вернул запись");
    if (String(row.payload_hash) !== payloadHash) return {kind: "conflict", reason: "payload_hash_mismatch"};
    const state = String(row.state);
    if (state === "Processed" || state === "Quarantined") return {kind: "duplicate", state};
    if (state !== "Processing") throw new InboxError("INBOX_RECORD_INVALID", "неизвестное состояние Inbox");
    if (inserted.rowCount !== 1) {
      const reclaimed = await this.reclaim(transaction, [message.messageId, leaseOwner, leaseUntilMs]);
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
    const result = await this.markProcessedStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), processedAt]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async quarantine(transaction: Transaction, messageId: string, leaseOwner: string, reason: string): Promise<void> {
    this.requirePermit(transaction, messageId, leaseOwner);
    validateReason(reason);
    const result = await this.quarantineStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), reason]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async release(transaction: Transaction, messageId: string, leaseOwner: string): Promise<void> {
    this.requirePermit(transaction, messageId, leaseOwner);
    const result = await this.releaseStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner")]);
    if (result.rowCount !== 1) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен или истёк");
    this.permits.get(transaction)?.delete(`${messageId}\u0000${leaseOwner}`);
  }

  public async quarantineRecord(transaction: Transaction, record: InboxQuarantineRecord, nowMs: number): Promise<InboxQuarantineResult> {
    validateQuarantineRecord(record);
    safeNonNegativeInteger(nowMs, "nowMs");
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

/** Выполняется внутри уже открытой withTransaction; transient error должен откатить внешнюю transaction. */
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
  const begin = await store.begin(transaction, message, leaseOwner, nowMs, leaseMs);
  if (begin.kind === "duplicate") return {kind: begin.state === "Quarantined" ? "quarantined" : "duplicate"};
  if (begin.kind === "conflict") return begin;
  if (begin.kind === "in_progress") return begin;
  await handler(transaction);
  await store.markProcessed(transaction, message.messageId, leaseOwner, processedAt);
  return {kind: "processed"};
}

export function createSqlInboxStore(database: Database, options: SqlInboxStoreOptions = {}): SqlInboxStore {
  return new SqlInboxStore(database, options);
}
