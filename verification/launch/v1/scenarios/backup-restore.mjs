#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { createReadStream, createWriteStream } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { load as parseYaml } from "js-yaml";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
  validateLaunchRunIdentity,
} from "../../../../packages/platform-config/src/launch-database-target.ts";
import {
  renderDatabaseSql,
  validateRoleMap,
} from "../../../../scripts/db-bootstrap.mjs";
import { validateLaunchContext } from "../report.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
const AGE_RECIPIENT = /^age1[02-9ac-hj-np-z]{58}$/u;
const TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
const G17_OPERATION_STAGES = new Set([
  "inspect-fixtures",
  "dump-encrypt",
  "create-restore",
  "decrypt-restore",
  "restore-database-bootstrap",
  "restore-table-acl",
  "restore-routine-acl",
  "verify-routine-acl",
  "verify-table-acl",
  "verify-orders-acl",
  "verify-restore-identity",
  "compare-source-restore",
  "recover-restored-state",
]);
const G17_DATABASE_ERROR_CODES = new Set([
  "DB_POOL_EXHAUSTED",
  "DB_INVALID_CONFIGURATION",
  "DB_CONNECTION_LOST",
  "DB_QUERY_TIMEOUT",
  "DB_QUERY_FAILED",
  "DB_INTERRUPTED",
  "DB_ROLLBACK_FAILED",
  "TRANSACTION_OUTCOME_UNKNOWN",
  "DB_INVALID_TRANSITION",
  "DB_TRANSACTION_ROLLED_BACK",
  "DB_STOPPED",
]);
const G17_FAILURE_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "DatabaseTransactionError",
  "TimeoutError",
]);
const isPostgres1711 = (version) => /\b17\.11\b/u.test(version ?? "");

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function restoreDatabaseName(runId, owner) {
  if (
    typeof runId !== "string" ||
    !RUN_ID.test(runId) ||
    !CANONICAL_DATABASE_OWNERS.includes(owner)
  )
    fail("G17_IDENTITY_INVALID");
  const name = `coffee_restore_${runId}_${owner}`;
  if (
    Buffer.byteLength(name, "utf8") > 63 ||
    !/^[a-z][A-Za-z0-9_-]+$/u.test(name)
  )
    fail("G17_RESTORE_NAME_INVALID");
  return name;
}

const G17_SCHEMA_RESTRICT_KEY = "coffeeG17SchemaCompareV1";

export function schemaSnapshotArguments(database) {
  quoteIdentifier(database);
  return [
    "--schema-only",
    "--no-owner",
    "--no-acl",
    "--format=plain",
    `--restrict-key=${G17_SCHEMA_RESTRICT_KEY}`,
    "--dbname",
    database,
  ];
}

export function buildBackupRestorePlan(
  context,
  ownership,
  roleMap,
  secretsPolicy,
) {
  const identity = validateLaunchRunIdentity(context);
  try {
    validateRoleMap(roleMap, ownership);
  } catch {
    fail("G17_OWNER_MAP_INVALID");
  }
  if (
    !Array.isArray(ownership?.databases) ||
    ownership.databases.length !== CANONICAL_DATABASE_OWNERS.length ||
    !Array.isArray(roleMap?.databases) ||
    roleMap.databases.length !== CANONICAL_DATABASE_OWNERS.length
  )
    fail("G17_OWNER_MAP_INVALID");
  const roleByOwner = new Map();
  for (const entry of ownership.databases) {
    if (
      !CANONICAL_DATABASE_OWNERS.includes(entry?.owner) ||
      entry.name !== `coffee_platform_${entry.owner}` ||
      roleByOwner.has(entry.owner)
    )
      fail("G17_OWNER_MAP_INVALID");
    const roleDatabase = roleMap.databases.find(
      ({ name }) => name === entry.name,
    );
    if (
      !roleDatabase ||
      roleDatabase.schema !== entry.owner ||
      roleDatabase.migratorRole !== entry.migratorRole
    )
      fail("G17_OWNER_MAP_INVALID");
    roleByOwner.set(entry.owner, roleDatabase);
  }
  if (CANONICAL_DATABASE_OWNERS.some((owner) => !roleByOwner.has(owner)))
    fail("G17_OWNER_MAP_INVALID");
  const recipients = secretsPolicy?.creation_rules
    ?.filter(
      (rule) =>
        rule?.path_regex === "secrets/platform\\.secrets\\.sops\\.yaml$",
    )
    .flatMap((rule) => rule?.age ?? []);
  if (
    !Array.isArray(recipients) ||
    recipients.length < 1 ||
    recipients.some((value) => !AGE_RECIPIENT.test(value)) ||
    new Set(recipients).size !== recipients.length
  )
    fail("G17_AGE_RECIPIENTS_INVALID");
  return {
    schemaVersion: 1,
    runId: identity.runId,
    candidateSha: identity.candidateSha,
    owners: CANONICAL_DATABASE_OWNERS.map((owner) => ({
      owner,
      sourceDatabase: deriveLaunchDatabaseName(identity, owner),
      restoreDatabase: restoreDatabaseName(identity.runId, owner),
      schema: roleByOwner.get(owner).schema,
      migratorRole: roleByOwner.get(owner).migratorRole,
      runtimeRoles: roleByOwner.get(owner).runtimeRoles,
      ciphertext: `gates/G17_BACKUP_RESTORE/artifacts/${owner}.dump.age`,
    })),
    age: { version: "1.3.2", recipients },
  };
}

export function safeG17FailureDiagnostics(error) {
  const diagnostic = {
    errorName: G17_FAILURE_ERROR_NAMES.has(error?.name) ? error.name : "Error",
    closedDatabaseErrorCode: null,
    sqlState: null,
    previousDatabaseCode: null,
  };
  const seen = new Set();
  let node = error;
  for (
    let depth = 0;
    node && typeof node === "object" && depth < 5 && !seen.has(node);
    depth += 1
  ) {
    seen.add(node);
    if (
      diagnostic.closedDatabaseErrorCode === null &&
      G17_DATABASE_ERROR_CODES.has(node.code)
    )
      diagnostic.closedDatabaseErrorCode = node.code;
    if (
      diagnostic.previousDatabaseCode === null &&
      G17_DATABASE_ERROR_CODES.has(node.previousCode)
    )
      diagnostic.previousDatabaseCode = node.previousCode;
    const sqlState = node.sqlState ?? node.code;
    if (
      diagnostic.sqlState === null &&
      typeof sqlState === "string" &&
      /^[0-9A-Z]{5}$/u.test(sqlState)
    )
      diagnostic.sqlState = sqlState;
    node = node.cause;
  }
  return diagnostic;
}

const commandVersions = new Map();
function commandVersion(name) {
  if (commandVersions.has(name)) return commandVersions.get(name);
  try {
    const version = execFileSync(name, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      env: safeChildEnv(),
    }).trim();
    commandVersions.set(name, version || null);
    return version || null;
  } catch {
    commandVersions.set(name, null);
    return null;
  }
}

function commandAvailable(name) {
  return commandVersion(name) !== null;
}

function commandFor(name, args) {
  if (!commandAvailable(name)) fail(`G17_REQUIRED_TOOL_MISSING:${name}`);
  return { command: name, args };
}

function safeChildEnv(extra = {}) {
  const inherited = {};
  for (const key of ["PATH", "HOME", "XDG_CONFIG_HOME"]) {
    if (typeof process.env[key] === "string") inherited[key] = process.env[key];
  }
  return { ...inherited, ...extra };
}

function safePgEnv(target, password, extra = {}) {
  return {
    ...safeChildEnv(),
    PGHOST: target.host,
    PGPORT: String(target.port),
    PGUSER: "postgres",
    PGPASSWORD: password,
    PGSSLMODE: "prefer",
    ...extra,
  };
}

function spawnChild(io, command, args, options) {
  return io.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
}

