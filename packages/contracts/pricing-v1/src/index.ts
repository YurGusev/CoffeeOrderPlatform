import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema, ValidateFunction } from "ajv";
import type {
  PricingQuoteCreateRequest,
  PricingQuoteResponse,
  ProblemDetails,
} from "@coffee-platform/generated-client-v1";
import {
  clientV1ParameterSchemas,
  clientV1Schemas,
} from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import type {
  PricingQuoteVerifyRequest,
  PricingQuoteVerificationResponse,
} from "@coffee-platform/generated-internal-v1";
import { internalV1Schemas } from "@coffee-platform/generated-internal-v1/runtime-schemas.gen.js";

export type {
  PricingQuoteCreateRequest,
  PricingQuoteResponse,
} from "@coffee-platform/generated-client-v1";
export type {
  PricingQuoteVerifyRequest,
  PricingQuoteVerificationResponse,
} from "@coffee-platform/generated-internal-v1";

type PricingRuntimeSchemas = Readonly<{
  createRequest: AnySchema;
  response: AnySchema;
  verifyRequest: AnySchema;
  verifyResponse: AnySchema;
  problem: AnySchema;
  idempotencyKey: AnySchema;
  replayOnly: AnySchema;
  quoteRef: AnySchema;
}>;

const ajv: Ajv2020 = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const temporal = (
      globalThis as {
        Temporal?: { Instant?: { from: (input: string) => unknown } };
      }
    ).Temporal;
    if (temporal?.Instant?.from === undefined) return false;
    try {
      temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  },
});
ajv.addFormat("uri-reference", {
  type: "string",
  validate: (value: string) =>
    URL.canParse(value, "https://coffeeorderplatform.local"),
});

export const pricingContractSchemas: PricingRuntimeSchemas = Object.freeze({
  createRequest: clientV1Schemas.PricingQuoteCreateRequest,
  response: clientV1Schemas.PricingQuoteResponse,
  verifyRequest: internalV1Schemas.PricingQuoteVerifyRequest,
  verifyResponse: internalV1Schemas.PricingQuoteVerificationResponse,
  problem: clientV1Schemas.ProblemDetails,
  idempotencyKey: clientV1ParameterSchemas.IdempotencyKey,
  replayOnly: clientV1ParameterSchemas.ReplayOnly,
  quoteRef: clientV1Schemas.QuoteRef,
});

const validateCreateRequest: ValidateFunction = ajv.compile(
  pricingContractSchemas.createRequest,
);
const validateResponse: ValidateFunction = ajv.compile(
  pricingContractSchemas.response,
);
const validateVerifyRequest: ValidateFunction = ajv.compile(
  pricingContractSchemas.verifyRequest,
);
const validateVerifyResponse: ValidateFunction = ajv.compile(
  pricingContractSchemas.verifyResponse,
);
const validateProblem: ValidateFunction = ajv.compile(
  pricingContractSchemas.problem,
);

export function isPricingQuoteCreateRequest(
  value: unknown,
): value is PricingQuoteCreateRequest {
  if (!validateCreateRequest(value)) return false;
  const lines = (value as PricingQuoteCreateRequest).lines;
  return (
    new Set(
      lines.map(
        (line) =>
          `${line.productRef}:${line.variantRef}:${line.sourceGrindKeyHash ?? ""}`,
      ),
    ).size === lines.length
  );
}

export function isPricingQuoteResponse(
  value: unknown,
): value is PricingQuoteResponse {
  return validateResponse(value) as boolean;
}

export function isPricingQuoteVerifyRequest(
  value: unknown,
): value is PricingQuoteVerifyRequest {
  return validateVerifyRequest(value) as boolean;
}

export function isPricingQuoteVerificationResponse(
  value: unknown,
): value is PricingQuoteVerificationResponse {
  return validateVerifyResponse(value) as boolean;
}

export function isPricingProblem(value: unknown): value is ProblemDetails {
  return validateProblem(value) as boolean;
}

export function pricingResponseSchema(
  success: unknown,
  successStatus: 200 | 201,
  statuses: readonly number[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries([
    [successStatus, success],
    ...statuses.map((status) => [status, pricingContractSchemas.problem]),
  ]);
}

export const contractPackage = {
  id: "@coffee-platform/contracts-pricing-v1",
  source: {
    manifest: "contracts/manifest.yaml",
    openapi: [
      "contracts/openapi/client-v1.yaml",
      "contracts/openapi/internal-v1.yaml",
    ],
    schemas: "contracts/schemas",
  },
} as const;
