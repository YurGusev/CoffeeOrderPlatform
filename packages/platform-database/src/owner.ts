import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { from as copyFrom } from "pg-copy-streams";
import {
  DatabaseTransactionError,
  databaseFailure,
  quoteIdentifier,
  type Database,
  type Transaction,
  type SqlScalar,
  type QueryResult,
} from "./index.js";
import {
  bounded,
  databases,
  transactions,
  trackLease,
  type TransactionData,
  type DatabaseData,
} from "./internal.js";

export type OwnerStatement<Row, Parameters extends readonly SqlScalar[]> = (
  transaction: Transaction,
  parameters: Parameters,
) => Promise<QueryResult<Row>>;
function context(
  database: Database,
  transaction: Transaction,
): [TransactionData, DatabaseData] {
  const tx = transactions.get(transaction);
  const data = databases.get(database);
  if (
    !tx ||
    !data ||
    tx.database !== database ||
    tx.state !== "Active" ||
    tx.lease.released
  )
    throw new DatabaseTransactionError("DB_INVALID_TRANSITION", tx?.metadata);
  if (tx.signal.aborted)
    throw new DatabaseTransactionError("DB_INTERRUPTED", tx.metadata);
  return [tx, data];
}
async function execute<Row>(
  database: Database,
  transaction: Transaction,
  sql: string,
  parameters: readonly SqlScalar[],
  migration = false,
): Promise<QueryResult<Row>> {
  const [tx, data] = context(database, transaction);
  tx.pending++;
  try {
    const result = await bounded(
      trackLease(
        data,
        tx.lease,
        tx.lease.client.query({
          text: sql,
          values: [...parameters],
          ...(migration ? {} : { queryMode: "extended" }),
        }),
      ),
      data.config.transactionTimeoutMs,
      () =>
        new DatabaseTransactionError(
          tx.signal.aborted ? "DB_INTERRUPTED" : "DB_QUERY_TIMEOUT",
          tx.metadata,
        ),
      tx.signal,
    );
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
  } catch (error) {
    const failure = databaseFailure(error, tx.metadata);
    if (failure.code === "DB_CONNECTION_LOST") {
      tx.lease.broken = true;
      data.healthy = false;
    }
    throw failure;
  } finally {
    tx.pending--;
  }
}

// Import этого entrypoint разрешён только owner adapters/repositories и foundation,
// не handlers/application: SQL фиксируется до обработки пользовательского command.
export function defineStatement<Row, Parameters extends readonly SqlScalar[]>(
  database: Database,
  sql: string,
): OwnerStatement<Row, Parameters> {
  if (!/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql))
    throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  return (transaction, parameters) =>
    execute<Row>(database, transaction, sql, parameters);
}

