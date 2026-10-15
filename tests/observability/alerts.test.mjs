import assert from 'node:assert/strict';
import test from 'node:test';
import {createAlertDefinitions, installNativeAlerts} from '../../tools/observability/alerts.mjs';
import {missingCpuFeatures, nativeAccessLogFilter, observabilityVerificationCoverage, sourceIdentity, traceSpanInventory, waitForOwnedMetricFamilySamples} from '../../tools/observability/verify.mjs';
import {runtimeMetricFamilies, sanitizeRuntimeMetricMatches, verifyRuntimeMetricMatrix} from './runtime-matrix.mjs';
import {NODE_RUNTIME_ROLES, summarizeRuntimeProbeOutput} from './runtime-matrix-probe.mjs';

const config = {telemetry: {
  openObserve: {organization: 'coffee', streams: {metrics: 'platform_metrics'}},
  alerts: {
    version: 1, evaluationIntervalMs: 60000,
    notReady: {forMs: 300000, threshold: 0},
    consumerLag: {forMs: 300000, threshold: 0},
    outboxOldestAge: {forMs: 300000, threshold: 0},
    unknownOutcome: {forMs: 120000, threshold: 0},
    sseDropRate: {forMs: 300000, threshold: 0.05},
  },
}};

void test('OpenObserve runner gates native execution on required CPU features', () => {
  assert.deepEqual(missingCpuFeatures('processor: 0\nflags: sse4_2 aes avx2 avx\n'), []);
  assert.deepEqual(missingCpuFeatures('processor: 0\nflags: sse4_2\n'), ['avx', 'aes']);
});

void test('OpenObserve trace inventory reads canonical operation_name and deduplicates per owner', () => {
  const traceId = 'a'.repeat(32);
  assert.deepEqual(traceSpanInventory([
    {service_name: 'orders-service', operation_name: 'HTTP POST', trace_id: traceId},
    {service_name: 'orders-service', operation_name: 'HTTP POST', trace_id: traceId},
    {service_name: 'realtime-gateway', operation_name: 'HTTP POST', trace_id: traceId},
    {service_name: 'orders-service', name: 'ignored name', trace_id: traceId},
    {service_name: 'orders-service', span_name: 'ignored span_name', trace_id: traceId},
    {service_name: '', operation_name: 'empty owner', trace_id: traceId},
    {service_name: 'orders-service', operation_name: '', trace_id: traceId},
  ]), {
    'orders-service': ['HTTP POST'],
    'realtime-gateway': ['HTTP POST'],
  });
});

void test('native access lookup selects its owner before the response page limit', () => {
  const correlationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(nativeAccessLogFilter(correlationId), `"service_name" = 'edge-nginx' AND "body_correlation_id" = '${correlationId}'`);
  assert.throws(() => nativeAccessLogFilter("' OR 1=1"), /requires a UUID/u);
});

void test('owner metric search waits for every owner and histogram component after the 100-row page filter', async () => {
  const base = 'platform_metrics_runtime_http_request_duration_ms';
  const components = ['_count', '_sum', '_bucket'];
  let inventoryCalls = 0;
  const ownerSearches = new Map();
  let query;
  const unrelated = Array.from({length: 101}, (_, index) => ({service_name: `other-${index}`, value: index}));
  const fetchImpl = async (url, init) => {
    if (url.pathname === '/api/coffee/streams') {
      inventoryCalls += 1;
      return new Response(JSON.stringify(inventoryCalls === 1 ? [] : components.map(component => ({stream_type: 'metrics', name: `${base}${component}`}))), {status: 200});
    }
    query = JSON.parse(init.body).query;
    const stream = query.sql.match(/FROM "([^"]+)"/u)?.[1];
    const ownerFilter = query.sql.match(/WHERE "service_name" = '((?:[^']|'')*)'/u)?.[1]?.replaceAll("''", "'");
    const key = `${stream}:${ownerFilter}`;
    const searches = (ownerSearches.get(key) ?? 0) + 1;
    ownerSearches.set(key, searches);
    assert.ok(query.sql.includes('AND "http_response_status_class" = \'4xx\''));
    const hits = ['orders-service', 'api-public'].includes(ownerFilter)
      ? stream === `${base}_bucket` && ownerFilter === 'api-public' && searches < 3 ? [] : [{service_name: ownerFilter, value: 7}]
      : unrelated.slice(0, query.size);
    return new Response(JSON.stringify({hits: {hits}}), {status: 200});
  };
  const matches = await waitForOwnedMetricFamilySamples({
    baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
    metricsPrefix: 'platform_metrics', family: {name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components, attributes: {http_response_status_class: '4xx'}},
    liveMetricStreams: [], startTimeUs: 1, fetchImpl, timeoutMs: 5000, intervalMs: 1,
  });
  assert.equal(inventoryCalls, 4, 'inventory refresh repeats until the final owner component becomes visible');
  assert.equal(ownerSearches.get(`${base}_bucket:api-public`), 3, 'one missing component must keep the whole family pending');
  assert.deepEqual(matches, components.map(component => ({stream: `${base}${component}`, sampleCount: 2, services: ['orders-service', 'api-public']})));
  assert.equal(query.sql, `SELECT * FROM "${base}_bucket" WHERE "service_name" = 'api-public' AND "http_response_status_class" = '4xx'`);
  assert.equal(query.size, 100);
});

