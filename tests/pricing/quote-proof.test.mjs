import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {hashInternalQuote, hashPublicQuote} from "../../apps/pricing-service/dist/domain/quote-proof.js";

const quote = {
  quoteRef: "prq_0123456789ABCDEFGHJKMNPQRS",
  policyVersionRef: "pol_0123456789ABCDEFGHJKMNPQRS",
  catalogSnapshotRevision: "12",
  customerRef: "cus_0123456789ABCDEFGHJKMNPQRS",
  createdAt: "2026-09-26T00:00:00.000Z",
  expiresAt: "2026-09-26T00:15:00.000Z",
  currency: "RUB",
  lines: [{
    lineNumber: 1,
    productRef: "prd_0123456789ABCDEFGHJKMNPQRS",
    variantRef: "var_0123456789ABCDEFGHJKMNPQRS",
    productDisplayName: "Кофе",
    quantity: "2.5",
    unit: "piece",
    unitMinor: "130",
    lineTotalMinor: "325",
  }],
  totalMinor: "325",
};
const policy = {quoteTtlSeconds: 900, quantityScale: 3, roundingMode: "CEILING"};
const proofLines = [{
  lineNumber: 1,
  offerRef: "off_0123456789ABCDEFGHJKMNPQRS",
  mappingRevision: "3",
  supplierUnitMinor: "100",
  catalogSnapshotRevision: "12",
  markupBasisPoints: "3000",
  minimumMarginMinor: "0",
}];

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

void test("public hash uses exact ordered persisted keys and UTF-8 compact JSON", () => {
  const canonical = '{"quoteRef":"prq_0123456789ABCDEFGHJKMNPQRS","policyVersionRef":"pol_0123456789ABCDEFGHJKMNPQRS","catalogSnapshotRevision":"12","customerRef":"cus_0123456789ABCDEFGHJKMNPQRS","createdAt":"2026-09-26T00:00:00.000Z","expiresAt":"2026-09-26T00:15:00.000Z","currency":"RUB","lines":[{"lineNumber":1,"productRef":"prd_0123456789ABCDEFGHJKMNPQRS","variantRef":"var_0123456789ABCDEFGHJKMNPQRS","productDisplayName":"Кофе","quantity":"2.5","unit":"piece","unitMinor":"130","lineTotalMinor":"325"}],"totalMinor":"325"}';
  assert.equal(hashPublicQuote(quote), sha256(canonical));
  assert.equal(hashPublicQuote({...quote, hash: "untrusted"}), sha256(canonical));
  for (const [field, value] of [["quoteRef", "prq_other"], ["policyVersionRef", "pol_other"], ["catalogSnapshotRevision", "13"], ["customerRef", "cus_other"], ["createdAt", "2026-09-26T00:00:01.000Z"], ["expiresAt", "2026-09-26T00:15:01.000Z"], ["currency", "USD"], ["totalMinor", "326"]]) {
    assert.notEqual(hashPublicQuote({...quote, [field]: value}), sha256(canonical), field);
  }
  for (const [field, value] of [["productRef", "prd_other"], ["variantRef", "var_other"], ["productDisplayName", "Чай"], ["quantity", "3"], ["unit", "gram"], ["unitMinor", "131"], ["lineTotalMinor", "326"]]) {
    assert.notEqual(hashPublicQuote({...quote, lines: [{...quote.lines[0], [field]: value}]}), sha256(canonical), field);
  }
});

void test("private proof commits to each private fact and applied policy", () => {
  const original = hashInternalQuote(quote, policy, proofLines);
  assert.notEqual(original, hashPublicQuote(quote));
  for (const [field, value] of [["offerRef", "off_other"], ["mappingRevision", "4"], ["supplierUnitMinor", "101"], ["catalogSnapshotRevision", "13"], ["markupBasisPoints", "3001"], ["minimumMarginMinor", "1"]]) {
    assert.notEqual(hashInternalQuote(quote, policy, [{...proofLines[0], [field]: value}]), original, field);
  }
  for (const [field, value] of [["quoteTtlSeconds", 901], ["quantityScale", 2], ["roundingMode", "FLOOR"]]) {
    assert.notEqual(hashInternalQuote(quote, {...policy, [field]: value}, proofLines), original, field);
  }
  assert.throws(() => hashInternalQuote(quote, policy, []), /PRICING_PROOF_LINES_INVALID/);
  assert.throws(() => hashInternalQuote(quote, policy, [proofLines[0], proofLines[0]]), /PRICING_PROOF_LINES_INVALID/);
});
