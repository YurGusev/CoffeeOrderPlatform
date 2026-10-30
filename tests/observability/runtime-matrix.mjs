import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRuntimeLoggingOverride, discoverContainerLogs, OBSERVABILITY_TARGETS} from '../../tools/observability/generate.mjs';
import {prometheusMetricName} from '../../tools/observability/verify.mjs';
import {
  buildRuntimeMatrixProbe, COMMON_TEXT_FAMILIES, NODE_RUNTIME_ROLES, OWNER_TEXT_FAMILIES,
  OPTIONAL_OWNER_TEXT_FAMILIES, summarizeRuntimeProbeOutput,
} from './runtime-matrix-probe.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RUN_PROJECT = /^coffee-launch-[0-9]{8}t[0-9]{6}z-[a-f0-9]{7}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const CONTAINER_ID = /^[a-f0-9]{64}$/u;
const TOOLING_NAMES = new Set([
  'typescript', '@typescript/native-preview', 'typescript-eslint', '@typescript-eslint/parser', '@typescript-eslint/eslint-plugin',
  'ts-node', 'tsx', 'oxlint', 'oxlint-tsgolint', 'dependency-cruiser', '@hey-api/openapi-ts',
  '@stoplight/spectral-cli', 'prettier', 'vite', 'vitest', 'playwright',
]);
const ROOT_TOOLING_PACKAGES = [
  '@hey-api/openapi-ts', 'dependency-cruiser', 'oxlint', 'oxlint-tsgolint', 'playwright', 'prettier', 'typescript', 'vitest',
];
const TOOLING_PREFIXES = ['@typescript/native-preview-', '@typescript-eslint/', '@oxlint/'];
const REQUIRED_OUTBOX_OWNERS = [
  'catalog-activation-worker', 'orders-service', 'orders-aroma-preparation', 'aroma-observer', 'aroma-convergence',
];
const APP_NETWORKS = ['coffee_edge_backend', 'coffee_public_api_backend', 'coffee_internal_api', 'coffee_kafka_event'];
const ACTIVITY_DEPENDENT_METRICS = Object.freeze([
  {name: 'db.client.connection.checkout_wait', reason: 'sample is produced by a database checkout operation'},
  {name: 'db.client.transaction.duration', reason: 'sample is produced by a database transaction'},
  {name: 'db.client.transaction.count', reason: 'sample is produced by a database transaction'},
  {name: 'messaging.kafka.event.age', reason: 'sample is produced by a consumed Kafka record'},
  {name: 'messaging.kafka.consumer.lag', owners: ['realtime-gateway'], reason: 'a fresh realtime consumer group reports lag only after real consumption and commit; the mandatory launch proof checks it after activity'},
  {name: 'messaging.inbox.received.age', reason: 'sample is produced by an Inbox delivery'},
]);
const FAILURE_ERROR_KINDS = new Set(['Error', 'AssertionError', 'AggregateError']);
const FAILURE_ERROR_CODES = new Set(['ERR_ASSERTION', 'ABORT_ERR', 'ETIMEDOUT', 'ENOBUFS']);
const FAILURE_CHILD_SIGNALS = new Set(['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV']);
const FAILURE_FRAME_FILES = new Map([
  [resolve(ROOT, 'tools/compose-smoke.mjs'), 'tools/compose-smoke.mjs'],
  [resolve(ROOT, 'tools/observability/verify.mjs'), 'tools/observability/verify.mjs'],
  [resolve(ROOT, 'tests/observability/runtime-matrix.mjs'), 'tests/observability/runtime-matrix.mjs'],
]);
const FAILURE_METRIC_COMPONENTS = new Map([
  ['runtime_http_requests_total', ['']],
  ['runtime_http_request_duration_ms', ['_count', '_sum', '_bucket']],
  ...[
    'telemetry_log_records_dropped_total', 'telemetry_records_dropped_total', 'telemetry_export_failures_total',
    'telemetry_serialization_rejections_total', 'telemetry_queue_overflows_total', 'telemetry_shutdown_losses_total',
    'runtime_process_start_time_seconds', 'db.client.connection.waiting', 'messaging.kafka.consumer.lag',
    'messaging.outbox.oldest_unpublished.age', 'nginx_connections_current', 'probe_success',
  ].map(name => [name, ['']]),
]);
const FAILURE_METRIC_OWNERS = new Set([...NODE_RUNTIME_ROLES, 'edge-nginx']);

function fail(code) {
  throw new Error(code);
}

function safeDocker(runDocker, args) {
  try {
    return String(runDocker(args)).trim();
  } catch {
    fail('runtime matrix Docker operation failed');
  }
}

function parseJson(value, code) {
  try {
    return JSON.parse(value);
  } catch {
    fail(code);
  }
}

function assertNameList(value, expected, code) {
  const sorted = values => [...values].sort((left, right) => left.localeCompare(right));
  if (!Array.isArray(value) || value.length !== expected.length || sorted(value).join('\n') !== sorted(expected).join('\n')) fail(code);
}

function isForbiddenPackage(name) {
  return TOOLING_NAMES.has(name) || TOOLING_PREFIXES.some(prefix => name.startsWith(prefix));
}

export function runtimeMetricFamilies(config) {
  const services = config?.services;
  if (services === null || typeof services !== 'object') fail('runtime matrix platform config invalid');
  const databaseOwners = NODE_RUNTIME_ROLES.filter(role => typeof services[role]?.database === 'string');
  const kafkaOwners = NODE_RUNTIME_ROLES.filter(role => Array.isArray(services[role]?.kafka?.consumers) && services[role].kafka.consumers.length > 0);
  const durableKafkaOwners = NODE_RUNTIME_ROLES.filter(role =>
    Array.isArray(services[role]?.kafka?.consumers) && services[role].kafka.consumers.some(consumer => consumer?.processing === 'durable'));
  if (databaseOwners.length !== 10 || kafkaOwners.length !== 3 || durableKafkaOwners.length !== 2 ||
      REQUIRED_OUTBOX_OWNERS.some(role => !databaseOwners.includes(role))) {
    fail('runtime matrix owner inventory invalid');
  }
  const allRuntimes = [...NODE_RUNTIME_ROLES];
  return [
    {name: 'runtime_http_requests_total', owners: allRuntimes, components: [''], attributes: {http_response_status_class: '4xx'}},
    {name: 'runtime_http_request_duration_ms', owners: allRuntimes, components: ['_count', '_sum', '_bucket']},
    ...[
      'telemetry_log_records_dropped_total', 'telemetry_records_dropped_total', 'telemetry_export_failures_total',
      'telemetry_serialization_rejections_total', 'telemetry_queue_overflows_total', 'telemetry_shutdown_losses_total',
      'runtime_process_start_time_seconds',
    ].map(name => ({name, owners: allRuntimes, components: ['']})),
    {name: 'db.client.connection.waiting', owners: databaseOwners, components: ['']},
    {name: 'messaging.kafka.consumer.lag', owners: durableKafkaOwners, components: ['']},
    {name: 'messaging.outbox.oldest_unpublished.age', owners: REQUIRED_OUTBOX_OWNERS, components: ['']},
    {name: 'nginx_connections_current', owners: ['edge-nginx'], components: ['']},
    {name: 'probe_success', owners: ['edge-nginx'], components: [''], ownerLabel: 'probe_owner', attributes: {service_name: 'otel-collector'}},
  ];
}

