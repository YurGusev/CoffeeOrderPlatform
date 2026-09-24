import {createPrivateKey, createPublicKey, randomUUID} from "node:crypto";
import {aromaContractSchemas, isAromaCatalogExportRequest, isAromaCartSnapshot, isAromaCartSnapshotReadRequest, isAromaOfferBindingRequest, isAromaOfferBindingResponse, isAromaProblem, isAromaMutationResponse, isAromaRemoveLineRequest, isAromaSetQuantityRequest, type AromaCatalogExportRequest, type AromaCartSnapshotReadRequest, type AromaOfferBindingRequest, type AromaRemoveLineRequest, type AromaSetQuantityRequest} from "@coffee-platform/contracts-aroma-v1";
import {customerContractSchemas, customerErrorPolicy, customerErrorPolicyEntry, customerResponseSchema, isCustomerOrderInput, isCustomerProblem, isCustomerRef} from "@coffee-platform/contracts-customer-v1";
import {catalogContractSchemas, catalogResponseSchema, isCatalogOperationProblem, isCatalogPricingInput, isCatalogProductRef, isCatalogVariantRef} from "@coffee-platform/contracts-catalog-v1";
import type {CatalogPricingInput} from "@coffee-platform/contracts-catalog-v1";
import type {CustomerOrderInput} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeCompositionContext, RuntimeRequestContext} from "@coffee-platform/runtime";
import {parseServiceTransportMaterial, signServiceDelegation, verifyServiceDelegationWithKeySet, type ServiceTransportMaterial} from "@coffee-platform/security";

type HeaderValue = string | string[] | undefined;
type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
  body?: unknown;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{url: string | undefined}>;
  url: string;
  params: unknown;
}>;
type Reply = {
  header: (name: string, value: string) => Reply;
  code: (status: number) => Reply;
  type: (value: string) => Reply;
  send: (body?: unknown) => Reply;
};
type HttpClient = Readonly<{fetch: (path: string, options?: RequestInit) => Promise<Response>}>;
type Context = Readonly<{correlationId: string; traceparent?: string; signal: AbortSignal}>;
type ForwardResult = Readonly<{status: number; body: unknown}>;
type CatalogForwardResult = Readonly<{status: number; body: ReadableStream<Uint8Array> | Record<string, unknown>}>;
type CatalogPricingForwardResult = Readonly<{status: 200; body: CatalogPricingInput} | {status: 404 | 503; body: unknown}>;
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

type AromaCaller = "orders-service" | "catalog-activation-worker" | "catalog-supplier-sync" | "aroma-observer" | "aroma-convergence";
type InternalTransportCaller = AromaCaller | "pricing-service";
type CartMutationCaller = "aroma-convergence";
export type InternalCallerClaims = Readonly<{
  iss: string;
  aud: string;
  originalCaller: string;
  operationId: string;
  correlationId: string;
  traceparent: string;
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}>;

export type InternalApiAdapters = Readonly<{
  verifyTransport: (request: Request, expectedCaller: InternalTransportCaller) => boolean;
  verifyCallerDelegation: (token: string, request: Request, operationId: string, signal: AbortSignal) => Promise<InternalCallerClaims> | InternalCallerClaims;
  signDelegation: (claims: Readonly<{originalCaller: string; operationId: string; context: Context}>) => string;
  customer: Readonly<{orderInput: (customerRef: string, context: Context, delegation: string) => Promise<ForwardResult>}>;
  binding: Readonly<{register: (body: AromaOfferBindingRequest, context: Context, delegation: string) => Promise<ForwardResult>}>;
  catalog: Readonly<{export: (body: AromaCatalogExportRequest, context: Context, delegation: string) => Promise<CatalogForwardResult>; pricingInput: (productRef: string, variantRef: string, context: Context, delegation: string) => Promise<CatalogPricingForwardResult>}>;
  cart: Readonly<{
    read: (body: AromaCartSnapshotReadRequest, context: Context, delegation: string) => Promise<ForwardResult>;
    setQuantity: (offerRef: string, body: AromaSetQuantityRequest, context: Context, delegation: string) => Promise<ForwardResult>;
    remove: (offerRef: string, body: AromaRemoveLineRequest, context: Context, delegation: string) => Promise<ForwardResult>;
  }>;
}>;

