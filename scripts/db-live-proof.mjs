#!/usr/bin/env node

import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const FOUNDATION_DATABASE = "coffee_platform_orders";
const FOUNDATION_SCHEMA = "orders";
const FOUNDATION_RECORDS = "issue62_live_transaction_records";
const IDEMPOTENCY_RECORDS = "issue62_live_idempotency_records";
const COPY_RECORDS = "issue62_live_copy_records";
const MIGRATION_LEDGER = "issue62_live_migration_ledger";
const MIGRATION_TABLE = "issue62_live_migrated_records";

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

async function waitForPostgres(adminUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const client = await createClient(adminUrl);
      try {
        await client.query("SELECT 1");
      } finally {
        await client.end();
      }
      return;
    } catch {
      await sleep(250);
    }
  }
  fail("PostgreSQL published TCP endpoint did not become ready within 20 seconds");
}

async function createClient(url) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  // pg emits connection errors asynchronously; keep the event attached so a
  // disposable proof reports the failed operation through its normal caller.
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
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

function foundationIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    fail(`unsafe foundation identifier ${value}`);
  return `"${value}"`;
}

function foundationPool(max = 2) {
  return {
    max,
    checkoutTimeoutMs: 150,
    lockTimeoutMs: 250,
    interactiveStatementTimeoutMs: 1000,
    backgroundStatementTimeoutMs: 1000,
    terminalTimeoutMs: 350,
    transactionTimeoutMs: 1200,
    idleTimeoutMs: 30000,
    maxLifetimeMs: 1800000,
  };
}

function databaseConnectionOptions(adminUrl, roleEntry, password, port, max = 2) {
  const parsed = new URL(adminUrl);
  return {
    owner: "issue62-live-proof",
    database: roleEntry.database,
    allowedDatabase: roleEntry.database,
    host: parsed.hostname,
    port,
    user: roleEntry.role,
    password,
    pool: foundationPool(max),
    shutdownGraceMs: 3000,
  };
}

