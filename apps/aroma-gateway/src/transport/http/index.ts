import {createPublicKey} from "node:crypto";
import {aromaContractSchemas, isAromaCatalogExportRequest, isAromaCartSnapshot, isAromaCartSnapshotReadRequest, isAromaOfferBindingRequest, isAromaOfferBindingResponse, isAromaRemoveLineRequest, isAromaSetQuantityRequest, type AromaCartSnapshot, type AromaOfferBindingRequest, type AromaOfferBindingResponse} from "@coffee-platform/contracts-aroma-v1";
import type {Database} from "@coffee-platform/database";
import type {RuntimeComposition, RuntimeCompositionContext, RuntimeRequestContext} from "@coffee-platform/runtime";
import {verifyServiceDelegationWithKeySet} from "@coffee-platform/security";
import {ProviderError} from "../../domain/provider-errors.js";
import type {ProviderCartReader} from "../../application/cart-reader.js";
import {OfferBindingStore, OfferBindingStoreError} from "../../infrastructure/database/offer-binding-store.js";
import {Readable} from "node:stream";
import {createCatalogExportStream, type CatalogExportBoundary, type CatalogExportRequest} from "../../application/catalog-export.js";
import type {GatewayTelemetry} from "../../infrastructure/observability.js";
import {GatewayMutationExecutor, type MutationDelegation, type MutationExecutionResult} from "../../domain/mutation-journal.js";

type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type HeaderValue = string | string[] | undefined;
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
  body: unknown;
  params?: unknown;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{url: string | undefined}>;
  url: string;
}>;
type Reply = {header: (name: string, value: string) => Reply; code: (status: number) => Reply; type: (value: string) => Reply; send: (body?: unknown) => Reply};
type InternalClaims = Readonly<{iss: string; aud: string; originalCaller: string; operationId: string; correlationId: string; traceparent: string; iat: number; exp: number; jti: string; kid: string}>;

const OPERATION = "registerAromaOfferBinding" as const;
const CANONICAL_AROMA_SUPPLIER_REF = "sup_00000000000000000000000001" as const;

function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function oneHeader(value: HeaderValue): string | undefined { return Array.isArray(value) ? value[0] : value; }

function problem(request: Request, status: number, code: string, detail: string): Readonly<Record<string, unknown>> {
  return {type: "about:blank", title: code, status, code, detail, instance: request.routeOptions.url ?? request.url, correlationId: request.runtimeContext?.correlationId ?? request.id, errors: []};
}

function sendProblem(reply: Reply, body: Readonly<Record<string, unknown>>): Reply {
  return reply.header("cache-control", "no-store").code(Number(body["status"])).type("application/problem+json").send(body);
}

function frameworkError(request: Request, reply: Reply, error: unknown): Reply {
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const validation = code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_EMPTY_JSON_BODY" || code === "FST_ERR_CTP_BODY_TOO_LARGE" || code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
  return sendProblem(reply, problem(request, validation ? 400 : 503, validation ? "VALIDATION_FAILED" : "AROMA_PROVIDER_UNAVAILABLE", validation ? "Request validation failed" : "binding storage is unavailable"));
}

function context(request: Request): Readonly<{correlationId: string; traceparent?: string; signal: AbortSignal}> {
  const runtime = request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  return {correlationId: runtime?.correlationId ?? request.id, ...(runtime?.traceparent === undefined ? {} : {traceparent: runtime.traceparent}), signal: AbortSignal.any([base, AbortSignal.timeout(5_000)])};
}

function spoofed(request: Request): boolean {
  const blocked = ["x-actor-ref", "x-actor-permissions", "x-original-issuer", "x-original-caller", "x-service-identity", "x-transport-caller", "x-actor-context"];
  return blocked.some((name) => header(request, name) !== undefined) || Object.keys(request.headers).some((name) => name.toLowerCase().startsWith("x-actor-"));
}

