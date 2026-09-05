import {canonicalJson, canonicalRequestHash, type JsonValue} from "@coffee-platform/idempotency";
import {withTransaction, quoteIdentifier, type Database, type QueryResult, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {toInstant} from "@coffee-platform/platform-time";

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

export type OutboxState = "Pending" | "Publishing" | "Published" | "Quarantined";

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
  enqueue(transaction: Transaction, message: OutboxMessage): Promise<"created" | "duplicate" | "conflict">;
  claim(transaction: Transaction, nowMs: number, leaseOwner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]>;
  finalize(transaction: Transaction, messageId: string, leaseOwner: string, leaseToken: bigint | number): Promise<void>;
  fail(transaction: Transaction, messageId: string, leaseOwner: string, leaseToken: bigint | number, nextAttemptAtMs: number, lastError: string, permanent: boolean): Promise<OutboxState>;
}>;

type OutboxRow = Readonly<{
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
  if (typeof value !== "string" || value.length === 0) invalid(`Outbox ${field} должен быть непустой строкой`);
  return value;
}

function boundedString(value: unknown, field: string, max: number): string {
  const result = requiredString(value, field);
  if (result.length > max) invalid(`Outbox ${field} слишком длинный`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) invalid(`Outbox ${field} должен быть положительным целым числом`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`Outbox ${field} должен быть неотрицательным целым числом`);
  return value;
}

function sequenceValue(value: number | bigint): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) invalid("Outbox aggregateSequence должен быть safe integer");
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result <= 0n) invalid("Outbox aggregateSequence должен быть положительным");
  return result;
}

function numberValue(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new OutboxError("OUTBOX_RECORD_INVALID", `некорректное поле Outbox ${field}`);
  return result;
}

function bigintValue(value: unknown, field: string): bigint {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new OutboxError("OUTBOX_RECORD_INVALID", `некорректное поле Outbox ${field}`);
  }
}

function stringValue(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new OutboxError("OUTBOX_RECORD_INVALID", `некорректное поле Outbox ${field}`);
  return value;
}

function instantValue(value: unknown, field: string): string {
  const text = requiredString(value, field);
  try { return toInstant(text).toString(); } catch { invalid(`Outbox ${field} должен быть RFC3339 timestamp`); }
}

function rowInstantValue(value: unknown, field: string): string {
  const text = stringValue(value, field);
  try { return toInstant(text.replace(" ", "T")).toString(); } catch { throw new OutboxError("OUTBOX_RECORD_INVALID", `некорректное поле Outbox ${field}`); }
}

