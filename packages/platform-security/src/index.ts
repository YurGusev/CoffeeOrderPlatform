import {createPrivateKey, createPublicKey, sign, verify, X509Certificate, type KeyObject} from "node:crypto";
import type {ServerOptions} from "node:https";
import type {PeerCertificate} from "node:tls";
import {Temporal} from "@js-temporal/polyfill";

const TRANSPORT_SAN_PREFIX = "spiffe://coffee-platform/";
const TRANSPORT_SAN_RE = /^spiffe:\/\/coffee-platform\/([a-z0-9-]+)\/([a-z0-9-]+)$/u;
const CERTIFICATE_DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4}) GMT$/u;
const MONTHS = Object.freeze({Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11} as const);

export type TransportIdentity = Readonly<{
  environment: string;
  runtime: string;
  san: string;
}>;

export type ServiceTransportMaterial = Readonly<{
  keyPem: string;
  certPem: string;
  caPem: string;
  identity: TransportIdentity;
}>;

export type PublicTlsMaterial = Readonly<{
  keyPem: string;
  certPem: string;
  hostname: string;
}>;

export class TransportValidationError extends Error {
  public readonly code = "TRANSPORT_IDENTITY_INVALID";

  public constructor(message: string) {
    super(message);
    this.name = "TransportValidationError";
  }
}

function certificateTime(value: string, field: string): number {
  const match = CERTIFICATE_DATE_RE.exec(value);
  if (match === null) throw new TransportValidationError(`${field} is invalid`);
  const month = MONTHS[match[1] as keyof typeof MONTHS];
  const [, , dayText, hourText, minuteText, secondText, yearText] = match;
  if (month === undefined || dayText === undefined || hourText === undefined || minuteText === undefined || secondText === undefined || yearText === undefined) throw new TransportValidationError(`${field} is invalid`);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const year = Number(yearText);
  try {
    return Temporal.PlainDateTime.from({year, month: month + 1, day, hour, minute, second})
      .toZonedDateTime("UTC")
      .toInstant()
      .epochMilliseconds;
  } catch {
    throw new TransportValidationError(`${field} is invalid`);
  }
}

function identityFromSan(san: string, environment: string, expectedRuntime?: string): TransportIdentity {
  const match = TRANSPORT_SAN_RE.exec(san);
  if (match === null || match[1] !== environment || (expectedRuntime !== undefined && match[2] !== expectedRuntime)) {
    throw new TransportValidationError("service SAN is not allowed");
  }
  const [, matchedEnvironment, matchedRuntime] = match;
  if (matchedEnvironment === undefined || matchedRuntime === undefined) throw new TransportValidationError("service SAN is not allowed");
  return {environment: matchedEnvironment, runtime: matchedRuntime, san};
}

function certificateIdentity(certificate: X509Certificate, environment: string, expectedRuntime?: string): TransportIdentity {
  const san = certificate.subjectAltName?.split(",").map((value) => value.trim()).find((value) => value.startsWith("URI:"))?.slice(4);
  if (san === undefined || !san.startsWith(TRANSPORT_SAN_PREFIX)) throw new TransportValidationError("service SAN is required");
  const identity = identityFromSan(san, environment, expectedRuntime);
  const now = Temporal.Now.instant().epochMilliseconds;
  if (now < certificateTime(certificate.validFrom, "validFrom") || now > certificateTime(certificate.validTo, "validTo")) {
    throw new TransportValidationError("service certificate is expired or not yet valid");
  }
  return identity;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) throw new TransportValidationError(`transport material ${key} is required`);
  return value;
}

