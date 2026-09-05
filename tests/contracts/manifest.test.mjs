import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '../..');

async function lintMutation(mutator) {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-manifest-'));
  await cp(join(root, 'contracts'), join(directory, 'contracts'), { recursive: true });
  const manifestPath = join(directory, 'contracts/manifest.yaml');
  const manifest = yaml.load(await readFile(manifestPath, 'utf8'));
  const clientPath = join(directory, 'contracts/openapi/client-v1.yaml');
  const client = yaml.load(await readFile(clientPath, 'utf8'));
  mutator({manifest, client});
  await writeFile(manifestPath, yaml.dump(manifest));
  await writeFile(clientPath, yaml.dump(client));
  const result = spawnSync(process.execPath, ['scripts/contracts-lint.mjs', '--current', directory], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  return result;
}

void test('manifest and OpenAPI operation facts are checked in both directions', async () => {
  for (const mutation of [
    ({manifest}) => { manifest.contracts.find(({id}) => id === 'getOrderCard').statuses.pop(); },
    ({manifest}) => { manifest.contracts.find(({id}) => id === 'getOrderCard').operation = 'GET /wrong'; },
    ({manifest}) => { manifest.contracts.push({...manifest.contracts[0], id: 'extraOperation'}); },
    ({client}) => { client.paths['/api/client-v1/customers'].post['x-owner'] = 'orders-service'; },
  ]) {
    const result = await lintMutation(mutation);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
});
