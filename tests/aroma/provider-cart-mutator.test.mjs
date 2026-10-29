import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import test from "node:test";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { ProviderMutationJournalStore } from "../../apps/aroma-gateway/dist/infrastructure/database/provider-mutation-journal.js";
import { ProviderCartMutator } from "../../apps/aroma-gateway/dist/application/provider-cart-mutator.js";
import { createSourceIdentity } from "../../apps/aroma-gateway/dist/domain/source-identity.js";

import { isAromaProblem } from "../../packages/contracts/aroma-v1/dist/index.js";
import {
  GatewayMutationExecutor,
  canonicalMutationRequest,
  canonicalMutationRequestHash,
  typedResponseHash,
} from "../../apps/aroma-gateway/dist/domain/mutation-journal.js";

const TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
const CORRELATION = "11111111-1111-4111-8111-111111111111";

function request(number, operationKind = "SetLineQuantity") {
  const suffix = String(number).padStart(26, "0");
  return {
    operationRef: `op_${suffix}`,
    cartScopeRef: "aroma-primary",
    operationKind,
    offerRef: `off_${suffix}`,
    quantityMilli: operationKind === "SetLineQuantity" ? "3" : null,
  };
}

function acknowledgedBytes(requestValue) {
  return Buffer.from(
    JSON.stringify({
      operationRef: requestValue.operationRef,
      cartScopeRef: requestValue.cartScopeRef,
      offerRef: requestValue.offerRef,
      ...(requestValue.sourceGrindKeyHash === undefined
        ? {}
        : { sourceGrindKeyHash: requestValue.sourceGrindKeyHash }),
      state: "Acknowledged",
    }),
  );
}

const ACK_BYTES = acknowledgedBytes(request(3));
const rejectionBody = Object.freeze({
  type: "about:blank",
  title: "AROMA_PROVIDER_REJECTED",
  status: 409,
  code: "AROMA_PROVIDER_REJECTED",
  detail: "The typed gateway mutation was rejected.",
  instance: "/api/internal-v1/aroma/cart-lines",
  correlationId: CORRELATION,
  errors: [],
});
const rejectionBytes = (overrides = {}) =>
  Buffer.from(JSON.stringify({ ...rejectionBody, ...overrides }));
const REJECT_BYTES = rejectionBytes();

