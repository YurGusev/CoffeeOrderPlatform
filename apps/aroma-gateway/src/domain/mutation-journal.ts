import { createHash } from "node:crypto";
import {
  isAromaMutationResponse,
  isAromaProblem,
} from "@coffee-platform/contracts-aroma-v1";

export type MutationOperationKind = "SetLineQuantity" | "RemoveLine";
export type MutationJournalState =
  "Reserved" | "Dispatched" | "Acknowledged" | "Rejected" | "UnknownOutcome";
export type MutationQuantity = string | number | bigint | null;

export type MutationRequest = Readonly<{
  operationRef: string;
  cartScopeRef: string;
  operationKind: MutationOperationKind;
  offerRef: string;
  quantityMilli?: MutationQuantity;
  sourceGrindKeyHash?: string;
}>;

/** Claims are supplied only after the transport/delegation verifier has run. */
export type MutationDelegation = Readonly<{
  transportCaller: string;
  issuer: string;
  audience: string;
  originalCaller: string;
  operationId: string;
  callerIdentity: string;
  correlationId: string;
  traceparent?: string;
}>;

export type NormalizedMutationRequest = Readonly<{
  operationRef: string;
  cartScopeRef: string;
  operationKind: MutationOperationKind;
  offerRef: string;
  quantityMilli: string | null;
  sourceGrindKeyHash?: string;
}>;

export type MutationJournalErrorCode =
  | "AROMA_MUTATION_INVALID"
  | "SERVICE_DELEGATION_INVALID"
  | "AROMA_OPERATION_REF_CONFLICT"
  | "AROMA_OPERATION_IN_PROGRESS"
  | "AROMA_OPERATION_UNKNOWN_OUTCOME"
  | "AROMA_RESERVATION_LOST"
  | "AROMA_JOURNAL_CORRUPT";

export class MutationJournalError extends Error {
  public readonly code: MutationJournalErrorCode;

  public constructor(code: MutationJournalErrorCode) {
    super(code);
    this.name = "MutationJournalError";
    this.code = code;
  }
}

export type MutationReservation = Readonly<{
  operationRef: string;
  requestHash: string;
  reservationOwner: string;
  leaseUntil: string;
}>;

export type DispatchPermit = Readonly<{
  operationRef: string;
  requestHash: string;
  reservationOwner: string;
  sourceGrindKeyHash?: string;
}>;

/** Bytes are the Gateway's bounded typed reply, never a raw provider body. */
export type MutationAcknowledged = Readonly<{
  state: "Acknowledged";
  statusCode: 200;
  responseBodyBytes: Uint8Array;
  providerStatusCode?: number;
}>;

export type MutationRejected = Readonly<{
  state: "Rejected";
  statusCode: number;
  failureCode: string;
  responseBodyBytes: Uint8Array;
  providerStatusCode?: number;
}>;

export type UnsafeMutationResult = MutationAcknowledged | MutationRejected;

export type MutationTerminalResult = Readonly<{
  state: "Acknowledged" | "Rejected";
  statusCode: number;
  responseBodyBytes: Uint8Array;
  failureCode?: string;
  providerStatusCode?: number;
  replayed: boolean;
}>;

export type MutationUnknownOutcomeResult = Readonly<{
  state: "UnknownOutcome";
  failureCode: string;
  replayed: boolean;
}>;

export type MutationInProgressResult = Readonly<{
  state: "Reserved" | "Dispatched";
  operationRef: string;
}>;

export type MutationExecutionResult =
  | MutationTerminalResult
  | MutationUnknownOutcomeResult
  | MutationInProgressResult;

export type ReservationDecision =
  | Readonly<{ kind: "Reserved"; reservation: MutationReservation }>
  | Readonly<{ kind: "Replay"; outcome: MutationTerminalResult }>
  | Readonly<{
      kind: "InProgress";
      state: "Reserved" | "Dispatched";
      operationRef: string;
    }>
  | Readonly<{ kind: "UnknownOutcome"; outcome: MutationUnknownOutcomeResult }>;

export type DispatchDecision =
  | Readonly<{ kind: "DispatchPermitted"; permit: DispatchPermit }>
  | Readonly<{ kind: "Replay"; outcome: MutationTerminalResult }>
  | Readonly<{
      kind: "InProgress";
      state: "Reserved" | "Dispatched";
      operationRef: string;
    }>
  | Readonly<{ kind: "UnknownOutcome"; outcome: MutationUnknownOutcomeResult }>;

