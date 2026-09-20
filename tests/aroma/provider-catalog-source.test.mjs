import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {createProviderCatalogSource, normalizeProviderCatalogMoneyAndPromotions, normalizeProviderCatalogOffer, normalizeProviderPriceToMinor, sourceIdentityForOffer} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";
import {decodeCatalogPage} from "../../apps/aroma-gateway/dist/infrastructure/provider/decoder.js";
import {MemoryProviderSessionStore} from "../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import {ProviderHttpClient} from "../../apps/aroma-gateway/dist/infrastructure/provider/http-client.js";
import {ProviderSessionManager} from "../../apps/aroma-gateway/dist/infrastructure/provider/session.js";

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

void test("catalog source composes the real HTTP client and session manager without prefetching the next page", async (t) => {
  const calls = [];
  const client = new ProviderHttpClient({origin: "https://provider.test", timeoutMs: 1_000, maxResponseBytes: 64 * 1024, connections: 1});
  const manager = new ProviderSessionManager({
    transport: client,
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 7),
  });
  t.after(() => manager.close());
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({url, init});
    if (url.endsWith("/api/v1/auth/login")) {
      return new Response(JSON.stringify({data: {email: credentials.email, wholesale: true, retail: false}}), {
        headers: {
          "content-type": "application/json",
          "set-cookie": "october_session=provider-session; Domain=provider.test; Path=/; HttpOnly",
        },
      });
    }
    const pageNumber = Number(new URL(url).searchParams.get("page"));
    return new Response(JSON.stringify(page(pageNumber, 2, 2)), {headers: {"content-type": "application/json"}});
  });
  const source = createProviderCatalogSource({
    sessions: manager,
    credentials,
    sourceIdentityKey: Buffer.from("identity-key"),
    pageSize: 1,
    normalize,
  });
  const first = await source.next();
  assert.equal(first.done, false);
  assert.equal(first.value.displayName, "Offer 1");
  assert.deepEqual(calls.map(call => new URL(call.url).pathname), ["/api/v1/auth/login", "/api/v1/catalog/wholesale/products"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const second = await source.next();
  assert.equal(second.done, false);
  assert.equal(second.value.displayName, "Offer 2");
  assert.equal(new URL(calls[2].url).searchParams.get("page"), "2");
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
  assert.equal(normalizeProviderPriceToMinor("12.300"), "1230");
  assert.equal(normalizeProviderPriceToMinor("0"), "0");
  assert.equal(normalizeProviderPriceToMinor("0.00"), "0");
  for (const price of ["-1", "-0.01", "12.301", "1.001", "01", "1e2"]) assert.throws(() => normalizeProviderPriceToMinor(price), {code: "ProviderProtocolViolation"});
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
  assert.equal(normalizeProviderCatalogMoneyAndPromotions({...product, discounts: [{...product.discounts[0], discountRaw: "10.000"}]}, offer).supplierPromotions[0].discountBasisPoints, 1000);
  for (const bad of [{...product, discounts: undefined}, {...product, discounts: [{...product.discounts[0], discountRaw: "0"}]}, {...product, discounts: [{...product.discounts[0], discountRaw: "10.001"}]}, {...product, discounts: [{...product.discounts[0], discountRaw: "100.01"}]}, {...product, discounts: [{...product.discounts[0], minimumWeightRaw: "0.00"}]}, {...product, discounts: [{...product.discounts[0], providerUpdatedAt: "not-a-date"}]}, {...product, discounts: [{...product.discounts[0], providerUpdatedAt: "2026-02-30T00:00:00Z"}]}]) {
    assert.throws(() => normalizeProviderCatalogMoneyAndPromotions(bad, offer), {code: "ProviderProtocolViolation"});
  }
});

void test("production normalizer uses the offer ID as the domain-separated source variant key", async () => {
  const capture = JSON.parse(await readFile(new URL("../../evidence/aroma-provider/2026-09-12/page47.json", import.meta.url), "utf8"));
  const decoded = decodeCatalogPage(capture);
  const product = decoded.products[0];
  const offer = product.offers[0];
  const money = normalizeProviderCatalogMoneyAndPromotions(product, offer);
  assert.equal(money.supplierUnitMinor, "94000");
  assert.equal(money.currency, "RUB");
  const explicitPiece = normalizeProviderCatalogOffer(product, offer);
  assert.equal(explicitPiece.unit, "piece");
  assert.deepEqual(explicitPiece.providerIdentity, {
    rawProviderProductId: product.productId,
    rawProviderVariantId: offer.offerId,
    rawProviderOfferId: offer.offerId,
  });
  assert.equal(explicitPiece.providerIdentity.packing, undefined);
  assert.equal(explicitPiece.providerIdentity.grindId, undefined);

  const supplierRef = "sup_00000000000000000000000001";
  const key = Buffer.from("identity-key");
  const identity = sourceIdentityForOffer(explicitPiece, supplierRef, key);
  const independentlyComputedHash = entityType => createHmac("sha256", key)
    .update(Buffer.from(`hmac-sha256-v1\0${supplierRef}\0${entityType}\0${entityType === "product" ? product.productId : offer.offerId}`, "utf8"))
    .digest("hex");
  assert.equal(identity.sourceProductKeyHash, independentlyComputedHash("product"));
  assert.equal(identity.sourceVariantKeyHash, independentlyComputedHash("variant"));
  assert.equal(identity.sourceOfferKeyHash, independentlyComputedHash("offer"));
  assert.notEqual(identity.sourceVariantKeyHash, identity.sourceOfferKeyHash);
});

void test("zero-price captures preserve exact zero and become locally Unavailable", async () => {
  for (const path of ["../../evidence/aroma-provider/2026-09-12/page1.json", "../../evidence/aroma-provider/2026-09-12-authenticated/catalog-page1.json"]) {
    const capture = JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
    const decoded = decodeCatalogPage(capture);
    const offers = decoded.products.flatMap(product => product.offers.map(offer => normalizeProviderCatalogOffer(product, offer)));
    assert.equal(offers.length, 10);
    assert.equal(offers.every(offer => offer.supplierUnitMinor === "0" && offer.availability === "Unavailable"), true);
    const stopped = normalizeProviderCatalogOffer({...decoded.products[0], productOnStop: true}, decoded.products[0].offers[0]);
    assert.equal(stopped.supplierUnitMinor, "0");
    assert.equal(stopped.availability, "Stopped");
  }
  for (const price of ["-1", "-0.01", "1.001", "1e2"]) assert.throws(() => normalizeProviderPriceToMinor(price), {code: "ProviderProtocolViolation"});
});

void test("production normalizer rejects malformed image, availability, identity, or unit facts", async () => {
  const capture = JSON.parse(await readFile(new URL("../../evidence/aroma-provider/2026-09-12/page47.json", import.meta.url), "utf8"));
  const decoded = decodeCatalogPage(capture);
  const product = decoded.products[0];
  const offer = product.offers[0];
  const cases = [
    {...product, previewPath: null, photoPaths: [], offers: [offer]},
    {...product, productOnStop: undefined, offers: [offer]},
    {...product, soldByPiece: undefined, offers: [offer]},
    {...product, productId: "", offers: [offer]},
  ];
  assert.equal(normalizeProviderCatalogOffer(cases[0], cases[0].offers[0]).imageUrl, null);
  for (const missingFact of cases.slice(1)) assert.throws(() => normalizeProviderCatalogOffer(missingFact, missingFact.offers[0]), {code: "ProviderProtocolViolation"});
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
