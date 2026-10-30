import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat, readFile, writeFile, chmod} from 'node:fs/promises';
import {lstatSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dump as dumpYaml} from 'js-yaml';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';
import {ensurePrivateSecretDirectory, writePrivateSecret} from '../config-bootstrap/index.mjs';
import {loadVerifiedGateImage} from '../verified-infrastructure-image.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const OBSERVABILITY_TARGETS = [
  'edge-nginx', 'edge-gateway', 'api-public', 'api-internal', 'customer-service',
  'catalog-service', 'catalog-supplier-sync', 'catalog-activation-worker',
  'pricing-service', 'orders-service', 'orders-aroma-preparation', 'aroma-observer',
  'aroma-convergence', 'aroma-gateway', 'realtime-gateway',
];
const TELEMETRY_NETWORKS = [
  'coffee_observability', 'coffee_edge_backend', 'coffee_public_api_backend',
  'coffee_internal_api', 'coffee_kafka_event',
];
const LOGGED_SERVICES = [...OBSERVABILITY_TARGETS, 'kafka'];

export function prometheusMetricName(name) {
  const normalized = name.replace(/[^a-zA-Z0-9_]/gu, '_');
  const units = {runtime_http_request_duration_ms: '_milliseconds', messaging_kafka_consumer_lag: '_messages',
    messaging_outbox_oldest_unpublished_age: '_milliseconds', db_client_connection_checkout_wait: '_milliseconds',
    messaging_kafka_event_age: '_milliseconds', messaging_inbox_received_age: '_milliseconds'};
  return normalized + (units[normalized] ?? '');
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

export async function verifyBootstrapProbe({probePath = '/usr/bin/busybox', expectedSha256} = {}) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256 ?? '')) throw new Error('bootstrapProbeSha256 BOM ref is required');
  const info = await lstat(probePath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) throw new Error('bootstrap probe must be a regular executable file');
  const digest = createHash('sha256').update(await readFile(probePath)).digest('hex');
  if (digest !== expectedSha256) throw new Error('bootstrap probe SHA-256 differs from the BOM pin');
  return {path: resolve(probePath), sha256: digest};
}

