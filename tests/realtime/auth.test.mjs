import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "node:https";
import { generateKeyPairSync } from "node:crypto";
import * as gateway from "../../apps/realtime-gateway/dist/index.js";
import {
  isActorContextTimeValid,
  signActorContext,
} from "../../packages/platform-security/dist/index.js";
import {
  realtimeFixture,
  until,
  envelope,
  record,
  Sink,
  config,
  sleep,
  turn,
} from "./helpers.mjs";
import { processKafkaRecord } from "../../packages/platform-kafka-runtime/dist/index.js";

void test("configured verifier requires the scoped active/previous public key set, rejects signing/key fallback", () => {
  for (const secrets of [
    {},
    { security: {} },
    { security: { actorContextEdgeSigningPrivateKey: "synthetic" } },
    {
      security: {
        actorContextEdgeVerificationPublicKeys: {
          active: "invalid",
          previous: "invalid",
        },
      },
    },
    {
      security: {
        actorContextEdgeVerificationPublicKeys: {
          active: pair.publicKey.export({ type: "spki", format: "pem" }),
        },
      },
    },
  ])
    assert.throws(() => gateway.configuredRealtimeActorVerifier({ secrets }));
  const previous = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);
  const verifier = gateway.configuredRealtimeActorVerifier({
    secrets: {
      security: {
        actorContextEdgeVerificationPublicKeys: {
          active: pair.publicKey.export({ type: "spki", format: "pem" }),
          previous: previous.publicKey.export({ type: "spki", format: "pem" }),
        },
      },
    },
  });
  assert.equal(
    verifier(
      signActorContext(
        { ...base, iat: now, exp: now + 60 },
        previous.privateKey,
      ),
      corr,
      trace,
    ).sub,
    "operator",
  );
  assert.throws(() =>
    verifier(
      signActorContext(
        { ...base, iat: now, exp: now + 60 },
        generateKeyPairSync("ed25519").privateKey,
      ),
      corr,
      trace,
    ),
  );
});
void test("real composed mTLS receiver separates edge-nginx caller from signed edge-gateway issuer; negatives precede SSE", async (t) => {
  const f = await realtimeFixture(t);
  assert.equal(f.bindings.length, 1);
  assert.equal(f.bindings[0].group, "realtime-gateway-v1");
  async function rejected(options, status, code) {
    const response = await f.request(options);
    await until(() => response.res.complete);
    assert.equal(response.res.statusCode, status);
    assert.equal(
      response.res.headers["content-type"],
      "application/problem+json; charset=utf-8",
    );
    assert.equal(response.res.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(response.text()).code, code);
    assert.equal(
      JSON.parse(response.text()).correlationId,
      response.res.headers["x-correlation-id"],
    );
    assert.doesNotMatch(response.text(), /stream-ready|event-stream/);
    assert.equal(f.composition.hub().stats().connections, 0);
  }
  await rejected({ client: f.wrong }, 401, "AUTHENTICATION_REQUIRED");
  await assert.rejects(f.request({ client: null }));
  await rejected(
    {
      headers: {
        "x-correlation-id": corr,
        traceparent: trace,
        "x-actor-permissions": "orders:read:any",
      },
    },
    401,
    "AUTHENTICATION_REQUIRED",
  );
  for (const change of [
    { aud: "api-public" },
    { iss: "api-public" },
    { originalIssuer: "api-public" },
    { permissions: ["orders:read:own"] },
    { operationId: "getOrderCard" },
    { correlationId: "88888888-8888-4888-8888-888888888888" },
    { traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" },
    { iat: 1, exp: 2 },
  ])
    await rejected(
      { headers: f.headers(change) },
      403,
      "ACTOR_CONTEXT_INVALID",
    );
  await rejected(
    { headers: { ...f.headers(), "x-actor-context": "invalid" } },
    403,
    "ACTOR_CONTEXT_INVALID",
  );
  await rejected(
    { headers: f.headers({}, generateKeyPairSync("ed25519").privateKey) },
    403,
    "ACTOR_CONTEXT_INVALID",
  );
  await rejected(
    { path: "/events?orderRef=ord_00000000000000000000000000" },
    400,
    "VALIDATION_FAILED",
  );
  await rejected(
    { path: "/events?lastEventId=msg_00000000000000000000000000" },
    400,
    "VALIDATION_FAILED",
  );
  const missingTrace = f.headers();
  delete missingTrace.traceparent;
  await rejected({ headers: missingTrace }, 403, "ACTOR_CONTEXT_INVALID");
  const browserHeaders = f.headers({
    traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
  });
  delete browserHeaders.traceparent;
  const browserStream = await f.request({ headers: browserHeaders });
  assert.equal(
    browserStream.res.statusCode,
    200,
    "a native EventSource without tracing headers must accept the Edge-signed no-trace sentinel",
  );
  await until(() => browserStream.text().includes("stream-ready.v1"));
  browserStream.req.destroy();
  await until(() => f.composition.hub().stats().connections === 0);
  const stream = await f.request({
    headers: f.headers({}, f.previous.privateKey),
  });
  await until(() => stream.text().includes("stream-ready.v1"));
  assert.equal(stream.res.statusCode, 200);
  assert.equal(
    stream.res.headers["content-type"],
    "text/event-stream; charset=utf-8",
  );
  assert.equal(stream.res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(stream.res.headers.connection, "keep-alive");
  assert.equal(stream.res.headers["x-accel-buffering"], "no");
  await sleep(30);
  const telemetry = await f.request({ path: "/metrics" });
  await until(() => telemetry.res.complete);
  assert.ok(
    Number(
      /^coffee_realtime_event_loop_delay_samples (\d+)$/m.exec(
        telemetry.text(),
      )?.[1],
    ) > 0,
    "event-loop telemetry must contain actual process samples",
  );
  const delay = Number(
    /^coffee_realtime_event_loop_delay_p95_ms ([\d.]+)$/m.exec(
      telemetry.text(),
    )?.[1],
  );
  assert.ok(Number.isFinite(delay) && delay >= 0);
  const e = envelope();
  const order = [];
  await processKafkaRecord(record(e), {
    runtime: "realtime-gateway",
    groupId: f.bindings[0].group,
    topics: [record(e).topic],
    binding: f.bindings[0].binding,
    signal: new AbortController().signal,
    leaseMs: 30000,
    maxMessageBytes: 1048576,
    commit: async () => {
      assert.equal(f.composition.hub().stats().ringRecords, 1);
      order.push("offset");
    },
    quarantine: async () => assert.fail("valid invalidation quarantined"),
  });
  assert.deepEqual(order, ["offset"]);
  await until(() => stream.text().includes(e.messageId));
  assert.match(stream.text(), /resource-invalidated.v1/);
  stream.req.destroy();
  await until(() => f.composition.hub().stats().connections === 0);
  const reconnect = await f.request({
    headers: { ...f.headers(), "last-event-id": e.messageId },
  });
  await until(() => reconnect.text().includes("stream-ready.v1"));
  assert.doesNotMatch(reconnect.text(), /resource-invalidated/);
  const shutdown = await f.app.runtimeController.closeRuntime();
  assert.equal(shutdown.status, "stopped");
  assert.equal(f.composition.hub().stats().connections, 0);
  assert.equal(f.composition.hub().stats().queuedBytes, 0);
  assert.match(
    reconnect.text(),
    /event: stream-reset\.v1\n/,
    "the real runtime must deliver reset before closing its SSE socket on graceful drain",
  );
});
void test("graceful SSE drain closes a keep-alive TLS socket after flushing reset", async (t) => {
  const f = await realtimeFixture(t);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const stream = await f.request({ agent });
  await until(() => stream.text().includes("stream-ready.v1"));
  assert.equal(stream.req.agent, agent);
  assert.equal(stream.res.headers.connection, "keep-alive");
  const closing = f.app.runtimeController.closeRuntime();
  await until(() => stream.res.complete);
  const shutdown = await closing;
  assert.equal(shutdown.status, "stopped");
  assert.match(stream.text(), /event: stream-reset\.v1\n/);
  assert.equal(f.composition.hub().stats().connections, 0);
});
void test("real runtime early saturation emits a correlated RFC9457 capacity response before headers/handler", async (t) => {
  const f = await realtimeFixture(t, { concurrency: 1 });
  const stream = await f.request();
  await until(() => stream.text().includes("stream-ready.v1"));
  const denial = await f.request();
  await until(() => denial.res.complete);
  assert.equal(denial.res.statusCode, 503);
  assert.equal(
    denial.res.headers["content-type"],
    "application/problem+json; charset=utf-8",
  );
  assert.equal(denial.res.headers["cache-control"], "no-store");
  const problem = JSON.parse(denial.text());
  assert.equal(problem.code, "REALTIME_CAPACITY_EXCEEDED");
  assert.equal(problem.correlationId, denial.res.headers["x-correlation-id"]);
  assert.doesNotMatch(denial.text(), /stream-ready|event-stream/);
  assert.equal(f.composition.hub().stats().connections, 1);
  const health = await f.request({ path: "/health/live" });
  await until(() => health.res.complete);
  assert.equal(health.res.statusCode, 200);
  stream.req.destroy();
  await until(() => f.composition.hub().stats().connections === 0);
  const replacement = await f.request();
  await until(() => replacement.text().includes("stream-ready.v1"));
  assert.equal(replacement.res.statusCode, 200);
});
void test("event-loop delay metrics use actual scrape windows and retain the last sampled window", async (t) => {
  const f = await realtimeFixture(t);
  const read = () =>
    Object.fromEntries(
      f.composition
        .metrics()
        .filter((line) => line.startsWith("coffee_realtime_event_loop_delay_"))
        .map((line) => {
          const [name, value] = line.split(" ");
          return [name, Number(value)];
        }),
    );
  await sleep(250);
  const baseline = read();
  assert.ok(
    baseline.coffee_realtime_event_loop_delay_samples > 0,
    "baseline must capture real event-loop samples",
  );
  await sleep(30);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  const deadline = Date.now() + 1000;
  let blocked;
  do {
    await sleep(5);
    blocked = read();
  } while (
    blocked.coffee_realtime_event_loop_delay_samples ===
      baseline.coffee_realtime_event_loop_delay_samples &&
    Date.now() < deadline
  );
  assert.ok(
    blocked.coffee_realtime_event_loop_delay_samples >
      baseline.coffee_realtime_event_loop_delay_samples,
    "sample total must increase after the blocked window",
  );
  assert.ok(
    blocked.coffee_realtime_event_loop_delay_p95_ms >= 150,
    `short blocked window must not be diluted by the long baseline window: ${JSON.stringify({ baseline, blocked })}`,
  );
  const empty = read();
  assert.equal(
    empty.coffee_realtime_event_loop_delay_samples,
    blocked.coffee_realtime_event_loop_delay_samples,
    "empty scrape must preserve the monotonic sample total",
  );
  assert.equal(
    empty.coffee_realtime_event_loop_delay_p95_ms,
    blocked.coffee_realtime_event_loop_delay_p95_ms,
    "empty scrape must preserve the last actual window percentile",
  );
  await sleep(60);
  let next = read();
  if (
    next.coffee_realtime_event_loop_delay_samples ===
    empty.coffee_realtime_event_loop_delay_samples
  ) {
    await sleep(30);
    next = read();
  }
  assert.ok(
    next.coffee_realtime_event_loop_delay_samples >
      empty.coffee_realtime_event_loop_delay_samples,
    "next sampled window must advance the total",
  );
});
void test("realtime startup waits for all configured Kafka partitions and a usable latest-offset boundary before accepting SSE", async (t) => {
  let assigned = 0,
    subscriptionReady = false;
  const f = await realtimeFixture(t, {
    assignmentCount: () => assigned,
    subscriptionReady: () => subscriptionReady,
    onStarting: async (app, context) => {
      await until(() => app.server.listening);
      await sleep(25);
      assert.equal(
        app.runtimeController.phase(),
        "starting",
        "transport connection alone must not open a latest-offset delivery gap",
      );
      assigned = context.config.kafka.topics.realtimeInvalidate.partitions - 1;
      await sleep(25);
      assert.equal(
        app.runtimeController.phase(),
        "starting",
        "a partial fixed-group assignment is not launch readiness",
      );
      assigned = context.config.kafka.topics.realtimeInvalidate.partitions;
      await sleep(25);
      assert.equal(
        app.runtimeController.phase(),
        "starting",
        "assignment does not establish a usable latest-offset Fetch boundary",
      );
      subscriptionReady = true;
    },
  });
  assert.equal(f.app.runtimeController.phase(), "running");
  const stream = await f.request();
  await until(() => stream.text().includes("stream-ready.v1"));
  assert.equal(stream.res.statusCode, 200);
  assigned = 0;
  assert.equal(
    await f.composition.readinessChecks[0].check(new AbortController().signal),
    false,
    "assignment loss must make readiness red",
  );
});
const pair = generateKeyPairSync("ed25519");
const corr = "77777777-7777-4777-8777-777777777777";
const trace = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const base = {
  iss: "edge-gateway",
  originalIssuer: "edge-gateway",
  aud: "realtime-gateway",
  sub: "operator",
  permissions: ["orders:read:any"],
  operationId: "streamOrderInvalidations",
  correlationId: corr,
  traceparent: trace,
  iat: 100,
  exp: 160,
  jti: "synthetic",
  kid: "synthetic",
};
void test("retained signed actor expires at configured auth check; reconnect needs a fresh signed context", async () => {
  let clock = 110;
  const verify = gateway.createRealtimeActorVerifier(
    [pair.publicKey],
    () => clock,
  );
  const token = signActorContext(base, pair.privateKey);
  const claims = verify(token, corr, trace);
  assert.equal(
    isActorContextTimeValid(claims, 94, 5),
    false,
    "iat beyond the five-second future skew is not yet valid",
  );
  assert.equal(isActorContextTimeValid(claims, 95, 5), true);
  assert.equal(
    isActorContextTimeValid(claims, 164, 5),
    true,
    "exp remains valid through the last second inside the five-second skew",
  );
  assert.equal(isActorContextTimeValid(claims, 165, 5), false);
  const hub = new gateway.RealtimeHub({ ...config, authCheckMs: 5 });
  const sink = new Sink();
  hub.open(sink, {
    signal: new AbortController().signal,
    validateActor: () => isActorContextTimeValid(claims, clock, 5),
  });
  await turn();
  clock = 165;
  await sleep(15);
  assert.equal(sink.destroyed, true);
  assert.equal(hub.stats().connections, 0);
  assert.equal(hub.stats().queuedBytes, 0);
  assert.equal(hub.stats().authCloses, 1);
  assert.ok(hub.metrics().includes("coffee_realtime_auth_close_total 1"));
  assert.equal(
    hub.stats().slowCloses,
    0,
    "signed actor expiry is not pressure closure",
  );
  clock = 166;
  const renewed = signActorContext(
    { ...base, iat: 166, exp: 226 },
    pair.privateKey,
  );
  const renewedClaims = verify(renewed, corr, trace);
  const next = new Sink();
  hub.open(next, {
    signal: new AbortController().signal,
    validateActor: () => isActorContextTimeValid(renewedClaims, clock, 5),
  });
  await turn();
  assert.match(next.frames[0], /^event: stream-ready.v1/);
  await hub.shutdown();
});
void test("real mTLS SSE closes after retained actor expiry and rejects a forged reconnect before SSE", async (t) => {
  const f = await realtimeFixture(t, { authCheckMs: 10 });
  const now = Math.floor(Date.now() / 1000);
  const headers = f.headers({ iat: now - 60, exp: now - 3 });
  const stream = await f.request({ headers });
  assert.equal(stream.res.statusCode, 200);
  await until(() => stream.text().includes("stream-ready.v1"));
  assert.equal(f.composition.hub().stats().connections, 1);
  await until(
    () =>
      f.composition.hub().stats().authCloses === 1 &&
      f.composition.hub().stats().connections === 0,
    3000,
  );
  assert.equal(
    f.composition.hub().stats().queuedBytes,
    0,
    "expired SSE cleanup releases its queue",
  );
  await until(() => stream.res.destroyed && stream.req.socket?.destroyed, 1000);
  const forged = await f.request({
    headers: f.headers({}, generateKeyPairSync("ed25519").privateKey),
  });
  await until(() => forged.res.complete);
  assert.equal(forged.res.statusCode, 403);
  assert.equal(JSON.parse(forged.text()).code, "ACTOR_CONTEXT_INVALID");
  assert.doesNotMatch(forged.text(), /stream-ready|event-stream/);
  assert.equal(f.composition.hub().stats().connections, 0);
});
void test("crypto receiver binds issuer/audience/operation/permission/correlation/trace, not a trusted boolean", () => {
  assert.equal(typeof gateway.createRealtimeActorVerifier, "function");
  const verify = gateway.createRealtimeActorVerifier(
    [pair.publicKey],
    () => 110,
  );
  const token = signActorContext(base, pair.privateKey);
  assert.equal(verify(token, corr, trace).sub, "operator");
  const noTrace = "00-00000000000000000000000000000000-0000000000000000-00";
  const untraced = signActorContext(
    { ...base, traceparent: noTrace },
    pair.privateKey,
  );
  assert.equal(verify(untraced, corr, undefined).sub, "operator");
  assert.throws(() => verify(token, corr, undefined));
  assert.throws(() => verify(untraced, corr, noTrace));
  for (const change of [
    { aud: "api-public" },
    { iss: "api-public" },
    { operationId: "getOrderCard" },
    { permissions: [] },
    { correlationId: "88888888-8888-4888-8888-888888888888" },
    { traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01" },
    { exp: 161 },
    { iat: 120, exp: 160 },
    { exp: 100, iat: 50 },
  ])
    assert.throws(() =>
      verify(
        signActorContext({ ...base, ...change }, pair.privateKey),
        corr,
        trace,
      ),
    );
});
