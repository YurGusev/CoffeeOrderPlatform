import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  verify,
  X509Certificate,
} from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import https from "node:https";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { Client } from "pg";
import {
  infrastructureSecretEntries,
  loadPlatformConfig,
  loadServiceCatalog,
} from "../../scripts/config-lib.mjs";
import {
  assertTelemetryNetworks,
  createCollectorConfig,
  createAlloyConfig,
  createObservabilityProvenance,
  createComposeOverride,
  discoverContainerLogs,
  ensureCollectorConfigOwnership,
  ensureBackendOwnership,
  generateRuntimeLoggingOverride,
  createBackendConfigs,
  verifyBootstrapProbe,
  writeBackendConfigs,
} from "../../tools/observability/generate.mjs";
import {
  checkBootstrap,
  attestCanonicalMigrationPreparation,
  ensureNginxSecretOwnership,
  finalizeAromaSandboxDatabase,
  loadRuntimeConfig,
  materializeAromaSandboxSecrets,
  materializeCollectorSecrets,
  materializeGrafanaAdminSecret,
  provisionDevelopmentGrafanaAdmin,
  materializeRuntimeSecrets,
  openAromaSandboxMigrator,
  probeCanonicalMigrationTarget,
  prepareCanonicalMigratorRoles,
  readPreparedPostgresIdentity,
  readMigrationCredential,
  readTastyCredentials,
  provisionAromaSandboxDatabases,
  removeMaterializedSecrets,
  synchronizeMigrationAdminCredential,
  validateMigrationPreparationArtifact,
  validateMigrationPreparationConfigTransition,
  validateBackupTarget,
} from "../../tools/config-bootstrap/index.mjs";
import {
  fixtureConfigText,
  materializeBrowserFixture,
  readBrowserFixtureLineage,
  validateBrowserFixtureGitLineage,
  validateBrowserFixtureLineage,
} from "../../tools/config-bootstrap/browser-fixture.mjs";
import {
  validateBrowserCorrelation,
  verifyBrowserChildBundle,
} from "../../verification/launch/v1/scenarios/browser.mjs";
import { runMigrationStage } from "../../verification/launch/v1/scenarios/migrations.mjs";
import { validateLaunchContext } from "../../verification/launch/v1/report.mjs";
import { assertScopedSecrets } from "../../packages/platform-runtime/dist/index.js";
import { checkObservabilityHealth } from "../../tools/observability/health.mjs";
import {
  createOidcProviderServer,
  selectBrowserFixtureAccount,
} from "../realtime/fixtures/oidc-provider.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const sample = {
  environment: "development",
  platform: {
    shutdownGraceMs: 30000,
    health: {
      intervalMs: 5000,
      timeoutMs: 1000,
      startupGraceMs: 30000,
      failureThreshold: 3,
    },
  },
  telemetry: {
    namespace: "coffee-platform",
    releaseDigest: "development",
    nginxStatusEndpoint: "http://edge-nginx:8081/nginx_status",
    collector: {
      otlpEndpoint: "http://otel-collector:4318",
      healthEndpoint: "http://otel-collector:13133",
      memoryLimitMiB: 128,
      memorySpikeMiB: 32,
      containerMemoryMiB: 512,
      memoryCheckIntervalMs: 1000,
      batchSize: 128,
      batchTimeoutMs: 1000,
      queueCapacity: 2048,
      queueConsumers: 2,
      exportTimeoutMs: 2000,
      retryInitialMs: 1000,
      retryMaxMs: 5000,
      retryWindowMs: 15000,
      maxLogRecordBytes: 65536,
    },
    producer: {
      queueCapacity: 256,
      maxRecordBytes: 16384,
      batchSize: 64,
      batchIntervalMs: 1000,
      exportTimeoutMs: 1000,
      diagnosticIntervalMs: 10000,
      flushTimeoutMs: 2000,
    },
    logging: { maxSizeMiB: 8, maxFiles: 3 },
    diskWatermarkPercent: 80,
    externalReportingEnabled: false,
    alerts: {
      evaluationIntervalMs: 60000,
      diskUsage: { forMs: 0 },
      sinkMemoryMiB: 128,
    },
    grafana: {
      endpoint: "http://grafana:3000",
      memoryLimitMiB: 512,
      maxDiskBytes: 1073741824,
    },
    loki: {
      endpoint: "http://loki:3100",
      memoryLimitMiB: 512,
      maxDiskBytes: 1073741824,
      retentionDays: 3,
    },
    prometheus: {
      endpoint: "http://prometheus:9090",
      memoryLimitMiB: 512,
      maxDiskBytes: 1073741824,
      retentionDays: 3,
      outOfOrderWindowMs: 1800000,
    },
    tempo: {
      endpoint: "http://tempo:3200",
      otlpEndpoint: "http://tempo:4318",
      memoryLimitMiB: 768,
      maxDiskBytes: 1073741824,
      retentionDays: 3,
      finishOnShutdownTimeoutMs: 10000,
    },
  },
};
const logs = [
  {
    service: "edge-nginx",
    containerId: "a".repeat(64),
    logPath: `/var/lib/docker/containers/${"a".repeat(64)}/${"a".repeat(64)}-json.log`,
  },
  {
    service: "orders-service",
    containerId: "b".repeat(64),
    logPath: `/srv/coffee/docker-data/containers/${"b".repeat(64)}/${"b".repeat(64)}-json.log`,
  },
];

