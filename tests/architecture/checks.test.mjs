import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = join(REPO_ROOT, 'tests/architecture/fixtures');

function run(script, root = REPO_ROOT) {
  return spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', script), '--root', root], { encoding: 'utf8' });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

async function authorityRoot() {
  const root = await mkdtemp(join(tmpdir(), 'coffee-issue2-'));
  await cp(join(REPO_ROOT, 'config'), join(root, 'config'), { recursive: true });
  await cp(join(REPO_ROOT, 'platform'), join(root, 'platform'), { recursive: true });
  return root;
}

async function mutateJson(path, mutation) {
  const document = JSON.parse(await readFile(path, 'utf8'));
  mutation(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

test('GREEN: accepted manifests pass all direct checkers deterministically', async () => {
  for (const script of ['check-service-catalog.mjs', 'check-database-ownership.mjs', 'check-architecture.mjs']) {
    const first = run(script);
    const second = run(script);
    assert.equal(first.status, 0, output(first));
    assert.deepEqual([first.status, first.stdout, first.stderr], [second.status, second.stdout, second.stderr]);
  }
});

test('RED BOUND-IMPORT: Orders cannot import Catalog internal repository', () => {
  const result = run('check-architecture.mjs', join(FIXTURES, 'invalid-import-orders-catalog'));
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-IMPORT/);
  assert.match(output(result), /orders-service.*catalog-service/s);
});

test('RED BOUND-IMPORT: Catalog cannot import Orders infrastructure DB', () => {
  const result = run('check-architecture.mjs', join(FIXTURES, 'invalid-import-catalog-orders'));
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-IMPORT/);
  assert.match(output(result), /catalog-service.*orders-service/s);
});

test('GREEN: versioned contract import is accepted by Dependency Cruiser 18.2.0 wrapper', () => {
  const result = run('check-architecture.mjs', join(FIXTURES, 'valid-import'));
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /Dependency Cruiser 18\.2\.0/);
});

test('RED BOUND-DB-CLAIM: Orders cannot receive Customer database URL/role', async () => {
  const root = await authorityRoot();
  try {
    await cp(join(FIXTURES, 'invalid-db/runtime-environment.json'), join(root, 'runtime-environment.json'));
    const result = run('check-database-ownership.mjs', root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-DB-CLAIM.*orders-service.*coffee_platform_customer/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GREEN: runtime with its own database and role is accepted', async () => {
  const root = await authorityRoot();
  try {
    await cp(join(FIXTURES, 'valid-db/runtime-environment.json'), join(root, 'runtime-environment.json'));
    const result = run('check-database-ownership.mjs', root);
    assert.equal(result.status, 0, output(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GREEN: Catalog event consumer uses the named versioned interaction contract', async () => {
  const policy = JSON.parse(await readFile(join(REPO_ROOT, 'config/service-interactions.json'), 'utf8'));
  const edge = policy.interactions.find((interaction) => interaction.id === 'catalog-mapping-preparation');
  assert.deepEqual(
    { from: edge.from, to: edge.to, mode: edge.mode, contract: edge.contract },
    { from: 'catalog-activation-worker', to: 'orders-aroma-preparation', mode: 'event', contract: 'CatalogMappingChanged.v2' },
  );
  const result = run('check-service-catalog.mjs');
  assert.equal(result.status, 0, output(result));
});

test('RED BOUND-DB-CLAIM: two database owners cannot share one owner identity', async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, 'config/database-ownership.json');
    await mutateJson(path, (document) => { document.databases[1].owner = 'customer'; });
    const result = run('check-database-ownership.mjs', root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-DB-CLAIM.*duplicate owner customer/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RED BOUND-INTERACTION: Catalog to Orders DB edge is rejected', async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, 'config/service-interactions.json');
    await mutateJson(path, (document) => document.interactions.push({
      id: 'catalog-orders-db', from: 'catalog-service', to: 'orders-service', mode: 'db',
      contract: 'none', operations: ['SELECT'], timeout: 'none', retryOwner: 'none', dataExposure: 'orders-db',
    }));
    const result = run('check-service-catalog.mjs', root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-INTERACTION.*catalog-orders-db.*forbidden mode db/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('RED BOUND-SECRET: api-public cannot receive a foreign Postgres secret', async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, 'config/service-catalog.json');
    await mutateJson(path, (document) => { document.runtimes.find((runtime) => runtime.name === 'api-public').secretRefs.push('postgres.ordersService'); });
    const result = run('check-service-catalog.mjs', root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-SECRET.*api-public/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON Schema Draft 2020-12 accepts all three authority manifests', () => {
  const code = String.raw`
from pathlib import Path
import json
from jsonschema import Draft202012Validator
for schema_path in sorted(Path('config').glob('*.schema.json')):
    Draft202012Validator.check_schema(json.loads(schema_path.read_text()))
for path in sorted(Path('config').glob('*.json')):
    if path.name.endswith('.schema.json'):
        continue
    doc=json.loads(path.read_text())
    schema=json.loads(path.with_name(doc['$schema'][2:]).read_text())
    Draft202012Validator(schema).validate(doc)
`;
  const result = spawnSync('python3', ['-c', code], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, output(result));
});
