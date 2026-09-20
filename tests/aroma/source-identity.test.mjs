import assert from "node:assert/strict";
import {createHmac, createSecretKey} from "node:crypto";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {
  SOURCE_ENTITY_TYPES,
  SOURCE_IDENTITY_SCHEME,
  SourceIdentityValidationError,
  createSourceIdentity,
  computeSourceIdentityHash,
  frameSourceIdentityMessage,
  isSourceEntityType,
} from "../../apps/aroma-gateway/dist/domain/source-identity.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_PATH = join(REPO_ROOT, "apps/aroma-gateway/src/domain/source-identity.ts");
const KEY = Buffer.from("source-identity-known-vector-key", "utf8");
const INPUT = {
  supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  entityType: "offer",
  rawProviderIdentifier: "provider-offer-42",
};
const KNOWN_VECTOR = "aeabad28ebc816114fddad10a8e57988f51508728001e9199015a0ab900569e6";

function independentlyFramed(input) {
  return Buffer.concat([
    Buffer.from("hmac-sha256-v1", "utf8"),
    Buffer.from([0x00]),
    Buffer.from(input.supplierRef, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(input.entityType, "utf8"),
    Buffer.from([0x00]),
    Buffer.from(input.rawProviderIdentifier.normalize("NFC"), "utf8"),
  ]);
}

void test("source identity matches an independently computed known vector", () => {
  const message = independentlyFramed(INPUT);
  const expected = createHmac("sha256", KEY).update(message).digest("hex");
  assert.equal(expected, KNOWN_VECTOR);
  assert.equal(computeSourceIdentityHash(INPUT, KEY), KNOWN_VECTOR);
  assert.match(KNOWN_VECTOR, /^[0-9a-f]{64}$/);
});

void test("source identity framing contains three literal NUL bytes", () => {
  const expected = independentlyFramed(INPUT);
  const actual = Buffer.from(frameSourceIdentityMessage(INPUT));
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    [...actual].flatMap((byte, index) => (byte === 0x00 ? [index] : [])),
    ["hmac-sha256-v1".length, "hmac-sha256-v1".length + 1 + INPUT.supplierRef.length, "hmac-sha256-v1".length + 1 + INPUT.supplierRef.length + 1 + INPUT.entityType.length],
  );
  assert.equal(actual.includes(Buffer.from("\\0", "utf8")), false);
});

void test("source identity normalizes provider identifiers to NFC only", () => {
  const decomposed = {...INPUT, rawProviderIdentifier: "cafe\u0301-provider"};
  const composed = {...INPUT, rawProviderIdentifier: "café-provider"};
  assert.equal(computeSourceIdentityHash(decomposed, KEY), computeSourceIdentityHash(composed, KEY));

  const preserved = {...INPUT, rawProviderIdentifier: " Provider-ID 😀 � "};
  assert.deepEqual(
    Buffer.from(frameSourceIdentityMessage(preserved)).subarray(-Buffer.byteLength(preserved.rawProviderIdentifier)),
    Buffer.from(preserved.rawProviderIdentifier, "utf8"),
  );
});

void test("product, variant, offer, and grind remain separate HMAC domains", () => {
  const hashes = SOURCE_ENTITY_TYPES.map((entityType) => computeSourceIdentityHash({...INPUT, entityType}, KEY));
  assert.equal(new Set(hashes).size, SOURCE_ENTITY_TYPES.length);
  assert.equal(isSourceEntityType("product"), true);
  assert.equal(isSourceEntityType("variant"), true);
  assert.equal(isSourceEntityType("offer"), true);
  assert.equal(isSourceEntityType("grind"), true);
  assert.equal(isSourceEntityType("Product"), false);
  assert.equal(isSourceEntityType("variant\u0000"), false);
  assert.equal(isSourceEntityType(null), false);
});

void test("source identity rejects embedded NUL, empty, malformed, and unknown input", () => {
  const invalidInputs = [
    {...INPUT, supplierRef: ""},
    {...INPUT, supplierRef: "supplier-not-a-canonical-ref"},
    {...INPUT, supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FA\u0000"},
    {...INPUT, rawProviderIdentifier: ""},
    ...["\ud800", "offer-\udbff", "\udc00", "\ud800x"].map((rawProviderIdentifier) => ({...INPUT, rawProviderIdentifier})),
    {...INPUT, rawProviderIdentifier: "provider\u0000offer"},
    {...INPUT, entityType: "Product"},
    {...INPUT, entityType: ""},
    {...INPUT, entityType: "offer\u0000"},
    {...INPUT, extra: true},
    {supplierRef: INPUT.supplierRef, entityType: INPUT.entityType},
  ];

  for (const invalid of invalidInputs) {
    assert.throws(
      () => frameSourceIdentityMessage(invalid),
      (error) => error instanceof SourceIdentityValidationError && error.code.startsWith("INVALID_"),
    );
  }

  assert.throws(
    () => computeSourceIdentityHash(INPUT, Buffer.alloc(0)),
    (error) => error instanceof SourceIdentityValidationError && error.code === "INVALID_KEY",
  );
  assert.throws(
    () => computeSourceIdentityHash(INPUT, createSecretKey(Buffer.alloc(0))),
    (error) => error instanceof SourceIdentityValidationError && error.code === "INVALID_KEY",
  );
  assert.throws(
    () => computeSourceIdentityHash(INPUT, "super-secret-key"),
    (error) => error instanceof SourceIdentityValidationError && error.code === "INVALID_KEY" && !String(error).includes("super-secret-key"),
  );
});

void test("identity creation returns proof only and never creates a variant ID", () => {
  const identity = createSourceIdentity({
    ...INPUT,
    entityType: "variant",
    sourceIdentityKey: KEY,
  });
  assert.deepEqual(identity, {
    sourceIdentityScheme: SOURCE_IDENTITY_SCHEME,
    sourceIdentityHash: computeSourceIdentityHash({...INPUT, entityType: "variant"}, KEY),
  });
  assert.equal("variantId" in identity, false);
  assert.equal("variantRef" in identity, false);
  assert.equal("offerRef" in identity, false);
});

void test("source identity helper has no logging path for its dedicated key input", async () => {
  const source = await readFile(SOURCE_PATH, "utf8");
  assert.doesNotMatch(source, /\bconsole\s*\.|\blogger\s*\./u);
});
