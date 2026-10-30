import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {awaitConvergenceMetricBarrier} from './launch-path.mjs';
import {createAlertDefinitions, createGrafanaAlertProvisioning} from '../../tools/observability/alerts.mjs';
import {createAlertSink} from '../../tools/observability/alert-sink.mjs';
import {createCollectorConfig} from '../../tools/observability/generate.mjs';
import {captureContainerDiagnostics, observabilityVerificationCoverage, parseCollectorMemoryLimiterMetrics, isCollectorMemoryRefusal, sourceIdentity, stopContainerGracefully, validateCollectorMemorySample, queryPrometheusRange, queryLokiLogs, waitForOwnedMetricFamilySamples, waitForSameTraceSpans, waitForConvergenceMetricSamples, readSinkEvents, durationMilliseconds, parseCollectorExpiredRetryDrops, observabilityGateComplete, persistVerificationResult, collectorMemorySelfTelemetry, isExporterMetricForSignal, parseLokiWalMetrics, alertEpisodeStartMs} from '../../tools/observability/verify.mjs';
import {nodeImageProbe, runtimeMetricFamilies, sanitizeRuntimeMatrixFailure, sanitizeRuntimeMetricMatches, verifyRuntimeMetricMatrix} from './runtime-matrix.mjs';
import {NODE_RUNTIME_ROLES, summarizeRuntimeProbeOutput} from './runtime-matrix-probe.mjs';

const config = {environment: 'development', telemetry: {
  namespace: 'coffee-platform', releaseDigest: 'test-release',
  diskWatermarkPercent: 80,
  alerts: {
    version: 1, evaluationIntervalMs: 60000,
    notReady: {forMs: 300000, threshold: 0},
    consumerLag: {forMs: 300000, threshold: 0},
    outboxOldestAge: {forMs: 300000, threshold: 0},
    unknownOutcome: {forMs: 120000, threshold: 0},
    sseDropRate: {forMs: 300000, threshold: 0.05}, diskUsage: {forMs: 0},
  },
}};

void test('observability CLI can await its runtime and launch modules without an ESM evaluation cycle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coffee-observability-import-'));
  const loader = path.join(dir, 'loader.mjs');
  const verify = new URL('../../tools/observability/verify.mjs', import.meta.url);
  try {
    await writeFile(loader, `
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
`);
    const execute = cycle => spawnSync(process.execPath, ['--no-warnings', '--loader', loader, fileURLToPath(verify)], {
      encoding: 'utf8', timeout: 20000, env: {...process.env, OBSERVABILITY_CYCLE_TEST: cycle ? '1' : '0'},
    });
    const negative = execute(true);
    assert.equal(negative.status, 13, 'negative control must reproduce the unsettled top-level await');
    const actual = execute(false);
    assert.equal(actual.status, 0, actual.stderr);
    assert.deepEqual(JSON.parse(actual.stdout), {status: 'probe-pass'});
  } finally {await rm(dir, {recursive: true, force: true});}
});

