import {Ajv2020} from "ajv/dist/2020.js";
import type {AnySchema, ValidateFunction} from "ajv";
import type {AromaCartSnapshot, AromaCartSnapshotReadRequest, AromaCatalogExportRecord, AromaCatalogExportRequest, AromaMutationResponse, AromaOfferBindingRequest, AromaOfferBindingResponse, AromaRemoveLineRequest, AromaSetQuantityRequest, ProblemDetails} from "@coffee-platform/generated-internal-v1";
import {internalV1Schemas} from "@coffee-platform/generated-internal-v1/runtime-schemas.gen.js";

export type {AromaCartSnapshot, AromaCartSnapshotReadRequest, AromaCatalogExportRecord, AromaCatalogExportRequest, AromaMutationResponse, AromaOfferBindingRequest, AromaOfferBindingResponse, AromaRemoveLineRequest, AromaSetQuantityRequest, ProblemDetails} from '@coffee-platform/generated-internal-v1';

type RuntimeSchema = AnySchema;
type ProblemRuntimeSchema = RuntimeSchema & Readonly<{properties: Readonly<{instance: Readonly<{pattern: string}>}>}>;
const problemSchema = internalV1Schemas["ProblemDetails"] as ProblemRuntimeSchema;
const uriReferencePattern = new RegExp(problemSchema.properties.instance.pattern, "u");
const ajv: Ajv2020 = new Ajv2020({allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false});
ajv.addFormat("date-time", {type: "string", validate: (value: string) => {
  const temporal = (globalThis as {Temporal?: {Instant?: {from: (input: string) => unknown}}}).Temporal;
  if (temporal?.Instant?.from !== undefined) {
    try { temporal.Instant.from(value); return true; } catch { return false; }
  }
  return false;
}});
ajv.addFormat("uri-reference", {type: "string", validate: (value: string) => uriReferencePattern.test(value)});
ajv.addFormat("uri", {type: "string", validate: (value: string) => { try { const url = new URL(value); return url.protocol !== ""; } catch { return false; } }});
const schemas: Readonly<Record<string, RuntimeSchema>> = Object.freeze({
  catalogExportRequest: internalV1Schemas["AromaCatalogExportRequest"],
  catalogExportRecord: internalV1Schemas["AromaCatalogExportRecord"],
  offerBindingRequest: internalV1Schemas["AromaOfferBindingRequest"],
  offerBindingResponse: internalV1Schemas["AromaOfferBindingResponse"],
  mutationResponse: internalV1Schemas["AromaMutationResponse"],
  cartSnapshotReadRequest: internalV1Schemas["AromaCartSnapshotReadRequest"],
  cartSnapshot: internalV1Schemas["AromaCartSnapshot"],
  setQuantityRequest: internalV1Schemas["AromaSetQuantityRequest"],
  removeLineRequest: internalV1Schemas["AromaRemoveLineRequest"],
  problem: problemSchema,
});
const validateCatalogExportRequest: ValidateFunction = ajv.compile(schemas["catalogExportRequest"]!);
const validateCatalogExportRecord: ValidateFunction = ajv.compile(schemas["catalogExportRecord"]!);
const validateRequest: ValidateFunction = ajv.compile(schemas["offerBindingRequest"]!);
const validateResponse: ValidateFunction = ajv.compile(schemas["offerBindingResponse"]!);
const validateMutationResponse: ValidateFunction = ajv.compile(schemas["mutationResponse"]!);
const validateCartSnapshotReadRequest: ValidateFunction = ajv.compile(schemas["cartSnapshotReadRequest"]!);
const validateCartSnapshot: ValidateFunction = ajv.compile(schemas["cartSnapshot"]!);
const validateSetQuantityRequest: ValidateFunction = ajv.compile(schemas["setQuantityRequest"]!);
const validateRemoveLineRequest: ValidateFunction = ajv.compile(schemas["removeLineRequest"]!);
const validateProblem: ValidateFunction = ajv.compile(schemas["problem"]!);

export const aromaContractSchemas: Readonly<Record<string, RuntimeSchema>> = schemas;
export function isAromaCatalogExportRequest(value: unknown): value is AromaCatalogExportRequest { return validateCatalogExportRequest(value) as boolean; }
export function isAromaCatalogExportRecord(value: unknown): value is AromaCatalogExportRecord { return validateCatalogExportRecord(value) as boolean; }
export function isAromaOfferBindingRequest(value: unknown): value is AromaOfferBindingRequest { return validateRequest(value) as boolean; }
export function isAromaOfferBindingResponse(value: unknown): value is AromaOfferBindingResponse { return validateResponse(value) as boolean; }
export function isAromaMutationResponse(value: unknown): value is AromaMutationResponse { return validateMutationResponse(value) as boolean; }
export function isAromaCartSnapshotReadRequest(value: unknown): value is AromaCartSnapshotReadRequest { return validateCartSnapshotReadRequest(value) as boolean; }
export function isAromaCartSnapshot(value: unknown): value is AromaCartSnapshot { return validateCartSnapshot(value) as boolean; }
export function isAromaSetQuantityRequest(value: unknown): value is AromaSetQuantityRequest { return validateSetQuantityRequest(value) as boolean; }
export function isAromaRemoveLineRequest(value: unknown): value is AromaRemoveLineRequest { return validateRemoveLineRequest(value) as boolean; }
export function isAromaProblem(value: unknown): value is ProblemDetails { return validateProblem(value) as boolean; }

export const contractPackage = {
  id: '@coffee-platform/contracts-aroma-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: 'contracts/openapi/internal-v1.yaml',
    schemas: 'contracts/schemas',
  },
} as const;

export {CATALOG_MAX_BATCH_BYTES, CATALOG_MAX_ITEM_BYTES, CATALOG_MAX_OFFERS_PER_BATCH, CATALOG_MAX_STREAM_LINE_BYTES, canonicalCatalogJson, catalogBatchCanonicalBytes, catalogBatchBytes, catalogBatchHash, catalogContentHash, createCatalogContentHash, catalogSha256} from "./catalog-hash.js";
export type {CatalogContentHashAccumulator, CatalogHash, CatalogJsonPrimitive, CatalogJsonValue} from "./catalog-hash.js";
