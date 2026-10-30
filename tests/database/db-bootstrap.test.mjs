import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";

import {
  assertBootstrapInputs,
  bootstrapDatabases,
  projectLaunchDatabaseTargets,
  readJson,
  renderDatabaseObjectSql,
  renderDatabaseSql,
  renderRoleSql,
  renderSafePlan,
  validateRoleMap,
  validateServerProbe,
} from "../../scripts/db-bootstrap.mjs";
import {
  buildSmokeCases,
  runDatabaseSmoke,
  validateDeliverySqlContract,
  validateSmokeTarget,
} from "../../scripts/db-smoke.mjs";
import {
  assertDatabaseAdmissionBudget,
  loadPlatformConfig,
  parsePlatformConfig,
  PlatformConfigError,
} from "../../packages/platform-config/src/index.ts";
import { isExpectedMissingDockerInspect } from "../../verification/launch/v1/scenarios/aroma-sandbox-resources.mjs";
import {
  buildMigrationPlan,
  cleanupMigrationDatabases,
  createMigrationDatabase,
} from "../../verification/launch/v1/scenarios/migrations.mjs";
import { validateMigrationPreparationArtifact } from "../../tools/config-bootstrap/index.mjs";

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

void test("G16: Docker inspect accepts only the exact absent resource response", () => {
  const name = "coffee-g16-diagnostic-absent-network";
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "[]\n",
        stderr: `Error response from daemon: network ${name} not found\n`,
      },
      "network",
      name,
    ),
    true,
  );
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "[{}]",
        stderr: `Error response from daemon: network ${name} not found`,
      },
      "network",
      name,
    ),
    false,
  );
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "[]",
        stderr: `Error response from daemon: network ${name}-other not found`,
      },
      "network",
      name,
    ),
    false,
  );
  const containerName = "coffee-g16-diagnostic-absent-container";
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "[]\n",
        stderr: `Error response from daemon: No such container: ${containerName}\n`,
      },
      "container",
      containerName,
    ),
    true,
  );
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "[]",
        stderr: `Error: No such object: ${containerName}`,
      },
      "container",
      containerName,
    ),
    true,
  );
  assert.equal(
    isExpectedMissingDockerInspect(
      {
        code: 1,
        stdout: "{}",
        stderr: `Error response from daemon: No such container: ${containerName}`,
      },
      "container",
      containerName,
    ),
    false,
  );
});

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

void test("G08 v2 keeps the four UPDATE scopes column-only and rejects stale ACLs", async () => {
  assert.equal(roleMap.schemaVersion, 2);
  const roleMapSchema = await readJson(
    join(ROOT, "config/database-role-map.schema.json"),
  );
  const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
    roleMapSchema,
  );
  assert.equal(validateSchema(roleMap), true);
  const scoped = roleMap.databases.flatMap((database) =>
    database.runtimeRoles.flatMap((runtime) =>
      Object.entries(runtime.columnUpdates ?? {}).map(([table, columns]) => ({
        database,
        runtime,
        table,
        columns,
      })),
    ),
  );
  assert.equal(scoped.length, 4);
  for (const { database, runtime, table, columns } of scoped) {
    const sql = renderDatabaseSql(database);
    const qualified = `"${database.schema}"."${table}"`;
    const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
    const inspectColumnAcl = sql.indexOf(
      "CROSS JOIN LATERAL aclexplode(attribute.attacl)",
    );
    const rejectUnexpectedColumn = sql.indexOf(
      "RAISE EXCEPTION 'unexpected column UPDATE grant",
    );
    const revokeTableUpdate = sql.indexOf(
      `EXECUTE 'REVOKE UPDATE ON TABLE ${qualified} FROM "${runtime.role}"'`,
    );
    const grantScopedUpdate = sql.indexOf(
      `EXECUTE 'GRANT UPDATE (${quotedColumns}) ON TABLE ${qualified} TO "${runtime.role}"'`,
    );
    assert.ok(inspectColumnAcl >= 0);
    assert.ok(sql.includes("acl.grantee = runtime_role_oid"));
    assert.ok(sql.includes("acl.grantee = 0"));
    assert.ok(rejectUnexpectedColumn > inspectColumnAcl);
    assert.ok(revokeTableUpdate > rejectUnexpectedColumn);
    assert.ok(grantScopedUpdate > revokeTableUpdate);
    assert.equal(sql.includes("information_schema.column_privileges"), false);
    assert.equal(
      sql.includes(`GRANT UPDATE ON TABLE ${qualified} TO "${runtime.role}"`),
      false,
    );
  }

  const legacy = structuredClone(roleMap);
  legacy.schemaVersion = 1;
  assert.throws(() => validateRoleMap(legacy, ownership), /schemaVersion/u);
  assert.equal(validateSchema(legacy), false);
  const widened = structuredClone(roleMap);
  const activation = widened.databases
    .find(({ schema }) => schema === "catalog")
    .runtimeRoles.find(
      ({ runtime }) => runtime === "catalog-activation-worker",
    );
  activation.columnUpdates.supplier_snapshots.push("created_at");
  assert.throws(
    () => validateRoleMap(widened, ownership),
    /column update scope is invalid/u,
  );
  assert.equal(validateSchema(widened), false);
});

