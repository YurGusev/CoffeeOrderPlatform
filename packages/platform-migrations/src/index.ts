import { createHash } from "node:crypto";
import { quoteIdentifier, withTransaction } from "@coffee-platform/database";
import type {
  Database,
  QueryResult,
  SqlScalar,
  Transaction,
} from "@coffee-platform/database";
import {
  defineMigration,
  defineStatement,
} from "@coffee-platform/database/owner";

export type Migration = Readonly<{
  id: string;
  checksum: string;
  sql: string;
}>;

export type AppliedMigration = Readonly<{
  id: string;
  checksum: string;
}>;

export type MigrationRunnerOptions = Readonly<{
  schema?: string;
  ledgerTable?: string;
  lockKey?: string;
}>;

export type MigrationErrorCode =
  | "MIGRATION_INVALID"
  | "MIGRATION_CHECKSUM_DRIFT"
  | "MIGRATION_ORPHAN"
  | "MIGRATION_MISSING_CHECKSUM"
  | "MIGRATION_NON_PREFIX";

export class MigrationError extends Error {
  public readonly migrationId: string | undefined;
  public readonly code: MigrationErrorCode;

  public constructor(
    message: string,
    migrationId?: string,
    code: MigrationErrorCode = "MIGRATION_INVALID",
  ) {
    super(message);
    this.name = "MigrationError";
    this.migrationId = migrationId;
    this.code = code;
  }
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migrationNumber(id: string): number {
  if (!/^\d{4}_[a-z][a-z0-9_]*$/.test(id))
    throw new MigrationError(`некорректный migration id: ${id}`);
  return Number(id.slice(0, 4));
}

export function validateMigrations(
  migrations: readonly Migration[],
): readonly Migration[] {
  const ids = new Set<string>();
  let previous = -1;
  for (const migration of migrations) {
    const number = migrationNumber(migration.id);
    if (number <= previous)
      throw new MigrationError(
        "migrations должны быть отсортированы по id",
        migration.id,
      );
    if (ids.has(migration.id))
      throw new MigrationError("migration id повторяется", migration.id);
    if (!migration.checksum || !/^[0-9a-f]{64}$/.test(migration.checksum)) {
      throw new MigrationError(
        "у migration отсутствует checksum",
        migration.id,
        "MIGRATION_MISSING_CHECKSUM",
      );
    }
    if (migrationChecksum(migration.sql) !== migration.checksum) {
      throw new MigrationError(
        "checksum migration не совпадает",
        migration.id,
        "MIGRATION_CHECKSUM_DRIFT",
      );
    }
    ids.add(migration.id);
    previous = number;
  }
  return migrations;
}

type AppliedRow = Readonly<{ id: unknown; checksum: unknown }>;

function readApplied(
  rows: readonly AppliedRow[],
  ordered: readonly Migration[],
): readonly AppliedMigration[] {
  const applied: AppliedMigration[] = [];
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const id = typeof row.id === "string" ? row.id : "";
    const checksum = typeof row.checksum === "string" ? row.checksum : "";
    if (!checksum || !/^[0-9a-f]{64}$/.test(checksum)) {
      throw new MigrationError(
        "в ledger отсутствует checksum",
        id || undefined,
        "MIGRATION_MISSING_CHECKSUM",
      );
    }
    if (!id || seen.has(id))
      throw new MigrationError(
        "ledger содержит orphan или duplicate migration",
        id || undefined,
        "MIGRATION_ORPHAN",
      );
    seen.add(id);
    const expected = ordered[index];
    if (expected === undefined)
      throw new MigrationError(
        "ledger содержит migration вне текущего набора",
        id,
        "MIGRATION_ORPHAN",
      );
    if (expected.id !== id)
      throw new MigrationError(
        "ledger migrations не образуют применённый prefix",
        id,
        "MIGRATION_NON_PREFIX",
      );
    if (expected.checksum !== checksum)
      throw new MigrationError(
        "применённая migration изменилась",
        id,
        "MIGRATION_CHECKSUM_DRIFT",
      );
    applied.push({ id, checksum });
  }
  return applied;
}

type AppliedQuery = (
  transaction: Transaction,
  parameters: readonly SqlScalar[],
) => Promise<QueryResult<AppliedRow>>;
type InsertQuery = (
  transaction: Transaction,
  parameters: readonly SqlScalar[],
) => Promise<QueryResult<Readonly<{ id: string }>>>;
type LockQuery = (
  transaction: Transaction,
  parameters: readonly SqlScalar[],
) => Promise<QueryResult<Readonly<{ pg_advisory_xact_lock: null }>>>;

/**
 * Runs owner migrations through the opaque database boundary. The ledger DDL,
 * each supplied DDL statement, and its checksum row are committed together.
 */
export async function applyMigrations(
  database: Database,
  migrations: readonly Migration[],
  options: MigrationRunnerOptions = {},
): Promise<readonly string[]> {
  const ordered = validateMigrations(migrations);
  const schema = options.schema ?? "public";
  const ledgerTable = options.ledgerTable ?? "platform_schema_migrations";
  const qualifiedTable = `${quoteIdentifier(schema)}.${quoteIdentifier(ledgerTable)}`;
  const lockKey =
    options.lockKey ?? `coffee-platform-migrations:${schema}.${ledgerTable}`;
  const advisoryLock: LockQuery = defineStatement(
    database,
    "SELECT pg_advisory_xact_lock(hashtext($1))",
  );
  const createLedger = defineMigration(
    database,
    `CREATE TABLE IF NOT EXISTS ${qualifiedTable} (
    id text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  );
  const readLedger: AppliedQuery = defineStatement(
    database,
    `SELECT id, checksum FROM ${qualifiedTable} ORDER BY id`,
  );
  const insertLedger: InsertQuery = defineStatement(
    database,
    `INSERT INTO ${qualifiedTable} (id, checksum) VALUES ($1, $2)`,
  );

  return withTransaction(
    database,
    { mode: "background" },
    async (transaction: Transaction): Promise<readonly string[]> => {
      await advisoryLock(transaction, [lockKey]);
      await createLedger(transaction);
      const applied = readApplied(
        (await readLedger(transaction, [])).rows,
        ordered,
      );
      const appliedIds = new Set(applied.map((migration) => migration.id));
      const newlyApplied: string[] = [];
      for (const migration of ordered) {
        if (appliedIds.has(migration.id)) continue;
        await defineMigration(database, migration.sql)(transaction);
        await insertLedger(transaction, [migration.id, migration.checksum]);
        newlyApplied.push(migration.id);
      }
      return newlyApplied;
    },
  );
}
