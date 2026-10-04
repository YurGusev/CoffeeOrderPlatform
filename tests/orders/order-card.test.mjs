import assert from "node:assert/strict";
import test from "node:test";
import {projectOrderCard} from "../../apps/orders-service/dist/domain/order-card.js";
import {nextOrderStatus} from "../../apps/orders-service/dist/domain/order-state.js";
import {isOrderCardResponse} from "../../packages/contracts/orders-v1/dist/index.js";

void test("first-launch state machine is a pure, exhaustive command table", () => {
  const cases = [
    [null, "CreateDraft", "Draft"],
    [null, "UpsertItem", null],
    [null, "DeleteItem", null],
    [null, "Confirm", null],
    [null, "RequestReconciliation", null],
    ["Draft", "CreateDraft", null],
    ["Draft", "UpsertItem", "Draft"],
    ["Draft", "DeleteItem", "Draft"],
    ["Draft", "Confirm", "Confirmed"],
    ["Draft", "RequestReconciliation", null],
    ["Confirmed", "CreateDraft", null],
    ["Confirmed", "UpsertItem", null],
    ["Confirmed", "DeleteItem", null],
    ["Confirmed", "Confirm", null],
    ["Confirmed", "RequestReconciliation", "Confirmed"],
    ["Unknown", "CreateDraft", null],
    ["Unknown", "UpsertItem", null],
    ["Unknown", "DeleteItem", null],
    ["Unknown", "Confirm", null],
    ["Unknown", "RequestReconciliation", null],
  ];
  for (const [from, command, expected] of cases) {
    assert.equal(nextOrderStatus(from, command), expected, `${from} + ${command}`);
  }
});

void test("allowedActions table derives from current permissions, proofs, and first-launch state", () => {
  for (const [status, count, permissions, time, expected] of [
    ["Draft", 0, ["orders:edit:any", "orders:confirm:any"], nowEpochMs, ["edit-items"]],
    ["Draft", 1, [], nowEpochMs, []],
    ["Draft", 1, ["orders:confirm:any"], nowEpochMs, ["confirm"]],
    ["Draft", 1, ["orders:edit:any", "orders:confirm:any"], item().quoteExpiresAtEpochMs, ["edit-items"]],
    ["Confirmed", 1, ["orders:edit:any", "orders:confirm:any", "orders:reconcile:any"], nowEpochMs, []],
    ["Unknown", 1, ["orders:edit:any", "orders:confirm:any"], nowEpochMs, []],
  ]) {
    const card = projectOrderCard({order: order({status}), items: count ? [item()] : [], nowEpochMs: time, permissions});
    assert.deepEqual(card.allowedActions, expected, String(status));
  }
});

const order = (changes = {}) => ({
  orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  version: "2",
  projectionVersion: "5",
  status: "Draft",
  customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAY",
  customerDisplayName: "Иван",
  customerVersion: "1",
  phoneE164: "+79991112233", // A local row must never expose Customer PII.
  ...changes,
});
const item = (changes = {}) => ({
  itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  linePosition: 1,
  productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  displayName: "Кофе",
  quantity: "1.5",
  unit: "piece",
  quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  quoteLineNumber: 1,
  unitMinor: "150",
  lineTotalMinor: "225",
  quoteHash: "a".repeat(64),
  quoteExpiresAt: "2026-09-26T15:00:00Z",
  quoteExpiresAtEpochMs: Date.UTC(2026, 8, 26, 15),
  offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  internalProofHash: "b".repeat(64),
  ...changes,
});
const nowEpochMs = Date.UTC(2026, 8, 26, 14);

