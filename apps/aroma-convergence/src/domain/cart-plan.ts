const MAX_INT64 = 9_223_372_036_854_775_807n;
const HASH = /^[0-9a-f]{64}$/u;
const OFFER = /^off_[0-9A-HJKMNP-TV-Z]{26}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;

export type PhysicalLine = Readonly<{
  offerRef: string;
  sourceGrindKeyHash?: string;
  quantityMilli: string;
}>;
export type CartDifference = Readonly<
  PhysicalLine & {
    action: "SetQuantity" | "Remove";
    observedBeforeMilli: string;
    providerQuantity?: string;
  }
>;

function key(
  line: Pick<PhysicalLine, "offerRef" | "sourceGrindKeyHash">,
): string {
  if (
    !OFFER.test(line.offerRef) ||
    (line.sourceGrindKeyHash !== undefined &&
      !HASH.test(line.sourceGrindKeyHash))
  )
    throw new TypeError("AROMA_LINE_KEY_INVALID");
  return `${line.offerRef}:${line.sourceGrindKeyHash ?? ""}`;
}

/** The Gateway accepts whole units; fractions and imprecise JS numbers never leave Orders. */
export function providerQuantity(quantityMilli: string): string {
  if (!POSITIVE.test(quantityMilli))
    throw new TypeError("AROMA_QUANTITY_NOT_SUPPORTED");
  const quantity = BigInt(quantityMilli);
  if (
    quantity > MAX_INT64 ||
    quantity % 1000n !== 0n ||
    quantity / 1000n > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new TypeError("AROMA_QUANTITY_NOT_SUPPORTED");
  }
  return (quantity / 1000n).toString();
}

function index(lines: readonly PhysicalLine[]): Map<string, PhysicalLine> {
  if (lines.length > 10_000)
    throw new TypeError("AROMA_CART_CAPACITY_EXCEEDED");
  const found = new Map<string, PhysicalLine>();
  for (const line of lines) {
    const identity = key(line);
    if (
      !POSITIVE.test(line.quantityMilli) ||
      BigInt(line.quantityMilli) > MAX_INT64 ||
      found.has(identity)
    ) {
      throw new TypeError("AROMA_CART_LINE_INVALID");
    }
    found.set(identity, line);
  }
  return found;
}

/** Complete fresh Observed only; no side effects, and at most one deterministic mutation. */
export function firstCartDifference(
  desired: readonly PhysicalLine[],
  observed: readonly PhysicalLine[],
  cleanupOnly = false,
): CartDifference | null {
  const target = index(desired),
    actual = index(observed);
  for (const line of target.values()) providerQuantity(line.quantityMilli);
  let first: string | undefined;
  for (const [identity, wanted] of target) {
    const observedQuantity = actual.get(identity)?.quantityMilli;
    if (
      wanted.quantityMilli !== observedQuantity &&
      (!cleanupOnly ||
        BigInt(wanted.quantityMilli) < BigInt(observedQuantity ?? "0")) &&
      (first === undefined || identity < first)
    ) {
      first = identity;
    }
  }
  for (const identity of actual.keys()) {
    if (!target.has(identity) && (first === undefined || identity < first))
      first = identity;
  }
  if (first === undefined) return null;
  const wanted = target.get(first),
    current = actual.get(first),
    line = wanted ?? current;
  if (line === undefined) throw new TypeError("AROMA_CART_LINE_INVALID");
  if (wanted === undefined)
    return {
      offerRef: line.offerRef,
      ...(line.sourceGrindKeyHash === undefined
        ? {}
        : { sourceGrindKeyHash: line.sourceGrindKeyHash }),
      quantityMilli: "0",
      observedBeforeMilli: line.quantityMilli,
      action: "Remove",
    };
  return {
    offerRef: line.offerRef,
    ...(line.sourceGrindKeyHash === undefined
      ? {}
      : { sourceGrindKeyHash: line.sourceGrindKeyHash }),
    quantityMilli: wanted.quantityMilli,
    observedBeforeMilli: current?.quantityMilli ?? "0",
    action: "SetQuantity",
    providerQuantity: providerQuantity(wanted.quantityMilli),
  };
}

/** A reservation is reconciled by fresh physical truth, never replayed by operationRef. */
export function reconcileReservation(
  reservation: Pick<
    CartDifference,
    "offerRef" | "sourceGrindKeyHash" | "quantityMilli" | "observedBeforeMilli"
  >,
  before: readonly PhysicalLine[],
  observed: readonly PhysicalLine[],
): "RecoveredApplied" | "RecoveredNotApplied" | "AROMA_EXTERNAL_CHANGE" {
  const prior = index(before),
    current = index(observed),
    identity = key(reservation);
  if (
    (prior.get(identity)?.quantityMilli ?? "0") !==
    reservation.observedBeforeMilli
  )
    throw new TypeError("AROMA_RESERVATION_INVALID");
  for (const other of new Set([...prior.keys(), ...current.keys()])) {
    if (
      other !== identity &&
      (prior.get(other)?.quantityMilli ?? "0") !==
        (current.get(other)?.quantityMilli ?? "0")
    )
      return "AROMA_EXTERNAL_CHANGE";
  }
  const actual = current.get(identity)?.quantityMilli ?? "0";
  if (actual === reservation.quantityMilli) return "RecoveredApplied";
  if (actual === reservation.observedBeforeMilli) return "RecoveredNotApplied";
  return "AROMA_EXTERNAL_CHANGE";
}