void test("infrastructure scopes separate Collector and Grafana credentials", async () => {
  const catalog = await loadServiceCatalog(REPO_ROOT);
  assert.deepEqual(catalog.infrastructureSecretScopes, {
    "otel-collector": [
      { name: "exporterToken", ref: "telemetry.exporterToken" },
    ],
    "grafana-bootstrap": [
      { name: "admin-secret", ref: "telemetry.grafanaAdmin" },
    ],
  });
  assert.deepEqual(
    await infrastructureSecretEntries("grafana-bootstrap", { root: REPO_ROOT }),
    [["admin-secret", "telemetry.grafanaAdmin"]],
  );
  const root = await mkdtemp("/dev/shm/coffee-observability-catalog-");
  try {
    await mkdir(`${root}/config`, { recursive: true });
    await cp(
      `${REPO_ROOT}/config/service-catalog.schema.json`,
      `${root}/config/service-catalog.schema.json`,
    );
    catalog.infrastructureSecretScopes["otel-collector"].push({
      name: "admin-secret",
      ref: "telemetry.grafanaAdmin",
    });
    await writeFile(
      `${root}/config/service-catalog.json`,
      JSON.stringify(catalog),
    );
    await assert.rejects(loadServiceCatalog(root), /CONFIG-SCHEMA/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("backend configs replace readonly files on a second generation", async () => {
  const dir = await mkdtemp("/dev/shm/coffee-observability-config-");
  try {
    const first = await writeBackendConfigs(dir, {
      loki: { retention: "old" },
      alerts: { version: 1 },
    });
    assert.equal((await stat(first.loki)).mode & 0o777, 0o444);
    const second = await writeBackendConfigs(dir, {
      loki: { retention: "new" },
      alerts: { version: 2 },
    });
    assert.deepEqual(first, second);
    assert.deepEqual(parseYaml(await readFile(second.loki, "utf8")), {
      retention: "new",
    });
    assert.deepEqual(parseYaml(await readFile(second.alerts, "utf8")), {
      version: 2,
    });
    assert.equal((await stat(second.loki)).mode & 0o777, 0o444);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("bootstrap probe is an executable matching the BOM SHA-256", async () => {
  const toolchain = JSON.parse(
    await readFile(`${REPO_ROOT}/config/toolchain-versions.json`, "utf8"),
  );
  const result = await verifyBootstrapProbe({
    expectedSha256: toolchain.bootstrapProbeSha256,
  });
  assert.equal(result.sha256, toolchain.bootstrapProbeSha256);
  await assert.rejects(
    verifyBootstrapProbe({ expectedSha256: "0".repeat(64) }),
    /differs from the BOM pin/u,
  );
});

void test("observability health probes all services with the configured timeout", async () => {
  const urls = [];
  const results = await checkObservabilityHealth({
    config: sample,
    collectorProbe: () => true,
    fetchImpl: async (url, options) => {
      assert.ok(url instanceof URL);
      urls.push(url.href);
      assert.ok(options.signal);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(
    results.map((result) => result.name),
    ["otel-collector", "grafana", "loki", "prometheus", "tempo"],
  );
  assert.deepEqual(urls, [
    "http://grafana:3000/api/health",
    "http://loki:3100/ready",
    "http://prometheus:9090/-/ready",
    "http://tempo:3200/ready",
  ]);
  await assert.rejects(
    checkObservabilityHealth({
      config: sample,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /loopback probe is required/u,
  );
  await assert.rejects(
    checkObservabilityHealth({
      config: sample,
      collectorProbe: () => false,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /loopback probe failed/u,
  );
});

void test("Collector config ownership is changed only by pinned Node with CAP_CHOWN and retains mode 0400", () => {
  const calls = [];
  const proof = ensureCollectorConfigOwnership({
    collectorConfigPath: "/dev/shm/coffee-observability/collector.yaml",
    nodeImage: "node@sha256:" + "d".repeat(64),
    runDocker: (args, timeout) => {
      calls.push({ args, timeout });
      return '{"uid":0,"gid":0,"mode":"0400"}';
    },
  });
  assert.deepEqual(proof, {
    path: "/dev/shm/coffee-observability/collector.yaml",
    uid: 0,
    gid: 0,
    mode: "0400",
    verified: true,
  });
  ensureCollectorConfigOwnership({
    collectorConfigPath: "/dev/shm/config",
    nodeImage: "sha256:" + "a".repeat(64),
    runDocker: (args) => {
      assert.ok(args.includes("sha256:" + "a".repeat(64)));
      return '{"uid":0,"gid":0,"mode":"0400"}';
    },
  });
  assert.equal(calls[0].timeout, 10000);
  assert.ok(
    calls[0].args.includes("--network") && calls[0].args.includes("none"),
  );
  assert.ok(
    calls[0].args.includes("--cap-drop") &&
      calls[0].args.includes("--cap-add") &&
      calls[0].args.includes("CHOWN"),
  );
  assert.ok(
    calls[0].args.some((arg) =>
      arg.includes(
        "type=bind,source=/dev/shm/coffee-observability/collector.yaml,target=/collector.yaml",
      ),
    ),
  );
  assert.ok(calls[0].args.at(-1).includes("fs.chownSync(p,0,0)"));
  assert.ok(calls[0].args.at(-1).includes("after.uid!==0"));
  assert.throws(
    () =>
      ensureCollectorConfigOwnership({
        collectorConfigPath: "/dev/shm/config",
        nodeImage: "node:latest",
        runDocker: () => "",
      }),
    /nodeImage BOM digest/u,
  );
});

void test("runtime logging override is bounded and can be emitted before container discovery", async () => {
  const outputDir = await mkdtemp("/dev/shm/coffee-runtime-logging-");
  try {
    const { path } = await generateRuntimeLoggingOverride({
      root: REPO_ROOT,
      outputDir,
      config: sample,
    });
    const contents = await readFile(path, "utf8");
    const metadata = await stat(path);
    assert.equal(metadata.mode & 0o777, 0o400);
    assert.match(contents, /mode: non-blocking/u);
    assert.match(contents, /max-buffer-size: ['"]4194304['"]/u);
    assert.match(contents, /edge-gateway:/u);
    assert.match(contents, /kafka:/u);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

void test("observability generator rejects a symlink output directory without changing its target", async () => {
  const root = await mkdtemp("/dev/shm/coffee-runtime-logging-link-");
  const targetDir = join(root, "target");
  const outputLink = join(root, "output");
  await mkdir(targetDir);
  await symlink(targetDir, outputLink, "dir");
  try {
    await assert.rejects(
      generateRuntimeLoggingOverride({
        root: REPO_ROOT,
        outputDir: outputLink,
        config: sample,
      }),
      /real directory owned by config-bootstrap/u,
    );
    assert.deepEqual(await readdir(targetDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("observability provenance includes all pinned images, bounded storage and no credentials", async () => {
  const imageRefs = Object.fromEntries(
    [
      "otelCollectorImage",
      "grafanaImage",
      "lokiImage",
      "prometheusImage",
      "tempoImage",
      "nodeImage",
    ].map((name) => [name, `fixture@sha256:${"a".repeat(64)}`]),
  );
  imageRefs.bootstrapProbeSha256 = "b".repeat(64);
  const storageVolumes = Object.fromEntries(
    ["grafana", "loki", "prometheus", "tempo"].map((name) => [
      name,
      `coffee-test-${name}-data`,
    ]),
  );
  const alertSinkImage = {
    imageId: `sha256:${"d".repeat(64)}`,
    receiptSha256: "e".repeat(64),
    candidateSha: "f".repeat(40),
    runId: "fixture",
  };
  const grafanaImage = {
    imageId: `sha256:${"1".repeat(64)}`,
    receiptSha256: "2".repeat(64),
    candidateSha: "3".repeat(40),
    runId: "fixture",
  };
  const provenance = await createObservabilityProvenance({
    root: REPO_ROOT,
    config: sample,
    imageRefs,
    grafanaImage,
    alertSinkImage,
    logFiles: logs,
    storageVolumes,
    collectorConfigSha256: "c".repeat(64),
  });
  assert.deepEqual(provenance.storageVolumes, storageVolumes);
  assert.deepEqual(Object.keys(provenance.images), [
    "otelCollector",
    "grafanaBase",
    "loki",
    "prometheus",
    "tempo",
    "nodeHelper",
  ]);
  assert.equal(provenance.images.grafanaBase, imageRefs.grafanaImage);
  const admitted = await createObservabilityProvenance({
    root: REPO_ROOT,
    config: sample,
    imageRefs,
    grafanaImage,
    alertSinkImage,
    logFiles: logs,
    storageVolumes,
    collectorConfigSha256: "c".repeat(64),
    nodeHelperImage: alertSinkImage.imageId,
  });
  assert.equal(admitted.images.nodeHelper, alertSinkImage.imageId);
  assert.deepEqual(provenance.grafanaImage, grafanaImage);
  assert.deepEqual(provenance.alertSinkImage, alertSinkImage);
  assert.equal(provenance.limits.loki.maxDiskBytes, 1073741824);
  assert.doesNotMatch(
    JSON.stringify(provenance),
    /producer-token|admin-secret/u,
  );
});

void test("backend ownership helper refuses foreign volumes before changing ownership", () => {
  const storageVolumes = Object.fromEntries(
    ["grafana", "loki", "prometheus", "tempo"].map((name) => [
      name,
      `coffee-test-${name}-data`,
    ]),
  );
  const calls = [];
  const nodeImage = `node:fixture@sha256:${"a".repeat(64)}`;
  const runDocker = (args) => {
    calls.push(args);
    if (args[0] === "volume")
      return JSON.stringify([
        {
          Driver: "local",
          Labels: {
            "coffee.owner": args[2].includes("tempo")
              ? "foreign"
              : "operations",
            "coffee.lifecycle": "fixture",
          },
          Options: {
            type: "ext4",
            o: "nodev,nosuid,noexec",
            device: "/dev/loop1",
          },
        },
      ]);
    throw new Error("unexpected mutation");
  };
  assert.throws(
    () =>
      ensureBackendOwnership({
        storageVolumes,
        grafanaAdminSecretPath: "/tmp/admin-secret",
        nodeImage,
        runDocker,
      }),
    /unrelated telemetry volume/u,
  );
  assert.equal(
    calls.some((args) => args[0] === "run"),
    false,
  );
});

void test("Collector config accepts only exact selected log files and bounds export", () => {
  const config = createCollectorConfig({
    config: sample,
    logFiles: logs,
    exporterToken: "producer-token",
  });
  assert.deepEqual(config.receivers.filelog.include, [
    `/var/lib/docker/containers/${"a".repeat(64)}/${"a".repeat(64)}-json.log`,
    `/var/lib/docker/containers/${"b".repeat(64)}/${"b".repeat(64)}-json.log`,
  ]);
  assert.equal(config.receivers.filelog.storage, "file_storage");
  assert.deepEqual(config.extensions.file_storage, {
    directory: "/var/lib/alloy/file_storage",
    fsync: true,
  });
  assert.ok(config.service.extensions.includes("file_storage"));
  assert.equal(config.receivers.filelog.include_file_path, true);
  assert.equal(config.receivers.filelog.max_log_size, 65536);
  assert.deepEqual(config.receivers.filelog.operators, [
    {
      type: "add",
      id: "owner-edge-nginx",
      field: 'resource["service.name"]',
      value: "edge-nginx",
      if: `attributes["log.file.path"] == ${JSON.stringify(logs[0].logPath)}`,
      on_error: "drop_quiet",
    },
    {
      type: "add",
      id: "owner-orders-service",
      field: 'resource["service.name"]',
      value: "orders-service",
      if: `attributes["log.file.path"] == "/var/lib/docker/containers/${"b".repeat(64)}/${"b".repeat(64)}-json.log"`,
      on_error: "drop_quiet",
    },
    {
      type: "json_parser",
      id: "docker_json",
      parse_from: "body",
      parse_to: "attributes",
      on_error: "drop_quiet",
      timestamp: {
        parse_from: "attributes.time",
        layout_type: "gotime",
        layout: "2006-01-02T15:04:05.999999999Z07:00",
      },
    },
    {
      type: "move",
      from: "attributes.log",
      to: "body",
      on_error: "drop_quiet",
    },
    {
      type: "filter",
      id: "structured_json_only",
      expr: 'not (body matches "^[[:space:]]*[{]")',
    },
    {
      type: "json_parser",
      id: "application_json",
      parse_from: "body",
      parse_to: "body",
      on_error: "drop_quiet",
    },
    {
      type: "time_parser",
      id: "producer_time",
      if: "body.time != nil",
      parse_from: "body.time",
      layout_type: "epoch",
      layout: "ms",
      on_error: "drop_quiet",
    },
  ]);
  assert.ok(
    config.receivers.filelog.operators.some(
      ({ type, id, expr }) =>
        type === "filter" &&
        id === "structured_json_only" &&
        expr === 'not (body matches "^[[:space:]]*[{]")',
    ),
  );
  assert.deepEqual(config.service.pipelines.logs.receivers, ["filelog"]);
  assert.deepEqual(config.service.pipelines.logs.processors, [
    "memory_limiter",
    "transform/records",
    "batch",
  ]);
  assert.equal(
    config.processors["transform/records"].log_statements[0].statements[0],
    "flatten(log.body, resolveConflicts=true) where IsMap(log.body)",
  );
  assert.match(
    config.processors["transform/records"].log_statements[0].statements[1],
    /^delete_matching_keys\(log\.body, .+\) where IsMap\(log\.body\)$/u,
  );
  assert.match(
    config.processors["transform/records"].log_statements[0].statements[2],
    /^delete_matching_keys\(log\.attributes, .+\)$/u,
  );
  assert.equal(
    config.processors["transform/records"].log_statements[0].statements.some(
      (statement) => statement.includes('resource.attributes["service.name"]'),
    ),
    false,
  );
  assert.deepEqual(config.service.pipelines.metrics.processors, [
    "memory_limiter",
    "transform/metric_names",
    "batch",
  ]);
  assert.deepEqual(config.receivers.nginx, {
    endpoint: sample.telemetry.nginxStatusEndpoint,
    collection_interval: "5000ms",
  });
  assert.deepEqual(config.service.pipelines["metrics/nginx"].receivers, [
    "nginx",
  ]);
  assert.deepEqual(
    config.processors["transform/nginx_resource"].metric_statements[0]
      .statements,
    [
      'set(resource.attributes["service.name"], "edge-nginx")',
      'set(resource.attributes["service.namespace"], "coffee-platform")',
      'set(resource.attributes["service.version"], "development")',
      'set(resource.attributes["deployment.environment"], "development")',
    ],
  );
  const minimalConfig = createCollectorConfig({
    config: sample,
    logFiles: [
      {
        service: "edge-gateway",
        containerId: "b".repeat(64),
        logPath: `/var/lib/docker/containers/${"b".repeat(64)}/${"b".repeat(64)}-json.log`,
      },
    ],
    exporterToken: "producer-token",
  });
  assert.equal(minimalConfig.receivers.nginx, undefined);
  assert.equal(minimalConfig.processors["transform/nginx_resource"], undefined);
  assert.equal(minimalConfig.service.pipelines["metrics/nginx"], undefined);
  const emptyConfig = createCollectorConfig({
    config: sample,
    logFiles: [],
    exporterToken: "producer-token",
  });
  assert.equal(emptyConfig.receivers.filelog, undefined);
  assert.equal(emptyConfig.receivers.nginx, undefined);
  assert.equal(emptyConfig.service.pipelines.logs, undefined);
  assert.equal(emptyConfig.extensions.file_storage, undefined);
  assert.equal(
    emptyConfig.receivers.otlp.protocols.http.auth.authenticator,
    "bearertokenauth/server",
  );
  assert.deepEqual(Object.keys(emptyConfig.service.pipelines).sort(), [
    "metrics",
    "traces",
  ]);
  const emptyAlloy = createAlloyConfig({
    config: sample,
    logFiles: [],
    exporterToken: "producer-token",
  });
  assert.doesNotMatch(
    emptyAlloy,
    /otelcol\.receiver\.filelog|otelcol\.storage\.file|otelcol\.processor\.transform "logs"|otelcol\.exporter\.otlphttp "logs"|otelcol\.receiver\.nginx/u,
  );
  assert.match(emptyAlloy, /auth = otelcol\.auth\.bearer\.producer\.handler/u);
  assert.match(
    emptyAlloy,
    /metrics = \[otelcol\.processor\.memory_limiter\.main\.input\]/u,
  );
  assert.match(
    emptyAlloy,
    /traces = \[otelcol\.processor\.memory_limiter\.main\.input\]/u,
  );
  assert.deepEqual(
    config.processors["transform/metric_names"].metric_statements[0],
    {
      context: "datapoint",
      statements: [
        'delete_key(datapoint.attributes, "error.message")',
        'delete_key(datapoint.attributes, "http.url")',
      ],
    },
  );
  assert.equal(config.service.pipelines.traces.receivers[0], "otlp");
  assert.equal(config.processors.memory_limiter.limit_mib, 128);
  assert.equal(config.processors.memory_limiter.spike_limit_mib, 32);
  assert.equal(
    config.exporters["otlp_http/logs"].sending_queue.queue_size,
    2048,
  );
  assert.equal(
    config.exporters["otlp_http/logs"].retry_on_failure.max_elapsed_time,
    "15000ms",
  );
  const redaction = config.processors[
    "transform/records"
  ].log_statements[0].statements[1].match(
    /delete_matching_keys\(log\.body, "(.*)"\)/u,
  )?.[1];
  const redactionKey = new RegExp(redaction.slice(4), "iu");
  assert.equal(redactionKey.test("password"), true);
  assert.equal(redactionKey.test("client_ip"), true);
  assert.equal(redactionKey.test("description"), false);
  assert.equal(redactionKey.test("security"), false);
  assert.throws(
    () =>
      createCollectorConfig({
        config: sample,
        logFiles: [{ ...logs[0], logPath: "/tmp/all-containers/*.log" }],
        exporterToken: "x",
      }),
    /exact Docker json-file paths/u,
  );
});

void test("generated Collector and backend configs preserve bounded delivery and isolate each store", async () => {
  const collector = createCollectorConfig({
    config: sample,
    logFiles: logs,
    exporterToken: "producer-token",
  });
  assert.equal(
    collector.exporters["otlp_http/logs"].endpoint,
    "http://loki:3100/otlp",
  );
  assert.equal(
    collector.exporters["otlp_http/metrics"].endpoint,
    "http://prometheus:9090/api/v1/otlp",
  );
  assert.equal(
    collector.exporters["otlp_http/traces"].endpoint,
    "http://tempo:4318",
  );
  assert.equal(collector.receivers.filelog.storage, "file_storage");
  for (const signal of ["logs", "metrics", "traces"])
    assert.equal(
      collector.exporters[`otlp_http/${signal}`].sending_queue.queue_size,
      2048,
    );
  const alloy = createAlloyConfig({
    config: sample,
    logFiles: logs,
    exporterToken: "producer-token",
  });
  assert.match(alloy, /auth = otelcol.auth.bearer.producer.handler/u);
  assert.match(alloy, /endpoint = "0.0.0.0:4318"/u);
  assert.match(alloy, /operators = /u);
  assert.match(
    alloy,
    /logs = \[otelcol.processor.memory_limiter.main.input\]/u,
  );
  assert.match(alloy, /prometheus.exporter.unix "storage"/u);
  assert.match(
    alloy,
    /\/telemetry-storage\/\(grafana\|loki\|prometheus\|tempo\)/u,
  );
  assert.match(alloy, /prometheus.exporter.blackbox "health"/u);
  assert.match(alloy, /probe_owner = "edge-nginx"/u);
  assert.match(alloy, /otelcol.receiver.nginx "edge"/u);
  const backend = createBackendConfigs(sample);
  assert.equal(
    backend.prometheus.storage.tsdb.out_of_order_time_window,
    "1800000ms",
  );
  assert.equal(backend.loki.analytics.reporting_enabled, false);
  assert.equal(backend.tempo.usage_report.reporting_enabled, false);
  assert.equal(backend.loki.ingester.wal.disk_full_threshold, 0.8);
  assert.equal(backend.loki.limits_config.retention_period, "72h");
  assert.equal(backend.tempo.backend_worker.compaction.block_retention, "72h");
  assert.equal(
    backend.tempo.backend_worker.finish_on_shutdown_timeout,
    "10000ms",
  );
  assert.deepEqual(
    backend.datasources.datasources.map((source) => source.uid),
    ["loki", "prometheus", "tempo"],
  );
  const images = Object.fromEntries(
    [
      "otelCollectorImage",
      "grafanaImage",
      "lokiImage",
      "prometheusImage",
      "tempoImage",
      "nodeImage",
    ].map((name) => [name, `fixture@sha256:${"a".repeat(64)}`]),
  );
  images.bootstrapProbeSha256 = "a".repeat(64);
  const names = ["grafana", "loki", "prometheus", "tempo"];
  const storageVolumes = Object.fromEntries(
    names.map((name) => [name, `coffee-test-${name}-data`]),
  );
  const backendConfigPaths = Object.fromEntries(
    [...names, "datasources", "alerts", "contacts"].map((name) => [
      name,
      `/tmp/${name}.yaml`,
    ]),
  );
  const alertSinkImage = `sha256:${"b".repeat(64)}`;
  const grafanaImage = `sha256:${"c".repeat(64)}`;
  const compose = createComposeOverride({
    config: sample,
    imageRefs: images,
    grafanaImage,
    alertSinkImage,
    logFiles: logs,
    collectorConfigPath: "/tmp/collector.yaml",
    storageVolumes,
    backendConfigPaths,
    grafanaAdminSecretPath: "/tmp/admin-secret",
  });
  for (const name of names) {
    assert.equal(compose.volumes[`${name}_data`].name, storageVolumes[name]);
    assert.deepEqual(compose.services[name].networks, ["coffee_observability"]);
    assert.equal(compose.services[name].ports, undefined);
  }
  assert.equal(compose.services.grafana.mem_limit, "512m");
  assert.equal(
    compose.services.grafana.environment.GF_PLUGINS_PREINSTALL_DISABLED,
    "true",
  );
  assert.equal(compose.services.grafana.image, grafanaImage);
  assert.notEqual(compose.services.grafana.image, images.grafanaImage);
  assert.ok(
    compose.services.grafana.volumes.some(
      (volume) => volume.target === "/var/lib/grafana",
    ),
  );
  assert.ok(
    compose.services.grafana.volumes.every(
      (volume) =>
        !"/opt/grafana/plugins".startsWith(`${volume.target}/`) &&
        volume.target !== "/opt/grafana/plugins",
    ),
  );
  assert.match(
    compose.services.prometheus.command.join(" "),
    /--web.enable-otlp-receiver/u,
  );
  assert.deepEqual(compose.services["otel-collector"].expose, ["4318"]);
  assert.equal(
    compose.services["otel-collector"].healthcheck.test.at(-1),
    "http://127.0.0.1:13133/-/ready",
  );
  assert.ok(
    compose.services["otel-collector"].command.includes(
      "--server.http.listen-addr=127.0.0.1:13133",
    ),
  );
  assert.deepEqual(
    compose.services["otel-collector"].volumes.find(
      (volume) => volume.target === "/var/lib/alloy",
    ),
    {
      type: "volume",
      source: "collector_checkpoints",
      target: "/var/lib/alloy",
      volume: { nocopy: true },
    },
  );
  assert.equal(
    compose.services["otel-collector"].volumes.filter(
      (volume) =>
        volume.target.startsWith("/telemetry-storage/") && volume.read_only,
    ).length,
    4,
  );
  assert.deepEqual(compose.services["alert-sink"].tmpfs, [
    "/run/alerts:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=32m",
  ]);
  assert.equal(compose.services["alert-sink"].image, alertSinkImage);
  assert.notEqual(compose.services["alert-sink"].image, images.nodeImage);
  const evidenceDir = await mkdtemp("/dev/shm/coffee-alert-evidence-");
  const link = `${evidenceDir}-link`;
  const args = {
    config: sample,
    imageRefs: images,
    grafanaImage,
    alertSinkImage,
    logFiles: logs,
    collectorConfigPath: "/tmp/collector.yaml",
    storageVolumes,
    backendConfigPaths,
    grafanaAdminSecretPath: "/tmp/admin-secret",
  };
  const withoutRuntimes = createComposeOverride({ ...args, logFiles: [] });
  assert.deepEqual(withoutRuntimes.services["otel-collector"].networks, [
    "coffee_observability",
  ]);
  assert.equal(
    withoutRuntimes.services["otel-collector"].volumes.some((volume) =>
      volume.target.startsWith("/var/lib/docker/containers/"),
    ),
    false,
  );
  for (const invalid of [undefined, images.grafanaImage, "sha256:bad"])
    assert.throws(
      () => createComposeOverride({ ...args, grafanaImage: invalid }),
      /verified grafanaImage ID is required/u,
    );
  for (const invalid of [undefined, images.nodeImage, "sha256:bad"])
    assert.throws(
      () => createComposeOverride({ ...args, alertSinkImage: invalid }),
      /verified alertSinkImage ID is required/u,
    );
  try {
    if (process.getuid() !== 1000) {
      assert.throws(
        () => createComposeOverride({ ...args, alertEvidenceDir: evidenceDir }),
        /owned by UID 1000/u,
      );
      return;
    }
    const isolated = createComposeOverride({
      ...args,
      alertEvidenceDir: evidenceDir,
      observabilityNetworkName: "coffee-observability-network",
    });
    assert.deepEqual(isolated.networks.coffee_observability, {
      name: "coffee-observability-network",
      internal: true,
    });
    assert.ok(
      isolated.services["otel-collector"].networks.includes(
        "coffee_observability",
      ),
    );
    assert.equal(isolated.services["alert-sink"].tmpfs, undefined);
    assert.deepEqual(isolated.services["alert-sink"].volumes.at(-1), {
      type: "bind",
      source: evidenceDir,
      target: "/run/alerts",
    });
    await symlink(evidenceDir, link, "dir");
    assert.throws(
      () => createComposeOverride({ ...args, alertEvidenceDir: link }),
      /real mode 0700/u,
    );
    await chmod(evidenceDir, 0o755);
    assert.throws(
      () => createComposeOverride({ ...args, alertEvidenceDir: evidenceDir }),
      /real mode 0700/u,
    );
    for (const name of ["coffee/production", null])
      assert.throws(
        () =>
          createComposeOverride({ ...args, observabilityNetworkName: name }),
        /invalid observability network/u,
      );
  } finally {
    await rm(link, { force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

void test("normal discovery uses only owned telemetry networks", () => {
  const inspected = [];
  let foreign = false;
  const runDocker = (args) => {
    const name = args[2];
    inspected.push(name);
    if (name === "coffee_observability")
      throw Object.assign(new Error("missing"), {
        stderr: "No such network: coffee_observability",
      });
    return JSON.stringify([
      {
        Name: name,
        Driver: "bridge",
        Internal: true,
        Labels: {
          "com.docker.compose.project": foreign ? "foreign" : "coffee-platform",
          "com.docker.compose.network": name,
        },
      },
    ]);
  };
  assertTelemetryNetworks({
    projectName: "coffee-platform",
    logFiles: [],
    runDocker,
  });
  assert.deepEqual(inspected, ["coffee_observability"]);
  inspected.length = 0;
  assertTelemetryNetworks({
    projectName: "coffee-platform",
    logFiles: [logs[0]],
    runDocker,
  });
  assert.equal(inspected.length, 5);
  foreign = true;
  assert.throws(
    () =>
      assertTelemetryNetworks({
        projectName: "coffee-platform",
        logFiles: [logs[0]],
        runDocker,
      }),
    /network does not belong/u,
  );
});

void test("log discovery selects exactly one running container by project and runtime labels", async () => {
  const id = "b".repeat(64);
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args[0] === "ps") return `${id}\n`;
    return JSON.stringify([
      {
        Id: id,
        LogPath: `/var/lib/docker/containers/${id}/${id}-json.log`,
        State: { Running: true },
        Config: {
          Labels: {
            "com.docker.compose.project": "coffee-proof",
            "com.docker.compose.service": "edge-gateway",
          },
        },
      },
    ]);
  };
  const found = await discoverContainerLogs({
    projectName: "coffee-proof",
    runtimes: ["edge-gateway"],
    runDocker,
  });
  assert.deepEqual(found, [
    {
      service: "edge-gateway",
      containerId: id,
      logPath: `/var/lib/docker/containers/${id}/${id}-json.log`,
    },
  ]);
  assert.ok(calls[0].includes("label=com.docker.compose.project=coffee-proof"));
  assert.ok(calls[0].includes("label=com.docker.compose.service=edge-gateway"));
  assert.ok(calls[0].includes("--no-trunc"));
  assert.deepEqual(
    await discoverContainerLogs({
      projectName: "coffee-proof",
      runtimes: ["edge-nginx"],
      allowMissing: true,
      runDocker: () => "",
    }),
    [],
  );
  await assert.rejects(
    discoverContainerLogs({
      projectName: "coffee-proof",
      runtimes: ["edge-nginx"],
      runDocker: () => "",
    }),
    /exactly one running container/u,
  );
  const partial = await discoverContainerLogs({
    projectName: "coffee-proof",
    runtimes: ["edge-nginx", "edge-gateway"],
    allowMissing: true,
    runDocker: (args) =>
      args[0] === "ps" &&
      args.includes("label=com.docker.compose.service=edge-nginx")
        ? ""
        : runDocker(args),
  });
  assert.deepEqual(partial, found);
  await assert.rejects(
    discoverContainerLogs({
      projectName: "coffee-proof",
      runtimes: ["edge-gateway"],
      allowMissing: true,
      runDocker: () => `${id}\n${id}\n`,
    }),
    /exactly one running container/u,
  );
  await assert.rejects(
    discoverContainerLogs({
      projectName: "coffee-proof",
      runtimes: ["edge-gateway"],
      runDocker: () => `${id}\n${id}\n`,
    }),
    /exactly one running container/u,
  );
  await assert.rejects(
    discoverContainerLogs({
      projectName: "coffee-proof",
      runtimes: ["edge-gateway"],
      runDocker: (args) =>
        args[0] === "ps"
          ? `${id}\n`
          : JSON.stringify([
              {
                Id: id,
                LogPath: "/tmp/not-json.log",
                State: { Running: true },
                Config: {
                  Labels: {
                    "com.docker.compose.project": "other",
                    "com.docker.compose.service": "edge-gateway",
                  },
                },
              },
            ]),
    }),
    /identity does not match/u,
  );
});

void test("collector/admin refs remain optional in the shared encrypted-secret inventory until provisioned", async () => {
  const schema = JSON.parse(
    await readFile(`${REPO_ROOT}/secrets/platform-secrets.schema.json`, "utf8"),
  );
  const telemetry = schema.$defs.environment.properties.telemetry;
  assert.equal(telemetry.required.includes("grafanaAdmin"), false);
  assert.equal(telemetry.properties.grafanaAdmin.$ref, "#/$defs/encrypted");
});

void test("unprovisioned collector and admin credentials fail closed without writing scoped files", async () => {
  const fixtureRoot = await mkdtemp("/dev/shm/coffee-observability-config-");
  const collectorDir = await mkdtemp(
    "/dev/shm/coffee-observability-bootstrap-",
  );
  const adminDir = await mkdtemp("/dev/shm/coffee-grafana-admin-");
  try {
    for (const path of ["config", "platform"])
      await cp(`${REPO_ROOT}/${path}`, `${fixtureRoot}/${path}`, {
        recursive: true,
      });
    await mkdir(`${fixtureRoot}/secrets`, { recursive: true });
    await cp(
      `${REPO_ROOT}/secrets/platform-secrets.schema.json`,
      `${fixtureRoot}/secrets/platform-secrets.schema.json`,
    );
    await cp(`${REPO_ROOT}/.sops.yaml`, `${fixtureRoot}/.sops.yaml`);
    await writeFile(
      `${fixtureRoot}/secrets/platform.secrets.sops.yaml`,
      JSON.stringify(syntheticEncryptedSecrets()),
      "utf8",
    );

    await assert.rejects(
      materializeGrafanaAdminSecret({
        root: fixtureRoot,
        outputDir: adminDir,
        env: {},
      }),
      /CONFIG-SECRET-REF.*grafanaAdmin/u,
    );
    assert.deepEqual(await readdir(collectorDir), []);
    assert.deepEqual(await readdir(adminDir), []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(collectorDir, { recursive: true, force: true });
    await rm(adminDir, { recursive: true, force: true });
  }
});

void test("development Grafana provisioning creates once through SOPS stdin and preserves other ciphertext", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = await mkdtemp("/dev/shm/coffee-grafana-provision-test-");
  const secretPath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const callsPath = join(fixture.bin, "provision-calls.json");
  try {
    const encrypted = JSON.parse(await readFile(secretPath, "utf8"));
    const plain = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    delete encrypted.environments.development.telemetry.grafanaAdmin;
    delete plain.environments.development.telemetry.grafanaAdmin;
    await writeFile(secretPath, JSON.stringify(encrypted));
    await writeFile(fixture.plainPath, JSON.stringify(plain));
    const source = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const plainPath = ${JSON.stringify(fixture.plainPath)};
const callsPath = ${JSON.stringify(callsPath)};
if (args[0] === "set") {
  const value = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!/^[a-f0-9]{64}$/.test(value)) process.exit(1);
  const current = JSON.parse(fs.readFileSync(args[args.length - 2], "utf8"));
  current.environments.development.telemetry.grafanaAdmin = "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]";
  fs.writeFileSync(args[args.length - 2], JSON.stringify(current));
  const plain = JSON.parse(fs.readFileSync(plainPath, "utf8"));
  plain.environments.development.telemetry.grafanaAdmin = value;
  fs.writeFileSync(plainPath, JSON.stringify(plain));
  fs.writeFileSync(callsPath, JSON.stringify({args, credentialInArgs: args.some(arg => arg.includes(value))}));
} else if (args[0] === "--decrypt") process.stdout.write(fs.readFileSync(plainPath));
else process.exit(1);
`;
    await writeFile(join(fixture.bin, "sops"), source, { mode: 0o700 });
    const first = await provisionDevelopmentGrafanaAdmin({
      root: fixture.root,
      outputDir,
      env: fixture.env,
    });
    assert.equal(first.created, true);
    assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal((await stat(first.path)).mode & 0o777, 0o400);
    const credential = (await readFile(first.path, "utf8")).trim();
    assert.match(credential, /^[a-f0-9]{64}$/u);
    const args = JSON.parse(await readFile(callsPath, "utf8"));
    assert.equal(args.credentialInArgs, false);
    assert.ok(args.args.includes("--value-stdin"));
    const after = JSON.parse(await readFile(secretPath, "utf8"));
    delete after.environments.development.telemetry.grafanaAdmin;
    assert.deepEqual(after.environments, encrypted.environments);
    const ciphertextBeforeRepeat = await readFile(secretPath, "utf8");
    const second = await provisionDevelopmentGrafanaAdmin({
      root: fixture.root,
      outputDir,
      env: fixture.env,
    });
    assert.equal(second.created, false);
    assert.equal(await readFile(secretPath, "utf8"), ciphertextBeforeRepeat);
    assert.equal((await readFile(second.path, "utf8")).trim(), credential);
    const configPath = join(fixture.root, "config/platform.yaml");
    const config = parseYaml(await readFile(configPath, "utf8"));
    config.environment = "staging";
    config.telemetry.releaseDigest = `sha256:${"a".repeat(64)}`;
    await writeFile(configPath, dumpYaml(config));
    await assert.rejects(
      provisionDevelopmentGrafanaAdmin({
        root: fixture.root,
        outputDir,
        env: fixture.env,
      }),
      /restricted to development/u,
    );
    assert.equal(await readFile(secretPath, "utf8"), ciphertextBeforeRepeat);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("collector secret admission rejects a missing encrypted credential before invoking SOPS", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = await mkdtemp(
    "/dev/shm/coffee-observability-missing-secret-",
  );
  try {
    const encryptedPath = join(
      fixture.root,
      "secrets/platform.secrets.sops.yaml",
    );
    const encrypted = JSON.parse(await readFile(encryptedPath, "utf8"));
    delete encrypted.environments.development.telemetry.exporterToken;
    await writeFile(encryptedPath, JSON.stringify(encrypted), "utf8");

    await assert.rejects(
      materializeCollectorSecrets({
        root: fixture.root,
        outputDir,
        env: fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-SCHEMA");
        return true;
      },
    );
    await assert.rejects(
      stat(join(fixture.bin, "sops-invoked")),
      (error) => error.code === "ENOENT",
    );
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

void test("collector/admin materializers reject untrusted output directories and symlink targets", async () => {
  const root = await mkdtemp("/dev/shm/coffee-observability-output-");
  const fixture = await createSecretMaterializationFixture();
  const targetDir = join(root, "target");
  const collectorLink = join(root, "collector-link");
  const adminLink = join(root, "admin-link");
  await mkdir(targetDir);
  await symlink(targetDir, collectorLink, "dir");
  await symlink(targetDir, adminLink, "dir");
  try {
    await assert.rejects(
      materializeCollectorSecrets({ outputDir: collectorLink, env: {} }),
      /real directory owned by config-bootstrap/u,
    );
    await assert.rejects(
      materializeGrafanaAdminSecret({ outputDir: adminLink, env: {} }),
      /real directory owned by config-bootstrap/u,
    );

    const collectorDir = join(root, "collector");
    const adminDir = join(root, "admin");
    const collectorTarget = join(root, "collector-victim");
    const adminTarget = join(root, "admin-victim");
    await mkdir(collectorDir);
    await mkdir(adminDir);
    await writeFile(collectorTarget, "collector victim");
    await writeFile(adminTarget, "admin victim");
    await symlink(collectorTarget, join(collectorDir, "collector.json"));
    await symlink(adminTarget, join(adminDir, "admin-secret"));
    await assert.rejects(
      materializeCollectorSecrets({
        root: fixture.root,
        outputDir: collectorDir,
        env: fixture.env,
      }),
      /existing secret output must be a regular file/u,
    );
    await assert.rejects(
      materializeGrafanaAdminSecret({
        root: fixture.root,
        outputDir: adminDir,
        env: fixture.env,
      }),
      /existing secret output must be a regular file/u,
    );
    assert.equal(await readFile(collectorTarget, "utf8"), "collector victim");
    assert.equal(await readFile(adminTarget, "utf8"), "admin victim");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("collector/admin materializers atomically replace owned files with mode 0400 secrets", async () => {
  const fixture = await createSecretMaterializationFixture();
  const collectorDir = await mkdtemp(
    "/dev/shm/coffee-observability-atomic-collector-",
  );
  const adminDir = await mkdtemp("/dev/shm/coffee-observability-atomic-admin-");
  try {
    const collectorPath = join(collectorDir, "collector.json");
    const adminPath = join(adminDir, "admin-secret");
    await writeFile(collectorPath, "stale collector secret", { mode: 0o400 });
    await writeFile(adminPath, "stale admin secret", { mode: 0o400 });
    const oldCollector = await stat(collectorPath);
    const oldAdmin = await stat(adminPath);

    await materializeCollectorSecrets({
      root: fixture.root,
      outputDir: collectorDir,
      env: fixture.env,
    });
    await materializeGrafanaAdminSecret({
      root: fixture.root,
      outputDir: adminDir,
      env: fixture.env,
    });

    const collector = JSON.parse(await readFile(collectorPath, "utf8"));
    assert.deepEqual(collector, { exporterToken: "fixture-secret-value" });
    assert.equal(await readFile(adminPath, "utf8"), "fixture-secret-value\n");
    for (const [path, oldMetadata] of [
      [collectorPath, oldCollector],
      [adminPath, oldAdmin],
    ]) {
      const metadata = await stat(path);
      assert.equal(metadata.mode & 0o777, 0o400);
      assert.equal(metadata.uid, process.getuid());
      assert.notEqual(metadata.ino, oldMetadata.ino);
    }
    assert.deepEqual((await readdir(collectorDir)).sort(), ["collector.json"]);
    assert.deepEqual((await readdir(adminDir)).sort(), ["admin-secret"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(collectorDir, { recursive: true, force: true });
    await rm(adminDir, { recursive: true, force: true });
  }
});

void test("collector/admin materializers reject directories owned by another user", async () => {
  if (process.getuid() === 0) return;
  const before = await stat("/tmp");
  assert.notEqual(before.uid, process.getuid());
  for (const materialize of [
    materializeCollectorSecrets,
    materializeGrafanaAdminSecret,
  ]) {
    await assert.rejects(
      materialize({ outputDir: "/tmp", env: {} }),
      /real directory owned by config-bootstrap/u,
    );
  }
  const after = await stat("/tmp");
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
});

void test("runtime materialization is scope-bound, accepted by runtime loader, and removes only its secret file", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputParent = await mkdtemp(
    "/dev/shm/coffee-observability-runtime-scope-",
  );
  const outputDir = join(outputParent, "secrets");
  const runtime = "catalog-service";
  const secretPath = join(outputDir, "coffee-platform.yaml");
  const siblingPath = join(outputDir, "keep.txt");
  try {
    const runtimeConfig = await loadRuntimeConfig({
      root: fixture.root,
      runtime,
      env: fixture.env,
    });
    const platformConfig = parseYaml(
      await readFile(join(fixture.root, "config/platform.yaml"), "utf8"),
      { json: true },
    );
    const materialized = await materializeRuntimeSecrets({
      root: fixture.root,
      runtime,
      outputDir,
      env: fixture.env,
    });
    assert.equal(materialized.path, secretPath);
    assert.deepEqual(materialized.secretRefs, runtimeConfig.secretRefs);

    const directoryMetadata = await stat(outputDir);
    const fileMetadata = await stat(secretPath);
    await writeFile(siblingPath, "fixture sibling");
    assert.equal(directoryMetadata.uid, process.getuid());
    assert.equal(directoryMetadata.mode & 0o777, 0o700);
    assert.equal(fileMetadata.uid, process.getuid());
    assert.equal(fileMetadata.mode & 0o777, 0o400);

    const document = parseYaml(await readFile(secretPath, "utf8"), {
      json: true,
    });
    assert.deepEqual(Object.keys(document).sort(), [
      "environment",
      "runtime",
      "schemaVersion",
      "secrets",
    ]);
    assert.equal(document.environment, platformConfig.environment);
    assert.equal(document.runtime, runtime);
    assertScopedSecrets(
      document,
      runtime,
      platformConfig.environment,
      runtimeConfig.secretRefs,
    );
    const valueAt = (root, ref) =>
      ref
        .split(".")
        .reduce(
          (value, key) =>
            value !== null && typeof value === "object"
              ? value[key]
              : undefined,
          root,
        );
    const flatten = (value, prefix = "") => {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return [prefix];
      return Object.entries(value).flatMap(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return child !== null &&
          typeof child === "object" &&
          !Array.isArray(child)
          ? flatten(child, path)
          : [path];
      });
    };
    const refs = [
      ...runtimeConfig.secretRefs,
      ...(runtimeConfig.optionalSecretRefs ?? []),
    ];
    const expectedPaths = refs
      .flatMap((ref) => {
        const value = valueAt(document.secrets, ref);
        return value === undefined ? [] : flatten(value, ref);
      })
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      flatten(document.secrets).sort((left, right) =>
        left.localeCompare(right),
      ),
      expectedPaths,
    );
    assert.ok(
      valueAt(document.secrets, "bootstrap.postgresAdminPassword") ===
        undefined,
    );
    assert.ok(
      valueAt(document.secrets, "telemetry.grafanaAdmin") === undefined,
    );

    const wrongRuntime = { ...document, runtime: "orders-service" };
    assert.throws(
      () =>
        assertScopedSecrets(
          wrongRuntime,
          runtime,
          platformConfig.environment,
          runtimeConfig.secretRefs,
        ),
      /identity mismatch/u,
    );
    await removeMaterializedSecrets(secretPath);
    await removeMaterializedSecrets(secretPath);
    await assert.rejects(stat(secretPath), (error) => error.code === "ENOENT");
    assert.equal(await readFile(siblingPath, "utf8"), "fixture sibling");
    await assert.rejects(removeMaterializedSecrets(outputDir), (error) => {
      assert.equal(error.code, "EISDIR");
      return true;
    });
    assert.equal((await stat(outputDir)).isDirectory(), true);

    await symlink(siblingPath, secretPath);
    let symlinkError;
    try {
      await materializeRuntimeSecrets({
        root: fixture.root,
        runtime,
        outputDir,
        env: fixture.env,
      });
    } catch (error) {
      symlinkError = error;
    }
    assert.equal(await readFile(siblingPath, "utf8"), "fixture sibling");
    assert.equal(symlinkError?.ruleId, "CONFIG-SECRET-OUTPUT");

    await rm(secretPath);
    const linkedOutputDir = join(outputParent, "linked-secrets");
    await symlink(outputDir, linkedOutputDir);
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime,
        outputDir: linkedOutputDir,
        env: fixture.env,
      }),
      (error) => error.ruleId === "CONFIG-SECRET-OUTPUT",
    );
    await assert.rejects(stat(secretPath), (error) => error.code === "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(outputParent, { recursive: true, force: true });
  }
});

void test("runtime materialization omits absent optional edge credentials", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = await mkdtemp("/dev/shm/coffee-runtime-optional-secret-");
  const outputPath = join(outputDir, "coffee-platform.yaml");
  try {
    const materialized = await materializeRuntimeSecrets({
      root: fixture.root,
      runtime: "edge-gateway",
      outputDir,
      env: fixture.env,
    });
    const document = parseYaml(await readFile(outputPath, "utf8"), {
      json: true,
    });

    assert.equal(materialized.runtime, "edge-gateway");
    assert.equal(materialized.secretRefs.includes("edge.tlsCaBundle"), false);
    assert.equal(document.secrets.edge.tlsCaBundle, undefined);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o400);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

void test("runtime materialization rejects locator overrides before SOPS and malformed plaintext before creating a file", async () => {
  const fixture = await createSecretMaterializationFixture();
  const secretPath = join(
    fixture.root,
    "missing-output",
    "coffee-platform.yaml",
  );
  try {
    const outputDir = join(fixture.root, "missing-output");
    for (const runtime of [undefined, "", 123]) {
      await assert.rejects(
        loadRuntimeConfig({ root: fixture.root, runtime, env: fixture.env }),
        { ruleId: "CONFIG-RUNTIME" },
      );
      await assert.rejects(
        materializeRuntimeSecrets({
          root: fixture.root,
          runtime,
          outputDir,
          env: fixture.env,
        }),
        { ruleId: "CONFIG-RUNTIME" },
      );
    }
    const configEnv = {
      ...fixture.env,
      COFFEE_CONFIG_FILE: join(fixture.root, "config/platform.yaml"),
    };
    const service = await loadRuntimeConfig({
      root: fixture.root,
      runtime: "catalog-service",
      env: configEnv,
    });
    assert.ok(service);
    await assert.rejects(
      loadRuntimeConfig({
        root: fixture.root,
        runtime: "unknown-runtime",
        env: configEnv,
      }),
      { ruleId: "CONFIG-RUNTIME" },
    );
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "unknown-runtime",
        outputDir,
        env: configEnv,
      }),
      { ruleId: "CONFIG-RUNTIME" },
    );
    assert.equal((await readdir(fixture.bin)).includes("sops-invoked"), false);
    await assert.rejects(stat(secretPath), (error) => error.code === "ENOENT");
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "catalog-service",
        env: { ...fixture.env, COFFEE_DATABASE_PASSWORD: "synthetic-canary" },
      }),
      /CONFIG-ENV-OVERRIDE/u,
    );
    assert.equal((await readdir(fixture.bin)).includes("sops-invoked"), false);
    await assert.rejects(stat(secretPath), (error) => error.code === "ENOENT");

    const decrypted = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    delete decrypted.environments.development.telemetry.exporterToken;
    await writeFile(fixture.plainPath, JSON.stringify(decrypted), "utf8");
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "catalog-service",
        outputDir: join(fixture.root, "missing-output"),
        env: fixture.env,
      }),
      /CONFIG-SOPS-PLAINTEXT.*decrypted secret is missing/u,
    );
    assert.equal((await readdir(fixture.bin)).includes("sops-invoked"), true);
    await assert.rejects(stat(secretPath), (error) => error.code === "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("runtime materialization fails closed on SOPS errors and malformed decrypted metadata", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = join(fixture.root, "guarded-output");
  const outputPath = join(outputDir, "coffee-platform.yaml");
  const sopsPath = join(fixture.bin, "sops");
  const canary = "private-bootstrap-canary-7e2d";
  try {
    await writeFile(
      sopsPath,
      `#!/bin/sh\n: > '${join(fixture.bin, "sops-failed")}'\nprintf '%s' '${canary}'\nprintf 'synthetic SOPS failure' >&2\nexit 23\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "catalog-service",
        outputDir,
        env: fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-SOPS-MAC");
        assert.doesNotMatch(error.message, new RegExp(canary, "u"));
        return true;
      },
    );
    assert.equal((await readdir(fixture.bin)).includes("sops-failed"), true);
    await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");

    await writeFile(
      sopsPath,
      `#!/bin/sh\n: > '${join(fixture.bin, "sops-invoked")}'\ncat '${fixture.plainPath}'\n`,
      { mode: 0o700 },
    );
    const malformed = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    malformed.schemaVersion = 99;
    malformed.privateCanary = canary;
    await writeFile(fixture.plainPath, JSON.stringify(malformed), "utf8");
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "catalog-service",
        outputDir,
        env: fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-SOPS-PLAINTEXT");
        assert.doesNotMatch(error.message, new RegExp(canary, "u"));
        return true;
      },
    );
    await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");

    malformed.schemaVersion = 1;
    delete malformed.environments.staging;
    await writeFile(fixture.plainPath, JSON.stringify(malformed), "utf8");
    await assert.rejects(
      materializeRuntimeSecrets({
        root: fixture.root,
        runtime: "catalog-service",
        outputDir,
        env: fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-SOPS-PLAINTEXT");
        assert.match(
          error.message,
          /staging: decrypted environment is missing/u,
        );
        assert.doesNotMatch(error.message, new RegExp(canary, "u"));
        return true;
      },
    );
    await assert.rejects(stat(outputPath), (error) => error.code === "ENOENT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G16 materializes only run-scoped admin and runtime secret files with owner-only permissions", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = await mkdtemp("/dev/shm/coffee-g16-secrets-");
  const runId = "20261024T185000Z-abc1234";
  try {
    const result = await materializeAromaSandboxSecrets({
      root: fixture.root,
      runId,
      outputDir,
      env: fixture.env,
    });
    const platformConfig = parseYaml(
      await readFile(join(fixture.root, "config/platform.yaml"), "utf8"),
      { json: true },
    );
    const runtimes = [
      "orders-aroma-preparation",
      "aroma-convergence",
      "catalog-supplier-sync",
      "catalog-activation-worker",
      "catalog-service",
      "aroma-gateway",
    ];
    assert.deepEqual(
      Object.keys(result.runtimes).sort((left, right) =>
        left.localeCompare(right),
      ),
      [...runtimes].sort((left, right) => left.localeCompare(right)),
    );
    assert.equal(
      result.adminPasswordFile,
      join(outputDir, "postgres-admin-password"),
    );
    assert.deepEqual(
      (await readdir(outputDir)).sort((left, right) =>
        left.localeCompare(right),
      ),
      [...runtimes, "postgres-admin-password"].sort((left, right) =>
        left.localeCompare(right),
      ),
    );

    const adminMetadata = await stat(result.adminPasswordFile);
    assert.equal(adminMetadata.uid, process.getuid());
    assert.equal(adminMetadata.mode & 0o777, 0o400);
    for (const runtime of runtimes) {
      const path = result.runtimes[runtime].scopedSecretRef;
      assert.equal(path, join(outputDir, runtime, "coffee-platform.yaml"));
      const directoryMetadata = await stat(join(outputDir, runtime));
      const fileMetadata = await stat(path);
      assert.equal(directoryMetadata.uid, process.getuid());
      assert.equal(directoryMetadata.mode & 0o777, 0o700);
      assert.equal(fileMetadata.uid, process.getuid());
      assert.equal(fileMetadata.mode & 0o777, 0o400);
      const document = parseYaml(await readFile(path, "utf8"), { json: true });
      const runtimeConfig = await loadRuntimeConfig({
        root: fixture.root,
        runtime,
        env: fixture.env,
      });
      assertScopedSecrets(
        document,
        runtime,
        platformConfig.environment,
        runtimeConfig.secretRefs,
      );
      assert.ok(
        valueAtPath(document.secrets, "bootstrap.postgresAdminPassword") ===
          undefined,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

void test("G16 database provisioning enforces the pinned server and cleans up only its created run databases", async (t) => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = await mkdtemp("/dev/shm/coffee-g16-secrets-");
  const runId = "20261024T185100Z-def5678";
  const serverIdentity = "7123456789012345678";
  const toolchain = JSON.parse(
    await readFile(
      join(fixture.root, "config/toolchain-versions.json"),
      "utf8",
    ),
  );
  const ownership = JSON.parse(
    await readFile(
      join(fixture.root, "config/database-ownership.json"),
      "utf8",
    ),
  );
  const roleMap = JSON.parse(
    await readFile(join(fixture.root, "config/database-role-map.json"), "utf8"),
  );
  const decrypted = JSON.parse(await readFile(fixture.plainPath, "utf8"));
  const environment = decrypted.environments.development;
  const adminPassword = "fixture-admin-canary";
  setValueAtPath(environment, "bootstrap.postgresAdminPassword", adminPassword);

  const expectedOwners = ["catalog", "orders", "integration"];
  const expectedDatabases = Object.fromEntries(
    expectedOwners.map((owner) => [
      owner,
      `coffee_verify_${runId.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}_${owner}`,
    ]),
  );
  const expectedPasswords = new Map();
  for (const owner of expectedOwners) {
    const ownedDatabase = ownership.databases.find(
      (entry) => entry.owner === owner,
    );
    const database = roleMap.databases.find(
      (entry) => entry.name === ownedDatabase.name,
    );
    for (const runtimeRole of database.runtimeRoles) {
      const claim = ownership.runtimeClaims.find(
        (entry) => entry.runtime === runtimeRole.runtime,
      );
      const credential = valueAtPath(environment, claim.secretRef);
      credential.username = runtimeRole.role;
      credential.password = `fixture-${runtimeRole.runtime}-credential`;
      expectedPasswords.set(runtimeRole.role, credential.password);
    }
  }
  const firstRuntime = roleMap.databases.find(
    (database) => database.name === "coffee_platform_catalog",
  ).runtimeRoles[0];
  const firstRuntimeClaim = ownership.runtimeClaims.find(
    (claim) => claim.runtime === firstRuntime.runtime,
  );
  const firstRuntimeCredential = valueAtPath(
    environment,
    firstRuntimeClaim.secretRef,
  );
  const validFirstRuntimeCredential = { ...firstRuntimeCredential };
  await writeFile(fixture.plainPath, JSON.stringify(decrypted), "utf8");

  const fake = {
    serverIdentity,
    serverVersion: toolchain.postgresql,
    wrongServerVersion: false,
    failCreateDatabase: null,
    failOwnerDatabase: null,
    failEnd: false,
    endCalls: 0,
    connections: [],
    createAttempts: [],
    createdDatabases: [],
    droppedDatabases: [],
    runtimeCredentialSql: [],
  };
  t.mock.method(Client.prototype, "connect", async function () {
    fake.connections.push({ database: this.database, user: this.user });
  });
  t.mock.method(Client.prototype, "end", async function () {
    fake.endCalls += 1;
    if (fake.failEnd) throw new Error("synthetic end failure");
  });
  t.mock.method(Client.prototype, "query", async function (sql) {
    if (this.database === fake.failOwnerDatabase)
      throw new Error("synthetic owner grant failure");
    if (sql.includes("SELECT current_database()")) {
      return {
        rows: [
          {
            current_database: this.database,
            current_user: "postgres",
            server_version: fake.wrongServerVersion
              ? "16.11"
              : fake.serverVersion,
            is_superuser: true,
            system_identifier: fake.serverIdentity,
          },
        ],
      };
    }
    const createDatabase = sql.match(
      /^CREATE DATABASE "([a-z0-9_]+)" OWNER "([a-z0-9_]+)" TEMPLATE template0$/u,
    );
    if (createDatabase) {
      const [, databaseName, ownerRole] = createDatabase;
      fake.createAttempts.push(databaseName);
      if (databaseName === fake.failCreateDatabase)
        throw new Error("synthetic create failure");
      fake.createdDatabases.push({ databaseName, ownerRole });
      return { rows: [] };
    }
    const dropDatabase = sql.match(/^DROP DATABASE IF EXISTS "([a-z0-9_]+)"$/u);
    if (dropDatabase) {
      fake.droppedDatabases.push(dropDatabase[1]);
      return { rows: [] };
    }
    const runtimeRole = sql.match(
      /CREATE ROLE "([a-z0-9_]+)" LOGIN NOSUPERUSER/u,
    )?.[1];
    if (runtimeRole && expectedPasswords.has(runtimeRole)) {
      fake.runtimeCredentialSql.push({
        role: runtimeRole,
        matchesClaim: sql.includes(
          `PASSWORD '${expectedPasswords.get(runtimeRole)}'`,
        ),
      });
    }
    return { rows: [] };
  });

  const provision = () =>
    provisionAromaSandboxDatabases({
      root: fixture.root,
      runId,
      host: "127.0.0.1",
      port: 55432,
      outputDir,
      env: fixture.env,
    });
  const resetObservations = () => {
    fake.connections.length = 0;
    fake.createAttempts.length = 0;
    fake.createdDatabases.length = 0;
    fake.droppedDatabases.length = 0;
    fake.runtimeCredentialSql.length = 0;
    fake.endCalls = 0;
  };
  try {
    const provisionArgs = {
      root: fixture.root,
      runId,
      host: "127.0.0.1",
      port: 55432,
      outputDir,
      env: fixture.env,
    };
    for (const [override, ruleId] of [
      [{ host: "192.0.2.1" }, "CONFIG-G16-ENDPOINT"],
      [{ port: 0 }, "CONFIG-G16-ENDPOINT"],
      [{ port: 65536 }, "CONFIG-G16-ENDPOINT"],
      [{ port: 1.5 }, "CONFIG-G16-ENDPOINT"],
      [{ outputDir: "/tmp/foreign" }, "CONFIG-G16-SECRET-PATH"],
    ]) {
      await assert.rejects(
        provisionAromaSandboxDatabases({ ...provisionArgs, ...override }),
        { ruleId },
      );
      assert.deepEqual(fake.connections, []);
      assert.deepEqual(await readdir(outputDir), []);
    }
    const configPath = join(fixture.root, "config/platform.yaml");
    const configBytes = await readFile(configPath);
    const config = parseYaml(configBytes.toString("utf8"));
    config.environment = "production";
    config.telemetry.releaseDigest = `sha256:${"a".repeat(64)}`;
    await writeFile(configPath, dumpYaml(config));
    try {
      await assert.rejects(provision(), { ruleId: "CONFIG-G16-ENVIRONMENT" });
      assert.deepEqual(fake.connections, []);
    } finally {
      await writeFile(configPath, configBytes);
    }
    const roleMapPath = join(fixture.root, "config/database-role-map.json");
    const roleMapBytes = await readFile(roleMapPath);
    try {
      for (const malformedMap of [
        { ...roleMap, schemaVersion: 1 },
        { ...roleMap, authorityRef: "foreign" },
        { ...roleMap, databases: [] },
      ]) {
        await writeFile(roleMapPath, JSON.stringify(malformedMap));
        await assert.rejects(provision(), { ruleId: "CONFIG-G16-ROLE-MAP" });
        assert.deepEqual(fake.connections, []);
        assert.deepEqual(fake.createAttempts, []);
      }
    } finally {
      await writeFile(roleMapPath, roleMapBytes);
    }
    for (const [name, credential] of [
      [
        "noncanonical runtime username",
        {
          ...validFirstRuntimeCredential,
          username: "coffee_unmapped_runtime",
        },
      ],
      [
        "admin password reused by runtime",
        { ...validFirstRuntimeCredential, password: adminPassword },
      ],
    ]) {
      Object.assign(firstRuntimeCredential, credential);
      await writeFile(fixture.plainPath, JSON.stringify(decrypted), "utf8");
      resetObservations();
      await assert.rejects(provision(), (error) => {
        assert.equal(error.ruleId, "CONFIG-G16-RUNTIME-SECRET", name);
        return true;
      });
      assert.deepEqual(fake.connections, [], name);
      assert.deepEqual(fake.createAttempts, [], name);
      assert.deepEqual(fake.droppedDatabases, [], name);
    }
    Object.assign(firstRuntimeCredential, validFirstRuntimeCredential);
    await writeFile(fixture.plainPath, JSON.stringify(decrypted), "utf8");
    resetObservations();

    const provisioned = await provision();
    assert.equal(provisioned.systemIdentifier, serverIdentity);
    assert.deepEqual(
      Object.keys(provisioned.databases).sort((left, right) =>
        left.localeCompare(right),
      ),
      [...expectedOwners].sort((left, right) => left.localeCompare(right)),
    );
    assert.deepEqual(
      fake.createdDatabases.map((entry) => entry.databaseName),
      expectedOwners.map((owner) => expectedDatabases[owner]),
    );
    assert.deepEqual(
      fake.runtimeCredentialSql
        .map((entry) => entry.role)
        .sort((left, right) => left.localeCompare(right)),
      [...expectedPasswords.keys()].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
    assert.ok(fake.runtimeCredentialSql.every((entry) => entry.matchesClaim));
    assert.deepEqual(fake.droppedDatabases, []);
    for (const owner of expectedOwners) {
      const sourceDatabase = `coffee_platform_${owner}`;
      const canonicalDatabase = roleMap.databases.find(
        (entry) => entry.name === sourceDatabase,
      );
      assert.equal(
        provisioned.databases[owner].migrator.username,
        canonicalDatabase.migratorRole,
      );
      assert.deepEqual(
        provisioned.databases[owner].runtimes
          .map((entry) => entry.runtime)
          .sort((left, right) => left.localeCompare(right)),
        canonicalDatabase.runtimeRoles
          .map((entry) => entry.runtime)
          .sort((left, right) => left.localeCompare(right)),
      );
    }

    resetObservations();
    fake.wrongServerVersion = true;
    await assert.rejects(provision(), /CONFIG-G16-SERVER-IDENTITY/u);
    assert.deepEqual(fake.createAttempts, []);
    assert.deepEqual(fake.droppedDatabases, []);

    resetObservations();
    fake.wrongServerVersion = false;
    fake.failCreateDatabase = expectedDatabases.orders;
    fake.failEnd = true;
    await assert.rejects(provision(), (error) => {
      assert.equal(error.message, "synthetic create failure");
      assert.doesNotMatch(error.message, /synthetic end failure/u);
      return true;
    });
    assert.deepEqual(fake.createAttempts, [
      expectedDatabases.catalog,
      expectedDatabases.orders,
    ]);
    assert.deepEqual(
      fake.createdDatabases.map((entry) => entry.databaseName),
      [expectedDatabases.catalog],
    );
    assert.deepEqual(fake.droppedDatabases, [expectedDatabases.catalog]);
    assert.equal(
      fake.endCalls,
      1,
      "admin close failure must not prevent rollback or replace the setup error",
    );
    assert.equal(
      fake.droppedDatabases.some(
        (name) => !Object.values(expectedDatabases).includes(name),
      ),
      false,
    );

    resetObservations();
    fake.failCreateDatabase = null;
    fake.failOwnerDatabase = expectedDatabases.catalog;
    await assert.rejects(provision(), (error) => {
      assert.equal(error.message, "synthetic owner grant failure");
      return true;
    });
    assert.deepEqual(
      fake.createdDatabases.map((entry) => entry.databaseName),
      expectedOwners.map((owner) => expectedDatabases[owner]),
    );
    assert.deepEqual(
      fake.droppedDatabases,
      [...expectedOwners].reverse().map((owner) => expectedDatabases[owner]),
    );
    assert.equal(
      fake.endCalls,
      2,
      "owner and admin close failures must preserve grant failure and cleanup",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  }
});

void test("config-bootstrap validates the synthetic encrypted config without decrypting it and rejects locator overrides", async () => {
  const fixture = await createSecretMaterializationFixture();
  const migrationDir = join(fixture.root, "apps/pricing-service/migrations");
  await mkdir(migrationDir, { recursive: true });
  await cp(
    join(
      REPO_ROOT,
      "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql",
    ),
    join(migrationDir, "0001_create_pricing_policy_versions.sql"),
  );
  const encryptedPath = join(
    fixture.root,
    "secrets/platform.secrets.sops.yaml",
  );
  const encrypted = JSON.parse(await readFile(encryptedPath, "utf8"));
  const fixtureKey = "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]";
  const platform = parseYaml(
    await readFile(join(fixture.root, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const setFixtureRef = (environment, ref, value) => {
    const parts = ref.split(".");
    let current = environment;
    for (const part of parts.slice(0, -1)) current = current[part] ??= {};
    current[parts.at(-1)] = value;
  };
  for (const environment of Object.values(encrypted.environments)) {
    for (const service of Object.values(platform.services)) {
      for (const ref of service.secretRefs) {
        if (valueAtPath(environment, ref) !== undefined) continue;
        if (ref.startsWith("security.serviceVerificationKeys.")) {
          setFixtureRef(environment, ref, {
            active: fixtureKey,
            previous: fixtureKey,
          });
        } else {
          setFixtureRef(environment, ref, fixtureKey);
        }
      }
    }
  }
  await writeFile(encryptedPath, JSON.stringify(encrypted), "utf8");
  const previous = new Map(
    Object.keys(process.env)
      .filter((key) => key.startsWith("COFFEE_") || key.startsWith("SOPS_"))
      .map((key) => [key, process.env[key]]),
  );
  const previousPath = process.env.PATH;
  try {
    for (const key of previous.keys()) delete process.env[key];
    process.env.PATH = fixture.env.PATH;
    assert.deepEqual(await checkBootstrap(fixture.root), {
      role: "config-bootstrap",
      lifecycle: "init-only",
      listener: false,
      longRunning: false,
    });
    assert.equal((await readdir(fixture.bin)).includes("sops-invoked"), false);

    process.env.COFFEE_DATABASE_PASSWORD = "synthetic-locator-canary";
    await assert.rejects(checkBootstrap(fixture.root), /CONFIG-ENV-OVERRIDE/u);
    assert.equal((await readdir(fixture.bin)).includes("sops-invoked"), false);
  } finally {
    delete process.env.COFFEE_DATABASE_PASSWORD;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    for (const [key, value] of previous) process.env[key] = value;
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 canonical target probe is read-only and reports only bounded identity and role inventory", async (t) => {
  const launch = await createMigrationLaunchFixture();
  const {
    fixture,
    runId,
    evidenceDir,
    contextPath,
    candidateSha,
    adminPassword,
  } = launch;
  const probeCalls = [];
  const connections = [];
  const roleRows = [];
  try {
    t.mock.method(Client.prototype, "connect", async function () {
      connections.push({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
        password: this.password,
      });
    });
    const originalContextBytes = await readFile(contextPath);
    const roleMapPath = join(fixture.root, "config/database-role-map.json");
    const originalRoleMapBytes = await readFile(roleMapPath);
    const expectRejectedBeforeTrustedOperations = async () => {
      await assert.rejects(
        probeCanonicalMigrationTarget({
          root: fixture.root,
          contextPath,
          env: fixture.env,
        }),
        /CONFIG-G08-CHECKOUT/u,
      );
      assert.equal(
        (await readdir(fixture.bin)).includes("sops-invoked"),
        false,
      );
      assert.equal(connections.length, 0);
    };

    await writeFile(
      roleMapPath,
      Buffer.concat([originalRoleMapBytes, Buffer.from("\n")]),
    );
    await expectRejectedBeforeTrustedOperations();
    await writeFile(roleMapPath, originalRoleMapBytes);

    const configPath = join(fixture.root, "config/platform.yaml");
    const originalConfigBytes = await readFile(configPath);
    const dirtyConfigBytes = Buffer.concat([
      originalConfigBytes,
      Buffer.from("\n# G08 dirty checkout fixture\n"),
    ]);
    await writeFile(configPath, dirtyConfigBytes);
    await chmod(contextPath, 0o600);
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        candidateSha,
        baseConfigSha256: createHash("sha256")
          .update(dirtyConfigBytes)
          .digest("hex"),
        sourceRepoRoot: REPO_ROOT,
        evidenceDir,
        checkoutDir: fixture.root,
      }),
    );
    await chmod(contextPath, 0o400);
    await expectRejectedBeforeTrustedOperations();
    await writeFile(configPath, originalConfigBytes);
    await chmod(contextPath, 0o600);
    await writeFile(contextPath, originalContextBytes);
    await chmod(contextPath, 0o400);

    await writeFile(
      roleMapPath,
      Buffer.concat([originalRoleMapBytes, Buffer.from("\n")]),
    );
    execFileSync("git", ["add", "config/database-role-map.json"], {
      cwd: fixture.root,
    });
    await expectRejectedBeforeTrustedOperations();
    execFileSync(
      "git",
      [
        "restore",
        "--source=HEAD",
        "--staged",
        "--worktree",
        "--",
        "config/database-role-map.json",
      ],
      { cwd: fixture.root },
    );

    execFileSync(
      "git",
      ["update-index", "--skip-worktree", "config/database-role-map.json"],
      { cwd: fixture.root },
    );
    await expectRejectedBeforeTrustedOperations();
    execFileSync(
      "git",
      ["update-index", "--no-skip-worktree", "config/database-role-map.json"],
      { cwd: fixture.root },
    );

    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async function (sql, values) {
      probeCalls.push({ sql, values });
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: "7613370342949990434",
            },
          ],
        };
      if (sql.startsWith("SELECT rolname,")) return { rows: roleRows };
      assert.fail(`unexpected G08 probe query: ${sql}`);
    });

    const absent = await probeCanonicalMigrationTarget({
      root: fixture.root,
      contextPath,
      env: fixture.env,
    });
    assert.equal(absent.stage, "readonly-probe");
    assert.equal(absent.runId, runId);
    assert.equal(absent.candidateSha, candidateSha);
    assert.deepEqual(absent.postgres, {
      host: "coffee_postgres",
      port: 5432,
      version: "17.11",
      systemIdentifier: "7613370342949990434",
      database: "postgres",
      user: "coffeeuser",
    });
    assert.deepEqual(absent.roleInventory, {
      expectedCount: 15,
      existing: [],
      allAbsent: true,
    });
    assert.equal(JSON.stringify(absent).includes(adminPassword), false);
    assert.deepEqual(connections[0], {
      host: "coffee_postgres",
      port: 5432,
      database: "postgres",
      user: "coffeeuser",
      password: adminPassword,
    });
    assert.equal(probeCalls.length, 2);
    assert.equal(
      probeCalls.some(({ sql }) => /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)),
      false,
    );

    roleRows.push({
      rolname: "coffee_customer_migrator",
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 20,
    });
    const existing = await probeCanonicalMigrationTarget({
      root: fixture.root,
      contextPath,
      env: fixture.env,
    });
    assert.equal(existing.roleInventory.allAbsent, false);
    assert.equal(existing.roleInventory.existing.length, 1);
    assert.equal(
      existing.roleInventory.existing[0].role,
      "coffee_customer_migrator",
    );
    assert.equal(probeCalls.length, 4);
    assert.equal(
      probeCalls.some(({ sql }) => /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)),
      false,
    );

    const canonicalRole = { ...roleRows[0] };
    roleRows.push({ ...canonicalRole });
    await assert.rejects(
      probeCanonicalMigrationTarget({
        root: fixture.root,
        contextPath,
        env: fixture.env,
      }),
      (error) =>
        error.ruleId === "CONFIG-G08-PROBE" &&
        error.facts.stage === "identity" &&
        error.facts.failureCategory === "invalid_response",
    );
    roleRows.splice(0, roleRows.length, {
      ...canonicalRole,
      rolname: "coffee_foreign_migrator",
    });
    await assert.rejects(
      probeCanonicalMigrationTarget({
        root: fixture.root,
        contextPath,
        env: fixture.env,
      }),
      (error) =>
        error.ruleId === "CONFIG-G08-PROBE" &&
        error.facts.stage === "identity" &&
        error.facts.failureCategory === "invalid_response",
    );
    assert.equal(
      probeCalls.some(({ sql }) => /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)),
      false,
      "duplicate and foreign role rows must remain a read-only rejection",
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 canonical target probe returns finite sanitized database failure facts", async (t) => {
  const { fixture, evidenceDir, contextPath } =
    await createMigrationLaunchFixture();
  const credentialCanary = "synthetic-pg-password-detail-canary";
  try {
    t.mock.method(Client.prototype, "connect", async () => {
      throw Object.assign(new Error(credentialCanary), {
        code: "28P01",
        detail: credentialCanary,
      });
    });
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async () => {
      assert.fail("G08 connect failure must stop before SQL");
    });

    await assert.rejects(
      probeCanonicalMigrationTarget({
        root: fixture.root,
        contextPath,
        env: fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-PROBE");
        assert.deepEqual(error.facts, {
          stage: "connect",
          failureCategory: "authentication",
          sqlState: "28P01",
        });
        assert.equal(JSON.stringify(error).includes(credentialCanary), false);
        assert.equal(error.message.includes(credentialCanary), false);
        return true;
      },
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 canonical target probe sanitizes identity and role-inventory query failures", async (t) => {
  const canary = "synthetic-query-detail-canary";
  for (const scenario of [
    {
      name: "identity",
      fails: (sql) => sql.includes("pg_control_system()"),
      code: "42501",
      expected: {
        stage: "identity",
        failureCategory: "authorization",
        sqlState: "42501",
      },
    },
    {
      name: "role-inventory",
      fails: (sql) => sql.startsWith("SELECT rolname,"),
      code: "ENOTFOUND",
      expected: {
        stage: "role-inventory",
        failureCategory: "dns",
      },
    },
    {
      name: "connection-close",
      fails: () => false,
      closeFailure: true,
      code: "ETIMEDOUT",
      expected: {
        stage: "close",
        failureCategory: "timeout",
      },
    },
  ])
    await t.test(scenario.name, async (t) => {
      const { fixture, evidenceDir, contextPath } =
        await createMigrationLaunchFixture();
      let endCalls = 0;
      try {
        t.mock.method(Client.prototype, "connect", async () => {});
        t.mock.method(Client.prototype, "end", async () => {
          endCalls += 1;
          if (scenario.closeFailure)
            throw Object.assign(new Error(canary), {
              code: scenario.code,
              detail: canary,
            });
        });
        t.mock.method(Client.prototype, "query", async (sql) => {
          if (scenario.fails(sql))
            throw Object.assign(new Error(canary), {
              code: scenario.code,
              detail: canary,
            });
          if (sql.includes("pg_control_system()"))
            return {
              rows: [
                {
                  current_database: "postgres",
                  current_user: "coffeeuser",
                  server_version: "17.11 (fixture)",
                  server_version_num: "170011",
                  is_superuser: true,
                  system_identifier: "7613370342949990434",
                },
              ],
            };
          if (sql.startsWith("SELECT rolname,")) return { rows: [] };
          assert.fail(`unexpected G08 ${scenario.name} query`);
        });

        await assert.rejects(
          probeCanonicalMigrationTarget({
            root: fixture.root,
            contextPath,
            env: fixture.env,
          }),
          (error) => {
            assert.equal(error.ruleId, "CONFIG-G08-PROBE");
            assert.deepEqual(error.facts, scenario.expected);
            assert.equal(error.message.includes(canary), false);
            assert.equal(JSON.stringify(error.facts).includes(canary), false);
            return true;
          },
        );
        assert.equal(endCalls, 1);
      } finally {
        await rm(evidenceDir, { recursive: true, force: true });
        await rm(fixture.root, { recursive: true, force: true });
        await rm(fixture.bin, { recursive: true, force: true });
      }
    });
});

void test("G08 admin credential sync uses the configured user and does not rewrite a valid SOPS credential", async (t) => {
  const { fixture, evidenceDir, contextPath, adminPassword } =
    await createMigrationLaunchFixture();
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const bundleBefore = await readFile(bundlePath);
  const connections = [];
  const queries = [];
  try {
    await installFakeMigrationSops(fixture);
    await installFakeMigrationAdminDocker(fixture);
    t.mock.method(Client.prototype, "connect", async function () {
      connections.push({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
        password: this.password,
      });
    });
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async function (sql) {
      queries.push(sql);
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: "7613370342949990434",
            },
          ],
        };
      if (sql.startsWith("SELECT rolname,")) return { rows: [] };
      assert.fail("G08 admin verification must remain read-only");
    });

    const result = await synchronizeMigrationAdminCredential({
      root: fixture.root,
      contextPath,
      env: fixture.env,
      expectedSystemIdentifier: "7613370342949990434",
    });
    assert.equal(result.stage, "admin-credential-verified");
    assert.equal(result.credentialSource, "existing-sops");
    assert.equal(result.roleInventory.allAbsent, true);
    assert.deepEqual(connections, [
      {
        host: "coffee_postgres",
        port: 5432,
        database: "postgres",
        user: "coffeeuser",
        password: adminPassword,
      },
    ]);
    assert.deepEqual(await readFile(bundlePath), bundleBefore);
    assert.equal(
      await readFile(join(fixture.bin, "g08-docker-calls.json"), "utf8"),
      "",
    );
    assert.equal(
      queries.some((sql) => /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)),
      false,
    );
    assert.equal(JSON.stringify(result).includes(adminPassword), false);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 admin credential sync falls back only on exact 28P01 and persists only the encrypted admin field", async (t) => {
  const { fixture, evidenceDir, contextPath, adminPassword } =
    await createMigrationLaunchFixture();
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const initialBundle = await readFile(bundlePath);
  const initialPlain = JSON.parse(await readFile(fixture.plainPath, "utf8"));
  const sourcePassword = "synthetic-g08-source-password-canary";
  const connections = [];
  const queries = [];
  let connectCalls = 0;
  try {
    await installFakeMigrationSops(fixture);
    await installFakeMigrationAdminDocker(fixture, {
      password: sourcePassword,
    });
    t.mock.method(Client.prototype, "connect", async function () {
      connectCalls += 1;
      connections.push({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
        password: this.password,
      });
      if (connectCalls === 1)
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
    });
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async function (sql) {
      queries.push(sql);
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: "7613370342949990434",
            },
          ],
        };
      if (sql.startsWith("SELECT rolname,")) return { rows: [] };
      assert.fail("G08 credential synchronization must not execute DDL");
    });

    const result = await synchronizeMigrationAdminCredential({
      root: fixture.root,
      contextPath,
      env: fixture.env,
      expectedSystemIdentifier: "7613370342949990434",
    });
    assert.equal(result.stage, "admin-credential-synchronized");
    assert.equal(result.credentialSource, "approved-container");
    assert.equal(
      result.source.containerId,
      "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f",
    );
    assert.equal(connectCalls, 2);
    assert.deepEqual(
      connections.map(({ user, password }) => ({ user, password })),
      [
        { user: "coffeeuser", password: adminPassword },
        { user: "coffeeuser", password: sourcePassword },
      ],
    );
    assert.equal(
      queries.some((sql) => /\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)),
      false,
    );
    const updatedBundle = await readFile(bundlePath);
    assert.notDeepEqual(updatedBundle, initialBundle);
    assert.equal(
      updatedBundle.toString("utf8").includes(sourcePassword),
      false,
    );
    assert.deepEqual(
      (await readdir(join(fixture.root, "secrets"))).sort(),
      ["platform-secrets.schema.json", "platform.secrets.sops.yaml"].sort(),
    );
    const decrypt = spawnSync("sops", ["--decrypt", bundlePath], {
      cwd: fixture.root,
      env: fixture.env,
      encoding: "utf8",
    });
    assert.equal(decrypt.status, 0, decrypt.stderr);
    const updatedPlain = JSON.parse(decrypt.stdout);
    assert.equal(
      updatedPlain.environments.development.bootstrap.postgresAdminPassword,
      sourcePassword,
    );
    const expectedPlain = structuredClone(initialPlain);
    expectedPlain.environments.development.bootstrap.postgresAdminPassword =
      sourcePassword;
    assert.deepEqual(updatedPlain, expectedPlain);
    const dockerCalls = await readFile(
      join(fixture.bin, "g08-docker-calls.json"),
      "utf8",
    );
    assert.deepEqual(
      dockerCalls
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).action),
      ["inspect", "exec", "inspect"],
    );
    assert.equal(dockerCalls.includes(sourcePassword), false);
    assert.equal(JSON.stringify(result).includes(sourcePassword), false);
    assert.equal(JSON.stringify(result).includes(adminPassword), false);
    const encryptArgs = JSON.parse(
      await readFile(join(fixture.bin, "g08-encrypt-invoked"), "utf8"),
    );
    assert.deepEqual(encryptArgs, [
      "encrypt",
      "--input-type",
      "json",
      "--output-type",
      "yaml",
      "--filename-override",
      bundlePath,
    ]);
    assert.equal(encryptArgs.includes("/dev/stdin"), false);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 admin credential sync refuses non-auth failures, changed source identity, and rejected source credentials without bundle writes", async (t) => {
  const scenarios = [
    {
      name: "non-authentication PG failure never reads Docker",
      connect: async () => {
        throw Object.assign(new Error("synthetic network detail"), {
          code: "ECONNREFUSED",
        });
      },
      expectedRule: "CONFIG-G08-PROBE",
      docker: {},
    },
    {
      name: "changed container identity stops after inspection",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      docker: { changeOnInspection: 2 },
      expectedStage: "container-after-extract",
      expectedDockerCalls: ["inspect", "exec", "inspect"],
    },
    {
      name: "inspect command failure stops before credential extraction",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      expectedStage: "container-before-extract",
      docker: { failAction: "inspect" },
      expectedDockerCalls: ["inspect"],
    },
    {
      name: "malformed inspect output stops before credential extraction",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      expectedStage: "container-before-extract",
      docker: { malformedInspect: true },
      expectedDockerCalls: ["inspect"],
    },
    {
      name: "credential extraction command failure stops before retry",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      expectedStage: "credential-extract",
      docker: { failAction: "exec" },
      expectedDockerCalls: ["inspect", "exec"],
    },
    {
      name: "empty source credential is rejected before retry",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      expectedStage: "credential-validate",
      docker: { password: Buffer.alloc(0) },
      expectedDockerCalls: ["inspect", "exec", "inspect"],
    },
    {
      name: "non-UTF-8 source credential is rejected before retry",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE",
      expectedStage: "credential-validate",
      docker: { password: Buffer.from([0xc3, 0x28]) },
      expectedDockerCalls: ["inspect", "exec", "inspect"],
    },
    {
      name: "network identity change during extraction stops before retry",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-ADMIN-SOURCE_CHANGED",
      expectedStage: "container-after-extract",
      docker: { changeNetworkOnInspection: 2 },
      expectedDockerCalls: ["inspect", "exec", "inspect"],
    },
    {
      name: "rejected source credential cannot rewrite SOPS",
      connect: async () => {
        throw Object.assign(new Error("synthetic authentication detail"), {
          code: "28P01",
        });
      },
      expectedRule: "CONFIG-G08-PROBE",
      docker: { password: "synthetic-wrong-source-password" },
      alwaysReject: true,
    },
    {
      name: "server identity mismatch after source auth cannot rewrite SOPS",
      connect: async (call) => {
        if (call === 1)
          throw Object.assign(new Error("synthetic authentication detail"), {
            code: "28P01",
          });
      },
      expectedRule: "CONFIG-G08-PROBE",
      docker: {},
      changedServerIdentity: true,
    },
    {
      name: "existing canonical role after source auth cannot rewrite SOPS",
      connect: async (call) => {
        if (call === 1)
          throw Object.assign(new Error("synthetic authentication detail"), {
            code: "28P01",
          });
      },
      expectedRule: "CONFIG-G08-ROLE-PRESENT",
      docker: {},
      existingRole: true,
    },
    {
      name: "saved admin bundle round-trip rejects a changed foreign field",
      connect: async (call) => {
        if (call === 1)
          throw Object.assign(new Error("synthetic authentication detail"), {
            code: "28P01",
          });
      },
      expectedRule: "CONFIG-G08-SOPS-ROUNDTRIP",
      expectedStage: "admin-secret-saved",
      docker: {},
      savedBundleMutation: "foreign-field",
      expectedDockerCalls: ["inspect", "exec", "inspect"],
      expectedConnectCalls: 2,
    },
  ];
  for (const scenario of scenarios) {
    const { fixture, evidenceDir, contextPath } =
      await createMigrationLaunchFixture();
    const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
    const bundleBefore = await readFile(bundlePath);
    let connectCalls = 0;
    const adminQueries = [];
    try {
      await installFakeMigrationSops(fixture, {
        savedBundleMutation: scenario.savedBundleMutation,
      });
      await installFakeMigrationAdminDocker(fixture, scenario.docker);
      t.mock.method(Client.prototype, "connect", async () => {
        connectCalls += 1;
        await scenario.connect(connectCalls);
      });
      t.mock.method(Client.prototype, "end", async () => {});
      t.mock.method(Client.prototype, "query", async (sql) => {
        adminQueries.push(sql);
        if (
          scenario.alwaysReject ||
          (!scenario.changedServerIdentity &&
            !scenario.existingRole &&
            !scenario.savedBundleMutation)
        )
          assert.fail("failed admin authentication must stop before SQL");
        if (sql.includes("pg_control_system()"))
          return {
            rows: [
              {
                current_database: "postgres",
                current_user: "coffeeuser",
                server_version: "17.11 (fixture)",
                server_version_num: "170011",
                is_superuser: true,
                system_identifier: scenario.changedServerIdentity
                  ? "9999999999999999999"
                  : "7613370342949990434",
              },
            ],
          };
        if (sql.startsWith("SELECT rolname,"))
          return {
            rows: scenario.existingRole
              ? [
                  {
                    rolname: "coffee_customer_migrator",
                    rolcanlogin: true,
                    rolsuper: false,
                    rolcreatedb: false,
                    rolcreaterole: false,
                    rolinherit: false,
                    rolreplication: false,
                    rolbypassrls: false,
                    rolconnlimit: 20,
                  },
                ]
              : [],
          };
        assert.fail("unexpected G08 admin query");
      });
      await assert.rejects(
        synchronizeMigrationAdminCredential({
          root: fixture.root,
          contextPath,
          env: fixture.env,
          expectedSystemIdentifier: "7613370342949990434",
        }),
        (error) => {
          assert.equal(error.ruleId, scenario.expectedRule, scenario.name);
          if (scenario.expectedStage)
            assert.equal(
              error.facts.stage,
              scenario.expectedStage,
              scenario.name,
            );
          return true;
        },
        scenario.name,
      );
      if (scenario.savedBundleMutation)
        assert.notDeepEqual(
          await readFile(bundlePath),
          bundleBefore,
          scenario.name,
        );
      else
        assert.deepEqual(
          await readFile(bundlePath),
          bundleBefore,
          scenario.name,
        );
      if (!scenario.savedBundleMutation)
        assert.equal(
          (await readdir(join(fixture.bin))).includes("g08-encrypt-invoked"),
          false,
          scenario.name,
        );
      const dockerCallsPath = join(fixture.bin, "g08-docker-calls.json");
      const dockerCalls = await readFile(dockerCallsPath, "utf8").catch(
        () => "",
      );
      if (scenario.expectedRule === "CONFIG-G08-PROBE" && connectCalls === 1)
        assert.equal(dockerCalls, "", scenario.name);
      if (scenario.docker.changeOnInspection)
        assert.equal((dockerCalls.match(/"inspect"/gu) ?? []).length, 2);
      if (scenario.expectedDockerCalls) {
        assert.deepEqual(
          dockerCalls
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line).action),
          scenario.expectedDockerCalls,
          scenario.name,
        );
        assert.equal(
          connectCalls,
          scenario.expectedConnectCalls ?? 1,
          scenario.name,
        );
        if (scenario.savedBundleMutation) {
          assert.equal(
            (await readFile(bundlePath, "utf8")).includes(
              "foreign-saved-canary",
            ),
            false,
            scenario.name,
          );
          assert.equal(
            (await readdir(join(fixture.bin))).includes("g08-encrypt-invoked"),
            true,
            scenario.name,
          );
          assert.equal(
            adminQueries.some((sql) =>
              /\b(?:BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/iu.test(sql),
            ),
            false,
            scenario.name,
          );
        } else {
          assert.equal(
            (await readdir(join(fixture.bin))).includes("g08-encrypt-invoked"),
            false,
            scenario.name,
          );
        }
      }
      if (scenario.alwaysReject) assert.equal(connectCalls, 2);
      if (scenario.changedServerIdentity || scenario.existingRole)
        assert.equal(connectCalls, 2);
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.bin, { recursive: true, force: true });
    }
  }
});

void test("G17 target binds readonly context, isolated config, and server identity before secret access", async (t) => {
  const launch = await createMigrationLaunchFixture({
    databaseIsolation: true,
  });
  const { fixture, evidenceDir, contextPath } = launch;
  t.after(async () => {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  });
  const args = { root: fixture.root, contextPath };
  const originalContext = await readFile(contextPath);
  const context = JSON.parse(originalContext);
  for (const [override, ruleId] of [
    [{ contextPath: "relative" }, "CONFIG-G17-CONTEXT"],
    [{ root: "/tmp/foreign" }, "CONFIG-G17-CONTEXT"],
    [{ runId: "other-run" }, "CONFIG-G17-CONTEXT"],
    [{ candidateSha: "f".repeat(40) }, "CONFIG-G17-CONTEXT"],
    [{ host: "127.0.0.1" }, "CONFIG-G17-CONFIG"],
    [{ port: 5433 }, "CONFIG-G17-CONFIG"],
    [{ expectedSystemIdentifier: "not-numeric" }, "CONFIG-G17-CONFIG"],
  ]) {
    await assert.rejects(validateBackupTarget({ ...args, ...override }), {
      ruleId,
    });
  }
  await chmod(contextPath, 0o600);
  try {
    await assert.rejects(validateBackupTarget(args), {
      ruleId: "CONFIG-G17-CONTEXT",
    });
    await writeFile(contextPath, "{invalid context");
    await chmod(contextPath, 0o400);
    await assert.rejects(validateBackupTarget(args), {
      ruleId: "CONFIG-G17-CONTEXT",
    });
  } finally {
    await chmod(contextPath, 0o600);
    await writeFile(contextPath, originalContext);
    await chmod(contextPath, 0o400);
  }
  const configPath = join(fixture.root, "config/platform.yaml");
  const configBytes = await readFile(configPath);
  await writeFile(configPath, Buffer.concat([configBytes, Buffer.from("\n")]));
  try {
    await assert.rejects(validateBackupTarget(args), {
      ruleId: "CONFIG-G17-CONFIG",
    });
  } finally {
    await writeFile(configPath, configBytes);
  }
  const artifactDir = join(evidenceDir, "gates/G00_PREFLIGHT/artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const identityPath = join(artifactDir, "postgres-server-identity.json");
  const identity = {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    host: "coffee_postgres",
    port: 5432,
    version: "17.11",
    systemIdentifier: "7613370342949990434",
  };
  await writeFile(identityPath, "{invalid identity", { mode: 0o600 });
  await assert.rejects(validateBackupTarget(args), {
    ruleId: "CONFIG-G17-SERVER-IDENTITY",
  });
  await writeFile(identityPath, JSON.stringify(identity));
  await assert.rejects(
    validateBackupTarget({ ...args, expectedSystemIdentifier: "999" }),
    { ruleId: "CONFIG-G17-SERVER-IDENTITY" },
  );
  const result = await validateBackupTarget(args);
  assert.deepEqual(result.target, {
    host: "coffee_postgres",
    port: 5432,
    systemIdentifier: identity.systemIdentifier,
  });
  await chmod(identityPath, 0o666);
  await assert.rejects(validateBackupTarget(args), {
    ruleId: "CONFIG-G17-SERVER-IDENTITY",
  });
  assert.deepEqual(JSON.parse(await readFile(identityPath, "utf8")), identity);
  assert.equal(
    await lstat(join(fixture.bin, "sops-invoked")).catch(() => null),
    null,
  );
});

void test("G08 credential reader rejects malformed requests before accessing secrets", async () => {
  const valid = {
    root: "/nonexistent-g08-root",
    owner: "customer",
    kind: "migrator",
  };
  const invalid = [
    { kind: "unknown" },
    { owner: 1 },
    { owner: "Customer" },
    { kind: "runtime" },
    { kind: "runtime", runtime: "Catalog-service" },
    { runtime: "catalog-service" },
    { expectedSystemIdentifier: 123 },
    { expectedSystemIdentifier: "123x" },
    { expectedSystemIdentifier: "1".repeat(21) },
  ];
  for (const request of invalid) {
    await assert.rejects(
      readMigrationCredential({ ...valid, ...request }),
      /CONFIG-G08-CREDENTIAL-REQUEST/u,
    );
  }
});

void test("G08 current attestation requires password authentication and unchanged canonical inputs", async (t) => {
  const launch = await createMigrationLaunchFixture({
    migratorBlock: true,
    alignedRunId: true,
  });
  const { fixture, contextPath, evidenceDir } = launch;
  const { roleNames, artifactPath } =
    await writeMigrationPreparationArtifact(launch);
  const args = {
    root: fixture.root,
    contextPath,
    env: fixture.env,
    expectedSystemIdentifier: "7613370342949990434",
  };
  const configPath = join(fixture.root, "config/platform.yaml");
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const closed = [];
  let mode = "valid";
  let roleConnections = 0;
  try {
    await installFakeMigrationSops(fixture);
    t.mock.method(Client.prototype, "connect", async function () {
      if (this.user !== "coffeeuser") {
        roleConnections += 1;
        if (mode === "wrong-password" && roleConnections === 4)
          throw new Error("private error");
        if (roleConnections === 1 && mode === "config")
          await writeFile(configPath, "changed");
        if (roleConnections === 1 && mode === "bundle")
          await writeFile(bundlePath, "changed");
        if (roleConnections === 1 && mode === "context") {
          await chmod(contextPath, 0o600);
          await writeFile(contextPath, "changed");
          await chmod(contextPath, 0o400);
        }
        if (mode !== "trust") {
          this.connection.emit(
            mode === "md5" ? "authenticationMD5Password" : "authenticationSASL",
            {},
          );
          if (mode !== "md5" && mode !== "sasl-incomplete")
            this.connection.emit("authenticationSASLFinal", {});
        }
      }
    });
    t.mock.method(Client.prototype, "end", async function () {
      closed.push(this.user);
    });
    t.mock.method(Client.prototype, "query", async function (sql) {
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: "7613370342949990434",
            },
          ],
        };
      if (sql.startsWith("SELECT rolname,"))
        return {
          rows: [...roleNames, ...(mode === "extra-role" ? ["foreign"] : [])]
            .filter((_, index) => mode !== "missing-role" || index !== 0)
            .map((rolname, index) => ({
              rolname,
              rolcanlogin: true,
              rolsuper: mode === "attributes" && index === 0,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false,
              rolconnlimit: 20,
            })),
        };
      assert.equal(sql, "SELECT current_user, current_database()");
      return {
        rows: [
          {
            current_user: mode === "wrong-user" ? "foreign" : this.user,
            current_database: "postgres",
          },
        ],
      };
    });
    const context = JSON.parse(await readFile(contextPath, "utf8"));
    const approvedPath = join(
      evidenceDir,
      "gates/G08_MIGRATIONS/artifacts/approved-target.json",
    );
    await writeFile(
      approvedPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        systemIdentifier: args.expectedSystemIdentifier,
      }),
      { mode: 0o400 },
    );
    await rm(artifactPath);
    mode = "trust";
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = fixture.env.PATH;
      await assert.rejects(
        runMigrationStage("clean", { root: fixture.root, contextPath }),
        {
          ruleId: "CONFIG-G08-ROLE-AUTH",
        },
      );
      assert.equal(roleConnections, 1);
      await assert.rejects(lstat(artifactPath), { code: "ENOENT" });
      mode = "valid";
      roleConnections = 0;
      await assert.rejects(
        runMigrationStage("clean", { root: fixture.root, contextPath }),
        { code: "ENOENT" },
      );
      assert.equal(roleConnections, 15);
      const generated = JSON.parse(await readFile(artifactPath, "utf8"));
      assert.equal(generated.preparation.stage, "roles-verified");
      assert.deepEqual(
        validateMigrationPreparationArtifact(
          generated,
          context,
          generated.preparation.bundle.resultingSha256,
        ),
        generated.preparation,
      );
      await rm(artifactPath);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
    mode = "valid";
    roleConnections = 0;
    closed.length = 0;
    const preparation = await attestCanonicalMigrationPreparation(args);
    assert.equal(preparation.stage, "roles-verified");
    assert.equal(preparation.createdCount, 0);
    assert.equal(roleConnections, 15);
    assert.equal(closed.length, 17);
    const wrapper = {
      schemaVersion: 1,
      runId: context.runId,
      candidateSha: context.candidateSha,
      baseConfigSha256: context.baseConfigSha256,
      preparation,
    };
    assert.deepEqual(
      validateMigrationPreparationArtifact(
        wrapper,
        context,
        preparation.bundle.resultingSha256,
      ),
      preparation,
    );
    for (const mutation of [
      { createdCount: 15 },
      { transaction: "committed" },
      { runId: `20261025T000000Z-${context.candidateSha.slice(0, 7)}` },
      {
        runId: "20261025T000000Z-abcdef0",
        candidateSha: `abcdef0${"a".repeat(33)}`,
      },
      { baseConfigSha256: "a".repeat(64), configSha256: "a".repeat(64) },
      { bundle: { ...preparation.bundle, beforeSha256: "a".repeat(64) } },
    ])
      assert.throws(
        () =>
          validateMigrationPreparationArtifact(
            { ...wrapper, preparation: { ...preparation, ...mutation } },
            context,
            preparation.bundle.resultingSha256,
          ),
        /CONFIG-G08-PREPARATION/u,
      );
    await assert.rejects(
      attestCanonicalMigrationPreparation({
        ...args,
        expectedSystemIdentifier: undefined,
      }),
      { ruleId: "CONFIG-G08-IDENTITY" },
    );
    await assert.rejects(
      attestCanonicalMigrationPreparation({
        ...args,
        expectedSystemIdentifier: "999",
      }),
      { ruleId: "CONFIG-G08-PROBE" },
    );
    mode = "md5";
    await attestCanonicalMigrationPreparation(args);
    for (mode of [
      "trust",
      "sasl-incomplete",
      "wrong-password",
      "wrong-user",
      "attributes",
      "missing-role",
      "extra-role",
    ]) {
      roleConnections = 0;
      const start = closed.length;
      await assert.rejects(attestCanonicalMigrationPreparation(args), {
        ruleId:
          mode === "extra-role"
            ? "CONFIG-G08-PROBE"
            : ["attributes", "missing-role"].includes(mode)
              ? "CONFIG-G08-ROLE-INVENTORY"
              : "CONFIG-G08-ROLE-AUTH",
      });
      assert.equal(closed.length - start, roleConnections + 1);
    }
    for (const [change, path, ruleId] of [
      ["config", configPath, "CONFIG-G08-CONFIG"],
      ["bundle", bundlePath, "CONFIG-G08-BUNDLE_CHANGED"],
      ["context", contextPath, "CONFIG-G08-CONTEXT"],
    ]) {
      mode = change;
      roleConnections = 0;
      const bytes = await readFile(path);
      try {
        await assert.rejects(attestCanonicalMigrationPreparation(args), {
          ruleId,
        });
      } finally {
        if (change === "context") await chmod(path, 0o600);
        await writeFile(path, bytes);
        if (change === "context") await chmod(path, 0o400);
      }
    }
    mode = "valid";
    const plain = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    delete plain.environments.development.bootstrap.migrators.customer;
    await writeFile(fixture.plainPath, JSON.stringify(plain));
    await assert.rejects(attestCanonicalMigrationPreparation(args), {
      ruleId: "CONFIG-G08-ADMIN-SECRET",
    });
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      false,
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G15 child credentials reuse the unchanged parent G08 receipt only through exact OIDC lineage", async (t) => {
  const parent = await createMigrationLaunchFixture({
    migratorBlock: true,
    databaseIsolation: true,
  });
  const { roleNames } = await writeMigrationPreparationArtifact(parent);
  const child = await createBrowserChildMigrationLaunchFixture(parent);
  const childBundlePath = join(
    child.root,
    "secrets/platform.secrets.sops.yaml",
  );
  const childBundleInfo = await lstat(childBundlePath);
  assert.equal(childBundleInfo.isFile(), true);
  assert.equal(childBundleInfo.uid, process.getuid());
  assert.equal(childBundleInfo.mode & 0o022, 0);
  const artifactPath = join(
    parent.evidenceDir,
    "gates/G08_MIGRATIONS/artifacts/canonical-preparation.json",
  );
  const parentReceipt = await readFile(artifactPath);
  const parentContextBytes = await readFile(parent.contextPath);
  const parentContextMode = (await lstat(parent.contextPath)).mode & 0o777;
  const connectCalls = [];
  const queryCalls = [];
  let replaceParentContextDuringProbe = false;
  t.after(async () => {
    await rm(child.evidenceDir, { recursive: true, force: true });
    await rm(child.root, { recursive: true, force: true });
    await rm(parent.evidenceDir, { recursive: true, force: true });
    await rm(parent.fixture.root, { recursive: true, force: true });
    await rm(parent.fixture.bin, { recursive: true, force: true });
  });
  await installFakeMigrationSops(parent.fixture, {
    additionalBundlePaths: [childBundlePath],
  });
  t.mock.method(Client.prototype, "connect", async function () {
    connectCalls.push(this.user);
  });
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async function (sql, values) {
    queryCalls.push({ sql, values });
    if (sql.includes("pg_control_system()"))
      return {
        rows: [
          {
            current_database: "postgres",
            current_user: "coffeeuser",
            server_version: "17.11 (fixture)",
            server_version_num: "170011",
            is_superuser: true,
            system_identifier: "7613370342949990434",
          },
        ],
      };
    if (sql.startsWith("SELECT rolname,")) {
      assert.deepEqual(values, [roleNames]);
      const result = {
        rows: roleNames.map((rolname) => ({
          rolname,
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
          rolconnlimit: 20,
        })),
      };
      if (replaceParentContextDuringProbe) {
        replaceParentContextDuringProbe = false;
        await chmod(parent.contextPath, 0o600);
        await writeFile(parent.contextPath, "{invalid parent context\n");
        await chmod(parent.contextPath, 0o400);
      }
      return result;
    }
    assert.fail("G15 inherited preparation must use readonly identity queries");
  });

  const identity = await readPreparedPostgresIdentity({
    root: child.root,
    contextPath: child.contextPath,
    preparationContextPath: parent.contextPath,
    env: parent.fixture.env,
  });
  const migrator = await readMigrationCredential({
    root: child.root,
    contextPath: child.contextPath,
    preparationContextPath: parent.contextPath,
    owner: "orders",
    kind: "migrator",
    expectedSystemIdentifier: "7613370342949990434",
    env: parent.fixture.env,
  });
  assert.deepEqual(identity, {
    host: "coffee_postgres",
    port: 5432,
    version: "17.11",
    systemIdentifier: "7613370342949990434",
    database: "postgres",
    user: "coffeeuser",
  });
  assert.deepEqual(migrator, {
    username: "coffee_orders_migrator",
    password: "existing-migrator-orders-canary",
  });
  assert.equal(connectCalls.length, 2);
  assert.equal(queryCalls.length, 4);
  assert.deepEqual(await readFile(artifactPath), parentReceipt);
  await assert.rejects(
    readFile(
      join(
        child.evidenceDir,
        "gates/G08_MIGRATIONS/artifacts/canonical-preparation.json",
      ),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    readMigrationCredential({
      root: child.root,
      contextPath: child.contextPath,
      preparationContextPath: join(child.evidenceDir, "context.json"),
      owner: "orders",
      kind: "migrator",
      env: parent.fixture.env,
    }),
    /CONFIG-G08-G15-LINEAGE/u,
  );
  assert.equal(connectCalls.length, 2);

  const dirtyParentMarker = join(
    parent.fixture.root,
    "g15-untrusted-parent-checkout.txt",
  );
  const connectionsBeforeDirtyParent = connectCalls.length;
  await writeFile(dirtyParentMarker, "uncommitted source change\n");
  try {
    await assert.rejects(
      readMigrationCredential({
        root: child.root,
        contextPath: child.contextPath,
        preparationContextPath: parent.contextPath,
        owner: "orders",
        kind: "migrator",
        env: parent.fixture.env,
      }),
      { ruleId: "CONFIG-G08-G15-LINEAGE" },
    );
  } finally {
    await rm(dirtyParentMarker, { force: true });
  }
  assert.equal(
    connectCalls.length,
    connectionsBeforeDirtyParent,
    "a dirty G15 parent checkout must be rejected before PostgreSQL access",
  );

  const connectionsBeforeParentRace = connectCalls.length;
  const queriesBeforeParentRace = queryCalls.length;
  replaceParentContextDuringProbe = true;
  try {
    await assert.rejects(
      readMigrationCredential({
        root: child.root,
        contextPath: child.contextPath,
        preparationContextPath: parent.contextPath,
        owner: "orders",
        kind: "migrator",
        env: parent.fixture.env,
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-G15-LINEAGE");
        assert.doesNotMatch(JSON.stringify(error.facts ?? {}), /canary/u);
        return true;
      },
    );
  } finally {
    await chmod(parent.contextPath, 0o600);
    await writeFile(parent.contextPath, parentContextBytes);
    await chmod(parent.contextPath, parentContextMode);
  }
  assert.equal(connectCalls.length - connectionsBeforeParentRace, 1);
  assert.equal(queryCalls.length - queriesBeforeParentRace, 2);
  assert.deepEqual(await readFile(parent.contextPath), parentContextBytes);
  assert.equal(
    (await lstat(parent.contextPath)).mode & 0o777,
    parentContextMode,
  );
  assert.deepEqual(await readFile(artifactPath), parentReceipt);
});

void test("G15 child G08 credential admission rejects non-profile config changes before PostgreSQL connection", async (t) => {
  const parent = await createMigrationLaunchFixture({
    migratorBlock: true,
    databaseIsolation: true,
  });
  await writeMigrationPreparationArtifact(parent);
  const child = await createBrowserChildMigrationLaunchFixture(parent, {
    skipLineageValidation: true,
    mutateConfig: (text) =>
      text.replace(
        "clientId: realtime-browser-fixture",
        "clientId: unauthorized-fixture",
      ),
  });
  let connectCalls = 0;
  t.after(async () => {
    await rm(child.evidenceDir, { recursive: true, force: true });
    await rm(child.root, { recursive: true, force: true });
    await rm(parent.evidenceDir, { recursive: true, force: true });
    await rm(parent.fixture.root, { recursive: true, force: true });
    await rm(parent.fixture.bin, { recursive: true, force: true });
  });
  await installFakeMigrationSops(parent.fixture, {
    additionalBundlePaths: [
      join(child.root, "secrets/platform.secrets.sops.yaml"),
    ],
  });
  t.mock.method(Client.prototype, "connect", async () => {
    connectCalls += 1;
  });
  await assert.rejects(
    readMigrationCredential({
      root: child.root,
      contextPath: child.contextPath,
      preparationContextPath: parent.contextPath,
      owner: "orders",
      kind: "migrator",
      env: parent.fixture.env,
    }),
    /CONFIG-G08-G15-LINEAGE/u,
  );
  assert.equal(connectCalls, 0);
});

void test("G08 preparation binds its committed config and permits only the approved isolation transition", () => {
  const preparedConfigBytes = Buffer.from(
    [
      "postgres:",
      "  host: coffee_postgres",
      "  bootstrapUsername: coffeeuser",
      "verification:",
      "  databaseIsolation:",
      "    enabled: false",
      "  kafkaNamespaceIsolation: false",
      "telemetry:",
      "  namespace: coffee-platform",
      "",
    ].join("\n"),
  );
  const preparedConfigSha256 = createHash("sha256")
    .update(preparedConfigBytes)
    .digest("hex");
  const transitioned = Buffer.from(
    preparedConfigBytes
      .toString("utf8")
      .replace("    enabled: false", "    enabled: true")
      .replace(
        "  kafkaNamespaceIsolation: false",
        "  kafkaNamespaceIsolation: true",
      ),
  );
  const currentConfigSha256 = createHash("sha256")
    .update(transitioned)
    .digest("hex");

  assert.equal(
    validateMigrationPreparationConfigTransition(
      preparedConfigBytes,
      preparedConfigBytes,
      preparedConfigSha256,
    ),
    true,
  );
  assert.equal(
    validateMigrationPreparationConfigTransition(
      preparedConfigBytes,
      transitioned,
      preparedConfigSha256,
    ),
    true,
  );

  const coveragePaths = [
    "tests/aroma/api-internal-operations.test.mjs",
    "tests/aroma/safe-read-http.test.mjs",
    "tests/aroma/scoping-provenance.test.mjs",
    "tests/aroma/source-identity.test.mjs",
    "tests/orders/security.test.mjs",
    "tests/orders/observability.test.mjs",
    "tests/aroma/catalog-export.test.mjs",
    "tests/edge-auth/operations.test.mjs",
    "tests/realtime/auth.test.mjs",
    "tests/realtime/contract.test.mjs",
    "tests/realtime/replay.test.mjs",
    "tests/realtime/backpressure.test.mjs",
  ];
  const coveragePreparedConfigBytes = Buffer.from(
    [
      "postgres:",
      "  host: coffee_postgres",
      "  bootstrapUsername: coffeeuser",
      "verification:",
      "  databaseIsolation:",
      "    enabled: false",
      "  kafkaNamespaceIsolation: false",
      "  unitCoverage:",
      "    thresholds:",
      "      lines: 90",
      "      functions: 90",
      "      branches: 85",
      "    criticalModules:",
      "      - id: fixture-module",
      "        sourceRoots: [fixture/src]",
      "        coverageRoots: [fixture/dist]",
      "        format: js",
      "    testFiles:",
      "      - tests/config/platform-config.test.mjs",
      "      - tests/config/observability-bootstrap.test.mjs",
      "platform:",
      "  namespace: coffee-platform",
      "  # Coverage paths are independent from platform paths.",
      "  paths:",
      "      - apps/api-public/src/main.ts",
      "",
    ].join("\n"),
  );
  const coveragePreparedConfigSha256 = createHash("sha256")
    .update(coveragePreparedConfigBytes)
    .digest("hex");
  const coverageTransitionedText = coveragePreparedConfigBytes
    .toString("utf8")
    .replace("    enabled: false", "    enabled: true")
    .replace(
      "  kafkaNamespaceIsolation: false",
      "  kafkaNamespaceIsolation: true",
    )
    .replace(
      "      - tests/config/observability-bootstrap.test.mjs\n",
      [
        "      - tests/config/observability-bootstrap.test.mjs",
        ...coveragePaths.map((path) => `      - ${path}`),
        "",
      ].join("\n"),
    );
  const coverageTransitionedBytes = Buffer.from(coverageTransitionedText);
  assert.equal(
    validateMigrationPreparationConfigTransition(
      coveragePreparedConfigBytes,
      coverageTransitionedBytes,
      coveragePreparedConfigSha256,
    ),
    true,
    "only the exact approved coverage additions may accompany the flags",
  );
  const rejectsCoverageTransition = (text) =>
    assert.throws(
      () =>
        validateMigrationPreparationConfigTransition(
          coveragePreparedConfigBytes,
          Buffer.from(text),
          coveragePreparedConfigSha256,
        ),
      /CONFIG-G08-PREPARATION-CONFIG/u,
    );
  rejectsCoverageTransition(
    coverageTransitionedText.replace(`      - ${coveragePaths[0]}\n`, ""),
  );
  rejectsCoverageTransition(
    coverageTransitionedText.replace(
      `      - ${coveragePaths[0]}\n`,
      `      - ${coveragePaths[0]}\n      - ${coveragePaths[0]}\n`,
    ),
  );
  rejectsCoverageTransition(
    coverageTransitionedText.replace(
      `      - ${coveragePaths[0]}\n`,
      `      - tests/config/unapproved.test.mjs\n      - ${coveragePaths[0]}\n`,
    ),
  );
  const approvedCoverageBlock = coveragePaths
    .map((path) => `      - ${path}`)
    .join("\n");
  const misplacedCoverageText = coverageTransitionedText
    .replace(`${approvedCoverageBlock}\n`, "")
    .replace(
      "      - apps/api-public/src/main.ts\n",
      `      - apps/api-public/src/main.ts\n${approvedCoverageBlock}\n`,
    );
  rejectsCoverageTransition(misplacedCoverageText);
  rejectsCoverageTransition(
    coverageTransitionedText.replace("      lines: 90", "      lines: 91"),
  );
  rejectsCoverageTransition(
    coverageTransitionedText.replace(
      "        sourceRoots: [fixture/src]",
      "        sourceRoots: [other/src]",
    ),
  );
  rejectsCoverageTransition(
    coverageTransitionedText.replace(
      "      - tests/config/platform-config.test.mjs\n",
      "",
    ),
  );

  const oldCandidateSha = "1".repeat(40);
  const currentCandidateSha = "2".repeat(40);
  const context = {
    runId: "20261025T123456Z-2222222",
    candidateSha: currentCandidateSha,
    baseConfigSha256: currentConfigSha256,
  };
  const bundleSha256 = "b".repeat(64);
  const prep = {
    schemaVersion: 1,
    stage: "roles-created",
    runId: "20261025T120000Z-1111111",
    candidateSha: oldCandidateSha,
    baseConfigSha256: preparedConfigSha256,
    configSha256: preparedConfigSha256,
    postgres: {
      host: "coffee_postgres",
      port: 5432,
      version: "17.11",
      systemIdentifier: "7613370342949990434",
      database: "postgres",
      user: "coffeeuser",
    },
    bundle: {
      beforeSha256: bundleSha256,
      resultingSha256: bundleSha256,
    },
    roleNames: Array.from({ length: 15 }, (_, index) => `role-${index}`),
    createdCount: 15,
    transaction: "committed",
  };
  assert.equal(
    validateMigrationPreparationArtifact(
      {
        schemaVersion: 1,
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        preparation: prep,
      },
      context,
      bundleSha256,
    ),
    prep,
  );

  const validReceipt = {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    preparation: prep,
  };
  const invalidReceipts = [
    ["extra", true],
    ["schemaVersion", 2],
    ["candidateSha", "3".repeat(40)],
    ["baseConfigSha256", "3".repeat(64)],
    ["preparation.extra", true],
    ["preparation.schemaVersion", 2],
    ["preparation.stage", "pending"],
    ["preparation.runId", "bad"],
    ["preparation.runId", null],
    ["preparation.candidateSha", "bad"],
    ["preparation.candidateSha", null],
    ["preparation.runId", "20261025T120000Z-2222222"],
    ["preparation.baseConfigSha256", "bad"],
    ["preparation.baseConfigSha256", null],
    ["preparation.configSha256", "3".repeat(64)],
    ["preparation.postgres.extra", true],
    ["preparation.postgres.host", "foreign"],
    ["preparation.postgres.port", 5433],
    ["preparation.postgres.version", "17.10"],
    ["preparation.postgres.database", "other"],
    ["preparation.postgres.systemIdentifier", "bad"],
    ["preparation.postgres.systemIdentifier", null],
    ["preparation.postgres.user", null],
    ["preparation.bundle.extra", true],
    ["preparation.bundle.beforeSha256", "bad"],
    ["preparation.bundle.beforeSha256", null],
    ["preparation.bundle.resultingSha256", "3".repeat(64)],
    ["preparation.roleNames", null],
    ["preparation.roleNames", prep.roleNames.slice(1)],
    ["preparation.roleNames.0", 1],
    ["preparation.roleNames.0", prep.roleNames[1]],
    ["preparation.createdCount", 14],
    ["preparation.transaction", "pending"],
  ];
  for (const [path, value] of invalidReceipts) {
    const receipt = structuredClone(validReceipt);
    setValueAtPath(receipt, path, value);
    assert.throws(
      () =>
        validateMigrationPreparationArtifact(receipt, context, bundleSha256),
      /CONFIG-G08-PREPARATION/u,
      path,
    );
  }

  const rejectsTransition = (current) =>
    assert.throws(
      () =>
        validateMigrationPreparationConfigTransition(
          preparedConfigBytes,
          current,
          preparedConfigSha256,
        ),
      /CONFIG-G08-PREPARATION-CONFIG/u,
    );
  rejectsTransition(
    Buffer.from(
      transitioned
        .toString("utf8")
        .replace("host: coffee_postgres", "host: foreign-postgres"),
    ),
  );
  rejectsTransition(
    Buffer.from(
      transitioned
        .toString("utf8")
        .replace("bootstrapUsername: coffeeuser", "bootstrapUsername: other"),
    ),
  );
  rejectsTransition(
    Buffer.from(
      transitioned
        .toString("utf8")
        .replace("namespace: coffee-platform", "namespace: changed"),
    ),
  );
  rejectsTransition(
    Buffer.from(
      transitioned
        .toString("utf8")
        .replace("    enabled: true", "    enabled: false"),
    ),
  );
  assert.throws(
    () =>
      validateMigrationPreparationConfigTransition(
        transitioned,
        preparedConfigBytes,
        createHash("sha256").update(transitioned).digest("hex"),
      ),
    /CONFIG-G08-PREPARATION-CONFIG/u,
  );
  assert.throws(
    () =>
      validateMigrationPreparationConfigTransition(
        preparedConfigBytes,
        transitioned,
        "a".repeat(64),
      ),
    /CONFIG-G08-PREPARATION-CONFIG/u,
  );
});

void test("G08 credential reader rejects stale receipts, invalid identities, unsafe inventories, and unisolated configs", async (t) => {
  const cases = [
    {
      name: "writable preparation receipt",
      artifactMode: 0o600,
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "malformed preparation receipt",
      artifactContents: "{synthetic-invalid-json",
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "missing launch context",
      missingContext: true,
      expectedRule: "CONFIG-G08-CONTEXT",
      probe: false,
    },
    {
      name: "orphan G15 parent metadata without a preparation context",
      orphanPreparationMetadata: true,
      expectedRule: "CONFIG-G08-G15-LINEAGE",
      probe: false,
    },
    {
      name: "missing config file",
      removeConfig: true,
      expectedRule: "CONFIG-G08-CONFIG",
      probe: false,
    },
    {
      name: "symlinked config file",
      symlinkConfig: true,
      expectedRule: "CONFIG-G08-CONFIG",
      probe: false,
    },
    {
      name: "cross-run wrapper",
      options: {
        receipt: {
          mutateWrapper: (wrapper) => ({ ...wrapper, runId: "other-run" }),
        },
      },
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "saved bundle digest mismatch",
      options: {
        receipt: {
          mutatePreparation: (preparation) => ({
            ...preparation,
            bundle: { ...preparation.bundle, resultingSha256: "a".repeat(64) },
          }),
        },
      },
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "preparation server identity differs from approved identity",
      options: {
        receipt: {
          mutatePreparation: (preparation) => ({
            ...preparation,
            postgres: {
              ...preparation.postgres,
              systemIdentifier: "9999999999999999999",
            },
          }),
        },
      },
      expectedRule: "CONFIG-G08-IDENTITY",
      probe: false,
    },
    {
      name: "preparation role names differ from canonical role map",
      options: {
        receipt: {
          mutatePreparation: (preparation) => ({
            ...preparation,
            roleNames: [
              "coffee_unmapped_migrator",
              ...preparation.roleNames.slice(1),
            ],
          }),
        },
      },
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "preparation config digest differs from the committed config",
      options: {
        receipt: {
          mutatePreparation: (preparation) => ({
            ...preparation,
            configSha256: "a".repeat(64),
          }),
        },
      },
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "preparation candidate outside current ancestry",
      options: {
        receipt: {
          mutatePreparation: (preparation) => ({
            ...preparation,
            candidateSha: "f".repeat(40),
            runId: preparation.runId.replace(/-[0-9a-f]{7}$/u, "-fffffff"),
          }),
        },
      },
      expectedRule: "CONFIG-G08-PREPARATION",
      probe: false,
    },
    {
      name: "unknown owner",
      owner: "not-an-owner",
      expectedRule: "CONFIG-G08-CREDENTIAL-OWNER",
      probe: false,
    },
    {
      name: "unisolated database config",
      options: { databaseIsolation: false },
      expectedRule: "CONFIG-G08-TARGET",
      probe: false,
    },
    {
      name: "wrong live server identity",
      serverIdentifier: "9999999999999999999",
      expectedRule: "CONFIG-G08-PROBE",
      probe: true,
      expectedQueries: 1,
    },
    {
      name: "wrong live PostgreSQL user",
      serverOverrides: { current_user: "foreign_admin" },
      expectedRule: "CONFIG-G08-PROBE",
      probe: true,
      expectedQueries: 1,
    },
    {
      name: "wrong live PostgreSQL database",
      serverOverrides: { current_database: "coffee_platform_customer" },
      expectedRule: "CONFIG-G08-PROBE",
      probe: true,
      expectedQueries: 1,
    },
    {
      name: "wrong live PostgreSQL version",
      serverOverrides: { server_version_num: "170012" },
      expectedRule: "CONFIG-G08-PROBE",
      probe: true,
      expectedQueries: 1,
    },
    {
      name: "missing canonical role",
      roleInventory: "missing",
      expectedRule: "CONFIG-G08-ROLE-INVENTORY",
      probe: true,
      expectedQueries: 2,
    },
    {
      name: "privileged canonical role",
      roleInventory: "superuser",
      expectedRule: "CONFIG-G08-ROLE-INVENTORY",
      probe: true,
      expectedQueries: 2,
    },
    ...[
      ["login disabled", "rolcanlogin", false],
      ["CREATEDB enabled", "rolcreatedb", true],
      ["CREATEROLE enabled", "rolcreaterole", true],
      ["inherit enabled", "rolinherit", true],
      ["replication enabled", "rolreplication", true],
      ["BYPASSRLS enabled", "rolbypassrls", true],
      ["connection limit changed", "rolconnlimit", 19],
    ].map(([name, roleProperty, roleValue]) => ({
      name: `canonical role ${name}`,
      roleMutation: { roleProperty, roleValue },
      expectedRule: "CONFIG-G08-ROLE-INVENTORY",
      probe: true,
      expectedQueries: 2,
    })),
    {
      name: "preparation receipt changed during the read-only probe",
      mutateReceiptDuringProbe: true,
      expectedRule: "CONFIG-G08-PREPARATION_CHANGED",
      probe: true,
      expectedQueries: 2,
    },
    {
      name: "encrypted credential bundle changed during the read-only probe",
      mutateBundleDuringProbe: true,
      expectedRule: "CONFIG-G08-BUNDLE_CHANGED",
      probe: true,
      expectedQueries: 2,
    },
    {
      name: "encrypted bundle removed after its final snapshot read",
      snapshotRace: "bundle",
      expectedRule: "CONFIG-G08-BUNDLE_CHANGED",
      probe: true,
      expectedQueries: 2,
    },
    {
      name: "preparation receipt removed after canonical path resolution",
      snapshotRace: "receipt",
      expectedRule: "CONFIG-G08-PREPARATION_CHANGED",
      probe: true,
      expectedQueries: 2,
    },
  ];
  let state = {};
  let connectCalls = 0;
  const queryCalls = [];
  t.mock.method(Client.prototype, "connect", async () => {
    connectCalls += 1;
  });
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async (sql, values) => {
    queryCalls.push(sql);
    if (sql.includes("pg_control_system()")) {
      if (state.mutateReceiptDuringProbe) {
        await chmod(state.receiptPath, 0o600);
        await writeFile(state.receiptPath, '{"replacement":"changed"}\n');
        await chmod(state.receiptPath, 0o400);
        state.mutateReceiptDuringProbe = false;
      }
      return {
        rows: [
          {
            current_database: "postgres",
            current_user: "coffeeuser",
            server_version: "17.11 (fixture)",
            server_version_num: "170011",
            is_superuser: true,
            system_identifier: state.serverIdentifier ?? "7613370342949990434",
            ...state.serverOverrides,
          },
        ],
      };
    }
    if (sql.startsWith("SELECT rolname,")) {
      let rows = state.roleNames.map((rolname) => ({
        rolname,
        rolcanlogin: true,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
        rolconnlimit: 20,
      }));
      if (state.roleInventory === "missing") rows = rows.slice(1);
      if (state.roleInventory === "superuser") rows[0].rolsuper = true;
      if (state.roleMutation)
        rows[0][state.roleMutation.roleProperty] = state.roleMutation.roleValue;
      assert.deepEqual(values, [state.roleNames]);
      if (state.mutateBundleDuringProbe) {
        await chmod(state.bundlePath, 0o600);
        await writeFile(state.bundlePath, state.bundleReplacement);
        state.mutateBundleDuringProbe = false;
      }
      if (state.snapshotRace) state.armSnapshotRace = true;
      return { rows };
    }
    assert.fail("credential reader must issue only readonly identity queries");
  });

  for (const scenario of cases) {
    const launch = await createMigrationLaunchFixture({
      migratorBlock: true,
      databaseIsolation: scenario.options?.databaseIsolation !== false,
    });
    const { fixture, evidenceDir, contextPath } = launch;
    try {
      if (scenario.orphanPreparationMetadata) {
        const context = JSON.parse(await readFile(contextPath, "utf8"));
        context.resources = { g15ParentRunId: launch.runId };
        await chmod(contextPath, 0o600);
        await writeFile(contextPath, `${JSON.stringify(context)}\n`);
        await chmod(contextPath, 0o400);
      }
      await installFakeMigrationSops(fixture);
      const artifact = await writeMigrationPreparationArtifact(
        launch,
        scenario.options?.receipt,
      );
      if (scenario.artifactContents !== undefined) {
        await chmod(artifact.artifactPath, 0o600);
        await writeFile(artifact.artifactPath, scenario.artifactContents);
        await chmod(artifact.artifactPath, 0o400);
      }
      if (scenario.artifactMode !== undefined)
        await chmod(artifact.artifactPath, scenario.artifactMode);
      if (scenario.removeConfig)
        await rm(join(fixture.root, "config/platform.yaml"));
      if (scenario.symlinkConfig) {
        const configPath = join(fixture.root, "config/platform.yaml");
        await rm(configPath);
        await symlink(
          join(fixture.root, "config/database-role-map.json"),
          configPath,
        );
      }
      state = {
        roleNames: artifact.roleNames,
        roleInventory: scenario.roleInventory,
        roleMutation: scenario.roleMutation,
        serverIdentifier: scenario.serverIdentifier,
        serverOverrides: scenario.serverOverrides,
        mutateReceiptDuringProbe: scenario.mutateReceiptDuringProbe,
        mutateBundleDuringProbe: scenario.mutateBundleDuringProbe,
        receiptPath: artifact.artifactPath,
        bundlePath: join(fixture.root, "secrets/platform.secrets.sops.yaml"),
        bundleReplacement: Buffer.from("foreign bundle replacement\n"),
        snapshotRace: scenario.snapshotRace,
        armSnapshotRace: false,
      };
      let snapshotRaceMock;
      let snapshotRacePath;
      let snapshotRaceBytes;
      let snapshotRaceMode;
      let snapshotRaceTriggered = false;
      if (scenario.snapshotRace) {
        snapshotRacePath =
          scenario.snapshotRace === "bundle"
            ? state.bundlePath
            : state.receiptPath;
        snapshotRaceBytes = await readFile(snapshotRacePath);
        snapshotRaceMode = (await stat(snapshotRacePath)).mode & 0o777;
        const method =
          scenario.snapshotRace === "bundle" ? "readFile" : "realpath";
        const originalMethod = fsPromises[method].bind(fsPromises);
        snapshotRaceMock = t.mock.method(
          fsPromises,
          method,
          async (...args) => {
            const actualPath = resolve(String(args[0]));
            if (!state.armSnapshotRace || actualPath !== snapshotRacePath)
              return originalMethod(...args);
            state.armSnapshotRace = false;
            snapshotRaceTriggered = true;
            const result = await originalMethod(...args);
            await rm(snapshotRacePath);
            return result;
          },
        );
        syncBuiltinESMExports();
      }
      const callsBefore = connectCalls;
      const queriesBefore = queryCalls.length;
      try {
        await assert.rejects(
          readMigrationCredential({
            root: fixture.root,
            contextPath: scenario.missingContext
              ? join(fixture.root, "missing-context.json")
              : contextPath,
            owner: scenario.owner ?? "customer",
            kind: "migrator",
            expectedSystemIdentifier: "7613370342949990434",
            env: fixture.env,
          }),
          (error) => {
            assert.equal(error.ruleId, scenario.expectedRule, scenario.name);
            return true;
          },
          scenario.name,
        );
        assert.equal(
          connectCalls - callsBefore,
          scenario.probe ? 1 : 0,
          scenario.name,
        );
        assert.equal(
          queryCalls.length - queriesBefore,
          scenario.expectedQueries ?? 0,
          scenario.name,
        );
        if (scenario.symlinkConfig)
          assert.equal(
            (await readdir(fixture.bin)).includes("sops-invoked"),
            false,
            "symlinked config must fail before trusted secret access",
          );
        if (scenario.mutateReceiptDuringProbe) {
          assert.equal(queryCalls.slice(-2).length, 2);
          assert.ok(
            queryCalls
              .slice(-2)
              .every((sql) => sql.trimStart().startsWith("SELECT")),
            "receipt replacement must be detected after readonly target queries",
          );
        }
        if (scenario.mutateBundleDuringProbe) {
          const probeQueries = queryCalls.slice(-2);
          assert.equal(probeQueries.length, 2, scenario.name);
          assert.ok(
            probeQueries.every((sql) => sql.trimStart().startsWith("SELECT")),
            "bundle replacement must be detected after readonly target queries",
          );
          assert.deepEqual(
            await readFile(state.bundlePath),
            state.bundleReplacement,
            "foreign bundle replacement must remain untouched",
          );
        }
        if (scenario.snapshotRace) {
          assert.equal(snapshotRaceTriggered, true, scenario.name);
          assert.equal(
            await lstat(snapshotRacePath).catch(() => null),
            null,
            "the exact owned snapshot target must be absent at rejection",
          );
          const probeQueries = queryCalls.slice(-2);
          assert.equal(probeQueries.length, 2, scenario.name);
          assert.ok(
            probeQueries.every((sql) => sql.trimStart().startsWith("SELECT")),
            "snapshot race must be detected after readonly target queries",
          );
        }
      } finally {
        if (snapshotRaceMock) {
          snapshotRaceMock.mock.restore();
          syncBuiltinESMExports();
        }
        if (snapshotRaceTriggered) {
          await writeFile(snapshotRacePath, snapshotRaceBytes);
          await chmod(snapshotRacePath, snapshotRaceMode);
          assert.deepEqual(await readFile(snapshotRacePath), snapshotRaceBytes);
          assert.equal(
            (await stat(snapshotRacePath)).mode & 0o777,
            snapshotRaceMode,
          );
        }
      }
    } finally {
      await rm(evidenceDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.bin, { recursive: true, force: true });
    }
  }
});

void test("G08 role preparation rechecks roles, stores only encrypted credentials and creates all roles in one transaction", async (t) => {
  const launch = await createMigrationLaunchFixture();
  const { fixture, evidenceDir, contextPath, adminPassword } = launch;
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const initialBundle = await readFile(bundlePath);
  const initialBundleSha = createHash("sha256")
    .update(initialBundle)
    .digest("hex");
  const connections = [];
  const queries = [];
  const createStatements = [];
  const roleRows = [];
  let inventoryCalls = 0;
  let identityCalls = 0;
  let failTransactionProbe = false;
  let changeIdentityOnTransactionProbe = false;
  let systemIdentifier = "7613370342949990434";
  let conflictOnTransaction = false;
  let replaceBundleOnTransactionInventory = false;
  let replacementBundleBytes;
  let createFailureAt = 0;
  let rollbackFails = false;
  let commitFails = false;
  let closeFails = false;
  let closeCalls = 0;
  try {
    await installFakeMigrationSops(fixture);
    t.mock.method(Client.prototype, "connect", async function () {
      connections.push({
        host: this.host,
        port: this.port,
        database: this.database,
        user: this.user,
      });
    });
    t.mock.method(Client.prototype, "end", async () => {
      closeCalls += 1;
      if (closeFails && queries.some(({ sql }) => sql === "COMMIT"))
        throw new Error("fixture connection close canary");
    });
    t.mock.method(Client.prototype, "query", async function (sql, values) {
      queries.push({ sql, values });
      if (sql.includes("pg_control_system()")) {
        identityCalls += 1;
        if (failTransactionProbe && identityCalls === 2)
          throw Object.assign(new Error("fixture transaction probe canary"), {
            code: "42501",
            detail: "fixture transaction probe canary",
          });
        const observedSystemIdentifier =
          changeIdentityOnTransactionProbe && identityCalls === 2
            ? "7613370342949990435"
            : systemIdentifier;
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: observedSystemIdentifier,
            },
          ],
        };
      }
      if (sql.startsWith("SELECT rolname,")) {
        inventoryCalls += 1;
        if (replaceBundleOnTransactionInventory && inventoryCalls === 2) {
          await writeFile(bundlePath, replacementBundleBytes);
          await chmod(bundlePath, 0o600);
        }
        if (conflictOnTransaction && inventoryCalls === 2)
          return {
            rows: [
              {
                rolname: "coffee_customer_migrator",
                rolcanlogin: true,
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolinherit: false,
                rolreplication: false,
                rolbypassrls: false,
                rolconnlimit: 20,
              },
            ],
          };
        return { rows: roleRows };
      }
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "ROLLBACK") {
        if (rollbackFails) throw new Error("fixture rollback failed");
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (commitFails) throw new Error("fixture commit outcome unknown");
        return { rows: [] };
      }
      if (sql.startsWith("CREATE ROLE ")) {
        createStatements.push(sql);
        if (createFailureAt && createStatements.length === createFailureAt)
          throw new Error("fixture CREATE ROLE failed");
        return { rows: [] };
      }
      assert.fail("unexpected G08 preparation query");
    });

    systemIdentifier = "7613370342949990435";
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-IDENTITY");
        assert.equal(error.facts.stage, "readonly-probe");
        assert.equal(
          error.facts.postgres.systemIdentifier,
          "7613370342949990435",
        );
        assert.equal(
          JSON.stringify(error.facts).includes(adminPassword),
          false,
        );
        return true;
      },
    );
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      false,
    );
    assert.equal(createStatements.length, 0);
    assert.equal(
      queries.some(({ sql }) => sql === "BEGIN"),
      false,
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(bundlePath))
        .digest("hex"),
      initialBundleSha,
    );
    systemIdentifier = "7613370342949990434";

    identityCalls = 0;
    inventoryCalls = 0;
    queries.length = 0;
    createStatements.length = 0;
    changeIdentityOnTransactionProbe = true;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-IDENTITY_CHANGED");
        assert.equal(error.facts.stage, "role-transaction");
        assert.equal(
          error.facts.postgres.systemIdentifier,
          "7613370342949990435",
        );
        assert.equal(
          JSON.stringify({
            message: error.message,
            facts: error.facts,
          }).includes(adminPassword),
          false,
        );
        return true;
      },
    );
    changeIdentityOnTransactionProbe = false;
    assert.equal(identityCalls, 2);
    assert.equal(createStatements.length, 0);
    assert.ok(queries.some(({ sql }) => sql === "BEGIN"));
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(
        ({ sql }) => sql === "COMMIT" || sql.startsWith("CREATE ROLE "),
      ),
      false,
    );
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      true,
    );
    await rm(join(fixture.bin, "g08-encrypt-invoked"), { force: true });
    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);

    roleRows.push({
      rolname: "coffee_customer_migrator",
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 20,
    });
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-ROLE-PRESENT");
        assert.deepEqual(
          error.facts.roleInventory.existing.map((role) => role.role),
          ["coffee_customer_migrator"],
        );
        assert.equal(error.facts.bundleSha256, initialBundleSha);
        assert.equal(
          JSON.stringify(error.facts).includes(adminPassword),
          false,
        );
        return true;
      },
    );
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      false,
    );
    assert.equal(createStatements.length, 0);
    assert.equal(
      createHash("sha256")
        .update(await readFile(bundlePath))
        .digest("hex"),
      initialBundleSha,
    );

    roleRows.length = 0;
    inventoryCalls = 0;
    conflictOnTransaction = true;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-ROLE_CONFLICT");
        assert.equal(error.facts.stage, "role-transaction");
        assert.equal(
          error.facts.roleInventory.existing[0].role,
          "coffee_customer_migrator",
        );
        assert.equal(error.facts.bundleResultingSha256.length, 64);
        return true;
      },
    );
    assert.equal(createStatements.length, 0);
    assert.ok(queries.some(({ sql }) => sql === "BEGIN"));
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(({ sql }) => sql === "COMMIT"),
      false,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    conflictOnTransaction = false;
    inventoryCalls = 0;
    identityCalls = 0;
    failTransactionProbe = true;
    queries.length = 0;
    createStatements.length = 0;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-TRANSACTION-PROBE");
        assert.equal(error.facts.stage, "role-transaction-probe-failed");
        assert.equal(JSON.stringify(error).includes("canary"), false);
        return true;
      },
    );
    failTransactionProbe = false;
    assert.equal(createStatements.length, 0);
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(({ sql }) => sql === "COMMIT"),
      false,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    queries.length = 0;
    replacementBundleBytes = Buffer.from("foreign bundle replacement\n");
    conflictOnTransaction = false;
    replaceBundleOnTransactionInventory = true;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-BUNDLE_CHANGED");
        assert.equal(error.facts.stage, "bundle-changed-before-role-create");
        return true;
      },
    );
    replaceBundleOnTransactionInventory = false;
    assert.deepEqual(await readFile(bundlePath), replacementBundleBytes);
    assert.equal(createStatements.length, 0);
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(({ sql }) => sql === "COMMIT"),
      false,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    queries.length = 0;
    createFailureAt = 3;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-ROLE-CREATE");
        assert.equal(error.facts.stage, "role-transaction-rolled-back");
        return true;
      },
    );
    createFailureAt = 0;
    assert.equal(createStatements.length, 3);
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(({ sql }) => sql === "COMMIT"),
      false,
    );
    assert.equal(
      queries.some(({ sql }) => /\bDROP\b/iu.test(sql)),
      false,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    queries.length = 0;
    createFailureAt = 3;
    rollbackFails = true;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-ROLLBACK-UNKNOWN");
        assert.equal(error.facts.stage, "rollback-outcome-unknown");
        return true;
      },
    );
    createFailureAt = 0;
    rollbackFails = false;
    assert.equal(createStatements.length, 3);
    assert.ok(queries.some(({ sql }) => sql === "ROLLBACK"));
    assert.equal(
      queries.some(({ sql }) => sql === "COMMIT" || /\bDROP\b/iu.test(sql)),
      false,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    conflictOnTransaction = false;
    queries.length = 0;
    const prepared = await prepareCanonicalMigratorRoles({
      root: fixture.root,
      contextPath,
      env: fixture.env,
      expectedSystemIdentifier: "7613370342949990434",
    });
    assert.equal(prepared.stage, "roles-created");
    assert.equal(prepared.createdCount, 15);
    assert.equal(prepared.transaction, "committed");
    assert.equal(prepared.bundle.beforeSha256, initialBundleSha);
    assert.notEqual(prepared.bundle.resultingSha256, initialBundleSha);
    assert.deepEqual(
      [...prepared.roleNames].sort((left, right) => left.localeCompare(right)),
      [
        "coffee_customer_migrator",
        "coffee_customer_rw",
        "coffee_catalog_migrator",
        "coffee_catalog_api_ro",
        "coffee_catalog_import_rw",
        "coffee_catalog_activate_rw",
        "coffee_pricing_migrator",
        "coffee_pricing_rw",
        "coffee_orders_migrator",
        "coffee_orders_service_rw",
        "coffee_orders_prepare_rw",
        "coffee_orders_observer_rw",
        "coffee_orders_convergence_rw",
        "coffee_integration_migrator",
        "coffee_aroma_gateway_rw",
      ].sort(),
    );
    assert.equal(createStatements.length, 15);
    assert.ok(createStatements.every((sql) => sql.startsWith("CREATE ROLE ")));
    assert.equal(
      queries.some(({ sql }) => /\b(?:ALTER|DROP)\b/iu.test(sql)),
      false,
    );
    assert.deepEqual(
      queries
        .map(({ sql }) => sql)
        .filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)),
      ["BEGIN", "COMMIT"],
    );
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      true,
    );
    const encryptedText = await readFile(bundlePath, "utf8");
    assert.equal(encryptedText.includes(adminPassword), false);
    assert.equal(encryptedText.includes("fixture-secret-value"), false);
    assert.equal(JSON.stringify(prepared).includes(adminPassword), false);
    assert.equal(
      JSON.stringify(prepared).includes("fixture-secret-value"),
      false,
    );
    assert.equal((await stat(bundlePath)).mode & 0o777, 0o600);
    assert.equal(
      createHash("sha256")
        .update(await readFile(bundlePath))
        .digest("hex"),
      prepared.bundle.resultingSha256,
    );

    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    queries.length = 0;
    commitFails = true;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-COMMIT-UNKNOWN");
        assert.equal(error.facts.stage, "commit-outcome-unknown");
        assert.equal(error.facts.bundleResultingSha256.length, 64);
        assert.equal(
          JSON.stringify(error.facts).includes(adminPassword),
          false,
        );
        return true;
      },
    );
    assert.equal(createStatements.length, 15);
    assert.ok(queries.some(({ sql }) => sql === "COMMIT"));
    assert.equal(
      queries.some(({ sql }) => sql === "ROLLBACK"),
      false,
    );
    assert.equal(
      queries.some(({ sql }) => /\b(?:ALTER|DROP)\b/iu.test(sql)),
      false,
    );

    commitFails = false;
    closeFails = true;
    await writeFile(bundlePath, initialBundle);
    await chmod(bundlePath, 0o600);
    inventoryCalls = 0;
    createStatements.length = 0;
    queries.length = 0;
    const closesBefore = closeCalls;
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      (error) => {
        assert.equal(error.ruleId, "CONFIG-G08-COMMIT-CLOSE");
        assert.equal(error.facts.stage, "roles-committed-close-failed");
        assert.equal(error.facts.roleNames.length, 15);
        assert.doesNotMatch(
          JSON.stringify({ message: error.message, facts: error.facts }),
          /fixture connection close canary|fixture-secret-value|fixture-g08-admin-canary/u,
        );
        return true;
      },
    );
    assert.equal(closeCalls, closesBefore + 2);
    assert.equal(createStatements.length, 15);
    assert.deepEqual(
      queries
        .map(({ sql }) => sql)
        .filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)),
      ["BEGIN", "COMMIT"],
    );
    assert.equal(
      queries.some(({ sql }) => /\b(?:DROP|DELETE)\b/iu.test(sql)),
      false,
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("G08 role preparation refuses an existing migrator block and a changed bundle snapshot", async (t) => {
  const launch = await createMigrationLaunchFixture({ migratorBlock: true });
  const { fixture, evidenceDir, contextPath } = launch;
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const initialBundle = await readFile(bundlePath);
  let inventoryCalls = 0;
  let roleRows = [];
  let cleanLaunch;
  try {
    t.mock.method(Client.prototype, "connect", async () => {});
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", async (sql) => {
      if (sql.includes("pg_control_system()"))
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11 (fixture)",
              server_version_num: "170011",
              is_superuser: true,
              system_identifier: "7613370342949990434",
            },
          ],
        };
      if (sql.startsWith("SELECT rolname,")) {
        inventoryCalls += 1;
        return { rows: roleRows };
      }
      assert.fail("unexpected G08 preparation query");
    });

    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: fixture.root,
        contextPath,
        env: fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      /CONFIG-G08-MIGRATOR-BLOCK_PRESENT/u,
    );
    assert.equal(inventoryCalls, 1);
    assert.equal(
      (await readdir(fixture.bin)).includes("g08-encrypt-invoked"),
      false,
    );
    assert.deepEqual(await readFile(bundlePath), initialBundle);

    // Restore the initial no-block state so the changed-snapshot branch is isolated.
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    cleanLaunch = await createMigrationLaunchFixture();
    const cleanBundlePath = join(
      cleanLaunch.fixture.root,
      "secrets/platform.secrets.sops.yaml",
    );
    const changedBundleBytes = Buffer.from(
      "fixture external bundle replacement\n",
    );
    await installFakeMigrationSops(cleanLaunch.fixture, {
      mutateBundleDuringEncrypt: changedBundleBytes.toString("utf8"),
    });
    inventoryCalls = 0;
    roleRows = [];
    await assert.rejects(
      prepareCanonicalMigratorRoles({
        root: cleanLaunch.fixture.root,
        contextPath: cleanLaunch.contextPath,
        env: cleanLaunch.fixture.env,
        expectedSystemIdentifier: "7613370342949990434",
      }),
      /CONFIG-G08-BUNDLE_CHANGED/u,
    );
    assert.deepEqual(await readFile(cleanBundlePath), changedBundleBytes);
    assert.equal(
      (await readdir(cleanLaunch.fixture.bin)).includes("g08-encrypt-invoked"),
      true,
    );
    assert.equal(inventoryCalls, 1);
    assert.equal(roleRows.length, 0);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    if (cleanLaunch) {
      await rm(cleanLaunch.evidenceDir, { recursive: true, force: true });
      await rm(cleanLaunch.fixture.root, { recursive: true, force: true });
      await rm(cleanLaunch.fixture.bin, { recursive: true, force: true });
    }
  }
});