export type MutationUnknownFailureCode =
  | "AROMA_PROVIDER_TIMEOUT"
  | "AROMA_PROVIDER_DISCONNECT"
  | "AROMA_PROVIDER_INVALID_RESPONSE"
  | "AROMA_PROVIDER_UNAVAILABLE"
  | "AROMA_PROVIDER_OUTCOME_UNKNOWN";

export type MutationJournalPort = Readonly<{
  reserve: (
    request: NormalizedMutationRequest,
    delegation: MutationDelegation,
    signal?: AbortSignal,
  ) => Promise<ReservationDecision>;
  /** Persist a known safe-preparation rejection while the row is still Reserved. */
  rejectReservation?: (
    reservation: MutationReservation,
    result: MutationRejected,
    signal?: AbortSignal,
  ) => Promise<MutationTerminalResult | MutationUnknownOutcomeResult>;
  markDispatched: (
    reservation: MutationReservation,
    signal?: AbortSignal,
  ) => Promise<DispatchDecision>;
  acknowledge: (
    permit: DispatchPermit,
    result: MutationAcknowledged,
    signal?: AbortSignal,
  ) => Promise<MutationTerminalResult | MutationUnknownOutcomeResult>;
  reject: (
    permit: DispatchPermit,
    result: MutationRejected,
    signal?: AbortSignal,
  ) => Promise<MutationTerminalResult | MutationUnknownOutcomeResult>;
  markUnknown: (
    permit: DispatchPermit,
    failureCode: MutationUnknownFailureCode,
    signal?: AbortSignal,
  ) => Promise<MutationUnknownOutcomeResult | MutationTerminalResult>;
}>;

export type ProviderUnsafeMutator = (
  request: NormalizedMutationRequest,
  permit: DispatchPermit,
  signal: AbortSignal,
  preparation?: unknown,
) => Promise<UnsafeMutationResult>;
export type ProviderMutationPreparer = (
  request: NormalizedMutationRequest,
  signal: AbortSignal,
) => Promise<unknown>;
/** Internal handoff used by ProviderCartMutator without widening the transport seam. */
export const PROVIDER_MUTATION_PREPARER = Symbol("provider-mutation-preparer");
export type PreparedProviderUnsafeMutator = ProviderUnsafeMutator & {
  readonly [PROVIDER_MUTATION_PREPARER]?: ProviderMutationPreparer;
};
/** @deprecated compatibility alias for existing unit seams; production never uses a test implementation. */
export type TestOnlyUnsafeProviderMutator = ProviderUnsafeMutator;

/** The only response bodies allowed to cross the unsafe provider seam. */
export type GatewayMutationResponseExpectation = Readonly<{
  state: "Acknowledged" | "Rejected";
  statusCode: number;
  failureCode?: string;
  operationRef?: string;
  cartScopeRef?: string;
  offerRef?: string;
  sourceGrindKeyHash?: string;
}>;

