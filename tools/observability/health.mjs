import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadPlatformConfig} from '../../scripts/config-lib.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function requireHealthy(name, url, timeoutMs, fetchImpl) {
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`${name} health returned HTTP ${response.status}`);
  return {name, status: response.status};
}

export async function checkObservabilityHealth({config, fetchImpl = fetch} = {}) {
  if (!config?.telemetry?.collector?.healthEndpoint || !config?.telemetry?.openObserve?.endpoint) {
    throw new Error('collector and OpenObserve endpoints are required');
  }
  const timeoutMs = config.platform?.health?.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('platform.health.timeoutMs must be a positive safe integer');
  }
  const collectorUrl = new URL(config.telemetry.collector.healthEndpoint);
  collectorUrl.pathname = collectorUrl.pathname === '/' ? '/' : `${collectorUrl.pathname.replace(/\/$/u, '')}/`;
  const openObserveUrl = new URL('/healthz', config.telemetry.openObserve.endpoint);
  return Promise.all([
    requireHealthy('otel-collector', collectorUrl, timeoutMs, fetchImpl),
    requireHealthy('openobserve', openObserveUrl, timeoutMs, fetchImpl),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadPlatformConfig(REPO_ROOT);
    for (const result of await checkObservabilityHealth({config})) console.log(`${result.name}: HTTP ${result.status}`);
  } catch (error) {
    console.error(`observability health failed: ${error.message}`);
    process.exitCode = 1;
  }
}