function delegation(overrides = {}) {
  return {
    transportCaller: "api-internal",
    issuer: "api-internal",
    audience: "aroma-gateway",
    originalCaller: "aroma-convergence",
    operationId: "setAromaCartLineQuantity",
    callerIdentity: "api-internal",
    correlationId: CORRELATION,
    traceparent: TRACEPARENT,
    ...overrides,
  };
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function terminal(record, replayed) {
  const result = {
    state: record.state,
    statusCode: record.statusCode,
    responseBodyBytes: new Uint8Array(record.responseBodyBytes),
    replayed,
  };
  if (record.failureCode !== undefined) result.failureCode = record.failureCode;
  return result;
}

function unknown(record, replayed) {
  return {
    state: "UnknownOutcome",
    failureCode: record.failureCode ?? "AROMA_PROVIDER_OUTCOME_UNKNOWN",
    replayed,
  };
}

class SharedJournal {
  constructor() {
    this.records = new Map();
    this.events = [];
    this.reserveCalls = 0;
    this.acceptedReservations = 0;
    this.dispatchCalls = 0;
  }
}

class MemoryJournal {
  constructor(shared, reservationOwner, leaseMs = 30_000) {
    this.shared = shared;
    this.reservationOwner = reservationOwner;
    this.leaseMs = leaseMs;
  }

  async reserve(requestValue, delegationValue) {
    this.shared.reserveCalls++;
    const hash = canonicalMutationRequestHash(requestValue, delegationValue);
    const key = canonicalMutationRequest(requestValue, delegationValue);
    let record = this.shared.records.get(requestValue.operationRef);
    if (record === undefined) {
      record = {
        operationRef: requestValue.operationRef,
        requestHash: hash,
        requestKey: key,
        state: "Reserved",
        reservationOwner: this.reservationOwner,
        leaseUntil: Date.now() + this.leaseMs,
        dispatchedAt: undefined,
        responseBodyBytes: undefined,
        statusCode: undefined,
        failureCode: undefined,
      };
      this.shared.records.set(requestValue.operationRef, record);
      this.shared.acceptedReservations++;
      this.shared.events.push("reserved-committed");
      return { kind: "Reserved", reservation: this.reservation(record) };
    }
    if (record.requestHash !== hash || record.requestKey !== key)
      throw codedError("AROMA_OPERATION_REF_CONFLICT");
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return { kind: "Replay", outcome: terminal(record, true) };
    if (record.state === "UnknownOutcome" || record.state === "Dispatched")
      return { kind: "UnknownOutcome", outcome: unknown(record, true) };
    if (record.leaseUntil <= Date.now()) {
      record.reservationOwner = this.reservationOwner;
      record.leaseUntil = Date.now() + this.leaseMs;
      this.shared.acceptedReservations++;
      this.shared.events.push("reserved-takeover-committed");
      return { kind: "Reserved", reservation: this.reservation(record) };
    }
    return {
      kind: "InProgress",
      state: "Reserved",
      operationRef: record.operationRef,
    };
  }

  async markDispatched(reservationValue) {
    this.shared.dispatchCalls++;
    const record = this.shared.records.get(reservationValue.operationRef);
    if (record === undefined) throw codedError("AROMA_JOURNAL_CORRUPT");
    if (
      record.requestHash !== reservationValue.requestHash ||
      record.reservationOwner !== reservationValue.reservationOwner
    ) {
      throw codedError("AROMA_RESERVATION_LOST");
    }
    if (record.state === "Reserved" && record.leaseUntil > Date.now()) {
      record.state = "Dispatched";
      record.dispatchedAt = Date.now();
      this.shared.events.push("dispatched-committed");
      return { kind: "DispatchPermitted", permit: this.permit(record) };
    }
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return { kind: "Replay", outcome: terminal(record, true) };
    if (record.state === "UnknownOutcome" || record.state === "Dispatched")
      return { kind: "UnknownOutcome", outcome: unknown(record, true) };
    return {
      kind: "InProgress",
      state: "Reserved",
      operationRef: record.operationRef,
    };
  }

  async rejectReservation(reservationValue, result) {
    const record = this.current(reservationValue);
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return terminal(record, true);
    if (record.state !== "Reserved") throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Rejected";
    record.statusCode = result.statusCode;
    record.failureCode = result.failureCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    this.shared.events.push("rejected-before-dispatch");
    return terminal(record, false);
  }

  async acknowledge(permitValue, result) {
    const record = this.current(permitValue);
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return terminal(record, true);
    if (record.state !== "Dispatched")
      throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Acknowledged";
    record.statusCode = result.statusCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    return terminal(record, false);
  }

  async reject(permitValue, result) {
    const record = this.current(permitValue);
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return terminal(record, true);
    if (record.state !== "Dispatched")
      throw codedError("AROMA_RESERVATION_LOST");
    record.state = "Rejected";
    record.statusCode = result.statusCode;
    record.failureCode = result.failureCode;
    record.responseBodyBytes = new Uint8Array(result.responseBodyBytes);
    record.completedAt = Date.now();
    return terminal(record, false);
  }

  async markUnknown(permitValue, failureCode) {
    const record = this.current(permitValue);
    if (record.state === "UnknownOutcome") return unknown(record, true);
    if (record.state === "Acknowledged" || record.state === "Rejected")
      return terminal(record, true);
    if (record.state !== "Dispatched")
      throw codedError("AROMA_RESERVATION_LOST");
    record.state = "UnknownOutcome";
    record.failureCode = failureCode;
    record.completedAt = Date.now();
    return unknown(record, false);
  }

  async recoverAfterRestart(cutoff = Date.now()) {
    let recovered = 0;
    for (const record of this.shared.records.values()) {
      if (record.state === "Dispatched" && record.dispatchedAt < cutoff) {
        record.state = "UnknownOutcome";
        record.failureCode = "AROMA_PROVIDER_OUTCOME_UNKNOWN";
        record.completedAt = Date.now();
        recovered++;
      }
    }
    return recovered;
  }

  reservation(record) {
    return {
      operationRef: record.operationRef,
      requestHash: record.requestHash,
      reservationOwner: record.reservationOwner,
      leaseUntil: new Date(record.leaseUntil).toISOString(),
    };
  }

  permit(record) {
    return {
      operationRef: record.operationRef,
      requestHash: record.requestHash,
      reservationOwner: record.reservationOwner,
    };
  }

  current(permitValue) {
    const record = this.shared.records.get(permitValue.operationRef);
    if (
      record === undefined ||
      record.requestHash !== permitValue.requestHash ||
      record.reservationOwner !== permitValue.reservationOwner
    )
      throw codedError("AROMA_RESERVATION_LOST");
    return record;
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("timed out waiting for test seam");
}

function acknowledgeMutator(shared, calls, bytes) {
  return async (requestValue, _permit, _signal) => {
    calls.value++;
    assert.equal(shared.events.at(-1), "dispatched-committed");
    return {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: bytes ?? acknowledgedBytes(requestValue),
    };
  };
}

const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const credentials = {
  scopeRef: "aroma-primary",
  email: "canonical@example.test",
  password: "test-only",
};
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const emptyCart = {
  products: [],
  prices: {
    categories: [],
    weights: [],
    discounts: [],
    prices: [],
    total: { default: 0, promo: 0 },
  },
};
const cart = (quantity) => ({
  products: [
    {
      id: 300001,
      offer: { id: 300000, price: 852.6 },
      quantity,
      packing: "Aroma",
      grind_id: null,
    },
  ],
  prices: {
    categories: [],
    weights: [],
    discounts: [],
    prices: [],
    total: { default: 620 * quantity, promo: 434 * quantity },
  },
});
const identity = {
  offerRef,
  supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  sourceIdentityScheme: "hmac-sha256-v1",
  sourceOfferKeyHash: "a".repeat(64),
  rawProviderOfferId: "300000",
  rawProviderProductId: "300001",
  rawProviderVariantId: "300000",
  packing: "Aroma",
  grindId: null,
  cartLineId: "300001",
};
const signal = () => new AbortController().signal;
const createMutator = (options) =>
  new ProviderCartMutator({ ...options, defaultPacking: "Aroma" });

function sessionFor(bodies, mutations, mutationBody) {
  let reads = 0;
  const responseBody =
    mutationBody === undefined
      ? undefined
      : mutationBody instanceof Uint8Array
        ? mutationBody
        : bytes(mutationBody);
  return {
    get reads() {
      return reads;
    },
    read: async function* () {
      const body = bodies[Math.min(reads++, bodies.length - 1)];
      yield bytes(body);
    },
    mutate: async (operation) => {
      mutations.push(operation);
      return { statusCode: 200, body: responseBody };
    },
  };
}

void test("malformed HTTP 200 mutation response cannot be acknowledged after a confirming fresh GET", async () => {
  const mutations = [];
  const session = sessionFor(
    [cart(1), cart(3)],
    mutations,
    Buffer.from("{not-json", "utf8"),
  );
  const mutator = createMutator({
    sessions: { acquire: async () => session },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  });
  await assert.rejects(
    mutator.execute(
      {
        operationRef,
        cartScopeRef: "aroma-primary",
        operationKind: "SetLineQuantity",
        offerRef,
        quantityMilli: "3",
      },
      {},
      signal(),
    ),
    { code: "ProviderDecodeInvalid" },
  );
  assert.deepEqual(mutations, [
    {
      kind: "set-cart-line-quantity",
      cartLineId: "300001",
      quantity: 3,
      packing: "Aroma",
    },
  ]);
  assert.equal(session.reads, 2);
});

void test("mutation response must prove full provider identity and operation-specific result", async () => {
  const cases = [
    {
      request: {
        operationRef,
        cartScopeRef: "aroma-primary",
        operationKind: "SetLineQuantity",
        offerRef,
        quantityMilli: "3",
      },
      observed: [cart(1), cart(3)],
      response: {
        ...cart(3),
        products: [{ ...cart(3).products[0], packing: "Other" }],
      },
    },
    {
      request: {
        operationRef,
        cartScopeRef: "aroma-primary",
        operationKind: "SetLineQuantity",
        offerRef,
        quantityMilli: "3",
      },
      observed: [cart(1), cart(3)],
      response: cart(2),
    },
    {
      request: {
        operationRef,
        cartScopeRef: "aroma-primary",
        operationKind: "RemoveLine",
        offerRef,
        quantityMilli: null,
      },
      observed: [cart(1), emptyCart],
      response: cart(1),
    },
  ];
  for (const { request, observed, response } of cases) {
    const mutations = [];
    const mutator = createMutator({
      sessions: {
        acquire: async () => sessionFor(observed, mutations, response),
      },
      credentials,
      bindings: { resolveProviderOffer: async () => identity },
    });
    await assert.rejects(mutator.execute(request, {}, signal()), {
      code: "ProviderProtocolViolation",
    });
    assert.equal(mutations.length, 1);
  }
});

void test("mutator performs one exact typed mutation and verifies the fresh cart for quantity 3", async () => {
  const fallbackMutations = [];
  const fallbackSession = sessionFor(
    [cart(1), cart(3)],
    fallbackMutations,
    cart(3),
  );
  const fallbackResult = await createMutator({
    sessions: { acquire: async () => fallbackSession },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  }).execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef,
      quantityMilli: "3",
    },
    {},
    signal(),
  );
  assert.equal(fallbackResult.state, "Acknowledged");
  assert.equal(fallbackSession.reads, 2);

  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const mutations = [];
  const session = sessionFor([cart(3)], mutations, cart(3));
  const originalRead = session.read.bind(session);
  const originalMutate = session.mutate.bind(session);
  session.read = async function* (...args) {
    shared.events.push("verification-read");
    yield* originalRead(...args);
  };
  session.mutate = async (operation) => {
    assert.equal(
      shared.records.get(operationRef).state,
      "Dispatched",
      "provider mutation must wait for a committed dispatch permit",
    );
    shared.events.push("provider-mutation");
    return originalMutate(operation);
  };
  const mutator = createMutator({
    sessions: {
      readSafe: async function* (scope, operation, requestSignal) {
        assert.deepEqual(scope, credentials);
        assert.deepEqual(operation, { kind: "cart" });
        assert.equal(requestSignal.aborted, false);
        shared.events.push("safe-read");
        yield bytes(cart(1));
      },
      acquire: async (scope) => {
        assert.deepEqual(scope, credentials);
        shared.events.push("acquire-mutation-session");
        return session;
      },
    },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  });
  const result = await new GatewayMutationExecutor(
    journal,
    mutator.execute.bind(mutator),
  ).execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef,
      quantityMilli: "3",
    },
    delegation(),
    signal(),
  );
  assert.equal(result.state, "Acknowledged");
  assert.deepEqual(shared.events, [
    "reserved-committed",
    "safe-read",
    "acquire-mutation-session",
    "dispatched-committed",
    "provider-mutation",
    "verification-read",
  ]);
  assert.deepEqual(mutations, [
    {
      kind: "set-cart-line-quantity",
      cartLineId: "300001",
      quantity: 3,
      packing: "Aroma",
    },
  ]);
  assert.equal(session.reads, 1);
});

