import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {Client} from "pg";
import {createDatabase} from "../packages/platform-database/dist/index.js";
import {applyMigrations, migrationChecksum} from "../packages/platform-migrations/dist/index.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const image = "postgres:17.11";
const databaseName = "coffee_platform_catalog";
const password = `catalog-${randomBytes(12).toString("hex")}`;
const pool = Object.freeze({max:4, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000});

async function docker(...args) {
  return exec("docker", args, {timeout: 120_000});
}
async function waitForPostgres(port) {
  let last;
  for (let attempt = 0; attempt < 80; attempt++) {
    const client = new Client({host:"127.0.0.1", port, database:databaseName, user:"postgres", password, ssl:false});
    try { await client.connect(); await client.query("SELECT 1"); await client.end(); return; }
    catch (error) { last = error; await client.end().catch(() => undefined); await new Promise(resolveWait => setTimeout(resolveWait, 250)); }
  }
  throw last ?? new Error("PostgreSQL did not become ready");
}
async function migrations() {
  const names = ["0001_supplier_snapshots", "0002_snapshot_batches", "0003_snapshot_staging"];
  return Promise.all(names.map(async id => {
    const sql = await readFile(resolve(root, `apps/catalog-service/migrations/${id}.sql`), "utf8");
    return {id, sql, checksum:migrationChecksum(sql)};
  }));
}

export async function withCatalogPostgres(run) {
  const name = `coffee-catalog-${process.pid}-${randomBytes(4).toString("hex")}`;
  let adminDatabase;
  let runtimeDatabase;
  let adminClient;
  try {
    await docker("run", "--detach", "--rm", "--name", name, "--env", `POSTGRES_PASSWORD=${password}`, "--env", `POSTGRES_DB=${databaseName}`, "--publish", "127.0.0.1::5432", image);
    const mapped = await docker("port", name, "5432/tcp");
    const match = /:(\d+)\s*$/u.exec(mapped.stdout);
    if (match === null) throw new Error(`cannot determine disposable PostgreSQL port: ${mapped.stdout}`);
    const port = Number(match[1]);
    await waitForPostgres(port);
    adminClient = new Client({host:"127.0.0.1", port, database:databaseName, user:"postgres", password, ssl:false});
    await adminClient.connect();
    const runtimePassword = `runtime-${randomBytes(12).toString("hex")}`;
    await adminClient.query(`CREATE ROLE coffee_catalog_import_rw LOGIN PASSWORD '${runtimePassword}'`);
    adminDatabase = createDatabase({owner:"catalog-migrator-proof", database:databaseName, allowedDatabase:databaseName, host:"127.0.0.1", port, user:"postgres", password, ssl:false, pool, shutdownGraceMs:40_000});
    await adminDatabase.resource.start(new AbortController().signal);
    const set = await migrations();
    const firstApply = await applyMigrations(adminDatabase, set, {schema:"public", ledgerTable:"catalog_schema_migrations", lockKey:"catalog-proof"});
    const secondApply = await applyMigrations(adminDatabase, set, {schema:"public", ledgerTable:"catalog_schema_migrations", lockKey:"catalog-proof"});
    runtimeDatabase = createDatabase({owner:"catalog-supplier-sync", database:databaseName, allowedDatabase:databaseName, host:"127.0.0.1", port, user:"coffee_catalog_import_rw", password:runtimePassword, ssl:false, pool, shutdownGraceMs:40_000});
    await runtimeDatabase.resource.start(new AbortController().signal);
    return await run({database:runtimeDatabase, adminClient, firstApply, secondApply, container:name, port, runtimePassword, databaseName});
  } finally {
    if (runtimeDatabase !== undefined) await runtimeDatabase.resource.stop(AbortSignal.timeout(5_000)).catch(() => undefined);
    if (adminDatabase !== undefined) await adminDatabase.resource.stop(AbortSignal.timeout(5_000)).catch(() => undefined);
    if (adminClient !== undefined) await adminClient.end().catch(() => undefined);
    await docker("rm", "--force", name).catch(() => undefined);
  }
}
