import assert from "node:assert/strict";
import test from "node:test";
import {ProviderCartMutator} from "../../apps/aroma-gateway/dist/application/provider-cart-mutator.js";
import {createSourceIdentity} from "../../apps/aroma-gateway/dist/domain/source-identity.js";

const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const credentials = {scopeRef: "aroma-primary", email: "canonical@example.test", password: "test-only"};
const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
const emptyCart = {products: [], prices: {categories: [], weights: [], discounts: [], prices: [], total: {default: 0, promo: 0}}};
const cart = quantity => ({products: [{id: 300001, offer: {id: 300000, price: 852.6}, quantity, packing: "Aroma", grind_id: null}], prices: {categories: [], weights: [], discounts: [], prices: [], total: {default: 620 * quantity, promo: 434 * quantity}}});
const identity = {offerRef, supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV", sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64), rawProviderOfferId: "300000", rawProviderProductId: "300001", rawProviderVariantId: "300000", packing: "Aroma", grindId: null, cartLineId: "300001"};
const signal = () => new AbortController().signal;
const createMutator = options => new ProviderCartMutator({...options, defaultPacking: "Aroma"});

function sessionFor(bodies, mutations, mutationBody) {
  let reads = 0;
  const responseBody = mutationBody === undefined ? undefined : mutationBody instanceof Uint8Array ? mutationBody : bytes(mutationBody);
  return {
    get reads() { return reads; },
    read: async function* () {
      const body = bodies[Math.min(reads++, bodies.length - 1)];
      yield bytes(body);
    },
    mutate: async operation => { mutations.push(operation); return {statusCode: 200, body: responseBody}; },
  };
}

void test("malformed HTTP 200 mutation response cannot be acknowledged after a confirming fresh GET", async () => {
  const mutations = [];
  const session = sessionFor([cart(1), cart(3)], mutations, Buffer.from("{not-json", "utf8"));
  const mutator = createMutator({
    sessions: {acquire: async () => session},
    credentials,
    bindings: {resolveProviderOffer: async () => identity},
  });
  await assert.rejects(mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "3"}, {}, signal()), {code: "ProviderDecodeInvalid"});
  assert.deepEqual(mutations, [{kind: "set-cart-line-quantity", cartLineId: "300001", quantity: 3, packing: "Aroma"}]);
  assert.equal(session.reads, 2);
});

void test("mutation response must prove full provider identity and operation-specific result", async () => {
  const cases = [
    {
      request: {operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "3"},
      observed: [cart(1), cart(3)],
      response: {...cart(3), products: [{...cart(3).products[0], packing: "Other"}]},
    },
    {
      request: {operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "3"},
      observed: [cart(1), cart(3)],
      response: cart(2),
    },
    {
      request: {operationRef, cartScopeRef: "aroma-primary", operationKind: "RemoveLine", offerRef, quantityMilli: null},
      observed: [cart(1), emptyCart],
      response: cart(1),
    },
  ];
  for (const {request, observed, response} of cases) {
    const mutations = [];
    const mutator = createMutator({
      sessions: {acquire: async () => sessionFor(observed, mutations, response)},
      credentials,
      bindings: {resolveProviderOffer: async () => identity},
    });
    await assert.rejects(mutator.execute(request, {}, signal()), {code: "ProviderProtocolViolation"});
    assert.equal(mutations.length, 1);
  }
});

void test("mutator performs one exact typed mutation and verifies the fresh cart for quantity 3", async () => {
  const mutations = [];
  const session = sessionFor([cart(1), cart(3)], mutations, cart(3));
  const mutator = createMutator({
    sessions: {acquire: async () => session},
    credentials,
    bindings: {resolveProviderOffer: async () => identity},
  });
  const result = await mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "3"}, {}, signal());
  assert.equal(result.state, "Acknowledged");
  assert.deepEqual(mutations, [{kind: "set-cart-line-quantity", cartLineId: "300001", quantity: 3, packing: "Aroma"}]);
  assert.equal(session.reads, 2);
});

