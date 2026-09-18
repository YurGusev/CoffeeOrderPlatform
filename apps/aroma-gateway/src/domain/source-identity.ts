import {createHmac} from "node:crypto";
import type {KeyObject} from "node:crypto";

export const SOURCE_IDENTITY_SCHEME = "hmac-sha256-v1" as const;
export const SOURCE_ENTITY_TYPES = ["product", "variant", "offer"] as const;

export type SourceEntityType = (typeof SOURCE_ENTITY_TYPES)[number];
export type SourceIdentityKey = Uint8Array | KeyObject;

export type SourceIdentityInput = Readonly<{
  supplierRef: string;
  entityType: SourceEntityType;
  rawProviderIdentifier: string;
}>;

export type SourceIdentityRequest = SourceIdentityInput & Readonly<{
  sourceIdentityKey: SourceIdentityKey;
}>;

export type SourceIdentityHash = string & {
  readonly __sourceIdentityHash: unique symbol;
};

export type SourceIdentity = Readonly<{
  sourceIdentityScheme: typeof SOURCE_IDENTITY_SCHEME;
  sourceIdentityHash: SourceIdentityHash;
}>;

export type SourceIdentityValidationCode =
  | "INVALID_INPUT"
  | "INVALID_KEY"
  | "INVALID_SUPPLIER_REF"
  | "INVALID_ENTITY_TYPE"
  | "INVALID_RAW_PROVIDER_IDENTIFIER";

export class SourceIdentityValidationError extends Error {
  readonly code: SourceIdentityValidationCode;

  constructor(code: SourceIdentityValidationCode) {
    super(code);
    this.name = "SourceIdentityValidationError";
    this.code = code;
  }
}

const SUPPLIER_REF_PATTERN = /^sup_[0-9A-HJKMNP-TV-Z]{26}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const INPUT_KEYS = ["supplierRef", "entityType", "rawProviderIdentifier"] as const;
const REQUEST_KEYS = [...INPUT_KEYS, "sourceIdentityKey"] as const;

function invalid(code: SourceIdentityValidationCode): never {
  throw new SourceIdentityValidationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}


function isNulFreeNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && value.isWellFormed();
}

export function isSourceEntityType(value: unknown): value is SourceEntityType {
  return value === "product" || value === "variant" || value === "offer";
}

export function isSourceIdentityKey(value: unknown): value is SourceIdentityKey {
  if (value instanceof Uint8Array) return value.byteLength > 0;
  if (!isRecord(value)) return false;
  return value["type"] === "secret" && typeof value["export"] === "function" &&
    typeof value["symmetricKeySize"] === "number" && value["symmetricKeySize"] > 0;
}

export function assertSourceIdentityInput(value: unknown): asserts value is SourceIdentityInput {
  if (!isRecord(value) || !hasExactlyKeys(value, INPUT_KEYS)) invalid("INVALID_INPUT");
  if (typeof value["supplierRef"] !== "string" || !SUPPLIER_REF_PATTERN.test(value["supplierRef"]) || value["supplierRef"].includes("\u0000")) {
    invalid("INVALID_SUPPLIER_REF");
  }
  if (!isSourceEntityType(value["entityType"])) invalid("INVALID_ENTITY_TYPE");
  if (!isNulFreeNonEmptyString(value["rawProviderIdentifier"])) invalid("INVALID_RAW_PROVIDER_IDENTIFIER");
}

export function validateSourceIdentityInput(value: unknown): SourceIdentityInput {
  assertSourceIdentityInput(value);
  return value;
}

export function isSourceIdentityInput(value: unknown): value is SourceIdentityInput {
  try {
    assertSourceIdentityInput(value);
    return true;
  } catch {
    return false;
  }
}

export function assertSourceIdentityKey(value: unknown): asserts value is SourceIdentityKey {
  if (!isSourceIdentityKey(value)) invalid("INVALID_KEY");
}

export function frameSourceIdentityMessage(input: SourceIdentityInput): Uint8Array {
  assertSourceIdentityInput(input);
  const normalizedProviderIdentifier = input.rawProviderIdentifier.normalize("NFC");
  return Buffer.concat([
    Buffer.from(SOURCE_IDENTITY_SCHEME, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(input.supplierRef, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(input.entityType, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(normalizedProviderIdentifier, "utf8"),
  ]);
}

export function computeSourceIdentityHash(input: SourceIdentityInput, sourceIdentityKey: SourceIdentityKey): SourceIdentityHash {
  assertSourceIdentityInput(input);
  assertSourceIdentityKey(sourceIdentityKey);

  let digest: string;
  try {
    digest = createHmac("sha256", sourceIdentityKey).update(frameSourceIdentityMessage(input)).digest("hex");
  } catch {
    invalid("INVALID_KEY");
  }
  if (!HASH_PATTERN.test(digest)) invalid("INVALID_KEY");
  return digest as SourceIdentityHash;
}

export function createSourceIdentity(request: SourceIdentityRequest): SourceIdentity {
  if (!isRecord(request) || !hasExactlyKeys(request, REQUEST_KEYS)) invalid("INVALID_INPUT");
  assertSourceIdentityInput({
    supplierRef: request["supplierRef"],
    entityType: request["entityType"],
    rawProviderIdentifier: request["rawProviderIdentifier"],
  });
  assertSourceIdentityKey(request["sourceIdentityKey"]);
  return Object.freeze({
    sourceIdentityScheme: SOURCE_IDENTITY_SCHEME,
    sourceIdentityHash: computeSourceIdentityHash({
      supplierRef: request["supplierRef"],
      entityType: request["entityType"],
      rawProviderIdentifier: request["rawProviderIdentifier"],
    }, request["sourceIdentityKey"]),
  });
}
