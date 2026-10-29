import type { QueryClient } from "@tanstack/react-query";
import type { OrderCardResponse } from "@coffee-platform/generated-client-v1";
import { ApiError, ProtocolError } from "./client.js";
import { compareDecimalVersion } from "./format.js";
import { queryKeys } from "../app/query-keys.js";

export class OrderCardProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderCardProtocolError";
  }
}

export function isFatalOrderCardReadError(
  error: unknown,
): error is ApiError | ProtocolError | OrderCardProtocolError {
  return (
    (error instanceof ApiError && [403, 404].includes(error.problem.status)) ||
    error instanceof ProtocolError ||
    error instanceof OrderCardProtocolError
  );
}

export function acceptOrderCard(
  previous: OrderCardResponse | undefined,
  next: OrderCardResponse,
  source: "owner-get" | "command" = "command",
): OrderCardResponse {
  if (!previous) return next;
  if (previous.orderRef !== next.orderRef) {
    throw new OrderCardProtocolError(
      "Ответ карточки относится к другому заказу",
    );
  }
  const order = compareDecimalVersion(
    previous.projectionVersion,
    next.projectionVersion,
  );
  if (order > 0) return previous;
  if (order === 0) {
    const {
      allowedActions: previousActions,
      aroma: previousAroma,
      ...previousCard
    } = previous;
    const { allowedActions: nextActions, aroma: nextAroma, ...nextCard } = next;
    const sameCard = JSON.stringify(previousCard) === JSON.stringify(nextCard);
    const {
      state: previousState,
      blockers: previousBlockers,
      ...previousAromaFacts
    } = previousAroma;
    const {
      state: nextState,
      blockers: nextBlockers,
      ...nextAromaFacts
    } = nextAroma;
    const sameAromaFacts =
      JSON.stringify(previousAromaFacts) === JSON.stringify(nextAromaFacts);
    const sameBlockers =
      JSON.stringify(previousBlockers) === JSON.stringify(nextBlockers);
    const identicalAroma =
      JSON.stringify(previousAroma) === JSON.stringify(nextAroma);
    const identicalCard = sameCard && identicalAroma;
    const exactUnknownOutcomeOverlay = (
      state: string,
      blockers: typeof nextBlockers,
    ) =>
      state === "UnknownOutcome" &&
      blockers.length === 1 &&
      blockers[0]?.code === "AROMA_UNKNOWN_OUTCOME";
    const previousUnknownOutcomeOverlay = exactUnknownOutcomeOverlay(
      previousState,
      previousBlockers,
    );
    const nextUnknownOutcomeOverlay = exactUnknownOutcomeOverlay(
      nextState,
      nextBlockers,
    );

    // Only a current validated owner GET can observe DB-time lease/freshness
    // transitions or the UnknownOutcome reservation overlay at a fixed version.
    const ownerReadStateChange =
      source === "owner-get" &&
      next.status === "Confirmed" &&
      sameCard &&
      sameAromaFacts &&
      ((sameBlockers &&
        ((previousState === "InSync" &&
          ["OutOfSync", "Converging"].includes(nextState)) ||
          (previousState === "Converging" && nextState === "OutOfSync") ||
          (previousState === "OutOfSync" && nextState === "Converging"))) ||
        nextUnknownOutcomeOverlay ||
        (previousUnknownOutcomeOverlay &&
          [
            "PendingObservation",
            "Converging",
            "OutOfSync",
            "Blocked",
            "UnknownOutcome",
          ].includes(nextState)));

    if (!identicalCard && !ownerReadStateChange) {
      throw new OrderCardProtocolError(
        "Одинаковая версия представления содержит разные данные",
      );
    }
    if (ownerReadStateChange) return next;
    return JSON.stringify(previousActions) === JSON.stringify(nextActions)
      ? previous
      : next;
  }
  return next;
}

export function storeAcceptedOrderCard(
  queryClient: QueryClient,
  next: OrderCardResponse,
): OrderCardResponse | undefined {
  const key = queryKeys.orderDetail(next.orderRef);
  const current = queryClient.getQueryData<OrderCardResponse>(key);
  if (isFatalOrderCardReadError(queryClient.getQueryState(key)?.error))
    return current;
  const accepted = acceptOrderCard(current, next);
  if (accepted === next) queryClient.setQueryData(key, next);
  return accepted;
}
