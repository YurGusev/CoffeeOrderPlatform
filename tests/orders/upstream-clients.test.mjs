import assert from "node:assert/strict";
import test from "node:test";
import {
  CustomerOrderInputClientError,
  createCustomerOrderInputClient,
} from "../../apps/orders-service/dist/infrastructure/customer-client.js";
import {
  PricingQuoteClientError,
  createPricingQuoteClient,
} from "../../apps/orders-service/dist/infrastructure/pricing-client.js";

const ids = {
  customer: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  quote: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  product: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  variant: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const context = {
  delegation: "signed-delegation",
  correlationId: "123e4567-e89b-12d3-a456-426614174000",
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};
const customerInput = (changes = {}) => ({
  customerRef: ids.customer,
  customerVersion: "1",
  displayName: "Ada",
  state: "Active",
  ...changes,
});
const pricingResponse = (changes = {}) => ({
  valid: true,
  quoteRef: ids.quote,
  policyVersionRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  catalogSnapshotRevision: "1",
  customerRef: ids.customer,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  currency: "RUB",
  line: {
    lineNumber: 2,
    productRef: ids.product,
    variantRef: ids.variant,
    productDisplayName: "Coffee",
    offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    mappingRevision: "1",
    quantity: "2",
    unit: "piece",
    supplierUnitMinor: "100",
    unitMinor: "150",
    lineTotalMinor: "300",
    currency: "RUB",
    internalProofHash: "a".repeat(64),
  },
  ...changes,
});
const problem = (status, code) => ({
  type: "about:blank",
  title: code,
  status,
  code,
  detail: code,
  instance: "/api/internal-v1",
  correlationId: context.correlationId,
  errors: [],
});
const json = (body, status = 200, contentType = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
const captureClient = (responseOrFetch) => {
  const calls = [];
  const client = {
    async fetch(path, options) {
      calls.push({ path, options });
      return typeof responseOrFetch === "function"
        ? responseOrFetch(path, options)
        : responseOrFetch;
    },
  };
  return { client, calls };
};
const getCustomerRequest = (signal = AbortSignal.timeout(5_000)) => ({
  customerRef: ids.customer,
  ...context,
  signal,
});
const getPricingRequest = (signal = AbortSignal.timeout(5_000)) => ({
  quoteRef: ids.quote,
  hash: "a".repeat(64),
  customerRef: ids.customer,
  quoteLineNumber: 2,
  productRef: ids.product,
  variantRef: ids.variant,
  quantity: "2",
  ...context,
  signal,
});

void test("Customer client calls only the internal order-input route with signed context and bounded deadline", async () => {
  const { client, calls } = captureClient(json(customerInput()));
  const result =
    await createCustomerOrderInputClient(client).getOrderInput(
      getCustomerRequest(),
    );
  assert.deepEqual(result, customerInput());
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    `/api/internal-v1/customers/${encodeURIComponent(ids.customer)}/order-input`,
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(
    calls[0].options.headers["x-service-delegation"],
    context.delegation,
  );
  assert.equal(
    calls[0].options.headers["x-correlation-id"],
    context.correlationId,
  );
  assert.equal(calls[0].options.headers.traceparent, context.traceparent);
  assert.equal(calls[0].options.signal.aborted, false);
});

void test("Customer client rejects inactive, identity-mismatched, malformed, and oversized responses", async () => {
  for (const [response, code] of [
    [json(customerInput({ state: "Inactive" })), "CUSTOMER_NOT_ACTIVE"],
    [
      json(customerInput({ customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAY" })),
      "CUSTOMER_UNAVAILABLE",
    ],
    [
      new Response("{", { headers: { "content-type": "application/json" } }),
      "CUSTOMER_UNAVAILABLE",
    ],
    [
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      "CUSTOMER_UNAVAILABLE",
    ],
    [
      new Response("x".repeat(256 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
      "CUSTOMER_UNAVAILABLE",
    ],
  ]) {
    await assert.rejects(
      createCustomerOrderInputClient(
        captureClient(response).client,
      ).getOrderInput(getCustomerRequest()),
      (error) => {
        assert.ok(error instanceof CustomerOrderInputClientError);
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

void test("Customer client maps only a valid not-found problem and treats invalid status payloads as unavailable", async () => {
  await assert.rejects(
    createCustomerOrderInputClient(
      captureClient(
        json(
          problem(404, "CUSTOMER_NOT_FOUND"),
          404,
          "application/problem+json",
        ),
      ).client,
    ).getOrderInput(getCustomerRequest()),
    (error) =>
      error instanceof CustomerOrderInputClientError &&
      error.code === "CUSTOMER_NOT_FOUND",
  );
  await assert.rejects(
    createCustomerOrderInputClient(
      captureClient(
        json(problem(404, "OTHER"), 404, "application/problem+json"),
      ).client,
    ).getOrderInput(getCustomerRequest()),
    (error) =>
      error instanceof CustomerOrderInputClientError &&
      error.code === "CUSTOMER_UNAVAILABLE",
  );
  await assert.rejects(
    createCustomerOrderInputClient(
      captureClient(
        json(
          problem(503, "CUSTOMER_UNAVAILABLE"),
          503,
          "application/problem+json",
        ),
      ).client,
    ).getOrderInput(getCustomerRequest()),
    (error) =>
      error instanceof CustomerOrderInputClientError &&
      error.code === "CUSTOMER_UNAVAILABLE",
  );
  await assert.rejects(
    createCustomerOrderInputClient(
      captureClient(
        json(
          problem(503, "CUSTOMER_NOT_FOUND"),
          503,
          "application/problem+json",
        ),
      ).client,
    ).getOrderInput(getCustomerRequest()),
    (error) =>
      error instanceof CustomerOrderInputClientError &&
      error.code === "CUSTOMER_UNAVAILABLE",
  );
});

void test("Pricing client posts exact quote scope to the internal verify route and validates authoritative response", async () => {
  const expected = pricingResponse();
  const { client, calls } = captureClient(json(expected));
  const result =
    await createPricingQuoteClient(client).verify(getPricingRequest());
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/internal-v1/pricing/quotes:verify");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers["x-service-delegation"],
    context.delegation,
  );
  assert.equal(
    calls[0].options.headers["x-correlation-id"],
    context.correlationId,
  );
  assert.equal(calls[0].options.headers.traceparent, context.traceparent);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    quoteRef: ids.quote,
    hash: "a".repeat(64),
    customerRef: ids.customer,
    quoteLineNumber: 2,
    productRef: ids.product,
    variantRef: ids.variant,
    quantity: "2",
  });
});

void test("Pricing client rejects quote/customer/selected-line/expiry/currency mismatches, malformed, and oversized bodies", async () => {
  for (const body of [
    pricingResponse({ quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    pricingResponse({ customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAY" }),
    pricingResponse({ line: { ...pricingResponse().line, lineNumber: 1 } }),
    pricingResponse({
      line: {
        ...pricingResponse().line,
        productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      },
    }),
    pricingResponse({
      line: {
        ...pricingResponse().line,
        variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAY",
      },
    }),
    pricingResponse({ line: { ...pricingResponse().line, quantity: "3" } }),
    pricingResponse({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    pricingResponse({ currency: "USD" }),
    pricingResponse({ line: { ...pricingResponse().line, currency: "USD" } }),
    { valid: true },
  ]) {
    await assert.rejects(
      createPricingQuoteClient(captureClient(json(body)).client).verify(
        getPricingRequest(),
      ),
      (error) => {
        assert.ok(error instanceof PricingQuoteClientError);
        assert.equal(error.code, "PRICING_UNAVAILABLE");
        return true;
      },
    );
  }
  await assert.rejects(
    createPricingQuoteClient(
      captureClient(
        new Response("x".repeat(256 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
      ).client,
    ).verify(getPricingRequest()),
    (error) =>
      error instanceof PricingQuoteClientError &&
      error.code === "PRICING_UNAVAILABLE",
  );
});

void test("Pricing client maps only contract-valid stale, scope, and unavailable problems", async () => {
  for (const [status, code, expected] of [
    [400, "VALIDATION_FAILED", "PRICING_UNAVAILABLE"],
    [401, "SERVICE_AUTHENTICATION_REQUIRED", "PRICING_UNAVAILABLE"],
    [403, "SERVICE_DELEGATION_INVALID", "PRICING_UNAVAILABLE"],
    [404, "PRICING_QUOTE_NOT_FOUND", "PRICING_STALE"],
    [409, "PRICING_QUOTE_HASH_MISMATCH", "PRICING_STALE"],
    [409, "PRICING_QUOTE_EXPIRED", "PRICING_STALE"],
    [409, "PRICING_QUOTE_SCOPE_MISMATCH", "PRICING_SCOPE_MISMATCH"],
    [503, "PRICING_POLICY_UNAVAILABLE", "PRICING_UNAVAILABLE"],
  ]) {
    const response = json(
      problem(status, code),
      status,
      "application/problem+json",
    );
    await assert.rejects(
      createPricingQuoteClient(captureClient(response).client).verify(
        getPricingRequest(),
      ),
      (error) => {
        assert.ok(error instanceof PricingQuoteClientError);
        assert.equal(error.code, expected);
        return true;
      },
    );
  }
  const mismatch = json(
    problem(409, "PRICING_QUOTE_SCOPE_MISMATCH"),
    503,
    "application/problem+json",
  );
  await assert.rejects(
    createPricingQuoteClient(captureClient(mismatch).client).verify(
      getPricingRequest(),
    ),
    (error) => {
      assert.ok(error instanceof PricingQuoteClientError);
      assert.equal(error.code, "PRICING_UNAVAILABLE");
      return true;
    },
  );
});

void test("both clients enforce a one-second deadline and preserve caller cancellation", async () => {
  for (const [factory, invoke, ErrorType, unavailableCode] of [
    [
      createCustomerOrderInputClient,
      "getOrderInput",
      CustomerOrderInputClientError,
      "CUSTOMER_UNAVAILABLE",
    ],
    [
      createPricingQuoteClient,
      "verify",
      PricingQuoteClientError,
      "PRICING_UNAVAILABLE",
    ],
  ]) {
    let seenSignal;
    const client = {
      fetch: (_path, options) =>
        new Promise((_resolve, reject) => {
          seenSignal = options.signal;
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    };
    await assert.rejects(
      factory(client)[invoke](
        invoke === "getOrderInput" ? getCustomerRequest() : getPricingRequest(),
      ),
      (error) => {
        assert.ok(error instanceof ErrorType);
        assert.equal(error.code, unavailableCode);
        return true;
      },
    );
    assert.equal(seenSignal.aborted, true);

    const caller = new AbortController();
    const pending = factory(client)[invoke](
      invoke === "getOrderInput"
        ? getCustomerRequest(caller.signal)
        : getPricingRequest(caller.signal),
    );
    caller.abort(new Error("caller cancelled"));
    await assert.rejects(
      pending,
      (error) => error.message === "caller cancelled",
    );
  }
});
