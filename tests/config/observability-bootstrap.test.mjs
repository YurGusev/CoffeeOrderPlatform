import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import test from 'node:test';
import {infrastructureSecretEntries, loadServiceCatalog} from '../../scripts/config-lib.mjs';
import {
  createCollectorConfig,
  createObservabilityProvenance,
  createComposeOverride,
  discoverContainerLogs,
  ensureCollectorConfigOwnership,
  generateRuntimeLoggingOverride,
  openObserveBufferEnvironment,
  verifyBootstrapProbe,
} from '../../tools/observability/generate.mjs';
import {materializeCollectorSecrets, materializeOpenObserveAdminSecret} from '../../tools/config-bootstrap/index.mjs';
import {initializeOpenObserve} from '../../tools/observability/bootstrap.mjs';
import {checkObservabilityHealth} from '../../tools/observability/health.mjs';
import {verifyCollectorQueueMetrics} from '../../tools/observability/verify.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const sample = {
  environment: 'development',
  platform: {health: {intervalMs: 5000, timeoutMs: 1000, startupGraceMs: 30000, failureThreshold: 3}},
  telemetry: {
    namespace: 'coffee-platform', releaseDigest: 'development', nginxStatusEndpoint: 'http://edge-nginx:8081/nginx_status',
    collector: {
      otlpEndpoint: 'http://otel-collector:4318', healthEndpoint: 'http://otel-collector:13133',
      metricsEndpoint: 'http://otel-collector:8888', memoryLimitMiB: 128, memorySpikeMiB: 32,
      memoryCheckIntervalMs: 1000, batchSize: 128, batchTimeoutMs: 1000, queueCapacity: 512,
      queueConsumers: 2, exportTimeoutMs: 2000, retryInitialMs: 1000, retryMaxMs: 5000,
      retryWindowMs: 15000, maxLogRecordBytes: 65536,
    },
    producer: {
      queueCapacity: 256, maxRecordBytes: 16384, batchSize: 64, batchIntervalMs: 1000,
      exportTimeoutMs: 1000, diagnosticIntervalMs: 10000, flushTimeoutMs: 2000,
    },
    logging: {maxSizeMiB: 8, maxFiles: 3},
    openObserve: {
      endpoint: 'http://openobserve:5080', organization: 'coffee',
      bootstrapEmail: 'operations@coffee-platform.internal', validationMarker: 'bootstrap-validation-placeholder',
      telemetryEnabled: false, mmdbDownloadEnabled: false, modelPricingEnabled: false, memoryLimitMiB: 512,
      memTableMaxSizeMiB: 128, maxFileSizeInMemoryMiB: 8, maxFileSizeOnDiskMiB: 8,
      maxFileRetentionSeconds: 30, memPersistIntervalSeconds: 2,
      streams: {logs: 'platform_logs', traces: 'platform_traces', metrics: 'platform_metrics'},
      retentionDays: 3, maxDiskBytes: 1073741824, diskWatermarkPercent: 80,
      compactionIntervalSeconds: 60, deleteFilesDelayMinutes: 1, jobCleanupWaitSeconds: 60,
    },
  },
};
const logs = [
  {service: 'edge-nginx', containerId: 'a'.repeat(64), logPath: `/var/lib/docker/containers/${'a'.repeat(64)}/${'a'.repeat(64)}-json.log`},
  {service: 'orders-service', containerId: 'b'.repeat(64), logPath: `/srv/coffee/docker-data/containers/${'b'.repeat(64)}/${'b'.repeat(64)}-json.log`},
];

void test('infrastructure secret scopes come from the validated catalog and separate Collector/admin credentials', async () => {
  const catalog = await loadServiceCatalog(REPO_ROOT);
  assert.deepEqual(catalog.infrastructureSecretScopes, {
    'otel-collector': [
      {name: 'exporterToken', ref: 'telemetry.exporterToken'},
      {name: 'openObserveIngestToken', ref: 'telemetry.openObserveIngestToken'},
    ],
    'openobserve-bootstrap': [
      {name: 'admin-secret', ref: 'telemetry.openObserveAdmin'},
    ],
  });
  assert.deepEqual(await infrastructureSecretEntries('otel-collector', {root: REPO_ROOT}), [
    ['exporterToken', 'telemetry.exporterToken'],
    ['openObserveIngestToken', 'telemetry.openObserveIngestToken'],
  ]);
  assert.deepEqual(await infrastructureSecretEntries('openobserve-bootstrap', {root: REPO_ROOT}), [
    ['admin-secret', 'telemetry.openObserveAdmin'],
  ]);
  await assert.rejects(infrastructureSecretEntries('openobserve', {root: REPO_ROOT}), /unknown infrastructure secret scope/u);
});

