import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import {
  customerContractSchemas,
  customerErrorPolicy,
  customerErrorPolicyEntry,
  customerResponseSchema,
  customerSearchQueryError,
  decodeCustomerSearchQuery,
  hasCustomerPermission,
  isCustomerCreateRequest,
  isCustomerIdempotencyKey,
  isCustomerProblem,
  isCustomerReplayOnly,
  isCustomerResponse,
  isCustomerSearchResponse,
} from "@coffee-platform/contracts-customer-v1";
import {
  catalogContractSchemas,
  catalogResponseSchema,
  catalogSearchQueryError,
  decodeCatalogSearchQuery,
  isCatalogOperationProblem,
  isCatalogSearchResponse,
} from "@coffee-platform/contracts-catalog-v1";
import type { CatalogSearchResponse } from "@coffee-platform/contracts-catalog-v1";
import type {
  CustomerCreateRequest,
  CustomerResponse,
  CustomerSearchResponse,
} from "@coffee-platform/contracts-customer-v1";
import {
  isPricingProblem,
  isPricingQuoteCreateRequest,
  isPricingQuoteResponse,
  pricingContractSchemas,
  pricingResponseSchema,
} from "@coffee-platform/contracts-pricing-v1";
import {
  isIfMatchVersion,
  isItemRef,
  isOrderCardResponse,
  isOrderConfirmRequest,
  isOrderDraftCreateRequest,
  isOrderItemPutRequest,
  isOrderRef,
  isOrdersIdempotencyKey,
  isOrdersProblem,
  isOrdersReplayOnly,
  isReconciliationAcceptedResponse,
  isReconciliationRequest,
  ordersContractSchemas,
} from "@coffee-platform/contracts-orders-v1";
import type { OrderCardResponse } from "@coffee-platform/contracts-orders-v1";
import type {
  PricingQuoteCreateRequest,
  PricingQuoteResponse,
} from "@coffee-platform/contracts-pricing-v1";
import type {
  RuntimeComposition,
  RuntimeCompositionContext,
  RuntimeRequestContext,
} from "@coffee-platform/runtime";
import {
  parseServiceTransportMaterial,
  signActorContext,
  verifyActorContextWithKeySet,
  type ActorContextClaims,
  type ServiceTransportMaterial,
} from "@coffee-platform/security";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_BYTES = 8 * 1024;

type HeaderValue = string | string[] | undefined;
type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{ url: string | undefined }>;
  url: string;
  body: unknown;
  query: unknown;
  params?: unknown;
}>;
type Reply = {
  header: (name: string, value: string) => Reply;
  code: (status: number) => Reply;
  type: (value: string) => Reply;
  send: (body?: unknown) => Reply;
};
type HttpClient = Readonly<{
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
}>;
type Context = Readonly<{
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;
type ForwardResult = Readonly<{
  status: number;
  body: unknown;
  replayed?: boolean;
}>;
type CatalogSearchQuery = Readonly<{
  query: string;
  availability?: string;
  limit?: number;
  cursor?: string;
}>;
type CatalogForwardResult = Readonly<
  | { status: 200; body: CatalogSearchResponse }
  | { status: 400 | 401 | 403 | 503; body: unknown }
>;
type ForwardContext = Readonly<{
  actor: ActorContextClaims;
  context: Context;
  idempotencyKey: string;
  replayOnly: boolean;
}>;
type CatalogForwardContext = Readonly<{
  actor: ActorContextClaims;
  context: Context;
}>;
type PricingForwardResult = Readonly<{
  status: number;
  body: unknown;
  replayed?: boolean;
}>;
type OrdersOperationId =
  | "createOrderDraft"
  | "upsertOrderItem"
  | "removeOrderItem"
  | "confirmOrder"
  | "requestAromaReconciliation"
  | "getOrderCard";
const ordersPermissionByOperation = {
  createOrderDraft: "orders:create",
  getOrderCard: "orders:read:any",
  upsertOrderItem: "orders:edit:any",
  removeOrderItem: "orders:edit:any",
  confirmOrder: "orders:confirm:any",
  requestAromaReconciliation: "orders:reconcile:any",
} as const satisfies Record<OrdersOperationId, string>;
type OrdersForwardContext = Readonly<{
  actor: ActorContextClaims;
  context: Context;
  idempotencyKey?: string;
  ifMatchVersion?: string;
  replayOnly?: boolean;
}>;
type OrdersForwardResult = Readonly<{
  status: number;
  body: unknown;
  replayed?: boolean;
}>;
type OrdersClient = Readonly<{
  forward: (
    operationId: OrdersOperationId,
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body: unknown,
    forwardContext: OrdersForwardContext,
  ) => Promise<OrdersForwardResult>;
}>;
type Problem = Readonly<{
  type: "about:blank";
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  correlationId: string;
  errors: readonly [];
}>;

export type CustomerClient = Readonly<{
  create: (
    request: CustomerCreateRequest | undefined,
    context: ForwardContext,
  ) => Promise<ForwardResult>;
  search: (
    query: string,
    limit: number,
    cursor: string | undefined,
    context: ForwardContext,
  ) => Promise<ForwardResult>;
}>;

export type PublicApiAdapters = Readonly<{
  expectedIngressCaller?: "edge-gateway" | "edge-nginx";
  verifyTransport: (
    request: Request,
    expectedCaller: "edge-gateway" | "edge-nginx",
  ) => boolean;
  verifyActor: (
    token: string,
    operationId: string,
    signal: AbortSignal,
    correlationId: string,
  ) => Promise<ActorContextClaims> | ActorContextClaims;
  customer: CustomerClient;
  catalog: Readonly<{
    search: (
      query: CatalogSearchQuery,
      context: CatalogForwardContext,
    ) => Promise<CatalogForwardResult>;
  }>;
  pricing?: Readonly<{
    create: (
      request: PricingQuoteCreateRequest | undefined,
      context: ForwardContext,
    ) => Promise<PricingForwardResult>;
  }>;
  orders?: OrdersClient;
}>;

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}

function oneHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function exceedsBodyLimit(request: Request): boolean {
  const declared = oneHeader(header(request, "content-length"));
  if (
    declared !== undefined &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)
  )
    return true;
  if (request.body === undefined) return false;
  try {
    return (
      Buffer.byteLength(JSON.stringify(request.body), "utf8") > MAX_BODY_BYTES
    );
  } catch {
    return true;
  }
}

function exceedsUrlLimit(request: Request): boolean {
  return Buffer.byteLength(request.url, "utf8") > MAX_URL_BYTES;
}

