import {createPrivateKey, createPublicKey, randomUUID} from "node:crypto";
import type {CustomerCreateRequest, CustomerResponse, CustomerSearchResponse} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeCompositionContext, RuntimeRequestContext} from "@coffee-platform/runtime";
import {signActorContext, verifyActorContext, type ActorContextClaims} from "@coffee-platform/security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function sendForward(reply: Reply, result: ForwardResult): Reply {
  reply.header("cache-control", "no-store");
  if (result.replayed === true) reply.header("idempotency-replayed", "true");
  if (result.status >= 400 && isProblem(result.body)) return reply.code(result.status).type("application/problem+json").send(result.body);
  return reply.code(result.status).send(result.body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validAddress(value: unknown): boolean {
  if (!isRecord(value) || !stringField(value["line1"], 1, 200) || !stringField(value["city"], 1, 100) || value["countryCode"] !== "RU") return false;
  return (value["line2"] === undefined || stringField(value["line2"], 0, 200)) &&
    (value["postalCode"] === undefined || stringField(value["postalCode"], 0, 32)) &&
    Object.keys(value).every((key) => ["addressRef", "line1", "line2", "city", "postalCode", "countryCode"].includes(key));
}

function validCreateBody(value: unknown): value is CustomerCreateRequest {
  if (!isRecord(value) || !stringField(value["displayName"], 1, 200)) return false;
  if (value["phone"] !== undefined && !stringField(value["phone"], 1, 64)) return false;
  if (value["email"] !== undefined && (!stringField(value["email"], 1, 254) || !EMAIL.test(value["email"]))) return false;
  if (value["phone"] === undefined && value["email"] === undefined) return false;
  return (value["address"] === undefined || validAddress(value["address"])) &&
    Object.keys(value).every((key) => ["displayName", "phone", "email", "address"].includes(key));
}

function isProblem(value: unknown): value is Problem {
  return isRecord(value) && value["type"] === "about:blank" && typeof value["title"] === "string" && typeof value["status"] === "number" &&
    typeof value["code"] === "string" && typeof value["detail"] === "string" && typeof value["instance"] === "string" &&
    typeof value["correlationId"] === "string" && Array.isArray(value["errors"]);
}

function replayOnly(request: Request): boolean | Problem {
  const value = oneHeader(header(request, "idempotency-replay-only"));
  if (value === undefined) return false;
  if (value !== "true" || request.body !== undefined || header(request, "if-match-version") !== undefined) return problem(request, 400, "VALIDATION_FAILED", "replay-only requires true and an empty body");
  return true;
}

function idempotencyKey(request: Request): string | Problem {
  const value = oneHeader(header(request, "idempotency-key"));
  return value !== undefined && UUID.test(value) ? value : problem(request, 400, "VALIDATION_FAILED", "Idempotency-Key must be a UUID");
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
  if (claims.iss !== "edge-gateway" || claims.aud !== "api-public" || claims.operationId !== operationId || claims.originalIssuer !== "edge-gateway" || claims.sub.length === 0) throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}

const CUSTOMER_ADDRESS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["line1", "city", "countryCode"],
  properties: {
    addressRef: {type: "string", pattern: "^adr_[0-9A-HJKMNP-TV-Z]{26}$"}, line1: {type: "string", minLength: 1, maxLength: 200},
    line2: {type: "string", maxLength: 200}, city: {type: "string", minLength: 1, maxLength: 100}, postalCode: {type: "string", maxLength: 32},
    countryCode: {type: "string", pattern: "^[A-Z]{2}$", const: "RU"},
  },
};

const CUSTOMER_CREATE_SCHEMA = {
  anyOf: [
    {type: "object", additionalProperties: false, required: ["displayName", "phone"], properties: {
      displayName: {type: "string", minLength: 1, maxLength: 200}, phone: {type: "string", minLength: 1, maxLength: 64}, email: {type: "string", maxLength: 254}, address: CUSTOMER_ADDRESS_SCHEMA,
    }},
    {type: "object", additionalProperties: false, required: ["displayName", "email"], properties: {
      displayName: {type: "string", minLength: 1, maxLength: 200}, phone: {type: "string", minLength: 1, maxLength: 64}, email: {type: "string", maxLength: 254}, address: CUSTOMER_ADDRESS_SCHEMA,
    }},
  ],
};

const CUSTOMER_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["customerRef", "version", "displayName", "createdAt", "updatedAt"],
  properties: {
    customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"}, version: {type: "string", pattern: "^(0|[1-9][0-9]*)$"}, displayName: {type: "string", minLength: 1, maxLength: 200},
    phone: {type: "string", pattern: "^\\+[1-9][0-9]{7,14}$"}, email: {type: "string", maxLength: 254}, address: CUSTOMER_ADDRESS_SCHEMA,
    createdAt: {type: "string", pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"},
    updatedAt: {type: "string", pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"},
  },
};

const CUSTOMER_SEARCH_RESPONSE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items", "nextCursor"],
  properties: {items: {type: "array", maxItems: 50, items: {type: "object", additionalProperties: false, required: ["customerRef", "version", "displayName"], properties: {
    customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"}, version: {type: "string", pattern: "^(0|[1-9][0-9]*)$"}, displayName: {type: "string", minLength: 1, maxLength: 200}, phone: {type: "string", maxLength: 32}, email: {type: "string", maxLength: 254},
  }}}, nextCursor: {type: ["string", "null"], maxLength: 512}},
};

