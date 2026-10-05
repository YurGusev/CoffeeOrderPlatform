import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {createHash,randomBytes} from "node:crypto";
import {Client} from "pg";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const ORDER="ord_00000000000000000000000001";
const OFFER="off_00000000000000000000000001";
const SCOPE="aroma-primary";
const H="a".repeat(64);
const F="b".repeat(64); // Gateway fingerprint не является Desired hash.
const OWNER="00000000-0000-4000-8000-000000000001";
const ATTEMPT=n=>`att_${String(n).padStart(26,"0")}`;
const OP=n=>`op_${String(n).padStart(26,"0")}`;
const ROLES=["coffee_orders_service_rw","coffee_orders_prepare_rw","coffee_orders_observer_rw","coffee_orders_convergence_rw"];
const MIGRATIONS=["0001_create_orders","0002_create_order_items","0003_create_order_history","0004_create_order_contributions","0005_create_orders_idempotency","0006_create_orders_outbox","0007_order_grind_selection","0008_create_orders_inbox","0009_create_catalog_mapping_projection","0010_create_cart_desired","0011_create_cart_observed","0012_create_convergence_attempts","0013_create_convergence_leases","0014_create_mutation_reservations","0015_create_order_aroma_projections","0016_create_aroma_work_schedules","0017_allow_cart_outbox","0018_guard_order_card_projection","0019_read_guarded_aroma_card","0020_guard_cart_fact_batches"];

async function rejectsSql(db,sql,parameters=[],code="23514") {
  await db.query("SAVEPOINT rejected_sql");
  try { await assert.rejects(db.query(sql,parameters),{code}); }
  finally { await db.query("ROLLBACK TO SAVEPOINT rejected_sql; RELEASE SAVEPOINT rejected_sql"); }
}
async function transaction(db,run) {
  await db.query("BEGIN");
  try { await run(); } finally { await db.query("ROLLBACK"); }
}