function context(request: Request, timeoutMs?: number): Context {
  const runtime: RuntimeRequestContext | null | undefined =
    request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  const signal =
    timeoutMs === undefined
      ? base
      : AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]);
  return {
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined
      ? {}
      : { traceparent: runtime.traceparent }),
    signal,
  };
}

function problem(
  request: Request,
  status: number,
  code: string,
  detail: string,
): Problem {
  return {
    type: "about:blank",
    title: code,
    status,
    code,
    detail,
    instance: request.routeOptions.url ?? request.url,
    correlationId: request.runtimeContext?.correlationId ?? request.id,
    errors: [],
  };
}

function sendProblem(reply: Reply, body: Problem): Reply {
  return reply
    .header("cache-control", "no-store")
    .code(body.status)
    .type("application/problem+json")
    .send(body);
}

function frameworkError(request: Request, reply: Reply, error: unknown): Reply {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const validation =
    code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
  const policy = validation
    ? customerErrorPolicy.VALIDATION_FAILED
    : customerErrorPolicy.INTERNAL_ERROR;
  return sendProblem(
    reply,
    problem(
      request,
      policy.status,
      validation ? "VALIDATION_FAILED" : "INTERNAL_ERROR",
      policy.detail,
    ),
  );
}

function forwardedProblem(request: Request, value: unknown): Problem {
  if (!isCustomerProblem(value))
    return problem(
      request,
      503,
      "CUSTOMER_UNAVAILABLE",
      customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail,
    );
  const policy = customerErrorPolicyEntry(value.code);
  return policy !== undefined && policy.status === value.status
    ? problem(request, policy.status, value.code, policy.detail)
    : problem(
        request,
        503,
        "CUSTOMER_UNAVAILABLE",
        customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail,
      );
}

function sendForward(
  request: Request,
  reply: Reply,
  result: ForwardResult,
  kind: "create" | "search",
): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400)
    return sendProblem(reply, forwardedProblem(request, result.body));
  if (
    (kind === "create"
      ? isCustomerResponse(result.body)
      : isCustomerSearchResponse(result.body)) === false
  )
    return sendProblem(
      reply,
      problem(
        request,
        503,
        "CUSTOMER_UNAVAILABLE",
        customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail,
      ),
    );
  if (result.replayed === true) reply.header("idempotency-replayed", "true");
  return reply.code(result.status).send(result.body);
}

function sendCatalogForward(
  request: Request,
  reply: Reply,
  result: CatalogForwardResult,
): Reply {
  reply.header("cache-control", "no-store");
  if (result.status === 200 && isCatalogSearchResponse(result.body))
    return reply.code(200).send(result.body as CatalogSearchResponse);
  if (isCatalogOperationProblem(result.body, "search", result.status)) {
    return sendProblem(
      reply,
      problem(
        request,
        result.status,
        result.body.code,
        "catalog request failed",
      ),
    );
  }
  return sendProblem(
    reply,
    problem(
      request,
      503,
      "CATALOG_UNAVAILABLE",
      "catalog owner returned an invalid response",
    ),
  );
}