export function sanitizeRuntimeMetricMatches(family, matches) {
  if (typeof family?.name !== 'string' || family.name.length === 0 ||
      !Array.isArray(family?.owners) || family.owners.length === 0 ||
      family.owners.some(owner => typeof owner !== 'string' || owner.length === 0) ||
      new Set(family.owners).size !== family.owners.length ||
      !Array.isArray(family.components) || family.components.length === 0 ||
      family.components.some(component => typeof component !== 'string')) {
    fail('runtime matrix OTLP family descriptor invalid');
  }
  if (!Array.isArray(matches) || matches.length !== family.components.length) fail('runtime matrix OTLP family components incomplete');
  const expectedStreams = family.components.map(component =>
    `${prometheusMetricName(family.name)}${component}`);
  const seen = new Set();
  const sanitized = [];
  for (const match of matches) {
    if (match === null || typeof match !== 'object' || Array.isArray(match) ||
        typeof match.stream !== 'string' || !expectedStreams.includes(match.stream) || seen.has(match.stream) ||
        !Number.isSafeInteger(match.sampleCount) || match.sampleCount < 1 ||
        !Array.isArray(match.services) || match.services.length !== family.owners.length ||
        new Set(match.services).size !== family.owners.length || match.services.some(service => !family.owners.includes(service))) {
      fail('runtime matrix OTLP family owner evidence invalid');
    }
    seen.add(match.stream);
    sanitized.push({stream: match.stream, sampleCount: match.sampleCount, services: [...match.services].sort((left, right) => left.localeCompare(right))});
  }
  if (expectedStreams.some(stream => !seen.has(stream))) fail('runtime matrix OTLP family components incomplete');
  return sanitized.sort((left, right) => left.stream.localeCompare(right.stream));
}

function sanitizeMetricFamilyObservation(value) {
  const hasOnlyKeys = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(object, key));
  if (!hasOnlyKeys(value, ['name', 'owners', 'components']) || !FAILURE_METRIC_COMPONENTS.has(value.name) ||
      !Array.isArray(value.owners) || value.owners.length === 0 || new Set(value.owners).size !== value.owners.length ||
      value.owners.some(owner => !FAILURE_METRIC_OWNERS.has(owner)) ||
      !Array.isArray(value.components) || value.components.length !== FAILURE_METRIC_COMPONENTS.get(value.name).length) return undefined;
  const expectedComponents = FAILURE_METRIC_COMPONENTS.get(value.name);
  const components = [];
  for (const component of value.components) {
    if (!hasOnlyKeys(component, ['component', 'streamPresent', 'presentOwners', 'missingOwners', 'sampleCount']) &&
        !hasOnlyKeys(component, ['component', 'streamPresent', 'presentOwners', 'missingOwners', 'sampleCount', 'queryFailure'])) return undefined;
    if (typeof component.component !== 'string' || !expectedComponents.includes(component.component) ||
        components.some(candidate => candidate.component === component.component) || typeof component.streamPresent !== 'boolean' ||
        !Array.isArray(component.presentOwners) || !Array.isArray(component.missingOwners) ||
        !Number.isSafeInteger(component.sampleCount) || component.sampleCount < 0 ||
        [...component.presentOwners, ...component.missingOwners].some(owner => !value.owners.includes(owner)) ||
        new Set(component.presentOwners).size !== component.presentOwners.length ||
        new Set(component.missingOwners).size !== component.missingOwners.length ||
        component.presentOwners.length + component.missingOwners.length !== value.owners.length ||
        value.owners.some(owner => component.presentOwners.includes(owner) === component.missingOwners.includes(owner)) ||
        (component.presentOwners.length === 0) !== (component.sampleCount === 0) ||
        (!component.streamPresent && (component.sampleCount !== 0 || component.presentOwners.length > 0)) ||
        (component.queryFailure !== undefined && (component.queryFailure === null || typeof component.queryFailure !== 'object' || Array.isArray(component.queryFailure) ||
          Object.keys(component.queryFailure).some(key => !['outcome', 'httpStatus', 'errorClass'].includes(key)) ||
          component.queryFailure.outcome !== 'QUERY_FAILED' || component.presentOwners.length > 0 || component.sampleCount !== 0))) return undefined;
    const queryFailure = component.queryFailure === undefined ? undefined : {outcome: 'QUERY_FAILED'};
    if (queryFailure !== undefined && Number.isInteger(component.queryFailure.httpStatus) &&
        component.queryFailure.httpStatus >= 100 && component.queryFailure.httpStatus <= 599)
      queryFailure.httpStatus = component.queryFailure.httpStatus;
    if (queryFailure !== undefined && ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(component.queryFailure.errorClass))
      queryFailure.errorClass = component.queryFailure.errorClass;
    components.push({
      component: component.component, streamPresent: component.streamPresent,
      presentOwners: [...component.presentOwners], missingOwners: [...component.missingOwners], sampleCount: component.sampleCount,
      ...(queryFailure === undefined ? {} : {queryFailure}),
    });
  }
  if (expectedComponents.some(component => !components.some(candidate => candidate.component === component))) return undefined;
  return {name: value.name, owners: [...value.owners], components};
}

