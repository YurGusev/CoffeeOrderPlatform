import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertBootstrapInputs,
  bootstrapDatabases,
  readJson,
  renderRoleSql,
  renderSafePlan,
  validateRoleMap,
  validateServerProbe,
} from "../../scripts/db-bootstrap.mjs";
import {
  buildSmokeCases,
  runDatabaseSmoke,
  validateSmokeTarget,
} from "../../scripts/db-smoke.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OWNERSHIP_PATH = join(ROOT, "config/database-ownership.json");
const ROLE_MAP_PATH = join(ROOT, "config/database-role-map.json");
const ADMIN_URL =
  "postgresql://bootstrap:admin-secret@coffee-postgres:5432/postgres";

const ownership = await readJson(OWNERSHIP_PATH);
const roleMap = await readJson(ROLE_MAP_PATH);
const roles = [
  ...roleMap.databases.map((database) => database.migratorRole),
  ...roleMap.databases.flatMap((database) =>
    database.runtimeRoles.map((runtime) => runtime.role),
  ),
];
const rolePasswords = Object.fromEntries(
  roles.map((role) => [role, `${role}-secret`]),
);

void test("GREEN: роль-карта совпадает с ownership и содержит точные владельцы", () => {
  assert.deepEqual(validateRoleMap(roleMap, ownership), {
    databaseCount: 5,
    migratorRoleCount: 5,
    runtimeRoleCount: 10,
  });
  const plan = renderSafePlan(roleMap);
  assert.equal(plan.length, 5);
  assert.equal(JSON.stringify(plan).includes("coffeeorderdb"), false);
  assert.equal(JSON.stringify(plan).includes("PASSWORD"), false);
});

void test("RED: bootstrap требует admin URL, точную identity и полный secret bundle", () => {
  assert.throws(
    () =>
      assertBootstrapInputs({
        roleMap,
        ownership,
        rolePasswords,
        expectedServerIdentity: "known",
      }),
    /COFFEE_DB_ADMIN_URL/,
  );
  assert.throws(
    () =>
      assertBootstrapInputs({
        adminUrl:
          "postgresql://bootstrap:admin-secret@coffee-postgres:5432/coffeeorderdb",
        roleMap,
        ownership,
        rolePasswords,
        expectedServerIdentity: "known",
      }),
    /legacy/,
  );
  assert.throws(
    () =>
      assertBootstrapInputs({
        adminUrl:
          "postgresql://bootstrap:admin-secret@coffee-postgres:5432/coffee_platform_orders",
        roleMap,
        ownership,
        rolePasswords,
        expectedServerIdentity: "known",
      }),
    /maintenance database/,
  );
  assert.throws(
    () =>
      assertBootstrapInputs({
        adminUrl: ADMIN_URL,
        roleMap,
        ownership,
        rolePasswords: {},
        expectedServerIdentity: "known",
      }),
    /missing secret/,
  );
  assert.throws(
    () =>
      assertBootstrapInputs({
        adminUrl: ADMIN_URL,
        roleMap,
        ownership,
        rolePasswords,
        expectedServerIdentity: "",
      }),
    /EXPECTED_SERVER_IDENTITY/,
  );
});

void test("GREEN/RED: server identity accepts only approved PostgreSQL 17.11 superuser", () => {
  const probe = {
    current_database: "postgres",
    current_user: "bootstrap",
    server_version: "17.11 (Debian 17.11-1)",
    server_version_num: "170011",
    is_superuser: true,
    system_identifier: "known-cluster-identity",
  };
  assert.equal(
    validateServerProbe(probe, {
      expectedServerIdentity: "known-cluster-identity",
    }).serverVersion,
    "17.11",
  );
  assert.throws(
    () =>
      validateServerProbe(
        { ...probe, system_identifier: "other" },
        { expectedServerIdentity: "known-cluster-identity" },
      ),
    /server identity/,
  );
  assert.throws(
    () =>
      validateServerProbe(
        { ...probe, is_superuser: false },
        { expectedServerIdentity: "known-cluster-identity" },
      ),
    /superuser/,
  );
  assert.throws(
    () =>
      validateServerProbe(
        { ...probe, current_database: "coffeeorderdb" },
        { expectedServerIdentity: "known-cluster-identity" },
      ),
    /forbidden target/,
  );
});

