import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import dns from "node:dns";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import { load as parseYaml } from "js-yaml";
import { openBlackholeProxy } from "../../scripts/db-live-proof.mjs";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";
import { loadPlatformConfig } from "../../packages/platform-config/dist/index.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  parseServiceTransportMaterial,
  verifyTransportPeer,
} from "../../packages/platform-security/dist/index.js";
import { createAromaObserverComposition } from "../../apps/aroma-observer/dist/runtime-composition.js";
import { createAromaConvergenceComposition } from "../../apps/aroma-convergence/dist/runtime-composition.js";
import {
  normalizeAromaCartSnapshot,
  isAromaOwnerMessage,
  isAromaCartSnapshot,
} from "../../packages/contracts/aroma-v1/dist/index.js";

const observationSettings = parseYaml(
  await readFile(
    new URL("../../config/platform.yaml", import.meta.url),
    "utf8",
  ),
  { json: true },
).services["aroma-observer"].aromaObservation;
const OPTIONS = {
  intervalMs: observationSettings.intervalMs,
  leaseMs: observationSettings.leaseMs,
  maxSnapshotAgeMs: observationSettings.maxSnapshotAgeMs,
  maxLines: observationSettings.maxLines,
};
import {
  createDatabase,
  withTransaction,
} from "../../packages/platform-database/dist/index.js";
import { defineStatement } from "../../packages/platform-database/dist/owner.js";
import { createSqlOutboxStore } from "../../packages/platform-outbox/dist/index.js";
import {
  canonicalJson,
  canonicalRequestHash,
} from "../../packages/platform-idempotency/dist/index.js";

const MIGRATIONS = [
  "0001_create_orders",
  "0002_create_order_items",
  "0003_create_order_history",
  "0004_create_order_contributions",
  "0005_create_orders_idempotency",
  "0006_create_orders_outbox",
  "0007_order_grind_selection",
  "0008_create_orders_inbox",
  "0009_create_catalog_mapping_projection",
  "0010_create_cart_desired",
  "0011_create_cart_observed",
  "0012_create_convergence_attempts",
  "0013_create_convergence_leases",
  "0014_create_mutation_reservations",
  "0015_create_order_aroma_projections",
  "0016_create_aroma_work_schedules",
  "0017_allow_cart_outbox",
  "0018_guard_order_card_projection",
  "0019_read_guarded_aroma_card",
  "0020_guard_cart_fact_batches",
  "0021_optimize_observed_format_checks",
  "0022_terminal_cart_item_rejection",
  "0023_ascii_observed_identity",
];
const ROLES = [
  "coffee_orders_service_rw",
  "coffee_orders_prepare_rw",
  "coffee_orders_observer_rw",
  "coffee_orders_convergence_rw",
];
const POOL = {
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};
const signal = () => new AbortController().signal;
const fingerprint = "a".repeat(64);

function message(occurredAt, revision = "1") {
  const correlationId = randomUUID();
  const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
  const payload = {
    cartScopeRef: "aroma-primary",
    observedRevision: revision,
    observedAt: occurredAt,
    observationState: "Complete",
    cartFingerprint: fingerprint,
  };
  const envelope = {
    envelopeVersion: "1",
    messageId: `msg_${revision.padStart(26, "0")}`,
    messageType: "AromaObservationChanged.v1",
    occurredAt,
    producer: "aroma-observer",
    correlationId,
    causationId: null,
    traceparent,
    aggregate: { type: "AromaCart", ref: "aroma-primary", version: revision },
    payload,
  };
  return {
    messageId: envelope.messageId,
    messageType: envelope.messageType,
    topic: "coffee.aroma.cart.events.v1",
    aggregateRef: "aroma-primary",
    aggregateSequence: 1n,
    ownerVersion: revision,
    partitionKey: "aroma-primary",
    schemaVersion: "1",
    envelope,
    payload,
    occurredAt,
    correlationId,
    traceparent,
  };
}

