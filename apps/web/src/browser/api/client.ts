import type {
  CatalogProductSummary,
  CatalogSearchResponse,
  CustomerCreateRequest,
  CustomerResponse,
  CustomerSearchResponse,
  OrderCardResponse,
  OrderItemPutRequest,
  PricingQuoteCreateRequest,
  PricingQuoteResponse,
  ProblemDetails,
  ReconciliationAcceptedResponse,
} from "@coffee-platform/generated-client-v1";
import type { BrowserSession } from "@coffee-platform/generated-edge-auth-v1";
import { clientV1Schemas } from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import { edgeAuthV1Schemas } from "@coffee-platform/generated-edge-auth-v1/runtime-schemas.gen.js";
import { assertSchema } from "./schema.js";
import {
  beginIntent,
  completeIntent,
  markIntentAmbiguous,
  type CommandKind,
  type PendingIntent,
} from "./idempotency.js";
import { assertApplicationSession, captureApplicationSession } from "./session-identity.js";
import { currentEpochMilliseconds, instantEpochMilliseconds } from "./time.js";

export const SESSION_INVALIDATED = "coffee:session-invalidated";
export const BROWSER_TELEMETRY = "coffee:browser-telemetry";

export class ApiError extends Error {
  readonly problem: ProblemDetails;
  readonly replayed: boolean;
  readonly terminal: boolean;

