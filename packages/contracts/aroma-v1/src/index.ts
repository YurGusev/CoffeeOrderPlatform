import {Ajv2020} from "ajv/dist/2020.js";
import type {AnySchema, ValidateFunction} from "ajv";
import type {AromaCartSnapshot, AromaCartSnapshotReadRequest, AromaMutationResponse, AromaOfferBindingRequest, AromaOfferBindingResponse, ProblemDetails} from "@coffee-platform/generated-internal-v1";
import {internalV1Schemas} from "@coffee-platform/generated-internal-v1/runtime-schemas.gen.js";

export type {AromaCartSnapshot, AromaCartSnapshotReadRequest, AromaCatalogExportRecord, AromaCatalogExportRequest, AromaMutationResponse, AromaOfferBindingRequest, AromaOfferBindingResponse, ProblemDetails} from '@coffee-platform/generated-internal-v1';

type RuntimeSchema = AnySchema;
type ProblemRuntimeSchema = RuntimeSchema & Readonly<{properties: Readonly<{instance: Readonly<{pattern: string}>}>}>;
const problemSchema = internalV1Schemas["ProblemDetails"] as ProblemRuntimeSchema;
const uriReferencePattern = new RegExp(problemSchema.properties.instance.pattern, "u");
const ajv: Ajv2020 = new Ajv2020({allErrors: true, strict: true});
ajv.addFormat("date-time", {type: "string", validate: (value: string) => {
  const temporal = (globalThis as {Temporal?: {Instant?: {from: (input: string) => unknown}}}).Temporal;
  if (temporal?.Instant?.from !== undefined) {
    try { temporal.Instant.from(value); return true; } catch { return false; }
  }
  return false;
}});
ajv.addFormat("uri-reference", {type: "string", validate: (value: string) => uriReferencePattern.test(value)});
const schemas: Readonly<Record<string, RuntimeSchema>> = Object.freeze({
  offerBindingRequest: internalV1Schemas["AromaOfferBindingRequest"],
  offerBindingResponse: internalV1Schemas["AromaOfferBindingResponse"],
  mutationResponse: internalV1Schemas["AromaMutationResponse"],
  cartSnapshotReadRequest: internalV1Schemas["AromaCartSnapshotReadRequest"],
  cartSnapshot: internalV1Schemas["AromaCartSnapshot"],
  problem: problemSchema,
});
const validateRequest: ValidateFunction = ajv.compile(schemas["offerBindingRequest"]!);
const validateResponse: ValidateFunction = ajv.compile(schemas["offerBindingResponse"]!);
const validateMutationResponse: ValidateFunction = ajv.compile(schemas["mutationResponse"]!);
const validateCartSnapshotReadRequest: ValidateFunction = ajv.compile(schemas["cartSnapshotReadRequest"]!);
const validateCartSnapshot: ValidateFunction = ajv.compile(schemas["cartSnapshot"]!);
const validateProblem: ValidateFunction = ajv.compile(schemas["problem"]!);

export const aromaContractSchemas: Readonly<Record<string, RuntimeSchema>> = schemas;
export function isAromaOfferBindingRequest(value: unknown): value is AromaOfferBindingRequest { return validateRequest(value) as boolean; }
export function isAromaOfferBindingResponse(value: unknown): value is AromaOfferBindingResponse { return validateResponse(value) as boolean; }
export function isAromaMutationResponse(value: unknown): value is AromaMutationResponse { return validateMutationResponse(value) as boolean; }
export function isAromaCartSnapshotReadRequest(value: unknown): value is AromaCartSnapshotReadRequest { return validateCartSnapshotReadRequest(value) as boolean; }
export function isAromaCartSnapshot(value: unknown): value is AromaCartSnapshot { return validateCartSnapshot(value) as boolean; }
export function isAromaProblem(value: unknown): value is ProblemDetails { return validateProblem(value) as boolean; }

export const contractPackage = {
  id: '@coffee-platform/contracts-aroma-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: 'contracts/openapi/internal-v1.yaml',
    schemas: 'contracts/schemas',
  },
} as const;