const PROBLEM_SCHEMA = {
  type: "object", additionalProperties: false, required: ["type", "title", "status", "code", "detail", "instance", "correlationId", "errors"],
  properties: {
    type: {type: "string", minLength: 1, maxLength: 2048}, title: {type: "string", minLength: 1, maxLength: 200}, status: {type: "integer", minimum: 400, maximum: 599},
    code: {type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$"}, detail: {type: "string", minLength: 1, maxLength: 2000}, instance: {type: "string", minLength: 1, maxLength: 2048},
    correlationId: {type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"}, errors: {type: "array", maxItems: 100, items: {type: "object", additionalProperties: false, required: ["code", "message"], properties: {
      code: {type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$"}, message: {type: "string", minLength: 1, maxLength: 500}, field: {type: "string", minLength: 1, maxLength: 200},
    }}},
  },
};

function responseSchema(success: unknown, successStatus: 200 | 201, statuses: readonly number[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries([[successStatus, success], ...statuses.map((status) => [status, PROBLEM_SCHEMA])]);
}

export function registerPublicRoutes(app: RuntimeApp, adapters: PublicApiAdapters): void {
  app.post("/api/client-v1/customers", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {body: CUSTOMER_CREATE_SCHEMA, response: responseSchema(CUSTOMER_RESPONSE_SCHEMA, 201, [400, 401, 403, 409, 410, 500, 503])},
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "edge-gateway")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      const requestContext = context(request);
      let claims: ActorContextClaims;
      try { claims = await actor(request, adapters, "createCustomer", requestContext.signal); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      const replay = replayOnly(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const key = idempotencyKey(request);
      if (typeof key !== "string") return sendProblem(reply, key);
      const body = validCreateBody(request.body) ? request.body : undefined;
      if (!replay && body === undefined) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "CustomerCreateRequest is invalid"));
      try {
        const result = await adapters.customer.create(replay ? undefined : body, {actor: claims, context: requestContext, idempotencyKey: key, replayOnly: replay});
        return sendForward(reply, result);
      } catch {
        return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", "customer service is unavailable"));
      }
    },
  });

  app.get("/api/client-v1/customers", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {querystring: {type: "object", required: ["query"], additionalProperties: false, properties: {query: {type: "string", minLength: 2, maxLength: 200}, limit: {type: "integer", minimum: 1, maximum: 50}, cursor: {type: "string", maxLength: 512, pattern: "^[A-Za-z0-9_-]*$"}}}, response: responseSchema(CUSTOMER_SEARCH_RESPONSE_SCHEMA, 200, [400, 401, 403, 500, 503])},
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "edge-gateway")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      const requestContext = context(request, 1_000);
      let claims: ActorContextClaims;
      try { claims = await actor(request, adapters, "searchCustomers", requestContext.signal); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      const queryObject = isRecord(request.query) ? request.query : {};
      const query = queryObject["query"];
      const limitValue = queryObject["limit"];
      const cursor = queryObject["cursor"];
      const limit = limitValue === undefined ? 20 : Number(limitValue);
      if (!stringField(query, 2, 200) || !Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && (!stringField(cursor, 0, 512) || !CURSOR.test(cursor)))) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "search query is invalid"));
      try {
        const result = await adapters.customer.search(query, limit, typeof cursor === "string" ? cursor : undefined, {actor: claims, context: requestContext, idempotencyKey: "", replayOnly: false});
        return sendForward(reply, result);
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

function publicKey(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  return typeof value === "string" && value.length > 0 ? createPublicKey(value) : undefined;
}

function epochSeconds(): number {
  return Math.floor((performance.timeOrigin + performance.now()) / 1_000);
}

function customerOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["api-public"].outbound.find((entry) => entry.startsWith("customer-service:"));
  if (target === undefined) throw new Error("PUBLIC_API_CUSTOMER_ORIGIN_NOT_CONFIGURED");
  return `http://${target}`;
}

export function createConfiguredPublicAdapters(context: RuntimeCompositionContext, client: HttpClient): PublicApiAdapters {
  const signingKey = privateKey(context, "security.apiPublicDelegationSigningPrivateKey");
  const actorVerificationKey = publicKey(context, "security.actorContextEdgeVerificationPublicKey");
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
    verifyTransport: () => false,
    verifyActor: (token, operationId, signal) => {
      signal.throwIfAborted();
      if (actorVerificationKey === undefined) throw new Error("PUBLIC_API_ACTOR_VERIFICATION_KEY_NOT_CONFIGURED");
      const claims = verifyActorContext(token, {publicKey: actorVerificationKey, issuer: "edge-gateway", audience: "api-public", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
      if (claims.operationId !== operationId) throw new Error("ACTOR_CONTEXT_INVALID");
      return claims;
    },
    customer: createHttpCustomerClient({fetch: (path, options) => client.fetch(path, options)}, sign),
  };
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