async function createFoundationTables(adminUrl, roleMap, rolePasswords) {
  const database = roleMap.databases.find(
    (candidate) => candidate.name === FOUNDATION_DATABASE,
  );
  if (!database) fail(`missing ${FOUNDATION_DATABASE} in role map`);
  const runtime = database.runtimeRoles.find(
    (candidate) => candidate.runtime === "orders-service",
  );
  if (!runtime) fail("missing orders-service runtime role in role map");
  const migrator = await createClient(
    replaceDatabase(adminUrl, database.name, {
      user: database.migratorRole,
      password: rolePasswords[database.migratorRole],
    }),
  );
  const schema = foundationIdentifier(FOUNDATION_SCHEMA);
  try {
    await migrator.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.${foundationIdentifier(FOUNDATION_RECORDS)} (
        record_key text PRIMARY KEY,
        record_value text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${schema}.${foundationIdentifier(IDEMPOTENCY_RECORDS)} (
        actor_ref text NOT NULL,
        scope text NOT NULL,
        idempotency_key text NOT NULL,
        request_hash text NOT NULL,
        state text NOT NULL CHECK (state IN ('Acquired', 'Completed')),
        lease_owner text NOT NULL,
        lease_until timestamptz NOT NULL,
        created_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        response_status integer,
        response_body jsonb,
        resource_ref text,
        completed_at timestamptz,
        PRIMARY KEY (actor_ref, scope, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS ${schema}.${foundationIdentifier(COPY_RECORDS)} (
        value text PRIMARY KEY
      );
    `);
    await migrator.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.${foundationIdentifier(FOUNDATION_RECORDS)}, ${schema}.${foundationIdentifier(IDEMPOTENCY_RECORDS)}, ${schema}.${foundationIdentifier(COPY_RECORDS)} TO ${foundationIdentifier(runtime.role)}`,
    );
  } finally {
    await migrator.end();
  }
  return { database, runtime };
}

async function dropFoundationTables(adminUrl, database, rolePasswords) {
  const migrator = await createClient(
    replaceDatabase(adminUrl, database.name, {
      user: database.migratorRole,
      password: rolePasswords[database.migratorRole],
    }),
  );
  const schema = foundationIdentifier(FOUNDATION_SCHEMA);
  try {
    await migrator.query(
      `DROP TABLE IF EXISTS ${schema}.${foundationIdentifier(MIGRATION_TABLE)}, ${schema}.${foundationIdentifier(MIGRATION_LEDGER)}, ${schema}.${foundationIdentifier(COPY_RECORDS)}, ${schema}.${foundationIdentifier(IDEMPOTENCY_RECORDS)}, ${schema}.${foundationIdentifier(FOUNDATION_RECORDS)}`,
    );
  } finally {
    await migrator.end();
  }
}

function packetQueries(buffer, queries) {
  let offset = 0;
  while (buffer.length - offset >= 4) {
    if (buffer[offset] === 0) {
      const startupLength = buffer.readUInt32BE(offset);
      if (startupLength < 8 || buffer.length - offset < startupLength) break;
      offset += startupLength;
      continue;
    }
    if (buffer.length - offset < 5) break;
    const length = buffer.readUInt32BE(offset + 1);
    if (length < 4 || buffer.length - offset < length + 1) break;
    if (buffer[offset] === 0x51) {
      const body = buffer.subarray(offset + 5, offset + length + 1);
      queries.push(body.toString("utf8").replace(/\0.*$/s, "").trim().toUpperCase());
    }
    offset += length + 1;
  }
  return buffer.subarray(offset);
}

async function openBlackholeProxy(targetPort, commandToDrop) {
  const observed = [];
  const sockets = new Set();
  let closedPeers = 0;
  const server = net.createServer((client) => {
    sockets.add(client);
    let commandBuffer = Buffer.alloc(0);
    let upstream;
    let dropResponses = false;
    let peerClosed = false;
    const close = () => {
      if (peerClosed) return;
      peerClosed = true;
      closedPeers += 1;
      sockets.delete(client);
      upstream?.destroy();
    };
    client.once("error", close);
    client.once("close", close);
    upstream = net.createConnection({ host: "127.0.0.1", port: targetPort });
    upstream.once("error", () => client.destroy());
    upstream.once("close", () => client.destroy());
    client.on("data", (chunk) => {
      commandBuffer = Buffer.concat([commandBuffer, chunk]);
      const before = observed.length;
      commandBuffer = packetQueries(commandBuffer, observed);
      if (observed.slice(before).includes(commandToDrop)) dropResponses = true;
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!dropResponses) client.write(chunk);
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    fail("blackhole proxy did not bind an ephemeral port");
  }
  return {
    port: address.port,
    observed,
    get closedPeers() {
      return closedPeers;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  };
}

async function closeDatabase(database) {
  const stop = database.resource.stop(AbortSignal.timeout(1000));
  try {
    await Promise.race([
      stop,
      sleep(1000).then(() => {
        throw new Error("database stop exceeded live proof deadline");
      }),
    ]);
  } catch {
    database.resource.destroy();
    await Promise.race([stop.catch(() => undefined), sleep(100)]);
  }
}

async function waitForIdleMetrics(database, deadlineMs = 1000) {
  const startedAt = Date.now();
  let metrics = database.metrics();
  while (Date.now() - startedAt < deadlineMs) {
    metrics = database.metrics();
    if (metrics.active === 0 && metrics.pending === 0 && metrics.waiting === 0)
      return metrics;
    await sleep(10);
  }
  return metrics;
}

async function waitForClosedPeers(proxy, deadlineMs = 1000) {
  const startedAt = Date.now();
  while (proxy.closedPeers === 0 && Date.now() - startedAt < deadlineMs)
    await sleep(10);
  return proxy.closedPeers;
}

async function runCommitBlackholeProof({ adminUrl, roleEntry, password, port }) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const { defineStatement } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/owner.js"))
      .href,
  );
  const { canonicalRequestHash, createSqlIdempotencyStore } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-idempotency/dist/index.js"))
      .href,
  );
  const proxy = await openBlackholeProxy(port, "COMMIT");
  const database = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, proxy.port),
  );
  const idempotency = createSqlIdempotencyStore(database, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  const identity = { actorRef: "actor-62", scope: "commit-command", key: "blackhole-62" };
  const requestHash = canonicalRequestHash({ command: "commit-blackhole", issue: 62 });
  const response = { status: 201, body: { accepted: true } };
  const startedAt = Date.now();
  let code;
  let metricsBeforeStop;
  let closedPeersBeforeStop;
  let proofDatabase;
  try {
    await database.resource.start(AbortSignal.timeout(1000));
    proofDatabase = defineStatement(
      database,
      `INSERT INTO ${foundationIdentifier(FOUNDATION_RECORDS)} (record_key, record_value) VALUES ($1, $2)`,
    );
    try {
      await withTransaction(
        database,
        { mode: "interactive", correlationId: "issue62-commit-blackhole" },
        async (transaction) => {
          const acquired = await idempotency.acquire(
            transaction,
            identity,
            requestHash,
            "commit-blackhole-owner",
            startedAt,
            10000,
            60000,
          );
          if (acquired.kind !== "acquired") fail("commit blackhole idempotency was not acquired");
          await proofDatabase(transaction, ["commit-blackhole", "committed"]);
          await idempotency.complete(
            transaction,
            identity,
            "commit-blackhole-owner",
            response,
          );
          return "accepted";
        },
      );
    } catch (error) {
      code = error?.code;
    }
    metricsBeforeStop = await waitForIdleMetrics(database);
    if (
      metricsBeforeStop.active !== 0 ||
      metricsBeforeStop.idle !== 0 ||
      metricsBeforeStop.pending !== 0
    )
      fail(`commit blackhole left metrics active=${metricsBeforeStop.active}, idle=${metricsBeforeStop.idle}, pending=${metricsBeforeStop.pending}`);
    closedPeersBeforeStop = await waitForClosedPeers(proxy);
  } finally {
    await closeDatabase(database);
    await proxy.close();
  }
  if (code !== "TRANSACTION_OUTCOME_UNKNOWN")
    fail(`commit blackhole returned ${code ?? "no error"}; commands=${proxy.observed.join(",")}`);
  const verifier = await createClient(replaceDatabase(adminUrl, roleEntry.database));
  let rows;
  try {
    rows = await verifier.query(
      `SELECT record_value FROM ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(FOUNDATION_RECORDS)} WHERE record_key = $1`,
      ["commit-blackhole"],
    );
  } finally {
    await verifier.end();
  }
  if (rows.rowCount !== 1 || rows.rows[0].record_value !== "committed")
    fail("commit blackhole did not leave durable committed data");
  const restartDatabase = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const restartStore = createSqlIdempotencyStore(restartDatabase, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  let replay;
  try {
    await restartDatabase.resource.start(AbortSignal.timeout(1000));
    replay = await withTransaction(
      restartDatabase,
      { mode: "background" },
      async (transaction) => restartStore.get(transaction, identity),
    );
  } finally {
    await closeDatabase(restartDatabase);
  }
  if (
    replay?.state !== "Completed" ||
    replay.response?.status !== response.status ||
    JSON.stringify(replay.response.body) !== JSON.stringify(response.body)
  )
    fail("restart reconciliation did not return the durable terminal response");
  if (!proxy.observed.includes("COMMIT") || proxy.observed.includes("ROLLBACK"))
    fail(`commit blackhole command sequence was ${proxy.observed.join(",")}`);
  const wallClockMs = Date.now() - startedAt;
  if (wallClockMs >= 3000 || closedPeersBeforeStop < 1)
    fail(`commit blackhole bound/release evidence failed: ${wallClockMs}ms, closedPeersBeforeStop=${closedPeersBeforeStop}`);
  return {
    code,
    durableCommit: true,
    durableReplayAfterRestart: true,
    rollbackAfterCommit: false,
    wallClockMs,
    boundedByMs: 3000,
    metricsBeforeStop,
    closedPeers: closedPeersBeforeStop,
    closedPeersBeforeStop,
    commands: proxy.observed,
  };
}

async function runCaughtSqlRollbackProof({ adminUrl, roleEntry, password, port }) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const { defineStatement } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/owner.js"))
      .href,
  );
  const { canonicalRequestHash, createSqlIdempotencyStore } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-idempotency/dist/index.js"))
      .href,
  );
  const databaseA = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const databaseB = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const storeA = createSqlIdempotencyStore(databaseA, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  const storeB = createSqlIdempotencyStore(databaseB, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  const identity = { actorRef: "actor-62", scope: "caught-sql", key: "rollback-62" };
  const requestHash = canonicalRequestHash({ command: "caught-sql", issue: 62 });
  const ownerWrite = defineStatement(
    databaseB,
    `INSERT INTO ${foundationIdentifier(FOUNDATION_RECORDS)} (record_key, record_value) VALUES ($1, $2)`,
  );
  const failingStatement = defineStatement(databaseA, "SELECT * FROM issue62_missing_table");
  let code;
  let retryDecision;
  try {
    await Promise.all([
      databaseA.resource.start(AbortSignal.timeout(1000)),
      databaseB.resource.start(AbortSignal.timeout(1000)),
    ]);
    try {
      await withTransaction(databaseA, { mode: "background" }, async (transaction) => {
        const acquired = await storeA.acquire(
          transaction,
          identity,
          requestHash,
          "caught-sql-owner",
          Date.now(),
          10000,
          60000,
        );
        if (acquired.kind !== "acquired") fail("caught SQL proof did not acquire idempotency");
        try {
          await failingStatement(transaction, []);
        } catch {
          // The owner deliberately catches the SQL failure; PostgreSQL marks
          // the transaction aborted, so COMMIT must return command tag ROLLBACK.
        }
      });
    } catch (error) {
      code = error?.code;
    }
    const verifier = await createClient(replaceDatabase(adminUrl, roleEntry.database));
    try {
      const ownerRows = await verifier.query(
        `SELECT record_value FROM ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(FOUNDATION_RECORDS)} WHERE record_key = $1`,
        ["caught-sql-owner-state"],
      );
      if (ownerRows.rowCount !== 0) fail("caught SQL rollback committed owner state");
    } finally {
      await verifier.end();
    }
    retryDecision = await withTransaction(
      databaseB,
      { mode: "background" },
      async (transaction) => {
        const decision = await storeB.acquire(
          transaction,
          identity,
          requestHash,
          "caught-sql-retry",
          Date.now(),
          10000,
          60000,
        );
        if (decision.kind !== "acquired") return decision.kind;
        await ownerWrite(transaction, ["caught-sql-owner-state", "retry-committed"]);
        await storeB.complete(transaction, identity, "caught-sql-retry", {
          status: 200,
          body: "retry-committed",
        });
        return decision.kind;
      },
    );
  } finally {
    await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
  }
  if (code !== "DB_TRANSACTION_ROLLED_BACK")
    fail(`caught SQL COMMIT returned ${code ?? "no error"}`);
  if (retryDecision !== "acquired")
    fail(`caught SQL retry returned ${retryDecision ?? "no decision"}`);
  return { code, nextCall: retryDecision, falseReplay: false };
}

async function runRollbackBlackholeProof({ adminUrl, roleEntry, password, port }) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const proxy = await openBlackholeProxy(port, "ROLLBACK");
  const database = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, proxy.port),
  );
  const controller = new AbortController();
  const startedAt = Date.now();
  let code;
  let metricsBeforeStop;
  let closedPeersBeforeStop;
  try {
    await database.resource.start(AbortSignal.timeout(1000));
    try {
      await withTransaction(
        database,
        { mode: "interactive", signal: controller.signal },
        async () => {
          controller.abort();
        },
      );
    } catch (error) {
      code = error?.code;
    }
    metricsBeforeStop = await waitForIdleMetrics(database);
    if (
      metricsBeforeStop.active !== 0 ||
      metricsBeforeStop.pending !== 0 ||
      metricsBeforeStop.idle !== 0
    )
      fail(`rollback blackhole left metrics active=${metricsBeforeStop.active}, pending=${metricsBeforeStop.pending}, idle=${metricsBeforeStop.idle}`);
    closedPeersBeforeStop = await waitForClosedPeers(proxy);
  } finally {
    await closeDatabase(database);
    await proxy.close();
  }
  if (code !== "DB_ROLLBACK_FAILED")
    fail(`rollback blackhole returned ${code ?? "no error"}`);
  if (!proxy.observed.includes("ROLLBACK"))
    fail(`rollback blackhole did not issue ROLLBACK: ${proxy.observed.join(",")}`);
  const wallClockMs = Date.now() - startedAt;
  if (wallClockMs >= 3000 || closedPeersBeforeStop < 1)
    fail(`rollback blackhole bound/release evidence failed: ${wallClockMs}ms, closedPeersBeforeStop=${closedPeersBeforeStop}`);
  return {
    code,
    destroyed: true,
    wallClockMs,
    boundedByMs: 3000,
    metricsBeforeStop,
    closedPeers: closedPeersBeforeStop,
    closedPeersBeforeStop,
    commands: proxy.observed,
  };
}

