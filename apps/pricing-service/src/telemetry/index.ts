import { context, trace, SpanStatusCode } from "@opentelemetry/api";

export const PRICING_SPAN_NAMES = [
  "pricing.idempotency.precheck",
  "pricing.policy.lookup",
  "pricing.catalog.pricing_input",
  "pricing.quote.persist",
  "pricing.quote.verify",
  "pricing.quote.create",
  "pricing.quote.calculate",
] as const;

export type PricingSpanName = (typeof PRICING_SPAN_NAMES)[number];
export type PricingCreateOutcome =
  "created" | "replayed" | "conflict" | "in_progress" | "error";
export type PricingCatalogReadOutcome = "success" | "error";
export type PricingVerifyOutcome =
  | "valid"
  | "not_found"
  | "hash_mismatch"
  | "expired"
  | "scope_mismatch"
  | "error";
export type PricingCatalogRetryOutcome = "no_retry" | "recovered" | "mixed";
export type PricingDatabaseOutcome =
  "committed" | "replayed" | "conflict" | "in_progress" | "unknown" | "error";

const OUTCOMES = {
  create: ["created", "replayed", "conflict", "in_progress", "error"],
  catalogRead: ["success", "error"],
  verify: [
    "valid",
    "not_found",
    "hash_mismatch",
    "expired",
    "scope_mismatch",
    "error",
  ],
  catalogRetry: ["no_retry", "recovered", "mixed"],
  database: [
    "committed",
    "replayed",
    "conflict",
    "in_progress",
    "unknown",
    "error",
  ],
} as const;

const METRIC_NAMES = {
  create: "coffee_pricing_quote_create_results_total",
  catalogRead: "coffee_pricing_catalog_read_results_total",
  verify: "coffee_pricing_quote_verify_results_total",
  catalogRetry: "coffee_pricing_catalog_retry_results_total",
  database: "coffee_pricing_database_results_total",
} as const;

const DURATION_TOTAL = "coffee_pricing_operation_duration_ms_total";
const DURATION_COUNT = "coffee_pricing_operation_duration_ms_count";
const LINE_COUNT_BUCKETS = ["1", "2-8", "9-100"] as const;
const LINE_COUNT_METRIC = "coffee_pricing_quote_line_count_total";

/** Bounded Pricing spans and counters; labels and span names are fixed enums only. */
export class PricingTelemetry {
  readonly #counters = new Map<string, number>();
  readonly #tracer = trace.getTracer("coffee-platform.pricing-service");

  public async observe<T>(
    name: PricingSpanName,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!(PRICING_SPAN_NAMES as readonly string[]).includes(name)) {
      throw new TypeError("Unsupported Pricing span name");
    }

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

  public observeSync<T>(name: PricingSpanName, work: () => T): T {
    if (!(PRICING_SPAN_NAMES as readonly string[]).includes(name)) {
      throw new TypeError("Unsupported Pricing span name");
    }
    const span = this.#tracer.startSpan(name);
    try {
      return context.with(trace.setSpan(context.active(), span), work);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  public createOutcome(outcome: PricingCreateOutcome): void {
    this.#increment("create", outcome);
  }

  public catalogReadOutcome(outcome: PricingCatalogReadOutcome): void {
    this.#increment("catalogRead", outcome);
  }

  public verifyOutcome(outcome: PricingVerifyOutcome): void {
    this.#increment("verify", outcome);
  }

  public catalogRetryOutcome(outcome: PricingCatalogRetryOutcome): void {
    this.#increment("catalogRetry", outcome);
  }

  public databaseOutcome(outcome: PricingDatabaseOutcome): void {
    this.#increment("database", outcome);
  }

  public observeDuration(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.#counters.set(
      DURATION_TOTAL,
      (this.#counters.get(DURATION_TOTAL) ?? 0) + milliseconds,
    );
    this.#counters.set(
      DURATION_COUNT,
      (this.#counters.get(DURATION_COUNT) ?? 0) + 1,
    );
  }

  public quoteLineCount(count: number): void {
    if (!Number.isInteger(count) || count < 1 || count > 100) return;
    const bucket = count === 1 ? "1" : count <= 8 ? "2-8" : "9-100";
    const key = `${LINE_COUNT_METRIC}{bucket="${bucket}"}`;
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
  }

  public render(): readonly string[] {
    const outcomes = (
      Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[]
    ).flatMap((kind) => {
      const metric = METRIC_NAMES[kind];
      return OUTCOMES[kind].map((outcome) => {
        const labelled = `${metric}{outcome="${outcome}"}`;
        return `${labelled} ${this.#counters.get(labelled) ?? 0}`;
      });
    });
    return [
      ...outcomes,
      `${DURATION_TOTAL} ${this.#counters.get(DURATION_TOTAL) ?? 0}`,
      `${DURATION_COUNT} ${this.#counters.get(DURATION_COUNT) ?? 0}`,
      ...LINE_COUNT_BUCKETS.map((bucket) => {
        const labelled = `${LINE_COUNT_METRIC}{bucket="${bucket}"}`;
        return `${labelled} ${this.#counters.get(labelled) ?? 0}`;
      }),
    ];
  }

  #increment<K extends keyof typeof OUTCOMES>(kind: K, outcome: string): void {
    if (!(OUTCOMES[kind] as readonly string[]).includes(outcome)) return;
    const key = `${METRIC_NAMES[kind]}{outcome="${outcome}"}`;
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + 1);
  }
}
