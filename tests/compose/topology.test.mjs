import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import test from "node:test";
import {createRuntimeLoggingOverride} from "../../tools/observability/generate.mjs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const COMPOSE_FILE = join(REPO_ROOT, "compose.yaml");
const OBSERVABILITY_CONFIG = {
  platform: {shutdownGraceMs: 30000, health: {intervalMs: 5000, timeoutMs: 1000, startupGraceMs: 30000, failureThreshold: 3}},
  telemetry: {
    collector: {
      otlpEndpoint: "http://otel-collector:4318",
      healthEndpoint: "http://otel-collector:13133",
      metricsEndpoint: "http://otel-collector:8888",
      memoryLimitMiB: 128,
      memorySpikeMiB: 32,
      containerMemoryMiB: 512,
    },
    producer: {maxRecordBytes: 16384, queueCapacity: 256},
    logging: {maxSizeMiB: 8, maxFiles: 3},
  },
};

void test("programmatic observability hooks require a bounded recovery-proof run", async () => {
  const {runComposeSmoke} = await import("../../tools/compose-smoke.mjs");
  const hooks = {
    exporterToken: "fixture-exporter-token",
    onReady: async () => {},
    onCleanup: async () => {},
  };
  await assert.rejects(
    runComposeSmoke({args: ["--stub-secrets"], observability: hooks}),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({args: ["--recovery-proof", "--no-build"], observability: hooks}),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({args: ["--recovery-proof", "--keep"], observability: hooks}),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({args: ["--recovery-proof"], observability: {...hooks, exporterToken: ""}}),
    /exporterToken must not be empty/,
  );
  await assert.rejects(
    runComposeSmoke({args: ["--recovery-proof"], observability: {...hooks, onReady: undefined}}),
    /onReady must be a function/,
  );
  let cleanupCalls = 0;
  let cleanupContext = "not-invoked";
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--project-name", "coffee-platform"],
      observability: {...hooks, onCleanup: async (context) => {
        cleanupCalls += 1;
        cleanupContext = context;
      }},
    }),
    /main platform project/,
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupContext, undefined);
});

