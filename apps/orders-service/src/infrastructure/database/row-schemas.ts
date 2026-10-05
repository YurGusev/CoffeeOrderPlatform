import {Ajv2020} from "ajv/dist/2020.js";
import type {ValidateFunction} from "ajv";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const REF = (prefix: string): string => `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`;
const HASH = "^[0-9a-f]{64}$";
const INT64_POSITIVE = "^[1-9][0-9]*$";
const INT64_NONNEGATIVE = "^(?:0|[1-9][0-9]*)$";

export type OrderRow = Readonly<{
  order_ref: string;
  status: "Draft" | "Confirmed";
  version: string;
  projection_version: string;
  customer_ref: string;
  customer_version: string;
  customer_display_name: string;
  customer_state: "Active";
  customer_state_proof_hash: string;
  currency: "RUB" | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  created_by_actor_ref: string;
  last_modified_by_actor_ref: string;
}>;

export type OrderItemRow = Readonly<{
  order_ref: string;
  item_ref: string;
  line_position: number;
  product_ref: string;
  variant_ref: string;
  product_display_name: string;
  unit: "piece" | "gram" | "kilogram";
  quantity_milli: string;
  quote_ref: string;
  quote_line_number: number;
  quote_hash: string;
  internal_proof_hash: string;
  quote_expires_at: Date;
  policy_version_ref: string;
  catalog_snapshot_revision: string;
  mapping_revision: string;
  offer_ref: string;
  unit_minor: string;
  source_grind_key_hash: string | null;
  grind_display_name: string | null;
  line_total_minor: string;
  currency: "RUB";
  created_at: Date;
  updated_at: Date;
}>;

export class OrderRowDecodeError extends Error {
  public readonly code = "ORDER_DATABASE_DECODE_ERROR" as const;
  public constructor() {
    super("ORDER_DATABASE_DECODE_ERROR");
    this.name = "OrderRowDecodeError";
  }
}

const orderRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "order_ref", "status", "version", "projection_version", "customer_ref",
    "customer_version", "customer_display_name", "customer_state",
    "customer_state_proof_hash", "currency", "confirmed_at", "created_at",
    "updated_at", "created_by_actor_ref", "last_modified_by_actor_ref",
  ],
  properties: {
    order_ref: {type: "string", pattern: REF("ord"), maxLength: 30},
    status: {type: "string", enum: ["Draft", "Confirmed"]},
    version: {type: "string", pattern: INT64_POSITIVE, format: "positive-int64"},
    projection_version: {type: "string", pattern: INT64_POSITIVE, format: "positive-int64"},
    customer_ref: {type: "string", pattern: REF("cus"), maxLength: 30},
    customer_version: {type: "string", pattern: INT64_POSITIVE, format: "positive-int64"},
    customer_display_name: {type: "string", minLength: 1, maxLength: 200},
    customer_state: {type: "string", const: "Active"},
    customer_state_proof_hash: {type: "string", pattern: HASH, maxLength: 64},
    currency: {type: ["string", "null"], enum: ["RUB", null]},
    confirmed_at: {type: ["object", "null"]},
    created_at: {type: "object"},
    updated_at: {type: "object"},
    created_by_actor_ref: {type: "string", minLength: 1, maxLength: 128},
    last_modified_by_actor_ref: {type: "string", minLength: 1, maxLength: 128},
  },
} as const;

const orderItemRowSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "order_ref", "item_ref", "line_position", "product_ref", "variant_ref",
    "product_display_name", "unit", "quantity_milli", "quote_ref",
    "quote_line_number", "quote_hash", "internal_proof_hash", "quote_expires_at",
    "policy_version_ref", "catalog_snapshot_revision", "mapping_revision",
    "offer_ref", "unit_minor", "source_grind_key_hash", "grind_display_name", "line_total_minor", "currency", "created_at", "updated_at",
  ],
  properties: {
    order_ref: {type: "string", pattern: REF("ord"), maxLength: 30},
    item_ref: {type: "string", pattern: REF("itm"), maxLength: 30},
    line_position: {type: "integer", minimum: 1, maximum: 100},
    product_ref: {type: "string", pattern: REF("prd"), maxLength: 30},
    variant_ref: {type: "string", pattern: REF("var"), maxLength: 30},
    product_display_name: {type: "string", minLength: 1},
    unit: {type: "string", enum: ["piece", "gram", "kilogram"]},
    quantity_milli: {type: "string", pattern: INT64_POSITIVE, format: "positive-int64"},
    quote_ref: {type: "string", pattern: REF("prq"), maxLength: 30},
    quote_line_number: {type: "integer", minimum: 1, maximum: 100},
    quote_hash: {type: "string", pattern: HASH, maxLength: 64},
    internal_proof_hash: {type: "string", pattern: HASH, maxLength: 64},
    quote_expires_at: {type: "object"},
    policy_version_ref: {type: "string", pattern: REF("pvr"), maxLength: 30},
    catalog_snapshot_revision: {type: "string", pattern: INT64_NONNEGATIVE, format: "nonnegative-int64"},
    mapping_revision: {type: "string", pattern: INT64_NONNEGATIVE, format: "nonnegative-int64"},
    offer_ref: {type: "string", pattern: REF("off"), maxLength: 30},
    source_grind_key_hash: {type: ["string", "null"], pattern: HASH},
    grind_display_name: {type: ["string", "null"], minLength: 1, maxLength: 200},
    unit_minor: {type: "string", pattern: INT64_NONNEGATIVE, format: "nonnegative-int64"},
    line_total_minor: {type: "string", pattern: INT64_NONNEGATIVE, format: "nonnegative-int64"},
    currency: {type: "string", const: "RUB"},
    created_at: {type: "object"},
    updated_at: {type: "object"},
  },
} as const;

const ajv = new Ajv2020({allErrors: true, strict: true});
ajv.addFormat("positive-int64", {
  type: "string",
  validate: (value: string): boolean => {
    try { return BigInt(value) <= MAX_INT64; } catch { return false; }
  },
});
ajv.addFormat("nonnegative-int64", {
  type: "string",
  validate: (value: string): boolean => {
    try { return BigInt(value) <= MAX_INT64; } catch { return false; }
  },
});

const validateOrderRow: ValidateFunction = ajv.compile(orderRowSchema);
const validateOrderItemRow: ValidateFunction = ajv.compile(orderItemRowSchema);

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function invalidRow(): never {
  throw new OrderRowDecodeError();
}

export function decodeOrderRow(value: unknown): OrderRow {
  if (!validateOrderRow(value)) invalidRow();
  const row = value as OrderRow;
  if (!isValidDate(row.created_at) || !isValidDate(row.updated_at)) invalidRow();
  if (row.confirmed_at !== null && !isValidDate(row.confirmed_at)) invalidRow();
  if ((row.status === "Draft") !== (row.confirmed_at === null)) invalidRow();
  if (row.status === "Confirmed" && row.currency !== "RUB") invalidRow();
  return row;
}

export function decodeOrderItemRow(value: unknown): OrderItemRow {
  if (!validateOrderItemRow(value)) invalidRow();
  const row = value as OrderItemRow;
  if (!isValidDate(row.quote_expires_at) || !isValidDate(row.created_at) || !isValidDate(row.updated_at)) invalidRow();
  if ((row.source_grind_key_hash === null) !== (row.grind_display_name === null)) invalidRow();
  if (BigInt(row.quantity_milli) > 999_999_999n) invalidRow();
  const expectedTotal = (BigInt(row.unit_minor) * BigInt(row.quantity_milli) + 999n) / 1000n;
  if (BigInt(row.line_total_minor) !== expectedTotal) invalidRow();
  return row;
}
