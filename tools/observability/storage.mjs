import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';

// Operations создаёт отдельную файловую систему: telemetry не может заполнить business disk.
export function provisionStorage({name, maxDiskBytes, nodeImage, run = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim()}) {
  if (!/^coffee-[a-z0-9-]+$/u.test(name) || !Number.isSafeInteger(maxDiskBytes) || maxDiskBytes < 268435456 || !/@sha256:[0-9a-f]{64}$/u.test(nodeImage)) throw new Error('Invalid bounded telemetry storage specification');
  const backingVolume = `${name}-backing`;
  const lifecycle = /^coffee-g14-[a-f0-9-]{36}-data$/u.test(name) ? 'fixture' : 'persistent';
  const owned = volume => {
    let info;
    try { info = JSON.parse(run(['volume', 'inspect', volume]))[0]; }
    catch (error) { if (/no such volume/iu.test(String(error.stderr ?? error.message))) return undefined; throw error; }
    if (info?.Labels?.['coffee.owner'] !== 'operations' || info.Labels['coffee.lifecycle'] !== lifecycle) throw new Error('Refusing to reuse unrelated telemetry volume');
    return info;
  };
  owned(backingVolume);
  run(['volume', 'create', '--label', 'coffee.owner=operations', '--label', `coffee.lifecycle=${lifecycle}`, backingVolume]);
  const device = run(['run', '--rm', '--privileged', '--network', 'none', '--mount', `type=volume,source=${backingVolume},target=/storage`, nodeImage, 'sh', '-ceu', `
    if [ -e /storage/telemetry.ext4 ]; then
      test "$(stat -c %s /storage/telemetry.ext4)" = "$1"
    else
      truncate -s "$1" /storage/telemetry.ext4
      mkfs.ext4 -q -m 0 /storage/telemetry.ext4
    fi
    existing=$(losetup -j /storage/telemetry.ext4 | cut -d : -f 1)
    if [ -n "$existing" ]; then printf '%s' "$existing"; else
      device=$(losetup --find)
      test -b "$device" || mknod "$device" b 7 "\${device##*loop}"
      losetup "$device" /storage/telemetry.ext4
      printf '%s' "$device"
    fi
  `, 'storage', String(maxDiskBytes)]).trim();
  if (!/^\/dev\/loop[0-9]+$/u.test(device)) throw new Error('Cannot provision bounded telemetry loop device');
  const previous = owned(name);
  if (previous && (previous.Options?.device !== device || previous.Options?.type !== 'ext4')) throw new Error('Existing telemetry volume has different storage backing');
  run(['volume', 'create', '--driver', 'local', '--opt', 'type=ext4', '--opt', `device=${device}`, '--opt', 'o=nodev,nosuid,noexec', '--label', 'coffee.owner=operations', '--label', `coffee.lifecycle=${lifecycle}`, name]);
  return {volumeName: name, backingVolume, device, maxDiskBytes};
}

export function removeStorage({storage, nodeImage, run = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})}) {
  if (!/^coffee-g14-[a-f0-9-]{36}-data$/u.test(storage.volumeName) || storage.backingVolume !== `${storage.volumeName}-backing` || !/^\/dev\/loop[0-9]+$/u.test(storage.device)) throw new Error('Cleanup is restricted to disposable G14 storage');
  for (const volume of [storage.volumeName, storage.backingVolume]) {
    const info = JSON.parse(run(['volume', 'inspect', volume]))[0];
    if (info?.Labels?.['coffee.owner'] !== 'operations' || info.Labels['coffee.lifecycle'] !== 'fixture') throw new Error('Refusing to remove unrelated telemetry volume');
  }
  run(['volume', 'rm', storage.volumeName]);
  // Сопоставление backing file проверяется до detach; чужой loop device не трогаем.
  run(['run', '--rm', '--privileged', '--network', 'none', '--mount', `type=volume,source=${storage.backingVolume},target=/storage`, nodeImage, 'sh', '-ceu', 'losetup -j /storage/telemetry.ext4 | cut -d : -f 1 | grep -Fx "$1"; losetup -d "$1"', 'storage', storage.device]);
  run(['volume', 'rm', storage.backingVolume]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--name');
    if (index < 0 || !process.argv[index + 1]) throw new Error('--name is required');
    const config = await loadPlatformConfig();
    const bom = JSON.parse(await readFile(new URL('../../config/toolchain-versions.json', import.meta.url), 'utf8'));
    console.log(JSON.stringify(provisionStorage({name: process.argv[index + 1], maxDiskBytes: config.telemetry.openObserve.maxDiskBytes, nodeImage: bom.nodeImage})));
  } catch (error) {
    console.error(`telemetry storage: ${error.message}`);
    process.exitCode = 1;
  }
}
