import { createHash } from "node:crypto";
import type { IdempotencyKey } from "@coffee-platform/idempotency";
import {
  isOrderCardResponse,
  isReconciliationAcceptedResponse,
  isOrderDraftCreateRequest,
  isOrderItemPutRequest,
  isOrderConfirmRequest,
  isReconciliationRequest,
  isOrdersIdempotencyKey,
  isIfMatchVersion,
  isOrderRef,
  isItemRef,
} from "@coffee-platform/contracts-orders-v1";
import type {
  OrderStore,
  OrderCommandResult,
  ReconciliationCommandResult,
  OrderReplayResult,
  OrderPrecheckResult,
} from "../infrastructure/database/order-store.js";
import { observe, type OrdersSpanName } from "../observability.js";
import {
  createDraft,
  type CommandContext,
} from "../application/create-draft.js";
import { upsertItem } from "../application/upsert-item.js";
import { deleteItem } from "../application/delete-item.js";
import { confirmOrder } from "../application/confirm-order.js";
import { getOrderCard } from "../application/get-order-card.js";
import { requestAromaReconciliation } from "../application/request-aroma-reconciliation.js";

type App = Parameters<
  NonNullable<
    import("@coffee-platform/runtime").RuntimeComposition["configure"]
  >
>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, string | string[] | undefined>>;
  id: string;
  url: string;
  body: unknown;
  params: unknown;
  routeOptions: Readonly<{ url: string | undefined }>;
  runtimeContext:
    import("@coffee-platform/runtime").RuntimeRequestContext | null;
}>;
type Reply = {
  statusCode: number;
  header(name: string, value: string): Reply;
  code(status: number): Reply;
  type(mime: string): Reply;
  send(body?: unknown): Reply;
};
type Operation =
  | "createOrderDraft"
  | "getOrderCard"
  | "upsertOrderItem"
  | "removeOrderItem"
  | "confirmOrder"
  | "requestAromaReconciliation";
type Claims = Readonly<{
  iss: string;
  aud: string;
  originalIssuer: string;
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent?: string;
}>;
type Context = Readonly<{
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
  deadlineUtc: string | null;
}>;
type Security = Readonly<{
  verifyTransport: (request: Request, caller: "api-public") => boolean;
  verifyPublicDelegation: (
    token: string,
    operation: Operation,
    correlationId: string,
    signal: AbortSignal,
  ) => Claims | Promise<Claims>;
  signInternalDelegation: (
    request: Readonly<{
      operationId: "getCustomerOrderInput" | "verifyPricingQuote";
      correlationId: string;
      traceparent?: string;
      deadlineUtc: string | null;
    }>,
  ) => string;
}>;
type Store = Pick<
  OrderStore,
  | "createDraft"
  | "putItem"
  | "deleteItem"
  | "confirm"
  | "requestReconciliation"
  | "getCard"
  | "precheck"
  | "preflightPut"
  | "replay"