void test('synthetic alert fixture starts neutral and dilutes SSE only after a real low-rate drop', async () => {
  const source = await readFile(new URL('./fixture.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('let active = ');
  const end = source.indexOf('\nconst app = await createRuntime(', start);
  const configureStart = source.indexOf('  configure(server) {', end);
  const configureEnd = source.indexOf('\n  },\n});', configureStart);
  assert.ok(start >= 0 && end > start && configureStart > end && configureEnd > configureStart);
  const handlers = new Map(), readiness = [];
  const server = {post: (name, handler) => handlers.set(name, handler), get: () => {}};
  const request = {log: {info() {}}, runtimeSpan: {setAttribute() {}}};
  const reply = {code() {return this;}, send(value) {return value;}};
  let now = 1_000_000;
  const fixture = runInNewContext(`(() => {${source.slice(start, end)}\nconst app = {${source.slice(configureStart, configureEnd)}\n}}; app.configure(server); return {emit, state: () => ({active, consumerLag, oldestOutboxAgeMs, unknownOutcomes, sseAttempts, sseDrops})};})()`, {
    server, Date: {now: () => now}, config: {telemetry: {alerts: {outboxOldestAge: {threshold: 0}}, loki: {retentionDays: 3}}},
    logger: {info() {}}, runId: 'fixture', redactionCanary: 'fixture-canary',
    trace: {getTracer: () => ({startSpan: () => ({end() {}})})}, setRuntimeReadiness: value => readiness.push(value),
  });
  const state = active => handlers.get('/test/state')({body: {active}}, reply);
  const snapshot = () => JSON.parse(JSON.stringify(fixture.state()));
  fixture.emit(request);
  assert.deepEqual(snapshot(), {active: false, consumerLag: 0, oldestOutboxAgeMs: 0, unknownOutcomes: 0, sseAttempts: 0, sseDrops: 0});
  await state(true);
  now += 99_999;
  fixture.emit(request);
  assert.deepEqual(snapshot(), {active: true, consumerLag: 1, oldestOutboxAgeMs: 1, unknownOutcomes: 1, sseAttempts: 0, sseDrops: 0});
  await state(false);
  fixture.emit(request);
  assert.equal(snapshot().sseAttempts, 0, 'inactive baseline must not dilute a drop that has not occurred');
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
  assert.deepEqual(snapshot(), {active: false, consumerLag: 0, oldestOutboxAgeMs: 0, unknownOutcomes: 0, sseAttempts: 1004, sseDrops: 2});
  assert.ok(snapshot().sseDrops / snapshot().sseAttempts < 0.05);
  assert.deepEqual(readiness, [false, true, false, true]);
});

void test('Collector filelog retries transient high-memory refusals within the configured retry window', () => {
  const retry = {initialMs: 1000, maxMs: 5000, windowMs: 15000};
  const config = createCollectorConfig({
    config: {
      environment: 'test', platform: {health: {intervalMs: 5000, timeoutMs: 1000}},
      telemetry: {
        namespace: 'coffee-platform', releaseDigest: 'test-release', alerts: {evaluationIntervalMs: 60000}, nginxStatusEndpoint: 'http://edge-nginx:8081/nginx_status',
        collector: {
          otlpEndpoint: 'http://otel-collector:4318', healthEndpoint: 'http://otel-collector:13133', metricsEndpoint: 'http://otel-collector:8888',
          memoryLimitMiB: 128, memorySpikeMiB: 32, memoryCheckIntervalMs: 1000, batchSize: 128, batchTimeoutMs: 1000,
          queueCapacity: 512, queueConsumers: 2, exportTimeoutMs: 2000,
          retryInitialMs: retry.initialMs, retryMaxMs: retry.maxMs, retryWindowMs: retry.windowMs, maxLogRecordBytes: 65536,
        },
        grafana: {endpoint: 'http://grafana:3000'}, loki: {endpoint: 'http://loki:3100'},
        prometheus: {endpoint: 'http://prometheus:9090'}, tempo: {endpoint: 'http://tempo:3200', otlpEndpoint: 'http://tempo:4318'},
      },
    },
    logFiles: [{service: 'api-public', containerId: 'a'.repeat(64),
      logPath: `/var/lib/docker/containers/${'a'.repeat(64)}/${'a'.repeat(64)}-json.log`}],
    exporterToken: 'producer-token',
  });

  assert.deepEqual(config.receivers.filelog.retry_on_failure, {
    enabled: true, initial_interval: '1000ms', max_interval: '5000ms', max_elapsed_time: '15000ms',
  });
});

void test('convergence phase acknowledgement follows backend PASS and rejects failed or stale phases', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coffee-metric-barrier-'));
  const barrierId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const phase = 'unknown-current';
  const prefix = path.join(dir, `convergence-metric-${barrierId}-${phase}`);
  const checkpoint = {schemaVersion: 1, barrierId, phase, expectedMetrics: []};
  const pendingHelper = new Promise(() => {});
  try {
    await writeFile(`${prefix}.checkpoint.json`, JSON.stringify(checkpoint));
    const entered = Promise.withResolvers(), backend = Promise.withResolvers();
    const waiting = awaitConvergenceMetricBarrier({dir, barrierId, phase, helperCompletion: pendingHelper,
      onConvergenceMetrics: async value => {assert.deepEqual(value, {barrierId, phase, expectedMetrics: []}); entered.resolve(); return backend.promise;}});
    await entered.promise;
    await assert.rejects(readFile(`${prefix}.ack.json`), {code: 'ENOENT'});
    backend.resolve({status: 'PASS'});
    await waiting;
    assert.deepEqual(JSON.parse(await readFile(`${prefix}.ack.json`, 'utf8')), {schemaVersion: 1, barrierId, phase, status: 'PASS'});
    await rm(`${prefix}.ack.json`);
    const failure = new Error('backend unavailable');
    await assert.rejects(awaitConvergenceMetricBarrier({dir, barrierId, phase, helperCompletion: pendingHelper,
      onConvergenceMetrics: async () => {throw failure;}}), error => error === failure);
    assert.equal(JSON.parse(await readFile(`${prefix}.ack.json`, 'utf8')).status, 'FAIL');
    await writeFile(`${prefix}.checkpoint.json`, JSON.stringify({...checkpoint, phase: 'recovered-terminal'}));
    await assert.rejects(awaitConvergenceMetricBarrier({dir, barrierId, phase, helperCompletion: pendingHelper,
      onConvergenceMetrics: async () => assert.fail('stale phase cannot reach backend callback')}));
    assert.equal(JSON.parse(await readFile(`${prefix}.ack.json`, 'utf8')).status, 'FAIL');
    const helperFailure = new Error('helper stopped');
    await assert.rejects(awaitConvergenceMetricBarrier({dir, barrierId, phase,
      helperCompletion: Promise.resolve({ok: false, error: helperFailure}), onConvergenceMetrics: async () => assert.fail('helper already stopped')}), error => error === helperFailure);
  } finally {await rm(dir, {recursive: true, force: true});}
});

void test('runtime metric matrix derives all runtime owners and sanitizes probe receipts', () => {
  const databaseOwners = new Set([
    'customer-service', 'catalog-service', 'catalog-supplier-sync', 'catalog-activation-worker', 'pricing-service',
    'orders-service', 'orders-aroma-preparation', 'aroma-observer', 'aroma-convergence', 'aroma-gateway',
  ]);
  const consumerOwners = new Set(['orders-aroma-preparation', 'aroma-convergence', 'realtime-gateway']);
  const config = {services: Object.fromEntries(NODE_RUNTIME_ROLES.map(role => [role, {
    database: databaseOwners.has(role) ? `coffee_platform_${role}` : null,
    kafka: {consumers: consumerOwners.has(role) ? [{groupId: `${role}-consumer`, processing: role === 'realtime-gateway' ? 'realtime' : 'durable'}] : []},
  }]))};
  const families = runtimeMetricFamilies(config);
  assert.deepEqual(families.find(({name}) => name === 'runtime_http_requests_total'), {
    name: 'runtime_http_requests_total', owners: [...NODE_RUNTIME_ROLES], components: [''],
    attributes: {http_response_status_class: '4xx'},
  });
  assert.deepEqual(families.find(({name}) => name === 'db.client.connection.waiting').owners, [...databaseOwners]);
  assert.deepEqual(families.find(({name}) => name === 'messaging.kafka.consumer.lag').owners, ['orders-aroma-preparation', 'aroma-convergence']);
  assert.deepEqual(families.find(({name}) => name === 'messaging.outbox.oldest_unpublished.age').owners, [
    'catalog-activation-worker', 'orders-service', 'orders-aroma-preparation', 'aroma-observer', 'aroma-convergence',
  ]);
  assert.deepEqual(families.find(({name}) => name === 'runtime_http_request_duration_ms').components, ['_count', '_sum', '_bucket']);
  const httpDuration = families.find(({name}) => name === 'runtime_http_request_duration_ms');
  assert.deepEqual(sanitizeRuntimeMetricMatches(httpDuration, [
    {stream: 'runtime_http_request_duration_ms_milliseconds_count', sampleCount: 14, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'runtime_http_request_duration_ms_milliseconds_sum', sampleCount: 14, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'runtime_http_request_duration_ms_milliseconds_bucket', sampleCount: 42, services: [...NODE_RUNTIME_ROLES], labels: {secret: 'discard'}},
  ]), [
    {stream: 'runtime_http_request_duration_ms_milliseconds_bucket', sampleCount: 42, services: [...NODE_RUNTIME_ROLES].sort()},
    {stream: 'runtime_http_request_duration_ms_milliseconds_count', sampleCount: 14, services: [...NODE_RUNTIME_ROLES].sort()},
    {stream: 'runtime_http_request_duration_ms_milliseconds_sum', sampleCount: 14, services: [...NODE_RUNTIME_ROLES].sort()},
  ]);
  assert.throws(() => sanitizeRuntimeMetricMatches(httpDuration, []), /components incomplete/u);
  assert.throws(() => sanitizeRuntimeMetricMatches(httpDuration, [
    {stream: 'runtime_http_request_duration_ms_milliseconds_count', sampleCount: 1, services: ['other-runtime']},
    {stream: 'runtime_http_request_duration_ms_milliseconds_sum', sampleCount: 1, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'runtime_http_request_duration_ms_milliseconds_bucket', sampleCount: 1, services: [...NODE_RUNTIME_ROLES]},
  ]), /owner evidence invalid/u);

  const summary = summarizeRuntimeProbeOutput(JSON.stringify({
    node: 'v26.8.1', uid: 1000, runtime: 'orders-service', liveStatus: 200, readyStatus: 200, metricsStatus: 200,
    unknownStatus: 404, familyCount: 1, families: {runtime_admission_rejected_total: {count: 1, min: 0, max: 0}}, pass: true,
  }), {role: 'orders-service', nodeVersion: '26.8.1'});
  assert.deepEqual(summary, {
    role: 'orders-service', status: 'PASS', nodeVersion: 'v26.8.1', uid: 1000,
    http: {live: 200, ready: 200, metrics: 200, unknown: 404},
    familyCount: 1, families: {runtime_admission_rejected_total: {count: 1, min: 0, max: 0}},
  });
  assert.throws(() => summarizeRuntimeProbeOutput(JSON.stringify({secret: 'must never pass through'}), {
    role: 'orders-service', nodeVersion: '26.8.1',
  }), /runtime metrics probe assertion failed/u);
});

void test('startup diagnostics bound and redact container state, health output and logs', () => {
  const secret = 'private-credential-canary';
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push([command, args]);
    if (args[0] === 'inspect') return {status: 0, stdout: JSON.stringify({Running: true, ExitCode: 0, OOMKilled: false,
      Error: `failed ${secret}`, Health: {Status: 'unhealthy', Log: Array.from({length: 4}, (_, index) => ({ExitCode: index, Output: `failed ${secret} Bearer opaque-token password=unknown-password ${'x'.repeat(1100)}`}))},
      Config: {Env: ['SHOULD_NOT_BE_REPORTED']}})};
    return {status: 0, stdout: `error ${secret} Bearer opaque-token\n${Array(14).fill(`INFO starting SQLite migration ${secret} Bearer opaque-token ${'x'.repeat(350)}`).join('\n')}\n`, stderr: ''};
  };
  const diagnostics = captureContainerDiagnostics({name: 'a'.repeat(64), stage: 'startup', secrets: [secret], spawnProcess});
  assert.equal(diagnostics.state.Health.status, 'unhealthy');
  assert.deepEqual(diagnostics.state.Health.log.map(item => item.exitCode), [1, 2, 3]);
  assert.ok(diagnostics.state.Health.log.every(item => item.output.length <= 900));
  assert.match(diagnostics.errorOrWarningLines, /error/u);
  assert.match(diagnostics.startupLines, /SQLite migration/u);
  assert.ok(Buffer.byteLength(diagnostics.startupLines) <= 2000);
  for (const value of [secret, 'opaque-token', 'unknown-password', 'SHOULD_NOT_BE_REPORTED']) assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(value, 'u'));
  assert.equal(calls.length, 2);
  const unavailable = captureContainerDiagnostics({name: 'b'.repeat(64), spawnProcess: () => ({status: 1, stdout: '', stderr: ''})});
  assert.deepEqual(unavailable.state, {unavailable: true});
});

