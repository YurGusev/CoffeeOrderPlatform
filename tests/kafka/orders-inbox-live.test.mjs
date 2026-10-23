import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import {setTimeout as sleep} from "node:timers/promises";
import test from "node:test";
import pg, {Client} from "pg";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {defineStatement} from "../../packages/platform-database/dist/owner.js";
import {createSqlInboxStore,InboxProcessingError} from "../../packages/platform-inbox/dist/index.js";
import {createSqlOutboxStore,relayOutboxBatch} from "../../packages/platform-outbox/dist/index.js";
import {canonicalJson,canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {parseEnvelope, processKafkaRecord} from "../../packages/platform-kafka-runtime/dist/index.js";
import {metrics} from "@opentelemetry/api";

const roles=["coffee_orders_service_rw","coffee_orders_prepare_rw","coffee_orders_observer_rw","coffee_orders_convergence_rw"];
const migrations=["0001_create_orders","0002_create_order_items","0003_create_order_history","0004_create_order_contributions","0005_create_orders_idempotency","0006_create_orders_outbox","0007_order_grind_selection","0008_create_orders_inbox","0009_create_catalog_mapping_projection","0010_create_cart_desired","0011_create_cart_observed","0012_create_convergence_attempts","0013_create_convergence_leases","0014_create_mutation_reservations","0015_create_order_aroma_projections","0016_create_aroma_work_schedules"];
const pool={max:4,checkoutTimeoutMs:2000,lockTimeoutMs:1000,interactiveStatementTimeoutMs:5000,backgroundStatementTimeoutMs:10000,terminalTimeoutMs:3000,transactionTimeoutMs:20000,idleTimeoutMs:30000,maxLifetimeMs:1800000};
const group="orders-aroma-preparation-v1";
const otherGroup="aroma-convergence-v1";
const ORDER="ord_00000000000000000000000001";
const envelope=(id="original")=>({envelopeVersion:"1",messageId:id,messageType:"OrderConfirmed.v1",occurredAt:"2026-10-01T00:00:00Z",producer:"orders-service",correlationId:"inbox-proof",causationId:null,traceparent:"00-11111111111111111111111111111111-2222222222222222-01",aggregate:{type:"Order",ref:ORDER,version:"1"},payload:{orderRef:ORDER,orderVersion:"1"}});
const record=(value=envelope(),offset="1")=>({topic:"coffee.orders.lifecycle.v1",partition:0,offset,key:ORDER,value,headers:{}});
const message=e=>({messageId:e.messageId,messageType:e.messageType,receivedAt:e.occurredAt,payloadHash:canonicalRequestHash(e),payload:e});
const live={timeout:180000,skip:process.env.COFFEE_DB_LIVE_PROOF!=="1"?"set COFFEE_DB_LIVE_PROOF=1":false};
const metricMeasurements=[];
const observableCallbacks=new Map();
assert.equal(metrics.setGlobalMeterProvider({getMeter(){return {
  createHistogram(name){return {record(value,attributes){metricMeasurements.push({name,value,attributes});}};},
  createObservableGauge(name){return {addCallback(callback){observableCallbacks.set(name,callback);}};},
};}}),true);

function observeGauge(name) {
  const samples=[];
  observableCallbacks.get(name)?.({observe(value,attributes){samples.push({value,attributes});}});
  return samples;
}

async function fixture(run) {
  const receipt=await withCatalogPostgres(async({adminClient,port})=>{
    const passwords=new Map();
    for(const role of ["coffee_orders_migrator",...roles]) {
      const password=randomBytes(24).toString("hex");passwords.set(role,password);
      await adminClient.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    await adminClient.query("CREATE DATABASE coffee_platform_orders OWNER coffee_orders_migrator");
    await adminClient.query("REVOKE ALL ON DATABASE coffee_platform_orders FROM PUBLIC");
    await adminClient.query(`GRANT CONNECT ON DATABASE coffee_platform_orders TO ${roles.join(",")}`);
    const migrator=new Client({host:"127.0.0.1",port,database:"coffee_platform_orders",user:"coffee_orders_migrator",password:passwords.get("coffee_orders_migrator"),ssl:false});
    const databases=[];
    await migrator.connect();
    try {
      await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      for(const id of migrations) await migrator.query(await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`,import.meta.url),"utf8"));
      // Synthetic owner effect only, no provider/network or invented domain refs.
      await migrator.query("CREATE TABLE orders.inbox_proof_effects(consumer_name text NOT NULL,message_id text NOT NULL,PRIMARY KEY(consumer_name,message_id))");
      await migrator.query(`GRANT SELECT,INSERT ON orders.inbox_proof_effects TO ${roles.slice(1).join(",")}`);
      const create=async role=>{
        const database=createDatabase({owner:"orders-inbox-proof",database:"coffee_platform_orders",allowedDatabase:"coffee_platform_orders",host:"127.0.0.1",port,user:role,password:passwords.get(role),ssl:false,pool,shutdownGraceMs:40000});
        databases.push(database);await database.resource.start(AbortSignal.timeout(5000));return database;
      };
      const preparation=await create("coffee_orders_prepare_rw");
      const convergence=await create("coffee_orders_convergence_rw");
      const read=sql=>migrator.query(sql);
      const insertEffect=db=>defineStatement(db,"INSERT INTO orders.inbox_proof_effects(consumer_name,message_id) VALUES($1,$2)");
      const options=(db,consumerName=group,handler)=>({runtime:consumerName===group?"orders-aroma-preparation":"aroma-convergence",groupId:consumerName,topics:["coffee.orders.lifecycle.v1"],binding:{processing:"durable",database:db,inbox:createSqlInboxStore(db,{schema:"orders",consumerName}),decode:value=>{
        assert.equal(value.messageType,"OrderConfirmed.v1");assert.equal(value.producer,"orders-service");
        assert.equal(value.aggregate?.type,"Order");assert.equal(value.aggregate?.ref,ORDER);assert.equal(value.aggregate?.version,"1");
        return parseEnvelope(value,payload=>{
        assert.deepEqual(Object.keys(payload).sort(),["orderRef","orderVersion"]);
        assert.equal(payload.orderRef,ORDER);assert.equal(payload.orderVersion,"1");return payload;
      });},handle:handler??(async(tx,e,source)=>{
        assert.equal(source.key,e.aggregate.ref);
        await insertEffect(db)(tx,[consumerName,e.messageId]);
      })},leaseMs:30000,maxMessageBytes:65536,signal:new AbortController().signal,commit:async()=>{}});
      await run({preparation,convergence,migrator,read,insertEffect,options,create});
      return {migrations:migrations.length};
    } finally {
      for(const db of databases.reverse()) await db.resource.stop(AbortSignal.timeout(40000));
      await migrator.end();
    }
  });
  assert.equal(receipt.cleanup.containerRemoved,true);
}

void test("Orders consumer Inbox persists full envelope and commits offset only after owner transaction",live,async()=>fixture(async({preparation,read,options})=>{
  metricMeasurements.length=0;
  const e={...envelope(),traceparent:"01-11111111111111111111111111111111-2222222222222222-01"};const opts=options(preparation);let commits=0;
  opts.commit=async()=>{
    commits++;
    const row=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
    assert.equal(row.state,"Processed");assert.equal(row.lease_owner,"");
    assert.equal(row.consumer_name,group);assert.equal(row.message_id,e.messageId);
    assert.equal(row.partition_key,e.aggregate.ref);assert.equal(row.owner_version,e.aggregate.version);assert.equal(row.schema_version,e.envelopeVersion);
    assert.deepEqual(row.envelope,e);assert.deepEqual(row.payload,e.payload);
    assert.equal(row.envelope_hash,canonicalRequestHash(e));assert.equal(row.payload_hash,canonicalRequestHash(e.payload));
    assert.equal(row.outcome,"Processed");assert.deepEqual(row.result,{kind:"Processed"});
    assert.ok(row.processed_at);assert.equal(row.quarantined_at,null);
    assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,1);
  };
  const connectDescriptor=Object.getOwnPropertyDescriptor(pg.Pool.prototype,"connect");
  const originalConnect=pg.Pool.prototype.connect;
  let signalCheckoutStarted;
  let releaseCheckout;
  const checkoutStarted=new Promise(resolve=>{signalCheckoutStarted=resolve;});
  const checkoutGate=new Promise(resolve=>{releaseCheckout=resolve;});
  let checkoutDelayed=false;
  try {
    pg.Pool.prototype.connect=async function(...args) {
      if(!checkoutDelayed&&this.options.database==="coffee_platform_orders"&&this.options.user==="coffee_orders_prepare_rw") {
        checkoutDelayed=true;
        signalCheckoutStarted();
        await checkoutGate;
      }
      return originalConnect.apply(this,args);
    };
    const processing=processKafkaRecord(record(e),opts);
    await checkoutStarted;
    await new Promise(resolve=>setTimeout(resolve,50));
    releaseCheckout();
    await processing;
  } finally {
    releaseCheckout();
    if(connectDescriptor)Object.defineProperty(pg.Pool.prototype,"connect",connectDescriptor);
    else delete pg.Pool.prototype.connect;
  }
  assert.equal(commits,1);
  const receivedAge=metricMeasurements.filter(sample=>sample.name==="messaging.inbox.received.age");
  assert.equal(receivedAge.length,1);
  assert.ok(receivedAge[0].value>=25,"Inbox age must include the controlled wait for owner DB checkout");
}));

void test("Outbox oldest age is current, scoped by configured topics and ignores terminal states",live,async()=>fixture(async({migrator,create})=>{
  metricMeasurements.length=0;
  const service=await create("coffee_orders_service_rw");
  const topic="coffee.orders.lifecycle.v1",otherTopic="coffee.orders.cart.v1",emptyTopic="coffee.orders.unused.v1",unknownTopic="coffee.other.v1";
  const nowMs=Date.parse("2026-10-14T00:00:00Z");
  await migrator.query("INSERT INTO orders.orders(order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref) VALUES($1,$2,1,'fixture','Active',$3,'fixture','fixture')",[ORDER,"cus_00000000000000000000000001","a".repeat(64)]);
  const rows=[
    ["age-pending",topic,"2026-10-10T00:00:00Z","Pending"],
    ["age-publishing",topic,"2026-10-11T00:00:00Z","Publishing"],
    ["age-published",topic,"2026-10-01T00:00:00Z","Published"],
    ["age-quarantined",topic,"2026-10-01T00:00:00Z","Quarantined"],
    ["age-other-topic",otherTopic,"2026-10-13T12:00:00Z","Pending"],
    ["age-unconfigured-topic",unknownTopic,"2026-10-01T00:00:00Z","Pending"],
  ];
  for(const [index,[id,destination,occurredAt,state]] of rows.entries()) {
    const payload={id};
    const envelope={envelopeVersion:"1",messageId:id,messageType:`AgeProof${index}`,occurredAt,producer:"orders-service",correlationId:`age-${index}`,causationId:null,traceparent:"00-11111111111111111111111111111111-2222222222222222-01",aggregate:{type:"Order",ref:ORDER,version:"1"},payload};
    const hash=canonicalRequestHash(envelope);
    await migrator.query(`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,state,lease_owner,lease_until,attempt,next_attempt_at,published_at,quarantined_at)
      VALUES($1,$2,$3,$4::varchar(30),$5,'1',$4::text,'1',$6,$7,$8::jsonb,$9::jsonb,$7,$10::timestamptz,$11,NULL,$12,$13::varchar(16),$14,clock_timestamp(),0,clock_timestamp()-interval '1 day',CASE WHEN $13::varchar(16)='Published' THEN clock_timestamp() END,CASE WHEN $13::varchar(16)='Quarantined' THEN clock_timestamp() END)`,
    [id,envelope.messageType,destination,ORDER,index+1,Buffer.from(canonicalJson(envelope)),hash,canonicalJson(envelope),canonicalJson(payload),occurredAt,envelope.correlationId,envelope.traceparent,state,state==="Publishing"?"age-proof":""]);
  }
  const store=createSqlOutboxStore(service,{schema:"orders",topics:[topic,otherTopic,emptyTopic]});
  const ages=await withTransaction(service,{mode:"background"},transaction=>store.oldestUnpublishedAgesMs(transaction,nowMs));
  assert.deepEqual(ages?.toSorted((left,right)=>left.topic.localeCompare(right.topic)),[{topic:otherTopic,ageMs:12*60*60*1000},{topic,ageMs:4*24*60*60*1000},{topic:emptyTopic,ageMs:0}]);
  assert.equal(Math.max(...(ages??[]).map(age=>age.ageMs)),4*24*60*60*1000);
  const unscoped=createSqlOutboxStore(service,{schema:"orders"});
  assert.equal(await withTransaction(service,{mode:"background"},transaction=>unscoped.oldestUnpublishedAgesMs(transaction,nowMs)),null);

  const firstRelay=await relayOutboxBatch(store,service,async()=>({kind:"ack"}),{nowMs:Date.now(),leaseOwner:"age-proof-relay",policy:{leaseMs:60_000,sendTimeoutMs:5_000,maxInFlight:1,retry:{baseMs:1,maxMs:10,maxAttempts:3}}});
  assert.equal(firstRelay.published,1);
  const expectedTopics=[emptyTopic,otherTopic,topic].toSorted();
  const gaugeDeadline=performance.now()+pool.transactionTimeoutMs;
  let gaugeSamples=[];
  while(performance.now()<gaugeDeadline) {
    gaugeSamples=observeGauge("messaging.outbox.oldest_unpublished.age");
    const actualTopics=gaugeSamples.map(sample=>sample.attributes["messaging.destination.name"]).toSorted((left,right)=>left.localeCompare(right));
    if(JSON.stringify(actualTopics)===JSON.stringify(expectedTopics))break;
    await sleep(Math.min(10,gaugeDeadline-performance.now()));
  }
  assert.deepEqual(gaugeSamples.map(sample=>sample.attributes["messaging.destination.name"]).toSorted((left,right)=>left.localeCompare(right)),expectedTopics,"background refresh records every configured topic before the database transaction deadline");
  assert.equal(gaugeSamples.find(sample=>sample.attributes["messaging.destination.name"]===emptyTopic)?.value,0);

  const failingAgeStore=new Proxy(store,{get(target,key){if(key==="oldestUnpublishedAgesMs")return async()=>{throw new Error("diagnostic query failed")};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value;}});
  const relay=await relayOutboxBatch(failingAgeStore,service,async()=>({kind:"ack"}),{nowMs:Date.now(),leaseOwner:"age-proof-relay",policy:{leaseMs:60_000,sendTimeoutMs:5_000,maxInFlight:1,retry:{baseMs:1,maxMs:10,maxAttempts:3}}});
  assert.equal(relay.published,1,"age query failure must not change the relay outcome");
  assert.deepEqual(observeGauge("messaging.outbox.oldest_unpublished.age"),[]);
}));

void test("same messageId is independent across consumers; metadata conflicts append source quarantine without terminal rewrite",live,async()=>fixture(async({preparation,convergence,read,options,migrator})=>{
  const e=envelope();let effects=0;let commits=0;
  const a=options(preparation);const handle=a.binding.handle;
  a.binding.handle=async(...args)=>{effects++;await handle(...args);};
  a.commit=async()=>{commits++;};
  await processKafkaRecord(record(e),a);
  const original=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
  await processKafkaRecord(record(e,"2"),a);
  assert.equal(effects,1);assert.equal(commits,2);
  await processKafkaRecord(record(e),options(convergence,otherGroup));
  assert.deepEqual((await read("SELECT consumer_name,message_id FROM orders.inbox_messages ORDER BY consumer_name")).rows,[{consumer_name:otherGroup,message_id:"original"},{consumer_name:group,message_id:"original"}]);
  assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,2);
  const changed={...e,correlationId:"different-metadata"};
  a.commit=async()=>{
    commits++;
    const row=(await read("SELECT * FROM orders.inbox_quarantine")).rows[0];
    assert.equal(row.consumer_name,group);assert.equal(row.message_id,e.messageId);assert.equal(row.message_type,e.messageType);
    assert.equal(row.partition_key,e.aggregate.ref);assert.equal(row.schema_version,e.envelopeVersion);
    assert.equal(row.reason,"MESSAGE_ID_PAYLOAD_CONFLICT");
    assert.equal(row.payload_hash,canonicalRequestHash(e.payload));assert.equal(row.envelope_hash,canonicalRequestHash(changed));
    assert.deepEqual(row.envelope,changed);assert.equal(row.offset,"3");
    assert.deepEqual((await read(`SELECT * FROM orders.inbox_messages WHERE consumer_name='${group}'`)).rows[0],original);
  };
  await processKafkaRecord(record(changed,"3"),a);
  await processKafkaRecord(record(changed,"3"),a);
  assert.equal(effects,1);assert.equal(commits,4);
  assert.equal((await read("SELECT * FROM orders.inbox_quarantine")).rowCount,1);
  await assert.rejects(migrator.query("UPDATE orders.inbox_messages SET outcome='Changed' WHERE state='Processed'"),{code:"23514"});
  await assert.rejects(migrator.query("DELETE FROM orders.inbox_messages"),{code:"23514"});
  await assert.rejects(migrator.query("UPDATE orders.inbox_quarantine SET reason='changed'"),{code:"23514"});
}));

const tx=(database,handler)=>withTransaction(database,{mode:"background",signal:AbortSignal.timeout(10000)},handler);

void test("handler rollback never commits offset or effect; offset failure replay is effect-free",live,async()=>fixture(async({preparation,read,options,insertEffect})=>{
  const e=envelope("rollback");let commits=0;
  const failed=options(preparation,group,async(transaction,event)=>{
    await insertEffect(preparation)(transaction,[group,event.messageId]);throw new Error("synthetic transient");
  });
  failed.commit=async()=>{commits++;};
  await assert.rejects(processKafkaRecord(record(e),failed),/synthetic transient/);
  assert.equal(commits,0);
  assert.equal((await read("SELECT * FROM orders.inbox_messages")).rowCount,0);
  assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,0);
  const retry=options(preparation);
  retry.commit=async()=>{throw new Error("synthetic offset ack lost");};
  await assert.rejects(processKafkaRecord(record(e),retry),{code:"OFFSET_COMMIT_OUTCOME_UNKNOWN"});
  assert.equal((await read("SELECT * FROM orders.inbox_messages WHERE state='Processed'")).rowCount,1);
  let replayEffects=0;
  const replay=options(preparation,group,async()=>{replayEffects++;});replay.commit=async()=>{commits++;};
  await processKafkaRecord(record(e),replay);
  assert.equal(replayEffects,0);assert.equal(commits,1);
  assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,1);
}));

void test("permanent owner rejection rolls back partial effects before durable quarantine and offset commit",live,async()=>fixture(async({preparation,read,options,insertEffect})=>{
  const e=envelope("permanent");let commits=0;let handlers=0;
  const opts=options(preparation,group,async(transaction,event)=>{
    handlers++;
    await insertEffect(preparation)(transaction,[group,event.messageId]);
    throw new InboxProcessingError({kind:"permanent",reason:"OWNER_REVISION_CONFLICT"});
  });
  opts.commit=async()=>{
    commits++;
    assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,0);
    const row=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
    assert.equal(row.state,"Quarantined");assert.equal(row.quarantine_reason,"OWNER_REVISION_CONFLICT");
    assert.equal(row.consumer_name,group);assert.deepEqual(row.envelope,e);
    const q=(await read("SELECT * FROM orders.inbox_quarantine")).rows[0];
    assert.equal(q.reason,"OWNER_REVISION_CONFLICT");assert.equal(q.consumer_name,group);assert.equal(q.offset,"30");
    assert.deepEqual(q.envelope,e);assert.equal(q.envelope_hash,canonicalRequestHash(e));
  };
  await processKafkaRecord(record(e,"30"),opts);
  await processKafkaRecord(record(e,"30"),opts);
  assert.equal(commits,2);assert.equal(handlers,1);
  assert.equal((await read("SELECT * FROM orders.inbox_quarantine")).rowCount,1);
}));

void test("DB clock leases ignore caller skew; release expires without DELETE and restart reclaims unchanged envelope",live,async()=>fixture(async({preparation,read,options,migrator})=>{
  const e=envelope("restart");const inbox=createSqlInboxStore(preparation,{schema:"orders",consumerName:group});
  const before=(await read("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms")).rows[0].now_ms;
  await tx(preparation,async transaction=>{
    const acquired=await inbox.begin(transaction,message(e),"first-owner",0,30000);
    assert.equal(acquired.kind,"acquired");assert.deepEqual(acquired.record.message.payload,e);
    assert.equal(acquired.record.message.payloadHash,canonicalRequestHash(e));assert.equal(acquired.record.attempt,1);
    assert.ok(acquired.record.leaseUntilMs>Number(before)+29000);
    await assert.rejects(inbox.markProcessed(transaction,e.messageId,"wrong-owner",e.occurredAt),{code:"INBOX_NOT_ACQUIRED"});
  });
  const original=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
  const restarted=createSqlInboxStore(preparation,{schema:"orders",consumerName:group});
  await tx(preparation,async transaction=>{
    const blocked=await restarted.begin(transaction,message(e),"second-owner",8000000000000000,30000);
    assert.equal(blocked.kind,"in_progress");
    await assert.rejects(restarted.release(transaction,e.messageId,"first-owner"),{code:"INBOX_NOT_ACQUIRED"});
  });
  let commits=0;const processOptions=options(preparation);processOptions.commit=async()=>{commits++;};
  await assert.rejects(processKafkaRecord(record(e),processOptions),{code:"KAFKA_HANDLER_FAILED"});assert.equal(commits,0);
  // Simulate elapsed time using the frozen schema's permitted lease expiry UPDATE.
  await migrator.query("UPDATE orders.inbox_messages SET lease_until=clock_timestamp()-interval '1 second' WHERE message_id='restart'");
  await tx(preparation,async transaction=>{
    const reclaimed=await restarted.begin(transaction,message(e),"second-owner",0,30000);
    assert.equal(reclaimed.kind,"acquired");assert.equal(reclaimed.record.attempt,2);
    await restarted.release(transaction,e.messageId,"second-owner");
  });
  const released=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
  assert.equal(released.state,"Processing");assert.equal(released.attempt,2);assert.deepEqual(released.envelope,original.envelope);
  assert.equal(released.received_at.toISOString(),original.received_at.toISOString());
  assert.equal(released.envelope_hash,original.envelope_hash);assert.equal(released.payload_hash,original.payload_hash);
  await processKafkaRecord(record(e),options(preparation));
  assert.equal((await read("SELECT attempt,state FROM orders.inbox_messages")).rows[0].attempt,3);
  assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,1);
}));

void test("terminal quarantine requires lease permit and stores stable result; expired finalization rolls back effects",live,async()=>fixture(async({preparation,read,insertEffect})=>{
  const inbox=createSqlInboxStore(preparation,{schema:"orders",consumerName:group});
  const sleep=defineStatement(preparation,"SELECT pg_sleep($1)");const e=envelope("expired");
  await assert.rejects(tx(preparation,async transaction=>{
    assert.equal((await inbox.begin(transaction,message(e),"short-lease",0,1)).kind,"acquired");
    await insertEffect(preparation)(transaction,[group,e.messageId]);await sleep(transaction,[0.02]);
    await inbox.markProcessed(transaction,e.messageId,"short-lease",e.occurredAt);
  }),{code:"INBOX_LEASE_INVALID"});
  assert.equal((await read("SELECT * FROM orders.inbox_messages")).rowCount,0);assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,0);
  const q=envelope("terminal-quarantine");
  await tx(preparation,async transaction=>{
    await assert.rejects(inbox.quarantine(transaction,q.messageId,"lease","PERMANENT_INVALID"),{code:"INBOX_NOT_ACQUIRED"});
    assert.equal((await inbox.begin(transaction,message(q),"lease",0,30000)).kind,"acquired");
    await inbox.quarantine(transaction,q.messageId,"lease","PERMANENT_INVALID");
    await assert.rejects(inbox.release(transaction,q.messageId,"lease"),{code:"INBOX_NOT_ACQUIRED"});
  });
  const terminal=(await read("SELECT * FROM orders.inbox_messages")).rows[0];
  assert.equal(terminal.state,"Quarantined");assert.equal(terminal.quarantine_reason,"PERMANENT_INVALID");assert.equal(terminal.outcome,"Quarantined");
  assert.equal(terminal.lease_owner,"");assert.deepEqual(terminal.result,{kind:"Quarantined"});assert.ok(terminal.quarantined_at);assert.equal(terminal.processed_at,null);
  await tx(preparation,async transaction=>assert.deepEqual(await inbox.begin(transaction,message(q),"new-lease",0,30000),{kind:"duplicate",state:"Quarantined"}));
  assert.deepEqual((await read("SELECT * FROM orders.inbox_messages")).rows[0],terminal);
}));

void test("malformed full envelope fails before Inbox effects; Kafka invalid wire quarantine is consumer/source keyed",live,async()=>fixture(async({preparation,convergence,read,options})=>{
  const inbox=createSqlInboxStore(preparation,{schema:"orders",consumerName:group});
  for(const invalid of [null,"raw-wire",{}, {...envelope(),envelopeVersion:"2"},{...envelope(),aggregate:{type:"Order",ref:ORDER,version:"0"}}, {...envelope(),aggregate:{type:"Order",ref:ORDER,version:"9223372036854775808"}}, {...envelope(),payloadHash:"bogus"}]) {
    const bad={messageId:invalid?.messageId??"bad",messageType:invalid?.messageType??"OrderConfirmed.v1",receivedAt:"2026-10-01T00:00:00Z",payload:invalid,payloadHash:canonicalRequestHash(invalid)};
    await assert.rejects(tx(preparation,transaction=>inbox.begin(transaction,bad,"lease",0,30000)),{code:"INBOX_INVALID"});
  }
  assert.equal((await read("SELECT * FROM orders.inbox_messages")).rowCount,0);
  const wire={invalid:"arbitrary JSON"};let effects=0;let commits=0;
  const a=options(preparation,group,async()=>{effects++;});
  a.commit=async()=>{
    commits++;const quarantine=(await read("SELECT * FROM orders.inbox_quarantine")).rows[0];
    assert.equal(quarantine.consumer_name,group);assert.equal(quarantine.message_id,null);assert.equal(quarantine.message_type,null);
    assert.equal(quarantine.partition_key,null);assert.equal(quarantine.schema_version,null);assert.equal(quarantine.payload_hash,null);
    assert.equal(quarantine.envelope_hash,canonicalRequestHash(wire));assert.deepEqual(quarantine.envelope,wire);
    assert.equal(quarantine.reason,"KAFKA_ENVELOPE_INVALID");assert.equal(quarantine.offset,"8");
  };
  await processKafkaRecord(record(wire,"8"),a);await processKafkaRecord(record(wire,"8"),a);
  assert.equal(commits,2);assert.equal(effects,0);
  await processKafkaRecord(record(wire,"8"),options(convergence,otherGroup));
  assert.equal((await read("SELECT * FROM orders.inbox_quarantine")).rowCount,2);
  assert.equal((await read("SELECT * FROM orders.inbox_messages")).rowCount,0);
  await tx(preparation,async transaction=>{
    assert.equal(await inbox.quarantineRecord(transaction,{topic:"coffee.orders.lifecycle.v1",partition:0,offset:"8",envelope:{different:true},reason:"INVALID"},0),"conflict");
  });
  assert.deepEqual((await read(`SELECT envelope FROM orders.inbox_quarantine WHERE consumer_name='${group}'`)).rows[0].envelope,wire);
}));

void test("consumerName and envelope identity/hash are strict and sanitized before SQL effects",live,async()=>fixture(async({preparation,read})=>{
  for(const consumerName of [null,true,{},"","UPPERCASE","white space"," leading","trailing ","a".repeat(65),"a\u0000b","a;DROP TABLE orders.inbox_messages"]) {
    assert.throws(()=>createSqlInboxStore(preparation,{schema:"orders",consumerName}),{code:"INBOX_INVALID"});
  }
  const inbox=createSqlInboxStore(preparation,{schema:"orders",consumerName:group});
  const e=envelope("identity");
  for(const bad of [{...message(e),messageId:"different"},{...message(e),messageType:"Other.v1"},{...message(e),payloadHash:"0".repeat(64)}]) {
    await assert.rejects(tx(preparation,transaction=>inbox.begin(transaction,bad,"lease",0,30000)),{code:"INBOX_INVALID"});
  }
  for(const traceparent of [`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`,`00-${"0".repeat(32)}-${"b".repeat(16)}-01`,`00-${"a".repeat(32)}-${"0".repeat(16)}-01`]) {
    const invalidEnvelope={...e,messageId:`invalid-trace-${traceparent.slice(0,2)}-${traceparent.slice(3,5)}`,traceparent};
    const invalidMessage={...message(invalidEnvelope),payloadHash:canonicalRequestHash(invalidEnvelope)};
    await assert.rejects(tx(preparation,transaction=>inbox.begin(transaction,invalidMessage,"lease",0,30000)),{code:"INBOX_INVALID"});
  }
  await assert.rejects(tx(preparation,transaction=>inbox.quarantineRecord(transaction,{topic:"coffee.orders.lifecycle.v1",partition:0,offset:"01",envelope:e,reason:"INVALID"},0)),{code:"INBOX_INVALID"});
  await assert.rejects(tx(preparation,transaction=>inbox.quarantineRecord(transaction,{topic:"coffee.orders.lifecycle.v1",partition:0,offset:"9223372036854775808",envelope:e,reason:"INVALID"},0)),{code:"INBOX_INVALID"});
  await assert.rejects(tx(preparation,transaction=>inbox.quarantineRecord(transaction,{topic:"coffee.orders.lifecycle.v1",partition:0,offset:"1",envelope:e,payloadHash:"0".repeat(64),reason:"INVALID"},0)),{code:"INBOX_INVALID"});
  assert.equal((await read("SELECT * FROM orders.inbox_messages")).rowCount,0);assert.equal((await read("SELECT * FROM orders.inbox_quarantine")).rowCount,0);
}));

void test("concurrent real processKafkaRecord consumers serialize the same composite identity into one durable effect",live,async()=>fixture(async({preparation,read,options,create,insertEffect})=>{
  const second=await create("coffee_orders_prepare_rw");
  const sleep=defineStatement(preparation,"SELECT pg_sleep($1)");let handlers=0;let commits=0;
  const a=options(preparation,group,async(transaction,event)=>{
    handlers++;
    await sleep(transaction,[0.05]);
    await insertEffect(preparation)(transaction,[group,event.messageId]);
  });
  const b=options(second,group,async(transaction,event)=>{
    handlers++;await insertEffect(second)(transaction,[group,event.messageId]);
  });
  a.commit=b.commit=async()=>{commits++;};
  const e=envelope("concurrent");
  await Promise.all([processKafkaRecord(record(e,"20"),a),processKafkaRecord(record(e,"21"),b)]);
  assert.equal(handlers,1);assert.equal(commits,2);
  assert.equal((await read("SELECT * FROM orders.inbox_proof_effects")).rowCount,1);
  assert.deepEqual((await read("SELECT consumer_name,message_id,state,attempt FROM orders.inbox_messages")).rows,[{consumer_name:group,message_id:e.messageId,state:"Processed",attempt:1}]);
}));

void test("consumerName absent preserves generic business payload, caller timestamp, single identity and DELETE release",live,async()=>fixture(async({preparation,migrator,read})=>{
  // The existing generic SQL contract from 06_EVENTS_AND_RECOVERY.md, not an Orders migration change.
  await migrator.query(`CREATE TABLE orders.legacy_inbox_messages (
    message_id text PRIMARY KEY,message_type text NOT NULL,received_at timestamptz NOT NULL,payload jsonb NOT NULL,
    payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),state text NOT NULL CHECK(state IN ('Processing','Processed','Quarantined')),
    lease_owner text NOT NULL,lease_until timestamptz NOT NULL,attempt integer NOT NULL CHECK(attempt>0),processed_at timestamptz,quarantine_reason text,quarantined_at timestamptz
  );CREATE TABLE orders.legacy_inbox_quarantine (
    topic text NOT NULL,"partition" integer NOT NULL CHECK("partition">=0),"offset" text NOT NULL,message_id text,message_type text,
    payload_hash text CHECK(payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),envelope jsonb,reason text NOT NULL,quarantined_at timestamptz NOT NULL,
    PRIMARY KEY(topic,"partition","offset")
  );GRANT SELECT,INSERT,UPDATE,DELETE ON orders.legacy_inbox_messages,orders.legacy_inbox_quarantine TO coffee_orders_prepare_rw`);
  const inbox=createSqlInboxStore(preparation,{schema:"orders",table:"legacy_inbox_messages",quarantineTable:"legacy_inbox_quarantine"});
  const payload={legacy:"business payload only"};
  const m={messageId:"legacy",messageType:"Legacy.v1",payload,payloadHash:canonicalRequestHash(payload),receivedAt:"2026-01-01T00:00:00Z"};
  const now=Number((await read("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms")).rows[0].now_ms);
  await tx(preparation,async transaction=>{
    const acquired=await inbox.begin(transaction,m,"legacy-lease",now,30000);
    assert.equal(acquired.kind,"acquired");assert.deepEqual(acquired.record.message,m);
    assert.equal(acquired.record.leaseUntilMs,now+30000);
    await inbox.release(transaction,m.messageId,"legacy-lease");
  });
  assert.equal((await read("SELECT * FROM orders.legacy_inbox_messages")).rowCount,0);
  await tx(preparation,async transaction=>{
    assert.equal((await inbox.begin(transaction,m,"legacy-lease",now,30000)).record.attempt,1);
    await inbox.markProcessed(transaction,m.messageId,"legacy-lease","2026-02-01T00:00:00Z");
  });
  const original=(await read("SELECT * FROM orders.legacy_inbox_messages")).rows[0];
  assert.equal(original.processed_at.toISOString(),"2026-02-01T00:00:00.000Z");assert.deepEqual(original.payload,payload);
  await tx(preparation,async transaction=>{
    assert.deepEqual(await inbox.begin(transaction,m,"another-lease",now,30000),{kind:"duplicate",state:"Processed"});
    const changed={...m,payload:{changed:true},payloadHash:canonicalRequestHash({changed:true})};
    assert.deepEqual(await inbox.begin(transaction,changed,"another-lease",now,30000),{kind:"conflict",reason:"payload_hash_mismatch"});
    const q={topic:"legacy.topic",partition:0,offset:"non-numeric-legacy-offset",messageId:m.messageId,envelope:payload,reason:"INBOX_HASH_CONFLICT"};
    assert.equal(await inbox.quarantineRecord(transaction,q,now),"created");
    assert.equal(await inbox.quarantineRecord(transaction,q,now),"duplicate");
    assert.equal(await inbox.quarantineRecord(transaction,{...q,envelope:{different:true}},now),"conflict");
  });
  const q=(await read("SELECT * FROM orders.legacy_inbox_quarantine")).rows[0];
  assert.equal(q.reason,"INBOX_HASH_CONFLICT");assert.equal(q.payload_hash,canonicalRequestHash(payload));assert.deepEqual(q.envelope,payload);
  assert.deepEqual((await read("SELECT * FROM orders.legacy_inbox_messages")).rows[0],original);
}));