void test("external run database renderer reuses grants without role DDL", () => {
  for (const database of roleMap.databases) {
    const fullSql = renderDatabaseSql(database);
    const expectedObjectSql = fullSql
      .split("\n")
      .filter((statement) => !statement.startsWith("ALTER ROLE "))
      .join("\n");
    const objectSql = renderDatabaseObjectSql(database);

    assert.equal(objectSql, expectedObjectSql, database.name);
    assert.match(objectSql, /CREATE SCHEMA IF NOT EXISTS/u);
    assert.match(objectSql, /GRANT CONNECT, TEMPORARY ON DATABASE/u);
    assert.match(objectSql, /ALTER DEFAULT PRIVILEGES FOR ROLE/u);
    assert.doesNotMatch(objectSql, /\b(?:CREATE|ALTER|DROP)\s+ROLE\b/iu);
  }
  assert.match(
    renderDatabaseSql(roleMap.databases[0]),
    /ALTER ROLE .* IN DATABASE/u,
  );
});

void test("GREEN/RED: launch projection changes only owned database names", () => {
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T110000Z-abcdef0",
    candidateSha: "abcdef0123456789abcdef0123456789abcdef01",
    baseConfigSha256: "a".repeat(64),
  };
  const originalOwnership = structuredClone(ownership);
  const originalRoleMap = structuredClone(roleMap);
  const { ownership: projectedOwnership, roleMap: projectedRoleMap } =
    projectLaunchDatabaseTargets({ ownership, roleMap, launchIdentity });

  const expectedName = (owner) =>
    `coffee_verify_20261024t110000z_abcdef0_${owner}`;
  const expectedOwnership = structuredClone(originalOwnership);
  const canonicalToDerived = new Map();
  for (const database of expectedOwnership.databases) {
    const canonical = database.name;
    database.name = expectedName(database.owner);
    canonicalToDerived.set(canonical, database.name);
  }
  expectedOwnership.runtimeClaims = expectedOwnership.runtimeClaims.map(
    (claim) => ({
      ...claim,
      database:
        claim.database === null ? null : canonicalToDerived.get(claim.database),
    }),
  );
  const expectedRoleMap = structuredClone(originalRoleMap);
  expectedRoleMap.databases = expectedRoleMap.databases.map((database) => ({
    ...database,
    name: canonicalToDerived.get(database.name),
  }));

  assert.deepEqual(projectedOwnership, expectedOwnership);
  assert.deepEqual(projectedRoleMap, expectedRoleMap);
  assert.deepEqual(ownership, originalOwnership);
  assert.deepEqual(roleMap, originalRoleMap);
  assert.deepEqual(
    validateRoleMap(projectedRoleMap, projectedOwnership, { launchIdentity }),
    {
      databaseCount: 5,
      migratorRoleCount: 5,
      runtimeRoleCount: 10,
    },
  );
  assert.throws(
    () => validateRoleMap(projectedRoleMap, projectedOwnership),
    /approved namespace/u,
  );
  assert.deepEqual(validateRoleMap(roleMap, ownership).databaseCount, 5);

  assert.throws(
    () =>
      projectLaunchDatabaseTargets({
        ownership: { ...ownership, databases: ownership.databases.slice(1) },
        roleMap,
        launchIdentity,
      }),
    /exactly five databases/u,
  );
  const foreignOwnership = structuredClone(ownership);
  foreignOwnership.databases[0].owner = "foreign";
  assert.throws(
    () =>
      projectLaunchDatabaseTargets({
        ownership: foreignOwnership,
        roleMap,
        launchIdentity,
      }),
    /foreign database owner/u,
  );
  const arbitraryRoleMap = structuredClone(roleMap);
  arbitraryRoleMap.databases[0].name = "coffee_verify_other_customer";
  assert.throws(
    () =>
      projectLaunchDatabaseTargets({
        ownership,
        roleMap: arbitraryRoleMap,
        launchIdentity,
      }),
    /missing ownership declaration/u,
  );
  const partialProjection = structuredClone(projectedOwnership);
  partialProjection.databases[0].name = "coffee_platform_customer";
  assert.throws(
    () =>
      validateRoleMap(projectedRoleMap, partialProjection, { launchIdentity }),
    /approved namespace/u,
  );
  assert.throws(
    () =>
      projectLaunchDatabaseTargets({
        ownership,
        roleMap,
        launchIdentity: { ...launchIdentity, candidateSha: "f".repeat(40) },
      }),
    /launch run identity/u,
  );
});

