import { createHash } from "node:crypto";
import type { Database } from "@coffee-platform/database";
import {
  isPricingQuoteCreateRequest,
  isPricingQuoteResponse,
  isPricingQuoteVerifyRequest,
  isPricingQuoteVerificationResponse,
  isPricingProblem,
  pricingContractSchemas,
  pricingResponseSchema,
  type PricingQuoteCreateRequest,
  type PricingQuoteVerifyRequest,
} from "@coffee-platform/contracts-pricing-v1";
import type { IdempotencyKey } from "@coffee-platform/idempotency";
import type {
  RuntimeComposition,
  RuntimeRequestContext,
} from "@coffee-platform/runtime";
import {
  createPricingQuote,
  type CatalogPricingClient,
} from "../application/create-pricing-quote.js";
import { PricingStore } from "../infrastructure/database/pricing-store.js";
import { PricingTelemetry } from "../observability.js";

type App = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type Request = Readonly<{
  headers: Readonly<Record<string, string | string[] | undefined>>;
  id: string;
  url: string;
  body: unknown;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{ url: string | undefined }>;
}>;
type Reply = {
  header(name: string, value: string): Reply;
  code(status: number): Reply;
  type(mime: string): Reply;
  send(body?: unknown): Reply;
};
type PublicClaims = Readonly<{
  iss: string;
  aud: string;
  originalIssuer: string;
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent?: string;
}>;
type InternalClaims = Readonly<{
  iss: string;
  aud: string;
  originalCaller: string;
  operationId: string;
  correlationId: string;
  traceparent?: string;
}>;
type Context = Readonly<{
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;
export type PricingSecurity = Readonly<{
  verifyTransport: (
    request: Request,
    caller: "api-public" | "api-internal",
  ) => boolean;
  verifyPublicDelegation: (
    token: string,
    operation: "createPricingQuote",
    signal: AbortSignal,
  ) => PublicClaims | Promise<PublicClaims>;
  verifyInternalDelegation: (
    token: string,
    operation: "verifyPricingQuote",
    signal: AbortSignal,
  ) => InternalClaims | Promise<InternalClaims>;
  signCatalogDelegation: (
    context: Readonly<{
      correlationId: string;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ) => string;
}>;
export type PricingOwner = Readonly<{
  create: (
    input: Readonly<{
      request: PricingQuoteCreateRequest;
      identity: IdempotencyKey;
      context: Context;
    }>,
  ) => ReturnType<typeof createPricingQuote>;
  replay: (
    identity: IdempotencyKey,
    signal: AbortSignal,
  ) => ReturnType<PricingStore["precheck"]>;
  verify: (
    request: PricingQuoteVerifyRequest,
    context: Context,
  ) => ReturnType<PricingStore["verify"]>;
}>;
export type PricingHttpAdapters = PricingSecurity &
  Readonly<{ owner: PricingOwner }>;

const CREATE = "/api/client-v1/pricing/quotes";
const VERIFY = "/api/internal-v1/pricing/quotes:verify";
const SCOPE = createHash("sha256")
  .update(`POST\n${CREATE}`, "utf8")
  .digest("hex");
const MAX_BODY_BYTES = 16 * 1024;
const statusByCode: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  AUTHENTICATION_REQUIRED: 401,
  ACTOR_CONTEXT_INVALID: 403,
  SERVICE_AUTHENTICATION_REQUIRED: 401,
  SERVICE_DELEGATION_INVALID: 403,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,
  IDEMPOTENCY_RESULT_NOT_RETAINED: 410,
  IDEMPOTENCY_LOOKUP_UNAVAILABLE: 503,
  IDEMPOTENCY_RESULT_INVALID: 500,
  CATALOG_PRODUCT_NOT_FOUND: 404,
  CATALOG_PRODUCT_UNAVAILABLE: 409,
  CATALOG_REVISION_CHANGED: 409,
  PRICING_GRIND_NOT_AVAILABLE: 422,
  CATALOG_UNAVAILABLE: 503,
  PRICING_QUOTE_NOT_FOUND: 404,
  PRICING_QUOTE_HASH_MISMATCH: 409,
  PRICING_QUOTE_EXPIRED: 409,
  PRICING_QUOTE_SCOPE_MISMATCH: 409,
  PRICING_POLICY_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};
// Pricing contracts expose runtime schemas but not an operation-specific error-policy table.
// These allowlists mirror the two OpenAPI operations; never send an internal code on client-v1.
const publicErrors = new Set([
  "VALIDATION_FAILED",
  "AUTHENTICATION_REQUIRED",
  "ACTOR_CONTEXT_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_REQUEST_IN_PROGRESS",
  "IDEMPOTENCY_RESULT_NOT_RETAINED",
  "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
  "IDEMPOTENCY_RESULT_INVALID",
  "CATALOG_PRODUCT_NOT_FOUND",
  "CATALOG_PRODUCT_UNAVAILABLE",
  "CATALOG_REVISION_CHANGED",
  "PRICING_GRIND_NOT_AVAILABLE",
  "CATALOG_UNAVAILABLE",
  "PRICING_POLICY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
const internalErrors = new Set([
  "VALIDATION_FAILED",
  "SERVICE_AUTHENTICATION_REQUIRED",
  "SERVICE_DELEGATION_INVALID",
  "PRICING_QUOTE_NOT_FOUND",
  "PRICING_QUOTE_HASH_MISMATCH",
  "PRICING_QUOTE_EXPIRED",
  "PRICING_QUOTE_SCOPE_MISMATCH",
  "PRICING_POLICY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);
function one(request: Request, name: string): string | undefined {
  const entries = Object.entries(request.headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (entries.length !== 1 || Array.isArray(entries[0]?.[1])) return undefined;
  return entries[0]?.[1];
}
function present(request: Request, name: string): boolean {
  return Object.keys(request.headers).some((key) => key.toLowerCase() === name);
}
function spoofed(request: Request, allowed: string): boolean {
  return Object.keys(request.headers).some((key) => {
    const name = key.toLowerCase();
    return (
      (name.startsWith("x-actor-") ||
        [
          "x-original-issuer",
          "x-original-caller",
          "x-service-identity",
          "x-transport-caller",
          "x-service-delegation",
        ].includes(name)) &&
      name !== allowed
    );
  });
}
function context(request: Request, deadlineMs: number): Context {
  const runtime = request.runtimeContext;
  return {
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined
      ? {}
      : { traceparent: runtime.traceparent }),
    signal: AbortSignal.any([
      runtime?.signal ?? new AbortController().signal,
      AbortSignal.timeout(deadlineMs),
    ]),
  };
}
function sendProblem(
  request: Request,
  reply: Reply,
  code: string,
  internal = false,
): Reply {
  const safeCode = (internal ? internalErrors : publicErrors).has(code)
    ? code
    : "INTERNAL_ERROR";
  const safeStatus = statusByCode[safeCode] ?? 500;
  const body = {
    type: "about:blank",
    title: safeCode,
    status: safeStatus,
    code: safeCode,
    detail: "Request could not be completed",
    instance: request.routeOptions.url ?? request.url,
    correlationId: request.runtimeContext?.correlationId ?? request.id,
    errors: [],
  };
  if (!isPricingProblem(body))
    throw new Error("PRICING_PROBLEM_SCHEMA_INVALID");
  return reply
    .header("cache-control", "no-store")
    .code(safeStatus)
    .type("application/problem+json")
    .send(body);
}
function errorCode(error: unknown, internal = false, replay = false): string {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : "";
  if (
    replay &&
    (code.startsWith("DB_") || code === "TRANSACTION_OUTCOME_UNKNOWN")
  )
    return "IDEMPOTENCY_LOOKUP_UNAVAILABLE";
  if (
    replay &&
    (code === "IDEMPOTENCY_RECORD_INVALID" ||
      code === "IDEMPOTENCY_NOT_ACQUIRED")
  )
    return "IDEMPOTENCY_RESULT_INVALID";
  if (code === "CATALOG_REVISION_CHANGED") return "CATALOG_REVISION_CHANGED";
  if (code === "PRICING_PERSISTED_FACTS_INVALID") return "INTERNAL_ERROR";
  if (code.startsWith("DB_") || code === "TRANSACTION_OUTCOME_UNKNOWN")
    return "INTERNAL_ERROR";
  return statusByCode[code] !== undefined ? code : "INTERNAL_ERROR";
}
function validBodySize(request: Request): boolean {
  const length = one(request, "content-length");
  if (
    present(request, "content-length") &&
    (length === undefined ||
      !/^\d+$/u.test(length) ||
      Number(length) > MAX_BODY_BYTES)
  )
    return false;
  try {
    return (
      request.body === undefined ||
      Buffer.byteLength(JSON.stringify(request.body), "utf8") <= MAX_BODY_BYTES
    );
  } catch {
    return false;
  }
}
function uuid(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}
function sendCreate(
  request: Request,
  reply: Reply,
  result: Awaited<ReturnType<PricingOwner["create"]>>,
): Reply {
  if (result.status !== 201 || !isPricingQuoteResponse(result.body))
    return sendProblem(request, reply, "INTERNAL_ERROR");
  reply.header("cache-control", "no-store");
  if (result.replayed) reply.header("idempotency-replayed", "true");
  return reply.code(201).send(result.body);
}
export function registerPricingRoutes(
  app: App,
  adapters: PricingHttpAdapters,
): void {
  app.post(CREATE, {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (_error, request, reply) =>
      sendProblem(request, reply, "VALIDATION_FAILED"),
    schema: {
      response: pricingResponseSchema(
        pricingContractSchemas.response,
        201,
        [400, 401, 403, 404, 409, 410, 500, 503],
      ),
    },
    handler: async (request, reply) => {
      const ctx = context(request, 5_000);
      if (!adapters.verifyTransport(request, "api-public"))
        return sendProblem(request, reply, "AUTHENTICATION_REQUIRED");
      if (spoofed(request, "x-actor-context"))
        return sendProblem(request, reply, "ACTOR_CONTEXT_INVALID");
      const token = one(request, "x-actor-context");
      if (!token)
        return sendProblem(
          request,
          reply,
          present(request, "x-actor-context")
            ? "ACTOR_CONTEXT_INVALID"
            : "AUTHENTICATION_REQUIRED",
        );
      let claims: PublicClaims;
      try {
        claims = await adapters.verifyPublicDelegation(
          token,
          "createPricingQuote",
          ctx.signal,
        );
      } catch {
        return sendProblem(request, reply, "ACTOR_CONTEXT_INVALID");
      }
      if (
        !claims ||
        claims.iss !== "api-public" ||
        claims.aud !== "pricing-service" ||
        claims.originalIssuer !== "edge-gateway" ||
        claims.operationId !== "createPricingQuote" ||
        !claims.sub ||
        !Array.isArray(claims.permissions) ||
        !claims.permissions.includes("pricing:create") ||
        claims.correlationId !== ctx.correlationId ||
        (ctx.traceparent !== undefined &&
          claims.traceparent !== ctx.traceparent)
      )
        return sendProblem(request, reply, "ACTOR_CONTEXT_INVALID");
      if (!validBodySize(request))
        return sendProblem(request, reply, "VALIDATION_FAILED");
      const key = one(request, "idempotency-key");
      if (!uuid(key)) return sendProblem(request, reply, "VALIDATION_FAILED");
      const identity = { actorRef: claims.sub, scope: SCOPE, key };
      const replay = one(request, "idempotency-replay-only");
      if (
        present(request, "idempotency-replay-only") &&
        (replay !== "true" ||
          request.body !== undefined ||
          present(request, "if-match-version"))
      )
        return sendProblem(request, reply, "VALIDATION_FAILED");
      if (replay === "true") {
        try {
          const result = await adapters.owner.replay(identity, ctx.signal);
          if (result.kind === "not_retained")
            return sendProblem(
              request,
              reply,
              "IDEMPOTENCY_RESULT_NOT_RETAINED",
            );
          if (result.kind === "in_progress")
            return sendProblem(
              request,
              reply,
              "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            );
          if (result.kind !== "completed")
            return sendProblem(request, reply, "IDEMPOTENCY_RESULT_INVALID");
          return sendCreate(request, reply, {
            status: result.status,
            body: result.body,
            replayed: true,
          });
        } catch (error) {
          return sendProblem(request, reply, errorCode(error, false, true));
        }
      }
      if (!isPricingQuoteCreateRequest(request.body))
        return sendProblem(request, reply, "VALIDATION_FAILED");
      try {
        return sendCreate(
          request,
          reply,
          await adapters.owner.create({
            request: request.body,
            identity,
            context: ctx,
          }),
        );
      } catch (error) {
        return sendProblem(request, reply, errorCode(error));
      }
    },
  });
  app.post(VERIFY, {
    config: { runtimeDeadlineProfile: "defaultMs" },
    bodyLimit: MAX_BODY_BYTES,
    errorHandler: (_error, request, reply) =>
      sendProblem(request, reply, "VALIDATION_FAILED", true),
    schema: {
      response: pricingResponseSchema(
        pricingContractSchemas.verifyResponse,
        200,
        [400, 401, 403, 404, 409, 500, 503],
      ),
    },
    handler: async (request, reply) => {
      const ctx = context(request, 1_000);
      if (!adapters.verifyTransport(request, "api-internal"))
        return sendProblem(
          request,
          reply,
          "SERVICE_AUTHENTICATION_REQUIRED",
          true,
        );
      if (
        spoofed(request, "x-service-delegation") ||
        present(request, "idempotency-key")
      )
        return sendProblem(request, reply, "SERVICE_DELEGATION_INVALID", true);
      const token = one(request, "x-service-delegation");
      if (!token)
        return sendProblem(
          request,
          reply,
          present(request, "x-service-delegation")
            ? "SERVICE_DELEGATION_INVALID"
            : "SERVICE_AUTHENTICATION_REQUIRED",
          true,
        );
      let claims: InternalClaims;
      try {
        claims = await adapters.verifyInternalDelegation(
          token,
          "verifyPricingQuote",
          ctx.signal,
        );
      } catch {
        return sendProblem(request, reply, "SERVICE_DELEGATION_INVALID", true);
      }
      if (
        !claims ||
        claims.iss !== "api-internal" ||
        claims.aud !== "pricing-service" ||
        claims.originalCaller !== "orders-service" ||
        claims.operationId !== "verifyPricingQuote" ||
        claims.correlationId !== ctx.correlationId ||
        (ctx.traceparent !== undefined &&
          claims.traceparent !== ctx.traceparent)
      )
        return sendProblem(request, reply, "SERVICE_DELEGATION_INVALID", true);
      if (!validBodySize(request) || !isPricingQuoteVerifyRequest(request.body))
        return sendProblem(request, reply, "VALIDATION_FAILED", true);
      try {
        const result = await adapters.owner.verify(request.body, ctx);
        if (!isPricingQuoteVerificationResponse(result))
          return sendProblem(request, reply, "INTERNAL_ERROR", true);
        return reply.header("cache-control", "no-store").code(200).send(result);
      } catch (error) {
        return sendProblem(request, reply, errorCode(error, true), true);
      }
    },
  });
}
export function createPricingAdapters(
  database: Database,
  security: PricingSecurity,
  catalogClient: CatalogPricingClient,
  telemetry = new PricingTelemetry(),
): PricingHttpAdapters {
  const store = new PricingStore(database, telemetry);
  const catalog: CatalogPricingClient = {
    async getPricingInput(request) {
      try {
        const result = await telemetry.observe(
          "pricing.catalog.pricing_input",
          () => catalogClient.getPricingInput(request),
        );
        telemetry.catalogReadOutcome("success");
        return result;
      } catch (error) {
        telemetry.catalogReadOutcome("error");
        throw error;
      }
    },
  };
  return {
    ...security,
    owner: {
      create: async ({ request, identity, context }) => {
        const start = performance.now();
        try {
          const result = await telemetry.observe("pricing.quote.create", () =>
            createPricingQuote(store, catalog, {
              request,
              identity,
              correlationId: context.correlationId,
              ...(context.traceparent === undefined
                ? {}
                : { traceparent: context.traceparent }),
              signal: context.signal,
              signDelegation: () => security.signCatalogDelegation(context),
              onCatalogRetry: (outcome) =>
                telemetry.catalogRetryOutcome(outcome),
            }),
          );
          telemetry.createOutcome(result.replayed ? "replayed" : "created");
          telemetry.databaseOutcome(result.replayed ? "replayed" : "committed");
          if (!result.replayed)
            telemetry.quoteLineCount(result.body.lines.length);
          return result;
        } catch (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
          telemetry.createOutcome(
            code === "IDEMPOTENCY_CONFLICT"
              ? "conflict"
              : code === "IDEMPOTENCY_REQUEST_IN_PROGRESS"
                ? "in_progress"
                : "error",
          );
          if (code === "TRANSACTION_OUTCOME_UNKNOWN")
            telemetry.databaseOutcome("unknown");
          else if (typeof code === "string" && code.startsWith("DB_"))
            telemetry.databaseOutcome("error");
          throw error;
        } finally {
          telemetry.observeDuration(performance.now() - start);
        }
      },
      replay: async (identity, signal) => {
        const start = performance.now();
        try {
          const result = await store.precheck(identity, undefined, signal);
          if (result.kind === "completed") {
            telemetry.createOutcome("replayed");
            telemetry.databaseOutcome("replayed");
          } else if (result.kind === "in_progress")
            telemetry.createOutcome("in_progress");
          else if (result.kind === "conflict")
            telemetry.createOutcome("conflict");
          return result;
        } catch (error) {
          telemetry.createOutcome("error");
          throw error;
        } finally {
          telemetry.observeDuration(performance.now() - start);
        }
      },
      verify: async (request, context) => {
        const start = performance.now();
        try {
          const result = await telemetry.observe("pricing.quote.verify", () =>
            store.verify({
              request,
              actorRef: "orders-service",
              correlationId: context.correlationId,
              signal: context.signal,
            }),
          );
          telemetry.verifyOutcome("valid");
          return result;
        } catch (error) {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
          telemetry.verifyOutcome(
            code === "PRICING_QUOTE_NOT_FOUND"
              ? "not_found"
              : code === "PRICING_QUOTE_HASH_MISMATCH"
                ? "hash_mismatch"
                : code === "PRICING_QUOTE_EXPIRED"
                  ? "expired"
                  : code === "PRICING_QUOTE_SCOPE_MISMATCH"
                    ? "scope_mismatch"
                    : "error",
          );
          throw error;
        } finally {
          telemetry.observeDuration(performance.now() - start);
        }
      },
    },
  };
}
