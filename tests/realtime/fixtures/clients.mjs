import assert from "node:assert/strict";
import { Agent } from "node:https";
import tls from "node:tls";
import { parentPort, workerData } from "node:worker_threads";
import {
  fixture,
  openStream,
  tlsOptions,
  wireValidator,
} from "./transport.mjs";
import {
  nowMs,
  isoAt,
  Histogram,
  assertCoverage,
  ulidTime,
  SSE_RETRY_MS,
  SSE_READY_TIMEOUT_MS,
} from "./protocol.mjs";

const recoveryBudget = SSE_RETRY_MS + SSE_READY_TIMEOUT_MS;
const edgeNginxSecureContext = tls.createSecureContext(
  tlsOptions("edge-nginx"),
);
const liveHistogram = new Histogram(),
  replayHistogram = new Histogram();
const validate = wireValidator(),
  streams = [],
  seen = [],
  states = [],
  histogram = new Histogram(),
  gaps = new Histogram(recoveryBudget),
  timers = new Set();
let measuring = false,
  closed = false,
  shutdownArmed = false,
  shutdownReceipts = [],
  frames = 0,
  heartbeats = 0,
  coverageChecks = 0,
  disconnects = 0,
  reconnects = 0,
  unexpectedDisconnects = 0,
  firstFrames = [];