void test("G08 role preparation validates temporary ciphertext and plaintext before replacing secrets", async (t) => {
  const cases = [
    {
      name: "SOPS encryption command failure",
      options: { failEncryption: true },
      expectedRule: "CONFIG-G08-SOPS-ENCRYPT",
    },
    {
      name: "schema-invalid output",
      options: { invalidOutput: "empty" },
      validationStage: "encrypted-document-validation",
      ruleId: "CONFIG-SCHEMA",
    },
    {
      name: "plaintext encrypted leaf",
      options: { invalidOutput: "plaintext" },
      validationStage: "encrypted-document-validation",
      ruleId: "CONFIG-SCHEMA",
    },
    {
      name: "plaintext leak in otherwise valid ciphertext",
      options: { invalidOutput: "plaintext-leak" },
      validationStage: "plaintext-leak-check",
      ruleId: "CONFIG-G08-SOPS-OUTPUT",
    },
    {
      name: "undecryptable ciphertext",
      options: { corruptTemporaryCiphertext: true },
      validationStage: "temporary-decrypt",
    },
    {
      name: "changed existing credential",
      options: { changeExistingCredential: true },
      validationStage: "temporary-roundtrip-validation",
    },
    {
      name: "bundle replacement after rename is rejected without deleting the replacement",
      options: {},
      replaceAfterRename: true,
      expectedRule: "CONFIG-G08-BUNDLE_WRITE",
    },
    {
      name: "saved foreign field change fails after valid temporary round-trip",
      options: { savedBundleMutation: "foreign-field" },
      savedBundleChanged: true,
      expectedRule: "CONFIG-G08-SOPS-ROUNDTRIP",
    },
    {
      name: "saved migrator mismatch fails after valid temporary round-trip",
      options: { savedBundleMutation: "wrong-migrator-map" },
      savedBundleChanged: true,
      expectedRule: "CONFIG-G08-SOPS-ROUNDTRIP",
    },
  ];
  const systemIdentifier = "7613370342949990434";
  let queries = [];
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "end", async () => {});
  t.mock.method(Client.prototype, "query", async (sql) => {
    queries.push(sql);
    if (sql.includes("pg_control_system()"))
      return {
        rows: [
          {
            current_database: "postgres",
            current_user: "coffeeuser",
            server_version: "17.11 (fixture)",
            server_version_num: "170011",
            is_superuser: true,
            system_identifier: systemIdentifier,
          },
        ],
      };
    if (sql.startsWith("SELECT rolname,")) return { rows: [] };
    assert.fail("invalid temporary bundle must fail before transaction");
  });

  for (const scenario of cases) {
    const { fixture, evidenceDir, contextPath } =
      await createMigrationLaunchFixture();
    const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
    const originalBundle = await readFile(bundlePath);
    const originalSha = createHash("sha256")
      .update(originalBundle)
      .digest("hex");
    const foreignReplacement = Buffer.from("foreign bundle replacement\n");
    let renameMock;
    try {
      await installFakeMigrationSops(fixture, scenario.options);
      if (scenario.replaceAfterRename) {
        const originalRename = fsPromises.rename.bind(fsPromises);
        renameMock = t.mock.method(
          fsPromises,
          "rename",
          async (sourcePath, targetPath) => {
            await originalRename(sourcePath, targetPath);
            if (resolve(String(targetPath)) === bundlePath) {
              await rm(bundlePath);
              await writeFile(bundlePath, foreignReplacement, { mode: 0o600 });
              await chmod(bundlePath, 0o600);
            }
          },
        );
        syncBuiltinESMExports();
      }
      queries = [];
      await assert.rejects(
        prepareCanonicalMigratorRoles({
          root: fixture.root,
          contextPath,
          env: fixture.env,
          expectedSystemIdentifier: systemIdentifier,
        }),
        (error) => {
          if (scenario.expectedRule) {
            assert.equal(error.ruleId, scenario.expectedRule);
            assert.equal(error.facts, undefined);
            assert.equal(error.message.includes("canary"), false);
            return true;
          }
          assert.equal(error.ruleId, "CONFIG-G08-SOPS-OUTPUT");
          assert.equal(error.facts.validationStage, scenario.validationStage);
          assert.deepEqual(
            Object.keys(error.facts).sort((left, right) =>
              left.localeCompare(right),
            ),
            scenario.ruleId
              ? ["ruleId", "validationStage"]
              : ["validationStage"],
          );
          if (scenario.ruleId)
            assert.equal(error.facts.ruleId, scenario.ruleId);
          assert.equal(JSON.stringify(error.facts).includes("canary"), false);
          assert.equal(error.message.includes("canary"), false);
          return true;
        },
        scenario.name,
      );
      const currentBundle = await readFile(bundlePath);
      const currentBundleSha = createHash("sha256")
        .update(currentBundle)
        .digest("hex");
      if (scenario.replaceAfterRename)
        assert.equal(
          currentBundleSha,
          createHash("sha256").update(foreignReplacement).digest("hex"),
        );
      else if (scenario.savedBundleChanged)
        assert.notEqual(currentBundleSha, originalSha);
      else assert.equal(currentBundleSha, originalSha);
      if (scenario.replaceAfterRename) {
        assert.deepEqual(await readFile(bundlePath), foreignReplacement);
        assert.equal(
          (await readdir(join(fixture.bin))).includes("g08-encrypt-invoked"),
          true,
        );
      }
      if (scenario.savedBundleChanged)
        assert.equal(
          (await readdir(join(fixture.bin))).includes("g08-encrypt-invoked"),
          true,
        );
      if (scenario.savedBundleChanged) {
        assert.equal(
          currentBundle.toString("utf8").includes("foreign-saved-canary"),
          false,
        );
        const args = JSON.parse(
          await readFile(
            join(fixture.bin, "g08-temp-decrypt-args.json"),
            "utf8",
          ),
        );
        assert.deepEqual(args.slice(0, -1), [
          "--decrypt",
          "--input-type",
          "yaml",
          "--output-type",
          "yaml",
        ]);
        assert.match(
          args.at(-1),
          /\.platform\.secrets\.sops\.yaml\.[^/]+\.tmp$/u,
        );
      }
      assert.deepEqual(
        (await readdir(join(fixture.root, "secrets"))).sort(),
        ["platform-secrets.schema.json", "platform.secrets.sops.yaml"].sort(),
      );
      if (scenario.validationStage?.startsWith("temporary-")) {
        const args = JSON.parse(
          await readFile(
            join(fixture.bin, "g08-temp-decrypt-args.json"),
            "utf8",
          ),
        );
        assert.deepEqual(args.slice(0, -1), [
          "--decrypt",
          "--input-type",
          "yaml",
          "--output-type",
          "yaml",
        ]);
        assert.equal(typeof args.at(-1), "string");
        assert.ok(args.at(-1).startsWith(join(fixture.root, "secrets", ".")));
        assert.match(
          args.at(-1),
          /\.platform\.secrets\.sops\.yaml\.[^/]+\.tmp$/u,
        );
      }
      assert.ok(queries.some((sql) => sql.startsWith("SELECT rolname,")));
      assert.equal(queries.includes("BEGIN"), false);
      assert.equal(
        queries.some((sql) => sql.startsWith("CREATE ROLE ")),
        false,
      );
    } finally {
      if (renameMock) {
        renameMock.mock.restore();
        syncBuiltinESMExports();
      }
      await rm(evidenceDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
      await rm(fixture.bin, { recursive: true, force: true });
    }
  }
});