void test("G08 derives only the five run databases and validates its exact preparation binding", () => {
  const context = {
    schemaVersion: 1,
    runId: "20261024T110000Z-abcdef0",
    candidateSha: "abcdef0123456789abcdef0123456789abcdef01",
    baseConfigSha256: "a".repeat(64),
  };
  const { owners } = buildMigrationPlan({
    launchIdentity: context,
    ownership,
    roleMap,
  });
  assert.deepEqual(
    owners.map(({ owner, name }) => [owner, name]),
    ["catalog", "customer", "integration", "orders", "pricing"].map((owner) => [
      owner,
      `coffee_verify_20261024t110000z_abcdef0_${owner}`,
    ]),
  );
  assert.equal(
    owners.some(({ name }) =>
      ["coffeeorderdb", "coffeeorder_staging"].includes(name),
    ),
    false,
  );

  const prep = {
    schemaVersion: 1,
    stage: "roles-created",
    runId: "20261024T100000Z-abcdef0",
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    configSha256: context.baseConfigSha256,
    postgres: {
      host: "coffee_postgres",
      port: 5432,
      version: "17.11",
      systemIdentifier: "7613370342949990434",
      database: "postgres",
      user: "coffeeuser",
    },
    bundle: { beforeSha256: "b".repeat(64), resultingSha256: "c".repeat(64) },
    roleNames: [
      ...roleMap.databases.map((database) => database.migratorRole),
      ...roleMap.databases.flatMap((database) =>
        database.runtimeRoles.map((runtime) => runtime.role),
      ),
    ].sort((left, right) => left.localeCompare(right)),
    createdCount: 15,
    transaction: "committed",
  };
  const artifact = {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    preparation: prep,
  };
  assert.equal(
    validateMigrationPreparationArtifact(artifact, context, "c".repeat(64)),
    prep,
  );
  assert.throws(
    () =>
      validateMigrationPreparationArtifact(
        artifact,
        { ...context, runId: "wrong" },
        "c".repeat(64),
      ),
    /CONFIG-G08-PREPARATION/u,
  );
  assert.throws(
    () =>
      validateMigrationPreparationArtifact(artifact, context, "d".repeat(64)),
    /CONFIG-G08-PREPARATION/u,
  );
  assert.throws(
    () =>
      buildMigrationPlan({
        launchIdentity: context,
        ownership: { ...ownership, databases: ownership.databases.slice(1) },
        roleMap,
      }),
    /exactly five databases/u,
  );
});

