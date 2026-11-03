import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import {
  createDatabase,
  withTransaction,
} from "../../packages/platform-database/dist/index.js";
import {
  applyMigrations,
  migrationChecksum,
} from "../../packages/platform-migrations/dist/index.js";
import { createSqlOutboxStore } from "../../packages/platform-outbox/dist/index.js";

const execFileAsync = promisify(execFile);
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, "apps/catalog-service/migrations");
const MIGRATION_IDS = [
  "0001_supplier_snapshots",
  "0002_snapshot_batches",
  "0003_snapshot_staging",
  "0004_catalog_active",
  "0005_catalog_identity",
  "0006_catalog_outbox",
  "0007_catalog_grants",
  "0008_catalog_active_read",
  "0009_active_snapshot_freshness",
  "0010_catalog_category",
  "0011_active_catalog_category",
];
const pool = {
  max: 4,
  checkoutTimeoutMs: 1_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 5_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};

async function loadMigrations() {
  const names = (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.deepEqual(
    names,
    MIGRATION_IDS.map((id) => `${id}.sql`),
    "Catalog migration sequence must match its ordered migration ledger",
  );
  return Promise.all(
    MIGRATION_IDS.map(async (id) => {
      const sql = await readFile(join(MIGRATIONS_DIR, `${id}.sql`), "utf8");
      return { id, sql, checksum: migrationChecksum(sql) };
    }),
  );
}

const expectedGrantRows = (role) =>
  Object.entries(role.tables)
    .flatMap(([table, privileges]) =>
      privileges
        .filter(
          (privilege) =>
            !(
              privilege === "UPDATE" &&
              role.role === "coffee_catalog_activate_rw" &&
              ["source_identities", "supplier_snapshots"].includes(table)
            ),
        )
        .map((privilege) => `${table}:${privilege}`),
    )
    .sort((left, right) => left.localeCompare(right));

function roleUrl(database, user, password, port) {
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = user;
  url.password = password;
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

async function waitForPostgres(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const client = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "postgres",
      connectionTimeoutMillis: 500,
    });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }
  throw new Error(
    `disposable PostgreSQL did not become ready: ${lastError?.message ?? "timeout"}`,
  );
}

async function expectPermissionDenied(client, sql, label) {
  await assert.rejects(client.query(sql), (error) => {
    assert.equal(error.code, "42501", `${label} must be denied by PostgreSQL`);
    return true;
  });
}

void test("Catalog activation migrations match role-map least privilege and preserve importer scope", async () => {
  const roleMap = JSON.parse(
    await readFile(join(ROOT, "config/database-role-map.json"), "utf8"),
  );
  const catalog = roleMap.databases.find(
    (database) => database.name === "coffee_platform_catalog",
  );
  assert.ok(catalog, "Catalog database must exist in the role map");
  const roles = Object.fromEntries(
    catalog.runtimeRoles.map((role) => [role.role, role]),
  );
  assert.deepEqual(roles.coffee_catalog_api_ro.tables, {
    active_products: ["SELECT"],
    active_variants: ["SELECT"],
    active_offer_mappings: ["SELECT"],
    active_availability: ["SELECT"],
    active_snapshot_metadata: ["SELECT"],
  });
  assert.deepEqual(roles.coffee_catalog_import_rw.tables, {
    supplier_snapshots: ["SELECT", "INSERT", "UPDATE"],
    snapshot_batches: ["SELECT", "INSERT"],
    snapshot_products: ["SELECT", "INSERT"],
    snapshot_variants: ["SELECT", "INSERT"],
    snapshot_offers: ["SELECT", "INSERT"],
    snapshot_availability: ["SELECT", "INSERT"],
  });
  assert.deepEqual(roles.coffee_catalog_activate_rw.tables, {
    supplier_snapshots: ["SELECT", "UPDATE"],
    snapshot_batches: ["SELECT"],
    snapshot_products: ["SELECT"],
    snapshot_variants: ["SELECT"],
    snapshot_offers: ["SELECT"],
    snapshot_availability: ["SELECT"],
    source_identities: ["SELECT", "INSERT", "UPDATE"],
    catalog_state: ["SELECT", "INSERT", "UPDATE"],
    products: ["SELECT", "INSERT"],
    variants: ["SELECT", "INSERT"],
    offer_mappings: ["SELECT", "INSERT"],
    availability: ["SELECT", "INSERT"],
    outbox_messages: ["SELECT", "INSERT", "UPDATE"],
    offer_binding_acks: ["SELECT", "INSERT", "UPDATE"],
  });
  const migrations = await loadMigrations();
  assert.equal(
    migrations.every(
      (migration) => migration.checksum === migrationChecksum(migration.sql),
    ),
    true,
  );
  assert.equal(
    migrations.find((migration) => migration.id === "0004_catalog_active")
      ?.checksum,
    "8a0a460dbe540e26ab4f5946245069616c441f38c8b9dd8f3e1f274a31d7381a",
    "published 0004 must remain checksum-compatible with existing migration ledgers",
  );
});