export function parseServiceTransportMaterial(value: unknown, environment: string, runtime: string): ServiceTransportMaterial {
  if (typeof value !== "string" || value.length === 0) throw new TransportValidationError("scoped service transport material is required");
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw new TransportValidationError("scoped service transport material must be JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new TransportValidationError("scoped service transport material must be an object");
  const source = parsed as Record<string, unknown>;
  if (Object.keys(source).sort().join(",") !== "caPem,certPem,keyPem") throw new TransportValidationError("transport material has unknown fields");
  const keyPem = stringField(source, "keyPem");
  const certPem = stringField(source, "certPem");
  const caPem = stringField(source, "caPem");
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(certPem); } catch { throw new TransportValidationError("service certificate is invalid"); }
  return {keyPem, certPem, caPem, identity: certificateIdentity(certificate, environment, runtime)};
}

export function createMutualTlsServerOptions(material: ServiceTransportMaterial): ServerOptions {
  return {key: material.keyPem, cert: material.certPem, ca: material.caPem, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3"};
}

export function parsePublicTlsMaterial(keyPem: unknown, certPem: unknown, hostname: string): PublicTlsMaterial {
  if (typeof keyPem !== "string" || keyPem.length === 0 || typeof certPem !== "string" || certPem.length === 0 || hostname.length === 0) {
    throw new TransportValidationError("public TLS material is incomplete");
  }
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
    if (certificate.checkHost(hostname) === undefined || !certificate.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("public certificate does not match key or hostname");
  } catch {
    throw new TransportValidationError("public TLS certificate is invalid for configured hostname");
  }
  const now = Temporal.Now.instant().epochMilliseconds;
  if (now < certificateTime(certificate.validFrom, "validFrom") || now > certificateTime(certificate.validTo, "validTo")) {
    throw new TransportValidationError("public TLS certificate is expired or not yet valid");
  }
  return {keyPem, certPem, hostname};
}

export function createPublicTlsServerOptions(material: PublicTlsMaterial): ServerOptions {
  return {key: material.keyPem, cert: material.certPem, requestCert: false, minVersion: "TLSv1.3"};
}

export function verifyTransportPeer(certificate: PeerCertificate, environment: string, expectedRuntime?: string): TransportIdentity {
  if (certificate.subjectaltname === undefined) throw new TransportValidationError("peer service SAN is required");
  const san = certificate.subjectaltname.split(",").map((value) => value.trim()).find((value) => value.startsWith("URI:"))?.slice(4);
  if (san === undefined) throw new TransportValidationError("peer service SAN is required");
  const identity = identityFromSan(san, environment, expectedRuntime);
  const now = Temporal.Now.instant().epochMilliseconds;
  if (now < certificateTime(certificate.valid_from, "valid_from") || now > certificateTime(certificate.valid_to, "valid_to")) throw new TransportValidationError("peer service certificate is expired or not yet valid");
  return identity;
}

export type ActorContextClaims = Readonly<{
  iss: string;
  aud: string;
  originalIssuer: string;
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent: string;
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}>;

export type ServiceDelegationClaims = Readonly<{
  iss: string;
  aud: string;
  originalCaller: string;
  operationId: string;
  correlationId: string;
  traceparent: string;
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}>;

export class SecurityValidationError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SecurityValidationError";
    this.code = code;
  }
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch {
    throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "некорректное base64url значение");
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  if (typeof value !== "object") throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "недопустимое значение claim");
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`).join(",")}}`;
}

function claimString(source: Record<string, unknown>, key: keyof ActorContextClaims): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", `claim ${key} должен быть непустой строкой`);
  return value;
}

function claimNumber(source: Record<string, unknown>, key: "iat" | "exp"): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", `claim ${key} должен быть целым числом`);
  return value;
}

