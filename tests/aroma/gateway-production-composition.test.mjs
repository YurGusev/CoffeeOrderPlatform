import assert from "node:assert/strict";
import test from "node:test";
import {createProviderCatalogSource, normalizeProviderCatalogOffer, sourceIdentityForOffer} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";
import {ProviderCartMutator} from "../../apps/aroma-gateway/dist/application/provider-cart-mutator.js";

const supplierRef = "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const page = (currentPage, lastPage, total = lastPage) => ({data: [{id: currentPage, name: "Tea", discount: [], offers: [{id: String(currentPage), name: "Tea", vendor_code: "T", price: 1, params: []}]}], links: {first: null, last: null, prev: null, next: null}, meta: {current_page: currentPage, from: currentPage, to: currentPage, last_page: lastPage, per_page: 1, total}});
const bytes = value => Buffer.from(JSON.stringify(value));
const normalized = (product, offer) => ({displayName: offer.name, unit: "piece", supplierUnitMinor: "1", currency: "RUB", availability: "Available", imageUrl: "https://example.test/tea", supplierPromotions: [], providerIdentity: {rawProviderProductId: product.productId, rawProviderVariantId: offer.offerId, rawProviderOfferId: offer.offerId, packing: null, grindId: null}});

void test("provider catalog source is sequential, bounded, cancellable, and HMAC identity is Gateway-local", async () => {
  const controller = new AbortController();
  const calls = [];
  const sessions = {acquire: async () => ({read: async function* (operation) {calls.push(operation.page); yield bytes(page(operation.page, 2, 2));}})};
  const source = createProviderCatalogSource({sessions, credentials: {scopeRef: "aroma", email: "a@example.test", password: "secret"}, sourceIdentityKey: Buffer.from("key"), pageSize: 1, signal: controller.signal, normalize: normalized});
  assert.equal((await source.next()).value.displayName, "Tea");
  assert.deepEqual(calls, [1]);
  controller.abort();
  await assert.rejects(() => source.next(), {name: "AbortError"});
  assert.deepEqual(calls, [1]);
  const identity = sourceIdentityForOffer({...normalized({productId: "1"}, {offerId: "2", name: "Tea"})}, supplierRef, Buffer.from("key"));
  assert.match(identity.sourceOfferKeyHash, /^[a-f0-9]{64}$/u);
});

void test("catalog source fails closed when provider metadata drifts or money normalization is unproven", async () => {
  let call = 0;
  const source = createProviderCatalogSource({sessions: {acquire: async () => ({read: async function* () {call += 1; yield bytes(page(call, 2, call === 1 ? 2 : 3));}})}, credentials: {scopeRef: "aroma", email: "a@example.test", password: "secret"}, sourceIdentityKey: Buffer.from("key"), pageSize: 1, normalize: normalized});
  await source.next();
  await assert.rejects(() => source.next(), {code: "ProviderProtocolViolation"});
  assert.equal(call, 2);
  await assert.rejects(async () => { const empty = createProviderCatalogSource({sessions: {acquire: async () => ({read: async function* () {yield bytes(page(1, 1));}})}, credentials: {scopeRef: "aroma", email: "a@example.test", password: "secret"}, sourceIdentityKey: Buffer.from("key"), normalize: normalizeProviderCatalogOffer}); for await (const _ of empty) {} }, {code: "ProviderProtocolViolation"});
});

void test("production mutator resolves exact identity and performs one unsafe call", async () => {
  const cart = {prices: {total: {default: 0, promo: 0}}, products: [{id: 71, offer: {id: 70, price: 1}, quantity: 1, packing: null, grind_id: null}]};
  let unsafeCalls = 0;
  let reads = 0;
  const changed = {...cart, products: [{...cart.products[0], quantity: 2}]};
  const mutator = new ProviderCartMutator({sessions: {acquire: async () => ({read: async function* () {reads += 1; yield bytes(reads === 1 ? cart : changed);}})}, credentials: {scopeRef: "aroma", email: "a@example.test", password: "secret"}, bindings: {resolveProviderOffer: async () => ({offerRef, supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64), rawProviderOfferId: "70", rawProviderProductId: "70", rawProviderVariantId: "70", packing: null, grindId: null, cartLineId: null})}, transport: {mutate: async operation => {unsafeCalls += 1; assert.equal(operation.kind, "set-cart-line-quantity"); return {statusCode: 200, body: bytes(changed)};}}});
  const result = await mutator.execute({operationRef: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV", cartScopeRef: "aroma-primary", operationKind: "SetLineQuantity", offerRef, quantityMilli: "2"}, {}, new AbortController().signal);
  assert.equal(result.state, "Acknowledged");
  assert.equal(unsafeCalls, 1);
  assert.equal(reads, 2);
});
