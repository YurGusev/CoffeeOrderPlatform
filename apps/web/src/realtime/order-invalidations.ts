import type {
  OrderCardResponse,
  SseResourceInvalidated,
  SseStreamReady,
  SseStreamReset,
} from "@coffee-platform/generated-client-v1";
import { clientV1Schemas } from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import type { Query, QueryClient } from "@tanstack/react-query";
import { assertSchema } from "../shared/schema.js";
import { instantEpochMilliseconds } from "../shared/time.js";

const schemas = clientV1Schemas as Record<string, unknown>;
// Event data uses the same canonical generated schemas as transport proofs.
export const orderStreamSchemas = {
  "resource-invalidated.v1": schemas["SseResourceInvalidated"],
  "stream-ready.v1": schemas["SseStreamReady"],
  "stream-reset.v1": schemas["SseStreamReset"],
} as const;
export type OrderStreamEvent = keyof typeof orderStreamSchemas;
export type OrderStreamData =
  SseResourceInvalidated | SseStreamReady | SseStreamReset;

/** Ignore untrusted/malformed hints; never expose their payload as business data. */
export function parseOrderStreamData(
  event: OrderStreamEvent,
  data: string,
): OrderStreamData | undefined {
  if (new TextEncoder().encode(data).byteLength > 2048) return undefined;
  try {
    const value = assertSchema<OrderStreamData>(
      orderStreamSchemas[event],
      JSON.parse(data),
      event,
    );
    if ("connectedAt" in value) instantEpochMilliseconds(value.connectedAt);
    return value;
  } catch {
    return undefined;
  }
}

export function isOrderDetailQuery(query: Query): boolean {
  return (
    query.queryKey.length === 3 &&
    query.queryKey[0] === "orders" &&
    query.queryKey[1] === "detail"
  );
}

const pendingCauses = new WeakMap<
  Query,
  {
    correlationId: string;
    isCurrent: () => boolean;
    promise: Promise<unknown> | undefined;
  }
>();
const fetchCauses = new WeakMap<
  AbortSignal,
  { correlationId: string; isCurrent: () => boolean }
>();

export function orderFetchCorrelation(
  client: QueryClient,
  queryKey: readonly unknown[],
  signal: AbortSignal,
): string | undefined {
  const existing = fetchCauses.get(signal);
  if (existing)
    return existing.isCurrent() ? existing.correlationId : undefined;
  const query = client.getQueryCache().find({ queryKey, exact: true });
  const cause = query && pendingCauses.get(query);
  if (
    !query ||
    !cause ||
    !cause.isCurrent() ||
    (cause.promise && cause.promise !== query.promise)
  )
    return undefined;
  pendingCauses.delete(query);
  fetchCauses.set(signal, cause);
  return cause.correlationId;
}

function withHintCause(
  query: Query,
  correlationId: string | undefined,
  isCurrent: () => boolean,
  work: () => Promise<void>,
): Promise<void> {
  if (!correlationId) return work();
  const cause: {
    correlationId: string;
    isCurrent: () => boolean;
    promise: Promise<unknown> | undefined;
  } = { correlationId, isCurrent, promise: undefined };
  const previous = query.promise;
  pendingCauses.set(query, cause);
  const result = work();
  cause.promise = query.promise;
  if (!cause.promise || cause.promise === previous) {
    if (pendingCauses.get(query) === cause) pendingCauses.delete(query);
  } else {
    void cause.promise.then(
      () => {
        if (pendingCauses.get(query) === cause) pendingCauses.delete(query);
      },
      () => {
        if (pendingCauses.get(query) === cause) pendingCauses.delete(query);
      },
    );
  }
  return result;
}

async function invalidateDetails(
  client: QueryClient,
  queries: Query[],
  isCurrent: () => boolean,
  correlationId?: string,
): Promise<void> {
  await Promise.all(
    queries.map(async (query) => {
      if (!isCurrent()) return;
      // TanStack does not cancel/refetch an initial GET with no data. A ready/hint
      // received during that GET needs one subsequent owner read to close the race.
      const initialRead =
        query.state.fetchStatus !== "idle" && query.state.data === undefined;
      const initialPromise = initialRead ? query.promise : undefined;
      await withHintCause(
        query,
        initialRead ? undefined : correlationId,
        isCurrent,
        () =>
          client.invalidateQueries({
            queryKey: query.queryKey,
            exact: true,
            refetchType: "active",
          }),
      );
      if (initialPromise) await initialPromise.catch(() => undefined);
      if (
        initialRead &&
        isCurrent() &&
        client
          .getQueryCache()
          .find({ queryKey: query.queryKey, exact: true }) === query
      ) {
        await withHintCause(query, correlationId, isCurrent, () =>
          client.refetchQueries({
            queryKey: query.queryKey,
            exact: true,
            type: "active",
          }),
        );
      }
    }),
  );
}

export async function invalidateOrderHint(
  client: QueryClient,
  hint: SseResourceInvalidated,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  const query = client
    .getQueryCache()
    .find({ queryKey: ["orders", "detail", hint.subjectRef], exact: true });
  if (!query) return;
  const card = query.state.data as OrderCardResponse | undefined;
  if (card && BigInt(card.projectionVersion) >= BigInt(hint.ownerVersion))
    return;
  await invalidateDetails(client, [query], isCurrent, hint.correlationId);
}

export async function invalidateExistingOrderDetails(
  client: QueryClient,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  await invalidateDetails(
    client,
    client.getQueryCache().findAll({ predicate: isOrderDetailQuery }),
    isCurrent,
  );
}
