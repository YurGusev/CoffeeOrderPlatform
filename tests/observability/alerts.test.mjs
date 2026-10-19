import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {awaitConvergenceMetricBarrier} from './launch-path.mjs';
import {createAlertDefinitions, installNativeAlert, installNativeAlerts} from '../../tools/observability/alerts.mjs';
import {OBSERVABILITY_TARGETS} from '../../tools/observability/generate.mjs';
import {missingCpuFeatures, nativeAccessLogFilter, observabilityVerificationCoverage, parseCollectorMemoryLimiterMetrics, isCollectorMemoryRefusal, readinessMetricSamples, sourceIdentity, stopContainerGracefully, traceSpanInventory, validateCollectorMemorySample, waitForOwnedMetricFamilySamples, waitForConvergenceMetricSamples, waitForStreamRetentionSettings} from '../../tools/observability/verify.mjs';
import {nodeImageProbe, runtimeMetricFamilies, sanitizeRuntimeMatrixFailure, sanitizeRuntimeMetricMatches, verifyRuntimeMetricMatrix} from './runtime-matrix.mjs';
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

void test('native readiness reads every fresh owner in one bounded, newest-first search', async () => {
  const services = OBSERVABILITY_TARGETS.filter(service => service !== 'edge-nginx');
  const afterUs = 1_700_000_000_000_000;
  const samplesPerOwner = 60;
  const records = services.flatMap(service => Array.from({length: samplesPerOwner}, (_, index) => ({
    service_name: service, value: index === 0 ? 0 : 1, _timestamp: afterUs + index + 1,
  }))).sort((left, right) => right._timestamp - left._timestamp);
  assert.equal(services.length, 14);
  assert.equal(records.length, services.length * samplesPerOwner);
  assert.ok(records.every((record, index) => index === 0 || records[index - 1]._timestamp >= record._timestamp),
    'the 840 in-window fixture samples are ordered newest first');
  const observe = async returnedRecords => {
    let calls = 0;
    let query;
    const samples = await readinessMetricSamples({
      baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
      stream: 'platform_metrics_runtime_ready', services, afterUs,
      fetchImpl: async (url, init) => {
        calls += 1;
        query = JSON.parse(init.body).query;
        return new Response(JSON.stringify({hits: {hits: returnedRecords}}), {status: 200});
      },
    });
    assert.equal(calls, 1, 'one poll sends one search for the whole owner set');
    assert.equal(query.sql, `SELECT * FROM "platform_metrics_runtime_ready" WHERE "service_name" IN (${services.map(service => `'${service}'`).join(', ')}) ORDER BY "_timestamp" DESC`);
    assert.equal(query.size, 1000);
    assert.equal(query.start_time, afterUs);
    assert.equal(query.from, 0);
    return samples;
  };

  const ready = await observe(records);
  assert.equal(ready.length, services.length);
  assert.ok(ready.every(({sample}) => sample?.value === 1 && sample.timestampUs === afterUs + samplesPerOwner),
    'each owner resolves to its newest value=1 sample after the oldest value=0 sample');

  const missing = services.at(-1);
  for (const invalidRecords of [
    records.filter(record => record.service_name !== missing),
    records.map(record => record.service_name === missing ? {...record, _timestamp: afterUs} : record),
    records.map(record => record.service_name === missing ? {...record, service_name: 'unexpected-owner'} : record),
  ]) {
    const samples = await observe(invalidRecords);
    assert.equal(samples.length, services.length);
    assert.equal(samples.every(({sample}) => sample?.value === 1), false,
      'missing, stale, or unexpected-owner evidence must not satisfy readiness');
  }
});

