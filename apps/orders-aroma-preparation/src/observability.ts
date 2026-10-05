import {context, trace, SpanStatusCode} from "@opentelemetry/api";
import {nowInstant, toInstant} from "@coffee-platform/platform-time";

const SPANS = ["orders.aroma_preparation.inbox", "orders.aroma_preparation.recompute", "orders.aroma_preparation.projection", "orders.aroma_preparation.recovery"] as const;
const SERIES = {
  inbox: ["catalog_changed", "order_confirmed", "reconciliation_requested", "other", "error"],
  recompute: ["changed", "unchanged", "error"],
  projection: ["changed", "unchanged", "error"],
  recovery: ["completed", "idle", "error"],
} as const;
type Series = keyof typeof SERIES;
type SpanName = (typeof SPANS)[number];
function ageMs(timestamp?: string): number {
  if (timestamp === undefined) return 0;
  try {
    const normalized = timestamp.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    return Math.max(0, nowInstant().epochMilliseconds - toInstant(normalized).epochMilliseconds);
  } catch {return 0;}
}

/** Orders-owned bounded spans and /metrics values; no business identifiers enter telemetry. */
export class AromaPreparationTelemetry {
  readonly #tracer = trace.getTracer("coffee-platform.orders-aroma-preparation");
  readonly #counters = new Map<string, number>();
  #desiredRevision = "0";
  #desiredCreatedAt: string | undefined;

  async observe<T>(name: SpanName, work: () => Promise<T>): Promise<T> {
    if (!(SPANS as readonly string[]).includes(name)) throw new TypeError("Unsupported preparation span");
    const span = this.#tracer.startSpan(name);
    try {return await context.with(trace.setSpan(context.active(), span), work);}
    catch (error) {span.setStatus({code: SpanStatusCode.ERROR}); throw error;}
    finally {span.end();}
  }

  result(series: Series, value: string): void {
    if (!(SERIES[series] as readonly string[]).includes(value)) return;
    const key = `coffee_aroma_preparation_${series}_results_total{result="${value}"}`;
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
  }

  desired(revision: string, createdAt: string): void {
    this.#desiredRevision = revision;
    this.#desiredCreatedAt = createdAt;
  }

  render(): readonly string[] {
    return [
      ...Object.entries(SERIES).flatMap(([series, values]) => values.map(result => {
        const name = `coffee_aroma_preparation_${series}_results_total{result="${result}"}`;
        return `${name} ${this.#counters.get(name) ?? 0}`;
      })),
      `coffee_aroma_preparation_desired_revision ${this.#desiredRevision}`,
      `coffee_aroma_preparation_desired_age_ms ${ageMs(this.#desiredCreatedAt)}`,
    ];
  }
}