void test("empty Draft is owner-only and editing is the only allowed action", () => {
  const card = projectOrderCard({order: order(), items: [], nowEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.equal(card.version, "2");
  assert.equal(card.projectionVersion, "5");
  assert.equal(card.pricing, null);
  assert.deepEqual(card.aroma, {state: "NotRequested", desiredRevision: "0", observedRevision: "0", blockers: []});
  assert.deepEqual(card.allowedActions, ["edit-items"]);
  assert.equal(JSON.stringify(card).includes("phoneE164"), false);
});

void test("Draft uses persisted quote facts for RUB total/proof and only allows valid Confirm", () => {
  const card = projectOrderCard({order: order(), items: [item()], nowEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.equal(card.pricing.totalMinor, "225");
  assert.equal(card.pricing.currency, "RUB");
  assert.deepEqual(card.pricing.quoteProofs, [{quoteRef: item().quoteRef, hash: item().quoteHash, expiresAt: item().quoteExpiresAt}]);
  assert.deepEqual(card.allowedActions, ["edit-items", "confirm"]);
  assert.equal(card.items[0].offerRef, undefined);
  assert.equal(card.items[0].internalProofHash, undefined);
  assert.equal(card.items[0].quoteHash, undefined);
  const expired = projectOrderCard({order: order(), items: [item()], nowEpochMs: item().quoteExpiresAtEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.deepEqual(expired.allowedActions, ["edit-items"]);
});

void test("confirmed card exposes only persisted public AROMA fields and gates reconciliation by state and permission", () => {
  for(const state of ["PendingObservation","Converging","InSync","OutOfSync","Blocked","UnknownOutcome"]){
    const aroma={state,desiredRevision:"8",observedRevision:"9",lastObservedAt:"2026-10-03T00:00:00Z",
      blockers:state==="Blocked"?[{code:"MAPPING_CHANGED",message:"Сопоставление изменилось"}]:[],operationRef:"must-not-leak",desiredHash:"must-not-leak"};
    const card=projectOrderCard({order:order({status:"Confirmed"}),items:[item()],nowEpochMs,permissions:["orders:reconcile:any"],aroma});
    assert.equal(card.aroma.state,state);assert.equal(card.aroma.desiredRevision,"8");assert.equal(card.aroma.observedRevision,"9");
    assert.equal(card.aroma.operationRef,undefined);assert.equal(card.aroma.desiredHash,undefined);
    assert.deepEqual(card.allowedActions,["OutOfSync","Blocked","UnknownOutcome"].includes(state)?["request-aroma-reconciliation"]:[]);
    assert.deepEqual(projectOrderCard({order:order({status:"Confirmed"}),items:[item()],nowEpochMs,permissions:[],aroma}).allowedActions,[]);
    assert.equal(projectOrderCard({order:order(),items:[item()],nowEpochMs,permissions:[],aroma}).aroma.state,"NotRequested");
  }
});

void test("approved stable AROMA blockers validate in the generated public Card contract without exposing proof internals", () => {
  for(const code of ["AROMA_UNKNOWN_OUTCOME","AROMA_WORKER_INTERRUPTED","AROMA_OBSERVATION_UNAVAILABLE","AROMA_OBSERVATION_INVALID","AROMA_EXTERNAL_CHANGE","AROMA_QUANTITY_NOT_SUPPORTED","AROMA_MUTATIONS_DISABLED","AROMA_MAPPING_NOT_AVAILABLE","AROMA_OPERATION_UNKNOWN_OUTCOME","AROMA_VERIFICATION_UNAVAILABLE","AROMA_VERIFICATION_INVALID","AROMA_CART_ITEM_NOT_FOUND"]){
    const card=projectOrderCard({order:order({status:"Confirmed"}),items:[item()],nowEpochMs,permissions:["orders:reconcile:any"],
      aroma:{state:"Blocked",desiredRevision:"8",observedRevision:"9",blockers:[{code,message:"Сходимость корзины требует проверки"}]}});
    assert.equal(isOrderCardResponse(card),true,code);assert.equal(card.aroma.blockers[0].code,code);
  }
});

void test("confirmed card is PendingObservation without an AROMA projection; version and projectionVersion stay separate", () => {
  const card = projectOrderCard({order: order({status: "Confirmed", version: "3", projectionVersion: "9"}), items: [item()], nowEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.equal(card.version, "3");
  assert.equal(card.projectionVersion, "9");
  assert.equal(card.aroma.state, "PendingObservation");
  assert.deepEqual(card.allowedActions, []);
});

void test("current permissions independently gate edit and confirm actions", () => {
  const row = order();
  const lines = [item()];
  const noPermissions = projectOrderCard({order: row, items: lines, nowEpochMs, permissions: []});
  assert.deepEqual(noPermissions.allowedActions, []);
  const editOnly = projectOrderCard({order: row, items: lines, nowEpochMs, permissions: ["orders:edit:any"]});
  assert.deepEqual(editOnly.allowedActions, ["edit-items"]);
  const confirmOnly = projectOrderCard({order: row, items: lines, nowEpochMs, permissions: ["orders:confirm:any"]});
  assert.deepEqual(confirmOnly.allowedActions, ["confirm"]);
});

void test("reconcile permission does not expose recovery action for PendingObservation", () => {
  const card = projectOrderCard({
    order: order({status: "Confirmed"}),
    items: [item()],
    nowEpochMs,
    permissions: ["orders:reconcile:any"],
  });
  assert.equal(card.aroma.state, "PendingObservation");
  assert.deepEqual(card.allowedActions, []);
});

void test("inconsistent persisted facts never grant Confirm or reconciliation", () => {
  const card = projectOrderCard({order: order(), items: [item(), item({linePosition: 2})], nowEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.deepEqual(card.allowedActions, []);
  assert.equal(card.aroma.state, "Blocked");
  assert.deepEqual(card.aroma.blockers.map(blocker => blocker.code), ["ORDER_STATE_INCONSISTENT"]);
  const invalidStatus = projectOrderCard({order: order({status: "Unknown"}), items: [item()], nowEpochMs, permissions: ["orders:edit:any", "orders:confirm:any"]});
  assert.deepEqual(invalidStatus.allowedActions, []);
});