void test("mutator adds a missing mapped line using the provider offer id, never the public offer ref", async () => {
  const mutations = [];
  const session = sessionFor([emptyCart, cart(1)], mutations, cart(1));
  const mutator = createMutator({
    sessions: { acquire: async () => session },
    credentials,
    bindings: {
      resolveProviderOffer: async () => ({ ...identity, cartLineId: null }),
    },
  });
  const result = await mutator.execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef,
      quantityMilli: "1",
    },
    {},
    signal(),
  );
  assert.equal(result.state, "Acknowledged");
  assert.deepEqual(mutations, [
    { kind: "add-cart-line", offerId: "300000", quantity: 1, packing: "Aroma" },
  ]);
  assert.equal(JSON.stringify(mutations).includes(offerRef), false);
});

void test("mutator resolves the selected grind hash to the provider grind id and echoes the hash", async () => {
  const sourceIdentityKey = Buffer.from(
    "test-only-source-identity-key",
    "utf8",
  );
  const sourceGrindKeyHash = createSourceIdentity({
    supplierRef: identity.supplierRef,
    entityType: "grind",
    rawProviderIdentifier: "7",
    sourceIdentityKey,
  }).sourceIdentityHash;
  const selectedCart = (quantity) => ({
    ...cart(quantity),
    products: [{ ...cart(quantity).products[0], grind_id: "7" }],
  });
  const mutations = [];
  let cartReads = 0;
  const session = {
    read: async function* (operation) {
      yield bytes(
        operation.kind === "grinds"
          ? [{ id: 7, name: "Средний" }]
          : cartReads++ === 0
            ? emptyCart
            : selectedCart(2),
      );
    },
    mutate: async (operation) => {
      mutations.push(operation);
      return { statusCode: 200, body: bytes(selectedCart(2)) };
    },
  };
  const mutator = createMutator({
    sessions: { acquire: async () => session },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
    supplierRef: identity.supplierRef,
    sourceIdentityKey,
  });
  const result = await mutator.execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef,
      sourceGrindKeyHash,
      quantityMilli: "2",
    },
    {},
    signal(),
  );

  assert.deepEqual(mutations, [
    {
      kind: "add-cart-line",
      offerId: "300000",
      quantity: 2,
      packing: "Aroma",
      grindId: "7",
    },
  ]);
  assert.equal(
    JSON.parse(Buffer.from(result.responseBodyBytes).toString("utf8"))
      .sourceGrindKeyHash,
    sourceGrindKeyHash,
  );
});

void test("mutator removes an existing line and refuses a missing remove before unsafe dispatch", async () => {
  const removed = [];
  const existingSession = sessionFor([cart(1), emptyCart], removed, emptyCart);
  const mutator = createMutator({
    sessions: { acquire: async () => existingSession },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  });
  const removedResult = await mutator.execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "RemoveLine",
      offerRef,
      quantityMilli: null,
    },
    {},
    signal(),
  );
  assert.equal(removedResult.state, "Acknowledged");
  assert.deepEqual(removed, [
    { kind: "remove-cart-line", cartLineId: "300001" },
  ]);

  const missing = [];
  const missingSession = sessionFor([emptyCart], missing);
  const missingMutator = createMutator({
    sessions: { acquire: async () => missingSession },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  });
  const missingResult = await missingMutator.execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "RemoveLine",
      offerRef,
      quantityMilli: null,
    },
    {},
    signal(),
  );
  assert.equal(missingResult.state, "Rejected");
  assert.equal(missingResult.statusCode, 404);
  assert.deepEqual(missing, []);
});

void test("mutator rejects ambiguous provider identity without making an unsafe call", async () => {
  const mutations = [];
  const duplicate = {
    ...cart(1),
    products: [cart(1).products[0], { ...cart(1).products[0], id: 300002 }],
  };
  const mutator = createMutator({
    sessions: { acquire: async () => sessionFor([duplicate], mutations) },
    credentials,
    bindings: { resolveProviderOffer: async () => identity },
  });
  await assert.rejects(
    mutator.execute(
      {
        operationRef,
        cartScopeRef: "aroma-primary",
        operationKind: "SetLineQuantity",
        offerRef,
        quantityMilli: "1",
      },
      {},
      signal(),
    ),
    { code: "ProviderDecodeInvalid" },
  );
  assert.deepEqual(mutations, []);
});

void test("mutator uses the configured packing when catalog facts are absent", async () => {
  const mutations = [];
  let sessions = 0;
  const identityWithoutCatalogFacts = { ...identity };
  delete identityWithoutCatalogFacts.packing;
  delete identityWithoutCatalogFacts.grindId;
  const mutator = createMutator({
    sessions: {
      acquire: async () => {
        sessions += 1;
        return sessionFor([cart(1), cart(2)], mutations, cart(2));
      },
    },
    credentials,
    bindings: { resolveProviderOffer: async () => identityWithoutCatalogFacts },
  });
  const result = await mutator.execute(
    {
      operationRef,
      cartScopeRef: "aroma-primary",
      operationKind: "SetLineQuantity",
      offerRef,
      quantityMilli: "2",
    },
    {},
    signal(),
  );
  assert.equal(result.state, "Acknowledged");
  assert.equal(sessions, 1);
  assert.equal(mutations.length, 1);
});

