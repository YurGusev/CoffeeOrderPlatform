import {ProviderError} from "../../domain/provider-errors.js";
import {nowInstant, toInstant} from "@coffee-platform/platform-time";

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const MAX_COOKIE_VALUE = 8192;

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

export type ProviderCookie = Readonly<{
  name: string;
  value: string;
  domain: string | null;
  path: string;
  expiresAt: string | null;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "strict" | "lax" | "none" | null;
}>;

function cookieInvalid(): never {
  throw new ProviderError("ProviderProtocolViolation");
}

function domainMatches(host: string, domain: string): boolean {
  const normalized = domain.replace(/^\./u, "").toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

function parseExpiry(value: string): string {
  try { return toInstant(value).toString(); } catch { /* RFC 6265 date follows below. */ }
  const match = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})(?:\s+|-)([A-Za-z]{3})(?:\s+|-)(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/u.exec(value.trim());
  if (match === null) cookieInvalid();
  const [, day, monthName, year, hour, minute, second] = match;
  if (day === undefined || monthName === undefined || year === undefined || hour === undefined || minute === undefined || second === undefined) cookieInvalid();
  const months = new Map([["Jan", "01"], ["Feb", "02"], ["Mar", "03"], ["Apr", "04"], ["May", "05"], ["Jun", "06"], ["Jul", "07"], ["Aug", "08"], ["Sep", "09"], ["Oct", "10"], ["Nov", "11"], ["Dec", "12"]]);
  const month = months.get(monthName);
  if (month === undefined) cookieInvalid();
  try { return toInstant(`${year}-${month}-${day.padStart(2, "0")}T${hour}:${minute}:${second}Z`).toString(); } catch { cookieInvalid(); }
}

function splitSetCookie(value: string): string[] {
  // Expires may contain a comma. The look-ahead only splits a new cookie pair.
  return value.split(/,(?=\s*[^;,=\s]+\s*=)/u).map(item => item.trim()).filter(item => item.length > 0);
}

function oneSetCookie(serialized: string, originHost: string): ProviderCookie {
  const parts = serialized.split(";").map(item => item.trim());
  const first = parts.shift();
  if (first === undefined) cookieInvalid();
  const separator = first.indexOf("=");
  if (separator <= 0) cookieInvalid();
  const name = first.slice(0, separator).trim();
  const value = first.slice(separator + 1);
  if (!COOKIE_NAME.test(name) || value.length > MAX_COOKIE_VALUE || hasControl(value)) cookieInvalid();
  let domain: string | null = null;
  let path = "/";
  let expiresAt: string | null = null;
  let maxAge: number | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: ProviderCookie["sameSite"] = null;
  for (const attribute of parts) {
    if (attribute.length === 0) continue;
    const equals = attribute.indexOf("=");
    const attributeName = (equals < 0 ? attribute : attribute.slice(0, equals)).trim().toLowerCase();
    const attributeValue = equals < 0 ? "" : attribute.slice(equals + 1).trim();
    if (attributeName === "domain") {
      if (domain !== null || attributeValue.length === 0 || /\s/u.test(attributeValue) || hasControl(attributeValue) || !domainMatches(originHost, attributeValue)) cookieInvalid();
      domain = attributeValue.replace(/^\./u, "").toLowerCase();
    } else if (attributeName === "path") {
      if (attributeValue.length === 0 || !attributeValue.startsWith("/") || hasControl(attributeValue)) cookieInvalid();
      path = attributeValue;
    } else if (attributeName === "expires") {
      if (expiresAt !== null) cookieInvalid();
      expiresAt = parseExpiry(attributeValue);
    } else if (attributeName === "max-age") {
      if (maxAge !== null || !/^-?\d+$/u.test(attributeValue)) cookieInvalid();
      maxAge = Number(attributeValue);
      if (!Number.isSafeInteger(maxAge)) cookieInvalid();
    } else if (attributeName === "secure") secure = true;
    else if (attributeName === "httponly") httpOnly = true;
    else if (attributeName === "samesite") {
      if (sameSite !== null || !["strict", "lax", "none"].includes(attributeValue.toLowerCase())) cookieInvalid();
      sameSite = attributeValue.toLowerCase() as NonNullable<ProviderCookie["sameSite"]>;
    }
    // Unknown attributes are not sent back and are not persisted.
  }
  if (maxAge !== null) {
    try { expiresAt = maxAge <= 0 ? "1970-01-01T00:00:00Z" : nowInstant().add({seconds: maxAge}).toString(); } catch { cookieInvalid(); }
  }
  return {name, value, domain, path, expiresAt, secure, httpOnly, sameSite};
}