  constructor(problem: ProblemDetails, replayed: boolean, terminal: boolean) {
    super(problem.detail);
    this.name = "ApiError";
    this.problem = problem;
    this.replayed = replayed;
    this.terminal = terminal;
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export class PendingIntentError extends Error {
  constructor() {
    super("У команды уже есть неподтверждённый результат. Сначала проверьте его в панели восстановления.");
    this.name = "PendingIntentError";
  }
}

export function isRetryableQueryError(error: unknown): boolean {
  if (error instanceof ApiError) return [502, 503, 504].includes(error.problem.status);
  return error instanceof TypeError;
}

const clientSchemas = clientV1Schemas as Record<string, unknown>;
const edgeSchemas = edgeAuthV1Schemas as Record<string, unknown>;

function csrfToken(): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "__Host-coffee-csrf") return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function requireCsrfToken(): string {
  const token = csrfToken();
  if (!token) throw new ProtocolError("CSRF-токен сессии отсутствует");
  return token;
}

function assertCsrfSession(token: string): void {
  if (csrfToken() === token) return;
  window.dispatchEvent(new Event(SESSION_INVALIDATED));
  throw new ProtocolError("Сессия браузера изменилась; команда не отправлена");
}

function telemetryName(input: Readonly<{ method: "GET" | "POST" | "PUT" | "DELETE"; replayOnly?: boolean }>): string {
  if (input.replayOnly) return "ui.recovery.result";
  return input.method === "GET" ? "ui.query.result" : "ui.command.result";
}

function telemetryEndpoint(path: string): string {
  const pathname = new URL(path, window.location.origin).pathname;
  return pathname.replace(/\/(?:ord|itm|cus|prd|var|prq|pvr)_[0-9A-HJKMNP-TV-Z]{26}/gu, "/:ref");
}

function emitTelemetry(
  input: Readonly<{ method: "GET" | "POST" | "PUT" | "DELETE"; path: string; replayOnly?: boolean }>,
  result: string,
  startedAt: number,
  correlationId: string,
): void {
  window.dispatchEvent(new CustomEvent(BROWSER_TELEMETRY, { detail: {
    correlationId,
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    endpoint: telemetryEndpoint(input.path),
    name: telemetryName(input),
    result,
    route: telemetryEndpoint(window.location.pathname),
  } }));
}

const terminalCommandCodes = new Set([
  "VALIDATION_FAILED",
  "CUSTOMER_PHONE_CONFLICT",
  "CUSTOMER_EMAIL_CONFLICT",
  "CATALOG_PRODUCT_NOT_FOUND",
  "CATALOG_PRODUCT_UNAVAILABLE",
  "CATALOG_REVISION_CHANGED",
  "PRICING_GRIND_NOT_AVAILABLE",
  "CUSTOMER_NOT_FOUND",
  "CUSTOMER_NOT_ACTIVE",
  "ORDER_NOT_FOUND",
  "ORDER_ITEM_NOT_FOUND",
  "ORDER_VERSION_CONFLICT",
  "ORDER_QUOTE_STALE",
  "ORDER_NOT_EDITABLE",
  "ORDER_ITEM_LIMIT_EXCEEDED",
  "ORDER_QUOTE_SCOPE_MISMATCH",
  "ORDER_CONFIRMATION_REJECTED",
  "ORDER_EMPTY",
  "ORDER_DESIRED_OVERFLOW",
  "AROMA_RECONCILIATION_NOT_ALLOWED",
]);

const terminalProblemsByCommand: Readonly<Record<CommandKind, Readonly<Record<string, number>>>> = {
  "create-customer": { CUSTOMER_EMAIL_CONFLICT: 409, CUSTOMER_PHONE_CONFLICT: 409, VALIDATION_FAILED: 400 },
  "create-quote": { CATALOG_PRODUCT_NOT_FOUND: 404, CATALOG_PRODUCT_UNAVAILABLE: 409, CATALOG_REVISION_CHANGED: 409, PRICING_GRIND_NOT_AVAILABLE: 422, VALIDATION_FAILED: 400 },
  "create-draft": { CUSTOMER_NOT_ACTIVE: 409, CUSTOMER_NOT_FOUND: 404, VALIDATION_FAILED: 400 },
  "put-item": {
    CATALOG_PRODUCT_NOT_FOUND: 404,
    ORDER_ITEM_LIMIT_EXCEEDED: 409,
    ORDER_NOT_EDITABLE: 409,
    ORDER_NOT_FOUND: 404,
    ORDER_QUOTE_SCOPE_MISMATCH: 409,
    ORDER_QUOTE_STALE: 409,
    ORDER_VERSION_CONFLICT: 409,
    VALIDATION_FAILED: 400,
  },
  "delete-item": { ORDER_ITEM_NOT_FOUND: 404, ORDER_NOT_EDITABLE: 409, ORDER_NOT_FOUND: 404, ORDER_VERSION_CONFLICT: 409, VALIDATION_FAILED: 400 },
  "confirm-order": {
    ORDER_CONFIRMATION_REJECTED: 422,
    ORDER_DESIRED_OVERFLOW: 422,
    ORDER_EMPTY: 422,
    ORDER_NOT_EDITABLE: 409,
    ORDER_NOT_FOUND: 404,
    ORDER_QUOTE_STALE: 409,
    ORDER_VERSION_CONFLICT: 409,
    VALIDATION_FAILED: 400,
  },
  "request-reconciliation": { AROMA_RECONCILIATION_NOT_ALLOWED: 409, ORDER_NOT_FOUND: 404, ORDER_VERSION_CONFLICT: 409, VALIDATION_FAILED: 400 },
};

export function isTerminalCommandProblem(problem: ProblemDetails): boolean {
  return terminalCommandCodes.has(problem.code);
}

export function isTerminalProblemForCommand(kind: CommandKind, problem: ProblemDetails): boolean {
  return terminalProblemsByCommand[kind][problem.code] === problem.status;
}

function terminalProblem(problem: ProblemDetails, response: Response, replayOnly: boolean, commandKind?: CommandKind): boolean {
  if (replayOnly) {
    return response.headers.get("Idempotency-Replayed") === "true"
      && commandKind !== undefined
      && isTerminalProblemForCommand(commandKind, problem);
  }
  return commandKind !== undefined && isTerminalProblemForCommand(commandKind, problem);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    throw new ProtocolError(`HTTP ${response.status}: ответ не является JSON`);
  }
}

