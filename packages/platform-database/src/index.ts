import pg from "pg";
import type {DatabasePoolConfig} from "@coffee-platform/config";
import {bounded, databases, transactions, track, trackLease, type DatabaseData, type Lease, type TransactionData, type Waiter} from "./internal.js";

export type SqlScalar = string | number | bigint | boolean | Uint8Array | null;
export type QueryResult<Row> = Readonly<{rows: readonly Row[]; rowCount: number}>;
export type TransactionState = "NotStarted" | "Active" | "Committing" | "Committed" | "RollingBack" | "RolledBack" | "Unknown";
export type CorrelationMetadata = Readonly<{correlationId?: string; causationId?: string; traceparent?: string}>;
export type DatabaseErrorCode = "DB_POOL_EXHAUSTED" | "DB_INVALID_CONFIGURATION" | "DB_CONNECTION_LOST" | "DB_QUERY_TIMEOUT" | "DB_QUERY_FAILED" | "DB_INTERRUPTED" | "DB_ROLLBACK_FAILED" | "TRANSACTION_OUTCOME_UNKNOWN" | "DB_INVALID_TRANSITION" | "DB_TRANSACTION_ROLLED_BACK" | "DB_STOPPED";
export class DatabaseTransactionError extends Error {
  public readonly code: DatabaseErrorCode;
  public readonly metadata: CorrelationMetadata;
  public readonly sqlState: string | undefined;
  public readonly previousCode: DatabaseErrorCode | undefined;
  public constructor(code: DatabaseErrorCode, metadata: CorrelationMetadata = {}, sqlState?: string, previousCode?: DatabaseErrorCode) {
    super(code);
    this.name = "DatabaseTransactionError";
    this.code = code;
    this.metadata = Object.freeze(Object.fromEntries(Object.entries(metadata).filter(([key, value]) => ["correlationId", "causationId", "traceparent"].includes(key) && typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value))));
    this.sqlState = sqlState;
    this.previousCode = previousCode;
  }
}

declare const databaseBrand: unique symbol;
declare const transactionBrand: unique symbol;
export type Transaction = Readonly<{[transactionBrand]: true; state: () => TransactionState}>;
export type Database = Readonly<{
  [databaseBrand]: true;
  resource: Readonly<{name: string; start: (signal: AbortSignal) => Promise<void>; stop: (signal: AbortSignal) => Promise<void>; destroy: () => void}>;
  readiness: Readonly<{name: string; check: (signal: AbortSignal) => Promise<boolean>}>;
  metrics: () => Readonly<{active: number; idle: number; waiting: number; saturationTotal: number; pending: number}>;
}>;
export type DatabaseOptions = Readonly<{
  owner: string; database: string; allowedDatabase: string; host: string; port: number;
  user: string; password: string; ssl?: boolean | "prefer";
  pool: DatabasePoolConfig; shutdownGraceMs: number;
}>;
export type TransactionOptions = CorrelationMetadata & Readonly<{mode: "interactive" | "background"; signal?: AbortSignal}>;

