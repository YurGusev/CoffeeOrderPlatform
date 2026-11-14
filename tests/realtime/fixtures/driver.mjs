import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { json as publishJson } from "./setup.mjs";
import { readFile, appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  fixture,
  login,
  request,
  until,
  openStream,
  nativeProducer,
  envelopeValidator,
  wireValidator,
} from "./transport.mjs";
import {
  nowMs,
  isoNow,
  isoAt,
  Histogram,
  THRESHOLDS,
  ulid,
  parseMetrics,
  metric,
  classifyResult,
  SSE_RETRY_MS,
  SSE_READY_TIMEOUT_MS,
  OIDC_SESSION_LOGIN_INTERVAL_MS,
} from "./protocol.mjs";

const out = fixture.resultDir;
const result = {
  schema: "coffee.realtime.transport-soak-result/v1",
  mode: fixture.mode,
  profile: fixture.profile,
  requestedDurationMs: fixture.durationMs,
  durationMs: 0,
  clients: fixture.clients,
  rate: fixture.rate,
  subjects: fixture.subjects,
  published: 0,
  minLive: 0,
  maxLive: 0,
  disconnects: 0,
  reconnects: 0,
  protocolFrames: 0,
  coverageChecks: 0,
  eventLatencyP95Ms: null,
  eventLoopP95Ms: null,
  checks: {},
  cleanupVerified: false,
  transport: {
    tls: true,
    saslSsl: true,
    realAuthorizer: true,
    realComposition: true,
  },
  checkDetails: {},
  error: null,
};
const workers = [],
  allStreams = [];
let producer,
  shutdown = false,
  successfulShutdown = false,
  forcedClientClose = false,
  fatal,
  sequence = 0,
  headroomErrors = 0,
  shutdownWorkerErrors = 0;
