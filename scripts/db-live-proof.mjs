#!/usr/bin/env node

import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  SERVER_IDENTITY_SQL,
  bootstrapDatabases,
  readJson,
  replaceDatabase,
  validateServerProbe,
} from "./db-bootstrap.mjs";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ROLE_MAP = join(REPO_ROOT, "config/database-role-map.json");
const DEFAULT_OWNERSHIP = join(REPO_ROOT, "config/database-ownership.json");
export const POSTGRES_IMAGE =
  "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const LEGACY_DATABASES = ["coffeeorderdb", "coffeeorder_staging"];
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{5,31}$/;
const PROBE_TABLE = "issue3_db_live_permission_probe";

function fail(message) {
  throw new Error(`DB-LIVE-PROOF ${message}`);
}

async function docker(args) {
  try {
    return await execFileAsync("docker", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    fail(`docker ${args[0] ?? "command"} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function runId() {
  return `${Date.now().toString(36)}${randomBytes(6).toString("hex")}`.toLowerCase();
}

function safeRunId(value) {
  if (
    value !== undefined &&
    (!RUN_ID_PATTERN.test(value) || value.length > 32)
  ) {
    fail("run id must contain only lowercase verification characters");
  }
  return value ?? runId();
}

function roleList(roleMap) {
  return [
    ...roleMap.databases.map((database) => database.migratorRole),
    ...roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => runtime.role),
    ),
  ];
}

function roleEntries(roleMap) {
  return roleMap.databases.flatMap((database) =>
    database.runtimeRoles.map((runtime) => ({
      runtime: runtime.runtime,
      role: runtime.role,
      database: database.name,
      schema: database.schema,
    })),
  );
}

async function waitForPostgres(containerName) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await docker([
        "exec",
        containerName,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ]);
      return;
    } catch {
      await sleep(250);
    }
  }
  fail("PostgreSQL did not become ready within 20 seconds");
}

async function createClient(url) {
  const client = new Client(url);
  // pg emits connection errors asynchronously; keep the event attached so a
  // disposable proof reports the failed operation through its normal caller.
  client.on("error", () => {});
  await client.connect();
  return client;
}

async function createDatabase(adminUrl, database) {
  const admin = await createClient(adminUrl);
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }
}

function rawDatabaseUrl(adminUrl, database) {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function captureLegacy(adminUrl, database) {
  const client = await createClient(rawDatabaseUrl(adminUrl, database));
  try {
    const result = await client.query(
      `SELECT value FROM public."${PROBE_TABLE}" ORDER BY value`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function seedLegacy(adminUrl, database, marker) {
  await createDatabase(adminUrl, database);
  const client = await createClient(rawDatabaseUrl(adminUrl, database));
  try {
    await client.query(
      `CREATE TABLE public."${PROBE_TABLE}" (value text PRIMARY KEY)`,
    );
    await client.query(
      `INSERT INTO public."${PROBE_TABLE}" (value) VALUES ($1)`,
      [marker],
    );
  } finally {
    await client.end();
  }
}

async function verifyOwnWrite(adminUrl, roleEntry, password) {
  const client = await createClient(
    replaceDatabase(adminUrl, roleEntry.database, {
      user: roleEntry.role,
      password,
    }),
  );
  const probe = `${PROBE_TABLE}_${roleEntry.role.replaceAll("_", "")}`;
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query(
      `CREATE TEMP TABLE "${probe}" (probe_id integer PRIMARY KEY, runtime text NOT NULL) ON COMMIT DROP`,
    );
    await client.query(
      `INSERT INTO "${probe}" (probe_id, runtime) VALUES (1, $1)`,
      [roleEntry.runtime],
    );
    const result = await client.query(
      `SELECT count(*)::integer AS count FROM "${probe}"`,
    );
    if (String(result.rows?.[0]?.count) !== "1") {
      fail(`${roleEntry.runtime}: own database write did not round-trip`);
    }
    await client.query("ROLLBACK");
    started = false;
  } finally {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original own-write failure.
      }
    }
    await client.end();
  }
}

function permissionDenied(error) {
  return (
    error?.code === "42501" ||
    /permission denied|not authorized/i.test(String(error?.message ?? ""))
  );
}

async function verifyForeignOperations(
  adminUrl,
  database,
  schema,
  role,
  expectedRolePassword,
) {
  const client = await createClient(replaceDatabase(adminUrl, database));
  let roleSet = false;
  try {
    await client.query(
      `CREATE TABLE "${schema}"."${PROBE_TABLE}" (value text PRIMARY KEY)`,
    );
    await client.query(`SET ROLE "${role}"`);
    roleSet = true;
    for (const operation of [
      `SELECT value FROM "${schema}"."${PROBE_TABLE}"`,
      `INSERT INTO "${schema}"."${PROBE_TABLE}" (value) VALUES ('denied')`,
    ]) {
      let denied = false;
      try {
        await client.query("BEGIN");
        await client.query(operation);
        await client.query("ROLLBACK");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the permission result.
        }
        denied = permissionDenied(error);
      }
      if (!denied)
        fail(
          `${role}: foreign ${operation.startsWith("SELECT") ? "SELECT" : "INSERT"} was not denied`,
        );
    }
    await client.query("RESET ROLE");
    roleSet = false;
  } finally {
    if (roleSet) {
      try {
        await client.query("RESET ROLE");
      } catch {
        // Preserve the original smoke failure.
      }
    }
    try {
      await client.query(`DROP TABLE IF EXISTS "${schema}"."${PROBE_TABLE}"`);
    } finally {
      await client.end();
    }
  }
  // Make the role password an explicit input to this check without ever logging it.
  if (
    typeof expectedRolePassword !== "string" ||
    expectedRolePassword.length === 0
  )
    fail(`${role}: missing role secret`);
}

async function verifyRoleHardening(adminUrl, roleMap) {
  const client = await createClient(adminUrl);
  try {
    const roles = roleList(roleMap);
    const result = await client.query(
      "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[])",
      [roles],
    );
    if (result.rows.length !== roles.length)
      fail("not all declared roles were created");
    for (const row of result.rows) {
      if (
        row.rolsuper ||
        row.rolcreatedb ||
        row.rolcreaterole ||
        row.rolreplication ||
        row.rolbypassrls ||
        !row.rolcanlogin
      ) {
        fail(`${row.rolname}: role hardening invariant failed`);
      }
    }
    return result.rows.length;
  } finally {
    await client.end();
  }
}

async function writeEvidence(evidenceDir, result) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, `issue-3-db-live-proof-${result.runId}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

export async function runLiveProof({
  runId: requestedRunId,
  evidenceDir,
} = {}) {
  const proofRunId = safeRunId(requestedRunId);
  const containerName = `coffee-issue3-db-proof-${proofRunId}`;
  const adminPassword = randomBytes(32).toString("base64url");
  let adminUrl;
  let containerStarted = false;
  let cleanupPassed = false;
  let result;
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--label",
      "coffee.platform.issue=3",
      "--label",
      `coffee.platform.run=${proofRunId}`,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      "POSTGRES_DB=postgres",
      POSTGRES_IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(containerName);
    const portOutput = await docker([
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
      containerName,
    ]);
    const port = String(portOutput.stdout).trim();
    if (!/^\d+$/.test(port))
      fail("Docker did not publish an isolated PostgreSQL port");
    adminUrl = `postgresql://postgres:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/postgres`;

    const initialAdmin = await createClient(adminUrl);
    let probe;
    try {
      probe = (await initialAdmin.query(SERVER_IDENTITY_SQL)).rows[0];
    } finally {
      await initialAdmin.end();
    }
    const identity = validateServerProbe(probe, {
      expectedServerIdentity: probe.system_identifier,
    });
    const roleMap = await readJson(DEFAULT_ROLE_MAP);
    const ownership = await readJson(DEFAULT_OWNERSHIP);
    const rolePasswords = Object.fromEntries(
      roleList(roleMap).map((role) => [
        role,
        `${randomBytes(24).toString("base64url")}-${role}`,
      ]),
    );
    for (const [index, database] of LEGACY_DATABASES.entries()) {
      await seedLegacy(adminUrl, database, `legacy-${proofRunId}-${index}`);
    }
    const legacyBefore = Object.fromEntries(
      await Promise.all(
        LEGACY_DATABASES.map(async (database) => [
          database,
          await captureLegacy(adminUrl, database),
        ]),
      ),
    );
    const connectAsAdmin = async (database) =>
      createClient(replaceDatabase(adminUrl, database));
    const firstAdmin = await createClient(adminUrl);
    const first = await bootstrapDatabases({
      adminClient: firstAdmin,
      adminUrl,
      connectClient: connectAsAdmin,
      roleMap,
      ownership,
      rolePasswords,
      expectedServerIdentity: identity.serverIdentity,
    });
    await firstAdmin.end();
    const secondAdmin = await createClient(adminUrl);
    const second = await bootstrapDatabases({
      adminClient: secondAdmin,
      adminUrl,
      connectClient: connectAsAdmin,
      roleMap,
      ownership,
      rolePasswords,
      expectedServerIdentity: identity.serverIdentity,
    });
    await secondAdmin.end();
    if (!first.databases.every((database) => database.state === "created"))
      fail("first bootstrap did not create all five databases");
    if (!second.databases.every((database) => database.state === "existing"))
      fail("second bootstrap was not a no-op over existing databases");
    if (!first.idempotent || !second.idempotent)
      fail("bootstrap did not report idempotent execution");
    const hardenedRoleCount = await verifyRoleHardening(adminUrl, roleMap);
    let ownWriteCount = 0;
    let foreignSelectDeniedCount = 0;
    let foreignInsertDeniedCount = 0;
    for (const entry of roleEntries(roleMap)) {
      await verifyOwnWrite(adminUrl, entry, rolePasswords[entry.role]);
      ownWriteCount += 1;
      for (const database of roleMap.databases) {
        if (database.name === entry.database) continue;
        await verifyForeignOperations(
          adminUrl,
          database.name,
          database.schema,
          entry.role,
          rolePasswords[entry.role],
        );
        foreignSelectDeniedCount += 1;
        foreignInsertDeniedCount += 1;
      }
    }
    const legacyAfter = Object.fromEntries(
      await Promise.all(
        LEGACY_DATABASES.map(async (database) => [
          database,
          await captureLegacy(adminUrl, database),
        ]),
      ),
    );
    const legacyUnchanged =
      JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter);
    if (!legacyUnchanged) fail("legacy sentinel data changed");
    result = {
      schemaVersion: 1,
      runId: proofRunId,
      image: POSTGRES_IMAGE,
      serverVersion: identity.serverVersion,
      serverIdentitySha256: createHash("sha256")
        .update(identity.serverIdentity)
        .digest("hex"),
      bootstrap: {
        firstCreatedDatabaseCount: first.databases.filter(
          (database) => database.state === "created",
        ).length,
        secondExistingDatabaseCount: second.databases.filter(
          (database) => database.state === "existing",
        ).length,
        idempotent: first.idempotent && second.idempotent,
      },
      roles: {
        migratorCount: roleMap.databases.length,
        runtimeCount: roleEntries(roleMap).length,
        hardenedRoleCount,
      },
      permissions: {
        ownWriteCount,
        foreignSelectDeniedCount,
        foreignInsertDeniedCount,
      },
      legacy: { databases: LEGACY_DATABASES, unchanged: legacyUnchanged },
      cleanup: { containerName, containerRemoved: false },
    };
  } finally {
    if (containerStarted) {
      try {
        await docker(["rm", "--force", containerName]);
        cleanupPassed = true;
      } catch {
        cleanupPassed = false;
      }
    } else {
      cleanupPassed = true;
    }
    if (result) {
      result.cleanup.containerRemoved = cleanupPassed;
      await writeEvidence(evidenceDir, result);
    }
  }
  if (!result || !cleanupPassed) fail("live proof cleanup failed");
  return result;
}

async function main(argv) {
  const runIndex = argv.indexOf("--run-id");
  const evidenceIndex = argv.indexOf("--evidence-dir");
  const requestedRunId = runIndex === -1 ? undefined : argv[runIndex + 1];
  if (evidenceIndex !== -1 && !argv[evidenceIndex + 1])
    fail("--evidence-dir requires a value");
  const evidenceDir =
    evidenceIndex === -1 ? undefined : resolve(argv[evidenceIndex + 1]);
  if (runIndex !== -1 && !requestedRunId) fail("--run-id requires a value");
  const result = await runLiveProof({ runId: requestedRunId, evidenceDir });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