>;
type Customer = Readonly<{
  getOrderInput: (
    request: Readonly<{
      customerRef: string;
      delegation: string;
      correlationId: string;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ) => Promise<
    import("@coffee-platform/contracts-customer-v1").CustomerOrderInput
  >;
}>;
type Pricing = Readonly<{
  verify: (
    request: Readonly<{
      quoteRef: string;
      hash: string;
      customerRef: string;
      quoteLineNumber: number;
      productRef: string;
      variantRef: string;
      quantity: string;
      delegation: string;
      correlationId: string;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ) => Promise<
    import("@coffee-platform/contracts-pricing-v1").PricingQuoteVerificationResponse
  >;
}>;
export type OrdersHttpAdapters = Security &
  Readonly<{
    owner: Readonly<{ store: Store; customer: Customer; pricing: Pricing }>;
  }>;

const BASE = "/api/client-v1/orders";
const permissions: Readonly<Record<Operation, string>> = {
  createOrderDraft: "orders:create",
  getOrderCard: "orders:read:any",
  upsertOrderItem: "orders:edit:any",
  removeOrderItem: "orders:edit:any",
  confirmOrder: "orders:confirm:any",
  requestAromaReconciliation: "orders:reconcile:any",
};
const paths = {
  create: `${BASE}/drafts`,
  get: `${BASE}/:orderRef`,
  put: `${BASE}/:orderRef/items/:itemRef`,
  remove: `${BASE}/:orderRef/items/:itemRef`,
  confirm: `${BASE}/:orderRef/commands/confirm`,
  reconcile: `${BASE}/:orderRef/commands/request-aroma-reconciliation`,
};
const status: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  AUTHENTICATION_REQUIRED: 401,
  ACTOR_CONTEXT_INVALID: 403,
  ORDER_NOT_FOUND: 404,
  ORDER_ITEM_NOT_FOUND: 404,
  CUSTOMER_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,
  ORDER_VERSION_CONFLICT: 409,
  ORDER_NOT_EDITABLE: 409,
  ORDER_ITEM_LIMIT_EXCEEDED: 409,
  ORDER_QUOTE_STALE: 409,
  ORDER_QUOTE_SCOPE_MISMATCH: 409,
  PRICING_QUOTE_EXPIRED: 409,
  AROMA_RECONCILIATION_NOT_ALLOWED: 409,
  IDEMPOTENCY_RESULT_NOT_RETAINED: 410,
  ORDER_EMPTY: 422,
  ORDER_DESIRED_OVERFLOW: 422,
  ORDER_CONFIRMATION_REJECTED: 422,
  IDEMPOTENCY_LOOKUP_UNAVAILABLE: 503,
  CUSTOMER_NOT_ACTIVE: 409,
  CUSTOMER_UNAVAILABLE: 503,
  PRICING_UNAVAILABLE: 503,
  IDEMPOTENCY_RESULT_INVALID: 500,
  INTERNAL_ERROR: 500,
};
const PUBLIC_CODES = new Set(Object.keys(status));
function param(r: Request, key: string): unknown {
  if (r.params === null || typeof r.params !== "object") return undefined;
  return (r.params as Readonly<Record<string, unknown>>)[key];
}
function header(r: Request, name: string): string | undefined {
  const found = Object.entries(r.headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  return found.length === 1 && !Array.isArray(found[0]?.[1])
    ? found[0]?.[1]
    : undefined;
}
function present(r: Request, name: string): boolean {
  return Object.keys(r.headers).some((key) => key.toLowerCase() === name);
}
function spoofed(r: Request): boolean {
  return Object.keys(r.headers).some((k) => {
    const n = k.toLowerCase();
    return (
      (n.startsWith("x-actor-") ||
        [
          "x-original-issuer",
          "x-original-caller",
          "x-service-identity",
          "x-transport-caller",
          "x-service-delegation",
        ].includes(n)) &&
      n !== "x-actor-context"
    );
  });
}
function ctx(r: Request): Context {
  const runtime = r.runtimeContext;
  return {
    correlationId: runtime?.correlationId ?? r.id,
    ...(runtime?.traceparent === undefined
      ? {}
      : { traceparent: runtime.traceparent }),
    signal: runtime?.signal ?? new AbortController().signal,
    deadlineUtc: runtime?.deadlineUtc ?? null,
  };
}
function problem(r: Request, reply: Reply, code: string): Reply {
  const safe = PUBLIC_CODES.has(code) ? code : "INTERNAL_ERROR",
    s = status[safe] ?? 500;
  return reply
    .header("cache-control", "no-store")
    .code(s)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title: safe,
      status: s,
      code: safe,
      detail: "Request could not be completed",
      instance: r.routeOptions.url ?? r.url,
      correlationId: r.runtimeContext?.correlationId ?? r.id,
      errors: [],
    });
}
function codeOf(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof e.code === "string") {
    const code = e.code;
    if (
      [
        "VALIDATION_FAILED",
        "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
        "ORDER_NOT_FOUND",
        "ORDER_ITEM_NOT_FOUND",
        "ORDER_VERSION_CONFLICT",
        "ORDER_NOT_EDITABLE",
        "ORDER_QUOTE_STALE",
        "ORDER_EMPTY",
        "ORDER_ITEM_LIMIT_EXCEEDED",
        "ORDER_QUOTE_SCOPE_MISMATCH",
        "ORDER_DESIRED_OVERFLOW",
        "ORDER_CONFIRMATION_REJECTED",
        "AROMA_RECONCILIATION_NOT_ALLOWED",
        "IDEMPOTENCY_CONFLICT",
      ].includes(code)
    )
      return code;
    if (code === "PRICING_SCOPE_MISMATCH") return "ORDER_QUOTE_SCOPE_MISMATCH";
    if (["PRICING_STALE", "PRICING_QUOTE_EXPIRED"].includes(code))
      return "ORDER_QUOTE_STALE";
    if (code.startsWith("DB_") || code === "TRANSACTION_OUTCOME_UNKNOWN")
      return "INTERNAL_ERROR";
    if (code.startsWith("CUSTOMER_") || code.startsWith("PRICING_"))
      return code;
  }
  return "INTERNAL_ERROR";
}
function bodyBytes(r: Request): boolean {
  const n = header(r, "content-length");
  if (
    present(r, "content-length") &&
    (n === undefined || !/^\d+$/u.test(n) || Number(n) > 16_384)
  )
    return false;
  try {
    return (
      r.body === undefined ||
      Buffer.byteLength(JSON.stringify(r.body) ?? "") <= 16_384
    );
  } catch {
    return false;
  }
}
function uuid(v: string | undefined): v is string {
  return isOrdersIdempotencyKey(v);
}
function scope(method: string, path: string): string {
  return createHash("sha256")
    .update(`${method}\n${path}`, "utf8")
    .digest("hex");
}
function identity(claims: Claims, s: string, key: string): IdempotencyKey {
  return { actorRef: claims.sub, scope: s, key };
}
function validateContext(
  claims: Claims | undefined,
  operation: Operation,
  c: Context,
): boolean {
  return (
    !!claims &&
    claims.iss === "api-public" &&
    claims.aud === "orders-service" &&
    claims.originalIssuer === "edge-gateway" &&
    claims.operationId === operation &&
    !!claims.sub &&
    Array.isArray(claims.permissions) &&
    claims.permissions.includes(permissions[operation]) &&
    claims.correlationId === c.correlationId &&
    (c.traceparent === undefined || claims.traceparent === c.traceparent)
  );
}
async function authorize(
  r: Request,
  reply: Reply,
  a: OrdersHttpAdapters,
  operation: Operation,
  c: Context,
): Promise<Claims | null> {
  if (!a.verifyTransport(r, "api-public")) {
    problem(r, reply, "AUTHENTICATION_REQUIRED");
    return null;
  }
  if (spoofed(r)) {
    problem(r, reply, "ACTOR_CONTEXT_INVALID");
    return null;
  }
  const token = header(r, "x-actor-context");
  if (!token) {
    problem(
      r,
      reply,
      present(r, "x-actor-context")
        ? "ACTOR_CONTEXT_INVALID"
        : "AUTHENTICATION_REQUIRED",
    );
    return null;
  }
  try {
    const claims = await a.verifyPublicDelegation(
      token,
      operation,
      c.correlationId,
      c.signal,
    );
    if (!validateContext(claims, operation, c)) {
      problem(r, reply, "ACTOR_CONTEXT_INVALID");
      return null;
    }
    return claims;
  } catch {
    problem(r, reply, "ACTOR_CONTEXT_INVALID");
    return null;
  }
}
function replayHeader(r: Request): "normal" | "replay" | "invalid" {
  const v = header(r, "idempotency-replay-only");
  if (!present(r, "idempotency-replay-only")) return "normal";
  return v === "true" && r.body === undefined && !present(r, "if-match-version")
    ? "replay"
    : "invalid";
}
function sendCard(
  r: Request,
  reply: Reply,
  result: OrderCommandResult,
  expected: string,
  statuses: readonly number[],
): Reply {
  if (
    !statuses.includes(result.status) ||
    !isOrderCardResponse(result.body) ||
    result.body.orderRef !== expected
  )
    return problem(r, reply, "INTERNAL_ERROR");
  reply.header("cache-control", "no-store");
  if (result.replayed) reply.header("idempotency-replayed", "true");
  return reply.code(result.status).send(result.body);
}
function sendReconciliation(
  r: Request,
  reply: Reply,
  result: ReconciliationCommandResult,
  expected: string,
): Reply {
  if (
    result.status !== 202 ||
    !isReconciliationAcceptedResponse(result.body) ||
    result.body.orderRef !== expected
  )
    return problem(r, reply, "INTERNAL_ERROR");
  reply.header("cache-control", "no-store");
  if (result.replayed) reply.header("idempotency-replayed", "true");
  return reply.code(202).send(result.body);
}
function replayProblem(
  r: Request,
  reply: Reply,
  result: OrderReplayResult | OrderPrecheckResult,
): Reply | null {
  if (result.kind === "not_retained")
    return problem(r, reply, "IDEMPOTENCY_RESULT_NOT_RETAINED");
  if (result.kind === "in_progress")
    return problem(r, reply, "IDEMPOTENCY_REQUEST_IN_PROGRESS");
  if (result.kind === "conflict")
    return problem(r, reply, "IDEMPOTENCY_CONFLICT");
  if (result.kind === "invalid")
    return problem(r, reply, "IDEMPOTENCY_RESULT_INVALID");
  return null;
}
function replayCard(
  r: Request,
  reply: Reply,
  result: OrderReplayResult | OrderPrecheckResult,
  expectedStatus: 200 | 201,
  orderRef?: string,
): Reply {
  if (result.kind !== "completed")
    return (
      replayProblem(r, reply, result) ?? problem(r, reply, "INTERNAL_ERROR")
    );
  const saved = result.response;
  if (
    !isOrderCardResponse(saved.body) ||
    (orderRef !== undefined && saved.body.orderRef !== orderRef) ||
    saved.status !== expectedStatus
  )
    return problem(r, reply, "IDEMPOTENCY_RESULT_INVALID");
  reply
    .header("cache-control", "no-store")
    .header("idempotency-replayed", "true");
  return reply.code(saved.status).send(saved.body);
}
function replayReconciliation(
  r: Request,
  reply: Reply,
  result: OrderReplayResult | OrderPrecheckResult,
  orderRef: string,
): Reply {
  if (result.kind !== "completed")
    return (
      replayProblem(r, reply, result) ?? problem(r, reply, "INTERNAL_ERROR")
    );
  const saved = result.response;
  if (
    saved.status !== 202 ||
    saved.resourceRef !== orderRef ||
    !isReconciliationAcceptedResponse(saved.body) ||
    saved.body.orderRef !== orderRef
  )
    return problem(r, reply, "IDEMPOTENCY_RESULT_INVALID");
  return reply
    .header("cache-control", "no-store")
    .header("idempotency-replayed", "true")
    .code(202)
    .send(saved.body);
}
function traced(
  name: OrdersSpanName,
  handler: (r: Request, p: Reply) => Promise<Reply>,
): (r: Request, p: Reply) => Promise<Reply> {
  return (r, p) =>
    observe(
      name,
      () => handler(r, p),
      r.runtimeContext?.signal,
      () => p.statusCode >= 400,
    );
}
function commandContext(
  claims: Claims,
  ident: IdempotencyKey,
  c: Context,
  replayOnly: boolean,
): CommandContext {
  return {
    actorRef: claims.sub,
    permissions: claims.permissions,
    identity: ident,
    correlationId: c.correlationId,
    signal: c.signal,
    ...(c.traceparent === undefined ? {} : { traceparent: c.traceparent }),
    deadlineUtc: c.deadlineUtc,
    replayOnly,
  };
}
export function registerOrdersRoutes(app: App, a: OrdersHttpAdapters): void {
  const common = {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: 16_384,
    errorHandler: (_e: unknown, r: Request, p: Reply) =>
      problem(r, p, "VALIDATION_FAILED"),
  };
  app.post(paths.create, {
    ...common,
    handler: traced("orders.http.create", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "createOrderDraft", c);
      if (!claims) return p;
      const key = header(r, "idempotency-key");
      if (!uuid(key) || !bodyBytes(r))
        return problem(r, p, "VALIDATION_FAILED");
      const ident = identity(claims, scope("POST", paths.create), key),
        mode = replayHeader(r);
      if (mode === "invalid") return problem(r, p, "VALIDATION_FAILED");
      const request = isOrderDraftCreateRequest(r.body) ? r.body : undefined;
      if (mode === "normal" && !request)
        return problem(r, p, "VALIDATION_FAILED");
      try {
        const outcome = await createDraft(
          {
            store: a.owner.store,
            customer: a.owner.customer,
            signInternalDelegation: a.signInternalDelegation,
          },
          {
            ...commandContext(claims, ident, c, mode === "replay"),
            customerRef: request?.customerRef,
          },
        );
        if ("kind" in outcome) return replayCard(r, p, outcome, 201);
        return sendCard(r, p, outcome, outcome.body.orderRef, [201]);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
  app.get(paths.get, {
    ...common,
    handler: traced("orders.http.get", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "getOrderCard", c);
      if (!claims) return p;
      const orderRef = param(r, "orderRef");
      if (!isOrderRef(orderRef)) return problem(r, p, "VALIDATION_FAILED");
      try {
        const card = await getOrderCard(a.owner.store, {
          orderRef,
          permissions: claims.permissions,
          correlationId: c.correlationId,
          signal: c.signal,
        });
        if (!isOrderCardResponse(card) || card.orderRef !== orderRef)
          return problem(r, p, "INTERNAL_ERROR");
        return p.header("cache-control", "no-store").code(200).send(card);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
  app.put(paths.put, {
    ...common,
    handler: traced("orders.http.put", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "upsertOrderItem", c);
      if (!claims) return p;
      const orderRef = param(r, "orderRef"),
        itemRef = param(r, "itemRef");
      if (!isOrderRef(orderRef) || !isItemRef(itemRef))
        return problem(r, p, "VALIDATION_FAILED");
      const key = header(r, "idempotency-key");
      if (!uuid(key) || !bodyBytes(r))
        return problem(r, p, "VALIDATION_FAILED");
      const ident = identity(
          claims,
          scope("PUT", `${BASE}/${orderRef}/items/${itemRef}`),
          key,
        ),
        mode = replayHeader(r);
      if (mode === "invalid") return problem(r, p, "VALIDATION_FAILED");
      const request = isOrderItemPutRequest(r.body) ? r.body : undefined;
      if (mode === "normal" && !request)
        return problem(r, p, "VALIDATION_FAILED");
      try {
        const outcome = await upsertItem(
          {
            store: a.owner.store,
            pricing: a.owner.pricing,
            signInternalDelegation: a.signInternalDelegation,
          },
          {
            ...commandContext(claims, ident, c, mode === "replay"),
            orderRef,
            itemRef,
            request,
          },
        );
        if ("kind" in outcome) return replayCard(r, p, outcome, 200, orderRef);
        return sendCard(r, p, outcome, orderRef, [200]);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
  app.delete(paths.remove, {
    ...common,
    handler: traced("orders.http.remove", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "removeOrderItem", c);
      if (!claims) return p;
      const orderRef = param(r, "orderRef"),
        itemRef = param(r, "itemRef");
      if (!isOrderRef(orderRef) || !isItemRef(itemRef))
        return problem(r, p, "VALIDATION_FAILED");
      const key = header(r, "idempotency-key"),
        version = header(r, "if-match-version");
      if (!uuid(key) || r.body !== undefined)
        return problem(r, p, "VALIDATION_FAILED");
      const ident = identity(
          claims,
          scope("DELETE", `${BASE}/${orderRef}/items/${itemRef}`),
          key,
        ),
        mode = replayHeader(r);
      if (mode === "invalid") return problem(r, p, "VALIDATION_FAILED");
      if (mode === "normal" && !isIfMatchVersion(version))
        return problem(r, p, "VALIDATION_FAILED");
      try {
        const outcome = await deleteItem(a.owner.store, {
          ...commandContext(claims, ident, c, mode === "replay"),
          orderRef,
          itemRef,
          expectedVersion: version,
        });
        if ("kind" in outcome) return replayCard(r, p, outcome, 200, orderRef);
        return sendCard(r, p, outcome, orderRef, [200]);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
  app.post(paths.confirm, {
    ...common,
    handler: traced("orders.http.confirm", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "confirmOrder", c);
      if (!claims) return p;
      const orderRef = param(r, "orderRef");
      if (!isOrderRef(orderRef)) return problem(r, p, "VALIDATION_FAILED");
      const key = header(r, "idempotency-key");
      if (!uuid(key) || !bodyBytes(r))
        return problem(r, p, "VALIDATION_FAILED");
      const ident = identity(
          claims,
          scope("POST", `${BASE}/${orderRef}/commands/confirm`),
          key,
        ),
        mode = replayHeader(r);
      if (mode === "invalid") return problem(r, p, "VALIDATION_FAILED");
      const request = isOrderConfirmRequest(r.body) ? r.body : undefined;
      if (mode === "normal" && !request)
        return problem(r, p, "VALIDATION_FAILED");
      try {
        const outcome = await confirmOrder(a.owner.store, {
          ...commandContext(claims, ident, c, mode === "replay"),
          orderRef,
          expectedVersion: request?.expectedVersion,
        });
        if ("kind" in outcome) return replayCard(r, p, outcome, 200, orderRef);
        return sendCard(r, p, outcome, orderRef, [200]);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
  app.post(paths.reconcile, {
    ...common,
    handler: traced("orders.http.reconcile", async (r: Request, p: Reply) => {
      const c = ctx(r),
        claims = await authorize(r, p, a, "requestAromaReconciliation", c);
      if (!claims) return p;
      const orderRef = param(r, "orderRef");
      if (!isOrderRef(orderRef)) return problem(r, p, "VALIDATION_FAILED");
      const key = header(r, "idempotency-key");
      if (!uuid(key) || !bodyBytes(r))
        return problem(r, p, "VALIDATION_FAILED");
      const ident = identity(
          claims,
          scope(
            "POST",
            `${BASE}/${orderRef}/commands/request-aroma-reconciliation`,
          ),
          key,
        ),
        mode = replayHeader(r);
      if (mode === "invalid") return problem(r, p, "VALIDATION_FAILED");
      const request = isReconciliationRequest(r.body) ? r.body : undefined;
      if (mode === "normal" && !request)
        return problem(r, p, "VALIDATION_FAILED");
      try {
        const outcome = await requestAromaReconciliation(a.owner.store, {
          ...commandContext(claims, ident, c, mode === "replay"),
          orderRef,
          expectedVersion: request?.expectedVersion,
          reason: request?.reason,
        });
        if ("kind" in outcome)
          return replayReconciliation(r, p, outcome, orderRef);
        return sendReconciliation(r, p, outcome, orderRef);
      } catch (e) {
        return problem(r, p, codeOf(e));
      }
    }),
  });
}