function requireDatabase(database: Database): DatabaseData {
  const data = databases.get(database);
  if (!data) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  return data;
}
function release(data: DatabaseData, lease: Lease, destroy = false): void {
  if (lease.released) return;
  lease.released = true;
  lease.client.removeListener("error", lease.onError);
  lease.client.release(destroy || lease.broken || lease.pending > 0);
  data.leases.delete(lease);
  dispatchWaiters(data);
}
export function databaseFailure(error: unknown, metadata: CorrelationMetadata): DatabaseTransactionError {
  if (error instanceof DatabaseTransactionError) return error;
  const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (["57014", "55P03"].includes(code)) return new DatabaseTransactionError("DB_QUERY_TIMEOUT", metadata, code);
  if (/^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08") && !["57P01", "57P02", "57P03"].includes(code)) return new DatabaseTransactionError("DB_QUERY_FAILED", metadata, code);
  return new DatabaseTransactionError("DB_CONNECTION_LOST", metadata);
}
async function acquire(data: DatabaseData, metadata: CorrelationMetadata, signal?: AbortSignal): Promise<Lease> {
  if (data.shutdown.signal.aborted) throw new DatabaseTransactionError("DB_STOPPED", metadata);
  if (signal?.aborted) throw new DatabaseTransactionError("DB_INTERRUPTED", metadata);
  const rejectWaiter = (waiter: Waiter, error: Error): void => {
    const index = data.waiters.indexOf(waiter);
    if (index !== -1) data.waiters.splice(index, 1);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    data.shutdown.signal.removeEventListener("abort", waiter.shutdownAbort);
    waiter.reject(error);
  };
  if (data.leases.size + data.acquiring >= data.config.max || data.waiters.length > 0) {
    if (!data.config.maxWaiting || data.waiters.length >= data.config.maxWaiting) {
      data.saturated++;
      throw new DatabaseTransactionError("DB_POOL_EXHAUSTED", metadata);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject, ...(signal ? {signal} : {}),
        abort: () => {
          if (signal?.reason instanceof Error && signal.reason.name === "TimeoutError") data.saturated++;
          rejectWaiter(waiter, new DatabaseTransactionError("DB_INTERRUPTED", metadata));
        },
        shutdownAbort: () => rejectWaiter(waiter, new DatabaseTransactionError("DB_STOPPED", metadata)),
      };
      data.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, {once: true});
      data.shutdown.signal.addEventListener("abort", waiter.shutdownAbort, {once: true});
      if (signal?.aborted) waiter.abort();
      else if (data.shutdown.signal.aborted) waiter.shutdownAbort();
    });
  } else data.acquiring++;
  if (data.shutdown.signal.aborted || signal?.aborted) {
    data.acquiring--;
    dispatchWaiters(data);
    throw new DatabaseTransactionError(data.shutdown.signal.aborted ? "DB_STOPPED" : "DB_INTERRUPTED", metadata);
  }
  let expired = false;
  let acquired: Lease | undefined;
  const connection = track(data, data.pool.connect().catch((error: unknown) => {
    // Единственный fallback — отказ SSL negotiation ДО authentication/BEGIN.
    // Ошибки сертификата, запросов и неизвестного COMMIT не повторяются.
    if (!expired && !signal?.aborted && !data.shutdown.signal.aborted && data.preferSsl && error instanceof Error && error.message === "The server does not support SSL connections") {
      data.pool.options.ssl = false;
      return data.pool.connect();
    }
    throw error;
  }).then(client => {
    if (expired || data.shutdown.signal.aborted) { client.release(true); throw new DatabaseTransactionError("DB_STOPPED", metadata); }
    const lease: Lease = {client, released: false, broken: false, pending: 0, onError: () => {lease.broken = true; data.healthy = false;}};
    client.on("error", lease.onError);
    data.leases.add(lease);
    acquired = lease;
    return lease;
  }).finally(() => {data.acquiring--; dispatchWaiters(data);}));
  try {
    return await bounded(connection, data.config.checkoutTimeoutMs, () => {
      if (data.shutdown.signal.aborted) return new DatabaseTransactionError("DB_STOPPED", metadata);
      if (signal?.aborted) return new DatabaseTransactionError("DB_INTERRUPTED", metadata);
      data.saturated++;
      return new DatabaseTransactionError("DB_POOL_EXHAUSTED", metadata);
    },
      AbortSignal.any([data.shutdown.signal, ...(signal ? [signal] : [])]));
  } catch (error) {
    expired = true;
    if (acquired) release(data, acquired, true);
    if (!(error instanceof DatabaseTransactionError)) data.healthy = false;
    throw databaseFailure(error, metadata);
  }
}
function dispatchWaiters(data: DatabaseData): void {
  if (data.shutdown.signal.aborted) return;
  while (data.waiters.length > 0 && data.leases.size + data.acquiring < data.config.max) {
    const waiter = data.waiters.shift()!;
    waiter.signal?.removeEventListener("abort", waiter.abort);
    data.shutdown.signal.removeEventListener("abort", waiter.shutdownAbort);
    data.acquiring++;
    waiter.resolve();
  }
}
async function command(data: DatabaseData, lease: Lease, sql: string, ms: number, metadata: CorrelationMetadata, signal?: AbortSignal): Promise<pg.QueryResult> {
  if (signal?.aborted) throw new DatabaseTransactionError("DB_INTERRUPTED", metadata);
  try {
    return await bounded(trackLease(data, lease, lease.client.query(sql)), ms, () => new DatabaseTransactionError(signal?.aborted ? "DB_INTERRUPTED" : "DB_QUERY_TIMEOUT", metadata), signal);
  } catch (error) {throw databaseFailure(error, metadata);}
}

