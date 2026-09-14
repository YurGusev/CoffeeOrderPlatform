import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {ProviderError} from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import {ProviderCartReader} from "../../apps/aroma-gateway/dist/application/cart-reader.js";

const capture = async (name) => JSON.parse(await readFile(new URL(`../../evidence/aroma-provider/2026-09-12-cart-mutations/${name}`, import.meta.url), "utf8"));
const sessionFor = (body) => ({read: async function* () { yield Buffer.from(JSON.stringify(body), "utf8"); }});
const reader = (body, resolve, now = "2026-09-12T16:20:00Z") => new ProviderCartReader({
  sessions: {acquire: async () => sessionFor(body)},
  credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
  bindings: {resolveByRawProviderOfferId: resolve},
  now: () => now,
});

void test("cart reader maps provider offer IDs through bindings and derives a Gateway snapshot reference", async () => {
  const body = await capture("add-one-get.json");
  const calls = [];
  const result = await reader(body, async (rawProviderOfferId) => {
    calls.push(rawProviderOfferId);
    return {offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: {offerId: rawProviderOfferId, packing: "Aroma", grindId: null}};
  }).read();
  assert.deepEqual(calls, ["300000"]);
  assert.deepEqual(result.lines, [{offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", quantity: "1"}]);
  assert.match(result.providerSnapshotRef, /^aroma-gateway:cart-body-sha256:[a-f0-9]{64}$/u);
  assert.match(result.cartFingerprint, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(result), /300000|300001|852\.6/u);
});

void test("complete empty cart is valid, while missing binding and duplicate mapped identity fail closed", async () => {
  const empty = await reader(await capture("initial-cart.json"), async () => { throw new Error("binding must not be called"); }).read();
  assert.deepEqual(empty.lines, []);

  const body = await capture("add-one-get.json");
  await assert.rejects(reader(body, async () => undefined).read(), {code: "ProviderCartMappingMissing"});
  const ambiguous = {...body, products: [
    {...body.products[0], id: body.products[0].id + 1, offer: {...body.products[0].offer, id: body.products[0].offer.id + 1}},
    body.products[0],
  ]};
  await assert.rejects(reader(ambiguous, async (rawProviderOfferId) => ({offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: {offerId: rawProviderOfferId, packing: "Aroma", grindId: null}})).read(), {code: "ProviderCartMappingAmbiguous"});
});

void test("cart reader rejects independently changed packing or grind identity without a snapshot", async () => {
  const body = await capture("add-one-get.json");
  const original = body.products[0];
  const binding = (rawProviderOfferId) => ({offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: {
    offerId: rawProviderOfferId,
    packing: original.packing,
    grindId: original.grind_id,
  }});
  for (const [field, value] of [["packing", "UnsupportedPacking"], ["grind_id", "unsupported-grind"]]) {
    const changed = {...body, products: [{...original, [field]: value}]};
    await assert.rejects(reader(changed, async (rawProviderOfferId) => binding(rawProviderOfferId)).read(), {code: "ProviderCartMappingMissing"});
  }
});

void test("cart reader accepts a full-identity resolver mapping", async () => {
  const body = await capture("add-one-get.json");
  const identities = [];
  const result = await new ProviderCartReader({
    sessions: {acquire: async () => sessionFor(body)},
    credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
    bindings: {
      resolveByRawProviderOfferId: async () => { throw new Error("raw-only lookup must not be used"); },
      resolveByProviderIdentity: async (identity) => { identities.push(identity); return {offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: identity}; },
    },
  }).read();
  assert.deepEqual(identities, [{offerId: "300000", packing: "Aroma", grindId: null}]);
  assert.deepEqual(result.lines, [{offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", quantity: "1"}]);
});

void test("cart reader captures freshness at provider-body completion before binding lookup", async () => {
  const body = await capture("add-one-get.json");
  const events = [];
  let nowCalls = 0;
  const result = await new ProviderCartReader({
    sessions: {acquire: async () => ({read: async function* () { yield Buffer.from(JSON.stringify(body), "utf8"); events.push("provider-body-complete"); }})},
    credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
    bindings: {
      resolveByRawProviderOfferId: async () => {
        events.push("binding-lookup");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: {offerId: "300000", packing: "Aroma", grindId: null}};
      },
    },
    now: () => {
      nowCalls += 1;
      events.push("captured-at");
      return "2026-09-12T16:20:00Z";
    },
  }).read();
  assert.equal(nowCalls, 1);
  assert.deepEqual(events, ["provider-body-complete", "captured-at", "binding-lookup"]);
  assert.equal(result.capturedAt, "2026-09-12T16:20:00Z");
});

void test("cart reader uses one bounded bulk exact-identity lookup and preserves result order", async () => {
  const first = await capture("add-one-get.json");
  const second = {...first.products[0], id: first.products[0].id + 1, offer: {...first.products[0].offer, id: first.products[0].offer.id + 1}};
  const body = {...first, products: [first.products[0], second]};
  const calls = [];
  const result = await new ProviderCartReader({
    sessions: {acquire: async () => sessionFor(body)},
    credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
    bindings: {
      resolveByRawProviderOfferId: async () => { throw new Error("per-line lookup must not be used"); },
      resolveByProviderIdentities: async (identities, supplierRef) => {
        calls.push({identities, supplierRef});
        return identities.map((identity, index) => ({
          offerRef: `off_01ARZ3NDEKTSV4RRFFQ69G5FA${index + 1}`,
          supplierRef,
          providerIdentity: identity,
        }));
      },
    },
  }).read();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identities.length, 2);
  assert.deepEqual(result.lines.map((line) => line.offerRef), ["off_01ARZ3NDEKTSV4RRFFQ69G5FA1", "off_01ARZ3NDEKTSV4RRFFQ69G5FA2"]);
});

void test("cart reader fails closed when a bulk identity is missing or crosses supplier", async () => {
  const body = await capture("add-one-get.json");
  for (const binding of [undefined, {offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", supplierRef: "sup_foreign", providerIdentity: {offerId: "300000", packing: "Aroma", grindId: null}}]) {
    const reader = new ProviderCartReader({
      sessions: {acquire: async () => sessionFor(body)},
      credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
      bindings: {
        resolveByRawProviderOfferId: async () => { throw new Error("per-line lookup must not be used"); },
        resolveByProviderIdentities: async () => [binding],
      },
    });
    await assert.rejects(reader.read(), {code: "ProviderCartMappingMissing"});
  }
});

void test("partial provider stream never becomes empty cart", async () => {
  const body = await capture("initial-cart.json");
  const result = new ProviderCartReader({
    sessions: {acquire: async () => ({read: async function* () { yield Buffer.from("{\"products\":[]", "utf8"); throw new ProviderError("ProviderReadIncomplete", true); }})},
    credentials: {scopeRef: "aroma-development", email: "canonical@example.test", password: "not-used-by-test"},
    bindings: {resolveByRawProviderOfferId: async () => undefined},
  });
  await assert.rejects(result.read(), {code: "ProviderReadIncomplete"});
  assert.notEqual(body, undefined);
});

const supportedBinding = (rawProviderOfferId) => ({offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", providerIdentity: {offerId: rawProviderOfferId, packing: "Aroma", grindId: null}});

void test("cart fingerprint is canonical over provider line order", async () => {
  const body = await capture("add-one-get.json");
  const first = await reader(body, async (rawProviderOfferId) => supportedBinding(rawProviderOfferId)).read();
  const reordered = {...body, products: [...body.products].reverse()};
  const second = await reader(reordered, async (rawProviderOfferId) => supportedBinding(rawProviderOfferId)).read();
  assert.equal(first.cartFingerprint, second.cartFingerprint);
  assert.equal(createHash("sha256").update(JSON.stringify([{offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", quantity: "1"}])).digest("hex"), first.cartFingerprint);
});
