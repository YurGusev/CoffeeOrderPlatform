import { currentEpochMilliseconds } from "./time.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIMESTAMP = 281_474_976_710_655;

function encode128(value: bigint): string {
  let current = value;
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(current & 31n)]}${encoded}`;
    current >>= 5n;
  }
  return encoded;
}

export function newUlidRef(prefix: "itm", now = currentEpochMilliseconds(), randomness = crypto.getRandomValues(new Uint8Array(10))): string {
  const timestamp = Math.floor(now);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_TIMESTAMP || randomness.length !== 10) {
    throw new Error("Невозможно создать ULID identifier");
  }
  let random = 0n;
  for (const byte of randomness) random = (random << 8n) | BigInt(byte);
  return `${prefix}_${encode128((BigInt(timestamp) << 80n) | random)}`;
}