export function createDatabase(options: DatabaseOptions): Database {
  if ([options.owner, options.database, options.allowedDatabase, options.host, options.user, options.password].some(value => typeof value !== "string" || value.length === 0) ||
    !Number.isSafeInteger(options.shutdownGraceMs) || options.shutdownGraceMs <= 0 ||
    (options.ssl !== undefined && options.ssl !== true && options.ssl !== false && options.ssl !== "prefer")) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  assertOwnedDatabase(options.database, options.allowedDatabase);
  const c = options.pool;
  if (!c) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535 ||
    (c.maxWaiting !== undefined && (!Number.isSafeInteger(c.maxWaiting) || c.maxWaiting < 0 || c.maxWaiting > 100)) ||
    [c.max, c.checkoutTimeoutMs, c.lockTimeoutMs, c.interactiveStatementTimeoutMs, c.backgroundStatementTimeoutMs, c.terminalTimeoutMs, c.transactionTimeoutMs, c.idleTimeoutMs, c.maxLifetimeMs].some(value => !Number.isSafeInteger(value) || value <= 0) ||
    c.checkoutTimeoutMs + c.transactionTimeoutMs + c.terminalTimeoutMs * 2 >= options.shutdownGraceMs) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  const pool = new pg.Pool({host: options.host, port: options.port, database: options.database, user: options.user, password: options.password,
    ssl: options.ssl === "prefer" ? true : options.ssl ?? false, max: c.max, connectionTimeoutMillis: c.checkoutTimeoutMs, idleTimeoutMillis: c.idleTimeoutMs,
    maxLifetimeSeconds: c.maxLifetimeMs / 1000, application_name: options.owner});
  const data: DatabaseData = {pool, config: c, preferSsl: options.ssl === "prefer", shutdown: new AbortController(), leases: new Set(), pending: new Set(), healthy: false, saturated: 0, acquiring: 0, waiters: []};
  pool.on("error", () => {data.healthy = false;});
  const health = async (signal: AbortSignal): Promise<boolean> => {
    if (data.shutdown.signal.aborted) return false;
    if (data.waiters.length > 0 || data.leases.size + data.acquiring >= c.max) return data.healthy;
    let lease: Lease | undefined;
    try {
      lease = await acquire(data, {}, signal);
      await command(data, lease, "SELECT 1", c.terminalTimeoutMs, {}, signal);
      data.healthy = true;
      return true;
    } catch (error) {
      if (error instanceof DatabaseTransactionError && error.code === "DB_POOL_EXHAUSTED") return data.healthy;
      data.healthy = false;
      if (lease) lease.broken = true;
      return false;
    } finally { if (lease) release(data, lease); }
  };
  const destroy = (): void => {
    data.shutdown.abort();
    for (const lease of data.leases) release(data, lease, true);
    data.ending ??= pool.end();
    void data.ending.catch(() => {data.healthy = false;});
  };
  const database = Object.freeze({
    resource: {name: "database", start: async (signal: AbortSignal): Promise<void> => { await health(signal); },
      stop: async (_signal: AbortSignal): Promise<void> => {
        data.shutdown.abort();
        // Произвольный callback Promise не отменяем. Незавершённый ресурс увидит #61 и эскалирует fail-stop.
        while (data.pending.size > 0) await Promise.allSettled(data.pending);
        data.ending ??= pool.end();
        await data.ending;
      }, destroy},
    readiness: {name: "database", check: health},
    metrics: () => ({active: data.leases.size, idle: pool.idleCount, waiting: data.waiters.length, saturationTotal: data.saturated, pending: data.pending.size}),
  }) as Database;
  databases.set(database, data);
  return database;
}