export type OwnerCopy = (
  transaction: Transaction,
  source: Readable,
) => Promise<void>;
export function defineCopy(
  database: Database,
  table: string,
  columns: readonly string[],
  schema = "public",
): OwnerCopy {
  if (columns.length === 0)
    throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  const sql = `COPY ${quoteIdentifier(schema)}.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) FROM STDIN`;
  return async (transaction, source): Promise<void> => {
    const [tx, data] = context(database, transaction);
    tx.pending++;
    const abort = new AbortController();
    const signal = AbortSignal.any([tx.signal, abort.signal]);
    const timer = setTimeout(
      () => abort.abort(),
      data.config.transactionTimeoutMs,
    );
    try {
      const stream = tx.lease.client.query(copyFrom(sql));
      // pipeline сохраняет backpressure; AbortSignal инициирует CopyFail, не выдаёт timeout за rollback.
      await bounded(
        trackLease(data, tx.lease, pipeline(source, stream, { signal })),
        data.config.transactionTimeoutMs,
        () => new DatabaseTransactionError("DB_QUERY_TIMEOUT", tx.metadata),
        tx.signal,
      );
    } catch (error) {
      const failure = tx.signal.aborted
        ? new DatabaseTransactionError("DB_INTERRUPTED", tx.metadata)
        : databaseFailure(error, tx.metadata);
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

export type TemporaryColumn = Readonly<{
  name: string;
  type: "integer" | "text" | "jsonb";
  nullable?: boolean;
}>;
const TEMPORARY_COLUMN_TYPES = new Set<TemporaryColumn["type"]>([
  "integer",
  "text",
  "jsonb",
]);
export function defineTemporaryTable(
  database: Database,
  table: string,
  columns: readonly TemporaryColumn[],
): (transaction: Transaction) => Promise<void> {
  if (columns.length === 0 || !/^[a-z][a-z0-9_]{0,62}$/u.test(table))
    throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  const seen = new Set<string>();
  const definitions = columns.map((column) => {
    if (
      !/^[a-z][a-z0-9_]{0,62}$/u.test(column.name) ||
      seen.has(column.name) ||
      !TEMPORARY_COLUMN_TYPES.has(column.type)
    ) {
      throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
    }
    seen.add(column.name);
    return `${quoteIdentifier(column.name)} ${column.type}${column.nullable === true ? "" : " NOT NULL"}`;
  });
  const sql = `CREATE TEMP TABLE ${quoteIdentifier(table)} (${definitions.join(", ")}) ON COMMIT DROP`;
  return async (transaction) => {
    await execute(database, transaction, sql, [], true);
  };
}

// Только checksum runner platform-migrations может импортировать эту DDL capability.
function validateMigrationSql(sql: string): void {
  const invalid = (): never => {
    throw new DatabaseTransactionError("DB_INVALID_CONFIGURATION");
  };
  const wordStart = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z_\u0080-\uffff]/u.test(c);
  const wordPart = (c: string | undefined): boolean =>
    c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/u.test(c);
  const transactionCommand = (words: readonly string[]): boolean => {
    const [first, second] = words;
    if (
      first === "BEGIN" ||
      first === "COMMIT" ||
      first === "ROLLBACK" ||
      first === "ABORT" ||
      first === "END" ||
      first === "SAVEPOINT" ||
      first === "RELEASE"
    )
      return true;
    if ((first === "START" || first === "PREPARE") && second === "TRANSACTION")
      return true;
    return (
      first === "SET" &&
      (second === "TRANSACTION" ||
        words.slice(1, 5).join(" ") ===
          "SESSION CHARACTERISTICS AS TRANSACTION")
    );
  };
  let statementWords: string[] = [];
  let readingStatementHead = true;
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];
    if (/\s/u.test(char ?? "")) {
      i++;
      continue;
    }
    if (char === "-" && next === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth !== 0) invalid();
      continue;
    }
    if (char === ";") {
      statementWords = [];
      readingStatementHead = true;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      const escapeBackslash =
        char === "'" &&
        sql[i - 1]?.toUpperCase() === "E" &&
        !wordPart(sql[i - 2]);
      const quote = char;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escapeBackslash && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote && sql[i + 1] === quote) {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) invalid();
      readingStatementHead = false;
      continue;
    }
    if (char === "$") {
      const delimiter =
        /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/u.exec(
          sql.slice(i),
        )?.[0];
      if (delimiter !== undefined) {
        const close = sql.indexOf(delimiter, i + delimiter.length);
        if (close === -1) invalid();
        i = close + delimiter.length;
        readingStatementHead = false;
        continue;
      }
    }
    if (wordStart(char)) {
      const start = i++;
      while (wordPart(sql[i])) i++;
      if (readingStatementHead && statementWords.length < 5) {
        statementWords.push(sql.slice(start, i).toUpperCase());
        if (transactionCommand(statementWords)) invalid();
      }
      continue;
    }
    readingStatementHead = false;
    i++;
  }
}

export function defineMigration(
  database: Database,
  sql: string,
): (transaction: Transaction) => Promise<void> {
  validateMigrationSql(sql);
  return async (transaction) => {
    await execute(database, transaction, sql, [], true);
  };
}
