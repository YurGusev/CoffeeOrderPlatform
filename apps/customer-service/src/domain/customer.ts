import {createHash, randomBytes} from "node:crypto";
import {domainToASCII} from "node:url";
import {parsePhoneNumberFromString} from "libphonenumber-js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/u;
const EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const EMAIL_DOMAIN_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const ACTOR_PATTERN = /^[\x21-\x7e]{1,128}$/u;

let lastUlidTimestamp = -1;
let lastUlidRandom: Uint8Array | undefined;

export type CustomerStatus = "Active" | "Inactive";
export type AddressKind = "Delivery";

export type CustomerAddressInput = Readonly<{
  line1: string;
  line2?: string;
  city: string;
  postalCode?: string;
  countryCode?: string;
}>;

export type CustomerCreateInput = Readonly<{
  displayName: string;
  phone?: string;
  email?: string;
  address?: CustomerAddressInput;
}>;

export type NormalizedAddress = Readonly<{
  kind: AddressKind;
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string | null;
  countryCode: string;
}>;

export type NormalizedCustomerCreate = Readonly<{
  displayName: string;
  displayNameSearch: string;
  phoneE164: string | null;
  emailNormalized: string | null;
  address: NormalizedAddress | null;
}>;

export type CustomerResponse = Readonly<{
  customerRef: string;
  version: string;
  displayName: string;
  phone?: string;
  email?: string;
  address?: Readonly<{
    addressRef: string;
    line1: string;
    line2?: string;
    city: string;
    postalCode?: string;
    countryCode: string;
  }>;
  createdAt: string;
  updatedAt: string;
}>;

export type CustomerSummary = Readonly<{
  customerRef: string;
  version: string;
  displayName: string;
  phone?: string;
  email?: string;
}>;

export type CustomerOrderInput = Readonly<{
  customerRef: string;
  customerVersion: string;
  displayName: string;
  state: CustomerStatus;
}>;

export type CustomerSearchMode = "phone" | "email" | "name";
export type CustomerSearch = Readonly<{
  mode: CustomerSearchMode;
  value: string;
  queryHash: string;
}>;

export class CustomerDomainError extends Error {
  public readonly code:
    | "VALIDATION_FAILED"
    | "INVALID_CURSOR"
    | "CUSTOMER_NOT_FOUND"
    | "CUSTOMER_PHONE_CONFLICT"
    | "CUSTOMER_EMAIL_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "IDEMPOTENCY_REQUEST_IN_PROGRESS"
    | "IDEMPOTENCY_RESULT_INVALID"
    | "CUSTOMER_UNAVAILABLE";

