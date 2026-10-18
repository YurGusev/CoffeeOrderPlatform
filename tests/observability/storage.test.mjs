import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import test from 'node:test';
import {provisionStorage, removeStorage} from '../../tools/observability/storage.mjs';

const name = 'coffee-g14-00000000-0000-4000-8000-000000000001-data';
const nodeImage = `node:fixture@sha256:${'a'.repeat(64)}`;
const labels = lifecycle => ({'coffee.owner': 'operations', 'coffee.lifecycle': lifecycle});

function runStorageHelper(args, fileState) {
  const root = mkdtempSync(join(tmpdir(), 'coffee-storage-helper-'));
  const storage = join(root, 'storage');
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(storage);
  mkdirSync(bin);
  if (fileState === 'symlink') {
    writeFileSync(join(storage, 'target'), 'fixture');
    symlinkSync(join(storage, 'target'), join(storage, 'telemetry.ext4'));
  }
  const commands = {
    'blkid': 'printf "ext4\\n"',
    'losetup': 'if [ "$1" = "--find" ]; then printf "/dev/loop18\\n"; fi',
    'mkfs.ext4': ':',
    'mknod': ':',
    'stat': 'printf "1073741824\\n"',
    'truncate': ':',
  };
  for (const [name, body] of Object.entries(commands)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$OBS_STORAGE_TEST_LOG"\n${body}\n`);
    chmodSync(path, 0o700);
  }
  try {
    const shellArgs = args.slice(args.indexOf('sh') + 1);
    shellArgs[1] = shellArgs[1].replaceAll('/storage', storage);
    const result = spawnSync('sh', shellArgs, {
      encoding: 'utf8',
      env: {...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OBS_STORAGE_TEST_LOG: log},
    });
    return {status: result.status, stdout: result.stdout, stderr: result.stderr, commands: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []};
  } finally { rmSync(root, {recursive: true, force: true}); }
}

function runWithShellHelper(harness, fileState) {
  return args => {
    if (args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find')) {
      harness.calls.push(args);
      const result = runStorageHelper(args, fileState);
      if (result.status !== 0) throw new Error('storage helper rejected backing file');
      return result.stdout.trim();
    }
    return harness.run(args);
  };
}

function storageHarness({previousDevice, attached = false, active = false, failCreate = false, failRemove = false, failCleanup = false, backingExists = true, foreignNamed = false, foreignDriver = false} = {}) {
  const calls = [];
  const volumes = new Map(backingExists ? [[`${name}-backing`, {Driver: 'local', Labels: labels('fixture'), Options: null}]] : []);
  if (previousDevice) volumes.set(name, {
    Driver: foreignDriver ? 'other' : 'local',
    Labels: foreignNamed ? labels('persistent') : {...labels('fixture'), 'coffee.retention': 'keep'},
    Options: {type: 'ext4', device: previousDevice, o: 'nodev,nosuid,noexec'},
  });
  const run = args => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volume = volumes.get(args[2]);
      if (!volume) throw Object.assign(new Error(`no such volume: ${args[2]}`), {stderr: `no such volume: ${args[2]}`});
      return JSON.stringify([volume]);
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      if (args.at(-1) === name) {
        if (failCreate) throw new Error('volume create failed');
        const optionArgs = args.flatMap((arg, index) => arg === '--opt' ? [args[index + 1]] : []);
        const Options = Object.fromEntries(optionArgs.map(value => value.split('=')));
        const labelArgs = args.flatMap((arg, index) => arg === '--label' ? [args[index + 1]] : []);
        const Labels = Object.fromEntries(labelArgs.map(value => value.split('=')));
        volumes.set(name, {Driver: 'local', Labels, Options});
      }
      return '';
    }
    if (args[0] === 'volume' && args[1] === 'rm') {
      assert.equal(args.includes('--force'), false);
      if (failRemove) throw new Error('volume is in use');
      volumes.delete(args[2]);
      return '';
    }
    if (args[0] === 'ps') return active ? 'container-id' : '';
    if (args[0] === 'run') {
      const script = args[args.indexOf('-ceu') + 1];
      if (script.includes('losetup --find')) return JSON.stringify({device: '/dev/loop18', attached});
      if (script.includes('losetup -d') && failCleanup) throw new Error('cleanup failed');
      return '';
    }
    return '';
  };
  return {calls, run, volumes};
}

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

