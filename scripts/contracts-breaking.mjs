#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { contractAjv } from './contracts-ajv.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = process.argv.includes('--current') ? resolve(valueAfter('--current')) : repositoryRoot;
const baseRoot = process.argv.includes('--base') ? resolve(valueAfter('--base')) : null;
const fixedSources = ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml', 'contracts/openapi/edge-auth-v1.yaml', 'contracts/manifest.yaml'];

async function schemaSources(directory, prefix = 'contracts/schemas') {
  const path = resolve(directory, prefix);
  if (!existsSync(path)) return [];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await schemaSources(directory, child));
    else if (entry.name.endsWith('.json')) result.push(child);
  }
  return result;
}

function baseSchemaSources() {
  if (baseRoot) return schemaSources(baseRoot);
  const result = spawnSync('git', ['ls-tree', '-r', '--name-only', 'origin/develop', 'contracts/schemas'], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`cannot read baseline origin/develop: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout.trim().split('\n').filter((path) => path.endsWith('.json'));
}

const evidencePath = resolve(root, 'contracts/compatibility-evidence.yaml');
const compatibilityEvidence = existsSync(evidencePath) ? yaml.load(readFileSync(evidencePath, 'utf8')) ?? {} : {};
const optionalEvidence = compatibilityEvidence.optionalExpansions ?? [];
const narrowingEvidence = compatibilityEvidence.narrowingCorrections ?? [];
const privateVerifyReplacements = compatibilityEvidence.approvedInternalReplacements ?? [];
const approvedResponseExpansions = compatibilityEvidence.approvedResponseExpansions ?? [];
const approvedCommandRecoveryExpansions = compatibilityEvidence.approvedCommandRecoveryExpansions ?? [];
const privateVerifySchemas = new Set(['PricingQuoteVerifyLine', 'PricingQuoteVerifyRequest', 'PricingQuoteVerificationResponse']);

function fromBase(path) {
  if (baseRoot) {
    const source = resolve(baseRoot, path);
    return existsSync(source) ? yaml.load(readFileSync(source, 'utf8')) : null;
  }
  const result = spawnSync('git', ['show', `origin/develop:${path}`], { cwd: root, encoding: 'utf8' });
  if (result.status === 0) return yaml.load(result.stdout);
  if (/exists on disk, but not in|does not exist in/.test(result.stderr)) return null;
  throw new Error(`cannot read baseline origin/develop:${path}: ${result.error?.message ?? result.stderr.trim()}`);
}

function fail(message) { throw new Error(`breaking contract: ${message}`); }

function requireOptionalEvidence(sourcePath, at, property) {
  const evidence = optionalEvidence.find((entry) => entry.schemaPath === sourcePath && entry.location === at && entry.property === property);
  if (!evidence?.fixture || !existsSync(resolve(root, evidence.fixture))) fail(`${at}: optional property ${property} added without fixture and policy evidence`);
  if (!readFileSync(resolve(root, evidence.fixture), 'utf8').includes(`"${property}"`)) fail(`${at}: evidence fixture does not contain ${property}`);
}

function fixtureValue(document, pointer, at) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) fail(`${at}: narrowing evidence fixtureValuePointer is missing`);
  let value = document;
  for (const token of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) fail(`${at}: narrowing evidence fixtureValuePointer does not resolve`);
    value = value[token];
  }
  return value;
}

function proveNarrowing(evidence, at, keyword, before, after) {
  const document = yaml.load(readFileSync(resolve(root, evidence.fixture), 'utf8'));
  const fixtures = Array.isArray(document) ? document : [document];
  const fixture = fixtures.find((entry) => entry?.case === evidence.fixtureCase);
  if (fixture === undefined) fail(`${at}: narrowing evidence fixture does not contain case ${evidence.fixtureCase}`);
  if (evidence.expectedKeyword !== keyword || fixture.expectedKeyword !== keyword) fail(`${at}: narrowing evidence is not bound to keyword ${keyword}`);
  const value = fixtureValue(fixture, evidence.fixtureValuePointer, at);
  const ajv = contractAjv();
  const beforeValidator = ajv.compile(before === undefined ? true : {type: 'string', [keyword]: before});
  const afterValidator = ajv.compile({type: 'string', [keyword]: after});
  if (!beforeValidator(value)) fail(`${at}: narrowing fixture was not accepted by the previous constraint`);
  if (afterValidator(value)) fail(`${at}: narrowing fixture is still accepted by the new constraint`);
  if (!afterValidator.errors?.some((error) => error.keyword === keyword)) fail(`${at}: narrowing fixture does not fail keyword ${keyword}`);
}

function evidenceValueHash(value) {
  return createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex');
}

function approvedPrivateVerifyReplacement(path, name, before, after) {
  if (path !== 'contracts/openapi/internal-v1.yaml' || !privateVerifySchemas.has(name)) return false;
  const evidence = privateVerifyReplacements.find((entry) => entry.schemaPath === path && entry.schema === name);
  if (evidence === undefined) return false;
  if (privateVerifyReplacements.length !== privateVerifySchemas.size ||
      new Set(privateVerifyReplacements.map((entry) => entry.schema)).size !== privateVerifySchemas.size ||
      evidence.issue !== 8 || evidence.migration !== 'docs/launch/16_PRICING_IMPLEMENTATION_SPEC.md' ||
      evidence.proof !== 'tests/pricing/pricing-store.test.mjs' ||
      !existsSync(resolve(root, evidence.migration)) || !existsSync(resolve(root, evidence.proof)) ||
      ![evidence.beforeSha256, evidence.afterSha256].includes(evidenceValueHash(before)) || evidence.afterSha256 !== evidenceValueHash(after) ||
      (name === 'PricingQuoteVerifyLine' && after !== undefined)) {
    fail(`${path}#${name}: approved private verify replacement evidence is incomplete or has drifted`);
  }
  return true;
}

