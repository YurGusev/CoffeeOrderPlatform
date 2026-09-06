import {createPrivateKey, createPublicKey, randomUUID} from "node:crypto";
import {customerContractSchemas, customerErrorPolicy, customerErrorPolicyEntry, customerResponseSchema, decodeCustomerSearchQuery, hasCustomerPermission, isCustomerCreateRequest, isCustomerIdempotencyKey, isCustomerProblem, isCustomerReplayOnly, isCustomerResponse, isCustomerSearchResponse} from "@coffee-platform/contracts-customer-v1";
import type {CustomerCreateRequest, CustomerResponse, CustomerSearchResponse} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeCompositionContext, RuntimeRequestContext} from "@coffee-platform/runtime";
import {parseServiceTransportMaterial, signActorContext, verifyActorContextWithKeySet, type ActorContextClaims, type ServiceTransportMaterial} from "@coffee-platform/security";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_BYTES = 8 * 1024;

type HeaderValue = string | string[] | undefined;
type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{url: string | undefined}>;
  url: string;
  body: unknown;
  query: unknown;
}>;
type Reply = {
  header: (name: string, value: string) => Reply;
  code: (status: number) => Reply;
  type: (value: string) => Reply;
  send: (body?: unknown) => Reply;
};
type HttpClient = Readonly<{fetch: (path: string, options?: RequestInit) => Promise<Response>}>;
type Context = Readonly<{correlationId: string; traceparent?: string; signal: AbortSignal}>;
type ForwardResult = Readonly<{status: number; body: unknown; replayed?: boolean}>;
type ForwardContext = Readonly<{actor: ActorContextClaims; context: Context; idempotencyKey: string; replayOnly: boolean}>;
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
  create: (request: CustomerCreateRequest | undefined, context: ForwardContext) => Promise<ForwardResult>;
  search: (query: string, limit: number, cursor: string | undefined, context: ForwardContext) => Promise<ForwardResult>;
}>;

export type PublicApiAdapters = Readonly<{
  verifyTransport: (request: Request, expectedCaller: "edge-gateway") => boolean;
  verifyActor: (token: string, operationId: string, signal: AbortSignal) => Promise<ActorContextClaims> | ActorContextClaims;
  customer: CustomerClient;
}>;

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function oneHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function exceedsBodyLimit(request: Request): boolean {
  const declared = oneHeader(header(request, "content-length"));
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return true;
  if (request.body === undefined) return false;
  try { return Buffer.byteLength(JSON.stringify(request.body), "utf8") > MAX_BODY_BYTES; } catch { return true; }
}

function exceedsUrlLimit(request: Request): boolean {
  return Buffer.byteLength(request.url, "utf8") > MAX_URL_BYTES;
}

function context(request: Request, timeoutMs?: number): Context {
  const runtime: RuntimeRequestContext | null | undefined = request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  const signal = timeoutMs === undefined ? base : AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]);
  return {
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined ? {} : {traceparent: runtime.traceparent}),
    signal,
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

function frameworkError(request: Request, reply: Reply, error: unknown): Reply {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const validation = code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
  const policy = validation ? customerErrorPolicy.VALIDATION_FAILED : customerErrorPolicy.INTERNAL_ERROR;
  return sendProblem(reply, problem(request, policy.status, validation ? "VALIDATION_FAILED" : "INTERNAL_ERROR", policy.detail));
}

function forwardedProblem(request: Request, value: unknown): Problem {
  if (!isCustomerProblem(value)) return problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail);
  const policy = customerErrorPolicyEntry(value.code);
  return policy !== undefined && policy.status === value.status
    ? problem(request, policy.status, value.code, policy.detail)
    : problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail);
}

function sendForward(request: Request, reply: Reply, result: ForwardResult, kind: "create" | "search"): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) return sendProblem(reply, forwardedProblem(request, result.body));
  if ((kind === "create" ? isCustomerResponse(result.body) : isCustomerSearchResponse(result.body)) === false) return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", customerErrorPolicy.CUSTOMER_UNAVAILABLE.detail));
  if (result.replayed === true) reply.header("idempotency-replayed", "true");
  return reply.code(result.status).send(result.body);
}

function replayOnly(request: Request): boolean | Problem {
  const value = oneHeader(header(request, "idempotency-replay-only"));
  if (value === undefined) return false;
  if (!isCustomerReplayOnly(value === "true") || request.body !== undefined || header(request, "if-match-version") !== undefined) return problem(request, 400, "VALIDATION_FAILED", "replay-only requires true and an empty body");
  return true;
}

