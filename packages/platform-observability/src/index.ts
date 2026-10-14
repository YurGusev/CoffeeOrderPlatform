import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import pino, { type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from "pino";
import { context, metrics, trace, type Observable } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { createAllowListAttributesProcessor, PeriodicExportingMetricReader, MeterProvider } from "@opentelemetry/sdk-metrics";
import { BasicTracerProvider, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace-base";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogScalar = string | number | boolean | null;
export type LogValue =
  LogScalar | readonly LogValue[] | { readonly [key: string]: LogValue };
export type LogFields = Readonly<Record<string, LogValue>>;
let droppedLogRecords = 0;
export function logRecordsDropped(): number { return droppedLogRecords; }
let lastLogDropDiagnosticAt = 0;
function recordDroppedLogs(diagnosticIntervalMs = 10_000, count = 1, reason: "record" | "queue" = "record"): void {
  droppedLogRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedLogRecords + count);
  if (reason === "record") telemetrySerializationRejected = Math.min(Number.MAX_SAFE_INTEGER, telemetrySerializationRejected + count);
  else telemetryQueueOverflows = Math.min(Number.MAX_SAFE_INTEGER, telemetryQueueOverflows + count);
  const now = performance.now();
  if (lastLogDropDiagnosticAt === 0 || now - lastLogDropDiagnosticAt >= diagnosticIntervalMs) {
    lastLogDropDiagnosticAt = now;
    process.emitWarning("Structured log records dropped by configured telemetry bounds", {code: "LOG_RECORD_DROPPED"});
  }
}
let droppedTelemetryRecords = 0;
let failedTelemetryExports = 0;
let telemetryShutdownLoss = 0;
let telemetrySerializationRejected = 0;
let telemetryQueueOverflows = 0;
export function telemetryDiagnostics(): Readonly<{dropped: number; exportFailures: number; shutdownLoss: number; serializationRejected: number; queueOverflows: number}> {
  return {dropped: droppedTelemetryRecords, exportFailures: failedTelemetryExports, shutdownLoss: telemetryShutdownLoss, serializationRejected: telemetrySerializationRejected, queueOverflows: telemetryQueueOverflows};
}
let runtimeReadyValue = 0;
let registerRuntimeReadyGauge: (() => void) | undefined;
export function setRuntimeReadiness(ready: boolean): void {
  runtimeReadyValue = ready ? 1 : 0;
  registerRuntimeReadyGauge?.();
}
let recordRuntimeHttpMetric: ((durationMs: number, attributes: Readonly<Record<string, string>>) => void) | undefined;
export function recordRuntimeHttpRequest(durationMs: number, attributes: Readonly<Record<string, string>>): void {
  recordRuntimeHttpMetric?.(durationMs, attributes);
}

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "apiKey",
  "body",
  "payload",
  "cart",
  "cookie",
  "credential",
  "customer",
  "email",
  "err",
  "error",
  "exception",
  "header",
  "phone",
  "password",
  "passwd",
  "pii",
  "privateKey",
  "stack",
  "provider",
  "query",
  "sql",
  "db.statement",
  "url.full",
  "http.url",
  "statement",
  "secret",
  "token",
  "address",
  "displayName",
  "actorRef",
  "orderRef",
  "paymentRef",
  "invoiceRef",
  "idempotencyKey",
  "message",
  "description",
] as const;

function shouldRedact(key: string, sensitiveKeys: readonly string[]): boolean {
  const lower = key.replace(/[\s_.-]/gu, "").toLowerCase();
  return sensitiveKeys.some(
    (candidate) =>
      lower.includes(candidate.replace(/[\s_.-]/gu, "").toLowerCase()),
  );
}

