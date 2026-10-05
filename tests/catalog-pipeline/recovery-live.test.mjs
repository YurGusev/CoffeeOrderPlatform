import assert from "node:assert/strict";
import test from "node:test";
import {generateKeyPairSync} from "node:crypto";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {catalogBatchBytes,catalogBatchHash,catalogContentHash} from "../../packages/contracts/aroma-v1/dist/index.js";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {createCatalogActivationStore} from "../../apps/catalog-activation-worker/dist/infrastructure/activation-store.js";
import {CatalogStore} from "../../apps/catalog-service/dist/infrastructure/postgres/catalog-store.js";
import {searchCatalog,createCatalogCursorSigner} from "../../apps/catalog-service/dist/application/search-catalog.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";
import {runCatalogRecoveryProof} from "../../scripts/catalog-recovery-live-proof.mjs";


const supplier="sup_00000000000000000000000001";
const pool={max:4,checkoutTimeoutMs:2_000,lockTimeoutMs:2_000,interactiveStatementTimeoutMs:5_000,
  backgroundStatementTimeoutMs:10_000,terminalTimeoutMs:3_000,transactionTimeoutMs:20_000,
  idleTimeoutMs:30_000,maxLifetimeMs:1_800_000};

void test("importer is SIGKILLed after a durable batch; a new process recovers before export",{
  timeout:180_000,skip:process.env.COFFEE_DB_LIVE_PROOF!=="1"?"disposable PostgreSQL required":false,
},async()=>{
  const proof=await runCatalogRecoveryProof();
  assert.equal(proof.skipped,false);
  assert.equal(proof.restart.processKilled,"SIGKILL");
  assert.notEqual(proof.restart.firstPid,proof.restart.secondPid);
  assert.equal(proof.restart.oldStateBeforeExport,"Rejected");
  assert.equal(proof.restart.newSnapshotRef,true);
  assert.equal(proof.restart.newState,"Received");
  assert.equal(proof.restart.startupReadyStatus,503);
  assert.equal(proof.restart.recoveredReadyStatus,200);
  assert.equal(proof.restart.transport,"real-mtls-internal-client");
});

async function stage(admin,ref,displayName,price) {
  const items=[
    {p:"1",v:"2",o:"3",name:`${displayName} A`},
    {p:"4",v:"5",o:"6",name:`${displayName} B`},
  ].map(value=>({sourceProductKeyHash:value.p.repeat(64),sourceVariantKeyHash:value.v.repeat(64),sourceOfferKeyHash:value.o.repeat(64),
    displayName:value.name,unit:"piece",supplierUnitMinor:price,currency:"RUB",availability:"Available",imageUrl:null,
    supplierPromotions:[],grindOptions:[],sourceIdentityScheme:"hmac-sha256-v1"}));
  const hash=catalogBatchHash(items);
  await admin.query(`INSERT INTO catalog.supplier_snapshots(snapshot_ref,supplier_ref,provider_snapshot_ref,state,next_batch_number,
    declared_batch_count,declared_product_count,declared_variant_count,declared_offer_count,received_batch_count,
    received_product_count,received_variant_count,received_offer_count,content_hash,received_at)
    VALUES($1,$2,$3,'Received',1,1,2,2,2,1,2,2,2,$4,clock_timestamp())`,
    [ref,supplier,`provider-${ref}`,catalogContentHash([hash])]);
  await admin.query("INSERT INTO catalog.snapshot_batches(snapshot_ref,batch_number,offer_count,uncompressed_bytes,batch_hash) VALUES($1,0,2,$2,$3)",
    [ref,catalogBatchBytes(items),hash]);
  for(const [index,item] of items.entries()) {
    await admin.query("INSERT INTO catalog.snapshot_products(snapshot_ref,source_product_key_hash,image_url) VALUES($1,$2,NULL)",[ref,item.sourceProductKeyHash]);
    await admin.query("INSERT INTO catalog.snapshot_variants(snapshot_ref,source_variant_key_hash,source_product_key_hash,display_name,unit) VALUES($1,$2,$3,$4,'piece')",
      [ref,item.sourceVariantKeyHash,item.sourceProductKeyHash,item.displayName]);
    await admin.query(`INSERT INTO catalog.snapshot_offers(snapshot_ref,source_offer_key_hash,source_variant_key_hash,batch_number,item_index,
      supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme) VALUES($1,$2,$3,0,$4,$5,'RUB','[]','[]','hmac-sha256-v1')`,
      [ref,item.sourceOfferKeyHash,item.sourceVariantKeyHash,index,price]);
    await admin.query("INSERT INTO catalog.snapshot_availability(snapshot_ref,source_offer_key_hash,availability) VALUES($1,$2,'Available')",
      [ref,item.sourceOfferKeyHash]);
  }
}

