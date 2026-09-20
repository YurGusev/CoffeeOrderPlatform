import {randomUUID} from "node:crypto";
import type {GatewayTelemetry} from "../observability.js";
import {finishGatewaySpan} from "../observability.js";
import {DatabaseTransactionError, type Database, type QueryResult, type SqlScalar, type Transaction, withTransaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {
  assertMutationDelegation,
  canonicalMutationRequestHash,
  isValidGatewayMutationResponseBytes,
  MutationJournalError,
  normalizeMutationRequest,
  typedResponseHash,
  type DispatchDecision,
  type DispatchPermit,
  type MutationAcknowledged,
  type MutationDelegation,
  type MutationJournalPort,
  type MutationJournalState,
  type MutationRejected,
  type MutationRequest,
  type MutationReservation,
  type MutationUnknownFailureCode,
  type MutationTerminalResult,
  type MutationUnknownOutcomeResult,
  type ReservationDecision,
  type NormalizedMutationRequest,
} from "../../domain/mutation-journal.js";

const JOURNAL_COLUMNS = `operation_ref, cart_scope_ref, operation_kind, offer_ref, quantity_milli,
  source_grind_key_hash, request_hash, caller_identity, original_caller, operation_id, correlation_id, traceparent,
  state, reservation_owner, lease_until, provider_status_code, outcome_hash, failure_code,
  response_status, response_body_bytes, created_at, started_at, dispatched_at, completed_at, last_seen_at,
  retention_until`;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_FAILURE_CODES = new Set<MutationUnknownFailureCode>([
  "AROMA_PROVIDER_TIMEOUT",
  "AROMA_PROVIDER_DISCONNECT",
  "AROMA_PROVIDER_INVALID_RESPONSE",
  "AROMA_PROVIDER_UNAVAILABLE",
  "AROMA_PROVIDER_OUTCOME_UNKNOWN",
]);
const UNKNOWN_COMMIT_RECOVERY_TIMEOUT_MS = 1_000;
const MAX_TYPED_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TERMINAL_CLEANUP_LIMIT = 100;
const MAX_TERMINAL_CLEANUP_LIMIT = 1_000;

type JournalRow = Readonly<{
  operation_ref: unknown;
  cart_scope_ref: unknown;
  operation_kind: unknown;
  offer_ref: unknown;
  quantity_milli: unknown;
  source_grind_key_hash: unknown;
  request_hash: unknown;
  caller_identity: unknown;
  original_caller: unknown;
  operation_id: unknown;
  correlation_id: unknown;
  traceparent: unknown;
  state: unknown;
  reservation_owner: unknown;
  lease_until: unknown;
  provider_status_code: unknown;
  outcome_hash: unknown;
  failure_code: unknown;
  response_status: unknown;
  response_body_bytes: unknown;
  created_at: unknown;
  started_at: unknown;
  dispatched_at: unknown;
  completed_at: unknown;
  last_seen_at: unknown;
  retention_until: unknown;
}>;

type OperationRow = Readonly<{operation_ref: unknown}>;
type JournalStatement = (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<JournalRow>>;
type OperationStatement = (transaction: Transaction, parameters: readonly SqlScalar[]) => Promise<QueryResult<OperationRow>>;

export type ProviderMutationJournalRecord = Readonly<{
  operationRef: string;
  cartScopeRef: string;
  operationKind: "SetLineQuantity" | "RemoveLine";
  offerRef: string;
  quantityMilli: string | null;
  sourceGrindKeyHash: string | null;
  requestHash: string;
  callerIdentity: string;
  originalCaller: string;
  operationId: string;
  correlationId: string;
  traceparent: string | null;
  state: MutationJournalState;
  reservationOwner: string;
  leaseUntil: string;
  providerStatusCode: number | null;
  outcomeHash: string | null;
  failureCode: string | null;
  responseStatus: number | null;
  /** Gateway-generated typed response bytes; never a provider response body. */
  responseBodyBytes: Uint8Array | null;
  createdAt: string;
  startedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  lastSeenAt: string;
  retentionUntil: string;
}>;

function corrupt(): never {
  throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) corrupt();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

function timestamp(value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) corrupt();
    return value.toISOString();
  }
  return requiredString(value);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) corrupt();
  return value;
}

function nullableBytes(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > MAX_TYPED_RESPONSE_BYTES) corrupt();
  return new Uint8Array(value);
}

function quantity(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = typeof value === "bigint" ? value.toString() : typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^(0|[1-9][0-9]*)$/.test(normalized)) corrupt();
  try {
    if (BigInt(normalized) > 9_223_372_036_854_775_807n) corrupt();
  } catch {
    corrupt();
  }
  return normalized;
}

function journalState(value: unknown): MutationJournalState {
  if (value === "Reserved" || value === "Dispatched" || value === "Acknowledged" || value === "Rejected" || value === "UnknownOutcome") return value;
  corrupt();
}