function sanitizeNativeNginxAlert(value) {
  const phases = ['readiness', 'native-state', 'episodes', 'request-error', 'stability', 'pending-firing', 'complete'];
  const predicates = ['readiness-not-one', 'readiness-query-failed', 'native-state-query-failed', 'native-state-not-normal', 'awaiting-fresh-native-normal',
    'native-state-not-firing', 'native-pending', 'pending-not-after-normal-baseline', 'pending-window-not-proven', 'sink-query-failed', 'unresolved-episodes',
    'episodes-resolved', 'continuous-stability', 'baseline-stable'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      !(value.queryValue === null || (typeof value.queryValue === 'number' && Number.isFinite(value.queryValue))) ||
      !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 ||
      !Number.isSafeInteger(value.requiredStableMs) || value.requiredStableMs < 0 ||
      !Number.isSafeInteger(value.stableMs) || value.stableMs < 0 ||
      ['eventCount', 'episodeCount', 'unresolvedEpisodeCount'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10000) ||
      !phases.includes(value.phase) || !predicates.includes(value.predicate)) return undefined;
  const sanitizeRequestError = requestError => {
    if (requestError === null || typeof requestError !== 'object' || Array.isArray(requestError)) return undefined;
    const safe = {
      ...(['query', 'sink', 'native-state'].includes(requestError.source) ? {source: requestError.source} : {}),
      ...(Number.isInteger(requestError.httpStatus) && requestError.httpStatus >= 100 && requestError.httpStatus <= 599
        ? {httpStatus: requestError.httpStatus} : {}),
      ...(['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(requestError.errorClass)
        ? {errorClass: requestError.errorClass} : {}),
    };
    return Object.keys(safe).length > 0 ? safe : undefined;
  };
  const requestError = sanitizeRequestError(value.requestError);
  const lastResetRequestError = sanitizeRequestError(value.lastReset?.requestError);
  const lastResetHasValidRequestError = value.lastReset?.reason === 'request-error' &&
    ['readiness', 'native-state', 'episodes'].includes(value.lastReset.phase) &&
    Number.isSafeInteger(value.lastReset.queryDurationMs) && value.lastReset.queryDurationMs >= 0 && value.lastReset.queryDurationMs <= 600000 &&
      ((value.lastReset.phase === 'readiness' && lastResetRequestError?.source === 'query') ||
      (value.lastReset.phase === 'native-state' && lastResetRequestError?.source === 'native-state') ||
      (value.lastReset.phase === 'episodes' && lastResetRequestError?.source === 'sink')) && lastResetRequestError !== undefined;
  const lastReset = value.lastReset !== null && typeof value.lastReset === 'object' && !Array.isArray(value.lastReset) &&
      ['readiness-not-one', 'unresolved-episodes', 'native-state-not-normal', 'native-normal-not-fresh', 'request-error'].includes(value.lastReset.reason) &&
      Number.isSafeInteger(value.lastReset.observedAt) && value.lastReset.observedAt >= 0 &&
      (value.lastReset.reason !== 'request-error' || lastResetHasValidRequestError) &&
      (['native-state-not-normal', 'native-normal-not-fresh'].includes(value.lastReset.reason) &&
        ['unknown', 'normal', 'pending', 'firing'].includes(value.lastReset.nativeOutcome) ||
        !['native-state-not-normal', 'native-normal-not-fresh'].includes(value.lastReset.reason))
    ? {
      reason: value.lastReset.reason, observedAt: value.lastReset.observedAt,
      ...(['native-state-not-normal', 'native-normal-not-fresh'].includes(value.lastReset.reason)
        ? {nativeOutcome: value.lastReset.nativeOutcome} : {}),
      ...(value.lastReset.reason === 'request-error'
        ? {phase: value.lastReset.phase, queryDurationMs: value.lastReset.queryDurationMs, requestError: lastResetRequestError} : {}),
    }
    : undefined;
  const queryDurationMs = Number.isSafeInteger(value.queryDurationMs) && value.queryDurationMs >= 0 && value.queryDurationMs <= 600000
    ? value.queryDurationMs : undefined;
  const nativeAlertId = typeof value.nativeAlertId === 'string' && /^[A-Za-z0-9]{27}$/u.test(value.nativeAlertId)
    ? value.nativeAlertId : undefined;
  const baselineNormalAlertId = typeof value.baselineNormalAlertId === 'string' && /^[A-Za-z0-9]{27}$/u.test(value.baselineNormalAlertId)
    ? value.baselineNormalAlertId : undefined;
  const pendingAlertId = typeof value.pendingAlertId === 'string' && /^[A-Za-z0-9]{27}$/u.test(value.pendingAlertId)
    ? value.pendingAlertId : undefined;
  const nativeOutcome = ['unknown', 'normal', 'pending', 'firing'].includes(value.nativeOutcome) ? value.nativeOutcome : undefined;
  const safeNativeTimestamp = number => Number.isSafeInteger(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined;
  const nativeOutcomeAtUs = safeNativeTimestamp(value.nativeOutcomeAtUs);
  const nativeOutcomeSinceUs = safeNativeTimestamp(value.nativeOutcomeSinceUs);
  const nativeOutcomeAnchorAtUs = safeNativeTimestamp(value.nativeOutcomeAnchorAtUs);
  const baselineNormalOutcomeAtUs = safeNativeTimestamp(value.baselineNormalOutcomeAtUs);
  const baselineNormalSinceUs = safeNativeTimestamp(value.baselineNormalSinceUs);
  const pendingOutcomeAtUs = safeNativeTimestamp(value.pendingOutcomeAtUs);
  const firingOutcomeAtUs = safeNativeTimestamp(value.firingOutcomeAtUs);
  const pendingSinceUs = safeNativeTimestamp(value.pendingSinceUs);
  const firingSinceUs = safeNativeTimestamp(value.firingSinceUs);
  const pendingElapsedUs = Number.isSafeInteger(value.pendingElapsedUs) && value.pendingElapsedUs >= 0 && value.pendingElapsedUs <= 600_000_000
    ? value.pendingElapsedUs : undefined;
  const stopCallStartedAtUs = safeNativeTimestamp(value.stopCallStartedAtUs);
  const stopCallEndedAtUs = safeNativeTimestamp(value.stopCallEndedAtUs);
  const firstFailedProbeAtUs = safeNativeTimestamp(value.firstFailedProbeAtUs);
  const failedProbeObservedAtUs = safeNativeTimestamp(value.failedProbeObservedAtUs);
  const failedProbeSampleAtUs = safeNativeTimestamp(value.failedProbeSampleAtUs);
  return {
    queryValue: value.queryValue, observedAt: value.observedAt, requiredStableMs: value.requiredStableMs,
    stableMs: value.stableMs, eventCount: value.eventCount, episodeCount: value.episodeCount,
    unresolvedEpisodeCount: value.unresolvedEpisodeCount, phase: value.phase, predicate: value.predicate,
    ...(requestError === undefined ? {} : {requestError}),
    ...(queryDurationMs === undefined ? {} : {queryDurationMs}),
    ...(lastReset === undefined ? {} : {lastReset}),
    ...(nativeAlertId === undefined ? {} : {nativeAlertId}),
    ...(baselineNormalAlertId === undefined ? {} : {baselineNormalAlertId}),
    ...(pendingAlertId === undefined ? {} : {pendingAlertId}),
    ...(nativeOutcome === undefined ? {} : {nativeOutcome}),
    ...(nativeOutcomeAtUs === undefined ? {} : {nativeOutcomeAtUs}),
    ...(nativeOutcomeSinceUs === undefined ? {} : {nativeOutcomeSinceUs}),
    ...(nativeOutcomeAnchorAtUs === undefined ? {} : {nativeOutcomeAnchorAtUs}),
    ...(baselineNormalOutcomeAtUs === undefined ? {} : {baselineNormalOutcomeAtUs}),
    ...(baselineNormalSinceUs === undefined ? {} : {baselineNormalSinceUs}),
    ...(pendingOutcomeAtUs === undefined ? {} : {pendingOutcomeAtUs}),
    ...(firingOutcomeAtUs === undefined ? {} : {firingOutcomeAtUs}),
    ...(pendingSinceUs === undefined ? {} : {pendingSinceUs}),
    ...(firingSinceUs === undefined ? {} : {firingSinceUs}),
    ...(pendingElapsedUs === undefined ? {} : {pendingElapsedUs}),
    ...(stopCallStartedAtUs === undefined ? {} : {stopCallStartedAtUs}),
    ...(stopCallEndedAtUs === undefined ? {} : {stopCallEndedAtUs}),
    ...(firstFailedProbeAtUs === undefined ? {} : {firstFailedProbeAtUs}),
    ...(failedProbeObservedAtUs === undefined ? {} : {failedProbeObservedAtUs}),
    ...(failedProbeSampleAtUs === undefined ? {} : {failedProbeSampleAtUs}),
  };
}

function sanitizeNativeNginxRecovery(value) {
  const outcomes = ['QUERY_NOT_RUN', 'QUERY_ERROR', 'QUERY_SUCCEEDED', 'NO_TARGET_ROWS', 'NO_NUMERIC_TARGET_SAMPLE',
    'NO_FRESH_TARGET_SAMPLE', 'MATCHED', 'VALUE_MISMATCH'];
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      value.stage !== 'recovery' || !outcomes.includes(value.outcome) ||
      !Number.isSafeInteger(value.requiredAfterUs) || value.requiredAfterUs <= 0 ||
      !Number.isSafeInteger(value.observedAtUs) || value.observedAtUs <= 0 ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount < 0 || value.rowCount > 100 ||
      !Number.isSafeInteger(value.matchingRowCount) || value.matchingRowCount < 0 || value.matchingRowCount > value.rowCount ||
      (value.totalRowCount !== undefined && (!Number.isSafeInteger(value.totalRowCount) || value.totalRowCount < value.rowCount)) ||
      (value.isPartial !== undefined && typeof value.isPartial !== 'boolean') ||
      ![0, 1].includes(value.expectedValue)) return undefined;
  if (value.failureCode !== undefined && !['FATAL_GUARD', 'WAIT_TIMEOUT'].includes(value.failureCode)) return undefined;
  if (value.errorClass !== undefined && !['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(value.errorClass)) return undefined;
  if (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) return undefined;
  let latestTargetSample;
  if (value.latestTargetSample !== undefined) {
    const sample = value.latestTargetSample;
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample) ||
        sample.service !== 'edge-nginx' || sample.statusClass !== '2xx' ||
        !Number.isSafeInteger(sample.timestampUs) || sample.timestampUs <= 0 || !Number.isFinite(sample.value)) return undefined;
    latestTargetSample = {service: 'edge-nginx', statusClass: '2xx', timestampUs: sample.timestampUs, value: sample.value};
  }
  return {
    stage: 'recovery', outcome: value.outcome, requiredAfterUs: value.requiredAfterUs, observedAtUs: value.observedAtUs,
    rowCount: value.rowCount, matchingRowCount: value.matchingRowCount, expectedValue: value.expectedValue,
    ...(value.totalRowCount === undefined ? {} : {totalRowCount: value.totalRowCount}),
    ...(value.isPartial === undefined ? {} : {isPartial: value.isPartial}),
    ...(value.failureCode === undefined ? {} : {failureCode: value.failureCode}),
    ...(value.errorClass === undefined ? {} : {errorClass: value.errorClass}),
    ...(value.httpStatus === undefined ? {} : {httpStatus: value.httpStatus}),
    ...(latestTargetSample === undefined ? {} : {latestTargetSample}),
  };
}

export function sanitizeRuntimeMatrixFailure(error) {
  const primaryError = error instanceof AggregateError && error.cause instanceof Error ? error.cause : error;
  const name = primaryError !== null && typeof primaryError === 'object' ? primaryError.name : undefined;
  const code = primaryError !== null && typeof primaryError === 'object' ? primaryError.code : undefined;
  const stack = primaryError !== null && typeof primaryError === 'object' && typeof primaryError.stack === 'string' ? primaryError.stack : '';
  const status = primaryError !== null && typeof primaryError === 'object' ? primaryError.status : undefined;
  const signal = primaryError !== null && typeof primaryError === 'object' ? primaryError.signal : undefined;
  const stderr = primaryError !== null && typeof primaryError === 'object' ? primaryError.stderr : undefined;
  const metricFamilyObservation = primaryError !== null && typeof primaryError === 'object'
    ? sanitizeMetricFamilyObservation(primaryError.metricFamilyObservation) : undefined;
  const nativeNginxAlert = primaryError !== null && typeof primaryError === 'object'
    ? sanitizeNativeNginxAlert(primaryError.nativeNginxAlert) : undefined;
  const nativeNginxRecovery = primaryError !== null && typeof primaryError === 'object'
    ? sanitizeNativeNginxRecovery(primaryError.nativeNginxRecovery) : undefined;
  const frames = [];
  for (const line of stack.slice(0, 20_000).split('\n')) {
    const match = line.match(/(?:\(|at )((?:file:\/\/\/)?[^()\s]+):(\d+):(\d+)\)?$/u);
    if (!match) continue;
    let file;
    try { file = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1]; }
    catch { continue; }
    const source = FAILURE_FRAME_FILES.get(resolve(file));
    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3]);
    if (!source || !Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(columnNumber) || columnNumber < 1) continue;
    frames.push({source, line: lineNumber, column: columnNumber});
    if (frames.length === 5) break;
  }
  const childEvalFrames = [];
  const stderrTail = typeof stderr === 'string' ? stderr.slice(-20_000) :
    Buffer.isBuffer(stderr) ? stderr.subarray(-20_000).toString('utf8') : '';
  for (const line of stderrTail.split('\n')) {
    const match = line.match(/^\s*at\s+(?:.*\()?file:\/\/\/app\/\[eval1\]:(\d+):(\d+)\)?\s*$/u);
    if (!match) continue;
    const lineNumber = Number(match[1]);
    const columnNumber = Number(match[2]);
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(columnNumber) || columnNumber < 1) continue;
    childEvalFrames.push({line: lineNumber, column: columnNumber});
    if (childEvalFrames.length === 5) break;
  }
  return {
    errorKind: FAILURE_ERROR_KINDS.has(name) ? name : 'unknown',
    ...(FAILURE_ERROR_CODES.has(code) ? {code} : {}),
    ...(Number.isSafeInteger(status) && status >= 0 && status <= 255 ? {childExitCode: status} : {}),
    ...(FAILURE_CHILD_SIGNALS.has(signal) ? {childSignal: signal} : {}),
    frames,
    ...(childEvalFrames.length > 0 ? {childEvalFrames} : {}),
    ...(metricFamilyObservation === undefined ? {} : {metricFamilyObservation}),
    ...(nativeNginxAlert === undefined ? {} : {nativeNginxAlert}),
    ...(nativeNginxRecovery === undefined ? {} : {nativeNginxRecovery}),
  };
}