export function redactLogValue(
  value: unknown,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): unknown {
  const active = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "function" || typeof current === "symbol") return "[REDACTED]";
    if (current instanceof Error) return {type: current.name, message: "[REDACTED]", stack: "[REDACTED]"};
    if (current === null || typeof current !== "object") return current;
    if (active.has(current) || depth >= 12) return "[REDACTED]";
    active.add(current);
    try {
      if (Array.isArray(current)) return current.slice(0, 100).map(entry => visit(entry, depth + 1));
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        if (key === "req" && entry !== null && typeof entry === "object") {
          const request = entry as {method?: string; routeOptions?: {url?: string}; correlationContext?: {correlationId?: string}; id?: string};
          result[key] = {
            ...(request.method === undefined ? {} : {method: request.method}),
            ...(request.routeOptions?.url === undefined ? {} : {url: request.routeOptions.url}),
            ...((request.correlationContext?.correlationId ?? request.id) === undefined ? {} : {correlationId: request.correlationContext?.correlationId ?? request.id}),
          };
        } else {
          result[key] = shouldRedact(key, sensitiveKeys) ? "[REDACTED]" : visit(entry, depth + 1);
        }
      }
      return result;
    } catch {
      return "[REDACTED]";
    } finally {
      active.delete(current);
    }
  };
  return visit(value, 0);
}

export function redactLogFields(
  fields: Readonly<Record<string, unknown>>,
  sensitiveKeys: readonly string[] = DEFAULT_SENSITIVE_KEYS,
): Readonly<Record<string, unknown>> {
  return redactLogValue(fields, sensitiveKeys) as Readonly<Record<string, unknown>>;
}

function loggerOptions(baseFields: LogFields, maxRecordBytes = 16_384, diagnosticIntervalMs = 10_000): LoggerOptions {
  return {
    base: redactLogFields(baseFields) as Record<string, unknown>,
    mixin() {
      const span = trace.getActiveSpan()?.spanContext();
      return span === undefined || span.traceId === "0".repeat(32)
        ? {}
        : {traceId: span.traceId, spanId: span.spanId};
    },
    serializers: {
      err: redactLogValue as (value: Error) => Record<string, unknown>,
      req: (request: {method?: string; routeOptions?: {url?: string}; correlationContext?: {correlationId?: string}; correlationId?: string; id?: string}) => ({
        method: request.method,
        ...(request.routeOptions?.url === undefined ? {} : {url: request.routeOptions.url}),
        ...((request.correlationContext?.correlationId ?? request.correlationId ?? request.id) === undefined ? {} : {correlationId: request.correlationContext?.correlationId ?? request.correlationId ?? request.id}),
      }),
    },
    hooks: {
      logMethod(args, method) {
        let safeArgs = args.map((value) => value !== null && typeof value === "object" ? redactLogValue(value) : value);
        let oversized = false;
        try {
          const span = trace.getActiveSpan()?.spanContext();
          const mixin = span === undefined || span.traceId === "0".repeat(32)
            ? {}
            : {traceId: span.traceId, spanId: span.spanId};
          const message = safeArgs.find((value): value is string => typeof value === "string");
          const record = {level: 30, time: Math.trunc(performance.timeOrigin + performance.now()), pid: process.pid, hostname: "x", ...this.bindings(), ...mixin, args: safeArgs, ...(message === undefined ? {} : {msg: message})};
          oversized = Buffer.byteLength(JSON.stringify(record)) + 128 > maxRecordBytes;
        }
        catch { oversized = true; }
        if (oversized) {
          recordDroppedLogs(diagnosticIntervalMs);
          return;
        }
        method.apply(this, safeArgs as [unknown, string?, ...unknown[]]);
      },
    },
  } satisfies LoggerOptions;
}

export function createPinoLogger(baseFields: LogFields = {}, maxRecordBytes = 16_384, destination?: DestinationStream, queueCapacity = 1, diagnosticIntervalMs = 10_000): PinoLogger {
  if (destination !== undefined) return protectChild(pino(loggerOptions(baseFields, maxRecordBytes, diagnosticIntervalMs), destination));
  const stream = pino.destination({dest: 1, sync: false, maxLength: maxRecordBytes * queueCapacity});
  stream.on("drop", (chunk: string) => recordDroppedLogs(diagnosticIntervalMs, chunk.split("\n").filter(Boolean).length, "queue"));
  return protectChild(pino(loggerOptions(baseFields, maxRecordBytes, diagnosticIntervalMs), stream));
}

