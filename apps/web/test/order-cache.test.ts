import assert from "node:assert/strict";
import type { OrderCardResponse } from "@coffee-platform/generated-client-v1";
import { QueryClient } from "@tanstack/react-query";
import { test } from "vitest";
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
  assert.throws(() => acceptOrderCard(current, { ...card("3"), status: "Confirmed" }), OrderCardProtocolError);
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

test("query keys match the normative route state", () => {
  assert.deepEqual(queryKeys.customersSearch({ q: "иван", cursor: "next" }), ["customers", "search", { q: "иван", cursor: "next", limit: 20 }]);
  assert.deepEqual(queryKeys.catalogSearch({ orderRef: card("1").orderRef, q: "кофе", availability: "Available" }), [
    "catalog",
    "search",
    { orderRef: card("1").orderRef, q: "кофе", availability: "Available", limit: 20 },
  ]);
  assert.deepEqual(queryKeys.orderDetail(card("1").orderRef), ["orders", "detail", card("1").orderRef]);
});
