import {createPublicKey} from "node:crypto";
import {verifyActorContext, verifyServiceDelegation} from "@coffee-platform/security";
import {startConfiguredRuntime, type RuntimeCompositionContext} from "@coffee-platform/runtime";
import {createCustomerAdapters, registerCustomerRoutes} from "./http/index.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function publicKey(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  return typeof value === "string" && value.length > 0 ? createPublicKey(value) : undefined;
}

await startConfiguredRuntime("customer-service", {
  configure: (app, _signal, database, _kafka, context) => {
    if (database === undefined) throw new Error("customer-service database is required");
    if (context === undefined) throw new Error("customer-service runtime context is required");
    const publicDelegationKey = publicKey(context, "security.delegationVerificationKeys.api-public");
    const internalDelegationKey = publicKey(context, "security.delegationVerificationKeys.api-internal");
    registerCustomerRoutes(app, createCustomerAdapters(database, {
      verifyTransport: () => false,
      verifyPublicDelegation: (token, operationId, signal) => {
        signal.throwIfAborted();
        if (publicDelegationKey === undefined) throw new Error("CUSTOMER_PUBLIC_DELEGATION_KEY_NOT_CONFIGURED");
        const claims = verifyActorContext(token, {publicKey: publicDelegationKey, issuer: "api-public", audience: "customer-service", nowEpochSeconds: Math.floor((performance.timeOrigin + performance.now()) / 1_000), clockSkewSeconds: 5});
        if (claims.operationId !== operationId) throw new Error("SERVICE_DELEGATION_INVALID");
        return claims;
      },
      verifyInternalDelegation: (token, operationId, signal) => {
        signal.throwIfAborted();
        if (internalDelegationKey === undefined) throw new Error("CUSTOMER_INTERNAL_DELEGATION_KEY_NOT_CONFIGURED");
        const claims = verifyServiceDelegation(token, {publicKey: internalDelegationKey, issuer: "api-internal", audience: "customer-service", nowEpochSeconds: Math.floor((performance.timeOrigin + performance.now()) / 1_000), clockSkewSeconds: 5});
        if (claims.operationId !== operationId) throw new Error("SERVICE_DELEGATION_INVALID");
        return claims;
      },
    }));
  },
});