void test("binding acknowledgement reread selects one row by composite key", async () => {
  const source = await readFile(
    join(
      ROOT,
      "apps/catalog-activation-worker/src/infrastructure/activation-store.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /FROM catalog\.offer_binding_acks WHERE snapshot_ref=\$1 AND source_offer_key_hash=\$2/u,
  );
  assert.doesNotMatch(
    source,
    /bound\(tx,\[snapshot\.snapshot_ref\]\)\)\.rows\.find/u,
  );
});

void test(
  "disposable PostgreSQL applies Catalog migrations and proves active schema, SqlOutboxStore, and grants",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "set COFFEE_DB_LIVE_PROOF=1 to run the disposable PostgreSQL proof"
        : false,
  },
  async (t) => {
    const migrations = await loadMigrations();
    const container = `coffee-catalog-activation-${process.pid}-${Date.now()}`;
    const { stdout: started } = await execFileAsync("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "-e",
      "POSTGRES_PASSWORD=activation-migrations-test",
      "-p",
      "127.0.0.1::5432",
      "postgres:17.11",
    ]);
    const containerId = started.trim();
    let port;
    let admin;
    let databases = [];
    t.after(async () => {
      for (const database of databases)
        await database.resource
          .stop(new AbortController().signal)
          .catch(() => {});
      await admin?.end().catch(() => {});
      await execFileAsync("docker", ["rm", "--force", containerId]).catch(
        () => {},
      );
    });

    const { stdout: mappedPort } = await execFileAsync("docker", [
      "port",
      containerId,
      "5432/tcp",
    ]);
    port = Number(mappedPort.trim().split(":").at(-1));
    assert.ok(Number.isInteger(port) && port > 0);
    await waitForPostgres(port);
    admin = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "postgres",
    });
    await admin.connect();
    for (const [role, password] of [
      ["coffee_catalog_migrator", "migrator-pass"],
      ["coffee_catalog_api_ro", "api-pass"],
      ["coffee_catalog_import_rw", "import-pass"],
      ["coffee_catalog_activate_rw", "activate-pass"],
    ]) {
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    }
    await admin.query("CREATE DATABASE coffee_platform_catalog");
    await admin.query("CREATE DATABASE foreign_owner");
    await admin.query("REVOKE CONNECT ON DATABASE foreign_owner FROM PUBLIC");
    await admin.query(
      "GRANT CONNECT ON DATABASE coffee_platform_catalog TO coffee_catalog_migrator, coffee_catalog_api_ro, coffee_catalog_import_rw, coffee_catalog_activate_rw",
    );
    const bootstrapClient = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "coffee_platform_catalog",
    });
    await bootstrapClient.connect();
    await bootstrapClient.query("CREATE SCHEMA catalog");
    await bootstrapClient.end();

    const migrator = createDatabase({
      owner: "activation-test-migrator",
      database: "coffee_platform_catalog",
      allowedDatabase: "coffee_platform_catalog",
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      ssl: false,
      pool,
      shutdownGraceMs: 60_000,
    });
    databases.push(migrator);
    await migrator.resource.start(new AbortController().signal);
    const migrationOptions = {
      schema: "catalog",
      ledgerTable: "platform_schema_migrations",
      lockKey: "catalog-activation-proof",
    };
    assert.deepEqual(
      await applyMigrations(migrator, migrations.slice(0, 1), migrationOptions),
      MIGRATION_IDS.slice(0, 1),
    );
    const baseCatalog = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "coffee_platform_catalog",
    });
    await baseCatalog.connect();
    const baseChecks = await baseCatalog.query(
      "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='catalog.supplier_snapshots'::regclass AND contype='c'",
    );
    const baseByName = Object.fromEntries(
      baseChecks.rows.map((row) => [row.conname, row.definition]),
    );
    assert.match(
      baseByName.supplier_snapshots_provider_snapshot_ref_check,
      /provider_snapshot_ref IS NULL/u,
    );
    assert.match(
      baseByName.supplier_snapshots_check,
      /provider_snapshot_ref IS NOT NULL/u,
    );
    assert.match(
      baseByName.supplier_snapshots_check1,
      /declared_batch_count IS NOT NULL/u,
    );
    assert.match(
      baseByName.supplier_snapshots_check2,
      /failure_code IS NOT NULL/u,
    );
    await baseCatalog.end();
    const migrationRun = await applyMigrations(
      migrator,
      migrations.slice(0, 7),
      migrationOptions,
    );
    assert.deepEqual(migrationRun, MIGRATION_IDS.slice(1, 7));
    const legacyCatalog = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "coffee_platform_catalog",
    });
    await legacyCatalog.connect();
    try {
      await legacyCatalog.query(
        "INSERT INTO catalog.supplier_snapshots(snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at) VALUES ('snp_00000000000000000000000009','sup_00000000000000000000000000','legacy-export','Active',0,1,1,0,repeat('a',64),clock_timestamp())",
      );
      await legacyCatalog.query(
        "INSERT INTO catalog.products(snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('snp_00000000000000000000000009','prd_00000000000000000000000009','Before upgrade','before upgrade')",
      );
      await legacyCatalog.query(
        "INSERT INTO catalog.variants(snapshot_ref,variant_ref,product_ref,unit) VALUES ('snp_00000000000000000000000009','var_00000000000000000000000009','prd_00000000000000000000000009','piece')",
      );
      await legacyCatalog.query(
        "UPDATE catalog.catalog_state SET active_snapshot_ref='snp_00000000000000000000000009',active_snapshot_revision=1,active_content_hash=repeat('a',64) WHERE id=true",
      );
      assert.deepEqual(
        (
          await legacyCatalog.query(
            "SELECT variant_ref FROM catalog.active_variants",
          )
        ).rows,
        [{ variant_ref: "var_00000000000000000000000009" }],
      );
    } finally {
      await legacyCatalog.end();
    }
    assert.deepEqual(
      await applyMigrations(migrator, migrations, migrationOptions),
      MIGRATION_IDS.slice(7),
    );
    assert.deepEqual(
      await applyMigrations(migrator, migrations, migrationOptions),
      [],
    );

    const migrationClient = new Client({
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: "activation-migrations-test",
      database: "coffee_platform_catalog",
    });
    await migrationClient.connect();
    assert.deepEqual(
      (
        await migrationClient.query(
          "SELECT grind_options FROM catalog.variants WHERE variant_ref='var_00000000000000000000000009'",
        )
      ).rows,
      [{ grind_options: null }],
      "forward migration must preserve existing variants as unknown grind options",
    );
    const legacyApi = new Client(
      roleUrl(
        "coffee_platform_catalog",
        "coffee_catalog_api_ro",
        "api-pass",
        port,
      ),
    );
    await legacyApi.connect();
    try {
      assert.deepEqual(
        (
          await legacyApi.query(
            "SELECT snapshot_ref,snapshot_revision FROM catalog.active_snapshot_metadata",
          )
        ).rows,
        [
          {
            snapshot_ref: "snp_00000000000000000000000009",
            snapshot_revision: "1",
          },
        ],
      );
      assert.deepEqual(
        (
          await legacyApi.query(
            "SELECT variant_ref,grind_options FROM catalog.active_variants",
          )
        ).rows,
        [
          {
            variant_ref: "var_00000000000000000000000009",
            grind_options: null,
          },
        ],
        "forward migration must retain the API grant and visibility of the previously active generation",
      );
    } finally {
      await legacyApi.end();
    }
    await migrationClient.query(
      "UPDATE catalog.catalog_state SET active_snapshot_ref=NULL,active_snapshot_revision=NULL,active_content_hash=NULL WHERE id=true",
    );
    await migrationClient.query(
      "DELETE FROM catalog.variants WHERE variant_ref='var_00000000000000000000000009'",
    );
    await migrationClient.query(
      "DELETE FROM catalog.products WHERE product_ref='prd_00000000000000000000000009'",
    );
    await migrationClient.query(
      "DELETE FROM catalog.supplier_snapshots WHERE snapshot_ref='snp_00000000000000000000000009'",
    );
    const checks = await migrationClient.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='catalog' AND table_type='BASE TABLE' AND table_name <> 'platform_schema_migrations' ORDER BY table_name",
    );
    assert.deepEqual(
      checks.rows.map((row) => row.table_name),
      [
        "catalog_state",
        "offer_binding_acks",
        "offer_mappings",
        "outbox_messages",
        "products",
        "snapshot_availability",
        "snapshot_batches",
        "snapshot_offers",
        "snapshot_products",
        "snapshot_variants",
        "source_identities",
        "supplier_snapshots",
        "variants",
        "availability",
      ].sort(),
    );
    const stageConstraint = await migrationClient.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='catalog.supplier_snapshots'::regclass AND contype='c'",
    );
    assert.match(
      stageConstraint.rows.map((row) => row.definition).join("\n"),
      /Active/u,
    );
    assert.match(
      stageConstraint.rows.map((row) => row.definition).join("\n"),
      /Superseded/u,
    );
    const catalogRoleMap = JSON.parse(
      await readFile(join(ROOT, "config/database-role-map.json"), "utf8"),
    ).databases.find((database) => database.name === "coffee_platform_catalog");
    for (const role of catalogRoleMap.runtimeRoles) {
      const actual = await migrationClient.query(
        "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE table_schema='catalog' AND table_name <> 'platform_schema_migrations' AND grantee=$1",
        [role.role],
      );
      assert.deepEqual(
        actual.rows
          .map((row) => `${row.table_name}:${row.privilege_type}`)
          .sort(),
        expectedGrantRows(role),
        `${role.role} actual PostgreSQL grants must exactly match role map`,
      );
    }
    const mutableSnapshotColumns = await migrationClient.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE table_schema='catalog' AND table_name='supplier_snapshots' AND grantee='coffee_catalog_activate_rw' AND privilege_type='UPDATE' ORDER BY column_name",
    );
    assert.deepEqual(
      mutableSnapshotColumns.rows.map((row) => row.column_name),
      [
        "content_hash",
        "declared_batch_count",
        "declared_offer_count",
        "declared_product_count",
        "declared_variant_count",
        "failure_code",
        "received_at",
        "state",
      ],
    );
    const immutableColumns = await migrationClient.query(
      "SELECT column_name FROM information_schema.column_privileges WHERE table_schema='catalog' AND table_name='source_identities' AND grantee='coffee_catalog_activate_rw' AND privilege_type='UPDATE' ORDER BY column_name",
    );
    assert.deepEqual(
      immutableColumns.rows.map((row) => row.column_name),
      ["last_seen_snapshot_ref", "state"],
    );
    const ackColumns = await migrationClient.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='catalog' AND table_name='offer_binding_acks' ORDER BY ordinal_position",
    );
    assert.deepEqual(
      ackColumns.rows.map((row) => row.column_name),
      [
        "snapshot_ref",
        "source_offer_key_hash",
        "offer_ref",
        "state",
        "first_snapshot_ref",
        "acked_at",
      ],
    );

    const activation = createDatabase({
      owner: "activation-test-runtime",
      database: "coffee_platform_catalog",
      allowedDatabase: "coffee_platform_catalog",
      host: "127.0.0.1",
      port,
      user: "coffee_catalog_activate_rw",
      password: "activate-pass",
      ssl: false,
      pool,
      shutdownGraceMs: 60_000,
    });
    databases.push(activation);
    await activation.resource.start(new AbortController().signal);
    const activationClient = new Client(
      roleUrl(
        "coffee_platform_catalog",
        "coffee_catalog_activate_rw",
        "activate-pass",
        port,
      ),
    );
    await activationClient.connect();
    const importer = new Client(
      roleUrl(
        "coffee_platform_catalog",
        "coffee_catalog_import_rw",
        "import-pass",
        port,
      ),
    );
    await importer.connect();
    await importer.query(
      "INSERT INTO catalog.supplier_snapshots (snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at) VALUES ('snp_00000000000000000000000000','sup_00000000000000000000000000','provider-0','Received',0,1,0,0,repeat('a',64),clock_timestamp())",
    );
    await activationClient.query(
      "UPDATE catalog.supplier_snapshots SET state='Active' WHERE snapshot_ref='snp_00000000000000000000000000'",
    );
    assert.equal(
      (
        await activationClient.query(
          "SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref='snp_00000000000000000000000000'",
        )
      ).rows[0].state,
      "Active",
    );
    assert.equal(
      (
        await activationClient.query(
          "SELECT count(*)::integer AS count FROM catalog.catalog_state WHERE id=true",
        )
      ).rows[0].count,
      1,
    );
    await activationClient.query(
      "INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('snp_00000000000000000000000000','prd_00000000000000000000000000','Product','product')",
    );
    await activationClient.query(
      "UPDATE catalog.catalog_state SET active_snapshot_ref='snp_00000000000000000000000000',active_snapshot_revision=1,active_content_hash=repeat('a',64),updated_at=clock_timestamp() WHERE id=true",
    );
    await activationClient.query(
      "INSERT INTO catalog.source_identities (supplier_ref,entity_type,source_identity_scheme,source_identity_hash,stable_ref,semantic_fingerprint,first_seen_snapshot_ref,last_seen_snapshot_ref,state) VALUES ('sup_00000000000000000000000000','product','hmac-sha256-v1',repeat('b',64),'prd_00000000000000000000000000',repeat('c',64),'snp_00000000000000000000000000','snp_00000000000000000000000000','Present')",
    );
    await assert.rejects(
      activationClient.query(
        "UPDATE catalog.source_identities SET semantic_fingerprint=repeat('d',64)",
      ),
      (error) => {
        assert.equal(
          error.code,
          "42501",
          "runtime role cannot update semantic_fingerprint",
        );
        return true;
      },
    );

    const store = createSqlOutboxStore(activation, {
      schema: "catalog",
      table: "outbox_messages",
    });
    const occurredAt = new Date().toISOString();
    const outboxMessage = {
      messageId: "msg_catalog_activation_0001",
      messageType: "CatalogSnapshotActivated.v1",
      topic: "coffee.catalog.snapshot.v1",
      aggregateRef: "catalog",
      aggregateSequence: 1,
      ownerVersion: "1",
      partitionKey: "catalog",
      schemaVersion: "1",
      occurredAt,
      correlationId: "corr_catalog_activation",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      envelope: {
        envelopeVersion: "1",
        messageId: "msg_catalog_activation_0001",
        messageType: "CatalogSnapshotActivated.v1",
        occurredAt,
        producer: "catalog-activation-worker",
        correlationId: "corr_catalog_activation",
        causationId: null,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        aggregate: { type: "Catalog", ref: "catalog", version: "1" },
        payload: {
          snapshotRef: "snp_00000000000000000000000000",
          snapshotRevision: "1",
        },
      },
      payload: {
        snapshotRef: "snp_00000000000000000000000000",
        snapshotRevision: "1",
      },
    };
    assert.equal(
      await withTransaction(activation, { mode: "background" }, (tx) =>
        store.enqueue(tx, outboxMessage),
      ),
      "created",
    );
    const [claim] = await withTransaction(
      activation,
      { mode: "background" },
      (tx) => store.claim(tx, Date.now(), "activation-proof", 1, 30_000),
    );
    assert.equal(claim?.message.messageId, outboxMessage.messageId);
    assert.equal(claim?.state, "Publishing");
    await withTransaction(activation, { mode: "background" }, (tx) =>
      store.finalize(
        tx,
        outboxMessage.messageId,
        "activation-proof",
        claim.leaseToken,
      ),
    );
    assert.equal(
      (
        await activationClient.query(
          "SELECT state FROM catalog.outbox_messages WHERE message_id=$1",
          [outboxMessage.messageId],
        )
      ).rows[0].state,
      "Published",
    );

    await expectPermissionDenied(
      activationClient,
      "SELECT * FROM catalog.platform_schema_migrations",
      "activation migration ledger access",
    );
    const api = new Client(
      roleUrl(
        "coffee_platform_catalog",
        "coffee_catalog_api_ro",
        "api-pass",
        port,
      ),
    );
    await api.connect();
    await expectPermissionDenied(
      api,
      "SELECT * FROM catalog.platform_schema_migrations",
      "API migration ledger access",
    );
    assert.equal(
      (await api.query("SELECT product_ref FROM catalog.active_products"))
        .rows[0].product_ref,
      "prd_00000000000000000000000000",
    );
    await importer.query(
      "INSERT INTO catalog.supplier_snapshots (snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at) VALUES ('snp_00000000000000000000000001','sup_00000000000000000000000000','provider-1','Received',0,1,0,0,repeat('b',64),clock_timestamp())",
    );
    await activationClient.query(
      "UPDATE catalog.supplier_snapshots SET state='Active' WHERE snapshot_ref='snp_00000000000000000000000001'",
    );
    await activationClient.query(
      "INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('snp_00000000000000000000000001','prd_00000000000000000000000001','Next','next')",
    );
    await activationClient.query(
      "UPDATE catalog.catalog_state SET active_snapshot_ref='snp_00000000000000000000000001',active_snapshot_revision=2,active_content_hash=repeat('b',64),updated_at=clock_timestamp() WHERE id=true",
    );
    await activationClient.query(
      "UPDATE catalog.supplier_snapshots SET state='Superseded' WHERE snapshot_ref='snp_00000000000000000000000000'",
    );
    const transitions = await activationClient.query(
      "SELECT snapshot_ref,state,content_hash FROM catalog.supplier_snapshots ORDER BY snapshot_ref",
    );
    assert.deepEqual(
      transitions.rows.map((row) => [row.state, row.content_hash.trim()]),
      [
        ["Superseded", "a".repeat(64)],
        ["Active", "b".repeat(64)],
      ],
    );
    assert.equal(
      (await api.query("SELECT product_ref FROM catalog.active_products"))
        .rows[0].product_ref,
      "prd_00000000000000000000000001",
    );
    await importer.query(
      "INSERT INTO catalog.supplier_snapshots (snapshot_ref,supplier_ref,provider_snapshot_ref,state,declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at) VALUES ('snp_00000000000000000000000002','sup_00000000000000000000000000','provider-2','Received',0,0,0,0,repeat('c',64),clock_timestamp())",
    );
    await activationClient.query(
      "UPDATE catalog.supplier_snapshots SET state='Rejected',failure_code='PROOF_REJECTED',declared_batch_count=NULL,declared_product_count=NULL,declared_variant_count=NULL,declared_offer_count=NULL,content_hash=NULL,received_at=NULL WHERE snapshot_ref='snp_00000000000000000000000002'",
    );
    const rejected = await activationClient.query(
      "SELECT state,failure_code,declared_batch_count,content_hash,received_at FROM catalog.supplier_snapshots WHERE snapshot_ref='snp_00000000000000000000000002'",
    );
    assert.deepEqual(rejected.rows[0], {
      state: "Rejected",
      failure_code: "PROOF_REJECTED",
      declared_batch_count: null,
      content_hash: null,
      received_at: null,
    });
    await expectPermissionDenied(
      activationClient,
      "UPDATE catalog.supplier_snapshots SET received_product_count=9 WHERE snapshot_ref='snp_00000000000000000000000000'",
      "activation manifest mutation",
    );
    await expectPermissionDenied(
      api,
      "SELECT * FROM catalog.products",
      "API generation table access",
    );
    await expectPermissionDenied(
      api,
      "SELECT * FROM catalog.snapshot_products",
      "API staging access",
    );
    await expectPermissionDenied(
      api,
      "SELECT * FROM catalog.source_identities",
      "API identity access",
    );
    await expectPermissionDenied(
      activationClient,
      "INSERT INTO catalog.snapshot_batches (snapshot_ref,batch_number,offer_count,uncompressed_bytes,batch_hash) VALUES ('snp_00000000000000000000000000',0,0,2,repeat('a',64))",
      "activation staging write",
    );

    await importer.query(
      "INSERT INTO catalog.snapshot_products (snapshot_ref,source_product_key_hash) VALUES ('snp_00000000000000000000000000',repeat('e',64))",
    );
    await expectPermissionDenied(
      importer,
      "SELECT * FROM catalog.products",
      "import active read",
    );
    await expectPermissionDenied(
      importer,
      "INSERT INTO catalog.products (snapshot_ref,product_ref,display_name,display_name_sort_key) VALUES ('snp_00000000000000000000000000','prd_00000000000000000000000001','Denied','denied')",
      "import active write",
    );

    const passwords = {
      coffee_catalog_api_ro: "api-pass",
      coffee_catalog_import_rw: "import-pass",
      coffee_catalog_activate_rw: "activate-pass",
    };
    for (const role of catalogRoleMap.runtimeRoles) {
      const foreign = new Client(
        roleUrl("foreign_owner", role.role, passwords[role.role], port),
      );
      let foreignError;
      try {
        await foreign.connect();
      } catch (error) {
        foreignError = error;
      } finally {
        await foreign.end().catch(() => {});
      }
      assert.equal(
        foreignError?.code,
        "42501",
        `${role.role} must be denied CONNECT to foreign owner database`,
      );
    }

    await importer.end();
    await api.end();
    await activationClient.end();
    await migrationClient.end();
  },
);
