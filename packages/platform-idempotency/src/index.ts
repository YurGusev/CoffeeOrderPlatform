import {createHash} from "node:crypto";
import {quoteIdentifier} from "@coffee-platform/database";
import type {Database, QueryResult, SqlScalar, Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | {readonly [key: string]: JsonValue};

export type IdempotencyKey = Readonly<{
  actorRef: string;
  scope: string;
  key: string;
}>;

export type IdempotencyResponse = Readonly<{
  status: number;
  body: JsonValue;
  resourceRef?: string;
}>;

export type IdempotencyRecord<Response extends IdempotencyResponse = IdempotencyResponse> = Readonly<{
  identity: IdempotencyKey;
  requestHash: string;
  state: "Acquired" | "Completed";
  leaseOwner: string;
  leaseUntilMs: number;
  expiresAtMs: number;
  response?: Response;
}>;

export type AcquireResult<Response extends IdempotencyResponse = IdempotencyResponse> =
  | Readonly<{kind: "acquired"; record: IdempotencyRecord<Response>}>
  | Readonly<{kind: "replay"; response: Response}>
  | Readonly<{kind: "conflict"; reason: "request_hash_mismatch"}>
  | Readonly<{kind: "in_progress"; leaseUntilMs: number}>;

export type IdempotencyErrorCode =
  | "IDEMPOTENCY_NOT_ACQUIRED"
  | "IDEMPOTENCY_EXPIRED"
  | "IDEMPOTENCY_RECORD_INVALID";

export class IdempotencyError extends Error {
  public readonly code: IdempotencyErrorCode;

  public constructor(code: IdempotencyErrorCode, message: string) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
  }
}

function validateIdentity(identity: IdempotencyKey, requestHash: string, leaseOwner: string): void {
  if (!identity.actorRef || !identity.scope || !identity.key || !leaseOwner || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректная idempotency identity или request hash");
  }
}

function validateWindow(nowMs: number, leaseMs: number, retentionMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 ||
    !Number.isSafeInteger(retentionMs) || retentionMs <= 0 || leaseMs > retentionMs ||
    nowMs + leaseMs > Number.MAX_SAFE_INTEGER || nowMs + retentionMs > Number.MAX_SAFE_INTEGER) {
    throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректное окно idempotency");
  }
}

function validateResponse(response: IdempotencyResponse): void {
  if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректный terminal response");
  }
}

function canonicalize(value: JsonValue, stack = new WeakSet<object>()): JsonValue {
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("canonical JSON не допускает циклические значения");
    stack.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("canonical JSON не допускает sparse array");
      result.push(canonicalize(value[index] as JsonValue, stack));
    }
    stack.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    const object = value as {readonly [key: string]: JsonValue};
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON допускает только plain object");
    if (Object.getOwnPropertySymbols(object).length !== 0) throw new TypeError("canonical JSON не допускает symbol keys");
    if (stack.has(object)) throw new TypeError("canonical JSON не допускает циклические значения");
    stack.add(object);
    const sorted = Object.create(null) as {[key: string]: JsonValue};
    for (const key of Object.keys(object).sort()) sorted[key] = canonicalize(object[key] as JsonValue, stack);
    stack.delete(object);
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical JSON допускает только конечные числа");
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError("canonical JSON не допускает это значение");
  }
  return value;
}

/** Compact JSON with recursively lexicographic object keys. Arrays keep their order. */
export function canonicalJson(value: JsonValue): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new TypeError("значение нельзя представить canonical JSON");
  return encoded;
}

export function canonicalRequestHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export interface IdempotencyStore<Response extends IdempotencyResponse = IdempotencyResponse> {
  acquire(transaction: Transaction, identity: IdempotencyKey, requestHash: string, leaseOwner: string, nowMs: number, leaseMs: number, retentionMs: number): Promise<AcquireResult<Response>>;
  complete(transaction: Transaction, identity: IdempotencyKey, leaseOwner: string, response: Response): Promise<void>;
  get(transaction: Transaction, identity: IdempotencyKey): Promise<IdempotencyRecord<Response> | undefined>;
}