void test('issue 64 metric matrix derives all runtime owners and sanitizes probe receipts', () => {
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
    {stream: 'platform_metrics_runtime_http_request_duration_ms_count', sampleCount: 14, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_sum', sampleCount: 14, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_bucket', sampleCount: 42, services: [...NODE_RUNTIME_ROLES], labels: {secret: 'discard'}},
  ], 'platform_metrics'), [
    {stream: 'platform_metrics_runtime_http_request_duration_ms_bucket', sampleCount: 42, services: [...NODE_RUNTIME_ROLES].sort()},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_count', sampleCount: 14, services: [...NODE_RUNTIME_ROLES].sort()},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_sum', sampleCount: 14, services: [...NODE_RUNTIME_ROLES].sort()},
  ]);
  assert.throws(() => sanitizeRuntimeMetricMatches(httpDuration, [], 'platform_metrics'), /components incomplete/u);
  assert.throws(() => sanitizeRuntimeMetricMatches(httpDuration, [
    {stream: 'platform_metrics_runtime_http_request_duration_ms_count', sampleCount: 1, services: ['other-runtime']},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_sum', sampleCount: 1, services: [...NODE_RUNTIME_ROLES]},
    {stream: 'platform_metrics_runtime_http_request_duration_ms_bucket', sampleCount: 1, services: [...NODE_RUNTIME_ROLES]},
  ], 'platform_metrics'), /owner evidence invalid/u);

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

void test('issue 64 metric matrix requires a source identity callback before any Docker work', async () => {
  const args = {
    projectName: 'coffee-issue64-final-aaaaaaaa', exporterToken: 'fixture-token',
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

void test('issue 64 evidence distinguishes selected live roles from full 14-runtime G14 coverage', () => {
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
  assert.equal(coverage.verificationScope, 'issue-64-operations-predecessor');
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

void test('native alert definitions use versioned OpenObserve metrics and configured windows', () => {
  const definitions = createAlertDefinitions({config});
  assert.deepEqual(definitions.map(({key, pendingPeriodSec, threshold}) => [key, pendingPeriodSec, threshold]), [
    ['notReady', 300, 0], ['consumerLag', 300, 0], ['outboxOldestAge', 300, 0], ['unknownOutcome', 120, 0], ['sseDropRate', 300, 0.05],
  ]);
  assert.ok(definitions.every(rule => rule.name.startsWith('g14-v1-') && rule.queryCondition.type === 'promql'));
  assert.equal(definitions.find(rule => rule.key === 'notReady').streamName, 'platform_metrics_runtime_ready');
  assert.equal(definitions.find(rule => rule.key === 'notReady').queryCondition.promql, 'min(platform_metrics_runtime_ready)');
  assert.deepEqual(definitions.find(rule => rule.key === 'notReady').queryCondition.promql_condition, {column: 'value', operator: '<=', value: 0});
  assert.equal(definitions.find(rule => rule.key === 'consumerLag').streamName, 'platform_metrics_messaging_kafka_consumer_lag');
  assert.equal(definitions.find(rule => rule.key === 'outboxOldestAge').streamName, 'platform_metrics_messaging_outbox_oldest_unpublished_age');
  assert.equal(definitions.find(rule => rule.key === 'unknownOutcome').streamName, 'platform_metrics_coffee_aroma_unknown_outcomes_current');
  assert.equal(definitions.find(rule => rule.key === 'sseDropRate').streamName, 'platform_metrics_coffee_realtime_invalidation_dropped_total');
  assert.equal(new Set(definitions.map(rule => rule.streamName)).size, definitions.length);
  const ssePromql = definitions.find(rule => rule.key === 'sseDropRate').queryCondition.promql;
  assert.match(ssePromql, /rate\(platform_metrics_coffee_realtime_invalidation_dropped_total\[300s\]\).*rate\(platform_metrics_coffee_realtime_invalidation_attempts_total\[300s\]\)/u);
  assert.match(ssePromql, /clamp_min\(sum\(rate\(platform_metrics_coffee_realtime_invalidation_attempts_total\[300s\]\)\), 1e-12\)/u);
  assert.doesNotMatch(ssePromql, /,\s*1\)/u);
  assert.equal((1 / 100) / (2 / 100), 0.5);
  assert.equal((1 / 100) / Math.max(2 / 100, 1), 0.01, 'a whole-unit denominator floor would hide the 50% low-rate drop ratio');
  assert.ok(definitions.every(rule => !JSON.stringify(rule).includes('g14_run_id') && !JSON.stringify(rule).includes('platform_logs')));
});

void test('native alert installation configures only local webhook delivery and recovery', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({url: new URL(url).pathname, init, body: init.body ? JSON.parse(init.body) : undefined});
    return new Response('', {status: 200});
  };
  const rules = await installNativeAlerts({config, baseUrl: 'http://127.0.0.1:5080', organization: 'coffee', authorization: 'Basic fixture', fetchImpl});
  assert.equal(rules.length, 5);
  assert.equal(requests.length, 7);
  assert.equal(requests[1].body.url, 'http://127.0.0.1:9091/alerts');
  for (const request of requests.slice(2)) {
    assert.equal(request.url, '/api/v2/coffee/alerts');
    assert.equal(request.body.is_real_time, false);
    assert.equal(request.body.stream_type, 'metrics');
    assert.equal(request.body.query_condition.type, 'promql');
    assert.equal(request.body.enabled, true);
    assert.equal(request.body.trigger_condition.period, config.telemetry.alerts.evaluationIntervalMs / 60000);
    assert.equal(request.body.trigger_condition.frequency, config.telemetry.alerts.evaluationIntervalMs / 60000);
    assert.deepEqual(request.body.destinations, ['g14-local']);
    assert.equal(request.body.notify_on_recovery, true);
    assert.deepEqual(request.body.recovery_destinations, ['g14-local']);
  }
  assert.equal(requests.at(-1).body.pending_period_sec, 300);
  assert.equal(requests.at(-1).body.trigger_condition.threshold, 1);
  assert.deepEqual(requests.at(-1).body.query_condition.promql_condition, {column: 'value', operator: '>', value: 0.05});
});
