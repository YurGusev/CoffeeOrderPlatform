import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";
import {createRuntime} from "../../packages/platform-runtime/dist/index.js";
import {signServiceDelegation} from "../../packages/platform-security/dist/index.js";
import {registerAromaBindingRoutes, registerAromaCatalogExportRoute} from "../../apps/aroma-gateway/dist/transport/http/index.js";
import {OfferBindingStore} from "../../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";
import {createProviderCatalogSource} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";
import {ProviderCartMutator} from "../../apps/aroma-gateway/dist/application/provider-cart-mutator.js";
import {sourceIdentityForOffer} from "../../apps/aroma-gateway/dist/application/provider-catalog-source.js";
import {sha256CatalogHash} from "../../apps/aroma-gateway/dist/application/catalog-export.js";

const supplierRef = "sup_00000000000000000000000001";
const foreignSupplierRef = "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const scopeRef = "aroma-primary";
const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const snapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const bytes = value => Buffer.from(JSON.stringify(value), "utf8");
const normalized = {
  displayName: "Tea",
  unit: "piece",
  supplierUnitMinor: "1",
  currency: "RUB",
  availability: "Available",
  imageUrl: "https://example.test/tea",
  supplierPromotions: [],
  providerIdentity: {
    rawProviderProductId: "provider-product",
    rawProviderVariantId: "platform-source-variant",
    rawProviderOfferId: "provider-offer",
    packing: "Unknown provider packing",
    grindId: "unknown-provider-grind",
  },
};
const credentials = {scopeRef, email: "canonical@example.test", password: "test-only"};

void test("provider catalog source preserves normalizer identity, including unknown packing and grind", async () => {
  const source = createProviderCatalogSource({
    sessions: {acquire: async () => ({read: async function* () {
      yield bytes({data: [{id: 7, name: "Tea", discount: [], offers: [{id: "70", name: "Tea", vendor_code: "T", price: 1, params: []}]}], links: {first: null, last: null, prev: null, next: null}, meta: {current_page: 1, from: 1, to: 1, last_page: 1, per_page: 1, total: 1}});
    }})},
    credentials,
    sourceIdentityKey: Buffer.from("key"),
    normalize: () => normalized,
  });
  const result = await source.next();
  assert.deepEqual(result.value.providerIdentity, normalized.providerIdentity);
  assert.notEqual(result.value.providerIdentity.packing, null);
  assert.notEqual(result.value.providerIdentity.grindId, null);
});

const {privateKey, publicKey} = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({type: "spki", format: "pem"}).toString();
const context = {secrets: {security: {delegationVerificationKeys: {"api-internal": {active: publicPem, previous: publicPem}}}}};
const delegation = (originalCaller, operationId) => {
  const iat = Math.floor(Date.now() / 1000);
  return signServiceDelegation({iss: "api-internal", aud: "aroma-gateway", originalCaller, operationId, correlationId: "corr-scope", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat, exp: iat + 60, jti: `${originalCaller}-${operationId}-${iat}`, kid: "test"}, privateKey);
};
const runtimeOptions = {host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 15_000, deadlineProfiles: {readMs: 15_000, defaultMs: 15_000}};

void test("foreign catalog export is rejected before source or persistence, while own snapshots expose traversal provenance", async t => {
  const app = await createRuntime({name: "scoping-export-test", ...runtimeOptions});
  app.addHook("preHandler", async request => { request.runtimeContext.transportIdentity = {runtime: "api-internal", environment: "test", san: "spiffe://test/api-internal"}; });
  let sourceCalls = 0;
  const started = [];
  const sourceFactory = () => { sourceCalls += 1; return (async function* () { yield normalized; })(); };
  const key = Buffer.from("catalog-identity-key");
  const boundary = {
    identity: {resolve: (offer, exportContext) => sourceIdentityForOffer(offer, exportContext.supplierRef, key)},
    hash: {sha256: sha256CatalogHash},
    persistence: {
      beginExport: record => { started.push(record); },
      recordBatch: () => {},
      completeExport: () => {},
    },
  };
  registerAromaCatalogExportRoute(app, sourceFactory, boundary, context, supplierRef);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const headers = {"x-service-delegation": delegation("catalog-supplier-sync", "exportAromaCatalog")};
  const foreign = await app.inject({method: "POST", url: "/api/internal-v1/aroma/catalog-exports", headers, payload: {snapshotRef, supplierRef: foreignSupplierRef}});
  assert.equal(foreign.statusCode, 400);
  assert.equal(sourceCalls, 0);
  assert.deepEqual(started, []);
  const first = await app.inject({method: "POST", url: "/api/internal-v1/aroma/catalog-exports", headers, payload: {snapshotRef, supplierRef}});
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body.split("\n")[0]).providerSnapshotRef, `aroma-gateway:catalog-export:${snapshotRef}`);
  const secondSnapshotRef = "snp_01ARZ3NDEKTSV4RRFFQ69G5FAX";
  const second = await app.inject({method: "POST", url: "/api/internal-v1/aroma/catalog-exports", headers, payload: {snapshotRef: secondSnapshotRef, supplierRef}});
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body.split("\n")[0]).providerSnapshotRef, `aroma-gateway:catalog-export:${secondSnapshotRef}`);
  assert.notEqual(JSON.parse(first.body.split("\n")[0]).providerSnapshotRef, JSON.parse(second.body.split("\n")[0]).providerSnapshotRef);
});

