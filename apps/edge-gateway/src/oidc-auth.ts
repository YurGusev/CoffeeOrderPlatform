import {
  createHash,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import type { VerifyJsonWebKeyInput } from "node:crypto";

export interface OidcProfile {
  issuer: string;
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  redirectUri: string;
  allowedAlgorithms: readonly ["RS256"];
}

export interface ResolvedActor {
  actorRef: string;
  permissions: readonly string[];
}

export interface OidcAuthorityOptions {
  profile: OidcProfile;
  resolveActor: (
    validatedClaims: Readonly<Record<string, unknown>>,
  ) => ResolvedActor | Promise<ResolvedActor>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface LoginAttempt {
  authorizationUrl: string;
  state: string;
  loginBinding: string;
}

export interface SessionView {
  actorRef: string;
  permissions: readonly string[];
  csrf: string;
  expiresAt: number;
}

export class OidcDependencyUnavailableError extends Error {
  constructor() {
    super("OIDC dependency unavailable");
  }
}

interface PendingLogin {
  nonce: string;
  verifier: string;
  loginBindingDigest: Buffer;
  returnTo: string;
  expiresAt: number;
}

interface StoredSession extends SessionView {
  csrfDigest: Buffer;
}

interface RsaJwk extends Record<string, unknown> {
  kid: string;
  n: string;
  e: string;
}

interface JwkSet {
  keys: RsaJwk[];
}

const LOGIN_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 15 * 60_000;
const JWKS_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_PENDING = 1_000;
const MAX_SESSIONS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_RETURN_TO = "/app/customers";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.href === value
    );
  } catch {
    return false;
  }
}

