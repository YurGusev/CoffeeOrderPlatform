import assert from "node:assert/strict";
import test from "node:test";
import { trace } from "@opentelemetry/api";
import { createPricingAdapters } from "../../apps/pricing-service/dist/http/index.js";
import { PricingStore } from "../../apps/pricing-service/dist/infrastructure/database/pricing-store.js";
import { PricingTelemetry } from "../../apps/pricing-service/dist/observability.js";

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

void test("Pricing adapters preserve owner and Catalog outcomes in telemetry", async (t) => {
  const policy = {
    policyVersionRef: `pvr_${"0".repeat(26)}`,
    version: "1",
    currency: "RUB",
    markupBasisPoints: 3000,
    minimumMarginMinor: "0",
    quoteTtlSeconds: 900,
    quantityScale: 3,
    roundingMode: "CEILING",
  };
  const quote = { status: 201, body: { lines: [{}] }, replayed: false };
  const verified = { valid: true };
  const catalogFact = {
    productRef: `prd_${"0".repeat(26)}`,
    variantRef: `var_${"0".repeat(26)}`,
    offerRef: `off_${"0".repeat(26)}`,
    snapshotRevision: "1",
    supplierUnitMinor: "100",
    currency: "RUB",
    unit: "piece",
    availability: "Available",
    mappingRevision: "1",
    displayName: "Coffee",
  };
  const request = {
    customerRef: `cus_${"0".repeat(26)}`,
    lines: [
      {
        productRef: catalogFact.productRef,
        variantRef: catalogFact.variantRef,
        quantity: "2.500",
      },
    ],
  };
  const identity = {
    actorRef: "operator-1",
    scope: "a".repeat(64),
    key: "00000000-0000-4000-8000-000000000001",
  };
  const context = {
    correlationId: "00000000-0000-4000-8000-000000000002",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    signal: new AbortController().signal,
  };
  let precheckResult = { kind: "not_retained" };
  let precheckError;
  let createResult = quote;
  let createError;
  let catalogError;
  let verifyResult = verified;
  let verifyError;
  const calls = { create: [], catalog: [], sign: [], verify: [] };
  t.mock.method(PricingStore.prototype, "precheck", async () => {
    if (precheckError) throw precheckError;
    return precheckResult;
  });
  t.mock.method(PricingStore.prototype, "readActivePolicy", async () => policy);
  t.mock.method(PricingStore.prototype, "create", async (input) => {
    calls.create.push(input);
    if (createError) throw createError;
    return createResult;
  });
  t.mock.method(PricingStore.prototype, "verify", async (input) => {
    calls.verify.push(input);
    if (verifyError) throw verifyError;
    return verifyResult;
  });

  const telemetry = new PricingTelemetry();
  const adapters = createPricingAdapters(
    {},
    {
      signCatalogDelegation: (received) => {
        calls.sign.push(received);
        return "signed-catalog-delegation";
      },
    },
    {
      async getPricingInput(input) {
        calls.catalog.push(input);
        if (catalogError) throw catalogError;
        return catalogFact;
      },
    },
    telemetry,
  );
  assert.equal(
    await adapters.owner.create({ request, identity, context }),
    quote,
  );
  assert.equal(calls.create[0].lines[0].quantity, "2.5");
  assert.equal(calls.catalog[0].delegation, "signed-catalog-delegation");
  assert.equal(calls.catalog[0].traceparent, context.traceparent);
  assert.equal(calls.catalog[0].signal.aborted, false);
  assert.equal(calls.sign[0].correlationId, context.correlationId);

  precheckResult = { kind: "completed", ...quote, replayed: true };
  assert.deepEqual(
    await adapters.owner.create({ request, identity, context }),
    {
      status: 201,
      body: quote.body,
      replayed: true,
    },
  );
  for (const [kind, code] of [
    ["conflict", "IDEMPOTENCY_CONFLICT"],
    ["in_progress", "IDEMPOTENCY_REQUEST_IN_PROGRESS"],
  ]) {
    precheckResult = { kind };
    await assert.rejects(
      adapters.owner.create({ request, identity, context }),
      {
        code,
      },
    );
  }
  precheckResult = { kind: "not_retained" };

  catalogError = { code: "CATALOG_UNAVAILABLE" };
  await assert.rejects(adapters.owner.create({ request, identity, context }), {
    code: "CATALOG_UNAVAILABLE",
  });
  catalogError = undefined;
  createResult = { ...quote, replayed: true };
  await adapters.owner.create({ request, identity, context });
  createResult = quote;
  createError = { code: "DB_QUERY_FAILED" };
  await assert.rejects(adapters.owner.create({ request, identity, context }), {
    code: "DB_QUERY_FAILED",
  });
  createError = { code: "TRANSACTION_OUTCOME_UNKNOWN" };
  await assert.rejects(adapters.owner.create({ request, identity, context }), {
    code: "TRANSACTION_OUTCOME_UNKNOWN",
  });
  createError = undefined;
  createError = new Error("private database detail");
  await assert.rejects(adapters.owner.create({ request, identity, context }), {
    message: "private database detail",
  });
  createError = undefined;
  const contextWithoutTraceparent = {
    correlationId: context.correlationId,
    signal: context.signal,
  };
  assert.equal(
    await adapters.owner.create({
      request,
      identity,
      context: contextWithoutTraceparent,
    }),
    quote,
  );

  precheckResult = { kind: "completed", ...quote, replayed: true };
  assert.equal(
    (await adapters.owner.replay(identity, context.signal)).kind,
    "completed",
  );
  for (const kind of ["in_progress", "conflict", "not_retained"]) {
    precheckResult = { kind };
    assert.equal(
      (await adapters.owner.replay(identity, context.signal)).kind,
      kind,
    );
  }
  precheckError = { code: "DB_QUERY_FAILED" };
  await assert.rejects(adapters.owner.replay(identity, context.signal), {
    code: "DB_QUERY_FAILED",
  });
  precheckError = undefined;

  assert.equal(await adapters.owner.verify({}, context), verified);
  for (const code of [
    "PRICING_QUOTE_NOT_FOUND",
    "PRICING_QUOTE_HASH_MISMATCH",
    "PRICING_QUOTE_EXPIRED",
    "PRICING_QUOTE_SCOPE_MISMATCH",
    "DB_QUERY_FAILED",
  ]) {
    verifyError = { code };
    await assert.rejects(adapters.owner.verify({}, context), { code });
  }
  verifyError = new Error("private verification detail");
  await assert.rejects(adapters.owner.verify({}, context), {
    message: "private verification detail",
  });
  verifyError = undefined;
  verifyResult = undefined;

  const rendered = telemetry.render().join("\n");
  for (const [metric, outcome, count] of [
    ["coffee_pricing_quote_create_results_total", "created", 2],
    ["coffee_pricing_quote_create_results_total", "replayed", 3],
    ["coffee_pricing_quote_create_results_total", "conflict", 2],
    ["coffee_pricing_quote_create_results_total", "in_progress", 2],
    ["coffee_pricing_quote_create_results_total", "error", 5],
    ["coffee_pricing_catalog_read_results_total", "success", 6],
    ["coffee_pricing_catalog_read_results_total", "error", 1],
    ["coffee_pricing_catalog_retry_results_total", "no_retry", 6],
    ["coffee_pricing_database_results_total", "committed", 2],
    ["coffee_pricing_database_results_total", "replayed", 3],
    ["coffee_pricing_database_results_total", "error", 1],
    ["coffee_pricing_database_results_total", "unknown", 1],
    ["coffee_pricing_quote_verify_results_total", "valid", 1],
    ["coffee_pricing_quote_verify_results_total", "not_found", 1],
    ["coffee_pricing_quote_verify_results_total", "hash_mismatch", 1],
    ["coffee_pricing_quote_verify_results_total", "expired", 1],
    ["coffee_pricing_quote_verify_results_total", "scope_mismatch", 1],
    ["coffee_pricing_quote_verify_results_total", "error", 2],
  ]) {
    assert.match(
      rendered,
      new RegExp(`${metric}\\{outcome="${outcome}"\\} ${count}(?:\\n|$)`, "u"),
    );
  }
});

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
