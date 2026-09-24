#!/usr/bin/env node

import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const DELIVERY_INBOX = "issue63_live_inbox_messages";
const DELIVERY_QUARANTINE = "issue63_live_inbox_quarantine";
const DELIVERY_OUTBOX = "issue63_live_outbox_messages";
const DELIVERY_OWNER = "issue63_live_owner_effects";

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

/**
 * SQL contract used by the disposable owner migration below and by db:smoke.
 * The contract is deliberately SQL text so the structural check inspects the
 * same DDL that the live proof executes; it does not claim a Kafka proof.
 */
export function exportedSQLContract(schemaName = FOUNDATION_SCHEMA) {
  const schema = foundationIdentifier(schemaName);
  const inbox = `${schema}.${foundationIdentifier(DELIVERY_INBOX)}`;
  const quarantine = `${schema}.${foundationIdentifier(DELIVERY_QUARANTINE)}`;
  const outbox = `${schema}.${foundationIdentifier(DELIVERY_OUTBOX)}`;
  const owner = `${schema}.${foundationIdentifier(DELIVERY_OWNER)}`;
  return {
    schema: schemaName,
    tables: {inbox, quarantine, outbox, owner},
    ddl: {
      inbox: `CREATE TABLE ${inbox} (
        message_id text PRIMARY KEY,
        message_type text NOT NULL,
        received_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        state text NOT NULL CHECK (state IN ('Processing', 'Processed', 'Quarantined')),
        lease_owner text NOT NULL,
        lease_until timestamptz NOT NULL,
        attempt integer NOT NULL CHECK (attempt > 0),
        processed_at timestamptz,
        quarantine_reason text,
        quarantined_at timestamptz
      );`,
      quarantine: `CREATE TABLE ${quarantine} (
        topic text NOT NULL,
        partition integer NOT NULL CHECK (partition >= 0),
        "offset" text NOT NULL,
        message_id text,
        message_type text,
        payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
        envelope jsonb,
        reason text NOT NULL,
        quarantined_at timestamptz NOT NULL,
        PRIMARY KEY (topic, partition, "offset")
      );`,
      outbox: `CREATE TABLE ${outbox} (
        message_id text PRIMARY KEY,
        message_type text NOT NULL,
        topic text NOT NULL,
        aggregate_ref text NOT NULL,
        aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
        owner_version text NOT NULL,
        partition_key text NOT NULL,
        schema_version text NOT NULL,
        envelope jsonb NOT NULL,
        payload jsonb NOT NULL,
        payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
        occurred_at timestamptz NOT NULL,
        correlation_id text NOT NULL,
        causation_id text,
        traceparent text,
        state text NOT NULL CHECK (state IN ('Pending', 'Publishing', 'Published', 'Quarantined')),
        lease_owner text NOT NULL,
        lease_token bigint NOT NULL CHECK (lease_token >= 0),
        lease_until timestamptz NOT NULL,
        attempt integer NOT NULL CHECK (attempt >= 0),
        next_attempt_at timestamptz NOT NULL,
        last_error text,
        published_at timestamptz,
        quarantined_at timestamptz,
        UNIQUE (aggregate_ref, aggregate_sequence)
      );`,
      owner: `CREATE TABLE ${owner} (
        message_id text PRIMARY KEY,
        aggregate_ref text NOT NULL,
        effect_value text NOT NULL,
        applied_at timestamptz NOT NULL,
        UNIQUE (aggregate_ref, message_id)
      );`,
    },
  };
}

export async function createDeliveryTables(adminUrl, database, rolePasswords, runtimeRole) {
  const migrator = await createClient(
    replaceDatabase(adminUrl, database.name, {
      user: database.migratorRole,
      password: rolePasswords[database.migratorRole],
    }),
  );
  const contract = exportedSQLContract();
  const {inbox, quarantine, outbox, owner} = contract.tables;
  try {
    await migrator.query(`${Object.values(contract.ddl).join("\n")}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${inbox}, ${quarantine}, ${outbox}, ${owner}
        TO ${foundationIdentifier(runtimeRole)};
    `);
  } finally {
    await migrator.end();
  }
  return {inbox, quarantine, outbox, owner};
}

export async function dropDeliveryTables(adminUrl, database, rolePasswords) {
  const migrator = await createClient(
    replaceDatabase(adminUrl, database.name, {
      user: database.migratorRole,
      password: rolePasswords[database.migratorRole],
    }),
  );
  const schema = foundationIdentifier(FOUNDATION_SCHEMA);
  try {
    await migrator.query(
      `DROP TABLE IF EXISTS ${schema}.${foundationIdentifier(DELIVERY_OUTBOX)}, ${schema}.${foundationIdentifier(DELIVERY_QUARANTINE)}, ${schema}.${foundationIdentifier(DELIVERY_INBOX)}, ${schema}.${foundationIdentifier(DELIVERY_OWNER)}`,
    );
  } finally {
    await migrator.end();
  }
}

function deliveryMessage(messageId, aggregateRef, aggregateSequence, payload, messageType = "Issue63.LiveEvent") {
  // Preserve a nanosecond envelope even though PostgreSQL timestamps round to microseconds.
  const occurredAt = new Date().toISOString().replace("Z", "123456Z");
  const correlationId = `correlation-${messageId}`;
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const ownerVersion = "1";
  return {
    messageId,
    messageType,
    topic: "coffee.issue63.live.v1",
    aggregateRef,
    aggregateSequence,
    ownerVersion,
    partitionKey: aggregateRef,
    schemaVersion: "1",
    envelope: {
      envelopeVersion: "1",
      messageId,
      messageType,
      occurredAt,
      producer: "orders-service",
      correlationId,
      causationId: null,
      traceparent,
      aggregate: {type: "Issue63Aggregate", ref: aggregateRef, version: ownerVersion},
      payload,
    },
    payload,
    occurredAt,
    correlationId,
    traceparent,
  };
}