void test("mutator adds a missing mapped line using the provider offer id, never the public offer ref", async () => {
  const mutations = [];
  const session = sessionFor([emptyCart, cart(1)], mutations, cart(1));
  const mutator = createMutator({
    sessions: {acquire: async () => session},
    credentials,
    bindings: {resolveProviderOffer: async () => ({...identity, cartLineId: null})},
  });
  const result = await mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "1"}, {}, signal());
  assert.equal(result.state, "Acknowledged");
  assert.deepEqual(mutations, [{kind: "add-cart-line", offerId: "300000", quantity: 1, packing: "Aroma"}]);
  assert.equal(JSON.stringify(mutations).includes(offerRef), false);
});

void test("mutator resolves the selected grind hash to the provider grind id and echoes the hash", async () => {
  const sourceIdentityKey = Buffer.from("test-only-source-identity-key", "utf8");
  const sourceGrindKeyHash = createSourceIdentity({
    supplierRef: identity.supplierRef,
    entityType: "grind",
    rawProviderIdentifier: "7",
    sourceIdentityKey,
  }).sourceIdentityHash;
  const selectedCart = quantity => ({
    ...cart(quantity),
    products: [{...cart(quantity).products[0], grind_id: "7"}],
  });
  const mutations = [];
  let cartReads = 0;
  const session = {
    read: async function* (operation) {
      yield bytes(operation.kind === "grinds"
        ? [{id: 7, name: "Средний"}]
        : cartReads++ === 0 ? emptyCart : selectedCart(2));
    },
    mutate: async operation => {
      mutations.push(operation);
      return {statusCode: 200, body: bytes(selectedCart(2))};
    },
  };
  const mutator = createMutator({
    sessions: {acquire: async () => session},
    credentials,
    bindings: {resolveProviderOffer: async () => identity},
    supplierRef: identity.supplierRef,
    sourceIdentityKey,
  });
  const result = await mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, sourceGrindKeyHash, quantityMilli: "2"}, {}, signal());

  assert.deepEqual(mutations, [{kind: "add-cart-line", offerId: "300000", quantity: 2, packing: "Aroma", grindId: "7"}]);
  assert.equal(JSON.parse(Buffer.from(result.responseBodyBytes).toString("utf8")).sourceGrindKeyHash, sourceGrindKeyHash);
});

void test("mutator removes an existing line and refuses a missing remove before unsafe dispatch", async () => {
  const removed = [];
  const existingSession = sessionFor([cart(1), emptyCart], removed, emptyCart);
  const mutator = createMutator({sessions: {acquire: async () => existingSession}, credentials, bindings: {resolveProviderOffer: async () => identity}});
  const removedResult = await mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "RemoveLine", offerRef, quantityMilli: null}, {}, signal());
  assert.equal(removedResult.state, "Acknowledged");
  assert.deepEqual(removed, [{kind: "remove-cart-line", cartLineId: "300001"}]);

  const missing = [];
  const missingSession = sessionFor([emptyCart], missing);
  const missingMutator = createMutator({sessions: {acquire: async () => missingSession}, credentials, bindings: {resolveProviderOffer: async () => identity}});
  const missingResult = await missingMutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "RemoveLine", offerRef, quantityMilli: null}, {}, signal());
  assert.equal(missingResult.state, "Rejected");
  assert.equal(missingResult.statusCode, 404);
  assert.deepEqual(missing, []);
});

void test("mutator rejects ambiguous provider identity without making an unsafe call", async () => {
  const mutations = [];
  const duplicate = {...cart(1), products: [cart(1).products[0], {...cart(1).products[0], id: 300002}]};
  const mutator = createMutator({sessions: {acquire: async () => sessionFor([duplicate], mutations)}, credentials, bindings: {resolveProviderOffer: async () => identity}});
  await assert.rejects(mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "1"}, {}, signal()), {code: "ProviderDecodeInvalid"});
  assert.deepEqual(mutations, []);
});

void test("mutator uses the configured packing when catalog facts are absent", async () => {
  const mutations = [];
  let sessions = 0;
  const identityWithoutCatalogFacts = {...identity};
  delete identityWithoutCatalogFacts.packing;
  delete identityWithoutCatalogFacts.grindId;
  const mutator = createMutator({
    sessions: {acquire: async () => { sessions += 1; return sessionFor([cart(1), cart(2)], mutations, cart(2)); }},
    credentials,
    bindings: {resolveProviderOffer: async () => identityWithoutCatalogFacts},
  });
  const result = await mutator.execute({operationRef, cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "2"}, {}, signal());
  assert.equal(result.state, "Acknowledged");
  assert.equal(sessions, 1);
  assert.equal(mutations.length, 1);
});
