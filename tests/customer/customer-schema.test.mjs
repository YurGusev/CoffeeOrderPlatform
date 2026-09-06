import assert from "node:assert/strict";
import {readdir, readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {Client} from "pg";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {applyMigrations, migrationChecksum} from "../../packages/platform-migrations/dist/index.js";
import {CUSTOMER_DATABASE_URL, blocker, liveDatabase} from "./fixtures/customer-testkit.mjs";

const MIGRATIONS = new URL("../../apps/customer-service/migrations/", import.meta.url);

async function loadCustomerMigrations() {
  let names;
  try {
    names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(new URL(name, MIGRATIONS), "utf8");
    return {id: name.slice(0, -4), sql, checksum: migrationChecksum(sql)};
  }));
}

async function snapshot(client) {
  const columns = await client.query(
    `SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'customer'
        AND table_name IN ('customers', 'addresses', 'channel_links', 'idempotency_records', 'audit_log')
      ORDER BY table_name, ordinal_position`,
  );
  const constraints = await client.query(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname, c.contype, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'customer'
      ORDER BY table_name, c.conname`,
  );
  const indexes = await client.query(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'customer'
      ORDER BY tablename, indexname`,
  );
  const grants = await client.query(
    `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'customer' AND grantee = 'coffee_customer_rw'
      ORDER BY table_name, privilege_type`,
  );
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    grants: grants.rows,
  };
}

function assertRequiredColumns(assertion, rows, expected) {
  const byTable = new Map();
  for (const row of rows) {
    const list = byTable.get(row.table_name) ?? [];
    list.push(row.column_name);
    byTable.set(row.table_name, list);
  }
  for (const [table, columns] of Object.entries(expected)) {
    assertion.deepEqual([...(byTable.get(table) ?? [])].sort((left, right) => left.localeCompare(right)), [...columns].sort((left, right) => left.localeCompare(right)), `${table} columns changed`);
  }
}

void test("Customer migrations are repeatable and create the exact owner schema", async (t) => {
  const migrations = await loadCustomerMigrations();
  if (migrations.length === 0) {
    blocker(t, "customer-service migrations are not present");
    return;
  }
  const url = process.env.CUSTOMER_MIGRATOR_DATABASE_URL;
  if (!url) {
    blocker(t, "CUSTOMER_MIGRATOR_DATABASE_URL is missing; migration checks require the real migrator role");
    return;
  }
  const client = await liveDatabase(t, url);
  if (!client) return;
  const identity = await client.query("SELECT current_database(), current_user, current_setting('server_version') AS server_version");
  assert.equal(identity.rows[0].current_database, new URL(url).pathname.slice(1));
  assert.match(identity.rows[0].server_version, /^17\.11(?:\s|$)/);

  const parsed = new URL(url);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  const database = createDatabase({
    owner: "customer-test-migrations",
    database: databaseName,
    allowedDatabase: databaseName,
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: process.env.CUSTOMER_MIGRATOR_SSL === "false" ? false : "prefer",
    pool: {max: 2, checkoutTimeoutMs: 250, lockTimeoutMs: 250, interactiveStatementTimeoutMs: 1_500, backgroundStatementTimeoutMs: 5_000, terminalTimeoutMs: 2_000, transactionTimeoutMs: 10_000, idleTimeoutMs: 30_000, maxLifetimeMs: 1_800_000},
    shutdownGraceMs: 30_000,
  });
  t.after(async () => database.resource.stop(new AbortController().signal));

  const firstRun = await applyMigrations(database, migrations, {schema: "customer"});
  assert.ok(firstRun.length === 0 || firstRun.length === migrations.length);
  const before = await snapshot(client);
  const secondRun = await applyMigrations(database, migrations, {schema: "customer"});
  const after = await snapshot(client);
  assert.deepEqual(secondRun, []);
  assert.deepEqual(after, before);

  assertRequiredColumns(assert, after.columns, {
    customers: ["customer_ref", "version", "display_name", "display_name_search", "phone_e164", "email_normalized", "status", "created_at", "updated_at", "created_by_actor_ref", "updated_by_actor_ref"],
    addresses: ["address_ref", "customer_ref", "kind", "line1", "line2", "city", "postal_code", "country_code", "version", "is_active", "created_at", "updated_at", "created_by_actor_ref", "updated_by_actor_ref"],
    channel_links: ["channel_link_ref", "customer_ref", "provider", "external_subject_hash", "status", "created_at", "updated_at", "created_by_actor_ref", "updated_by_actor_ref"],
    idempotency_records: ["actor_ref", "scope", "idempotency_key", "request_hash", "state", "lease_owner", "lease_until", "response_status", "response_body", "resource_ref", "created_at", "expires_at", "completed_at"],
    audit_log: ["audit_ref", "customer_ref", "operation", "actor_ref", "correlation_id", "occurred_at", "before_hash", "after_hash"],
  });
  const definitions = after.constraints.map((row) => row.definition).join("\n");
  assert.match(definitions, /phone_e164 IS NOT NULL OR email_normalized IS NOT NULL/i);
  assert.match(definitions, /status.*Active/i);
  assert.match(definitions, /kind.*Delivery/i);
  assert.match(definitions, /provider.*Web.*VK/i);
  assert.match(definitions, /external_subject_hash/i);
  assert.match(after.indexes.map((row) => row.indexdef).join("\n"), /UNIQUE.*phone_e164/i);
  assert.match(after.indexes.map((row) => row.indexdef).join("\n"), /UNIQUE.*email_normalized/i);
  assert.match(after.indexes.map((row) => row.indexdef).join("\n"), /display_name_search.*text_pattern_ops/i);
  assert.ok(after.grants.some((row) => row.table_name === "customers" && row.privilege_type === "SELECT"));
  assert.ok(after.grants.some((row) => row.table_name === "customers" && row.privilege_type === "INSERT"));
  assert.equal(migrations.every((migration) => migration.checksum === migrationChecksum(migration.sql)), true);
});

void test("coffee_customer_rw has owner-local DML only and cannot run DDL", async (t) => {
  const client = await liveDatabase(t, process.env.CUSTOMER_RUNTIME_DATABASE_URL ?? CUSTOMER_DATABASE_URL);
  if (!client) return;
  const identity = await client.query("SELECT current_database(), current_user");
  assert.match(identity.rows[0].current_user, /^coffee_customer_rw$/);
  const visible = await client.query("SELECT count(*)::integer AS count FROM customer.customers");
  assert.ok(Number.isInteger(Number(visible.rows[0].count)));

  const table = `customer_permission_probe_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await client.query(`CREATE TABLE customer.${table} (probe_id integer PRIMARY KEY)`);
    created = true;
  } catch (error) {
    assert.equal(error.code, "42501");
  }
  if (created) {
    await client.query(`DROP TABLE customer.${table}`);
    assert.fail("coffee_customer_rw unexpectedly executed DDL");
  }
});

void test("coffee_customer_rw cannot connect to a foreign owner database", async (t) => {
  const url = process.env.CUSTOMER_FOREIGN_DATABASE_URL;
  if (!url) {
    blocker(t, "CUSTOMER_FOREIGN_DATABASE_URL is missing; cross-owner permission proof needs the real foreign target");
    return;
  }
  const client = new Client(url);
  try {
    await assert.rejects(
      client.connect(),
      (error) => error?.code === "42501" || error?.code === "3D000",
    );
  } finally {
    await client.end().catch(() => {});
  }
});
