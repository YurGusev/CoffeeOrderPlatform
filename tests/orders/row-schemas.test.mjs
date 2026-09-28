import assert from "node:assert/strict";
import test from "node:test";
import {decodeOrderItemRow, decodeOrderRow, OrderRowDecodeError} from "../../apps/orders-service/src/infrastructure/database/row-schemas.ts";

const order = {
  order_ref: `ord_${"0".repeat(26)}`,
  status: "Draft",
  version: "1",
  projection_version: "1",
  customer_ref: `cus_${"1".repeat(26)}`,
  customer_version: "1",
  customer_display_name: "Ada",
  customer_state: "Active",
  customer_state_proof_hash: "a".repeat(64),
  currency: null,
  confirmed_at: null,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
  created_by_actor_ref: "operator:ada",
  last_modified_by_actor_ref: "operator:ada",
};

const item = {
  order_ref: order.order_ref,
  item_ref: `itm_${"2".repeat(26)}`,
  line_position: 1,
  product_ref: `prd_${"3".repeat(26)}`,
  variant_ref: `var_${"4".repeat(26)}`,
  product_display_name: "Coffee",
  unit: "gram",
  quantity_milli: "2500",
  quote_ref: `prq_${"5".repeat(26)}`,
  quote_line_number: 1,
  quote_hash: "b".repeat(64),
  internal_proof_hash: "c".repeat(64),
  quote_expires_at: new Date("2026-01-02T00:00:00.000Z"),
  policy_version_ref: `pvr_${"6".repeat(26)}`,
  catalog_snapshot_revision: "0",
  mapping_revision: "0",
  offer_ref: `off_${"7".repeat(26)}`,
  unit_minor: "100",
  line_total_minor: "250",
  currency: "RUB",
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

void test("decodes complete PostgreSQL orders.orders row and rejects unknown/missing columns", () => {
  assert.deepEqual(decodeOrderRow(order), order);
  assert.deepEqual(decodeOrderRow({...order, status: "Confirmed", currency: "RUB", confirmed_at: new Date("2026-01-01T00:00:00.000Z")}), {...order, status: "Confirmed", currency: "RUB", confirmed_at: new Date("2026-01-01T00:00:00.000Z")});
  for (const row of [
    {...order, surprise: "unmapped"},
    Object.fromEntries(Object.entries(order).filter(([key]) => key !== "updated_at")),
  ]) {
    assert.throws(() => decodeOrderRow(row), (error) => error instanceof OrderRowDecodeError && error.code === "ORDER_DATABASE_DECODE_ERROR" && error.message === "ORDER_DATABASE_DECODE_ERROR");
  }
});

void test("orders row decoder rejects invalid persisted status, identities, money state, and bigint values", () => {
  for (const row of [
    {...order, status: "Cancelled"},
    {...order, order_ref: "ord_invalid"},
    {...order, version: "01"},
    {...order, customer_state: "Inactive"},
    {...order, currency: "USD"},
    {...order, status: "Confirmed", confirmed_at: null},
    {...order, status: "Confirmed", confirmed_at: new Date("2026-01-01T00:00:00.000Z")},
    {...order, projection_version: "9223372036854775808"},
  ]) {
    assert.throws(() => decodeOrderRow(row), OrderRowDecodeError);
  }
});

void test("decodes complete PostgreSQL orders.order_items row and rejects unknown/missing columns", () => {
  assert.deepEqual(decodeOrderItemRow(item), item);
  for (const row of [
    {...item, surprise: true},
    Object.fromEntries(Object.entries(item).filter(([key]) => key !== "updated_at")),
  ]) {
    assert.throws(() => decodeOrderItemRow(row), (error) => error instanceof OrderRowDecodeError && error.code === "ORDER_DATABASE_DECODE_ERROR" && error.message === "ORDER_DATABASE_DECODE_ERROR");
  }
});

void test("item decoder enforces schema checks and exact persisted arithmetic without leaking row data", () => {
  for (const row of [
    {...item, item_ref: "itm_invalid"},
    {...item, line_position: 101},
    {...item, unit: "ounce"},
    {...item, quantity_milli: "01"},
    {...item, quantity_milli: "1000000000", line_total_minor: "100000000"},
    {...item, quote_hash: "not-a-hash"},
    {...item, catalog_snapshot_revision: "-1"},
    {...item, unit_minor: "9223372036854775808"},
    {...item, line_total_minor: "249"},
    {...item, currency: "USD"},
    {...item, quote_expires_at: "not a timestamp"},
  ]) {
    assert.throws(() => decodeOrderItemRow(row), (error) => error instanceof OrderRowDecodeError && error.code === "ORDER_DATABASE_DECODE_ERROR" && error.message === "ORDER_DATABASE_DECODE_ERROR" && !error.message.includes(JSON.stringify(row)));
  }
});