function protectChild(logger: PinoLogger): PinoLogger {
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf(logger)) as {child?: unknown} | null;
  const child = prototype?.child as ((this: PinoLogger, bindings: Record<string, unknown>, options?: unknown) => PinoLogger) | undefined;
  if (child === undefined) throw new TypeError("Pino child method is unavailable");
  Object.defineProperty(logger, "child", {
    value: function(this: PinoLogger, bindings: Record<string, unknown>, options?: unknown) {
      return child.call(this, redactLogFields(bindings), options);
    },
  });
  return logger;
}

export type Logger = PinoLogger;

export type TelemetryResource = Readonly<{
  name: "telemetry";
  start: () => void;
  stop: (signal: AbortSignal) => Promise<void>;
  destroy: () => void;
}>;

type TelemetryRuntimeConfig = Readonly<{
  environment: "development" | "staging" | "production";
  namespace: string;
  releaseDigest: string;
  collector: Readonly<{otlpEndpoint: string}>;
  producer: Readonly<{queueCapacity: number; maxRecordBytes: number; batchSize: number; batchIntervalMs: number; exportTimeoutMs: number; diagnosticIntervalMs: number; flushTimeoutMs: number}>;
}>;

const OWNER_METRICS: Readonly<Record<string, Readonly<{counter?: true; labels?: Readonly<Record<string, readonly string[]>>}>>> = {
  coffee_realtime_connections:{},coffee_realtime_scheduled_connections:{},coffee_realtime_writing_connections:{},coffee_realtime_writing_records:{},
  coffee_realtime_queue_records:{},coffee_realtime_queue_bytes:{},coffee_realtime_ring_records:{},coffee_realtime_ring_bytes:{},
  coffee_realtime_slow_close_total:{counter:true},coffee_realtime_ring_evictions_total:{counter:true},coffee_realtime_auth_close_total:{counter:true},
  coffee_realtime_invalidation_attempts_total:{counter:true},coffee_realtime_invalidation_dropped_total:{counter:true},
  coffee_realtime_event_loop_delay_p95_ms:{},coffee_realtime_event_loop_delay_samples:{counter:true},
  coffee_catalog_import_batches_total:{counter:true},coffee_catalog_import_batch_bytes_total:{counter:true},
  coffee_catalog_import_batch_duration_seconds_sum:{counter:true},coffee_catalog_import_batch_duration_seconds_count:{counter:true},
  coffee_catalog_import_backpressure_seconds_sum:{counter:true,labels:{phase:["stream","copy"]}},
  coffee_catalog_import_backpressure_seconds_count:{counter:true,labels:{phase:["stream","copy"]}},
  coffee_catalog_import_duration_seconds_sum:{counter:true},coffee_catalog_import_duration_seconds_count:{counter:true},
  coffee_catalog_import_age_seconds:{},coffee_catalog_import_has_success:{},
  coffee_catalog_import_results_total:{counter:true,labels:{outcome:["success","failure","unknown","aborted"]}},
  coffee_catalog_import_scheduler_skipped_total:{counter:true},
  coffee_aroma_observation_results_total:{counter:true,labels:{result:["idle","observed","failed"]}},
  coffee_aroma_observation_recovery_results_total:{counter:true,labels:{result:["ready","error"]}},
  coffee_aroma_observation_fence_failures_total:{counter:true},coffee_aroma_observed_age_ms:{},
  coffee_aroma_attempt_results_total:{counter:true,labels:{result:["no_op_in_sync","verified_in_sync","out_of_sync","blocked","unknown_outcome","failed"]}},
  coffee_aroma_recovery_results_total:{counter:true,labels:{result:["completed","failed","unknown_outcome","recovered_applied","recovered_not_applied","external_change"]}},
  coffee_aroma_mutation_calls_total:{counter:true,labels:{action:["set_quantity","remove"]}},
  coffee_aroma_lease_failures_total:{counter:true},coffee_aroma_fence_failures_total:{counter:true},coffee_aroma_unknown_outcomes_total:{counter:true},
  coffee_aroma_unknown_outcomes_current:{},
  coffee_aroma_blockers_total:{counter:true},coffee_aroma_provider_failures_total:{counter:true},
  coffee_aroma_preparation_inbox_results_total:{counter:true,labels:{result:["catalog_changed","order_confirmed","reconciliation_requested","other","error"]}},
  coffee_aroma_preparation_recompute_results_total:{counter:true,labels:{result:["changed","unchanged","error"]}},
  coffee_aroma_preparation_projection_results_total:{counter:true,labels:{result:["changed","unchanged","error"]}},
  coffee_aroma_preparation_recovery_results_total:{counter:true,labels:{result:["completed","idle","error"]}},
  coffee_aroma_preparation_desired_age_ms:{},
  coffee_aroma_convergence_ready:{},coffee_aroma_observation_ready:{},coffee_aroma_preparation_ready:{},
  coffee_orders_outbox_relay_ready:{},
};
const METRIC_LINE = /^([a-z][a-z0-9_]*)(?:\{([a-z][a-z0-9_]*)="([a-z][a-z0-9_]*)"\})? (-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/u;
const SAFE_METRIC_ATTRIBUTE_KEYS = ["orders.operation","orders.result","orders.state","db.owner","transaction.mode","transaction.outcome","messaging.destination.name","messaging.consumer.group","messaging.destination.partition.id","http.request.method","http.route","http.response.status_class","phase","result","action","outcome"];

function ownerMetricSamples(lines: readonly string[]): Map<string, Readonly<{value:number;attributes:Readonly<Record<string,string>>}>> {
  const samples = new Map<string, Readonly<{value:number;attributes:Readonly<Record<string,string>>}>>();
  for (const line of lines) {
    const match = METRIC_LINE.exec(line);
    if (match === null) continue;
    const [, name, label, labelValue, valueText] = match;
    const definition = name === undefined ? undefined : OWNER_METRICS[name];
    const value = Number(valueText);
    if (definition === undefined || !Number.isFinite(value)) continue;
    if (label === undefined) {
      if (definition.labels !== undefined) continue;
      samples.set(name!, {value,attributes:{}});
      continue;
    }
    const allowed = definition.labels?.[label];
    if (allowed === undefined || labelValue === undefined || !allowed.includes(labelValue)) continue;
    samples.set(`${name}{${label}=${labelValue}}`, {value,attributes:{[label]:labelValue}});
  }
  return samples;
}

export function createTelemetryResource(
  config: TelemetryRuntimeConfig,
  runtime: string,
  exporterToken: string,
  runtimeMetrics?: () => readonly string[],
): TelemetryResource {
  if (exporterToken.length === 0) throw new TypeError("telemetry exporter token is required");
  const headers = {authorization: `Bearer ${exporterToken}`};
  const resource = resourceFromAttributes({
    "deployment.environment": config.environment,
    "service.namespace": config.namespace,
    "service.name": runtime,
    "service.version": config.releaseDigest,
  });
  const traceExporter = new OTLPTraceExporter({url: `${config.collector.otlpEndpoint.replace(/\/$/u, "")}/v1/traces`, headers, timeoutMillis: config.producer.exportTimeoutMs});
  const spans: ReadableSpan[] = [];
  let exportInProgress = false;
  let inFlightSpanCount = 0;
  let discardNewSpans = false;
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastDiagnosticAt = 0;
  let resolveDrain: (() => void) | undefined;
  const recordFailure = (): void => {
    failedTelemetryExports = Math.min(Number.MAX_SAFE_INTEGER, failedTelemetryExports + 1);
    const now = performance.now();
    if (lastDiagnosticAt === 0 || now - lastDiagnosticAt >= config.producer.diagnosticIntervalMs) {
      lastDiagnosticAt = now;
      process.emitWarning("OpenTelemetry exporter failed; telemetry is best effort", {code: "OTEL_EXPORT_FAILED"});
    }
  };
  const discardPendingSpans = (): void => {
    const lost = spans.length + inFlightSpanCount;
    if (batchTimer !== undefined) { clearTimeout(batchTimer); batchTimer = undefined; }
    spans.length = 0;
    inFlightSpanCount = 0;
    exportInProgress = false;
    discardNewSpans = true;
    const resolve = resolveDrain;
    resolveDrain = undefined;
    resolve?.();
    if (lost === 0) return;
    telemetryShutdownLoss = Math.min(Number.MAX_SAFE_INTEGER, telemetryShutdownLoss + lost);
    const now = performance.now();
    if (lastDiagnosticAt === 0 || now - lastDiagnosticAt >= config.producer.diagnosticIntervalMs) {
      lastDiagnosticAt = now;
      process.emitWarning("OpenTelemetry spans dropped at bounded shutdown", {code: "OTEL_SHUTDOWN_LOSS"});
    }
  };
  const settleDrain = (): void => {
    if (!exportInProgress && spans.length === 0) { const resolve = resolveDrain; resolveDrain = undefined; resolve?.(); }
  };
  const scheduleDrain = (): void => {
    if (batchTimer !== undefined || spans.length === 0) return;
    batchTimer = setTimeout(() => { batchTimer = undefined; drain(); }, config.producer.batchIntervalMs);
    batchTimer.unref();
  };
  const drain = (): void => {
    if (exportInProgress || spans.length === 0) { settleDrain(); return; }
    if (batchTimer !== undefined) { clearTimeout(batchTimer); batchTimer = undefined; }
    exportInProgress = true;
    const batch = spans.splice(0, config.producer.batchSize);
    inFlightSpanCount = batch.length;
    try {
      traceExporter.export(batch, result => {
        if (result.code !== 0) recordFailure();
        exportInProgress = false;
        inFlightSpanCount = 0;
        if (spans.length >= config.producer.batchSize) drain();
        else { scheduleDrain(); settleDrain(); }
      });
    } catch {
      recordFailure();
      exportInProgress = false;
      inFlightSpanCount = 0;
      if (spans.length >= config.producer.batchSize) drain();
      else { scheduleDrain(); settleDrain(); }
    }
  };
  const processor: SpanProcessor = {
    onStart() {},
    onEnd(span) {
      if (discardNewSpans) { droppedTelemetryRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedTelemetryRecords + 1); return; }
      const safe = new Proxy(span, {get(target, property) {
        if (property === "attributes") return redactLogFields(target.attributes);
        if (property === "events") return target.events.map(event => ({...event, attributes: redactLogFields(event.attributes ?? {})}));
        if (property === "links") return target.links.map(link => ({...link, attributes: redactLogFields(link.attributes ?? {})}));
        if (property === "status") return target.status.message === undefined ? target.status : {...target.status, message: "[REDACTED]"};
        if (property === "name" && /^(?:select|insert|update|delete|replace|with)\b/iu.test(target.name)) return "[REDACTED]";
        return Reflect.get(target, property, target);
      }});
      let bytes = Number.POSITIVE_INFINITY;
      try { bytes = Buffer.byteLength(JSON.stringify({name: safe.name, attributes: safe.attributes, events: safe.events, links: safe.links})); } catch {}
      if (spans.length + inFlightSpanCount >= config.producer.queueCapacity || bytes > config.producer.maxRecordBytes) {
        droppedTelemetryRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedTelemetryRecords + 1);
        if (bytes > config.producer.maxRecordBytes) telemetrySerializationRejected = Math.min(Number.MAX_SAFE_INTEGER, telemetrySerializationRejected + 1);
        else telemetryQueueOverflows = Math.min(Number.MAX_SAFE_INTEGER, telemetryQueueOverflows + 1);
        const now = performance.now();
        if (lastDiagnosticAt === 0 || now - lastDiagnosticAt >= config.producer.diagnosticIntervalMs) {
          lastDiagnosticAt = now;
          process.emitWarning("OpenTelemetry span dropped by configured telemetry bounds", {code: "OTEL_SPAN_DROPPED"});
        }
        return;
      }
      spans.push(safe);
      if (spans.length >= config.producer.batchSize) drain();
      else scheduleDrain();
    },
    forceFlush() {
      if (!exportInProgress && spans.length === 0) return Promise.resolve();
      return new Promise(resolve => { resolveDrain = resolve; drain(); });
    },
    async shutdown() {
      await this.forceFlush();
      await traceExporter.shutdown();
    },
  };
  const tracerProvider = new BasicTracerProvider({resource, spanProcessors: [processor]});
  const metricExporter = new OTLPMetricExporter({url: `${config.collector.otlpEndpoint.replace(/\/$/u, "")}/v1/metrics`, headers, timeoutMillis: config.producer.exportTimeoutMs});
  const trackedMetricExporter = new Proxy(metricExporter, {get(target, property) {
    if (property === "export") return (data: Parameters<typeof target.export>[0], callback: Parameters<typeof target.export>[1]) => {
      try {
        target.export(data, result => {
          if (result.code !== 0) recordFailure();
          callback(result);
        });
      } catch { recordFailure(); callback({code: 1, error: new Error("metric export failed")}); }
    };
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  }});
  const meterProvider = new MeterProvider({
    resource,
    views: [{instrumentName:"*",attributesProcessors:[createAllowListAttributesProcessor(SAFE_METRIC_ATTRIBUTE_KEYS)]}],
    readers: [new PeriodicExportingMetricReader({
      exporter: trackedMetricExporter,
      exportIntervalMillis: config.producer.batchIntervalMs,
      exportTimeoutMillis: config.producer.exportTimeoutMs,
      maxExportBatchSize: config.producer.batchSize,
      cardinalityLimits: {default: Math.min(2000, config.producer.queueCapacity)},
    })],
  });
  const processMeter = meterProvider.getMeter("coffee-platform.runtime-process");
  const httpRequests = processMeter.createCounter("runtime_http_requests_total");
  const httpRequestDuration = processMeter.createHistogram("runtime_http_request_duration_ms", {unit: "ms"});
  const runtimeHttpMetricRecorder = (durationMs: number, attributes: Readonly<Record<string, string>>): void => {
    httpRequests.add(1, attributes);
    httpRequestDuration.record(durationMs, attributes);
  };
  let runtimeReadyGaugeRegistered = false;
  const registerReadyGauge = (): void => {
    if (runtimeReadyGaugeRegistered) return;
    runtimeReadyGaugeRegistered = true;
    processMeter.createObservableGauge("runtime_ready").addCallback(result => result.observe(runtimeReadyValue));
  };
  for (const [name, read] of [
    ["telemetry_log_records_dropped_total", logRecordsDropped],
    ["telemetry_records_dropped_total", () => droppedTelemetryRecords],
    ["telemetry_export_failures_total", () => failedTelemetryExports],
    ["telemetry_shutdown_losses_total", () => telemetryShutdownLoss],
    ["telemetry_serialization_rejections_total", () => telemetrySerializationRejected],
    ["telemetry_queue_overflows_total", () => telemetryQueueOverflows],
  ] as const) {
    const counter = processMeter.createObservableCounter(name);
    counter.addCallback(result => result.observe(read()));
  }
  processMeter.createObservableGauge("runtime_process_start_time_seconds").addCallback(result => result.observe(performance.timeOrigin / 1000));
  const eventLoopDelay = monitorEventLoopDelay({resolution: 20});
  let previousEventLoopUtilization = performance.eventLoopUtilization();
  let gcPauseCount = 0;
  let gcPauseTotalMs = 0;
  const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {gcPauseCount += 1; gcPauseTotalMs += entry.duration;}
  });
  const observeGauge = (name: string, read: () => number, unit = ""): void => {
    processMeter.createObservableGauge(name, unit === "" ? {} : {unit}).addCallback(result => result.observe(read()));
  };
  observeGauge("runtime_event_loop_utilization", () => {
    const current = performance.eventLoopUtilization(previousEventLoopUtilization);
    previousEventLoopUtilization = performance.eventLoopUtilization();
    return current.utilization;
  });
  for (const percentile of [50,95,99]) observeGauge(`runtime_event_loop_delay_p${percentile}_ms`, () => eventLoopDelay.count === 0 ? 0 : eventLoopDelay.percentile(percentile) / 1e6, "ms");
  observeGauge("runtime_event_loop_delay_samples", () => eventLoopDelay.count);
  for (const [name, key] of [["runtime_process_rss_bytes","rss"],["runtime_process_heap_used_bytes","heapUsed"],["runtime_process_heap_total_bytes","heapTotal"],["runtime_process_external_bytes","external"],["runtime_process_array_buffers_bytes","arrayBuffers"]] as const)
    observeGauge(name, () => process.memoryUsage()[key], "By");
  const gcCount = processMeter.createObservableCounter("runtime_gc_pause_count_total");
  gcCount.addCallback(result => result.observe(gcPauseCount));
  observeGauge("runtime_gc_pause_total_ms", () => gcPauseTotalMs, "ms");
  const ownerMeter = meterProvider.getMeter("coffee-platform.runtime-owner-metrics");
  const ownerInstruments = new Map<string, Observable>();
  for (const [name, definition] of Object.entries(OWNER_METRICS)) {
    ownerInstruments.set(name, definition.counter === true ? ownerMeter.createObservableCounter(name) : ownerMeter.createObservableGauge(name));
  }
  if (runtimeMetrics !== undefined) {
    const instruments = [...ownerInstruments.values()];
    ownerMeter.addBatchObservableCallback(result => {
      let samples: Map<string, Readonly<{value:number;attributes:Readonly<Record<string,string>>}>>;
      try { samples = ownerMetricSamples(runtimeMetrics()); } catch { return; }
      for (const [key, sample] of samples) {
        const separator = key.indexOf("{");
        const name = separator < 0 ? key : key.slice(0, separator);
        const instrument = ownerInstruments.get(name);
        if (instrument !== undefined) result.observe(instrument, sample.value, sample.attributes);
      }
    }, instruments);
  }
  const contextManager = new AsyncLocalStorageContextManager();
  let started = false;
  const bounded = async (operation: Promise<unknown>, signal: AbortSignal): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        operation.then(() => undefined),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("telemetry shutdown timeout")), config.producer.flushTimeoutMs);
          timer.unref();
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, {once: true});
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  };
  return {
    name: "telemetry",
    start() {
      if (started) return;
      if (!context.setGlobalContextManager(contextManager.enable()) ||
          !trace.setGlobalTracerProvider(tracerProvider) ||
          !metrics.setGlobalMeterProvider(meterProvider))
        throw new Error("OpenTelemetry globals are already configured");
      registerRuntimeReadyGauge = registerReadyGauge;
      recordRuntimeHttpMetric = runtimeHttpMetricRecorder;
      started = true;
      eventLoopDelay.enable();
      gcObserver.observe({entryTypes:["gc"]});
    },
    async stop(signal) {
      if (!started) return;
      try {
        await bounded(Promise.all([tracerProvider.forceFlush(), meterProvider.forceFlush()]), signal);
      } catch { discardPendingSpans(); }
      try {
        await bounded(Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]), signal);
      } catch { /* Exporter shutdown is bounded and best effort. */ }
      finally {
        eventLoopDelay.disable();
        gcObserver.disconnect();
        context.disable();
        trace.disable();
        metrics.disable();
        if (registerRuntimeReadyGauge === registerReadyGauge) registerRuntimeReadyGauge = undefined;
        if (recordRuntimeHttpMetric === runtimeHttpMetricRecorder) recordRuntimeHttpMetric = undefined;
        started = false;
      }
    },
    destroy() {
      eventLoopDelay.disable();
      gcObserver.disconnect();
      contextManager.disable();
      void tracerProvider.shutdown().catch(() => undefined);
      void meterProvider.shutdown().catch(() => undefined);
      context.disable();
      trace.disable();
      metrics.disable();
      if (registerRuntimeReadyGauge === registerReadyGauge) registerRuntimeReadyGauge = undefined;
      if (recordRuntimeHttpMetric === runtimeHttpMetricRecorder) recordRuntimeHttpMetric = undefined;
      started = false;
    },
  };
}

