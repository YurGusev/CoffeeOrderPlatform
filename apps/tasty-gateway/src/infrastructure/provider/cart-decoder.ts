export type TastyCartLine = Readonly<{
  rowId: string;
  offerId: string;
  productId: string;
  quantity: number;
  grindingId: string | null;
  packageId: string | null;
}>;

export type TastyCartSnapshot = Readonly<{
  kind: "empty" | "nonempty";
  lines: readonly TastyCartLine[];
  completeness: "Unproven";
}>;

export type TastyCartErrorCode =
  | "TASTY_CART_INCOMPLETE"
  | "TASTY_CART_INVALID"
  | "TASTY_CART_UNSUPPORTED_LINE";

export class TastyCartDecodeError extends Error {
  readonly code: TastyCartErrorCode;

  constructor(code: TastyCartErrorCode) {
    super(code);
    this.name = "TastyCartDecodeError";
    this.code = code;
  }
}

function fail(code: TastyCartErrorCode): never {
  throw new TastyCartDecodeError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("TASTY_CART_INVALID");
  return value as Record<string, unknown>;
}

function required(source: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(source, key)) fail("TASTY_CART_INCOMPLETE");
  return source[key];
}

function id(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("TASTY_CART_INVALID");
  return String(value);
}

function nullableId(value: unknown): string | null {
  return value === null ? null : id(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("TASTY_CART_INVALID");
  return value;
}

function line(value: unknown): TastyCartLine {
  const source = record(value);
  const gift = boolean(required(source, "is_gift"));
  const promocode = boolean(required(source, "is_promocode"));
  const itemData = required(source, "item_data");
  const active = boolean(required(source, "active"));
  const blocked = boolean(required(source, "is_blocked"));
  const type = required(source, "type");
  if (typeof type !== "string") fail("TASTY_CART_INVALID");
  if (
    gift ||
    promocode ||
    itemData !== null ||
    !active ||
    blocked ||
    (type !== "bean_coffee" && type !== "ground_coffee")
  ) {
    fail("TASTY_CART_UNSUPPORTED_LINE");
  }
  const quantity = required(source, "quantity");
  if (
    typeof quantity !== "number" ||
    !Number.isSafeInteger(quantity) ||
    quantity <= 0
  )
    fail("TASTY_CART_INVALID");
  const product = record(required(source, "product"));
  return {
    rowId: id(required(source, "id")),
    offerId: id(required(source, "offer_id")),
    productId: id(required(product, "id")),
    quantity,
    grindingId: nullableId(required(source, "grinding_id")),
    packageId: nullableId(required(source, "package_id")),
  };
}

export function decodeTastyCartResponse(body: unknown): TastyCartSnapshot {
  const source = record(body);
  const data = required(source, "data");
  if (!Array.isArray(data)) fail("TASTY_CART_INVALID");
  const meta = record(required(source, "meta"));
  if (data.length === 0) {
    for (const key of [
      "price",
      "price_without_discount",
      "weight",
      "coffee_weight",
      "tea_weight",
    ]) {
      const value = required(meta, key);
      if (typeof value !== "number" || !Number.isFinite(value) || value !== 0)
        fail("TASTY_CART_INVALID");
    }
  }
  const lines = data.map(line);
  if (new Set(lines.map((entry) => entry.rowId)).size !== lines.length)
    fail("TASTY_CART_INVALID");
  return {
    kind: lines.length === 0 ? "empty" : "nonempty",
    lines,
    completeness: "Unproven",
  };
}
