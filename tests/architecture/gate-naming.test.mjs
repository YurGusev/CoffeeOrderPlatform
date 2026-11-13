import assert from "node:assert/strict";
import test from "node:test";
import {
  isOpaqueToken,
  pathViolation,
  violationsInSource,
} from "../../scripts/check-gate-naming.mjs";
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
  const probeEnv = `COFFEE_${gateNumber(13)}_REQUEST_DIR`;
  assert.deepEqual(kinds(`const name = "${probeEnv}";\n`).sort(), [
    `environment:${probeEnv}`,
    `identifier:${probeEnv}`,
  ]);
  assert.deepEqual(kinds(`fail("CONFIG-${gateNumber(8)}-SOPS-OUTPUT");\n`), [
    `gate-number:${gateNumber(8)}`,
    `error-code:CONFIG-${gateNumber(8)}-SOPS-OUTPUT`,
  ]);
});

void test("номер гейта в комментарии запрещён", () => {
  for (const number of [12, 8, 14]) {
    const line = `// ${gateNumber(number)} собирает образы\n`;
    assert.deepEqual(kinds(line), [
      `gate-number:${gateNumber(number)}`,
      `comment:${gateNumber(number)}`,
    ]);
  }
  for (const number of [8, 14]) {
    const line = `# ${gateNumber(number)} миграции\n`;
    assert.deepEqual(kinds(line), [
      `gate-number:${gateNumber(number)}`,
      `comment:${gateNumber(number)}`,
    ]);
  }
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
  assert.deepEqual(kinds("const hash = 'a'.repeat(64) + 'G12';\n"), [
    "gate-number:G12",
  ]);
});

void test("старый id нормализуется в slug, неизвестный id — нет", () => {
  assert.equal(gateSlug("supply_chain"), "supply_chain");
  assert.equal(gateSlug("supply_chain"), "supply_chain");
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

void test("номер гейта в имени файла запрещён", () => {
  assert.deepEqual(pathViolation("tools/browser-scan.mjs"), null);
  assert.equal(
    pathViolation(`tools/${gateNumber(15)}-browser-scan.mjs`)?.kind,
    "path",
  );
  assert.equal(
    pathViolation(`tests/tools/${gateNumber(15)}-browser-proof.test.mjs`)?.path,
    `tests/tools/${gateNumber(15)}-browser-proof.test.mjs`,
  );
});

void test("каждое слово camelCase-имени проверяется, случайная строка — нет", () => {
  assert.equal(
    isOpaqueToken(`create${gateNumber(14)}BrowserNetworkMonitor`),
    false,
  );
  assert.equal(isOpaqueToken(`${"a".repeat(64)}`), true);
  assert.equal(isOpaqueToken("5f2d9b1c7a4e8f30d6b2"), true);
  assert.equal(isOpaqueToken("aGVsbG8td29ybGQtdGhpcy1pcy1iYXNlNjQ"), true);
});