function idempotencyKey(request: Request): string | Problem {
  const value = oneHeader(header(request, "idempotency-key"));
  return value !== undefined && isCustomerIdempotencyKey(value) ? value : problem(request, 400, "VALIDATION_FAILED", "Idempotency-Key must be a UUID");
}

function spoofed(request: Request): boolean {
  const blocked = ["x-actor-ref", "x-original-issuer", "x-original-caller", "x-service-identity", "x-transport-caller", "x-service-delegation"];
  return blocked.some((name) => header(request, name) !== undefined) || Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-actor-") && name.toLowerCase() !== "x-actor-context");
}

async function actor(request: Request, adapters: PublicApiAdapters, operationId: string, signal: AbortSignal): Promise<ActorContextClaims> {
  if (spoofed(request)) throw new Error("ACTOR_CONTEXT_INVALID");
  const token = oneHeader(header(request, "x-actor-context"));
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyActor(token, operationId, signal);
  if (claims.iss !== "edge-gateway" || claims.aud !== "api-public" || claims.operationId !== operationId || claims.originalIssuer !== "edge-gateway" || claims.sub.length === 0 || !hasCustomerPermission(claims.permissions, operationId as "createCustomer" | "searchCustomers")) throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

export function registerPublicRoutes(app: RuntimeApp, adapters: PublicApiAdapters): void {
  app.post("/api/client-v1/customers", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (error, request, reply) => frameworkError(request, reply, error),
    schema: {response: customerResponseSchema(customerContractSchemas.response, 201, [400, 401, 403, 409, 410, 500, 503])},
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "edge-gateway")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      const requestContext = context(request);
      let claims: ActorContextClaims;
      try { claims = await actor(request, adapters, "createCustomer", requestContext.signal); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      if (exceedsBodyLimit(request)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const replay = replayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = idempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = isCustomerCreateRequest(request.body) ? request.body : undefined;
      if (!replay && body === undefined) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      try {
        const result = await adapters.customer.create(replay ? undefined : body, {actor: claims, context: requestContext, idempotencyKey: key, replayOnly: replay});
        return sendForward(request, reply, result, "create");
      } catch {
        return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", "customer service is unavailable"));
      }
    },
  });

  app.get("/api/client-v1/customers", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {response: customerResponseSchema(customerContractSchemas.searchResponse, 200, [400, 401, 403, 500, 503])},
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "edge-gateway")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      const requestContext = context(request, 1_000);
      let claims: ActorContextClaims;
      try { claims = await actor(request, adapters, "searchCustomers", requestContext.signal); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      if (exceedsUrlLimit(request)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const decodedQuery = decodeCustomerSearchQuery(request.query);
      if (decodedQuery === undefined) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const query = decodedQuery.query;
      const limit = decodedQuery.limit ?? 20;
      const cursor = decodedQuery.cursor;
      try {
        const result = await adapters.customer.search(query, limit, typeof cursor === "string" ? cursor : undefined, {actor: claims, context: requestContext, idempotencyKey: "", replayOnly: false});
        return sendForward(request, reply, result, "search");
      } catch {
        return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", "customer service is unavailable"));
      }
    },
  });
}

export function createHttpCustomerClient(client: HttpClient, sign: (actor: ActorContextClaims, owner: string, operationId: string, context: Context) => string): CustomerClient {
  const call = async (path: string, method: "GET" | "POST", body: unknown, requestContext: ForwardContext, operationId: string): Promise<ForwardResult> => {
    const token = sign(requestContext.actor, "customer-service", operationId, requestContext.context);
    const headers: Record<string, string> = {"x-actor-context": token, "x-correlation-id": requestContext.context.correlationId, ...(requestContext.idempotencyKey === "" ? {} : {"idempotency-key": requestContext.idempotencyKey})};
    if (requestContext.context.traceparent !== undefined) headers["traceparent"] = requestContext.context.traceparent;
    if (requestContext.replayOnly) headers["idempotency-replay-only"] = "true";
    const response = await client.fetch(path, {method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body), headers: {...headers, "content-type": "application/json"}}), signal: requestContext.context.signal});
    let responseBody: unknown;
    try { responseBody = await response.json(); } catch { responseBody = {type: "about:blank", title: "CUSTOMER_UNAVAILABLE", status: 503, code: "CUSTOMER_UNAVAILABLE", detail: "customer service returned an invalid response", instance: path, correlationId: requestContext.context.correlationId, errors: []}; }
    return {status: response.status, body: responseBody, ...(response.headers.get("idempotency-replayed") === "true" ? {replayed: true} : {})};
  };
  return {
    create: (request, requestContext) => call("/api/client-v1/customers", "POST", request, requestContext, "createCustomer"),
    search: (query, limit, cursor, requestContext) => {
      const params = new URLSearchParams({query, limit: String(limit), ...(cursor === undefined ? {} : {cursor})});
      return call(`/api/client-v1/customers?${params.toString()}`, "GET", undefined, requestContext, "searchCustomers");
    },
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
  if (typeof value !== "string" || value.length === 0) throw new Error("PUBLIC_API_DELEGATION_KEY_NOT_CONFIGURED");
  return createPrivateKey(value);
}

