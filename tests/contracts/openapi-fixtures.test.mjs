import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import test from "node:test";
import yaml from "js-yaml";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OPENAPI_ROOT = join(ROOT, "contracts/openapi");
const COMMON_ROOT = join(ROOT, "contracts/schemas/common");
const POSITIVE_ROOT = join(ROOT, "contracts/fixtures/positive");
const NEGATIVE_ROOT = join(ROOT, "contracts/fixtures/negative");
const DOCUMENTS = new Map();
const DOCUMENT_PATHS = new Map([
  ["client-v1", join(OPENAPI_ROOT, "client-v1.yaml")],
  ["internal-v1", join(OPENAPI_ROOT, "internal-v1.yaml")],
]);

function pointer(value, fragment) {
  if (!fragment || fragment === "#") return value;
  return fragment.slice(2).split("/").reduce((current, part) => current[part.replaceAll("~1", "/").replaceAll("~0", "~")], value);
}

function reference(ref, fromPath) {
  const [source, fragment] = ref.split("#");
  const path = normalize(source ? resolve(dirname(fromPath), source) : fromPath);
  const document = DOCUMENTS.get(path);
  if (!document) throw new Error(`unresolved schema reference ${ref} from ${fromPath}`);
  return {path, value: pointer(document, fragment ? `#${fragment}` : "#")};
}

function inline(value, fromPath, stack = []) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => inline(item, fromPath, stack));
  if (value.$ref) {
    const key = `${fromPath}:${value.$ref}`;
    if (stack.includes(key)) throw new Error(`cyclic schema reference ${key}`);
    const target = reference(value.$ref, fromPath);
    return inline(target.value, target.path, [...stack, key]);
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "discriminator").map(([key, item]) => [key, inline(item, fromPath, stack)]));
}

function refName(schema) {
  const ref = schema?.$ref;
  return ref?.startsWith("#/components/schemas/") ? ref.split("/").at(-1) : undefined;
}

function schemaNames(schema) {
  if (schema?.$ref) return refName(schema) ? [refName(schema)] : [];
  return [...(schema?.oneOf ?? []), ...(schema?.anyOf ?? [])].flatMap((item) => schemaNames(item));
}

function operationEntries(documentName) {
  const path = DOCUMENT_PATHS.get(documentName);
  const document = DOCUMENTS.get(path);
  return Object.entries(document.paths).flatMap(([route, pathItem]) => Object.entries(pathItem)
    .filter(([method]) => ["get", "post", "put", "delete"].includes(method))
    .map(([method, operation]) => ({documentName, path, route, method, operation})));
}

function findOperation(documentName, operationId) {
  const found = operationEntries(documentName).find(({operation}) => operation.operationId === operationId);
  assert.ok(found, `${documentName}:${operationId} is not in OpenAPI`);
  return found;
}

function responseObject(operation, status, path) {
  const response = operation.responses[String(status)];
  assert.ok(response, `${operation.operationId}: missing response ${status}`);
  return response.$ref ? reference(response.$ref, path).value : response;
}

function responseMedia(documentName, operationId, status, mediaType) {
  const {operation, path, route} = findOperation(documentName, operationId);
  const response = responseObject(operation, status, path);
  const media = response.content?.[mediaType];
  if (!media) throw new Error(`${documentName}:${operationId}:${status} ${route}: unsupported representation ${mediaType}`);
  return {media, operation, path, response};
}

function componentSchema(documentName, schemaName) {
  const path = DOCUMENT_PATHS.get(documentName);
  const document = DOCUMENTS.get(path);
  assert.ok(document.components.schemas[schemaName], `${documentName}: missing schema ${schemaName}`);
  return inline(document.components.schemas[schemaName], path);
}