// These success assertions are the narrow RED prerequisite gate. They must not be
// inverted to bless schema/adapter incompatibility or bypassed with a fake Order.
void test(
  "observer complete Observed + cart Outbox works under real owner role",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async (t) => {
    const receipt = await withCatalogPostgres(async ({ adminClient, port }) => {
      const databaseName = "coffee_platform_orders";
      const passwords = new Map();
      for (const role of ["coffee_orders_migrator", ...ROLES]) {
        const password = randomBytes(24).toString("hex");
        passwords.set(role, password);
        await adminClient.query(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
        );
      }
      await adminClient.query(
        "CREATE DATABASE coffee_platform_orders OWNER coffee_orders_migrator",
      );
      await adminClient.query(
        "REVOKE ALL ON DATABASE coffee_platform_orders FROM PUBLIC",
      );
      await adminClient.query(
        `GRANT CONNECT ON DATABASE coffee_platform_orders TO ${ROLES.join(",")}`,
      );
      const connect = async (role) => {
        const client = new Client({
          host: "127.0.0.1",
          port,
          database: databaseName,
          user: role,
          password: passwords.get(role),
          connectionTimeoutMillis: 2_000,
          ssl: false,
        });
        try {
          await client.connect();
          return client;
        } catch (error) {
          await client.end();
          throw error;
        }
      };
      const migrator = await connect("coffee_orders_migrator");
      let runtime;
      let observer;
      try {
        await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
        for (const id of MIGRATIONS) {
          await migrator.query(
            await readFile(
              new URL(
                `../../apps/orders-service/migrations/${id}.sql`,
                import.meta.url,
              ),
              "utf8",
            ),
          );
        }
        observer = await connect("coffee_orders_observer_rw");
        const role = (
          await observer.query(
            "SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0];
        assert.deepEqual(role, {
          name: "coffee_orders_observer_rw",
          rolsuper: false,
        });
        runtime = createDatabase({
          owner: "aroma-observer",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          port,
          user: role.name,
          password: passwords.get(role.name),
          ssl: false,
          pool: POOL,
          shutdownGraceMs: 40_000,
        });
        await runtime.resource.start(signal());
        const outbox = createSqlOutboxStore(runtime, {
          schema: "orders",
          envelopeBytes: true,
        });
        const insertObserved = defineStatement(
          runtime,
          `INSERT INTO orders.cart_observed_revisions
        (cart_scope_ref, observed_revision, state, provider_snapshot_ref, cart_fingerprint, captured_at, source_kind)
        VALUES ('aroma-primary',1,'Current',$1,$2,clock_timestamp(),'Observer')`,
        );
        const lock = defineStatement(
          runtime,
          "SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))",
        );
        const now = (
          await observer.query("SELECT clock_timestamp() AS now")
        ).rows[0].now.toISOString();
        const requiredByteColumns = (
          await observer.query(`SELECT column_name,is_nullable,column_default
        FROM information_schema.columns WHERE table_schema='orders' AND table_name='outbox_messages'
        AND column_name IN ('envelope_bytes','envelope_hash') ORDER BY column_name`)
        ).rows;
        t.diagnostic(
          `Outbox byte columns=${JSON.stringify(requiredByteColumns)}`,
        );
        const event = message(now);
        let adapterFailed = false;
        await t.test(
          "common SQL Outbox adapter atomically enqueues AromaObservationChanged.v1",
          async () => {
            try {
              const result = await withTransaction(
                runtime,
                {
                  mode: "background",
                  signal: signal(),
                  correlationId: event.correlationId,
                },
                async (tx) => {
                  await lock(tx, []);
                  await insertObserved(tx, [
                    `aroma-gateway:cart-body-sha256:${fingerprint}`,
                    fingerprint,
                  ]);
                  return outbox.enqueue(tx, event);
                },
              );
              assert.equal(result, "created");
            } catch (error) {
              adapterFailed = true;
              t.diagnostic(
                `common adapter failed: name=${error.name}; code=${error.code}; sqlState=${error.sqlState}`,
              );
              throw error;
            }
          },
        );
        await t.test(
          "Observed and Outbox commit together or both roll back on failure",
          async () => {
            const expected = adapterFailed ? 0 : 1;
            assert.equal(
              (
                await observer.query(
                  "SELECT count(*)::int AS count FROM orders.cart_observed_revisions",
                )
              ).rows[0].count,
              expected,
            );
            assert.equal(
              (
                await observer.query(
                  "SELECT count(*)::int AS count FROM orders.outbox_messages",
                )
              ).rows[0].count,
              expected,
            );
          },
        );
        await t.test(
          "cart scope is accepted by Orders Outbox even with complete exact byte facts",
          async () => {
            // Independent owner-role probe isolates the FK blocker from missing bytes.
            const direct = message(now, "2");
            const sequence = adapterFailed ? 1 : 2;
            const bytes = Buffer.from(canonicalJson(direct.envelope));
            const hash = createHash("sha256").update(bytes).digest("hex");
            try {
              await observer.query(
                `INSERT INTO orders.outbox_messages
            (message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,
             envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,traceparent,lease_until)
            VALUES($1::text,$2::text,$3::text,$4::varchar(30),$13::bigint,'2',$4::text,'1',$5::bytea,$6::char(64),$7::jsonb,$8::jsonb,$9::char(64),$10::timestamptz,$11::text,$12::text,clock_timestamp())`,
                [
                  direct.messageId,
                  direct.messageType,
                  direct.topic,
                  direct.aggregateRef,
                  bytes,
                  hash,
                  JSON.stringify(direct.envelope),
                  JSON.stringify(direct.payload),
                  canonicalRequestHash(direct.envelope),
                  now,
                  direct.correlationId,
                  direct.traceparent,
                  sequence,
                ],
              );
            } catch (error) {
              t.diagnostic(
                `complete byte facts failed: sqlState=${error.code}; constraint=${error.constraint}; column=${error.column ?? "none"}`,
              );
              // SQLSTATE/constraint only: never expose pg detail, payload or private responses.
              assert.fail(
                `cart Outbox rejected: sqlState=${error.code}; constraint=${error.constraint}`,
              );
            }
            assert.equal(
              (
                await observer.query(
                  "SELECT count(*)::int AS count FROM orders.outbox_messages",
                )
              ).rows[0].count,
              sequence,
            );
          },
        );
        const ownerTransaction = (callback) =>
          withTransaction(
            runtime,
            { mode: "background", signal: signal() },
            callback,
          );
        await t.test(
          "byte-backed replay and claim preserve exact envelope bytes/hash",
          async () => {
            const stored = (
              await observer.query(
                "SELECT * FROM orders.outbox_messages WHERE message_id=$1",
                [event.messageId],
              )
            ).rows[0];
            assert.ok(
              Buffer.from(stored.envelope_bytes).equals(
                Buffer.from(canonicalJson(event.envelope)),
              ),
            );
            assert.equal(
              stored.envelope_hash,
              canonicalRequestHash(event.envelope),
            );
            assert.equal(
              await ownerTransaction((transaction) =>
                outbox.enqueue(transaction, event),
              ),
              "duplicate",
            );
            const clock = Number(
              (
                await observer.query(
                  "SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
                )
              ).rows[0].now,
            );
            const claims = await ownerTransaction((transaction) =>
              outbox.claim(
                transaction,
                clock,
                "observer-byte-proof",
                1,
                30_000,
              ),
            );
            assert.equal(claims.length, 1);
            assert.deepEqual(claims[0].message.envelope, event.envelope);
            assert.equal(claims[0].message.messageId, event.messageId);
            await ownerTransaction((transaction) =>
              outbox.finalize(
                transaction,
                event.messageId,
                claims[0].leaseOwner,
                claims[0].leaseToken,
              ),
            );
            assert.equal(
              (
                await observer.query(
                  "SELECT state FROM orders.outbox_messages WHERE message_id=$1",
                  [event.messageId],
                )
              ).rows[0].state,
              "Published",
            );
          },
        );
        await t.test(
          "topic-scoped relay never claims another producer topic and retains cross-topic aggregate ordering",
          async () => {
            const commands = createSqlOutboxStore(runtime, {
              schema: "orders",
              envelopeBytes: true,
              topics: ["coffee.aroma.cart.commands.v1"],
            });
            const events = createSqlOutboxStore(runtime, {
              schema: "orders",
              envelopeBytes: true,
              topics: ["coffee.aroma.cart.events.v1"],
            });
            const clock = () => Number(Date.now() + 1000);
            assert.deepEqual(
              await ownerTransaction((tx) =>
                commands.claim(tx, clock(), "command-relay", 10, 30_000),
              ),
              [],
            );
            assert.equal(
              (
                await observer.query(
                  "SELECT attempt FROM orders.outbox_messages WHERE message_id=$1",
                  [message(now, "2").messageId],
                )
              ).rows[0].attempt,
              0,
            );
            const envelope = JSON.parse(
              await readFile(
                new URL(
                  "../../contracts/fixtures/positive/events/aroma-convergence-requested.v1.json",
                  import.meta.url,
                ),
                "utf8",
              ),
            );
            const command = {
              messageId: envelope.messageId,
              messageType: envelope.messageType,
              topic: "coffee.aroma.cart.commands.v1",
              aggregateRef: "aroma-primary",
              aggregateSequence: 3n,
              ownerVersion: "3",
              partitionKey: "aroma-primary",
              schemaVersion: "1",
              envelope,
              payload: envelope.payload,
              occurredAt: envelope.occurredAt,
              correlationId: envelope.correlationId,
              causationId: envelope.causationId,
              traceparent: envelope.traceparent,
            };
            await ownerTransaction((tx) => outbox.enqueue(tx, command));
            assert.deepEqual(
              await ownerTransaction((tx) =>
                commands.claim(tx, clock(), "command-relay", 10, 30_000),
              ),
              [],
              "unpublished earlier event must block later command on the same cart stream",
            );
            const [eventClaim] = await ownerTransaction((tx) =>
              events.claim(tx, clock(), "event-relay", 10, 30_000),
            );
            assert.equal(
              eventClaim.message.topic,
              "coffee.aroma.cart.events.v1",
            );
            await ownerTransaction((tx) =>
              events.finalize(
                tx,
                eventClaim.message.messageId,
                eventClaim.leaseOwner,
                eventClaim.leaseToken,
              ),
            );
            const [commandClaim] = await ownerTransaction((tx) =>
              commands.claim(tx, clock(), "command-relay", 10, 30_000),
            );
            assert.equal(commandClaim.message.messageId, command.messageId);
            assert.deepEqual(commandClaim.message.envelope, envelope);
            await ownerTransaction((tx) =>
              commands.finalize(
                tx,
                commandClaim.message.messageId,
                commandClaim.leaseOwner,
                commandClaim.leaseToken,
              ),
            );
          },
        );
        await t.test(
          "cart allowance retains real Order FK and rejects other scopes/topics",
          async () => {
            const base = message(now, "9");
            const orderRef = "ord_00000000000000000000000009";
            const payload = { orderRef, orderVersion: "9", requestedAt: now };
            const order = {
              ...base,
              messageType: "OrderReconciliationRequested.v1",
              topic: "coffee.orders.lifecycle.v1",
              aggregateRef: orderRef,
              partitionKey: orderRef,
              payload,
              envelope: {
                ...base.envelope,
                messageType: "OrderReconciliationRequested.v1",
                producer: "orders-service",
                aggregate: { type: "Order", ref: orderRef, version: "9" },
                payload,
              },
            };
            await assert.rejects(
              ownerTransaction((transaction) =>
                outbox.enqueue(transaction, order),
              ),
              (error) => error.sqlState === "23503",
            );
            const other = {
              ...base,
              aggregateRef: "aroma-secondary",
              partitionKey: "aroma-secondary",
              envelope: {
                ...base.envelope,
                aggregate: {
                  ...base.envelope.aggregate,
                  ref: "aroma-secondary",
                },
              },
            };
            await assert.rejects(
              ownerTransaction((transaction) =>
                outbox.enqueue(transaction, other),
              ),
              (error) => error.sqlState === "23514",
            );
            await assert.rejects(
              ownerTransaction((transaction) =>
                outbox.enqueue(transaction, {
                  ...base,
                  aggregateSequence: 4n,
                  topic: "coffee.orders.lifecycle.v1",
                }),
              ),
              (error) => error.sqlState === "23514",
            );
          },
        );
        return { runtimeRole: role.name };
      } finally {
        if (runtime !== undefined)
          await runtime.resource.stop(AbortSignal.timeout(5_000));
        if (observer !== undefined) await observer.end();
        await migrator.end();
      }
    });
    assert.equal(receipt.cleanup.containerRemoved, true);
    t.diagnostic(
      `disposable cleanup containerRemoved=${receipt.cleanup.containerRemoved}; runtimeRole=${receipt.runtimeRole}`,
    );
  },
);

// Separate database/domain fixture: prerequisite observations/events above are
// never treated as real domain history for the store behavioral proofs.
async function withObserverDomain(run, owner = "aroma-observer") {
  const role = owner === "aroma-observer" ? "coffee_orders_observer_rw" : "coffee_orders_convergence_rw";
  return withCatalogPostgres(async ({ adminClient, port }) => {
    const passwords = new Map();
    for (const role of ["coffee_orders_migrator", ...ROLES]) {
      const password = randomBytes(24).toString("hex");
      passwords.set(role, password);
      await adminClient.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`,
      );
    }
    await adminClient.query(
      "CREATE DATABASE coffee_platform_orders OWNER coffee_orders_migrator",
    );
    await adminClient.query(
      "REVOKE ALL ON DATABASE coffee_platform_orders FROM PUBLIC",
    );
    await adminClient.query(
      `GRANT CONNECT ON DATABASE coffee_platform_orders TO ${ROLES.join(",")}`,
    );
    const connect = async (user) => {
      const client = new Client({
        host: "127.0.0.1",
        port,
        database: "coffee_platform_orders",
        user,
        password: passwords.get(user),
        connectionTimeoutMillis: 2_000,
        ssl: false,
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        await client.end();
        throw error;
      }
    };
    const migrator = await connect("coffee_orders_migrator");
    const observer = await connect(role);
    const databaseAt = (targetPort) =>
      createDatabase({
        owner,
        database: "coffee_platform_orders",
        allowedDatabase: "coffee_platform_orders",
        host: "127.0.0.1",
        port: targetPort,
        user: role,
        password: passwords.get(role),
        ssl: false,
        pool: POOL,
        shutdownGraceMs: 40_000,
      });
    const runtime = databaseAt(port);
    try {
      await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      for (const id of MIGRATIONS)
        await migrator.query(
          await readFile(
            new URL(
              `../../apps/orders-service/migrations/${id}.sql`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      assert.deepEqual(
        (
          await observer.query(
            "SELECT current_user AS name,rolsuper FROM pg_roles WHERE rolname=current_user",
          )
        ).rows[0],
        { name: role, rolsuper: false },
      );
      await runtime.resource.start(signal());
      return await run({ runtime, observer, migrator, databaseAt, port });
    } finally {
      await runtime.resource.stop(AbortSignal.timeout(5_000));
      await observer.end();
      await migrator.end();
    }
  });
}

for (const owner of ["aroma-observer", "aroma-convergence"]) void test(
  `${owner} readiness remains available during a held business request`,
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "coffee-observer-wiring-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const caKey = join(directory, "ca.key"),
      caCert = join(directory, "ca.crt");
    const openssl = (...args) =>
      execFileSync("openssl", args, { stdio: "ignore", timeout: 10_000 });
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-subj",
      "/CN=observer-wiring-ca",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    );
    const caPem = await readFile(caCert, "utf8");
    const material = async (runtime) => {
      const key = join(directory, `${runtime}.key`),
        csr = join(directory, `${runtime}.csr`),
        cert = join(directory, `${runtime}.crt`);
      openssl(
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        csr,
        "-subj",
        `/CN=${runtime}`,
        "-addext",
        `subjectAltName=DNS:${runtime},URI:spiffe://coffee-platform/development/${runtime}`,
        "-addext",
        "extendedKeyUsage=serverAuth,clientAuth",
      );
      openssl(
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-out",
        cert,
        "-days",
        "1",
        "-sha256",
        "-copy_extensions",
        "copyall",
      );
      return parseServiceTransportMaterial(
        JSON.stringify({
          keyPem: await readFile(key, "utf8"),
          certPem: await readFile(cert, "utf8"),
          caPem,
        }),
        "development",
        runtime,
      );
    };
    const runtimeTls = await material(owner),
      internalTls = await material("api-internal");
    const businessArrived = Promise.withResolvers(),
      businessClosed = Promise.withResolvers();
    const readinessClosed = Promise.withResolvers();
    let readinessRequests = 0,
      holdReadiness = false,
      businessOpen = false;
    const server = createHttpsServer(
      {
        key: internalTls.keyPem,
        cert: internalTls.certPem,
        ca: caPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      },
      (request, response) => {
        verifyTransportPeer(
          request.socket.getPeerCertificate(),
          "development",
          owner,
        );
        if (request.url === "/api/internal-v1/aroma/cart-snapshots:read") {
          assert.equal(request.method, "POST");
          businessOpen = true;
          response.once("close", () => { businessOpen = false; businessClosed.resolve(); });
          businessArrived.resolve();
          return;
        }
        assert.equal(request.method, "GET");
        assert.equal(request.url, "/health/ready");
        readinessRequests++;
        if (holdReadiness) {
          response.once("close", () => readinessClosed.resolve());
          return;
        }
        response.writeHead(200).end("ready");
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      if (server.listening)
        await new Promise((resolve) => server.close(resolve));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const originalLookup = dns.lookup.bind(dns);
    t.mock.method(dns, "lookup", (hostname, options, callback) => {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (hostname !== "api-internal")
        return originalLookup(hostname, options, callback);
      return options?.all
        ? callback(null, [{ address: "127.0.0.1", family: 4 }])
        : callback(null, "127.0.0.1", 4);
    });
    const config = structuredClone(
      await loadPlatformConfig(
        new URL("../../config/platform.yaml", import.meta.url).pathname,
        parseYaml,
      ),
    );
    config.services[owner].outbound = [
      `api-internal:${address.port}`,
    ];
    const receipt = await withObserverDomain(async ({ runtime, migrator }) => {
      if (owner === "aroma-convergence") {
        await migrator.query("BEGIN");
        await migrator.query("INSERT INTO orders.cart_desired_revisions VALUES($1,1,'Current',$2,0,transaction_timestamp())", ["aroma-primary", fingerprint]);
        await migrator.query("INSERT INTO orders.cart_desired_lines VALUES($1,1,$2,NULL,1000,$3,'[]'::jsonb)", ["aroma-primary", "off_00000000000000000000000001", fingerprint]);
        await migrator.query("INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,reason,next_attempt_at) VALUES($1,1,'Recovery',transaction_timestamp())", ["aroma-primary"]);
        await migrator.query("COMMIT");
      }
      const composition = owner === "aroma-observer" ? createAromaObserverComposition() : createAromaConvergenceComposition();
      const kafka = { bind: () => {}, relay: async () => {} };
      const app = await createRuntime({
        name: owner,
        host: "127.0.0.1",
        port: 0,
        shutdownGraceMs: 5000,
        health: config.services[owner].health,
        readinessChecks: composition.readinessChecks,
        resources: composition.resources,
        configure: (app, signal) =>
          composition.configure(app, signal, runtime, kafka, {
            config,
            secrets: {
              security: {
                serviceTransportKeys: {
                  [owner]: JSON.stringify({
                    keyPem: runtimeTls.keyPem,
                    certPem: runtimeTls.certPem,
                    caPem: runtimeTls.caPem,
                  }),
                },
              },
            },
          }),
      });
      try {
        await app.runtimeController.start();
        await Promise.race([
          businessArrived.promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("business request not received")),
              10_000,
            ).unref(),
          ),
        ]);
        assert.equal(businessOpen, true);
        if (owner === "aroma-convergence") {
          const attempts = await migrator.query("SELECT state, desired_revision::text AS revision FROM orders.convergence_attempts");
          assert.deepEqual(attempts.rows, [{ state: "Started", revision: "1" }]);
        }
        const ready = await app.inject("/health/ready");
        assert.equal(businessOpen, true);
        assert.equal(ready.statusCode, 200);
        assert.equal(readinessRequests, 1);
        holdReadiness = true;
        assert.equal((await app.inject("/health/ready")).statusCode, 503);
        await Promise.race([
          readinessClosed.promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("readiness request not canceled")),
              5000,
            ).unref(),
          ),
        ]);
        holdReadiness = false;
        assert.equal((await app.inject("/health/ready")).statusCode, 200);
        assert.equal(readinessRequests, 3);
        assert.equal(businessOpen, true);
      } finally {
        assert.deepEqual(await app.runtimeController.closeRuntime("SIGTERM"), {
          status: "stopped",
          pending: [],
        });
      }
      await Promise.race([
        businessClosed.promise,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("business request not canceled")),
            5000,
          ).unref(),
        ),
      ]);
      return {};
    }, owner);
    assert.equal(receipt.cleanup.containerRemoved, true);
  },
);

