import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';
import {loadVerifiedGateImage} from '../verified-infrastructure-image.mjs';

// Operations создаёт отдельную файловую систему: telemetry не может заполнить business disk.
export function provisionStorage({name, maxDiskBytes, storageHelperImage, run = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()}) {
  if (!/^coffee-[a-z0-9-]+$/u.test(name) || !Number.isSafeInteger(maxDiskBytes) || maxDiskBytes < 268435456 || !/^sha256:[0-9a-f]{64}$/u.test(storageHelperImage)) throw new Error('Invalid bounded telemetry storage specification');
  const backingVolume = `${name}-backing`;
  const lifecycle = /^coffee-g14-[a-f0-9-]{36}-(?:grafana|loki|prometheus|tempo)-data$/u.test(name) ? 'fixture' : 'persistent';
  const owned = volume => {
    let info;
    try { info = JSON.parse(run(['volume', 'inspect', volume]))[0]; }
    catch (error) { if (/no such volume/iu.test(String(error.stderr ?? error.message))) return undefined; throw error; }
    if (info?.Labels?.['coffee.owner'] !== 'operations' || info.Labels['coffee.lifecycle'] !== lifecycle) throw new Error('Refusing to reuse unrelated telemetry volume');
    return info;
  };
  const backing = owned(backingVolume);
  if (backing && (backing.Driver !== 'local' || (backing.Options && Object.keys(backing.Options).length > 0))) throw new Error('Existing telemetry backing volume has different storage options');
  const previous = owned(name);
  if (previous && !backing) throw new Error('Existing telemetry volume is missing its backing volume');
  if (previous) {
    const options = previous.Options ?? {};
    if (previous.Driver !== 'local' || options.type !== 'ext4' || options.o !== 'nodev,nosuid,noexec' || !/^\/dev\/loop[0-9]+$/u.test(options.device ?? '') || Object.keys(options).length !== 3)
      throw new Error('Existing telemetry volume has different storage backing');
    if (run(['ps', '--all', '--filter', `volume=${name}`, '--format', '{{.ID}}']).trim()) throw new Error('Cannot rebind an active telemetry volume');
  }
  run(['volume', 'create', '--label', 'coffee.owner=operations', '--label', `coffee.lifecycle=${lifecycle}`, backingVolume]);
  const attachment = JSON.parse(run(['run', '--rm', '--privileged', '--network', 'none', '--mount', `type=volume,source=${backingVolume},target=/storage`, storageHelperImage, 'sh', '-ceu', `
    if [ -L /storage/telemetry.ext4 ]; then exit 1; fi
    if [ -e /storage/telemetry.ext4 ]; then
      test -f /storage/telemetry.ext4
      test "$(stat -c %s /storage/telemetry.ext4)" = "$1"
      test "$(blkid -p -s TYPE -o value /storage/telemetry.ext4)" = ext4
    else
      test "$2" = false
      truncate -s "$1" /storage/telemetry.ext4
      mkfs.ext4 -q -m 0 /storage/telemetry.ext4
    fi
    existing=$(losetup -j /storage/telemetry.ext4 | cut -d : -f 1)
    if [ -n "$existing" ]; then printf '{"device":"%s","attached":false}' "$existing"; else
      device=$(losetup --find)
      test -b "$device" || mknod "$device" b 7 "\${device##*loop}"
      losetup "$device" /storage/telemetry.ext4
      printf '{"device":"%s","attached":true}' "$device"
    fi
  `, 'storage', String(maxDiskBytes), String(Boolean(previous))]));
  const {device, attached} = attachment;
  const validDevice = typeof device === 'string' && /^\/dev\/loop[0-9]+$/u.test(device);
  try {
    if (!validDevice) throw new Error('Cannot provision bounded telemetry loop device');
    if (typeof attached !== 'boolean') throw new Error('Cannot verify telemetry loop attachment');
    if (previous && previous.Options.device !== device) run(['volume', 'rm', name]);
    const volumeLabels = previous?.Labels ?? {'coffee.owner': 'operations', 'coffee.lifecycle': lifecycle};
    run(['volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${device}`, '--opt', 'o=nodev,nosuid,noexec', ...Object.entries(volumeLabels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), name]);
    return {volumeName: name, backingVolume, device, maxDiskBytes};
  } catch (error) {
    if (attached === true && validDevice) {
      try {
        run(['run', '--rm', '--privileged', '--network', 'none', '--mount', `type=volume,source=${backingVolume},target=/storage`, storageHelperImage, 'sh', '-ceu', 'losetup -j /storage/telemetry.ext4 | cut -d : -f 1 | grep -Fx "$1"; losetup -d "$1"', 'storage', device]);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Telemetry storage provisioning and loop cleanup failed');
      }
    }
    throw error;
  }
}

export function removeStorage({storage, storageHelperImage, run = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})}) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(storageHelperImage)) throw new Error('Invalid verified telemetry storage helper image');
  if (!/^coffee-g14-[a-f0-9-]{36}-(?:grafana|loki|prometheus|tempo)-data$/u.test(storage.volumeName) || storage.backingVolume !== `${storage.volumeName}-backing` || !/^\/dev\/loop[0-9]+$/u.test(storage.device)) throw new Error('Cleanup is restricted to disposable G14 storage');
  for (const volume of [storage.volumeName, storage.backingVolume]) {
    const info = JSON.parse(run(['volume', 'inspect', volume]))[0];
    if (info?.Labels?.['coffee.owner'] !== 'operations' || info.Labels['coffee.lifecycle'] !== 'fixture') throw new Error('Refusing to remove unrelated telemetry volume');
  }
  run(['volume', 'rm', storage.volumeName]);
  // Сопоставление backing file проверяется до detach; чужой loop device не трогаем.
  run(['run', '--rm', '--privileged', '--network', 'none', '--mount', `type=volume,source=${storage.backingVolume},target=/storage`, storageHelperImage, 'sh', '-ceu', 'losetup -j /storage/telemetry.ext4 | cut -d : -f 1 | grep -Fx "$1"; losetup -d "$1"', 'storage', storage.device]);
  run(['volume', 'rm', storage.backingVolume]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--name');
    if (index < 0 || !process.argv[index + 1]) throw new Error('--name is required');
    const storeIndex = process.argv.indexOf('--store');
    const store = process.argv[storeIndex + 1];
    if (storeIndex < 0 || !['grafana', 'loki', 'prometheus', 'tempo'].includes(store)) throw new Error('--store must be grafana, loki, prometheus or tempo');
    const config = await loadPlatformConfig();
    const image = await loadVerifiedGateImage({target: 'storage-helper'});
    console.log(JSON.stringify(provisionStorage({name: process.argv[index + 1], maxDiskBytes: config.telemetry[store].maxDiskBytes, storageHelperImage: image.imageId})));
  } catch (error) {
    console.error(`telemetry storage: ${error.message}`);
    process.exitCode = 1;
  }
}
