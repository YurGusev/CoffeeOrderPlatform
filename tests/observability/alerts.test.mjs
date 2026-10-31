import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { createHash } from "node:crypto";
import { load as parseYaml } from "js-yaml";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { awaitConvergenceMetricBarrier } from "./launch-path.mjs";
import {
  createAlertDefinitions,
  createGrafanaAlertProvisioning,
} from "../../tools/observability/alerts.mjs";
import { createAlertSink } from "../../tools/observability/alert-sink.mjs";
import {
  createCollectorConfig,
  OBSERVABILITY_TARGETS,
  prometheusMetricName,
} from "../../tools/observability/generate.mjs";
import {
  parseTempoStatusConfigResponse,
  captureContainerDiagnostics,
  observabilityVerificationCoverage,
  parseCollectorMemoryLimiterMetrics,
  isCollectorMemoryRefusal,
  sourceIdentity,
  stopContainerGracefully,
  validateCollectorMemorySample,
  queryPrometheusRange,
  queryLokiLogs,
  waitForOwnedMetricFamilySamples,
  waitForSameTraceSpans,
  collectG14BrowserTelemetry,
  validateG14ComponentCleanup,
  waitForConvergenceMetricSamples,
  readSinkEvents,
  durationMilliseconds,
  parseCollectorExpiredRetryDrops,
  observabilityGateComplete,
  readG14Qualification,
  persistVerificationResult,
  collectorMemorySelfTelemetry,
  isExporterMetricForSignal,
  parseLokiWalMetrics,
  parsePrometheusWalFailures,
  alertEpisodeStartMs,
} from "../../tools/observability/verify.mjs";
import {
  nodeImageProbe,
  runtimeMetricFamilies,
  sanitizeRuntimeMatrixFailure,
  sanitizeRuntimeMetricMatches,
  summarizeComposeReceipt,
  verifyRuntimeMetricMatrix,
} from "./runtime-matrix.mjs";
import { resolveConvergenceTargets } from "./convergence-metrics-proof.mjs";
import {
  NODE_RUNTIME_ROLES,
  summarizeRuntimeProbeOutput,
} from "./runtime-matrix-probe.mjs";

const config = {
  environment: "development",
  telemetry: {
    namespace: "coffee-platform",
    releaseDigest: "test-release",
    diskWatermarkPercent: 80,
    alerts: {
      version: 1,
      evaluationIntervalMs: 60000,
      notReady: { forMs: 300000, threshold: 0 },
      consumerLag: { forMs: 300000, threshold: 0 },
      outboxOldestAge: { forMs: 300000, threshold: 0 },
      unknownOutcome: { forMs: 120000, threshold: 0 },
      sseDropRate: { forMs: 300000, threshold: 0.05 },
      diskUsage: { forMs: 0 },
    },
  },
};

const syntheticNodeNotReady = {
  status: "PASS",
  service: "g14-synthetic",
  ruleUid: "g14-v1-service-not-ready-synthetic",
  forMs: 300000,
  threshold: 0,
  nativeProbeAbsent: true,
  cleanupVerified: true,
  productionRuleUnchanged: true,
  activationMs: 1000000,
  recoveryMs: 1301000,
  baseline: { value: 1, timestampUs: 999000000 },
  failed: { value: 0, timestampUs: 1001000000 },
  recovered: { value: 1, timestampUs: 1302000000 },
  firing: {
    episodeId: "1234567890abcdef:1970-01-01T00:21:40.000Z",
    receivedAt: "1970-01-01T00:21:40.500Z",
  },
  resolved: {
    episodeId: "1234567890abcdef:1970-01-01T00:21:40.000Z",
    receivedAt: "1970-01-01T00:21:42.500Z",
  },
};

void test("Tempo effective config is parsed after its native status request header", () => {
  const expected = {
    backend_worker: {
      finish_on_shutdown_timeout: "10s",
      compaction: { block_retention: "72h0m0s" },
    },
  };
  assert.deepEqual(
    parseTempoStatusConfigResponse(
      "GET /status/config\n---\nbackend_worker:\n  finish_on_shutdown_timeout: 10s\n  compaction:\n    block_retention: 72h0m0s\n",
    ),
    expected,
  );
  for (const invalid of [
    "backend_worker: {}",
    "GET /other\n---\n{}",
    "GET /status/config\n---\nnull",
    "GET /status/config\n---\n[]",
    "GET /status/config\n---\n{}\n---\n{}",
  ])
    assert.throws(() => parseTempoStatusConfigResponse(invalid));
});

