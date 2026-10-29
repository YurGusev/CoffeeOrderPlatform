import {randomUUID} from 'node:crypto';
import {OBSERVABILITY_TARGETS} from './generate.mjs';

const ALERT_METRICS = [
  {key: 'notReady', slug: 'service-not-ready', metric: 'runtime_ready', operator: '<='},
  {key: 'consumerLag', slug: 'consumer-lag', metric: 'messaging_kafka_consumer_lag_messages', operator: '>'},
  {key: 'outboxOldestAge', slug: 'outbox-oldest-age', metric: 'messaging_outbox_oldest_unpublished_age_milliseconds', operator: '>'},
  {key: 'unknownOutcome', slug: 'unknown-outcome', metric: 'coffee_aroma_unknown_outcomes_current', operator: '>'},
  {key: 'sseDropRate', slug: 'sse-drop-rate', metric: 'coffee_realtime_invalidation_dropped_total', operator: '>'},
];

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

export function createAlertDefinitions({config, readinessServices} = {}) {
  const telemetry = required(config?.telemetry, 'telemetry');
  const alerts = required(telemetry.alerts, 'telemetry.alerts');
  if (!Number.isSafeInteger(alerts.version) || alerts.version < 1) throw new Error('telemetry.alerts.version must be a positive integer');
  if (!Number.isSafeInteger(alerts.evaluationIntervalMs) || alerts.evaluationIntervalMs <= 0 || alerts.evaluationIntervalMs % 1000 !== 0)
    throw new Error('telemetry.alerts.evaluationIntervalMs must be a positive whole number of seconds');
  const labels = [
    ['deployment_environment', config.environment], ['service_namespace', telemetry.namespace], ['service_version', telemetry.releaseDigest],
  ].map(([name, value]) => {
    if (typeof value !== 'string' || !value) throw new Error(`${name} must be a nonempty string`);
    return `${name}=${JSON.stringify(value)}`;
  }).join(',');
  const allServices = OBSERVABILITY_TARGETS.filter(service => service !== 'edge-nginx');
  const services = readinessServices ?? allServices;
  if (!Array.isArray(services) || services.length === 0 || services.some(service => typeof service !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(service)) || new Set(services).size !== services.length)
    throw new Error('readinessServices must contain unique service names');
  const runtime = `runtime_ready{service_name=~"^(${services.join('|')})$",${labels}}`;
  const nginx = `probe_success{service_name="otel-collector",probe_owner="edge-nginx",${labels}}`;
  const readiness = `min(${runtime} or ${nginx}) * (scalar(count(count by (service_name) (${runtime}))) == bool ${services.length})`;
  const production = readinessServices === undefined || (services.length === allServices.length && services.every((service, index) => service === allServices[index]));
  const definitions = ALERT_METRICS.map(rule => {
    const {threshold, forMs} = required(alerts[rule.key], `telemetry.alerts.${rule.key}`);
    if (typeof threshold !== 'number' || !Number.isFinite(threshold) || !Number.isSafeInteger(forMs) || forMs <= 0 || forMs % 1000 !== 0)
      throw new Error(`invalid alert config: ${rule.key}`);
    const select = metric => `${metric}{${labels}}`;
    const query = rule.key === 'notReady' ? (production ? `((${readiness}) and on() (count(${nginx}) > 0)) or vector(0)` : `(${readiness}) or vector(0)`)
      : rule.key === 'sseDropRate' ? `sum(rate(${select(rule.metric)}[${forMs / 1000}s])) / clamp_min(sum(rate(${select('coffee_realtime_invalidation_attempts_total')}[${forMs / 1000}s])), 1e-12)`
      : `max(${select(rule.metric)})`;
    return {key: rule.key, name: `g14-v${alerts.version}-${rule.slug}${rule.key === 'notReady' && !production ? '-synthetic' : ''}`,
      metric: rule.metric, threshold, operator: rule.operator, forMs, query};
  });
  if (typeof telemetry.diskWatermarkPercent !== 'number' || !Number.isFinite(telemetry.diskWatermarkPercent) || telemetry.diskWatermarkPercent <= 0 || telemetry.diskWatermarkPercent > 100)
    throw new Error('telemetry.diskWatermarkPercent must be a percentage');
  const diskForMs = required(alerts.diskUsage, 'telemetry.alerts.diskUsage').forMs;
  if (!Number.isSafeInteger(diskForMs) || diskForMs < 0 || diskForMs % 1000 !== 0) throw new Error('invalid alert config: diskUsage');
  const diskSelector = `{mountpoint=~"/telemetry-storage/(grafana|loki|prometheus|tempo)",service_name="otel-collector",${labels}}`;
  definitions.push({key: 'diskWatermark', name: `g14-v${alerts.version}-disk-watermark`,
    metric: 'node_filesystem_free_bytes', threshold: telemetry.diskWatermarkPercent, operator: '>=', forMs: diskForMs,
    query: `100 * (1 - node_filesystem_free_bytes${diskSelector} / node_filesystem_size_bytes${diskSelector})`});
  return definitions;
}

export function createGrafanaAlertProvisioning(config, {notificationUrl} = {}) {
  required(notificationUrl, 'notificationUrl');
  const rules = createAlertDefinitions({config}).map(rule => ({
    uid: rule.name, title: rule.name, condition: 'B',
    data: [
      {refId: 'A', datasourceUid: 'prometheus', relativeTimeRange: {from: Math.max(rule.forMs / 1000, 600), to: 0},
        model: {refId: 'A', datasource: {type: 'prometheus', uid: 'prometheus'}, expr: rule.query, instant: true, range: false, intervalMs: 1000, maxDataPoints: 43200}},
      {refId: 'B', datasourceUid: '__expr__', relativeTimeRange: {from: 0, to: 0},
        model: {refId: 'B', datasource: {type: '__expr__', uid: '__expr__'}, type: 'math', expression: `$A ${rule.operator} ${rule.threshold}`, intervalMs: 1000, maxDataPoints: 43200}},
    ],
    noDataState: ['notReady', 'diskWatermark'].includes(rule.key) ? 'Alerting' : 'OK', execErrState: 'Alerting', for: `${rule.forMs / 1000}s`,
  }));
  return {
    alerts: {apiVersion: 1, groups: [{orgId: 1, name: 'g14', folder: 'Operations', interval: `${config.telemetry.alerts.evaluationIntervalMs / 1000}s`, rules}]},
    contacts: {apiVersion: 1, contactPoints: [{orgId: 1, name: 'g14-local', receivers: [{uid: 'g14-local', type: 'webhook', settings: {url: notificationUrl, httpMethod: 'POST'}, disableResolveMessage: false}]}],
      policies: [{orgId: 1, receiver: 'g14-local', group_by: ['alertname'], group_wait: '0s', group_interval: '1m', repeat_interval: '4h'}]},
  };
}

export function newRunId() { return randomUUID(); }
