import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomBytes, randomUUID, createHash} from "node:crypto";
import {canonicalJson, canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {createSqlInboxStore} from "../../packages/platform-inbox/dist/index.js";
import {processKafkaRecord} from "../../packages/platform-kafka-runtime/dist/index.js";
import {toInstant} from "../../packages/platform-time/dist/index.js";
import {Client} from "pg";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

export const DATABASE = "coffee_platform_orders";
export const ROLE = "coffee_orders_prepare_rw";
export const ROLES = ["coffee_orders_migrator", "coffee_orders_service_rw", ROLE,
  "coffee_orders_observer_rw", "coffee_orders_convergence_rw"];
export const MIGRATIONS = [
  "0001_create_orders", "0002_create_order_items", "0003_create_order_history",
  "0004_create_order_contributions", "0005_create_orders_idempotency", "0006_create_orders_outbox",
  "0007_order_grind_selection", "0008_create_orders_inbox", "0009_create_catalog_mapping_projection",
  "0010_create_cart_desired", "0011_create_cart_observed", "0012_create_convergence_attempts",
  "0013_create_convergence_leases", "0014_create_mutation_reservations",
  "0015_create_order_aroma_projections", "0016_create_aroma_work_schedules",
  "0017_allow_cart_outbox", "0018_guard_order_card_projection","0019_read_guarded_aroma_card","0020_guard_cart_fact_batches","0021_optimize_observed_format_checks","0022_terminal_cart_item_rejection","0023_ascii_observed_identity",
];
const pool = {max: 2, checkoutTimeoutMs: 2_000, lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000, backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000, transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000, maxLifetimeMs: 1_800_000};

export const ref = prefix => `${prefix}_${randomBytes(13).toString("hex").toUpperCase()}`;
export const trace = "00-11111111111111111111111111111111-2222222222222222-01";
export const live = {timeout: 180_000, skip: process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false};
export const customer = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
function envelope(type, payload, aggregate, producer) {
  return {envelopeVersion: "1", messageId: ref("msg"), messageType: type, occurredAt: new Date().toISOString(),
    producer, correlationId: randomUUID(), causationId: null, traceparent: trace, aggregate, payload};
}
export function mapping(product, revision = "1", changes = {}) {
  const payload = {productRef: product.product, variantRef: product.variant, offerRef: product.offer,
    mappingRevision: revision, catalogSnapshotRevision: revision, mappingState: "Active", availability: "Available",
    effectiveAt: "2026-10-03T00:00:00Z", ...changes};
  return envelope("CatalogMappingChanged.v2", payload, {type: "CatalogMapping", ref: product.product, version: revision === "0" ? "1" : revision}, "catalog-activation-worker");
}
export const product = () => ({product: ref("prd"), variant: ref("var"), offer: ref("off")});

export async function fixture(run, options = {}) {
  const {createAromaPreparationStore} = await import("../../apps/orders-aroma-preparation/dist/infrastructure/preparation-store.js");
  const {decodeAromaPreparationEnvelope} = await import("../../apps/orders-aroma-preparation/dist/application/messages.js");
  const receipt = await withCatalogPostgres(async ({adminClient, port, container}) => {
    const passwords = new Map();
    for (const role of ROLES) {
      const password = randomBytes(24).toString("hex"); passwords.set(role, password);
      await adminClient.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    await adminClient.query(`CREATE DATABASE ${DATABASE} OWNER coffee_orders_migrator`);
    await adminClient.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
    await adminClient.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLE},coffee_orders_service_rw,coffee_orders_convergence_rw`);
    const migrator = new Client({host: "127.0.0.1", port, database: DATABASE, user: "coffee_orders_migrator",
      password: passwords.get("coffee_orders_migrator"), connectionTimeoutMillis: 2_000, ssl: false});
    const open = async (role = ROLE, connectionPort = port) => {
      const database = createDatabase({owner: role === ROLE ? "orders-aroma-preparation" : "orders-service", database: DATABASE, allowedDatabase: DATABASE,
        host: "127.0.0.1", port: connectionPort, user: role, password: passwords.get(role), ssl: false, pool, shutdownGraceMs: 40_000});
      await database.resource.start(AbortSignal.timeout(5_000)); return database;
    };
    let database;
    let core;
    try {
      await migrator.connect(); await migrator.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      for (const id of MIGRATIONS) await migrator.query(await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`, import.meta.url), "utf8"));
      database = await open(); core = await open("coffee_orders_service_rw");
      const settings = {batchSize: 100, maxOrders: 100, maxLines: 1000, maxSnapshotAgeMs: 60_000, ...options};
      let store = createAromaPreparationStore(database, settings);
      const tx = callback => withTransaction(database, {mode: "background"}, callback);
      const query = (text, values = []) => migrator.query(text, values);
      const read = async (text, values = []) => (await query(text, values)).rows;
      let offset = 0;
      let commits = 0;
      const groups = {"CatalogMappingChanged.v2": "orders-catalog-mapping-v2", "OrderConfirmed.v1": "orders-aroma-preparation-v1",
        "OrderReconciliationRequested.v1": "orders-aroma-preparation-v1", "AromaObservationChanged.v1": "orders-aroma-projection-v1", "AromaConvergenceChanged.v1": "orders-aroma-projection-v1"};
      const topics = {"orders-catalog-mapping-v2": "coffee.catalog.mapping.v2", "orders-aroma-preparation-v1": "coffee.orders.lifecycle.v1", "orders-aroma-projection-v1": "coffee.aroma.cart.events.v1"};
      const deliver = async (message, extra = {}) => {
        const groupId = extra.groupId ?? groups[message.messageType];
        const topic = topics[groupId];
        const record = {topic, partition: 0, offset: String(offset++), key: message.aggregate.ref, value: canonicalJson(message), headers: {}, ...extra.record};
        await processKafkaRecord(record, {runtime: "orders-aroma-preparation", groupId, topics: [topic], leaseMs: 60_000,
          maxMessageBytes: 1_048_576, signal: extra.signal ?? new AbortController().signal,
          binding: {processing: "durable", database, inbox: createSqlInboxStore(database, {schema: "orders", consumerName: groupId}),
            decode: decodeAromaPreparationEnvelope, handle: async (transaction, decoded, actualRecord, signal) => {
              assert.equal(actualRecord.groupId, undefined, "real KafkaRecord must not acquire an invented groupId");
              await store.handle(transaction, decoded, actualRecord, signal);
            }}, commit: async () => {commits++; if (extra.commit) await extra.commit();}});
        return record;
      };
      const restart = async (connectionPort = port) => {await database.resource.stop(AbortSignal.timeout(5_000)); database = await open(ROLE,connectionPort); store = createAromaPreparationStore(database, settings);};
      const seed = async (items, {contribute = true} = {}) => {
        const order = ref("ord");
        await query(`INSERT INTO orders.orders(order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,currency,created_by_actor_ref,last_modified_by_actor_ref)
          VALUES($1,$2,1,'fixture','Active',$3,'RUB','fixture','fixture')`, [order, customer, "a".repeat(64)]);
        let position = 0;
        const rows = [];
        for (const item of items) {
          const itemRef = ref("itm"); const quantity = item.quantity ?? "1000"; const grind = item.grind ?? null; const hash = canonicalRequestHash({itemRef});
          await query(`INSERT INTO orders.order_items(order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,
            internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency,source_grind_key_hash,grind_display_name)
            VALUES($1,$2,$3,$4,$5,'fixture','piece',$6::bigint,$7,1,$8,$8,clock_timestamp()+interval '1 hour',$9,1,1,$10,0,0,'RUB',$11,$12)`,
          [order,itemRef,++position,item.product,item.variant,quantity,ref("prq"),hash,ref("pvr"),item.offer,grind,grind === null ? null : "fixture grind"]);
          rows.push({itemRef, offer: item.offer, grind, quantity, hash});
        }
        const saved = await read("UPDATE orders.orders SET status='Confirmed',version=2,projection_version=2,confirmed_at=clock_timestamp() WHERE order_ref=$1 RETURNING confirmed_at::text", [order]);
        const confirmedAt = toInstant(saved[0].confirmed_at.replace(" ", "T")).toString({fractionalSecondDigits: 3});
        const addContribution = async () => {
          await query("INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version) VALUES($1,1,2)", [order]);
          for (const row of rows) await query(`INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,quantity_milli,contribution_hash,item_refs,source_grind_key_hash)
            VALUES($1,1,$2,$3::bigint,$4,$5,$6)`, [order,row.offer,row.quantity,row.hash,[row.itemRef],row.grind]);
        };
        if (contribute) await addContribution();
        const confirmed = envelope("OrderConfirmed.v1", {orderRef: order,orderVersion: "2",customerRef: customer,confirmedAt,contributionRevision: "1"}, {type: "Order",ref: order,version: "2"}, "orders-service");
        return {order,rows,confirmed,addContribution};
      };
      const card = async order => (await read("SELECT p.*,o.version::text AS business_version,o.projection_version::text AS card_version FROM orders.order_aroma_projections p JOIN orders.orders o USING(order_ref) WHERE p.order_ref=$1", [order]))[0];
      const current = async () => (await read("SELECT desired_revision::text,desired_hash FROM orders.cart_desired_revisions WHERE state='Current'"))[0];
      const observe = async ({stale = false, lines} = {}) => {
        const desired = await current();
        const revision = (await read("SELECT (COALESCE(max(observed_revision),0)+1)::text AS revision FROM orders.cart_observed_revisions"))[0].revision;
        const cartLines = lines ?? await read("SELECT offer_ref,source_grind_key_hash,quantity_milli::text FROM orders.cart_desired_lines WHERE desired_revision=$1 ORDER BY offer_ref,source_grind_key_hash NULLS FIRST", [desired.desired_revision]);
        const fingerprint = canonicalRequestHash(cartLines);
        await query("BEGIN");
        try {
          await query("UPDATE orders.cart_observed_revisions SET state='Superseded' WHERE state='Current'");
          await query(`INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,cart_fingerprint,captured_at,complete,source_kind,provider_snapshot_ref)
            VALUES('aroma-primary',$1,'Current',$2,clock_timestamp()-($3::int*interval '1 second'),true,'Observer',$4)`, [revision,fingerprint,stale ? 120 : 0,ref("snapshot")]);
          for (const line of cartLines) await query(`INSERT INTO orders.cart_observed_lines(cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash)
            VALUES('aroma-primary',$1,$2,$3,$4,$5)`, [revision,line.offer_ref,line.source_grind_key_hash,line.quantity_milli,canonicalRequestHash(line)]);
          await query("COMMIT");
        } catch (error) {await query("ROLLBACK"); throw error;}
        const saved = (await read("SELECT captured_at::text FROM orders.cart_observed_revisions WHERE observed_revision=$1", [revision]))[0];
        const changed = envelope("AromaObservationChanged.v1", {cartScopeRef: "aroma-primary",observedRevision: revision,observedAt: toInstant(saved.captured_at.replace(" ","T")).toString(),observationState: "Complete",cartFingerprint: fingerprint}, {type: "AromaCart",ref: "aroma-primary",version: revision}, "aroma-observer");
        return {revision,fingerprint,changed};
      };
      const proof = async (obs, {state = "NoOpInSync", epoch = "1", active = false, reserve = false} = {}) => {
        const wanted = await current(); const owner = randomUUID(); const attempt = ref("att");
        await query(`INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,expires_at) VALUES('aroma-primary',$1,$2,clock_timestamp()+($3::int*interval '1 second'))
          ON CONFLICT(cart_scope_ref) DO UPDATE SET owner_instance_id=EXCLUDED.owner_instance_id,fence_epoch=EXCLUDED.fence_epoch,expires_at=EXCLUDED.expires_at,heartbeat_at=clock_timestamp()`, [owner,epoch,active ? 60 : -1]);
        const line = (await read("SELECT * FROM orders.cart_desired_lines WHERE desired_revision=$1 ORDER BY offer_ref,source_grind_key_hash NULLS FIRST LIMIT 1", [wanted.desired_revision]))[0];
        await query(`INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state,observed_start_revision,selected_action,selected_offer_ref,selected_source_grind_key_hash,ended_at,failure_code,blocker_codes)
          VALUES($1,'aroma-primary',$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $11 THEN clock_timestamp() ELSE NULL END,$12,$13)`,
        [attempt,wanted.desired_revision,wanted.desired_hash,owner,epoch,reserve ? "MutationReserved" : state,obs.revision,
          reserve ? "SetQuantity" : null,reserve ? line.offer_ref : null,reserve ? line.source_grind_key_hash : null,
          !reserve && ["NoOpInSync","OutOfSync","Blocked","Failed","UnknownOutcome"].includes(state),state === "Failed" ? "AROMA_GET_FAILED" : null, state === "Blocked" ? '["MAPPING_MISSING"]' : '[]']);
        let operation;
        if (reserve) {
          operation = ref("op");
          const baseline = (await read("SELECT quantity_milli::text FROM orders.cart_observed_lines WHERE observed_revision=$1 AND offer_ref=$2 AND source_grind_key_hash IS NOT DISTINCT FROM $3::char(64)",[obs.revision,line.offer_ref,line.source_grind_key_hash]))[0]?.quantity_milli ?? "0";
          await query(`INSERT INTO orders.mutation_reservations(operation_ref,attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_before_revision,action,offer_ref,source_grind_key_hash,observed_before_milli,desired_milli,target_provider_quantity,request_hash,reserved_until,provider_deadline_at,safety_margin_ms,state)
            VALUES($1,$2,'aroma-primary',$3,$4,$5,'SetQuantity',$6,$7,$8,$9,$9::bigint/1000,$10,clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '1 minute',1000,'Reserved')`,
          [operation,attempt,wanted.desired_revision,epoch,obs.revision,line.offer_ref,line.source_grind_key_hash,baseline,line.quantity_milli,"a".repeat(64)]);
        }
        const changed = envelope("AromaConvergenceChanged.v1", {cartScopeRef: "aroma-primary",desiredRevision: wanted.desired_revision,observedRevision: obs.revision,attemptRef: attempt,attemptState: reserve ? "UnknownOutcome" : state,changedAt: new Date().toISOString(),blockerCodes: []}, {type: "AromaCart",ref: "aroma-primary",version: epoch}, "aroma-convergence");
        return {attempt,operation,changed,owner,epoch};
      };
      const acceptIntent = async order => {
        const saved = (await read("UPDATE orders.orders SET version=version+1 WHERE order_ref=$1 RETURNING version::text", [order]))[0];
        const requestedAt = (await read("SELECT clock_timestamp()::text AS now"))[0].now;
        const at = toInstant(requestedAt.replace(" ","T")).toString({fractionalSecondDigits: 3});
        const event = envelope("OrderReconciliationRequested.v1", {orderRef: order,orderVersion: saved.version,requestedAt: at}, {type: "Order",ref: order,version: saved.version}, "orders-service");
        await query(`INSERT INTO orders.order_history(history_ref,order_ref,order_version,event_type,actor_ref,correlation_id,occurred_at,facts) VALUES($1,$2,$3,'ReconciliationRequested','fixture',$4,$5,'{"requestKind":"OperatorRequested"}')`, [ref("htr"),order,saved.version,event.correlationId,at]);
        const bytes = Buffer.from(canonicalJson(event));
        const seq = (await read("SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS seq FROM orders.outbox_messages WHERE aggregate_ref=$1", [order]))[0].seq;
        await query(`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,lease_until)
          VALUES($1,'OrderReconciliationRequested.v1','coffee.orders.lifecycle.v1',$2::varchar(30),$3::bigint,$4::text,$2::text,'1',$5::bytea,$6::char(64),$7::jsonb,$8::jsonb,$9::char(64),$10::timestamptz,$11::text,NULL,$12::text,clock_timestamp())`,
        [event.messageId,order,seq,saved.version,bytes,createHash("sha256").update(bytes).digest("hex"),JSON.stringify(event),JSON.stringify(event.payload),canonicalRequestHash(event),at,event.correlationId,trace]);
        return event;
      };
      const publisherConnection={owner:'orders-aroma-preparation',database:DATABASE,allowedDatabase:DATABASE,host:'127.0.0.1',port,user:ROLE,password:passwords.get(ROLE),ssl:false,pool,shutdownGraceMs:40000};
      return await run({get store() {return store;},container,publisherConnection,port,database: () => database, core,tx,query,read,deliver,restart,seed,card,current,observe,proof,acceptIntent,commits: () => commits,runtimeCredential:role=>({username:role,password:passwords.get(role)})});
    } finally {if (database) await database.resource.stop(AbortSignal.timeout(5_000)); if (core) await core.resource.stop(AbortSignal.timeout(5_000)); await migrator.end();}
  });
  assert.equal(receipt.cleanup.containerRemoved,true);
  return receipt;
}

