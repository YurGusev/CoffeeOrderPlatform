#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '..');
const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = process.argv.includes('--current') ? resolve(valueAfter('--current')) : repositoryRoot;
const baseRoot = process.argv.includes('--base') ? resolve(valueAfter('--base')) : null;
const fixedSources = ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml', 'contracts/manifest.yaml'];

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
const optionalEvidence = existsSync(evidencePath) ? yaml.load(readFileSync(evidencePath, 'utf8')).optionalExpansions ?? [] : [];

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
  if (after.pattern !== undefined && before.pattern !== after.pattern) fail(`${at}: pattern narrowed`);
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
  const structural = new Set(['$ref', 'const', 'pattern', 'type', 'enum', 'required', 'properties', '$defs', 'items', 'allOf', 'anyOf', 'oneOf', 'prefixItems', 'additionalProperties', 'minimum', 'exclusiveMinimum', 'minItems', 'minLength', 'minProperties', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxLength', 'maxProperties', 'title', 'description', 'examples', 'example', 'default', 'deprecated', 'readOnly', 'writeOnly']);
  for (const [keyword, value] of Object.entries(before)) if (!structural.has(keyword) && JSON.stringify(value) !== JSON.stringify(after[keyword])) fail(`${at}: unsupported keyword ${keyword} changed`);
  for (const [keyword] of Object.entries(after)) if (!structural.has(keyword) && !Object.hasOwn(before, keyword)) fail(`${at}: unsupported keyword ${keyword} added`);
}

function compareMedia(before, after, at, sourcePath) {
  for (const [mediaType, media] of Object.entries(before ?? {})) {
    if (!after?.[mediaType]) fail(`${at}: media type ${mediaType} removed`);
    compareSchema(media.schema, after[mediaType].schema, `${at}.${mediaType}`, sourcePath);
  }
}

function compareResponse(before, after, at, sourcePath) {
  if (before.$ref !== after.$ref) fail(`${at}: response $ref changed`);
  compareMedia(before.content, after.content, `${at}.content`, sourcePath);
  for (const [name, header] of Object.entries(before.headers ?? {})) {
    if (!after.headers?.[name]) fail(`${at}: response header ${name} removed`);
    compareSchema(header, after.headers[name], `${at}.headers.${name}`, sourcePath);
  }
}

function compareParameter(before, after, at, sourcePath) {
  if (!after) fail(`${at}: parameter removed`);
  for (const field of ['name', 'in', 'required', '$ref']) if (before[field] !== after[field]) fail(`${at}: parameter ${field} changed`);
  compareSchema(before.schema, after.schema, `${at}.schema`, sourcePath);
}

function parameterKey(parameter) {
  return parameter.$ref ?? `${parameter.in}:${parameter.name}`;
}

function compareParameters(before, after, at, sourcePath, afterDocument) {
  const next = new Map((after ?? []).map((parameter) => [parameterKey(parameter), parameter]));
  const previous = new Set((before ?? []).map(parameterKey));
  for (const parameter of before ?? []) compareParameter(parameter, next.get(parameterKey(parameter)), `${at}:${parameterKey(parameter)}`, sourcePath);
  for (const parameter of after ?? []) {
    if (previous.has(parameterKey(parameter))) continue;
    const resolved = parameter.$ref?.startsWith('#/components/parameters/')
      ? afterDocument.components.parameters[parameter.$ref.split('/').at(-1)]
      : parameter;
    if (resolved?.required) fail(`${at}: required parameter ${parameterKey(parameter)} added`);
  }
}

function compareOpenApi(before, after, path) {
  if (JSON.stringify(before['x-command-recovery'] ?? null) !== JSON.stringify(after['x-command-recovery'] ?? null)) fail(`${path}: command recovery protocol changed`);
  for (const [route, pathItem] of Object.entries(before.paths ?? {})) {
    if (!after.paths?.[route]) fail(`${path}: route ${route} removed`);
    compareParameters(pathItem.parameters, after.paths[route].parameters, `${path}:${route}:parameters`, path, after);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const next = after.paths[route][method];
      if (!next) fail(`${path}: ${method.toUpperCase()} ${route} removed`);
      if (operation.operationId !== next.operationId) fail(`${path}: ${method.toUpperCase()} ${route} operationId changed`);
      if (JSON.stringify(operation.security ?? null) !== JSON.stringify(next.security ?? null)) fail(`${path}: ${operation.operationId} security changed`);
      for (const field of ['x-owner', 'x-audience', 'x-caller', 'x-callers', 'x-exposure', 'x-auth', 'x-idempotency']) {
        if (JSON.stringify(operation[field]) !== JSON.stringify(next[field])) fail(`${path}: ${operation.operationId} ${field} changed`);
      }
      compareParameters(operation.parameters, next.parameters, `${path}:${operation.operationId}:parameters`, path, after);
      if (Boolean(operation.requestBody?.required) !== Boolean(next.requestBody?.required)) fail(`${path}: ${operation.operationId} request body required changed`);
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!next.responses?.[status]) fail(`${path}: ${operation.operationId} status ${status} removed`);
        compareResponse(response, next.responses[status], `${path}:${operation.operationId}:${status}`, path);
      }
      compareMedia(operation.requestBody?.content, next.requestBody?.content, `${path}:${operation.operationId}:request`, path);
    }
  }
  for (const [name, schema] of Object.entries(before.components?.schemas ?? {})) {
    if (!after.components?.schemas?.[name]) fail(`${path}: schema ${name} removed`);
    compareSchema(schema, after.components.schemas[name], `${path}#${name}`, path);
  }
  for (const [name, parameter] of Object.entries(before.components?.parameters ?? {})) {
    compareParameter(parameter, after.components?.parameters?.[name], `${path}:parameter:${name}`, path);
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