void test('OpenObserve retention settings wait only for stream-settings 404 readiness', {timeout: 10000}, async t => {
  t.mock.timers.enable({apis: ['Date'], now: 0});
  const requests = [];
  const fetchImpl = async (url, init) => {
    t.mock.timers.tick(1);
    requests.push({url, init});
    return new Response(requests.length === 1 ? 'temporary canary response' : '', {status: requests.length === 1 ? 404 : 200});
  };
  await waitForStreamRetentionSettings({baseUrl: 'http://openobserve.test', authorization: 'Basic fixture',
    organization: 'coffee', stream: 'platform_metrics_runtime_http_requests_total', streamType: 'metrics',
    retentionDays: 7, fetchImpl, sensitiveValues: ['temporary canary response'], timeoutMs: 100, intervalMs: 1});
  assert.equal(requests.length, 2, 'a stream-settings 404 is retried until the settings endpoint is ready');
  for (const {url, init} of requests) {
    assert.equal(url.pathname, '/api/coffee/streams/platform_metrics_runtime_http_requests_total/settings');
    assert.equal(url.searchParams.get('type'), 'metrics');
    assert.equal(init.method, 'PUT');
    assert.equal(init.headers.Authorization, 'Basic fixture');
    assert.deepEqual(JSON.parse(init.body), {data_retention: 7});
  }

  let permanent404Calls = 0;
  let timeoutFailure;
  try {
    await waitForStreamRetentionSettings({baseUrl: 'http://openobserve.test', authorization: 'Basic fixture',
      organization: 'coffee', stream: 'platform_metrics_missing', streamType: 'metrics', retentionDays: 7,
      fetchImpl: async () => {permanent404Calls += 1; t.mock.timers.tick(10); return new Response('permanent canary', {status: 404});},
      sensitiveValues: ['permanent canary'], timeoutMs: 5, intervalMs: 1});
  } catch (error) { timeoutFailure = error; }
  assert.ok(timeoutFailure, 'a permanent 404 must fail after the bounded readiness deadline');
  assert.equal(permanent404Calls, 1);
  assert.match(timeoutFailure.message, /did not complete/u);
  assert.equal(timeoutFailure.message.includes('permanent canary'), false);

  for (const status of [401, 500]) {
    let calls = 0;
    let failure;
    try {
      await waitForStreamRetentionSettings({baseUrl: 'http://openobserve.test', authorization: 'Basic fixture',
        organization: 'coffee', stream: 'platform_metrics_denied', streamType: 'metrics', retentionDays: 7,
        fetchImpl: async () => {calls += 1; t.mock.timers.tick(1); return new Response('auth canary', {status});},
        sensitiveValues: ['auth canary'], timeoutMs: 100, intervalMs: 1});
    } catch (error) { failure = error; }
    assert.equal(calls, 1, `HTTP ${status} fails immediately`);
    assert.equal(failure?.httpStatus, status);
    assert.equal(failure?.fatal, true);
    assert.equal(failure?.message.includes('auth canary'), false);
  }

  let networkCalls = 0;
  let networkFailure;
  try {
    await waitForStreamRetentionSettings({baseUrl: 'http://openobserve.test', authorization: 'Basic fixture',
      organization: 'coffee', stream: 'platform_metrics_offline', streamType: 'metrics', retentionDays: 7,
      fetchImpl: async () => {networkCalls += 1; t.mock.timers.tick(1); throw new Error('network unavailable');}, timeoutMs: 100, intervalMs: 1});
  } catch (error) { networkFailure = error; }
  assert.equal(networkCalls, 1, 'network failures are fatal rather than retried');
  assert.equal(networkFailure?.fatal, true);
  assert.match(networkFailure?.message ?? '', /network unavailable/u);
});