export function parseSetCookieHeaders(headers: Headers, originHost: string): readonly ProviderCookie[] {
  const getSetCookie = (headers as Headers & {getSetCookie?: () => string[]}).getSetCookie;
  const values = typeof getSetCookie === "function" ? getSetCookie.call(headers) : (() => {
    const combined = headers.get("set-cookie");
    return combined === null ? [] : splitSetCookie(combined);
  })();
  return values.map(value => oneSetCookie(value, originHost));
}

function epochMilliseconds(value: string): number {
  try { return Number(toInstant(value).epochMilliseconds); } catch { return Number.NaN; }
}

export function cookieHeader(cookies: readonly ProviderCookie[], originHost: string, now = Number(nowInstant().epochMilliseconds)): string {
  const usable = cookies.filter(cookie =>
    COOKIE_NAME.test(cookie.name) && cookie.value.length <= MAX_COOKIE_VALUE && !hasControl(cookie.value) &&
    (originHost === "" || cookie.domain === null || domainMatches(originHost, cookie.domain)) &&
    cookie.path === "/" && (cookie.expiresAt === null || epochMilliseconds(cookie.expiresAt) > now));
  return usable.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

export function earliestCookieExpiry(cookies: readonly ProviderCookie[]): string | null {
  const expiries = cookies.flatMap(cookie => cookie.expiresAt === null ? [] : [cookie.expiresAt]);
  if (expiries.length === 0) return null;
  return expiries.reduce((earliest, value) => epochMilliseconds(value) < epochMilliseconds(earliest) ? value : earliest);
}

export function serializeCookieMaterial(cookies: readonly ProviderCookie[]): string {
  if (cookies.length === 0) cookieInvalid();
  return JSON.stringify(cookies.map(cookie => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
    expiresAt: cookie.expiresAt, secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
  })));
}

export function deserializeCookieMaterial(value: string): readonly ProviderCookie[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { cookieInvalid(); }
  if (!Array.isArray(parsed) || parsed.length === 0) cookieInvalid();
  return parsed.map(item => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) cookieInvalid();
    const source = item as Record<string, unknown>;
    const name = source["name"];
    const cookieValue = source["value"];
    const domain = source["domain"];
    const path = source["path"];
    const expiresAt = source["expiresAt"];
    const secure = source["secure"];
    const httpOnly = source["httpOnly"];
    const sameSite = source["sameSite"];
    if (typeof name !== "string" || !COOKIE_NAME.test(name) || typeof cookieValue !== "string" || cookieValue.length > MAX_COOKIE_VALUE || hasControl(cookieValue) ||
      !(domain === null || typeof domain === "string") || typeof path !== "string" || path !== "/" ||
      !(expiresAt === null || typeof expiresAt === "string") || typeof secure !== "boolean" || typeof httpOnly !== "boolean" ||
      !(sameSite === null || sameSite === "strict" || sameSite === "lax" || sameSite === "none")) cookieInvalid();
    if (expiresAt !== null) { try { toInstant(expiresAt); } catch { cookieInvalid(); } }
    return {name, value: cookieValue, domain, path, expiresAt, secure, httpOnly, sameSite};
  });
}