void test("concurrent calls produce one durable reservation and one dispatch permit", async () => {
  const shared = new SharedJournal();
  const firstJournal = new MemoryJournal(shared, "owner-a");
  const secondJournal = new MemoryJournal(shared, "owner-b");
  const firstCalls = { value: 0 };
  const secondCalls = { value: 0 };
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const first = new GatewayMutationExecutor(firstJournal, async (...args) => {
    firstCalls.value++;
    assert.equal(shared.events.at(-1), "dispatched-committed");
    await blocked;
    return acknowledgeMutator(shared, { value: 0 })(...args);
  });
  const second = new GatewayMutationExecutor(secondJournal, async () => {
    secondCalls.value++;
    throw new Error("duplicate dispatch");
  });
  const req = request(1);
  const firstPromise = first.execute(req, delegation());
  await waitFor(() => firstCalls.value === 1);
  const secondResult = await second.execute(
    req,
    delegation({ correlationId: "22222222-2222-4222-8222-222222222222" }),
  );
  assert.equal(secondResult.state, "UnknownOutcome");
  release();
  const firstResult = await firstPromise;
  assert.equal(firstResult.state, "Acknowledged");
  assert.equal(shared.acceptedReservations, 1);
  assert.equal(shared.dispatchCalls, 1);
  assert.equal(firstCalls.value, 1);
  assert.equal(secondCalls.value, 0);
});

void test("safe preparation finishes before the dispatch permit and known preparation failure is terminal before dispatch", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const requestValue = request(40);
  const preparationEvents = [];
  let unsafeCalls = 0;
  const executor = new GatewayMutationExecutor(
    journal,
    async (requestValue2) => {
      unsafeCalls++;
      preparationEvents.push("unsafe");
      assert.equal(
        shared.records.get(requestValue2.operationRef).state,
        "Dispatched",
      );
      return {
        state: "Acknowledged",
        statusCode: 200,
        responseBodyBytes: acknowledgedBytes(requestValue2),
      };
    },
    async () => {
      preparationEvents.push("prepared");
      return { safeCart: true };
    },
  );
  const acknowledged = await executor.execute(requestValue, delegation());
  assert.equal(acknowledged.state, "Acknowledged");
  assert.deepEqual(preparationEvents, ["prepared", "unsafe"]);
  assert.deepEqual(shared.events.slice(0, 2), [
    "reserved-committed",
    "dispatched-committed",
  ]);
  assert.equal(unsafeCalls, 1);

  const failedRequest = request(41);
  const failed = await new GatewayMutationExecutor(
    new MemoryJournal(shared, "owner-b"),
    async () => {
      throw new Error("unsafe preparation failure must not reach provider");
    },
    async () => {
      throw codedError("ProviderSessionUnavailable");
    },
  ).execute(failedRequest, delegation());
  assert.equal(failed.state, "Rejected");
  assert.equal(failed.statusCode, 503);
  assert.equal(
    shared.records.get(failedRequest.operationRef).state,
    "Rejected",
  );
  assert.equal(shared.dispatchCalls, 1);
});

void test("delegation is rejected before reserve and a changed request conflicts on operationRef", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const calls = { value: 0 };
  const executor = new GatewayMutationExecutor(
    journal,
    acknowledgeMutator(shared, calls),
  );
  await assert.rejects(
    executor.execute(
      request(2),
      delegation({ transportCaller: "aroma-convergence" }),
    ),
    { code: "SERVICE_DELEGATION_INVALID" },
  );
  assert.equal(shared.reserveCalls, 0);
  await executor.execute(request(2), delegation());
  await assert.rejects(
    executor.execute({ ...request(2), quantityMilli: "4" }, delegation()),
    { code: "AROMA_OPERATION_REF_CONFLICT" },
  );
  assert.equal(calls.value, 1);
  assert.equal(shared.reserveCalls, 2);
});

void test("selected grind is part of the operation identity while legacy no-grind replay keeps its hash", async () => {
  const shared = new SharedJournal();
  const calls = { value: 0 };
  const executor = new GatewayMutationExecutor(
    new MemoryJournal(shared, "owner-a"),
    acknowledgeMutator(shared, calls),
  );
  const first = { ...request(42), sourceGrindKeyHash: "a".repeat(64) };
  const second = { ...first, sourceGrindKeyHash: "b".repeat(64) };
  await executor.execute(first, delegation());
  await assert.rejects(executor.execute(second, delegation()), {
    code: "AROMA_OPERATION_REF_CONFLICT",
  });
  assert.equal(calls.value, 1);

  const legacy = request(43);
  const legacyHash = canonicalMutationRequestHash(legacy, delegation());
  assert.equal(
    legacyHash,
    canonicalMutationRequestHash(
      { ...legacy, sourceGrindKeyHash: undefined },
      delegation(),
    ),
  );
  const replay = await executor.execute(legacy, delegation());
  assert.equal(replay.replayed, false);
  assert.equal(canonicalMutationRequestHash(legacy, delegation()), legacyHash);
});

void test("SetLineQuantity rejects null and zero before reserve while RemoveLine keeps null", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const executor = new GatewayMutationExecutor(
    journal,
    acknowledgeMutator(shared, { value: 0 }),
  );
  await assert.rejects(
    executor.execute({ ...request(22), quantityMilli: null }, delegation()),
    { code: "AROMA_MUTATION_INVALID" },
  );
  assert.equal(shared.reserveCalls, 0);
  await assert.rejects(
    executor.execute({ ...request(22), quantityMilli: "0" }, delegation()),
    { code: "AROMA_MUTATION_INVALID" },
  );
  assert.equal(shared.reserveCalls, 0);

  const removeCalls = { value: 0 };
  const removeResult = await new GatewayMutationExecutor(
    journal,
    acknowledgeMutator(shared, removeCalls),
  ).execute(
    request(23, "RemoveLine"),
    delegation({ operationId: "removeAromaCartLine" }),
  );
  assert.equal(removeResult.state, "Acknowledged");
  assert.equal(removeCalls.value, 1);
  assert.equal(shared.reserveCalls, 1);
});

void test("SetLineQuantity caps the integer at the lossless provider dispatch boundary", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const executor = new GatewayMutationExecutor(
    journal,
    acknowledgeMutator(shared, { value: 0 }),
  );
  const accepted = {
    ...request(44),
    quantityMilli: String(Number.MAX_SAFE_INTEGER),
  };
  await assert.doesNotReject(executor.execute(accepted, delegation()));
  assert.equal(shared.reserveCalls, 1);
  await assert.rejects(
    executor.execute(
      { ...request(45), quantityMilli: String(Number.MAX_SAFE_INTEGER + 1) },
      delegation(),
    ),
    { code: "AROMA_MUTATION_INVALID" },
  );
  assert.equal(shared.reserveCalls, 1);
});