type IdempotencyRow = Readonly<{
  actor_ref: unknown;
  scope: unknown;
  idempotency_key: unknown;
  request_hash: unknown;
  state: unknown;
  lease_owner: unknown;
  lease_until_ms: unknown;
  expires_at_ms: unknown;
  response_status: unknown;
  response_body: unknown;
  resource_ref: unknown;
}>;

function numberValue(value: unknown, field: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result)) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", `некорректное поле idempotency: ${field}`);
  return result;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", `некорректное поле idempotency: ${field}`);
  return value;
}

function bodyValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  return value as JsonValue;
}

function rowRecord<Response extends IdempotencyResponse>(row: IdempotencyRow): IdempotencyRecord<Response> {
  const identity = {actorRef: stringValue(row.actor_ref, "actor_ref"), scope: stringValue(row.scope, "scope"), key: stringValue(row.idempotency_key, "idempotency_key")};
  const state = String(row.state);
  if (state !== "Acquired" && state !== "Completed") throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "неизвестное состояние idempotency");
  const requestHash = stringValue(row.request_hash, "request_hash");
  if (!/^[0-9a-f]{64}$/.test(requestHash)) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректный request_hash");
  const leaseOwner = stringValue(row.lease_owner, "lease_owner");
  const base = {
    identity,
    requestHash,
    state,
    leaseOwner,
    leaseUntilMs: numberValue(row.lease_until_ms, "lease_until"),
    expiresAtMs: numberValue(row.expires_at_ms, "expires_at"),
  } as IdempotencyRecord<Response>;
  if (state === "Acquired" && (row.response_status === null || row.response_status === undefined)) return base;
  if (row.response_status === null || row.response_status === undefined) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "Completed record не содержит response_status");
  const body = bodyValue(row.response_body);
  if (body === undefined) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "Completed record не содержит response_body");
  const response = {status: numberValue(row.response_status, "response_status"), body};
  validateResponse(response);
  if (row.resource_ref !== null && row.resource_ref !== undefined && typeof row.resource_ref !== "string") {
    throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "resource_ref не является строкой");
  }
  return {...base, response: {...response, ...(row.resource_ref === null || row.resource_ref === undefined ? {} : {resourceRef: row.resource_ref})} as Response};
}

const rowProjection = `actor_ref, scope, idempotency_key, request_hash, state, lease_owner,
  CASE WHEN isfinite(lease_until) THEN round(extract(epoch from lease_until) * 1000)::text ELSE 'invalid' END AS lease_until_ms,
  CASE WHEN isfinite(expires_at) THEN round(extract(epoch from expires_at) * 1000)::text ELSE 'invalid' END AS expires_at_ms,
  response_status, response_body, resource_ref`;

export type IdempotencyStoreOptions = Readonly<{
  schema?: string;
  table?: string;
}>;