void test("observability CLI can await its runtime and launch modules without an ESM evaluation cycle", async () => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "coffee-observability-import-"),
  );
  const loader = path.join(dir, "loader.mjs");
  const verify = new URL(
    "../../tools/observability/verify.mjs",
    import.meta.url,
  );
  try {
    await writeFile(
      loader,
      `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url === ${JSON.stringify(verify.href)}) {
    const source = String(result.source);
    const start = source.indexOf('export async function runObservabilityVerification(');
    const end = source.indexOf('\\nif (process.argv[1] === fileURLToPath(import.meta.url))', start);
    if (start < 0 || end < 0) throw new Error('probe cannot locate CLI entry');
    return {...result, source: source.slice(0, start) + "export async function runObservabilityVerification() { await import('../../tests/observability/runtime-matrix.mjs'); await import('../../tests/observability/launch-path.mjs'); await import('../compose-smoke.mjs'); return {status: 'probe-pass'}; }\\n" + source.slice(end)};
  }
  if (process.env.OBSERVABILITY_CYCLE_TEST === '1' && url.endsWith('/tests/observability/runtime-matrix.mjs'))
    return {...result, source: "import {runObservabilityVerification as cycleProbe} from '../../tools/observability/verify.mjs';\\n" + String(result.source)};
  return result;
}
`,
    );
    const execute = (cycle) =>
      spawnSync(
        process.execPath,
        ["--no-warnings", "--loader", loader, fileURLToPath(verify)],
        {
          encoding: "utf8",
          timeout: 20000,
          env: { ...process.env, OBSERVABILITY_CYCLE_TEST: cycle ? "1" : "0" },
        },
      );
    const negative = execute(true);
    assert.equal(
      negative.status,
      13,
      "negative control must reproduce the unsettled top-level await",
    );
    const actual = execute(false);
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), { status: "probe-pass" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("synthetic alert fixture starts neutral and dilutes SSE only after a real low-rate drop", async () => {
  const source = await readFile(
    new URL("./fixture.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("let active = ");
  const end = source.indexOf("\nconst app = await createRuntime(", start);
  const configureStart = source.indexOf("  configure(server) {", end);
  const configureEnd = source.indexOf("\n  },\n});", configureStart);
  assert.ok(
    start >= 0 &&
      end > start &&
      configureStart > end &&
      configureEnd > configureStart,
  );
  const handlers = new Map(),
    readiness = [];
  const server = {
    post: (name, handler) => handlers.set(name, handler),
    get: () => {},
  };
  const request = { log: { info() {} }, runtimeSpan: { setAttribute() {} } };
  const reply = {
    code() {
      return this;
    },
    send(value) {
      return value;
    },
  };
  let now = 1_000_000;
  const fixture = runInNewContext(
    `(() => {${source.slice(start, end)}\nconst app = {${source.slice(configureStart, configureEnd)}\n}}; app.configure(server); return {emit, state: () => ({active, consumerLag, oldestOutboxAgeMs, unknownOutcomes, sseAttempts, sseDrops})};})()`,
    {
      server,
      Date: { now: () => now },
      config: {
        telemetry: {
          alerts: { outboxOldestAge: { threshold: 0 } },
          loki: { retentionDays: 3 },
        },
      },
      logger: { info() {} },
      runId: "fixture",
      redactionCanary: "fixture-canary",
      trace: { getTracer: () => ({ startSpan: () => ({ end() {} }) }) },
      setRuntimeReadiness: (value) => readiness.push(value),
    },
  );
  const state = (active) =>
    handlers.get("/test/state")({ body: { active } }, reply);
  const snapshot = () => JSON.parse(JSON.stringify(fixture.state()));
  fixture.emit(request);
  assert.deepEqual(snapshot(), {
    active: false,
    consumerLag: 0,
    oldestOutboxAgeMs: 0,
    unknownOutcomes: 0,
    sseAttempts: 0,
    sseDrops: 0,
  });
  await state(true);
  now += 99_999;
  fixture.emit(request);
  assert.deepEqual(snapshot(), {
    active: true,
    consumerLag: 1,
    oldestOutboxAgeMs: 1,
    unknownOutcomes: 1,
    sseAttempts: 0,
    sseDrops: 0,
  });
  await state(false);
  fixture.emit(request);
  assert.equal(
    snapshot().sseAttempts,
    0,
    "inactive baseline must not dilute a drop that has not occurred",
  );
  await state(true);
  now += 1;
  fixture.emit(request);
  assert.equal(snapshot().sseAttempts, 2);
  assert.equal(snapshot().sseDrops, 1);
  now += 100_000;
  fixture.emit(request);
  assert.equal(snapshot().sseDrops / snapshot().sseAttempts, 0.5);
  await state(false);
  fixture.emit(request);
  assert.deepEqual(snapshot(), {
    active: false,
    consumerLag: 0,
    oldestOutboxAgeMs: 0,
    unknownOutcomes: 0,
    sseAttempts: 1004,
    sseDrops: 2,
  });
  assert.ok(snapshot().sseDrops / snapshot().sseAttempts < 0.05);
  assert.deepEqual(readiness, [false, true, false, true]);
});

void test("Collector filelog retries transient high-memory refusals within the configured retry window", () => {
  const retry = { initialMs: 1000, maxMs: 5000, windowMs: 15000 };
  const config = createCollectorConfig({
    config: {
      environment: "test",
      platform: { health: { intervalMs: 5000, timeoutMs: 1000 } },
      telemetry: {
        namespace: "coffee-platform",
        releaseDigest: "test-release",
        alerts: { evaluationIntervalMs: 60000 },
        nginxStatusEndpoint: "http://edge-nginx:8081/nginx_status",
        collector: {
          otlpEndpoint: "http://otel-collector:4318",
          healthEndpoint: "http://otel-collector:13133",
          metricsEndpoint: "http://otel-collector:8888",
          memoryLimitMiB: 128,
          memorySpikeMiB: 32,
          memoryCheckIntervalMs: 1000,
          batchSize: 128,
          batchTimeoutMs: 1000,
          queueCapacity: 512,
          queueConsumers: 2,
          exportTimeoutMs: 2000,
          retryInitialMs: retry.initialMs,
          retryMaxMs: retry.maxMs,
          retryWindowMs: retry.windowMs,
          maxLogRecordBytes: 65536,
        },
        grafana: { endpoint: "http://grafana:3000" },
        loki: { endpoint: "http://loki:3100" },
        prometheus: { endpoint: "http://prometheus:9090" },
        tempo: {
          endpoint: "http://tempo:3200",
          otlpEndpoint: "http://tempo:4318",
        },
      },
    },
    logFiles: [
      {
        service: "api-public",
        containerId: "a".repeat(64),
        logPath: `/var/lib/docker/containers/${"a".repeat(64)}/${"a".repeat(64)}-json.log`,
      },
    ],
    exporterToken: "producer-token",
  });

  assert.deepEqual(config.receivers.filelog.retry_on_failure, {
    enabled: true,
    initial_interval: "1000ms",
    max_interval: "5000ms",
    max_elapsed_time: "15000ms",
  });
});

void test("convergence phase acknowledgement follows backend PASS and rejects failed or stale phases", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coffee-metric-barrier-"));
  const barrierId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const phase = "unknown-current";
  const prefix = path.join(dir, `convergence-metric-${barrierId}-${phase}`);
  const checkpoint = {
    schemaVersion: 1,
    barrierId,
    phase,
    expectedMetrics: [],
  };
  const pendingHelper = new Promise(() => {});
  try {
    await writeFile(`${prefix}.checkpoint.json`, JSON.stringify(checkpoint));
    const entered = Promise.withResolvers(),
      backend = Promise.withResolvers();
    const waiting = awaitConvergenceMetricBarrier({
      dir,
      barrierId,
      phase,
      helperCompletion: pendingHelper,
      onConvergenceMetrics: async (value) => {
        assert.deepEqual(value, { barrierId, phase, expectedMetrics: [] });
        entered.resolve();
        return backend.promise;
      },
    });
    await entered.promise;
    await assert.rejects(readFile(`${prefix}.ack.json`), { code: "ENOENT" });
    backend.resolve({ status: "PASS" });
    await waiting;
    assert.deepEqual(JSON.parse(await readFile(`${prefix}.ack.json`, "utf8")), {
      schemaVersion: 1,
      barrierId,
      phase,
      status: "PASS",
    });
    await rm(`${prefix}.ack.json`);
    const failure = new Error("backend unavailable");
    await assert.rejects(
      awaitConvergenceMetricBarrier({
        dir,
        barrierId,
        phase,
        helperCompletion: pendingHelper,
        onConvergenceMetrics: async () => {
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(
      JSON.parse(await readFile(`${prefix}.ack.json`, "utf8")).status,
      "FAIL",
    );
    await writeFile(
      `${prefix}.checkpoint.json`,
      JSON.stringify({ ...checkpoint, phase: "recovered-terminal" }),
    );
    await assert.rejects(
      awaitConvergenceMetricBarrier({
        dir,
        barrierId,
        phase,
        helperCompletion: pendingHelper,
        onConvergenceMetrics: async () =>
          assert.fail("stale phase cannot reach backend callback"),
      }),
    );
    assert.equal(
      JSON.parse(await readFile(`${prefix}.ack.json`, "utf8")).status,
      "FAIL",
    );
    const helperFailure = new Error("helper stopped");
    await assert.rejects(
      awaitConvergenceMetricBarrier({
        dir,
        barrierId,
        phase,
        helperCompletion: Promise.resolve({ ok: false, error: helperFailure }),
        onConvergenceMetrics: async () => assert.fail("helper already stopped"),
      }),
      (error) => error === helperFailure,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("runtime metric matrix derives all runtime owners and sanitizes probe receipts", () => {
  const databaseOwners = new Set([
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
  ]);
  const consumerOwners = new Set([
    "orders-aroma-preparation",
    "aroma-convergence",
    "realtime-gateway",
  ]);
  const config = {
    services: Object.fromEntries(
      NODE_RUNTIME_ROLES.map((role) => [
        role,
        {
          database: databaseOwners.has(role) ? `coffee_platform_${role}` : null,
          kafka: {
            consumers: consumerOwners.has(role)
              ? [
                  {
                    groupId: `${role}-consumer`,
                    processing:
                      role === "realtime-gateway" ? "realtime" : "durable",
                  },
                ]
              : [],
          },
        },
      ]),
    ),
  };
  const families = runtimeMetricFamilies(config);
  assert.deepEqual(
    families.find(({ name }) => name === "runtime_http_requests_total"),
    {
      name: "runtime_http_requests_total",
      owners: [...NODE_RUNTIME_ROLES],
      components: [""],
      attributes: { http_response_status_class: "4xx" },
    },
  );
  assert.deepEqual(
    families.find(({ name }) => name === "db.client.connection.waiting").owners,
    [...databaseOwners],
  );
  assert.deepEqual(
    families.find(({ name }) => name === "messaging.kafka.consumer.lag").owners,
    ["orders-aroma-preparation", "aroma-convergence"],
  );
  assert.deepEqual(
    families.find(
      ({ name }) => name === "messaging.outbox.oldest_unpublished.age",
    ).owners,
    [
      "catalog-activation-worker",
      "orders-service",
      "orders-aroma-preparation",
      "aroma-observer",
      "aroma-convergence",
    ],
  );
  assert.deepEqual(
    families.find(({ name }) => name === "runtime_http_request_duration_ms")
      .components,
    ["_count", "_sum", "_bucket"],
  );
  const httpDuration = families.find(
    ({ name }) => name === "runtime_http_request_duration_ms",
  );
  assert.deepEqual(
    sanitizeRuntimeMetricMatches(httpDuration, [
      {
        stream: "runtime_http_request_duration_ms_milliseconds_count",
        sampleCount: 14,
        services: [...NODE_RUNTIME_ROLES],
      },
      {
        stream: "runtime_http_request_duration_ms_milliseconds_sum",
        sampleCount: 14,
        services: [...NODE_RUNTIME_ROLES],
      },
      {
        stream: "runtime_http_request_duration_ms_milliseconds_bucket",
        sampleCount: 42,
        services: [...NODE_RUNTIME_ROLES],
        labels: { secret: "discard" },
      },
    ]),
    [
      {
        stream: "runtime_http_request_duration_ms_milliseconds_bucket",
        sampleCount: 42,
        services: [...NODE_RUNTIME_ROLES].sort(),
      },
      {
        stream: "runtime_http_request_duration_ms_milliseconds_count",
        sampleCount: 14,
        services: [...NODE_RUNTIME_ROLES].sort(),
      },
      {
        stream: "runtime_http_request_duration_ms_milliseconds_sum",
        sampleCount: 14,
        services: [...NODE_RUNTIME_ROLES].sort(),
      },
    ],
  );
  assert.throws(
    () => sanitizeRuntimeMetricMatches(httpDuration, []),
    /components incomplete/u,
  );
  assert.throws(
    () =>
      sanitizeRuntimeMetricMatches(httpDuration, [
        {
          stream: "runtime_http_request_duration_ms_milliseconds_count",
          sampleCount: 1,
          services: ["other-runtime"],
        },
        {
          stream: "runtime_http_request_duration_ms_milliseconds_sum",
          sampleCount: 1,
          services: [...NODE_RUNTIME_ROLES],
        },
        {
          stream: "runtime_http_request_duration_ms_milliseconds_bucket",
          sampleCount: 1,
          services: [...NODE_RUNTIME_ROLES],
        },
      ]),
    /owner evidence invalid/u,
  );

  const summary = summarizeRuntimeProbeOutput(
    JSON.stringify({
      node: "v26.8.1",
      uid: 1000,
      runtime: "orders-service",
      liveStatus: 200,
      readyStatus: 200,
      metricsStatus: 200,
      unknownStatus: 404,
      familyCount: 1,
      families: {
        runtime_admission_rejected_total: { count: 1, min: 0, max: 0 },
      },
      pass: true,
    }),
    { role: "orders-service", nodeVersion: "26.8.1" },
  );
  assert.deepEqual(summary, {
    role: "orders-service",
    status: "PASS",
    nodeVersion: "v26.8.1",
    uid: 1000,
    http: { live: 200, ready: 200, metrics: 200, unknown: 404 },
    familyCount: 1,
    families: {
      runtime_admission_rejected_total: { count: 1, min: 0, max: 0 },
    },
  });
  assert.throws(
    () =>
      summarizeRuntimeProbeOutput(
        JSON.stringify({ secret: "must never pass through" }),
        {
          role: "orders-service",
          nodeVersion: "26.8.1",
        },
      ),
    /runtime metrics probe assertion failed/u,
  );
});

void test("startup diagnostics bound and redact container state, health output and logs", () => {
  const secret = "private-credential-canary";
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "inspect")
      return {
        status: 0,
        stdout: JSON.stringify({
          Running: true,
          ExitCode: 0,
          OOMKilled: false,
          Error: `failed ${secret} Authorization: Bearer state-unknown body password=body-private url=https://example.invalid/?token=url-private`,
          Health: {
            Status: "unhealthy",
            Log: Array.from({ length: 4 }, (_, index) => ({
              ExitCode: index,
              Output: `failed ${secret} Authorization: Bearer health-unknown Bearer opaque-token password=unknown-password ${"x".repeat(1100)}`,
            })),
          },
          Config: { Env: ["SHOULD_NOT_BE_REPORTED"] },
        }),
      };
    return {
      status: 0,
      stdout: `error ${secret} Authorization: Bearer error-unknown Bearer opaque-token header authorization=header-private\n${Array(
        14,
      )
        .fill(
          `INFO starting SQLite migration ${secret} Authorization: Bearer startup-unknown Bearer opaque-token ${"x".repeat(350)}`,
        )
        .join("\n")}\n`,
      stderr: "",
    };
  };
  const diagnostics = captureContainerDiagnostics({
    name: "a".repeat(64),
    stage: "startup",
    secrets: [secret],
    spawnProcess,
  });
  assert.equal(diagnostics.state.Health.status, "unhealthy");
  assert.deepEqual(
    diagnostics.state.Health.log.map((item) => item.exitCode),
    [1, 2, 3],
  );
  assert.ok(
    diagnostics.state.Health.log.every((item) => item.output.length <= 900),
  );
  assert.match(diagnostics.errorOrWarningLines, /error/u);
  assert.match(diagnostics.startupLines, /SQLite migration/u);
  assert.ok(Buffer.byteLength(diagnostics.startupLines) <= 2000);
  for (const value of [
    secret,
    "opaque-token",
    "unknown-password",
    "state-unknown",
    "health-unknown",
    "error-unknown",
    "startup-unknown",
    "body-private",
    "url-private",
    "header-private",
    "SHOULD_NOT_BE_REPORTED",
  ])
    assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(value, "u"));
  assert.equal(calls.length, 2);
  const unavailable = captureContainerDiagnostics({
    name: "b".repeat(64),
    spawnProcess: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  assert.deepEqual(unavailable.state, { unavailable: true });
});

void test("runtime failure diagnostics retain only allowlisted error codes and local frame coordinates", () => {
  const secret = "canary-secret-must-not-escape";
  const cause = new Error(`${secret} in message`);
  cause.name = "AssertionError";
  cause.code = "ERR_ASSERTION";
  cause.actual = secret;
  cause.expected = secret;
  cause.stack = `${secret}\n    at fail (file://${path.resolve("tools/compose-smoke.mjs")}:123:45)\n    at verify (file://${path.resolve("tools/observability/verify.mjs")}:345:67)\n    at test (file://${path.resolve("tests/observability/runtime-matrix.mjs")}:234:56)\n    at other (file:///tmp/${secret}.mjs:1:2)`;
  const diagnostics = sanitizeRuntimeMatrixFailure(cause);
  assert.deepEqual(diagnostics, {
    errorKind: "AssertionError",
    code: "ERR_ASSERTION",
    frames: [
      { source: "tools/compose-smoke.mjs", line: 123, column: 45 },
      { source: "tools/observability/verify.mjs", line: 345, column: 67 },
      {
        source: "tests/observability/runtime-matrix.mjs",
        line: 234,
        column: 56,
      },
    ],
  });
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  const aggregate = new AggregateError([cause], `${secret} aggregate message`, {
    cause,
  });
  assert.deepEqual(sanitizeRuntimeMatrixFailure(aggregate), diagnostics);
  const childFailure = new Error(`${secret} child failure`);
  childFailure.code = "ENOBUFS";
  childFailure.status = 137;
  childFailure.stderr = Buffer.from(
    [
      secret,
      ...Array.from(
        { length: 6 },
        (_, index) => `    at file:///app/[eval1]:${index + 10}:${index + 20}`,
      ),
      `    at leak (file:///tmp/${secret}.mjs:9:8)`,
    ].join("\n"),
  );
  childFailure.stack = `${secret}\n    at run (file://${path.resolve("tools/observability/verify.mjs")}:456:78)`;
  const childDiagnostics = sanitizeRuntimeMatrixFailure(childFailure);
  assert.deepEqual(childDiagnostics, {
    errorKind: "Error",
    code: "ENOBUFS",
    childExitCode: 137,
    frames: [
      { source: "tools/observability/verify.mjs", line: 456, column: 78 },
    ],
    childEvalFrames: [10, 11, 12, 13, 14].map((line, index) => ({
      line,
      column: index + 20,
    })),
  });
  assert.equal(JSON.stringify(childDiagnostics).includes(secret), false);
  const signalFailure = new Error(secret);
  signalFailure.signal = "SIGTERM";
  signalFailure.stack = childFailure.stack;
  const signalDiagnostics = sanitizeRuntimeMatrixFailure(signalFailure);
  assert.equal(signalDiagnostics.childSignal, "SIGTERM");
  assert.equal("childExitCode" in signalDiagnostics, false);
  assert.equal(JSON.stringify(signalDiagnostics).includes(secret), false);
  assert.equal(
    JSON.stringify(sanitizeRuntimeMatrixFailure(aggregate)).includes(secret),
    false,
  );
  const unknown = sanitizeRuntimeMatrixFailure({
    name: secret,
    code: secret,
    stack: `Error: ${secret}\n    at leak (/tmp/${secret}.mjs:9:8)`,
  });
  assert.deepEqual(unknown, { errorKind: "unknown", frames: [] });
  assert.deepEqual(sanitizeRuntimeMatrixFailure(secret), {
    errorKind: "unknown",
    frames: [],
  });
  const quietBaselineCases = [
    { queryValue: 0, phase: "readiness", predicate: "readiness-not-one" },
    {
      queryValue: 1,
      phase: "native-state",
      predicate: "native-state-not-normal",
      nativeAlertId: "0".repeat(27),
      nativeOutcome: "pending",
      nativeOutcomeAtUs: 1234567,
      nativeOutcomeSinceUs: 1234000,
      nativeOutcomeAnchorAtUs: 1230000,
      lastReset: {
        reason: "native-state-not-normal",
        observedAt: 1234,
        nativeOutcome: "pending",
      },
    },
    {
      queryValue: 1,
      phase: "native-state",
      predicate: "awaiting-fresh-native-normal",
      lastReset: {
        reason: "native-normal-not-fresh",
        observedAt: 1234,
        nativeOutcome: "normal",
      },
    },
    {
      queryValue: 1,
      phase: "episodes",
      predicate: "unresolved-episodes",
      eventCount: 2,
      episodeCount: 1,
      unresolvedEpisodeCount: 1,
    },
    {
      queryValue: null,
      phase: "request-error",
      predicate: "readiness-query-failed",
      requestError: { source: "query", httpStatus: 503, errorClass: "Error" },
    },
    {
      queryValue: 1,
      phase: "request-error",
      predicate: "sink-query-failed",
      requestError: { source: "sink", errorClass: "AbortError" },
    },
    {
      queryValue: 1,
      phase: "stability",
      predicate: "continuous-stability",
      stableMs: 1500,
    },
  ];
  for (const sample of quietBaselineCases) {
    const quietBaseline = {
      queryValue: null,
      observedAt: 1234,
      requiredStableMs: 60000,
      stableMs: 0,
      eventCount: 0,
      episodeCount: 0,
      unresolvedEpisodeCount: 0,
      phase: "readiness",
      predicate: "readiness-not-one",
      ...sample,
      arbitraryBody: secret,
      ...(sample.requestError === undefined
        ? {}
        : {
            requestError: {
              ...sample.requestError,
              message: secret,
              headers: { authorization: secret },
            },
          }),
    };
    const cause = new Error(secret);
    const wrappedFailure = Object.assign(new Error(secret), {
      cause,
      nativeNginxAlert: quietBaseline,
    });
    const sanitized = sanitizeRuntimeMatrixFailure(wrappedFailure);
    const expected = {
      queryValue: sample.queryValue,
      observedAt: 1234,
      requiredStableMs: 60000,
      stableMs: sample.stableMs ?? 0,
      eventCount: sample.eventCount ?? 0,
      episodeCount: sample.episodeCount ?? 0,
      unresolvedEpisodeCount: sample.unresolvedEpisodeCount ?? 0,
      phase: sample.phase,
      predicate: sample.predicate,
      ...(sample.requestError === undefined
        ? {}
        : { requestError: sample.requestError }),
      ...(sample.nativeAlertId === undefined
        ? {}
        : {
            nativeAlertId: sample.nativeAlertId,
            nativeOutcome: sample.nativeOutcome,
            nativeOutcomeAtUs: sample.nativeOutcomeAtUs,
            nativeOutcomeSinceUs: sample.nativeOutcomeSinceUs,
            nativeOutcomeAnchorAtUs: sample.nativeOutcomeAnchorAtUs,
            lastReset: sample.lastReset,
          }),
      ...(sample.lastReset?.reason === "native-normal-not-fresh"
        ? { lastReset: sample.lastReset }
        : {}),
    };
    assert.deepEqual(sanitized.nativeNginxAlert, expected);
    assert.equal(JSON.stringify(sanitized).includes(secret), false);
  }
  const retriedSnapshot = {
    queryValue: 1,
    observedAt: 2345,
    requiredStableMs: 60000,
    stableMs: 1500,
    eventCount: 0,
    episodeCount: 0,
    unresolvedEpisodeCount: 0,
    phase: "stability",
    predicate: "continuous-stability",
    queryDurationMs: 37,
    lastReset: {
      reason: "request-error",
      observedAt: 1234,
      phase: "readiness",
      queryDurationMs: 5000,
      requestError: {
        source: "query",
        httpStatus: 503,
        errorClass: "TimeoutError",
        message: secret,
      },
    },
  };
  const retriedFailure = Object.assign(new Error(secret), {
    nativeNginxAlert: retriedSnapshot,
  });
  const retriedDiagnostics = sanitizeRuntimeMatrixFailure(retriedFailure);
  assert.deepEqual(retriedDiagnostics.nativeNginxAlert, {
    queryValue: 1,
    observedAt: 2345,
    requiredStableMs: 60000,
    stableMs: 1500,
    eventCount: 0,
    episodeCount: 0,
    unresolvedEpisodeCount: 0,
    phase: "stability",
    predicate: "continuous-stability",
    queryDurationMs: 37,
    lastReset: {
      reason: "request-error",
      observedAt: 1234,
      phase: "readiness",
      queryDurationMs: 5000,
      requestError: {
        source: "query",
        httpStatus: 503,
        errorClass: "TimeoutError",
      },
    },
  });
  assert.equal(JSON.stringify(retriedDiagnostics).includes(secret), false);
  const recoveryObservation = {
    stage: "recovery",
    outcome: "VALUE_MISMATCH",
    requiredAfterUs: 1_800_000_500_000_000,
    observedAtUs: 1_800_000_560_000_000,
    rowCount: 3,
    matchingRowCount: 2,
    expectedValue: 1,
    totalRowCount: 8,
    isPartial: false,
    latestTargetSample: {
      service: "edge-nginx",
      statusClass: "2xx",
      timestampUs: 1_800_000_550_000_000,
      value: 0,
    },
    arbitraryBody: secret,
  };
  const recoveryFailure = Object.assign(new Error(secret), {
    nativeNginxAlert: {
      queryValue: 1,
      observedAt: 2345,
      requiredStableMs: 60000,
      stableMs: 0,
      eventCount: 0,
      episodeCount: 0,
      unresolvedEpisodeCount: 0,
      phase: "readiness",
      predicate: "readiness-not-one",
    },
    nativeNginxRecovery: recoveryObservation,
  });
  const recoveryDiagnostics = sanitizeRuntimeMatrixFailure(recoveryFailure);
  assert.deepEqual(recoveryDiagnostics.nativeNginxRecovery, {
    stage: "recovery",
    outcome: "VALUE_MISMATCH",
    requiredAfterUs: recoveryObservation.requiredAfterUs,
    observedAtUs: recoveryObservation.observedAtUs,
    rowCount: 3,
    matchingRowCount: 2,
    expectedValue: 1,
    totalRowCount: 8,
    isPartial: false,
    latestTargetSample: recoveryObservation.latestTargetSample,
  });
  assert.equal(
    recoveryDiagnostics.nativeNginxAlert.predicate,
    "readiness-not-one",
    "recovery diagnostics do not replace the native baseline evidence",
  );
  assert.equal(JSON.stringify(recoveryDiagnostics).includes(secret), false);
  const invalidRecoveryFailure = Object.assign(new Error(secret), {
    nativeNginxRecovery: {
      ...recoveryObservation,
      latestTargetSample: {
        ...recoveryObservation.latestTargetSample,
        value: Number.NaN,
      },
    },
  });
  assert.equal(
    "nativeNginxRecovery" in
      sanitizeRuntimeMatrixFailure(invalidRecoveryFailure),
    false,
    "non-finite target values are omitted instead of serialized",
  );
  const pendingFailure = Object.assign(new Error(secret), {
    nativeNginxAlert: {
      queryValue: 1,
      observedAt: 2345,
      requiredStableMs: 65000,
      stableMs: 0,
      eventCount: 0,
      episodeCount: 0,
      unresolvedEpisodeCount: 0,
      phase: "pending-firing",
      predicate: "pending-window-not-proven",
      nativeAlertId: "0".repeat(27),
      nativeOutcome: "firing",
      nativeOutcomeAtUs: 1_800_000_400_000_000,
      nativeOutcomeSinceUs: 1_800_000_350_000_000,
      pendingSinceUs: 1_800_000_001_000_000,
      firingSinceUs: 1_800_000_350_000_000,
      pendingElapsedUs: 349_000_000,
      stopCallStartedAtUs: 1_800_000_000_000_000,
      stopCallEndedAtUs: 1_800_000_100_000_000,
      firstFailedProbeAtUs: 1_800_000_110_000_000,
      firingOutcomeAtUs: secret,
      baselineNormalSinceUs: Number.NaN,
      arbitraryBody: secret,
    },
  });
  const pendingDiagnostics = sanitizeRuntimeMatrixFailure(pendingFailure);
  assert.deepEqual(pendingDiagnostics.nativeNginxAlert, {
    queryValue: 1,
    observedAt: 2345,
    requiredStableMs: 65000,
    stableMs: 0,
    eventCount: 0,
    episodeCount: 0,
    unresolvedEpisodeCount: 0,
    phase: "pending-firing",
    predicate: "pending-window-not-proven",
    nativeAlertId: "0".repeat(27),
    nativeOutcome: "firing",
    nativeOutcomeAtUs: 1_800_000_400_000_000,
    nativeOutcomeSinceUs: 1_800_000_350_000_000,
    pendingSinceUs: 1_800_000_001_000_000,
    firingSinceUs: 1_800_000_350_000_000,
    pendingElapsedUs: 349_000_000,
    stopCallStartedAtUs: 1_800_000_000_000_000,
    stopCallEndedAtUs: 1_800_000_100_000_000,
    firstFailedProbeAtUs: 1_800_000_110_000_000,
  });
  assert.equal(JSON.stringify(pendingDiagnostics).includes(secret), false);
  const invalidDuration = structuredClone(retriedSnapshot);
  invalidDuration.queryDurationMs = "37";
  invalidDuration.lastReset.queryDurationMs = Number.NaN;
  const invalidDurationDiagnostics = sanitizeRuntimeMatrixFailure(
    Object.assign(new Error(secret), { nativeNginxAlert: invalidDuration }),
  );
  assert.equal(
    "queryDurationMs" in invalidDurationDiagnostics.nativeNginxAlert,
    false,
  );
  assert.equal(
    "lastReset" in invalidDurationDiagnostics.nativeNginxAlert,
    false,
  );
  assert.equal(
    JSON.stringify(invalidDurationDiagnostics).includes(secret),
    false,
  );
  const safeObservation = {
    name: "runtime_http_request_duration_ms",
    owners: ["orders-service", "api-public"],
    components: [
      {
        component: "_count",
        streamPresent: true,
        presentOwners: ["orders-service", "api-public"],
        missingOwners: [],
        sampleCount: 2,
      },
      {
        component: "_sum",
        streamPresent: true,
        presentOwners: ["orders-service", "api-public"],
        missingOwners: [],
        sampleCount: 2,
      },
      {
        component: "_bucket",
        streamPresent: true,
        presentOwners: [],
        missingOwners: ["orders-service", "api-public"],
        sampleCount: 0,
        queryFailure: { outcome: "QUERY_FAILED" },
      },
    ],
  };
  assert.deepEqual(
    sanitizeRuntimeMatrixFailure(
      Object.assign(new Error(secret), {
        metricFamilyObservation: safeObservation,
      }),
    ).metricFamilyObservation,
    safeObservation,
  );
  const malformedMetadata = structuredClone(safeObservation);
  malformedMetadata.components[2].queryFailure.httpStatus = "503";
  malformedMetadata.components[2].queryFailure.errorClass = secret;
  const safeMalformedMetadata = sanitizeRuntimeMatrixFailure(
    Object.assign(new Error(secret), {
      metricFamilyObservation: malformedMetadata,
    }),
  );
  assert.deepEqual(
    safeMalformedMetadata.metricFamilyObservation.components[2].queryFailure,
    { outcome: "QUERY_FAILED" },
  );
  assert.equal(JSON.stringify(safeMalformedMetadata).includes(secret), false);
  for (const httpStatus of [99, 600, 503.5, "503"]) {
    const invalidStatus = structuredClone(safeObservation);
    invalidStatus.components[2].queryFailure.httpStatus = httpStatus;
    const sanitized = sanitizeRuntimeMatrixFailure(
      Object.assign(new Error(secret), {
        metricFamilyObservation: invalidStatus,
      }),
    );
    assert.deepEqual(
      sanitized.metricFamilyObservation.components[2].queryFailure,
      { outcome: "QUERY_FAILED" },
    );
  }
  const validMetadata = structuredClone(safeObservation);
  validMetadata.components[2].queryFailure.httpStatus = 503;
  validMetadata.components[2].queryFailure.errorClass = "AbortError";
  assert.deepEqual(
    sanitizeRuntimeMatrixFailure(
      Object.assign(new Error(secret), {
        metricFamilyObservation: validMetadata,
      }),
    ).metricFamilyObservation.components[2].queryFailure,
    { outcome: "QUERY_FAILED", httpStatus: 503, errorClass: "AbortError" },
  );
  const invalidObservations = [
    (observation) => {
      observation.name = secret;
    },
    (observation) => {
      observation.owners[1] = secret;
    },
    (observation) => {
      observation.components[0].component = secret;
    },
    (observation) => {
      observation.components[2].queryFailure.outcome = secret;
    },
    (observation) => {
      observation.components[2].queryFailure.extra = secret;
    },
    (observation) => {
      observation.components[0].sampleCount = 1.5;
    },
  ];
  for (const mutate of invalidObservations) {
    const invalidFailure = new Error(secret);
    invalidFailure.metricFamilyObservation = structuredClone(safeObservation);
    mutate(invalidFailure.metricFamilyObservation);
    const serialized = JSON.stringify(
      sanitizeRuntimeMatrixFailure(invalidFailure),
    );
    assert.equal(serialized.includes("metricFamilyObservation"), false);
    assert.equal(serialized.includes(secret), false);
  }
});

void test("infrastructure stop gate rejects a Docker stop that needed SIGKILL", () => {
  const stopStates = [
    { Running: false, ExitCode: 0, OOMKilled: false },
    { Running: false, ExitCode: 137, OOMKilled: false },
  ];
  const commands = [];
  const run = (args) => {
    commands.push(args);
    if (args[0] === "inspect" && args[2] === "{{.Id}}") return "a".repeat(64);
    if (args[0] === "inspect" && args[2] === "{{json .State}}")
      return JSON.stringify(stopStates.shift());
    return "container";
  };
  const clean = stopContainerGracefully({
    run,
    name: "collector-fixture",
    graceMs: 30000,
  });
  const forced = stopContainerGracefully({
    run,
    name: "grafana-fixture",
    graceMs: 30000,
  });
  assert.equal(clean.status, "PASS");
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.oomKilled, false);
  assert.equal(clean.forcedKill, false);
  assert.equal(forced.status, "FAIL");
  assert.equal(forced.exitCode, 137);
  assert.equal(forced.forcedKill, true);
  assert.ok(forced.elapsedMs <= forced.graceBudgetMs);
  assert.deepEqual(
    commands.filter((args) => args[0] === "stop"),
    [
      ["stop", "--time", "30", "collector-fixture"],
      ["stop", "--time", "30", "grafana-fixture"],
    ],
  );
});

void test("Collector memory proof accepts only native limiter counters and bounded fresh cgroup samples", () => {
  assert.equal(
    isCollectorMemoryRefusal({ httpStatus: 503, otlpCode: 14, refusal: true }),
    true,
  );
  for (const response of [
    { httpStatus: 503, otlpCode: 14, refusal: false },
    { httpStatus: 503, otlpCode: 13, refusal: true },
    { httpStatus: 500, otlpCode: 14, refusal: true },
    { httpStatus: 200, otlpCode: 14, refusal: true },
    { httpStatus: 503, otlpCode: "14", refusal: true },
    undefined,
  ])
    assert.equal(isCollectorMemoryRefusal(response), false);
  assert.deepEqual(
    parseCollectorMemoryLimiterMetrics(
      [
        "# HELP otelcol_processor_memory_limiter_refused_spans Refused spans.",
        'otelcol_processor_memory_limiter_refused_spans{processor="memory_limiter"} 2',
        'otelcol_processor_memory_limiter_refused_spans_total{processor="memory_limiter"} 3',
        'otelcol_processor_memory_limiter_accepted_spans{processor="memory_limiter",otel_scope_name="otelcol"} 17',
        'otelcol_processor_memory_limiter_refused_spans{processor="other"} 99',
        'otelcol_processor_memory_limiter_refused_spans_extra{processor="memory_limiter"} 99',
      ].join("\n"),
    ),
    { refused: 3, accepted: 17 },
  );
  assert.throws(
    () =>
      parseCollectorMemoryLimiterMetrics(
        'otelcol_processor_memory_limiter_refused_spans{processor="memory_limiter"} NaN',
      ),
    /counter was invalid/u,
  );
  const memoryOptions = {
    nowMs: 1000,
    receivedAtMs: 900,
    previousSequence: 1,
    containerMemoryMiB: 512,
    guardBytes: 448 * 1024 * 1024,
  };
  const fresh = {
    sequence: 2,
    currentBytes: 128 * 1024 * 1024,
    maxBytes: 512 * 1024 * 1024,
    kernelPeakBytes: 192 * 1024 * 1024,
    anonBytes: 96 * 1024 * 1024,
    fileBytes: 24 * 1024 * 1024,
    kernelBytes: 8 * 1024 * 1024,
    oom: 0,
    oomKill: 0,
    sampledAtMs: 1700000000000,
  };
  assert.equal(validateCollectorMemorySample(fresh, memoryOptions), fresh);
  for (const options of [
    { ...memoryOptions, nowMs: 1001 },
    { ...memoryOptions, previousSequence: 0 },
  ])
    assert.throws(
      () => validateCollectorMemorySample(fresh, options),
      /invalid or stale/u,
    );
  assert.throws(
    () =>
      validateCollectorMemorySample(
        { ...fresh, maxBytes: 320 * 1024 * 1024 },
        memoryOptions,
      ),
    /invalid or stale/u,
  );
  assert.throws(
    () =>
      validateCollectorMemorySample(fresh, {
        ...memoryOptions,
        containerMemoryMiB: 320,
      }),
    /invalid or stale/u,
  );
  assert.throws(
    () =>
      validateCollectorMemorySample({ ...fresh, fileBytes: -1 }, memoryOptions),
    /invalid or stale/u,
  );
  for (const failing of [
    { ...fresh, kernelPeakBytes: 448 * 1024 * 1024 },
    { ...fresh, oomKill: 1 },
  ]) {
    assert.throws(
      () => validateCollectorMemorySample(failing, memoryOptions),
      (error) => {
        assert.match(error.message, /safety guard/u);
        assert.equal(error.diagnosticCode, "COLLECTOR_MEMORY_SAFETY_GUARD");
        assert.deepEqual(Object.keys(error.failureSample).sort(), [
          "anonBytes",
          "currentBytes",
          "fileBytes",
          "kernelBytes",
          "kernelPeakBytes",
          "maxBytes",
          "oom",
          "oomKill",
          "sampledAtMs",
          "sequence",
        ]);
        assert.equal(
          error.failureSample.kernelPeakBytes,
          failing.kernelPeakBytes,
        );
        return true;
      },
    );
  }
  assert.throws(
    () =>
      validateCollectorMemorySample(
        { ...fresh, privateCanary: "sensitive-memory-record" },
        memoryOptions,
      ),
    (error) => {
      assert.match(error.message, /invalid or stale/u);
      assert.deepEqual(error.failureSample, fresh);
      assert.equal(
        JSON.stringify(error.failureSample).includes("sensitive-memory-record"),
        false,
      );
      return true;
    },
  );
  assert.throws(
    () =>
      validateCollectorMemorySample(
        { ...fresh, currentBytes: 448 * 1024 * 1024 },
        memoryOptions,
      ),
    /safety guard/u,
  );
});

void test("Collector memory pressure resumes owned Tempo before counter confirmation and on failure", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function runCollectorMemoryProof(");
  const end = source.indexOf("\nfunction metricTimestampUs(", start);
  assert.ok(start >= 0 && end > start);
  const scenario = async (failure) => {
    let now = 1_000_000,
      paused = false,
      accepted = 1,
      refused = 0,
      unpauseAttempts = 0;
    const events = [],
      progress = {},
      cleanupErrors = [],
      tempoId = "a".repeat(64);
    class Clock extends Date {
      static now() {
        return now;
      }
    }
    const run = (args) => {
      if (args[0] === "inspect")
        return JSON.stringify({
          "com.docker.compose.project": "coffee-observability-run",
          "com.docker.compose.service":
            failure === "ownership" ? "loki" : "tempo",
        });
      if (args[0] === "pause") {
        events.push("pause");
        paused = true;
        if (failure === "pause") throw new Error("pause failed");
      }
      if (args[0] === "unpause") {
        events.push("unpause");
        if (
          failure === "combined" ||
          (failure === "unpause" && ++unpauseAttempts === 1)
        )
          throw new Error("unpause failed");
        paused = false;
      }
    };
    const proof = runInNewContext(`(${source.slice(start, end)})`, {
      Date: Clock,
      sleep: async (ms) => {
        now += ms;
      },
      MEMORY_MIB_BYTES: 1024 * 1024,
      MEMORY_SAMPLER_STALE_MS: 100,
      MEMORY_LIMITER_METRICS: { refused: "refused", accepted: "accepted" },
      safeCollectorMemorySample: (value) => value,
      isCollectorMemoryRefusal,
      containerGeneration: ({ name }) => ({
        id: name === "collector" ? name : tempoId,
        state: {
          Running: true,
          Paused: name !== "collector" && paused,
          OOMKilled: false,
          StartedAt: "start",
        },
      }),
      collectorMemorySelfTelemetry: async ({ allowUnmaterializedRefused }) => {
        if (!allowUnmaterializedRefused) {
          events.push("confirmation");
          assert.equal(paused, false);
        }
        return { counters: { accepted, refused } };
      },
      sendCollectorMemorySpan: async ({ name, paddingBytes }) => {
        if (name.endsWith("pressure")) {
          events.push("pressure");
          assert.equal(paused, true);
          assert.equal(paddingBytes, 200 * 1024);
          if (failure === "request" || failure === "combined")
            throw new Error("pressure failed");
          if (failure === "exhausted") {
            now += 60000;
            return { httpStatus: 200, wireBytes: 2048 };
          }
          if (failure === "invalid")
            return {
              httpStatus: 503,
              otlpCode: 13,
              refusal: true,
              wireBytes: 2048,
            };
          refused = 1;
          return {
            httpStatus: 503,
            otlpCode: 14,
            refusal: true,
            wireBytes: 2048,
          };
        }
        accepted++;
        return { httpStatus: 200, wireBytes: 1024 };
      },
    });
    const options = {
      run,
      collectorName: "collector",
      tempoName: tempoId.slice(0, 12),
      collectorIp: "collector",
      prometheusUrl: "prometheus",
      config: {
        platform: { health: { intervalMs: 5000 } },
        telemetry: {
          collector: {
            memoryLimitMiB: 256,
            memorySpikeMiB: 64,
            memoryCheckIntervalMs: 1000,
            retryWindowMs: 15000,
            containerMemoryMiB: 1024,
          },
        },
      },
      collectorConfig:
        'limit = "256MiB" spike_limit = "64MiB" check_interval = "1000ms"',
      token: "secret",
      runId: "run",
      progress,
      cleanupErrors,
      cleanError: (error) => error.message,
      sampler: {
        peakBytes: 1024,
        waitForFreshSample: async () => ({ currentBytes: 512, maxBytes: 1024 }),
      },
    };
    if (failure) {
      const message = {
        invalid: /unproven memory-refusal/u,
        request: /pressure failed/u,
        pause: /pause failed/u,
        unpause: /unpause failed/u,
        combined: /pressure failed/u,
        exhausted: /not reached/u,
        ownership: /ownership/u,
      }[failure];
      await assert.rejects(proof(options), message);
      assert.equal(paused, failure === "combined");
      assert.deepEqual(
        cleanupErrors,
        failure === "combined" ? ["Tempo memory restore: unpause failed"] : [],
      );
      assert.deepEqual(
        events.filter((event) => event === "pause" || event === "unpause"),
        failure === "ownership"
          ? []
          : failure === "unpause"
            ? ["pause", "unpause", "unpause"]
            : ["pause", "unpause"],
      );
      if (failure === "request") {
        assert.equal(progress.attempted, 1);
        assert.equal(progress.pendingMaxWireBytes, 512 * 1024);
      }
      if (failure === "exhausted") assert.equal(progress.packetCount, 1);
    } else {
      const result = await proof(options);
      assert.equal(result.refusal.refusedSpansDelta, 1);
      assert.equal(result.recovery.acceptedSpansDelta, 1);
      assert.ok(events.indexOf("pause") < events.indexOf("pressure"));
      assert.ok(events.indexOf("pressure") < events.indexOf("unpause"));
      assert.ok(events.indexOf("unpause") < events.indexOf("confirmation"));
      assert.equal(paused, false);
    }
    assert.equal(JSON.stringify(progress).includes("secret"), false);
  };
  for (const failure of [
    undefined,
    "invalid",
    "request",
    "pause",
    "unpause",
    "combined",
    "exhausted",
    "ownership",
  ])
    await scenario(failure);
});

void test("generated Node image probe accepts nameless nested package metadata but keeps package roots strict", () => {
  const runProbe = (files, links = {}) => {
    const directories = new Set(["/app"]);
    for (const file of Object.keys(files)) {
      let parent = path.dirname(file);
      while (parent.startsWith("/app/")) {
        directories.add(parent);
        parent = path.dirname(parent);
      }
    }
    for (const link of Object.keys(links)) {
      let parent = path.dirname(link);
      while (parent.startsWith("/app/")) {
        directories.add(parent);
        parent = path.dirname(parent);
      }
    }
    const linkedPath = (value) => {
      for (const [link, target] of Object.entries(links))
        if (value === link || value.startsWith(`${link}/`))
          return target.error
            ? value
            : `${target.path}${value.slice(link.length)}`;
      return value;
    };
    const fs = {
      realpathSync(value) {
        const linked = linkedPath(value);
        if (!directories.has(linked))
          throw new Error("missing fixture directory");
        return linked;
      },
      readFileSync(value) {
        const linked = linkedPath(value);
        if (!Object.hasOwn(files, linked))
          throw new Error("missing fixture file");
        return files[linked];
      },
      statSync(value) {
        if (links[value]?.error) {
          const error = new Error("fixture stat failed");
          error.code = links[value].error;
          throw error;
        }
        const linked = linkedPath(value);
        return {
          isFile: () => Object.hasOwn(files, linked),
          isDirectory: () => directories.has(linked),
        };
      },
      readdirSync(value) {
        value = linkedPath(value);
        if (!directories.has(value))
          throw new Error("missing fixture directory");
        const children = new Map();
        for (const entry of [
          ...directories,
          ...Object.keys(files),
          ...Object.keys(links),
        ]) {
          if (!entry.startsWith(`${value}/`)) continue;
          const rest = entry.slice(value.length + 1);
          if (!rest.includes("/"))
            children.set(
              rest,
              Object.hasOwn(links, entry)
                ? "symlink"
                : Object.hasOwn(files, entry)
                  ? "file"
                  : "directory",
            );
          else {
            const child = path.join(value, rest.split("/")[0]);
            children.set(
              rest.split("/")[0],
              Object.hasOwn(links, child) ? "symlink" : "directory",
            );
          }
        }
        return [...children].map(([name, kind]) => ({
          name,
          isFile: () => kind === "file",
          isDirectory: () => kind === "directory",
          isSymbolicLink: () => kind === "symlink",
        }));
      },
    };
    let output = "";
    const runtimeProcess = {
      version: process.version,
      getuid: () => 1000,
      stdout: {
        write: (value) => {
          output += value;
        },
      },
      exitCode: 0,
    };
    runInNewContext(
      nodeImageProbe("orders-service", process.versions.node, ["typescript"]),
      {
        process: runtimeProcess,
        require: (name) =>
          name === "node:fs"
            ? fs
            : name === "node:path"
              ? path
              : (() => {
                  throw new Error("unexpected module");
                })(),
      },
    );
    return JSON.parse(output);
  };
  const base = {
    "/app/package.json": JSON.stringify({
      name: "@coffee-platform/orders-service",
      dependencies: {},
    }),
    "/app/dist/main.js": "",
    "/app/node_modules/fastify/package.json": JSON.stringify({
      name: "fastify",
    }),
    "/app/node_modules/.pnpm/@scope+lib@1/node_modules/@scope/lib/package.json":
      JSON.stringify({ name: "@scope/lib" }),
  };
  const valid = runProbe({
    ...base,
    "/app/node_modules/fastify/test/fixtures/package.json": JSON.stringify({
      type: "module",
    }),
  });
  assert.equal(valid.packageScanComplete, true);
  assert.deepEqual(valid.forbiddenPackages, []);
  assert.equal(valid.pass, true);
  for (const packageRoot of [
    "/app/node_modules/fastify/package.json",
    "/app/node_modules/.pnpm/@scope+lib@1/node_modules/@scope/lib/package.json",
  ]) {
    const missingInstalledName = runProbe({ ...base, [packageRoot]: "{}" });
    assert.equal(missingInstalledName.packageScanComplete, false);
    assert.equal(missingInstalledName.pass, false);
  }
  for (const invalidManifest of [
    "{invalid",
    "[]",
    "null",
    "42",
    '{"name":7}',
  ]) {
    const malformedNested = runProbe({
      ...base,
      "/app/node_modules/fastify/test/fixtures/package.json": invalidManifest,
    });
    assert.equal(malformedNested.packageScanComplete, false);
    assert.equal(malformedNested.pass, false);
  }
  const forbiddenNested = runProbe({
    ...base,
    "/app/node_modules/fastify/test/fixtures/package.json": JSON.stringify({
      name: "typescript",
    }),
  });
  assert.equal(forbiddenNested.packageScanComplete, true);
  assert.deepEqual(forbiddenNested.forbiddenPackages, ["typescript"]);
  assert.equal(forbiddenNested.pass, false);
  const danglingWorkspaceAlias =
    "/app/node_modules/.pnpm/node_modules/@coffee-platform/orders-service";
  const missingTarget = runProbe(base, {
    [danglingWorkspaceAlias]: { error: "ENOENT" },
  });
  assert.equal(missingTarget.packageScanComplete, true);
  assert.equal(missingTarget.pass, true);
  const inaccessibleTarget = runProbe(base, {
    [danglingWorkspaceAlias]: { error: "EACCES" },
  });
  assert.equal(inaccessibleTarget.packageScanComplete, false);
  assert.equal(inaccessibleTarget.pass, false);
  const linkedForbidden = runProbe(
    {
      ...base,
      "/app/vendor/compiler/package.json": JSON.stringify({
        name: "typescript",
      }),
    },
    { [danglingWorkspaceAlias]: { path: "/app/vendor/compiler" } },
  );
  assert.equal(linkedForbidden.packageScanComplete, true);
  assert.deepEqual(linkedForbidden.forbiddenPackages, ["typescript"]);
  assert.equal(linkedForbidden.pass, false);
});

void test("runtime metric matrix requires a source identity callback before any Docker work", async () => {
  const args = {
    projectName: "coffee-launch-20261024t120000z-a12bc34",
    exporterToken: "fixture-token",
    onRolesReady: async () => {},
    onCleanup: async () => {},
    verifyMetricFamily: async () => {},
    nodeVersion: "1.2.3",
    nginxVersion: "1.2.3",
  };
  let dockerCalls = 0;
  for (const sourceIdentity of [undefined, {}]) {
    await assert.rejects(
      verifyRuntimeMetricMatrix({
        ...args,
        sourceIdentity,
        runDocker: () => {
          dockerCalls += 1;
          throw new Error("unexpected Docker call");
        },
      }),
      /runtime matrix inputs invalid/u,
    );
  }
  let identityCalls = 0;
  for (const projectName of [
    "coffee-legacy-runtime-aaaaaaaa",
    "coffee-launch-20261024t120000z-a12bc340",
    "coffee-launch-20261024T120000Z-a12bc34",
    "coffee-launch-local-20261024t120000z-a12bc34",
    "coffee-platform",
  ]) {
    await assert.rejects(
      verifyRuntimeMetricMatrix({
        ...args,
        projectName,
        sourceIdentity: async () => {
          identityCalls += 1;
          throw new Error("unexpected source callback");
        },
        runDocker: () => {
          dockerCalls += 1;
          throw new Error("unexpected Docker call");
        },
      }),
      /runtime matrix inputs invalid/u,
    );
  }
  assert.equal(identityCalls, 0);
  await assert.rejects(
    verifyRuntimeMetricMatrix({
      ...args,
      sourceIdentity: async () => {
        identityCalls += 1;
        throw new Error("source callback failure");
      },
      runDocker: () => {
        dockerCalls += 1;
        throw new Error("unexpected Docker call");
      },
    }),
    /runtime matrix source identity unavailable/u,
  );
  assert.equal(identityCalls, 1);
  assert.equal(dockerCalls, 0);
});

void test("external runtime matrix requires exact five database targets and confirmed cleanup", () => {
  const project = "coffee-launch-20261024t120000z-a12bc34";
  const databases = ["customer", "catalog", "pricing", "orders", "integration"]
    .map((owner) => `coffee_verify_20261024t120000z_a12bc34_${owner}`)
    .sort();
  const receipt = {
    proofKind: "observability-external",
    project,
    runtimes: 14,
    nativeIngress: "edge-nginx",
    kafka: true,
    ephemeralKafkaBroker: true,
    credentialSource: "canonical-runtime-plus-local-kafka-fixture",
    telemetry: true,
    dbIntegrationProof: true,
    gracefulShutdown: true,
    healthEndpoints: ["/health/live", "/health/ready", "/metrics"],
    recoveryProof: {
      postgres: { externalPostgres: true, runtimeRoleCount: 10, databases },
    },
    externalCleanup: {
      verified: true,
      databases: { verified: true, removed: databases, retained: [] },
      attachment: {
        baselineAttached: false,
        attempted: true,
        removed: true,
        routePreserved: true,
      },
    },
  };
  assert.equal(
    summarizeComposeReceipt(receipt, project, true).postgres.databaseCount,
    5,
  );
  assert.equal(
    summarizeComposeReceipt(
      {
        ...receipt,
        externalCleanup: {
          ...receipt.externalCleanup,
          attachment: {
            baselineAttached: true,
            attempted: false,
            removed: false,
            routePreserved: true,
          },
        },
      },
      project,
      true,
    ).postgres.databaseCount,
    5,
  );
  for (const invalid of [
    { ...receipt, proofKind: "observability-fixture" },
    {
      ...receipt,
      recoveryProof: {
        postgres: {
          ...receipt.recoveryProof.postgres,
          databases: [...databases.slice(0, 4), "coffeeorderdb"],
        },
      },
    },
    {
      ...receipt,
      externalCleanup: { ...receipt.externalCleanup, verified: false },
    },
    {
      ...receipt,
      externalCleanup: {
        ...receipt.externalCleanup,
        attachment: {
          baselineAttached: false,
          attempted: true,
          removed: false,
          routePreserved: true,
        },
      },
    },
    ...[
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
    ].map((attachment) => ({
      ...receipt,
      externalCleanup: { ...receipt.externalCleanup, attachment },
    })),
  ])
    assert.throws(
      () => summarizeComposeReceipt(invalid, project, true),
      /receipt assertion failed/u,
    );
});

void test("runtime matrix reads isolation policies from the validated platform config shape", async () => {
  const config = parseYaml(
    await readFile(
      new URL("../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  config.verification.databaseIsolation.enabled = true;
  config.verification.kafkaNamespaceIsolation = false;
  let calls = 0;
  await assert.rejects(
    verifyRuntimeMetricMatrix({
      config,
      projectName: "coffee-launch-20261024t120000z-a12bc34",
      exporterToken: "fixture-token",
      nodeVersion: "1.2.3",
      nginxVersion: "1.2.3",
      sourceIdentity: async () => {
        calls += 1;
      },
      onRolesReady: async () => {},
      onCleanup: async () => {},
      verifyMetricFamily: async () => {},
    }),
    /runtime matrix isolation policies must agree/u,
  );
  assert.equal(calls, 0);
});

void test("convergence proof derives run-scoped DB and Kafka names before accessing them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coffee-convergence-target-"));
  try {
    const config = parseYaml(
      await readFile(
        new URL("../../config/platform.yaml", import.meta.url),
        "utf8",
      ),
    );
    config.verification.databaseIsolation.enabled = true;
    config.verification.kafkaNamespaceIsolation = true;
    const configBytes = Buffer.from(JSON.stringify(config));
    const contextPath = path.join(dir, "context.json");
    const runId = "20261024T120000Z-a12bc34";
    await writeFile(
      contextPath,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        candidateSha: `a12bc34${"0".repeat(33)}`,
        baseConfigSha256: createHash("sha256")
          .update(configBytes)
          .digest("hex"),
      }),
      { mode: 0o400 },
    );
    const targets = await resolveConvergenceTargets({
      configBytes,
      contextPath,
      ownershipPath: fileURLToPath(
        new URL("../../config/database-ownership.json", import.meta.url),
      ),
    });
    assert.equal(
      targets.databaseTarget.database,
      "coffee_verify_20261024t120000z_a12bc34_orders",
    );
    assert.equal(
      targets.databaseTarget.allowedDatabase,
      targets.databaseTarget.database,
    );
    assert.equal(
      targets.physicalTargets.groups["aroma-convergence-v1"],
      `${runId}.aroma-convergence-v1`,
    );
    assert.equal(
      targets.physicalTargets.topics["coffee.aroma.cart.commands.v1"],
      `${runId}.coffee.aroma.cart.commands.v1`,
    );
    await assert.rejects(
      resolveConvergenceTargets({ configBytes }),
      /matching launch isolation/u,
    );
    await assert.rejects(
      resolveConvergenceTargets({
        configBytes: Buffer.concat([configBytes, Buffer.from(" ")]),
        contextPath,
        ownershipPath: fileURLToPath(
          new URL("../../config/database-ownership.json", import.meta.url),
        ),
      }),
    );
    config.verification.kafkaNamespaceIsolation = false;
    await assert.rejects(
      resolveConvergenceTargets({
        configBytes: Buffer.from(JSON.stringify(config)),
        contextPath,
      }),
      /matching Kafka isolation/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("verification provenance hashes the non-ignored source tree and compiled runtime packages", async () => {
  const identity = await sourceIdentity(
    new URL("../..", import.meta.url).pathname,
  );
  assert.equal(identity.sourceFiles.status, "PASS");
  assert.ok(identity.sourceFiles.fileCount > 0);
  assert.match(identity.sourceFiles.sha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.configSha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.bomSha256, /^[a-f0-9]{64}$/u);
  assert.match(
    identity.runtimeArtifacts["packages/platform-runtime/dist"].sha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(
    identity.runtimeArtifacts["packages/platform-observability/dist"].sha256,
    /^[a-f0-9]{64}$/u,
  );
  assert.match(identity.identityHash, /^[a-f0-9]{64}$/u);
});

void test("observability evidence distinguishes selected live roles from full 14-runtime G14 coverage", () => {
  const coverage = observabilityVerificationCoverage({
    launchPathProof: {
      roles: [
        { role: "edge-nginx" },
        { role: "edge-gateway" },
        { role: "api-public" },
        { role: "api-internal" },
        { role: "orders-service" },
        { role: "orders-aroma-preparation" },
        { role: "realtime-gateway" },
        { role: "kafka" },
      ],
    },
    metricApplicability: {
      "messaging.kafka.consumer.lag": [],
      aromaConvergenceProof: {
        "unknown-current": { status: "PASS" },
        "recovered-terminal": { status: "PASS" },
      },
    },
  });
  assert.equal(coverage.verificationScope, "operations-component");
  assert.equal(coverage.fullSystemG14.status, "NOT_RUN");
  assert.equal(coverage.fullSystemG14.owner, "#13");
  assert.equal(coverage.fullSystemG14.requiredNodeRuntimeCount, 14);
  assert.deepEqual(coverage.fullSystemG14.launchPathNodeRuntimes, [
    "api-internal",
    "api-public",
    "edge-gateway",
    "orders-aroma-preparation",
    "orders-service",
    "realtime-gateway",
  ]);
  assert.equal(coverage.fullSystemG14.launchPathNativeNginx, true);
  assert.equal(
    coverage.fullSystemG14.convergenceMetricProof.processKind,
    "driver-container SQL-backed proof helper",
  );
  assert.equal(coverage.fullSystemG14.convergenceMetricProof.status, "PASS");
  assert.deepEqual(coverage.fullSystemG14.nodeRuntimesNotClaimedAsLive, [
    "customer-service",
    "catalog-service",
    "catalog-supplier-sync",
    "catalog-activation-worker",
    "pricing-service",
    "aroma-observer",
    "aroma-convergence",
    "aroma-gateway",
  ]);
  const withMatrix = observabilityVerificationCoverage({
    runtimeMetricMatrix: {
      status: "PASS",
      runtimeMetrics: { roles: NODE_RUNTIME_ROLES.map((role) => ({ role })) },
    },
  });
  assert.deepEqual(withMatrix.fullSystemG14.metricMatrixNodeRuntimes, [
    ...NODE_RUNTIME_ROLES,
  ]);
  assert.deepEqual(withMatrix.fullSystemG14.nodeRuntimesNotClaimedAsLive, []);
  assert.equal(
    withMatrix.fullSystemG14.status,
    "NOT_RUN",
    "functional telemetry coverage does not grant full-system launch acceptance",
  );
});

void test("Grafana provisions deployment-scoped rules with configured windows and local recovery delivery", () => {
  const { alerts, contacts } = createGrafanaAlertProvisioning(config, {
    notificationUrl: "http://alert-sink:9091/alerts",
  });
  const rules = alerts.groups[0].rules;
  const definitions = createAlertDefinitions({ config });
  assert.deepEqual(
    rules.map((rule) => rule.for),
    ["300s", "300s", "300s", "120s", "300s", "0s"],
  );
  assert.ok(
    rules.every(
      (rule) =>
        rule.data[0].datasourceUid === "prometheus" &&
        rule.data[0].model.expr.includes(
          'deployment_environment="development",service_namespace="coffee-platform",service_version="test-release"',
        ),
    ),
  );
  assert.match(
    rules[0].data[0].model.expr,
    /count by \(service_name\).+== bool 14/u,
  );
  assert.match(
    rules[0].data[0].model.expr,
    /probe_success\{service_name="otel-collector",probe_owner="edge-nginx"/u,
  );
  assert.match(
    rules[1].data[0].model.expr,
    /messaging_kafka_consumer_lag_messages/u,
  );
  assert.match(
    rules[2].data[0].model.expr,
    /messaging_outbox_oldest_unpublished_age_milliseconds/u,
  );
  assert.equal(rules[4].data[1].model.expression, "$A > 0.05");
  assert.equal(rules[5].data[1].model.expression, "$A >= 80");
  assert.match(
    rules[5].data[0].model.expr,
    /^100 \* \(1 - node_filesystem_free_bytes\{mountpoint=~"\/telemetry-storage\/\(grafana\|loki\|prometheus\|tempo\)",service_name="otel-collector"/u,
  );
  assert.match(
    rules[5].data[0].model.expr,
    /\/ node_filesystem_size_bytes\{mountpoint=~"\/telemetry-storage\/\(grafana\|loki\|prometheus\|tempo\)",service_name="otel-collector"/u,
  );
  assert.equal(
    (
      rules[5].data[0].model.expr.match(
        /deployment_environment="development"/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.doesNotMatch(rules[5].data[0].model.expr, /state=/u);
  assert.equal(rules[5].noDataState, "Alerting");
  assert.equal(
    contacts.contactPoints[0].receivers[0].settings.url,
    "http://alert-sink:9091/alerts",
  );
  assert.equal(
    contacts.contactPoints[0].receivers[0].disableResolveMessage,
    false,
  );
  assert.equal(contacts.policies[0].receiver, "g14-local");
  assert.throws(
    () =>
      createGrafanaAlertProvisioning(
        { ...config, telemetry: { ...config.telemetry, releaseDigest: "" } },
        { notificationUrl: "http://alert-sink:9091/alerts" },
      ),
    /service_version/u,
  );
  const synthetic = createAlertDefinitions({
    config,
    readinessServices: ["g14-synthetic"],
  });
  assert.match(synthetic[0].query, /service_name=~"\^\(g14-synthetic\)\$"/u);
  assert.doesNotMatch(synthetic[0].query, /and on\(\)/u);
  assert.deepEqual(
    synthetic.slice(1).map((rule) => rule.name),
    definitions.slice(1).map((rule) => rule.name),
  );
  for (const readinessServices of [
    [],
    ["g14-synthetic", "g14-synthetic"],
    ["bad|owner"],
  ])
    assert.throws(
      () => createAlertDefinitions({ config, readinessServices }),
      /readinessServices/u,
    );
});

void test("Grafana webhook stores bounded sanitized firing and resolved episodes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coffee-alert-sink-"));
  const outputPath = path.join(dir, "episodes.jsonl");
  const server = createAlertSink({ outputPath, maxBytes: 1024, maxFiles: 3 });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/alerts`;
    const alert = {
      status: "firing",
      fingerprint: "0123456789abcdef",
      startsAt: "2026-10-29T00:00:00Z",
      labels: {
        alertname: "g14-v1-service-not-ready",
        secret: "canary-secret",
      },
      annotations: { payload: "canary-secret" },
    };
    const send = (alerts) =>
      fetch(url, {
        method: "POST",
        body: JSON.stringify({ alerts, secret: "canary-secret" }),
      });
    assert.equal((await send([alert])).status, 200);
    assert.equal((await send([{ ...alert, status: "resolved" }])).status, 200);
    let lines = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      lines.map((value) => value.status),
      ["firing", "resolved"],
    );
    assert.equal(lines[0].episodeId, lines[1].episodeId);
    assert.equal(lines[0].name, "g14-v1-service-not-ready");
    assert.doesNotMatch(JSON.stringify(lines), /canary-secret/u);
    assert.equal(
      (await send([{ ...alert, labels: { alertname: "canary-secret" } }]))
        .status,
      400,
    );
    assert.equal(
      (await send([{ ...alert, fingerprint: "canary-secret" }])).status,
      400,
    );
    assert.equal(
      (await send(Array.from({ length: 33 }, () => alert))).status,
      400,
    );
    for (let index = 0; index < 30; index++)
      assert.equal((await send([alert])).status, 200);
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), [
      "episodes.jsonl",
      "episodes.jsonl.1",
      "episodes.jsonl.2",
    ]);
    for (const file of files) {
      assert.ok((await stat(path.join(dir, file))).size <= 1024);
      assert.doesNotMatch(
        await readFile(path.join(dir, file), "utf8"),
        /canary-secret/u,
      );
    }
    lines = (await readFile(outputPath, "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      lines.every(
        (value) => value.episodeId === "0123456789abcdef:2026-10-29T00:00:00Z",
      ),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

void test("Grafana backend queries require fresh owner samples and exact traces", async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const timestamp = Math.floor(Date.now() / 1000);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.pathname === "/api/v1/query_range") {
      assert.match(
        url.searchParams.get("query"),
        /^(?:timestamp\()?runtime_http_request_duration_ms_milliseconds_/u,
      );
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { service_name: "orders-service" },
                values: [
                  [
                    timestamp,
                    url.searchParams.get("query").startsWith("timestamp(")
                      ? String(timestamp)
                      : "2",
                  ],
                ],
              },
            ],
          },
        }),
      );
    }
    if (url.pathname === "/api/traces/" + "a".repeat(32))
      return new Response(
        JSON.stringify({
          batches: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: "orders-service" },
                  },
                ],
              },
              scopeSpans: [
                { spans: [{ traceId: "a".repeat(32), name: "order" }] },
              ],
            },
          ],
        }),
      );
    if (url.pathname === "/loki/api/v1/query_range")
      return new Response(
        JSON.stringify({
          status: "success",
          data: {
            resultType: "streams",
            result: [
              {
                stream: { service_name: "orders-service" },
                values: [
                  [
                    String(BigInt(timestamp) * 1000000000n),
                    JSON.stringify({ g14_run_id: "a".repeat(32) }),
                    { service_version: "one" },
                  ],
                ],
              },
            ],
          },
        }),
      );
    throw new Error("unexpected query");
  };
  const family = {
    name: "runtime_http_request_duration_ms",
    owners: ["orders-service"],
    components: ["_count", "_sum", "_bucket"],
  };
  const matches = await waitForOwnedMetricFamilySamples({
    baseUrl: "http://prometheus:9090",
    family,
    startTimeUs,
    fetchImpl,
    timeoutMs: 100,
    intervalMs: 1,
  });
  assert.equal(matches.length, 3);
  assert.deepEqual(
    sanitizeRuntimeMetricMatches(family, matches).map(
      (match) => match.services,
    ),
    Array(3).fill(["orders-service"]),
  );
  const trace = await waitForSameTraceSpans({
    baseUrl: "http://tempo:3200",
    traceId: "a".repeat(32),
    expectedSpanNames: { "orders-service": ["order"] },
    fetchImpl,
    timeoutMs: 100,
  });
  assert.deepEqual(trace.spanInventory, { "orders-service": ["order"] });
  const logs = await queryLokiLogs({
    baseUrl: "http://loki:3100",
    runId: "a".repeat(32),
    startTimeUs,
    fetchImpl,
  });
  assert.equal(logs[0].service_version, "one");
  assert.equal(logs[0].g14_run_id, "a".repeat(32));
  assert.equal(calls.length, 8);
  await assert.rejects(
    queryPrometheusRange({
      baseUrl: "http://prometheus:9090",
      expression: "x",
      startTimeUs,
      fetchImpl: async () => new Response(JSON.stringify({ status: "error" })),
    }),
    /invalid range response/u,
  );
  await assert.rejects(
    waitForSameTraceSpans({
      baseUrl: "http://tempo:3200",
      traceId: "a".repeat(32),
      expectedSpanNames: { "orders-service": ["missing"] },
      fetchImpl,
      timeoutMs: 2,
      intervalMs: 1,
    }),
    /did not complete/u,
  );
});

void test("G14 component requires five child database removals before browser", () => {
  const runId = "20261030T120000Z-abcdef0";
  const names = ["customer", "catalog", "pricing", "orders", "integration"]
    .map(
      (owner) =>
        `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  const cleanup = {
    verified: true,
    databases: { verified: true, removed: names, retained: [] },
    attachment: { routePreserved: true },
  };
  const component = { cleanupVerified: true, cleanup };
  assert.equal(validateG14ComponentCleanup(component, runId), cleanup);
  for (const altered of [
    { ...component, cleanupVerified: false },
    { ...component, cleanup: { ...cleanup, verified: false } },
    {
      ...component,
      cleanup: {
        ...cleanup,
        databases: { ...cleanup.databases, removed: names.slice(1) },
      },
    },
    {
      ...component,
      cleanup: {
        ...cleanup,
        databases: { ...cleanup.databases, retained: [names[0]] },
      },
    },
    {
      ...component,
      cleanup: { ...cleanup, attachment: { routePreserved: false } },
    },
  ])
    assert.throws(
      () => validateG14ComponentCleanup(altered, runId),
      /cleanup is unverified/u,
    );
});

void test("G14 queries actual child telemetry before cleanup and fails closed on missing or private data", async () => {
  const { runManagedRollbackChild } =
    await import("../../verification/launch/v1/scenarios/rollback.mjs");
  const traceId = "a".repeat(32);
  const cid = "8f53d687-fd3b-47be-b32b-2081d08bc55a";
  const nativeNginxContainerId = "b".repeat(64);
  const ordersContainerId = "d".repeat(64);
  const ordersLogPath = `/var/lib/docker/containers/${ordersContainerId}/${ordersContainerId}-json.log`;
  const nativeLogPath = `/var/lib/docker/containers/${nativeNginxContainerId}/${nativeNginxContainerId}-json.log`;
  const proof = {
    correlationId: cid,
    traceId,
    ownerTraceparent: `00-${traceId}-${"c".repeat(16)}-01`,
    realtimeTraceparent: `00-${traceId}-${"c".repeat(16)}-01`,
    runId: "20261030T120000Z-abcdef0",
    candidateSha: "abcdef0" + "0".repeat(33),
    configSha256: "c".repeat(64),
  };
  const required = {
    "orders-service": [
      "Outbox.relay",
      "Kafka.produce",
      "HTTP POST",
      "db.transaction",
    ],
    "orders-aroma-preparation": [
      "Kafka.consume",
      "Inbox.consumeOnce",
      "Outbox.relay",
      "Kafka.produce",
    ],
    "realtime-gateway": ["Kafka.consume"],
  };
  const nowMs = Date.now();
  const startTimeUs = (nowMs - 1000) * 1000;
  const events = [];
  const responses =
    ({
      wrongCid = false,
      empty = false,
      wrongTrace = false,
      privateLog = false,
      privateSpan = false,
      privateField,
      privateLocation,
      privateLogField,
      splitTrace = false,
      wrongLink = false,
      detachedRequest = false,
      requestLink = false,
      wrongRequestLink = false,
      wrongAnchor = false,
      missingCompletion = false,
      foreignContainer = false,
      extraRows = [],
      edgeOverrides = {},
    } = {}) =>
    async (url) => {
      if (url.pathname === "/loki/api/v1/query_range") {
        events.push("loki");
        const correlation = wrongCid
          ? "8f53d687-fd3b-47be-b32b-2081d08bc55b"
          : cid;
        return new Response(
          JSON.stringify({
            status: "success",
            data: {
              resultType: "streams",
              result: ["edge-nginx", "orders-service"].map((role) => ({
                stream: { service_name: role },
                values: (role === "edge-nginx" ? ["POST", "GET"] : ["orders"])
                  .map((method, index) => [
                    String(BigInt(nowMs) * 1000000n),
                    JSON.stringify({
                      ...(role === "edge-nginx"
                        ? { correlation_id: correlation }
                        : { correlationId: correlation }),
                      ...(wrongCid ? { unrelated: cid } : {}),
                      ...(privateLog ? { password: "canary-secret" } : {}),
                      ...(privateLogField
                        ? { [privateLogField]: "private-marker" }
                        : {
                            traceId: detachedRequest ? "e".repeat(32) : traceId,
                            spanId: wrongAnchor
                              ? "f".repeat(16)
                              : "c".repeat(16),
                          }),
                      ...(role === "edge-nginx"
                        ? {
                            method,
                            route: "client.orders",
                            request_id: String(index + 1).repeat(32),
                            status: 200,
                            duration_seconds: index === 0 ? 0.12 : 0.3,
                            ...(missingCompletion
                              ? {}
                              : { request_completion: "OK" }),
                            request_bytes: 128,
                            response_bytes: 256,
                            ...edgeOverrides,
                          }
                        : {}),
                    }),
                    ...(role === "edge-nginx"
                      ? [
                          {
                            log_file_path: foreignContainer
                              ? "/foreign/log"
                              : nativeLogPath,
                          },
                        ]
                      : [{ log_file_path: ordersLogPath }]),
                  ])
                  .concat(role === "edge-nginx" ? extraRows : []),
              })),
            },
          }),
        );
      }
      events.push("tempo");
      if (url.pathname === "/api/search")
        return new Response(
          JSON.stringify({
            traces: splitTrace ? [{ traceID: "d".repeat(32) }] : [],
          }),
        );
      const requestedTrace = url.pathname.split("/").at(-1);
      const linked = requestedTrace === "d".repeat(32);
      const requestTrace = requestedTrace === "e".repeat(32);
      const selected = requestTrace
        ? { "orders-service": ["HTTP POST", "db.transaction"] }
        : linked
          ? { "realtime-gateway": ["Kafka.consume"] }
          : Object.fromEntries(
              Object.entries(required).filter(
                ([role]) => !splitTrace || role !== "realtime-gateway",
              ),
            );
      return new Response(
        JSON.stringify({
          resourceSpans: empty
            ? []
            : Object.entries(selected).map(([role, names]) => ({
                resource: {
                  attributes: [
                    { key: "service.name", value: { stringValue: role } },
                  ],
                },
                scopeSpans: [
                  {
                    spans: names.map((name) => ({
                      traceId: wrongTrace ? "b".repeat(32) : requestedTrace,
                      spanId: "c".repeat(16),
                      name,
                      ...(linked
                        ? {
                            links: [
                              {
                                traceId,
                                spanId: (wrongLink ? "f" : "c").repeat(16),
                              },
                            ],
                          }
                        : {}),
                      ...(requestTrace && requestLink
                        ? {
                            links: [
                              {
                                traceId,
                                spanId: (wrongRequestLink ? "f" : "c").repeat(
                                  16,
                                ),
                              },
                            ],
                          }
                        : {}),
                      ...(privateSpan
                        ? {
                            attributes: [
                              {
                                key: "http.request.body",
                                value: { stringValue: "sensitive" },
                              },
                            ],
                          }
                        : {}),
                      ...(privateField && privateLocation === "attributes"
                        ? {
                            attributes: [
                              {
                                key: privateField,
                                value: { stringValue: "private-marker" },
                              },
                            ],
                          }
                        : {}),
                      ...(privateField && privateLocation === "events"
                        ? {
                            events: [
                              {
                                attributes: [
                                  {
                                    key: privateField,
                                    value: { stringValue: "private-marker" },
                                  },
                                ],
                              },
                            ],
                          }
                        : {}),
                      ...(privateLocation === "deep"
                        ? {
                            events: [
                              {
                                attributes: [
                                  {
                                    key: "safe",
                                    value: {
                                      nested: {
                                        nested: {
                                          nested: { email: "private-marker" },
                                        },
                                      },
                                    },
                                  },
                                ],
                              },
                            ],
                          }
                        : {}),
                      ...(privateField && privateLocation === "links"
                        ? {
                            links: [
                              {
                                attributes: [
                                  {
                                    key: privateField,
                                    value: { stringValue: "private-marker" },
                                  },
                                ],
                              },
                            ],
                          }
                        : {}),
                    })),
                  },
                ],
              })),
        }),
      );
    };
  const collect = (fetchImpl) =>
    collectG14BrowserTelemetry({
      proof,
      startTimeUs,
      lokiUrl: "http://loki:3100",
      tempoUrl: "http://tempo:3200",
      nativeNginxContainerId,
      nativeNginxImageId: `sha256:${"e".repeat(64)}`,
      ordersContainerId,
      ordersImageId: `sha256:${"f".repeat(64)}`,
      fetchImpl,
      timeoutMs: 30,
      intervalMs: 1,
      secrets: ["canary-secret"],
    });
  const source = `const request=stage=>new Promise((resolve,reject)=>{process.once('message',m=>m.ok?resolve():reject(Error('nack')));process.send({stage});}); await request('init');await request('roles-ready');await request('browser-proof');await request('cleanup');process.disconnect();`;
  let result;
  await runManagedRollbackChild({
    args: ["--input-type=module", "-e", source],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    onIpc: async ({ stage }) => {
      if (stage === "browser-proof") {
        result = await collect(responses());
        events.push("proof-ack");
      }
      if (stage === "cleanup") events.push("cleanup");
      return null;
    },
  });
  await assert.rejects(
    waitForSameTraceSpans({
      baseUrl: "http://tempo:3200",
      traceId,
      expectedSpanNames: {},
      fetchImpl: responses(),
      timeoutMs: 30,
      intervalMs: 1,
    }),
    /nonempty role spans/u,
  );
  assert.equal(result.status, "OBSERVED");
  const multiTrace = await collect(
    responses({ splitTrace: true, detachedRequest: true, requestLink: true }),
  );
  assert.equal(multiTrace.status, "OBSERVED");
  assert.deepEqual(multiTrace.durableTraceIds, [traceId, "d".repeat(32)]);
  assert.deepEqual(multiTrace.requestTraceIds, ["e".repeat(32)]);
  assert.equal(
    (await collect(responses({ detachedRequest: true }))).status,
    "NOT_PROVEN",
  );
  assert.equal(
    (
      await collect(
        responses({
          detachedRequest: true,
          requestLink: true,
          wrongRequestLink: true,
        }),
      )
    ).status,
    "NOT_PROVEN",
  );
  assert.equal(
    (await collect(responses({ splitTrace: true, wrongLink: true }))).status,
    "NOT_PROVEN",
  );
  assert.equal(
    (await collect(responses({ detachedRequest: true, wrongAnchor: true })))
      .status,
    "NOT_PROVEN",
  );
  assert.ok(
    events.indexOf("loki") < events.indexOf("proof-ack") &&
      events.indexOf("tempo") < events.indexOf("proof-ack") &&
      events.indexOf("proof-ack") < events.indexOf("cleanup"),
  );
  assert.equal(JSON.stringify(result).includes("canary-secret"), false);
  assert.deepEqual(result.logCounts, { "edge-nginx": 2, "orders-service": 1 });
  const { windowStartUtc, windowEndUtc, ...measurement } =
    result.ordinaryApiMeasurement;
  assert.equal(windowStartUtc, new Date(startTimeUs / 1000).toISOString());
  assert.ok(Date.parse(windowEndUtc) >= nowMs);
  assert.deepEqual(measurement, {
    status: "MEASURED",
    scope:
      "observed subset, verified CID, native edge-nginx, client.orders, observation window",
    unit: "seconds",
    percentile: "nearest-rank",
    sampleCount: 2,
    successCount: 2,
    errorCount: 0,
    abortedCount: 0,
    incompleteCount: 0,
    excludedCount: 0,
    duplicateCount: 0,
    statusCounts: { 200: 2 },
    min: 0.12,
    max: 0.3,
    p50: 0.12,
    p95: 0.3,
  });
  events.length = 0;
  await runManagedRollbackChild({
    args: ["--input-type=module", "-e", source],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    onIpc: async ({ stage }) => {
      if (stage === "browser-proof") {
        result = await collect(responses({ wrongCid: true }));
        events.push("proof-ack");
      }
      if (stage === "cleanup") events.push("cleanup");
      return null;
    },
  });
  assert.equal(result.status, "NOT_PROVEN");
  assert.ok(events.indexOf("proof-ack") < events.indexOf("cleanup"));
  for (const change of [
    { wrongCid: true },
    { empty: true },
    { wrongTrace: true },
    { missingCompletion: true },
    { foreignContainer: true },
    { edgeOverrides: { duration_seconds: -1 } },
    { edgeOverrides: { duration_seconds: "bad" } },
    { edgeOverrides: { request_id: "invalid" } },
    { edgeOverrides: { route: null } },
    { edgeOverrides: { method: null } },
    { edgeOverrides: { request_completion: "unknown" } },
    { edgeOverrides: { request_completion: "" } },
  ])
    assert.equal((await collect(responses(change))).status, "NOT_PROVEN");
  const edgeRow = (body) => [
    String(BigInt(nowMs) * 1000000n),
    JSON.stringify({
      correlation_id: cid,
      route: "client.orders",
      method: "GET",
      request_id: "3".repeat(32),
      status: 200,
      duration_seconds: 0.45,
      request_completion: "OK",
      ...body,
    }),
    { log_file_path: nativeLogPath },
  ];
  const measured = await collect(
    responses({
      extraRows: [
        edgeRow({}),
        edgeRow({}),
        edgeRow({
          request_id: "4".repeat(32),
          status: 503,
          duration_seconds: 0.6,
        }),
        edgeRow({
          request_id: "5".repeat(32),
          status: 499,
          request_completion: "",
        }),
        edgeRow({ request_id: "6".repeat(32), route: "events" }),
        edgeRow({ request_id: "7".repeat(32), request_completion: "" }),
      ],
    }),
  );
  assert.equal(measured.ordinaryApiMeasurement.sampleCount, 4);
  assert.equal(measured.ordinaryApiMeasurement.errorCount, 1);
  assert.equal(measured.ordinaryApiMeasurement.abortedCount, 1);
  assert.equal(measured.ordinaryApiMeasurement.incompleteCount, 1);
  assert.equal(measured.ordinaryApiMeasurement.excludedCount, 1);
  assert.equal(measured.ordinaryApiMeasurement.duplicateCount, 1);
  assert.equal(measured.ordinaryApiMeasurement.p50, 0.3);
  assert.equal(measured.ordinaryApiMeasurement.p95, 0.6);
  assert.equal(
    (
      await collect(
        responses({
          extraRows: [edgeRow({}), edgeRow({ duration_seconds: 0.7 })],
        }),
      )
    ).status,
    "NOT_PROVEN",
  );
  assert.equal(
    (
      await collect(
        responses({
          extraRows: [
            edgeRow({ correlation_id: "8f53d687-fd3b-47be-b32b-2081d08bc55b" }),
          ],
        }),
      )
    ).status,
    "NOT_PROVEN",
  );
  for (const change of [{ privateLog: true }, { privateSpan: true }]) {
    const failure = await collect(responses(change));
    assert.equal(failure.reason, "PRIVACY_REJECTED");
    assert.equal(JSON.stringify(failure).includes("canary-secret"), false);
  }
  for (const privateLogField of [
    "email",
    "phone",
    "cookie",
    "session",
    "payload",
    "request_body",
  ]) {
    const failure = await collect(responses({ privateLogField }));
    assert.equal(failure.reason, "PRIVACY_REJECTED");
    assert.equal(JSON.stringify(failure).includes("private-marker"), false);
  }
  for (const privateLocation of ["attributes", "events", "links"])
    for (const privateField of [
      "email",
      "phone",
      "cookie",
      "session",
      "payload",
      "http.request.body",
    ]) {
      const failure = await collect(
        responses({ privateField, privateLocation }),
      );
      assert.equal(failure.reason, "PRIVACY_REJECTED");
      assert.equal(JSON.stringify(failure).includes("private-marker"), false);
    }
  const deeplyNested = await collect(responses({ privateLocation: "deep" }));
  assert.equal(deeplyNested.reason, "PRIVACY_REJECTED");
  assert.equal(JSON.stringify(deeplyNested).includes("private-marker"), false);
});

void test("convergence proof accepts both actual recovery metric values and rejects another owner", async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const expectedMetrics = [
    { name: "coffee_aroma_unknown_outcomes_current", values: [1, 0] },
  ];
  const response = (owner) => async (url) =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { service_name: owner },
              values: url.searchParams.get("query").startsWith("timestamp(")
                ? [
                    [now - 1, String(now - 1)],
                    [now, String(now)],
                  ]
                : [
                    [now - 1, "1"],
                    [now, "0"],
                  ],
            },
          ],
        },
      }),
    );
  const result = await waitForConvergenceMetricSamples({
    baseUrl: "http://prometheus:9090",
    startTimeUs,
    expectedMetrics,
    fetchImpl: response("aroma-convergence"),
    timeoutMs: 100,
  });
  assert.deepEqual(
    result.coffee_aroma_unknown_outcomes_current.observedValues,
    [1, 0],
  );
  await assert.rejects(
    waitForConvergenceMetricSamples({
      baseUrl: "http://prometheus:9090",
      startTimeUs,
      expectedMetrics,
      fetchImpl: response("other"),
      timeoutMs: 2,
      intervalMs: 1,
    }),
    /did not complete/u,
  );
});

void test("Prometheus evaluation time cannot make an old source sample fresh", async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async (url) =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: { service_name: "orders-service" },
              values: [
                [
                  now,
                  url.searchParams.get("query").startsWith("timestamp(")
                    ? String(now - 60)
                    : "1",
                ],
              ],
            },
          ],
        },
      }),
    );
  assert.deepEqual(
    await queryPrometheusRange({
      baseUrl: "http://prometheus:9090",
      expression: "runtime_ready",
      startTimeUs,
      fetchImpl,
    }),
    [],
  );
  await assert.rejects(
    waitForOwnedMetricFamilySamples({
      baseUrl: "http://prometheus:9090",
      startTimeUs,
      fetchImpl,
      family: {
        name: "runtime_ready",
        owners: ["orders-service"],
        components: [""],
      },
      timeoutMs: 2,
      intervalMs: 1,
    }),
    /did not complete/u,
  );
});

void test("alert episode evidence includes bounded rotated files in order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "coffee-alert-evidence-"));
  const file = path.join(dir, "events.jsonl");
  try {
    await writeFile(
      `${file}.1`,
      JSON.stringify({ name: "rule", status: "firing", episodeId: "same" }) +
        "\n",
    );
    await writeFile(
      file,
      JSON.stringify({ name: "rule", status: "resolved", episodeId: "same" }) +
        "\n",
    );
    assert.deepEqual(
      (await readSinkEvents(file)).map(({ status }) => status),
      ["firing", "resolved"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("backend query errors omit response body and preserve bounded abort signal", async () => {
  await assert.rejects(
    queryPrometheusRange({
      baseUrl: "http://prometheus:9090",
      expression: "runtime_ready",
      startTimeUs: (Date.now() - 10000) * 1000,
      fetchImpl: async (_url, options) => {
        assert.ok(options.signal instanceof AbortSignal);
        return new Response("secret canary", { status: 503 });
      },
    }),
    (error) => error.httpStatus === 503 && !error.message.includes("secret"),
  );
});

void test("Alloy blackbox probe attribution uses the actual probe owner", async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async (url) =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: [
            {
              metric: {
                service_name: "otel-collector",
                probe_owner: "edge-nginx",
              },
              values: [
                [
                  now,
                  url.searchParams.get("query").startsWith("timestamp(")
                    ? String(now)
                    : "1",
                ],
              ],
            },
          ],
        },
      }),
    );
  const family = {
    name: "probe_success",
    owners: ["edge-nginx"],
    components: [""],
    ownerLabel: "probe_owner",
    attributes: { service_name: "otel-collector" },
  };
  const result = await waitForOwnedMetricFamilySamples({
    baseUrl: "http://prometheus:9090",
    family,
    startTimeUs,
    fetchImpl,
    timeoutMs: 100,
  });
  assert.deepEqual(result, [
    { stream: "probe_success", sampleCount: 1, services: ["edge-nginx"] },
  ]);
});

