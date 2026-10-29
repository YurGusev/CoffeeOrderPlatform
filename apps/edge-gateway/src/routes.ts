import { randomUUID, timingSafeEqual } from "node:crypto";
import type {
  RuntimeComposition,
  RuntimeRequestContext,
} from "@coffee-platform/runtime";
import { OidcDependencyUnavailableError } from "./oidc-auth.js";
import type { SessionView } from "./oidc-auth.js";

// Node 26 provides Temporal at runtime; the pinned TypeScript lib does not yet declare it.
declare const Temporal: {
  readonly Instant: {
    fromEpochMilliseconds: (value: number) => {
      toString: (options: { fractionalSecondDigits: 3 }) => string;
    };
  };
};

type RuntimeApp = Parameters<NonNullable<RuntimeComposition["configure"]>>[0];
type RouteApp = Pick<RuntimeApp, "get" | "post">;
type EdgeRequest = Readonly<{
  raw: Readonly<{ rawHeaders: string[]; socket: unknown }>;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  query: unknown;
  runtimeContext?: RuntimeRequestContext | null;
}>;
type EdgeReply = {
  header: (name: string, value: string | readonly string[]) => EdgeReply;
  getHeader: (name: string) => number | string | string[] | undefined;
  code: (status: number) => EdgeReply;
  type: (value: string) => EdgeReply;
  send: (body?: unknown) => EdgeReply;
};

export type EdgeAuthAuthority = Readonly<{
  begin: (
    returnTo?: string,
  ) => Promise<
    Readonly<{ authorizationUrl: string; state: string; loginBinding: string }>
  >;
  complete: (
    state: string,
    code: string,
    loginBinding: string,
  ) => Promise<
    Readonly<{
      sessionId: string;
      csrf: string;
      actorRef: string;
      expiresAt: number;
      returnTo: string;
    }>
  >;
  session: (id: string) => SessionView | undefined;
  verifyCsrf: (id: string, csrf: string) => boolean;
  logout: (id: string) => boolean;
}>;

export type EdgeOperation = Readonly<{
  operationId: string;
  audience: "api-public" | "realtime-gateway";
  requiredPermission?: string;
}>;

export type EdgeActorClaims = Readonly<{
  iss: "edge-gateway";
  aud: "api-public" | "realtime-gateway";
  originalIssuer: "edge-gateway";
  sub: string;
  permissions: readonly string[];
  operationId: string;
  correlationId: string;
  traceparent?: string;
  iat: number;
  exp: number;
  jti: string;
}>;

export type EdgeAuthAdapters = Readonly<{
  authority: EdgeAuthAuthority;
  /** Must verify the authenticated TLS peer as the configured edge-nginx service identity. */
  verifyNginxPeer: (request: EdgeRequest) => boolean;
  /** Must resolve only against the validated contract inventory; undefined fails closed. */
  resolveOperation: (
    method: string,
    rawTarget: string,
  ) => EdgeOperation | undefined;
  /** Signs the current compact Ed25519 actor-context contract. */
  signActorContext: (claims: EdgeActorClaims) => string;
  now: () => number;
  origin: string;
}>;