function requireNarrowingEvidence(sourcePath, at, keyword, before, after) {
  const previousValue = before === undefined ? null : before;
  const evidence = narrowingEvidence.find((entry) => entry.schemaPath === sourcePath && entry.location === at && entry.keyword === keyword &&
    ((JSON.stringify(entry.before) === JSON.stringify(previousValue) && JSON.stringify(entry.after) === JSON.stringify(after)) ||
      (entry.beforeSha256 === evidenceValueHash(previousValue) && entry.afterSha256 === evidenceValueHash(after))));
  if (!evidence) fail(`${at}: ${keyword} narrowed`);
  if (!Number.isSafeInteger(evidence.issue) || evidence.issue <= 0 || typeof evidence.reason !== 'string' || evidence.reason.length < 10) fail(`${at}: narrowing evidence must name issue and reason`);
  if (typeof evidence.migration !== 'string' || !existsSync(resolve(root, evidence.migration))) fail(`${at}: narrowing evidence migration document is missing`);
  if (typeof evidence.fixture !== 'string' || !existsSync(resolve(root, evidence.fixture)) || typeof evidence.fixtureCase !== 'string') fail(`${at}: narrowing evidence fixture is missing`);
  proveNarrowing(evidence, at, keyword, before, after);
}

function compareSchema(before, after, at, sourcePath) {
  if (before === undefined || before === null) {
    if (after !== undefined && after !== null) fail(`${at}: schema constraint added`);
    return;
  }
  if (after === undefined || after === null) fail(`${at}: schema removed`);
  if (typeof before === 'boolean' || typeof after === 'boolean') {
    if (before !== after) fail(`${at}: boolean schema changed`);
    return;
  }
  if (before.$ref !== after.$ref) fail(`${at}: $ref changed`);
  if ((Object.hasOwn(before, 'const') || Object.hasOwn(after, 'const')) && before.const !== after.const) fail(`${at}: const changed`);
  if (after.pattern !== undefined && before.pattern !== after.pattern) requireNarrowingEvidence(sourcePath, at, 'pattern', before.pattern, after.pattern);
  if (after.format !== undefined && before.format !== after.format) requireNarrowingEvidence(sourcePath, at, 'format', before.format, after.format);
  for (const keyword of ['minimum', 'exclusiveMinimum', 'minItems', 'minLength', 'minProperties']) {
    if (after[keyword] !== undefined && (before[keyword] === undefined || after[keyword] > before[keyword])) fail(`${at}: ${keyword} narrowed`);
  }
  for (const keyword of ['maximum', 'exclusiveMaximum', 'maxItems', 'maxLength', 'maxProperties']) {
    if (after[keyword] !== undefined && (before[keyword] === undefined || after[keyword] < before[keyword])) fail(`${at}: ${keyword} narrowed`);
  }
  if (before.additionalProperties !== false && after.additionalProperties === false) fail(`${at}: unknown fields narrowed`);
  const beforeTypes = new Set(Array.isArray(before.type) ? before.type : [before.type].filter(Boolean));
  const afterTypes = new Set(Array.isArray(after.type) ? after.type : [after.type].filter(Boolean));
  for (const type of beforeTypes) if (!afterTypes.has(type)) fail(`${at}: type ${type} removed`);
  const beforeEnum = new Set(before.enum ?? []);
  const afterEnum = new Set(after.enum ?? []);
  if (before.enum === undefined && after.enum !== undefined) fail(`${at}: enum narrowed`);
  for (const value of beforeEnum) if (!afterEnum.has(value)) fail(`${at}: enum value ${JSON.stringify(value)} removed`);
  const oldRequired = new Set(before.required ?? []);
  for (const value of after.required ?? []) if (!oldRequired.has(value)) fail(`${at}: required field ${value} added`);
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!Object.hasOwn(after.properties ?? {}, name)) fail(`${at}: property ${name} removed`);
    compareSchema(schema, after.properties[name], `${at}.${name}`, sourcePath);
  }
  const oldProperties = new Set(Object.keys(before.properties ?? {}));
  const required = new Set(after.required ?? []);
  for (const name of Object.keys(after.properties ?? {})) {
    if (!oldProperties.has(name) && !required.has(name)) requireOptionalEvidence(sourcePath, at, name);
  }
  if (JSON.stringify(before.dependentRequired ?? null) !== JSON.stringify(after.dependentRequired ?? null)) {
    if (before.dependentRequired !== undefined || after.additionalProperties !== false ||
        Object.entries(after.dependentRequired ?? {}).length === 0 ||
        !Object.entries(after.dependentRequired ?? {}).every(([name, dependencies]) =>
          Array.isArray(dependencies) && dependencies.length > 0 &&
          [name, ...dependencies].every((property) => !oldProperties.has(property) && !required.has(property) && Object.hasOwn(after.properties ?? {}, property)))) {
      fail(`${at}: dependentRequired changes previously accepted objects`);
    }
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const oldItems = before[keyword] ?? [];
    const newItems = after[keyword] ?? [];
    if (newItems.length < oldItems.length) fail(`${at}: ${keyword} branch removed`);
    for (const [index, item] of oldItems.entries()) compareSchema(item, newItems[index], `${at}.${keyword}[${index}]`, sourcePath);
  }
  if (before.items) compareSchema(before.items, after.items, `${at}.items`, sourcePath);
  for (const [name, schema] of Object.entries(before.$defs ?? {})) {
    if (!Object.hasOwn(after.$defs ?? {}, name)) fail(`${at}: definition ${name} removed`);
    compareSchema(schema, after.$defs[name], `${at}.$defs.${name}`, sourcePath);
  }
  const structural = new Set(['$ref', 'const', 'pattern', 'format', 'type', 'enum', 'required', 'properties', '$defs', 'items', 'allOf', 'anyOf', 'oneOf', 'prefixItems', 'dependentRequired', 'additionalProperties', 'minimum', 'exclusiveMinimum', 'minItems', 'minLength', 'minProperties', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxLength', 'maxProperties', 'title', 'description', 'examples', 'example', 'default', 'deprecated', 'readOnly', 'writeOnly']);
  for (const [keyword, value] of Object.entries(before)) if (!structural.has(keyword) && JSON.stringify(value) !== JSON.stringify(after[keyword])) fail(`${at}: unsupported keyword ${keyword} changed`);
  for (const [keyword] of Object.entries(after)) if (!structural.has(keyword) && !Object.hasOwn(before, keyword)) fail(`${at}: unsupported keyword ${keyword} added`);
}

function compareMedia(before, after, at, sourcePath) {
  for (const [mediaType, media] of Object.entries(before ?? {})) {
    if (!after?.[mediaType]) fail(`${at}: media type ${mediaType} removed`);
    compareSchema(media.schema, after[mediaType].schema, `${at}.${mediaType}`, sourcePath);
  }
}

function allowConfirmResponseExpansion(sourcePath, route, at, before, after) {
  const expectedPath = 'contracts/openapi/client-v1.yaml';
  const expectedRoute = '/api/client-v1/orders/{orderRef}/commands/confirm';
  const expectedAt = 'contracts/openapi/client-v1.yaml:confirmOrder:422';
  const beforeRef = '#/components/responses/RecoveryOrderConfirmationRejected';
  const variants = ['ErrorOrderConfirmationRejected', 'ErrorOrderEmpty', 'ErrorOrderDesiredOverflow'];
  if (sourcePath !== expectedPath || route !== expectedRoute || at !== expectedAt || before.$ref !== beforeRef || after.$ref !== undefined) return false;
  const evidence = approvedResponseExpansions.find((entry) => entry.schemaPath === expectedPath && entry.route === expectedRoute && entry.operationId === 'confirmOrder' && entry.status === 422);
  if (approvedResponseExpansions.length !== 1 || !evidence || evidence.issue !== 8 || evidence.beforeRef !== beforeRef ||
      JSON.stringify(evidence.afterRefs) !== JSON.stringify(variants.map((name) => `#/components/schemas/${name}`)) ||
      evidence.fixture !== 'contracts/fixtures/positive/http/problems.json' || JSON.stringify(evidence.fixtureCases) !== JSON.stringify(variants)) {
    fail(`${at}: issue-8 response expansion evidence is incomplete or has drifted`);
  }
  const fixturePath = resolve(root, evidence.fixture);
  if (!existsSync(fixturePath)) fail(`${at}: response expansion fixture is missing`);
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const schema of variants) {
    const fixture = fixtures.find((entry) => entry.document === 'client-v1' && entry.operationId === 'confirmOrder' && entry.status === 422 && entry.schema === schema);
    if (!fixture || fixture.body?.status !== 422 || fixture.body?.code !== schema.replace(/^Error/, '').replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter}`).toUpperCase()) fail(`${at}: response expansion fixture is incomplete for ${schema}`);
  }
  const currentDocument = yaml.load(readFileSync(resolve(root, sourcePath), 'utf8'));
  const recoveryHeaders = currentDocument.components?.responses?.RecoveryOrderConfirmationRejected?.headers;
  const expectedContent = {'application/problem+json': {schema: {oneOf: variants.map((name) => ({$ref: `#/components/schemas/${name}`}))}}};
  if (JSON.stringify(after.content) !== JSON.stringify(expectedContent) || JSON.stringify(after.headers) !== JSON.stringify(recoveryHeaders) || after.description !== 'Confirmation is rejected, or the completed rejection is replayed.') fail(`${at}: issue-8 response expansion does not match the approved branches`);
  return true;
}

function allowPricingGrindRecoveryExpansion(sourcePath, before, after) {
  const entry = approvedCommandRecoveryExpansions[0];
  const operationId = 'createPricingQuote';
  const schema = 'ErrorPricingGrindNotAvailable';
  if (sourcePath !== 'contracts/openapi/client-v1.yaml' || approvedCommandRecoveryExpansions.length !== 1 ||
      entry?.schemaPath !== sourcePath || entry.operationId !== operationId || entry.addedTerminalSchema !== schema ||
      entry.issue !== 11 || entry.fixture !== 'contracts/fixtures/positive/http/problems.json' ||
      entry.fixtureCase !== schema) return false;
  const previous = before?.terminalSchemas?.[operationId];
  const next = after?.terminalSchemas?.[operationId];
  const fixturePath = resolve(root, entry.fixture);
  if (!Array.isArray(previous) || !Array.isArray(next) || next.length !== previous.length + 1 || next.at(-1) !== schema ||
      JSON.stringify(next.slice(0, -1)) !== JSON.stringify(previous) || !existsSync(fixturePath)) {
    fail(`${sourcePath}: command recovery expansion lacks matching evidence`);
  }
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!fixtures.some((fixture) => fixture.document === 'client-v1' && fixture.operationId === operationId &&
      fixture.status === 422 && fixture.schema === entry.fixtureCase)) {
    fail(`${sourcePath}: command recovery expansion fixture is incomplete`);
  }
  after.terminalSchemas[operationId] = previous;
  return true;
}

