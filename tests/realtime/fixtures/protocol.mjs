import assert from "node:assert/strict";
import { TextDecoder } from "node:util";

export const nowMs = () => Date.now();
export const isoAt = (ms) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toString({
    smallestUnit: "millisecond",
  });
export const isoNow = () =>
  Temporal.Now.instant().toString({ smallestUnit: "millisecond" });
export const parseTime = (value) => {
  try {
    return Number(Temporal.Instant.from(value).epochMilliseconds);
  } catch {
    return NaN;
  }
};
export const FULL = Object.freeze({
  clients: 1,
  rate: 100,
  durationMs: 1800000,
});
export const SSE_RETRY_MS = 3000;
export const SSE_READY_TIMEOUT_MS = 10000;
export const OIDC_SESSION_LOGIN_INTERVAL_MS = 600000;
export const THRESHOLDS = Object.freeze({
  eventLatencyP95Ms: 1000,
  eventLoopP95Ms: 100,
  cleanupMs: 10000,
  shutdownMs: 20000,
  headroomMs: 1000,
  slowDisconnectMs: 10000,
  nginxRssBytes: 536870912,
  nginxFd: 16384,
  realtimeRssBytes: 536870912,
  realtimeFd: 12288,
  driverRssBytes: 2147483648,
  driverFd: 32768,
});
const MAX_DRIVER_DIAGNOSTIC_CHARS = 1024;

export function driverFailure(error) {
  const code =
    typeof error?.code === "string" && error.code.length > 0
      ? error.code
      : "TRANSPORT_PROOF_FAILED";
  const message =
    typeof error?.message === "string" && error.message.length > 0
      ? error.message
      : code;
  const failure = { code, message };
  if (typeof error?.diagnostic === "string" && error.diagnostic.length > 0)
    failure.diagnostic = error.diagnostic.slice(-MAX_DRIVER_DIAGNOSTIC_CHARS);
  return failure;
}

