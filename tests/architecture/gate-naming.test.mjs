import assert from "node:assert/strict";
import test from "node:test";
import { violationsInSource } from "../../scripts/check-gate-naming.mjs";
import {
  GATE_SLUG_PATTERN,
  LEGACY_GATE_IDS,
  gateLabel,
  gateSlug,
} from "../../verification/launch/v1/gate-identity.mjs";

const gateNumber = (number) => `G${String(number).padStart(2, "0")}`;

function kinds(source) {
  return violationsInSource("tools/probe.mjs", source).map(
    ({ kind, match }) => `${kind}:${match}`,
  );
}

void test("номер гейта в идентификаторе, env-переменной и коде ошибки запрещён", () => {
  assert.deepEqual(kinds(`const scan${gateNumber(12)}Inventory = 1;\n`), [
    `identifier:scan${gateNumber(12)}Inventory`,
  ]);
  assert.deepEqual(
    kinds(`const name = "COFFEE_${gateNumber(12)}_CACHE_DIR";\n`).sort(),
    [
      `environment:COFFEE_${gateNumber(12)}_CACHE_DIR`,
      `identifier:COFFEE_${gateNumber(12)}_CACHE_DIR`,
    ],
  );
  assert.deepEqual(kinds(`fail("CONFIG-${gateNumber(8)}-SOPS-OUTPUT");\n`), [
    `error-code:CONFIG-${gateNumber(8)}-SOPS-OUTPUT`,
  ]);
});

void test("номер гейта в комментарии запрещён", () => {
  assert.deepEqual(kinds(`// ${gateNumber(12)} собирает образы\n`), [
    `comment:${gateNumber(12)}`,
  ]);
  assert.deepEqual(kinds(`# ${gateNumber(8)} миграции\n`), [
    `comment:${gateNumber(8)}`,
  ]);
  assert.deepEqual(kinds(` * ${gateNumber(14)} наблюдаемость\n`), [
    `comment:${gateNumber(14)}`,
  ]);
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

void test("старый id нормализуется в slug, неизвестный id — нет", () => {
  assert.equal(gateSlug("supply_chain"), "supply_chain");
  assert.equal(gateSlug("G12_SUPPLY_CHAIN"), "supply_chain");
  assert.equal(gateSlug("G99_UNKNOWN"), null);
  assert.equal(gateSlug(undefined), null);
  assert.equal(Object.isFrozen(LEGACY_GATE_IDS), true);
  for (const [legacy, slug] of Object.entries(LEGACY_GATE_IDS)) {
    assert.match(slug, GATE_SLUG_PATTERN);
    assert.equal(gateSlug(legacy), slug);
  }
});

void test("метка гейта вычисляется из позиции и slug", () => {
  assert.equal(gateLabel(0, "preflight"), "G00 preflight");
  assert.equal(gateLabel(8, "supply_chain"), "G08 supply_chain");
  assert.equal(gateLabel(9, "migrations"), "G09 migrations");
  assert.equal(gateLabel(19, "report"), "G19 report");
});