async function runIdempotencyProof(adminUrl, roleEntry, password, port) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const { defineStatement } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/owner.js"))
      .href,
  );
  const { canonicalRequestHash, createSqlIdempotencyStore } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-idempotency/dist/index.js"))
      .href,
  );
  const databaseA = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const databaseB = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const storeA = createSqlIdempotencyStore(databaseA, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  const storeB = createSqlIdempotencyStore(databaseB, {
    schema: FOUNDATION_SCHEMA,
    table: IDEMPOTENCY_RECORDS,
  });
  const identity = { actorRef: "actor-62", scope: "orders-command", key: "request-62" };
  const requestHash = canonicalRequestHash({ command: "issue-62", value: 62 });
  const otherHash = canonicalRequestHash({ command: "issue-62", value: 63 });
  const now = Date.now();
  const response = { status: 201, body: { accepted: true } };
  const ownerWriteA = defineStatement(
    databaseA,
    `INSERT INTO ${foundationIdentifier(FOUNDATION_RECORDS)} (record_key, record_value) VALUES ($1, $2)`,
  );
  const ownerWriteB = defineStatement(
    databaseB,
    `INSERT INTO ${foundationIdentifier(FOUNDATION_RECORDS)} (record_key, record_value) VALUES ($1, $2)`,
  );
  const seedExpired = defineStatement(
    databaseB,
    `INSERT INTO ${foundationIdentifier(IDEMPOTENCY_RECORDS)} (actor_ref, scope, idempotency_key, request_hash, state, lease_owner, lease_until, created_at, expires_at) VALUES ($1, $2, $3, $4, 'Acquired', $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))`,
  );
  try {
    await Promise.all([
      databaseA.resource.start(AbortSignal.timeout(1000)),
      databaseB.resource.start(AbortSignal.timeout(1000)),
    ]);
    const acquire = (database, store, owner, ownerWrite, holdMs = 0) =>
      withTransaction(database, { mode: "background" }, async (transaction) => {
        const decision = await store.acquire(
          transaction,
          identity,
          requestHash,
          owner,
          now,
          10000,
          60000,
        );
        if (decision.kind === "acquired") {
          if (holdMs > 0) await sleep(holdMs);
          await ownerWrite(transaction, ["idempotency-owner-state", "one-owner-mutation"]);
          await store.complete(transaction, identity, owner, response);
        }
        return decision.kind;
      });
    const first = acquire(databaseA, storeA, "live-owner-a", ownerWriteA, 100);
    await sleep(20);
    const decisions = await Promise.all([
      first,
      acquire(databaseB, storeB, "live-owner-b", ownerWriteB),
    ]);
    const replay = await withTransaction(
      databaseB,
      { mode: "background" },
      async (transaction) =>
        storeB.acquire(transaction, identity, requestHash, "replay-owner", now, 10000, 60000),
    );
    const conflict = await withTransaction(
      databaseB,
      { mode: "background" },
      async (transaction) =>
        storeB.acquire(transaction, identity, otherHash, "conflict-owner", now, 10000, 60000),
    );
    const unknownIdentity = { actorRef: "actor-62", scope: "orders-command", key: "unknown-62" };
    await withTransaction(databaseB, { mode: "background" }, async (transaction) => {
      await seedExpired(transaction, [
        unknownIdentity.actorRef,
        unknownIdentity.scope,
        unknownIdentity.key,
        requestHash,
        "unknown-owner",
        now - 1,
        now - 60000,
        now + 60000,
      ]);
    });
    const expired = await withTransaction(
      databaseB,
      { mode: "background" },
      async (transaction) =>
        storeB.acquire(transaction, unknownIdentity, requestHash, "recovery-owner", now, 10000, 60000),
    );
    const terminalReplayBodies = [];
    for (const [index, body] of [null, "plain-string"].entries()) {
      const replayIdentity = { actorRef: "actor-62", scope: "orders-command", key: `body-${index}` };
      const replayHash = canonicalRequestHash({ body });
      await withTransaction(databaseB, { mode: "background" }, async (transaction) => {
        const acquired = await storeB.acquire(transaction, replayIdentity, replayHash, `body-owner-${index}`, now, 10000, 60000);
        if (acquired.kind !== "acquired") fail(`terminal body ${index} was not acquired`);
        await storeB.complete(transaction, replayIdentity, `body-owner-${index}`, { status: 200, body });
      });
      const terminalReplay = await withTransaction(
        databaseB,
        { mode: "background" },
        async (transaction) =>
          storeB.acquire(transaction, replayIdentity, replayHash, `body-replay-${index}`, now, 10000, 60000),
      );
      if (terminalReplay.kind !== "replay" || !Object.is(terminalReplay.response.body, body))
        fail(`terminal body ${index} was not replayable`);
      terminalReplayBodies.push(terminalReplay.response.body);
    }
    const ownerState = await withTransaction(
      databaseB,
      { mode: "background" },
      async (transaction) =>
        defineStatement(
          databaseB,
          `SELECT record_value FROM ${foundationIdentifier(FOUNDATION_RECORDS)} WHERE record_key = $1`,
        )(transaction, ["idempotency-owner-state"]),
    );
    if (decisions.filter((decision) => decision === "acquired").length !== 1)
      fail(`idempotency acquired decisions were ${decisions.join(",")}`);
    if (replay.kind !== "replay") fail("restart replay was not terminal");
    if (conflict.kind !== "conflict") fail("hash conflict was not detected");
    if (expired.kind !== "in_progress") fail("expired unknown lease was reacquired");
    if (ownerState.rowCount !== 1) fail("owner mutation was not atomic with idempotency completion");
    return {
      decisions,
      acquiredCount: decisions.filter((decision) => decision === "acquired").length,
      replayable: replay.kind === "replay",
      conflict: conflict.kind === "conflict",
      expiredLeaseRequiresRecovery: expired.kind === "in_progress",
      atomicOwnerMutation: ownerState.rowCount === 1,
      terminalReplayBodies,
    };
  } finally {
    await Promise.all([closeDatabase(databaseA), closeDatabase(databaseB)]);
  }
}

