import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import pg from "pg";
import {trace} from "@opentelemetry/api";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {defineStatement} from "../../packages/platform-database/dist/owner.js";
import {applyMigrations, migrationChecksum} from "../../packages/platform-migrations/dist/index.js";
import {canonicalJson, canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {createSqlOutboxStore} from "../../packages/platform-outbox/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const pool = {max:4, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000};
const observed = [];
trace.setGlobalTracerProvider({getTracer: () => ({startSpan(name) {
  const span = {name, ends:0, status:undefined, attributes:{},
    setAttribute(key,value) {this.attributes[key]=value;return this;},
    setStatus(value) {this.status=value;return this;},
    end() {this.ends++;},
    spanContext: () => ({traceId:"1".repeat(32),spanId:"2".repeat(16),traceFlags:1}),
  };
  observed.push(span);
  return span;
}})});
const ref = (prefix, n = 1) => `${prefix}_${String(n).padStart(26, "0")}`;
const hash = char => char.repeat(64);
const identity = () => ({actorRef:"orders-test-actor", scope:hash("a"), key:randomUUID()});
const customer = {customerRef:ref("cus"), customerVersion:"1", displayName:"Заказчик", state:"Active"};
const proof = n => ({
  productRef:ref("prd"), variantRef:ref("var"), productDisplayName:"Кофе", unit:"piece", quantityMilli:"2500",
  quoteRef:ref("prq", n), quoteLineNumber:1, quoteHash:hash("d"), internalProofHash:hash("e"),
  quoteExpiresAt:Temporal.Now.instant().add({hours:1}).toString(), policyVersionRef:ref("pvr"),
  catalogSnapshotRevision:"1", mappingRevision:"1", offerRef:ref("off", n), unitMinor:"150", lineTotalMinor:"375", currency:"RUB",
});
const request = (expectedVersion, p) => ({expectedVersion, productRef:p.productRef, variantRef:p.variantRef, quantity:"2.5", quoteRef:p.quoteRef, quoteLineNumber:p.quoteLineNumber, quoteHash:p.quoteHash});
const commandMeta = () => ({actorRef:"orders-test-actor", identity:identity(), correlationId:randomUUID(), cardPermissions:["orders:edit:any", "orders:confirm:any"]});

const schemaRoot = new URL("../../contracts/schemas/", import.meta.url);
const ajv = new Ajv2020({strict:true, allErrors:true});
ajv.addFormat("date-time", {type:"string", validate:value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value)});
for (const path of ["common/identifiers.v1.schema.json", "common/money-version-time.v1.schema.json", "common/message-envelope.v1.schema.json", "events/order-confirmed.v1.schema.json"]) {
  ajv.addSchema(JSON.parse(await readFile(new URL(path, schemaRoot), "utf8")));
}
const orderConfirmedSchema = ajv.getSchema("https://coffeeorderplatform.local/contracts/schemas/events/order-confirmed.v1.schema.json");
assert.ok(orderConfirmedSchema);

void test("OrderStore exposes command, exact precheck, PUT preflight, replay, history, Desired, and Outbox operations", async () => {
  const {OrderStore} = await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
  for (const method of ["createDraft", "putItem", "deleteItem", "confirm", "getCard", "replay", "precheck", "preflightPut"]) {
    assert.equal(typeof OrderStore.prototype[method], "function", `${method} must be implemented`);
  }
});

void test("OrderConfirmed envelope and payload match the published schema and reject legacy/missing facts", () => {
  const valid = {
    envelopeVersion:"1", messageId:ref("msg"), messageType:"OrderConfirmed.v1", occurredAt:"2026-09-27T10:00:00.000Z",
    producer:"orders-service", correlationId:randomUUID(), causationId:null, traceparent:"00-11111111111111111111111111111111-2222222222222222-01",
    aggregate:{type:"Order", ref:ref("ord"), version:"3"},
    payload:{orderRef:ref("ord"), orderVersion:"3", customerRef:ref("cus"), confirmedAt:"2026-09-27T10:00:00.000Z", contributionRevision:"1"},
  };
  assert.equal(orderConfirmedSchema(valid), true, JSON.stringify(orderConfirmedSchema.errors));
  const missing = structuredClone(valid); delete missing.payload.customerRef;
  assert.equal(orderConfirmedSchema(missing), false);
  const legacy = structuredClone(valid); legacy.payload.contributionHash = hash("a");
  assert.equal(orderConfirmedSchema(legacy), false);
});