const pricingErrorCodes: Readonly<Record<number, readonly string[]>> =
  Object.freeze({
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["CATALOG_PRODUCT_NOT_FOUND"],
    409: [
      "CATALOG_PRODUCT_UNAVAILABLE",
      "CATALOG_REVISION_CHANGED",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: [
      "CATALOG_UNAVAILABLE",
      "PRICING_POLICY_UNAVAILABLE",
      "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
    ],
  });

function pricingUnavailable(request: Request): Problem {
  return problem(
    request,
    503,
    "CATALOG_UNAVAILABLE",
    "pricing service is unavailable",
  );
}

function sendPricingForward(
  request: Request,
  reply: Reply,
  result: PricingForwardResult,
): Reply {
  reply.header("cache-control", "no-store");
  if (result.status === 201 && isPricingQuoteResponse(result.body)) {
    if (result.replayed === true) reply.header("idempotency-replayed", "true");
    return reply.code(201).send(result.body as PricingQuoteResponse);
  }
  if (
    result.status >= 400 &&
    isPricingProblem(result.body) &&
    pricingErrorCodes[result.status]?.includes(result.body.code) &&
    result.body.status === result.status
  ) {
    return sendProblem(
      reply,
      problem(
        request,
        result.status,
        result.body.code,
        "pricing request failed",
      ),
    );
  }
  return sendProblem(reply, pricingUnavailable(request));
}

const ordersAllowedProblemCodes: Readonly<
  Record<OrdersOperationId, Readonly<Record<number, readonly string[]>>>
> = Object.freeze({
  createOrderDraft: {
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["CUSTOMER_NOT_FOUND"],
    409: [
      "CUSTOMER_NOT_ACTIVE",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: ["CUSTOMER_UNAVAILABLE", "IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
  },
  upsertOrderItem: {
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["ORDER_NOT_FOUND", "CATALOG_PRODUCT_NOT_FOUND"],
    409: [
      "ORDER_VERSION_CONFLICT",
      "ORDER_QUOTE_STALE",
      "ORDER_QUOTE_SCOPE_MISMATCH",
      "ORDER_ITEM_LIMIT_EXCEEDED",
      "ORDER_NOT_EDITABLE",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: ["IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
  },
  removeOrderItem: {
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["ORDER_NOT_FOUND", "ORDER_ITEM_NOT_FOUND"],
    409: [
      "ORDER_VERSION_CONFLICT",
      "ORDER_NOT_EDITABLE",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: ["IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
  },
  confirmOrder: {
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["ORDER_NOT_FOUND"],
    409: [
      "ORDER_VERSION_CONFLICT",
      "ORDER_QUOTE_STALE",
      "ORDER_NOT_EDITABLE",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    422: [
      "ORDER_CONFIRMATION_REJECTED",
      "ORDER_EMPTY",
      "ORDER_DESIRED_OVERFLOW",
    ],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: ["IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
  },
  requestAromaReconciliation: {
    400: ["VALIDATION_FAILED"],
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["ORDER_NOT_FOUND"],
    409: [
      "ORDER_VERSION_CONFLICT",
      "AROMA_RECONCILIATION_NOT_ALLOWED",
      "IDEMPOTENCY_CONFLICT",
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    ],
    410: ["IDEMPOTENCY_RESULT_NOT_RETAINED"],
    500: ["INTERNAL_ERROR", "IDEMPOTENCY_RESULT_INVALID"],
    503: ["IDEMPOTENCY_LOOKUP_UNAVAILABLE"],
  },
  getOrderCard: {
    401: ["AUTHENTICATION_REQUIRED"],
    403: ["ACTOR_CONTEXT_INVALID"],
    404: ["ORDER_NOT_FOUND"],
    500: ["INTERNAL_ERROR"],
  },
});

function sendOrdersForward(
  request: Request,
  reply: Reply,
  result: OrdersForwardResult,
  operationId: OrdersOperationId,
): Reply {
  reply
    .header("cache-control", "no-store")
    .header(
      "x-correlation-id",
      request.runtimeContext?.correlationId ?? request.id,
    );
  const successStatus: Readonly<Record<OrdersOperationId, number>> = {
    createOrderDraft: 201,
    upsertOrderItem: 200,
    removeOrderItem: 200,
    confirmOrder: 200,
    requestAromaReconciliation: 202,
    getOrderCard: 200,
  };
  if (result.status === successStatus[operationId]) {
    const validBody =
      operationId === "requestAromaReconciliation"
        ? isReconciliationAcceptedResponse(result.body)
        : isOrderCardResponse(result.body);
    if (!validBody)
      return sendProblem(
        reply,
        problem(
          request,
          503,
          "ORDERS_UNAVAILABLE",
          "orders owner returned an invalid response",
        ),
      );
    const requestedRef = orderParams(request)["orderRef"];
    if (
      typeof requestedRef === "string" &&
      (result.body as { orderRef: string }).orderRef !== requestedRef
    ) {
      return sendProblem(
        reply,
        problem(
          request,
          503,
          "ORDERS_UNAVAILABLE",
          "orders owner returned an invalid response",
        ),
      );
    }
    if (
      operationId === "createOrderDraft" &&
      !ordersReplayOnly(request) &&
      (result.body as OrderCardResponse).customer.customerRef !==
        (request.body as { customerRef: string }).customerRef
    ) {
      return sendProblem(
        reply,
        problem(
          request,
          503,
          "ORDERS_UNAVAILABLE",
          "orders owner returned an invalid response",
        ),
      );
    }
    if (result.replayed === true && operationId !== "getOrderCard")
      reply.header("idempotency-replayed", "true");
    return reply.code(result.status).send(result.body);
  }
  if (
    isOrdersProblem(result.body) &&
    result.body.status === result.status &&
    ordersAllowedProblemCodes[operationId][result.status]?.includes(
      result.body.code,
    )
  ) {
    return sendProblem(
      reply,
      problem(
        request,
        result.status,
        result.body.code,
        "orders request failed",
      ),
    );
  }
  return sendProblem(
    reply,
    problem(request, 503, "ORDERS_UNAVAILABLE", "orders owner is unavailable"),
  );
}

async function ordersActor(
  request: Request,
  adapters: PublicApiAdapters,
  operationId: OrdersOperationId,
  signal: AbortSignal,
): Promise<ActorContextClaims> {
  if (spoofed(request)) throw new Error("ACTOR_CONTEXT_INVALID");
  const rawToken = header(request, "x-actor-context");
  const token = Array.isArray(rawToken)
    ? rawToken.length === 1
      ? rawToken[0]
      : undefined
    : rawToken;
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const correlationId = request.runtimeContext?.correlationId ?? request.id;
  if (!isOrdersIdempotencyKey(correlationId))
    throw new Error("ACTOR_CONTEXT_INVALID");
  const suppliedCorrelation = header(request, "x-correlation-id");
  if (
    suppliedCorrelation !== undefined &&
    (Array.isArray(suppliedCorrelation)
      ? suppliedCorrelation.length !== 1 ||
        suppliedCorrelation[0] !== correlationId
      : suppliedCorrelation !== correlationId)
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  const claims = await adapters.verifyActor(
    token,
    operationId,
    signal,
    correlationId,
  );
  if (
    claims.iss !== "edge-gateway" ||
    claims.aud !== "api-public" ||
    claims.originalIssuer !== "edge-gateway" ||
    claims.operationId !== operationId ||
    claims.correlationId !== correlationId ||
    claims.sub.length === 0 ||
    !claims.permissions.includes(ordersPermissionByOperation[operationId]) ||
    (request.runtimeContext?.traceparent !== undefined &&
      claims.traceparent !== request.runtimeContext.traceparent)
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

function ordersSingleHeader(
  request: Request,
  name: string,
): string | undefined | null {
  const value = header(request, name);
  return Array.isArray(value)
    ? value.length === 1
      ? (value[0] ?? null)
      : null
    : value;
}

function ordersHasNoQuery(request: Request): boolean {
  return (
    request.query === null ||
    typeof request.query !== "object" ||
    Object.keys(request.query).length === 0
  );
}

function ordersReplayOnly(request: Request): boolean | Problem {
  const raw = header(request, "idempotency-replay-only");
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : null) : raw;
  if (value === undefined) return false;
  if (
    value === null ||
    !isOrdersReplayOnly(value === "true") ||
    request.body !== undefined ||
    header(request, "if-match-version") !== undefined
  )
    return problem(
      request,
      400,
      "VALIDATION_FAILED",
      "replay-only requires true and an empty body",
    );
  return true;
}

function ordersIdempotencyKey(request: Request): string | Problem {
  const raw = header(request, "idempotency-key");
  const value = Array.isArray(raw)
    ? raw.length === 1
      ? raw[0]
      : undefined
    : raw;
  return value !== undefined && isOrdersIdempotencyKey(value)
    ? value
    : problem(
        request,
        400,
        "VALIDATION_FAILED",
        "Idempotency-Key must be a UUID",
      );
}

function orderParams(request: Request): Record<string, unknown> {
  return request.params !== null && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {};
}

async function forwardOrder(
  request: Request,
  reply: Reply,
  adapters: PublicApiAdapters,
  operationId: OrdersOperationId,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  extra: Readonly<{
    idempotencyKey?: string;
    ifMatchVersion?: string;
    replayOnly?: boolean;
  }> = {},
): Promise<Reply> {
  if (
    !adapters.verifyTransport(
      request,
      adapters.expectedIngressCaller ?? "edge-nginx",
    )
  )
    return sendProblem(
      reply,
      problem(
        request,
        401,
        "AUTHENTICATION_REQUIRED",
        "service identity is required",
      ),
    );
  const requestContext = context(
    request,
    operationId === "getOrderCard" ? 1_000 : undefined,
  );
  let claims: ActorContextClaims;
  try {
    claims = await ordersActor(
      request,
      adapters,
      operationId,
      requestContext.signal,
    );
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
    return sendProblem(
      reply,
      problem(
        request,
        code === "AUTHENTICATION_REQUIRED" ? 401 : 403,
        code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID",
        "signed actor context is invalid",
      ),
    );
  }
  if (exceedsBodyLimit(request) || exceedsUrlLimit(request))
    return sendProblem(
      reply,
      problem(request, 400, "VALIDATION_FAILED", "Request validation failed"),
    );
  try {
    if (adapters.orders === undefined)
      throw new Error("orders client is not configured");
    const result = await adapters.orders.forward(
      operationId,
      method,
      path,
      body,
      { actor: claims, context: requestContext, ...extra },
    );
    return sendOrdersForward(request, reply, result, operationId);
  } catch {
    return sendProblem(
      reply,
      problem(
        request,
        503,
        "ORDERS_UNAVAILABLE",
        "orders service is unavailable",
      ),
    );
  }
}

async function pricingActor(
  request: Request,
  adapters: PublicApiAdapters,
  signal: AbortSignal,
): Promise<ActorContextClaims> {
  if (spoofed(request)) throw new Error("ACTOR_CONTEXT_INVALID");
  const token = oneHeader(header(request, "x-actor-context"));
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyActor(
    token,
    "createPricingQuote",
    signal,
    request.runtimeContext?.correlationId ?? request.id,
  );
  if (
    claims.iss !== "edge-gateway" ||
    claims.aud !== "api-public" ||
    claims.originalIssuer !== "edge-gateway" ||
    claims.operationId !== "createPricingQuote" ||
    claims.sub.length === 0 ||
    !claims.permissions.includes("pricing:create")
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

async function catalogActor(
  request: Request,
  adapters: PublicApiAdapters,
  signal: AbortSignal,
): Promise<ActorContextClaims> {
  if (spoofed(request)) throw new Error("ACTOR_CONTEXT_INVALID");
  const token = oneHeader(header(request, "x-actor-context"));
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyActor(
    token,
    "searchCatalogProducts",
    signal,
    request.runtimeContext?.correlationId ?? request.id,
  );
  if (
    claims.iss !== "edge-gateway" ||
    claims.aud !== "api-public" ||
    claims.originalIssuer !== "edge-gateway" ||
    claims.operationId !== "searchCatalogProducts" ||
    claims.sub.length === 0 ||
    !claims.permissions.includes("catalog:read")
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

function replayOnly(request: Request): boolean | Problem {
  const value = oneHeader(header(request, "idempotency-replay-only"));
  if (value === undefined) return false;
  if (
    !isCustomerReplayOnly(value === "true") ||
    request.body !== undefined ||
    header(request, "if-match-version") !== undefined
  )
    return problem(
      request,
      400,
      "VALIDATION_FAILED",
      "replay-only requires true and an empty body",
    );
  return true;
}

function idempotencyKey(request: Request): string | Problem {
  const value = oneHeader(header(request, "idempotency-key"));
  return value !== undefined && isCustomerIdempotencyKey(value)
    ? value
    : problem(
        request,
        400,
        "VALIDATION_FAILED",
        "Idempotency-Key must be a UUID",
      );
}

function spoofed(request: Request): boolean {
  const blocked = [
    "x-actor-ref",
    "x-original-issuer",
    "x-original-caller",
    "x-service-identity",
    "x-transport-caller",
    "x-service-delegation",
  ];
  return (
    blocked.some((name) => header(request, name) !== undefined) ||
    Object.keys(request.headers).some(
      (name) =>
        name.toLowerCase().startsWith("x-actor-") &&
        name.toLowerCase() !== "x-actor-context",
    )
  );
}

async function actor(
  request: Request,
  adapters: PublicApiAdapters,
  operationId: string,
  signal: AbortSignal,
): Promise<ActorContextClaims> {
  if (spoofed(request)) throw new Error("ACTOR_CONTEXT_INVALID");
  const token = oneHeader(header(request, "x-actor-context"));
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyActor(
    token,
    operationId,
    signal,
    request.runtimeContext?.correlationId ?? request.id,
  );
  if (
    claims.iss !== "edge-gateway" ||
    claims.aud !== "api-public" ||
    claims.operationId !== operationId ||
    claims.originalIssuer !== "edge-gateway" ||
    claims.sub.length === 0 ||
    !hasCustomerPermission(
      claims.permissions,
      operationId as "createCustomer" | "searchCustomers",
    )
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

export function registerPublicRoutes(
  app: RuntimeApp,
  adapters: PublicApiAdapters,
): void {
  app.post("/api/client-v1/pricing/quotes", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (error, request, reply) =>
      frameworkError(request, reply, error),
    schema: {
      response: pricingResponseSchema(
        pricingContractSchemas.response,
        201,
        [400, 401, 403, 404, 409, 410, 500, 503],
      ),
    },
    handler: async (request, reply) => {
      if (
        !adapters.verifyTransport(
          request,
          adapters.expectedIngressCaller ?? "edge-nginx",
        )
      )
        return sendProblem(
          reply,
          problem(
            request,
            401,
            "AUTHENTICATION_REQUIRED",
            "service identity is required",
          ),
        );
      const requestContext = context(request);
      let claims: ActorContextClaims;
      try {
        claims = await pricingActor(request, adapters, requestContext.signal);
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(
          reply,
          problem(
            request,
            code === "AUTHENTICATION_REQUIRED" ? 401 : 403,
            code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID",
            "signed actor context is invalid",
          ),
        );
      }
      if (exceedsBodyLimit(request))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      const replay = replayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = idempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = isPricingQuoteCreateRequest(request.body)
        ? request.body
        : undefined;
      if (!replay && body === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      try {
        if (adapters.pricing === undefined)
          throw new Error("pricing client is not configured");
        return sendPricingForward(
          request,
          reply,
          await adapters.pricing.create(replay ? undefined : body, {
            actor: claims,
            context: requestContext,
            idempotencyKey: key,
            replayOnly: replay,
          }),
        );
      } catch {
        return sendProblem(reply, pricingUnavailable(request));
      }
    },
  });

  app.post("/api/client-v1/customers", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (error, request, reply) =>
      frameworkError(request, reply, error),
    schema: {
      response: customerResponseSchema(
        customerContractSchemas.response,
        201,
        [400, 401, 403, 409, 410, 500, 503],
      ),
    },
    handler: async (request, reply) => {
      if (
        !adapters.verifyTransport(
          request,
          adapters.expectedIngressCaller ?? "edge-nginx",
        )
      )
        return sendProblem(
          reply,
          problem(
            request,
            401,
            "AUTHENTICATION_REQUIRED",
            "service identity is required",
          ),
        );
      const requestContext = context(request);
      let claims: ActorContextClaims;
      try {
        claims = await actor(
          request,
          adapters,
          "createCustomer",
          requestContext.signal,
        );
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(
          reply,
          problem(
            request,
            code === "AUTHENTICATION_REQUIRED" ? 401 : 403,
            code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID",
            "signed actor context is invalid",
          ),
        );
      }
      if (exceedsBodyLimit(request))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      const replay = replayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = idempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = isCustomerCreateRequest(request.body)
        ? request.body
        : undefined;
      if (!replay && body === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      try {
        const result = await adapters.customer.create(
          replay ? undefined : body,
          {
            actor: claims,
            context: requestContext,
            idempotencyKey: key,
            replayOnly: replay,
          },
        );
        return sendForward(request, reply, result, "create");
      } catch {
        return sendProblem(
          reply,
          problem(
            request,
            503,
            "CUSTOMER_UNAVAILABLE",
            "customer service is unavailable",
          ),
        );
      }
    },
  });

  app.get("/api/client-v1/customers", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    schema: {
      response: customerResponseSchema(
        customerContractSchemas.searchResponse,
        200,
        [400, 401, 403, 500, 503],
      ),
    },
    handler: async (request, reply) => {
      if (
        !adapters.verifyTransport(
          request,
          adapters.expectedIngressCaller ?? "edge-nginx",
        )
      )
        return sendProblem(
          reply,
          problem(
            request,
            401,
            "AUTHENTICATION_REQUIRED",
            "service identity is required",
          ),
        );
      const requestContext = context(request, 1_000);
      let claims: ActorContextClaims;
      try {
        claims = await actor(
          request,
          adapters,
          "searchCustomers",
          requestContext.signal,
        );
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(
          reply,
          problem(
            request,
            code === "AUTHENTICATION_REQUIRED" ? 401 : 403,
            code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID",
            "signed actor context is invalid",
          ),
        );
      }
      if (exceedsUrlLimit(request))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      const decodedQuery = decodeCustomerSearchQuery(request.query);
      if (decodedQuery === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            customerSearchQueryError(request.query),
            "Request validation failed",
          ),
        );
      const query = decodedQuery.query;
      const limit = decodedQuery.limit ?? 20;
      const cursor = decodedQuery.cursor;
      try {
        const result = await adapters.customer.search(
          query,
          limit,
          typeof cursor === "string" ? cursor : undefined,
          {
            actor: claims,
            context: requestContext,
            idempotencyKey: "",
            replayOnly: false,
          },
        );
        return sendForward(request, reply, result, "search");
      } catch {
        return sendProblem(
          reply,
          problem(
            request,
            503,
            "CUSTOMER_UNAVAILABLE",
            "customer service is unavailable",
          ),
        );
      }
    },
  });

  app.get("/api/client-v1/catalog/products", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    schema: {
      response: catalogResponseSchema(
        catalogContractSchemas.searchResponse,
        200,
        [400, 401, 403, 503],
      ),
    },
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (
        !adapters.verifyTransport(
          request,
          adapters.expectedIngressCaller ?? "edge-nginx",
        )
      )
        return sendProblem(
          reply,
          problem(
            request,
            401,
            "AUTHENTICATION_REQUIRED",
            "service identity is required",
          ),
        );
      const requestContext = context(request, 1_000);
      let claims: ActorContextClaims;
      try {
        claims = await catalogActor(request, adapters, requestContext.signal);
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(
          reply,
          problem(
            request,
            code === "AUTHENTICATION_REQUIRED" ? 401 : 403,
            code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID",
            "signed actor context is invalid",
          ),
        );
      }
      if (exceedsUrlLimit(request))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      const decoded = decodeCatalogSearchQuery(request.query);
      if (decoded === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            catalogSearchQueryError(request.query),
            "Request validation failed",
          ),
        );
      try {
        return sendCatalogForward(
          request,
          reply,
          await adapters.catalog.search(decoded, {
            actor: claims,
            context: requestContext,
          }),
        );
      } catch {
        return sendProblem(
          reply,
          problem(
            request,
            503,
            "CATALOG_UNAVAILABLE",
            "catalog owner is unavailable",
          ),
        );
      }
    },
  });

  const orderSchema = (successStatus: number) => ({
    response: {
      [successStatus]:
        successStatus === 202
          ? ordersContractSchemas.reconciliationAcceptedResponse
          : ordersContractSchemas.cardResponse,
      400: ordersContractSchemas.problem,
      401: ordersContractSchemas.problem,
      403: ordersContractSchemas.problem,
      404: ordersContractSchemas.problem,
      409: ordersContractSchemas.problem,
      410: ordersContractSchemas.problem,
      422: ordersContractSchemas.problem,
      500: ordersContractSchemas.problem,
      503: ordersContractSchemas.problem,
    },
  });
  const commandOptions = {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (error: Error, request: Request, reply: Reply) =>
      frameworkError(request, reply, error),
  };

  app.post("/api/client-v1/orders/drafts", {
    ...commandOptions,
    schema: orderSchema(201),
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (
        !ordersHasNoQuery(request) ||
        header(request, "if-match-version") !== undefined
      )
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Query parameters and If-Match-Version are not supported",
          ),
        );
      const replay = ordersReplayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = ordersIdempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = replay
        ? undefined
        : isOrderDraftCreateRequest(request.body)
          ? request.body
          : undefined;
      if (!replay && body === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      return forwardOrder(
        request,
        reply,
        adapters,
        "createOrderDraft",
        "POST",
        "/api/client-v1/orders/drafts",
        body,
        { idempotencyKey: key, replayOnly: replay },
      );
    },
  });

  app.put("/api/client-v1/orders/:orderRef/items/:itemRef", {
    ...commandOptions,
    schema: orderSchema(200),
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const { orderRef, itemRef } = orderParams(request);
      if (
        !isOrderRef(orderRef) ||
        !isItemRef(itemRef) ||
        header(request, "if-match-version") !== undefined ||
        !ordersHasNoQuery(request)
      )
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request path or headers are invalid",
          ),
        );
      const replay = ordersReplayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = ordersIdempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = replay
        ? undefined
        : isOrderItemPutRequest(request.body)
          ? request.body
          : undefined;
      if (!replay && body === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request validation failed",
          ),
        );
      return forwardOrder(
        request,
        reply,
        adapters,
        "upsertOrderItem",
        "PUT",
        `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
        body,
        { idempotencyKey: key, replayOnly: replay },
      );
    },
  });

  app.delete("/api/client-v1/orders/:orderRef/items/:itemRef", {
    ...commandOptions,
    schema: orderSchema(200),
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const { orderRef, itemRef } = orderParams(request);
      if (
        !isOrderRef(orderRef) ||
        !isItemRef(itemRef) ||
        request.body !== undefined
      )
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request path or body is invalid",
          ),
        );
      const replay = ordersReplayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = ordersIdempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const match = ordersSingleHeader(request, "if-match-version");
      if (match === null)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "If-Match-Version must appear once",
          ),
        );
      if (!replay && (match === undefined || !isIfMatchVersion(match)))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "If-Match-Version is required and must be a decimal version",
          ),
        );
      if (!ordersHasNoQuery(request))
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Query parameters are not supported",
          ),
        );
      return forwardOrder(
        request,
        reply,
        adapters,
        "removeOrderItem",
        "DELETE",
        `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
        undefined,
        {
          idempotencyKey: key,
          ...(!replay && match !== undefined ? { ifMatchVersion: match } : {}),
          replayOnly: replay,
        },
      );
    },
  });

  for (const command of [
    { operationId: "confirmOrder" as const, suffix: "confirm" },
    {
      operationId: "requestAromaReconciliation" as const,
      suffix: "request-aroma-reconciliation",
    },
  ]) {
    const isAroma = command.operationId === "requestAromaReconciliation";
    app.post(`/api/client-v1/orders/:orderRef/commands/${command.suffix}`, {
      ...commandOptions,
      schema: orderSchema(isAroma ? 202 : 200),
      handler: async (request, rawReply) => {
        const reply = rawReply as unknown as Reply;
        const { orderRef } = orderParams(request);
        if (
          !isOrderRef(orderRef) ||
          header(request, "if-match-version") !== undefined ||
          !ordersHasNoQuery(request)
        )
          return sendProblem(
            reply,
            problem(
              request,
              400,
              "VALIDATION_FAILED",
              "Request path or headers are invalid",
            ),
          );
        const replay = ordersReplayOnly(request);
        if (typeof replay !== "boolean") return sendProblem(reply, replay);
        const key = ordersIdempotencyKey(request);
        if (typeof key !== "string") return sendProblem(reply, key);
        const body = replay
          ? undefined
          : isAroma
            ? isReconciliationRequest(request.body)
              ? request.body
              : undefined
            : isOrderConfirmRequest(request.body)
              ? request.body
              : undefined;
        if (!replay && body === undefined)
          return sendProblem(
            reply,
            problem(
              request,
              400,
              "VALIDATION_FAILED",
              "Request validation failed",
            ),
          );
        return forwardOrder(
          request,
          reply,
          adapters,
          command.operationId,
          "POST",
          `/api/client-v1/orders/${orderRef}/commands/${command.suffix}`,
          body,
          { idempotencyKey: key, replayOnly: replay },
        );
      },
    });
  }

  app.get("/api/client-v1/orders/:orderRef", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    schema: {
      response: {
        200: ordersContractSchemas.cardResponse,
        400: ordersContractSchemas.problem,
        401: ordersContractSchemas.problem,
        403: ordersContractSchemas.problem,
        404: ordersContractSchemas.problem,
        500: ordersContractSchemas.problem,
        503: ordersContractSchemas.problem,
      },
    },
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const { orderRef } = orderParams(request);
      if (
        !isOrderRef(orderRef) ||
        request.body !== undefined ||
        !ordersHasNoQuery(request) ||
        ["idempotency-key", "idempotency-replay-only", "if-match-version"].some(
          (name) => header(request, name) !== undefined,
        )
      )
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            "Request path or headers are invalid",
          ),
        );
      return forwardOrder(
        request,
        reply,
        adapters,
        "getOrderCard",
        "GET",
        `/api/client-v1/orders/${orderRef}`,
        undefined,
      );
    },
  });
}

export function createHttpCustomerClient(
  client: HttpClient,
  sign: (
    actor: ActorContextClaims,
    owner: string,
    operationId: string,
    context: Context,
  ) => string,
): CustomerClient {
  const call = async (
    path: string,
    method: "GET" | "POST",
    body: unknown,
    requestContext: ForwardContext,
    operationId: string,
  ): Promise<ForwardResult> => {
    const token = sign(
      requestContext.actor,
      "customer-service",
      operationId,
      requestContext.context,
    );
    const headers: Record<string, string> = {
      "x-actor-context": token,
      "x-correlation-id": requestContext.context.correlationId,
      ...(requestContext.idempotencyKey === ""
        ? {}
        : { "idempotency-key": requestContext.idempotencyKey }),
    };
    if (requestContext.context.traceparent !== undefined)
      headers["traceparent"] = requestContext.context.traceparent;
    if (requestContext.replayOnly) headers["idempotency-replay-only"] = "true";
    const response = await client.fetch(path, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { ...headers, "content-type": "application/json" },
          }),
      signal: requestContext.context.signal,
    });
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = {
        type: "about:blank",
        title: "CUSTOMER_UNAVAILABLE",
        status: 503,
        code: "CUSTOMER_UNAVAILABLE",
        detail: "customer service returned an invalid response",
        instance: path,
        correlationId: requestContext.context.correlationId,
        errors: [],
      };
    }
    return {
      status: response.status,
      body: responseBody,
      ...(response.headers.get("idempotency-replayed") === "true"
        ? { replayed: true }
        : {}),
    };
  };
  return {
    create: (request, requestContext) =>
      call(
        "/api/client-v1/customers",
        "POST",
        request,
        requestContext,
        "createCustomer",
      ),
    search: (query, limit, cursor, requestContext) => {
      const params = new URLSearchParams({
        query,
        limit: String(limit),
        ...(cursor === undefined ? {} : { cursor }),
      });
      return call(
        `/api/client-v1/customers?${params.toString()}`,
        "GET",
        undefined,
        requestContext,
        "searchCustomers",
      );
    },
  };
}