const OPERATION_REF = /^op_[0-9A-HJKMNP-TV-Z]{26}$/;
const OFFER_REF = /^off_[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const QUANTITY = /^(0|[1-9][0-9]*)$/;
const SAFE_SERVICE_IDENTITY = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_OPERATION_ID = /^[A-Za-z][A-Za-z0-9]{0,127}$/;
const SOURCE_GRIND_KEY_HASH = /^[a-f0-9]{64}$/;
// Technical dispatch cap: ProviderCartMutator converts the admitted package/piece count to Number.
// This is not a provider inventory maximum.
const MAX_QUANTITY = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_TYPED_RESPONSE_BYTES = 64 * 1024;
const FAILURE_CODES = new Set<MutationUnknownFailureCode>([
  "AROMA_PROVIDER_TIMEOUT",
  "AROMA_PROVIDER_DISCONNECT",
  "AROMA_PROVIDER_INVALID_RESPONSE",
  "AROMA_PROVIDER_UNAVAILABLE",
  "AROMA_PROVIDER_OUTCOME_UNKNOWN",
]);

function invalid(): never {
  throw new MutationJournalError("AROMA_MUTATION_INVALID");
}

function invalidDelegation(): never {
  throw new MutationJournalError("SERVICE_DELEGATION_INVALID");
}

function normalizeQuantity(value: MutationQuantity | undefined): string {
  if (value === null || value === undefined) invalid();
  const normalized =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? Number.isSafeInteger(value) && value >= 0
          ? String(value)
          : ""
        : value;
  if (typeof normalized !== "string" || !QUANTITY.test(normalized)) invalid();
  const quantity = BigInt(normalized);
  if (quantity <= 0n || quantity > MAX_QUANTITY) invalid();
  return normalized;
}

export function normalizeMutationRequest(
  request: MutationRequest,
): NormalizedMutationRequest {
  if (request === null || typeof request !== "object") invalid();
  if (
    !OPERATION_REF.test(request.operationRef) ||
    !OFFER_REF.test(request.offerRef) ||
    request.cartScopeRef !== "aroma-primary"
  )
    invalid();
  if (
    request.operationKind !== "SetLineQuantity" &&
    request.operationKind !== "RemoveLine"
  )
    invalid();
  const quantityMilli =
    request.operationKind === "RemoveLine"
      ? request.quantityMilli === undefined || request.quantityMilli === null
        ? null
        : invalid()
      : normalizeQuantity(request.quantityMilli);
  if (
    request.sourceGrindKeyHash !== undefined &&
    (typeof request.sourceGrindKeyHash !== "string" ||
      !SOURCE_GRIND_KEY_HASH.test(request.sourceGrindKeyHash))
  )
    invalid();
  return {
    operationRef: request.operationRef,
    cartScopeRef: request.cartScopeRef,
    operationKind: request.operationKind,
    offerRef: request.offerRef,
    quantityMilli,
    ...(request.sourceGrindKeyHash === undefined
      ? {}
      : { sourceGrindKeyHash: request.sourceGrindKeyHash }),
  };
}

function expectedOperationId(operationKind: MutationOperationKind): string {
  return operationKind === "SetLineQuantity"
    ? "setAromaCartLineQuantity"
    : "removeAromaCartLine";
}

/** Exact allowlist for the mutation capability. This runs before any reserve SQL. */
export function assertMutationDelegation(
  request: MutationRequest | NormalizedMutationRequest,
  delegation: MutationDelegation,
): void {
  if (delegation === null || typeof delegation !== "object")
    invalidDelegation();
  const normalized = normalizeMutationRequest(request);
  if (
    !SAFE_SERVICE_IDENTITY.test(delegation.transportCaller) ||
    !SAFE_SERVICE_IDENTITY.test(delegation.callerIdentity) ||
    !SAFE_OPERATION_ID.test(delegation.operationId) ||
    !UUID.test(delegation.correlationId) ||
    (delegation.traceparent !== undefined &&
      !TRACEPARENT.test(delegation.traceparent)) ||
    delegation.transportCaller !== "api-internal" ||
    delegation.callerIdentity !== "api-internal" ||
    delegation.issuer !== "api-internal" ||
    delegation.audience !== "aroma-gateway" ||
    delegation.originalCaller !== "aroma-convergence" ||
    delegation.operationId !== expectedOperationId(normalized.operationKind)
  )
    invalidDelegation();
}

export function canonicalMutationRequest(
  request: MutationRequest | NormalizedMutationRequest,
  delegation: MutationDelegation,
): string {
  const normalized = normalizeMutationRequest(request);
  const base = [
    "aroma-gateway-mutation-v1",
    normalized.cartScopeRef,
    normalized.operationKind,
    normalized.offerRef,
    normalized.quantityMilli,
    delegation.callerIdentity,
    delegation.originalCaller,
    delegation.operationId,
  ];
  return JSON.stringify(
    normalized.sourceGrindKeyHash === undefined
      ? base
      : [...base, normalized.sourceGrindKeyHash],
  );
}

export function canonicalMutationRequestHash(
  request: MutationRequest | NormalizedMutationRequest,
  delegation: MutationDelegation,
): string {
  return createHash("sha256")
    .update(canonicalMutationRequest(request, delegation), "utf8")
    .digest("hex");
}

export function typedResponseHash(responseBodyBytes: Uint8Array): string {
  return createHash("sha256").update(responseBodyBytes).digest("hex");
}

class InvalidTypedMutationResponseError extends Error {
  public readonly code = "AROMA_PROVIDER_INVALID_RESPONSE" as const;

  public constructor() {
    super("invalid typed mutation response");
    this.name = "InvalidTypedMutationResponseError";
  }
}

function invalidTypedMutationResponse(): never {
  throw new InvalidTypedMutationResponseError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validFailureCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
}

function decodeResponseBody(value: unknown): unknown {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > MAX_TYPED_RESPONSE_BYTES
  )
    return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
  } catch {
    return undefined;
  }
}

