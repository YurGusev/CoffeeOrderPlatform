import assert from "node:assert/strict";
import { test } from "vitest";
import { formatPrivatePhone } from "../src/browser/api/format.js";

test("formatPrivatePhone preserves only a short operator-safe hint", () => {
  assert.equal(formatPrivatePhone("+79999994567"), "+799••••4567");
  assert.equal(formatPrivatePhone("invalid"), "Телефон скрыт");
});