void test("invalid typed response bytes are unknown before acknowledge and use the invalid-response failure code", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const originalAcknowledge = journal.acknowledge.bind(journal);
  const originalMarkUnknown = journal.markUnknown.bind(journal);
  let acknowledgeCalls = 0;
  let markUnknownFailureCode;
  journal.acknowledge = async (...args) => {
    acknowledgeCalls++;
    return originalAcknowledge(...args);
  };
  journal.markUnknown = async (...args) => {
    markUnknownFailureCode = args[1];
    return originalMarkUnknown(...args);
  };

  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Acknowledged",
    statusCode: 200,
    responseBodyBytes: Buffer.from("not JSON"),
  })).execute(request(24), delegation());

  assert.deepEqual(result, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_INVALID_RESPONSE",
    replayed: false,
  });
  assert.equal(acknowledgeCalls, 0);
  assert.equal(markUnknownFailureCode, "AROMA_PROVIDER_INVALID_RESPONSE");
  assert.equal(
    shared.records.get(request(24).operationRef).state,
    "UnknownOutcome",
  );
});

void test("ProviderCartMutator malformed response becomes durable UnknownOutcome and replays without a provider call", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const requestValue = request(27);
  const identity = {
    offerRef: requestValue.offerRef,
    supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "a".repeat(64),
    rawProviderOfferId: "300000",
    rawProviderProductId: "300001",
    rawProviderVariantId: "300000",
    packing: "Aroma",
    grindId: null,
    cartLineId: "300001",
  };
  const cart = (quantity) => ({
    products: [
      {
        id: 300001,
        offer: { id: 300000, price: 852.6 },
        quantity,
        packing: "Aroma",
        grind_id: null,
      },
    ],
    prices: {
      categories: [],
      weights: [],
      discounts: [],
      prices: [],
      total: { default: 0, promo: 0 },
    },
  });
  let reads = 0;
  let providerCalls = 0;
  const session = {
    read: async function* () {
      yield Buffer.from(JSON.stringify(cart(reads++ === 0 ? 1 : 3)));
    },
    mutate: async () => {
      providerCalls++;
      return { statusCode: 200, body: Buffer.from("{not-json", "utf8") };
    },
  };
  const mutator = new ProviderCartMutator({
    sessions: { acquire: async () => session },
    credentials: {
      scopeRef: "aroma-primary",
      email: "canonical@example.test",
      password: "test-only",
    },
    bindings: { resolveProviderOffer: async () => identity },
    defaultPacking: "Aroma",
  });
  const executor = new GatewayMutationExecutor(
    journal,
    mutator.execute.bind(mutator),
  );
  const first = await executor.execute(requestValue, delegation());
  assert.deepEqual(first, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_INVALID_RESPONSE",
    replayed: false,
  });
  const replay = await executor.execute(requestValue, delegation());
  assert.deepEqual(replay, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_INVALID_RESPONSE",
    replayed: true,
  });
  assert.equal(providerCalls, 1);
});

void test("invalid ProblemDetails URI-reference becomes UnknownOutcome before reject", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const invalidReferences = [
    "1:abc",
    ":abc",
    "/[::1]",
    "http://[",
    "/has space",
    "\\evil.com",
    "%",
    "\0",
    "foo[bar",
    "foo]bar",
    '"foo',
    "%GG",
  ];
  const validReferences = [
    "./1:abc",
    "/a:b",
    "//[::1]/",
    "http://[::1]/",
    "HTTP://EXAMPLE.COM/problem",
    "urn:example:test",
    "/relative/path",
    "../a?b#c",
    "a%20b",
  ];
  for (const field of ["type", "instance"]) {
    for (const value of invalidReferences)
      assert.equal(
        isAromaProblem({ ...rejectionBody, [field]: value }),
        false,
        `${field}: ${JSON.stringify(value)}`,
      );
    for (const value of validReferences)
      assert.equal(
        isAromaProblem({ ...rejectionBody, [field]: value }),
        true,
        `${field}: ${JSON.stringify(value)}`,
      );
  }
  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: rejectionBytes({ instance: "http://[" }),
  })).execute(request(25), delegation());
  assert.deepEqual(result, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_INVALID_RESPONSE",
    replayed: false,
  });
  assert.equal(
    shared.records.get(request(25).operationRef).state,
    "UnknownOutcome",
  );
});

void test("contract-valid ProblemDetails counts Unicode title by schema semantics", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const title = "😀".repeat(101);
  const body = { ...rejectionBody, title };
  assert.equal(isAromaProblem(body), true);
  const result = await new GatewayMutationExecutor(journal, async () => ({
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: rejectionBytes({ title }),
  })).execute(request(26), delegation());
  assert.equal(result.state, "Rejected");
  assert.equal(shared.records.get(request(26).operationRef).state, "Rejected");
});

void test("acknowledged and rejected terminal rows replay exact typed bytes without HTTP", async () => {
  const ackShared = new SharedJournal();
  const ackJournal = new MemoryJournal(ackShared, "owner-a");
  const ackCalls = { value: 0 };
  const ackExecutor = new GatewayMutationExecutor(
    ackJournal,
    acknowledgeMutator(ackShared, ackCalls, ACK_BYTES),
  );
  const ackRequest = request(3);
  const ackFirst = await ackExecutor.execute(ackRequest, delegation());
  const ackReplay = await new GatewayMutationExecutor(ackJournal, async () => {
    throw new Error("HTTP must not run");
  }).execute(ackRequest, delegation());
  assert.equal(ackReplay.state, "Acknowledged");
  assert.equal(ackReplay.replayed, true);
  assert.deepEqual(
    Buffer.from(ackReplay.responseBodyBytes),
    Buffer.from(ackFirst.responseBodyBytes),
  );
  assert.equal(
    typedResponseHash(ackReplay.responseBodyBytes),
    typedResponseHash(ACK_BYTES),
  );
  assert.equal(ackCalls.value, 1);

  const rejectShared = new SharedJournal();
  const rejectJournal = new MemoryJournal(rejectShared, "owner-a");
  let rejectCalls = 0;
  const rejectExecutor = new GatewayMutationExecutor(
    rejectJournal,
    async () => {
      rejectCalls++;
      return {
        state: "Rejected",
        statusCode: 409,
        failureCode: "AROMA_PROVIDER_REJECTED",
        responseBodyBytes: REJECT_BYTES,
      };
    },
  );
  const rejectRequest = request(4);
  const rejectFirst = await rejectExecutor.execute(rejectRequest, delegation());
  const rejectReplay = await new GatewayMutationExecutor(
    rejectJournal,
    async () => {
      throw new Error("HTTP must not run");
    },
  ).execute(rejectRequest, delegation());
  assert.equal(rejectReplay.state, "Rejected");
  assert.equal(rejectReplay.replayed, true);
  assert.deepEqual(
    Buffer.from(rejectReplay.responseBodyBytes),
    Buffer.from(rejectFirst.responseBodyBytes),
  );
  assert.equal(rejectCalls, 1);
});

