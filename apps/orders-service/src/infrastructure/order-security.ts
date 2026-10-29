import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  signServiceDelegation,
  verifyActorContextWithKeySet,
  type ActorContextClaims,
} from "@coffee-platform/security";

const PERMISSION = {
  createOrderDraft: "orders:create",
  getOrderCard: "orders:read:any",
  upsertOrderItem: "orders:edit:any",
  removeOrderItem: "orders:edit:any",
  confirmOrder: "orders:confirm:any",
  requestAromaReconciliation: "orders:reconcile:any",
} as const;
const INTERNAL_OPERATIONS = [
  "getCustomerOrderInput",
  "verifyPricingQuote",
] as const;
type OrdersOperation = keyof typeof PERMISSION;
type InternalOperation = (typeof INTERNAL_OPERATIONS)[number];
const TRACEPARENT_EMPTY =
  "00-00000000000000000000000000000000-0000000000000000-00";

type Clock = Readonly<{
  Instant: Readonly<{
    from: (value: string) => Readonly<{ epochMilliseconds: number }>;
  }>;
  Now: Readonly<{ instant: () => Readonly<{ epochMilliseconds: number }> }>;
}>;
function clock(): Clock {
  const value = (globalThis as { Temporal?: Clock }).Temporal;
  if (value === undefined) throw new Error("TEMPORAL_UNAVAILABLE");
  return value;
}
function nowEpochMilliseconds(): number {
  return clock().Now.instant().epochMilliseconds;
}

export type OrdersSecurity = Readonly<{
  verifyPublicDelegation: (
    token: string,
    operationId: OrdersOperation,
    correlationId: string,
  ) => ActorContextClaims;
  signInternalDelegation: (
    request: Readonly<{
      operationId: InternalOperation;
      correlationId: string;
      traceparent?: string;
      deadlineUtc: string | null;
    }>,
  ) => string;
}>;

function ed25519Private(value: string): KeyObject {
  if (typeof value !== "string" || !value)
    throw new Error("ORDERS_DELEGATION_SIGNER_NOT_CONFIGURED");
  const key = createPrivateKey(value);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("ORDERS_DELEGATION_SIGNER_INVALID");
  return key;
}
function ed25519Public(value: string): KeyObject {
  if (typeof value !== "string" || !value)
    throw new Error("ORDERS_ACTOR_VERIFIER_NOT_CONFIGURED");
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("ORDERS_ACTOR_VERIFIER_INVALID");
  return key;
}

/** Scoped service material is required at composition, not lazily at the first command. */
export function createOrdersSecurity(
  material: Readonly<{
    signingPrivateKey: string;
    publicVerificationKeys: Readonly<{ active: string; previous: string }>;
  }>,
): OrdersSecurity {
  const signingKey = ed25519Private(material.signingPrivateKey);
  const publicKeys = [
    ed25519Public(material.publicVerificationKeys?.active),
    ed25519Public(material.publicVerificationKeys?.previous),
  ];
  return {
    verifyPublicDelegation(token, operationId, correlationId) {
      if (!(operationId in PERMISSION))
        throw new Error("ACTOR_CONTEXT_INVALID");
      const claims = verifyActorContextWithKeySet(token, {
        publicKeys,
        issuer: "api-public",
        audience: "orders-service",
        nowEpochSeconds: Math.floor(nowEpochMilliseconds() / 1_000),
        clockSkewSeconds: 5,
      });
      if (
        claims.originalIssuer !== "edge-gateway" ||
        claims.operationId !== operationId ||
        claims.correlationId !== correlationId ||
        !claims.permissions.includes(PERMISSION[operationId])
      ) {
        throw new Error("ACTOR_CONTEXT_INVALID");
      }
      return claims;
    },
    signInternalDelegation(request) {
      if (
        !(INTERNAL_OPERATIONS as readonly string[]).includes(
          request.operationId,
        )
      )
        throw new Error("SERVICE_DELEGATION_INVALID");
      let deadline = NaN;
      if (typeof request.deadlineUtc === "string") {
        try {
          deadline = clock().Instant.from(
            request.deadlineUtc,
          ).epochMilliseconds;
        } catch {
          /* Invalid or absent request deadline fails closed below. */
        }
      }
      const now = nowEpochMilliseconds();
      if (!Number.isFinite(deadline) || deadline <= now)
        throw new Error("SERVICE_DELEGATION_DEADLINE_EXPIRED");
      const iat = Math.floor(now / 1_000);
      const exp = Math.min(iat + 6, Math.floor(deadline / 1_000) + 5);
      if (exp <= iat) throw new Error("SERVICE_DELEGATION_DEADLINE_EXPIRED");
      return signServiceDelegation(
        {
          iss: "orders-service",
          aud: "api-internal",
          originalCaller: "orders-service",
          operationId: request.operationId,
          correlationId: request.correlationId,
          traceparent: request.traceparent ?? TRACEPARENT_EMPTY,
          iat,
          exp,
          jti: randomUUID(),
          kid: "orders-service-delegation-v1",
        },
        signingKey,
      );
    },
  };
}
