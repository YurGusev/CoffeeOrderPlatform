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
import { decodeAromaPreparationEnvelope } from "../../apps/orders-aroma-preparation/dist/application/messages.js";
import { decodeAromaConvergenceEnvelope } from "../../apps/aroma-convergence/dist/application/messages.js";
import { projectAromaCard } from "../../apps/orders-aroma-preparation/dist/domain/projection.js";

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
  for (const invalid of [
    line("1000", undefined, "off_invalid"),
    line("1000", "not-a-grind-hash"),
  ])
    assert.throws(
      () => firstCartDifference([invalid], []),
      /AROMA_LINE_KEY_INVALID/u,
    );

  const overCapacity = Array.from({ length: 10_001 }, (_, index) =>
    line("1000", undefined, `off_${String(index + 1).padStart(26, "0")}`),
  );
  assert.throws(
    () => firstCartDifference(overCapacity, []),
    /AROMA_CART_CAPACITY_EXCEEDED/u,
  );

  assert.equal(
    firstCartDifference([line("2000", first)], [line("1000", first)], true),
    null,
  );
  assert.deepEqual(
    firstCartDifference(
      [line("1000", second), line("1000", first)],
      [
        line("2000", second),
        line("3000", first),
        line("1000", undefined, anotherOffer),
      ],
      true,
    ),
    {
      ...line("1000", first),
      observedBeforeMilli: "3000",
      providerQuantity: "1",
      action: "SetQuantity",
    },
  );
  assert.deepEqual(firstCartDifference([], [line("1000", first)], true), {
    offerRef,
    sourceGrindKeyHash: first,
    quantityMilli: "0",
    observedBeforeMilli: "1000",
    action: "Remove",
  });
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