function endpointPort(endpoint, name) {
  const port = Number(new URL(requireValue(endpoint, name)).port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must contain an explicit TCP port`);
  return port;
}

function docker(args, runDocker) {
  return runDocker(args);
}

export function ensureCollectorConfigOwnership({collectorConfigPath, nodeImage, runDocker = (args, timeout = 10000) => execFileSync('docker', args, {encoding: 'utf8', timeout})} = {}) {
  if (!/@sha256:[a-f0-9]{64}$/u.test(nodeImage ?? '')) throw new Error('nodeImage BOM digest is required for Collector config ownership');
  const helper = [
    'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16',
    '--mount', `type=bind,source=${resolve(requireValue(collectorConfigPath, 'collectorConfigPath'))},target=/collector.yaml`,
    nodeImage, 'node', '-e',
    'const fs=require("node:fs");const p="/collector.yaml";const before=fs.lstatSync(p);if(!before.isFile()||before.isSymbolicLink()||(before.mode&0o777)!==0o400)throw Error("collector config must be a regular mode 0400 file");fs.chownSync(p,0,0);const after=fs.lstatSync(p);if(after.uid!==0||after.gid!==0||!after.isFile()||(after.mode&0o777)!==0o400)throw Error("collector config ownership verification failed");process.stdout.write(JSON.stringify({uid:after.uid,gid:after.gid,mode:"0400"}));',
  ];
  const result = runDocker(helper, 10000);
  const proof = JSON.parse(String(result));
  if (proof.uid !== 0 || proof.gid !== 0 || proof.mode !== '0400') throw new Error('Collector config ownership helper returned an invalid proof');
  return {path: resolve(collectorConfigPath), ...proof, verified: true};
}

export function ensureBackendOwnership({storageVolumes, grafanaAdminSecretPath, nodeImage, runDocker = (args, timeout = 10000) => execFileSync('docker', args, {encoding: 'utf8', timeout})} = {}) {
  if (!/@sha256:[a-f0-9]{64}$/u.test(nodeImage ?? '')) throw new Error('nodeImage BOM digest is required for backend ownership');
  const owners = {grafana: 472, loki: 10001, prometheus: 65534, tempo: 10001};
  for (const name of Object.keys(owners)) {
    const volume = requireValue(storageVolumes?.[name], `${name} storage volume`);
    if (!/^coffee-[a-z0-9-]+$/u.test(volume)) throw new Error('invalid telemetry storage volume');
    const info = JSON.parse(runDocker(['volume', 'inspect', volume], 10000))[0];
    if (info?.Labels?.['coffee.owner'] !== 'operations' || !['persistent', 'fixture'].includes(info.Labels['coffee.lifecycle']) || info.Driver !== 'local' || info.Options?.type !== 'ext4' || info.Options?.o !== 'nodev,nosuid,noexec' || !/^\/dev\/loop[0-9]+$/u.test(info.Options?.device ?? '')) throw new Error('refusing to change ownership of unrelated telemetry volume');
  }
  const mounts = Object.keys(owners).flatMap(name => ['--mount', `type=volume,source=${storageVolumes[name]},target=/data/${name}`]);
  const args = ['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16', ...mounts,
    '--mount', `type=bind,source=${resolve(requireValue(grafanaAdminSecretPath, 'grafanaAdminSecretPath'))},target=/admin-secret`, nodeImage, 'node', '-e',
    `const fs=require('node:fs');const owners=${JSON.stringify(owners)};for(const [name,uid] of Object.entries(owners)){const p='/data/'+name;fs.chownSync(p,uid,uid);if(fs.statSync(p).uid!==uid)throw Error('volume ownership failed')}const p='/admin-secret';const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&0o777)!==0o400)throw Error('admin secret must be regular mode 0400');fs.chownSync(p,472,472);if(fs.statSync(p).uid!==472)throw Error('secret ownership failed');`];
  runDocker(args, 10000);
  return {storageVolumes, grafanaAdminUid: 472};
}

function hasExactDockerLogPath({containerId, logPath}) {
  return /^[a-f0-9]{64}$/u.test(containerId ?? '') &&
    typeof logPath === 'string' && logPath.startsWith('/') &&
    dirname(logPath).endsWith(`/${containerId}`) && logPath.endsWith(`/${containerId}-json.log`);
}

export async function createObservabilityProvenance({root = REPO_ROOT, config, imageRefs, grafanaImage, alertSinkImage, logFiles, storageVolumes, collectorConfigSha256} = {}) {
  const sources = {
    platformConfig: 'config/platform.yaml',
    platformSchema: 'config/platform.schema.json',
    imageBom: 'config/toolchain-versions.json',
    lockfile: 'pnpm-lock.yaml',
    serviceCatalog: 'config/service-catalog.json',
    secretsSchema: 'secrets/platform-secrets.schema.json',
  };
  const sourceSha256 = Object.fromEntries(await Promise.all(Object.entries(sources).map(async ([name, path]) => [
    name,
    createHash('sha256').update(await readFile(join(root, path))).digest('hex'),
  ])));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceSha256,
    images: {otelCollector: imageRefs.otelCollectorImage, grafanaBase: imageRefs.grafanaImage, loki: imageRefs.lokiImage, prometheus: imageRefs.prometheusImage, tempo: imageRefs.tempoImage, nodeHelper: imageRefs.nodeImage},
    grafanaImage: {imageId: grafanaImage.imageId, receiptSha256: grafanaImage.receiptSha256, candidateSha: grafanaImage.candidateSha, runId: grafanaImage.runId},
    alertSinkImage: {imageId: alertSinkImage.imageId, receiptSha256: alertSinkImage.receiptSha256, candidateSha: alertSinkImage.candidateSha, runId: alertSinkImage.runId},
    bootstrapProbeSha256: imageRefs.bootstrapProbeSha256,
    storageVolumes,
    collectorConfigSha256,
    selectedLogs: logFiles.map(({service, containerId, logPath}) => ({service, containerId, logPath})),
    limits: {
      collector: {
        memoryLimitMiB: config.telemetry.collector.memoryLimitMiB,
        memorySpikeMiB: config.telemetry.collector.memorySpikeMiB,
        containerMemoryMiB: config.telemetry.collector.containerMemoryMiB,
        maxLogRecordBytes: config.telemetry.collector.maxLogRecordBytes,
        batchSize: config.telemetry.collector.batchSize,
        queueCapacity: config.telemetry.collector.queueCapacity,
        queueConsumers: config.telemetry.collector.queueConsumers,
        exportTimeoutMs: config.telemetry.collector.exportTimeoutMs,
        retryWindowMs: config.telemetry.collector.retryWindowMs,
      },
      producer: {
        queueCapacity: config.telemetry.producer.queueCapacity,
        maxRecordBytes: config.telemetry.producer.maxRecordBytes,
        batchSize: config.telemetry.producer.batchSize,
        batchIntervalMs: config.telemetry.producer.batchIntervalMs,
        exportTimeoutMs: config.telemetry.producer.exportTimeoutMs,
        diagnosticIntervalMs: config.telemetry.producer.diagnosticIntervalMs,
        flushTimeoutMs: config.telemetry.producer.flushTimeoutMs,
      },
      logging: {maxSizeMiB: config.telemetry.logging.maxSizeMiB, maxFiles: config.telemetry.logging.maxFiles},
      grafana: config.telemetry.grafana,
      loki: config.telemetry.loki,
      prometheus: config.telemetry.prometheus,
      tempo: config.telemetry.tempo,
      diskWatermarkPercent: config.telemetry.diskWatermarkPercent,
    },
  };
}

export async function discoverContainerLogs({projectName, runtimes = OBSERVABILITY_TARGETS, runDocker = (args) => execFileSync('docker', args, {encoding: 'utf8'})} = {}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(projectName ?? '')) throw new Error('projectName must be a lowercase Compose project name');
  const discovered = [];
  for (const service of runtimes) {
    const ids = docker([
      'ps', '--quiet', '--no-trunc', '--filter', 'status=running', '--filter', `label=com.docker.compose.project=${projectName}`,
      '--filter', `label=com.docker.compose.service=${service}`,
    ], runDocker).trim().split(/\s+/u).filter(Boolean);
    if (ids.length !== 1) throw new Error(`${service}: expected exactly one running container in Compose project ${projectName}`);
    const inspected = JSON.parse(docker(['inspect', ids[0]], runDocker))[0];
    if (inspected?.Id !== ids[0] || inspected?.State?.Running !== true ||
        inspected?.Config?.Labels?.['com.docker.compose.project'] !== projectName ||
        inspected?.Config?.Labels?.['com.docker.compose.service'] !== service) {
      throw new Error(`${service}: Docker inspect identity does not match the selected Compose container`);
    }
    const logPath = inspected.LogPath;
    if (!hasExactDockerLogPath({containerId: ids[0], logPath})) {
      throw new Error(`${service}: expected Docker json-file LogPath for the selected container`);
    }
    discovered.push({service, containerId: ids[0], logPath: resolve(logPath)});
  }
  return discovered;
}

export function createCollectorConfig({config, logFiles, exporterToken} = {}) {
  const collector = requireValue(config?.telemetry?.collector, 'telemetry.collector');
  const nginxStatusEndpoint = requireValue(config?.telemetry?.nginxStatusEndpoint, 'telemetry.nginxStatusEndpoint');
  if (!/^http:\/\/edge-nginx:[1-9][0-9]{0,4}\/nginx_status$/u.test(nginxStatusEndpoint) || Number(new URL(nginxStatusEndpoint).port) > 65535)
    throw new Error('telemetry.nginxStatusEndpoint must be the private edge-nginx stub_status endpoint');
  requireValue(exporterToken, 'telemetry.exporterToken');
  if (!Array.isArray(logFiles) || logFiles.length === 0 ||
      new Set(logFiles.map(({service}) => service)).size !== logFiles.length ||
      logFiles.some((entry) => !OBSERVABILITY_TARGETS.includes(entry.service) || !hasExactDockerLogPath(entry))) {
    throw new Error('logFiles must contain unique exact Docker json-file paths for selected runtimes');
  }
  const include = logFiles.map(({containerId}) => `/var/lib/docker/containers/${containerId}/${containerId}-json.log`);
  const includeNginxMetrics = logFiles.some(({service}) => service === 'edge-nginx');
  const sourceOwnerOperators = logFiles.map(({service, containerId}) => ({
    type: 'add',
    id: `owner-${service}`,
    field: 'resource["service.name"]',
    value: service,
    if: `attributes["log.file.path"] == "/var/lib/docker/containers/${containerId}/${containerId}-json.log"`,
    on_error: 'drop_quiet',
  }));
  const sensitiveKeys = '(?i).*(password|passwd|credential|api.?key|token|secret|authorization|cookie|session|private.?key|email|phone|actor|address|(?:client|remote|source|forwarded).?ip|(?:request|callback|target).?(uri|url)|payload|request.?body).*';
  const resourceStatements = (serviceName) => [
    `set(resource.attributes["service.name"], ${JSON.stringify(serviceName)})`,
    `set(resource.attributes["service.namespace"], ${JSON.stringify(config.telemetry.namespace)})`,
    `set(resource.attributes["service.version"], ${JSON.stringify(config.telemetry.releaseDigest)})`,
    `set(resource.attributes["deployment.environment"], ${JSON.stringify(config.environment)})`,
  ];
  const pipelines = {};
  for (const signal of ['logs', 'traces', 'metrics']) {
    pipelines[signal] = {
      receivers: signal === 'logs' ? ['filelog'] : ['otlp'],
      processors: ['memory_limiter', ...(signal === 'logs' ? ['transform/records'] : signal === 'metrics' ? ['transform/metric_names'] : []), 'batch'],
      exporters: [`otlp_http/${signal}`],
    };
  }
  for (const service of (includeNginxMetrics ? ['nginx'] : [])) {
    pipelines[`metrics/${service}`] = {
      receivers: ['nginx'],
      processors: ['memory_limiter', `transform/${service}_resource`, 'transform/metric_names', 'batch'],
      exporters: ['otlp_http/metrics'],
    };
  }
  return {
    extensions: {
      file_storage: {directory: '/var/lib/alloy/file_storage', fsync: true},
      'bearertokenauth/server': {scheme: 'Bearer', token: exporterToken},
    },
    receivers: {
      otlp: {
        protocols: {
          http: {
            endpoint: `0.0.0.0:${endpointPort(collector.otlpEndpoint, 'telemetry.collector.otlpEndpoint')}`,
            auth: {authenticator: 'bearertokenauth/server'},
          },
        },
      },
      filelog: {
        include,
        include_file_path: true,
        start_at: 'beginning',
        storage: 'file_storage',
        max_log_size: collector.maxLogRecordBytes,
        retry_on_failure: {
          enabled: true,
          initial_interval: `${collector.retryInitialMs}ms`,
          max_interval: `${collector.retryMaxMs}ms`,
          max_elapsed_time: `${collector.retryWindowMs}ms`,
        },
        operators: [
          ...sourceOwnerOperators,
          {
            type: 'json_parser',
            id: 'docker_json',
            parse_from: 'body',
            parse_to: 'attributes',
            on_error: 'drop_quiet',
            timestamp: {
              parse_from: 'attributes.time',
              layout_type: 'gotime',
              layout: '2006-01-02T15:04:05.999999999Z07:00',
            },
          },
          {type: 'move', from: 'attributes.log', to: 'body', on_error: 'drop_quiet'},
          {
            type: 'filter',
            id: 'structured_json_only',
            expr: 'not (body matches "^[[:space:]]*[{]")',
          },
          {
            type: 'json_parser',
            id: 'application_json',
            parse_from: 'body',
            parse_to: 'body',
            on_error: 'drop_quiet',
          },
          {
            type: 'time_parser',
            id: 'producer_time',
            if: 'body.time != nil',
            parse_from: 'body.time',
            layout_type: 'epoch',
            layout: 'ms',
            on_error: 'drop_quiet',
          },
        ],
      },
      ...(includeNginxMetrics ? {
        nginx: {
          endpoint: nginxStatusEndpoint,
          collection_interval: `${config.platform.health.intervalMs}ms`,
        },
      } : {}),
    },
    processors: {
      memory_limiter: {
        check_interval: `${collector.memoryCheckIntervalMs}ms`,
        limit_mib: collector.memoryLimitMiB,
        spike_limit_mib: collector.memorySpikeMiB,
      },
      batch: {
        send_batch_size: collector.batchSize,
        send_batch_max_size: collector.batchSize,
        timeout: `${collector.batchTimeoutMs}ms`,
      },
      'transform/records': {
        error_mode: 'propagate',
        log_statements: [{context: 'log', statements: [
          'flatten(log.body, resolveConflicts=true) where IsMap(log.body)',
          `delete_matching_keys(log.body, "${sensitiveKeys}") where IsMap(log.body)`,
          `delete_matching_keys(log.attributes, "${sensitiveKeys}")`,
          `set(resource.attributes["service.namespace"], ${JSON.stringify(config.telemetry.namespace)})`,
          `set(resource.attributes["service.version"], ${JSON.stringify(config.telemetry.releaseDigest)})`,
          `set(resource.attributes["deployment.environment"], ${JSON.stringify(config.environment)})`,
        ]}],
      },
      'transform/metric_names': {
        error_mode: 'propagate',
        metric_statements: [
          {context: 'datapoint', statements: [
            'delete_key(datapoint.attributes, "error.message")',
            'delete_key(datapoint.attributes, "http.url")',
          ]},
        ],
      },
      ...(includeNginxMetrics ? {
        'transform/nginx_resource': {
          error_mode: 'propagate',
          metric_statements: [{context: 'metric', statements: resourceStatements('edge-nginx')}],
        },
      } : {}),

    },
    exporters: Object.fromEntries(['logs', 'traces', 'metrics'].map((signal) => [
      `otlp_http/${signal}`,
      {
        endpoint: signal === 'logs' ? `${config.telemetry.loki.endpoint}/otlp` : signal === 'metrics' ? `${config.telemetry.prometheus.endpoint}/api/v1/otlp` : config.telemetry.tempo.otlpEndpoint,
        timeout: `${collector.exportTimeoutMs}ms`,
        sending_queue: {
          enabled: true,
          sizer: 'items',
          queue_size: collector.queueCapacity,
          block_on_overflow: false,
          wait_for_result: false,
          num_consumers: collector.queueConsumers,
        },
        retry_on_failure: {
          enabled: true,
          initial_interval: `${collector.retryInitialMs}ms`,
          max_interval: `${collector.retryMaxMs}ms`,
          max_elapsed_time: `${collector.retryWindowMs}ms`,
        },
      },
    ])),
    service: {
      extensions: ['file_storage', 'bearertokenauth/server'],
      pipelines,
    },
  };
}

function alloyValue(value) {
  if (Array.isArray(value)) return `[${value.map(alloyValue).join(', ')}${value.length ? ',' : ''}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${alloyValue(item)}`).join(', ')}${Object.keys(value).length ? ',' : ''}}`;
  return JSON.stringify(value);
}