async function request<T>(input: Readonly<{
  body?: unknown;
  commandKind?: CommandKind;
  expected: readonly number[];
  headers?: Readonly<Record<string, string>>;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  replayOnly?: boolean;
  schema: unknown;
  signal?: AbortSignal;
}>): Promise<T> {
  const startedAt = performance.now();
  const correlationId = crypto.randomUUID();
  const headers = new Headers({ Accept: "application/json", "X-Correlation-ID": correlationId, ...input.headers });
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  if (input.method !== "GET" && !headers.has("X-CSRF-Token")) {
    const csrf = csrfToken();
    if (!csrf) {
      emitTelemetry(input, "blocked:csrf", startedAt, correlationId);
      throw new ProtocolError("CSRF-токен сессии отсутствует");
    }
    headers.set("X-CSRF-Token", csrf);
  }
  let response: Response;
  try {
    response = await fetch(input.path, {
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      credentials: "same-origin",
      headers,
      method: input.method,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    emitTelemetry(input, "network-error", startedAt, correlationId);
    throw error;
  }
  const replayed = response.headers.get("Idempotency-Replayed") === "true";
  if (!response.ok) {
    if (input.path !== "/auth/session" && response.status === 401) window.dispatchEvent(new Event(SESSION_INVALIDATED));
    try {
      const value = await parseJson(response);
      let problem: ProblemDetails;
      try {
        problem = assertSchema<ProblemDetails>(clientSchemas["ProblemDetails"], value, "Problem Details");
      } catch {
        problem = assertSchema<ProblemDetails>(edgeSchemas["ProblemDetails"], value, "Problem Details");
      }
      if (problem.status !== response.status) {
        throw new ProtocolError(`HTTP status ${response.status} не совпадает с Problem Details status ${problem.status}`);
      }
      emitTelemetry(input, `problem:${problem.code}`, startedAt, correlationId);
      throw new ApiError(problem, replayed, terminalProblem(problem, response, input.replayOnly === true, input.commandKind));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      emitTelemetry(input, "protocol-error", startedAt, correlationId);
      throw error;
    }
  }
  if (!input.expected.includes(response.status)) {
    emitTelemetry(input, "protocol-status", startedAt, correlationId);
    throw new ProtocolError(`Неожиданный HTTP status ${response.status}`);
  }
  if (input.replayOnly && !replayed) {
    emitTelemetry(input, "protocol-replay", startedAt, correlationId);
    throw new ProtocolError("Replay-only lookup не вернул Idempotency-Replayed: true");
  }
  if (response.status === 204) {
    emitTelemetry(input, `http:${response.status}`, startedAt, correlationId);
    return undefined as T;
  }
  try {
    const result = assertSchema<T>(input.schema, await parseJson(response), input.path);
    emitTelemetry(input, `http:${response.status}`, startedAt, correlationId);
    return result;
  } catch (error) {
    emitTelemetry(input, "protocol-error", startedAt, correlationId);
    throw error;
  }
}

async function assertFreshCommandSession(actorRef: string, capturedSession: ReturnType<typeof captureApplicationSession>): Promise<void> {
  try {
    const fresh = await request<BrowserSession>({
      expected: [200],
      method: "GET",
      path: "/auth/session",
      schema: edgeSchemas["BrowserSession"],
    });
    assertApplicationSession(capturedSession);
    if (instantEpochMilliseconds(fresh.expiresAt) <= currentEpochMilliseconds()) {
      window.dispatchEvent(new Event(SESSION_INVALIDATED));
      throw new ProtocolError("Сессия оператора истекла до отправки команды");
    }
    if (fresh.actorRef !== actorRef) {
      window.dispatchEvent(new Event(SESSION_INVALIDATED));
      throw new ProtocolError("Серверная сессия сменилась; команда не отправлена");
    }
  } catch (error) {
    if (error instanceof ApiError && error.problem.status === 401) window.dispatchEvent(new Event(SESSION_INVALIDATED));
    throw error;
  }
}

async function command<T>(input: Readonly<{
  actorRef: string;
  body?: unknown;
  expected: readonly number[];
  headers?: Readonly<Record<string, string>>;
  kind: CommandKind;
  method: PendingIntent["method"];
  path: string;
  schema: unknown;
}>): Promise<T> {
  const session = captureApplicationSession(input.actorRef);
  const csrf = csrfToken();
  if (!csrf) {
    emitTelemetry({ method: input.method, path: input.path }, "blocked:csrf", performance.now(), crypto.randomUUID());
    throw new ProtocolError("CSRF-токен сессии отсутствует");
  }
  await assertFreshCommandSession(input.actorRef, session);
  assertCsrfSession(csrf);
  const begun = await beginIntent({
    actorRef: input.actorRef,
    body: input.body ?? input.headers ?? null,
    kind: input.kind,
    method: input.method,
    path: input.path,
  });
  if (!begun.created) throw new PendingIntentError();
  const intent = begun.intent;
  try {
    assertApplicationSession(session);
    assertCsrfSession(csrf);
  } catch (error) {
    completeIntent(intent.key);
    throw error;
  }
  try {
    const result = await request<T>({
      body: input.body,
      commandKind: input.kind,
      expected: input.expected,
      headers: { "Idempotency-Key": intent.key, "X-CSRF-Token": csrf, ...input.headers },
      method: input.method,
      path: input.path,
      schema: input.schema,
    });
    assertApplicationSession(session);
    completeIntent(intent.key);
    return result;
  } catch (error) {
    try {
      assertApplicationSession(session);
    } catch (sessionError) {
      markIntentAmbiguous(intent);
      throw sessionError;
    }
    if (error instanceof ApiError && error.terminal) completeIntent(intent.key);
    else markIntentAmbiguous(intent);
    throw error;
  }
}

function search(path: string, params: Readonly<Record<string, string | undefined>>): string {
  const url = new URL(path, window.location.origin);
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(name, value);
  return `${url.pathname}${url.search}`;
}

function encoded(ref: string): string {
  return encodeURIComponent(ref);
}

export const api = {
  getSession: (signal?: AbortSignal): Promise<BrowserSession> => request({
    expected: [200],
    method: "GET",
    path: "/auth/session",
    schema: edgeSchemas["BrowserSession"],
    ...(signal ? { signal } : {}),
  }),
  logout: (): Promise<void> => request({
    expected: [204],
    method: "POST",
    path: "/auth/logout",
    schema: true,
  }),
  searchCustomers: (query: string, cursor?: string, signal?: AbortSignal): Promise<CustomerSearchResponse> => request({
    expected: [200],
    method: "GET",
    path: search("/api/client-v1/customers", { cursor, limit: "20", query }),
    schema: clientSchemas["CustomerSearchResponse"],
    ...(signal ? { signal } : {}),
  }),
  createCustomer: (actorRef: string, body: CustomerCreateRequest): Promise<CustomerResponse> => command({
    actorRef,
    body,
    expected: [201],
    kind: "create-customer",
    method: "POST",
    path: "/api/client-v1/customers",
    schema: clientSchemas["CustomerResponse"],
  }),
  searchCatalog: (query: string, availability: CatalogProductSummary["availability"] | "", cursor?: string, signal?: AbortSignal): Promise<CatalogSearchResponse> => request({
    expected: [200],
    method: "GET",
    path: search("/api/client-v1/catalog/products", { availability: availability || undefined, cursor, limit: "20", query }),
    schema: clientSchemas["CatalogSearchResponse"],
    ...(signal ? { signal } : {}),
  }),
  createQuote: (actorRef: string, body: PricingQuoteCreateRequest): Promise<PricingQuoteResponse> => command({
    actorRef,
    body,
    expected: [201],
    kind: "create-quote",
    method: "POST",
    path: "/api/client-v1/pricing/quotes",
    schema: clientSchemas["PricingQuoteResponse"],
  }),
  createDraft: (actorRef: string, customerRef: string): Promise<OrderCardResponse> => command({
    actorRef,
    body: { customerRef },
    expected: [201],
    kind: "create-draft",
    method: "POST",
    path: "/api/client-v1/orders/drafts",
    schema: clientSchemas["OrderCardResponse"],
  }),
  getOrderCard: (orderRef: string, signal?: AbortSignal): Promise<OrderCardResponse> => request({
    expected: [200],
    method: "GET",
    path: `/api/client-v1/orders/${encoded(orderRef)}`,
    schema: clientSchemas["OrderCardResponse"],
    ...(signal ? { signal } : {}),
  }),
  putOrderItem: (actorRef: string, orderRef: string, itemRef: string, body: OrderItemPutRequest): Promise<OrderCardResponse> => command({
    actorRef,
    body,
    expected: [200],
    kind: "put-item",
    method: "PUT",
    path: `/api/client-v1/orders/${encoded(orderRef)}/items/${encoded(itemRef)}`,
    schema: clientSchemas["OrderCardResponse"],
  }),
  deleteOrderItem: (actorRef: string, orderRef: string, itemRef: string, expectedVersion: string): Promise<OrderCardResponse> => command({
    actorRef,
    expected: [200],
    headers: { "If-Match-Version": expectedVersion },
    kind: "delete-item",
    method: "DELETE",
    path: `/api/client-v1/orders/${encoded(orderRef)}/items/${encoded(itemRef)}`,
    schema: clientSchemas["OrderCardResponse"],
  }),
  confirmOrder: (actorRef: string, orderRef: string, expectedVersion: string): Promise<OrderCardResponse> => command({
    actorRef,
    body: { expectedVersion },
    expected: [200],
    kind: "confirm-order",
    method: "POST",
    path: `/api/client-v1/orders/${encoded(orderRef)}/commands/confirm`,
    schema: clientSchemas["OrderCardResponse"],
  }),
  requestReconciliation: (actorRef: string, orderRef: string, expectedVersion: string, reason: string): Promise<ReconciliationAcceptedResponse> => command({
    actorRef,
    body: { expectedVersion, reason },
    expected: [202],
    kind: "request-reconciliation",
    method: "POST",
    path: `/api/client-v1/orders/${encoded(orderRef)}/commands/request-aroma-reconciliation`,
    schema: clientSchemas["ReconciliationAcceptedResponse"],
  }),
  replayIntent: async (intent: PendingIntent): Promise<CustomerResponse | PricingQuoteResponse | OrderCardResponse | ReconciliationAcceptedResponse> => {
    const session = captureApplicationSession(intent.actorRef);
    const csrf = requireCsrfToken();
    await assertFreshCommandSession(intent.actorRef, session);
    assertCsrfSession(csrf);
    const schemaName = intent.kind === "create-customer" ? "CustomerResponse"
      : intent.kind === "create-quote" ? "PricingQuoteResponse"
        : intent.kind === "request-reconciliation" ? "ReconciliationAcceptedResponse"
          : "OrderCardResponse";
    try {
      const result = await request<CustomerResponse | PricingQuoteResponse | OrderCardResponse | ReconciliationAcceptedResponse>({
        commandKind: intent.kind,
        expected: intent.kind === "create-customer" || intent.kind === "create-draft" ? [200, 201]
          : intent.kind === "request-reconciliation" ? [202]
            : [200, 201],
        headers: {
          "X-CSRF-Token": csrf,
          "Idempotency-Key": intent.key,
          "Idempotency-Replay-Only": "true",
        },
        method: intent.method,
        path: intent.path,
        replayOnly: true,
        schema: clientSchemas[schemaName],
      });
      assertApplicationSession(session);
      completeIntent(intent.key);
      return result;
    } catch (error) {
      assertApplicationSession(session);
      if (error instanceof ApiError && error.replayed && error.terminal) completeIntent(intent.key);
      throw error;
    }
  },
};