export function createHttpCatalogClient(
  client: HttpClient,
  sign: (
    actor: ActorContextClaims,
    owner: string,
    operationId: string,
    context: Context,
  ) => string,
): PublicApiAdapters["catalog"] {
  return {
    search: async (query, requestContext) => {
      const delegation = sign(
        requestContext.actor,
        "catalog-service",
        "searchCatalogProducts",
        requestContext.context,
      );
      const params = new URLSearchParams({ query: query.query });
      if (query.availability !== undefined)
        params.set("availability", query.availability);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      const headers: Record<string, string> = {
        "x-actor-context": delegation,
        "x-correlation-id": requestContext.context.correlationId,
        accept: "application/json, application/problem+json",
      };
      if (requestContext.context.traceparent !== undefined)
        headers["traceparent"] = requestContext.context.traceparent;
      const response = await client.fetch(
        `/api/client-v1/catalog/products?${params.toString()}`,
        { method: "GET", headers, signal: requestContext.context.signal },
      );
      if (![200, 400, 401, 403, 503].includes(response.status))
        throw new Error("catalog owner returned an unsupported status");
      const expectedMediaType =
        response.status === 200
          ? "application/json"
          : "application/problem+json";
      if (mediaType(response) !== expectedMediaType)
        throw new Error("catalog owner returned an unsupported media type");
      const body = await boundedCatalogJson(response, 1_048_576);
      if (response.status === 200) {
        if (!isCatalogSearchResponse(body))
          throw new Error("catalog owner returned an invalid response");
        return { status: 200, body: body as CatalogSearchResponse };
      }
      if (!isCatalogOperationProblem(body, "search", response.status))
        throw new Error("catalog owner returned an invalid response");
      return { status: response.status as 400 | 401 | 403 | 503, body };
    },
  };
}