void test("preparation decoder binds aggregate identity and canonical revisions", async () => {
  const fixture = async (name) =>
    JSON.parse(
      await readFile(
        new URL(
          `../../contracts/fixtures/positive/events/${name}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const mapping = await fixture("catalog-mapping-changed.v2");
  const validMapping = {
    ...mapping,
    aggregate: { ...mapping.aggregate, version: "17" },
    payload: { ...mapping.payload, mappingRevision: "0" },
  };
  assert.equal(decodeAromaPreparationEnvelope(validMapping), validMapping);
  for (const invalid of [
    {
      ...validMapping,
      aggregate: { ...validMapping.aggregate, ref: anotherOffer },
    },
    {
      ...validMapping,
      aggregate: { ...validMapping.aggregate, type: "Order" },
    },
    {
      ...validMapping,
      aggregate: { ...validMapping.aggregate, version: "01" },
    },
    {
      ...validMapping,
      aggregate: { ...validMapping.aggregate, version: "9223372036854775808" },
    },
    {
      ...validMapping,
      payload: { ...validMapping.payload, mappingRevision: "01" },
    },
    {
      ...validMapping,
      payload: {
        ...validMapping.payload,
        mappingRevision: "9223372036854775808",
      },
    },
  ])
    assert.throws(
      () => decodeAromaPreparationEnvelope(invalid),
      /AROMA_PREPARATION_ENVELOPE_INVALID/u,
    );

  const orderConfirmed = await fixture("order-confirmed.v1");
  assert.equal(decodeAromaPreparationEnvelope(orderConfirmed), orderConfirmed);
  assert.throws(
    () =>
      decodeAromaPreparationEnvelope({
        ...orderConfirmed,
        aggregate: { ...orderConfirmed.aggregate, version: "3" },
      }),
    /AROMA_PREPARATION_ENVELOPE_INVALID/u,
  );

  const reconciliation = await fixture("order-reconciliation-requested.v1");
  assert.equal(decodeAromaPreparationEnvelope(reconciliation), reconciliation);
  assert.throws(
    () =>
      decodeAromaPreparationEnvelope({
        ...reconciliation,
        payload: { ...reconciliation.payload, orderRef: anotherOffer },
      }),
    /AROMA_PREPARATION_ENVELOPE_INVALID/u,
  );

  const observation = await fixture("aroma-observation-changed.v1");
  assert.equal(decodeAromaPreparationEnvelope(observation), observation);
  assert.throws(
    () =>
      decodeAromaPreparationEnvelope({
        ...observation,
        aggregate: { ...observation.aggregate, version: "4" },
      }),
    /AROMA_PREPARATION_ENVELOPE_INVALID/u,
  );

  const convergence = await fixture("aroma-convergence-changed.v1");
  assert.equal(decodeAromaPreparationEnvelope(convergence), convergence);
  assert.throws(
    () =>
      decodeAromaPreparationEnvelope({
        ...convergence,
        payload: {
          ...convergence.payload,
          desiredRevision: "9223372036854775808",
        },
      }),
    /AROMA_PREPARATION_ENVELOPE_INVALID/u,
  );
});

void test("convergence decoder binds wake-up scope and accepts only its command type", async () => {
  const envelope = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/fixtures/positive/events/aroma-convergence-requested.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.strictEqual(decodeAromaConvergenceEnvelope(envelope), envelope);
  assert.throws(
    () =>
      decodeAromaConvergenceEnvelope({
        ...envelope,
        aggregate: { ...envelope.aggregate, ref: "aroma-secondary" },
      }),
    /AROMA_CONVERGENCE_KEY_INVALID/u,
  );

  const otherOwnerMessage = JSON.parse(
    await readFile(
      new URL(
        "../../contracts/fixtures/positive/events/aroma-observation-changed.v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(isAromaOwnerMessage(otherOwnerMessage), true);
  assert.throws(
    () => decodeAromaConvergenceEnvelope(otherOwnerMessage),
    /AROMA_CONVERGENCE_ENVELOPE_INVALID/u,
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

  const removal = {
    offerRef,
    sourceGrindKeyHash: first,
    quantityMilli: "0",
    observedBeforeMilli: "1000",
  };
  const beforeRemoval = [line("1000", first), line("2000", second)];
  assert.equal(
    reconcileReservation(removal, beforeRemoval, [line("2000", second)]),
    "RecoveredApplied",
    "the selected grind key may be absent while its sibling remains",
  );
  assert.equal(
    reconcileReservation(removal, beforeRemoval, beforeRemoval),
    "RecoveredNotApplied",
    "an unchanged selected key means the removal was not applied",
  );
  assert.equal(
    reconcileReservation(removal, beforeRemoval, [
      line("2000", first),
      line("2000", second),
    ]),
    "AROMA_EXTERNAL_CHANGE",
    "a changed selected key is not proof of removal",
  );
  assert.equal(
    reconcileReservation(removal, beforeRemoval, [
      line("1000", first),
      line("3000", second),
    ]),
    "AROMA_EXTERNAL_CHANGE",
    "a sibling change prevents attributing the snapshot to this removal",
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

void test("preparation Card requires current terminal proof and preserves state precedence", () => {
  const orderRef = "ord_00000000000000000000000001";
  const sourceMessageId = "msg_00000000000000000000000001";
  const desired = { desired_revision: "3", desired_hash: first };
  const observed = {
    observed_revision: "7",
    cart_fingerprint: second,
    captured_at: "2026-10-26T00:00:00.000Z",
    fresh: true,
  };
  const attempt = {
    attempt_ref: "att_00000000000000000000000001",
    desired_revision: "3",
    desired_hash: first,
    fence_epoch: "2",
    owner_instance_id: "11111111-1111-4111-8111-111111111111",
    state: "VerifiedInSync",
    observed_start_revision: "6",
    observed_end_revision: "7",
    failure_code: null,
    blocker_codes: [],
  };
  const plan = {
    hash: first,
    sourceMaxOrderVersion: "5",
    lines: [],
    blockers: [],
    orders: [{ orderRef, contributionRevision: "1", contributionHash: first }],
  };
  const facts = {
    desired,
    observed,
    attempt,
    fence_epoch: attempt.fence_epoch,
    owner_instance_id: attempt.owner_instance_id,
    lease_active: false,
    unresolved: false,
    unknown: false,
    exactLines: true,
  };
  const card = (changes = {}, planChanges = {}) =>
    projectAromaCard(
      orderRef,
      { ...plan, ...planChanges },
      { ...facts, ...changes },
      sourceMessageId,
    );
  for (const terminalAttempt of [
    attempt,
    {
      ...attempt,
      state: "NoOpInSync",
      observed_start_revision: "7",
      observed_end_revision: null,
    },
  ]) {
    assert.deepEqual(card({ attempt: terminalAttempt }), {
      order_ref: orderRef,
      cart_scope_ref: "aroma-primary",
      desired_revision: "3",
      desired_hash: first,
      observed_revision: "7",
      observed_cart_fingerprint: second,
      verified_desired_revision: "3",
      verified_desired_hash: first,
      verified_observed_revision: "7",
      verified_cart_fingerprint: second,
      attempt_ref: attempt.attempt_ref,
      verified_attempt_ref: attempt.attempt_ref,
      fence_epoch: "2",
      state: "InSync",
      blocker_codes: [],
      last_observed_at: observed.captured_at,
      source_message_id: sourceMessageId,
    });
  }
  const blocker = {
    orderRef,
    productRef: "prd_00000000000000000000000001",
    variantRef: "var_00000000000000000000000001",
    code: "MAPPING_MISSING",
    mappingRevision: null,
  };
  const cases = [
    [
      "PendingObservation",
      { observed: undefined, unknown: true, lease_active: true },
      { blockers: [blocker] },
      ["MAPPING_MISSING"],
    ],
    [
      "UnknownOutcome",
      { unknown: true, lease_active: true },
      { blockers: [blocker, blocker] },
      ["AROMA_UNKNOWN_OUTCOME", "MAPPING_MISSING"],
    ],
    [
      "Blocked",
      { lease_active: true },
      { blockers: [blocker, blocker] },
      ["MAPPING_MISSING"],
    ],
    ["Converging", { lease_active: true }, {}, []],
    ["OutOfSync", { desired: undefined }, {}, []],
    ["OutOfSync", { desired: { ...desired, desired_revision: "4" } }, {}, []],
    ["OutOfSync", { desired: { ...desired, desired_hash: second } }, {}, []],
    [
      "OutOfSync",
      { observed: { ...observed, observed_revision: "8" } },
      {},
      [],
    ],
    ["OutOfSync", { observed: { ...observed, fresh: false } }, {}, []],
    ["OutOfSync", { fence_epoch: "3" }, {}, []],
    [
      "OutOfSync",
      { owner_instance_id: "22222222-2222-4222-8222-222222222222" },
      {},
      [],
    ],
    ["OutOfSync", { attempt: undefined }, {}, []],
    ["OutOfSync", { attempt: { ...attempt, state: "Started" } }, {}, []],
    ["OutOfSync", { unresolved: true }, {}, []],
    ["OutOfSync", { exactLines: false }, {}, []],
    ["OutOfSync", {}, { orders: [] }, []],
    [
      "Blocked",
      {
        attempt: {
          ...attempt,
          state: "Failed",
          failure_code: "AROMA_EXTERNAL_CHANGE",
          blocker_codes: ["AROMA_MUTATIONS_DISABLED", "AROMA_EXTERNAL_CHANGE"],
        },
      },
      {},
      ["AROMA_EXTERNAL_CHANGE", "AROMA_MUTATIONS_DISABLED"],
    ],
    [
      "Blocked",
      {
        attempt: {
          ...attempt,
          state: "Blocked",
          blocker_codes: ["AROMA_MUTATIONS_DISABLED"],
        },
      },
      {},
      ["AROMA_MUTATIONS_DISABLED"],
    ],
    [
      "OutOfSync",
      {
        attempt: {
          ...attempt,
          state: "Failed",
          fence_epoch: "1",
          failure_code: "AROMA_EXTERNAL_CHANGE",
        },
      },
      {},
      [],
    ],
  ];
  for (const [state, changes, planChanges, blockerCodes] of cases) {
    const actual = card(changes, planChanges);
    assert.equal(actual.state, state, JSON.stringify(changes));
    assert.deepEqual(actual.blocker_codes, blockerCodes);
    assert.deepEqual(
      [
        actual.verified_desired_revision,
        actual.verified_desired_hash,
        actual.verified_observed_revision,
        actual.verified_cart_fingerprint,
        actual.verified_attempt_ref,
      ],
      [null, null, null, null, null],
      state,
    );
  }
  assert.equal(
    card(
      {},
      {
        blockers: [{ ...blocker, orderRef: "ord_00000000000000000000000002" }],
      },
    ).state,
    "InSync",
  );
  const noFacts = card({
    desired: undefined,
    observed: undefined,
    attempt: undefined,
  });
  assert.equal(noFacts.desired_revision, "0");
  assert.equal(noFacts.observed_revision, "0");
  assert.equal(noFacts.desired_hash, null);
  assert.equal(noFacts.observed_cart_fingerprint, null);
  assert.equal(noFacts.attempt_ref, null);
  assert.equal(noFacts.fence_epoch, null);
  assert.equal(noFacts.last_observed_at, null);
});
