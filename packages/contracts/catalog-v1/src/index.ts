import {Ajv2020} from "ajv/dist/2020.js";
import type {AnySchema, ValidateFunction} from "ajv";
import type {CatalogSearchResponse} from "@coffee-platform/generated-client-v1";
import {clientV1Schemas} from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import type {CatalogPricingInput} from "@coffee-platform/generated-internal-v1";

export type {CatalogProductSummary, CatalogSearchResponse} from "@coffee-platform/generated-client-v1";
export type {CatalogPricingInput} from "@coffee-platform/generated-internal-v1";

type RuntimeSchema = AnySchema;
type CatalogRuntimeSchemas = Readonly<{
  searchResponse: RuntimeSchema;
  pricingInput: RuntimeSchema;
  problem: RuntimeSchema;
  query: RuntimeSchema;
  productRef: RuntimeSchema;
  variantRef: RuntimeSchema;
}>;

const ajv: Ajv2020 = new Ajv2020({allErrors: true, strict: true});
ajv.addFormat("uri-reference", {type: "string", validate: (value: string) => URL.canParse(value, "https://coffeeorderplatform.local")});
ajv.addFormat("uri", {type: "string", validate: (value: string) => URL.canParse(value)});

// These schemas mirror the Catalog components in the two OpenAPI source contracts.
// Catalog's runtime schema aliases are not yet emitted by the types-only generator.
const productRefSchema = {type: "string", pattern: "^prd_[0-9A-HJKMNP-TV-Z]{26}$"} as const;
const variantRefSchema = {type: "string", pattern: "^var_[0-9A-HJKMNP-TV-Z]{26}$"} as const;
const catalogProductSummarySchema = {
  type: "object", additionalProperties: false,
  required: ["productRef", "variantRef", "displayName", "unit", "availability", "mappingAvailable"],
  properties: {
    productRef: productRefSchema,
    variantRef: variantRefSchema,
    displayName: {type: "string", minLength: 1, maxLength: 200},
    unit: {type: "string", enum: ["piece", "gram", "kilogram"]},
    availability: {type: "string", enum: ["Available", "Unavailable", "Stopped"]},
    mappingAvailable: {type: "boolean"},
    imageUrl: {type: "string", format: "uri", maxLength: 2048},
  },
} as const;
const searchResponseSchema = {
  type: "object", additionalProperties: false,
  required: ["snapshotRevision", "items", "nextCursor"],
  properties: {
    snapshotRevision: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    items: {type: "array", maxItems: 50, items: catalogProductSummarySchema},
    nextCursor: {type: ["string", "null"], maxLength: 512},
  },
} as const;
const pricingInputSchema = {
  type: "object", additionalProperties: false,
  required: ["productRef", "variantRef", "offerRef", "snapshotRevision", "supplierUnitMinor", "currency", "unit", "availability", "mappingRevision", "displayName"],
  properties: {
    productRef: productRefSchema,
    variantRef: variantRefSchema,
    offerRef: {type: "string", pattern: "^off_[0-9A-HJKMNP-TV-Z]{26}$"},
    snapshotRevision: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    supplierUnitMinor: {type: "string", pattern: "^-?(0|[1-9][0-9]*)$"},
    currency: {type: "string", const: "RUB"},
    unit: {type: "string", enum: ["piece", "gram", "kilogram"]},
    availability: {type: "string", enum: ["Available", "Unavailable", "Stopped"]},
    mappingRevision: {type: "string", pattern: "^(0|[1-9][0-9]*)$"},
    displayName: {type: "string", minLength: 1, maxLength: 200},
  },
} as const;
const querySchema = {
  type: "object", additionalProperties: false, required: ["query"],
  properties: {
    query: {type: "string"},
    availability: {type: "string", enum: ["Available", "Unavailable", "Stopped"]},
    limit: {type: "integer", minimum: 1, maximum: 50, default: 20},
    cursor: {type: "string", maxLength: 512, pattern: "^[A-Za-z0-9_-]*$"},
  },
} as const;

export const catalogContractSchemas: CatalogRuntimeSchemas = Object.freeze({
  searchResponse: searchResponseSchema,
  pricingInput: pricingInputSchema,
  problem: clientV1Schemas.ProblemDetails,
  query: querySchema,
  productRef: productRefSchema,
  variantRef: variantRefSchema,
});