void test('owner metric search groups all expected owners before the 100-row page limit and waits for every histogram component', async () => {
  const base = 'platform_metrics_runtime_http_request_duration_ms';
  const components = ['_count', '_sum', '_bucket'];
  let inventoryCalls = 0;
  const componentSearches = new Map();
  let query;
  const unrelated = Array.from({length: 101}, (_, index) => ({service_name: `other-${index}`, value: index}));
  const fetchImpl = async (url, init) => {
    if (url.pathname === '/api/coffee/streams') {
      inventoryCalls += 1;
      return new Response(JSON.stringify(inventoryCalls === 1 ? [] : components.map(component => ({stream_type: 'metrics', name: `${base}${component}`}))), {status: 200});
    }
    query = JSON.parse(init.body).query;
    const stream = query.sql.match(/FROM "([^"]+)"/u)?.[1];
    const searches = (componentSearches.get(stream) ?? 0) + 1;
    componentSearches.set(stream, searches);
    assert.match(query.sql, /WHERE "service_name" IN \('orders-service', 'api-public'\) AND "http_response_status_class" = '4xx' GROUP BY "service_name"$/u);
    assert.equal(query.size, 100, 'grouped owner evidence uses the existing 100-row search bound');
    assert.equal(query.start_time, 1);
    assert.ok(Number.isSafeInteger(query.end_time));
    assert.equal(query.from, 0);
    assert.ok(query.sql.includes('AND "http_response_status_class" = \'4xx\''));
    const allowed = new Set(['orders-service', 'api-public']);
    const records = [...unrelated, ...[...allowed].map(service_name => ({service_name, http_response_status_class: '4xx'}))];
    const filtered = records.filter(record => allowed.has(record.service_name) && record.http_response_status_class === '4xx');
    const hits = [...new Set(filtered.map(record => record.service_name))]
      .filter(owner => !(stream === `${base}_bucket` && owner === 'api-public' && searches < 3))
      .map(service_name => ({service_name, sample_count: filtered.filter(record => record.service_name === service_name).length}));
    return new Response(JSON.stringify({hits: {hits}}), {status: 200});
  };
  const matches = await waitForOwnedMetricFamilySamples({
    baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
    metricsPrefix: 'platform_metrics', family: {name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components, attributes: {http_response_status_class: '4xx'}},
    liveMetricStreams: [], startTimeUs: 1, fetchImpl, timeoutMs: 5000, intervalMs: 1,
  });
  assert.equal(inventoryCalls, 4, 'inventory refresh repeats until the final owner component becomes visible');
  assert.equal(componentSearches.get(`${base}_bucket`), 3, 'one missing owner group must keep the whole family pending');
  assert.deepEqual(matches, components.map(component => ({stream: `${base}${component}`, sampleCount: 2, services: ['orders-service', 'api-public']})));
  assert.equal(query.sql, `SELECT "service_name", COUNT(*) AS sample_count FROM "${base}_bucket" WHERE "service_name" IN ('orders-service', 'api-public') AND "http_response_status_class" = '4xx' GROUP BY "service_name"`);
  assert.equal(query.size, 100);

  const secret = 'query-secret-must-not-escape';
  const failureFetch = async (url, init) => {
    if (url.pathname === '/api/coffee/streams') return new Response(JSON.stringify(components.map(component => ({stream_type: 'metrics', name: `${base}${component}`}))));
    const failingQuery = JSON.parse(init.body).query;
    const stream = failingQuery.sql.match(/FROM "([^"]+)"/u)?.[1];
    if (stream === `${base}_bucket`) return new Response(secret, {status: 503});
    return new Response(JSON.stringify({hits: {hits: ['orders-service', 'api-public'].map(service_name => ({service_name, sample_count: 1}))}}));
  };
  let failure;
  try {
    await waitForOwnedMetricFamilySamples({
      baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
      metricsPrefix: 'platform_metrics', family: {name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components},
      liveMetricStreams: components.map(component => `${base}${component}`), startTimeUs: 1,
      fetchImpl: failureFetch, timeoutMs: 20, intervalMs: 1,
    });
  } catch (error) { failure = error; }
  assert.ok(failure, 'the incomplete owner bucket must remain pending until timeout');
  const diagnostics = sanitizeRuntimeMatrixFailure(failure).metricFamilyObservation;
  assert.deepEqual(diagnostics.components.find(component => component.component === '_bucket'), {
    component: '_bucket', streamPresent: true, presentOwners: [], missingOwners: ['orders-service', 'api-public'],
    sampleCount: 0, queryFailure: {outcome: 'QUERY_FAILED', httpStatus: 503, errorClass: 'Error'},
  });
  assert.equal(JSON.stringify(diagnostics).includes(secret), false);
  assert.equal(JSON.stringify(sanitizeRuntimeMatrixFailure(failure)).includes(secret), false);

  const timeoutFetch = async (url, init) => {
    if (url.pathname === '/api/coffee/streams') return new Response(JSON.stringify(components.map(component => ({stream_type: 'metrics', name: `${base}${component}`}))));
    const stream = JSON.parse(init.body).query.sql.match(/FROM "([^"]+)"/u)?.[1];
    if (stream === `${base}_bucket`) throw new DOMException(secret, 'TimeoutError');
    return new Response(JSON.stringify({hits: {hits: ['orders-service', 'api-public'].map(service_name => ({service_name, sample_count: 1}))}}));
  };
  let timeoutFailure;
  try {
    await waitForOwnedMetricFamilySamples({
      baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
      metricsPrefix: 'platform_metrics', family: {name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components},
      liveMetricStreams: components.map(component => `${base}${component}`), startTimeUs: 1,
      fetchImpl: timeoutFetch, timeoutMs: 20, intervalMs: 1,
    });
  } catch (error) { timeoutFailure = error; }
  assert.ok(timeoutFailure, 'query timeout must remain a failed observation');
  assert.deepEqual(sanitizeRuntimeMatrixFailure(timeoutFailure).metricFamilyObservation.components[2].queryFailure,
    {outcome: 'QUERY_FAILED', errorClass: 'TimeoutError'});
  assert.equal(JSON.stringify(sanitizeRuntimeMatrixFailure(timeoutFailure)).includes(secret), false);

  const invalidGroups = [
    [{service_name: 'unexpected-owner', sample_count: 1}],
    [{service_name: 'orders-service', sample_count: 1}, {service_name: 'orders-service', sample_count: 1}],
    [{service_name: 'orders-service', sample_count: 0}],
    ['orders-service', 'api-public'].map(service_name => ({service_name, sample_count: Number.MAX_SAFE_INTEGER})),
  ];
  for (const groups of invalidGroups) {
    const invalidFetch = async (url, init) => {
      if (url.pathname === '/api/coffee/streams') return new Response(JSON.stringify(components.map(component => ({stream_type: 'metrics', name: `${base}${component}`}))));
      const stream = JSON.parse(init.body).query.sql.match(/FROM "([^"]+)"/u)?.[1];
      return new Response(JSON.stringify({hits: {hits: stream === `${base}_count` ? groups : []}}));
    };
    let invalidFailure;
    try {
      await waitForOwnedMetricFamilySamples({
        baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee',
        metricsPrefix: 'platform_metrics', family: {name: 'runtime_http_request_duration_ms', owners: ['orders-service', 'api-public'], components},
        liveMetricStreams: components.map(component => `${base}${component}`), startTimeUs: 1,
        fetchImpl: invalidFetch, timeoutMs: 1, intervalMs: 1,
      });
    } catch (error) { invalidFailure = error; }
    assert.ok(invalidFailure, 'invalid grouped owner evidence must not satisfy the family gate');
    const invalidDiagnostics = sanitizeRuntimeMatrixFailure(invalidFailure).metricFamilyObservation;
    assert.deepEqual(invalidDiagnostics.components[0], {
      component: '_count', streamPresent: true, presentOwners: [], missingOwners: ['orders-service', 'api-public'],
      sampleCount: 0, queryFailure: {outcome: 'QUERY_FAILED', errorClass: 'Error'},
    });
  }
});