void test("retention readback compares compound Go durations and rejects malformed values", () => {
  assert.equal(durationMilliseconds("72h0m0s"), 3 * 86400000);
  assert.equal(durationMilliseconds("3d"), 3 * 86400000);
  assert.equal(durationMilliseconds("1m30s"), 90000);
  assert.ok(Number.isNaN(durationMilliseconds("72h trailing")));
  assert.ok(Number.isNaN(durationMilliseconds("")));
});

void test("polling timeout reports the latest observation and preserves fatal errors", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function waitFor(");
  const end = source.indexOf("\nfunction requireRunning(", start);
  assert.ok(start >= 0 && end > start);
  const run = async (steps) => {
    let now = 0,
      calls = 0;
    const wait = runInNewContext(`(${source.slice(start, end)})`, {
      Date: { now: () => now },
      sleep: async (ms) => {
        now += ms;
      },
      Error,
    });
    return wait(
      async () => {
        const step = steps[calls++];
        if (step instanceof Error) throw step;
        return step;
      },
      { timeoutMs: steps.length, intervalMs: 1, description: "probe" },
    );
  };
  await assert.rejects(
    run([new Error("stale error"), false, false]),
    (error) => error.message === "probe did not complete",
  );
  await assert.rejects(
    run([new Error("stale error"), false, new Error("current error")]),
    (error) => error.message === "probe did not complete: current error",
  );
  const fatal = Object.assign(new Error("fatal error"), { fatal: true });
  await assert.rejects(
    run([new Error("stale error"), fatal, false]),
    (error) => error === fatal,
  );
  assert.equal(await run([new Error("stale error"), false, "ready"]), "ready");
});

