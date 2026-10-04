import {createHash, sign, verify, type KeyObject} from "node:crypto";

const MAX_CURSOR_LENGTH = 512;
const SIGNATURE_BYTES = 64;
const REFERENCE = /^prd_[0-9A-HJKMNP-TV-Z]{26}$/u;
const VARIANT = /^var_[0-9A-HJKMNP-TV-Z]{26}$/u;

export type CatalogAvailability = "Available" | "Unavailable" | "Stopped";
export type CatalogSearchRow = Readonly<{
  snapshotRevision: string | null;
  productRef: string | null;
  variantRef: string | null;
  displayName: string | null;
  displayNameSortKey: string | null;
  unit: "piece" | "gram" | "kilogram" | null;
  availability: CatalogAvailability | null;
  mappingAvailable: boolean | null;
  imageUrl: string | null;
  offerRef: string | null;
  supplierUnitMinor: string | null;
  currency: string | null;
  mappingRevision: string | null;
  grindOptions?: unknown;
}>;
export type CatalogPricingInputRow = CatalogSearchRow & Readonly<{snapshotFresh: boolean}>;
export type CatalogPageStore = Readonly<{
  search: (input: Readonly<{query: string; availability: CatalogAvailability | null; after: CatalogCursorPosition | null; limit: number; signal?: AbortSignal; correlationId?: string}>) => Promise<Readonly<{snapshotRevision: string | null; cursorValid: boolean; rows: readonly CatalogSearchRow[]}>>;
}>;
export type CatalogCursorPosition = Readonly<{sortKeyHash: string; productRef: string; variantRef: string}>;
export type CatalogCursorSigner = Readonly<{privateKey: KeyObject; publicKeys: readonly KeyObject[]; activeKid: string; maxAgeSeconds: number; clockSkewSeconds: number; nowEpochSeconds: () => number}>;
type CatalogCursor = Readonly<{v: 1; kid: string; iat: number; exp: number; snapshotRevision: string; filterHash: string; sortKeyHash: string; productRef: string; variantRef: string}>;

export class CatalogOwnerError extends Error {
  public readonly code: "INVALID_CURSOR" | "VALIDATION_FAILED" | "CATALOG_SNAPSHOT_INCOMPLETE" | "CATALOG_REVISION_CHANGED" | "CATALOG_PRODUCT_NOT_FOUND" | "CATALOG_PRODUCT_UNAVAILABLE" | "CATALOG_UNAVAILABLE";
  public constructor(code: CatalogOwnerError["code"]) {super(code); this.name = "CatalogOwnerError"; this.code = code;}
}

function normalizeQuery(value: string): string {
  const query = value.trim().normalize("NFKC").toLowerCase();
  if (Array.from(query).length < 2 || Array.from(query).length > 200) throw new CatalogOwnerError("VALIDATION_FAILED");
  return query;
}

function filterHash(query: string, availability: CatalogAvailability | undefined): string {
  return createHash("sha256").update(JSON.stringify([query, availability ?? null]), "utf8").digest("base64url");
}

function cursorFailure(): never { throw new CatalogOwnerError("INVALID_CURSOR"); }
function decodeCursor(value: string, expectedFilterHash: string, signer: CatalogCursorSigner): CatalogCursor {
  if (value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) cursorFailure();
  const signatureLength = Math.ceil(SIGNATURE_BYTES * 4 / 3);
  if (value.length <= signatureLength) cursorFailure();
  const payloadPart = value.slice(0, -signatureLength);
  const signaturePart = value.slice(-signatureLength);
  const payloadBytes = Buffer.from(payloadPart, "base64url");
  const signature = Buffer.from(signaturePart, "base64url");
  if (payloadBytes.toString("base64url") !== payloadPart || signature.length !== SIGNATURE_BYTES || signature.toString("base64url") !== signaturePart) cursorFailure();
  if (!signer.publicKeys.some((key) => verify(null, payloadBytes, key, signature))) cursorFailure();
  let parsed: unknown;
  try {parsed = JSON.parse(payloadBytes.toString("utf8")) as unknown;} catch {cursorFailure();}
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) cursorFailure();
  const cursor = parsed as Record<string, unknown>;
  if (Object.keys(cursor).sort().join(",") !== "exp,filterHash,iat,kid,productRef,snapshotRevision,sortKeyHash,v,variantRef" ||
      cursor["v"] !== 1 || cursor["kid"] !== signer.activeKid ||
      typeof cursor["iat"] !== "number" || !Number.isSafeInteger(cursor["iat"]) || typeof cursor["exp"] !== "number" || !Number.isSafeInteger(cursor["exp"]) ||
      cursor["exp"] <= signer.nowEpochSeconds() - signer.clockSkewSeconds || cursor["iat"] > signer.nowEpochSeconds() + signer.clockSkewSeconds ||
      cursor["exp"] <= cursor["iat"] || cursor["exp"] > cursor["iat"] + signer.maxAgeSeconds + signer.clockSkewSeconds ||
      typeof cursor["snapshotRevision"] !== "string" || !/^[1-9][0-9]*$/u.test(cursor["snapshotRevision"]) ||
      cursor["filterHash"] !== expectedFilterHash || typeof cursor["sortKeyHash"] !== "string" || !/^[a-f0-9]{64}$/u.test(cursor["sortKeyHash"]) ||
      typeof cursor["productRef"] !== "string" || !REFERENCE.test(cursor["productRef"]) || typeof cursor["variantRef"] !== "string" || !VARIANT.test(cursor["variantRef"])) cursorFailure();
  return cursor as unknown as CatalogCursor;
}

