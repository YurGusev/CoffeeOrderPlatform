import {sign, verify, type KeyObject} from "node:crypto";
import {canonicalJson} from "@coffee-platform/idempotency";
import {
  CustomerDomainError,
  normalizeSearchQuery,
  toCustomerSummary,
  type CustomerSummary,
  type CustomerSearch,
} from "../domain/customer.js";
import type {CustomerStore} from "../infrastructure/postgres/customer-store.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_CURSOR_LENGTH = 2_048;
const ED25519_SIGNATURE_LENGTH = 86;

export type CustomerSearchResult = Readonly<{
  items: readonly CustomerSummary[];
  nextCursor: string | null;
}>;

export type CustomerCursor = Readonly<{
  v: 1;
  queryHash: string;
  name: string;
  customerRef: string;
}>;

export type CustomerCursorSigner = Readonly<{
  sign: (payload: string) => string;
  verify: (payload: string, signature: string) => boolean;
}>;

function invalidCursor(): never {
  throw new CustomerDomainError("INVALID_CURSOR", "cursor is invalid");
}

function cursorValue(value: unknown): CustomerCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "c,n,q,v") invalidCursor();
  if (object["v"] !== 1 || typeof object["q"] !== "string" || !/^[A-Za-z0-9_-]+$/u.test(object["q"])) invalidCursor();
  const queryHashBytes = Buffer.from(object["q"], "base64url");
  if (queryHashBytes.length !== 32 || queryHashBytes.toString("base64url") !== object["q"]) invalidCursor();
  if (typeof object["n"] !== "string" || object["n"].length === 0 || object["n"].length > 200 ||
    typeof object["c"] !== "string" || !/^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(object["c"])) invalidCursor();
  return {
    v: 1,
    queryHash: queryHashBytes.toString("hex"),
    name: object["n"],
    customerRef: object["c"],
  };
}

function cursorPayload(cursor: CustomerCursor): string {
  return canonicalJson({
    c: cursor.customerRef,
    n: cursor.name,
    q: Buffer.from(cursor.queryHash, "hex").toString("base64url"),
    v: cursor.v,
  });
}

function decodeBase64Url(value: string): Readonly<{payload: string; signature: string; decoded: string}> {
  if (value.length <= ED25519_SIGNATURE_LENGTH || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidCursor();
  const payload = value.slice(0, -ED25519_SIGNATURE_LENGTH);
  const signature = value.slice(-ED25519_SIGNATURE_LENGTH);
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== payload || Buffer.from(signature, "base64url").toString("base64url") !== signature) invalidCursor();
  return {payload, signature, decoded};
}

export function encodeCustomerCursor(cursor: CustomerCursor, signer: CustomerCursorSigner): string {
  const normalized = cursorValue({
    c: cursor.customerRef,
    n: cursor.name,
    q: Buffer.from(cursor.queryHash, "hex").toString("base64url"),
    v: cursor.v,
  });
  const payload = cursorPayload(normalized);
  const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
  const signature = signer.sign(encodedPayload);
  if (signature.length !== ED25519_SIGNATURE_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(signature) || Buffer.from(signature, "base64url").length !== 64) invalidCursor();
  const value = `${encodedPayload}${signature}`;
  if (value.length > MAX_CURSOR_LENGTH) invalidCursor();
  return value;
}

export function decodeCustomerCursor(value: string, search: CustomerSearch, signer: CustomerCursorSigner): CustomerCursor {
  const {payload, signature, decoded} = decodeBase64Url(value);
  try {
    if (!signer.verify(payload, signature)) invalidCursor();
  } catch {
    invalidCursor();
  }
  let envelope: unknown;
  try { envelope = JSON.parse(decoded); } catch { invalidCursor(); }
  const cursor = cursorValue(envelope);
  if (cursorPayload(cursor) !== decoded || cursor.queryHash !== search.queryHash) invalidCursor();
  return cursor;
}

export function createEd25519CustomerCursorSigner(privateKey: KeyObject, publicKey: KeyObject | readonly KeyObject[]): CustomerCursorSigner {
  const verificationKeys = Array.isArray(publicKey) ? publicKey : [publicKey];
  if (verificationKeys.length === 0) throw new CustomerDomainError("CUSTOMER_UNAVAILABLE", "customer cursor verification is unavailable");
  return {
    sign: (payload) => Buffer.from(sign(null, Buffer.from(payload, "utf8"), privateKey)).toString("base64url"),
    verify: (payload, signature) => verificationKeys.some((key) => verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64url"))),
  };
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CustomerDomainError("VALIDATION_FAILED", "limit must be between 1 and 50");
  }
  return limit;
}

export async function searchCustomers(
  store: CustomerStore,
  input: Readonly<{query: string; limit?: number; cursor?: string}>,
  signer: CustomerCursorSigner | undefined,
  signal?: AbortSignal,
): Promise<CustomerSearchResult> {
  if (signer === undefined) throw new CustomerDomainError("CUSTOMER_UNAVAILABLE", "customer search capability is unavailable");
  const search = normalizeSearchQuery(input.query);
  const limit = pageLimit(input.limit);
  const cursor = input.cursor === undefined ? null : decodeCustomerCursor(input.cursor, search, signer);
  const rows = await store.search(search, cursor, limit + 1, signal);
  const hasNext = rows.length > limit;
  const pageRows = hasNext ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toCustomerSummary),
    nextCursor: hasNext && last !== undefined
      ? encodeCustomerCursor({v: 1, queryHash: search.queryHash, name: last.name, customerRef: last.customerRef}, signer)
      : null,
  };
}
