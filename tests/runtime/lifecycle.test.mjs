import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScopedSecrets,
  createRuntime,
  createShutdownController,
} from "../../packages/platform-runtime/src/index.ts";

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

void test("Fastify close drains in-flight work before completing", async () => {
  const app = await createRuntime({
    name: "lifecycle-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
  });
  let release;
  let entered = false;
  app.get("/inflight", async () => {
    entered = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    return { status: "completed" };
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const request = fetch(`http://127.0.0.1:${address.port}/inflight`, {
    headers: { connection: "close" },
  });
  await waitFor(() => entered);
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  release();
  const response = await request;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "completed" });
  await closing;
  assert.equal(closed, true);
});

void test("health endpoints expose live and ready states", async () => {
  const app = await createRuntime({
    name: "health-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
  });
  const response = await app.inject("/health/live");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "live", runtime: "health-test" });
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 200);
  await app.close();
});

void test("readiness checks fail closed, recover, and expose correlation context", async () => {
  let dependencyReady = false;
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const app = await createRuntime({
    name: "readiness-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    health: {
      livePath: "/live",
      readyPath: "/ready",
      metricsPath: "/metrics",
      intervalMs: 5000,
      timeoutMs: 100,
      startupGraceMs: 30000,
      failureThreshold: 3,
      successThreshold: 1,
    },
    readinessChecks: [{ name: "database", check: async () => dependencyReady }],
  });
  app.get("/context", async (request) => ({
    requestCorrelationId: request.correlationContext?.correlationId,
  }));
  const notReady = await app.inject({
    method: "GET",
    url: "/ready",
    headers: { "x-correlation-id": correlationId },
  });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), {
    status: "not-ready",
    runtime: "readiness-test",
  });
  dependencyReady = true;
  const ready = await app.inject({
    method: "GET",
    url: "/ready",
    headers: { "x-correlation-id": correlationId, traceparent },
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.headers["x-correlation-id"], correlationId);
  assert.equal(ready.headers.traceparent, traceparent);
  const context = await app.inject({
    method: "GET",
    url: "/context",
    headers: { "x-correlation-id": correlationId, traceparent },
  });
  assert.deepEqual(context.json(), { requestCorrelationId: correlationId });
  const invalid = await app.inject({
    method: "GET",
    url: "/context",
    headers: { "x-correlation-id": "invalid", traceparent: "invalid" },
  });
  assert.match(invalid.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
  assert.equal(invalid.headers.traceparent, undefined);
  await app.close();
});

void test("shutdown controller marks readiness unavailable and closes dependencies once", async () => {
  let hookCalls = 0;
  const app = await createRuntime({
    name: "shutdown-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    shutdownHooks: [
      async () => {
        hookCalls += 1;
      },
    ],
  });
  const shutdown = createShutdownController(app, {
    name: "shutdown-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    shutdownHooks: [
      async () => {
        hookCalls += 1;
      },
    ],
  });
  const closing = shutdown.stop("SIGTERM");
  const notReady = await app.inject("/health/ready");
  assert.equal(notReady.statusCode, 503);
  await closing;
  await shutdown.stop("SIGINT");
  assert.equal(hookCalls, 1);
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("scoped secrets fail closed on foreign identity or missing refs", () => {
  const valid = {
    schemaVersion: 1,
    environment: "development",
    runtime: "customer-service",
    secrets: { postgres: { customer: { password: "redacted" } } },
  };
  assert.doesNotThrow(() =>
    assertScopedSecrets(valid, "customer-service", "development", [
      "postgres.customer",
    ]),
  );
  assert.throws(
    () =>
      assertScopedSecrets(
        { ...valid, runtime: "orders-service" },
        "customer-service",
        "development",
        ["postgres.customer"],
      ),
    /identity mismatch/,
  );
  assert.throws(
    () =>
      assertScopedSecrets(valid, "customer-service", "development", [
        "postgres.ordersService",
      ]),
    /required ref postgres\.ordersService is missing/,
  );
  assert.throws(
    () =>
      assertScopedSecrets(
        { ...valid, unexpected: true },
        "customer-service",
        "development",
        ["postgres.customer"],
      ),
    /unknown or missing metadata key/,
  );
});
