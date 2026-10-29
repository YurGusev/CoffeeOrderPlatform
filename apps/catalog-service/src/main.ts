import { createPrivateKey, createPublicKey } from "node:crypto";
import {
  verifyActorContextWithKeySet,
  verifyServiceDelegationWithKeySet,
} from "@coffee-platform/security";
import {
  startConfiguredRuntime,
  type RuntimeCompositionContext,
} from "@coffee-platform/runtime";
import { createCatalogCursorSigner } from "./application/search-catalog.js";
import { createCatalogAdapters, registerCatalogRoutes } from "./http/index.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function privateKey(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  return createPrivateKey(value);
}
function verificationKeys(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  const source = value as Record<string, unknown>;
  const active = source["active"];
  const previous = source["previous"];
  if (
    typeof active !== "string" ||
    active.length === 0 ||
    typeof previous !== "string" ||
    previous.length === 0
  )
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  return [createPublicKey(active), createPublicKey(previous)];
}
function catalogCursorPolicy(
  context: RuntimeCompositionContext,
): Readonly<{
  activeKid: string;
  maxAgeSeconds: number;
  clockSkewSeconds: number;
}> {
  const value = context.config.security["catalogCursor"];
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("SECURITY_CATALOG_CURSOR_POLICY_NOT_CONFIGURED");
  const source = value as Record<string, unknown>;
  const activeKid = source["activeKid"];
  const maxAgeSeconds = source["maxAgeSeconds"];
  const clockSkewSeconds = source["clockSkewSeconds"];
  if (
    typeof activeKid !== "string" ||
    activeKid.length === 0 ||
    typeof maxAgeSeconds !== "number" ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    typeof clockSkewSeconds !== "number" ||
    !Number.isSafeInteger(clockSkewSeconds) ||
    clockSkewSeconds < 0
  ) {
    throw new Error("SECURITY_CATALOG_CURSOR_POLICY_INVALID");
  }
  return { activeKid, maxAgeSeconds, clockSkewSeconds };
}
await startConfiguredRuntime("catalog-service", {
  configure: (app, _signal, database, _kafka, context) => {
    if (database === undefined)
      throw new Error("catalog-service database is required");
    if (context === undefined)
      throw new Error("catalog-service runtime context is required");
    const publicDelegationKeys = verificationKeys(
      context,
      "security.delegationVerificationKeys.api-public",
    );
    const internalDelegationKeys = verificationKeys(
      context,
      "security.delegationVerificationKeys.api-internal",
    );
    const cursorPrivateKey = privateKey(
      context,
      "security.catalogCursorSigningPrivateKey",
    );
    const cursorSigner = createCatalogCursorSigner(
      cursorPrivateKey,
      createPublicKey(cursorPrivateKey),
      catalogCursorPolicy(context),
    );
    registerCatalogRoutes(
      app,
      createCatalogAdapters(
        database,
        {
          verifyTransport: (request, expectedCaller) =>
            request.runtimeContext?.transportIdentity?.runtime ===
            expectedCaller,
          verifyPublicDelegation: (token, operationId, signal) => {
            signal.throwIfAborted();
            const claims = verifyActorContextWithKeySet(token, {
              publicKeys: publicDelegationKeys,
              issuer: "api-public",
              audience: "catalog-service",
              nowEpochSeconds: Math.floor(
                (performance.timeOrigin + performance.now()) / 1_000,
              ),
              clockSkewSeconds: 5,
            });
            if (claims.operationId !== operationId)
              throw new Error("ACTOR_CONTEXT_INVALID");
            return claims;
          },
          verifyInternalDelegation: (token, operationId, signal) => {
            signal.throwIfAborted();
            const claims = verifyServiceDelegationWithKeySet(token, {
              publicKeys: internalDelegationKeys,
              issuer: "api-internal",
              audience: "catalog-service",
              nowEpochSeconds: Math.floor(
                (performance.timeOrigin + performance.now()) / 1_000,
              ),
              clockSkewSeconds: 5,
            });
            if (claims.operationId !== operationId)
              throw new Error("SERVICE_DELEGATION_INVALID");
            return claims;
          },
        },
        cursorSigner,
        context.config.services["catalog-service"].catalogSnapshotProof
          ?.maxAgeMs,
      ),
    );
  },
});