function validateProbeContext(context, projectName) {
  if (context?.projectName !== projectName) fail('runtime matrix Compose project mismatch');
  assertNameList(context.runtimes, NODE_RUNTIME_ROLES, 'runtime matrix Compose role inventory mismatch');
  const supplied = context.networks;
  if (supplied === null || typeof supplied !== 'object') fail('runtime matrix Compose networks missing');
  const networks = Object.fromEntries(APP_NETWORKS.map(name => {
    const actual = supplied[name];
    if (typeof actual !== 'string' || actual.length === 0 || actual.length > 128 || /[\r\n]/u.test(actual)) fail('runtime matrix Compose network identity invalid');
    return [name, actual];
  }));
  return networks;
}

function inspectContainer(runDocker, row, projectName, expectedLogging) {
  const inspected = parseJson(safeDocker(runDocker, ['inspect', row.containerId]), 'runtime matrix container inspect invalid');
  if (!Array.isArray(inspected) || inspected.length !== 1) fail('runtime matrix container inspect invalid');
  const item = inspected[0];
  const actualLogConfig = item.HostConfig?.LogConfig;
  const expectedOptions = Object.fromEntries(Object.entries(expectedLogging.options).map(([name, value]) => [name, String(value)]));
  const actualOptions = actualLogConfig?.Config ?? {};
  if (item.Id !== row.containerId || item.State?.Running !== true ||
      item.Config?.Labels?.['com.docker.compose.project'] !== projectName ||
      item.Config?.Labels?.['com.docker.compose.service'] !== row.service ||
      !IMAGE_ID.test(item.Image ?? '')) fail('runtime matrix container identity mismatch');
  if (actualLogConfig?.Type !== expectedLogging.driver ||
      Object.keys(actualOptions).length !== Object.keys(expectedOptions).length ||
      Object.entries(expectedOptions).some(([name, value]) => actualOptions[name] !== value)) fail('runtime matrix Docker logging policy mismatch');
  if (item.LogPath !== row.logPath) fail('runtime matrix Docker log path mismatch');
  return {role: row.service, containerId: item.Id, imageId: item.Image, logPath: item.LogPath,
    logging: {driver: actualLogConfig.Type, options: actualOptions}};
}

