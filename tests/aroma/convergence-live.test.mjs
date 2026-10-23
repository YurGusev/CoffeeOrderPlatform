import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {randomBytes, createHash} from "node:crypto";
import {Client} from "pg";
import {load as parse} from "js-yaml";
import {createDatabase, withTransaction} from "../../packages/platform-database/dist/index.js";
import {defineStatement} from "../../packages/platform-database/dist/owner.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";
import {createSqlOutboxStore} from "../../packages/platform-outbox/dist/index.js";
import {createSqlInboxStore} from "../../packages/platform-inbox/dist/index.js";
import {processKafkaRecord} from "../../packages/platform-kafka-runtime/dist/index.js";
import {canonicalJson, canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {isAromaOwnerMessage} from "../../packages/contracts/aroma-v1/dist/index.js";

const MIGRATIONS = ["0001_create_orders", "0002_create_order_items", "0003_create_order_history", "0004_create_order_contributions", "0005_create_orders_idempotency", "0006_create_orders_outbox", "0007_order_grind_selection", "0008_create_orders_inbox", "0009_create_catalog_mapping_projection", "0010_create_cart_desired", "0011_create_cart_observed", "0012_create_convergence_attempts", "0013_create_convergence_leases", "0014_create_mutation_reservations", "0015_create_order_aroma_projections", "0016_create_aroma_work_schedules", "0017_allow_cart_outbox", "0018_guard_order_card_projection","0019_read_guarded_aroma_card","0020_guard_cart_fact_batches","0021_optimize_observed_format_checks","0022_terminal_cart_item_rejection","0023_ascii_observed_identity"];
const ROLE = "coffee_orders_convergence_rw", DATABASE = "coffee_platform_orders", SCOPE = "aroma-primary";
const OFFER = "off_00000000000000000000000001", H = "a".repeat(64);
const OWNER = "00000000-0000-4000-8000-000000000001";
const signal = new AbortController().signal;
const pool = {max:4, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000};
const settings = parse(await readFile(new URL("../../config/platform.yaml",import.meta.url),"utf8")).services["aroma-convergence"];
const options = {ownerInstanceId:OWNER,mutationsEnabled:true,...Object.fromEntries(Object.entries(settings.aromaConvergence).filter(([key])=>key!=="pollIntervalMs"))};
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

void test("convergence owner-role PostgreSQL + controlled fake Gateway", {timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF!=="1"?"disposable PostgreSQL required":false}, async t => {
  const receipt = await withCatalogPostgres(async ({adminClient, port}) => {
    const passwords = new Map();
    for (const role of ["coffee_orders_migrator", "coffee_orders_service_rw", "coffee_orders_prepare_rw", "coffee_orders_observer_rw", ROLE]) {
      const password = randomBytes(24).toString("hex"); passwords.set(role,password);
      await adminClient.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    await adminClient.query(`CREATE DATABASE ${DATABASE} OWNER coffee_orders_migrator`);
    await adminClient.query(`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC`);
    await adminClient.query(`GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLE},coffee_orders_observer_rw`);
    const db = new Client({host:"127.0.0.1",port,database:DATABASE,user:"coffee_orders_migrator",password:passwords.get("coffee_orders_migrator"),ssl:false});
    let runtime;
    try {
      await db.connect();
      for (const id of MIGRATIONS) await db.query(await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`,import.meta.url),"utf8"));
      runtime = createDatabase({owner:"aroma-convergence",database:DATABASE,allowedDatabase:DATABASE,host:"127.0.0.1",port,user:ROLE,password:passwords.get(ROLE),ssl:false,pool,shutdownGraceMs:40_000});
      await runtime.resource.start(signal);
      const tx = callback => withTransaction(runtime,{mode:"background",signal},callback);
      await t.test("real non-superuser role can write convergence facts, never per-Order projection/history",async () => {
        const identity=defineStatement(runtime,"SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
        assert.deepEqual((await tx(tr => identity(tr,[]))).rows,[{role:ROLE,rolsuper:false,rolbypassrls:false}]);
        for (const sql of ["UPDATE orders.order_aroma_projections SET projection_version=projection_version WHERE false", "SELECT * FROM orders.order_aroma_projection_history LIMIT 0", "UPDATE orders.orders SET version=version WHERE false"]) {
          const query=defineStatement(runtime,sql);
          await assert.rejects(tx(tr => query(tr,[])),error => error.sqlState==="42501");
        }
      });
      await t.test("strict frozen request schema preserves IDs and rejects unsupported/producer/key/extra fields",async () => {
        const {decodeAromaConvergenceEnvelope}=await import("../../apps/aroma-convergence/dist/application/messages.js");
        const value={envelopeVersion:"1",messageId:"msg_00000000000000000000000001",messageType:"AromaConvergenceRequested.v1",occurredAt:"2026-10-01T00:00:00Z",producer:"orders-aroma-preparation",correlationId:OWNER,causationId:null,traceparent:`00-${"a".repeat(32)}-${"b".repeat(16)}-01`,aggregate:{type:"AromaCart",ref:SCOPE,version:"7"},payload:{cartScopeRef:SCOPE,desiredRevision:"1",reason:"Recovery",orderRef:null}};
        assert.equal(decodeAromaConvergenceEnvelope(value),value);
        for (const bad of [{...value,messageType:"OrderConfirmed.v1"},{...value,producer:"aroma-convergence"},{...value,messageId:"msg_bad"},{...value,extra:true},{...value,payload:{...value.payload,extra:true}},{...value,aggregate:{...value.aggregate,ref:"other"}}]) assert.throws(()=>decodeAromaConvergenceEnvelope(bad),TypeError);
      });
      const time=(await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).rows[0].now;
      const payload={cartScopeRef:SCOPE,observedRevision:"1",observedAt:time,observationState:"Complete",cartFingerprint:H};
      const envelope={envelopeVersion:"1",messageId:"msg_00000000000000000000000002",messageType:"AromaObservationChanged.v1",occurredAt:time,producer:"aroma-convergence",correlationId:OWNER,causationId:null,traceparent:`00-${"a".repeat(32)}-${"b".repeat(16)}-01`,aggregate:{type:"AromaCart",ref:SCOPE,version:"1"},payload};
      const message={messageId:envelope.messageId,messageType:envelope.messageType,topic:"coffee.aroma.cart.events.v1",aggregateRef:SCOPE,aggregateSequence:1n,ownerVersion:"1",partitionKey:SCOPE,schemaVersion:"1",envelope,payload,occurredAt:time,correlationId:OWNER,traceparent:envelope.traceparent};
      await t.test("required Outbox factory must enqueue a schema-valid cart event on frozen Orders schema",async gate => {
        gate.diagnostic(JSON.stringify((await db.query("SELECT column_name,is_nullable,column_default FROM information_schema.columns WHERE table_schema='orders' AND table_name='outbox_messages' AND column_name IN ('envelope_bytes','envelope_hash') ORDER BY column_name")).rows));
        const outbox=createSqlOutboxStore(runtime,{schema:"orders",envelopeBytes:true});
        // This is deliberately a POSITIVE prerequisite. Expecting 23502 would hide
        // the broken lane contract and falsely report store/fake-Gateway GREEN.
        const rollback = new Error("successful prerequisite rollback");
        await assert.rejects(tx(async tr => {assert.equal(await outbox.enqueue(tr,message),"created");throw rollback;}),error=>error===rollback);
      });
      await t.test("cart aggregate must be accepted by actual Outbox FK when exact bytes/hash are supplied",async gate => {
        gate.diagnostic(JSON.stringify((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='orders.outbox_messages'::regclass AND contype='f'")).rows));
        // Diagnostic-only explicit insert isolates the independent FK blocker;
        // the production store continues using the mandated shared factory.
        const insert=defineStatement(runtime,`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,traceparent,lease_until) VALUES($1,$2,$3,$4::varchar(30),1,'1',$4::text,'1',$5,$6,$7::jsonb,$8::jsonb,$6,$9::timestamptz,$10,$11,clock_timestamp())`);
        const rollback = new Error("successful diagnostic rollback");
        await assert.rejects(tx(async tr => {await insert(tr,[envelope.messageId,envelope.messageType,message.topic,SCOPE,Buffer.from(canonicalJson(envelope)),canonicalRequestHash(envelope),canonicalJson(envelope),canonicalJson(payload),time,OWNER,envelope.traceparent]);throw rollback;}),error=>error===rollback);
      });
      await t.test("durable no-op is proved by exact full vectors, not Desired hash versus fingerprint",async () => {
        const {createAromaConvergenceStore}=await import("../../apps/aroma-convergence/dist/infrastructure/convergence-store.js");
        await db.query("BEGIN");
        await db.query("INSERT INTO orders.cart_desired_revisions VALUES($1,1,'Current',$2,0,transaction_timestamp())",[SCOPE,H]);
        await db.query("INSERT INTO orders.cart_desired_lines VALUES($1,1,$2,NULL,1000,$3,'[]'::jsonb)",[SCOPE,OFFER,H]);
        await db.query("INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,reason,next_attempt_at) VALUES($1,1,'Recovery',transaction_timestamp())",[SCOPE]);
        await db.query("COMMIT");
        let mutations=0;
        const gateway={read:async()=>{
          const capturedAt=(await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).rows[0].now;
          const lines=[{offerRef:OFFER,quantity:"1"}];
          return {cartScopeRef:SCOPE,capturedAt,providerSnapshotRef:`aroma-gateway:cart-body-sha256:${H}`,cartFingerprint:hash(lines),lines};
        },setQuantity:async()=>{mutations++;},remove:async()=>{mutations++;}};
        const store=createAromaConvergenceStore(runtime,options);
        await store.recover(signal);
        let result;
        try {result=await store.runOnce(gateway,signal);}
        catch (error) {
          assert.equal(mutations,0,"Outbox prerequisite failure must not reach an unsafe call");
          assert.equal((await db.query("SELECT count(*) FROM orders.cart_observed_revisions")).rows[0].count,"0","snapshot transaction rolls back with its failed Outbox write");
          assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages")).rows[0].count,"0");
          throw error;
        }
        assert.equal(result,"attempted");
        assert.equal(mutations,0);
        const attempt=(await db.query("SELECT * FROM orders.convergence_attempts")).rows[0];
        assert.equal(attempt.state,"NoOpInSync");
        assert.match(attempt.attempt_ref,/^att_[0-9A-HJKMNP-TV-Z]{26}$/u);
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,false);
        assert.equal((await db.query("SELECT count(*) FROM orders.mutation_reservations")).rows[0].count,"0");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,"1");
        assert.equal(await store.runOnce(gateway,signal),"idle");
      });
      const {createAromaConvergenceStore} = await import("../../apps/aroma-convergence/dist/infrastructure/convergence-store.js");
      const OTHER = "off_00000000000000000000000002", GRIND = "b".repeat(64);
      const owner2 = "00000000-0000-4000-8000-000000000002";
      const pgNow = async () => (await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).rows[0].now;
      const line = (offerRef, quantity, sourceGrindKeyHash) => ({offerRef, quantity, ...(sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash})});
      const snapshot = async lines => ({cartScopeRef:SCOPE,capturedAt:await pgNow(),providerSnapshotRef:`aroma-gateway:cart-body-sha256:${hash(lines)}`,cartFingerprint:hash(lines),lines});
      const freshDesired = async (lines, codes = []) => {
        await db.query("BEGIN");
        try {
          await db.query("SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))");
          const revision = (await db.query("SELECT (COALESCE(max(desired_revision),0)+1)::text AS revision FROM orders.cart_desired_revisions")).rows[0].revision;
          await db.query("UPDATE orders.cart_desired_revisions SET state='Superseded' WHERE state='Current'");
          await db.query("INSERT INTO orders.cart_desired_revisions VALUES($1,$2,'Current',$3,0,clock_timestamp())",[SCOPE,revision,hash({lines,codes})]);
          for (const value of lines) await db.query("INSERT INTO orders.cart_desired_lines VALUES($1,$2,$3,$4,$5,$6,'[]'::jsonb)",[SCOPE,revision,value.offerRef,value.sourceGrindKeyHash??null,value.quantityMilli,H]);
          if(codes.length) {
            const orderRef="ord_00000000000000000000000003";
            await db.query("INSERT INTO orders.orders(order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref) VALUES($1,'cus_00000000000000000000000001',1,'Disposable fixture','Active',$2,'fixture','fixture') ON CONFLICT DO NOTHING",[orderRef,H]);
            for(const code of codes) await db.query("INSERT INTO orders.cart_desired_blockers VALUES($1,$2,$3,'prd_00000000000000000000000001','var_00000000000000000000000001',$4,1)",[SCOPE,revision,orderRef,code]);
          }
          await db.query(`INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,reason,next_attempt_at) VALUES($1,$2,'Recovery',clock_timestamp())
            ON CONFLICT(cart_scope_ref) DO UPDATE SET desired_revision=EXCLUDED.desired_revision,dirty=true,wake_revision=orders.convergence_work.wake_revision+1,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()`,[SCOPE,revision]);
          await db.query("COMMIT");
          return revision;
        } catch(error) {await db.query("ROLLBACK");throw error;}
      };
      const target = (offerRef = OFFER, quantityMilli = "1000", sourceGrindKeyHash) => ({offerRef,quantityMilli,...(sourceGrindKeyHash===undefined?{}:{sourceGrindKeyHash})});
      const reset = async (lines = [target()], codes = []) => {
        await db.query("TRUNCATE orders.cart_desired_revisions,orders.cart_observed_revisions,orders.convergence_leases,orders.convergence_work,orders.catalog_mapping_projection,orders.outbox_messages CASCADE");
        await freshDesired(lines,codes);
        for (const [index,offerRef] of [OFFER,OTHER].entries()) await db.query("INSERT INTO orders.catalog_mapping_projection VALUES($1,$2,$3,1,1,'Active','Available',clock_timestamp(),'fixture',$4)",[`prd_${String(index+1).padStart(26,'0')}`,`var_${String(index+1).padStart(26,'0')}`,offerRef,H]);
      };
      const facts = async () => ({attempts:(await db.query("SELECT * FROM orders.convergence_attempts ORDER BY started_at,attempt_ref")).rows,reservations:(await db.query("SELECT * FROM orders.mutation_reservations ORDER BY reserved_at,operation_ref")).rows});
      const due = async () => {await db.query("UPDATE orders.convergence_work SET next_attempt_at=clock_timestamp() WHERE dirty");};
      const waitBarrier = async () => {
        await db.query("SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM max(reserved_until)-clock_timestamp()))+0.01) FROM orders.mutation_reservations");
        await due();
      };
      // Only disposable callback tests compress the deadline/window. Production
      // uses unchanged config/platform.yaml options; no service default is added.
      const short = {...options,providerDeadlineMs:1_000,safetyMarginMs:50};
      const fake = (initial = []) => {
        const cart = {lines:initial.map(value=>({...value})),reads:0,calls:[],beforeRead:undefined,beforeMutation:undefined};
        const lockProbe = async () => {
          await db.query("BEGIN");
          try {await db.query("SET LOCAL lock_timeout='500ms'");await db.query("SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))");}
          finally {await db.query("ROLLBACK");}
        };
        const mutate = async (action,offerRef,request,context) => {
          await lockProbe();
          context.signal.throwIfAborted();
          cart.calls.push({action,offerRef,request});
          if(cart.beforeMutation) await cart.beforeMutation({action,offerRef,request,context});
          const key = value => value.offerRef===offerRef && value.sourceGrindKeyHash===request.sourceGrindKeyHash;
          cart.lines=cart.lines.filter(value=>!key(value));
          if(action==="SetQuantity") cart.lines.push(line(offerRef,request.quantity,request.sourceGrindKeyHash));
          return {operationRef:request.operationRef,cartScopeRef:SCOPE,offerRef,state:"Acknowledged",...(request.sourceGrindKeyHash===undefined?{}:{sourceGrindKeyHash:request.sourceGrindKeyHash})};
        };
        cart.catalogReads=0;cart.beforeCatalog=undefined;
        cart.gateway={catalogInput:async(productRef,variantRef,context)=>{
          await lockProbe();context.signal.throwIfAborted();cart.catalogReads++;
          const mapping=(await db.query("SELECT * FROM orders.catalog_mapping_projection WHERE product_ref=$1 AND variant_ref=$2",[productRef,variantRef])).rows[0];
          const proof={productRef,variantRef,offerRef:mapping.offer_ref,snapshotRevision:String(mapping.catalog_snapshot_revision),mappingRevision:String(mapping.mapping_revision),supplierUnitMinor:"1",currency:"RUB",unit:"piece",availability:"Available",displayName:"Fixture",grindOptions:[{sourceGrindKeyHash:GRIND,displayName:"Fixture grind"}]};
          return cart.beforeCatalog ? cart.beforeCatalog(proof,context) : proof;
        },read:async context=>{await lockProbe();cart.reads++;if(cart.beforeRead) await cart.beforeRead(context);return snapshot(cart.lines);},setQuantity:(...args)=>mutate("SetQuantity",...args),remove:(...args)=>mutate("Remove",...args)};
        return cart;
      };
      await t.test("SQL no-op equality preserves absent versus present grind identity",async () => {
        await reset([target(OFFER,"1000"),target(OFFER,"1000",GRIND)]);
        const cart=fake([line(OFFER,"1"),line(OFFER,"1",GRIND)]);
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,0);
        assert.equal((await facts()).attempts[0]?.state,"NoOpInSync");
      });
      const isCopyStream = value => value !== null && typeof value === "object" &&
        typeof value.write === "function" && typeof value._final === "function";
      const afterCopy = (stream, hook, complete = () => {}) => {
        const final = stream._final;
        stream._final = function (callback) {
          return final.call(this,error => {
            if(error) return callback(error);
            Promise.resolve().then(hook).then(()=>{complete();callback();},error=>callback(error));
          });
        };
      };
      await t.test("shared Observer and Convergence keep aggregate revisions separate from transport sequence",async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        const convergence=createAromaConvergenceStore(runtime,options);
        await convergence.recover(signal);
        assert.equal(await convergence.runOnce(cart.gateway,signal),"attempted");
        await freshDesired([target()]);
        assert.equal(await convergence.runOnce(cart.gateway,signal),"attempted");

        const observerRuntime=createDatabase({owner:"aroma-observer",database:DATABASE,allowedDatabase:DATABASE,
          host:"127.0.0.1",port,user:"coffee_orders_observer_rw",password:passwords.get("coffee_orders_observer_rw"),ssl:false,pool,shutdownGraceMs:40_000});
        await observerRuntime.resource.start(signal);
        try {
          const {createAromaObservationStore}=await import("../../apps/aroma-observer/dist/infrastructure/observation-store.js");
          const observer=createAromaObservationStore(observerRuntime,{ownerInstanceId:owner2,intervalMs:5_000,leaseMs:30_000,maxSnapshotAgeMs:15_000,maxLines:10_000});
          await observer.recover(signal);
          assert.equal(await observer.runOnce({read:async()=>snapshot([line(OFFER,"1")])},signal),"observed");
        } finally {await observerRuntime.resource.stop(AbortSignal.timeout(5_000));}

        const observations=(await db.query(`SELECT aggregate_sequence::text AS sequence,owner_version,
          envelope#>>'{aggregate,version}' AS aggregate_version,payload#>>'{observedRevision}' AS observed_revision,envelope
          FROM orders.outbox_messages WHERE message_type='AromaObservationChanged.v1' ORDER BY aggregate_sequence`)).rows;
        assert.deepEqual(observations.map(({sequence,owner_version,aggregate_version,observed_revision})=>
          [sequence,owner_version,aggregate_version,observed_revision]),[["1","1","1","1"],["3","2","2","2"],["5","3","3","3"]]);
        for(const row of observations) assert.equal(isAromaOwnerMessage(row.envelope),true);
        const convergenceEvents=(await db.query(`SELECT aggregate_sequence::text AS sequence,owner_version,
          envelope#>>'{aggregate,version}' AS aggregate_version,payload#>>'{observedRevision}' AS observed_revision,envelope
          FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1' ORDER BY aggregate_sequence`)).rows;
        assert.deepEqual(convergenceEvents.map(({sequence,owner_version,aggregate_version})=>[sequence,owner_version,aggregate_version]),[["2","2","2"],["4","4","4"]]);
        for(const row of convergenceEvents) assert.equal(isAromaOwnerMessage(row.envelope),true);
      });
      await t.test("capacity: 10000 complete lines, bounded wake-up storm and local Attempt at most 500ms",async cap=>{
        const lines=Array.from({length:10_000},(_,i)=>target(`off_${String(i+1).padStart(26,"0")}`));
        await reset(lines);
        const revision=(await db.query("SELECT desired_revision::text FROM orders.convergence_work")).rows[0].desired_revision;
        const store=createAromaConvergenceStore(runtime,options);
        const request={envelopeVersion:"1",messageId:"msg_00000000000000000000000009",messageType:"AromaConvergenceRequested.v1",occurredAt:await pgNow(),producer:"orders-aroma-preparation",correlationId:OWNER,causationId:null,traceparent:`00-${"a".repeat(32)}-${"b".repeat(16)}-01`,aggregate:{type:"AromaCart",ref:SCOPE,version:"1"},payload:{cartScopeRef:SCOPE,desiredRevision:revision,reason:"Recovery",orderRef:null}};
        for(let wake=0;wake<1000;wake++)await tx(transaction=>store.handleWake(transaction,request,signal));
        assert.equal((await db.query("SELECT count(*)::int AS count FROM orders.convergence_work")).rows[0].count,1);
        let providerMs=0,reads=0,mutations=0,active=0,peak=0;
        const gateway={read:async context=>{context.signal.throwIfAborted();active++;peak=Math.max(peak,active);reads++;const started=performance.now();
          try{return await snapshot(lines.map(value=>line(value.offerRef,"1")));}finally{providerMs+=performance.now()-started;active--; }},
          setQuantity:async()=>{mutations++;throw new Error("capacity no-op must not mutate");},remove:async()=>{mutations++;throw new Error("capacity no-op must not mutate");}};
        const heapBefore=process.memoryUsage().heapUsed;const peakBefore=process.resourceUsage().maxRSS;const started=performance.now();
        assert.equal(await store.runOnce(gateway,signal),"attempted");const totalMs=performance.now()-started;const localMs=totalMs-providerMs;
        assert.equal(reads,1);assert.equal(mutations,0);assert.equal(peak,1);assert.equal(active,0);
        assert.equal((await db.query("SELECT count(*)::int AS lines FROM orders.cart_observed_lines WHERE observed_revision=(SELECT observed_revision FROM orders.cart_observed_revisions WHERE state='Current')")).rows[0].lines,10000);
        assert.equal((await facts()).attempts.at(-1).state,"NoOpInSync");assert.equal(await store.runOnce(gateway,signal),"idle");
        cap.diagnostic(JSON.stringify({lines:10000,wakeups:1000,workRows:1,localAttemptMs:localMs,totalMs,providerMs,limitMs:500,peakInFlight:peak,heapGrowthBytes:process.memoryUsage().heapUsed-heapBefore,peakRssGrowthKiB:process.resourceUsage().maxRSS-peakBefore}));
        assert.ok(localMs<=500,`real local Attempt ${localMs}ms excluding provider latency exceeds 500ms`);
      });
      await t.test("positive mutation needs fresh Catalog proof; missing, stale or different facts fail closed before reservation",async () => {
        for(const invalid of [()=>{throw new Error("unavailable");},p=>({...p,offerRef:OTHER}),p=>({...p,availability:"Stopped"}),p=>({...p,snapshotRevision:"0"}),p=>({...p,mappingRevision:"0"}),p=>({...p,mappingRevision:"2"}),p=>({...p,grindOptions:[]}),p=>({...p,extra:true})]) {
          await reset([target(OFFER,"1000",GRIND)]);const cart=fake();cart.beforeCatalog=invalid;
          await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
          const result=await facts();assert.equal(cart.catalogReads,1);assert.equal(cart.calls.length,0);assert.equal(cart.reads,1);
          assert.equal(result.reservations.length,0);assert.equal(result.attempts[0].state,"Blocked");
          assert.equal(result.attempts[0].failure_code,"AROMA_MAPPING_NOT_AVAILABLE");
        }
        await reset();const cart=fake();cart.beforeCatalog=async p=>{await db.query("UPDATE orders.catalog_mapping_projection SET mapping_revision=2");return p;};
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,0);assert.equal((await facts()).reservations.length,0);
        await reset();await db.query("UPDATE orders.catalog_mapping_projection SET offer_ref=$1,mapping_revision=2",[OFFER]);const ambiguous=fake();
        await createAromaConvergenceStore(runtime,options).runOnce(ambiguous.gateway,signal);
        assert.equal(ambiguous.calls.length,0);assert.equal(ambiguous.catalogReads,0);assert.equal((await facts()).reservations.length,0);
        await reset([target(OFFER,"1000")]);await db.query("UPDATE orders.catalog_mapping_projection SET mapping_state='Stopped',availability='Stopped',mapping_revision=2");
        const reduction=fake([line(OFFER,"2")]);reduction.beforeCatalog=()=>{throw new Error("negative convergence must not require Catalog availability");};
        await createAromaConvergenceStore(runtime,options).runOnce(reduction.gateway,signal);
        assert.equal(reduction.catalogReads,0);assert.equal(reduction.calls[0].action,"SetQuantity");assert.equal(reduction.calls[0].request.quantity,"1");
        assert.equal((await facts()).attempts[0].state,"VerifiedInSync");
        await reset([]);const removal=fake([line(OFFER,"1")]);
        removal.beforeCatalog=()=>{throw new Error("removal must not request Catalog");};
        await createAromaConvergenceStore(runtime,options).runOnce(removal.gateway,signal);
        assert.equal(removal.catalogReads,0);assert.equal(removal.calls[0].action,"Remove");
      });
      await t.test("PRODUCT_UNAVAILABLE permits only verified cleanup and keeps the Attempt blocked",async () => {
        await reset([], ["PRODUCT_UNAVAILABLE"]);await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const removal=fake([line(OFFER,"1",GRIND)]);
        await createAromaConvergenceStore(runtime,options).runOnce(removal.gateway,signal);
        let result=await facts();
        assert.deepEqual(removal.calls.map(call=>[call.action,call.request.sourceGrindKeyHash]),[["Remove",GRIND]]);assert.equal(removal.catalogReads,0);
        assert.equal(result.reservations[0].state,"Verified");assert.equal(result.attempts[0].state,"Blocked");
        assert.deepEqual(result.attempts[0].blocker_codes,["PRODUCT_UNAVAILABLE"]);

        await reset([target(OFFER,"1000")], ["PRODUCT_UNAVAILABLE"]);await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const decrease=fake([line(OFFER,"2")]);
        await createAromaConvergenceStore(runtime,options).runOnce(decrease.gateway,signal);
        result=await facts();
        assert.deepEqual(decrease.calls.map(call=>[call.action,call.request.quantity]),[["SetQuantity","1"]]);assert.equal(decrease.catalogReads,0);
        assert.equal(result.reservations[0].state,"Verified");assert.equal(result.attempts[0].state,"Blocked");
        assert.deepEqual(result.attempts[0].blocker_codes,["PRODUCT_UNAVAILABLE"]);

        await reset([], ["PRODUCT_UNAVAILABLE"]);
        await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const multiple=fake([line(OFFER,"1"),line(OTHER,"1")]),store=createAromaConvergenceStore(runtime,options);
        await store.runOnce(multiple.gateway,signal);
        result=await facts();
        assert.equal(multiple.calls.length,1);assert.equal(result.attempts.length,1);assert.equal(result.attempts[0].state,"Blocked");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);
        await due();await store.runOnce(multiple.gateway,signal);
        result=await facts();
        assert.equal(multiple.calls.length,2);assert.equal(result.attempts.length,2);assert.ok(result.attempts.every(attempt=>attempt.state==="Blocked"));
        assert.deepEqual(multiple.calls.map(call=>call.action),["Remove","Remove"]);
        assert.equal(await store.runOnce(multiple.gateway,signal),"idle");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,false);

        await reset([target(OFFER,"2000"),target(OFFER,"1000",GRIND)], ["PRODUCT_UNAVAILABLE"]);
        await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const mixed=fake([line(OFFER,"1"),line(OFFER,"2",GRIND)]);
        await createAromaConvergenceStore(runtime,options).runOnce(mixed.gateway,signal);
        result=await facts();
        assert.deepEqual(mixed.calls.map(call=>[call.action,call.request.sourceGrindKeyHash,call.request.quantity]),[["SetQuantity",GRIND,"1"]]);
        assert.equal(result.attempts[0].state,"Blocked");assert.deepEqual(result.attempts[0].blocker_codes,["PRODUCT_UNAVAILABLE"]);

        await reset([target(OFFER,"2000")], ["PRODUCT_UNAVAILABLE"]);
        await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const positive=fake([line(OFFER,"1")]);
        await createAromaConvergenceStore(runtime,options).runOnce(positive.gateway,signal);
        result=await facts();
        assert.equal(positive.calls.length,0);assert.equal(result.reservations.length,0);assert.equal(result.attempts[0].state,"Blocked");
        assert.deepEqual(result.attempts[0].blocker_codes,["PRODUCT_UNAVAILABLE"]);

        await reset([], ["MAPPING_STOPPED"]);
        await db.query("UPDATE orders.catalog_mapping_projection SET mapping_state='Stopped',availability='Stopped',mapping_revision=2,effective_at=clock_timestamp()");
        const stopped=fake([line(OFFER,"1")]);
        await createAromaConvergenceStore(runtime,options).runOnce(stopped.gateway,signal);
        result=await facts();
        assert.deepEqual(stopped.calls.map(call=>call.action),["Remove"]);assert.equal(result.reservations[0].state,"Verified");
        assert.equal(result.attempts[0].state,"Blocked");assert.deepEqual(result.attempts[0].blocker_codes,["MAPPING_STOPPED"]);

        await reset([], ["PRODUCT_UNAVAILABLE","AROMA_QUANTITY_NOT_SUPPORTED"]);
        const hardBlocker=fake([line(OFFER,"1")]);
        await createAromaConvergenceStore(runtime,options).runOnce(hardBlocker.gateway,signal);
        result=await facts();
        assert.equal(hardBlocker.calls.length,0);assert.equal(result.reservations.length,0);assert.equal(result.attempts[0].state,"Blocked");
        assert.deepEqual(result.attempts[0].blocker_codes,["AROMA_QUANTITY_NOT_SUPPORTED","PRODUCT_UNAVAILABLE"]);
      });
      await t.test("RecoveredApplied is reconcile-only even when current Desired has another difference; old UnknownOutcome stays immutable",async () => {
        await reset();
        const {AromaConvergenceTelemetry} = await import("../../apps/aroma-convergence/dist/observability.js");
        const telemetry = new AromaConvergenceTelemetry();
        const waitUnknown = async expected => {
          for (let tick = 0; tick < 100; tick++) {
            if (telemetry.render().includes(`coffee_aroma_unknown_outcomes_current ${expected}`)) return;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.fail(`unresolved UnknownOutcome gauge did not reach ${expected}`);
        };
        assert.ok(!telemetry.render().some(line => line.startsWith("coffee_aroma_unknown_outcomes_current")));
        const cart=fake();
        cart.beforeMutation=async ({offerRef,request})=>{cart.lines=[line(offerRef,request.quantity)];throw new Error("controlled lost response");};
        await createAromaConvergenceStore(runtime,short,telemetry).runOnce(cart.gateway,signal);
        await waitUnknown(1);
        const old=(await facts()).attempts[0];
        assert.equal(old.state,"UnknownOutcome");
        await freshDesired([target(OFFER,"2000")]);
        await waitBarrier();
        cart.beforeMutation=undefined;
        await createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2},telemetry).runOnce(cart.gateway,signal);
        await waitUnknown(0);
        assert.ok(telemetry.render().includes("coffee_aroma_unknown_outcomes_total 1"));
        const result=await facts();
        assert.equal(cart.calls.length,1,"recovery Applied must never start a new unsafe call");
        assert.equal(result.reservations[0].state,"RecoveredApplied");
        assert.deepEqual(result.attempts[0],old,"terminal prior Attempt is immutable");
        assert.equal(result.attempts[1].state,"OutOfSync");
        assert.equal(result.attempts[1].selected_action,null);
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);

        await reset([], ["PRODUCT_UNAVAILABLE"]);
        await db.query("UPDATE orders.catalog_mapping_projection SET availability='Unavailable',mapping_revision=2,catalog_snapshot_revision=2,effective_at=clock_timestamp()");
        const cleanupCart=fake([line(OFFER,"1"),line(OTHER,"1")]);
        cleanupCart.beforeMutation=async ({offerRef,request})=>{
          cleanupCart.lines=cleanupCart.lines.filter(value=>value.offerRef!==offerRef||value.sourceGrindKeyHash!==request.sourceGrindKeyHash);
          throw new Error("controlled lost cleanup acknowledgement");
        };
        await createAromaConvergenceStore(runtime,short).runOnce(cleanupCart.gateway,signal);
        let cleanupFacts=await facts();
        assert.equal(cleanupCart.calls.length,1);assert.equal(cleanupFacts.attempts[0].state,"UnknownOutcome");
        assert.equal(cleanupFacts.reservations[0].state,"UnknownOutcome");
        const oldCleanupAttempt=cleanupFacts.attempts[0];
        await waitBarrier();cleanupCart.beforeMutation=undefined;
        const recovered= createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2});
        await recovered.runOnce(cleanupCart.gateway,signal);
        cleanupFacts=await facts();
        assert.deepEqual(cleanupFacts.attempts[0],oldCleanupAttempt);
        assert.equal(cleanupFacts.reservations[0].state,"RecoveredApplied");
        const recoveredReservation=cleanupFacts.reservations[0];
        assert.equal(cleanupFacts.attempts[1].state,"Blocked");assert.equal(cleanupFacts.attempts[1].selected_action,null);
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);
        await due();await createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2}).runOnce(cleanupCart.gateway,signal);
        cleanupFacts=await facts();
        assert.equal(cleanupCart.calls.length,2);assert.notEqual(cleanupCart.calls[0].request.operationRef,cleanupCart.calls[1].request.operationRef);
        assert.deepEqual(cleanupFacts.attempts[0],oldCleanupAttempt);assert.deepEqual(cleanupFacts.reservations[0],recoveredReservation);
        assert.equal(cleanupFacts.attempts[1].state,"Blocked");assert.equal(cleanupFacts.attempts[1].selected_action,null);
        assert.equal(cleanupFacts.attempts[2].state,"Blocked");assert.equal(cleanupFacts.attempts[2].selected_action,"Remove");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,false);
        assert.equal(await recovered.runOnce(cleanupCart.gateway,signal),"idle");
      });
      await t.test("Acknowledged is durable before fresh verification; successful SetQuantity touches exactly one nullable-grind key",async () => {
        await reset([target(OFFER,"1000"),target(OFFER,"2000",GRIND)]);
        const cart=fake([line(OFFER,"1"),line(OFFER,"1",GRIND)]);
        cart.beforeRead=async () => {
          if(cart.reads===2) {
            const reservation=(await facts()).reservations[0];
            assert.equal(reservation.state,"Acknowledged");
            assert.match(reservation.gateway_outcome_hash,/^[0-9a-f]{64}$/u);
          }
        };
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.reads,2);
        assert.equal(cart.calls.length,1);
        assert.deepEqual(cart.calls[0],{action:"SetQuantity",offerRef:OFFER,request:{operationRef:cart.calls[0].request.operationRef,cartScopeRef:SCOPE,sourceGrindKeyHash:GRIND,quantity:"2"}});
        const result=await facts();
        assert.equal(result.attempts[0].state,"VerifiedInSync");
        assert.equal(result.reservations[0].state,"Verified");
        assert.equal(result.reservations[0].observed_before_milli,"1000");
        assert.equal(result.reservations[0].desired_milli,"2000");
        assert.equal(result.reservations[0].request_hash,canonicalRequestHash({offerRef:OFFER,action:"SetQuantity",request:cart.calls[0].request}));
        assert.equal((await db.query("SELECT count(*) FROM orders.cart_observed_revisions")).rows[0].count,"2");
      });
      await t.test("Remove touches exactly one key and leaves a different grind untouched; network can acquire advisory lock",async () => {
        await reset([target(OFFER,"1000",GRIND)]);
        const cart=fake([line(OFFER,"1"),line(OFFER,"1",GRIND)]);
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.reads,2);
        assert.equal(cart.calls.length,1);
        assert.equal(cart.calls[0].action,"Remove");
        assert.equal(cart.calls[0].request.sourceGrindKeyHash,undefined);
        assert.equal(cart.calls[0].request.quantity,undefined);
        assert.deepEqual(cart.lines,[line(OFFER,"1",GRIND)]);
        assert.equal((await facts()).attempts[0].state,"VerifiedInSync");
      });
      await t.test("one Attempt never mutates a second difference",async () => {
        await reset([target(OFFER,"2000"),target(OTHER,"2000")]);
        const cart=fake();
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        assert.equal((await facts()).attempts[0].state,"OutOfSync");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);
      });
      await t.test("only definitive Gateway cart-item 404 is terminal Rejected; 503 remains UnknownOutcome",async () => {
        const {GatewayClientError}=await import("../../apps/aroma-convergence/dist/gateway-client.js");
        for(const [status,problemCode,state,attemptState,blockers] of [
          [404,"AROMA_CART_ITEM_NOT_FOUND","Rejected","Blocked",["AROMA_CART_ITEM_NOT_FOUND"]],
          [503,"AROMA_PROVIDER_UNAVAILABLE","UnknownOutcome","UnknownOutcome",["AROMA_OPERATION_UNKNOWN_OUTCOME"]],
        ]) {
          await reset();
          const cart=fake();
          cart.beforeMutation=()=>{throw new GatewayClientError("Rejected",status,problemCode);};
          const store=createAromaConvergenceStore(runtime,options);
          await store.runOnce(cart.gateway,signal);
          const result=await facts(),reservation=result.reservations[0],attempt=result.attempts[0];
          assert.equal(cart.calls.length,1);
          assert.equal(cart.reads,1,"no verification GET follows a rejected/unknown mutation response");
          assert.equal(reservation.state,state);
          assert.equal(reservation.resolved_at!==null,state==="Rejected");
          assert.equal(reservation.gateway_outcome_hash,state==="Rejected"?canonicalRequestHash({status:404,problemCode:"AROMA_CART_ITEM_NOT_FOUND"}):null);
          assert.equal(attempt.state,attemptState);
          assert.deepEqual(attempt.blocker_codes,blockers);
          assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,state==="UnknownOutcome");
          if(state==="Rejected") {
            assert.equal(await store.runOnce(cart.gateway,signal),"idle");
            assert.equal(cart.calls.length,1);
            const rewrite=defineStatement(runtime,"UPDATE orders.mutation_reservations SET state='RecoveredNotApplied' WHERE operation_ref=$1");
            await assert.rejects(tx(tr=>rewrite(tr,[reservation.operation_ref])),error=>error.sqlState==="23514");
          }
        }
      });
      for (const mode of ["disabled","missing","stopped","unavailable","fractional"]) await t.test(`${mode} fails closed before positive mutation`,async () => {
        await reset([target(OFFER,mode==="fractional"?"1500":"1000")]);
        if(mode==="missing") await db.query("TRUNCATE orders.catalog_mapping_projection");
        if(mode==="stopped") await db.query("UPDATE orders.catalog_mapping_projection SET mapping_revision=2,mapping_state='Stopped',effective_at=clock_timestamp()");
        if(mode==="unavailable") await db.query("UPDATE orders.catalog_mapping_projection SET mapping_revision=2,availability='Unavailable',effective_at=clock_timestamp()");
        const cart=fake();
        await createAromaConvergenceStore(runtime,{...options,mutationsEnabled:mode!=="disabled"}).runOnce(cart.gateway,signal);
        const result=await facts();
        assert.equal(cart.calls.length,0);
        assert.equal(result.reservations.length,0);
        assert.equal(result.attempts[0].state,"Blocked");
      });
      const currentObservation = async () => (await db.query("SELECT * FROM orders.cart_observed_revisions WHERE state='Current'")).rows[0];
      await t.test("processed preparation wake uses payload Desired for DB guard and provenance when owner version is stream sequence",async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        const store=createAromaConvergenceStore(runtime,options);
        await store.recover(signal);
        assert.equal(await store.runOnce(cart.gateway,signal),"attempted");
        const desiredRevision=await freshDesired([target()]);
        const {decodeAromaConvergenceEnvelope}=await import("../../apps/aroma-convergence/dist/application/messages.js");
        const wakeEnvelope={envelopeVersion:"1",messageId:"msg_00000000000000000000000099",messageType:"AromaConvergenceRequested.v1",
          occurredAt:await pgNow(),producer:"orders-aroma-preparation",correlationId:"00000000-0000-4000-8000-000000000099",
          causationId:"msg_00000000000000000000000098",traceparent:`00-${"c".repeat(32)}-${"d".repeat(16)}-01`,
          aggregate:{type:"AromaCart",ref:SCOPE,version:"3"},
          payload:{cartScopeRef:SCOPE,desiredRevision,reason:"OperatorRequested",orderRef:"ord_00000000000000000000000003"}};
        const wakeStore=createSqlInboxStore(runtime,{schema:"orders",consumerName:"aroma-convergence-v1"});
        let commits=0;
        await processKafkaRecord({topic:"coffee.aroma.cart.commands.v1",partition:0,offset:"900",key:SCOPE,value:canonicalJson(wakeEnvelope),headers:{}},
          {runtime:"aroma-convergence",groupId:"aroma-convergence-v1",topics:["coffee.aroma.cart.commands.v1"],leaseMs:60_000,maxMessageBytes:65_536,signal,
            binding:{processing:"durable",database:runtime,inbox:wakeStore,decode:decodeAromaConvergenceEnvelope,
              handle:(transaction,envelope)=>store.handleWake(transaction,envelope,signal)},commit:async()=>{commits++;}});
        assert.equal(commits,1);
        const inbox=(await db.query("SELECT state,owner_version,payload,envelope FROM orders.inbox_messages WHERE consumer_name='aroma-convergence-v1' AND message_id=$1",[wakeEnvelope.messageId])).rows[0];
        assert.equal(inbox.state,"Processed");
        assert.equal(inbox.owner_version,"3");
        assert.equal(inbox.payload.desiredRevision,desiredRevision);
        assert.deepEqual(inbox.envelope,wakeEnvelope);
        assert.equal((await db.query("SELECT count(*) FROM orders.inbox_quarantine WHERE consumer_name='aroma-convergence-v1' AND message_id=$1",[wakeEnvelope.messageId])).rows[0].count,"0");
        assert.deepEqual((await db.query("SELECT desired_revision::text,dirty FROM orders.convergence_work")).rows,[{desired_revision:desiredRevision,dirty:true}]);

        assert.equal(await store.runOnce(cart.gateway,signal),"attempted");
        const sourced=(await db.query(`SELECT message_id,correlation_id,causation_id,envelope FROM orders.outbox_messages
          WHERE message_type='AromaConvergenceChanged.v1' AND causation_id=$1`,[wakeEnvelope.messageId])).rows[0];
        assert.ok(sourced);
        assert.equal(sourced.correlation_id,wakeEnvelope.correlationId);
        assert.equal(sourced.causation_id,wakeEnvelope.messageId);
        assert.equal(sourced.envelope.correlationId,wakeEnvelope.correlationId);
        assert.equal(sourced.envelope.causationId,wakeEnvelope.messageId);
        assert.equal(sourced.envelope.payload.desiredRevision,desiredRevision);
      });
      for(const mode of ["throw","partial","fingerprint","provenance","future","stale","over-capacity"]) await t.test(`invalid ${mode} GET preserves previous Current complete observation`,async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        const store=createAromaConvergenceStore(runtime,options);
        await store.runOnce(cart.gateway,signal);
        const old=await currentObservation();
        await freshDesired([target(OFFER,"2000")]);
        cart.gateway.read=async () => {
          if(mode==="throw") throw new Error("controlled GET error");
          const value=await snapshot(cart.lines);
          if(mode==="partial") value.complete=false;
          if(mode==="fingerprint") value.cartFingerprint=H;
          if(mode==="provenance") value.providerSnapshotRef="aroma-gateway:cart-body-sha256:invalid";
          if(mode==="future" || mode==="stale") value.capturedAt=(await db.query(`SELECT to_char((clock_timestamp() ${mode==="future"?"+":"-"} interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS value`)).rows[0].value;
          if(mode==="over-capacity") return snapshot([line(OFFER,"1"),line(OTHER,"1")]);
          return value;
        };
        await createAromaConvergenceStore(runtime,{...options,maxLines:mode==="over-capacity"?1:options.maxLines}).runOnce(cart.gateway,signal);
        assert.deepEqual(await currentObservation(),old);
        assert.equal(cart.calls.length,0);
        assert.equal((await facts()).attempts.at(-1).state,"Failed");
      });
      await t.test("Desired invalidated during preflight prevents observation/success/mutation under stale target",async () => {
        await reset();
        const cart=fake();
        cart.beforeRead=()=>freshDesired([target(OFFER,"2000")]);
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,0);
        assert.equal(await currentObservation(),undefined);
        assert.equal((await facts()).attempts[0].ended_at,null);
        assert.equal((await db.query("SELECT dirty,desired_revision FROM orders.convergence_work")).rows[0].desired_revision,"2");
      });
      await t.test("two replicas cannot dispatch simultaneously while one provider callback is in flight",async () => {
        await reset();
        const cart=fake();
        cart.beforeMutation=async () => {
          const rival=fake();
          const store2=createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2});
          assert.equal(await store2.runOnce(rival.gateway,signal),"idle");
          assert.equal(rival.calls.length,0);
          assert.equal(rival.reads,0);
          const r=(await facts()).reservations[0];
          assert.equal(r.state,"Dispatched");
          const safety=(await db.query("SELECT l.expires_at >= r.reserved_until AS lease_covers,r.reserved_until >= r.provider_deadline_at+r.safety_margin_ms*interval '1 millisecond' AS margin_covers FROM orders.convergence_leases l CROSS JOIN orders.mutation_reservations r")).rows[0];
          assert.deepEqual(safety,{lease_covers:true,margin_covers:true});
        };
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        assert.equal((await facts()).attempts[0].state,"VerifiedInSync");
      });
      await t.test("stale fence after dispatch rejects late ACK and success without writing a second observation",async () => {
        await reset();
        const cart=fake();
        cart.beforeMutation=()=>db.query("UPDATE orders.convergence_leases SET owner_instance_id=$1,fence_epoch=fence_epoch+1,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp()",[owner2]);
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        assert.equal(cart.reads,1);
        assert.equal((await facts()).attempts[0].ended_at,null);
        assert.equal((await facts()).reservations[0].state,"Dispatched");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,"0");
      });
      await t.test("fake clock: configured 10s heartbeat renews the exact 30s DB lease and ownership loss aborts held GET",async clockTest => {
        await reset();const cart=fake();let started,heartbeatDone;
        const entered=new Promise(resolve=>{started=resolve;});let heartbeatCount=0;
        const original=Client.prototype.query;
        Client.prototype.query=function(...args) {
          const text=typeof args[0]==="string"?args[0]:args[0]?.text;
          const result=original.apply(this,args);
          if(this.connectionParameters.user!==ROLE || !result?.then || !text?.includes("SET heartbeat_at=lease_clock.now")) return result;
          return result.then(value=>{heartbeatCount++;heartbeatDone?.();return value;});
        };
        cart.beforeRead=async context=>{started();await new Promise(resolve=>context.signal.addEventListener("abort",resolve,{once:true}));};
        clockTest.mock.timers.enable({apis:["setTimeout"]});
        const originalSetTimeout=globalThis.setTimeout;
        let timerRegistrations=0,registeredNextHeartbeat;
        const nextHeartbeatScheduled=new Promise(resolve=>{registeredNextHeartbeat=resolve;});
        globalThis.setTimeout=function(callback,delay,...args) {
          const timer=Reflect.apply(originalSetTimeout,this,[callback,delay,...args]);
          if(delay===options.heartbeatIntervalMs && ++timerRegistrations===2) registeredNextHeartbeat();
          return timer;
        };
        try {
          const pending=createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);await entered;
          const lease=(await db.query("SELECT EXTRACT(epoch FROM expires_at-acquired_at)*1000 AS duration FROM orders.convergence_leases")).rows[0];
          assert.equal(Number(lease.duration),30_000);
          clockTest.mock.timers.tick(9_999);await Promise.resolve();assert.equal(heartbeatCount,0);
          let completed=new Promise(resolve=>{heartbeatDone=resolve;});clockTest.mock.timers.tick(1);await completed;
          assert.equal(heartbeatCount,1);
          // PostgreSQL is the authority: inject its expired fence, then advance the next heartbeat.
          await nextHeartbeatScheduled;
          await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
          completed=new Promise(resolve=>{heartbeatDone=resolve;});
          clockTest.mock.timers.tick(10_000);await completed;await pending;
          assert.equal(heartbeatCount,2);assert.equal(cart.calls.length,0);
          assert.equal((await db.query("SELECT count(*) FROM orders.cart_observed_revisions")).rows[0].count,"0");
        } finally {globalThis.setTimeout=originalSetTimeout;clockTest.mock.timers.reset();Client.prototype.query=original;}
      });
      await t.test("heartbeat DB failure is visible instead of being swallowed as ordinary provider failure",async () => {
        await reset();
        const cart=fake();
        const tuning={...options,leaseMs:5_000,heartbeatIntervalMs:20,providerDeadlineMs:2_000,safetyMarginMs:100};
        cart.beforeRead=async context => {
          await db.query("BEGIN");
          await db.query("SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))");
          try {await new Promise(resolve => {if(context.signal.aborted) resolve();else context.signal.addEventListener("abort",resolve,{once:true});});}
          finally {await db.query("ROLLBACK");}
        };
        try {
          await assert.rejects(createAromaConvergenceStore(runtime,tuning).runOnce(cart.gateway,signal),error=>error.sqlState==="55P03");
        } finally {await db.query("ROLLBACK");}
        assert.equal(cart.calls.length,0);
      });
      const seedCrash = async (state, baseline = []) => {
        const attemptRef="att_00000000000000000000000001",operationRef="op_00000000000000000000000001";
        const {normalizeAromaCartSnapshot}=await import("../../packages/contracts/aroma-v1/dist/index.js");
        const normalized=normalizeAromaCartSnapshot(await snapshot(baseline));
        const desired=(await db.query("SELECT desired_revision,desired_hash FROM orders.cart_desired_revisions WHERE state='Current'")).rows[0];
        const request={operationRef,cartScopeRef:SCOPE,quantity:"1"};
        await db.query("BEGIN");
        try {
          await db.query("INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind) VALUES($1,1,'Current',$2,$3,$4,'Observer')",[SCOPE,normalized.snapshot.providerSnapshotRef,normalized.snapshot.cartFingerprint,normalized.snapshot.capturedAt]);
          for(const value of normalized.lines) await db.query("INSERT INTO orders.cart_observed_lines VALUES($1,1,$2,$3,$4,$5)",[SCOPE,value.offerRef,value.sourceGrindKeyHash??null,value.quantityMilli,value.sanitizedLineHash]);
          await db.query("INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state,observed_start_revision,selected_offer_ref,selected_action,started_at) VALUES($1,$2,$3,$4,$5,1,$6,1,$7,'SetQuantity',clock_timestamp()-interval '10 seconds')",[attemptRef,SCOPE,desired.desired_revision,desired.desired_hash,OWNER,state==="Reserved"?"MutationReserved":"MutationDispatched",OFFER]);
          await db.query(`INSERT INTO orders.mutation_reservations(operation_ref,attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_before_revision,action,offer_ref,observed_before_milli,desired_milli,target_provider_quantity,request_hash,reserved_at,reserved_until,provider_deadline_at,safety_margin_ms,state,dispatched_at,gateway_outcome_hash)
            SELECT $1,$2,$3,$4,1,1,'SetQuantity',$5,0,1000,1,$6,t.now-interval '5 seconds',t.now-interval '3 seconds',t.now-interval '4 seconds',1000,$7::text,CASE WHEN $7::text='Reserved' THEN NULL ELSE t.now-interval '5 seconds' END,CASE WHEN $7::text='Acknowledged' THEN $8::text ELSE NULL END FROM (SELECT clock_timestamp() AS now OFFSET 0)t`,[operationRef,attemptRef,SCOPE,desired.desired_revision,OFFER,canonicalRequestHash({offerRef:OFFER,action:"SetQuantity",request}),state,H]);
          await db.query("INSERT INTO orders.convergence_leases VALUES($1,$2,1,clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '1 second')",[SCOPE,OWNER]);
          await db.query("COMMIT");
        } catch(error) {await db.query("ROLLBACK");throw error;}
        return {attemptRef,operationRef,request};
      };
      for(const state of ["Reserved","Dispatched","Acknowledged"]) for(const applied of [true,false]) await t.test(`restart after durable ${state} window reconciles ${applied?"Applied":"NotApplied"} under new fence and never resends old operationRef`,async () => {
        await reset();
        const old=await seedCrash(state);
        const cart=fake(applied?[line(OFFER,"1")]:[]);
        const store=createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2});
        await store.recover(signal);
        const interrupted=(await facts()).attempts[0];
        assert.equal(interrupted.state,"UnknownOutcome");
        assert.equal((await facts()).reservations[0].state,"UnknownOutcome");
        await store.recover(signal);
        assert.deepEqual((await facts()).attempts[0],interrupted);
        await store.runOnce(cart.gateway,signal);
        const result=await facts();
        const prior=result.reservations.find(value=>value.operation_ref===old.operationRef);
        assert.equal(prior.state,applied?"RecoveredApplied":"RecoveredNotApplied");
        assert.equal(cart.calls.length,applied?0:1);
        assert.equal(cart.calls.some(call=>call.request.operationRef===old.operationRef),false);
        assert.deepEqual(result.attempts[0],interrupted);
        assert.equal(result.attempts[1].fence_epoch,"2");
        assert.equal(result.attempts[1].state,applied?"NoOpInSync":"VerifiedInSync");
        if(!applied) assert.equal(cart.reads,2);
        else assert.equal(cart.reads,1);
      });
      await t.test("unexpired durable reservation blocks a new fence/unsafe call even after lease expiry",async () => {
        await reset();
        await seedCrash("Dispatched");
        await db.query("UPDATE orders.mutation_reservations SET provider_deadline_at=clock_timestamp()+interval '1 second',reserved_until=clock_timestamp()+interval '3 seconds'");
        const cart=fake();
        assert.equal(await createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2}).runOnce(cart.gateway,signal),"idle");
        assert.equal(cart.reads,0);
        assert.equal(cart.calls.length,0);
        assert.equal((await db.query("SELECT fence_epoch FROM orders.convergence_leases")).rows[0].fence_epoch,"1");
      });
      for(const drift of ["selected-line","other-line"]) await t.test(`reconcile-only ${drift} external drift blocks without resolving/resending unknown mutation`,async () => {
        await reset();
        await seedCrash("Dispatched");
        const cart=fake(drift==="selected-line"?[line(OFFER,"3")]:[line(OFFER,"1"),line(OTHER,"1")]);
        await createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2}).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,0);
        const result=await facts();
        assert.equal(result.reservations[0].state,"UnknownOutcome");
        assert.equal(result.attempts[1].state,"Blocked");
        assert.deepEqual(result.attempts[1].blocker_codes,["AROMA_EXTERNAL_CHANGE"]);
      });
      for(const mode of ["lost-not-applied","invalid-ack","timeout","partial-verification","failed-verification","external-drift"]) await t.test(`${mode} after dispatch persists UnknownOutcome and preserves last complete proof`,async () => {
        await reset();
        const cart=fake();
        if(mode==="lost-not-applied") cart.beforeMutation=async ()=>{throw new Error("controlled loss before application");};
        if(mode==="invalid-ack") {const real=cart.gateway.setQuantity;cart.gateway.setQuantity=async (...args)=>({...await real(...args),operationRef:"op_00000000000000000000000099"});}
        if(mode==="timeout") cart.beforeMutation=async ({context})=>{await new Promise(resolve=>context.signal.addEventListener("abort",resolve,{once:true}));context.signal.throwIfAborted();};
        if(mode==="partial-verification") {const real=cart.gateway.read;cart.gateway.read=async context=>{const value=await real(context);return cart.reads===2?{...value,complete:false}:value;};}
        if(mode==="failed-verification") cart.beforeRead=async ()=>{if(cart.reads===2) throw new Error("controlled verification GET failure");};
        if(mode==="external-drift") cart.beforeRead=async ()=>{if(cart.reads===2) cart.lines.push(line(OTHER,"1"));};
        await createAromaConvergenceStore(runtime,short).runOnce(cart.gateway,signal);
        const result=await facts();
        assert.equal(cart.calls.length,1);
        assert.equal(result.attempts[0].state,"UnknownOutcome");
        assert.equal(result.reservations[0].state,"UnknownOutcome");
        assert.equal((await currentObservation()).observed_revision,mode==="external-drift"?"2":"1");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);
        if(mode==="lost-not-applied") {
          await waitBarrier();
          cart.beforeMutation=undefined;
          await createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2}).runOnce(cart.gateway,signal);
          assert.equal(cart.calls.length,2);
          assert.notEqual(cart.calls[0].request.operationRef,cart.calls[1].request.operationRef);
          assert.equal((await facts()).reservations[0].state,"RecoveredNotApplied");
        }
      });
      const commitSeam = async (sqlNeedle, hook, body) => {
        const original=Client.prototype.query,marked=new WeakSet();let fired=false;
        Client.prototype.query=function (...args) {
          const text=typeof args[0]==="string"?args[0]:args[0]?.text;
          const result=original.apply(this,args);
          if(this.connectionParameters.user!==ROLE) return result;
          if(result?.then) return result.then(async value=>{
            if(text?.includes(sqlNeedle)) marked.add(this);
            if(text==="COMMIT" && marked.has(this)) {marked.delete(this);fired=true;await hook();}
            return value;
          });
          if(text?.includes(sqlNeedle) && isCopyStream(result)) afterCopy(result,()=>{},()=>marked.add(this));
          return result;
        };
        try {return await body();}
        finally {Client.prototype.query=original;assert.equal(fired,true,`required fault seam not reached: ${sqlNeedle}`);}
      };
      for(const invalidation of ["fence","expiry","desired","mapping"]) await t.test(`${invalidation} immediately after exact reservation commit prevents dispatch/unsafe call`,async () => {
        await reset();
        const cart=fake();
        const hook=async ()=>{
          if(invalidation==="fence") await db.query("UPDATE orders.convergence_leases SET owner_instance_id=$1,fence_epoch=fence_epoch+1,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp()",[owner2]);
          if(invalidation==="expiry") await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
          if(invalidation==="desired") await freshDesired([target(OFFER,"2000")]);
          if(invalidation==="mapping") await db.query("UPDATE orders.catalog_mapping_projection SET mapping_revision=2,mapping_state='Stopped',effective_at=clock_timestamp()");
        };
        await commitSeam("INSERT INTO orders.mutation_reservations",hook,()=>createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal));
        assert.equal(cart.calls.length,0);
        assert.equal((await facts()).reservations[0].state,"Reserved");
        assert.equal((await facts()).attempts[0].state,"MutationReserved");
      });
      for(const invalidation of ["fence","desired","new-observed"]) await t.test(`${invalidation} during verification prevents authoritative success or replacing a stronger Current`,async () => {
        await reset();
        const cart=fake();
        let stronger;
        cart.beforeRead=async ()=>{
          if(cart.reads!==2) return;
          if(invalidation==="fence") await db.query("UPDATE orders.convergence_leases SET owner_instance_id=$1,fence_epoch=fence_epoch+1,acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp()",[owner2]);
          if(invalidation==="desired") await freshDesired([target(OFFER,"2000")]);
          if(invalidation==="new-observed") {
            const {normalizeAromaCartSnapshot}=await import("../../packages/contracts/aroma-v1/dist/index.js");
            const proof=normalizeAromaCartSnapshot(await snapshot([line(OTHER,"1")]));
            await db.query("BEGIN");
            try {
              await db.query("SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))");
              await db.query("UPDATE orders.cart_observed_revisions SET state='Superseded' WHERE state='Current'");
              await db.query("INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind) VALUES($1,2,'Current',$2,$3,$4,'Observer')",[SCOPE,proof.snapshot.providerSnapshotRef,proof.snapshot.cartFingerprint,proof.snapshot.capturedAt]);
              for(const value of proof.lines) await db.query("INSERT INTO orders.cart_observed_lines VALUES($1,2,$2,$3,$4,$5)",[SCOPE,value.offerRef,value.sourceGrindKeyHash??null,value.quantityMilli,value.sanitizedLineHash]);
              await db.query("COMMIT");
            } catch(error) {await db.query("ROLLBACK");throw error;}
            stronger=await currentObservation();
          }
        };
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        assert.equal((await facts()).attempts[0].ended_at,null);
        assert.equal((await facts()).reservations[0].state,"Acknowledged");
        if(stronger) assert.deepEqual(await currentObservation(),stronger);
        else assert.equal((await currentObservation()).observed_revision,"1");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,"0");
      });
      await t.test("shutdown AbortSignal bounds an ignoring callback; new process recovers durable Acknowledged without resend",async () => {
        await reset();
        const cart=fake(),shutdown=new AbortController();
        cart.beforeRead=async ()=>{if(cart.reads===2) {shutdown.abort(new Error("controlled shutdown"));await new Promise(()=>{});}};
        const store=createAromaConvergenceStore(runtime,short);
        await assert.rejects(store.runOnce(cart.gateway,shutdown.signal),error=>error.code==="DB_INTERRUPTED" || error.message==="controlled shutdown");
        assert.equal(cart.calls.length,1);
        assert.equal((await facts()).reservations[0].state,"Acknowledged");
        assert.equal((await facts()).attempts[0].ended_at,null);
        assert.equal(runtime.metrics().active,0);
        await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
        await waitBarrier();
        cart.beforeRead=undefined;
        const restarted=createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2});
        await restarted.recover(signal);
        await restarted.runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        assert.equal((await facts()).reservations[0].state,"RecoveredApplied");
        assert.equal((await facts()).attempts[1].state,"NoOpInSync");
        assert.equal(runtime.metrics().active,0);
      });
      await t.test("persisted blockers defeat apparent vector equality and prohibit a positive mutation",async () => {
        await reset();
        await freshDesired([target()],["MAPPING_CHANGED","MAPPING_STOPPED"]);
        const cart=fake([line(OFFER,"1")]);
        const orderBefore=(await db.query("SELECT * FROM orders.orders WHERE order_ref='ord_00000000000000000000000003'")).rows;
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        const result=await facts();
        assert.equal(cart.calls.length,0);
        assert.equal(result.reservations.length,0);
        assert.equal(result.attempts[0].state,"Blocked");
        assert.deepEqual(result.attempts[0].blocker_codes,["MAPPING_CHANGED","MAPPING_STOPPED"]);
        assert.deepEqual((await db.query("SELECT * FROM orders.orders WHERE order_ref='ord_00000000000000000000000003'")).rows,orderBefore);
        for(const table of ["order_aroma_projections","order_aroma_projection_history","order_history"]) assert.equal((await db.query(`SELECT count(*) FROM orders.${table}`)).rows[0].count,"0");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='RealtimeInvalidated.v1'")).rows[0].count,"0");
      });
      const hint=revision=>({envelopeVersion:"1",messageId:"msg_00000000000000000000000088",messageType:"AromaConvergenceRequested.v1",occurredAt:time,producer:"orders-aroma-preparation",correlationId:OWNER,causationId:null,traceparent:`00-${"a".repeat(32)}-${"b".repeat(16)}-01`,aggregate:{type:"AromaCart",ref:SCOPE,version:revision},payload:{cartScopeRef:SCOPE,desiredRevision:revision,reason:"Recovery",orderRef:null}});
      await t.test("durable dirty wake coalesces across new instances; stale/equal Kafka hints cannot weaken Current proof or rewrite terminal Attempt/Outbox",async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        await freshDesired([target()]);
        await db.query("UPDATE orders.convergence_work SET next_attempt_at=clock_timestamp()+interval '1 hour'");
        await tx(tr=>createAromaConvergenceStore(runtime,options).handleWake(tr,hint("1"),signal));
        assert.equal(await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal),"idle");
        const before=(await db.query("SELECT * FROM orders.convergence_work")).rows[0];
        const store=createAromaConvergenceStore(runtime,options);
        await tx(tr=>store.handleWake(tr,hint("2"),signal));
        await tx(tr=>store.handleWake(tr,hint("2"),signal));
        const pending=(await db.query("SELECT * FROM orders.convergence_work")).rows[0];
        assert.equal(pending.wake_revision,before.wake_revision);
        assert.equal(pending.desired_revision,"2");
        assert.equal(pending.dirty,true);
        await createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2}).runOnce(cart.gateway,signal);
        const immutable=await facts(),proof=await currentObservation(),outbox=(await db.query("SELECT message_id,envelope_bytes,envelope_hash,envelope,payload,payload_hash FROM orders.outbox_messages ORDER BY aggregate_sequence")).rows;
        await tx(tr=>store.handleWake(tr,hint("1"),signal));
        await tx(tr=>store.handleWake(tr,hint("2"),signal));
        await store.recover(signal);
        assert.equal(await store.runOnce(cart.gateway,signal),"idle");
        assert.deepEqual(await facts(),immutable);
        assert.deepEqual(await currentObservation(),proof);
        assert.deepEqual((await db.query("SELECT message_id,envelope_bytes,envelope_hash,envelope,payload,payload_hash FROM orders.outbox_messages ORDER BY aggregate_sequence")).rows,outbox);
        assert.equal(cart.calls.length,0);
        assert.equal(cart.reads,1);
        const attempt=immutable.attempts[0];
        const mutateAttempt=defineStatement(runtime,"UPDATE orders.convergence_attempts SET failure_code='rewrite' WHERE attempt_ref=$1");
        await assert.rejects(tx(tr=>mutateAttempt(tr,[attempt.attempt_ref])),error=>error.sqlState==="23514");
        const mutateOutbox=defineStatement(runtime,"UPDATE orders.outbox_messages SET payload='{}'::jsonb WHERE message_id=$1");
        await assert.rejects(tx(tr=>mutateOutbox(tr,[outbox[0].message_id])),error=>error.sqlState==="23514");
      });
      await t.test("process pause after final dispatch commit cannot start HTTP after provider deadline/reservation window or new fence",async () => {
        await reset();
        const cart=fake(),rival=fake();
        let rivalResult;
        await commitSeam("UPDATE orders.mutation_reservations SET state='Dispatched'",async ()=>{
          await waitBarrier();
          await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
          rivalResult=await createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2,mutationsEnabled:false}).runOnce(rival.gateway,signal);
        },()=>createAromaConvergenceStore(runtime,short).runOnce(cart.gateway,signal));
        assert.equal(rivalResult,"attempted");
        assert.equal(cart.calls.length,0,"expired already-committed dispatch budget cannot be restarted at callback boundary");
        assert.equal(rival.calls.length,0);
        assert.equal((await db.query("SELECT fence_epoch FROM orders.convergence_leases")).rows[0].fence_epoch,"2");
      });
      const statementSeam = async (sqlNeedle, hook, body) => {
        const original=Client.prototype.query;
        let fired=false;
        Client.prototype.query=function (...args) {
          const text=typeof args[0]==="string"?args[0]:args[0]?.text;
          const result=original.apply(this,args);
          if(this.connectionParameters.user!==ROLE) return result;
          if(result?.then) return result.then(async value=>{if(!fired && text?.includes(sqlNeedle)) {fired=true;await hook();}return value;});
          if(!fired && text?.includes(sqlNeedle) && isCopyStream(result)) afterCopy(result,async()=>{fired=true;await hook();});
          return result;
        };
        try {return await body();}
        finally {Client.prototype.query=original;assert.equal(fired,true,`required fault seam not reached: ${sqlNeedle}`);}
      };
      await t.test("lease expires after terminal write but before COMMIT: terminal Attempt/event/work consumption must roll back",async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        await statementSeam("UPDATE orders.convergence_attempts SET state=$2",()=>db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'"),()=>createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal));
        assert.equal((await facts()).attempts[0].ended_at,null,"expired fence must not commit terminal success");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,"0");
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,true);
      });
      await t.test("lease expires mid-snapshot write: no stale Current/lines/observation event may commit",async () => {
        await reset();
        const cart=fake([line(OFFER,"1")]);
        await statementSeam('COPY "orders"."cart_observed_lines"',()=>db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'"),()=>createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal));
        assert.equal(await currentObservation(),undefined);
        assert.equal((await facts()).attempts[0].state,"Started");
        assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages")).rows[0].count,"0");
        assert.equal(cart.calls.length,0);
      });
      await t.test("new preparation wake during callback survives terminal work consumption and is resumed durably by another instance",async () => {
        await reset();
        const cart=fake();
        cart.beforeMutation=async ()=>{
          await db.query("BEGIN");
          try {
            await db.query("SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))");
            await db.query("UPDATE orders.convergence_work SET wake_revision=wake_revision+1,dirty=true,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()");
            await db.query("COMMIT");
          } catch(error) {await db.query("ROLLBACK");throw error;}
        };
        await createAromaConvergenceStore(runtime,options).runOnce(cart.gateway,signal);
        const pending=(await db.query("SELECT * FROM orders.convergence_work")).rows[0];
        assert.equal(pending.wake_revision,"2");
        assert.equal(pending.dirty,true);
        assert.equal((await facts()).attempts[0].state,"VerifiedInSync");
        cart.beforeMutation=undefined;
        await createAromaConvergenceStore(runtime,{...options,ownerInstanceId:owner2}).runOnce(cart.gateway,signal);
        assert.equal((await facts()).attempts[1].state,"NoOpInSync");
        assert.equal(cart.calls.length,1);
        assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,false);
      });
      await t.test("shutdown bounds an ignoring initial read and clears in-process guard for the next durable attempt",async () => {
        await reset();
        const cart=fake(),shutdown=new AbortController();
        cart.beforeRead=async ()=>{shutdown.abort(new Error("controlled initial-read shutdown"));await new Promise(()=>{});};
        const store=createAromaConvergenceStore(runtime,short);
        await assert.rejects(store.runOnce(cart.gateway,shutdown.signal),error=>error.code==="DB_INTERRUPTED" || error.message==="controlled initial-read shutdown");
        assert.equal(cart.calls.length,0);
        assert.equal(await currentObservation(),undefined);
        assert.equal(runtime.metrics().active,0);
        await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
        cart.beforeRead=undefined;
        await store.recover(signal);
        await store.runOnce(cart.gateway,signal);
        assert.equal((await facts()).attempts[0].state,"Failed");
        assert.equal((await facts()).attempts[1].state,"VerifiedInSync");
        assert.equal(cart.calls.length,1);
      });
      for(const boundary of [
        {name:"Attempt commit",sql:"INSERT INTO orders.convergence_attempts",calls:0},
        {name:"initial Observed save",beforeSql:"INSERT INTO orders.cart_observed_revisions",afterSql:'COPY "orders"."cart_observed_lines"',calls:0},
        {name:"reservation commit",sql:"INSERT INTO orders.mutation_reservations",calls:0},
        {name:"dispatch commit",sql:"UPDATE orders.mutation_reservations SET state='Dispatched'",calls:0},
        {name:"acknowledgement commit",sql:"UPDATE orders.mutation_reservations SET state=$2",calls:1},
        {name:"verification plus terminal/event commit",sql:"UPDATE orders.convergence_attempts SET state=$2",calls:1},
      ]) for(const phase of ["before","after"]) await t.test(`${phase} ${boundary.name}: shutdown rolls back atomically or recovers committed facts without replay`,async () => {
        await reset();
        const cart=fake(),shutdown=new AbortController();
        const hook=()=>shutdown.abort(new Error(`controlled ${phase} ${boundary.name} shutdown`));
        const run=()=>createAromaConvergenceStore(runtime,short).runOnce(cart.gateway,shutdown.signal);
        try {
          if(phase==="before") await statementSeam(boundary.beforeSql ?? boundary.sql,hook,run);
          else await commitSeam(boundary.afterSql ?? boundary.sql,hook,run);
        } catch(error) {
          assert.ok(shutdown.signal.aborted,`only the controlled shutdown may interrupt ${boundary.name}; caught ${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`);
        }

        const beforeRecovery=await facts();
        const oldAttemptRef=beforeRecovery.attempts[0]?.attempt_ref;
        const oldOperationRef=beforeRecovery.reservations[0]?.operation_ref;
        const oldOperationCalls=oldOperationRef===undefined?0:cart.calls.filter(call=>call.request.operationRef===oldOperationRef).length;
        const terminalCommitted=boundary.name==="verification plus terminal/event commit"&&phase==="after";
        assert.equal(cart.calls.length,boundary.calls);
        if(boundary.name==="Attempt commit") assert.equal(beforeRecovery.attempts.length,phase==="after"?1:0);
        if(boundary.name==="initial Observed save") {
          assert.equal((await db.query("SELECT count(*) FROM orders.cart_observed_revisions")).rows[0].count,phase==="after"?"1":"0");
          assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaObservationChanged.v1'")).rows[0].count,phase==="after"?"1":"0");
          assert.equal(beforeRecovery.attempts[0]?.state,phase==="after"?"Observed":"Started");
        }
        if(boundary.name==="reservation commit") {
          assert.equal(beforeRecovery.reservations.length,phase==="after"?1:0);
          assert.equal(beforeRecovery.attempts[0]?.state,phase==="after"?"MutationReserved":"Observed");
        }
        if(boundary.name==="dispatch commit") {
          assert.equal(beforeRecovery.reservations[0]?.state,phase==="after"?"Dispatched":"Reserved");
          assert.equal(beforeRecovery.attempts[0]?.state,phase==="after"?"MutationDispatched":"MutationReserved");
        }
        if(boundary.name==="acknowledgement commit") assert.equal(beforeRecovery.reservations[0]?.state,phase==="after"?"Acknowledged":"Dispatched");
        if(boundary.name==="verification plus terminal/event commit") {
          assert.equal(beforeRecovery.attempts[0]?.ended_at!==null,phase==="after");
          assert.equal((await db.query("SELECT count(*) FROM orders.cart_observed_revisions")).rows[0].count,phase==="after"?"2":"1");
          assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,phase==="after"?"1":"0");
        }
        if(boundary.name!=="verification plus terminal/event commit") assert.equal((await db.query("SELECT count(*) FROM orders.outbox_messages WHERE message_type='AromaConvergenceChanged.v1'")).rows[0].count,"0");

        await db.query("UPDATE orders.convergence_leases SET expires_at=clock_timestamp()-interval '1 millisecond'");
        const restarted=createAromaConvergenceStore(runtime,{...short,ownerInstanceId:owner2});
        await restarted.recover(signal);
        if(oldAttemptRef!==undefined && !terminalCommitted) {
          const recovered=(await facts()).attempts.find(value=>value.attempt_ref===oldAttemptRef);
          assert.equal(recovered.ended_at!==null,true,"expired owner's unfinished Attempt becomes durable terminal recovery");
        }
        if(oldOperationRef!==undefined && !terminalCommitted) {
          assert.equal((await facts()).reservations.find(value=>value.operation_ref===oldOperationRef).state,"UnknownOutcome");
          assert.equal(await restarted.runOnce(cart.gateway,signal),"idle","unresolved reservation is a recovery barrier until its dispatch window ends");
          await waitBarrier();
        } else await due();
        cart.beforeRead=undefined;
        const recoveryResult=await restarted.runOnce(cart.gateway,signal);
        assert.equal(cart.calls.length,1);
        if(oldOperationRef!==undefined) assert.equal(cart.calls.filter(call=>call.request.operationRef===oldOperationRef).length,oldOperationCalls,"recovery never resubmits the old operationRef");
        if(terminalCommitted) {
          assert.equal(recoveryResult,"idle");
          assert.equal((await db.query("SELECT dirty FROM orders.convergence_work")).rows[0].dirty,false);
          assert.equal((await facts()).reservations[0].state,"Verified");
          assert.equal((await facts()).attempts[0].state,"VerifiedInSync");
          assert.equal(cart.calls.length,1);
        }
        assert.equal(runtime.metrics().active,0);
      });
    } finally {
      if(runtime) await runtime.resource.stop(AbortSignal.timeout(5_000));
      await db.end();
    }
    return {role:ROLE,provider:"controlled fake only"};
  });
  assert.equal(receipt.cleanup.containerRemoved,true);
});
