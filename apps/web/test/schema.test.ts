import assert from "node:assert/strict";
import { test } from "vitest";
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