void test("native pressure evidence precedes identity and relief guards", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const fsPressure = filesystem();");
  const end = source.indexOf("\n            assertGeneration();", start);
  assert.ok(start >= 0 && end > start);
  const cases = [
    {
      name: "full with native failure",
      dev: 1,
      ino: 2,
      bavail: 0,
      native: true,
    },
    {
      name: "relieved with native failure",
      dev: 1,
      ino: 2,
      bavail: 3,
      native: true,
    },
    {
      name: "full without native failure",
      dev: 1,
      ino: 2,
      bavail: 0,
      native: false,
    },
    {
      name: "relieved without native failure",
      dev: 1,
      ino: 2,
      bavail: 3,
      native: false,
      error: "filesystem pressure ended before a native storage failure",
    },
    {
      name: "changed device with native failure",
      dev: 9,
      ino: 2,
      bavail: 3,
      native: true,
      error: "filesystem identity changed during pressure",
    },
    {
      name: "changed inode with native failure",
      dev: 1,
      ino: 9,
      bavail: 3,
      native: true,
      error: "filesystem identity changed during pressure",
    },
    {
      name: "changed device without native failure",
      dev: 9,
      ino: 2,
      bavail: 0,
      native: false,
      error: "filesystem identity changed during pressure",
    },
    {
      name: "changed inode without native failure",
      dev: 1,
      ino: 9,
      bavail: 0,
      native: false,
      error: "filesystem identity changed during pressure",
    },
  ];
  for (const scenario of cases) {
    const fsPressure = {
      dev: scenario.dev,
      ino: scenario.ino,
      bavail: scenario.bavail,
    };
    const nativeFailure = scenario.native
      ? { httpStatus: 500, sqliteDiskFullLog: true }
      : undefined;
    const pressureEvidence = {};
    const execute = runInNewContext(`(() => {${source.slice(start, end)}\n})`, {
      filesystem: () => fsPressure,
      fsBefore: { dev: 1, ino: 2 },
      pressureEvidence,
      nativeFailure,
      name: "grafana",
      Error,
    });
    if (scenario.error)
      assert.throws(
        execute,
        (error) => error.message === `grafana ${scenario.error}`,
        scenario.name,
      );
    else execute();
    assert.equal(
      pressureEvidence.filesystemPressure,
      fsPressure,
      scenario.name,
    );
    assert.equal(pressureEvidence.nativeFailure, nativeFailure, scenario.name);
    assert.equal(
      Object.hasOwn(pressureEvidence, "nativeFailure"),
      scenario.native,
      scenario.name,
    );
  }
});