const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const OFFER_REF = new RegExp(`^off_${ULID}$`, "u");

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function oneHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function context(request: Request, timeoutMs: number): Context {
  const runtime: RuntimeRequestContext | null | undefined = request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  return {
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined ? {} : {traceparent: runtime.traceparent}),
    signal: AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]),
  };
}

function problem(request: Request, status: number, code: string, detail: string): Problem {
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
  return reply.header("cache-control", "no-store").code(body.status).type("application/problem+json").send(body);
}

function sendForward(request: Request, reply: Reply, result: ForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) {
    if (!isCustomerProblem(result.body)) return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail));
    const policy = customerErrorPolicyEntry(result.body.code);
    return sendProblem(reply, policy !== undefined && policy.status === result.body.status
      ? problem(request, policy.status, result.body.code, policy.detail)
      : problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail));
  }
  if (!isCustomerOrderInput(result.body)) return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail));
  return reply.code(result.status).send(result.body);
}

const BINDING_ERROR_CODES = new Set(["AROMA_BINDING_CONFLICT", "AROMA_BINDING_SOURCE_NOT_FOUND", "AROMA_BINDING_SNAPSHOT_INCOMPLETE"]);
function sendBindingForward(request: Request, reply: Reply, result: ForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) {
    if (!isAromaProblem(result.body) || !BINDING_ERROR_CODES.has(result.body.code) || result.body.status !== result.status) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding gateway returned an invalid response"));
    return sendProblem(reply, problem(request, result.status, result.body.code, "immutable binding request was rejected"));
  }
  if (result.status !== 200 || !isAromaOfferBindingResponse(result.body)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding gateway returned an invalid response"));
  return reply.code(200).send(result.body);
}

const AROMA_MUTATION_ERROR_CODES = new Set(["AROMA_CART_ITEM_NOT_FOUND", "AROMA_OPERATION_REF_CONFLICT", "AROMA_OPERATION_IN_PROGRESS", "AROMA_OPERATION_UNKNOWN_OUTCOME", "AROMA_PROVIDER_UNAVAILABLE"]);
function sendCatalogPricingForward(request: Request, reply: Reply, result: CatalogPricingForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status === 200 && isCatalogPricingInput(result.body)) return reply.code(200).send(result.body as CatalogPricingInput);
  if (isCatalogOperationProblem(result.body, "pricing", result.status)) {
    return sendProblem(reply, problem(request, result.status, result.body.code, "catalog pricing request failed"));
  }
  return sendProblem(reply, problem(request, 503, "CATALOG_UNAVAILABLE", "catalog owner returned an invalid response"));
}

function sendAromaMutationForward(request: Request, reply: Reply, result: ForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) {
    if (!isAromaProblem(result.body) || !AROMA_MUTATION_ERROR_CODES.has(result.body.code) || result.body.status !== result.status) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway returned an invalid response"));
    return sendProblem(reply, problem(request, result.status, result.body.code, "aroma cart operation was not acknowledged"));
  }
  if (result.status !== 200 || !isAromaMutationResponse(result.body)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway returned an invalid response"));
  return reply.code(200).send(result.body);
}

const AROMA_EXPORT_ERROR_CODES = new Set(["AROMA_PROVIDER_UNAVAILABLE"]);
function sendAromaCatalogForward(request: Request, reply: Reply, result: CatalogForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) {
    if (!isAromaProblem(result.body) || !AROMA_EXPORT_ERROR_CODES.has(result.body.code) || result.body.status !== result.status) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway returned an invalid response"));
    return sendProblem(reply, problem(request, result.status, result.body.code, "aroma catalog export is unavailable"));
  }
  if (result.status !== 200 || !(result.body instanceof ReadableStream)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway returned an invalid stream"));
  return reply.header("content-type", "application/x-ndjson").code(200).send(result.body);
}