  public constructor(code: CustomerDomainError["code"], message: string) {
    super(message);
    this.name = "CustomerDomainError";
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new CustomerDomainError("VALIDATION_FAILED", message);
}

function normalizedWhitespace(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function boundedText(value: unknown, field: string, maximum: number, required = true): string {
  if (typeof value !== "string") invalid(`${field} must be a string`);
  const normalized = normalizedWhitespace(value);
  if (required && normalized.length === 0) invalid(`${field} must not be empty`);
  if (normalized.length > maximum) invalid(`${field} is too long`);
  return normalized;
}

export function normalizeDisplayName(value: string): string {
  const normalized = boundedText(value, "displayName", 200);
  if (normalized.length === 0) invalid("displayName must not be empty");
  return normalized;
}

export function normalizePhone(value: string): string {
  if (value.length > 64) invalid("phone is too long");
  const normalized = value.normalize("NFC").trim();
  const parsed = parsePhoneNumberFromString(normalized, "RU");
  if (parsed === undefined || !parsed.isValid() || !E164_PATTERN.test(parsed.number)) invalid("phone must be a valid number");
  return parsed.number;
}

export function normalizeEmail(value: string): string {
  const normalized = value.normalize("NFC").trim().toLowerCase();
  if (normalized.length > 254) invalid("email is too long");
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at !== normalized.indexOf("@")) invalid("email format is invalid");
  const local = normalized.slice(0, at);
  const asciiDomain = domainToASCII(normalized.slice(at + 1));
  if (!EMAIL_LOCAL_PATTERN.test(local) || !EMAIL_DOMAIN_PATTERN.test(asciiDomain)) invalid("email format is invalid");
  const result = `${local}@${asciiDomain.toLowerCase()}`;
  if (result.length > 254) invalid("email is too long");
  return result;
}

export function normalizeAddress(input: CustomerAddressInput): NormalizedAddress {
  const line1 = boundedText(input.line1, "address.line1", 200);
  const line2 = boundedText(input.line2 ?? "", "address.line2", 200, false) || null;
  const city = boundedText(input.city, "address.city", 120);
  const postalCode = boundedText(input.postalCode ?? "", "address.postalCode", 20, false) || null;
  const countryCode = (input.countryCode ?? "RU").normalize("NFC").trim().toUpperCase();
  if (!/^[A-Z]{2}$/u.test(countryCode)) invalid("address.countryCode must be ISO alpha-2");
  return {kind: "Delivery", line1, line2, city, postalCode, countryCode};
}

export function normalizeCustomerCreate(input: CustomerCreateInput): NormalizedCustomerCreate {
  const displayName = normalizeDisplayName(input.displayName);
  const phoneE164 = input.phone === undefined ? null : normalizePhone(input.phone);
  const emailNormalized = input.email === undefined ? null : normalizeEmail(input.email);
  if (phoneE164 === null && emailNormalized === null) invalid("phone or email is required");
  return {
    displayName,
    displayNameSearch: displayName.toLowerCase(),
    phoneE164,
    emailNormalized,
    address: input.address === undefined ? null : normalizeAddress(input.address),
  };
}

export function normalizeSearchQuery(value: string): CustomerSearch {
  const query = normalizedWhitespace(value);
  if (query.length < 2 || query.length > 200) invalid("query length must be between 2 and 200");
  const phone = parsePhoneNumberFromString(query, "RU");
  if (phone !== undefined && phone.isValid() && E164_PATTERN.test(phone.number)) return search("phone", phone.number);
  if (query.includes("@")) return search("email", normalizeEmail(query));
  return search("name", query.toLowerCase());
}

function search(mode: CustomerSearchMode, value: string): CustomerSearch {
  const queryHash = createHash("sha256").update(value, "utf8").digest("hex");
  return {mode, value, queryHash};
}

export function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function maskPhone(value: string): string {
  return `${value.slice(0, 2)}******${value.slice(-4)}`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function toCustomerSummary(row: Readonly<{
  customerRef: string;
  version: string;
  displayName: string;
  phoneE164: string | null;
  emailNormalized: string | null;
}>): CustomerSummary {
  return {
    customerRef: row.customerRef,
    version: row.version,
    displayName: row.displayName,
    ...(row.phoneE164 === null ? {} : {phone: maskPhone(row.phoneE164)}),
    ...(row.emailNormalized === null ? {} : {email: maskEmail(row.emailNormalized)}),
  };
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function assertActorRef(value: string): void {
  if (!ACTOR_PATTERN.test(value)) invalid("actorRef is invalid");
}

export function assertCustomerRef(value: string): void {
  if (!/^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value)) invalid("customerRef is invalid");
}

export function monotonicUlid(): string {
  let timestamp = Math.floor(performance.timeOrigin + performance.now());
  if (timestamp < lastUlidTimestamp) timestamp = lastUlidTimestamp;
  if (timestamp === lastUlidTimestamp) {
    if (lastUlidRandom === undefined) lastUlidRandom = randomBytes(10);
    else if (incrementRandom(lastUlidRandom)) {
      timestamp += 1;
      lastUlidTimestamp = timestamp;
    }
  } else {
    lastUlidRandom = randomBytes(10);
    lastUlidTimestamp = timestamp;
  }
  if (lastUlidRandom === undefined) throw new Error("ULID random part was not initialized");
  return `${encodeTimestamp(timestamp)}${encodeRandom(lastUlidRandom)}`;
}

function incrementRandom(value: Uint8Array): boolean {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const next = (value[index] ?? 0) + 1;
    value[index] = next & 0xff;
    if (next <= 0xff) return false;
  }
  value.fill(0);
  return true;
}

function encodeTimestamp(value: number): string {
  let remainder = value;
  let encoded = "";
  for (let index = 0; index < 10; index += 1) {
    encoded = `${ULID_ALPHABET[remainder % 32] ?? "0"}${encoded}`;
    remainder = Math.floor(remainder / 32);
  }
  return encoded;
}

function encodeRandom(value: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += ULID_ALPHABET[(buffer >> bits) & 31] ?? "0";
      buffer &= (1 << bits) - 1;
    }
  }
  return encoded;
}

export function auditAfterHash(input: Readonly<{customerRef: string; addressRef?: string}>): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
}