function inboxMessage(message, canonicalRequestHash) {
  return {
    messageId: message.messageId,
    messageType: message.messageType,
    receivedAt: message.occurredAt,
    payloadHash: canonicalRequestHash(message.envelope),
    payload: message.envelope,
  };
}

async function deliveryRows(adminUrl, database, table, where, parameters = []) {
  const client = await createClient(replaceDatabase(adminUrl, database));
  try {
    return await client.query(
      `SELECT * FROM ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(table)} ${where}`,
      parameters,
    );
  } finally {
    await client.end();
  }
}

async function runDeliveryProof({adminUrl, port, roleMap, rolePasswords}) {
  const database = roleMap.databases.find(
    (candidate) => candidate.name === FOUNDATION_DATABASE,
  );
  if (!database) fail(`missing ${FOUNDATION_DATABASE} for delivery proof`);
  const runtime = database.runtimeRoles.find(
    (candidate) => candidate.runtime === "orders-service",
  );
  if (!runtime) fail("missing orders-service runtime role for delivery proof");
  await createDeliveryTables(adminUrl, database, rolePasswords, runtime.role);
  const roleEntry = {database: database.name, role: runtime.role};
  const password = rolePasswords[roleEntry.role];
  let databaseA;
  let databaseB;
  let crashDatabase;
  let recoveredDatabase;
  let unknownDatabase;
  try {
    const [{createDatabase: createFoundationDatabase, withTransaction, DatabaseTransactionError}, {createSqlInboxStore}, {createSqlOutboxStore}, {defineStatement}, {canonicalJson, canonicalRequestHash}] = await Promise.all([
      import(pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/index.js")).href),
      import(pathToFileURL(join(REPO_ROOT, "packages/platform-inbox/dist/index.js")).href),
      import(pathToFileURL(join(REPO_ROOT, "packages/platform-outbox/dist/index.js")).href),
      import(pathToFileURL(join(REPO_ROOT, "packages/platform-database/dist/owner.js")).href),
      import(pathToFileURL(join(REPO_ROOT, "packages/platform-idempotency/dist/index.js")).href),
    ]);
    databaseA = createFoundationDatabase(
      databaseConnectionOptions(adminUrl, roleEntry, password, port),
    );
    databaseB = createFoundationDatabase(
      databaseConnectionOptions(adminUrl, roleEntry, password, port),
    );
    await Promise.all([
      databaseA.resource.start(AbortSignal.timeout(1000)),
      databaseB.resource.start(AbortSignal.timeout(1000)),
    ]);
    const inboxA = createSqlInboxStore(databaseA, {
      schema: FOUNDATION_SCHEMA,
      table: DELIVERY_INBOX,
      quarantineTable: DELIVERY_QUARANTINE,
    });
    const outboxA = createSqlOutboxStore(databaseA, {
      schema: FOUNDATION_SCHEMA,
      table: DELIVERY_OUTBOX,
    });
    const outboxB = createSqlOutboxStore(databaseB, {
      schema: FOUNDATION_SCHEMA,
      table: DELIVERY_OUTBOX,
    });
    const ownerWriteA = defineDeliveryOwnerStatement(databaseA, defineStatement);
    const base = deliveryMessage("issue63-base", "aggregate-base", 1, {value: "base"});
    const toInbox = (message) => inboxMessage(message, canonicalRequestHash);
    const baseInbox = toInbox(base);
    let baseBegin;
    let baseOutbox;
    await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-base"}, async (transaction) => {
      baseBegin = await inboxA.begin(transaction, baseInbox, "consumer-a", Date.now(), 10_000);
      if (baseBegin.kind !== "acquired") fail(`base Inbox decision was ${baseBegin.kind}`);
      await ownerWriteA(transaction, [base.messageId, base.aggregateRef, "base", base.occurredAt]);
      baseOutbox = await outboxA.enqueue(transaction, base);
      await inboxA.markProcessed(transaction, base.messageId, "consumer-a", new Date().toISOString());
    });
    if (baseOutbox !== "created") fail(`base Outbox decision was ${baseOutbox}`);

    const baseOwner = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OWNER, "WHERE message_id = $1", [base.messageId]);
    const baseInboxRows = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_INBOX, "WHERE message_id = $1", [base.messageId]);
    const baseOutboxRows = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OUTBOX, "WHERE message_id = $1", [base.messageId]);
    if (baseOwner.rowCount !== 1 || baseInboxRows.rows[0]?.state !== "Processed" || baseOutboxRows.rowCount !== 1)
      fail("Inbox, owner state and Outbox were not committed atomically");

    const rolledBack = deliveryMessage("issue63-rollback", "aggregate-rollback", 1, {value: "rollback"});
    let rollbackCode;
    try {
      await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-rollback"}, async (transaction) => {
        const begin = await inboxA.begin(transaction, toInbox(rolledBack), "consumer-rollback", Date.now(), 10_000);
        if (begin.kind !== "acquired") fail(`rollback Inbox decision was ${begin.kind}`);
        await ownerWriteA(transaction, [rolledBack.messageId, rolledBack.aggregateRef, "rolled-back", rolledBack.occurredAt]);
        await outboxA.enqueue(transaction, rolledBack);
        await inboxA.markProcessed(transaction, rolledBack.messageId, "consumer-rollback", new Date().toISOString());
        throw new DatabaseTransactionError("DB_QUERY_FAILED");
      });
    } catch (error) {
      rollbackCode = error?.code;
    }
    const rolledBackOwner = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OWNER, "WHERE message_id = $1", [rolledBack.messageId]);
    const rolledBackInbox = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_INBOX, "WHERE message_id = $1", [rolledBack.messageId]);
    const rolledBackOutbox = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OUTBOX, "WHERE message_id = $1", [rolledBack.messageId]);
    if (rollbackCode !== "DB_QUERY_FAILED" || rolledBackOwner.rowCount !== 0 || rolledBackInbox.rowCount !== 0 || rolledBackOutbox.rowCount !== 0)
      fail("rollback left partial Inbox, owner or Outbox state");
    await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-rollback-retry"}, async (transaction) => {
      const begin = await inboxA.begin(transaction, toInbox(rolledBack), "consumer-retry", Date.now(), 10_000);
      if (begin.kind !== "acquired") fail(`rollback retry Inbox decision was ${begin.kind}`);
      await ownerWriteA(transaction, [rolledBack.messageId, rolledBack.aggregateRef, "retry", rolledBack.occurredAt]);
      if (await outboxA.enqueue(transaction, rolledBack) !== "created") fail("rollback retry did not create Outbox");
      await inboxA.markProcessed(transaction, rolledBack.messageId, "consumer-retry", new Date().toISOString());
    });
    for (const expected of [base, rolledBack]) {
      const claim = (await withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.claim(transaction, Date.now(), "publisher-seed", 1, 5_000)))[0];
      if (!claim || claim.message.messageId !== expected.messageId) fail(`seed Outbox claim was ${claim?.message.messageId ?? "empty"}`);
      await withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.finalize(transaction, claim.message.messageId, claim.leaseOwner, claim.leaseToken));
    }

    let duplicateDecision;
    let conflictDecision;
    let quarantineDecision;
    await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-duplicate"}, async (transaction) => {
      duplicateDecision = await inboxA.begin(transaction, baseInbox, "consumer-duplicate", Date.now(), 10_000);
      if (duplicateDecision.kind !== "duplicate") fail(`same Inbox payload returned ${duplicateDecision.kind}`);
      const duplicateOutbox = await outboxA.enqueue(transaction, base);
      if (duplicateOutbox !== "duplicate") fail(`same Outbox message returned ${duplicateOutbox}`);
    });
    const conflicting = {...base, envelope: {...base.envelope, producer: "other-producer"}};
    await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-conflict"}, async (transaction) => {
      conflictDecision = await inboxA.begin(transaction, toInbox(conflicting), "consumer-conflict", Date.now(), 10_000);
      if (conflictDecision.kind !== "conflict") fail(`different Inbox payload returned ${conflictDecision.kind}`);
      quarantineDecision = await inboxA.quarantineRecord(transaction, {
        topic: base.topic,
        partition: 0,
        offset: "63-conflict-1",
        messageId: conflicting.messageId,
        messageType: conflicting.messageType,
        envelope: conflicting.envelope,
        reason: "MESSAGE_ID_PAYLOAD_CONFLICT",
      }, Date.now());
    });
    if (quarantineDecision !== "created") fail(`Inbox conflict quarantine returned ${quarantineDecision}`);
    const quarantineRepeat = await withTransaction(databaseA, {mode: "interactive"}, (transaction) => inboxA.quarantineRecord(transaction, {
      topic: base.topic,
      partition: 0,
      offset: "63-conflict-1",
      messageId: conflicting.messageId,
      messageType: conflicting.messageType,
      envelope: conflicting.envelope,
      reason: "MESSAGE_ID_PAYLOAD_CONFLICT",
    }, Date.now()));
    if (quarantineRepeat !== "duplicate") fail(`duplicate quarantine returned ${quarantineRepeat}`);

    const sameSequenceAggregate = "aggregate-different-message-types";
    const differentTypeA = deliveryMessage("issue63-type-a", sameSequenceAggregate, 1, {value: "type-a"}, "Issue63.TypeA");
    const differentTypeB = deliveryMessage("issue63-type-b", sameSequenceAggregate, 1, {value: "type-b"}, "Issue63.TypeB");
    const directOutboxInsert = (database) => defineStatement(database, `INSERT INTO ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(DELIVERY_OUTBOX)}
      (message_id, message_type, topic, aggregate_ref, aggregate_sequence, owner_version,
       partition_key, schema_version, envelope, payload, payload_hash, occurred_at,
       correlation_id, causation_id, traceparent, state, lease_owner, lease_token,
       lease_until, attempt, next_attempt_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12::timestamptz,
       $13, $14, $15, 'Pending', '', 0, clock_timestamp(), 0, clock_timestamp())
      ON CONFLICT (aggregate_ref, aggregate_sequence) DO NOTHING RETURNING message_id`);
    const insertDifferentType = (statement, transaction, message) => statement(transaction, [
      message.messageId,
      message.messageType,
      message.topic,
      message.aggregateRef,
      message.aggregateSequence,
      message.ownerVersion,
      message.partitionKey,
      message.schemaVersion,
      canonicalJson(message.envelope),
      canonicalJson(message.payload),
      canonicalRequestHash(message.envelope),
      message.occurredAt,
      message.correlationId,
      null,
      message.traceparent,
    ]);
    const directOutboxInsertA = directOutboxInsert(databaseA);
    const directOutboxInsertB = directOutboxInsert(databaseB);
    const [differentTypeResultA, differentTypeResultB] = await Promise.all([
      withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-type-a"}, (transaction) => insertDifferentType(directOutboxInsertA, transaction, differentTypeA)),
      withTransaction(databaseB, {mode: "interactive", correlationId: "issue63-type-b"}, (transaction) => insertDifferentType(directOutboxInsertB, transaction, differentTypeB)),
    ]);
    const differentTypeRows = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OUTBOX, "WHERE aggregate_ref = $1", [sameSequenceAggregate]);
    const differentTypeAccepted = [differentTypeResultA, differentTypeResultB].filter((result) => result.rowCount === 1).length;
    const differentTypeConflicts = [differentTypeResultA, differentTypeResultB].filter((result) => result.rowCount === 0).length;
    if (differentTypeAccepted !== 1 || differentTypeConflicts !== 1 || differentTypeRows.rowCount !== 1)
      fail(`aggregate sequence uniqueness accepted ${differentTypeAccepted} and conflicted ${differentTypeConflicts} rows=${differentTypeRows.rowCount}`);
    const uniqueClaim = (await withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.claim(transaction, Date.now(), "publisher-unique", 1, 5_000)))[0];
    if (!uniqueClaim || uniqueClaim.message.aggregateRef !== sameSequenceAggregate) fail("missing unique sequence fixture claim");
    await withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.finalize(transaction, uniqueClaim.message.messageId, uniqueClaim.leaseOwner, uniqueClaim.leaseToken));

    const orderedOne = deliveryMessage("issue63-order-1", "aggregate-a-order", 1, {value: "one"});
    const orderedTwo = deliveryMessage("issue63-order-2", "aggregate-a-order", 2, {value: "two"});
    const independent = deliveryMessage("issue63-independent-1", "aggregate-b-independent", 1, {value: "independent"});
    await withTransaction(databaseA, {mode: "interactive", correlationId: "issue63-order-seed"}, async (transaction) => {
      for (const message of [orderedOne, orderedTwo, independent]) {
        if (await outboxA.enqueue(transaction, message) !== "created") fail(`seed Outbox did not create ${message.messageId}`);
      }
    });
    const firstClaim = await withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.claim(transaction, Date.now(), "publisher-order-a", 1, 5_000));
    if (firstClaim.length !== 1 || firstClaim[0].message.messageId !== orderedOne.messageId)
      fail(`first ordered claim was ${firstClaim.map((claim) => claim.message.messageId).join(",")}`);
    const secondClaim = await withTransaction(databaseB, {mode: "background"}, (transaction) => outboxB.claim(transaction, Date.now(), "publisher-order-b", 1, 5_000));
    if (secondClaim.length !== 1 || secondClaim[0].message.messageId !== independent.messageId)
      fail(`independent aggregate claim was ${secondClaim.map((claim) => claim.message.messageId).join(",")}`);
    await Promise.all([
      withTransaction(databaseA, {mode: "background"}, (transaction) => outboxA.finalize(transaction, firstClaim[0].message.messageId, firstClaim[0].leaseOwner, firstClaim[0].leaseToken)),
      withTransaction(databaseB, {mode: "background"}, (transaction) => outboxB.finalize(transaction, secondClaim[0].message.messageId, secondClaim[0].leaseOwner, secondClaim[0].leaseToken)),
    ]);
    const secondOrderClaim = await withTransaction(databaseB, {mode: "background"}, (transaction) => outboxB.claim(transaction, Date.now(), "publisher-order-b", 1, 5_000));
    if (secondOrderClaim.length !== 1 || secondOrderClaim[0].message.messageId !== orderedTwo.messageId)
      fail(`second ordered claim was ${secondOrderClaim.map((claim) => claim.message.messageId).join(",")}`);
    await withTransaction(databaseB, {mode: "background"}, (transaction) => outboxB.finalize(transaction, secondOrderClaim[0].message.messageId, secondOrderClaim[0].leaseOwner, secondOrderClaim[0].leaseToken));

    crashDatabase = createFoundationDatabase(databaseConnectionOptions(adminUrl, roleEntry, password, port));
    await crashDatabase.resource.start(AbortSignal.timeout(1000));
    const crashOutbox = createSqlOutboxStore(crashDatabase, {schema: FOUNDATION_SCHEMA, table: DELIVERY_OUTBOX});
    const crashMessage = deliveryMessage("issue63-lease-recovery", "aggregate-lease", 1, {value: "lease"});
    await withTransaction(crashDatabase, {mode: "background"}, (transaction) => crashOutbox.enqueue(transaction, crashMessage));
    const oldClaim = (await withTransaction(crashDatabase, {mode: "background"}, (transaction) => crashOutbox.claim(transaction, Date.now(), "publisher-old", 1, 50)))[0];
    if (!oldClaim || oldClaim.message.messageId !== crashMessage.messageId) fail("expired lease fixture was not claimed");
    await closeDatabase(crashDatabase);
    crashDatabase = undefined;
    await sleep(100);
    recoveredDatabase = createFoundationDatabase(databaseConnectionOptions(adminUrl, roleEntry, password, port));
    await recoveredDatabase.resource.start(AbortSignal.timeout(1000));
    const recoveredOutbox = createSqlOutboxStore(recoveredDatabase, {schema: FOUNDATION_SCHEMA, table: DELIVERY_OUTBOX});
    let staleFenceCode;
    try {
      await withTransaction(recoveredDatabase, {mode: "background"}, (transaction) => recoveredOutbox.finalize(transaction, oldClaim.message.messageId, oldClaim.leaseOwner, oldClaim.leaseToken));
    } catch (error) {
      staleFenceCode = error?.code;
    }
    const recoveredClaim = (await withTransaction(recoveredDatabase, {mode: "background"}, (transaction) => recoveredOutbox.claim(transaction, Date.now(), "publisher-new", 1, 5_000)))[0];
    if (!recoveredClaim || recoveredClaim.message.messageId !== oldClaim.message.messageId) fail("expired Outbox lease was not recoverable");
    await withTransaction(recoveredDatabase, {mode: "background"}, (transaction) => recoveredOutbox.finalize(transaction, recoveredClaim.message.messageId, recoveredClaim.leaseOwner, recoveredClaim.leaseToken));
    if (staleFenceCode !== "OUTBOX_LEASE_INVALID") fail(`stale Outbox fence returned ${staleFenceCode ?? "no error"}`);
    await closeDatabase(recoveredDatabase);
    recoveredDatabase = undefined;

    const unknownMessage = deliveryMessage("issue63-db-unknown", "aggregate-unknown", 1, {value: "unknown"});
    const proxy = await openBlackholeProxy(port, "COMMIT");
    unknownDatabase = createFoundationDatabase(databaseConnectionOptions(adminUrl, roleEntry, password, proxy.port));
    let unknownCode;
    try {
      await unknownDatabase.resource.start(AbortSignal.timeout(1000));
      const unknownInbox = createSqlInboxStore(unknownDatabase, {schema: FOUNDATION_SCHEMA, table: DELIVERY_INBOX, quarantineTable: DELIVERY_QUARANTINE});
      const unknownOutbox = createSqlOutboxStore(unknownDatabase, {schema: FOUNDATION_SCHEMA, table: DELIVERY_OUTBOX});
      const unknownOwner = defineDeliveryOwnerStatement(unknownDatabase, defineStatement);
      try {
        await withTransaction(unknownDatabase, {mode: "interactive", correlationId: "issue63-db-unknown"}, async (transaction) => {
          const begin = await unknownInbox.begin(transaction, toInbox(unknownMessage), "consumer-unknown", Date.now(), 10_000);
          if (begin.kind !== "acquired") fail(`DB unknown Inbox decision was ${begin.kind}`);
          await unknownOwner(transaction, [unknownMessage.messageId, unknownMessage.aggregateRef, "unknown", unknownMessage.occurredAt]);
          if (await unknownOutbox.enqueue(transaction, unknownMessage) !== "created") fail("DB unknown Outbox was not created");
          await unknownInbox.markProcessed(transaction, unknownMessage.messageId, "consumer-unknown", new Date().toISOString());
        });
      } catch (error) {
        unknownCode = error?.code;
      }
    } finally {
      await closeDatabase(unknownDatabase);
      unknownDatabase = undefined;
      await proxy.close();
    }
    if (unknownCode !== "TRANSACTION_OUTCOME_UNKNOWN") fail(`DB unknown returned ${unknownCode ?? "no error"}`);
    const unknownInboxRows = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_INBOX, "WHERE message_id = $1", [unknownMessage.messageId]);
    const unknownOutboxRows = await deliveryRows(adminUrl, FOUNDATION_DATABASE, DELIVERY_OUTBOX, "WHERE message_id = $1", [unknownMessage.messageId]);
    if (unknownInboxRows.rowCount !== 1 || unknownInboxRows.rows[0]?.state !== "Processed" || unknownOutboxRows.rowCount !== 1 || unknownOutboxRows.rows[0]?.state !== "Pending")
      fail("DB unknown did not preserve durable Inbox/Outbox state");
    const replayAfterUnknown = await withTransaction(databaseA, {mode: "interactive"}, (transaction) => inboxA.begin(transaction, toInbox(unknownMessage), "consumer-replay", Date.now(), 10_000));
    if (replayAfterUnknown.kind !== "duplicate") fail(`DB unknown replay returned ${replayAfterUnknown.kind}`);

    return {
      transport: "postgresql-only",
      realKafka: false,
      structural: {
        kind: "owner-local-sql-contract",
        source: "exportedSQLContract",
        liveDatabase: false,
        realKafka: false,
        tables: exportedSQLContract(FOUNDATION_SCHEMA).tables,
        checks: [
          "inbox-message-hash-state-lease",
          "quarantine-topic-partition-offset-hash",
          "outbox-stable-id-hash-lease-order",
          "outbox-aggregate-sequence-independent-of-message-type",
          "owner-effect-identity",
          "owner-local-no-cross-table-reference",
        ],
      },
      brokerAckProof: "not-run",
      offsetCommitProof: "not-run",
      atomicity: {
        committedInboxOwnerOutbox: true,
        rollbackCode,
        rollbackLeftNoPartialRows: true,
        redeliveryProcessed: true,
      },
      duplicateConflict: {
        inboxDuplicate: duplicateDecision.kind === "duplicate",
        inboxConflict: conflictDecision.kind === "conflict",
        quarantine: quarantineDecision,
        outboxDuplicate: true,
        outboxConflict: true,
      },
      payloadHash: {
        inboxValidated: baseBegin.record.payloadHash === canonicalRequestHash(base.envelope),
        outboxValidated: baseOutbox === "created",
        conflictQuarantined: quarantineDecision === "created",
        recoveredClaimValidated: recoveredClaim.payloadHash === canonicalRequestHash(recoveredClaim.message.envelope),
      },
      differentMessageTypeSequence: {
        concurrent: true,
        accepted: differentTypeAccepted,
        conflicts: differentTypeConflicts,
        durableRows: differentTypeRows.rowCount,
      },
      aggregateOrdering: {
        sameAggregate: [firstClaim[0].message.aggregateSequence.toString(), secondOrderClaim[0].message.aggregateSequence.toString()],
        sequenceBarrier: true,
        otherAggregateIndependent: secondClaim[0].message.aggregateRef === independent.aggregateRef,
      },
      crashAfterClaimBeforeFinalize: {
        stableMessageId: oldClaim.message.messageId === recoveredClaim.message.messageId,
        recovered: true,
        staleFenceCode,
        brokerAckProof: "not-run",
      },
      dbUnknown: {
        code: unknownCode,
        durableInboxState: unknownInboxRows.rows[0]?.state,
        durableOutboxState: unknownOutboxRows.rows[0]?.state,
        replay: replayAfterUnknown.kind,
        stableMessageId: unknownOutboxRows.rows[0]?.message_id === unknownMessage.messageId,
      },
    };
  } finally {
    await Promise.all([
      databaseA ? closeDatabase(databaseA) : Promise.resolve(),
      databaseB ? closeDatabase(databaseB) : Promise.resolve(),
      crashDatabase ? closeDatabase(crashDatabase) : Promise.resolve(),
      recoveredDatabase ? closeDatabase(recoveredDatabase) : Promise.resolve(),
      unknownDatabase ? closeDatabase(unknownDatabase) : Promise.resolve(),
    ]);
    await dropDeliveryTables(adminUrl, database, rolePasswords);
  }
}

