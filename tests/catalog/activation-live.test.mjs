import assert from "node:assert/strict";
import test from "node:test";
import {Client} from "pg";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {catalogBatchBytes, catalogBatchHash, catalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {createSqlOutboxStore,relayOutboxBatch} from "../../packages/platform-outbox/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";
import {createCatalogActivationStore} from "../../apps/catalog-activation-worker/dist/activation-store.js";

const SUPPLIER = "sup_00000000000000000000000001";
const P = "1".repeat(64);
const V = "2".repeat(64);
const O = "3".repeat(64);
const pool = {max:4, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000};

async function stage(admin, snapshotRef, price = "123", status = "Available", grindOptions = []) {
  const item = {sourceProductKeyHash:P, sourceVariantKeyHash:V, sourceOfferKeyHash:O,
    displayName:"Кофе", unit:"piece", supplierUnitMinor:price, currency:"RUB",
    availability:status, imageUrl:null, supplierPromotions:[],
    ...(grindOptions === null ? {} : {grindOptions}), sourceIdentityScheme:"hmac-sha256-v1"};
  const batchHash = catalogBatchHash([item]);
  await admin.query(`INSERT INTO catalog.supplier_snapshots
    (snapshot_ref,supplier_ref,provider_snapshot_ref,state,next_batch_number,declared_batch_count,
     declared_product_count,declared_variant_count,declared_offer_count,received_batch_count,
     received_product_count,received_variant_count,received_offer_count,content_hash,received_at)
    VALUES ($1,$2,'provider-ref','Received',1,1,1,1,1,1,1,1,1,$3,clock_timestamp())`,
    [snapshotRef,SUPPLIER,catalogContentHash([batchHash])]);
  await admin.query(`INSERT INTO catalog.snapshot_batches
    (snapshot_ref,batch_number,offer_count,uncompressed_bytes,batch_hash) VALUES($1,0,1,$2,$3)`,
    [snapshotRef,catalogBatchBytes([item]),batchHash]);
  await admin.query(`INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url) VALUES($1,$2,NULL)`, [snapshotRef,P]);
  await admin.query(`INSERT INTO catalog.snapshot_variants(snapshot_ref,source_variant_key_hash,source_product_key_hash,display_name,unit)
    VALUES($1,$2,$3,'Кофе','piece')`, [snapshotRef,V,P]);
  await admin.query(`INSERT INTO catalog.snapshot_offers(snapshot_ref,source_offer_key_hash,source_variant_key_hash,batch_number,item_index,supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme)
    VALUES($1,$2,$3,0,0,$4,'RUB','[]',$5::jsonb,'hmac-sha256-v1')`, [snapshotRef,O,V,price,grindOptions === null ? null : JSON.stringify(grindOptions)]);
  await admin.query(`INSERT INTO catalog.snapshot_availability(snapshot_ref,source_offer_key_hash,availability) VALUES($1,$2,$3)`, [snapshotRef,O,status]);
}

async function stageEmpty(admin,snapshotRef) {
  await admin.query(`INSERT INTO catalog.supplier_snapshots
    (snapshot_ref,supplier_ref,provider_snapshot_ref,state,next_batch_number,declared_batch_count,
     declared_product_count,declared_variant_count,declared_offer_count,received_batch_count,
     received_product_count,received_variant_count,received_offer_count,content_hash,received_at)
    VALUES($1,$2,'provider-empty','Received',0,0,0,0,0,0,0,0,0,$3,clock_timestamp())`,
    [snapshotRef,SUPPLIER,catalogContentHash([])]);
}

void test("activation commits pointer and Outbox together; reuses refs; rejects corrupt snapshot", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  const result = await withCatalogPostgres(async ({adminClient,port,databaseName}) => {
    await adminClient.query("CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'");
    await adminClient.query("CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'");
    for (const name of ["0004_catalog_active","0005_catalog_identity","0006_catalog_outbox","0007_catalog_grants"]) {
      await adminClient.query(await readFile(resolve("apps/catalog-service/migrations",`${name}.sql`),"utf8"));
    }
    const database = createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user:"coffee_catalog_activate_rw",password:"activate-proof",ssl:false,pool,shutdownGraceMs:40_000});
    await database.resource.start(new AbortController().signal);
    try {return await proveActivation(database,adminClient,port,databaseName);} finally {await database.resource.stop(AbortSignal.timeout(5_000));}
  });
  assert.deepEqual({activated:result.activated,rejected:result.rejected,events:result.events},{activated:7,rejected:1,events:11});
});

