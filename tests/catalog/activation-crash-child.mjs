import {Client} from "pg";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {createCatalogActivationStore} from "../../apps/catalog-activation-worker/dist/activation-store.js";

const port=Number(process.env.CRASH_DB_PORT);
const databaseName=process.env.CRASH_DB_NAME;
const user=process.env.CRASH_DB_USER;
const password=process.env.CRASH_DB_PASSWORD;
const snapshotRef=process.env.CRASH_SNAPSHOT;
const mode=process.argv[2];
const pool={max:2,checkoutTimeoutMs:2_000,lockTimeoutMs:25_000,interactiveStatementTimeoutMs:5_000,
  backgroundStatementTimeoutMs:10_000,terminalTimeoutMs:3_000,transactionTimeoutMs:30_000,
  idleTimeoutMs:30_000,maxLifetimeMs:1_800_000};
const report=message=>process.stdout.write(`${JSON.stringify({pid:process.pid,...message})}\n`);

try {
  if(mode==="verify") {
    const client=new Client({host:"127.0.0.1",port,database:databaseName,user,password,ssl:false,connectionTimeoutMillis:5_000});
    await client.connect();
    const result=await client.query(`SELECT active_snapshot_ref,active_snapshot_revision FROM catalog.catalog_state WHERE id=true`);
    await client.end();
    const row=result.rows[0];
    if(row?.active_snapshot_ref!==snapshotRef || row?.active_snapshot_revision!=="1")
      throw new Error(`recovered activation mismatch: ${JSON.stringify(row)}`);
    report({type:"verified",snapshotRef:row.active_snapshot_ref,snapshotRevision:row.active_snapshot_revision});
  } else if(mode==="activate" || mode==="activate-and-wait" || mode==="race-once") {
    const database=createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user,password,ssl:false,pool,shutdownGraceMs:40_000});
    await database.resource.start(new AbortController().signal);
    try {
      const store=createCatalogActivationStore(database);
      report({type:"ready"});
      const result=await store.runOnce(async request=>({...request,firstSnapshotRef:snapshotRef,state:"Bound"}));
      if(mode==="race-once") {
        if(result.kind!=="activated" && result.kind!=="idle") throw new Error(`unexpected race result: ${JSON.stringify(result)}`);
        report({type:"finished",kind:result.kind});
      } else {
        if(result.kind!=="activated" || result.snapshotRef!==snapshotRef)
          throw new Error(`activation returned ${JSON.stringify(result)}`);
        report({type:"committed",snapshotRef:result.snapshotRef,snapshotRevision:result.snapshotRevision});
        if(mode==="activate-and-wait") await new Promise(()=>{});
      }
    } finally {
      await database.resource.stop(AbortSignal.timeout(5_000));
    }
  } else {
    throw new Error(`unknown child mode: ${mode}`);
  }
} catch(error) {
  report({type:"error",message:error instanceof Error ? `${error.name}: ${error.message}` : String(error),code:error?.code ?? null});
  process.exitCode=1;
}