function sendCartForward(request: Request, reply: Reply, result: ForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.status !== 200 || !isAromaCartSnapshot(result.body)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway returned an invalid response"));
  return reply.code(200).send(result.body);
}

function spoofed(request: Request): boolean {
  const blocked = ["x-actor-ref", "x-actor-permissions", "x-original-issuer", "x-original-caller", "x-service-identity", "x-transport-caller", "x-actor-context"];
  return blocked.some((name) => header(request, name) !== undefined) || Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-actor-"));
}

function trustedCaller(request: Request, allowed: readonly AromaCaller[]): AromaCaller | undefined {
  const caller = request.runtimeContext?.transportIdentity?.runtime;
  return caller !== undefined && (allowed as readonly string[]).includes(caller) ? caller as AromaCaller : undefined;
}

function paramsRecord(request: Request): Record<string, unknown> {
  return request.params !== null && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};
}

function operationOfferRef(request: Request, suffix: ":set" | ":remove"): string | undefined {
  const value = paramsRecord(request)[suffix === ":set" ? "offerRef:set" : "offerRef:remove"];
  if (typeof value !== "string" || !value.endsWith(suffix)) return undefined;
  const offerRef = value.slice(0, -suffix.length);
  return OFFER_REF.test(offerRef) ? offerRef : undefined;
}

function operationSchemaResponse(): Readonly<Record<number, unknown>> {
  return {200: aromaContractSchemas["mutationResponse"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 404: aromaContractSchemas["problem"], 409: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]};
}

