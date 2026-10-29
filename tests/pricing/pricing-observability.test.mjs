import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { PricingTelemetry } from "../../apps/pricing-service/src/observability.ts";

const createOutcomes = [
  "created",
  "replayed",
  "conflict",
  "in_progress",
  "error",
];
const catalogOutcomes = ["success", "error"];
const verifyOutcomes = [
  "valid",
  "not_found",
  "hash_mismatch",
  "expired",
  "scope_mismatch",
  "error",
];
const retryOutcomes = ["no_retry", "recovered", "mixed"];
const databaseOutcomes = [
  "committed",
  "replayed",
  "conflict",
  "in_progress",
  "unknown",
  "error",
];

let activeSpans = [];
trace.setGlobalTracerProvider({
  getTracer(name) {
    assert.equal(name, "coffee-platform.pricing-service");
    return {
      startSpan(spanName, options) {
        activeSpans.push({
          name: spanName,
          options,
          status: undefined,
          ended: false,
          setStatus(status) {
            this.status = status;
          },
          end() {
            this.ended = true;
          },
          spanContext() {
            return {
              traceId: "1".repeat(32),
              spanId: "2".repeat(16),
              traceFlags: 1,
            };
          },
        });
        return activeSpans.at(-1);
      },
    };
  },
});

function installTracer(spans) {
  activeSpans = spans;
}

void test("Pricing metrics initialize every fixed outcome and reject dynamic labels", () => {
  const telemetry = new PricingTelemetry();
  const initial = telemetry.render();
  assert.equal(
    initial.length,
    createOutcomes.length +
      catalogOutcomes.length +
      verifyOutcomes.length +
      retryOutcomes.length +
      databaseOutcomes.length +
      5,
  );
  for (const outcome of [
    ...createOutcomes,
    ...catalogOutcomes,
    ...verifyOutcomes,
    ...retryOutcomes,
    ...databaseOutcomes,
  ]) {
    assert.ok(
      initial.some((line) => line.endsWith(`{outcome="${outcome}"} 0`)),
    );
  }
  assert.ok(initial.includes("coffee_pricing_operation_duration_ms_total 0"));
  assert.ok(initial.includes("coffee_pricing_operation_duration_ms_count 0"));
  for (const bucket of ["1", "2-8", "9-100"])
    assert.ok(
      initial.includes(
        `coffee_pricing_quote_line_count_total{bucket="${bucket}"} 0`,
      ),
    );

  const userId = "user-identifier-canary-71b9";
  const privateCanary = "supplier-price-private-canary-93a4";
  telemetry.createOutcome("created");
  telemetry.catalogReadOutcome("success");
  telemetry.verifyOutcome("valid");
  telemetry.catalogRetryOutcome("recovered");
  telemetry.databaseOutcome("committed");
  telemetry.observeDuration(12.5);
  telemetry.observeDuration(-1);
  telemetry.observeDuration(Number.NaN);
  telemetry.quoteLineCount(1);
  telemetry.quoteLineCount(8);
  telemetry.quoteLineCount(100);
  telemetry.quoteLineCount(0);
  telemetry.quoteLineCount(101);
  telemetry.createOutcome(userId);
  telemetry.catalogReadOutcome(privateCanary);
  telemetry.verifyOutcome(`${userId}:${privateCanary}`);
  telemetry.catalogRetryOutcome(userId);
  telemetry.databaseOutcome(privateCanary);

  const rendered = telemetry.render().join("\n");
  assert.match(
    rendered,
    /coffee_pricing_quote_create_results_total\{outcome="created"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_catalog_read_results_total\{outcome="success"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_quote_verify_results_total\{outcome="valid"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_catalog_retry_results_total\{outcome="recovered"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_database_results_total\{outcome="committed"\} 1/u,
  );
  assert.match(rendered, /coffee_pricing_operation_duration_ms_total 12\.5/u);
  assert.match(rendered, /coffee_pricing_operation_duration_ms_count 1/u);
  assert.match(
    rendered,
    /coffee_pricing_quote_line_count_total\{bucket="1"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_quote_line_count_total\{bucket="2-8"\} 1/u,
  );
  assert.match(
    rendered,
    /coffee_pricing_quote_line_count_total\{bucket="9-100"\} 1/u,
  );
  assert.doesNotMatch(
    rendered,
    /user-identifier-canary-71b9|supplier-price-private-canary-93a4/u,
  );
  assert.equal(telemetry.render().length, initial.length);
});

void test("observe uses only fixed span names and ends successful spans without attributes", async () => {
  const spans = [];
  installTracer(spans);
  const telemetry = new PricingTelemetry();
  const expected = [
    "pricing.idempotency.precheck",
    "pricing.policy.lookup",
    "pricing.catalog.pricing_input",
    "pricing.quote.persist",
    "pricing.quote.verify",
    "pricing.quote.create",
    "pricing.quote.calculate",
  ];
  for (const name of expected) {
    assert.equal(await telemetry.observe(name, async () => "ok"), "ok");
  }
  assert.deepEqual(
    spans.map((span) => span.name),
    expected,
  );
  assert.ok(spans.every((span) => span.ended && span.options === undefined));
  await assert.rejects(
    telemetry.observe(
      "pricing.quote.verify:user-identifier-canary-71b9",
      async () => "never",
    ),
    TypeError,
  );
  assert.equal(spans.length, expected.length);
});

void test("observe ends a failed span, marks error without recording the raw error, and rethrows", async () => {
  const spans = [];
  installTracer(spans);
  const telemetry = new PricingTelemetry();
  const privateCanary = "private-error-message-canary-456c";
  const failure = new Error(privateCanary);

  await assert.rejects(
    telemetry.observe("pricing.quote.persist", async () => {
      throw failure;
    }),
    (error) => error === failure,
  );

  assert.equal(spans.length, 1);
  assert.equal(spans[0].ended, true);
  assert.deepEqual(spans[0].status, { code: 2 });
  assert.equal("recordException" in spans[0], false);
  assert.equal(JSON.stringify(spans[0]).includes(privateCanary), false);
});

void test("synchronous calculation span ends on success and on error without raw facts", () => {
  const spans = [];
  installTracer(spans);
  const telemetry = new PricingTelemetry();
  assert.equal(
    telemetry.observeSync("pricing.quote.calculate", () => 130n),
    130n,
  );
  const failure = new Error("supplier-price-private-canary");
  assert.throws(
    () =>
      telemetry.observeSync("pricing.quote.calculate", () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(
    spans.map((span) => span.name),
    ["pricing.quote.calculate", "pricing.quote.calculate"],
  );
  assert.equal(
    spans.every((span) => span.ended),
    true,
  );
  assert.deepEqual(spans[1].status, { code: 2 });
  assert.equal(
    JSON.stringify(spans).includes("supplier-price-private-canary"),
    false,
  );
});
