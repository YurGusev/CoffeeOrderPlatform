#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = "docs/launch/25_TS7_LINT_RULE_PARITY.md";
const STATUSES = new Set(["COVERED", "PARTIAL", "GAP"]);
const compareText = (left, right) => left.localeCompare(right);

const EXPECTED_ROWS = Object.freeze([
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
]);

const EXPECTED_EFFECT_DIAGNOSTICS = Object.freeze([
  "floatingEffect",
  "floatingEffectInVitest",
  "missingEffectContext",
  "missingEffectError",
  "missingLayerContext",
  "promiseInEffectSuccess",
  "anyUnknownInErrorContext",
  "effectFnImplicitAny",
  "leakingRequirements",
  "multipleEffectProvide",
  "runEffectInsideEffect",
  "scopeInLayerEffect",
  "strictEffectProvide",
  "tryCatchInEffectGen",
  "unknownInEffectCatch",
  "globalErrorInEffectCatch",
  "globalErrorInEffectFailure",
  "abortControllerInEffect",
  "asyncFunction",
  "extendsNativeError",
  "duplicatePackage",
  "outdatedApi",
]);

const EXPECTED_EFFECT_ARCHITECTURE = Object.freeze([
  "EFFECT-ARCH-PRIMARY",
  "EFFECT-ARCH-RUN-BOUNDARY",
  "EFFECT-ARCH-PROVIDE-BOUNDARY",
  "EFFECT-ARCH-MODULE-ALLOWLIST",
  "EFFECT-ARCH-OWNER-LAYER",
  "EFFECT-ARCH-DURABILITY",
  "EFFECT-ARCH-UNSAFE-RETRY",
  "EFFECT-ARCH-SCOPED-FIBER",
  "EFFECT-ARCH-SCOPED-LAYER",
  "EFFECT-ARCH-SQL-BOUNDARY",
  "EFFECT-ARCH-CONTRACT-AUTHORITY",
  "EFFECT-ARCH-DIAGNOSTIC-WAIVER",
  "EFFECT-ARCH-LEGACY-INVENTORY",
]);

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

async function loadJson(path, rule) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(rule, `${path}: strict JSON required: ${error.message}`);
  }
}

function extractMatrix(markdown) {
  const marker = "```json\n";
  const start = markdown.indexOf(marker);
  if (start === -1) fail("RULE-PARITY-DOCUMENT", `${MATRIX_PATH}: canonical JSON block is missing`);
  const contentStart = start + marker.length;
  const end = markdown.indexOf("\n```", contentStart);
  if (end === -1) fail("RULE-PARITY-DOCUMENT", `${MATRIX_PATH}: canonical JSON block is not closed`);
  try {
    return JSON.parse(markdown.slice(contentStart, end));
  } catch (error) {
    fail("RULE-PARITY-DOCUMENT", `${MATRIX_PATH}: invalid canonical JSON: ${error.message}`);
  }
}

function exactSet(actual, expected, label) {
  const actualSorted = [...actual].sort(compareText);
  const expectedSorted = [...expected].sort(compareText);
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    fail(
      "RULE-PARITY-INVENTORY",
      `${label}: expected ${expectedSorted.join(", ")}; got ${actualSorted.join(", ")}`,
    );
  }
}

function validateEvidence(root, row, label) {
  if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
    fail("RULE-PARITY-EVIDENCE", `${label}: at least one evidence path is required`);
  }
  for (const evidence of row.evidence) {
    if (typeof evidence !== "string" || evidence.length === 0) {
      fail("RULE-PARITY-EVIDENCE", `${label}: evidence path must be a non-empty string`);
    }
    if (!existsSync(resolve(root, evidence))) {
      fail("RULE-PARITY-EVIDENCE", `${label}: evidence path does not exist: ${evidence}`);
    }
  }
}

function validateRows(root, rows, expectedIds, options = {}) {
  if (!Array.isArray(rows)) fail("RULE-PARITY-DOCUMENT", `${options.label}: array is required`);
  const ids = rows.map((row) => row?.id);
  if (new Set(ids).size !== ids.length) fail("RULE-PARITY-INVENTORY", `${options.label}: duplicate row id`);
  exactSet(ids, expectedIds, options.label);

  for (const row of rows) {
    if (!row || typeof row !== "object") fail("RULE-PARITY-DOCUMENT", `${options.label}: each row must be an object`);
    if (!STATUSES.has(row.status)) fail("RULE-PARITY-STATUS", `${row.id}: invalid status ${row.status}`);
    if (row.uncoveredBlocksReplacement !== true) {
      fail("RULE-PARITY-BLOCKING", `${row.id}: uncoveredBlocksReplacement must be true`);
    }
    validateEvidence(root, row, row.id);
    if (options.requireCovered && row.status !== "COVERED") {
      fail("RULE-PARITY-EFFECT-GAP", `${row.id}: Effect foundation row must be COVERED, got ${row.status}`);
    }
  }
}