export async function withTransaction<Result>(database: Database, options: TransactionOptions, callback: (transaction: Transaction) => Promise<Result>): Promise<Result> {
  const data = requireDatabase(database);
  const metadata: CorrelationMetadata = {
    ...(options.correlationId === undefined ? {} : {correlationId: options.correlationId}),
    ...(options.causationId === undefined ? {} : {causationId: options.causationId}),
    ...(options.traceparent === undefined ? {} : {traceparent: options.traceparent}),
  };
  if (!["interactive", "background"].includes(options.mode)) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION", metadata);
  const signal = AbortSignal.any([data.shutdown.signal, AbortSignal.timeout(data.config.transactionTimeoutMs), ...(options.signal ? [options.signal] : [])]);
  const lease = await acquire(data, metadata, signal);
  const state: TransactionData = {database, lease, state: "NotStarted", signal, metadata, pending: 0};
  const transaction = Object.freeze({state: () => state.state}) as Transaction;
  transactions.set(transaction, state);
  let began = false;
  let destroy = false;
  try {
    began = true; // BEGIN мог достигнуть сервера даже если ответ потерян.
    await command(data, lease, "BEGIN", data.config.terminalTimeoutMs, metadata, signal);
    state.state = "Active";
    const statementMs = options.mode === "interactive" ? data.config.interactiveStatementTimeoutMs : data.config.backgroundStatementTimeoutMs;
    for (const [name, value] of [["lock_timeout", data.config.lockTimeoutMs], ["statement_timeout", statementMs], ["idle_in_transaction_session_timeout", data.config.idleTimeoutMs]] as const) {
      await command(data, lease, `SET LOCAL ${name} = '${value}ms'`, data.config.terminalTimeoutMs, metadata, signal);
    }
    const result = await bounded(track(data, Promise.resolve().then(() => {
      if (signal.aborted) throw new DatabaseTransactionError("DB_INTERRUPTED", metadata);
      return callback(transaction);
    })), data.config.transactionTimeoutMs,
      () => new DatabaseTransactionError(signal.aborted ? "DB_INTERRUPTED" : "DB_QUERY_TIMEOUT", metadata), signal);
    if (signal.aborted) throw new DatabaseTransactionError("DB_INTERRUPTED", metadata);
    if (state.pending !== 0) throw new DatabaseTransactionError("DB_INVALID_TRANSITION", metadata);
    state.state = "Committing";
    let reply: pg.QueryResult;
    try {
      // Client disconnect/shutdown после начала COMMIT не доказывает rollback.
      reply = await command(data, lease, "COMMIT", data.config.terminalTimeoutMs, metadata);
    } catch {
      state.state = "Unknown";
      destroy = true;
      throw new DatabaseTransactionError("TRANSACTION_OUTCOME_UNKNOWN", metadata);
    }
    if (reply.command === "ROLLBACK") {
      state.state = "RolledBack";
      throw new DatabaseTransactionError("DB_TRANSACTION_ROLLED_BACK", metadata);
    }
    if (reply.command !== "COMMIT") {
      state.state = "Unknown";
      destroy = true;
      throw new DatabaseTransactionError("TRANSACTION_OUTCOME_UNKNOWN", metadata);
    }
    state.state = "Committed";
    return result;
  } catch (error) {
    if (began && ["NotStarted", "Active"].includes(state.state)) {
      state.state = "RollingBack";
      try {
        const reply = await command(data, lease, "ROLLBACK", data.config.terminalTimeoutMs, metadata);
        if (reply.command !== "ROLLBACK") throw new Error("rollback tag");
        state.state = "RolledBack";
      } catch {
        state.state = "Unknown";
        destroy = true;
        throw new DatabaseTransactionError("DB_ROLLBACK_FAILED", metadata, undefined, error instanceof DatabaseTransactionError ? error.code : "DB_QUERY_FAILED");
      }
    }
    const failure = error;
    if (failure instanceof DatabaseTransactionError && failure.code === "DB_CONNECTION_LOST") {destroy = true; data.healthy = false;}
    throw failure;
  } finally { release(data, lease, destroy); }
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  return `"${identifier}"`;
}
export function assertOwnedDatabase(database: string, allowedDatabase: string): void {
  if (database !== allowedDatabase) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
}