function waitChild(child, label) {
  const rejectProcess = (suffix) => {
    const safeLabel = /^[A-Z][A-Z0-9_]{0,40}$/u.test(label)
      ? label
      : "UNKNOWN_PROCESS";
    const code = `${safeLabel.startsWith("G17_") ? "" : "G17_PROCESS_"}${safeLabel}_${suffix}`;
    const error = new Error(code);
    error.code = code;
    return error;
  };
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", () => rejectPromise(rejectProcess("SPAWN_FAILED")));
    child.once("close", (code, signal) =>
      code === 0
        ? resolvePromise()
        : rejectPromise(rejectProcess(`EXIT_${signal ?? code ?? "unknown"}`)),
    );
  });
}

function killChild(child) {
  if (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  )
    return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null)
      child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
}

export async function runStreamPair({
  io,
  first,
  second,
  outputPath,
  cwd,
  timeoutMs = TIMEOUT_MS,
  labels,
}) {
  const left = spawnChild(io, first.command, first.args, {
    cwd,
    env: first.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const right = spawnChild(io, second.command, second.args, {
    cwd,
    env: second.env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const leftDone = waitChild(left, labels[0]);
  const rightDone = waitChild(right, labels[1]);
  const output = createWriteStream(outputPath, {
    flags:
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode: 0o600,
  });
  let timeout;
  try {
    timeout = setTimeout(() => {
      killChild(left);
      killChild(right);
    }, timeoutMs);
    await Promise.all([
      pipeline(left.stdout, right.stdin),
      pipeline(right.stdout, output),
      leftDone,
      rightDone,
    ]);
  } catch (error) {
    killChild(left);
    killChild(right);
    await Promise.allSettled([leftDone, rightDone]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runStreamRestore({
  io,
  ageCommand,
  restoreCommand,
  cwd,
  timeoutMs = TIMEOUT_MS,
}) {
  const left = spawnChild(io, ageCommand.command, ageCommand.args, {
    cwd,
    env: ageCommand.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const right = spawnChild(io, restoreCommand.command, restoreCommand.args, {
    cwd,
    env: restoreCommand.env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const leftDone = waitChild(left, "AGE_DECRYPT");
  const rightDone = waitChild(right, "PG_RESTORE");
  let timeout;
  try {
    timeout = setTimeout(() => {
      killChild(left);
      killChild(right);
    }, timeoutMs);
    await Promise.all([
      pipeline(left.stdout, right.stdin),
      leftDone,
      rightDone,
    ]);
  } catch (error) {
    killChild(left);
    killChild(right);
    await Promise.allSettled([leftDone, rightDone]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function capture({
  io,
  command,
  args,
  env,
  cwd,
  timeoutMs = 30_000,
  limit = OUTPUT_LIMIT,
  trim = true,
}) {
  const child = spawnChild(io, command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks = [];
  let bytes = 0;
  const childDone = waitChild(child, "G17_COMMAND");
  const timer = setTimeout(() => killChild(child), timeoutMs);
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > limit) {
        killChild(child);
        fail("G17_COMMAND_OUTPUT_LIMIT");
      }
      chunks.push(chunk);
    }
    await childDone;
    const output = Buffer.concat(chunks).toString("utf8");
    return trim ? output.trim() : output;
  } catch (error) {
    killChild(child);
    await Promise.allSettled([childDone]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function hashStream({
  io,
  command,
  args,
  env,
  cwd,
  timeoutMs = TIMEOUT_MS,
  includeLength = false,
}) {
  const child = spawnChild(io, command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const hash = createHash("sha256");
  let length = 0;
  const childDone = waitChild(child, "G17_HASH_STREAM");
  const timer = setTimeout(() => killChild(child), timeoutMs);
  try {
    for await (const chunk of child.stdout) {
      hash.update(chunk);
      length += chunk.length;
    }
    await childDone;
    const sha256 = hash.digest("hex");
    return includeLength ? { sha256, length } : sha256;
  } catch (error) {
    killChild(child);
    await Promise.allSettled([childDone]);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const SCHEMA_DIFF_CLASSES = Object.freeze([
  "blank",
  "restrict",
  "objectHeader",
  "sqlComment",
  "createSchema",
  "ownerChange",
  "databaseComment",
  "schemaComment",
  "otherSql",
]);

const G17_VERIFIED_SCHEMA_COMPARISONS = Object.freeze([
  Object.freeze({
    owner: "customer",
    sourceSchemaSha256:
      "b1eaf9e8c0586c5752451d6f1fcdaf79f6a9d408931cf5ee6cc331fc313be8fa",
    restoreSchemaSha256:
      "46f16abdb2f0e8222638c0cf005e40c0f3da4318c3d1e6aab80505dd282e1ba9",
    mode: "verified-pg17-array-coercion-v1",
  }),
  Object.freeze({
    owner: "catalog",
    sourceSchemaSha256:
      "49dbcfa251f0666c608bbc9ced08a531a63f55d458348eb0d8c36068a8ea5bc2",
    restoreSchemaSha256:
      "de898f34cce90397ac994565490385b92a7e66e1d4b2dd827153e3fec1e73206",
    mode: "verified-pg17-array-coercion-v1",
  }),
  Object.freeze({
    owner: "pricing",
    sourceSchemaSha256:
      "c2ccb09f96da9684ea2448276965101090b288e70e357e13f43fe132c72fdeba",
    restoreSchemaSha256:
      "313a035738d1e7d968b580d09f0f3af1a2a42d47228a741192690e246da8700d",
    mode: "verified-pg17-array-coercion-v1",
  }),
  Object.freeze({
    owner: "orders",
    sourceSchemaSha256:
      "133b2f9d0ee84b7a9a918df1a386b4ca60a121560d2fc76fd2945d8148d12116",
    restoreSchemaSha256:
      "13c47b11f96f82e142eeaf23f2f6adad49266c63a7156bf553fb54d1bac970b0",
    mode: "verified-pg17-array-coercion-v1",
  }),
  Object.freeze({
    owner: "integration",
    sourceSchemaSha256:
      "e25f1c7044520b7d2d470856d5e668ba9f9cabb7c9e58caf85681e3bae0ccf01",
    restoreSchemaSha256:
      "03450e85590d6a1a7a52f6b8b88c63d4ddb15885d947faa4264a697cf946845a",
    mode: "verified-pg17-array-coercion-v1",
  }),
]);

export function g17SchemaComparisonMode(
  owner,
  sourceSchemaSha256,
  restoreSchemaSha256,
) {
  if (
    typeof owner !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceSchemaSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(restoreSchemaSha256 ?? "")
  )
    fail("G17_SCHEMA_COMPARISON_INPUT_INVALID");
  if (sourceSchemaSha256 === restoreSchemaSha256)
    return "raw-sha256-equality-v1";
  const approved = G17_VERIFIED_SCHEMA_COMPARISONS.find(
    (entry) =>
      entry.owner === owner &&
      entry.sourceSchemaSha256 === sourceSchemaSha256 &&
      entry.restoreSchemaSha256 === restoreSchemaSha256,
  );
  return approved?.mode ?? null;
}

function schemaLineClass(line) {
  if (/^\s*$/u.test(line)) return "blank";
  if (/^\\(?:un)?restrict\b/u.test(line)) return "restrict";
  if (/^--\s*Name:/u.test(line)) return "objectHeader";
  if (line.startsWith("--")) return "sqlComment";
  if (/^CREATE SCHEMA\b/iu.test(line)) return "createSchema";
  if (/^ALTER\b.*\bOWNER\s+TO\b/iu.test(line)) return "ownerChange";
  if (/^COMMENT ON DATABASE\b/iu.test(line)) return "databaseComment";
  if (/^COMMENT ON SCHEMA\b/iu.test(line)) return "schemaComment";
  return "otherSql";
}

export function summarizeSchemaDumpDifference({
  sourceDump,
  restoreDump,
  sourceSchemaSha256,
  restoreSchemaSha256,
  sourceBytes,
  restoreBytes,
}) {
  if (
    typeof sourceDump !== "string" ||
    typeof restoreDump !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceSchemaSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(restoreSchemaSha256 ?? "") ||
    !Number.isSafeInteger(sourceBytes) ||
    !Number.isSafeInteger(restoreBytes)
  )
    fail("G17_SCHEMA_DIAGNOSTIC_INPUT_INVALID");

  const sourceLines = sourceDump.split("\n");
  const restoreLines = restoreDump.split("\n");
  const classCounts = Object.fromEntries(
    SCHEMA_DIFF_CLASSES.map((name) => [name, 0]),
  );
  const firstDifferences = [];
  let differingLineCount = 0;
  for (
    let lineIndex = 0;
    lineIndex < Math.max(sourceLines.length, restoreLines.length);
    lineIndex += 1
  ) {
    const sourceLine = sourceLines[lineIndex] ?? "";
    const restoreLine = restoreLines[lineIndex] ?? "";
    if (sourceLine === restoreLine) continue;
    differingLineCount += 1;
    const sourceClass = schemaLineClass(sourceLine);
    const restoreClass = schemaLineClass(restoreLine);
    classCounts[sourceClass] += 1;
    if (restoreClass !== sourceClass) classCounts[restoreClass] += 1;
    if (firstDifferences.length >= 8) continue;
    firstDifferences.push({
      lineIndex,
      sourceClass,
      restoreClass,
      sourceLineSha256: createHash("sha256").update(sourceLine).digest("hex"),
      restoreLineSha256: createHash("sha256").update(restoreLine).digest("hex"),
    });
  }
  return {
    sourceSchemaSha256,
    restoreSchemaSha256,
    sourceBytes,
    restoreBytes,
    sourceLineCount: sourceLines.length,
    restoreLineCount: restoreLines.length,
    differingLineCount,
    differingClassCounts: classCounts,
    firstDifferences,
  };
}

export function quoteIdentifier(value) {
  const restoreMatch =
    typeof value === "string" &&
    /^coffee_restore_([0-9]{8}T[0-9]{6}Z-[0-9a-f]{7})_([a-z]+)$/u.exec(value);
  const restoreName =
    restoreMatch &&
    CANONICAL_DATABASE_OWNERS.includes(restoreMatch[2]) &&
    value === restoreDatabaseName(restoreMatch[1], restoreMatch[2]);
  if (
    typeof value !== "string" ||
    ((!/^[a-z][a-z0-9_-]*$/u.test(value) ||
      value.startsWith("coffee_restore_")) &&
      !restoreName)
  )
    fail("G17_SQL_IDENTIFIER_INVALID");
  return `"${value.replaceAll('"', '""')}"`;
}

export function g17RoutineAclSnapshotSql(schema) {
  if (typeof schema !== "string" || !/^[a-z][a-z_]*$/u.test(schema))
    fail("G17_ROUTINE_SCHEMA_INVALID");
  return `SELECT COALESCE(json_agg(json_build_array(n.nspname,p.proname,p.prokind,pg_get_function_identity_arguments(p.oid),owner.rolname,CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,acl.privilege_type,acl.is_grantable) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid),CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END,acl.privilege_type,acl.is_grantable),'[]'::json)::text
FROM pg_proc AS p
JOIN pg_namespace AS n ON n.oid=p.pronamespace
JOIN pg_roles AS owner ON owner.oid=p.proowner
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) AS acl
LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
WHERE n.nspname='${schema}' AND p.prokind IN ('f','p','a','w')`;
}

export function renderG17RestoreFunctionAclSql(ownerPlan) {
  if (
    !ownerPlan ||
    !CANONICAL_DATABASE_OWNERS.includes(ownerPlan.owner) ||
    ownerPlan.schema !== ownerPlan.owner
  )
    fail("G17_ROUTINE_SCHEMA_INVALID");
  const statements = [
    `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ${quoteIdentifier(ownerPlan.schema)} FROM PUBLIC;`,
  ];
  if (ownerPlan.owner === "orders") {
    const roles = new Map(
      (ownerPlan.runtimeRoles ?? []).map(({ runtime, role }) => [
        runtime,
        role,
      ]),
    );
    if (
      roles.get("orders-service") !== "coffee_orders_service_rw" ||
      roles.get("orders-aroma-preparation") !== "coffee_orders_prepare_rw"
    )
      fail("G17_ROUTINE_ROLE_MAP_INVALID");
    statements.push(
      `GRANT EXECUTE ON FUNCTION ${quoteIdentifier(ownerPlan.schema)}.write_card_projection(text,jsonb) TO ${quoteIdentifier(roles.get("orders-service"))},${quoteIdentifier(roles.get("orders-aroma-preparation"))};`,
      `GRANT EXECUTE ON FUNCTION ${quoteIdentifier(ownerPlan.schema)}.read_card_projection(text,integer) TO ${quoteIdentifier(roles.get("orders-service"))};`,
    );
  }
  return statements.join("\n");
}

export function verifyG17RoutineAclSnapshots(sourceSnapshot, restoreSnapshot) {
  const parse = (value) => {
    let rows;
    try {
      rows = JSON.parse(value);
    } catch {
      fail("G17_ROUTINE_ACL_QUERY_INVALID");
    }
    if (
      !Array.isArray(rows) ||
      rows.some(
        (row) =>
          !Array.isArray(row) ||
          row.length !== 8 ||
          row.some((field, index) =>
            index === 7
              ? typeof field !== "boolean"
              : typeof field !== "string",
          ),
      )
    )
      fail("G17_ROUTINE_ACL_QUERY_INVALID");
    return rows;
  };
  const source = parse(sourceSnapshot);
  const restored = parse(restoreSnapshot);
  if (JSON.stringify(source) !== JSON.stringify(restored))
    fail("G17_ROUTINE_ACL_MISMATCH");
  return source;
}

const G17_TABLE_PRIVILEGES = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
]);
const G17_COLUMN_PRIVILEGES = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "REFERENCES",
]);
const G17_RELATION_KINDS = new Set(["r", "p", "v", "m", "f"]);

export function g17TableAclSnapshotSql(schema) {
  if (typeof schema !== "string" || !/^[a-z][a-z_]*$/u.test(schema))
    fail("G17_TABLE_SCHEMA_INVALID");
  return `WITH relations AS (
  SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl
  FROM pg_class AS c JOIN pg_namespace AS n ON n.oid=c.relnamespace
  WHERE n.nspname='${schema}' AND c.relkind IN ('r','p','v','m','f')
), acl_rows AS (
  SELECT r.relname,r.relkind,owner.rolname AS owner_name,NULL::text AS column_name,
    grantor.rolname AS grantor_name,
    CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
    acl.privilege_type,acl.is_grantable
  FROM relations AS r JOIN pg_roles AS owner ON owner.oid=r.relowner
  CROSS JOIN LATERAL aclexplode(COALESCE(r.relacl,acldefault('r',r.relowner))) AS acl
  JOIN pg_roles AS grantor ON grantor.oid=acl.grantor
  LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
  UNION ALL
  SELECT r.relname,r.relkind,owner.rolname AS owner_name,NULL::text AS column_name,
    owner.rolname AS grantor_name,'__EMPTY_ACL__'::text AS grantee_name,
    '__EMPTY_ACL__'::text AS privilege_type,false AS is_grantable
  FROM relations AS r JOIN pg_roles AS owner ON owner.oid=r.relowner
  WHERE NOT EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(r.relacl,acldefault('r',r.relowner))) AS acl
  )
  UNION ALL
  SELECT r.relname,r.relkind,owner.rolname AS owner_name,a.attname AS column_name,
    grantor.rolname AS grantor_name,
    CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_name,
    acl.privilege_type,acl.is_grantable
  FROM relations AS r JOIN pg_roles AS owner ON owner.oid=r.relowner
  JOIN pg_attribute AS a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
  CROSS JOIN LATERAL aclexplode(COALESCE(a.attacl,acldefault('c',r.relowner))) AS acl
  JOIN pg_roles AS grantor ON grantor.oid=acl.grantor
  LEFT JOIN pg_roles AS grantee ON grantee.oid=acl.grantee
)
SELECT COALESCE(json_agg(json_build_array(relname,relkind,owner_name,column_name,grantor_name,grantee_name,privilege_type,is_grantable)
  ORDER BY relname,COALESCE(column_name,''),grantee_name,privilege_type,is_grantable,grantor_name),'[]'::json)::text
FROM acl_rows`;
}

function parseG17TableAclSnapshot(snapshot, ownerPlan) {
  let rows;
  try {
    rows = JSON.parse(snapshot);
  } catch {
    fail("G17_TABLE_ACL_QUERY_INVALID");
  }
  const allowedRoles = new Set([
    ownerPlan.migratorRole,
    ...(ownerPlan.runtimeRoles ?? []).map(({ role }) => role),
  ]);
  const relationKinds = new Map();
  const keys = new Set();
  if (!Array.isArray(rows) || rows.length === 0)
    fail("G17_TABLE_ACL_QUERY_INVALID");
  for (const row of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== 8 ||
      row.some((value, index) =>
        index === 3
          ? value !== null && typeof value !== "string"
          : index === 7
            ? typeof value !== "boolean"
            : typeof value !== "string",
      )
    )
      fail("G17_TABLE_ACL_QUERY_INVALID");
    const [
      relation,
      kind,
      owner,
      column,
      grantor,
      grantee,
      privilege,
      grantable,
    ] = row;
    if (
      !/^[a-z][a-z0-9_]*$/u.test(relation) ||
      !G17_RELATION_KINDS.has(kind) ||
      owner !== ownerPlan.migratorRole ||
      grantor !== ownerPlan.migratorRole ||
      (grantee !== "PUBLIC" && !allowedRoles.has(grantee)) ||
      grantable ||
      (column === null
        ? !G17_TABLE_PRIVILEGES.has(privilege)
        : !/^[a-z][a-z0-9_]*$/u.test(column) ||
          !G17_COLUMN_PRIVILEGES.has(privilege))
    )
      fail("G17_TABLE_ACL_UNSUPPORTED");
    if (relationKinds.has(relation) && relationKinds.get(relation) !== kind)
      fail("G17_TABLE_ACL_QUERY_INVALID");
    relationKinds.set(relation, kind);
    const key = JSON.stringify(row);
    if (keys.has(key)) fail("G17_TABLE_ACL_QUERY_INVALID");
    keys.add(key);
  }
  return rows;
}

export function renderG17RestoreTableAclSql(ownerPlan, sourceSnapshot) {
  if (
    !ownerPlan ||
    !CANONICAL_DATABASE_OWNERS.includes(ownerPlan.owner) ||
    ownerPlan.schema !== ownerPlan.owner
  )
    fail("G17_TABLE_SCHEMA_INVALID");
  const rows = parseG17TableAclSnapshot(sourceSnapshot, ownerPlan);
  const roles = [
    ...new Set((ownerPlan.runtimeRoles ?? []).map(({ role }) => role)),
  ];
  if (
    !roles.length ||
    roles.some((role) => !/^coffee_[a-z_]+_(?:rw|ro)$/u.test(role))
  )
    fail("G17_TABLE_ROLE_MAP_INVALID");
  const recipients = ["PUBLIC", ...roles.map(quoteIdentifier)].join(",");
  const relations = [...new Set(rows.map(([relation]) => relation))].sort(
    (a, b) => a.localeCompare(b),
  );
  const statements = [];
  for (const relation of relations) {
    const qualified = `${quoteIdentifier(ownerPlan.schema)}.${quoteIdentifier(relation)}`;
    // PostgreSQL REVOKE on a table also removes its corresponding column ACLs.
    statements.push(
      `REVOKE ALL PRIVILEGES ON TABLE ${qualified} FROM ${recipients};`,
    );
  }
  const groups = new Map();
  for (const [relation, , owner, column, grantor, grantee, privilege] of rows) {
    if (grantee === owner) continue;
    const key = JSON.stringify([relation, column, grantor, grantee]);
    const group = groups.get(key) ?? {
      relation,
      column,
      grantor,
      grantee,
      privileges: new Set(),
    };
    group.privileges.add(privilege);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].sort((a, b) =>
    `${a.relation}:${a.column ?? ""}:${a.grantee}:${a.grantor}`.localeCompare(
      `${b.relation}:${b.column ?? ""}:${b.grantee}:${b.grantor}`,
    ),
  )) {
    const grantee =
      group.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(group.grantee);
    const target = `${quoteIdentifier(ownerPlan.schema)}.${quoteIdentifier(group.relation)}`;
    const privileges = [...group.privileges]
      .sort((a, b) => a.localeCompare(b))
      .map((privilege) =>
        group.column === null
          ? privilege
          : `${privilege} (${quoteIdentifier(group.column)})`,
      )
      .join(", ");
    statements.push(`SET ROLE ${quoteIdentifier(group.grantor)};`);
    statements.push(`GRANT ${privileges} ON TABLE ${target} TO ${grantee};`);
    statements.push("RESET ROLE;");
  }
  return statements.join("\n");
}

export function verifyG17TableAclSnapshots(
  sourceSnapshot,
  restoreSnapshot,
  ownerPlan,
) {
  const source = parseG17TableAclSnapshot(sourceSnapshot, ownerPlan);
  const restored = parseG17TableAclSnapshot(restoreSnapshot, ownerPlan);
  const sort = (rows) => rows.map((row) => JSON.stringify(row)).sort();
  if (JSON.stringify(sort(source)) !== JSON.stringify(sort(restored)))
    fail("G17_TABLE_ACL_MISMATCH");
  return source;
}

export function g17OrdersAclInvariantSql(ownerPlan) {
  if (
    !ownerPlan ||
    ownerPlan.owner !== "orders" ||
    ownerPlan.schema !== "orders"
  )
    fail("G17_TABLE_SCHEMA_INVALID");
  const role = (runtime) => {
    const claim = ownerPlan.runtimeRoles?.find(
      (item) => item.runtime === runtime,
    );
    if (!claim || !/^coffee_[a-z_]+_(?:rw|ro)$/u.test(claim.role))
      fail("G17_TABLE_ROLE_MAP_INVALID");
    return `'${claim.role}'`;
  };
  const service = role("orders-service");
  const preparation = role("orders-aroma-preparation");
  const convergence = role("aroma-convergence");
  return `SELECT json_build_array(
  has_table_privilege(${service},'orders.orders','UPDATE'),
  has_column_privilege(${service},'orders.orders','status','UPDATE'),
  has_column_privilege(${service},'orders.orders','version','UPDATE'),
  has_column_privilege(${service},'orders.orders','projection_version','UPDATE'),
  has_table_privilege(${preparation},'orders.cart_desired_order_facts','SELECT'),
  has_table_privilege(${preparation},'orders.cart_desired_order_facts','INSERT'),
  has_table_privilege(${preparation},'orders.order_aroma_projections','SELECT'),
  has_table_privilege(${preparation},'orders.convergence_work','INSERT'),
  has_table_privilege(${preparation},'orders.convergence_work','UPDATE'),
  has_table_privilege(${convergence},'orders.cart_desired_order_facts','SELECT'),
  has_table_privilege(${convergence},'orders.convergence_attempts','INSERT'),
  has_table_privilege(${convergence},'orders.convergence_attempts','UPDATE'),
  has_table_privilege(${convergence},'orders.convergence_leases','UPDATE'),
  has_table_privilege(${convergence},'orders.mutation_reservations','UPDATE'),
  has_column_privilege(${convergence},'orders.convergence_work','dirty','UPDATE'),
  has_column_privilege(${convergence},'orders.convergence_work','desired_revision','UPDATE')
)::text`;
}

export function verifyG17OrdersAclInvariants(snapshot) {
  let values;
  try {
    values = JSON.parse(snapshot);
  } catch {
    fail("G17_TABLE_ACL_PROBE_INVALID");
  }
  const expected = [
    false,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ];
  if (
    !Array.isArray(values) ||
    values.length !== expected.length ||
    values.some(
      (value, index) => typeof value !== "boolean" || value !== expected[index],
    )
  )
    fail("G17_TABLE_ACL_INVARIANT_FAILED");
  return values;
}

function psqlCommand(target, database, sql) {
  const args = [
    "-X",
    "-A",
    "-t",
    "-F",
    "\t",
    "-v",
    "ON_ERROR_STOP=1",
    "--host",
    target.host,
    "--port",
    String(target.port),
    "--username",
    "postgres",
    "--dbname",
    database,
    "--command",
    sql,
  ];
  return commandFor("psql", args);
}

async function queryText(owner, database, sql, { target, password, root, io }) {
  const env = safePgEnv(target, password);
  const command = psqlCommand(target, database, sql);
  return capture({ io, ...command, cwd: root, env, limit: 128 * 1024 });
}

async function readRestoreDatabaseOwnership(
  database,
  { target, password, root, io },
) {
  const output = await queryText(
    "bootstrap",
    "postgres",
    `SELECT datname, oid::text, pg_get_userbyid(datdba), COALESCE(shobj_description(oid,'pg_database'),'-') FROM pg_database WHERE datname='${database}'`,
    { target, password, root, io },
  );
  if (!output) return null;
  const [name, oid, owner, marker] = output.split("\t");
  if (
    name !== database ||
    !/^[1-9][0-9]*$/u.test(oid ?? "") ||
    !/^[a-z][a-z0-9_]*$/u.test(owner ?? "")
  )
    fail("G17_RESTORE_OWNERSHIP_QUERY_INVALID");
  return { database: name, oid, owner, marker: marker === "-" ? null : marker };
}

function sameRestoreOwnership(actual, expected) {
  return (
    actual?.database === expected.database &&
    actual.oid === expected.oid &&
    actual.owner === expected.owner &&
    actual.marker === expected.marker
  );
}

export async function createG17OwnedRestoreDatabase({
  ownerPlan,
  identity,
  createDatabase,
  readOwnership,
  setMarker,
  created,
  createAttempts,
}) {
  const attempt = {
    database: ownerPlan.restoreDatabase,
    owner: ownerPlan.owner,
    state: "CREATE_PENDING",
  };
  createAttempts.push(attempt);
  try {
    await createDatabase();
    attempt.state = "CREATE_ACKNOWLEDGED_UNCLAIMED";
  } catch {
    attempt.state = "CREATE_UNKNOWN_OUTCOME";
    throw Object.assign(new Error("G17_RESTORE_CREATE_OUTCOME_UNKNOWN"), {
      code: "G17_RESTORE_CREATE_OUTCOME_UNKNOWN",
    });
  }

  const beforeMarker = await readOwnership(ownerPlan.restoreDatabase);
  if (
    !beforeMarker ||
    beforeMarker.owner !== ownerPlan.migratorRole ||
    beforeMarker.marker !== null
  )
    fail("G17_RESTORE_CREATE_OWNERSHIP_UNPROVEN");
  const record = {
    database: ownerPlan.restoreDatabase,
    owner: ownerPlan.migratorRole,
    oid: beforeMarker.oid,
    marker: `coffee-g17:${identity.runId}:${identity.candidateSha}:${ownerPlan.owner}:${randomUUID()}`,
  };
  await setMarker(record.database, record.marker);
  const afterMarker = await readOwnership(record.database);
  if (!sameRestoreOwnership(afterMarker, record))
    fail("G17_RESTORE_CREATE_MARKER_UNPROVEN");
  attempt.state = "OWNED";
  created.push(record);
  return record;
}

export async function cleanupG17OwnedRestoreDatabases({
  created,
  createAttempts,
  verifyServer,
  readOwnership,
  dropDatabase,
}) {
  const removed = [];
  const retained = [];
  let verified = true;
  for (const attempt of createAttempts) {
    if (attempt.state !== "OWNED") {
      verified = false;
      retained.push({ database: attempt.database, reason: attempt.state });
    }
  }
  for (const record of [...created].reverse()) {
    try {
      await verifyServer(record);
      const actual = await readOwnership(record.database);
      if (!sameRestoreOwnership(actual, record)) {
        verified = false;
        retained.push({
          database: record.database,
          reason: "OWNERSHIP_MISMATCH",
        });
        continue;
      }
      await dropDatabase(record.database);
      if (await readOwnership(record.database)) {
        verified = false;
        retained.push({
          database: record.database,
          reason: "DROP_NOT_CONFIRMED",
        });
        continue;
      }
      removed.push(record.database);
    } catch (error) {
      verified = false;
      retained.push({
        database: record.database,
        reason:
          typeof error?.code === "string" &&
          /^G17_[A-Z0-9_:,-]+$/u.test(error.code)
            ? error.code
            : "CLEANUP_OUTCOME_UNKNOWN",
      });
    }
  }
  return { verified, removed, retained };
}

async function serverIdentity({
  database,
  owner,
  target,
  password,
  root,
  io,
  expectedSystemIdentifier,
  expectedVersion,
  expectedDatabaseOwner,
}) {
  const sql =
    "SELECT current_database(), current_user, split_part(current_setting('server_version'), ' ', 1), (SELECT system_identifier::text FROM pg_control_system()), (SELECT role.rolname FROM pg_database AS database JOIN pg_roles AS role ON role.oid=database.datdba WHERE database.datname=current_database())";
  const output = await queryText(owner, database, sql, {
    target,
    password,
    root,
    io,
  });
  const [actualDatabase, user, version, systemIdentifier, databaseOwner] =
    output.split("\t");
  if (
    actualDatabase !== database ||
    user !== "postgres" ||
    version !== expectedVersion ||
    systemIdentifier !== expectedSystemIdentifier ||
    databaseOwner !== expectedDatabaseOwner
  )
    fail("G17_SERVER_IDENTITY_MISMATCH");
  return {
    database: actualDatabase,
    user,
    version,
    systemIdentifier,
    databaseOwner,
  };
}

async function snapshotDatabase({ ownerPlan, target, password, root, io }) {
  const env = safePgEnv(target, password);
  const schemaDump = commandFor("pg_dump", [
    ...schemaSnapshotArguments(ownerPlan.sourceDatabase),
  ]);
  const sourceSchema = await hashStream({
    io,
    ...schemaDump,
    cwd: root,
    env,
    includeLength: true,
  });
  const restoredSchemaDump = commandFor("pg_dump", [
    ...schemaSnapshotArguments(ownerPlan.restoreDatabase),
  ]);
  const restoredSchema = await hashStream({
    io,
    ...restoredSchemaDump,
    cwd: root,
    env,
    includeLength: true,
  });
  const sourceSchemaHash = sourceSchema.sha256;
  const schemaHash = restoredSchema.sha256;
  const schemaComparisonMode = g17SchemaComparisonMode(
    ownerPlan.owner,
    sourceSchemaHash,
    schemaHash,
  );
  if (!schemaComparisonMode) {
    let schemaComparisonDiagnostic;
    try {
      const sourceDump = await capture({
        io,
        ...schemaDump,
        cwd: root,
        env,
        trim: false,
      });
      const restoreDump = await capture({
        io,
        ...restoredSchemaDump,
        cwd: root,
        env,
        trim: false,
      });
      schemaComparisonDiagnostic = summarizeSchemaDumpDifference({
        sourceDump,
        restoreDump,
        sourceSchemaSha256: sourceSchemaHash,
        restoreSchemaSha256: schemaHash,
        sourceBytes: sourceSchema.length,
        restoreBytes: restoredSchema.length,
      });
    } catch {
      schemaComparisonDiagnostic = {
        sourceSchemaSha256: sourceSchemaHash,
        restoreSchemaSha256: schemaHash,
        sourceBytes: sourceSchema.length,
        restoreBytes: restoredSchema.length,
        diagnosticFailed: true,
      };
    }
    try {
      fail("G17_SCHEMA_MISMATCH");
    } catch (error) {
      error.schemaComparisonDiagnostic = schemaComparisonDiagnostic;
      throw error;
    }
  }
  const tablesSql = `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = '${ownerPlan.schema}' ORDER BY tablename`;
  const tables = (
    await queryText(ownerPlan.owner, ownerPlan.sourceDatabase, tablesSql, {
      target,
      password,
      root,
      io,
    })
  )
    .split("\n")
    .filter(Boolean);
  if (!tables.length) fail("G17_OWNER_SCHEMA_EMPTY");
  const tableFacts = [];
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table)) fail("G17_TABLE_NAME_INVALID");
    const relation = `${quoteIdentifier(ownerPlan.schema)}.${quoteIdentifier(table)}`;
    const count = await queryText(
      ownerPlan.owner,
      ownerPlan.sourceDatabase,
      `SELECT count(*) FROM ${relation}`,
      { target, password, root, io },
    );
    const rowsHashCommand = commandFor("psql", [
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      target.host,
      "--port",
      String(target.port),
      "--username",
      "postgres",
      "--dbname",
      ownerPlan.sourceDatabase,
      "--command",
      `COPY (SELECT row_to_json(t)::text FROM ${relation} AS t ORDER BY 1) TO STDOUT WITH (FORMAT csv)`,
    ]);
    const sourceHash = await hashStream({
      io,
      ...rowsHashCommand,
      cwd: root,
      env,
    });
    const restoreCount = await queryText(
      ownerPlan.owner,
      ownerPlan.restoreDatabase,
      `SELECT count(*) FROM ${relation}`,
      { target, password, root, io },
    );
    const restoreHashCommand = commandFor("psql", [
      "-X",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "--host",
      target.host,
      "--port",
      String(target.port),
      "--username",
      "postgres",
      "--dbname",
      ownerPlan.restoreDatabase,
      "--command",
      `COPY (SELECT row_to_json(t)::text FROM ${relation} AS t ORDER BY 1) TO STDOUT WITH (FORMAT csv)`,
    ]);
    const restoreHash = await hashStream({
      io,
      ...restoreHashCommand,
      cwd: root,
      env,
    });
    if (
      !/^(0|[1-9][0-9]*)$/u.test(count) ||
      count !== restoreCount ||
      sourceHash !== restoreHash
    )
      fail("G17_OWNER_DATA_MISMATCH");
    tableFacts.push({ table, count, invariantSha256: sourceHash });
  }
  const migrationVersion = await queryText(
    ownerPlan.owner,
    ownerPlan.sourceDatabase,
    `SELECT id || ':' || checksum FROM ${quoteIdentifier(ownerPlan.schema)}.platform_schema_migrations ORDER BY id`,
    { target, password, root, io },
  );
  if (!migrationVersion) fail("G17_MIGRATION_LEDGER_EMPTY");
  const migrationSha256 = createHash("sha256")
    .update(migrationVersion)
    .digest("hex");
  const invariantSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        schemaComparisonMode,
        sourceSchemaSha256: sourceSchemaHash,
        restoreSchemaSha256: schemaHash,
        migrationSha256,
        tableFacts,
      }),
    )
    .digest("hex");
  return {
    sourceSchemaSha256: sourceSchemaHash,
    restoreSchemaSha256: schemaHash,
    schemaComparisonMode,
    migrationSha256,
    tableFacts,
    invariantSha256,
  };
}

async function ensureSafeEvidenceDirectory(root, evidenceDir) {
  const runId = resolve(evidenceDir).split("/").at(-1);
  const expected = resolve(root, "evidence/launch", runId);
  if (
    resolve(evidenceDir) !== expected ||
    (await realpath(root)) !== resolve(root)
  )
    fail("G17_EVIDENCE_PATH_INVALID");
  const parts = [
    resolve(root),
    resolve(root, "evidence"),
    resolve(root, "evidence/launch"),
    expected,
    resolve(expected, "gates"),
    resolve(expected, "gates/G17_BACKUP_RESTORE"),
    resolve(expected, "gates/G17_BACKUP_RESTORE/artifacts"),
  ];
  for (const path of parts) {
    let info = await lstat(path).catch((error) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (!info) {
      await mkdir(path, { mode: 0o700 });
      info = await lstat(path);
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      fail("G17_EVIDENCE_PATH_INVALID");
  }
  return resolve(expected, "gates/G17_BACKUP_RESTORE/artifacts");
}

async function writeEvidence(path, value) {
  const existing = await lstat(path).catch((error) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    fail("G17_EVIDENCE_FILE_INVALID");
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (existing ? fsConstants.O_TRUNC : fsConstants.O_EXCL);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runBackupRestoreScenario({
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  root = ROOT,
  target,
  env = process.env,
  io = { spawn },
} = {}) {
  if (!contextPath) fail("G17_LAUNCH_CONTEXT_REQUIRED");
  const { context, candidateRoot, sourceRoot, evidenceDir } =
    await validateLaunchContext(contextPath);
  if (candidateRoot !== resolve(root)) fail("G17_CANDIDATE_ROOT_MISMATCH");
  if (!env.SOPS_AGE_KEY_FILE) fail("G17_TRUSTED_AGE_LOCATOR_REQUIRED");
  if (
    !target ||
    typeof target.host !== "string" ||
    !Number.isInteger(target.port) ||
    !/^[0-9]+$/u.test(target.systemIdentifier ?? "")
  )
    fail("G17_TARGET_SELECTION_REQUIRED");

  const toolchain = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  if (toolchain?.age !== "1.3.2" || toolchain?.postgresql !== "17.11")
    fail("G17_TOOLCHAIN_PIN_INVALID");
  const ownership = JSON.parse(
    await readFile(join(root, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(root, "config/database-role-map.json"), "utf8"),
  );
  const policy = parseYaml(await readFile(join(root, ".sops.yaml"), "utf8"));
  const plan = buildBackupRestorePlan(context, ownership, roleMap, policy);
  const config = parseYaml(
    await readFile(join(root, "config/platform.yaml"), "utf8"),
  );
  if (
    config.environment === "production" ||
    config.postgres?.host !== target.host ||
    config.postgres?.port !== target.port
  )
    fail("G17_TARGET_CONFIG_MISMATCH");
  const ageLocator = resolve(env.SOPS_AGE_KEY_FILE);
  const ageInfo = await lstat(ageLocator).catch(() => null);
  if (
    !ageInfo?.isFile() ||
    ageInfo.isSymbolicLink() ||
    (await realpath(ageLocator)) !== ageLocator
  )
    fail("G17_TRUSTED_AGE_LOCATOR_INVALID");
  for (const tool of ["psql", "pg_dump", "pg_restore"]) {
    commandFor(tool, ["--version"]);
    const actual = commandVersion(tool);
    if (!isPostgres1711(actual)) fail("G17_POSTGRES_CLIENT_VERSION_MISMATCH");
  }
  const ageVersion = commandVersion("age");
  if (ageVersion !== `v${toolchain.age}`) fail("G17_AGE_VERSION_MISMATCH");
  const artifactsDir = await ensureSafeEvidenceDirectory(
    sourceRoot,
    evidenceDir,
  );
  for (const name of ["backup-restore.json", "backup-restore-cleanup.json"]) {
    if (await lstat(join(artifactsDir, name)).catch(() => null))
      fail("G17_EVIDENCE_ALREADY_EXISTS");
  }
  for (const entry of plan.owners) {
    const path = join(evidenceDir, entry.ciphertext);
    if (await lstat(path).catch(() => null))
      fail("G17_CIPHERTEXT_ALREADY_EXISTS");
  }

  const bootstrap =
    await import("../../../../tools/config-bootstrap/index.mjs");
  const recovery = await import("./backup-restore-recovery.mjs");
  const credentials = { admin: new Map(), runtimes: new Map() };
  const runtimeByOwner = {
    orders: ["orders-aroma-preparation", "aroma-convergence"],
    integration: ["aroma-gateway"],
  };
  for (const owner of plan.owners) {
    const credential = await bootstrap.readG17BackupCredential({
      root,
      runId: plan.runId,
      candidateSha: plan.candidateSha,
      owner: owner.owner,
      sourceDatabase: owner.sourceDatabase,
      restoreDatabase: owner.restoreDatabase,
      host: target.host,
      port: target.port,
      expectedSystemIdentifier: target.systemIdentifier,
      env,
    });
    credentials.admin.set(owner.owner, credential.password);
    for (const runtime of runtimeByOwner[owner.owner] ?? []) {
      credentials.runtimes.set(
        runtime,
        await bootstrap.readG17BackupCredential({
          root,
          runId: plan.runId,
          candidateSha: plan.candidateSha,
          owner: owner.owner,
          runtime,
          sourceDatabase: owner.sourceDatabase,
          restoreDatabase: owner.restoreDatabase,
          host: target.host,
          port: target.port,
          expectedSystemIdentifier: target.systemIdentifier,
          env,
        }),
      );
    }
  }
  const password = credentials.admin.get(plan.owners[0].owner);
  const expectedVersion = toolchain.postgresql;
  const preflight = [];
  const sourceRoutineAcls = new Map();
  const sourceTableAcls = new Map();
  for (const owner of plan.owners) {
    preflight.push({
      owner: owner.owner,
      source: await serverIdentity({
        database: owner.sourceDatabase,
        owner: owner.owner,
        target,
        password: credentials.admin.get(owner.owner),
        root,
        io,
        expectedSystemIdentifier: target.systemIdentifier,
        expectedVersion,
        expectedDatabaseOwner: owner.migratorRole,
      }),
    });
    sourceRoutineAcls.set(
      owner.owner,
      await queryText(
        owner.owner,
        owner.sourceDatabase,
        g17RoutineAclSnapshotSql(owner.schema),
        { target, password: credentials.admin.get(owner.owner), root, io },
      ),
    );
    const sourceTableAcl = await queryText(
      owner.owner,
      owner.sourceDatabase,
      g17TableAclSnapshotSql(owner.schema),
      { target, password: credentials.admin.get(owner.owner), root, io },
    );
    verifyG17TableAclSnapshots(sourceTableAcl, sourceTableAcl, owner);
    sourceTableAcls.set(owner.owner, sourceTableAcl);
  }
  const existing = await queryText(
    "bootstrap",
    "postgres",
    `SELECT datname FROM pg_database WHERE datname IN (${plan.owners.map(({ restoreDatabase }) => `'${restoreDatabase}'`).join(",")}) ORDER BY datname`,
    { target, password, root, io },
  );
  if (existing) fail("G17_RESTORE_TARGET_ALREADY_EXISTS");
  const identity = await serverIdentity({
    database: "postgres",
    owner: "bootstrap",
    target,
    password,
    root,
    io,
    expectedSystemIdentifier: target.systemIdentifier,
    expectedVersion,
    expectedDatabaseOwner: "postgres",
  });

  const evidence = {
    schemaVersion: 1,
    status: "IN_PROGRESS",
    runId: plan.runId,
    candidateSha: plan.candidateSha,
    age: { version: "1.3.2", recipients: plan.age.recipients },
    server: identity,
    sources: preflight,
    owners: [],
    startedAt: new Date().toISOString(),
    cleanup: { verified: false },
  };
  const evidencePath = join(artifactsDir, "backup-restore.json");
  await writeEvidence(evidencePath, evidence);
  const created = [];
  const createAttempts = [];
  const restoreOwnership = new Map();
  const removedRestoreDatabases = [];
  const aggregateStartedAt = Date.now();
  let operationStage = "inspect-fixtures";
  try {
    const fixtures = await recovery.inspectG17RecoveryFixtures({
      target,
      password,
      runtimeCredentials: Object.fromEntries(credentials.runtimes),
      config,
      runId: plan.runId,
      sourceDatabases: Object.fromEntries(
        plan.owners.map(({ owner, sourceDatabase }) => [owner, sourceDatabase]),
      ),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    evidence.recoveryFixtures = {
      orderRef: fixtures.orders.orderRef,
      desiredHash: fixtures.orders.desiredHash,
      completedAttemptCount: fixtures.orders.completedAttemptCount,
      interruptedAttempt: fixtures.orders.interruptedAttempt,
      unknownOperationRef: fixtures.orders.operationRef,
      gatewayUnknownOperationRef: fixtures.gateway.operationRef,
      inbox: {
        completedMessageId: fixtures.orders.inbox.completedMessageId,
        pendingMessageId: fixtures.orders.inbox.pendingMessageId,
      },
      outbox: fixtures.orders.outbox,
    };
    await writeEvidence(evidencePath, evidence);
    for (const owner of plan.owners) {
      operationStage = "dump-encrypt";
      const ownerEnv = safePgEnv(target, credentials.admin.get(owner.owner));
      const source = commandFor("pg_dump", [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--dbname",
        owner.sourceDatabase,
      ]);
      const encrypt = {
        command: "age",
        args: [
          "--encrypt",
          ...plan.age.recipients.flatMap((recipient) => [
            "--recipient",
            recipient,
          ]),
        ],
        env: safeChildEnv(),
      };
      const ciphertextPath = join(artifactsDir, `${owner.owner}.dump.age`);
      const dumpStartedAt = new Date().toISOString();
      await runStreamPair({
        io,
        first: { ...source, env: ownerEnv },
        second: encrypt,
        outputPath: ciphertextPath,
        cwd: root,
        labels: ["PG_DUMP", "AGE_ENCRYPT"],
      });
      const dumpCompletedAt = new Date().toISOString();
      const ciphertextSha256 = await hashFile(ciphertextPath);
      const ciphertextSizeBytes = (await lstat(ciphertextPath)).size;
      const createSql = `CREATE DATABASE ${quoteIdentifier(owner.restoreDatabase)} OWNER ${quoteIdentifier(owner.migratorRole)} TEMPLATE template0`;
      operationStage = "create-restore";
      const ownedRestore = await createG17OwnedRestoreDatabase({
        ownerPlan: owner,
        identity: plan,
        created,
        createAttempts,
        createDatabase: () =>
          queryText(owner.owner, "postgres", createSql, {
            target,
            password,
            root,
            io,
          }),
        readOwnership: (database) =>
          readRestoreDatabaseOwnership(database, {
            target,
            password,
            root,
            io,
          }),
        setMarker: (database, marker) =>
          queryText(
            owner.owner,
            "postgres",
            `COMMENT ON DATABASE ${quoteIdentifier(database)} IS '${marker}'`,
            { target, password, root, io },
          ),
      });
      restoreOwnership.set(owner.owner, ownedRestore);
      const restore = commandFor("pg_restore", [
        "--single-transaction",
        "--exit-on-error",
        "--no-owner",
        "--no-acl",
        "--role",
        owner.migratorRole,
        "--dbname",
        owner.restoreDatabase,
      ]);
      const decrypt = {
        command: "age",
        args: ["--decrypt", "--identity", ageLocator, ciphertextPath],
        env: safeChildEnv(),
      };
      const restoreStartedAt = Date.now();
      operationStage = "decrypt-restore";
      await runStreamRestore({
        io,
        ageCommand: decrypt,
        restoreCommand: { ...restore, env: ownerEnv },
        cwd: root,
      });
      const restoreMs = Date.now() - restoreStartedAt;
      if (restoreMs > 10 * 60_000) fail("G17_RESTORE_TIME_LIMIT");
      operationStage = "restore-database-bootstrap";
      await queryText(
        owner.owner,
        owner.restoreDatabase,
        renderDatabaseSql({ ...owner, name: owner.restoreDatabase }),
        { target, password: credentials.admin.get(owner.owner), root, io },
      );
      operationStage = "restore-table-acl";
      await queryText(
        owner.owner,
        owner.restoreDatabase,
        renderG17RestoreTableAclSql(owner, sourceTableAcls.get(owner.owner)),
        { target, password: credentials.admin.get(owner.owner), root, io },
      );
      operationStage = "restore-routine-acl";
      await queryText(
        owner.owner,
        owner.restoreDatabase,
        renderG17RestoreFunctionAclSql(owner),
        { target, password: credentials.admin.get(owner.owner), root, io },
      );
      operationStage = "verify-routine-acl";
      const restoredRoutineAcl = await queryText(
        owner.owner,
        owner.restoreDatabase,
        g17RoutineAclSnapshotSql(owner.schema),
        { target, password: credentials.admin.get(owner.owner), root, io },
      );
      const routineAcl = verifyG17RoutineAclSnapshots(
        sourceRoutineAcls.get(owner.owner),
        restoredRoutineAcl,
      );
      operationStage = "verify-table-acl";
      const restoredTableAcl = await queryText(
        owner.owner,
        owner.restoreDatabase,
        g17TableAclSnapshotSql(owner.schema),
        { target, password: credentials.admin.get(owner.owner), root, io },
      );
      const tableAcl = verifyG17TableAclSnapshots(
        sourceTableAcls.get(owner.owner),
        restoredTableAcl,
        owner,
      );
      let ordersAclInvariants = null;
      if (owner.owner === "orders") {
        operationStage = "verify-orders-acl";
        const invariantSnapshot = await queryText(
          owner.owner,
          owner.restoreDatabase,
          g17OrdersAclInvariantSql(owner),
          { target, password: credentials.admin.get(owner.owner), root, io },
        );
        ordersAclInvariants = verifyG17OrdersAclInvariants(invariantSnapshot);
      }
      operationStage = "verify-restore-identity";
      await serverIdentity({
        database: owner.restoreDatabase,
        owner: owner.owner,
        target,
        password,
        root,
        io,
        expectedSystemIdentifier: target.systemIdentifier,
        expectedVersion,
        expectedDatabaseOwner: owner.migratorRole,
      });
      operationStage = "compare-source-restore";
      const snapshot = await snapshotDatabase({
        ownerPlan: owner,
        target,
        password,
        root,
        io,
      });
      evidence.owners.push({
        ...owner,
        restoreDatabaseOwnership: {
          oid: ownedRestore.oid,
          owner: ownedRestore.owner,
          marker: ownedRestore.marker,
        },
        dumpStartedAt,
        dumpCompletedAt,
        restoreMs,
        ciphertextSha256,
        ciphertextSizeBytes,
        routineAclSha256: createHash("sha256")
          .update(JSON.stringify(routineAcl))
          .digest("hex"),
        tableAclSha256: createHash("sha256")
          .update(JSON.stringify(tableAcl))
          .digest("hex"),
        ...(ordersAclInvariants
          ? {
              ordersAclInvariantSha256: createHash("sha256")
                .update(JSON.stringify(ordersAclInvariants))
                .digest("hex"),
            }
          : {}),
        ...snapshot,
        restoreVerified: true,
      });
      await writeEvidence(evidencePath, evidence);
    }
    operationStage = "recover-restored-state";
    const recoveryResult = await recovery.proveG17RecoveryAfterRestore({
      target,
      password,
      runtimeCredentials: Object.fromEntries(credentials.runtimes),
      config,
      runId: plan.runId,
      fixtures,
      restoreDatabases: Object.fromEntries(
        plan.owners.map(({ owner, restoreDatabase }) => [
          owner,
          restoreDatabase,
        ]),
      ),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (Date.now() - aggregateStartedAt > 30 * 60_000)
      fail("G17_TOTAL_TIME_LIMIT");
    evidence.recovery = recoveryResult.recovery;
    evidence.totalElapsedMs = Date.now() - aggregateStartedAt;
    evidence.status = "PASS";
  } catch (error) {
    evidence.status = "FAIL";
    evidence.failureStage = G17_OPERATION_STAGES.has(operationStage)
      ? operationStage
      : "inspect-fixtures";
    evidence.failureCode =
      typeof error?.code === "string" && /^G17_[A-Z0-9_:,-]+$/u.test(error.code)
        ? error.code
        : "G17_OPERATION_FAILED";
    evidence.failureDiagnostic = safeG17FailureDiagnostics(error);
    if (error?.code === "G17_SCHEMA_MISMATCH") {
      evidence.schemaComparisonDiagnostic =
        error.schemaComparisonDiagnostic ?? { diagnosticFailed: true };
    }
    evidence.ciphertextArtifacts = [];
    for (const owner of plan.owners) {
      const path = join(artifactsDir, `${owner.owner}.dump.age`);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink())
        evidence.ciphertextArtifacts.push({
          owner: owner.owner,
          sha256: await hashFile(path),
          sizeBytes: info.size,
        });
    }
    throw error;
  } finally {
    evidence.endedAt = new Date().toISOString();
    evidence.totalElapsedMs = Date.now() - aggregateStartedAt;
    await writeEvidence(evidencePath, evidence).catch(() => {});
    const cleanupResult = await cleanupG17OwnedRestoreDatabases({
      created,
      createAttempts,
      verifyServer: () =>
        serverIdentity({
          database: "postgres",
          owner: "bootstrap",
          target,
          password,
          root,
          io,
          expectedSystemIdentifier: target.systemIdentifier,
          expectedVersion,
          expectedDatabaseOwner: "postgres",
        }),
      readOwnership: (database) =>
        readRestoreDatabaseOwnership(database, { target, password, root, io }),
      dropDatabase: (database) =>
        queryText(
          "bootstrap",
          "postgres",
          `DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`,
          { target, password, root, io },
        ),
    });
    removedRestoreDatabases.push(...cleanupResult.removed);
    evidence.cleanup = {
      verified: cleanupResult.verified,
      removedRestoreDatabases,
      retainedRestoreDatabases: cleanupResult.retained,
      createAttempts: createAttempts.map(({ database, owner, state }) => ({
        database,
        owner,
        state,
      })),
    };
    if (!cleanupResult.verified) {
      evidence.status = "FAIL";
      evidence.failureCode = "G17_RESTORE_CLEANUP_FAILED";
    }
    await writeEvidence(
      join(artifactsDir, "backup-restore-cleanup.json"),
      evidence.cleanup,
    ).catch(() => {});
    await writeEvidence(evidencePath, evidence).catch(() => {});
  }
  return evidence;
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function resolveG17Target({
  root = ROOT,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
} = {}) {
  if (!contextPath) fail("G17_LAUNCH_CONTEXT_REQUIRED");
  try {
    const { validateG17BackupTarget } =
      await import("../../../../tools/config-bootstrap/index.mjs");
    return (await validateG17BackupTarget({ root, contextPath })).target;
  } catch {
    fail("G17_TARGET_TRUST_INVALID");
  }
}

async function main() {
  try {
    if (process.argv.length !== 2) fail("G17_ARGUMENTS_INVALID");
    const target = await resolveG17Target();
    const result = await runBackupRestoreScenario({
      target,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    const code =
      typeof error?.code === "string" && /^G17_[A-Z0-9_:,-]+$/u.test(error.code)
        ? error.code
        : "G17_OPERATION_FAILED";
    console.log(
      JSON.stringify(
        { status: "FAIL", code, ...safeG17FailureDiagnostics(error) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