function inspectImage(runDocker, role, imageId) {
  const result = parseJson(safeDocker(runDocker, ['image', 'inspect', '--format', '{{json .}}', imageId]), 'runtime matrix image inspect invalid');
  const repoDigests = result.RepoDigests ?? [];
  if (result.Id !== imageId || !Array.isArray(repoDigests) || repoDigests.some(value => typeof value !== 'string')) fail('runtime matrix image identity mismatch');
  return {role, imageId, repoDigests};
}

export function nodeImageProbe(role, nodeVersion, forbiddenNames) {
  const constants = JSON.stringify({role, nodeVersion, forbidden: forbiddenNames, prefixes: TOOLING_PREFIXES});
  return `const fs=require('node:fs'),path=require('node:path'),c=${constants};
const forbidden=new Set(c.forbidden),isForbidden=n=>forbidden.has(n)||c.prefixes.some(prefix=>n.startsWith(prefix));
let complete=true;const found=new Set(),visited=new Set();
function manifest(file){try{
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  if(p===null||typeof p!=='object'||Array.isArray(p)){complete=false;return;}
  const parts=file.split('/'),nodeModules=parts.lastIndexOf('node_modules'),packageParts=parts.slice(nodeModules+1,-1);
  const packageRoot=(packageParts.length===1&&!packageParts[0].startsWith('@'))||(packageParts.length===2&&packageParts[0].startsWith('@'));
  if((Object.hasOwn(p,'name')&&typeof p.name!=='string')||(packageRoot&&typeof p.name!=='string'))complete=false;
  else if(typeof p.name==='string'&&isForbidden(p.name))found.add(p.name);
}catch{complete=false;}}
function walk(dir){let real;try{real=fs.realpathSync(dir);}catch{complete=false;return;}if(!real.startsWith('/app/')||visited.has(real))return;visited.add(real);let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{complete=false;return;}for(const entry of entries){const file=path.join(dir,entry.name);if(entry.name==='package.json'&&(entry.isFile()||entry.isSymbolicLink()))manifest(file);if(entry.isDirectory())walk(file);else if(entry.isSymbolicLink()){try{if(fs.statSync(file).isDirectory())walk(file);}catch(error){if(error.code!=='ENOENT')complete=false;}}}}
let packageName=null,rootForbidden=[];try{const root=JSON.parse(fs.readFileSync('/app/package.json','utf8'));packageName=root.name;if(typeof packageName!=='string')complete=false;for(const section of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])for(const n of Object.keys(root[section]||{}))if(isForbidden(n))rootForbidden.push(n);}catch{complete=false;}
let distMainPresent=false;try{distMainPresent=fs.statSync('/app/dist/main.js').isFile();}catch{}try{walk('/app/node_modules');}catch{complete=false;}for(const n of rootForbidden)found.add(n);
const result={node:process.version,uid:process.getuid?.()??null,packageName,distMainPresent,packageScanComplete:complete,forbiddenPackages:[...found].sort()};
result.pass=result.node==='v'+c.nodeVersion&&result.uid===1000&&result.packageName==='@coffee-platform/'+c.role&&result.distMainPresent&&complete&&result.forbiddenPackages.length===0;process.stdout.write(JSON.stringify(result)+'\\n');if(!result.pass)process.exitCode=1;`;
}

