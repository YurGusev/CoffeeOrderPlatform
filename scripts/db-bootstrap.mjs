#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
  validateLaunchDatabaseIdentity,
} from "../packages/platform-config/src/launch-database-target.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OWNERSHIP = join(REPO_ROOT, "config/database-ownership.json");
const DEFAULT_ROLE_MAP = join(REPO_ROOT, "config/database-role-map.json");
const DENIED_DATABASES = new Set(["coffeeorderdb", "coffeeorder_staging"]);
const PLATFORM_DATABASES = new Set([
  "coffee_platform_customer",
  "coffee_platform_catalog",
  "coffee_platform_pricing",
  "coffee_platform_orders",
  "coffee_platform_integration",
]);
const DENIED_ROLES = new Set([
  "postgres",
  "coffee_orders_rw",
  "coffee_platform_superuser",
]);
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const BACKUP_RESTORE_DATABASE =
  /^coffee_restore_[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}_(customer|catalog|pricing|orders|integration)$/;
const ROLE = /^coffee_[a-z_]+_(?:migrator|rw|ro)$/;
const PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const SCOPED_COLUMN_UPDATES = Object.freeze({
  coffee_catalog_activate_rw: Object.freeze({
    supplier_snapshots: Object.freeze([
      "state",
      "failure_code",
      "declared_batch_count",
      "declared_product_count",
      "declared_variant_count",
      "declared_offer_count",
      "content_hash",
      "received_at",
    ]),
    source_identities: Object.freeze(["last_seen_snapshot_ref", "state"]),
  }),
  coffee_orders_service_rw: Object.freeze({
    orders: Object.freeze([
      "status",
      "version",
      "customer_ref",
      "customer_version",
      "customer_display_name",
      "customer_state",
      "customer_state_proof_hash",
      "currency",
      "confirmed_at",
      "updated_at",
      "last_modified_by_actor_ref",
    ]),
  }),
  coffee_orders_convergence_rw: Object.freeze({
    convergence_work: Object.freeze(["dirty", "next_attempt_at", "updated_at"]),
  }),
});

export const SERVER_IDENTITY_SQL = `
SELECT
  current_database() AS current_database,
  current_user AS current_user,
  current_setting('server_version') AS server_version,
  current_setting('server_version_num') AS server_version_num,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
  (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
`;

const ADVISORY_LOCK_SQL =
  "SELECT pg_advisory_lock(hashtextextended('coffee-platform:database-bootstrap:v1', 0))";
const ADVISORY_UNLOCK_SQL =
  "SELECT pg_advisory_unlock(hashtextextended('coffee-platform:database-bootstrap:v1', 0))";

function fail(message) {
  throw new Error(`DB-BOOTSTRAP ${message}`);
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    fail(`${label} is not a safe PostgreSQL identifier`);
  return value;
}

function quoteIdentifier(value) {
  return `"${assertIdentifier(value, "identifier").replaceAll('"', '""')}"`;
}

function quoteDatabaseIdentifier(value) {
  const isCanonicalBackupRestore =
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 63 &&
    BACKUP_RESTORE_DATABASE.test(value);
  if (!IDENTIFIER.test(value ?? "") && !isCanonicalBackupRestore)
    fail("database name is not a canonical identifier or G17 restore target");
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  if (typeof value !== "string") fail("secret value must be a string");
  return `'${value.replaceAll("'", "''")}'`;
}

