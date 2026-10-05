import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {createDatabase} from "../../packages/platform-database/dist/index.js";
import {withCatalogPostgres} from "../../scripts/catalog-live-harness.mjs";

const pool = {max:4, checkoutTimeoutMs:2_000, lockTimeoutMs:1_000, interactiveStatementTimeoutMs:5_000, backgroundStatementTimeoutMs:10_000, terminalTimeoutMs:3_000, transactionTimeoutMs:20_000, idleTimeoutMs:30_000, maxLifetimeMs:1_800_000};
const ref = (prefix, n = 1) => `${prefix}_${String(n).padStart(26,"0")}`;
const identity = () => ({actorRef:"pricing-test",scope:"a".repeat(64),key:randomUUID()});

void test("PricingStore exists with owner-local persistence methods", async () => {
  const {PricingStore} = await import("../../apps/pricing-service/dist/infrastructure/database/pricing-store.js");
  for (const name of ["readActivePolicy", "precheck", "create", "verify"]) assert.equal(typeof PricingStore.prototype[name], "function");
});

void test("create prepares bounded money facts before opening its owner transaction",async () => {
  const source = await readFile(new URL("../../apps/pricing-service/src/infrastructure/database/pricing-store.ts",import.meta.url),"utf8");
  const create = source.slice(source.indexOf("  public async create("),source.indexOf("  /** Only the authenticated"));
  const transaction = create.indexOf("const persist = () => withTransaction<");
  assert.ok(transaction > 0);
  assert.match(create.slice(0,transaction),/calculatePricingLine\(/u);
  assert.match(create.slice(0,transaction),/sumLineTotals\(/u);
  assert.doesNotMatch(create.slice(transaction),/calculatePricingLine\(|sumLineTotals\(|parseQuantity\(/u);
  assert.match(create.slice(0,transaction),/input\.lines\.length > 100/u);
  assert.doesNotMatch(source,/\bfetch\(|from ["'](?:node:https?|undici)["']/u);
});

void test("PostgreSQL PricingStore atomic create, replay, conflict and private verification", {
  timeout:180_000, skip:process.env.COFFEE_DB_LIVE_PROOF !== "1" ? "disposable PostgreSQL required" : false,
}, async () => {
  const {PricingStore} = await import("../../apps/pricing-service/dist/infrastructure/database/pricing-store.js");
  // Reuse the repository's disposable PostgreSQL lifecycle; no production database is touched.
  await withCatalogPostgres(async ({adminClient:admin,port,databaseName}) => {
    await admin.query("CREATE ROLE coffee_pricing_rw LOGIN PASSWORD 'pricing-proof'");
    for (const migration of ["0001_create_pricing_policy_versions", "0002_create_pricing_quotes", "0003_create_pricing_idempotency", "0004_create_pricing_audit", "0005_quote_grind_selection"])
      await admin.query(await readFile(new URL(`../../apps/pricing-service/migrations/${migration}.sql`, import.meta.url), "utf8"));
    const database = createDatabase({owner:"pricing-service",database:databaseName,allowedDatabase:databaseName,host:"127.0.0.1",port,user:"coffee_pricing_rw",password:"pricing-proof",ssl:false,pool,shutdownGraceMs:40_000});
    const store = new PricingStore(database);
    try {
      const policy = await store.readActivePolicy();
      await assert.rejects(admin.query(`INSERT INTO pricing.pricing_policy_versions
        (policy_version_ref,version,currency,markup_basis_points,minimum_margin_minor,quote_ttl_seconds,quantity_scale,rounding_mode,status,valid_from,created_by_actor_ref)
        VALUES($1,2,'RUB',3000,0,900,3,'CEILING','Active',transaction_timestamp(),'pricing-test')`,[ref("pvr",2)]),{code:"23505"});
      // Drop and restore the DB constraint around deliberate persisted-row corruption.
      await admin.query("ALTER TABLE pricing.pricing_policy_versions DROP CONSTRAINT pricing_policy_versions_markup_basis_points_check");
      await admin.query("UPDATE pricing.pricing_policy_versions SET markup_basis_points=100001 WHERE policy_version_ref=$1",[policy.policyVersionRef]);
      await assert.rejects(store.readActivePolicy(),{code:"PRICING_DATABASE_DECODE_ERROR"});
      await admin.query("UPDATE pricing.pricing_policy_versions SET markup_basis_points=3000 WHERE policy_version_ref=$1",[policy.policyVersionRef]);
      await admin.query("ALTER TABLE pricing.pricing_policy_versions ADD CONSTRAINT pricing_policy_versions_markup_basis_points_check CHECK (markup_basis_points BETWEEN 0 AND 100000)");
      const id = identity();
      const input = {identity:id,requestHash:"b".repeat(64),correlationId:randomUUID(),policy,customerRef:ref("cus"),catalogSnapshotRevision:"1",lines:[{productRef:ref("prd"),variantRef:ref("var"),productDisplayName:"Кофе",quantity:"2.5",unit:"piece",offerRef:ref("off"),mappingRevision:"1",supplierUnitMinor:"100",catalogSnapshotRevision:"1"},{productRef:ref("prd",2),variantRef:ref("var",2),productDisplayName:"Чай",quantity:"2",unit:"piece",offerRef:ref("off",2),mappingRevision:"1",supplierUnitMinor:"100",catalogSnapshotRevision:"1"}]};
      assert.equal((await store.precheck(id,input.requestHash)).kind,"not_retained");
      const line = input.lines[0];
      let preparedOutsideTransaction = false;
      const observedLine = {...line,get supplierUnitMinor() { assert.equal(database.metrics().active,0); preparedOutsideTransaction = true; return line.supplierUnitMinor; }};
      const created = await store.create({...input,lines:[observedLine,input.lines[1]]});
      assert.equal(preparedOutsideTransaction,true);
      assert.equal(created.status,201);
      assert.equal(created.replayed,false);
      assert.equal(created.body.totalMinor,"585");
      assert.equal(created.body.lines[0].unitMinor,"130");
      assert.equal("supplierUnitMinor" in created.body.lines[0],false);
      for (const statement of [
        "UPDATE pricing.pricing_quotes SET total_minor=0 WHERE quote_ref=$1",
        "DELETE FROM pricing.pricing_quotes WHERE quote_ref=$1",
        "UPDATE pricing.pricing_quote_lines SET product_display_name='changed' WHERE quote_ref=$1",
        "DELETE FROM pricing.pricing_quote_lines WHERE quote_ref=$1",
      ]) {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE coffee_pricing_rw");
          await assert.rejects(admin.query(statement,[created.body.quoteRef]),{code:"42501"});
        } finally {await admin.query("ROLLBACK");}
      }
      assert.deepEqual(await store.create(input),{...created,replayed:true});
      assert.deepEqual((await store.precheck(id,input.requestHash)).body,created.body);
      assert.equal((await store.precheck(id,"c".repeat(64))).kind,"conflict");
      await assert.rejects(store.create({...input,requestHash:"c".repeat(64)}),{code:"IDEMPOTENCY_CONFLICT"});
      const request = {quoteRef:created.body.quoteRef,hash:created.body.hash,customerRef:input.customerRef,quoteLineNumber:2,productRef:input.lines[1].productRef,variantRef:input.lines[1].variantRef,quantity:input.lines[1].quantity};
      const verification = await store.verify({request,actorRef:"orders-service",correlationId:randomUUID()});
      assert.equal(verification.valid,true);
      assert.equal(verification.line.lineNumber,2);
      assert.equal(verification.line.supplierUnitMinor,"100");
      assert.match(verification.line.internalProofHash,/^[0-9a-f]{64}$/u);
      await assert.rejects(store.verify({request:{...request,hash:"f".repeat(64)},actorRef:"orders-service",correlationId:randomUUID()}),{code:"PRICING_QUOTE_HASH_MISMATCH"});
      assert.equal((await admin.query("SELECT count(*)::int n FROM pricing.pricing_quotes")).rows[0].n,1);
      assert.equal((await admin.query("SELECT count(*)::int n FROM pricing.pricing_audit_records WHERE action='QuoteRejected'")).rows[0].n,1);
      const counts = async () => (await admin.query(`SELECT
        (SELECT count(*)::int FROM pricing.pricing_quotes) quotes,
        (SELECT count(*)::int FROM pricing.pricing_quote_lines) lines,
        (SELECT count(*)::int FROM pricing.pricing_audit_records) audits,
        (SELECT count(*)::int FROM pricing.pricing_idempotency_records) commands`)).rows[0];
      // Fail at the last write, after quote, lines and audit were inserted.
      await admin.query(`CREATE FUNCTION pricing.fail_complete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$;
        CREATE TRIGGER fail_complete BEFORE UPDATE ON pricing.pricing_idempotency_records FOR EACH ROW EXECUTE FUNCTION pricing.fail_complete()`);
      const before = await counts(), failedIdentity = identity();
      await assert.rejects(store.create({...input,identity:failedIdentity}));
      assert.deepEqual(await counts(),before);
      assert.equal((await store.precheck(failedIdentity,input.requestHash)).kind,"not_retained");
      await admin.query("DROP TRIGGER fail_complete ON pricing.pricing_idempotency_records; DROP FUNCTION pricing.fail_complete()");
      await assert.rejects(store.create({...input,identity:identity(),policy:{...policy,version:"2"}}),{code:"PRICING_POLICY_UNAVAILABLE"});
      assert.deepEqual(await counts(),before);
      const stuck = identity();
      await admin.query(`INSERT INTO pricing.pricing_idempotency_records
        (actor_ref,scope,idempotency_key,request_hash,state,lease_owner,lease_until,created_at,expires_at)
        VALUES($1,$2,$3,$4,'Acquired',$5,now()-interval '2 days',now()-interval '3 days',now()-interval '1 day')`,
        [stuck.actorRef,stuck.scope,stuck.key,input.requestHash,randomUUID()]);
      assert.equal((await store.precheck(stuck,input.requestHash)).kind,"in_progress");
      assert.equal((await store.precheck(stuck,"d".repeat(64))).kind,"conflict");
      await assert.rejects(store.create({...input,identity:stuck}),{code:"IDEMPOTENCY_REQUEST_IN_PROGRESS"});
      assert.equal((await admin.query("SELECT count(*)::int n FROM pricing.pricing_quotes")).rows[0].n,1);
      const check = request => store.verify({request,actorRef:"orders-service",correlationId:randomUUID()});
      await assert.rejects(check({...request,customerRef:ref("cus",2)}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(check({...request,quoteLineNumber:1}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(check({...request,quantity:"2.500"}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(check({...request,productRef:input.lines[0].productRef}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(check({...request,variantRef:input.lines[0].variantRef}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(check({...request,quoteRef:ref("prq",99)}),{code:"PRICING_QUOTE_NOT_FOUND"});
      await admin.query("ALTER TABLE pricing.pricing_quotes DROP CONSTRAINT pricing_quotes_currency_check");
      await admin.query("UPDATE pricing.pricing_quotes SET currency='USD' WHERE quote_ref=$1",[request.quoteRef]);
      await assert.rejects(check(request),{code:"PRICING_DATABASE_DECODE_ERROR"});
      await admin.query("UPDATE pricing.pricing_quotes SET currency='RUB' WHERE quote_ref=$1",[request.quoteRef]);
      await admin.query("ALTER TABLE pricing.pricing_quotes ADD CONSTRAINT pricing_quotes_currency_check CHECK (currency = 'RUB')");
      await admin.query("ALTER TABLE pricing.pricing_quote_lines DROP CONSTRAINT pricing_quote_lines_currency_check");
      await admin.query("UPDATE pricing.pricing_quote_lines SET currency='USD' WHERE quote_ref=$1",[request.quoteRef]);
      await assert.rejects(check(request),{code:"PRICING_DATABASE_DECODE_ERROR"});
      await admin.query("UPDATE pricing.pricing_quote_lines SET currency='RUB' WHERE quote_ref=$1",[request.quoteRef]);
      await admin.query("ALTER TABLE pricing.pricing_quote_lines ADD CONSTRAINT pricing_quote_lines_currency_check CHECK (currency = 'RUB')");
      // Persisted private corruption is rejected even while the public hash remains intact.
      const originalProof = (await admin.query("SELECT internal_proof_hash FROM pricing.pricing_quotes WHERE quote_ref=$1",[request.quoteRef])).rows[0].internal_proof_hash;
      await admin.query("UPDATE pricing.pricing_quotes SET internal_proof_hash=$2 WHERE quote_ref=$1",[request.quoteRef,"0".repeat(64)]);
      await assert.rejects(check(request),error => error.code === "PRICING_QUOTE_HASH_MISMATCH" && !error.message.includes(originalProof));
      await admin.query("UPDATE pricing.pricing_quotes SET internal_proof_hash=$2 WHERE quote_ref=$1",[request.quoteRef,originalProof]);
      await admin.query("UPDATE pricing.pricing_quotes SET canonical_hash=$2 WHERE quote_ref=$1",[request.quoteRef,"0".repeat(64)]);
      await assert.rejects(check({...request,hash:"0".repeat(64)}),{code:"PRICING_QUOTE_HASH_MISMATCH"});
      await admin.query("UPDATE pricing.pricing_quotes SET canonical_hash=$2 WHERE quote_ref=$1",[request.quoteRef,created.body.hash]);
      await admin.query("UPDATE pricing.pricing_quote_lines SET product_display_name='tampered' WHERE quote_ref=$1 AND line_number=1",[request.quoteRef]);
      await assert.rejects(check(request),{code:"PRICING_QUOTE_HASH_MISMATCH"});
      await admin.query("UPDATE pricing.pricing_quote_lines SET product_display_name='Кофе' WHERE quote_ref=$1 AND line_number=1",[request.quoteRef]);
      // Replay's closed decoder must not expose extra private JSONB keys, or accept a non-201 result.
      await admin.query("UPDATE pricing.pricing_idempotency_records SET response_body=response_body || '{\"supplierUnitMinor\":\"SECRET-CANARY\"}'::jsonb WHERE idempotency_key=$1",[id.key]);
      await assert.rejects(store.precheck(id,input.requestHash),error => error.code === "IDEMPOTENCY_RESULT_INVALID" && !error.message.includes("SECRET-CANARY"));
      await assert.rejects(admin.query("UPDATE pricing.pricing_idempotency_records SET response_status=200 WHERE idempotency_key=$1",[id.key]),{code:"23514"});
      await admin.query("UPDATE pricing.pricing_idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1",[id.key,JSON.stringify(created.body)]);
      // Age a fixture and recompute both hashes; expiry is then the only failed invariant.
      const {hashPublicQuote,hashInternalQuote} = await import("../../apps/pricing-service/dist/domain/quote-proof.js");
      const aged = {...created.body,createdAt:new Date(Date.parse(created.body.createdAt)-3_600_000).toISOString(),expiresAt:new Date(Date.parse(created.body.expiresAt)-3_600_000).toISOString()};
      aged.hash = hashPublicQuote(aged);
      const agedProof = hashInternalQuote(aged,policy,input.lines.map((item,index)=>({lineNumber:index+1,offerRef:item.offerRef,mappingRevision:item.mappingRevision,supplierUnitMinor:item.supplierUnitMinor,catalogSnapshotRevision:item.catalogSnapshotRevision,markupBasisPoints:String(policy.markupBasisPoints),minimumMarginMinor:policy.minimumMarginMinor})));
      await admin.query("UPDATE pricing.pricing_quotes SET created_at=$2,expires_at=$3,canonical_hash=$4,internal_proof_hash=$5 WHERE quote_ref=$1",[request.quoteRef,aged.createdAt,aged.expiresAt,aged.hash,agedProof]);
      await assert.rejects(check({...request,hash:aged.hash}),{code:"PRICING_QUOTE_EXPIRED"});
      // Replay is the original persisted 201, never a reprice or a validity check.
      assert.deepEqual((await store.precheck(id,input.requestHash)).body,created.body);
      await admin.query("UPDATE pricing.pricing_idempotency_records SET created_at=now()-interval '3 days',lease_until=now()-interval '2 days',expires_at=now()-interval '1 day',completed_at=now()-interval '2 days' WHERE idempotency_key=$1",[id.key]);
      assert.equal((await store.precheck(id,input.requestHash)).kind,"not_retained");
      assert.equal((await admin.query("SELECT count(*)::int n FROM pricing.pricing_quotes")).rows[0].n,1);
      const selected = {sourceGrindKeyHash:"a".repeat(64),grindDisplayName:"Средний помол"};
      const grindLine = {...input.lines[0], ...selected};
      const mixed = await store.create({...input,identity:identity(),requestHash:"f".repeat(64),lines:[input.lines[0],grindLine]});
      assert.equal(mixed.body.lines.length,2,"the same product/variant with a distinct grind is a distinct quote line");
      assert.equal(mixed.body.lines[1].grindDisplayName,selected.grindDisplayName);
      const selectedRequest={quoteRef:mixed.body.quoteRef,hash:mixed.body.hash,customerRef:input.customerRef,quoteLineNumber:2,productRef:grindLine.productRef,variantRef:grindLine.variantRef,quantity:grindLine.quantity,sourceGrindKeyHash:selected.sourceGrindKeyHash};
      assert.equal((await store.verify({request:selectedRequest,actorRef:"orders-service",correlationId:randomUUID()})).line.sourceGrindKeyHash,selected.sourceGrindKeyHash);
      await assert.rejects(store.verify({request:{...selectedRequest,sourceGrindKeyHash:undefined},actorRef:"orders-service",correlationId:randomUUID()}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
      await assert.rejects(store.verify({request:{...selectedRequest,quoteLineNumber:1},actorRef:"orders-service",correlationId:randomUUID()}),{code:"PRICING_QUOTE_SCOPE_MISMATCH"});
    } finally {await database.resource.stop(AbortSignal.timeout(5_000));}
  });
});
