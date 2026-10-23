import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {materializeCollectorSecrets, materializeOpenObserveAdminSecret, removeMaterializedSecrets} from '../config-bootstrap/index.mjs';
import {verifyBootstrapProbe} from './generate.mjs';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';

export {materializeCollectorSecrets, materializeOpenObserveAdminSecret};

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

function readCpuFlags(path = '/proc/cpuinfo') {
  const cpuInfo = readFile(path, 'utf8');
  return cpuInfo.then((text) => new Set(text.match(/^flags\s*:\s*(.+)$/mu)?.[1]?.split(/\s+/u) ?? []));
}

function run(args, runDocker, timeout = 5000) {
  return runDocker(args, {timeout});
}

async function waitForOpenObserve({container, endpoint, startupGraceMs, runDocker, secrets = [], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}) {
  const diagnostics = () => {
    const redact = (value) => secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, String(value ?? ''))
      .replace(/(authorization|token|password|secret)([=: ]+)\S+/giu, '$1$2[REDACTED]')
      .replace(/o2oi_[A-Za-z0-9_-]+/gu, '[REDACTED]');
    let state;
    try {
      const rawState = run(['inspect', '--format={{json .State}}', container], runDocker, 3000);
      const value = JSON.parse(rawState);
      state = Object.fromEntries(['Running', 'ExitCode', 'OOMKilled', 'Error', 'StartedAt', 'FinishedAt']
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, typeof value[key] === 'string' ? redact(value[key]) : value[key]]));
    } catch {}
    let logs = '';
    try { logs = run(['logs', '--tail', '80', container], runDocker, 3000); } catch (error) { logs = error?.stdout ?? ''; }
    const errorLines = redact(logs).split(/\r?\n/u)
      .filter((line) => /\b(?:warn(?:ing)?|error|panic)\b/iu.test(line))
      .slice(-12)
      .map((line) => line.slice(-320));
    return {state, errorOrWarningLines: errorLines};
  };
  const startupError = (message) => {
    const details = diagnostics();
    const summary = [
      details.state === undefined ? undefined : `state: ${JSON.stringify(details.state)}`,
      details.errorOrWarningLines.length === 0 ? undefined : `docker logs stdout+stderr (last error/warn lines): ${details.errorOrWarningLines.join('\n')}`,
    ].filter(Boolean).join('; ');
    const error = new Error(`${message}${summary ? `; ${summary}` : ''}`);
    error.containerDiagnostics = [{
      name: container,
      stage: 'seed',
      state: details.state ?? null,
      errorOrWarningLines: details.errorOrWarningLines,
    }];
    return error;
  };
  const deadline = Date.now() + startupGraceMs;
  let lastError;
  while (Date.now() < deadline) {
    const running = run(['inspect', '--format={{.State.Running}}', container], runDocker, 3000).trim();
    if (running !== 'true') {
      throw startupError('OpenObserve seed process exited before becoming healthy');
    }
    try {
      run(['exec', container, '/busybox', 'wget', '-q', '-O', '/dev/null', '-T', '2', endpoint], runDocker, 3000);
      return;
    } catch (error) {
      lastError = error;
      await wait(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  }
  throw startupError(`OpenObserve did not become healthy within ${startupGraceMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

export async function initializeOpenObserve({
  config,
  imageRefs,
  openObserveDataVolume,
  adminSecretPath,
  emulatorPath,
  probePath = '/usr/bin/busybox',
  runDocker = (args, {timeout = 5000} = {}) => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout}),
  cpuFlags = readCpuFlags(),
  wait,
} = {}) {
  const openObserve = requireValue(config?.telemetry?.openObserve, 'telemetry.openObserve');
  const bootstrapEmail = requireValue(openObserve.bootstrapEmail, 'telemetry.openObserve.bootstrapEmail');
  const validationMarker = requireValue(openObserve.validationMarker, 'telemetry.openObserve.validationMarker');
  const startupGraceMs = requireValue(config?.platform?.health?.startupGraceMs, 'platform.health.startupGraceMs');
  const dataDir = '/data';
  if (!/^coffee-[a-z0-9-]+$/u.test(openObserveDataVolume ?? '')) throw new Error('openObserveDataVolume must be an isolated named volume');
  const image = requireValue(imageRefs?.openObserveImage, 'openObserveImage BOM ref');
  const nodeImage = requireValue(imageRefs?.nodeImage, 'nodeImage BOM ref');
  if (!/@sha256:[a-f0-9]{64}$/u.test(image) || !/@sha256:[a-f0-9]{64}$/u.test(nodeImage)) throw new Error('OpenObserve and Node helper images must use BOM digests');
  const secretInfo = await lstat(adminSecretPath);
  if (!secretInfo.isFile() || (secretInfo.mode & 0o777) !== 0o400) throw new Error('OpenObserve admin secret must be a regular mode 0400 tmpfs file');
  const adminSecretValue = (await readFile(adminSecretPath, 'utf8')).trim();
  if (!adminSecretValue || adminSecretValue === validationMarker) throw new Error('OpenObserve admin secret must be non-empty and distinct from the runtime validation marker');
  if (emulatorPath !== undefined) {
    if (!isAbsolute(emulatorPath)) throw new Error('OpenObserve emulator path must be absolute');
    const emulatorInfo = await lstat(emulatorPath);
    if (!emulatorInfo.isFile() || (emulatorInfo.mode & 0o111) === 0) throw new Error('OpenObserve emulator must be an executable regular file');
  }
  await verifyBootstrapProbe({probePath, expectedSha256: imageRefs.bootstrapProbeSha256});
  const flags = await cpuFlags;
  if (emulatorPath === undefined)
    for (const flag of ['avx', 'aes']) if (!flags.has(flag)) throw new Error(`OpenObserve requires host CPU flag ${flag}`);

  const secret = resolve(adminSecretPath);
  const container = `coffee-openobserve-seed-${randomUUID()}`;
  const endpoint = `http://127.0.0.1:${new URL(openObserve.endpoint).port}/healthz`;
  const nodeArgs = [
    'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32',
    '--mount', `type=volume,source=${openObserveDataVolume},target=${dataDir}`,
    '--mount', `type=bind,source=${secret},target=/admin-secret`,
    nodeImage, 'node', '-e',
    'require("node:fs").chownSync("/data", 10001, 10001); require("node:fs").chownSync("/admin-secret", 10001, 10001)',
  ];
  run(nodeArgs, runDocker, 10000);
  const emulatorMount = emulatorPath === undefined ? [] : ['--mount', `type=bind,source=${resolve(emulatorPath)},target=/run/tools/qemu-x86_64,readonly`];
  const seedCommand = emulatorPath === undefined
    ? 'export ZO_ROOT_USER_PASSWORD="$(/busybox cat /admin-secret)"; exec /openobserve'
    : 'export ZO_ROOT_USER_PASSWORD="$(/busybox cat /admin-secret)"; exec /run/tools/qemu-x86_64 -cpu max /openobserve';
  const startArgs = [
    'run', '--detach', '--name', container, '--network', 'none', '--read-only', '--user', '10001:10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', `${openObserve.memoryLimitMiB}m`, '--pids-limit', '128',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m',
    '--mount', `type=volume,source=${openObserveDataVolume},target=${dataDir}`,
    '--mount', `type=bind,source=${resolve(probePath)},target=/busybox,readonly`,
    '--mount', `type=bind,source=${secret},target=/admin-secret,readonly`,
    ...emulatorMount,
    '--env', 'ZO_LOCAL_MODE=true', '--env', `ZO_DATA_DIR=${dataDir}`, '--env', `ZO_HTTP_PORT=${new URL(openObserve.endpoint).port}`,
    '--env', `ZO_TELEMETRY=${openObserve.telemetryEnabled}`,
    '--env', `ZO_MMDB_DISABLE_DOWNLOAD=${!openObserve.mmdbDownloadEnabled}`,
    '--env', `ZO_MODEL_PRICING_ENABLED=${openObserve.modelPricingEnabled}`,
    '--env', `ZO_COMPACT_INTERVAL=${openObserve.compactionIntervalSeconds}`,
    '--env', `ZO_COMPACT_DATA_RETENTION_INTERVAL=${openObserve.compactionIntervalSeconds}`,
    '--env', `ZO_COMPACT_DATA_RETENTION_DAYS=${openObserve.retentionDays}`,
    '--env', `ZO_COMPACT_DELETE_FILES_DELAY_MINUTES=${openObserve.deleteFilesDelayMinutes}`,
    '--env', `ZO_COMPACT_JOB_CLEAN_WAIT_TIME=${openObserve.jobCleanupWaitSeconds}`,
    '--env', 'ZO_DISK_CIRCUIT_BREAKER_ENABLED=true',
    '--env', `ZO_DISK_CIRCUIT_BREAKER_THRESHOLD=${openObserve.diskWatermarkPercent}`,
    '--env', `ZO_ROOT_USER_EMAIL=${bootstrapEmail}`,
    '--entrypoint', '/busybox', image, 'sh', '-ceu',
    seedCommand,
  ];
  let started = false;
  try {
    run(startArgs, runDocker, 10000);
    started = true;
    await waitForOpenObserve({container, endpoint, startupGraceMs, runDocker, secrets: [adminSecretValue], wait});
    const validateAndMark = [
      'const fs=require("node:fs");',
      'const email=process.env.ZO_ROOT_USER_EMAIL;',
      'const password=fs.readFileSync("/admin-secret","utf8").trim();',
      'const authorization="Basic "+Buffer.from(email+":"+password).toString("base64");',
      'fetch(`http://127.0.0.1:${process.env.ZO_HTTP_PORT}/api/organizations`,{headers:{authorization},signal:AbortSignal.timeout(3000)})',
      '.then(async response=>{await response.arrayBuffer();if(response.status!==200)throw new Error(`root authentication returned HTTP ${response.status}`);',
      'fs.writeFileSync("/data/.coffee-initialized-v1",email+"\\n",{encoding:"utf8",mode:0o600,flag:"wx"});})',
      '.catch(error=>{console.error(error.message);process.exitCode=1})',
    ].join('');
    run([
      'run', '--rm', '--network', `container:${container}`, '--read-only', '--user', '10001:10001',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32',
      '--mount', `type=volume,source=${openObserveDataVolume},target=${dataDir}`,
      '--mount', `type=bind,source=${secret},target=/admin-secret,readonly`,
      '--env', `ZO_HTTP_PORT=${new URL(openObserve.endpoint).port}`, '--env', `ZO_ROOT_USER_EMAIL=${bootstrapEmail}`,
      nodeImage, 'node', '-e', validateAndMark,
    ], runDocker, 8000);
    return {container, initialized: true};
  } finally {
    if (started) run(['rm', '--force', container], runDocker, 5000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const initialize = process.argv.includes('--initialize');
    const admin = process.argv.includes('--openobserve-admin');
    const collector = process.argv.includes('--collector');
    if ([initialize, admin, collector].filter(Boolean).length !== 1) throw new Error('select exactly one of --collector, --openobserve-admin, or --initialize');
    const option = (name) => {
      const index = process.argv.indexOf(name);
      if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
      return process.argv[index + 1];
    };
    if (initialize) {
      const config = await loadPlatformConfig();
      const toolchain = JSON.parse(await readFile(new URL('../../config/toolchain-versions.json', import.meta.url), 'utf8'));
      const secrets = await materializeOpenObserveAdminSecret();
      try {
        const result = await initializeOpenObserve({
          config,
          imageRefs: {
            openObserveImage: toolchain.openObserveImage,
            nodeImage: toolchain.nodeImage,
            bootstrapProbeSha256: toolchain.bootstrapProbeSha256,
          },
          openObserveDataVolume: option('--data-volume'),
          adminSecretPath: secrets.path,
          probePath: process.argv.includes('--probe-path') ? option('--probe-path') : '/usr/bin/busybox',
          ...(process.argv.includes('--emulator') ? {emulatorPath: option('--emulator')} : {}),
        });
        console.log(`OpenObserve initialized in one-shot container ${result.container}`);
      } finally {
        await removeMaterializedSecrets(secrets.path);
      }
    } else {
      const outputDir = process.argv.includes('--output-dir') ? option('--output-dir') : undefined;
      const result = admin
        ? await materializeOpenObserveAdminSecret({outputDir})
        : await materializeCollectorSecrets({outputDir});
      console.log(`observability bootstrap: materialized ${result.runtime} secrets at ${result.path}`);
    }
  } catch (error) {
    console.error(`observability bootstrap failed: ${error.message}`);
    process.exitCode = 1;
  }
}
