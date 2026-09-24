import assert from "node:assert/strict";
import {test} from "node:test";
import {semanticFingerprint} from "../../apps/catalog-activation-worker/dist/identity.js";

const P = "1".repeat(64);
const V = "2".repeat(64);
const O = "3".repeat(64);

void test("fingerprint includes only immutable relationships and unit, never mutable price/availability/name/image", () => {
  const variant = {entityType:"variant", sourceHash:V, parentHash:P, unit:"piece"};
  assert.equal(semanticFingerprint(variant), semanticFingerprint({...variant, displayName:"Новый кофе", price:"999", availability:"Stopped", imageUrl:null}));
  assert.notEqual(semanticFingerprint(variant), semanticFingerprint({...variant, parentHash:O}));
  assert.notEqual(semanticFingerprint(variant), semanticFingerprint({...variant, unit:"gram"}));
  const offer = {entityType:"offer", sourceHash:O, parentHash:V};
  assert.equal(semanticFingerprint(offer), semanticFingerprint({...offer, price:"1", availability:"Unavailable"}));
  assert.notEqual(semanticFingerprint(offer), semanticFingerprint({...offer, parentHash:P}));
  assert.notEqual(semanticFingerprint({entityType:"product", sourceHash:P}), semanticFingerprint({entityType:"offer", sourceHash:P, parentHash:V}));
});
