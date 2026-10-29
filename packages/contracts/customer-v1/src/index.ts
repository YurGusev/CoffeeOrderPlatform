import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import type {
  CustomerCreateRequest,
  CustomerResponse,
  CustomerSearchResponse,
  ProblemDetails,
} from "@coffee-platform/generated-client-v1";
import {
  clientV1ParameterSchemas,
  clientV1Schemas,
} from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import type { CustomerOrderInput } from "@coffee-platform/generated-internal-v1";
import { internalV1Schemas } from "@coffee-platform/generated-internal-v1/runtime-schemas.gen.js";

export type {
  CustomerCreateRequest,
  CustomerResponse,
  CustomerSearchResponse,
  CustomerSummary,
} from "@coffee-platform/generated-client-v1";
export type { CustomerOrderInput } from "@coffee-platform/generated-internal-v1";

type RuntimeSchema = AnySchema;
type CustomerRuntimeSchemas = Readonly<{
  address: RuntimeSchema;
  createRequest: RuntimeSchema;
  response: RuntimeSchema;
  summary: RuntimeSchema;
  searchResponse: RuntimeSchema;
  customerRef: RuntimeSchema;
  orderInput: RuntimeSchema;
  problem: RuntimeSchema;
  searchQuery: RuntimeSchema;
  idempotencyKey: RuntimeSchema;
  replayOnly: RuntimeSchema;
}>;

const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("email", {
  type: "string",
  validate: (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value),
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const temporal = (
      globalThis as {
        Temporal?: { Instant?: { from: (input: string) => unknown } };
      }
    ).Temporal;
    if (temporal?.Instant?.from !== undefined) {
      try {
        temporal.Instant.from(value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  },
});
ajv.addFormat("uri-reference", {
  type: "string",
  validate: (value: string) =>
    URL.canParse(value, "https://coffeeorderplatform.local"),
});

export const customerContractSchemas: CustomerRuntimeSchemas = Object.freeze({
  address: clientV1Schemas.CustomerAddress,
  createRequest: clientV1Schemas.CustomerCreateRequest,
  response: clientV1Schemas.CustomerResponse,
  summary: clientV1Schemas.CustomerSummary,
  searchResponse: clientV1Schemas.CustomerSearchResponse,
  customerRef: clientV1Schemas.CustomerRef,
  orderInput: internalV1Schemas.CustomerOrderInput,
  problem: clientV1Schemas.ProblemDetails,
  searchQuery: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: clientV1ParameterSchemas.CustomerQuery,
      limit: clientV1ParameterSchemas.PageLimit,
      cursor: clientV1ParameterSchemas.CustomerCursor,
    },
  },
  idempotencyKey: clientV1ParameterSchemas.IdempotencyKey,
  replayOnly: clientV1ParameterSchemas.ReplayOnly,
} as const);

const validateCreateRequest: ValidateFunction = ajv.compile(
  customerContractSchemas.createRequest,
);
const validateResponse: ValidateFunction = ajv.compile(
  customerContractSchemas.response,
);
const validateSearchResponse: ValidateFunction = ajv.compile(
  customerContractSchemas.searchResponse,
);
const validateOrderInput: ValidateFunction = ajv.compile(
  customerContractSchemas.orderInput,
);
const validateProblem: ValidateFunction = ajv.compile(
  customerContractSchemas.problem,
);
const validateSearchQuery: ValidateFunction = ajv.compile(
  customerContractSchemas.searchQuery,
);
const validateCustomerRef: ValidateFunction = ajv.compile(
  customerContractSchemas.customerRef,
);
const validateIdempotencyKey: ValidateFunction = ajv.compile(
  customerContractSchemas.idempotencyKey,
);
const validateReplayOnly: ValidateFunction = ajv.compile(
  customerContractSchemas.replayOnly,
);

export function isCustomerCreateRequest(
  value: unknown,
): value is CustomerCreateRequest {
  return validateCreateRequest(value) as boolean;
}

export function isCustomerResponse(value: unknown): value is CustomerResponse {
  return validateResponse(value) as boolean;
}

export function isCustomerSearchResponse(
  value: unknown,
): value is CustomerSearchResponse {
  return validateSearchResponse(value) as boolean;
}

export function isCustomerSearchQuery(
  value: unknown,
): value is Readonly<{ query: string; limit?: number; cursor?: string }> {
  return validateSearchQuery(value) as boolean;
}

export function decodeCustomerSearchQuery(
  value: unknown,
): Readonly<{ query: string; limit?: number; cursor?: string }> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !["query", "limit", "cursor"].includes(key))
  )
    return undefined;
  if (typeof raw["query"] !== "string") return undefined;
  const limitValue = raw["limit"];
  const limit =
    limitValue === undefined
      ? undefined
      : typeof limitValue === "string" &&
          /^(?:[1-9]|[1-4][0-9]|50)$/u.test(limitValue)
        ? Number(limitValue)
        : undefined;
  if (limitValue !== undefined && limit === undefined) return undefined;
  if (raw["cursor"] !== undefined && typeof raw["cursor"] !== "string")
    return undefined;
  const decoded = {
    query: raw["query"],
    ...(limit === undefined ? {} : { limit }),
    ...(raw["cursor"] === undefined ? {} : { cursor: raw["cursor"] }),
  };
  return isCustomerSearchQuery(decoded) ? decoded : undefined;
}

