import {
  catalogContractSchemas,
  catalogResponseSchema,
  isCatalogOperationProblem,
  isCatalogPricingInput,
  isCatalogProductRef,
  isCatalogSearchResponse,
  isCatalogVariantRef,
  decodeCatalogSearchQuery,
  catalogSearchQueryError,
} from "@coffee-platform/contracts-catalog-v1";
import type {
  RuntimeComposition,
  RuntimeRequestContext,
} from "@coffee-platform/runtime";
import type { Database } from "@coffee-platform/database";
import {
  searchCatalog,
  validatedGrindOptions,
  CatalogOwnerError,
  type CatalogAvailability,
  type CatalogCursorSigner,
} from "../application/search-catalog.js";
import {
  CatalogStore,
  type CatalogOwnerStore,
} from "../infrastructure/postgres/catalog-store.js";

type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type HeaderValue = string | string[] | undefined;
type Request = Readonly<{
  headers: Readonly<Record<string, HeaderValue>>;
  id: string;
  runtimeContext: RuntimeRequestContext | null;
  routeOptions: Readonly<{ url: string | undefined }>;
  url: string;
  query: unknown;
  params: unknown;
  log?: Readonly<{
    warn: (fields: Readonly<Record<string, unknown>>, message: string) => void;
  }>;
}>;
type Reply = {
  header: (name: string, value: string) => Reply;
  code: (status: number) => Reply;
  type: (value: string) => Reply;
  send: (body?: unknown) => Reply;
};
type Context = Readonly<{
  signal: AbortSignal;
  correlationId: string;
  traceparent?: string;
}>;
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
type OwnerResult = Readonly<{ status: number; body: unknown }>;
type PublicClaims = Readonly<{
  iss: string;
  aud: string;
  originalIssuer: string;
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent: string;
}>;
type InternalClaims = Readonly<{
  iss: string;
  aud: string;
  originalCaller: string;
  operationId: string;
  correlationId: string;
  traceparent: string;
}>;

