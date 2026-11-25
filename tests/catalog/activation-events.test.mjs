import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  snapshotActivatedMessage,
  mappingChangedMessage,
  newCatalogRef,
} from "../../apps/catalog-activation-worker/dist/domain/events.js";

const suffix = "0".repeat(26);
const supplierRef = `sup_${suffix}`;
const snapshotRef = `snp_${suffix}`;
const productRef = `prd_${suffix}`;
const variantRef = `var_${suffix}`;
const offerRef = `off_${suffix}`;
const occurredAt = "2026-09-23T00:00:00.000Z";

const shared = { supplierRef, snapshotRef, snapshotRevision: "1", occurredAt };
const fixtureRoot = new URL(
  "../../contracts/fixtures/positive/events/",
  import.meta.url,
);

void test("owner refs use contract ULID alphabet, prefix and non-repeating secure randomness", () => {
  for (const prefix of ["prd", "var", "off", "msg"]) {
    const first = newCatalogRef(prefix);
    assert.match(first, new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    assert.notEqual(first, newCatalogRef(prefix));
  }
});

void test("snapshot Outbox event carries only committed revision summary and supplier key", () => {
  const message = snapshotActivatedMessage({
    ...shared,
    productCount: 1,
    variantCount: 1,
    offerCount: 1,
    batchCount: 1,
    contentHash: "a".repeat(64),
  });
  assert.equal(message.topic, "coffee.catalog.snapshot.v1");
  assert.equal(message.partitionKey, supplierRef);
  assert.equal(message.aggregateRef, snapshotRef);
  assert.equal(message.aggregateSequence, 1n);
  const later = snapshotActivatedMessage({
    ...shared,
    snapshotRevision: "2",
    productCount: 1,
    variantCount: 1,
    offerCount: 1,
    batchCount: 1,
    contentHash: "a".repeat(64),
  });
  assert.equal(later.aggregateSequence, 1n);
  assert.equal(later.envelope.aggregate.version, "2");
  assert.deepEqual(Object.keys(message.payload).sort(), [
    "activatedAt",
    "batchCount",
    "contentHash",
    "offerCount",
    "productCount",
    "snapshotRef",
    "snapshotRevision",
    "supplierRef",
    "variantCount",
  ]);
  assert.equal(message.envelope.messageId, message.messageId);
  assert.equal(message.envelope.payload.snapshotRevision, "1");
  assert.equal(message.envelope.producer, "catalog-activation-worker");
});

void test("mapping event sends changed refs/state only, with product key and decimal mapping revision", () => {
  const active = mappingChangedMessage({
    ...shared,
    productRef,
    variantRef,
    offerRef,
    mappingRevision: "1",
    mappingState: "Active",
    availability: "Available",
  });
  assert.equal(active.topic, "coffee.catalog.mapping.v2");
  assert.equal(active.partitionKey, productRef);
  assert.equal(active.aggregateRef, productRef);
  assert.deepEqual(Object.keys(active.payload).sort(), [
    "availability",
    "catalogSnapshotRevision",
    "effectiveAt",
    "mappingRevision",
    "mappingState",
    "offerRef",
    "productRef",
    "variantRef",
  ]);
  const missing = mappingChangedMessage({
    ...shared,
    productRef,
    variantRef,
    offerRef: null,
    mappingRevision: "2",
    mappingState: "Missing",
    availability: "Unavailable",
  });
  assert.equal(missing.payload.offerRef, null);
  assert.equal(missing.aggregateSequence, 2n);
  assert.throws(() =>
    mappingChangedMessage({
      ...shared,
      productRef,
      variantRef,
      offerRef: null,
      mappingRevision: "2",
      mappingState: "Active",
      availability: "Available",
    }),
  );
});

void test("Catalog aggregate metadata matches accepted event fixtures", async () => {
  const snapshot = JSON.parse(
    await readFile(
      new URL("catalog-snapshot-activated.v1.json", fixtureRoot),
      "utf8",
    ),
  );
  const activated = snapshotActivatedMessage({
    ...snapshot.payload,
    occurredAt: snapshot.occurredAt,
  });
  assert.deepEqual(activated.envelope.aggregate, snapshot.aggregate);
  assert.equal(activated.partitionKey, snapshot.payload.supplierRef);
  const mapping = JSON.parse(
    await readFile(
      new URL("catalog-mapping-changed.v2.json", fixtureRoot),
      "utf8",
    ),
  );
  const changed = mappingChangedMessage({
    ...mapping.payload,
    supplierRef: snapshot.payload.supplierRef,
    snapshotRef: snapshot.payload.snapshotRef,
    snapshotRevision: mapping.payload.catalogSnapshotRevision,
    occurredAt: mapping.occurredAt,
    productSequence: mapping.aggregate.version,
  });
  assert.deepEqual(changed.envelope.aggregate, mapping.aggregate);
  assert.equal(changed.partitionKey, mapping.payload.productRef);
});

void test("product aggregate sequence is independent of variant mapping revision", () => {
  const changed = mappingChangedMessage({
    ...shared,
    productRef,
    variantRef,
    offerRef,
    mappingRevision: "1",
    mappingState: "Active",
    availability: "Available",
    productSequence: "3",
  });
  assert.equal(changed.aggregateSequence, 3n);
  assert.equal(changed.ownerVersion, "3");
  assert.equal(changed.payload.mappingRevision, "1");
});
