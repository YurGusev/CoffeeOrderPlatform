import type { OrderStore } from "../infrastructure/database/order-store.js";
import { observe } from "../observability.js";

export async function getOrderCard(
  store: Pick<OrderStore, "getCard">,
  input: Readonly<{
    orderRef: string;
    permissions: readonly string[];
    correlationId: string;
    signal: AbortSignal;
  }>,
): ReturnType<OrderStore["getCard"]> {
  return observe(
    "orders.use_case.get",
    () =>
      store.getCard(input.orderRef, {
        permissions: input.permissions,
        correlationId: input.correlationId,
        signal: input.signal,
      }),
    input.signal,
  );
}