async function runMigrationDriftProof(adminUrl, database, rolePasswords) {
  const { createDatabase } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const { applyMigrations, migrationChecksum } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-migrations/dist/index.js"))
      .href,
  );
  const parsed = new URL(adminUrl);
  const foundation = createDatabase({
    owner: "issue62-live-migration-proof",
    database: database.name,
    allowedDatabase: database.name,
    host: parsed.hostname,
    port: Number(parsed.port),
    user: database.migratorRole,
    password: rolePasswords[database.migratorRole],
    pool: foundationPool(),
    shutdownGraceMs: 3000,
  });
  const schema = foundationIdentifier(FOUNDATION_SCHEMA);
  const migrationSql = `CREATE TABLE ${schema}.${foundationIdentifier(MIGRATION_TABLE)} (value text PRIMARY KEY)`;
  const migration = {
    id: "0001_issue62_live",
    sql: migrationSql,
    checksum: migrationChecksum(migrationSql),
  };
  let driftRejected = false;
  try {
    await foundation.resource.start(AbortSignal.timeout(1000));
    await applyMigrations(foundation, [migration], {
      schema: FOUNDATION_SCHEMA,
      ledgerTable: MIGRATION_LEDGER,
      lockKey: "issue62-live-migration-proof",
    });
    const driftSql = "SELECT 62";
    await applyMigrations(
      foundation,
      [{ id: migration.id, sql: driftSql, checksum: migrationChecksum(driftSql) }],
      { schema: FOUNDATION_SCHEMA, ledgerTable: MIGRATION_LEDGER, lockKey: "issue62-live-migration-proof" },
    );
  } catch (error) {
    driftRejected = error?.code === "MIGRATION_CHECKSUM_DRIFT";
  } finally {
    await closeDatabase(foundation);
  }
  if (!driftRejected) fail("live migration checksum drift was accepted");
  return { driftRejected, applied: migration.id };
}

