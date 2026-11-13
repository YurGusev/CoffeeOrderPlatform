#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
  validateLaunchDatabaseIdentity,
} from "../../../../packages/platform-config/src/launch-database-target.ts";
import { loadPlatformConfig } from "../../../../scripts/config-lib.mjs";
import {
  projectLaunchDatabaseTargets,
  renderDatabaseSql,
  validateRoleMap,
} from "../../../../scripts/db-bootstrap.mjs";
import {
  canonicalJson,
  canonicalRequestHash,
} from "../../../../packages/platform-idempotency/dist/index.js";
import { validateLaunchContext } from "../report.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const ACCEPTED_PREFIX_COMMIT = "e278aeb10e57d37485542f8668f078456074b038";
const OWNERS = Object.freeze({
  customer: { current: 3, prefix: 2 },
  catalog: { current: 12, prefix: 8 },
  pricing: { current: 5, prefix: 4 },
  orders: { current: 24, prefix: 6 },
  integration: { current: 7, prefix: 7 },
});
const DENIED_DATABASES = new Set(["coffeeorderdb", "coffeeorder_staging"]);
const MIGRATION_FAILURE = Symbol("G08 migration failure");
const OWNER_PHASES = new Set([
  "callerprefix",
  "seed",
  "current",
  "column-boundary",
  "fixture-check",
]);
const ROLE_ATTRIBUTES = Object.freeze({
  login: true,
  superuser: false,
  createDb: false,
  createRole: false,
  inherit: false,
  replication: false,
  bypassRls: false,
  connectionLimit: 20,
});

function fail(code, message = code) {
  const error = new Error(`G08_MIGRATIONS ${code}: ${message}`);
  error[MIGRATION_FAILURE] = true;
  throw error;
}

export function formatOwnerStageFailure(owner, phase, error) {
  if (!Object.hasOwn(OWNERS, owner) || !OWNER_PHASES.has(phase))
    throw new TypeError("Invalid G08 owner stage");
  if (error?.[MIGRATION_FAILURE]) return error;
  const sqlState = [error?.sqlState, error?.code].find(
    (candidate) =>
      typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate),
  );
  return new Error(
    `G08_MIGRATIONS OWNER_STAGE_FAILED: ${owner}:${phase}:${sqlState ?? "UNKNOWN"}`,
  );
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function canonicalRoles(ownership, roleMap) {
  return sorted([
    ...ownership.databases.map((database) => database.migratorRole),
    ...roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => runtime.role),
    ),
  ]);
}

export function buildMigrationPlan({ launchIdentity, ownership, roleMap }) {
  const identity = validateLaunchDatabaseIdentity(launchIdentity);
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity: identity,
  });
  validateRoleMap(projected.roleMap, projected.ownership, {
    launchIdentity: identity,
  });
  const owners = projected.ownership.databases
    .map((database) => ({
      ...database,
      roleMap: projected.roleMap.databases.find(
        (entry) => entry.name === database.name,
      ),
    }))
    .sort((left, right) => left.owner.localeCompare(right.owner));
  if (
    owners.length !== CANONICAL_DATABASE_OWNERS.length ||
    owners.some(
      (owner) =>
        DENIED_DATABASES.has(owner.name) ||
        owner.name !== deriveLaunchDatabaseName(identity, owner.owner) ||
        !owner.roleMap ||
        owner.roleMap.migratorRole !== owner.migratorRole,
    )
  )
    fail("TARGET_PLAN_INVALID");
  return {
    identity,
    owners,
    ownership: projected.ownership,
    roleMap: projected.roleMap,
  };
}

function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    fail("GIT_EVIDENCE_UNAVAILABLE");
  }
}