void test('convergence backend acknowledgement waits for both gauge phases and recovered owner result', async () => {
  const expectedMetrics = [
    {name: 'coffee_aroma_unknown_outcomes_current', attributes: {}, values: [1, 0]},
    {name: 'coffee_aroma_recovery_results_total', attributes: {result: 'recovered_applied'}, value: 1},
  ];
  let polls = 0;
  const observations = [];
  const fetchImpl = async (url, init) => {
    if (url.pathname.endsWith('/streams')) {
      polls += 1;
      return new Response(JSON.stringify(expectedMetrics.map(metric => ({stream_type: 'metrics', name: `platform_metrics_${metric.name}`}))));
    }
    const query = JSON.parse(init.body).query;
    assert.ok(query.sql.includes('"service_name" = \'aroma-convergence\''));
    const current = query.sql.includes('unknown_outcomes_current');
    const samples = current
      ? [{value: 1}, ...(polls >= 2 ? [{value: 0}] : [])]
      : [{value: polls >= 3 ? 1 : 0, attributes_result: 'recovered_applied'}, {value: 1, attributes_result: 'other'}];
    return new Response(JSON.stringify({hits: {hits: samples.map(sample => ({service_name: 'aroma-convergence', _timestamp: 1700000000000000, ...sample}))}}));
  };
  const result = await waitForConvergenceMetricSamples({
    baseUrl: 'http://openobserve.test', authorization: 'Basic fixture', organization: 'coffee', metricsPrefix: 'platform_metrics',
    expectedMetrics, startTimeUs: 1, fetchImpl, timeoutMs: 1000, intervalMs: 1,
    onObservation: value => observations.push(value),
  });
  assert.equal(polls, 3);
  assert.deepEqual(observations[0].coffee_aroma_unknown_outcomes_current.missingValues, [0]);
  assert.deepEqual(observations[1].coffee_aroma_recovery_results_total.missingValues, [1]);
  assert.deepEqual(result.coffee_aroma_unknown_outcomes_current.observedValues, [1, 0]);
  assert.deepEqual(result.coffee_aroma_recovery_results_total.observedValues, [1]);
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

void test('issue 64 failure diagnostics retain only allowlisted error codes and local frame coordinates', () => {
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
  const forced = stopContainerGracefully({run, name: 'openobserve-fixture', graceMs: 30000});
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
    ['stop', '--time', '30', 'openobserve-fixture'],
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
  const readinessServices = OBSERVABILITY_TARGETS.filter(service => service !== 'edge-nginx');
  const readinessOwnerFilter = `^(${readinessServices.join('|')})$`;
  assert.equal(definitions.find(rule => rule.key === 'notReady').queryCondition.promql,
    `(min(platform_metrics_runtime_ready{service_name=~"${readinessOwnerFilter}"} or platform_metrics_httpcheck_status{service_name="edge-nginx",http_status_class="2xx"}) * (scalar(count(count by (service_name) (platform_metrics_runtime_ready{service_name=~"${readinessOwnerFilter}"}))) == bool ${readinessServices.length})) or vector(0)`);
  assert.equal(readinessServices.length, 14);
  assert.match(definitions.find(rule => rule.key === 'notReady').queryCondition.promql, /count by \(service_name\)/u,
    'the readiness gate counts distinct expected runtime owners');
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

void test('synthetic readiness scope is isolated and rejects invalid owner filters', () => {
  const synthetic = createAlertDefinitions({config, readinessServices: ['g14-synthetic']});
  assert.equal(synthetic[0].name, 'g14-v1-service-not-ready-synthetic');
  assert.match(synthetic[0].queryCondition.promql,
    /runtime_ready\{service_name=~"\^\(g14-synthetic\)\$"\}.*== bool 1\)\) or vector\(0\)/u);
  assert.deepEqual(synthetic.slice(1).map(({name}) => name),
    createAlertDefinitions({config}).slice(1).map(({name}) => name));
  for (const readinessServices of [[], ['g14-synthetic', 'g14-synthetic'], ['bad|owner']])
    assert.throws(() => createAlertDefinitions({config, readinessServices}), /readinessServices/u);
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
  assert.match(requests[2].body.query_condition.promql, /== bool 14\)\) or vector\(0\)/u,
    'the production POST keeps the complete default owner gate');
});

