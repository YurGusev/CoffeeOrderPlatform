import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import test from 'node:test';
import {provisionStorage, removeStorage} from '../../tools/observability/storage.mjs';
import {loadVerifiedGateImage} from '../../tools/verified-infrastructure-image.mjs';
import {RUNTIME_NAMES} from '../../packages/platform-config/src/index.ts';

const name = 'coffee-observability-00000000-0000-4000-8000-000000000001-loki-data';
const storageHelperImage = `sha256:${'a'.repeat(64)}`;
const labels = lifecycle => ({'coffee.owner': 'operations', 'coffee.lifecycle': lifecycle});

function runStorageHelper(args, fileState, find = '/dev/loop18', {sysDevice = '7:23', nodeDevice} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coffee-storage-helper-'));
  const storage = join(root, 'storage');
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  mkdirSync(storage);
  mkdirSync(bin);
  mkdirSync(join(root, 'dev'));
  for (const minor of [18, 23]) {
    const path = join(root, 'sys/block', `loop${minor}`);
    mkdirSync(path, {recursive: true});
    writeFileSync(join(path, 'dev'), `${minor === 23 ? sysDevice : `7:${minor}`}\n`);
  }
  if (fileState === 'symlink') {
    writeFileSync(join(storage, 'target'), 'fixture');
    symlinkSync(join(storage, 'target'), join(storage, 'telemetry.ext4'));
  }
  const commands = {
    'blkid': 'printf "ext4\\n"',
    'losetup': 'if [ "$1" = "--find" ]; then printf "%s\\n" "$OBS_STORAGE_TEST_FIND"; fi',
    'mkfs.ext4': ':',
    'mknod': ': > "$1"',
    'stat': 'if [ "$2" = "%t:%T" ]; then if [ -n "$OBS_STORAGE_TEST_NODE_DEVICE" ]; then printf "%s\\n" "$OBS_STORAGE_TEST_NODE_DEVICE"; else printf "7:%x\\n" "${3##*loop}"; fi; else printf "1073741824\\n"; fi',
    'truncate': ':',
  };
  for (const [name, body] of Object.entries(commands)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$OBS_STORAGE_TEST_LOG"\n${body}\n`);
    chmodSync(path, 0o700);
  }
  try {
    const shellArgs = args.slice(args.indexOf('sh') + 1);
    shellArgs[1] = shellArgs[1].replaceAll('/storage', storage).replaceAll('/dev/loop', `${root}/dev/loop`).replaceAll('/sys/block', `${root}/sys/block`).replaceAll('test -b "$device"', 'test -f "$device"');
    const result = spawnSync('sh', shellArgs, {
      encoding: 'utf8',
      env: {...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, OBS_STORAGE_TEST_LOG: log, OBS_STORAGE_TEST_FIND: find.replaceAll('/dev/loop', `${root}/dev/loop`), OBS_STORAGE_TEST_NODE_DEVICE: nodeDevice ?? ''},
    });
    return {status: result.status, stdout: result.stdout.replaceAll(`${root}/dev/loop`, '/dev/loop'), stderr: result.stderr, commands: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []};
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
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run}), /unrelated telemetry volume/u);
  assert.equal(calls.length, 1, 'no creation, mount, formatting or delete before ownership validation');
  for (const foreign of ['coffee-platform-observability-data', 'coffee-observability-grafana-data',
    'coffee-observability-00000000-grafana-data']) {
    assert.throws(() => removeStorage({storage: {volumeName: foreign, backingVolume: `${foreign}-backing`, device: '/dev/loop17'}, storageHelperImage, run}), /disposable G14 storage/u);
  }
  assert.equal(calls.length, 1);
  assert.throws(() => provisionStorage({name, maxDiskBytes: Infinity, storageHelperImage, run}), /Invalid bounded/u);
});

void test('fixture cleanup validates both owners before removing or detaching storage', () => {
  const calls = [];
  const run = args => {
    calls.push(args);
    return JSON.stringify([{Labels: {'coffee.owner': 'operations', 'coffee.lifecycle': args.at(-1).endsWith('-backing') ? 'persistent' : 'fixture'}}]);
  };
  assert.throws(() => removeStorage({storage: {volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop17'}, storageHelperImage, run}), /unrelated telemetry volume/u);
  assert.ok(calls.every(args => args[0] === 'volume' && args[1] === 'inspect'));
});

void test('owned telemetry volume is rebound to a renumbered loop without touching its backing data', () => {
  const harness = storageHarness({previousDevice: '/dev/loop17', attached: false});
  assert.deepEqual(provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: harness.run}), {
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
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: harness.run}));
    assert.equal(harness.calls.some(args => args[0] === 'run'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create'), false);
  }
});

void test('owned data volume without its backing fails closed before creating or attaching storage', () => {
  const harness = storageHarness({previousDevice: '/dev/loop17', backingExists: false});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: harness.run}), /missing its backing volume/u);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create'), false);
  assert.equal(harness.calls.some(args => args[0] === 'run'), false);
  assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
});

