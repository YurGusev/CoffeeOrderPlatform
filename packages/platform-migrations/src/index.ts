import {createHash} from "node:crypto";

export type Migration = Readonly<{
  id: string;
  checksum: string;
  sql: string;
}>;

export type AppliedMigration = Readonly<{
  id: string;
  checksum: string;
}>;

export interface MigrationStore {
  readApplied(): Promise<readonly AppliedMigration[]>;
  apply(migration: Migration): Promise<void>;
}

export class MigrationError extends Error {
  public readonly migrationId: string | undefined;

  public constructor(message: string, migrationId?: string) {
    super(message);
    this.name = "MigrationError";
    this.migrationId = migrationId;
  }
}

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

function migrationNumber(id: string): number {
  if (!/^\d{4}_[a-z][a-z0-9_]*$/.test(id)) throw new MigrationError(`некорректный migration id: ${id}`);
  return Number(id.slice(0, 4));
}

export function validateMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const ids = new Set<string>();
  let previous = -1;
  for (const migration of migrations) {
    const number = migrationNumber(migration.id);
    if (number <= previous) throw new MigrationError("migrations должны быть отсортированы по id", migration.id);
    if (ids.has(migration.id)) throw new MigrationError("migration id повторяется", migration.id);
    if (migrationChecksum(migration.sql) !== migration.checksum) throw new MigrationError("checksum migration не совпадает", migration.id);
    ids.add(migration.id);
    previous = number;
  }
  return migrations;
}

export async function applyMigrations(store: MigrationStore, migrations: readonly Migration[]): Promise<readonly string[]> {
  const ordered = validateMigrations(migrations);
  const applied = await store.readApplied();
  const appliedById = new Map(applied.map((migration) => [migration.id, migration.checksum]));
  const appliedIds: string[] = [];
  for (const migration of ordered) {
    const knownChecksum = appliedById.get(migration.id);
    if (knownChecksum !== undefined) {
      if (knownChecksum !== migration.checksum) throw new MigrationError("применённая migration изменилась", migration.id);
      continue;
    }
    await store.apply(migration);
    appliedIds.push(migration.id);
  }
  return appliedIds;
}
