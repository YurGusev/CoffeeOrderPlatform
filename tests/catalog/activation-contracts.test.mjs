import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  snapshotActivatedMessage,
  mappingChangedMessage,
} from "../../apps/catalog-activation-worker/dist/events.js";

const root = new URL("../../contracts/schemas/", import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(value),
});
for (const path of [
  "common/identifiers.v1.schema.json",
  "common/money-version-time.v1.schema.json",
  "common/message-envelope.v1.schema.json",
  "events/catalog-snapshot-activated.v1.schema.json",
  "events/catalog-mapping-changed.v2.schema.json",
]) {
  ajv.addSchema(JSON.parse(await readFile(new URL(path, root), "utf8")));
}

const sup = "sup_00000000000000000000000001";
const snp = "snp_00000000000000000000000001";
const product = "prd_00000000000000000000000001";
const variant = "var_00000000000000000000000001";
const offer = "off_00000000000000000000000001";
const shared = {
  supplierRef: sup,
  snapshotRef: snp,
  snapshotRevision: "1",
  occurredAt: "2026-09-23T10:00:00Z",
};
void test("snapshot event validates accepted JSON Schema and rejects full Catalog rows", () => {
  const message = snapshotActivatedMessage({
    ...shared,
    productCount: 1,
    variantCount: 1,
    offerCount: 1,
    batchCount: 1,
    contentHash: "a".repeat(64),
  });
  const schema = ajv.getSchema(
    "https://coffeeorderplatform.local/contracts/schemas/events/catalog-snapshot-activated.v1.schema.json",
  );
  assert.ok(schema);
  assert.equal(schema(message.envelope), true, JSON.stringify(schema.errors));
  const invalid = structuredClone(message.envelope);
  invalid.payload.items = [{ price: "100" }];
  assert.equal(schema(invalid), false);
});

void test("mapping event validates both Active and Missing cases; rejects invalid offer semantics", () => {
  const schema = ajv.getSchema(
    "https://coffeeorderplatform.local/contracts/schemas/events/catalog-mapping-changed.v2.schema.json",
  );
  assert.ok(schema);
  const active = mappingChangedMessage({
    ...shared,
    productRef: product,
    variantRef: variant,
    offerRef: offer,
    mappingRevision: "1",
    mappingState: "Active",
    availability: "Available",
  });
  assert.equal(schema(active.envelope), true, JSON.stringify(schema.errors));
  const missing = mappingChangedMessage({
    ...shared,
    productRef: product,
    variantRef: variant,
    offerRef: null,
    mappingRevision: "2",
    mappingState: "Missing",
    availability: "Unavailable",
  });
  assert.equal(schema(missing.envelope), true, JSON.stringify(schema.errors));
  const invalidMissing = structuredClone(missing.envelope);
  invalidMissing.payload.offerRef = offer;
  assert.equal(schema(invalidMissing), false);
  const invalidActive = structuredClone(active.envelope);
  invalidActive.payload.offerRef = null;
  assert.equal(schema(invalidActive), false);
});
