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

async function red(mutator) {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-breaking-'));
  const base = join(directory, 'base');
  const current = join(directory, 'current');
  for (const path of [base, current]) await mkdir(join(path, 'contracts/openapi'), { recursive: true });
  const changed = structuredClone(baseline);
  mutator(changed);
  await writeFile(join(base, 'contracts/openapi/client-v1.yaml'), yaml.dump(baseline));
  await writeFile(join(current, 'contracts/openapi/client-v1.yaml'), yaml.dump(changed));
  const result = spawnSync(process.execPath, ['scripts/contracts-breaking.mjs', '--base', base, '--current', current], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

void test('breaking guard rejects endpoint, required field and enum removal', async () => {
  for (const mutation of [
    (document) => { delete document.paths['/items']; },
    (document) => { document.components.schemas.Item.required.push('state'); },
    (document) => { document.components.schemas.Item.properties.state.enum.pop(); },
  ]) {
    const result = await red(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /breaking contract/);
  }
});
