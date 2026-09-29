import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BrowserSession,
} from "@coffee-platform/generated-edge-auth-v1";
import type {
  CatalogProductSummary,
  CustomerCreateRequest,
  CustomerResponse,
  OrderCardResponse,
  PricingQuoteResponse,
  ReconciliationAcceptedResponse,
} from "@coffee-platform/generated-client-v1";
import { api, ProtocolError, SESSION_INVALIDATED } from "./client.js";
import {
  clearPendingIntents,
  dismissRecoveryDiscardedWarning,
  markRecoveryDiscarded,
  readPendingIntents,
  type PendingIntent,
} from "./idempotency.js";
import { acceptOrderCard, storeAcceptedOrderCard } from "./order-card.js";
import {
  assertApplicationSession,
  captureApplicationSession,
  currentApplicationActor,
  setApplicationSession,
} from "./session-identity.js";
import { currentEpochMilliseconds, instantEpochMilliseconds } from "./time.js";
import { queryKeys } from "../app/query-keys.js";

export function useBrowserSession() {
  const queryClient = useQueryClient();
  return useQuery<BrowserSession>({
    queryFn: async ({ signal }) => {
      const next = await api.getSession(signal);
      if (instantEpochMilliseconds(next.expiresAt) <= currentEpochMilliseconds()) {
        setApplicationSession(undefined);
        throw new ProtocolError("Сессия оператора истекла");
      }
      const previousActor = currentApplicationActor();
      const pending = readPendingIntents();
      if (pending.corrupt || pending.items.some((intent) => intent.actorRef !== next.actorRef)) {
        clearPendingIntents();
        markRecoveryDiscarded();
      }
      if (previousActor && previousActor !== next.actorRef) {
        void queryClient.cancelQueries();
        queryClient.getMutationCache().clear();
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "browser-session" });
      }
      setApplicationSession(next.actorRef);
      return next;
    },
    queryKey: ["browser-session"],
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: async () => {
      await queryClient.cancelQueries();
      clearPendingIntents();
      dismissRecoveryDiscardedWarning();
      setApplicationSession(undefined);
      queryClient.clear();
      window.dispatchEvent(new Event(SESSION_INVALIDATED));
    },
  });
}

export function useCustomerSearch(actorRef: string, q: string, cursor?: string) {
  return useQuery({
    enabled: q.trim().length >= 2,
    queryFn: async ({ signal }) => {
      const session = captureApplicationSession(actorRef);
      const result = await api.searchCustomers(q, cursor, signal);
      assertApplicationSession(session);
      return result;
    },
    queryKey: queryKeys.customersSearch({ q, ...(cursor ? { cursor } : {}) }),
    staleTime: 30_000,
  });
}

export function useCreateCustomer(actorRef: string) {
  return useMutation({ mutationFn: (body: CustomerCreateRequest) => api.createCustomer(actorRef, body) });
}

export function useCreateDraft(actorRef: string) {
  return useMutation({ mutationFn: (customerRef: string) => api.createDraft(actorRef, customerRef) });
}

export function useOrderCard(actorRef: string, orderRef: string) {
  const queryClient = useQueryClient();
  const orderKey = queryKeys.orderDetail(orderRef);
  return useQuery({
    enabled: /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(orderRef),
    queryFn: async ({ signal }) => {
      const session = captureApplicationSession(actorRef);
      const next = await api.getOrderCard(orderRef, signal);
      assertApplicationSession(session);
      return acceptOrderCard(queryClient.getQueryData<OrderCardResponse>(orderKey), next);
    },
    queryKey: orderKey,
    staleTime: 0,
  });
}

export function useCatalogSearch(actorRef: string, input: Readonly<{
  availability: CatalogProductSummary["availability"] | "";
  cursor?: string;
  orderRef: string;
  q: string;
}>) {
  return useQuery({
    enabled: input.q.trim().length >= 2 && /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.orderRef),
    queryFn: async ({ signal }) => {
      const session = captureApplicationSession(actorRef);
      const result = await api.searchCatalog(input.q, input.availability, input.cursor, signal);
      assertApplicationSession(session);
      return result;
    },
    queryKey: queryKeys.catalogSearch(input),
    staleTime: 30_000,
  });
}

export type QuoteAndPutInput = Readonly<{
  itemRef: string;
  product: Pick<CatalogProductSummary, "productRef" | "variantRef">;
  quantity: string;
}>;