function compareResponse(before, after, at, sourcePath, route) {
  // #17 extends exactly these Catalog error responses while retaining their old branch.
  const catalogExtensions = [
    {route: '/api/client-v1/catalog/products', at: 'contracts/openapi/client-v1.yaml:searchCatalogProducts:400', oldName: 'ValidationFailed', variants: ['ErrorValidationFailed', 'ErrorInvalidCursor']},
    {route: '/api/client-v1/catalog/products', at: 'contracts/openapi/client-v1.yaml:searchCatalogProducts:503', oldName: 'CatalogSnapshotIncomplete', variants: ['ErrorCatalogSnapshotIncomplete', 'ErrorCatalogUnavailable']},
    {route: '/api/internal-v1/catalog/products/{productRef}/variants/{variantRef}/pricing-input', at: 'contracts/openapi/internal-v1.yaml:getCatalogPricingInput:503', oldName: 'CatalogSnapshotIncomplete', variants: ['ErrorCatalogSnapshotIncomplete', 'ErrorCatalogUnavailable']},
  ];
  const catalogExtension = catalogExtensions.some(({route: expectedRoute, at: expectedAt, oldName, variants}) =>
    route === expectedRoute && at === expectedAt && before.$ref === `#/components/responses/${oldName}` && after.$ref === undefined &&
    JSON.stringify(after.content) === JSON.stringify({'application/problem+json': {schema: {oneOf:
      variants.map((name) => ({$ref: `#/components/schemas/${name}`}))}}}));
  const issue8Expansion = allowConfirmResponseExpansion(sourcePath, route, at, before, after);
  if (before.$ref !== after.$ref && !catalogExtension && !issue8Expansion) fail(`${at}: response $ref changed`);
  compareMedia(before.content, after.content, `${at}.content`, sourcePath);
  for (const [name, header] of Object.entries(before.headers ?? {})) {
    if (!after.headers?.[name]) fail(`${at}: response header ${name} removed`);
    compareSchema(header, after.headers[name], `${at}.headers.${name}`, sourcePath);
  }
}

