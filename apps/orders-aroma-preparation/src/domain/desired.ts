import {canonicalRequestHash, type JsonValue} from "@coffee-platform/idempotency";

export class AromaPreparationError extends Error {
  public readonly code: string;
  public constructor(code: string) {super(code); this.name = "AromaPreparationError"; this.code = code;}
}
export type Contribution = Readonly<{order_ref: string; contribution_revision: string; order_version: string}>;
export type ItemProof = Readonly<{
  itemRef: string; found: true; productRef: string; variantRef: string;
  offerRef: string; grind: string | null; quantity: string;
  mappingOffer: string | null; mappingRevision: string | null; mappingState: string | null; availability: string | null;
}> | Readonly<{
  itemRef: string; found: false; productRef: null; variantRef: null; offerRef: null; grind: null; quantity: null;
  mappingOffer: null; mappingRevision: null; mappingState: null; availability: null;
}>;
export type ContributionLine = Readonly<{
  order_ref: string; contribution_revision: string; offer_ref: string; source_grind_key_hash: string | null;
  quantity_milli: string; contribution_hash: string; item_refs: readonly string[]; items: readonly ItemProof[];
}>;
export type DesiredLine = Readonly<{
  offerRef: string; sourceGrindKeyHash: string | null; quantityMilli: string; contributionHash: string; contributingOrderRefs: readonly string[];
}>;
export type DesiredBlocker = Readonly<{
  orderRef: string; productRef: string; variantRef: string; code: string; mappingRevision: string | null;
}>;
export type DesiredOrderFact = Readonly<{orderRef: string; contributionRevision: string; contributionHash: string}>;
export type DesiredPlan = Readonly<{
  hash: string; sourceMaxOrderVersion: string; lines: readonly DesiredLine[]; blockers: readonly DesiredBlocker[]; orders: readonly DesiredOrderFact[];
}>;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_PROVIDER_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
export function compare(left: string, right: string): number {return left < right ? -1 : left > right ? 1 : 0;}
export function jsonHash(value: unknown): string {return canonicalRequestHash(value as JsonValue);}
function physical(offer: string, grind: string | null): string {return `${offer}:${grind ?? ""}`;}
function quantity(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new AromaPreparationError("AROMA_CONTRIBUTION_INVALID");
  const result = BigInt(value);
  if (result > MAX_INT64) throw new AromaPreparationError("AROMA_DESIRED_OVERFLOW");
  return result;
}
function mappingBlocker(item: ItemProof): string | undefined {
  if (item.mappingState === "Stopped" || item.availability === "Stopped") return "MAPPING_STOPPED";
  if (item.mappingState !== "Active" || item.mappingOffer === null) return "MAPPING_MISSING";
  if (item.mappingOffer !== item.offerRef) return "MAPPING_CHANGED";
  if (item.availability !== "Available") return "PRODUCT_UNAVAILABLE";
  return undefined;
}

/** Pure recompute from immutable Orders-local facts. Frozen offers are NEVER
 * remapped. NULL grind is its own physical key, not a wildcard. */
export function buildDesired(contributions: readonly Contribution[], input: readonly ContributionLine[], maxOrders: number, maxLines: number): DesiredPlan {
  if (contributions.length > maxOrders || input.length > maxLines) throw new AromaPreparationError("AROMA_PREPARATION_CARDINALITY");
  const blockers = new Map<string, DesiredBlocker>();
  const groups = new Map<string, {offer: string; grind: string | null; quantity: bigint; sources: Set<string>; hashes: Set<string>}>();
  const orderHashes = new Map<string, string[]>();
  const seenItems = new Set<string>();
  for (const line of input) {
    const expectedQuantity = quantity(line.quantity_milli);
    if (line.item_refs.length === 0 || line.items.length !== line.item_refs.length || new Set(line.item_refs).size !== line.item_refs.length ||
      !/^[0-9a-f]{64}$/u.test(line.contribution_hash)) throw new AromaPreparationError("AROMA_CONTRIBUTION_INVALID");
    let actualQuantity = 0n;
    const hashes = orderHashes.get(line.order_ref) ?? [];
    hashes.push(line.contribution_hash);
    orderHashes.set(line.order_ref, hashes);
    for (const item of line.items) {
      const itemKey = `${line.order_ref}:${item.itemRef}`;
      if (!item.found || seenItems.has(itemKey) || !line.item_refs.includes(item.itemRef) || item.offerRef !== line.offer_ref || item.grind !== line.source_grind_key_hash) {
        throw new AromaPreparationError("AROMA_CONTRIBUTION_INVALID");
      }
      seenItems.add(itemKey);
      const amount = quantity(item.quantity);
      actualQuantity += amount;
      let code = mappingBlocker(item);
      if (expectedQuantity % 1000n !== 0n || expectedQuantity / 1000n > MAX_PROVIDER_UNITS || amount % 1000n !== 0n) code = "AROMA_QUANTITY_NOT_SUPPORTED";
      if (code !== undefined) {
        const blocker = {orderRef: line.order_ref, productRef: item.productRef, variantRef: item.variantRef, code, mappingRevision: item.mappingRevision};
        blockers.set(`${line.order_ref}:${item.productRef}:${item.variantRef}:${code}`, blocker);
        continue;
      }
      const key = physical(line.offer_ref, line.source_grind_key_hash);
      const group = groups.get(key) ?? {offer: line.offer_ref, grind: line.source_grind_key_hash, quantity: 0n, sources: new Set<string>(), hashes: new Set<string>()};
      group.quantity += amount;
      if (group.quantity > MAX_INT64) throw new AromaPreparationError("AROMA_DESIRED_OVERFLOW");
      if (group.quantity / 1000n > MAX_PROVIDER_UNITS) throw new AromaPreparationError("AROMA_QUANTITY_NOT_SUPPORTED");
      group.sources.add(line.order_ref);
      group.hashes.add(line.contribution_hash);
      groups.set(key, group);
    }
    if (actualQuantity !== expectedQuantity) throw new AromaPreparationError("AROMA_CONTRIBUTION_INVALID");
  }
  if (groups.size > maxLines) throw new AromaPreparationError("AROMA_PREPARATION_CARDINALITY");
  const lines = [...groups.entries()].sort(([a], [b]) => compare(a, b)).map(([, group]): DesiredLine => ({
    offerRef: group.offer, sourceGrindKeyHash: group.grind, quantityMilli: group.quantity.toString(),
    contributionHash: jsonHash([...group.hashes].sort(compare)), contributingOrderRefs: [...group.sources].sort(compare),
  }));
  const blocked = [...blockers.entries()].sort(([a], [b]) => compare(a, b)).map(([, blocker]) => blocker);
  const orders = contributions.map((contribution): DesiredOrderFact => {
    const hashes = orderHashes.get(contribution.order_ref);
    if (!hashes) throw new AromaPreparationError("AROMA_CONTRIBUTION_INVALID");
    return {orderRef: contribution.order_ref, contributionRevision: contribution.contribution_revision, contributionHash: jsonHash(hashes.sort(compare))};
  }).sort((a, b) => compare(a.orderRef, b.orderRef));
  let sourceMaxOrderVersion = 0n;
  for (const contribution of contributions) if (BigInt(contribution.order_version) > sourceMaxOrderVersion) sourceMaxOrderVersion = BigInt(contribution.order_version);
  return {hash: jsonHash({lines, blockers: blocked, orders}), sourceMaxOrderVersion: sourceMaxOrderVersion.toString(), lines, blockers: blocked, orders};
}