void test("signed cursor invalidates after activation and concurrent reads never mix active revisions",{
  timeout:180_000,skip:process.env.COFFEE_DB_LIVE_PROOF!=="1"?"disposable PostgreSQL required":false,
},async t=>withCatalogPostgres(async({adminClient,port,databaseName})=>{
  await adminClient.query("CREATE ROLE coffee_catalog_activate_rw LOGIN PASSWORD 'activate-proof'");
  await adminClient.query("CREATE ROLE coffee_catalog_api_ro LOGIN PASSWORD 'api-proof'");
  for(const name of ["0004_catalog_active","0005_catalog_identity","0006_catalog_outbox","0007_catalog_grants","0008_catalog_active_read","0009_active_snapshot_freshness"])
    await adminClient.query(await readFile(resolve("apps/catalog-service/migrations",`${name}.sql`),"utf8"));
  const first="snp_00000000000000000000000041",second="snp_00000000000000000000000042",third="snp_00000000000000000000000043";
  await stage(adminClient,first,"Revision one coffee","111");
  await stage(adminClient,second,"Revision two coffee","222");
  await stage(adminClient,third,"Revision three coffee","333");
  const activation=createDatabase({owner:"catalog-activation-worker",database:databaseName,allowedDatabase:databaseName,
    host:"127.0.0.1",port,user:"coffee_catalog_activate_rw",password:"activate-proof",ssl:false,pool,shutdownGraceMs:40_000});
  const api=createDatabase({owner:"catalog-service",database:databaseName,allowedDatabase:databaseName,
    host:"127.0.0.1",port,user:"coffee_catalog_api_ro",password:"api-proof",ssl:false,pool:{...pool,max:32},shutdownGraceMs:40_000});
  await activation.resource.start(new AbortController().signal);
  await api.resource.start(new AbortController().signal);
  try {
    const activate=createCatalogActivationStore(activation);
    const catalog=new CatalogStore(api);
    const {privateKey,publicKey}=generateKeyPairSync("ed25519");
    const signer=createCatalogCursorSigner(privateKey,publicKey);
    const bind=async request=>({...request,firstSnapshotRef:first,state:"Bound"});
    assert.deepEqual(await activate.runSnapshot(first,bind),{kind:"activated",snapshotRef:first,snapshotRevision:"1"});
    const initial=await searchCatalog(catalog,{query:"coffee",limit:1},signer);
    assert.equal(initial.snapshotRevision,"1");
    assert.ok(initial.nextCursor,"fixture must issue a real signed continuation cursor");
    assert.deepEqual(await activate.runSnapshot(second,async request=>({...request,firstSnapshotRef:first,state:"Bound"})),
      {kind:"activated",snapshotRef:second,snapshotRevision:"2"});
    await assert.rejects(searchCatalog(catalog,{query:"coffee",limit:1,cursor:initial.nextCursor},signer),error=>error.code==="INVALID_CURSOR");

    await adminClient.query("CREATE FUNCTION catalog.test_activation_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$");
    await adminClient.query("CREATE TRIGGER test_activation_pause BEFORE UPDATE OF active_snapshot_ref ON catalog.catalog_state FOR EACH ROW EXECUTE FUNCTION catalog.test_activation_pause()");
    t.diagnostic(`pool before concurrent reads: ${JSON.stringify(api.metrics())}`);
    const concurrentReads=Array.from({length:2},()=>searchCatalog(catalog,{query:"coffee",limit:1},signer));
    const [duringPages,activationResult]=await Promise.all([
      Promise.all(concurrentReads),
      activate.runSnapshot(third,async request=>({...request,firstSnapshotRef:first,state:"Bound"})),
    ]);
    assert.deepEqual(activationResult,{kind:"activated",snapshotRef:third,snapshotRevision:"3"});
    const afterPage=await searchCatalog(catalog,{query:"coffee",limit:1},signer);
    for(const page of [...duringPages,afterPage]) {
      assert.ok(["2","3"].includes(page.snapshotRevision));
      const expected=page.snapshotRevision==="2"?"Revision two coffee A":"Revision three coffee A";
      assert.equal(page.items[0].displayName,expected,"each page must match its single reported active revision");
    }
    assert.ok(duringPages.every(page=>page.snapshotRevision==="2"),"reads during the delayed activation see the complete old generation");
    assert.equal(afterPage.snapshotRevision,"3","a read after commit sees the complete new generation");
  } finally {
    await api.resource.stop(AbortSignal.timeout(5_000));
    await activation.resource.stop(AbortSignal.timeout(5_000));
  }
}));