void test("smoke removes only images built by this run and preserves keep/no-build/shared images", async (t) => {
  const {buildRuntimeImages, removeBuiltRuntimeImages} = await import("../../tools/compose-smoke.mjs");
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push([command, args]);
    if (args.includes("RUNTIME=second")) throw new Error("build interrupted");
    return "";
  });
  syncBuiltinESMExports();
  try {
    const images = [];
    assert.throws(() => buildRuntimeImages("coffee-cleanup-proof", ["first", "second"], images), /interrupted/);
    assert.deepEqual(images, ["coffee-cleanup-proof-first:latest"]);
    calls.length = 0;
    removeBuiltRuntimeImages(images, {keep: true});
    removeBuiltRuntimeImages(images, {noBuild: true});
    assert.deepEqual(calls, []);
    removeBuiltRuntimeImages(images, {});
    assert.deepEqual(calls, [["docker", ["image", "rm", "coffee-cleanup-proof-first:latest"]]]);
    calls.length = 0;
    const complete = [];
    buildRuntimeImages("coffee-cleanup-proof", ["first"], complete);
    assert.deepEqual(complete, images, "shared nginx must not be scheduled for deletion");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("all smoke modes isolate networks while only topology smoke adopts external PostgreSQL", async () => {
  const {writeScopedComposeOverride} = await import("../../tools/compose-smoke.mjs");
  for (const [sharedPostgres, recoveryLogging] of [[true, false], [false, false], [false, true]]) {
    const path = await writeScopedComposeOverride("coffee-scope-proof", {
      sharedPostgres,
      ...(recoveryLogging ? {recoveryProof: true, runtimeLogging: OBSERVABILITY_CONFIG} : {}),
    });
    try {
      const result = spawnSync("docker", ["compose", "-p", "coffee-scope-proof", "-f", COMPOSE_FILE, "-f", path, "config", "--format", "json"], {
        encoding: "utf8", env: {...process.env, COFFEE_COMPOSE_SECRETS_DIR: "/dev/shm"},
      });
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      for (const [name, network] of Object.entries(config.networks)) {
        assert.equal(network.name, name === "coffee_postgres_data" && sharedPostgres ? name : `coffee-scope-proof_${name}`);
      }
      assert.equal(config.networks.coffee_postgres_data.external, true);
      if (recoveryLogging) {
        const expectedLogging = createRuntimeLoggingOverride({config: OBSERVABILITY_CONFIG}).services;
        for (const [service, expected] of Object.entries(expectedLogging)) {
          assert.deepEqual(config.services[service].logging, expected.logging, `${service} Docker logging policy`);
        }
        assert.equal(config.services["aroma-provider-fixture"].logging, undefined);
      } else assert.equal(config.services["edge-gateway"].logging, undefined);
    } finally {
      await rm(path);
    }
  }
});

void test("local container controls exclude shared PostgreSQL and refuse deletion of running groups", async () => {
  const directory = await mkdtemp("/dev/shm/coffee-controls-proof-");
  const docker = join(directory, "docker");
  await writeFile(docker, `#!/bin/sh
case "$1" in
  ps)
    case "$*" in
      *service=api*) echo 'api-id api' ;;
      *) printf 'db-id postgres\\napi-id api\\nui-id blazorui\\n' ;;
    esac ;;
  inspect)
    case "$*" in *Running*) echo true ;; *) printf '%s\\n' "$*" ;; esac ;;
  start|stop) printf '%s\\n' "$*" ;;
  container) echo 'unsafe delete reached' >&2; exit 99 ;;
  *) exit 98 ;;
esac
`, "utf8");
  await chmod(docker, 0o700);
  const run = (...args) => spawnSync("bash", [join(REPO_ROOT, "tools/coffee-containers.sh"), ...args], {encoding: "utf8", env: {...process.env, PATH: `${directory}:${process.env.PATH}`}});
  try {
    const status = run("legacy", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /api-id ui-id/);
    assert.doesNotMatch(status.stdout, /db-id/);
    const start = run("legacy", "start");
    assert.equal(start.status, 0);
    assert.equal(start.stdout.trim(), "start api-id", "disabled UI must remain stopped");
    const stop = run("legacy", "stop");
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout.trim(), "stop --time 30 api-id ui-id");
    const removal = run("legacy", "remove");
    assert.equal(removal.status, 1);
    assert.match(removal.stderr, /Сначала/);
    assert.doesNotMatch(removal.stderr, /unsafe delete/);
    assert.equal(run("legacy", "remove", "--volumes").status, 2);
    assert.equal(run("unknown", "stop").status, 2);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

const RUNTIMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
];

const NETWORKS = {
  "edge-gateway": ["coffee_edge_backend"],
  "api-public": ["coffee_edge_backend", "coffee_public_api_backend"],
  "api-internal": ["coffee_internal_api"],

  "customer-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "catalog-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "catalog-supplier-sync": ["coffee_internal_api", "coffee_postgres_data"],
  "catalog-activation-worker": ["coffee_postgres_data", "coffee_kafka_event", "coffee_internal_api"],
  "pricing-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "orders-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "orders-aroma-preparation": ["coffee_postgres_data", "coffee_kafka_event"],
  "aroma-observer": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "aroma-convergence": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "aroma-gateway": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_provider_egress",
  ],
  "realtime-gateway": ["coffee_edge_backend", "coffee_kafka_event"],
};

const SCOPED_SECRET_NAMES = [
  ...RUNTIMES.map((runtime) => `runtime-${runtime}`),
  "edge-nginx-public-cert",
  "edge-nginx-public-key",
  "edge-nginx-upstream-ca",
  "edge-nginx-client-cert",
  "edge-nginx-client-key",
];

function composeConfig(projectName) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...(projectName === undefined ? [] : ["--project-name", projectName]),
      "-f",
      COMPOSE_FILE,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.error,
    undefined,
    `Docker is required for topology validation: ${result.error?.message ?? ""}`,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

void test("Compose materializes 14 Node runtimes, native nginx, and Kafka", () => {
  const config = composeConfig();
  assert.deepEqual(
    Object.keys(config.services).sort((left, right) =>
      left.localeCompare(right),
    ),
    [...RUNTIMES, "edge-nginx", "kafka"].sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(config.services["api-agent"], undefined);
  assert.equal(config.services["config-bootstrap"], undefined);
  assert.equal(config.services.postgres, undefined);
  const nginx = config.services["edge-nginx"];
  assert.equal(nginx.build.dockerfile, "apps/edge-nginx/Dockerfile");
  assert.deepEqual(Object.keys(nginx.depends_on).sort(), ["api-public", "edge-gateway", "realtime-gateway"]);
  for (const dependency of Object.values(nginx.depends_on)) assert.equal(dependency.condition, "service_healthy");
  assert.equal(nginx.user, "101:101");
  assert.equal(nginx.read_only, true);
  assert.equal(nginx.init, true);
  assert.equal(nginx.volumes, undefined);
  assert.equal(nginx.cpus, 2, "native nginx must have the accepted CPU bound");
  assert.equal(nginx.mem_limit, "536870912", "native nginx must have the accepted 512 MiB memory bound");
  assert.deepEqual(nginx.ulimits?.nofile, {soft: 16384, hard: 16384});
  assert.deepEqual(nginx.tmpfs, ["/tmp:rw,noexec,nosuid,nodev,size=8m"]);
  assert.deepEqual(Object.keys(nginx.networks).sort(), ["coffee_edge_backend", "coffee_host_ingress"]);
  assert.deepEqual(nginx.ports.map(({target, published, host_ip}) => ({target, published, host_ip})), [
    {target: 8443, published: "8443", host_ip: "127.0.0.1"},
  ]);
  assert.deepEqual(nginx.secrets.map(({target, uid, gid, mode}) => ({target, uid, gid, mode})), [
    {target: "/run/secrets/edge-nginx/public.crt", uid: "101", gid: "101", mode: "0400"},
    {target: "/run/secrets/edge-nginx/public.key", uid: "101", gid: "101", mode: "0400"},
    {target: "/run/secrets/edge-nginx/upstream-ca.crt", uid: "101", gid: "101", mode: "0400"},
    {target: "/run/secrets/edge-nginx/client.crt", uid: "101", gid: "101", mode: "0400"},
    {target: "/run/secrets/edge-nginx/client.key", uid: "101", gid: "101", mode: "0400"},
  ]);

  for (const runtime of RUNTIMES) {
    const service = config.services[runtime];
    assert.deepEqual(
      Object.keys(service.networks).sort((left, right) =>
        left.localeCompare(right),
      ),
      [...NETWORKS[runtime]].sort((left, right) => left.localeCompare(right)),
      runtime,
    );
    assert.equal(service.stop_grace_period, "30s", runtime);
    assert.equal(service.user, "node", runtime);
    assert.equal(service.init, true, runtime);
    assert.equal(service.read_only, true, runtime);
    assert.deepEqual(
      service.tmpfs,
      ["/tmp:rw,noexec,nosuid,nodev", "/run/secrets:rw,noexec,nosuid,nodev"],
      runtime,
    );
    assert.equal(service.volumes, undefined, runtime);
    assert.deepEqual(
      service.healthcheck.test.slice(0, 1),
      ["CMD-SHELL"],
      runtime,
    );
    assert.equal(service.environment.RUNTIME_NAME, runtime, runtime);
    assert.equal(
      service.environment.COFFEE_CONFIG_FILE,
      "/app/config/platform.yaml",
      runtime,
    );
    assert.equal(
      service.environment.COFFEE_RUNTIME_SECRETS_FILE,
      "/run/secrets/coffee-platform.yaml",
      runtime,
    );
    assert.equal(service.environment.OTEL_SERVICE_NAME, runtime, runtime);
    assert.equal(
      service.environment.OTEL_PROPAGATORS,
      "tracecontext,baggage",
      runtime,
    );
    assert.equal(
      service.environment.OTEL_RESOURCE_ATTRIBUTES,
      "service.namespace=coffee-platform,deployment.environment=development",
      runtime,
    );
    assert.equal(
      service.environment.OTEL_EXPORTER_OTLP_PROTOCOL,
      "http/protobuf",
      runtime,
    );
    assert.deepEqual(
      service.secrets,
      [
        {
          source: `runtime-${runtime}`,
          target: "/run/secrets/coffee-platform.yaml",
          uid: "1000",
          gid: "1000",
          mode: "0400",
        },
      ],
      runtime,
    );
    assert.equal(service.ports, undefined, runtime);
  }
  assert.deepEqual(
    Object.keys(config.secrets).sort((left, right) =>
      left.localeCompare(right),
    ),
    [...SCOPED_SECRET_NAMES].sort((left, right) => left.localeCompare(right)),
  );
  for (const runtime of RUNTIMES) {
    const source = config.secrets[`runtime-${runtime}`].file;
    assert.match(
      source,
      /^\/dev\/shm\//,
      `${runtime} secret source must be ephemeral tmpfs`,
    );
    assert.equal(
      source.includes("/CoffeeOrderPlatform"),
      false,
      `${runtime} secret source must not be persistent workspace storage`,
    );
  }
});

void test("Compose networks enforce the launch planes and external PostgreSQL attachment", () => {
  const config = composeConfig();
  assert.deepEqual(Object.keys(config.networks).sort(), [
    "coffee_edge_backend",
    "coffee_host_ingress",
    "coffee_internal_api",
    "coffee_kafka_event",
    "coffee_postgres_data",
    "coffee_provider_egress",
    "coffee_public_api_backend",
  ]);
  assert.equal(config.networks.coffee_postgres_data.external, true);
  assert.equal(
    config.networks.coffee_postgres_data.name,
    "coffee_postgres_data",
  );
  assert.equal(config.networks.coffee_postgres_data.internal, undefined);
  assert.equal(config.networks.coffee_host_ingress.name, "coffee_host_ingress");
  assert.notEqual(config.networks.coffee_host_ingress.internal, true);
  assert.deepEqual(
    Object.entries(config.services)
      .filter(([, service]) => Object.hasOwn(service.networks, "coffee_host_ingress"))
      .map(([name]) => name),
    ["edge-nginx"],
    "only edge-nginx may join the host-reachable ingress network",
  );
  assert.notEqual(config.networks.coffee_provider_egress.internal, true);
  for (const name of [
    "coffee_edge_backend",
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_kafka_event",
  ]) {
    assert.equal(config.networks[name].internal, true, name);
  }
});

void test("Compose keeps forbidden trust-plane connections absent (negative topology)", () => {
  const config = composeConfig();
  const forbidden = {
    "edge-gateway": [
      "coffee_public_api_backend",
      "coffee_internal_api",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "api-public": [
      "coffee_internal_api",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "api-internal": [
      "coffee_public_api_backend",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "customer-service": ["coffee_kafka_event", "coffee_provider_egress"],
    "aroma-gateway": ["coffee_kafka_event"],
  };
  for (const runtime of RUNTIMES) {
    const attached = new Set(Object.keys(config.services[runtime].networks));
    assert.equal(
      attached.has("coffee_network"),
      false,
      `${runtime} must not join legacy coffee_network`,
    );
    for (const network of forbidden[runtime] ?? []) {
      assert.equal(
        attached.has(network),
        false,
        `${runtime} must not join ${network}`,
      );
    }
  }
  const providerMembers = RUNTIMES.filter((runtime) =>
    Object.hasOwn(config.services[runtime].networks, "coffee_provider_egress"),
  );
  assert.deepEqual(providerMembers, ["aroma-gateway"]);
});

void test("Kafka is pinned and runs as a single-node KRaft broker without host publish", () => {
  const config = composeConfig();
  const kafka = config.services.kafka;
  assert.equal(
    kafka.image,
    "apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837",
  );
  assert.deepEqual(Object.keys(kafka.networks), ["coffee_kafka_event"]);
  assert.equal(kafka.ports, undefined);
  assert.equal(kafka.environment.KAFKA_PROCESS_ROLES, "broker,controller");
  assert.equal(
    kafka.environment.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP,
    "CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL",
  );
  assert.equal(kafka.environment.KAFKA_LISTENERS, "SASL_SSL://:9092,CONTROLLER://:29093");
  assert.equal(kafka.environment.KAFKA_ADVERTISED_LISTENERS, "SASL_SSL://kafka:9092");
  assert.equal(kafka.environment.KAFKA_INTER_BROKER_LISTENER_NAME, "SASL_SSL");
  assert.equal(kafka.environment.KAFKA_AUTO_CREATE_TOPICS_ENABLE, "false");
  assert.match(kafka.healthcheck.test[1], /kafka-broker-api-versions/);
});

void test("Kafka data uses a project-scoped named volume", async () => {
  const config = composeConfig();
  const scopedConfig = composeConfig("coffee-topology-volume-scope");
  const kafkaData = config.volumes?.kafka_data;
  assert.equal(config.services.kafka.environment.KAFKA_LOG_DIRS, "/var/lib/kafka/data");
  assert.deepEqual(kafkaData, { name: "coffee-platform_kafka_data" });
  assert.equal(
    scopedConfig.volumes?.kafka_data?.name,
    "coffee-topology-volume-scope_kafka_data",
  );
  assert.deepEqual(
    config.services.kafka.volumes.filter(({ target }) =>
      target === "/var/lib/kafka/data",
    ),
    [
      {
        type: "volume",
        source: "kafka_data",
        target: "/var/lib/kafka/data",
        volume: {},
      },
    ],
  );
  const source = await readFile(COMPOSE_FILE, "utf8");
  assert.doesNotMatch(source, /(^|\n)  kafka_data:\n(?:    .*\n)*    name:/);
});

void test("observability overlay keeps OpenObserve private and bounds exact Docker log mounts", async () => {
  const {createComposeOverride, createRuntimeLoggingOverride} = await import("../../tools/observability/generate.mjs");
  const id = "a".repeat(64);
  const logFiles = [{service: "edge-nginx", containerId: id, logPath: `/var/lib/docker/containers/${id}/${id}-json.log`}];
  const overlay = createComposeOverride({
    config: {
      ...OBSERVABILITY_CONFIG,
      telemetry: {...OBSERVABILITY_CONFIG.telemetry, openObserve: {endpoint: "http://openobserve:5080", bootstrapEmail: "operations@coffee-platform.internal", validationMarker: "bootstrap-validation-placeholder", telemetryEnabled: false, mmdbDownloadEnabled: false, modelPricingEnabled: false, maxDiskBytes: 1073741824, memoryLimitMiB: 512, memTableMaxSizeMiB: 128, maxFileSizeInMemoryMiB: 8, maxFileSizeOnDiskMiB: 8, maxFileRetentionSeconds: 30, memPersistIntervalSeconds: 2, compactionIntervalSeconds: 60, deleteFilesDelayMinutes: 1, retentionDays: 3, diskWatermarkPercent: 80, jobCleanupWaitSeconds: 60}},
    },
    imageRefs: {otelCollectorImage: "otel/opentelemetry-collector-contrib@sha256:collector", openObserveImage: "openobserve@sha256:openobserve", bootstrapProbeSha256: "dbac288c29ba568459550a2da9e7ae0ded6b1fc728ee9fad3044c44e62d6ac14"},
    logFiles,
    collectorConfigPath: "/dev/shm/observability/collector.yaml",
    openObserveDataVolume: "coffee-topology-openobserve-data",
  });
  const collector = overlay.services["otel-collector"];
  const openObserve = overlay.services.openobserve;
  assert.deepEqual(openObserve.environment, {ZO_LOCAL_MODE: "true", ZO_DATA_DIR: "/data", ZO_HTTP_PORT: "5080", ZO_ROOT_USER_EMAIL: "operations@coffee-platform.internal", ZO_ROOT_USER_PASSWORD: "bootstrap-validation-placeholder", ZO_TELEMETRY: "false", ZO_MMDB_DISABLE_DOWNLOAD: "true", ZO_MODEL_PRICING_ENABLED: "false", ZO_MEM_TABLE_MAX_SIZE: "128", ZO_MAX_FILE_SIZE_IN_MEMORY: "8", ZO_MAX_FILE_SIZE_ON_DISK: "8", ZO_MAX_FILE_RETENTION_TIME: "30", ZO_MEM_PERSIST_INTERVAL: "2", ZO_COMPACT_INTERVAL: "60", ZO_COMPACT_DATA_RETENTION_INTERVAL: "60", ZO_COMPACT_DATA_RETENTION_DAYS: "3", ZO_COMPACT_DELETE_FILES_DELAY_MINUTES: "1", ZO_COMPACT_JOB_CLEAN_WAIT_TIME: "60", ZO_DISK_CIRCUIT_BREAKER_ENABLED: "true", ZO_DISK_CIRCUIT_BREAKER_THRESHOLD: "80"});
  assert.deepEqual(openObserve.entrypoint, ["/busybox", "sh", "-ceu"]);
  assert.match(openObserve.command[0], /\.coffee-initialized-v1/u);
  assert.match(openObserve.command[0], /test ! -L/u);
  assert.match(openObserve.command[0], /marker_email.*ZO_ROOT_USER_EMAIL/u);
  assert.ok(openObserve.healthcheck.test.join(" ").includes("test \"$used\" -lt '80'"));
  assert.deepEqual(openObserve.networks, ["coffee_observability"]);
  assert.deepEqual(collector.networks, ["coffee_observability", "coffee_edge_backend", "coffee_public_api_backend", "coffee_internal_api", "coffee_kafka_event"]);
  assert.equal(collector.ports, undefined);
  assert.equal(openObserve.ports, undefined);
  assert.equal(collector.healthcheck.test[1], "/busybox");
  assert.equal(collector.healthcheck.test[7], "1");
  assert.ok(openObserve.healthcheck.test.join(" ").includes("-T 1 "));
  assert.ok(openObserve.healthcheck.test.join(" ").includes("http://127.0.0.1:5080/healthz"));
  assert.ok(collector.volumes.some(({source, target, read_only}) => source === "/usr/bin/busybox" && target === "/busybox" && read_only));
  assert.ok(openObserve.volumes.some(({source, target, read_only}) => source === "/usr/bin/busybox" && target === "/busybox" && read_only));
  assert.deepEqual(collector.volumes.filter(({read_only}) => read_only !== true), [
    {type: "volume", source: "collector_checkpoints", target: "/var/lib/otelcol/file_storage"},
  ]);
  assert.ok(collector.volumes.some(({source, target, read_only}) => source === `/var/lib/docker/containers/${id}` && target === `/var/lib/docker/containers/${id}` && read_only));
  assert.equal(collector.volumes.some(({source}) => source === "/var/run/docker.sock"), false);
  assert.equal(collector.mem_limit, "512m");
  for (const role of ["otel-collector", "openobserve"])
    assert.equal(overlay.services[role].stop_grace_period, "30000ms");
  assert.deepEqual(overlay.volumes.openobserve_data, {external: true, name: "coffee-topology-openobserve-data"});
  assert.deepEqual(overlay.networks.coffee_observability, {name: "coffee_observability", internal: true});

  const logging = createRuntimeLoggingOverride({config: OBSERVABILITY_CONFIG});
  assert.deepEqual(logging.services["edge-gateway"].logging.options, {"max-size": "8m", "max-file": "3", mode: "non-blocking", "max-buffer-size": "4194304"});
  assert.deepEqual(logging.services.kafka.logging.options, {"max-size": "8m", "max-file": "3", mode: "non-blocking", "max-buffer-size": "4194304"});
});

void test("Node production image is exact, non-root, and keeps build tooling out of final stage", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /node:26\.8\.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae/,
  );
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS build/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS runtime/);
  assert.match(dockerfile, /pnpm --filter .* deploy --prod/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /COPY --from=build \/runtime/);
  assert.match(dockerfile, /COPY platform\/launch-v1-connectivity-policy\.json \.\/platform\/launch-v1-connectivity-policy\.json/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "scripts\/permission-enforce\.mjs"\]/);
  assert.match(dockerfile, /CMD \["--entry", "dist\/main\.js"\]/);
});

void test("Confluent Node 26 addon links dynamically to separately pinned librdkafka", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /AS librdkafka-build/);
  assert.match(dockerfile, /LIBRDKAFKA_VERSION=2\.15\.0/);
  assert.match(
    dockerfile,
    /LIBRDKAFKA_SOURCE_SHA256=259015220cdca708afe838b5aa79ebf1a5fb710fb4179cf918d390aed85d5dbc/,
  );
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /CKJS_LINKING=dynamic BUILD_LIBRDKAFKA=0/);
  assert.match(dockerfile, /ldd .*confluent-kafka-javascript\.node/);
  assert.doesNotMatch(dockerfile, /\/ckjs|librdkafka-static\.a/);
});

