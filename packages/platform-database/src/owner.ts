import {pipeline} from "node:stream/promises";
import type {Readable} from "node:stream";
import {from as copyFrom} from "pg-copy-streams";
import {DatabaseTransactionError, databaseFailure, quoteIdentifier, type Database, type Transaction, type SqlScalar, type QueryResult} from "./index.js";
import {bounded, databases, transactions, trackLease, type TransactionData, type DatabaseData} from "./internal.js";

export type OwnerStatement<Row, Parameters extends readonly SqlScalar[]> = (transaction: Transaction, parameters: Parameters) => Promise<QueryResult<Row>>;
function context(database: Database, transaction: Transaction): [TransactionData, DatabaseData] {
  const tx = transactions.get(transaction);
  const data = databases.get(database);
  if (!tx || !data || tx.database !== database || tx.state !== "Active" || tx.lease.released) throw new DatabaseTransactionError("DB_INVALID_TRANSITION", tx?.metadata);
  if (tx.signal.aborted) throw new DatabaseTransactionError("DB_INTERRUPTED", tx.metadata);
  return [tx, data];
}
async function execute<Row>(database: Database, transaction: Transaction, sql: string, parameters: readonly SqlScalar[], migration = false): Promise<QueryResult<Row>> {
  const [tx, data] = context(database, transaction);
  tx.pending++;
  try {
    const result = await bounded(trackLease(data, tx.lease, tx.lease.client.query({text: sql, values: [...parameters], ...(migration ? {} : {queryMode: "extended"})})), data.config.transactionTimeoutMs,
      () => new DatabaseTransactionError(tx.signal.aborted ? "DB_INTERRUPTED" : "DB_QUERY_TIMEOUT", tx.metadata), tx.signal);
    return {rows: result.rows as Row[], rowCount: result.rowCount ?? 0};
  } catch (error) {
    const failure = databaseFailure(error, tx.metadata);
    if (failure.code === "DB_CONNECTION_LOST") {tx.lease.broken = true; data.healthy = false;}
    throw failure;
  } finally { tx.pending--; }
}

// Import этого entrypoint разрешён только owner adapters/repositories и foundation,
// не handlers/application: SQL фиксируется до обработки пользовательского command.
export function defineStatement<Row, Parameters extends readonly SqlScalar[]>(database: Database, sql: string): OwnerStatement<Row, Parameters> {
  if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  return (transaction, parameters) => execute<Row>(database, transaction, sql, parameters);
}

export type OwnerCopy = (transaction: Transaction, source: Readable) => Promise<void>;
export function defineCopy(database: Database, table: string, columns: readonly string[], schema = "public"): OwnerCopy {
  if (columns.length === 0) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  const sql = `COPY ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) FROM STDIN`;
  return async (transaction, source): Promise<void> => {
    const [tx, data] = context(database, transaction);
    tx.pending++;
    const abort = new AbortController();
    const signal = AbortSignal.any([tx.signal, abort.signal]);
    const timer = setTimeout(() => abort.abort(), data.config.transactionTimeoutMs);
    try {
      const stream = tx.lease.client.query(copyFrom(sql));
      // pipeline сохраняет backpressure; AbortSignal инициирует CopyFail, не выдаёт timeout за rollback.
      await bounded(trackLease(data, tx.lease, pipeline(source, stream, {signal})), data.config.transactionTimeoutMs,
        () => new DatabaseTransactionError("DB_QUERY_TIMEOUT", tx.metadata), tx.signal);
    } catch (error) {
      const failure = tx.signal.aborted ? new DatabaseTransactionError("DB_INTERRUPTED", tx.metadata) : databaseFailure(error, tx.metadata);
      if (failure.code === "DB_CONNECTION_LOST") tx.lease.broken = true;
      throw failure;
    } finally {
      clearTimeout(timer);
      abort.abort();
      source.destroy();
      tx.pending--;
    }
  };
}

// Только checksum runner platform-migrations может импортировать эту DDL capability.
export function defineMigration(database: Database, sql: string): (transaction: Transaction) => Promise<void> {
  if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|END|PREPARE\s+TRANSACTION)\b/i.test(sql)) throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  return async transaction => {await execute(database, transaction, sql, [], true);};
}