export function createHttpPricingClient(
  client: HttpClient,
  sign: (
    actor: ActorContextClaims,
    owner: string,
    operationId: string,
    context: Context,
  ) => string,
): NonNullable<PublicApiAdapters["pricing"]> {
  return {
    create: async (body, requestContext) => {
      const path = "/api/client-v1/pricing/quotes";
      const headers: Record<string, string> = {
        "x-actor-context": sign(
          requestContext.actor,
          "pricing-service",
          "createPricingQuote",
          requestContext.context,
        ),
        "x-correlation-id": requestContext.context.correlationId,
        "idempotency-key": requestContext.idempotencyKey,
        accept: "application/json, application/problem+json",
      };
      if (requestContext.context.traceparent !== undefined)
        headers["traceparent"] = requestContext.context.traceparent;
      if (requestContext.replayOnly)
        headers["idempotency-replay-only"] = "true";
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await client.fetch(path, {
        method: "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: requestContext.context.signal,
      });
      if (
        response.status !== 201 &&
        pricingErrorCodes[response.status] === undefined
      )
        throw new Error("pricing owner returned unsupported status");
      if (
        mediaType(response) !==
        (response.status === 201
          ? "application/json"
          : "application/problem+json")
      )
        throw new Error("pricing owner returned unsupported media type");
      const result = await boundedCatalogJson(response, 1_048_576);
      if (response.status === 201 && !isPricingQuoteResponse(result))
        throw new Error("pricing owner returned invalid quote");
      if (
        response.status !== 201 &&
        (!isPricingProblem(result) ||
          result.status !== response.status ||
          !pricingErrorCodes[response.status]?.includes(result.code))
      )
        throw new Error("pricing owner returned invalid problem");
      return {
        status: response.status,
        body: result,
        ...(response.headers.get("idempotency-replayed") === "true"
          ? { replayed: true }
          : {}),
      };
    },
  };
}

