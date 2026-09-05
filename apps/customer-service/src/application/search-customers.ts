import {withTransaction, type Database} from "@coffee-platform/database";
import {canonicalJson, type JsonValue} from "@coffee-platform/idempotency";
import {
  CustomerDomainError,
  escapeLikePrefix,
  normalizeSearchQuery,
  toCustomerSummary,
  type CustomerSummary,
  type CustomerSearch,
} from "../domain/customer.js";
import type {CustomerRepository} from "../infrastructure/postgres/customer-repository.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export type CustomerSearchResult = Readonly<{
  items: readonly CustomerSummary[];
  nextCursor: string | null;
}>;

type Cursor = Readonly<{
  v: 1;
  queryHash: string;
  name: string;
  customerRef: string;
}>;

function invalidCursor(): never {
  throw new CustomerDomainError("INVALID_CURSOR", "cursor is invalid");
}

function cursorValue(value: unknown): Cursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(",") !== "customerRef,name,queryHash,v") invalidCursor();
  if (object["v"] !== 1 || typeof object["queryHash"] !== "string" || !/^[0-9a-f]{64}$/u.test(object["queryHash"]) ||
    typeof object["name"] !== "string" || object["name"].length === 0 ||
    typeof object["customerRef"] !== "string" || !/^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(object["customerRef"])) invalidCursor();
  return {
    v: 1,
    queryHash: object["queryHash"],
    name: object["name"],
    customerRef: object["customerRef"],
  };
}

export function encodeCustomerCursor(cursor: Cursor): string {
  return Buffer.from(canonicalJson(cursor as JsonValue), "utf8").toString("base64url");
}

export function decodeCustomerCursor(value: string, search: CustomerSearch): Cursor {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalidCursor();
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) invalidCursor();
  } catch {
    invalidCursor();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    invalidCursor();
  }
  const cursor = cursorValue(parsed);
  if (canonicalJson(cursor as JsonValue) !== decoded) invalidCursor();
  if (cursor.queryHash !== search.queryHash) invalidCursor();
  return cursor;
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CustomerDomainError("VALIDATION_FAILED", "limit must be between 1 and 50");
  }
  return limit;
}

export async function searchCustomers(
  database: Database,
  repository: CustomerRepository,
  input: Readonly<{query: string; limit?: number; cursor?: string}>,
  signal?: AbortSignal,
): Promise<CustomerSearchResult> {
  const search = normalizeSearchQuery(input.query);
  const limit = pageLimit(input.limit);
  const cursor = input.cursor === undefined ? null : decodeCustomerCursor(input.cursor, search);
  const rows = await withTransaction(database, {
    mode: "interactive",
    ...(signal === undefined ? {} : {signal}),
  }, transaction => repository.search(transaction, search.mode, search.mode === "name" ? escapeLikePrefix(search.value) : search.value, cursor, limit + 1));
  const hasNext = rows.length > limit;
  const pageRows = hasNext ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map(toCustomerSummary),
    nextCursor: hasNext && last !== undefined
      ? encodeCustomerCursor({v: 1, queryHash: search.queryHash, name: last.name, customerRef: last.customerRef})
      : null,
  };
}
