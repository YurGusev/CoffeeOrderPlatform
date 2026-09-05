import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
