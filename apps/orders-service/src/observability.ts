import { context, metrics, trace, SpanStatusCode } from "@opentelemetry/api";

/** Local Orders instrumentation only; installing a context manager/provider/exporter is the runtime's responsibility. */
export const ORDERS_SPAN_NAMES = [
  "orders.http.create",
  "orders.http.get",
  "orders.http.put",
  "orders.http.remove",
  "orders.http.confirm",
  "orders.http.reconcile",
  "orders.use_case.create",
  "orders.use_case.put",
  "orders.use_case.remove",
  "orders.use_case.confirm",
  "orders.use_case.get",
  "orders.use_case.reconcile",
  "orders.customer.order_input",
  "orders.pricing.verify",
  "orders.transaction.create",
  "orders.transaction.put",
  "orders.transaction.remove",
  "orders.transaction.confirm",
  "orders.transaction.reconcile",
  "orders.transaction.get",
  "orders.transaction.precheck",
  "orders.transaction.replay",
  "orders.outbox.insert",
] as const;
export type OrdersSpanName = (typeof ORDERS_SPAN_NAMES)[number];
const tracer = trace.getTracer("coffee-platform.orders-service");
let instruments:
  | Readonly<{
      provider: ReturnType<typeof metrics.getMeterProvider>;
      total: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      duration: ReturnType<
        ReturnType<typeof metrics.getMeter>["createHistogram"]
      >;
    }>
  | undefined;
const STATES = new Set([
  "NotRequested",
  "PendingObservation",
  "OutOfSync",
  "Blocked",
  "UnknownOutcome",
  "Converging",
  "InSync",
]);

function stateOf(value: unknown): string {
  if (value === null || typeof value !== "object") return "unknown";
  const body = "body" in value ? value.body : value;
  if (body === null || typeof body !== "object" || !("aroma" in body))
    return "unknown";
  const aroma = body.aroma;
  return aroma !== null &&
    typeof aroma === "object" &&
    "state" in aroma &&
    typeof aroma.state === "string" &&
    STATES.has(aroma.state)
    ? aroma.state
    : "unknown";
}

function returnedRejection(name: OrdersSpanName, value: unknown): boolean {
  if (!(
    name.startsWith("orders.use_case.") ||
    name === "orders.transaction.precheck" ||
    name === "orders.transaction.replay"
  ))
    return false;
  if (
    value === null ||
    typeof value !== "object" ||
    !("kind" in value) ||
    typeof value.kind !== "string"
  )
    return false;
  if (value.kind === "proceed") return false;
  if (value.kind === "completed") {
    const response = "response" in value ? value.response : undefined;
    return (
      response !== null &&
      typeof response === "object" &&
      "status" in response &&
      typeof response.status === "number" &&
      response.status >= 400
    );
  }
  return true;
}

/** Never add request data, SQL, error messages or exception events to these spans. */
export async function observe<T>(
  name: OrdersSpanName,
  work: () => Promise<T>,
  signal?: AbortSignal,
  failed?: (result: T) => boolean,
): Promise<T> {
  if (!(ORDERS_SPAN_NAMES as readonly string[]).includes(name))
    throw new TypeError("Unsupported Orders span name");
  const span = tracer.startSpan(name);
  const started = performance.now();
  let outcome: "success" | "error" | "aborted" = "error";
  let state = "unknown";
  try {
    const result = await context.with(
      trace.setSpan(context.active(), span),
      work,
    );
    outcome = signal?.aborted
      ? "aborted"
      : (failed?.(result) ?? returnedRejection(name, result))
        ? "error"
        : "success";
    state = stateOf(result);
    span.setAttribute("orders.outcome", outcome);
    if (outcome !== "success") span.setStatus({ code: SpanStatusCode.ERROR });
    return result;
  } catch (error) {
    outcome = signal?.aborted ? "aborted" : "error";
    span.setAttribute("orders.outcome", outcome);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
    const attributes = {
      "orders.operation": name,
      "orders.result": outcome,
      "orders.state": state,
    };
    try {
      const provider = metrics.getMeterProvider();
      if (instruments?.provider !== provider) {
        const meter = provider.getMeter("coffee-platform.orders-service");
        instruments = {
          provider,
          total: meter.createCounter("orders.operation.total"),
          duration: meter.createHistogram("orders.operation.duration_ms", {
            unit: "ms",
          }),
        };
      }
      instruments.total.add(1, attributes);
      instruments.duration.record(performance.now() - started, attributes);
    } catch {
      /* telemetry must not change the command result */
    }
  }
}