void test("immutable binding keeps the earliest snapshot when two generations register the same offer out of order", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  await withCatalogPostgres(async ({adminClient,port,databaseName}) => {
    await adminClient.query("CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'");
    await adminClient.query("CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'");
    for (const name of ["0004_catalog_active","0005_catalog_identity","0006_catalog_outbox","0007_catalog_grants"])
      await adminClient.query(await readFile(resolve("apps/catalog-service/migrations",`${name}.sql`),"utf8"));
    const first="snp_00000000000000000000000021";
    const second="snp_00000000000000000000000022";
    await stage(adminClient,first);
    await stage(adminClient,second);
    const database=createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user:"coffee_catalog_activate_rw",password:"activate-proof",ssl:false,pool,shutdownGraceMs:40_000});
    await database.resource.start(new AbortController().signal);
    try {
      const store=createCatalogActivationStore(database);
      let registered;
      const bind=async request => {
        registered ??= {...request,firstSnapshotRef:request.snapshotRef,state:"Bound"};
        assert.equal(request.offerRef,registered.offerRef);
        return registered;
      };
      let enterFirst,releaseFirst;
      const firstEntered=new Promise(resolve => {enterFirst=resolve;});
      const firstGate=new Promise(resolve => {releaseFirst=resolve;});
      const pendingFirst=store.runSnapshot(first,async request => {
        enterFirst(); await firstGate; return bind(request);
      });
      await firstEntered;
      let firstResult;
      let secondResult;
      try { secondResult=await store.runSnapshot(second,bind); }
      finally { releaseFirst(); firstResult=await pendingFirst.catch(error => error); }
      assert.equal(registered.firstSnapshotRef,first);
      assert.deepEqual(secondResult,{kind:"activated",snapshotRef:second,snapshotRevision:"1"});
      assert.deepEqual(firstResult,{kind:"superseded",snapshotRef:first});
      assert.deepEqual((await adminClient.query("SELECT first_snapshot_ref FROM catalog.offer_binding_acks WHERE snapshot_ref=$1",[second])).rows,
        [{first_snapshot_ref:first}]);
    } finally {await database.resource.stop(AbortSignal.timeout(5_000));}
  });
});

void test("API role reads active grind options after activation and after a missing-offer snapshot", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  await withCatalogPostgres(async ({adminClient,port,databaseName}) => {
    await adminClient.query("CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'");
    await adminClient.query("CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'");
    for (const name of ["0004_catalog_active","0005_catalog_identity","0006_catalog_outbox","0007_catalog_grants"])
      await adminClient.query(await readFile(resolve("apps/catalog-service/migrations",`${name}.sql`),"utf8"));
    const first="snp_00000000000000000000000031";
    const empty="snp_00000000000000000000000032";
    const noOptions="snp_00000000000000000000000033";
    const absentOptions="snp_00000000000000000000000034";
    const grindOptions=[{sourceGrindKeyHash:"4".repeat(64),displayName:"Эспрессо"}];
    await stage(adminClient,first,"123","Available",grindOptions);
    const database=createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user:"coffee_catalog_activate_rw",password:"activate-proof",ssl:false,pool,shutdownGraceMs:40_000});
    const api=new Client({host:"127.0.0.1",port,user:"coffee_catalog_api_ro",password:"api-proof",database:databaseName});
    await database.resource.start(new AbortController().signal);
    try {
      await api.connect();
      const store=createCatalogActivationStore(database);
      const bind=async request => ({...request,firstSnapshotRef:first,state:"Bound"});
      assert.equal((await store.runSnapshot(first,bind)).kind,"activated");
      assert.deepEqual((await api.query("SELECT grind_options FROM catalog.active_variants")).rows,[{grind_options:grindOptions}]);
      await stageEmpty(adminClient,empty);
      assert.equal((await store.runSnapshot(empty,async()=>{throw new Error("empty generation must not bind");})).kind,"activated");
      assert.deepEqual((await api.query("SELECT grind_options FROM catalog.active_variants")).rows,[{grind_options:grindOptions}]);
      await stage(adminClient,noOptions);
      assert.equal((await store.runSnapshot(noOptions,bind)).kind,"activated");
      assert.deepEqual((await api.query("SELECT grind_options FROM catalog.active_variants")).rows,[{grind_options:[]}]);
      await stage(adminClient,absentOptions,"123","Available",null);
      assert.equal((await store.runSnapshot(absentOptions,bind)).kind,"activated");
      assert.deepEqual((await api.query("SELECT grind_options FROM catalog.active_variants")).rows,[{grind_options:null}]);
    } finally {await api.end().catch(()=>{}); await database.resource.stop(AbortSignal.timeout(5_000));}
  });
});

