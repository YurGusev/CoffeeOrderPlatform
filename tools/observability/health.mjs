import {dirname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function requireHealthy(name, url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`${name} health returned HTTP ${response.status}`);
  return {name, status: response.status};
}

export async function checkObservabilityHealth({config, collectorProbe, fetchImpl = fetch} = {}) {
  if (!config?.telemetry?.collector?.healthEndpoint || ['grafana', 'loki', 'prometheus', 'tempo'].some(name => !config.telemetry[name]?.endpoint)) {
    throw new Error('collector and backend endpoints are required');
  }
  const timeoutMs = config.platform?.health?.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('platform.health.timeoutMs must be a positive safe integer');
  }
  if (typeof collectorProbe !== 'function') throw new Error('a Collector loopback probe is required');
  return Promise.all([
    Promise.resolve().then(collectorProbe).then(ok => { if (ok !== true) throw new Error('Collector loopback probe failed'); return {name: 'otel-collector', status: 200}; }),
    ...['grafana', 'loki', 'prometheus', 'tempo'].map(name => requireHealthy(name, new URL(name === 'grafana' ? '/api/health' : name === 'prometheus' ? '/-/ready' : '/ready', config.telemetry[name].endpoint), timeoutMs, fetchImpl)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadPlatformConfig(REPO_ROOT);
    const index = process.argv.indexOf('--collector-container');
    const container = process.argv[index + 1];
    if (index < 0 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(container ?? '')) throw new Error('--collector-container is required');
    const port = new URL(config.telemetry.collector.healthEndpoint).port;
    const timeout = Math.max(1, Math.ceil(config.platform.health.timeoutMs / 1000));
    const collectorProbe = () => { execFileSync('docker', ['exec', container, '/busybox', 'wget', '-q', '-O', '/dev/null', '-T', String(timeout), `http://127.0.0.1:${port}/-/ready`], {timeout: config.platform.health.timeoutMs + 1000}); return true; };
    for (const result of await checkObservabilityHealth({config, collectorProbe})) console.log(`${result.name}: HTTP ${result.status}`);
  } catch (error) {
    console.error(`observability health failed: ${error.message}`);
    process.exitCode = 1;
  }
}