void test(
  "observer durable safe-only store behavioral proofs under real PostgreSQL role",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async (t) => {
    const receipt = await withObserverDomain(
      async ({ runtime, observer, migrator, databaseAt, port }) => {
        const { createAromaObservationStore } =
          await import("../../apps/aroma-observer/dist/infrastructure/observation-store.js");
        const owner = () => randomUUID();
        const makeStore = (options = {}, database = runtime) =>
          createAromaObservationStore(database, {
            ...OPTIONS,
            ownerInstanceId: owner(),
            ...options,
          });
        const offer = "off_00000000000000000000000001";
        const grindA = "a".repeat(64),
          grindB = "b".repeat(64);
        const lines = [
          { offerRef: offer, quantity: "1" },
          { offerRef: offer, quantity: "2", sourceGrindKeyHash: grindA },
          { offerRef: offer, quantity: "3", sourceGrindKeyHash: grindB },
        ];
        const fractionalLines = [
          { offerRef: offer, quantity: "1.001" },
          { offerRef: offer, quantity: "2", sourceGrindKeyHash: grindA },
          { offerRef: offer, quantity: "3.125", sourceGrindKeyHash: grindB },
        ];
        const hash = (value) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const snapshot = async (wireLines = lines, offsetMs = 0) => ({
          cartScopeRef: "aroma-primary",
          providerSnapshotRef: `aroma-gateway:cart-body-sha256:${fingerprint}`,
          capturedAt: (
            await observer.query(
              "SELECT clock_timestamp()+$1*interval '1 millisecond' AS now",
              [offsetMs],
            )
          ).rows[0].now.toISOString(),
          cartFingerprint: hash(wireLines),
          lines: wireLines,
        });
        let unsafeCalls = 0;
        let safeCalls = 0;
        const gateway = (read) => ({
          read: async (context) => {
            safeCalls++;
            assert.ok(context.signal instanceof AbortSignal);
            assert.match(context.correlationId, /^[0-9a-f-]{36}$/u);
            assert.match(
              context.traceparent,
              /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/u,
            );
            return read(context);
          },
          setQuantity: () => {
            unsafeCalls++;
            throw new Error("unsafe observer setQuantity");
          },
          remove: () => {
            unsafeCalls++;
            throw new Error("unsafe observer remove");
          },
        });
        const reset = async () => {
          await migrator.query(
            "TRUNCATE orders.outbox_messages,orders.cart_observed_revisions,orders.observation_schedule CASCADE",
          );
        };
        const due = async () => {
          const result =
            await observer.query(`UPDATE orders.observation_schedule SET next_observation_at=clock_timestamp()-interval '1 millisecond'
        WHERE cart_scope_ref='aroma-primary' AND lease_owner IS NULL`);
          assert.equal(result.rowCount, 1);
        };
        const expire = async (expectedOwner) => {
          const result = await observer.query(
            `UPDATE orders.observation_schedule SET lease_until=clock_timestamp()-interval '1 millisecond'
        WHERE cart_scope_ref='aroma-primary' AND lease_owner=$1 AND lease_until>clock_timestamp() RETURNING lease_owner`,
            [expectedOwner],
          );
          assert.equal(result.rowCount, 1);
        };
        const state = async () => ({
          revisions: (
            await observer.query(
              "SELECT * FROM orders.cart_observed_revisions ORDER BY observed_revision",
            )
          ).rows,
          lines: (
            await observer.query(
              "SELECT * FROM orders.cart_observed_lines ORDER BY observed_revision,offer_ref,source_grind_key_hash NULLS FIRST",
            )
          ).rows,
          outbox: (
            await observer.query(
              "SELECT * FROM orders.outbox_messages ORDER BY aggregate_sequence",
            )
          ).rows,
          schedule: (
            await observer.query(
              "SELECT *,next_observation_at>clock_timestamp() AS delayed FROM orders.observation_schedule",
            )
          ).rows[0],
        });
        const assertRescheduled = (facts) => {
          assert.equal(facts.schedule.lease_owner, null);
          assert.equal(facts.schedule.lease_until, null);
          assert.equal(facts.schedule.delayed, true);
        };
        const started = async (options) => {
          const store = makeStore(options);
          await store.recover(signal());
          return store;
        };

        await t.test(
          "durable startup schedule works with empty Desired; restart preserves live lease and backoff",
          async () => {
            await reset();
            const store = await started();
            assert.equal(
              (
                await observer.query(
                  "SELECT count(*)::int AS count FROM orders.cart_desired_revisions",
                )
              ).rows[0].count,
              0,
            );
            assert.equal((await state()).schedule.lease_owner, null);
            await store.recover(signal());
            assert.equal(
              (
                await observer.query(
                  "SELECT count(*)::int AS count FROM orders.observation_schedule",
                )
              ).rows[0].count,
              1,
            );
            assert.equal(
              await store.runOnce(
                gateway(() => snapshot([])),
                signal(),
              ),
              "observed",
            );
            assertRescheduled(await state());
            const before = (await state()).schedule;
            const restarted = makeStore();
            await restarted.recover(signal());
            assert.deepEqual((await state()).schedule, before);
            const calls = safeCalls;
            assert.equal(
              await restarted.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "idle",
            );
            assert.equal(safeCalls, calls);
            await observer.query(
              "UPDATE orders.observation_schedule SET lease_owner=$1,lease_until=clock_timestamp()+interval '1 hour'",
              [owner()],
            );
            const held = (await state()).schedule;
            await makeStore().recover(signal());
            assert.deepEqual((await state()).schedule, held);
          },
        );

        await t.test(
          "one full read commits exact nullable-grind lines, Current, Outbox bytes and next schedule atomically",
          async () => {
            await reset();
            const store = await started();
            const value = await snapshot();
            const expected = normalizeAromaCartSnapshot(value);
            const calls = safeCalls;
            assert.equal(
              await store.runOnce(
                gateway(async () => value),
                signal(),
              ),
              "observed",
            );
            assert.equal(safeCalls, calls + 1);
            const facts = await state();
            assert.equal(facts.revisions.length, 1);
            assert.equal(facts.revisions[0].state, "Current");
            assert.equal(facts.revisions[0].source_kind, "Observer");
            assert.equal(facts.revisions[0].observed_revision, "1");
            assert.deepEqual(
              facts.lines.map((row) => ({
                offerRef: row.offer_ref,
                sourceGrindKeyHash: row.source_grind_key_hash,
                quantityMilli: row.quantity_milli,
                sanitizedLineHash: row.sanitized_line_hash,
              })),
              expected.lines.map((line) => ({
                ...line,
                sourceGrindKeyHash: line.sourceGrindKeyHash ?? null,
              })),
            );
            assert.equal(facts.outbox.length, 1);
            const event = facts.outbox[0];
            assert.equal(event.topic, "coffee.aroma.cart.events.v1");
            assert.equal(event.message_type, "AromaObservationChanged.v1");
            assert.equal(event.aggregate_ref, "aroma-primary");
            assert.equal(event.order_ref, null);
            assert.equal(event.aggregate_sequence, "1");
            assert.equal(event.owner_version, "1");
            assert.equal(isAromaOwnerMessage(event.envelope), true);
            assert.deepEqual(event.envelope.payload, {
              cartScopeRef: "aroma-primary",
              observedRevision: "1",
              observedAt: value.capturedAt,
              observationState: "Complete",
              cartFingerprint: value.cartFingerprint,
            });
            assert.deepEqual(
              JSON.parse(event.envelope_bytes.toString("utf8")),
              event.envelope,
            );
            assert.equal(
              event.envelope_hash,
              canonicalRequestHash(event.envelope),
            );
            assert.equal(event.payload_hash, event.envelope_hash);
            assertRescheduled(facts);
          },
        );

        await t.test(
          "network callback obtains the same advisory lock on another connection: no TX or checkout during read",
          async () => {
            await reset();
            const store = await started();
            assert.equal(
              await store.runOnce(
                gateway(async () => {
                  assert.equal(runtime.metrics().active, 0);
                  await observer.query("BEGIN");
                  try {
                    assert.equal(
                      (
                        await observer.query(
                          "SELECT pg_try_advisory_xact_lock(hashtext('orders:aroma-primary')) AS free",
                        )
                      ).rows[0].free,
                      true,
                    );
                  } finally {
                    await observer.query("ROLLBACK");
                  }
                  return snapshot();
                }),
                signal(),
              ),
              "observed",
            );
          },
        );

        const invalidCases = [
          [
            "failed GET",
            async () => {
              throw new Error("provider-url cookie=ephemeral-no-log");
            },
          ],
          [
            "partial GET",
            async () => ({ ...(await snapshot()), complete: false }),
          ],
          [
            "invalid DTO",
            async () => ({
              ...(await snapshot()),
              providerSnapshotRef: "raw-provider-id",
            }),
          ],
          [
            "fingerprint mismatch",
            async () => ({
              ...(await snapshot()),
              cartFingerprint: "f".repeat(64),
            }),
          ],
          ["duplicate physical key", () => snapshot([lines[0], lines[0]])],
          [
            "null is not the first grind",
            () => snapshot([{ ...lines[0], sourceGrindKeyHash: null }]),
          ],
          [
            "out of int64 quantity",
            () => snapshot([{ offerRef: offer, quantity: "9223372036854776" }]),
          ],
          [
            "older than PG freshness bound",
            () => snapshot(lines, -OPTIONS.maxSnapshotAgeMs - 1000),
          ],
          ["future PG timestamp", () => snapshot(lines, 60_000)],
        ];
        for (const [label, read] of invalidCases)
          await t.test(
            `${String(label)} preserves last Current and retries durably`,
            async () => {
              await reset();
              const store = await started();
              assert.equal(
                await store.runOnce(
                  gateway(() => snapshot()),
                  signal(),
                ),
                "observed",
              );
              const previous = await state();
              await due();
              const calls = safeCalls;
              assert.equal(
                await store.runOnce(gateway(read), signal()),
                "failed",
              );
              assert.equal(safeCalls, calls + 1);
              const after = await state();
              assert.deepEqual(after.revisions, previous.revisions);
              assert.deepEqual(after.lines, previous.lines);
              assert.deepEqual(after.outbox, previous.outbox);
              assertRescheduled(after);
            },
          );

        await t.test(
          "maxLines accepts exact configured bound; rejects bound+1 before any new physical fact",
          async () => {
            await reset();
            const store = await started();
            const boundedLines = Array.from(
              { length: OPTIONS.maxLines },
              (_, index) => ({
                offerRef: `off_${String(index + 1).padStart(26, "0")}`,
                quantity: "1",
              }),
            );
            assert.equal(
              await store.runOnce(
                gateway(() => snapshot(boundedLines)),
                signal(),
              ),
              "observed",
            );
            const before = await state();
            assert.equal(before.lines.length, OPTIONS.maxLines);
            await due();
            assert.equal(
              await store.runOnce(
                gateway(() =>
                  snapshot([
                    ...boundedLines,
                    {
                      offerRef: "off_00000000000000000000010001",
                      quantity: "1",
                    },
                  ]),
                ),
                signal(),
              ),
              "failed",
            );
            const after = await state();
            assert.deepEqual(after.revisions, before.revisions);
            assert.deepEqual(after.outbox, before.outbox);
            assertRescheduled(after);
          },
        );

        await t.test(
          "persisted bigint maximum determines next revision and cart Outbox sequence across restarted stores",
          async () => {
            await reset();
            const left = await started();
            assert.equal(
              await left.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "observed",
            );
            await observer.query(
              `INSERT INTO orders.cart_observed_revisions
        (cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind)
        VALUES ('aroma-primary',9007199254740993,'Superseded',$1,$2,clock_timestamp(),'Observer')`,
              [`aroma-gateway:cart-body-sha256:${fingerprint}`, hash([])],
            );
            await due();
            const right = makeStore();
            await right.recover(signal());
            assert.equal(
              await right.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "observed",
            );
            await due();
            assert.equal(
              await left.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "observed",
            );
            const facts = await state();
            assert.deepEqual(
              facts.revisions.map((row) => row.observed_revision),
              ["1", "9007199254740993", "9007199254740994", "9007199254740995"],
            );
            assert.equal(facts.revisions.at(-1).state, "Current");
            assert.deepEqual(
              facts.outbox.map((row) => row.aggregate_sequence),
              ["1", "2", "3"],
            );
            assert.deepEqual(
              facts.outbox.map((row) => row.owner_version),
              ["1", "9007199254740994", "9007199254740995"],
            );
          },
        );

        await t.test(
          "two replicas never duplicate a live read; lease takeover rejects stale completion and preserves new Current",
          async () => {
            await reset();
            const instance = owner();
            const left = await started({ ownerInstanceId: instance });
            const right = makeStore();
            const entered = Promise.withResolvers(),
              release = Promise.withResolvers();
            const leftRun = left.runOnce(
              gateway(async () => {
                const old = await snapshot();
                entered.resolve();
                await release.promise;
                return old;
              }),
              signal(),
            );
            try {
              await entered.promise;
              assert.equal(
                await right.runOnce(
                  gateway(() => snapshot()),
                  signal(),
                ),
                "idle",
              );
              assert.equal(
                await left.runOnce(
                  gateway(() => snapshot()),
                  signal(),
                ),
                "idle",
              );
              await expire(instance);
              assert.equal(
                await right.runOnce(
                  gateway(() => snapshot([])),
                  signal(),
                ),
                "observed",
              );
              const newest = await state();
              release.resolve();
              assert.equal(await leftRun, "idle");
              assert.deepEqual(await state(), newest);
              assert.equal(newest.revisions.length, 1);
              assert.equal(newest.lines.length, 0);
              assert.equal(newest.outbox.length, 1);
            } finally {
              release.resolve();
              await leftRun;
            }
          },
        );

        await t.test(
          "same owner identity on two stores cannot pass an old per-claim timestamp fence",
          async () => {
            await reset();
            const instance = owner();
            const left = await started({ ownerInstanceId: instance });
            const right = makeStore({ ownerInstanceId: instance });
            const entered = Promise.withResolvers(),
              release = Promise.withResolvers();
            const running = left.runOnce(
              gateway(async () => {
                const old = await snapshot();
                entered.resolve();
                await release.promise;
                return old;
              }),
              signal(),
            );
            try {
              await entered.promise;
              await expire(instance);
              assert.equal(
                await right.runOnce(
                  gateway(() => snapshot([])),
                  signal(),
                ),
                "observed",
              );
              const newest = await state();
              release.resolve();
              assert.equal(await running, "idle");
              assert.deepEqual(await state(), newest);
            } finally {
              release.resolve();
              await running;
            }
          },
        );

        await t.test(
          "older snapshot cannot supersede a newer Current written while the safe read was in flight",
          async () => {
            await reset();
            const store = await started();
            const value = await snapshot(lines, -1000);
            assert.equal(
              await store.runOnce(
                gateway(async () => {
                  await observer.query(
                    `INSERT INTO orders.cart_observed_revisions
          (cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind)
          VALUES ('aroma-primary',40,'Current',$1,$2,clock_timestamp(),'Observer')`,
                    [`aroma-gateway:cart-body-sha256:${fingerprint}`, hash([])],
                  );
                  return value;
                }),
                signal(),
              ),
              "failed",
            );
            const facts = await state();
            assert.equal(facts.revisions.length, 1);
            assert.equal(facts.revisions[0].observed_revision, "40");
            assert.equal(facts.outbox.length, 0);
            assertRescheduled(facts);
          },
        );

        await t.test(
          "Outbox write failure rolls back supersede/Observed/lines/schedule and escapes as DB error",
          async () => {
            await reset();
            const store = await started();
            assert.equal(
              await store.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "observed",
            );
            await due();
            const before = await state();
            // Disposable fault injection only; production grants/migrations unchanged.
            await migrator.query(
              "REVOKE INSERT ON orders.outbox_messages FROM coffee_orders_observer_rw",
            );
            try {
              await assert.rejects(
                store.runOnce(
                  gateway(() => snapshot([])),
                  signal(),
                ),
                { code: "DB_QUERY_FAILED" },
              );
            } finally {
              await migrator.query(
                "GRANT INSERT ON orders.outbox_messages TO coffee_orders_observer_rw",
              );
            }
            const after = await state();
            assert.deepEqual(after.revisions, before.revisions);
            assert.deepEqual(after.lines, before.lines);
            assert.deepEqual(after.outbox, before.outbox);
            assert.notEqual(after.schedule.lease_owner, null);
            const restarted = makeStore();
            await restarted.recover(signal());
            assert.equal(
              await restarted.runOnce(
                gateway(() => snapshot()),
                signal(),
              ),
              "idle",
            );
            await expire(after.schedule.lease_owner);
            assert.equal(
              await restarted.runOnce(
                gateway(() => snapshot([])),
                signal(),
              ),
              "observed",
            );
            assert.equal(
              (await state()).revisions.at(-1).observed_revision,
              "2",
            );
          },
        );

        await t.test(
          "expired final permit before dispatch results in zero safe reads",
          async () => {
            await reset();
            const instance = owner();
            await started();
            const proxy = await openBlackholeProxy(port, "COMMIT", {
              dropReplyAt: 1000,
              blockExtendedQuery:
                "SELECT EXISTS(SELECT 1 FROM orders.observation_schedule",
            });
            const database = databaseAt(proxy.port);
            let running;
            let blocked = false;
            try {
              await database.resource.start(signal());
              const store = makeStore({ ownerInstanceId: instance }, database);
              const calls = safeCalls;
              running = store.runOnce(
                gateway(() => snapshot()),
                signal(),
              );
              await proxy.waitForQueryBlocked(5000);
              blocked = true;
              await expire(instance);
              proxy.releaseBlockedQuery();
              blocked = false;
              assert.equal(await running, "idle");
              assert.equal(safeCalls, calls);
              assert.equal((await state()).revisions.length, 0);
            } finally {
              if (blocked) proxy.releaseBlockedQuery();
              await Promise.allSettled([running]);
              try {
                await database.resource.stop(signal());
              } finally {
                await proxy.close();
              }
            }
          },
        );

        await t.test(
          "expiry inside completion rolls back all facts including staged Outbox and next schedule",
          async () => {
            await reset();
            const instance = owner();
            await started();
            const proxy = await openBlackholeProxy(port, "COMMIT", {
              dropReplyAt: 1000,
              blockExtendedQuery: "UPDATE orders.observation_schedule SET",
            });
            const database = databaseAt(proxy.port);
            let running;
            let blocked = false;
            try {
              await database.resource.start(signal());
              const store = makeStore({ ownerInstanceId: instance }, database);
              running = store.runOnce(
                gateway(() => snapshot()),
                signal(),
              );
              await proxy.waitForQueryBlocked(5000);
              blocked = true;
              await expire(instance);
              proxy.releaseBlockedQuery();
              blocked = false;
              assert.equal(await running, "idle");
              const facts = await state();
              assert.equal(facts.revisions.length, 0);
              assert.equal(facts.lines.length, 0);
              assert.equal(facts.outbox.length, 0);
              assert.equal(facts.schedule.lease_owner, instance);
            } finally {
              if (blocked) proxy.releaseBlockedQuery();
              await Promise.allSettled([running]);
              try {
                await database.resource.stop(signal());
              } finally {
                await proxy.close();
              }
            }
          },
        );

        await t.test(
          "real lost PostgreSQL completion COMMIT response is unknown, not failed GET; restart reads committed facts",
          async () => {
            await reset();
            await started();
            // runOnce commits claim, final permit, then completion: drop only reply #3.
            const proxy = await openBlackholeProxy(port, "COMMIT", {
              dropOnce: true,
              dropReplyAt: 3,
            });
            const database = databaseAt(proxy.port);
            try {
              await database.resource.start(signal());
              const store = makeStore({}, database);
              await assert.rejects(
                store.runOnce(
                  gateway(() => snapshot()),
                  signal(),
                ),
                { code: "TRANSACTION_OUTCOME_UNKNOWN" },
              );
              assert.equal(
                (await proxy.waitForReplyDropped(5000)).command,
                "COMMIT",
              );
              const facts = await state();
              assert.equal(facts.revisions.length, 1);
              assert.equal(facts.lines.length, 3);
              assert.equal(facts.outbox.length, 1);
              assertRescheduled(facts);
              const restarted = makeStore();
              await restarted.recover(signal());
              const calls = safeCalls;
              assert.equal(
                await restarted.runOnce(
                  gateway(() => snapshot()),
                  signal(),
                ),
                "idle",
              );
              assert.equal(safeCalls, calls);
              await due();
              assert.equal(
                await restarted.runOnce(
                  gateway(() => snapshot([])),
                  signal(),
                ),
                "observed",
              );
              assert.deepEqual(
                (await state()).revisions.map((row) => row.observed_revision),
                ["1", "2"],
              );
            } finally {
              await database.resource.stop(signal());
              await proxy.close();
            }
          },
        );

        await t.test(
          "aborted input is zero provider reads and no observation",
          async () => {
            await reset();
            const store = await started();
            const calls = safeCalls;
            const aborted = new AbortController();
            aborted.abort();
            await assert.rejects(
              store.runOnce(
                gateway(() => snapshot()),
                aborted.signal,
              ),
              { code: "DB_INTERRUPTED" },
            );
            assert.equal(safeCalls, calls);
            assert.equal((await state()).revisions.length, 0);
          },
        );
        await t.test(
          "contract-valid exact decimal quantities persist without precision loss (shared normalization regression)",
          async () => {
            await reset();
            const store = await started();
            const value = await snapshot(fractionalLines);
            assert.equal(
              isAromaCartSnapshot(value),
              true,
              "wire DTO is contract-valid, not malformed",
            );
            assert.equal(
              await store.runOnce(
                gateway(async () => value),
                signal(),
              ),
              "observed",
            );
            assert.deepEqual(
              (await state()).lines.map((row) => row.quantity_milli),
              ["1001", "2000", "3125"],
            );
          },
        );
        await t.test(
          "observer never calls unsafe Gateway methods across all behavioral slices",
          () => {
            assert.equal(unsafeCalls, 0);
          },
        );
        return { runtimeRole: "coffee_orders_observer_rw" };
      },
    );
    assert.equal(receipt.cleanup.containerRemoved, true);
    t.diagnostic(
      `domain cleanup containerRemoved=${receipt.cleanup.containerRemoved}; runtimeRole=${receipt.runtimeRole}`,
    );
  },
);
