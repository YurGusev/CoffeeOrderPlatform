import {canonicalCatalogJson, catalogBatchBytes, catalogBatchHash, catalogContentHash, isAromaCatalogExportRecord} from "../packages/contracts/aroma-v1/dist/index.js";
import {createCatalogImportStore} from "../apps/catalog-supplier-sync/dist/catalog-import-store.js";
import {runCatalogImport} from "../apps/catalog-supplier-sync/dist/run-catalog-import.js";
import {withCatalogPostgres, proveCatalogForeignConnect} from "./catalog-live-harness.mjs";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {Client} from "pg";
import {Readable} from "node:stream";
import {createServer} from "node:http";
import {once} from "node:events";
import {InternalCatalogClient} from "../apps/catalog-supplier-sync/dist/internal-api-client.js";
import {trace} from "@opentelemetry/api";
import {CatalogTelemetry} from "../apps/catalog-supplier-sync/dist/observability.js";

const supplierRef = "sup_00000000000000000000000001";
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const hash = value => value.repeat(64);
const first = Object.freeze({
  sourceProductKeyHash:hash("1"), sourceVariantKeyHash:hash("2"), sourceOfferKeyHash:hash("3"),
  displayName:"Кофе ☕\tстрока\nвозврат\r\\' OR 1=1 --", unit:"piece", supplierUnitMinor:"12345", currency:"RUB", availability:"Available", imageUrl:null,
  supplierPromotions:[{discountBasisPoints:125, minimumWeightRaw:"0.250", providerCreatedAt:"2026-09-20T00:00:00Z", providerUpdatedAt:"2026-09-20T01:00:00Z"}],
  sourceIdentityScheme:"hmac-sha256-v1",
});
const second = Object.freeze({
  sourceProductKeyHash:hash("4"), sourceVariantKeyHash:hash("5"), sourceOfferKeyHash:hash("6"),
  displayName:"Empty optional arrays", unit:"gram", supplierUnitMinor:"0", currency:"RUB", availability:"Stopped", imageUrl:"https://example.invalid/a.png",
  supplierPromotions:[], grindOptions:[], sourceIdentityScheme:"hmac-sha256-v1",
});
function batch(snapshot, items, batchNumber = 0, previousBatchHash = null) {
  return {streamVersion:"1", recordType:"snapshot-batch", snapshotRef:snapshot, batchNumber, offerCount:items.length,
    uncompressedBytes:catalogBatchBytes(items), batchHash:catalogBatchHash(items), previousBatchHash, items};
}
function completed(snapshot, batches, items) {
  return {streamVersion:"1", recordType:"snapshot-completed", snapshotRef:snapshot, batchCount:batches.length,
    productCount:new Set(items.map(item => item.sourceProductKeyHash)).size, variantCount:new Set(items.map(item => item.sourceVariantKeyHash)).size,
    offerCount:items.length, contentHash:catalogContentHash(batches.map(value => value.batchHash)), completedAt:"2026-09-20T02:00:00Z"};
}
async function started(store, snapshot, provider = "provider-snapshot-1") {
  await store.create(snapshot, supplierRef);
  await store.acceptStarted({streamVersion:"1", recordType:"snapshot-started", snapshotRef:snapshot, supplierRef, providerSnapshotRef:provider, startedAt:"2026-09-20T00:00:00Z"});
}

