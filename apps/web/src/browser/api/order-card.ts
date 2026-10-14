import type { QueryClient } from "@tanstack/react-query";
import type { OrderCardResponse } from "@coffee-platform/generated-client-v1";
import { ApiError } from "./client.js";
import { compareDecimalVersion } from "./format.js";
import { queryKeys } from "../app/query-keys.js";

export class OrderCardProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderCardProtocolError";
  }
}

export function isFatalOrderCardReadError(error: unknown): error is ApiError {
  return error instanceof ApiError && [403, 404].includes(error.problem.status);
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
    const { allowedActions: previousActions, ...previousCard } = previous;
    const { allowedActions: nextActions, ...nextCard } = next;
    if (JSON.stringify(previousCard) !== JSON.stringify(nextCard)) {
      throw new OrderCardProtocolError("Одинаковая версия представления содержит разные данные");
    }
    return JSON.stringify(previousActions) === JSON.stringify(nextActions) ? previous : next;
  }
  return next;
}

export function storeAcceptedOrderCard(queryClient: QueryClient, next: OrderCardResponse): OrderCardResponse | undefined {
  const key = queryKeys.orderDetail(next.orderRef);
  const current = queryClient.getQueryData<OrderCardResponse>(key);
  if (isFatalOrderCardReadError(queryClient.getQueryState(key)?.error)) return current;
  const accepted = acceptOrderCard(current, next);
  if (accepted === next) queryClient.setQueryData(key, next);
  return accepted;
}
