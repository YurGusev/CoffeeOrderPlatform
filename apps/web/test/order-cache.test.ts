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
  const inSync: OrderCardResponse = { ...card("3"), status: "Confirmed", allowedActions: [], aroma: { ...card("3").aroma, desiredRevision: "1", observedRevision: "1", state: "InSync" } };
  const converging: OrderCardResponse = { ...inSync, aroma: { ...inSync.aroma, state: "Converging" } };
  const outOfSync: OrderCardResponse = { ...inSync, allowedActions: ["request-aroma-reconciliation"], aroma: { ...inSync.aroma, state: "OutOfSync" } };
  const ownerGet = (before: OrderCardResponse, after: OrderCardResponse) => acceptOrderCard(before, after, "owner-get");
  assert.equal(ownerGet(inSync, outOfSync), outOfSync, "read-time freshness expiry may stale a same-version Card");
  assert.equal(ownerGet(inSync, converging), converging, "an active lease can be visible at read time");
  assert.equal(ownerGet(converging, outOfSync), outOfSync, "read-time lease expiry may stale a same-version Card");
  assert.equal(ownerGet(outOfSync, converging), converging, "a read may observe the lease become active again");
  for (const [before, after] of [[inSync, outOfSync], [inSync, converging], [converging, outOfSync], [outOfSync, converging]] as const) {
    assert.throws(() => acceptOrderCard(before, after), OrderCardProtocolError, "command/replay results cannot use owner read-time transitions");
  }
  assert.throws(() => ownerGet(outOfSync, inSync), OrderCardProtocolError, "freshness cannot reverse to InSync without a new projection version");
  assert.throws(() => ownerGet(inSync, { ...inSync, aroma: { ...inSync.aroma, state: "PendingObservation" } }), OrderCardProtocolError, "unrelated state changes remain fatal");
  const blocked: OrderCardResponse = { ...inSync, allowedActions: ["request-aroma-reconciliation"], aroma: { ...inSync.aroma, blockers: [{ code: "MAPPING_MISSING", message: "Mapping is missing" }], state: "Blocked" } };
  const unknown: OrderCardResponse = { ...inSync, allowedActions: ["request-aroma-reconciliation"], aroma: { ...inSync.aroma, blockers: [{ code: "AROMA_UNKNOWN_OUTCOME", message: "Provider outcome is unknown" }], state: "UnknownOutcome" } };
  assert.equal(ownerGet(blocked, unknown), unknown, "the exact UnknownOutcome overlay can take precedence over Blocked");
  assert.equal(ownerGet(unknown, blocked), blocked, "resolving the overlay restores the underlying Blocked state");
  const unknownWithoutMarker: OrderCardResponse = { ...unknown, aroma: { ...unknown.aroma, blockers: [{ code: "AROMA_EXTERNAL_CHANGE", message: "Cart changed outside Orders" }] } };
  const unknownWithMultipleBlockers: OrderCardResponse = { ...unknown, aroma: { ...unknown.aroma, blockers: [...unknown.aroma.blockers, { code: "MAPPING_MISSING", message: "Mapping is missing" }] } };
  assert.throws(() => ownerGet(unknownWithoutMarker, blocked), OrderCardProtocolError, "only the exact UnknownOutcome overlay can justify an exit transition");
  assert.throws(() => ownerGet(unknownWithMultipleBlockers, outOfSync), OrderCardProtocolError, "a multi-blocker UnknownOutcome snapshot is not an overlay witness");
  assert.equal(ownerGet(unknownWithMultipleBlockers, unknown), unknown, "a current GET may enter the exact overlay from a stored UnknownOutcome snapshot");
  const draftUnknown: OrderCardResponse = { ...card("3"), aroma: { ...card("3").aroma, blockers: [{ code: "AROMA_UNKNOWN_OUTCOME", message: "Provider outcome is unknown" }], state: "UnknownOutcome" } };
  assert.throws(() => ownerGet(card("3"), draftUnknown), OrderCardProtocolError, "read-time state transitions are limited to Confirmed Cards");
  for (const state of ["PendingObservation", "Converging", "OutOfSync", "Blocked", "UnknownOutcome"] as const) {
    const blockers = state === "UnknownOutcome"
      ? [{ code: "AROMA_EXTERNAL_CHANGE", message: "Cart changed outside Orders" }]
      : state === "Blocked" ? [{ code: "MAPPING_MISSING", message: "Mapping is missing" }] : [];
    const allowedActions = ["OutOfSync", "Blocked", "UnknownOutcome"].includes(state) ? ["request-aroma-reconciliation"] as const : [] as const;
    const resolved: OrderCardResponse = { ...inSync, allowedActions, aroma: { ...inSync.aroma, blockers, state } };
    assert.equal(ownerGet(unknown, resolved), resolved, `UnknownOutcome may resolve to ${state} from a current owner GET`);
  }
  assert.throws(() => acceptOrderCard(blocked, unknown), OrderCardProtocolError, "commands cannot enter the read-time UnknownOutcome overlay");
  assert.throws(() => acceptOrderCard(unknown, blocked), OrderCardProtocolError, "commands cannot use the read-time UnknownOutcome overlay to change a snapshot");
  assert.throws(() => ownerGet(inSync, { ...unknown, aroma: { ...unknown.aroma, blockers: [{ code: "AROMA_UNKNOWN_OUTCOME", message: "Provider outcome is unknown" }, { code: "MAPPING_MISSING", message: "Mapping is missing" }] } }), OrderCardProtocolError, "UnknownOutcome entry requires the exact singleton marker");
  assert.throws(() => ownerGet(inSync, { ...inSync, aroma: { ...inSync.aroma, state: "OutOfSync", blockers: [{ code: "AROMA_EXTERNAL_CHANGE", message: "Cart changed outside Orders" }] } }), OrderCardProtocolError, "ordinary freshness transitions cannot hide blocker changes");
  assert.throws(() => ownerGet(outOfSync, { ...outOfSync, aroma: { ...outOfSync.aroma, blockers: [{ code: "AROMA_EXTERNAL_CHANGE", message: "Cart changed outside Orders" }] } }), OrderCardProtocolError, "arbitrary blocker changes remain fatal without an overlay transition");
  assert.throws(() => ownerGet(inSync, { ...outOfSync, aroma: { ...outOfSync.aroma, desiredRevision: "2" } }), OrderCardProtocolError, "same-version state changes cannot hide a Desired revision change");
  assert.throws(() => ownerGet(inSync, { ...outOfSync, aroma: { ...outOfSync.aroma, observedRevision: "2" } }), OrderCardProtocolError, "same-version state changes cannot hide an Observed revision change");
  assert.throws(() => ownerGet(inSync, { ...outOfSync, aroma: { ...outOfSync.aroma, lastObservedAt: "2026-10-14T00:00:00.000Z" } }), OrderCardProtocolError, "same-version state changes cannot hide a read-time fact change");
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
