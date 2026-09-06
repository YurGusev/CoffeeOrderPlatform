import {createHash} from "node:crypto";
import type {Database} from "@coffee-platform/database";
import {customerContractSchemas, customerErrorPolicy, customerErrorPolicyEntry, customerResponseSchema, customerSearchQueryError, decodeCustomerSearchQuery, hasCustomerPermission, isCustomerCreateRequest, isCustomerIdempotencyKey, isCustomerOrderInput, isCustomerProblem, isCustomerRef, isCustomerResponse, isCustomerSearchResponse, isCustomerReplayOnly} from "@coffee-platform/contracts-customer-v1";
import type {CustomerCreateRequest, CustomerOrderInput, CustomerResponse, CustomerSearchResponse, CustomerSummary} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeRequestContext} from "@coffee-platform/runtime";
import {createCustomer} from "../application/create-customer.js";
import {getCustomerOrderInput} from "../application/get-customer-order-input.js";
import {searchCustomers, type CustomerCursorSigner} from "../application/search-customers.js";
import {createCustomerIdempotencyRepository} from "../infrastructure/postgres/idempotency-repository.js";
import {CustomerRepository} from "../infrastructure/postgres/customer-repository.js";
import {CustomerStore} from "../infrastructure/postgres/customer-store.js";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_BYTES = 8 * 1024;

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
  log?: Readonly<{warn: (fields: Readonly<Record<string, unknown>>, message: string) => void}>;
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
type OwnerResult = Readonly<{status: number; body: unknown; resourceRef?: string; replayed?: boolean}>;
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

function exceedsBodyLimit(request: Request): boolean {
  const declared = oneHeader(header(request, "content-length"));
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return true;
  if (request.body === undefined) return false;
  try { return Buffer.byteLength(JSON.stringify(request.body), "utf8") > MAX_BODY_BYTES; } catch { return true; }
}

