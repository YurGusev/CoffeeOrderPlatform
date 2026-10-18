import {randomUUID} from 'node:crypto';
import {OBSERVABILITY_TARGETS} from './generate.mjs';

const ALERT_API = '/api/v2';
const MANAGEMENT_API = '/api';
const ALERT_METRICS = [
  {key: 'notReady', slug: 'service-not-ready', metric: 'runtime_ready', operator: '<='},
  {key: 'consumerLag', slug: 'consumer-lag', metric: 'messaging.kafka.consumer.lag', operator: '>'},
  {key: 'outboxOldestAge', slug: 'outbox-oldest-age', metric: 'messaging.outbox.oldest_unpublished.age', operator: '>'},
  {key: 'unknownOutcome', slug: 'unknown-outcome', metric: 'coffee_aroma_unknown_outcomes_current', operator: '>'},
  {key: 'sseDropRate', slug: 'sse-drop-rate', metric: 'coffee_realtime_invalidation_dropped_total', operator: '>'},
];
const READINESS_SERVICES = OBSERVABILITY_TARGETS.filter(service => service !== 'edge-nginx');

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

function metricStream(prefix, name) {
  return `${prefix}_${name}`.replace(/[^a-zA-Z0-9_]/gu, '_');
}

function promqlFor(rule, streams, windowSeconds, readinessServices) {
  if (rule.key === 'notReady') {
    const owners = `^(${readinessServices.join('|')})$`;
    const runtimeReady = `${streams.runtime_ready}{service_name=~"${owners}"}`;
    return `(min(${runtimeReady} or ${streams.httpcheck_status}{service_name="edge-nginx",http_status_class="2xx"}) * (scalar(count(count by (service_name) (${runtimeReady}))) == bool ${readinessServices.length})) or vector(0)`;
  }
  if (rule.key === 'sseDropRate') {
    const dropped = streams.coffee_realtime_invalidation_dropped_total;
    const attempts = streams.coffee_realtime_invalidation_attempts_total;
    return `sum(rate(${dropped}[${windowSeconds}s])) / clamp_min(sum(rate(${attempts}[${windowSeconds}s])), 1e-12)`;
  }
  return `max(${streams[rule.metric]})`;
}

export function createAlertDefinitions({config, readinessServices} = {}) {
  const telemetry = required(config?.telemetry, 'telemetry');
  const alerts = required(telemetry.alerts, 'telemetry.alerts');
  const version = alerts.version;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('telemetry.alerts.version must be a positive integer');
  const evaluationIntervalMs = alerts.evaluationIntervalMs;
  if (!Number.isSafeInteger(evaluationIntervalMs) || evaluationIntervalMs <= 0 || evaluationIntervalMs % 60000 !== 0)
    throw new Error('telemetry.alerts.evaluationIntervalMs must be a positive whole number of minutes');
  const evaluationIntervalMinutes = evaluationIntervalMs / 60000;
  const prefix = required(telemetry.openObserve?.streams?.metrics, 'telemetry.openObserve.streams.metrics');
  const expectedReadinessServices = readinessServices ?? READINESS_SERVICES;
  if (!Array.isArray(expectedReadinessServices) || expectedReadinessServices.length === 0 ||
    expectedReadinessServices.some(service => typeof service !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(service)) ||
    new Set(expectedReadinessServices).size !== expectedReadinessServices.length)
    throw new Error('readinessServices must contain unique service names');
  const streamNames = Object.fromEntries(ALERT_METRICS.map(({metric}) => [metric, metricStream(prefix, metric)]));
  streamNames.coffee_realtime_invalidation_attempts_total = metricStream(prefix, 'coffee_realtime_invalidation_attempts_total');
  streamNames.httpcheck_status = metricStream(prefix, 'httpcheck_status');

  return ALERT_METRICS.map(rule => {
    const threshold = required(alerts[rule.key]?.threshold, `telemetry.alerts.${rule.key}.threshold`);
    const forMs = alerts[rule.key]?.forMs;
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || !Number.isSafeInteger(forMs) || forMs <= 0)
      throw new Error(`invalid alert config: ${rule.key}`);
    return {
      key: rule.key,
      name: `g14-v${version}-${rule.slug}${rule.key === 'notReady' && readinessServices !== undefined &&
        (expectedReadinessServices.length !== READINESS_SERVICES.length || expectedReadinessServices.some((service, index) => service !== READINESS_SERVICES[index])) ? '-synthetic' : ''}`,
      streamName: streamNames[rule.metric],
      metricName: rule.metric,
      threshold,
      operator: rule.operator,
      evaluationIntervalMinutes,
      pendingPeriodSec: forMs / 1000,
      queryCondition: {
        type: 'promql',
        promql: promqlFor(rule, streamNames, forMs / 1000, expectedReadinessServices),
        promql_condition: {column: 'value', operator: rule.operator, value: threshold},
      },
    };
  });
}

async function request({fetchImpl, baseUrl, path, authorization, method = 'POST', body}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: {Authorization: authorization, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`OpenObserve API ${method} ${path} returned HTTP ${response.status}`);
  const text = await response.text();
  return text.length === 0 ? undefined : JSON.parse(text);
}

export async function installNativeAlert({baseUrl, organization, authorization, definition, fetchImpl = fetch} = {}) {
  required(baseUrl, 'baseUrl');
  required(organization, 'organization');
  required(authorization, 'authorization');
  required(definition, 'definition');
  await request({fetchImpl, baseUrl, path: `${ALERT_API}/${organization}/alerts`, authorization, body: {
    name: definition.name,
    stream_type: 'metrics',
    stream_name: definition.streamName,
    is_real_time: false,
    query_condition: definition.queryCondition,
    trigger_condition: {period: definition.evaluationIntervalMinutes, operator: '>=', threshold: 1, frequency: definition.evaluationIntervalMinutes, frequency_type: 'minutes', silence: 0},
    destinations: ['g14-local'],
    enabled: true,
    pending_period_sec: definition.pendingPeriodSec,
    notify_on_recovery: true,
    recovery_destinations: ['g14-local'],
    keep_firing_for: 0,
  }});
  return definition;
}

export async function installNativeAlerts({config, baseUrl, organization, authorization, readinessServices, fetchImpl = fetch} = {}) {
  required(baseUrl, 'baseUrl');
  required(organization, 'organization');
  required(authorization, 'authorization');
  const definitions = createAlertDefinitions({config, readinessServices});
  const api = (path, args = {}) => request({fetchImpl, baseUrl, path, authorization, ...args});

  await api(`${MANAGEMENT_API}/${organization}/alerts/templates`, {body: {
    name: 'g14-local-template',
    body: '{"status":"{alert_status}","episode_id":"{episode_id}","name":"{alert_name}"}',
    type: 'http', title: '', kind: 'custom',
  }});
  await api(`${MANAGEMENT_API}/${organization}/alerts/destinations`, {body: {
    name: 'g14-local', url: 'http://127.0.0.1:9091/alerts', method: 'post', type: 'http',
    template: 'g14-local-template', skip_tls_verify: false, headers: {'Content-Type': 'application/json'},
  }});

  for (const definition of definitions) {
    await installNativeAlert({baseUrl, organization, authorization, definition, fetchImpl});
  }
  return definitions;
}

export function newRunId() {
  return randomUUID();
}