void test("Loki retention fixture changes cache TTL on a clone of the original profile", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "const lokiProfile = structuredClone(originalLokiConfig);",
  );
  const end = source.indexOf("\n      const readLokiKnobs =", start);
  assert.ok(start >= 0 && end > start);
  for (const cache of [
    undefined,
    { embedded_cache: { ttl: "24h", enabled: true }, keep: "value" },
  ]) {
    const originalLokiConfig = {
      ingester: { chunk_idle_period: "1h" },
      compactor: { compaction_interval: "10m" },
      ...(cache
        ? {
            chunk_store_config: {
              chunk_cache_config: cache,
              other: "preserved",
            },
          }
        : {}),
    };
    const original = structuredClone(originalLokiConfig);
    const profile = runInNewContext(
      `(() => {${source.slice(start, end)}\nreturn lokiProfile;})()`,
      {
        originalLokiConfig,
        structuredClone,
      },
    );
    assert.deepEqual(originalLokiConfig, original);
    assert.equal(
      profile.chunk_store_config.chunk_cache_config.embedded_cache.ttl,
      "30s",
    );
    assert.equal(
      profile.chunk_store_config.chunk_cache_config.embedded_cache.enabled,
      true,
    );
    if (cache) {
      assert.equal(profile.chunk_store_config.chunk_cache_config.keep, "value");
      assert.equal(profile.chunk_store_config.other, "preserved");
    }
  }
});

