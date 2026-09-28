import {createHash, randomBytes, randomUUID} from "node:crypto";
import {withTransaction, type Database, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {canonicalJson, canonicalRequestHash, createSqlIdempotencyStore, IdempotencyError, type IdempotencyKey, type IdempotencyResponse, type JsonValue} from "@coffee-platform/idempotency";
import {isOrderCardResponse, isReconciliationAcceptedResponse, type OrderCardResponse, type ReconciliationAcceptedResponse} from "@coffee-platform/contracts-orders-v1";
import {computeOrderContribution, type ContributionItem} from "../../domain/order-contribution.js";
import {projectOrderCard, type StoredCardItem, type StoredCardOrder} from "../../domain/order-card.js";
import {nextOrderStatus} from "../../domain/order-state.js";
import {decodeOrderItemRow, decodeOrderRow} from "./row-schemas.js";
import {observe} from "../../observability.js";

const LEASE_MS = 30_000;
const RETENTION_MS = 86_400_000;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
type Row = Readonly<Record<string, unknown>>;
type ItemSnapshot = Readonly<{
  productRef:string; variantRef:string; productDisplayName:string; unit:"piece"|"gram"|"kilogram"; quantityMilli:string;
  quoteRef:string; quoteLineNumber:number; quoteHash:string; internalProofHash:string; quoteExpiresAt:string;
  policyVersionRef:string; catalogSnapshotRevision:string; mappingRevision:string; offerRef:string;
  unitMinor:string; lineTotalMinor:string; currency:"RUB";
}>;
type Meta = Readonly<{actorRef:string; identity:IdempotencyKey; correlationId:string; signal?:AbortSignal; traceparent?:string; cardPermissions?:readonly string[]}>;
type ItemRequest=Readonly<{expectedVersion:string;productRef:string;variantRef:string;quantity:string;quoteRef:string;quoteLineNumber:number;quoteHash:string}>;
export type CreateDraftCommand = Meta & Readonly<{customer:Readonly<{customerRef:string;customerVersion:string;displayName:string;state:"Active"}>}>;
export type PutItemCommand = Meta & Readonly<{orderRef:string;itemRef:string;expectedVersion:string;request:ItemRequest;item:ItemSnapshot}>;
export type DeleteItemCommand = Meta & Readonly<{orderRef:string;itemRef:string;expectedVersion:string}>;
export type ConfirmOrderCommand = Meta & Readonly<{orderRef:string;expectedVersion:string}>;
export type ReconciliationCommand = Meta & Readonly<{orderRef:string;expectedVersion:string;reason:string}>;
export type OrderCommandResult = Readonly<{status:200|201;body:OrderCardResponse;replayed:boolean}>;
export type ReconciliationCommandResult = Readonly<{status:202;body:ReconciliationAcceptedResponse;replayed:boolean}>;
type ReconciliationState = "OutOfSync"|"Blocked"|"UnknownOutcome";
/** Test-only, synchronous, read-only local projection. The production composition root never supplies one. */
export type ReconciliationProjectionFixture = ReadonlyMap<string,Readonly<{orderVersion:string;state:ReconciliationState|"PendingObservation"|"Converging"|"InSync"}>>;
export type OrderReplayResult =
  | Readonly<{kind:"completed";response:Readonly<{status:number;body:JsonValue;resourceRef?:string}>}>
  | Readonly<{kind:"in_progress"}> | Readonly<{kind:"not_retained"}> | Readonly<{kind:"invalid"}>;
export type OrderPrecheckResult=OrderReplayResult|Readonly<{kind:"proceed"}>|Readonly<{kind:"conflict"}>;
export class OrderStoreError extends Error {
  public readonly code:string;
  public constructor(code:string) {super(code);this.name="OrderStoreError";this.code=code;}
}

type TemporalInstantLike=Readonly<{epochMilliseconds:number;toString:(options?:Readonly<{fractionalSecondDigits?:number}>)=>string}>;
type TemporalApi=Readonly<{Instant:Readonly<{from:(value:string)=>TemporalInstantLike}>;Now:Readonly<{instant:()=>TemporalInstantLike}>}>;
function temporal():TemporalApi {const api=(globalThis as {Temporal?:TemporalApi}).Temporal;if(api===undefined)throw new Error("TEMPORAL_UNAVAILABLE");return api;}
function fail(code:string):never {throw new OrderStoreError(code);}
function string(value:unknown):string {if(typeof value!=="string"||value.length===0) return fail("ORDER_DATABASE_DECODE_ERROR");return value;}
function canonicalPositive(value:string):string {if(!/^[1-9][0-9]*$/u.test(value)||BigInt(value)>MAX_BIGINT) return fail("ORDER_VALIDATION_FAILED");return value;}
function canonicalNonnegative(value:string):string {if(!/^(?:0|[1-9][0-9]*)$/u.test(value)||BigInt(value)>MAX_BIGINT) return fail("ORDER_VALIDATION_FAILED");return value;}
function validRef(value:string,prefix:string):string {if(!new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`,`u`).test(value)) return fail("ORDER_VALIDATION_FAILED");return value;}
function validHash(value:string):string {if(!/^[0-9a-f]{64}$/u.test(value)) return fail("ORDER_VALIDATION_FAILED");return value;}
function milliseconds(value:unknown):number {try {if(typeof value==="number"||typeof value==="bigint") {const n=Number(value);if(Number.isSafeInteger(n))return n;}if(typeof value==="string") {if(/^(?:0|[1-9][0-9]*)$/u.test(value)){const n=Number(value);if(Number.isSafeInteger(n))return n;}return temporal().Instant.from(value).epochMilliseconds;}} catch {} return fail("ORDER_DATABASE_DECODE_ERROR");}
function timestamp(value:unknown):string {try {if(typeof value!=="string")return fail("ORDER_DATABASE_DECODE_ERROR");return temporal().Instant.from(value).toString({fractionalSecondDigits:3});}catch{return fail("ORDER_DATABASE_DECODE_ERROR");}}
function newRef(prefix:string):string {let bits=(BigInt(temporal().Now.instant().epochMilliseconds)<<80n)|BigInt(`0x${randomBytes(10).toString("hex")}`);let encoded="";for(let i=0;i<26;i++){encoded=ULID_ALPHABET[Number(bits&31n)]!+encoded;bits>>=5n;}return `${prefix}_${encoded}`;}
function requestHash(value:JsonValue):string {return canonicalRequestHash(value);}
export function hashOrderDraftRequest(customerRef:string):string {validRef(customerRef,"cus");return requestHash({customerRef});}
export function hashOrderItemPutRequest(request:ItemRequest):string {canonicalPositive(request.expectedVersion);validRef(request.productRef,"prd");validRef(request.variantRef,"var");validRef(request.quoteRef,"prq");validHash(request.quoteHash);if(!Number.isInteger(request.quoteLineNumber)||request.quoteLineNumber<1||request.quoteLineNumber>100||! /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/u.test(request.quantity))return fail("ORDER_VALIDATION_FAILED");return requestHash({expectedVersion:request.expectedVersion,productRef:request.productRef,variantRef:request.variantRef,quantity:request.quantity,quoteRef:request.quoteRef,quoteLineNumber:request.quoteLineNumber,quoteHash:request.quoteHash});}
function quantityMilli(value:string):string {if(!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,3})?$/u.test(value))return fail("ORDER_VALIDATION_FAILED");const [whole,fraction=""] = value.split(".");const milli=BigInt(whole!)*1000n+BigInt((fraction+"000").slice(0,3));if(milli<1n||milli>999_999_999n)return fail("ORDER_VALIDATION_FAILED");return milli.toString();}
export function customerSnapshotProofHash(customer:Readonly<{customerRef:string;customerVersion:string;displayName:string;state:"Active"}>):string {return requestHash({customerRef:customer.customerRef,customerVersion:customer.customerVersion,displayName:customer.displayName,state:customer.state});}
function objectJson(value:unknown):JsonValue {if(value===null||typeof value!=="object") return fail("IDEMPOTENCY_RESULT_INVALID");return value as JsonValue;}
function publicReplay(response:IdempotencyResponse,orderRef:string):OrderCommandResult {
  if(response.resourceRef!==orderRef||!isOrderCardResponse(response.body)||response.body.orderRef!==orderRef) return fail("IDEMPOTENCY_RESULT_INVALID");
  if(response.status!==200&&response.status!==201) return fail("IDEMPOTENCY_RESULT_INVALID");
  return {status:response.status,body:response.body,replayed:true};
}
function publicReconciliationReplay(response:IdempotencyResponse,orderRef:string):ReconciliationCommandResult {
  if(response.status!==202||response.resourceRef!==orderRef||!isReconciliationAcceptedResponse(response.body)||response.body.orderRef!==orderRef)return fail("IDEMPOTENCY_RESULT_INVALID");
  return {status:202,body:response.body,replayed:true};
}
function replayResponse(result:OrderCommandResult|ReconciliationCommandResult):IdempotencyResponse {return {status:result.status,body:result.body as unknown as JsonValue,resourceRef:result.body.orderRef};}
function reconciliationScope(orderRef:string):string {return createHash("sha256").update(`POST\n/api/client-v1/orders/${orderRef}/commands/request-aroma-reconciliation`,"utf8").digest("hex");}
function validReplay(identity:IdempotencyKey,response:IdempotencyResponse):boolean {
  const body=response.body;
  if(isReconciliationAcceptedResponse(body))return response.status===202&&response.resourceRef===body.orderRef&&identity.scope===reconciliationScope(body.orderRef);
  return (response.status===200||response.status===201)&&isOrderCardResponse(body)&&response.resourceRef===body.orderRef&&identity.scope!==reconciliationScope(body.orderRef);
}
function checkActor(command:Meta):void {if(!command.actorRef||command.identity.actorRef!==command.actorRef||!command.correlationId) fail("ORDER_VALIDATION_FAILED");}
function eventHash(bytes:Buffer):string {return createHash("sha256").update(bytes).digest("hex");}
function validTraceparent(value:string):string {const match=/^(?!ff-)([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(value);if(match===null||match[2]==="0".repeat(32)||match[3]==="0".repeat(16))return fail("ORDER_VALIDATION_FAILED");return value;}

export class OrderStore {
  private readonly database:Database;
  private readonly idempotency;
  private readonly leaseOwners=new WeakMap<Transaction,string>();
  private readonly selectOrderForShare;
  private readonly selectOrderForUpdate;
  private readonly selectItems;
  private readonly insertOrder;
  private readonly updateOrder;
  private readonly insertHistory;
  private readonly insertItem;
  private readonly updateItem;
  private readonly deleteItemRow;
  private readonly insertDesired;
  private readonly insertDesiredLine;
  private readonly insertOutbox;
  private readonly insertReconciliationOutbox;
  private readonly updateReconciledOrder;
  private readonly readIdempotencyTime;
  private readonly checkQuoteExpiry;
  private readonly testOnlyReconciliationProjection:ReconciliationProjectionFixture|undefined;
  public constructor(database:Database,options:Readonly<{testOnlyReconciliationProjection?:ReconciliationProjectionFixture}>={}) {
    this.database=database;
    this.testOnlyReconciliationProjection=options.testOnlyReconciliationProjection;
    this.idempotency=createSqlIdempotencyStore<IdempotencyResponse>(database,{schema:"orders",table:"idempotency_records"});
    this.readIdempotencyTime=defineStatement<Row,[]>(database,"SELECT floor(extract(epoch FROM transaction_timestamp())*1000)::bigint AS now_ms");
    this.selectOrderForShare=defineStatement<Row,[string]>(database,"SELECT * FROM orders.orders WHERE order_ref=$1 FOR SHARE");
    this.selectOrderForUpdate=defineStatement<Row,[string]>(database,"SELECT * FROM orders.orders WHERE order_ref=$1 FOR UPDATE");
    this.checkQuoteExpiry=defineStatement<Row,[string]>(database,"SELECT $1::timestamptz > transaction_timestamp() AS valid");
    this.selectItems=defineStatement<Row,[string]>(database,"SELECT * FROM orders.order_items WHERE order_ref=$1 ORDER BY line_position");
    this.insertOrder=defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO orders.orders(order_ref,customer_ref,customer_version,customer_display_name,customer_state,customer_state_proof_hash,created_by_actor_ref,last_modified_by_actor_ref,status) VALUES($1,$2,$3,$4,'Active',$5,$6,$6,$7)`);
    this.updateOrder=defineStatement<Row,readonly SqlScalar[]>(database,`UPDATE orders.orders SET version=version+1, projection_version=projection_version+1, currency=COALESCE(currency,$3), updated_at=transaction_timestamp(), last_modified_by_actor_ref=$4 WHERE order_ref=$1 AND status='Draft' AND version=$2 RETURNING version::text`);
    this.insertHistory=defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO orders.order_history(history_ref,order_ref,order_version,event_type,item_ref,actor_ref,correlation_id,facts) VALUES($1,$2,$3,$4,$5,$6,$7::uuid,$8::jsonb)`);
    this.insertItem=defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO orders.order_items(order_ref,item_ref,line_position,product_ref,variant_ref,product_display_name,unit,quantity_milli,quote_ref,quote_line_number,quote_hash,internal_proof_hash,quote_expires_at,policy_version_ref,catalog_snapshot_revision,mapping_revision,offer_ref,unit_minor,line_total_minor,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14,$15,$16,$17,$18,$19,$20)`);
    this.updateItem=defineStatement<Row,readonly SqlScalar[]>(database,`UPDATE orders.order_items SET product_ref=$3,variant_ref=$4,product_display_name=$5,unit=$6,quantity_milli=$7,quote_ref=$8,quote_line_number=$9,quote_hash=$10,internal_proof_hash=$11,quote_expires_at=$12::timestamptz,policy_version_ref=$13,catalog_snapshot_revision=$14,mapping_revision=$15,offer_ref=$16,unit_minor=$17,line_total_minor=$18,currency=$19,updated_at=transaction_timestamp() WHERE order_ref=$1 AND item_ref=$2`);
    this.deleteItemRow=defineStatement<Row,readonly SqlScalar[]>(database,"DELETE FROM orders.order_items WHERE order_ref=$1 AND item_ref=$2 RETURNING item_ref");
    this.insertDesired=defineStatement<Row,readonly SqlScalar[]>(database,"INSERT INTO orders.order_desired_contributions(order_ref,contribution_revision,order_version) VALUES($1,1,$2)");
    this.insertDesiredLine=defineStatement<Row,readonly SqlScalar[]>(database,"INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,quantity_milli,contribution_hash,item_refs) VALUES($1,1,$2,$3,$4,ARRAY(SELECT jsonb_array_elements_text($5::jsonb))::varchar[])");
    this.insertOutbox=defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,lease_until) VALUES($1::text,'OrderConfirmed.v1','coffee.orders.lifecycle.v1',$2::varchar(30),$3::bigint,$4::text,$2::text,'1',$5::bytea,$6::char(64),$7::jsonb,$8::jsonb,$9::char(64),$10::timestamptz,$11::text,NULL,$12::text,to_timestamp(0))`);
    this.updateReconciledOrder=defineStatement<Row,readonly SqlScalar[]>(database,`UPDATE orders.orders SET version=version+1,projection_version=projection_version+1,updated_at=transaction_timestamp(),last_modified_by_actor_ref=$3 WHERE order_ref=$1 AND status='Confirmed' AND version=$2 RETURNING version::text AS version,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at`);
    this.insertReconciliationOutbox=defineStatement<Row,readonly SqlScalar[]>(database,`INSERT INTO orders.outbox_messages(message_id,message_type,topic,aggregate_ref,aggregate_sequence,owner_version,partition_key,schema_version,envelope_bytes,envelope_hash,envelope,payload,payload_hash,occurred_at,correlation_id,causation_id,traceparent,lease_until) VALUES($1::text,'OrderReconciliationRequested.v1','coffee.orders.lifecycle.v1',$2::varchar(30),$3::bigint,$3::text,$2::text,'1',$4::bytea,$5::char(64),$6::jsonb,$7::jsonb,$5::char(64),$8::timestamptz,$9::text,NULL,$10::text,to_timestamp(0))`);
  }
  private async time(tx:Transaction):Promise<number> {const row=(await this.readIdempotencyTime(tx,[])).rows[0];if(row===undefined)return fail("ORDER_DATABASE_DECODE_ERROR");return milliseconds(row["now_ms"]);}
  private async acquire(tx:Transaction,command:Meta,hash:string,reconciliationOrderRef?:string):Promise<"new"|OrderCommandResult|ReconciliationCommandResult> {
    checkActor(command);const leaseOwner=randomUUID();const acquired=await this.idempotency.acquire(tx,command.identity,hash,leaseOwner,await this.time(tx),LEASE_MS,RETENTION_MS);
    if(acquired.kind==="conflict") return fail("IDEMPOTENCY_CONFLICT");
    if(acquired.kind==="in_progress") return fail("IDEMPOTENCY_REQUEST_IN_PROGRESS");
    if(acquired.kind==="replay") {const orderRef=string(acquired.response.resourceRef);return reconciliationOrderRef===undefined?publicReplay(acquired.response,orderRef):publicReconciliationReplay(acquired.response,reconciliationOrderRef);}
    this.leaseOwners.set(tx,leaseOwner);
    return "new";
  }
  private async complete(tx:Transaction,command:Meta,result:OrderCommandResult|ReconciliationCommandResult):Promise<void> {
    // SqlIdempotencyStore's transaction-local permit is tied to the lease owner created at acquire.
    const permit=this.leaseOwners.get(tx);
    if(permit===undefined) return fail("IDEMPOTENCY_NOT_ACQUIRED");
    await this.idempotency.complete(tx,command.identity,permit,replayResponse(result));
  }
  private async response(tx:Transaction,orderRef:string,permissions:readonly string[]=[]):Promise<OrderCardResponse> {
    // Item DML's owner trigger takes FOR UPDATE on the same parent; keep this lock through both reads.
    const rawOrder=(await this.selectOrderForShare(tx,[orderRef])).rows[0];if(rawOrder===undefined)return fail("ORDER_NOT_FOUND");
    const order=decodeOrderRow(rawOrder);
    const rows=(await this.selectItems(tx,[orderRef])).rows.map(decodeOrderItemRow);
    const storedOrder:StoredCardOrder={orderRef:order.order_ref,status:order.status,version:order.version,projectionVersion:order.projection_version,customerRef:order.customer_ref,customerDisplayName:order.customer_display_name,customerVersion:order.customer_version};
    const items:StoredCardItem[]=rows.map(row=>({itemRef:row.item_ref,linePosition:row.line_position,productRef:row.product_ref,variantRef:row.variant_ref,displayName:row.product_display_name,quantity:(Number(row.quantity_milli)/1000).toString(),unit:row.unit,quoteRef:row.quote_ref,quoteLineNumber:row.quote_line_number,unitMinor:row.unit_minor,lineTotalMinor:row.line_total_minor,quoteHash:row.quote_hash,quoteExpiresAt:timestamp(row.quote_expires_at.toISOString()),quoteExpiresAtEpochMs:row.quote_expires_at.getTime()}));
    const projected=projectOrderCard({order:storedOrder,items,nowEpochMs:await this.time(tx),permissions});
    if(!isOrderCardResponse(projected))return fail("ORDER_DATABASE_DECODE_ERROR");return projected;
  }
  private async bump(tx:Transaction,command:Meta,orderRef:string,expectedVersion:string,currency:string|null):Promise<string> {
    const result=await this.updateOrder(tx,[orderRef,expectedVersion,currency,command.actorRef]);if(result.rowCount!==1)return fail("ORDER_VERSION_CONFLICT");return string(result.rows[0]?.["version"]);
  }
  private async history(tx:Transaction,command:Meta,orderRef:string,version:string,event:string,itemRef:string|null,facts:JsonValue):Promise<void> {
    await this.insertHistory(tx,[newRef("htr"),orderRef,version,event,itemRef,command.actorRef,command.correlationId,JSON.stringify(facts)]);
  }
  private async runCommand(tx:Transaction,command:Meta,inputHash:string,status:200|201,action:()=>Promise<{orderRef:string;version:string;event:string;itemRef?:string;facts:JsonValue}>):Promise<OrderCommandResult> {
    // COMMIT outcome is owned by withTransaction; propagate unknown outcomes and resolve only by exact replay/precheck.
    const acquired=await this.acquire(tx,command,inputHash);if(acquired!=="new")return acquired as OrderCommandResult;
    const result=await action();
    await this.history(tx,command,result.orderRef,result.version,result.event,result.itemRef??null,result.facts);
    const body=await this.response(tx,result.orderRef,command.cardPermissions??[]);
    if(body.aroma.blockers.some(blocker=>blocker.code==="ORDER_STATE_INCONSISTENT"))return fail("ORDER_STATE_INCONSISTENT");
    const response={status,body,replayed:false} as const;
    await this.complete(tx,command,response);return response;
  }
  public async createDraft(command:CreateDraftCommand):Promise<OrderCommandResult> {
    const customer={...command.customer};validRef(customer.customerRef,"cus");canonicalPositive(customer.customerVersion);if(customer.state!=="Active"||!customer.displayName) return fail("CUSTOMER_NOT_ACTIVE");
    const proofHash=customerSnapshotProofHash(customer);const hash=hashOrderDraftRequest(customer.customerRef);
    return observe("orders.transaction.create",()=>withTransaction(this.database,{mode:"interactive",correlationId:command.correlationId,...(command.signal===undefined?{}:{signal:command.signal})},tx=>this.runCommand(tx,command,hash,201,async()=>{
      const initial=nextOrderStatus(null,"CreateDraft");if(initial===null)return fail("ORDER_STATE_INCONSISTENT");
      const orderRef=newRef("ord");await this.insertOrder(tx,[orderRef,customer.customerRef,customer.customerVersion,customer.displayName,proofHash,command.actorRef,initial]);
      return {orderRef,version:"1",event:"DraftCreated",facts:{customerRef:customer.customerRef,customerVersion:customer.customerVersion}};
    })),command.signal);
  }
  public async putItem(command:PutItemCommand):Promise<OrderCommandResult> {
    const {orderRef,itemRef,expectedVersion}=command;validRef(orderRef,"ord");validRef(itemRef,"itm");canonicalPositive(expectedVersion);const item={...command.item};
    const request=command.request;if(request.expectedVersion!==expectedVersion||request.productRef!==item.productRef||request.variantRef!==item.variantRef||request.quoteRef!==item.quoteRef||request.quoteLineNumber!==item.quoteLineNumber||request.quoteHash!==item.quoteHash||quantityMilli(request.quantity)!==item.quantityMilli)return fail("ORDER_VALIDATION_FAILED");
    validRef(item.productRef,"prd");validRef(item.variantRef,"var");validRef(item.quoteRef,"prq");validRef(item.policyVersionRef,"pvr");validRef(item.offerRef,"off");canonicalPositive(item.quantityMilli);canonicalNonnegative(item.catalogSnapshotRevision);canonicalNonnegative(item.mappingRevision);validHash(item.quoteHash);validHash(item.internalProofHash);
    if(!Number.isInteger(item.quoteLineNumber)||item.quoteLineNumber<1||item.quoteLineNumber>100||!item.productDisplayName||!["piece","gram","kilogram"].includes(item.unit)||item.currency!=="RUB")return fail("ORDER_VALIDATION_FAILED");
    const quoteExpiresAt=timestamp(item.quoteExpiresAt);
    const hash=hashOrderItemPutRequest(request);
    return observe("orders.transaction.put",()=>withTransaction(this.database,{mode:"interactive",correlationId:command.correlationId,...(command.signal===undefined?{}:{signal:command.signal})},tx=>this.runCommand(tx,command,hash,200,async()=>{
      const rawParent=(await this.selectOrderForUpdate(tx,[orderRef])).rows[0];if(rawParent===undefined)return fail("ORDER_NOT_FOUND");const parent=decodeOrderRow(rawParent);if(nextOrderStatus(parent.status,"UpsertItem")===null)return fail("ORDER_NOT_EDITABLE");if(parent.version!==expectedVersion)return fail("ORDER_VERSION_CONFLICT");
      if((await this.checkQuoteExpiry(tx,[quoteExpiresAt])).rows[0]?.["valid"]!==true)return fail("PRICING_QUOTE_EXPIRED");
      const rows=(await this.selectItems(tx,[orderRef])).rows.map(decodeOrderItemRow);
      if(rows.some(row=>row.item_ref!==itemRef&&row.quote_ref===item.quoteRef&&row.quote_line_number===item.quoteLineNumber))return fail("ORDER_QUOTE_SCOPE_MISMATCH");
      const existing=rows.find(row=>row.item_ref===itemRef);let position:number;
      if(existing!==undefined) position=existing.line_position;else {const count=(await defineStatement<Row,[string]>(this.database,"SELECT COALESCE(min(candidate.position),101)::int AS count FROM generate_series(1,100) AS candidate(position) WHERE NOT EXISTS (SELECT 1 FROM orders.order_items WHERE order_ref=$1 AND line_position=candidate.position)")(tx,[orderRef])).rows[0];position=Number(count?.["count"]??101);if(position>100)return fail("ORDER_ITEM_LIMIT_EXCEEDED");}
      const currency=string(parent["currency"]??"RUB");if(parent["currency"]!==null&&parent["currency"]!=="RUB")return fail("ORDER_STATE_INCONSISTENT");
      await this.bump(tx,command,orderRef,expectedVersion,currency);
      const params=[orderRef,itemRef,position,item.productRef,item.variantRef,item.productDisplayName,item.unit,item.quantityMilli,item.quoteRef,item.quoteLineNumber,item.quoteHash,item.internalProofHash,quoteExpiresAt,item.policyVersionRef,item.catalogSnapshotRevision,item.mappingRevision,item.offerRef,item.unitMinor,item.lineTotalMinor,item.currency] as const;
      if(existing===undefined)await this.insertItem(tx,params);else await this.updateItem(tx,[orderRef,itemRef,...params.slice(3)]);
      return {orderRef,version:(BigInt(expectedVersion)+1n).toString(),event:"ItemUpserted",itemRef,facts:{itemRef,quoteRef:item.quoteRef,quoteLineNumber:item.quoteLineNumber}};
    })),command.signal);
  }
  public async deleteItem(command:DeleteItemCommand):Promise<OrderCommandResult> {
    const {orderRef,itemRef,expectedVersion}=command;validRef(orderRef,"ord");validRef(itemRef,"itm");canonicalPositive(expectedVersion);
    const hash=requestHash({orderRef,itemRef,expectedVersion});
    return observe("orders.transaction.remove",()=>withTransaction(this.database,{mode:"interactive",correlationId:command.correlationId,...(command.signal===undefined?{}:{signal:command.signal})},tx=>this.runCommand(tx,command,hash,200,async()=>{
      const rawParent=(await this.selectOrderForUpdate(tx,[orderRef])).rows[0];if(rawParent===undefined)return fail("ORDER_NOT_FOUND");const parent=decodeOrderRow(rawParent);if(nextOrderStatus(parent.status,"DeleteItem")===null)return fail("ORDER_NOT_EDITABLE");if(parent.version!==expectedVersion)return fail("ORDER_VERSION_CONFLICT");
      const removed=await this.deleteItemRow(tx,[orderRef,itemRef]);if(removed.rowCount!==1)return fail("ORDER_ITEM_NOT_FOUND");
      const next=(BigInt(expectedVersion)+1n).toString();await this.bump(tx,command,orderRef,expectedVersion,parent["currency"]===null?null:"RUB");
      return {orderRef,version:next,event:"ItemRemoved",itemRef,facts:{itemRef}};
    })),command.signal);
  }
  public async confirm(command:ConfirmOrderCommand):Promise<OrderCommandResult> {
    const {orderRef,expectedVersion}=command;validRef(orderRef,"ord");canonicalPositive(expectedVersion);const traceparent=command.traceparent===undefined?`00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`:validTraceparent(command.traceparent);const hash=requestHash({orderRef,expectedVersion});
    return observe("orders.transaction.confirm",()=>withTransaction(this.database,{mode:"interactive",correlationId:command.correlationId,...(command.signal===undefined?{}:{signal:command.signal})},tx=>this.runCommand(tx,command,hash,200,async()=>{
      const rawOrder=(await this.selectOrderForUpdate(tx,[orderRef])).rows[0];
      if(rawOrder===undefined)return fail("ORDER_NOT_FOUND");const order=decodeOrderRow(rawOrder);const nextStatus=nextOrderStatus(order.status,"Confirm");if(nextStatus===null)return fail("ORDER_NOT_EDITABLE");if(order.version!==expectedVersion)return fail("ORDER_VERSION_CONFLICT");
      const rows=(await this.selectItems(tx,[orderRef])).rows.map(decodeOrderItemRow);if(rows.length===0)return fail("ORDER_EMPTY");
      const beforeConfirm=await this.response(tx,orderRef,[]);
      if(beforeConfirm.aroma.blockers.some(blocker=>blocker.code==="ORDER_STATE_INCONSISTENT"))return fail("ORDER_STATE_INCONSISTENT");
      const items:ContributionItem[]=rows.map(row=>({itemRef:row.item_ref,offerRef:row.offer_ref,productRef:row.product_ref,variantRef:row.variant_ref,quantityMilli:row.quantity_milli,quoteRef:row.quote_ref,quoteLineNumber:row.quote_line_number}));
      const contribution=computeOrderContribution(items);const now=await this.time(tx);if(rows.some(row=>row.quote_expires_at.getTime()<=now))return fail("PRICING_QUOTE_EXPIRED");
      const version=(BigInt(expectedVersion)+1n).toString();const updated=await defineStatement<Row,readonly SqlScalar[]>(this.database,`UPDATE orders.orders SET status=$5,version=$3,projection_version=projection_version+1,confirmed_at=transaction_timestamp(),updated_at=transaction_timestamp(),last_modified_by_actor_ref=$4,currency='RUB' WHERE order_ref=$1 AND status='Draft' AND version=$2 RETURNING to_char(confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS confirmed_at`)(tx,[orderRef,expectedVersion,version,command.actorRef,nextStatus]);
      if(updated.rowCount!==1)return fail("ORDER_VERSION_CONFLICT");const confirmedAt=timestamp(updated.rows[0]?.["confirmed_at"]);
      await this.insertDesired(tx,[orderRef,version]);for(const line of contribution.lines)await this.insertDesiredLine(tx,[orderRef,line.offerRef,line.quantityMilli,line.contributionHash,JSON.stringify(line.itemRefs)]);
      const payload={orderRef,orderVersion:version,customerRef:string(order["customer_ref"]),confirmedAt,contributionRevision:"1"};const envelope={envelopeVersion:"1",messageId:newRef("msg"),messageType:"OrderConfirmed.v1",occurredAt:confirmedAt,producer:"orders-service",correlationId:command.correlationId,causationId:null,traceparent,aggregate:{type:"Order",ref:orderRef,version},payload};
      const bytes=Buffer.from(canonicalJson(envelope));const envelopeDigest=eventHash(bytes);const payloadDigest=requestHash(envelope);await observe("orders.outbox.insert",()=>this.insertOutbox(tx,[envelope.messageId,orderRef,version,version,bytes,envelopeDigest,JSON.stringify(envelope),JSON.stringify(payload),payloadDigest,confirmedAt,command.correlationId,envelope.traceparent]),command.signal);
      return {orderRef,version,event:"OrderConfirmed",facts:{contributionRevision:"1",contributionHash:contribution.hash}};
    })),command.signal);
  }
  public async requestReconciliation(command:ReconciliationCommand):Promise<ReconciliationCommandResult> {
    const {orderRef,expectedVersion,reason}=command;
    validRef(orderRef,"ord");canonicalPositive(expectedVersion);
    if(typeof reason!=="string"||reason.length<1||reason.length>500||command.identity.scope!==reconciliationScope(orderRef))return fail("ORDER_VALIDATION_FAILED");
    const traceparent=command.traceparent===undefined?`00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`:validTraceparent(command.traceparent);
    const hash=requestHash({orderRef,expectedVersion,reason});
    return observe("orders.transaction.reconcile",()=>withTransaction(this.database,{mode:"interactive",correlationId:command.correlationId,...(command.signal===undefined?{}:{signal:command.signal})},async tx=>{
      const acquired=await this.acquire(tx,command,hash,orderRef);
      if(acquired!=="new")return acquired as ReconciliationCommandResult;
      const raw=(await this.selectOrderForUpdate(tx,[orderRef])).rows[0];
      if(raw===undefined)return fail("ORDER_NOT_FOUND");
      const order=decodeOrderRow(raw);
      if(nextOrderStatus(order.status,"RequestReconciliation")===null)return fail("AROMA_RECONCILIATION_NOT_ALLOWED");
      if(order.version!==expectedVersion)return fail("ORDER_VERSION_CONFLICT");
      const projected=this.testOnlyReconciliationProjection?.get(orderRef);
      if(projected?.orderVersion!==order.version||!(projected.state==="OutOfSync"||projected.state==="Blocked"||projected.state==="UnknownOutcome"))return fail("AROMA_RECONCILIATION_NOT_ALLOWED");
      const updated=await this.updateReconciledOrder(tx,[orderRef,expectedVersion,command.actorRef]);
      if(updated.rowCount!==1)return fail("ORDER_VERSION_CONFLICT");
      const version=string(updated.rows[0]?.["version"]),requestedAt=timestamp(updated.rows[0]?.["requested_at"]);
      // The free-text operator reason participates in idempotency, but must not enter the durable audit/event payload.
      await this.history(tx,command,orderRef,version,"ReconciliationRequested",null,{requestKind:"OperatorRequested"});
      const payload={orderRef,orderVersion:version,requestedAt};
      const envelope={envelopeVersion:"1",messageId:newRef("msg"),messageType:"OrderReconciliationRequested.v1",occurredAt:requestedAt,producer:"orders-service",correlationId:command.correlationId,causationId:null,traceparent,aggregate:{type:"Order",ref:orderRef,version},payload};
      const bytes=Buffer.from(canonicalJson(envelope));const digest=eventHash(bytes);
      await observe("orders.outbox.insert",()=>this.insertReconciliationOutbox(tx,[envelope.messageId,orderRef,version,bytes,digest,JSON.stringify(envelope),JSON.stringify(payload),requestedAt,command.correlationId,traceparent]),command.signal);
      const result={status:202,body:{orderRef,orderVersion:version,requestedAt,aromaState:projected.state},replayed:false} as const;
      if(!isReconciliationAcceptedResponse(result.body))return fail("ORDER_DATABASE_DECODE_ERROR");
      await this.complete(tx,command,result);
      return result;
    }),command.signal);
  }
  public async getCard(orderRef:string,options:Readonly<{permissions?:readonly string[];correlationId:string;signal?:AbortSignal}>):Promise<OrderCardResponse> {
    validRef(orderRef,"ord");return observe("orders.transaction.get",()=>withTransaction(this.database,{mode:"interactive",correlationId:options.correlationId,...(options.signal===undefined?{}:{signal:options.signal})},tx=>this.response(tx,orderRef,options.permissions??[])),options.signal);
  }
  /** Call only after operation permission checks; use before Customer/Pricing network reads. */
  public async precheck(identity:IdempotencyKey,hash:string,correlationId:string,signal?:AbortSignal):Promise<OrderPrecheckResult> {
    validHash(hash);
    return observe("orders.transaction.precheck",()=>withTransaction(this.database,{mode:"interactive",correlationId,...(signal===undefined?{}:{signal})},async tx=>{
      const record=await this.idempotency.get(tx,identity);if(record===undefined)return {kind:"proceed"} as const;
      if(record.requestHash!==hash)return {kind:"conflict"} as const;
      if(record.state==="Acquired")return {kind:"in_progress"} as const;
      if(record.expiresAtMs<=await this.time(tx))return {kind:"not_retained"} as const;
      if(record.response===undefined||!validReplay(identity,record.response))return {kind:"invalid"} as const;
      return {kind:"completed",response:{status:record.response.status,body:objectJson(record.response.body),resourceRef:string(record.response.resourceRef)}} as const;
    }),signal);
  }
  /** Authorization must happen before this bodyless replay lookup too. */
  public async replay(identity:IdempotencyKey,signal:AbortSignal|undefined,correlationId:string):Promise<OrderReplayResult> {
    try {
      return await observe("orders.transaction.replay",()=>withTransaction(this.database,{mode:"interactive",correlationId,...(signal===undefined?{}:{signal})},async tx=>{
        const record=await this.idempotency.get(tx,identity);if(record===undefined)return {kind:"not_retained"} as const;
        if(record.state==="Acquired")return {kind:"in_progress"} as const;
        if(record.expiresAtMs<=await this.time(tx))return {kind:"not_retained"} as const;
        if(record.response===undefined||!validReplay(identity,record.response))return {kind:"invalid"} as const;
        return {kind:"completed",response:{status:record.response.status,body:objectJson(record.response.body),...(record.response.resourceRef===undefined?{}:{resourceRef:record.response.resourceRef})}} as const;
      }),signal);
    } catch (error) {
      if (error instanceof IdempotencyError && error.code === "IDEMPOTENCY_RECORD_INVALID") return {kind:"invalid"};
      throw error;
    }
  }
}
