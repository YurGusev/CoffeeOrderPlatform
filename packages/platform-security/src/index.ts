import {createPublicKey, sign, verify, type KeyObject} from "node:crypto";

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