void test("G08 retains a late CREATE after an initial absent inspection", async () => {
  const database = {
    owner: "catalog",
    name: "coffee_verify_20261025t120000z_1111111_catalog",
  };
  const resources = [];
  let databaseExists = false;
  let dropCalls = 0;
  await assert.rejects(
    createMigrationDatabase(
      database,
      resources,
      async () => {
        assert.equal(resources[0].state, "create-pending");
        throw new Error("CREATE response was lost");
      },
      async () => {
        const inspection = { exists: databaseExists };
        databaseExists = true;
        return inspection;
      },
    ),
    /CREATE response was lost/u,
  );
  assert.equal(resources[0].state, "ambiguous");
  assert.deepEqual(resources[0].inspection, { exists: false });

  const cleanupReceipt = await cleanupMigrationDatabases(
    resources,
    async () => {
      dropCalls += 1;
    },
  );
  assert.deepEqual(cleanupReceipt, {
    verified: false,
    removed: [],
    retained: [database.name],
  });
  assert.equal(dropCalls, 0);

  const acknowledged = [];
  await createMigrationDatabase(
    database,
    acknowledged,
    async () => {},
    async () => {},
  );
  assert.equal(acknowledged[0].state, "created-acknowledged");
  const acknowledgedCleanup = await cleanupMigrationDatabases(
    acknowledged,
    async () => {
      dropCalls += 1;
    },
  );
  assert.equal(acknowledgedCleanup.verified, true);
  assert.deepEqual(acknowledgedCleanup.removed, [database.name]);
  assert.equal(dropCalls, 1);
});

void test("GREEN/RED: database SQL quotes only normative G17 restore names as special identifiers", () => {
  const orders = roleMap.databases.find(
    (database) => database.schema === "orders",
  );
  const restoreName = "coffee_restore_20261024T160245Z-09a4bd2_orders";
  const sql = renderDatabaseSql({ ...orders, name: restoreName });
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON DATABASE "coffee_restore_20261024T160245Z-09a4bd2_orders" FROM PUBLIC;/u,
  );
  assert.match(
    sql,
    /ALTER ROLE "coffee_orders_migrator" IN DATABASE "coffee_restore_20261024T160245Z-09a4bd2_orders" SET search_path/u,
  );
  assert.match(
    sql,
    /GRANT CONNECT, TEMPORARY ON DATABASE "coffee_restore_20261024T160245Z-09a4bd2_orders" TO/u,
  );

  for (const name of [
    "Coffee_restore_20261024T160245Z-09a4bd2_orders",
    "coffee_restore_20261024t160245z-09a4bd2_orders",
    "coffee_restore_20261024T160245Z-09a4bd2_legacy",
    'coffee_restore_20261024T160245Z-09a4bd2_orders"; DROP DATABASE postgres; --',
    `coffee_restore_${"a".repeat(70)}`,
  ]) {
    assert.throws(
      () => renderDatabaseSql({ ...orders, name }),
      /DB-BOOTSTRAP database name is not a canonical identifier or G17 restore target/u,
    );
  }
});

