export type TastyCatalogOption = Readonly<{ id: string; name: string }>;

export type TastyCatalogOffer = Readonly<{
  id: string;
  name: string;
  type: string | null;
  priceRaw: string;
  discountRaw: string | null;
  weightRaw: string;
  maxQuantityRaw: string;
  notAvailable: boolean;
  availableAt: string | null;
  grindings: readonly TastyCatalogOption[];
  packages: readonly TastyCatalogOption[];
}>;

export type TastyCatalogProduct = Readonly<{
  id: string;
  name: string;
  type: string | null;
  notAvailable: boolean;
  availableAt: string | null;
  quantityKgRaw: string;
  offers: readonly TastyCatalogOffer[];
}>;

export type TastyCatalogResponse = Readonly<{
  products: readonly TastyCatalogProduct[];
}>;

export type TastyCatalogErrorCode =
  | "TASTY_CATALOG_INCOMPLETE"
  | "TASTY_CATALOG_INVALID"
  | "TASTY_CATALOG_MONEY_NOT_PROVEN";

export class TastyCatalogDecodeError extends Error {
  readonly code: TastyCatalogErrorCode;

  constructor(code: TastyCatalogErrorCode) {
    super(code);
    this.name = "TastyCatalogDecodeError";
    this.code = code;
  }
}

const NUMBER_SOURCE = Symbol("number-source");
type NumberSource = Readonly<{ [NUMBER_SOURCE]: string; value: number }>;

function fail(code: TastyCatalogErrorCode): never {
  throw new TastyCatalogDecodeError(code);
}

function numberSource(value: unknown): value is NumberSource {
  return value !== null && typeof value === "object" && NUMBER_SOURCE in value;
}

function record(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    numberSource(value)
  )
    return fail("TASTY_CATALOG_INVALID");
  return value as Record<string, unknown>;
}

function required(source: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(source, key)) return fail("TASTY_CATALOG_INCOMPLETE");
  return source[key];
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return fail("TASTY_CATALOG_INVALID");
  return value;
}

function text(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.isWellFormed() ||
    value.includes("\u0000")
  )
    return fail("TASTY_CATALOG_INVALID");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return fail("TASTY_CATALOG_INVALID");
  return value;
}

function id(value: unknown): string {
  if (
    !numberSource(value) ||
    !/^[1-9][0-9]*$/u.test(value[NUMBER_SOURCE]) ||
    !Number.isSafeInteger(value.value)
  )
    return fail("TASTY_CATALOG_INVALID");
  return value[NUMBER_SOURCE];
}

function rawNumber(value: unknown, monetary = false): string {
  if (!numberSource(value)) return fail("TASTY_CATALOG_INVALID");
  const raw = value[NUMBER_SOURCE];
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw))
    return fail(
      monetary ? "TASTY_CATALOG_MONEY_NOT_PROVEN" : "TASTY_CATALOG_INVALID",
    );
  return raw;
}

function options(value: unknown): readonly TastyCatalogOption[] {
  return array(value).map((entry) => {
    const option = record(entry);
    return {
      id: id(required(option, "id")),
      name: text(required(option, "name")),
    };
  });
}

function offer(value: unknown): TastyCatalogOffer {
  const source = record(value);
  const discount = required(source, "discount");
  return {
    id: id(required(source, "id")),
    name: text(required(source, "name")),
    type: nullableText(required(source, "type")),
    priceRaw: rawNumber(required(source, "price"), true),
    discountRaw: discount === null ? null : rawNumber(discount, true),
    weightRaw: rawNumber(required(source, "weight")),
    maxQuantityRaw: rawNumber(required(source, "max_quantity")),
    notAvailable: bool(required(source, "not_available")),
    availableAt: nullableText(required(source, "available_at")),
    grindings: options(required(source, "grindings")),
    packages: options(required(source, "packages")),
  };
}

function product(value: unknown): TastyCatalogProduct {
  const source = record(value);
  return {
    id: id(required(source, "id")),
    name: text(required(source, "name")),
    type: nullableText(required(source, "type")),
    notAvailable: bool(required(source, "not_available")),
    availableAt: nullableText(required(source, "available_at")),
    quantityKgRaw: rawNumber(required(source, "quantity_kg")),
    offers: array(required(source, "offers")).map(offer),
  };
}

export function decodeTastyCatalogResponse(
  body: unknown,
): TastyCatalogResponse {
  if (
    body === undefined ||
    body === null ||
    (typeof body === "string" && body.trim().length === 0)
  )
    return fail("TASTY_CATALOG_INCOMPLETE");
  if (typeof body !== "string")
    return fail(
      typeof body === "object"
        ? "TASTY_CATALOG_MONEY_NOT_PROVEN"
        : "TASTY_CATALOG_INVALID",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      body,
      (_key: string, value: unknown, context?: { source: string }): unknown => {
        if (typeof value !== "number") return value;
        if (context === undefined)
          return fail("TASTY_CATALOG_MONEY_NOT_PROVEN");
        return { [NUMBER_SOURCE]: context.source, value };
      },
    ) as unknown;
  } catch (error) {
    if (error instanceof TastyCatalogDecodeError) throw error;
    return fail("TASTY_CATALOG_INVALID");
  }
  const root = record(parsed);
  const products = array(required(root, "data"));
  record(required(root, "meta"));
  return { products: products.map(product) };
}
