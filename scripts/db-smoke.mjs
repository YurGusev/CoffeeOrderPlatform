#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replaceDatabase, readJson, validateRoleMap } from "./db-bootstrap.mjs";
import { exportedSQLContract } from "./db-live-proof.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OWNERSHIP = join(REPO_ROOT, "config/database-ownership.json");
const DEFAULT_ROLE_MAP = join(REPO_ROOT, "config/database-role-map.json");
const RUN_ID = /^[a-z0-9][a-z0-9_-]{5,31}$/;
const SAFE_DB_PREFIX = /^coffee_verify_[a-z0-9][a-z0-9_-]{5,31}_$/;

function fail(message) {
  throw new Error(`DB-SMOKE ${message}`);
}

export function validateSmokeTarget({ enabled, runId, databasePrefix }) {
  if (enabled !== true)
    fail("live smoke requires COFFEE_DB_SMOKE_ENABLED=true");
  if (typeof runId !== "string" || !RUN_ID.test(runId))
    fail("run id must be an explicit lowercase verification id");
  if (
    typeof databasePrefix !== "string" ||
    !SAFE_DB_PREFIX.test(databasePrefix) ||
    databasePrefix !== `coffee_verify_${runId}_`
  ) {
    fail(
      "database prefix must be the exact isolated coffee_verify_<run-id>_ target",
    );
  }
  return { runId, databasePrefix };
}

function appRoles(roleMap) {
  return roleMap.databases.flatMap((database) =>
    database.runtimeRoles.map((runtime) => ({
      ...runtime,
      database: database.name,
      schema: database.schema,
    })),
  );
}

export function buildSmokeCases(roleMap, ownership) {
  validateRoleMap(roleMap, ownership);
  const runtimes = appRoles(roleMap);
  const own = runtimes.map((runtime) => ({
    kind: "own-write",
    runtime: runtime.runtime,
    database: runtime.database,
    role: runtime.role,
  }));
  const crossOwner = runtimes.flatMap((runtime) =>
    roleMap.databases
      .filter((database) => database.name !== runtime.database)
      .map((database) => ({
        kind: "foreign-connect-denied",
        runtime: runtime.runtime,
        database: database.name,
        role: runtime.role,
      })),
  );
  return [...own, ...crossOwner];
}

function requireSql(contract, key, pattern, description) {
  const statement = contract.ddl?.[key];
  if (
    typeof statement !== "string" ||
    typeof contract.tables?.[key] !== "string" ||
    !statement.includes(`CREATE TABLE ${contract.tables[key]}`) ||
    !pattern.test(statement)
  )
    fail(`delivery SQL contract ${key} is missing ${description}`);
  return statement;
}

/**
 * Validate the exported owner-local DDL without connecting to PostgreSQL.
 * This is a structural smoke gate; live database and Kafka evidence have
 * separate commands and are never inferred from this result.
 */