const driverLoop = monitorEventLoopDelay({ resolution: 10 });
driverLoop.enable();
const sourceEnvelope = JSON.parse(
  await readFile(
    new URL(
      "../../../contracts/fixtures/positive/events/realtime-invalidated.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const validEnvelope = await envelopeValidator();
const refs = Array.from(
  { length: fixture.subjects },
  (_, i) => `ord_${ulid(1700000000000, BigInt(i + 1))}`,
);
const expected = new Int32Array(fixture.subjects),
  counts = new Int32Array(new SharedArrayBuffer(fixture.shards * 4));
const stats = new Map(),
  readies = new Map(),
  covered = new Map(),
  started = new Set(),
  stopped = new Set(),
  shutdownArmed = new Map(),
  shutdownReceipts = new Map();
const json = async (name, value) => publishJson(`${out}/${name}`, value);
const record = async (name, value) =>
  appendFile(
    `${out}/${name}`,
    JSON.stringify({ ...value, at: isoNow() }) + "\n",
  );
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
async function control(action) {
  const id = randomUUID();
  await json("control-request.json", { id, action });
  return await until(
    async () => {
      try {
        const r = JSON.parse(
          await readFile(`${out}/control-response.json`, "utf8"),
        );
        if (r.id !== id) return false;
        assert.equal(r.ok, true, r.error ?? `host control ${action} failed`);
        return r;
      } catch (e) {
        if (e.code === "ENOENT") return false;
        throw e;
      }
    },
    { timeout: THRESHOLDS.shutdownMs + 5000, label: `host ${action}` },
  );
}
async function publish(subject = refs[0], version = ++sequence) {
  const now = nowMs(),
    e = structuredClone(sourceEnvelope);
  e.messageId = `msg_${ulid(now, BigInt(version))}`;
  e.occurredAt = isoAt(now);
  e.aggregate.ref = e.payload.subjectRef = subject;
  e.aggregate.version = e.payload.ownerVersion = String(version);
  e.correlationId = randomUUID();
  validEnvelope(e);
  const ack = await producer.send(
    "coffee.realtime.invalidate.v1",
    subject,
    JSON.stringify(e),
    {
      messageId: e.messageId,
      messageType: e.messageType,
      correlationId: e.correlationId,
      traceparent: e.traceparent,
    },
    AbortSignal.timeout(5000),
  );
  assert.equal(ack.topic, "coffee.realtime.invalidate.v1");
  assert.ok(/^(0|[1-9][0-9]*)$/u.test(ack.offset));
  return e;
}
async function gatewayMetrics() {
  const r = await request(
    "realtime-gateway",
    fixture.config.services["realtime-gateway"].listen.port,
    "/metrics",
  );
  assert.equal(r.status, 200);
  const samples = parseMetrics(r.body);
  await record("gateway-metrics.jsonl", { samples });
  return samples;
}
const connectionMetric = (rows) =>
  metric(rows, /^coffee_realtime_connections$/u, "active connections");
const authCloseMetric = (rows) =>
  metric(
    rows,
    /^coffee_realtime_auth_close_total$/u,
    "actual retained-actor auth closures",
  );
const recoveryBudget = SSE_RETRY_MS + SSE_READY_TIMEOUT_MS;
const loopMetric = (rows) => {
  assert.ok(
    metric(
      rows,
      /^coffee_realtime_event_loop_delay_samples$/u,
      "actual event-loop samples",
    ).value > 0,
  );
  return metric(
    rows,
    /^coffee_realtime_event_loop_delay_p95_ms$/u,
    "gateway event-loop p95 milliseconds",
  );
};
async function directHealth(host) {
  const r = await request(
    host,
    fixture.config.services[host].listen.port,
    "/health/ready",
    { timeout: 1000 },
  );
  assert.equal(r.status, 200, `${host} reserved health headroom`);
  return r;
}
async function headroom(cookie) {
  const tasks = Array.from({ length: 8 }, (_, n) =>
    (async () => {
      const start = performance.now();
      const kind = n % 4;
      let r;
      if (kind === 0) {
        r = await request("edge-nginx", 8443, "/auth/session", {
          cookie,
          timeout: 1000,
        });
        assert.equal(r.status, 200);
      }
      if (kind === 1) {
        r = await request(
          "edge-nginx",
          8443,
          `/api/client-v1/orders/${refs[0]}`,
          { cookie, timeout: 1000 },
        );
        assert.equal(
          r.status,
          404,
          "actual API delegation -> synthetic mTLS owner typed miss",
        );
        const p = JSON.parse(r.body);
        assert.equal(p.code, "ORDER_NOT_FOUND");
        assert.equal(p.status, 404);
        assert.ok(
          r.headers["content-type"].startsWith("application/problem+json"),
        );
      }
      if (kind === 2) {
        r = await request("edge-nginx", 8443, "/health/live", {
          timeout: 1000,
        });
        assert.equal(r.status, 200);
      }
      if (kind === 3) {
        r = await directHealth("realtime-gateway");
      }
      const observed = {
        kind,
        latencyMs: performance.now() - start,
        status: r.status,
        transportMs: r.timings,
        driverLoopP95Ms: driverLoop.percentile(95) / 1e6,
        driverLoopMaxMs: driverLoop.max / 1e6,
      };
      if (observed.latencyMs > THRESHOLDS.headroomMs) {
        await record("samples.jsonl", {
          phase: "headroom-failure",
          ...observed,
        });
        throw failure(
          "HEADROOM_LATENCY_EXCEEDED",
          `headroom kind=${kind} latencyMs=${observed.latencyMs}>${THRESHOLDS.headroomMs}`,
        );
      }
      return observed;
    })(),
  );
  return await Promise.all(tasks);
}
async function admissionPrephase(cookie) {
  const limit = fixture.config.nginxTransport.limits.sseAdmissionConnections,
    streams = [];
  assert.equal(limit, 512, "reference admission ceiling must remain512");
  let receipt;
  try {
    for (let offset = 0; offset < limit; offset += 16) {
      const batch = [];
      for (let n = offset; n < Math.min(offset + 16, limit); n++) {
        const stream = openStream(cookie);
        streams.push(stream);
        batch.push(stream.ready);
      }
      await Promise.all(batch);
    }
    const ids = streams.map((stream) => stream.connectionId);
    assert.equal(
      new Set(ids).size,
      limit,
      "boundary cohort has512 distinct live connections",
    );
    assert.equal(
      connectionMetric(await gatewayMetrics()).value,
      limit,
      "all512 boundary streams are simultaneously live",
    );
    const rejected = openStream(cookie);
    streams.push(rejected);
    await assert.rejects(rejected.ready, (error) => {
      assert.equal(error.status, 503);
      assert.ok(
        error.headers["content-type"].startsWith("application/problem+json"),
      );
      assert.ok(!error.headers["content-type"].startsWith("text/event-stream"));
      assert.equal(JSON.parse(error.body).code, "REALTIME_CAPACITY_EXCEEDED");
      return true;
    });
    await until(() => rejected.response.destroyed, {
      timeout: THRESHOLDS.cleanupMs,
      label: "513th preheader rejection transport cleanup",
    });
    await rejected.closed;
    assert.equal(
      connectionMetric(await gatewayMetrics()).value,
      limit,
      "rejected stream does not replace a live boundary stream",
    );
    receipt = {
      live: limit,
      uniqueConnectionIds: new Set(ids).size,
      rejectedConnection: limit + 1,
      status: 503,
      code: "REALTIME_CAPACITY_EXCEEDED",
      beforeSseHeaders: true,
      establishedAt: isoNow(),
    };
  } finally {
    for (const stream of streams) stream.close();
    await Promise.all(streams.map((stream) => stream.closed));
    await until(
      async () => connectionMetric(await gatewayMetrics()).value === 0,
      {
        timeout: THRESHOLDS.cleanupMs,
        label: "separate admission cohort cleanup before measurement",
      },
    );
  }
  result.checkDetails.admission = { ...receipt, cleanupVerified: true };
  result.checks.admission = true;
}
async function preflight() {
  await until(
    async () => {
      for (const service of ["edge-gateway", "api-public", "realtime-gateway"])
        await directHealth(service);
      return true;
    },
    { timeout: 45000, label: "actual scoped composition readiness" },
  );
  wireValidator();
  const cookie = await login();
  const heartbeatProbe = openStream(cookie, { onFrame: () => {} });
  allStreams.push(heartbeatProbe);
  await heartbeatProbe.ready;
  const first = await publish();
  await until(() => heartbeatProbe.lastFrame?.id === first.messageId, {
    timeout: 1000,
    label: "first broker -> actual SSE hint",
  });
  const firstId = first.messageId;
  heartbeatProbe.close();
  await heartbeatProbe.closed;
  const next = await publish(refs[0]);
  const frames = [];
  const retained = openStream(cookie, {
    lastEventId: firstId,
    onFrame: (f) => frames.push(f),
  });
  allStreams.push(retained);
  await retained.ready;
  await until(() => frames.some((f) => f.id === next.messageId), {
    timeout: 1000,
    label: "real retained Last-Event-ID replay",
  });
  result.checks.replay = true;
  result.reconnects++;
  const resetFrames = [];
  const reset = openStream(cookie, {
    lastEventId: `msg_${ulid(1700000000000, 900000n)}`,
    onFrame: (f) => resetFrames.push(f),
  });
  allStreams.push(reset);
  await reset.ready;
  await until(() => resetFrames.some((f) => f.event === "stream-reset.v1"), {
    timeout: 1000,
    label: "unknown Last-Event-ID reset",
  });
  result.checks.reset = true;
  reset.close();
  await reset.closed;
  retained.close();
  await retained.closed;
  const slow = openStream(cookie, { onFrame: () => {} });
  allStreams.push(slow);
  await slow.ready;
  slow.response.pause();
  const before = await gatewayMetrics();
  const pressure = (rows) =>
    metric(
      rows,
      /^coffee_realtime_slow_close_total$/u,
      "queue/write-pressure disconnects",
    ).value;
  const burstStart = nowMs(),
    count =
      fixture.config.services["realtime-gateway"].realtime.ringMaxRecords * 2;
  for (let n = 0; n < count; n += 100) {
    const batch = [];
    for (let j = n; j < Math.min(n + 100, count); j++)
      batch.push(publish(`ord_${ulid(1700000000001, BigInt(j + 1))}`));
    await Promise.all(batch);
  }
  const lastBurst = nowMs();
  await record("slow-burst.jsonl", {
    count,
    acknowledged: true,
    durationMs: lastBurst - burstStart,
  });
  const after = await until(
    async () => {
      const m = await gatewayMetrics();
      return pressure(m) > pressure(before) ? m : false;
    },
    {
      timeout: THRESHOLDS.slowDisconnectMs,
      label:
        "causal slow-reader queue/write pressure disconnect (not auth expiry)",
    },
  );
  slow.response.resume();
  await until(() => slow.response.destroyed, {
    timeout: THRESHOLDS.slowDisconnectMs,
    label: "real slow-reader TLS close",
  });
  result.checks.slow = true;
  result.checkDetails.slow = {
    burstPublished: count,
    burstMs: lastBurst - burstStart,
    disconnectObservedMs: nowMs() - lastBurst,
    pressureCounters: after.filter((r) =>
      /realtime_.*(?:disconnect|close)/u.test(r.name),
    ),
  };
  const evictedFrames = [];
  const evicted = openStream(await login(), {
    lastEventId: firstId,
    onFrame: (f) => evictedFrames.push(f),
  });
  allStreams.push(evicted);
  await evicted.ready;
  await until(() => evictedFrames.some((f) => f.event === "stream-reset.v1"), {
    timeout: 1000,
    label: "actual ring eviction reset",
  });
  result.checks.evicted = true;
  evicted.close();
  await evicted.closed;
  await until(
    async () => connectionMetric(await gatewayMetrics()).value === 0,
    { timeout: THRESHOLDS.cleanupMs, label: "prephase session/socket cleanup" },
  );
  await admissionPrephase(cookie);
  await record("protocol.jsonl", {
    phase: "preflight",
    first: { id: firstId, event: "resource-invalidated.v1" },
    replay: frames,
    unknownReset: resetFrames,
    evictedReset: evictedFrames,
  });
  result.reconnects = 0; // prephase reconnect is recorded separately from main cohort re-auth
  return await login();
}
async function measurement(cookie) {
  const readyStart = nowMs();
  for (let shard = 0; shard < fixture.shards; shard++) {
    const count =
      Math.floor(fixture.clients / fixture.shards) +
      (shard < fixture.clients % fixture.shards ? 1 : 0);
    const clientOffset =
      Math.floor(fixture.clients / fixture.shards) * shard +
      Math.min(shard, fixture.clients % fixture.shards);
    const worker = new Worker(new URL("./clients.mjs", import.meta.url), {
      workerData: {
        index: shard,
        count,
        clientOffset,
        cookie,
        liveBuffer: counts.buffer,
        subjectRefs: refs,
      },
    });
    workers.push(worker);
    worker.on("message", (m) => {
      if (m.type === "fatal") fatal = failure(m.code, m.message);
      if (m.type === "ready") readies.set(shard, m);
      if (m.type === "started") started.add(shard);
      if (m.type === "coverage") {
        const set = covered.get(m.checkpoint) ?? new Set();
        set.add(shard);
        covered.set(m.checkpoint, set);
      }
      if (m.type === "stats") stats.set(shard, m);
      if (m.type === "latency-diagnostic") {
        void record("latency-diagnostic.jsonl", m).catch((e) => {
          fatal = e;
        });
      }
      if (m.type === "reauth" || m.type === "reauth-retry") {
        void record("reauth.jsonl", m).catch((e) => {
          fatal = e;
        });
      }
      if (m.type === "stopped") stopped.add(shard);
      if (m.type === "shutdown-armed") shutdownArmed.set(shard, m);
      if (m.type === "shutdown-closed") shutdownReceipts.set(shard, m);
    });
    worker.on("error", (e) => {
      shutdownWorkerErrors++;
      fatal = failure("CLIENT_SHARD_FAILED", e.message);
    });
    worker.on("exit", (code) => {
      if (shutdown && !shutdownReceipts.has(shard)) {
        shutdownWorkerErrors++;
        fatal = failure(
          "CLIENT_SHARD_EXIT",
          `client worker ${shard} exited ${code} before its shutdown receipt`,
        );
      } else if (!shutdown && code !== 0) {
        shutdownWorkerErrors++;
        fatal = failure(
          "CLIENT_SHARD_EXIT",
          `client worker ${shard} exited ${code}`,
        );
      }
    });
  }
  await until(
    () => {
      if (fatal) throw fatal;
      return readies.size === fixture.shards;
    },
    { timeout: 45000, label: "all simultaneously live TLS SSE streams" },
  );
  const ids = [...readies.values()].flatMap((r) => r.connectionIds);
  assert.equal(ids.length, fixture.clients);
  assert.equal(new Set(ids).size, fixture.clients);
  assert.equal(
    counts.reduce((a, b) => a + b, 0),
    fixture.clients,
  );
  assert.equal(connectionMetric(await gatewayMetrics()).value, fixture.clients);
  result.checkDetails.capacity = {
    live: fixture.clients,
    uniqueConnectionIds: new Set(ids).size,
    establishedAt: isoNow(),
  };

  for (const w of workers) w.postMessage({ type: "start" });
  await until(() => started.size === fixture.shards, {
    timeout: 3000,
    label: "measurement workers armed",
  });
  const beforeMain = await gatewayMetrics(),
    authBefore = authCloseMetric(beforeMain).value;
  const slowBefore = metric(
    beforeMain,
    /^coffee_realtime_slow_close_total$/u,
    "pressure closures before main cohort",
  ).value;
  const start = performance.now(),
    wallStart = nowMs();
  result.minLive = result.maxLive = fixture.clients;
  result.measurementStartedAt = isoAt(wallStart);
  result.establishmentMs = nowMs() - readyStart;
  let sent = 0,
    nextSample = 0,
    reloaded = false,
    reloadRunning = false,
    checkpoint = 0,
    sampleRunning = false;
  // Граница очереди ACK измеряет устойчивую пропускную способность, а не
  // дрожание планировщика: не меньше двух секунд публикации на текущем темпе.
  const maxPendingPublishes = Math.max(100, fixture.rate * 2);
  const secondCounts = new Map(),
    pendingPublishes = new Set();
  let peakPendingPublishes = 0;
  let nextLogin = OIDC_SESSION_LOGIN_INTERVAL_MS,
    loginRunning = false,
    sessionRefreshes = 0;
  async function sample() {
    if (sampleRunning) return;
    sampleRunning = true;
    try {
      const rows = await gatewayMetrics();
      assert.ok(
        connectionMetric(rows).value <= fixture.clients,
        "actual receiver exceeded capacity cohort",
      );
      assert.equal(
        metric(
          rows,
          /^coffee_realtime_slow_close_total$/u,
          "main pressure closures",
        ).value,
        slowBefore,
        "healthy cohort had a queue/write-pressure close",
      );
      const loop = loopMetric(rows);
      result.eventLoopP95Ms = Math.max(result.eventLoopP95Ms ?? 0, loop.value);
      assert.ok(
        loop.value <= THRESHOLDS.eventLoopP95Ms,
        "gateway event-loop p95 >100ms",
      );
      const head = await headroom(cookie);
      result.checkDetails.headroomSamples =
        (result.checkDetails.headroomSamples ?? 0) + head.length;
      await record("samples.jsonl", {
        phase: "measurement",
        elapsedMs: performance.now() - start,
        live: counts.reduce((a, b) => a + b, 0),
        gatewayLoopP95: loop,
        gatewayMetrics: rows,
        headroom: head,
        acked: result.published,
      });
      for (const w of workers) w.postMessage({ type: "stats" });
    } catch (e) {
      headroomErrors++;
      fatal = e;
    } finally {
      sampleRunning = false;
    }
  }
  while (performance.now() - start < fixture.durationMs) {
    if (fatal) throw fatal;
    const live = counts.reduce((a, b) => a + b, 0);
    result.minLive = Math.min(result.minLive, live);
    result.maxLive = Math.max(result.maxLive, live);
    assert.ok(
      live >= 0 && live <= fixture.clients,
      "actual cohort count outside capacity",
    );
    const target = start + (sent * 1000) / fixture.rate,
      delay = target - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    else
      assert.ok(
        -delay < 1000,
        "100/s publisher schedule fell >1000ms behind; no auto tuning",
      );
    assert.ok(
      pendingPublishes.size < maxPendingPublishes,
      `bounded publisher exceeded ${maxPendingPublishes} in-flight ACKs`,
    );
    const subject = Math.floor(sent / 4) % fixture.subjects,
      version = ++sequence;
    const delivery = publish(refs[subject], version)
      .then(() => {
        expected[subject] = Math.max(expected[subject], version);
        result.published++;
        const second = Math.floor((performance.now() - start) / 1000);
        secondCounts.set(second, (secondCounts.get(second) ?? 0) + 1);
      })
      .catch((e) => {
        fatal ??= e;
      })
      .finally(() => pendingPublishes.delete(delivery));
    pendingPublishes.add(delivery);
    peakPendingPublishes = Math.max(
      peakPendingPublishes,
      pendingPublishes.size,
    );
    sent++;
    const elapsed = performance.now() - start;
    result.durationMs = elapsed;
    if (elapsed >= nextLogin) {
      nextLogin += OIDC_SESSION_LOGIN_INTERVAL_MS;
      loginRunning = true;
      void login()
        .then((fresh) => {
          cookie = fresh;
          sessionRefreshes++;
          for (const w of workers) w.postMessage({ type: "session", cookie });
          return record("reauth.jsonl", {
            type: "oidc-session",
            at: isoNow(),
            elapsedMs: performance.now() - start,
            refresh: sessionRefreshes,
          });
        })
        .catch((e) => {
          fatal = e;
        })
        .finally(() => {
          loginRunning = false;
        });
    }
    if (elapsed >= nextSample) {
      nextSample += 1000;
      void sample();
    }
    if (sent % fixture.rate === 0) {
      checkpoint++;
      covered.set(checkpoint, new Set());
      const checkpointIssuedAt = nowMs();
      for (const w of workers)
        w.postMessage({
          type: "checkpoint",
          checkpoint,
          expected: Array.from(expected),
          checkpointIssuedAt,
          checkAt: checkpointIssuedAt + 1000,
          deadlineAt:
            checkpointIssuedAt + recoveryBudget + THRESHOLDS.eventLatencyP95Ms,
        });
    }
    if (!reloaded && elapsed >= fixture.durationMs / 2) {
      reloaded = true;
      reloadRunning = true;
      const before = counts.reduce((a, b) => a + b, 0);
      void control("reload")
        .then((receipt) => {
          result.checkDetails.reload = {
            ...receipt,
            liveBefore: before,
            liveAfter: counts.reduce((a, b) => a + b, 0),
          };
          result.checks.reload = true;
        })
        .catch((e) => {
          fatal = e;
        })
        .finally(() => {
          reloadRunning = false;
        });
    }
  }
  // Окно измерения закрывается условием цикла, поэтому последняя записанная
  // длительность может оказаться на доли миллисекунды меньше целевой.
  result.durationMs = Math.max(result.durationMs, performance.now() - start);
  await until(
    () =>
      !sampleRunning &&
      !loginRunning &&
      !reloadRunning &&
      pendingPublishes.size === 0,
    {
      timeout: THRESHOLDS.shutdownMs + 5000,
      label:
        "all scheduled broker ACKs, headroom, actual reload and OIDC session login finished",
    },
  );
  if (fatal) throw fatal;
  assert.equal(
    result.published,
    sent,
    "every scheduled publication must have a broker ACK",
  );
  result.checkDetails.publisher = {
    scheduled: sent,
    acked: result.published,
    pending: pendingPublishes.size,
    peakPending: peakPendingPublishes,
    maxPending: maxPendingPublishes,
  };
  checkpoint++;
  covered.set(checkpoint, new Set());
  const checkpointIssuedAt = nowMs();
  for (const w of workers)
    w.postMessage({
      type: "checkpoint",
      checkpoint,
      expected: Array.from(expected),
      checkpointIssuedAt,
      checkAt: checkpointIssuedAt + 1000,
      deadlineAt:
        checkpointIssuedAt + recoveryBudget + THRESHOLDS.eventLatencyP95Ms,
    });
  await until(
    () => {
      if (fatal) throw fatal;
      return (
        covered.size === checkpoint &&
        [...covered.values()].every((set) => set.size === fixture.shards)
      );
    },
    {
      timeout: recoveryBudget + THRESHOLDS.eventLatencyP95Ms,
      label:
        "every subject/client checkpoint expected maximum ownerVersion including re-auth replay",
    },
  );
  for (const [id, set] of covered)
    assert.equal(
      set.size,
      fixture.shards,
      `coverage checkpoint ${id} missing clients`,
    );
  const afterMain = await until(
    async () => {
      if (fatal) throw fatal;
      stats.clear();
      for (const w of workers) w.postMessage({ type: "stats" });
      await until(() => stats.size === fixture.shards, {
        timeout: 2000,
        label: "actual worker metrics",
      });
      const rows = await gatewayMetrics(),
        closed = [...stats.values()].reduce((n, s) => n + s.disconnects, 0);
      return [...stats.values()].every((s) => s.pending === 0) &&
        counts.reduce((a, b) => a + b, 0) === fixture.clients &&
        connectionMetric(rows).value === fixture.clients &&
        authCloseMetric(rows).value - authBefore === closed
        ? rows
        : false;
    },
    {
      timeout: recoveryBudget,
      label: "consistent recovered cohort and causal auth-close counters",
    },
  );
  const histogram = new Histogram(),
    gapHistogram = new Histogram(recoveryBudget);
  let recoveredClients = 0,
    pending = 0,
    unexpectedDisconnects = 0;
  for (const s of stats.values()) {
    histogram.merge(s.histogram);
    gapHistogram.merge(s.gaps);
    result.coverageChecks += s.coverageChecks;
    result.protocolFrames += s.frames;
    result.disconnects += s.disconnects;
    result.reconnects += s.reconnects;
    recoveredClients += s.recoveredClients;
    pending += s.pending;
    unexpectedDisconnects += s.unexpectedDisconnects;
  }
  result.checkDetails.reauth = {
    recoveredClients,
    samples: gapHistogram.count,
    unexpectedDisconnects,
    pending,
    authCloseDelta: authCloseMetric(afterMain).value - authBefore,
    finalLive: connectionMetric(afterMain).value,
    maxGapMs: gapHistogram.max,
    gapP95Ms: gapHistogram.p95(),
    retryMs: SSE_RETRY_MS,
    readyTimeoutMs: SSE_READY_TIMEOUT_MS,
    sessionRefreshes,
    sessionRefreshIntervalMs: OIDC_SESSION_LOGIN_INTERVAL_MS,
    rawMinLive: result.minLive,
    rawMaxLive: result.maxLive,
  };
  result.checks.reauth =
    recoveredClients === fixture.clients &&
    result.disconnects === result.reconnects &&
    gapHistogram.count === result.reconnects &&
    unexpectedDisconnects === 0 &&
    pending === 0 &&
    gapHistogram.max <= recoveryBudget;
  result.eventLatencyP95Ms = histogram.p95();
  result.checkDetails.eventLatency = histogram.json();
  result.checkDetails.publisherSeconds = Object.fromEntries(secondCounts);
  result.checkDetails.expectedMaximum = Object.fromEntries(
    refs.map((ref, i) => [ref, String(expected[i])]),
  );
  result.checks.headroom =
    headroomErrors === 0 && (result.checkDetails.headroomSamples ?? 0) > 0;
  await json(
    "worker-results.json",
    [...stats.values()].map(({ histogram, ...rest }) => ({
      ...rest,
      latency: { count: histogram.count, maxMs: histogram.max },
    })),
  );
  for (const s of stats.values())
    await record("protocol.jsonl", {
      phase: "measurement",
      shard: s.shard,
      frames: s.firstFrames,
    });
  if (fatal) throw fatal;
  const cleanupStart = performance.now();
  shutdown = true;
  for (const w of workers) w.postMessage({ type: "shutdown-arm" });
  await until(
    () => {
      if (fatal) throw fatal;
      return shutdownArmed.size === workers.length;
    },
    {
      timeout: THRESHOLDS.cleanupMs,
      label: "all loaded TLS client shards armed for server-side shutdown",
    },
  );
  const armed = [...shutdownArmed.values()],
    armedClients = armed.reduce((n, m) => n + m.clients, 0),
    armedLive = armed.reduce((n, m) => n + m.live, 0),
    liveBefore = counts.reduce((a, b) => a + b, 0);
  const gatewayLiveBefore = connectionMetric(await gatewayMetrics()).value;
  assert.equal(
    armedClients,
    fixture.clients,
    "shutdown arm covers every fixture client",
  );
  assert.equal(
    armedLive,
    fixture.clients,
    "every client remains live after shutdown arm",
  );
  assert.equal(
    liveBefore,
    fixture.clients,
    "shared client population remains live before SIGTERM",
  );
  assert.equal(
    gatewayLiveBefore,
    fixture.clients,
    "gateway reports the loaded cohort immediately before SIGTERM",
  );
  const hostReceipt = await control("shutdown");
  assert.ok(hostReceipt.elapsedMs <= THRESHOLDS.shutdownMs);
  await until(
    () => {
      if (fatal) throw fatal;
      return shutdownReceipts.size === workers.length;
    },
    {
      timeout: THRESHOLDS.cleanupMs,
      label: "all live client streams closed by gateway shutdown",
    },
  );
  const shards = [...shutdownReceipts.values()],
    clientReceipts = shards.flatMap((m) => m.receipts ?? []),
    clientIds = clientReceipts.map((r) => r.client);
  assert.equal(
    shards.reduce((n, m) => n + m.clients, 0),
    fixture.clients,
    "every worker reports its server-closed streams",
  );
  assert.equal(
    shards.reduce((n, m) => n + m.live, 0),
    0,
    "all actual client handles release after server close",
  );
  assert.equal(clientReceipts.length, fixture.clients);
  assert.equal(new Set(clientIds).size, fixture.clients);
  for (const receipt of clientReceipts) {
    const resetAt = Date.parse(receipt.resetAt),
      serverClosedAt = Date.parse(receipt.serverClosedAt);
    assert.ok(
      Number.isFinite(resetAt) &&
        Number.isFinite(serverClosedAt) &&
        serverClosedAt >= resetAt,
    );
    assert.equal(receipt.elapsedMs, serverClosedAt - resetAt);
    assert.ok(receipt.elapsedMs <= THRESHOLDS.cleanupMs);
    assert.ok(receipt.connectionId);
  }
  result.checkDetails.cleanupMs = performance.now() - cleanupStart;
  assert.ok(result.checkDetails.cleanupMs <= THRESHOLDS.cleanupMs);
  result.checks.cleanup = true;
  result.checkDetails.shutdown = {
    ...hostReceipt,
    clients: fixture.clients,
    liveBefore,
    gatewayLiveBefore,
    armedClients,
    armedLive,
    closedClients: clientReceipts.length,
    workerErrors: shutdownWorkerErrors,
    timedOut: false,
    forcedClientClose: false,
    clientReceipts,
    shardReceipts: shards.map((receipt) => ({
      shard: receipt.shard,
      clients: receipt.clients,
      live: receipt.live,
    })),
  };
  result.checks.shutdown = true;
  successfulShutdown = true;
}
try {
  producer = await nativeProducer();
  await measurement(await preflight());
} catch (e) {
  result.error = {
    code: e.code ?? "TRANSPORT_PROOF_FAILED",
    message: e.message,
  };
  await record("samples.jsonl", {
    phase: "failure",
    error: result.error,
    live: counts.reduce((a, b) => a + b, 0),
  });
} finally {
  shutdown = true;
  driverLoop.disable();
  for (const s of allStreams) s.close();
  if (!successfulShutdown && workers.length) {
    forcedClientClose = true;
    for (const w of workers) {
      if (w.threadId !== -1) {
        w.postMessage({ type: "stop" });
        await w.terminate().catch(() => {});
      }
    }
  }
  if (result.checkDetails.shutdown)
    result.checkDetails.shutdown.forcedClientClose = forcedClientClose;
  await producer?.close().catch((e) => {
    result.error ??= { code: "PUBLISHER_CLEANUP_FAILED", message: e.message };
  });
  if (result.status !== "fixture-transport-only-not-launch-proof")
    Object.assign(result, classifyResult(result));
  await json("driver-result.json", result);
  console.log(
    JSON.stringify({
      status: result.status,
      launchProof: false,
      artifact: "/results/driver-result.json",
      error: result.error,
    }),
  );
  process.exitCode = result.error ? 1 : 0;
}
