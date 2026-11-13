import assert from "node:assert/strict";
import test from "node:test";
import { violationsInSource } from "../../scripts/check-gate-naming.mjs";

function kinds(source) {
  return violationsInSource("tools/probe.mjs", source).map(
    ({ kind, match }) => `${kind}:${match}`,
  );
}

void test("номер гейта в идентификаторе, env-переменной и коде ошибки запрещён", () => {
  assert.deepEqual(kinds("const scanG12Inventory = 1;\n"), [
    "identifier:scanG12Inventory",
  ]);
  assert.deepEqual(kinds('const name = "COFFEE_G12_CACHE_DIR";\n').sort(), [
    "environment:COFFEE_G12_CACHE_DIR",
    "identifier:COFFEE_G12_CACHE_DIR",
  ]);
  assert.deepEqual(kinds('fail("CONFIG-G08-SOPS-OUTPUT");\n'), [
    "error-code:CONFIG-G08-SOPS-OUTPUT",
  ]);
});

void test("номер гейта в комментарии запрещён", () => {
  assert.deepEqual(kinds("// G12 собирает образы\n"), ["comment:G12"]);
  assert.deepEqual(kinds("# G08 миграции\n"), ["comment:G08"]);
  assert.deepEqual(kinds(" * G14 наблюдаемость\n"), ["comment:G14"]);
});

void test("slug-имена и обычный текст конвенцию не нарушают", () => {
  assert.deepEqual(kinds("const supplyChainInventory = 1;\n"), []);
  assert.deepEqual(kinds('const name = "COFFEE_SCAN_CACHE_DIR";\n'), []);
  assert.deepEqual(kinds("// гейт supply_chain собирает образы\n"), []);
  assert.deepEqual(kinds('fail("CONFIG-MIGRATIONS-SOPS-OUTPUT");\n'), []);
});

void test("хеши и случайные fixture-строки не считаются именами гейтов", () => {
  assert.deepEqual(
    kinds("const digest = 'MLG12IM7qQUyLTcrmGPs48s5mCiC9e';\n"),
    [],
  );
  assert.deepEqual(kinds("const hash = 'a'.repeat(64) + 'G12';\n"), []);
});