export function createAlloyConfig({config, logFiles, exporterToken} = {}) {
  const ir = createCollectorConfig({config, logFiles, exporterToken});
  const filelog = ir.receivers.filelog;
  const collector = config.telemetry.collector;
  const value = alloyValue;
  const limit = `check_interval = ${value(`${collector.memoryCheckIntervalMs}ms`)}
  limit = ${value(`${collector.memoryLimitMiB}MiB`)}
  spike_limit = ${value(`${collector.memorySpikeMiB}MiB`)}`;
  const metricStatements = ir.processors['transform/metric_names'].metric_statements[0].statements;
  const recordStatements = ir.processors['transform/records'].log_statements[0].statements;
  const resourceStatements = name => [
    `set(resource.attributes["service.name"], ${JSON.stringify(name)})`,
    `set(resource.attributes["service.namespace"], ${JSON.stringify(config.telemetry.namespace)})`,
    `set(resource.attributes["service.version"], ${JSON.stringify(config.telemetry.releaseDigest)})`,
    `set(resource.attributes["deployment.environment"], ${JSON.stringify(config.environment)})`,
  ];
  const exporters = ['logs', 'metrics', 'traces'].map(signal => {
    const exporter = ir.exporters[`otlp_http/${signal}`];
    return `otelcol.exporter.otlphttp ${value(signal)} {
  client {
    endpoint = ${value(exporter.endpoint)}
    timeout = ${value(exporter.timeout)}
  }
  sending_queue {
    enabled = true
    num_consumers = ${collector.queueConsumers}
    queue_size = ${collector.queueCapacity}
    sizer = "items"
    block_on_overflow = false
    wait_for_result = false
  }
  retry_on_failure {
    enabled = true
    initial_interval = ${value(`${collector.retryInitialMs}ms`)}
    max_interval = ${value(`${collector.retryMaxMs}ms`)}
    max_elapsed_time = ${value(`${collector.retryWindowMs}ms`)}
  }
}`;
  }).join('\n\n');
  const nginx = logFiles.some(entry => entry.service === 'edge-nginx') ? `
otelcol.receiver.nginx "edge" {
  endpoint = ${value(config.telemetry.nginxStatusEndpoint)}
  collection_interval = ${value(`${config.platform.health.intervalMs}ms`)}
  output { metrics = [otelcol.processor.memory_limiter.nginx.input] }
}
otelcol.processor.memory_limiter "nginx" {
  ${limit}
  output { metrics = [otelcol.processor.transform.nginx_resource.input] }
}
otelcol.processor.transform "nginx_resource" {
  error_mode = "propagate"
  metric_statements {
    context = "metric"
    statements = ${value(resourceStatements('edge-nginx'))}
  }
  output { metrics = [otelcol.processor.transform.metrics.input] }
}
` : '';
  const rendered = `otelcol.storage.file "checkpoints" {
  directory = "/var/lib/alloy/file_storage"
  create_directory = true
  fsync = true
}
otelcol.auth.bearer "producer" { token = ${value(exporterToken)} }
otelcol.receiver.otlp "producer" {
  http {
    endpoint = ${value(`0.0.0.0:${endpointPort(collector.otlpEndpoint, 'telemetry.collector.otlpEndpoint')}`)}
    auth = otelcol.auth.bearer.producer.handler
  }
  output {
    metrics = [otelcol.processor.memory_limiter.main.input]
    traces = [otelcol.processor.memory_limiter.main.input]
  }
}
otelcol.receiver.filelog "runtime" {
  include = ${value(filelog.include)}
  include_file_path = true
  start_at = "beginning"
  max_log_size = ${value(`${filelog.max_log_size}B`)}
  operators = ${value(filelog.operators)}
  storage = otelcol.storage.file.checkpoints.handler
  retry_on_failure {
    enabled = true
    initial_interval = ${value(filelog.retry_on_failure.initial_interval)}
    max_interval = ${value(filelog.retry_on_failure.max_interval)}
    max_elapsed_time = ${value(filelog.retry_on_failure.max_elapsed_time)}
  }
  output { logs = [otelcol.processor.memory_limiter.main.input] }
}
otelcol.processor.memory_limiter "main" {
  ${limit}
  output {
    metrics = [otelcol.processor.transform.metrics.input]
    logs = [otelcol.processor.transform.logs.input]
    traces = [otelcol.processor.batch.main.input]
  }
}
otelcol.processor.transform "metrics" {
  error_mode = "propagate"
  metric_statements {
    context = "datapoint"
    statements = ${value(metricStatements)}
  }
  output { metrics = [otelcol.processor.batch.main.input] }
}
otelcol.processor.transform "logs" {
  error_mode = "propagate"
  log_statements {
    context = "log"
    statements = ${value(recordStatements)}
  }
  output { logs = [otelcol.processor.batch.main.input] }
}
otelcol.processor.batch "main" {
  timeout = ${value(`${collector.batchTimeoutMs}ms`)}
  send_batch_size = ${collector.batchSize}
  send_batch_max_size = ${collector.batchSize}
  output {
    metrics = [otelcol.exporter.otlphttp.metrics.input]
    logs = [otelcol.exporter.otlphttp.logs.input]
    traces = [otelcol.exporter.otlphttp.traces.input]
  }
}
${exporters}
${nginx}`;
  const interval = `${config.platform.health.intervalMs}ms`;
  const timeout = `${config.platform.health.timeoutMs}ms`;
  const collectorHealth = `http://127.0.0.1:${endpointPort(collector.healthEndpoint, 'telemetry.collector.healthEndpoint')}/-/ready`;
  const checks = [
    ['otel-collector', collectorHealth],
    ...['grafana', 'loki', 'prometheus', 'tempo'].map(name => [name, new URL(name === 'grafana' ? '/api/health' : name === 'prometheus' ? '/-/ready' : '/ready', config.telemetry[name].endpoint).toString()]),
    ...(logFiles.some(entry => entry.service === 'edge-nginx') ? [['edge-nginx', config.telemetry.nginxStatusEndpoint]] : []),
  ];
  const blackboxConfig = JSON.stringify({modules: {http_2xx: {prober: 'http', timeout, http: {preferred_ip_protocol: 'ip4'}}}});
  return `${rendered}

prometheus.exporter.blackbox "health" {
  config = ${JSON.stringify(blackboxConfig)}
  probe_timeout_offset = "0s"
${checks.map(([name, address]) => `  target {
    name = ${JSON.stringify(name)}
    address = ${JSON.stringify(address)}
    module = "http_2xx"
    labels = { probe_owner = ${JSON.stringify(name)}, }
  }`).join('\n')}
}
prometheus.scrape "health" {
  targets = prometheus.exporter.blackbox.health.targets
  scrape_interval = ${JSON.stringify(interval)}
  scrape_timeout = ${JSON.stringify(timeout)}
  forward_to = [otelcol.receiver.prometheus.internal.receiver]
}
prometheus.exporter.unix "storage" { set_collectors = ["filesystem"] }
prometheus.scrape "storage" {
  targets = prometheus.exporter.unix.storage.targets
  scrape_interval = ${JSON.stringify(`${config.telemetry.alerts.evaluationIntervalMs}ms`)}
  scrape_timeout = ${JSON.stringify(timeout)}
  forward_to = [prometheus.relabel.storage.receiver]
}
prometheus.relabel "storage" {
  rule {
    source_labels = ["mountpoint"]
    regex = "/telemetry-storage/(grafana|loki|prometheus|tempo)"
    action = "keep"
  }
  rule {
    source_labels = ["__name__"]
    regex = "node_filesystem_(size|free)_bytes"
    action = "keep"
  }
  forward_to = [otelcol.receiver.prometheus.internal.receiver]
}
prometheus.exporter.self "internal" { }
prometheus.scrape "internal" {
  targets = prometheus.exporter.self.internal.targets
  scrape_interval = ${JSON.stringify(interval)}
  scrape_timeout = ${JSON.stringify(timeout)}
  forward_to = [otelcol.receiver.prometheus.internal.receiver]
}
otelcol.receiver.prometheus "internal" {
  output { metrics = [otelcol.processor.memory_limiter.internal.input] }
}
otelcol.processor.memory_limiter "internal" {
  ${limit}
  output { metrics = [otelcol.processor.transform.internal_resource.input] }
}
otelcol.processor.transform "internal_resource" {
  error_mode = "propagate"
  metric_statements {
    context = "metric"
    statements = ${value(resourceStatements('otel-collector'))}
  }
  output { metrics = [otelcol.processor.transform.metrics.input] }
}
`;
}

