import assert from "node:assert/strict";
import { test } from "vitest";
import { instantEpochMilliseconds } from "../src/browser/api/time.js";

test("instantEpochMilliseconds parses UTC and numeric offsets without legacy Date", () => {
  assert.equal(instantEpochMilliseconds("1970-01-01T00:00:00.000Z"), 0);
  assert.equal(instantEpochMilliseconds("2026-09-29T18:00:00.000Z"), 1_790_704_800_000);
  assert.equal(instantEpochMilliseconds("2026-09-29T21:00:00.000+03:00"), 1_790_704_800_000);
});

test("instantEpochMilliseconds rejects invalid calendar values", () => {
  assert.throws(() => instantEpochMilliseconds("2026-02-29T00:00:00Z"));
  assert.throws(() => instantEpochMilliseconds("not-an-instant"));
});