function gitFile(root, path) {
  try {
    return execFileSync("git", ["show", `${ACCEPTED_PREFIX_COMMIT}:${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail("HISTORICAL_MIGRATION_UNAVAILABLE");
  }
}

function assertPreparationAncestor(root, prepSha, candidateSha) {
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", prepSha, candidateSha],
      {
        cwd: root,
        stdio: "ignore",
      },
    );
  } catch {
    fail("PREPARATION_NOT_ANCESTOR");
  }
}

async function readPreparation(context, evidenceDir, root) {
  const path = join(
    evidenceDir,
    "gates/migrations/artifacts/canonical-preparation.json",
  );
  let info;
  let bytes;
  try {
    info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o400 ||
      info.size > 16 * 1024
    )
      fail("PREPARATION_ARTIFACT_UNTRUSTED");
    bytes = await readFile(path);
  } catch (error) {
    if (error.message.startsWith("G08_MIGRATIONS")) throw error;
    fail("PREPARATION_ARTIFACT_MISSING");
  }
  const secretsPath = join(root, "secrets/platform.secrets.sops.yaml");
  const secretsBytes = await readFile(secretsPath);
  const { validateMigrationPreparationArtifact } =
    await import("../../../../tools/config-bootstrap/index.mjs");
  const prep = validateMigrationPreparationArtifact(
    JSON.parse(bytes.toString("utf8")),
    context,
    hash(secretsBytes),
  );
  assertPreparationAncestor(root, prep.candidateSha, context.candidateSha);
  return { prep, sha256: hash(bytes), path };
}

export async function readApprovedMigrationTarget(context, evidenceDir) {
  const path = join(
    evidenceDir,
    "gates/migrations/artifacts/approved-target.json",
  );
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o400 ||
      info.size > 4096
    )
      fail("APPROVED_TARGET_INVALID");
    const bytes = await file.readFile();
    const after = await file.stat();
    const value = JSON.parse(bytes.toString("utf8"));
    if (
      after.dev !== info.dev ||
      after.ino !== info.ino ||
      after.size !== info.size ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !==
        "baseConfigSha256,candidateSha,runId,schemaVersion,systemIdentifier" ||
      value.schemaVersion !== 1 ||
      value.runId !== context.runId ||
      value.candidateSha !== context.candidateSha ||
      value.baseConfigSha256 !== context.baseConfigSha256 ||
      typeof value.systemIdentifier !== "string" ||
      !/^[0-9]{1,20}$/u.test(value.systemIdentifier)
    )
      fail("APPROVED_TARGET_INVALID");
    return {
      systemIdentifier: value.systemIdentifier,
      dev: info.dev,
      ino: info.ino,
      sha256: hash(bytes),
    };
  } catch (error) {
    if (error?.[MIGRATION_FAILURE]) throw error;
    fail("APPROVED_TARGET_INVALID");
  } finally {
    await file?.close();
  }
}

function migrationId(file) {
  const id = file.replace(/\.sql$/u, "");
  if (!/^\d{4}_[a-z][a-z0-9_]*$/u.test(id)) fail("MIGRATION_FILENAME_INVALID");
  return id;
}

async function loadCurrentMigrations(root, database, migrationChecksum) {
  const directory = resolve(root, database.migrationPath);
  if (!directory.startsWith(`${resolve(root)}/`))
    fail("MIGRATION_PATH_INVALID");
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length !== OWNERS[database.owner]?.current)
    fail("MIGRATION_INVENTORY_MISMATCH", database.owner);
  return Promise.all(
    files.map(async (file) => {
      const id = migrationId(file);
      const sql = await readFile(join(directory, file), "utf8");
      return { id, sql, checksum: migrationChecksum(sql) };
    }),
  );
}

function historicalMigrations(root, database, migrationChecksum) {
  const paths = git(root, [
    "ls-tree",
    "-r",
    "--name-only",
    ACCEPTED_PREFIX_COMMIT,
    "--",
    database.migrationPath,
  ])
    .split("\n")
    .filter((path) => path.endsWith(".sql"));
  if (paths.length !== OWNERS[database.owner]?.prefix)
    fail("HISTORICAL_PREFIX_MISMATCH", database.owner);
  return paths.map((path) => {
    const sql = gitFile(root, path);
    return {
      id: migrationId(path.slice(path.lastIndexOf("/") + 1)),
      sql,
      checksum: migrationChecksum(sql),
    };
  });
}

function assertAcceptedPrefix(current, prefix, owner) {
  const currentById = new Map(
    current.map((migration) => [migration.id, migration.checksum]),
  );
  if (
    prefix.some(
      (migration) => currentById.get(migration.id) !== migration.checksum,
    ) ||
    current
      .slice(0, prefix.length)
      .some((migration, index) => migration.id !== prefix[index].id)
  )
    fail("HISTORICAL_CHECKSUM_MISMATCH", owner);
}

function quoted(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    fail("UNSAFE_IDENTIFIER");
  return `"${value}"`;
}

const schemaFactsSql = `
WITH target AS (SELECT oid, nspname FROM pg_namespace WHERE nspname = $1), facts AS (
  SELECT 'schema'::text AS kind, nspname AS name,
         jsonb_build_object('owner', pg_get_userbyid(nspowner)) AS fact
    FROM pg_namespace WHERE nspname = $1
  UNION ALL
  SELECT 'relation', relation.relname,
         jsonb_build_object('kind', relation.relkind, 'owner', pg_get_userbyid(relation.relowner),
           'persistence', relation.relpersistence, 'options', relation.reloptions,
           'rls', relation.relrowsecurity, 'forceRls', relation.relforcerowsecurity,
           'view', CASE WHEN relation.relkind IN ('v','m') THEN pg_get_viewdef(relation.oid, true) END)
    FROM pg_class relation JOIN target ON target.oid = relation.relnamespace
   WHERE relation.relkind IN ('r','p','v','m','S','f')
  UNION ALL
  SELECT 'column', relation.relname || '.' || attribute.attname,
         jsonb_build_object('position', attribute.attnum, 'type', format_type(attribute.atttypid, attribute.atttypmod),
           'notNull', attribute.attnotnull, 'default', pg_get_expr(default_value.adbin, default_value.adrelid),
           'identity', attribute.attidentity, 'generated', attribute.attgenerated,
           'collation', CASE WHEN attribute.attcollation = 0 THEN NULL ELSE attribute.attcollation::regcollation::text END,
           'storage', attribute.attstorage, 'compression', attribute.attcompression)
    FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN target ON target.oid = relation.relnamespace
    LEFT JOIN pg_attrdef default_value ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
   WHERE attribute.attnum > 0 AND NOT attribute.attisdropped AND relation.relkind IN ('r','p','v','m','f')
  UNION ALL
  SELECT 'constraint', relation.relname || '.' || constraint_row.conname,
         jsonb_build_object('type', constraint_row.contype, 'definition', pg_get_constraintdef(constraint_row.oid, true),
           'deferrable', constraint_row.condeferrable, 'deferred', constraint_row.condeferred, 'validated', constraint_row.convalidated)
    FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN target ON target.oid = relation.relnamespace
  UNION ALL
  SELECT 'index', relation.relname || '.' || index_relation.relname,
         jsonb_build_object('definition', pg_get_indexdef(index_row.indexrelid), 'valid', index_row.indisvalid,
           'ready', index_row.indisready, 'unique', index_row.indisunique, 'primary', index_row.indisprimary)
    FROM pg_index index_row JOIN pg_class relation ON relation.oid = index_row.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN target ON target.oid = relation.relnamespace
  UNION ALL
  SELECT 'sequence', relation.relname,
         jsonb_build_object('type', sequence.seqtypid::regtype::text, 'start', sequence.seqstart,
           'increment', sequence.seqincrement, 'min', sequence.seqmin, 'max', sequence.seqmax,
           'cache', sequence.seqcache, 'cycle', sequence.seqcycle)
    FROM pg_sequence sequence JOIN pg_class relation ON relation.oid = sequence.seqrelid
    JOIN target ON target.oid = relation.relnamespace
  UNION ALL
  SELECT 'function', procedure_row.proname || '(' || pg_get_function_identity_arguments(procedure_row.oid) || ')',
         jsonb_build_object('definition', pg_get_functiondef(procedure_row.oid), 'owner', pg_get_userbyid(procedure_row.proowner),
           'securityDefiner', procedure_row.prosecdef, 'volatility', procedure_row.provolatile,
           'config', procedure_row.proconfig, 'language', language.lanname)
    FROM pg_proc procedure_row JOIN target ON target.oid = procedure_row.pronamespace
    JOIN pg_language language ON language.oid = procedure_row.prolang
  UNION ALL
  SELECT 'trigger', relation.relname || '.' || trigger_row.tgname,
         jsonb_build_object('definition', pg_get_triggerdef(trigger_row.oid, true), 'enabled', trigger_row.tgenabled)
    FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN target ON target.oid = relation.relnamespace WHERE NOT trigger_row.tgisinternal
  UNION ALL
  SELECT 'type', type_row.typname,
         jsonb_build_object('kind', type_row.typtype, 'definition', format_type(type_row.oid, NULL),
           'base', CASE WHEN type_row.typbasetype = 0 THEN NULL ELSE type_row.typbasetype::regtype::text END,
           'notNull', type_row.typnotnull, 'default', type_row.typdefault, 'enum',
           (SELECT jsonb_agg(enum.enumlabel ORDER BY enum.enumsortorder) FROM pg_enum enum WHERE enum.enumtypid = type_row.oid))
    FROM pg_type type_row JOIN target ON target.oid = type_row.typnamespace
   WHERE type_row.typtype IN ('d','e')
  UNION ALL
  SELECT 'policy', relation.relname || '.' || policy.polname,
         jsonb_build_object('command', policy.polcmd, 'permissive', policy.polpermissive,
           'roles', policy.polroles, 'using', pg_get_expr(policy.polqual, policy.polrelid),
           'check', pg_get_expr(policy.polwithcheck, policy.polrelid))
    FROM pg_policy policy JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN target ON target.oid = relation.relnamespace
)
SELECT kind, name, fact FROM facts ORDER BY kind, name, fact::text`;

const aclFactsSql = `
WITH target AS (SELECT oid, nspname FROM pg_namespace WHERE nspname = $1), facts AS (
  SELECT 'schema'::text AS kind, nspname AS name, COALESCE(nspacl::text, '') AS acl
    FROM pg_namespace WHERE nspname = $1
  UNION ALL
  SELECT 'relation', relation.relname, COALESCE(relation.relacl::text, '')
    FROM pg_class relation JOIN target ON target.oid = relation.relnamespace
  UNION ALL
  SELECT 'column', relation.relname || '.' || attribute.attname, COALESCE(attribute.attacl::text, '')
    FROM pg_attribute attribute JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN target ON target.oid = relation.relnamespace
   WHERE attribute.attnum > 0 AND NOT attribute.attisdropped AND attribute.attacl IS NOT NULL
  UNION ALL
  SELECT 'function', procedure_row.proname || '(' || pg_get_function_identity_arguments(procedure_row.oid) || ')', COALESCE(procedure_row.proacl::text, '')
    FROM pg_proc procedure_row JOIN target ON target.oid = procedure_row.pronamespace
  UNION ALL
  SELECT 'type', type_row.typname, COALESCE(type_row.typacl::text, '')
    FROM pg_type type_row JOIN target ON target.oid = type_row.typnamespace
)
SELECT kind, name, acl FROM facts ORDER BY kind, name, acl`;

async function query(database, sql, parameters = []) {
  const { defineStatement } =
    await import("../../../../packages/platform-database/dist/owner.js");
  const { withTransaction } =
    await import("../../../../packages/platform-database/dist/index.js");
  const statement = defineStatement(database, sql);
  return withTransaction(
    database,
    { mode: "background" },
    async (transaction) => (await statement(transaction, parameters)).rows,
  );
}

async function migrationDatabase(database, credentials, config, modules) {
  const service = config.services[database.migrationOwner];
  if (!service?.dbPool)
    fail("MIGRATOR_SERVICE_CONFIG_MISSING", database.migrationOwner);
  const instance = modules.createDatabase({
    owner: database.migrationOwner,
    database: database.name,
    allowedDatabase: database.name,
    host: config.postgres.host,
    port: config.postgres.port,
    user: credentials.username,
    password: credentials.password,
    ssl: false,
    pool: service.dbPool,
    shutdownGraceMs: config.platform.shutdownGraceMs,
  });
  await instance.resource.start(new AbortController().signal);
  return instance;
}

async function ledger(database, schema) {
  return query(
    database,
    `SELECT id, btrim(checksum) AS checksum FROM ${quoted(schema)}.platform_schema_migrations ORDER BY id`,
  );
}

async function schemaState(database, schema, execute = query) {
  const [facts, acl] = await Promise.all([
    execute(database, schemaFactsSql, [schema]),
    execute(database, aclFactsSql, [schema]),
  ]);
  if (!facts.length) fail("OWNER_SCHEMA_MISSING", schema);
  return {
    schemaFingerprint: hash(JSON.stringify(facts)),
    aclFingerprint: hash(JSON.stringify(acl)),
  };
}

export function assertRoleMapGrantRows(roleDatabase, actual) {
  const expected = new Set();
  for (const entry of roleDatabase.runtimeRoles) {
    for (const [table, privileges] of Object.entries(entry.tables)) {
      for (const privilege of privileges) {
        if (privilege === "UPDATE" && entry.columnUpdates?.[table]) continue;
        expected.add(`${entry.role}\0table\0${table}\0${privilege}\0\0false`);
      }
    }
    for (const [table, columns] of Object.entries(entry.columnUpdates ?? {}))
      for (const column of columns)
        expected.add(
          `${entry.role}\0column\0${table}\0UPDATE\0${column}\0false`,
        );
  }
  const granted = new Set();
  for (const row of actual) {
    const tuple = `${row.grantee}\0${row.grant_scope}\0${row.table_name}\0${row.privilege_type}\0${row.column_name ?? ""}\0${row.is_grantable === true}`;
    if (!expected.has(tuple))
      fail(
        "ROLE_MAP_EXTRA_GRANT",
        `${row.grantee}:${row.grant_scope}:${row.table_name}:${row.privilege_type}${row.column_name ? `:${row.column_name}` : ""}`,
      );
    granted.add(tuple);
  }
  for (const tuple of expected)
    if (!granted.has(tuple))
      fail("ROLE_MAP_GRANT_MISSING", tuple.replaceAll("\0", ":"));
}

async function assertRoleMapGrants(
  database,
  schema,
  roleDatabase,
  execute = query,
) {
  const run = (sql, parameters = []) => execute(database, sql, parameters);
  const schemaRoles = roleDatabase.runtimeRoles.map(({ role }) => role);
  const allRoles = [roleDatabase.migratorRole, ...schemaRoles];
  const databaseRows = await run(
    `SELECT rolname,
       has_database_privilege(rolname, current_database(), 'CONNECT') AS connect,
       has_database_privilege(rolname, current_database(), 'TEMPORARY') AS temporary,
       has_database_privilege(rolname, current_database(), 'CREATE') AS create_privilege
     FROM unnest($1::text[]) AS roles(rolname) ORDER BY rolname`,
    [allRoles],
  );
  if (
    databaseRows.length !== allRoles.length ||
    databaseRows.some(
      (row) =>
        row.connect !== true ||
        row.temporary !== true ||
        row.create_privilege !== (row.rolname === roleDatabase.migratorRole),
    )
  )
    fail("DATABASE_GRANT_MISMATCH", schema);
  const roleSettings = await run(
    `SELECT role.rolname, setting.setconfig
       FROM pg_db_role_setting setting JOIN pg_roles role ON role.oid=setting.setrole
      WHERE setting.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND role.rolname = ANY($1::text[]) ORDER BY role.rolname`,
    [allRoles],
  );
  if (
    roleSettings.length !== allRoles.length ||
    roleSettings.some(
      (row) =>
        JSON.stringify(row.setconfig) !==
        JSON.stringify([`search_path=${schema}, pg_catalog`]),
    )
  )
    fail("DATABASE_ROLE_SETTING_MISMATCH", schema);
  const schemaRows = await run(
    "SELECT rolname, has_schema_privilege(rolname, $1, 'USAGE') AS usage FROM unnest($2::text[]) AS roles(rolname) ORDER BY rolname",
    [schema, schemaRoles],
  );
  if (
    schemaRows.length !== schemaRoles.length ||
    schemaRows.some((row) => row.usage !== true)
  )
    fail("SCHEMA_GRANT_MISMATCH", schema);
  const actual = await run(
    `WITH target AS (
       SELECT oid FROM pg_namespace WHERE nspname = $1
     ), runtime_roles AS (
       SELECT oid FROM pg_roles WHERE rolname = ANY($2::text[])
     )
     SELECT 'table'::text AS grant_scope,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            relation.relname AS table_name,
            acl.privilege_type,
            NULL::text AS column_name,
            acl.is_grantable
       FROM pg_class relation
       CROSS JOIN target
       CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      WHERE relation.relnamespace = target.oid
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND (acl.grantee = 0 OR acl.grantee IN (SELECT oid FROM runtime_roles))
     UNION ALL
     SELECT 'column'::text AS grant_scope,
            CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
            relation.relname AS table_name,
            acl.privilege_type,
            attribute.attname::text AS column_name,
            acl.is_grantable
       FROM pg_attribute attribute
       JOIN pg_class relation ON relation.oid = attribute.attrelid
       CROSS JOIN target
       CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
      WHERE relation.relnamespace = target.oid
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
        AND (acl.grantee = 0 OR acl.grantee IN (SELECT oid FROM runtime_roles))
      ORDER BY grantee, table_name, privilege_type, grant_scope, column_name`,
    [schema, schemaRoles],
  );
  assertRoleMapGrantRows(roleDatabase, actual);
}

async function applyOwnerDatabase(database, set, mode, modules) {
  const migrationOptions = {
    schema: database.roleMap.schema,
    ledgerTable: "platform_schema_migrations",
    lockKey: `g08:${database.owner}:migration-oracle:v1`,
  };
  const applied = await modules.applyMigrations(
    database.instance,
    set,
    migrationOptions,
  );
  const rows = await ledger(database.instance, database.roleMap.schema);
  const expectedRows = set.map(({ id, checksum }) => ({ id, checksum }));
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows))
    fail("LEDGER_MISMATCH", database.owner);
  await assertRoleMapGrants(
    database.instance,
    database.roleMap.schema,
    database.roleMap,
  );
  const schema = await schemaState(database.instance, database.roleMap.schema);
  const noOp = await modules.applyMigrations(
    database.instance,
    set,
    migrationOptions,
  );
  if (noOp.length !== 0) fail("MIGRATION_RERUN_NOT_NOOP", database.owner);
  const after = await schemaState(database.instance, database.roleMap.schema);
  const afterLedger = await ledger(database.instance, database.roleMap.schema);
  if (
    JSON.stringify(rows) !== JSON.stringify(afterLedger) ||
    JSON.stringify(schema) !== JSON.stringify(after)
  )
    fail("MIGRATION_RERUN_CHANGED_STATE", database.owner);
  if (
    (mode === "clean" || mode === "boundaries") &&
    JSON.stringify(applied) !== JSON.stringify(set.map(({ id }) => id))
  )
    fail("CLEAN_MIGRATION_SET_MISMATCH", database.owner);
  return {
    owner: database.owner,
    database: database.name,
    migrationCount: rows.length,
    ledgerSha256: hash(JSON.stringify(rows)),
    ...schema,
  };
}

async function verifyColumnUpdateRenderRejects({
  database,
  resources,
  admin,
  credentials,
  config,
  expectedSystemIdentifier,
  launchIdentity,
  applied,
}) {
  if (
    database.name !== deriveLaunchDatabaseName(launchIdentity, database.owner)
  )
    fail("COLUMN_UPDATE_TEST_TARGET_NOT_DERIVED", database.owner);
  const resource = resources.find(
    (entry) => entry.database.name === database.name,
  );
  if (
    !resource ||
    resource.state !== "created-acknowledged" ||
    resource.database.owner !== database.owner
  )
    fail("COLUMN_UPDATE_TEST_TARGET_NOT_ACKNOWLEDGED", database.owner);

  await probeServerIdentity(config, credentials, expectedSystemIdentifier);
  await assertOwnedRunDatabase(
    admin,
    database,
    expectedSystemIdentifier,
    credentials.username,
  );
  const client = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: database.name,
    user: credentials.username,
    password: credentials.password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    await assertServerIdentity(
      client,
      expectedSystemIdentifier,
      credentials.username,
      database.name,
    );
    const directQuery = async (_database, sql, parameters = []) =>
      (await client.query(sql, parameters)).rows;
    const schema = database.roleMap.schema;
    await client.query(`SET search_path = ${quoted(schema)}, pg_catalog`);
    const baseline = await schemaState(client, schema, directQuery);
    if (
      baseline.schemaFingerprint !== applied.schemaFingerprint ||
      baseline.aclFingerprint !== applied.aclFingerprint
    )
      fail("COLUMN_UPDATE_TEST_BASELINE_CHANGED", database.owner);
    await assertRoleMapGrants(client, schema, database.roleMap, directQuery);
    try {
      await client.query(renderDatabaseSql(database.roleMap));
    } catch {
      fail("COLUMN_UPDATE_TEST_CLEAN_RENDER_FAILED", database.owner);
    }
    await assertRoleMapGrants(client, schema, database.roleMap, directQuery);
    const afterCleanRender = await schemaState(client, schema, directQuery);
    if (
      afterCleanRender.schemaFingerprint !== baseline.schemaFingerprint ||
      afterCleanRender.aclFingerprint !== baseline.aclFingerprint
    )
      fail("COLUMN_UPDATE_TEST_CLEAN_RENDER_CHANGED_STATE", database.owner);

    for (const runtime of database.roleMap.runtimeRoles) {
      for (const [table, allowedColumns] of Object.entries(
        runtime.columnUpdates ?? {},
      )) {
        const result = await client.query(
          `SELECT attribute.attname::text AS column_name
             FROM pg_attribute attribute
            WHERE attribute.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND NOT (attribute.attname::text = ANY($3::text[]))
            ORDER BY attribute.attnum
            LIMIT 1`,
          [schema, table, allowedColumns],
        );
        const column = result.rows[0]?.column_name;
        if (!column)
          fail("COLUMN_UPDATE_TEST_COLUMN_UNAVAILABLE", database.owner);

        let expectedRejection = false;
        let setupFailed = false;
        let transactionAttempted = false;
        let rollbackFailed = false;
        try {
          transactionAttempted = true;
          await client.query("BEGIN");
          await client.query(
            `GRANT UPDATE (${quoted(column)}) ON TABLE ${quoted(schema)}.${quoted(table)} TO ${quoted(runtime.role)}`,
          );
          try {
            await client.query(renderDatabaseSql(database.roleMap));
          } catch (error) {
            expectedRejection =
              error?.code === "P0001" &&
              typeof error.message === "string" &&
              error.message.startsWith("unexpected column UPDATE grant on ");
          }
        } catch {
          setupFailed = true;
        } finally {
          if (transactionAttempted) {
            try {
              await client.query("ROLLBACK");
            } catch {
              rollbackFailed = true;
            }
          }
        }
        if (rollbackFailed)
          fail("COLUMN_UPDATE_TEST_ROLLBACK_FAILED", database.owner);
        if (setupFailed)
          fail("COLUMN_UPDATE_TEST_SETUP_FAILED", database.owner);
        if (!expectedRejection)
          fail("COLUMN_UPDATE_TEST_REJECTION_NOT_CONFIRMED", database.owner);

        await assertRoleMapGrants(
          client,
          schema,
          database.roleMap,
          directQuery,
        );
        const afterRollback = await schemaState(client, schema, directQuery);
        if (
          afterRollback.schemaFingerprint !== baseline.schemaFingerprint ||
          afterRollback.aclFingerprint !== baseline.aclFingerprint
        )
          fail("COLUMN_UPDATE_TEST_ROLLBACK_CHANGED_STATE", database.owner);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function seedCatalog(database) {
  await query(
    database,
    `INSERT INTO catalog.supplier_snapshots
    (snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at)
    VALUES ('snp_00000000000000000000000009','sup_00000000000000000000000000','legacy-export','Active',0,1,1,0,repeat('a',64),clock_timestamp())`,
  );
  await query(
    database,
    `INSERT INTO catalog.products(snapshot_ref,product_ref,display_name,display_name_sort_key)
    VALUES ('snp_00000000000000000000000009','prd_00000000000000000000000009','Before upgrade','before upgrade')`,
  );
  await query(
    database,
    `INSERT INTO catalog.variants(snapshot_ref,variant_ref,product_ref,unit)
    VALUES ('snp_00000000000000000000000009','var_00000000000000000000000009','prd_00000000000000000000000009','piece')`,
  );
  await query(
    database,
    `UPDATE catalog.catalog_state SET active_snapshot_ref='snp_00000000000000000000000009',active_snapshot_revision=1,active_content_hash=repeat('a',64) WHERE id=true`,
  );
}

async function seedPricing(database) {
  await query(
    database,
    `INSERT INTO pricing.pricing_quotes
    (quote_ref,customer_ref,policy_version_ref,catalog_snapshot_revision,currency,total_minor,canonical_hash,internal_proof_hash,created_at,expires_at,actor_ref,correlation_id,request_hash)
    VALUES ('prq_00000000000000000000000001','cus_00000000000000000000000001','pvr_00000000000000000000000001',1,'RUB',100,repeat('a',64),repeat('b',64),clock_timestamp(),clock_timestamp()+interval '10 minutes','g08-forward','00000000-0000-4000-8000-000000000008',repeat('c',64))`,
  );
  await query(
    database,
    `INSERT INTO pricing.pricing_quote_lines
    (quote_ref,line_number,product_ref,variant_ref,product_display_name,offer_ref,catalog_snapshot_revision,mapping_revision,unit,quantity_milli,supplier_unit_minor,markup_basis_points,minimum_margin_minor,unit_minor,line_total_minor,currency)
    VALUES ('prq_00000000000000000000000001',1,'prd_00000000000000000000000001','var_00000000000000000000000001','Legacy product','off_00000000000000000000000001',1,1,'piece',1000,100,0,0,100,100,'RUB')`,
  );
}

async function seedOrders(database) {
  const orderRef = "ord_00000000000000000000000001";
  const messageId = "g08-forward-message";
  const correlationId = "g08-forward-correlation";
  const traceparent = "00-00000000000000000000000000000001-0000000000000001-01";
  const confirmedAt = "2026-10-25T10:00:00.000Z";
  const payload = {
    orderRef,
    orderVersion: "2",
    customerRef: "cus_00000000000000000000000001",
    confirmedAt,
    contributionRevision: "1",
  };
  const envelope = {
    envelopeVersion: "1",
    messageId,
    messageType: "OrderConfirmed.v1",
    occurredAt: confirmedAt,
    producer: "orders-service",
    correlationId,
    causationId: null,
    traceparent,
    aggregate: { type: "Order", ref: orderRef, version: "2" },
    payload,
  };
  const envelopeBytes = Buffer.from(canonicalJson(envelope), "utf8");
  const envelopeHash = createHash("sha256").update(envelopeBytes).digest("hex");
  await query(
    database,
    `INSERT INTO orders.orders
    (order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref)
    VALUES ($1,'cus_00000000000000000000000001',1,'Forward fixture','Active',repeat('a',64),'g08-forward','g08-forward')`,
    [orderRef],
  );
  await query(
    database,
    `INSERT INTO orders.order_items
    (order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
    VALUES ('ord_00000000000000000000000001','itm_00000000000000000000000001',1,'prd_00000000000000000000000001','var_00000000000000000000000001','Legacy product','piece',1000,'prq_00000000000000000000000001',1,repeat('b',64),repeat('c',64),clock_timestamp()+interval '10 minutes','pvr_00000000000000000000000001',1,1,'off_00000000000000000000000001',100,100,'RUB')`,
  );
  await query(
    database,
    `UPDATE orders.orders SET status='Confirmed',version=2,currency='RUB',confirmed_at=$2,updated_at=$2 WHERE order_ref=$1`,
    [orderRef, confirmedAt],
  );
  await query(
    database,
    `INSERT INTO orders.outbox_messages
    (message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,lease_until)
    VALUES ($1,'OrderConfirmed.v1','coffee.orders.lifecycle.v1',$2::text,1,'2',$2::text,'1',$3,$4::char(64),$5::jsonb,$6::jsonb,$7::char(64),$8::timestamptz,$9,NULL,$10,$11::timestamptz)`,
    [
      messageId,
      orderRef,
      envelopeBytes,
      envelopeHash,
      JSON.stringify(envelope),
      JSON.stringify(payload),
      canonicalRequestHash(envelope),
      confirmedAt,
      correlationId,
      traceparent,
      "2026-10-25T10:01:00.000Z",
    ],
  );
}

export async function fixtureState(database, owner, afterSuffix = false) {
  if (owner === "catalog")
    return query(
      database,
      `SELECT jsonb_build_object('snapshot',to_jsonb(snapshot),'product','{"category_name":null}'::jsonb || to_jsonb(product),'variant',to_jsonb(variant),'state',to_jsonb(state)) AS row
      FROM catalog.supplier_snapshots snapshot JOIN catalog.products product USING(snapshot_ref)
      JOIN catalog.variants variant USING(snapshot_ref,product_ref) CROSS JOIN catalog.catalog_state state
      WHERE snapshot.snapshot_ref='snp_00000000000000000000000009'`,
    );
  if (owner === "pricing")
    return query(
      database,
      `SELECT jsonb_build_object(
        'quote_ref',line.quote_ref,'line_number',line.line_number,'product_ref',line.product_ref,
        'variant_ref',line.variant_ref,'product_display_name',line.product_display_name,
        'offer_ref',line.offer_ref,'catalog_snapshot_revision',line.catalog_snapshot_revision,
        'mapping_revision',line.mapping_revision,'unit',line.unit,'quantity_milli',line.quantity_milli,
        'supplier_unit_minor',line.supplier_unit_minor,'markup_basis_points',line.markup_basis_points,
        'minimum_margin_minor',line.minimum_margin_minor,'unit_minor',line.unit_minor,
        'line_total_minor',line.line_total_minor,'currency',line.currency) AS row
      ${afterSuffix ? ", line.source_grind_key_hash IS NULL AND line.grind_display_name IS NULL AS grind_columns_null" : ""}
      FROM pricing.pricing_quote_lines line WHERE quote_ref='prq_00000000000000000000000001'`,
    );
  if (owner === "orders")
    return query(
      database,
      `SELECT jsonb_build_object(
        'order_ref',item.order_ref,'item_ref',item.item_ref,'line_position',item.line_position,
        'product_ref',item.product_ref,'variant_ref',item.variant_ref,
        'product_display_name',item.product_display_name,'unit',item.unit,
        'quantity_milli',item.quantity_milli,'quote_ref',item.quote_ref,
        'quote_line_number',item.quote_line_number,'quote_hash',item.quote_hash,
        'internal_proof_hash',item.internal_proof_hash,'quote_expires_at',item.quote_expires_at,
        'policy_version_ref',item.policy_version_ref,
        'catalog_snapshot_revision',item.catalog_snapshot_revision,
        'mapping_revision',item.mapping_revision,'offer_ref',item.offer_ref,
        'unit_minor',item.unit_minor,'line_total_minor',item.line_total_minor,
        'currency',item.currency,'created_at',item.created_at,'updated_at',item.updated_at) AS row,
      jsonb_build_object(
        'message_id',message.message_id,'message_type',message.message_type,'topic',message.topic,
        'aggregate_ref',message.aggregate_ref,'aggregate_sequence',message.aggregate_sequence,
        'owner_version',message.owner_version,'partition_key',message.partition_key,
        'schema_version',message.schema_version,'envelope_bytes',message.envelope_bytes,
        'envelope_hash',message.envelope_hash,'envelope',message.envelope,'payload',message.payload,
        'payload_hash',message.payload_hash,'occurred_at',message.occurred_at,
        'correlation_id',message.correlation_id,'causation_id',message.causation_id,
        'traceparent',message.traceparent,'state',message.state,'lease_owner',message.lease_owner,
        'lease_token',message.lease_token,'lease_until',message.lease_until,
        'attempt',message.attempt,'next_attempt_at',message.next_attempt_at,
        'last_error',message.last_error,'published_at',message.published_at,
        'quarantined_at',message.quarantined_at) AS outbox
      ${afterSuffix ? ", item.source_grind_key_hash IS NULL AND item.grind_display_name IS NULL AS grind_columns_null, message.order_ref AS outbox_order_ref" : ""}
      FROM orders.order_items item CROSS JOIN orders.outbox_messages message
      WHERE item.order_ref='ord_00000000000000000000000001'
        AND message.message_id='g08-forward-message'`,
    );
  return [];
}

async function seedForwardFixtures(database) {
  if (database.owner === "catalog") await seedCatalog(database.instance);
  if (database.owner === "pricing") await seedPricing(database.instance);
  if (database.owner === "orders") await seedOrders(database.instance);
  const before = await fixtureState(database.instance, database.owner);
  if (
    ["catalog", "pricing", "orders"].includes(database.owner) &&
    before.length !== 1
  )
    fail("FORWARD_FIXTURE_MISSING", database.owner);
  return before;
}

export async function assertForwardFixtures(database, before) {
  if (!["catalog", "pricing", "orders"].includes(database.owner)) return;
  const after = await fixtureState(database.instance, database.owner, true);
  if (
    after.length !== before.length ||
    after.some(
      (row, index) =>
        JSON.stringify(row.row) !== JSON.stringify(before[index].row) ||
        (database.owner === "orders" &&
          JSON.stringify(row.outbox) !== JSON.stringify(before[index].outbox)),
    )
  )
    fail("FORWARD_FIXTURE_CHANGED", database.owner);
  if (
    database.owner !== "catalog" &&
    after.some((row) => row.grind_columns_null !== true)
  )
    fail("FORWARD_LEGACY_GRIND_NOT_NULL", database.owner);
  if (
    database.owner === "orders" &&
    after.some(
      (row) => row.outbox_order_ref !== "ord_00000000000000000000000001",
    )
  )
    fail("FORWARD_OUTBOX_ORDER_REFERENCE_MISMATCH", database.owner);
}

async function assertServerIdentity(
  client,
  expected,
  username,
  expectedDatabase = "postgres",
) {
  const result =
    await client.query(`SELECT current_database() AS database, current_user AS username,
    split_part(current_setting('server_version'), ' ', 1) AS version,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`);
  const row = result.rows[0];
  if (
    row?.database !== expectedDatabase ||
    row.username !== username ||
    row.version !== "17.11" ||
    row.system_identifier !== expected ||
    row.superuser !== true
  )
    fail("SERVER_IDENTITY_MISMATCH");
  return row;
}

async function assertPreparedRoles(client, roles) {
  const result = await client.query(
    `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconnlimit
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
    [roles],
  );
  const rows = result.rows;
  if (rows.length !== roles.length) fail("PREPARED_ROLE_INVENTORY_MISMATCH");
  for (const row of rows) {
    const attributes = {
      login: row.rolcanlogin,
      superuser: row.rolsuper,
      createDb: row.rolcreatedb,
      createRole: row.rolcreaterole,
      inherit: row.rolinherit,
      replication: row.rolreplication,
      bypassRls: row.rolbypassrls,
      connectionLimit: row.rolconnlimit,
    };
    if (JSON.stringify(attributes) !== JSON.stringify(ROLE_ATTRIBUTES))
      fail("PREPARED_ROLE_ATTRIBUTES_MISMATCH", row.rolname);
  }
}

async function assertTargetsAbsent(client, owners) {
  const result = await client.query(
    "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname",
    [owners.map(({ name }) => name)],
  );
  if (result.rows.length) fail("RUN_DATABASE_ALREADY_EXISTS");
}

async function assertOwnedRunDatabase(
  client,
  database,
  systemIdentifier,
  username,
) {
  await assertServerIdentity(client, systemIdentifier, username);
  const result = await client.query(
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
    [database.name],
  );
  if (
    result.rows[0]?.datname !== database.name ||
    result.rows[0]?.owner !== database.migratorRole ||
    DENIED_DATABASES.has(result.rows[0]?.datname)
  )
    fail("RUN_DATABASE_OWNERSHIP_MISMATCH", database.owner);
}

export async function createMigrationDatabase(
  database,
  resources,
  create,
  inspectOutcome,
) {
  const resource = { database, state: "create-pending" };
  resources.push(resource);
  try {
    await create();
    resource.state = "created-acknowledged";
    return resource;
  } catch (error) {
    try {
      const outcome = await inspectOutcome();
      resource.inspection = outcome;
    } catch {
      resource.inspection = null;
    }
    resource.state = "ambiguous";
    throw error;
  }
}

export async function cleanupMigrationDatabases(resources, removeOwned) {
  const removed = [];
  const retained = [];
  for (const resource of [...resources].reverse()) {
    if (resource.state !== "created-acknowledged") {
      retained.push(resource.database.name);
      continue;
    }
    try {
      await removeOwned(resource.database);
      removed.push(resource.database.name);
    } catch {
      retained.push(resource.database.name);
    }
  }
  return {
    verified: retained.length === 0,
    removed: sorted(removed),
    retained: sorted(retained),
  };
}

async function probeServerIdentity(
  config,
  credentials,
  expectedSystemIdentifier,
) {
  const client = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: "postgres",
    user: credentials.username,
    password: credentials.password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    await assertServerIdentity(
      client,
      expectedSystemIdentifier,
      credentials.username,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

async function setupDatabase(
  admin,
  database,
  credentials,
  config,
  resources,
  expectedSystemIdentifier,
) {
  await probeServerIdentity(config, credentials, expectedSystemIdentifier);
  await createMigrationDatabase(
    database,
    resources,
    () =>
      admin.query(
        `CREATE DATABASE ${quoted(database.name)} OWNER ${quoted(database.migratorRole)} TEMPLATE template0`,
      ),
    async () => {
      const inspection = new Client({
        host: config.postgres.host,
        port: config.postgres.port,
        database: "postgres",
        user: credentials.username,
        password: credentials.password,
        ssl: false,
        connectionTimeoutMillis: 3_000,
      });
      try {
        await inspection.connect();
        await assertServerIdentity(
          inspection,
          expectedSystemIdentifier,
          credentials.username,
        );
        const result = await inspection.query(
          "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
          [database.name],
        );
        if (result.rows.length === 0) return { exists: false };
        return { exists: true, owner: result.rows[0].owner };
      } finally {
        await inspection.end().catch(() => {});
      }
    },
  );
  const client = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: database.name,
    user: credentials.username,
    password: credentials.password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  try {
    await client.connect();
    await probeServerIdentity(config, credentials, expectedSystemIdentifier);
    await client.query(renderDatabaseSql(database.roleMap));
  } finally {
    await client.end().catch(() => {});
  }
}

async function cleanup(
  admin,
  resources,
  config,
  credentials,
  expectedSystemIdentifier,
) {
  return cleanupMigrationDatabases(resources, async (database) => {
    await probeServerIdentity(config, credentials, expectedSystemIdentifier);
    await assertOwnedRunDatabase(
      admin,
      database,
      expectedSystemIdentifier,
      credentials.username,
    );
    await admin.query(`DROP DATABASE ${quoted(database.name)}`);
    const remaining = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [database.name],
    );
    if (remaining.rowCount !== 0) fail("CLEANUP_NOT_CONFIRMED", database.owner);
  });
}

function retainedResourceDetails(resources, retained) {
  const byName = new Map(
    resources.map((resource) => [resource.database.name, resource]),
  );
  return retained
    .map((name) => {
      const owner = byName.get(name)?.inspection?.owner;
      return `${name}(owner=${typeof owner === "string" ? owner : "unknown"})`;
    })
    .join(",");
}

async function openAdmin({ root, contextPath, owner, prep, config }) {
  const { readMigrationCredential } =
    await import("../../../../tools/config-bootstrap/index.mjs");
  const credential = await readMigrationCredential({
    root,
    contextPath,
    owner,
    kind: "admin",
    expectedSystemIdentifier: prep.postgres.systemIdentifier,
  });
  const client = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    database: "postgres",
    user: credential.username,
    password: credential.password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
  });
  await client.connect();
  return { client, credential };
}

async function runStage(
  mode,
  {
    root = ROOT,
    contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    verifyBoundaries,
  } = {},
) {
  if (mode === "boundaries" && typeof verifyBoundaries !== "function")
    fail("BOUNDARY_VERIFIER_REQUIRED");
  if (!contextPath) fail("LAUNCH_CONTEXT_MISSING");
  const identity = await validateLaunchContext(contextPath);
  const { context, evidenceDir, candidateRoot } = identity;
  if (candidateRoot !== resolve(root)) fail("CANDIDATE_ROOT_MISMATCH");
  const configPath = join(root, "config/platform.yaml");
  const configBytes = await readFile(configPath);
  if (hash(configBytes) !== context.baseConfigSha256)
    fail("CONFIG_CONTEXT_MISMATCH");
  const [ownership, roleMap] = await Promise.all([
    readFile(join(root, "config/database-ownership.json"), "utf8").then(
      JSON.parse,
    ),
    readFile(join(root, "config/database-role-map.json"), "utf8").then(
      JSON.parse,
    ),
  ]);
  const config = await loadPlatformConfig(root, configPath);
  if (
    config.environment === "production" ||
    config.postgres.host !== "coffee_postgres" ||
    config.postgres.port !== 5432
  )
    fail("CANONICAL_TARGET_REQUIRED");
  const launchIdentity = {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
  };
  const plan = buildMigrationPlan({ launchIdentity, ownership, roleMap });
  if (mode === "clean") {
    const approved = await readApprovedMigrationTarget(context, evidenceDir);
    const { attestCanonicalMigrationPreparation } =
      await import("../../../../tools/config-bootstrap/index.mjs");
    const proof = await attestCanonicalMigrationPreparation({
      root,
      contextPath,
      expectedSystemIdentifier: approved.systemIdentifier,
    });
    const current = await readApprovedMigrationTarget(context, evidenceDir);
    if (JSON.stringify(approved) !== JSON.stringify(current))
      fail("APPROVED_TARGET_CHANGED");
    await writeFile(
      join(
        evidenceDir,
        "gates/migrations/artifacts/canonical-preparation.json",
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        preparation: proof,
      })}\n`,
      { flag: "wx", mode: 0o400 },
    );
  }
  const preparation = await readPreparation(context, evidenceDir, root);
  if (preparation.prep.postgres.user !== config.postgres.bootstrapUsername)
    fail("PREPARATION_ADMIN_USERNAME_MISMATCH");
  const secretsSha256 = hash(
    await readFile(join(root, "secrets/platform.secrets.sops.yaml")),
  );
  if (secretsSha256 !== preparation.prep.bundle.resultingSha256)
    fail("PREPARATION_BUNDLE_MISMATCH");
  const roleNames = canonicalRoles(ownership, roleMap);
  if (
    JSON.stringify(roleNames) !==
    JSON.stringify(sorted(preparation.prep.roleNames))
  )
    fail("PREPARATION_ROLE_SET_MISMATCH");
  const cleanPath = join(evidenceDir, "gates/migrations/artifacts/clean.json");
  let cleanReceipt = null;
  const expectedRunDatabases = plan.owners.map(({ name }) => name).sort();
  if (mode === "forward") {
    const clean = JSON.parse(
      await readFile(cleanPath, "utf8").catch(() => "null"),
    );
    if (
      clean?.schemaVersion !== 1 ||
      clean?.status !== "PASS" ||
      clean.stage !== "clean" ||
      clean.runId !== context.runId ||
      clean.candidateSha !== context.candidateSha ||
      clean.baseConfigSha256 !== context.baseConfigSha256 ||
      clean.preparationSha256 !== preparation.sha256 ||
      clean.systemIdentifier !== preparation.prep.postgres.systemIdentifier ||
      clean.acceptedPrefixCommit !== ACCEPTED_PREFIX_COMMIT ||
      clean.owners?.length !== plan.owners.length ||
      clean.cleanup?.verified !== true ||
      clean.cleanup?.retained?.length !== 0 ||
      JSON.stringify(clean.cleanup?.removed) !==
        JSON.stringify(expectedRunDatabases) ||
      JSON.stringify(clean.legacyTargetsExcluded) !==
        JSON.stringify(sorted(DENIED_DATABASES))
    )
      fail("CLEAN_RECEIPT_MISSING_OR_INVALID");
    cleanReceipt = clean;
  }

  const modules = await Promise.all([
    import("../../../../packages/platform-database/dist/index.js"),
    import("../../../../packages/platform-migrations/dist/index.js"),
  ]).then(([database, migrations]) => ({ ...database, ...migrations }));
  const sets = new Map();
  const currentOwners = [];
  for (const database of plan.owners) {
    const current = await loadCurrentMigrations(
      root,
      database,
      modules.migrationChecksum,
    );
    const prefix = historicalMigrations(
      root,
      database,
      modules.migrationChecksum,
    );
    assertAcceptedPrefix(current, prefix, database.owner);
    sets.set(database.owner, { current, prefix });
    currentOwners.push({
      ...database,
      currentMigrations: current,
      prefixMigrations: prefix,
    });
  }

  const adminRead = await openAdmin({
    root,
    contextPath,
    owner: plan.owners[0].owner,
    prep: preparation.prep,
    config,
  });
  const { client: admin, credential: adminCredential } = adminRead;
  const expectedSystemIdentifier = preparation.prep.postgres.systemIdentifier;
  const resources = [];
  const databases = [];
  let stageError = null;
  let cleanupAttempted = false;
  let cleanupResult = { verified: false, removed: [], retained: [] };
  let boundaryResult = null;
  try {
    await assertServerIdentity(
      admin,
      expectedSystemIdentifier,
      adminCredential.username,
    );
    await assertPreparedRoles(admin, roleNames);
    await assertTargetsAbsent(admin, plan.owners);
    for (const database of currentOwners) {
      const stage = sets.get(database.owner);
      const ownerCredential = await (
        await import("../../../../tools/config-bootstrap/index.mjs")
      ).readMigrationCredential({
        root,
        contextPath,
        owner: database.owner,
        kind: "migrator",
        expectedSystemIdentifier,
      });
      await setupDatabase(
        admin,
        database,
        adminCredential,
        config,
        resources,
        expectedSystemIdentifier,
      );
      const instance = await migrationDatabase(
        database,
        ownerCredential,
        config,
        modules,
      );
      database.instance = instance;
      let ownerPhase = "callerprefix";
      try {
        if (mode === "forward") {
          await probeServerIdentity(
            config,
            adminCredential,
            expectedSystemIdentifier,
          );
          const prefixApplied = await modules.applyMigrations(
            instance,
            stage.prefix,
            {
              schema: database.roleMap.schema,
              ledgerTable: "platform_schema_migrations",
              lockKey: `g08:${database.owner}:migration-oracle:v1`,
            },
          );
          if (
            JSON.stringify(prefixApplied) !==
            JSON.stringify(stage.prefix.map(({ id }) => id))
          )
            fail("FORWARD_PREFIX_NOT_APPLIED", database.owner);
          ownerPhase = "seed";
          const fixtureBefore = await seedForwardFixtures(database);
          await probeServerIdentity(
            config,
            adminCredential,
            expectedSystemIdentifier,
          );
          ownerPhase = "current";
          const applied = await applyOwnerDatabase(
            database,
            stage.current,
            mode,
            modules,
          );
          ownerPhase = "column-boundary";
          await verifyColumnUpdateRenderRejects({
            database,
            resources,
            admin,
            credentials: adminCredential,
            config,
            expectedSystemIdentifier,
            launchIdentity: plan.identity,
            applied,
          });
          ownerPhase = "fixture-check";
          await assertForwardFixtures(database, fixtureBefore);
          databases.push({ ...applied, prefixCount: stage.prefix.length });
        } else {
          await probeServerIdentity(
            config,
            adminCredential,
            expectedSystemIdentifier,
          );
          const applied = await applyOwnerDatabase(
            database,
            stage.current,
            mode,
            modules,
          );
          await verifyColumnUpdateRenderRejects({
            database,
            resources,
            admin,
            credentials: adminCredential,
            config,
            expectedSystemIdentifier,
            launchIdentity: plan.identity,
            applied,
          });
          databases.push(
            mode === "boundaries"
              ? { ...applied, prefixCount: stage.prefix.length }
              : applied,
          );
        }
      } catch (error) {
        throw mode === "forward"
          ? formatOwnerStageFailure(database.owner, ownerPhase, error)
          : error;
      } finally {
        await instance.resource
          .stop(AbortSignal.timeout(5_000))
          .catch(() => {});
      }
    }
    if (cleanReceipt) {
      const cleanByOwner = new Map(
        cleanReceipt.owners.map((owner) => [owner.owner, owner]),
      );
      if (
        databases.length !== cleanReceipt.owners.length ||
        databases.some((owner) => {
          const clean = cleanByOwner.get(owner.owner);
          return (
            !clean ||
            owner.database !== clean.database ||
            owner.migrationCount !== clean.migrationCount ||
            owner.ledgerSha256 !== clean.ledgerSha256 ||
            owner.schemaFingerprint !== clean.schemaFingerprint ||
            owner.aclFingerprint !== clean.aclFingerprint
          );
        })
      )
        fail("FORWARD_DIFFERS_FROM_CLEAN");
    }
    if (mode === "boundaries") {
      if (databases.length !== plan.owners.length || resources.length !== 5)
        fail("BOUNDARY_DATABASE_SET_INCOMPLETE");
      boundaryResult = await verifyBoundaries({
        context,
        config,
        ownership: plan.ownership,
        roleMap: plan.roleMap,
        databases: databases.map(({ owner, database }) => ({
          owner,
          database,
        })),
        preparationSha256: preparation.sha256,
        expectedSystemIdentifier,
      });
      if (
        !boundaryResult ||
        boundaryResult.runId !== context.runId ||
        boundaryResult.ownOperationCount !== 10 ||
        boundaryResult.foreignDeniedCount !== 40 ||
        boundaryResult.caseCount !== 50 ||
        boundaryResult.ownOperations?.length !== 10 ||
        boundaryResult.foreignConnectionDenials?.length !== 40
      )
        fail("BOUNDARY_VERIFICATION_INCOMPLETE");
    }
    await assertServerIdentity(
      admin,
      expectedSystemIdentifier,
      adminCredential.username,
    );
    cleanupAttempted = true;
    cleanupResult = await cleanup(
      admin,
      resources,
      config,
      adminCredential,
      expectedSystemIdentifier,
    );
    if (!cleanupResult.verified) fail("CLEANUP_RESOURCES_RETAINED");
  } catch (error) {
    stageError = error;
    if (!cleanupAttempted) {
      cleanupAttempted = true;
      cleanupResult = await cleanup(
        admin,
        resources,
        config,
        adminCredential,
        expectedSystemIdentifier,
      );
    }
  } finally {
    await admin.end().catch(() => {});
  }
  if (stageError && !cleanupResult.verified)
    fail(
      "CLEANUP_RESOURCES_RETAINED",
      retainedResourceDetails(resources, cleanupResult.retained) ||
        "unknown owned resources",
    );
  if (stageError) throw stageError;
  if (!cleanupResult.verified)
    fail(
      "CLEANUP_RESOURCES_RETAINED",
      retainedResourceDetails(resources, cleanupResult.retained) ||
        "unknown owned resources",
    );
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    stage: mode,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    preparationSha256: preparation.sha256,
    ...(cleanReceipt ? { cleanSha256: hash(await readFile(cleanPath)) } : {}),
    systemIdentifier: expectedSystemIdentifier,
    acceptedPrefixCommit: ACCEPTED_PREFIX_COMMIT,
    owners: databases,
    cleanup: cleanupResult,
    legacyTargetsExcluded: sorted(DENIED_DATABASES),
  };
  if (mode === "boundaries") {
    const boundaryReceipt = {
      schemaVersion: 1,
      status: "PASS",
      stage: "live-boundaries",
      runId: context.runId,
      candidateSha: context.candidateSha,
      baseConfigSha256: context.baseConfigSha256,
      preparationSha256: preparation.sha256,
      migrationResultSha256: hash(JSON.stringify(databases)),
      systemIdentifier: expectedSystemIdentifier,
      owners: databases.map(({ owner, database }) => ({ owner, database })),
      migrationOwners: databases,
      ownOperations: boundaryResult.ownOperations,
      foreignConnectionDenials: boundaryResult.foreignConnectionDenials,
      ownOperationCount: boundaryResult.ownOperationCount,
      foreignDeniedCount: boundaryResult.foreignDeniedCount,
      caseCount: boundaryResult.caseCount,
      cleanup: cleanupResult,
    };
    const artifactPath = join(
      evidenceDir,
      "gates/db_boundaries/artifacts/result.json",
    );
    await writeFile(
      artifactPath,
      `${JSON.stringify(boundaryReceipt, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({ databaseBoundaryReceipt: boundaryReceipt }, null, 2)}\n`,
    );
    return boundaryReceipt;
  }
  const artifactPath = join(
    evidenceDir,
    "gates/migrations/artifacts",
    mode === "clean" ? "clean.json" : "result.json",
  );
  await writeFile(artifactPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify(mode === "forward" ? { migrationOracle: receipt } : { migrationClean: receipt })}\n`,
  );
  return receipt;
}

export async function runMigrationStage(mode, options) {
  if (mode !== "clean" && mode !== "forward")
    fail("USAGE", "expected clean|forward");
  return runStage(mode, options);
}

export async function runDatabaseBoundaryStage(options) {
  return runStage("boundaries", options);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runMigrationStage(process.argv[2]);
  } catch (error) {
    process.stderr.write(
      `${error.message.startsWith("G08_MIGRATIONS") ? error.message : "G08_MIGRATIONS FAILED"}\n`,
    );
    process.exitCode = 1;
  }
}