const validateSearchResponse: ValidateFunction = ajv.compile(catalogContractSchemas.searchResponse);
const validatePricingInput: ValidateFunction = ajv.compile(catalogContractSchemas.pricingInput);
const validateProblem: ValidateFunction = ajv.compile(catalogContractSchemas.problem);
const validateQuery: ValidateFunction = ajv.compile(catalogContractSchemas.query);
const validateProductRef: ValidateFunction = ajv.compile(catalogContractSchemas.productRef);
const validateVariantRef: ValidateFunction = ajv.compile(catalogContractSchemas.variantRef);

export function isCatalogSearchResponse(value: unknown): value is CatalogSearchResponse {
  return validateSearchResponse(value) as boolean;
}

export function isCatalogPricingInput(value: unknown): value is CatalogPricingInput {
  return validatePricingInput(value) as boolean;
}

export function isCatalogProblem(value: unknown): value is Readonly<{status: number; code: string; detail: string}> {
  return validateProblem(value) as boolean;
}

export function isCatalogProductRef(value: unknown): value is string {
  return validateProductRef(value) as boolean;
}

export function isCatalogVariantRef(value: unknown): value is string {
  return validateVariantRef(value) as boolean;
}

export type CatalogSearchQuery = Readonly<{query: string; availability?: "Available" | "Unavailable" | "Stopped"; limit?: number; cursor?: string}>;

function validNormalizedQuery(query: string): boolean {
  const length = Array.from(query.trim().normalize("NFKC").toLowerCase()).length;
  return length >= 2 && length <= 200;
}

export function decodeCatalogSearchQuery(value: unknown): CatalogSearchQuery | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["query", "availability", "limit", "cursor"].includes(key))) return undefined;
  if (typeof raw["query"] !== "string" || !validNormalizedQuery(raw["query"])) return undefined;
  const limitValue = raw["limit"];
  const limit = limitValue === undefined
    ? undefined
    : typeof limitValue === "string" && /^(?:[1-9]|[1-4][0-9]|50)$/u.test(limitValue)
      ? Number(limitValue)
      : undefined;
  if (limitValue !== undefined && limit === undefined) return undefined;
  if (raw["availability"] !== undefined && typeof raw["availability"] !== "string") return undefined;
  if (raw["cursor"] !== undefined && typeof raw["cursor"] !== "string") return undefined;
  const decoded = {
    query: raw["query"],
    ...(raw["availability"] === undefined ? {} : {availability: raw["availability"]}),
    ...(limit === undefined ? {} : {limit}),
    ...(raw["cursor"] === undefined ? {} : {cursor: raw["cursor"]}),
  };
  return validateQuery(decoded) ? decoded as CatalogSearchQuery : undefined;
}

export function catalogSearchQueryError(value: unknown): "INVALID_CURSOR" | "VALIDATION_FAILED" {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const {cursor, ...query} = value as Record<string, unknown>;
    if (typeof cursor === "string" && decodeCatalogSearchQuery(query) !== undefined) return "INVALID_CURSOR";
  }
  return "VALIDATION_FAILED";
}

const operationErrors = {
  search: {400: ["VALIDATION_FAILED", "INVALID_CURSOR"], 401: ["AUTHENTICATION_REQUIRED"], 403: ["ACTOR_CONTEXT_INVALID"], 503: ["CATALOG_SNAPSHOT_INCOMPLETE", "CATALOG_UNAVAILABLE"]},
  pricing: {400: ["VALIDATION_FAILED"], 401: ["SERVICE_AUTHENTICATION_REQUIRED"], 403: ["SERVICE_DELEGATION_INVALID"], 404: ["CATALOG_PRODUCT_NOT_FOUND"], 503: ["CATALOG_SNAPSHOT_INCOMPLETE", "CATALOG_UNAVAILABLE"]},
} as const;

export function isCatalogOperationProblem(value: unknown, operation: "search" | "pricing", status: number): value is Readonly<{status: number; code: string; detail: string}> {
  if (!isCatalogProblem(value) || value.status !== status) return false;
  const codes = operationErrors[operation][status as keyof typeof operationErrors[typeof operation]] as readonly string[] | undefined;
  return codes?.includes(value.code) ?? false;
}

export function catalogResponseSchema(successSchema: unknown, successStatus: 200, errorStatuses: readonly number[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries([[successStatus, successSchema], ...errorStatuses.map((status) => [status, catalogContractSchemas.problem])]);
}

export const contractPackage = {
  id: "@coffee-platform/contracts-catalog-v1",
  source: {
    manifest: "contracts/manifest.yaml",
    openapi: ["contracts/openapi/client-v1.yaml", "contracts/openapi/internal-v1.yaml"],
    schemas: "contracts/schemas",
  },
} as const;
