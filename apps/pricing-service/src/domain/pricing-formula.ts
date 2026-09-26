const MAX_DB_BIGINT = 9_223_372_036_854_775_807n;
const QUANTITY_PATTERN = /^(?:[1-9][0-9]{0,5}(?:\.[0-9]{1,3})?|0\.(?!0{1,3}$)[0-9]{1,3})$/u;
const CANONICAL_MINOR_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

function dbBigint(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > MAX_DB_BIGINT) {
    throw new RangeError(`${field} must fit a nonnegative database bigint`);
  }
  return value;
}

/** Decimal wire quantity, normalized without float or trailing zeroes. */
export function parseQuantity(value: string): {quantity: string; quantityMilli: bigint} {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new RangeError("quantity must be between 0.001 and 999999.999 with at most three decimal places");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return {
    quantity: fraction === "" ? whole : `${whole}.${fraction.replace(/0+$/u, "")}`.replace(/\.$/u, ""),
    quantityMilli: BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0")),
  };
}

/** Catalog/DB minor units are canonical decimal strings, bounded by signed bigint64. */
export function parseCanonicalMinor(value: string): bigint {
  if (typeof value !== "string" || !CANONICAL_MINOR_PATTERN.test(value)) {
    throw new RangeError("minor units must be a canonical nonnegative decimal string");
  }
  return dbBigint(BigInt(value), "minor units");
}

/** Convert an in-range internal bigint back to the canonical decimal wire representation. */
export function encodeMinor(value: bigint): string {
  return dbBigint(value, "minor units").toString();
}

export type PricingLineInput = Readonly<{
  quantity: string;
  supplierUnitMinor: string;
  markupBasisPoints: number;
  minimumMarginMinor: bigint;
}>;

export type CalculatedPricingLine = Readonly<{
  quantity: string;
  quantityMilli: bigint;
  unitMinor: bigint;
  lineTotalMinor: bigint;
}>;

export function calculatePricingLine(input: PricingLineInput): CalculatedPricingLine {
  const {quantity, quantityMilli} = parseQuantity(input.quantity);
  const supplier = parseCanonicalMinor(input.supplierUnitMinor);
  if (!Number.isInteger(input.markupBasisPoints) || input.markupBasisPoints < 0 || input.markupBasisPoints > 100_000) {
    throw new RangeError("markupBasisPoints must be an integer between 0 and 100000");
  }
  const minimumMargin = dbBigint(input.minimumMarginMinor, "minimumMarginMinor");
  const markupUnit = (supplier * (10_000n + BigInt(input.markupBasisPoints)) + 9_999n) / 10_000n;
  const unitMinor = dbBigint(markupUnit > supplier + minimumMargin ? markupUnit : supplier + minimumMargin, "unitMinor");
  const lineTotalMinor = dbBigint((unitMinor * quantityMilli + 999n) / 1000n, "lineTotalMinor");
  return {quantity, quantityMilli, unitMinor, lineTotalMinor};
}

export function sumLineTotals(lines: Iterable<Pick<CalculatedPricingLine, "lineTotalMinor">>): bigint {
  let total = 0n;
  for (const line of lines) {
    total = dbBigint(total + dbBigint(line.lineTotalMinor, "lineTotalMinor"), "totalMinor");
  }
  return total;
}
