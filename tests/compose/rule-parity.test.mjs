import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRuleParity } from "../../scripts/check-rule-parity.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const compareText = (left, right) => left.localeCompare(right);

async function matrix() {
  const markdown = await readFile(
    resolve(REPO_ROOT, "docs/launch/25_TS7_LINT_RULE_PARITY.md"),
    "utf8",
  );
  const blockStart = markdown.indexOf("```json\n") + "```json\n".length;
  const blockEnd = markdown.indexOf("\n```", blockStart);
  return JSON.parse(markdown.slice(blockStart, blockEnd));
}

void test("canonical rule-parity matrix validates TS7 and complete Effect evidence", async () => {
  const result = await checkRuleParity(REPO_ROOT);
  assert.equal(result.rows, 12);
  assert.equal(result.effectDiagnostics, 22);
  assert.equal(result.effectArchitecture, 13);
  assert.equal(result.uncoveredPolicy, "block-replacement");
  await assert.rejects(
    () => checkRuleParity(REPO_ROOT, { admit: true }),
    /TS7-MISUSED-PROMISE: status GAP blocks replacement/,
  );
});

void test("every uncovered legacy rule class remains a blocking replacement gate", async () => {
  const document = await matrix();
  const uncovered = document.rows.filter(
    (row) => row.status === "GAP" || row.status === "PARTIAL",
  );
  assert.ok(uncovered.length > 0);
  for (const row of uncovered) {
    assert.equal(row.uncoveredBlocksReplacement, true, row.id);
  }
});

void test("Effect diagnostic and architecture sections are fully COVERED in 3.2", async () => {
  const document = await matrix();
  for (const row of [
    ...document.effectDiagnostics,
    ...document.effectArchitecture,
  ]) {
    assert.equal(row.status, "COVERED", row.id);
    assert.equal(row.uncoveredBlocksReplacement, true, row.id);
    assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0, row.id);
  }
});

void test("Effect diagnostic rows use exact configured diagnostic identity", async () => {
  const document = await matrix();
  const config = JSON.parse(
    await readFile(resolve(REPO_ROOT, "tsconfig.effect.json"), "utf8"),
  );
  const severity = config.compilerOptions.plugins.find(
    (plugin) => plugin.name === "@effect/language-service",
  ).diagnosticSeverity;

  assert.deepEqual(
    document.effectDiagnostics.map((row) => row.diagnostic).sort(compareText),
    Object.keys(severity).sort(compareText),
  );
  for (const row of document.effectDiagnostics) {
    assert.equal(row.id, `EFFECT-DIAG-${row.diagnostic}`);
    assert.equal(severity[row.diagnostic], "error");
  }
});