async function proveActivation(database, admin,port,databaseName) {
  const first = "snp_00000000000000000000000011";
  await stage(admin,first);
  const bind = async request => ({...request,firstSnapshotRef:first,state:"Bound"});
  const store = createCatalogActivationStore(database);
  let enteredFirst,releaseFirst;
  const firstEntered=new Promise(resolve=>{enteredFirst=resolve;});
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const slowWorker=store.runSnapshot(first,async request=>{
    enteredFirst(); await firstGate; return {...request,firstSnapshotRef:first,state:"Bound"};
  });
  await firstEntered;
  try {assert.deepEqual(await store.runSnapshot(first,bind),{kind:"activated",snapshotRef:first,snapshotRevision:"1"});}
  finally {releaseFirst();}
  assert.deepEqual(await slowWorker,{kind:"idle"});
  assert.equal((await admin.query("SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true")).rows[0].active_snapshot_ref,first);
  const firstOffer = (await admin.query("SELECT offer_ref FROM catalog.offer_mappings WHERE snapshot_ref=$1",[first])).rows[0].offer_ref;
  assert.match(firstOffer,/^off_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,2);
  assert.deepEqual(await store.runSnapshot(first,bind), {kind:"activated",snapshotRef:first,snapshotRevision:"1"});
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,2);
  const second = "snp_00000000000000000000000012";
  await stage(admin,second,"456");
  await assert.rejects(store.runOnce(async request => ({...request,firstSnapshotRef:second,state:"Bound"})),
    {code:"ACTIVATION_BINDING_MISMATCH"});
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.offer_binding_acks WHERE snapshot_ref=$1",[second])).rows[0].n,0);
  assert.equal((await admin.query("SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true")).rows[0].active_snapshot_ref,first);
  assert.deepEqual(await store.runOnce(bind), {kind:"activated",snapshotRef:second,snapshotRevision:"2"});
  assert.equal((await admin.query("SELECT offer_ref FROM catalog.offer_mappings WHERE snapshot_ref=$1",[second])).rows[0].offer_ref,firstOffer);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,3);
  assert.equal((await admin.query("SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",[first])).rows[0].state,"Superseded");
  const third = "snp_00000000000000000000000013";
  await stage(admin,third);
  await admin.query("REVOKE INSERT ON catalog.outbox_messages FROM coffee_catalog_activate_rw");
  try {
    await assert.rejects(store.runOnce(bind), error => error.code==="DB_QUERY_FAILED" && error.sqlState==="42501");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.products WHERE snapshot_ref=$1",[third])).rows[0].n,0);
    assert.equal((await admin.query("SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true")).rows[0].active_snapshot_ref,second);
    assert.equal((await admin.query("SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",[third])).rows[0].state,"Received");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,3);
  } finally {
    await admin.query("GRANT INSERT ON catalog.outbox_messages TO coffee_catalog_activate_rw");
  }
  assert.deepEqual(await store.runOnce(async () => {throw new Error("ack replay must not bind");}),
    {kind:"activated",snapshotRef:third,snapshotRevision:"3"});
  const older="snp_00000000000000000000000014";
  const newer="snp_00000000000000000000000015";
  await stage(admin,older);
  await stage(admin,newer);
  let enterOld,releaseOld;
  const oldEntered=new Promise(resolve => {enterOld=resolve;});
  const oldGate=new Promise(resolve => {releaseOld=resolve;});
  const oldWork=store.runSnapshot(older,async request => {
    enterOld(); await oldGate; return {...request,firstSnapshotRef:first,state:"Bound"};
  });
  await oldEntered;
  try {
    assert.deepEqual(await store.runSnapshot(newer,bind),{kind:"activated",snapshotRef:newer,snapshotRevision:"4"});
  } finally { releaseOld(); }
  assert.deepEqual(await oldWork,{kind:"superseded",snapshotRef:older});
  assert.equal((await admin.query("SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true")).rows[0].active_snapshot_ref,newer);
  assert.equal((await admin.query("SELECT state FROM catalog.supplier_snapshots WHERE snapshot_ref=$1",[older])).rows[0].state,"Superseded");
  const bad = "snp_00000000000000000000000016";
  await stage(admin,bad);
  await admin.query("DELETE FROM catalog.snapshot_availability WHERE snapshot_ref=$1",[bad]);
  await admin.query("DELETE FROM catalog.snapshot_offers WHERE snapshot_ref=$1",[bad]);
  await admin.query("DELETE FROM catalog.snapshot_batches WHERE snapshot_ref=$1",[bad]);
  assert.deepEqual(await store.runOnce(bind), {kind:"rejected",snapshotRef:bad,code:"ACTIVATION_BATCH_SEQUENCE_MISMATCH"});
  assert.equal((await admin.query("SELECT active_snapshot_ref FROM catalog.catalog_state WHERE id=true")).rows[0].active_snapshot_ref,newer);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,5);
  const empty="snp_00000000000000000000000017";
  await stageEmpty(admin,empty);
  assert.deepEqual(await store.runOnce(bind),{kind:"activated",snapshotRef:empty,snapshotRevision:"5"});
  const absent=(await admin.query("SELECT mapping_state,offer_ref,mapping_revision FROM catalog.offer_mappings WHERE snapshot_ref=$1",[empty])).rows[0];
  assert.deepEqual(absent,{mapping_state:"Missing",offer_ref:null,mapping_revision:"2"});
  const returning="snp_00000000000000000000000018";
  await stage(admin,returning);
  assert.deepEqual(await store.runOnce(bind),{kind:"activated",snapshotRef:returning,snapshotRevision:"6"});
  const returned=(await admin.query("SELECT mapping_state,offer_ref,mapping_revision FROM catalog.offer_mappings WHERE snapshot_ref=$1",[returning])).rows[0];
  assert.deepEqual(returned,{mapping_state:"Active",offer_ref:firstOffer,mapping_revision:"3"});
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,9);
  const stopped="snp_00000000000000000000000019";
  await stage(admin,stopped,"123","Stopped");
  assert.deepEqual(await store.runOnce(bind),{kind:"activated",snapshotRef:stopped,snapshotRevision:"7"});
  assert.deepEqual((await admin.query("SELECT mapping_state,offer_ref FROM catalog.offer_mappings WHERE snapshot_ref=$1",[stopped])).rows[0],
    {mapping_state:"Stopped",offer_ref:null});
  assert.equal((await admin.query("SELECT state FROM catalog.source_identities WHERE supplier_ref=$1 AND entity_type='offer' AND source_identity_hash=$2",[SUPPLIER,O])).rows[0].state,"Stopped");
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages")).rows[0].n,11);
  await proveDurableRelay(admin,port,databaseName);
  return {activated:7,rejected:1,events:11};
}