function loadValidator(ajv, documentName, schemaName) {
  return ajv.compile(componentSchema(documentName, schemaName));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertRoundTrip(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON encode/decode changed value`);
}

function setPath(value, path, next) {
  const parent = path.slice(0, -1).reduce((current, part) => current[part], value);
  parent[path.at(-1)] = next;
}

function deletePath(value, path) {
  const parent = path.slice(0, -1).reduce((current, part) => current[part], value);
  delete parent[path.at(-1)];
}

function applyMutations(value, fixture) {
  const result = clone(value);
  for (const path of fixture.delete ?? []) deletePath(result, path);
  for (const [path, next] of fixture.set ?? []) setPath(result, path, next);
  for (const [path, next] of fixture.add ?? []) setPath(result, path, next);
  return result;
}

async function jsonFixture(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  assert.ok(Array.isArray(value), `${path}: fixture must be an array`);
  return value;
}

async function loadCorpus() {
  for (const path of DOCUMENT_PATHS.values()) DOCUMENTS.set(path, yaml.load(await readFile(path, "utf8")));
  for (const fileName of await readdir(COMMON_ROOT)) {
    if (fileName.endsWith(".json")) {
      const path = join(COMMON_ROOT, fileName);
      DOCUMENTS.set(path, JSON.parse(await readFile(path, "utf8")));
    }
  }
  const ajv = new Ajv2020({allErrors: true, strict: true, strictRequired: false, validateFormats: false});
  return {ajv, success: await jsonFixture(join(POSITIVE_ROOT, "http/success.json")), problems: await jsonFixture(join(POSITIVE_ROOT, "http/problems.json"))};
}

function successOperations() {
  return ["client-v1", "internal-v1"].flatMap((documentName) => operationEntries(documentName)
    .flatMap(({operation, ...entry}) => Object.entries(operation.responses)
      .filter(([status]) => status.startsWith("2"))
      .flatMap(([status]) => Object.keys(responseObject(operation, status, entry.path).content ?? {})
        .map((mediaType) => ({...entry, operation, status: Number(status), mediaType, schema: responseMedia(documentName, operation.operationId, status, mediaType).media.schema})))));
}

function problemVariants() {
  return ["client-v1", "internal-v1"].flatMap((documentName) => operationEntries(documentName).flatMap(({operation, path}) => Object.entries(operation.responses).flatMap(([status]) => {
    const response = responseObject(operation, status, path);
    return Object.entries(response.content ?? {}).filter(([mediaType]) => mediaType === "application/problem+json").flatMap(([, media]) => schemaNames(media.schema).map((schema) => ({documentName, operationId: operation.operationId, status: Number(status), schema})));
  })));
}

void test("HTTP success fixtures cover every OpenAPI success representation", async () => {
  const {success, ajv} = await loadCorpus();
  const byKey = new Map(success.map((fixture) => [`${fixture.document}|${fixture.operationId}|${fixture.status}|${fixture.mediaType}`, fixture]));
  assert.equal(byKey.size, success.length, "duplicate success fixture key");
  for (const expected of successOperations()) {
    const key = `${expected.documentName}|${expected.operation.operationId}|${expected.status}|${expected.mediaType}`;
    const fixture = byKey.get(key);
    assert.ok(fixture, `${key}: missing success fixture`);
    assert.equal(fixture.schema, refName(expected.schema) ?? fixture.schema, `${key}: schema mismatch`);
    if (fixture.streamFixture) continue;
    const validate = loadValidator(ajv, fixture.document, fixture.schema);
    assert.equal(validate(fixture.body), true, `${key}: ${JSON.stringify(validate.errors)}`);
  }
  assert.equal(byKey.size, successOperations().length, "unmapped success fixture");
});

void test("Problem fixtures cover every operation response variant and exact status/code", async () => {
  const {problems, ajv} = await loadCorpus();
  const expected = problemVariants();
  const expectedKeys = new Set(expected.map(({documentName, schema}) => `${documentName}|${schema}`));
  const seen = new Set();
  for (const fixture of problems) {
    const key = `${fixture.document}|${fixture.schema}`;
    assert.ok(expectedKeys.has(key), `${key}: not an operation Problem variant`);
    assert.equal(seen.has(key), false, `${key}: duplicate Problem fixture`);
    seen.add(key);
    const allowed = expected.some((item) => item.documentName === fixture.document && item.operationId === fixture.operationId && item.status === fixture.status && item.schema === fixture.schema);
    assert.equal(allowed, true, `${key}: fixture is not allowed at ${fixture.operationId}:${fixture.status}`);
    const validate = loadValidator(ajv, fixture.document, fixture.schema);
    assert.equal(validate(fixture.body), true, `${key}: ${JSON.stringify(validate.errors)}`);
    assert.equal(fixture.body.status, fixture.status);
  }
  assert.deepEqual(seen, expectedKeys, "missing Problem variant fixture");
});

void test("positive wire fixtures survive encode/decode round-trip", async () => {
  const {success, problems} = await loadCorpus();
  for (const fixture of [...success, ...problems]) if (fixture.body) assertRoundTrip(fixture.body, `${fixture.document}:${fixture.operationId}:${fixture.status}`);
  for (const frame of await jsonFixture(join(POSITIVE_ROOT, "sse/order-invalidations.json"))) assertRoundTrip(frame, `SSE:${frame.event ?? "heartbeat"}`);
  for (const [index, line] of (await readFile(join(POSITIVE_ROOT, "ndjson/aroma-catalog-success.ndjson"), "utf8")).trim().split("\n").entries()) assertRoundTrip(JSON.parse(line), `NDJSON:${index + 1}`);
});

void test("SSE fixtures enforce ready/reset/invalidation/heartbeat wire rules", async () => {
  const {ajv} = await loadCorpus();
  const frames = await jsonFixture(join(POSITIVE_ROOT, "sse/order-invalidations.json"));
  assert.deepEqual(frames.map((frame) => frame.event ?? "heartbeat"), ["stream-ready.v1", "resource-invalidated.v1", "stream-reset.v1", "heartbeat"]);
  const ready = loadValidator(ajv, "client-v1", "SseStreamReady");
  const invalidated = loadValidator(ajv, "client-v1", "SseResourceInvalidated");
  const reset = loadValidator(ajv, "client-v1", "SseStreamReset");
  assert.equal(ready(frames[0].data), true, JSON.stringify(ready.errors));
  assert.equal(invalidated(frames[1].data), true, JSON.stringify(invalidated.errors));
  assert.equal(reset(frames[2].data), true, JSON.stringify(reset.errors));
  assert.equal("id" in frames[0], false);
  assert.equal("id" in frames[2], false);
  assert.equal(frames[1].id.startsWith("msg_"), true);
  assert.equal(frames[1].retry, 3000);
  assert.equal(frames[3].intervalSeconds, 15);
});

void test("NDJSON success stream validates every record and terminal ordering", async () => {
  const {ajv} = await loadCorpus();
  const lines = (await readFile(join(POSITIVE_ROOT, "ndjson/aroma-catalog-success.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.recordType), ["snapshot-started", "snapshot-batch", "snapshot-completed"]);
  const validate = loadValidator(ajv, "internal-v1", "AromaCatalogExportRecord");
  for (const [index, line] of lines.entries()) assert.equal(validate(line), true, `line ${index + 1}: ${JSON.stringify(validate.errors)}`);
  assert.equal(new Set(lines.map((line) => line.snapshotRef)).size, 1);
  assert.equal(lines[1].batchNumber, 0);
  assert.equal(lines[1].previousBatchHash, null);
  assert.equal(lines.at(-1).recordType, "snapshot-completed");
});

void test("negative HTTP fixtures fail closed across trust and representation boundaries", async () => {
  const {ajv, success, problems} = await loadCorpus();
  const negatives = await jsonFixture(join(NEGATIVE_ROOT, "http/rejections.json"));
  const successByKey = new Map(success.map((fixture) => [`${fixture.document}|${fixture.operationId}|${fixture.status}|${fixture.schema}`, fixture]));
  const problemByKey = new Map(problems.map((fixture) => [`${fixture.document}|${fixture.operationId}|${fixture.status}|${fixture.schema}`, fixture]));
  const requiredCases = new Set(["missing-field", "additional-field", "invalid-ref-ulid", "invalid-uuid", "invalid-hash", "invalid-traceparent", "invalid-timestamp", "numeric-version", "numeric-money", "numeric-quantity", "noncanonical-decimal", "invalid-enum", "invalid-cross-field", "actor-provider-credentials-public", "wrong-problem-status", "wrong-problem-code", "unsupported-representation", "pii-secret-provider-body-sse"]);
  assert.deepEqual(new Set(negatives.map((fixture) => fixture.case)), requiredCases);
  for (const fixture of negatives) {
    if (fixture.case === "unsupported-representation") {
      assert.throws(() => responseMedia(fixture.document, fixture.operationId, fixture.status, fixture.mediaType), new RegExp(`${fixture.operationId}.*${fixture.mediaType}`));
      continue;
    }
    if (fixture.target === "common") {
      const validate = loadValidator(ajv, fixture.document, fixture.schema);
      assert.equal(validate(fixture.value), false, `${fixture.case}: unexpectedly valid`);
      continue;
    }
    let body;
    if (fixture.target === "request") {
      const {operation} = findOperation(fixture.document, fixture.operationId);
      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      assert.equal(refName(schema), fixture.schema, `${fixture.case}: request schema mismatch`);
      body = fixture.body;
    }
    else if (fixture.streamFile) {
      const frames = await jsonFixture(join(POSITIVE_ROOT, `sse/${fixture.streamFile}`));
      body = frames[fixture.streamIndex].data;
    }
    else {
      const base = fixture.baseProblem ? problemByKey.get(fixture.baseProblem) : successByKey.get(fixture.base);
      assert.ok(base, `${fixture.case}: missing mutation base`);
      body = base.body;
    }
    const validate = loadValidator(ajv, fixture.document, fixture.schema);
    assert.equal(validate(applyMutations(body, fixture)), false, `${fixture.case}: unexpectedly valid`);
  }
});

void test("negative SSE and NDJSON fixtures reject unsafe wire shapes and order", async () => {
  const {ajv} = await loadCorpus();
  const frames = await jsonFixture(join(POSITIVE_ROOT, "sse/order-invalidations.json"));
  const negatives = await jsonFixture(join(NEGATIVE_ROOT, "sse/rejections.json"));
  for (const fixture of negatives) {
    const frame = applyMutations(frames[fixture.streamIndex], fixture);
    if (fixture.heartbeat) assert.notEqual(frame.intervalSeconds, 15, fixture.case);
    else if (fixture.case === "invalidation-wrong-retry") assert.notEqual(frame.retry, 3000, fixture.case);
    else assert.equal("id" in frame, true, fixture.case);
  }
  const lines = (await readFile(join(NEGATIVE_ROOT, "ndjson/aroma-catalog-invalid.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const validate = loadValidator(ajv, "internal-v1", "AromaCatalogExportRecord");
  assert.equal(validate(lines[0]), false, JSON.stringify(validate.errors));
  assert.notEqual(lines[0].recordType, "snapshot-started");
});
