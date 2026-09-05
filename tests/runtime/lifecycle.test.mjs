import assert from "node:assert/strict";
import {request as httpRequest} from "node:http";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import test from "node:test";
import {load as parseYaml} from "js-yaml";
import {RUNTIME_NAMES, loadPlatformConfig} from "../../packages/platform-config/src/index.ts";
import {
  assertScopedSecrets,
  configuredRuntimeIdentity,
  createRuntime,
  RuntimeError,
  startRuntime,
} from "../../packages/platform-runtime/src/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const health = {
  livePath: "/health/live",
  readyPath: "/health/ready",
  metricsPath: "/metrics",
  intervalMs: 5_000,
  timeoutMs: 1_000,
  startupGraceMs: 30_000,
  failureThreshold: 3,
  successThreshold: 1,
};

function identity(name, options = {}) {
  return {
    name,
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    ...options,
  };
}

async function startApp(options) {
  const app = await createRuntime(options);
  await app.runtimeController.start();
  return app;
}

function stopApp(app, signal = "SIGTERM") {
  return app.runtimeController.closeRuntime(signal);
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function addressOf(app) {
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

function closeClientRequest(request) {
  return new Promise((resolve) => {
    request.once("close", resolve);
    request.once("error", resolve);
    request.destroy();
  });
}

async function requestJson(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {host: "127.0.0.1", port, path, ...options},
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({response, body}));
      },
    );
    request.once("error", reject);
    request.end(options.body);
  });
}

function waitForChildExit(child, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("child did not exit before timeout"));
    }, timeoutMs);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolve, {code, signal}));
  });
}

void test("Fastify close drains in-flight work before completing", async () => {
  const app = await createRuntime(identity("lifecycle-test"));
  let release;
  let entered = false;
  app.get("/inflight", async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "completed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = fetch(`http://127.0.0.1:${port}/inflight`, {
    headers: {connection: "close"},
  });
  await waitFor(() => entered);
  let closed = false;
  const closing = stopApp(app).then((result) => {
    closed = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  release();
  const response = await request;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {status: "completed"});
  assert.deepEqual(await closing, {status: "stopped", pending: []});
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("health endpoints expose live and ready states", async () => {
  const app = await startApp(identity("health-test"));
  const live = await app.inject("/health/live");
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), {status: "live", runtime: "health-test"});
  const ready = await app.inject("/health/ready");
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
});

void test("readiness checks fail closed, recover, and expose correlation context", async () => {
  let dependencyReady = false;
  const correlationId = "11111111-1111-4111-8111-111111111111";
  const traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const app = await createRuntime(identity("readiness-test", {
    health: {...health, timeoutMs: 100},
    requiredDependencies: ["database"],
    readinessChecks: [{name: "database", check: async () => dependencyReady}],
  }));
  app.get("/context", async (request) => ({
    requestCorrelationId: request.correlationContext?.correlationId,
    deadlineUtc: request.runtimeContext?.deadlineUtc,
  }));
  await app.runtimeController.start();
  const notReady = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: {"x-correlation-id": correlationId},
  });
  assert.equal(notReady.statusCode, 503);
  assert.deepEqual(notReady.json(), {status: "not-ready", runtime: "readiness-test"});
  dependencyReady = true;
  const ready = await app.inject({
    method: "GET",
    url: "/health/ready",
    headers: {"x-correlation-id": correlationId, traceparent},
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.headers["x-correlation-id"], correlationId);
  assert.equal(ready.headers.traceparent, traceparent);
  const context = await app.inject({
    method: "GET",
    url: "/context",
    headers: {"x-correlation-id": correlationId, traceparent},
  });
  assert.equal(context.json().requestCorrelationId, correlationId);
  assert.match(context.json().deadlineUtc, /^\d{4}-\d{2}-\d{2}T/);
  const invalid = await app.inject({
    method: "GET",
    url: "/context",
    headers: {"x-correlation-id": "invalid", traceparent: "invalid"},
  });
  assert.match(invalid.headers["x-correlation-id"], /^[0-9a-f-]{36}$/);
  assert.equal(invalid.headers.traceparent, undefined);
  await stopApp(app);
});

