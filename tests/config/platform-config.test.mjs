import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import Ajv2020 from "ajv/dist/2020.js";

import { parsePlatformConfig, PlatformConfigError, RUNTIME_NAMES } from "../../packages/platform-config/src/index.ts";
import {readRoutes, render} from "../../tools/nginx/generate.mjs";
import { validateAllPermissionManifests } from "../../scripts/permission-audit.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function configRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-config-"));
  await cp(join(REPO_ROOT, "config"), join(root, "config"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "platform"), join(root, "platform"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "secrets"), join(root, "secrets"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "compose.yaml"), join(root, "compose.yaml"));
  await cp(join(REPO_ROOT, ".sops.yaml"), join(root, ".sops.yaml"));
  await mkdir(join(root, "apps/pricing-service/migrations"), {recursive: true});
  await cp(join(REPO_ROOT, "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql"),
    join(root, "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql"));
  return root;
}

function run(root, env = {}) {
  const cleanEnvironment = { ...process.env };
  for (const key of [
    "COFFEE_REQUIRE_SOPS_MAC",
    "SOPS_AGE_KEY_FILE",
    "SOPS_BIN",
  ])
    delete cleanEnvironment[key];
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/check-platform-config.mjs"), "--root", root],
    {
      encoding: "utf8",
      env: { ...cleanEnvironment, ...env },
    },
  );
}

void test("GREEN: platform parser preserves a null or fully explicit browser OIDC profile", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  assert.equal(document.browserOidc, null);
  assert.equal(parsePlatformConfig(document).browserOidc, null);

  const profile = {
    issuer: "https://issuer.invalid",
    clientId: "test-client-id",
    authorizationUrl: "https://issuer.invalid/authorize",
    tokenUrl: "https://issuer.invalid/token",
    jwksUrl: "https://issuer.invalid/jwks",
    redirectUri: "https://localhost/auth/callback",
    allowedAlgorithms: ["RS256"],
    actorRefClaim: "claim-ref-from-verified-profile",
    permissionsClaim: "permissions-claim-from-verified-profile",
  };
  assert.deepEqual(parsePlatformConfig({...document, browserOidc: profile}).browserOidc, profile);
  assert.throws(
    () => parsePlatformConfig({...document, browserOidc: {...profile, actorRefClaim: undefined}}),
    PlatformConfigError,
  );
  assert.throws(
    () => parsePlatformConfig({...document, browserOidc: {...profile, allowedAlgorithms: ["none"]}}),
    PlatformConfigError,
  );
});

