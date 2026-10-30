import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { runLiveProof } from "./db-live-proof.mjs";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { createDatabase } from "../packages/platform-database/dist/index.js";
import {
  applyMigrations,
  migrationChecksum,
} from "../packages/platform-migrations/dist/index.js";
import { validateLaunchDatabaseIdentity } from "../packages/platform-config/dist/index.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const image = JSON.parse(readFileSync(resolve(root, "config/toolchain-versions.json"), "utf8")).postgresFixtureImage;
assert.match(image ?? "", /^postgres:17\.11@sha256:[0-9a-f]{64}$/u, "disposable PostgreSQL image must be pinned");
const databaseName = "coffee_platform_catalog";
const password = `catalog-${randomBytes(12).toString("hex")}`;
const pool = Object.freeze({
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
});

async function docker(...args) {
  return exec("docker", args, { timeout: 120_000 });
}
async function waitForPostgres(port, targetDatabase = databaseName) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    const client = new Client({
      host: "127.0.0.1",
      port,
      database: targetDatabase,
      user: "postgres",
      password,
      ssl: false,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      last = error;
      await client.end().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw last ?? new Error("PostgreSQL did not become ready");
}
async function migrations() {
  const names = [
    "0001_supplier_snapshots",
    "0002_snapshot_batches",
    "0003_snapshot_staging",
  ];
  return Promise.all(
    names.map(async (id) => {
      const sql = await readFile(
        resolve(root, `apps/catalog-service/migrations/${id}.sql`),
        "utf8",
      );
      return { id, sql, checksum: migrationChecksum(sql) };
    }),
  );
}

// Use the existing live foundation route, not db:smoke's offline role-case plan.
export async function proveCatalogForeignConnect() {
  const receipt = await runLiveProof({
    bindingProof: async ({ port, rolePasswords, roleMap }) => {
      const denials = [];
      for (const target of roleMap.databases.filter(
        (row) => row.name !== databaseName,
      )) {
        const client = new Client({
          host: "127.0.0.1",
          port,
          database: target.name,
          user: "coffee_catalog_import_rw",
          password: rolePasswords.coffee_catalog_import_rw,
          connectionTimeoutMillis: 2_000,
          ssl: false,
        });
        try {
          await assert.rejects(
            () => client.connect(),
            (error) => {
              assert.equal(error.code, "42501");
              denials.push({ database: target.name, sqlstate: error.code });
              return true;
            },
          );
        } finally {
          await client.end();
        }
      }
      return {
        runtime: "catalog-supplier-sync",
        role: "coffee_catalog_import_rw",
        route: "existing-live-foundation",
        denials,
      };
    },
  });
  assert.equal(receipt.cleanup.containerRemoved, true);
  return { ...receipt.binding, cleanup: receipt.cleanup.containerRemoved };
}

async function proveMigrations(database, adminClient, set) {
  const options = {
    schema: "catalog",
    ledgerTable: "platform_schema_migrations",
    lockKey: "catalog-proof",
  };
  await adminClient.query("CREATE SCHEMA IF NOT EXISTS catalog");
  const first = await applyMigrations(database, set.slice(0, 1), options);
  const states = ["Created", "Received", "Receiving", "Rejected"];
  for (const [index, state] of states.entries()) {
    await adminClient.query(
      `INSERT INTO catalog.supplier_snapshots(snapshot_ref,supplier_ref,state,provider_snapshot_ref,
      declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at,failure_code)
      VALUES($1,$2,$3,$4,$5,$5,$5,$5,$6,$7,$8)`,
      [
        `snp_${String(index + 1).padStart(26, "0")}`,
        "sup_00000000000000000000000001",
        state,
        ["Received", "Receiving"].includes(state) ? "pre-upgrade" : null,
        state === "Received" ? 0 : null,
        state === "Received" ? "0".repeat(64) : null,
        state === "Received" ? "2026-09-20T00:00:00Z" : null,
        state === "Rejected" ? "PROVIDER_UNAVAILABLE" : null,
      ],
    );
  }
  const before = (
    await adminClient.query(
      "SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref",
    )
  ).rows;
  const remaining = await applyMigrations(database, set, options);
  assert.deepEqual(first, ["0001_supplier_snapshots"]);
  assert.deepEqual(remaining, [
    "0002_snapshot_batches",
    "0003_snapshot_staging",
  ]);
  const after = (
    await adminClient.query(
      "SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref",
    )
  ).rows;
  assert.deepEqual(after, before);
  const ledgerBefore = (
    await adminClient.query(
      "SELECT * FROM catalog.platform_schema_migrations ORDER BY id",
    )
  ).rows;
  const secondApply = await applyMigrations(database, set, options);
  assert.deepEqual(secondApply, []);
  const changedSql = `${set[0].sql}\n-- recomputed-checksum drift probe\n`;
  const changed = set.map((row, index) =>
    index === 0
      ? { ...row, sql: changedSql, checksum: migrationChecksum(changedSql) }
      : row,
  );
  let driftCode;
  await assert.rejects(
    () => applyMigrations(database, changed, options),
    (error) => {
      driftCode = error.code;
      return (
        error.code === "MIGRATION_CHECKSUM_DRIFT" &&
        error.migrationId === set[0].id
      );
    },
  );
  assert.deepEqual(
    (
      await adminClient.query(
        "SELECT * FROM catalog.platform_schema_migrations ORDER BY id",
      )
    ).rows,
    ledgerBefore,
  );
  assert.deepEqual(
    (
      await adminClient.query(
        "SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref",
      )
    ).rows,
    before,
  );
  // Sentinels belong only to the migration drill, not startup recovery scenarios.
  await adminClient.query("DELETE FROM catalog.supplier_snapshots");
  return {
    firstApply: [...first, ...remaining],
    secondApply,
    migrationProof: {
      ledger: "catalog.platform_schema_migrations",
      preservedStates: states,
      repeatNoop: true,
      driftCode,
      recomputedChecksum: changed[0].checksum !== set[0].checksum,
      ledgerUnchanged: true,
    },
  };
}

export async function withCatalogPostgres(
  run,
  { skipCatalogInitialization = false, launchIdentity } = {},
) {
  assert.equal(typeof run, "function");
  assert.equal(typeof skipCatalogInitialization, "boolean");
  const validatedLaunchIdentity =
    launchIdentity === undefined
      ? undefined
      : validateLaunchDatabaseIdentity(launchIdentity);
  assert.ok(
    !skipCatalogInitialization || validatedLaunchIdentity,
    "Catalog initialization may only be skipped for a validated launch identity",
  );
  const name = `coffee-catalog-${process.pid}-${randomBytes(4).toString("hex")}`;
  const runLabelKey = "io.coffeeorderplatform.catalog-live-harness.run";
  const runLabel = validatedLaunchIdentity
    ? `${validatedLaunchIdentity.runId}-${randomBytes(8).toString("hex")}`
    : `${name}-${randomBytes(8).toString("hex")}`;
  const targetDatabase = skipCatalogInitialization ? "postgres" : databaseName;
  let adminDatabase;
  let runtimeDatabase;
  let adminClient;
  let result;
  let containerId;
  let containerIdentity;
  let inspectContainer;
  let assertOwnedContainer;
  let launchAttempted = false;
  let primaryError;
  let cleanupError;
  let containerRemoved = false;
  let teardownMs;
  try {
    launchAttempted = true;
    await docker(
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--label",
      `${runLabelKey}=${runLabel}`,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--env",
      `POSTGRES_DB=${targetDatabase}`,
      "--tmpfs",
      "/var/lib/postgresql/data:rw,noexec,nosuid,size=536870912",
      "--publish",
      "127.0.0.1::5432",
      image,
    ).then(({ stdout }) => {
      const reportedId = stdout.trim();
      if (!/^[0-9a-f]{64}$/u.test(reportedId))
        throw new Error("disposable PostgreSQL container CID is unavailable");
      containerId = reportedId;
    });
    inspectContainer = async () => {
      const format = `{{.Id}}|{{.Name}}|{{.Image}}|{{.Config.Image}}|{{index .Config.Labels "${runLabelKey}"}}|{{json (index .NetworkSettings.Ports "5432/tcp")}}|{{json .HostConfig.Tmpfs}}`;
      const { stdout } = await docker(
        "inspect",
        "--format",
        format,
        containerId,
      );
      const fields = stdout.trim().split("|");
      assert.equal(fields.length, 7, "selected container identity fields");
      const bindings = JSON.parse(fields[5]);
      assert.ok(Array.isArray(bindings));
      assert.equal(bindings.length, 1, "one published PostgreSQL port");
      return {
        id: fields[0],
        name: fields[1],
        imageId: fields[2],
        configuredImage: fields[3],
        runLabel: fields[4],
        hostIp: bindings[0]?.HostIp,
        hostPort: bindings[0]?.HostPort,
        tmpfs: JSON.parse(fields[6]),
      };
    };
    assertOwnedContainer = (actual, expected) => {
      assert.equal(actual.id, containerId, "disposable PostgreSQL CID drift");
      assert.equal(actual.name, `/${name}`, "disposable PostgreSQL name drift");
      assert.match(actual.imageId, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(actual.configuredImage, image, "PostgreSQL image pin drift");
      assert.equal(actual.runLabel, runLabel, "disposable run label drift");
      assert.equal(
        actual.hostIp,
        "127.0.0.1",
        "PostgreSQL must bind loopback only",
      );
      assert.match(actual.hostPort, /^[1-9][0-9]*$/u);
      assert.equal(actual.tmpfs?.["/var/lib/postgresql/data"], "rw,noexec,nosuid,size=536870912", "disposable PostgreSQL must use bounded tmpfs");
      if (expected) assert.deepEqual(actual, expected);
    };
    containerIdentity = await inspectContainer();
    assertOwnedContainer(containerIdentity);
    const port = Number(containerIdentity.hostPort);
    await waitForPostgres(port, targetDatabase);
    assertOwnedContainer(await inspectContainer(), containerIdentity);
    const filesystem = (await docker("exec", containerId, "stat", "-f", "-c", "%T|%S|%b", "/var/lib/postgresql/data")).stdout.trim().split("|");
    assert.equal(filesystem.length, 3, "disposable PostgreSQL filesystem fields");
    assert.equal(filesystem[0], "tmpfs", "disposable PostgreSQL filesystem type");
    assert.equal(Number(filesystem[1]) * Number(filesystem[2]), 536870912, "disposable PostgreSQL tmpfs capacity");
    adminClient = new Client({
      host: "127.0.0.1",
      port,
      database: targetDatabase,
      user: "postgres",
      password,
      ssl: false,
    });
    await adminClient.connect();
    let firstApply = [];
    let secondApply = [];
    let migrationProof;
    let runtimePassword;
    if (!skipCatalogInitialization) {
      assertOwnedContainer(await inspectContainer(), containerIdentity);
      runtimePassword = `runtime-${randomBytes(12).toString("hex")}`;
      await adminClient.query(
        `CREATE ROLE coffee_catalog_import_rw LOGIN PASSWORD '${runtimePassword}'`,
      );
      adminDatabase = createDatabase({
        owner: "catalog-migrator-proof",
        database: databaseName,
        allowedDatabase: databaseName,
        host: "127.0.0.1",
        port,
        user: "postgres",
        password,
        ssl: false,
        pool,
        shutdownGraceMs: 40_000,
      });
      await adminDatabase.resource.start(new AbortController().signal);
      const set = await migrations();
      ({ firstApply, secondApply, migrationProof } = await proveMigrations(
        adminDatabase,
        adminClient,
        set,
      ));
      runtimeDatabase = createDatabase({
        owner: "catalog-supplier-sync",
        database: databaseName,
        allowedDatabase: databaseName,
        host: "127.0.0.1",
        port,
        user: "coffee_catalog_import_rw",
        password: runtimePassword,
        ssl: false,
        pool,
        shutdownGraceMs: 40_000,
      });
      await runtimeDatabase.resource.start(new AbortController().signal);
    }
    assertOwnedContainer(await inspectContainer(), containerIdentity);
    result = await run({
      ...(runtimeDatabase ? { database: runtimeDatabase } : {}),
      adminClient,
      firstApply,
      secondApply,
      ...(migrationProof ? { migrationProof } : {}),
      container: name,
      containerId,
      containerImageId: containerIdentity.imageId,
      port,
      ...(runtimePassword ? { runtimePassword } : {}),
      databaseName: targetDatabase,
      catalogInitialized: !skipCatalogInitialization,
      runLabel,
      ...(validatedLaunchIdentity
        ? { launchIdentity: validatedLaunchIdentity }
        : {}),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    const teardownStart = performance.now();
    if (runtimeDatabase !== undefined)
      await runtimeDatabase.resource
        .stop(AbortSignal.timeout(5_000))
        .catch(() => undefined);
    if (adminDatabase !== undefined)
      await adminDatabase.resource
        .stop(AbortSignal.timeout(5_000))
        .catch(() => undefined);
    if (adminClient !== undefined)
      await adminClient.end().catch(() => undefined);
    if (launchAttempted && !containerId) {
      cleanupError = new Error(
        "disposable PostgreSQL launch outcome is unknown; no name-based cleanup attempted",
      );
    } else if (containerId) {
      try {
        const idFilter = `id=${String(containerId)}`;
        const listed = await docker(
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          idFilter,
        );
        const ids = listed.stdout.trim().split(/\s+/u).filter(Boolean);
        if (ids.length === 0) {
          containerRemoved = true;
        } else {
          assert.deepEqual(ids, [containerId], "exact container ID lookup");
          assert.equal(typeof inspectContainer, "function");
          assert.equal(typeof assertOwnedContainer, "function");
          const currentIdentity = await inspectContainer();
          assertOwnedContainer(currentIdentity, containerIdentity);
          await docker("rm", "--force", "--volumes", containerId);
          const after = await docker(
            "ps",
            "--all",
            "--quiet",
            "--no-trunc",
            "--filter",
            idFilter,
          );
          assert.equal(after.stdout.trim(), "", "exact container CID remains");
          containerRemoved = true;
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    teardownMs = performance.now() - teardownStart;
    if (teardownMs >= 40_000)
      cleanupError ??= new Error("teardown exceeded shutdown budget");
  }
  if (primaryError && cleanupError)
    throw new AggregateError(
      [primaryError, cleanupError],
      "catalog PostgreSQL callback failed and owned-container cleanup was not verified",
    );
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return {
    ...result,
    cleanup: { containerRemoved, teardownMs, shutdownBudgetMs: 40_000 },
  };
}
