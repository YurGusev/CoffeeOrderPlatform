import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const COMPOSE_FILE = join(REPO_ROOT, "compose.yaml");

const RUNTIMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "web",
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
  "edge-gateway": [
    "coffee_host_ingress",
    "coffee_public_ingress",
    "coffee_edge_backend",
  ],
  "api-public": ["coffee_edge_backend", "coffee_public_api_backend"],
  "api-internal": ["coffee_internal_api"],
  web: ["coffee_public_ingress"],
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
  "catalog-activation-worker": ["coffee_postgres_data", "coffee_kafka_event"],
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

const SCOPED_SECRET_NAMES = RUNTIMES.map((runtime) => `runtime-${runtime}`);

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

void test("Compose materializes exactly 15 runtime processes and Kafka", () => {
  const config = composeConfig();
  assert.deepEqual(
    Object.keys(config.services).sort((left, right) =>
      left.localeCompare(right),
    ),
    [...RUNTIMES, "kafka"].sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(config.services["api-agent"], undefined);
  assert.equal(config.services["config-bootstrap"], undefined);
  assert.equal(config.services.postgres, undefined);

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
    if (runtime === "edge-gateway") {
      assert.deepEqual(
        service.ports.map(({ target, published, host_ip }) => ({
          target,
          published,
          host_ip,
        })),
        [{ target: 4000, published: "4000", host_ip: "127.0.0.1" }],
        runtime,
      );
    } else {
      assert.equal(service.ports, undefined, runtime);
    }
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
    "coffee_public_ingress",
  ]);
  assert.equal(config.networks.coffee_postgres_data.external, true);
  assert.equal(
    config.networks.coffee_postgres_data.name,
    "coffee_postgres_data",
  );
  assert.equal(config.networks.coffee_postgres_data.internal, undefined);
  assert.notEqual(config.networks.coffee_provider_egress.internal, true);
  assert.equal(config.networks.coffee_host_ingress.name, "coffee_host_ingress");
  assert.notEqual(config.networks.coffee_host_ingress.internal, true);
  assert.equal(config.networks.coffee_public_ingress.internal, true);
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
      "coffee_public_ingress",
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
