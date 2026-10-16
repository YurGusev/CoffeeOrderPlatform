import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod, lstat, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dump as dumpYaml} from 'js-yaml';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';

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

function requireValue(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

export function openObserveBufferEnvironment(openObserve) {
  return {
    ZO_MEM_TABLE_MAX_SIZE: String(requireValue(openObserve?.memTableMaxSizeMiB, 'telemetry.openObserve.memTableMaxSizeMiB')),
    ZO_MAX_FILE_SIZE_IN_MEMORY: String(requireValue(openObserve?.maxFileSizeInMemoryMiB, 'telemetry.openObserve.maxFileSizeInMemoryMiB')),
    ZO_MAX_FILE_SIZE_ON_DISK: String(requireValue(openObserve?.maxFileSizeOnDiskMiB, 'telemetry.openObserve.maxFileSizeOnDiskMiB')),
    ZO_MAX_FILE_RETENTION_TIME: String(requireValue(openObserve?.maxFileRetentionSeconds, 'telemetry.openObserve.maxFileRetentionSeconds')),
    ZO_MEM_PERSIST_INTERVAL: String(requireValue(openObserve?.memPersistIntervalSeconds, 'telemetry.openObserve.memPersistIntervalSeconds')),
  };
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

function hasExactDockerLogPath({containerId, logPath}) {
  return /^[a-f0-9]{64}$/u.test(containerId ?? '') &&
    typeof logPath === 'string' && logPath.startsWith('/') &&
    dirname(logPath).endsWith(`/${containerId}`) && logPath.endsWith(`/${containerId}-json.log`);
}

export async function createObservabilityProvenance({root = REPO_ROOT, config, imageRefs, logFiles, openObserveDataVolume, collectorConfigSha256} = {}) {
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
    images: {otelCollector: imageRefs.otelCollectorImage, openObserve: imageRefs.openObserveImage, nodeHelper: imageRefs.nodeImage},
    bootstrapProbeSha256: imageRefs.bootstrapProbeSha256,
    openObserveDataVolume,
    collectorConfigSha256,
    selectedLogs: logFiles.map(({service, containerId, logPath}) => ({service, containerId, logPath})),
    limits: {
      collector: {
        memoryLimitMiB: config.telemetry.collector.memoryLimitMiB,
        memorySpikeMiB: config.telemetry.collector.memorySpikeMiB,
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
      openObserve: {
        memoryLimitMiB: config.telemetry.openObserve.memoryLimitMiB,
        memTableMaxSizeMiB: config.telemetry.openObserve.memTableMaxSizeMiB,
        maxFileSizeInMemoryMiB: config.telemetry.openObserve.maxFileSizeInMemoryMiB,
        maxFileSizeOnDiskMiB: config.telemetry.openObserve.maxFileSizeOnDiskMiB,
        maxFileRetentionSeconds: config.telemetry.openObserve.maxFileRetentionSeconds,
        memPersistIntervalSeconds: config.telemetry.openObserve.memPersistIntervalSeconds,
        telemetryEnabled: config.telemetry.openObserve.telemetryEnabled,
        mmdbDownloadEnabled: config.telemetry.openObserve.mmdbDownloadEnabled,
        modelPricingEnabled: config.telemetry.openObserve.modelPricingEnabled,
        retentionDays: config.telemetry.openObserve.retentionDays,
        maxDiskBytes: config.telemetry.openObserve.maxDiskBytes,
        diskWatermarkPercent: config.telemetry.openObserve.diskWatermarkPercent,
        compactionIntervalSeconds: config.telemetry.openObserve.compactionIntervalSeconds,
        deleteFilesDelayMinutes: config.telemetry.openObserve.deleteFilesDelayMinutes,
        jobCleanupWaitSeconds: config.telemetry.openObserve.jobCleanupWaitSeconds,
      },
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

export function createCollectorConfig({config, logFiles, exporterToken, openObserveIngestToken} = {}) {
  const collector = requireValue(config?.telemetry?.collector, 'telemetry.collector');
  const openObserve = requireValue(config?.telemetry?.openObserve, 'telemetry.openObserve');
  const nginxStatusEndpoint = requireValue(config?.telemetry?.nginxStatusEndpoint, 'telemetry.nginxStatusEndpoint');
  if (!/^http:\/\/edge-nginx:[1-9][0-9]{0,4}\/nginx_status$/u.test(nginxStatusEndpoint) || Number(new URL(nginxStatusEndpoint).port) > 65535)
    throw new Error('telemetry.nginxStatusEndpoint must be the private edge-nginx stub_status endpoint');
  requireValue(exporterToken, 'telemetry.exporterToken');
  requireValue(openObserveIngestToken, 'telemetry.openObserveIngestToken');
  if (!Array.isArray(logFiles) || logFiles.length === 0 ||
      new Set(logFiles.map(({service}) => service)).size !== logFiles.length ||
      logFiles.some((entry) => !OBSERVABILITY_TARGETS.includes(entry.service) || !hasExactDockerLogPath(entry))) {
    throw new Error('logFiles must contain unique exact Docker json-file paths for selected runtimes');
  }
  const include = logFiles.map(({containerId}) => `/var/lib/docker/containers/${containerId}/${containerId}-json.log`);
  const includeNginxMetrics = logFiles.some(({service}) => service === 'edge-nginx');
  const collectorHealthEndpoint = new URL('/', requireValue(collector.healthEndpoint, 'telemetry.collector.healthEndpoint')).toString();
  const openObserveHealthEndpoint = new URL('/healthz', requireValue(openObserve.endpoint, 'telemetry.openObserve.endpoint')).toString();
  const sourceOwnerOperators = logFiles.map(({service, containerId}) => ({
    type: 'add',
    id: `owner-${service}`,
    field: 'resource["service.name"]',
    value: service,
    if: `attributes["log.file.path"] == "/var/lib/docker/containers/${containerId}/${containerId}-json.log"`,
    on_error: 'drop_quiet',
  }));
  const healthCheck = (endpoint) => ({
    collection_interval: `${config.platform.health.intervalMs}ms`,
    targets: [{endpoint, method: 'GET', timeout: `${config.platform.health.timeoutMs}ms`}],
  });
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
  for (const service of [...(includeNginxMetrics ? ['nginx'] : []), 'collector']) {
    pipelines[`metrics/${service}`] = {
      receivers: [service === 'nginx' ? 'nginx' : 'prometheus/collector'],
      processors: ['memory_limiter', `transform/${service}_resource`, 'transform/metric_names', 'batch'],
      exporters: ['otlp_http/metrics'],
    };
  }
  for (const service of [...(includeNginxMetrics ? ['nginx'] : []), 'collector', 'openobserve']) {
    pipelines[`metrics/health_${service}`] = {
      receivers: [`http_check/${service}`],
      processors: ['memory_limiter', `transform/health_${service}_resource`, 'transform/metric_names', 'batch'],
      exporters: ['otlp_http/metrics'],
    };
  }
  return {
    extensions: {
      health_check: {endpoint: `0.0.0.0:${endpointPort(collector.healthEndpoint, 'telemetry.collector.healthEndpoint')}`},
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
      'prometheus/collector': {
        config: {
          scrape_configs: [{
            job_name: 'otel-collector',
            scrape_interval: `${config.platform.health.intervalMs}ms`,
            static_configs: [{targets: [`127.0.0.1:${endpointPort(collector.metricsEndpoint, 'telemetry.collector.metricsEndpoint')}`]}],
          }],
        },
      },
      ...(includeNginxMetrics ? {'http_check/nginx': healthCheck(nginxStatusEndpoint)} : {}),
      'http_check/collector': healthCheck(collectorHealthEndpoint),
      'http_check/openobserve': healthCheck(openObserveHealthEndpoint),
      filelog: {
        include,
        include_file_path: true,
        start_at: 'beginning',
        max_log_size: collector.maxLogRecordBytes,
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
          {context: 'metric', statements: [
            `set(metric.name, Concat([${JSON.stringify(openObserve.streams.metrics)}, metric.name], "_"))`,
          ]},
          {context: 'datapoint', statements: ['delete_key(datapoint.attributes, "error.message")']},
        ],
      },
      ...(includeNginxMetrics ? {
        'transform/nginx_resource': {
          error_mode: 'propagate',
          metric_statements: [{context: 'metric', statements: resourceStatements('edge-nginx')}],
        },
      } : {}),
      'transform/collector_resource': {
        error_mode: 'propagate',
        metric_statements: [{context: 'metric', statements: resourceStatements('otel-collector')}],
      },
      'transform/health_collector_resource': {
        error_mode: 'propagate',
        metric_statements: [{context: 'metric', statements: resourceStatements('otel-collector')}],
      },
      ...(includeNginxMetrics ? {
        'transform/health_nginx_resource': {
          error_mode: 'propagate',
          metric_statements: [
            {context: 'metric', statements: resourceStatements('edge-nginx')},
            {context: 'datapoint', statements: ['delete_key(datapoint.attributes, "http.status_code")']},
          ],
        },
      } : {}),
      'transform/health_openobserve_resource': {
        error_mode: 'propagate',
        metric_statements: [{context: 'metric', statements: resourceStatements('openobserve')}],
      },
    },
    exporters: Object.fromEntries(['logs', 'traces', 'metrics'].map((signal) => [
      `otlp_http/${signal}`,
      {
        endpoint: `${openObserve.endpoint}/api/${openObserve.organization}`,
        headers: {
          Authorization: `Basic ${Buffer.from(`${openObserve.organization}:${openObserveIngestToken}`).toString('base64')}`,
          ...(signal === 'metrics' ? {} : {'stream-name': openObserve.streams[signal]}),
        },
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
      extensions: ['health_check', 'bearertokenauth/server'],
      telemetry: {
        metrics: {readers: [{pull: {exporter: {prometheus: {
          host: '0.0.0.0',
          port: endpointPort(collector.metricsEndpoint, 'telemetry.collector.metricsEndpoint'),
        }}}}]},
      },
      pipelines,
    },
  };
}

export function createComposeOverride({config, imageRefs, logFiles, collectorConfigPath, probePath = '/usr/bin/busybox', openObserveDataVolume} = {}) {
  requireValue(imageRefs?.otelCollectorImage, 'otelCollectorImage BOM ref');
  requireValue(imageRefs?.openObserveImage, 'openObserveImage BOM ref');
  requireValue(imageRefs?.bootstrapProbeSha256, 'bootstrapProbeSha256 BOM ref');
  if (!/^coffee-[a-z0-9-]+$/u.test(requireValue(openObserveDataVolume, 'openObserveDataVolume'))) throw new Error('openObserveDataVolume must be an isolated named volume');
  const logVolumes = logFiles.map(({containerId, logPath}) => {
    const directory = dirname(logPath);
    return {type: 'bind', source: directory, target: `/var/lib/docker/containers/${containerId}`, read_only: true};
  });
  const logging = createDockerLogging(config);
  const openObservePort = endpointPort(config.telemetry.openObserve.endpoint, 'telemetry.openObserve.endpoint');
  const probeMount = {type: 'bind', source: resolve(probePath), target: '/busybox', read_only: true};
  const probeTimeoutSeconds = Math.max(1, Math.ceil(config.platform.health.timeoutMs / 1000));
  const healthcheck = (url, {diskWatermarkPercent} = {}) => ({
    test: diskWatermarkPercent === undefined
      ? ['CMD', '/busybox', 'wget', '-q', '-O', '/dev/null', '-T', String(probeTimeoutSeconds), url]
      : ['CMD', '/busybox', 'sh', '-ceu', `/busybox wget -q -O /dev/null -T ${probeTimeoutSeconds} '${url}'; used="$(/busybox df -P /data | /busybox tail -n 1 | /busybox awk '{gsub(/%/, "", $5); print $5}')"; test "$used" -lt '${diskWatermarkPercent}'`],
    interval: `${config.platform.health.intervalMs}ms`,
    timeout: `${config.platform.health.timeoutMs}ms`,
    start_period: `${config.platform.health.startupGraceMs}ms`,
    retries: config.platform.health.failureThreshold,
  });
  return {
    services: {
      ...Object.fromEntries(LOGGED_SERVICES.map((service) => [service, {logging}])),
      'otel-collector': {
        image: imageRefs.otelCollectorImage,
        command: ['--config=/etc/otelcol-contrib/config.yaml'],
        restart: 'unless-stopped',
        init: true,
        read_only: true,
        user: '0:0',
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cpus: 1,
        mem_limit: `${config.telemetry.collector.memoryLimitMiB + config.telemetry.collector.memorySpikeMiB}m`,
        pids_limit: 128,
        tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=8m'],
        volumes: [
          {type: 'bind', source: collectorConfigPath, target: '/etc/otelcol-contrib/config.yaml', read_only: true},
          probeMount,
          ...logVolumes,
        ],
        expose: [
          String(endpointPort(config.telemetry.collector.otlpEndpoint, 'telemetry.collector.otlpEndpoint')),
          String(endpointPort(config.telemetry.collector.healthEndpoint, 'telemetry.collector.healthEndpoint')),
          String(endpointPort(config.telemetry.collector.metricsEndpoint, 'telemetry.collector.metricsEndpoint')),
        ],
        networks: TELEMETRY_NETWORKS,
        depends_on: {openobserve: {condition: 'service_healthy'}},
        healthcheck: healthcheck(`http://127.0.0.1:${endpointPort(config.telemetry.collector.healthEndpoint, 'telemetry.collector.healthEndpoint')}/`),
        logging,
      },
      openobserve: {
        image: imageRefs.openObserveImage,
        entrypoint: ['/busybox', 'sh', '-ceu'],
        command: [
          'test -f /data/.coffee-initialized-v1; test ! -L /data/.coffee-initialized-v1; '
          + '{ IFS= read -r marker_email; if IFS= read -r marker_extra; then exit 1; fi; } < /data/.coffee-initialized-v1; '
          + 'test "$marker_email" = "$ZO_ROOT_USER_EMAIL"; '
          + 'test -n "$ZO_ROOT_USER_PASSWORD"; exec /openobserve',
        ],
        restart: 'unless-stopped',
        init: true,
        read_only: true,
        user: '10001:10001',
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cpus: 2,
        mem_limit: `${config.telemetry.openObserve.memoryLimitMiB}m`,
        pids_limit: 128,
        environment: {
          ZO_LOCAL_MODE: 'true',
          ZO_DATA_DIR: '/data',
          ZO_HTTP_PORT: String(openObservePort),
          ZO_ROOT_USER_EMAIL: String(config.telemetry.openObserve.bootstrapEmail),
          ZO_ROOT_USER_PASSWORD: String(requireValue(config.telemetry.openObserve.validationMarker, 'telemetry.openObserve.validationMarker')),
          ...openObserveBufferEnvironment(config.telemetry.openObserve),
          ZO_TELEMETRY: String(config.telemetry.openObserve.telemetryEnabled),
          ZO_MMDB_DISABLE_DOWNLOAD: String(!config.telemetry.openObserve.mmdbDownloadEnabled),
          ZO_MODEL_PRICING_ENABLED: String(config.telemetry.openObserve.modelPricingEnabled),
          ZO_COMPACT_INTERVAL: String(config.telemetry.openObserve.compactionIntervalSeconds),
          ZO_COMPACT_DATA_RETENTION_INTERVAL: String(config.telemetry.openObserve.compactionIntervalSeconds),
          ZO_COMPACT_DATA_RETENTION_DAYS: String(config.telemetry.openObserve.retentionDays),
          ZO_COMPACT_DELETE_FILES_DELAY_MINUTES: String(config.telemetry.openObserve.deleteFilesDelayMinutes),
          ZO_COMPACT_JOB_CLEAN_WAIT_TIME: String(config.telemetry.openObserve.jobCleanupWaitSeconds),
          ZO_DISK_CIRCUIT_BREAKER_ENABLED: 'true',
          ZO_DISK_CIRCUIT_BREAKER_THRESHOLD: String(config.telemetry.openObserve.diskWatermarkPercent),
        },
        tmpfs: ['/tmp:rw,noexec,nosuid,nodev,size=8m'],
        volumes: [{type: 'volume', source: 'openobserve_data', target: '/data'}, probeMount],
        expose: [String(openObservePort)],
        networks: ['coffee_observability'],
        healthcheck: healthcheck(`http://127.0.0.1:${openObservePort}/healthz`, {diskWatermarkPercent: config.telemetry.openObserve.diskWatermarkPercent}),
        logging,
      },
    },
    networks: {coffee_observability: {name: 'coffee_observability', internal: true}},
    volumes: {openobserve_data: {external: true, name: openObserveDataVolume}},
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
  await mkdir(outputDir, {recursive: true, mode: 0o700});
  await chmod(outputDir, 0o700);
  const content = dumpYaml(createRuntimeLoggingOverride({config: platformConfig}), {noRefs: true, lineWidth: 120});
  await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(path, content, {encoding: 'utf8', mode: 0o400});
  await chmod(path, 0o400);
  return {path};
}

export async function generate({root = REPO_ROOT, projectName, outputDir = '/dev/shm/coffee-platform-observability', secretsPath = '/dev/shm/coffee-platform-observability-secrets/collector.json', probePath = '/usr/bin/busybox', openObserveDataVolume, runDocker} = {}) {
  requireValue(openObserveDataVolume, 'openObserveDataVolume');
  const config = await loadPlatformConfig(root);
  const toolchain = JSON.parse(await readFile(join(root, 'config/toolchain-versions.json'), 'utf8'));
  const imageRefs = {otelCollectorImage: toolchain.otelCollectorImage, openObserveImage: toolchain.openObserveImage, nodeImage: toolchain.nodeImage, bootstrapProbeSha256: toolchain.bootstrapProbeSha256};
  await verifyBootstrapProbe({probePath, expectedSha256: imageRefs.bootstrapProbeSha256});
  const logFiles = await discoverContainerLogs({projectName, runDocker});
  const secretInfo = await lstat(secretsPath);
  if (!secretInfo.isFile() || (secretInfo.mode & 0o777) !== 0o400) throw new Error('collector scoped secret file must be regular and mode 0400');
  const secrets = JSON.parse(await readFile(secretsPath, 'utf8'));
  const collectorConfig = createCollectorConfig({config, logFiles, ...secrets});
  const collectorYaml = dumpYaml(collectorConfig, {noRefs: true, lineWidth: 120});
  const collectorConfigPath = join(outputDir, 'collector.yaml');
  const composeOverridePath = join(outputDir, 'compose.override.yaml');
  const provenancePath = join(outputDir, 'provenance.json');
  await mkdir(outputDir, {recursive: true, mode: 0o700});
  await chmod(outputDir, 0o700);
  await unlink(collectorConfigPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(collectorConfigPath, collectorYaml, {encoding: 'utf8', mode: 0o400});
  await chmod(collectorConfigPath, 0o400);
  const composeYaml = dumpYaml(createComposeOverride({config, imageRefs, logFiles, collectorConfigPath, probePath, openObserveDataVolume}), {noRefs: true, lineWidth: 120});
  await writeFile(composeOverridePath, composeYaml, {encoding: 'utf8', mode: 0o400});
  await chmod(composeOverridePath, 0o400);
  const provenance = await createObservabilityProvenance({root, config, imageRefs, logFiles, openObserveDataVolume, collectorConfigSha256: createHash('sha256').update(collectorYaml).digest('hex')});
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {encoding: 'utf8', mode: 0o400});
  await chmod(provenancePath, 0o400);
  const collectorConfigOwnership = ensureCollectorConfigOwnership({collectorConfigPath, nodeImage: imageRefs.nodeImage, runDocker});
  return {collectorConfigPath, composeOverridePath, provenancePath, logFiles, collectorConfigOwnership};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const outputIndex = process.argv.indexOf('--output-dir');
    const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
    if (process.argv.includes('--logging-only')) {
      const result = await generateRuntimeLoggingOverride({outputDir});
      console.log(`runtime logging override generated: ${result.path}`);
      process.exitCode = 0;
    } else {
    const index = process.argv.indexOf('--project-name');
    const projectName = index >= 0 ? process.argv[index + 1] : undefined;
    const volumeIndex = process.argv.indexOf('--data-volume');
    const openObserveDataVolume = volumeIndex >= 0 ? process.argv[volumeIndex + 1] : undefined;
    const result = await generate({projectName, openObserveDataVolume, outputDir});
    console.log(`observability generated: ${result.composeOverridePath}`);
    }
  } catch (error) {
    console.error(`observability generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
