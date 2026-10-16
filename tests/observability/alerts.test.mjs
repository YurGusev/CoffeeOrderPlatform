import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import path from 'node:path';
import {createAlertDefinitions, installNativeAlerts} from '../../tools/observability/alerts.mjs';
import {missingCpuFeatures, nativeAccessLogFilter, observabilityVerificationCoverage, parseCollectorMemoryLimiterMetrics, sourceIdentity, stopContainerGracefully, traceSpanInventory, validateCollectorMemorySample, waitForOwnedMetricFamilySamples} from '../../tools/observability/verify.mjs';
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
  assert.equal(definitions.find(rule => rule.key === 'notReady').queryCondition.promql,
    'min(platform_metrics_runtime_ready or platform_metrics_httpcheck_status{service_name="edge-nginx",http_status_class="2xx"})');
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