void test('runtime failure diagnostics retain only allowlisted error codes and local frame coordinates', () => {
  const secret = 'canary-secret-must-not-escape';
  const cause = new Error(`${secret} in message`);
  cause.name = 'AssertionError';
  cause.code = 'ERR_ASSERTION';
  cause.actual = secret;
  cause.expected = secret;
  cause.stack = `${secret}\n    at fail (file://${path.resolve('tools/compose-smoke.mjs')}:123:45)\n    at verify (file://${path.resolve('tools/observability/verify.mjs')}:345:67)\n    at test (file://${path.resolve('tests/observability/runtime-matrix.mjs')}:234:56)\n    at other (file:///tmp/${secret}.mjs:1:2)`;
  const diagnostics = sanitizeRuntimeMatrixFailure(cause);
  assert.deepEqual(diagnostics, {
    errorKind: 'AssertionError', code: 'ERR_ASSERTION', frames: [
      {source: 'tools/compose-smoke.mjs', line: 123, column: 45},
      {source: 'tools/observability/verify.mjs', line: 345, column: 67},
      {source: 'tests/observability/runtime-matrix.mjs', line: 234, column: 56},
    ],
  });
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  const aggregate = new AggregateError([cause], `${secret} aggregate message`, {cause});
  assert.deepEqual(sanitizeRuntimeMatrixFailure(aggregate), diagnostics);
  const childFailure = new Error(`${secret} child failure`);
  childFailure.code = 'ENOBUFS';
  childFailure.status = 137;
  childFailure.stderr = Buffer.from([
    secret,
    ...Array.from({length: 6}, (_, index) => `    at file:///app/[eval1]:${index + 10}:${index + 20}`),
    `    at leak (file:///tmp/${secret}.mjs:9:8)`,
  ].join('\n'));
  childFailure.stack = `${secret}\n    at run (file://${path.resolve('tools/observability/verify.mjs')}:456:78)`;
  const childDiagnostics = sanitizeRuntimeMatrixFailure(childFailure);
  assert.deepEqual(childDiagnostics, {
    errorKind: 'Error', code: 'ENOBUFS', childExitCode: 137,
    frames: [{source: 'tools/observability/verify.mjs', line: 456, column: 78}],
    childEvalFrames: [10, 11, 12, 13, 14].map((line, index) => ({line, column: index + 20})),
  });
  assert.equal(JSON.stringify(childDiagnostics).includes(secret), false);
  const signalFailure = new Error(secret);
  signalFailure.signal = 'SIGTERM';
  signalFailure.stack = childFailure.stack;
  const signalDiagnostics = sanitizeRuntimeMatrixFailure(signalFailure);
  assert.equal(signalDiagnostics.childSignal, 'SIGTERM');
  assert.equal('childExitCode' in signalDiagnostics, false);
  assert.equal(JSON.stringify(signalDiagnostics).includes(secret), false);
  assert.equal(JSON.stringify(sanitizeRuntimeMatrixFailure(aggregate)).includes(secret), false);
  const unknown = sanitizeRuntimeMatrixFailure({name: secret, code: secret, stack: `Error: ${secret}\n    at leak (/tmp/${secret}.mjs:9:8)`});
  assert.deepEqual(unknown, {errorKind: 'unknown', frames: []});
  assert.deepEqual(sanitizeRuntimeMatrixFailure(secret), {errorKind: 'unknown', frames: []});
  const quietBaselineCases = [
    {queryValue: 0, phase: 'readiness', predicate: 'readiness-not-one'},
    {queryValue: 1, phase: 'native-state', predicate: 'native-state-not-normal', nativeAlertId: '0'.repeat(27),
      nativeOutcome: 'pending', nativeOutcomeAtUs: 1234567, nativeOutcomeSinceUs: 1234000, nativeOutcomeAnchorAtUs: 1230000,
      lastReset: {reason: 'native-state-not-normal', observedAt: 1234, nativeOutcome: 'pending'}},
    {queryValue: 1, phase: 'native-state', predicate: 'awaiting-fresh-native-normal',
      lastReset: {reason: 'native-normal-not-fresh', observedAt: 1234, nativeOutcome: 'normal'}},
    {queryValue: 1, phase: 'episodes', predicate: 'unresolved-episodes', eventCount: 2, episodeCount: 1, unresolvedEpisodeCount: 1},
    {queryValue: null, phase: 'request-error', predicate: 'readiness-query-failed', requestError: {source: 'query', httpStatus: 503, errorClass: 'Error'}},
    {queryValue: 1, phase: 'request-error', predicate: 'sink-query-failed', requestError: {source: 'sink', errorClass: 'AbortError'}},
    {queryValue: 1, phase: 'stability', predicate: 'continuous-stability', stableMs: 1500},
  ];
  for (const sample of quietBaselineCases) {
    const quietBaseline = {
      queryValue: null, observedAt: 1234, requiredStableMs: 60000, stableMs: 0,
      eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0,
      phase: 'readiness', predicate: 'readiness-not-one', ...sample,
      arbitraryBody: secret,
      ...(sample.requestError === undefined ? {} : {requestError: {...sample.requestError, message: secret, headers: {authorization: secret}}}),
    };
    const cause = new Error(secret);
    const wrappedFailure = Object.assign(new Error(secret), {cause, nativeNginxAlert: quietBaseline});
    const sanitized = sanitizeRuntimeMatrixFailure(wrappedFailure);
    const expected = {
      queryValue: sample.queryValue, observedAt: 1234, requiredStableMs: 60000,
      stableMs: sample.stableMs ?? 0, eventCount: sample.eventCount ?? 0,
      episodeCount: sample.episodeCount ?? 0, unresolvedEpisodeCount: sample.unresolvedEpisodeCount ?? 0,
      phase: sample.phase, predicate: sample.predicate,
      ...(sample.requestError === undefined ? {} : {requestError: sample.requestError}),
      ...(sample.nativeAlertId === undefined ? {} : {nativeAlertId: sample.nativeAlertId, nativeOutcome: sample.nativeOutcome,
        nativeOutcomeAtUs: sample.nativeOutcomeAtUs, nativeOutcomeSinceUs: sample.nativeOutcomeSinceUs,
        nativeOutcomeAnchorAtUs: sample.nativeOutcomeAnchorAtUs,
        lastReset: sample.lastReset}),
      ...(sample.lastReset?.reason === 'native-normal-not-fresh' ? {lastReset: sample.lastReset} : {}),
    };
    assert.deepEqual(sanitized.nativeNginxAlert, expected);
    assert.equal(JSON.stringify(sanitized).includes(secret), false);
  }
  const retriedSnapshot = {
    queryValue: 1, observedAt: 2345, requiredStableMs: 60000, stableMs: 1500,
    eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0,
    phase: 'stability', predicate: 'continuous-stability', queryDurationMs: 37,
    lastReset: {reason: 'request-error', observedAt: 1234, phase: 'readiness', queryDurationMs: 5000,
      requestError: {source: 'query', httpStatus: 503, errorClass: 'TimeoutError', message: secret}},
  };
  const retriedFailure = Object.assign(new Error(secret), {nativeNginxAlert: retriedSnapshot});
  const retriedDiagnostics = sanitizeRuntimeMatrixFailure(retriedFailure);
  assert.deepEqual(retriedDiagnostics.nativeNginxAlert, {
    queryValue: 1, observedAt: 2345, requiredStableMs: 60000, stableMs: 1500,
    eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0,
    phase: 'stability', predicate: 'continuous-stability', queryDurationMs: 37,
    lastReset: {reason: 'request-error', observedAt: 1234, phase: 'readiness', queryDurationMs: 5000,
      requestError: {source: 'query', httpStatus: 503, errorClass: 'TimeoutError'}},
  });
  assert.equal(JSON.stringify(retriedDiagnostics).includes(secret), false);
  const recoveryObservation = {
    stage: 'recovery', outcome: 'VALUE_MISMATCH', requiredAfterUs: 1_800_000_500_000_000,
    observedAtUs: 1_800_000_560_000_000, rowCount: 3, matchingRowCount: 2, expectedValue: 1,
    totalRowCount: 8, isPartial: false,
    latestTargetSample: {service: 'edge-nginx', statusClass: '2xx', timestampUs: 1_800_000_550_000_000, value: 0},
    arbitraryBody: secret,
  };
  const recoveryFailure = Object.assign(new Error(secret), {
    nativeNginxAlert: {queryValue: 1, observedAt: 2345, requiredStableMs: 60000, stableMs: 0,
      eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0, phase: 'readiness', predicate: 'readiness-not-one'},
    nativeNginxRecovery: recoveryObservation,
  });
  const recoveryDiagnostics = sanitizeRuntimeMatrixFailure(recoveryFailure);
  assert.deepEqual(recoveryDiagnostics.nativeNginxRecovery, {
    stage: 'recovery', outcome: 'VALUE_MISMATCH', requiredAfterUs: recoveryObservation.requiredAfterUs,
    observedAtUs: recoveryObservation.observedAtUs, rowCount: 3, matchingRowCount: 2, expectedValue: 1,
    totalRowCount: 8, isPartial: false,
    latestTargetSample: recoveryObservation.latestTargetSample,
  });
  assert.equal(recoveryDiagnostics.nativeNginxAlert.predicate, 'readiness-not-one', 'recovery diagnostics do not replace the native baseline evidence');
  assert.equal(JSON.stringify(recoveryDiagnostics).includes(secret), false);
  const invalidRecoveryFailure = Object.assign(new Error(secret), {
    nativeNginxRecovery: {...recoveryObservation, latestTargetSample: {...recoveryObservation.latestTargetSample, value: Number.NaN}},
  });
  assert.equal('nativeNginxRecovery' in sanitizeRuntimeMatrixFailure(invalidRecoveryFailure), false,
    'non-finite target values are omitted instead of serialized');
  const pendingFailure = Object.assign(new Error(secret), {nativeNginxAlert: {
    queryValue: 1, observedAt: 2345, requiredStableMs: 65000, stableMs: 0,
    eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0,
    phase: 'pending-firing', predicate: 'pending-window-not-proven', nativeAlertId: '0'.repeat(27), nativeOutcome: 'firing',
    nativeOutcomeAtUs: 1_800_000_400_000_000, nativeOutcomeSinceUs: 1_800_000_350_000_000,
    pendingSinceUs: 1_800_000_001_000_000, firingSinceUs: 1_800_000_350_000_000, pendingElapsedUs: 349_000_000,
    stopCallStartedAtUs: 1_800_000_000_000_000, stopCallEndedAtUs: 1_800_000_100_000_000,
    firstFailedProbeAtUs: 1_800_000_110_000_000, firingOutcomeAtUs: secret, baselineNormalSinceUs: Number.NaN, arbitraryBody: secret,
  }});
  const pendingDiagnostics = sanitizeRuntimeMatrixFailure(pendingFailure);
  assert.deepEqual(pendingDiagnostics.nativeNginxAlert, {
    queryValue: 1, observedAt: 2345, requiredStableMs: 65000, stableMs: 0,
    eventCount: 0, episodeCount: 0, unresolvedEpisodeCount: 0,
    phase: 'pending-firing', predicate: 'pending-window-not-proven', nativeAlertId: '0'.repeat(27), nativeOutcome: 'firing',
    nativeOutcomeAtUs: 1_800_000_400_000_000, nativeOutcomeSinceUs: 1_800_000_350_000_000,
    pendingSinceUs: 1_800_000_001_000_000, firingSinceUs: 1_800_000_350_000_000, pendingElapsedUs: 349_000_000,
    stopCallStartedAtUs: 1_800_000_000_000_000, stopCallEndedAtUs: 1_800_000_100_000_000,
    firstFailedProbeAtUs: 1_800_000_110_000_000,
  });
  assert.equal(JSON.stringify(pendingDiagnostics).includes(secret), false);
  const invalidDuration = structuredClone(retriedSnapshot);
  invalidDuration.queryDurationMs = '37';
  invalidDuration.lastReset.queryDurationMs = Number.NaN;
  const invalidDurationDiagnostics = sanitizeRuntimeMatrixFailure(Object.assign(new Error(secret), {nativeNginxAlert: invalidDuration}));
  assert.equal('queryDurationMs' in invalidDurationDiagnostics.nativeNginxAlert, false);
  assert.equal('lastReset' in invalidDurationDiagnostics.nativeNginxAlert, false);
  assert.equal(JSON.stringify(invalidDurationDiagnostics).includes(secret), false);
  const safeObservation = {
    name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components: [
      {component: '_count', streamPresent: true, presentOwners: ['orders-service', 'api-public'], missingOwners: [], sampleCount: 2},
      {component: '_sum', streamPresent: true, presentOwners: ['orders-service', 'api-public'], missingOwners: [], sampleCount: 2},
      {component: '_bucket', streamPresent: true, presentOwners: [], missingOwners: ['orders-service', 'api-public'], sampleCount: 0,
        queryFailure: {outcome: 'QUERY_FAILED'}},
    ],
  };
  assert.deepEqual(sanitizeRuntimeMatrixFailure(Object.assign(new Error(secret), {metricFamilyObservation: safeObservation})).metricFamilyObservation, safeObservation);
  const malformedMetadata = structuredClone(safeObservation);
  malformedMetadata.components[2].queryFailure.httpStatus = '503';
  malformedMetadata.components[2].queryFailure.errorClass = secret;
  const safeMalformedMetadata = sanitizeRuntimeMatrixFailure(Object.assign(new Error(secret), {metricFamilyObservation: malformedMetadata}));
  assert.deepEqual(safeMalformedMetadata.metricFamilyObservation.components[2].queryFailure, {outcome: 'QUERY_FAILED'});
  assert.equal(JSON.stringify(safeMalformedMetadata).includes(secret), false);
  for (const httpStatus of [99, 600, 503.5, '503']) {
    const invalidStatus = structuredClone(safeObservation);
    invalidStatus.components[2].queryFailure.httpStatus = httpStatus;
    const sanitized = sanitizeRuntimeMatrixFailure(Object.assign(new Error(secret), {metricFamilyObservation: invalidStatus}));
    assert.deepEqual(sanitized.metricFamilyObservation.components[2].queryFailure, {outcome: 'QUERY_FAILED'});
  }
  const validMetadata = structuredClone(safeObservation);
  validMetadata.components[2].queryFailure.httpStatus = 503;
  validMetadata.components[2].queryFailure.errorClass = 'AbortError';
  assert.deepEqual(sanitizeRuntimeMatrixFailure(Object.assign(new Error(secret), {metricFamilyObservation: validMetadata}))
    .metricFamilyObservation.components[2].queryFailure, {outcome: 'QUERY_FAILED', httpStatus: 503, errorClass: 'AbortError'});
  const invalidObservations = [
    observation => { observation.name = secret; },
    observation => { observation.owners[1] = secret; },
    observation => { observation.components[0].component = secret; },
    observation => { observation.components[2].queryFailure.outcome = secret; },
    observation => { observation.components[2].queryFailure.extra = secret; },
    observation => { observation.components[0].sampleCount = 1.5; },
  ];
  for (const mutate of invalidObservations) {
    const invalidFailure = new Error(secret);
    invalidFailure.metricFamilyObservation = structuredClone(safeObservation);
    mutate(invalidFailure.metricFamilyObservation);
    const serialized = JSON.stringify(sanitizeRuntimeMatrixFailure(invalidFailure));
    assert.equal(serialized.includes('metricFamilyObservation'), false);
    assert.equal(serialized.includes(secret), false);
  }
});