export type CatalogOwner = Readonly<{
  search: (
    input: Readonly<{
      query: string;
      availability?: CatalogAvailability;
      limit: number;
      cursor?: string;
      context: Context;
    }>,
  ) => Promise<OwnerResult>;
  pricingInput: (
    input: Readonly<{
      productRef: string;
      variantRef: string;
      context: Context;
      maxSnapshotAgeMs?: number;
    }>,
  ) => Promise<OwnerResult>;
}>;
export type CatalogHttpAdapters = Readonly<{
  owner: CatalogOwner;
  snapshotProofMaxAgeMs?: number;
  verifyTransport: (
    request: Request,
    expectedCaller: "api-public" | "api-internal",
  ) => boolean;
  verifyPublicDelegation: (
    token: string,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<PublicClaims> | PublicClaims;
  verifyInternalDelegation: (
    token: string,
    operationId: string,
    signal: AbortSignal,
  ) => Promise<InternalClaims> | InternalClaims;
}>;
function header(request: Request, name: string): HeaderValue {
  return Object.entries(request.headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}
function single(value: HeaderValue): string | undefined {
  return Array.isArray(value)
    ? value.length === 1
      ? value[0]
      : undefined
    : value;
}
function requestContext(request: Request, timeoutMs?: number): Context {
  const runtime = request.runtimeContext;
  const signal =
    timeoutMs === undefined
      ? (runtime?.signal ?? new AbortController().signal)
      : AbortSignal.any([
          runtime?.signal ?? new AbortController().signal,
          AbortSignal.timeout(timeoutMs),
        ]);
  return {
    signal,
    correlationId: runtime?.correlationId ?? request.id,
    ...(runtime?.traceparent === undefined
      ? {}
      : { traceparent: runtime.traceparent }),
  };
}
function problem(
  request: Request,
  status: number,
  code: string,
  detail: string,
): Problem {
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
  return reply
    .header("cache-control", "no-store")
    .code(body.status)
    .type("application/problem+json")
    .send(body);
}
function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
function ownerFailure(request: Request, error: unknown): Problem {
  const code = errorCode(error);
  if (code === "VALIDATION_FAILED")
    return problem(request, 400, code, "catalog search query is invalid");
  if (code === "INVALID_CURSOR")
    return problem(
      request,
      400,
      code,
      "cursor is invalid for this query or active catalog revision",
    );
  if (code === "CATALOG_SNAPSHOT_INCOMPLETE")
    return problem(request, 503, code, "active catalog snapshot is incomplete");
  if (code === "CATALOG_PRODUCT_NOT_FOUND")
    return problem(
      request,
      404,
      code,
      "catalog product or variant was not found",
    );
  if (
    code?.startsWith("DB_") ||
    code === "TRANSACTION_OUTCOME_UNKNOWN" ||
    code === "CATALOG_UNAVAILABLE"
  )
    return problem(
      request,
      503,
      "CATALOG_UNAVAILABLE",
      "catalog is temporarily unavailable",
    );
  return problem(
    request,
    503,
    "CATALOG_UNAVAILABLE",
    "catalog is temporarily unavailable",
  );
}
function frameworkError(request: Request, reply: Reply, error: unknown): Reply {
  const code = errorCode(error);
  const validation =
    code === "FST_ERR_VALIDATION" ||
    code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
  return sendProblem(
    reply,
    problem(
      request,
      validation ? 400 : 503,
      validation ? "VALIDATION_FAILED" : "CATALOG_UNAVAILABLE",
      validation ? "request is invalid" : "catalog is temporarily unavailable",
    ),
  );
}
function spoofed(
  request: Request,
  allow: "x-actor-context" | "x-service-delegation",
): boolean {
  return Object.keys(request.headers).some((name) => {
    const lower = name.toLowerCase();
    return (
      (lower.startsWith("x-actor-") ||
        lower.startsWith("x-service-") ||
        lower === "x-original-caller" ||
        lower === "x-original-issuer") &&
      lower !== allow
    );
  });
}
function normalizedQueryForContract(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const query = value as Record<string, unknown>;
  return typeof query["limit"] === "number" &&
    Number.isSafeInteger(query["limit"])
    ? { ...query, limit: String(query["limit"]) }
    : value;
}
async function publicClaims(
  request: Request,
  adapters: CatalogHttpAdapters,
): Promise<PublicClaims> {
  if (spoofed(request, "x-actor-context"))
    throw new Error("ACTOR_CONTEXT_INVALID");
  const token = single(header(request, "x-actor-context"));
  if (token === undefined) throw new Error("AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyPublicDelegation(
    token,
    "searchCatalogProducts",
    requestContext(request).signal,
  );
  if (
    claims.iss !== "api-public" ||
    claims.aud !== "catalog-service" ||
    claims.originalIssuer !== "edge-gateway" ||
    claims.operationId !== "searchCatalogProducts" ||
    !claims.sub ||
    !claims.permissions.includes("catalog:read")
  )
    throw new Error("ACTOR_CONTEXT_INVALID");
  return claims;
}
async function internalClaims(
  request: Request,
  adapters: CatalogHttpAdapters,
): Promise<InternalClaims> {
  if (spoofed(request, "x-service-delegation"))
    throw new Error("SERVICE_DELEGATION_INVALID");
  const token = single(header(request, "x-service-delegation"));
  if (token === undefined) throw new Error("SERVICE_AUTHENTICATION_REQUIRED");
  const claims = await adapters.verifyInternalDelegation(
    token,
    "getCatalogPricingInput",
    requestContext(request, 1_500).signal,
  );
  if (
    claims.iss !== "api-internal" ||
    claims.aud !== "catalog-service" ||
    !["pricing-service", "aroma-convergence"].includes(claims.originalCaller) ||
    claims.operationId !== "getCatalogPricingInput"
  )
    throw new Error("SERVICE_DELEGATION_INVALID");
  return claims;
}
function authProblem(
  request: Request,
  error: unknown,
  kind: "public" | "internal",
): Problem {
  const message = error instanceof Error ? error.message : "";
  if (message === "AUTHENTICATION_REQUIRED")
    return problem(
      request,
      401,
      "AUTHENTICATION_REQUIRED",
      "signed actor context is required",
    );
  if (message === "SERVICE_AUTHENTICATION_REQUIRED")
    return problem(
      request,
      401,
      message,
      "signed service delegation is required",
    );
  return problem(
    request,
    403,
    kind === "public" ? "ACTOR_CONTEXT_INVALID" : "SERVICE_DELEGATION_INVALID",
    "signed delegation is invalid",
  );
}
function sendOwnerResult(
  request: Request,
  reply: Reply,
  result: OwnerResult,
  success: "search" | "pricing",
): Reply {
  reply.header("cache-control", "no-store");
  if (result.status >= 400) {
    if (isCatalogOperationProblem(result.body, success, result.status))
      return sendProblem(
        reply,
        problem(
          request,
          result.status,
          result.body.code,
          "catalog request failed",
        ),
      );
    return sendProblem(
      reply,
      problem(
        request,
        503,
        "CATALOG_UNAVAILABLE",
        "invalid catalog owner response",
      ),
    );
  }
  const valid =
    success === "search"
      ? isCatalogSearchResponse(result.body)
      : isCatalogPricingInput(result.body);
  return valid && result.status === 200
    ? reply.code(200).send(result.body)
    : sendProblem(
        reply,
        ownerFailure(request, new Error("invalid catalog response")),
      );
}
function ownerResult(
  request: Request,
  reply: Reply,
  work: () => Promise<OwnerResult>,
  kind: "search" | "pricing",
): Promise<Reply> {
  return work()
    .then((result) => sendOwnerResult(request, reply, result, kind))
    .catch((error: unknown) =>
      sendProblem(reply, ownerFailure(request, error)),
    );
}

export function createCatalogOwner(
  store: CatalogOwnerStore,
  cursorSigner?: CatalogCursorSigner,
): CatalogOwner {
  return {
    search: async (input) => {
      if (cursorSigner === undefined)
        throw new Error("CATALOG_CURSOR_SIGNER_NOT_CONFIGURED");
      return {
        status: 200,
        body: await searchCatalog(store, input, cursorSigner),
      };
    },
    pricingInput: async (input) => {
      const row = await store.pricingInput(
        input.productRef,
        input.variantRef,
        input.context.signal,
        input.context.correlationId,
        input.maxSnapshotAgeMs,
      );
      if (row === undefined || row.snapshotRevision === null)
        throw new CatalogOwnerError(
          input.maxSnapshotAgeMs === undefined
            ? "CATALOG_SNAPSHOT_INCOMPLETE"
            : "CATALOG_UNAVAILABLE",
        );
      if (input.maxSnapshotAgeMs !== undefined && row.snapshotFresh !== true)
        throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
      if (row.productRef === null || row.variantRef === null)
        throw new CatalogOwnerError("CATALOG_PRODUCT_NOT_FOUND");
      if (
        row.mappingAvailable !== true ||
        row.offerRef === null ||
        row.supplierUnitMinor === null ||
        row.currency !== "RUB" ||
        row.mappingRevision === null ||
        row.availability === null ||
        row.unit === null ||
        row.displayName === null
      )
        throw new CatalogOwnerError("CATALOG_PRODUCT_NOT_FOUND");
      const grindOptions = validatedGrindOptions(row.grindOptions);
      return {
        status: 200,
        body: {
          productRef: row.productRef,
          variantRef: row.variantRef,
          offerRef: row.offerRef,
          snapshotRevision: row.snapshotRevision,
          supplierUnitMinor: row.supplierUnitMinor,
          currency: row.currency,
          unit: row.unit,
          availability: row.availability,
          mappingRevision: row.mappingRevision,
          displayName: row.displayName,
          ...(grindOptions === undefined ? {} : { grindOptions }),
        },
      };
    },
  };
}
export function createCatalogAdapters(
  database: Database,
  security: Readonly<{
    verifyTransport: CatalogHttpAdapters["verifyTransport"];
    verifyPublicDelegation: CatalogHttpAdapters["verifyPublicDelegation"];
    verifyInternalDelegation: CatalogHttpAdapters["verifyInternalDelegation"];
  }>,
  signer: CatalogCursorSigner,
  snapshotProofMaxAgeMs?: number,
): CatalogHttpAdapters {
  return {
    owner: createCatalogOwner(new CatalogStore(database), signer),
    ...(snapshotProofMaxAgeMs === undefined ? {} : { snapshotProofMaxAgeMs }),
    ...security,
  };
}
export function registerCatalogRoutes(
  app: RuntimeApp,
  adapters: CatalogHttpAdapters,
): void {
  app.setErrorHandler((error, request, reply) =>
    frameworkError(request, reply, error),
  );
  app.get("/api/client-v1/catalog/products", {
    config: { runtimeDeadlineProfile: "defaultMs" },
    schema: {
      querystring: catalogContractSchemas.query,
      response: catalogResponseSchema(
        catalogContractSchemas.searchResponse,
        200,
        [400, 401, 403, 503],
      ),
    },
    handler: async (request, reply) => {
      if (!adapters.verifyTransport(request, "api-public"))
        return sendProblem(
          reply,
          problem(
            request,
            401,
            "AUTHENTICATION_REQUIRED",
            "api-public transport identity is required",
          ),
        );
      try {
        await publicClaims(request, adapters);
      } catch (error) {
        return sendProblem(reply, authProblem(request, error, "public"));
      }
      const query = normalizedQueryForContract(request.query);
      const decoded = decodeCatalogSearchQuery(query);
      if (decoded === undefined)
        return sendProblem(
          reply,
          problem(
            request,
            400,
            "VALIDATION_FAILED",
            catalogSearchQueryError(query),
          ),
        );
      return ownerResult(
        request,
        reply,
        () =>
          adapters.owner.search({
            ...decoded,
            limit: decoded.limit ?? 20,
            context: requestContext(request),
          }),
        "search",
      );
    },
  });
  app.get(
    "/api/internal-v1/catalog/products/:productRef/variants/:variantRef/pricing-input",
    {
      config: { runtimeDeadlineProfile: "defaultMs" },
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["productRef", "variantRef"],
          properties: {
            productRef: catalogContractSchemas.productRef,
            variantRef: catalogContractSchemas.variantRef,
          },
        },
        response: catalogResponseSchema(
          catalogContractSchemas.pricingInput,
          200,
          [400, 401, 403, 404, 503],
        ),
      },
      handler: async (request, reply) => {
        if (!adapters.verifyTransport(request, "api-internal"))
          return sendProblem(
            reply,
            problem(
              request,
              401,
              "SERVICE_AUTHENTICATION_REQUIRED",
              "api-internal transport identity is required",
            ),
          );
        let claims: InternalClaims;
        try {
          claims = await internalClaims(request, adapters);
        } catch (error) {
          return sendProblem(reply, authProblem(request, error, "internal"));
        }
        const params = request.params as Record<string, unknown>;
        if (
          !isCatalogProductRef(params["productRef"]) ||
          !isCatalogVariantRef(params["variantRef"])
        )
          return sendProblem(
            reply,
            problem(
              request,
              400,
              "VALIDATION_FAILED",
              "product or variant reference is invalid",
            ),
          );
        if (
          claims.originalCaller === "aroma-convergence" &&
          adapters.snapshotProofMaxAgeMs === undefined
        )
          return sendProblem(
            reply,
            problem(
              request,
              503,
              "CATALOG_UNAVAILABLE",
              "catalog is temporarily unavailable",
            ),
          );
        return ownerResult(
          request,
          reply,
          () =>
            adapters.owner.pricingInput({
              productRef: params["productRef"] as string,
              variantRef: params["variantRef"] as string,
              context: requestContext(request, 1_500),
              ...(claims.originalCaller === "aroma-convergence"
                ? { maxSnapshotAgeMs: adapters.snapshotProofMaxAgeMs }
                : {}),
            }),
          "pricing",
        );
      },
    },
  );
}