export function createHttpOrdersClient(
  client: HttpClient,
  sign: (
    actor: ActorContextClaims,
    owner: string,
    operationId: string,
    context: Context,
  ) => string,
): OrdersClient {
  return {
    forward: async (operationId, method, path, body, forwardContext) => {
      const headers: Record<string, string> = {
        "x-actor-context": sign(
          forwardContext.actor,
          "orders-service",
          operationId,
          forwardContext.context,
        ),
        "x-correlation-id": forwardContext.context.correlationId,
        accept: "application/json, application/problem+json",
      };
      if (forwardContext.context.traceparent !== undefined)
        headers["traceparent"] = forwardContext.context.traceparent;
      if (forwardContext.idempotencyKey !== undefined)
        headers["idempotency-key"] = forwardContext.idempotencyKey;
      if (forwardContext.ifMatchVersion !== undefined)
        headers["if-match-version"] = forwardContext.ifMatchVersion;
      if (forwardContext.replayOnly === true)
        headers["idempotency-replay-only"] = "true";
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await client.fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: forwardContext.context.signal,
      });
      const supportedStatus =
        response.status ===
          (
            {
              createOrderDraft: 201,
              upsertOrderItem: 200,
              removeOrderItem: 200,
              confirmOrder: 200,
              requestAromaReconciliation: 202,
              getOrderCard: 200,
            } satisfies Record<OrdersOperationId, number>
          )[operationId] ||
        ordersAllowedProblemCodes[operationId][response.status] !== undefined;
      if (!supportedStatus)
        throw new Error("orders owner returned unsupported status");
      const isSuccess =
        response.status ===
        (
          {
            createOrderDraft: 201,
            upsertOrderItem: 200,
            removeOrderItem: 200,
            confirmOrder: 200,
            requestAromaReconciliation: 202,
            getOrderCard: 200,
          } satisfies Record<OrdersOperationId, number>
        )[operationId];
      if (
        mediaType(response) !==
        (isSuccess ? "application/json" : "application/problem+json")
      )
        throw new Error("orders owner returned unsupported media type");
      if (
        response.headers.get("x-correlation-id") !==
          forwardContext.context.correlationId ||
        response.headers.get("cache-control")?.toLowerCase() !== "no-store"
      )
        throw new Error("orders owner returned invalid response headers");
      const replayHeader = response.headers.get("idempotency-replayed");
      if (replayHeader !== null && replayHeader !== "true")
        throw new Error("orders owner returned invalid replay header");
      const responseBody = await boundedCatalogJson(response, 1_048_576);
      if (isSuccess) {
        const valid =
          operationId === "requestAromaReconciliation"
            ? isReconciliationAcceptedResponse(responseBody)
            : isOrderCardResponse(responseBody);
        if (!valid)
          throw new Error("orders owner returned invalid response body");
      } else if (
        !isOrdersProblem(responseBody) ||
        responseBody.status !== response.status ||
        !ordersAllowedProblemCodes[operationId][response.status]?.includes(
          responseBody.code,
        )
      ) {
        throw new Error("orders owner returned invalid problem body");
      }
      return {
        status: response.status,
        body: responseBody,
        ...(replayHeader === "true" ? { replayed: true } : {}),
      };
    },
  };
}

