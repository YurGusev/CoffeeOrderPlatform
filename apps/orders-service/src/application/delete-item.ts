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

export async function deleteItem(
  store: Pick<OrderStore, "replay" | "precheck" | "deleteItem">,
  input: CommandContext &
    Readonly<{
      orderRef: string;
      itemRef: string;
      expectedVersion: string | undefined;
    }>,
): Promise<CommandOutcome<OrderCommandResult>> {
  return observe(
    "orders.use_case.remove",
    async () => {
      if (input.replayOnly) return lookupReplay(store, input);
      if (input.expectedVersion === undefined)
        throw failure("VALIDATION_FAILED");
      const hash = canonicalRequestHash({
        orderRef: input.orderRef,
        itemRef: input.itemRef,
        expectedVersion: input.expectedVersion,
      });
      const checked = await precheckCommand(store, input, hash);
      if (checked.kind !== "proceed") return checked;
      return store.deleteItem({
        actorRef: input.actorRef,
        identity: input.identity,
        correlationId: input.correlationId,
        signal: input.signal,
        cardPermissions: input.permissions,
        orderRef: input.orderRef,
        itemRef: input.itemRef,
        expectedVersion: input.expectedVersion,
      });
    },
    input.signal,
  );
}