/** Validate generated internal-v1 schemas, then only operation/result correspondence. */
export function isValidGatewayMutationResponseBytes(
  value: unknown,
  expected: GatewayMutationResponseExpectation,
): value is Uint8Array {
  const body = decodeResponseBody(value);
  if (body === undefined) return false;
  if (expected.state === "Acknowledged") {
    if (!isAromaMutationResponse(body) || expected.statusCode !== 200)
      return false;
    const bodyRecord = body as Record<string, unknown>;
    const responseGrind = bodyRecord["sourceGrindKeyHash"];
    if (
      expected.sourceGrindKeyHash === undefined
        ? responseGrind !== undefined
        : responseGrind !== expected.sourceGrindKeyHash
    )
      return false;
    return (
      (expected.operationRef === undefined ||
        body.operationRef === expected.operationRef) &&
      (expected.cartScopeRef === undefined ||
        body.cartScopeRef === expected.cartScopeRef) &&
      (expected.offerRef === undefined || body.offerRef === expected.offerRef)
    );
  }
  if (!isAromaProblem(body)) return false;
  return (
    body.status === expected.statusCode &&
    (expected.failureCode === undefined || body.code === expected.failureCode)
  );
}

function providerStatus(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 100 ||
    value > 599
  )
    invalidTypedMutationResponse();
  return value;
}

function validateUnsafeMutationResult(
  value: unknown,
  request: NormalizedMutationRequest,
): UnsafeMutationResult {
  if (!isRecord(value)) invalidTypedMutationResponse();
  const providerStatusCode = providerStatus(value["providerStatusCode"]);
  const state = value["state"];
  const statusCode = value["statusCode"];
  const failureCodeValue = value["failureCode"];
  if (state === "Acknowledged" && statusCode === 200) {
    const responseBodyBytes = value["responseBodyBytes"];
    if (
      !isValidGatewayMutationResponseBytes(responseBodyBytes, {
        state: "Acknowledged",
        statusCode: 200,
        operationRef: request.operationRef,
        cartScopeRef: request.cartScopeRef,
        offerRef: request.offerRef,
        ...(request.sourceGrindKeyHash === undefined
          ? {}
          : { sourceGrindKeyHash: request.sourceGrindKeyHash }),
      })
    )
      invalidTypedMutationResponse();
    return {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: new Uint8Array(responseBodyBytes),
      ...(providerStatusCode === undefined ? {} : { providerStatusCode }),
    };
  }
  if (
    state === "Rejected" &&
    typeof statusCode === "number" &&
    Number.isSafeInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599 &&
    validFailureCode(failureCodeValue)
  ) {
    const responseBodyBytes = value["responseBodyBytes"];
    if (
      !isValidGatewayMutationResponseBytes(responseBodyBytes, {
        state: "Rejected",
        statusCode,
        failureCode: failureCodeValue,
      })
    )
      invalidTypedMutationResponse();
    return {
      state: "Rejected",
      statusCode,
      failureCode: failureCodeValue,
      responseBodyBytes: new Uint8Array(responseBodyBytes),
      ...(providerStatusCode === undefined ? {} : { providerStatusCode }),
    };
  }
  invalidTypedMutationResponse();
}

function failureCode(error: unknown): MutationUnknownFailureCode {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ProviderDecodeInvalid" || code === "ProviderDecodeIncomplete")
    return "AROMA_PROVIDER_INVALID_RESPONSE";
  if (
    typeof code === "string" &&
    FAILURE_CODES.has(code as MutationUnknownFailureCode)
  )
    return code as MutationUnknownFailureCode;
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "AROMA_PROVIDER_TIMEOUT";
  return "AROMA_PROVIDER_OUTCOME_UNKNOWN";
}

function preparationErrorCode(error: unknown): string {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ProviderCartItemNotFound") return "AROMA_CART_ITEM_NOT_FOUND";
  if (code === "ProviderCartMappingMissing")
    return "AROMA_PROVIDER_MAPPING_MISSING";
  if (code === "ProviderCartMappingAmbiguous")
    return "AROMA_PROVIDER_MAPPING_AMBIGUOUS";
  if (
    code === "ProviderDecodeInvalid" ||
    code === "ProviderDecodeIncomplete" ||
    code === "ProviderReadIncomplete" ||
    code === "ProviderProtocolViolation"
  )
    return "AROMA_PROVIDER_INVALID_RESPONSE";
  if (
    code === "ProviderAuthenticationFailed" ||
    code === "ProviderAuthorizationFailed"
  )
    return "AROMA_PROVIDER_AUTHENTICATION_FAILED";
  if (
    code === "ProviderSessionUnavailable" ||
    code === "ProviderUnavailable" ||
    code === "ProviderCancelled"
  )
    return "AROMA_PROVIDER_UNAVAILABLE";
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "AROMA_PROVIDER_UNAVAILABLE";
  return "AROMA_PROVIDER_PREPARATION_FAILED";
}