function resolveParameter(document, parameter) {
  const reference = parameter?.$ref;
  if (typeof reference !== 'string' || !reference.startsWith('#/components/parameters/')) return parameter;
  return document.components?.parameters?.[reference.split('/').at(-1)] ?? parameter;
}

function compareParameter(before, after, at, sourcePath, beforeDocument, afterDocument) {
  if (!after) fail(`${at}: parameter removed`);
  const previous = resolveParameter(beforeDocument, before);
  const next = resolveParameter(afterDocument, after);
  for (const field of ['name', 'in', 'required']) if (previous[field] !== next[field]) fail(`${at}: parameter ${field} changed`);
  compareSchema(previous.schema, next.schema, `${at}.schema`, sourcePath);
}

function parameterKey(document, parameter) {
  const resolved = resolveParameter(document, parameter);
  return `${resolved.in}:${resolved.name}`;
}

function compareParameters(before, after, at, sourcePath, beforeDocument, afterDocument) {
  const next = new Map((after ?? []).map((parameter) => [parameterKey(afterDocument, parameter), parameter]));
  const previous = new Set((before ?? []).map((parameter) => parameterKey(beforeDocument, parameter)));
  for (const parameter of before ?? []) {
    const key = parameterKey(beforeDocument, parameter);
    compareParameter(parameter, next.get(key), `${at}:${key}`, sourcePath, beforeDocument, afterDocument);
  }
  for (const parameter of after ?? []) {
    const key = parameterKey(afterDocument, parameter);
    if (previous.has(key)) continue;
    const resolved = resolveParameter(afterDocument, parameter);
    if (resolved?.required) fail(`${at}: required parameter ${key} added`);
  }
}

