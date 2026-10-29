import { trace, type Span, SpanStatusCode } from "@opentelemetry/api";

export const GATEWAY_METRIC_NAMES = [
  "sessionAttempts",
  "sessionCacheHits",
  "sessionLogins",
  "sessionFailures",
  "safeReadAttempts",
  "safeReadReauthenticated",
  "safeReadFailures",
  "safeReadBytes",
  "catalogBatches",
  "catalogBatchBytes",
  "catalogFailures",
  "journalAcquire",
  "journalDispatch",
  "journalTerminalPersistence",
  "mutationAcknowledged",
  "mutationRejected",
  "mutationUnknown",
  "providerLatencyMs",
] as const;

export type GatewayMetricName = (typeof GATEWAY_METRIC_NAMES)[number];
type ResultMetric =
  | "sessionResult"
  | "safeReadResult"
  | "catalogResult"
  | "journalState"
  | "mutationOutcome";
type ResultValue =
  | "cache_hit"
  | "login"
  | "failure"
  | "success"
  | "reauthenticated"
  | "reserved"
  | "dispatched"
  | "acknowledged"
  | "rejected"
  | "unknown";

const ENDED_SPANS = new WeakSet<object>();

const RESULT_VALUES: Readonly<Record<ResultMetric, readonly ResultValue[]>> = {
  sessionResult: ["cache_hit", "login", "failure"],
  safeReadResult: ["success", "reauthenticated", "failure"],
  catalogResult: ["success", "failure"],
  journalState: [
    "reserved",
    "dispatched",
    "acknowledged",
    "rejected",
    "unknown",
  ],
  mutationOutcome: ["acknowledged", "rejected", "unknown"],
};

const RESULT_METRIC_NAMES: Readonly<Record<ResultMetric, string>> = {
  sessionResult: "aroma_gateway_session_results_total",
  safeReadResult: "aroma_gateway_safe_read_results_total",
  catalogResult: "aroma_gateway_catalog_results_total",
  journalState: "aroma_gateway_journal_states_total",
  mutationOutcome: "aroma_gateway_mutation_outcomes_total",
};

const COUNTER_METRIC_NAMES: Readonly<Record<GatewayMetricName, string>> = {
  sessionAttempts: "aroma_gateway_session_attempts_total",
  sessionCacheHits: "aroma_gateway_session_cache_hits_total",
  sessionLogins: "aroma_gateway_session_logins_total",
  sessionFailures: "aroma_gateway_session_failures_total",
  safeReadAttempts: "aroma_gateway_safe_read_attempts_total",
  safeReadReauthenticated: "aroma_gateway_safe_read_reauthenticated_total",
  safeReadFailures: "aroma_gateway_safe_read_failures_total",
  safeReadBytes: "aroma_gateway_safe_read_bytes_total",
  catalogBatches: "aroma_gateway_catalog_batches_total",
  catalogBatchBytes: "aroma_gateway_catalog_batch_bytes_total",
  catalogFailures: "aroma_gateway_catalog_failures_total",
  journalAcquire: "aroma_gateway_journal_acquire_total",
  journalDispatch: "aroma_gateway_journal_dispatch_total",
  journalTerminalPersistence:
    "aroma_gateway_journal_terminal_persistence_total",
  mutationAcknowledged: "aroma_gateway_mutation_acknowledged_total",
  mutationRejected: "aroma_gateway_mutation_rejected_total",
  mutationUnknown: "aroma_gateway_mutation_unknown_total",
  providerLatencyMs: "aroma_gateway_provider_latency_ms_total",
};

function finiteResult(
  metric: ResultMetric,
  value: string,
): value is ResultValue {
  return RESULT_VALUES[metric].includes(value as ResultValue);
}

/** In-process, bounded metrics for the Gateway-owned /metrics endpoint. */
export class GatewayMetrics {
  readonly #counters = new Map<string, number>();

  increment(name: GatewayMetricName, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const metric = COUNTER_METRIC_NAMES[name];
    this.#counters.set(metric, (this.#counters.get(metric) ?? 0) + amount);
    const outcome =
      name === "mutationAcknowledged"
        ? "acknowledged"
        : name === "mutationRejected"
          ? "rejected"
          : name === "mutationUnknown"
            ? "unknown"
            : undefined;
    if (outcome !== undefined) this.result("mutationOutcome", outcome);
  }

  result(metric: ResultMetric, value: string): void {
    if (!finiteResult(metric, value)) return;
    const name = `${RESULT_METRIC_NAMES[metric]}{result="${value}"}`;
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + 1);
  }

  metricNames(): readonly string[] {
    return [
      ...Object.values(COUNTER_METRIC_NAMES),
      ...Object.values(RESULT_METRIC_NAMES),
    ];
  }

  render(): readonly string[] {
    return [
      ...Object.values(COUNTER_METRIC_NAMES).map(
        (name) => `${name} ${this.#counters.get(name) ?? 0}`,
      ),
      ...Object.entries(RESULT_METRIC_NAMES).flatMap(([metric, name]) =>
        RESULT_VALUES[metric as ResultMetric].map((value) => {
          const labelled = `${name}{result="${value}"}`;
          return `${labelled} ${this.#counters.get(labelled) ?? 0}`;
        }),
      ),
    ];
  }
}

export type GatewayTelemetry = Readonly<{
  metrics: GatewayMetrics;
  startSpan(
    name: string,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): Span;
  observeProviderLatency(milliseconds: number): void;
}>;

export function createGatewayTelemetry(
  metrics: GatewayMetrics,
): GatewayTelemetry {
  return {
    metrics,
    startSpan(name, attributes = {}) {
      const span = trace
        .getTracer("coffee-platform.aroma-gateway")
        .startSpan(name);
      for (const [key, value] of Object.entries(attributes)) {
        if (
          /cookie|password|secret|token|authorization|credential|email|body|pii/i.test(
            key,
          )
        )
          continue;
        if (
          typeof value === "string" &&
          /cookie|password|secret|token|authorization|credential|email|body|pii/i.test(
            value,
          )
        )
          continue;
        span.setAttribute(key, value);
      }
      return span;
    },
    observeProviderLatency(milliseconds) {
      metrics.increment(
        "providerLatencyMs",
        Math.max(0, Math.round(milliseconds)),
      );
    },
  };
}

export function finishGatewaySpan(span: Span, error?: unknown): void {
  if (ENDED_SPANS.has(span)) return;
  ENDED_SPANS.add(span);
  if (error !== undefined) {
    span.recordException(
      error instanceof Error
        ? new Error(error.name)
        : new Error("provider operation failed"),
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}