void test("shutdown resources stop once in reverse order and repeated close is idempotent", async () => {
  const calls = [];
  const resource = (name) => ({
    name,
    start: async () => { calls.push(`start:${name}`); },
    stop: async () => { calls.push(`stop:${name}`); },
    destroy: () => { calls.push(`destroy:${name}`); },
  });
  const app = await startApp(identity("shutdown-test", {
    resources: [resource("database"), resource("worker")],
  }));
  const first = stopApp(app, "SIGTERM");
  const second = stopApp(app, "SIGINT");
  assert.strictEqual(first, second);
  assert.deepEqual(await first, {status: "stopped", pending: []});
  assert.deepEqual(calls, ["start:database", "start:worker", "stop:worker", "stop:database"]);
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.strictEqual(await app.runtimeController.whenStopped, await first);
});

void test("phase transition rejects invalid edges and keeps repeated transition harmless", async () => {
  const app = await createRuntime(identity("phase-test"));
  assert.equal(app.runtimeController.phase(), "starting");
  assert.throws(() => app.runtimeController.transition("stopped"), (error) =>
    error instanceof RuntimeError && error.code === "RUNTIME_INVALID_TRANSITION");
  await app.runtimeController.start();
  assert.equal(app.runtimeController.phase(), "running");
  app.runtimeController.transition("draining");
  app.runtimeController.transition("draining");
  assert.equal(app.runtimeController.phase(), "draining");
  const result = await stopApp(app);
  assert.deepEqual(result, {status: "stopped", pending: []});
  assert.throws(() => app.runtimeController.transition("running"), /RUNTIME_INVALID_TRANSITION/);
});

void test("liveness stays live while draining and readiness fails closed", async () => {
  const gate = Promise.withResolvers();
  let entered = 0;
  const app = await startApp(identity("draining-test", {
    configure: (server) => {
      server.addHook("onRequest", async () => {
        entered += 1;
        await gate.promise;
      });
    },
  }));
  const {port} = addressOf(app);
  const live = requestJson(port, "/health/live");
  const ready = requestJson(port, "/health/ready");
  await waitFor(() => entered === 2);
  const closing = stopApp(app);
  assert.equal(app.runtimeController.phase(), "draining");
  gate.resolve();
  assert.equal((await live).response.statusCode, 200);
  assert.equal((await ready).response.statusCode, 503);
  assert.deepEqual(await closing, {status: "stopped", pending: []});
  assert.equal(app.server.listening, false);
  await assert.rejects(requestJson(port, "/health/ready", {agent: false}), {code: "ECONNREFUSED"});
  assert.throws(() => app.runtimeController.start(), /RUNTIME_INVALID_TRANSITION/);
});

void test("premature GET response disconnect aborts the request signal", async () => {
  let entered = false;
  let rawRequest;
  let release;
  let signal;
  const app = await createRuntime(identity("disconnect-get-test", {deadlineMs: 2_000}));
  app.get("/slow", async (request) => {
    rawRequest = request.raw;
    signal = request.runtimeContext.signal;
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "completed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/slow"});
  request.end();
  await waitFor(() => entered);
  assert.equal(rawRequest.complete, true);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  release();
  await stopApp(app);
});