void test("recovery proof preserves the body error when orders-aroma-preparation restore also fails", async () => {
  const source = await readFile(new URL("../../tools/compose-smoke.mjs", import.meta.url), "utf8");
  const start = source.indexOf(`        runCompose(
          projectName,
          secretsDir,
          ["stop", "orders-aroma-preparation"],`);
  const end = source.indexOf("\n      }\n    }\n    if (!options.keep)", start);
  assert.ok(start >= 0 && end > start);
  const recoveryBlock = source.slice(start, end);
  const bodyError = new Error("BODY_SECRET_CANARY");
  const restoreError = new Error("RESTORE_SECRET_CANARY");
  const readinessError = new Error("READINESS_SECRET_CANARY");
  const run = ({bodyFails = false, restoreFails = false, readinessFails = false} = {}) => {
    const calls = [];
    const promise = runInNewContext(`(async()=>{${recoveryBlock};return nativeFoundation;})()`, {
      AggregateError, assert, bodyError, restoreError, readinessError,
      projectName: "synthetic-project", secretsDir: "synthetic-secrets", composeFile: "synthetic-compose",
      recoveryDatabaseProof: {port: 5432}, recoveryProofCredentials: {}, platformConfig: {}, nativeFoundation: undefined,
      prepareKafkaNativeFixture: async () => {if (bodyFails) throw bodyError;return {mappingTopic: "synthetic-topic"};},
      nativeFoundationSource: () => "synthetic-source",
      runCompose: (_project, _secrets, args) => {
        calls.push(args[0] === "up" ? "restore-up" : args[0]);
        if (args[0] === "up" && restoreFails) throw restoreError;
        if (args[0] === "exec") return JSON.stringify({sigterm: {received: true, gateEntered: true, activeAtSignal: {total: 1}, ownerCount: 1, closedMetrics: {consumer: {assigned: 0, active: 0, pending: 0}}}});
        return "";
      },
      assertOrdersOutboxBrokerRecovery: async () => ({recovered: true}),
      runKafkaBlackholeProof: async () => ({recovered: true}),
      waitForRuntimeReadiness: async () => {calls.push("readiness");if (readinessFails) throw readinessError;},
    });
    return {calls, promise};
  };

  const bodyOnly = run({bodyFails: true});
  await assert.rejects(bodyOnly.promise, (error) => error === bodyError);
  assert.deepEqual(bodyOnly.calls, ["stop", "restore-up", "readiness"]);
  await assert.rejects(run({restoreFails: true}).promise, (error) => error === restoreError);
  await assert.rejects(run({readinessFails: true}).promise, (error) => error === readinessError);
  await assert.rejects(run({bodyFails: true, restoreFails: true}).promise, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual([...error.errors], [bodyError, restoreError]);
    assert.equal(error.cause, bodyError);
    assert.equal(error.message, "Recovery proof and orders-aroma-preparation restoration both failed");
    assert.doesNotMatch(error.message, /BODY_SECRET_CANARY|RESTORE_SECRET_CANARY/u);
    return true;
  });
  const success = run();
  await success.promise;
  assert.deepEqual(success.calls, ["stop", "exec", "restore-up", "readiness"]);
});