void test('existing storage refuses a missing or symlink backing file while fresh storage formats safely', () => {
  for (const fileState of ['missing', 'symlink']) {
    const harness = storageHarness({previousDevice: '/dev/loop17'});
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: runWithShellHelper(harness, fileState)}), /storage helper rejected backing file/u);
    const attachCall = harness.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find'));
    assert.equal(attachCall.at(-1), 'true');
    const result = runStorageHelper(attachCall, fileState);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.commands, []);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'rm'), false);
    assert.equal(harness.calls.some(args => args[0] === 'volume' && args[1] === 'create' && args.at(-1) === name), false);
  }

  const fresh = storageHarness({attached: true});
  assert.deepEqual(provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: runWithShellHelper(fresh, 'missing')}), {
    volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop18', maxDiskBytes: 1073741824,
  });
  const freshAttach = fresh.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find'));
  assert.equal(freshAttach.at(-1), 'false');
  const freshResult = runStorageHelper(freshAttach, 'missing');
  assert.equal(freshResult.status, 0);
  assert.ok(freshResult.commands.includes('truncate'));
  assert.ok(freshResult.commands.includes('mkfs.ext4'));
  const lost = runStorageHelper(freshAttach, 'missing', '/dev/loop23 (lost)');
  assert.equal(lost.status, 0);
  assert.deepEqual(JSON.parse(lost.stdout), {device: '/dev/loop23', attached: true});
  for (const invalid of ['/dev/loop23 (lost) extra', '/dev/loop23/other', '/dev/loop23 (lost) (lost)', '/dev/loop999']) {
    const result = runStorageHelper(freshAttach, 'missing', invalid);
    assert.notEqual(result.status, 0);
    assert.equal(result.commands.includes('mknod'), false);
  }
  const wrongSys = runStorageHelper(freshAttach, 'missing', '/dev/loop23 (lost)', {sysDevice: '7:24'});
  assert.notEqual(wrongSys.status, 0);
  assert.equal(wrongSys.commands.includes('mknod'), false);
  const wrongNode = runStorageHelper(freshAttach, 'missing', '/dev/loop23 (lost)', {nodeDevice: '7:18'});
  assert.notEqual(wrongNode.status, 0);
  assert.equal(wrongNode.commands.filter(command => command === 'losetup').length, 2);
});

void test('telemetry failure detaches only a verified new loop and leaves a reused loop alone', () => {
  const attached = storageHarness({attached: true, failCreate: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: attached.run}), /volume create failed/u);
  const cleanup = attached.calls.find(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d'));
  assert.ok(cleanup);
  assert.equal(cleanup.at(-1), '/dev/loop18');
  assert.match(cleanup[cleanup.indexOf('-ceu') + 1], /losetup -j \/storage\/telemetry\.ext4[\s\S]*grep -Fx "\$1"; losetup -d "\$1"/u);

  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: storageHarness({attached: true, failCreate: true, failCleanup: true}).run}), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'Telemetry storage provisioning and loop cleanup failed');
    assert.deepEqual(error.errors.map(cause => cause.message), ['volume create failed', 'cleanup failed']);
    return true;
  });

  const failedRebind = storageHarness({previousDevice: '/dev/loop17', attached: true, failRemove: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: failedRebind.run}), /volume is in use/u);
  assert.deepEqual(failedRebind.calls.find(args => args[0] === 'volume' && args[1] === 'rm'), ['volume', 'rm', name]);
  assert.ok(failedRebind.calls.some(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d')));
  assert.ok(failedRebind.volumes.has(name));
  assert.ok(failedRebind.volumes.has(`${name}-backing`));

  const reused = storageHarness({previousDevice: '/dev/loop18', attached: false, failCreate: true});
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: reused.run}), /volume create failed/u);
  assert.equal(reused.calls.some(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d')), false);
});