function rowToRecord(row: JournalRow): ProviderMutationJournalRecord {
  const state = journalState(row.state);
  const operationKind = row.operation_kind;
  if (operationKind !== "SetLineQuantity" && operationKind !== "RemoveLine") corrupt();
  const responseStatus = nullableNumber(row.response_status);
  const providerStatusCode = nullableNumber(row.provider_status_code);
  const responseBodyBytes = nullableBytes(row.response_body_bytes);
  const requestHash = requiredString(row.request_hash);
  const sourceGrindKeyHash = nullableString(row.source_grind_key_hash);
  const outcomeHash = nullableString(row.outcome_hash);
  const failureCode = nullableString(row.failure_code);
  if (outcomeHash !== null && !HASH.test(outcomeHash)) corrupt();
  if (!HASH.test(requestHash)) corrupt();
  if (sourceGrindKeyHash !== null && !HASH.test(sourceGrindKeyHash)) corrupt();
  if (failureCode !== null && !FAILURE_CODE.test(failureCode)) corrupt();
  if (responseStatus !== null && (responseStatus < 100 || responseStatus > 599)) corrupt();
  if (providerStatusCode !== null && (providerStatusCode < 100 || providerStatusCode > 599)) corrupt();
  if ((state === "Acknowledged" || state === "Rejected") !== (responseBodyBytes !== null && responseStatus !== null && outcomeHash !== null)) corrupt();
  if ((state === "Rejected" || state === "UnknownOutcome") !== (failureCode !== null)) corrupt();
  if ((state === "Reserved" || state === "Dispatched" || state === "UnknownOutcome") && responseBodyBytes !== null) corrupt();
  return {
    operationRef: requiredString(row.operation_ref),
    cartScopeRef: requiredString(row.cart_scope_ref),
    operationKind,
    offerRef: requiredString(row.offer_ref),
    quantityMilli: quantity(row.quantity_milli),
    sourceGrindKeyHash,
    requestHash,
    callerIdentity: requiredString(row.caller_identity),
    originalCaller: requiredString(row.original_caller),
    operationId: requiredString(row.operation_id),
    correlationId: requiredString(row.correlation_id),
    traceparent: nullableString(row.traceparent),
    state,
    reservationOwner: requiredString(row.reservation_owner),
    leaseUntil: timestamp(row.lease_until),
    providerStatusCode,
    outcomeHash,
    failureCode,
    responseStatus,
    responseBodyBytes,
    createdAt: timestamp(row.created_at),
    startedAt: timestamp(row.started_at),
    dispatchedAt: row.dispatched_at === null || row.dispatched_at === undefined ? null : timestamp(row.dispatched_at),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : timestamp(row.completed_at),
    lastSeenAt: timestamp(row.last_seen_at),
    retentionUntil: timestamp(row.retention_until),
  };
}

function reservation(record: ProviderMutationJournalRecord): MutationReservation {
  return {
    operationRef: record.operationRef,
    requestHash: record.requestHash,
    reservationOwner: record.reservationOwner,
    leaseUntil: record.leaseUntil,
  };
}

function permit(record: ProviderMutationJournalRecord): DispatchPermit {
  return {
    operationRef: record.operationRef,
    requestHash: record.requestHash,
    reservationOwner: record.reservationOwner,
    ...(record.sourceGrindKeyHash === null ? {} : {sourceGrindKeyHash: record.sourceGrindKeyHash}),
  };
}

function terminal(record: ProviderMutationJournalRecord, replayed: boolean): MutationTerminalResult {
  if ((record.state !== "Acknowledged" && record.state !== "Rejected") || record.responseStatus === null || record.responseBodyBytes === null) corrupt();
  let expected: Readonly<{state: "Acknowledged" | "Rejected"; statusCode: number; failureCode?: string; operationRef?: string; cartScopeRef?: string; offerRef?: string; sourceGrindKeyHash?: string}>;
  if (record.state === "Acknowledged") {
    expected = {state: "Acknowledged", statusCode: record.responseStatus, operationRef: record.operationRef, cartScopeRef: record.cartScopeRef, offerRef: record.offerRef, ...(record.sourceGrindKeyHash === null ? {} : {sourceGrindKeyHash: record.sourceGrindKeyHash})};
  } else {
    if (record.failureCode === null) corrupt();
    expected = {state: "Rejected", statusCode: record.responseStatus, failureCode: record.failureCode};
  }
  if (!isValidGatewayMutationResponseBytes(record.responseBodyBytes, expected)) corrupt();
  const base = {
    state: record.state,
    statusCode: record.responseStatus,
    responseBodyBytes: new Uint8Array(record.responseBodyBytes),
    replayed,
    ...(record.providerStatusCode === null ? {} : {providerStatusCode: record.providerStatusCode}),
  } as const;
  if (record.state === "Rejected") {
    if (record.failureCode === null) corrupt();
    return {...base, state: "Rejected", failureCode: record.failureCode};
  }
  return {...base, state: "Acknowledged"};
}

function unknown(record: ProviderMutationJournalRecord | undefined, replayed: boolean, fallback = "AROMA_PROVIDER_OUTCOME_UNKNOWN"): MutationUnknownOutcomeResult {
  return {state: "UnknownOutcome", failureCode: record?.failureCode ?? fallback, replayed};
}

