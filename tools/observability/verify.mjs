import {execFileSync, spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {accessSync, constants as fsConstants, existsSync} from 'node:fs';
import {lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {delimiter, dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dump as dumpYaml} from 'js-yaml';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';
import {installNativeAlerts, newRunId} from './alerts.mjs';
import {initializeOpenObserve} from './bootstrap.mjs';
import {discoverContainerLogs, createCollectorConfig, createComposeOverride, openObserveBufferEnvironment, OBSERVABILITY_TARGETS} from './generate.mjs';
import {provisionStorage, removeStorage} from './storage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NODE_RUNTIME_TARGETS = OBSERVABILITY_TARGETS.filter(runtime => runtime !== 'edge-nginx');
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const docker = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000}).trim();

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
}

function inspectFixtureTools() {
  const commands = {
    node: {binary: process.execPath, args: ['--version']},
    cp: {args: ['--version']},
    openssl: {args: ['version']},
    java: {args: ['-version']},
    keytool: {args: ['-J-version']},
    pnpm: {args: ['--version']},
    docker: {args: ['version', '--format', '{{.Client.Version}}']},
  };
  const tools = Object.fromEntries(Object.entries(commands).map(([name, command]) => {
    let binary = command.binary;
    if (binary === undefined) {
      binary = (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, name))
        .find(candidate => existsSync(candidate) && (() => { try { accessSync(candidate, fsConstants.X_OK); return true; } catch { return false; } })());
    }
    if (binary === undefined) return [name, {available: false, version: null}];
    try {
      const result = spawnSync(binary, command.args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000});
      if (result.error !== undefined || result.status !== 0) {
        const failure = result.error?.code ?? `exit-${result.status ?? result.signal ?? 'unknown'}`;
        return [name, {available: false, path: binary, version: null, failure}];
      }
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      const version = output.split('\n').map(line => line.trim()).find(Boolean) ?? null;
      return [name, {available: version !== null, path: binary, version}];
    } catch (error) {
      return [name, {available: false, path: binary, version: null, failure: error.code ?? `exit-${error.status ?? 'unknown'}`}];
    }
  }));
  const missing = Object.entries(tools).filter(([, tool]) => tool.available !== true).map(([name]) => name);
  return {status: missing.length === 0 ? 'PASS' : 'FAIL', tools, missing};
}

export function missingCpuFeatures(cpuInfo) {
  const flags = new Set(cpuInfo.match(/^(?:flags|Features)\s*:\s*(.+)$/m)?.[1]?.split(/\s+/u) ?? []);
  return ['avx', 'aes'].filter(feature => !flags.has(feature));
}

function basicAuthorization(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;
}

async function api({fetchImpl = fetch, baseUrl, path, authorization, method = 'GET', body, expected = [200], sensitiveValues = []}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: {Authorization: authorization, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!expected.includes(response.status)) {
    const safeText = sensitiveValues.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, text);
    throw new Error(`OpenObserve ${method} ${path} returned HTTP ${response.status}${safeText ? `: ${safeText.slice(0, 300)}` : ''}`);
  }
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return text; }
}

async function waitFor(predicate, {timeoutMs, intervalMs = 2000, description}) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${description} did not complete${lastError ? `: ${lastError.message}` : ''}`);
}

function requireRunning({run, name, secrets = []}) {
  const state = run(['inspect', '--format', '{{.State.Running}}|{{.State.ExitCode}}', name]);
  if (!state.startsWith('true|')) {
    let logs = '';
    try { logs = run(['logs', '--tail', '12', name]); } catch {}
    const safeLogs = secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, logs)
      .replace(/(authorization|token|password|secret)([=: ]+)\S+/giu, '$1$2[REDACTED]')
      .replace(/o2oi_[A-Za-z0-9_-]+/gu, '[REDACTED]');
    throw Object.assign(new Error(`${name} exited before health (code ${state.split('|')[1] ?? 'unknown'})${safeLogs ? `; sanitized logs: ${safeLogs.slice(-1200)}` : ''}`), {fatal: true});
  }
}

function captureContainerDiagnostics({name, stage = 'observed', secrets = []}) {
  const inspect = spawnSync('docker', ['inspect', '--format', '{{json .State}}', name], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let state;
  if (!inspect.error && inspect.status === 0) {
    try {
      const value = JSON.parse(inspect.stdout.trim());
      state = Object.fromEntries(['Running', 'ExitCode', 'OOMKilled', 'Error', 'StartedAt', 'FinishedAt'].map(key => [key, value[key]]));
      state.Error = secrets.reduce((value, secret) => secret ? value.replaceAll(secret, '[REDACTED]') : value, String(state.Error ?? '').slice(0, 500))
        .replace(/(authorization|token|password|secret)([=: ]+)\S+/giu, '$1$2[REDACTED]')
        .replace(/\b(Basic|Bearer)\s+[^\s"']+/giu, '$1 [REDACTED]')
        .replace(/o2oi_[A-Za-z0-9_-]+/gu, '[REDACTED]');
    } catch { state = {unavailable: true}; }
  } else state = {unavailable: true};
  const logResult = spawnSync('docker', ['logs', '--tail', '120', name], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = sanitizedDiagnostics(`${logResult.stdout ?? ''}\n${logResult.stderr ?? ''}`, secrets);
  return {name, stage, state, ...(logs ? {errorOrWarningLines: logs} : {})};
}

function openObserveCgroupDiagnostics(name) {
  const fields = {
    cpuMax: 'NOT_CAPTURED',
    cpuStat: {nr_periods: 'NOT_CAPTURED', nr_throttled: 'NOT_CAPTURED', throttled_usec: 'NOT_CAPTURED'},
    memoryCurrent: 'NOT_CAPTURED',
    memoryPeak: 'NOT_CAPTURED',
    memoryMax: 'NOT_CAPTURED',
  };
  const script = [
    'set -eu',
    'read_value() { key="$1"; file="/sys/fs/cgroup/$2"; if [ -r "$file" ]; then IFS= read -r value < "$file" || value=; if [ -n "$value" ]; then printf "%s=%s\\n" "$key" "$value"; else printf "%s=NOT_CAPTURED\\n" "$key"; fi; else printf "%s=NOT_CAPTURED\\n" "$key"; fi; }',
    'read_value cpuMax cpu.max',
    'if [ -r /sys/fs/cgroup/cpu.stat ]; then /busybox awk \'$1 == "nr_periods" || $1 == "nr_throttled" || $1 == "throttled_usec" { print "cpuStat." $1 "=" $2 }\' /sys/fs/cgroup/cpu.stat; else printf "cpuStat.nr_periods=NOT_CAPTURED\\ncpuStat.nr_throttled=NOT_CAPTURED\\ncpuStat.throttled_usec=NOT_CAPTURED\\n"; fi',
    'read_value memoryCurrent memory.current',
    'read_value memoryPeak memory.peak',
    'read_value memoryMax memory.max',
  ].join('\n');
  const result = spawnSync('docker', ['exec', name, '/busybox', 'sh', '-c', script], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.status !== 0) return {status: 'NOT_CAPTURED', ...fields};
  for (const line of (result.stdout ?? '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (value === 'NOT_CAPTURED') continue;
    if (key === 'cpuMax') {
      const match = /^(max|\d+)\s+(\d+)$/u.exec(value);
      const quotaMicros = match?.[1] === 'max' ? null : Number(match?.[1]);
      const periodMicros = Number(match?.[2]);
      if (match && (quotaMicros === null || Number.isSafeInteger(quotaMicros)) && Number.isSafeInteger(periodMicros))
        fields.cpuMax = {quotaMicros, periodMicros};
    } else if (key.startsWith('cpuStat.')) {
      const stat = key.slice('cpuStat.'.length);
      const numericValue = Number(value);
      if (Object.hasOwn(fields.cpuStat, stat) && /^\d+$/u.test(value) && Number.isSafeInteger(numericValue)) fields.cpuStat[stat] = numericValue;
    } else if (['memoryCurrent', 'memoryPeak', 'memoryMax'].includes(key) && /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) {
      fields[key] = Number(value);
    } else if (key === 'memoryMax' && value === 'max') {
      fields.memoryMax = 'max';
    }
  }
  const values = [fields.cpuMax, ...Object.values(fields.cpuStat), fields.memoryCurrent, fields.memoryPeak, fields.memoryMax];
  return {status: values.every(value => value !== 'NOT_CAPTURED') ? 'CAPTURED' : 'NOT_CAPTURED', ...fields};
}

function containerGeneration({run, name}) {
  return {
    id: run(['inspect', '--format', '{{.Id}}', name]),
    state: JSON.parse(run(['inspect', '--format', '{{json .State}}', name])),
  };
}

function startedAtUs(state) {
  const startedAtMs = Date.parse(state?.StartedAt ?? '');
  if (!Number.isFinite(startedAtMs)) throw new Error('container process start time is unavailable');
  return startedAtMs * 1000;
}

function metricTimestampUs(record) {
  const raw = Object.entries(record ?? []).find(([key, value]) =>
    /^(?:_timestamp|timestamp|@timestamp)$/iu.test(key) && (typeof value === 'number' || typeof value === 'string'))?.[1];
  if (typeof raw === 'number') {
    if (raw > 1e14) return raw;
    if (raw > 1e11) return raw * 1000;
    return raw * 1e6;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed * 1000 : undefined;
  }
  return undefined;
}

function latestMetricSample(records, {service, afterUs, beforeUs}) {
  return records.map(record => ({
    timestampUs: metricTimestampUs(record),
    service: metricRecordAttribute(record, 'service_name'),
    instanceId: metricRecordAttribute(record, 'service_instance_id'),
    value: metricValues([record])[0],
  })).filter(sample => sample.service === service && Number.isFinite(sample.timestampUs) && sample.value !== undefined &&
    (afterUs === undefined || sample.timestampUs > afterUs) && (beforeUs === undefined || sample.timestampUs < beforeUs))
    .sort((left, right) => right.timestampUs - left.timestampUs)[0];
}

async function waitForProcessMetric({baseUrl, authorization, organization, stream, service, afterUs, beforeUs, description}) {
  return waitFor(async () => {
    const samples = rows(await streamSearch({baseUrl, authorization, organization, stream, streamType: 'metrics', startTimeUs: afterUs, endTimeUs: beforeUs ?? Date.now() * 1000}));
    return latestMetricSample(samples, {service, afterUs, beforeUs}) ?? false;
  }, {timeoutMs: 60000, intervalMs: 1000, description});
}

async function fixtureDiagnostics(baseUrl) {
  const response = await fetch(new URL('/test/diagnostics', baseUrl), {signal: AbortSignal.timeout(2000)});
  if (!response.ok) throw new Error(`synthetic runtime diagnostics returned HTTP ${response.status}`);
  const diagnostics = await response.json();
  const counters = ['dropped', 'exportFailures', 'shutdownLoss', 'serializationRejected', 'queueOverflows'];
  if (!Number.isInteger(diagnostics.processId) || !Number.isFinite(diagnostics.processStartTimeSeconds) ||
      counters.some(counter => !Number.isSafeInteger(diagnostics[counter]) || diagnostics[counter] < 0))
    throw new Error('synthetic runtime diagnostics did not expose typed process identity and loss counters');
  const counterValues = Object.fromEntries(counters.map(counter => [counter, diagnostics[counter]]));
  return {processId: diagnostics.processId, processStartTimeSeconds: diagnostics.processStartTimeSeconds,
    ...counterValues, counters: counterValues};
}

function openObserveDiskDiagnostics({run, name}) {
  const mounts = run(['exec', name, '/busybox', 'cat', '/proc/mounts'])
    .split('\n')
    .map(line => line.trim().split(/\s+/u))
    .filter(fields => fields.length >= 3 && (fields[1] === '/' || fields[1] === '/data' || fields[1].startsWith('/data/')))
    .map(fields => ({mountPoint: fields[1], filesystem: fields[2]}));
  const mountPoints = [...new Set(mounts.map(mount => mount.mountPoint))];
  const filesystemUsage = run(['exec', name, '/busybox', 'df', '-P', ...mountPoints])
    .split('\n').slice(1).filter(Boolean).map(line => {
      const fields = line.trim().split(/\s+/u);
      return {mountPoint: fields.at(-1), totalBytes: Number(fields[1]) * 1024, usedBytes: Number(fields[2]) * 1024, usedPercent: Number(fields[4]?.replace('%', ''))};
    });
  let nodeDiskMetrics = [];
  try {
    const metrics = run(['exec', name, '/busybox', 'wget', '-q', '-O', '-', 'http://127.0.0.1:5080/metrics']);
    nodeDiskMetrics = metrics.split('\n').map(line => {
      const match = /^node_disk_(total|usage)(?:\{([^}]*)\})?\s+([0-9.eE+-]+)$/u.exec(line);
      if (!match) return undefined;
      const labels = Object.fromEntries([...(match[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/gu)].map(([, key, value]) => [key, value]));
      const mountPoint = labels.mountpoint ?? labels.mount_point ?? labels.path;
      if (mountPoint !== '/' && mountPoint !== '/data' && !mountPoint?.startsWith('/data/')) return undefined;
      return {name: match[1], mountPoint, value: Number(match[3])};
    }).filter(Boolean);
  } catch {}
  return {mounts, filesystemUsage, nodeDiskMetrics};
}

function sanitizedDiagnostics(value, secrets) {
  return secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, value)
    .replace(/(authorization|token|password|secret)([=: ]+)\S+/giu, '$1$2[REDACTED]')
    .replace(/o2oi_[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .replace(/\b(Basic|Bearer)\s+[^\s"']+/giu, '$1 [REDACTED]')
    .split('\n')
    .filter(line => /\b(error|warn|failed|unauthorized|forbidden|queue is full)\b/iu.test(line))
    .slice(-10)
    .map(line => line.slice(0, 900))
    .join('\n');
}

function sanitizedStartupMilestones(value, secrets) {
  return secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, value)
    .replace(/(authorization|token|password|secret)([=: ]+)\S+/giu, '$1$2[REDACTED]')
    .replace(/\b(Basic|Bearer)\s+[^\s"']+/giu, '$1 [REDACTED]')
    .replace(/o2oi_[A-Za-z0-9_-]+/gu, '[REDACTED]')
    .split('\n')
    .filter(line => /\b(start(?:ing|ed)?|listen(?:ing)?|server|migrat(?:e|ion)|ready|initiali[sz]e|bind(?:ing)?)\b/iu.test(line))
    .slice(-8)
    .map(line => line.slice(0, 400))
    .join('\n');
}

async function readSinkEvents(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function fixtureRequest({baseUrl, path = '/synthetic', method = 'POST', body, runId}) {
  const traceId = runId.replaceAll('-', '').padEnd(32, '0');
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      'x-correlation-id': runId,
      traceparent: `00-${traceId}-0123456789abcdef-01`,
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`synthetic runtime ${method} ${path} returned HTTP ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function streamSearch({baseUrl, authorization, organization, stream, runId, field, filterSql, streamType = 'logs', windowMs = 10 * 60 * 1000, startTimeUs, endTimeUs = Date.now() * 1000, fetchImpl = fetch}) {
  const escapedStream = stream.replaceAll('"', '""');
  const filter = filterSql ?? (runId === undefined || field === undefined ? '' : `"${field}" = '${runId}'`);
  return api({fetchImpl, baseUrl, path: `/api/${encodeURIComponent(organization)}/_search?type=${encodeURIComponent(streamType)}`, authorization, method: 'POST', expected: [200], body: {
    query: {sql: `SELECT * FROM "${escapedStream}"${filter ? ` WHERE ${filter}` : ''}`, start_time: startTimeUs ?? endTimeUs - windowMs * 1000, end_time: endTimeUs, from: 0, size: 100},
    search_type: 'ui', timeout: 5,
  }});
}

function rows(result) {
  return result?.hits?.hits ?? result?.hits ?? result?.data?.records ?? result?.data?.rows ?? result?.records ?? [];
}

function summarizeLogRows(records, {runId, redactionCanary}) {
  const paths = new Set();
  let runIdObserved = false;
  let canaryLeaked = false;
  const visit = (value, path = '', depth = 0) => {
    if (value === '[REDACTED]') paths.add(path);
    if (value === runId) runIdObserved = true;
    if (value === redactionCanary) canaryLeaked = true;
    if (depth >= 8 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value).slice(0, 100)) visit(child, path ? `${path}.${key}` : key, depth + 1);
  };
  for (const record of records.slice(0, 10)) visit(record);
  return {recordCount: records.length, recordKeys: [...new Set(records.flatMap(record => Object.keys(record ?? {})))].slice(0, 80), redactedPaths: [...paths].slice(0, 30), runIdObserved, canaryLeaked};
}

