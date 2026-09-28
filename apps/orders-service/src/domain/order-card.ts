import type {OrderCardResponse} from "@coffee-platform/contracts-orders-v1";

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const NONNEGATIVE = /^(?:0|[1-9][0-9]*)$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const ACTION_PERMISSION = {
  "edit-items": "orders:edit:any",
  confirm: "orders:confirm:any",
  "request-aroma-reconciliation": "orders:reconcile:any",
} satisfies Record<OrderCardResponse["allowedActions"][number], string>;

export type StoredCardOrder = Readonly<{
  orderRef: string;
  version: string;
  projectionVersion: string;
  status: string;
  customerRef: string;
  customerDisplayName: string;
  customerVersion: string;
}>;
export type StoredCardItem = Readonly<{
  itemRef: string;
  linePosition: number;
  productRef: string;
  variantRef: string;
  displayName: string;
  quantity: string;
  unit: "piece" | "gram" | "kilogram";
  quoteRef: string;
  quoteLineNumber: number;
  unitMinor: string;
  lineTotalMinor: string;
  quoteHash: string;
  quoteExpiresAt: string;
  quoteExpiresAtEpochMs: number;
}>;
export type CardProjectionInput = Readonly<{
  order: StoredCardOrder;
  items: readonly StoredCardItem[];
  nowEpochMs: number;
  permissions: readonly string[];
}>;

function compare(left: string, right: string): number {return left < right ? -1 : left > right ? 1 : 0;}
function money(value: string): bigint {
  if (typeof value !== "string" || !NONNEGATIVE.test(value)) throw new Error("ORDER_STATE_INCONSISTENT");
  const amount = BigInt(value);
  if (amount > MAX_BIGINT) throw new Error("ORDER_STATE_INCONSISTENT");
  return amount;
}

/** Project only whitelisted public fields from owner rows; never read another service. */
export function projectOrderCard({order, items, nowEpochMs, permissions}: CardProjectionInput): OrderCardResponse {
  let inconsistent = !(order.status === "Draft" || order.status === "Confirmed") ||
    !POSITIVE.test(order.version) || !POSITIVE.test(order.projectionVersion) ||
    !POSITIVE.test(order.customerVersion) || !Number.isFinite(nowEpochMs) || items.length > 100;
  const sorted = [...items].sort((left, right) => left.linePosition - right.linePosition);
  const seenRefs = new Set<string>();
  const seenPositions = new Set<number>();
  const proofs = new Map<string, {quoteRef: string; hash: string; expiresAt: string}>();
  let total = 0n;
  for (const item of sorted) {
    if (!Number.isInteger(item.linePosition) || item.linePosition < 1 || item.linePosition > 100 ||
      !Number.isInteger(item.quoteLineNumber) || item.quoteLineNumber < 1 || item.quoteLineNumber > 100 ||
      seenRefs.has(item.itemRef) || seenPositions.has(item.linePosition) ||
      !Number.isFinite(item.quoteExpiresAtEpochMs) || !/^[0-9a-f]{64}$/u.test(item.quoteHash)) inconsistent = true;
    seenRefs.add(item.itemRef);
    seenPositions.add(item.linePosition);
    const previous = proofs.get(item.quoteRef);
    if (previous && (previous.hash !== item.quoteHash || previous.expiresAt !== item.quoteExpiresAt)) inconsistent = true;
    proofs.set(item.quoteRef, {quoteRef: item.quoteRef, hash: item.quoteHash, expiresAt: item.quoteExpiresAt});
    try {
      money(item.unitMinor);
      total += money(item.lineTotalMinor);
      if (total > MAX_BIGINT) inconsistent = true;
    } catch {inconsistent = true;}
  }
  const status = order.status === "Confirmed" ? "Confirmed" : "Draft";
  const aroma: OrderCardResponse["aroma"] = inconsistent ? {
    state: "Blocked", desiredRevision: "0", observedRevision: "0",
    blockers: [{code: "ORDER_STATE_INCONSISTENT", message: "Состояние заказа требует проверки"}],
  } : {state: status === "Draft" ? "NotRequested" : "PendingObservation", desiredRevision: "0", observedRevision: "0", blockers: []};
  const publicItems: OrderCardResponse["items"] = inconsistent ? [] : sorted.map(item => ({
    itemRef: item.itemRef,
    linePosition: item.linePosition,
    productRef: item.productRef,
    variantRef: item.variantRef,
    displayName: item.displayName,
    quantity: item.quantity,
    unit: item.unit,
    quoteRef: item.quoteRef,
    quoteLineNumber: item.quoteLineNumber,
    unitMinor: item.unitMinor,
    lineTotalMinor: item.lineTotalMinor,
  }));
  const pricing: OrderCardResponse["pricing"] = inconsistent || sorted.length === 0 ? null : {
    totalMinor: total.toString(),
    currency: "RUB",
    quoteProofs: [...proofs.values()].sort((left, right) => compare(left.quoteRef, right.quoteRef)),
  };
  const allowedActions: OrderCardResponse["allowedActions"] = inconsistent ? [] : [
    ...(status === "Draft" && permissions.includes(ACTION_PERMISSION["edit-items"]) ? ["edit-items" as const] : []),
    ...(status === "Draft" && permissions.includes(ACTION_PERMISSION.confirm) && sorted.length > 0 &&
      sorted.every(item => item.quoteExpiresAtEpochMs > nowEpochMs) ? ["confirm" as const] : []),
    ...(status === "Confirmed" && permissions.includes(ACTION_PERMISSION["request-aroma-reconciliation"]) &&
      (aroma.state === "OutOfSync" || aroma.state === "Blocked" || aroma.state === "UnknownOutcome")
      ? ["request-aroma-reconciliation" as const] : []),
  ];
  return {
    orderRef: order.orderRef,
    version: order.version,
    projectionVersion: order.projectionVersion,
    status,
    customer: {customerRef: order.customerRef, displayName: order.customerDisplayName},
    items: publicItems,
    pricing,
    aroma,
    allowedActions,
  };
}