void test('storage helper rejects image tags and uses the verified ID for every privileged operation', () => {
  const harness = storageHarness({attached: true, failCreate: true});
  for (const image of [undefined, `node:fixture@${storageHelperImage}`, 'storage-helper:latest']) {
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage: image, run: harness.run}), /Invalid bounded/u);
    assert.throws(() => removeStorage({storage: {volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop18'}, storageHelperImage: image, run: harness.run}), /Invalid verified/u);
  }
  assert.equal(harness.calls.length, 0);
  assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, run: harness.run}), /volume create failed/u);
  assert.equal(harness.calls.filter(args => args[0] === 'run').length, 2);
  assert.ok(harness.calls.filter(args => args[0] === 'run').every(args => args.includes(storageHelperImage)));
  const cleanup = storageHarness({previousDevice: '/dev/loop18'});
  removeStorage({storage: {volumeName: name, backingVolume: `${name}-backing`, device: '/dev/loop18'}, storageHelperImage, run: cleanup.run});
  assert.ok(cleanup.calls.find(args => args[0] === 'run').includes(storageHelperImage));
});

void test('G12 binds storage helper to the Node base, receipt, index and image', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coffee-storage-proof-'));
  try {
    const candidateRoot = join(root, 'candidate');
    const evidenceDir = join(root, 'evidence');
    const artifacts = join(evidenceDir, 'gates/G12_SUPPLY_CHAIN/artifacts/supply-chain/artifacts');
    mkdirSync(join(candidateRoot, 'config'), {recursive: true});
    mkdirSync(artifacts, {recursive: true});
    const hash = value => createHash('sha256').update(value).digest('hex');
    const runId = 'storage-fixture';
    const candidateSha = 'a'.repeat(40);
    const treeSha = 'b'.repeat(40);
    const manifestDigest = `sha256:${'c'.repeat(64)}`;
    const platformDigest = `sha256:${'d'.repeat(64)}`;
    const index = Buffer.from(JSON.stringify({schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: platformDigest, size: 1, platform: {os: 'linux', architecture: 'amd64'}}]}));
    const baseImage = `node:fixture@sha256:${hash(index)}`;
    const platform = Buffer.from(JSON.stringify({verification: {securityScan: {enabled: true, cpu: 2, memoryMiB: 2048, parallel: 1, minimumFreeDiskGiB: 20, maximumDatabaseAgeHours: 24, approvedFixed: [], egressRepositories: ['ghcr.io/aquasecurity/trivy-db', 'ghcr.io/aquasecurity/trivy-java-db']}}}));
    const grafanaImage = `grafana:fixture@sha256:${hash(index)}`;
    const pins = Object.fromEntries(['loki', 'tempo', 'prometheus'].map(name => [name, {version: '1.0.0', zipSha256: hash(`${name}-zip`), manifestSha256: hash(`${name}-manifest`), binarySha256: hash(`${name}-binary`)}]));
    const toolchainData = {nodeImage: baseImage, grafanaImage, grafanaPlugins: pins, grafanaSigningKeySourceSha256: hash('key'), grafanaSigningKeyFingerprint: 'A'.repeat(40), grafanaTempoModule: {version: 'fixture', h1: 'fixture', revision: 'a'.repeat(40), fixCommits: ['b'.repeat(40), 'c'.repeat(40)], replacement: null}};
    const toolchain = Buffer.from(JSON.stringify(toolchainData));
    const lockfile = Buffer.from('lock');
    const context = {runId, candidateSha, baseConfigSha256: hash(platform)};
    const environment = {runId, candidateSha, candidatePath: candidateRoot, dirty: false, configSha256: hash(platform), treeSha, toolchainVersionsSha256: hash(toolchain), lockfileSha256: hash(lockfile)};
    for (const [path, data] of [[join(candidateRoot, 'config/platform.yaml'), platform], [join(candidateRoot, 'config/toolchain-versions.json'), toolchain], [join(candidateRoot, 'pnpm-lock.yaml'), lockfile]]) {
      writeFileSync(path, data, {mode: 0o644}); chmodSync(path, 0o644);
    }
    writeFileSync(join(evidenceDir, 'environment.json'), JSON.stringify(environment), {mode: 0o600});
    const artifact = Buffer.from('artifact');
    const baseMaterial = {sourceRef: baseImage, platformManifestDigest: platformDigest, indexArtifact: {path: 'artifacts/storage-helper-base-index.json', sha256: hash(index), sizeBytes: index.length}};
    const receipt = {schemaVersion: 1, gate: 'G12_SUPPLY_CHAIN', status: 'PASS', runId, candidateSha, treeSha, configSha256: hash(platform), toolchainVersionsSha256: hash(toolchain), lockfileSha256: hash(lockfile), target: 'storage-helper', importTag: `coffee-g12-${hash(runId).slice(0, 12)}-storage-helper:latest`, baseImage, imageId: storageHelperImage, manifestDigest, platformManifestDigest: platformDigest, provenanceStatus: 'INCOMPLETE_LOCAL_CONTEXT', provenanceSha256: 'e'.repeat(64), attestationSha256: 'f'.repeat(64), buildInputBinding: {status: 'OBSERVED', sourceCommit: candidateSha, sourceTreeSha: treeSha, archiveSha256: '1'.repeat(64), archiveSizeBytes: 1, extractedTreeSha256: '2'.repeat(64), extractedBytes: 1, sourceKind: 'git-archive-local-context', buildkitMaterialsCompleteness: 'INCOMPLETE_LOCAL_CONTEXT', invocation: {entryPoint: 'docker buildx build', builder: 'coffee-platform-mtu', target: 'storage-helper', platform: 'linux/amd64', provenance: 'mode=min', output: 'oci-layout-directory'}}, ociArtifact: {path: 'artifacts/storage-helper.oci.tar', sha256: hash(artifact), sizeBytes: artifact.length, layoutTreeSha256: '3'.repeat(64), layoutBytes: 1}, baseMaterial};
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    const image = {path: 'artifacts/storage-helper-receipt.json', receiptSha256: hash(receiptBytes), imageId: receipt.imageId, importTag: receipt.importTag, manifestDigest, ociArtifactPath: receipt.ociArtifact.path, ociArtifactSha256: hash(artifact)};
    const result = {gate: 'G12_SUPPLY_CHAIN', status: 'PASS', code: 'G12_SCAN_CLEAN', runId, candidateSha, storageHelper: image, provenance: {status: 'PASS', sourceRevision: candidateSha, treeSha, configSha256: hash(platform), toolchainVersionsSha256: hash(toolchain), lockfileSha256: hash(lockfile), images: [{service: 'storage-helper', imageId: receipt.imageId, manifestDigest, platformManifestDigest: platformDigest, provenanceStatus: 'PASS', metadataSha256: receipt.provenanceSha256, attestationSha256: receipt.attestationSha256, baseMaterial}]}};
    const grafanaId = `sha256:${hash('grafana-image')}`;
    const grafanaBase = {sourceRef: grafanaImage, platformManifestDigest: platformDigest, indexArtifact: {path: 'artifacts/grafana-base-index.json', sha256: hash(index), sizeBytes: index.length}};
    const vendorPlugins = {treeSha256: hash('plugins'), treeBytes: 1, signingKeySourceSha256: toolchainData.grafanaSigningKeySourceSha256, signingKeyFingerprint: toolchainData.grafanaSigningKeyFingerprint, plugins: pins, effectiveFiles: Object.fromEntries(Object.keys(pins).map(name => [name, {path: `/opt/grafana/plugins/${name}/gpx_grafana-${name}-datasource_linux_amd64`, sha256: pins[name].binarySha256, sizeBytes: 1, layerDigest: platformDigest}]))};
    const grafanaReceipt = {...receipt, target: 'grafana', importTag: `coffee-g12-${hash(runId).slice(0, 12)}-grafana:latest`, baseImage: grafanaImage, imageId: grafanaId, baseMaterial: grafanaBase, buildInputBinding: {...receipt.buildInputBinding, sourceKind: 'git-archive-plus-verified-plugins', invocation: {...receipt.buildInputBinding.invocation, target: 'grafana'}, vendorPlugins}, ociArtifact: {...receipt.ociArtifact, path: 'artifacts/grafana.oci.tar'}};
    const grafanaReceiptBytes = Buffer.from(JSON.stringify(grafanaReceipt));
    result.grafana = {path: 'artifacts/grafana-receipt.json', receiptSha256: hash(grafanaReceiptBytes), imageId: grafanaId, importTag: grafanaReceipt.importTag, manifestDigest, ociArtifactPath: grafanaReceipt.ociArtifact.path, ociArtifactSha256: grafanaReceipt.ociArtifact.sha256};
    result.provenance.images.push({service: 'grafana', imageId: grafanaId, manifestDigest, platformManifestDigest: platformDigest, provenanceStatus: 'PASS', metadataSha256: grafanaReceipt.provenanceSha256, attestationSha256: grafanaReceipt.attestationSha256, baseMaterial: grafanaBase});
    const services = [...RUNTIME_NAMES, 'grafana', 'storage-helper', 'edge-nginx', 'kafka', 'otel-collector', 'loki', 'prometheus', 'tempo', 'lockfile'];
    result.reports = [];
    for (const service of services) {
      const existing = result.provenance.images.find(entry => entry.service === service);
      const imageId = existing?.imageId ?? `sha256:${hash(service)}`;
      if (!existing && service !== 'lockfile') {
        const upstream = ['otel-collector', 'loki', 'prometheus', 'tempo'].includes(service);
        result.provenance.images.push(upstream
          ? {service, imageId, manifestDigest, sourceReference: `${service}:fixture@${manifestDigest}`, identityStatus: 'PINNED_DIGEST_VERIFIED'}
          : {service, imageId, manifestDigest, platformManifestDigest: platformDigest, provenanceStatus: 'PASS', metadataSha256: hash(`${service}-metadata`), attestationSha256: hash(`${service}-attestation`)});
      }
      for (const suffix of ['sbom.cdx.json', 'vulnerabilities.json']) {
        const name = `${service}.${suffix}`;
        const contents = Buffer.from(JSON.stringify(suffix === 'vulnerabilities.json' ? {Results: [], Metadata: service === 'lockfile' ? {} : {ImageID: imageId}} : {bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: []}));
        writeFileSync(join(artifacts, name), contents, {mode: 0o600});
        result.reports.push({path: name, sha256: hash(contents), findings: {high: 0, critical: 0}});
      }
    }
    result.findings = {high: 0, critical: 0};
    result.evaluation = {rawHigh: 0, resolvedFixed: 0, unresolvedHigh: 0, critical: 0};
    const decision = {schemaVersion: 1, gate: 'G12_SUPPLY_CHAIN', runId, candidateSha, treeSha, configSha256: hash(platform), toolchainVersionsSha256: hash(toolchain), lockfileSha256: hash(lockfile), imageId: grafanaId, manifestDigest, platformManifestDigest: platformDigest, rawReportSha256: result.reports.find(entry => entry.path === 'grafana.vulnerabilities.json').sha256, approvedFixed: [], vendorPlugins, module: toolchainData.grafanaTempoModule, decisions: [], evaluatedAt: '2026-10-30T00:00:00.000Z', openVex: null};
    const decisionBytes = Buffer.from(JSON.stringify(decision));
    result.adjudication = {path: 'artifacts/grafana-adjudication.json', sha256: hash(decisionBytes)};
    writeFileSync(join(artifacts, 'grafana-receipt.json'), grafanaReceiptBytes, {mode: 0o600});
    writeFileSync(join(artifacts, 'grafana-adjudication.json'), decisionBytes, {mode: 0o600});
    for (const [path, data] of [[join(artifacts, '../result.json'), JSON.stringify(result)], [join(artifacts, 'storage-helper-receipt.json'), receiptBytes], [join(artifacts, 'storage-helper.oci.tar'), artifact], [join(artifacts, 'storage-helper-base-index.json'), index]]) writeFileSync(path, data, {mode: 0o600});
    const options = {target: 'storage-helper', contextFile: join(root, 'context'), loadImage: false, validateContext: async () => ({context, candidateRoot, evidenceDir})};
    const validated = await loadVerifiedGateImage(options);
    assert.equal(validated.imageId, storageHelperImage);
    assert.ok(Object.isFrozen(validated));
    writeFileSync(join(artifacts, 'storage-helper-base-index.json'), '{}');
    await assert.rejects(loadVerifiedGateImage(options), /G12_KAFKA_BASE_MATERIAL_INVALID/u);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