function claimsFromUnknown(value: unknown): ActorContextClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "claims должны быть объектом");
  const source = value as Record<string, unknown>;
  const expected = ["iss", "aud", "originalIssuer", "sub", "permissions", "operationId", "correlationId", "traceparent", "iat", "exp", "jti", "kid"] as const;
  for (const key of Object.keys(source)) if (!(expected as readonly string[]).includes(key)) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", `неизвестный claim ${key}`);
  for (const key of expected) if (!Object.hasOwn(source, key)) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", `отсутствует claim ${key}`);
  if (!Array.isArray(source["permissions"]) || source["permissions"].some((permission) => typeof permission !== "string" || permission.length === 0)) {
    throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "permissions должны быть массивом непустых строк");
  }
  const claims: ActorContextClaims = {
    iss: claimString(source, "iss"),
    aud: claimString(source, "aud"),
    originalIssuer: claimString(source, "originalIssuer"),
    sub: claimString(source, "sub"),
    permissions: [...source["permissions"]],
    operationId: claimString(source, "operationId"),
    correlationId: claimString(source, "correlationId"),
    traceparent: claimString(source, "traceparent"),
    iat: claimNumber(source, "iat"),
    exp: claimNumber(source, "exp"),
    jti: claimString(source, "jti"),
    kid: claimString(source, "kid"),
  };
  if (claims.exp <= claims.iat) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "exp должен быть позже iat");
  return claims;
}

export function signActorContext(claims: ActorContextClaims, privateKey: KeyObject): string {
  const checked = claimsFromUnknown(claims);
  const payload = Buffer.from(canonical(checked), "utf8");
  const signature = sign(null, payload, privateKey);
  return `${base64url(payload)}.${base64url(signature)}`;
}

export type VerifyActorContextOptions = Readonly<{
  publicKey: KeyObject | string | Buffer;
  issuer: string;
  audience: string;
  nowEpochSeconds: number;
  clockSkewSeconds: number;
}>;

export function verifyActorContext(token: string, options: VerifyActorContextOptions): ActorContextClaims {
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "ожидался compact actor context");
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (payloadPart === undefined || signaturePart === undefined) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "ожидался compact actor context");
  const payload = decodeBase64url(payloadPart);
  const signature = decodeBase64url(signaturePart);
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString("utf8")) as unknown; } catch { throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "claims не являются JSON"); }
  const claims = claimsFromUnknown(parsed);
  const publicKey = options.publicKey instanceof Buffer ? createPublicKey({key: options.publicKey, format: "der", type: "spki"}) : options.publicKey;
  if (!verify(null, payload, publicKey, signature)) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "подпись actor context недействительна");
  if (claims.iss !== options.issuer || claims.aud !== options.audience) throw new SecurityValidationError("SERVICE_AUDIENCE_FORBIDDEN", "issuer или audience не разрешены");
  if (!Number.isSafeInteger(options.nowEpochSeconds) || options.clockSkewSeconds < 0) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "некорректные параметры времени");
  if (claims.iat > options.nowEpochSeconds + options.clockSkewSeconds || claims.exp <= options.nowEpochSeconds - options.clockSkewSeconds) {
    throw new SecurityValidationError("ACTOR_CONTEXT_EXPIRED", "actor context истёк или ещё не действителен");
  }
  return claims;
}

export type VerifyActorContextKeySetOptions = Omit<VerifyActorContextOptions, "publicKey"> & Readonly<{publicKeys: readonly KeyObject[]}>;

