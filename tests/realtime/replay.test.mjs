import assert from "node:assert/strict";
import test from "node:test";
import {
  RealtimeHub,
  invalidationFrame,
} from "../../apps/realtime-gateway/dist/index.js";
import {
  config,
  envelope,
  record,
  Sink,
  turn,
  sleep,
  until,
} from "./helpers.mjs";
const options = (extra = {}) => ({
  signal: new AbortController().signal,
  validateActor: () => true,
  ...extra,
});
const publish = (hub, e) =>
  hub.binding.enqueue(
    hub.binding.decode(e, record(e)),
    new AbortController().signal,
  );
const ids = (sink) =>
  sink.frames.flatMap((text) =>
    [...text.matchAll(/^id: (.+)$/gm)].map((match) => match[1]),
  );
const unsuperseded = (n) =>
  envelope(n, String(n), `ord_${String(n).padStart(26, "0")}`);
void test("replay coalesces only within live windows and preserves raw cursor lookup and selected order", async (t) => {
  const hub = new RealtimeHub({ ...config, coalesceMs: 5 });
  t.after(() => hub.destroy());
  const a = "ord_" + String(1).padStart(26, "0"),
    b = "ord_" + String(2).padStart(26, "0");
  await publish(hub, envelope(1, "1", b));
  for (const [n, subject] of [
    [2, a],
    [3, b],
    [4, a],
  ])
    await publish(hub, envelope(n, String(n), subject));
  await sleep(15);
  for (const [n, subject] of [
    [5, a],
    [6, b],
    [7, a],
  ])
    await publish(hub, envelope(n, String(n), subject));
  await sleep(15);
  for (const n of [8, 9]) await publish(hub, envelope(n, String(n), a));
  for (const cursor of [1, 2]) {
    const sink = new Sink();
    hub.open(sink, options({ lastEventId: envelope(cursor).messageId }));
    await until(
      () =>
        sink.frames.some((f) => f.includes("event: stream-ready.v1")) &&
        hub.stats().queuedRecords === 0,
    );
    assert.deepEqual(
      ids(sink),
      [3, 4, 6, 7, 9].map((n) => envelope(n).messageId),
    );
    assert.match(sink.frames.at(-1), /^event: stream-ready.v1/);
    assert.ok(!sink.frames.some((f) => f.includes("stream-reset.v1")));
  }
  assert.equal(hub.stats().ringRecords, 9);
  assert.equal(hub.stats().dedupEntries, 9);
  assert.equal(hub.stats().queuedRecords, 0);
  assert.equal(hub.stats().queuedBytes, 0);
});
void test("large retained replay yields to unrelated I/O without dropping IDs or moving ready", async (t) => {
  const hub = new RealtimeHub(config);
  t.after(() => hub.destroy());
  for (let n = 1; n <= 200; n++) await publish(hub, unsuperseded(n));
  const sink = new Sink();
  let observed;
  const write = sink.write.bind(sink);
  sink.write = (text, callback) => {
    if (observed === undefined && sink.frames.length === 0)
      setImmediate(() => {
        observed = ids(sink).length;
      });
    return write(text, callback);
  };
  hub.open(sink, options({ lastEventId: envelope(1).messageId }));
  await until(() => observed !== undefined);
  assert.ok(
    observed > 0 && observed <= 64,
    `an unrelated I/O turn must run before all 199 replay records; saw ${observed}`,
  );
  await until(
    () =>
      sink.frames.some((f) => f.includes("event: stream-ready.v1")) &&
      hub.stats().queuedRecords === 0,
  );
  assert.deepEqual(
    ids(sink),
    Array.from({ length: 199 }, (_, i) => envelope(i + 2).messageId),
  );
  assert.match(sink.frames.at(-1), /^event: stream-ready.v1/);
  assert.equal(hub.stats().queuedRecords, 0);
  const cancelled = new Sink(),
    stream = hub.open(
      cancelled,
      options({ lastEventId: envelope(1).messageId }),
    );
  await turn();
  stream.close();
  const count = cancelled.frames.length;
  await turn();
  assert.equal(
    cancelled.frames.length,
    count,
    "closing during a yielded replay cancels its scheduled pump",
  );
  assert.equal(hub.stats().queuedRecords, 0);
  assert.equal(hub.stats().queuedBytes, 0);
  await hub.shutdown();
});
void test("no cursor means no replay; unknown/malformed cursor resets before ready, then live", async () => {
  const hub = new RealtimeHub({ ...config, coalesceMs: 5 });
  const e = envelope();
  await publish(hub, e);
  const sink = new Sink();
  hub.open(sink, options());
  await turn();
  assert.match(sink.frames[0], /^event: stream-ready.v1/);
  assert.equal(ids(sink).length, 0);
  const ready = JSON.parse(sink.frames[0].split("data: ")[1]);
  assert.deepEqual(Object.keys(ready), ["connectionId", "connectedAt"]);
  assert.match(ready.connectionId, /^[a-f0-9-]{36}$/);
  assert.match(ready.connectedAt, /Z$/);
  for (const cursor of ["msg_00000000000000000000009999", "bad cursor", ""]) {
    const reset = new Sink();
    hub.open(reset, options({ lastEventId: cursor }));
    await until(() =>
      reset.frames.some((f) => f.includes("event: stream-ready.v1")),
    );
    assert.match(reset.frames[0], /^event: stream-reset.v1/);
    assert.match(reset.frames[1], /^event: stream-ready.v1/);
    assert.deepEqual(JSON.parse(reset.frames[0].split("data: ")[1]), {
      reason: "REPLAY_UNAVAILABLE",
    });
    assert.equal(reset.destroyed, false);
  }
  await hub.shutdown();
  assert.equal(hub.stats().connections, 0);
  assert.equal(hub.stats().queuedBytes, 0);
});
void test("ring replay is ordered/lazy within two queue records and precedes ready", async () => {
  const hub = new RealtimeHub({ ...config, queueMaxRecords: 2 });
  for (let n = 1; n <= 20; n++) await publish(hub, unsuperseded(n));
  const sink = new Sink();
  hub.open(sink, options({ lastEventId: envelope(1).messageId }));
  await until(
    () =>
      sink.frames.some((f) => f.includes("event: stream-ready.v1")) &&
      hub.stats().queuedRecords === 0,
  );
  assert.deepEqual(
    ids(sink),
    Array.from({ length: 19 }, (_, i) => envelope(i + 2).messageId),
  );
  assert.match(sink.frames.at(-1), /^event: stream-ready.v1/);
  assert.equal(sink.destroyed, false);
  assert.equal(hub.stats().queuedRecords, 0);
  await hub.shutdown();
});
void test("retained replay uses bounded grouped writes without changing any id or replay-ready-live order", async () => {
  const hub = new RealtimeHub({ ...config, coalesceMs: 5 });
  for (let n = 1; n <= 20; n++) await publish(hub, unsuperseded(n));
  const sink = new Sink(),
    callbacks = [];
  sink.write = (text, callback) => {
    sink.frames.push(Buffer.isBuffer(text) ? text.toString("utf8") : text);
    callbacks.push(callback);
    return true;
  };
  hub.open(sink, options({ lastEventId: envelope(1).messageId }));
  await turn();
  const first = sink.frames[0],
    firstIds = [...first.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
  assert.ok(
    firstIds.length > 1 && firstIds.length < 19,
    "replay must group writes but remain lazy",
  );
  assert.deepEqual(
    firstIds,
    Array.from(
      { length: firstIds.length },
      (_, i) => envelope(i + 2).messageId,
    ),
  );
  assert.equal(
    hub.stats().queuedRecords,
    firstIds.length + 1,
    "entire in-flight batch plus ready remains accounted",
  );
  await publish(hub, envelope(21));
  await sleep(15);
  assert.equal(
    sink.frames[0],
    first,
    "reentrant live arrival cannot mutate written replay",
  );
  for (let n = 0; n < callbacks.length; n++) {
    callbacks[n]();
    await turn();
  }
  const text = sink.frames.join(""),
    allIds = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(
    allIds,
    Array.from({ length: 20 }, (_, i) => envelope(i + 2).messageId),
  );
  assert.ok(
    text.indexOf("event: stream-ready.v1") <
      text.indexOf(envelope(21).messageId),
  );
  assert.equal(hub.stats().queuedRecords, 0);
  sink.write = Sink.prototype.write.bind(sink);
  await hub.shutdown();
});
void test("live record arriving reentrantly during replay is neither lost nor duplicated after ready", async () => {
  const hub = new RealtimeHub({ ...config, coalesceMs: 5 });
  for (let n = 1; n <= 3; n++) await publish(hub, envelope(n));
  const sink = new Sink();
  const write = sink.write.bind(sink);
  let injected = false;
  sink.write = (text, callback) => {
    if (!injected) {
      injected = true;
      void publish(hub, envelope(4));
      void publish(hub, envelope(5));
    }
    return write(text, callback);
  };
  hub.open(sink, options({ lastEventId: envelope(1).messageId }));
  await until(
    () =>
      injected &&
      ids(sink).includes(envelope(5).messageId) &&
      hub.stats().queuedRecords === 0,
  );
  assert.deepEqual(
    ids(sink),
    [3, 5].map((n) => envelope(n).messageId),
  );
  const wire = sink.frames.join(""),
    ready = wire.indexOf("event: stream-ready.v1");
  assert.ok(
    wire.indexOf(envelope(3).messageId) < ready &&
      ready < wire.indexOf(envelope(5).messageId),
  );
  await hub.shutdown();
});
void test("ring record/byte/age budgets evict both dedup/version indexes; restart or eviction resets", async () => {
  const bytes = Buffer.byteLength(invalidationFrame(envelope()), "utf8");
  let now = 0;
  for (const limits of [
    { ringMaxRecords: 2 },
    { ringMaxBytes: bytes * 2 },
    { ringMaxAgeMs: 10 },
  ]) {
    const hub = new RealtimeHub({ ...config, ...limits }, () => now);
    for (let n = 1; n <= 5; n++)
      await publish(
        hub,
        envelope(n, String(n), `ord_${String(n).padStart(26, "0")}`),
      );
    if (limits.ringMaxAgeMs) now += 11;
    const s = hub.stats();
    assert.ok(s.ringRecords <= 2);
    assert.ok(s.ringBytes <= bytes * 2);
    assert.equal(s.dedupEntries, s.ringRecords);
    assert.equal(s.versionEntries, s.ringRecords);
    const sink = new Sink();
    hub.open(sink, options({ lastEventId: envelope(1).messageId }));
    await turn();
    assert.match(sink.frames[0], /^event: stream-reset.v1/);
    await hub.shutdown();
  }
  const restarted = new RealtimeHub(config);
  const sink = new Sink();
  restarted.open(sink, options({ lastEventId: envelope().messageId }));
  await turn();
  assert.match(sink.frames[0], /^event: stream-reset.v1/);
  await restarted.shutdown();
});
void test("coalescing selects highest ownerVersion with the selected messageId, bounded metadata only", async () => {
  const hub = new RealtimeHub({ ...config, coalesceMs: 5 });
  const sink = new Sink();
  hub.open(sink, options());
  await turn();
  for (let n = 1; n <= 3; n++) await publish(hub, envelope(n));
  await sleep(20);
  assert.deepEqual(ids(sink), [envelope(3).messageId]);
  assert.equal(hub.stats().ringRecords, 3);
  assert.equal(hub.stats().pendingRecords, 0);
  await hub.shutdown();
});