void test('owned telemetry volume is rebound to a renumbered loop without touching its backing data', () => {
  const harness = storageHarness({previousDevice: '/dev/loop17', attached: false});
  assert.deepEqual(provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: harness.run}), {
    volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop18', maxDiskBytes: 1073741824,
  });
  assert.ok(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm' && args[2] === name));
  assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm' && args[2] === `${name}-backing`), false);
  assert.ok(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create' && args.at(-1) === name && args.includes('device=/dev/loop18') && args.includes('coffee.owner=operations') && args.includes('coffee.lifecycle=fixture') && args.includes('coffee.retention=keep')));
  assert.deepEqual(harness.volumes.get(name).Labels, {...labels('fixture'), 'coffee.retention': 'keep'});
  const attachCall = harness.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find'));
  const attachScript = attachCall[attachCall.indexOf('-ceu') + 1];
  assert.ok(attachScript.indexOf('blkid -p') < attachScript.indexOf('losetup --find'));
});

void test('telemetry provisioning rejects foreign or active named volumes before attaching a loop', () => {
  for (const harness of [storageHarness({previousDevice: '/dev/loop17', foreignNamed: true}), storageHarness({previousDevice: '/dev/loop17', foreignDriver: true}), storageHarness({previousDevice: '/dev/loop17', active: true})]) {
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: harness.run}));
    assert.equal(harness.calls.some(args => args[0] === 'run'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create'), false);
  }
});

void test('owned data volume without its backing fails closed before creating or attaching storage', () => {
  const harness = storageHarness({previousDevice: '/dev/loop17', backingExists: false});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: harness.run}), /missing its backing volume/u);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create'), false);
  assert.equal(harness.calls.some(args => args[0] === 'run'), false);
  assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
});

void test('existing storage refuses a missing or symlink backing file while fresh storage formats safely', () => {
  for (const fileState of ['missing', 'symlink']) {
    const harness = storageHarness({previousDevice: '/dev/loop17'});
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: runWithShellHelper(harness, fileState)}), /storage helper rejected backing file/u);
    const attachCall = harness.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find'));
    assert.equal(attachCall.at(-1), 'true');
    const result = runStorageHelper(attachCall, fileState);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.commands, []);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create' && args.at(-1) === name), false);
  }

  const fresh = storageHarness({attached: true});
  assert.deepEqual(provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: runWithShellHelper(fresh, 'missing')}), {
    volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop18', maxDiskBytes: 1073741824,
  });
  const freshAttach = fresh.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find'));
  assert.equal(freshAttach.at(-1), 'false');
  const freshResult = runStorageHelper(freshAttach, 'missing');
  assert.equal(freshResult.status, 0);
  assert.ok(freshResult.commands.includes('truncate'));
  assert.ok(freshResult.commands.includes('mkfs.ext4'));
});

void test('telemetry failure detaches only a verified new loop and leaves a reused loop alone', () => {
  const attached = storageHarness({attached: true, failCreate: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: attached.run}), /volume create failed/u);
  const cleanup = attached.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d'));
  assert.ok(cleanup);
  assert.equal(cleanup.at(-1), '/dev/loop18');
  assert.match(cleanup[cleanup.indexOf('-ceu') + 1], /losetup -j \/storage\/telemetry\.ext4[\s\S]*grep -Fx "\$1"; losetup -d "\$1"/u);

  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: storageHarness({attached: true, failCreate: true, failCleanup: true}).run}), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Telemetry storage provisioning and loop cleanup failed');
    assert.deepEqual(error.errors.map(cause => cause.message), ['volume create failed', 'cleanup failed']);
    return true;
  });

  const failedRebind = storageHarness({previousDevice: '/dev/loop17', attached: true, failRemove: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: failedRebind.run}), /volume is in use/u);
  assert.deepEqual(failedRebind.calls.find(args => args[0] === 'volume' && args[1] === 'rm'), ['volume', 'rm', name]);
  assert.ok(failedRebind.calls.some(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d')));
  assert.ok(failedRebind.volumes.has(name));
  assert.ok(failedRebind.volumes.has(`${name}-backing`));

  const reused = storageHarness({previousDevice: '/dev/loop18', attached: false, failCreate: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, nodeImage, run: reused.run}), /volume create failed/u);
  assert.equal(reused.calls.some(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d')), false);
});
