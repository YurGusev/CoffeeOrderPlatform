#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MATRIX_PATH = "docs/launch/25_TS7_LINT_RULE_PARITY.md";
const EXPECTED_IDS = [
  "JS-CORRECTNESS",
  "TS7-PROMISE",
  "TS7-MISUSED-PROMISE",
  "TS7-UNSAFE-ANY",
  "TS7-EXHAUSTIVE-SWITCH",
  "ARCH-SYNC-API",
  "TS7-EVAL",
  "TS7-ESM",
  "TS7-ERASABLE",
  "TS7-BRAND-CAST",
  "BOUNDARIES",
  "ARCH-FORBIDDEN",
];
const STATUSES = new Set(["COVERED", "PARTIAL", "GAP"]);

function fail(message) {
  throw new Error("RULE-PARITY " + message);
}

function extractMatrix(markdown) {
  const sectionStart = markdown.indexOf("## 3. Rule-parity matrix");
  if (sectionStart < 0) fail(MATRIX_PATH + ": matrix section is missing");
  const jsonStart = markdown.indexOf("```json\n", sectionStart);
  if (jsonStart < 0) fail(MATRIX_PATH + ": canonical JSON block is missing");
  const contentStart = jsonStart + "```json\n".length;
  const contentEnd = markdown.indexOf("\n```", contentStart);
  if (contentEnd < 0)
    fail(MATRIX_PATH + ": canonical JSON block is unterminated");
  try {
    return {
      matrix: JSON.parse(markdown.slice(contentStart, contentEnd)),
      table: markdown.slice(sectionStart, jsonStart),
    };
  } catch (error) {
    fail(MATRIX_PATH + ": canonical JSON is invalid: " + error.message);
  }
}

function assertExact(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      label +
        ": expected " +
        JSON.stringify(expected) +
        ", got " +
        JSON.stringify(actual),
    );
  }
}

function registryValue(registry, reference, label) {
  const prefix = "config/toolchain-versions.json#/";
  if (!reference.startsWith(prefix)) fail(`${label}: canonical registry reference is required`);
  const key = reference.slice(prefix.length);
  if (!Object.hasOwn(registry, key) || typeof registry[key] !== "string" || registry[key].length === 0)
    fail(`${label}: registry key is missing: ${key}`);
  return registry[key];
}

async function assertEvidence(root, row) {
  if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
    fail(row.id + ": evidence must contain at least one repository path");
  }
  for (const path of row.evidence) {
    if (typeof path !== "string" || path.length === 0)
      fail(row.id + ": invalid evidence path");
    try {
      await stat(join(root, path));
    } catch {
      fail(row.id + ": evidence path does not exist: " + path);
    }
  }
}

export async function checkRuleParity(root = REPO_ROOT, { admit = false } = {}) {
  const markdown = await readFile(join(root, MATRIX_PATH), "utf8");
  const registry = JSON.parse(await readFile(join(root, "config/toolchain-versions.json"), "utf8"));
  const { matrix, table } = extractMatrix(markdown);
  assertExact(matrix.schemaVersion, 1, "schemaVersion");
  assertExact(
    matrix.authority,
    {
      compilerRef: "config/toolchain-versions.json#/typescript",
      oxlintRef: "config/toolchain-versions.json#/oxlint",
      tsgolintRef: "config/toolchain-versions.json#/oxlintTsgolint",
      diagnosticParityTest: "tests/architecture/checks.test.mjs",
    },
    "authority",
  );
  registryValue(registry, matrix.authority.compilerRef, "authority.compilerRef");
  registryValue(registry, matrix.authority.oxlintRef, "authority.oxlintRef");
  registryValue(registry, matrix.authority.tsgolintRef, "authority.tsgolintRef");
  assertExact(matrix.replacement, "ESLint", "replacement");
  assertExact(matrix.uncoveredPolicy, "block-replacement", "uncoveredPolicy");
  if (!Array.isArray(matrix.rows)) fail("rows must be an array");
  assertExact(
    matrix.rows.map((row) => row.id),
    EXPECTED_IDS,
    "row IDs",
  );
  if (new Set(matrix.rows.map((row) => row.id)).size !== matrix.rows.length) {
    fail("row IDs must be unique");
  }
  for (const row of matrix.rows) {
    if (!row || typeof row !== "object") fail("each row must be an object");
    if (!STATUSES.has(row.status))
      fail((row.id ?? "unknown") + ": invalid status " + row.status);
    if (admit && matrix.uncoveredPolicy === "block-replacement" && row.status !== "COVERED") {
      fail(row.id + ": status " + row.status + " blocks replacement");
    }
    if (row.uncoveredBlocksReplacement !== true) {
      fail(row.id + ": uncoveredBlocksReplacement must be true");
    }
    const tableRow = table
      .split("\n")
      .find((line) => line.startsWith("| `" + row.id + "` /"));
    if (!tableRow) fail(row.id + ": human-readable matrix row is missing");
    if (!tableRow.includes("**" + row.status + "**")) {
      fail(row.id + ": human-readable status is missing");
    }
    if (!tableRow.includes("`BLOCK`"))
      fail(row.id + ": human-readable severity must be BLOCK");
    await assertEvidence(root, row);
  }
  return {
    matrixPath: MATRIX_PATH,
    rows: matrix.rows.length,
    uncoveredPolicy: matrix.uncoveredPolicy,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf("--root");
  const root =
    rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : REPO_ROOT;
  const admit = process.argv.includes("--admit");
  try {
    const result = await checkRuleParity(root, { admit });
    console.log(
      (admit ? "rule parity admission: OK (" : "rule parity check: OK (") +
        result.rows +
        " canonical rows; " +
        result.uncoveredPolicy +
        ")",
    );
  } catch (error) {
    console.error("rule parity: FAIL: " + error.message);
    process.exitCode = 1;
  }
}
