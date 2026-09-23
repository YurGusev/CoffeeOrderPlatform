import {createHash} from "node:crypto";

export type CatalogJsonPrimitive = string | number | boolean | null;
export type CatalogJsonValue = CatalogJsonPrimitive | readonly CatalogJsonValue[] | Readonly<{[key: string]: CatalogJsonValue}>;
export type CatalogHash = string;

export const CATALOG_MAX_OFFERS_PER_BATCH = 500;
export const CATALOG_MAX_BATCH_BYTES = 2_097_152;
export const CATALOG_MAX_ITEM_BYTES = 262_144;
export const CATALOG_MAX_STREAM_LINE_BYTES = 2_359_296;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: CatalogJsonValue, stack: WeakSet<object>): CatalogJsonValue {
  if (Array.isArray(value)) {
    if (stack.has(value)) throw new TypeError("canonical JSON does not permit cycles");
    stack.add(value);
    const result: CatalogJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("canonical JSON does not permit sparse arrays");
      result.push(canonicalize(value[index]!, stack));
    }
    stack.delete(value);
    return result;
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) throw new TypeError("canonical JSON permits only plain objects");
    if (stack.has(value)) throw new TypeError("canonical JSON does not permit cycles");
    stack.add(value);
    const result: Record<string, CatalogJsonValue> = Object.create(null) as Record<string, CatalogJsonValue>;
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) throw new TypeError("canonical JSON does not permit undefined values");
      result[key] = canonicalize(child as CatalogJsonValue, stack);
    }
    stack.delete(value);
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError("canonical JSON does not permit this value");
  }
  return value;
}

export function canonicalCatalogJson(value: CatalogJsonValue): string {
  const encoded = JSON.stringify(canonicalize(value, new WeakSet<object>()));
  if (encoded === undefined) throw new TypeError("value cannot be represented as canonical JSON");
  return encoded;
}

export function catalogBatchCanonicalBytes(items: readonly unknown[]): Uint8Array {
  return Buffer.from(canonicalCatalogJson(items as CatalogJsonValue), "utf8");
}

export function catalogBatchBytes(items: readonly unknown[]): number {
  return catalogBatchCanonicalBytes(items).byteLength;
}

export function catalogSha256(bytes: Uint8Array): CatalogHash {
  return createHash("sha256").update(bytes).digest("hex");
}

export function catalogBatchHash(items: readonly unknown[]): CatalogHash {
  return catalogSha256(catalogBatchCanonicalBytes(items));
}

export type CatalogContentHashAccumulator = Readonly<{
  update(batchHash: CatalogHash): void;
  digest(): CatalogHash;
}>;

/** SHA-256 of ordered binary batch digests, retaining no batch-hash collection.
 * digest() finalizes the accumulator; subsequent updates/digests throw.
 */
export function createCatalogContentHash(): CatalogContentHashAccumulator {
  const hash = createHash("sha256");
  return Object.freeze({
    update(value: CatalogHash): void {
      if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("batch hash must be lowercase SHA-256 hex");
      hash.update(Buffer.from(value, "hex"));
    },
    digest(): CatalogHash { return hash.digest("hex"); },
  });
}

export function catalogContentHash(batchHashes: readonly string[]): CatalogHash {
  const hash = createCatalogContentHash();
  for (const value of batchHashes) hash.update(value);
  return hash.digest();
}
