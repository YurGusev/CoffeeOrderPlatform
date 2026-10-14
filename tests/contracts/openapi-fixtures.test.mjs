import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";
import { contractAjv } from "../../scripts/contracts-ajv.mjs";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import { clientV1Schemas } from "../../packages/generated/client-v1/src/runtime-schemas.gen.ts";
import {pricingContractSchemas, isPricingQuoteCreateRequest, isPricingQuoteResponse, isPricingQuoteVerifyRequest, isPricingQuoteVerificationResponse, isPricingProblem, pricingResponseSchema} from "../../packages/contracts/pricing-v1/dist/index.js";

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

function assertRoundTrip(value, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON encode/decode changed value`);
}

function encodeSseFrame(frame) {
  if (frame.comment) {
    if (frame.comment !== "heartbeat" || frame.intervalSeconds !== 15 || Object.keys(frame).some((key) => !["comment", "intervalSeconds"].includes(key))) throw new Error("invalid heartbeat frame");
    return ": heartbeat\n\n";
  }
  if (!["stream-ready.v1", "resource-invalidated.v1", "stream-reset.v1"].includes(frame.event)) throw new Error("invalid SSE event");
  if (frame.event !== "resource-invalidated.v1" && "id" in frame) throw new Error("SSE id is forbidden");
  if (frame.event === "resource-invalidated.v1" && frame.retry !== 3000) throw new Error("invalid SSE retry");
  return `${frame.event ? `event: ${frame.event}\n` : ""}${frame.id ? `id: ${frame.id}\n` : ""}${frame.retry ? `retry: ${frame.retry}\n` : ""}data: ${JSON.stringify(frame.data)}\n\n`;
}

function decodeSse(wire) {
  return wire.trimEnd().split("\n\n").map((block) => {
    if (block === ": heartbeat") return {comment: "heartbeat", intervalSeconds: 15};
    const frame = {};
    for (const line of block.split("\n")) {
      const [field, ...parts] = line.split(":");
      const value = parts.join(":").trimStart();
      if (field === "data") frame.data = JSON.parse(value);
      else if (field === "retry") frame.retry = Number(value);
      else if (["event", "id"].includes(field)) frame[field] = value;
      else throw new Error(`unsupported SSE field ${field}`);
    }
    return frame;
  });
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
  const result = structuredClone(value);
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
  const ajv = contractAjv({strictRequired: false});
  const problems = await jsonFixture(join(POSITIVE_ROOT, "http/problems.json"));
  problems.push({
    document: "client-v1",
    operationId: "createPricingQuote",
    status: 503,
    schema: "ErrorPricingPolicyUnavailable",
    body: {
      type: "about:blank",
      title: "PRICING_POLICY_UNAVAILABLE",
      status: 503,
      code: "PRICING_POLICY_UNAVAILABLE",
      detail: "Pricing policy is unavailable",
      instance: "/api/client-v1/pricing/quotes",
      correlationId: "11111111-1111-4111-8111-111111111111",
      errors: [],
    },
  });
  return {ajv, success: await jsonFixture(join(POSITIVE_ROOT, "http/success.json")), problems};
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

void test("CustomerCreateRequest requires at least one contact from the source schema", async () => {
  const {ajv} = await loadCorpus();
  const validate = loadValidator(ajv, "client-v1", "CustomerCreateRequest");
  for (const body of [
    {displayName: "Клиент", phone: "+79991234567"},
    {displayName: "Клиент", email: "client@example.test"},
    {displayName: "Клиент", phone: "+79991234567", email: "client@example.test"},
  ]) assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(validate({displayName: "Клиент"}), false);
});

void test("Pricing runtime guards use generated OpenAPI schemas and reject private leakage", async () => {
  const {success, problems} = await loadCorpus();
  const publicQuote = success.find((item) => item.operationId === "createPricingQuote").body;
  const verifiedQuote = success.find((item) => item.operationId === "verifyPricingQuote").body;
  const line = publicQuote.lines[0];
  const create = {customerRef: publicQuote.customerRef, lines: [{productRef: line.productRef, variantRef: line.variantRef, quantity: line.quantity}]};
  const verify = {quoteRef: publicQuote.quoteRef, hash: publicQuote.hash, customerRef: publicQuote.customerRef, quoteLineNumber: verifiedQuote.line.lineNumber, productRef: verifiedQuote.line.productRef, variantRef: verifiedQuote.line.variantRef, quantity: verifiedQuote.line.quantity};
  const problem = problems.find((item) => item.document === "client-v1").body;

  assert.equal(isPricingQuoteCreateRequest(create), true);
  assert.equal(isPricingQuoteCreateRequest({...create, lines: [create.lines[0], {...create.lines[0], variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAZ"}]}), true, "same product with distinct variant");
  assert.equal(isPricingQuoteResponse(publicQuote), true);
  assert.equal(isPricingQuoteVerifyRequest(verify), true);
  assert.equal(isPricingQuoteVerificationResponse(verifiedQuote), true);
  assert.equal(isPricingProblem(problem), true);
  assert.equal(pricingContractSchemas.createRequest.properties.lines.items.properties.quantity.type, "string");
  assert.equal(pricingContractSchemas.verifyRequest.properties.quoteLineNumber.minimum, 1);
  assert.equal(pricingContractSchemas.verifyRequest.properties.quoteLineNumber.maximum, 100);
  assert.equal(pricingContractSchemas.verifyRequest.properties.quantity.type, "string");
  assert.equal(pricingContractSchemas.verifyRequest.additionalProperties, false);
  assert.deepEqual(pricingResponseSchema(pricingContractSchemas.response, 201, [400, 409]), {
    201: pricingContractSchemas.response, 400: pricingContractSchemas.problem, 409: pricingContractSchemas.problem,
  });
  assert.equal(pricingContractSchemas.idempotencyKey.type, "string");
  assert.equal(pricingContractSchemas.replayOnly.const, true);
  assert.equal(pricingContractSchemas.quoteRef.type, "string");

  assert.equal(isPricingQuoteCreateRequest({...create, lines: [create.lines[0], {...create.lines[0]}]}), false, "duplicate product/variant pair");
  assert.equal(isPricingQuoteCreateRequest({...create, lines: []}), false);
  assert.equal(isPricingQuoteCreateRequest({...create, lines: [{...create.lines[0], quantity: 1.5}]}), false);
  assert.equal(isPricingQuoteCreateRequest({...create, supplierUnitMinor: "900"}), false);
  assert.equal(isPricingQuoteCreateRequest({...create, lines: [{...create.lines[0], offerRef: verifiedQuote.line.offerRef}]}), false);
  assert.equal(isPricingQuoteResponse({...publicQuote, lines: [{...line, supplierUnitMinor: "900"}]}), false);
  assert.equal(isPricingQuoteResponse({...publicQuote, internalProofHash: verifiedQuote.line.internalProofHash}), false);
  assert.equal(isPricingQuoteResponse({...publicQuote, totalMinor: 1800}), false);
  assert.equal(isPricingQuoteVerifyRequest({...verify, hash: "invalid"}), false);
  assert.equal(isPricingQuoteVerifyRequest({...verify, quoteLineNumber: 0}), false);
  assert.equal(isPricingQuoteVerifyRequest({...verify, quoteLineNumber: 101}), false);
  assert.equal(isPricingQuoteVerifyRequest({...verify, lines: create.lines}), false, "legacy full-lines verification is rejected");
  assert.equal(isPricingQuoteVerificationResponse({...verifiedQuote, valid: false}), false);
  assert.equal(isPricingQuoteVerificationResponse({...verifiedQuote, line: {...verifiedQuote.line, supplierUnitMinor: 900}}), false);
  assert.equal(isPricingQuoteVerificationResponse({...verifiedQuote, lines: [verifiedQuote.line]}), false);
  assert.equal(isPricingProblem({...problem, supplierUnitMinor: "900"}), false);
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
  for (const [index, name] of ["SseStreamReady", "SseResourceInvalidated", "SseStreamReset"].entries()) {
    const generated = clientV1Schemas[name];
    assert.ok(generated, `missing generated SSE runtime schema: ${name}`);
    assert.deepEqual(generated, componentSchema("client-v1", name), `${name} differs from canonical OpenAPI`);
    const validate = ajv.compile(generated);
    assert.equal(validate(frames[index].data), true, JSON.stringify(validate.errors));
    assert.equal(validate({...frames[index].data, businessState: "forbidden"}), false);
  }
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
  assert.deepEqual(decodeSse(frames.map(encodeSseFrame).join("")), frames);
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
  assert.deepEqual(lines[1].items[0].supplierPromotions, [{discountBasisPoints: 1000, minimumWeightRaw: "0", providerCreatedAt: "2026-09-05T09:00:00.000Z", providerUpdatedAt: "2026-09-05T09:30:00.000Z"}]);
  const grindLines = (await readFile(join(POSITIVE_ROOT, "ndjson/aroma-catalog-grind-options.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const [index, line] of grindLines.entries()) assert.equal(validate(line), true, `grind option line ${index + 1}: ${JSON.stringify(validate.errors)}`);
  assert.deepEqual(grindLines[1].items[0].grindOptions, [{sourceGrindKeyHash: "4444444444444444444444444444444444444444444444444444444444444444", displayName: "Средний помол"}]);
  const missingImageLines = (await readFile(join(POSITIVE_ROOT, "ndjson/aroma-catalog-missing-image.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const [index, line] of missingImageLines.entries()) assert.equal(validate(line), true, `missing image line ${index + 1}: ${JSON.stringify(validate.errors)}`);
  assert.equal(missingImageLines[1].items[0].imageUrl, null);
  assert.equal(lines.at(-1).recordType, "snapshot-completed");

  let releaseProducer;
  const producerMayFinish = new Promise((resolve) => { releaseProducer = resolve; });
  async function* records() {
    yield `${JSON.stringify(lines[0])}\n`;
    await producerMayFinish;
    for (const line of lines.slice(1)) yield `${JSON.stringify(line)}\n`;
  }
  const app = await createRuntime({name: "contracts-ndjson-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500});
  app.get("/stream", async (_request, reply) => reply.type("application/x-ndjson").send(Readable.from(records())));
  const abort = new AbortController();
  let reader;
  try {
    await app.runtimeController.start();
    const address = app.server.address();
    assert.equal(typeof address, "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/stream`, {signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)])});
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    while (!wire.includes("\n")) {
      const first = await reader.read();
      assert.equal(first.done, false, "producer EOF arrived before the first record");
      wire += decoder.decode(first.value, {stream: true});
    }
    assert.equal(JSON.parse(wire.slice(0, wire.indexOf("\n"))).recordType, "snapshot-started", "first record was buffered until producer EOF");
    assert.equal(wire, `${JSON.stringify(lines[0])}\n`, "client received records produced only after the release gate");
    releaseProducer();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) wire += decoder.decode(chunk.value, {stream: true});
    wire += decoder.decode();
    const decoded = wire.trim().split("\n").map((line) => JSON.parse(line));
    for (const line of decoded) assert.equal(validate(line), true, JSON.stringify(validate.errors));
    assert.deepEqual(decoded, lines);
  } finally {
    releaseProducer();
    abort.abort();
    await reader?.cancel();
    await app.runtimeController.closeRuntime("test");
  }
});