void test("LIVE: Orders migrations use the checksum runner, repeat without writes, and roll back failed SQL and ledger", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  await withCatalogPostgres(async ({adminClient:admin, port, databaseName}) => {
    const rolePassword = randomUUID().replaceAll("-", "");
    await admin.query("CREATE ROLE coffee_orders_service_rw");
    await admin.query(`CREATE ROLE coffee_orders_service_migrator LOGIN PASSWORD '${rolePassword}'`);
    await admin.query(`GRANT CREATE ON DATABASE "${databaseName}" TO coffee_orders_service_migrator`);
    await admin.query("CREATE SCHEMA orders AUTHORIZATION coffee_orders_service_migrator");
    const database = createDatabase({owner:"orders-migrator-proof",database:databaseName,allowedDatabase:databaseName,
      host:"127.0.0.1",port,user:"coffee_orders_service_migrator",password:rolePassword,ssl:false,pool,shutdownGraceMs:40_000});
    const ids = ["0001_create_orders", "0002_create_order_items", "0003_create_order_history",
      "0004_create_order_contributions", "0005_create_orders_idempotency", "0006_create_orders_outbox", "0007_order_grind_selection"];
    const set = await Promise.all(ids.map(async id => {
      const sql = await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`, import.meta.url), "utf8");
      return {id,sql,checksum:migrationChecksum(sql)};
    }));
    const options = {schema:"orders",ledgerTable:"platform_schema_migrations",lockKey:"orders-migration-proof"};
    try {
      await database.resource.start(new AbortController().signal);
      assert.deepEqual(await applyMigrations(database,set,options),ids);
      assert.deepEqual(await applyMigrations(database,set,options),[]);
      const faultySql = "CREATE TABLE orders.migration_partial_probe (id integer); SELECT 1/0;";
      await assert.rejects(
        applyMigrations(database,[...set,{id:"0008_intentionally_fail",sql:faultySql,checksum:migrationChecksum(faultySql)}],options),
        error => error?.code === "DB_QUERY_FAILED" && error?.sqlState === "22012",
        "the SQL must reach the second statement and fail after creating the temporary migration table",
      );
      const inspect = defineStatement(database,"SELECT id FROM orders.platform_schema_migrations ORDER BY id");
      const probe = defineStatement(database,"SELECT to_regclass('orders.migration_partial_probe') AS relation");
      const after = await withTransaction(database,{mode:"background"},async tx => ({
        ledger:(await inspect(tx,[])).rows,relation:(await probe(tx,[])).rows[0]?.relation,
      }));
      assert.deepEqual(after.ledger.map(row => row.id),ids);
      assert.equal(after.relation,null);
      assert.deepEqual(await applyMigrations(database,set,options),[]);
    } finally {await database.resource.stop(AbortSignal.timeout(5_000));}
  });
});

void test("PostgreSQL OrderStore atomically persists commands, prechecks before owner reads, reuses item positions, and writes schema-valid Confirm proof", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  const {OrderStore, hashOrderDraftRequest, hashOrderItemPutRequest, customerSnapshotProofHash} = await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
  await withCatalogPostgres(async ({adminClient:admin, port, databaseName}) => {
    await admin.query("CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD 'orders-proof'");
    for(const role of ["coffee_orders_prepare_rw","coffee_orders_observer_rw","coffee_orders_convergence_rw"]) await admin.query(`CREATE ROLE ${role} NOLOGIN`);
    for (const migration of ["0001_create_orders", "0002_create_order_items", "0003_create_order_history", "0004_create_order_contributions", "0005_create_orders_idempotency", "0006_create_orders_outbox", "0007_order_grind_selection","0008_create_orders_inbox","0009_create_catalog_mapping_projection","0010_create_cart_desired","0011_create_cart_observed","0012_create_convergence_attempts","0013_create_convergence_leases","0014_create_mutation_reservations","0015_create_order_aroma_projections","0016_create_aroma_work_schedules","0017_allow_cart_outbox","0018_guard_order_card_projection","0019_read_guarded_aroma_card","0020_guard_cart_fact_batches","0021_optimize_observed_format_checks","0022_terminal_cart_item_rejection","0023_ascii_observed_identity"]) {
      await admin.query(await readFile(new URL(`../../apps/orders-service/migrations/${migration}.sql`, import.meta.url), "utf8"));
    }
    const database = createDatabase({owner:"orders-service", database:databaseName, allowedDatabase:databaseName, host:"127.0.0.1", port, user:"coffee_orders_service_rw", password:"orders-proof", ssl:false, pool, shutdownGraceMs:40_000});
    const store = new OrderStore(database);
    try {
      const create = {...commandMeta(), customer};
      assert.deepEqual(await store.precheck(create.identity, hashOrderDraftRequest(customer.customerRef), randomUUID()), {kind:"proceed"});
      const draft = await store.createDraft(create);
      assert.equal(draft.status, 201);
      assert.equal(draft.replayed, false);
      assert.equal(draft.body.status, "Draft");
      assert.equal(draft.body.version, "1");
      assert.deepEqual(await store.createDraft(create), {...draft, replayed:true});
      const draftPrecheck = await store.precheck(create.identity, hashOrderDraftRequest(customer.customerRef), randomUUID());
      assert.equal(draftPrecheck.kind, "completed");
      assert.deepEqual(draftPrecheck.response.body, draft.body);
      assert.equal((await store.precheck(create.identity, hash("b"), randomUUID())).kind, "conflict");
      const persistedProof = (await admin.query("SELECT customer_state_proof_hash FROM orders.orders WHERE order_ref=$1", [draft.body.orderRef])).rows[0].customer_state_proof_hash;
      assert.equal(persistedProof, customerSnapshotProofHash(customer));

      const firstRef = ref("itm", 1), firstProof = proof(1), firstRequest = request("1", firstProof);
      const firstPut = {...commandMeta(), orderRef:draft.body.orderRef, itemRef:firstRef, expectedVersion:"1", request:firstRequest, item:firstProof};
      await assert.rejects(store.putItem({...firstPut, request:{...firstRequest, quantity:"3.5"}}), {code:"ORDER_VALIDATION_FAILED"}, "verified pricing snapshot must match the original browser request");
      assert.deepEqual(await store.precheck(firstPut.identity, hashOrderItemPutRequest(firstRequest), randomUUID()), {kind:"proceed"});
      const beforeAbortedPreflight=(await admin.query("SELECT count(*)::int AS count FROM orders.idempotency_records")).rows[0].count;
      const abortedPreflight=new AbortController();abortedPreflight.abort();
      assert.deepEqual(await store.preflightPut(firstPut.identity,hashOrderItemPutRequest(firstRequest),firstPut.orderRef,[],randomUUID(),abortedPreflight.signal),{kind:"lookup_unavailable"});
      assert.equal(database.metrics().active,0,"an aborted preflight leaves no leased connection");
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM orders.idempotency_records")).rows[0].count,beforeAbortedPreflight,"an aborted preflight cannot claim a write or idempotency record");
      assert.deepEqual(await store.preflightPut(firstPut.identity,hashOrderItemPutRequest(firstRequest),firstPut.orderRef,[],randomUUID()),{kind:"proceed",customerRef:customer.customerRef});
      await assert.rejects(store.preflightPut(commandMeta().identity,hashOrderItemPutRequest(firstRequest),ref("ord",99),[],randomUUID()),{code:"ORDER_NOT_FOUND"});
      const edited = await store.putItem(firstPut);
      assert.equal(edited.body.version, "2");
      assert.equal(edited.body.items.length, 1);
      const beforePrecheck = (await admin.query("SELECT count(*)::int AS count FROM orders.idempotency_records")).rows[0].count;
      const putPrecheck = await store.precheck(firstPut.identity, hashOrderItemPutRequest(firstRequest), randomUUID());
      assert.equal(putPrecheck.kind, "completed");
      assert.deepEqual(putPrecheck.response.body, edited.body);
      const completedPreflight=await store.preflightPut(firstPut.identity,hashOrderItemPutRequest(firstRequest),firstPut.orderRef,[],randomUUID());
      assert.equal(completedPreflight.kind,"completed");
      if(completedPreflight.kind==="completed")assert.deepEqual(completedPreflight.response.body,edited.body);
      assert.equal((await admin.query("SELECT count(*)::int AS count FROM orders.idempotency_records")).rows[0].count, beforePrecheck, "precheck must be read-only before Customer/Pricing calls");
      assert.deepEqual(await store.putItem(firstPut), {...edited, replayed:true});

      const secondRef = ref("itm", 2), secondProof = proof(2), secondRequest = request("2", secondProof);
      const second = await store.putItem({...commandMeta(), orderRef:draft.body.orderRef, itemRef:secondRef, expectedVersion:"2", request:secondRequest, item:secondProof});
      assert.equal(second.body.version, "3");
      const thirdRef = ref("itm", 3), thirdProof = proof(3), thirdRequest = request("3", thirdProof);
      const third = await store.putItem({...commandMeta(), orderRef:draft.body.orderRef, itemRef:thirdRef, expectedVersion:"3", request:thirdRequest, item:thirdProof});
      assert.equal(third.body.version, "4");
      await store.deleteItem({...commandMeta(), orderRef:draft.body.orderRef, itemRef:secondRef, expectedVersion:"4"});
      const fourthRef = ref("itm", 4), fourthProof = proof(4), fourthRequest = request("5", fourthProof);
      const fourth = await store.putItem({...commandMeta(), orderRef:draft.body.orderRef, itemRef:fourthRef, expectedVersion:"5", request:fourthRequest, item:fourthProof});
      assert.equal(fourth.body.version, "6");
      assert.deepEqual(fourth.body.items.map(item => item.linePosition), [1, 2, 3], "inserting after a middle deletion reuses the vacant position");

      const confirm = {...commandMeta(), orderRef:draft.body.orderRef, expectedVersion:"6"};
      const confirmed = await store.confirm(confirm);
      assert.equal(confirmed.status, 200);
      assert.deepEqual(observed.filter(span => span.name === "orders.transaction.confirm").map(span => span.ends),[1]);
      assert.deepEqual(observed.filter(span => span.name === "orders.outbox.insert").map(span => span.ends),[1]);
      assert.ok(observed.every(span => !JSON.stringify({name:span.name,attributes:span.attributes,status:span.status}).includes(confirm.orderRef)));
      assert.equal(confirmed.body.status, "Confirmed");
      assert.equal(confirmed.body.version, "7");
      assert.deepEqual(await store.confirm(confirm), {...confirmed, replayed:true});
      const card = await store.getCard(draft.body.orderRef, {permissions:[], correlationId:randomUUID()});
      assert.equal(card.version, "7");
      assert.equal(card.items.length, 3);

      const durable = (await admin.query(`SELECT
        (SELECT count(*)::int FROM orders.orders WHERE order_ref=$1) AS orders,
        (SELECT count(*)::int FROM orders.order_items WHERE order_ref=$1) AS items,
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.order_desired_contribution_lines WHERE order_ref=$1) AS desired_lines,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE resource_ref=$1 AND state='Completed') AS completed`, [draft.body.orderRef])).rows[0];
      assert.deepEqual(durable, {orders:1, items:3, history:7, desired:1, desired_lines:3, outbox:1, completed:7});
      const storedEvent = (await admin.query("SELECT topic, message_type, message_id, aggregate_sequence, envelope, envelope_bytes, envelope_hash, payload, payload_hash FROM orders.outbox_messages WHERE aggregate_ref=$1", [draft.body.orderRef])).rows[0];
      assert.equal(storedEvent.topic, "coffee.orders.lifecycle.v1");
      assert.equal(storedEvent.message_type, "OrderConfirmed.v1");
      assert.match(storedEvent.message_id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/u);
      assert.equal(storedEvent.aggregate_sequence, "1");
      assert.equal(orderConfirmedSchema(storedEvent.envelope), true, JSON.stringify(orderConfirmedSchema.errors));
      assert.equal(storedEvent.payload_hash, canonicalRequestHash(storedEvent.envelope), "SqlOutboxStore.claim must accept the persisted canonical envelope");
      assert.deepEqual(storedEvent.envelope_bytes, Buffer.from(canonicalJson(storedEvent.envelope)), "immutable Outbox bytes must match Kafka's canonical serialization");
      assert.equal(storedEvent.envelope_hash, canonicalRequestHash(storedEvent.envelope));
      const outbox = createSqlOutboxStore(database, {schema:"orders"});
      const [first] = await withTransaction(database, {mode:"background"}, tx => outbox.claim(tx, Date.now(), "orders-relay-before-restart", 1, 30_000));
      assert.equal(first?.message.messageId, storedEvent.message_id);
      assert.equal(first.message.topic, "coffee.orders.lifecycle.v1");
      const originalBytes = (await admin.query("SELECT envelope_bytes FROM orders.outbox_messages WHERE message_id=$1", [first.message.messageId])).rows[0].envelope_bytes;
      await admin.query("UPDATE orders.outbox_messages SET lease_until=transaction_timestamp()-interval '1 second' WHERE message_id=$1", [first.message.messageId]);
      const restarted = createSqlOutboxStore(database, {schema:"orders"});
      const [reclaimed] = await withTransaction(database, {mode:"background"}, tx => restarted.claim(tx, Date.now(), "orders-relay-after-restart", 1, 30_000));
      assert.equal(reclaimed?.message.messageId, first.message.messageId);
      assert.deepEqual(reclaimed.message.envelope, first.message.envelope);
      assert.deepEqual((await admin.query("SELECT envelope_bytes FROM orders.outbox_messages WHERE message_id=$1", [reclaimed.message.messageId])).rows[0].envelope_bytes, originalBytes);
      await withTransaction(database, {mode:"background"}, tx => restarted.finalize(tx, reclaimed.message.messageId, "orders-relay-after-restart", reclaimed.leaseToken));
      assert.equal((await admin.query("SELECT state FROM orders.outbox_messages WHERE message_id=$1", [reclaimed.message.messageId])).rows[0].state, "Published");
      assert.deepEqual(await withTransaction(database, {mode:"background"}, tx => restarted.claim(tx, Date.now(), "orders-relay-again", 1, 30_000)), []);
      assert.deepEqual(storedEvent.payload, {orderRef:draft.body.orderRef, orderVersion:"7", customerRef:customer.customerRef, confirmedAt:storedEvent.envelope.payload.confirmedAt, contributionRevision:"1"});
      const invalidFacts = structuredClone(storedEvent.envelope); delete invalidFacts.payload.orderVersion;
      assert.equal(orderConfirmedSchema(invalidFacts), false);
      const desired = (await admin.query("SELECT quantity_milli::text, item_refs FROM orders.order_desired_contribution_lines WHERE order_ref=$1 ORDER BY offer_ref", [draft.body.orderRef])).rows;
      assert.equal(desired.length, 3);
      assert.ok(desired.every(line => line.quantity_milli === "2500" && line.item_refs.length === 1));
      const replay = await store.replay(confirm.identity, undefined, randomUUID());
      assert.equal(replay.kind, "completed");
      assert.equal(replay.response.status, 200);
      assert.equal(replay.response.resourceRef, draft.body.orderRef);

      const groundDraft=await store.createDraft({...commandMeta(),customer});
      const grain={sourceGrindKeyHash:"a".repeat(64),grindDisplayName:"Средний помол"};
      const groundProofs=[proof(31),{...proof(32),offerRef:proof(31).offerRef,...grain},{...proof(33),offerRef:proof(31).offerRef,...grain}];
      for(const [index,item] of groundProofs.entries()) {
        const version=String(index+1);
        const expected={...request(version,item),...(item.sourceGrindKeyHash===undefined?{}:{sourceGrindKeyHash:item.sourceGrindKeyHash})};
        const put=await store.putItem({...commandMeta(),orderRef:groundDraft.body.orderRef,itemRef:ref("itm",31+index),expectedVersion:version,request:expected,item});
        assert.equal(put.body.items[index].sourceGrindKeyHash,item.sourceGrindKeyHash);
        if(index===1) await assert.rejects(store.putItem({...commandMeta(),orderRef:groundDraft.body.orderRef,itemRef:ref("itm",39),expectedVersion:put.body.version,request:{...expected,expectedVersion:put.body.version,sourceGrindKeyHash:"b".repeat(64)},item}),{code:"ORDER_VALIDATION_FAILED"});
      }
      await store.confirm({...commandMeta(),orderRef:groundDraft.body.orderRef,expectedVersion:"4"});
      const groundLines=(await admin.query("SELECT offer_ref, source_grind_key_hash, quantity_milli::text FROM orders.order_desired_contribution_lines WHERE order_ref=$1 ORDER BY offer_ref, source_grind_key_hash NULLS FIRST",[groundDraft.body.orderRef])).rows;
      assert.deepEqual(groundLines,[{offer_ref:groundProofs[0].offerRef,source_grind_key_hash:null,quantity_milli:"2500"},{offer_ref:groundProofs[0].offerRef,source_grind_key_hash:grain.sourceGrindKeyHash,quantity_milli:"5000"}]);

      const expiredDraft = await store.createDraft({...commandMeta(), customer});
      const expiredProof = {...proof(9), quoteExpiresAt:Temporal.Now.instant().subtract({hours:1}).toString()};
      const expiredRequest = request("1", expiredProof);
      const expiredPut = {...commandMeta(), orderRef:expiredDraft.body.orderRef, itemRef:ref("itm", 9), expectedVersion:"1", request:expiredRequest, item:expiredProof};
      await assert.rejects(store.putItem(expiredPut), {code:"PRICING_QUOTE_EXPIRED"});
      const expiredConfirm = {...commandMeta(), orderRef:expiredDraft.body.orderRef, expectedVersion:"1"};
      await assert.rejects(store.confirm(expiredConfirm), {code:"ORDER_EMPTY"});
      const rollback = (await admin.query(`SELECT
        (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox,
        (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.order_items WHERE order_ref=$1) AS items,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS put_idempotency`,
        [expiredDraft.body.orderRef, expiredPut.identity.actorRef, expiredPut.identity.scope, expiredPut.identity.key])).rows[0];
      assert.deepEqual(rollback, {status:"Draft", history:1, desired:0, outbox:0, version:"1", items:0, put_idempotency:0}, "expired PUT must leave no version, item, history, Desired, Outbox or idempotency effects");

      const duplicateDraft = await store.createDraft({...commandMeta(), customer});
      const duplicateFirstProof = proof(21);
      await store.putItem({...commandMeta(), orderRef:duplicateDraft.body.orderRef, itemRef:ref("itm", 21), expectedVersion:"1", request:request("1",duplicateFirstProof), item:duplicateFirstProof});
      const duplicateSecondProof = {...proof(22), quoteRef:duplicateFirstProof.quoteRef, quoteLineNumber:duplicateFirstProof.quoteLineNumber};
      const duplicatePut = {...commandMeta(), orderRef:duplicateDraft.body.orderRef, itemRef:ref("itm", 22), expectedVersion:"2", request:request("2",duplicateSecondProof), item:duplicateSecondProof};
      await assert.rejects(store.putItem(duplicatePut), {code:"ORDER_QUOTE_SCOPE_MISMATCH"});
      assert.deepEqual((await admin.query(`SELECT (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.order_items WHERE order_ref=$1) AS items,
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS rejected_idempotency`,
        [duplicateDraft.body.orderRef, duplicatePut.identity.actorRef, duplicatePut.identity.scope, duplicatePut.identity.key])).rows[0],
      {version:"2",items:1,history:2,rejected_idempotency:0});
      const unique = (await admin.query(`SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid='orders.order_items'::regclass AND contype='u' AND pg_get_constraintdef(oid) LIKE '%(order_ref, quote_ref, quote_line_number)%'`)).rows[0].n;
      assert.equal(unique,1,"the owner migration must reject duplicate quote-line proofs even for direct SQL writers");
      await assert.rejects(admin.query(`INSERT INTO orders.order_items (order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
        SELECT order_ref,$2,2,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency
        FROM orders.order_items WHERE order_ref=$1 AND item_ref=$3`, [duplicateDraft.body.orderRef,ref("itm",22),ref("itm",21)]), {code:"23505", constraint:"order_items_quote_line_unique"});
      // Simulate a previously persisted bad state to verify Confirm's own fail-closed guard.
      await admin.query("ALTER TABLE orders.order_items DROP CONSTRAINT order_items_quote_line_unique");
      await admin.query(`INSERT INTO orders.order_items (order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
        SELECT order_ref,$2,2,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency
        FROM orders.order_items WHERE order_ref=$1 AND item_ref=$3`, [duplicateDraft.body.orderRef,ref("itm",22),ref("itm",21)]);
      await assert.rejects(store.confirm({...commandMeta(),orderRef:duplicateDraft.body.orderRef,expectedVersion:"2"}), {code:"ORDER_STATE_INCONSISTENT"});
      assert.deepEqual((await admin.query(`SELECT (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox`, [duplicateDraft.body.orderRef])).rows[0],
      {status:"Draft",desired:0,outbox:0});
      await admin.query("DELETE FROM orders.order_items WHERE order_ref=$1 AND item_ref=$2", [duplicateDraft.body.orderRef,ref("itm",22)]);
      await admin.query("ALTER TABLE orders.order_items ADD CONSTRAINT order_items_quote_line_unique UNIQUE (order_ref, quote_ref, quote_line_number)");

      async function assertCardSerialized(orderRef, expected, mutate) {
        let entered; let release;
        const readEntered = new Promise(resolve => {entered=resolve;});
        const readRelease = new Promise(resolve => {release=resolve;});
        const originalQuery = pg.Client.prototype.query;
        let paused = false;
        let readPromise; let writePromise;
        // Pause only this getCard after the parent SELECT; the writer uses a separate connection.
        pg.Client.prototype.query = function (...args) {
          const result = originalQuery.apply(this,args);
          const sql = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (!paused && /^SELECT \* FROM orders\.orders WHERE order_ref=\$1(?: FOR SHARE)?$/u.test(sql)) {
            paused = true;
            return Promise.resolve(result).then(async rows => {entered(); await readRelease; return rows;});
          }
          return result;
        };
        try {
          readPromise = store.getCard(orderRef,{permissions:[],correlationId:randomUUID()});
          await readEntered;
          let writeDone = false;
          writePromise = Promise.resolve().then(mutate).then(value => {writeDone=true;return {value};},error => {writeDone=true;return {error};});
          await new Promise(resolve => setTimeout(resolve,150));
          assert.equal(writeDone,false,"parent/child writer must wait until card reads the same committed state");
          release();
          const card = await readPromise;
          assert.equal(card.version,expected.version);
          assert.equal(card.projectionVersion,expected.version);
          assert.equal(card.status,expected.status);
          assert.deepEqual(card.items.map(row=>row.itemRef),expected.items);
          const written = await writePromise;
          if (written.error) throw written.error;
          return written.value;
        } finally {
          release();
          await Promise.allSettled([readPromise ?? Promise.resolve(),writePromise ?? Promise.resolve()]);
          pg.Client.prototype.query = originalQuery;
        }
      }
      const consistentDraft = await store.createDraft({...commandMeta(),customer});
      const consistentFirst = proof(31);
      await store.putItem({...commandMeta(),orderRef:consistentDraft.body.orderRef,itemRef:ref("itm",31),expectedVersion:"1",request:request("1",consistentFirst),item:consistentFirst});
      const consistentSecond = proof(32);
      const added = await assertCardSerialized(consistentDraft.body.orderRef,{version:"2",status:"Draft",items:[ref("itm",31)]},
        () => store.putItem({...commandMeta(),orderRef:consistentDraft.body.orderRef,itemRef:ref("itm",32),expectedVersion:"2",request:request("2",consistentSecond),item:consistentSecond}));
      assert.equal(added.body.version,"3");
      assert.deepEqual(added.body.items.map(row=>row.itemRef),[ref("itm",31),ref("itm",32)]);
      const removed = await assertCardSerialized(consistentDraft.body.orderRef,{version:"3",status:"Draft",items:[ref("itm",31),ref("itm",32)]},
        () => store.deleteItem({...commandMeta(),orderRef:consistentDraft.body.orderRef,itemRef:ref("itm",32),expectedVersion:"3"}));
      assert.equal(removed.body.version,"4");
      assert.deepEqual(removed.body.items.map(row=>row.itemRef),[ref("itm",31)]);
      const serializedConfirm = await assertCardSerialized(consistentDraft.body.orderRef,{version:"4",status:"Draft",items:[ref("itm",31)]},
        () => store.confirm({...commandMeta(),orderRef:consistentDraft.body.orderRef,expectedVersion:"4"}));
      assert.equal(serializedConfirm.body.status,"Confirmed");
      assert.equal(serializedConfirm.body.version,"5");

      // A direct owner SQL item mutation also uses the migration trigger's parent FOR UPDATE.
      const directDraft = await store.createDraft({...commandMeta(),customer});
      const directProof = proof(33);
      await store.putItem({...commandMeta(),orderRef:directDraft.body.orderRef,itemRef:ref("itm",33),expectedVersion:"1",request:request("1",directProof),item:directProof});
      await assertCardSerialized(directDraft.body.orderRef,{version:"2",status:"Draft",items:[ref("itm",33)]},
        () => admin.query("DELETE FROM orders.order_items WHERE order_ref=$1 AND item_ref=$2",[directDraft.body.orderRef,ref("itm",33)]));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM orders.order_items WHERE order_ref=$1",[directDraft.body.orderRef])).rows[0].n,0);

      const atLimit = await store.createDraft({...commandMeta(), customer});
      const seedProof = proof(11);
      await store.putItem({...commandMeta(), orderRef:atLimit.body.orderRef, itemRef:ref("itm", 1), expectedVersion:"1", request:request("1", seedProof), item:seedProof});
      await admin.query(`INSERT INTO orders.order_items (order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
        SELECT source.order_ref,'itm_' || lpad(slots.position::text,26,'0'),slots.position,source.product_ref,source.variant_ref,source.product_display_name,source.unit,source.quantity_milli,source.quote_ref,slots.position,source.quote_hash,source.internal_proof_hash,source.quote_expires_at,source.policy_version_ref,source.catalog_snapshot_revision,source.mapping_revision,source.offer_ref,source.unit_minor,source.line_total_minor,source.currency
        FROM orders.order_items AS source CROSS JOIN generate_series(2,100) AS slots(position) WHERE source.order_ref=$1 AND source.item_ref=$2`, [atLimit.body.orderRef, ref("itm", 1)]);
      const extraProof=proof(101);
      const overflow={...commandMeta(), orderRef:atLimit.body.orderRef, itemRef:ref("itm", 101), expectedVersion:"2", request:request("2",extraProof), item:extraProof};
      await assert.rejects(store.putItem(overflow), {code:"ORDER_ITEM_LIMIT_EXCEEDED"});
      const limitFacts=(await admin.query(`SELECT (SELECT count(*)::int FROM orders.order_items WHERE order_ref=$1) AS items,
        (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS rejected_key`,
        [atLimit.body.orderRef, overflow.identity.actorRef, overflow.identity.scope, overflow.identity.key])).rows[0];
      assert.deepEqual(limitFacts,{items:100,version:"2",rejected_key:0});

      const expensiveDraft=await store.createDraft({...commandMeta(),customer});
      const largePrice="5000000000000000000";
      const expensiveFirst={...proof(41),quantityMilli:"1000",unitMinor:largePrice,lineTotalMinor:largePrice};
      const expensiveSecond={...proof(42),quantityMilli:"1000",unitMinor:largePrice,lineTotalMinor:largePrice};
      const expensiveRef=expensiveDraft.body.orderRef;
      await store.putItem({...commandMeta(),orderRef:expensiveRef,itemRef:ref("itm",41),expectedVersion:"1",
        request:{...request("1",expensiveFirst),quantity:"1"},item:expensiveFirst});
      const excessivePut={...commandMeta(),orderRef:expensiveRef,itemRef:ref("itm",42),expectedVersion:"2",
        request:{...request("2",expensiveSecond),quantity:"1"},item:expensiveSecond};
      await assert.rejects(store.putItem(excessivePut),{code:"ORDER_STATE_INCONSISTENT"},"PUT must not commit an aggregate the projector would hide");
      assert.deepEqual((await admin.query(`SELECT
        (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.order_items WHERE order_ref=$1) AS items,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS rejected_key`,
        [expensiveRef,excessivePut.identity.actorRef,excessivePut.identity.scope,excessivePut.identity.key])).rows[0],
      {version:"2",items:1,rejected_key:0});
      // Pre-existing inconsistent rows still require an independent Confirm guard.
      await admin.query(`INSERT INTO orders.order_items (order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency)
        SELECT order_ref,$2,2,product_ref,variant_ref,product_display_name,unit,quantity_milli,$3,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,$4,unit_minor,line_total_minor,currency
        FROM orders.order_items WHERE order_ref=$1 AND item_ref=$5`,
        [expensiveRef,ref("itm",42),expensiveSecond.quoteRef,expensiveSecond.offerRef,ref("itm",41)]);
      const rejectedConfirm={...commandMeta(),orderRef:expensiveRef,expectedVersion:"2"};
      await assert.rejects(store.confirm(rejectedConfirm),{code:"ORDER_STATE_INCONSISTENT"});
      assert.deepEqual((await admin.query(`SELECT
        (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
        (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS rejected_key`,
        [expensiveRef,rejectedConfirm.identity.actorRef,rejectedConfirm.identity.scope,rejectedConfirm.identity.key])).rows[0],
      {status:"Draft",version:"2",history:2,desired:0,outbox:0,rejected_key:0});
    } finally {
      await database.resource.stop(AbortSignal.timeout(5_000));
    }
  });
});
