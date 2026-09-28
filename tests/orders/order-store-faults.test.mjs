import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomBytes, randomUUID} from "node:crypto";
import test from "node:test";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {openBlackholeProxy} from "../../scripts/db-live-proof.mjs";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const pool = {max:6, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000};
const ref = prefix => `${prefix}_${randomBytes(16).toString("hex").toUpperCase().slice(0, 26)}`;
const hash = char => char.repeat(64);
const identity = () => ({actorRef:"orders-fault-test", scope:hash("a"), key:randomUUID()});
const customer = {customerRef:"cus_00000000000000000000000001", customerVersion:"1", displayName:"Fault test", state:"Active"};
const proof = n => ({
  productRef:"prd_00000000000000000000000001", variantRef:"var_00000000000000000000000001", productDisplayName:"Coffee", unit:"piece", quantityMilli:"2500",
  quoteRef:`prq_${String(n).padStart(26, "0")}`, quoteLineNumber:1, quoteHash:hash("d"), internalProofHash:hash("e"),
  quoteExpiresAt:Temporal.Now.instant().add({hours:1}).toString(), policyVersionRef:"pvr_00000000000000000000000001",
  catalogSnapshotRevision:"1", mappingRevision:"1", offerRef:`off_${String(n).padStart(26, "0")}`, unitMinor:"150", lineTotalMinor:"375", currency:"RUB",
});
const request = (expectedVersion, item) => ({expectedVersion, productRef:item.productRef, variantRef:item.variantRef, quantity:"2.5", quoteRef:item.quoteRef, quoteLineNumber:item.quoteLineNumber, quoteHash:item.quoteHash});
const meta = (key = identity()) => ({actorRef:"orders-fault-test", identity:key, correlationId:randomUUID(), cardPermissions:["orders:edit:any", "orders:confirm:any"]});
const migrations = ["0001_create_orders", "0002_create_order_items", "0003_create_order_history", "0004_create_order_contributions", "0005_create_orders_idempotency", "0006_create_orders_outbox"];
const closeDatabase = async database => {
  if (!database) return;
  await database.resource.stop(AbortSignal.timeout(5_000)).catch(() => database.resource.destroy());
};
const connection = (databaseName, port, password, user = "coffee_orders_service_rw") => createDatabase({
  owner:"orders-fault-proof", database:databaseName, allowedDatabase:databaseName, host:"127.0.0.1", port, user, password, ssl:false, pool, shutdownGraceMs:40_000,
});