function defineDeliveryOwnerStatement(database, defineStatement) {
  return defineStatement(
    database,
    `INSERT INTO ${foundationIdentifier(FOUNDATION_SCHEMA)}.${foundationIdentifier(DELIVERY_OWNER)} (message_id, aggregate_ref, effect_value, applied_at) VALUES ($1, $2, $3, $4::timestamptz)`,
  );
}

function packetQueries(buffer, queries, extendedQueries = []) {
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
    } else if (buffer[offset] === 0x50) {
      const body = buffer.subarray(offset + 5, offset + length + 1);
      const statementEnd = body.indexOf(0);
      const queryEnd = statementEnd < 0 ? -1 : body.indexOf(0, statementEnd + 1);
      if (queryEnd >= 0)
        extendedQueries.push(body.subarray(statementEnd + 1, queryEnd).toString("utf8").trim().toUpperCase());
    }
    offset += length + 1;
  }
  return buffer.subarray(offset);
}

function packetCommandTags(buffer, tags) {
  let offset = 0;
  while (buffer.length - offset >= 5) {
    const type = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    if (length < 4 || buffer.length - offset < length + 1) break;
    if (type === 0x43) {
      const body = buffer.subarray(offset + 5, offset + length + 1);
      const terminator = body.indexOf(0);
      if (terminator >= 0) tags.push(body.subarray(0, terminator).toString("utf8"));
    }
    offset += length + 1;
  }
  return buffer.subarray(offset);
}

