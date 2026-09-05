import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contractAjv } from "../../scripts/contracts-ajv.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCHEMA_ROOT = join(ROOT, "contracts/schemas");
const POSITIVE_ROOT = join(ROOT, "contracts/fixtures/positive/events");
const NEGATIVE_ROOT = join(ROOT, "contracts/fixtures/negative/events");

async function loadSchemas() {
  const files = [];
  for (const directory of ["common", "events"])
    for (const name of await readdir(join(SCHEMA_ROOT, directory)))
      if (name.endsWith(".json")) files.push(join(SCHEMA_ROOT, directory, name));
  const schemas = await Promise.all(
    files.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
  );
  const ajv = contractAjv();
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) ajv.getSchema(schema.$id);
  return { ajv, schemas };
}

function eventValidators(ajv, schemas) {
  return new Map(
    schemas
      .filter((schema) => schema.$id.includes("/events/"))
      .map((schema) => [schema.title, ajv.getSchema(schema.$id)]),
  );
}

async function fixtures(directory) {
  return Promise.all(
    (await readdir(directory)).map(async (name) => ({
      name,
      value: JSON.parse(await readFile(join(directory, name), "utf8")),
    })),
  );
}

void test("common and event schemas compile as strict JSON Schema 2020-12", async () => {
  const { schemas } = await loadSchemas();
  assert.equal(schemas.length, 11);
  assert.equal(schemas.filter((schema) => schema.$id.includes("/events/")).length, 7);
  for (const schema of schemas) assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

void test("event schemas reference common definitions instead of copying them", async () => {
  const {schemas} = await loadSchemas();
  const common = schemas.filter((schema) => schema.$id.includes("/common/"));
  const fingerprints = new Set(common.flatMap((schema) => Object.values(schema.$defs ?? {}).map((definition) => JSON.stringify(definition))));
  const visit = (value, path) => {
    if (!value || typeof value !== "object") return;
    assert.equal(fingerprints.has(JSON.stringify(value)), false, `${path}: local copy of common definition`);
    for (const [name, child] of Object.entries(value)) visit(child, `${path}/${name}`);
  };
  for (const schema of schemas.filter((item) => item.$id.includes("/events/"))) visit(schema, schema.$id);
});

void test("all seven launch event positive fixtures validate", async () => {
  const { ajv, schemas } = await loadSchemas();
  const validators = eventValidators(ajv, schemas);
  const valid = await fixtures(POSITIVE_ROOT);
  assert.equal(valid.length, 7);
  for (const { name, value } of valid) {
    const validate = validators.get(value.messageType);
    assert.ok(validate, `${name}: unknown message type`);
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
  }
});

void test("negative event fixtures fail closed", async () => {
  const { ajv, schemas } = await loadSchemas();
  const validators = eventValidators(ajv, schemas);
  const invalid = await fixtures(NEGATIVE_ROOT);
  assert.equal(invalid.length, 7);
  for (const { name, value } of invalid) {
    const validate = validators.get(value.messageType);
    assert.ok(validate, `${name}: unknown message type`);
    assert.equal(validate(value), false, `${name}: unexpectedly valid`);
  }
});

void test("shared numeric, identity, hash, timestamp and traceparent definitions reject unsafe values", async () => {
  const { ajv } = await loadSchemas();
  const schema = "https://coffeeorderplatform.local/contracts/schemas/common";
  const check = (file, definition, value) => ajv.getSchema(`${schema}/${file}#/$defs/${definition}`)?.(value) ?? false;
  for (const value of ["0", "1", "1000000"]) assert.equal(check("identifiers.v1.schema.json", "Version", value), true);
  for (const value of ["01", "1.0", 1]) assert.equal(check("identifiers.v1.schema.json", "Version", value), false);
  for (const value of ["1", "0.001", "999999.999"]) assert.equal(check("money-version-time.v1.schema.json", "QuantityDecimal", value), true);
  for (const value of ["0", "0.0", "01", "1.0000", "1000000"]) assert.equal(check("money-version-time.v1.schema.json", "QuantityDecimal", value), false);
  assert.equal(check("identifiers.v1.schema.json", "UUID", "11111111-1111-4111-8111-111111111111"), true);
  assert.equal(check("identifiers.v1.schema.json", "UUID", "not-a-uuid"), false);
  assert.equal(check("money-version-time.v1.schema.json", "HashSha256", "a".repeat(64)), true);
  assert.equal(check("money-version-time.v1.schema.json", "HashSha256", "A".repeat(64)), false);
  assert.equal(check("money-version-time.v1.schema.json", "Timestamp", "2026-09-05T10:00:00Z"), true);
  assert.equal(check("money-version-time.v1.schema.json", "Timestamp", "2026-09-05T10:00:00+05:00"), false);
  assert.equal(check("money-version-time.v1.schema.json", "Timestamp", "2026-02-31T00:00:00Z"), false);
  assert.equal(check("money-version-time.v1.schema.json", "Traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"), true);
  assert.equal(check("money-version-time.v1.schema.json", "Traceparent", "00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01"), false);
});