void test("config-bootstrap CLI rejects an unknown runtime before invoking SOPS", async () => {
  const root = await mkdtemp("/dev/shm/coffee-bootstrap-cli-");
  const bin = join(root, "bin");
  const marker = join(root, "sops-invoked");
  const fakeSops = join(bin, "sops");
  try {
    await mkdir(bin, { recursive: true });
    await writeFile(
      fakeSops,
      `#!/bin/sh\nprintf invoked > '${marker}'\nprintf '{}'\n`,
      { mode: 0o700 },
    );
    await chmod(fakeSops, 0o700);

    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, "tools/config-bootstrap/index.mjs"),
        "--runtime",
        "not-a-configured-runtime",
      ],
      {
        cwd: REPO_ROOT,
        env: { PATH: bin },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /config-bootstrap: FAIL: CONFIG-RUNTIME not-a-configured-runtime: unknown runtime/u,
    );
    await assert.rejects(stat(marker), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("edge-nginx materialization validates TLS identity and replaces the five scoped PEM files", async () => {
  const fixture = await createSecretMaterializationFixture();
  const outputDir = join(fixture.root, "nginx-output");
  const secretDir = join(outputDir, "edge-nginx");
  const logPath = join(fixture.root, "docker-args.jsonl");
  const dockerPath = join(fixture.bin, "docker");
  const filenames = [
    "public.crt",
    "public.key",
    "upstream-ca.crt",
    "client.crt",
    "client.key",
  ];
  const oldPath = process.env.PATH;
  const oldDockerLog = process.env.FAKE_DOCKER_LOG;
  const identityDir = join(fixture.root, "identities");
  const makeIdentity = async (name, subject, subjectAltName) => {
    const keyPath = join(identityDir, `${name}.key`);
    const certPath = join(identityDir, `${name}.crt`);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        subject,
        "-days",
        "1",
        "-addext",
        `subjectAltName=${subjectAltName}`,
      ],
      { stdio: "ignore" },
    );
    return {
      keyPem: await readFile(keyPath, "utf8"),
      certPem: await readFile(certPath, "utf8"),
    };
  };
  try {
    await mkdir(identityDir, { recursive: true });
    const publicIdentity = await makeIdentity(
      "public",
      "/CN=localhost",
      "DNS:localhost",
    );
    const wrongHostIdentity = await makeIdentity(
      "wrong-host",
      "/CN=other.invalid",
      "DNS:other.invalid",
    );
    const clientIdentity = await makeIdentity(
      "client",
      "/CN=edge-nginx",
      "URI:spiffe://coffee-platform/development/edge-nginx",
    );
    const wrongClientSan = await makeIdentity(
      "wrong-client-san",
      "/CN=edge-nginx",
      "URI:spiffe://coffee-platform/development/other",
    );
    await writeFile(
      join(fixture.bin, "docker"),
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    await writeFile(logPath, "", "utf8");
    process.env.PATH = `${fixture.bin}:${oldPath ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;

    const validDocument = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    validDocument.environments.development.edge.tlsPrivateKey =
      publicIdentity.keyPem;
    validDocument.environments.development.edge.tlsCertificate =
      publicIdentity.certPem;
    validDocument.environments.development.security.serviceTransportKeys[
      "edge-nginx"
    ] = JSON.stringify({
      caPem: publicIdentity.certPem,
      certPem: clientIdentity.certPem,
      keyPem: clientIdentity.keyPem,
    });
    await writeFile(fixture.plainPath, JSON.stringify(validDocument), "utf8");
    const expectedContents = {
      "public.crt": publicIdentity.certPem,
      "public.key": publicIdentity.keyPem,
      "upstream-ca.crt": publicIdentity.certPem,
      "client.crt": clientIdentity.certPem,
      "client.key": clientIdentity.keyPem,
    };
    const emptyOutputDir = join(fixture.root, "empty-nginx-output");
    const emptySecretDir = join(emptyOutputDir, "edge-nginx");
    await assert.rejects(
      stat(emptySecretDir),
      (error) => error.code === "ENOENT",
    );
    const emptyMaterialization = await materializeRuntimeSecrets({
      root: fixture.root,
      runtime: "edge-nginx",
      outputDir: emptyOutputDir,
      env: fixture.env,
    });
    assert.deepEqual(emptyMaterialization.files, filenames);
    assert.equal(emptyMaterialization.path, emptySecretDir);
    for (const name of filenames) {
      const path = join(emptySecretDir, name);
      const metadata = await stat(path);
      assert.equal(metadata.uid, process.getuid());
      assert.equal(metadata.mode & 0o777, 0o400);
      assert.equal(await readFile(path, "utf8"), expectedContents[name]);
    }
    assert.deepEqual(
      (await readdir(emptySecretDir)).sort(),
      [...filenames].sort(),
    );

    await mkdir(secretDir, { recursive: true });
    for (const name of filenames) {
      const path = join(secretDir, name);
      await writeFile(path, "stale fixture PEM", { mode: 0o400 });
    }
    const first = await materializeRuntimeSecrets({
      root: fixture.root,
      runtime: "edge-nginx",
      outputDir,
      env: fixture.env,
    });
    assert.deepEqual(first.files, filenames);
    assert.equal(first.path, secretDir);
    for (const name of filenames) {
      const path = join(secretDir, name);
      const metadata = await stat(path);
      assert.equal(metadata.uid, process.getuid());
      assert.equal(metadata.mode & 0o777, 0o400);
      assert.equal(await readFile(path, "utf8"), expectedContents[name]);
    }
    assert.deepEqual((await readdir(secretDir)).sort(), [...filenames].sort());

    await materializeRuntimeSecrets({
      root: fixture.root,
      runtime: "edge-nginx",
      outputDir,
      env: fixture.env,
    });
    for (const name of filenames) {
      const path = join(secretDir, name);
      assert.equal(await readFile(path, "utf8"), expectedContents[name]);
      assert.equal((await stat(path)).mode & 0o777, 0o400);
    }
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 6);
    for (const args of calls) {
      assert.equal(args[0], "run");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.equal(args.includes("--read-only"), true);
      assert.equal(
        args.filter((value) => value.startsWith("type=bind,source=")).length,
        filenames.length,
      );
    }
    assert.equal(calls[0][calls[0].indexOf("--user") + 1], "0:0");
    assert.equal(calls[1][calls[1].indexOf("--user") + 1], "101:101");

    const invalidCases = [
      ["public hostname mismatch", wrongHostIdentity, clientIdentity, "valid"],
      [
        "public key mismatch",
        publicIdentity,
        clientIdentity,
        "valid",
        wrongHostIdentity.keyPem,
      ],
      ["client SPIFFE mismatch", publicIdentity, wrongClientSan, "valid"],
      [
        "client key mismatch",
        publicIdentity,
        clientIdentity,
        "valid",
        undefined,
        wrongClientSan.keyPem,
      ],
      [
        "malformed transport shape",
        publicIdentity,
        clientIdentity,
        "extra-key",
      ],
    ];
    for (const [
      label,
      publicValue,
      clientValue,
      transportShape,
      publicKeyOverride,
      clientKeyOverride,
    ] of invalidCases) {
      const document = JSON.parse(await readFile(fixture.plainPath, "utf8"));
      const environment = document.environments.development;
      environment.edge.tlsPrivateKey = publicKeyOverride ?? publicValue.keyPem;
      environment.edge.tlsCertificate = publicValue.certPem;
      const transport =
        transportShape === "extra-key"
          ? {
              caPem: publicIdentity.certPem,
              certPem: clientValue.certPem,
              keyPem: clientKeyOverride ?? clientValue.keyPem,
              unexpected: "x",
            }
          : {
              caPem: publicIdentity.certPem,
              certPem: clientValue.certPem,
              keyPem: clientKeyOverride ?? clientValue.keyPem,
            };
      environment.security.serviceTransportKeys["edge-nginx"] =
        JSON.stringify(transport);
      await writeFile(fixture.plainPath, JSON.stringify(document), "utf8");
      const rejectedOutput = join(
        fixture.root,
        `rejected-${label.replaceAll(" ", "-")}`,
      );
      await assert.rejects(
        materializeRuntimeSecrets({
          root: fixture.root,
          runtime: "edge-nginx",
          outputDir: rejectedOutput,
          env: fixture.env,
        }),
        (error) => error.ruleId === "CONFIG-NGINX-SECRET",
        label,
      );
      await assert.rejects(
        stat(rejectedOutput),
        (error) => error.code === "ENOENT",
      );
    }
    assert.equal(
      (await readFile(logPath, "utf8")).trim().split("\n").length,
      6,
      "invalid identities must fail before Docker",
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldDockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = oldDockerLog;
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

void test("nginx ownership helper uses only its pinned offline ownership and readonly verification commands", async () => {
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const root = await mkdtemp("/dev/shm/coffee-nginx-ownership-contract-");
  const bin = join(root, "bin");
  const input = join(root, "input");
  const logPath = join(root, "docker-args.jsonl");
  const files = [
    "public.crt",
    "public.key",
    "upstream-ca.crt",
    "client.crt",
    "client.key",
  ];
  const fakeDocker = join(bin, "docker");
  const environmentKeys = ["PATH", "FAKE_DOCKER_LOG", "FAKE_DOCKER_FAIL_USER"];
  const previous = new Map(
    environmentKeys.map((key) => [key, process.env[key]]),
  );
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(input, { recursive: true });
    for (const name of files)
      await writeFile(join(input, name), "synthetic PEM fixture");
    await writeFile(
      fakeDocker,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
const userIndex = args.indexOf('--user');
if (process.env.FAKE_DOCKER_FAIL_USER && args[userIndex + 1] === process.env.FAKE_DOCKER_FAIL_USER) process.exit(17);
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}:${previous.get("PATH") ?? ""}`;
    process.env.FAKE_DOCKER_LOG = logPath;
    delete process.env.FAKE_DOCKER_FAIL_USER;

    await ensureNginxSecretOwnership(input);
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    const [ownership, verification] = calls;
    for (const args of calls) {
      assert.equal(args[0], "run");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      assert.equal(args.includes("--read-only"), true);
      assert.ok(args.includes(toolchain.nodeImage));
      assert.equal(
        args.filter((value) => value.startsWith("type=bind,source=")).length,
        files.length,
      );
    }
    assert.equal(ownership[ownership.indexOf("--user") + 1], "0:0");
    const capabilityValues = ownership.flatMap((value, index) =>
      value === "--cap-add" ? [ownership[index + 1]] : [],
    );
    assert.deepEqual(capabilityValues, ["CHOWN", "FOWNER"]);
    const ownershipScript = ownership[ownership.indexOf("sh") + 2];
    assert.match(ownershipScript, /chown 101:101/u);
    assert.match(ownershipScript, /chmod 0400/u);
    assert.equal(verification[verification.indexOf("--user") + 1], "101:101");
    assert.equal(verification.includes("--cap-add"), false);
    assert.ok(
      verification.some(
        (value) =>
          value.includes("s.uid!==101") &&
          value.includes("s.gid!==101") &&
          value.includes("0o400"),
      ),
    );
    assert.ok(verification.some((value) => value.includes("readonly")));

    await writeFile(logPath, "", "utf8");
    process.env.FAKE_DOCKER_FAIL_USER = "0:0";
    await assert.rejects(
      ensureNginxSecretOwnership(input),
      (error) => error.status === 17,
    );
    const failedOwnership = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      failedOwnership.length,
      1,
      "a failed ownership step must not launch the verifier",
    );

    await writeFile(logPath, "", "utf8");
    process.env.FAKE_DOCKER_FAIL_USER = "101:101";
    await assert.rejects(
      ensureNginxSecretOwnership(input),
      (error) => error.status === 17,
    );
    const failedVerification = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      failedVerification.length,
      2,
      "verification failure must propagate after the ownership command",
    );
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

void test("G16 migrator and finalizer bind the run database, server identity, and canonical role before SQL effects", async (t) => {
  const fixture = await createSecretMaterializationFixture();
  const runId = "20261024T185200Z-fac5678";
  const owner = "orders";
  const host = "127.0.0.1";
  const port = 55433;
  const systemIdentifier = "7123456789012345678";
  const database = `coffee_verify_${runId.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}_${owner}`;
  const ownership = JSON.parse(
    await readFile(
      join(fixture.root, "config/database-ownership.json"),
      "utf8",
    ),
  );
  const roleMap = JSON.parse(
    await readFile(join(fixture.root, "config/database-role-map.json"), "utf8"),
  );
  const ownerRecord = ownership.databases.find(
    (entry) => entry.owner === owner,
  );
  const roleDatabase = roleMap.databases.find(
    (entry) => entry.name === ownerRecord.name,
  );
  const toolchain = JSON.parse(
    await readFile(
      join(fixture.root, "config/toolchain-versions.json"),
      "utf8",
    ),
  );
  const fake = {
    systemIdentifier,
    serverVersion: toolchain.postgresql,
    connections: [],
    queries: [],
    ends: 0,
    failEnd: false,
    migratorIdentity: null,
  };
  t.mock.method(Client.prototype, "connect", async function () {
    fake.connections.push({
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      ssl: this.ssl,
    });
  });
  t.mock.method(Client.prototype, "query", async function (sql) {
    fake.queries.push({ database: this.database, sql });
    if (sql.startsWith("SELECT current_database()"))
      return {
        rows: [
          {
            current_database: this.database,
            current_user: "postgres",
            server_version: fake.serverVersion,
            system_identifier: fake.systemIdentifier,
          },
        ],
      };
    if (sql === "SELECT current_user, session_user")
      return {
        rows: [
          fake.migratorIdentity ?? {
            current_user: roleDatabase.migratorRole,
            session_user: "postgres",
          },
        ],
      };
    return { rows: [] };
  });
  t.mock.method(Client.prototype, "end", async function () {
    fake.ends += 1;
    if (fake.failEnd) throw new Error("synthetic end failure");
  });

  try {
    const migrator = await openAromaSandboxMigrator({
      root: fixture.root,
      runId,
      owner,
      host,
      port,
      expectedSystemIdentifier: systemIdentifier,
      env: fixture.env,
    });
    assert.deepEqual(fake.connections[0], {
      host,
      port,
      database,
      user: "postgres",
      ssl: false,
    });
    assert.deepEqual(
      fake.queries.slice(0, 4).map(({ sql }) => sql),
      [
        "SELECT current_database(), current_user, current_setting('server_version') AS server_version, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier",
        `SET ROLE "${roleDatabase.migratorRole}"`,
        `SET search_path = "${roleDatabase.schema}", pg_catalog`,
        "SELECT current_user, session_user",
      ],
    );
    assert.equal(
      fake.ends,
      0,
      "the returned migrator connection remains caller-owned",
    );
    await migrator.end();
    assert.equal(fake.ends, 1);

    fake.systemIdentifier = "8123456789012345678";
    fake.failEnd = true;
    const beforeMismatch = fake.queries.length;
    await assert.rejects(
      openAromaSandboxMigrator({
        root: fixture.root,
        runId,
        owner,
        host,
        port,
        expectedSystemIdentifier: systemIdentifier,
        env: fixture.env,
      }),
      (error) => {
        assert.match(error.message, /CONFIG-G16-MIGRATOR_TARGET_MISMATCH/u);
        assert.doesNotMatch(error.message, /synthetic end failure/u);
        return true;
      },
    );
    assert.equal(
      fake.queries.length - beforeMismatch,
      1,
      "identity mismatch must precede SET ROLE",
    );
    assert.equal(fake.ends, 2, "failed open must close its client");

    fake.systemIdentifier = systemIdentifier;
    fake.failEnd = true;
    const finalized = await finalizeAromaSandboxDatabase({
      root: fixture.root,
      runId,
      owner,
      host,
      port,
      expectedSystemIdentifier: systemIdentifier,
      env: fixture.env,
    });
    assert.deepEqual(finalized, {
      owner,
      database,
      migratorRole: roleDatabase.migratorRole,
      systemIdentifier,
    });
    const finalizeQueries = fake.queries.slice(beforeMismatch + 1);
    assert.equal(
      finalizeQueries[0].sql.startsWith("SELECT current_database()"),
      true,
    );
    assert.ok(
      finalizeQueries[1].sql.includes(
        `CREATE SCHEMA IF NOT EXISTS "${roleDatabase.schema}" AUTHORIZATION "${roleDatabase.migratorRole}"`,
      ),
    );
    assert.equal(fake.connections.at(-1).database, database);
    assert.equal(fake.connections.at(-1).user, "postgres");
    assert.equal(fake.ends, 3, "finalizer closes its admin connection");

    fake.systemIdentifier = "8123456789012345678";
    fake.failEnd = true;
    const beforeFinalizeMismatch = fake.queries.length;
    await assert.rejects(
      finalizeAromaSandboxDatabase({
        root: fixture.root,
        runId,
        owner,
        host,
        port,
        expectedSystemIdentifier: systemIdentifier,
        env: fixture.env,
      }),
      (error) => {
        assert.match(error.message, /CONFIG-G16-FINALIZE-TARGET_MISMATCH/u);
        assert.doesNotMatch(error.message, /synthetic end failure/u);
        return true;
      },
    );
    assert.equal(
      fake.queries.length - beforeFinalizeMismatch,
      1,
      "finalize mismatch must precede database DDL",
    );
    assert.equal(fake.ends, 4);

    for (const scenario of [
      {
        label: "wrong current_user after SET ROLE",
        identity: { current_user: "postgres", session_user: "postgres" },
      },
      {
        label: "wrong session_user after SET ROLE",
        identity: {
          current_user: roleDatabase.migratorRole,
          session_user: "foreign_bootstrap",
        },
      },
    ]) {
      const { label, identity } = scenario;
      fake.systemIdentifier = systemIdentifier;
      fake.migratorIdentity = identity;
      const queryStart = fake.queries.length;
      const connectionStart = fake.connections.length;
      const endsStart = fake.ends;
      await assert.rejects(
        openAromaSandboxMigrator({
          root: fixture.root,
          runId,
          owner,
          host,
          port,
          expectedSystemIdentifier: systemIdentifier,
          env: fixture.env,
        }),
        (error) => {
          assert.match(error.message, /CONFIG-G16-MIGRATOR_ROLE_MISMATCH/u);
          return true;
        },
        label,
      );
      assert.equal(fake.connections.length, connectionStart + 1, label);
      assert.equal(
        fake.ends,
        endsStart + 1,
        `${label}: failed client is closed`,
      );
      assert.deepEqual(
        fake.queries.slice(queryStart).map(({ sql }) => sql),
        [
          "SELECT current_database(), current_user, current_setting('server_version') AS server_version, (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier",
          `SET ROLE "${roleDatabase.migratorRole}"`,
          `SET search_path = "${roleDatabase.schema}", pg_catalog`,
          "SELECT current_user, session_user",
        ],
        `${label}: no caller work follows the failed role proof`,
      );
    }
    fake.migratorIdentity = null;

    const platformPath = join(fixture.root, "config/platform.yaml");
    const platform = parseYaml(await readFile(platformPath, "utf8"), {
      json: true,
    });
    platform.environment = "production";
    platform.telemetry.releaseDigest = `sha256:${"0".repeat(64)}`;
    await writeFile(platformPath, dumpYaml(platform), "utf8");
    const connectionCount = fake.connections.length;
    await assert.rejects(
      openAromaSandboxMigrator({
        root: fixture.root,
        runId,
        owner,
        host,
        port,
        expectedSystemIdentifier: systemIdentifier,
        env: fixture.env,
      }),
      /CONFIG-G16-ENVIRONMENT/u,
    );
    await assert.rejects(
      finalizeAromaSandboxDatabase({
        root: fixture.root,
        runId,
        owner,
        host,
        port,
        expectedSystemIdentifier: systemIdentifier,
        env: fixture.env,
      }),
      /CONFIG-G16-ENVIRONMENT/u,
    );
    assert.equal(
      fake.connections.length,
      connectionCount,
      "production targets must be rejected before connecting",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

function valueAtPath(root, ref) {
  return ref
    .split(".")
    .reduce(
      (value, key) =>
        value !== null && typeof value === "object" ? value[key] : undefined,
      root,
    );
}

function setValueAtPath(root, ref, value) {
  const parts = ref.split(".");
  const parent = parts
    .slice(0, -1)
    .reduce((current, key) => current[key], root);
  parent[parts.at(-1)] = value;
}

void test("trusted bootstrap returns only provisioned Tasty credentials", async () => {
  const fixture = await createSecretMaterializationFixture();
  try {
    await assert.rejects(
      readTastyCredentials({ root: fixture.root, env: fixture.env }),
      /CONFIG-TASTY-CREDENTIAL/,
    );
    const path = join(fixture.root, "secrets/platform.secrets.sops.yaml");
    const encrypted = JSON.parse(await readFile(path, "utf8"));
    encrypted.environments.development.tasty = {
      login: "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]",
      password: "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]",
    };
    await writeFile(path, JSON.stringify(encrypted));
    const plaintext = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    plaintext.environments.development.tasty = {
      login: "fixture-login",
      password: "fixture-password",
    };
    await writeFile(fixture.plainPath, JSON.stringify(plaintext));
    assert.deepEqual(
      await readTastyCredentials({ root: fixture.root, env: fixture.env }),
      { login: "fixture-login", password: "fixture-password" },
    );
    plaintext.environments.development.tasty.password = "";
    await writeFile(fixture.plainPath, JSON.stringify(plaintext));
    await assert.rejects(
      readTastyCredentials({ root: fixture.root, env: fixture.env }),
      /CONFIG-SOPS-PLAINTEXT/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
  }
});

async function createSecretMaterializationFixture() {
  const root = await mkdtemp("/dev/shm/coffee-observability-secret-fixture-");
  const bin = await mkdtemp("/dev/shm/coffee-observability-sops-bin-");
  const plainPath = join(bin, "decrypted.json");
  const invokedPath = join(bin, "sops-invoked");
  try {
    for (const path of ["config", "platform"])
      await cp(`${REPO_ROOT}/${path}`, `${root}/${path}`, { recursive: true });
    await mkdir(`${root}/secrets`, { recursive: true });
    await cp(
      `${REPO_ROOT}/secrets/platform-secrets.schema.json`,
      `${root}/secrets/platform-secrets.schema.json`,
    );
    await cp(`${REPO_ROOT}/.sops.yaml`, `${root}/.sops.yaml`);
    const encrypted = syntheticEncryptedSecrets();
    for (const environment of Object.values(encrypted.environments)) {
      environment.telemetry.grafanaAdmin =
        "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]";
    }
    await writeFile(
      `${root}/secrets/platform.secrets.sops.yaml`,
      JSON.stringify(encrypted),
      "utf8",
    );
    const decrypted = structuredClone(encrypted);
    delete decrypted.sops;
    const replaceEncrypted = (value) => {
      if (Array.isArray(value)) return value.map(replaceEncrypted);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [
            key,
            replaceEncrypted(child),
          ]),
        );
      return typeof value === "string" && value.startsWith("ENC[")
        ? "fixture-secret-value"
        : value;
    };
    await writeFile(
      plainPath,
      JSON.stringify(replaceEncrypted(decrypted)),
      "utf8",
    );
    await writeFile(
      join(bin, "sops"),
      `#!/bin/sh\n: > '${invokedPath}'\ncat '${plainPath}'\n`,
      { mode: 0o700 },
    );
    await chmod(join(bin, "sops"), 0o700);
    return {
      root,
      bin,
      plainPath,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}` },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
    throw error;
  }
}

async function createBrowserLaunchFixture({
  mutateConfig,
  extraTrackedFile,
} = {}) {
  const launch = await createMigrationLaunchFixture();
  const { fixture, evidenceDir, contextPath } = launch;
  try {
    const configPath = join(fixture.root, "config/platform.yaml");
    const configText = fixtureConfigText(await readFile(configPath, "utf8"));
    const candidateConfig = mutateConfig
      ? mutateConfig(configText)
      : configText;
    await writeFile(configPath, candidateConfig, "utf8");
    if (extraTrackedFile)
      await writeFile(join(fixture.root, extraTrackedFile), "fixture\n");
    execFileSync(
      "git",
      [
        "add",
        "config/platform.yaml",
        ...(extraTrackedFile ? [extraTrackedFile] : []),
      ],
      {
        cwd: fixture.root,
      },
    );
    execFileSync(
      "git",
      ["commit", "-qm", "G15 verification OIDC config variant"],
      {
        cwd: fixture.root,
      },
    );
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    const baseConfigSha256 = createHash("sha256")
      .update(await readFile(configPath))
      .digest("hex");
    await chmod(contextPath, 0o600);
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: launch.runId,
        candidateSha,
        baseConfigSha256,
        sourceRepoRoot: REPO_ROOT,
        evidenceDir,
        checkoutDir: fixture.root,
      }),
      { mode: 0o400, flag: "w" },
    );
    await chmod(contextPath, 0o400);
    return { ...launch, baseCandidateSha: launch.candidateSha, candidateSha };
  } catch (error) {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    throw error;
  }
}

async function createBrowserChildMigrationLaunchFixture(
  parent,
  { mutateConfig, skipLineageValidation = false } = {},
) {
  const childRoot = await mkdtemp(
    "/dev/shm/coffee-observability-g15-child-fixture-",
  );
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  let evidenceDir;
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        parent.fixture.root,
        childRoot,
      ],
      { stdio: "ignore" },
    );
    await chmod(join(childRoot, "secrets/platform.secrets.sops.yaml"), 0o400);
    await chmod(join(childRoot, "config/platform.yaml"), 0o644);
    execFileSync(
      "git",
      [
        "remote",
        "set-url",
        "origin",
        "https://github.com/YurGusev/CoffeeOrderPlatform",
      ],
      { cwd: childRoot, stdio: "ignore" },
    );
    const configPath = join(childRoot, "config/platform.yaml");
    let configText = fixtureConfigText(await readFile(configPath, "utf8"));
    if (mutateConfig) configText = mutateConfig(configText);
    await writeFile(configPath, configText, "utf8");
    execFileSync("git", ["add", "--", "config/platform.yaml"], {
      cwd: childRoot,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=G15 fixture",
        "-c",
        "user.email=g15@example.invalid",
        "commit",
        "-qm",
        "G15 exact OIDC fixture",
      ],
      { cwd: childRoot, stdio: "ignore" },
    );
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: childRoot,
      encoding: "utf8",
    }).trim();
    const baseConfigSha256 = createHash("sha256")
      .update(await readFile(configPath))
      .digest("hex");
    const runId = `${timestamp}-${candidateSha.slice(0, 7)}`;
    evidenceDir = join(REPO_ROOT, "evidence/launch", runId);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const contextPath = join(evidenceDir, "context.json");
    const context = {
      schemaVersion: 1,
      runId,
      candidateSha,
      baseConfigSha256,
      sourceRepoRoot: REPO_ROOT,
      evidenceDir,
      checkoutDir: childRoot,
      acceptedBaseCommit: parent.candidateSha,
      startedAtUtc: new Date().toISOString(),
      githubSnapshotPath: null,
      resources: {
        composeProject: `coffee-launch-${runId.toLowerCase()}`,
        g08PreparationContextPath: parent.contextPath,
        g15ParentCandidateSha: parent.candidateSha,
        g15ParentCheckoutRoot: parent.fixture.root,
        g15ParentRunId: parent.runId,
        kafkaPrefix: runId,
      },
    };
    await writeFile(contextPath, JSON.stringify(context), { mode: 0o400 });
    await chmod(contextPath, 0o400);
    await validateLaunchContext(contextPath);
    if (!skipLineageValidation)
      await validateBrowserFixtureLineage({
        root: REPO_ROOT,
        contextPath,
        baseCandidateSha: parent.candidateSha,
      });
    return { root: childRoot, runId, candidateSha, contextPath, evidenceDir };
  } catch (error) {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
    throw error;
  }
}

void test("G15 generated child clone replaces its local origin before context validation", async (t) => {
  const launch = await createBrowserLaunchFixture();
  const runId = `${new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z-${randomBytes(4).toString("hex").slice(0, 7)}`;
  const childRoot = await mkdtemp(join(tmpdir(), "g15-origin-child-"));
  const evidenceDir = join(REPO_ROOT, "evidence/launch", runId);
  const contextPath = join(evidenceDir, "context.json");
  t.after(async () => {
    await rm(launch.evidenceDir, { recursive: true, force: true });
    await rm(launch.fixture.root, { recursive: true, force: true });
    await rm(launch.fixture.bin, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
    await rm(evidenceDir, { recursive: true, force: true });
  });
  execFileSync(
    "git",
    [
      "clone",
      "--quiet",
      "--shared",
      "--no-hardlinks",
      launch.fixture.root,
      childRoot,
    ],
    { stdio: "ignore" },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: childRoot,
    encoding: "utf8",
  }).trim();
  const configBytes = await readFile(join(childRoot, "config/platform.yaml"));
  const context = {
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
    sourceRepoRoot: REPO_ROOT,
    evidenceDir,
    checkoutDir: childRoot,
  };
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await writeFile(contextPath, JSON.stringify(context), { mode: 0o400 });
  await chmod(contextPath, 0o400);

  await assert.rejects(validateLaunchContext(contextPath));
  execFileSync(
    "git",
    [
      "remote",
      "set-url",
      "origin",
      "https://github.com/YurGusev/CoffeeOrderPlatform",
    ],
    { cwd: childRoot, stdio: "ignore" },
  );
  const validated = await validateLaunchContext(contextPath);
  assert.equal(validated.candidateRoot, childRoot);
  assert.equal(validated.context.candidateSha, candidateSha);
});

void test("G15 fixture lineage, tmpfs trust, and PKCE account switching stay isolated", async (t) => {
  const launch = await createBrowserLaunchFixture();
  const ingressCaDir = await mkdtemp("/dev/shm/g15-ingress-ca-");
  let materialized;
  let idpServer;
  try {
    const ingressCaKey = join(ingressCaDir, "public-ca.key");
    const ingressCaPath = join(ingressCaDir, "public-ca.crt");
    execFileSync(
      "/usr/bin/openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "2",
        "-keyout",
        ingressCaKey,
        "-out",
        ingressCaPath,
        "-subj",
        "/CN=G15 public ingress test CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
      ],
      { stdio: "ignore", timeout: 30000 },
    );
    await chmod(ingressCaKey, 0o400);
    await chmod(ingressCaPath, 0o400);
    const ingressPrivateKeyCanary = await readFile(ingressCaKey, "utf8");
    const publicIngressCaPem =
      (await readFile(ingressCaPath, "utf8")) + ingressPrivateKeyCanary;
    const canonicalIngressCaPem = new X509Certificate(
      publicIngressCaPem,
    ).toString();
    const lineage = await validateBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: launch.contextPath,
      baseCandidateSha: launch.baseCandidateSha,
    });
    assert.equal(lineage.profile, "verification-only-pkce-jwks-v1");
    assert.equal(lineage.issuer, "https://idp.fixture.invalid");
    assert.equal(
      lineage.receiptPath,
      join(
        launch.evidenceDir,
        "gates/G15_BROWSER/artifacts/oidc-fixture-lineage.json",
      ),
    );
    const lineageReceiptBytes = await readFile(lineage.receiptPath);
    const tamperedLineage = {
      ...JSON.parse(lineageReceiptBytes.toString("utf8")),
      issuer: "https://foreign.fixture.invalid",
    };
    await chmod(lineage.receiptPath, 0o600);
    await writeFile(lineage.receiptPath, JSON.stringify(tamperedLineage));
    await chmod(lineage.receiptPath, 0o400);
    await assert.rejects(
      readBrowserFixtureLineage({
        root: REPO_ROOT,
        contextPath: launch.contextPath,
        baseCandidateSha: launch.baseCandidateSha,
      }),
      { code: "G15_RECEIPT_STALE" },
    );
    await chmod(lineage.receiptPath, 0o600);
    await writeFile(lineage.receiptPath, lineageReceiptBytes);
    await chmod(lineage.receiptPath, 0o400);
    await assert.rejects(
      materializeBrowserFixture({
        root: REPO_ROOT,
        contextPath: launch.contextPath,
        lineageArtifactLoc: lineage.receiptPath,
        publicIngressCaPem,
        tmpfsRoot: "/tmp",
      }),
      { code: "G15_TMPFS_REQUIRED" },
    );
    await assert.rejects(
      materializeBrowserFixture({
        root: REPO_ROOT,
        contextPath: launch.contextPath,
        lineageArtifactLoc: lineage.receiptPath,
        publicIngressCaPem: "not a certificate",
      }),
      { code: "G15_INGRESS_CA_INVALID" },
    );
    const sentinelRoot = await mkdtemp("/dev/shm/g15-nss-sentinel-");
    const sentinelPath = join(sentinelRoot, "foreign-sentinel.txt");
    const sentinelBytes = Buffer.from("foreign tmpfs sentinel survives\n");
    await writeFile(sentinelPath, sentinelBytes, { mode: 0o600 });
    const childProcess = process.getBuiltinModule("node:child_process");
    const originalExecFileSync = childProcess.execFileSync.bind(childProcess);
    let partialFixtureRoot;
    let nssImportCalls = 0;
    let nssObservation;
    let nssReply;
    const nssFailureMock = t.mock.method(
      childProcess,
      "execFileSync",
      (...args) => {
        const [command, commandArgs] = args;
        if (command === "/usr/bin/python3") {
          nssImportCalls += 1;
          const databaseIndex = commandArgs.indexOf("--database");
          const nssDatabase =
            databaseIndex >= 0 ? commandArgs[databaseIndex + 1] : undefined;
          if (typeof nssDatabase === "string")
            partialFixtureRoot = resolve(nssDatabase, "../../../../../");
          const fs = process.getBuiltinModule("node:fs");
          nssObservation = {
            script: commandArgs[0],
            hasDatabaseArgument: databaseIndex >= 0,
            fixtureOnTmpfs:
              partialFixtureRoot?.startsWith("/dev/shm/") ?? false,
            publicCaMaterialized:
              typeof partialFixtureRoot === "string" &&
              fs.existsSync(
                join(partialFixtureRoot, "certs/public-ingress-ca.crt"),
              ),
            privateIdpMaterialized:
              typeof partialFixtureRoot === "string" &&
              fs.existsSync(join(partialFixtureRoot, "idp/idp.key")),
          };
          if (nssReply !== undefined) return Buffer.from(nssReply);
          throw new Error("synthetic NSS import failure");
        }
        return originalExecFileSync(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        materializeBrowserFixture({
          root: REPO_ROOT,
          contextPath: launch.contextPath,
          lineageArtifactLoc: lineage.receiptPath,
          publicIngressCaPem,
        }),
        { code: "G15_NSS_IMPORT_FAILED" },
      );
      assert.equal(nssImportCalls, 1);
      assert.equal(
        nssObservation.script.endsWith("/browser-nss-trust.py"),
        true,
      );
      assert.equal(nssObservation.hasDatabaseArgument, true);
      assert.equal(nssObservation.fixtureOnTmpfs, true);
      assert.equal(nssObservation.publicCaMaterialized, true);
      assert.equal(nssObservation.privateIdpMaterialized, true);
      assert.ok(partialFixtureRoot);
      await assert.rejects(stat(partialFixtureRoot), { code: "ENOENT" });
      assert.deepEqual(await readFile(sentinelPath), sentinelBytes);
      const validNssReceipt = {
        schemaVersion: 1,
        certificateCount: 2,
        sslTrustedCa: true,
        status: "PUBLIC_CA_IMPORTED",
      };
      for (const invalidReceipt of [
        "{invalid json",
        JSON.stringify({ ...validNssReceipt, extra: true }),
        JSON.stringify({ ...validNssReceipt, schemaVersion: 2 }),
        JSON.stringify({ ...validNssReceipt, certificateCount: 1 }),
        JSON.stringify({ ...validNssReceipt, sslTrustedCa: false }),
        JSON.stringify({ ...validNssReceipt, status: "FAILED" }),
      ]) {
        nssReply = invalidReceipt;
        partialFixtureRoot = undefined;
        await assert.rejects(
          materializeBrowserFixture({
            root: REPO_ROOT,
            contextPath: launch.contextPath,
            lineageArtifactLoc: lineage.receiptPath,
            publicIngressCaPem,
          }),
          { code: "G15_NSS_RECEIPT_INVALID" },
        );
        assert.ok(partialFixtureRoot);
        await assert.rejects(stat(partialFixtureRoot), { code: "ENOENT" });
        assert.deepEqual(await readFile(sentinelPath), sentinelBytes);
      }
    } finally {
      nssFailureMock.mock.restore();
      syncBuiltinESMExports();
      await rm(sentinelRoot, { recursive: true, force: true });
    }
    materialized = await materializeBrowserFixture({
      root: REPO_ROOT,
      contextPath: launch.contextPath,
      lineageArtifactLoc: lineage.receiptPath,
      publicIngressCaPem,
    });
    assert.equal(materialized.profile, "verification-only-pkce-jwks-v1");
    assert.equal(materialized.idp.hostname, "idp.fixture.invalid");
    assert.equal(
      materialized.browser.caCertificatePath.startsWith("/dev/shm/"),
      true,
    );
    assert.equal(
      materialized.publicIngressCaPath.startsWith("/dev/shm/"),
      true,
    );
    const importedIngressCa = await readFile(
      materialized.publicIngressCaPath,
      "utf8",
    );
    assert.equal(importedIngressCa, canonicalIngressCaPem);
    assert.equal(importedIngressCa.includes(ingressPrivateKeyCanary), false);
    assert.equal(importedIngressCa.includes("PRIVATE KEY"), false);
    await assert.rejects(
      materializeBrowserFixture({
        root: REPO_ROOT,
        contextPath: launch.contextPath,
        lineageArtifactLoc: lineage.receiptPath,
        publicIngressCaPem: await readFile(
          materialized.idp.certificatePath,
          "utf8",
        ),
      }),
      { code: "G15_INGRESS_CA_INVALID" },
    );
    assert.equal(
      materialized.browser.nssProfilePath.startsWith("/dev/shm/"),
      true,
    );
    assert.equal(Object.hasOwn(materialized, "caPrivateKey"), false);
    const browserEntries = await readdir(materialized.browser.nssProfilePath);
    assert.ok(browserEntries.includes("cert9.db"));
    assert.ok(browserEntries.includes("key4.db"));
    const browserHomeEntries = await readdir(materialized.browser.homePath, {
      recursive: true,
    });
    assert.equal(
      browserHomeEntries.some((entry) => /\.(?:key|pem)$/u.test(entry)),
      false,
    );
    for (const path of [
      materialized.browser.caCertificatePath,
      materialized.publicIngressCaPath,
      materialized.idp.certificatePath,
      materialized.idp.privateKeyPath,
      materialized.idp.jwksPath,
      materialized.idp.jwksPrivateKeyPath,
    ]) {
      const file = await stat(path);
      assert.equal(file.mode & 0o777, 0o400);
      assert.equal(file.uid, process.getuid());
    }
    assert.match(
      await readFile(materialized.idp.jwksPath, "utf8"),
      /"kid":"g15-fixture-rs256-v1"/u,
    );

    const profile = (await loadPlatformConfig(launch.fixture.root)).browserOidc;
    const [{ keys }, signingKeyPem, tlsKeyPem, tlsCertificatePem, caPem] =
      await Promise.all([
        readFile(materialized.idp.jwksPath, "utf8").then(JSON.parse),
        readFile(materialized.idp.jwksPrivateKeyPath, "utf8"),
        readFile(materialized.idp.privateKeyPath, "utf8"),
        readFile(materialized.idp.certificatePath, "utf8"),
        readFile(materialized.browser.caCertificatePath, "utf8"),
      ]);
    const [jwk] = keys;
    idpServer = createOidcProviderServer({
      tlsKeyPem,
      tlsCertificatePem,
      profile,
      signingKey: createPrivateKey(signingKeyPem),
      jwk,
      selectAccount: selectBrowserFixtureAccount,
    });
    await new Promise((resolve, reject) => {
      idpServer.once("error", reject);
      idpServer.listen(0, "127.0.0.1", resolve);
    });
    const idpPort = idpServer.address().port;
    const requestIdp = ({ method, path, cookie, body }) =>
      new Promise((resolve, reject) => {
        const request = https.request(
          {
            hostname: "idp.fixture.invalid",
            port: idpPort,
            path,
            method,
            ca: caPem,
            lookup: (_hostname, options, callback) => {
              const done = typeof options === "function" ? options : callback;
              if (typeof options === "object" && options.all)
                done(null, [{ address: "127.0.0.1", family: 4 }]);
              else done(null, "127.0.0.1", 4);
            },
            headers: {
              ...(cookie === undefined ? {} : { cookie }),
              ...(body === undefined
                ? {}
                : {
                    "content-type": "application/x-www-form-urlencoded",
                    "content-length": Buffer.byteLength(body),
                  }),
            },
          },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        request.on("error", reject);
        if (body !== undefined) request.write(body);
        request.end();
      });
    const beginAuthorization = async (cookie) => {
      const verifier = randomBytes(32).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      const state = randomBytes(16).toString("base64url");
      const parameters = new URLSearchParams({
        client_id: profile.clientId,
        redirect_uri: profile.redirectUri,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        nonce,
        state,
      });
      const response = await requestIdp({
        method: "GET",
        path: `/authorize?${parameters}`,
        cookie,
      });
      assert.equal(response.status, 302);
      const callback = new URL(response.headers.location);
      assert.equal(callback.searchParams.get("state"), state);
      return { code: callback.searchParams.get("code"), verifier, nonce };
    };
    const exchangeCode = async ({ code, verifier }, cookie) => {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: profile.clientId,
        redirect_uri: profile.redirectUri,
        code_verifier: verifier,
        code,
      }).toString();
      const response = await requestIdp({
        method: "POST",
        path: "/token",
        cookie,
        body,
      });
      assert.equal(response.status, 200, response.body);
      const { id_token: token } = JSON.parse(response.body);
      const [header, payload, signature] = token.split(".");
      assert.equal(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          createPublicKey({ key: jwk, format: "jwk" }),
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    };
    const restrictedCode = await beginAuthorization(
      "g15_fixture_account=restricted",
    );
    const restrictedToken = await exchangeCode(
      restrictedCode,
      "g15_fixture_account=operator",
    );
    assert.equal(restrictedToken.actor_ref, "actor:g15-browser-restricted");
    assert.deepEqual(restrictedToken.permissions, []);
    assert.equal(restrictedToken.nonce, restrictedCode.nonce);
    const operatorCode = await beginAuthorization(undefined);
    const operatorToken = await exchangeCode(
      operatorCode,
      "g15_fixture_account=restricted",
    );
    assert.equal(operatorToken.actor_ref, "actor:g15-browser-fixture");
    assert.deepEqual(operatorToken.permissions, [
      "customer:create",
      "customer:read",
      "catalog:read",
      "pricing:create",
      "orders:create",
      "orders:edit:any",
      "orders:confirm:any",
      "orders:read:any",
    ]);
    for (const cookie of [
      "g15_fixture_account=unknown",
      "g15_fixture_account=operator; g15_fixture_account=restricted",
      "unknown=value",
    ]) {
      const parameters = new URLSearchParams({
        client_id: profile.clientId,
        redirect_uri: profile.redirectUri,
        response_type: "code",
        code_challenge_method: "S256",
        code_challenge: "valid-shape",
        nonce: "nonce",
        state: "state",
      });
      const response = await requestIdp({
        method: "GET",
        path: `/authorize?${parameters}`,
        cookie,
      });
      assert.equal(response.status, 400);
    }
    idpServer.closeAllConnections();
    await new Promise((resolve) => idpServer.close(resolve));
    idpServer = undefined;

    const ownedFixtureRoot = materialized.fixtureRoot;
    const relocatedFixtureRoot = join(ingressCaDir, "owned-fixture-relocated");
    const replacementFixtureRoot = await mkdtemp(
      "/dev/shm/g15-fixture-replacement-",
    );
    const replacementCanary = join(replacementFixtureRoot, "canary.txt");
    await writeFile(replacementCanary, "replacement must survive cleanup\n");
    const originalIdentity = await lstat(ownedFixtureRoot);
    const replacementIdentity = await lstat(replacementFixtureRoot);
    await rename(ownedFixtureRoot, relocatedFixtureRoot);
    await rename(replacementFixtureRoot, ownedFixtureRoot);
    let cleanupError;
    try {
      await materialized.cleanup();
    } catch (error) {
      cleanupError = error;
    }
    let replacementCanaryContents;
    try {
      replacementCanaryContents = await readFile(
        join(ownedFixtureRoot, "canary.txt"),
        "utf8",
      );
    } catch {
      replacementCanaryContents = undefined;
    }
    const currentIdentity = await lstat(ownedFixtureRoot).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      currentIdentity?.isDirectory() &&
      !currentIdentity.isSymbolicLink() &&
      currentIdentity.dev === replacementIdentity.dev &&
      currentIdentity.ino === replacementIdentity.ino
    )
      await rm(ownedFixtureRoot, { recursive: true, force: false });
    const relocatedIdentity = await lstat(relocatedFixtureRoot);
    await rename(relocatedFixtureRoot, ownedFixtureRoot);
    const restoredIdentity = await lstat(ownedFixtureRoot);
    assert.equal(restoredIdentity.dev, originalIdentity.dev);
    assert.equal(restoredIdentity.ino, originalIdentity.ino);
    assert.equal(cleanupError?.code, "G15_FIXTURE_OWNERSHIP_CHANGED");
    assert.equal(
      replacementCanaryContents,
      "replacement must survive cleanup\n",
    );
    assert.equal(relocatedIdentity.dev, originalIdentity.dev);
    assert.equal(relocatedIdentity.ino, originalIdentity.ino);
    await materialized.cleanup();
    materialized = undefined;
    await assert.rejects(stat(ownedFixtureRoot), { code: "ENOENT" });
  } finally {
    if (idpServer) {
      idpServer.closeAllConnections();
      await new Promise((resolve) => idpServer.close(resolve));
    }
    if (materialized) await materialized.cleanup();
    await rm(ingressCaDir, { recursive: true, force: true });
    await rm(launch.evidenceDir, { recursive: true, force: true });
    await rm(launch.fixture.root, { recursive: true, force: true });
    await rm(launch.fixture.bin, { recursive: true, force: true });
  }
});

void test("G15 Compose wiring mounts only scoped fixture paths and trusts the IdP CA in Edge", async () => {
  const { writeScopedComposeOverride } =
    await import("../../tools/compose-smoke.mjs");
  const directory = await mkdtemp("/dev/shm/g15-compose-wiring-");
  const candidateRoot = join(directory, "candidate");
  const fixtureRoot = join(directory, "fixture");
  const contextPath = join(directory, "context.json");
  const caPath = join(fixtureRoot, "browser-home", "ca.crt");
  await mkdir(join(candidateRoot, "node_modules"), { recursive: true });
  await mkdir(join(fixtureRoot, "idp"), { recursive: true });
  await mkdir(join(fixtureRoot, "browser-home"), { recursive: true });
  await mkdir(join(fixtureRoot, "certs"), { recursive: true });
  await writeFile(contextPath, "{}\n", { mode: 0o400 });
  await writeFile(caPath, "PUBLIC-IDP-CA\n", { mode: 0o400 });
  await writeFile(join(fixtureRoot, "idp", "idp.key"), "PRIVATE-CANARY\n", {
    mode: 0o400,
  });
  const override = await writeScopedComposeOverride("g15-browser-wiring", {
    sharedPostgres: false,
    recoveryProof: true,
    launchContextPath: contextPath,
    browserFixture: {
      fixtureRoot,
      browser: { caCertificatePath: caPath },
    },
    candidateRoot,
  });
  try {
    const result = spawnSync(
      "docker",
      [
        "compose",
        "-p",
        "g15-browser-wiring",
        "-f",
        join(REPO_ROOT, "compose.yaml"),
        "-f",
        override,
        "config",
        "--format",
        "json",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COFFEE_COMPOSE_SECRETS_DIR: join(directory, "secrets"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    const idp = config.services["g15-idp"];
    assert.match(idp.image, /^node:26\.8\.1-trixie-slim@sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(idp.command, [
      "node",
      "/workspace/tests/realtime/fixtures/oidc-provider.mjs",
      "--serve-g15",
      "/workspace",
      "/run/g15-idp",
    ]);
    assert.equal(idp.user, "1000:1000");
    assert.equal(idp.read_only, true);
    assert.deepEqual(idp.cap_drop, ["ALL"]);
    assert.deepEqual(idp.security_opt, ["no-new-privileges:true"]);
    assert.equal(
      String(idp.sysctls["net.ipv4.ip_unprivileged_port_start"]),
      "0",
    );
    assert.equal(idp.pids_limit, 64);
    assert.ok(idp.cpus <= 1);
    assert.equal(idp.mem_limit, "268435456");
    assert.equal(idp.ports, undefined);
    assert.ok(
      idp.networks.coffee_edge_backend.aliases.includes("idp.fixture.invalid"),
    );
    assert.deepEqual(Object.keys(idp.networks), ["coffee_edge_backend"]);
    for (const [source, target] of [
      [join(fixtureRoot, "idp"), "/run/g15-idp"],
      [candidateRoot, "/workspace"],
      [join(candidateRoot, "node_modules"), "/workspace/node_modules"],
    ])
      assert.ok(
        idp.volumes.some(
          (volume) =>
            volume.source === source &&
            volume.target === target &&
            volume.read_only,
        ),
      );
    const edge = config.services["edge-gateway"];
    assert.equal(
      edge.environment.NODE_EXTRA_CA_CERTS,
      "/run/g15-browser/idp-ca.crt",
    );
    assert.ok(
      edge.volumes.some(
        (volume) =>
          volume.source === caPath &&
          volume.target === "/run/g15-browser/idp-ca.crt" &&
          volume.read_only,
      ),
    );
    assert.equal(
      edge.volumes.some((volume) => volume.source.includes("/fixture/idp")),
      false,
    );
    assert.deepEqual(
      config.services["edge-nginx"].ports.map((port) => ({
        host_ip: port.host_ip,
        published: port.published,
        target: port.target,
      })),
      [{ host_ip: "127.0.0.1", published: "8443", target: 8443 }],
    );
  } finally {
    await rm(override, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G15 programmatic browser hooks reject runs without validated context", async () => {
  const { runComposeSmoke } = await import("../../tools/compose-smoke.mjs");
  const previousContext = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  delete process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  try {
    await assert.rejects(
      runComposeSmoke({
        args: ["--recovery-proof"],
        browser: {
          baseCandidateSha: "a".repeat(40),
          onReady: async () => {},
          onCleanup: async () => {},
        },
      }),
      /G15 browser hooks require a validated launch context/u,
    );
  } finally {
    if (previousContext === undefined)
      delete process.env.COFFEE_LAUNCH_CONTEXT_FILE;
    else process.env.COFFEE_LAUNCH_CONTEXT_FILE = previousContext;
  }
});

void test("G15 lineage rejects a non-profile config edit and an extra committed path", async (t) => {
  const badProfile = await createBrowserLaunchFixture({
    mutateConfig: (text) =>
      text.replace(
        "https://idp.fixture.invalid",
        "https://evil.fixture.invalid",
      ),
  });
  t.after(async () => {
    await rm(badProfile.evidenceDir, { recursive: true, force: true });
    await rm(badProfile.fixture.root, { recursive: true, force: true });
    await rm(badProfile.fixture.bin, { recursive: true, force: true });
  });
  await assert.rejects(
    validateBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: badProfile.contextPath,
      baseCandidateSha: badProfile.baseCandidateSha,
    }),
    { code: "G15_CONFIG_DELTA_INVALID" },
  );

  const extraPath = await createBrowserLaunchFixture({
    extraTrackedFile: "config/g15-extra.txt",
  });
  t.after(async () => {
    await rm(extraPath.evidenceDir, { recursive: true, force: true });
    await rm(extraPath.fixture.root, { recursive: true, force: true });
    await rm(extraPath.fixture.bin, { recursive: true, force: true });
  });
  await assert.rejects(
    validateBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: extraPath.contextPath,
      baseCandidateSha: extraPath.baseCandidateSha,
    }),
    { code: "G15_CONFIG_ONLY_LINEAGE_REQUIRED" },
  );

  const staleContext = await createBrowserLaunchFixture();
  t.after(async () => {
    await rm(staleContext.evidenceDir, { recursive: true, force: true });
    await rm(staleContext.fixture.root, { recursive: true, force: true });
    await rm(staleContext.fixture.bin, { recursive: true, force: true });
  });
  await assert.rejects(
    validateBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: staleContext.contextPath,
      baseCandidateSha: staleContext.candidateSha,
    }),
    { code: "G15_BASE_NOT_DIRECT_PARENT" },
  );
  const context = JSON.parse(await readFile(staleContext.contextPath, "utf8"));
  context.baseConfigSha256 = "0".repeat(64);
  await chmod(staleContext.contextPath, 0o600);
  await writeFile(staleContext.contextPath, JSON.stringify(context), {
    mode: 0o400,
  });
  await chmod(staleContext.contextPath, 0o400);
  await assert.rejects(
    validateBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: staleContext.contextPath,
      baseCandidateSha: staleContext.baseCandidateSha,
    }),
    { code: "G15_CONTEXT_CONFIG_MISMATCH" },
  );
});

void test("G15 child Compose preamble reads the parent-sealed lineage without rewriting it", async (t) => {
  const launch = await createBrowserLaunchFixture();
  t.after(async () => {
    await rm(launch.evidenceDir, { recursive: true, force: true });
    await rm(launch.fixture.root, { recursive: true, force: true });
    await rm(launch.fixture.bin, { recursive: true, force: true });
  });
  for (const baseText of [
    "no marker",
    "browserOidc: null\nbrowserOidc: null",
  ]) {
    assert.throws(() => fixtureConfigText(baseText), {
      code: "G15_CONFIG_BASE_INVALID",
    });
  }
  const pureInputs = {
    candidateRoot: launch.fixture.root,
    baseCandidateSha: launch.baseCandidateSha,
    candidateSha: launch.candidateSha,
    runId: launch.runId,
    configSha256: "0".repeat(64),
  };
  for (const [override, code] of [
    [{ baseCandidateSha: "invalid" }, "G15_BASE_SHA_INVALID"],
    [{ candidateSha: "invalid" }, "G15_CANDIDATE_INVALID"],
    [{ runId: "invalid" }, "G15_CANDIDATE_INVALID"],
  ]) {
    await assert.rejects(
      validateBrowserFixtureGitLineage({ ...pureInputs, ...override }),
      { code },
    );
  }
  const lineageArgs = {
    root: REPO_ROOT,
    contextPath: launch.contextPath,
    baseCandidateSha: launch.baseCandidateSha,
  };
  const expectedReceiptPath = join(
    launch.evidenceDir,
    "gates/G15_BROWSER/artifacts/oidc-fixture-lineage.json",
  );
  await assert.rejects(
    validateBrowserFixtureLineage({
      ...lineageArgs,
      root: "/tmp/foreign-g15-source",
    }),
    { code: "G15_SOURCE_ROOT_INVALID" },
  );
  assert.equal(await lstat(expectedReceiptPath).catch(() => null), null);
  await chmod(launch.contextPath, 0o600);
  try {
    await assert.rejects(validateBrowserFixtureLineage(lineageArgs), {
      code: "G15_CONTEXT_MODE_INVALID",
    });
    assert.equal(await lstat(expectedReceiptPath).catch(() => null), null);
  } finally {
    await chmod(launch.contextPath, 0o400);
  }
  const created = await validateBrowserFixtureLineage(lineageArgs);
  const beforeBytes = await readFile(created.receiptPath);
  const verified = await readBrowserFixtureLineage({
    root: REPO_ROOT,
    contextPath: launch.contextPath,
    baseCandidateSha: launch.baseCandidateSha,
  });
  assert.deepEqual(verified, created);
  assert.deepEqual(await readFile(created.receiptPath), beforeBytes);
  assert.equal((await stat(created.receiptPath)).mode & 0o777, 0o400);
  await assert.rejects(
    readBrowserFixtureLineage({
      ...lineageArgs,
      root: "/tmp/foreign-g15-source",
    }),
    { code: "G15_SOURCE_ROOT_INVALID" },
  );
  await assert.rejects(
    materializeBrowserFixture({
      ...lineageArgs,
      lineageArtifactLoc: join(launch.evidenceDir, "foreign-receipt.json"),
      publicIngressCaPem: "unused",
    }),
    { code: "G15_RECEIPT_PATH_INVALID" },
  );
  const artifactsDir = dirname(created.receiptPath);
  await chmod(artifactsDir, 0o755);
  try {
    await assert.rejects(readBrowserFixtureLineage(lineageArgs), {
      code: "G15_RECEIPT_DIRECTORY_INVALID",
    });
    assert.deepEqual(await readFile(created.receiptPath), beforeBytes);
  } finally {
    await chmod(artifactsDir, 0o700);
  }
  const foreignPath = join(launch.evidenceDir, "foreign-receipt.json");
  const foreignBytes = Buffer.from("foreign receipt must survive\n");
  await writeFile(foreignPath, foreignBytes, { mode: 0o600 });
  await rm(created.receiptPath);
  await symlink(foreignPath, created.receiptPath);
  try {
    await assert.rejects(readBrowserFixtureLineage(lineageArgs), {
      code: "G15_RECEIPT_FILE_INVALID",
    });
    assert.deepEqual(await readFile(foreignPath), foreignBytes);
  } finally {
    await rm(created.receiptPath);
    await writeFile(created.receiptPath, beforeBytes, { mode: 0o400 });
    await chmod(created.receiptPath, 0o400);
  }
  await assert.rejects(
    materializeBrowserFixture({
      ...lineageArgs,
      lineageArtifactLoc: created.receiptPath,
      publicIngressCaPem: "-----BEGIN CERTIFICATE-----\ninvalid",
    }),
    { code: "G15_INGRESS_CA_INVALID" },
  );
  assert.deepEqual(await readFile(created.receiptPath), beforeBytes);
  await assert.rejects(
    readBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: launch.contextPath,
      baseCandidateSha: launch.candidateSha,
    }),
    { code: "G15_BASE_NOT_DIRECT_PARENT" },
  );
  assert.deepEqual(await readFile(created.receiptPath), beforeBytes);

  const receipt = JSON.parse(beforeBytes.toString("utf8"));
  await chmod(created.receiptPath, 0o600);
  await writeFile(
    created.receiptPath,
    JSON.stringify({ ...receipt, unapproved: true }),
    { mode: 0o400 },
  );
  await chmod(created.receiptPath, 0o400);
  await assert.rejects(
    readBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: launch.contextPath,
      baseCandidateSha: launch.baseCandidateSha,
    }),
    { code: "G15_RECEIPT_SCHEMA_INVALID" },
  );

  await chmod(created.receiptPath, 0o600);
  await writeFile(created.receiptPath, beforeBytes);
  await chmod(created.receiptPath, 0o600);
  await assert.rejects(
    readBrowserFixtureLineage({
      root: REPO_ROOT,
      contextPath: launch.contextPath,
      baseCandidateSha: launch.baseCandidateSha,
    }),
    { code: "G15_RECEIPT_FILE_INVALID" },
  );
});

void test("G15 parent admission restores and verifies the child bundle after checkout removal", async (t) => {
  const launch = await createBrowserLaunchFixture();
  const bundleDirectory = await mkdtemp(join(tmpdir(), "g15-parent-bundle-"));
  t.after(async () => {
    await rm(launch.evidenceDir, { recursive: true, force: true });
    await rm(launch.fixture.root, { recursive: true, force: true });
    await rm(launch.fixture.bin, { recursive: true, force: true });
    await rm(bundleDirectory, { recursive: true, force: true });
  });
  const context = JSON.parse(await readFile(launch.contextPath, "utf8"));
  const lineageWithPath = await validateBrowserFixtureLineage({
    root: REPO_ROOT,
    contextPath: launch.contextPath,
    baseCandidateSha: launch.baseCandidateSha,
  });
  const lineage = JSON.parse(
    await readFile(lineageWithPath.receiptPath, "utf8"),
  );
  const pureLineage = await validateBrowserFixtureGitLineage({
    candidateRoot: launch.fixture.root,
    baseCandidateSha: launch.baseCandidateSha,
    candidateSha: launch.candidateSha,
    runId: launch.runId,
    configSha256: context.baseConfigSha256,
  });
  assert.deepEqual(pureLineage.receipt, lineage);
  await assert.rejects(
    validateBrowserFixtureGitLineage({
      candidateRoot: launch.fixture.root,
      baseCandidateSha: launch.candidateSha,
      candidateSha: launch.candidateSha,
      runId: launch.runId,
      configSha256: context.baseConfigSha256,
    }),
    { code: "G15_BASE_NOT_DIRECT_PARENT" },
  );

  const bundlePath = join(bundleDirectory, "child.bundle");
  const baseSourceRepo = join(bundleDirectory, "base-source.git");
  const baseConfigBytes = execFileSync(
    "git",
    ["cat-file", "blob", `${launch.baseCandidateSha}:config/platform.yaml`],
    { cwd: launch.fixture.root },
  );
  const childConfigBytes = execFileSync(
    "git",
    ["cat-file", "blob", `${launch.candidateSha}:config/platform.yaml`],
    { cwd: launch.fixture.root },
  );
  execFileSync(
    "git",
    ["clone", "--bare", launch.fixture.root, baseSourceRepo],
    { stdio: "ignore" },
  );
  context.sourceRepoRoot = baseSourceRepo;
  execFileSync(
    "git",
    ["update-ref", "refs/heads/g15-browser-child", launch.candidateSha],
    { cwd: launch.fixture.root },
  );
  execFileSync(
    "git",
    [
      "bundle",
      "create",
      bundlePath,
      "refs/heads/g15-browser-child",
      `^${launch.baseCandidateSha}`,
    ],
    { cwd: launch.fixture.root },
  );
  await rm(launch.fixture.root, { recursive: true, force: true });
  assert.equal(
    await verifyBrowserChildBundle({
      bundlePath,
      baseCandidateSha: launch.baseCandidateSha,
      childContext: context,
      lineageReceipt: lineage,
      baseConfigBytes,
      childConfigBytes,
    }).then((result) => result.candidateSha),
    launch.candidateSha,
  );

  const corruptedBundle = join(bundleDirectory, "corrupted.bundle");
  await writeFile(
    corruptedBundle,
    Buffer.concat([await readFile(bundlePath), Buffer.from("tamper")]),
  );
  await assert.rejects(
    verifyBrowserChildBundle({
      bundlePath: corruptedBundle,
      baseCandidateSha: launch.baseCandidateSha,
      childContext: context,
      lineageReceipt: lineage,
      baseConfigBytes,
      childConfigBytes,
    }),
    { code: "G15_BUNDLE_FETCH_FAILED" },
  );
});

async function writeSyntheticParentG12({
  candidateRoot,
  evidenceDir,
  context,
  indexBytes,
}) {
  const { RUNTIME_NAMES } =
    await import("../../packages/platform-config/src/index.ts");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const { runId, candidateSha } = context;
  const supplyChainDir = join(
    evidenceDir,
    "gates/G12_SUPPLY_CHAIN/artifacts/supply-chain",
  );
  await mkdir(join(supplyChainDir, "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  const toolchainBytes = await readFile(
    join(candidateRoot, "config/toolchain-versions.json"),
  );
  const toolchain = JSON.parse(toolchainBytes);
  const approvedFixed = parseYaml(
    await readFile(join(candidateRoot, "config/platform.yaml"), "utf8"),
  ).verification.securityScan.approvedFixed;
  const lockfileBytes = await readFile(join(candidateRoot, "pnpm-lock.yaml"));
  const imageId = `sha256:${"2".repeat(64)}`;
  const manifestDigest = `sha256:${"3".repeat(64)}`;
  const platformManifestDigest = `sha256:${"4".repeat(64)}`;
  const pins = toolchain.grafanaPlugins;
  const grafanaImage = toolchain.grafanaImage;
  const environment = {
    runId,
    candidateSha,
    candidatePath: candidateRoot,
    dirty: false,
    configSha256: context.baseConfigSha256,
    treeSha: "5".repeat(40),
    toolchainVersionsSha256: hash(toolchainBytes),
    lockfileSha256: hash(lockfileBytes),
  };
  await writeFile(
    join(evidenceDir, "environment.json"),
    JSON.stringify(environment),
    { mode: 0o600 },
  );
  const ociArtifact = Buffer.from("mock OCI artifact bytes");
  const baseMaterial = {
    sourceRef: `apache/kafka:4.3.2@sha256:${hash(indexBytes)}`,
    platformManifestDigest,
    indexArtifact: {
      path: "artifacts/kafka-base-index.json",
      sha256: hash(indexBytes),
      sizeBytes: indexBytes.length,
    },
  };
  const receipt = {
    schemaVersion: 1,
    gate: "G12_SUPPLY_CHAIN",
    status: "PASS",
    runId,
    candidateSha,
    treeSha: environment.treeSha,
    configSha256: context.baseConfigSha256,
    toolchainVersionsSha256: environment.toolchainVersionsSha256,
    lockfileSha256: environment.lockfileSha256,
    target: "kafka",
    importTag: `coffee-g12-${hash(Buffer.from(runId)).slice(0, 12)}-kafka:latest`,
    baseImage: baseMaterial.sourceRef,
    imageId,
    manifestDigest,
    platformManifestDigest,
    provenanceStatus: "INCOMPLETE_LOCAL_CONTEXT",
    provenanceSha256: "6".repeat(64),
    attestationSha256: "7".repeat(64),
    buildInputBinding: {
      status: "OBSERVED",
      sourceCommit: candidateSha,
      sourceTreeSha: environment.treeSha,
      archiveSha256: "8".repeat(64),
      archiveSizeBytes: 123,
      extractedTreeSha256: "9".repeat(64),
      extractedBytes: 123,
      sourceKind: "git-archive-local-context",
      buildkitMaterialsCompleteness: "INCOMPLETE_LOCAL_CONTEXT",
      invocation: {
        entryPoint: "docker buildx build",
        builder: "coffee-platform-mtu",
        target: "kafka",
        platform: "linux/amd64",
        provenance: "mode=min",
        output: "oci-layout-directory",
      },
    },
    ociArtifact: {
      path: "artifacts/kafka.oci.tar",
      sha256: hash(ociArtifact),
      sizeBytes: ociArtifact.length,
      layoutTreeSha256: "a".repeat(64),
      layoutBytes: 123,
    },
    baseMaterial,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const result = {
    gate: "G12_SUPPLY_CHAIN",
    status: "PASS",
    code: "G12_SCAN_CLEAN",
    runId,
    candidateSha,
    kafka: {
      path: "artifacts/kafka-receipt.json",
      receiptSha256: hash(receiptBytes),
      imageId,
      importTag: receipt.importTag,
      manifestDigest,
      ociArtifactPath: "artifacts/kafka.oci.tar",
      ociArtifactSha256: hash(ociArtifact),
    },
    provenance: {
      status: "PASS",
      sourceRevision: candidateSha,
      treeSha: environment.treeSha,
      configSha256: context.baseConfigSha256,
      toolchainVersionsSha256: environment.toolchainVersionsSha256,
      lockfileSha256: environment.lockfileSha256,
      images: [
        {
          service: "kafka",
          imageId,
          manifestDigest,
          platformManifestDigest,
          provenanceStatus: "PASS",
          metadataSha256: receipt.provenanceSha256,
          attestationSha256: receipt.attestationSha256,
          baseMaterial,
        },
      ],
    },
  };
  const grafanaId = `sha256:${hash("grafana-image")}`;
  const grafanaBase = {
    sourceRef: grafanaImage,
    platformManifestDigest,
    indexArtifact: {
      path: "artifacts/grafana-base-index.json",
      sha256: hash(indexBytes),
      sizeBytes: indexBytes.length,
    },
  };
  const vendorPlugins = {
    treeSha256: hash("plugins"),
    treeBytes: 1,
    signingKeySourceSha256: toolchain.grafanaSigningKeySourceSha256,
    signingKeyFingerprint: toolchain.grafanaSigningKeyFingerprint,
    plugins: pins,
    effectiveFiles: Object.fromEntries(
      Object.keys(pins).map((name) => [
        name,
        {
          path: `/opt/grafana/plugins/${name}/gpx_grafana-${name}-datasource_linux_amd64`,
          sha256: pins[name].binarySha256,
          sizeBytes: 1,
          layerDigest: platformManifestDigest,
        },
      ]),
    ),
  };
  const grafanaReceipt = {
    ...receipt,
    target: "grafana",
    importTag: `coffee-g12-${hash(Buffer.from(runId)).slice(0, 12)}-grafana:latest`,
    baseImage: grafanaImage,
    imageId: grafanaId,
    baseMaterial: grafanaBase,
    buildInputBinding: {
      ...receipt.buildInputBinding,
      sourceKind: "git-archive-plus-verified-plugins",
      invocation: {
        ...receipt.buildInputBinding.invocation,
        target: "grafana",
      },
      vendorPlugins,
    },
    ociArtifact: { ...receipt.ociArtifact, path: "artifacts/grafana.oci.tar" },
  };
  const grafanaReceiptBytes = Buffer.from(JSON.stringify(grafanaReceipt));
  result.grafana = {
    path: "artifacts/grafana-receipt.json",
    receiptSha256: hash(grafanaReceiptBytes),
    imageId: grafanaId,
    importTag: grafanaReceipt.importTag,
    manifestDigest,
    ociArtifactPath: grafanaReceipt.ociArtifact.path,
    ociArtifactSha256: grafanaReceipt.ociArtifact.sha256,
  };
  result.provenance.images.push({
    service: "grafana",
    imageId: grafanaId,
    manifestDigest,
    platformManifestDigest,
    provenanceStatus: "PASS",
    metadataSha256: grafanaReceipt.provenanceSha256,
    attestationSha256: grafanaReceipt.attestationSha256,
    baseMaterial: grafanaBase,
  });
  const services = [
    ...RUNTIME_NAMES,
    "grafana",
    "storage-helper",
    "edge-nginx",
    "kafka",
    "otel-collector",
    "loki",
    "prometheus",
    "tempo",
    "lockfile",
  ];
  result.reports = [];
  for (const service of services) {
    const existing = result.provenance.images.find(
      (entry) => entry.service === service,
    );
    const scannedImageId = existing?.imageId ?? `sha256:${hash(service)}`;
    if (!existing && service !== "lockfile") {
      const upstream = [
        "otel-collector",
        "loki",
        "prometheus",
        "tempo",
      ].includes(service);
      result.provenance.images.push(
        upstream
          ? {
              service,
              imageId: scannedImageId,
              manifestDigest,
              sourceReference: `${service}:fixture@${manifestDigest}`,
              identityStatus: "PINNED_DIGEST_VERIFIED",
            }
          : {
              service,
              imageId: scannedImageId,
              manifestDigest,
              platformManifestDigest,
              provenanceStatus: "PASS",
              metadataSha256: hash(`${service}-metadata`),
              attestationSha256: hash(`${service}-attestation`),
            },
      );
    }
    for (const suffix of ["sbom.cdx.json", "vulnerabilities.json"]) {
      const name = `${service}.${suffix}`;
      const contents = Buffer.from(
        JSON.stringify(
          suffix === "vulnerabilities.json"
            ? {
                Results: [],
                Metadata:
                  service === "lockfile" ? {} : { ImageID: scannedImageId },
              }
            : {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                components: [],
              },
        ),
      );
      await writeFile(join(supplyChainDir, "artifacts", name), contents, {
        mode: 0o600,
      });
      result.reports.push({
        path: name,
        sha256: hash(contents),
        findings: { high: 0, critical: 0 },
      });
    }
  }
  result.findings = { high: 0, critical: 0 };
  result.evaluation = {
    rawHigh: 0,
    resolvedFixed: 0,
    unresolvedHigh: 0,
    critical: 0,
  };
  const decision = {
    schemaVersion: 1,
    gate: "G12_SUPPLY_CHAIN",
    runId,
    candidateSha,
    treeSha: environment.treeSha,
    configSha256: context.baseConfigSha256,
    toolchainVersionsSha256: environment.toolchainVersionsSha256,
    lockfileSha256: environment.lockfileSha256,
    imageId: grafanaId,
    manifestDigest,
    platformManifestDigest,
    rawReportSha256: result.reports.find(
      (entry) => entry.path === "grafana.vulnerabilities.json",
    ).sha256,
    approvedFixed,
    vendorPlugins,
    module: toolchain.grafanaTempoModule,
    decisions: [],
    evaluatedAt: "2026-10-30T00:00:00.000Z",
    openVex: null,
  };
  const decisionBytes = Buffer.from(JSON.stringify(decision));
  result.adjudication = {
    path: "artifacts/grafana-adjudication.json",
    sha256: hash(decisionBytes),
  };
  await writeFile(
    join(supplyChainDir, "artifacts/grafana-receipt.json"),
    grafanaReceiptBytes,
    { mode: 0o600 },
  );
  await writeFile(
    join(supplyChainDir, "artifacts/grafana-adjudication.json"),
    decisionBytes,
    { mode: 0o600 },
  );
  for (const [path, bytes] of [
    [join(supplyChainDir, "result.json"), Buffer.from(JSON.stringify(result))],
    [join(supplyChainDir, "artifacts/kafka-receipt.json"), receiptBytes],
    [join(supplyChainDir, "artifacts/kafka.oci.tar"), ociArtifact],
    [join(supplyChainDir, "artifacts/kafka-base-index.json"), indexBytes],
    [join(supplyChainDir, "artifacts/grafana-base-index.json"), indexBytes],
  ])
    await writeFile(path, bytes, { mode: 0o600 });
  return { imageId, receiptSha256: hash(receiptBytes) };
}

void test("browser correlation executes the child lifecycle and preserves early image failure evidence", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "coffee-correlation-lifecycle-"),
  );
  const root = join(directory, "candidate");
  const originalCwd = process.cwd();
  const oldContext = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  let mock;
  t.after(async () => {
    if (mock) {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    process.chdir(originalCwd);
    if (oldContext === undefined) delete process.env.COFFEE_LAUNCH_CONTEXT_FILE;
    else process.env.COFFEE_LAUNCH_CONTEXT_FILE = oldContext;
    await rm(directory, { recursive: true, force: true });
  });
  execFileSync("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-hardlinks",
    REPO_ROOT,
    root,
  ]);
  await cp(
    join(REPO_ROOT, "verification/launch/v1/scenarios/browser.mjs"),
    join(root, "verification/launch/v1/scenarios/browser.mjs"),
  );
  await cp(
    join(REPO_ROOT, "tools/observability/verify.mjs"),
    join(root, "tools/observability/verify.mjs"),
  );
  await cp(
    join(REPO_ROOT, "tests/realtime/fixtures/setup.mjs"),
    join(root, "tests/realtime/fixtures/setup.mjs"),
  );
  await cp(
    join(REPO_ROOT, "tools/realtime-capacity.mjs"),
    join(root, "tools/realtime-capacity.mjs"),
  );
  const platformPath = join(root, "config/platform.yaml");
  const config = (await readFile(platformPath, "utf8")).replace(
    "    enabled: false\n  kafkaNamespaceIsolation: false",
    "    enabled: true\n  kafkaNamespaceIsolation: true",
  );
  assert.match(
    config,
    /databaseIsolation:\n    enabled: true\n  kafkaNamespaceIsolation: true/u,
  );
  await writeFile(platformPath, config);
  const probePath = join(directory, "probe");
  await writeFile(probePath, "synthetic executable\n", { mode: 0o755 });
  const bomPath = join(root, "config/toolchain-versions.json");
  const bom = JSON.parse(await readFile(bomPath, "utf8"));
  bom.bootstrapProbeSha256 = createHash("sha256")
    .update(await readFile(probePath))
    .digest("hex");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const platformManifestDigest = `sha256:${"4".repeat(64)}`;
  const indexBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: platformManifestDigest,
          size: 123,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
  );
  bom.kafkaImage = `apache/kafka:4.3.2@sha256:${hash(indexBytes)}`;
  bom.grafanaImage = `grafana:fixture@sha256:${hash(indexBytes)}`;
  bom.grafanaPlugins = Object.fromEntries(
    ["loki", "tempo", "prometheus"].map((name) => [
      name,
      {
        version: "1.0.0",
        zipSha256: hash(`${name}-zip`),
        manifestSha256: hash(`${name}-manifest`),
        binarySha256: hash(`${name}-binary`),
      },
    ]),
  );
  bom.grafanaSigningKeySourceSha256 = hash("key");
  bom.grafanaSigningKeyFingerprint = "A".repeat(40);
  bom.grafanaTempoModule = {
    version: "fixture",
    h1: "fixture",
    revision: "a".repeat(40),
    fixCommits: ["b".repeat(40), "c".repeat(40)],
    replacement: null,
  };
  await writeFile(bomPath, JSON.stringify(bom, null, 2));
  for (const file of [platformPath, bomPath, join(root, "pnpm-lock.yaml")])
    await chmod(file, 0o644);
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git(
    "remote",
    "set-url",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  );
  git(
    "add",
    "config/platform.yaml",
    "config/toolchain-versions.json",
    "verification/launch/v1/scenarios/browser.mjs",
    "tools/observability/verify.mjs",
    "tests/realtime/fixtures/setup.mjs",
    "tools/realtime-capacity.mjs",
  );
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "Fixture candidate",
  );
  const sha = git("rev-parse", "HEAD");
  const sourceRoot = join(directory, "source");
  execFileSync("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-hardlinks",
    root,
    sourceRoot,
  ]);
  await chmod(join(sourceRoot, "evidence"), 0o700);
  execFileSync("git", [
    "-C",
    sourceRoot,
    "remote",
    "set-url",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  ]);
  await writeFile(join(root, ".git/info/exclude"), "node_modules\ndist\n", {
    flag: "a",
  });
  await symlink(
    join(REPO_ROOT, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
  for (const group of ["apps", "packages"]) {
    for (const name of await readdir(join(root, group))) {
      const source = join(REPO_ROOT, group, name, "node_modules");
      if (await stat(source).catch(() => null))
        await symlink(source, join(root, group, name, "node_modules"), "dir");
      const dist = join(REPO_ROOT, group, name, "dist");
      if (await stat(dist).catch(() => null))
        await symlink(dist, join(root, group, name, "dist"), "dir");
    }
  }
  const configHash = createHash("sha256")
    .update(await readFile(platformPath))
    .digest("hex");
  async function makeContext(
    stamp,
    candidateRoot = root,
    contextSourceRoot = sourceRoot,
  ) {
    const runId = `${stamp}-${sha.slice(0, 7)}`;
    const evidenceDir = join(contextSourceRoot, "evidence/launch", runId);
    const artifacts = join(evidenceDir, "gates/G14_OBSERVABILITY/artifacts");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    const context = {
      schemaVersion: 1,
      runId,
      candidateSha: sha,
      baseConfigSha256: configHash,
      checkoutDir: candidateRoot,
      sourceRepoRoot: contextSourceRoot,
      evidenceDir,
      acceptedBaseCommit: sha,
      startedAtUtc: new Date().toISOString(),
      githubSnapshotPath: null,
      resources: {
        composeProject: `coffee-launch-${runId.toLowerCase()}`,
        kafkaPrefix: runId,
      },
    };
    const contextPath = join(evidenceDir, "context.json");
    await writeFile(contextPath, JSON.stringify(context), { mode: 0o400 });
    return { context, contextPath, evidenceDir, artifacts };
  }
  const execReal = childProcess.execFileSync;
  mock = t.mock.method(
    childProcess,
    "execFileSync",
    (command, args, options) => {
      if (command === "docker")
        throw new Error("Docker is forbidden in this test");
      if (command === "pnpm" || command === process.execPath)
        return Buffer.alloc(0);
      return execReal(command, args, options);
    },
  );
  syncBuiltinESMExports();
  process.chdir(root);
  const { runBrowserParent, validateBrowserCorrelation: validateCorrelation } =
    await import(
      pathToFileURL(join(root, "verification/launch/v1/scenarios/browser.mjs"))
        .href
    );
  const success = await makeContext("20261030T120000Z");
  const expectedKafka = await writeSyntheticParentG12({
    candidateRoot: root,
    evidenceDir: success.evidenceDir,
    context: success.context,
    indexBytes,
  });
  const { loadVerifiedGateImage: loadFixtureKafka, readQualificationInputs } =
    await import(
      pathToFileURL(join(root, "tests/realtime/fixtures/setup.mjs")).href
    );
  process.env.COFFEE_LAUNCH_CONTEXT_FILE = success.contextPath;
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
  let observed;
  const synthetic = join(directory, "synthetic-callback");
  const callback = async (contextPath) => {
    const info = await stat(contextPath);
    assert.equal(info.mode & 0o777, 0o400);
    const child = JSON.parse(await readFile(contextPath, "utf8"));
    assert.equal(child.resources.g15ParentCandidateSha, sha);
    assert.equal(child.resources.g15ParentRunId, success.context.runId);
    assert.equal(
      child.resources.g08PreparationContextPath,
      success.contextPath,
    );
    const childParent = execReal(
      "git",
      ["-C", child.checkoutDir, "rev-parse", "HEAD^"],
      { encoding: "utf8" },
    ).trim();
    assert.equal(childParent, sha);
    assert.equal(
      execReal(
        "git",
        ["-C", child.checkoutDir, "diff", "--name-only", `${sha}..HEAD`],
        { encoding: "utf8" },
      ).trim(),
      "config/platform.yaml",
    );
    const base = parseYaml(config),
      variant = parseYaml(
        await readFile(join(child.checkoutDir, "config/platform.yaml"), "utf8"),
      );
    assert.ok(variant.browserOidc);
    variant.browserOidc = base.browserOidc;
    assert.deepEqual(variant, base);
    assert.equal(
      await stat(join(child.evidenceDir, "environment.json")).catch(() => null),
      null,
    );
    const image = await loadFixtureKafka({
      target: "kafka",
      contextFile: contextPath,
      loadImage: false,
    });
    assert.equal(image.imageId, expectedKafka.imageId);
    assert.equal(image.receiptSha256, expectedKafka.receiptSha256);
    assert.equal(image.candidateSha, sha);
    assert.equal(image.runId, success.context.runId);
    assert.deepEqual(image.launchIdentity, {
      schemaVersion: 1,
      runId: child.runId,
      candidateSha: child.candidateSha,
      baseConfigSha256: child.baseConfigSha256,
    });
    const lineageBytes = await readFile(
      join(
        child.evidenceDir,
        "gates/G15_BROWSER/artifacts/oidc-fixture-lineage.json",
      ),
    );
    assert.equal(image.lineageReceiptSha256, hash(lineageBytes));
    const admitted = await readQualificationInputs(contextPath);
    const { RUNTIME_NAMES } =
      await import("../../packages/platform-config/src/index.ts");
    assert.deepEqual(
      admitted.qualification.runtimeImages,
      [...RUNTIME_NAMES, "edge-nginx"].map((service) => ({
        service,
        imageId: `sha256:${hash(service)}`,
      })),
    );
    assert.equal(admitted.qualification.candidateSha, sha);
    assert.equal(
      admitted.qualification.baseConfigSha256,
      success.context.baseConfigSha256,
    );
    assert.deepEqual(admitted.launchPath.launchIdentity, image.launchIdentity);
    const reportPath = join(
      success.evidenceDir,
      "gates/G12_SUPPLY_CHAIN/artifacts/supply-chain/artifacts/edge-gateway.vulnerabilities.json",
    );
    const reportBytes = await readFile(reportPath);
    await writeFile(reportPath, Buffer.concat([reportBytes, Buffer.from(" ")]));
    try {
      await assert.rejects(readQualificationInputs(contextPath));
    } finally {
      await writeFile(reportPath, reportBytes);
    }
    const componentImage = await loadFixtureKafka({
      target: "kafka",
      loadImage: false,
    });
    assert.equal(componentImage.candidateSha, sha);
    assert.equal(componentImage.launchIdentity, undefined);
    const dockerCalls = [];
    const importedImage = await loadFixtureKafka({
      target: "kafka",
      contextFile: contextPath,
      run: (args) => {
        dockerCalls.push(args);
        if (args.at(-1) === "coffee-platform-kafka:verified-artifact-required")
          throw new Error(`No such image: ${args.at(-1)}`);
        return `${expectedKafka.imageId}|${JSON.stringify([image.importTag])}`;
      },
    });
    assert.equal(dockerCalls.length, 3);
    assert.equal(importedImage.imageId, image.imageId);
    assert.deepEqual(importedImage.launchIdentity, image.launchIdentity);
    assert.equal(
      importedImage.lineageReceiptSha256,
      image.lineageReceiptSha256,
    );
    const contextBytes = await readFile(contextPath);
    const rejectChild = async (changed) => {
      await chmod(contextPath, 0o600);
      await writeFile(contextPath, JSON.stringify(changed));
      await chmod(contextPath, 0o400);
      try {
        await assert.rejects(
          loadFixtureKafka({
            target: "kafka",
            contextFile: contextPath,
            loadImage: false,
          }),
        );
      } finally {
        await chmod(contextPath, 0o600);
        await writeFile(contextPath, contextBytes);
        await chmod(contextPath, 0o400);
      }
    };
    await rejectChild({
      ...child,
      resources: {
        ...child.resources,
        g15ParentRunId: "20261030T120001Z-1234567",
      },
    });
    await rejectChild({ ...child, candidateSha: "f".repeat(40) });
    const childConfigPath = join(child.checkoutDir, "config/platform.yaml");
    const childConfigBytes = await readFile(childConfigPath);
    await writeFile(
      childConfigPath,
      Buffer.concat([childConfigBytes, Buffer.from("\n")]),
    );
    try {
      await assert.rejects(
        loadFixtureKafka({
          target: "kafka",
          contextFile: contextPath,
          loadImage: false,
        }),
      );
    } finally {
      await writeFile(childConfigPath, childConfigBytes);
    }
    const parentConfigBytes = await readFile(platformPath);
    await writeFile(
      platformPath,
      Buffer.concat([parentConfigBytes, Buffer.from("\n")]),
    );
    try {
      await assert.rejects(
        loadFixtureKafka({
          target: "kafka",
          contextFile: contextPath,
          loadImage: false,
        }),
      );
    } finally {
      await writeFile(platformPath, parentConfigBytes);
    }
    assert.equal(
      (
        await loadFixtureKafka({
          target: "kafka",
          contextFile: contextPath,
          loadImage: false,
        })
      ).imageId,
      expectedKafka.imageId,
    );
    observed = child;
    await mkdir(synthetic);
    try {
      const databases = [
        "customer",
        "catalog",
        "pricing",
        "orders",
        "integration",
      ]
        .map(
          (owner) =>
            `coffee_verify_${child.runId.toLowerCase().replace("-", "_")}_${owner}`,
        )
        .sort();
      return {
        cleanupVerified: true,
        cleanup: {
          verified: true,
          databases: { verified: true, removed: databases, retained: [] },
          attachment: {
            baselineAttached: false,
            attempted: true,
            removed: true,
            routePreserved: true,
          },
        },
        launchPath: {
          verified: true,
          correlationId: "8f53d687-fd3b-47be-b32b-2081d08bc55a",
          traceId: "00bf08bba3714e52b26d23c08e06ce16",
          refetchReceipt: { matched: true },
          sseFrameMatched: true,
          projectionReceipt: { causationMatched: true },
        },
      };
    } finally {
      await rm(synthetic, { recursive: true });
    }
  };
  const result = await runBrowserParent({ runCorrelation: callback });
  assert.equal(result.browserChild.childCandidateSha, observed.candidateSha);
  assert.equal(await stat(observed.checkoutDir).catch(() => null), null);
  assert.equal(await stat(observed.evidenceDir).catch(() => null), null);
  assert.equal(await stat(synthetic).catch(() => null), null);
  assert.equal(
    (
      await validateCorrelation({
        evidenceDir: success.evidenceDir,
        parentContext: success.context,
      })
    ).files.length,
    6,
  );

  const qualificationRunId = "i12-0123456789abcdef";
  const qualificationRaw = join(directory, "capacity-raw");
  const qualification = await runBrowserParent({
    qualificationRunId,
    runQualification: async (contextPath) => {
      const admitted = await readQualificationInputs(contextPath);
      const os = await import("node:os");
      const roles = [
        "kafka",
        "idp",
        "orders-fixture",
        "edge-gateway",
        "api-public",
        "realtime-gateway",
        "edge-nginx",
        "driver",
      ];
      const images = Object.fromEntries(
        admitted.qualification.runtimeImages.map(({ service, imageId }) => [
          service,
          imageId,
        ]),
      );
      const manifest = {
        runId: qualificationRunId,
        qualification: admitted.qualification,
        launchIdentity: admitted.launchPath.launchIdentity,
        lineageReceiptSha256: admitted.launchPath.lineageReceiptSha256,
        configSha256: admitted.launchPath.launchIdentity.baseConfigSha256,
        images,
        kafkaSupplyChain: { imageId: expectedKafka.imageId },
        hardware: {
          architecture: process.arch,
          platform: process.platform,
          availableParallelism: os.availableParallelism(),
          cpus: os.cpus().map((cpu) => cpu.model),
          memoryBytes: os.totalmem(),
          node: process.version,
          driverHostFdLimit: await readFile("/proc/self/limits", "utf8"),
        },
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const shutdown = {
        ok: true,
        state: { ExitCode: 0 },
        elapsedMs: 100,
        clients: 1,
        liveBefore: 1,
        gatewayLiveBefore: 1,
        armedClients: 1,
        armedLive: 1,
        closedClients: 1,
        workerErrors: 0,
        timedOut: false,
        forcedClientClose: false,
        clientReceipts: [
          {
            client: 0,
            connectionId: "fixture",
            resetAt: "2026-10-12T00:00:00.000Z",
            serverClosedAt: "2026-10-12T00:00:00.010Z",
            elapsedMs: 10,
          },
        ],
        shardReceipts: [{ shard: 0, clients: 1, live: 0 }],
      };
      const result = {
        status: "PASS",
        launchProof: true,
        classification: "full-profile",
        cleanupVerified: true,
        manifestSha256: hash(manifestBytes),
        mode: "full",
        profile: "operator-1",
        subjects: 100,
        durationMs: 1800000,
        clients: 1,
        rate: 100,
        published: 180000,
        minLive: 0,
        maxLive: 1,
        disconnects: 1,
        reconnects: 1,
        eventLatencyP95Ms: 999,
        eventLoopP95Ms: 99,
        coverageChecks: 1,
        protocolFrames: 1,
        checks: Object.fromEntries(
          [
            "admission",
            "slow",
            "replay",
            "evicted",
            "reset",
            "reload",
            "headroom",
            "cleanup",
            "shutdown",
            "budgets",
            "reauth",
          ].map((key) => [key, true]),
        ),
        checkDetails: {
          shutdown,
          admission: {
            live: 512,
            rejectedConnection: 513,
            status: 503,
            code: "REALTIME_CAPACITY_EXCEEDED",
            beforeSseHeaders: true,
          },
          expectedMaximum: Object.fromEntries(
            Array.from({ length: 100 }, (_, index) => [
              `ord_${String(index + 1).padStart(26, "0")}`,
              "1",
            ]),
          ),
          reauth: {
            recoveredClients: 1,
            samples: 1,
            unexpectedDisconnects: 0,
            pending: 0,
            authCloseDelta: 1,
            finalLive: 1,
            maxGapMs: 4500,
            gapP95Ms: 4000,
            retryMs: 3000,
            readyTimeoutMs: 10000,
            sessionRefreshes: 2,
            sessionRefreshIntervalMs: 600000,
          },
        },
      };
      const containers = roles.map((role) => {
        const native = [
          "edge-gateway",
          "api-public",
          "realtime-gateway",
          "edge-nginx",
        ].includes(role);
        const nginx = role === "edge-nginx";
        const mounts = nginx
          ? ["/run/secrets/edge-nginx"]
          : [
              "/app/config/platform.yaml",
              "/run/secrets/coffee-platform.yaml",
              "/run/coffee-launch/context.json",
              ...(role === "edge-gateway"
                ? ["/run/g15-browser/idp-ca.crt"]
                : []),
            ];
        return {
          role,
          id: hash(`container-${role}`),
          name: `${qualificationRunId}-${role}`,
          image:
            role === "kafka"
              ? expectedKafka.imageId
              : (images[role] ?? `sha256:${hash(role)}`),
          ...(native
            ? {
                native: {
                  entrypoint: nginx
                    ? ["nginx"]
                    : ["node", "scripts/permission-enforce.mjs"],
                  command: nginx
                    ? ["-g", "daemon off;"]
                    : ["--entry", "dist/main.js"],
                  mounts: mounts.map((Destination) => ({
                    Destination,
                    RW: false,
                  })),
                },
              }
            : {}),
        };
      });
      const cleanup = {
        verified: true,
        syntheticPrivateMaterialRemoved: true,
        owner: { removed: true },
        network: {
          name: `${qualificationRunId}-net`,
          created: true,
          removed: true,
        },
        receipts: containers.map(({ role, id }) => ({
          role,
          id,
          removed: true,
          logsCaptured: true,
        })),
      };
      await mkdir(qualificationRaw, { mode: 0o700 });
      for (const [name, bytes] of [
        ["profile-manifest.json", manifestBytes],
        ["result.json", Buffer.from(JSON.stringify(result))],
        ["cleanup.json", Buffer.from(JSON.stringify(cleanup))],
        ["containers.json", Buffer.from(JSON.stringify(containers))],
      ])
        await writeFile(join(qualificationRaw, name), bytes, { mode: 0o600 });
      return { runId: qualificationRunId, resultDir: qualificationRaw };
    },
  });
  assert.equal(qualification.qualificationSeal.status, "SEALED");
  const packet = qualification.artifactsDir;
  const receiptPath = join(packet, "qualification.json");
  const endedAt = Date.now() - 1000;
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    runId: qualificationRunId,
    startedAt: new Date(endedAt - 1801000).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    elapsedMs: 1801000,
    candidateSha: sha,
    baseConfigSha256: success.context.baseConfigSha256,
    sealSha256: hash(await readFile(join(packet, "seal.json"))),
  };
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o400 });
  const os = (await import("node:os")).default;
  const oldUserInfo = os.userInfo;
  const userMock = t.mock.method(os, "userInfo", () => ({
    ...oldUserInfo(),
    homedir: directory,
  }));
  syncBuiltinESMExports();
  try {
    const { admitRealtimeCapacity } = await import(
      pathToFileURL(join(root, "tools/realtime-capacity.mjs")).href
    );
    const replace = async (path, bytes) => {
      await chmod(path, 0o600);
      await writeFile(path, bytes);
      await chmod(path, 0o400);
    };
    for (const change of [
      { candidateSha: "f".repeat(40) },
      { baseConfigSha256: "f".repeat(64) },
      { endedAt: new Date(Date.now() + 60000).toISOString() },
      {
        startedAt: new Date(Date.now() - 10000000).toISOString(),
        endedAt: new Date(Date.now() - 7201000).toISOString(),
      },
      { elapsedMs: 2700001 },
    ]) {
      await replace(receiptPath, JSON.stringify({ ...receipt, ...change }));
      await assert.rejects(
        admitRealtimeCapacity({
          receiptPath,
          contextFile: success.contextPath,
        }),
      );
    }
    await replace(receiptPath, JSON.stringify(receipt));
    const rawResultPath = join(packet, "result.json");
    const originalResult = await readFile(rawResultPath);
    await replace(
      rawResultPath,
      Buffer.concat([originalResult, Buffer.from(" ")]),
    );
    await assert.rejects(
      admitRealtimeCapacity({ receiptPath, contextFile: success.contextPath }),
    );
    await replace(rawResultPath, originalResult);
    const packetNames = [
      "profile-manifest.json",
      "result.json",
      "cleanup.json",
      "seal.json",
      "qualification.json",
    ];
    const originals = Object.fromEntries(
      await Promise.all(
        packetNames.map(async (name) => [
          name,
          await readFile(join(packet, name)),
        ]),
      ),
    );
    for (const change of [
      ({ manifest }) => {
        manifest.qualification.runtimeImages[0].imageId = `sha256:${"f".repeat(64)}`;
      },
      ({ manifest }) => {
        manifest.hardware.memoryBytes += 1;
      },
      ({ cleanup }) => {
        cleanup.verified = false;
      },
    ]) {
      const manifest = JSON.parse(originals["profile-manifest.json"]);
      const result = JSON.parse(originals["result.json"]);
      const cleanup = JSON.parse(originals["cleanup.json"]);
      const seal = JSON.parse(originals["seal.json"]);
      const alteredReceipt = JSON.parse(originals["qualification.json"]);
      change({ manifest, cleanup });
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const cleanupBytes = Buffer.from(JSON.stringify(cleanup));
      result.manifestSha256 = hash(manifestBytes);
      const resultBytes = Buffer.from(JSON.stringify(result));
      seal.hashes.manifest = hash(manifestBytes);
      seal.hashes.result = hash(resultBytes);
      seal.hashes.cleanup = hash(cleanupBytes);
      const sealBytes = Buffer.from(JSON.stringify(seal));
      alteredReceipt.sealSha256 = hash(sealBytes);
      try {
        for (const [name, bytes] of [
          ["profile-manifest.json", manifestBytes],
          ["result.json", resultBytes],
          ["cleanup.json", cleanupBytes],
          ["seal.json", sealBytes],
          ["qualification.json", Buffer.from(JSON.stringify(alteredReceipt))],
        ])
          await replace(join(packet, name), bytes);
        await assert.rejects(
          admitRealtimeCapacity({
            receiptPath,
            contextFile: success.contextPath,
          }),
        );
      } finally {
        for (const name of packetNames)
          await replace(join(packet, name), originals[name]);
      }
    }
    const lineagePath = join(packet, "browser-lineage.json");
    const originalLineage = await readFile(lineagePath);
    await replace(
      lineagePath,
      Buffer.concat([originalLineage, Buffer.from(" ")]),
    );
    await assert.rejects(
      admitRealtimeCapacity({ receiptPath, contextFile: success.contextPath }),
    );
    await replace(lineagePath, originalLineage);
  } finally {
    userMock.mock.restore();
    syncBuiltinESMExports();
  }

  const failure = await makeContext("20261030T120001Z");
  process.env.COFFEE_LAUNCH_CONTEXT_FILE = failure.contextPath;
  let failedChild;
  await assert.rejects(
    runBrowserParent({
      runCorrelation: async (contextPath) => {
        failedChild = JSON.parse(await readFile(contextPath, "utf8"));
        await mkdir(synthetic);
        try {
          throw new Error("synthetic callback failure");
        } finally {
          await rm(synthetic, { recursive: true });
        }
      },
    }),
    /synthetic callback failure/u,
  );
  assert.ok((await stat(failedChild.checkoutDir)).isDirectory());
  assert.ok((await stat(failedChild.evidenceDir)).isDirectory());
  assert.equal(await stat(synthetic).catch(() => null), null);
  assert.equal(
    await stat(join(failure.artifacts, "browser-correlation.json")).catch(
      () => null,
    ),
    null,
  );
  assert.equal(
    await stat(join(failure.artifacts, "browser-source.bundle")).catch(
      () => null,
    ),
    null,
  );

  const imageFailure = await makeContext("20261030T120002Z");
  process.env.COFFEE_LAUNCH_CONTEXT_FILE = imageFailure.contextPath;
  const { runObservabilityVerification } = await import(
    pathToFileURL(join(root, "tools/observability/verify.mjs")).href
  );
  await assert.rejects(
    runObservabilityVerification({
      root,
      probePath,
      run: () => {
        throw new Error("unexpected Docker");
      },
    }),
    (error) =>
      error.evidence?.status === "FAIL" &&
      /G12_KAFKA_EVIDENCE_PATH_INVALID/u.test(error.evidence.failure),
  );
  const saved = join(imageFailure.artifacts, "observability");
  const savedNames = [
    "alert-transitions.json",
    "correlation-proof.json",
    "redaction-scan.json",
    "queue-loss-counters.json",
    "retention-result.json",
    "runtime-health-matrix.json",
    "result.json",
  ];
  for (const name of savedNames)
    assert.ok((await stat(join(saved, name))).isFile());
  const savedResult = JSON.parse(
    await readFile(join(saved, "result.json"), "utf8"),
  );
  assert.equal(savedResult.status, "FAIL");
  assert.match(savedResult.failure, /G12_KAFKA_EVIDENCE_PATH_INVALID/u);

  const foreignRoot = join(directory, "foreign");
  execReal("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-hardlinks",
    root,
    foreignRoot,
  ]);
  execReal("git", [
    "-C",
    foreignRoot,
    "remote",
    "set-url",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  ]);
  const foreign = await makeContext("20261030T120003Z", foreignRoot, root);
  process.env.COFFEE_LAUNCH_CONTEXT_FILE = foreign.contextPath;
  const foreignLocalEvidence = join(foreignRoot, "evidence/observability");
  const foreignEvidenceBefore = (await readdir(foreignLocalEvidence)).sort();
  await assert.rejects(
    runObservabilityVerification({
      root: foreignRoot,
      probePath,
      run: () => {
        throw new Error("unexpected Docker");
      },
    }),
    /candidate root differs from verifier root/u,
  );
  await assert.rejects(
    runObservabilityVerification({
      root,
      probePath,
      run: () => {
        throw new Error("unexpected Docker");
      },
    }),
    (error) =>
      error.evidence?.status === "FAIL" &&
      /candidate root differs from verifier root/u.test(error.evidence.failure),
  );
  assert.deepEqual(
    (await readdir(foreignLocalEvidence)).sort(),
    foreignEvidenceBefore,
  );
  assert.equal(
    await stat(join(foreign.artifacts, "observability")).catch(() => null),
    null,
  );
  const malformed = await makeContext("20261030T120004Z");
  await chmod(malformed.contextPath, 0o600);
  await writeFile(malformed.contextPath, "{");
  process.env.COFFEE_LAUNCH_CONTEXT_FILE = malformed.contextPath;
  await assert.rejects(
    runObservabilityVerification({
      root,
      probePath,
      run: () => {
        throw new Error("unexpected Docker");
      },
    }),
    (error) => error.evidence?.status === "FAIL",
  );
  assert.equal(
    await stat(join(malformed.artifacts, "observability")).catch(() => null),
    null,
  );

  const currentRoot = join(directory, "current-candidate");
  const currentSource = join(directory, "current-source");
  execReal("git", ["clone", "--quiet", "--no-local", root, currentRoot]);
  execReal("git", [
    "-C",
    currentRoot,
    "remote",
    "set-url",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  ]);
  for (const file of [
    "config/platform.yaml",
    "config/toolchain-versions.json",
    "pnpm-lock.yaml",
  ])
    await chmod(join(currentRoot, file), 0o644);
  execReal("git", [
    "clone",
    "--quiet",
    "--shared",
    "--no-hardlinks",
    currentRoot,
    currentSource,
  ]);
  execReal("git", [
    "-C",
    currentSource,
    "remote",
    "set-url",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  ]);
  await writeFile(
    join(currentRoot, ".git/info/exclude"),
    "node_modules\ndist\n",
    {
      flag: "a",
    },
  );
  await symlink(
    join(REPO_ROOT, "node_modules"),
    join(currentRoot, "node_modules"),
    "dir",
  );
  for (const group of ["apps", "packages"]) {
    for (const name of await readdir(join(currentRoot, group))) {
      for (const path of ["node_modules", "dist"]) {
        const source = join(REPO_ROOT, group, name, path);
        if (await stat(source).catch(() => null))
          await symlink(source, join(currentRoot, group, name, path), "dir");
      }
    }
  }
  const current = await makeContext(
    "20261030T120005Z",
    currentRoot,
    currentSource,
  );
  const replay = await makeContext(
    "20261030T120006Z",
    currentRoot,
    currentRoot,
  );
  for (const run of [current, replay])
    await writeSyntheticParentG12({
      candidateRoot: currentRoot,
      evidenceDir: run.evidenceDir,
      context: run.context,
      indexBytes,
    });
  assert.notEqual(current.context.runId, success.context.runId);
  assert.notEqual(
    current.context.sourceRepoRoot,
    success.context.sourceRepoRoot,
  );
  assert.notEqual(
    replay.context.sourceRepoRoot,
    current.context.sourceRepoRoot,
  );
  assert.equal(current.context.candidateSha, success.context.candidateSha);
  assert.equal(
    current.context.baseConfigSha256,
    success.context.baseConfigSha256,
  );
  const currentPacket = join(
    currentSource,
    "evidence/launch/qualifications",
    qualificationRunId,
  );
  const replayPacket = join(
    currentRoot,
    "evidence/launch/qualifications",
    qualificationRunId,
  );
  await mkdir(dirname(currentPacket), { recursive: true, mode: 0o700 });
  await mkdir(dirname(replayPacket), { recursive: true, mode: 0o700 });
  await cp(packet, currentPacket, { recursive: true });
  await cp(packet, replayPacket, { recursive: true });
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
  assert.equal(await stat(root).catch(() => null), null);
  for (const name of savedNames)
    assert.ok((await stat(join(saved, name))).isFile());
  const currentUserMock = t.mock.method(os, "userInfo", () => ({
    ...oldUserInfo(),
    homedir: directory,
  }));
  syncBuiltinESMExports();
  try {
    const { admitRealtimeCapacity: admitCurrent } = await import(
      pathToFileURL(join(currentRoot, "tools/realtime-capacity.mjs")).href
    );
    const accepted = await admitCurrent({
      receiptPath: join(currentPacket, "qualification.json"),
      contextFile: current.contextPath,
    });
    assert.equal(accepted.receipt.runId, qualificationRunId);
    await assert.rejects(
      admitCurrent({
        receiptPath: join(replayPacket, "qualification.json"),
        contextFile: replay.contextPath,
      }),
      { code: "EEXIST" },
    );
  } finally {
    currentUserMock.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("browser correlation admission verifies the sealed child bundle and scoped cleanup", async (t) => {
  const parent = await createMigrationLaunchFixture({
    databaseIsolation: true,
    alignedRunId: true,
  });
  const child = await createBrowserChildMigrationLaunchFixture(parent);
  t.after(async () => {
    await rm(child.evidenceDir, { recursive: true, force: true });
    await rm(child.root, { recursive: true, force: true });
    await rm(parent.evidenceDir, { recursive: true, force: true });
    await rm(parent.fixture.root, { recursive: true, force: true });
    await rm(parent.fixture.bin, { recursive: true, force: true });
  });
  const parentContext = JSON.parse(await readFile(parent.contextPath, "utf8"));
  parentContext.acceptedBaseCommit = parent.candidateSha;
  parentContext.evidenceDir = join(
    parent.fixture.root,
    "evidence/launch",
    parent.runId,
  );
  const context = JSON.parse(await readFile(child.contextPath, "utf8"));
  context.sourceRepoRoot = parent.fixture.root;
  context.evidenceDir = join(
    parent.fixture.root,
    "evidence/launch",
    child.runId,
  );
  context.checkoutDir = join(parent.fixture.root, ".g15-browser-child-removed");
  context.acceptedBaseCommit = parentContext.acceptedBaseCommit;
  context.resources.g08PreparationContextPath = join(
    parentContext.evidenceDir,
    "context.json",
  );
  const lineage = await readFile(
    join(
      child.evidenceDir,
      "gates/G15_BROWSER/artifacts/oidc-fixture-lineage.json",
    ),
  );
  const baseConfig = await readFile(
    join(parent.fixture.root, "config/platform.yaml"),
  );
  const childConfig = await readFile(join(child.root, "config/platform.yaml"));
  const directory = join(
    parentContext.evidenceDir,
    "gates/G14_OBSERVABILITY/artifacts",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bundle = join(directory, "browser-source.bundle");
  execFileSync(
    "git",
    ["update-ref", "refs/heads/g15-browser-child", child.candidateSha],
    { cwd: child.root },
  );
  execFileSync(
    "git",
    [
      "bundle",
      "create",
      bundle,
      "refs/heads/g15-browser-child",
      `^${parent.candidateSha}`,
    ],
    { cwd: child.root },
  );
  await chmod(bundle, 0o400);
  const childContext = Buffer.from(JSON.stringify(context));
  for (const [name, bytes] of [
    ["browser-context.json", childContext],
    ["browser-lineage.json", lineage],
    ["browser-base.yaml", baseConfig],
    ["browser-config.yaml", childConfig],
  ])
    await writeFile(join(directory, name), bytes, { mode: 0o400 });
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const databases = ["customer", "catalog", "pricing", "orders", "integration"]
    .map(
      (owner) =>
        `coffee_verify_${child.runId.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    runId: parent.runId,
    candidateSha: parent.candidateSha,
    baseConfigSha256: digest(baseConfig),
    childRunId: child.runId,
    childCandidateSha: child.candidateSha,
    childContextSha256: digest(childContext),
    lineageSha256: digest(lineage),
    bundleSha256: digest(await readFile(bundle)),
    baseConfigArtifactSha256: digest(baseConfig),
    childConfigArtifactSha256: digest(childConfig),
    checkoutRemoved: true,
    evidenceRemoved: true,
    proof: {
      verified: true,
      correlationId: "8f53d687-fd3b-47be-b32b-2081d08bc55a",
      traceId: "00bf08bba3714e52b26d23c08e06ce16",
      browserRefetchMatched: true,
      sseFrameMatched: true,
      ownerCausation: true,
    },
    cleanup: {
      verified: true,
      databases: { verified: true, removed: [...databases], retained: [] },
      attachment: {
        baselineAttached: false,
        attempted: true,
        removed: true,
        routePreserved: true,
      },
    },
  };
  const receiptPath = join(directory, "browser-correlation.json");
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await rm(child.root, { recursive: true, force: true });
  assert.equal(
    (
      await validateBrowserCorrelation({
        evidenceDir: parentContext.evidenceDir,
        parentContext,
      })
    ).files.length,
    6,
  );
  receipt.cleanup.attachment = {
    baselineAttached: true,
    attempted: false,
    removed: false,
    routePreserved: true,
  };
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal(
    (
      await validateBrowserCorrelation({
        evidenceDir: parentContext.evidenceDir,
        parentContext,
      })
    ).files.length,
    6,
  );
  for (const attachment of [
    {
      baselineAttached: true,
      attempted: true,
      removed: false,
      routePreserved: true,
    },
    {
      baselineAttached: true,
      attempted: false,
      removed: true,
      routePreserved: true,
    },
    {
      baselineAttached: false,
      attempted: false,
      removed: false,
      routePreserved: true,
    },
    { attempted: true, removed: true, routePreserved: true },
  ]) {
    receipt.cleanup.attachment = attachment;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(
      validateBrowserCorrelation({
        evidenceDir: parentContext.evidenceDir,
        parentContext,
      }),
      { code: "G14_BROWSER_CORRELATION_RECEIPT_INVALID" },
    );
  }
  receipt.cleanup.attachment = {
    baselineAttached: false,
    attempted: true,
    removed: true,
    routePreserved: true,
  };
  await writeFile(receiptPath, JSON.stringify(receipt));
  const observations = join(directory, "observability");
  await mkdir(observations, { mode: 0o700 });
  const observationRun = "00bf08bb-a371-4e52-b26d-23c08e06ce16";
  const names = [
    "alert-transitions.json",
    "correlation-proof.json",
    "redaction-scan.json",
    "queue-loss-counters.json",
    "retention-result.json",
    "runtime-health-matrix.json",
    "result.json",
  ];
  for (const name of names) {
    const data = { status: "PASS", runId: observationRun };
    if (name === "correlation-proof.json")
      data.launchPath = {
        correlationId: receipt.proof.correlationId,
        traceId: receipt.proof.traceId,
        browserRefetchMatched: true,
        ownerCausation: true,
      };
    if (name === "result.json")
      Object.assign(data, {
        browserCorrelationChild: receipt,
        provenance: {
          sourceHashStable: true,
          start: {
            baseSha: parent.candidateSha,
            configSha256: parentContext.baseConfigSha256,
            sourceFiles: { status: "PASS" },
          },
        },
        runtimeMetricMatrix: {
          composeReceipt: {
            postgres: { externalPostgres: true },
            externalCleanup: { verified: true },
          },
        },
        cleanupErrors: [],
        fullSystemG14: { status: "NOT_RUN" },
      });
    await writeFile(join(observations, name), JSON.stringify(data), {
      mode: 0o600,
    });
  }
  await writeFile(
    join(parentContext.evidenceDir, "context.json"),
    JSON.stringify(parentContext),
    { mode: 0o600 },
  );
  const { verifyGateArtifacts } =
    await import("../../verification/launch/v1/run.mjs");
  const wrongCommand = {
    runs: [
      {
        argv: ["true"],
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
      },
    ],
    artifacts: [],
  };
  assert.match(
    await verifyGateArtifacts(
      { id: "G14_OBSERVABILITY", command: "pnpm test:observability" },
      wrongCommand,
      parentContext.evidenceDir,
    ),
    /browser correlation child lineage or cleanup is invalid/u,
  );
  const record = {
    runs: [
      {
        argv: ["pnpm", "test:observability"],
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
      },
    ],
    artifacts: [],
  };
  assert.match(
    await verifyGateArtifacts(
      { id: "G14_OBSERVABILITY", command: "pnpm test:observability" },
      record,
      parentContext.evidenceDir,
    ),
    /full-system SLO, chaos and capacity proof is not complete/u,
  );
  assert.equal(
    record.artifacts.length,
    13,
    "valid child and observability files remain recorded on denial",
  );
  receipt.cleanup.databases.removed[0] = "coffeeorderdb";
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(
    validateBrowserCorrelation({
      evidenceDir: parentContext.evidenceDir,
      parentContext,
    }),
    { code: "G14_BROWSER_CORRELATION_RECEIPT_INVALID" },
  );
  receipt.cleanup.databases.removed = databases;
  receipt.proof.browserRefetchMatched = false;
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(
    validateBrowserCorrelation({
      evidenceDir: parentContext.evidenceDir,
      parentContext,
    }),
    { code: "G14_BROWSER_CORRELATION_RECEIPT_INVALID" },
  );
});

async function writeMigrationPreparationArtifact(
  launch,
  {
    systemIdentifier = "7613370342949990434",
    mutateWrapper = (value) => value,
    mutatePreparation = (value) => value,
  } = {},
) {
  const { fixture, evidenceDir, runId, candidateSha } = launch;
  const context = JSON.parse(
    await readFile(join(evidenceDir, "context.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(fixture.root, "config/database-role-map.json"), "utf8"),
  );
  const roleNames = [
    ...roleMap.databases.map((database) => database.migratorRole),
    ...roleMap.databases.flatMap((database) =>
      database.runtimeRoles.map((runtime) => runtime.role),
    ),
  ];
  const bundleSha256 = createHash("sha256")
    .update(
      await readFile(join(fixture.root, "secrets/platform.secrets.sops.yaml")),
    )
    .digest("hex");
  const preparation = mutatePreparation({
    schemaVersion: 1,
    stage: "roles-created",
    runId: runId.replace(/-[0-9a-f]{7}$/u, `-${candidateSha.slice(0, 7)}`),
    candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    configSha256: context.baseConfigSha256,
    postgres: {
      host: "coffee_postgres",
      port: 5432,
      version: "17.11",
      systemIdentifier,
      database: "postgres",
      user: "coffeeuser",
    },
    bundle: {
      beforeSha256: bundleSha256,
      resultingSha256: bundleSha256,
    },
    roleNames,
    createdCount: 15,
    transaction: "committed",
  });
  const wrapper = mutateWrapper({
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256: context.baseConfigSha256,
    preparation,
  });
  const artifactDir = join(evidenceDir, "gates/G08_MIGRATIONS/artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(artifactDir, "canonical-preparation.json");
  await writeFile(artifactPath, JSON.stringify(wrapper), { mode: 0o400 });
  await chmod(artifactPath, 0o400);
  return { artifactPath, roleNames, bundleSha256 };
}

async function installFakeMigrationSops(
  fixture,
  {
    mutateBundleDuringEncrypt,
    invalidOutput,
    failEncryption = false,
    corruptTemporaryCiphertext = false,
    changeExistingCredential = false,
    additionalBundlePaths = [],
    savedBundleMutation = "",
  } = {},
) {
  const templatePath = join(fixture.bin, "g08-sops-template.json");
  const encryptMarker = join(fixture.bin, "g08-encrypt-invoked");
  const temporaryDecryptArgsPath = join(
    fixture.bin,
    "g08-temp-decrypt-args.json",
  );
  const bundlePath = join(fixture.root, "secrets/platform.secrets.sops.yaml");
  const initialBundleSha256 = createHash("sha256")
    .update(await readFile(bundlePath))
    .digest("hex");
  await writeFile(
    templatePath,
    JSON.stringify(syntheticEncryptedSecrets()),
    "utf8",
  );
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const templatePath = ${JSON.stringify(templatePath)};
const plainPath = ${JSON.stringify(fixture.plainPath)};
const marker = ${JSON.stringify(encryptMarker)};
const temporaryDecryptArgsPath = ${JSON.stringify(temporaryDecryptArgsPath)};
const bundlePath = ${JSON.stringify(bundlePath)};
const additionalBundlePaths = ${JSON.stringify(additionalBundlePaths)};
const initialBundleSha256 = ${JSON.stringify(initialBundleSha256)};
const mutation = ${JSON.stringify(typeof mutateBundleDuringEncrypt === "string" ? mutateBundleDuringEncrypt : "")};
const invalidOutput = ${JSON.stringify(invalidOutput ?? "")};
const failEncryption = ${JSON.stringify(failEncryption)};
const corruptTemporaryCiphertext = ${JSON.stringify(corruptTemporaryCiphertext)};
const changeExistingCredential = ${JSON.stringify(changeExistingCredential)};
const savedBundleMutation = ${JSON.stringify(savedBundleMutation)};
function transform(value, path, encode) {
  if (Array.isArray(value)) return value.map((child, index) => transform(child, [...path, String(index)], encode));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transform(child, [...path, key], encode)]));
  if (typeof value !== "string" || path[0] === "sops" || path.join(".") === "schemaVersion" || path.at(-1) === "username") return value;
  if (encode) return "ENC[AES256_GCM,data:" + Buffer.from(value).toString("base64") + ",iv:fixture,tag:fixture,type:str]";
  const match = value.match(/^ENC\\[AES256_GCM,data:([^,]+),iv:[^,]+,tag:[^,]+,type:(?:str|bytes)\\]$/u);
  if (!match) throw new Error("invalid fake encrypted leaf");
  return Buffer.from(match[1], "base64").toString("utf8");
}
if (args[0] === "encrypt") {
  const plain = JSON.parse(fs.readFileSync(0, "utf8"));
  if (failEncryption) {
    fs.writeFileSync(marker, JSON.stringify(args));
    process.stderr.write("synthetic SOPS failure canary");
    process.exit(17);
  }
  if (invalidOutput === "empty") {
    fs.writeFileSync(marker, JSON.stringify(args));
    process.stdout.write("{}");
    process.exit(0);
  }
  const encrypted = transform(plain, [], true);
  if (invalidOutput === "plaintext") encrypted.environments.development.bootstrap.migrators.customer = "plaintext-canary";
  if (changeExistingCredential) encrypted.environments.development.postgres.customer.password = "ENC[AES256_GCM,data:Y2hhbmdlZA==,iv:fixture,tag:fixture,type:str]";
  encrypted.sops = JSON.parse(fs.readFileSync(templatePath, "utf8")).sops;
  fs.writeFileSync(marker, JSON.stringify(args));
  if (mutation) fs.writeFileSync(bundlePath, mutation);
  process.stdout.write(JSON.stringify(encrypted) + (invalidOutput === "plaintext-leak" ? "\\n# " + plain.environments.development.bootstrap.postgresAdminPassword : ""));
} else if (args.includes("--decrypt")) {
  const currentPath = args.at(-1);
  if (/\\.platform\\.secrets\\.sops\\.yaml\\.[^/]+\\.tmp$/u.test(currentPath)) {
    fs.writeFileSync(temporaryDecryptArgsPath, JSON.stringify(args));
    if (corruptTemporaryCiphertext) process.exit(23);
  }
  const currentBytes = fs.readFileSync(currentPath);
  const currentSha256 = crypto.createHash("sha256").update(currentBytes).digest("hex");
  if ([bundlePath, ...additionalBundlePaths].includes(currentPath) && currentSha256 === initialBundleSha256) {
    process.stdout.write(fs.readFileSync(plainPath, "utf8"));
  } else {
    const current = JSON.parse(currentBytes.toString("utf8"));
    const plain = transform(current, [], false);
    delete plain.sops;
    if (currentPath === bundlePath && currentSha256 !== initialBundleSha256) {
      if (savedBundleMutation === "foreign-field")
        plain.environments.development.postgres.customer.password = "foreign-saved-canary";
      if (savedBundleMutation === "wrong-migrator-map")
        plain.environments.development.bootstrap.migrators.customer = "foreign-saved-canary";
    }
    process.stdout.write(JSON.stringify(plain));
  }
} else {
  process.exitCode = 2;
}
`;
  const sopsPath = join(fixture.bin, "sops");
  await writeFile(sopsPath, source, { mode: 0o700 });
  await chmod(sopsPath, 0o700);
  return { encryptMarker };
}

async function installFakeMigrationAdminDocker(
  fixture,
  {
    password = "synthetic-g08-container-password",
    changeOnInspection = 0,
    changeNetworkOnInspection = 0,
    failAction = "",
    malformedInspect = false,
  } = {},
) {
  const callLogPath = join(fixture.bin, "g08-docker-calls.json");
  await writeFile(callLogPath, "", { mode: 0o600 });
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(callLogPath)};
const password = Buffer.from(${JSON.stringify(Buffer.from(password).toString("base64"))}, "base64");
const changeOnInspection = ${JSON.stringify(changeOnInspection)};
const changeNetworkOnInspection = ${JSON.stringify(changeNetworkOnInspection)};
const failAction = ${JSON.stringify(failAction)};
const malformedInspect = ${JSON.stringify(malformedInspect)};
const inspectionCount = fs.readFileSync(logPath, "utf8").split("\\n").filter((line) => line && JSON.parse(line).action === "inspect").length + 1;
fs.appendFileSync(logPath, JSON.stringify({ action: args[0] }) + "\\n");
if (args[0] === failAction) process.exit(17);
if (args[0] === "inspect") {
  if (malformedInspect) {
    process.stdout.write("not-json\\n");
    process.exit(0);
  }
  const containerId = changeOnInspection && inspectionCount >= changeOnInspection
    ? "f".repeat(64)
    : "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f";
  const networkId = changeNetworkOnInspection && inspectionCount >= changeNetworkOnInspection
    ? "e".repeat(64)
    : "d".repeat(64);
  process.stdout.write([containerId, "sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b", "true", JSON.stringify({ coffee_network: { NetworkID: networkId } })].join("\\n") + "\\n");
} else if (args[0] === "exec") {
  process.stdout.write(password);
} else {
  process.exitCode = 2;
}
`;
  const dockerPath = join(fixture.bin, "docker");
  await writeFile(dockerPath, source, { mode: 0o700 });
  await chmod(dockerPath, 0o700);
  return { callLogPath };
}

function syntheticEncryptedSecrets() {
  const encrypted = "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]";
  const recipients = [
    "age19nj28zyvv2epe64gfexkzasguc2dh596dj5z5fvrlu58lsp2sqxqzk93wh",
    "age1cehh5tuxnuqq2sq8ekz2tzym8fmn9gdepngud6dakt7nnvfd63qsajm2cr",
    "age1aqtw0rf374l6kys2y34jfqfc0sfd3z8dzrfkc4cy92ktxjkvfsgq0u6y4f",
  ];
  const schema = JSON.parse(
    readFileSync(`${REPO_ROOT}/secrets/platform-secrets.schema.json`, "utf8"),
  );
  const build = (definition) => {
    if (definition.$ref)
      return build(
        definition.$ref
          .split("/")
          .slice(1)
          .reduce(
            (value, part) =>
              value[part.replaceAll("~1", "/").replaceAll("~0", "~")],
            schema,
          ),
      );
    if (definition.const !== undefined) return definition.const;
    if (definition.enum) return definition.enum[0];
    if (definition.type === "string") return encrypted;
    if (definition.type === "integer") return definition.minimum ?? 1;
    if (definition.type === "array")
      return definition.minItems
        ? Array.from({ length: definition.minItems }, () =>
            build(definition.items),
          )
        : [];
    if (definition.type === "object")
      return Object.fromEntries(
        (definition.required ?? []).map((key) => [
          key,
          build(definition.properties[key]),
        ]),
      );
    return {};
  };
  const result = build(schema);
  result.sops.age = recipients.map((recipient) => ({
    recipient,
    enc: "-----BEGIN AGE ENCRYPTED FILE-----\nfixture\n-----END AGE ENCRYPTED FILE-----",
  }));
  result.sops.lastmodified = "2026-10-14T00:00:00Z";
  result.sops.version = "3.13.3";
  result.sops.unencrypted_regex = "^(schemaVersion|username)$";
  return result;
}

async function createMigrationLaunchFixture({
  migratorBlock = false,
  databaseIsolation = false,
  alignedRunId = false,
} = {}) {
  const fixture = await createSecretMaterializationFixture();
  let runId = `${new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z-${Math.floor(
    Math.random() * 0x10000000,
  )
    .toString(16)
    .padStart(7, "0")}`;
  let evidenceDir = join(REPO_ROOT, "evidence/launch", runId);
  let contextPath = join(evidenceDir, "context.json");
  const adminPassword = "fixture-g08-admin-canary";
  try {
    const plain = JSON.parse(await readFile(fixture.plainPath, "utf8"));
    plain.environments.development.bootstrap.postgresAdminPassword =
      adminPassword;
    const ownership = JSON.parse(
      await readFile(
        join(fixture.root, "config/database-ownership.json"),
        "utf8",
      ),
    );
    for (const claim of ownership.runtimeClaims) {
      if (!claim.role || !claim.secretRef) continue;
      valueAtPath(plain.environments.development, claim.secretRef).username =
        claim.role;
    }
    const encryptedPath = join(
      fixture.root,
      "secrets/platform.secrets.sops.yaml",
    );
    const encrypted = JSON.parse(await readFile(encryptedPath, "utf8"));
    if (migratorBlock) {
      const owners = [
        "customer",
        "catalog",
        "pricing",
        "orders",
        "integration",
      ];
      plain.environments.development.bootstrap.migrators = Object.fromEntries(
        owners.map((owner) => [owner, `existing-migrator-${owner}-canary`]),
      );
      encrypted.environments.development.bootstrap.migrators =
        Object.fromEntries(
          owners.map((owner) => [
            owner,
            "ENC[AES256_GCM,data:x,iv:x,tag:x,type:str]",
          ]),
        );
    }
    await writeFile(fixture.plainPath, JSON.stringify(plain), "utf8");
    await writeFile(encryptedPath, JSON.stringify(encrypted), "utf8");
    const configPath = join(fixture.root, "config/platform.yaml");
    const configDocument = parseYaml(await readFile(configPath, "utf8"), {
      json: true,
    });
    configDocument.verification.databaseIsolation.enabled = databaseIsolation;
    configDocument.verification.kafkaNamespaceIsolation = false;
    await writeFile(configPath, dumpYaml(configDocument, { lineWidth: -1 }));
    await chmod(configPath, 0o644);
    await chmod(encryptedPath, 0o600);

    execFileSync("git", ["init", "-q"], { cwd: fixture.root });

    execFileSync("git", ["config", "user.name", "G08 fixture"], {
      cwd: fixture.root,
    });
    execFileSync("git", ["config", "user.email", "g08@example.invalid"], {
      cwd: fixture.root,
    });
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/YurGusev/CoffeeOrderPlatform",
      ],
      { cwd: fixture.root },
    );
    execFileSync(
      "git",
      ["add", "config", "platform", "secrets", ".sops.yaml"],
      { cwd: fixture.root },
    );
    execFileSync("git", ["commit", "-qm", "G08 readonly probe fixture"], {
      cwd: fixture.root,
    });
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.root,
      encoding: "utf8",
    }).trim();
    if (alignedRunId) {
      runId = runId.replace(/-[0-9a-f]{7}$/u, `-${candidateSha.slice(0, 7)}`);
      evidenceDir = join(REPO_ROOT, "evidence/launch", runId);
      contextPath = join(evidenceDir, "context.json");
    }
    const baseConfigSha256 = createHash("sha256")
      .update(await readFile(join(fixture.root, "config/platform.yaml")))
      .digest("hex");
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        candidateSha,
        baseConfigSha256,
        sourceRepoRoot: REPO_ROOT,
        evidenceDir,
        checkoutDir: fixture.root,
      }),
      { mode: 0o400 },
    );
    await chmod(contextPath, 0o400);
    return {
      fixture,
      runId,
      evidenceDir,
      contextPath,
      candidateSha,
      adminPassword,
    };
  } catch (error) {
    await rm(evidenceDir, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.bin, { recursive: true, force: true });
    throw error;
  }
}