export async function openBlackholeProxy(
  targetPort,
  commandToDrop,
  {
    targetHost = "127.0.0.1",
    listenHost = "127.0.0.1",
    listenPort = 0,
    dropOnce = false,
    dropCommandOnce = false,
    dropCommandAt = 1,
    dropReplyAt = 1,
    blockExtendedQuery,
  } = {},
) {
  if (!Number.isSafeInteger(dropCommandAt) || dropCommandAt < 1)
    fail("blackhole command occurrence must be a positive safe integer");
  if (!Number.isSafeInteger(dropReplyAt) || dropReplyAt < 1)
    fail("blackhole reply occurrence must be a positive safe integer");
  if (blockExtendedQuery !== undefined && (typeof blockExtendedQuery !== "string" || blockExtendedQuery.trim() === ""))
    fail("blackhole extended-query barrier must name a non-empty query fragment");
  const observed = [];
  const sockets = new Set();
  const commandWaiters = new Map();
  const replyDropWaiters = new Set();
  const queryBlockWaiters = new Set();
  const peerCloseWaiters = new Set();
  const blockedQueryFragment = blockExtendedQuery?.trim().toUpperCase();
  let closedPeers = 0;
  let replyDropped;
  let blockedQuery;
  let blockedQueryRelease;
  let blockQueryArmed = blockedQueryFragment !== undefined;
  let droppedReplyBytes = 0;
  let dropArmed = true;
  let dropCommandArmed = dropCommandOnce;
  let matchingCommands = 0;
  const rejectBarriers = (error) => {
    for (const waiters of commandWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    commandWaiters.clear();
    for (const waiter of replyDropWaiters) waiter.reject(error);
    replyDropWaiters.clear();
    for (const waiter of queryBlockWaiters) waiter.reject(error);
    queryBlockWaiters.clear();
    for (const waiter of peerCloseWaiters) waiter.reject(error);
    peerCloseWaiters.clear();
  };
  const signalCommand = (command) => {
    for (const waiter of commandWaiters.get(command) ?? []) waiter.resolve({ command });
    commandWaiters.delete(command);
  };
  const signalReplyDropped = (value) => {
    replyDropped = value;
    for (const waiter of replyDropWaiters) waiter.resolve(value);
    replyDropWaiters.clear();
  };
  const signalQueryBlocked = (query) => {
    blockedQuery = query;
    for (const waiter of queryBlockWaiters) waiter.resolve({query});
    queryBlockWaiters.clear();
  };
  const signalPeerClosed = () => {
    for (const waiter of peerCloseWaiters) waiter.resolve({closedPeers});
    peerCloseWaiters.clear();
  };
  const waitFor = (waiters, predicate, timeoutMs, description) => {
    if (predicate()) return Promise.resolve(predicate());
    return new Promise((resolvePromise, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          waiters.delete?.(waiter);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          waiters.delete?.(waiter);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete?.(waiter);
        reject(new Error(`blackhole protocol barrier timed out: ${description}`));
      }, timeoutMs);
      if (waiters.add) waiters.add(waiter);
      else waiters.push(waiter);
    });
  };
  const server = net.createServer((client) => {
    sockets.add(client);
    let commandBuffer = Buffer.alloc(0);
    let replyBuffer = Buffer.alloc(0);
    let upstream;
    let dropResponses = false;
    let holdQuery = false;
    let heldChunks = [];
    let peerClosed = false;
    const close = () => {
      if (peerClosed) return;
      peerClosed = true;
      closedPeers += 1;
      signalPeerClosed();
      sockets.delete(client);
      upstream?.destroy();
    };
    client.once("error", close);
    client.once("close", close);
    upstream = net.createConnection({ host: targetHost, port: targetPort });
    upstream.once("error", () => client.destroy());
    upstream.once("close", () => client.destroy());
    client.on("data", (chunk) => {
      if (holdQuery) {
        heldChunks.push(chunk);
        return;
      }
      commandBuffer = Buffer.concat([commandBuffer, chunk]);
      const before = observed.length;
      const extendedQueries = [];
      commandBuffer = packetQueries(commandBuffer, observed, extendedQueries);
      let suppressChunk = false;
      for (const command of observed.slice(before)) {
        signalCommand(command);
        if (command !== commandToDrop) continue;
        matchingCommands += 1;
        if (!dropCommandOnce && matchingCommands === dropReplyAt && (!dropOnce || dropArmed)) {
          dropResponses = true;
          dropArmed = false;
        }
        if (dropCommandArmed && matchingCommands === dropCommandAt) {
          suppressChunk = true;
          dropCommandArmed = false;
        }
      }
      for (const query of extendedQueries) {
        if (blockQueryArmed && query.includes(blockedQueryFragment)) {
          blockQueryArmed = false;
          holdQuery = true;
          heldChunks.push(chunk);
          blockedQueryRelease = () => {
            holdQuery = false;
            const chunks = heldChunks;
            heldChunks = [];
            for (const heldChunk of chunks) upstream.write(heldChunk);
          };
          signalQueryBlocked(query);
          return;
        }
      }
      if (!suppressChunk) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!dropResponses) {
        client.write(chunk);
        return;
      }
      droppedReplyBytes += chunk.length;
      const before = [];
      replyBuffer = Buffer.concat([replyBuffer, chunk]);
      replyBuffer = packetCommandTags(replyBuffer, before);
      if (replyDropped === undefined && before.includes(commandToDrop)) {
        signalReplyDropped({command: commandToDrop, tag: commandToDrop, bytes: droppedReplyBytes});
      }
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, resolvePromise);
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
    waitForCommand(command, timeoutMs = 5_000) {
      if (observed.includes(command)) return Promise.resolve({ command });
      const waiters = commandWaiters.get(command) ?? new Set();
      commandWaiters.set(command, waiters);
      return waitFor(
        waiters,
        () => observed.includes(command),
        timeoutMs,
        `${command} observed`,
      );
    },
    waitForReplyDropped(timeoutMs = 5_000) {
      if (replyDropped !== undefined) return Promise.resolve(replyDropped);
      return waitFor(
        replyDropWaiters,
        () => replyDropped !== undefined,
        timeoutMs,
        `${commandToDrop} reply dropped`,
      );
    },
    waitForQueryBlocked(timeoutMs = 5_000) {
      if (blockedQuery !== undefined) return Promise.resolve({query: blockedQuery});
      return waitFor(
        queryBlockWaiters,
        () => blockedQuery !== undefined,
        timeoutMs,
        `${blockedQueryFragment} extended query blocked`,
      );
    },
    releaseBlockedQuery() {
      if (blockedQueryRelease === undefined) fail("blackhole extended-query barrier was not blocked");
      const release = blockedQueryRelease;
      blockedQueryRelease = undefined;
      release();
    },
    waitForPeerClosed(previousClosedPeers = 0, timeoutMs = 5_000) {
      if (!Number.isSafeInteger(previousClosedPeers) || previousClosedPeers < 0)
        fail("blackhole peer-close baseline must be a non-negative safe integer");
      if (closedPeers > previousClosedPeers) return Promise.resolve({closedPeers});
      return waitFor(
        peerCloseWaiters,
        () => closedPeers > previousClosedPeers,
        timeoutMs,
        `database peer closed after baseline ${previousClosedPeers}`,
      );
    },
    closeConnections() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      rejectBarriers(new Error("blackhole proxy closed before protocol barrier"));
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

async function runCatalogActivationProof({ adminUrl, roleMap, rolePasswords }) {
  const catalog = roleMap.databases.find((database) => database.name === "coffee_platform_catalog");
  if (!catalog) fail("missing Catalog database in role map");
  const migrationNames = [
    "0001_supplier_snapshots.sql", "0002_snapshot_batches.sql", "0003_snapshot_staging.sql",
    "0004_catalog_active.sql", "0005_catalog_identity.sql", "0006_catalog_outbox.sql",
    "0007_catalog_grants.sql", "0008_catalog_active_read.sql",
  ];
  const migrationDirectory = join(REPO_ROOT, "apps/catalog-service/migrations");
  const migrator = await createClient(replaceDatabase(adminUrl, catalog.name, {
    user: catalog.migratorRole, password: rolePasswords[catalog.migratorRole],
  }));
  const appliedMigrations = [];
  try {
    await migrator.query(`CREATE TABLE IF NOT EXISTS catalog.platform_schema_migrations (
      id text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const name of migrationNames) {
      const sql = await readFile(join(migrationDirectory, name), "utf8");
      await migrator.query(sql);
      await migrator.query(
        "INSERT INTO catalog.platform_schema_migrations (id,checksum) VALUES ($1,$2)",
        [name.slice(0, -4), createHash("sha256").update(sql, "utf8").digest("hex")],
      );
      appliedMigrations.push(name.slice(0, -4));
    }
  } finally {
    await migrator.end();
  }

  const connectRole = async (role) => createClient(replaceDatabase(adminUrl, catalog.name, {
    user: role, password: rolePasswords[role],
  }));
  const activation = await connectRole("coffee_catalog_activate_rw");
  const api = await connectRole("coffee_catalog_api_ro");
  const importer = await connectRole("coffee_catalog_import_rw");
  const sqlstates = {};
  async function expectDenied(client, key, sql) {
    try {
      await client.query(sql);
    } catch (error) {
      sqlstates[key] = error.code ?? null;
      if (error.code !== "42501") fail(`${key}: expected SQLSTATE 42501, got ${error.code ?? "none"}`);
      outcomes[key] = true;
      return true;
    }
    sqlstates[key] = null;
    fail(`${key}: operation unexpectedly succeeded`);
  }
  const snapshotRef = `snp_${randomBytes(16).toString("hex").toUpperCase().slice(0, 26)}`;
  const supplierRef = `sup_${randomBytes(16).toString("hex").toUpperCase().slice(0, 26)}`;
  const productRef = `prd_${randomBytes(16).toString("hex").toUpperCase().slice(0, 26)}`;
  const messageId = `catalog-live-${randomBytes(8).toString("hex")}`;
  const outcomes = {};
  try {
    await importer.query(
      "INSERT INTO catalog.supplier_snapshots (snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at) VALUES ($1,$2,'live-proof','Received',0,1,0,0,repeat('a',64),clock_timestamp())",
      [snapshotRef, supplierRef],
    );
    await activation.query("SELECT snapshot_ref FROM catalog.supplier_snapshots WHERE snapshot_ref=$1", [snapshotRef]);
    outcomes.activationStagingSelect = true;
    await activation.query("UPDATE catalog.supplier_snapshots SET state='Active' WHERE snapshot_ref=$1", [snapshotRef]);
    await activation.query(
      "INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ($1,$2,'Live proof','live proof')",
      [snapshotRef, productRef],
    );
    await activation.query(
      "UPDATE catalog.catalog_state SET active_snapshot_ref=$1,active_snapshot_revision=1,active_content_hash=repeat('a',64),updated_at=clock_timestamp() WHERE id=true",
      [snapshotRef],
    );
    outcomes.activationActiveInsert = true;
    outcomes.activationActiveUpdate = true;

    const occurredAt = new Date().toISOString();
    const envelope = {
      envelopeVersion: "1", messageId, messageType: "CatalogSnapshotActivated.v1", occurredAt,
      producer: "db-live-proof", correlationId: "catalog-live-proof", causationId: null,
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      aggregate: {type: "Catalog", ref: "catalog", version: "1"},
      payload: {snapshotRef, snapshotRevision: "1"},
    };
    await activation.query(
      `INSERT INTO catalog.outbox_messages (message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,state,lease_owner,lease_token,lease_until,attempt,next_attempt_at) VALUES ($1,$2,'coffee.catalog.snapshot.v1','catalog',1,'1','catalog','1',$3::jsonb,$4::jsonb,repeat('b',64),$5,$6,NULL,$7,'Pending','',0,$5,0,$5)`,
      [messageId, "CatalogSnapshotActivated.v1", JSON.stringify(envelope), JSON.stringify(envelope.payload), occurredAt, "catalog-live-proof", envelope.traceparent],
    );
    await activation.query(
      "UPDATE catalog.outbox_messages SET state='Publishing',lease_owner='live-proof',lease_token=1,lease_until=clock_timestamp() + interval '1 minute' WHERE message_id=$1",
      [messageId],
    );
    outcomes.activationOutboxInsert = true;
    outcomes.activationOutboxUpdate = true;

    for (const view of ["active_products", "active_variants", "active_offer_mappings", "active_availability", "active_snapshot_metadata"]) {
      await api.query(`SELECT * FROM catalog.${view}`);
    }
    const metadata = await api.query("SELECT snapshot_ref,snapshot_revision FROM catalog.active_snapshot_metadata");
    if (metadata.rows.length !== 1 || metadata.rows[0].snapshot_ref !== snapshotRef || metadata.rows[0].snapshot_revision !== "1") {
      fail("API role must see the committed Catalog pointer and decimal-string revision");
    }
    outcomes.apiActiveViewsSelect = true;
    await expectDenied(api, "apiCatalogStateSelect", "SELECT * FROM catalog.catalog_state");
    await expectDenied(api, "apiStagingSelect", "SELECT * FROM catalog.supplier_snapshots");
    await expectDenied(api, "apiActiveInsert", `INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('${snapshotRef}','prd_00000000000000000000000001','Denied','denied')`);
    await expectDenied(api, "apiActiveUpdate", "UPDATE catalog.catalog_state SET active_snapshot_revision=2 WHERE id=true");
    await expectDenied(importer, "importActiveSelect", "SELECT * FROM catalog.active_products");
    await expectDenied(importer, "importActiveInsert", `INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('${snapshotRef}','prd_00000000000000000000000002','Denied','denied')`);
    await expectDenied(importer, "importActiveUpdate", "UPDATE catalog.catalog_state SET active_snapshot_revision=2 WHERE id=true");
    await expectDenied(importer, "importOutboxSelect", "SELECT * FROM catalog.outbox_messages");
    await expectDenied(importer, "importOutboxInsert", "INSERT INTO catalog.outbox_messages (message_id) VALUES ('denied')");
    await expectDenied(importer, "importOutboxUpdate", "UPDATE catalog.outbox_messages SET state='Published' WHERE message_id='missing'");

    const foreignConnect = {};
    for (const database of ["coffee_platform_customer", "coffee_platform_pricing", "coffee_platform_orders", "coffee_platform_integration"]) {
      const client = new Client({
        connectionString: replaceDatabase(adminUrl, database, {
          user: "coffee_catalog_activate_rw", password: rolePasswords.coffee_catalog_activate_rw,
        }), connectionTimeoutMillis: 1000, query_timeout: 2000,
      });
      client.on("error", () => {});
      try {
        await client.connect();
        foreignConnect[database] = { denied: false, sqlstate: null };
        fail(`activation role unexpectedly connected to ${database}`);
      } catch (error) {
        foreignConnect[database] = { denied: error.code === "42501", sqlstate: error.code ?? null };
        if (error.code !== "42501") fail(`activation CONNECT ${database}: expected SQLSTATE 42501, got ${error.code ?? "none"}`);
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    outcomes.connectDeniedToForeignDatabases = Object.values(foreignConnect).every((entry) => entry.denied);
    return { appliedMigrations, outcomes, sqlstates, foreignConnect };
  } finally {
    await importer.end();
    await api.end();
    await activation.end();
  }
}

async function writeEvidence(evidenceDir, result) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, {recursive: true});
  const {foundation, delivery, ...legacyResult} = result;
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
  if (delivery) {
    await writeFile(
      join(evidenceDir, `issue-63-db-live-proof-${result.runId}.json`),
      `${JSON.stringify({schemaVersion: 1, runId: result.runId, delivery}, null, 2)}\n`,
      "utf8",
    );
  }
}

export async function runLiveProof({
  runId: requestedRunId,
  evidenceDir,
  bindingProof,
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
      "--tmpfs",
      "/var/lib/postgresql/data",
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
    let binding;
    if (bindingProof !== undefined) {
      phase = "binding-proof";
      binding = await bindingProof({
        adminUrl,
        port: Number(port),
        roleMap,
        rolePasswords,
      });
    }
    phase = "database-foundation";
    const foundation = await runDatabaseFoundationProof({
      adminUrl,
      port: Number(port),
      roleMap,
      rolePasswords,
    });
    phase = "delivery-postgresql-proof";
    let delivery;
    try {
      delivery = await runDeliveryProof({
        adminUrl,
        port: Number(port),
        roleMap,
        rolePasswords,
      });
    } catch (error) {
      fail(`delivery PostgreSQL proof: ${error.message}`);
    }
    let catalogActivation;
    phase = "catalog-activation-postgresql-proof";
    try {
      catalogActivation = await runCatalogActivationProof({ adminUrl, roleMap, rolePasswords });
    } catch (error) {
      fail(`Catalog activation PostgreSQL proof: ${error.message}`);
    }
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
      ...(binding === undefined ? {} : {binding}),
      foundation,
      delivery,
      catalogActivation,
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
