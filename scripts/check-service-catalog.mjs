#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_FIELDS = new Set(['name', 'owner', 'sourceRoot', 'purpose', 'contractPackages', 'incomingHttp', 'incomingEvents', 'schedules', 'outgoingHttp', 'outgoingEvents', 'database', 'secretRefs', 'publicity', 'transportMode']);
const CATALOG_DIGEST = '9b1b202aa978d4e844898a3f0a5c0812e50652f3140f1b369bc72ede4e157c29';
const INTERACTIONS_DIGEST = 'ad869ee1028882c0a0eebf3376c330960e2156d250d60607be95917a83e470e1';

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail('BOUND-CATALOG', `${path}: cannot read strict JSON: ${error.message}`);
  }
}

function exactKeys(value, expected, label) {
  const actual = new Set(Object.keys(value));
  const missing = [...expected].filter((key) => !actual.has(key));
  const unknown = [...actual].filter((key) => !expected.has(key));
  if (missing.length || unknown.length) fail('BOUND-CATALOG', `${label}: missing=[${missing.join(',')}] unknown=[${unknown.join(',')}]`);
}

function uniqueMap(items, key, rule, label) {
  const result = new Map();
  for (const item of items) {
    if (result.has(item[key])) fail(rule, `${label}: duplicate ${key} ${item[key]}`);
    result.set(item[key], item);
  }
  return result;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length) {
    fail('BOUND-CATALOG', `${label}: explicit unique string array required`);
  }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export async function checkServiceCatalog(root = REPO_ROOT) {
  const catalog = await readJson(join(root, 'config/service-catalog.json'));
  const ownership = await readJson(join(root, 'config/database-ownership.json'));
  const policy = await readJson(join(root, 'config/service-interactions.json'));
  const profile = await readJson(join(root, 'platform/launch-v1-runtime-profile.json'));

  if (catalog.exactRuntimeCount !== 15 || catalog.runtimes.length !== 15) fail('BOUND-CATALOG', 'exact 15 runtime catalog required');
  const catalogByName = uniqueMap(catalog.runtimes, 'name', 'BOUND-CATALOG', 'service catalog');
  const profileByName = uniqueMap(profile.runtimes, 'name', 'BOUND-CATALOG', 'runtime profile');
  const claimsByName = uniqueMap(ownership.runtimeClaims, 'runtime', 'BOUND-DB-CLAIM', 'database claims');
  const expectedNames = new Set(profileByName.keys());
  if (catalogByName.size !== expectedNames.size || [...expectedNames].some((name) => !catalogByName.has(name))) fail('BOUND-CATALOG', 'runtime set differs from #19 profile');

  for (const [name, runtime] of catalogByName) {
    exactKeys(runtime, RUNTIME_FIELDS, `runtime ${name}`);
    const profileRuntime = profileByName.get(name);
    if (runtime.owner !== profileRuntime.owner) fail('BOUND-CATALOG', `${name}: owner ${runtime.owner} differs from #19 ${profileRuntime.owner}`);
    if (runtime.transportMode !== profileRuntime.transportMode) fail('BOUND-CATALOG', `${name}: transportMode differs from #19 profile`);
    if (runtime.sourceRoot !== `apps/${name}`) fail('BOUND-CATALOG', `${name}: sourceRoot must be apps/${name}`);
    for (const field of ['contractPackages', 'incomingHttp', 'incomingEvents', 'schedules', 'outgoingHttp', 'outgoingEvents', 'secretRefs']) stringArray(runtime[field], `${name}.${field}`);
    for (const packageRoot of runtime.contractPackages) {
      if (!/^packages\/contracts\/[a-z0-9-]+-v[0-9]+$/.test(packageRoot)) fail('BOUND-IMPORT', `${name}: unversioned or non-contract package ${packageRoot}`);
    }
    const actualSecrets = [...runtime.secretRefs].sort((left, right) => left.localeCompare(right));
    const expectedSecrets = [...profileRuntime.secretRefs].sort((left, right) => left.localeCompare(right));
    if (JSON.stringify(actualSecrets) !== JSON.stringify(expectedSecrets)) fail('BOUND-SECRET', `${name}: secretRefs differ from accepted #19 profile`);
    const claim = claimsByName.get(name);
    if (!claim) fail('BOUND-DB-CLAIM', `${name}: database claim missing`);
    if (runtime.database === null) {
      if (profileRuntime.dbPrincipal !== null || claim.database !== null) fail('BOUND-DB-CLAIM', `${name}: DB-less authority mismatch`);
    } else {
      if (runtime.database.role !== profileRuntime.dbPrincipal) fail('BOUND-DB-CLAIM', `${name}: DB role differs from #19 profile`);
      if (claim.database !== runtime.database.name || claim.role !== runtime.database.role) fail('BOUND-DB-CLAIM', `${name}: service catalog and ownership claim differ`);
    }
  }

  if (policy.defaultPolicy !== 'deny' || policy.databaseEdgesAcrossOwnersAllowed !== false) fail('BOUND-INTERACTION', 'interaction policy must be default-deny with no cross-owner DB edge');
  const interactions = uniqueMap(policy.interactions, 'id', 'BOUND-INTERACTION', 'interaction matrix');
  for (const interaction of interactions.values()) {
    if (!catalogByName.has(interaction.from)) fail('BOUND-INTERACTION', `${interaction.id}: unknown source ${interaction.from}`);
    if (!catalogByName.has(interaction.to) && interaction.to !== 'external:aroma-origin') fail('BOUND-INTERACTION', `${interaction.id}: unknown target ${interaction.to}`);
    if (!['http', 'event', 'provider-http'].includes(interaction.mode)) fail('BOUND-INTERACTION', `${interaction.id}: forbidden mode ${interaction.mode}`);
    if (interaction.to === 'external:aroma-origin' && (interaction.from !== 'aroma-gateway' || interaction.mode !== 'provider-http')) fail('BOUND-INTERACTION', `${interaction.id}: provider egress is Gateway-only`);
    if (interaction.mode === 'provider-http' && interaction.to !== 'external:aroma-origin') fail('BOUND-INTERACTION', `${interaction.id}: provider edge target changed`);
  }

  const internalProfile = profile.internalOperationAllowlist;
  for (const operation of internalProfile) {
    const callerEdge = [...interactions.values()].some((edge) => edge.from === operation.originalCaller && edge.to === 'api-internal' && edge.operations.includes(operation.operationId));
    const targetEdge = [...interactions.values()].some((edge) => edge.from === 'api-internal' && edge.to === operation.target && edge.contract === `internal-v1:${operation.operationId}`);
    if (!callerEdge || !targetEdge) fail('BOUND-INTERACTION', `${operation.originalCaller} -> ${operation.target} ${operation.operationId}: delegation edge missing`);
  }

  for (const runtime of catalog.runtimes) {
    for (const event of runtime.incomingEvents) {
      if (![...interactions.values()].some((edge) => edge.mode === 'event' && edge.to === runtime.name && edge.contract === event)) fail('BOUND-INTERACTION', `${runtime.name}: incoming event ${event} has no producer edge`);
    }
    for (const event of runtime.outgoingEvents) {
      if (event === 'CatalogSnapshotActivated.v1') continue;
      if (![...interactions.values()].some((edge) => edge.mode === 'event' && edge.from === runtime.name && edge.contract === event)) fail('BOUND-INTERACTION', `${runtime.name}: outgoing event ${event} has no consumer edge`);
    }
  }
  if (digest(catalog) !== CATALOG_DIGEST) fail('BOUND-CATALOG', 'service catalog differs from the accepted exact authority');
  if (digest(policy) !== INTERACTIONS_DIGEST) fail('BOUND-INTERACTION', 'interaction matrix contains an unknown or changed edge');
  return { runtimeCount: catalogByName.size, interactionCount: interactions.size };
}

function parseRoot(argv) {
  const index = argv.indexOf('--root');
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkServiceCatalog(parseRoot(process.argv.slice(2)));
    console.log(`service catalog: passed (${result.runtimeCount} runtime, ${result.interactionCount} interactions)`);
  } catch (error) {
    console.error(`service catalog: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