void test('fixture backing placement binds an owned empty directory and cleans its exact file', () => {
  const root = mkdtempSync(join(tmpdir(), 'coffee-observability-00000000-0000-4000-8000-000000000001-storage-'));
  const dir = join(root, name);
  mkdirSync(dir, {mode: 0o700});
  const calls = [];
  const volumes = new Map();
  const run = args => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (!volumes.has(args[2])) throw Object.assign(new Error('no such volume'), {stderr: 'no such volume'});
      return JSON.stringify([volumes.get(args[2])]);
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const options = args.flatMap((arg, i) => arg === '--opt' ? [args[i + 1]] : []);
      volumes.set(args.at(-1), {Driver: 'local', Labels: labels('fixture'), Options: Object.fromEntries(options.map(option => {
        const split = option.indexOf('=');
        return [option.slice(0, split), option.slice(split + 1)];
      }))});
      return '';
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]); return ''; }
    if (args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find')) {
      writeFileSync(join(dir, 'telemetry.ext4'), 'fixture');
      return JSON.stringify({device: '/dev/loop18', attached: true});
    }
    return '';
  };
  try {
    const storage = provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run});
    assert.deepEqual(volumes.get(`${name}-backing`).Options, {type: 'none', o: 'bind', device: dir});
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run}), /private and empty/u);
    const info = volumes.get(`${name}-backing`);
    info.Options.device = join(root, 'unrelated');
    const before = calls.length;
    assert.throws(() => removeStorage({storage, storageHelperImage, run}), /storage options changed/u);
    assert.ok(calls.slice(before).every(args => args[0] === 'volume' && args[1] === 'inspect'));
    assert.ok(existsSync(join(dir, 'telemetry.ext4')));
    info.Options.device = dir;
    renameSync(join(dir, 'telemetry.ext4'), join(dir, 'retained'));
    symlinkSync(join(dir, 'retained'), join(dir, 'telemetry.ext4'));
    assert.throws(() => removeStorage({storage, storageHelperImage, run}), /backing path identity changed/u);
    assert.ok(existsSync(join(dir, 'retained')));
    rmSync(join(dir, 'telemetry.ext4'));
    renameSync(join(dir, 'retained'), join(dir, 'telemetry.ext4'));
    removeStorage({storage, storageHelperImage, run});
    assert.equal(existsSync(dir), false);
    assert.ok(existsSync(root));
    assert.equal(volumes.size, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

void test('fixture backing placement refuses persistent names, symlinks and reused directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'coffee-observability-00000000-0000-4000-8000-000000000001-storage-'));
  const dir = join(root, name);
  mkdirSync(dir, {mode: 0o700});
  const calls = [];
  const run = args => { calls.push(args); return ''; };
  try {
    assert.throws(() => provisionStorage({name: 'coffee-production-loki-data', maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run}), /Invalid fixture/u);
    writeFileSync(join(dir, 'unrelated'), 'preserve');
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run}), /private and empty/u);
    rmSync(join(dir, 'unrelated'));
    rmSync(dir, {recursive: true});
    symlinkSync(root, dir);
    assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run}), /Invalid fixture/u);
    assert.equal(calls.length, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

void test('failed fixture allocation cleans only an identified file with no loop association', () => {
  for (const ambiguous of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'coffee-observability-00000000-0000-4000-8000-000000000001-storage-'));
    const dir = join(root, name);
    mkdirSync(dir, {mode: 0o700});
    const volumes = new Map();
    const calls = [];
    const run = args => {
      calls.push(args);
      if (args[0] === 'volume' && args[1] === 'inspect') {
        if (!volumes.has(args[2])) throw Object.assign(new Error('no such volume'), {stderr: 'no such volume'});
        return JSON.stringify([volumes.get(args[2])]);
      }
      if (args[0] === 'volume' && args[1] === 'create') {
        volumes.set(args.at(-1), {Driver: 'local', Labels: labels('fixture'), Options: {type: 'none', o: 'bind', device: dir}});
      }
      if (args[0] === 'volume' && args[1] === 'rm') volumes.delete(args[2]);
      if (args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup --find')) {
        writeFileSync(join(dir, 'telemetry.ext4'), 'fixture');
        throw new Error('allocation failed');
      }
      if (args[0] === 'run' && ambiguous) throw new Error('loop association cannot be verified');
      return '';
    };
    try {
      assert.throws(() => provisionStorage({name, maxDiskBytes: 1073741824, storageHelperImage, backingDirectory: dir, run}), ambiguous ? /fixture allocation retained/u : /allocation failed/u);
      assert.equal(existsSync(dir), ambiguous);
      assert.equal(volumes.has(`${name}-backing`), ambiguous);
      assert.equal(calls.some(args => args[0] === 'run' && args[args.indexOf('-ceu') + 1]?.includes('losetup -d')), false);
    } finally { rmSync(root, {recursive: true, force: true}); }
  }
});