function exactIssuer(value: unknown): value is string {
  if (exactHttpsUrl(value)) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      url.search === "" &&
      url.pathname === "/" &&
      !value.endsWith("/") &&
      `${value}/` === url.href
    );
  } catch {
    return false;
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validProfile(profile: unknown): profile is OidcProfile {
  if (!isRecord(profile)) return false;
  return (
    exactIssuer(profile["issuer"]) &&
    typeof profile["clientId"] === "string" &&
    profile["clientId"].length > 0 &&
    profile["clientId"].length <= 512 &&
    exactHttpsUrl(profile["authorizationUrl"]) &&
    exactHttpsUrl(profile["tokenUrl"]) &&
    exactHttpsUrl(profile["jwksUrl"]) &&
    exactHttpsUrl(profile["redirectUri"]) &&
    Array.isArray(profile["allowedAlgorithms"]) &&
    profile["allowedAlgorithms"].length === 1 &&
    profile["allowedAlgorithms"][0] === "RS256"
  );
}

function safeReturnTo(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_RETURN_TO;
  if (
    value.length > 2_048 ||
    !value.startsWith("/app/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacters(value)
  ) {
    throw new Error("unsafe returnTo");
  }
  if (value.includes("%")) throw new Error("unsafe returnTo");
  const pathname = value.split(/[?#]/u, 1)[0] ?? "";
  if (
    pathname
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    pathname.includes("//")
  ) {
    throw new Error("unsafe returnTo");
  }
  return value;
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function base64urlJson(segment: string): unknown {
  if (!/^[\da-z_-]+$/iu.test(segment)) throw new Error("malformed JWT segment");
  return JSON.parse(
    Buffer.from(segment, "base64url").toString("utf8"),
  ) as unknown;
}

async function readJsonBounded(response: Response): Promise<unknown> {
  if (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json" ||
    response.body === null
  ) {
    throw new Error("invalid OIDC response media type");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("OIDC response too large");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function constantTimeTextEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createOidcAuthority(options: OidcAuthorityOptions) {
  if (
    !isRecord(options) ||
    !validProfile(options.profile) ||
    typeof options.resolveActor !== "function"
  ) {
    throw new Error("invalid explicit OIDC profile or actor resolver");
  }
  const { profile } = options;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.timeOrigin + performance.now());
  const pending = new Map<string, PendingLogin>();
  const sessions = new Map<string, StoredSession>();
  let jwks: JwkSet | undefined;
  let jwksExpiresAt = 0;

  async function fetchOidcJson(
    url: string,
    init: RequestInit,
  ): Promise<unknown> {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== url)
      )
        throw new Error("OIDC endpoint rejected request");
      return await readJsonBounded(response);
    } catch {
      throw new OidcDependencyUnavailableError();
    }
  }

  function prune(): void {
    const time = now();
    for (const [key, entry] of pending)
      if (entry.expiresAt <= time) pending.delete(key);
    for (const [key, entry] of sessions)
      if (entry.expiresAt <= time) sessions.delete(key);
  }

  async function loadJwks(force: boolean): Promise<JwkSet> {
    if (!force && jwks && jwksExpiresAt > now()) return jwks;
    const data = await fetchOidcJson(profile.jwksUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (
      !isRecord(data) ||
      !Array.isArray(data["keys"]) ||
      data["keys"].length < 1 ||
      data["keys"].length > 100
    )
      throw new OidcDependencyUnavailableError();
    const keys = data["keys"].filter(
      (key): key is RsaJwk =>
        isRecord(key) &&
        key["kty"] === "RSA" &&
        typeof key["kid"] === "string" &&
        key["kid"].length > 0 &&
        (key["use"] === undefined || key["use"] === "sig") &&
        (key["alg"] === undefined || key["alg"] === "RS256") &&
        (key["key_ops"] === undefined ||
          (Array.isArray(key["key_ops"]) &&
            key["key_ops"].includes("verify"))) &&
        typeof key["n"] === "string" &&
        typeof key["e"] === "string",
    );
    if (keys.length === 0) throw new OidcDependencyUnavailableError();
    jwks = { keys };
    jwksExpiresAt = now() + JWKS_TTL_MS;
    return jwks;
  }

  async function findKey(kid: string): Promise<RsaJwk> {
    let set = await loadJwks(false);
    let key = set.keys.find((candidate) => candidate.kid === kid);
    if (!key) {
      set = await loadJwks(true);
      key = set.keys.find((candidate) => candidate.kid === kid);
    }
    if (!key) throw new Error("unknown signing key");
    return key;
  }

  async function validateIdToken(
    token: string,
    expectedNonce: string,
  ): Promise<Record<string, unknown>> {
    if (token.length > 32_768) throw new Error("ID token too large");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("malformed ID token");
    const header = base64urlJson(parts[0] ?? "");
    const claims = base64urlJson(parts[1] ?? "");
    if (
      !isRecord(header) ||
      !isRecord(claims) ||
      header["alg"] !== "RS256" ||
      typeof header["kid"] !== "string"
    )
      throw new Error("invalid ID token header");
    if (
      header["crit"] !== undefined ||
      header["jku"] !== undefined ||
      header["x5u"] !== undefined
    )
      throw new Error("unsupported ID token header");
    const key = await findKey(header["kid"]);
    const signedBytes = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2] ?? "", "base64url");
    if (
      !verifySignature(
        "RSA-SHA256",
        signedBytes,
        { key: key as unknown as VerifyJsonWebKeyInput["key"], format: "jwk" },
        signature,
      )
    )
      throw new Error("invalid ID token signature");

    const timestamp = Math.floor(now() / 1_000);
    if (claims["iss"] !== profile.issuer) throw new Error("invalid issuer");
    const audiences =
      typeof claims["aud"] === "string" ? [claims["aud"]] : claims["aud"];
    if (
      !Array.isArray(audiences) ||
      audiences.length === 0 ||
      !audiences.every(
        (audience) => typeof audience === "string" && audience.length > 0,
      ) ||
      !audiences.includes(profile.clientId) ||
      ((audiences.length > 1 || claims["azp"] !== undefined) &&
        claims["azp"] !== profile.clientId)
    )
      throw new Error("invalid audience");
    if (
      typeof claims["nonce"] !== "string" ||
      !constantTimeTextEqual(claims["nonce"], expectedNonce)
    )
      throw new Error("invalid nonce");
    if (
      typeof claims["exp"] !== "number" ||
      !Number.isFinite(claims["exp"]) ||
      claims["exp"] <= timestamp
    )
      throw new Error("expired ID token");
    if (
      claims["nbf"] !== undefined &&
      (typeof claims["nbf"] !== "number" ||
        !Number.isFinite(claims["nbf"]) ||
        claims["nbf"] > timestamp + CLOCK_SKEW_SECONDS)
    )
      throw new Error("ID token not active");
    if (
      typeof claims["iat"] !== "number" ||
      !Number.isFinite(claims["iat"]) ||
      claims["iat"] > timestamp + CLOCK_SKEW_SECONDS ||
      claims["iat"] < timestamp - 86_400
    )
      throw new Error("invalid ID token issued-at");
    return claims;
  }

  return {
    async begin(returnTo?: string): Promise<LoginAttempt> {
      const target = safeReturnTo(returnTo);
      prune();
      if (pending.size >= MAX_PENDING)
        throw new Error("too many pending OIDC logins");
      let state: string;
      do state = randomToken();
      while (pending.has(state));
      const nonce = randomToken();
      const verifier = randomToken(48);
      const loginBinding = randomToken();
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      const expiresAt = now() + LOGIN_TTL_MS;
      pending.set(state, {
        nonce,
        verifier,
        loginBindingDigest: createHash("sha256").update(loginBinding).digest(),
        returnTo: target,
        expiresAt,
      });
      const url = new URL(profile.authorizationUrl);
      url.searchParams.set("client_id", profile.clientId);
      url.searchParams.set("redirect_uri", profile.redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { authorizationUrl: url.href, state, loginBinding };
    },

    async complete(
      state: string,
      code: string,
      loginBinding: string,
      issuer?: string,
    ): Promise<{
      sessionId: string;
      csrf: string;
      actorRef: string;
      returnTo: string;
      expiresAt: number;
    }> {
      prune();
      const login = pending.get(state);
      if (!login || login.expiresAt <= now())
        throw new Error("invalid or expired OIDC state");
      pending.delete(state);
      if (
        typeof loginBinding !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(loginBinding)
      )
        throw new Error("invalid OIDC browser binding");
      const bindingDigest = createHash("sha256").update(loginBinding).digest();
      if (!timingSafeEqual(bindingDigest, login.loginBindingDigest))
        throw new Error("invalid OIDC browser binding");
      if (typeof code !== "string" || code.length === 0 || code.length > 4_096)
        throw new Error("invalid authorization code");
      if (issuer !== undefined && issuer !== profile.issuer)
        throw new Error("invalid authorization response issuer");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: profile.redirectUri,
        client_id: profile.clientId,
        code_verifier: login.verifier,
      });
      const tokenResponse = await fetchOidcJson(profile.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (
        !isRecord(tokenResponse) ||
        typeof tokenResponse["id_token"] !== "string"
      )
        throw new OidcDependencyUnavailableError();
      const claims = await validateIdToken(
        tokenResponse["id_token"],
        login.nonce,
      );
      let resolved: ResolvedActor;
      try {
        resolved = await options.resolveActor(Object.freeze({ ...claims }));
      } catch {
        throw new OidcDependencyUnavailableError();
      }
      if (
        !isRecord(resolved) ||
        typeof resolved["actorRef"] !== "string" ||
        resolved["actorRef"].length === 0 ||
        resolved["actorRef"].length > 256 ||
        !Array.isArray(resolved["permissions"]) ||
        resolved["permissions"].length > 256 ||
        !resolved["permissions"].every(
          (permission) =>
            typeof permission === "string" &&
            permission.length > 0 &&
            permission.length <= 256,
        )
      ) {
        throw new OidcDependencyUnavailableError();
      }
      prune();
      if (sessions.size >= MAX_SESSIONS)
        throw new OidcDependencyUnavailableError();
      let sessionId: string;
      do sessionId = randomToken();
      while (sessions.has(sessionId));
      const csrf = randomToken();
      const expiresAt = Math.floor(now() + SESSION_TTL_MS);
      const actorRef = resolved["actorRef"];
      const permissions = Object.freeze([
        ...new Set(resolved["permissions"] as string[]),
      ]);
      sessions.set(sessionId, {
        actorRef,
        permissions,
        csrf,
        csrfDigest: createHash("sha256").update(csrf).digest(),
        expiresAt,
      });
      return { sessionId, csrf, actorRef, returnTo: login.returnTo, expiresAt };
    },

    session(id: string): SessionView | undefined {
      prune();
      const entry = sessions.get(id);
      if (!entry) return undefined;
      return {
        actorRef: entry.actorRef,
        permissions: entry.permissions,
        csrf: entry.csrf,
        expiresAt: entry.expiresAt,
      };
    },

    verifyCsrf(id: string, csrf: string): boolean {
      prune();
      const entry = sessions.get(id);
      if (!entry || typeof csrf !== "string") return false;
      const digest = createHash("sha256").update(csrf).digest();
      return (
        digest.length === entry.csrfDigest.length &&
        timingSafeEqual(digest, entry.csrfDigest)
      );
    },

    logout(id: string): boolean {
      return sessions.delete(id);
    },
  };
}