export function createBackendConfigs(config) {
  const {loki, prometheus, tempo, diskWatermarkPercent} = config.telemetry;
  return {
    loki: {
      auth_enabled: false,
      analytics: {reporting_enabled: config.telemetry.externalReportingEnabled},
      server: {http_listen_port: endpointPort(loki.endpoint, 'telemetry.loki.endpoint')},
      common: {path_prefix: '/var/loki', replication_factor: 1, ring: {kvstore: {store: 'inmemory'}}, storage: {filesystem: {chunks_directory: '/var/loki/chunks', rules_directory: '/var/loki/rules'}}},
      schema_config: {configs: [{from: '2024-01-01', store: 'tsdb', object_store: 'filesystem', schema: 'v13', index: {prefix: 'index_', period: '24h'}}]},
      ingester: {wal: {dir: '/var/loki/wal', disk_full_threshold: diskWatermarkPercent / 100}},
      compactor: {working_directory: '/var/loki/compactor', retention_enabled: true, delete_request_store: 'filesystem'},
      limits_config: {retention_period: `${loki.retentionDays * 24}h`, allow_structured_metadata: true},
    },
    prometheus: {
      global: {scrape_interval: `${config.platform.health.intervalMs}ms`, scrape_timeout: `${config.platform.health.timeoutMs}ms`},
      otlp: {promote_resource_attributes: ['service.name', 'service.namespace', 'service.version', 'deployment.environment']},
      storage: {tsdb: {out_of_order_time_window: `${prometheus.outOfOrderWindowMs}ms`}},
      scrape_configs: [],
    },
    tempo: {
      usage_report: {reporting_enabled: config.telemetry.externalReportingEnabled},
      server: {http_listen_port: endpointPort(tempo.endpoint, 'telemetry.tempo.endpoint')},
      distributor: {receivers: {otlp: {protocols: {http: {endpoint: `0.0.0.0:${endpointPort(tempo.otlpEndpoint, 'telemetry.tempo.otlpEndpoint')}`}}}}},
      storage: {trace: {backend: 'local', local: {path: '/var/tempo/blocks'}, wal: {path: '/var/tempo/wal'}}},
      live_store: {wal: {path: '/var/tempo/live-wal'}},
      backend_scheduler: {local_work_path: '/var/tempo/scheduler'},
      backend_worker: {compaction: {block_retention: `${tempo.retentionDays * 24}h`}},
    },
    datasources: {apiVersion: 1, datasources: [
      {name: 'Loki', uid: 'loki', type: 'loki', access: 'proxy', url: loki.endpoint},
      {name: 'Prometheus', uid: 'prometheus', type: 'prometheus', access: 'proxy', url: prometheus.endpoint, isDefault: true},
      {name: 'Tempo', uid: 'tempo', type: 'tempo', access: 'proxy', url: tempo.endpoint},
    ]},
  };
}

