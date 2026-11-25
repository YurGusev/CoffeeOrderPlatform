import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { nowInstant, toInstant } from "@coffee-platform/platform-time";

const SPANS = [
  "aroma.observer.recovery",
  "aroma.observer.observation",
  "aroma.observer.lease",
  "aroma.observer.provider.read",
  "aroma.observer.persist",
] as const;
const RESULTS = ["idle", "observed", "failed"] as const;
const RECOVERY = ["ready", "error"] as const;
type SpanName = (typeof SPANS)[number];
function ageMs(timestamp?: string): number {
  if (timestamp === undefined) return 0;
  try {
    const normalized = timestamp
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00");
    return Math.max(
      0,
      nowInstant().epochMilliseconds - toInstant(normalized).epochMilliseconds,
    );
  } catch {
    return 0;
  }
}

/** Bounded observer spans and metrics. The only result dimension is a fixed enum. */
export class AromaObserverTelemetry {
  readonly #tracer = trace.getTracer("coffee-platform.aroma-observer");
  readonly #results = new Map<string, number>();
  readonly #recoveries = new Map<string, number>();
  #observedCapturedAt: string | undefined;
  #fenceFailures = 0;

  async observe<T>(name: SpanName, work: () => Promise<T>): Promise<T> {
    if (!(SPANS as readonly string[]).includes(name))
      throw new TypeError("Unsupported observer span");
    const span = this.#tracer.startSpan(name);
    try {
      return await context.with(trace.setSpan(context.active(), span), work);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  result(value: string): void {
    if (!(RESULTS as readonly string[]).includes(value)) return;
    const key = `coffee_aroma_observation_results_total{result="${value}"}`;
    this.#results.set(key, (this.#results.get(key) ?? 0) + 1);
  }
  recovery(value: string): void {
    if (!(RECOVERY as readonly string[]).includes(value)) return;
    const key = `coffee_aroma_observation_recovery_results_total{result="${value}"}`;
    this.#recoveries.set(key, (this.#recoveries.get(key) ?? 0) + 1);
  }

  observed(capturedAt: string): void {
    this.#observedCapturedAt = capturedAt;
  }
  fenceFailure(): void {
    this.#fenceFailures += 1;
  }

  render(): readonly string[] {
    return [
      ...RESULTS.map((result) => {
        const name = `coffee_aroma_observation_results_total{result="${result}"}`;
        return `${name} ${this.#results.get(name) ?? 0}`;
      }),
      ...RECOVERY.map((result) => {
        const name = `coffee_aroma_observation_recovery_results_total{result="${result}"}`;
        return `${name} ${this.#recoveries.get(name) ?? 0}`;
      }),
      `coffee_aroma_observation_fence_failures_total ${this.#fenceFailures}`,
      `coffee_aroma_observed_age_ms ${ageMs(this.#observedCapturedAt)}`,
    ];
  }
}
