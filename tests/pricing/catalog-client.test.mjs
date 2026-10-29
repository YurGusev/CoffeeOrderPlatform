import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CatalogPricingError,
  createCatalogPricingClient,
} from "../../apps/pricing-service/dist/infrastructure/catalog-client.js";

const productRef = `prd_${"0".repeat(26)}`;
const variantRef = `var_${"0".repeat(26)}`;
const request = {
  productRef,
  variantRef,
  delegation: "signed",
  correlationId: "00000000-0000-4000-8000-000000000001",
  signal: new AbortController().signal,
};
const valid = {
  productRef,
  variantRef,
  offerRef: `off_${"0".repeat(26)}`,
  snapshotRevision: "12",
  supplierUnitMinor: "100",
  currency: "RUB",
  unit: "piece",
  availability: "Available",
  mappingRevision: "2",
  displayName: "Coffee",
};

function client(status, body, onFetch) {
  return createCatalogPricingClient({
    fetch: async (path, options) => {
      onFetch?.(path, options);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

void test("Pricing calls only the allowlisted internal pricing-input path with signed delegation", async () => {
  const calls = [];
  const result = await client(200, valid, (path, options) =>
    calls.push({ path, options }),
  ).getPricingInput(request);
  assert.deepEqual(result, valid);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
  );
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["x-service-delegation"], "signed");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

void test("Pricing rejects missing and unavailable Catalog facts without leaking owner data", async () => {
  for (const [status, body, code] of [
    [404, { detail: "private" }, "CATALOG_PRODUCT_NOT_FOUND"],
    [503, { detail: "private" }, "CATALOG_UNAVAILABLE"],
    [200, { ...valid, availability: "Stopped" }, "CATALOG_PRODUCT_UNAVAILABLE"],
    [200, { ...valid, supplierUnitMinor: "-1" }, "CATALOG_UNAVAILABLE"],
    [
      200,
      { ...valid, productRef: `prd_${"1".repeat(26)}` },
      "CATALOG_UNAVAILABLE",
    ],
    [200, { ...valid, currency: "USD" }, "CATALOG_UNAVAILABLE"],
  ]) {
    await assert.rejects(
      () => client(status, body).getPricingInput(request),
      (error) => {
        assert.ok(error instanceof CatalogPricingError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes("private"), false);
        return true;
      },
    );
  }
});

void test("Pricing fails closed on invalid response body and never fetches after cancellation", async () => {
  await assert.rejects(
    () => client(200, { supplierUnitMinor: "100" }).getPricingInput(request),
    { code: "CATALOG_UNAVAILABLE" },
  );
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(() =>
    client(200, valid, () => {
      called = true;
    }).getPricingInput({ ...request, signal: controller.signal }),
  );
  assert.equal(called, false);
});

void test("Pricing abort closes an in-flight Catalog HTTP response body", async (t) => {
  let disconnected;
  const closed = new Promise((resolve) => {
    disconnected = resolve;
  });
  const server = createServer((_request, response) => {
    response.on("close", disconnected);
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let responseReady;
  const ready = new Promise((resolve) => {
    responseReady = resolve;
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const owner = createCatalogPricingClient({
    fetch: async (path, options) => {
      const response = await fetch(
        `http://127.0.0.1:${address.port}${path}`,
        options,
      );
      responseReady();
      return response;
    },
  });
  const controller = new AbortController();
  const pending = owner.getPricingInput({
    ...request,
    signal: controller.signal,
  });
  await ready;
  controller.abort();
  await assert.rejects(pending, { code: "CATALOG_UNAVAILABLE" });
  await Promise.race([
    closed,
    delay(1_500).then(() => {
      throw new Error("Catalog body connection did not close");
    }),
  ]);
});

void test("Pricing stops reading and cancels an oversized Catalog response", async () => {
  let chunks = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      chunks += 1;
      controller.enqueue(new Uint8Array(8 * 1024).fill(32));
      if (chunks === 128) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const owner = createCatalogPricingClient({
    fetch: async () => new Response(body, { status: 200 }),
  });
  await assert.rejects(() => owner.getPricingInput(request), {
    code: "CATALOG_UNAVAILABLE",
  });
  assert.ok(chunks < 128, `read all ${chunks} chunks`);
  assert.equal(canceled, true);
});
