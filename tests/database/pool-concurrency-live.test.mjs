import assert from "node:assert/strict";
import test from "node:test";
import {createDatabase,withTransaction} from "../../packages/platform-database/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const pool = {max:2,checkoutTimeoutMs:2_000,lockTimeoutMs:2_000,interactiveStatementTimeoutMs:5_000,
  backgroundStatementTimeoutMs:10_000,terminalTimeoutMs:3_000,transactionTimeoutMs:20_000,
  idleTimeoutMs:30_000,maxLifetimeMs:1_800_000};

void test("two simultaneous checkouts inside cap succeed, third fails closed without a pg wait queue",{
  timeout:120_000,skip:process.env.COFFEE_DB_LIVE_PROOF!=="1" ? "disposable PostgreSQL required" : false,
},async t=>{
  await withCatalogPostgres(async({port,databaseName,runtimePassword})=>{
    const importDb=createDatabase({owner:"catalog-supplier-sync",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user:"coffee_catalog_import_rw",password:runtimePassword,
      ssl:false,pool,shutdownGraceMs:40_000});
    await importDb.resource.start(new AbortController().signal);
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    let entered=0;
    let bothEntered;
    const admitted=new Promise(resolve=>{bothEntered=resolve;});
    const hold=()=>withTransaction(importDb,{mode:"interactive"},async()=>{
      if(++entered===2) bothEntered();
      await gate;
      return "committed";
    })
      .then(value=>({value}),error=>({error}));
    try {
      const first=hold();
      const second=hold();
      const admission=await Promise.race([admitted.then(()=>"both"),second.then(outcome=>outcome),
        new Promise(resolve=>setTimeout(()=>resolve("waiting"),2_000))]);
      if (admission?.error) throw admission.error;
      assert.equal(admission,"both","second checkout did not enter before its deadline");
      assert.equal(entered,2,`two in-cap transactions should enter, observed ${entered}; ${JSON.stringify(importDb.metrics())}`);
      assert.equal(importDb.metrics().active,2);
      await assert.rejects(()=>withTransaction(importDb,{mode:"interactive"},async()=>"should-not-enter"),error=>error.code==="DB_POOL_EXHAUSTED");
      assert.equal(importDb.metrics().waiting,0);
      t.diagnostic(JSON.stringify({inCap:entered,deniedAtCap:true,metrics:importDb.metrics()}));
      release();
      assert.deepEqual(await Promise.all([first,second]),[{value:"committed"},{value:"committed"}]);
    } finally {release();await importDb.resource.stop(AbortSignal.timeout(5_000));}
  });
});
