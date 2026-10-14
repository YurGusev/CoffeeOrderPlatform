import {readFile} from 'node:fs/promises';
import {metrics, trace} from '/repo/packages/platform-observability/node_modules/@opentelemetry/api/build/src/index.js';
import {createPinoLogger, createTelemetryResource, setRuntimeReadiness, telemetryDiagnostics} from '/repo/packages/platform-observability/dist/index.js';
import {createRuntime} from '/repo/packages/platform-runtime/dist/index.js';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
const {config, runId, exporterToken, redactionCanary} = fixture;
const telemetry = createTelemetryResource(config.telemetry, 'g14-synthetic', exporterToken, runtimeMetrics);
const shutdownProbe = {
  name: 'g14-shutdown-probe',
  start() {},
  stop() {
    const span = trace.getTracer('g14.synthetic.shutdown').startSpan('g14.synthetic.shutdown', {
      attributes: {'g14.run_id': runId, 'g14.fixture': true},
    });
    span.end();
  },
  destroy() {},
};
const logger = createPinoLogger({service: 'g14-synthetic'}, config.telemetry.producer.maxRecordBytes);
let active = true;
let oldTimestamp = false;
let consumerLag = 0;
let oldestOutboxAgeMs = 0;
let unknownOutcomes = 0;
let sseAttempts = 0;
let sseDrops = 0;
let lastSseCounterIncrementAt = Date.now();

function runtimeMetrics() {
  return [
    `coffee_aroma_unknown_outcomes_current ${unknownOutcomes}`,
    `coffee_realtime_invalidation_attempts_total ${sseAttempts}`,
    `coffee_realtime_invalidation_dropped_total ${sseDrops}`,
  ];
}

function emit(request) {
  const now = Date.now();
  consumerLag = active ? 1 : 0;
  oldestOutboxAgeMs = active ? Math.max(1, config.telemetry.alerts.outboxOldestAge.threshold + 1) : 0;
  unknownOutcomes = active ? 1 : 0;
  if (active && now - lastSseCounterIncrementAt >= 100_000) {
    // Exercise a low-rate 50% drop ratio; a divisor floor of 1 would hide it.
    sseAttempts += 2;
    sseDrops += 1;
    lastSseCounterIncrementAt = now;
  } else {
    if (!active) sseAttempts += 1000;
  }
  const record = {g14_run_id: runId, g14_fixture: true, token: redactionCanary};
  if (oldTimestamp) record.time = now - ((config.telemetry.openObserve.retentionDays + 1) * 24 * 60 * 60 * 1000);
  request.log.info(record, 'synthetic observability sample');
  logger.info({g14_run_id: runId, g14_fixture: true}, 'synthetic runtime request');
}

const app = await createRuntime({
  name: 'g14-synthetic',
  host: '0.0.0.0',
  port: 4310,
  shutdownGraceMs: config.platform.shutdownGraceMs,
  health: config.platform.health,
  telemetryLogRecordBytes: config.telemetry.producer.maxRecordBytes,
  resources: [telemetry, shutdownProbe],
  metrics: runtimeMetrics,
  configure(server) {
    server.post('/synthetic', async (request, reply) => {
      request.runtimeSpan?.setAttribute('g14.run_id', runId);
      request.runtimeSpan?.setAttribute('g14.fixture', true);
      const span = trace.getTracer('g14.synthetic').startSpan('g14.synthetic.request', {attributes: {'g14.run_id': runId, 'g14.fixture': true}});
      span.end();
      emit(request);
      return reply.code(202).send({accepted: true, runId});
    });
    server.post('/test/state', async (request, reply) => {
      const body = request.body ?? {};
      if (typeof body.active !== 'boolean' || (body.oldTimestamp !== undefined && typeof body.oldTimestamp !== 'boolean'))
        return reply.code(400).send({error: 'invalid test state'});
      active = body.active;
      oldTimestamp = body.oldTimestamp === true;
      setRuntimeReadiness(!active);
      return {active, oldTimestamp};
    });
    server.post('/test/burst', async (request, reply) => {
      const count = request.body?.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 8192) return reply.code(400).send({error: 'invalid test count'});
      const tracer = trace.getTracer('g14.synthetic');
      for (let index = 0; index < count; index += 1) {
        const span = tracer.startSpan('g14.synthetic.queue-probe', {attributes: {'g14.run_id': runId, 'g14.fixture': true}});
        span.end();
      }
      return {accepted: count};
    });
    server.get('/test/diagnostics', async () => ({
      ...telemetryDiagnostics(),
      processId: process.pid,
      processStartTimeSeconds: performance.timeOrigin / 1000,
    }));
  },
});
await app.runtimeController.start();
const metricMeter = metrics.getMeter('g14-synthetic-fixture');
metricMeter.createObservableGauge('messaging.kafka.consumer.lag', {unit: 'messages'}).addCallback(observer => observer.observe(consumerLag));
metricMeter.createObservableGauge('messaging.outbox.oldest_unpublished.age', {unit: 'ms'}).addCallback(observer => observer.observe(oldestOutboxAgeMs));
logger.info({g14_run_id: runId, event: 'fixture.ready'}, 'synthetic runtime ready');
const timer = setInterval(() => {
  void fetch('http://127.0.0.1:4310/synthetic', {method: 'POST'}).catch(() => undefined);
}, 10000);
timer.unref();

async function shutdown() {
  clearInterval(timer);
  await app.runtimeController.closeRuntime('SIGTERM');
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
