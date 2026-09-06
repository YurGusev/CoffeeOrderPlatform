import {createPrivateKey, createPublicKey, randomUUID} from "node:crypto";
import {customerContractSchemas, customerErrorPolicy, customerErrorPolicyEntry, customerResponseSchema, isCustomerOrderInput, isCustomerProblem, isCustomerRef} from "@coffee-platform/contracts-customer-v1";
import type {CustomerOrderInput} from "@coffee-platform/contracts-customer-v1";
import type {RuntimeComposition, RuntimeCompositionContext, RuntimeRequestContext} from "@coffee-platform/runtime";
import {parseServiceTransportMaterial, signServiceDelegation, verifyServiceDelegationWithKeySet, type ServiceTransportMaterial} from "@coffee-platform/security";

type HeaderValue = string | string[] | undefined;
type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
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
  verifyTransport: (request: Request, expectedCaller: "orders-service") => boolean;
  verifyCallerDelegation: (token: string, request: Request, operationId: string, signal: AbortSignal) => Promise<InternalCallerClaims> | InternalCallerClaims;
  signDelegation: (claims: Readonly<{originalCaller: string; operationId: string; context: Context}>) => string;
  customer: Readonly<{orderInput: (customerRef: string, context: Context, delegation: string) => Promise<ForwardResult>}>;
}>;

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function oneHeader(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function context(request: Request): Context {
  const runtime: RuntimeRequestContext | null | undefined = request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  return {
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined ? {} : {traceparent: runtime.traceparent}),
    signal: AbortSignal.any([base, AbortSignal.timeout(1_000)]),
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

function spoofed(request: Request): boolean {
  const blocked = ["x-actor-ref", "x-original-issuer", "x-transport-caller", "x-service-identity", "x-actor-context"];
  return blocked.some((name) => header(request, name) !== undefined) || Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-actor-"));
}

export function registerInternalRoutes(app: RuntimeApp, adapters: InternalApiAdapters): void {
  app.get("/api/internal-v1/customers/:customerRef/order-input", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    schema: {response: customerResponseSchema(customerContractSchemas.orderInput, 200, [400, 401, 403, 404, 500, 503])},
    handler: async (request, reply) => {
      if (spoofed(request) || !adapters.verifyTransport(request, "orders-service")) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      const token = oneHeader(header(request, "x-service-delegation"));
      if (token === undefined) return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "signed service delegation is required"));
      const requestContext = context(request);
      let claims: InternalCallerClaims;
      try { claims = await adapters.verifyCallerDelegation(token, request, "getCustomerOrderInput", requestContext.signal); }
      catch { return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed")); }
      if (claims.iss !== "orders-service" || claims.aud !== "api-internal" || claims.originalCaller !== "orders-service" || claims.operationId !== "getCustomerOrderInput") return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      const params = request.params !== null && typeof request.params === "object" && !Array.isArray(request.params) ? request.params as Record<string, unknown> : {};
      const customerRef = params["customerRef"];
      if (!isCustomerRef(customerRef)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      const delegation = adapters.signDelegation({originalCaller: "orders-service", operationId: "getCustomerOrderInput", context: requestContext});
      try {
        const result = await adapters.customer.orderInput(customerRef, requestContext, delegation);
        return sendForward(request, reply, result);
      } catch {
        return sendProblem(reply, problem(request, 503, "CUSTOMER_UNAVAILABLE", "customer service is unavailable"));
      }
    },
  });
}

export function createHttpCustomerClient(client: HttpClient): InternalApiAdapters["customer"] {
  return {
    orderInput: async (customerRef, requestContext, delegation) => {
      const headers: Record<string, string> = {"x-service-delegation": delegation, "x-correlation-id": requestContext.correlationId};
      if (requestContext.traceparent !== undefined) headers["traceparent"] = requestContext.traceparent;
      const response = await client.fetch(`/api/internal-v1/customers/${encodeURIComponent(customerRef)}/order-input`, {method: "GET", headers, signal: requestContext.signal});
      let body: unknown;
      try { body = await response.json(); } catch { body = {type: "about:blank", title: "CUSTOMER_UNAVAILABLE", status: 503, code: "CUSTOMER_UNAVAILABLE", detail: "customer service returned an invalid response", instance: "/api/internal-v1/customers/order-input", correlationId: requestContext.correlationId, errors: []}; }
      return {status: response.status, body};
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

export function createConfiguredInternalAdapters(context: RuntimeCompositionContext, client: HttpClient): InternalApiAdapters {
  const signingKey = privateKey(context, "security.apiInternalDelegationSigningPrivateKey");
  const callerVerificationKeys = verificationKeys(context, "security.serviceVerificationKeys.orders-service");
  return {
    verifyTransport: (request, expectedCaller) => request.runtimeContext?.transportIdentity?.runtime === expectedCaller,
    verifyCallerDelegation: (token, _request, operationId, signal) => {
      signal.throwIfAborted();
      return verifyServiceDelegationWithKeySet(token, {publicKeys: callerVerificationKeys, issuer: "orders-service", audience: "api-internal", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
    },
    signDelegation: ({originalCaller, operationId, context: requestContext}) => {
      const iat = epochSeconds();
      return signServiceDelegation({
        iss: "api-internal",
        aud: "customer-service",
        originalCaller,
        operationId,
        correlationId: requestContext.correlationId,
        traceparent: requestContext.traceparent ?? "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + 5,
        jti: randomUUID(),
        kid: "api-internal-delegation-v1",
      }, signingKey);
    },
    customer: createHttpCustomerClient({fetch: (path, options) => client.fetch(path, options)}),
  };
}

export function configuredTransportMaterial(context: RuntimeCompositionContext): ServiceTransportMaterial {
  let value: unknown = context.secrets;
  for (const part of "security.serviceTransportKeys.api-internal".split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("INTERNAL_API_TRANSPORT_NOT_CONFIGURED");
    value = (value as Record<string, unknown>)[part];
  }
  return parseServiceTransportMaterial(value, context.config.environment, "api-internal");
}

export function configuredCustomerTls(context: RuntimeCompositionContext) {
  return {material: configuredTransportMaterial(context), targetEnvironment: context.config.environment, targetRuntime: "customer-service"};
}

export function configuredCustomerOrigin(context: RuntimeCompositionContext): string {
  return customerOrigin(context);
}

export function createUnavailableInternalAdapters(): InternalApiAdapters {
  return {
    verifyTransport: () => false,
    verifyCallerDelegation: () => { throw new Error("INTERNAL_API_SECURITY_NOT_CONFIGURED"); },
    signDelegation: () => { throw new Error("INTERNAL_API_SECURITY_NOT_CONFIGURED"); },
    customer: {orderInput: async () => { throw new Error("INTERNAL_API_CUSTOMER_CLIENT_NOT_CONFIGURED"); }},
  };
}

export type {CustomerOrderInput};