function compareOpenApi(before, after, path) {
  const oldRecovery = structuredClone(before['x-command-recovery'] ?? null);
  const newRecovery = structuredClone(after['x-command-recovery'] ?? null);
  if (JSON.stringify(oldRecovery) !== JSON.stringify(newRecovery) && !allowPricingGrindRecoveryExpansion(path, oldRecovery, newRecovery)) {
    fail(`${path}: command recovery protocol changed`);
  }
  if (JSON.stringify(oldRecovery) !== JSON.stringify(newRecovery)) fail(`${path}: command recovery protocol changed`);
  for (const [route, pathItem] of Object.entries(before.paths ?? {})) {
    if (!after.paths?.[route]) fail(`${path}: route ${route} removed`);
    compareParameters(pathItem.parameters, after.paths[route].parameters, `${path}:${route}:parameters`, path, before, after);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const next = after.paths[route][method];
      if (!next) fail(`${path}: ${method.toUpperCase()} ${route} removed`);
      if (operation.operationId !== next.operationId) fail(`${path}: ${method.toUpperCase()} ${route} operationId changed`);
      if (JSON.stringify(operation.security ?? null) !== JSON.stringify(next.security ?? null)) fail(`${path}: ${operation.operationId} security changed`);
      for (const field of ['x-owner', 'x-audience', 'x-caller', 'x-callers', 'x-exposure', 'x-auth', 'x-idempotency']) {
        if (JSON.stringify(operation[field]) !== JSON.stringify(next[field])) fail(`${path}: ${operation.operationId} ${field} changed`);
      }
      compareParameters(operation.parameters, next.parameters, `${path}:${operation.operationId}:parameters`, path, before, after);
      if (Boolean(operation.requestBody?.required) !== Boolean(next.requestBody?.required)) fail(`${path}: ${operation.operationId} request body required changed`);
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!next.responses?.[status]) fail(`${path}: ${operation.operationId} status ${status} removed`);
        compareResponse(response, next.responses[status], `${path}:${operation.operationId}:${status}`, path, route);
      }
      compareMedia(operation.requestBody?.content, next.requestBody?.content, `${path}:${operation.operationId}:request`, path);
    }
  }
  for (const [name, schema] of Object.entries(before.components?.schemas ?? {})) {
    if (approvedPrivateVerifyReplacement(path, name, schema, after.components?.schemas?.[name])) continue;
    if (!after.components?.schemas?.[name]) fail(`${path}: schema ${name} removed`);
    compareSchema(schema, after.components.schemas[name], `${path}#${name}`, path);
  }
  for (const [name, parameter] of Object.entries(before.components?.parameters ?? {})) {
    compareParameter(parameter, after.components?.parameters?.[name], `${path}:parameter:${name}`, path, before, after);
  }
  for (const [name, response] of Object.entries(before.components?.responses ?? {})) {
    const next = after.components?.responses?.[name];
    if (!next) fail(`${path}: response ${name} removed`);
    compareResponse(response, next, `${path}:response:${name}`, path);
  }
  for (const [name, header] of Object.entries(before.components?.headers ?? {})) {
    const next = after.components?.headers?.[name];
    if (!next) fail(`${path}: header ${name} removed`);
    if (header.$ref !== next.$ref) fail(`${path}: header ${name} $ref changed`);
    compareSchema(header.schema, next.schema, `${path}:header:${name}`, path);
  }
  for (const [name, scheme] of Object.entries(before.components?.securitySchemes ?? {})) {
    const next = after.components?.securitySchemes?.[name];
    if (!next) fail(`${path}: security scheme ${name} removed`);
    if (JSON.stringify(scheme) !== JSON.stringify(next)) fail(`${path}: security scheme ${name} changed`);
  }
}

const sources = [...fixedSources, ...await baseSchemaSources()];
for (const path of sources) {
  const before = fromBase(path);
  if (!before) continue;
  if (!existsSync(resolve(root, path))) fail(`${path} removed`);
  const after = yaml.load(await readFile(resolve(root, path), 'utf8'));
  if (path.includes('/openapi/')) compareOpenApi(before, after, path);
  else if (path === 'contracts/manifest.yaml') {
    const oldEntries = new Map((before.contracts ?? []).map((entry) => [entry.id, entry]));
    const newEntries = new Map((after.contracts ?? []).map((entry) => [entry.id, entry]));
    for (const [id, entry] of oldEntries) {
      const next = newEntries.get(id);
      if (!next) fail(`manifest entry ${id} removed`);
      for (const field of ['kind', 'owner', 'operation', 'key', 'audience', 'producers', 'consumers', 'pii', 'secrets', 'compatibility']) if (JSON.stringify(entry[field]) !== JSON.stringify(next[field])) fail(`manifest ${id} ${field} changed`);
    }
  }
  else compareSchema(before, after, path, path);
}
console.log('contracts breaking check passed');