export function validateDeliverySqlContract(contract = exportedSQLContract()) {
  if (!contract || typeof contract !== "object")
    fail("delivery SQL contract must be an object");
  const tables = contract.tables;
  if (!tables || typeof tables !== "object")
    fail("delivery SQL contract must declare owner-local tables");
  const tableNames = Object.values(tables);
  if (
    tableNames.length !== 4 ||
    tableNames.some(
      (table) =>
        typeof table !== "string" ||
        !/^"[a-z][a-z0-9_]{0,62}"\."[a-z][a-z0-9_]{0,62}"$/u.test(table),
    ) ||
    new Set(tableNames).size !== tableNames.length
  )
    fail("delivery SQL contract tables must be distinct owner-local qualified identifiers");
  const inbox = requireSql(
    contract,
    "inbox",
    /CREATE TABLE\s+"[a-z][a-z0-9_]{0,62}"\."[a-z][a-z0-9_]{0,62}"\s*\([\s\S]*message_id text PRIMARY KEY[\s\S]*payload_hash text NOT NULL CHECK[\s\S]*state text NOT NULL CHECK \(state IN \('Processing', 'Processed', 'Quarantined'\)\)[\s\S]*lease_owner text NOT NULL[\s\S]*lease_until timestamptz NOT NULL[\s\S]*attempt integer NOT NULL CHECK \(attempt > 0\)[\s\S]*processed_at timestamptz[\s\S]*quarantine_reason text[\s\S]*quarantined_at timestamptz[\s\S]*\);/u,
    "message identity, hash, state and lease fields",
  );
  const quarantine = requireSql(
    contract,
    "quarantine",
    /CREATE TABLE\s+[\s\S]*topic text NOT NULL[\s\S]*partition integer NOT NULL CHECK \(partition >= 0\)[\s\S]*"offset" text NOT NULL[\s\S]*payload_hash text CHECK \(payload_hash IS NULL OR payload_hash ~[\s\S]*PRIMARY KEY \(topic, partition, "offset"\)[\s\S]*\);/u,
    "Kafka identity quarantine key and payload hash",
  );
  const outbox = requireSql(
    contract,
    "outbox",
    /CREATE TABLE\s+[\s\S]*message_id text PRIMARY KEY[\s\S]*topic text NOT NULL[\s\S]*aggregate_ref text NOT NULL[\s\S]*aggregate_sequence bigint NOT NULL CHECK \(aggregate_sequence > 0\)[\s\S]*owner_version text NOT NULL[\s\S]*partition_key text NOT NULL[\s\S]*schema_version text NOT NULL[\s\S]*envelope jsonb NOT NULL[\s\S]*payload jsonb NOT NULL[\s\S]*payload_hash text NOT NULL CHECK[\s\S]*state text NOT NULL CHECK \(state IN \('Pending', 'Publishing', 'Published', 'Quarantined'\)\)[\s\S]*lease_owner text NOT NULL[\s\S]*lease_token bigint NOT NULL CHECK \(lease_token >= 0\)[\s\S]*lease_until timestamptz NOT NULL[\s\S]*attempt integer NOT NULL CHECK \(attempt >= 0\)[\s\S]*next_attempt_at timestamptz NOT NULL[\s\S]*last_error text[\s\S]*published_at timestamptz[\s\S]*quarantined_at timestamptz[\s\S]*UNIQUE \(aggregate_ref, aggregate_sequence\)[\s\S]*\);/u,
    "stable message identity, payload hash, publish state, lease and aggregate order",
  );
  const owner = requireSql(
    contract,
    "owner",
    /CREATE TABLE\s+[\s\S]*message_id text PRIMARY KEY[\s\S]*aggregate_ref text NOT NULL[\s\S]*effect_value text NOT NULL[\s\S]*applied_at timestamptz NOT NULL[\s\S]*UNIQUE \(aggregate_ref, message_id\)[\s\S]*\);/u,
    "owner effect identity",
  );
  const ddl = `${inbox}\n${quarantine}\n${outbox}\n${owner}`;
  if (/REFERENCES\s+[^\s(]+\.[^\s(]+/iu.test(ddl))
    fail("delivery SQL contract must not reference another owner's table");
  return {
    kind: "owner-local-sql-contract",
    source: "exportedSQLContract",
    liveDatabase: false,
    realKafka: false,
    tables: {...tables},
    checks: [
      "inbox-message-hash-state-lease",
      "quarantine-topic-partition-offset-hash",
      "outbox-stable-id-hash-lease-order",
      "outbox-aggregate-sequence-independent-of-message-type",
      "owner-effect-identity",
      "owner-local-no-cross-table-reference",
    ],
  };
}

function isPermissionDenied(error) {
  return (
    error?.code === "42501" ||
    /permission denied|not authorized/i.test(String(error?.message ?? ""))
  );
}

async function closeClient(client) {
  if (client && typeof client.end === "function") await client.end();
}

async function verifyOwnWrite(client, runtime) {
  const probe = `coffee_platform_db_smoke_probe_${runtime.role.replaceAll("-", "_")}`;
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query(
      `CREATE TEMP TABLE "${probe}" (probe_id integer PRIMARY KEY, runtime text NOT NULL) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO "${probe}" (probe_id, runtime) VALUES (1, $1)`,
      [runtime.runtime],
    );
    const result = await client.query(
      `SELECT count(*)::integer AS count FROM "${probe}"`,
    );
    if (
      result.rows?.[0]?.count !== 1 &&
      String(result.rows?.[0]?.count) !== "1"
    )
      fail(`${runtime.runtime}: own DB temporary write did not round-trip`);
    await client.query("ROLLBACK");
    transactionStarted = false;
  } finally {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* preserve the original smoke failure */
      }
    }
  }
}

