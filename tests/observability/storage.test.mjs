import assert from 'node:assert/strict';
import test from 'node:test';
import {provisionStorage, removeStorage} from '../../tools/observability/storage.mjs';

const name = 'coffee-g14-00000000-0000-4000-8000-000000000001-data';
const nodeImage = `node:fixture@sha256:${'a'.repeat(64)}`;

void test('bounded telemetry storage preserves unrelated volumes and cleanup excludes persistent data', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') return JSON.stringify([{Labels: {'coffee.owner': 'another-project'}}]);
    return '';
  };
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run}), /unrelated telemetry volume/u);
  assert.equal(calls.length, 1, 'no creation, mount, formatting or delete before ownership validation');
  assert.throws(() => removeStorage({storage: {volumeName: 'coffee-platform-observability-data', backingVolume: 'coffee-platform-observability-data-backing', device: '/dev/loop17'}, nodeImage, run}), /disposable G14 storage/u);
  assert.equal(calls.length, 1);
  assert.throws(() => provisionStorage({name, maxDiskBytes: Infinity, nodeImage, run}), /Invalid bounded/u);
});

void test('fixture cleanup validates both owners before removing or detaching storage', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    return JSON.stringify([{Labels: {'coffee.owner': 'operations', 'coffee.lifecycle': args.at(-1).endsWith('-backing') ? 'persistent' : 'fixture'}}]);
  };
  assert.throws(() => removeStorage({storage: {volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop17'}, nodeImage, run}), /unrelated telemetry volume/u);
  assert.ok(calls.every(args => args[0] === 'volume' && args[1] === 'inspect'));
});