function sameRequest(record: ProviderMutationJournalRecord, request: NormalizedMutationRequest, delegation: MutationDelegation, requestHash: string): boolean {
  return record.requestHash === requestHash &&
    record.cartScopeRef === request.cartScopeRef &&
    record.operationKind === request.operationKind &&
    record.offerRef === request.offerRef &&
    record.quantityMilli === request.quantityMilli &&
    (record.sourceGrindKeyHash === null ? undefined : record.sourceGrindKeyHash) === request.sourceGrindKeyHash &&
    record.callerIdentity === delegation.callerIdentity &&
    record.originalCaller === delegation.originalCaller &&
    record.operationId === delegation.operationId;
}

function samePermit(record: ProviderMutationJournalRecord, value: DispatchPermit): boolean {
  // requestHash already commits to sourceGrindKeyHash; reservations/permits retain the legacy shape.
  return record.operationRef === value.operationRef && record.requestHash === value.requestHash && record.reservationOwner === value.reservationOwner;
}

function decisionForExisting(record: ProviderMutationJournalRecord, request: NormalizedMutationRequest, delegation: MutationDelegation, requestHash: string): ReservationDecision {
  if (!sameRequest(record, request, delegation, requestHash)) throw new MutationJournalError("AROMA_OPERATION_REF_CONFLICT");
  if (record.state === "Acknowledged" || record.state === "Rejected") return {kind: "Replay", outcome: terminal(record, true)};
  if (record.state === "UnknownOutcome") return {kind: "UnknownOutcome", outcome: unknown(record, true)};
  if (record.state === "Dispatched") return {kind: "UnknownOutcome", outcome: unknown(record, true)};
  return {kind: "InProgress", state: "Reserved", operationRef: record.operationRef};
}

function validateOwner(owner: string): void {
  if (!UUID.test(owner)) throw new MutationJournalError("AROMA_MUTATION_INVALID");
}

function validateLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > 86_400_000) throw new MutationJournalError("AROMA_MUTATION_INVALID");
}

function validateTerminalCleanupLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TERMINAL_CLEANUP_LIMIT) throw new MutationJournalError("AROMA_MUTATION_INVALID");
}

function validateResponseBytes(value: unknown, expected: Readonly<{state: "Acknowledged" | "Rejected"; statusCode: number; failureCode?: string; sourceGrindKeyHash?: string}>): Uint8Array {
  if (!isValidGatewayMutationResponseBytes(value, expected)) throw new MutationJournalError("AROMA_MUTATION_INVALID");
  return new Uint8Array(value);
}

function validateProviderStatus(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) throw new MutationJournalError("AROMA_MUTATION_INVALID");
  return value;
}

function terminalResultFromInput(result: MutationAcknowledged | MutationRejected, replayed: boolean, sourceGrindKeyHash?: string): MutationTerminalResult {
  const providerStatusCode = validateProviderStatus(result.providerStatusCode);
  if (result.state === "Acknowledged") {
    if (result.statusCode !== 200) throw new MutationJournalError("AROMA_MUTATION_INVALID");
    const responseBodyBytes = validateResponseBytes(result.responseBodyBytes, {state: "Acknowledged", statusCode: 200, ...(sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash})});
    return {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes,
      replayed,
      ...(providerStatusCode === null ? {} : {providerStatusCode}),
    };
  }
  if (!Number.isSafeInteger(result.statusCode) || result.statusCode < 400 || result.statusCode > 599 || !FAILURE_CODE.test(result.failureCode)) throw new MutationJournalError("AROMA_MUTATION_INVALID");
  const responseBodyBytes = validateResponseBytes(result.responseBodyBytes, {state: "Rejected", statusCode: result.statusCode, failureCode: result.failureCode});
  return {
    state: "Rejected",
    statusCode: result.statusCode,
    failureCode: result.failureCode,
    responseBodyBytes,
    replayed,
    ...(providerStatusCode === null ? {} : {providerStatusCode}),
  };
}

function safeFailureCode(value: MutationUnknownFailureCode): void {
  if (!SAFE_FAILURE_CODES.has(value)) throw new MutationJournalError("AROMA_MUTATION_INVALID");
}

function transactionOptions(signal?: AbortSignal): Readonly<{mode: "interactive"; signal?: AbortSignal}> {
  return signal === undefined ? {mode: "interactive"} : {mode: "interactive", signal};
}

function isUnknownCommit(error: unknown): boolean {
  return error instanceof DatabaseTransactionError && error.code === "TRANSACTION_OUTCOME_UNKNOWN";
}

function stateMetric(state: MutationJournalState): "reserved" | "dispatched" | "acknowledged" | "rejected" | "unknown" {
  if (state === "Reserved") return "reserved";
  if (state === "Dispatched") return "dispatched";
  if (state === "Acknowledged") return "acknowledged";
  if (state === "Rejected") return "rejected";
  return "unknown";
}

