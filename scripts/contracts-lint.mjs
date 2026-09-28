#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';
import { contractAjv } from './contracts-ajv.mjs';

const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = process.argv.includes('--current') ? resolve(valueAfter('--current')) : resolve(import.meta.dirname, '..');
const schemaRoot = resolve(root, 'contracts/schemas');
const openApiRoot = resolve(root, 'contracts/openapi');
const manifestPath = resolve(root, 'contracts/manifest.yaml');
const documents = new Map();

async function load(path) {
  if (!documents.has(path)) {
    const source = await readFile(path, 'utf8');
    documents.set(path, path.endsWith('.json') ? JSON.parse(source) : yaml.load(source));
  }
  return documents.get(path);
}

function pointer(document, fragment) {
  if (!fragment || fragment === '#') return document;
  return fragment.slice(2).split('/').reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], document);
}

async function checkRefs(value, sourcePath, seen = new Set()) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string') {
    const [file = '', fragment = ''] = value.$ref.split('#');
    const targetPath = file ? resolve(dirname(sourcePath), file) : sourcePath;
    const key = `${targetPath}#${fragment}`;
    if (!seen.has(key)) {
      const target = pointer(await load(targetPath), fragment ? `#${fragment}` : '#');
      if (target === undefined) throw new Error(`${sourcePath}: unresolved $ref ${value.$ref}`);
      seen.add(key);
      await checkRefs(target, targetPath, seen);
    }
  }
  for (const child of Object.values(value)) await checkRefs(child, sourcePath, seen);
}

async function files(directory, suffixes) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, suffixes));
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) result.push(path);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

const schemas = await Promise.all((await files(schemaRoot, ['.json'])).map(async (path) => ({ path, value: JSON.parse(await readFile(path, 'utf8')) })));
const ajv = contractAjv();
for (const { path, value } of schemas) {
  if (value.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(`${path}: JSON Schema 2020-12 required`);
  if (!value.$id) throw new Error(`${path}: $id required`);
  ajv.addSchema(value);
}
for (const { path, value } of schemas) {
  for (const definition of Object.keys(value.$defs ?? {})) {
    if (!ajv.getSchema(`${value.$id}#/$defs/${definition}`)) throw new Error(`${path}: invalid published definition ${definition}`);
  }
}
for (const { path, value } of schemas) {
  try {
    if (!ajv.getSchema(value.$id)) ajv.compile(value);
  }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

const operationIds = new Set();
const operations = new Map();
const openApiFiles = await files(openApiRoot, ['.yaml', '.yml']);
for (const path of openApiFiles) {
  const document = await load(path);
  if (document?.openapi !== '3.2.0') throw new Error(`${path}: OpenAPI 3.2.0 required`);
  if (!document.info?.title || !document.info?.version || !document.paths || !document.components?.schemas) throw new Error(`${path}: incomplete OpenAPI document`);
  const ids = new Set();
  for (const [route, pathItem] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      if (!operation.operationId || ids.has(operation.operationId)) throw new Error(`${path}: duplicate or missing operationId ${operation.operationId}`);
      ids.add(operation.operationId);
      operationIds.add(operation.operationId);
      if (!operation.responses || Object.keys(operation.responses).length === 0) throw new Error(`${path}: ${operation.operationId} has no responses`);
      for (const field of ['x-owner', 'x-audience', 'x-exposure']) if (!operation[field]) throw new Error(`${path}: ${operation.operationId} missing ${field}`);
      if (path.includes('client-v1') && operation['x-permission'] !== undefined && !/^[a-z]+:[a-z]+(?::[a-z]+)?$/.test(operation['x-permission'])) throw new Error(`${path}: ${operation.operationId} has invalid x-permission`);
      if (!operation.security?.length) throw new Error(`${path}: ${operation.operationId} missing security`);
      if (path.includes('client-v1') && operation['x-exposure'] === 'public' && !operation['x-caller']) throw new Error(`${path}: ${operation.operationId} missing x-caller`);
      if (path.includes('internal-v1') && (!operation['x-auth'] || !operation['x-callers']?.length)) throw new Error(`${path}: ${operation.operationId} incomplete internal trust metadata`);
      const media = Object.values(operation.responses).flatMap((response) => Object.keys(response.content ?? {}));
      const kind = media.includes('text/event-stream') ? 'sse' : media.includes('application/x-ndjson') ? 'ndjson' : 'http';
      operations.set(operation.operationId, {
        operation: `${method.toUpperCase()} ${route}`,
        statuses: Object.keys(operation.responses).map(Number),
        kind,
        owner: operation['x-owner']?.replace(/-(?:service|gateway)$/, ''),
      });
    }
  }
  await checkRefs(document, path);
}
const manifest = await load(manifestPath);
const entries = manifest.contracts ?? [];
const eventEntries = entries.filter((entry) => entry.kind === 'event' || entry.kind === 'command');
if (eventEntries.length !== 8 || new Set(eventEntries.map((entry) => entry.id)).size !== 8) throw new Error(`${manifestPath}: exactly eight message types required`);
for (const entry of eventEntries) if (!entry.key) throw new Error(`${manifestPath}: ${entry.id} message key required`);
for (const operationId of operationIds) if (!entries.some((entry) => entry.id === operationId)) throw new Error(`${manifestPath}: missing operation ${operationId}`);
for (const entry of entries.filter((item) => ['http', 'sse', 'ndjson'].includes(item.kind))) {
  const source = operations.get(entry.id);
  if (!source) throw new Error(`${manifestPath}: extra operation ${entry.id}`);
  for (const field of ['operation', 'statuses', 'kind', 'owner']) {
    if (JSON.stringify(entry[field]) !== JSON.stringify(source[field])) throw new Error(`${manifestPath}: ${entry.id} ${field} drift; OpenAPI=${JSON.stringify(source[field])}`);
  }
}
console.log(`contracts lint passed: ${schemas.length} JSON Schemas, ${openApiFiles.length} OpenAPI documents`);