void test('synthetic readiness scope reaches only its separately named readiness rule payload', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({url: new URL(url).pathname, body: init.body ? JSON.parse(init.body) : undefined});
    return new Response('', {status: 200});
  };
  const rules = await installNativeAlerts({config, baseUrl: 'http://127.0.0.1:5080', organization: 'coffee', authorization: 'Basic fixture', readinessServices: ['g14-synthetic'], fetchImpl});
  assert.equal(rules[0].name, 'g14-v1-service-not-ready-synthetic');
  assert.equal(requests[2].body.name, 'g14-v1-service-not-ready-synthetic');
  assert.equal(requests[2].body.query_condition.promql.includes('service_name=~"^(g14-synthetic)$"'), true);
  assert.deepEqual(requests.slice(3).map(({body}) => body.name), rules.slice(1).map(({name}) => name));
});

void test('a late native alert install posts one selected readiness rule only', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({url: new URL(url).pathname, method: init.method, body: JSON.parse(init.body)});
    return new Response('', {status: 200});
  };
  const definition = createAlertDefinitions({config}).find(rule => rule.key === 'notReady');
  await installNativeAlert({baseUrl: 'http://127.0.0.1:5080', organization: 'coffee', authorization: 'Basic fixture', definition, fetchImpl});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/v2/coffee/alerts');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.name, 'g14-v1-service-not-ready');
  assert.equal(requests[0].body.query_condition.promql, definition.queryCondition.promql);
});