function keys(context: RuntimeCompositionContext): readonly ReturnType<typeof createPublicKey>[] {
  let value: unknown = context.secrets;
  for (const part of "security.delegationVerificationKeys.api-internal".split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("AROMA_GATEWAY_DELEGATION_KEYS_NOT_CONFIGURED");
    value = (value as Record<string, unknown>)[part];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("AROMA_GATEWAY_DELEGATION_KEYS_NOT_CONFIGURED");
  const source = value as Record<string, unknown>;
  if (typeof source["active"] !== "string" || typeof source["previous"] !== "string") throw new Error("AROMA_GATEWAY_DELEGATION_KEYS_NOT_CONFIGURED");
  return [createPublicKey(source["active"]), createPublicKey(source["previous"])] as const;
}

function epochSeconds(): number { return Math.floor((performance.timeOrigin + performance.now()) / 1_000); }

function registerRoute(app: RuntimeApp, database: Database | undefined, verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined, expectedSupplierRef: string | undefined): void {
  const store = database === undefined ? undefined : new OfferBindingStore(database);
  app.post("/api/internal-v1/aroma/offer-bindings", {
    config: {runtimeDeadlineProfile: "defaultMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (error, request, rawReply) => frameworkError(request, rawReply as unknown as Reply, error),
    schema: {response: {200: aromaContractSchemas["offerBindingResponse"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 409: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (spoofed(request) || header(request, "x-service-delegation") === undefined || request.runtimeContext?.transportIdentity?.runtime !== "api-internal") return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      if (verificationKeys === undefined) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding storage is unavailable"));
      let claims: InternalClaims;
      try {
        const token = oneHeader(header(request, "x-service-delegation"));
        if (token === undefined) throw new Error("missing delegation");
        claims = verifyServiceDelegationWithKeySet(token, {publicKeys: verificationKeys, issuer: "api-internal", audience: "aroma-gateway", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
      } catch {
        return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      }
      if (claims.iss !== "api-internal" || claims.aud !== "aroma-gateway" || claims.originalCaller !== "catalog-activation-worker" || claims.operationId !== OPERATION) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      if (!isAromaOfferBindingRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      if (expectedSupplierRef !== undefined && request.body.supplierRef !== expectedSupplierRef) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      if (store === undefined) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding storage is unavailable"));
      try {
        const result = await store.register(request.body as AromaOfferBindingRequest, context(request).signal);
        if (!isAromaOfferBindingResponse(result)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding storage returned an invalid response"));
        return reply.header("cache-control", "no-store").code(200).send(result);
      } catch (error) {
        if (error instanceof OfferBindingStoreError) return sendProblem(reply, problem(request, 409, error.code, "immutable binding request was rejected"));
        return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "binding storage is unavailable"));
      }
    },
  });
}

export function registerAromaBindingRoutes(app: RuntimeApp, database: Database | undefined, context: RuntimeCompositionContext | undefined, expectedSupplierRef?: string): void {
  let verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined;
  if (context !== undefined) {
    try { verificationKeys = keys(context); } catch { verificationKeys = undefined; }
  }
  registerRoute(app, database, verificationKeys, expectedSupplierRef ?? context?.config?.aroma?.supplierRef ?? CANONICAL_AROMA_SUPPLIER_REF);
}

export function createUnavailableAromaBindingRoutes(app: RuntimeApp): void { registerRoute(app, undefined, undefined, undefined); }

function cartContext(request: Request): Readonly<{correlationId: string; traceparent?: string; signal: AbortSignal}> {
  const runtime = request.runtimeContext;
  const base = runtime?.signal ?? new AbortController().signal;
  return {correlationId: runtime?.correlationId ?? request.id, ...(runtime?.traceparent === undefined ? {} : {traceparent: runtime.traceparent}), signal: AbortSignal.any([base, AbortSignal.timeout(10_000)])};
}

export function registerAromaCartSnapshotRoute(app: RuntimeApp, reader: ProviderCartReader, context: RuntimeCompositionContext | undefined): void {
  let verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined;
  if (context !== undefined) {
    try { verificationKeys = keys(context); } catch { verificationKeys = undefined; }
  }
  app.post("/api/internal-v1/aroma/cart-snapshots:read", {
    config: {runtimeDeadlineProfile: "cartMs"},
    bodyLimit: 64 * 1024,
    errorHandler: (error, request, rawReply) => frameworkError(request, rawReply as unknown as Reply, error),
    schema: {response: {200: aromaContractSchemas["cartSnapshot"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}},
    handler: async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      if (spoofed(request) || header(request, "x-service-delegation") === undefined || request.runtimeContext?.transportIdentity?.runtime !== "api-internal") return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
      if (verificationKeys === undefined) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability is unavailable"));
      let claims: InternalClaims;
      try {
        const token = oneHeader(header(request, "x-service-delegation"));
        if (token === undefined) throw new Error("missing delegation");
        claims = verifyServiceDelegationWithKeySet(token, {publicKeys: verificationKeys, issuer: "api-internal", audience: "aroma-gateway", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5});
      } catch {
        return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      }
      if ((claims.originalCaller !== "aroma-observer" && claims.originalCaller !== "aroma-convergence") || claims.iss !== "api-internal" || claims.aud !== "aroma-gateway" || claims.operationId !== "readAromaCartSnapshot") return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
      if (!isAromaCartSnapshotReadRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
      try {
        const requestSignal = cartContext(request).signal;
        request.log?.info({event: "aroma.safe_read.start", aborted: requestSignal.aborted, reason: requestSignal.reason instanceof Error ? requestSignal.reason.name : typeof requestSignal.reason}, "AROMA safe read started");
        const result = await reader.read(requestSignal);
        if (!isAromaCartSnapshot(result)) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability returned an invalid response"));
        return reply.header("cache-control", "no-store").code(200).send(result);
      } catch (error) {
        if (error instanceof ProviderError) request.log?.warn({event: "aroma.safe_read.failure", code: error.code, responseBytesReceived: error.responseBytesReceived, statusCode: error.statusCode}, "AROMA safe read failed");
        return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability is unavailable"));
      }
    },
  });
}

export type {AromaOfferBindingRequest, AromaOfferBindingResponse, AromaCartSnapshot};

function mutationRequest(request: Request, operationKind: "SetLineQuantity" | "RemoveLine", offerRef: string): Readonly<Record<string, unknown>> | undefined {
  if (operationKind === "SetLineQuantity") {
    if (!isAromaSetQuantityRequest(request.body)) return undefined;
    const value = request.body;
    // Provider mutation semantics are only proven for the existing integer representation;
    // keep decimal wire lossless at transport, but fail closed before journal/provider dispatch.
    if (value.quantity.includes(".")) return undefined;
    return {operationRef: value.operationRef, cartScopeRef: value.cartScopeRef, operationKind, offerRef, quantityMilli: value.quantity};
  }
  if (!isAromaRemoveLineRequest(request.body)) return undefined;
  const value = request.body;
  return {operationRef: value.operationRef, cartScopeRef: value.cartScopeRef, operationKind, offerRef};
}

function mutationDelegation(request: Request, claims: InternalClaims): MutationDelegation {
  return {transportCaller: request.runtimeContext?.transportIdentity?.runtime ?? "", issuer: claims.iss, audience: claims.aud, originalCaller: claims.originalCaller, operationId: claims.operationId, callerIdentity: "api-internal", correlationId: claims.correlationId, ...(claims.traceparent === undefined ? {} : {traceparent: claims.traceparent})};
}

function mutationResult(reply: Reply, request: Request, result: MutationExecutionResult): Reply {
  if (result.state === "Acknowledged") return reply.header("cache-control", "no-store").code(200).send(JSON.parse(new TextDecoder().decode(result.responseBodyBytes)));
  if (result.state === "Rejected") return sendProblem(reply, JSON.parse(new TextDecoder().decode(result.responseBodyBytes)) as Readonly<Record<string, unknown>>);
  return sendProblem(reply, problem(request, 409, result.state === "UnknownOutcome" ? "AROMA_OPERATION_UNKNOWN_OUTCOME" : "AROMA_OPERATION_IN_PROGRESS", "mutation outcome requires reconciliation"));
}

function registerMutationRoute(app: RuntimeApp, executor: GatewayMutationExecutor, verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined): void {
  app.post("/api/internal-v1/aroma/cart-lines/:mutationTarget", {config: {runtimeDeadlineProfile: "mutationMs"}, bodyLimit: 64 * 1024, errorHandler: (error, request, rawReply) => frameworkError(request, rawReply as unknown as Reply, error), schema: {response: {200: aromaContractSchemas["mutationResponse"], 400: aromaContractSchemas["problem"], 401: aromaContractSchemas["problem"], 403: aromaContractSchemas["problem"], 404: aromaContractSchemas["problem"], 409: aromaContractSchemas["problem"], 503: aromaContractSchemas["problem"]}}, handler: async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const params = request.params !== null && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const target = params["mutationTarget"];
    const match = typeof target === "string" ? /^(off_[0-9A-HJKMNP-TV-Z]{26}):(set-quantity|remove)$/u.exec(target) : null;
    if (match === null) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
    const offerRef = match[1]!;
    const operationKind = match[2] === "set-quantity" ? "SetLineQuantity" : "RemoveLine";
    const operationId = operationKind === "SetLineQuantity" ? "setAromaCartLineQuantity" : "removeAromaCartLine";
    if (spoofed(request) || header(request, "x-service-delegation") === undefined || request.runtimeContext?.transportIdentity?.runtime !== "api-internal") return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
    if (verificationKeys === undefined) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability is unavailable"));
    let claims: InternalClaims;
    try { const token = oneHeader(header(request, "x-service-delegation")); if (token === undefined) throw new Error("missing delegation"); claims = verifyServiceDelegationWithKeySet(token, {publicKeys: verificationKeys, issuer: "api-internal", audience: "aroma-gateway", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5}); } catch { return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed")); }
    if (claims.originalCaller !== "aroma-convergence" || claims.operationId !== operationId) return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
    const body = mutationRequest(request, operationKind, offerRef);
    if (body === undefined) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
    try { return mutationResult(reply, request, await executor.execute(body as never, mutationDelegation(request, claims), request.runtimeContext?.signal)); }
    catch (error) { const code = error !== null && typeof error === "object" && "code" in error && typeof (error as {code?: unknown}).code === "string" ? (error as {code: string}).code : "UNKNOWN"; if (code === "AROMA_MUTATION_INVALID") return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed")); if (code === "AROMA_OPERATION_REF_CONFLICT") return sendProblem(reply, problem(request, 409, "AROMA_OPERATION_REF_CONFLICT", "operation reference conflicts with a previous request")); request.log?.warn({event: "aroma.mutation.failure", code}, "AROMA mutation failed"); return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability is unavailable")); }
  }});
}

export function registerAromaMutationRoutes(app: RuntimeApp, executor: GatewayMutationExecutor, context: RuntimeCompositionContext | undefined): void {
  let verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined;
  if (context !== undefined) { try { verificationKeys = keys(context); } catch { verificationKeys = undefined; } }
  registerMutationRoute(app, executor, verificationKeys);
}

export type CatalogSourceFactory = (supplierRef: string, signal: AbortSignal) => AsyncIterable<import("../../application/catalog-export.js").NormalizedCatalogOffer>;
export function registerAromaCatalogExportRoute(app: RuntimeApp, sourceFactory: CatalogSourceFactory, boundary: CatalogExportBoundary, context: RuntimeCompositionContext | undefined, expectedSupplierRef?: string, telemetry?: GatewayTelemetry): void {
  let verificationKeys: readonly ReturnType<typeof createPublicKey>[] | undefined;
  if (context !== undefined) { try { verificationKeys = keys(context); } catch { verificationKeys = undefined; } }
  app.post("/api/internal-v1/aroma/catalog-exports", {config: {runtimeDeadlineProfile: "readMs"}, bodyLimit: 64 * 1024, errorHandler: (error, request, rawReply) => frameworkError(request, rawReply as unknown as Reply, error), handler: async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    if (spoofed(request) || header(request, "x-service-delegation") === undefined || request.runtimeContext?.transportIdentity?.runtime !== "api-internal") return sendProblem(reply, problem(request, 401, "SERVICE_AUTHENTICATION_REQUIRED", "service identity is required"));
    if (verificationKeys === undefined) return sendProblem(reply, problem(request, 503, "AROMA_PROVIDER_UNAVAILABLE", "provider capability is unavailable"));
    let claims: InternalClaims;
    try { const token = oneHeader(header(request, "x-service-delegation")); if (token === undefined) throw new Error("missing delegation"); claims = verifyServiceDelegationWithKeySet(token, {publicKeys: verificationKeys, issuer: "api-internal", audience: "aroma-gateway", nowEpochSeconds: epochSeconds(), clockSkewSeconds: 5}); } catch { return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed")); }
    if (claims.originalCaller !== "catalog-supplier-sync" || claims.operationId !== "exportAromaCatalog") return sendProblem(reply, problem(request, 403, "SERVICE_DELEGATION_INVALID", "caller, audience, or operation is not allowed"));
    if (!isAromaCatalogExportRequest(request.body)) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
    const value = request.body;
    const configuredSupplierRef = expectedSupplierRef ?? context?.config?.aroma?.supplierRef ?? CANONICAL_AROMA_SUPPLIER_REF;
    if (configuredSupplierRef !== undefined && value["supplierRef"] !== configuredSupplierRef) return sendProblem(reply, problem(request, 400, "VALIDATION_FAILED", "Request validation failed"));
    const requestValue: CatalogExportRequest = {snapshotRef: value["snapshotRef"], supplierRef: value["supplierRef"], providerSnapshotRef: `aroma-gateway:catalog-export:${value["snapshotRef"]}`};
    const signal = request.runtimeContext?.signal ?? new AbortController().signal;
    const stream = createCatalogExportStream({source: sourceFactory(requestValue.supplierRef, signal), request: requestValue, boundary, signal, ...(telemetry === undefined ? {} : {telemetry})});
    return reply.header("cache-control", "no-store").header("content-type", "application/x-ndjson").code(200).send(Readable.from(stream));
  }});
}