async function proveDurableRelay(admin,port,databaseName) {
  const expected=(await admin.query("SELECT message_id FROM catalog.outbox_messages ORDER BY message_id")).rows.map(row=>row.message_id);
  const fresh=createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
    host:"127.0.0.1",port,user:"coffee_catalog_activate_rw",password:"activate-proof",ssl:false,pool,shutdownGraceMs:40_000});
  await fresh.resource.start(new AbortController().signal);
  try {
    const relay=createSqlOutboxStore(fresh,{schema:"catalog"});
    const sent=[];
    const claims=[];
    for (let attempt=0;attempt<=expected.length;attempt++) {
      const result=await relayOutboxBatch(relay,fresh,async claim=>{
        claims.push(claim);
        sent.push(claim.message.messageId);
        return {kind:"ack"};
      },{nowMs:Date.now(),leaseOwner:"restarted-catalog-worker",policy:{leaseMs:10_000,sendTimeoutMs:2_000,
        maxInFlight:1,retry:{baseMs:100,maxMs:1_000,maxAttempts:3}}});
      if (result.unknown!==0) {
        // A finalization response can be unknown after commit; reconcile by durable ID.
        const rows=(await admin.query("SELECT message_id,state FROM catalog.outbox_messages WHERE message_id=ANY($1::text[])",
          [claims.map(claim=>claim.message.messageId)])).rows;
        assert.equal(rows.length,claims.length);
        assert.ok(rows.every(row=>row.state==="Published"),"unknown relay outcome must be recovered, not assumed published");
      }
      if (result.claimed===0) break;
    }
    assert.deepEqual(sent.sort((left,right)=>left.localeCompare(right)),expected);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM catalog.outbox_messages WHERE state='Published'")).rows[0].n,11);
  } finally { await fresh.resource.stop(AbortSignal.timeout(5_000)); }
}