const SESSION_COOKIE = "__Host-coffee-session";
const CSRF_COOKIE = "__Host-coffee-csrf";
const LOGIN_COOKIE = "__Host-coffee-login";
const CLEAR_LOGIN_COOKIE = `${LOGIN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
const NO_STORE = "no-store";
const MAX_RAW_TARGET = 4_096;
const SECURITY_HEADERS = new Set([
  "x-actor-context",
  "x-audience",
  "x-operation-id",
  "x-original-method",
  "x-original-uri",
  "x-http-method-override",
  "x-method-override",
  "x-original-url",
]);

function rawHeaderValues(request: EdgeRequest, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function header(request: EdgeRequest, name: string): string | undefined {
  const values = rawHeaderValues(request, name);
  if (values.length !== 1) return undefined;
  return values[0];
}

function sendProblem(
  reply: EdgeReply,
  status: 400 | 401 | 403 | 503,
  code: string,
  detail: string,
): EdgeReply {
  const correlationId =
    typeof reply.getHeader("x-correlation-id") === "string"
      ? String(reply.getHeader("x-correlation-id"))
      : randomUUID();
  reply
    .header("cache-control", NO_STORE)
    .type("application/problem+json")
    .code(status);
  return reply.send({
    type: "about:blank",
    title: code,
    status,
    code,
    detail,
    instance: "",
    correlationId,
    errors: [],
  });
}

function setNoStore(reply: EdgeReply): void {
  reply.header("cache-control", NO_STORE);
  reply.header("pragma", NO_STORE);
}

function cookieValue(request: EdgeRequest, key: string): string | undefined {
  const values = rawHeaderValues(request, "cookie");
  if (
    values.length !== 1 ||
    values[0] === undefined ||
    values[0].length > 8_192
  )
    return undefined;
  const found: string[] = [];
  for (const item of values[0].split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === key)
      found.push(item.slice(separator + 1).trim());
  }
  return found.length === 1 && found[0] !== "" ? found[0] : undefined;
}

function validSameOrigin(request: EdgeRequest, origin: string): boolean {
  const values = rawHeaderValues(request, "origin");
  return values.length === 1 && values[0] === origin;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function invalidPath(rawTarget: string): boolean {
  if (
    rawTarget.length === 0 ||
    rawTarget.length > MAX_RAW_TARGET ||
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//")
  )
    return true;
  const queryAt = rawTarget.indexOf("?");
  const path = queryAt < 0 ? rawTarget : rawTarget.slice(0, queryAt);
  if (path.includes("%") || path.includes("\\")) return true;
  for (const char of path) {
    const code = char.charCodeAt(0);
    if (code <= 32 || code === 127 || char === "#") return true;
  }
  if (path.split("/").some((part) => part === "." || part === ".."))
    return true;
  return path.length === 0;
}

function isBodyless(request: EdgeRequest): boolean {
  return (
    request.body === undefined &&
    rawHeaderValues(request, "content-length").length === 0 &&
    rawHeaderValues(request, "transfer-encoding").length === 0
  );
}

function sessionFromRequest(
  request: EdgeRequest,
  authority: EdgeAuthAuthority,
): Readonly<{ id: string; session: SessionView }> | undefined {
  const id = cookieValue(request, SESSION_COOKIE);
  if (id === undefined) return undefined;
  const session = authority.session(id);
  if (session === undefined || !Number.isFinite(session.expiresAt))
    return undefined;
  return { id, session };
}

function rejectSecurityHeaderForgery(request: EdgeRequest): boolean {
  for (const name of SECURITY_HEADERS) {
    const values = rawHeaderValues(request, name);
    if (values.length > 1) return true;
  }
  return [
    "x-actor-context",
    "x-audience",
    "x-operation-id",
    "x-http-method-override",
    "x-method-override",
    "x-original-url",
  ].some((name) => rawHeaderValues(request, name).length > 0);
}

function clearCookies(reply: EdgeReply): void {
  reply.header("set-cookie", [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    `${CSRF_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`,
    CLEAR_LOGIN_COOKIE,
  ]);
}

/** Register only the contract-owned Edge auth and nginx subrequest HTTP handlers. */
export function registerEdgeAuthRoutes(
  app: RouteApp,
  adapters: EdgeAuthAdapters,
): void {
  app.get("/auth/login", async (request: EdgeRequest, reply: EdgeReply) => {
    setNoStore(reply);
    const query = request.query as Record<string, unknown>;
    if (
      Object.keys(query).some((key) => key !== "returnTo") ||
      (query["returnTo"] !== undefined && typeof query["returnTo"] !== "string")
    )
      return sendProblem(
        reply,
        400,
        "INVALID_AUTH_REQUEST",
        "Invalid login request.",
      );
    try {
      const attempt = await adapters.authority.begin(
        typeof query["returnTo"] === "string" ? query["returnTo"] : undefined,
      );
      const target = new URL(attempt.authorizationUrl);
      if (
        target.protocol !== "https:" ||
        target.username !== "" ||
        target.password !== "" ||
        target.hash !== "" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(attempt.loginBinding)
      )
        return sendProblem(
          reply,
          503,
          "AUTH_UNAVAILABLE",
          "Authentication is unavailable.",
        );
      return reply
        .code(303)
        .header("location", target.toString())
        .header(
          "set-cookie",
          `${LOGIN_COOKIE}=${attempt.loginBinding}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
        )
        .send();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return sendProblem(
        reply,
        /returnTo|return path|unsafe/iu.test(message) ? 400 : 503,
        /returnTo|return path|unsafe/iu.test(message)
          ? "INVALID_AUTH_REQUEST"
          : "AUTH_UNAVAILABLE",
        /returnTo|return path|unsafe/iu.test(message)
          ? "Invalid local return path."
          : "Authentication is unavailable.",
      );
    }
  });

  app.get("/auth/callback", async (request: EdgeRequest, reply: EdgeReply) => {
    setNoStore(reply);
    const query = request.query as Record<string, unknown>;
    if (
      Object.keys(query).some((key) => key !== "state" && key !== "code") ||
      typeof query["state"] !== "string" ||
      typeof query["code"] !== "string" ||
      query["state"].length > 512 ||
      query["code"].length > 4_096
    ) {
      reply.header("set-cookie", CLEAR_LOGIN_COOKIE);
      return sendProblem(
        reply,
        400,
        "INVALID_AUTH_REQUEST",
        "Invalid authentication callback.",
      );
    }
    const loginBinding = cookieValue(request, LOGIN_COOKIE);
    if (loginBinding === undefined) {
      reply.header("set-cookie", CLEAR_LOGIN_COOKIE);
      return sendProblem(
        reply,
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication could not be completed.",
      );
    }
    try {
      const result = await adapters.authority.complete(
        query["state"],
        query["code"],
        loginBinding,
      );
      if (
        !result.returnTo.startsWith("/app/") ||
        result.returnTo.startsWith("//") ||
        result.returnTo.includes("\\") ||
        result.returnTo.includes("%")
      ) {
        reply.header("set-cookie", CLEAR_LOGIN_COOKIE);
        return sendProblem(
          reply,
          401,
          "AUTHENTICATION_REQUIRED",
          "Authentication could not be completed.",
        );
      }
      reply
        .header("location", result.returnTo)
        .header("set-cookie", [
          `${SESSION_COOKIE}=${result.sessionId}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          `${CSRF_COOKIE}=${result.csrf}; Path=/; Secure; SameSite=Lax`,
          CLEAR_LOGIN_COOKIE,
        ]);
      return reply.code(303).send();
    } catch (error) {
      reply.header("set-cookie", CLEAR_LOGIN_COOKIE);
      if (error instanceof OidcDependencyUnavailableError)
        return sendProblem(
          reply,
          503,
          "AUTH_UNAVAILABLE",
          "Authentication is unavailable.",
        );
      return sendProblem(
        reply,
        401,
        "AUTHENTICATION_REQUIRED",
        "Authentication could not be completed.",
      );
    }
  });

  app.get("/auth/session", async (request: EdgeRequest, reply: EdgeReply) => {
    setNoStore(reply);
    try {
      const current = sessionFromRequest(request, adapters.authority);
      if (current === undefined)
        return sendProblem(
          reply,
          401,
          "AUTHENTICATION_REQUIRED",
          "An active session is required.",
        );
      return reply
        .code(200)
        .type("application/json")
        .send({
          actorRef: current.session.actorRef,
          expiresAt: Temporal.Instant.fromEpochMilliseconds(
            current.session.expiresAt,
          ).toString({ fractionalSecondDigits: 3 }),
        });
    } catch {
      return sendProblem(
        reply,
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is unavailable.",
      );
    }
  });

  app.post("/auth/logout", async (request: EdgeRequest, reply: EdgeReply) => {
    setNoStore(reply);
    try {
      const current = sessionFromRequest(request, adapters.authority);
      if (current === undefined)
        return sendProblem(
          reply,
          401,
          "AUTHENTICATION_REQUIRED",
          "An active session is required.",
        );
      const csrfHeader = header(request, "x-csrf-token");
      const csrfCookie = cookieValue(request, CSRF_COOKIE);
      if (
        !validSameOrigin(request, adapters.origin) ||
        csrfHeader === undefined ||
        csrfCookie === undefined ||
        !sameSecret(csrfHeader, csrfCookie) ||
        !adapters.authority.verifyCsrf(current.id, csrfHeader)
      )
        return sendProblem(
          reply,
          403,
          "CSRF_FAILED",
          "Origin or CSRF proof is invalid.",
        );
      if (!adapters.authority.logout(current.id))
        return sendProblem(
          reply,
          401,
          "AUTHENTICATION_REQUIRED",
          "An active session is required.",
        );
      clearCookies(reply);
      return reply.code(204).send();
    } catch {
      return sendProblem(
        reply,
        503,
        "AUTH_UNAVAILABLE",
        "Authentication is unavailable.",
      );
    }
  });

  app.get(
    "/_edge/authorize",
    async (request: EdgeRequest, reply: EdgeReply) => {
      setNoStore(reply);
      try {
        if (!adapters.verifyNginxPeer(request))
          return sendProblem(
            reply,
            401,
            "AUTHENTICATION_REQUIRED",
            "Authenticated nginx transport is required.",
          );
        if (!isBodyless(request) || rejectSecurityHeaderForgery(request))
          return sendProblem(
            reply,
            403,
            "AUTHORIZATION_FORBIDDEN",
            "Authorization request is invalid.",
          );
        const method = header(request, "x-original-method");
        const rawTarget = header(request, "x-original-uri");
        if (
          method === undefined ||
          rawTarget === undefined ||
          !/^(GET|POST|PUT|PATCH|DELETE|HEAD)$/u.test(method) ||
          invalidPath(rawTarget)
        )
          return sendProblem(
            reply,
            403,
            "AUTHORIZATION_FORBIDDEN",
            "Authorization request is invalid.",
          );
        const operation = adapters.resolveOperation(method, rawTarget);
        if (
          operation === undefined ||
          !/^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(operation.operationId) ||
          !["api-public", "realtime-gateway"].includes(operation.audience)
        )
          return sendProblem(
            reply,
            403,
            "AUTHORIZATION_FORBIDDEN",
            "The requested operation is not authorized.",
          );
        if (
          method !== "GET" &&
          (!validSameOrigin(request, adapters.origin) ||
            header(request, "x-csrf-token") === undefined)
        )
          return sendProblem(
            reply,
            403,
            "CSRF_FAILED",
            "Origin or CSRF proof is invalid.",
          );
        const current = sessionFromRequest(request, adapters.authority);
        if (current === undefined)
          return sendProblem(
            reply,
            401,
            "AUTHENTICATION_REQUIRED",
            "An active session is required.",
          );
        if (method !== "GET") {
          const csrfHeader = header(request, "x-csrf-token");
          const csrfCookie = cookieValue(request, CSRF_COOKIE);
          if (
            csrfHeader === undefined ||
            csrfCookie === undefined ||
            !sameSecret(csrfHeader, csrfCookie) ||
            !adapters.authority.verifyCsrf(current.id, csrfHeader)
          )
            return sendProblem(
              reply,
              403,
              "CSRF_FAILED",
              "Origin or CSRF proof is invalid.",
            );
        }
        if (
          operation.requiredPermission !== undefined &&
          !current.session.permissions.includes(operation.requiredPermission)
        )
          return sendProblem(
            reply,
            403,
            "AUTHORIZATION_FORBIDDEN",
            "The actor lacks permission for this operation.",
          );
        const now = adapters.now();
        if (!Number.isFinite(now) || now < 0)
          return sendProblem(
            reply,
            503,
            "AUTH_UNAVAILABLE",
            "Authentication is unavailable.",
          );
        const iat = Math.floor(now / 1_000);
        const exp = Math.floor(
          Math.min(now + 60_000, current.session.expiresAt) / 1_000,
        );
        if (exp <= iat)
          return sendProblem(
            reply,
            401,
            "AUTHENTICATION_REQUIRED",
            "The active session has expired.",
          );
        const traceparent = header(request, "traceparent");
        const claims: EdgeActorClaims = {
          iss: "edge-gateway",
          aud: operation.audience,
          originalIssuer: "edge-gateway",
          sub: current.session.actorRef,
          permissions: [...current.session.permissions],
          operationId: operation.operationId,
          correlationId: request.runtimeContext?.correlationId ?? randomUUID(),
          ...(traceparent === undefined ? {} : { traceparent }),
          iat,
          exp,
          jti: randomUUID(),
        };
        const token = adapters.signActorContext(claims);
        if (
          typeof token !== "string" ||
          token.length === 0 ||
          token.length > 8_192
        )
          return sendProblem(
            reply,
            503,
            "AUTH_UNAVAILABLE",
            "Authentication is unavailable.",
          );
        reply.header("x-actor-context", token);
        reply.header("x-correlation-id", claims.correlationId);
        return reply.code(204).send();
      } catch {
        return sendProblem(
          reply,
          503,
          "AUTH_UNAVAILABLE",
          "Authentication is unavailable.",
        );
      }
    },
  );
}