export type CorrelationContext = Readonly<{
  correlationId: string;
  traceparent?: string;
  causationId?: string;
}>;

export type HeaderValue = string | readonly string[] | undefined;
export type HeaderSource =
  | Readonly<Record<string, HeaderValue>>
  | Readonly<{ get(name: string): string | null }>;

const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRACEPARENT_PATTERN =
  /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u;
const CORRELATION_HEADER = "x-correlation-id";
const TRACEPARENT_HEADER = "traceparent";
const CAUSATION_HEADER = "x-causation-id";

function header(
  source: HeaderSource | undefined,
  name: string,
): string | undefined {
  if (source === undefined) return undefined;
  if ("get" in source && typeof source.get === "function")
    return source.get(name) ?? undefined;
  const value = Object.entries(source).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function isCorrelationId(value: string): boolean {
  return CORRELATION_ID_PATTERN.test(value);
}

export function isTraceparent(value: string): boolean {
  if (!TRACEPARENT_PATTERN.test(value)) return false;
  const [version, traceId, parentId] = value.split("-");
  return (
    version === "00" &&
    traceId !== "0".repeat(32) &&
    parentId !== "0".repeat(16)
  );
}

/**
 * Resolve the transport context once at the process boundary. Invalid incoming
 * values are intentionally discarded instead of being propagated downstream.
 */
export function createCorrelationContext(
  source?: HeaderSource,
  fallbackCorrelationId?: string,
): CorrelationContext {
  const incomingCorrelationId = header(source, CORRELATION_HEADER);
  const correlationId =
    incomingCorrelationId !== undefined &&
    isCorrelationId(incomingCorrelationId)
      ? incomingCorrelationId
      : fallbackCorrelationId !== undefined &&
          isCorrelationId(fallbackCorrelationId)
        ? fallbackCorrelationId
        : randomUUID();
  const traceparent = header(source, TRACEPARENT_HEADER);
  const causationId = header(source, CAUSATION_HEADER);
  return {
    correlationId,
    ...(traceparent !== undefined && isTraceparent(traceparent)
      ? { traceparent }
      : {}),
    ...(causationId !== undefined &&
    causationId.length > 0 &&
    causationId.length <= 128
      ? { causationId }
      : {}),
  };
}

export function correlationHeaders(
  context: CorrelationContext,
): Readonly<Record<string, string>> {
  return {
    [CORRELATION_HEADER]: context.correlationId,
    ...(context.traceparent === undefined
      ? {}
      : { [TRACEPARENT_HEADER]: context.traceparent }),
  };
}

export function withCorrelationFields(context: CorrelationContext): LogFields {
  return {
    correlationId: context.correlationId,
    ...(context.traceparent === undefined
      ? {}
      : { traceparent: context.traceparent }),
    ...(context.causationId === undefined
      ? {}
      : { causationId: context.causationId }),
  };
}