export function classifyResult(r) {
  const missing = [];
  for (const name of [
    "admission",
    "slow",
    "replay",
    "evicted",
    "reset",
    "reload",
    "headroom",
    "cleanup",
    "shutdown",
    "budgets",
  ])
    if (r.checks?.[name] !== true) missing.push(name);
  if (r.protocolFrames < 1 || r.coverageChecks < 1)
    missing.push("nonempty protocol/coverage");
  if (
    r.eventLatencyP95Ms === null ||
    !Number.isFinite(r.eventLatencyP95Ms) ||
    r.eventLatencyP95Ms > THRESHOLDS.eventLatencyP95Ms
  )
    missing.push("event latency");
  if (
    r.eventLoopP95Ms === null ||
    !Number.isFinite(r.eventLoopP95Ms) ||
    r.eventLoopP95Ms > THRESHOLDS.eventLoopP95Ms
  )
    missing.push("gateway event loop");
  if (!r.cleanupVerified) missing.push("fixture cleanup");
  if (r.error) missing.push(r.error.code ?? "execution error");
  const shutdown = r.checkDetails?.shutdown,
    receipts = shutdown?.clientReceipts,
    shards = shutdown?.shardReceipts;
  const clientIds = Array.isArray(receipts)
    ? receipts.map((receipt) => receipt?.client)
    : [];
  const shardIds = Array.isArray(shards)
    ? shards.map((receipt) => receipt?.shard)
    : [];
  const validShutdown =
    shutdown?.clients === r.clients &&
    Number.isSafeInteger(r.clients) &&
    r.clients > 0 &&
    shutdown.liveBefore === r.clients &&
    shutdown.gatewayLiveBefore === r.clients &&
    shutdown.armedClients === r.clients &&
    shutdown.armedLive === r.clients &&
    shutdown.closedClients === r.clients &&
    shutdown.workerErrors === 0 &&
    shutdown.timedOut === false &&
    shutdown.forcedClientClose === false &&
    shutdown.ok === true &&
    shutdown.state?.ExitCode === 0 &&
    Number.isFinite(shutdown.elapsedMs) &&
    shutdown.elapsedMs >= 0 &&
    shutdown.elapsedMs <= THRESHOLDS.shutdownMs &&
    Array.isArray(receipts) &&
    receipts.length === r.clients &&
    new Set(clientIds).size === r.clients &&
    clientIds.every(
      (client) =>
        Number.isSafeInteger(client) && client >= 0 && client < r.clients,
    ) &&
    receipts.every((receipt) => {
      const resetAt = parseTime(receipt.resetAt),
        serverClosedAt = parseTime(receipt.serverClosedAt);
      return (
        typeof receipt.connectionId === "string" &&
        receipt.connectionId.length > 0 &&
        Number.isFinite(resetAt) &&
        Number.isFinite(serverClosedAt) &&
        serverClosedAt >= resetAt &&
        Number.isFinite(receipt.elapsedMs) &&
        receipt.elapsedMs === serverClosedAt - resetAt &&
        receipt.elapsedMs <= THRESHOLDS.cleanupMs
      );
    }) &&
    Array.isArray(shards) &&
    shards.length > 0 &&
    new Set(shardIds).size === shards.length &&
    shardIds.every((shard) => Number.isSafeInteger(shard) && shard >= 0) &&
    shards.reduce((n, shard) => n + shard.clients, 0) === r.clients &&
    shards.every((shard) => shard.live === 0);
  if (!validShutdown) missing.push("loaded graceful shutdown receipt");
  if (r.mode === "full") {
    if (r.profile !== "operator-1") missing.push("explicit operator-1 profile");
    if (
      r.clients !== FULL.clients ||
      !Number.isSafeInteger(r.minLive) ||
      r.minLive < 0 ||
      r.minLive > FULL.clients ||
      r.maxLive !== FULL.clients
    )
      missing.push("one operator and raw population samples");
    const admission = r.checkDetails?.admission;
    if (
      admission?.live !== 512 ||
      admission.rejectedConnection !== 513 ||
      admission.status !== 503 ||
      admission.code !== "REALTIME_CAPACITY_EXCEEDED" ||
      admission.beforeSseHeaders !== true
    )
      missing.push("actual separate 512/513 admission receipt");
    const maxima = Object.entries(r.checkDetails?.expectedMaximum ?? {});
    if (
      r.subjects !== 100 ||
      maxima.length !== 100 ||
      maxima.some(
        ([ref, version]) =>
          !/^ord_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(ref) ||
          !/^[1-9][0-9]*$/u.test(version),
      )
    )
      missing.push("100 measured order subjects");
    if (r.durationMs < FULL.durationMs) missing.push("continuous 1800000ms");
    if (
      r.rate !== FULL.rate ||
      r.published < (FULL.rate * FULL.durationMs) / 1000
    )
      missing.push("100 valid ACKed invalidations/sec");
    const reauth = r.checkDetails?.reauth;
    if (
      r.checks?.reauth !== true ||
      !Number.isSafeInteger(r.disconnects) ||
      r.disconnects < FULL.clients ||
      r.disconnects !== r.reconnects ||
      reauth?.recoveredClients !== FULL.clients ||
      reauth.samples !== r.reconnects ||
      reauth.unexpectedDisconnects !== 0 ||
      reauth.pending !== 0 ||
      !Number.isSafeInteger(reauth.authCloseDelta) ||
      reauth.authCloseDelta !== r.disconnects ||
      reauth.finalLive !== FULL.clients ||
      reauth.retryMs !== SSE_RETRY_MS ||
      reauth.readyTimeoutMs !== SSE_READY_TIMEOUT_MS ||
      !Number.isSafeInteger(reauth.sessionRefreshes) ||
      reauth.sessionRefreshes < 2 ||
      reauth.sessionRefreshIntervalMs !== OIDC_SESSION_LOGIN_INTERVAL_MS ||
      !Number.isFinite(reauth.maxGapMs) ||
      reauth.maxGapMs < 0 ||
      reauth.maxGapMs > SSE_RETRY_MS + SSE_READY_TIMEOUT_MS ||
      !Number.isFinite(reauth.gapP95Ms) ||
      reauth.gapP95Ms < 0 ||
      reauth.gapP95Ms > reauth.maxGapMs
    )
      missing.push("bounded causal re-auth for every client");
  }
  return {
    status: missing.length
      ? "FAIL"
      : r.mode === "full"
        ? "PASS"
        : "smoke-not-launch-proof",
    launchProof: missing.length === 0 && r.mode === "full",
    missing,
  };
}
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(time, sequence) {
  let n = (BigInt(time) << 80n) | BigInt(sequence);
  let text = "";
  for (let i = 0; i < 26; i++) {
    text = ALPHABET[Number(n & 31n)] + text;
    n >>= 5n;
  }
  assert.equal(n, 0n);
  return text;
}
export function ulidTime(text) {
  assert.match(text, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  let n = 0;
  for (const c of text.slice(0, 10)) n = n * 32 + ALPHABET.indexOf(c);
  return n;
}
export class Histogram {
  count = 0;
  sum = 0;
  max = 0;
  constructor(maxMs = 10000) {
    assert.ok(Number.isSafeInteger(maxMs) && maxMs > 0);
    this.bins = new Float64Array(maxMs + 2);
  }
  add(ms) {
    assert.ok(Number.isFinite(ms) && ms >= 0, "invalid measured latency");
    const n = Math.ceil(ms);
    this.bins[Math.min(n, this.bins.length - 1)]++;
    this.count++;
    this.sum += ms;
    this.max = Math.max(this.max, ms);
  }
  merge(other) {
    assert.equal(other.bins.length, this.bins.length, "histogram bounds");
    for (let i = 0; i < this.bins.length; i++) this.bins[i] += other.bins[i];
    this.count += other.count;
    this.sum += other.sum;
    this.max = Math.max(this.max, other.max);
  }
  p95() {
    if (!this.count) return null;
    let n = 0;
    for (let i = 0; i < this.bins.length; i++) {
      n += this.bins[i];
      if (n >= this.count * 0.95)
        return i === this.bins.length - 1 ? Infinity : i;
    }
    throw new Error("histogram corrupt");
  }
  json() {
    return {
      count: this.count,
      p95Ms: this.p95(),
      maxMs: this.max,
      meanMs: this.count ? this.sum / this.count : null,
    };
  }
  reset() {
    this.bins.fill(0);
    this.count = 0;
    this.sum = 0;
    this.max = 0;
  }
}
export function assertCoverage(observed, expected) {
  let checks = 0;
  for (let c = 0; c < observed.length; c++)
    for (let s = 0; s < expected.length; s++) {
      assert.ok(
        observed[c][s] >= expected[s],
        `silent loss: client=${c} subject=${s} received=${observed[c][s]} expectedMaximum=${expected[s]}`,
      );
      checks++;
    }
  return checks;
}
const INVALIDATION_CACHE_MAX = 64;
const invalidationCaches = new WeakMap();
/** No business-wire reimplementation: caller supplies generated schema validators. */
export class SseDecoder {
  decoder = new TextDecoder("utf-8", { fatal: true });
  pending = "";
  constructor(validate, onFrame, onHeartbeat = () => {}) {
    this.validate = validate;
    this.onFrame = onFrame;
    this.onHeartbeat = onHeartbeat;
    let cache = invalidationCaches.get(validate);
    if (cache === undefined) {
      cache = new Map();
      invalidationCaches.set(validate, cache);
    }
    this.invalidationCache = cache;
  }
  push(bytes) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    let offset;
    while ((offset = this.pending.indexOf("\n\n")) !== -1) {
      const raw = this.pending.slice(0, offset);
      this.pending = this.pending.slice(offset + 2);
      assert.ok(Buffer.byteLength(raw) <= 8192, "SSE frame budget");
      this.frame(raw);
    }
    assert.ok(Buffer.byteLength(this.pending) <= 8192, "SSE frame budget");
  }
  frame(raw) {
    if (raw.startsWith(":")) {
      assert.match(raw, /^: heartbeat \d{4}-\d{2}-\d{2}T[^\n]+$/u);
      assert.ok(Number.isFinite(parseTime(raw.slice(12))));
      this.onHeartbeat();
      return;
    }
    const cached = this.invalidationCache.get(raw);
    if (cached !== undefined) {
      const data = { ...cached.data };
      this.validate(cached.fields.event, data);
      this.onFrame({ ...cached.fields, data });
      return;
    }
    const fields = {};
    for (const line of raw.split("\n")) {
      const n = line.indexOf(":");
      assert.ok(n > 0, "invalid SSE field");
      const k = line.slice(0, n),
        v = line.slice(n + 1).replace(/^ /u, "");
      assert.ok(
        ["event", "id", "data", "retry"].includes(k),
        "unknown SSE field",
      );
      assert.ok(!Object.hasOwn(fields, k), "duplicate SSE field");
      fields[k] = v;
    }
    assert.ok(
      [
        "resource-invalidated.v1",
        "stream-ready.v1",
        "stream-reset.v1",
      ].includes(fields.event),
      "unknown SSE event",
    );
    assert.ok(
      typeof fields.data === "string" && Buffer.byteLength(fields.data) <= 2048,
      "SSE data budget",
    );
    if (fields.event === "resource-invalidated.v1") {
      assert.match(fields.id, /^msg_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
      assert.equal(fields.retry, "3000");
    } else {
      assert.ok(!Object.hasOwn(fields, "id"), "service record has id");
      if (Object.hasOwn(fields, "retry"))
        assert.equal(fields.retry, "3000", "invalid service retry");
    }
    const data = JSON.parse(fields.data);
    this.validate(fields.event, data);
    if (fields.event === "resource-invalidated.v1") {
      if (this.invalidationCache.size === INVALIDATION_CACHE_MAX)
        this.invalidationCache.delete(
          this.invalidationCache.keys().next().value,
        );
      this.invalidationCache.set(raw, {
        fields: { ...fields },
        data: { ...data },
      });
    }
    this.onFrame({ ...fields, data });
  }
}
export function parseMetrics(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match =
      /^([a-zA-Z_:][\w:]*)(\{[^\n]*\})? ([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(?: \d+)?$/u.exec(
        line,
      );
    assert.ok(match, `invalid Prometheus metric line: ${line.slice(0, 120)}`);
    rows.push({
      name: match[1],
      labels: match[2] ?? "",
      value: Number(match[3]),
    });
  }
  return rows;
}
export function metric(rows, pattern, label) {
  const matching = rows.filter((r) => pattern.test(r.name));
  assert.equal(
    matching.length,
    1,
    `missing/ambiguous ${label} metric: ${matching.map((r) => r.name).join(",")}`,
  );
  assert.ok(Number.isFinite(matching[0].value), `nonfinite ${label}`);
  return matching[0];
}