export class SqlIdempotencyStore<Response extends IdempotencyResponse = IdempotencyResponse> implements IdempotencyStore<Response> {
  private readonly permits = new WeakMap<Transaction, Map<string, string>>();
  private readonly insert: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{idempotency_key: string}>>>;
  private readonly read: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<IdempotencyRow>>;
  private readonly readForUpdate: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<IdempotencyRow>>;
  private readonly markCompleted: (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<Readonly<{idempotency_key: string}>>>;

  public constructor(database: Database, tableOrOptions: string | IdempotencyStoreOptions = {}) {
    const table = typeof tableOrOptions === "string" ? tableOrOptions : tableOrOptions.table ?? "idempotency_records";
    const schema = typeof tableOrOptions === "string" ? "public" : tableOrOptions.schema ?? "public";
    const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
    this.insert = defineStatement(database, `INSERT INTO ${qualifiedTable}
      (actor_ref, scope, idempotency_key, request_hash, state, lease_owner, lease_until, created_at, expires_at)
      VALUES ($1, $2, $3, $4, 'Acquired', $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
      ON CONFLICT (actor_ref, scope, idempotency_key) DO NOTHING
      RETURNING idempotency_key`);
    this.read = defineStatement(database, `SELECT ${rowProjection} FROM ${qualifiedTable}
      WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`);
    this.readForUpdate = defineStatement(database, `SELECT ${rowProjection} FROM ${qualifiedTable}
      WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE`);
    this.markCompleted = defineStatement(database, `UPDATE ${qualifiedTable}
      SET state = 'Completed', response_status = $5, response_body = $6::jsonb, resource_ref = $7, completed_at = clock_timestamp()
      WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3 AND lease_owner = $4 AND state = 'Acquired'
        AND lease_until > clock_timestamp()
      RETURNING idempotency_key`);
  }

  public async acquire(transaction: Transaction, identity: IdempotencyKey, requestHash: string, leaseOwner: string, nowMs: number, leaseMs: number, retentionMs: number): Promise<AcquireResult<Response>> {
    validateIdentity(identity, requestHash, leaseOwner);
    validateWindow(nowMs, leaseMs, retentionMs);
    const inserted = await this.insert(transaction, [identity.actorRef, identity.scope, identity.key, requestHash, leaseOwner, nowMs + leaseMs, nowMs, nowMs + retentionMs]);
    const result = await this.readForUpdate(transaction, [identity.actorRef, identity.scope, identity.key]);
    const row = result.rows[0];
    if (row === undefined) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "acquire не вернул idempotency record");
    const record = rowRecord<Response>(row);
    if (record.requestHash !== requestHash) return {kind: "conflict", reason: "request_hash_mismatch"};
    if (record.state === "Completed" && record.response !== undefined) return {kind: "replay", response: record.response};
    if (inserted.rowCount === 1) {
      let transactionPermits = this.permits.get(transaction);
      if (transactionPermits === undefined) {
        transactionPermits = new Map();
        this.permits.set(transaction, transactionPermits);
      }
      transactionPermits.set(`${identity.actorRef}\u0000${identity.scope}\u0000${identity.key}`, leaseOwner);
      return {kind: "acquired", record};
    }
    // Expired Acquired records stay InProgress: unknown outcome is reconciled by owner truth.
    return {kind: "in_progress", leaseUntilMs: record.leaseUntilMs};
  }

  public async complete(transaction: Transaction, identity: IdempotencyKey, leaseOwner: string, response: Response): Promise<void> {
    if (!identity.actorRef || !identity.scope || !identity.key || !leaseOwner) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректная idempotency identity");
    validateResponse(response);
    const mapKey = `${identity.actorRef}\u0000${identity.scope}\u0000${identity.key}`;
    if (this.permits.get(transaction)?.get(mapKey) !== leaseOwner) throw new IdempotencyError("IDEMPOTENCY_NOT_ACQUIRED", "idempotency permit принадлежит другой transaction");
    let body: string;
    try { body = canonicalJson(response.body); } catch { throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "response body не является JSON"); }
    const result = await this.markCompleted(transaction, [identity.actorRef, identity.scope, identity.key, leaseOwner, response.status, body, response.resourceRef ?? null]);
    if (result.rowCount !== 1) throw new IdempotencyError("IDEMPOTENCY_NOT_ACQUIRED", "idempotency lease не принадлежит вызывающему или истёк");
    this.permits.get(transaction)?.delete(mapKey);
  }

  public async get(transaction: Transaction, identity: IdempotencyKey): Promise<IdempotencyRecord<Response> | undefined> {
    if (!identity.actorRef || !identity.scope || !identity.key) throw new IdempotencyError("IDEMPOTENCY_RECORD_INVALID", "некорректная idempotency identity");
    const result = await this.read(transaction, [identity.actorRef, identity.scope, identity.key]);
    const row = result.rows[0];
    return row === undefined ? undefined : rowRecord<Response>(row);
  }
}

export function createSqlIdempotencyStore<Response extends IdempotencyResponse = IdempotencyResponse>(database: Database, options: string | IdempotencyStoreOptions = {}): SqlIdempotencyStore<Response> {
  return new SqlIdempotencyStore<Response>(database, options);
}
