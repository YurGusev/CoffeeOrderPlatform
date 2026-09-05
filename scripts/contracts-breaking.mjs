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
  return result.status === 0 ? result.stdout.trim().split('\n').filter((path) => path.endsWith('.json')) : [];
}

const evidencePath = resolve(root, 'contracts/compatibility-evidence.yaml');
const optionalEvidence = existsSync(evidencePath) ? yaml.load(readFileSync(evidencePath, 'utf8')).optionalExpansions ?? [] : [];

function fromBase(path) {
  if (baseRoot) {
    const source = resolve(baseRoot, path);
    return existsSync(source) ? yaml.load(readFileSync(source, 'utf8')) : null;
  }
  const result = spawnSync('git', ['show', `origin/develop:${path}`], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? yaml.load(result.stdout) : null;
}

function fail(message) { throw new Error(`breaking contract: ${message}`); }

function requireOptionalEvidence(sourcePath, at, property) {
  const evidence = optionalEvidence.find((entry) => entry.schemaPath === sourcePath && entry.location === at && entry.property === property);
  if (!evidence?.fixture || !existsSync(resolve(root, evidence.fixture))) fail(`${at}: optional property ${property} added without fixture and policy evidence`);
  if (!readFileSync(resolve(root, evidence.fixture), 'utf8').includes(`"${property}"`)) fail(`${at}: evidence fixture does not contain ${property}`);
}

function compareSchema(before, after, at, sourcePath) {
  if (!before || !after) return;
  if (Object.hasOwn(before, 'const') && before.const !== after.const) fail(`${at}: const changed`);
  if (before.pattern && before.pattern !== after.pattern) fail(`${at}: pattern changed`);
  if (before.minimum !== undefined && (after.minimum ?? -Infinity) > before.minimum) fail(`${at}: minimum narrowed`);
  if (before.maximum !== undefined && (after.maximum ?? Infinity) < before.maximum) fail(`${at}: maximum narrowed`);
  if (before.additionalProperties !== false && after.additionalProperties === false) fail(`${at}: unknown fields narrowed`);
  const beforeTypes = new Set(Array.isArray(before.type) ? before.type : [before.type].filter(Boolean));
  const afterTypes = new Set(Array.isArray(after.type) ? after.type : [after.type].filter(Boolean));
  for (const type of beforeTypes) if (!afterTypes.has(type)) fail(`${at}: type ${type} removed`);
  const beforeEnum = new Set(before.enum ?? []);
  const afterEnum = new Set(after.enum ?? []);
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
}

function compareOpenApi(before, after, path) {
  for (const [route, pathItem] of Object.entries(before.paths ?? {})) {
    if (!after.paths?.[route]) fail(`${path}: route ${route} removed`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const next = after.paths[route][method];
      if (!next) fail(`${path}: ${method.toUpperCase()} ${route} removed`);
      if (operation.operationId !== next.operationId) fail(`${path}: ${method.toUpperCase()} ${route} operationId changed`);
      if (operation['x-audience'] !== next['x-audience']) fail(`${path}: ${operation.operationId} audience changed`);
      if (operation['x-callers'] && JSON.stringify(operation['x-callers']) !== JSON.stringify(next['x-callers'])) fail(`${path}: ${operation.operationId} caller allowlist changed`);
      for (const status of Object.keys(operation.responses ?? {})) if (!next.responses?.[status]) fail(`${path}: ${operation.operationId} status ${status} removed`);
    }
  }
  for (const [name, schema] of Object.entries(before.components?.schemas ?? {})) {
    if (!after.components?.schemas?.[name]) fail(`${path}: schema ${name} removed`);
    compareSchema(schema, after.components.schemas[name], `${path}#${name}`, path);
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
