import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  aromaContractSchemas,
  isAromaCartSnapshot,
  isAromaOwnerMessage,
  normalizeAromaCartSnapshot,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  firstCartDifference,
  providerQuantity,
  reconcileReservation,
} from "../../apps/aroma-convergence/dist/cart-plan.js";

const offerRef = "off_00000000000000000000000001";
const anotherOffer = "off_00000000000000000000000002";
const first = "a".repeat(64),
  second = "b".repeat(64);
const line = (quantityMilli, sourceGrindKeyHash, offer = offerRef) => ({
  offerRef: offer,
  quantityMilli,
  ...(sourceGrindKeyHash === undefined ? {} : { sourceGrindKeyHash }),
});

void test("bundled owner validators cover canonical seven envelopes and reject malformed source without repair", async () => {
  for (const name of [
    "order-confirmed.v1",
    "order-reconciliation-requested.v1",
    "catalog-mapping-changed.v2",
    "aroma-convergence-requested.v1",
    "aroma-observation-changed.v1",
    "aroma-convergence-changed.v1",
    "realtime-invalidated.v1",
  ]) {
    const envelope = JSON.parse(
      await readFile(
        new URL(
          `../../contracts/fixtures/positive/events/${name}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(isAromaOwnerMessage(envelope), true, name);
    assert.equal(
      isAromaOwnerMessage({ ...envelope, producer: "unsupported-runtime" }),
      false,
      name,
    );
    assert.equal(
      isAromaOwnerMessage({ ...envelope, messageId: "msg_invalid" }),
      false,
      name,
    );
    assert.equal(
      isAromaOwnerMessage({ ...envelope, unexpected: true }),
      false,
      name,
    );
    assert.equal(
      isAromaOwnerMessage({
        ...envelope,
        payload: { ...envelope.payload, unexpected: true },
      }),
      false,
      name,
    );
  }
  const unsupported = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/fixtures/positive/events/catalog-snapshot-activated.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(isAromaOwnerMessage(unsupported), false);
});

void test("first cart diff keys offer, absence then selected grind and removes only the matching line", () => {
  const observed = [line("1000", second), line("1000", first), line("1000")];
  const desired = [line("2000", second), line("1000", first)];
  assert.deepEqual(firstCartDifference(desired, observed), {
    offerRef,
    quantityMilli: "0",
    observedBeforeMilli: "1000",
    action: "Remove",
  });
  assert.deepEqual(
    firstCartDifference([line("1000"), line("2000", first)], observed),
    {
      ...line("2000", first),
      observedBeforeMilli: "1000",
      providerQuantity: "2",
      action: "SetQuantity",
    },
  );
  assert.equal(
    firstCartDifference([line("1000", first)], [line("1000", first)]),
    null,
  );
  assert.equal(
    firstCartDifference(
      [line("1000", first, anotherOffer)],
      [line("1000", first, anotherOffer)],
    ),
    null,
  );
  assert.throws(
    () => firstCartDifference([line("1000", first), line("2000", first)], []),
    /AROMA_CART_LINE_INVALID/u,
  );
});

void test("provider quantity requires exact positive whole units and a safe JS integer", () => {
  assert.equal(providerQuantity("2000"), "2");
  for (const invalid of [
    "0",
    "1",
    "1500",
    "2001",
    "-1000",
    "01",
    "9007199254740992000",
    "9223372036854775808",
  ])
    assert.throws(
      () => providerQuantity(invalid),
      /AROMA_QUANTITY_NOT_SUPPORTED/u,
    );
  assert.throws(
    () => firstCartDifference([line("1500")], []),
    /AROMA_QUANTITY_NOT_SUPPORTED/u,
  );
  assert.throws(
    () =>
      firstCartDifference([line("1500", first, anotherOffer)], [line("1000")]),
    /AROMA_QUANTITY_NOT_SUPPORTED/u,
  );
});

void test("unknown reservation result reconciles by exact key and fresh complete snapshot", () => {
  const reserved = { ...line("2000", first), observedBeforeMilli: "1000" };
  const before = [line("1000", second), line("1000", first)];
  assert.equal(
    reconcileReservation(reserved, before, [
      line("1000", second),
      line("2000", first),
    ]),
    "RecoveredApplied",
  );
  assert.equal(
    reconcileReservation(reserved, before, before),
    "RecoveredNotApplied",
  );
  assert.equal(
    reconcileReservation(reserved, before, [
      line("1000", second),
      line("3000", first),
    ]),
    "AROMA_EXTERNAL_CHANGE",
  );
  assert.equal(
    reconcileReservation(reserved, before, [
      line("2000", second),
      line("2000", first),
    ]),
    "AROMA_EXTERNAL_CHANGE",
  );
  assert.equal(
    reconcileReservation(reserved, before, []),
    "AROMA_EXTERNAL_CHANGE",
  );
  assert.throws(
    () =>
      reconcileReservation(
        reserved,
        [line("2000", first)],
        [line("2000", first)],
      ),
    /AROMA_RESERVATION_INVALID/u,
  );
});

void test("snapshot validator preserves canonical uniqueItems semantics and handles 10000 closed line objects within the Attempt budget", () => {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
  });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value) => {
      try {
        Temporal.Instant.from(value);
        return true;
      } catch {
        return false;
      }
    },
  });
  const reference = ajv.compile(aromaContractSchemas.cartSnapshot);
  const lines = [
    { offerRef, quantity: "1" },
    { offerRef: anotherOffer, quantity: "2", sourceGrindKeyHash: first },
  ];
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: "fixture-ref",
    capturedAt: "2026-10-03T00:00:00Z",
    cartFingerprint: "a".repeat(64),
    lines,
  };
  for (const value of [
    snapshot,
    { ...snapshot, lines: [lines[0], { quantity: "1", offerRef }] },
    { ...snapshot, lines: [lines[0], { ...lines[0], quantity: "1.0" }] },
    { ...snapshot, lines: [lines[0], { ...lines[0], quantity: "2" }] },
    {
      ...snapshot,
      lines: [lines[0], { ...lines[0], sourceGrindKeyHash: first }],
    },
    { ...snapshot, lines: [{ ...lines[0], sourceGrindKeyHash: null }] },
    { ...snapshot, lines: [{ ...lines[0], unexpected: true }] },
    { ...snapshot, lines: [{ offerRef, quantity: "-1" }] },
    { ...snapshot, extra: true },
  ]) {
    assert.equal(
      isAromaCartSnapshot(value),
      reference(value),
      JSON.stringify(value),
    );
  }
  const large = {
    ...snapshot,
    lines: Array.from({ length: 10000 }, (_, i) => ({
      offerRef: `off_${String(i + 1).padStart(26, "0")}`,
      quantity: "1",
    })),
  };
  const started = performance.now();
  assert.equal(isAromaCartSnapshot(large), true);
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed <= 500,
    `schema validation ${elapsed}ms exceeds complete local Attempt budget`,
  );
  assert.equal(
    isAromaCartSnapshot({ ...large, lines: [...large.lines, large.lines[0]] }),
    false,
  );
  assert.equal(
    isAromaCartSnapshot({
      ...large,
      lines: [
        ...large.lines.slice(0, -1),
        { quantity: "1", offerRef: large.lines[0].offerRef },
      ],
    }),
    false,
  );
});

void test("snapshot decimal normalization preserves exact milli and the original wire quantities", () => {
  const lines = [
    { offerRef, quantity: "1.001" },
    { offerRef, quantity: "2.00", sourceGrindKeyHash: first },
    { offerRef, quantity: "3.125", sourceGrindKeyHash: second },
    { offerRef: anotherOffer, quantity: "0.001" },
  ];
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"d".repeat(64)}`,
    capturedAt: "2026-10-03T00:00:00Z",
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(lines))
      .digest("hex"),
    lines: [...lines].reverse(),
  };
  assert.equal(isAromaCartSnapshot(snapshot), true);
  const normalized = normalizeAromaCartSnapshot(snapshot);
  assert.deepEqual(
    normalized.lines.map(({ quantityMilli }) => quantityMilli),
    ["1001", "2000", "3125", "1"],
  );
  assert.strictEqual(normalized.snapshot, snapshot);
  assert.deepEqual(
    normalized.snapshot.lines.map(({ quantity }) => quantity),
    ["0.001", "3.125", "2.00", "1.001"],
  );
});

void test("snapshot normalization verifies sanitized wire fingerprint and preserves every nullable grind key", () => {
  const hash = (value) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const lines = [
    { offerRef, quantity: "1" },
    { offerRef, quantity: "2", sourceGrindKeyHash: first },
    { offerRef, quantity: "3", sourceGrindKeyHash: second },
  ];
  const snapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"d".repeat(64)}`,
    capturedAt: "2026-10-01T12:00:00Z",
    cartFingerprint: hash(lines),
    lines: [...lines].reverse(),
  };
  const normalized = normalizeAromaCartSnapshot(snapshot);
  assert.equal(normalized.snapshot.capturedAt, snapshot.capturedAt);
  assert.deepEqual(
    normalized.lines.map(({ sanitizedLineHash, ...facts }) => {
      assert.match(sanitizedLineHash, /^[0-9a-f]{64}$/u);
      return facts;
    }),
    [line("1000"), line("2000", first), line("3000", second)],
  );
  assert.equal(
    normalizeAromaCartSnapshot({
      ...snapshot,
      lines: [],
      cartFingerprint: hash([]),
    }).lines.length,
    0,
  );
  for (const invalid of [
    { ...snapshot, cartFingerprint: "e".repeat(64) },
    {
      ...snapshot,
      lines: [lines[0], lines[0]],
      cartFingerprint: hash([lines[0], lines[0]]),
    },
    { ...snapshot, providerSnapshotRef: "raw-provider-ref" },
    { ...snapshot, complete: false },
    {
      ...snapshot,
      lines: [{ offerRef, quantity: "9007199254740992" }],
      cartFingerprint: hash([{ offerRef, quantity: "9007199254740992" }]),
    },
    {
      ...snapshot,
      lines: [{ offerRef, quantity: "9223372036854776" }],
      cartFingerprint: hash([{ offerRef, quantity: "9223372036854776" }]),
    },
    {
      ...snapshot,
      lines: [{ offerRef, quantity: "1", sourceGrindKeyHash: null }],
    },
  ])
    assert.throws(
      () => normalizeAromaCartSnapshot(invalid),
      /AROMA_OBSERVATION_INVALID/u,
    );
});
