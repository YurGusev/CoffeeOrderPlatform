import assert from "node:assert/strict";
import { test } from "vitest";
import { newUlidRef } from "../src/browser/api/ulid.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function decodedTimestamp(ref: string): number {
  let value = 0;
  for (const char of ref.slice(4, 14))
    value = value * 32 + CROCKFORD.indexOf(char);
  return value;
}

test("item ref encodes the ULID timestamp and 80 bits of randomness", () => {
  const now = 1_799_999_999_999;
  const ref = newUlidRef(
    "itm",
    now,
    new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
  assert.match(ref, /^itm_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
  assert.equal(decodedTimestamp(ref), now);
  const zeroRandomness = newUlidRef("itm", now, new Uint8Array(10));
  assert.equal(zeroRandomness, newUlidRef("itm", now, new Uint8Array(10)));
  assert.match(zeroRandomness, /0{16}$/u);
});

test("item ref rejects invalid timestamp and randomness length", () => {
  assert.throws(() => newUlidRef("itm", -1, new Uint8Array(10)), /ULID/u);
  assert.throws(() => newUlidRef("itm", 1, new Uint8Array(9)), /ULID/u);
});