void test("telemetry config is strict, immutable, and rejects missing or inconsistent budgets", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const parsed = parsePlatformConfig(document);
  const alternateCollectorPort = structuredClone(document);
  alternateCollectorPort.telemetry.collector.otlpEndpoint = "http://otel-collector:4319";
  assert.equal(parsePlatformConfig(alternateCollectorPort).telemetry.collector.otlpEndpoint, "http://otel-collector:4319");
  const minimumTelemetryDiskBytes = 256 * 1024 * 1024;
  const minimumDiskConfig = structuredClone(document);
  minimumDiskConfig.telemetry.openObserve.maxDiskBytes = minimumTelemetryDiskBytes;
  assert.equal(parsePlatformConfig(minimumDiskConfig).telemetry.openObserve.maxDiskBytes, minimumTelemetryDiskBytes);
  const undersizedDiskConfig = structuredClone(document);
  undersizedDiskConfig.telemetry.openObserve.maxDiskBytes = minimumTelemetryDiskBytes - 1;
  assert.throws(() => parsePlatformConfig(undersizedDiskConfig), PlatformConfigError);
  const platformSchema = JSON.parse(await readFile(join(REPO_ROOT, "config/platform.schema.json"), "utf8"));
  assert.equal(platformSchema.$defs.telemetry.properties.openObserve.properties.maxDiskBytes.minimum, minimumTelemetryDiskBytes);
  const collectorEndpointPattern = new RegExp(platformSchema.$defs.telemetry.properties.collector.properties.otlpEndpoint.pattern, "u");
  assert.equal(collectorEndpointPattern.test("http://otel-collector:4319"), true);
  assert.equal(collectorEndpointPattern.test("http://otel-collector:65535"), true);
  for (const endpoint of ["http://other-host:4318", "http://OTEL-COLLECTOR:4318", "http://otel-collector", "http://otel-collector:0", "http://otel-collector:80", "http://otel-collector:65536", "http://otel-collector:4318?target=elsewhere", "http://otel-collector:4318?", "http://otel-collector:4318#"])
    assert.equal(collectorEndpointPattern.test(endpoint), false, endpoint);
  const genericOpenObserve = structuredClone(document);
  genericOpenObserve.telemetry.openObserve.endpoint = "http://openobserve.internal:5080";
  assert.equal(parsePlatformConfig(genericOpenObserve).telemetry.openObserve.endpoint, "http://openobserve.internal:5080");
  assert.equal(parsed.telemetry.namespace, "coffee-platform");
  assert.deepEqual([
    parsed.telemetry.collector.memoryLimitMiB,
    parsed.telemetry.collector.memorySpikeMiB,
    parsed.telemetry.collector.containerMemoryMiB,
  ], [256, 64, 1024]);
  assert.equal(parsed.telemetry.openObserve.retentionDays, 3);
  assert.deepEqual([
    parsed.telemetry.openObserve.memTableMaxSizeMiB,
    parsed.telemetry.openObserve.maxFileSizeInMemoryMiB,
    parsed.telemetry.openObserve.maxFileSizeOnDiskMiB,
    parsed.telemetry.openObserve.maxFileRetentionSeconds,
    parsed.telemetry.openObserve.memPersistIntervalSeconds,
  ], [128, 8, 8, 30, 2]);
  assert.deepEqual(
    [parsed.telemetry.openObserve.telemetryEnabled, parsed.telemetry.openObserve.mmdbDownloadEnabled, parsed.telemetry.openObserve.modelPricingEnabled],
    [false, false, false],
  );
  assert.equal(parsed.telemetry.openObserve.deleteFilesDelayMinutes, 1);
  assert.equal(parsed.telemetry.openObserve.jobCleanupWaitSeconds, 60);
  assert.equal(parsed.telemetry.alerts.evaluationIntervalMs, 60_000);
  assert.equal(parsed.telemetry.alerts.sseDropRate.threshold, 0.05);
  assert.ok(Object.isFrozen(parsed.telemetry) && Object.isFrozen(parsed.telemetry.collector));
  for (const changed of [
    {...document, telemetry: undefined},
    {...document, telemetry: Object.fromEntries(Object.entries(document.telemetry).filter(([key]) => key !== "nginxStatusEndpoint"))},
    {...document, telemetry: {...document.telemetry, producer: {...document.telemetry.producer, extra: true}}},
    {...document, telemetry: {...document.telemetry, nginxStatusEndpoint: "http://edge-nginx:65536/nginx_status"}},
    ...["otlpEndpoint", "healthEndpoint", "metricsEndpoint"].flatMap((name) => [
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://other-host:4318"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://OTEL-COLLECTOR:4318"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector:0"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector:65536"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector:4318?target=elsewhere"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector:4318?"}}},
      {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, [name]: "http://otel-collector:4318#"}}},
    ]),
    {...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, queueCapacity: 32, batchSize: 64}}},
    {...document, telemetry: {...document.telemetry, collector: Object.fromEntries(Object.entries(document.telemetry.collector).filter(([key]) => key !== "containerMemoryMiB"))}},
    ...[0, 512.5, 320, Number.MAX_SAFE_INTEGER].map((containerMemoryMiB) => ({...document, telemetry: {...document.telemetry, collector: {...document.telemetry.collector, containerMemoryMiB}}})),
    {...document, telemetry: {...document.telemetry, alerts: {...document.telemetry.alerts, unknownOutcome: {...document.telemetry.alerts.unknownOutcome, threshold: -1}}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, retentionDays: 1}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, diskWatermarkPercent: 100}}},
    {...document, telemetry: {...document.telemetry, openObserve: Object.fromEntries(Object.entries(document.telemetry.openObserve).filter(([key]) => key !== "memPersistIntervalSeconds"))}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, maxFileSizeInMemoryMiB: 128}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, memTableMaxSizeMiB: document.telemetry.openObserve.memoryLimitMiB}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, maxFileSizeOnDiskMiB: 1025}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, memPersistIntervalSeconds: 31}}},
    ...["logs", "traces", "metrics"].map((name) => ({...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, streams: {...document.telemetry.openObserve.streams, [name]: "Bad-Stream"}}}})),
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, bootstrapEmail: "not-an-email"}}},
    {...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, deleteFilesDelayMinutes: 0}}},
    ...["telemetryEnabled", "mmdbDownloadEnabled", "modelPricingEnabled"].map((key) => ({...document, telemetry: {...document.telemetry, openObserve: {...document.telemetry.openObserve, [key]: true}}})),
    {...document, telemetry: {...document.telemetry, alerts: {...document.telemetry.alerts, evaluationIntervalMs: 1000}}},
  ]) assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  assert.throws(() => parsePlatformConfig({...document, environment: "production"}), PlatformConfigError);
  assert.match(parsePlatformConfig({...document, environment: "production", telemetry: {...document.telemetry, releaseDigest: `sha256:${"a".repeat(64)}`}}).telemetry.releaseDigest, /^sha256:/u);
});