function verificationKeys(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("PUBLIC_API_ACTOR_VERIFICATION_KEYS_NOT_CONFIGURED");
  const source = value as Record<string, unknown>;
  const active = source["active"];
  const previous = source["previous"];
  if (typeof active !== "string" || active.length === 0 || typeof previous !== "string" || previous.length === 0) throw new Error("PUBLIC_API_ACTOR_VERIFICATION_KEYS_NOT_CONFIGURED");
  return [createPublicKey(active), createPublicKey(previous)];
}

function epochSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function customerOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-public"].outbound.find((entry) => entry.startsWith("customer-service:"));
  if (target === undefined) throw new Error("PUBLIC_API_CUSTOMER_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

export function createConfiguredPublicAdapters(context: RuntimeCompositionContext, client: HttpClient): PublicApiAdapters {
  const signingKey = privateKey(context, "security.apiPublicDelegationSigningPrivateKey");
  const actorVerificationKeys = verificationKeys(context, "security.actorContextEdgeVerificationPublicKeys");
  const sign = (actor: ActorContextClaims, owner: string, operationId: string, requestContext: Context): string => {
    const iat = epochSeconds();
    return signActorContext({
      iss: "api-public",
      aud: owner,
      originalIssuer: actor.iss,
      sub: actor.sub,
      permissions: actor.permissions,
      operationId,
      correlationId: requestContext.correlationId,
      traceparent: requestContext.traceparent ?? "00-00000000000000000000000000000000-0000000000000000-00",
      iat,
      exp: iat + 6,
      jti: randomUUID(),
      kid: "api-public-delegation-v1",
    }, signingKey);
  };
  return {
    verifyTransport: (request, expectedCaller) => request.runtimeContext?.transportIdentity?.runtime === expectedCaller,
    verifyActor: (token, operationId, signal) => {
      signal.throwIfAborted();
      const claims = verifyActorContextWithKeySet(token, {publicKeys: actorVerificationKeys, issuer: "edge-gateway", audience: "api-public", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
      if (claims.operationId !== operationId) throw new Error("ACTOR_CONTEXT_INVALID");
      return claims;
    },
    customer: createHttpCustomerClient({fetch: (path, options) => client.fetch(path, options)}, sign),
  };
}

export function configuredTransportMaterial(context: RuntimeCompositionContext): ServiceTransportMaterial {
  let value: unknown = context.secrets;
  for (const part of "security.serviceTransportKeys.api-public".split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("PUBLIC_API_TRANSPORT_NOT_CONFIGURED");
    value = (value as Record<string, unknown>)[part];
  }
  return parseServiceTransportMaterial(value, context.config.environment, "api-public");
}

export function configuredCustomerTls(context: RuntimeCompositionContext) {
  return {material: configuredTransportMaterial(context), targetEnvironment: context.config.environment, targetRuntime: "customer-service"};
}

export function configuredCustomerOrigin(context: RuntimeCompositionContext): string {
  return customerOrigin(context);
}

export function createUnavailablePublicAdapters(): PublicApiAdapters {
  return {
    verifyTransport: () => false,
    verifyActor: () => { throw new Error("PUBLIC_API_SECURITY_NOT_CONFIGURED"); },
    customer: {create: async () => { throw new Error("PUBLIC_API_CUSTOMER_CLIENT_NOT_CONFIGURED"); }, search: async () => { throw new Error("PUBLIC_API_CUSTOMER_CLIENT_NOT_CONFIGURED"); }},
  };
}

export type {CustomerCreateRequest, CustomerResponse, CustomerSearchResponse};