void test("Tempo retention fixture accelerates cleanup and verifies the effective cadence", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const originalTempoConfig = configs.tempo;");
  const end = source.indexOf("const originalTempoBytes =", start);
  const readerStart = source.indexOf("const readTempoKnobs = async () =>", end);
  const readerEnd = source.indexOf("const originalTempoKnobs =", readerStart);
  const checkStart = source.indexOf(
    "const activeTempo = await readTempoKnobs();",
    readerEnd,
  );
  const checkEnd = source.indexOf("const otlpUrl =", checkStart);
  assert.ok(
    start >= 0 &&
      end > start &&
      readerStart > end &&
      readerEnd > readerStart &&
      checkEnd > checkStart,
  );
  const original = {
    backend_worker: { compaction: { block_retention: "72h" } },
    backend_scheduler: {},
    live_store: {
      wal: { path: "/var/tempo/live-wal" },
      flush_op_timeout: "5m",
    },
    storage: { trace: {} },
  };
  const configs = { tempo: structuredClone(original) };
  const profile = runInNewContext(
    `(() => {${source.slice(start, end)}return tempoProfile;})()`,
    { configs, structuredClone },
  );
  assert.deepEqual(configs.tempo, original);
  assert.equal(profile.live_store.flush_op_timeout, "30s");
  assert.equal(profile.live_store.wal.path, original.live_store.wal.path);
  const readKnobs = runInNewContext(
    `(() => {${source.slice(readerStart, readerEnd)}return readTempoKnobs;})()`,
    {
      api: async () => profile,
      baseUrls: {},
      parseTempoStatusConfigResponse: (value) => value,
      durationMilliseconds,
    },
  );
  const effective = await readKnobs();
  assert.equal(effective.cleanup, 30000);
  const check = (value) =>
    runInNewContext(`(async () => {${source.slice(checkStart, checkEnd)}})()`, {
      readTempoKnobs: async () => value,
      Error,
    });
  await check(effective);
  await assert.rejects(
    check({ ...effective, cleanup: 300000 }),
    /fixture retention profile was not effective/u,
  );
});