void test("RED: config loader rejects enabling OpenObserve external requests", async () => {
  for (const key of ["telemetryEnabled", "mmdbDownloadEnabled", "modelPricingEnabled"]) {
    const root = await configRoot();
    try {
      const path = join(root, "config/platform.yaml");
      const document = parseYaml(await readFile(path, "utf8"), {json: true});
      document.telemetry.openObserve[key] = true;
      await writeFile(path, dumpYaml(document), "utf8");
      const result = run(root);
      assert.notEqual(result.status, 0, key);
      assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SCHEMA|CONFIG-OBSERVABILITY-EGRESS/u, key);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

void test("GREEN: Pricing bootstrap policy matches the immutable migration seed", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const policy = parsePlatformConfig(document).pricingPolicy;
  assert.deepEqual(policy, {
    policyVersionRef: "pvr_00000000000000000000000001",
    version: "1",
    currency: "RUB",
    markupBasisPoints: 3000,
    minimumMarginMinor: "0",
    quoteTtlSeconds: 900,
    quantityScale: 3,
    roundingMode: "CEILING",
  });
  const migration = await readFile(join(REPO_ROOT, "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql"), "utf8");
  assert.match(migration, /VALUES\s*\('pvr_00000000000000000000000001', 1, 'RUB', 3000, 0,\s*900, 3, 'CEILING', 'Active'/u);
  assert.throws(() => parsePlatformConfig({...document, pricingPolicy: {...document.pricingPolicy, minimumMarginMinor: "01"}}), PlatformConfigError);
  assert.throws(() => parsePlatformConfig({...document, pricingPolicy: undefined}), PlatformConfigError);
});

void test("Catalog snapshot proof threshold keeps missing config fail-closed and strictly parses the approved value", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const withoutThreshold = structuredClone(document);
  delete withoutThreshold.services["catalog-service"].catalogSnapshotProof;
  assert.equal(parsePlatformConfig(withoutThreshold).services["catalog-service"].catalogSnapshotProof, undefined);
  assert.deepEqual(parsePlatformConfig(document).services["catalog-service"].catalogSnapshotProof, {maxAgeMs: 7_200_000});
  const configured = structuredClone(document);
  configured.services["catalog-service"].catalogSnapshotProof = {maxAgeMs: 123_456};
  assert.deepEqual(parsePlatformConfig(configured).services["catalog-service"].catalogSnapshotProof, {maxAgeMs: 123_456});
  for (const invalid of [{maxAgeMs: 0}, {maxAgeMs: 1.5}, {maxAgeMs: Number.MAX_SAFE_INTEGER + 1}, {maxAgeMs: 1, extra: true}]) {
    const changed = structuredClone(document);
    changed.services["catalog-service"].catalogSnapshotProof = invalid;
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
  const wrongOwner = structuredClone(document);
  wrongOwner.services["pricing-service"].catalogSnapshotProof = {maxAgeMs: 123_456};
  assert.throws(() => parsePlatformConfig(wrongOwner), PlatformConfigError);
});

void test("AROMA workflow: mutation switch is explicit, convergence-only and independent of capability", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const runtime = document.services["aroma-convergence"];
  assert.equal(runtime.mutationsEnabled, false);
  assert.equal(runtime.mutationCapability, true);
  assert.equal(parsePlatformConfig(document).services["aroma-convergence"].mutationsEnabled, false);
  const enabled = structuredClone(document);
  enabled.services["aroma-convergence"].mutationsEnabled = true;
  assert.equal(parsePlatformConfig(enabled).services["aroma-convergence"].mutationsEnabled, true);
  for (const invalid of [undefined, null, "false", 0]) {
    const changed = structuredClone(document);
    changed.services["aroma-convergence"].mutationsEnabled = invalid;
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
  const observer = structuredClone(document);
  observer.services["aroma-observer"].mutationsEnabled = true;
  assert.throws(() => parsePlatformConfig(observer), PlatformConfigError);
});

void test("AROMA workflow: durable schedule limits are explicit, bounded and role-specific", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const parsed = parsePlatformConfig(document);
  const settings = [
    ["orders-aroma-preparation", "aromaPreparation"],
    ["aroma-observer", "aromaObservation"],
    ["aroma-convergence", "aromaConvergence"],
  ];
  for (const [runtime, property] of settings) {
    assert.ok(document.services[runtime][property]);
    assert.deepEqual(parsed.services[runtime][property], document.services[runtime][property]);
    const invalidSettings = [undefined, {...document.services[runtime][property], pollIntervalMs: 0},
      {...document.services[runtime][property], maxLines: Number.MAX_SAFE_INTEGER},
      {...document.services[runtime][property], unknown: 1}];
    if (property !== "aromaPreparation") invalidSettings.push({...document.services[runtime][property], maxResponseBytes: 2_097_153});
    for (const invalid of invalidSettings) {
      const changed = structuredClone(document);
      changed.services[runtime][property] = invalid;
      assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
    }
  }
  assert.equal(parsed.services["aroma-observer"].aromaObservation.maxResponseBytes, 2_097_152);
  assert.equal(parsed.services["aroma-convergence"].aromaConvergence.maxResponseBytes, 2_097_152);
  assert.equal(parsed.services["aroma-convergence"].aromaConvergence.leaseMs,30_000);
  assert.equal(parsed.services["aroma-convergence"].aromaConvergence.heartbeatIntervalMs,10_000);
  for(const patch of [{leaseMs:45_000},{heartbeatIntervalMs:5_000}]) {
    const changed=structuredClone(document);Object.assign(changed.services["aroma-convergence"].aromaConvergence,patch);
    assert.throws(()=>parsePlatformConfig(changed),PlatformConfigError);
  }
  const staleLease = structuredClone(document);
  staleLease.services["aroma-convergence"].aromaConvergence.leaseMs = 1000;
  assert.throws(() => parsePlatformConfig(staleLease), PlatformConfigError);
  const wrongRole = structuredClone(document);
  wrongRole.services["orders-service"].aromaObservation = document.services["aroma-observer"].aromaObservation;
  assert.throws(() => parsePlatformConfig(wrongRole), PlatformConfigError);
});

void test("Realtime budgets and scoped actor verification are explicit, bounded and role-specific", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const runtime = document.services["realtime-gateway"];
  assert.ok(runtime.realtime);
  assert.deepEqual(parsePlatformConfig(document).services["realtime-gateway"].realtime, runtime.realtime);
  assert.equal(runtime.realtime.maxConnections, 512);
  assert.equal(runtime.realtime.rssBudgetBytes, 536870912);
  const ordinary=structuredClone(document);
  delete ordinary.platform.realtimeFullProfileMemoryBytes;
  assert.equal("realtimeFullProfileMemoryBytes" in parsePlatformConfig(ordinary).platform,false);
  assert.equal("realtimeFullProfileMemoryBytes" in document.platform,false);
  for (const invalid of [undefined, null, 0, 536870912, 1073741824, 1073741825, "1073741824"]) {
    const changed = structuredClone(document);
    changed.platform.realtimeFullProfileMemoryBytes = invalid;
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
  assert.equal(runtime.concurrency, runtime.realtime.maxConnections);
  const overCapacity = structuredClone(document);
  overCapacity.services["realtime-gateway"].concurrency = 513;
  overCapacity.services["realtime-gateway"].realtime.maxConnections = 513;
  assert.throws(() => parsePlatformConfig(overCapacity), PlatformConfigError);
  assert.ok(runtime.secretRefs.includes("security.actorContextEdgeVerificationPublicKeys"));
  assert.equal(runtime.secretRefs.some(ref => /SigningPrivateKey|postgres\./u.test(ref)), false);
  assert.equal(runtime.database, null);
  assert.equal(runtime.replicas, 1);
  for (const invalid of [undefined, {...runtime.realtime, unknown: 1}, {...runtime.realtime, maxConnections: 5001},
    {...runtime.realtime, shutdownGraceMs: 20001}, {...runtime.realtime, shutdownGraceMs: 0},
    {...runtime.realtime, queueMaxBytes: 0}, {...runtime.realtime, ringMaxRecords: 10001},
    {...runtime.realtime, rssBudgetBytes: 536870913}, {...runtime.realtime, fdBudget: 12289},
    {...runtime.realtime, totalQueueMaxBytes: runtime.realtime.queueMaxBytes - 1},
    {...runtime.realtime, totalQueueMaxBytes: runtime.realtime.rssBudgetBytes}]) {
    const changed = structuredClone(document);
    changed.services["realtime-gateway"].realtime = invalid;
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
  for (const change of [
    value => {value.services["orders-service"].realtime = runtime.realtime;},
    value => {value.services["realtime-gateway"].replicas = 2;},
    value => {value.services["realtime-gateway"].concurrency = 5001;},
    value => {value.services["realtime-gateway"].secretRefs = runtime.secretRefs.filter(ref => ref !== "security.actorContextEdgeVerificationPublicKeys");},
    value => {value.services["realtime-gateway"].secretRefs.push("security.actorContextEdgeSigningPrivateKey");},
  ]) {
    const changed = structuredClone(document);
    change(changed);
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
});

void test("NGINX reference admission retains 512 streams and a separate full profile requires worker-slot headroom", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const routes = readRoutes(parseYaml(await readFile(join(REPO_ROOT, "contracts/openapi/client-v1.yaml"), "utf8"), {json: true}));
  const profile = document.nginxTransport;
  const statusEndpoint = document.telemetry.nginxStatusEndpoint;
  assert.equal(profile.limits.sseAdmissionConnections, 512);
  assert.equal(profile.limits.workerProcesses, 1);
  assert.equal(profile.limits.requestPoolBytes, 2048);
  const reference = render(profile, routes, statusEndpoint);
  const schema = JSON.parse(await readFile(join(REPO_ROOT, "config/nginx-profile.schema.json"), "utf8"));
  const validate = new Ajv2020({allErrors: true, strict: true}).compile(schema);
  assert.equal(validate(profile), true);
  assert.match(reference, /^worker_processes 1;$/m);
  assert.match(reference, /request_pool_size 2048;/u);
  assert.match(reference, /listen 8081; server_name edge-nginx; location = \/nginx_status \{ stub_status; access_log off;/u);
  assert.match(reference, /location = \/health\/ready \{ return 404; \}/u);
  assert.match(reference, /location = \/metrics \{ return 404; \}/u);
  assert.throws(() => render(profile, routes, "http://attacker.invalid:8081/nginx_status"), /private nginx status endpoint/u);
  for (const workerProcesses of [undefined, 0, 1.5, 3, "2; include /etc/passwd;"]) {
    const invalidProfile = structuredClone(profile);
    invalidProfile.limits.workerProcesses = workerProcesses;
    assert.throws(() => render(invalidProfile, routes, statusEndpoint), /worker processes/u);
  }
  for (const requestPoolBytes of [undefined, 0, 1024, 2048.5, 4096, "2048; include /etc/passwd;"]) {
    const invalidProfile = structuredClone(profile);
    invalidProfile.limits.requestPoolBytes = requestPoolBytes;
    assert.throws(() => render(invalidProfile, routes, statusEndpoint), /request pool/u);
  }
  assert.match(reference, /worker_connections 2048;/u);
  assert.match(reference, /limit_conn edge_sse_admission 512;/u);
  assert.match(reference, /limit_conn edge_api_admission 384;/u);
  assert.match(reference, /limit_conn edge_auth_admission 320;/u);
  assert.match(reference, /location @realtime_capacity.*REALTIME_CAPACITY_EXCEEDED/u);
  const fullProfile = structuredClone(profile);
  fullProfile.limits.workerProcesses = 2;
  fullProfile.limits.workerConnections = 16384;
  const full = render(fullProfile, routes, statusEndpoint);
  assert.match(full, /^worker_processes 2;$/m);
  for (const sseAdmissionConnections of [513, 5000]) {
    const invalidProfile = structuredClone(profile);
    invalidProfile.limits.sseAdmissionConnections = sseAdmissionConnections;
    assert.equal(validate(invalidProfile), false);
    assert.throws(() => render(invalidProfile, routes, statusEndpoint), /SSE admission/u);
  }
  fullProfile.limits.workerConnections = 1024;
  assert.throws(() => render(fullProfile, routes, statusEndpoint), /worker.*headroom/u);
  assert.equal(document.nginxTransport.limits.sseAdmissionConnections, 512);
});

void test("RED: config:check rejects mismatched Pricing policy and immutable seed", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const source = await readFile(path, "utf8");
    assert.match(source, /markupBasisPoints: 3000/u);
    await writeFile(path, source.replace("markupBasisPoints: 3000", "markupBasisPoints: 3001"));
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-PRICING-POLICY/u);
  } finally { await rm(root, {recursive: true, force: true}); }
});

void test("DB checkout waiting is bounded and reserved for the orders runtime", async () => {
  const document = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const parsed = parsePlatformConfig(document);
  assert.equal(parsed.services["orders-service"].dbPool.maxWaiting, 100);
  assert.equal(parsed.services["customer-service"].dbPool.maxWaiting, 0);
  for (const invalid of [-1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1]) {
    const changed = structuredClone(document);
    changed.services["orders-service"].dbPool.maxWaiting = invalid;
    assert.throws(() => parsePlatformConfig(changed), PlatformConfigError);
  }
  const otherService = structuredClone(document);
  otherService.services["customer-service"].dbPool.maxWaiting = 1;
  assert.throws(() => parsePlatformConfig(otherService), PlatformConfigError);

  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const wrongOrdersLimit = structuredClone(document);
    wrongOrdersLimit.services["orders-service"].dbPool.maxWaiting = 99;
    await writeFile(path, dumpYaml(wrongOrdersLimit), "utf8");
    const ordersResult = run(root);
    assert.notEqual(ordersResult.status, 0);
    assert.match(`${ordersResult.stdout}\n${ordersResult.stderr}`, /CONFIG-RUNTIME-POLICY/u);
  } finally { await rm(root, {recursive: true, force: true}); }
});

