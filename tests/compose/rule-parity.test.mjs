import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRuleParity } from "../../scripts/check-rule-parity.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

void test("canonical TS7 rule-parity matrix is schema-checked and fail-closed", async () => {
  const result = await checkRuleParity(REPO_ROOT);
  assert.equal(result.rows, 12);
  assert.equal(result.uncoveredPolicy, "block-replacement");
});

void test("every uncovered rule class remains a blocking replacement gate", async () => {
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
  for (const row of uncovered) {
    assert.equal(row.uncoveredBlocksReplacement, true, row.id);
    assert.match(
      markdown,
      new RegExp(
        "\\| `" +
          row.id +
          "` /[\\s\\S]*?\\*\\*" +
          row.status +
          "\\*\\*[\\s\\S]*?`BLOCK`",
      ),
      row.id,
    );
  }
});