async function validateEffectDiagnostics(root, matrix) {
  const config = await loadJson(resolve(root, "tsconfig.effect.json"), "RULE-PARITY-EFFECT-CONFIG");
  const plugins = config.compilerOptions?.plugins;
  const plugin = Array.isArray(plugins)
    ? plugins.find((entry) => entry?.name === "@effect/language-service")
    : undefined;
  if (!plugin) fail("RULE-PARITY-EFFECT-CONFIG", "@effect/language-service plugin is missing");

  const evidenceManifest = await loadJson(
    resolve(root, "tests/architecture/fixtures/effect-diagnostics/manifest.json"),
    "RULE-PARITY-EFFECT-EVIDENCE",
  );
  const languageService = new Set(
    (evidenceManifest.languageServiceDiagnostics ?? []).map((entry) => entry.name),
  );
  const projectLevel = new Set(
    (evidenceManifest.projectLevelDiagnostics ?? []).map((entry) => entry.name),
  );
  const replacements = new Set(
    (evidenceManifest.effect4ArchitectureReplacements ?? []).map((entry) => entry.name),
  );
  exactSet(
    new Set([...languageService, ...projectLevel, ...replacements]),
    EXPECTED_EFFECT_DIAGNOSTICS,
    "Effect diagnostic evidence manifest",
  );

  const diagnostics = matrix.effectDiagnostics;
  validateRows(
    root,
    diagnostics,
    EXPECTED_EFFECT_DIAGNOSTICS.map((diagnostic) => `EFFECT-DIAG-${diagnostic}`),
    { label: "effectDiagnostics", requireCovered: true },
  );

  const diagnosticNames = diagnostics.map((row) => row.diagnostic);
  exactSet(diagnosticNames, EXPECTED_EFFECT_DIAGNOSTICS, "effectDiagnostics.diagnostic");

  for (const row of diagnostics) {
    if (row.id !== `EFFECT-DIAG-${row.diagnostic}`) {
      fail("RULE-PARITY-INVENTORY", `${row.id}: id must match diagnostic ${row.diagnostic}`);
    }
    if (plugin.diagnosticSeverity?.[row.diagnostic] !== "error") {
      fail("RULE-PARITY-EFFECT-CONFIG", `${row.diagnostic}: diagnostic severity must be error`);
    }

    const expectedEnforcement = languageService.has(row.diagnostic)
      ? "language-service"
      : projectLevel.has(row.diagnostic)
        ? "project-checker"
        : "architecture-checker";
    if (row.enforcement !== expectedEnforcement) {
      fail(
        "RULE-PARITY-EFFECT-EVIDENCE",
        `${row.diagnostic}: expected enforcement ${expectedEnforcement}, got ${row.enforcement}`,
      );
    }
    if (expectedEnforcement !== "language-service" && typeof row.ruleId !== "string") {
      fail("RULE-PARITY-EFFECT-EVIDENCE", `${row.diagnostic}: project ruleId is required`);
    }
  }
}

function firstBlockingUncovered(matrix) {
  for (const group of [matrix.rows, matrix.effectDiagnostics, matrix.effectArchitecture]) {
    for (const row of group) {
      if (row.status !== "COVERED" && row.uncoveredBlocksReplacement) return row;
    }
  }
  return null;
}

export async function checkRuleParity(root = REPO_ROOT, options = {}) {
  const resolvedRoot = resolve(root);
  const markdown = await readFile(resolve(resolvedRoot, MATRIX_PATH), "utf8");
  const matrix = extractMatrix(markdown);

  if (matrix.schemaVersion !== 2) fail("RULE-PARITY-DOCUMENT", "schemaVersion must be 2");
  if (matrix.replacement !== "ESLint") fail("RULE-PARITY-DOCUMENT", "replacement must be ESLint");
  if (matrix.uncoveredPolicy !== "block-replacement") {
    fail("RULE-PARITY-DOCUMENT", "uncoveredPolicy must be block-replacement");
  }
  if (matrix.authority?.compiler !== "typescript@7.0.2") {
    fail("RULE-PARITY-AUTHORITY", "compiler authority must be typescript@7.0.2");
  }
  if (matrix.authority?.effectLanguageService !== "@effect/tsgo@0.39.0") {
    fail("RULE-PARITY-AUTHORITY", "Effect language-service authority must be @effect/tsgo@0.39.0");
  }
  if (matrix.authority?.oxlint !== "oxlint@1.80.0") {
    fail("RULE-PARITY-AUTHORITY", "Oxlint authority mismatch");
  }
  if (matrix.authority?.tsgolint !== "oxlint-tsgolint@7.0.2001") {
    fail("RULE-PARITY-AUTHORITY", "tsgolint authority mismatch");
  }

  validateRows(resolvedRoot, matrix.rows, EXPECTED_ROWS, { label: "rows" });
  await validateEffectDiagnostics(resolvedRoot, matrix);
  validateRows(
    resolvedRoot,
    matrix.effectArchitecture,
    EXPECTED_EFFECT_ARCHITECTURE,
    { label: "effectArchitecture", requireCovered: true },
  );

  if (options.admit) {
    const blocking = firstBlockingUncovered(matrix);
    if (blocking) {
      fail(
        "RULE-PARITY-ADMISSION",
        `${blocking.id}: status ${blocking.status} blocks replacement`,
      );
    }
  }

  return {
    rows: matrix.rows.length,
    effectDiagnostics: matrix.effectDiagnostics.length,
    effectArchitecture: matrix.effectArchitecture.length,
    uncoveredPolicy: matrix.uncoveredPolicy,
    replacement: matrix.replacement,
  };
}

function parseArguments(argv) {
  const rootIndex = argv.indexOf("--root");
  return {
    root: rootIndex === -1 ? REPO_ROOT : resolve(argv[rootIndex + 1]),
    admit: argv.includes("--admit"),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await checkRuleParity(options.root, { admit: options.admit });
    console.log(
      `rule parity ${options.admit ? "admission" : "check"}: OK `
      + `(${result.rows} TS/general rows, ${result.effectDiagnostics} Effect diagnostics, `
      + `${result.effectArchitecture} Effect architecture rows; ${result.uncoveredPolicy})`,
    );
  } catch (error) {
    console.error(`rule parity: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
