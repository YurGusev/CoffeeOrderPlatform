import {randomBytes, randomUUID} from "node:crypto";
import {Ajv2020} from "ajv/dist/2020.js";
import type {AnySchema, ValidateFunction} from "ajv";
import {Temporal} from "@js-temporal/polyfill";
import {withTransaction, type Database, type Transaction, type SqlScalar} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {createSqlIdempotencyStore, type IdempotencyKey, type IdempotencyResponse} from "@coffee-platform/idempotency";
import type {PricingQuoteResponse, PricingQuoteVerifyRequest, PricingQuoteVerificationResponse} from "@coffee-platform/contracts-pricing-v1";
import {isPricingQuoteResponse, isPricingQuoteVerificationResponse} from "@coffee-platform/contracts-pricing-v1";
import {calculatePricingLine, parseQuantity, parseCanonicalMinor, encodeMinor, sumLineTotals} from "../../domain/pricing-formula.js";
import {hashPublicQuote, hashInternalQuote, type PricingProofLine} from "../../domain/quote-proof.js";
import type {PricingTelemetry} from "../../observability.js";

type Row = Readonly<Record<string, unknown>>;
const rowAjv = new Ajv2020({allErrors:true,strict:true});
rowAjv.addFormat("uuid", {type:"string",validate:(value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)});
const databaseDecodeError = () => new PricingStoreError("PRICING_DATABASE_DECODE_ERROR");
function rowValidator(schema: AnySchema): ValidateFunction {return rowAjv.compile(schema);}
function decodeRow(row: Row, validate: ValidateFunction): Row {
  if (!validate(row)) throw databaseDecodeError();
  return row;
}
const refPattern = "[0-9A-HJKMNP-TV-Z]{26}";
const hashPattern = "^[0-9a-f]{64}$";
const policyRowSchema: AnySchema = {type:"object",additionalProperties:false,required:["policy_version_ref","version","currency","markup_basis_points","minimum_margin_minor","quote_ttl_seconds","quantity_scale","rounding_mode"],properties:{policy_version_ref:{type:"string",pattern:`^pvr_${refPattern}$`},version:{type:"string",pattern:"^[1-9][0-9]*$"},currency:{const:"RUB"},markup_basis_points:{type:"integer",minimum:0,maximum:100000},minimum_margin_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},quote_ttl_seconds:{type:"integer",minimum:60,maximum:3600},quantity_scale:{const:3},rounding_mode:{const:"CEILING"}}};
const clockRowSchema: AnySchema = {type:"object",additionalProperties:false,required:["created_at","expires_at","now_ms"],properties:{created_at:{type:"object"},expires_at:{type:"object"},now_ms:{type:"string",pattern:"^(0|[1-9][0-9]*)$"}}};
const quoteRowSchema: AnySchema = {type:"object",additionalProperties:false,required:["quote_ref","customer_ref","policy_version_ref","catalog_snapshot_revision","currency","total_minor","canonical_hash","internal_proof_hash","created_at","expires_at","actor_ref","correlation_id","request_hash","quote_ttl_seconds","quantity_scale","rounding_mode","unexpired"],properties:{quote_ref:{type:"string",pattern:`^prq_${refPattern}$`},customer_ref:{type:"string",pattern:`^cus_${refPattern}$`},policy_version_ref:{type:"string",pattern:`^pvr_${refPattern}$`},catalog_snapshot_revision:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},currency:{const:"RUB"},total_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},canonical_hash:{type:"string",pattern:hashPattern},internal_proof_hash:{type:"string",pattern:hashPattern},created_at:{type:"object"},expires_at:{type:"object"},actor_ref:{type:"string",minLength:1},correlation_id:{type:"string",format:"uuid"},request_hash:{type:"string",pattern:hashPattern},quote_ttl_seconds:{type:"integer",minimum:60,maximum:3600},quantity_scale:{const:3},rounding_mode:{const:"CEILING"},unexpired:{type:"boolean"}}};
const lineRowSchema: AnySchema = {type:"object",additionalProperties:false,required:["quote_ref","line_number","product_ref","variant_ref","product_display_name","offer_ref","catalog_snapshot_revision","mapping_revision","unit","quantity_milli","supplier_unit_minor","markup_basis_points","minimum_margin_minor","unit_minor","line_total_minor","currency"],properties:{quote_ref:{type:"string",pattern:`^prq_${refPattern}$`},line_number:{type:"integer",minimum:1,maximum:100},product_ref:{type:"string",pattern:`^prd_${refPattern}`},variant_ref:{type:"string",pattern:`^var_${refPattern}`},product_display_name:{type:"string",minLength:1},offer_ref:{type:"string",pattern:`^off_${refPattern}`},catalog_snapshot_revision:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},mapping_revision:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},unit:{enum:["piece","gram","kilogram"]},quantity_milli:{type:"string",pattern:"^[1-9][0-9]*$"},supplier_unit_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},markup_basis_points:{type:"integer",minimum:0,maximum:100000},minimum_margin_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},unit_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},line_total_minor:{type:"string",pattern:"^(0|[1-9][0-9]*)$"},currency:{const:"RUB"}}};
const idempotencyRecordSchema: AnySchema = {type:"object",additionalProperties:false,required:["identity","requestHash","state","leaseOwner","leaseUntilMs","expiresAtMs"],properties:{identity:{type:"object",additionalProperties:false,required:["actorRef","scope","key"],properties:{actorRef:{type:"string",minLength:1},scope:{type:"string",pattern:hashPattern},key:{type:"string",format:"uuid"}}},requestHash:{type:"string",pattern:hashPattern},state:{enum:["Acquired","Completed"]},leaseOwner:{type:"string",format:"uuid"},leaseUntilMs:{type:"integer"},expiresAtMs:{type:"integer"},response:{type:"object",additionalProperties:false,required:["status","body"],properties:{status:{type:"integer",minimum:100,maximum:599},body:true,resourceRef:{type:"string",minLength:1}}}}};
const idempotencyResponseSchema: AnySchema = {type:"object",additionalProperties:false,required:["status","body"],properties:{status:{type:"integer",minimum:100,maximum:599},body:true,resourceRef:{type:"string",minLength:1}}};
const validatePolicyRow = rowValidator(policyRowSchema), validateClockRow = rowValidator(clockRowSchema), validateQuoteRow = rowValidator(quoteRowSchema), validateLineRow = rowValidator(lineRowSchema), validateIdempotencyRecord = rowValidator(idempotencyRecordSchema), validateIdempotencyResponse = rowValidator(idempotencyResponseSchema);
export type PricingPolicy = Readonly<{
  policyVersionRef: string; version: string; currency: "RUB"; markupBasisPoints: number;
  minimumMarginMinor: string; quoteTtlSeconds: number; quantityScale: 3; roundingMode: "CEILING";
}>;
export type PricingStoreLine = Readonly<{
  productRef: string; variantRef: string; productDisplayName: string; quantity: string;
  unit: "piece" | "gram" | "kilogram"; offerRef: string; mappingRevision: string;
  supplierUnitMinor: string; catalogSnapshotRevision: string;
}>;
export type PricingCreateInput = Readonly<{
  identity: IdempotencyKey; requestHash: string; correlationId: string; policy: PricingPolicy;
  customerRef: string; catalogSnapshotRevision: string; lines: readonly PricingStoreLine[]; signal?: AbortSignal;
}>;
export type PricingCreateResult = Readonly<{status: 201; body: PricingQuoteResponse; replayed: boolean}>;
export type PricingPrecheckResult =
  | (PricingCreateResult & Readonly<{kind: "completed"}>)
  | Readonly<{kind: "conflict" | "in_progress" | "not_retained"}>;