function inspectProducerRedaction({name, runId, redactionCanary}) {
  const result = spawnSync('docker', ['logs', name], {encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']});
  if (result.error || result.status !== 0) throw new Error('could not inspect the synthetic producer Docker log for redaction evidence');
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const records = output.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  let matchingRunId = false;
  let redactedToken = false;
  const visit = (value, depth = 0) => {
    if (depth >= 8 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (child === runId) matchingRunId = true;
      if (key.toLowerCase() === 'token' && child === '[REDACTED]') redactedToken = true;
      visit(child, depth + 1);
    }
  };
  records.forEach(record => visit(record));
  return {matchingRunId, redactedToken, canaryLeaked: output.includes(redactionCanary), recordsScanned: records.length};
}

function containsSensitiveField(value, depth = 0) {
  if (depth >= 8 || value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /authorization|password|secret|token/iu.test(key) || containsSensitiveField(child, depth + 1));
}

async function verifySignal({baseUrl, authorization, organization, stream, runId, field, streamType = 'logs'}) {
  return waitFor(async () => rows(await streamSearch({baseUrl, authorization, organization, stream, runId, field, streamType})).length > 0, {
    timeoutMs: 60000, description: `run-id record in OpenObserve stream ${stream}`,
  });
}

async function verifyMetricSignal({baseUrl, authorization, organization, stream, startTimeUs}) {
  return waitFor(async () => {
    const samples = rows(await streamSearch({baseUrl, authorization, organization, stream, streamType: 'metrics', startTimeUs}));
    return samples.length > 0 ? samples : false;
  }, {
    timeoutMs: 60000, description: `OpenTelemetry SDK metric in OpenObserve stream ${stream}`,
  });
}

function metricValues(records) {
  return records.flatMap(record => Object.entries(record ?? [])
    .filter(([key, value]) => /^(?:value|_value)$/iu.test(key) && typeof value === 'number')
    .map(([, value]) => value));
}

async function verifyMetricThreshold({baseUrl, authorization, organization, stream, predicate, description, timeoutMs = 60000}) {
  return waitFor(async () => {
    const samples = rows(await streamSearch({baseUrl, authorization, organization, stream, streamType: 'metrics'}));
    const values = metricValues(samples);
    return values.some(predicate) ? {samples, values} : false;
  }, {timeoutMs, intervalMs: 2000, description});
}

function summarizeHttpCheckSamples(records) {
  const samples = records.slice(0, 20).map(record => {
    const entries = Object.entries(record ?? {});
    const service = entries.find(([key, value]) => /service_name/iu.test(key) && typeof value === 'string')?.[1];
    const statusClass = entries.find(([key, value]) => /status_class/iu.test(key) && typeof value === 'string')?.[1];
    const value = entries.find(([key, candidate]) => /^(?:value|_value)$/iu.test(key) && typeof candidate === 'number')?.[1];
    const statusCode = entries.find(([key, candidate]) => /status_code/iu.test(key) && typeof candidate === 'number')?.[1];
    const timestamp = entries.find(([key, candidate]) => /^(?:_timestamp|timestamp|@timestamp)$/iu.test(key) && (typeof candidate === 'number' || typeof candidate === 'string'))?.[1];
    return {service, statusClass, value, ...(statusCode === undefined ? {} : {statusCode}), ...(timestamp === undefined ? {} : {timestamp})};
  });
  return {
    sampleCount: records.length,
    healthyOpenObserve: samples.some(sample => sample.service === 'openobserve' && sample.statusClass === '2xx' && sample.value === 1),
    healthyCollector: samples.some(sample => sample.service === 'otel-collector' && sample.statusClass === '2xx' && sample.value === 1),
    samples,
  };
}

async function waitForHealthyHttpCheckMetrics({baseUrl, authorization, organization, stream, startTimeUs, description, timeoutMs = 60000}) {
  let lastSummary = {sampleCount: 0, healthyOpenObserve: false, healthyCollector: false, samples: []};
  try {
    const samples = await waitFor(async () => {
      const records = rows(await streamSearch({baseUrl, authorization, organization, stream, streamType: 'metrics', startTimeUs}));
      lastSummary = summarizeHttpCheckSamples(records);
      return lastSummary.healthyOpenObserve && lastSummary.healthyCollector ? records : false;
    }, {timeoutMs, intervalMs: 2000, description});
    return {samples, summary: lastSummary};
  } catch (error) {
    error.message += `; latest health samples=${JSON.stringify(lastSummary)}`;
    throw error;
  }
}

export function traceSpanInventory(records) {
  const inventory = {};
  for (const record of records) {
    const service = record?.service_name;
    const spanName = record?.operation_name;
    if (typeof service !== 'string' || service.length === 0 || typeof spanName !== 'string' || spanName.length === 0) continue;
    inventory[service] ??= new Set();
    inventory[service].add(spanName);
  }
  return Object.fromEntries(Object.entries(inventory).map(([service, names]) => [service, [...names].sort()]));
}

export function nativeAccessLogFilter(correlationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(correlationId)) throw new TypeError('native access probe requires a UUID');
  return `"service_name" = 'edge-nginx' AND "body_correlation_id" = '${correlationId}'`;
}

function metricRecordServices(records) {
  return [...new Set(records.flatMap(record => Object.entries(record ?? [])
    .filter(([key, value]) => /service_name/iu.test(key) && typeof value === 'string')
    .map(([, value]) => value)))].sort();
}

export async function waitForOwnedMetricFamilySamples({baseUrl, authorization, organization, metricsPrefix, family, liveMetricStreams, startTimeUs, fetchImpl = fetch, timeoutMs = 60000, intervalMs = 2000}) {
  let availableStreams = new Set(liveMetricStreams);
  const attributeFilters = Object.entries(family.attributes ?? {}).map(([key, value]) => {
    if (!/^[a-z][a-z0-9_]*$/u.test(key) || typeof value !== 'string') throw new TypeError('metric filter must use normalized attribute names and string values');
    return `"${key}" = '${value.replaceAll("'", "''")}'`;
  });
  return waitFor(async () => {
    const base = `${metricsPrefix}_${family.name.replace(/[^a-zA-Z0-9_]/gu, '_')}`;
    const candidateStreams = family.components.map(component => `${base}${component}`).filter(stream => availableStreams.has(stream));
    const matches = [];
    for (const stream of candidateStreams) {
      const services = new Set();
      let sampleCount = 0;
      for (const owner of family.owners) {
        const escapedOwner = owner.replaceAll("'", "''");
        const samples = rows(await streamSearch({
          baseUrl, authorization, organization, stream, streamType: 'metrics', startTimeUs, fetchImpl,
          filterSql: [`"service_name" = '${escapedOwner}'`, ...attributeFilters].join(' AND '),
        }));
        const ownedSamples = samples.filter(sample => metricRecordServices([sample]).includes(owner));
        if (ownedSamples.length > 0) {
          services.add(owner);
          sampleCount += ownedSamples.length;
        }
      }
      if (services.size > 0) matches.push({stream, sampleCount, services: [...services]});
    }
    if (matches.length === family.components.length && matches.every(match => family.owners.every(owner => match.services.includes(owner)))) return matches;
    const inventory = streamEntries(await api({
      fetchImpl, baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`,
    }));
    availableStreams = new Set(inventory.filter(stream => stream?.stream_type === 'metrics' && typeof stream?.name === 'string').map(stream => stream.name));
    return false;
  }, {timeoutMs, intervalMs, description: `OpenObserve metric family ${family.name} from every owning runtime (${family.owners.join(', ')})`});
}

function metricRecordAttribute(record, name) {
  const direct = record?.[name] ?? record?.[`attributes_${name}`] ?? record?.[`attributes.${name}`] ?? record?.attributes?.[name];
  return typeof direct === 'string' || typeof direct === 'number' ? direct : undefined;
}

function validConvergenceMetricContract(metrics) {
  const expected = [
    {name: 'coffee_aroma_attempt_results_total', attributes: {result: 'unknown_outcome'}, value: 1},
    {name: 'coffee_aroma_unknown_outcomes_total', attributes: {}, value: 1},
    {name: 'coffee_aroma_unknown_outcomes_current', attributes: {}, values: [1, 0]},
    {name: 'coffee_aroma_recovery_results_total', attributes: {result: 'recovered_applied'}, value: 1},
  ];
  if (!Array.isArray(metrics) || metrics.length !== expected.length) return false;
  return expected.every(expectedMetric => {
    const actual = metrics.find(metric => metric?.name === expectedMetric.name);
    return actual !== undefined && JSON.stringify(actual.attributes ?? {}) === JSON.stringify(expectedMetric.attributes) &&
      actual.value === expectedMetric.value && JSON.stringify(actual.values) === JSON.stringify(expectedMetric.values);
  });
}

function hasExactValue(value, expected, depth = 0) {
  if (value === expected) return true;
  if (depth >= 8 || value === null || typeof value !== 'object') return false;
  return Object.values(value).slice(0, 100).some(child => hasExactValue(child, expected, depth + 1));
}

async function collectorTraceCounters({baseUrl, authorization, organization, metricsPrefix}) {
  const counters = [];
  for (const metric of ['otelcol_receiver_accepted_spans', 'otelcol_exporter_sent_spans']) {
    const stream = `${metricsPrefix}_${metric}`;
    try {
      const result = await streamSearch({baseUrl, authorization, organization, stream, streamType: 'metrics'});
      counters.push({stream, samples: rows(result).slice(0, 5).map(record => ({
        numericValues: Object.fromEntries(Object.entries(record ?? {}).filter(([, value]) => typeof value === 'number')),
      }))});
    } catch {
      counters.push({stream, samples: []});
    }
  }
  return counters;
}

export async function verifyCollectorQueueMetrics({baseUrl, authorization, organization, metricsPrefix, startTimeUs, lossStartTimeUs = startTimeUs, lossEndTimeUs, queueCapacity, fetchImpl = fetch, timeoutMs = 60000, intervalMs = 2000}) {
  const metricNames = [
    'otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity',
    'otelcol_exporter_enqueue_failed_log_records', 'otelcol_exporter_enqueue_failed_metric_points', 'otelcol_exporter_enqueue_failed_spans',
    'otelcol_exporter_send_failed_log_records', 'otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_send_failed_spans',
    'otelcol_exporter_sent_log_records', 'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_spans',
  ];
  let lastObservation = null;
  try { return await waitFor(async () => {
    const inventory = streamEntries(await api({fetchImpl, baseUrl, authorization, organization, path: `/api/${encodeURIComponent(organization)}/streams`}));
    const availableStreams = new Set(inventory.filter(stream => stream?.stream_type === 'metrics').map(stream => stream.name));
    const samplesByMetric = {};
    for (const metricName of metricNames) {
      const stream = `${metricsPrefix}_${metricName}`;
      if (!availableStreams.has(stream)) {
        samplesByMetric[metricName] = {stream, available: false, sampleCount: 0, values: [], timestampsUs: []};
        continue;
      }
      const processScopedLossMetric = metricName.includes('_send_failed_') || metricName.includes('_enqueue_failed_');
      const samples = rows(await streamSearch({
        fetchImpl, baseUrl, authorization, organization, stream, streamType: 'metrics',
        startTimeUs: processScopedLossMetric ? lossStartTimeUs : startTimeUs,
        ...(processScopedLossMetric && lossEndTimeUs !== undefined ? {endTimeUs: lossEndTimeUs} : {}),
        filterSql: '"service_name" = \'otel-collector\'',
      }));
      const values = metricValues(samples);
      const timestampsUs = samples.map(metricTimestampUs).filter(Number.isFinite);
      samplesByMetric[metricName] = {stream, available: true, sampleCount: samples.length, values, timestampsUs};
    }
    const queue = samplesByMetric.otelcol_exporter_queue_size.values;
    const capacity = samplesByMetric.otelcol_exporter_queue_capacity.values;
    const sent = ['log_records', 'metric_points', 'spans'].flatMap(signal =>
      samplesByMetric[`otelcol_exporter_sent_${signal}`].values);
    const requiredFreshMetrics = ['otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity',
      'otelcol_exporter_sent_log_records', 'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_spans'];
    const missingFreshRequiredMetrics = requiredFreshMetrics.filter(metric =>
      !samplesByMetric[metric].timestampsUs.some(timestamp => timestamp > startTimeUs));
    const freshQueueSamples = missingFreshRequiredMetrics.length === 0;
    const positiveOutageLossMetrics = ['otelcol_exporter_send_failed_log_records', 'otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_send_failed_spans']
      .filter(metric => samplesByMetric[metric].timestampsUs.some(timestamp => timestamp >= lossStartTimeUs &&
        (lossEndTimeUs === undefined || timestamp < lossEndTimeUs)) && samplesByMetric[metric].values.some(value => value > 0));
    const outageLossSamples = positiveOutageLossMetrics.length > 0;
    const lossWindowEndedAtRestart = lossEndTimeUs !== undefined && lossEndTimeUs === startTimeUs;
    lastObservation = {
      metrics: Object.fromEntries(metricNames.map(metricName => {
        const sample = samplesByMetric[metricName];
        return [metricName, {
          available: sample.available,
          sampleCount: sample.sampleCount,
          latestTimestampUs: sample.timestampsUs.length ? Math.max(...sample.timestampsUs) : null,
          ...(sample.values.length ? {minimum: Math.min(...sample.values), maximum: Math.max(...sample.values)} : {}),
        }];
      })),
      missingFreshRequiredMetrics,
      positiveOutageLossMetrics,
      outageLossObserved: outageLossSamples,
      queueWithinBounds: queue.length > 0 && queue.every(value => value >= 0 && value <= queueCapacity),
      configuredCapacityObserved: capacity.some(value => value === queueCapacity),
      positiveSentMetrics: ['otelcol_exporter_sent_log_records', 'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_spans']
        .filter(metric => samplesByMetric[metric].values.some(value => value > 0)),
      freshRequiredMetricsObserved: freshQueueSamples,
    };
    if (queue.length === 0 || capacity.length === 0 || !capacity.some(value => value === queueCapacity) ||
        queue.some(value => value < 0 || value > queueCapacity) || !outageLossSamples || !sent.some(value => value > 0) || !freshQueueSamples)
      return false;
    return {
      status: 'PASS',
      service: 'otel-collector',
      queueCapacity,
      queueSampleCount: queue.length,
      queueMaximum: Math.max(...queue),
      capacitySampleCount: capacity.length,
      postRestartMetricTimestampsStrictlyAfterStartedAt: lossWindowEndedAtRestart,
      historicalLossMetricWindowEndedAtRestart: lossWindowEndedAtRestart,
      sendFailureSamples: Object.fromEntries(['log_records', 'metric_points', 'spans'].map(signal => [signal, samplesByMetric[`otelcol_exporter_send_failed_${signal}`]])),
      sentSamples: Object.fromEntries(['log_records', 'metric_points', 'spans'].map(signal => [signal, samplesByMetric[`otelcol_exporter_sent_${signal}`]])),
      enqueueFailureSamples: Object.fromEntries(['log_records', 'metric_points', 'spans'].map(signal => [signal, samplesByMetric[`otelcol_exporter_enqueue_failed_${signal}`]])),
      optionalMetricStreamsAbsent: ['log_records', 'metric_points', 'spans']
        .flatMap(signal => [`otelcol_exporter_enqueue_failed_${signal}`, `otelcol_exporter_send_failed_${signal}`, `otelcol_exporter_sent_${signal}`])
        .filter(metricName => !samplesByMetric[metricName].available),
    };
  }, {timeoutMs, intervalMs, description: 'Collector self-scrape queue, send-failure, and recovery counters'}); }
  catch (error) {
    if (error instanceof Error && lastObservation !== null)
      error.message += `; last bounded observation=${JSON.stringify(lastObservation)}`;
    throw error;
  }
}

function collectorExpiredRetryDropEvidence({name, startTimeUs}) {
  const since = new Date(Math.floor(startTimeUs / 1000)).toISOString();
  const logs = spawnSync('docker', ['logs', '--since', since, name], {
    encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (logs.error || logs.status !== 0) throw new Error('could not inspect Collector logs for expired retry evidence');
  const logLines = `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`.split('\n');
  const droppedLines = logLines.filter(line => /Exporting failed\. Dropping data\./iu.test(line) && /no more retries left/iu.test(line));
  const droppedItems = droppedLines.reduce((total, line) => total + Number(line.match(/"dropped_items"\s*:\s*(\d+)/u)?.[1] ?? 0), 0);
  if (droppedLines.length === 0 || droppedItems === 0)
    throw new Error('Collector outage did not reach the configured retry expiry and report a dropped batch');
  return {status: 'PASS', expiredRetryDropEvents: droppedLines.length, droppedItems};
}

function streamEntries(value) {
  if (Array.isArray(value)) return value;
  for (const key of ['data', 'list', 'streams', 'items']) {
    if (Array.isArray(value?.[key])) return value[key];
    const nested = value?.[key];
    if (nested !== null && typeof nested === 'object') {
      const entries = streamEntries(nested);
      if (entries.length > 0) return entries;
    }
  }
  return [];
}

async function fixtureHealth({baseUrl, path, budgetMs}) {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {signal: AbortSignal.timeout(budgetMs)});
  const latencyMs = performance.now() - started;
  if (!response.ok || latencyMs >= budgetMs) throw new Error(`fixture health ${path} failed HTTP ${response.status} in ${Math.round(latencyMs)}ms`);
  return Math.round(latencyMs);
}

async function setFixtureState({baseUrl, runId, active, oldTimestamp = false}) {
  return fixtureRequest({baseUrl, path: '/test/state', body: {active, oldTimestamp}, runId});
}

async function sourceDirectoryDigest(root, directory) {
  const files = [];
  const visit = async current => {
    let entries;
    try { entries = await readdir(current, {withFileTypes: true}); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  const absolute = join(root, directory);
  await visit(absolute);
  if (files.length === 0) return {status: 'UNAVAILABLE', fileCount: 0, sha256: null};
  const digest = createHash('sha256');
  for (const file of files) {
    const relativePath = file.slice(absolute.length + 1);
    const content = await readFile(file);
    digest.update(relativePath).update('\0').update(createHash('sha256').update(content).digest()).update('\0');
  }
  return {status: 'PASS', fileCount: files.length, sha256: digest.digest('hex')};
}

export async function sourceIdentity(root = REPO_ROOT) {
  const [configBytes, bomBytes] = await Promise.all([
    readFile(join(root, 'config/platform.yaml')),
    readFile(join(root, 'config/toolchain-versions.json')),
  ]);
  const bom = JSON.parse(bomBytes);
  let baseSha = null;
  let sourceFiles = [];
  let sourceListAvailable = false;
  try {
    baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    sourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: root, encoding: 'buffer'})
      .toString('utf8').split('\0').filter(Boolean).sort();
    sourceListAvailable = sourceFiles.length > 0;
  } catch {}
  const sourceDigest = createHash('sha256');
  let missingFiles = 0;
  for (const relativePath of sourceFiles) {
    sourceDigest.update(relativePath).update('\0');
    try {
      sourceDigest.update(createHash('sha256').update(await readFile(join(root, relativePath))).digest());
    } catch {
      missingFiles += 1;
      sourceDigest.update('missing');
    }
    sourceDigest.update('\0');
  }
  const runtimeArtifacts = Object.fromEntries(await Promise.all([
    'packages/platform-runtime/dist',
    'packages/platform-observability/dist',
  ].map(async directory => [directory, await sourceDirectoryDigest(root, directory)])));
  const configSha256 = createHash('sha256').update(configBytes).digest('hex');
  const bomSha256 = createHash('sha256').update(bomBytes).digest('hex');
  const sourceSha256 = sourceListAvailable ? sourceDigest.digest('hex') : null;
  const identityHash = sourceSha256 && Object.values(runtimeArtifacts).every(value => value.status === 'PASS')
    ? createHash('sha256').update(JSON.stringify({sourceSha256, configSha256, bomSha256, runtimeArtifacts})).digest('hex')
    : null;
  return {
    baseSha,
    configSha256,
    bomSha256,
    imageRefs: Object.fromEntries(['otelCollectorImage', 'openObserveImage', 'nodeImage', 'kafkaImage', 'nginxImage'].filter(key => bom[key] !== undefined).map(key => [key, bom[key]])),
    sourceFiles: {status: sourceListAvailable && missingFiles === 0 ? 'PASS' : 'UNAVAILABLE', fileCount: sourceFiles.length, missingFileCount: missingFiles, sha256: sourceSha256},
    runtimeArtifacts,
    identityHash,
  };
}

export function observabilityVerificationCoverage(evidence) {
  const launchRoles = [...new Set((evidence.launchPathProof?.roles ?? []).map(({role}) => role).filter(role => typeof role === 'string'))].sort();
  const launchNodeRuntimes = launchRoles.filter(role => NODE_RUNTIME_TARGETS.includes(role));
  const metricApplicability = evidence.metricApplicability ?? {};
  const convergenceProof = metricApplicability.aromaConvergenceProof;
  const matrixNodeRuntimes = evidence.runtimeMetricMatrix?.status === 'PASS'
    ? (evidence.runtimeMetricMatrix.runtimeMetrics?.roles ?? []).map(({role}) => role).filter(role => NODE_RUNTIME_TARGETS.includes(role))
    : [];
  return {
    verificationScope: 'issue-64-operations-predecessor',
    statusAppliesTo: 'issue-64 mandatory Operations backend and instrumentation gates',
    fullSystemG14: {
      status: 'NOT_RUN',
      owner: '#13',
      reason: 'Issue #64 verifies functional telemetry; full-system SLO, chaos, capacity and business launch acceptance remain owned by #13.',
      requiredNodeRuntimeCount: NODE_RUNTIME_TARGETS.length,
      launchPathNodeRuntimes: launchNodeRuntimes,
      metricMatrixNodeRuntimes: matrixNodeRuntimes,
      launchPathNativeNginx: launchRoles.includes('edge-nginx'),
      launchPathKafkaRole: launchRoles.includes('kafka'),
      convergenceMetricProof: {
        ownerRuntime: 'aroma-convergence',
        processKind: 'driver-container SQL-backed proof helper',
        status: convergenceProof === undefined ? 'NOT_RUN' : 'PASS',
      },
      observedOwnerMetricFamilies: Object.keys(metricApplicability).filter(name => name !== 'aromaConvergenceProof').sort(),
      nodeRuntimesNotClaimedAsLive: NODE_RUNTIME_TARGETS.filter(role => !launchNodeRuntimes.includes(role) && !matrixNodeRuntimes.includes(role)),
    },
  };
}

async function persistEvidence({root, evidence, secrets = []}) {
  const dir = join(root, 'evidence/observability', evidence.runId);
  const sanitize = value => secrets.reduce((result, secret) => secret ? result.replaceAll(secret, '[REDACTED]') : result, value);
  const statusArtifact = (status, details = {}) => ({runId: evidence.runId, status, ...details,
    ...(status === 'NOT_RUN' ? {reason: sanitize(evidence.failure ?? evidence.limitations[0] ?? 'criterion was not exercised')} : {})});
  const provenanceEnd = await sourceIdentity(root);
  const provenanceStart = evidence.provenanceStart;
  const sourceHashStable = provenanceStart?.identityHash !== null && provenanceStart?.identityHash === provenanceEnd.identityHash;
  if (evidence.status === 'PASS' && (!sourceHashStable || provenanceStart?.sourceFiles?.status !== 'PASS')) {
    evidence.status = 'FAIL';
    evidence.failure = 'tested source or compiled runtime digest was unavailable or changed during verification';
  }
  const alertState = evidence.alertTransitions ?? 'NOT_RUN';
  const redaction = evidence.redactionScan;
  const outage = evidence.outageRestart;
  const verificationCoverage = observabilityVerificationCoverage(evidence);
  const runtimeHealthGates = [
    evidence.runtimeMetricMatrix?.status,
    evidence.runtimeShutdownStatus,
    evidence.networkIsolation?.status,
    evidence.networkIsolation?.launchPathNetworkStatus,
    evidence.telemetryHealth?.openObserveOutage,
    evidence.telemetryHealth?.recoveryStatus,
    evidence.telemetryHealth?.launchPathCollectorConfig,
    evidence.telemetryHealth?.launchPathOutageStatus,
    evidence.collectorQueueMetrics?.status,
    evidence.processCounterRestart?.status,
    evidence.diskPressureStatus,
  ];
  const runtimeHealthStatus = runtimeHealthGates.every(status => status === 'PASS') && outage ? 'PASS' : evidence.status === 'FAIL' ? 'FAIL' : 'NOT_RUN';
  const documents = {
    'alert-transitions.json': statusArtifact(alertState, {alerts: evidence.alerts, inputMetrics: evidence.alertInputs ?? {}}),
    'correlation-proof.json': statusArtifact(evidence.launchPathCorrelation ?? 'NOT_RUN', {syntheticTraceCorrelation: (evidence.signals ?? []).some(signal => signal.includes('traces')) ? 'PASS' : 'NOT_RUN', syntheticSignals: evidence.signals ?? [], launchPath: evidence.launchPathProof ?? {}}),
    'redaction-scan.json': statusArtifact(redaction?.status ?? 'NOT_RUN', redaction ?? {}),
    'queue-loss-counters.json': statusArtifact(outage?.queueDrops > 0 && outage.producerExportFailureObserved === true &&
      outage.collectorExpiredRetryDrop?.status === 'PASS' && evidence.collectorQueueMetrics?.status === 'PASS' &&
      evidence.processCounterRestart?.status === 'PASS' ? 'PASS' : 'NOT_RUN', {
      ...(outage?.queueDrops === undefined ? {} : {droppedRecords: outage.queueDrops, producerExportFailureObserved: outage.producerExportFailureObserved}),
      collectorExpiredRetryDrop: outage?.collectorExpiredRetryDrop ?? {},
      collector: evidence.collectorQueueMetrics ?? {},
      processCounterRestart: evidence.processCounterRestart ?? {},
    }),
    'retention-result.json': statusArtifact(typeof evidence.retention === 'object' && evidence.retention.ttlRemovedRecord && evidence.diskPressureStatus === 'PASS' ? 'PASS' : 'NOT_RUN', {
      ...(typeof evidence.retention === 'object' ? evidence.retention : {}), diskPressure: evidence.diskPressure ?? {},
    }),
    'runtime-health-matrix.json': statusArtifact(runtimeHealthStatus, {
      ...verificationCoverage,
      ...outage,
      gracefulShutdown: evidence.runtimeShutdown ?? 'NOT_RUN',
      telemetryHealth: evidence.telemetryHealth ?? {},
      metricApplicability: evidence.metricApplicability ?? {},
      runtimeMetricMatrix: evidence.runtimeMetricMatrix ?? {status: 'NOT_RUN'},
      processCounterRestart: evidence.processCounterRestart ?? {},
      diskPressure: evidence.diskPressure ?? {},
      networkIsolation: evidence.networkIsolation ?? 'NOT_RUN',
      openObserveDisk: evidence.openObserveDisk ?? {},
      executionMode: evidence.executionMode,
    }),
  };
  await mkdir(dir, {recursive: true, mode: 0o700});
  for (const [name, artifact] of Object.entries(documents))
    await writeFile(join(dir, name), `${JSON.stringify(artifact, null, 2)}\n`, {mode: 0o600});
  if (evidence.hostTransport !== undefined)
    await writeFile(join(dir, 'host-transport.json'), `${JSON.stringify(evidence.hostTransport, null, 2)}\n`, {mode: 0o600});
  const result = { ...evidence, ...verificationCoverage, failure: evidence.failure === undefined ? undefined : sanitize(evidence.failure), provenance: {start: provenanceStart ?? null, end: provenanceEnd, sourceHashStable},
    commands: [{argv: [process.execPath, ...process.argv.slice(1)]}] };
  const resultBytes = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(join(dir, 'result.json'), resultBytes, {mode: 0o600});
  return {directory: dir, resultSha256: createHash('sha256').update(resultBytes).digest('hex')};
}

async function inspectEmulator(path) {
  if (!isAbsolute(path)) throw new Error('--emulator path must be absolute');
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o111) === 0) throw new Error('--emulator must be an executable regular file');
  const version = execFileSync(path, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000}).trim();
  if (!/^qemu-x86_64 version\s+\d+\.\d+/u.test(version)) throw new Error('--emulator must be a qemu-x86_64 user-mode binary');
  return {path, version: version.split('\n')[0], sha256: createHash('sha256').update(await readFile(path)).digest('hex')};
}

async function inspectHostTransport(path, {root, run, emulator, probeSha256}) {
  if (!isAbsolute(path)) throw new Error('--host-transport path must be absolute');
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error('--host-transport must be a regular file, not a symlink');
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const bomBytes = await readFile(join(root, 'config/toolchain-versions.json'));
  const bom = JSON.parse(bomBytes);
  const bomSha256 = createHash('sha256').update(bomBytes).digest('hex');
  if (raw.schemaVersion !== 1 || raw.bomSha256 !== bomSha256) throw new Error('isolated Docker host manifest does not match the current BOM');
  const expectedKeys = ['nodeImage', 'otelCollectorImage', 'openObserveImage'].sort();
  const images = raw.images;
  if (!Array.isArray(images) || images.length !== expectedKeys.length) throw new Error('isolated Docker host manifest must contain exactly the three pinned runtime images');
  const supplementalKeys = ['kafkaImage', 'nginxImage'].sort();
  const supplementalImages = raw.supplementalImages;
  if (!Array.isArray(supplementalImages) || supplementalImages.length !== supplementalKeys.length)
    throw new Error('isolated Docker host manifest must include the pinned Kafka and nginx fixture images');
  const expectedByKey = new Map([...expectedKeys, ...supplementalKeys].map(key => [key, bom[key]]));
  const sanitizedImages = [];
  for (const image of [...images, ...supplementalImages]) {
    if (!expectedByKey.has(image?.bomKey) || image.bomRef !== expectedByKey.get(image.bomKey) || image.sourceVerified !== true || !/^sha256:[a-f0-9]{64}$/u.test(image.imageId ?? ''))
      throw new Error('isolated Docker host manifest contains an unverified or unexpected image reference');
    const actualImageId = run(['image', 'inspect', '--format', '{{.Id}}', image.bomRef]);
    if (actualImageId !== image.imageId) throw new Error(`isolated Docker image identity mismatch for ${image.bomKey}`);
    expectedByKey.delete(image.bomKey);
    sanitizedImages.push({bomKey: image.bomKey, bomRef: image.bomRef, imageId: image.imageId, sourceVerified: true});
  }
  if (expectedByKey.size !== 0) throw new Error('isolated Docker host manifest is missing a required runtime image');
  const toolchainCache = raw.toolchainCache;
  if (!Array.isArray(toolchainCache) || toolchainCache.length !== 1) throw new Error('isolated Docker host manifest must include its separate BuildKit toolchain cache');
  const buildkit = toolchainCache[0];
  if (buildkit?.name !== 'buildkit' || !/^moby\/buildkit:[^@]+@sha256:[a-f0-9]{64}$/u.test(buildkit.imageRef ?? '') ||
      !/^sha256:[a-f0-9]{64}$/u.test(buildkit.imageId ?? '') || buildkit.sourceVerified !== true)
    throw new Error('isolated Docker host manifest contains an unverified or mutable BuildKit cache reference');
  if (run(['image', 'inspect', '--format', '{{.Id}}', buildkit.imageId]) !== buildkit.imageId)
    throw new Error('isolated Docker BuildKit cache identity mismatch');
  if (!['tmpfs', 'loop-ext4'].includes(raw.dataRootBacking) || typeof raw.dockerVersion !== 'string' || typeof raw.storageDriver !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.shimSha256 ?? ''))
    throw new Error('isolated Docker host manifest is missing required transport attestations');
  if (raw.probeSha256 !== probeSha256) throw new Error('isolated Docker host probe digest does not match the pinned helper');
  if (emulator !== undefined && raw.qemuSha256 !== emulator.sha256) throw new Error('isolated Docker host QEMU digest does not match the selected emulator');
  return {
    path,
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
    schemaVersion: 1,
    bomSha256,
    images: sanitizedImages.filter(image => expectedKeys.includes(image.bomKey)),
    supplementalImages: sanitizedImages.filter(image => supplementalKeys.includes(image.bomKey)),
    toolchainCache: [{name: buildkit.name, imageRef: buildkit.imageRef, imageId: buildkit.imageId, sourceVerified: true}],
    shimSha256: raw.shimSha256,
    dockerVersion: raw.dockerVersion,
    storageDriver: raw.storageDriver,
    dataRootBacking: raw.dataRootBacking,
    qemuSha256: raw.qemuSha256,
    probeSha256: raw.probeSha256,
  };
}

export async function runObservabilityVerification({root = REPO_ROOT, run = docker, emulatorPath, probePath = '/usr/bin/busybox', hostTransportPath} = {}) {
  const runId = newRunId();
  const provenanceStart = await sourceIdentity(root);
  const absentFeatures = missingCpuFeatures(await readFile('/proc/cpuinfo', 'utf8'));
  const emulator = emulatorPath === undefined ? undefined : await inspectEmulator(emulatorPath);
  const openObserveFixtureCpuLimit = emulator === undefined ? 2 : 4;
  if (!isAbsolute(probePath)) throw new Error('--probe path must be absolute');
  const probeSha256 = createHash('sha256').update(await readFile(probePath)).digest('hex');
  const hostTransport = hostTransportPath === undefined ? undefined : await inspectHostTransport(hostTransportPath, {root, run, emulator, probeSha256});
  if (absentFeatures.length > 0 && emulator === undefined) {
    const evidence = {
      runId, status: 'FAIL', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      provenanceStart,
      failure: `OpenObserve native execution requires CPU features absent on this host: ${absentFeatures.join(', ')}`,
      executionMode: 'native-preflight-blocked',
      missingCpuFeatures: absentFeatures,
      nativeAlerts: 'NOT_RUN', streamDelivery: 'NOT_RUN', ingestionScope: 'NOT_RUN', retentionExpiry: 'NOT_RUN',
      collectorOutageRestart: 'NOT_RUN', launchPathCorrelation: 'NOT_RUN',
      limitations: ['CPU preflight stopped the runner before creating containers, volumes, credentials, or other Docker resources.'],
    };
    const persisted = await persistEvidence({root, evidence});
    evidence.evidenceDirectory = persisted.directory;
    evidence.resultSha256 = persisted.resultSha256;
    throw Object.assign(new Error(evidence.failure), {evidence});
  }
  const project = safeName(`coffee-g14-${runId}`);
  const workDir = await mkdtemp(`/dev/shm/${project}-`);
  const createdNetworks = [];
  let storage;
  const containers = [];
  const cleanupErrors = [];
  const sensitiveValues = [];
  const evidence = {runId, startedAt: new Date().toISOString(), provenanceStart, alerts: [], signals: [], retention: 'NOT_RUN', limitations: [], containerDiagnostics: []};
  evidence.executionMode = emulator === undefined ? 'native' : 'qemu-user-emulation';
  evidence.openObserveResourceLimits = {expectedCpuLimitCores: openObserveFixtureCpuLimit, expectedMemoryLimitMiB: null, status: 'NOT_RUN'};
  if (emulator !== undefined) evidence.emulator = {path: emulator.path, version: emulator.version, sha256: emulator.sha256, startupVerified: false, capacityEvidence: 'NOT_CLAIMED', hostCpuFeaturesMissing: absentFeatures};
  evidence.bootstrapProbe = {path: probePath, sha256: 'unverified'};
  if (hostTransport !== undefined) evidence.hostTransport = hostTransport;
  const add = name => containers.push(name);
  const stop = name => {
    try { run(['rm', '-f', name]); }
    catch (error) {
      try {
        if (run(['ps', '-aq', '--filter', `name=^${name}$`])) cleanupErrors.push(`cannot remove fixture container ${name}: ${error.message}`);
      } catch (inspectError) { cleanupErrors.push(`cannot verify removal of fixture container ${name}: ${inspectError.message}`); }
    }
  };
  try {
    evidence.hostTools = inspectFixtureTools();
    if (evidence.hostTools.status !== 'PASS')
      throw new Error(`fixture host is missing required tools: ${evidence.hostTools.missing.join(', ')}`);
    const config = await loadPlatformConfig(root);
    const toolchain = JSON.parse(await readFile(join(root, 'config/toolchain-versions.json'), 'utf8'));
    for (const key of ['otelCollectorImage', 'openObserveImage', 'nodeImage']) {
      if (!/@sha256:[a-f0-9]{64}$/u.test(toolchain[key] ?? '')) throw new Error(`${key} must be an immutable BOM image ref`);
    }
    const bootstrapProbeSha256 = toolchain.bootstrapProbeSha256;
    const actualBootstrapProbeSha256 = createHash('sha256').update(await readFile(probePath)).digest('hex');
    if (actualBootstrapProbeSha256 !== bootstrapProbeSha256) throw new Error('local bootstrap probe digest does not match its BOM authority');
    evidence.bootstrapProbe.sha256 = actualBootstrapProbeSha256;
    const adminPassword = `G14-aA1!${randomBytes(32).toString('base64url')}`;
    const producerToken = randomBytes(32).toString('base64url');
    const redactionCanary = `g14-secret-${randomBytes(24).toString('hex')}`;
    sensitiveValues.push(adminPassword, producerToken, redactionCanary);
    const passwordPath = join(workDir, 'admin-password');
    const sinkPath = join(workDir, 'alert-events.jsonl');
    await writeFile(passwordPath, `${adminPassword}\n`, {mode: 0o400});
    await writeFile(sinkPath, '', {mode: 0o600});
    const storageName = `${project}-data`;
    storage = provisionStorage({name: storageName, maxDiskBytes: config.telemetry.openObserve.maxDiskBytes, nodeImage: toolchain.nodeImage, run});
    await initializeOpenObserve({
      config,
      imageRefs: {openObserveImage: toolchain.openObserveImage, nodeImage: toolchain.nodeImage, bootstrapProbeSha256},
      openObserveDataVolume: storage.volumeName,
      adminSecretPath: passwordPath,
      probePath,
      ...(emulator === undefined ? {} : {emulatorPath: emulator.path}),
      runDocker: args => run(args),
    });
    const backendNetwork = `${project}-backend`;
    const producerNetwork = `${project}-producer`;
    for (const network of [backendNetwork, producerNetwork]) {
      run(['network', 'create', '--driver', 'bridge', '--internal', '--opt', 'com.docker.network.bridge.enable_ip_masquerade=false', '--label', 'coffee.owner=operations', network]);
      createdNetworks.push(network);
    }

    const openObserveName = `${project}-openobserve`;
    const runtimeCredentialPlaceholder = config.telemetry.openObserve.validationMarker;
    if (typeof runtimeCredentialPlaceholder !== 'string' || runtimeCredentialPlaceholder.length === 0)
      throw new Error('telemetry.openObserve.validationMarker must be configured for isolated runtime validation');
    const openObserve = config.telemetry.openObserve;
    evidence.openObserveResourceLimits.expectedMemoryLimitMiB = openObserve.memoryLimitMiB;
    if (openObserve.telemetryEnabled !== false || openObserve.mmdbDownloadEnabled !== false || openObserve.modelPricingEnabled !== false)
      throw new Error('isolated OpenObserve must disable telemetry and optional external GeoIP/model-pricing downloads');
    const fixtureIngestWindowHours = config.telemetry.openObserve.retentionDays * 24 + 48;
    add(openObserveName);
    const emulatorMount = emulator === undefined ? [] : ['--mount', `type=bind,source=${emulator.path},target=/run/tools/qemu-x86_64,readonly`];
    run(['run', '-d', '--name', openObserveName, '--network', backendNetwork, '--network-alias', 'openobserve',
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cpus', String(openObserveFixtureCpuLimit), '--memory', `${openObserve.memoryLimitMiB}m`, '--pids-limit', '128',
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
      '--mount', `type=volume,source=${storage.volumeName},target=/data`,
      '--mount', `type=bind,source=${probePath},target=/busybox,readonly`,
      '--user', '10001:10001', '--env', 'ZO_LOCAL_MODE=true', '--env', 'ZO_DATA_DIR=/data', '--env', 'ZO_HTTP_PORT=5080',
      '--env', `ZO_ROOT_USER_EMAIL=${config.telemetry.openObserve.bootstrapEmail}`,
      '--env', `ZO_ROOT_USER_PASSWORD=${runtimeCredentialPlaceholder}`,
      ...Object.entries(openObserveBufferEnvironment(openObserve)).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      '--env', `ZO_TELEMETRY=${openObserve.telemetryEnabled}`,
      '--env', `ZO_MMDB_DISABLE_DOWNLOAD=${!openObserve.mmdbDownloadEnabled}`,
      '--env', `ZO_MODEL_PRICING_ENABLED=${openObserve.modelPricingEnabled}`,
      '--env', `ZO_COMPACT_INTERVAL=${config.telemetry.openObserve.compactionIntervalSeconds}`,
      '--env', `ZO_COMPACT_DATA_RETENTION_INTERVAL=${config.telemetry.openObserve.compactionIntervalSeconds}`,
      '--env', `ZO_COMPACT_DATA_RETENTION_DAYS=${config.telemetry.openObserve.retentionDays}`,
      '--env', `ZO_COMPACT_JOB_CLEAN_WAIT_TIME=${config.telemetry.openObserve.jobCleanupWaitSeconds}`,
      '--env', `ZO_COMPACT_DELETE_FILES_DELAY_MINUTES=${config.telemetry.openObserve.deleteFilesDelayMinutes}`,
      '--env', `ZO_INGEST_ALLOWED_UPTO=${fixtureIngestWindowHours}`,
      '--env', 'ZO_DISK_CIRCUIT_BREAKER_ENABLED=true',
      '--env', `ZO_DISK_CIRCUIT_BREAKER_THRESHOLD=${config.telemetry.openObserve.diskWatermarkPercent}`,
      '--env', 'ZO_SSRF_ALLOW_LOOPBACK=true', ...emulatorMount,
      '--entrypoint', '/busybox', toolchain.openObserveImage, 'sh', '-ceu',
      emulator === undefined ? 'exec /openobserve' : 'exec /run/tools/qemu-x86_64 -cpu max /openobserve',
    ]);
    const openObserveIp = run(['inspect', '--format', `{{(index .NetworkSettings.Networks "${backendNetwork}").IPAddress}}`, openObserveName]);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(openObserveIp)) throw new Error('could not resolve OpenObserve on its isolated backend network');
    const baseUrl = `http://${openObserveIp}:5080`;
    const authorization = basicAuthorization(config.telemetry.openObserve.bootstrapEmail, adminPassword);
    const configuredOrganization = config.telemetry.openObserve.organization;
    try {
      await waitFor(async () => {
        requireRunning({run, name: openObserveName, secrets: sensitiveValues});
        const response = await fetch(new URL('/healthz', baseUrl), {signal: AbortSignal.timeout(1500)}).catch(error => {
          throw new Error(`health endpoint unavailable (${error.cause?.code ?? error.name})`);
        });
        return response.ok;
      }, {timeoutMs: 60000, intervalMs: 1000, description: 'OpenObserve normal non-root restart health'});
    } catch (error) {
      const innerHealth = spawnSync('docker', ['exec', openObserveName, '/busybox', 'wget', '-q', '--spider', '-T', '2', 'http://127.0.0.1:5080/healthz'], {
        encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const bindings = JSON.parse(run(['inspect', '--format', '{{json .HostConfig.PortBindings}}', openObserveName]));
      const networkNames = Object.keys(JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', openObserveName])));
      const startupLogs = spawnSync('docker', ['logs', '--tail', '120', openObserveName], {
        encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      evidence.normalStartupDiagnosis = {
        containerLoopbackHealth: !innerHealth.error && innerHealth.status === 0 ? 'PASS' : 'FAIL',
        containerLoopbackExitCode: innerHealth.status ?? null,
        publishedPortCount: Object.values(bindings ?? {}).flat().length,
        attachedNetworkCount: networkNames.length,
        attachedOnlyToBackend: networkNames.length === 1 && networkNames[0] === backendNetwork,
        backendAddressPresent: Boolean(openObserveIp),
        startupMilestones: sanitizedStartupMilestones(`${startupLogs.stdout ?? ''}\n${startupLogs.stderr ?? ''}`, sensitiveValues),
      };
      error.message += `; container loopback health=${evidence.normalStartupDiagnosis.containerLoopbackHealth}; published ports=${evidence.normalStartupDiagnosis.publishedPortCount}; backend address present=${evidence.normalStartupDiagnosis.backendAddressPresent}`;
      throw error;
    }
    evidence.containerDiagnostics.push({
      ...captureContainerDiagnostics({name: openObserveName, stage: 'normal-startup', secrets: sensitiveValues}),
      cgroup: openObserveCgroupDiagnostics(openObserveName),
    });
    if (emulator !== undefined) evidence.emulator.startupVerified = true;
    const openObserveHostLimits = run(['inspect', '--format', '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}', openObserveName]).split('|').map(Number);
    const expectedNanoCpus = openObserveFixtureCpuLimit * 1_000_000_000;
    const expectedMemoryBytes = openObserve.memoryLimitMiB * 1024 * 1024;
    evidence.openObserveResourceLimits = {
      expectedCpuLimitCores: openObserveFixtureCpuLimit,
      actualNanoCpus: openObserveHostLimits[0],
      expectedMemoryLimitMiB: openObserve.memoryLimitMiB,
      actualMemoryBytes: openObserveHostLimits[1],
      status: openObserveHostLimits[0] === expectedNanoCpus && openObserveHostLimits[1] === expectedMemoryBytes ? 'PASS' : 'FAIL',
    };
    if (evidence.openObserveResourceLimits.status !== 'PASS') throw new Error('OpenObserve fixture resource limits do not match the expected CPU quota and configured memory limit');
    const normalEnvironment = JSON.parse(run(['inspect', '--format', '{{json .Config.Env}}', openObserveName]));
    const normalMounts = JSON.parse(run(['inspect', '--format', '{{json .Mounts}}', openObserveName]));
    const openObserveBindings = JSON.parse(run(['inspect', '--format', '{{json .HostConfig.PortBindings}}', openObserveName]));
    const openObserveNetworks = Object.keys(JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', openObserveName])));
    const backendPrivateOnly = Object.values(openObserveBindings ?? {}).flat().length === 0 && openObserveNetworks.length === 1 && openObserveNetworks[0] === backendNetwork;
    if (!backendPrivateOnly) throw new Error('OpenObserve fixture must have no host bindings and attach only to its isolated backend network');
    evidence.openObserveDisk = openObserveDiskDiagnostics({run, name: openObserveName});
    if (!normalEnvironment.includes(`ZO_ROOT_USER_PASSWORD=${runtimeCredentialPlaceholder}`) || normalEnvironment.some(value => value.includes(adminPassword)) ||
        Object.entries(openObserveBufferEnvironment(openObserve)).some(([name, value]) => !normalEnvironment.includes(`${name}=${value}`)) ||
        !normalEnvironment.includes('ZO_TELEMETRY=false') || !normalEnvironment.includes('ZO_MMDB_DISABLE_DOWNLOAD=true') ||
        !normalEnvironment.includes('ZO_MODEL_PRICING_ENABLED=false'))
      throw new Error('normal OpenObserve runtime received unexpected bootstrap credentials or optional network features are enabled');
    if (normalMounts.some(mount => mount.Destination === '/admin-secret'))
      throw new Error('normal OpenObserve runtime unexpectedly received the bootstrap admin secret file');
    const placeholderAuthorization = basicAuthorization(config.telemetry.openObserve.bootstrapEmail, runtimeCredentialPlaceholder);
    await api({baseUrl, authorization: placeholderAuthorization, path: '/api/organizations', sensitiveValues, expected: [401, 403]});
    evidence.bootstrapSecretHandling = {status: 'PASS', bootstrapAdminCredentialAbsentFromRuntime: true, placeholderBasicAuthRejected: true,
      externalTelemetryDisabled: true, mmdbDownloadsDisabled: true, modelPricingDownloadsDisabled: true};

    const createdOrganization = await api({baseUrl, authorization, path: '/api/organizations', method: 'POST', sensitiveValues, body: {
      identifier: configuredOrganization, name: 'Coffee', org_type: 'default',
    }, expected: [200]});
    const organizations = await api({baseUrl, authorization, path: '/api/organizations', sensitiveValues});
    const listedOrganizations = Array.isArray(organizations?.data) ? organizations.data.map(item => item.identifier).filter(value => typeof value === 'string') : [];
    const organization = createdOrganization?.identifier ?? createdOrganization?.organization?.identifier;
    evidence.organizationCheck = {
      configuredIdentifier: configuredOrganization,
      runtimeIdentifier: organization ?? null,
      visibleAfterCreate: typeof organization === 'string' && listedOrganizations.includes(organization),
    };
    if (!evidence.organizationCheck.visibleAfterCreate) throw new Error('OpenObserve organization create response did not make its runtime identifier visible to root');
    config.telemetry.openObserve.organization = organization;
    const tokenResponse = await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/ingestion-tokens`, method: 'POST', sensitiveValues, body: {
      name: 'otel-collector', description: 'Collector-only OTLP ingestion', splunk_token: false,
    }, expected: [200, 201]});
    const openObserveToken = tokenResponse?.data?.token;
    if (typeof openObserveToken !== 'string' || !openObserveToken.startsWith('o2oi_')) throw new Error('OpenObserve did not return a scoped ingestion token');
    sensitiveValues.push(openObserveToken);
    const ingestAuthorization = basicAuthorization('coffee', openObserveToken);
    await api({baseUrl, authorization: ingestAuthorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues, expected: [401, 403]});
    evidence.ingestionTokenScope = 'management-api-rejected';

    const producerName = `${project}-synthetic-runtime`;
    add(producerName);
    const fixtureConfigPath = join(workDir, 'runtime-fixture.json');
    const fixtureConfig = structuredClone(config);
    fixtureConfig.telemetry.environment = fixtureConfig.environment;
    fixtureConfig.telemetry.collector.otlpEndpoint = 'http://otel-collector:4318';
    await writeFile(fixtureConfigPath, JSON.stringify({config: fixtureConfig, runId, exporterToken: producerToken, redactionCanary}) + '\n', {mode: 0o400});
    run(['run', '-d', '--name', producerName, '--network', producerNetwork,
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cpus', '0.5', '--memory', '256m', '--pids-limit', '32',
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--user', `${process.getuid()}:${process.getgid()}`,
      '--log-driver', 'json-file', '--log-opt', `max-size=${config.telemetry.logging.maxSizeMiB}m`, '--log-opt', `max-file=${config.telemetry.logging.maxFiles}`,
      '--label', `com.docker.compose.project=${project}`, '--label', 'com.docker.compose.service=edge-gateway',
      '--mount', `type=bind,source=${join(root, 'node_modules')},target=/repo/node_modules,readonly`,
      '--mount', `type=bind,source=${join(root, 'packages')},target=/repo/packages,readonly`,
      '--mount', `type=bind,source=${join(root, 'tests/observability/fixture.mjs')},target=/fixture.mjs,readonly`,
      '--mount', `type=bind,source=${fixtureConfigPath},target=/fixture-config.json,readonly`,
      '--entrypoint', 'node', toolchain.nodeImage, '/fixture.mjs', '/fixture-config.json']);
    const producerIp = run(['inspect', '--format', `{{(index .NetworkSettings.Networks "${producerNetwork}").IPAddress}}`, producerName]);
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(producerIp)) throw new Error('could not resolve synthetic producer on its isolated network');
    const producerNetworks = Object.keys(JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', producerName])));
    const producerBindings = JSON.parse(run(['inspect', '--format', '{{json .HostConfig.PortBindings}}', producerName]));
    if (producerNetworks.length !== 1 || producerNetworks[0] !== producerNetwork || Object.values(producerBindings ?? {}).flat().length !== 0)
      throw new Error('synthetic producer fixture must have no host bindings and attach only to its isolated producer network');
    const fixtureBaseUrl = `http://${producerIp}:4310`;
    await waitFor(async () => {
      requireRunning({run, name: producerName, secrets: sensitiveValues});
      const response = await fetch(new URL(config.platform.health.readyPath, fixtureBaseUrl), {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
      return response?.ok;
    }, {timeoutMs: 30000, intervalMs: 500, description: 'canonical Fastify synthetic runtime readiness'});
    const logFiles = await discoverContainerLogs({projectName: project, runtimes: ['edge-gateway'], runDocker: run});
    evidence.nginxMetrics = logFiles.some(({service}) => service === 'edge-nginx') ? 'PASS' : 'NOT_RUN';
    const collectorConfig = createCollectorConfig({config, logFiles, exporterToken: producerToken, openObserveIngestToken: openObserveToken});
    // Fixture-only timestamp mapping makes a synthetic Pino `time` field exercise backend TTL.
    const fixtureTimeParser = collectorConfig.receivers.filelog.operators.find(operator => operator.id === 'producer_time');
    if (!fixtureTimeParser) throw new Error('Collector config lacks the conditional producer timestamp parser');
    fixtureTimeParser.if = 'body.g14_fixture == true && body.time != nil';
    const collectorConfigPath = join(workDir, 'collector.yaml');
    const collectorName = `${project}-collector`;
    const collectorPhases = [];
    let collectorIp;
    let collectorHealthEndpoint;
    const restoreCollectorConfigOwnership = (uid, gid, mode) => run([
      'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
      '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '32',
      '--mount', `type=bind,source=${collectorConfigPath},target=/collector-config`,
      '--entrypoint', 'node', toolchain.nodeImage, '-e',
      `const fs=require('node:fs');fs.chownSync('/collector-config',0,0);fs.chmodSync('/collector-config',${mode});fs.chownSync('/collector-config',${uid},${gid});`,
    ]);
    const startCollector = async (selectedLogs, stage, selectedConfig, extraNetworks = []) => {
      restoreCollectorConfigOwnership(1000, 1000, 0o600);
      await writeFile(collectorConfigPath, dumpYaml(selectedConfig, {noRefs: true, lineWidth: 120}), {mode: 0o600});
      restoreCollectorConfigOwnership(0, 0, 0o400);
      const logMounts = selectedLogs.map(log => ({
        source: dirname(log.logPath), destination: `/var/lib/docker/containers/${log.containerId}`, containerId: log.containerId,
      }));
      const mountArgs = logMounts.flatMap(({source, destination}) => ['--mount', `type=bind,source=${source},target=${destination},readonly`]);
      run(['run', '-d', '--name', collectorName, '--network', backendNetwork,
        '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cpus', '1', '--memory', `${config.telemetry.collector.memoryLimitMiB + config.telemetry.collector.memorySpikeMiB}m`, '--pids-limit', '128',
        '--log-driver', 'json-file', '--log-opt', `max-size=${config.telemetry.logging.maxSizeMiB}m`, '--log-opt', `max-file=${config.telemetry.logging.maxFiles}`,
        '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL', '--user', '0:0', '--network-alias', 'otel-collector',
        '--mount', `type=bind,source=${collectorConfigPath},target=/etc/otelcol-contrib/config.yaml,readonly`, ...mountArgs,
        toolchain.otelCollectorImage, '--config=/etc/otelcol-contrib/config.yaml']);
      run(['network', 'connect', '--alias', 'otel-collector', producerNetwork, collectorName]);
      const networks = [backendNetwork, producerNetwork, ...extraNetworks].sort();
      for (const network of extraNetworks) run(['network', 'connect', '--alias', 'otel-collector', network, collectorName]);
      const actualNetworks = Object.keys(JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', collectorName]))).sort();
      const bindings = JSON.parse(run(['inspect', '--format', '{{json .HostConfig.PortBindings}}', collectorName]));
      const mounts = JSON.parse(run(['inspect', '--format', '{{json .Mounts}}', collectorName]));
      const bindMounts = mounts.filter(mount => mount.Type === 'bind').map(({Source, Destination, RW}) => ({source: resolve(Source), destination: Destination, readOnly: RW === false}));
      const expectedBindMounts = [
        {source: resolve(collectorConfigPath), destination: '/etc/otelcol-contrib/config.yaml', readOnly: true},
        ...logMounts.map(({source, destination}) => ({source: resolve(source), destination, readOnly: true})),
      ].sort((a, b) => a.destination.localeCompare(b.destination));
      bindMounts.sort((a, b) => a.destination.localeCompare(b.destination));
      const hostConfig = JSON.parse(run(['inspect', '--format', '{{json .HostConfig}}', collectorName]));
      const containerConfig = JSON.parse(run(['inspect', '--format', '{{json .Config}}', collectorName]));
      const configStat = await lstat(collectorConfigPath);
      const configRootReadonly = configStat.uid === 0 && configStat.gid === 0 && (configStat.mode & 0o777) === 0o400;
      const safeRuntime = hostConfig.ReadonlyRootfs === true && hostConfig.Privileged !== true &&
        containerConfig.User === '0:0' && hostConfig.CapDrop?.includes('ALL') === true &&
        (hostConfig.CapAdd ?? []).length === 0 && hostConfig.PidMode !== 'host' && hostConfig.NetworkMode !== 'host' &&
        hostConfig.SecurityOpt?.includes('no-new-privileges:true') === true && configRootReadonly;
      if (JSON.stringify(actualNetworks) !== JSON.stringify(networks) || Object.values(bindings ?? {}).flat().length !== 0 ||
          JSON.stringify(bindMounts) !== JSON.stringify(expectedBindMounts) || !safeRuntime)
        throw new Error(`Collector ${stage} mounts, networks, or privilege restrictions did not match the selected exact logs`);
      collectorIp = run(['inspect', '--format', `{{(index .NetworkSettings.Networks "${backendNetwork}").IPAddress}}`, collectorName]);
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(collectorIp)) throw new Error(`could not resolve Collector health address during ${stage}`);
      collectorHealthEndpoint = `http://${collectorIp}:13133`;
      collectorPhases.push({stage, selectedServices: selectedLogs.map(({service}) => service).sort(),
        mountedContainerIds: logMounts.map(({containerId}) => containerId).sort(), bindMountsReadOnly: true,
        healthAddress: `${collectorIp}:13133`, networks: actualNetworks, hostBindingsAbsent: true, rootUser: true, readOnlyRoot: true,
        configRootOwnedMode0400: true, capabilitiesDropped: true, noNewPrivileges: true});
    };
    await writeFile(collectorConfigPath, dumpYaml(collectorConfig, {noRefs: true, lineWidth: 120}), {mode: 0o600});
    // Docker's json-file logs are root-readable, so the Collector needs UID 0.
    // Keep its capability set empty and its mounted config and logs read-only.
    add(collectorName);
    await startCollector(logFiles, 'initial-startup', collectorConfig);
    evidence.collectorPhases = collectorPhases;

    const networkProbe = JSON.parse(run(['exec', producerName, 'node', '-e',
      'const urls=process.argv.slice(1);Promise.all(urls.map(async url=>{try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});return {blocked:false,status:response.status};}catch{return {blocked:true};}})).then(results=>process.stdout.write(JSON.stringify(results)));',
      'http://openobserve:5080/healthz', `http://${openObserveIp}:5080/healthz`]));
    if (!Array.isArray(networkProbe) || networkProbe.length !== 2 || networkProbe.some(result => result.blocked !== true))
      throw new Error('synthetic application network can reach the isolated OpenObserve management/data endpoint');
    evidence.networkIsolation = {
      status: 'PASS', producerOpenObserveDnsBlocked: networkProbe[0].blocked, producerOpenObserveIpBlocked: networkProbe[1].blocked,
      managementEndpointScope: 'isolated-runner-to-private-backend-ip',
      managementEndpoints: [
        {service: 'openobserve', address: `${openObserveIp}:5080`, network: backendNetwork, hostBindingsAbsent: true},
        {service: 'otel-collector', address: `${collectorIp}:13133`, network: backendNetwork, hostBindingsAbsent: true},
        {service: 'synthetic-runtime', address: `${producerIp}:4310`, network: producerNetwork, hostBindingsAbsent: true},
      ],
      openObserveHostBindingsAbsent: true, openObserveAttachedOnlyToBackend: true,
      collectorHostBindingsAbsent: true, collectorAttachedOnlyToFixtureNetworks: true,
      producerHostBindingsAbsent: true, producerAttachedOnlyToProducerNetwork: true,
    };

    const sinkName = `${project}-alert-sink`;
    add(sinkName);
    run(['run', '-d', '--name', sinkName, `--network=container:${openObserveName}`,
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m', '--cpus', '0.25', '--memory', '64m', '--pids-limit', '16',
      '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
      '--mount', `type=bind,source=${resolve(dirname(fileURLToPath(import.meta.url)), 'alert-sink.mjs')},target=/alert-sink.mjs,readonly`,
      '--mount', `type=bind,source=${sinkPath},target=/evidence/alert-events.jsonl`,
      toolchain.nodeImage, 'node', '/alert-sink.mjs', '/evidence/alert-events.jsonl']);

    await waitFor(async () => {
      requireRunning({run, name: collectorName, secrets: sensitiveValues});
      const response = await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
      return response?.ok;
    }, {timeoutMs: 30000, description: 'Collector health'});
    evidence.containerDiagnostics.push(captureContainerDiagnostics({name: collectorName, stage: 'initial-startup', secrets: sensitiveValues}));
    const correlationHeaders = { 'x-correlation-id': runId, traceparent: `00-${runId.replaceAll('-', '').padEnd(32, '0')}-0123456789abcdef-01` };
    const sampleResponse = await fetch(new URL('/synthetic', fixtureBaseUrl), {method: 'POST', headers: correlationHeaders, signal: AbortSignal.timeout(5000)});
    if (!sampleResponse.ok) throw new Error(`synthetic fixture request returned HTTP ${sampleResponse.status}`);
    try {
      await verifySignal({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.logs, runId, field: 'body_g14_run_id'});
      await verifySignal({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.traces, runId: runId.replaceAll('-', ''), field: 'trace_id', streamType: 'traces'});
      await verifyMetricSignal({baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_runtime_ready`});
      const {summary: healthSummary} = await waitForHealthyHttpCheckMetrics({
        baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_httpcheck_status`,
        description: 'initial native readiness metrics for OpenObserve and Collector',
      });
      if (!healthSummary.healthyOpenObserve || !healthSummary.healthyCollector) throw new Error(`initial native readiness samples were not healthy: ${JSON.stringify(healthSummary)}`);
      evidence.telemetryHealth = {initial: healthSummary, openObserveOutage: 'NOT_RUN', recovered: 'NOT_RUN'};
    } catch (error) {
      let collectorLogs = '';
      let streamNames = [];
      let producerTelemetry = {};
      let collectorSpans = [];
      try {
        const logResult = spawnSync('docker', ['logs', '--tail', '80', collectorName], {
          encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (logResult.error) throw logResult.error;
        collectorLogs = sanitizedDiagnostics(`${logResult.stdout ?? ''}\n${logResult.stderr ?? ''}`, sensitiveValues);
      } catch {}
      try {
        const streams = await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues});
        streamNames = streamEntries(streams).map(stream => stream?.name).filter(value => typeof value === 'string');
      } catch {}
      try {
        const response = await fetch(new URL('/test/diagnostics', fixtureBaseUrl), {signal: AbortSignal.timeout(2000)});
        if (response.ok) producerTelemetry = await response.json();
      } catch {}
      collectorSpans = await collectorTraceCounters({baseUrl, authorization, organization, metricsPrefix: config.telemetry.openObserve.streams.metrics});
      error.message += `; diagnostic streams=${JSON.stringify(streamNames)}; producerTelemetry=${JSON.stringify(producerTelemetry)}; collectorSpanCounters=${JSON.stringify(collectorSpans)}${collectorLogs ? `; sanitized collector logs: ${collectorLogs}` : ''}`;
      throw error;
    }
    const producerRedaction = inspectProducerRedaction({name: producerName, runId, redactionCanary});
    if (!producerRedaction.matchingRunId || !producerRedaction.redactedToken || producerRedaction.canaryLeaked)
      throw new Error(`synthetic Pino pre-export redaction failed: ${JSON.stringify(producerRedaction)}`);
    const redactedLogs = await verifySignal({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.logs, runId, field: 'body_g14_run_id'});
    const backendRows = rows(await streamSearch({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.logs, runId, field: 'body_g14_run_id'}));
    const backendSummary = summarizeLogRows(backendRows, {runId, redactionCanary});
    const backendSensitiveFieldPresent = backendRows.some(record => containsSensitiveField(record));
    if (!redactedLogs || backendSummary.canaryLeaked || !backendSummary.runIdObserved || backendSensitiveFieldPresent)
      throw new Error(`synthetic redaction did not hold through OpenObserve: ${JSON.stringify({...backendSummary, sensitiveFieldPresent: backendSensitiveFieldPresent})}`);
    evidence.redactionScan = {status: 'PASS', producerRedaction: 'PASS', producerCanaryLeaked: false, backendCanaryLeaked: false, backendSensitiveFieldPresent: false, matchingProducerRecords: producerRedaction.recordsScanned};
    evidence.signals = ['canonical Pino filelog JSON → configured logs stream', 'Fastify request spans via OTLP → configured traces stream', `OpenTelemetry SDK metrics via OTLP → ${config.telemetry.openObserve.streams.metrics}_* metric streams`];

    const streamInventory = await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues});
    const retentionStreams = new Map([
      [config.telemetry.openObserve.streams.logs, 'logs'],
      [config.telemetry.openObserve.streams.traces, 'traces'],
      ...streamEntries(streamInventory)
        .filter(stream => stream?.stream_type === 'metrics' && stream?.name?.startsWith(`${config.telemetry.openObserve.streams.metrics}_`))
        .map(stream => [stream.name, 'metrics']),
    ]);
    for (const [stream, streamType] of retentionStreams) {
      const query = new URLSearchParams({type: streamType});
      await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams/${encodeURIComponent(stream)}/settings?${query}`, method: 'PUT', body: {data_retention: config.telemetry.openObserve.retentionDays}});
    }
    const latencyBudgetMs = config.platform.requestDeadlineMs;
    const healthLatencies = [];
    const openObserveStoppedAtUs = Date.now() * 1000;
    run(['stop', openObserveName]);
    healthLatencies.push(await fixtureHealth({baseUrl: fixtureBaseUrl, path: config.platform.health.livePath, budgetMs: latencyBudgetMs}));
    await fixtureRequest({baseUrl: fixtureBaseUrl, runId});
    const collectorRetryExpiryWaitMs = config.telemetry.collector.retryWindowMs + config.telemetry.collector.exportTimeoutMs +
      config.telemetry.collector.batchTimeoutMs + config.telemetry.collector.retryMaxMs + config.platform.health.intervalMs;
    await sleep(Math.max(config.platform.health.intervalMs + config.platform.health.timeoutMs, collectorRetryExpiryWaitMs));
    const collectorExpiredRetryDrop = collectorExpiredRetryDropEvidence({name: collectorName, startTimeUs: openObserveStoppedAtUs});
    const openObserveRestartedAtUs = Date.now() * 1000;
    run(['start', openObserveName]);
    await waitFor(async () => {
      requireRunning({run, name: openObserveName, secrets: sensitiveValues});
      const response = await fetch(new URL('/healthz', baseUrl), {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
      return response?.ok;
    }, {timeoutMs: 60000, intervalMs: 1000, description: 'OpenObserve restart after outage'});
    healthLatencies.push(await fixtureHealth({baseUrl: fixtureBaseUrl, path: config.platform.health.readyPath, budgetMs: latencyBudgetMs}));
    const outageHealthRows = await waitFor(async () => {
      const samples = rows(await streamSearch({baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_httpcheck_error`, streamType: 'metrics', startTimeUs: openObserveStoppedAtUs}));
      return samples.some(record => {
        const entries = Object.entries(record ?? {});
        const openObserveTarget = entries.some(([key, value]) => /service_name/iu.test(key) && value === 'openobserve');
        const errorValue = entries.some(([key, value]) => /^(?:value|_value)$/iu.test(key) && value === 1);
        return openObserveTarget && errorValue;
      }) ? samples : false;
    }, {timeoutMs: 60000, intervalMs: 2000, description: 'stored OpenObserve health-check error after real backend outage'});
    evidence.telemetryHealth.openObserveOutage = 'PASS';
    evidence.telemetryHealth.openObserveOutageWaitMs = collectorRetryExpiryWaitMs;
    evidence.telemetryHealth.outageMetricSamples = outageHealthRows.length;
    const {summary: recoveredHealthSummary} = await waitForHealthyHttpCheckMetrics({
      baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_httpcheck_status`,
      startTimeUs: openObserveRestartedAtUs, description: 'healthy native status samples after OpenObserve restart',
    });
    evidence.telemetryHealth.recovered = recoveredHealthSummary;
    evidence.telemetryHealth.recoveryStatus = 'PASS';
    const baselineDiagnostics = await fixtureDiagnostics(fixtureBaseUrl);
    const collectorBeforeRestart = containerGeneration({run, name: collectorName});
    if (!collectorBeforeRestart.state.Running) throw new Error('Collector process was not running before its restart');
    const collectorBeforeRestartAtUs = startedAtUs(collectorBeforeRestart.state);
    const collectorUptimeStream = `${config.telemetry.openObserve.streams.metrics}_otelcol_process_uptime`;
    const collectorUptimeBeforeRestart = await waitForProcessMetric({
      baseUrl, authorization, organization, stream: collectorUptimeStream,
      service: 'otel-collector', afterUs: collectorBeforeRestartAtUs,
      description: 'native Collector process uptime before restart',
    });
    const collectorOutageLossBeforeRestart = await verifyCollectorQueueMetrics({
      baseUrl, authorization, organization,
      metricsPrefix: config.telemetry.openObserve.streams.metrics,
      startTimeUs: openObserveRestartedAtUs,
      lossStartTimeUs: openObserveStoppedAtUs,
      queueCapacity: config.telemetry.collector.queueCapacity,
    });
    evidence.collectorOutageLossBeforeRestart = {
      status: collectorOutageLossBeforeRestart.status,
      collectorProcessStartedAt: collectorBeforeRestart.state.StartedAt,
      queryStartedAtUs: openObserveRestartedAtUs,
      lossWindowStartedAtUs: openObserveStoppedAtUs,
      sendFailureSamples: collectorOutageLossBeforeRestart.sendFailureSamples,
    };
    run(['stop', collectorName]);
    await fixtureRequest({baseUrl: fixtureBaseUrl, path: '/test/burst', body: {count: config.telemetry.producer.queueCapacity * 4}, runId});
    for (let index = 0; index < 4; index += 1) {
      healthLatencies.push(await fixtureHealth({baseUrl: fixtureBaseUrl, path: config.platform.health.readyPath, budgetMs: latencyBudgetMs}));
    }
    const failedQueueDiagnostics = await waitFor(async () => {
      const diagnostics = await (await fetch(new URL('/test/diagnostics', fixtureBaseUrl))).json();
      return diagnostics.exportFailures > baselineDiagnostics.exportFailures && diagnostics.dropped > baselineDiagnostics.dropped ? diagnostics : false;
    }, {timeoutMs: config.telemetry.producer.exportTimeoutMs + config.telemetry.producer.batchIntervalMs + config.telemetry.producer.diagnosticIntervalMs, intervalMs: 500, description: 'producer queue-drop and failed-export counters during Collector outage'});
    run(['start', collectorName]);
    await waitFor(async () => {
      requireRunning({run, name: collectorName, secrets: sensitiveValues});
      const response = await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
      return response?.ok;
    }, {timeoutMs: 30000, intervalMs: 500, description: 'Collector restart after outage'});
    const collectorAfterRestart = containerGeneration({run, name: collectorName});
    const collectorRestartedAtUs = startedAtUs(collectorAfterRestart.state);
    if (collectorAfterRestart.id !== collectorBeforeRestart.id || collectorRestartedAtUs <= collectorBeforeRestartAtUs ||
        collectorAfterRestart.state.Running !== true)
      throw new Error('Collector restart did not create a fresh process generation in the same container');
    const collectorUptimeAfterRestart = await waitForProcessMetric({
      baseUrl, authorization, organization, stream: collectorUptimeStream,
      service: 'otel-collector', afterUs: collectorRestartedAtUs,
      description: 'native Collector process uptime after restart',
    });
    if (!(collectorUptimeAfterRestart.value > 0) || !(collectorUptimeAfterRestart.value < collectorUptimeBeforeRestart.value) ||
        (collectorUptimeBeforeRestart.instanceId && collectorUptimeAfterRestart.instanceId &&
          collectorUptimeBeforeRestart.instanceId === collectorUptimeAfterRestart.instanceId))
      throw new Error('Collector native process uptime or instance identity did not reset after restart');
    const afterOutage = await fetch(new URL('/synthetic', fixtureBaseUrl), {method: 'POST', headers: correlationHeaders, signal: AbortSignal.timeout(5000)});
    if (!afterOutage.ok) throw new Error(`synthetic request after Collector recovery returned HTTP ${afterOutage.status}`);
    evidence.outageRestart = {openObserve: 'restarted', collector: 'restarted', producerExportFailureObserved: true,
      queueDrops: failedQueueDiagnostics.dropped - baselineDiagnostics.dropped, collectorExpiredRetryDrop,
      healthLatencyMs: healthLatencies, budgetMs: latencyBudgetMs};
    evidence.collectorQueueMetrics = await verifyCollectorQueueMetrics({
      baseUrl, authorization, organization,
      metricsPrefix: config.telemetry.openObserve.streams.metrics,
      startTimeUs: collectorRestartedAtUs,
      lossStartTimeUs: openObserveStoppedAtUs,
      lossEndTimeUs: collectorRestartedAtUs,
      queueCapacity: config.telemetry.collector.queueCapacity,
    });
    evidence.outageRestart.collectorQueueMetrics = evidence.collectorQueueMetrics;
    evidence.outageRestart.collectorProcessGeneration = {
      sameContainer: true,
      startedAtChanged: true,
      beforeStartedAt: collectorBeforeRestart.state.StartedAt,
      afterStartedAt: collectorAfterRestart.state.StartedAt,
      processUptime: {
        metric: 'otelcol_process_uptime',
        before: {valueSeconds: collectorUptimeBeforeRestart.value, timestampUs: collectorUptimeBeforeRestart.timestampUs},
        after: {valueSeconds: collectorUptimeAfterRestart.value, timestampUs: collectorUptimeAfterRestart.timestampUs},
        instanceIdentityChanged: Boolean(collectorUptimeBeforeRestart.instanceId && collectorUptimeAfterRestart.instanceId &&
          collectorUptimeBeforeRestart.instanceId !== collectorUptimeAfterRestart.instanceId),
      },
      postRestartQueueAndSentMetricsOnly: true,
      lossCounterWindowEndsAtRestart: true,
      abruptCrashLossMayBeIncomplete: true,
    };

    const producerBeforeRestart = containerGeneration({run, name: producerName});
    if (!producerBeforeRestart.state.Running) throw new Error('synthetic producer process was not running before its restart');
    const producerBeforeRestartAtUs = startedAtUs(producerBeforeRestart.state);
    const producerBeforeDiagnostics = await fixtureDiagnostics(fixtureBaseUrl);
    if (producerBeforeDiagnostics.counters.dropped <= 0 || producerBeforeDiagnostics.counters.exportFailures <= 0)
      throw new Error('synthetic producer did not expose positive process-scoped loss counters before restart');
    const producerStartMetricStream = `${config.telemetry.openObserve.streams.metrics}_runtime_process_start_time_seconds`;
    const producerStartBefore = await waitForProcessMetric({
      baseUrl, authorization, organization, stream: producerStartMetricStream,
      service: 'g14-synthetic', afterUs: producerBeforeRestartAtUs,
      description: 'synthetic producer process start-time metric before restart',
    });
    const producerLossMetricsBefore = {};
    for (const [counter, metric] of [
      ['dropped', 'telemetry_records_dropped_total'],
      ['exportFailures', 'telemetry_export_failures_total'],
    ]) {
      producerLossMetricsBefore[counter] = await waitForProcessMetric({
        baseUrl, authorization, organization,
        stream: `${config.telemetry.openObserve.streams.metrics}_${metric}`,
        service: 'g14-synthetic', afterUs: producerBeforeRestartAtUs,
        description: `synthetic producer ${counter} metric before restart`,
      });
      if (producerLossMetricsBefore[counter].value <= 0)
        throw new Error(`synthetic producer ${counter} metric was not positive before restart`);
    }
    run(['restart', producerName]);
    await waitFor(async () => {
      requireRunning({run, name: producerName, secrets: sensitiveValues});
      const response = await fetch(new URL(config.platform.health.readyPath, fixtureBaseUrl), {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
      return response?.ok;
    }, {timeoutMs: 30000, intervalMs: 500, description: 'synthetic producer readiness after process restart'});
    const producerAfterRestart = containerGeneration({run, name: producerName});
    const producerRestartedAtUs = startedAtUs(producerAfterRestart.state);
    if (producerAfterRestart.id !== producerBeforeRestart.id || producerRestartedAtUs <= producerBeforeRestartAtUs ||
        producerAfterRestart.state.Running !== true)
      throw new Error('synthetic producer restart did not create a fresh process generation in the same container');
    const producerAfterDiagnostics = await fixtureDiagnostics(fixtureBaseUrl);
    if (producerAfterDiagnostics.processStartTimeSeconds <= producerBeforeDiagnostics.processStartTimeSeconds ||
        producerAfterDiagnostics.counters.dropped !== 0 || producerAfterDiagnostics.counters.exportFailures !== 0 ||
        Object.values(producerAfterDiagnostics.counters).some(value => value !== 0))
      throw new Error('synthetic producer loss counters did not reset with the new process generation');
    const producerRestartRequest = await fixtureRequest({baseUrl: fixtureBaseUrl, runId});
    if (producerRestartRequest?.accepted !== true) throw new Error('synthetic producer rejected the post-restart SDK telemetry request');
    const producerStartAfter = await waitForProcessMetric({
      baseUrl, authorization, organization, stream: producerStartMetricStream,
      service: 'g14-synthetic', afterUs: producerRestartedAtUs,
      description: 'synthetic producer process start-time metric after restart',
    });
    const producerReadyAfter = await waitForProcessMetric({
      baseUrl, authorization, organization,
      stream: `${config.telemetry.openObserve.streams.metrics}_runtime_ready`,
      service: 'g14-synthetic', afterUs: producerRestartedAtUs,
      description: 'synthetic producer SDK readiness metric after restart',
    });
    const producerRequestsAfter = await waitForProcessMetric({
      baseUrl, authorization, organization,
      stream: `${config.telemetry.openObserve.streams.metrics}_runtime_http_requests_total`,
      service: 'g14-synthetic', afterUs: producerRestartedAtUs,
      description: 'synthetic producer SDK request metric after restart',
    });
    if (Math.abs(producerStartAfter.value - producerAfterDiagnostics.processStartTimeSeconds) > 0.001 ||
        producerStartAfter.timestampUs <= producerRestartedAtUs || producerReadyAfter.value !== 1 ||
        producerRequestsAfter.value <= 0 || producerStartBefore.value >= producerStartAfter.value ||
        producerStartBefore.timestampUs >= producerRestartedAtUs)
      throw new Error('synthetic producer SDK metrics did not identify the new process generation');
    evidence.processCounterRestart = {
      status: 'PASS',
      producer: {
        sameContainer: true,
        startedAtChanged: true,
        beforeStartedAt: producerBeforeRestart.state.StartedAt,
        afterStartedAt: producerAfterRestart.state.StartedAt,
        beforeProcessId: producerBeforeDiagnostics.processId,
        afterProcessId: producerAfterDiagnostics.processId,
        processStartTimeMetric: {
          before: {valueSeconds: producerStartBefore.value, timestampUs: producerStartBefore.timestampUs},
          after: {valueSeconds: producerStartAfter.value, timestampUs: producerStartAfter.timestampUs},
          matchesRuntimeDiagnostics: true,
        },
        postRestartSdkMetrics: {
          runtimeReady: {value: producerReadyAfter.value, timestampUs: producerReadyAfter.timestampUs},
          httpRequests: {value: producerRequestsAfter.value, timestampUs: producerRequestsAfter.timestampUs},
        },
        lossCounters: {
          before: producerBeforeDiagnostics.counters,
          after: producerAfterDiagnostics.counters,
          storedBeforeRestart: Object.fromEntries(Object.entries(producerLossMetricsBefore).map(([name, sample]) => [name, sample.value])),
          reset: true,
        },
        abruptCrashLossMayBeIncomplete: true,
      },
      collector: evidence.outageRestart.collectorProcessGeneration,
    };

    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = workDir;
    let launchNetwork;
    let collectorAttachedToLaunchNetwork = false;
    const detachLaunchCollector = () => {
      if (!collectorAttachedToLaunchNetwork) return;
      run(['network', 'disconnect', '--force', launchNetwork, collectorName]);
      collectorAttachedToLaunchNetwork = false;
    };
    let launchCollectorOutageStartedAt;
    let launchNginxContainer;
    const launchStartedAtUs = Date.now() * 1000;
    const waitForNativeAccess = async correlationId => {
      try {
        return await waitFor(async () => {
          const found = rows(await streamSearch({baseUrl, authorization, organization,
            stream: config.telemetry.openObserve.streams.logs, filterSql: nativeAccessLogFilter(correlationId), startTimeUs: launchStartedAtUs}));
          return found.some(record => record.service_name === 'edge-nginx' && hasExactValue(record, correlationId)) ? found : false;
        }, {timeoutMs: 60000, intervalMs: 2000, description: 'real edge-nginx access log correlated in OpenObserve'});
      } catch (error) {
        const diagnostic = {producer: {available: false}, backend: {available: false}};
        try {
          const records = run(['logs', '--tail', '1000', launchNginxContainer]).split('\n').flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
          });
          diagnostic.producer = {available: true, recordCount: records.length,
            matchingCorrelationRecords: records.filter(record => record.correlation_id === correlationId).length,
            recordKeys: [...new Set(records.flatMap(record => Object.keys(record)))].slice(0, 40)};
        } catch {}
        try {
          const records = rows(await streamSearch({baseUrl, authorization, organization,
            stream: config.telemetry.openObserve.streams.logs, filterSql: '"service_name" = \'edge-nginx\'', startTimeUs: launchStartedAtUs}));
          diagnostic.backend = {available: true, recordCount: records.length,
            matchingCorrelationRecords: records.filter(record => hasExactValue(record, correlationId)).length,
            recordKeys: [...new Set(records.flatMap(record => Object.keys(record)))].slice(0, 40)};
        } catch {}
        evidence.nativeAccessLogDiagnostics = diagnostic;
        throw error;
      }
    };
    try {
      const {runLaunchPath} = await import('../../tests/observability/launch-path.mjs');
      const launchResult = await runLaunchPath({
        telemetry: {config: config.telemetry, endpoint: 'http://otel-collector:4318', exporterToken: producerToken},
        resultDir: join(workDir, 'launch-path'),
        onNetworkCleanup: detachLaunchCollector,
        onNetwork: async ({networkName}) => {
          launchNetwork = networkName;
          const launchNetworkProbe = JSON.parse(run(['run', '--rm', '--network', networkName, '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=8m',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16',
            '--entrypoint', 'node', toolchain.nodeImage, '-e',
            'const urls=process.argv.slice(1);Promise.all(urls.map(async url=>{try{const response=await fetch(url,{signal:AbortSignal.timeout(1500)});return {blocked:false,status:response.status};}catch{return {blocked:true};}})).then(results=>process.stdout.write(JSON.stringify(results)));',
            'http://openobserve:5080/healthz', `http://${openObserveIp}:5080/healthz`]));
          if (!Array.isArray(launchNetworkProbe) || launchNetworkProbe.length !== 2 || launchNetworkProbe.some(result => result.blocked !== true))
            throw new Error('real launch-path application network can reach the isolated OpenObserve management/data endpoint');
          evidence.networkIsolation.launchPathOpenObserveDnsBlocked = launchNetworkProbe[0].blocked;
          evidence.networkIsolation.launchPathOpenObserveIpBlocked = launchNetworkProbe[1].blocked;
          evidence.networkIsolation.launchPathNetworkStatus = 'PASS';
          run(['network', 'connect', '--alias', 'otel-collector', networkName, collectorName]);
          collectorAttachedToLaunchNetwork = true;
        },
        onRolesReady: async ({logFiles: roleLogFiles}) => {
          if (!Array.isArray(roleLogFiles) || roleLogFiles.length === 0) throw new Error('launch-path fixture supplied no exact runtime log files');
          if (!roleLogFiles.some(({service}) => service === 'edge-nginx')) throw new Error('launch-path fixture did not expose the real edge-nginx log source');
          launchNginxContainer = roleLogFiles.find(({service}) => service === 'edge-nginx').containerId;
          const roleCollectorConfig = createCollectorConfig({config, logFiles: roleLogFiles, exporterToken: producerToken, openObserveIngestToken: openObserveToken});
          run(['rm', '-f', collectorName]);
          collectorAttachedToLaunchNetwork = false;
          await startCollector(roleLogFiles, 'launch-path-role-logs', roleCollectorConfig, [launchNetwork]);
          collectorAttachedToLaunchNetwork = true;
          await waitFor(async () => {
            requireRunning({run, name: collectorName, secrets: sensitiveValues});
            const response = await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
            return response?.ok;
          }, {timeoutMs: 30000, intervalMs: 500, description: 'Collector restart with exact launch-path runtime logs'});
          evidence.containerDiagnostics.push(captureContainerDiagnostics({name: collectorName, stage: 'launch-path-role-logs', secrets: sensitiveValues}));
          await verifyMetricSignal({baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_nginx_connections_current`});
          const {summary: roleHealthSummary} = await waitForHealthyHttpCheckMetrics({
            baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_httpcheck_status`,
            description: 'healthy native status samples after exact launch Collector config restart',
          });
          if (!roleHealthSummary.healthyOpenObserve || !roleHealthSummary.healthyCollector)
            throw new Error(`launch-path Collector did not publish healthy endpoint checks: ${JSON.stringify(roleHealthSummary)}`);
          evidence.telemetryHealth.launchPathCollectorConfig = 'PASS';
          evidence.nginxMetrics = 'PASS';
          launchCollectorOutageStartedAt = performance.now();
          run(['stop', collectorName]);
        },
        observeBaseline: async (baseline, {probeNativeAccess}) => {
          const expectedRoles = ['kafka', 'orders-service', 'orders-aroma-preparation', 'api-internal', 'api-public', 'realtime-gateway', 'edge-gateway', 'edge-nginx'];
          const expectedNodeRoles = ['edge-gateway', 'api-public', 'api-internal', 'orders-service', 'orders-aroma-preparation', 'realtime-gateway'];
          const observedRoles = new Set((baseline?.roles ?? []).filter(role => role.running === true).map(role => role.role));
          const nodeReadiness = baseline?.nodeReadiness;
          const nodeReadinessRoles = nodeReadiness && typeof nodeReadiness === 'object' && !Array.isArray(nodeReadiness)
            ? Object.keys(nodeReadiness).sort()
            : [];
          const allNodeRolesReady = nodeReadinessRoles.length === expectedNodeRoles.length &&
            nodeReadinessRoles.every((role, index) => role === [...expectedNodeRoles].sort()[index]) &&
            expectedNodeRoles.every(role => nodeReadiness[role] === 200);
          if (baseline?.verified !== true || !/^[0-9a-f-]{36}$/iu.test(baseline.correlationId ?? '') ||
              !/^[0-9a-f]{32}$/iu.test(baseline.traceId ?? '') || !Number.isSafeInteger(baseline.sourceEvents) || baseline.sourceEvents < 2 ||
              baseline.sourceBrokerAckCount !== baseline.sourceEvents || baseline.sourceInboxCommitted !== true ||
              baseline.projectionPresent !== true || baseline.realtimeOutboxPersisted !== true || baseline.sseReady !== true ||
              baseline.ownerRefetch?.status !== 200 || baseline.ownerRefetch?.requestAndResponseCorrelationMatched !== true ||
              baseline.ownerRefetch?.requestAndResponseTraceparentMatched !== true || expectedRoles.some(role => !observedRoles.has(role)) ||
              !allNodeRolesReady ||
              typeof launchCollectorOutageStartedAt !== 'number')
            throw new Error('actual owner path did not remain healthy during the Collector outage');
          const outageElapsedMs = Math.round(performance.now() - launchCollectorOutageStartedAt);
          const collectorRestartedAtUs = Date.now() * 1000;
          run(['start', collectorName]);
          await waitFor(async () => {
            requireRunning({run, name: collectorName, secrets: sensitiveValues});
            const response = await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
            return response?.ok;
          }, {timeoutMs: 30000, intervalMs: 500, description: 'Collector recovery after real owner-path outage'});
          const {summary: recoveredSummary} = await waitForHealthyHttpCheckMetrics({
            baseUrl, authorization, organization, stream: `${config.telemetry.openObserve.streams.metrics}_httpcheck_status`,
            startTimeUs: collectorRestartedAtUs, description: 'healthy native status samples after launch-path Collector outage',
          });
          const nativeProbe = await probeNativeAccess();
          const nativeProbeRows = await waitForNativeAccess(nativeProbe.correlationId);
          evidence.telemetryHealth.nativeAccessAfterRestart = {status: 'PASS', ownerGetStatus: nativeProbe.status,
            correlationMatched: nativeProbe.correlationMatched, accessLogRows: nativeProbeRows.length};
          evidence.telemetryHealth.launchPathOutage = {
            collectorStopped: true,
            collectorRestarted: true,
            outageElapsedMs,
            sourceEvents: baseline.sourceEvents,
            sourceBrokerAckCount: baseline.sourceBrokerAckCount,
            sourceInboxCommitted: baseline.sourceInboxCommitted,
            projectionPresent: baseline.projectionPresent,
            realtimeOutboxPersisted: baseline.realtimeOutboxPersisted,
            sseReady: baseline.sseReady,
            ownerRefetchStatus: baseline.ownerRefetch.status,
            ownerCorrelationMatched: baseline.ownerRefetch.requestAndResponseCorrelationMatched,
            ownerTraceparentMatched: baseline.ownerRefetch.requestAndResponseTraceparentMatched,
            allRuntimeRolesRunning: expectedRoles.every(role => observedRoles.has(role)),
            nodeReadiness,
            allActualNodeRolesReady: allNodeRolesReady,
            healthyEndpointChecksAfterRestart: recoveredSummary,
          };
          evidence.telemetryHealth.launchPathOutageStatus = 'PASS';
        },
        observeProof: async proof => {
          try {
            if (proof?.verified !== true || !/^[0-9a-f-]{36}$/iu.test(proof.correlationId ?? '') || !/^[0-9a-f]{32}$/iu.test(proof.traceId ?? ''))
              throw new Error('launch-path fixture did not return a valid verified correlation proof');
            const expectedTelemetry = proof.expectedTelemetry;
            const ownerMessageSha256 = proof.ownerBrokerReceipt?.messageIdSha256;
            const wakeMessageSha256 = proof.wakeReceipt?.messageIdSha256;
            const convergenceWake = proof.convergenceMetricReceipt?.wakeReceipt;
            const resultRelay = proof.convergenceMetricReceipt?.resultRelayReceipt;
            const resultMessages = resultRelay?.resultMessages;
            const projection = proof.projectionReceipt;
            const hasHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
            const causalProofValid = proof.command?.status === 202 && proof.command?.ownerOutboxMatched === true &&
              proof.command?.traceparentMatched === true && proof.command?.rootCausation === true &&
              hasHash(ownerMessageSha256) && proof.ownerMessageSha256 === ownerMessageSha256 &&
              proof.ownerBrokerReceipt?.state === 'Published' &&
              proof.wakeReceipt?.messageType === 'AromaConvergenceRequested.v1' && proof.wakeReceipt?.state === 'Published' &&
              proof.wakeReceipt?.causationMatched === true && proof.wakeReceipt?.causationMessageSha256 === ownerMessageSha256 &&
              hasHash(wakeMessageSha256) && convergenceWake?.messageIdSha256 === wakeMessageSha256 &&
              convergenceWake?.rootCausationSha256 === ownerMessageSha256 && convergenceWake?.outboxState === 'Published' &&
              convergenceWake?.inboxState === 'Processed' && convergenceWake?.correlationMatched === true &&
              convergenceWake?.traceparentMatched === true && resultRelay?.wakeMessageIdSha256 === wakeMessageSha256 &&
              resultRelay?.allSelectedMessagesPublished === true && Array.isArray(resultMessages) && resultMessages.length > 0 &&
              resultRelay.selectedOutboxPublishedCount === resultMessages.length &&
              resultMessages.every(message => message?.state === 'Published' && message.causationIdSha256 === wakeMessageSha256 &&
                message.correlationMatched === true && message.traceparentMatched === true && hasHash(message.messageIdSha256)) &&
              hasHash(projection?.resultMessageSha256) && resultMessages.some(message => message?.messageIdSha256 === projection.resultMessageSha256) &&
              projection?.resultCausationMatched === true &&
              projection?.resultCausationMessageSha256 === wakeMessageSha256 && projection?.inboxState === 'Processed' &&
              projection?.outboxState === 'Published' && projection?.causationMatched === true &&
              projection?.causationMessageSha256 === projection?.resultMessageSha256 &&
              hasHash(projection?.realtimeMessageSha256) && projection?.realtimeMessageSha256 === proof.realtimeMessageSha256 &&
              proof.refetchReceipt?.status === 200 && proof.refetchReceipt?.matched === true &&
              proof.refetchReceipt?.frameMessageSha256 === projection?.realtimeMessageSha256 &&
              proof.sseReceipt?.frameMatched === true && proof.sseReceipt?.correlationId === proof.correlationId &&
              proof.transport?.realAromaConvergenceConsumer === true;
            if (!causalProofValid || proof.projectionReceipt?.inboxState !== 'Processed' ||
                proof.projectionReceipt?.outboxState !== 'Published' || proof.projectionReceipt?.traceparentMatched !== true ||
                proof.projectionReceipt?.causationMatched !== true || proof.command?.rootCausation !== true ||
                proof.sseReceipt?.frameMatched !== true || proof.sseReceipt?.correlationId !== proof.correlationId ||
                proof.refetchReceipt?.matched !== true || proof.refetchReceipt?.requestAndResponseCorrelationMatched !== true ||
                proof.refetchReceipt?.correlationId !== proof.correlationId || proof.refetchReceipt?.traceparentSha256 !== proof.traceparentSha256 ||
                proof.transport?.realKafka !== true || proof.transport?.realOrdersService !== true || proof.transport?.realOrdersAromaPreparation !== true ||
                proof.transport?.edge !== 'nginx -> Edge -> api-public' ||
                !expectedTelemetry || !Array.isArray(expectedTelemetry.nativeLogRoles) || !expectedTelemetry.nativeLogRoles.includes('edge-nginx') ||
                !expectedTelemetry.traceSpanNames || !Array.isArray(expectedTelemetry.separateRealtimeSpanNames) ||
                !proof.roles?.some(role => role.role === 'edge-nginx') ||
                proof.convergenceMetricReceipt?.verified !== true || proof.convergenceMetricReceipt.owner !== 'aroma-convergence' ||
                proof.convergenceMetricReceipt.unknownOutcomeCounter !== 1 || proof.convergenceMetricReceipt.unknownOutcomesCurrent?.join(',') !== '1,0' ||
                proof.convergenceMetricReceipt.recoveredAppliedCounter !== 1 ||
                proof.convergenceMetricReceipt.attemptStates?.join(',') !== 'UnknownOutcome,NoOpInSync' ||
                !validConvergenceMetricContract(expectedTelemetry.ownerMetrics))
              throw new Error('launch-path fixture receipts did not prove the actual Kafka, owner, projection, SSE and refetch boundaries');
            const logRows = await waitFor(async () => {
              const found = rows(await streamSearch({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.logs, runId: proof.correlationId, field: 'body_correlationid'}));
              return found.length > 0 ? found : false;
            }, {timeoutMs: 60000, intervalMs: 2000, description: 'launch-path correlation record in OpenObserve logs'});
            let missingSpans = [];
            const {traceRows, spanInventory} = await waitFor(async () => {
              const found = rows(await streamSearch({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.traces, runId: proof.traceId, field: 'trace_id', streamType: 'traces'}));
              const inventory = traceSpanInventory(found);
              missingSpans = Object.entries(expectedTelemetry.traceSpanNames).flatMap(([service, names]) =>
                names.filter(name => !inventory[service]?.includes(name)).map(name => `${service}:${name}`));
              return missingSpans.length === 0 ? {traceRows: found, spanInventory: inventory} : false;
            }, {timeoutMs: 60000, intervalMs: 2000, description: 'all expected same-trace runtime spans in OpenObserve'}).catch(error => {
              error.message += `; missing same-trace spans=${JSON.stringify(missingSpans)}`;
              throw error;
            });
            const edgeLogRows = await waitForNativeAccess(proof.correlationId);
            const separateSpanNames = expectedTelemetry.separateRealtimeSpanNames ?? [];
            let separateRealtimeSpans = [];
            if (separateSpanNames.length) {
              let missingSeparateSpans = [...separateSpanNames];
              separateRealtimeSpans = await waitFor(async () => {
                const found = rows(await streamSearch({
                  baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.traces, streamType: 'traces',
                  filterSql: `"service_name" = 'realtime-gateway' AND "operation_name" IN (${separateSpanNames.map(name => `'${name}'`).join(', ')})`,
                  startTimeUs: launchStartedAtUs,
                }));
                const inventory = traceSpanInventory(found);
                missingSeparateSpans = separateSpanNames.filter(name => !inventory['realtime-gateway']?.includes(name));
                return missingSeparateSpans.length === 0 ? found : false;
              }, {timeoutMs: 60000, intervalMs: 2000, description: 'all separate realtime SSE spans in OpenObserve'}).catch(error => {
                error.message += `; missing separate realtime spans=${JSON.stringify(missingSeparateSpans)}`;
                throw error;
              });
            }
            const metricFamilies = [
              {name: 'db.client.connection.checkout_wait', owners: ['orders-service', 'orders-aroma-preparation', 'aroma-convergence'], components: ['_count', '_sum', '_bucket']},
              {name: 'db.client.connection.waiting', owners: ['orders-service'], components: ['']},
              {name: 'messaging.kafka.consumer.lag', owners: ['orders-aroma-preparation', 'realtime-gateway'], components: ['']},
              {name: 'messaging.kafka.event.age', owners: ['orders-aroma-preparation', 'realtime-gateway', 'aroma-convergence'], components: ['_count', '_sum', '_bucket']},
              {name: 'messaging.outbox.oldest_unpublished.age', owners: ['orders-service', 'orders-aroma-preparation'], components: ['']},
              {name: 'messaging.inbox.received.age', owners: ['orders-aroma-preparation', 'aroma-convergence'], components: ['_count', '_sum', '_bucket']},
              {name: 'coffee_realtime_invalidation_attempts_total', owners: ['realtime-gateway'], components: ['']},
              {name: 'coffee_realtime_invalidation_dropped_total', owners: ['realtime-gateway'], components: ['']},
              {name: 'coffee_realtime_connections', owners: ['realtime-gateway'], components: ['']},
              {name: 'coffee_realtime_queue_records', owners: ['realtime-gateway'], components: ['']},
              {name: 'coffee_realtime_queue_bytes', owners: ['realtime-gateway'], components: ['']},
              {name: 'runtime_http_requests_total', owners: ['api-public', 'orders-service'], components: ['']},
              {name: 'runtime_http_request_duration_ms', owners: ['api-public', 'orders-service'], components: ['_count', '_sum', '_bucket']},
              {name: 'coffee_aroma_attempt_results_total', owners: ['aroma-convergence'], components: ['']},
              {name: 'coffee_aroma_unknown_outcomes_total', owners: ['aroma-convergence'], components: ['']},
              {name: 'coffee_aroma_unknown_outcomes_current', owners: ['aroma-convergence'], components: ['']},
              {name: 'coffee_aroma_recovery_results_total', owners: ['aroma-convergence'], components: ['']},
            ];
            const liveMetricStreams = streamEntries(await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues}))
              .filter(stream => stream?.stream_type === 'metrics' && typeof stream?.name === 'string')
              .map(stream => stream.name);
            const metricApplicability = {};
            evidence.metricApplicability = metricApplicability;
            for (const family of metricFamilies) {
              const matches = await waitForOwnedMetricFamilySamples({
                baseUrl, authorization, organization, metricsPrefix: config.telemetry.openObserve.streams.metrics,
                family, liveMetricStreams, startTimeUs: launchStartedAtUs,
              });
              metricApplicability[family.name] = matches;
            }
            evidence.metricApplicability.aromaConvergenceLastObservation = {
              status: 'PENDING',
              metrics: Object.fromEntries(expectedTelemetry.ownerMetrics.map(expected => {
                const expectedValues = expected.values ?? [expected.value];
                return [expected.name, {streamPresent: false, queryRows: 0, ownerRows: 0, attrMatchedRows: 0,
                  observedValues: [], expectedValues, missingValues: expectedValues, latestTimestampUs: null}];
              })),
            };
            let ownerMetricObservations;
            try {
              ownerMetricObservations = await waitFor(async () => {
                const inventory = streamEntries(await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues}));
                const availableStreams = new Set(inventory.filter(stream => stream?.stream_type === 'metrics').map(stream => stream.name));
                const observed = {};
                const diagnostics = {};
                let complete = true;
                for (const expected of expectedTelemetry.ownerMetrics) {
                  const stream = `${config.telemetry.openObserve.streams.metrics}_${expected.name.replace(/[^a-zA-Z0-9_]/gu, '_')}`;
                  const streamPresent = availableStreams.has(stream);
                  const wanted = expected.values ?? [expected.value];
                  if (!streamPresent) {
                    diagnostics[expected.name] = {streamPresent, queryRows: 0, ownerRows: 0, attrMatchedRows: 0,
                      observedValues: [], expectedValues: wanted, missingValues: wanted, latestTimestampUs: null};
                    complete = false;
                    continue;
                  }
                  const samples = rows(await streamSearch({
                    baseUrl, authorization, organization, stream, streamType: 'metrics', startTimeUs: launchStartedAtUs,
                    filterSql: '"service_name" = \'aroma-convergence\'',
                  }));
                  const owned = samples.filter(sample => metricRecordServices([sample]).includes('aroma-convergence'));
                  const matching = owned.filter(sample => Object.entries(expected.attributes ?? {}).every(([name, value]) => metricRecordAttribute(sample, name) === value));
                  const values = metricValues(matching);
                  const missingValues = wanted.filter(value => !values.includes(value));
                  const uniqueValues = [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right).slice(0, 16);
                  const timestamps = matching.map(metricTimestampUs).filter(Number.isFinite);
                  diagnostics[expected.name] = {streamPresent, queryRows: samples.length, ownerRows: owned.length,
                    attrMatchedRows: matching.length, observedValues: uniqueValues, expectedValues: wanted, missingValues,
                    latestTimestampUs: timestamps.length ? Math.max(...timestamps) : null};
                  if (missingValues.length > 0) complete = false;
                  observed[expected.name] = {stream, owner: 'aroma-convergence', sampleCount: matching.length, observedValues: values, expectedValues: wanted};
                }
                evidence.metricApplicability.aromaConvergenceLastObservation = {status: 'PENDING', metrics: diagnostics};
                return complete ? observed : false;
              }, {timeoutMs: 60000, intervalMs: 2000, description: 'real aroma-convergence owner metrics from the SQL-backed recovery proof'});
            } catch (error) {
              evidence.metricApplicability.aromaConvergenceLastObservation.status = 'FAIL';
              throw error;
            }
            evidence.metricApplicability.aromaConvergenceLastObservation.status = 'PASS';
            const proofData = JSON.stringify({logRows, traceRows, edgeLogRows, separateRealtimeSpans});
            if (sensitiveValues.some(secret => secret && proofData.includes(secret))) throw new Error('launch-path telemetry exposed a fixture secret');
            if (/"(?:payload|request_body)"\s*:/iu.test(proofData)) throw new Error('launch-path telemetry exposed a raw payload field');
            evidence.metricApplicability = metricApplicability;
            evidence.metricApplicability.aromaConvergenceProof = ownerMetricObservations;
            evidence.launchPathCorrelation = 'PASS';
            evidence.launchPathProof = {
              verified: true,
              correlationId: proof.correlationId,
              traceId: proof.traceId,
              traceparentSha256: proof.traceparentSha256,
              browserRefetchMatched: proof.browserRefetchMatched === true,
              sseFrameMatched: proof.sseFrameMatched === true,
              rootCommandCausation: proof.command?.rootCausation === true,
              projectionCausationMatched: proof.projectionReceipt?.causationMatched === true,
              causationMessageSha256: proof.projectionReceipt?.causationMessageSha256,
              sourceEvents: Array.isArray(proof.sourceEvents) ? proof.sourceEvents.length : 0,
              ownerLogRecords: proof.ownerLogRecords,
              roles: (proof.roles ?? []).map(({role, containerId, imageId}) => ({role, containerId, imageId})),
              edgeNginxLogRows: edgeLogRows.length,
              traceSpanCount: Object.values(spanInventory).reduce((sum, names) => sum + names.length, 0),
              traceServices: Object.keys(spanInventory).sort(),
              separateRealtimeSpanCount: separateRealtimeSpans.length,
              metricApplicability,
              logStreamMatched: true,
              traceStreamMatched: true,
              rawPayloadObserved: false,
              fixtureCapacityClaim: false,
            };
          } finally {
            detachLaunchCollector();
          }
        },
      });
      evidence.launchPathFixture = {status: launchResult.error === null ? 'PASS' : 'FAIL', cleanupVerified: launchResult.cleanupVerified === true, smokeOnly: true};
      if (evidence.launchPathCorrelation !== 'PASS') throw new Error('launch-path fixture returned without observing native telemetry proof');
      evidence.signals.push('real Kafka → Orders owners → SSE/browser refetch records and W3C trace observed in OpenObserve');
      detachLaunchCollector();
      run(['rm', '-f', collectorName]);
      await startCollector(logFiles, 'post-launch-initial-logs', collectorConfig);
      await waitFor(async () => {
        requireRunning({run, name: collectorName, secrets: sensitiveValues});
        const response = await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined);
        return response?.ok;
      }, {timeoutMs: 30000, intervalMs: 500, description: 'Collector restored with fixture-only producer timestamp parser'});
      evidence.containerDiagnostics.push(captureContainerDiagnostics({name: collectorName, stage: 'post-launch-initial-logs', secrets: sensitiveValues}));
      evidence.telemetryHealth.launchPathCollectorConfig = 'PASS';
    } finally {
      try { detachLaunchCollector(); } catch {}
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }

    const matrixProject = `coffee-issue64-final-${runId.slice(0, 8)}`;
    let matrixNetworks = [];
    const detachMatrixNetworks = () => {
      if (matrixNetworks.length === 0) return;
      if (!run(['ps', '--all', '--quiet', '--filter', `name=^/${collectorName}$`])) { matrixNetworks = []; return; }
      const attached = JSON.parse(run(['inspect', '--format', '{{json .NetworkSettings.Networks}}', collectorName]));
      for (const network of matrixNetworks) {
        if (Object.hasOwn(attached, network)) run(['network', 'disconnect', '--force', network, collectorName]);
      }
      matrixNetworks = [];
    };
    evidence.runtimeMetricMatrix = {status: 'RUNNING', project: matrixProject};
    try {
      const {verifyRuntimeMetricMatrix} = await import('../../tests/observability/runtime-matrix.mjs');
      evidence.runtimeMetricMatrix = await verifyRuntimeMetricMatrix({
        config, exporterToken: producerToken, projectName: matrixProject, runDocker: run,
        sourceIdentity,
        nodeVersion: toolchain.node, nginxVersion: toolchain.nginxVersion,
        onRolesReady: async ({logFiles: matrixLogs, networks}) => {
          matrixNetworks = [...new Set(Object.values(networks))];
          if (matrixNetworks.length !== 4) throw new Error('runtime matrix requires four distinct application trust zones');
          const matrixCollectorConfig = createCollectorConfig({config, logFiles: matrixLogs, exporterToken: producerToken, openObserveIngestToken: openObserveToken});
          run(['rm', '-f', collectorName]);
          await startCollector(matrixLogs, 'all-runtime-metric-matrix', matrixCollectorConfig, matrixNetworks);
          await waitFor(async () => {
            requireRunning({run, name: collectorName, secrets: sensitiveValues});
            return (await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined))?.ok;
          }, {timeoutMs: 30000, intervalMs: 500, description: 'Collector with all fourteen runtime log sources'});
          const zones = [];
          for (const network of matrixNetworks) {
            const probes = JSON.parse(run(['run', '--rm', '--network', network, '--read-only', '--cap-drop', 'ALL',
              '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16', '--entrypoint', 'node', toolchain.nodeImage, '-e',
              'Promise.all(process.argv.slice(1).map(async url=>{try{await fetch(url,{signal:AbortSignal.timeout(1500)});return false;}catch{return true;}})).then(result=>process.stdout.write(JSON.stringify(result)))',
              'http://openobserve:5080/healthz', `http://${openObserveIp}:5080/healthz`]));
            if (!Array.isArray(probes) || probes.length !== 2 || probes.some(blocked => blocked !== true))
              throw new Error('runtime matrix application network can reach OpenObserve');
            zones.push({network, dnsBlocked: true, ipBlocked: true});
          }
          evidence.networkIsolation.runtimeMetricMatrix = {status: 'PASS', zones};
        },
        onCleanup: async () => { detachMatrixNetworks(); },
        verifyMetricFamily: async ({startTimeUs, ...family}) => {
          const inventory = streamEntries(await api({baseUrl, authorization, path: `/api/${encodeURIComponent(organization)}/streams`, sensitiveValues}));
          return waitForOwnedMetricFamilySamples({baseUrl, authorization, organization,
            metricsPrefix: config.telemetry.openObserve.streams.metrics, family, startTimeUs,
            liveMetricStreams: inventory.filter(stream => stream?.stream_type === 'metrics').map(stream => stream.name)});
        },
      });
    } catch (error) {
      evidence.runtimeMetricMatrix = error.runtimeMetricMatrix ?? {status: 'FAIL', project: matrixProject};
      throw error;
    } finally {
      detachMatrixNetworks();
      run(['rm', '-f', collectorName]);
      await startCollector(logFiles, 'post-matrix-initial-logs', collectorConfig);
      await waitFor(async () => (await fetch(collectorHealthEndpoint, {signal: AbortSignal.timeout(1000)}).catch(() => undefined))?.ok,
        {timeoutMs: 30000, intervalMs: 500, description: 'Collector restored after all-runtime metric matrix'});
    }

    await setFixtureState({baseUrl: fixtureBaseUrl, runId, active: true});
    await fixtureRequest({baseUrl: fixtureBaseUrl, runId});
    const metricAlertInputs = {};
    for (const [key, suffix, predicate] of [
      ['notReady', 'runtime_ready', value => value <= 0],
      ['consumerLag', 'messaging_kafka_consumer_lag', value => value > config.telemetry.alerts.consumerLag.threshold],
      ['outboxOldestAge', 'messaging_outbox_oldest_unpublished_age', value => value > config.telemetry.alerts.outboxOldestAge.threshold],
      ['unknownOutcome', 'coffee_aroma_unknown_outcomes_current', value => value > config.telemetry.alerts.unknownOutcome.threshold],
    ]) {
      const stream = `${config.telemetry.openObserve.streams.metrics}_${suffix}`;
      const metric = await verifyMetricThreshold({baseUrl, authorization, organization, stream, predicate, description: `synthetic alert input metric ${key} exceeds its production gate`});
      metricAlertInputs[key] = {stream, sampleCount: metric.samples.length, matchingValues: metric.values.filter(predicate).length};
    }
    for (const suffix of ['coffee_realtime_invalidation_attempts_total', 'coffee_realtime_invalidation_dropped_total']) {
      const stream = `${config.telemetry.openObserve.streams.metrics}_${suffix}`;
      const metric = await verifyMetricThreshold({baseUrl, authorization, organization, stream, predicate: value => value > 0, timeoutMs: 130000, description: `synthetic alert input counter ${suffix} is exported`});
      metricAlertInputs[suffix] = {stream, sampleCount: metric.samples.length, positiveValues: metric.values.filter(value => value > 0).length};
    }
    evidence.alertInputs = metricAlertInputs;
    const definitions = await installNativeAlerts({config, baseUrl, organization, authorization});
    const observed = new Map();
    const maxForMs = Math.max(...definitions.map(({pendingPeriodSec}) => pendingPeriodSec)) * 1000;
    const fireDeadline = maxForMs + 4 * config.telemetry.alerts.evaluationIntervalMs;
    await waitFor(async () => {
      const events = await readSinkEvents(sinkPath);
      for (const definition of definitions) {
        const firing = events.find(event => event.name === definition.name && event.status === 'firing');
        if (firing) observed.set(definition.name, firing.episodeId);
      }
      return observed.size === definitions.length;
    }, {timeoutMs: fireDeadline, intervalMs: 5000, description: 'native OpenObserve alert firing transitions'});
    await setFixtureState({baseUrl: fixtureBaseUrl, runId, active: false});
    await fixtureRequest({baseUrl: fixtureBaseUrl, runId});
    const resolveDeadline = maxForMs + 4 * config.telemetry.alerts.evaluationIntervalMs;
    await waitFor(async () => {
      const events = await readSinkEvents(sinkPath);
      return definitions.every(definition => events.some(event => event.name === definition.name && event.status === 'resolved' && event.episodeId === observed.get(definition.name)));
    }, {timeoutMs: resolveDeadline, intervalMs: 5000, description: 'native OpenObserve alert recovery transitions'});
    evidence.alerts = definitions.map(({key, pendingPeriodSec, threshold, name, streamName, queryCondition}) => ({
      key, name, streamName, queryType: queryCondition.type, query: queryCondition.promql,
      comparator: queryCondition.promql_condition.operator, threshold, pendingPeriodSec,
      episodeId: observed.get(name), firing: true, resolved: true,
    }));

    const pressureCompose = createComposeOverride({
      config,
      imageRefs: toolchain,
      logFiles: [],
      collectorConfigPath,
      openObserveDataVolume: storage.volumeName,
    });
    const generatedHealthcheck = pressureCompose.services.openobserve.healthcheck.test;
    if (!Array.isArray(generatedHealthcheck) || generatedHealthcheck[0] !== 'CMD')
      throw new Error('generated OpenObserve healthcheck does not expose its native disk watermark guard');
    const guardCommand = generatedHealthcheck.slice(1);
    const guardStatus = () => {
      try { run(['exec', openObserveName, ...guardCommand]); return 0; }
      catch (error) { if (error.status === 1) return 1; throw error; }
    };
    const diskRows = () => run(['exec', openObserveName, '/busybox', 'df', '-Pk', '/', '/data'])
      .split('\n').slice(1).filter(Boolean).map(line => {
        const fields = line.trim().split(/\s+/u);
        return {mountPoint: fields.at(-1), totalBytes: Number(fields[1]) * 1024, usedBytes: Number(fields[2]) * 1024, usedPercent: Number(fields[4]?.replace('%', ''))};
      });
    const initialDiskRows = diskRows();
    const rootDisk = initialDiskRows.find(row => row.mountPoint === '/');
    const dataDisk = initialDiskRows.find(row => row.mountPoint === '/data');
    if (!rootDisk || !dataDisk || guardStatus() !== 0 || !Number.isFinite(rootDisk.totalBytes) || !Number.isFinite(dataDisk.totalBytes))
      throw new Error('OpenObserve disk guard preflight or bounded mount statistics are unavailable');
    const watermarkPercent = config.telemetry.openObserve.diskWatermarkPercent;
    const dataTargetBytes = Math.min(Math.floor(dataDisk.totalBytes * 0.83), Math.floor(storage.maxDiskBytes * 0.83));
    const writeBytes = dataTargetBytes - dataDisk.usedBytes;
    const rootHeadroomBytes = Math.floor(rootDisk.totalBytes * 0.85) - rootDisk.usedBytes - 32 * 1024 * 1024;
    const maxWriteBytes = Math.min(Math.floor(storage.maxDiskBytes * 0.85), rootHeadroomBytes);
    const aggregateTotalBytes = rootDisk.totalBytes + dataDisk.totalBytes;
    const projectedAggregatePercent = (rootDisk.usedBytes + dataDisk.usedBytes + writeBytes * 2) * 100 / aggregateTotalBytes;
    if (!Number.isSafeInteger(writeBytes) || writeBytes <= 0 || writeBytes > maxWriteBytes ||
        projectedAggregatePercent < watermarkPercent || !Number.isSafeInteger(dataTargetBytes))
      throw new Error('bounded fixture disk lacks enough safe headroom to exercise the configured native watermark');
    const pressurePath = `/data/.g14-disk-pressure-${runId}`;
    const helperArgs = ['run', '--rm', '--network', 'none', '--read-only', '--user', '10001:10001', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--memory', '64m', '--pids-limit', '16',
      '--mount', `type=volume,source=${storage.volumeName},target=/data`, '--entrypoint', 'node', toolchain.nodeImage, '-e'];
    const removePressureFile = identity => run([...helperArgs, `const fs=require('node:fs');const path=${JSON.stringify(pressurePath)};const expected={dev:${JSON.stringify(identity.dev)},ino:${JSON.stringify(identity.ino)}};let st;try{st=fs.lstatSync(path);}catch(error){if(error.code==='ENOENT')process.exit(0);throw error;}if(!st.isFile()||st.isSymbolicLink()||st.dev!==expected.dev||st.ino!==expected.ino)throw new Error('fixture pressure file identity changed; refusing cleanup');fs.unlinkSync(path);`]);
    const dataTargetKiB = Math.floor(dataTargetBytes / 1024);
    const maxWriteKiB = Math.floor(maxWriteBytes / 1024);
    const rootCeilingKiB = Math.floor(rootDisk.totalBytes / 1024 * 0.85) - 8192;
    const pressureScript = `
set -eu
umask 077
set -C
file=$1
target=$2
maxwrite=$3
rootlimit=$4
: > "$file"
identity=$(/busybox stat -c '%d %i' "$file")
dev=\${identity% *}
ino=\${identity#* }
keep=0
cleanup() {
  if [ "$keep" -ne 1 ]; then
    current=$(/busybox stat -c '%d %i' "$file" 2>/dev/null || true)
    if [ "$current" = "$identity" ]; then /busybox rm -f -- "$file"; fi
  fi
}
trap cleanup EXIT
written=0
while :; do
  set -- $(/busybox df -Pk / | /busybox tail -n 1)
  root_total=$2
  root_used=$3
  set -- $(/busybox df -Pk /data | /busybox tail -n 1)
  data_total=$2
  data_used=$3
  if [ "$data_used" -ge "$target" ]; then break; fi
  remaining=$((target-data_used))
  chunk=4096
  if [ "$remaining" -lt "$chunk" ]; then chunk=$remaining; fi
  if [ $((written+chunk)) -gt "$maxwrite" ] || [ $((root_used+chunk)) -ge "$rootlimit" ]; then
    size=$(/busybox wc -c < "$file")
    printf '{"dev":%s,"ino":%s,"size":%s,"writtenKiB":%s,"status":"headroom-exhausted"}\\n' "$dev" "$ino" "$size" "$written"
    keep=1
    exit 0
  fi
  /busybox dd if=/dev/zero bs=1K count="$chunk" 2>/dev/null >> "$file"
  written=$((written+chunk))
done
/busybox sync
size=$(/busybox wc -c < "$file")
printf '{"dev":%s,"ino":%s,"size":%s,"writtenKiB":%s,"rootTotalKiB":%s,"rootUsedKiB":%s,"dataTotalKiB":%s,"dataUsedKiB":%s}\\n' "$dev" "$ino" "$size" "$written" "$root_total" "$root_used" "$data_total" "$data_used"
keep=1`;
    const diskIngest = async marker => {
      const response = await fetch(new URL(`/api/${encodeURIComponent(organization)}/${encodeURIComponent(config.telemetry.openObserve.streams.logs)}/_json`, baseUrl), {
        method: 'POST', headers: {Authorization: ingestAuthorization, 'Content-Type': 'application/json'},
        body: JSON.stringify([{_timestamp: String(Date.now() * 1000), message: 'bounded G14 disk admission probe', disk_pressure_run_id: marker}]),
        signal: AbortSignal.timeout(5000),
      });
      return response.status;
    };
    const pressureProbeId = `${runId}-disk`;
    if (await diskIngest(`${pressureProbeId}-baseline`) !== 200)
      throw new Error('scoped synthetic log ingestion did not pass before bounded disk pressure');
    let pressureIdentity;
    let pressureAfterRows;
    try {
      const output = run(['exec', openObserveName, '/busybox', 'sh', '-ceu', pressureScript, 'g14-pressure', pressurePath,
        String(dataTargetKiB), String(maxWriteKiB), String(rootCeilingKiB)]);
      pressureIdentity = JSON.parse(output);
      if (!Number.isSafeInteger(pressureIdentity.dev) || !Number.isSafeInteger(pressureIdentity.ino) || pressureIdentity.size > maxWriteBytes ||
          pressureIdentity.writtenKiB > maxWriteKiB || pressureIdentity.status === 'headroom-exhausted')
        throw new Error('bounded disk pressure helper returned invalid file identity or byte count');
      pressureAfterRows = diskRows();
      const rootAfter = pressureAfterRows.find(row => row.mountPoint === '/');
      const dataAfter = pressureAfterRows.find(row => row.mountPoint === '/data');
      if (!rootAfter || !dataAfter) throw new Error('bounded pressure did not retain both measured mounts');
      const rootUsedPercent = rootAfter.usedBytes * 100 / rootAfter.totalBytes;
      const dataUsedPercent = dataAfter.usedBytes * 100 / dataAfter.totalBytes;
      const aggregateAfterPercent = (rootAfter.usedBytes + dataAfter.usedBytes) * 100 / (rootAfter.totalBytes + dataAfter.totalBytes);
      if (rootUsedPercent >= 85 || dataUsedPercent < watermarkPercent || dataUsedPercent >= 85 ||
          aggregateAfterPercent < watermarkPercent || guardStatus() !== 1)
        throw new Error('bounded storage did not trip native aggregate admission and generated /data watermark guards within reserved headroom');
      await waitFor(async () => await diskIngest(`${pressureProbeId}-blocked`) === 503,
        {timeoutMs: 65000, intervalMs: 2000, description: 'native OpenObserve disk breaker rejects scoped synthetic ingestion after refresh'});
      evidence.diskPressure = {
        status: 'PASS',
        maximumWriteBytes: maxWriteBytes,
        writtenBytes: pressureIdentity.size,
        fileDev: pressureIdentity.dev,
        fileInode: pressureIdentity.ino,
        dataUsedPercent: Number(dataUsedPercent.toFixed(2)),
        dataDfReportedPercent: dataAfter.usedPercent,
        rootUsedPercent: Number(rootUsedPercent.toFixed(2)),
        rootDfReportedPercent: rootAfter.usedPercent,
        aggregateUsedPercent: Number(aggregateAfterPercent.toFixed(2)),
        watermarkPercent,
        rootReservedHeadroomBytes: rootDisk.totalBytes * 0.85 - rootAfter.usedBytes,
        generatedDataGuardRejected: true,
        nativeScopedIngestStatus: 503,
      };
    } finally {
      if (pressureIdentity) removePressureFile(pressureIdentity);
    }
    await waitFor(async () => {
      const afterCleanup = diskRows();
      const data = afterCleanup.find(row => row.mountPoint === '/data');
      const root = afterCleanup.find(row => row.mountPoint === '/');
      return data && root && data.usedPercent < watermarkPercent && guardStatus() === 0 &&
        (root.usedBytes + data.usedBytes) * 100 / (root.totalBytes + data.totalBytes) < watermarkPercent;
    }, {timeoutMs: 30000, intervalMs: 1000, description: 'generated OpenObserve disk guard recovers after owned pressure file cleanup'});
    await waitFor(async () => await diskIngest(`${pressureProbeId}-recovered`) === 200,
      {timeoutMs: 65000, intervalMs: 2000, description: 'native OpenObserve scoped ingestion recovers after owned pressure file cleanup'});
    evidence.diskPressure.cleanupVerified = true;
    evidence.diskPressure.recoveredIngestStatus = 200;
    evidence.diskPressureStatus = 'PASS';

    const retentionMs = config.telemetry.openObserve.retentionDays * 24 * 60 * 60 * 1000;
    const expiredTimestamp = Date.now() - retentionMs - 24 * 60 * 60 * 1000;
    const expiredEndTimeUs = (expiredTimestamp + 30 * 60 * 1000) * 1000;
    await setFixtureState({baseUrl: fixtureBaseUrl, runId, active: false, oldTimestamp: true});
    await fixtureRequest({baseUrl: fixtureBaseUrl, runId});
    await setFixtureState({baseUrl: fixtureBaseUrl, runId, active: false});
    const oldLogQuery = () => streamSearch({baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.logs, runId, field: 'body_g14_run_id', windowMs: 60 * 60 * 1000, endTimeUs: expiredEndTimeUs});
    await waitFor(async () => rows(await oldLogQuery()).length > 0, {timeoutMs: 60000, description: 'backdated fixture record visible before TTL expiry'});
    const ttlWaitMs = Math.max(65 * 60 * 1000, config.telemetry.openObserve.jobCleanupWaitSeconds * 2000);
    await waitFor(async () => rows(await oldLogQuery()).length === 0, {timeoutMs: ttlWaitMs, intervalMs: 30000, description: 'OpenObserve native retention TTL removal'});
    const filesystem = JSON.parse(run(['run', '--rm', '--network', 'none', '--mount', `type=volume,source=${storage.volumeName},target=/data,readonly`, '--entrypoint', 'node', toolchain.nodeImage, '-e', "const s=require('node:fs').statfsSync('/data'); process.stdout.write(JSON.stringify({totalBytes:s.blocks*s.bsize,freeBytes:s.bfree*s.bsize}))"]));
    const usedPercent = (filesystem.totalBytes - filesystem.freeBytes) * 100 / filesystem.totalBytes;
    if (usedPercent >= config.telemetry.openObserve.diskWatermarkPercent) throw new Error(`isolated telemetry filesystem crossed configured ${config.telemetry.openObserve.diskWatermarkPercent}% watermark`);
    evidence.retention = {configuredDays: config.telemetry.openObserve.retentionDays, fixtureOnlyIngestWindowHours: fixtureIngestWindowHours, backdatedRecordVisible: true, ttlRemovedRecord: true, usedPercent: Number(usedPercent.toFixed(2)), watermarkPercent: config.telemetry.openObserve.diskWatermarkPercent};

    const shutdownStartedAt = performance.now();
    const shutdownStartedAtUs = Date.now() * 1000;
    run(['kill', '--signal=SIGTERM', producerName]);
    await waitFor(() => JSON.parse(run(['inspect', '--format', '{{json .State}}', producerName])).Running === false,
      {timeoutMs: config.platform.shutdownGraceMs, intervalMs: 250, description: 'synthetic runtime graceful SIGTERM shutdown'});
    const shutdownState = JSON.parse(run(['inspect', '--format', '{{json .State}}', producerName]));
    const shutdownElapsedMs = Math.round(performance.now() - shutdownStartedAt);
    if (shutdownState.ExitCode !== 0 || shutdownState.OOMKilled || shutdownElapsedMs > config.platform.shutdownGraceMs)
      throw new Error('synthetic runtime did not exit cleanly within the configured SIGTERM grace period');
    const stopTimeSpanRows = await waitFor(async () => {
      const found = rows(await streamSearch({
        baseUrl, authorization, organization, stream: config.telemetry.openObserve.streams.traces,
        streamType: 'traces', filterSql: `"service_name" = 'g14-synthetic'`, startTimeUs: shutdownStartedAtUs,
      }));
      const matching = found.filter(record => {
        const service = record?.service_name;
        const spanName = record?.operation_name;
        return service === 'g14-synthetic' && spanName === 'g14.synthetic.shutdown' &&
          hasExactValue(record, runId);
      });
      return matching.length > 0 ? matching : false;
    }, {timeoutMs: 60000, intervalMs: 2000, description: 'stop-time synthetic span exported after SIGTERM'});
    evidence.runtimeShutdown = {
      exitCode: shutdownState.ExitCode,
      oomKilled: shutdownState.OOMKilled,
      elapsedMs: shutdownElapsedMs,
      gracePeriodMs: config.platform.shutdownGraceMs,
      stopTimeSpanExported: true,
      stopTimeSpanSampleCount: stopTimeSpanRows.length,
    };
    evidence.completedAt = new Date().toISOString();
    evidence.alertTransitions = 'PASS';
    evidence.nativeAlerts = 'PASS';
    evidence.streamDelivery = 'PASS';
    evidence.ingestionScope = 'PASS';
    evidence.retentionExpiry = 'PASS';
    evidence.collectorOutageRestart = 'PASS';
    evidence.runtimeShutdownStatus = 'PASS';
    const requiredGates = [
      evidence.runtimeMetricMatrix?.status, evidence.networkIsolation?.runtimeMetricMatrix?.status,
      evidence.launchPathCorrelation, evidence.nginxMetrics, evidence.alertTransitions, evidence.nativeAlerts,
      evidence.streamDelivery, evidence.ingestionScope, evidence.retentionExpiry, evidence.collectorOutageRestart,
      evidence.runtimeShutdownStatus, evidence.networkIsolation?.status, evidence.networkIsolation?.launchPathNetworkStatus,
      evidence.telemetryHealth?.openObserveOutage, evidence.telemetryHealth?.recoveryStatus,
      evidence.telemetryHealth?.launchPathCollectorConfig, evidence.telemetryHealth?.launchPathOutageStatus,
      evidence.collectorQueueMetrics?.status,
      evidence.diskPressureStatus,
    ];
    if (requiredGates.every(status => status === 'PASS')) {
      evidence.status = 'PASS';
      evidence.limitations.push('QEMU-эмуляция подтверждает функциональную интеграцию, но не производительность или capacity OpenObserve на нативном AVX/AES CPU.');
    } else {
      evidence.status = 'NOT_RUN';
      evidence.failure = 'G14 содержит обязательные критерии со статусом NOT_RUN; общий PASS не выставлен.';
    }
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.failure = error.message;
    if (error.launchFailure?.stage === 'orders-outbox-relay') evidence.launchFailure = error.launchFailure;
    evidence.completedAt = new Date().toISOString();
    const capturedNames = new Set(evidence.containerDiagnostics.map(item => item.name));
    for (const name of containers) {
      if (capturedNames.has(name)) continue;
      const diagnostic = captureContainerDiagnostics({name, stage: 'failure-before-cleanup', secrets: sensitiveValues});
      if (name.endsWith('-openobserve')) diagnostic.cgroup = openObserveCgroupDiagnostics(name);
      if (!diagnostic.state.unavailable || diagnostic.errorOrWarningLines || name.endsWith('-openobserve')) evidence.containerDiagnostics.push(diagnostic);
    }
    if (Array.isArray(error.containerDiagnostics)) {
      for (const diagnostic of error.containerDiagnostics) evidence.containerDiagnostics.push(diagnostic);
    }
  } finally {
    for (const name of containers.filter(value => value.endsWith('-openobserve') || value.endsWith('-collector'))) {
      const diagnostic = captureContainerDiagnostics({name, stage: 'pre-cleanup', secrets: sensitiveValues});
      if (name.endsWith('-openobserve')) diagnostic.cgroup = openObserveCgroupDiagnostics(name);
      evidence.containerDiagnostics.push(diagnostic);
    }
    for (const name of containers.reverse()) stop(name);
    for (const network of createdNetworks.reverse()) {
      try { run(['network', 'rm', network]); }
      catch (error) { cleanupErrors.push(`cannot remove fixture network: ${network}: ${error.message}`); }
    }
    if (storage) {
      try { removeStorage({storage, nodeImage: JSON.parse(await readFile(join(root, 'config/toolchain-versions.json'), 'utf8')).nodeImage, run}); }
      catch (error) { cleanupErrors.push(`cannot remove fixture storage: ${error.message}`); }
    }
    try { await rm(workDir, {recursive: true, force: true}); } catch (error) { cleanupErrors.push(`cannot remove temporary fixture files: ${error.message}`); }
  }
  if (cleanupErrors.length > 0) {
    evidence.status = 'FAIL';
    evidence.cleanupErrors = cleanupErrors;
    evidence.failure ??= 'fixture cleanup failed';
  }
  try {
    const persisted = await persistEvidence({root, evidence, secrets: sensitiveValues});
    evidence.evidenceDirectory = persisted.directory;
    evidence.resultSha256 = persisted.resultSha256;
  } catch (error) {
    evidence.status = 'FAIL';
    evidence.failure = `cannot persist sanitized evidence: ${error.message}`;
  }
  if (evidence.status !== 'PASS') throw Object.assign(new Error(evidence.failure ?? 'G14 verification did not pass'), {evidence});
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    let emulatorPath;
    let probePath = '/usr/bin/busybox';
    let hostTransportPath;
    if (args.length > 0) {
      while (args.length > 0) {
        const option = args.shift();
        const value = args.shift();
        if (!value || !['--emulator', '--probe', '--host-transport'].includes(option)) throw new Error('usage: node tools/observability/verify.mjs [--emulator <absolutePath>] [--probe <absolutePath>] [--host-transport <absolutePath>]');
        if (option === '--emulator') emulatorPath = value;
        else if (option === '--probe') probePath = value;
        else hostTransportPath = value;
      }
    }
    const evidence = await runObservabilityVerification({emulatorPath, probePath, hostTransportPath});
    console.log(JSON.stringify(evidence));
  } catch (error) {
    if (error.evidence) console.error(JSON.stringify(error.evidence));
    else console.error(JSON.stringify({status: 'FAIL', failure: error.message}));
    process.exitCode = 1;
  }
}
