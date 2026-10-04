import assert from "node:assert/strict";
import { test } from "vitest";
import { clientV1Schemas } from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";
import { assertSchema } from "../src/browser/api/schema.js";

test("runtime validator enforces every allOf branch", () => {
  const schema = {
    allOf: [
      { required: ["kind"], properties: { kind: { const: "catalog" } }, type: "object" },
      { required: ["imageUrl"], properties: { imageUrl: { format: "uri", type: "string" } }, type: "object" },
    ],
  } as const;
  assert.deepEqual(assertSchema(schema, { kind: "catalog", imageUrl: "https://example.invalid/image.png" }, "fixture"), {
    kind: "catalog",
    imageUrl: "https://example.invalid/image.png",
  });
  assert.throws(() => assertSchema(schema, { kind: "catalog", imageUrl: "not a valid uri" }, "fixture"), /некорректный uri/u);
  assert.throws(() => assertSchema(schema, { kind: "other", imageUrl: "https://example.invalid/image.png" }, "fixture"), /фиксированное значение/u);
});

test("OrderItem requires grind hash and display name together", () => {
  const schema = clientV1Schemas.OrderCardResponse.properties.items.items;
  const item = {
    itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    linePosition: 1,
    productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    displayName: "Кофе",
    quantity: "1",
    unit: "piece",
    quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    quoteLineNumber: 1,
    unitMinor: "100",
    lineTotalMinor: "100",
  };
  assert.doesNotThrow(() => assertSchema(schema, item, "OrderItem"));
  assert.throws(() => assertSchema(schema, { ...item, sourceGrindKeyHash: "a".repeat(64) }, "OrderItem"), /обязательное поле отсутствует/u);
  assert.throws(() => assertSchema(schema, { ...item, grindDisplayName: "Мелкий" }, "OrderItem"), /обязательное поле отсутствует/u);
});