void test("lost response or timeout becomes UnknownOutcome and never dispatches again", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  let calls = 0;
  const executor = new GatewayMutationExecutor(journal, async () => {
    calls++;
    throw codedError("AROMA_PROVIDER_TIMEOUT");
  });
  const req = request(5);
  const first = await executor.execute(req, delegation());
  const replay = await new GatewayMutationExecutor(journal, async () => {
    calls++;
    throw new Error("duplicate dispatch");
  }).execute(req, delegation());
  assert.deepEqual(first, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_TIMEOUT",
    replayed: false,
  });
  assert.deepEqual(replay, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_TIMEOUT",
    replayed: true,
  });
  assert.equal(calls, 1);
});

void test("aborted provider timeout is durably marked UnknownOutcome with a terminal journal signal", async () => {
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  const originalMarkUnknown = journal.markUnknown.bind(journal);
  journal.markUnknown = async (...args) => {
    assert.equal(args[2]?.aborted, false);
    return originalMarkUnknown(...args);
  };
  const controller = new AbortController();
  const executor = new GatewayMutationExecutor(
    journal,
    async (_request, _permit, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error("provider timeout"), {
        name: "TimeoutError",
      });
    },
  );
  const result = await executor.execute(
    request(21),
    delegation(),
    controller.signal,
  );
  assert.deepEqual(result, {
    state: "UnknownOutcome",
    failureCode: "AROMA_PROVIDER_TIMEOUT",
    replayed: false,
  });
});

void test("restart recovery fences stale Dispatched rows as UnknownOutcome", async () => {
  const shared = new SharedJournal();
  const oldJournal = new MemoryJournal(shared, "owner-a");
  const req = request(6);
  const reserved = await oldJournal.reserve(req, delegation());
  assert.equal(reserved.kind, "Reserved");
  const dispatched = await oldJournal.markDispatched(reserved.reservation);
  assert.equal(dispatched.kind, "DispatchPermitted");
  shared.records.get(req.operationRef).dispatchedAt = 0;
  const restarted = new MemoryJournal(shared, "owner-b");
  assert.equal(await restarted.recoverAfterRestart(Date.now()), 1);
  let calls = 0;
  const result = await new GatewayMutationExecutor(restarted, async () => {
    calls++;
    throw new Error("restart must not retry");
  }).execute(req, delegation());
  assert.equal(result.state, "UnknownOutcome");
  assert.equal(result.replayed, true);
  assert.equal(calls, 0);
});

void test("expired Reserved lease is taken over by one new owner before its first dispatch", async () => {
  const shared = new SharedJournal();
  const oldJournal = new MemoryJournal(shared, "owner-a", 1);
  const req = request(7);
  const reserved = await oldJournal.reserve(req, delegation());
  assert.equal(reserved.kind, "Reserved");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newJournal = new MemoryJournal(shared, "owner-b", 30_000);
  const calls = { value: 0 };
  const result = await new GatewayMutationExecutor(
    newJournal,
    acknowledgeMutator(shared, calls),
  ).execute(req, delegation());
  assert.equal(result.state, "Acknowledged");
  assert.equal(calls.value, 1);
  assert.equal(shared.acceptedReservations, 2);
  assert.equal(shared.dispatchCalls, 1);
  assert.equal(
    shared.records.get(req.operationRef).reservationOwner,
    "owner-b",
  );
});