export function createComposeOverride({config, imageRefs, grafanaImage, alertSinkImage, logFiles, collectorConfigPath, probePath = '/usr/bin/busybox', storageVolumes, backendConfigPaths, grafanaAdminSecretPath, alertSinkPath = join(REPO_ROOT, 'tools/observability/alert-sink.mjs'), alertEvidenceDir, observabilityNetworkName = 'coffee_observability'} = {}) {
  if (typeof grafanaImage !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(grafanaImage)) throw new Error('verified grafanaImage ID is required');
  if (typeof alertSinkImage !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(alertSinkImage)) throw new Error('verified alertSinkImage ID is required');
  if (typeof observabilityNetworkName !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(observabilityNetworkName)) throw new Error('invalid observability network name');
  if (alertEvidenceDir !== undefined) {
    if (!isAbsolute(alertEvidenceDir)) throw new Error('alert evidence directory must be absolute');
    const info = lstatSync(alertEvidenceDir);
    if (!info.isDirectory() || info.uid !== 1000 || (info.mode & 0o777) !== 0o700 || realpathSync(alertEvidenceDir) !== resolve(alertEvidenceDir)) throw new Error('alert evidence directory must be a real mode 0700 directory owned by UID 1000');
  }
  for (const name of ['otelCollectorImage', 'grafanaImage', 'lokiImage', 'prometheusImage', 'tempoImage', 'bootstrapProbeSha256']) requireValue(imageRefs?.[name], name);
  if (new Set(Object.values(storageVolumes ?? {})).size !== 4) throw new Error('backend storage volumes must be distinct');
  for (const name of ['grafana', 'loki', 'prometheus', 'tempo']) {
    if (!/^coffee-[a-z0-9-]+$/u.test(requireValue(storageVolumes?.[name], `${name} storage volume`))) throw new Error(`${name} storage must be an isolated named volume`);
  }
  const logVolumes = logFiles.map(({containerId, logPath}) => ({type: 'bind', source: dirname(logPath), target: `/var/lib/docker/containers/${containerId}`, read_only: true}));
  const logging = createDockerLogging(config);
  const probeMount = {type: 'bind', source: resolve(probePath), target: '/busybox', read_only: true};
  const healthcheck = (url) => ({
    test: ['CMD', '/busybox', 'wget', '-q', '-O', '/dev/null', '-T', String(Math.max(1, Math.ceil(config.platform.health.timeoutMs / 1000))), url],
    interval: `${config.platform.health.intervalMs}ms`, timeout: `${config.platform.health.timeoutMs}ms`,
    start_period: `${config.platform.health.startupGraceMs}ms`, retries: config.platform.health.failureThreshold,
  });
  const common = (name, uid, target, healthPath) => ({
    image: name === 'grafana' ? grafanaImage : imageRefs[`${name}Image`], restart: 'unless-stopped', stop_grace_period: `${config.platform.shutdownGraceMs}ms`,
    init: true, read_only: true, user: uid, security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'],
    cpus: 1, mem_limit: `${config.telemetry[name].memoryLimitMiB}m`, pids_limit: 128,
    tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=8m'],
    volumes: [{type: 'volume', source: `${name}_data`, target}, probeMount],
    expose: [String(endpointPort(config.telemetry[name].endpoint, `telemetry.${name}.endpoint`))],
    networks: ['coffee_observability'], healthcheck: healthcheck(`http://127.0.0.1:${endpointPort(config.telemetry[name].endpoint, `telemetry.${name}.endpoint`)}${healthPath}`), logging,
  });
  const bind = (name, target) => ({type: 'bind', source: resolve(requireValue(backendConfigPaths?.[name], `${name} config path`)), target, read_only: true});
  const grafana = common('grafana', '472:472', '/var/lib/grafana', '/api/health');
  grafana.environment = {GF_SECURITY_ADMIN_USER: 'admin', GF_SECURITY_ADMIN_PASSWORD__FILE: '/run/secrets/admin-secret', GF_AUTH_ANONYMOUS_ENABLED: 'false', GF_PLUGINS_PREINSTALL_DISABLED: 'true', GF_ANALYTICS_REPORTING_ENABLED: String(config.telemetry.externalReportingEnabled), GF_ANALYTICS_CHECK_FOR_UPDATES: 'false', GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false', GF_SERVER_HTTP_PORT: String(endpointPort(config.telemetry.grafana.endpoint, 'telemetry.grafana.endpoint'))};
  grafana.volumes.push(bind('datasources', '/etc/grafana/provisioning/datasources/coffee.yaml'), bind('alerts', '/etc/grafana/provisioning/alerting/grafana-alerts.yaml'), bind('contacts', '/etc/grafana/provisioning/alerting/grafana-contacts.yaml'), {type: 'bind', source: resolve(requireValue(grafanaAdminSecretPath, 'grafanaAdminSecretPath')), target: '/run/secrets/admin-secret', read_only: true});
  const loki = common('loki', '10001:10001', '/var/loki', '/ready');
  loki.command = ['-config.file=/etc/loki/config.yaml']; loki.volumes.push(bind('loki', '/etc/loki/config.yaml'));
  const prometheus = common('prometheus', '65534:65534', '/prometheus', '/-/ready');
  prometheus.command = ['--config.file=/etc/prometheus/config.yaml', '--storage.tsdb.path=/prometheus', `--storage.tsdb.retention.time=${config.telemetry.prometheus.retentionDays}d`, `--storage.tsdb.retention.size=${Math.floor(config.telemetry.prometheus.maxDiskBytes * config.telemetry.diskWatermarkPercent / 100)}B`, '--web.enable-otlp-receiver', `--web.listen-address=0.0.0.0:${endpointPort(config.telemetry.prometheus.endpoint, 'telemetry.prometheus.endpoint')}`]; prometheus.volumes.push(bind('prometheus', '/etc/prometheus/config.yaml'));
  const tempo = common('tempo', '10001:10001', '/var/tempo', '/ready');
  tempo.command = ['-config.file=/etc/tempo/config.yaml', '-target=all']; tempo.volumes.push(bind('tempo', '/etc/tempo/config.yaml')); tempo.expose.push(String(endpointPort(config.telemetry.tempo.otlpEndpoint, 'telemetry.tempo.otlpEndpoint')));
  return {
    services: {
      ...Object.fromEntries(LOGGED_SERVICES.map((service) => [service, {logging}])),
      'otel-collector': {
        image: imageRefs.otelCollectorImage, command: ['run', '--storage.path=/var/lib/alloy', `--server.http.listen-addr=127.0.0.1:${endpointPort(config.telemetry.collector.healthEndpoint, 'telemetry.collector.healthEndpoint')}`, '--server.http.enable-pprof=false', '--server.http.disable-support-bundle=true', '--disable-reporting', '--stability.level=experimental', '/etc/alloy/config.alloy'], restart: 'unless-stopped', stop_grace_period: `${config.platform.shutdownGraceMs}ms`, init: true, read_only: true, user: '0:0', security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], cpus: 1, mem_limit: `${config.telemetry.collector.containerMemoryMiB}m`, pids_limit: 128, tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=8m'],
        volumes: [{type: 'bind', source: collectorConfigPath, target: '/etc/alloy/config.alloy', read_only: true}, probeMount, {type: 'volume', source: 'collector_checkpoints', target: '/var/lib/alloy', volume: {nocopy: true}}, ...['grafana', 'loki', 'prometheus', 'tempo'].map(name => ({type: 'volume', source: `${name}_data`, target: `/telemetry-storage/${name}`, read_only: true})), ...logVolumes],
        expose: [String(endpointPort(config.telemetry.collector.otlpEndpoint, 'telemetry.collector.otlpEndpoint'))], networks: TELEMETRY_NETWORKS,
        depends_on: Object.fromEntries(['loki', 'prometheus', 'tempo'].map((name) => [name, {condition: 'service_healthy'}])),
        healthcheck: healthcheck(`http://127.0.0.1:${endpointPort(config.telemetry.collector.healthEndpoint, 'telemetry.collector.healthEndpoint')}/-/ready`), logging,
      }, grafana, loki, prometheus, tempo,
      'alert-sink': {
        image: alertSinkImage, command: ['node', '/app/alert-sink.mjs', '/run/alerts/episodes.jsonl', String(config.telemetry.logging.maxSizeMiB), String(config.telemetry.logging.maxFiles)],
        restart: 'unless-stopped', stop_grace_period: `${config.platform.shutdownGraceMs}ms`, init: true, read_only: true,
        user: '1000:1000', security_opt: ['no-new-privileges:true'], cap_drop: ['ALL'], cpus: 0.1, mem_limit: `${config.telemetry.alerts.sinkMemoryMiB}m`, pids_limit: 32,
        ...(alertEvidenceDir === undefined ? {tmpfs: [`/run/alerts:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=${config.telemetry.logging.maxSizeMiB * (config.telemetry.logging.maxFiles + 1)}m`]} : {}),
        volumes: [{type: 'bind', source: resolve(alertSinkPath), target: '/app/alert-sink.mjs', read_only: true},
          ...(alertEvidenceDir === undefined ? [] : [{type: 'bind', source: resolve(alertEvidenceDir), target: '/run/alerts'}])],
        expose: ['9091'], networks: ['coffee_observability'], logging,
      },
    },
    networks: {coffee_observability: {name: observabilityNetworkName, internal: true}},
    volumes: {collector_checkpoints: {}, ...Object.fromEntries(['grafana', 'loki', 'prometheus', 'tempo'].map((name) => [`${name}_data`, {external: true, name: storageVolumes[name]}]))},
  };
}

