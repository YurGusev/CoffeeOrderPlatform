import { createPrivateKey } from "node:crypto";
import type {
  RuntimeComposition,
  RuntimeCompositionContext,
  RuntimeRequestContext,
} from "@coffee-platform/runtime";
import { signActorContext } from "@coffee-platform/security";
import type { ActorContextClaims } from "@coffee-platform/security";
import { registerEdgeAuthRoutes } from "./routes.js";
import type {
  EdgeActorClaims,
  EdgeAuthAdapters,
  EdgeAuthAuthority,
  EdgeOperation,
} from "./routes.js";
import { clientV1BrowserOperations } from "./client-operations.gen.js";
import { createOidcAuthority } from "./oidc-auth.js";
import type { OidcProfile } from "./oidc-auth.js";

const ZERO_TRACEPARENT =
  "00-00000000000000000000000000000000-0000000000000000-00";
const ACTOR_CONTEXT_KID = "edge-actor-context-v1";

function matchesRoute(template: string, path: string): boolean {
  const required = template.split("/");
  const actual = path.split("/");
  if (actual.length !== required.length) return false;
  return required.every((segment, index) => {
    const value = actual[index];
    if (value === undefined) return false;
    if (/^\{[A-Za-z][A-Za-z0-9]*\}$/u.test(segment))
      return /^[A-Za-z0-9_-]+$/u.test(value);
    return segment === value;
  });
}

/** Only published client-v1 operations with an explicit permission can be authorized. */
export function resolveBrowserOperation(
  method: string,
  rawTarget: string,
): EdgeOperation | undefined {
  const path = rawTarget.split("?", 1)[0];
  if (
    path === undefined ||
    !path.startsWith("/") ||
    path.includes("%") ||
    path.includes("\\") ||
    path.includes("#")
  )
    return undefined;
  const operation = clientV1BrowserOperations.find(
    (entry) =>
      entry.method === method &&
      "permission" in entry &&
      matchesRoute(entry.path, path),
  );
  if (operation === undefined || !("permission" in operation)) return undefined;
  return {
    operationId: operation.operationId,
    audience: operation.audience,
    requiredPermission: operation.permission,
  };
}

function nginxPeer(
  request: Readonly<{ runtimeContext?: RuntimeRequestContext | null }>,
): boolean {
  return request.runtimeContext?.transportIdentity?.runtime === "edge-nginx";
}

function scopedActorSigningKey(context: RuntimeCompositionContext) {
  const security = context.secrets["security"];
  const value =
    security !== null &&
    typeof security === "object" &&
    !Array.isArray(security)
      ? (security as Record<string, unknown>)[
          "actorContextEdgeSigningPrivateKey"
        ]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("EDGE_ACTOR_CONTEXT_SIGNING_KEY_NOT_CONFIGURED");
  }
  return createPrivateKey(value);
}

/** Build the runtime-backed adapters; identity and permissions come only from authority state. */
export function createConfiguredEdgeAuthAdapters(
  context: RuntimeCompositionContext,
  authority: EdgeAuthAuthority,
  origin: string,
  resolveOperation: (
    method: string,
    rawTarget: string,
  ) => EdgeOperation | undefined = resolveBrowserOperation,
): EdgeAuthAdapters {
  return {
    authority,
    verifyNginxPeer: (request) =>
      nginxPeer(
        request as unknown as Readonly<{
          runtimeContext?: RuntimeRequestContext | null;
        }>,
      ),
    resolveOperation,
    signActorContext: (claims: EdgeActorClaims) => {
      const privateKey = scopedActorSigningKey(context);
      const signedClaims: ActorContextClaims = {
        iss: claims.iss,
        aud: claims.aud,
        originalIssuer: claims.originalIssuer,
        sub: claims.sub,
        permissions: claims.permissions,
        operationId: claims.operationId,
        correlationId: claims.correlationId,
        traceparent: claims.traceparent ?? ZERO_TRACEPARENT,
        iat: claims.iat,
        exp: claims.exp,
        jti: claims.jti,
        kid: ACTOR_CONTEXT_KID,
      };
      return signActorContext(signedClaims, privateKey);
    },
    now: () => performance.timeOrigin + performance.now(),
    origin,
  };
}

function unavailableAdapters(): EdgeAuthAdapters {
  const unavailable = (): never => {
    throw new Error("EDGE_AUTH_PROFILE_NOT_CONFIGURED");
  };
  const authority: EdgeAuthAuthority = {
    begin: async () => unavailable(),
    complete: async () => unavailable(),
    session: () => undefined,
    verifyCsrf: () => false,
    logout: () => false,
  };
  return {
    authority,
    verifyNginxPeer: () => false,
    resolveOperation: () => undefined,
    signActorContext: () => unavailable(),
    now: () => performance.timeOrigin + performance.now(),
    origin: "https://invalid.invalid",
  };
}

function runtimeAdapters(context: RuntimeCompositionContext): EdgeAuthAdapters {
  const oidc = context.config.browserOidc;
  if (oidc === null) return unavailableAdapters();
  const baseUrl = context.config.platform["publicBaseUrl"];
  if (typeof baseUrl !== "string")
    throw new Error("EDGE_PUBLIC_ORIGIN_NOT_CONFIGURED");
  const origin = new URL(baseUrl).origin;
  if (oidc.redirectUri !== `${origin}/auth/callback`) {
    throw new Error("EDGE_OIDC_REDIRECT_ORIGIN_MISMATCH");
  }
  const profile: OidcProfile = {
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    authorizationUrl: oidc.authorizationUrl,
    tokenUrl: oidc.tokenUrl,
    jwksUrl: oidc.jwksUrl,
    redirectUri: oidc.redirectUri,
    allowedAlgorithms: ["RS256"],
  };
  const permissions: ReadonlySet<string> = new Set(
    clientV1BrowserOperations.flatMap((operation) =>
      "permission" in operation ? [operation.permission] : [],
    ),
  );
  const authority = createOidcAuthority({
    profile,
    resolveActor: (claims) => {
      const actorRef = claims[oidc.actorRefClaim];
      const rights = claims[oidc.permissionsClaim];
      if (
        typeof actorRef !== "string" ||
        actorRef.length === 0 ||
        actorRef.length > 256 ||
        !Array.isArray(rights) ||
        rights.length > 256 ||
        !rights.every(
          (right) => typeof right === "string" && permissions.has(right),
        )
      ) {
        throw new Error("EDGE_OIDC_ACTOR_MAPPING_REJECTED");
      }
      return { actorRef, permissions: rights as string[] };
    },
  });
  return createConfiguredEdgeAuthAdapters(context, authority, origin);
}

/** Register edge auth routes in the platform runtime composition lifecycle. */
export function createEdgeAuthComposition(
  adapters?: EdgeAuthAdapters,
): RuntimeComposition {
  return {
    configure: (app, _signal, _database, _kafka, context) =>
      registerEdgeAuthRoutes(
        app,
        adapters ??
          (context ? runtimeAdapters(context) : unavailableAdapters()),
      ),
  };
}