export function customerSearchQueryError(
  value: unknown,
): "INVALID_CURSOR" | "VALIDATION_FAILED" {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const { cursor, ...query } = value as Record<string, unknown>;
    if (
      typeof cursor === "string" &&
      decodeCustomerSearchQuery(query) !== undefined
    )
      return "INVALID_CURSOR";
  }
  return "VALIDATION_FAILED";
}

export function isCustomerOrderInput(
  value: unknown,
): value is CustomerOrderInput {
  return validateOrderInput(value) as boolean;
}

export function isCustomerRef(value: unknown): value is string {
  return validateCustomerRef(value) as boolean;
}

export function isCustomerProblem(value: unknown): value is ProblemDetails {
  return validateProblem(value) as boolean;
}

export function isCustomerIdempotencyKey(value: unknown): value is string {
  return validateIdempotencyKey(value) as boolean;
}

export function isCustomerReplayOnly(value: unknown): value is true {
  return validateReplayOnly(value) as boolean;
}

export function customerResponseSchema(
  success: unknown,
  successStatus: 200 | 201,
  statuses: readonly number[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries([
    [successStatus, success],
    ...statuses.map((status) => [status, customerContractSchemas.problem]),
  ]);
}

export const customerPermission: Readonly<{
  createCustomer: "customer:create";
  searchCustomers: "customer:read";
}> = Object.freeze({
  createCustomer: "customer:create",
  searchCustomers: "customer:read",
});

export function hasCustomerPermission(
  permissions: readonly string[],
  operationId: keyof typeof customerPermission,
): boolean {
  return permissions.includes(customerPermission[operationId]);
}

type CustomerErrorPolicyEntry = Readonly<{ status: number; detail: string }>;
type CustomerErrorPolicy = Readonly<{
  VALIDATION_FAILED: CustomerErrorPolicyEntry;
  INVALID_CURSOR: CustomerErrorPolicyEntry;
  CUSTOMER_NOT_FOUND: CustomerErrorPolicyEntry;
  CUSTOMER_PHONE_CONFLICT: CustomerErrorPolicyEntry;
  CUSTOMER_EMAIL_CONFLICT: CustomerErrorPolicyEntry;
  IDEMPOTENCY_CONFLICT: CustomerErrorPolicyEntry;
  IDEMPOTENCY_REQUEST_IN_PROGRESS: CustomerErrorPolicyEntry;
  IDEMPOTENCY_RESULT_NOT_RETAINED: CustomerErrorPolicyEntry;
  IDEMPOTENCY_RESULT_INVALID: CustomerErrorPolicyEntry;
  IDEMPOTENCY_LOOKUP_UNAVAILABLE: CustomerErrorPolicyEntry;
  CUSTOMER_UNAVAILABLE: CustomerErrorPolicyEntry;
  INTERNAL_ERROR: CustomerErrorPolicyEntry;
}>;

export const customerErrorPolicy: CustomerErrorPolicy = Object.freeze({
  VALIDATION_FAILED: { status: 400, detail: "Request validation failed" },
  INVALID_CURSOR: { status: 400, detail: "Cursor is invalid" },
  CUSTOMER_NOT_FOUND: { status: 404, detail: "Customer does not exist" },
  CUSTOMER_PHONE_CONFLICT: {
    status: 409,
    detail: "The phone is already registered",
  },
  CUSTOMER_EMAIL_CONFLICT: {
    status: 409,
    detail: "The email is already registered",
  },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    detail: "Idempotency key conflicts with an existing request",
  },
  IDEMPOTENCY_REQUEST_IN_PROGRESS: {
    status: 409,
    detail: "The idempotent request is still in progress",
  },
  IDEMPOTENCY_RESULT_NOT_RETAINED: {
    status: 410,
    detail: "The completed result is no longer retained",
  },
  IDEMPOTENCY_RESULT_INVALID: {
    status: 500,
    detail: "Stored terminal response is invalid",
  },
  IDEMPOTENCY_LOOKUP_UNAVAILABLE: {
    status: 503,
    detail: "Idempotency lookup is unavailable",
  },
  CUSTOMER_UNAVAILABLE: {
    status: 503,
    detail: "Customer service is unavailable",
  },
  INTERNAL_ERROR: { status: 500, detail: "An unexpected error occurred" },
} as const);

export function customerErrorPolicyEntry(
  code: string,
): CustomerErrorPolicyEntry | undefined {
  return Object.hasOwn(customerErrorPolicy, code)
    ? customerErrorPolicy[code as keyof CustomerErrorPolicy]
    : undefined;
}

export const contractPackage = {
  id: "@coffee-platform/contracts-customer-v1",
  source: {
    manifest: "contracts/manifest.yaml",
    openapi: [
      "contracts/openapi/client-v1.yaml",
      "contracts/openapi/internal-v1.yaml",
    ],
    schemas: "contracts/schemas",
  },
} as const;
