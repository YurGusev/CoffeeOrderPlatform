import assert from "node:assert/strict";
import test from "node:test";
import { computeOrderContribution } from "../../apps/orders-service/dist/domain/order-contribution.js";
import { buildDesired } from "../../apps/orders-aroma-preparation/dist/domain/desired.js";

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
  assert.throws(
    () =>
      computeOrderContribution([
        item(a.itemRef, a.offerRef, "9223372036854775807"),
        item(b.itemRef, a.offerRef, "1", {
          quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        }),
      ]),
    { code: "ORDER_DESIRED_OVERFLOW" },
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

void test("Desired groups by frozen offer and grind with stable exact provenance", () => {
  const orderA = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const orderB = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const grind = "c".repeat(64);
  const contribution = (order_ref, order_version) => ({
    order_ref,
    contribution_revision: "1",
    order_version,
  });
  const line = (order_ref, itemRef, quantity_milli, source_grind_key_hash) => ({
    order_ref,
    contribution_revision: "1",
    offer_ref: a.offerRef,
    source_grind_key_hash,
    quantity_milli,
    contribution_hash: "a".repeat(64),
    item_refs: [itemRef],
    items: [
      {
        itemRef,
        found: true,
        productRef: a.productRef,
        variantRef: a.variantRef,
        offerRef: a.offerRef,
        grind: source_grind_key_hash,
        quantity: quantity_milli,
        mappingOffer: a.offerRef,
        mappingRevision: "1",
        mappingState: "Active",
        availability: "Available",
      },
    ],
  });
  const contributions = [contribution(orderA, "4"), contribution(orderB, "9")];
  const lines = [
    line(orderA, a.itemRef, "1000", null),
    line(orderB, b.itemRef, "2000", null),
    line(orderA, c.itemRef, "3000", grind),
  ];
  const plan = buildDesired(contributions, lines, 2, 3);
  const reordered = buildDesired(
    [...contributions].reverse(),
    [...lines].reverse(),
    2,
    3,
  );
  assert.equal(plan.hash, reordered.hash);
  assert.equal(plan.sourceMaxOrderVersion, "9");
  assert.deepEqual(
    plan.lines.map(
      ({
        offerRef,
        sourceGrindKeyHash,
        quantityMilli,
        contributingOrderRefs,
      }) => ({
        offerRef,
        sourceGrindKeyHash,
        quantityMilli,
        contributingOrderRefs,
      }),
    ),
    [
      {
        offerRef: a.offerRef,
        sourceGrindKeyHash: null,
        quantityMilli: "3000",
        contributingOrderRefs: [orderA, orderB],
      },
      {
        offerRef: a.offerRef,
        sourceGrindKeyHash: grind,
        quantityMilli: "3000",
        contributingOrderRefs: [orderA],
      },
    ],
  );
  assert.equal(plan.blockers.length, 0);
});

void test("Desired preserves valid mappings and blocks stopped, missing, changed, unavailable and unsupported quantities", () => {
  const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const makeLine = (quantityMilli, mapping = {}) => ({
    order_ref: orderRef,
    contribution_revision: "1",
    offer_ref: a.offerRef,
    source_grind_key_hash: null,
    quantity_milli: quantityMilli,
    contribution_hash: "b".repeat(64),
    item_refs: [itemRef],
    items: [
      {
        itemRef,
        found: true,
        productRef: a.productRef,
        variantRef: a.variantRef,
        offerRef: a.offerRef,
        grind: null,
        quantity: quantityMilli,
        mappingOffer: a.offerRef,
        mappingRevision: "7",
        mappingState: "Active",
        availability: "Available",
        ...mapping,
      },
    ],
  });
  const contribution = [
    {
      order_ref: orderRef,
      contribution_revision: "1",
      order_version: "2",
    },
  ];
  const desired = (line) => buildDesired(contribution, [line], 1, 1);
  assert.equal(desired(makeLine("1000")).lines[0].quantityMilli, "1000");
  for (const [overrides, code] of [
    [{ mappingState: "Stopped", availability: "Stopped" }, "MAPPING_STOPPED"],
    [{ mappingState: null, mappingOffer: null }, "MAPPING_MISSING"],
    [{ mappingOffer: c.offerRef }, "MAPPING_CHANGED"],
    [{ availability: "Unavailable" }, "PRODUCT_UNAVAILABLE"],
  ]) {
    const plan = desired(makeLine("1000", overrides));
    assert.equal(plan.lines.length, 0);
    assert.equal(plan.blockers[0].code, code);
    assert.equal(plan.blockers[0].mappingRevision, "7");
  }
  assert.equal(
    desired(makeLine("1500")).blockers[0].code,
    "AROMA_QUANTITY_NOT_SUPPORTED",
  );
  assert.equal(
    desired(makeLine((BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1000n + ""))
      .blockers[0].code,
    "AROMA_QUANTITY_NOT_SUPPORTED",
  );
  assert.equal(
    desired(makeLine((BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString()))
      .lines[0].quantityMilli,
    (BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString(),
  );
});

void test("Desired rejects malformed contribution proofs, cardinality overflow and int64 group overflow", () => {
  const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const make = (itemRef, quantityMilli) => ({
    order_ref: orderRef,
    contribution_revision: "1",
    offer_ref: a.offerRef,
    source_grind_key_hash: null,
    quantity_milli: quantityMilli,
    contribution_hash: "c".repeat(64),
    item_refs: [itemRef],
    items: [
      {
        itemRef,
        found: true,
        productRef: a.productRef,
        variantRef: a.variantRef,
        offerRef: a.offerRef,
        grind: null,
        quantity: quantityMilli,
        mappingOffer: a.offerRef,
        mappingRevision: "1",
        mappingState: "Active",
        availability: "Available",
      },
    ],
  });
  const contribution = [
    {
      order_ref: orderRef,
      contribution_revision: "1",
      order_version: "2",
    },
  ];
  const line = make("itm_01ARZ3NDEKTSV4RRFFQ69G5FAV", "1000");
  for (const malformed of [
    { ...line, item_refs: [] },
    { ...line, item_refs: [line.item_refs[0], line.item_refs[0]] },
    { ...line, items: [] },
    { ...line, contribution_hash: "not-a-hash" },
    { ...line, items: [{ ...line.items[0], offerRef: c.offerRef }] },
  ])
    assert.throws(() => buildDesired(contribution, [malformed], 1, 1), {
      code: "AROMA_CONTRIBUTION_INVALID",
    });
  assert.throws(() => buildDesired(contribution, [line], 1, 0), {
    code: "AROMA_PREPARATION_CARDINALITY",
  });
  const large = (BigInt(Number.MAX_SAFE_INTEGER) * 1000n).toString();
  assert.throws(
    () =>
      buildDesired(
        contribution,
        [
          make("itm_01ARZ3NDEKTSV4RRFFQ69G5FAV", large),
          make("itm_01ARZ3NDEKTSV4RRFFQ69G5FAW", large),
        ],
        1,
        2,
      ),
    { code: "AROMA_DESIRED_OVERFLOW" },
  );
});