function encodeCursor(cursor: CatalogCursor, signer: CatalogCursorSigner): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8");
  const signature = sign(null, payload, signer.privateKey);
  const encoded = `${payload.toString("base64url")}${signature.toString("base64url")}`;
  if (encoded.length > MAX_CURSOR_LENGTH) cursorFailure();
  return encoded;
}

function validRow(row: CatalogSearchRow): row is CatalogSearchRow & Readonly<{productRef: string; variantRef: string; displayName: string; displayNameSortKey: string; unit: "piece" | "gram" | "kilogram"; availability: CatalogAvailability; mappingAvailable: boolean}> {
  return typeof row.productRef === "string" && REFERENCE.test(row.productRef) && typeof row.variantRef === "string" && VARIANT.test(row.variantRef) &&
    typeof row.displayName === "string" && typeof row.displayNameSortKey === "string" &&
    ["piece", "gram", "kilogram"].includes(row.unit ?? "") && ["Available", "Unavailable", "Stopped"].includes(row.availability ?? "") && typeof row.mappingAvailable === "boolean";
}

export function validatedGrindOptions(value: unknown): readonly Readonly<{sourceGrindKeyHash: string; displayName: string}>[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
    const option = entry as Record<string, unknown>;
    if (Object.keys(option).sort().join(",") !== "displayName,sourceGrindKeyHash" ||
      typeof option["sourceGrindKeyHash"] !== "string" || !/^[0-9a-f]{64}$/u.test(option["sourceGrindKeyHash"]) ||
      typeof option["displayName"] !== "string" || option["displayName"].length === 0 ||
      Array.from(option["displayName"]).length > 200 || seen.has(option["sourceGrindKeyHash"])) throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
    seen.add(option["sourceGrindKeyHash"]);
    return {sourceGrindKeyHash: option["sourceGrindKeyHash"], displayName: option["displayName"]};
  });
}

export async function searchCatalog(store: CatalogPageStore, input: Readonly<{query: string; availability?: CatalogAvailability; limit?: number; cursor?: string; signal?: AbortSignal; correlationId?: string}>, signer: CatalogCursorSigner): Promise<Readonly<{snapshotRevision: string; items: readonly Readonly<{productRef: string; variantRef: string; displayName: string; unit: "piece" | "gram" | "kilogram"; availability: CatalogAvailability; mappingAvailable: boolean; imageUrl?: string | null; grindOptions?: readonly Readonly<{sourceGrindKeyHash: string; displayName: string}>[]}>[]; nextCursor: string | null}>> {
  const query = normalizeQuery(input.query);
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new CatalogOwnerError("VALIDATION_FAILED");
  const hash = filterHash(query, input.availability);
  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor, hash, signer);
  const page = await store.search({query, availability: input.availability ?? null, after: cursor ?? null, limit: limit + 1, ...(input.signal === undefined ? {} : {signal: input.signal}), ...(input.correlationId === undefined ? {} : {correlationId: input.correlationId})});
  if (page.snapshotRevision === null) throw new CatalogOwnerError("CATALOG_SNAPSHOT_INCOMPLETE");
  if (!/^[1-9][0-9]*$/u.test(page.snapshotRevision)) throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
  if (cursor !== undefined && cursor.snapshotRevision !== page.snapshotRevision) throw new CatalogOwnerError("INVALID_CURSOR");
  if (cursor !== undefined && !page.cursorValid) throw new CatalogOwnerError("INVALID_CURSOR");
  const hasNext = page.rows.length > limit;
  const rows = hasNext ? page.rows.slice(0, limit) : page.rows;
  const items = rows.map((row) => {
    if (!validRow(row)) throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
    const grindOptions = validatedGrindOptions(row.grindOptions);
    return {productRef: row.productRef, variantRef: row.variantRef, displayName: row.displayName, unit: row.unit, availability: row.availability, mappingAvailable: row.mappingAvailable, ...(row.imageUrl === null ? {} : {imageUrl: row.imageUrl}), ...(grindOptions === undefined ? {} : {grindOptions})};
  });
  const last = rows.at(-1);
  const issuedAt = signer.nowEpochSeconds();
  const nextCursor = hasNext && last !== undefined && validRow(last)
    ? encodeCursor({v: 1, kid: signer.activeKid, iat: issuedAt, exp: issuedAt + signer.maxAgeSeconds, snapshotRevision: page.snapshotRevision, filterHash: hash, sortKeyHash: createHash("sha256").update(last.displayNameSortKey, "utf8").digest("hex"), productRef: last.productRef, variantRef: last.variantRef}, signer)
    : null;
  return {snapshotRevision: page.snapshotRevision, items, nextCursor};
}

export function createCatalogCursorSigner(privateKey: KeyObject, publicKeys: KeyObject | readonly KeyObject[], policy: Readonly<{activeKid?: string; maxAgeSeconds?: number; clockSkewSeconds?: number; nowEpochSeconds?: () => number}> = {}): CatalogCursorSigner {
  const keys = Array.isArray(publicKeys) ? publicKeys : [publicKeys];
  const activeKid = policy.activeKid ?? "catalog-v1";
  const maxAgeSeconds = policy.maxAgeSeconds ?? 86_400;
  const clockSkewSeconds = policy.clockSkewSeconds ?? 5;
  if (privateKey.asymmetricKeyType !== "ed25519" || keys.length === 0 || keys.some((key) => key.asymmetricKeyType !== "ed25519") ||
      activeKid.length === 0 || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || !Number.isSafeInteger(clockSkewSeconds) || clockSkewSeconds < 0) {
    throw new CatalogOwnerError("CATALOG_UNAVAILABLE");
  }
  return {privateKey, publicKeys: keys, activeKid, maxAgeSeconds, clockSkewSeconds, nowEpochSeconds: policy.nowEpochSeconds ?? (() => Math.floor((performance.timeOrigin + performance.now()) / 1_000))};
}