function mediaType(response: Response): string | undefined {
  return response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

async function boundedCatalogJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (response.body === null) throw new Error("empty catalog response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("catalog response too large");
      chunks.push(chunk.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* cleanup */
    }
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function privateKey(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (typeof value !== "string" || value.length === 0)
    throw new Error("PUBLIC_API_DELEGATION_KEY_NOT_CONFIGURED");
  return createPrivateKey(value);
}

function verificationKeys(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("PUBLIC_API_ACTOR_VERIFICATION_KEYS_NOT_CONFIGURED");
  const source = value as Record<string, unknown>;
  const active = source["active"];
  const previous = source["previous"];
  if (
    typeof active !== "string" ||
    active.length === 0 ||
    typeof previous !== "string" ||
    previous.length === 0
  )
    throw new Error("PUBLIC_API_ACTOR_VERIFICATION_KEYS_NOT_CONFIGURED");
  return [createPublicKey(active), createPublicKey(previous)];
}

function epochSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function customerOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-public"].outbound.find((entry) =>
    entry.startsWith("customer-service:"),
  );
  if (target === undefined)
    throw new Error("PUBLIC_API_CUSTOMER_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function createConfiguredPublicAdapters(
  context: RuntimeCompositionContext,
  client: HttpClient,
  catalogClient: HttpClient = client,
  pricingClient: HttpClient = client,
  ordersClient: HttpClient = client,
): PublicApiAdapters {
  const signingKey = privateKey(
    context,
    "security.apiPublicDelegationSigningPrivateKey",
  );
  const actorVerificationKeys = verificationKeys(
    context,
    "security.actorContextEdgeVerificationPublicKeys",
  );
  const sign = (
    actor: ActorContextClaims,
    owner: string,
    operationId: string,
    requestContext: Context,
  ): string => {
    const iat = epochSeconds();
    return signActorContext(
      {
        iss: "api-public",
        aud: owner,
        originalIssuer: actor.iss,
        sub: actor.sub,
        permissions: actor.permissions,
        operationId,
        correlationId: requestContext.correlationId,
        traceparent:
          requestContext.traceparent ??
          "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + 6,
        jti: randomUUID(),
        kid: "api-public-delegation-v1",
      },
      signingKey,
    );
  };
  return {
    expectedIngressCaller: "edge-nginx",
    verifyTransport: (request, expectedCaller) =>
      request.runtimeContext?.transportIdentity?.runtime === expectedCaller,
    verifyActor: (token, operationId, signal, correlationId) => {
      signal.throwIfAborted();
      const claims = verifyActorContextWithKeySet(token, {
        publicKeys: actorVerificationKeys,
        issuer: "edge-gateway",
        audience: "api-public",
        nowEpochSeconds: epochSeconds(),
        clockSkewSeconds: 5,
      });
      if (
        claims.operationId !== operationId ||
        claims.correlationId !== correlationId ||
        claims.exp - claims.iat > 60
      )
        throw new Error("ACTOR_CONTEXT_INVALID");
      return claims;
    },
    customer: createHttpCustomerClient(
      { fetch: (path, options) => client.fetch(path, options) },
      sign,
    ),
    catalog: createHttpCatalogClient(
      { fetch: (path, options) => catalogClient.fetch(path, options) },
      sign,
    ),
    pricing: createHttpPricingClient(
      { fetch: (path, options) => pricingClient.fetch(path, options) },
      sign,
    ),
    orders: createHttpOrdersClient(
      { fetch: (path, options) => ordersClient.fetch(path, options) },
      sign,
    ),
  };
}

export function configuredTransportMaterial(
  context: RuntimeCompositionContext,
): ServiceTransportMaterial {
  let value: unknown = context.secrets;
  for (const part of "security.serviceTransportKeys.api-public".split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("PUBLIC_API_TRANSPORT_NOT_CONFIGURED");
    value = (value as Record<string, unknown>)[part];
  }
  return parseServiceTransportMaterial(
    value,
    context.config.environment,
    "api-public",
  );
}

export function configuredCustomerTls(context: RuntimeCompositionContext) {
  return {
    material: configuredTransportMaterial(context),
    targetEnvironment: context.config.environment,
    targetRuntime: "customer-service",
  };
}

export function configuredCustomerOrigin(
  context: RuntimeCompositionContext,
): string {
  return customerOrigin(context);
}

export function configuredCatalogOrigin(
  context: RuntimeCompositionContext,
): string {
  const target = context.config.services["api-public"].outbound.find((entry) =>
    entry.startsWith("catalog-service:"),
  );
  if (target === undefined)
    throw new Error("PUBLIC_API_CATALOG_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function configuredCatalogTls(context: RuntimeCompositionContext) {
  return {
    material: configuredTransportMaterial(context),
    targetEnvironment: context.config.environment,
    targetRuntime: "catalog-service",
  };
}

export function configuredPricingOrigin(
  context: RuntimeCompositionContext,
): string {
  const target = context.config.services["api-public"].outbound.find((entry) =>
    entry.startsWith("pricing-service:"),
  );
  if (target === undefined)
    throw new Error("PUBLIC_API_PRICING_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function configuredPricingTls(context: RuntimeCompositionContext) {
  return {
    material: configuredTransportMaterial(context),
    targetEnvironment: context.config.environment,
    targetRuntime: "pricing-service",
  };
}

export function configuredOrdersOrigin(
  context: RuntimeCompositionContext,
): string {
  const target = context.config.services["api-public"].outbound.find((entry) =>
    entry.startsWith("orders-service:"),
  );
  if (target === undefined)
    throw new Error("PUBLIC_API_ORDERS_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function configuredOrdersTls(context: RuntimeCompositionContext) {
  return {
    material: configuredTransportMaterial(context),
    targetEnvironment: context.config.environment,
    targetRuntime: "orders-service",
  };
}

export function createUnavailablePublicAdapters(): PublicApiAdapters {
  return {
    verifyTransport: () => false,
    verifyActor: () => {
      throw new Error("PUBLIC_API_SECURITY_NOT_CONFIGURED");
    },
    customer: {
      create: async () => {
        throw new Error("PUBLIC_API_CUSTOMER_CLIENT_NOT_CONFIGURED");
      },
      search: async () => {
        throw new Error("PUBLIC_API_CUSTOMER_CLIENT_NOT_CONFIGURED");
      },
    },
    catalog: {
      search: async () => {
        throw new Error("PUBLIC_API_CATALOG_CLIENT_NOT_CONFIGURED");
      },
    },
    pricing: {
      create: async () => {
        throw new Error("PUBLIC_API_PRICING_CLIENT_NOT_CONFIGURED");
      },
    },
  };
}

export type { CustomerCreateRequest, CustomerResponse, CustomerSearchResponse };