function nginxImageProbe(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) fail('runtime matrix nginx BOM version invalid');
  return `set -u
uid=$(id -u)
version=$(nginx -v 2>&1)
expected="nginx version: nginx/${version}"
version_ok=false
[ "$version" = "$expected" ] && version_ok=true
tools=""
separator=""
for tool in node npm pnpm corepack gcc g++ clang cc make apt-get dpkg; do
  if command -v "$tool" >/dev/null 2>&1; then tools=$(printf '%s%s"%s"' "\${tools}" "\${separator}" "$tool"); separator=,; fi
done
grep -R -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|BEGIN CERTIFICATE' /etc/nginx /usr/share/nginx/html >/dev/null 2>&1
grep_status=$?
private_absent=false
[ "$grep_status" -eq 1 ] && private_absent=true
pass=false
[ "$uid" = 101 ] && [ "$version_ok" = true ] && [ -z "$tools" ] && [ "$private_absent" = true ] && pass=true
printf '{"uid":%s,"nginxVersion":"nginx/%s","versionMatches":%s,"forbiddenTools":[%s],"privateMaterialAbsent":%s,"pass":%s}\\n' "$uid" "${version}" "$version_ok" "$tools" "$private_absent" "$pass"
[ "$pass" = true ]`;
}

function parseImageProbe(runDocker, args, expected, allowedNames, code) {
  const output = safeDocker(runDocker, args);
  const lines = output.split('\n').filter(Boolean);
  if (lines.length !== 1) fail(code);
  const value = parseJson(lines[0], code);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  if (Object.keys(value).length !== Object.keys(expected).length || Object.keys(expected).some(key => !Object.hasOwn(value, key))) fail(code);
  if (allowedNames !== undefined && (!Array.isArray(value.forbiddenPackages) || value.forbiddenPackages.some(name => typeof name !== 'string' || !isForbiddenPackage(name)))) fail(code);
  return value;
}

function runOwnedImageProbe(runDocker, args, name, imageId, code) {
  try { return String(runDocker(args)).trim(); }
  catch {
    try {
      const ids = String(runDocker(['ps', '-aq', '--filter', `name=^/${name}$`])).trim().split(/\s+/u).filter(Boolean);
      if (ids.length === 1 && CONTAINER_ID.test(ids[0])) {
        const inspected = JSON.parse(runDocker(['inspect', ids[0]]));
        const item = Array.isArray(inspected) && inspected.length === 1 ? inspected[0] : null;
        if (item?.Id === ids[0] && item?.Name === `/${name}` && item?.Image === imageId) {
          runDocker(['rm', '--force', ids[0]]);
        }
      }
    } catch {}
    fail(code);
  }
}

function scanNodeImage(runDocker, image, nodeVersion, projectSuffix, forbiddenNames) {
  const name = `coffee-runtime-matrix-${projectSuffix}-${image.role}`;
  const existing = safeDocker(runDocker, ['ps', '-aq', '--filter', `name=^/${name}$`]);
  if (existing !== '') fail('runtime matrix scanner name collision');
  const script = nodeImageProbe(image.role, nodeVersion, forbiddenNames);
  const args = [
    'run', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--read-only',
    '--memory', '128m', '--cpus', '1', '--pids-limit', '32', '--security-opt', 'no-new-privileges:true',
    '--user', '1000:1000', '--entrypoint', 'node', image.imageId, '-e', script,
  ];
  const value = parseImageProbe(args => runOwnedImageProbe(runDocker, args, name, image.imageId, 'runtime matrix Node image probe failed'), args, {
    node: null, uid: null, packageName: null, distMainPresent: null, packageScanComplete: null, forbiddenPackages: null, pass: null,
  }, true, 'runtime matrix Node image output invalid');
  const passed = value.pass === true && value.node === `v${nodeVersion}` && value.uid === 1000 &&
    value.packageName === `@coffee-platform/${image.role}` && value.distMainPresent === true && value.packageScanComplete === true && value.forbiddenPackages.length === 0;
  return {...image, nodeVersion: value.node, uid: value.uid, packageName: value.packageName,
    distMainPresent: value.distMainPresent, packageScanComplete: value.packageScanComplete,
    forbiddenPackages: [...value.forbiddenPackages].sort((left, right) => left.localeCompare(right)), status: passed ? 'PASS' : 'FAIL'};
}