void test("foreign binding is rejected before the store, while own supplier reaches it", async t => {
  const app = await createRuntime({name: "scoping-binding-test", ...runtimeOptions});
  app.addHook("preHandler", async request => { request.runtimeContext.transportIdentity = {runtime: "api-internal", environment: "test", san: "spiffe://test/api-internal"}; });
  let storeCalls = 0;
  t.mock.method(OfferBindingStore.prototype, "register", async request => { storeCalls += 1; return {offerRef: request.offerRef, supplierRef: request.supplierRef, sourceIdentityScheme: request.sourceIdentityScheme, sourceOfferKeyHash: request.sourceOfferKeyHash, firstSnapshotRef: request.snapshotRef, state: "Bound"}; });
  registerAromaBindingRoutes(app, {}, context, supplierRef);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  const body = {offerRef, supplierRef, snapshotRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64)};
  const headers = {"x-service-delegation": delegation("catalog-activation-worker", "registerAromaOfferBinding")};
  const foreign = await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers, payload: {...body, supplierRef: foreignSupplierRef}});
  assert.equal(foreign.statusCode, 400);
  assert.equal(storeCalls, 0);
  const own = await app.inject({method: "POST", url: "/api/internal-v1/aroma/offer-bindings", headers, payload: body});
  assert.equal(own.statusCode, 200);
  assert.equal(storeCalls, 1);
});

void test("mutator scopes offer resolution before acquiring a provider session", async () => {
  let sessions = 0;
  let resolverArgs;
  const foreign = new ProviderCartMutator({
    sessions: {acquire: async () => { sessions += 1; throw new Error("must not acquire"); }},
    credentials,
    defaultPacking: "Aroma",
    supplierRef,
    bindings: {resolveProviderOffer: async (...args) => { resolverArgs = args; return {offerRef, supplierRef: foreignSupplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64), rawProviderOfferId: "70", rawProviderProductId: "71", rawProviderVariantId: "70", packing: null, grindId: null, cartLineId: null}; }},
  });
  await assert.rejects(foreign.execute({operationRef: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV", cartScopeRef: scopeRef, operationKind: "RemoveLine", offerRef, quantityMilli: null}, {}, new AbortController().signal), {code: "ProviderCartMappingMissing"});
  assert.deepEqual(resolverArgs.slice(0, 2), [offerRef, supplierRef]);
  assert.equal(sessions, 0);
});

void test("own supplier binding reaches one provider session after scoped resolution", async () => {
  const cart = quantity => ({prices: {total: {default: 0, promo: 0}}, products: [{id: 71, offer: {id: 70, price: 1}, quantity, packing: "Aroma", grind_id: null}]});
  let reads = 0;
  let mutations = 0;
  const identity = {offerRef, supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: "a".repeat(64), rawProviderOfferId: "70", rawProviderProductId: "71", rawProviderVariantId: "70", packing: null, grindId: null, cartLineId: "71"};
  const mutator = new ProviderCartMutator({
    sessions: {acquire: async () => ({read: async function* () { yield bytes(cart(reads++ === 0 ? 1 : 2)); }})},
    credentials,
    defaultPacking: "Aroma",
    supplierRef,
    bindings: {resolveProviderOffer: async (receivedOfferRef, receivedSupplierRef) => { assert.equal(receivedOfferRef, offerRef); assert.equal(receivedSupplierRef, supplierRef); return identity; }},
    transport: {mutate: async () => ({statusCode: 200, body: bytes(cart(2))})},
  });
  const result = await mutator.execute({operationRef: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV", cartScopeRef: scopeRef, operationKind: "SetLineQuantity", offerRef, quantityMilli: "2"}, {}, new AbortController().signal);
  assert.equal(result.state, "Acknowledged");
  assert.equal(mutations, 0);
  assert.equal(reads, 2);
});
