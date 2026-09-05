import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const baseline = {
  openapi: '3.2.0', info: { title: 'fixture', version: '1' },
  paths: { '/items': { get: { operationId: 'getItems', 'x-audience': 'browser', responses: { 200: { description: 'ok' } } } } },
  components: { schemas: { Item: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, state: { type: 'string', enum: ['A', 'B'] } } } } },
};

async function red(mutator, withOptionalEvidence = false) {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  for (const path of [base, current]) await mkdir(join(path, 'contracts/openapi'), { recursive: true });
  const changed = structuredClone(baseline);
  mutator(changed);
  await writeFile(join(base, 'contracts/openapi/client-v1.yaml'), yaml.dump(baseline));
  await writeFile(join(current, 'contracts/openapi/client-v1.yaml'), yaml.dump(changed));
  if (withOptionalEvidence) {
    await mkdir(join(current, 'contracts/fixtures/positive/http'), { recursive: true });
    await writeFile(join(current, 'contracts/fixtures/positive/http/optional-note.json'), JSON.stringify({ id: '1', note: 'evidence' }));
    await writeFile(join(current, 'contracts/compatibility-evidence.yaml'), yaml.dump({ optionalExpansions: [{ schemaPath: 'contracts/openapi/client-v1.yaml', location: 'contracts/openapi/client-v1.yaml#Item', property: 'note', fixture: 'contracts/fixtures/positive/http/optional-note.json' }] }));
  }
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function realClientRed(mutator) {
  const source = yaml.load(await readFile(join(root, 'contracts/openapi/client-v1.yaml'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-real-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  for (const path of [base, current]) await mkdir(join(path, 'contracts/openapi'), { recursive: true });
  const changed = structuredClone(source);
  mutator(changed);
  await writeFile(join(base, 'contracts/openapi/client-v1.yaml'), yaml.dump(source));
  await writeFile(join(current, 'contracts/openapi/client-v1.yaml'), yaml.dump(changed));
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

void test('breaking guard rejects endpoint/schema/status/operation rename and schema narrowing', async () => {
  for (const mutation of [
    (document) => { delete document.paths['/items']; },
    (document) => { delete document.paths['/items'].get.responses[200]; },
    (document) => { document.paths['/items'].get.operationId = 'listItems'; },
    (document) => { delete document.components.schemas.Item; },
    (document) => { document.components.schemas.Item.required.push('state'); },
    (document) => { delete document.components.schemas.Item.properties.state; },
    (document) => { document.components.schemas.Item.properties.state.type = 'number'; },
    (document) => { document.components.schemas.Item.properties.state.enum.pop(); },
    (document) => { document.components.schemas.Item.properties.note = { type: 'string' }; },
  ]) {
    const result = await red(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
  }
});

void test('breaking guard admits optional expansion only with fixture and policy evidence', async () => {
  const result = await red((document) => { document.components.schemas.Item.properties.note = { type: 'string' }; }, true);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

void test('breaking guard rejects event schema, key and envelope changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-event-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', required: ['messageId', 'payload'],
    properties: { messageId: { type: 'string', const: 'message.v1' }, payload: { type: 'object', required: ['orderRef'], properties: { orderRef: { type: 'string' } } } },
  };
  const manifest = { contracts: [{ id: 'OrderConfirmed.v1', kind: 'event', owner: 'orders', operation: 'coffee.orders.lifecycle.v1', key: 'orderRef' }] };
  for (const path of [base, current]) {
    await mkdir(join(path, 'contracts/schemas/events'), { recursive: true });
    await mkdir(join(path, 'contracts'), { recursive: true });
    await writeFile(join(path, 'contracts/schemas/events/order.schema.json'), JSON.stringify(schema));
    await writeFile(join(path, 'contracts/manifest.yaml'), yaml.dump(manifest));
  }
  const changedSchema = structuredClone(schema);
  changedSchema.properties.messageId.const = 'message.v2';
  await writeFile(join(current, 'contracts/schemas/events/order.schema.json'), JSON.stringify(changedSchema));
  let result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);

  await writeFile(join(current, 'contracts/schemas/events/order.schema.json'), JSON.stringify(schema));
  const changedManifest = structuredClone(manifest);
  changedManifest.contracts[0].key = 'messageId';
  await writeFile(join(current, 'contracts/manifest.yaml'), yaml.dump(changedManifest));
  result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /breaking contract/);

  changedManifest.contracts = [];
  await writeFile(join(current, 'contracts/manifest.yaml'), yaml.dump(changedManifest));
  result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

for (const [name, mutation] of [
  ['response ref change', (document) => { document.paths['/api/client-v1/customers'].post.responses['201'].content['application/json'].schema.$ref = '#/components/schemas/OrderCardResponse'; }],
  ['required idempotency parameter weakening', (document) => { document.components.parameters.IdempotencyKey.required = false; }],
  ['component ref change', (document) => { document.components.schemas.CustomerRef.$ref = '../schemas/common/money-version-time.v1.schema.json#/$defs/MoneyMinor'; }],
  ['security removal', (document) => { document.paths['/api/client-v1/customers'].post.security = []; }],
  ['array bound narrowing', (document) => { document.components.schemas.PricingQuoteCreateRequest.properties.lines.maxItems = 1; }],
  ['shared response schema ref change', (document) => { document.components.responses.ValidationFailed.content['application/problem+json'].schema.$ref = '#/components/schemas/OrderCardResponse'; }],
  ['shared header const change', (document) => { document.components.headers.IdempotencyReplayed.schema.const = false; }],
  ['operation parameter removal', (document) => { document.paths['/api/client-v1/customers'].post.parameters.shift(); }],
  ['enum addition narrowing', (document) => { document.components.schemas.CustomerResponse.properties.displayName.enum = ['Only']; }],
  ['security scheme change', (document) => { document.components.securitySchemes.bearerAuth.scheme = 'basic'; }],
]) {
  void test(`breaking guard rejects real client ${String(name)}`, async () => {
    const result = await realClientRed(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
  });
}