void test("canonical hash excludes per-request correlation while binding trusted caller and operation", () => {
  const req = request(8);
  const first = delegation();
  const second = delegation({
    correlationId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(
    canonicalMutationRequestHash(req, first),
    canonicalMutationRequestHash(req, second),
  );
  assert.notEqual(
    canonicalMutationRequestHash(req, first),
    canonicalMutationRequestHash(
      req,
      delegation({ operationId: "removeAromaCartLine" }),
    ),
  );
});

void test("persisted journal rows fail closed on corruption and replay only typed terminal results", async (t) => {
  const input = request(73);
  const auth = delegation();
  const owner = "33333333-3333-4333-8333-333333333333";
  const digest = canonicalMutationRequestHash(input, auth);
  const at = "2026-10-26T10:00:00.000Z";
  const valid = {
    operation_ref: input.operationRef,
    cart_scope_ref: input.cartScopeRef,
    operation_kind: input.operationKind,
    offer_ref: input.offerRef,
    quantity_milli: input.quantityMilli,
    source_grind_key_hash: null,
    request_hash: digest,
    caller_identity: auth.callerIdentity,
    original_caller: auth.originalCaller,
    operation_id: auth.operationId,
    correlation_id: auth.correlationId,
    traceparent: auth.traceparent,
    state: "Reserved",
    reservation_owner: owner,
    lease_until: at,
    provider_status_code: null,
    outcome_hash: null,
    failure_code: null,
    response_status: null,
    response_body_bytes: null,
    created_at: at,
    started_at: at,
    dispatched_at: null,
    completed_at: null,
    last_seen_at: at,
    retention_until: at,
  };
  let row = valid;
  let lostCommit;
  const statements = [];
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    statements.push(sql);
    if (sql === "COMMIT" && lostCommit !== undefined) {
      row = lostCommit.row;
      lostCommit = undefined;
      return { rows: [], rowCount: 0, command: "UNKNOWN" };
    }
    if (
      sql.includes(
        "FROM integration.provider_mutation_journal WHERE operation_ref",
      )
    )
      return {
        rows: row === undefined ? [] : [row],
        rowCount: Number(row !== undefined),
      };
    return { rows: [], rowCount: 0, command: sql.split(" ")[0] };
  };
  connection.release = () => {};
  t.mock.method(pg.Pool.prototype, "connect", async () => connection);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const database = createDatabase({
    owner: "journal-unit",
    database: "owner",
    allowedDatabase: "owner",
    host: "localhost",
    port: 5432,
    user: "owner",
    password: "test-only",
    ssl: false,
    pool: {
      max: 2,
      checkoutTimeoutMs: 50,
      lockTimeoutMs: 40,
      interactiveStatementTimeoutMs: 100,
      backgroundStatementTimeoutMs: 200,
      terminalTimeoutMs: 40,
      transactionTimeoutMs: 300,
      idleTimeoutMs: 1000,
      maxLifetimeMs: 1000,
    },
    shutdownGraceMs: 1000,
  });
  t.after(() => database.resource.destroy());
  const store = new ProviderMutationJournalStore(database, {
    reservationOwner: owner,
  });
  for (const invalid of [
    { state: "Unexpected" },
    { operation_kind: "Unknown" },
    { operation_ref: "" },
    { request_hash: "bad" },
    { source_grind_key_hash: "private-id" },
    { outcome_hash: "bad" },
    { failure_code: "provider secret" },
    { quantity_milli: "-1" },
    { quantity_milli: "9223372036854775808" },
    { quantity_milli: 1.5 },
    { lease_until: new Date("invalid") },
    { response_status: 600 },
    { provider_status_code: "99" },
    { response_body_bytes: Buffer.alloc(0) },
    { response_body_bytes: "raw provider body" },
    { state: "Acknowledged" },
    { state: "UnknownOutcome" },
    { state: "Reserved", failure_code: "AROMA_PROVIDER_TIMEOUT" },
  ]) {
    row = { ...valid, ...invalid };
    await assert.rejects(store.get(input.operationRef), {
      code: "AROMA_JOURNAL_CORRUPT",
    });
  }
  assert.equal(
    statements.some((sql) => /^(INSERT|UPDATE|DELETE)\b/u.test(sql)),
    false,
  );
  row = { ...valid, quantity_milli: 3n, lease_until: new Date(at) };
  const decoded = await store.read(input.operationRef);
  assert.equal(decoded.quantityMilli, "3");
  assert.equal(decoded.leaseUntil, at);
  row = undefined;
  assert.equal(await store.get(input.operationRef), undefined);

  const responseBodyBytes = acknowledgedBytes(input);
  row = {
    ...valid,
    state: "Acknowledged",
    response_status: "200",
    response_body_bytes: responseBodyBytes,
    outcome_hash: typedResponseHash(responseBodyBytes),
  };
  let providerCalls = 0;
  const executor = new GatewayMutationExecutor(store, async () => {
    providerCalls += 1;
    throw new Error("must not dispatch");
  });
  const replay = await executor.execute(input, auth);
  assert.equal(replay.state, "Acknowledged");
  assert.equal(replay.replayed, true);
  assert.deepEqual(Buffer.from(replay.responseBodyBytes), responseBodyBytes);
  assert.equal(providerCalls, 0);
  row = {
    ...row,
    response_body_bytes: Buffer.from('{"private":"provider-secret"}'),
  };
  await assert.rejects(executor.execute(input, auth), {
    code: "AROMA_JOURNAL_CORRUPT",
  });
  assert.equal(providerCalls, 0);

  row = valid;
  assert.equal((await store.reserve(input, auth)).kind, "InProgress");
  const reservation = {
    operationRef: input.operationRef,
    requestHash: digest,
    reservationOwner: owner,
    leaseUntil: at,
  };
  assert.equal((await store.markDispatched(reservation)).kind, "InProgress");
  const rejected = {
    state: "Rejected",
    statusCode: 409,
    failureCode: "AROMA_PROVIDER_REJECTED",
    responseBodyBytes: REJECT_BYTES,
  };
  await assert.rejects(store.rejectReservation(reservation, rejected), {
    code: "AROMA_RESERVATION_LOST",
  });
  await assert.rejects(
    store.markUnknown(reservation, "AROMA_PROVIDER_TIMEOUT"),
    { code: "AROMA_RESERVATION_LOST" },
  );
  row = { ...valid, state: "Dispatched" };
  assert.equal((await store.reserve(input, auth)).kind, "UnknownOutcome");
  assert.equal(
    (await store.rejectReservation(reservation, rejected)).state,
    "UnknownOutcome",
  );
  row = {
    ...valid,
    state: "UnknownOutcome",
    failure_code: "AROMA_PROVIDER_TIMEOUT",
  };
  assert.equal(
    (await store.markUnknown(reservation, "AROMA_PROVIDER_TIMEOUT"))
      .failureCode,
    "AROMA_PROVIDER_TIMEOUT",
  );
  await assert.rejects(store.reject(reservation, rejected), {
    code: "AROMA_OPERATION_UNKNOWN_OUTCOME",
  });
  row = {
    ...valid,
    state: "Rejected",
    response_status: 409,
    response_body_bytes: REJECT_BYTES,
    outcome_hash: typedResponseHash(REJECT_BYTES),
    failure_code: "AROMA_PROVIDER_REJECTED",
  };
  const rejectedReplay = await store.rejectReservation(reservation, rejected);
  assert.equal(rejectedReplay.state, "Rejected");
  assert.equal(rejectedReplay.replayed, true);
  assert.deepEqual(Buffer.from(rejectedReplay.responseBodyBytes), REJECT_BYTES);
  row = { ...valid, reservation_owner: "44444444-4444-4444-8444-444444444444" };
  await assert.rejects(store.rejectReservation(reservation, rejected), {
    code: "AROMA_RESERVATION_LOST",
  });
  await assert.rejects(
    store.markUnknown(reservation, "AROMA_PROVIDER_TIMEOUT"),
    { code: "AROMA_RESERVATION_LOST" },
  );
  row = undefined;
  await assert.rejects(store.rejectReservation(reservation, rejected), {
    code: "AROMA_JOURNAL_CORRUPT",
  });
  await assert.rejects(
    store.markUnknown(reservation, "AROMA_PROVIDER_TIMEOUT"),
    { code: "AROMA_JOURNAL_CORRUPT" },
  );
  for (const limit of [0, -1, 1001, 1.5])
    await assert.rejects(store.cleanupTerminal(limit), {
      code: "AROMA_MUTATION_INVALID",
    });
  await assert.rejects(store.recoverAfterRestart("not-a-timestamp"), {
    code: "AROMA_MUTATION_INVALID",
  });
  assert.equal(await store.cleanupTerminal(1), 0);
  assert.equal(await store.recoverStaleDispatched(at), 0);

  row = valid;
  lostCommit = { row: undefined };
  const unknownReservation = await store.reserve(input, auth);
  assert.equal(unknownReservation.kind, "UnknownOutcome");
  assert.equal(unknownReservation.outcome.replayed, true);
  row = { ...valid, state: "Dispatched" };
  lostCommit = {
    row: {
      ...valid,
      state: "Acknowledged",
      response_status: 200,
      response_body_bytes: responseBodyBytes,
      outcome_hash: typedResponseHash(responseBodyBytes),
    },
  };
  const recoveredDispatch = await store.markDispatched(reservation);
  assert.equal(recoveredDispatch.kind, "Replay");
  assert.equal(recoveredDispatch.outcome.replayed, true);
  row = { ...valid, state: "Dispatched" };
  lostCommit = {
    row: {
      ...valid,
      state: "Acknowledged",
      response_status: 200,
      response_body_bytes: Buffer.from('{"private":"provider-secret"}'),
      outcome_hash: "a".repeat(64),
    },
  };
  const corruptRecovery = await store.markDispatched(reservation);
  assert.equal(corruptRecovery.kind, "UnknownOutcome");
  assert.equal(
    corruptRecovery.outcome.failureCode,
    "AROMA_PROVIDER_OUTCOME_UNKNOWN",
  );
  assert.equal(providerCalls, 0);
});

void test("mutation request and delegation guards reject invalid inputs before reservation", async () => {
  const shared = new SharedJournal();
  let unsafeCalls = 0;
  const executor = new GatewayMutationExecutor(
    new MemoryJournal(shared, "owner-a"),
    async () => {
      unsafeCalls += 1;
    },
  );
  const input = request(80);
  for (const invalid of [
    null,
    { ...input, operationRef: "bad" },
    { ...input, offerRef: "bad" },
    { ...input, cartScopeRef: "other" },
    { ...input, operationKind: "Add" },
    { ...input, quantityMilli: -1 },
    { ...input, quantityMilli: 1.5 },
    { ...input, quantityMilli: "01" },
    { ...input, quantityMilli: "1.0" },
    { ...input, sourceGrindKeyHash: "invalid" },
    { ...request(80, "RemoveLine"), quantityMilli: "1" },
  ]) {
    await assert.rejects(executor.execute(invalid, delegation()), {
      code: "AROMA_MUTATION_INVALID",
    });
  }
  for (const invalid of [
    null,
    delegation({ transportCaller: "Bad Caller" }),
    delegation({ callerIdentity: "aroma-convergence" }),
    delegation({ issuer: "orders-service" }),
    delegation({ audience: "wrong" }),
    delegation({ originalCaller: "orders-service" }),
    delegation({ operationId: "removeAromaCartLine" }),
    delegation({ operationId: "bad-operation" }),
    delegation({ correlationId: "not-uuid" }),
    delegation({ traceparent: "invalid" }),
  ]) {
    await assert.rejects(executor.execute(input, invalid), {
      code: "SERVICE_DELEGATION_INVALID",
    });
  }
  assert.equal(shared.reserveCalls, 0);
  assert.equal(shared.dispatchCalls, 0);
  assert.equal(unsafeCalls, 0);
});

void test("safe preparation failures are typed and persisted before any provider mutation", async () => {
  const cases = [
    ["ProviderCartItemNotFound", "AROMA_CART_ITEM_NOT_FOUND", 404],
    ["ProviderCartMappingMissing", "AROMA_PROVIDER_MAPPING_MISSING", 422],
    ["ProviderCartMappingAmbiguous", "AROMA_PROVIDER_MAPPING_AMBIGUOUS", 422],
    ["ProviderDecodeInvalid", "AROMA_PROVIDER_INVALID_RESPONSE", 502],
    ["ProviderDecodeIncomplete", "AROMA_PROVIDER_INVALID_RESPONSE", 502],
    ["ProviderReadIncomplete", "AROMA_PROVIDER_INVALID_RESPONSE", 502],
    ["ProviderProtocolViolation", "AROMA_PROVIDER_INVALID_RESPONSE", 502],
    [
      "ProviderAuthenticationFailed",
      "AROMA_PROVIDER_AUTHENTICATION_FAILED",
      503,
    ],
    [
      "ProviderAuthorizationFailed",
      "AROMA_PROVIDER_AUTHENTICATION_FAILED",
      503,
    ],
    ["ProviderUnavailable", "AROMA_PROVIDER_UNAVAILABLE", 503],
    ["ProviderCancelled", "AROMA_PROVIDER_UNAVAILABLE", 503],
    ["unexpected-private-error", "AROMA_PROVIDER_PREPARATION_FAILED", 503],
  ];
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  let unsafeCalls = 0;
  for (const [index, [cause, expectedCode, status]] of cases.entries()) {
    const input = request(100 + index);
    const executor = new GatewayMutationExecutor(
      journal,
      async () => {
        unsafeCalls += 1;
      },
      async () => {
        throw codedError(cause);
      },
    );
    const outcome = await executor.execute(input, delegation());
    assert.equal(outcome.state, "Rejected");
    assert.equal(outcome.failureCode, expectedCode);
    assert.equal(outcome.statusCode, status);
    assert.equal(
      JSON.parse(Buffer.from(outcome.responseBodyBytes)).code,
      expectedCode,
    );
    assert.doesNotMatch(
      Buffer.from(outcome.responseBodyBytes).toString(),
      /unexpected-private-error/u,
    );
    assert.equal((await executor.execute(input, delegation())).replayed, true);
  }
  assert.equal(shared.dispatchCalls, 0);
  assert.equal(unsafeCalls, 0);
});

void test("untrusted provider outcomes become unknown and cannot dispatch twice", async () => {
  const malformed = [
    null,
    { state: "Acknowledged", statusCode: 201, responseBodyBytes: ACK_BYTES },
    {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: Buffer.alloc(0),
    },
    {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: Buffer.alloc(65537),
    },
    {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: Buffer.from([0xff]),
    },
    {
      state: "Acknowledged",
      statusCode: 200,
      responseBodyBytes: ACK_BYTES,
      providerStatusCode: 600,
    },
    {
      state: "Rejected",
      statusCode: 200,
      failureCode: "AROMA_PROVIDER_REJECTED",
      responseBodyBytes: REJECT_BYTES,
    },
    {
      state: "Rejected",
      statusCode: 409,
      failureCode: "bad code",
      responseBodyBytes: REJECT_BYTES,
    },
    {
      state: "Rejected",
      statusCode: 409,
      failureCode: "AROMA_PROVIDER_REJECTED",
      responseBodyBytes: Buffer.from("{}"),
    },
  ];
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  let unsafeCalls = 0;
  for (const [index, result] of malformed.entries()) {
    const input = request(120 + index);
    const executor = new GatewayMutationExecutor(journal, async () => {
      unsafeCalls += 1;
      return result;
    });
    const outcome = await executor.execute(input, delegation());
    assert.equal(outcome.state, "UnknownOutcome");
    assert.equal(outcome.failureCode, "AROMA_PROVIDER_INVALID_RESPONSE");
    const replay = await executor.execute(input, delegation());
    assert.equal(replay.state, "UnknownOutcome");
    assert.equal(replay.replayed, true);
    assert.equal(unsafeCalls, index + 1);
  }
});

void test("provider failures after dispatch preserve unknown outcome without retry", async () => {
  const timeout = Object.assign(new Error("private-timeout"), {
    name: "AbortError",
  });
  const cases = [
    [codedError("ProviderDecodeInvalid"), "AROMA_PROVIDER_INVALID_RESPONSE"],
    [codedError("ProviderDecodeIncomplete"), "AROMA_PROVIDER_INVALID_RESPONSE"],
    [codedError("AROMA_PROVIDER_DISCONNECT"), "AROMA_PROVIDER_DISCONNECT"],
    [codedError("AROMA_PROVIDER_UNAVAILABLE"), "AROMA_PROVIDER_UNAVAILABLE"],
    [timeout, "AROMA_PROVIDER_TIMEOUT"],
    [new Error("private-provider-error"), "AROMA_PROVIDER_OUTCOME_UNKNOWN"],
  ];
  const shared = new SharedJournal();
  const journal = new MemoryJournal(shared, "owner-a");
  let calls = 0;
  for (const [index, [failure, expectedCode]] of cases.entries()) {
    const input = request(140 + index);
    const executor = new GatewayMutationExecutor(journal, async () => {
      calls += 1;
      throw failure;
    });
    const first = await executor.execute(input, delegation());
    assert.equal(first.state, "UnknownOutcome");
    assert.equal(first.failureCode, expectedCode);
    assert.doesNotMatch(
      JSON.stringify(first),
      /private-provider-error|private-timeout/u,
    );
    const second = await executor.execute(input, delegation());
    assert.equal(second.failureCode, expectedCode);
    assert.equal(second.replayed, true);
    assert.equal(calls, index + 1);
  }
});
