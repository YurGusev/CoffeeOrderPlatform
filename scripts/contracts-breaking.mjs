#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const repositoryRoot = resolve(import.meta.dirname, '..');
const valueAfter = (name) => process.argv[process.argv.indexOf(name) + 1];
const root = process.argv.includes('--current') ? resolve(valueAfter('--current')) : repositoryRoot;
const baseRoot = process.argv.includes('--base') ? resolve(valueAfter('--base')) : null;
const sources = ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml', 'contracts/manifest.yaml'];

function fromBase(path) {
  if (baseRoot) {
    const source = resolve(baseRoot, path);
    return existsSync(source) ? yaml.load(readFileSync(source, 'utf8')) : null;
  }
  const result = spawnSync('git', ['show', `origin/develop:${path}`], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? yaml.load(result.stdout) : null;
}

function fail(message) { throw new Error(`breaking contract: ${message}`); }

function compareSchema(before, after, at) {
  if (!before || !after) return;
  const beforeTypes = new Set(Array.isArray(before.type) ? before.type : [before.type].filter(Boolean));
  const afterTypes = new Set(Array.isArray(after.type) ? after.type : [after.type].filter(Boolean));
  for (const type of beforeTypes) if (!afterTypes.has(type)) fail(`${at}: type ${type} removed`);
  const beforeEnum = new Set(before.enum ?? []);
  const afterEnum = new Set(after.enum ?? []);
  for (const value of beforeEnum) if (!afterEnum.has(value)) fail(`${at}: enum value ${JSON.stringify(value)} removed`);
  const oldRequired = new Set(before.required ?? []);
  for (const value of after.required ?? []) if (!oldRequired.has(value)) fail(`${at}: required field ${value} added`);
  for (const [name, schema] of Object.entries(before.properties ?? {})) {
    if (!after.properties?.[name]) fail(`${at}: property ${name} removed`);
    compareSchema(schema, after.properties[name], `${at}.${name}`);
  }
}

function compareOpenApi(before, after, path) {
  for (const [route, pathItem] of Object.entries(before.paths ?? {})) {
    if (!after.paths?.[route]) fail(`${path}: route ${route} removed`);
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
      const next = after.paths[route][method];
      if (!next) fail(`${path}: ${method.toUpperCase()} ${route} removed`);
      if (operation['x-audience'] !== next['x-audience']) fail(`${path}: ${operation.operationId} audience changed`);
      if (operation['x-callers'] && JSON.stringify(operation['x-callers']) !== JSON.stringify(next['x-callers'])) fail(`${path}: ${operation.operationId} caller allowlist changed`);
      for (const status of Object.keys(operation.responses ?? {})) if (!next.responses?.[status]) fail(`${path}: ${operation.operationId} status ${status} removed`);
    }
  }
  for (const [name, schema] of Object.entries(before.components?.schemas ?? {})) {
    if (!after.components?.schemas?.[name]) fail(`${path}: schema ${name} removed`);
    compareSchema(schema, after.components.schemas[name], `${path}#${name}`);
  }
}

for (const path of sources) {
  const before = fromBase(path);
  if (!before) continue;
  const after = yaml.load(await readFile(resolve(root, path), 'utf8'));
  if (path.includes('/openapi/')) compareOpenApi(before, after, path);
  else {
    const oldEntries = new Map((before.contracts ?? []).map((entry) => [entry.id, entry]));
    const newEntries = new Map((after.contracts ?? []).map((entry) => [entry.id, entry]));
    for (const [id, entry] of oldEntries) {
      const next = newEntries.get(id);
      if (!next) fail(`manifest entry ${id} removed`);
      for (const field of ['audience', 'pii', 'secrets', 'compatibility']) if (JSON.stringify(entry[field]) !== JSON.stringify(next[field])) fail(`manifest ${id} ${field} changed`);
    }
  }
}
console.log('contracts breaking check passed');
