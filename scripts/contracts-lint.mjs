#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..');
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
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
for (const { path, value } of schemas) {
  if (value.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error(`${path}: JSON Schema 2020-12 required`);
  if (!value.$id) throw new Error(`${path}: $id required`);
  ajv.addSchema(value);
}
for (const { path, value } of schemas) {
  try {
    if (!ajv.getSchema(value.$id)) ajv.compile(value);
  }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

const operationIds = new Set();
for (const path of await files(openApiRoot, ['.yaml', '.yml'])) {
  const document = await load(path);
  if (document?.openapi !== '3.2.0') throw new Error(`${path}: OpenAPI 3.2.0 required`);
  if (!document.info?.title || !document.info?.version || !document.paths || !document.components?.schemas) throw new Error(`${path}: incomplete OpenAPI document`);
  const ids = new Set();
  for (const pathItem of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      if (!operation.operationId || ids.has(operation.operationId)) throw new Error(`${path}: duplicate or missing operationId ${operation.operationId}`);
      ids.add(operation.operationId);
      operationIds.add(operation.operationId);
      if (!operation.responses || Object.keys(operation.responses).length === 0) throw new Error(`${path}: ${operation.operationId} has no responses`);
    }
  }
  await checkRefs(document, path);
}
const manifest = await load(manifestPath);
const entries = manifest.contracts ?? [];
const eventEntries = entries.filter((entry) => entry.kind === 'event' || entry.kind === 'command');
if (eventEntries.length !== 7 || new Set(eventEntries.map((entry) => entry.id)).size !== 7) throw new Error(`${manifestPath}: exactly seven message types required`);
for (const operationId of operationIds) if (!entries.some((entry) => entry.id === operationId)) throw new Error(`${manifestPath}: missing operation ${operationId}`);
console.log(`contracts lint passed: ${schemas.length} JSON Schemas, 2 OpenAPI documents`);