export type PricingVerifyInput = Readonly<{
  request: PricingQuoteVerifyRequest; actorRef: string; correlationId: string; signal?: AbortSignal;
}>;
export class PricingStoreError extends Error {
  public readonly code: string;
  public constructor(code: string) {super(code); this.name = "PricingStoreError"; this.code = code;}
}
function invalid(): never {throw new PricingStoreError("PRICING_PERSISTED_FACTS_INVALID");}
function text(value: unknown): string {if (typeof value !== "string" || value.length === 0) return invalid(); return value;}
function ref(value: unknown, prefix: string): string {
  const result = text(value);
  if (!new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u").test(result)) return invalid();
  return result;
}
function minor(value: unknown): string {
  const result = text(value);
  try {parseCanonicalMinor(result);} catch {return invalid();}
  return result;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid();
  return value;
}
function hash(value: unknown): string {const result = text(value); if (!/^[0-9a-f]{64}$/u.test(result)) return invalid(); return result;}
function timestamp(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invalid();
  return value.toISOString();
}
function instantMs(value: string): number {
  try {return Temporal.Instant.from(value).epochMilliseconds;}
  catch {return invalid();}
}
function newRef(prefix: string, time: string): string {
  let bits = (BigInt(instantMs(time)) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let result = "";
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (let i = 0; i < 26; i++) {result = alphabet[Number(bits & 31n)] + result; bits >>= 5n;}
  return `${prefix}_${result}`;
}
function policyFromRow(row: Row | undefined): PricingPolicy {
  if (row === undefined) throw new PricingStoreError("PRICING_POLICY_UNAVAILABLE");
  decodeRow(row,validatePolicyRow);
  if (row["currency"] !== "RUB" || row["rounding_mode"] !== "CEILING" || row["quantity_scale"] !== 3) return invalid();
  const version = minor(row["version"]); if (version === "0") return invalid();
  return {policyVersionRef:ref(row["policy_version_ref"],"pvr"),version,currency:"RUB",markupBasisPoints:integer(row["markup_basis_points"],0,100_000),minimumMarginMinor:minor(row["minimum_margin_minor"]),quoteTtlSeconds:integer(row["quote_ttl_seconds"],60,3600),quantityScale:3,roundingMode:"CEILING"};
}
function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Row;
}
function exactKeys(value: Row, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !(name in value))) invalid();
}
// Closed response decoder prevents replaying private/extra fields from a corrupt JSONB record.
function publicResponse(value: unknown): PricingQuoteResponse {
  if (!isPricingQuoteResponse(value)) return invalid();
  const row = object(value);
  exactKeys(row,["quoteRef","policyVersionRef","catalogSnapshotRevision","customerRef","createdAt","expiresAt","currency","lines","totalMinor","hash"]);
  const createdAt = text(row["createdAt"]), expiresAt = text(row["expiresAt"]);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(createdAt) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(expiresAt) || instantMs(expiresAt) <= instantMs(createdAt) || row["currency"] !== "RUB" || !Array.isArray(row["lines"]) || row["lines"].length < 1 || row["lines"].length > 100) return invalid();
  const pairs = new Set<string>();
  const lines = row["lines"].map((value: unknown, index: number) => {
    const line = object(value);
    exactKeys(line,["lineNumber","productRef","variantRef","productDisplayName","quantity","unit","unitMinor","lineTotalMinor"]);
    const quantity = text(line["quantity"]);
    try {if (parseQuantity(quantity).quantity !== quantity) return invalid();} catch {return invalid();}
    if (line["lineNumber"] !== index + 1 || !["piece","gram","kilogram"].includes(text(line["unit"]))) return invalid();
    const productRef = ref(line["productRef"],"prd"), variantRef = ref(line["variantRef"],"var");
    const key = `${productRef}/${variantRef}`; if (pairs.has(key)) return invalid(); pairs.add(key);
    return {lineNumber:index + 1,productRef,variantRef,productDisplayName:text(line["productDisplayName"]),quantity,unit:line["unit"] as PricingStoreLine["unit"],unitMinor:minor(line["unitMinor"]),lineTotalMinor:minor(line["lineTotalMinor"])};
  });
  const response: PricingQuoteResponse = {quoteRef:ref(row["quoteRef"],"prq"),policyVersionRef:ref(row["policyVersionRef"],"pvr"),catalogSnapshotRevision:minor(row["catalogSnapshotRevision"]),customerRef:ref(row["customerRef"],"cus"),createdAt,expiresAt,currency:"RUB",lines,totalMinor:minor(row["totalMinor"]),hash:hash(row["hash"])};
  if (encodeMinor(sumLineTotals(lines.map(line => ({lineTotalMinor:BigInt(line["lineTotalMinor"])})))) !== response.totalMinor || hashPublicQuote(response) !== response.hash) return invalid();
  return response;
}
function replay(response: IdempotencyResponse): PricingCreateResult {
  try {
    if (response.status !== 201) return invalid();
    const body = publicResponse(response.body);
    if (response.resourceRef !== body.quoteRef) return invalid();
    return {status:201,body,replayed:true};
  } catch {throw new PricingStoreError("IDEMPOTENCY_RESULT_INVALID");}
}
const POLICY_COLUMNS = "policy_version_ref, version::text, currency, markup_basis_points, minimum_margin_minor::text, quote_ttl_seconds, quantity_scale, rounding_mode";

