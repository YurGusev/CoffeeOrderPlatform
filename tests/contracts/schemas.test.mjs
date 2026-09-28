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
  assert.equal(schemas.length, 12);
  assert.equal(schemas.filter((schema) => schema.$id.includes("/events/")).length, 8);
  for (const schema of schemas) assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

void test("uri-reference format follows RFC 3986 reference grammar", () => {
  const validate = contractAjv().compile({type: "string", format: "uri-reference"});
  for (const value of ["./1:abc", "/a:b", "//[::1]/", "http://[::1]/", "HTTP://EXAMPLE.COM/problem", "urn:example:test", "/relative/path", "../a?b#c", "a%20b"])
    assert.equal(validate(value), true, JSON.stringify(value));
  const invalid = ["1:abc", ":abc", "/[::1]", "http://[", "/has space", "\\evil.com", "%", "\0", "foo[bar", "foo]bar", "\"foo", "%GG"];
  assert.deepEqual(invalid.filter((value) => validate(value)), [], "accepted invalid URI references");
});

void test("ProblemDetails type and instance use the same URI-reference grammar", async () => {
  const {ajv, schemas} = await loadSchemas();
  const problemSchema = schemas.find((schema) => schema.$id.endsWith("/common/problem-details.v1.schema.json"));
  assert.ok(problemSchema);
  const validate = ajv.getSchema(`${problemSchema.$id}#/$defs/ProblemDetails`);
  assert.ok(validate);
  const base = {
    type: "about:blank",
    title: "VALIDATION_FAILED",
    status: 400,
    code: "VALIDATION_FAILED",
    detail: "Request validation failed",
    instance: "/problems/validation",
    correlationId: "11111111-1111-4111-8111-111111111111",
    errors: [],
  };
  const valid = ["./1:abc", "/a:b", "//[::1]/", "http://[::1]/", "HTTP://EXAMPLE.COM/problem", "urn:example:test", "/relative/path", "../a?b#c", "a%20b"];
  const invalid = ["1:abc", ":abc", "/[::1]", "http://[", "/has space", "\\evil.com", "%", "\0", "foo[bar", "foo]bar", "\"foo", "%GG"];
  for (const field of ["type", "instance"]) {
    for (const value of valid) assert.equal(validate({...base, [field]: value}), true, `${field}: ${JSON.stringify(value)}`);
    const accepted = invalid.filter((value) => validate({...base, [field]: value}));
    assert.deepEqual(accepted, [], `${field}: accepted invalid URI references`);
  }
  assert.equal(validate({...base, title: "😀".repeat(101)}), true);
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

void test("all eight launch event positive fixtures validate", async () => {
  const { ajv, schemas } = await loadSchemas();
  const validators = eventValidators(ajv, schemas);
  const valid = await fixtures(POSITIVE_ROOT);
  assert.equal(valid.length, 8);
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
  assert.equal(invalid.length, 8);
  for (const { name, value } of invalid) {
    const validate = validators.get(value.messageType);
    assert.ok(validate, `${name}: unknown message type`);
    assert.equal(validate(value), false, `${name}: unexpectedly valid`);
  }
});

void test("OrderReconciliationRequested.v1 carries only order-level intent", async () => {
  const { ajv, schemas } = await loadSchemas();
  const validate = eventValidators(ajv, schemas).get("OrderReconciliationRequested.v1");
  assert.ok(validate, "missing reconciliation event schema");
  const event = JSON.parse(await readFile(join(POSITIVE_ROOT, "order-reconciliation-requested.v1.json"), "utf8"));
  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.deepEqual(Object.keys(event.payload).sort(), ["orderRef", "orderVersion", "requestedAt"]);
  assert.deepEqual(event.aggregate, {type: "Order", ref: event.payload.orderRef, version: event.payload.orderVersion});
  for (const changed of [
    {...event, producer: "orders-aroma-preparation"},
    {...event, aggregate: {...event.aggregate, type: "Cart"}},
    {...event, payload: {...event.payload, reason: "OperatorRequested"}},
    {...event, payload: {...event.payload, actorRef: "operator"}},
    {...event, payload: {...event.payload, orderVersion: 7}},
    {...event, payload: {...event.payload, requestedAt: "2026-02-31T00:00:00Z"}},
    {...event, payload: {orderRef: event.payload.orderRef, orderVersion: event.payload.orderVersion}},
  ]) assert.equal(validate(changed), false, `accepted ${JSON.stringify(changed)}`);
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