void test("restoration preserves proof failure and reports both failures without a false pass", async () => {
  const source = await readFile(
    new URL("../../tools/observability/verify.mjs", import.meta.url),
    "utf8",
  );
  const restorations = [
    {
      name: "backup",
      variable: "backupRestorationError",
      first: "fixtureCompose.volumes = originalVolumes;",
    },
    {
      name: "Loki retention",
      variable: "lokiRestorationError",
      first: "await writeLokiConfig(originalLokiConfig);",
    },
    {
      name: "Prometheus retention",
      variable: "prometheusRestorationError",
      first: "services.prometheus.command = originalPrometheusCommand;",
    },
    {
      name: "Tempo retention",
      variable: "tempoRestorationError",
      first: "await writeTempoConfig(originalTempoConfig);",
    },
  ];
  for (const { name, variable, first } of restorations) {
    const position = source.indexOf(first);
    const start = source.lastIndexOf("} finally {", position);
    const statement = `if (${variable}) throw ${variable};`;
    const end = source.indexOf(statement, position) + statement.length;
    assert.ok(position >= 0 && start >= 0 && end > position);
    for (const [proofFails, restoreFails] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ]) {
      const cleanupErrors = [];
      const restore = () => {
        if (restoreFails) throw new Error("restore failure");
      };
      const fixtureCompose = {
        set volumes(_value) {
          restore();
        },
      };
      const context = {
        Error,
        cleanupErrors,
        cleanError: (error) => error.message,
        proof: () => {
          if (proofFails) throw new Error("proof failure");
        },
        fixtureCompose,
        originalVolumes: {},
        backendStopStarted: false,
        writeLokiConfig: restore,
        writeTempoConfig: restore,
        originalLokiConfig: {},
        originalTempoConfig: {},
        recreateBackend() {},
        readLokiKnobs: () => ({}),
        readTempoKnobs: () => ({}),
        originalLokiKnobs: {},
        originalTempoKnobs: {},
        originalLokiHash: "same",
        originalTempoHash: "same",
        createHash: () => ({ update: () => ({ digest: () => "same" }) }),
        readFile: async () => "",
        backendConfigPaths: {},
        services: { prometheus: {} },
        originalPrometheusCommand: [],
        saveCompose: restore,
        api: async () => ({ data: {} }),
        baseUrls: {},
        loadYaml: () => ({ services: { prometheus: { command: [] } } }),
        composeFile: "",
        profileFlagNames: [],
        originalFlags: {},
        profileHash: () => "same",
      };
      const execute = runInNewContext(
        `(async () => { let ${variable}; try { await proof(); ${source.slice(start, end)} })`,
        context,
      );
      if (proofFails || restoreFails) {
        await assert.rejects(
          execute(),
          (error) =>
            error.message ===
            (proofFails ? "proof failure" : "restore failure"),
          name,
        );
      } else await execute();
      assert.deepEqual(
        cleanupErrors,
        restoreFails ? [`${name} restore: restore failure`] : [],
        name,
      );
      if (restoreFails)
        assert.equal(observabilityGateComplete({ cleanupErrors }), false, name);
    }
  }
  const cleanupStart = source.indexOf(
    "        let syntheticResetVerified = false;",
  );
  const cleanupEnd = source.indexOf(
    "\n      }\n      if (!syntheticCleanupVerified)",
    cleanupStart,
  );
  const guardStart = source.indexOf(
    "\n    if (!syntheticCleanupVerified)",
    cleanupEnd,
  );
  const guardEnd = source.indexOf("\n    assertGrafanaGeneration(", guardStart);
  assert.ok(
    cleanupStart >= 0 &&
      cleanupEnd > cleanupStart &&
      guardStart > cleanupEnd &&
      guardEnd > guardStart,
  );
  for (const resetFails of [false, true]) {
    const calls = [];
    let nativeCalled = false;
    const productionBefore = {
      uid: "production",
      title: "production",
      for: "5m",
      condition: "B",
      noDataState: "Alerting",
      execErrState: "Alerting",
      data: [{ refId: "A", model: { expr: "production-query" } }],
    };
    const execute = runInNewContext(
      `(async () => { let syntheticCleanupVerified = false; try { ${source.slice(cleanupStart, cleanupEnd)} } catch {} ${source.slice(guardStart, guardEnd)} nativeProof(); })`,
      {
        Error,
        producerUrl: "producer",
        runId: "run",
        baseUrls: { grafana: "grafana" },
        authorization: "auth",
        groupPath: "group",
        syntheticPath: "synthetic",
        productionPath: "production",
        productionBefore,
        productionRule: { query: "production-query" },
        isDeepStrictEqual: (left, right) =>
          JSON.stringify(left) === JSON.stringify(right),
        fixtureRequest: async () => {
          if (resetFails) throw new Error("reset failed");
        },
        api: async (options) => {
          const status =
            options.method === "DELETE"
              ? 204
              : options.path === "production"
                ? 200
                : 404;
          assert.ok((options.expected ?? [200]).includes(status));
          calls.push([options.method ?? "GET", options.path, status]);
          return options.path === "production" ? productionBefore : undefined;
        },
        nativeProof: () => {
          nativeCalled = true;
        },
      },
    );
    if (resetFails)
      await assert.rejects(execute(), /cleanup was not verified/u);
    else await execute();
    assert.deepEqual(calls, [
      ["DELETE", "group", 204],
      ["GET", "group", 404],
      ["GET", "synthetic", 404],
      ["GET", "production", 200],
    ]);
    assert.equal(nativeCalled, !resetFails);
  }
});

void test("G14 cannot pass with a missing or incomplete required phase", () => {
  const pass = { status: "PASS" };
  const evidence = {
    cleanupErrors: [],
    phases: Object.fromEntries(
      [
        "startup",
        "signals",
        "alerts",
        "outage",
        "persistence",
        "backupRestore",
        "runtimeMatrix",
        "memory",
        "retention",
        "launchPath",
        "diskRecovery",
      ].map((name) => [name, "PASS"]),
    ),
    alertTransitions: "PASS",
    syntheticNodeNotReady: structuredClone(syntheticNodeNotReady),
    launchPathCorrelation: "PASS",
    nativeNginxAlert: pass,
    redactionScan: pass,
    networkIsolation: { status: "PASS", launchPathNetworkStatus: "PASS" },
    telemetryHealth: {
      dockerLogRotation: pass,
      producerLoggingPolicy: pass,
      collectorLoggingPolicy: pass,
      launchPathCollectorConfig: "PASS",
      launchPathOutageStatus: "PASS",
      collectorMemoryProof: pass,
    },
    collectorQueueMetrics: pass,
    processCounterRestart: pass,
    diskPressureStatus: "PASS",
    diskPressure: {
      status: "PASS",
      backends: Object.fromEntries(
        ["loki", "grafana", "prometheus", "tempo"].map((name) => [
          name,
          { status: "PASS" },
        ]),
      ),
    },
    runtimeShutdownStatus: "PASS",
  };
  assert.equal(observabilityGateComplete(evidence), true);
  for (const mutate of [
    (value) => {
      delete value.syntheticNodeNotReady;
    },
    (value) => {
      value.syntheticNodeNotReady.forMs = 1;
    },
    (value) => {
      value.syntheticNodeNotReady.firing.episodeId =
        "1234567890abcdef:1970-01-01T00:21:39.000Z";
    },
    (value) => {
      value.syntheticNodeNotReady.resolved.episodeId = "foreign";
    },
    (value) => {
      value.syntheticNodeNotReady.failed.timestampUs = 999000000;
    },
    (value) => {
      value.syntheticNodeNotReady.failed.timestampUs = 2000000000;
    },
    (value) => {
      value.syntheticNodeNotReady.baseline.value = 0;
    },
    (value) => {
      value.syntheticNodeNotReady.recovered.value = 0;
    },
    (value) => {
      value.syntheticNodeNotReady.recovered.timestampUs = 1300000000;
    },
    (value) => {
      value.syntheticNodeNotReady.nativeProbeAbsent = false;
    },
    (value) => {
      value.syntheticNodeNotReady.cleanupVerified = false;
    },
    (value) => {
      value.syntheticNodeNotReady.productionRuleUnchanged = false;
    },
  ]) {
    const changed = structuredClone(evidence);
    mutate(changed);
    assert.equal(observabilityGateComplete(changed), false);
  }
  for (const name of ["loki", "grafana", "prometheus", "tempo"]) {
    delete evidence.diskPressure.backends[name];
    assert.equal(observabilityGateComplete(evidence), false, `${name} missing`);
    evidence.diskPressure.backends[name] = { status: "FAIL" };
    assert.equal(observabilityGateComplete(evidence), false, `${name} failed`);
    evidence.diskPressure.backends[name] = { status: "PASS" };
  }
  evidence.diskPressure.status = "FAIL";
  assert.equal(
    observabilityGateComplete(evidence),
    false,
    "aggregate disk pressure failed",
  );
  evidence.diskPressure.status = "PASS";
  delete evidence.phases.backupRestore;
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.backupRestore = "PASS";
  delete evidence.phases.retention;
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.retention = "PARTIAL";
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.retention = "PASS";
  evidence.cleanupErrors.push("cleanup failed");
  assert.equal(observabilityGateComplete(evidence), false);
});

void test("G14 reads only the admitted qualification and its owned one-use claim", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "g14-admission-"));
  const originalUser = os.userInfo();
  const mockedUser = t.mock.method(os, "userInfo", () => ({
    ...originalUser,
    homedir: root,
  }));
  syncBuiltinESMExports();
  t.after(async () => {
    mockedUser.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  const runId = `i12-${"a".repeat(16)}`;
  const context = {
    candidateSha: "b".repeat(40),
    baseConfigSha256: "c".repeat(64),
  };
  const policy = {
    verification: {
      realtimeQualification: { maximumAgeSeconds: 7200, budgetSeconds: 2700 },
    },
  };
  const receiptSha256 = "d".repeat(64);
  const claimPath = path.join(
    root,
    ".local/state/coffee-platform/realtime-claims",
    `${runId}.json`,
  );
  const admissionPath = path.join(
    root,
    "gates/G14_OBSERVABILITY/artifacts/realtime-capacity.json",
  );
  await mkdir(path.dirname(claimPath), { recursive: true });
  await mkdir(path.dirname(admissionPath), { recursive: true });
  const admission = {
    receipt: {
      status: "PASS",
      runId,
      ...context,
      endedAt: new Date(Date.now() - 1000).toISOString(),
      elapsedMs: 1800000,
    },
    receiptSha256,
    claimPath,
    admittedAt: new Date().toISOString(),
  };
  await writeFile(claimPath, JSON.stringify({ runId, receiptSha256 }), {
    mode: 0o400,
  });
  await writeFile(admissionPath, JSON.stringify(admission), { mode: 0o600 });
  assert.deepEqual(await readG14Qualification(root, context, policy), {
    runId,
    ...context,
    receiptSha256,
    admittedAt: admission.admittedAt,
  });
  for (const mutate of [
    (entry) => {
      entry.receipt.candidateSha = "e".repeat(40);
    },
    (entry) => {
      entry.receipt.baseConfigSha256 = "e".repeat(64);
    },
    (entry) => {
      entry.receipt.endedAt = new Date(Date.now() - 7201000).toISOString();
    },
    (entry) => {
      entry.receipt.elapsedMs = 2700001;
    },
    (entry) => {
      entry.receiptSha256 = "e".repeat(64);
    },
    (entry) => {
      entry.claimPath = path.join(root, "different.json");
    },
  ]) {
    const invalid = structuredClone(admission);
    mutate(invalid);
    await writeFile(admissionPath, JSON.stringify(invalid));
    await assert.rejects(readG14Qualification(root, context, policy));
  }
});

