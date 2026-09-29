import type { QueryClient } from "@tanstack/react-query";
import type { OrderCardResponse } from "@coffee-platform/generated-client-v1";
import { compareDecimalVersion } from "./format.js";
import { queryKeys } from "../app/query-keys.js";

export class OrderCardProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderCardProtocolError";
  }
}

export function acceptOrderCard(
  previous: OrderCardResponse | undefined,
  next: OrderCardResponse,
): OrderCardResponse {
  if (!previous) return next;
  if (previous.orderRef !== next.orderRef) {
    throw new OrderCardProtocolError("Ответ карточки относится к другому заказу");
  }
  const order = compareDecimalVersion(previous.projectionVersion, next.projectionVersion);
  if (order > 0) return previous;
  if (order === 0) {
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      throw new OrderCardProtocolError("Одинаковая версия представления содержит разные данные");
    }
    return previous;
  }
  return next;
}

export function storeAcceptedOrderCard(queryClient: QueryClient, next: OrderCardResponse): OrderCardResponse {
  const key = queryKeys.orderDetail(next.orderRef);
  const accepted = acceptOrderCard(queryClient.getQueryData<OrderCardResponse>(key), next);
  if (accepted === next) queryClient.setQueryData(key, next);
  return accepted;
}