function validateMessage(message: OutboxMessage): string {
  for (const [value, field] of [[message.messageId, "messageId"], [message.messageType, "messageType"], [message.topic, "topic"], [message.aggregateRef, "aggregateRef"], [message.ownerVersion, "ownerVersion"], [message.partitionKey, "partitionKey"], [message.schemaVersion, "schemaVersion"], [message.occurredAt, "occurredAt"], [message.correlationId, "correlationId"]] as const) requiredString(value, field);
  const occurredAt = instantValue(message.occurredAt, "occurredAt");
  sequenceValue(message.aggregateSequence);
  if (message.causationId !== undefined) requiredString(message.causationId, "causationId");
  const traceparent = requiredString(message.traceparent, "traceparent");
  try {
    const envelope = message.envelope;
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) invalid("Outbox envelope должен быть plain object");
    const envelopeObject = envelope as {readonly [key: string]: JsonValue | undefined};
    const envelopeKeys = ["envelopeVersion", "messageId", "messageType", "occurredAt", "producer", "correlationId", "causationId", "traceparent", "aggregate", "payload"];
    if (Object.keys(envelopeObject).length !== envelopeKeys.length || Object.keys(envelopeObject).some(key => !envelopeKeys.includes(key))) invalid("Outbox envelope имеет неверный набор полей");
    if (envelopeObject["envelopeVersion"] !== "1" || message.schemaVersion !== "1") invalid("Outbox envelopeVersion должен быть '1'");
    if (envelopeObject["messageId"] !== message.messageId) invalid("Outbox envelope messageId должен совпадать с messageId");
    if (envelopeObject["messageType"] !== message.messageType) invalid("Outbox envelope messageType должен совпадать с messageType");
    if (instantValue(envelopeObject["occurredAt"], "envelope.occurredAt") !== occurredAt) invalid("Outbox envelope occurredAt должен совпадать с occurredAt");
    requiredString(envelopeObject["producer"], "envelope.producer");
    if (envelopeObject["correlationId"] !== message.correlationId) invalid("Outbox envelope correlationId должен совпадать с correlationId");
    const envelopeCausationId = envelopeObject["causationId"];
    if (envelopeCausationId !== (message.causationId ?? null) || (envelopeCausationId !== null && typeof envelopeCausationId !== "string")) invalid("Outbox envelope causationId должен совпадать с causationId");
    if (envelopeCausationId !== null) requiredString(envelopeCausationId, "envelope.causationId");
    if (envelopeObject["traceparent"] !== traceparent) invalid("Outbox envelope traceparent должен совпадать с traceparent");
    const aggregate = envelopeObject["aggregate"];
    if (aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate)) invalid("Outbox envelope aggregate должен быть plain object");
    const aggregateObject = aggregate as {readonly [key: string]: JsonValue | undefined};
    const aggregateKeys = ["type", "ref", "version"];
    if (Object.keys(aggregateObject).length !== aggregateKeys.length || Object.keys(aggregateObject).some(key => !aggregateKeys.includes(key))) invalid("Outbox envelope aggregate имеет неверный набор полей");
    requiredString(aggregateObject["type"], "envelope.aggregate.type");
    requiredString(aggregateObject["ref"], "envelope.aggregate.ref");
    requiredString(aggregateObject["version"], "envelope.aggregate.version");
    if (aggregateObject["ref"] !== message.aggregateRef) invalid("Outbox envelope aggregate.ref должен совпадать с aggregateRef");
    if (aggregateObject["version"] !== message.ownerVersion) invalid("Outbox envelope aggregate.version должен совпадать с ownerVersion");
    const envelopePayload = envelopeObject["payload"];
    if (envelopePayload === undefined || canonicalJson(envelopePayload) !== canonicalJson(message.payload)) invalid("Outbox envelope payload должен совпадать с payload");
    canonicalJson(envelope);
    return canonicalRequestHash(message.envelope);
  } catch {
    invalid("Outbox envelope или payload не является canonical JSON");
  }
}

function rowMessage(row: OutboxRow): OutboxClaim {
  const state = stringValue(row.state, "state");
  if (state !== "Publishing") throw new OutboxError("OUTBOX_RECORD_INVALID", "claim вернул не Publishing row");
  const payloadHash = stringValue(row.payload_hash, "payload_hash");
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) throw new OutboxError("OUTBOX_RECORD_INVALID", "некорректный payload_hash Outbox");
  const message: OutboxMessage = {
    messageId: stringValue(row.message_id, "message_id"),
    messageType: stringValue(row.message_type, "message_type"),
    topic: stringValue(row.topic, "topic"),
    aggregateRef: stringValue(row.aggregate_ref, "aggregate_ref"),
    aggregateSequence: bigintValue(row.aggregate_sequence, "aggregate_sequence"),
    ownerVersion: stringValue(row.owner_version, "owner_version"),
    partitionKey: stringValue(row.partition_key, "partition_key"),
    schemaVersion: stringValue(row.schema_version, "schema_version"),
    envelope: row.envelope as JsonValue,
    payload: row.payload as JsonValue,
    occurredAt: rowInstantValue(row.occurred_at, "occurred_at"),
    correlationId: stringValue(row.correlation_id, "correlation_id"),
    ...(row.causation_id === null || row.causation_id === undefined ? {} : {causationId: stringValue(row.causation_id, "causation_id")}),
    traceparent: stringValue(row.traceparent, "traceparent"),
  };
  let computedHash: string;
  try { computedHash = validateMessage(message); } catch { throw new OutboxError("OUTBOX_RECORD_INVALID", "claim вернул некорректное сообщение"); }
  if (computedHash !== payloadHash) throw new OutboxError("OUTBOX_RECORD_INVALID", "claim payload_hash не совпадает с envelope");
  return {
    message,
    payloadHash,
    state: "Publishing",
    attempt: positiveInteger(numberValue(row.attempt, "attempt"), "attempt"),
    leaseOwner: stringValue(row.lease_owner, "lease_owner"),
    leaseToken: bigintValue(row.lease_token, "lease_token"),
    leaseUntilMs: numberValue(row.lease_until_ms, "lease_until_ms"),
    nextAttemptAtMs: numberValue(row.next_attempt_at_ms, "next_attempt_at_ms"),
    ...(row.last_error === null || row.last_error === undefined ? {} : {lastError: stringValue(row.last_error, "last_error")}),
  };
}