void test("RED: non-null browser OIDC requires the exact explicit claims and RS256", async () => {
  const cases = [
    ["missing actor claim source", (profile) => { delete profile.actorRefClaim; }],
    ["missing permissions claim source", (profile) => { delete profile.permissionsClaim; }],
    ["unsupported algorithm", (profile) => { profile.allowedAlgorithms = ["none"]; }],
    ["unrecognized profile field", (profile) => { profile.defaultActor = "invented"; }],
  ];
  for (const [label, mutate] of cases) {
    const root = await configRoot();
    try {
      const path = join(root, "config/platform.yaml");
      const document = parseYaml(await readFile(path, "utf8"), {json: true});
      document.browserOidc = {
        issuer: "https://issuer.invalid",
        clientId: "test-client-id",
        authorizationUrl: "https://issuer.invalid/authorize",
        tokenUrl: "https://issuer.invalid/token",
        jwksUrl: "https://issuer.invalid/jwks",
        redirectUri: "https://localhost/auth/callback",
        allowedAlgorithms: ["RS256"],
        actorRefClaim: "claim-ref-from-verified-profile",
        permissionsClaim: "permissions-claim-from-verified-profile",
      };
      mutate(document.browserOidc);
      await writeFile(path, dumpYaml(document), "utf8");
      const result = run(root);
      assert.notEqual(result.status, 0, label);
      assert.match(`${result.stdout}\\n${result.stderr}`, /CONFIG-SCHEMA/, label);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
});

void test("GREEN: launch inventory is 14 Node runtimes plus native nginx with Edge egress denied", async () => {
  const platform = parseYaml(await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"), {json: true});
  const catalog = JSON.parse(await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"));
  const inventorySchema = JSON.parse(await readFile(join(REPO_ROOT, "secrets/platform-secrets.schema.json"), "utf8"));
  const connectivity = JSON.parse(await readFile(join(REPO_ROOT, "platform/launch-v1-connectivity-policy.json"), "utf8"));
  const edgePermissions = JSON.parse(await readFile(join(REPO_ROOT, "config/permissions/edge-gateway.json"), "utf8"));
  assert.equal(RUNTIME_NAMES.length, 14);
  assert.deepEqual(Object.keys(platform.services).sort(), [...RUNTIME_NAMES].sort());
  assert.deepEqual(catalog.runtimes.map(({name}) => name).sort(), [...RUNTIME_NAMES, "edge-nginx"].sort());
  assert.equal(catalog.runtimes.some(({name}) => name === "web"), false);
  const transportKeys = inventorySchema.$defs.security.properties.serviceTransportKeys;
  assert.equal(transportKeys.required.includes("web"), false);
  assert.equal(transportKeys.required.includes("edge-nginx"), false, "inventory schema must permit an unprovisioned native identity while bootstrap fails closed");
  assert.equal(transportKeys.properties["edge-nginx"].$ref, "#/$defs/encrypted");
  assert.deepEqual(platform.services["edge-gateway"].outbound, []);
  assert.deepEqual(platform.services["edge-gateway"].permissions.net, []);
  assert.deepEqual(edgePermissions.allowNet, []);
  const nodePermissionManifests = await validateAllPermissionManifests(REPO_ROOT);
  assert.equal(nodePermissionManifests.length, 14);
  assert.equal(nodePermissionManifests.some(({runtime}) => runtime === "edge-nginx"), false);
  const edgePolicy = connectivity.runtimePolicies.find(({runtime}) => runtime === "edge-gateway");
  assert.deepEqual(edgePolicy.allowedHostPorts, []);
  assert.deepEqual(edgePolicy.allowedExternalEgress, []);
  const nginxPolicy = connectivity.runtimePolicies.find(({runtime}) => runtime === "edge-nginx");
  assert.deepEqual(nginxPolicy.allowedHostPorts, ["edge-gateway:4000", "api-public:4050", "realtime-gateway:4401"]);
  assert.deepEqual(nginxPolicy.allowedExternalEgress, []);
  assert.equal(platform.services["edge-gateway"].transportMode, "mtls");
  assert.equal(platform.services["edge-gateway"].listen.port, 4000);
  assert.equal(platform.nginxTransport.listen, 8443);
  assert.equal(new URL(platform.platform.publicBaseUrl).origin,
    `https://${platform.nginxTransport.publicHost}:${platform.nginxTransport.listen}`);
  assert.deepEqual(platform.nginxTransport.upstreams, {
    edge: {host: "edge-gateway", port: 4000, serverName: "edge-gateway.development.svc.coffee-platform.internal"},
    apiPublic: {host: "api-public", port: 4050, serverName: "api-public.development.svc.coffee-platform.internal"},
    realtime: {host: "realtime-gateway", port: 4401, serverName: "realtime-gateway.development.svc.coffee-platform.internal"},
  });
});

void test("GREEN: canonical config and encrypted secrets pass the foundation checker", () => {
  const result = run(REPO_ROOT);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /15 runtimes/);
});

void test("GREEN: canonical source identity and Catalog staging authority are synchronized", async () => {
  const profile = JSON.parse(await readFile(join(REPO_ROOT, "platform/launch-v1-runtime-profile.json"), "utf8"));
  assert.deepEqual(profile.catalogIdentity, {
    algorithm: "hmac-sha256-v1",
    secretRef: "aroma.catalogIdentityKeyV1",
    keyInput: "dedicated-secret-ref-no-logging",
    inputEncoding: "UTF-8",
    input: ["hmac-sha256-v1", "0x00", "supplierRef", "0x00", "entityType", "0x00", "NFC(rawProviderIdentifier)"],
    separatorByte: 0,
    entityTypes: ["product", "variant", "offer", "grind"],
    supplierRefPolicy: "canonical-sup-ulid",
    rawProviderIdentifierPolicy: "non-empty-nul-free-nfc-no-trim-no-case-fold",
    outputEncoding: "lowercase-hex",
    variantIdPolicy: "never-generated",
    collisionPolicy: "quarantine-generation",
    rotationPolicy: "versioned-key-new-snapshots-only-existing-identities-remain-stable",
  });
  const gateway = profile.runtimes.find((runtime) => runtime.name === "aroma-gateway");
  assert.ok(gateway.secretRefs.includes("aroma.catalogIdentityKeyV1"));
  assert.equal(profile.runtimes.filter((runtime) => runtime.name !== "aroma-gateway").some((runtime) => runtime.secretRefs.includes("aroma.catalogIdentityKeyV1")), false);

  const roleMap = JSON.parse(await readFile(join(REPO_ROOT, "config/database-role-map.json"), "utf8"));
  const catalog = roleMap.databases.find((database) => database.name === "coffee_platform_catalog");
  for (const runtime of catalog.runtimeRoles.filter(({runtime}) => ["catalog-supplier-sync", "catalog-activation-worker"].includes(runtime))) {
    assert.ok(Object.hasOwn(runtime.tables, "supplier_snapshots"));
    assert.equal(Object.hasOwn(runtime.tables, "snapshot_generations"), false);
  }
  const platform = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
    {json: true},
  );
  assert.deepEqual(platform.aroma.origin, {scheme: "https", host: "aromateacoffee.ru", port: 443});
  assert.equal(platform.aroma.supplierRef, "sup_00000000000000000000000001");
  assert.equal(platform.aroma.scopeRef, "aroma-primary");
  assert.equal(platform.aroma.defaultPacking, "Aroma");
  assert.equal(platform.services["aroma-gateway"].replicas, 1, "safe-read session generation is process-local until durable CAS/epoch exists");
});

void test("GREEN: Kafka access is directional and uses the launch group mapping", async () => {
  const document = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
    {json: true},
  );
  assert.deepEqual(document.services["orders-aroma-preparation"].kafka.producers, [
    "coffee.aroma.cart.commands.v1",
    "coffee.realtime.invalidate.v1",
  ]);
  assert.deepEqual(document.services["orders-aroma-preparation"].kafka.consumers, [
    {groupId: "orders-catalog-mapping-v2", topics: ["coffee.catalog.mapping.v2"], processing: "durable"},
    {groupId: "orders-aroma-preparation-v1", topics: ["coffee.orders.lifecycle.v1"], processing: "durable"},
    {groupId: "orders-aroma-projection-v1", topics: ["coffee.aroma.cart.events.v1"], processing: "durable"},
  ]);
  assert.deepEqual(document.services["realtime-gateway"].kafka.consumers, [
    {groupId: "realtime-gateway-v1", topics: ["coffee.realtime.invalidate.v1"], processing: "realtime"},
  ]);
});

void test("RED: legacy Kafka mode/topics/groups path is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["realtime-gateway"].kafka = {
      mode: "consumer",
      topics: ["coffee.realtime.invalidate.v1"],
      groups: ["realtime-gateway-v1"],
    };
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SCHEMA/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: realtime processing is restricted to realtime-gateway", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["orders-service"].kafka.consumers = [{
      groupId: "realtime-gateway-v1",
      topics: ["coffee.realtime.invalidate.v1"],
      processing: "realtime",
    }];
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-KAFKA-REALTIME|CONFIG-KAFKA-DIRECTION/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: realtime consumer must use the launch group id", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["realtime-gateway"].kafka.consumers[0].groupId = "realtime-gateway-replica";
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-KAFKA-(REALTIME|DIRECTION)/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: unknown platform key fails closed before runtime startup", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.unexpected = true;
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SCHEMA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: plaintext secret leaf is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "secrets/platform.secrets.sops.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      document.replace(/password: ENC\[[^\n]+/, "password: leaked-plaintext"),
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SCHEMA|PLAINTEXT-SECRET)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: foreign database secret cannot be granted to a stateless runtime", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.services["realtime-gateway"].secretRefs.push("postgres.customer");
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SECRET-ALLOWLIST|DB-SECRET)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: foreign database secret cannot be granted to Catalog runtime", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.services["catalog-service"].secretRefs[0] =
      "postgres.ordersService";
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-SECRET-ALLOWLIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: secret-like key in Compose is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "compose.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      `${document}\nservices:\n  leaked-config:\n    environment:\n      PASSWORD: leaked\n`,
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-PLAINTEXT-KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: secret-like key in CI configuration is rejected", async () => {
  const root = await configRoot();
  try {
    const directory = join(root, ".github/workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "leaked.yml"),
      "name: check\njobs:\n  check:\n    password: leaked\n",
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-PLAINTEXT-KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: additional dotenv and secret files are rejected", async () => {
  const root = await configRoot();
  try {
    await writeFile(join(root, ".env.local"), "PLAIN=forbidden\n", "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-FORBIDDEN-FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: additional secret file outside the allowlist is rejected", async () => {
  const root = await configRoot();
  try {
    await writeFile(
      join(root, "runtime-secrets.yaml"),
      "not-a-secret-bundle\n",
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-FORBIDDEN-FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: malformed SOPS MAC is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "secrets/platform.secrets.sops.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      document.replace(/^    mac: .*$/mu, "    mac: invalid-mac"),
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SCHEMA|SOPS-MAC)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: requested SOPS MAC verification fails closed on decrypt/MAC error", async () => {
  const root = await configRoot();
  try {
    const bin = join(root, "test-bin");
    await mkdir(bin, { recursive: true });
    const sops = join(bin, "sops");
    await writeFile(sops, "#!/bin/sh\nexit 42\n", "utf8");
    await chmod(sops, 0o755);
    const keyFile = join(root, "age.key");
    await writeFile(keyFile, "test-only-key-material\n", "utf8");
    const result = run(root, {
      COFFEE_REQUIRE_SOPS_MAC: "1",
      SOPS_AGE_KEY_FILE: keyFile,
      SOPS_BIN: sops,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SOPS-MAC/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