void test("GREEN: role SQL is hardened and does not grant DDL or superuser capabilities", () => {
  const sql = renderRoleSql("coffee_customer_rw", "secret-value");
  assert.match(sql, /NOSUPERUSER/);
  assert.match(sql, /NOCREATEDB/);
  assert.match(sql, /NOCREATEROLE/);
  assert.match(sql, /NOBYPASSRLS/);
  assert.match(sql, /PASSWORD 'secret-value'/);
  assert.doesNotMatch(sql, /CREATE DATABASE/);
});

void test("GREEN: bootstrap executes an idempotent plan through an injected client only", async () => {
  const adminQueries = [];
  const adminClient = {
    async query(sql) {
      adminQueries.push(sql);
      if (sql.includes("current_database()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "bootstrap",
              server_version: "17.11",
              is_superuser: true,
              system_identifier: "known",
            },
          ],
        };
      if (sql.startsWith("SELECT datname")) return { rows: [] };
      return { rows: [] };
    },
  };
  const connected = [];
  const result = await bootstrapDatabases({
    adminClient,
    adminUrl: ADMIN_URL,
    connectClient: async (database) => {
      connected.push(database);
      return {
        async query() {
          return { rows: [] };
        },
        async end() {},
      };
    },
    roleMap,
    ownership,
    rolePasswords,
    expectedServerIdentity: "known",
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.databaseCount, 5);
  assert.deepEqual(
    connected.sort((left, right) => left.localeCompare(right)),
    roleMap.databases
      .map((database) => database.name)
      .sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(
    adminQueries.some((sql) => sql.includes("coffeeorderdb")),
    false,
  );
  assert.equal(
    adminQueries.some((sql) => sql.includes("admin-secret")),
    false,
  );
});

void test("GREEN: smoke matrix is isolated and checks every own/cross-owner pair", () => {
  const cases = buildSmokeCases(roleMap, ownership);
  assert.equal(cases.filter((item) => item.kind === "own-write").length, 10);
  assert.equal(
    cases.filter((item) => item.kind === "foreign-connect-denied").length,
    40,
  );
  assert.deepEqual(
    validateSmokeTarget({
      enabled: true,
      runId: "run1234",
      databasePrefix: "coffee_verify_run1234_",
    }),
    { runId: "run1234", databasePrefix: "coffee_verify_run1234_" },
  );
  assert.throws(
    () =>
      validateSmokeTarget({
        enabled: true,
        runId: "run1234",
        databasePrefix: "coffee_platform_",
      }),
    /isolated/,
  );
  assert.throws(
    () =>
      validateSmokeTarget({
        enabled: false,
        runId: "run1234",
        databasePrefix: "coffee_verify_run1234_",
      }),
    /ENABLED/,
  );
});

void test("GREEN: live smoke writes only a rolled-back temporary row and rejects foreign connections", async () => {
  const target = {
    enabled: true,
    runId: "run1234",
    databasePrefix: "coffee_verify_run1234_",
  };
  const calls = [];
  const ownDatabaseByRuntime = new Map(
    roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => [
        runtime.runtime,
        database.name.replace("coffee_platform_", ""),
      ]),
    ),
  );
  const result = await runDatabaseSmoke({
    baseAdminUrl: ADMIN_URL,
    roleMap,
    ownership,
    rolePasswords,
    isolatedTarget: target,
    connectClient: async ({ runtime, database }) => {
      calls.push({ runtime, database });
      if (!database.endsWith(ownDatabaseByRuntime.get(runtime))) {
        const error = new Error("permission denied for database");
        error.code = "42501";
        throw error;
      }
      return {
        async query(sql) {
          if (sql.startsWith("SELECT count")) return { rows: [{ count: 1 }] };
          return { rows: [] };
        },
        async end() {},
      };
    },
  });
  assert.equal(result.ownWriteCount, 10);
  assert.equal(result.foreignDeniedCount, 40);
  assert.equal(result.caseCount, 50);
  assert.equal(
    calls.some((call) => call.database.startsWith("coffee_platform_")),
    false,
  );
});

void test("GREEN: bootstrap role rendering never exposes passwords in safe plan", async () => {
  const source = await readFile(join(ROOT, "scripts/db-bootstrap.mjs"), "utf8");
  assert.match(
    source,
    /password is supplied only by the in-memory SOPS bundle/,
  );
});
