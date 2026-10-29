import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import {
  createHttpClient,
  type HttpClient,
} from "@coffee-platform/platform-http";
import {
  startConfiguredRuntime,
  type RuntimeComposition,
  type RuntimeCompositionContext,
} from "@coffee-platform/runtime";
import {
  parseServiceTransportMaterial,
  signServiceDelegation,
  verifyActorContextWithKeySet,
  verifyServiceDelegationWithKeySet,
} from "@coffee-platform/security";
import { createCatalogPricingClient } from "./infrastructure/catalog-client.js";
import { PricingStore } from "./infrastructure/database/pricing-store.js";
import {
  createPricingAdapters,
  registerPricingRoutes,
  type PricingSecurity,
} from "./http/index.js";
import { PricingTelemetry } from "./observability.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function verificationKeys(context: RuntimeCompositionContext, path: string) {
  const value = secretAt(context, path);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  const source = value as Record<string, unknown>;
  if (
    typeof source["active"] !== "string" ||
    !source["active"] ||
    typeof source["previous"] !== "string" ||
    !source["previous"]
  ) {
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  }
  return [
    createPublicKey(source["active"]),
    createPublicKey(source["previous"]),
  ];
}

function pricingSecurity(context: RuntimeCompositionContext): PricingSecurity {
  const publicKeys = verificationKeys(
    context,
    "security.delegationVerificationKeys.api-public",
  );
  const internalKeys = verificationKeys(
    context,
    "security.delegationVerificationKeys.api-internal",
  );
  const signingMaterial = secretAt(
    context,
    "security.pricingServiceDelegationSigningPrivateKey",
  );
  if (typeof signingMaterial !== "string" || !signingMaterial)
    throw new Error(
      "SECURITY_PRICING_SERVICE_DELEGATION_SIGNING_PRIVATE_KEY_NOT_CONFIGURED",
    );
  const signingKey = createPrivateKey(signingMaterial);
  return {
    verifyTransport: (request, caller) =>
      request.runtimeContext?.transportIdentity?.runtime === caller,
    verifyPublicDelegation: (token, operationId, signal) => {
      signal.throwIfAborted();
      const claims = verifyActorContextWithKeySet(token, {
        publicKeys,
        issuer: "api-public",
        audience: "pricing-service",
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
        publicKeys: internalKeys,
        issuer: "api-internal",
        audience: "pricing-service",
        nowEpochSeconds: Math.floor(
          (performance.timeOrigin + performance.now()) / 1_000,
        ),
        clockSkewSeconds: 5,
      });
      if (claims.operationId !== operationId)
        throw new Error("SERVICE_DELEGATION_INVALID");
      return claims;
    },
    signCatalogDelegation: ({ correlationId, traceparent, signal }) => {
      signal.throwIfAborted();
      const iat = Math.floor(
        (performance.timeOrigin + performance.now()) / 1_000,
      );
      return signServiceDelegation(
        {
          iss: "pricing-service",
          aud: "api-internal",
          originalCaller: "pricing-service",
          operationId: "getCatalogPricingInput",
          correlationId,
          traceparent:
            traceparent ??
            "00-00000000000000000000000000000000-0000000000000000-00",
          iat,
          exp: iat + 6,
          jti: randomUUID(),
          kid: "pricing-service-delegation-v1",
        },
        signingKey,
      );
    },
  };
}

let catalogClient: HttpClient | undefined;
let readinessStore: PricingStore | undefined;
const pricingTelemetry = new PricingTelemetry();
const composition: RuntimeComposition = {
  metrics: () => pricingTelemetry.render(),
  configure: (app, _signal, database, _kafka, context) => {
    if (database === undefined)
      throw new Error("pricing-service database is required");
    if (context === undefined)
      throw new Error("pricing-service runtime context is required");
    readinessStore = new PricingStore(database);
    const target = context.config.services["pricing-service"].outbound.find(
      (entry) => entry.startsWith("api-internal:"),
    );
    if (target === undefined)
      throw new Error("PRICING_CATALOG_GATEWAY_NOT_CONFIGURED");
    const material = parseServiceTransportMaterial(
      secretAt(context, "security.serviceTransportKeys.pricing-service"),
      context.config.environment,
      "pricing-service",
    );
    catalogClient = createHttpClient({
      origin: `https://${target}`,
      tls: {
        material,
        targetEnvironment: context.config.environment,
        targetRuntime: "api-internal",
      },
    });
    registerPricingRoutes(
      app,
      createPricingAdapters(
        database,
        pricingSecurity(context),
        createCatalogPricingClient(catalogClient),
        pricingTelemetry,
      ),
    );
  },
  resources: [
    {
      name: "pricing-catalog-http-client",
      start: () => {
        if (catalogClient === undefined)
          throw new Error("pricing catalog client is not configured");
      },
      stop: async () => {
        await catalogClient?.close();
      },
      destroy: () => {
        void catalogClient?.close();
      },
    },
  ],
  readinessChecks: [
    {
      name: "pricing-policy-active",
      check: async (signal) => {
        if (readinessStore === undefined) return false;
        try {
          await readinessStore.readActivePolicy(signal);
          return true;
        } catch {
          return false;
        }
      },
    },
  ],
};

await startConfiguredRuntime("pricing-service", composition);
