export type SqlScalar = string | number | bigint | boolean | Uint8Array | null;
export type QueryResult<Row> = Readonly<{rows: readonly Row[]; rowCount: number}>;

export interface DatabaseConnection {
  query<Row>(text: string, values?: readonly SqlScalar[]): Promise<QueryResult<Row>>;
  release(error?: Error): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseConnection>;
}

export type TransactionOptions = Readonly<{
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  idleInTransactionSessionTimeoutMs: number;
}>;

export class DatabaseTransactionError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseTransactionError";
  }
}

function timeoutSql(name: string, milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new DatabaseTransactionError(`${name} должен быть неотрицательным целым числом`);
  return `SET LOCAL ${name} = '${milliseconds}ms'`;
}

export async function withTransaction<Result>(
  pool: DatabasePool,
  options: TransactionOptions,
  callback: (connection: DatabaseConnection) => Promise<Result>,
): Promise<Result> {
  const connection = await pool.connect();
  let began = false;
  try {
    await connection.query("BEGIN");
    began = true;
    await connection.query(timeoutSql("lock_timeout", options.lockTimeoutMs));
    await connection.query(timeoutSql("statement_timeout", options.statementTimeoutMs));
    await connection.query(timeoutSql("idle_in_transaction_session_timeout", options.idleInTransactionSessionTimeoutMs));
    const result = await callback(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      try { await connection.query("ROLLBACK"); } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : "неизвестная ошибка rollback";
        throw new DatabaseTransactionError(`rollback не выполнен: ${detail}`, {cause: error});
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) throw new DatabaseTransactionError("недопустимый SQL identifier");
  return `"${identifier}"`;
}

export function assertOwnedDatabase(database: string, allowedDatabase: string): void {
  if (database !== allowedDatabase) throw new DatabaseTransactionError(`database ownership violation: ${database}`);
}