export function createRuntimeLoggingOverride({config} = {}) {
  const logging = createDockerLogging(config);
  return {services: Object.fromEntries(LOGGED_SERVICES.map((service) => [service, {logging}]))};
}

function createDockerLogging(config) {
  return {
    driver: 'json-file',
    options: {
      'max-size': `${config.telemetry.logging.maxSizeMiB}m`,
      'max-file': String(config.telemetry.logging.maxFiles),
      mode: 'non-blocking',
      'max-buffer-size': String(config.telemetry.producer.maxRecordBytes * config.telemetry.producer.queueCapacity),
    },
  };
}

export async function generateRuntimeLoggingOverride({root = REPO_ROOT, outputDir = '/dev/shm/coffee-platform-observability', config} = {}) {
  const platformConfig = config ?? await loadPlatformConfig(root);
  const path = join(outputDir, 'runtime-logging.override.yaml');
  await ensurePrivateSecretDirectory(outputDir);
  const content = dumpYaml(createRuntimeLoggingOverride({config: platformConfig}), {noRefs: true, lineWidth: 120});
  await writePrivateSecret(path, content);
  return {path};
}

export async function generate({root = REPO_ROOT, projectName, outputDir = '/dev/shm/coffee-platform-observability', secretsPath = '/dev/shm/coffee-platform-observability-secrets/collector.json', grafanaAdminSecretPath = '/dev/shm/coffee-platform-grafana-bootstrap/admin-secret', probePath = '/usr/bin/busybox', storageVolumes, alertEvidenceDir, observabilityNetworkName, runDocker} = {}) {
  const config = await loadPlatformConfig(root);
  const imageRefs = JSON.parse(await readFile(join(root, 'config/toolchain-versions.json'), 'utf8'));
  await verifyBootstrapProbe({probePath, expectedSha256: imageRefs.bootstrapProbeSha256});
  const alertSinkImage = await loadVerifiedGateImage({target: 'storage-helper'});
  const grafanaImage = await loadVerifiedGateImage({target: 'grafana'});
  const logFiles = await discoverContainerLogs({projectName, runDocker});
  for (const [path, label] of [[secretsPath, 'collector'], [grafanaAdminSecretPath, 'grafana admin']]) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o400) throw new Error(`${label} scoped secret file must be regular and mode 0400`);
  }
  const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
  const collectorYaml = createAlloyConfig({config, logFiles, ...secrets});
  const collectorConfigPath = join(outputDir, 'collector.alloy');
  const composeOverridePath = join(outputDir, 'compose.override.yaml');
  const provenancePath = join(outputDir, 'provenance.json');
  await ensurePrivateSecretDirectory(outputDir);
  await writePrivateSecret(collectorConfigPath, collectorYaml);
  const {createGrafanaAlertProvisioning} = await import('./alerts.mjs');
  const provisioning = createGrafanaAlertProvisioning(config, {notificationUrl: config.telemetry.alerts.notificationEndpoint});
  const backendConfigs = {...createBackendConfigs(config), ...provisioning};
  const backendConfigPaths = {};
  for (const [name, value] of Object.entries(backendConfigs)) {
    const filename = name === 'alerts' || name === 'contacts' ? `grafana-${name}.yaml` : `${name}.yaml`;
    const path = join(outputDir, filename);
    await writeFile(path, dumpYaml(value, {noRefs: true, lineWidth: 120}), {mode: 0o444});
    await chmod(path, 0o444);
    backendConfigPaths[name] = path;
  }
  const composeYaml = dumpYaml(createComposeOverride({config, imageRefs, grafanaImage: grafanaImage.imageId, alertSinkImage: alertSinkImage.imageId, logFiles, collectorConfigPath, probePath, storageVolumes, backendConfigPaths, grafanaAdminSecretPath, alertSinkPath: join(root, 'tools/observability/alert-sink.mjs'), alertEvidenceDir, observabilityNetworkName}), {noRefs: true, lineWidth: 120});
  await writePrivateSecret(composeOverridePath, composeYaml);
  const provenance = await createObservabilityProvenance({root, config, imageRefs, grafanaImage, alertSinkImage, logFiles, storageVolumes, collectorConfigSha256: createHash('sha256').update(collectorYaml).digest('hex')});
  await writePrivateSecret(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  const collectorConfigOwnership = ensureCollectorConfigOwnership({collectorConfigPath, nodeImage: imageRefs.nodeImage, runDocker});
  const backendOwnership = ensureBackendOwnership({storageVolumes, grafanaAdminSecretPath, nodeImage: imageRefs.nodeImage, runDocker});
  return {collectorConfigPath, composeOverridePath, provenancePath, backendConfigPaths, logFiles, collectorConfigOwnership, backendOwnership};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const outputIndex = process.argv.indexOf('--output-dir');
    const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
    if (process.argv.includes('--logging-only')) {
      const result = await generateRuntimeLoggingOverride({outputDir});
      console.log(`runtime logging override generated: ${result.path}`);
    } else {
      const index = process.argv.indexOf('--project-name');
      const projectName = index >= 0 ? process.argv[index + 1] : undefined;
      const storageVolumes = Object.fromEntries(['grafana', 'loki', 'prometheus', 'tempo'].map((name) => {
        const index = process.argv.indexOf(`--${name}-volume`);
        return [name, index >= 0 ? process.argv[index + 1] : undefined];
      }));
      const result = await generate({projectName, storageVolumes, outputDir});
      console.log(`observability generated: ${result.composeOverridePath}`);
    }
  } catch (error) {
    console.error(`observability generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