function scanNginxImage(runDocker, image, version, projectSuffix) {
  const name = `coffee-runtime-matrix-${projectSuffix}-edge-nginx`;
  if (safeDocker(runDocker, ['ps', '-aq', '--filter', `name=^/${name}$`]) !== '') fail('runtime matrix scanner name collision');
  const args = [
    'run', '--rm', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--read-only',
    '--memory', '128m', '--cpus', '1', '--pids-limit', '16', '--security-opt', 'no-new-privileges:true',
    '--user', '101:101', '--entrypoint', 'sh', image.imageId, '-c', nginxImageProbe(version),
  ];
  const value = parseImageProbe(args => runOwnedImageProbe(runDocker, args, name, image.imageId, 'runtime matrix nginx image probe failed'), args, {
    uid: null, nginxVersion: null, versionMatches: null, forbiddenTools: null, privateMaterialAbsent: null, pass: null,
  }, undefined, 'runtime matrix nginx image output invalid');
  const names = new Set(['node', 'npm', 'pnpm', 'corepack', 'gcc', 'g++', 'clang', 'cc', 'make', 'apt-get', 'dpkg']);
  if (!Array.isArray(value.forbiddenTools) || value.forbiddenTools.some(name => typeof name !== 'string' || !names.has(name))) fail('runtime matrix nginx image names invalid');
  const passed = value.pass === true && value.uid === 101 && value.nginxVersion === `nginx/${version}` &&
    value.versionMatches === true && value.privateMaterialAbsent === true && value.forbiddenTools.length === 0;
  return {...image, nginxVersion: value.nginxVersion, uid: value.uid, versionMatches: value.versionMatches,
    forbiddenTools: [...value.forbiddenTools].sort((left, right) => left.localeCompare(right)), privateMaterialAbsent: value.privateMaterialAbsent,
    status: passed ? 'PASS' : 'FAIL'};
}

async function sourceEvidence(sourceIdentity) {
  try {
    const identity = await sourceIdentity(ROOT);
    if (identity.sourceFiles.status !== 'PASS' || identity.runtimeArtifacts === null || identity.identityHash === null) {
      fail('runtime matrix source identity incomplete');
    }
    return identity;
  } catch {
    fail('runtime matrix source identity unavailable');
  }
}

async function forbiddenRuntimePackages() {
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')); }
  catch { fail('runtime matrix root package manifest invalid'); }
  const devDependencies = manifest?.devDependencies;
  if (devDependencies === null || typeof devDependencies !== 'object' ||
      ROOT_TOOLING_PACKAGES.some(name => !Object.hasOwn(devDependencies, name))) {
    fail('runtime matrix root tooling inventory invalid');
  }
  return [...new Set([...TOOLING_NAMES, ...ROOT_TOOLING_PACKAGES])].sort();
}

function summarizeComposeReceipt(receipt, projectName) {
  const expectedHealth = ['/health/live', '/health/ready', '/metrics'];
  const postgresStorage = receipt?.recoveryProof?.postgresStorage;
  if (receipt?.proofKind !== 'observability-fixture' || receipt?.project !== projectName || receipt.runtimes !== 14 || receipt.nativeIngress !== 'edge-nginx' ||
      receipt.kafka !== true || receipt.ephemeralKafkaBroker !== true || receipt.credentialSource !== 'local-fixture' ||
      receipt.telemetry !== true || receipt.dbIntegrationProof !== true || receipt.gracefulShutdown !== true ||
      receipt.recoveryProof === null || typeof receipt.recoveryProof !== 'object' ||
      postgresStorage?.type !== 'tmpfs' || postgresStorage.destination !== '/var/lib/postgresql/data' ||
      postgresStorage.sizeMiB !== 512 || postgresStorage.durability !== 'ephemeral' ||
      !Array.isArray(receipt.healthEndpoints) || expectedHealth.some(path => !receipt.healthEndpoints.includes(path))) {
    fail('runtime matrix Compose receipt assertion failed');
  }
  return {
    project: projectName, runtimes: 14, nativeIngress: 'edge-nginx', kafka: true,
    ephemeralKafkaBroker: true, credentialSource: 'local-fixture', telemetry: true,
    dbIntegrationProof: true, gracefulShutdown: true, healthEndpoints: expectedHealth,
    recoveryProofPresent: true, postgresStorage,
  };
}