const claimProjection = `current.message_id, current.message_type, current.topic, current.aggregate_ref, current.aggregate_sequence,
  current.owner_version, current.partition_key, current.schema_version, current.envelope, current.payload, current.payload_hash,
  current.envelope ->> 'occurredAt' AS occurred_at, current.correlation_id, current.causation_id, current.traceparent,
  current.state, current.lease_owner, current.lease_token,
  (extract(epoch from current.lease_until) * 1000)::bigint AS lease_until_ms,
  current.attempt, (extract(epoch from current.next_attempt_at) * 1000)::bigint AS next_attempt_at_ms, current.last_error`;

export type SqlOutboxStoreOptions = Readonly<{schema?: string; table?: string}>;

export class SqlOutboxStore implements OutboxStore {
  private readonly insert: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly readById: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<ExistingMessageRow>>;
  private readonly readSequence: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{aggregate_sequence: unknown}>>>;
  private readonly claimStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<OutboxRow>>;
  private readonly finalizeStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{message_id: string}>>>;
  private readonly failStatement: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{state: string}>>>;

  public constructor(database: Database, options: SqlOutboxStoreOptions = {}) {
    const qualified = `${quoteIdentifier(options.schema ?? "public")}.${quoteIdentifier(options.table ?? "outbox_messages")}`;
    this.insert = defineStatement(database, `INSERT INTO ${qualified}
      (message_id, message_type, topic, aggregate_ref, aggregate_sequence, owner_version,
       partition_key, schema_version, envelope, payload, payload_hash, occurred_at,
       correlation_id, causation_id, traceparent, state, lease_owner, lease_token,
       lease_until, attempt, next_attempt_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::timestamptz,
       $13, $14, $15, 'Pending', '', 0, clock_timestamp(), 0, clock_timestamp())
      ON CONFLICT (message_id) DO NOTHING RETURNING message_id`);
    this.readById = defineStatement(database, `SELECT payload_hash, message_type, topic, aggregate_ref, aggregate_sequence, owner_version, partition_key, schema_version, envelope
      FROM ${qualified} WHERE message_id = $1 FOR UPDATE`);
    this.readSequence = defineStatement(database, `SELECT aggregate_sequence FROM ${qualified}
      WHERE aggregate_ref = $1 ORDER BY aggregate_sequence DESC LIMIT 1 FOR UPDATE`);
    this.claimStatement = defineStatement(database, `WITH candidates AS (
      SELECT current.message_id FROM ${qualified} AS current
      WHERE current.next_attempt_at <= to_timestamp($1 / 1000.0)
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
    RETURNING ${claimProjection}`);
    this.finalizeStatement = defineStatement(database, `UPDATE ${qualified}
      SET state = 'Published', lease_owner = '', lease_until = clock_timestamp(), published_at = clock_timestamp()
      WHERE message_id = $1 AND state = 'Publishing' AND lease_owner = $2
        AND lease_token = $3 AND lease_until > clock_timestamp() RETURNING message_id`);
    this.failStatement = defineStatement(database, `UPDATE ${qualified}
      SET state = CASE WHEN $6 THEN 'Quarantined' ELSE 'Pending' END,
          lease_owner = '', lease_until = clock_timestamp(), next_attempt_at = to_timestamp($5 / 1000.0),
          last_error = $4,
          quarantined_at = CASE WHEN $6 THEN clock_timestamp() ELSE quarantined_at END
      WHERE message_id = $1 AND state = 'Publishing' AND lease_owner = $2
        AND lease_token = $3 AND lease_until > clock_timestamp() RETURNING state`);
  }

