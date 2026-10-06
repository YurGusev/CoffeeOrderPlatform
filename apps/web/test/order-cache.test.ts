import assert from "node:assert/strict";
import type { OrderCardResponse } from "@coffee-platform/generated-client-v1";
import { QueryClient } from "@tanstack/react-query";
import { test } from "vitest";
import { ApiError } from "../src/browser/api/client.js";
import { acceptOrderCard, OrderCardProtocolError, storeAcceptedOrderCard } from "../src/browser/api/order-card.js";
import { queryKeys } from "../src/browser/app/query-keys.js";

function card(projectionVersion: string, version = projectionVersion): OrderCardResponse {
  return {
    allowedActions: ["edit-items", "confirm"],
    aroma: { blockers: [], desiredRevision: "0", observedRevision: "0", state: "NotRequested" },
    customer: { customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV", displayName: "Иван Петров" },
    items: [],
    orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    pricing: null,
    projectionVersion,
    status: "Draft",
    version,
  };
}

test("order cache rejects stale and divergent equal-version cards", () => {
  const current = card("3");
  assert.equal(acceptOrderCard(current, card("2")), current);
  assert.equal(acceptOrderCard(current, card("3")), current);
  const expiredQuote = { ...card("3"), allowedActions: ["edit-items"] as const };
  assert.equal(acceptOrderCard(current, expiredQuote), expiredQuote);
  assert.throws(() => acceptOrderCard(current, { ...card("3"), status: "Confirmed" }), OrderCardProtocolError);
  assert.throws(() => acceptOrderCard(current, { ...expiredQuote, version: "4" }), OrderCardProtocolError);
  const newer = card("4");
  assert.equal(acceptOrderCard(current, newer), newer);
});

test("storeAcceptedOrderCard never rolls the cache back", () => {
  const client = new QueryClient();
  const newest = card("5");
  storeAcceptedOrderCard(client, newest);
  storeAcceptedOrderCard(client, card("4"));
  assert.equal(client.getQueryData(queryKeys.orderDetail(newest.orderRef)), newest);
});

test("fatal exact Order reads keep delayed mutation results out until a successful read", async () => {
  for (const status of [403, 404] as const) {
    const client = new QueryClient();
    const current = card("2");
    const key = queryKeys.orderDetail(current.orderRef);
    client.setQueryData(key, current);
    const fatal = new ApiError({
      type: "about:blank",
      title: status === 403 ? "Forbidden" : "Not found",
      status,
      code: status === 403 ? "AUTHORIZATION_FORBIDDEN" : "ORDER_NOT_FOUND",
      detail: "Order is unavailable",
      instance: `/api/client-v1/orders/${current.orderRef}`,
      correlationId: "00000000-0000-4000-8000-000000000001",
      errors: [],
    }, false, false);
    await assert.rejects(client.fetchQuery({ queryKey: key, queryFn: async () => { throw fatal; }, retry: false }));

    const delayedMutationResult = card("3");
    assert.equal(storeAcceptedOrderCard(client, delayedMutationResult), current);
    assert.equal(client.getQueryData(key), current);
    assert.equal(client.getQueryState(key)?.error, fatal);

    const fresh = card("4");
    await client.fetchQuery({ queryKey: key, queryFn: async () => fresh, retry: false });
    assert.equal(client.getQueryState(key)?.error, null);
    assert.deepEqual(storeAcceptedOrderCard(client, delayedMutationResult), fresh);
    assert.deepEqual(client.getQueryData(key), fresh, "a late result cannot roll back the successful owner read");
    client.clear();
  }
});

test("query keys match the normative route state", () => {
  assert.deepEqual(queryKeys.customersSearch({ q: "иван", cursor: "next" }), ["customers", "search", { q: "иван", cursor: "next", limit: 20 }]);
  assert.deepEqual(queryKeys.catalogSearch({ orderRef: card("1").orderRef, q: "кофе", availability: "Available" }), [
    "catalog",
    "search",
    { orderRef: card("1").orderRef, q: "кофе", availability: "Available", limit: 20 },
  ]);
  assert.deepEqual(queryKeys.orderDetail(card("1").orderRef), ["orders", "detail", card("1").orderRef]);
});