void test("negative HTTP fixtures fail closed across trust and representation boundaries", async () => {
  const {ajv, success, problems} = await loadCorpus();
  const negatives = await jsonFixture(join(NEGATIVE_ROOT, "http/rejections.json"));
  const successByKey = new Map(success.map((fixture) => [`${fixture.document}|${fixture.operationId}|${fixture.status}|${fixture.schema}`, fixture]));
  const problemByKey = new Map(problems.map((fixture) => [`${fixture.document}|${fixture.operationId}|${fixture.status}|${fixture.schema}`, fixture]));
  const requiredCases = new Set(["missing-field", "additional-field", "invalid-ref-ulid", "invalid-uuid", "invalid-hash", "invalid-traceparent", "invalid-timestamp", "invalid-calendar-timestamp", "numeric-version", "numeric-money", "numeric-quantity", "noncanonical-decimal", "invalid-enum", "invalid-cross-field", "actor-provider-credentials-public", "wrong-problem-status", "wrong-problem-code", "invalid-problem-instance", "invalid-problem-instance-leading-digit-scheme", "invalid-problem-instance-empty-scheme", "invalid-problem-instance-path-brackets", "invalid-problem-instance-space", "invalid-problem-type-leading-digit-scheme", "invalid-problem-type-empty-scheme", "invalid-problem-type-path-brackets", "invalid-problem-type-space", "zero-provider-quantity", "unsupported-representation", "pii-secret-provider-body-sse", "binding-additional-field", "wrong-order-empty-code", "wrong-order-item-limit-status"]);
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
    if (fixture.expectedKeyword) assert.ok(validate.errors?.some((error) => error.keyword === fixture.expectedKeyword && error.instancePath === fixture.expectedPath), `${fixture.case}: ${JSON.stringify(validate.errors)}`);
  }
});

void test("negative SSE and NDJSON fixtures reject unsafe wire shapes and order", async () => {
  const {ajv} = await loadCorpus();
  const frames = await jsonFixture(join(POSITIVE_ROOT, "sse/order-invalidations.json"));
  const negatives = await jsonFixture(join(NEGATIVE_ROOT, "sse/rejections.json"));
  for (const fixture of negatives) {
    const frame = applyMutations(frames[fixture.streamIndex], fixture);
    assert.throws(() => encodeSseFrame(frame), /invalid|forbidden/, fixture.case);
  }
  const lines = (await readFile(join(NEGATIVE_ROOT, "ndjson/aroma-catalog-invalid.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const validate = loadValidator(ajv, "internal-v1", "AromaCatalogExportRecord");
  assert.equal(validate(lines[0]), false, JSON.stringify(validate.errors));
  assert.notEqual(lines[0].recordType, "snapshot-started");
});