  public async enqueue(transaction: Transaction, message: OutboxMessage): Promise<"created" | "duplicate" | "conflict"> {
    const payloadHash = validateMessage(message);
    const sequence = sequenceValue(message.aggregateSequence);
    const existing = await this.readById(transaction, [message.messageId]);
    const existingRow = existing.rows[0];
    if (existingRow !== undefined) return sameMessage(existingRow, message, payloadHash) ? "duplicate" : "conflict";
    const sequenceRows = await this.readSequence(transaction, [message.aggregateRef]);
    const latest = sequenceRows.rows[0];
    const expected = latest === undefined ? 1n : bigintValue(latest.aggregate_sequence, "aggregate_sequence") + 1n;
    if (sequence !== expected) throw new OutboxError("OUTBOX_SEQUENCE_INVALID", "aggregateSequence должен быть непрерывным");
    const inserted = await this.insert(transaction, [message.messageId, message.messageType, message.topic, message.aggregateRef, sequence, message.ownerVersion, message.partitionKey, message.schemaVersion, canonicalJson(message.envelope), canonicalJson(message.payload), payloadHash, message.occurredAt, message.correlationId, message.causationId ?? null, message.traceparent ?? null]);
    if (inserted.rowCount === 1) return "created";
    const raced = await this.readById(transaction, [message.messageId]);
    const racedRow = raced.rows[0];
    return racedRow === undefined ? "conflict" : sameMessage(racedRow, message, payloadHash) ? "duplicate" : "conflict";
  }

  public async claim(transaction: Transaction, nowMs: number, leaseOwner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]> {
    nonNegativeInteger(nowMs, "nowMs");
    requiredString(leaseOwner, "leaseOwner");
    positiveInteger(limit, "limit");
    positiveInteger(leaseMs, "leaseMs");
    if (nowMs + leaseMs > Number.MAX_SAFE_INTEGER) invalid("Outbox lease выходит за пределы safe integer");
    const result = await this.claimStatement(transaction, [nowMs, nowMs + leaseMs, leaseOwner, limit]);
    return result.rows.map(rowMessage);
  }

  public async finalize(transaction: Transaction, messageId: string, leaseOwner: string, leaseToken: bigint | number): Promise<void> {
    const result = await this.finalizeStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), sequenceValue(leaseToken)]);
    if (result.rowCount !== 1) throw new OutboxError("OUTBOX_LEASE_INVALID", "Outbox lease недействителен, истёк или fence token устарел");
  }

  public async fail(transaction: Transaction, messageId: string, leaseOwner: string, leaseToken: bigint | number, nextAttemptAtMs: number, lastError: string, permanent: boolean): Promise<OutboxState> {
    nonNegativeInteger(nextAttemptAtMs, "nextAttemptAtMs");
    boundedString(lastError, "lastError", 512);
    if (typeof permanent !== "boolean") invalid("Outbox permanent должен быть boolean");
    const result = await this.failStatement(transaction, [requiredString(messageId, "messageId"), requiredString(leaseOwner, "leaseOwner"), sequenceValue(leaseToken), lastError, nextAttemptAtMs, permanent]);
    const state = result.rows[0]?.state;
    if (result.rowCount !== 1 || (state !== "Pending" && state !== "Quarantined")) throw new OutboxError("OUTBOX_LEASE_INVALID", "Outbox lease недействителен, истёк или fence token устарел");
    return state;
  }
}

function sameMessage(row: ExistingMessageRow, message: OutboxMessage, payloadHash: string): boolean {
  let envelopeHash: string;
  try { envelopeHash = canonicalRequestHash(row.envelope as JsonValue); } catch { return false; }
  return row.payload_hash === payloadHash && envelopeHash === payloadHash && row.message_type === message.messageType && row.topic === message.topic && row.aggregate_ref === message.aggregateRef && String(row.aggregate_sequence) === String(sequenceValue(message.aggregateSequence)) && row.owner_version === message.ownerVersion && row.partition_key === message.partitionKey && row.schema_version === message.schemaVersion;
}

export function createSqlOutboxStore(database: Database, options: SqlOutboxStoreOptions = {}): SqlOutboxStore {
  return new SqlOutboxStore(database, options);
}

export type OutboxSendResult =
  | Readonly<{kind: "ack"}>
  | Readonly<{kind: "unknown"}>
  | Readonly<{kind: "failed"; permanent?: boolean; error?: string}>;

