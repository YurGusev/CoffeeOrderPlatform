import {execFile} from "node:child_process";
import assert from "node:assert/strict";
import {runLiveProof} from "./db-live-proof.mjs";
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

// Use the existing live foundation route, not db:smoke's offline role-case plan.
export async function proveCatalogForeignConnect() {
  const receipt = await runLiveProof({bindingProof:async ({port,rolePasswords,roleMap}) => {
    const denials=[];
    for (const target of roleMap.databases.filter(row => row.name !== databaseName)) {
      const client=new Client({host:"127.0.0.1",port,database:target.name,user:"coffee_catalog_import_rw",
        password:rolePasswords.coffee_catalog_import_rw,connectionTimeoutMillis:2_000,ssl:false});
      try {
        await assert.rejects(() => client.connect(),error => {
          assert.equal(error.code,"42501"); denials.push({database:target.name,sqlstate:error.code}); return true;
        });
      } finally { await client.end(); }
    }
    return {runtime:"catalog-supplier-sync",role:"coffee_catalog_import_rw",route:"existing-live-foundation",denials};
  }});
  assert.equal(receipt.cleanup.containerRemoved,true);
  return {...receipt.binding,cleanup:receipt.cleanup.containerRemoved};
}

async function proveMigrations(database, adminClient, set) {
  const options={schema:"catalog",ledgerTable:"platform_schema_migrations",lockKey:"catalog-proof"};
  await adminClient.query("CREATE SCHEMA IF NOT EXISTS catalog");
  const first=await applyMigrations(database,set.slice(0,1),options);
  const states=["Created","Received","Receiving","Rejected"];
  for (const [index,state] of states.entries()) {
    await adminClient.query(`INSERT INTO catalog.supplier_snapshots(snapshot_ref,supplier_ref,state,provider_snapshot_ref,
      declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,content_hash,received_at,failure_code)
      VALUES($1,$2,$3,$4,$5,$5,$5,$5,$6,$7,$8)`,
      [`snp_${String(index+1).padStart(26,"0")}`,"sup_00000000000000000000000001",state,
        ["Received","Receiving"].includes(state) ? "pre-upgrade" : null,state === "Received" ? 0 : null,
        state === "Received" ? "0".repeat(64) : null,state === "Received" ? "2026-09-20T00:00:00Z" : null,
        state === "Rejected" ? "PROVIDER_UNAVAILABLE" : null]);
  }
  const before=(await adminClient.query("SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref")).rows;
  const remaining=await applyMigrations(database,set,options);
  assert.deepEqual(first,["0001_supplier_snapshots"]);
  assert.deepEqual(remaining,["0002_snapshot_batches","0003_snapshot_staging"]);
  const after=(await adminClient.query("SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref")).rows;
  assert.deepEqual(after,before);
  const ledgerBefore=(await adminClient.query("SELECT * FROM catalog.platform_schema_migrations ORDER BY id")).rows;
  const secondApply=await applyMigrations(database,set,options);
  assert.deepEqual(secondApply,[]);
  const changedSql=`${set[0].sql}\n-- recomputed-checksum drift probe\n`;
  const changed=set.map((row,index) => index === 0 ? {...row,sql:changedSql,checksum:migrationChecksum(changedSql)} : row);
  let driftCode;
  await assert.rejects(() => applyMigrations(database,changed,options),error => {
    driftCode=error.code; return error.code === "MIGRATION_CHECKSUM_DRIFT" && error.migrationId === set[0].id;
  });
  assert.deepEqual((await adminClient.query("SELECT * FROM catalog.platform_schema_migrations ORDER BY id")).rows,ledgerBefore);
  assert.deepEqual((await adminClient.query("SELECT * FROM catalog.supplier_snapshots ORDER BY snapshot_ref")).rows,before);
  // Sentinels belong only to the migration drill, not startup recovery scenarios.
  await adminClient.query("DELETE FROM catalog.supplier_snapshots");
  return {firstApply:[...first,...remaining],secondApply,migrationProof:{ledger:"catalog.platform_schema_migrations",preservedStates:states,repeatNoop:true,
    driftCode,recomputedChecksum:changed[0].checksum !== set[0].checksum,ledgerUnchanged:true}};
}

export async function withCatalogPostgres(run) {
  const name = `coffee-catalog-${process.pid}-${randomBytes(4).toString("hex")}`;
  let adminDatabase;
  let runtimeDatabase;
  let adminClient;
  let result;
  let teardownMs;
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
    const {firstApply,secondApply,migrationProof}=await proveMigrations(adminDatabase,adminClient,set);
    runtimeDatabase = createDatabase({owner:"catalog-supplier-sync", database:databaseName, allowedDatabase:databaseName, host:"127.0.0.1", port, user:"coffee_catalog_import_rw", password:runtimePassword, ssl:false, pool, shutdownGraceMs:40_000});
    await runtimeDatabase.resource.start(new AbortController().signal);
    result=await run({database:runtimeDatabase, adminClient, firstApply, secondApply, migrationProof, container:name, port, runtimePassword, databaseName});
  } finally {
    const teardownStart=performance.now();
    if (runtimeDatabase !== undefined) await runtimeDatabase.resource.stop(AbortSignal.timeout(5_000)).catch(() => undefined);
    if (adminDatabase !== undefined) await adminDatabase.resource.stop(AbortSignal.timeout(5_000)).catch(() => undefined);
    if (adminClient !== undefined) await adminClient.end().catch(() => undefined);
    await docker("rm", "--force", "--volumes", name);
    assert.equal((await docker("ps","--all","--quiet","--filter",`name=^/${name}$`)).stdout.trim(),"");
    teardownMs=performance.now()-teardownStart;
    assert.ok(teardownMs<40_000,"teardown exceeded shutdown budget");
  }
  return {...result,cleanup:{containerRemoved:true,teardownMs,shutdownBudgetMs:40_000}};
}