function preparationRejection(error: unknown): MutationRejected {
  const code = preparationErrorCode(error);
  const statusCode =
    code === "AROMA_CART_ITEM_NOT_FOUND"
      ? 404
      : code === "AROMA_PROVIDER_MAPPING_MISSING" ||
          code === "AROMA_PROVIDER_MAPPING_AMBIGUOUS"
        ? 422
        : code === "AROMA_PROVIDER_INVALID_RESPONSE"
          ? 502
          : 503;
  const responseBodyBytes = new TextEncoder().encode(
    JSON.stringify({
      type: "about:blank",
      title: code,
      status: statusCode,
      code,
      detail:
        "Provider mutation was not dispatched because safe preparation failed.",
      instance: "/api/internal-v1/aroma/cart-lines",
      correlationId: "00000000-0000-4000-8000-000000000000",
      errors: [],
    }),
  );
  return {
    state: "Rejected",
    statusCode,
    failureCode: code,
    responseBodyBytes,
  };
}

function noCancellation(): AbortSignal {
  return new AbortController().signal;
}

function executionFromReservation(
  decision: ReservationDecision | DispatchDecision,
): MutationExecutionResult | undefined {
  if (decision.kind === "Replay" || decision.kind === "UnknownOutcome")
    return decision.kind === "Replay" ? decision.outcome : decision.outcome;
  if (decision.kind === "InProgress")
    return { state: decision.state, operationRef: decision.operationRef };
  return undefined;
}

/**
 * Executes the durable half of a mutation. The only unsafe call is the required
 * provider mutator parameter; there is intentionally no default or fallback.
 */
export class GatewayMutationExecutor {
  readonly #journal: MutationJournalPort;
  readonly #unsafeMutator: ProviderUnsafeMutator;
  readonly #preparer: ProviderMutationPreparer | undefined;

  public constructor(
    journal: MutationJournalPort,
    unsafeMutator: ProviderUnsafeMutator,
    preparer?: ProviderMutationPreparer,
  ) {
    this.#journal = journal;
    this.#unsafeMutator = unsafeMutator;
    const preparedMutator = unsafeMutator as PreparedProviderUnsafeMutator & {
      readonly prepare?: ProviderMutationPreparer;
    };
    this.#preparer =
      preparer ??
      preparedMutator[PROVIDER_MUTATION_PREPARER] ??
      preparedMutator.prepare;
  }

  public async execute(
    request: MutationRequest,
    delegation: MutationDelegation,
    signal?: AbortSignal,
  ): Promise<MutationExecutionResult> {
    const normalized = normalizeMutationRequest(request);
    assertMutationDelegation(normalized, delegation);
    const operationSignal = signal ?? noCancellation();
    operationSignal.throwIfAborted();
    const reservation = await this.#journal.reserve(
      normalized,
      delegation,
      operationSignal,
    );
    const reservedResult = executionFromReservation(reservation);
    if (reservedResult !== undefined) return reservedResult;
    if (reservation.kind !== "Reserved")
      throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    operationSignal.throwIfAborted();
    let preparation: unknown;
    if (this.#preparer !== undefined) {
      try {
        preparation = await this.#preparer(normalized, operationSignal);
      } catch (error) {
        if (operationSignal.aborted) throw error;
        const rejected = preparationRejection(error);
        if (this.#journal.rejectReservation !== undefined)
          return this.#journal.rejectReservation(
            reservation.reservation,
            rejected,
            noCancellation(),
          );
        return { ...rejected, replayed: false };
      }
    }
    const dispatch = await this.#journal.markDispatched(
      reservation.reservation,
      operationSignal,
    );
    const dispatchResult = executionFromReservation(dispatch);
    if (dispatchResult !== undefined) return dispatchResult;
    if (dispatch.kind !== "DispatchPermitted")
      throw new MutationJournalError("AROMA_JOURNAL_CORRUPT");
    let result: UnsafeMutationResult;
    try {
      result = validateUnsafeMutationResult(
        await this.#unsafeMutator(
          normalized,
          dispatch.permit,
          operationSignal,
          preparation,
        ),
        normalized,
      );
    } catch (error) {
      return this.#journal.markUnknown(
        dispatch.permit,
        failureCode(error),
        noCancellation(),
      );
    }
    const terminalSignal = noCancellation();
    if (result.state === "Acknowledged")
      return this.#journal.acknowledge(dispatch.permit, result, terminalSignal);
    return this.#journal.reject(dispatch.permit, result, terminalSignal);
  }
}

export type { MutationUnknownFailureCode as SafeMutationFailureCode };