void test('infrastructure stop gate rejects a Docker stop that needed SIGKILL', () => {
  const stopStates = [
    {Running: false, ExitCode: 0, OOMKilled: false},
    {Running: false, ExitCode: 137, OOMKilled: false},
  ];
  const commands = [];
  const run = (args) => {
    commands.push(args);
    if (args[0] === 'inspect' && args[2] === '{{.Id}}') return 'a'.repeat(64);
    if (args[0] === 'inspect' && args[2] === '{{json .State}}') return JSON.stringify(stopStates.shift());
    return 'container';
  };
  const clean = stopContainerGracefully({run, name: 'collector-fixture', graceMs: 30000});
  const forced = stopContainerGracefully({run, name: 'grafana-fixture', graceMs: 30000});
  assert.equal(clean.status, 'PASS');
  assert.equal(clean.exitCode, 0);
  assert.equal(clean.oomKilled, false);
  assert.equal(clean.forcedKill, false);
  assert.equal(forced.status, 'FAIL');
  assert.equal(forced.exitCode, 137);
  assert.equal(forced.forcedKill, true);
  assert.ok(forced.elapsedMs <= forced.graceBudgetMs);
  assert.deepEqual(commands.filter(args => args[0] === 'stop'), [
    ['stop', '--time', '30', 'collector-fixture'],
    ['stop', '--time', '30', 'grafana-fixture'],
  ]);
});

void test('Collector memory proof accepts only native limiter counters and bounded fresh cgroup samples', () => {
  assert.equal(isCollectorMemoryRefusal({httpStatus: 503, otlpCode: 14, refusal: true}), true);
  for (const response of [
    {httpStatus: 503, otlpCode: 14, refusal: false},
    {httpStatus: 503, otlpCode: 13, refusal: true},
    {httpStatus: 500, otlpCode: 14, refusal: true},
    {httpStatus: 200, otlpCode: 14, refusal: true},
    {httpStatus: 503, otlpCode: '14', refusal: true},
    undefined,
  ]) assert.equal(isCollectorMemoryRefusal(response), false);
  assert.deepEqual(parseCollectorMemoryLimiterMetrics([
    '# HELP otelcol_processor_memory_limiter_refused_spans Refused spans.',
    'otelcol_processor_memory_limiter_refused_spans{processor="memory_limiter"} 2',
    'otelcol_processor_memory_limiter_refused_spans_total{processor="memory_limiter"} 3',
    'otelcol_processor_memory_limiter_accepted_spans{processor="memory_limiter",otel_scope_name="otelcol"} 17',
    'otelcol_processor_memory_limiter_refused_spans{processor="other"} 99',
    'otelcol_processor_memory_limiter_refused_spans_extra{processor="memory_limiter"} 99',
  ].join('\n')), {refused: 3, accepted: 17});
  assert.throws(() => parseCollectorMemoryLimiterMetrics('otelcol_processor_memory_limiter_refused_spans{processor="memory_limiter"} NaN'), /counter was invalid/u);
  const memoryOptions = {nowMs: 1000, receivedAtMs: 900, previousSequence: 1,
    containerMemoryMiB: 512, guardBytes: 448 * 1024 * 1024};
  const fresh = {sequence: 2, currentBytes: 128 * 1024 * 1024, maxBytes: 512 * 1024 * 1024,
    kernelPeakBytes: 192 * 1024 * 1024, anonBytes: 96 * 1024 * 1024, fileBytes: 24 * 1024 * 1024,
    kernelBytes: 8 * 1024 * 1024, oom: 0, oomKill: 0, sampledAtMs: 1700000000000};
  assert.equal(validateCollectorMemorySample(fresh, memoryOptions), fresh);
  for (const options of [
    {...memoryOptions, nowMs: 1001},
    {...memoryOptions, previousSequence: 0},
  ]) assert.throws(() => validateCollectorMemorySample(fresh, options), /invalid or stale/u);
  assert.throws(() => validateCollectorMemorySample({...fresh, maxBytes: 320 * 1024 * 1024}, memoryOptions), /invalid or stale/u);
  assert.throws(() => validateCollectorMemorySample(fresh, {...memoryOptions, containerMemoryMiB: 320}), /invalid or stale/u);
  assert.throws(() => validateCollectorMemorySample({...fresh, fileBytes: -1}, memoryOptions), /invalid or stale/u);
  for (const failing of [
    {...fresh, kernelPeakBytes: 448 * 1024 * 1024},
    {...fresh, oomKill: 1},
  ]) {
    assert.throws(() => validateCollectorMemorySample(failing, memoryOptions), error => {
      assert.match(error.message, /safety guard/u);
      assert.equal(error.diagnosticCode, 'COLLECTOR_MEMORY_SAFETY_GUARD');
      assert.deepEqual(Object.keys(error.failureSample).sort(), ['anonBytes', 'currentBytes', 'fileBytes', 'kernelBytes', 'kernelPeakBytes', 'maxBytes', 'oom', 'oomKill', 'sampledAtMs', 'sequence']);
      assert.equal(error.failureSample.kernelPeakBytes, failing.kernelPeakBytes);
      return true;
    });
  }
  assert.throws(() => validateCollectorMemorySample({...fresh, privateCanary: 'sensitive-memory-record'}, memoryOptions), error => {
    assert.match(error.message, /invalid or stale/u);
    assert.deepEqual(error.failureSample, fresh);
    assert.equal(JSON.stringify(error.failureSample).includes('sensitive-memory-record'), false);
    return true;
  });
  assert.throws(() => validateCollectorMemorySample({...fresh, currentBytes: 448 * 1024 * 1024}, memoryOptions), /safety guard/u);
});

