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
const DEFAULT_CURSOR_POLICY = Object.freeze({
  activeKid: "customer-cursor-v1",
  previousKid: "customer-cursor-v0",
  maxAgeSeconds: 86_400,
  clockSkewSeconds: 5,
  overlapSeconds: 172_800,
});

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

export type CustomerCursorPolicy = Readonly<{
  activeKid: string;
  previousKid: string;
  maxAgeSeconds: number;
  clockSkewSeconds: number;
  overlapSeconds: number;
  nowEpochSeconds?: () => number;
}>;

export type CustomerCursorSigner = Readonly<{
  policy: CustomerCursorPolicy;
  sign: (payload: string) => string;
  verify: (payload: string, signature: string, kid: string) => boolean;
}>;

type CursorEnvelope = CustomerCursor & Readonly<{
  kid: string;
  issuedAt: number;
  expiresAt: number;
}>;

function invalidCursor(): never {
  throw new CustomerDomainError("INVALID_CURSOR", "cursor is invalid");
}

function cursorEnvelope(value: unknown): CursorEnvelope {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "c,e,i,k,n,q,v") invalidCursor();
  if (object["v"] !== 1 || typeof object["q"] !== "string" || !/^[A-Za-z0-9_-]+$/u.test(object["q"])) invalidCursor();
  const queryHashBytes = Buffer.from(object["q"], "base64url");
  if (queryHashBytes.length !== 32 || queryHashBytes.toString("base64url") !== object["q"]) invalidCursor();
  if (typeof object["n"] !== "string" || object["n"].length === 0 || object["n"].length > 200 ||
    typeof object["c"] !== "string" || !/^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(object["c"]) ||
    typeof object["k"] !== "string" || object["k"].length === 0 || !/^[A-Za-z0-9-]+$/u.test(object["k"]) ||
    typeof object["i"] !== "number" || !Number.isSafeInteger(object["i"]) || object["i"] < 0 ||
    typeof object["e"] !== "number" || !Number.isSafeInteger(object["e"]) || object["e"] < 0) invalidCursor();
  return {
    v: 1,
    queryHash: queryHashBytes.toString("hex"),
    name: object["n"],
    customerRef: object["c"],
    kid: object["k"],
    issuedAt: object["i"],
    expiresAt: object["e"],
  };
}

function cursorPayload(cursor: CursorEnvelope): string {
  return canonicalJson({
    c: cursor.customerRef,
    e: cursor.expiresAt,
    i: cursor.issuedAt,
    k: cursor.kid,
    n: cursor.name,
    q: Buffer.from(cursor.queryHash, "hex").toString("base64url"),
    v: cursor.v,
  });
}

function nowEpochSeconds(policy: CustomerCursorPolicy): number {
  const now = policy.nowEpochSeconds?.() ?? Math.floor((performance.timeOrigin + performance.now()) / 1_000);
  if (!Number.isSafeInteger(now) || now < 0) throw new CustomerDomainError("CUSTOMER_UNAVAILABLE", "customer cursor clock is unavailable");
  return now;
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
  const issuedAt = nowEpochSeconds(signer.policy);
  const envelope: CursorEnvelope = {
    v: cursor.v,
    queryHash: cursor.queryHash,
    name: cursor.name,
    customerRef: cursor.customerRef,
    kid: signer.policy.activeKid,
    issuedAt,
    expiresAt: issuedAt + signer.policy.maxAgeSeconds,
  };
  const normalized = cursorEnvelope({
    c: envelope.customerRef,
    e: envelope.expiresAt,
    i: envelope.issuedAt,
    k: envelope.kid,
    n: envelope.name,
    q: Buffer.from(envelope.queryHash, "hex").toString("base64url"),
    v: envelope.v,
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
  let envelope: CursorEnvelope;
  try {
    envelope = cursorEnvelope(JSON.parse(decoded));
    if (!signer.verify(payload, signature, envelope.kid)) invalidCursor();
  } catch {
    invalidCursor();
  }
  const now = nowEpochSeconds(signer.policy);
  const age = now - envelope.issuedAt;
  if (
    envelope.expiresAt <= envelope.issuedAt ||
    envelope.expiresAt - envelope.issuedAt > signer.policy.maxAgeSeconds ||
    envelope.issuedAt > now + signer.policy.clockSkewSeconds ||
    envelope.expiresAt < now - signer.policy.clockSkewSeconds ||
    (envelope.kid === signer.policy.previousKid && age > signer.policy.overlapSeconds + signer.policy.clockSkewSeconds) ||
    (envelope.kid !== signer.policy.activeKid && envelope.kid !== signer.policy.previousKid) ||
    cursorPayload(envelope) !== decoded ||
    envelope.queryHash !== search.queryHash
  ) invalidCursor();
  return {
    v: envelope.v,
    queryHash: envelope.queryHash,
    name: envelope.name,
    customerRef: envelope.customerRef,
  };
}

export function createEd25519CustomerCursorSigner(
  privateKey: KeyObject,
  publicKey: KeyObject | readonly KeyObject[],
  policy: CustomerCursorPolicy = DEFAULT_CURSOR_POLICY,
): CustomerCursorSigner {
  if (
    policy.activeKid.length === 0 ||
    policy.previousKid.length === 0 ||
    policy.activeKid === policy.previousKid ||
    !Number.isSafeInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds < 1 ||
    !Number.isSafeInteger(policy.clockSkewSeconds) || policy.clockSkewSeconds < 0 ||
    !Number.isSafeInteger(policy.overlapSeconds) || policy.overlapSeconds < 1
  ) throw new CustomerDomainError("CUSTOMER_UNAVAILABLE", "customer cursor policy is invalid");
  const verificationKeys = Array.isArray(publicKey) ? publicKey : [publicKey];
  if (verificationKeys.length === 0) throw new CustomerDomainError("CUSTOMER_UNAVAILABLE", "customer cursor verification is unavailable");
  const byKid = new Map<string, KeyObject>([
    [policy.activeKid, verificationKeys[0]],
    ...(verificationKeys[1] === undefined ? [] : [[policy.previousKid, verificationKeys[1]] as const]),
  ]);
  return {
    policy,
    sign: (payload) => Buffer.from(sign(null, Buffer.from(payload, "utf8"), privateKey)).toString("base64url"),
    verify: (payload, signature, kid) => {
      const key = byKid.get(kid);
      return key !== undefined && verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signature, "base64url"));
    },
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