export async function runDatabaseSmoke({
  baseAdminUrl,
  roleMap,
  ownership,
  rolePasswords,
  connectClient,
  isolatedTarget,
}) {
  validateSmokeTarget(isolatedTarget);
  validateRoleMap(roleMap, ownership);
  const structural = validateDeliverySqlContract();
  if (
    !rolePasswords ||
    typeof rolePasswords !== "object" ||
    Array.isArray(rolePasswords)
  )
    fail("role passwords must come from the scoped decrypted secret bundle");
  const cases = buildSmokeCases(roleMap, ownership);
  const results = [];
  for (const smokeCase of cases) {
    const password = rolePasswords[smokeCase.role];
    if (typeof password !== "string" || password.length === 0)
      fail(`${smokeCase.runtime}: missing scoped role secret`);
    const targetDatabase = `${isolatedTarget.databasePrefix}${smokeCase.database.replace("coffee_platform_", "")}`;
    let client;
    try {
      client = await connectClient({
        runtime: smokeCase.runtime,
        role: smokeCase.role,
        database: targetDatabase,
        password,
        url: replaceDatabase(baseAdminUrl, targetDatabase, {
          user: smokeCase.role,
          password,
        }),
      });
      if (smokeCase.kind === "own-write") {
        await verifyOwnWrite(client, smokeCase);
      } else {
        fail(`${smokeCase.runtime}: foreign database accepted a connection`);
      }
      results.push({ ...smokeCase, outcome: "unexpected-success" });
    } catch (error) {
      if (
        smokeCase.kind !== "foreign-connect-denied" ||
        !isPermissionDenied(error)
      )
        throw error;
      results.push({ ...smokeCase, outcome: "permission-denied" });
    } finally {
      await closeClient(client);
    }
  }
  return {
    runId: isolatedTarget.runId,
    structural,
    ownWriteCount: results.filter(
      (result) =>
        result.kind === "own-write" && result.outcome === "unexpected-success",
    ).length,
    foreignDeniedCount: results.filter(
      (result) =>
        result.kind === "foreign-connect-denied" &&
        result.outcome === "permission-denied",
    ).length,
    caseCount: results.length,
  };
}

async function main(argv) {
  const roleMap = await readJson(DEFAULT_ROLE_MAP);
  const ownership = await readJson(DEFAULT_OWNERSHIP);
  if (argv.length === 0 || argv.includes("--plan")) {
    console.log(
      JSON.stringify(
        {structural: validateDeliverySqlContract(), roleCases: buildSmokeCases(roleMap, ownership)},
        null,
        2,
      ),
    );
    return;
  }
  if (!argv.includes("--execute"))
    fail(
      "use --plan for offline cases or --execute for an explicitly approved isolated target",
    );
  const isolatedTarget = validateSmokeTarget({
    enabled: process.env.COFFEE_DB_SMOKE_ENABLED === "true",
    runId: process.env.COFFEE_DB_SMOKE_RUN_ID,
    databasePrefix: process.env.COFFEE_DB_SMOKE_DATABASE_PREFIX,
  });
  const baseAdminUrl = process.env.COFFEE_DB_ADMIN_URL;
  if (!baseAdminUrl) fail("COFFEE_DB_ADMIN_URL is required for live smoke");
  let rolePasswords;
  try {
    rolePasswords = JSON.parse(process.env.COFFEE_DB_ROLE_PASSWORDS_JSON ?? "");
  } catch (error) {
    fail(`scoped role secret bundle is not valid JSON (${error.message})`);
  }
  const { Client } = await import("pg").catch(() => {
    fail(
      "the pg dependency is required only for --execute; no network was attempted",
    );
  });
  const result = await runDatabaseSmoke({
    baseAdminUrl,
    roleMap,
    ownership,
    rolePasswords,
    isolatedTarget,
    connectClient: async ({ url }) => {
      const client = new Client(url);
      await client.connect();
      return client;
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
