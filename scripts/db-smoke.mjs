#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readJson, validateRoleMap } from "./db-bootstrap.mjs";
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
    fail(
      "delivery SQL contract tables must be distinct owner-local qualified identifiers",
    );
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
    tables: { ...tables },
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
  return error?.code === "42501";
}

async function closeClient(client) {
  if (client && typeof client.end === "function") await client.end();
}

export async function runDatabaseSmoke({
  roleMap,
  ownership,
  databaseByOwner,
  readRuntimeCredential,
  connectClient,
  host,
  port,
  expectedSystemIdentifier,
  runId,
}) {
  validateRoleMap(roleMap, ownership);
  const structural = validateDeliverySqlContract();
  if (
    typeof readRuntimeCredential !== "function" ||
    typeof connectClient !== "function" ||
    !databaseByOwner ||
    typeof databaseByOwner !== "object" ||
    !/^[a-z0-9][a-z0-9_-]{5,31}$/iu.test(runId ?? "") ||
    typeof expectedSystemIdentifier !== "string" ||
    !/^[0-9]{1,20}$/u.test(expectedSystemIdentifier) ||
    typeof host !== "string" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    fail("context-bound runtime smoke inputs are invalid");
  const cases = buildSmokeCases(roleMap, ownership);
  const ownerByDatabase = new Map(
    ownership.databases.map((database) => [database.name, database.owner]),
  );
  const expectedOwnerSet = ownership.databases
    .map(({ owner }) => owner)
    .sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(Object.keys(databaseByOwner).sort()) !==
    JSON.stringify(expectedOwnerSet)
  )
    fail("runtime owner database set is not canonical");
  const roleByRuntime = new Map(
    roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => [
        runtime.runtime,
        { ...runtime, owner: ownerByDatabase.get(database.name) },
      ]),
    ),
  );
  const ownOperations = [];
  const foreignConnectionDenials = [];
  for (const smokeCase of cases) {
    const runtime = roleByRuntime.get(smokeCase.runtime);
    const owner = runtime?.owner;
    const databaseOwner = ownerByDatabase.get(smokeCase.database);
    const database = databaseByOwner[databaseOwner];
    const expectedDatabase = databaseOwner
      ? `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${databaseOwner}`
      : null;
    if (
      !owner ||
      !databaseOwner ||
      typeof database !== "string" ||
      database !== expectedDatabase
    )
      fail("runtime owner database target is invalid");
    const credential = await readRuntimeCredential({
      owner,
      runtime: smokeCase.runtime,
      expectedSystemIdentifier,
    });
    if (
      credential?.username !== smokeCase.role ||
      typeof credential.password !== "string" ||
      credential.password.length === 0 ||
      credential.password.includes("\0")
    )
      fail("runtime credential does not match the canonical role claim");
    let client;
    try {
      client = await connectClient({
        runtime: smokeCase.runtime,
        role: smokeCase.role,
        database,
        host,
        port,
        username: credential.username,
        password: credential.password,
      });
      if (smokeCase.kind === "own-write" && databaseOwner === owner) {
        const identity = await client.query(
          "SELECT current_database() AS database, current_user AS role",
        );
        if (
          identity.rows?.[0]?.database !== database ||
          identity.rows?.[0]?.role !== smokeCase.role
        )
          fail("runtime connected to an unexpected database identity");
        const allowedTable = Object.entries(runtime.tables).find(([, grants]) =>
          grants.includes("SELECT"),
        )?.[0];
        if (!allowedTable || !/^[a-z][a-z0-9_]*$/u.test(allowedTable))
          fail("runtime role has no canonical SELECT probe target");
        const schema = roleMap.databases.find(
          (entry) => entry.name === smokeCase.database,
        )?.schema;
        if (!schema || !/^[a-z][a-z0-9_]*$/u.test(schema))
          fail("runtime role schema is invalid");
        await client.query(
          `SELECT 1 FROM "${schema}"."${allowedTable}" LIMIT 0`,
        );
        ownOperations.push({
          runtime: smokeCase.runtime,
          owner,
          database,
          role: smokeCase.role,
          schema,
          table: allowedTable,
          operation: "SELECT",
          outcome: "allowed",
        });
      } else {
        if (
          smokeCase.kind !== "foreign-connect-denied" ||
          databaseOwner === owner
        )
          fail("runtime smoke case does not match owner target");
        fail("foreign database accepted a runtime connection");
      }
    } catch (error) {
      if (
        smokeCase.kind !== "foreign-connect-denied" ||
        !isPermissionDenied(error)
      )
        throw error;
      foreignConnectionDenials.push({
        runtime: smokeCase.runtime,
        owner,
        databaseOwner,
        role: smokeCase.role,
        database,
        sqlState: "42501",
        outcome: "permission-denied",
      });
    } finally {
      await closeClient(client);
    }
  }
  return {
    runId,
    structural,
    ownOperations,
    foreignConnectionDenials,
    ownOperationCount: ownOperations.length,
    foreignDeniedCount: foreignConnectionDenials.length,
    caseCount: ownOperations.length + foreignConnectionDenials.length,
  };
}

async function main(argv) {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (
    (argv.length === 1 && argv[0] === "--plan") ||
    (argv.length === 0 && !contextPath)
  ) {
    const roleMap = await readJson(DEFAULT_ROLE_MAP);
    const ownership = await readJson(DEFAULT_OWNERSHIP);
    console.log(
      JSON.stringify(
        {
          structural: validateDeliverySqlContract(),
          roleCases: buildSmokeCases(roleMap, ownership),
        },
        null,
        2,
      ),
    );
    return;
  }
  fail(
    "live smoke moved to verification/launch/v1/scenarios/db-smoke.mjs; run pnpm db:smoke with the launch runner context, or pass --plan for the offline plan",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
