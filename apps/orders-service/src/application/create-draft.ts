import type { IdempotencyKey } from "@coffee-platform/idempotency";
import { isCustomerOrderInput } from "@coffee-platform/contracts-customer-v1";
import { isOrderCardResponse } from "@coffee-platform/contracts-orders-v1";
import type {
  OrderStore,
  OrderCommandResult,
  OrderPrecheckResult,
  OrderReplayResult,
} from "../infrastructure/database/order-store.js";
import { hashOrderDraftRequest } from "../infrastructure/database/order-store.js";
import { observe } from "../observability.js";

export type CommandContext = Readonly<{
  actorRef: string;
  permissions: readonly string[];
  identity: IdempotencyKey;
  correlationId: string;
  signal: AbortSignal;
  traceparent?: string;
  deadlineUtc: string | null;
  replayOnly: boolean;
}>;
export type CommandOutcome<T> =
  T | Exclude<OrderPrecheckResult, { kind: "proceed" }>;
export function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

// These are the existing owner idempotency lookups, now before any application proof or write.
export async function lookupReplay(
  store: Pick<OrderStore, "replay">,
  input: CommandContext,
): Promise<OrderReplayResult> {
  try {
    return await store.replay(
      input.identity,
      input.signal,
      input.correlationId,
    );
  } catch {
    throw failure("IDEMPOTENCY_LOOKUP_UNAVAILABLE");
  }
}
export async function precheckCommand(
  store: Pick<OrderStore, "precheck">,
  input: CommandContext,
  hash: string,
): Promise<OrderPrecheckResult> {
  try {
    return await store.precheck(
      input.identity,
      hash,
      input.correlationId,
      input.signal,
    );
  } catch {
    throw failure("IDEMPOTENCY_LOOKUP_UNAVAILABLE");
  }
}

type Customer = Readonly<{
  getOrderInput: (
    request: Readonly<{
      customerRef: string;
      delegation: string;
      correlationId: string;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ) => Promise<
    import("@coffee-platform/contracts-customer-v1").CustomerOrderInput
  >;
}>;
type Sign = (
  request: Readonly<{
    operationId: "getCustomerOrderInput" | "verifyPricingQuote";
    correlationId: string;
    traceparent?: string;
    deadlineUtc: string | null;
  }>,
) => string;
export async function createDraft(
  deps: Readonly<{
    store: Pick<OrderStore, "replay" | "precheck" | "createDraft">;
    customer: Customer;
    signInternalDelegation: Sign;
  }>,
  input: CommandContext & Readonly<{ customerRef: string | undefined }>,
): Promise<CommandOutcome<OrderCommandResult>> {
  return observe(
    "orders.use_case.create",
    async () => {
      if (input.replayOnly) return lookupReplay(deps.store, input);
      if (input.customerRef === undefined) throw failure("VALIDATION_FAILED");
      let hash: string;
      try {
        hash = hashOrderDraftRequest(input.customerRef);
      } catch {
        throw failure("VALIDATION_FAILED");
      }
      const checked = await precheckCommand(deps.store, input, hash);
      if (checked.kind !== "proceed") return checked;
      const customer = await deps.customer.getOrderInput({
        customerRef: input.customerRef,
        delegation: deps.signInternalDelegation({
          operationId: "getCustomerOrderInput",
          correlationId: input.correlationId,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
          deadlineUtc: input.deadlineUtc,
        }),
        correlationId: input.correlationId,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
        signal: input.signal,
      });
      if (
        !isCustomerOrderInput(customer) ||
        customer.customerRef !== input.customerRef
      )
        throw failure("CUSTOMER_UNAVAILABLE");
      if (customer.state !== "Active") throw failure("CUSTOMER_NOT_ACTIVE");
      const result = await deps.store.createDraft({
        actorRef: input.actorRef,
        identity: input.identity,
        correlationId: input.correlationId,
        signal: input.signal,
        cardPermissions: input.permissions,
        customer: { ...customer, state: "Active" },
      });
      if (
        !isOrderCardResponse(result.body) ||
        result.body.customer.customerRef !== input.customerRef
      )
        throw failure("INTERNAL_ERROR");
      return result;
    },
    input.signal,
  );
}
