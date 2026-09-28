import {createHash} from "node:crypto";

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const REF_SUFFIX = "[0-9A-HJKMNP-TV-Z]{26}";
const refPatterns = {
  itemRef: new RegExp(`^itm_${REF_SUFFIX}$`, "u"),
  offerRef: new RegExp(`^off_${REF_SUFFIX}$`, "u"),
  productRef: new RegExp(`^prd_${REF_SUFFIX}$`, "u"),
  variantRef: new RegExp(`^var_${REF_SUFFIX}$`, "u"),
  quoteRef: new RegExp(`^prq_${REF_SUFFIX}$`, "u"),
} as const;

export type ContributionItem = Readonly<{
  itemRef: string;
  offerRef: string;
  productRef: string;
  variantRef: string;
  quantityMilli: string;
  quoteRef: string;
  quoteLineNumber: number;
}>;
export type ContributionLine = Readonly<{
  offerRef: string;
  quantityMilli: string;
  contributionHash: string;
  itemRefs: readonly string[];
}>;
export type OrderContribution = Readonly<{hash: string; lines: readonly ContributionLine[]}>;
export type ContributionErrorCode = "ORDER_EMPTY" | "ORDER_STATE_INCONSISTENT" | "ORDER_DESIRED_OVERFLOW";
export class OrderContributionError extends Error {
  public readonly code: ContributionErrorCode;
  public constructor(code: ContributionErrorCode) {super(code); this.name = "OrderContributionError"; this.code = code;}
}

function compare(left: string, right: string): number {return left < right ? -1 : left > right ? 1 : 0;}
function digest(value: unknown): string {return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");}
function facts(item: ContributionItem): Readonly<Record<string, string | number>> {
  // Fixed lexicographic keys form the compact canonical JSON committed by the contribution.
  return {
    itemRef: item.itemRef,
    productRef: item.productRef,
    quantityMilli: item.quantityMilli,
    quoteLineNumber: item.quoteLineNumber,
    quoteRef: item.quoteRef,
    variantRef: item.variantRef,
  };
}

/** Pure projection of persisted, already-verified Order items; no owner or provider reads. */
export function computeOrderContribution(items: readonly ContributionItem[]): OrderContribution {
  if (items.length === 0) throw new OrderContributionError("ORDER_EMPTY");
  if (items.length > 100) throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
  const ordered = [...items].sort((left, right) => compare(left.itemRef, right.itemRef));
  const groups = new Map<string, {quantity: bigint; items: ContributionItem[]}>();
  const quoteLines = new Set<string>();
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    if (item === undefined) throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
    if (index > 0 && ordered[index - 1]?.itemRef === item.itemRef) throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
    for (const key of Object.keys(refPatterns) as (keyof typeof refPatterns)[]) {
      if (!refPatterns[key].test(item[key])) throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
    }
    if (!Number.isInteger(item.quoteLineNumber) || item.quoteLineNumber < 1 || item.quoteLineNumber > 100 ||
      typeof item.quantityMilli !== "string" || !/^[1-9][0-9]*$/u.test(item.quantityMilli)) {
      throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
    }
    const quoteLine = `${item.quoteRef}:${item.quoteLineNumber}`;
    if (quoteLines.has(quoteLine)) throw new OrderContributionError("ORDER_STATE_INCONSISTENT");
    quoteLines.add(quoteLine);
    const quantity = BigInt(item.quantityMilli);
    if (quantity > MAX_BIGINT) throw new OrderContributionError("ORDER_DESIRED_OVERFLOW");
    const group = groups.get(item.offerRef) ?? {quantity: 0n, items: []};
    group.quantity += quantity;
    if (group.quantity > MAX_BIGINT) throw new OrderContributionError("ORDER_DESIRED_OVERFLOW");
    group.items.push(item);
    groups.set(item.offerRef, group);
  }
  const lines = [...groups.entries()].sort(([left], [right]) => compare(left, right)).map(([offerRef, group]): ContributionLine => ({
    offerRef,
    quantityMilli: group.quantity.toString(),
    contributionHash: digest(group.items.map(facts)),
    itemRefs: group.items.map(item => item.itemRef),
  }));
  return {hash: digest(ordered.map(facts)), lines};
}