function asRows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: cannot read strict JSON (${error.message})`);
  }
}

function expectedDatabaseNames(ownership, launchIdentity) {
  if (
    !Array.isArray(ownership?.databases) ||
    ownership.databases.length !== CANONICAL_DATABASE_OWNERS.length
  ) {
    fail("ownership manifest must declare exactly five databases");
  }
  const identity = launchIdentity
    ? validateLaunchDatabaseIdentity(launchIdentity)
    : null;
  const owners = new Set();
  const names = [];
  for (const database of ownership.databases) {
    const owner = database?.owner;
    if (
      typeof owner !== "string" ||
      !CANONICAL_DATABASE_OWNERS.includes(owner) ||
      owners.has(owner)
    ) {
      fail(
        "ownership manifest has a missing, duplicate or foreign database owner",
      );
    }
    const expectedName = identity
      ? deriveLaunchDatabaseName(identity, owner)
      : `coffee_platform_${owner}`;
    if (database.name !== expectedName)
      fail(`${owner}: ownership database differs from the approved namespace`);
    owners.add(owner);
    names.push(expectedName);
  }
  if (owners.size !== CANONICAL_DATABASE_OWNERS.length)
    fail("ownership manifest does not cover every canonical database owner");
  if (!Array.isArray(ownership.runtimeClaims))
    fail("ownership manifest runtime claims are invalid");
  return names;
}

function allRuntimeRoles(roleMap) {
  return roleMap.databases.flatMap((database) =>
    database.runtimeRoles.map((runtime) => runtime.role),
  );
}

export function validateRoleMap(roleMap, ownership, { launchIdentity } = {}) {
  if (
    !roleMap ||
    roleMap.schemaVersion !== 2 ||
    roleMap.authorityRef !== "docs/launch/05_DATA_OWNERSHIP.md"
  ) {
    fail("role map authority or schemaVersion is invalid");
  }
  const ownershipNames = expectedDatabaseNames(ownership, launchIdentity);
  if (!Array.isArray(roleMap.databases) || roleMap.databases.length !== 5)
    fail("role map must declare exactly five databases");
  const databaseNames = new Set();
  const migratorRoles = new Set();
  const runtimeRoles = new Set();
  const expectedClaims = new Map(
    ownership.runtimeClaims.map((claim) => [claim.runtime, claim]),
  );

  for (const database of roleMap.databases) {
    assertIdentifier(database.name, "database name");
    assertIdentifier(database.schema, `${database.name} schema`);
    if (DENIED_DATABASES.has(database.name))
      fail(`${database.name}: unsafe/legacy target database`);
    if (!ownershipNames.includes(database.name))
      fail(`${database.name}: missing ownership declaration`);
    if (databaseNames.has(database.name))
      fail(`${database.name}: duplicate role-map database`);
    databaseNames.add(database.name);
    if (
      typeof database.migratorRole !== "string" ||
      !ROLE.test(database.migratorRole) ||
      !database.migratorRole.endsWith("_migrator")
    ) {
      fail(`${database.name}: invalid migrator role`);
    }
    if (
      DENIED_ROLES.has(database.migratorRole) ||
      migratorRoles.has(database.migratorRole)
    )
      fail(`${database.name}: unsafe/duplicate migrator role`);
    const owner = ownership.databases.find(
      (candidate) => candidate.name === database.name,
    );
    if (!owner || owner.migratorRole !== database.migratorRole)
      fail(`${database.name}: migrator differs from ownership manifest`);
    migratorRoles.add(database.migratorRole);
    if (
      !Array.isArray(database.runtimeRoles) ||
      database.runtimeRoles.length < 1
    )
      fail(`${database.name}: runtime role list is empty`);

    for (const runtime of database.runtimeRoles) {
      if (
        typeof runtime.runtime !== "string" ||
        typeof runtime.role !== "string"
      )
        fail(`${database.name}: runtime role identity is incomplete`);
      if (runtimeRoles.has(runtime.role))
        fail(`${runtime.runtime}: duplicate runtime role`);
      if (
        !ROLE.test(runtime.role) ||
        runtime.role.endsWith("_migrator") ||
        DENIED_ROLES.has(runtime.role)
      )
        fail(`${runtime.runtime}: unsafe runtime role`);
      runtimeRoles.add(runtime.role);
      if (runtime.temporaryTables !== true)
        fail(`${runtime.runtime}: temporary table permission must be explicit`);
      const claim = expectedClaims.get(runtime.runtime);
      if (
        !claim ||
        claim.database !== database.name ||
        claim.role !== runtime.role
      )
        fail(`${runtime.runtime}: role map differs from runtime claim`);
      if (
        !runtime.tables ||
        typeof runtime.tables !== "object" ||
        Array.isArray(runtime.tables) ||
        Object.keys(runtime.tables).length === 0
      ) {
        fail(`${runtime.runtime}: table allowlist is empty`);
      }
      for (const [table, privileges] of Object.entries(runtime.tables)) {
        assertIdentifier(table, `${runtime.runtime} table`);
        if (
          !Array.isArray(privileges) ||
          privileges.length === 0 ||
          privileges.some((privilege) => !PRIVILEGES.has(privilege))
        ) {
          fail(`${runtime.runtime}.${table}: invalid table privileges`);
        }
      }
      const expectedColumnUpdates = SCOPED_COLUMN_UPDATES[runtime.role] ?? {};
      const hasColumnUpdates = Object.hasOwn(runtime, "columnUpdates");
      const actualColumnUpdates = runtime.columnUpdates;
      const expectedTables = Object.keys(expectedColumnUpdates).sort();
      const actualTables =
        actualColumnUpdates &&
        typeof actualColumnUpdates === "object" &&
        !Array.isArray(actualColumnUpdates)
          ? Object.keys(actualColumnUpdates).sort()
          : [];
      if (
        (expectedTables.length === 0 && hasColumnUpdates) ||
        (expectedTables.length > 0 &&
          (!hasColumnUpdates ||
            actualTables.join("\0") !== expectedTables.join("\0") ||
            expectedTables.some(
              (table) =>
                !Array.isArray(actualColumnUpdates[table]) ||
                JSON.stringify(actualColumnUpdates[table]) !==
                  JSON.stringify(expectedColumnUpdates[table]),
            )))
      )
        fail(`${runtime.runtime}: column update scope is invalid`);
      for (const table of Object.keys(expectedColumnUpdates)) {
        if (!runtime.tables[table]?.includes("UPDATE"))
          fail(`${runtime.runtime}.${table}: scoped UPDATE is not allowed`);
      }
    }
  }
  if (
    databaseNames.size !== 5 ||
    [...databaseNames].some((name) => !ownershipNames.includes(name))
  )
    fail("role-map and ownership database sets differ");
  const claimedRoles = new Set(
    ownership.runtimeClaims
      .filter((claim) => claim.role !== null)
      .map((claim) => claim.role),
  );
  if (
    claimedRoles.size !== runtimeRoles.size ||
    [...claimedRoles].some((role) => !runtimeRoles.has(role))
  )
    fail("role-map and ownership runtime role sets differ");
  return {
    databaseCount: databaseNames.size,
    migratorRoleCount: migratorRoles.size,
    runtimeRoleCount: runtimeRoles.size,
  };
}

/** Project canonical ownership and role documents into one trusted launch namespace. */
export function projectLaunchDatabaseTargets({
  ownership,
  roleMap,
  launchIdentity,
}) {
  const identity = validateLaunchDatabaseIdentity(launchIdentity);
  validateRoleMap(roleMap, ownership);

  const databaseByCanonicalName = new Map(
    ownership.databases.map((database) => [database.name, database]),
  );
  const derivedByCanonicalName = new Map(
    ownership.databases.map((database) => [
      database.name,
      deriveLaunchDatabaseName(identity, database.owner),
    ]),
  );
  const projectDatabase = (database, label) => {
    const projected = derivedByCanonicalName.get(database);
    if (!projected || !databaseByCanonicalName.has(database))
      fail(`${label}: database is not a canonical owned target`);
    return projected;
  };

  const projectedOwnership = structuredClone(ownership);
  projectedOwnership.databases = projectedOwnership.databases.map(
    (database) => ({
      ...database,
      name: projectDatabase(database.name, `${database.owner} ownership`),
    }),
  );
  projectedOwnership.runtimeClaims = projectedOwnership.runtimeClaims.map(
    (claim) => ({
      ...claim,
      database:
        claim.database === null
          ? null
          : projectDatabase(claim.database, `${claim.runtime} runtime claim`),
    }),
  );

  const projectedRoleMap = structuredClone(roleMap);
  projectedRoleMap.databases = projectedRoleMap.databases.map((database) => ({
    ...database,
    name: projectDatabase(database.name, `${database.name} role map`),
  }));
  validateRoleMap(projectedRoleMap, projectedOwnership, {
    launchIdentity: identity,
  });
  return { ownership: projectedOwnership, roleMap: projectedRoleMap };
}

function parseUrl(url, label) {
  if (typeof url !== "string" || url.length === 0) fail(`${label} is required`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(`${label} is not a valid PostgreSQL URL (${error.message})`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hostname.length === 0
  )
    fail(`${label} must use a PostgreSQL host URL`);
  if (!parsed.password)
    fail(
      `${label} must contain an admin secret; plaintext password is never printed`,
    );
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database || DENIED_DATABASES.has(database))
    fail(`${label} points to a forbidden legacy database`);
  if (PLATFORM_DATABASES.has(database))
    fail(
      `${label} must point to a maintenance database, not a platform target`,
    );
  return parsed;
}

export function replaceDatabase(url, database, { user, password } = {}) {
  const parsed = parseUrl(url, "PostgreSQL URL");
  assertIdentifier(database, "database");
  if (DENIED_DATABASES.has(database))
    fail("refusing to build a legacy database URL");
  parsed.pathname = `/${database}`;
  if (user !== undefined) parsed.username = user;
  if (password !== undefined) parsed.password = password;
  return parsed.toString();
}

export function validateServerProbe(
  probe,
  { expectedServerIdentity, expectedServerVersion = "17.11" } = {},
) {
  if (
    typeof expectedServerIdentity !== "string" ||
    expectedServerIdentity.trim() === ""
  )
    fail("expected server identity is required");
  if (!probe || typeof probe !== "object")
    fail("server identity probe returned no row");
  if (probe.system_identifier !== expectedServerIdentity)
    fail(
      "server identity is unknown or does not match the explicitly approved target",
    );
  const version = String(probe.server_version ?? "").split(" ")[0];
  if (version !== expectedServerVersion)
    fail(
      `PostgreSQL version ${version || "unknown"} is not the approved ${expectedServerVersion}`,
    );
  if (probe.is_superuser !== true)
    fail(
      "admin bootstrap requires a superuser connection; runtime roles are never accepted",
    );
  if (
    typeof probe.current_database !== "string" ||
    DENIED_DATABASES.has(probe.current_database) ||
    PLATFORM_DATABASES.has(probe.current_database)
  )
    fail("server probe selected a forbidden target database");
  if (typeof probe.current_user !== "string" || probe.current_user.length === 0)
    fail("server probe did not return current_user");
  return {
    serverVersion: version,
    serverIdentity: expectedServerIdentity,
    adminDatabase: probe.current_database,
    adminUser: probe.current_user,
  };
}

export function assertBootstrapInputs({
  adminUrl,
  expectedServerIdentity,
  rolePasswords,
  roleMap,
  ownership,
  launchIdentity,
}) {
  const parsed = parseUrl(adminUrl, "COFFEE_DB_ADMIN_URL");
  if (
    typeof expectedServerIdentity !== "string" ||
    expectedServerIdentity.trim() === ""
  )
    fail(
      "COFFEE_DB_EXPECTED_SERVER_IDENTITY is required; wildcard identity is not accepted",
    );
  const mapSummary = validateRoleMap(roleMap, ownership, { launchIdentity });
  if (
    !rolePasswords ||
    typeof rolePasswords !== "object" ||
    Array.isArray(rolePasswords)
  )
    fail(
      "role passwords must be supplied by the decrypted SOPS secret bundle in memory",
    );
  const requiredRoles = new Set([
    ...roleMap.databases.map((database) => database.migratorRole),
    ...allRuntimeRoles(roleMap),
  ]);
  for (const role of requiredRoles) {
    const password = rolePasswords[role];
    if (typeof password !== "string" || password.length === 0)
      fail(`missing secret for role ${role}`);
    if (password === decodeURIComponent(parsed.password))
      fail(`role ${role} must not reuse the admin secret`);
  }
  for (const role of Object.keys(rolePasswords))
    if (!requiredRoles.has(role)) fail(`unallowlisted role secret ${role}`);
  return { ...mapSummary, requiredRoleCount: requiredRoles.size };
}

function renderRoleGuard(role) {
  const roleLiteral = quoteLiteral(role);
  return `DO $bootstrap$\nDECLARE existing pg_roles;\nBEGIN\n  SELECT * INTO existing FROM pg_roles WHERE rolname = ${roleLiteral};\n  IF FOUND AND (existing.rolsuper OR existing.rolcreatedb OR existing.rolcreaterole OR existing.rolreplication OR existing.rolbypassrls) THEN\n    RAISE EXCEPTION 'existing role has unsafe attributes: %', ${roleLiteral};\n  END IF;\nEND\n$bootstrap$;`;
}

export function renderRoleSql(role, password = null) {
  assertIdentifier(role, "role");
  if (!ROLE.test(role) || DENIED_ROLES.has(role)) fail(`unsafe role ${role}`);
  const passwordClause =
    password === null ? "" : ` PASSWORD ${quoteLiteral(password)}`;
  return `${renderRoleGuard(role)}\nDO $bootstrap$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${quoteLiteral(role)}) THEN\n    CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20${passwordClause};\n  ELSE\n    ALTER ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20;\n  END IF;\nEND\n$bootstrap$;\n${password === null ? "-- password is supplied only by the in-memory SOPS bundle during execution" : `ALTER ROLE ${quoteIdentifier(role)} PASSWORD ${quoteLiteral(password)};`}`;
}

export function renderSafePlan(roleMap) {
  validateRoleMap(roleMap, {
    databases: roleMap.databases.map((database) => ({
      ...database,
      owner: database.name.replace(/^coffee_platform_/u, ""),
    })),
    runtimeClaims: roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => ({
        runtime: runtime.runtime,
        database: database.name,
        role: runtime.role,
      })),
    ),
  });
  return roleMap.databases.map((database) => ({
    database: database.name,
    schema: database.schema,
    migratorRole: database.migratorRole,
    runtimeRoles: database.runtimeRoles.map((runtime) => ({
      runtime: runtime.runtime,
      role: runtime.role,
      tables: Object.keys(runtime.tables),
    })),
    statements: {
      database: `CREATE DATABASE ${quoteIdentifier(database.name)} OWNER ${quoteIdentifier(database.migratorRole)} TEMPLATE template0`,
      schema: `CREATE SCHEMA ${quoteIdentifier(database.schema)} AUTHORIZATION ${quoteIdentifier(database.migratorRole)}`,
    },
  }));
}

function roleAttributesSql(role, database, schema) {
  return `ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteDatabaseIdentifier(database)} SET search_path = ${quoteLiteral(schema)}, pg_catalog;`;
}

function databasePrivilegesSql(database, roles) {
  const roleList = roles.map(quoteIdentifier).join(", ");
  return `REVOKE ALL PRIVILEGES ON DATABASE ${quoteDatabaseIdentifier(database)} FROM PUBLIC;\nGRANT CONNECT, TEMPORARY ON DATABASE ${quoteDatabaseIdentifier(database)} TO ${roleList};`;
}

function conditionalGrantSql(schema, table, role, privileges, columnUpdates) {
  const tablePrivileges = columnUpdates
    ? privileges.filter((privilege) => privilege !== "UPDATE")
    : privileges;
  const grants = tablePrivileges.join(", ");
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  if (!columnUpdates)
    return `DO $grant$\nBEGIN\n  IF to_regclass(format('%I.%I', ${quoteLiteral(schema)}, ${quoteLiteral(table)})) IS NOT NULL THEN\n    EXECUTE 'GRANT ${grants} ON TABLE ${qualified} TO ${quoteIdentifier(role)}';\n  END IF;\nEND\n$grant$;`;

  const columns = columnUpdates.map(quoteIdentifier).join(", ");
  const allowedColumns = `ARRAY[${columnUpdates.map(quoteLiteral).join(", ")}]::text[]`;
  const tableGrant = grants
    ? `    EXECUTE 'GRANT ${grants} ON TABLE ${qualified} TO ${quoteIdentifier(role)}';\n`
    : "";
  return `DO $grant$\nDECLARE\n  unexpected_column text;\n  runtime_role_oid oid;\nBEGIN\n  IF to_regclass(format('%I.%I', ${quoteLiteral(schema)}, ${quoteLiteral(table)})) IS NOT NULL THEN\n    SELECT oid INTO runtime_role_oid FROM pg_roles WHERE rolname = ${quoteLiteral(role)};\n    SELECT attribute.attname::text INTO unexpected_column\n      FROM pg_attribute AS attribute\n      JOIN pg_class AS relation ON relation.oid = attribute.attrelid\n      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace\n      CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl\n     WHERE namespace.nspname = ${quoteLiteral(schema)}\n       AND relation.relname = ${quoteLiteral(table)}\n       AND attribute.attnum > 0\n       AND NOT attribute.attisdropped\n       AND acl.privilege_type = 'UPDATE'\n       AND (acl.grantee = runtime_role_oid OR acl.grantee = 0)\n       AND NOT (attribute.attname::text = ANY (${allowedColumns}))\n     LIMIT 1;\n    IF unexpected_column IS NOT NULL THEN\n      RAISE EXCEPTION 'unexpected column UPDATE grant on %.%.%', ${quoteLiteral(schema)}, ${quoteLiteral(table)}, unexpected_column;\n    END IF;\n${tableGrant}    EXECUTE 'REVOKE UPDATE ON TABLE ${qualified} FROM ${quoteIdentifier(role)}';\n    EXECUTE 'GRANT UPDATE (${columns}) ON TABLE ${qualified} TO ${quoteIdentifier(role)}';\n  END IF;\nEND\n$grant$;`;
}

function schemaSql(database) {
  const schema = quoteIdentifier(database.schema);
  const migrator = quoteIdentifier(database.migratorRole);
  return `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${migrator};\nDO $bootstrap$\nDECLARE owner_name text;\nBEGIN\n  SELECT pg_get_userbyid(nspowner) INTO owner_name FROM pg_namespace WHERE nspname = ${quoteLiteral(database.schema)};\n  IF owner_name <> ${quoteLiteral(database.migratorRole)} THEN\n    RAISE EXCEPTION 'schema owner mismatch for ${database.schema}: %', owner_name;\n  END IF;\nEND\n$bootstrap$;\nREVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`;
}

export function renderDatabaseSql(
  database,
  { includeRoleAttributes = true } = {},
) {
  const runtimeRoles = database.runtimeRoles.map((runtime) => runtime.role);
  const roles = [database.migratorRole, ...runtimeRoles];
  return [
    databasePrivilegesSql(database.name, roles),
    ...(includeRoleAttributes
      ? roles.map((role) =>
          roleAttributesSql(role, database.name, database.schema),
        )
      : []),
    schemaSql(database),
    `GRANT USAGE ON SCHEMA ${quoteIdentifier(database.schema)} TO ${runtimeRoles.map(quoteIdentifier).join(", ")};`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(database.migratorRole)} IN SCHEMA ${quoteIdentifier(database.schema)} REVOKE ALL ON TABLES FROM PUBLIC;`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(database.migratorRole)} IN SCHEMA ${quoteIdentifier(database.schema)} REVOKE ALL ON SEQUENCES FROM PUBLIC;`,
    ...database.runtimeRoles.flatMap((runtime) =>
      Object.entries(runtime.tables).map(([table, privileges]) =>
        conditionalGrantSql(
          database.schema,
          table,
          runtime.role,
          privileges,
          runtime.columnUpdates?.[table],
        ),
      ),
    ),
  ].join("\n");
}

export function renderDatabaseObjectSql(database) {
  return renderDatabaseSql(database, { includeRoleAttributes: false });
}

async function queryOne(client, sql, values = []) {
  const result = await client.query(sql, values);
  const rows = asRows(result);
  return rows[0];
}

async function ensureRole(adminClient, role, password) {
  await adminClient.query(renderRoleSql(role, password));
}

async function ensureDatabase(adminClient, database) {
  const row = await queryOne(
    adminClient,
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
    [database.name],
  );
  if (!row) {
    await adminClient.query(
      `CREATE DATABASE ${quoteIdentifier(database.name)} OWNER ${quoteIdentifier(database.migratorRole)} TEMPLATE template0`,
    );
    return "created";
  }
  if (row.owner !== database.migratorRole)
    fail(
      `${database.name}: existing database owner is not the approved migrator`,
    );
  return "existing";
}

async function ensureDatabaseObjects(adminClient, connectClient, database) {
  await adminClient.query(
    databasePrivilegesSql(database.name, [
      database.migratorRole,
      ...database.runtimeRoles.map((runtime) => runtime.role),
    ]),
  );
  const client = await connectClient(database.name);
  try {
    await client.query(schemaSql(database));
    await client.query(
      `GRANT USAGE ON SCHEMA ${quoteIdentifier(database.schema)} TO ${database.runtimeRoles.map((runtime) => quoteIdentifier(runtime.role)).join(", ")};`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(database.migratorRole)} IN SCHEMA ${quoteIdentifier(database.schema)} REVOKE ALL ON TABLES FROM PUBLIC;`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(database.migratorRole)} IN SCHEMA ${quoteIdentifier(database.schema)} REVOKE ALL ON SEQUENCES FROM PUBLIC;`,
    );
    for (const role of [
      database.migratorRole,
      ...database.runtimeRoles.map((runtime) => runtime.role),
    ]) {
      await adminClient.query(
        roleAttributesSql(role, database.name, database.schema),
      );
    }
    for (const runtime of database.runtimeRoles) {
      for (const [table, privileges] of Object.entries(runtime.tables))
        await client.query(
          conditionalGrantSql(
            database.schema,
            table,
            runtime.role,
            privileges,
            runtime.columnUpdates?.[table],
          ),
        );
    }
  } finally {
    await client.end();
  }
}

export async function bootstrapDatabases({
  adminClient,
  adminUrl,
  connectClient,
  roleMap,
  ownership,
  rolePasswords,
  expectedServerIdentity,
  expectedServerVersion = "17.11",
  launchIdentity,
}) {
  if (!adminClient || typeof adminClient.query !== "function")
    fail("admin client is required");
  if (typeof connectClient !== "function")
    fail("database connector is required");
  const summary = assertBootstrapInputs({
    adminUrl:
      adminUrl ??
      adminClient.connectionParameters?.connectionString ??
      adminClient.connectionString ??
      process.env.COFFEE_DB_ADMIN_URL,
    expectedServerIdentity,
    rolePasswords,
    roleMap,
    ownership,
    launchIdentity,
  });
  await adminClient.query(ADVISORY_LOCK_SQL);
  let unlocked = false;
  try {
    const probe = await queryOne(adminClient, SERVER_IDENTITY_SQL);
    const identity = validateServerProbe(probe, {
      expectedServerIdentity,
      expectedServerVersion,
    });
    const roles = [
      ...roleMap.databases.map((database) => database.migratorRole),
      ...allRuntimeRoles(roleMap),
    ];
    for (const role of roles)
      await ensureRole(adminClient, role, rolePasswords[role]);
    const databases = [];
    for (const database of roleMap.databases) {
      const state = await ensureDatabase(adminClient, database);
      await ensureDatabaseObjects(adminClient, connectClient, database);
      databases.push({ name: database.name, state });
    }
    await adminClient.query(ADVISORY_UNLOCK_SQL);
    unlocked = true;
    return { ...summary, ...identity, databases, idempotent: true };
  } finally {
    if (!unlocked) {
      try {
        await adminClient.query(ADVISORY_UNLOCK_SQL);
      } catch {
        /* preserve the bootstrap failure */
      }
    }
  }
}

function parseRolePasswords(value) {
  if (!value)
    fail(
      "COFFEE_DB_ROLE_PASSWORDS_JSON is required only for a local ephemeral invocation; production callers pass decrypted SOPS data in memory",
    );
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`role secret bundle is not valid JSON (${error.message})`);
  }
}

async function main(argv) {
  const roleMap = await readJson(DEFAULT_ROLE_MAP);
  const ownership = await readJson(DEFAULT_OWNERSHIP);
  if (argv.includes("--plan")) {
    console.log(JSON.stringify(renderSafePlan(roleMap), null, 2));
    return;
  }
  if (!argv.includes("--execute"))
    fail(
      "use --plan for an offline plan or --execute for an explicitly configured admin-only run",
    );
  const adminUrl = process.env.COFFEE_DB_ADMIN_URL;
  const expectedServerIdentity = process.env.COFFEE_DB_EXPECTED_SERVER_IDENTITY;
  const rolePasswords = parseRolePasswords(
    process.env.COFFEE_DB_ROLE_PASSWORDS_JSON,
  );
  const { Client } = await import("pg").catch(() => {
    fail(
      "the pg dependency is required only for --execute; no network was attempted",
    );
  });
  const adminClient = new Client(adminUrl);
  await adminClient.connect();
  try {
    const result = await bootstrapDatabases({
      adminClient,
      expectedServerIdentity,
      rolePasswords,
      roleMap,
      ownership,
      connectClient: async (database) => {
        const client = new Client(replaceDatabase(adminUrl, database));
        await client.connect();
        return client;
      },
    });
    console.log(
      JSON.stringify(
        {
          databaseCount: result.databaseCount,
          runtimeRoleCount: result.runtimeRoleCount,
          databases: result.databases,
          idempotent: result.idempotent,
        },
        null,
        2,
      ),
    );
  } finally {
    await adminClient.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
