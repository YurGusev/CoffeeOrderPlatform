import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRuleParity } from "../../scripts/check-rule-parity.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

void test("canonical matrix keeps truth separate from #49 Effect admission", async () => {
  const result = await checkRuleParity(REPO_ROOT);
  assert.equal(result.rows, 23);
  assert.equal(result.effectRows, 11);
  assert.equal(result.effectAdmission, "ARCH-EFFECT-*");
  assert.equal(result.uncoveredPolicy, "block-replacement");
  const admitted = await checkRuleParity(REPO_ROOT, { admit: true });
  assert.equal(admitted.effectRows, 11);
});

void test("truth-matrix GAP/PARTIAL rows remain blocking replacement markers", async () => {
  const markdown = await readFile(
    resolve(REPO_ROOT, "docs/launch/25_TS7_LINT_RULE_PARITY.md"),
    "utf8",
  );
  const blockStart = markdown.indexOf("```json\n") + "```json\n".length;
  const blockEnd = markdown.indexOf("\n```", blockStart);
  const matrix = JSON.parse(markdown.slice(blockStart, blockEnd));
  const uncovered = matrix.rows.filter(
    (row) => row.status === "GAP" || row.status === "PARTIAL",
  );
  assert.ok(uncovered.length > 0);
  assert.equal(
    matrix.rows.find((row) => row.id === "TS7-MISUSED-PROMISE").status,
    "GAP",
  );
  for (const row of uncovered) {
    assert.equal(row.uncoveredBlocksReplacement, true, row.id);
  }
});