void test("full G14 coverage requires bound readiness, images, browser traces and admission", async () => {
  const platform = parseYaml(
    await readFile(
      new URL("../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  const pairs = {
    database: [
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
    ],
    kafka: [
      "catalog-activation-worker",
      "orders-service",
      "orders-aroma-preparation",
      "aroma-observer",
      "aroma-convergence",
      "realtime-gateway",
    ],
    "internal-api": ["orders-service", "aroma-observer", "aroma-convergence"],
  };
  const readiness = {
    status: "PASS",
    localChecks: "NOT_PROVEN",
    checks: Object.entries(pairs).flatMap(([dependency, runtimes]) =>
      runtimes.map((runtime) => ({
        runtime,
        dependency,
        before: 200,
        during: 503,
        after: 200,
        liveDuring: 200,
        restored: true,
        addressChanged:
          dependency === "kafka" && runtime !== "orders-aroma-preparation"
            ? null
            : false,
      })),
    ),
    notApplicable: ["edge-gateway", "api-public", "api-internal"].map(
      (runtime) => ({ runtime, reason: "no-registered-readiness-dependency" }),
    ),
  };
  const id = `sha256:${"1".repeat(64)}`;
  const traceId = "2".repeat(32);
  const carrier = `00-${traceId}-${"3".repeat(16)}-01`;
  const pass = { status: "PASS" };
  const proof = {
    status: "PASS",
    browserCleanup: "EXACT_OWNED_CONTAINER_REMOVED",
    runId: "child-run",
    candidateSha: "8".repeat(40),
    configSha256: "9".repeat(64),
    correlationId: "cid",
    traceId,
    ownerTraceparent: carrier,
    realtimeTraceparent: carrier,
  };
  const telemetry = {
    status: "OBSERVED",
    runId: proof.runId,
    candidateSha: proof.candidateSha,
    configSha256: proof.configSha256,
    correlationId: "cid",
    traceId,
    carrier,
    ordinaryApiMeasurement: {
      status: "MEASURED",
      sampleCount: 2,
      successCount: 2,
      min: 0.1,
      p50: 0.1,
      p95: 0.2,
      max: 0.2,
      windowStartUtc: "2026-10-30T00:00:00.000Z",
      windowEndUtc: "2026-10-30T00:00:01.000Z",
    },
    nativeSource: {
      role: "edge-nginx",
      containerId: "4".repeat(64),
      imageId: id,
    },
    ownerSource: {
      role: "orders-service",
      containerId: "5".repeat(64),
      imageId: id,
    },
    durableTraceIds: [traceId],
    durableLinks: [],
    requestTraceIds: [traceId],
    requestBindings: [
      {
        traceId,
        spanId: "7".repeat(16),
        role: "orders-service",
      },
    ],
    spans: {
      "orders-service": ["Outbox.relay", "Kafka.produce"],
      "orders-aroma-preparation": [
        "Kafka.consume",
        "Inbox.consumeOnce",
        "Outbox.relay",
        "Kafka.produce",
      ],
      "realtime-gateway": ["Kafka.consume"],
    },
  };
  const evidence = {
    status: "PASS",
    cleanupErrors: [],
    phases: Object.fromEntries(
      [
        "startup",
        "signals",
        "alerts",
        "outage",
        "persistence",
        "backupRestore",
        "runtimeMatrix",
        "memory",
        "retention",
        "launchPath",
        "diskRecovery",
      ].map((phase) => [phase, "PASS"]),
    ),
    alertTransitions: "PASS",
    syntheticNodeNotReady: structuredClone(syntheticNodeNotReady),
    launchPathCorrelation: "PASS",
    nativeNginxAlert: pass,
    redactionScan: pass,
    networkIsolation: { status: "PASS", launchPathNetworkStatus: "PASS" },
    telemetryHealth: {
      dockerLogRotation: pass,
      producerLoggingPolicy: pass,
      collectorLoggingPolicy: pass,
      launchPathCollectorConfig: "PASS",
      launchPathOutageStatus: "PASS",
      collectorMemoryProof: pass,
    },
    collectorQueueMetrics: pass,
    processCounterRestart: pass,
    diskPressureStatus: "PASS",
    runtimeShutdownStatus: "PASS",
    diskPressure: {
      status: "PASS",
      backends: Object.fromEntries(
        ["loki", "grafana", "prometheus", "tempo"].map((name) => [name, pass]),
      ),
    },
    provenanceStart: {
      baseSha: "a".repeat(40),
      configSha256: "b".repeat(64),
      bomSha256: "c".repeat(64),
      identityHash: "d".repeat(64),
      sourceFiles: pass,
    },
    qualificationAdmission: {
      runId: `i12-${"1".repeat(16)}`,
      candidateSha: "a".repeat(40),
      baseConfigSha256: "b".repeat(64),
      receiptSha256: "c".repeat(64),
      admittedAt: new Date().toISOString(),
    },
    verifiedRuntimeImages: OBSERVABILITY_TARGETS.map((service) => ({
      service,
      imageId: id,
    })),
    metricApplicability: {
      aromaConvergenceProof: {
        "unknown-current": pass,
        "recovered-terminal": pass,
      },
    },
    runtimeMetricMatrix: {
      status: "PASS",
      source: {
        baseSha: "a".repeat(40),
        configSha256: "b".repeat(64),
        bomSha256: "c".repeat(64),
        identityHash: "d".repeat(64),
      },
      configuration: {
        platformConfigSha256: "b".repeat(64),
        bomSha256: "c".repeat(64),
      },
      cleanupVerified: true,
      runtimeMetrics: {
        roles: NODE_RUNTIME_ROLES.map((role) => ({ role, status: "PASS" })),
        otlpFamilies: runtimeMetricFamilies(platform).map((family) => ({
          ...family,
          status: "PASS",
          matches: family.components.map((component) => ({
            stream: `${prometheusMetricName(family.name)}${component}`,
            sampleCount: 1,
            services: family.owners,
          })),
        })),
      },
      images: OBSERVABILITY_TARGETS.map((role) => ({
        role,
        imageId: id,
        status: "PASS",
      })),
      composeReceipt: {
        postgres: { externalPostgres: true },
        externalCleanup: { verified: true },
        dependencyReadiness: readiness,
      },
    },
    browserCorrelationChild: {
      checkoutRemoved: true,
      evidenceRemoved: true,
      cleanup: { verified: true },
      proof,
    },
    launchPathProof: {
      browserRefetchMatched: true,
      ownerCausation: true,
      traceStatus: "PASS",
      telemetrySubproof: telemetry,
    },
  };
  const options = {
    config: platform,
    sourceHashStable: true,
    backendArtifactsComplete: true,
  };
  assert.equal(
    observabilityVerificationCoverage(evidence, options).fullSystemG14.status,
    "PASS",
  );
  for (const change of [
    (value) => {
      value.syntheticNodeNotReady.ruleUid =
        "g14-v2-service-not-ready-synthetic";
    },
    (value) => {
      delete value.qualificationAdmission;
    },
    (value) => {
      value.qualificationAdmission.candidateSha = "f".repeat(40);
    },
    (value) => {
      value.runtimeMetricMatrix.runtimeMetrics.roles.pop();
    },
    ...["baseSha", "configSha256", "bomSha256", "identityHash"].flatMap(
      (key) => [
        (value) => {
          delete value.runtimeMetricMatrix.source[key];
        },
        (value) => {
          value.runtimeMetricMatrix.source[key] = "f".repeat(
            key === "baseSha" ? 40 : 64,
          );
        },
      ],
    ),
    ...["platformConfigSha256", "bomSha256"].flatMap((key) => [
      (value) => {
        delete value.runtimeMetricMatrix.configuration[key];
      },
      (value) => {
        value.runtimeMetricMatrix.configuration[key] = "f".repeat(64);
      },
    ]),
    ...["runId", "candidateSha", "configSha256"].flatMap((key) => [
      (value) => {
        delete value.launchPathProof.telemetrySubproof[key];
      },
      (value) => {
        value.launchPathProof.telemetrySubproof[key] = "foreign";
      },
    ]),
    (value) => {
      value.launchPathProof.telemetrySubproof.requestTraceIds = [
        "f".repeat(32),
      ];
      value.launchPathProof.telemetrySubproof.requestBindings[0].traceId =
        "f".repeat(32);
    },
    (value) => {
      value.runtimeMetricMatrix.runtimeMetrics.otlpFamilies.pop();
    },
    (value) => {
      value.metricApplicability.aromaConvergenceProof[
        "unknown-current"
      ].status = "FAIL";
    },
    (value) => {
      value.runtimeMetricMatrix.images[0].imageId = `sha256:${"f".repeat(64)}`;
    },
    (value) => {
      value.runtimeMetricMatrix.composeReceipt.dependencyReadiness.checks.pop();
    },
    (value) => {
      value.runtimeMetricMatrix.composeReceipt.externalCleanup.verified = false;
    },
    (value) => {
      value.launchPathProof.telemetrySubproof.correlationId = "foreign";
    },
    (value) => {
      value.launchPathProof.telemetrySubproof.ordinaryApiMeasurement.status =
        "NOT_PROVEN";
    },
    (value) => {
      value.launchPathProof.telemetrySubproof.nativeSource.imageId = `sha256:${"f".repeat(64)}`;
    },
    (value) => {
      value.browserCorrelationChild.proof.realtimeTraceparent = "foreign";
    },
    (value) => {
      value.cleanupErrors.push("unverified");
    },
  ]) {
    const altered = structuredClone(evidence);
    change(altered);
    assert.equal(
      observabilityVerificationCoverage(altered, options).fullSystemG14.status,
      "NOT_RUN",
    );
  }
  assert.equal(
    observabilityVerificationCoverage(evidence, {
      ...options,
      sourceHashStable: false,
    }).fullSystemG14.status,
    "NOT_RUN",
  );
  assert.equal(
    observabilityVerificationCoverage(evidence, {
      ...options,
      backendArtifactsComplete: false,
    }).fullSystemG14.status,
    "NOT_RUN",
  );
});

void test("Prometheus native WAL failure counter is unambiguous", () => {
  assert.equal(
    parsePrometheusWalFailures(
      "# HELP prometheus_tsdb_wal_writes_failed_total test\nprometheus_tsdb_wal_writes_failed_total 2\n",
    ),
    2,
  );
  assert.throws(
    () => parsePrometheusWalFailures(""),
    /unavailable or ambiguous/u,
  );
  assert.throws(
    () =>
      parsePrometheusWalFailures(
        "prometheus_tsdb_wal_writes_failed_total 1\nprometheus_tsdb_wal_writes_failed_total 2\n",
      ),
    /unavailable or ambiguous/u,
  );
});

void test("Grafana initial generation rejects a hidden restart even when healthy", async () => {
  const { assertGrafanaGeneration } =
    await import("../../tools/observability/verify.mjs");
  const initial = {
    Id: "a".repeat(64),
    RestartCount: 0,
    State: { StartedAt: "start", Running: true, OOMKilled: false },
  };
  assert.doesNotThrow(() => assertGrafanaGeneration(initial, initial));
  assert.throws(
    () => assertGrafanaGeneration(initial, { ...initial, RestartCount: 1 }),
    /Grafana crossed/u,
  );
  assert.throws(
    () =>
      assertGrafanaGeneration(initial, {
        ...initial,
        State: { ...initial.State, StartedAt: "restarted" },
      }),
    /Grafana crossed/u,
  );
  assert.throws(
    () =>
      assertGrafanaGeneration(
        { ...initial, RestartCount: 1 },
        { ...initial, RestartCount: 1 },
      ),
    /Grafana crossed/u,
  );
});

void test("Alloy refusal counter can be absent only before a verified first refusal", async () => {
  const now = Math.floor(Date.now() / 1000);
  const state = {
    StartedAt: new Date((now - 20) * 1000).toISOString(),
    Running: true,
    OOMKilled: false,
  };
  const generation = { id: "collector-id", state };
  const run = (args) =>
    args[0] === "exec"
      ? ""
      : args[2] === "{{.Id}}"
        ? generation.id
        : JSON.stringify(state);
  const fetchImpl = async (url) => {
    const expression = url.searchParams.get("query");
    const absent = expression.includes("refused_spans");
    const value = expression.startsWith("timestamp(") ? String(now) : "1";
    return new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "matrix",
          result: absent
            ? []
            : [
                {
                  metric: {
                    service_name: "otel-collector",
                    component_id: "otelcol.processor.memory_limiter.main",
                  },
                  values: [[now, value]],
                },
              ],
        },
      }),
    );
  };
  const options = {
    baseUrl: "http://prometheus:9090",
    config: {
      platform: { health: { timeoutMs: 1000 } },
      telemetry: {
        collector: { healthEndpoint: "http://otel-collector:13133" },
      },
    },
    run,
    name: "collector-id",
    generation,
    fetchImpl,
  };
  const baseline = await collectorMemorySelfTelemetry({
    ...options,
    allowUnmaterializedRefused: true,
  });
  assert.equal(baseline.counters.accepted, 1);
  assert.equal(baseline.counters.refused, 0);
  assert.equal(baseline.refusedNotMaterialized, true);
  await assert.rejects(
    collectorMemorySelfTelemetry(options),
    /refused counter unavailable/u,
  );
  await assert.rejects(
    collectorMemorySelfTelemetry({
      ...options,
      allowUnmaterializedRefused: true,
      generation: { id: "different", state },
    }),
    /crossed a process generation/u,
  );
});

void test("Alloy queue evidence uses matching component and signal", () => {
  assert.equal(
    isExporterMetricForSignal(
      {
        component_id: "otelcol.exporter.otlphttp.metrics",
        data_type: "metrics",
      },
      "otelcol_exporter_queue_size",
    ),
    true,
  );
  assert.equal(
    isExporterMetricForSignal(
      { component_id: "otelcol.exporter.otlphttp.metrics", data_type: "logs" },
      "otelcol_exporter_queue_size",
    ),
    false,
  );
  assert.equal(
    isExporterMetricForSignal(
      { component_id: "otelcol.exporter.otlphttp.logs" },
      "otelcol_exporter_send_failed_log_records",
    ),
    true,
  );
  assert.equal(
    isExporterMetricForSignal(
      { component_id: "otelcol.exporter.otlphttp.metrics" },
      "otelcol_exporter_send_failed_log_records",
    ),
    false,
  );
  assert.equal(
    isExporterMetricForSignal(
      { component_id: "otelcol.exporter.otlphttp.metrics" },
      "otelcol_exporter_queue_size",
    ),
    false,
  );
});

void test("Loki native WAL usage is a ratio and requires unambiguous counters", () => {
  assert.deepEqual(
    parseLokiWalMetrics(
      "loki_ingester_wal_disk_full_failures_total 3\nloki_ingester_wal_disk_usage_percent 0.81\n",
    ),
    { failures: 3, usageRatio: 0.81 },
  );
  assert.throws(
    () =>
      parseLokiWalMetrics(
        "loki_ingester_wal_disk_full_failures_total 3\nloki_ingester_wal_disk_usage_percent 81\n",
      ),
    /ratio is invalid/u,
  );
  assert.throws(
    () => parseLokiWalMetrics("loki_ingester_wal_disk_full_failures_total 3\n"),
    /unavailable or ambiguous/u,
  );
});

void test("Grafana hold windows use the episode start rather than delayed webhook arrival", () => {
  const started = "2026-10-30T10:00:00.000Z";
  assert.equal(
    alertEpisodeStartMs(`0123456789abcdef:${started}`),
    Date.parse(started),
  );
  assert.ok(Number.isNaN(alertEpisodeStartMs(`invalid:${started}`)));
});

void test("G14 cannot pass when required evidence cannot be written", async () => {
  const evidence = { status: "PASS" };
  await persistVerificationResult({
    root: "/fixture",
    evidence,
    secrets: [],
    persist: async () => {
      throw new Error("disk full");
    },
  });
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.failure, "cannot persist evidence: disk full");
  assert.equal(evidence.evidenceDirectory, undefined);
});

void test("launch observability artifacts survive removal of the temporary candidate", async () => {
  const parent = await mkdtemp(
    path.join(tmpdir(), "coffee-observability-evidence-"),
  );
  const root = path.join(parent, "candidate"),
    evidenceDir = path.join(parent, "launch");
  try {
    await mkdir(path.join(root, "config"), { recursive: true });
    for (const name of ["platform-runtime", "platform-observability"]) {
      const directory = path.join(root, "packages", name, "dist");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "index.js"), "export {};\n");
    }
    await writeFile(
      path.join(root, "config/platform.yaml"),
      "environment: development\n",
    );
    await writeFile(path.join(root, "config/toolchain-versions.json"), "{}\n");
    assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
    assert.equal(spawnSync("git", ["-C", root, "add", "config"]).status, 0);
    await mkdir(path.join(evidenceDir, "gates/G14_OBSERVABILITY/artifacts"), {
      recursive: true,
    });
    const retained = [
      "customer",
      "catalog",
      "pricing",
      "orders",
      "integration",
    ].map((owner) => `coffee_verify_20261030t120000z_123abcd_${owner}`);
    const launchPathExternalCleanup = {
      verified: false,
      databases: {
        verified: false,
        removed: [],
        retained,
        failure: "COMPOSE_CONSUMERS_NOT_STOPPED",
      },
      attachment: {
        baselineAttached: false,
        attempted: true,
        removed: false,
        routePreserved: false,
      },
      failure: "COMPOSE_CONSUMERS_NOT_STOPPED",
    };
    const evidence = {
      runId: "00bf08bb-a371-4e52-b26d-23c08e06ce16",
      status: "FAIL",
      limitations: [],
      phases: {},
      launchPathExternalCleanup,
    };
    await persistVerificationResult({
      root,
      evidence,
      secrets: [],
      launchEvidenceDir: evidenceDir,
    });
    const saved = evidence.evidenceDirectory;
    const names = [
      "alert-transitions.json",
      "correlation-proof.json",
      "redaction-scan.json",
      "queue-loss-counters.json",
      "retention-result.json",
      "runtime-health-matrix.json",
      "result.json",
    ];
    const hashes = await Promise.all(
      names.map(async (name) =>
        createHash("sha256")
          .update(await readFile(path.join(saved, name)))
          .digest("hex"),
      ),
    );
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(
      JSON.parse(await readFile(path.join(saved, "result.json"), "utf8"))
        .launchPathExternalCleanup,
      launchPathExternalCleanup,
    );
    for (let i = 0; i < names.length; i++) {
      const file = path.join(saved, names[i]);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        hashes[i],
      );
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

void test("Alloy native logfmt retry expiry reports the exact dropped_items field", () => {
  const line =
    'level=error msg="Exporting failed. Dropping data." component_id=otelcol.exporter.otlphttp.logs error="no more retries left: connection refused" dropped_items=128';
  assert.deepEqual(parseCollectorExpiredRetryDrops(line), {
    status: "PASS",
    expiredRetryDropEvents: 1,
    droppedItems: 128,
  });
  assert.deepEqual(
    parseCollectorExpiredRetryDrops(
      '{"msg":"Exporting failed. Dropping data.","error":"no more retries left","dropped_items":3}',
    ),
    { status: "PASS", expiredRetryDropEvents: 1, droppedItems: 3 },
  );
  assert.throws(() =>
    parseCollectorExpiredRetryDrops(
      line.replace("dropped_items=128", "other_dropped_items=128"),
    ),
  );
  assert.throws(() =>
    parseCollectorExpiredRetryDrops(
      line.replace("dropped_items=128", "dropped_items=128x"),
    ),
  );
});