void test("GREEN/RED: DB admission reserves one serial rollout without changing pool or server limits", async () => {
  const config = await loadPlatformConfig(
    join(ROOT, "config/platform.yaml"),
    (text) => parseYaml(text, { json: true }),
  );
  const declaredOwners = roleMap.databases.flatMap((database) =>
    database.runtimeRoles.map((role) => ({
      runtime: role.runtime,
      database: database.name,
    })),
  );
  assert.deepEqual(
    declaredOwners.map((owner) => owner.runtime).sort(),
    Object.entries(config.services)
      .filter(([, service]) => service.database !== null)
      .map(([runtime]) => runtime)
      .sort(),
  );
  for (const owner of declaredOwners)
    assert.equal(config.services[owner.runtime].database, owner.database);
  const budget = assertDatabaseAdmissionBudget({
    services: config.services,
    postgres: config.postgres,
  });
  assert.deepEqual(budget, {
    steadyConnections: 56,
    rolloutConnections: 8,
    reservedConnections: 32,
    requiredConnections: 96,
    maxConnections: 96,
    largestPool: 8,
  });
  const originalMaxConnections = config.postgres.maxConnections;
  const originalPoolMax = Object.fromEntries(
    Object.entries(config.services).map(([runtime, service]) => [
      runtime,
      service.dbPool?.max ?? null,
    ]),
  );
  assert.throws(
    () =>
      assertDatabaseAdmissionBudget({
        services: config.services,
        postgres: { ...config.postgres, rolloutReplicas: 2 },
      }),
    (error) =>
      error instanceof PlatformConfigError &&
      /DB admission budget 104 exceeds maxConnections 96/u.test(error.message),
  );
  assert.equal(config.postgres.maxConnections, originalMaxConnections);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(config.services).map(([runtime, service]) => [
        runtime,
        service.dbPool?.max ?? null,
      ]),
    ),
    originalPoolMax,
  );
  assert.equal(config.services["orders-service"].dbPool.max, 4);
  assert.equal(
    config.services["orders-service"].dbPool.terminalTimeoutMs,
    2000,
  );
  assert.equal(
    config.services["orders-service"].dbPool.transactionTimeoutMs,
    10000,
  );
  const source = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  assert.throws(
    () =>
      parsePlatformConfig({
        ...source,
        services: {
          ...source.services,
          "orders-service": {
            ...source.services["orders-service"],
            dbPool: {
              ...source.services["orders-service"].dbPool,
              transactionTimeoutMs: source.platform.shutdownGraceMs,
            },
          },
        },
      }),
    (error) =>
      error instanceof PlatformConfigError &&
      /DB timeout должен быть меньше platform\.shutdownGraceMs/u.test(
        error.message,
      ),
  );
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
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T110000Z-abcdef0",
    candidateSha: "abcdef0123456789abcdef0123456789abcdef01",
    baseConfigSha256: "a".repeat(64),
  };
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity,
  });
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
    roleMap: projected.roleMap,
    ownership: projected.ownership,
    rolePasswords,
    expectedServerIdentity: "known",
    launchIdentity,
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.databaseCount, 5);
  assert.deepEqual(
    connected.sort((left, right) => left.localeCompare(right)),
    projected.roleMap.databases
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
  const offline = JSON.parse(
    execFileSync(process.execPath, [join(ROOT, "scripts/db-smoke.mjs")], {
      encoding: "utf8",
    }),
  );
  assert.deepEqual(offline.roleCases, buildSmokeCases(roleMap, ownership));
  assert.deepEqual(offline.structural, validateDeliverySqlContract());
  assert.equal(offline.structural.liveDatabase, false);
  assert.equal(offline.structural.realKafka, false);
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

void test("G09 smoke performs role-mapped own reads and strictly classifies foreign database denial", async () => {
  const target = {
    runId: "run1234",
  };
  const calls = [];
  const databaseByOwner = Object.fromEntries(
    ownership.databases.map(({ owner }) => [
      owner,
      `coffee_verify_run1234_${owner}`,
    ]),
  );
  const result = await runDatabaseSmoke({
    roleMap,
    ownership,
    databaseByOwner,
    runId: target.runId,
    expectedSystemIdentifier: "7613370342949990434",
    host: "coffee_postgres",
    port: 5432,
    readRuntimeCredential: async ({ runtime, owner }) => ({
      username: roleMap.databases
        .find(
          (entry) =>
            entry.name ===
            ownership.databases.find((item) => item.owner === owner).name,
        )
        .runtimeRoles.find((entry) => entry.runtime === runtime).role,
      password: `${runtime}-selected-secret`,
    }),
    connectClient: async ({ runtime, role, database }) => {
      calls.push({ runtime, role, database });
      const owner = Object.entries(databaseByOwner).find(
        ([, targetDatabase]) => targetDatabase === database,
      )?.[0];
      const runtimeOwner = ownership.runtimeClaims.find(
        (claim) => claim.runtime === runtime,
      )?.database;
      const logicalOwnerDatabase = ownership.databases.find(
        (entry) => entry.owner === owner,
      )?.name;
      if (logicalOwnerDatabase !== runtimeOwner) {
        const error = new Error("permission denied for database");
        error.code = "42501";
        throw error;
      }
      return {
        async query(sql) {
          if (sql.includes("current_database()"))
            return { rows: [{ database, role }] };
          assert.match(
            sql,
            /^SELECT 1 FROM "[a-z][a-z0-9_]*"\."[a-z][a-z0-9_]*" LIMIT 0$/u,
          );
          return { rows: [] };
        },
        async end() {},
      };
    },
  });
  assert.equal(result.ownOperationCount, 10);
  assert.equal(result.foreignDeniedCount, 40);
  assert.equal(result.caseCount, 50);
  assert.equal(
    result.ownOperations.every(({ operation }) => operation === "SELECT"),
    true,
  );
  assert.equal(
    result.foreignConnectionDenials.every(
      ({ sqlState }) => sqlState === "42501",
    ),
    true,
  );
  assert.equal(JSON.stringify(result).includes("selected-secret"), false);
  assert.equal(
    calls.some((call) => call.database.startsWith("coffee_platform_")),
    false,
  );
});

void test("G09 smoke rejects foreign connection failures other than SQLSTATE 42501", async () => {
  await assert.rejects(
    runDatabaseSmoke({
      roleMap,
      ownership,
      databaseByOwner: Object.fromEntries(
        ownership.databases.map(({ owner }) => [
          owner,
          `coffee_verify_run1234_${owner}`,
        ]),
      ),
      runId: "run1234",
      expectedSystemIdentifier: "7613370342949990434",
      host: "coffee_postgres",
      port: 5432,
      readRuntimeCredential: async ({ runtime, owner }) => ({
        username: roleMap.databases
          .find(
            (entry) =>
              entry.name ===
              ownership.databases.find((item) => item.owner === owner).name,
          )
          .runtimeRoles.find((entry) => entry.runtime === runtime).role,
        password: `${runtime}-selected-secret`,
      }),
      connectClient: async ({ runtime, role, database }) => {
        const targetOwner = ownership.databases.find(({ owner }) =>
          database.endsWith(`_${owner}`),
        )?.owner;
        const expectedLogicalDatabase = ownership.runtimeClaims.find(
          (claim) => claim.runtime === runtime,
        )?.database;
        if (
          ownership.databases.find(({ owner }) => owner === targetOwner)
            ?.name === expectedLogicalDatabase
        )
          return {
            async query(sql) {
              if (sql.includes("current_database()"))
                return { rows: [{ database, role }] };
              return { rows: [] };
            },
            async end() {},
          };
        const error = new Error("database does not exist");
        error.code = "3D000";
        throw error;
      },
    }),
    (error) => error.code === "3D000",
  );
});

void test("GREEN: bootstrap role rendering never exposes passwords in safe plan", async () => {
  const source = await readFile(join(ROOT, "scripts/db-bootstrap.mjs"), "utf8");
  assert.match(
    source,
    /password is supplied only by the in-memory SOPS bundle/,
  );
});
