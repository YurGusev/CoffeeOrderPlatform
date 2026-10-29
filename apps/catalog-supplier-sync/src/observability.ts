import { AsyncLocalStorage } from "node:async_hooks";
import type { Readable } from "node:stream";
import { context, trace, SpanStatusCode } from "@opentelemetry/api";

type Phase = "generation" | "stream" | "validation" | "copy" | "transaction";
type Outcome = "success" | "failure" | "unknown" | "aborted";
type Identity = Readonly<{
  snapshotRef?: string;
  batchNumber?: number;
  correlationId?: string;
}>;
type Diagnostic = Identity &
  Readonly<{
    event:
      | "catalog_import"
      | "catalog_batch"
      | "catalog_supervisor"
      | "catalog_scheduler";
    outcome: Outcome;
    durationMs?: number;
  }>;
type Measurement = { seconds: number; count: number };
function outcomeOf(error: unknown, signal: AbortSignal): Outcome {
  return signal.aborted
    ? "aborted"
    : error instanceof Error && error.name === "CatalogOutcomeUnknown"
      ? "unknown"
      : "failure";
}

/** Identifiers are allowlisted diagnostics/span attributes, never metric labels. */
export class CatalogTelemetry {
  readonly #diagnostic: (value: Diagnostic) => void;
  readonly #now: () => number;
  readonly #identity = new AsyncLocalStorage<Identity>();
  readonly #outcomes: Record<Outcome, number> = {
    success: 0,
    failure: 0,
    unknown: 0,
    aborted: 0,
  };
  readonly #batchDuration: Measurement = { seconds: 0, count: 0 };
  readonly #backpressure: Record<"stream" | "copy", Measurement> = {
    stream: { seconds: 0, count: 0 },
    copy: { seconds: 0, count: 0 },
  };
  #batches = 0;
  #bytes = 0;
  #durationSeconds = 0;
  #lastSuccessful: number | undefined;
  readonly #observedAt: number;

  public constructor(
    diagnostic: (value: Diagnostic) => void = () => {},
    now: () => number = () => performance.now(),
  ) {
    this.#diagnostic = diagnostic;
    this.#now = now;
    this.#observedAt = now();
  }

  public withIdentity<T>(identity: Identity, work: () => T): T {
    // Project explicitly: neither records, request headers nor errors may be spread into telemetry.
    const fields = { ...this.#identity.getStore() };
    if (identity.snapshotRef !== undefined)
      fields.snapshotRef = identity.snapshotRef;
    if (identity.correlationId !== undefined)
      fields.correlationId = identity.correlationId;
    if (
      identity.batchNumber !== undefined &&
      Number.isSafeInteger(identity.batchNumber) &&
      identity.batchNumber >= 0
    )
      fields.batchNumber = identity.batchNumber;
    return this.#identity.run(fields, work);
  }

  public async observe<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
    const span = trace
      .getTracer("coffee-platform.catalog-supplier-sync")
      .startSpan(`catalog.import.${phase}`, {
        attributes: { ...this.#identity.getStore() },
      });
    try {
      return await context.with(trace.setSpan(context.active(), span), work);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  public validate<T>(work: () => T): T {
    const span = trace
      .getTracer("coffee-platform.catalog-supplier-sync")
      .startSpan("catalog.import.validation", {
        attributes: { ...this.#identity.getStore() },
      });
    try {
      return work();
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  public async generation<T>(
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const started = this.#now();
    let outcome: Outcome = "success";
    try {
      return await this.observe("generation", work);
    } catch (error) {
      outcome = outcomeOf(error, signal);
      throw error;
    } finally {
      const durationMs = Math.max(0, this.#now() - started);
      this.#durationSeconds += durationMs / 1000;
      if (outcome === "success") this.#lastSuccessful = this.#now();
      this.#outcomes[outcome]++;
      this.#diagnostic({
        event: "catalog_import",
        outcome,
        durationMs,
        ...this.#identity.getStore(),
      });
    }
  }

  public async measureBatch<T>(
    batchNumber: number,
    bytes: number,
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return this.withIdentity({ batchNumber }, async () => {
      const started = this.#now();
      let outcome: Outcome = "success";
      try {
        const result = await work();
        this.batch(bytes);
        return result;
      } catch (error) {
        outcome = outcomeOf(error, signal);
        throw error;
      } finally {
        const durationMs = Math.max(0, this.#now() - started);
        this.#batchDuration.seconds += durationMs / 1000;
        this.#batchDuration.count++;
        this.#diagnostic({
          event: "catalog_batch",
          outcome,
          durationMs,
          ...this.#identity.getStore(),
        });
      }
    });
  }

  /** Time a consumer holds each record before requesting the next; excludes upstream wait. */
  public async *consume<T>(records: AsyncIterable<T>): AsyncGenerator<T> {
    for await (const record of records) {
      const started = this.#now();
      try {
        yield record;
      } finally {
        this.#measurePressure("stream", started);
      }
    }
  }

  /** Observe actual source pauses caused by COPY's downstream writable, not total COPY time. */
  public async copy<T>(source: Readable, work: () => Promise<T>): Promise<T> {
    let pausedAt: number | undefined;
    const pause = (): void => {
      if (pausedAt === undefined && !source.readableEnded)
        pausedAt = this.#now();
    };
    const resume = (): void => {
      if (pausedAt === undefined) return;
      this.#measurePressure("copy", pausedAt);
      pausedAt = undefined;
    };
    source.on("pause", pause);
    source.on("resume", resume);
    source.on("end", resume);
    source.on("close", resume);
    try {
      return await this.observe("copy", work);
    } finally {
      resume();
      source.off("pause", pause);
      source.off("resume", resume);
      source.off("end", resume);
      source.off("close", resume);
    }
  }

  #measurePressure(phase: "stream" | "copy", started: number): void {
    this.#backpressure[phase].seconds +=
      Math.max(0, this.#now() - started) / 1000;
    this.#backpressure[phase].count++;
  }

  public scheduledFailure(): void {
    this.#diagnostic({ event: "catalog_scheduler", outcome: "failure" });
  }

  public supervisorFailure(): void {
    this.#diagnostic({ event: "catalog_supervisor", outcome: "failure" });
  }

  /** Accepted stream batches, including exact replay; not a durable row counter. */
  public batch(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    this.#batches++;
    this.#bytes += bytes;
  }

  public render(): readonly string[] {
    return [
      "# TYPE coffee_catalog_import_batches_total counter",
      `coffee_catalog_import_batches_total ${this.#batches}`,
      "# TYPE coffee_catalog_import_batch_bytes_total counter",
      `coffee_catalog_import_batch_bytes_total ${this.#bytes}`,
      "# HELP coffee_catalog_import_batch_duration_seconds Batch persistence and reconciliation duration, including failed attempts.",
      "# TYPE coffee_catalog_import_batch_duration_seconds summary",
      `coffee_catalog_import_batch_duration_seconds_sum ${this.#batchDuration.seconds}`,
      `coffee_catalog_import_batch_duration_seconds_count ${this.#batchDuration.count}`,
      "# HELP coffee_catalog_import_backpressure_seconds Stream consumer hold time (excluding upstream wait), or COPY source pause time.",
      "# TYPE coffee_catalog_import_backpressure_seconds summary",
      ...Object.entries(this.#backpressure).flatMap(([phase, value]) => [
        `coffee_catalog_import_backpressure_seconds_sum{phase="${phase}"} ${value.seconds}`,
        `coffee_catalog_import_backpressure_seconds_count{phase="${phase}"} ${value.count}`,
      ]),
      "# TYPE coffee_catalog_import_duration_seconds summary",
      `coffee_catalog_import_duration_seconds_sum ${this.#durationSeconds}`,
      `coffee_catalog_import_duration_seconds_count ${Object.values(this.#outcomes).reduce((sum, count) => sum + count, 0)}`,
      "# HELP coffee_catalog_import_age_seconds Age since last successful import, or telemetry startup if none succeeded.",
      "# TYPE coffee_catalog_import_age_seconds gauge",
      `coffee_catalog_import_age_seconds ${Math.max(0, this.#now() - (this.#lastSuccessful ?? this.#observedAt)) / 1000}`,
      "# TYPE coffee_catalog_import_has_success gauge",
      `coffee_catalog_import_has_success ${this.#lastSuccessful === undefined ? 0 : 1}`,
      "# TYPE coffee_catalog_import_results_total counter",
      ...Object.entries(this.#outcomes).map(
        ([outcome, count]) =>
          `coffee_catalog_import_results_total{outcome="${outcome}"} ${count}`,
      ),
    ];
  }
}
