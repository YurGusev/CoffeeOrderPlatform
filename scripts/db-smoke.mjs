#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { replaceDatabase, readJson, validateRoleMap } from "./db-bootstrap.mjs";

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
    console.log(JSON.stringify(buildSmokeCases(roleMap, ownership), null, 2));
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