void test("PostgreSQL Orders same-key concurrency, stale expectedVersion, transaction fault rollback, and unknown COMMIT replay", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  const {OrderStore} = await import("../../apps/orders-service/dist/infrastructure/database/order-store.js");
  await withCatalogPostgres(async ({adminClient:admin, port, databaseName}) => {
    const runtimePassword = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${runtimePassword}'`);
    for (const migration of migrations) {
      await admin.query(await readFile(new URL(`../../apps/orders-service/migrations/${migration}.sql`, import.meta.url), "utf8"));
    }

    let database = connection(databaseName, port, runtimePassword);
    let store = new OrderStore(database);
    let proxy;
    try {
      await database.resource.start(AbortSignal.timeout(5_000));

      // Both callers use precisely the same idempotency identity and request.
      const createCommand = {...meta(), customer};
      const sameKeyResults = await Promise.all([store.createDraft(createCommand), store.createDraft(createCommand)]);
      assert.equal(sameKeyResults.filter(result => !result.replayed).length, 1);
      assert.equal(sameKeyResults.filter(result => result.replayed).length, 1);
      assert.deepEqual(sameKeyResults[0].body, sameKeyResults[1].body);

      // Two distinct commands race on the same expected order version; only one may bump it.
      const orderRef = sameKeyResults[0].body.orderRef;
      const leftItem = proof(1), rightItem = proof(2);
      const put = (item, itemRef) => ({...meta(), orderRef, itemRef, expectedVersion:"1", request:request("1", item), item});
      const competing = await Promise.allSettled([put(leftItem, ref("itm")), put(rightItem, ref("itm"))].map(command => store.putItem(command)));
      assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(competing.filter(result => result.status === "rejected" && result.reason?.code === "ORDER_VERSION_CONFLICT").length, 1);
      const afterRace = await store.getCard(orderRef, {permissions:[], correlationId:randomUUID()});
      assert.equal(afterRace.version, "2");
      assert.equal(afterRace.items.length, 1);
      // Three distinct commands compete for the same version; only the winner may leave effects.
      const replacement = proof(3);
      const mixedCommands = [
        store.putItem({...meta(), orderRef, itemRef:afterRace.items[0].itemRef, expectedVersion:"2", request:request("2", replacement), item:replacement}),
        store.deleteItem({...meta(), orderRef, itemRef:afterRace.items[0].itemRef, expectedVersion:"2"}),
        store.confirm({...meta(), orderRef, expectedVersion:"2"}),
      ];
      const mixedRace = await Promise.allSettled(mixedCommands);
      const winnerIndex = mixedRace.findIndex(result => result.status === "fulfilled");
      assert.notEqual(winnerIndex, -1);
      assert.equal(mixedRace.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(mixedRace.filter(result => result.status === "rejected" &&
        ["ORDER_VERSION_CONFLICT", "ORDER_NOT_EDITABLE"].includes(result.reason?.code)).length, 2);
      const finalCard = await store.getCard(orderRef, {permissions:[], correlationId:randomUUID()});
      assert.equal(finalCard.version, "3");
      assert.equal(finalCard.status, winnerIndex === 2 ? "Confirmed" : "Draft");
      assert.equal(finalCard.items.length, winnerIndex === 1 ? 0 : 1);
      const mixedFacts = (await admin.query(`SELECT
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE resource_ref=$1 AND state='Completed') AS completed`, [orderRef])).rows[0];
      assert.deepEqual(mixedFacts, {history:3, desired:winnerIndex === 2 ? 1 : 0, outbox:winnerIndex === 2 ? 1 : 0, completed:3});

      // Fail each Confirm write on PostgreSQL itself; every attempt gets a fresh draft and key.
      await admin.query(`CREATE FUNCTION orders.fail_live_confirm_stage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected Orders Confirm stage failure' USING ERRCODE = '23514'; END $$`);
      const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
      const faultStages = [
        {name:"status/version", table:"orders.orders", operation:"UPDATE", predicate:orderRef => `OLD.order_ref = ${sqlLiteral(orderRef)} AND NEW.status = 'Confirmed'`},
        {name:"history", table:"orders.order_history", operation:"INSERT", predicate:orderRef => `NEW.order_ref = ${sqlLiteral(orderRef)} AND NEW.event_type = 'OrderConfirmed'`},
        {name:"contribution", table:"orders.order_desired_contributions", operation:"INSERT", predicate:orderRef => `NEW.order_ref = ${sqlLiteral(orderRef)}`},
        {name:"contribution line", table:"orders.order_desired_contribution_lines", operation:"INSERT", predicate:orderRef => `NEW.order_ref = ${sqlLiteral(orderRef)}`},
        {name:"Outbox", table:"orders.outbox_messages", operation:"INSERT", predicate:orderRef => `NEW.aggregate_ref = ${sqlLiteral(orderRef)}`},
        {name:"idempotency Acquired insert", table:"orders.idempotency_records", operation:"INSERT", predicate:(_orderRef, command) => `NEW.actor_ref = ${sqlLiteral(command.identity.actorRef)} AND NEW.scope = ${sqlLiteral(command.identity.scope)} AND NEW.idempotency_key = ${sqlLiteral(command.identity.key)}`},
        {name:"idempotency Completed update", table:"orders.idempotency_records", operation:"UPDATE", predicate:(_orderRef, command) => `NEW.actor_ref = ${sqlLiteral(command.identity.actorRef)} AND NEW.scope = ${sqlLiteral(command.identity.scope)} AND NEW.idempotency_key = ${sqlLiteral(command.identity.key)} AND NEW.state = 'Completed'`},
      ];
      try {
        for (const [index, stage] of faultStages.entries()) {
          const draft = await store.createDraft({...meta(), customer});
          const item = proof(30 + index), itemRequest = request("1", item);
          await store.putItem({...meta(), orderRef:draft.body.orderRef, itemRef:ref("itm"), expectedVersion:"1", request:itemRequest, item});
          const confirm = {...meta(), orderRef:draft.body.orderRef, expectedVersion:"2"};
          const trigger = `orders_live_confirm_fault_${index}`;
          await admin.query(`CREATE TRIGGER ${trigger} BEFORE ${stage.operation} ON ${stage.table} FOR EACH ROW WHEN (${stage.predicate(draft.body.orderRef, confirm)}) EXECUTE FUNCTION orders.fail_live_confirm_stage()`);
          try {
            await assert.rejects(store.confirm(confirm), {code:"DB_QUERY_FAILED"}, `fault at ${stage.name}`);
          } finally {
            await admin.query(`DROP TRIGGER ${trigger} ON ${stage.table}`);
          }

          const rolledBack = (await admin.query(`SELECT
            (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
            (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
            (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1) AS history,
            (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
            (SELECT count(*)::int FROM orders.order_desired_contribution_lines WHERE order_ref=$1) AS desired_lines,
            (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1) AS outbox,
            (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4) AS idempotency`,
            [draft.body.orderRef, confirm.identity.actorRef, confirm.identity.scope, confirm.identity.key])).rows[0];
          assert.deepEqual(rolledBack, {status:"Draft", version:"2", history:2, desired:0, desired_lines:0, outbox:0, idempotency:0}, `rollback at ${stage.name}`);

          const retried = await store.confirm(confirm);
          assert.equal(retried.body.status, "Confirmed", `same-key retry at ${stage.name}`);
          assert.equal(retried.body.version, "3", `version after retry at ${stage.name}`);
          const committed = (await admin.query(`SELECT
            (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
            (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
            (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1 AND event_type='OrderConfirmed') AS confirm_history,
            (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
            (SELECT count(*)::int FROM orders.order_desired_contribution_lines WHERE order_ref=$1) AS desired_lines,
            (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1 AND state='Pending') AS outbox,
            (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4 AND state='Completed') AS completed_idempotency`,
            [draft.body.orderRef, confirm.identity.actorRef, confirm.identity.scope, confirm.identity.key])).rows[0];
          assert.deepEqual(committed, {status:"Confirmed", version:"3", confirm_history:1, desired:1, desired_lines:1, outbox:1, completed_idempotency:1}, `single effect after retry at ${stage.name}`);
        }
      } finally {
        await admin.query("DROP FUNCTION orders.fail_live_confirm_stage()");
      }

      // A real TCP proxy drops PostgreSQL's COMMIT response only; reconnect and exact precheck resolve the outcome.
      const unknownDraft = await store.createDraft({...meta(), customer});
      const unknownItem = proof(4), unknownRequest = request("1", unknownItem);
      await store.putItem({...meta(), orderRef:unknownDraft.body.orderRef, itemRef:ref("itm"), expectedVersion:"1", request:unknownRequest, item:unknownItem});
      const unknownConfirm = {...meta(), orderRef:unknownDraft.body.orderRef, expectedVersion:"2"};
      await closeDatabase(database);
      database = undefined;
      store = undefined;

      proxy = await openBlackholeProxy(port, "COMMIT");
      database = connection(databaseName, proxy.port, runtimePassword);
      store = new OrderStore(database);
      await database.resource.start(AbortSignal.timeout(5_000));
      let unknownCode;
      try {
        await store.confirm(unknownConfirm);
      } catch (error) {
        unknownCode = error?.code;
      }
      assert.equal(unknownCode, "TRANSACTION_OUTCOME_UNKNOWN");
      const droppedCommitReply = await proxy.waitForReplyDropped(5_000);
      assert.equal(droppedCommitReply.command, "COMMIT");
      await closeDatabase(database);
      database = undefined;
      store = undefined;
      await proxy.close();
      proxy = undefined;

      // Restart a fresh Orders store against PostgreSQL and resolve only by the exact request hash.
      database = connection(databaseName, port, runtimePassword);
      store = new OrderStore(database);
      await database.resource.start(AbortSignal.timeout(5_000));
      const exactReplay = await store.precheck(unknownConfirm.identity, canonicalRequestHash({orderRef:unknownConfirm.orderRef, expectedVersion:unknownConfirm.expectedVersion}), randomUUID());
      assert.equal(exactReplay.kind, "completed");
      assert.equal(exactReplay.response.status, 200);
      assert.equal(exactReplay.response.body.status, "Confirmed");
      assert.equal(exactReplay.response.body.version, "3");
      const durableUnknown = (await admin.query(`SELECT
        (SELECT status FROM orders.orders WHERE order_ref=$1) AS status,
        (SELECT version::text FROM orders.orders WHERE order_ref=$1) AS version,
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref=$1 AND event_type='OrderConfirmed') AS confirm_history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref=$1) AS desired,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref=$1 AND state='Pending') AS pending_outbox,
        (SELECT count(*)::int FROM orders.idempotency_records WHERE actor_ref=$2 AND scope=$3 AND idempotency_key=$4 AND state='Completed') AS completed_idempotency`,
        [unknownConfirm.orderRef, unknownConfirm.identity.actorRef, unknownConfirm.identity.scope, unknownConfirm.identity.key])).rows[0];
      assert.deepEqual(durableUnknown, {status:"Confirmed", version:"3", confirm_history:1, desired:1, pending_outbox:1, completed_idempotency:1});

      // Same-key Confirm calls serialize to one commit and one exact idempotent replay.
      const concurrentConfirmOrder = await store.createDraft({...meta(), customer});
      const concurrentItem = proof(5), concurrentRequest = request("1", concurrentItem);
      await store.putItem({...meta(), orderRef:concurrentConfirmOrder.body.orderRef, itemRef:ref("itm"), expectedVersion:"1", request:concurrentRequest, item:concurrentItem});
      const confirmCommand = {...meta(), orderRef:concurrentConfirmOrder.body.orderRef, expectedVersion:"2"};
      const confirmResults = await Promise.all([store.confirm(confirmCommand), store.confirm(confirmCommand)]);
      assert.equal(confirmResults.filter(result => !result.replayed).length, 1);
      assert.equal(confirmResults.filter(result => result.replayed).length, 1);
      assert.deepEqual(confirmResults[0].body, confirmResults[1].body);
      const confirmations = (await admin.query("SELECT count(*)::int AS count FROM orders.outbox_messages WHERE aggregate_ref=$1", [concurrentConfirmOrder.body.orderRef])).rows[0].count;
      assert.equal(confirmations, 1);
    } finally {
      await closeDatabase(database);
      await proxy?.close();
    }
  });
});