function exceedsUrlLimit(request: Request): boolean {
  return Buffer.byteLength(request.url, "utf8") > MAX_URL_BYTES;
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

type SuccessKind = "create" | "search" | "order";

function ownerErrorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function safeOwnerProblem(request: Request, error: unknown, replayLookup = false): Problem {
  const rawCode = ownerErrorCode(error);
  if (replayLookup && (rawCode === "IDEMPOTENCY_RECORD_INVALID" || rawCode === "IDEMPOTENCY_NOT_ACQUIRED")) {
    const policy = customerErrorPolicy.IDEMPOTENCY_RESULT_INVALID;
    return problem(request, policy.status, "IDEMPOTENCY_RESULT_INVALID", policy.detail);
  }
  if (replayLookup && (rawCode?.startsWith("DB_") || rawCode === "TRANSACTION_OUTCOME_UNKNOWN")) {
    const policy = customerErrorPolicy.IDEMPOTENCY_LOOKUP_UNAVAILABLE;
    return problem(request, policy.status, "IDEMPOTENCY_LOOKUP_UNAVAILABLE", policy.detail);
  }
  if (rawCode !== undefined) {
    const knownPolicy = customerErrorPolicyEntry(rawCode);
    if (knownPolicy !== undefined) return problem(request, knownPolicy.status, rawCode, knownPolicy.detail);
  }
  if (rawCode?.startsWith("DB_") || rawCode === "TRANSACTION_OUTCOME_UNKNOWN") {
    const policy = customerErrorPolicy.CUSTOMER_UNAVAILABLE;
    return problem(request, policy.status, "CUSTOMER_UNAVAILABLE", policy.detail);
  }
  const policy = customerErrorPolicy.INTERNAL_ERROR;
  return problem(request, policy.status, "INTERNAL_ERROR", policy.detail);
}

function successValid(kind: SuccessKind, value: unknown): boolean {
  return kind === "create" ? isCustomerResponse(value) : kind === "search" ? isCustomerSearchResponse(value) : isCustomerOrderInput(value);
}

function forwardedOwnerProblem(request: Request, value: unknown, status: number): Problem {
  if (!isCustomerProblem(value)) return safeOwnerProblem(request, value);
  const policy = customerErrorPolicyEntry(value.code);
  return policy !== undefined && policy.status === status
    ? problem(request, policy.status, value.code, policy.detail)
    : safeOwnerProblem(request, new Error("invalid owner problem"));
}

function sendOwnerResult(request: Request, reply: Reply, result: OwnerResult, kind: SuccessKind, replayed = false): Reply {
  reply.header("cache-control", "no-store");
  if (replayed || result.replayed === true) reply.header("idempotency-replayed", "true");
  if (result.status >= 400) {
    return sendProblem(reply, forwardedOwnerProblem(request, result.body, result.status));
  }
  if (!successValid(kind, result.body)) return sendProblem(reply, safeOwnerProblem(request, new Error("invalid owner response")));
  return reply.code(result.status).send(result.body);
}

function sendOwnerFailure(request: Request, reply: Reply, error: unknown): Reply {
  if (ownerErrorCode(error) === "TRANSACTION_OUTCOME_UNKNOWN") {
    request.log?.warn(
      {event: "customer.transaction_outcome_unknown", errorCode: "TRANSACTION_OUTCOME_UNKNOWN"},
      "customer transaction outcome is unknown",
    );
  }
  return sendProblem(reply, safeOwnerProblem(request, error));
}

function validReplayResponse(response: OwnerResult): boolean {
  return response.status === 201 && isCustomerResponse(response.body);
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
    if (claims.iss !== "api-public" || claims.aud !== "customer-service" || claims.originalIssuer !== "edge-gateway" || claims.operationId !== operationId || !claims.sub || !hasCustomerPermission(claims.permissions, operationId as "createCustomer" | "searchCustomers")) throw new Error("ACTOR_CONTEXT_INVALID");
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

function frameworkError(request: Request, reply: Reply, error: unknown): Reply {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const validation = code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
  const policy = validation ? customerErrorPolicy.VALIDATION_FAILED : customerErrorPolicy.INTERNAL_ERROR;
  return sendProblem(reply, problem(request, policy.status, validation ? "VALIDATION_FAILED" : "INTERNAL_ERROR", policy.detail));
}

function parseReplay(request: Request): boolean | Problem {
  const value = oneHeader(header(request, "idempotency-replay-only"));
  if (value === undefined) return false;
  if (!isCustomerReplayOnly(value === "true") || request.body !== undefined || header(request, "if-match-version") !== undefined) return problem(request, 400, "VALIDATION_FAILED", "replay-only requires true and an empty body");
  return true;
}

function identity(request: Request, actorRef: string): Identity | Problem {
  const key = oneHeader(header(request, "idempotency-key"));
  if (key === undefined || !isCustomerIdempotencyKey(key)) return problem(request, 400, "VALIDATION_FAILED", "Idempotency-Key must be a UUID");
  const scope = createHash("sha256").update(`POST\n${PUBLIC_ROUTES.create}`, "utf8").digest("hex");
  return {actorRef, scope, key};
}

export function registerCustomerRoutes(app: RuntimeApp, adapters: CustomerHttpAdapters): void {
  app.post(PUBLIC_ROUTES.create, {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (error, request, reply) => frameworkError(request, reply, error),
    schema: {
      response: customerResponseSchema(customerContractSchemas.response, 201, [400, 401, 403, 409, 410, 500, 503]),
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
      if (exceedsBodyLimit(request)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const replay = parseReplay(request);
      if (typeof replay !== "boolean") return sendProblem(reply, replay);
      const requestIdentity = identity(request, claims.sub);
      if ("status" in requestIdentity) return sendProblem(reply, requestIdentity);
      const ownerContext = withActor(context, claims.sub);
      if (replay) {
        let result: ReplayResult;
        try { result = await adapters.owner.replay({identity: requestIdentity, context: ownerContext}); }
        catch (error) { return sendProblem(reply, safeOwnerProblem(request, error, true)); }
        if (result.kind === "in_progress") return sendProblem(reply, problem(request, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", "request is still in progress"));
        if (result.kind === "not_retained") return sendProblem(reply, problem(request, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", "completed result is not retained"));
        if (result.kind === "unavailable") return sendProblem(reply, problem(request, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE", "idempotency lookup is unavailable"));
        if (result.kind === "invalid" || !validReplayResponse(result.response)) return sendProblem(reply, problem(request, 500, "IDEMPOTENCY_RESULT_INVALID", "stored terminal response is invalid"));
        return sendOwnerResult(request, reply, result.response, "create", true);
      }
      if (!isCustomerCreateRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      try {
        const result = await adapters.owner.create({request: request.body, identity: requestIdentity, context: ownerContext});
        return sendOwnerResult(request, reply, result, "create");
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });

  app.get(PUBLIC_ROUTES.search, {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {
      response: customerResponseSchema(customerContractSchemas.searchResponse, 200, [400, 401, 403, 500, 503]),
    },
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "api-public")) return sendProblem(reply, problem(request, 401, "AUTHENTICATION_REQUIRED", "service identity is required"));
      let claims: PublicDelegationClaims;
      try { claims = await verifiedPublic(request, adapters, "searchCustomers"); }
      catch (error) {
        const code = error instanceof Error ? error.message : "ACTOR_CONTEXT_INVALID";
        return sendProblem(reply, problem(request, code === "AUTHENTICATION_REQUIRED" ? 401 : 403, code === "AUTHENTICATION_REQUIRED" ? code : "ACTOR_CONTEXT_INVALID", "signed actor context is invalid"));
      }
      if (exceedsUrlLimit(request)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const decodedQuery = decodeCustomerSearchQuery(request.query);
      if (decodedQuery === undefined) return sendProblem(reply, problem(request, 400, customerSearchQueryError(request.query), "Request validation failed"));
      const query = decodedQuery.query;
      const limit = decodedQuery.limit ?? 20;
      const cursor = decodedQuery.cursor;
      const context = withActor(runtimeContext(request, 1_000), claims.sub);
      try {
        const result = await adapters.owner.search({query, limit, ...(cursor === undefined ? {} : {cursor}), context});
        return sendOwnerResult(request, reply, result, "search");
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });

  app.get("/api/internal-v1/customers/:customerRef/order-input", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {
      response: customerResponseSchema(customerContractSchemas.orderInput, 200, [400, 401, 403, 404, 500, 503]),
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
      if (!isCustomerRef(customerRef)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const context = runtimeContext(request, 1_000);
      try {
        const result = await adapters.owner.orderInput({customerRef, context: {...context, actorRef: claims.originalCaller}});
        return sendOwnerResult(request, reply, result, "order");
      } catch (error) { return sendOwnerFailure(request, reply, error); }
    },
  });
}

export function createCustomerOwner(store: CustomerStore, cursorSigner?: CustomerCursorSigner): CustomerOwner {
  return {
    create: async ({request, identity, context}) => {
      const result = await createCustomer(store, {
        actorRef: identity.actorRef,
        scope: identity.scope,
        idempotencyKey: identity.key,
        correlationId: context.correlationId,
        body: request,
        signal: context.signal,
      });
      return {status: result.status, body: result.body, resourceRef: result.body.customerRef, replayed: result.replayed};
    },
    search: async ({query, limit, cursor, context}) => ({
      status: 200,
      body: await searchCustomers(store, {query, limit, ...(cursor === undefined ? {} : {cursor})}, cursorSigner, context.signal),
    }),
    orderInput: async ({customerRef, context}) => ({
      status: 200,
      body: await getCustomerOrderInput(store, customerRef, context.signal),
    }),
    replay: async ({identity, context}) => store.replay(identity, context.signal, context.correlationId),
  };
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
  cursorSigner?: CustomerCursorSigner,
): CustomerHttpAdapters {
  const repository = new CustomerRepository(database);
  const store = new CustomerStore(database, repository, createCustomerIdempotencyRepository(database));
  return {...security, owner: createCustomerOwner(store, cursorSigner)};
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
