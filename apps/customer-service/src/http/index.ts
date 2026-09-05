import {createHash} from "node:crypto";
import {withTransaction, type Database} from "@coffee-platform/database";
import type {IdempotencyStore} from "@coffee-platform/idempotency";
import type {CustomerCreateRequest, CustomerOrderInput, CustomerResponse, CustomerSearchResponse, CustomerSummary} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeRequestContext} from "@coffee-platform/runtime";
import {createCustomer, type CreateCustomerResult} from "../application/create-customer.js";
import {getCustomerOrderInput} from "../application/get-customer-order-input.js";
import {searchCustomers} from "../application/search-customers.js";
import {createCustomerIdempotencyRepository, type CustomerIdempotencyResponse} from "../infrastructure/postgres/idempotency-repository.js";
import {CustomerRepository} from "../infrastructure/postgres/customer-repository.js";

const CUSTOMER_REF = /^cus_[0-9A-HJKMNP-TV-Z]{26}$/;
const DECIMAL_VERSION = /^(0|[1-9][0-9]*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR = /^[A-Za-z0-9_-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PUBLIC_ROUTES = {
  create: "/api/client-v1/customers",
  search: "/api/client-v1/customers",
} as const;

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
  params: unknown;
}>;
type Reply = {
  header: (name: string, value: string) => Reply;
  code: (status: number) => Reply;
  type: (value: string) => Reply;
  send: (body?: unknown) => Reply;
};
type Context = Readonly<{
  actorRef: string;
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;
type Identity = Readonly<{actorRef: string; scope: string; key: string}>;
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
type OwnerResult = Readonly<{status: number; body: unknown; resourceRef?: string}>;
type ReplayResult =
  | Readonly<{kind: "completed"; response: OwnerResult}>
  | Readonly<{kind: "in_progress"}>
  | Readonly<{kind: "not_retained"}>
  | Readonly<{kind: "unavailable"}>
  | Readonly<{kind: "invalid"}>;

export type PublicDelegationClaims = Readonly<{
  iss: string;
  aud: string;
  originalIssuer: string;
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent: string;
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}>;

export type InternalDelegationClaims = Readonly<{
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

export type CustomerOwner = Readonly<{
  create: (input: Readonly<{
    request: CustomerCreateRequest;
    identity: Identity;
    context: Context;
  }>) => Promise<OwnerResult>;
  search: (input: Readonly<{
    query: string;
    limit: number;
    cursor?: string;
    context: Context;
  }>) => Promise<OwnerResult>;
  orderInput: (input: Readonly<{
    customerRef: string;
    context: Context;
  }>) => Promise<OwnerResult>;
  replay: (input: Readonly<{
    identity: Identity;
    context: Context;
  }>) => Promise<ReplayResult>;
}>;

export type CustomerHttpAdapters = Readonly<{
  owner: CustomerOwner;
  verifyTransport: (request: Request, expectedCaller: "api-public" | "api-internal") => boolean;
  verifyPublicDelegation: (token: string, operationId: string, signal: AbortSignal) => Promise<PublicDelegationClaims> | PublicDelegationClaims;
  verifyInternalDelegation: (token: string, operationId: string, signal: AbortSignal) => Promise<InternalDelegationClaims> | InternalDelegationClaims;
}>;

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function oneHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function runtimeContext(request: Request, timeoutMs?: number): Context {
  const context: RuntimeRequestContext | null | undefined = request.runtimeContext;
  const baseSignal = context?.signal ?? new AbortController().signal;
  const signal = timeoutMs === undefined ? baseSignal : AbortSignal.any([baseSignal, AbortSignal.timeout(timeoutMs)]);
  return {
    actorRef: "",
    correlationId: context?.correlationId ?? request.id,
    ...(context?.traceparent === undefined ? {} : {traceparent: context.traceparent}),
    signal,
  };
}

function withActor(context: Context, actorRef: string): Context {
  return {...context, actorRef};
}

function problem(request: Request, status: number, code: string, detail: string): Problem {
  const correlationId = request.runtimeContext?.correlationId ?? request.id;
  return {
    type: "about:blank",
    title: code,
    status,
    code,
    detail,
    instance: request.routeOptions.url ?? request.url,
    correlationId,
    errors: [],
  };
}

function sendProblem(reply: Reply, body: Problem, noStore = true): Reply {
  if (noStore) reply.header("cache-control", "no-store");
  return reply.code(body.status).type("application/problem+json").send(body);
}

function sendOwnerResult(reply: Reply, result: OwnerResult, replayed = false): Reply {
  reply.header("cache-control", "no-store");
  if (replayed) reply.header("idempotency-replayed", "true");
  if (result.status >= 400 && isProblem(result.body)) {
    return reply.code(result.status).type("application/problem+json").send(result.body);
  }
  return reply.code(result.status).send(result.body);
}

function sendOwnerFailure(request: Request, reply: Reply, error: unknown): Reply {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  const status = code === "VALIDATION_FAILED" || code === "INVALID_CURSOR" ? 400 :
    code === "CUSTOMER_NOT_FOUND" ? 404 :
      ["CUSTOMER_PHONE_CONFLICT", "CUSTOMER_EMAIL_CONFLICT", "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_REQUEST_IN_PROGRESS"].includes(code) ? 409 :
        ["IDEMPOTENCY_RESULT_INVALID", "INTERNAL_ERROR"].includes(code) ? 500 :
          code.startsWith("DB_") || code === "TRANSACTION_OUTCOME_UNKNOWN" || code === "CUSTOMER_UNAVAILABLE" ? 503 : 500;
  return sendProblem(reply, problem(request, status, code, error instanceof Error ? error.message : "customer service is unavailable"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function validAddress(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!stringField(value["line1"], 1, 200) || !stringField(value["city"], 1, 100) || value["countryCode"] !== "RU") return false;
  return (value["line2"] === undefined || stringField(value["line2"], 0, 200)) &&
    (value["postalCode"] === undefined || stringField(value["postalCode"], 0, 32)) &&
    Object.keys(value).every((key) => ["addressRef", "line1", "line2", "city", "postalCode", "countryCode"].includes(key));
}

function validCreateBody(value: unknown): value is CustomerCreateRequest {
  if (!isRecord(value) || !stringField(value["displayName"], 1, 200)) return false;
  if (value["phone"] !== undefined && !stringField(value["phone"], 1, 64)) return false;
  if (value["email"] !== undefined && (!stringField(value["email"], 1, 254) || !EMAIL.test(value["email"]))) return false;
  if (value["phone"] === undefined && value["email"] === undefined) return false;
  if (value["address"] !== undefined && !validAddress(value["address"])) return false;
  return Object.keys(value).every((key) => ["displayName", "phone", "email", "address"].includes(key));
}

function validCustomerResponse(value: unknown): value is CustomerResponse {
  if (!isRecord(value) || typeof value["customerRef"] !== "string" || !CUSTOMER_REF.test(value["customerRef"]) ||
    typeof value["version"] !== "string" || !DECIMAL_VERSION.test(value["version"]) ||
    !stringField(value["displayName"], 1, 200) || typeof value["createdAt"] !== "string" || typeof value["updatedAt"] !== "string" ||
    Object.keys(value).some((key) => !["customerRef", "version", "displayName", "phone", "email", "address", "createdAt", "updatedAt"].includes(key))) return false;
  if (value["phone"] !== undefined && (typeof value["phone"] !== "string" || !/^\+[1-9][0-9]{7,14}$/u.test(value["phone"]))) return false;
  if (value["email"] !== undefined && (typeof value["email"] !== "string" || !EMAIL.test(value["email"]))) return false;
  if (value["address"] === undefined) return true;
  const address = value["address"];
  return isRecord(address) && typeof address["addressRef"] === "string" && /^adr_[0-9A-HJKMNP-TV-Z]{26}$/u.test(address["addressRef"]) &&
    stringField(address["line1"], 1, 200) && (address["line2"] === undefined || address["line2"] === null || stringField(address["line2"], 0, 200)) &&
    stringField(address["city"], 1, 100) && (address["postalCode"] === undefined || address["postalCode"] === null || stringField(address["postalCode"], 0, 32)) &&
    address["countryCode"] === "RU" && Object.keys(address).every((key) => ["addressRef", "line1", "line2", "city", "postalCode", "countryCode"].includes(key));
}

function isProblem(value: unknown): value is Problem {
  return isRecord(value) && value["type"] === "about:blank" && typeof value["title"] === "string" &&
    typeof value["status"] === "number" && typeof value["code"] === "string" && typeof value["detail"] === "string" &&
    typeof value["instance"] === "string" && typeof value["correlationId"] === "string" && Array.isArray(value["errors"]);
}

function validReplayResponse(response: OwnerResult): boolean {
  return response.status === 201 && validCustomerResponse(response.body);
}

function spoofed(request: Request, allowed: readonly string[]): boolean {
  const blocked = ["x-actor-ref", "x-actor-permissions", "x-original-issuer", "x-original-caller", "x-service-identity", "x-transport-caller", "x-service-delegation"];
  return blocked.some((name) => header(request, name) !== undefined && !allowed.includes(name)) ||
    Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-actor-") && !allowed.includes(name.toLowerCase()));
}

function verifiedPublic(request: Request, adapters: CustomerHttpAdapters, operationId: string): Promise<PublicDelegationClaims> {
  if (spoofed(request, ["x-actor-context"])) return Promise.reject(new Error("ACTOR_CONTEXT_INVALID"));
  const token = oneHeader(header(request, "x-actor-context"));
  if (token === undefined) return Promise.reject(new Error("AUTHENTICATION_REQUIRED"));
  const context = runtimeContext(request);
  return Promise.resolve(adapters.verifyPublicDelegation(token, operationId, context.signal)).then((claims) => {
    if (claims.iss !== "api-public" || claims.aud !== "customer-service" || claims.originalIssuer !== "edge-gateway" || claims.operationId !== operationId || !claims.sub) throw new Error("ACTOR_CONTEXT_INVALID");
    return claims;
  });
}

function verifiedInternal(request: Request, adapters: CustomerHttpAdapters): Promise<InternalDelegationClaims> {
  if (spoofed(request, ["x-service-delegation"])) return Promise.reject(new Error("SERVICE_DELEGATION_INVALID"));
  const token = oneHeader(header(request, "x-service-delegation"));
  if (token === undefined) return Promise.reject(new Error("SERVICE_AUTHENTICATION_REQUIRED"));
  const context = runtimeContext(request, 1_000);
  return Promise.resolve(adapters.verifyInternalDelegation(token, "getCustomerOrderInput", context.signal)).then((claims) => {
    if (claims.iss !== "api-internal" || claims.aud !== "customer-service" || claims.originalCaller !== "orders-service" || claims.operationId !== "getCustomerOrderInput") throw new Error("SERVICE_DELEGATION_INVALID");
    return claims;
  });
}

function parseReplay(request: Request): boolean | Problem {
  const value = oneHeader(header(request, "idempotency-replay-only"));
  if (value === undefined) return false;
  if (value !== "true" || request.body !== undefined || header(request, "if-match-version") !== undefined) return problem(request, 400, "VALIDATION_FAILED", "replay-only requires true and an empty body");
  return true;
}

function identity(request: Request, actorRef: string): Identity | Problem {
  const key = oneHeader(header(request, "idempotency-key"));
  if (key === undefined || !UUID.test(key)) return problem(request, 400, "VALIDATION_FAILED", "Idempotency-Key must be a UUID");
  const scope = createHash("sha256").update(`POST\n${PUBLIC_ROUTES.create}`, "utf8").digest("hex");
  return {actorRef, scope, key};
}

const CUSTOMER_ADDRESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line1", "city", "countryCode"],
  properties: {
    addressRef: {type: "string", pattern: "^adr_[0-9A-HJKMNP-TV-Z]{26}$"},
    line1: {type: "string", minLength: 1, maxLength: 200},
    line2: {type: "string", maxLength: 200},
    city: {type: "string", minLength: 1, maxLength: 100},
    postalCode: {type: "string", maxLength: 32},
    countryCode: {type: "string", pattern: "^[A-Z]{2}$", const: "RU"},
  },
};

const CUSTOMER_CREATE_SCHEMA = {
  anyOf: [
    {type: "object", additionalProperties: false, required: ["displayName", "phone"], properties: {
      displayName: {type: "string", minLength: 1, maxLength: 200}, phone: {type: "string", minLength: 1, maxLength: 64},
      email: {type: "string", maxLength: 254}, address: CUSTOMER_ADDRESS_SCHEMA,
    }},
    {type: "object", additionalProperties: false, required: ["displayName", "email"], properties: {
      displayName: {type: "string", minLength: 1, maxLength: 200}, phone: {type: "string", minLength: 1, maxLength: 64},
      email: {type: "string", maxLength: 254}, address: CUSTOMER_ADDRESS_SCHEMA,
    }},
  ],
};

const CUSTOMER_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customerRef", "version", "displayName", "createdAt", "updatedAt"],
  properties: {
    customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"},
    version: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    displayName: {type: "string", minLength: 1, maxLength: 200},
    phone: {type: "string", pattern: "^\\+[1-9][0-9]{7,14}$"},
    email: {type: "string", maxLength: 254},
    address: CUSTOMER_ADDRESS_SCHEMA,
    createdAt: {type: "string", pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"},
    updatedAt: {type: "string", pattern: "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$"},
  },
};

const CUSTOMER_SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customerRef", "version", "displayName"],
  properties: {
    customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"},
    version: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    displayName: {type: "string", minLength: 1, maxLength: 200},
    phone: {type: "string", maxLength: 32},
    email: {type: "string", maxLength: 254},
  },
};

const CUSTOMER_SEARCH_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {items: {type: "array", maxItems: 50, items: CUSTOMER_SUMMARY_SCHEMA}, nextCursor: {type: ["string", "null"], maxLength: 512}},
};

const CUSTOMER_ORDER_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["customerRef", "customerVersion", "displayName", "state"],
  properties: {
    customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"},
    customerVersion: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    displayName: {type: "string", minLength: 1, maxLength: 200},
    state: {type: "string", enum: ["Active", "Inactive"]},
  },
};

const PROBLEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "status", "code", "detail", "instance", "correlationId", "errors"],
  properties: {
    type: {type: "string", minLength: 1, maxLength: 2048}, title: {type: "string", minLength: 1, maxLength: 200},
    status: {type: "integer", minimum: 400, maximum: 599}, code: {type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$"},
    detail: {type: "string", minLength: 1, maxLength: 2000}, instance: {type: "string", minLength: 1, maxLength: 2048},
    correlationId: {type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"},
    errors: {type: "array", maxItems: 100, items: {type: "object", additionalProperties: false, required: ["code", "message"], properties: {
      code: {type: "string", pattern: "^[A-Z][A-Z0-9_]{0,63}$"}, message: {type: "string", minLength: 1, maxLength: 500}, field: {type: "string", minLength: 1, maxLength: 200},
    }}},
  },
};

function responseSchema(success: unknown, successStatus: 200 | 201, statuses: readonly number[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries([[successStatus, success], ...statuses.map((status) => [status, PROBLEM_SCHEMA])]);
}

export function registerCustomerRoutes(app: RuntimeApp, adapters: CustomerHttpAdapters): void {
  app.post(PUBLIC_ROUTES.create, {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {
      body: CUSTOMER_CREATE_SCHEMA,
      response: responseSchema(CUSTOMER_RESPONSE_SCHEMA, 201, [400, 401, 403, 409, 410, 500, 503]),
    },
    handler: async (request, reply) => {
      const context = runtimeContext(request);
      if (!adapters.verifyTransport(request, "api-public")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      let claims: PublicDelegationClaims;
      try { claims = await verifiedPublic(request, adapters, "createCustomer"); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      const replay = parseReplay(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const requestIdentity = identity(request, claims.sub);
      if ("status" in requestIdentity) return sendProblem(reply, requestIdentity);
      const ownerContext = withActor(context, claims.sub);
      if (replay) {
        let result: ReplayResult;
        try { result = await adapters.owner.replay({identity: requestIdentity, context: ownerContext}); }
        catch (error) {
          const rawCode = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
          const code = rawCode === "IDEMPOTENCY_RECORD_INVALID" ? "IDEMPOTENCY_RESULT_INVALID" : rawCode.startsWith("DB_") || rawCode === "TRANSACTION_OUTCOME_UNKNOWN" ? "IDEMPOTENCY_LOOKUP_UNAVAILABLE" : "INTERNAL_ERROR";
          return sendProblem(reply, problem(request, code === "IDEMPOTENCY_RESULT_INVALID" ? 500 : code === "INTERNAL_ERROR" ? 500 : 503, code, error instanceof Error ? error.message : "idempotency lookup failed"));
        }
        if (result.kind === "in_progress") return sendProblem(reply, problem(request, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "request is still in progress"));
        if (result.kind === "not_retained") return sendProblem(reply, problem(request, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", "completed result is not retained"));
        if (result.kind === "unavailable") return sendProblem(reply, problem(request, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE", "idempotency lookup is unavailable"));
        if (result.kind === "invalid" || !validReplayResponse(result.response)) return sendProblem(reply, problem(request, 500, "IDEMPOTENCY_RESULT_INVALID", "stored terminal response is invalid"));
        return sendOwnerResult(reply, result.response, true);
      }
      if (!validCreateBody(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "CustomerCreateRequest is invalid"));
      try {
        const result = await adapters.owner.create({request: request.body, identity: requestIdentity, context: ownerContext});
        return sendOwnerResult(reply, result);
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });

  app.get(PUBLIC_ROUTES.search, {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {
      querystring: {type: "object", required: ["query"], additionalProperties: false, properties: {query: {type: "string", minLength: 2, maxLength: 200}, limit: {type: "integer", minimum: 1, maximum: 50}, cursor: {type: "string", maxLength: 512, pattern: "^[A-Za-z0-9_-]*$"}}},
      response: responseSchema(CUSTOMER_SEARCH_RESPONSE_SCHEMA, 200, [400, 401, 403, 500, 503]),
    },
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "api-public")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      let claims: PublicDelegationClaims;
      try { claims = await verifiedPublic(request, adapters, "searchCustomers"); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      const query = typeof request.query === "object" && request.query !== null ? (request.query as Record<string, unknown>)["query"] : undefined;
      const limitValue = typeof request.query === "object" && request.query !== null ? (request.query as Record<string, unknown>)["limit"] : undefined;
      const cursor = typeof request.query === "object" && request.query !== null ? (request.query as Record<string, unknown>)["cursor"] : undefined;
      const limit = limitValue === undefined ? 20 : Number(limitValue);
      if (!stringField(query, 2, 200) || !Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor !== undefined && (!stringField(cursor, 0, 512) || !CURSOR.test(cursor)))) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "search query is invalid"));
      const context = withActor(runtimeContext(request, 1_000), claims.sub);
      try {
        const result = await adapters.owner.search({query, limit, ...(cursor === undefined ? {} : {cursor}), context});
        return sendOwnerResult(reply, result);
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });

  app.get("/api/internal-v1/customers/:customerRef/order-input", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {
      params: {type: "object", required: ["customerRef"], additionalProperties: false, properties: {customerRef: {type: "string", pattern: "^cus_[0-9A-HJKMNP-TV-Z]{26}$"}}},
      response: responseSchema(CUSTOMER_ORDER_INPUT_SCHEMA, 200, [400, 401, 403, 404, 500, 503]),
    },
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "api-internal")) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      let claims: InternalDelegationClaims;
      try { claims = await verifiedInternal(request, adapters); }
      catch (error) {
        const code = error instanceof Error ? error.message : "SERVICE_DELEGATION_INVALID";
        return sendProblem(reply, problem(request, code === "SERVICE_AUTHENTICATION_REQUIRED" ? 401 : 403, code === "SERVICE_AUTHENTICATION_REQUIRED" ? code : "SERVICE_DELEGATION_INVALID", "signed service delegation is invalid"));
      }
      const customerRef = typeof request.params === "object" && request.params !== null ? (request.params as Record<string, unknown>)["customerRef"] : undefined;
      if (typeof customerRef !== "string" || !CUSTOMER_REF.test(customerRef)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "customerRef is invalid"));
      const context = runtimeContext(request, 1_000);
      try {
        const result = await adapters.owner.orderInput({customerRef, context: {...context, actorRef: claims.originalCaller}});
        return sendOwnerResult(reply, result);
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });
}

type CustomerOwnerIdempotency = IdempotencyStore<CustomerIdempotencyResponse>;

function nowMs(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

function failClosedSecurity(): Pick<CustomerHttpAdapters, "verifyTransport" | "verifyPublicDelegation" | "verifyInternalDelegation"> {
  return {
    verifyTransport: () => false,
    verifyPublicDelegation: () => { throw new Error("CUSTOMER_TRANSPORT_NOT_CONFIGURED"); },
    verifyInternalDelegation: () => { throw new Error("CUSTOMER_TRANSPORT_NOT_CONFIGURED"); },
  };
}

export function createCustomerAdapters(
  database: Database,
  security: Pick<CustomerHttpAdapters, "verifyTransport" | "verifyPublicDelegation" | "verifyInternalDelegation"> = failClosedSecurity(),
): CustomerHttpAdapters {
  const repository = new CustomerRepository(database);
  const idempotency: CustomerOwnerIdempotency = createCustomerIdempotencyRepository(database);
  const owner: CustomerOwner = {
    create: async ({request, identity, context}) => {
      const result: CreateCustomerResult = await createCustomer(database, repository, idempotency, {
        actorRef: identity.actorRef,
        scope: identity.scope,
        idempotencyKey: identity.key,
        correlationId: context.correlationId,
        body: request,
        signal: context.signal,
      });
      return {status: result.status, body: result.body, resourceRef: result.body.customerRef};
    },
    search: async ({query, limit, cursor, context}) => ({
      status: 200,
      body: await searchCustomers(database, repository, {query, limit, ...(cursor === undefined ? {} : {cursor})}, context.signal),
    }),
    orderInput: async ({customerRef, context}) => ({
      status: 200,
      body: await getCustomerOrderInput(database, repository, customerRef, context.signal),
    }),
    replay: async ({identity, context}) => withTransaction(database, {
      mode: "interactive",
      signal: context.signal,
      correlationId: context.correlationId,
    }, async transaction => {
      const record = await idempotency.get(transaction, identity);
      if (record === undefined) return {kind: "not_retained"} as const;
      if (record.state === "Acquired") return {kind: "in_progress"} as const;
      if (record.expiresAtMs <= nowMs()) return {kind: "not_retained"} as const;
      if (record.response === undefined) return {kind: "invalid"} as const;
      return {kind: "completed", response: {status: record.response.status, body: record.response.body, ...(record.response.resourceRef === undefined ? {} : {resourceRef: record.response.resourceRef})}} as const;
    }),
  };
  return {...security, owner};
}

function unavailable(message: string): Error {
  return new Error(message);
}

export function createUnavailableCustomerAdapters(): CustomerHttpAdapters {
  const owner: CustomerOwner = {
    create: async () => { throw unavailable("CUSTOMER_HTTP_OWNER_NOT_CONFIGURED"); },
    search: async () => { throw unavailable("CUSTOMER_HTTP_OWNER_NOT_CONFIGURED"); },
    orderInput: async () => { throw unavailable("CUSTOMER_HTTP_OWNER_NOT_CONFIGURED"); },
    replay: async () => { throw unavailable("CUSTOMER_HTTP_OWNER_NOT_CONFIGURED"); },
  };
  return {
    owner,
    verifyTransport: () => false,
    verifyPublicDelegation: () => { throw unavailable("CUSTOMER_HTTP_SECURITY_NOT_CONFIGURED"); },
    verifyInternalDelegation: () => { throw unavailable("CUSTOMER_HTTP_SECURITY_NOT_CONFIGURED"); },
  };
}

export type {CustomerCreateRequest, CustomerOrderInput, CustomerResponse, CustomerSearchResponse, CustomerSummary};