export function verifyActorContextWithKeySet(token: string, options: VerifyActorContextKeySetOptions): ActorContextClaims {
  if (options.publicKeys.length === 0) throw new SecurityValidationError("ACTOR_CONTEXT_INVALID", "verification key set is empty");
  let lastError: unknown;
  for (const publicKey of options.publicKeys) {
    try {
      return verifyActorContext(token, {...options, publicKey});
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof SecurityValidationError ? lastError : new SecurityValidationError("ACTOR_CONTEXT_INVALID", "actor context подпись недействительна");
}

function serviceClaimsFromUnknown(value: unknown): ServiceDelegationClaims {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "claims должны быть объектом");
  const source = value as Record<string, unknown>;
  const expected = ["iss", "aud", "originalCaller", "operationId", "correlationId", "traceparent", "iat", "exp", "jti", "kid"] as const;
  for (const key of Object.keys(source)) if (!(expected as readonly string[]).includes(key)) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", `неизвестный claim ${key}`);
  for (const key of expected) if (!Object.hasOwn(source, key)) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", `отсутствует claim ${key}`);
  const strings = ["iss", "aud", "originalCaller", "operationId", "correlationId", "traceparent", "jti", "kid"] as const;
  for (const key of strings) if (typeof source[key] !== "string" || source[key].length === 0) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", `claim ${key} должен быть непустой строкой`);
  for (const key of ["iat", "exp"] as const) if (typeof source[key] !== "number" || !Number.isSafeInteger(source[key]) || source[key] < 0) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", `claim ${key} должен быть целым числом`);
  const text = (key: (typeof strings)[number]): string => source[key] as string;
  const number = (key: "iat" | "exp"): number => source[key] as number;
  const claims: ServiceDelegationClaims = {
    iss: text("iss"), aud: text("aud"), originalCaller: text("originalCaller"), operationId: text("operationId"),
    correlationId: text("correlationId"), traceparent: text("traceparent"), iat: number("iat"), exp: number("exp"),
    jti: text("jti"), kid: text("kid"),
  };
  if (claims.exp <= claims.iat) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "exp должен быть позже iat");
  return claims;
}

export function signServiceDelegation(claims: ServiceDelegationClaims, privateKey: KeyObject): string {
  const checked = serviceClaimsFromUnknown(claims);
  const payload = Buffer.from(canonical(checked), "utf8");
  return `${base64url(payload)}.${base64url(sign(null, payload, privateKey))}`;
}

export type VerifyServiceDelegationOptions = Readonly<{
  publicKey: KeyObject | string | Buffer;
  issuer: string;
  audience: string;
  nowEpochSeconds: number;
  clockSkewSeconds: number;
}>;

export function verifyServiceDelegation(token: string, options: VerifyServiceDelegationOptions): ServiceDelegationClaims {
  const parts = token.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "ожидался compact service delegation");
  const payloadPart = parts[0];
  const signaturePart = parts[1];
  if (payloadPart === undefined || signaturePart === undefined) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "ожидался compact service delegation");
  const payload = decodeBase64url(payloadPart);
  const signature = decodeBase64url(signaturePart);
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString("utf8")) as unknown; } catch { throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "claims не являются JSON"); }
  const claims = serviceClaimsFromUnknown(parsed);
  const publicKey = options.publicKey instanceof Buffer ? createPublicKey({key: options.publicKey, format: "der", type: "spki"}) : options.publicKey;
  if (!verify(null, payload, publicKey, signature)) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "подпись delegation недействительна");
  if (claims.iss !== options.issuer || claims.aud !== options.audience) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "issuer или audience не разрешены");
  if (!Number.isSafeInteger(options.nowEpochSeconds) || options.clockSkewSeconds < 0) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "некорректные параметры времени");
  if (claims.iat > options.nowEpochSeconds + options.clockSkewSeconds || claims.exp <= options.nowEpochSeconds - options.clockSkewSeconds) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "delegation истёк или ещё не действителен");
  return claims;
}

export type VerifyServiceDelegationKeySetOptions = Omit<VerifyServiceDelegationOptions, "publicKey"> & Readonly<{publicKeys: readonly KeyObject[]}>;

export function verifyServiceDelegationWithKeySet(token: string, options: VerifyServiceDelegationKeySetOptions): ServiceDelegationClaims {
  if (options.publicKeys.length === 0) throw new SecurityValidationError("SERVICE_DELEGATION_INVALID", "verification key set is empty");
  let lastError: unknown;
  for (const publicKey of options.publicKeys) {
    try {
      return verifyServiceDelegation(token, {...options, publicKey});
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof SecurityValidationError ? lastError : new SecurityValidationError("SERVICE_DELEGATION_INVALID", "delegation подпись недействительна");
}