void test("non-cooperative handler stays tracked after disconnect and forces fail-stop", async () => {
  let entered = false;
  let signal;
  const app = await createRuntime(identity("non-cooperative-test", {deadlineMs: 2_000, shutdownGraceMs: 40}));
  app.get("/blackhole", async (request) => {
    signal = request.runtimeContext.signal;
    entered = true;
    await new Promise(() => {});
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/blackhole"});
  request.end();
  await waitFor(() => entered);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  const result = await stopApp(app);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual(result.pending, ["handlers"]);
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.equal(app.server.listening, false);
});

void test("partial POST input disconnects before the request is complete", async () => {
  let signal;
  const app = await createRuntime(identity("disconnect-post-test", {deadlineMs: 2_000}));
  app.post("/partial", async () => ({status: "unexpected"}));
  app.addHook("onRequest", (request) => {
    if (request.routeOptions.url === "/partial") signal = request.runtimeContext.signal;
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/partial",
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 10},
  });
  request.write("{}");
  await waitFor(() => signal !== undefined);
  await closeClientRequest(request);
  await waitFor(() => signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_CLIENT_DISCONNECTED");
  await stopApp(app);
});

void test("normal finished response does not abort and clears the deadline timer", async () => {
  let signal;
  const app = await createRuntime(identity("normal-response-test", {deadlineMs: 30}));
  app.get("/fast", async (request) => {
    signal = request.runtimeContext.signal;
    assert.match(request.runtimeContext.deadlineUtc, /^\d{4}-\d{2}-\d{2}T/);
    return {status: "ok"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const result = await requestJson(port, "/fast");
  assert.equal(result.response.statusCode, 200);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal.aborted, false);
  await stopApp(app);
});

void test("request deadline aborts a cooperative handler and destroys its response", async () => {
  let signal;
  const app = await createRuntime(identity("deadline-test", {deadlineMs: 30}));
  app.get("/deadline", async (request) => {
    signal = request.runtimeContext.signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
    return {status: "never-sent"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/deadline`));
  await waitFor(() => signal !== undefined && signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_REQUEST_DEADLINE");
  await stopApp(app);
});

void test("durable acceptance survives disconnect and idempotency replay does not repeat the effect", async () => {
  const ledger = new Map();
  const effects = [];
  let accepted = false;
  let release;
  let signal;
  const app = await createRuntime(identity("durable-accept-test", {deadlineMs: 2_000}));
  app.post("/command", async (request) => {
    signal = request.runtimeContext.signal;
    const key = request.headers["idempotency-key"];
    const completed = ledger.get(key);
    if (completed !== undefined) return {status: "replay", effect: completed};
    effects.push(key);
    ledger.set(key, "committed");
    request.runtimeContext.acceptDurable();
    accepted = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "accepted", effect: "committed"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const first = httpRequest({
    host: "127.0.0.1",
    port,
    path: "/command",
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 2, "idempotency-key": "command-1"},
  });
  first.end("{}");
  await waitFor(() => accepted);
  await closeClientRequest(first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
  release();
  const replay = await requestJson(port, "/command", {
    method: "POST",
    headers: {"content-type": "application/json", "content-length": 2, "idempotency-key": "command-1"},
    body: "{}",
  });
  assert.equal(replay.response.statusCode, 200);
  assert.deepEqual(JSON.parse(replay.body), {status: "replay", effect: "committed"});
  assert.deepEqual(effects, ["command-1"]);
  await stopApp(app);
});

void test("startup failure stops acquired resources in reverse order", async () => {
  const calls = [];
  const resources = [
    {name: "first", start: () => { calls.push("start:first"); }, stop: () => { calls.push("stop:first"); }, destroy: () => { calls.push("destroy:first"); }},
    {name: "second", start: () => { calls.push("start:second"); throw new Error("startup boom"); }, stop: () => { calls.push("stop:second"); }, destroy: () => { calls.push("destroy:second"); }},
  ];
  const app = await createRuntime(identity("startup-failure-test", {resources}));
  await assert.rejects(app.runtimeController.start(), /startup boom/);
  assert.deepEqual(calls, ["start:first", "start:second", "stop:second", "stop:first"]);
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("startup blackhole times out, cleans acquired resources, and skips later resources", async () => {
  const calls = [];
  let firstDestroyed = 0;
  let secondStarted = false;
  const app = await createRuntime(identity("startup-blackhole-test", {
    health: {...health, startupGraceMs: 30},
    shutdownGraceMs: 40,
    resources: [
      {
        name: "first",
        start: () => new Promise(() => {}),
        stop: () => { calls.push("stop:first"); },
        destroy: () => { firstDestroyed += 1; },
      },
      {
        name: "second",
        start: () => { secondStarted = true; },
        stop: () => { calls.push("stop:second"); },
        destroy: () => { calls.push("destroy:second"); },
      },
    ],
  }));
  const started = performance.now();
  await assert.rejects(app.runtimeController.start(), (error) => error?.code === "RUNTIME_STARTUP_DEADLINE");
  assert.ok(performance.now() - started < 500);
  assert.equal(secondStarted, false);
  assert.deepEqual(calls, ["stop:first"]);
  assert.equal(firstDestroyed, 1);
  assert.equal(app.runtimeController.phase(), "stopped");
});

void test("blackhole shutdown aborts requests, destroys resources, and closes the listener", async () => {
  let destroyed = 0;
  let requestSignal;
  let entered = false;
  let requestComplete = false;
  const app = await createRuntime(identity("blackhole-test", {
    shutdownGraceMs: 40,
    resources: [{
      name: "inflight-owner",
      stop: () => {},
      destroy: () => { destroyed += 1; },
    }],
  }));
  app.get("/open", async (request) => {
    requestSignal = request.runtimeContext.signal;
    requestComplete = request.raw.complete;
    entered = true;
    await new Promise((resolve) => requestSignal.addEventListener("abort", resolve, {once: true}));
    return {status: "aborted"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const request = httpRequest({host: "127.0.0.1", port, path: "/open"});
  const requestClosed = new Promise((resolve) => {
    request.once("close", resolve);
    request.once("error", resolve);
  });
  request.end();
  await waitFor(() => entered);
  assert.equal(requestComplete, true);
  const started = performance.now();
  const result = await stopApp(app);
  await requestClosed;
  assert.ok(performance.now() - started < 500);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual([...result.pending].sort((left, right) => left.localeCompare(right)), ["handlers", "requests", "server-close"]);
  assert.equal(destroyed, 1);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason.code, "RUNTIME_SHUTDOWN_DEADLINE");
  assert.equal(app.runtimeController.phase(), "stopped");
  assert.equal(app.server.listening, false);
  await new Promise((resolve) => {
    const reconnect = httpRequest({host: "127.0.0.1", port, path: "/health/live"});
    reconnect.once("error", (error) => {
      assert.equal(error.code, "ECONNREFUSED");
      resolve();
    });
    reconnect.end();
  });
});

void test("blackhole resource stop is bounded and force-destroyed", async () => {
  let stopStarted = false;
  let destroyed = 0;
  const app = await startApp(identity("blackhole-resource-test", {
    shutdownGraceMs: 40,
    resources: [{
      name: "blackhole",
      stop: () => {
        stopStarted = true;
        return new Promise(() => {});
      },
      destroy: () => { destroyed += 1; },
    }],
  }));
  const started = performance.now();
  const result = await stopApp(app);
  assert.ok(performance.now() - started < 500, "resource stop must return within the bounded shutdown allowance");
  assert.equal(stopStarted, true);
  assert.equal(result.status, "fail-stop");
  assert.deepEqual(result.pending, ["server-close", "stop:blackhole"]);
  assert.equal(destroyed, 1);
  assert.equal(app.server.listening, false);
});

void test("readiness blackhole is bounded and does not start new probes while pending", async () => {
  let probes = 0;
  let checkSignal;
  const app = await startApp(identity("readiness-blackhole-test", {
    health: {...health, timeoutMs: 30},
    requiredDependencies: ["database"],
    readinessChecks: [{
      name: "database",
      check: (signal) => {
        probes += 1;
        checkSignal = signal;
        return new Promise(() => {});
      },
    }],
  }));
  const started = performance.now();
  const first = await app.inject("/health/ready");
  assert.ok(performance.now() - started < 500, "readiness blackhole must return within the bounded probe allowance");
  assert.equal(first.statusCode, 503);
  assert.equal(probes, 1);
  assert.equal(checkSignal.aborted, true);
  assert.equal(checkSignal.reason.code, "RUNTIME_READINESS_DEADLINE");
  const second = await app.inject("/health/ready");
  assert.equal(second.statusCode, 503);
  assert.equal(probes, 1);
  const stopped = await stopApp(app);
  assert.equal(stopped.status, "fail-stop");
  assert.deepEqual(stopped.pending, ["readiness:database"]);
  assert.equal(app.server.listening, false);
});

void test("concurrency admission cap keeps health endpoints available", async () => {
  let entered = false;
  let release;
  const app = await createRuntime(identity("concurrency-test", {concurrency: 1}));
  app.get("/busy", async () => {
    entered = true;
    await new Promise((resolve) => { release = resolve; });
    return {status: "done"};
  });
  app.get("/second", async () => ({status: "unexpected"}));
  await app.runtimeController.start();
  const {port} = addressOf(app);
  const first = fetch(`http://127.0.0.1:${port}/busy`);
  await waitFor(() => entered);
  const second = await fetch(`http://127.0.0.1:${port}/second`);
  assert.equal(second.status, 503);
  assert.equal((await app.inject("/health/live")).statusCode, 200);
  assert.equal((await app.inject("/health/ready")).statusCode, 200);
  release();
  assert.equal((await first).status, 200);
  await stopApp(app);
});

void test("known deadline profile aborts and unknown profile is rejected", async () => {
  const unknown = await createRuntime(identity("unknown-profile-test", {
    deadlineProfiles: {defaultMs: 1_000, fastMs: 30},
  }));
  assert.throws(() => unknown.get("/unknown", {
    config: {runtimeDeadlineProfile: "missing"},
  }, async () => ({status: "unexpected"})), /RUNTIME_UNKNOWN_DEADLINE_PROFILE/);
  await stopApp(unknown);

  let signal;
  const app = await createRuntime(identity("known-profile-test", {
    deadlineMs: 1_000,
    deadlineProfiles: {defaultMs: 1_000, fastMs: 30},
  }));
  app.get("/fast", {
    config: {runtimeDeadlineProfile: "fastMs"},
  }, async (request) => {
    signal = request.runtimeContext.signal;
    await new Promise((resolve) => signal.addEventListener("abort", resolve, {once: true}));
    return {status: "never-sent"};
  });
  await app.runtimeController.start();
  const {port} = addressOf(app);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/fast`));
  await waitFor(() => signal !== undefined && signal.aborted);
  assert.equal(signal.reason.code, "RUNTIME_REQUEST_DEADLINE");
  await stopApp(app);
});

void test("startRuntime removes its process signal listeners after normal stop", async () => {
  const before = {
    term: process.listenerCount("SIGTERM"),
    int: process.listenerCount("SIGINT"),
  };
  const app = await startRuntime(identity("signal-cleanup-test"));
  assert.equal(process.listenerCount("SIGTERM"), before.term + 1);
  assert.equal(process.listenerCount("SIGINT"), before.int + 1);
  assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
  await waitFor(() => process.listenerCount("SIGTERM") === before.term && process.listenerCount("SIGINT") === before.int);
});

void test("all 15 configured roots use one real listen/controller lifecycle and dependency matrix", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  const serverCount = () => process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
  await waitFor(() => serverCount() === 0);
  const serversBefore = serverCount();
  const signalsBefore = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
  const startRoot = async (options) => {
    const app = await startRuntime({...options, host: "127.0.0.1", port: 0});
    assert.equal(serverCount(), serversBefore + 1, `${options.name}: exactly one TCP server`);
    assert.equal(process.listenerCount("SIGTERM"), signalsBefore[0] + 1, options.name);
    assert.equal(process.listenerCount("SIGINT"), signalsBefore[1] + 1, options.name);
    return app;
  };
  const stopRoot = async (app) => {
    assert.deepEqual(await stopApp(app), {status: "stopped", pending: []});
    await waitFor(() => serverCount() === serversBefore);
    assert.equal(process.listenerCount("SIGTERM"), signalsBefore[0]);
    assert.equal(process.listenerCount("SIGINT"), signalsBefore[1]);
  };
  const expectedDependencies = {
    "edge-gateway": [],
    "api-public": [],
    "api-internal": [],
    web: [],
    "customer-service": ["database"],
    "catalog-service": ["database"],
    "catalog-supplier-sync": ["database"],
    "catalog-activation-worker": ["database", "kafka"],
    "pricing-service": ["database"],
    "orders-service": ["database", "kafka"],
    "orders-aroma-preparation": ["database", "kafka"],
    "aroma-observer": ["database", "kafka"],
    "aroma-convergence": ["database", "kafka"],
    "aroma-gateway": ["database"],
    "realtime-gateway": ["kafka"],
  };
  assert.equal(RUNTIME_NAMES.length, 15);
  for (const name of RUNTIME_NAMES) {
    const base = configuredRuntimeIdentity(config, name);
    const required = expectedDependencies[name];
    assert.deepEqual(base.requiredDependencies, required, name);
    const missing = await startRoot(base);
    const missingReady = await missing.inject("/health/ready");
    assert.equal(missingReady.statusCode, required.length === 0 ? 200 : 503, name);
    const missingLive = await missing.inject("/health/live");
    assert.equal(missingLive.statusCode, 200, name);
    await stopRoot(missing);
    if (required.length === 0) continue;
    const state = new Map(required.map((dependency) => [dependency, true]));
    const checks = required.map((dependency) => ({name: dependency, check: () => state.get(dependency)}));
    const healthy = await startRoot({...base, readinessChecks: checks});
    assert.equal((await healthy.inject("/health/ready")).statusCode, 200, name);
    state.set(required[0], false);
    assert.equal((await healthy.inject("/health/ready")).statusCode, 503, name);
    await stopRoot(healthy);
  }
});

void test("configured roots preserve null deadlines for api-internal and realtime-gateway", async () => {
  const config = await loadPlatformConfig(join(root, "config/platform.yaml"), (text) => parseYaml(text, {json: true}));
  for (const name of ["api-internal", "realtime-gateway"]) {
    const base = configuredRuntimeIdentity(config, name, {
      configure: (app) => {
        app.get("/context", async (request) => ({deadlineUtc: request.runtimeContext.deadlineUtc}));
      },
    });
    const app = await startApp({...base, port: 0});
    assert.deepEqual((await app.inject("/context")).json(), {deadlineUtc: null});
    await stopApp(app);
  }
});

void test("startRuntime removes signal listeners and repeated process signals perform one shutdown in a child", async () => {
  const runtimePath = join(root, "packages/platform-runtime/src/index.ts");
  const script = `
    import {startRuntime} from ${JSON.stringify(runtimePath)};
    const app = await startRuntime({
      name: "signal-child",
      host: "127.0.0.1",
      port: 0,
      shutdownGraceMs: 50,
      resources: [{
        name: "blackhole",
        stop: () => { console.log("stop-hook"); return new Promise(() => {}); },
        destroy: () => console.log("destroy-hook"),
      }],
    });
    console.log("ready");
    void app;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child did not start: ${stderr}`)), 2_000);
      const onData = () => {
        if (stdout.includes("ready")) { clearTimeout(timer); child.stdout.removeListener("data", onData); resolve(); }
      };
      child.stdout.on("data", onData);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.kill("SIGINT");
    const exit = await waitForChildExit(child);
    assert.equal(exit.code, 1, stderr);
    assert.equal((stdout.match(/stop-hook/g) ?? []).length, 1, stdout);
    assert.equal((stdout.match(/destroy-hook/g) ?? []).length, 1, stdout);
    assert.equal((stdout.match(/runtime.shutdown"/g) ?? []).length, 1, stdout);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

void test("scoped secrets fail closed on foreign identity or missing refs", () => {
  const valid = {
    schemaVersion: 1,
    environment: "development",
    runtime: "customer-service",
    secrets: {postgres: {customer: {password: "redacted"}}},
  };
  assert.doesNotThrow(() => assertScopedSecrets(valid, "customer-service", "development", ["postgres.customer"]));
  assert.throws(() => assertScopedSecrets({...valid, runtime: "orders-service"}, "customer-service", "development", ["postgres.customer"]), /identity mismatch/);
  assert.throws(() => assertScopedSecrets(valid, "customer-service", "development", ["postgres.ordersService"]), /required ref postgres\.ordersService is missing/);
  assert.throws(() => assertScopedSecrets({...valid, unexpected: true}, "customer-service", "development", ["postgres.customer"]), /unknown or missing metadata key/);
});