void test('Collector memory pressure resumes owned Tempo before counter confirmation and on failure', async () => {
  const source = await readFile(new URL('../../tools/observability/verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function runCollectorMemoryProof(');
  const end = source.indexOf('\nfunction metricTimestampUs(', start);
  assert.ok(start >= 0 && end > start);
  const scenario = async (failure) => {
    let now = 1_000_000, paused = false, accepted = 1, refused = 0, unpauseAttempts = 0;
    const events = [], progress = {}, cleanupErrors = [], tempoId = 'a'.repeat(64);
    class Clock extends Date { static now() { return now; } }
    const run = args => {
      if (args[0] === 'inspect') return JSON.stringify({'com.docker.compose.project': 'coffee-observability-run', 'com.docker.compose.service': failure === 'ownership' ? 'loki' : 'tempo'});
      if (args[0] === 'pause') {events.push('pause'); paused = true; if (failure === 'pause') throw new Error('pause failed');}
      if (args[0] === 'unpause') {events.push('unpause'); if (failure === 'combined' || (failure === 'unpause' && ++unpauseAttempts === 1)) throw new Error('unpause failed'); paused = false;}
    };
    const proof = runInNewContext(`(${source.slice(start, end)})`, {
      Date: Clock, sleep: async ms => {now += ms;}, MEMORY_MIB_BYTES: 1024 * 1024, MEMORY_SAMPLER_STALE_MS: 100,
      MEMORY_LIMITER_METRICS: {refused: 'refused', accepted: 'accepted'}, safeCollectorMemorySample: value => value,
      isCollectorMemoryRefusal,
      containerGeneration: ({name}) => ({id: name === 'collector' ? name : tempoId, state: {Running: true, Paused: name !== 'collector' && paused, OOMKilled: false, StartedAt: 'start'}}),
      collectorMemorySelfTelemetry: async ({allowUnmaterializedRefused}) => {
        if (!allowUnmaterializedRefused) {events.push('confirmation'); assert.equal(paused, false);}
        return {counters: {accepted, refused}};
      },
      sendCollectorMemorySpan: async ({name, paddingBytes}) => {
        if (name.endsWith('pressure')) {
          events.push('pressure'); assert.equal(paused, true); assert.equal(paddingBytes, 200 * 1024);
          if (failure === 'request' || failure === 'combined') throw new Error('pressure failed');
          if (failure === 'exhausted') {now += 60000; return {httpStatus: 200, wireBytes: 2048};}
          if (failure === 'invalid') return {httpStatus: 503, otlpCode: 13, refusal: true, wireBytes: 2048};
          refused = 1; return {httpStatus: 503, otlpCode: 14, refusal: true, wireBytes: 2048};
        }
        accepted++; return {httpStatus: 200, wireBytes: 1024};
      },
    });
    const options = {run, collectorName: 'collector', tempoName: tempoId.slice(0, 12), collectorIp: 'collector', prometheusUrl: 'prometheus',
      config: {platform: {health: {intervalMs: 5000}}, telemetry: {collector: {memoryLimitMiB: 256, memorySpikeMiB: 64,
        memoryCheckIntervalMs: 1000, retryWindowMs: 15000, containerMemoryMiB: 1024}}},
      collectorConfig: 'limit = "256MiB" spike_limit = "64MiB" check_interval = "1000ms"', token: 'secret', runId: 'run', progress, cleanupErrors, cleanError: error => error.message,
      sampler: {peakBytes: 1024, waitForFreshSample: async () => ({currentBytes: 512, maxBytes: 1024})}};
    if (failure) {
      const message = {invalid: /unproven memory-refusal/u, request: /pressure failed/u, pause: /pause failed/u,
        unpause: /unpause failed/u, combined: /pressure failed/u, exhausted: /not reached/u, ownership: /ownership/u}[failure];
      await assert.rejects(proof(options), message);
      assert.equal(paused, failure === 'combined');
      assert.deepEqual(cleanupErrors, failure === 'combined' ? ['Tempo memory restore: unpause failed'] : []);
      assert.deepEqual(events.filter(event => event === 'pause' || event === 'unpause'), failure === 'ownership' ? [] :
        failure === 'unpause' ? ['pause', 'unpause', 'unpause'] : ['pause', 'unpause']);
      if (failure === 'request') {assert.equal(progress.attempted, 1); assert.equal(progress.pendingMaxWireBytes, 512 * 1024);}
      if (failure === 'exhausted') assert.equal(progress.packetCount, 1);
    } else {
      const result = await proof(options);
      assert.equal(result.refusal.refusedSpansDelta, 1);
      assert.equal(result.recovery.acceptedSpansDelta, 1);
      assert.ok(events.indexOf('pause') < events.indexOf('pressure'));
      assert.ok(events.indexOf('pressure') < events.indexOf('unpause'));
      assert.ok(events.indexOf('unpause') < events.indexOf('confirmation'));
      assert.equal(paused, false);
    }
    assert.equal(JSON.stringify(progress).includes('secret'), false);
  };
  for (const failure of [undefined, 'invalid', 'request', 'pause', 'unpause', 'combined', 'exhausted', 'ownership']) await scenario(failure);
});

void test('generated Node image probe accepts nameless nested package metadata but keeps package roots strict', () => {
  const runProbe = (files,links={}) => {
    const directories = new Set(['/app']);
    for (const file of Object.keys(files)) {
      let parent = path.dirname(file);
      while (parent.startsWith('/app/')) { directories.add(parent); parent = path.dirname(parent); }
    }
    for(const link of Object.keys(links)){let parent=path.dirname(link);while(parent.startsWith('/app/')){directories.add(parent);parent=path.dirname(parent);}}
    const linkedPath=value=>{
      for(const [link,target]of Object.entries(links))if(value===link||value.startsWith(`${link}/`))return target.error?value:`${target.path}${value.slice(link.length)}`;
      return value;
    };
    const fs = {
      realpathSync(value) { const linked=linkedPath(value);if (!directories.has(linked)) throw new Error('missing fixture directory'); return linked; },
      readFileSync(value) { const linked=linkedPath(value);if (!Object.hasOwn(files, linked)) throw new Error('missing fixture file'); return files[linked]; },
      statSync(value) {
        if(links[value]?.error){const error=new Error('fixture stat failed');error.code=links[value].error;throw error;}
        const linked=linkedPath(value);
        return {isFile: () => Object.hasOwn(files, linked),isDirectory:()=>directories.has(linked)};
      },
      readdirSync(value) {
        value=linkedPath(value);
        if (!directories.has(value)) throw new Error('missing fixture directory');
        const children = new Map();
        for (const entry of [...directories, ...Object.keys(files),...Object.keys(links)]) {
          if (!entry.startsWith(`${value}/`)) continue;
          const rest = entry.slice(value.length + 1);
          if (!rest.includes('/')) children.set(rest, Object.hasOwn(links,entry)?'symlink':Object.hasOwn(files, entry) ? 'file' : 'directory');
          else {const child=path.join(value,rest.split('/')[0]);children.set(rest.split('/')[0],Object.hasOwn(links,child)?'symlink':'directory');}
        }
        return [...children].map(([name, kind]) => ({name,isFile:()=>kind==='file',isDirectory:()=>kind==='directory',isSymbolicLink:()=>kind==='symlink'}));
      },
    };
    let output = '';
    const runtimeProcess = {version:process.version,getuid:()=>1000,stdout:{write:value=>{output+=value;}},exitCode:0};
    runInNewContext(nodeImageProbe('orders-service',process.versions.node,['typescript']),{process:runtimeProcess,require:name=>name==='node:fs'?fs:name==='node:path'?path:(()=>{throw new Error('unexpected module');})()});
    return JSON.parse(output);
  };
  const base = {
    '/app/package.json': JSON.stringify({name:'@coffee-platform/orders-service',dependencies:{}}),
    '/app/dist/main.js': '',
    '/app/node_modules/fastify/package.json': JSON.stringify({name:'fastify'}),
    '/app/node_modules/.pnpm/@scope+lib@1/node_modules/@scope/lib/package.json': JSON.stringify({name:'@scope/lib'}),
  };
  const valid = runProbe({...base,'/app/node_modules/fastify/test/fixtures/package.json':JSON.stringify({type:'module'})});
  assert.equal(valid.packageScanComplete,true);assert.deepEqual(valid.forbiddenPackages,[]);assert.equal(valid.pass,true);
  for(const packageRoot of ['/app/node_modules/fastify/package.json','/app/node_modules/.pnpm/@scope+lib@1/node_modules/@scope/lib/package.json']){
    const missingInstalledName = runProbe({...base,[packageRoot]:'{}'});
    assert.equal(missingInstalledName.packageScanComplete,false);assert.equal(missingInstalledName.pass,false);
  }
  for(const invalidManifest of ['{invalid','[]','null','42','{"name":7}']){
    const malformedNested = runProbe({...base,'/app/node_modules/fastify/test/fixtures/package.json':invalidManifest});
    assert.equal(malformedNested.packageScanComplete,false);assert.equal(malformedNested.pass,false);
  }
  const forbiddenNested = runProbe({...base,'/app/node_modules/fastify/test/fixtures/package.json':JSON.stringify({name:'typescript'})});
  assert.equal(forbiddenNested.packageScanComplete,true);assert.deepEqual(forbiddenNested.forbiddenPackages,['typescript']);assert.equal(forbiddenNested.pass,false);
  const danglingWorkspaceAlias='/app/node_modules/.pnpm/node_modules/@coffee-platform/orders-service';
  const missingTarget = runProbe(base,{[danglingWorkspaceAlias]:{error:'ENOENT'}});
  assert.equal(missingTarget.packageScanComplete,true);assert.equal(missingTarget.pass,true);
  const inaccessibleTarget = runProbe(base,{[danglingWorkspaceAlias]:{error:'EACCES'}});
  assert.equal(inaccessibleTarget.packageScanComplete,false);assert.equal(inaccessibleTarget.pass,false);
  const linkedForbidden = runProbe({...base,'/app/vendor/compiler/package.json':JSON.stringify({name:'typescript'})},{[danglingWorkspaceAlias]:{path:'/app/vendor/compiler'}});
  assert.equal(linkedForbidden.packageScanComplete,true);assert.deepEqual(linkedForbidden.forbiddenPackages,['typescript']);assert.equal(linkedForbidden.pass,false);
});

void test('runtime metric matrix requires a source identity callback before any Docker work', async () => {
  const args = {
    projectName: 'coffee-launch-20261024t120000z-a12bc34', exporterToken: 'fixture-token',
    onRolesReady: async () => {}, onCleanup: async () => {}, verifyMetricFamily: async () => {},
    nodeVersion: '1.2.3', nginxVersion: '1.2.3',
  };
  let dockerCalls = 0;
  for (const sourceIdentity of [undefined, {}]) {
    await assert.rejects(verifyRuntimeMetricMatrix({
      ...args, sourceIdentity, runDocker: () => { dockerCalls += 1; throw new Error('unexpected Docker call'); },
    }), /runtime matrix inputs invalid/u);
  }
  let identityCalls = 0;
  for (const projectName of ['coffee-legacy-runtime-aaaaaaaa', 'coffee-launch-20261024t120000z-a12bc340',
    'coffee-launch-20261024T120000Z-a12bc34', 'coffee-launch-local-20261024t120000z-a12bc34', 'coffee-platform']) {
    await assert.rejects(verifyRuntimeMetricMatrix({
      ...args, projectName,
      sourceIdentity: async () => { identityCalls += 1; throw new Error('unexpected source callback'); },
      runDocker: () => { dockerCalls += 1; throw new Error('unexpected Docker call'); },
    }), /runtime matrix inputs invalid/u);
  }
  assert.equal(identityCalls, 0);
  await assert.rejects(verifyRuntimeMetricMatrix({
    ...args,
    sourceIdentity: async () => { identityCalls += 1; throw new Error('source callback failure'); },
    runDocker: () => { dockerCalls += 1; throw new Error('unexpected Docker call'); },
  }), /runtime matrix source identity unavailable/u);
  assert.equal(identityCalls, 1);
  assert.equal(dockerCalls, 0);
});

void test('verification provenance hashes the non-ignored source tree and compiled runtime packages', async () => {
  const identity = await sourceIdentity(new URL('../..', import.meta.url).pathname);
  assert.equal(identity.sourceFiles.status, 'PASS');
  assert.ok(identity.sourceFiles.fileCount > 0);
  assert.match(identity.sourceFiles.sha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.configSha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.bomSha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.runtimeArtifacts['packages/platform-runtime/dist'].sha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.runtimeArtifacts['packages/platform-observability/dist'].sha256, /^[a-f0-9]{64}$/u);
  assert.match(identity.identityHash, /^[a-f0-9]{64}$/u);
});

void test('observability evidence distinguishes selected live roles from full 14-runtime G14 coverage', () => {
  const coverage = observabilityVerificationCoverage({
    launchPathProof: {roles: [
      {role: 'edge-nginx'}, {role: 'edge-gateway'}, {role: 'api-public'}, {role: 'api-internal'}, {role: 'orders-service'},
      {role: 'orders-aroma-preparation'}, {role: 'realtime-gateway'}, {role: 'kafka'},
    ]},
    metricApplicability: {
      'messaging.kafka.consumer.lag': [],
      aromaConvergenceProof: {owner: 'aroma-convergence'},
    },
  });
  assert.equal(coverage.verificationScope, 'operations-component');
  assert.equal(coverage.fullSystemG14.status, 'NOT_RUN');
  assert.equal(coverage.fullSystemG14.owner, '#13');
  assert.equal(coverage.fullSystemG14.requiredNodeRuntimeCount, 14);
  assert.deepEqual(coverage.fullSystemG14.launchPathNodeRuntimes, [
    'api-internal', 'api-public', 'edge-gateway', 'orders-aroma-preparation', 'orders-service', 'realtime-gateway',
  ]);
  assert.equal(coverage.fullSystemG14.launchPathNativeNginx, true);
  assert.equal(coverage.fullSystemG14.convergenceMetricProof.processKind, 'driver-container SQL-backed proof helper');
  assert.equal(coverage.fullSystemG14.convergenceMetricProof.status, 'PASS');
  assert.deepEqual(coverage.fullSystemG14.nodeRuntimesNotClaimedAsLive, [
    'customer-service', 'catalog-service', 'catalog-supplier-sync', 'catalog-activation-worker',
    'pricing-service', 'aroma-observer', 'aroma-convergence', 'aroma-gateway',
  ]);
  const withMatrix = observabilityVerificationCoverage({runtimeMetricMatrix: {status: 'PASS', runtimeMetrics: {roles: NODE_RUNTIME_ROLES.map(role => ({role}))}}});
  assert.deepEqual(withMatrix.fullSystemG14.metricMatrixNodeRuntimes, [...NODE_RUNTIME_ROLES]);
  assert.deepEqual(withMatrix.fullSystemG14.nodeRuntimesNotClaimedAsLive, []);
  assert.equal(withMatrix.fullSystemG14.status, 'NOT_RUN', 'functional telemetry coverage does not grant full-system launch acceptance');
});

void test('Grafana provisions deployment-scoped rules with configured windows and local recovery delivery', () => {
  const {alerts, contacts} = createGrafanaAlertProvisioning(config, {notificationUrl: 'http://alert-sink:9091/alerts'});
  const rules = alerts.groups[0].rules;
  const definitions = createAlertDefinitions({config});
  assert.deepEqual(rules.map(rule => rule.for), ['300s', '300s', '300s', '120s', '300s', '0s']);
  assert.ok(rules.every(rule => rule.data[0].datasourceUid === 'prometheus' && rule.data[0].model.expr.includes(
    'deployment_environment="development",service_namespace="coffee-platform",service_version="test-release"')));
  assert.match(rules[0].data[0].model.expr, /count by \(service_name\).+== bool 14/u);
  assert.match(rules[0].data[0].model.expr, /probe_success\{service_name="otel-collector",probe_owner="edge-nginx"/u);
  assert.match(rules[1].data[0].model.expr, /messaging_kafka_consumer_lag_messages/u);
  assert.match(rules[2].data[0].model.expr, /messaging_outbox_oldest_unpublished_age_milliseconds/u);
  assert.equal(rules[4].data[1].model.expression, '$A > 0.05');
  assert.equal(rules[5].data[1].model.expression, '$A >= 80');
  assert.match(rules[5].data[0].model.expr, /^100 \* \(1 - node_filesystem_free_bytes\{mountpoint=~"\/telemetry-storage\/\(grafana\|loki\|prometheus\|tempo\)",service_name="otel-collector"/u);
  assert.match(rules[5].data[0].model.expr, /\/ node_filesystem_size_bytes\{mountpoint=~"\/telemetry-storage\/\(grafana\|loki\|prometheus\|tempo\)",service_name="otel-collector"/u);
  assert.equal((rules[5].data[0].model.expr.match(/deployment_environment="development"/gu) ?? []).length, 2);
  assert.doesNotMatch(rules[5].data[0].model.expr, /state=/u);
  assert.equal(rules[5].noDataState, 'Alerting');
  assert.equal(contacts.contactPoints[0].receivers[0].settings.url, 'http://alert-sink:9091/alerts');
  assert.equal(contacts.contactPoints[0].receivers[0].disableResolveMessage, false);
  assert.equal(contacts.policies[0].receiver, 'g14-local');
  assert.throws(() => createGrafanaAlertProvisioning({...config, telemetry: {...config.telemetry, releaseDigest: ''}},
    {notificationUrl: 'http://alert-sink:9091/alerts'}), /service_version/u);
  const synthetic = createAlertDefinitions({config, readinessServices: ['g14-synthetic']});
  assert.match(synthetic[0].query, /service_name=~"\^\(g14-synthetic\)\$"/u);
  assert.doesNotMatch(synthetic[0].query, /and on\(\)/u);
  assert.deepEqual(synthetic.slice(1).map(rule => rule.name), definitions.slice(1).map(rule => rule.name));
  for (const readinessServices of [[], ['g14-synthetic', 'g14-synthetic'], ['bad|owner']])
    assert.throws(() => createAlertDefinitions({config, readinessServices}), /readinessServices/u);
});

void test('Grafana webhook stores bounded sanitized firing and resolved episodes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coffee-alert-sink-'));
  const outputPath = path.join(dir, 'episodes.jsonl');
  const server = createAlertSink({outputPath, maxBytes: 1024, maxFiles: 3});
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/alerts`;
    const alert = {status: 'firing', fingerprint: '0123456789abcdef', startsAt: '2026-10-29T00:00:00Z',
      labels: {alertname: 'g14-v1-service-not-ready', secret: 'canary-secret'}, annotations: {payload: 'canary-secret'}};
    const send = alerts => fetch(url, {method: 'POST', body: JSON.stringify({alerts, secret: 'canary-secret'})});
    assert.equal((await send([alert])).status, 200);
    assert.equal((await send([{...alert, status: 'resolved'}])).status, 200);
    let lines = (await readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(value => value.status), ['firing', 'resolved']);
    assert.equal(lines[0].episodeId, lines[1].episodeId);
    assert.equal(lines[0].name, 'g14-v1-service-not-ready');
    assert.doesNotMatch(JSON.stringify(lines), /canary-secret/u);
    assert.equal((await send([{...alert, labels: {alertname: 'canary-secret'}}])).status, 400);
    assert.equal((await send([{...alert, fingerprint: 'canary-secret'}])).status, 400);
    assert.equal((await send(Array.from({length: 33}, () => alert))).status, 400);
    for (let index = 0; index < 30; index++) assert.equal((await send([alert])).status, 200);
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), ['episodes.jsonl', 'episodes.jsonl.1', 'episodes.jsonl.2']);
    for (const file of files) {
      assert.ok((await stat(path.join(dir, file))).size <= 1024);
      assert.doesNotMatch(await readFile(path.join(dir, file), 'utf8'), /canary-secret/u);
    }
    lines = (await readFile(outputPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(lines.every(value => value.episodeId === '0123456789abcdef:2026-10-29T00:00:00Z'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, {recursive: true, force: true});
  }
});

void test('Grafana backend queries require fresh owner samples and exact traces', async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const timestamp = Math.floor(Date.now() / 1000);
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.pathname === '/api/v1/query_range') {
      assert.match(url.searchParams.get('query'), /^(?:timestamp\()?runtime_http_request_duration_ms_milliseconds_/u);
      return new Response(JSON.stringify({status: 'success', data: {resultType: 'matrix', result: [
        {metric: {service_name: 'orders-service'}, values: [[timestamp, url.searchParams.get('query').startsWith('timestamp(') ? String(timestamp) : '2']]},
      ]}}));
    }
    if (url.pathname === '/api/traces/' + 'a'.repeat(32)) return new Response(JSON.stringify({batches: [
      {resource: {attributes: [{key: 'service.name', value: {stringValue: 'orders-service'}}]}, scopeSpans: [{spans: [{traceId: 'a'.repeat(32), name: 'order'}]}]},
    ]}));
    if (url.pathname === '/loki/api/v1/query_range') return new Response(JSON.stringify({status: 'success', data: {resultType: 'streams', result: [
      {stream: {service_name: 'orders-service'}, values: [[String(BigInt(timestamp) * 1000000000n), JSON.stringify({g14_run_id: 'a'.repeat(32)}), {service_version: 'one'}]]},
    ]}}));
    throw new Error('unexpected query');
  };
  const family = {name: 'runtime_http_request_duration_ms', owners: ['orders-service'], components: ['_count', '_sum', '_bucket']};
  const matches = await waitForOwnedMetricFamilySamples({baseUrl: 'http://prometheus:9090', family, startTimeUs, fetchImpl, timeoutMs: 100, intervalMs: 1});
  assert.equal(matches.length, 3);
  assert.deepEqual(sanitizeRuntimeMetricMatches(family, matches).map(match => match.services), Array(3).fill(['orders-service']));
  const trace = await waitForSameTraceSpans({baseUrl: 'http://tempo:3200', traceId: 'a'.repeat(32), expectedSpanNames: {'orders-service': ['order']}, fetchImpl, timeoutMs: 100});
  assert.deepEqual(trace.spanInventory, {'orders-service': ['order']});
  const logs = await queryLokiLogs({baseUrl: 'http://loki:3100', runId: 'a'.repeat(32), startTimeUs, fetchImpl});
  assert.equal(logs[0].service_version, 'one');
  assert.equal(logs[0].g14_run_id, 'a'.repeat(32));
  assert.equal(calls.length, 8);
  await assert.rejects(queryPrometheusRange({baseUrl: 'http://prometheus:9090', expression: 'x', startTimeUs,
    fetchImpl: async () => new Response(JSON.stringify({status: 'error'}))}), /invalid range response/u);
  await assert.rejects(waitForSameTraceSpans({baseUrl: 'http://tempo:3200', traceId: 'a'.repeat(32), expectedSpanNames: {'orders-service': ['missing']}, fetchImpl, timeoutMs: 2, intervalMs: 1}), /did not complete/u);
});

void test('convergence proof accepts both actual recovery metric values and rejects another owner', async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const expectedMetrics = [{name: 'coffee_aroma_unknown_outcomes_current', values: [1, 0]}];
  const response = owner => async url => new Response(JSON.stringify({status: 'success', data: {resultType: 'matrix', result: [
    {metric: {service_name: owner}, values: url.searchParams.get('query').startsWith('timestamp(') ? [[now - 1, String(now - 1)], [now, String(now)]] : [[now - 1, '1'], [now, '0']]},
  ]}}));
  const result = await waitForConvergenceMetricSamples({baseUrl: 'http://prometheus:9090', startTimeUs, expectedMetrics, fetchImpl: response('aroma-convergence'), timeoutMs: 100});
  assert.deepEqual(result.coffee_aroma_unknown_outcomes_current.observedValues, [1, 0]);
  await assert.rejects(waitForConvergenceMetricSamples({baseUrl: 'http://prometheus:9090', startTimeUs, expectedMetrics, fetchImpl: response('other'), timeoutMs: 2, intervalMs: 1}), /did not complete/u);
});

void test('Prometheus evaluation time cannot make an old source sample fresh', async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async url => new Response(JSON.stringify({status: 'success', data: {resultType: 'matrix', result: [
    {metric: {service_name: 'orders-service'}, values: [[now, url.searchParams.get('query').startsWith('timestamp(') ? String(now - 60) : '1']]},
  ]}}));
  assert.deepEqual(await queryPrometheusRange({baseUrl: 'http://prometheus:9090', expression: 'runtime_ready', startTimeUs, fetchImpl}), []);
  await assert.rejects(waitForOwnedMetricFamilySamples({baseUrl: 'http://prometheus:9090', startTimeUs, fetchImpl,
    family: {name: 'runtime_ready', owners: ['orders-service'], components: ['']}, timeoutMs: 2, intervalMs: 1}), /did not complete/u);
});

void test('alert episode evidence includes bounded rotated files in order', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coffee-alert-evidence-'));
  const file = path.join(dir, 'events.jsonl');
  try {
    await writeFile(`${file}.1`, JSON.stringify({name: 'rule', status: 'firing', episodeId: 'same'}) + '\n');
    await writeFile(file, JSON.stringify({name: 'rule', status: 'resolved', episodeId: 'same'}) + '\n');
    assert.deepEqual((await readSinkEvents(file)).map(({status}) => status), ['firing', 'resolved']);
  } finally {await rm(dir, {recursive: true, force: true});}
});

void test('backend query errors omit response body and preserve bounded abort signal', async () => {
  await assert.rejects(queryPrometheusRange({baseUrl: 'http://prometheus:9090', expression: 'runtime_ready',
    startTimeUs: (Date.now() - 10000) * 1000, fetchImpl: async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      return new Response('secret canary', {status: 503});
    }}), error => error.httpStatus === 503 && !error.message.includes('secret'));
});

void test('Alloy blackbox probe attribution uses the actual probe owner', async () => {
  const startTimeUs = (Date.now() - 10000) * 1000;
  const now = Math.floor(Date.now() / 1000);
  const fetchImpl = async url => new Response(JSON.stringify({status: 'success', data: {resultType: 'matrix', result: [{
    metric: {service_name: 'otel-collector', probe_owner: 'edge-nginx'},
    values: [[now, url.searchParams.get('query').startsWith('timestamp(') ? String(now) : '1']],
  }]}}));
  const family = {name: 'probe_success', owners: ['edge-nginx'], components: [''], ownerLabel: 'probe_owner',
    attributes: {service_name: 'otel-collector'}};
  const result = await waitForOwnedMetricFamilySamples({baseUrl: 'http://prometheus:9090', family, startTimeUs, fetchImpl, timeoutMs: 100});
  assert.deepEqual(result, [{stream: 'probe_success', sampleCount: 1, services: ['edge-nginx']}]);
});

void test('retention readback compares compound Go durations and rejects malformed values', () => {
  assert.equal(durationMilliseconds('72h0m0s'), 3 * 86400000);
  assert.equal(durationMilliseconds('3d'), 3 * 86400000);
  assert.equal(durationMilliseconds('1m30s'), 90000);
  assert.ok(Number.isNaN(durationMilliseconds('72h trailing')));
  assert.ok(Number.isNaN(durationMilliseconds('')));
});

void test('restoration preserves proof failure and reports both failures without a false pass', async () => {
  const source = await readFile(new URL('../../tools/observability/verify.mjs', import.meta.url), 'utf8');
  const restorations = [
    {name: 'backup', variable: 'backupRestorationError', first: 'fixtureCompose.volumes = originalVolumes;'},
    {name: 'Loki retention', variable: 'lokiRestorationError', first: 'await writeLokiConfig(originalLokiConfig);'},
    {name: 'Prometheus retention', variable: 'prometheusRestorationError', first: 'services.prometheus.command = originalPrometheusCommand;'},
    {name: 'Tempo retention', variable: 'tempoRestorationError', first: 'await writeTempoConfig(originalTempoConfig);'},
  ];
  for (const {name, variable, first} of restorations) {
    const position = source.indexOf(first);
    const start = source.lastIndexOf('} finally {', position);
    const statement = `if (${variable}) throw ${variable};`;
    const end = source.indexOf(statement, position) + statement.length;
    assert.ok(position >= 0 && start >= 0 && end > position);
    for (const [proofFails, restoreFails] of [[false, false], [true, false], [false, true], [true, true]]) {
      const cleanupErrors = [];
      const restore = () => { if (restoreFails) throw new Error('restore failure'); };
      const fixtureCompose = {set volumes(_value) { restore(); }};
      const context = {
        Error, cleanupErrors, cleanError: error => error.message,
        proof: () => { if (proofFails) throw new Error('proof failure'); },
        fixtureCompose, originalVolumes: {}, backendStopStarted: false,
        writeLokiConfig: restore, writeTempoConfig: restore, originalLokiConfig: {}, originalTempoConfig: {},
        recreateBackend() {}, readLokiKnobs: () => ({}), readTempoKnobs: () => ({}),
        originalLokiKnobs: {}, originalTempoKnobs: {}, originalLokiHash: 'same', originalTempoHash: 'same',
        createHash: () => ({update: () => ({digest: () => 'same'})}), readFile: async () => '', backendConfigPaths: {},
        services: {prometheus: {}}, originalPrometheusCommand: [], saveCompose: restore,
        api: async () => ({data: {}}), baseUrls: {}, loadYaml: () => ({services: {prometheus: {command: []}}}),
        composeFile: '', profileFlagNames: [], originalFlags: {}, profileHash: () => 'same',
      };
      const execute = runInNewContext(`(async () => { let ${variable}; try { await proof(); ${source.slice(start, end)} })`, context);
      if (proofFails || restoreFails) {
        await assert.rejects(execute(), error => error.message === (proofFails ? 'proof failure' : 'restore failure'), name);
      } else await execute();
      assert.deepEqual(cleanupErrors, restoreFails ? [`${name} restore: restore failure`] : [], name);
      if (restoreFails) assert.equal(observabilityGateComplete({cleanupErrors}), false, name);
    }
  }
});

void test('G14 cannot pass with a missing or incomplete required phase', () => {
  const pass = {status: 'PASS'};
  const evidence = {cleanupErrors: [], phases: Object.fromEntries(['startup', 'signals', 'alerts', 'outage', 'persistence',
    'backupRestore', 'runtimeMatrix', 'memory', 'retention', 'launchPath', 'diskRecovery'].map(name => [name, 'PASS'])),
    alertTransitions: 'PASS', launchPathCorrelation: 'PASS', nativeNginxAlert: pass, redactionScan: pass,
    networkIsolation: {status: 'PASS', launchPathNetworkStatus: 'PASS'},
    telemetryHealth: {dockerLogRotation: pass, producerLoggingPolicy: pass, collectorLoggingPolicy: pass,
      launchPathCollectorConfig: 'PASS', launchPathOutageStatus: 'PASS', collectorMemoryProof: pass},
    collectorQueueMetrics: pass, processCounterRestart: pass, diskPressureStatus: 'PASS', runtimeShutdownStatus: 'PASS'};
  assert.equal(observabilityGateComplete(evidence), true);
  delete evidence.phases.backupRestore;
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.backupRestore = 'PASS';
  delete evidence.phases.retention;
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.retention = 'PARTIAL';
  assert.equal(observabilityGateComplete(evidence), false);
  evidence.phases.retention = 'PASS';
  evidence.cleanupErrors.push('cleanup failed');
  assert.equal(observabilityGateComplete(evidence), false);
});

void test('Alloy refusal counter can be absent only before a verified first refusal', async () => {
  const now = Math.floor(Date.now() / 1000);
  const state = {StartedAt: new Date((now - 20) * 1000).toISOString(), Running: true, OOMKilled: false};
  const generation = {id: 'collector-id', state};
  const run = args => args[0] === 'exec' ? '' : args[2] === '{{.Id}}' ? generation.id : JSON.stringify(state);
  const fetchImpl = async url => {
    const expression = url.searchParams.get('query');
    const absent = expression.includes('refused_spans');
    const value = expression.startsWith('timestamp(') ? String(now) : '1';
    return new Response(JSON.stringify({status: 'success', data: {resultType: 'matrix', result: absent ? [] : [
      {metric: {service_name: 'otel-collector', component_id: 'otelcol.processor.memory_limiter.main'}, values: [[now, value]]},
    ]}}));
  };
  const options = {baseUrl: 'http://prometheus:9090', config: {platform: {health: {timeoutMs: 1000}},
    telemetry: {collector: {healthEndpoint: 'http://otel-collector:13133'}}}, run, name: 'collector-id', generation, fetchImpl};
  const baseline = await collectorMemorySelfTelemetry({...options, allowUnmaterializedRefused: true});
  assert.equal(baseline.counters.accepted, 1);
  assert.equal(baseline.counters.refused, 0);
  assert.equal(baseline.refusedNotMaterialized, true);
  await assert.rejects(collectorMemorySelfTelemetry(options), /refused counter unavailable/u);
  await assert.rejects(collectorMemorySelfTelemetry({...options, allowUnmaterializedRefused: true,
    generation: {id: 'different', state}}), /crossed a process generation/u);
});

void test('Alloy queue evidence uses matching component and signal', () => {
  assert.equal(isExporterMetricForSignal({component_id: 'otelcol.exporter.otlphttp.metrics', data_type: 'metrics'}, 'otelcol_exporter_queue_size'), true);
  assert.equal(isExporterMetricForSignal({component_id: 'otelcol.exporter.otlphttp.metrics', data_type: 'logs'}, 'otelcol_exporter_queue_size'), false);
  assert.equal(isExporterMetricForSignal({component_id: 'otelcol.exporter.otlphttp.logs'}, 'otelcol_exporter_send_failed_log_records'), true);
  assert.equal(isExporterMetricForSignal({component_id: 'otelcol.exporter.otlphttp.metrics'}, 'otelcol_exporter_send_failed_log_records'), false);
  assert.equal(isExporterMetricForSignal({component_id: 'otelcol.exporter.otlphttp.metrics'}, 'otelcol_exporter_queue_size'), false);
});

void test('Loki native WAL usage is a ratio and requires unambiguous counters', () => {
  assert.deepEqual(parseLokiWalMetrics('loki_ingester_wal_disk_full_failures_total 3\nloki_ingester_wal_disk_usage_percent 0.81\n'),
    {failures: 3, usageRatio: 0.81});
  assert.throws(() => parseLokiWalMetrics('loki_ingester_wal_disk_full_failures_total 3\nloki_ingester_wal_disk_usage_percent 81\n'), /ratio is invalid/u);
  assert.throws(() => parseLokiWalMetrics('loki_ingester_wal_disk_full_failures_total 3\n'), /unavailable or ambiguous/u);
});

void test('Grafana hold windows use the episode start rather than delayed webhook arrival', () => {
  const started = '2026-10-30T10:00:00.000Z';
  assert.equal(alertEpisodeStartMs(`0123456789abcdef:${started}`), Date.parse(started));
  assert.ok(Number.isNaN(alertEpisodeStartMs(`invalid:${started}`)));
});

void test('G14 cannot pass when required evidence cannot be written', async () => {
  const evidence = {status: 'PASS'};
  await persistVerificationResult({root: '/fixture', evidence, secrets: [], persist: async () => { throw new Error('disk full'); }});
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.failure, 'cannot persist evidence: disk full');
  assert.equal(evidence.evidenceDirectory, undefined);
});

void test('Alloy native logfmt retry expiry reports the exact dropped_items field', () => {
  const line = 'level=error msg="Exporting failed. Dropping data." component_id=otelcol.exporter.otlphttp.logs error="no more retries left: connection refused" dropped_items=128';
  assert.deepEqual(parseCollectorExpiredRetryDrops(line), {status: 'PASS', expiredRetryDropEvents: 1, droppedItems: 128});
  assert.deepEqual(parseCollectorExpiredRetryDrops('{"msg":"Exporting failed. Dropping data.","error":"no more retries left","dropped_items":3}'),
    {status: 'PASS', expiredRetryDropEvents: 1, droppedItems: 3});
  assert.throws(() => parseCollectorExpiredRetryDrops(line.replace('dropped_items=128', 'other_dropped_items=128')));
  assert.throws(() => parseCollectorExpiredRetryDrops(line.replace('dropped_items=128', 'dropped_items=128x')));
});
