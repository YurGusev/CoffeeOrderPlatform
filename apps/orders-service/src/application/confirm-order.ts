import { canonicalRequestHash } from "@coffee-platform/idempotency";
import type {
  OrderStore,
  OrderCommandResult,
} from "../infrastructure/database/order-store.js";
import { observe } from "../telemetry/index.js";
import {
  failure,
  lookupReplay,
  precheckCommand,
  type CommandContext,
  type CommandOutcome,
} from "./create-draft.js";

export async function confirmOrder(
  store: Pick<OrderStore, "replay" | "precheck" | "confirm">,
  input: CommandContext &
    Readonly<{ orderRef: string; expectedVersion: string | undefined }>,
): Promise<CommandOutcome<OrderCommandResult>> {
  return observe(
    "orders.use_case.confirm",
    async () => {
      if (input.replayOnly) return lookupReplay(store, input);
      if (input.expectedVersion === undefined)
        throw failure("VALIDATION_FAILED");
      const hash = canonicalRequestHash({
        orderRef: input.orderRef,
        expectedVersion: input.expectedVersion,
      });
      const checked = await precheckCommand(store, input, hash);
      if (checked.kind !== "proceed") return checked;
      return store.confirm({
        actorRef: input.actorRef,
        identity: input.identity,
        correlationId: input.correlationId,
        signal: input.signal,
        cardPermissions: input.permissions,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
        orderRef: input.orderRef,
        expectedVersion: input.expectedVersion,
      });
    },
    input.signal,
  );
}