export function registerInternalRoutes(app: RuntimeApp, adapters: InternalApiAdapters): void {
  app.post("/api/internal-v1/aroma/offer-bindings", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (error, request, rawReply) => sendProblem(rawReply as unknown as Reply, problem(request, 400, "VALIDATION_FAILED", error instanceof Error && error.message === "invalid" ? "Request validation failed" : "Request validation failed")),
    schema: {response: {200: aromaContractSchemas["offerBindingResponse"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 409: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (header(request, "x-service-delegation") !== undefined || spoofed(request)) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller-supplied delegation is forbidden"));
      if (!adapters.verifyTransport(request, "catalog-activation-worker")) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      if (!isAromaOfferBindingRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const requestContext = context(request, 10_000);
      const delegation = adapters.signDelegation({originalCaller: "catalog-activation-worker", operationId: "registerAromaOfferBinding", context: requestContext});
      try { return sendBindingForward(request, reply, await adapters.binding.register(request.body, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway is unavailable")); }
    },
  });

  app.get("/api/internal-v1/customers/:customerRef/order-input", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {response: customerResponseSchema(customerContractSchemas.orderInput, 200, [400, 401, 403, 404, 500, 503])},
    handler: async (request, reply) => {
      if (spoofed(request) || !adapters.verifyTransport(request, "orders-service")) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      const token = oneHeader(header(request, "x-service-delegation"));
      if (token === undefined) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "signed service delegation is required"));
      const requestContext = context(request, 5_000);
      let claims: InternalCallerClaims;
      try { claims = await adapters.verifyCallerDelegation(token, request, "getCustomerOrderInput", requestContext.signal); }
      catch { return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed")); }
      if (claims.iss !== "orders-service" || claims.aud !== "api-internal" || claims.originalCaller !== "orders-service" || claims.operationId !== "getCustomerOrderInput") return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      const params = paramsRecord(request);
      const customerRef = params["customerRef"];
      if (!isCustomerRef(customerRef)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const delegation = adapters.signDelegation({originalCaller: "orders-service", operationId: "getCustomerOrderInput", context: requestContext});
      try { return sendForward(request, reply, await adapters.customer.orderInput(customerRef, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", "customer service is unavailable")); }
    },
  });

  app.get("/api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {response: catalogResponseSchema(catalogContractSchemas.pricingInput, 200, [400, 401, 403, 404, 503])},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (spoofed(request) || !adapters.verifyTransport(request, "pricing-service")) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "pricing service identity is required"));
      const token = oneHeader(header(request, "x-service-delegation"));
      if (token === undefined) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "signed service delegation is required"));
      const requestContext = context(request, 2_000);
      let claims: InternalCallerClaims;
      try { claims = await adapters.verifyCallerDelegation(token, request, "getCatalogPricingInput", requestContext.signal); }
      catch { return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed")); }
      if (claims.iss !== "pricing-service" || claims.aud !== "api-internal" || claims.originalCaller !== "pricing-service" || claims.operationId !== "getCatalogPricingInput") return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      const params = paramsRecord(request);
      const rawProductRef = params["productRef"];
      const rawVariantRef = params["variantRef"];
      if (!isCatalogProductRef(rawProductRef) || !isCatalogVariantRef(rawVariantRef)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const productRef = rawProductRef as string;
      const variantRef = rawVariantRef as string;
      const delegation = adapters.signDelegation({originalCaller: "pricing-service", operationId: "getCatalogPricingInput", context: requestContext});
      try { return sendCatalogPricingForward(request, reply, await adapters.catalog.pricingInput(productRef, variantRef, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "CATALOG_UNAVAILABLE", "catalog owner is unavailable")); }
    },
  });

  app.post("/api/internal-v1/aroma/catalog-exports", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (_error, request, rawReply) => sendProblem(rawReply as unknown as Reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed")),
    schema: {response: {200: {type: "string"}, 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const originalCaller = trustedCaller(request, ["catalog-supplier-sync"]);
      if (header(request, "x-service-delegation") !== undefined || spoofed(request)) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller-supplied delegation is forbidden"));
      if (originalCaller === undefined || !adapters.verifyTransport(request, originalCaller)) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      if (!isAromaCatalogExportRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const requestContext = context(request, 900_000);
      const delegation = adapters.signDelegation({originalCaller, operationId: "exportAromaCatalog", context: requestContext});
      try { return sendAromaCatalogForward(request, reply, await adapters.catalog.export(request.body, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway is unavailable")); }
    },
  });

  app.post("/api/internal-v1/aroma/cart-snapshots:read", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (_error, request, rawReply) => sendProblem(rawReply as unknown as Reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed")),
    schema: {body: aromaContractSchemas["cartSnapshotReadRequest"], response: {200: aromaContractSchemas["cartSnapshot"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const originalCaller = trustedCaller(request, ["aroma-observer", "aroma-convergence"]);
      if (header(request, "x-service-delegation") !== undefined || spoofed(request)) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller-supplied delegation is forbidden"));
      if (originalCaller === undefined || !adapters.verifyTransport(request, originalCaller)) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      if (!isAromaCartSnapshotReadRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const requestContext = context(request, 10_000);
      const delegation = adapters.signDelegation({originalCaller, operationId: "readAromaCartSnapshot", context: requestContext});
      try { return sendCartForward(request, reply, await adapters.cart.read(request.body, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway is unavailable")); }
    },
  });

  app.post("/api/internal-v1/aroma/cart-lines/:offerRef:set-quantity", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (_error, request, rawReply) => sendProblem(rawReply as unknown as Reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed")),
    schema: {response: operationSchemaResponse()},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const originalCaller: CartMutationCaller | undefined = request.runtimeContext?.transportIdentity?.runtime === "aroma-convergence" ? "aroma-convergence" : undefined;
      if (header(request, "x-service-delegation") !== undefined || spoofed(request)) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller-supplied delegation is forbidden"));
      if (originalCaller === undefined || !adapters.verifyTransport(request, originalCaller)) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      const offerRef = operationOfferRef(request, ":set");
      if (offerRef === undefined || !isAromaSetQuantityRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const requestContext = context(request, 10_000);
      const delegation = adapters.signDelegation({originalCaller, operationId: "setAromaCartLineQuantity", context: requestContext});
      try { return sendAromaMutationForward(request, reply, await adapters.cart.setQuantity(offerRef, request.body, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway is unavailable")); }
    },
  });

  app.post("/api/internal-v1/aroma/cart-lines/:offerRef:remove", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (_error, request, rawReply) => sendProblem(rawReply as unknown as Reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed")),
    schema: {response: operationSchemaResponse()},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const originalCaller: CartMutationCaller | undefined = request.runtimeContext?.transportIdentity?.runtime === "aroma-convergence" ? "aroma-convergence" : undefined;
      if (header(request, "x-service-delegation") !== undefined || spoofed(request)) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller-supplied delegation is forbidden"));
      if (originalCaller === undefined || !adapters.verifyTransport(request, originalCaller)) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      const offerRef = operationOfferRef(request, ":remove");
      if (offerRef === undefined || !isAromaRemoveLineRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const requestContext = context(request, 10_000);
      const delegation = adapters.signDelegation({originalCaller, operationId: "removeAromaCartLine", context: requestContext});
      try { return sendAromaMutationForward(request, reply, await adapters.cart.remove(offerRef, request.body, requestContext, delegation)); }
      catch { return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "aroma gateway is unavailable")); }
    },
  });
}

function requestHeaders(requestContext: Context, delegation: string, accept: string): Record<string, string> {
  const headers: Record<string, string> = {"content-type": "application/json", accept, "x-service-delegation": delegation, "x-correlation-id": requestContext.correlationId};
  if (requestContext.traceparent !== undefined) headers["traceparent"] = requestContext.traceparent;
  return headers;
}

export function createHttpCustomerClient(client: HttpClient): InternalApiAdapters["customer"] {
  return {
    orderInput: async (customerRef, requestContext, delegation) => {
      const headers = requestHeaders(requestContext, "", "application/json");
      delete headers["content-type"];
      delete headers["accept"];
      headers["x-service-delegation"] = delegation;
      const response = await client.fetch(`/api/internal-v1/customers/${encodeURIComponent(customerRef)}/order-input`, {method: "GET", headers, signal: requestContext.signal});
      let body: unknown;
      try { body = await response.json(); } catch { body = {type: "about:blank", title: "CUSTOMER_UNAVAILABLE", status: 503, code: "CUSTOMER_UNAVAILABLE", detail: "customer service returned an invalid response", instance: "/api/internal-v1/customers/order-input", correlationId: requestContext.correlationId, errors: []}; }
      return {status: response.status, body};
    },
  };
}

function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new Error("empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error("response too large");
      chunks.push(chunk.value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* cleanup */ }
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHttpAromaBindingClient(client: HttpClient): InternalApiAdapters["binding"] {
  return {
    register: async (body, requestContext, delegation) => {
      const response = await client.fetch("/api/internal-v1/aroma/offer-bindings", {method: "POST", headers: requestHeaders(requestContext, delegation, "application/json"), body: JSON.stringify(body), signal: requestContext.signal});
      const parsed = await boundedJson(response, 64 * 1024);
      if (response.status === 200 && isAromaOfferBindingResponse(parsed)) return {status: 200, body: parsed};
      if (response.status === 409 && isAromaProblem(parsed) && BINDING_ERROR_CODES.has(parsed.code)) return {status: 409, body: parsed};
      throw new Error("invalid aroma binding response");
    },
  };
}

export function createHttpAromaCatalogClient(client: HttpClient): Pick<InternalApiAdapters["catalog"], "export"> {
  return {
    export: async (body, requestContext, delegation) => {
      const response = await client.fetch("/api/internal-v1/aroma/catalog-exports", {method: "POST", headers: requestHeaders(requestContext, delegation, "application/x-ndjson"), body: JSON.stringify(body), signal: requestContext.signal});
      if (response.status === 200) {
        if (response.body === null) throw new Error("empty catalog export stream");
        return {status: 200, body: response.body};
      }
      const parsed = await boundedJson(response, 64 * 1024);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid catalog export error response");
      return {status: response.status, body: parsed as Record<string, unknown>};
    },
  };
}

export function createHttpCatalogPricingClient(client: HttpClient): Pick<InternalApiAdapters["catalog"], "pricingInput"> {
  return {
    pricingInput: async (productRef, variantRef, requestContext, delegation) => {
      const headers = requestHeaders(requestContext, delegation, "application/json, application/problem+json");
      delete headers["content-type"];
      const path = `/api/internal-v1/catalog/products/${encodeURIComponent(productRef)}/variants/${encodeURIComponent(variantRef)}/pricing-input`;
      const response = await client.fetch(path, {method: "GET", headers, signal: requestContext.signal});
      if (response.status !== 200 && response.status !== 404 && response.status !== 503) throw new Error("catalog owner returned an unsupported status");
      const expectedMediaType = response.status === 200 ? "application/json" : "application/problem+json";
      if (mediaType(response) !== expectedMediaType) throw new Error("catalog owner returned an unsupported media type");
      const body = await boundedJson(response, 64 * 1024);
      if (response.status === 200 && isCatalogPricingInput(body)) return {status: 200, body: body as CatalogPricingInput};
      if ((response.status === 404 || response.status === 503) && isCatalogOperationProblem(body, "pricing", response.status)) return {status: response.status, body};
      throw new Error("catalog owner returned an invalid response");
    },
  };
}

export function createHttpAromaCartClient(client: HttpClient): InternalApiAdapters["cart"] {
  const request = async (path: string, body: unknown, requestContext: Context, delegation: string): Promise<ForwardResult> => {
    const response = await client.fetch(path, {method: "POST", headers: requestHeaders(requestContext, delegation, "application/json"), body: JSON.stringify(body), signal: requestContext.signal});
    return {status: response.status, body: await boundedJson(response, 2 * 1024 * 1024)};
  };
  return {
    read: (body, requestContext, delegation) => request("/api/internal-v1/aroma/cart-snapshots:read", body, requestContext, delegation),
    setQuantity: (offerRef, body, requestContext, delegation) => request(`/api/internal-v1/aroma/cart-lines/${encodeURIComponent(offerRef)}:set-quantity`, body, requestContext, delegation),
    remove: (offerRef, body, requestContext, delegation) => request(`/api/internal-v1/aroma/cart-lines/${encodeURIComponent(offerRef)}:remove`, body, requestContext, delegation),
  };
}

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function privateKey(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (typeof value !== "string" || value.length === 0) throw new Error("INTERNAL_API_DELEGATION_KEY_NOT_CONFIGURED");
  return createPrivateKey(value);
}

function verificationKeys(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INTERNAL_API_CALLER_VERIFICATION_KEYS_NOT_CONFIGURED");
  const source = value as Record<string, unknown>;
  const active = source["active"];
  const previous = source["previous"];
  if (typeof active !== "string" || active.length === 0 || typeof previous !== "string" || previous.length === 0) throw new Error("INTERNAL_API_CALLER_VERIFICATION_KEYS_NOT_CONFIGURED");
  return [createPublicKey(active), createPublicKey(previous)];
}

function epochSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function customerOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-internal"].outbound.find((entry) => entry.startsWith("customer-service:"));
  if (target === undefined) throw new Error("INTERNAL_API_CUSTOMER_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function createConfiguredInternalAdapters(context: RuntimeCompositionContext, client: HttpClient, bindingClient: HttpClient = client, catalogClient: HttpClient = client): InternalApiAdapters {
  const signingKey = privateKey(context, "security.apiInternalDelegationSigningPrivateKey");
  const ordersVerificationKeys = verificationKeys(context, "security.serviceVerificationKeys.orders-service");
  const pricingVerificationKeys = verificationKeys(context, "security.serviceVerificationKeys.pricing-service");
  return {
    verifyTransport: (request, expectedCaller) => request.runtimeContext?.transportIdentity?.runtime === expectedCaller,
    verifyCallerDelegation: (token, _request, operationId, signal) => {
      signal.throwIfAborted();
      if (operationId === "getCatalogPricingInput") return verifyServiceDelegationWithKeySet(token, {publicKeys: pricingVerificationKeys, issuer: "pricing-service", audience: "api-internal", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
      return verifyServiceDelegationWithKeySet(token, {publicKeys: ordersVerificationKeys, issuer: "orders-service", audience: "api-internal", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
    },
    signDelegation: ({originalCaller, operationId, context: requestContext}) => {
      const iat = epochSeconds();
      const gatewayOperation = operationId === "registerAromaOfferBinding" || operationId === "readAromaCartSnapshot" || operationId === "exportAromaCatalog" || operationId === "setAromaCartLineQuantity" || operationId === "removeAromaCartLine";
      const ttl = operationId === "exportAromaCatalog" ? 905 : operationId === "getCatalogPricingInput" ? 6 : operationId === "getCustomerOrderInput" ? 10 : 15;
      const audience = operationId === "getCatalogPricingInput" ? "catalog-service" : gatewayOperation ? "aroma-gateway" : "customer-service";
      return signServiceDelegation({
        iss: "api-internal",
        aud: audience,
        originalCaller,
        operationId,
        correlationId: requestContext.correlationId,
        traceparent: requestContext.traceparent ?? "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + ttl,
        jti: randomUUID(),
        kid: "api-internal-delegation-v1",
      }, signingKey);
    },
    customer: createHttpCustomerClient({fetch: (path, options) => client.fetch(path, options)}),
    binding: createHttpAromaBindingClient({fetch: (path, options) => bindingClient.fetch(path, options)}),
    catalog: {...createHttpAromaCatalogClient({fetch: (path, options) => bindingClient.fetch(path, options)}), ...createHttpCatalogPricingClient({fetch: (path, options) => catalogClient.fetch(path, options)})},
    cart: createHttpAromaCartClient({fetch: (path, options) => bindingClient.fetch(path, options)}),
  };
}

export function configuredTransportMaterial(context: RuntimeCompositionContext): ServiceTransportMaterial {
  return parseServiceTransportMaterial(secretAt(context, "security.serviceTransportKeys.api-internal"), context.config.environment, "api-internal");
}

export function configuredCustomerTls(context: RuntimeCompositionContext) {
  return {material: configuredTransportMaterial(context), targetEnvironment: context.config.environment, targetRuntime: "customer-service"};
}

export function configuredCustomerOrigin(context: RuntimeCompositionContext): string {
  return customerOrigin(context);
}

export function configuredCatalogOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-internal"].outbound.find((entry) => entry.startsWith("catalog-service:"));
  if (target === undefined) throw new Error("INTERNAL_API_CATALOG_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function configuredCatalogTls(context: RuntimeCompositionContext) {
  return {material: configuredTransportMaterial(context), targetEnvironment: context.config.environment, targetRuntime: "catalog-service"};
}

export function configuredAromaGatewayOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-internal"].outbound.find((entry) => entry.startsWith("aroma-gateway:"));
  if (target === undefined) throw new Error("INTERNAL_API_AROMA_GATEWAY_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function configuredAromaGatewayTls(context: RuntimeCompositionContext) {
  return {material: configuredTransportMaterial(context), targetEnvironment: context.config.environment, targetRuntime: "aroma-gateway"};
}

export function createUnavailableInternalAdapters(): InternalApiAdapters {
  return {
    verifyTransport: () => false,
    verifyCallerDelegation: () => { throw new Error("INTERNAL_API_SECURITY_NOT_CONFIGURED"); },
    signDelegation: () => { throw new Error("INTERNAL_API_SECURITY_NOT_CONFIGURED"); },
    customer: {orderInput: async () => { throw new Error("INTERNAL_API_CUSTOMER_CLIENT_NOT_CONFIGURED"); }},
    binding: {register: async () => { throw new Error("INTERNAL_API_BINDING_CLIENT_NOT_CONFIGURED"); }},
    catalog: {export: async () => { throw new Error("INTERNAL_API_CATALOG_CLIENT_NOT_CONFIGURED"); }, pricingInput: async () => { throw new Error("INTERNAL_API_CATALOG_CLIENT_NOT_CONFIGURED"); }},
    cart: {
      read: async () => { throw new Error("INTERNAL_API_CART_CLIENT_NOT_CONFIGURED"); },
      setQuantity: async () => { throw new Error("INTERNAL_API_CART_CLIENT_NOT_CONFIGURED"); },
      remove: async () => { throw new Error("INTERNAL_API_CART_CLIENT_NOT_CONFIGURED"); },
    },
  };
}

export type {CustomerOrderInput};
