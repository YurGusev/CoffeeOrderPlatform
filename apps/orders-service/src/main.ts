import { createPrivateKey, createPublicKey } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createHttpClient,
  type HttpClient,
} from "@coffee-platform/platform-http";
import {
  startConfiguredRuntime,
  type RuntimeComposition,
  type RuntimeCompositionContext,
} from "@coffee-platform/runtime";
import { parseServiceTransportMaterial } from "@coffee-platform/security";
import { createSqlOutboxStore } from "@coffee-platform/outbox";
import { createOrdersSecurity } from "./infrastructure/order-security.js";
import { createCustomerOrderInputClient } from "./infrastructure/customer-client.js";
import { createPricingQuoteClient } from "./infrastructure/pricing-client.js";
import { checkInternalApiReady } from "./infrastructure/internal-api-readiness.js";
import { OrderStore } from "./infrastructure/database/order-store.js";
import { registerOrdersRoutes } from "./http/index.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function verifier(
  context: RuntimeCompositionContext,
): Readonly<{ active: string; previous: string }> {
  const value = secretAt(
    context,
    "security.delegationVerificationKeys.api-public",
  );
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("ORDERS_ACTOR_VERIFIER_NOT_CONFIGURED");
  const keys = value as Record<string, unknown>;
  if (
    typeof keys["active"] !== "string" ||
    !keys["active"] ||
    typeof keys["previous"] !== "string" ||
    !keys["previous"]
  )
    throw new Error("ORDERS_ACTOR_VERIFIER_NOT_CONFIGURED");
  createPublicKey(keys["active"]);
  createPublicKey(keys["previous"]);
  return { active: keys["active"], previous: keys["previous"] };
}
function securityFor(context: RuntimeCompositionContext) {
  const signing = secretAt(
    context,
    "security.ordersServiceDelegationSigningPrivateKey",
  );
  if (typeof signing !== "string" || !signing)
    throw new Error("ORDERS_DELEGATION_SIGNER_NOT_CONFIGURED");
  createPrivateKey(signing);
  return createOrdersSecurity({
    signingPrivateKey: signing,
    publicVerificationKeys: verifier(context),
  });
}
let internalClient: HttpClient | undefined;
let outboxLoop: Promise<void> | undefined;
let outboxController: AbortController | undefined;
let relayCycle: ((signal: AbortSignal) => Promise<void>) | undefined;
let relayAlive = false;
let relayRecovered = false;
let relayFailure = false;
const composition: RuntimeComposition = {
  configure: (app, processSignal, database, kafka, context) => {
    if (database === undefined || kafka === undefined || context === undefined)
      throw new Error("ORDERS_RUNTIME_DEPENDENCIES_MISSING");
    const security = securityFor(context);
    const target = context.config.services["orders-service"].outbound.find(
      (entry) => entry.startsWith("api-internal:"),
    );
    if (target === undefined)
      throw new Error("ORDERS_INTERNAL_API_ORIGIN_NOT_CONFIGURED");
    const material = parseServiceTransportMaterial(
      secretAt(context, "security.serviceTransportKeys.orders-service"),
      context.config.environment,
      "orders-service",
    );
    internalClient = createHttpClient({
      origin: `https://${target}`,
      tls: {
        material,
        targetEnvironment: context.config.environment,
        targetRuntime: "api-internal",
      },
      connections: 4,
      pipelining: 1,
    });
    const verification =
      context.config.services["aroma-convergence"].aromaConvergence;
    if (verification === undefined)
      throw new Error("ORDERS_AROMA_VERIFICATION_CONFIG_MISSING");
    const store = new OrderStore(database, {
      maxSnapshotAgeMs: verification.maxSnapshotAgeMs,
    });
    const customer = createCustomerOrderInputClient(internalClient);
    const pricing = createPricingQuoteClient(internalClient);
    registerOrdersRoutes(app, {
      verifyTransport: (request, caller) =>
        request.runtimeContext?.transportIdentity?.runtime === caller,
      verifyPublicDelegation: (token, operation, correlationId, signal) => {
        signal.throwIfAborted();
        return security.verifyPublicDelegation(token, operation, correlationId);
      },
      signInternalDelegation: security.signInternalDelegation,
      owner: { store, customer, pricing },
    });
    const outbox = createSqlOutboxStore(database, {
      schema: "orders",
      envelopeBytes: true,
      topics: context.config.services["orders-service"].kafka.producers,
    });
    outboxController = new AbortController();
    const controller = outboxController;
    if (processSignal.aborted) controller.abort(processSignal.reason);
    else
      processSignal.addEventListener(
        "abort",
        () => controller.abort(processSignal.reason),
        { once: true },
      );
    relayCycle = async (signal) => {
      await kafka.relay(outbox, database, signal);
    };
  },
  readinessChecks: [
    {
      name: "orders-outbox-relay",
      check: () => relayAlive && relayRecovered && !relayFailure,
    },
    {
      name: "orders-internal-api",
      check: (signal) => checkInternalApiReady(internalClient, signal),
    },
  ],
  resources: [
    {
      name: "orders-http-and-outbox",
      start: () => {
        if (
          internalClient === undefined ||
          relayCycle === undefined ||
          outboxController === undefined
        )
          throw new Error("ORDERS_RUNTIME_NOT_CONFIGURED");
        const controller = outboxController;
        relayAlive = true;
        outboxLoop = (async () => {
          try {
            while (!controller.signal.aborted) {
              try {
                await relayCycle!(controller.signal);
                relayRecovered = true;
                relayFailure = false;
              } catch (error) {
                if (controller.signal.aborted) break;
                relayFailure = true;
                console.error(
                  "orders outbox relay failed",
                  error instanceof Error ? error.name : "UNKNOWN",
                );
              }
              try {
                await sleep(1_000, undefined, { signal: controller.signal });
              } catch {
                if (!controller.signal.aborted)
                  throw new Error("ORDERS_OUTBOX_SUPERVISOR_FAILED");
              }
            }
          } finally {
            relayAlive = false;
          }
        })();
      },
      stop: async () => {
        outboxController?.abort();
        try {
          await outboxLoop;
        } finally {
          await internalClient?.close();
        }
      },
      destroy: () => {
        outboxController?.abort();
        void internalClient?.close();
      },
    },
  ],
  metrics: () => [
    "# TYPE coffee_orders_outbox_relay_ready gauge",
    `coffee_orders_outbox_relay_ready ${relayAlive && relayRecovered && !relayFailure ? 1 : 0}`,
  ],
};
await startConfiguredRuntime("orders-service", composition);
