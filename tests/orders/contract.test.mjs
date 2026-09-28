import test from "node:test";
import assert from "node:assert/strict";
import {
  isIfMatchVersion,
  isItemRef,
  isOrderCardResponse,
  isOrderConfirmRequest,
  isOrderDraftCreateRequest,
  isOrderItemPutRequest,
  isOrderRef,
  isOrdersIdempotencyKey,
  isOrdersProblem,
  isOrdersReplayOnly,
  isProductRef,
  isQuoteRef,
  isReconciliationAcceptedResponse,
  isReconciliationRequest,
  isVariantRef,
} from "../../packages/contracts/orders-v1/dist/index.js";

const refs = {
  customer: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  order: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  item: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  product: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  variant: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  quote: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

void test("validates all Orders command bodies with closed object shapes", () => {
  assert.equal(isOrderDraftCreateRequest({customerRef: refs.customer}), true);
  assert.equal(isOrderItemPutRequest({
    expectedVersion: "1", productRef: refs.product, variantRef: refs.variant,
    quantity: "2", quoteRef: refs.quote, quoteLineNumber: 1, quoteHash: "a".repeat(64),
  }), true);
  assert.equal(isOrderConfirmRequest({expectedVersion: "1"}), true);
  assert.equal(isReconciliationRequest({expectedVersion: "1", reason: "operator requested"}), true);
  assert.equal(isOrderDraftCreateRequest({customerRef: refs.customer, unexpected: true}), false);
  assert.equal(isOrderItemPutRequest({
    expectedVersion: "1", productRef: refs.product, variantRef: refs.variant,
    quantity: "2", quoteRef: refs.quote, quoteLineNumber: 1, quoteHash: "a".repeat(64), providerProof: "secret",
  }), false);
  assert.equal(isOrderConfirmRequest({expectedVersion: "1", status: "Confirmed"}), false);
  assert.equal(isReconciliationRequest({expectedVersion: "1", reason: "ok", providerToken: "secret"}), false);
});

void test("validates exact OrderCardResponse and rejects private proof fields", () => {
  const card = {
    orderRef: refs.order, version: "2", projectionVersion: "2", status: "Draft",
    customer: {customerRef: refs.customer, displayName: "Ada"}, items: [], pricing: null,
    aroma: {state: "NotRequested", desiredRevision: "0", observedRevision: "0", blockers: []},
    allowedActions: ["edit-items", "confirm"],
  };
  assert.equal(isOrderCardResponse(card), true);
  assert.equal(isOrderCardResponse({...card, internalProof: {token: "secret"}}), false);
  assert.equal(isOrderCardResponse({...card, pricing: {totalMinor: "0", currency: "RUB", quoteProofs: [], providerProof: "secret"}}), false);
  assert.equal(isOrderCardResponse({...card, aroma: {...card.aroma, blockers: [{code: "MAPPING_MISSING", message: "missing", privateProof: "secret"}]}}), false);
});

void test("validates reconciliation response, RFC 9457 problem, refs and command headers", () => {
  assert.equal(isReconciliationAcceptedResponse({
    orderRef: refs.order, orderVersion: "2", requestedAt: "2026-09-26T10:00:00Z", aromaState: "PendingObservation",
  }), true);
  assert.equal(isReconciliationAcceptedResponse({
    orderRef: refs.order, orderVersion: "2", requestedAt: "2026-09-26T10:00:00Z", aromaState: "PendingObservation", proof: "secret",
  }), false);
  assert.equal(isOrdersProblem({
    type: "about:blank", title: "Invalid request", status: 400, code: "VALIDATION_FAILED",
    detail: "Request validation failed", instance: "/orders", correlationId: "123e4567-e89b-12d3-a456-426614174000", errors: [],
  }), true);
  assert.equal(isOrderRef(refs.order), true);
  assert.equal(isItemRef(refs.item), true);
  assert.equal(isQuoteRef(refs.quote), true);
  assert.equal(isProductRef(refs.product), true);
  assert.equal(isVariantRef(refs.variant), true);
  assert.equal(isOrderRef("ord_bad"), false);
  assert.equal(isOrdersIdempotencyKey("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isOrdersIdempotencyKey("not-a-uuid"), false);
  assert.equal(isIfMatchVersion("0"), true);
  assert.equal(isIfMatchVersion("01"), false);
  assert.equal(isOrdersReplayOnly(true), true);
  assert.equal(isOrdersReplayOnly(false), false);
});