export function useQuoteAndPutItem(actorRef: string, orderRef: string) {
  const queryClient = useQueryClient();
  const orderKey = queryKeys.orderDetail(orderRef);
  return useMutation({
    mutationFn: async (input: QuoteAndPutInput) => {
      const current = queryClient.getQueryData<OrderCardResponse>(orderKey);
      if (!current || !current.allowedActions.includes("edit-items") || current.status !== "Draft") {
        throw new ProtocolError("Текущее состояние заказа не разрешает изменение состава");
      }
      const quote = await api.createQuote(actorRef, {
        customerRef: current.customer.customerRef,
        lines: [{ productRef: input.product.productRef, quantity: input.quantity, variantRef: input.product.variantRef }],
      });
      const line = quote.lines[0];
      if (!line) throw new ProtocolError("Сервис Pricing вернул цену без строки товара");
      return api.putOrderItem(actorRef, current.orderRef, input.itemRef, {
        expectedVersion: current.version,
        productRef: input.product.productRef,
        quantity: input.quantity,
        quoteHash: quote.hash,
        quoteLineNumber: line.lineNumber,
        quoteRef: quote.quoteRef,
        variantRef: input.product.variantRef,
      });
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: orderKey }),
    onSuccess: (next) => storeAcceptedOrderCard(queryClient, next),
  });
}

export function useDeleteOrderItem(actorRef: string, orderRef: string, onAccepted: () => void) {
  const queryClient = useQueryClient();
  const orderKey = queryKeys.orderDetail(orderRef);
  return useMutation({
    mutationFn: (itemRef: string) => {
      const current = queryClient.getQueryData<OrderCardResponse>(orderKey);
      if (!current) throw new ProtocolError("Карточка заказа недоступна");
      return api.deleteOrderItem(actorRef, current.orderRef, itemRef, current.version);
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: orderKey }),
    onSuccess: (next) => {
      storeAcceptedOrderCard(queryClient, next);
      onAccepted();
    },
  });
}

export function useConfirmOrder(actorRef: string, orderRef: string, onAccepted: () => void) {
  const queryClient = useQueryClient();
  const orderKey = queryKeys.orderDetail(orderRef);
  return useMutation({
    mutationFn: () => {
      const current = queryClient.getQueryData<OrderCardResponse>(orderKey);
      if (!current) throw new ProtocolError("Карточка заказа недоступна");
      return api.confirmOrder(actorRef, current.orderRef, current.version);
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: orderKey }),
    onSuccess: (next) => {
      storeAcceptedOrderCard(queryClient, next);
      onAccepted();
    },
  });
}

export function useRequestReconciliation(actorRef: string, orderRef: string, onAccepted: () => void) {
  const queryClient = useQueryClient();
  const orderKey = queryKeys.orderDetail(orderRef);
  return useMutation({
    mutationFn: (reason: string) => {
      const current = queryClient.getQueryData<OrderCardResponse>(orderKey);
      if (!current) throw new ProtocolError("Карточка заказа недоступна");
      return api.requestReconciliation(actorRef, current.orderRef, current.version, reason);
    },
    onMutate: () => queryClient.cancelQueries({ queryKey: orderKey }),
    onSuccess: () => {
      onAccepted();
      void queryClient.invalidateQueries({ exact: true, queryKey: orderKey, refetchType: "active" });
    },
  });
}

export type ReplayResult = CustomerResponse | PricingQuoteResponse | OrderCardResponse | ReconciliationAcceptedResponse;
export type ReplayOutcome = Readonly<{
  orderRef?: string;
  result: ReplayResult;
  verificationError?: unknown;
}>;

export function isCustomerResult(value: ReplayResult): value is CustomerResponse {
  return "customerRef" in value && "displayName" in value && !("orderRef" in value);
}

export function useReplayIntent(actorRef: string) {
  const queryClient = useQueryClient();
  return useMutation<ReplayOutcome, Error, PendingIntent>({
    mutationFn: async (intent) => {
      const result = await api.replayIntent(intent);
      if ("orderRef" in result) {
        try {
          const session = captureApplicationSession(actorRef);
          const latest = await api.getOrderCard(result.orderRef);
          assertApplicationSession(session);
          storeAcceptedOrderCard(queryClient, latest);
        } catch (verificationError) {
          return { orderRef: result.orderRef, result, verificationError };
        }
        return { orderRef: result.orderRef, result };
      }
      return { result };
    },
  });
}