const TABLES=["supplier_snapshots","snapshot_batches","snapshot_products","snapshot_variants","snapshot_offers","snapshot_availability"];
async function capture(admin, ref) {
  const rows={};
  for (const table of TABLES) {
    rows[table]=(await admin.query(`SELECT to_jsonb(t) AS row FROM catalog.${table} t WHERE snapshot_ref=$1 ORDER BY to_jsonb(t)::text`,[ref])).rows.map(row => row.row);
  }
  return rows;
}
async function assertUnchanged(admin,ref,before) {
  const after=await capture(admin,ref);
  assert.deepEqual(after,before);
  const active=(await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='coffee_catalog_import_rw' AND (state LIKE 'idle in transaction%' OR (state='active' AND query ~ '^COPY'))")).rows[0].count;
  assert.equal(active,0,"no active COPY or idle-in-transaction runtime backend");
  return after;
}
async function copyFailureProof(database,admin,mode,ref) {
  const controller=new AbortController();
  let sourceRef;
  let consumedChunks=0;
  let consumedBytes=0;
  const originalFrom=Readable.from.bind(Readable);
  const fromDescriptor=Object.getOwnPropertyDescriptor(Readable,"from");
  const controlledFrom=function(...args) {
    const source=originalFrom.apply(Readable,args);
    sourceRef=source;
    source.once("data",chunk => {
      consumedChunks++; consumedBytes+=Buffer.byteLength(chunk);
      // Pause only after the production pipeline has consumed real source data.
      // The scheduled fault runs after that chunk has reached the COPY sink.
      source.pause();
      setImmediate(() => mode === "abort" ? controller.abort() : source.destroy(new Error("secret provider body source fault")));
    });
    return source;
  };
  const store=createCatalogImportStore(database);
  await started(store,ref,`provider-${mode}`);
  const seed=batch(ref,[{...second,sourceProductKeyHash:hash("7"),sourceVariantKeyHash:hash("8"),sourceOfferKeyHash:hash("9")}]);
  await createCatalogImportStore(database).recordBatch(seed);
  const before=await capture(admin,ref);
  let code;
  try {
    Readable.from=controlledFrom;
    await assert.rejects(() => store.recordBatch(batch(ref,[first,second],1,seed.batchHash),controller.signal),error => {
      code=error.code; return mode === "abort" ? code === "DB_INTERRUPTED" : code === "DB_CONNECTION_LOST";
    });
  } finally {Object.defineProperty(Readable,"from",fromDescriptor);}
  assert.equal(sourceRef.destroyed,true);
  assert.ok(consumedChunks>0);
  const after=await assertUnchanged(admin,ref,before);
  assert.equal((await store.getSnapshot(ref,AbortSignal.timeout(3_000))).state,"Receiving");
  return {code,consumedChunks,consumedBytes,sourceDestroyed:sourceRef.destroyed,sixTablesUnchanged:true,poolUsable:true,before,after};
}
async function httpCopyShutdownProof(database,admin) {
  const ref="snp_00000000000000000000000105";
  const controller=new AbortController();
  const startedRecord={streamVersion:"1",recordType:"snapshot-started",snapshotRef:ref,supplierRef,
    providerSnapshotRef:"http-mid-copy-shutdown",startedAt:"2026-09-20T00:00:00Z"};
  // The live HTTP contract requires canonical decimal text; the direct-store
  // fixture above deliberately carries an otherwise accepted legacy spelling.
  const copyRecord=batch(ref,[{...first,supplierPromotions:[{...first.supplierPromotions[0],minimumWeightRaw:"0.25"}]},second]);
  assert.equal(isAromaCatalogExportRecord(copyRecord),true,"the HTTP fixture must satisfy InternalApiV1");
  let responseClosed;
  let serverRequestReceived=false;
  const abortedResponse=new Promise(resolve => {responseClosed=resolve;});
  let prematureResponseClose=false;
  const server=createServer((_request,response) => {
    serverRequestReceived=true;
    response.writeHead(200,{"content-type":"application/x-ndjson"});
    response.write(`${JSON.stringify(startedRecord)}\n${JSON.stringify(copyRecord)}\n`);
    response.once("close",() => {prematureResponseClose=!response.writableEnded;responseClosed();});
  });
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  const {port: httpPort}=server.address();
  const httpClient=new InternalCatalogClient({fetch:(path,options) => fetch(`http://127.0.0.1:${httpPort}${path}`,options)});
  const originalFrom=Readable.from.bind(Readable);
  const originalFromWeb=Readable.fromWeb.bind(Readable);
  const fromDescriptor=Object.getOwnPropertyDescriptor(Readable,"from");
  const fromWebDescriptor=Object.getOwnPropertyDescriptor(Readable,"fromWeb");
  let copySource;
  let httpSource;
  let copySourceReady;
  const copyPaused=new Promise(resolve => {copySourceReady=resolve;});
  Readable.from=function(...args) {
    const source=originalFrom.apply(Readable,args);
    copySource=source;
    source.once("data",() => {source.pause();copySourceReady();});
    return source;
  };
  Readable.fromWeb=function(...args) {
    httpSource=originalFromWeb.apply(Readable,args);
    return httpSource;
  };
  const store=createCatalogImportStore(database);
  let before;
  let importError;
  const receivedRecords=[];
  const importTask=runCatalogImport({store,supplierRef,snapshotRef:ref,signal:controller.signal,
    context:{correlationId:"24424424-2442-4442-8442-244244244244"},
    exportCatalog:async function* (request,context) {for await (const record of httpClient.export(request,context)) {receivedRecords.push({type:record?.recordType,valid:isAromaCatalogExportRecord(record),keys:Object.keys(record ?? {})});yield record;}}}).catch(error => {importError=error;});
  const shutdownStarted=performance.now();
  try {
    await Promise.race([copyPaused,new Promise((_,reject) => {const timer=setTimeout(() => reject(new Error(`COPY source did not start; request=${serverRequestReceived}, import=${importError?.code ?? importError?.message ?? "pending"}, records=${JSON.stringify(receivedRecords)}`)),10_000);timer.unref();})]);
    let activeCopy=false;
    const copyDeadline=performance.now()+10_000;
    while (performance.now()<copyDeadline) {
      const row=(await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='coffee_catalog_import_rw' AND state='active' AND query ~ '^COPY'" )).rows[0];
      if (row.count>0) {activeCopy=true;break;}
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.equal(activeCopy,true,"real PostgreSQL COPY must be active before shutdown");
    assert.equal(database.metrics().active,1,"the active COPY owns one leased runtime connection");
    // Created→Receiving is committed before batch COPY. Compare the durable
    // state immediately before cancelling COPY, not before starting the export.
    before=await capture(admin,ref);
    assert.equal(before.supplier_snapshots[0]?.state,"Receiving");
    const shutdownTask=database.resource.stop(AbortSignal.timeout(40_000));
    controller.abort(new DOMException("catalog shutdown","AbortError"));
    const remainingMs=40_000-(performance.now()-shutdownStarted);
    assert.ok(remainingMs>0,"shutdown budget elapsed before database shutdown");
    const deadline=AbortSignal.timeout(Math.max(1,Math.floor(remainingMs)));
    await Promise.race([Promise.all([shutdownTask,importTask]),new Promise((_,reject) =>
      deadline.addEventListener("abort",() => reject(new Error("active COPY shutdown exceeded 40s budget")),{once:true}))]);
    await Promise.race([abortedResponse,new Promise((_,reject) => {const timer=setTimeout(() => reject(new Error("HTTP body reader did not abort")),5_000);timer.unref();})]);
    assert.equal(prematureResponseClose,true,"HTTP response body must close before completion");
    assert.equal(copySource.destroyed,true,"COPY source must be destroyed");
    assert.equal(httpSource.destroyed,true,"HTTP response/body reader source must be destroyed");
    assert.ok(importError,"aborted COPY import must reject");
    assert.equal(importError.code,"DB_INTERRUPTED");
    const after=await capture(admin,ref);
    assert.deepEqual(after,before,"transaction rollback must preserve all six catalog tables");
    assert.equal(Object.keys(after).length,6);
    const active=(await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='coffee_catalog_import_rw' AND (state LIKE 'idle in transaction%' OR (state='active' AND query ~ '^COPY'))")).rows[0].count;
    assert.equal(active,0,"no COPY or idle transaction backend remains");
    assert.equal(database.metrics().active,0,"connection lease must be released");
    assert.equal(database.metrics().pending,0,"database shutdown waits for import transaction settlement");
    const shutdownMs=performance.now()-shutdownStarted;
    assert.ok(shutdownMs<40_000,"graceful shutdown must complete within its configured budget");
    return {readerCancelled:prematureResponseClose,copyCancelled:importError.code==="DB_INTERRUPTED",sourceDestroyed:copySource.destroyed&&httpSource.destroyed,
      sixTablesRolledBack:true,connectionReleased:database.metrics().active===0,shutdownAborted:controller.signal.aborted,shutdownMs,
      copyError:importError.code,observedActiveCopy:true,connectionBackendGone:active===0,before,after};
  } finally {
    controller.abort();
    // On a failed assertion or timeout, do not let the proof harness strand a
    // transaction or an open HTTP response while the disposable DB is removed.
    if (database.metrics().active>0 || database.metrics().pending>0) database.resource.destroy();
    Object.defineProperty(Readable,"from",fromDescriptor);
    Object.defineProperty(Readable,"fromWeb",fromWebDescriptor);
    server.closeAllConnections();
    try {
      await Promise.race([importTask,new Promise((_,reject) => {const timer=setTimeout(() => reject(new Error("import cleanup exceeded 5s")),5_000);timer.unref();})]);
    } finally {
      await new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}
async function postMergeProof(database,admin) {
  const store=createCatalogImportStore(database);
  const ref="snp_00000000000000000000000103";
  await started(store,ref,"provider-post-merge");
  const seed=batch(ref,[first]);
  await store.recordBatch(seed);
  const before=await capture(admin,ref);
  // Disposable DB observer: every merge must produce a row before the
  // revoked manifest INSERT fails. No production SQL or hooks are changed.
  await admin.query("CREATE SEQUENCE catalog.merge_probe START 1");
  await admin.query("GRANT USAGE ON SEQUENCE catalog.merge_probe TO coffee_catalog_import_rw");
  await admin.query(`CREATE FUNCTION catalog.observe_merges_proof() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM catalog.snapshot_products WHERE snapshot_ref=NEW.snapshot_ref AND source_product_key_hash='${hash("4")}')
        OR NOT EXISTS(SELECT 1 FROM catalog.snapshot_variants WHERE snapshot_ref=NEW.snapshot_ref AND source_variant_key_hash='${hash("5")}')
        OR NOT EXISTS(SELECT 1 FROM catalog.snapshot_offers WHERE snapshot_ref=NEW.snapshot_ref AND source_offer_key_hash='${hash("6")}')
        OR NOT EXISTS(SELECT 1 FROM catalog.snapshot_availability WHERE snapshot_ref=NEW.snapshot_ref AND source_offer_key_hash='${hash("6")}')
      THEN RAISE EXCEPTION 'merge precondition missing' USING ERRCODE='P0002'; END IF;
      PERFORM nextval('catalog.merge_probe');
      RETURN NEW;
    END $$`);
  await admin.query("CREATE TRIGGER observe_merges_proof AFTER INSERT ON catalog.snapshot_availability FOR EACH ROW EXECUTE FUNCTION catalog.observe_merges_proof()");
  await admin.query("REVOKE INSERT ON catalog.snapshot_batches FROM coffee_catalog_import_rw");
  // Observe the SQLSTATE at the real driver boundary; foundation intentionally
  // redacts it before the importer sees DB_QUERY_FAILED. Restore unconditionally.
  const query=Client.prototype.query,manifestStates=[];
  Client.prototype.query=function(...args) {
    const result=query.apply(this,args);
    if (this.connectionParameters.user === "coffee_catalog_import_rw" && args[0]?.text?.startsWith("INSERT INTO catalog.snapshot_batches")) {
      return result.catch(error => {manifestStates.push(error.code);throw error;});
    }
    return result;
  };
  let errorCode;
  try {
    await assert.rejects(() => store.recordBatch(batch(ref,[second],1,seed.batchHash)),error => {
      errorCode=error.code; return error.code === "IMPORT_DB_ROLLED_BACK";
    });
    assert.deepEqual(manifestStates,["42501"]);
    assert.equal((await admin.query("SELECT is_called FROM catalog.merge_probe")).rows[0].is_called,true);
    const after=await assertUnchanged(admin,ref,before);
    assert.equal((await store.getSnapshot(ref,AbortSignal.timeout(3_000))).state,"Receiving");
    const importRef="snp_00000000000000000000000104";
    const importBatch=batch(importRef,[second]);
    await assert.rejects(() => runCatalogImport({store,supplierRef,snapshotRef:importRef,signal:AbortSignal.timeout(5_000),
      context:{correlationId:"11111111-1111-4111-8111-111111111111"},
      exportCatalog:async function* () {
        yield {streamVersion:"1",recordType:"snapshot-started",snapshotRef:importRef,supplierRef,providerSnapshotRef:"known-rollback",startedAt:"2026-09-20T00:00:00Z"};
        yield importBatch;
      }}),error => error.code === "IMPORT_DB_ROLLED_BACK");
    const row=await store.getSnapshot(importRef);
    assert.equal(row.state,"Rejected");
    assert.equal(row.failure_code,"IMPORT_DB_ROLLED_BACK");
    const persisted=await capture(admin,importRef);
    for (const table of TABLES.slice(1)) assert.deepEqual(persisted[table],[]);
    assert.doesNotMatch(JSON.stringify(persisted),/secret|provider body|23514/u);
    return {postMergeRollback:{code:errorCode,sqlstate:manifestStates[0],allFourMergesObserved:true,sixTablesUnchanged:true,poolUsable:true,before,after},
      knownRollback:{failureCode:row.failure_code,safeText:true}};
  } finally {
    Client.prototype.query=query;
    await admin.query("GRANT INSERT ON catalog.snapshot_batches TO coffee_catalog_import_rw");
    await admin.query("DROP TRIGGER observe_merges_proof ON catalog.snapshot_availability");
    await admin.query("DROP FUNCTION catalog.observe_merges_proof()");
    await admin.query("DROP SEQUENCE catalog.merge_probe");
  }
}

async function stateMatrixProof(database,admin) {
  const store=createCatalogImportStore(database);
  const results=[];
  let serial=200;
  const next=() => `snp_${String(serial++).padStart(26,"0")}`;
  const startRecord=ref => ({streamVersion:"1",recordType:"snapshot-started",snapshotRef:ref,supplierRef,
    providerSnapshotRef:"matrix-provider",startedAt:"2026-09-20T00:00:00Z"});
  async function negative(name,ref,operation,code) {
    const before=await capture(admin,ref);
    await assert.rejects(operation,error => error.code === code,name);
    await assertUnchanged(admin,ref,before);
    results.push({name,code,passed:true});
  }
  const ref=next();
  await store.create(ref,supplierRef);
  const record=batch(ref,[second]);
  const terminal=completed(ref,[record],[second]);
  await negative("Created batch",ref,() => store.recordBatch(record),"BATCH_SEQUENCE_CONFLICT");
  await negative("Created complete",ref,() => store.complete(terminal),"TERMINAL_REPLAY_CONFLICT");
  await negative("wrong supplier",ref,() => store.acceptStarted({...startRecord(ref),supplierRef:"sup_00000000000000000000000002"}),"SNAPSHOT_STARTED_CONFLICT");
  await store.acceptStarted(startRecord(ref));
  let before=await capture(admin,ref);
  await store.acceptStarted(startRecord(ref));
  await assertUnchanged(admin,ref,before);
  results.push({name:"started exact replay",passed:true});
  await negative("wrong provider",ref,() => store.acceptStarted({...startRecord(ref),providerSnapshotRef:"other"}),"SNAPSHOT_STARTED_CONFLICT");
  await negative("batch gap",ref,() => store.recordBatch({...record,batchNumber:1}),"BATCH_SEQUENCE_CONFLICT");
  await negative("chain",ref,() => store.recordBatch({...record,previousBatchHash:"0".repeat(64)}),"BATCH_CHAIN_CONFLICT");
  await negative("byte count",ref,() => store.recordBatch({...record,uncompressedBytes:1}),"BATCH_BYTE_COUNT_MISMATCH");
  await negative("offer count",ref,() => store.recordBatch({...record,offerCount:2}),"BATCH_OFFER_COUNT_MISMATCH");
  await negative("payload hash",ref,() => store.recordBatch({...record,batchHash:"0".repeat(64)}),"BATCH_HASH_CONFLICT");
  for (const money of ["-1","01","1.0","1e2",1,null]) {
    await negative(`invalid money ${String(money)}`,ref,() => store.recordBatch(batch(ref,[{...second,supplierUnitMinor:money}])),"INVALID_STREAM_SCHEMA");
  }
  for (const [name,items] of [
    ["duplicate offer same",[second,second]],
    ["duplicate offer changed",[second,{...second,displayName:"other"}]],
    ["product collision",[second,{...first,sourceProductKeyHash:second.sourceProductKeyHash}]],
    ["variant collision",[second,{...first,sourceVariantKeyHash:second.sourceVariantKeyHash}]],
    ["grind collision",[{...second,grindOptions:[{sourceGrindKeyHash:hash("a"),displayName:"A"},{sourceGrindKeyHash:hash("a"),displayName:"B"}]}]],
  ]) await negative(name,ref,() => store.recordBatch(batch(ref,items)),"SOURCE_IDENTITY_COLLISION");
  await store.recordBatch(record);
  before=await capture(admin,ref);
  assert.equal(await store.recordBatch(record),"replay");
  await assertUnchanged(admin,ref,before);
  results.push({name:"Receiving exact batch replay",passed:true});
  await negative("changed previous hash replay",ref,() => store.recordBatch({...record,previousBatchHash:hash("b")}),"BATCH_REPLAY_CONFLICT");
  await negative("terminal counts",ref,() => store.complete({...terminal,productCount:2}),"TERMINAL_COUNT_MISMATCH");
  await negative("terminal content",ref,() => store.complete({...terminal,contentHash:hash("c")}),"TERMINAL_CONTENT_HASH_MISMATCH");
  await negative("cross-batch variant to product conflict",ref,() => store.recordBatch(batch(ref,
    [{...second,sourceProductKeyHash:hash("a"),sourceOfferKeyHash:hash("b")}],1,record.batchHash)),"SOURCE_IDENTITY_COLLISION");
  const later=batch(ref,[first],1,record.batchHash);
  await store.recordBatch(later);
  before=await capture(admin,ref);
  assert.equal(await store.recordBatch(record),"replay");
  await assertUnchanged(admin,ref,before);
  results.push({name:"older batch replay after progress",passed:true});
  const final=completed(ref,[record,later],[second,first]);
  // A nonzero manifest permits a different previous hash at the SQL layer;
  // complete must still reject the broken generation chain.
  await admin.query("UPDATE catalog.snapshot_batches SET previous_batch_hash=$2 WHERE snapshot_ref=$1 AND batch_number=1",[ref,hash("b")]);
  await negative("terminal chain",ref,() => store.complete(final),"TERMINAL_CHAIN_MISMATCH");
  await admin.query("UPDATE catalog.snapshot_batches SET previous_batch_hash=$2 WHERE snapshot_ref=$1 AND batch_number=1",[ref,record.batchHash]);
  await store.complete(final);
  assert.equal((await store.getSnapshot(ref)).received_at.toISOString(),"2026-09-20T02:00:00.000Z");
  const received=await capture(admin,ref);
  assert.equal(await store.complete(final),"replay");
  assert.equal(await store.recordBatch(record),"replay");
  await assertUnchanged(admin,ref,received);
  results.push({name:"Received exact terminal and batch replay",passed:true});
  await negative("Received reject",ref,() => store.reject(ref,"INVALID_STREAM"),"TERMINAL_REPLAY_CONFLICT");
  await negative("Received started",ref,() => store.acceptStarted(startRecord(ref)),"SNAPSHOT_STARTED_CONFLICT");
  const createdRejected=next();
  await store.create(createdRejected,supplierRef);
  await store.reject(createdRejected,"PROVIDER_UNAVAILABLE");
  assert.equal((await store.getSnapshot(createdRejected)).state,"Rejected");
  assert.equal((await store.getSnapshot(createdRejected)).received_at,null);
  const rejected=next();
  await started(store,rejected);
  const rejectedBatch=batch(rejected,[second]);
  await store.recordBatch(rejectedBatch);
  await store.reject(rejected,"PROVIDER_TIMEOUT");
  before=await capture(admin,rejected);
  assert.equal(await store.reject(rejected,"PROVIDER_TIMEOUT"),"replay");
  await assertUnchanged(admin,rejected,before);
  results.push({name:"Rejected exact replay",passed:true});
  await negative("Rejected different reason",rejected,() => store.reject(rejected,"INVALID_STREAM"),"TERMINAL_REPLAY_CONFLICT");
  await negative("Rejected completed",rejected,() => store.complete(completed(rejected,[rejectedBatch],[second])),"TERMINAL_REPLAY_CONFLICT");
  await negative("Rejected batch replay",rejected,() => store.recordBatch(rejectedBatch),"BATCH_REPLAY_CONFLICT");
  await negative("Rejected started",rejected,() => store.acceptStarted(startRecord(rejected)),"SNAPSHOT_STARTED_CONFLICT");
  return results;
}

async function aclProof({port,runtimePassword,databaseName,adminClient}) {
  const client=new Client({host:"127.0.0.1",port,database:databaseName,user:"coffee_catalog_import_rw",password:runtimePassword,connectionTimeoutMillis:2_000});
  const denials=[];
  await adminClient.query("CREATE TABLE catalog.acl_protected(value integer)");
  try {
    await client.connect();
    assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"coffee_catalog_import_rw");
    const map=JSON.parse(await readFile(new URL("../config/database-role-map.json",import.meta.url),"utf8"));
    const configured=map.databases.find(row => row.name === databaseName).runtimeRoles.find(row => row.role === "coffee_catalog_import_rw");
    for (const table of TABLES) {
      const expected=table === "supplier_snapshots" ? ["SELECT","INSERT","UPDATE"] : ["SELECT","INSERT"];
      assert.deepEqual(configured.tables[table],expected,`minimal role-map ${table}`);
      for (const permission of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","MAINTAIN"]) {
        const granted=(await client.query("SELECT has_table_privilege(current_user,$1,$2) AS granted",[`catalog.${table}`,permission])).rows[0].granted;
        assert.equal(granted,expected.includes(permission),`${table} ${permission}`);
      }
    }
    assert.deepEqual((await client.query("SELECT has_schema_privilege(current_user,'catalog','USAGE') AS usage, has_schema_privilege(current_user,'catalog','CREATE') AS create")).rows[0],{usage:true,create:false});
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE catalog_acl_probe(value integer) ON COMMIT DROP");
    await client.query("INSERT INTO catalog_acl_probe VALUES(1)");
    assert.equal((await client.query("SELECT value FROM catalog_acl_probe")).rows[0].value,1);
    await client.query("ROLLBACK");
    for (const [operation,sql] of [
      ...TABLES.slice(1).map(table => [`UPDATE ${table}`,`UPDATE catalog.${table} SET snapshot_ref=snapshot_ref`]),
      ["DELETE supplier_snapshots","DELETE FROM catalog.supplier_snapshots"],
      ["INSERT protected","INSERT INTO catalog.acl_protected VALUES(1)"],
      ["DDL catalog","CREATE TABLE catalog.forbidden(value text)"],["DDL public","CREATE TABLE public.forbidden(value text)"],
    ]) {
      await assert.rejects(() => client.query(sql),error => {assert.equal(error.code,"42501");denials.push({operation,sqlstate:error.code});return true;});
    }
    return {role:"coffee_catalog_import_rw",tempRoundTrip:true,roleMapMatchesMigrations:true,denials};
  } finally {await client.end();await adminClient.query("DROP TABLE catalog.acl_protected");}
}

export async function runCatalogCopyProof() {
  const spans = new Map();
  trace.setGlobalTracerProvider({getTracer:() => ({startSpan:name => {
    const row = spans.get(name) ?? {started:0,ended:0}; row.started++; spans.set(name,row);
    return {end:() => {row.ended++;}, setStatus:() => {}, spanContext:() => ({traceId:"1".repeat(32),spanId:"2".repeat(16),traceFlags:1})};
  }})});
  try {
    const foreignConnect=await proveCatalogForeignConnect();
    return await withCatalogPostgres(async ({database, adminClient, firstApply, secondApply, migrationProof, port, runtimePassword, databaseName}) => {
    const telemetry = new CatalogTelemetry();
    const store = createCatalogImportStore(database, telemetry);
    const midCopyAbort=await copyFailureProof(database,adminClient,"abort","snp_00000000000000000000000101");
    const copySourceFailure=await copyFailureProof(database,adminClient,"source","snp_00000000000000000000000102");
    const {postMergeRollback,knownRollback}=await postMergeProof(database,adminClient);
    const acl=await aclProof({port,runtimePassword,databaseName,adminClient});
    const stateMatrix=await stateMatrixProof(database,adminClient);
    await started(store, snapshotRef);
    const record = batch(snapshotRef, [first, second]);
    if (await store.recordBatch(record) !== "stored") throw new Error("first batch was not stored");
    if (await store.recordBatch(record) !== "replay") throw new Error("exact replay was not a no-op");
    const terminal = completed(snapshotRef, [record], [first, second]);
    await store.complete(terminal);
    const reconstructed = await store.reconstructBatch(snapshotRef, 0);
    if (canonicalCatalogJson(reconstructed) !== canonicalCatalogJson([first, second])) throw new Error("persistent reconstruction changed payload or optionals");
    const row = await store.getSnapshot(snapshotRef);
    if (row?.state !== "Received" || row.provider_snapshot_ref !== "provider-snapshot-1") throw new Error("snapshot did not reach Received");
    let replayConflictRejected = false;
    const changedReplay = batch(snapshotRef, [{...first, sourceOfferKeyHash:"e".repeat(64)}, second]);
    try { await store.recordBatch(changedReplay); } catch { replayConflictRejected = true; }
    if (!replayConflictRejected) throw new Error("mismatched batch replay was accepted");
    let terminalConflictRejected = false;
    try { await store.complete({...terminal, contentHash:"0".repeat(64)}); } catch { terminalConflictRejected = true; }
    if (!terminalConflictRejected || (await store.getSnapshot(snapshotRef))?.state !== "Received") throw new Error("terminal conflict changed Received state");
    let terminalTimestampConflictRejected = false;
    try { await store.complete({...terminal, completedAt:"2026-09-20T02:00:01Z"}); } catch { terminalTimestampConflictRejected = true; }
    if (!terminalTimestampConflictRejected || (await store.getSnapshot(snapshotRef))?.state !== "Received") throw new Error("terminal timestamp conflict changed Received state");

    const conflictRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBD";
    const conflictStarted = {streamVersion:"1", recordType:"snapshot-started", snapshotRef:conflictRef, supplierRef,
      providerSnapshotRef:"provider-replay-conflict", startedAt:"2026-09-20T00:00:00Z"};
    const conflictFirst = batch(conflictRef, [second]);
    const conflictChanged = batch(conflictRef, [{...second, displayName:"conflicting replay"}]);
    let conflictError;
    await runCatalogImport({store, supplierRef, snapshotRef:conflictRef, signal:new AbortController().signal,
      context:{correlationId:"66666666-6666-4666-8666-666666666666"},
      exportCatalog:async function* () { yield conflictStarted; yield conflictFirst; yield conflictChanged; }}).catch(error => { conflictError=error; });
    const conflictRow = await store.getSnapshot(conflictRef);
    const receivingReplayConflictRejected = conflictRow?.state === "Rejected" && conflictRow.failure_code === "BATCH_HASH_CONFLICT";
    if (!receivingReplayConflictRejected) throw new Error(`Receiving replay conflict was not durably rejected: ${conflictRow?.state ?? "missing"}/${conflictRow?.failure_code ?? "none"}; error=${conflictError?.name ?? "none"}/${conflictError?.code ?? "none"}/${conflictError?.message ?? "none"}; cause=${conflictError?.cause?.name ?? "none"}/${conflictError?.cause?.code ?? "none"}`);

    const tamperRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    await started(store, tamperRef, "provider-tamper");
    const tamperBatch = batch(tamperRef, [first]);
    await store.recordBatch(tamperBatch);
    await adminClient.query("UPDATE catalog.snapshot_variants SET display_name='tampered' WHERE snapshot_ref=$1", [tamperRef]);
    let tamperDetected = false;
    try { await store.complete(completed(tamperRef, [tamperBatch], [first])); }
    catch (error) { tamperDetected = error instanceof Error && /BATCH_DURABLE_HASH_MISMATCH/u.test(error.message); }
    if (!tamperDetected) throw new Error("persistent tamper was not detected");

    const rollbackRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAX";
    await started(store, rollbackRef, "provider-rollback");
    const duplicate = {...second, sourceOfferKeyHash:first.sourceOfferKeyHash};
    const bad = batch(rollbackRef, [first, duplicate]);
    await store.recordBatch(bad).then(() => { throw new Error("duplicate COPY batch was accepted"); }, () => undefined);
    const partial = await adminClient.query("SELECT count(*)::int count FROM catalog.snapshot_offers WHERE snapshot_ref=$1", [rollbackRef]);
    if (partial.rows[0].count !== 0) throw new Error("COPY failure left partial persistent rows");

    const driftRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAY";
    await started(store, driftRef, "provider-drift");
    const driftFirst = batch(driftRef, [first]);
    await store.recordBatch(driftFirst);
    const driftItem = {...second, sourceProductKeyHash:first.sourceProductKeyHash, imageUrl:"https://example.invalid/drift.png"};
    const driftSecond = batch(driftRef, [driftItem], 1, driftFirst.batchHash);
    let semanticDriftRejected = false;
    try { await store.recordBatch(driftSecond); } catch { semanticDriftRejected = true; }
    const driftRow = await store.getSnapshot(driftRef);
    if (!semanticDriftRejected || driftRow?.next_batch_number !== 1) throw new Error("cross-batch semantic drift was not atomic");

    const grindRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    await started(store, grindRef, "provider-grind-drift");
    const grindHash = "9".repeat(64);
    const grindFirst = batch(grindRef, [{...first, grindOptions:[{sourceGrindKeyHash:grindHash, displayName:"Крупный"}]}]);
    await store.recordBatch(grindFirst);
    const grindSecond = batch(grindRef, [{...second, grindOptions:[{sourceGrindKeyHash:grindHash, displayName:"Мелкий"}]}], 1, grindFirst.batchHash);
    let grindDriftRejected = false;
    try { await store.recordBatch(grindSecond); } catch { grindDriftRejected = true; }
    if (!grindDriftRejected || (await store.getSnapshot(grindRef))?.next_batch_number !== 1) throw new Error("generation grind identity drift was not atomic");

    const ordinalRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBB";
    await started(store, ordinalRef, "provider-ordinal-tamper");
    const ordinalBatch = batch(ordinalRef, [first]);
    await store.recordBatch(ordinalBatch);
    await adminClient.query("UPDATE catalog.snapshot_offers SET item_index=7 WHERE snapshot_ref=$1", [ordinalRef]);
    let ordinalTamperRejected = false;
    try { await store.complete(completed(ordinalRef, [ordinalBatch], [first])); }
    catch (error) { ordinalTamperRejected = error instanceof Error && /BATCH_DURABLE_ORDINAL_MISMATCH/u.test(error.message); }
    if (!ordinalTamperRejected) throw new Error("non-contiguous durable item ordinals were accepted");

    const countRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBC";
    await started(store, countRef, "provider-count-tamper");
    const countBatch = batch(countRef, [first]);
    await store.recordBatch(countBatch);
    await adminClient.query("INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url) VALUES($1,$2,NULL)", [countRef, "f".repeat(64)]);
    let durableCountTamperRejected = false;
    try { await store.complete(completed(countRef, [countBatch], [first])); }
    catch (error) { durableCountTamperRejected = error instanceof Error && /TERMINAL_COUNT_MISMATCH/u.test(error.message); }
    if (!durableCountTamperRejected) throw new Error("terminal trusted cached counters instead of durable rows");

    let permanentDdlDenied = false;
    await adminClient.query("SET ROLE coffee_catalog_import_rw");
    try { await adminClient.query("CREATE TABLE catalog.forbidden(value text)"); }
    catch { permanentDdlDenied = true; }
    finally { await adminClient.query("RESET ROLE"); }
    if (!permanentDdlDenied) throw new Error("import role acquired permanent DDL");

    // One full generation ties bounded counters to reconciled importer batches,
    // not direct store calls or failed COPY attempts.
    const metricsRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FBF";
    const metricsBatch = batch(metricsRef, [second]);
    await runCatalogImport({telemetry,store,supplierRef,snapshotRef:metricsRef,signal:new AbortController().signal,
      context:{correlationId:"11111111-1111-4111-8111-111111111111"},
      exportCatalog:async function* () {
        yield {streamVersion:"1",recordType:"snapshot-started",snapshotRef:metricsRef,supplierRef,providerSnapshotRef:"fixture-metrics",startedAt:"2026-09-21T00:00:00Z"};
        yield metricsBatch;
        yield completed(metricsRef,[metricsBatch],[second]);
      }});
    const httpCopyShutdown=await httpCopyShutdownProof(database,adminClient);
    const active=(await adminClient.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename='coffee_catalog_import_rw' AND (state LIKE 'idle in transaction%' OR (state='active' AND query ~ '^COPY'))")).rows[0].count;
    assert.equal(active,0);
    return {skipped:false, noActiveCopyOrTransaction:active === 0, migrationProof,midCopyAbort,copySourceFailure,httpCopyShutdown,postMergeRollback,knownRollback,acl,foreignConnect,stateMatrix,telemetry:{spans:Object.fromEntries(spans),metrics:telemetry.render()}, migrations:firstApply.length === 3 && secondApply.length === 0 ? "idempotent" : "invalid", copy:"bounded-temp-copy",
      reconstruction:{items:reconstructed, batchHash:record.batchHash, contentHash:terminal.contentHash},
      state:row.state, optionals:{missingGrinds:!("grindOptions" in reconstructed[0]), emptyGrinds:Array.isArray(reconstructed[1].grindOptions)},
      replayConflictRejected, receivingReplayConflictRejected, terminalConflictRejected, terminalTimestampConflictRejected,
      semanticDriftRejected, grindDriftRejected, tamperRejected:tamperDetected,
      ordinalTamperRejected, durableCountTamperRejected,
      rollbackAtomic:partial.rows[0].count === 0, grantsLeastPrivilege:permanentDdlDenied};
  }); } finally {trace.disable();}
}
