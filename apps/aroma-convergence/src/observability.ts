import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { nowInstant, toInstant } from "@coffee-platform/platform-time";

const SPANS = [
  "aroma.convergence.inbox",
  "aroma.convergence.attempt",
  "aroma.convergence.lease",
  "aroma.convergence.fence",
  "aroma.convergence.reservation",
  "aroma.convergence.provider.read",
  "aroma.convergence.provider.catalog_proof",
  "aroma.convergence.provider.mutation",
  "aroma.convergence.provider.verification",
  "aroma.convergence.recovery",
] as const;
const ATTEMPTS = [
  "no_op_in_sync",
  "verified_in_sync",
  "out_of_sync",
  "blocked",
  "unknown_outcome",
  "failed",
] as const;
const RECOVERY = [
  "completed",
  "failed",
  "unknown_outcome",
  "recovered_applied",
  "recovered_not_applied",
  "external_change",
] as const;
const MUTATIONS = ["set_quantity", "remove"] as const;
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

/** Orders-owned bounded spans and counters; values are fixed names and enums only. */
export class AromaConvergenceTelemetry {
  readonly #tracer = trace.getTracer("coffee-platform.aroma-convergence");
  readonly #attempts = new Map<string, number>();
  readonly #recoveries = new Map<string, number>();
  readonly #mutations = new Map<string, number>();
  #observedCapturedAt: string | undefined;
  #leaseFailures = 0;
  #fenceFailures = 0;
  #unknown = 0;
  #unresolvedUnknown: number | undefined;
  #blockers = 0;
  #providerFailures = 0;
  #degraded = false;

  async observe<T>(name: SpanName, work: () => Promise<T>): Promise<T> {
    if (!(SPANS as readonly string[]).includes(name))
      throw new TypeError("Unsupported convergence span");
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

  observed(capturedAt: string): void {
    this.#observedCapturedAt = capturedAt;
  }
  leaseFailure(): void {
    this.#leaseFailures += 1;
  }
  fenceFailure(): void {
    this.#fenceFailures += 1;
  }
  heartbeatFailure(): void {
    this.#fenceFailures += 1;
    this.#degraded = true;
  }
  providerFailure(): void {
    this.#providerFailures += 1;
    this.#degraded = true;
  }
  providerSuccess(): void {
    this.#degraded = false;
  }
  get ready(): boolean {
    return !this.#degraded;
  }
  blocker(count: number): void {
    this.#blockers += count;
  }
  attempt(value: string): void {
    this.#increment(this.#attempts, ATTEMPTS, value);
    if (value === "unknown_outcome") this.#unknown += 1;
  }
  recovery(value: string): void {
    this.#increment(this.#recoveries, RECOVERY, value);
  }
  unresolvedUnknown(value: number | undefined): void {
    this.#unresolvedUnknown =
      value !== undefined && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
  }
  mutation(value: string): void {
    this.#increment(this.#mutations, MUTATIONS, value);
  }

  render(): readonly string[] {
    return [
      ...this.#series(
        "coffee_aroma_attempt_results_total",
        this.#attempts,
        ATTEMPTS,
      ),
      ...this.#series(
        "coffee_aroma_recovery_results_total",
        this.#recoveries,
        RECOVERY,
      ),
      ...MUTATIONS.map(
        (action) =>
          `coffee_aroma_mutation_calls_total{action="${action}"} ${this.#mutations.get(action) ?? 0}`,
      ),
      `coffee_aroma_lease_failures_total ${this.#leaseFailures}`,
      `coffee_aroma_fence_failures_total ${this.#fenceFailures}`,
      `coffee_aroma_unknown_outcomes_total ${this.#unknown}`,
      ...(this.#unresolvedUnknown === undefined
        ? []
        : [`coffee_aroma_unknown_outcomes_current ${this.#unresolvedUnknown}`]),
      `coffee_aroma_blockers_total ${this.#blockers}`,
      `coffee_aroma_provider_failures_total ${this.#providerFailures}`,
      `coffee_aroma_observed_age_ms ${ageMs(this.#observedCapturedAt)}`,
    ];
  }

  #increment<T extends readonly string[]>(
    values: Map<string, number>,
    allowed: T,
    value: string,
  ): void {
    if (!(allowed as readonly string[]).includes(value)) return;
    values.set(value, (values.get(value) ?? 0) + 1);
  }
  #series<T extends readonly string[]>(
    name: string,
    values: Map<string, number>,
    allowed: T,
  ): string[] {
    return allowed.map(
      (value) => `${name}{result="${value}"} ${values.get(value) ?? 0}`,
    );
  }
}