function decisionState(decision: ReservationDecision | DispatchDecision): "reserved" | "dispatched" | "acknowledged" | "rejected" | "unknown" {
  if (decision.kind === "Reserved") return "reserved";
  if (decision.kind === "DispatchPermitted") return "dispatched";
  if (decision.kind === "InProgress") return stateMetric(decision.state);
  if (decision.kind === "Replay") return stateMetric(decision.outcome.state);
  return "unknown";
}

function observeJournalState(telemetry: GatewayTelemetry | undefined, state: "reserved" | "dispatched" | "acknowledged" | "rejected" | "unknown"): void {
  telemetry?.metrics.result("journalState", state);
}

function observeTerminalOutcome(telemetry: GatewayTelemetry | undefined, result: MutationTerminalResult | MutationUnknownOutcomeResult): void {
  const state = stateMetric(result.state);
  observeJournalState(telemetry, state);
  if (state === "acknowledged") telemetry?.metrics.increment("mutationAcknowledged");
  else if (state === "rejected") telemetry?.metrics.increment("mutationRejected");
  else if (state === "unknown") telemetry?.metrics.increment("mutationUnknown");
}

function finishOperationSpan(span: ReturnType<GatewayTelemetry["startSpan"]> | undefined, operationRef: string, result: string, error?: unknown): void {
  if (span === undefined) return;
  span.setAttribute("operationRef", operationRef);
  span.setAttribute("result", result);
  finishGatewaySpan(span, error);
}

function observeDecisionOutcome(telemetry: GatewayTelemetry | undefined, operationRef: string, decision: ReservationDecision | DispatchDecision): void {
  if (decision.kind !== "Replay" && decision.kind !== "UnknownOutcome") return;
  observeTerminalOutcome(telemetry, decision.outcome);
  finishMutationOutcomeSpan(telemetry, operationRef, decision.outcome);
}

function finishMutationOutcomeSpan(telemetry: GatewayTelemetry | undefined, operationRef: string, result: MutationTerminalResult | MutationUnknownOutcomeResult, error?: unknown): void {
  const span = telemetry?.startSpan("aroma.gateway.mutation.outcome", {operationRef});
  finishOperationSpan(span, operationRef, stateMetric(result.state), error);
}

export class ProviderMutationJournalRepository {
  readonly #insertReservation: JournalStatement;
  readonly #takeoverReservation: JournalStatement;
  readonly #readJournal: JournalStatement;
  readonly #markDispatched: JournalStatement;
  readonly #acknowledge: JournalStatement;
  readonly #reject: JournalStatement;
  readonly #rejectReservation: JournalStatement;
  readonly #markUnknown: JournalStatement;
  readonly #recoverDispatched: OperationStatement;
  readonly #cleanupTerminal: OperationStatement;