export type OutboxSender = (claim: OutboxClaim, signal: AbortSignal) => Promise<OutboxSendResult>;
export type OutboxRelayOptions = Readonly<{
  nowMs: number;
  leaseOwner: string;
  policy: Readonly<{
    leaseMs: number;
    sendTimeoutMs: number;
    maxInFlight: number;
    retry: Readonly<{baseMs: number; maxMs: number; maxAttempts: number}>;
  }>;
  signal?: AbortSignal;
}>;
export type OutboxRelayResult = Readonly<{claimed: number; published: number; failed: number; unknown: number; quarantined: number}>;

export async function relayOutboxBatch(store: OutboxStore, database: Database, send: OutboxSender, options: OutboxRelayOptions): Promise<OutboxRelayResult> {
  nonNegativeInteger(options.nowMs, "nowMs");
  requiredString(options.leaseOwner, "leaseOwner");
  positiveInteger(options.policy.leaseMs, "policy.leaseMs");
  positiveInteger(options.policy.sendTimeoutMs, "policy.sendTimeoutMs");
  positiveInteger(options.policy.maxInFlight, "policy.maxInFlight");
  positiveInteger(options.policy.retry.baseMs, "policy.retry.baseMs");
  positiveInteger(options.policy.retry.maxMs, "policy.retry.maxMs");
  positiveInteger(options.policy.retry.maxAttempts, "policy.retry.maxAttempts");
  if (options.policy.retry.baseMs > options.policy.retry.maxMs) invalid("policy.retry baseMs должен быть не больше maxMs");
  const txOptions = {mode: "background" as const, ...(options.signal === undefined ? {} : {signal: options.signal})};
  const claims = await withTransaction(database, txOptions, transaction => store.claim(transaction, options.nowMs, options.leaseOwner, options.policy.maxInFlight, options.policy.leaseMs));
  const processClaim = async (claim: OutboxClaim): Promise<OutboxRelayResult> => {
    if (options.signal?.aborted) return {claimed: 0, published: 0, failed: 0, unknown: 0, quarantined: 0};
    const timeout = new AbortController();
    const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal]);
    const sendPromise = Promise.resolve().then(() => send(claim, signal)).catch((): OutboxSendResult => ({kind: "unknown"}));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<OutboxSendResult>((resolve) => {timer = setTimeout(() => {timeout.abort(); resolve({kind: "unknown"});}, options.policy.sendTimeoutMs);});
    const outcome = await Promise.race([sendPromise, timeoutPromise]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome.kind === "ack") {
      await withTransaction(database, txOptions, transaction => store.finalize(transaction, claim.message.messageId, claim.leaseOwner, claim.leaseToken));
      return {claimed: 0, published: 1, failed: 0, unknown: 0, quarantined: 0};
    }
    if (outcome.kind === "unknown") return {claimed: 0, published: 0, failed: 0, unknown: 1, quarantined: 0};
    const exponent = Math.min(30, Math.max(0, claim.attempt - 1));
    const delay = Math.min(options.policy.retry.maxMs, options.policy.retry.baseMs * (2 ** exponent));
    const permanent = outcome.permanent === true || claim.attempt >= options.policy.retry.maxAttempts;
    const error = outcome.error === undefined ? "outbox send failed" : outcome.error.slice(0, 512);
    const state = await withTransaction(database, txOptions, transaction => store.fail(transaction, claim.message.messageId, claim.leaseOwner, claim.leaseToken, options.nowMs + delay, error, permanent));
    return {claimed: 0, published: 0, failed: 1, unknown: 0, quarantined: state === "Quarantined" ? 1 : 0};
  };
  const settled = await Promise.allSettled(claims.map(processClaim));
  return settled.reduce((total, result) => {
    if (result.status === "fulfilled") return {
      claimed: total.claimed,
      published: total.published + result.value.published,
      failed: total.failed + result.value.failed,
      unknown: total.unknown + result.value.unknown,
      quarantined: total.quarantined + result.value.quarantined,
    };
    return {...total, unknown: total.unknown + 1};
  }, {claimed: claims.length, published: 0, failed: 0, unknown: 0, quarantined: 0});
}