export class PricingStore {
  private readonly database: Database;
  private readonly telemetry: PricingTelemetry | undefined;
  private readonly idempotency;
  private readonly activePolicy;
  private readonly clock;
  private readonly insertQuote;
  private readonly insertLine;
  private readonly insertAudit;
  private readonly selectQuote;
  private readonly selectLines;
  public constructor(database: Database, telemetry?: PricingTelemetry) {
    this.database = database;
    this.telemetry = telemetry;
    this.idempotency = createSqlIdempotencyStore(database,{schema:"pricing",table:"pricing_idempotency_records"});
    this.activePolicy = defineStatement<Row,[]>(database,`SELECT ${POLICY_COLUMNS} FROM pricing.pricing_policy_versions WHERE currency='RUB' AND status='Active' AND valid_from <= transaction_timestamp() AND (valid_to IS NULL OR valid_to > transaction_timestamp())`);
    this.clock = defineStatement<Row,[number]>(database,"SELECT date_trunc('milliseconds',transaction_timestamp()) AS created_at, date_trunc('milliseconds',transaction_timestamp()) + $1 * interval '1 second' AS expires_at, floor(extract(epoch FROM transaction_timestamp()) * 1000)::text AS now_ms");
    this.insertQuote = defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO pricing.pricing_quotes (quote_ref,customer_ref,policy_version_ref,catalog_snapshot_revision,currency,total_minor,canonical_hash,internal_proof_hash,created_at,expires_at,actor_ref,correlation_id,request_hash) VALUES ($1,$2,$3,$4,'RUB',$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11::uuid,$12)`);
    this.insertLine = defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO pricing.pricing_quote_lines (quote_ref,line_number,product_ref,variant_ref,product_display_name,offer_ref,catalog_snapshot_revision,mapping_revision,unit,quantity_milli,supplier_unit_minor,markup_basis_points,minimum_margin_minor,unit_minor,line_total_minor,currency) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'RUB')`);
    this.insertAudit = defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO pricing.pricing_audit_records (audit_ref,action,quote_ref,actor_ref,correlation_id,reason_code) VALUES ($1,$2,$3,$4,$5::uuid,$6)`);
    this.selectQuote = defineStatement<Row,[string]>(database,`SELECT q.*, p.quote_ttl_seconds, p.quantity_scale, p.rounding_mode, q.total_minor::text, q.catalog_snapshot_revision::text, (q.expires_at > clock_timestamp()) AS unexpired FROM pricing.pricing_quotes q JOIN pricing.pricing_policy_versions p USING (policy_version_ref) WHERE quote_ref=$1`);
    this.selectLines = defineStatement<Row,[string]>(database,`SELECT *, catalog_snapshot_revision::text, mapping_revision::text, quantity_milli::text, supplier_unit_minor::text, minimum_margin_minor::text, unit_minor::text, line_total_minor::text FROM pricing.pricing_quote_lines WHERE quote_ref=$1 ORDER BY line_number`);
  }
  public async readActivePolicy(signal?: AbortSignal): Promise<PricingPolicy> {
    const lookup = () => withTransaction(this.database,{mode:"interactive",...(signal === undefined ? {} : {signal})},async tx => {
      const rows = (await this.activePolicy(tx,[])).rows;
      if (rows.length !== 1) throw new PricingStoreError("PRICING_POLICY_UNAVAILABLE");
      return policyFromRow(rows[0]);
    });
    return this.telemetry ? this.telemetry.observe("pricing.policy.lookup",lookup) : lookup();
  }
  public async precheck(identity: IdempotencyKey, requestHash: string | undefined, signal?: AbortSignal): Promise<PricingPrecheckResult> {
    const lookup = () => withTransaction<PricingPrecheckResult>(this.database,{mode:"interactive",...(signal === undefined ? {} : {signal})},async tx => {
      const record = await this.idempotency.get(tx,identity);
      if (record !== undefined && !validateIdempotencyRecord(record)) throw databaseDecodeError();
      if (record === undefined) return {kind:"not_retained"};
      const now = await this.time(tx,0);
      if (record.state === "Completed" && record.expiresAtMs <= now.nowMs) return {kind:"not_retained"};
      if (requestHash !== undefined && record.requestHash !== requestHash) return {kind:"conflict"};
      if (record.state === "Acquired") return {kind:"in_progress"};
      if (record.response === undefined) throw new PricingStoreError("IDEMPOTENCY_RESULT_INVALID");
      return {kind:"completed",...replay(record.response)};
    });
    return this.telemetry ? this.telemetry.observe("pricing.idempotency.precheck",lookup) : lookup();
  }
  private async time(tx: Transaction, ttl: number): Promise<{createdAt: string; expiresAt: string; nowMs: number}> {
    const row = (await this.clock(tx,[ttl])).rows[0]; if (row === undefined) return invalid();
    decodeRow(row,validateClockRow);
    const nowMs = Number(minor(row["now_ms"])); if (!Number.isSafeInteger(nowMs)) return invalid();
    return {createdAt:timestamp(row["created_at"]),expiresAt:timestamp(row["expires_at"]),nowMs};
  }
  private async audit(tx: Transaction, action: "QuoteCreated" | "QuoteVerified" | "QuoteRejected", quoteRef: string | null, actorRef: string, correlationId: string, reasonCode: string | null): Promise<void> {
    const now = await this.time(tx,0);
    await this.insertAudit(tx,[newRef("aud",now.createdAt),action,quoteRef,actorRef,correlationId,reasonCode]);
  }
  public async create(input: PricingCreateInput): Promise<PricingCreateResult> {
    // Catalog facts and money are fully prepared before acquiring an owner connection.
    // Copy caller-owned objects before the first await; only bounded timestamp-derived hashes remain in tx.
    const policy = {...input.policy};
    const identity = {...input.identity};
    const requestHash = hash(input.requestHash), customerRef = ref(input.customerRef,"cus");
    const catalogSnapshotRevision = minor(input.catalogSnapshotRevision);
    const correlationId = input.correlationId, signal = input.signal;
    if (input.lines.length < 1 || input.lines.length > 100) return invalid();
    const proofs: PricingProofLine[] = [];
    const quantities: bigint[] = [];
    const pairs = new Set<string>();
    const lines = input.lines.map((line,index) => {
      if (line.catalogSnapshotRevision !== catalogSnapshotRevision) throw new PricingStoreError("CATALOG_REVISION_CHANGED");
      const productRef = ref(line.productRef,"prd"), variantRef = ref(line.variantRef,"var");
      const pair = `${productRef}/${variantRef}`;
      if (pairs.has(pair)) return invalid();
      pairs.add(pair);
      const productDisplayName = text(line.productDisplayName);
      if (Array.from(productDisplayName).length > 200 || !["piece","gram","kilogram"].includes(line.unit)) return invalid();
      const calculate = () => calculatePricingLine({quantity:line.quantity,supplierUnitMinor:line.supplierUnitMinor,markupBasisPoints:policy.markupBasisPoints,minimumMarginMinor:BigInt(policy.minimumMarginMinor)});
      const calculated = this.telemetry ? this.telemetry.observeSync("pricing.quote.calculate",calculate) : calculate();
      quantities.push(calculated.quantityMilli);
      proofs.push({lineNumber:index + 1,offerRef:ref(line.offerRef,"off"),mappingRevision:minor(line.mappingRevision),supplierUnitMinor:minor(line.supplierUnitMinor),catalogSnapshotRevision,markupBasisPoints:String(policy.markupBasisPoints),minimumMarginMinor:policy.minimumMarginMinor});
      return {lineNumber:index + 1,productRef,variantRef,productDisplayName,quantity:calculated.quantity,unit:line.unit,unitMinor:encodeMinor(calculated.unitMinor),lineTotalMinor:encodeMinor(calculated.lineTotalMinor)};
    });
    const totalMinor = encodeMinor(sumLineTotals(lines.map(line => ({lineTotalMinor:BigInt(line.lineTotalMinor)}))));
    const persist = () => withTransaction<PricingCreateResult>(this.database,{mode:"interactive",correlationId,...(signal === undefined ? {} : {signal})},async tx => {
      const now = await this.time(tx,0), leaseOwner = randomUUID();
      const acquired = await this.idempotency.acquire(tx,identity,requestHash,leaseOwner,now.nowMs,30_000,86_400_000);
      if (acquired.kind === "conflict") throw new PricingStoreError("IDEMPOTENCY_CONFLICT");
      if (acquired.kind === "in_progress") throw new PricingStoreError("IDEMPOTENCY_REQUEST_IN_PROGRESS");
      if (acquired.kind === "replay") {
        if (!validateIdempotencyResponse(acquired.response)) throw databaseDecodeError();
        return replay(acquired.response);
      }
      if (!validateIdempotencyRecord(acquired.record)) throw databaseDecodeError();
      const policies = (await this.activePolicy(tx,[])).rows;
      if (policies.length !== 1) throw new PricingStoreError("PRICING_POLICY_UNAVAILABLE");
      const active = policyFromRow(policies[0]);
      if (Object.keys(active).some(key => active[key as keyof PricingPolicy] !== policy[key as keyof PricingPolicy])) throw new PricingStoreError("PRICING_POLICY_UNAVAILABLE");
      const time = await this.time(tx,policy.quoteTtlSeconds);
      const quoteRef = newRef("prq",time.createdAt);
      const facts = {quoteRef,policyVersionRef:policy.policyVersionRef,catalogSnapshotRevision,customerRef,createdAt:time.createdAt,expiresAt:time.expiresAt,currency:"RUB" as const,lines,totalMinor};
      const body: PricingQuoteResponse = {...facts,hash:hashPublicQuote(facts)};
      if (!isPricingQuoteResponse(body)) return invalid();
      const internalHash = hashInternalQuote(body,policy,proofs);
      await this.insertQuote(tx,[quoteRef,body.customerRef,body.policyVersionRef,body.catalogSnapshotRevision,body.totalMinor,body.hash,internalHash,body.createdAt,body.expiresAt,identity.actorRef,correlationId,requestHash]);
      for (const line of lines) {
        const proof = proofs[line.lineNumber - 1], quantityMilli = quantities[line.lineNumber - 1];
        if (proof === undefined || quantityMilli === undefined) return invalid();
        await this.insertLine(tx,[quoteRef,line.lineNumber,line.productRef,line.variantRef,line.productDisplayName,proof.offerRef,proof.catalogSnapshotRevision,proof.mappingRevision,line.unit,quantityMilli,proof.supplierUnitMinor,policy.markupBasisPoints,proof.minimumMarginMinor,line.unitMinor,line.lineTotalMinor]);
      }
      await this.audit(tx,"QuoteCreated",quoteRef,identity.actorRef,correlationId,null);
      await this.idempotency.complete(tx,identity,leaseOwner,{status:201,body,resourceRef:quoteRef});
      return {status:201,body,replayed:false};
    });
    return this.telemetry ? this.telemetry.observe("pricing.quote.persist",persist) : persist();
  }
  /** Only the authenticated Orders route may call this method. No public route receives these facts. */
  public async verify(input: PricingVerifyInput): Promise<PricingQuoteVerificationResponse> {
    const result = await withTransaction(this.database,{mode:"interactive",correlationId:input.correlationId,...(input.signal === undefined ? {} : {signal:input.signal})},async tx => {
      const row = (await this.selectQuote(tx,[input.request.quoteRef])).rows[0];
      const reject = async (code: string) => {
        await this.audit(tx,"QuoteRejected",row === undefined ? null : input.request.quoteRef,input.actorRef,input.correlationId,code);
        return {ok:false as const,code};
      };
      if (row === undefined) return reject("PRICING_QUOTE_NOT_FOUND");
      decodeRow(row,validateQuoteRow);
      const persistedLines = (await this.selectLines(tx,[input.request.quoteRef])).rows;
      for (const line of persistedLines) decodeRow(line,validateLineRow);
      let body: PricingQuoteResponse;
      let proofs: PricingProofLine[];
      let internalHash: string;
      try {
        const policy = {quoteTtlSeconds:integer(row["quote_ttl_seconds"],60,3600),quantityScale:integer(row["quantity_scale"],3,3),roundingMode:"CEILING" as const};
        if (row["rounding_mode"] !== "CEILING" || typeof row["unexpired"] !== "boolean") return await reject("PRICING_QUOTE_HASH_MISMATCH");
        proofs = persistedLines.map(line => ({lineNumber:integer(line["line_number"],1,100),offerRef:ref(line["offer_ref"],"off"),mappingRevision:minor(line["mapping_revision"]),supplierUnitMinor:minor(line["supplier_unit_minor"]),catalogSnapshotRevision:minor(line["catalog_snapshot_revision"]),markupBasisPoints:String(integer(line["markup_basis_points"],0,100_000)),minimumMarginMinor:minor(line["minimum_margin_minor"])}));
        const lines = persistedLines.map(line => {
          const milli = BigInt(minor(line["quantity_milli"])); if (milli < 1n || milli > 999_999_999n || line["currency"] !== "RUB" || line["catalog_snapshot_revision"] !== row["catalog_snapshot_revision"]) return invalid();
          const quantity = parseQuantity(`${milli / 1000n}.${String(milli % 1000n).padStart(3,"0")}`).quantity;
          const calculated = calculatePricingLine({quantity,supplierUnitMinor:minor(line["supplier_unit_minor"]),markupBasisPoints:integer(line["markup_basis_points"],0,100_000),minimumMarginMinor:BigInt(minor(line["minimum_margin_minor"]))});
          if (encodeMinor(calculated.unitMinor) !== minor(line["unit_minor"]) || encodeMinor(calculated.lineTotalMinor) !== minor(line["line_total_minor"])) return invalid();
          return {lineNumber:line["line_number"],productRef:line["product_ref"],variantRef:line["variant_ref"],productDisplayName:line["product_display_name"],quantity,unit:line["unit"],unitMinor:line["unit_minor"],lineTotalMinor:line["line_total_minor"]};
        });
        body = publicResponse({quoteRef:row["quote_ref"],policyVersionRef:row["policy_version_ref"],catalogSnapshotRevision:row["catalog_snapshot_revision"],customerRef:row["customer_ref"],createdAt:timestamp(row["created_at"]),expiresAt:timestamp(row["expires_at"]),currency:row["currency"],lines,totalMinor:row["total_minor"],hash:row["canonical_hash"]});
        if (instantMs(body.expiresAt) - instantMs(body.createdAt) !== policy.quoteTtlSeconds * 1000) return invalid();
        internalHash = hash(row["internal_proof_hash"]);
        if (hashPublicQuote(body) !== body.hash || hashInternalQuote(body,policy,proofs) !== internalHash) return invalid();
      } catch (error) {
        if (!(error instanceof PricingStoreError) && !(error instanceof RangeError) && !(error instanceof TypeError)) throw error;
        return reject("PRICING_QUOTE_HASH_MISMATCH");
      }
      if (body.hash !== input.request.hash) return reject("PRICING_QUOTE_HASH_MISMATCH");
      if (body.customerRef !== input.request.customerRef || body.lines.length !== input.request.lines.length || body.lines.some((line,index) => {
        const expected = input.request.lines[index];
        return expected === undefined || line["productRef"] !== expected.productRef || line["variantRef"] !== expected.variantRef || line["quantity"] !== expected.quantity;
      })) return reject("PRICING_QUOTE_SCOPE_MISMATCH");
      if (!row["unexpired"]) return reject("PRICING_QUOTE_EXPIRED");
      const verified: PricingQuoteVerificationResponse = {valid:true,quoteRef:body.quoteRef,policyVersionRef:body.policyVersionRef,catalogSnapshotRevision:body.catalogSnapshotRevision,customerRef:body.customerRef,expiresAt:body.expiresAt,currency:body.currency,totalMinor:body.totalMinor,lines:body.lines.map((line,index) => {
        const proof = proofs[index]; if (proof === undefined) return invalid();
        return {...line,offerRef:proof.offerRef,mappingRevision:proof.mappingRevision,supplierUnitMinor:proof.supplierUnitMinor,currency:"RUB",internalProofHash:internalHash};
      })};
      if (!isPricingQuoteVerificationResponse(verified)) return reject("PRICING_QUOTE_HASH_MISMATCH");
      await this.audit(tx,"QuoteVerified",body.quoteRef,input.actorRef,input.correlationId,null);
      return {ok:true as const,body:verified};
    });
    // Throw only after COMMIT so rejected verifications retain their append-only audit.
    if (!result.ok) throw new PricingStoreError(result.code);
    return result.body;
  }
}
