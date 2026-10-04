import {hash as cryptoHash} from "node:crypto";
import {isAromaCartSnapshot, type AromaCartSnapshot} from "./index.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
export type NormalizedAromaCartLine = Readonly<{
  offerRef: string;
  sourceGrindKeyHash?: string;
  quantityMilli: string;
  sanitizedLineHash: string;
}>;
export type NormalizedAromaCartSnapshot = Readonly<{
  snapshot: AromaCartSnapshot;
  lines: readonly NormalizedAromaCartLine[];
}>;
export class AromaCartNormalizationError extends Error {
  public constructor() {super("AROMA_OBSERVATION_INVALID"); this.name = "AromaCartNormalizationError";}
}
function invalid(): never {throw new AromaCartNormalizationError();}
function compare(left: string, right: string): number {return left < right ? -1 : left > right ? 1 : 0;}
function hash(value: unknown): string {return cryptoHash("sha256", JSON.stringify(value), "hex");}

/** Strict wire normalization shared by the two Orders-owned snapshot writers.
 * Freshness is checked by each store against PostgreSQL time, not a process clock.
 */
export function normalizeAromaCartSnapshot(value: unknown): NormalizedAromaCartSnapshot {
  if (!isAromaCartSnapshot(value) || !/^aroma-gateway:cart-body-sha256:[0-9a-f]{64}$/u.test(value.providerSnapshotRef)) invalid();
  const keys = new Set<string>();
  const canonical = value.lines.map(line => {
    const key = `${line.offerRef}:${line.sourceGrindKeyHash ?? ""}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    return {offerRef: line.offerRef, quantity: line.quantity,
      ...(line.sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash: line.sourceGrindKeyHash})};
  }).sort((left, right) => compare(left.offerRef, right.offerRef) || compare(left.sourceGrindKeyHash ?? "", right.sourceGrindKeyHash ?? ""));
  if (hash(canonical) !== value.cartFingerprint) invalid();
  const lines = canonical.map((line): NormalizedAromaCartLine => {
    const [whole, fraction = ""] = line.quantity.split(".");
    const quantity = BigInt(whole!);
    const quantityMilli = quantity * 1000n + BigInt(fraction.padEnd(3, "0"));
    if (quantityMilli <= 0n || quantity > BigInt(Number.MAX_SAFE_INTEGER) || quantityMilli > MAX_INT64) invalid();
    const facts = {offerRef: line.offerRef, quantityMilli: quantityMilli.toString(),
      ...(line.sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash: line.sourceGrindKeyHash})};
    return {...facts, sanitizedLineHash: hash(facts)};
  });
  return {snapshot: value, lines};
}
