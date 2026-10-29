import assert from "node:assert/strict";
import test from "node:test";
import { computeOrderContribution } from "../../apps/orders-service/dist/domain/order-contribution.js";

const item = (itemRef, offerRef, quantityMilli, overrides = {}) => ({
  itemRef,
  offerRef,
  quantityMilli,
  productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  quoteLineNumber: 1,
  ...overrides,
});
const a = item(
  "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "1500",
);
const b = item("itm_01ARZ3NDEKTSV4RRFFQ69G5FAW", a.offerRef, "2500", {
  quoteLineNumber: 2,
});
const c = item(
  "itm_01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "off_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "1000",
  { quoteLineNumber: 3 },
);

void test("contribution groups frozen offers and hashes persisted facts independent of item order", () => {
  const first = computeOrderContribution([c, b, a]);
  const second = computeOrderContribution([a, c, b]);
  assert.deepEqual(first, second);
  assert.equal(first.lines.length, 2);
  assert.equal(first.lines[0].offerRef, a.offerRef);
  assert.equal(first.lines[0].quantityMilli, "4000");
  assert.deepEqual(first.lines[0].itemRefs, [a.itemRef, b.itemRef]);
  assert.match(first.lines[0].contributionHash, /^[0-9a-f]{64}$/u);
  assert.match(first.hash, /^[0-9a-f]{64}$/u);
  assert.notEqual(
    computeOrderContribution([a, { ...b, quantityMilli: "2501" }, c]).hash,
    first.hash,
  );
});

void test("contribution rejects bad persisted proof, duplicate items, and signed bigint overflow", () => {
  assert.throws(() => computeOrderContribution([]));
  assert.throws(() => computeOrderContribution([a, a]));
  assert.throws(() =>
    computeOrderContribution([item(a.itemRef, a.offerRef, "0")]),
  );
  assert.throws(() =>
    computeOrderContribution([item(a.itemRef, a.offerRef, "01")]),
  );
  assert.throws(() =>
    computeOrderContribution([
      item(a.itemRef, a.offerRef, "9223372036854775808"),
    ]),
  );
  assert.throws(() =>
    computeOrderContribution([
      item(a.itemRef, a.offerRef, "9223372036854775807"),
      item(b.itemRef, a.offerRef, "1"),
    ]),
  );
});

void test("contribution refuses one persisted quote line under two distinct item refs", () => {
  assert.throws(
    () =>
      computeOrderContribution([
        a,
        { ...b, quoteLineNumber: a.quoteLineNumber },
      ]),
    { code: "ORDER_STATE_INCONSISTENT" },
  );
});

void test("physical contribution separates grind choices from the unselected line", () => {
  const first = "a".repeat(64),
    second = "b".repeat(64);
  const lines = computeOrderContribution([
    a,
    { ...b, sourceGrindKeyHash: first },
    { ...c, offerRef: a.offerRef, sourceGrindKeyHash: second },
  ]).lines;
  assert.deepEqual(
    lines.map((line) => [
      line.offerRef,
      line.sourceGrindKeyHash,
      line.quantityMilli,
    ]),
    [
      [a.offerRef, undefined, "1500"],
      [a.offerRef, first, "2500"],
      [a.offerRef, second, "1000"],
    ],
  );
  assert.notEqual(
    computeOrderContribution([a]).hash,
    computeOrderContribution([{ ...a, sourceGrindKeyHash: first }]).hash,
  );
});