const counts = new Int32Array(workerData.liveBuffer);
const index = workerData.index;
const subjectIndex = new Map(workerData.subjectRefs.map((ref, i) => [ref, i]));
function later(fn, ms) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    fn();
  }, ms);
  timers.add(timer);
  timer.unref();
  return timer;
}
function clearTimers() {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}
function fatal(error, code = "HEALTHY_CLIENT_FAILURE") {
  if (closed) return;
  closed = true;
  parentPort.postMessage({
    type: "fatal",
    code,
    message: error.message,
    shard: index,
    live: Atomics.load(counts, index),
  });
  clearTimers();
  for (const stream of streams) stream.close();
  for (const state of states) state?.agent.destroy();
}
try {
  let next = 0;
  async function establish(client) {
    const state = states[client],
      versions = seen[client],
      cursor = state.lastId;
    let replaying = cursor !== undefined;
    const stream = openStream(workerData.cookie, {
      agent: state.agent,
      lastEventId: cursor,
      validate,
      onHeartbeat: () => {
        heartbeats++;
      },
      onFrame: (frame) => {
        if (frame.event === "stream-ready.v1") replaying = false;
        if (firstFrames.length < 10)
          firstFrames.push({
            event: frame.event,
            id: frame.id ?? null,
            data: frame.data,
          });
        if (frame.event === "stream-reset.v1") {
          if (shutdownArmed) {
            state.shutdownResetAt = nowMs();
            return;
          }
          if (measuring) {
            fatal(
              new Error(
                "main cohort reset has no observed owner refetch proof",
              ),
              "REAUTH_REPLAY_UNAVAILABLE",
            );
            return;
          }
        }
        if (frame.event !== "resource-invalidated.v1") return;
        try {
          const s = subjectIndex.get(frame.data.subjectRef);
          assert.notEqual(
            s,
            undefined,
            "unpublished subject delivered to main measurement",
          );
          const version = Number(frame.data.ownerVersion);
          assert.ok(
            Number.isSafeInteger(version) &&
              version > 0 &&
              version < 2147483647,
          );
          assert.ok(version >= versions[s], "ownerVersion decreased");
          versions[s] = version;
          state.lastId = frame.id;
          if (measuring) {
            const latency = nowMs() - ulidTime(frame.id.slice(4));
            histogram.add(latency);
            (replaying ? replayHistogram : liveHistogram).add(latency);
            frames++;
          }
        } catch (e) {
          fatal(e, "WIRE_OR_COVERAGE_FAILURE");
        }
      },
      onClose: (s) => {
        if (s.closeObserved) return;
        s.closeObserved = true;
        if (s.counted) {
          s.counted = false;
          Atomics.sub(counts, index, 1);
        }
        if (closed || s.normalClose || !s.established) return;
        if (shutdownArmed) {
          if (state.shutdownResetAt === undefined) {
            fatal(
              new Error(
                "server closed a shutdown stream without a decoded stream-reset",
              ),
              "SHUTDOWN_RESET_MISSING",
            );
            return;
          }
          const serverClosedAt = nowMs();
          shutdownReceipts.push({
            client: workerData.clientOffset + client,
            connectionId: s.connectionId,
            resetAt: isoAt(state.shutdownResetAt),
            serverClosedAt: isoAt(serverClosedAt),
            elapsedMs: serverClosedAt - state.shutdownResetAt,
          });
          if (shutdownReceipts.length === streams.length)
            void Promise.all(streams.map((stream) => stream.closed)).then(
              () => {
                for (const state of states) state.agent.destroy();
                parentPort.postMessage({
                  type: "shutdown-closed",
                  shard: index,
                  clients: shutdownReceipts.length,
                  live: Atomics.load(counts, index),
                  receipts: shutdownReceipts,
                });
                parentPort.close();
              },
            );
          return;
        }
        const age = nowMs() - s.openedAt;
        if (
          !measuring ||
          age < (fixture.config.security.actorContext.maxAgeSeconds - 1) * 1000
        ) {
          unexpectedDisconnects++;
          fatal(
            new Error(`unexpected TLS SSE close after ${age}ms`),
            "POPULATION_INTERRUPTED",
          );
          return;
        }
        disconnects++;
        state.gapAt = nowMs();
        state.previousConnectionId = s.connectionId;
        state.deadline = later(
          () =>
            fatal(
              new Error(
                "re-auth ready exceeded wire retry plus establishment deadline",
              ),
              "REAUTH_RECOVERY_TIMEOUT",
            ),
          recoveryBudget,
        );
        later(() => {
          void recover(client);
        }, SSE_RETRY_MS);
      },
    });
    streams[client] = stream;
    await stream.ready;
    if (closed || stream.closeObserved) {
      stream.close();
      throw new Error("SSE closed before readiness ownership");
    }
    stream.established = true;
    stream.counted = true;
    Atomics.add(counts, index, 1);
    if (state.gapAt !== undefined) {
      const closedAt = state.gapAt,
        readyAt = nowMs(),
        gapMs = readyAt - closedAt;
      assert.ok(gapMs <= recoveryBudget, "re-auth recovery budget");
      assert.notEqual(
        stream.connectionId,
        state.previousConnectionId,
        "re-auth must have a new connection identity",
      );
      clearTimeout(state.deadline);
      timers.delete(state.deadline);
      state.deadline = undefined;
      state.gapAt = undefined;
      state.renewals++;
      state.recoveredAt = readyAt;
      reconnects++;
      gaps.add(gapMs);
      parentPort.postMessage({
        type: "reauth",
        shard: index,
        client,
        previousConnectionId: state.previousConnectionId,
        connectionId: stream.connectionId,
        lastEventId: cursor ?? null,
        tlsSessionReused: stream.request.socket.isSessionReused(),
        closedAt: isoAt(closedAt),
        readyAt: isoAt(readyAt),
        gapMs,
      });
    }
  }
  async function recover(client) {
    try {
      await establish(client);
    } catch (e) {
      if (closed) return;
      const state = states[client];
      if (
        state.gapAt !== undefined &&
        [502, 503, 504].includes(e.status) &&
        nowMs() + SSE_RETRY_MS < state.gapAt + recoveryBudget
      ) {
        parentPort.postMessage({
          type: "reauth-retry",
          shard: index,
          client,
          status: e.status,
          failedAt: isoAt(nowMs()),
          gapMs: nowMs() - state.gapAt,
        });
        later(() => {
          void recover(client);
        }, SSE_RETRY_MS);
      } else fatal(e, "REAUTH_ESTABLISHMENT_FAILED");
    }
  }
  async function opener() {
    while (next < workerData.count && !closed) {
      const client = next++;
      states[client] = {
        renewals: 0,
        agent: new Agent({
          keepAlive: false,
          maxSockets: 1,
          maxCachedSessions: 1,
          secureContext: edgeNginxSecureContext,
        }),
      };
      seen[client] = new Int32Array(fixture.subjects);
      await establish(client);
      assert.equal(
        streams[client].request.socket.isSessionReused(),
        false,
        "each client first admission requires its own cold TLS handshake",
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(8, workerData.count) }, opener),
  );
  assert.equal(
    new Set(streams.map((s) => s.connectionId)).size,
    workerData.count,
    "connection identities must be unique",
  );
  parentPort.postMessage({
    type: "ready",
    shard: index,
    count: streams.length,
    connectionIds: streams.map((s) => s.connectionId),
    oldestOpenedAt: Math.min(...streams.map((s) => s.openedAt)),
  });
  parentPort.on("message", (message) => {
    try {
      if (message.type === "start") {
        histogram.reset();
        liveHistogram.reset();
        replayHistogram.reset();
        gaps.reset();
        frames = 0;
        heartbeats = 0;
        coverageChecks = 0;
        disconnects = 0;
        reconnects = 0;
        firstFrames = [];
        measuring = true;
        parentPort.postMessage({
          type: "started",
          shard: index,
          live: Atomics.load(counts, index),
        });
      }
      if (message.type === "session") workerData.cookie = message.cookie;
      if (message.type === "checkpoint") {
        const target = Int32Array.from(message.expected),
          waiting = new Set();
        for (let client = 0; client < seen.length; client++)
          waiting.add(client);
        function scanCoverage() {
          if (!measuring || closed) return;
          try {
            if (nowMs() >= message.deadlineAt) {
              fatal(
                new Error(
                  "checkpoint expected ownerVersion maxima unavailable before coverage deadline",
                ),
                "COVERAGE_UNAVAILABLE",
              );
              return;
            }
            for (const client of waiting) {
              let complete = true;
              for (let subject = 0; subject < target.length; subject++)
                if (seen[client][subject] < target[subject]) {
                  complete = false;
                  break;
                }
              if (complete) {
                coverageChecks += assertCoverage([seen[client]], target);
                waiting.delete(client);
              }
            }
            if (waiting.size === 0) {
              parentPort.postMessage({
                type: "coverage",
                shard: index,
                checkpoint: message.checkpoint,
                checks: seen.length * target.length,
              });
              return;
            }
            later(scanCoverage, Math.min(100, message.deadlineAt - nowMs()));
          } catch (e) {
            fatal(e, "COVERAGE_UNAVAILABLE");
          }
        }
        later(scanCoverage, Math.max(0, message.checkAt - nowMs()));
      }
      if (message.type === "stats") {
        parentPort.postMessage({
          type: "latency-diagnostic",
          shard: index,
          live: liveHistogram.json(),
          replay: replayHistogram.json(),
          combined: histogram.json(),
        });
        parentPort.postMessage({
          type: "stats",
          shard: index,
          frames,
          heartbeats,
          coverageChecks,
          disconnects,
          reconnects,
          unexpectedDisconnects,
          recoveredClients: states.filter((s) => s.renewals > 0).length,
          pending: states.filter((s) => s.gapAt !== undefined).length,
          gaps: {
            bins: Array.from(gaps.bins),
            count: gaps.count,
            sum: gaps.sum,
            max: gaps.max,
          },
          live: Atomics.load(counts, index),
          histogram: {
            bins: Array.from(histogram.bins),
            count: histogram.count,
            sum: histogram.sum,
            max: histogram.max,
          },
          firstFrames,
        });
      }
      if (message.type === "shutdown-arm") {
        assert.equal(
          closed,
          false,
          "client worker must be healthy before shutdown arm",
        );
        assert.equal(
          streams.length,
          workerData.count,
          "shutdown arm includes each assigned client",
        );
        assert.ok(
          streams.every(
            (stream) =>
              stream.established && stream.counted && !stream.closeObserved,
          ),
          "every stream must remain live before SIGTERM",
        );
        measuring = false;
        shutdownArmed = true;
        for (const state of states) state.shutdownResetAt = undefined;
        clearTimers();
        disconnects = 0;
        reconnects = 0;
        unexpectedDisconnects = 0;
        parentPort.postMessage({
          type: "shutdown-armed",
          shard: index,
          clients: streams.length,
          live: Atomics.load(counts, index),
          armedAt: isoAt(nowMs()),
        });
      }
      if (message.type === "stop") {
        measuring = false;
        closed = true;
        clearTimers();
        for (const s of streams) s.close();
        for (const state of states) state?.agent.destroy();
        void Promise.all(streams.map((s) => s.closed)).then(() => {
          parentPort.postMessage({
            type: "stopped",
            shard: index,
            live: Atomics.load(counts, index),
          });
          parentPort.close();
        });
      }
    } catch (e) {
      fatal(e);
    }
  });
} catch (e) {
  fatal(e, "CLIENT_ESTABLISHMENT_FAILED");
  parentPort.close();
}
