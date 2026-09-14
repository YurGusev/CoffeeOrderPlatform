import assert from "node:assert/strict";
import test from "node:test";
import {createProviderCatalogSource, normalizeProviderCatalogMoneyAndPromotions, normalizeProviderCatalogOffer, normalizeProviderPriceToMinor} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";

const credentials = {scopeRef: "aroma-primary", email: "canonical@example.test", password: "test-only"};
const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
const page = (currentPage, lastPage, total = lastPage) => ({
  data: [{id: currentPage, name: `Product ${currentPage}`, discount: [], offers: [{id: String(currentPage), name: `Offer ${currentPage}`, vendor_code: `V-${currentPage}`, price: 10, params: []}]}],
  links: {first: null, last: null, prev: null, next: null},
  meta: {current_page: currentPage, from: currentPage, to: currentPage, last_page: lastPage, per_page: 1, total},
});
const normalize = (product, offer) => ({
  displayName: offer.name,
  unit: "piece",
  supplierUnitMinor: "10",
  currency: "RUB",
  availability: "Available",
  imageUrl: "https://example.test/product",
  supplierPromotions: [],
  providerIdentity: {rawProviderProductId: product.productId, rawProviderVariantId: offer.offerId, rawProviderOfferId: offer.offerId, packing: null, grindId: null},
});

void test("catalog source requests pages sequentially and does not fetch page two before demand", async () => {
  const calls = [];
  const source = createProviderCatalogSource({
    sessions: {acquire: async () => ({read: async function* (operation) {calls.push(operation.page); yield bytes(page(operation.page, 2, 2));}})},
    credentials,
    sourceIdentityKey: Buffer.from("identity-key"),
    pageSize: 1,
    normalize,
  });
  const first = await source.next();
  assert.equal(first.done, false);
  assert.equal(first.value.displayName, "Offer 1");
  assert.deepEqual(calls, [1]);
  const second = await source.next();
  assert.equal(second.done, false);
  assert.equal(second.value.displayName, "Offer 2");
  assert.deepEqual(calls, [1, 2]);
  assert.equal((await source.next()).done, true);
});

void test("catalog source fails closed on metadata drift and when no explicit normalizer is supplied", async () => {
  let calls = 0;
  const drifting = createProviderCatalogSource({
    sessions: {acquire: async () => ({read: async function* (operation) {calls += 1; yield bytes(page(operation.page, 2, operation.page === 1 ? 2 : 3));}})},
    credentials,
    sourceIdentityKey: Buffer.from("identity-key"),
    pageSize: 1,
    normalize,
  });
  await drifting.next();
  await assert.rejects(() => drifting.next(), {code: "ProviderProtocolViolation"});
  assert.equal(calls, 2);

  const unconfigured = createProviderCatalogSource({
    sessions: {acquire: async () => ({read: async function* () {yield bytes(page(1, 1));}})},
    credentials,
    sourceIdentityKey: Buffer.from("identity-key"),
  });
  await assert.rejects(() => unconfigured.next(), {code: "ProviderProtocolViolation"});
  assert.equal(normalizeProviderCatalogOffer instanceof Function, true);
});

void test("money and supplier promotions normalize exactly and fail closed", () => {
  assert.equal(normalizeProviderPriceToMinor("446"), "44600");
  assert.equal(normalizeProviderPriceToMinor("549"), "54900");
  assert.equal(normalizeProviderPriceToMinor("12.30"), "1230");
  for (const price of ["0", "0.00", "1.001", "01", "1e2"]) assert.throws(() => normalizeProviderPriceToMinor(price), {code: "ProviderProtocolViolation"});
  const product = {
    productId: "7",
    name: "Coffee",
    discounts: [{discountRaw: "10", minimumWeightRaw: "0", providerCreatedAt: "2026-09-14T04:55:24.000000Z", providerUpdatedAt: "2026-09-14T04:55:24.000000Z"}],
    offers: [],
  };
  const offer = {offerId: "8", name: "Coffee", vendorCode: "C-8", priceRaw: "549"};
  assert.deepEqual(normalizeProviderCatalogMoneyAndPromotions(product, offer), {
    supplierUnitMinor: "54900",
    currency: "RUB",
    supplierPromotions: [{discountBasisPoints: 1000, minimumWeightRaw: "0", providerCreatedAt: "2026-09-14T04:55:24.000000Z", providerUpdatedAt: "2026-09-14T04:55:24.000000Z"}],
  });
  for (const bad of [{...product, discounts: undefined}, {...product, discounts: [{...product.discounts[0], discountRaw: "0"}]}, {...product, discounts: [{...product.discounts[0], discountRaw: "100.01"}]}, {...product, discounts: [{...product.discounts[0], minimumWeightRaw: "0.00"}]}, {...product, discounts: [{...product.discounts[0], providerUpdatedAt: "not-a-date"}]}, {...product, discounts: [{...product.discounts[0], providerUpdatedAt: "2026-02-30T00:00:00Z"}]}]) {
    assert.throws(() => normalizeProviderCatalogMoneyAndPromotions(bad, offer), {code: "ProviderProtocolViolation"});
  }
});

void test("catalog source propagates cancellation before the next provider page", async () => {
  const controller = new AbortController();
  let calls = 0;
  const source = createProviderCatalogSource({
    sessions: {acquire: async () => ({read: async function* (operation) {calls += 1; yield bytes(page(operation.page, 2, 2));}})},
    credentials,
    sourceIdentityKey: Buffer.from("identity-key"),
    pageSize: 1,
    signal: controller.signal,
    normalize,
  });
  await source.next();
  controller.abort();
  await assert.rejects(() => source.next(), {name: "AbortError"});
  assert.equal(calls, 1);
});
