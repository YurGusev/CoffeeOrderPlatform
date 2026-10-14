import assert from "node:assert/strict";
import {createServer} from "node:http";
import test from "node:test";
import {createTelemetryResource} from "../../packages/platform-observability/dist/index.js";
import {createHttpClient, HttpOriginError} from "../../packages/platform-http/src/index.ts";

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(origin);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

void test("native fetch enforces the fixed origin and returns responses", async () => {
  await withServer((_request, response) => response.end("ok"), async (origin) => {
    const client = createHttpClient({origin, connections: 2});
    try {
      const response = await client.fetch("/health");
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "ok");
      await assert.rejects(client.fetch("https://not-allowed.example/"), HttpOriginError);
      await assert.rejects(client.fetch("health"), HttpOriginError);
    } finally {
      await client.close();
    }
  });
});

void test("active telemetry preserves caller traceparent and does not add one when absent", async () => {
  const receivedTraceparents = new Map();
  let exportedTraceRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/v1/traces" || request.url === "/v1/metrics") {
      if (request.url === "/v1/traces") exportedTraceRequests += 1;
      request.on("end", () => {response.writeHead(200, {"content-type": "application/x-protobuf"}); response.end();});
      request.resume();
      return;
    }
    receivedTraceparents.set(request.url, request.headers.traceparent);
    response.end("ok");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createHttpClient({origin: `http://127.0.0.1:${address.port}`});
  const telemetry = createTelemetryResource({
    environment: "development",
    namespace: "coffee-platform",
    releaseDigest: "test",
    collector: {otlpEndpoint: `http://127.0.0.1:${address.port}`, queueCapacity: 4, batchSize: 1, batchTimeoutMs: 10, exportTimeoutMs: 500},
    producer: {queueCapacity: 4, maxRecordBytes: 16384, batchSize: 4, batchIntervalMs: 60000, exportTimeoutMs: 500, diagnosticIntervalMs: 60000, flushTimeoutMs: 1000},
  }, "platform-http-test", "test-token");
  try {
    telemetry.start();
    const signedTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    assert.equal((await client.fetch("/signed", {headers: {traceparent: signedTraceparent}})).status, 200);
    assert.equal((await client.fetch("/absent")).status, 200);
    assert.equal(receivedTraceparents.get("/signed"), signedTraceparent);
    assert.equal(receivedTraceparents.has("/absent"), true);
    assert.equal(receivedTraceparents.get("/absent"), undefined);
  } finally {
    await client.close();
    await telemetry.stop(AbortSignal.timeout(2000));
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.ok(exportedTraceRequests > 0, "the canonical telemetry SDK exported the HTTP client span");
});

void test("native fetch combines caller cancellation with a deadline", async () => {
  await withServer((_request, _response) => {
    // Keep the request open until the client-side AbortSignal closes it.
  }, async (origin) => {
    const client = createHttpClient({origin});
    try {
      await assert.rejects(client.fetch("/deadline", {deadlineMs: 20}), (error) => error?.name === "TimeoutError");
      const controller = new AbortController();
      const request = client.fetch("/cancel", {signal: controller.signal, deadlineMs: 1_000});
      controller.abort(new Error("test cancellation"));
      await assert.rejects(request, (error) => error?.name === "Error" || error?.name === "AbortError");
    } finally {
      await client.close();
    }
  });
});

void test("Undici Agent bounds concurrent connections", async () => {
  let active = 0;
  let maxActive = 0;
  await withServer((_request, response) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => {
      active -= 1;
      response.end("done");
    }, 30);
  }, async (origin) => {
    const client = createHttpClient({origin, connections: 2, pipelining: 1});
    try {
      const responses = await Promise.all(Array.from({length: 6}, () => client.fetch("/pool")));
      assert.deepEqual(await Promise.all(responses.map((response) => response.text())), Array(6).fill("done"));
      assert.ok(maxActive <= 2, `max active connections was ${maxActive}`);
    } finally {
      await client.close();
    }
  });
});

void test("HTTP client rejects invalid pool and timeout settings", () => {
  assert.throws(() => createHttpClient({origin: "http://localhost", connections: 0}), /connections/);
  assert.throws(() => createHttpClient({origin: "http://localhost", idleTimeoutMs: 0}), /idleTimeoutMs/);
  assert.throws(() => createHttpClient({origin: "ftp://localhost"}), /http or https/);
});
