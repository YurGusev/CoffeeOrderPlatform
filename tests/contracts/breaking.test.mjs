import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');
const baseline = {
  openapi: '3.2.0', info: { title: 'fixture', version: '1' },
  paths: { '/items': { get: { operationId: 'getItems', 'x-audience': 'browser', responses: { 200: { description: 'ok' } } } } },
  components: { schemas: { Item: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, state: { type: 'string', enum: ['A', 'B'] } } } } },
};

async function red(mutator, withOptionalEvidence = false, withNarrowingEvidence = false, narrowingFixtureValue = '0') {
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
  if (withNarrowingEvidence) {
    await mkdir(join(current, 'contracts/fixtures/negative/http'), { recursive: true });
    await mkdir(join(current, 'docs/launch'), { recursive: true });
    await writeFile(join(current, 'contracts/fixtures/negative/http/narrow-id.json'), JSON.stringify({case: 'narrow-id', id: narrowingFixtureValue, expectedKeyword: 'pattern'}));
    await writeFile(join(current, 'docs/launch/narrow-id.md'), '# Narrow ID migration\n');
    await writeFile(join(current, 'contracts/compatibility-evidence.yaml'), yaml.dump({narrowingCorrections: [{schemaPath: 'contracts/openapi/client-v1.yaml', location: 'contracts/openapi/client-v1.yaml#Item.id', keyword: 'pattern', before: null, after: '^[1-9]$', issue: 10, reason: 'Correct a pre-runtime request constraint before provider integration.', migration: 'docs/launch/narrow-id.md', fixture: 'contracts/fixtures/negative/http/narrow-id.json', fixtureCase: 'narrow-id', fixtureValuePointer: '/id', expectedKeyword: 'pattern'}]}));
  }
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

async function realSourceRed(sourcePath, mutator) {
  const text = await readFile(join(root, sourcePath), 'utf8');
  const source = sourcePath.endsWith('.json') ? JSON.parse(text) : yaml.load(text);
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-real-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  for (const path of [base, current]) await mkdir(join(path, dirname(sourcePath)), { recursive: true });
  const changed = structuredClone(source);
  mutator(changed);
  const encode = sourcePath.endsWith('.json') ? (value) => JSON.stringify(value) : (value) => yaml.dump(value);
  await writeFile(join(base, sourcePath), encode(source));
  await writeFile(join(current, sourcePath), encode(changed));
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

const realClientRed = (mutator) => realSourceRed('contracts/openapi/client-v1.yaml', mutator);

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

void test('breaking guard admits only an exact narrowing correction with migration evidence', async () => {
  const accepted = await red((document) => { document.components.schemas.Item.properties.id.pattern = '^[1-9]$'; }, false, true);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  const different = await red((document) => { document.components.schemas.Item.properties.id.pattern = '^[1-8]$'; }, false, true);
  assert.notEqual(different.status, 0, `${different.stdout}\n${different.stderr}`);
  assert.match(different.stderr, /breaking contract/);
  const ineffective = await red((document) => { document.components.schemas.Item.properties.id.pattern = '^[1-9]$'; }, false, true, '7');
  assert.notEqual(ineffective.status, 0, `${ineffective.stdout}\n${ineffective.stderr}`);
  assert.match(ineffective.stderr, /breaking contract/);
});

void test('breaking guard admits a same-wire parameter ref replacement with a wider schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-parameter-ref-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  const document = {
    openapi: '3.2.0',
    info: { title: 'fixture', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'getItems',
          parameters: [{ $ref: '#/components/parameters/Cursor' }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
    components: {
      parameters: {
        Cursor: { name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 512 } },
      },
    },
  };
  const changed = structuredClone(document);
  changed.paths['/items'].get.parameters[0].$ref = '#/components/parameters/CustomerCursor';
  changed.components.parameters.CustomerCursor = { name: 'cursor', in: 'query', required: false, schema: { type: 'string', maxLength: 2048 } };
  for (const [root, value] of [[base, document], [current, changed]]) {
    await mkdir(join(root, 'contracts/openapi'), { recursive: true });
    await writeFile(join(root, 'contracts/openapi/client-v1.yaml'), yaml.dump(value));
  }
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
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

for (const [name, mutation, expected] of [
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
  ['request body required change', (document) => { document.paths['/api/client-v1/customers'].post.requestBody.required = true; }, /createCustomer request body required changed/],
  ['boolean response schema', (document) => { document.paths['/api/client-v1/customers'].post.responses['201'].content['application/json'].schema = false; }, /createCustomer:201\.content\.application\/json: boolean schema changed/],
]) {
  void test(`breaking guard rejects real client ${String(name)}`, async () => {
    const result = await realClientRed(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
    if (expected) assert.match(result.stderr, expected);
  });
}

void test('breaking guard rejects removing the real envelope version const', async () => {
  const result = await realSourceRed('contracts/schemas/common/message-envelope.v1.schema.json', (document) => {
    delete document.$defs.MessageEnvelope.properties.envelopeVersion.const;
  });
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /MessageEnvelope\.envelopeVersion: const changed/);
});