void test('catalog schema rejects widening Collector scope to OpenObserve admin', async () => {
  const root = await mkdtemp('/dev/shm/coffee-observability-catalog-');
  try {
    await mkdir(`${root}/config`, {recursive: true});
    await cp(`${REPO_ROOT}/config/service-catalog.schema.json`, `${root}/config/service-catalog.schema.json`);
    const catalogPath = `${root}/config/service-catalog.json`;
    const catalog = await loadServiceCatalog(REPO_ROOT);
    catalog.infrastructureSecretScopes['otel-collector'].push({name: 'admin-secret', ref: 'telemetry.openObserveAdmin'});
    await writeFile(catalogPath, JSON.stringify(catalog), 'utf8');
    await assert.rejects(loadServiceCatalog(root), /CONFIG-SCHEMA/u);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test('bootstrap probe is an executable matching the BOM SHA-256', async () => {
  const toolchain = JSON.parse(await readFile(`${REPO_ROOT}/config/toolchain-versions.json`, 'utf8'));
  const result = await verifyBootstrapProbe({expectedSha256: toolchain.bootstrapProbeSha256});
  assert.equal(result.sha256, toolchain.bootstrapProbeSha256);
  await assert.rejects(verifyBootstrapProbe({expectedSha256: '0'.repeat(64)}), /differs from the BOM pin/u);
});

void test('observability health probe uses the configured health timeout', async () => {
  const requests = [];
  const timeouts = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (timeout) => {
    timeouts.push(timeout);
    return new AbortController().signal;
  };
  let result;
  try {
    result = await checkObservabilityHealth({
      config: sample,
      fetchImpl: async (url, options) => {
        requests.push({url: url.href, signal: options.signal});
        return {ok: true, status: 200};
      },
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }
  assert.deepEqual(result.map(({name, status}) => ({name, status})), [
    {name: 'otel-collector', status: 200},
    {name: 'openobserve', status: 200},
  ]);
  assert.deepEqual(timeouts, [sample.platform.health.timeoutMs, sample.platform.health.timeoutMs]);
  assert.ok(requests.every(({signal}) => signal instanceof AbortSignal));
  assert.deepEqual(requests.map(({url}) => url), [
    'http://otel-collector:13133/',
    'http://openobserve:5080/healthz',
  ]);
});

void test('generated provenance records pinned sources and limits without secret values', async () => {
  const provenance = await createObservabilityProvenance({
    root: REPO_ROOT,
    config: sample,
    imageRefs: {
      otelCollectorImage: 'otel-collector@sha256:' + 'a'.repeat(64),
      openObserveImage: 'openobserve@sha256:' + 'b'.repeat(64),
      bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14',
    },
    logFiles: logs,
    openObserveDataVolume: 'coffee-test-openobserve-data',
    collectorConfigSha256: 'c'.repeat(64),
  });
  assert.equal(provenance.sourceSha256.imageBom.length, 64);
  assert.equal(provenance.sourceSha256.lockfile.length, 64);
  assert.equal(provenance.limits.collector.queueCapacity, 512);
  assert.equal(provenance.limits.openObserve.retentionDays, 3);
  assert.deepEqual({
    memTableMaxSizeMiB: provenance.limits.openObserve.memTableMaxSizeMiB,
    maxFileSizeInMemoryMiB: provenance.limits.openObserve.maxFileSizeInMemoryMiB,
    maxFileSizeOnDiskMiB: provenance.limits.openObserve.maxFileSizeOnDiskMiB,
    maxFileRetentionSeconds: provenance.limits.openObserve.maxFileRetentionSeconds,
    memPersistIntervalSeconds: provenance.limits.openObserve.memPersistIntervalSeconds,
  }, {
    memTableMaxSizeMiB: 128, maxFileSizeInMemoryMiB: 8, maxFileSizeOnDiskMiB: 8,
    maxFileRetentionSeconds: 30, memPersistIntervalSeconds: 2,
  });
  assert.deepEqual(
    [provenance.limits.openObserve.telemetryEnabled, provenance.limits.openObserve.mmdbDownloadEnabled, provenance.limits.openObserve.modelPricingEnabled],
    [false, false, false],
  );
  assert.equal(provenance.selectedLogs[0].containerId, logs[0].containerId);
  assert.doesNotMatch(JSON.stringify(provenance), /producer-token|o2oi-token|openObserveAdmin/u);
});

void test('Collector config ownership is changed only by pinned Node with CAP_CHOWN and retains mode 0400', () => {
  const calls = [];
  const proof = ensureCollectorConfigOwnership({
    collectorConfigPath: '/dev/shm/coffee-observability/collector.yaml',
    nodeImage: 'node@sha256:' + 'd'.repeat(64),
    runDocker: (args, timeout) => {
      calls.push({args, timeout});
      return '{"uid":0,"gid":0,"mode":"0400"}';
    },
  });
  assert.deepEqual(proof, {path: '/dev/shm/coffee-observability/collector.yaml', uid: 0, gid: 0, mode: '0400', verified: true});
  assert.equal(calls[0].timeout, 10000);
  assert.ok(calls[0].args.includes('--network') && calls[0].args.includes('none'));
  assert.ok(calls[0].args.includes('--cap-drop') && calls[0].args.includes('--cap-add') && calls[0].args.includes('CHOWN'));
  assert.ok(calls[0].args.some((arg) => arg.includes('type=bind,source=/dev/shm/coffee-observability/collector.yaml,target=/collector.yaml')));
  assert.ok(calls[0].args.at(-1).includes('fs.chownSync(p,0,0)'));
  assert.ok(calls[0].args.at(-1).includes('after.uid!==0'));
  assert.throws(() => ensureCollectorConfigOwnership({collectorConfigPath: '/dev/shm/config', nodeImage: 'node:latest', runDocker: () => ''}), /nodeImage BOM digest/u);
});

void test('runtime logging override is bounded and can be emitted before container discovery', async () => {
  const outputDir = await mkdtemp('/dev/shm/coffee-runtime-logging-');
  try {
    const {path} = await generateRuntimeLoggingOverride({root: REPO_ROOT, outputDir, config: sample});
    const contents = await readFile(path, 'utf8');
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o777, 0o400);
    assert.match(contents, /mode: non-blocking/u);
    assert.match(contents, /max-buffer-size: ['"]4194304['"]/u);
    assert.match(contents, /edge-gateway:/u);
    assert.match(contents, /kafka:/u);
  } finally {
    await rm(outputDir, {recursive: true, force: true});
  }
});

void test('OpenObserve seed keeps admin secret file-scoped, networkless, health-bounded, and removes the seed container', async () => {
  const directory = await mkdtemp('/dev/shm/coffee-openobserve-seed-');
  const secretPath = `${directory}/admin-secret`;
  await writeFile(secretPath, 'test-only-admin-secret\n', {mode: 0o400});
  const commands = [];
  try {
    const result = await initializeOpenObserve({
      config: sample,
      imageRefs: {
        openObserveImage: 'openobserve@sha256:' + 'a'.repeat(64),
        nodeImage: 'node@sha256:' + 'b'.repeat(64),
        bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14',
      },
      openObserveDataVolume: 'coffee-test-openobserve-data',
      adminSecretPath: secretPath,
      cpuFlags: new Set(['avx', 'aes']),
      wait: async () => {},
      runDocker: (args) => {
        commands.push(args);
        if (args[0] === 'run' && args.includes('--detach')) return 'seed-container-id';
        if (args[0] === 'inspect') return 'true';
        return '';
      },
    });
    assert.equal(result.initialized, true);
    const seed = commands.find((args) => args[0] === 'run' && args.includes('--detach'));
    assert.ok(seed.includes('--network') && seed.includes('none'));
    assert.ok(seed.includes('--env') && seed.includes('ZO_TELEMETRY=false'));
    assert.ok(seed.includes('ZO_MMDB_DISABLE_DOWNLOAD=true'));
    assert.ok(seed.includes('ZO_MODEL_PRICING_ENABLED=false'));
    assert.ok(seed.includes('export ZO_ROOT_USER_PASSWORD="$(/busybox cat /admin-secret)"; exec /openobserve'));
    assert.ok(seed.some((arg) => arg.includes('source=' + secretPath) && arg.includes('target=/admin-secret,readonly')));
    assert.equal(seed.includes('test-only-admin-secret'), false);
    assert.ok(commands.some((args) => args[0] === 'exec' && args.includes('http://127.0.0.1:5080/healthz')));
    const validation = commands.find((args) => args[0] === 'run' && args.includes('node') && args.at(-1)?.includes('/api/organizations'));
    assert.ok(validation.includes(`container:${seed[seed.indexOf('--name') + 1]}`));
    assert.ok(validation.at(-1).includes('/api/organizations'));
    assert.ok(validation.at(-1).includes('/data/.coffee-initialized-v1'));
    assert.ok(validation.at(-1).indexOf('if(response.status!==200)') < validation.at(-1).indexOf('writeFileSync("/data/.coffee-initialized-v1"'));
    assert.equal(validation.some((arg) => arg === 'test-only-admin-secret'), false);
    assert.ok(commands.some((args) => args[0] === 'rm' && args.includes('--force')));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('OpenObserve seed failure reports bounded container state and redacted stdout/stderr diagnostics', async () => {
  const directory = await mkdtemp('/dev/shm/coffee-openobserve-seed-failure-');
  const secretPath = `${directory}/admin-secret`;
  const adminSecret = 'admin-canary-secret-84';
  await writeFile(secretPath, `${adminSecret}\n`, {mode: 0o400});
  const commands = [];
  try {
    await assert.rejects(initializeOpenObserve({
      config: sample,
      imageRefs: {
        openObserveImage: 'openobserve@sha256:' + 'a'.repeat(64),
        nodeImage: 'node@sha256:' + 'b'.repeat(64),
        bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14',
      },
      openObserveDataVolume: 'coffee-test-openobserve-data',
      adminSecretPath: secretPath,
      cpuFlags: new Set(['avx', 'aes']),
      runDocker: (args) => {
        commands.push(args);
        if (args[0] === 'run' && args.includes('--detach')) return 'seed-container-id';
        if (args[0] === 'inspect' && args[1] === '--format={{.State.Running}}') return 'false';
        if (args[0] === 'inspect') return JSON.stringify({Running: false, ExitCode: 132, OOMKilled: false, Error: '', StartedAt: 'started', FinishedAt: 'finished'});
        if (args[0] === 'logs') return `stdout ERROR bootstrap failed\nstderr WARN password=${adminSecret}\nstderr panic token=o2oi-canary\nINFO startup complete`;
        return '';
      },
    }), (error) => {
      assert.match(error.message, /ExitCode":132/u);
      assert.match(error.message, /OOMKilled":false/u);
      assert.match(error.message, /StartedAt":"started"/u);
      assert.match(error.message, /FinishedAt":"finished"/u);
      assert.match(error.message, /stdout\+stderr/u);
      assert.match(error.message, /stdout ERROR bootstrap failed/u);
      assert.match(error.message, /stderr WARN password=\[REDACTED\]/u);
      assert.match(error.message, /stderr panic token=\[REDACTED\]/u);
      assert.doesNotMatch(error.message, new RegExp(adminSecret, 'u'));
      assert.doesNotMatch(error.message, /o2oi-canary/u);
      assert.deepEqual(error.containerDiagnostics[0], {
        name: commands.find((args) => args[0] === 'run' && args.includes('--detach'))[commands.find((args) => args[0] === 'run' && args.includes('--detach')).indexOf('--name') + 1],
        stage: 'seed',
        state: {Running: false, ExitCode: 132, OOMKilled: false, Error: '', StartedAt: 'started', FinishedAt: 'finished'},
        errorOrWarningLines: ['stdout ERROR bootstrap failed', 'stderr WARN password=[REDACTED]', 'stderr panic token=[REDACTED]'],
      });
      return true;
    });
    assert.ok(commands.some((args) => args[0] === 'rm' && args.includes('--force')));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('OpenObserve seed permits explicit executable QEMU only for the isolated test path', async () => {
  const directory = await mkdtemp('/dev/shm/coffee-openobserve-qemu-');
  const secretPath = `${directory}/admin-secret`;
  const emulatorPath = `${directory}/qemu-x86_64`;
  await writeFile(secretPath, 'test-only-admin-secret\n', {mode: 0o400});
  await writeFile(emulatorPath, '#!/bin/sh\nprintf "qemu-x86_64 version 7.2.0 (test)\\n"\n', {mode: 0o700});
  const commands = [];
  try {
    await initializeOpenObserve({
      config: sample,
      imageRefs: {
        openObserveImage: 'openobserve@sha256:' + 'a'.repeat(64),
        nodeImage: 'node@sha256:' + 'b'.repeat(64),
        bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14',
      },
      openObserveDataVolume: 'coffee-test-openobserve-data',
      adminSecretPath: secretPath,
      emulatorPath,
      cpuFlags: new Set(),
      wait: async () => {},
      runDocker: args => {
        commands.push(args);
        if (args[0] === 'run' && args.includes('--detach')) return 'seed-container-id';
        if (args[0] === 'inspect') return 'true';
        return '';
      },
    });
    const seed = commands.find(args => args[0] === 'run' && args.includes('--detach'));
    assert.ok(seed.includes(`type=bind,source=${emulatorPath},target=/run/tools/qemu-x86_64,readonly`));
    assert.ok(seed.includes('export ZO_ROOT_USER_PASSWORD="$(/busybox cat /admin-secret)"; exec /run/tools/qemu-x86_64 -cpu max /openobserve'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('OpenObserve seed fails before Docker mutation when host CPU is unsupported', async () => {
  const directory = await mkdtemp('/dev/shm/coffee-openobserve-cpu-');
  const secretPath = `${directory}/admin-secret`;
  await writeFile(secretPath, 'test-only-admin-secret\n', {mode: 0o400});
  let dockerCalls = 0;
  try {
    await assert.rejects(initializeOpenObserve({
      config: sample,
      imageRefs: {openObserveImage: 'openobserve@sha256:' + 'a'.repeat(64), nodeImage: 'node@sha256:' + 'b'.repeat(64), bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14'},
      openObserveDataVolume: 'coffee-test-openobserve-data',
      adminSecretPath: secretPath,
      cpuFlags: new Set(),
      runDocker: () => { dockerCalls += 1; return ''; },
    }), /host CPU flag avx/u);
    assert.equal(dockerCalls, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('OpenObserve seed refuses the public runtime validation marker as the admin credential', async () => {
  const directory = await mkdtemp('/dev/shm/coffee-openobserve-marker-');
  const secretPath = `${directory}/admin-secret`;
  await writeFile(secretPath, `${sample.telemetry.openObserve.validationMarker}\n`, {mode: 0o400});
  let dockerCalls = 0;
  try {
    await assert.rejects(initializeOpenObserve({
      config: sample,
      imageRefs: {openObserveImage: 'openobserve@sha256:' + 'a'.repeat(64), nodeImage: 'node@sha256:' + 'b'.repeat(64), bootstrapProbeSha256: 'dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14'},
      openObserveDataVolume: 'coffee-test-openobserve-data',
      adminSecretPath: secretPath,
      emulatorPath: '/bin/true',
      cpuFlags: new Set(['avx', 'aes']),
      runDocker: () => { dockerCalls += 1; return ''; },
    }), /distinct from the runtime validation marker/u);
    assert.equal(dockerCalls, 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

void test('Collector config accepts only exact selected log files and bounds export', () => {
  const config = createCollectorConfig({config: sample, logFiles: logs, exporterToken: 'producer-token', openObserveIngestToken: 'o2oi-token'});
  assert.deepEqual(config.receivers.filelog.include, [
    `/var/lib/docker/containers/${'a'.repeat(64)}/${'a'.repeat(64)}-json.log`,
    `/var/lib/docker/containers/${'b'.repeat(64)}/${'b'.repeat(64)}-json.log`,
  ]);
  assert.equal(config.receivers.filelog.include_file_path, true);
  assert.equal(config.receivers.filelog.max_log_size, 65536);
  assert.deepEqual(config.receivers.filelog.operators, [
    {type: 'add', id: 'owner-edge-nginx', field: 'resource["service.name"]', value: 'edge-nginx', if: `attributes["log.file.path"] == ${JSON.stringify(logs[0].logPath)}`, on_error: 'drop_quiet'},
    {type: 'add', id: 'owner-orders-service', field: 'resource["service.name"]', value: 'orders-service', if: `attributes["log.file.path"] == "/var/lib/docker/containers/${'b'.repeat(64)}/${'b'.repeat(64)}-json.log"`, on_error: 'drop_quiet'},
    {
      type: 'json_parser', id: 'docker_json', parse_from: 'body', parse_to: 'attributes', on_error: 'drop_quiet',
      timestamp: {parse_from: 'attributes.time', layout_type: 'gotime', layout: '2006-01-02T15:04:05.999999999Z07:00'},
    },
    {type: 'move', from: 'attributes.log', to: 'body', on_error: 'drop_quiet'},
    {type: 'filter', id: 'structured_json_only', expr: 'not (body matches "^[[:space:]]*[{]")'},
    {type: 'json_parser', id: 'application_json', parse_from: 'body', parse_to: 'body', on_error: 'drop_quiet'},
    {type: 'time_parser', id: 'producer_time', if: 'body.time != nil', parse_from: 'body.time', layout_type: 'epoch', layout: 'ms', on_error: 'drop_quiet'},
  ]);
  assert.ok(config.receivers.filelog.operators.some(({type, id, expr}) => type === 'filter' && id === 'structured_json_only' && expr === 'not (body matches "^[[:space:]]*[{]")'));
  assert.deepEqual(config.service.pipelines.logs.receivers, ['filelog']);
  assert.deepEqual(config.service.pipelines.logs.processors, ['memory_limiter', 'transform/records', 'batch']);
  assert.equal(config.processors['transform/records'].log_statements[0].statements[0], 'flatten(log.body, resolveConflicts=true) where IsMap(log.body)');
  assert.match(config.processors['transform/records'].log_statements[0].statements[1], /^delete_matching_keys\(log\.body, .+\) where IsMap\(log\.body\)$/u);
  assert.match(config.processors['transform/records'].log_statements[0].statements[2], /^delete_matching_keys\(log\.attributes, .+\)$/u);
  assert.equal(config.processors['transform/records'].log_statements[0].statements.some(statement => statement.includes('resource.attributes["service.name"]')), false);
  assert.deepEqual(config.service.pipelines.metrics.processors, ['memory_limiter', 'transform/metric_names', 'batch']);
  assert.deepEqual(config.receivers.nginx, {endpoint: sample.telemetry.nginxStatusEndpoint, collection_interval: '5000ms'});
  assert.deepEqual(config.receivers['prometheus/collector'].config.scrape_configs, [{
    job_name: 'otel-collector', scrape_interval: '5000ms', static_configs: [{targets: ['127.0.0.1:8888']}],
  }]);
  assert.deepEqual(config.service.pipelines['metrics/nginx'].receivers, ['nginx']);
  assert.deepEqual(config.service.pipelines['metrics/collector'].receivers, ['prometheus/collector']);
  assert.deepEqual(config.processors['transform/nginx_resource'].metric_statements[0].statements,
    ['set(resource.attributes["service.name"], "edge-nginx")', 'set(resource.attributes["service.namespace"], "coffee-platform")', 'set(resource.attributes["service.version"], "development")', 'set(resource.attributes["deployment.environment"], "development")']);
  assert.deepEqual(config.processors['transform/collector_resource'].metric_statements[0].statements,
    ['set(resource.attributes["service.name"], "otel-collector")', 'set(resource.attributes["service.namespace"], "coffee-platform")', 'set(resource.attributes["service.version"], "development")', 'set(resource.attributes["deployment.environment"], "development")']);
  assert.deepEqual(config.receivers['http_check/collector'], {
    collection_interval: '5000ms', targets: [{endpoint: 'http://otel-collector:13133/', method: 'GET', timeout: '1000ms'}],
  });
  assert.deepEqual(config.receivers['http_check/openobserve'], {
    collection_interval: '5000ms', targets: [{endpoint: 'http://openobserve:5080/healthz', method: 'GET', timeout: '1000ms'}],
  });
  for (const service of ['collector', 'openobserve']) {
    assert.deepEqual(config.service.pipelines[`metrics/health_${service}`].receivers, [`http_check/${service}`]);
    assert.deepEqual(config.service.pipelines[`metrics/health_${service}`].processors,
      ['memory_limiter', `transform/health_${service}_resource`, 'transform/metric_names', 'batch']);
  }
  assert.deepEqual(config.processors['transform/health_openobserve_resource'].metric_statements[0].statements,
    ['set(resource.attributes["service.name"], "openobserve")', 'set(resource.attributes["service.namespace"], "coffee-platform")', 'set(resource.attributes["service.version"], "development")', 'set(resource.attributes["deployment.environment"], "development")']);
  const minimalConfig = createCollectorConfig({
    config: sample,
    logFiles: [{service: 'edge-gateway', containerId: 'b'.repeat(64), logPath: `/var/lib/docker/containers/${'b'.repeat(64)}/${'b'.repeat(64)}-json.log`}],
    exporterToken: 'producer-token',
    openObserveIngestToken: 'o2oi-token',
  });
  assert.equal(minimalConfig.receivers.nginx, undefined);
  assert.equal(minimalConfig.processors['transform/nginx_resource'], undefined);
  assert.equal(minimalConfig.service.pipelines['metrics/nginx'], undefined);
  assert.deepEqual(minimalConfig.service.pipelines['metrics/collector'].receivers, ['prometheus/collector']);
  assert.equal(config.exporters['otlp_http/metrics'].headers['stream-name'], undefined);
  assert.deepEqual(config.processors['transform/metric_names'].metric_statements[0].statements,
    ['set(metric.name, Concat(["platform_metrics", metric.name], "_"))']);
  assert.equal(config.service.pipelines.traces.receivers[0], 'otlp');
  assert.equal(config.processors.memory_limiter.limit_mib, 128);
  assert.deepEqual(config.service.telemetry.metrics.readers[0].pull.exporter.prometheus, {host: '0.0.0.0', port: 8888});
  assert.equal(config.exporters['otlp_http/logs'].sending_queue.queue_size, 512);
  assert.equal(config.exporters['otlp_http/logs'].retry_on_failure.max_elapsed_time, '15000ms');
  assert.equal(config.exporters['otlp_http/logs'].headers.Authorization, `Basic ${Buffer.from('coffee:o2oi-token').toString('base64')}`);
  const compose = createComposeOverride({
    config: sample,
    imageRefs: {otelCollectorImage: 'otel-collector@sha256:' + 'a'.repeat(64), openObserveImage: 'openobserve@sha256:' + 'b'.repeat(64), bootstrapProbeSha256: 'c'.repeat(64)},
    logFiles: logs,
    collectorConfigPath: '/dev/shm/collector.yaml',
    openObserveDataVolume: 'coffee-test-openobserve-data',
  });
  assert.ok(compose.services['otel-collector'].networks.includes('coffee_edge_backend'),
    'Collector stays in the existing edge trust zone used by edge-nginx');
  const bufferEnvironment = {
    ZO_MEM_TABLE_MAX_SIZE: '128', ZO_MAX_FILE_SIZE_IN_MEMORY: '8', ZO_MAX_FILE_SIZE_ON_DISK: '8',
    ZO_MAX_FILE_RETENTION_TIME: '30', ZO_MEM_PERSIST_INTERVAL: '2',
  };
  assert.deepEqual(openObserveBufferEnvironment(sample.telemetry.openObserve), bufferEnvironment);
  assert.deepEqual(Object.fromEntries(Object.keys(bufferEnvironment).map(name => [name, compose.services.openobserve.environment[name]])), bufferEnvironment);
  const redaction = config.processors['transform/records'].log_statements[0].statements[1].match(/delete_matching_keys\(log\.body, "(.*)"\)/u)?.[1];
  const redactionKey = new RegExp(redaction.slice(4), 'iu');
  assert.equal(redactionKey.test('password'), true);
  assert.equal(redactionKey.test('client_ip'), true);
  assert.equal(redactionKey.test('description'), false);
  assert.equal(redactionKey.test('security'), false);
  assert.throws(() => createCollectorConfig({config: sample, logFiles: [{...logs[0], logPath: '/tmp/all-containers/*.log'}], exporterToken: 'x', openObserveIngestToken: 'y'}), /exact Docker json-file paths/u);
});

void test('Collector queue verification handles sparse streams without accepting missing required counters', async () => {
  const names = [
    'otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity',
    'otelcol_exporter_enqueue_failed_log_records', 'otelcol_exporter_enqueue_failed_metric_points', 'otelcol_exporter_enqueue_failed_spans',
    'otelcol_exporter_send_failed_log_records', 'otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_send_failed_spans',
    'otelcol_exporter_sent_log_records', 'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_spans',
  ];
  const availableStreams = names.filter(name => name !== 'otelcol_exporter_sent_spans').map(name => `platform_metrics_${name}`);
  let searchCount = 0;
  const fetchImpl = async url => {
    if (url.pathname === '/api/coffee/streams')
      return new Response(JSON.stringify({data: availableStreams.map(name => ({stream_type: 'metrics', name}))}), {status: 200});
    searchCount += 1;
    return new Response(JSON.stringify({hits: {hits: []}}), {status: 200});
  };
  let timeoutError;
  await assert.rejects(verifyCollectorQueueMetrics({
    baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
    metricsPrefix: 'platform_metrics', startTimeUs: 1000, lossStartTimeUs: 500, lossEndTimeUs: 1000,
    queueCapacity: 512, fetchImpl, timeoutMs: 1000, intervalMs: 20,
  }), error => {
    timeoutError = error;
    return /Collector self-scrape queue, send-failure, and recovery counters did not complete/u.test(error.message);
  });
  const diagnosticJson = timeoutError.message.match(/; last bounded observation=(\{.*\})$/u)?.[1];
  assert.ok(diagnosticJson, 'timeout reports a bounded last observation instead of hiding the missing metric');
  const diagnostics = JSON.parse(diagnosticJson);
  assert.deepEqual(diagnostics.missingFreshRequiredMetrics, [
    'otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity', 'otelcol_exporter_sent_log_records',
    'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_spans',
  ]);
  assert.equal(diagnostics.metrics.otelcol_exporter_sent_spans.available, false);
  assert.equal(diagnostics.metrics.otelcol_exporter_send_failed_log_records.sampleCount, 0,
    'sparse optional failure streams remain valid empty observations');
  assert.deepEqual(diagnostics.positiveOutageLossMetrics, []);
  assert.ok(searchCount > 0, 'available streams were queried while the absent required counter remained pending');

  const recoveryStartUs = 1_000_000_000_000_000;
  const failureTimestampUs = 700_000_000_000_000;
  const optionalFailureStreams = [
    'otelcol_exporter_enqueue_failed_log_records', 'otelcol_exporter_enqueue_failed_metric_points', 'otelcol_exporter_enqueue_failed_spans',
    'otelcol_exporter_send_failed_log_records', 'otelcol_exporter_send_failed_spans',
  ];
  const recoveryMetrics = new Map([
    ['otelcol_exporter_queue_size', [{_timestamp: recoveryStartUs + 1, value: 0, service_name: 'otel-collector'}]],
    ['otelcol_exporter_queue_capacity', [{_timestamp: recoveryStartUs + 1, value: 512, service_name: 'otel-collector'}]],
    ['otelcol_exporter_send_failed_metric_points', [{_timestamp: failureTimestampUs, value: 3, service_name: 'otel-collector'}]],
    ...['log_records', 'metric_points', 'spans'].map(signal => [
      `otelcol_exporter_sent_${signal}`,
      [{_timestamp: recoveryStartUs + 1, value: 1, service_name: 'otel-collector'}],
    ]),
  ]);
  const recoveryStreams = [...recoveryMetrics.keys()].map(name => `platform_metrics_${name}`);
  const recoveryFetch = async (url, init) => {
    if (url.pathname === '/api/coffee/streams')
      return new Response(JSON.stringify({data: recoveryStreams.map(name => ({stream_type: 'metrics', name}))}), {status: 200});
    const stream = url.searchParams.get('type') === 'metrics' &&
      JSON.parse(init.body).query.sql.match(/FROM "([^"]+)"/u)?.[1];
    const records = recoveryMetrics.get(stream?.replace('platform_metrics_', '')) ?? [];
    return new Response(JSON.stringify({hits: {hits: records}}), {status: 200});
  };
  const recovered = await verifyCollectorQueueMetrics({
    baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
    metricsPrefix: 'platform_metrics', startTimeUs: recoveryStartUs, lossStartTimeUs: failureTimestampUs - 1,
    lossEndTimeUs: recoveryStartUs, queueCapacity: 512, fetchImpl: recoveryFetch, timeoutMs: 5000, intervalMs: 1,
  });
  assert.equal(recovered.status, 'PASS');
  assert.equal(recovered.sendFailureSamples.metric_points.values[0], 3);
  assert.deepEqual(recovered.optionalMetricStreamsAbsent.sort(), optionalFailureStreams.sort());
});

void test('log discovery selects exactly one running container by project and runtime labels', async () => {
  const id = 'b'.repeat(64);
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args[0] === 'ps') return `${id}\n`;
    return JSON.stringify([{
      Id: id,
      LogPath: `/var/lib/docker/containers/${id}/${id}-json.log`,
      State: {Running: true},
      Config: {Labels: {'com.docker.compose.project': 'coffee-proof', 'com.docker.compose.service': 'edge-gateway'}},
    }]);
  };
  const found = await discoverContainerLogs({projectName: 'coffee-proof', runtimes: ['edge-gateway'], runDocker});
  assert.deepEqual(found, [{service: 'edge-gateway', containerId: id, logPath: `/var/lib/docker/containers/${id}/${id}-json.log`}]);
  assert.ok(calls[0].includes('label=com.docker.compose.project=coffee-proof'));
  assert.ok(calls[0].includes('label=com.docker.compose.service=edge-gateway'));
  assert.ok(calls[0].includes('--no-trunc'));
  await assert.rejects(discoverContainerLogs({projectName: 'coffee-proof', runtimes: ['edge-gateway'], runDocker: () => `${id}\n${id}\n`}), /exactly one running container/u);
  await assert.rejects(discoverContainerLogs({projectName: 'coffee-proof', runtimes: ['edge-gateway'], runDocker: (args) => args[0] === 'ps' ? `${id}\n` : JSON.stringify([{Id: id, LogPath: '/tmp/not-json.log', State: {Running: true}, Config: {Labels: {'com.docker.compose.project': 'other', 'com.docker.compose.service': 'edge-gateway'}}}])}), /identity does not match/u);
});

void test('collector/admin refs remain optional in the shared encrypted-secret inventory until provisioned', async () => {
  const schema = JSON.parse(await readFile(`${REPO_ROOT}/secrets/platform-secrets.schema.json`, 'utf8'));
  const telemetry = schema.$defs.environment.properties.telemetry;
  assert.equal(telemetry.required.includes('openObserveIngestToken'), false);
  assert.equal(telemetry.required.includes('openObserveAdmin'), false);
  assert.equal(telemetry.properties.openObserveIngestToken.$ref, '#/$defs/encrypted');
  assert.equal(telemetry.properties.openObserveAdmin.$ref, '#/$defs/encrypted');
});

void test('unprovisioned collector and admin credentials fail closed without writing scoped files', async () => {
  const fixtureRoot = await mkdtemp('/dev/shm/coffee-observability-config-');
  const collectorDir = await mkdtemp('/dev/shm/coffee-observability-bootstrap-');
  const adminDir = await mkdtemp('/dev/shm/coffee-openobserve-admin-');
  try {
    for (const path of ['config', 'platform']) await cp(`${REPO_ROOT}/${path}`, `${fixtureRoot}/${path}`, {recursive: true});
    await mkdir(`${fixtureRoot}/secrets`, {recursive: true});
    await cp(`${REPO_ROOT}/secrets/platform-secrets.schema.json`, `${fixtureRoot}/secrets/platform-secrets.schema.json`);
    await cp(`${REPO_ROOT}/.sops.yaml`, `${fixtureRoot}/.sops.yaml`);
    await writeFile(`${fixtureRoot}/secrets/platform.secrets.sops.yaml`, JSON.stringify(syntheticEncryptedSecrets()), 'utf8');

    await assert.rejects(materializeCollectorSecrets({root: fixtureRoot, outputDir: collectorDir, env: {}}), /CONFIG-SECRET-REF.*openObserveIngestToken/u);
    await assert.rejects(materializeOpenObserveAdminSecret({root: fixtureRoot, outputDir: adminDir, env: {}}), /CONFIG-SECRET-REF.*openObserveAdmin/u);
    assert.deepEqual(await readdir(collectorDir), []);
    assert.deepEqual(await readdir(adminDir), []);
  } finally {
    await rm(fixtureRoot, {recursive: true, force: true});
    await rm(collectorDir, {recursive: true, force: true});
    await rm(adminDir, {recursive: true, force: true});
  }
});

function syntheticEncryptedSecrets() {
  const encrypted = 'ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]';
  const recipients = [
    'age19nj28zyvv2epe64gfexkzasguc2dh596dj5z5fvrlu58lsp2sqxqzk93wh',
    'age1cehh5tuxnuqq2sq8ekz2tzym8fmn9gdepngud6dakt7nnvfd63qsajm2cr',
    'age1aqtw0rf374l6kys2y34jfqfc0sfd3z8dzrfkc4cy92ktxjkvfsgq0u6y4f',
  ];
  const schema = JSON.parse(readFileSync(`${REPO_ROOT}/secrets/platform-secrets.schema.json`, 'utf8'));
  const build = (definition) => {
    if (definition.$ref) return build(definition.$ref.split('/').slice(1).reduce((value, part) => value[part.replaceAll('~1', '/').replaceAll('~0', '~')], schema));
    if (definition.const !== undefined) return definition.const;
    if (definition.enum) return definition.enum[0];
    if (definition.type === 'string') return encrypted;
    if (definition.type === 'integer') return definition.minimum ?? 1;
    if (definition.type === 'array') return (definition.minItems ? Array.from({length: definition.minItems}, () => build(definition.items)) : []);
    if (definition.type === 'object') return Object.fromEntries((definition.required ?? []).map((key) => [key, build(definition.properties[key])]));
    return {};
  };
  const result = build(schema);
  result.sops.age = recipients.map((recipient) => ({recipient, enc: '-----BEGIN AGE ENCRYPTED FILE-----\nfixture\n-----END AGE ENCRYPTED FILE-----'}));
  result.sops.lastmodified = '2026-10-14T00:00:00Z';
  result.sops.version = '3.13.3';
  result.sops.unencrypted_regex = '^(schemaVersion|username)$';
  return result;
}