  public constructor(database: Database) {
    this.#insertReservation = defineStatement(database, `INSERT INTO integration.provider_mutation_journal
      (operation_ref, cart_scope_ref, operation_kind, offer_ref, quantity_milli, source_grind_key_hash, request_hash,
       caller_identity, original_caller, operation_id, correlation_id, traceparent, state,
       reservation_owner, lease_until, created_at, started_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10, $11::uuid, $12, 'Reserved', $13::uuid,
        clock_timestamp() + ($14::bigint * interval '1 millisecond'), clock_timestamp(), clock_timestamp(), clock_timestamp())
      ON CONFLICT (operation_ref) DO NOTHING
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#takeoverReservation = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET reservation_owner = $2::uuid,
          lease_until = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
          last_seen_at = clock_timestamp()
      WHERE operation_ref = $1
        AND request_hash = $4
        AND caller_identity = $5
        AND original_caller = $6
        AND operation_id = $7
        AND operation_kind = $8
        AND offer_ref = $9
        AND quantity_milli IS NOT DISTINCT FROM $10::bigint
        AND source_grind_key_hash IS NOT DISTINCT FROM $11
        AND cart_scope_ref = $12
        AND state = 'Reserved'
        AND lease_until <= clock_timestamp()
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#readJournal = defineStatement(database, `SELECT ${JOURNAL_COLUMNS}
      FROM integration.provider_mutation_journal WHERE operation_ref = $1`);
    this.#markDispatched = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'Dispatched', dispatched_at = clock_timestamp(), last_seen_at = clock_timestamp()
      WHERE operation_ref = $1 AND request_hash = $2 AND reservation_owner = $3::uuid
        AND state = 'Reserved' AND lease_until > clock_timestamp()
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#acknowledge = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'Acknowledged', provider_status_code = $4::integer, outcome_hash = $5,
          response_status = $6::smallint, response_body_bytes = $7,
          completed_at = clock_timestamp(),
          retention_until = clock_timestamp() + INTERVAL '90 days',
          last_seen_at = clock_timestamp()
      WHERE operation_ref = $1 AND reservation_owner = $2::uuid AND request_hash = $3 AND state = 'Dispatched'
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#reject = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'Rejected', provider_status_code = $4::integer, outcome_hash = $5,
          failure_code = $6, response_status = $7::smallint, response_body_bytes = $8,
          completed_at = clock_timestamp(),
          retention_until = clock_timestamp() + INTERVAL '90 days',
          last_seen_at = clock_timestamp()
      WHERE operation_ref = $1 AND reservation_owner = $2::uuid AND request_hash = $3 AND state = 'Dispatched'
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#rejectReservation = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'Rejected', provider_status_code = $4::integer, outcome_hash = $5,
          failure_code = $6, response_status = $7::smallint, response_body_bytes = $8,
          dispatched_at = COALESCE(dispatched_at, started_at),
          completed_at = clock_timestamp(),
          retention_until = clock_timestamp() + INTERVAL '90 days',
          last_seen_at = clock_timestamp()
      WHERE operation_ref = $1 AND reservation_owner = $2::uuid AND request_hash = $3 AND state = 'Reserved'
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#markUnknown = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'UnknownOutcome', failure_code = $4,
          completed_at = clock_timestamp(),
          retention_until = clock_timestamp() + INTERVAL '90 days',
          last_seen_at = clock_timestamp()
      WHERE operation_ref = $1 AND reservation_owner = $2::uuid AND request_hash = $3 AND state = 'Dispatched'
      RETURNING ${JOURNAL_COLUMNS}`);
    this.#recoverDispatched = defineStatement(database, `UPDATE integration.provider_mutation_journal
      SET state = 'UnknownOutcome', failure_code = $2,
          completed_at = COALESCE(completed_at, clock_timestamp()),
          retention_until = clock_timestamp() + INTERVAL '90 days',
          last_seen_at = clock_timestamp()
      WHERE state = 'Dispatched' AND dispatched_at IS NOT NULL
        AND ($1::timestamptz IS NULL OR dispatched_at < $1::timestamptz)
      RETURNING operation_ref`);
    this.#cleanupTerminal = defineStatement(database, `WITH candidates AS (
        SELECT operation_ref
        FROM integration.provider_mutation_journal
        WHERE state IN ('Acknowledged', 'Rejected', 'UnknownOutcome')
          AND retention_until <= clock_timestamp()
        ORDER BY retention_until, operation_ref
        FOR UPDATE SKIP LOCKED
        LIMIT $1::integer
      )
      DELETE FROM integration.provider_mutation_journal AS journal
      USING candidates
      WHERE journal.operation_ref = candidates.operation_ref
      RETURNING journal.operation_ref`);
  }

  public async read(transaction: Transaction, operationRef: string): Promise<ProviderMutationJournalRecord | undefined> {
    const result = await this.#readJournal(transaction, [operationRef]);
    const row = result.rows[0];
    return row === undefined ? undefined : rowToRecord(row);
  }

  public async reserve(
    transaction: Transaction,
    request: MutationRequest,
    delegation: MutationDelegation,
    reservationOwner: string,
    leaseMs: number,
  ): Promise<ReservationDecision> {
    const normalized = normalizeMutationRequest(request);
    assertMutationDelegation(normalized, delegation);
    validateOwner(reservationOwner);
    validateLease(leaseMs);
    const requestHash = canonicalMutationRequestHash(normalized, delegation);
    const parameters: readonly SqlScalar[] = [
      normalized.operationRef,
      normalized.cartScopeRef,
      normalized.operationKind,
      normalized.offerRef,
      normalized.quantityMilli,
      normalized.sourceGrindKeyHash ?? null,
      requestHash,
      delegation.callerIdentity,
      delegation.originalCaller,
      delegation.operationId,
      delegation.correlationId,
      delegation.traceparent ?? null,
      reservationOwner,
      leaseMs,
    ];
    const inserted = (await this.#insertReservation(transaction, parameters)).rows[0];
    if (inserted !== undefined) return {kind: "Reserved", reservation: reservation(rowToRecord(inserted))};
    const existing = await this.read(transaction, normalized.operationRef);
    if (existing === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    if (existing.state === "Reserved") {
      const takeover = await this.#takeoverReservation(transaction, [
        normalized.operationRef,
        reservationOwner,
        leaseMs,
        requestHash,
        delegation.callerIdentity,
        delegation.originalCaller,
        delegation.operationId,
        normalized.operationKind,
        normalized.offerRef,
        normalized.quantityMilli,
        normalized.sourceGrindKeyHash ?? null,
        normalized.cartScopeRef,
      ]);
      const takeoverRow = takeover.rows[0];
      if (takeoverRow !== undefined) return {kind: "Reserved", reservation: reservation(rowToRecord(takeoverRow))};
    }
    const current = await this.read(transaction, normalized.operationRef);
    if (current === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    return decisionForExisting(current, normalized, delegation, requestHash);
  }

  public async markDispatched(transaction: Transaction, value: MutationReservation): Promise<DispatchDecision> {
    validateOwner(value.reservationOwner);
    const updated = await this.#markDispatched(transaction, [value.operationRef, value.requestHash, value.reservationOwner]);
    const updatedRow = updated.rows[0];
    if (updatedRow !== undefined) return {kind: "DispatchPermitted", permit: permit(rowToRecord(updatedRow))};
    const current = await this.read(transaction, value.operationRef);
    if (current === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    if (!samePermit(current, value)) throw new MutationJournalError("AROMA_RESERVATION_LOST");
    if (current.state === "Acknowledged" || current.state === "Rejected") return {kind: "Replay", outcome: terminal(current, true)};
    if (current.state === "UnknownOutcome" || current.state === "Dispatched") return {kind: "UnknownOutcome", outcome: unknown(current, true)};
    return {kind: "InProgress", state: "Reserved", operationRef: current.operationRef};
  }

  public async acknowledge(transaction: Transaction, value: DispatchPermit, result: MutationAcknowledged): Promise<MutationTerminalResult> {
    validateOwner(value.reservationOwner);
    const validated = terminalResultFromInput(result, false, value.sourceGrindKeyHash);
    const updated = await this.#acknowledge(transaction, [
      value.operationRef,
      value.reservationOwner,
      value.requestHash,
      validated.providerStatusCode ?? null,
      typedResponseHash(validated.responseBodyBytes),
      validated.statusCode,
      validated.responseBodyBytes,
    ]);
    if (updated.rows[0] !== undefined) return validated;
    return this.#resolveTerminalRace(transaction, value);
  }

  public async reject(transaction: Transaction, value: DispatchPermit, result: MutationRejected): Promise<MutationTerminalResult> {
    validateOwner(value.reservationOwner);
    const validated = terminalResultFromInput(result, false);
    if (validated.state !== "Rejected" || validated.failureCode === undefined) throw new MutationJournalError("AROMA_MUTATION_INVALID");
    const updated = await this.#reject(transaction, [
      value.operationRef,
      value.reservationOwner,
      value.requestHash,
      validated.providerStatusCode ?? null,
      typedResponseHash(validated.responseBodyBytes),
      validated.failureCode,
      validated.statusCode,
      validated.responseBodyBytes,
    ]);
    if (updated.rows[0] !== undefined) return validated;
    return this.#resolveTerminalRace(transaction, value);
  }

  public async rejectReservation(transaction: Transaction, value: MutationReservation, result: MutationRejected): Promise<MutationTerminalResult | MutationUnknownOutcomeResult> {
    validateOwner(value.reservationOwner);
    const validated = terminalResultFromInput(result, false);
    if (validated.state !== "Rejected" || validated.failureCode === undefined) throw new MutationJournalError("AROMA_MUTATION_INVALID");
    const updated = await this.#rejectReservation(transaction, [
      value.operationRef,
      value.reservationOwner,
      value.requestHash,
      validated.providerStatusCode ?? null,
      typedResponseHash(validated.responseBodyBytes),
      validated.failureCode,
      validated.statusCode,
      validated.responseBodyBytes,
    ]);
    if (updated.rows[0] !== undefined) return validated;
    const current = await this.read(transaction, value.operationRef);
    if (current === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    if (!samePermit(current, value)) throw new MutationJournalError("AROMA_RESERVATION_LOST");
    if (current.state === "Acknowledged" || current.state === "Rejected") return terminal(current, true);
    if (current.state === "UnknownOutcome" || current.state === "Dispatched") return unknown(current, true);
    throw new MutationJournalError("AROMA_RESERVATION_LOST");
  }

  public async markUnknown(transaction: Transaction, value: DispatchPermit, failureCode: MutationUnknownFailureCode): Promise<MutationUnknownOutcomeResult | MutationTerminalResult> {
    validateOwner(value.reservationOwner);
    safeFailureCode(failureCode);
    const updated = await this.#markUnknown(transaction, [value.operationRef, value.reservationOwner, value.requestHash, failureCode]);
    if (updated.rows[0] !== undefined) return {state: "UnknownOutcome", failureCode, replayed: false};
    const current = await this.read(transaction, value.operationRef);
    if (current === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    if (!samePermit(current, value)) throw new MutationJournalError("AROMA_RESERVATION_LOST");
    if (current.state === "UnknownOutcome" || current.state === "Dispatched") return unknown(current, true);
    if (current.state === "Acknowledged" || current.state === "Rejected") return terminal(current, true);
    throw new MutationJournalError("AROMA_RESERVATION_LOST");
  }

  public async recoverStaleDispatched(transaction: Transaction, cutoff: string | null, failureCode: MutationUnknownFailureCode = "AROMA_PROVIDER_OUTCOME_UNKNOWN"): Promise<number> {
    safeFailureCode(failureCode);
    const result = await this.#recoverDispatched(transaction, [cutoff, failureCode]);
    return result.rowCount;
  }

  public async cleanupTerminal(transaction: Transaction, limit: number): Promise<number> {
    validateTerminalCleanupLimit(limit);
    const result = await this.#cleanupTerminal(transaction, [limit]);
    return result.rowCount;
  }

  async #resolveTerminalRace(transaction: Transaction, value: DispatchPermit): Promise<MutationTerminalResult> {
    const current = await this.read(transaction, value.operationRef);
    if (current === undefined) throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    if (!samePermit(current, value)) throw new MutationJournalError("AROMA_RESERVATION_LOST");
    if (current.state === "Acknowledged" || current.state === "Rejected") return terminal(current, true);
    if (current.state === "UnknownOutcome") throw new MutationJournalError("AROMA_OPERATION_UNKNOWN_OUTCOME");
    throw new MutationJournalError("AROMA_RESERVATION_LOST");
  }
}

export type ProviderMutationJournalStoreOptions = Readonly<{
  reservationOwner?: string;
  leaseMs?: number;
  telemetry?: GatewayTelemetry;
}>;

export class ProviderMutationJournalStore implements MutationJournalPort {
  readonly #database: Database;
  readonly #repository: ProviderMutationJournalRepository;
  readonly #reservationOwner: string;
  readonly #leaseMs: number;
  readonly #telemetry: GatewayTelemetry | undefined;

  public constructor(database: Database, options: ProviderMutationJournalStoreOptions = {}) {
    this.#database = database;
    this.#repository = new ProviderMutationJournalRepository(database);
    this.#reservationOwner = options.reservationOwner ?? randomUUID();
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#telemetry = options.telemetry;
    validateOwner(this.#reservationOwner);
    validateLease(this.#leaseMs);
  }

  public get reservationOwner(): string {
    return this.#reservationOwner;
  }

  async #rereadAfterUnknownCommit(operationRef: string): Promise<ProviderMutationJournalRecord | undefined> {
    try {
      return await withTransaction(this.#database, transactionOptions(AbortSignal.timeout(UNKNOWN_COMMIT_RECOVERY_TIMEOUT_MS)), transaction => this.#repository.read(transaction, operationRef));
    } catch {
      return undefined;
    }
  }

  async #recoverOutcome(operationRef: string, expectedPermit?: DispatchPermit, fallback?: MutationUnknownFailureCode): Promise<MutationTerminalResult | MutationUnknownOutcomeResult> {
    const record = await this.#rereadAfterUnknownCommit(operationRef);
    if (record === undefined || (expectedPermit !== undefined && !samePermit(record, expectedPermit))) return unknown(undefined, true, fallback);
    if (record.state === "Acknowledged" || record.state === "Rejected") {
      try {
        return terminal(record, true);
      } catch {
        return unknown(undefined, true, fallback);
      }
    }
    return unknown(record, true, fallback);
  }

  async #recoverReservationOutcome(request: NormalizedMutationRequest, delegation: MutationDelegation): Promise<ReservationDecision> {
    const record = await this.#rereadAfterUnknownCommit(request.operationRef);
    if (record === undefined) return {kind: "UnknownOutcome", outcome: unknown(undefined, true)};
    return decisionForExisting(record, request, delegation, canonicalMutationRequestHash(request, delegation));
  }

  public async reserve(request: NormalizedMutationRequest, delegation: MutationDelegation, signal?: AbortSignal): Promise<ReservationDecision> {
    const normalized = normalizeMutationRequest(request);
    assertMutationDelegation(normalized, delegation);
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.acquire", {operationRef: normalized.operationRef});
    try {
      let outcome: ReservationDecision;
      try {
        outcome = await withTransaction(this.#database, {
          ...transactionOptions(signal),
          correlationId: delegation.correlationId,
          ...(delegation.traceparent === undefined ? {} : {traceparent: delegation.traceparent}),
        }, transaction => this.#repository.reserve(transaction, normalized, delegation, this.#reservationOwner, this.#leaseMs));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        outcome = await this.#recoverReservationOutcome(normalized, delegation);
      }
      this.#telemetry?.metrics.increment("journalAcquire");
      const state = decisionState(outcome);
      observeJournalState(this.#telemetry, state);
      observeDecisionOutcome(this.#telemetry, normalized.operationRef, outcome);
      finishOperationSpan(span, normalized.operationRef, state);
      return outcome;
    } catch (error) {
      this.#telemetry?.metrics.increment("journalAcquire");
      finishOperationSpan(span, normalized.operationRef, "unknown", error);
      throw error;
    }
  }

  public async markDispatched(value: MutationReservation, signal?: AbortSignal): Promise<DispatchDecision> {
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.dispatch", {operationRef: value.operationRef});
    try {
      let outcome: DispatchDecision;
      try {
        outcome = await withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.markDispatched(transaction, value));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        const recovered = await this.#recoverOutcome(value.operationRef, value);
        outcome = recovered.state === "UnknownOutcome" ? {kind: "UnknownOutcome", outcome: recovered} : {kind: "Replay", outcome: recovered};
      }
      this.#telemetry?.metrics.increment("journalDispatch");
      const state = decisionState(outcome);
      observeJournalState(this.#telemetry, state);
      observeDecisionOutcome(this.#telemetry, value.operationRef, outcome);
      finishOperationSpan(span, value.operationRef, state);
      return outcome;
    } catch (error) {
      this.#telemetry?.metrics.increment("journalDispatch");
      finishOperationSpan(span, value.operationRef, "unknown", error);
      throw error;
    }
  }

  public async acknowledge(value: DispatchPermit, result: MutationAcknowledged, signal?: AbortSignal): Promise<MutationTerminalResult | MutationUnknownOutcomeResult> {
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.terminal_persistence", {operationRef: value.operationRef});
    try {
      let outcome: MutationTerminalResult | MutationUnknownOutcomeResult;
      try {
        outcome = await withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.acknowledge(transaction, value, result));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        outcome = await this.#recoverOutcome(value.operationRef, value);
      }
      observeTerminalOutcome(this.#telemetry, outcome);
      this.#telemetry?.metrics.increment("journalTerminalPersistence");
      finishOperationSpan(span, value.operationRef, stateMetric(outcome.state));
      finishMutationOutcomeSpan(this.#telemetry, value.operationRef, outcome);
      return outcome;
    } catch (error) {
      finishOperationSpan(span, value.operationRef, "unknown", error);
      throw error;
    }
  }

  public async reject(value: DispatchPermit, result: MutationRejected, signal?: AbortSignal): Promise<MutationTerminalResult | MutationUnknownOutcomeResult> {
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.terminal_persistence", {operationRef: value.operationRef});
    try {
      let outcome: MutationTerminalResult | MutationUnknownOutcomeResult;
      try {
        outcome = await withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.reject(transaction, value, result));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        outcome = await this.#recoverOutcome(value.operationRef, value);
      }
      observeTerminalOutcome(this.#telemetry, outcome);
      this.#telemetry?.metrics.increment("journalTerminalPersistence");
      finishOperationSpan(span, value.operationRef, stateMetric(outcome.state));
      finishMutationOutcomeSpan(this.#telemetry, value.operationRef, outcome);
      return outcome;
    } catch (error) {
      finishOperationSpan(span, value.operationRef, "unknown", error);
      throw error;
    }
  }

  public async rejectReservation(value: MutationReservation, result: MutationRejected, signal?: AbortSignal): Promise<MutationTerminalResult | MutationUnknownOutcomeResult> {
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.terminal_persistence", {operationRef: value.operationRef});
    try {
      let outcome: MutationTerminalResult | MutationUnknownOutcomeResult;
      try {
        outcome = await withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.rejectReservation(transaction, value, result));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        outcome = await this.#recoverOutcome(value.operationRef, value);
      }
      observeTerminalOutcome(this.#telemetry, outcome);
      this.#telemetry?.metrics.increment("journalTerminalPersistence");
      finishOperationSpan(span, value.operationRef, stateMetric(outcome.state));
      finishMutationOutcomeSpan(this.#telemetry, value.operationRef, outcome);
      return outcome;
    } catch (error) {
      finishOperationSpan(span, value.operationRef, "unknown", error);
      throw error;
    }
  }

  public async markUnknown(value: DispatchPermit, failureCode: MutationUnknownFailureCode, signal?: AbortSignal): Promise<MutationUnknownOutcomeResult | MutationTerminalResult> {
    const span = this.#telemetry?.startSpan("aroma.gateway.journal.terminal_persistence", {operationRef: value.operationRef});
    try {
      let outcome: MutationUnknownOutcomeResult | MutationTerminalResult;
      try {
        outcome = await withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.markUnknown(transaction, value, failureCode));
      } catch (error) {
        if (!isUnknownCommit(error)) throw error;
        outcome = await this.#recoverOutcome(value.operationRef, value, failureCode);
      }
      observeTerminalOutcome(this.#telemetry, outcome);
      this.#telemetry?.metrics.increment("journalTerminalPersistence");
      finishOperationSpan(span, value.operationRef, stateMetric(outcome.state));
      finishMutationOutcomeSpan(this.#telemetry, value.operationRef, outcome);
      return outcome;
    } catch (error) {
      finishOperationSpan(span, value.operationRef, "unknown", error);
      throw error;
    }
  }

  public async recoverAfterRestart(cutoff?: string, signal?: AbortSignal): Promise<number> {
    if (cutoff !== undefined && !ISO_TIMESTAMP.test(cutoff)) throw new MutationJournalError("AROMA_MUTATION_INVALID");
    return withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.recoverStaleDispatched(transaction, cutoff ?? null));
  }

  public async recoverStaleDispatched(cutoff?: string, signal?: AbortSignal): Promise<number> {
    return this.recoverAfterRestart(cutoff, signal);
  }

  public async cleanupTerminal(limit = DEFAULT_TERMINAL_CLEANUP_LIMIT, signal?: AbortSignal): Promise<number> {
    validateTerminalCleanupLimit(limit);
    return withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.cleanupTerminal(transaction, limit));
  }

  public async get(operationRef: string, signal?: AbortSignal): Promise<ProviderMutationJournalRecord | undefined> {
    return withTransaction(this.#database, transactionOptions(signal), transaction => this.#repository.read(transaction, operationRef));
  }

  public async read(operationRef: string, signal?: AbortSignal): Promise<ProviderMutationJournalRecord | undefined> {
    return this.get(operationRef, signal);
  }

  public get repository(): ProviderMutationJournalRepository {
    return this.#repository;
  }
}
