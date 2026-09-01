import assert from "node:assert/strict";
import test from "node:test";
import {
  businessDateTimeToInstant,
  deadlineAt,
  durationMilliseconds,
  isExpired,
  remainingUntil,
  resolveBusinessDateTime,
} from "../../packages/platform-time/src/index.ts";

void test("Temporal deadline and expiry use exact instants", () => {
  const start = "2026-09-01T00:00:00Z";
  const expiry = deadlineAt(start, "PT1.5S");

  assert.equal(expiry.toString(), "2026-09-01T00:00:01.5Z");
  assert.equal(isExpired(expiry, "2026-09-01T00:00:01.499Z"), false);
  assert.equal(isExpired(expiry, "2026-09-01T00:00:01.5Z"), true);
  assert.equal(durationMilliseconds(remainingUntil(expiry, "2026-09-01T00:00:00.5Z")), 1000);
});

void test("deadline rejects calendar durations", () => {
  assert.throws(() => deadlineAt("2026-09-01T00:00:00Z", "P1D"), /time units only/);
});

void test("Temporal resolves DST overlap only with an explicit policy", () => {
  const earlier = resolveBusinessDateTime("2024-10-27T02:30:00", "Europe/Berlin", "earlier");
  const later = resolveBusinessDateTime("2024-10-27T02:30:00", "Europe/Berlin", "later");

  assert.equal(earlier.offset, "+02:00");
  assert.equal(later.offset, "+01:00");
  assert.equal(businessDateTimeToInstant(later).since(businessDateTimeToInstant(earlier)).total({unit: "hours"}), 1);
  assert.throws(() => resolveBusinessDateTime("2024-10-27T02:30:00", "Europe/Berlin"), /multiple instants/);
});

void test("Temporal rejects nonexistent DST wall-clock time by default", () => {
  assert.throws(() => resolveBusinessDateTime("2024-03-31T02:30:00", "Europe/Berlin"), /multiple instants/);
});

void test("Temporal.Duration input remains time-only", () => {
  assert.equal(durationMilliseconds("PT2M5S"), 125_000);
});