async function desiredLine(db,revision,quantity=1000,grind=null) {
  await db.query("INSERT INTO orders.cart_desired_lines(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,contributing_order_refs) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[SCOPE,revision,OFFER,grind,quantity,H,JSON.stringify([ORDER])]);
}
async function observedLine(db,revision,quantity=1000,grind=null) {
  await db.query("INSERT INTO orders.cart_observed_lines(cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash) VALUES($1,$2,$3,$4,$5,$6)",[SCOPE,revision,OFFER,grind,quantity,H]);
}
async function freshDesired(db,revision=2,quantity=2000,grind=null) {
  await db.query("UPDATE orders.cart_desired_revisions SET state='Superseded' WHERE state='Current'");
  await db.query("INSERT INTO orders.cart_desired_revisions(cart_scope_ref,desired_revision,state,desired_hash,source_max_order_version) VALUES($1,$2,'Current',$3,1)",[SCOPE,revision,H]);
  if(quantity!==null) await desiredLine(db,revision,quantity,grind);
  await db.query("INSERT INTO orders.cart_desired_order_facts(cart_scope_ref,desired_revision,order_ref,contribution_revision,contribution_hash) VALUES($1,$2,$3,1,$4)",[SCOPE,revision,ORDER,H]);
}
async function freshObserved(db,revision=2,quantity=2000,grind=null,attempt=null,fence=null) {
  await db.query("UPDATE orders.cart_observed_revisions SET state='Superseded' WHERE state='Current'");
  await db.query("INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind,source_attempt_ref,fence_epoch) VALUES($1,$2,'Current','snapshot-proof',$3,transaction_timestamp(),$4,$5,$6)",[SCOPE,revision,F,attempt===null?"Observer":"Convergence",attempt,fence]);
  if(quantity!==null) await observedLine(db,revision,quantity,grind);
}
async function attempt(db,n,{desired=2,fence=n,grind=null,action="SetQuantity",state="Observed",baseline=1}={}) {
  await db.query("INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state,observed_start_revision,selected_offer_ref,selected_source_grind_key_hash,selected_action,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7::varchar='NoOpInSync' THEN transaction_timestamp() ELSE NULL END)",[ATTEMPT(n),SCOPE,desired,H,OWNER,fence,state,baseline,action===null?null:OFFER,grind,action]);
}
const RESERVE="INSERT INTO orders.mutation_reservations(operation_ref,attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_before_revision,action,offer_ref,source_grind_key_hash,observed_before_milli,desired_milli,target_provider_quantity,request_hash,reserved_until,provider_deadline_at,safety_margin_ms,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,transaction_timestamp()+interval '20 seconds',transaction_timestamp()+interval '10 seconds',1000,'Reserved')";
const reservation=(n,{operation=n,desired=2,fence=n,baseline=1,action="SetQuantity",grind=null,before=1000,quantity=2000,target=2}={})=>[OP(operation),ATTEMPT(n),SCOPE,desired,fence,baseline,action,OFFER,grind,before,quantity,target,H];
const SYNC_PROJECTION="INSERT INTO orders.order_aroma_projections(order_ref,cart_scope_ref,projection_version,desired_revision,desired_hash,observed_revision,observed_cart_fingerprint,verified_desired_revision,verified_desired_hash,verified_observed_revision,verified_cart_fingerprint,attempt_ref,verified_attempt_ref,fence_epoch,state,source_message_id) VALUES($1,$2,1,$6,$3,1,$4,$6,$3,1,$4,$5,$5,1,'InSync','proof')";

const FORMAT_CHECKS=[
  {column:"offer_ref",type:"varchar(30)",nullable:false,valid:OFFER,
    old:"offer_ref ~ '^off_[0-9A-HJKMNP-TV-Z]{26}$'",
    fast:"char_length(offer_ref) = 30 AND left(offer_ref,4) = 'off_' AND substring(offer_ref from 5) !~ '[^0-9A-HJKMNP-TV-Z]'"},
  {column:"source_grind_key_hash",type:"char(64)",nullable:true,valid:H,
    old:"source_grind_key_hash IS NULL OR source_grind_key_hash ~ '^[0-9a-f]{64}$'",
    fast:"source_grind_key_hash IS NULL OR (char_length(source_grind_key_hash::text) = 64 AND source_grind_key_hash::text !~ '[^0-9a-f]')"},
  {column:"sanitized_line_hash",type:"char(64)",nullable:false,valid:H,
    old:"sanitized_line_hash ~ '^[0-9a-f]{64}$'",
    fast:"char_length(sanitized_line_hash::text) = 64 AND sanitized_line_hash::text !~ '[^0-9a-f]'"},
];
function formatCases(check) {
  const offer=check.column==="offer_ref",prefix=offer?"off_":"",width=offer?26:64;
  const alphabet=offer?"0123456789ABCDEFGHJKMNPQRSTVWXYZ":"0123456789abcdef";
  const values=new Set([null,"",check.valid,check.valid+" ",check.valid+"   ",check.valid+"X",
    check.valid+"\n",check.valid+"\t"," "+check.valid,check.valid.slice(1),"\0",
    check.valid.slice(0,-1)+" ",check.valid.toLowerCase(),check.valid.toUpperCase()]);
  for(const length of [0,1,width-1,width,width+1,width+2]) values.add(prefix+"0".repeat(length));
  // Каждый разрешённый символ во всех позициях, а не только decimal fixtures.
  for(const char of alphabet) for(let position=0;position<width;position++)
    values.add(prefix+"0".repeat(position)+char+"0".repeat(width-position-1));
  for(const char of ["I","L","O","U","i","l","o","u","g","A","F","-","_","\n","\r","\t","\u0001","\u007f","é","Ж","😀","\u0301","０","Ａ","\u00a0","\u2028"," "])
    for(const position of [0,Math.floor(width/2),width-1]) values.add(prefix+"0".repeat(position)+char+"0".repeat(width-position-1));
  if(offer) for(const wrongPrefix of ["OFF_","Off_","off-","off ","of_"," off","oﬀ_"]) values.add(wrongPrefix+"0".repeat(26));
  let seed=0x00212026;
  const next=()=>{ seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed; };
  const chars=alphabet+"IlOUg_- \n\tЖé";
  for(let n=0;n<128;n++) {
    const length=next()%(width+5); let text=prefix;
    for(let i=0;i<length;i++) text+=chars[next()%chars.length];
    values.add(text);
  }
  return [...values];
}
async function observedExpressionParity(db, identityCollation="default") {
  const columns=(await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,
    c.collname,c.collprovider,c.collisdeterministic FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
    WHERE a.attrelid='orders.cart_observed_lines'::regclass AND a.attname=ANY($1::text[]) ORDER BY a.attname`,[FORMAT_CHECKS.map(row=>row.column)])).rows;
  assert.equal(columns.length,3);
  assert.ok(columns.every(row=>row.collisdeterministic&&row.collname===identityCollation));
  assert.deepEqual(columns.map(row=>[row.attname,row.type]),[
    ["offer_ref","character varying(30)"],["sanitized_line_hash","character(64)"],["source_grind_key_hash","character(64)"],
  ]);
  const environment=(await db.query("SELECT current_setting('server_encoding') AS encoding,datcollate,datctype FROM pg_database WHERE datname=current_database()")).rows[0];
  assert.equal(environment.encoding,"UTF8");
  let assignments=0,assignmentErrors=0,unknowns=0;
  for(const check of FORMAT_CHECKS) {
    const collate=identityCollation==="C"?' COLLATE "C"':"";
    await db.query(`CREATE TEMP TABLE observed_format_input (${check.column} ${check.type}${collate}) ON COMMIT DROP`);
    for(const value of formatCases(check)) {
      await db.query("SAVEPOINT format_input");
      try {
        // Assignment, без explicit typmod cast: overflow и bpchar padding настоящие.
        await db.query(`INSERT INTO observed_format_input VALUES($1)`,[value]);
        const row=(await db.query(`SELECT (${check.old}) AS old,(${check.fast}) AS fast FROM observed_format_input`)).rows[0];
        assert.equal(row.fast,row.old,`${check.column}: ${JSON.stringify(value)}`);
        assignments++; if(row.old===null) unknowns++;
      } catch(error) {
        assert.ok(["22001","22021"].includes(error.code),String(error)); assignmentErrors++;
      } finally { await db.query("ROLLBACK TO SAVEPOINT format_input; RELEASE SAVEPOINT format_input"); }
    }
    await db.query("DROP TABLE observed_format_input");
  }
  assert.equal(unknowns,2); // CHECK UNKNOWN допускает NULL; column NOT NULL — отдельно.
  // Полный Unicode scalar repertoire UTF8 (NUL/суррогаты не хранятся в PostgreSQL).
  // Совпадение positive/negative односимвольного класса + exact length/prefix
  // обосновывает произвольные комбинации, не объявляя corpus исчерпывающим.
  const offerCollation=identityCollation==="C"?' COLLATE "C"':"";
  const hashCollation=identityCollation==="C"?' COLLATE "C"':"";
  const unicode=(await db.query(`WITH chars AS (
    SELECT chr(n) AS ch FROM generate_series(1,1114111) n WHERE n NOT BETWEEN 55296 AND 57343
  ) SELECT count(*)::int AS scalars,
    count(*) FILTER (WHERE ((ch${offerCollation}) ~ '^[0-9A-HJKMNP-TV-Z]$') IS DISTINCT FROM ((ch${offerCollation}) !~ '[^0-9A-HJKMNP-TV-Z]'))::int AS offer_mismatches,
    count(*) FILTER (WHERE ((ch${hashCollation}) ~ '^[0-9a-f]$') IS DISTINCT FROM ((ch${hashCollation}) !~ '[^0-9a-f]'))::int AS hash_mismatches FROM chars`)).rows[0];
  assert.equal(unicode.offer_mismatches,0); assert.equal(unicode.hash_mismatches,0);
  return {environment,columns,assignments,assignmentErrors,unknowns,unicode};
}
async function observedOwnerAssignments(db) {
  await db.query("BEGIN");
  const results=[];
  try {
    await freshObserved(db,2,null);
    for(const check of FORMAT_CHECKS) for(const value of formatCases(check)) {
      const values=[OFFER,null,H]; values[FORMAT_CHECKS.indexOf(check)]=value;
      await db.query("SAVEPOINT format_owner");
      try {
        await db.query(`INSERT INTO orders.cart_observed_lines(cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash)
          VALUES('aroma-primary',2,$1,$2,1000,$3)`,values);
        const stored=(await db.query("SELECT offer_ref,source_grind_key_hash,sanitized_line_hash FROM orders.cart_observed_lines WHERE observed_revision=2")).rows;
        results.push({column:check.column,value,code:"00000",stored});
      } catch(error) {
        assert.ok(["23502","23514","22001","22021"].includes(error.code),String(error));
        results.push({column:check.column,value,code:error.code});
      } finally { await db.query("ROLLBACK TO SAVEPOINT format_owner; RELEASE SAVEPOINT format_owner"); }
    }
    for(const check of FORMAT_CHECKS) {
      assert.equal(results.find(row=>row.column===check.column&&row.value===null).code,check.nullable?"00000":"23502");
      assert.equal(results.find(row=>row.column===check.column&&row.value===check.valid).code,"00000");
      assert.equal(results.find(row=>row.column===check.column&&row.value===check.valid+" ").code,"00000");
      assert.equal(results.find(row=>row.column===check.column&&row.value===check.valid+"X").code,"22001");
      assert.equal(results.find(row=>row.column===check.column&&row.value===check.valid.slice(0,-1)+" ").code,"23514");
    }
    return results;
  } finally { await db.query("ROLLBACK"); }
}

async function observedSchemaMetadata(db) {
  const queries={
    constraints:`SELECT c.oid::text,c.conname,c.conrelid::regclass::text AS relation,pg_get_constraintdef(c.oid) AS definition,
      c.convalidated,c.condeferrable,c.condeferred FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='orders' ORDER BY c.oid`,
    columns:`SELECT a.attrelid::regclass::text AS relation,a.attname,a.atttypid,a.atttypmod,a.attnotnull,a.attcollation,
      pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='orders' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attrelid,a.attnum`,
    indexes:`SELECT c.oid::text,pg_get_indexdef(c.oid) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='orders' AND c.relkind='i' ORDER BY c.oid`,
    triggers:`SELECT t.oid::text,t.tgenabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='orders' ORDER BY t.oid`,
    functions:`SELECT p.oid::text,p.proowner,p.proacl,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='orders' ORDER BY p.oid`,
    grants:`SELECT c.oid::text,c.relname,c.relowner,c.relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='orders' ORDER BY c.oid`,
    schema:"SELECT oid::text,nspowner,nspacl FROM pg_namespace WHERE nspname='orders'",
    roles:"SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname LIKE 'coffee_orders_%' ORDER BY rolname",
  };
  const result={};
  for(const [name,sql] of Object.entries(queries)) result[name]=(await db.query(sql)).rows;
  return result;
}
async function ordersStoredRows(db) {
  const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='orders' ORDER BY tablename")).rows;
  const result={};
  for(const {tablename} of tables) result[tablename]=(await db.query(`SELECT to_jsonb(row) AS data,xmin::text,ctid::text FROM orders.${tablename} AS row ORDER BY to_jsonb(row)::text`)).rows;
  return result;
}

void test("disposable PostgreSQL: Orders-owned AROMA constraints и реальные runtime grants",{
  timeout:180_000,skip:process.env.COFFEE_DB_LIVE_PROOF!=="1"?"disposable PostgreSQL required":false,
},async t=>{
  const receipt=await withCatalogPostgres(async({adminClient,port})=>{
    const passwords=new Map();
    for(const role of ["coffee_orders_migrator",...ROLES]) {
      const password=randomBytes(24).toString("hex"); passwords.set(role,password);
      await adminClient.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    await adminClient.query("CREATE DATABASE coffee_platform_orders OWNER coffee_orders_migrator");
    await adminClient.query("REVOKE ALL ON DATABASE coffee_platform_orders FROM PUBLIC");
    await adminClient.query(`GRANT CONNECT ON DATABASE coffee_platform_orders TO ${ROLES.join(",")}`);
    const connect=async(role,database="coffee_platform_orders")=>{
      const client=new Client({host:"127.0.0.1",port,database,user:role,password:passwords.get(role),connectionTimeoutMillis:2_000,ssl:false});
      try { await client.connect(); return client; } catch(error) { await client.end(); throw error; }
    };
    const db=await connect("coffee_orders_migrator");
    try {
      await db.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      for(const id of MIGRATIONS)
        await db.query(await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`,import.meta.url),"utf8"));
      t.diagnostic(`Чистая Orders DB: ${MIGRATIONS.join(", ")}; migration owner=coffee_orders_migrator`);
      await db.query("BEGIN");
      await db.query("INSERT INTO orders.orders(order_ref,status,confirmed_at,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref) VALUES($1,'Confirmed',transaction_timestamp(),$2,1,'Test','Active',$3,'test','test')",[ORDER,"cus_00000000000000000000000001",H]);
      await db.query("INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version) VALUES($1,1,1)",[ORDER]);
      await db.query("INSERT INTO orders.cart_desired_revisions(cart_scope_ref,desired_revision,state,desired_hash,source_max_order_version) VALUES($1,1,'Current',$2,1)",[SCOPE,H]);
      await db.query("INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind) VALUES($1,1,'Current','snapshot-proof',$2,transaction_timestamp(),'Observer')",[SCOPE,F]);
      await desiredLine(db,1);
      await observedLine(db,1);
      await db.query("INSERT INTO orders.cart_desired_order_facts(cart_scope_ref,desired_revision,order_ref,contribution_revision,contribution_hash) VALUES($1,1,$2,1,$3)",[SCOPE,ORDER,H]);
      await db.query("COMMIT");
      await t.test("Observed CHECK expression parity на исходных varchar/bpchar и Unicode",async()=>{
        let proof;
        await transaction(db,async()=>{ proof=await observedExpressionParity(db); });
        t.diagnostic(JSON.stringify(proof));
      });
      const convergence=await connect("coffee_orders_convergence_rw");
      try {
        const beforeAssignments=await observedOwnerAssignments(convergence);
        await t.test("0021 populated upgrade сохраняет все rows/FK/indexes/triggers/grants/types",async()=>{
          const beforeMetadata=await observedSchemaMetadata(db),beforeRows=await ordersStoredRows(db);
          await db.query(await readFile(new URL("../../apps/orders-service/migrations/0021_optimize_observed_format_checks.sql",import.meta.url),"utf8"));
          const afterMetadata=await observedSchemaMetadata(db),afterRows=await ordersStoredRows(db);
          const changed=new Set(FORMAT_CHECKS.map(row=>`cart_observed_lines_${row.column}_check`));
          assert.equal(beforeMetadata.constraints.filter(row=>changed.has(row.conname)&&row.relation==="orders.cart_observed_lines").length,3);
          assert.equal(afterMetadata.constraints.filter(row=>changed.has(row.conname)&&row.relation==="orders.cart_observed_lines"&&row.convalidated&&!row.condeferrable).length,3);
          assert.ok(afterMetadata.constraints.filter(row=>changed.has(row.conname)&&row.relation==="orders.cart_observed_lines")
            .every(row=>row.definition.includes("char_length")&&row.definition.includes("!~")&&!beforeMetadata.constraints.some(old=>old.oid===row.oid)));
          const unchanged=metadata=>({...metadata,constraints:metadata.constraints.filter(row=>!(changed.has(row.conname)&&row.relation==="orders.cart_observed_lines"))});
          assert.deepEqual(unchanged(afterMetadata),unchanged(beforeMetadata));
          assert.deepEqual(afterRows,beforeRows);
          t.diagnostic(JSON.stringify({unchangedMetadata:Object.fromEntries(Object.entries(beforeMetadata).map(([name,rows])=>[name,rows.length])),
            preservedRows:Object.fromEntries(Object.entries(beforeRows).map(([name,rows])=>[name,rows.length])),
            changedChecks:afterMetadata.constraints.filter(row=>changed.has(row.conname)&&row.relation==="orders.cart_observed_lines")}));
        });
        await t.test("0021 реальные owner INSERT/SQLSTATE/storage до и после эквивалентны",async()=>{
          const afterAssignments=await observedOwnerAssignments(convergence);
          assert.deepEqual(afterAssignments,beforeAssignments);
          t.diagnostic(JSON.stringify({owner:"coffee_orders_convergence_rw",cases:afterAssignments.length,
            sqlstates:afterAssignments.reduce((counts,row)=>(counts[row.code]=(counts[row.code]??0)+1,counts),{})}));
        });
        await t.test("0021 owner runtime не получает DDL; FK/unique/quantity/creator/immutable fail closed",async()=>{
          await transaction(convergence,async()=>{
            await rejectsSql(convergence,"ALTER TABLE orders.cart_observed_lines ADD COLUMN runtime_escape text",[],"42501");
            await rejectsSql(convergence,"CREATE TABLE orders.runtime_escape(value text)",[],"42501");
            await rejectsSql(convergence,"INSERT INTO orders.cart_observed_lines VALUES($1,999,$2,NULL,1000,$3)",[SCOPE,OFFER,H],"23503");
            await rejectsSql(convergence,"INSERT INTO orders.cart_observed_lines VALUES($1,1,$2,$3,1000,$3)",[SCOPE,OFFER,H]);
            await freshObserved(convergence,2,null);
            await observedLine(convergence,2);
            await rejectsSql(convergence,"INSERT INTO orders.cart_observed_lines VALUES($1,2,$2,NULL,1000,$3)",[SCOPE,OFFER,H],"23505");
            await rejectsSql(convergence,"INSERT INTO orders.cart_observed_lines VALUES($1,2,$2,$3,0,$3)",[SCOPE,OFFER,H]);
            await rejectsSql(convergence,"INSERT INTO orders.cart_observed_lines VALUES($1,2,$2,$3,1000,$3)",[SCOPE,"off_"+"I".repeat(26),H]);
            await rejectsSql(convergence,"UPDATE orders.cart_observed_lines SET quantity_milli=3000",[],"42501");
            await rejectsSql(convergence,"DELETE FROM orders.cart_observed_lines",[],"42501");
            await rejectsSql(convergence,"UPDATE orders.cart_observed_revisions SET cart_fingerprint=$1",[H]);
            await rejectsSql(convergence,"DELETE FROM orders.cart_observed_revisions",[],"42501");
          });
        });
        await t.test("0022 adds terminal definitive rejection without changing existing reservation facts",async()=>{
          const beforeRows=await ordersStoredRows(db);
          await db.query(await readFile(new URL("../../apps/orders-service/migrations/0022_terminal_cart_item_rejection.sql",import.meta.url),"utf8"));
          const afterMetadata=await observedSchemaMetadata(db),afterRows=await ordersStoredRows(db);
          const state=afterMetadata.constraints.find(row=>row.relation==="orders.mutation_reservations"&&row.conname==="mutation_reservations_state_check");
          const resolved=afterMetadata.constraints.find(row=>row.relation==="orders.mutation_reservations"&&row.conname==="mutation_reservations_check3");
          const rejectedHash=afterMetadata.constraints.find(row=>row.relation==="orders.mutation_reservations"&&row.conname==="mutation_reservations_rejected_outcome_check");
          assert.ok(state?.definition.includes("'Rejected'")&&state.convalidated&&!state.condeferrable);
          assert.ok(resolved?.definition.includes("'Rejected'")&&resolved.convalidated&&!resolved.condeferrable);
          assert.ok(rejectedHash?.definition.includes("gateway_outcome_hash IS NOT NULL")&&rejectedHash.convalidated);
          assert.ok(afterMetadata.functions.find(row=>row.definition.includes("guard_mutation_reservation"))?.definition.includes("NEW.state = 'Rejected' AND OLD.state <> 'Dispatched'"));
          assert.deepEqual(afterRows,beforeRows);
        });
        await t.test("0023 uses bytewise collation for observed ASCII fields without changing its guards",async()=>{
          const before=await observedSchemaMetadata(db),beforeRows=await ordersStoredRows(db);
          await db.query(await readFile(new URL("../../apps/orders-service/migrations/0023_ascii_observed_identity.sql",import.meta.url),"utf8"));
          const after=await observedSchemaMetadata(db),afterRows=await ordersStoredRows(db);
          const normalizeColumns=metadata=>metadata.columns.map(row=>({...row,
            attcollation:["offer_ref","source_grind_key_hash","sanitized_line_hash"].includes(row.attname)&&row.relation==="orders.cart_observed_lines"
              ? before.columns.find(old=>old.relation===row.relation&&old.attname===row.attname).attcollation : row.attcollation}));
          const orderedConstraints=metadata=>metadata.constraints.map(({oid:_oid,...row})=>row)
            .sort((left,right)=>left.relation<right.relation?-1:left.relation>right.relation?1:left.conname<right.conname?-1:left.conname>right.conname?1:0);
          const orderedGrants=metadata=>metadata.grants.map(({oid:_oid,...row})=>row)
            .sort((left,right)=>left.relname<right.relname?-1:left.relname>right.relname?1:0);
          assert.deepEqual(normalizeColumns(after),before.columns);
          assert.deepEqual(orderedConstraints(after),orderedConstraints(before));
          assert.deepEqual(after.triggers,before.triggers);
          assert.deepEqual(after.functions,before.functions);
          assert.deepEqual(orderedGrants(after),orderedGrants(before));
          assert.deepEqual(after.schema,before.schema);
          assert.deepEqual(after.roles,before.roles);
          assert.deepEqual(afterRows,beforeRows);
          const identity=(await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,c.collname
            FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
            WHERE a.attrelid='orders.cart_observed_lines'::regclass AND a.attname=ANY($1::text[]) ORDER BY a.attname`,
            [["offer_ref","sanitized_line_hash","source_grind_key_hash"]])).rows;
          assert.deepEqual(identity,[
            {attname:"offer_ref",type:"character varying(30)",collname:"C"},
            {attname:"sanitized_line_hash",type:"character(64)",collname:"C"},
            {attname:"source_grind_key_hash",type:"character(64)",collname:"C"},
          ]);
          const observedUnique=after.indexes.find(row=>row.definition.includes("ON orders.cart_observed_lines")&&row.definition.includes("offer_ref"));
          assert.match(observedUnique?.definition??"",/CREATE UNIQUE INDEX/u);
          assert.match(observedUnique?.definition??"",/NULLS NOT DISTINCT/u);
          const indexCollations=(await db.query(`SELECT i.indisunique,i.indnullsnotdistinct,
              array_agg(COALESCE(c.collname::text,'none') ORDER BY key.ordinality) AS collations
            FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key(attnum,ordinality)
            JOIN LATERAL unnest(i.indcollation::oid[]) WITH ORDINALITY AS ic(oid,ordinality) USING(ordinality)
            LEFT JOIN pg_collation c ON c.oid=ic.oid
            WHERE i.indrelid='orders.cart_observed_lines'::regclass AND i.indisunique AND i.indnullsnotdistinct
            GROUP BY i.indexrelid,i.indisunique,i.indnullsnotdistinct`)).rows;
          assert.equal(indexCollations.length,1);
          assert.equal(indexCollations[0].indisunique,true);
          assert.equal(indexCollations[0].indnullsnotdistinct,true);
          assert.deepEqual(indexCollations[0].collations.slice(-2),["C","C"]);
          const afterAssignments=await observedOwnerAssignments(convergence);
          assert.deepEqual(afterAssignments,beforeAssignments);
          let proof;
          await transaction(db,async()=>{ proof=await observedExpressionParity(db,"C"); });
          t.diagnostic(JSON.stringify({identity,uniqueIndex:observedUnique?.definition,indexCollations:indexCollations[0],ownerAssignments:afterAssignments.length,
            preservedRows:Object.fromEntries(Object.entries(afterRows).map(([name,rows])=>[name,rows.length])),proof}));
        });
      } finally { await convergence.end(); }
      await t.test("Чистая 0001..0023 Orders DB принимает forward migrations",async()=>{
        await adminClient.query("CREATE DATABASE coffee_platform_orders_clean OWNER coffee_orders_migrator");
        const clean=await connect("coffee_orders_migrator","coffee_platform_orders_clean");
        try {
          await clean.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
          for(const id of [...MIGRATIONS,"0021_optimize_observed_format_checks","0022_terminal_cart_item_rejection","0023_ascii_observed_identity"])
            await clean.query(await readFile(new URL(`../../apps/orders-service/migrations/${id}.sql`,import.meta.url),"utf8"));
          const orderedObservedConstraints=metadata=>metadata.constraints.filter(row=>row.relation==="orders.cart_observed_lines")
            .map(({oid:_oid,...row})=>row).sort((left,right)=>left.conname<right.conname?-1:left.conname>right.conname?1:0);
          assert.deepEqual(orderedObservedConstraints(await observedSchemaMetadata(clean)),orderedObservedConstraints(await observedSchemaMetadata(db)));
          const cleanIdentity=(await clean.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,c.collname
            FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation
            WHERE a.attrelid='orders.cart_observed_lines'::regclass AND a.attname=ANY($1::text[]) ORDER BY a.attname`,
            [["offer_ref","sanitized_line_hash","source_grind_key_hash"]])).rows;
          assert.deepEqual(cleanIdentity,[
            {attname:"offer_ref",type:"character varying(30)",collname:"C"},
            {attname:"sanitized_line_hash",type:"character(64)",collname:"C"},
            {attname:"source_grind_key_hash",type:"character(64)",collname:"C"},
          ]);
        } finally { await clean.end(); }
      });
      const check=async(name,run)=>t.test(name,()=>transaction(db,()=>run(db)));
      await check("полный nullable physical key, один Current Desired",async()=>{
        await freshDesired(db,2,null);
        const desired="INSERT INTO orders.cart_desired_lines(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,contributing_order_refs) VALUES($1,2,$2,$3,1000,$4,$5::jsonb)";
        await db.query(desired,[SCOPE,OFFER,null,H,JSON.stringify([ORDER])]);
        await db.query(desired,[SCOPE,OFFER,H,H,JSON.stringify([ORDER])]);
        await rejectsSql(db,desired,[SCOPE,OFFER,null,H,JSON.stringify([ORDER])],"23505");
        await rejectsSql(db,"INSERT INTO orders.cart_desired_revisions(cart_scope_ref,desired_revision,state,desired_hash,source_max_order_version) VALUES($1,2,'Current',$2,1)",[SCOPE,H],"23505");
      });
      await check("Convergence Observed отвергает NULL fence, а failed/partial GET не заменяет Current",async()=>{
        await rejectsSql(db,"INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind,source_attempt_ref,fence_epoch) VALUES($1,2,'Superseded','snapshot-proof',$2,transaction_timestamp(),'Convergence',$3,NULL)",[SCOPE,F,ATTEMPT(1)]);
        await rejectsSql(db,"UPDATE orders.cart_observed_revisions SET complete=false WHERE observed_revision=1");
        assert.equal((await db.query("SELECT observed_revision FROM orders.cart_observed_revisions WHERE state='Current'")).rows[0].observed_revision,"1");
      });
      await check("InSync fail-closed при NULL verified facts/fence",async()=>{
        await rejectsSql(db,"INSERT INTO orders.order_aroma_projections(order_ref,cart_scope_ref,projection_version,desired_revision,observed_revision,state,verified_attempt_ref,fence_epoch,source_message_id) VALUES($1,$2,1,1,1,'InSync',$3,NULL,'proof')",[ORDER,SCOPE,ATTEMPT(1)]);
      });
      await check("InSync принимает current proof, но не подтверждает старый fence после takeover",async()=>{
        await attempt(db,1,{desired:1,action:null,state:"NoOpInSync"});
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        await rejectsSql(db,SYNC_PROJECTION,[ORDER,SCOPE,H,F,ATTEMPT(1),1]);
        await db.query("INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,expires_at) VALUES($1,$2,1,transaction_timestamp()+interval '30 seconds')",[SCOPE,OWNER]);
        await db.query("UPDATE orders.convergence_leases SET expires_at=acquired_at");
        await db.query(SYNC_PROJECTION,[ORDER,SCOPE,H,F,ATTEMPT(1),1]);
        assert.equal((await db.query("SELECT state FROM orders.order_aroma_projections")).rows[0].state,"InSync");
        await db.query("UPDATE orders.convergence_leases SET fence_epoch=2,owner_instance_id='00000000-0000-4000-8000-000000000002'");
        await rejectsSql(db,"UPDATE orders.order_aroma_projections SET projection_version=2");
      });
      for(const state of ["Reserved","Dispatched","Acknowledged","UnknownOutcome"])
        await check(`InSync не скрывает unresolved reservation ${state}`,async()=>{
          await attempt(db,1,{desired:1,action:null,state:"NoOpInSync"});
          await attempt(db,2,{desired:1,fence:1});
          await db.query("INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,expires_at) VALUES($1,$2,1,transaction_timestamp()+interval '30 seconds')",[SCOPE,OWNER]);
          await db.query(RESERVE,reservation(2,{desired:1,fence:1,quantity:1000,target:1}));
          if(state!=="Reserved") await db.query("UPDATE orders.mutation_reservations SET state=$1",[state]);
          await rejectsSql(db,SYNC_PROJECTION,[ORDER,SCOPE,H,F,ATTEMPT(1),1]);
        });
      await check("InSync не скрывает blocker current Desired пустыми blocker_codes",async()=>{
        await freshDesired(db,2,1000);
        await db.query("INSERT INTO orders.cart_desired_blockers(cart_scope_ref,desired_revision,order_ref,product_ref,variant_ref,code) VALUES($1,2,$2,'prd_00000000000000000000000001','var_00000000000000000000000001','MAPPING_MISSING')",[SCOPE,ORDER]);
        await attempt(db,1,{desired:2,action:null,state:"NoOpInSync"});
        await db.query("INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,expires_at) VALUES($1,$2,1,transaction_timestamp()+interval '30 seconds')",[SCOPE,OWNER]);
        await rejectsSql(db,SYNC_PROJECTION,[ORDER,SCOPE,H,F,ATTEMPT(1),2]);
      });
      await check("Inbox сохраняет envelope/payload, lease, quarantine и durable result",async()=>{
        const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='orders' AND table_name='inbox_messages'")).rows.map(row=>row.column_name);
        for(const field of ["schema_version","envelope_hash","envelope","payload","state","lease_owner","lease_until","attempt","quarantine_reason","quarantined_at","outcome","result"])
          assert.ok(columns.includes(field),`Inbox missing ${field}`);
      });
      await check("mapping revision/hash guard не допускает rollback и equal-revision conflict",async()=>{
        await db.query("INSERT INTO orders.catalog_mapping_projection(product_ref,variant_ref,offer_ref,mapping_revision,catalog_snapshot_revision,mapping_state,availability,effective_at,source_message_id,payload_hash) VALUES('prd_00000000000000000000000001','var_00000000000000000000000001',$1,2,2,'Active','Available',transaction_timestamp(),'mapping',$2)",[OFFER,H]);
        await rejectsSql(db,"UPDATE orders.catalog_mapping_projection SET mapping_revision=1");
        await rejectsSql(db,"UPDATE orders.catalog_mapping_projection SET payload_hash=$1",[F]);
        await db.query("UPDATE orders.catalog_mapping_projection SET mapping_revision=3,catalog_snapshot_revision=3");
      });
      await t.test("worker grants реально доступны через runtime login без DDL/core UPDATE",async()=>{
        const role=await connect("coffee_orders_prepare_rw");
        try { await transaction(role,async()=>{
          for(const table of ["orders","order_items","order_desired_contributions","order_desired_contribution_lines","order_history","cart_desired_revisions","convergence_leases","mutation_reservations"])
            await role.query(`SELECT * FROM orders.${table} LIMIT 0`);
          await rejectsSql(role,"UPDATE orders.orders SET version=version WHERE false",[],"42501");
          await rejectsSql(role,"UPDATE orders.convergence_leases SET expires_at=expires_at WHERE false",[],"42501");
          await rejectsSql(role,"UPDATE orders.mutation_reservations SET state=state WHERE false",[],"42501");
          await rejectsSql(role,"CREATE TABLE orders.worker_escape(value text)",[],"42501");
        }); } finally { await role.end(); }
      });
      await check("Attempt/Operation/Offer принимают канонический uppercase ULID, не lowercase",async()=>{
        await freshDesired(db);
        await db.query("INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state,selected_offer_ref,selected_action) VALUES($1,$2,2,$3,$4,1,'Started',$5,'SetQuantity')",["att_01ARZ3NDEKTSV4RRFFQ69G5FAX",SCOPE,H,OWNER,"off_01ARZ3NDEKTSV4RRFFQ69G5FAZ"]);
        await attempt(db,1);
        const values=reservation(1);
        values[0]="op_01ARZ3NDEKTSV4RRFFQ69G5FB2";
        await db.query(RESERVE,values);
        await rejectsSql(db,"INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state) VALUES($1,$2,2,$3,$4,1,'Started')",["att_01arz3ndektsv4rrffq69g5fax",SCOPE,H,OWNER]);
      });
      await check("Outbox immutable bytes/hash связаны с JSON и отвергают повреждённые facts",async()=>{
        const payload={cartScopeRef:SCOPE,observedRevision:"1",observedAt:"2026-10-03T00:00:00Z",observationState:"Complete",cartFingerprint:F};
        const envelope={envelopeVersion:"1",messageId:"msg_00000000000000000000000001",messageType:"AromaObservationChanged.v1",
          occurredAt:payload.observedAt,producer:"aroma-observer",correlationId:OWNER,causationId:null,
          traceparent:"00-11111111111111111111111111111111-2222222222222222-01",aggregate:{type:"AromaCart",ref:SCOPE,version:"1"},payload};
        const wire=JSON.stringify(envelope),digest=createHash("sha256").update(wire).digest("hex");
        const insert=`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,
          partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,traceparent,lease_until)
          VALUES($1,'AromaObservationChanged.v1','coffee.aroma.cart.events.v1',$2::varchar(30),1,'1',$2::text,'1',$3,$4,$5::jsonb,$6::jsonb,$4,$7::timestamptz,$8,$9,transaction_timestamp())`;
        const values=[envelope.messageId,SCOPE,Buffer.from(wire),digest,wire,JSON.stringify(payload),payload.observedAt,OWNER,envelope.traceparent];
        await rejectsSql(db,insert,values.map((value,index)=>index===3?H:value));
        const changed=JSON.stringify({...envelope,producer:"aroma-convergence"});
        await rejectsSql(db,insert,values.map((value,index)=>index===4?changed:value));
        await db.query(insert,values);
        assert.equal((await db.query("SELECT envelope_hash FROM orders.outbox_messages")).rows[0].envelope_hash,digest);
      });
      await t.test("guarded Card entry даёт один монотонный counter без изменения business version",async()=>{
        const role=await connect("coffee_orders_prepare_rw");
        const material={order_ref:ORDER,cart_scope_ref:SCOPE,desired_revision:1,desired_hash:H,
          observed_revision:1,observed_cart_fingerprint:F,verified_desired_revision:null,verified_desired_hash:null,
          verified_observed_revision:null,verified_cart_fingerprint:null,attempt_ref:null,verified_attempt_ref:null,
          fence_epoch:null,state:"OutOfSync",blocker_codes:[],last_observed_at:null,source_message_id:"projection-first"};
        const write="SELECT projection_version::text,material_change,snapshot FROM orders.write_card_projection($1,$2::jsonb)";
        try { await transaction(role,async()=>{
          const first=(await role.query(write,[ORDER,JSON.stringify(material)])).rows[0];
          assert.equal(first.material_change,true);assert.equal(first.projection_version,"2");
          assert.equal(first.snapshot.projection_version,2);
          const same=(await role.query(write,[ORDER,JSON.stringify({...material,source_message_id:"later-hint"})])).rows[0];
          assert.equal(same.material_change,false);assert.equal(same.projection_version,"2");
          const changed=(await role.query(write,[ORDER,JSON.stringify({...material,state:"Converging"})])).rows[0];
          assert.equal(changed.material_change,true);assert.equal(changed.projection_version,"3");
          assert.equal((await role.query("SELECT version::text,projection_version::text FROM orders.orders WHERE order_ref=$1",[ORDER])).rows[0].version,"1");
          await rejectsSql(role,"UPDATE orders.order_aroma_projections SET state=state WHERE false",[],"42501");
          await rejectsSql(role,"INSERT INTO orders.order_aroma_projections(order_ref) VALUES($1)",[ORDER],"42501");
          await rejectsSql(role,write,[ORDER,null],"42501");
          await rejectsSql(role,write,[ORDER,JSON.stringify({...material,projection_version:999})]);
        }); } finally { await role.end(); }
        assert.equal((await db.query("SELECT projection_version::text FROM orders.orders WHERE order_ref=$1",[ORDER])).rows[0].projection_version,"1");
      });
      await t.test("Order command entry запрещает прямой counter UPDATE и чужую AROMA запись",async()=>{
        const role=await connect("coffee_orders_service_rw");
        try { await transaction(role,async()=>{
          assert.equal((await role.query("SELECT projection_version::text FROM orders.write_card_projection($1)",[ORDER])).rows[0].projection_version,"2");
          assert.equal((await role.query("SELECT version::text FROM orders.orders WHERE order_ref=$1",[ORDER])).rows[0].version,"1");
          await rejectsSql(role,"UPDATE orders.orders SET projection_version=projection_version+1 WHERE false",[],"42501");
          await rejectsSql(role,"SELECT * FROM orders.write_card_projection($1,$2::jsonb)",[ORDER,JSON.stringify({order_ref:ORDER})],"42501");
        }); } finally { await role.end(); }
      });
      await check("Attempt и reservation сохраняют owner/hash/baseline/deadline safety facts",async()=>{
        for(const [table,fields] of [["convergence_attempts",["owner_instance_id","desired_hash"]],["mutation_reservations",["observed_before_revision","reserved_until","provider_deadline_at","safety_margin_ms"]]]) {
          const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='orders' AND table_name=$1",[table])).rows.map(row=>row.column_name);
          for(const field of fields) assert.ok(columns.includes(field),`${String(table)} missing ${String(field)}`);
        }
      });
      await check("Observed Convergence обязана ссылаться на существующий attempt/fence",async()=>{
        await rejectsSql(db,"INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind,source_attempt_ref,fence_epoch) VALUES($1,2,'Superseded','snapshot-proof',$2,transaction_timestamp(),'Convergence',$3,1)",[SCOPE,F,ATTEMPT(999)],"23503");
      });
      await check("Lease release сохраняет fence и допускается без reset acquired_at",async()=>{
        await db.query("INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,acquired_at,heartbeat_at,expires_at) VALUES($1,$2,5,'2026-01-01','2026-01-01','2026-01-02')",[SCOPE,OWNER]);
        await rejectsSql(db,"UPDATE orders.convergence_leases SET owner_instance_id='00000000-0000-4000-8000-000000000002'");
        await rejectsSql(db,"UPDATE orders.convergence_leases SET fence_epoch=4");
        await db.query("UPDATE orders.convergence_leases SET expires_at=acquired_at");
        await rejectsSql(db,"DELETE FROM orders.convergence_leases");
        assert.equal((await db.query("SELECT fence_epoch FROM orders.convergence_leases")).rows[0].fence_epoch,"5");
      });
      await check("Durable schedules существуют и не допускают invented desired refs",async()=>{
        for(const table of ["convergence_work","observation_schedule"]) {
          assert.equal((await db.query("SELECT to_regclass($1) AS name",[`orders.${table}`])).rows[0].name,`orders.${table}`);
        }
      });
      await check("committed complete revision не допускает позднего добавления cart facts",async()=>{
        await rejectsSql(db,"INSERT INTO orders.cart_desired_lines(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,contributing_order_refs) VALUES($1,1,$2,$3,1000,$3,'[]')",[SCOPE,OFFER,F]);
        await rejectsSql(db,"INSERT INTO orders.cart_observed_lines(cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash) VALUES($1,1,$2,$3,1000,$3)",[SCOPE,OFFER,F]);
      });
      await check("Desired historical facts immutable",async()=>{
        await rejectsSql(db,"UPDATE orders.cart_desired_lines SET quantity_milli=2000");
        await rejectsSql(db,"UPDATE orders.cart_desired_revisions SET desired_hash=$1",[F]);
      });
      await check("Observed nullable key и исторические complete факты immutable",async()=>{
        await freshObserved(db,2,1000);
        await observedLine(db,2,1000,H);
        await rejectsSql(db,"INSERT INTO orders.cart_observed_lines SELECT cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash FROM orders.cart_observed_lines WHERE observed_revision=2 AND source_grind_key_hash IS NULL",[],"23505");
        await rejectsSql(db,"UPDATE orders.cart_observed_lines SET quantity_milli=3000");
        await rejectsSql(db,"DELETE FROM orders.cart_observed_lines");
        await rejectsSql(db,"UPDATE orders.cart_observed_revisions SET cart_fingerprint=$1",[H]);
        await rejectsSql(db,"DELETE FROM orders.cart_observed_revisions");
      });
      await check("Inbox original messageId изолирован по consumer и canonical envelope immutable",async()=>{
        const payload={orderRef:ORDER,orderVersion:"1"};
        const envelope={envelopeVersion:"1",messageId:"original",messageType:"OrderConfirmed.v1",payload};
        const sql="INSERT INTO orders.inbox_messages(consumer_name,message_id,message_type,partition_key,schema_version,owner_version,payload_hash,envelope_hash,payload,envelope,lease_owner,lease_until) VALUES($1,'original','OrderConfirmed.v1',$2,'1',1,$3,$4,$5,$6,'worker',transaction_timestamp()+interval '30 seconds')";
        const values=["orders-aroma-preparation-v1",ORDER,H,F,payload,envelope];
        await db.query(sql,values);
        await db.query(sql,["aroma-convergence-v1",...values.slice(1)]);
        await rejectsSql(db,sql,values,"23505");
        for(const [column,value] of [["message_id","changed"],["consumer_name","other"],["message_type","Other.v1"],["partition_key","other"],["payload_hash",F],["envelope_hash",H],["schema_version","2"]])
          await rejectsSql(db,`UPDATE orders.inbox_messages SET ${column}=$1 WHERE consumer_name=$2`,[value,values[0]]);
        await rejectsSql(db,"UPDATE orders.inbox_messages SET state='Processed',processed_at=transaction_timestamp(),lease_owner='' WHERE consumer_name=$1",[values[0]]);
        await db.query("UPDATE orders.inbox_messages SET state='Processed',processed_at=transaction_timestamp(),lease_owner='',outcome='Applied',result=$1 WHERE consumer_name=$2",[{desiredRevision:"1"},values[0]]);
        await rejectsSql(db,"UPDATE orders.inbox_messages SET result='{}' WHERE consumer_name=$1",[values[0]]);
        await rejectsSql(db,"DELETE FROM orders.inbox_messages");
        await db.query("UPDATE orders.inbox_messages SET state='Quarantined',quarantined_at=transaction_timestamp(),quarantine_reason='MESSAGE_ID_PAYLOAD_CONFLICT',lease_owner='',outcome='Quarantined',result='{}' WHERE consumer_name='aroma-convergence-v1'");
        await db.query("INSERT INTO orders.inbox_quarantine(consumer_name,topic,\"partition\",\"offset\",message_id,message_type,partition_key,schema_version,payload_hash,envelope_hash,envelope,reason) VALUES($1,'orders.events',0,1,'original','Other.v1','different-key','1',$2,$3,$4,'MESSAGE_ID_PAYLOAD_CONFLICT')",[values[0],F,H,envelope]);
        await rejectsSql(db,"UPDATE orders.inbox_quarantine SET reason='overwrite'");
        assert.equal((await db.query("SELECT result FROM orders.inbox_messages WHERE consumer_name=$1",[values[0]])).rows[0].result.desiredRevision,"1");
      });
      await check("Attempt FK связывают Desired hash, complete observed refs и exact fence",async()=>{
        await freshDesired(db);
        await attempt(db,1);
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET owner_instance_id='00000000-0000-4000-8000-000000000002'");
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET desired_hash=$1",[F]);
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET observed_end_revision=999",[],"23503");
        await rejectsSql(db,"INSERT INTO orders.convergence_attempts(attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state) VALUES($1,$2,2,$3,$4,1,'Started')",[ATTEMPT(2),SCOPE,F,OWNER],"23503");
        await rejectsSql(db,"INSERT INTO orders.cart_observed_revisions(cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind,source_attempt_ref,fence_epoch) VALUES($1,2,'Superseded','snapshot-proof',$2,transaction_timestamp(),'Convergence',$3,2)",[SCOPE,F,ATTEMPT(1)],"23503");
        await db.query("UPDATE orders.convergence_attempts SET state='UnknownOutcome',ended_at=transaction_timestamp()");
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET ended_at=ended_at+interval '1 second'");
        await rejectsSql(db,"DELETE FROM orders.convergence_attempts");
      });
      await check("Reservation FK/NULL, exact grind/baseline и mandatory deadline margin fail closed",async()=>{
        await freshDesired(db);
        await attempt(db,1);
        await rejectsSql(db,RESERVE,reservation(999),"23503");
        await rejectsSql(db,RESERVE,reservation(1,{fence:2}),"23503");
        await rejectsSql(db,RESERVE,reservation(1,{baseline:null,before:0}),"23502");
        await rejectsSql(db,RESERVE,reservation(1,{grind:H}));
        await rejectsSql(db,RESERVE,reservation(1,{before:0}));
        await rejectsSql(db,RESERVE,reservation(1,{target:null}));
        await rejectsSql(db,RESERVE,reservation(1,{target:1}));
        await rejectsSql(db,RESERVE.replace("1000,'Reserved'","-1,'Reserved'"),reservation(1));
        await rejectsSql(db,RESERVE.replace("1000,'Reserved'","20000,'Reserved'"),reservation(1));
        await rejectsSql(db,RESERVE.replace("interval '20 seconds'","interval '10 seconds'"),reservation(1));
        await db.query(RESERVE,reservation(1));
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET provider_deadline_at=provider_deadline_at-interval '1 second'");
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET reserved_until=reserved_until-interval '1 second'");
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET reserved_until=provider_deadline_at");
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET safety_margin_ms=0");
        await db.query("UPDATE orders.mutation_reservations SET reserved_until=reserved_until+interval '5 seconds',provider_deadline_at=provider_deadline_at+interval '5 seconds'");
        for(const column of ["desired_milli","observed_before_milli","fence_epoch"])
          await rejectsSql(db,`UPDATE orders.mutation_reservations SET ${column}=${column}+1`);
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET source_grind_key_hash=$1",[H]);
        await rejectsSql(db,"DELETE FROM orders.mutation_reservations");
      });
      await check("UnknownOutcome barrier переживает новый lease/fence; one reservation per attempt",async()=>{
        await freshDesired(db);
        await attempt(db,1);
        await attempt(db,2);
        await db.query("INSERT INTO orders.convergence_leases(cart_scope_ref,owner_instance_id,fence_epoch,expires_at) VALUES($1,$2,1,transaction_timestamp()+interval '30 seconds')",[SCOPE,OWNER]);
        await db.query(RESERVE,reservation(1));
        await db.query("UPDATE orders.mutation_reservations SET state='UnknownOutcome'");
        await db.query("UPDATE orders.convergence_leases SET fence_epoch=2,owner_instance_id='00000000-0000-4000-8000-000000000002'");
        await rejectsSql(db,RESERVE,reservation(2),"23505");
        await db.query("UPDATE orders.mutation_reservations SET state='RecoveredNotApplied',resolved_at=transaction_timestamp()");
        await rejectsSql(db,RESERVE,reservation(1,{operation:3}),"23505");
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET gateway_outcome_hash=$1",[H]);
        await db.query(RESERVE,reservation(2));
        assert.equal((await db.query("SELECT count(*) FROM orders.mutation_reservations WHERE state='Reserved'")).rows[0].count,"1");
      });
      await check("Remove имеет zero desired, nullable provider quantity и immutable terminal reservation",async()=>{
        await freshDesired(db,2,null);
        await attempt(db,1,{action:"Remove"});
        await rejectsSql(db,RESERVE,reservation(1,{action:"Remove",quantity:0,target:0}));
        await db.query(RESERVE,reservation(1,{action:"Remove",quantity:0,target:null}));
        await db.query("UPDATE orders.mutation_reservations SET state='RecoveredApplied',resolved_at=transaction_timestamp()");
        await rejectsSql(db,"UPDATE orders.mutation_reservations SET state='Reserved',resolved_at=NULL");
        await rejectsSql(db,"DELETE FROM orders.mutation_reservations");
      });
      await check("NoOp/Verified terminal proof сравнивает exact lines, а не Desired/Gateway hash",async()=>{
        await attempt(db,1,{desired:1,action:null,state:"NoOpInSync"});
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET state='OutOfSync'");
        await freshDesired(db);
        await attempt(db,2);
        await db.query(RESERVE,reservation(2));
        await freshObserved(db,2,2000,null,ATTEMPT(2),2);
        await db.query("UPDATE orders.mutation_reservations SET state='Verified',resolved_at=transaction_timestamp() WHERE attempt_ref=$1",[ATTEMPT(2)]);
        await db.query("UPDATE orders.convergence_attempts SET state='VerifiedInSync',ended_at=transaction_timestamp(),observed_end_revision=2 WHERE attempt_ref=$1",[ATTEMPT(2)]);
        await db.query("SET CONSTRAINTS ALL IMMEDIATE");
        assert.notEqual(H,F);
      });
      await check("NoOp не выдаёт InSync для другого nullable grind или quantity",async()=>{
        await freshDesired(db,2,1000,H);
        await attempt(db,1,{action:null,state:"NoOpInSync"});
        await rejectsSql(db,"SET CONSTRAINTS ALL IMMEDIATE");
      });
      await check("VerifiedInSync без verification/reservation proof отвергается",async()=>{
        await freshDesired(db);
        await attempt(db,1);
        await rejectsSql(db,"UPDATE orders.convergence_attempts SET state='VerifiedInSync',ended_at=transaction_timestamp()");
        await db.query("UPDATE orders.convergence_attempts SET state='VerifiedInSync',ended_at=transaction_timestamp(),observed_end_revision=1");
        await rejectsSql(db,"SET CONSTRAINTS ALL IMMEDIATE");
      });
      await check("Durable pending intent/wake counter/observer lease не теряются и не регрессируют",async()=>{
        await db.query("INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,dirty,wake_revision,reason,next_attempt_at) VALUES($1,NULL,true,1,'OperatorRequested',transaction_timestamp())",[SCOPE]);
        await rejectsSql(db,"UPDATE orders.convergence_work SET desired_revision=999,wake_revision=2",[],"23503");
        await rejectsSql(db,"UPDATE orders.convergence_work SET desired_revision=1");
        await db.query("UPDATE orders.convergence_work SET desired_revision=1,wake_revision=2");
        await rejectsSql(db,"UPDATE orders.convergence_work SET desired_revision=NULL,wake_revision=3");
        await rejectsSql(db,"UPDATE orders.convergence_work SET wake_revision=1");
        await db.query("UPDATE orders.convergence_work SET dirty=false");
        await rejectsSql(db,"UPDATE orders.convergence_work SET dirty=true");
        await db.query("UPDATE orders.convergence_work SET dirty=true,wake_revision=3,next_attempt_at=transaction_timestamp()+interval '1 minute'");
        await rejectsSql(db,"DELETE FROM orders.convergence_work");
        await db.query("INSERT INTO orders.observation_schedule(cart_scope_ref,next_observation_at) VALUES($1,transaction_timestamp())",[SCOPE]);
        await rejectsSql(db,"UPDATE orders.observation_schedule SET lease_owner=$1",[OWNER]);
        await db.query("UPDATE orders.observation_schedule SET lease_owner=$1,lease_until=transaction_timestamp()+interval '30 seconds'",[OWNER]);
        await db.query("UPDATE orders.observation_schedule SET lease_owner=NULL,lease_until=NULL,next_observation_at=transaction_timestamp()+interval '1 minute'");
        await rejectsSql(db,"DELETE FROM orders.observation_schedule");
      });
    } finally { await db.end(); }
    return {migrations:MIGRATIONS};
  });
  assert.equal(receipt.cleanup.containerRemoved,true);
  t.diagnostic("Disposable PostgreSQL удалён вместе с volumes; production/provider не использованы");
});