function assertProjectCleanup(runDocker, projectName) {
  const checks = [
    ['ps', '-aq', '--filter', `label=com.docker.compose.project=${projectName}`],
    ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
    ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${projectName}`],
  ];
  for (const args of checks) if (safeDocker(runDocker, args) !== '') fail('runtime matrix Compose resources remain after cleanup');
}

export async function verifyRuntimeMetricMatrix({
  config, exporterToken, projectName, runDocker = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000}),
  onRolesReady, onCleanup, verifyMetricFamily, sourceIdentity, nodeVersion, nginxVersion,
} = {}) {
  if (!RUN_PROJECT.test(projectName ?? '') || typeof exporterToken !== 'string' || exporterToken.length === 0 ||
      typeof onRolesReady !== 'function' || typeof onCleanup !== 'function' || typeof verifyMetricFamily !== 'function' ||
      typeof sourceIdentity !== 'function' ||
      !/^\d+\.\d+\.\d+$/u.test(nodeVersion ?? '') || !/^\d+\.\d+\.\d+$/u.test(nginxVersion ?? '')) fail('runtime matrix inputs invalid');
  const projectSuffix = projectName.slice('coffee-launch-'.length);
  const [source, forbiddenPackages] = await Promise.all([sourceEvidence(sourceIdentity), forbiddenRuntimePackages()]);
  const toolchain = parseJson(await readFile(resolve(ROOT, 'config/toolchain-versions.json'), 'utf8'), 'runtime matrix BOM invalid');
  if (toolchain.node !== nodeVersion || toolchain.nginxVersion !== nginxVersion) fail('runtime matrix BOM version mismatch');
  const expected = runtimeMetricFamilies(config);
  const allowedPhases = new Set(['compose-recovery', 'container-inventory', 'container-image-identities', 'collector-ready', 'collector-cleanup']);
  for (const role of OBSERVABILITY_TARGETS) allowedPhases.add(`image-scan:${role}`);
  for (const role of NODE_RUNTIME_ROLES) allowedPhases.add(`runtime-probe:${role}`);
  for (const family of expected) allowedPhases.add(`otlp-family:${family.name}`);
  let phase = 'compose-recovery';
  const setPhase = value => {
    if (!allowedPhases.has(value)) fail('runtime matrix phase invalid');
    phase = value;
  };
  let readyCalled = false;
  let cleanupCalled = false;
  let runtimeImages = [];
  let probes = [];
  let verifiedMetrics = [];
  let imageEvidence = [];
  let capturedNetworks = {};
  let loggingPolicyEvidence = {status: 'NOT_RUN'};
  let phaseStartUs;
  const onReady = async context => {
    if (readyCalled) fail('runtime matrix Compose ready hook repeated');
    readyCalled = true;
    phaseStartUs = Date.now() * 1000;
    setPhase('container-inventory');
    capturedNetworks = validateProbeContext(context, projectName);
    let logFiles;
    try {
      logFiles = await discoverContainerLogs({projectName, runtimes: OBSERVABILITY_TARGETS, runDocker});
    } catch {
      fail('runtime matrix Compose container inventory invalid');
    }
    assertNameList(logFiles.map(item => item.service), OBSERVABILITY_TARGETS, 'runtime matrix Compose service inventory mismatch');
    setPhase('container-image-identities');
    const loggingPolicy = createRuntimeLoggingOverride({config}).services;
    const containers = logFiles.map(row => inspectContainer(runDocker, row, projectName, loggingPolicy[row.service].logging));
    loggingPolicyEvidence = {
      status: 'PASS',
      pinoDropCounter: 'telemetry_log_records_dropped_total',
      dockerNonblockingBufferDropAccounting: 'NOT_PROVEN',
      roles: containers.map(({role, logging}) => ({role, ...logging})),
    };
    runtimeImages = containers;
    const imageRecords = containers.map(image => inspectImage(runDocker, image.role, image.imageId));
    setPhase('collector-ready');
    await onRolesReady({logFiles, networks: capturedNetworks});
    for (const record of imageRecords) {
      setPhase(`image-scan:${record.role}`);
      imageEvidence.push(record.role === 'edge-nginx'
        ? scanNginxImage(runDocker, record, nginxVersion, projectSuffix)
        : scanNodeImage(runDocker, record, nodeVersion, projectSuffix, forbiddenPackages));
    }
    if (imageEvidence.length !== 15 || imageEvidence.some(image => image.status !== 'PASS')) fail('runtime matrix final image scan failed');
    for (const role of NODE_RUNTIME_ROLES) {
      setPhase(`runtime-probe:${role}`);
      const image = runtimeImages.find(candidate => candidate.role === role);
      const port = config.services[role]?.listen?.port;
      if (!image || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('runtime matrix role configuration invalid');
      const source = buildRuntimeMatrixProbe({role, nodeVersion, port});
      const output = safeDocker(runDocker, ['exec', '--user', '1000:1000', '--workdir', '/app', image.containerId, 'node', '--input-type=module', '-e', source]);
      probes.push(summarizeRuntimeProbeOutput(output, {role, nodeVersion}));
    }
    if (probes.length !== NODE_RUNTIME_ROLES.length) fail('runtime matrix role probes incomplete');
    for (const family of expected) {
      setPhase(`otlp-family:${family.name}`);
      const result = await verifyMetricFamily({...family, startTimeUs: phaseStartUs});
      const matches = sanitizeRuntimeMetricMatches(family, result);
      verifiedMetrics.push({name: family.name, owners: [...family.owners], components: [...family.components],
        ...(family.attributes === undefined ? {} : {attributes: {...family.attributes}}), matches, status: 'PASS'});
    }
    if (verifiedMetrics.length !== expected.length) fail('runtime matrix OTLP verification incomplete');
    setPhase('compose-recovery');
  };
  const cleanup = async context => {
    cleanupCalled = true;
    const previousPhase = phase;
    setPhase('collector-cleanup');
    let cleaned = false;
    try { await onCleanup(context); cleaned = true; }
    finally { if (cleaned && phase === 'collector-cleanup') setPhase(previousPhase); }
  };
  let smoke;
  try {
    const {runComposeSmoke} = await import('../../tools/compose-smoke.mjs');
    if (typeof runComposeSmoke !== 'function') fail('runtime matrix Compose runner unavailable');
    smoke = await runComposeSmoke({
      args: ['--recovery-proof', '--observability-fixture', '--project-name', projectName],
      observability: {exporterToken, onReady, onCleanup: cleanup},
    });
  } catch (cause) {
    const error = new Error(`runtime matrix failed during ${phase}`);
    error.runtimeMetricMatrix = {
      status: 'FAIL', project: projectName, source, images: imageEvidence,
      runtimeMetrics: {roles: probes, otlpFamilies: verifiedMetrics}, loggingPolicy: loggingPolicyEvidence, phase, cleanupCalled,
      failureDiagnostics: sanitizeRuntimeMatrixFailure(cause),
    };
    throw error;
  }
  if (!readyCalled || !cleanupCalled) fail('runtime matrix Compose hooks incomplete');
  const composeReceipt = summarizeComposeReceipt(smoke, projectName);
  assertProjectCleanup(runDocker, projectName);
  if (Object.values(capturedNetworks).some(name => name.startsWith(`${projectName}_`))) {
    const remainingNetworks = safeDocker(runDocker, ['network', 'ls', '--format', '{{.Name}}']).split('\n').filter(Boolean);
    if (Object.values(capturedNetworks).some(name => remainingNetworks.includes(name))) fail('runtime matrix project network remains after cleanup');
  }
  return {
    status: 'PASS', project: projectName, source,
    composeReceipt, cleanupVerified: true,
    loggingPolicy: loggingPolicyEvidence,
    runtimeMetrics: {
      status: 'PASS', roles: probes, otlpFamilies: verifiedMetrics,
      legacyTextScope: 'Only /metrics text callbacks and runtime foundation counters; OTLP-only process, database and Kafka instruments are verified through Prometheus.',
      legacyTextFamilies: {
        common: [...COMMON_TEXT_FAMILIES],
        ownerSpecific: Object.fromEntries(Object.entries(OWNER_TEXT_FAMILIES).map(([role, names]) => [role, [...names]])),
      },
    },
    metricApplicability: {
      activityDependent: ACTIVITY_DEPENDENT_METRICS.map(metric => ({...metric, status: 'NOT_ASSERTED_WITHOUT_ACTIVITY'})),
      optionalLegacyFamilies: Object.fromEntries(Object.entries(OPTIONAL_OWNER_TEXT_FAMILIES).map(([role, names]) => [role, [...names]])),
      outboxOwners: [...REQUIRED_OUTBOX_OWNERS],
    },
    images: imageEvidence,
    configuration: {nodeVersion, nginxVersion, nodeImage: toolchain.nodeImage, nginxImage: toolchain.nginxImage,
      bomSha256: source.bomSha256, platformConfigSha256: source.configSha256,
      rootToolingPackages: ROOT_TOOLING_PACKAGES},
  };
}