async function runCopyInterruptionProof({ adminUrl, roleEntry, password, port }) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const { defineCopy } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/owner.js"))
      .href,
  );
  const database = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port),
  );
  const controller = new AbortController();
  let code;
  let source;
  let yielded = 0;
  try {
    await database.resource.start(AbortSignal.timeout(1000));
    const copy = defineCopy(database, COPY_RECORDS, ["value"], FOUNDATION_SCHEMA);
    source = Readable.from(
      (async function* () {
        for (let index = 0; ; index += 1) {
          yielded += 1;
          yield `copy-${index}\n`;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      })(),
    );
    const abortTimer = setTimeout(() => controller.abort(), 80);
    try {
      await withTransaction(
        database,
        { mode: "interactive", signal: controller.signal },
        async (transaction) => copy(transaction, source),
      );
    } catch (error) {
      code = error?.code;
    } finally {
      clearTimeout(abortTimer);
      source.destroy();
    }
  } finally {
    await closeDatabase(database);
  }
  const verifier = await createClient(replaceDatabase(adminUrl, roleEntry.database));
  let count;
  try {
    count = await verifier.query(
      `SELECT count(*)::integer AS count FROM ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(COPY_RECORDS)}`,
    );
  } finally {
    await verifier.end();
  }
  if (code !== "DB_INTERRUPTED")
    fail(`COPY interruption returned ${code ?? "no error"}`);
  if (!source?.destroyed || yielded === 0)
    fail(`COPY interruption did not stop its source: destroyed=${source?.destroyed}, yielded=${yielded}`);
  if (Number(count.rows[0].count) !== 0) fail("COPY interruption committed rows");
  return {
    code,
    rowsAfterRollback: Number(count.rows[0].count),
    sourceDestroyed: source.destroyed,
    sourceYielded: yielded,
  };
}