void test("Orders recovery reads a complete bounded snapshot from every configured Kafka partition", () => {
  const source = readFile(new URL("../../tools/compose-smoke.mjs", import.meta.url), "utf8");
  return source.then((text) => {
    const start = text.indexOf("function readOrdersBrokerMessages(");
    const end = text.indexOf("\nasync function assertOrdersOutboxBrokerRecovery", start);
    assert.ok(start >= 0 && end > start);
    const readerSource = text.slice(start, end);
    const topic = {name: "coffee.orders.lifecycle.v1", partitions: 2};
    const commandError = new Error("synthetic Kafka command failure");
    const makeReader = ({offsets, records = {}, failCommand = false}) => {
      const commands = [];
      const reader = runInNewContext(`(${readerSource})`, {
        assert,
        runCompose: (_project, _secrets, args) => {
          const script = args.at(-1);
          commands.push(script);
          if (script.includes("kafka-get-offsets.sh")) return offsets;
          if (failCommand) throw commandError;
          const partition = Number(script.match(/--partition (\d+)/u)?.[1]);
          return records[partition] ?? "";
        },
      });
      return {commands, reader: () => reader("synthetic-project", "synthetic-secrets", "synthetic-compose", topic)};
    };

    const complete = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:2\n`,
      records: {1: '{"messageId":"one"}\n{"messageId":"two"}\n'},
    });
    assert.deepEqual(JSON.parse(JSON.stringify(complete.reader())), [{messageId: "one"}, {messageId: "two"}]);
    assert.equal(complete.commands.length, 2, "empty partitions need no consumer process");
    assert.match(complete.commands[1], /--partition 1 --offset 0 --max-messages 2 --timeout-ms 5000/u);
    assert.doesNotMatch(complete.commands.join(" "), /--group|2>\/dev\/null|\|\| true/u);

    const empty = makeReader({offsets: `${topic.name}:0:0\n${topic.name}:1:0\n`});
    assert.deepEqual(JSON.parse(JSON.stringify(empty.reader())), []);
    assert.equal(empty.commands.length, 1);

    for (const offsets of [
      `${topic.name}:0:1\n`,
      `${topic.name}:0:1\n${topic.name}:0:1\n${topic.name}:1:0\n`,
      `${topic.name}:0:-1\n${topic.name}:1:0\n`,
      `${topic.name}:0:\n${topic.name}:1:0\n`,
      `${topic.name}:0:0x1\n${topic.name}:1:0\n`,
      `${topic.name}:0:101\n${topic.name}:1:0\n`,
    ]) {
      const invalid = makeReader({offsets});
      assert.throws(invalid.reader, /offset snapshot/u);
      assert.equal(invalid.commands.length, 1, "invalid snapshots must fail before reading records");
    }

    const incomplete = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:2\n`,
      records: {1: '{"messageId":"one"}\n'},
    });
    assert.throws(incomplete.reader, /expected 2 records in partition 1, received 1/u);

    const failed = makeReader({offsets: `${topic.name}:0:0\n${topic.name}:1:1\n`, failCommand: true});
    assert.throws(failed.reader, (error) => error === commandError);
  });
});