async function runReadinessAndSaturationProof({
  adminUrl,
  roleEntry,
  password,
  port,
}) {
  const { createDatabase, withTransaction } = await import(
    pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js"))
      .href,
  );
  const database = createDatabase(
    databaseConnectionOptions(adminUrl, roleEntry, password, port, 1),
  );
  let secondCode;
  let first;
  try {
    await database.resource.start(AbortSignal.timeout(1000));
    const readyBefore = await database.readiness.check(AbortSignal.timeout(1000));
    const hold = new Promise((resolvePromise) => setTimeout(resolvePromise, 220));
    first = withTransaction(database, { mode: "interactive" }, async () => {
      await hold;
      return "held";
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    const readyDuring = await database.readiness.check(AbortSignal.timeout(1000));
    try {
      await withTransaction(database, { mode: "interactive" }, async () => "second");
    } catch (error) {
      secondCode = error?.code;
    }
    const saturated = database.metrics();
    await first;
    const readyAfter = await database.readiness.check(AbortSignal.timeout(1000));
    if (!readyBefore || !readyDuring || !readyAfter)
      fail("transient pool saturation changed required readiness");
    if (secondCode !== "DB_POOL_EXHAUSTED")
      fail(`pool saturation returned ${secondCode ?? "no error"}`);
    database.resource.destroy();
    const readyAfterDestroy = await database.readiness.check(AbortSignal.timeout(100));
    if (readyAfterDestroy) fail("destroyed database remained ready");
    return {
      readyBefore,
      readyDuring,
      readyAfter,
      secondCode,
      saturationTotal: saturated.saturationTotal,
      activeAfter: database.metrics().active,
      readyAfterDestroy,
      transientSaturationSeparate: true,
    };
  } finally {
    await first?.catch(() => undefined);
    await closeDatabase(database);
  }
}

async function runDatabaseFoundationProof({
  adminUrl,
  port,
  roleMap,
  rolePasswords,
}) {
  let prepared;
  try {
    prepared = await createFoundationTables(adminUrl, roleMap, rolePasswords);
  } catch (error) {
    fail(`foundation setup: ${error.message}`);
  }
  const roleEntry = {
    database: prepared.database.name,
    role: prepared.runtime.role,
  };
  const password = rolePasswords[roleEntry.role];
  try {
    let transaction;
    try {
      transaction = await runCommitBlackholeProof({ adminUrl, roleEntry, password, port });
    } catch (error) {
      fail(`commit proof: ${error.message}`);
    }
    let rollback;
    try {
      rollback = await runRollbackBlackholeProof({ adminUrl, roleEntry, password, port });
    } catch (error) {
      fail(`rollback proof: ${error.message}`);
    }
    let caughtSqlRollback;
    try {
      caughtSqlRollback = await runCaughtSqlRollbackProof({ adminUrl, roleEntry, password, port });
    } catch (error) {
      fail(`caught SQL proof: ${error.message}`);
    }
    let idempotency;
    try {
      idempotency = await runIdempotencyProof(adminUrl, roleEntry, password, port);
    } catch (error) {
      fail(`idempotency proof: ${error.message}`);
    }
    let migration;
    try {
      migration = await runMigrationDriftProof(adminUrl, prepared.database, rolePasswords);
    } catch (error) {
      fail(`migration proof: ${error.message}`);
    }
    let copy;
    try {
      copy = await runCopyInterruptionProof({ adminUrl, roleEntry, password, port });
    } catch (error) {
      fail(`COPY proof: ${error.message}`);
    }
    let readiness;
    try {
      readiness = await runReadinessAndSaturationProof({ adminUrl, roleEntry, password, port });
    } catch (error) {
      fail(`readiness proof: ${error.message}`);
    }
    return { transaction, rollback, caughtSqlRollback, idempotency, migration, copy, readiness };
  } finally {
    try {
      await dropFoundationTables(adminUrl, prepared.database, rolePasswords);
    } catch (error) {
      fail(`foundation cleanup: ${error.message}`);
    }
  }
}

async function writeEvidence(evidenceDir, result) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  const { foundation, ...legacyResult } = result;
  await writeFile(
    join(evidenceDir, `issue-3-db-live-proof-${result.runId}.json`),
    `${JSON.stringify(legacyResult, null, 2)}\n`,
    "utf8",
  );
  if (foundation) {
    await writeFile(
      join(evidenceDir, `issue-62-db-live-proof-${result.runId}.json`),
      `${JSON.stringify({ schemaVersion: 1, runId: result.runId, foundation }, null, 2)}\n`,
      "utf8",
    );
  }
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
  let phase = "init";
  try {
    phase = "container-start";
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
    phase = "published-port";
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

    phase = "published-tcp-readiness";
    await waitForPostgres(adminUrl);

    phase = "server-identity";
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
    phase = "legacy-seed";
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
    phase = "bootstrap-first";
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
    phase = "bootstrap-second";
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
    phase = "permission-proof";
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
    phase = "database-foundation";
    const foundation = await runDatabaseFoundationProof({
      adminUrl,
      port: Number(port),
      roleMap,
      rolePasswords,
    });
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
      foundation,
      cleanup: { containerName, containerRemoved: false },
    };
  } catch (error) {
    const message = String(error?.message ?? error)
      .replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, "postgresql://redacted")
      .slice(0, 400);
    throw new Error(`DB-LIVE-PROOF phase=${phase}: ${message}`);
  } finally {
    if (containerStarted) {
      try {
        await docker(["rm", "--force", "--volumes", containerName]);
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
