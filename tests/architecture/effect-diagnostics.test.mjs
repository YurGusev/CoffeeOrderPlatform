import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "tests/architecture/fixtures/effect-diagnostics",
);
const MANIFEST = JSON.parse(
  readFileSync(resolve(FIXTURE_ROOT, "manifest.json"), "utf8"),
);
const FIXTURE_PROJECT = resolve(REPO_ROOT, MANIFEST.project);
const compareText = (left, right) => left.localeCompare(right);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void test("RED Effect diagnostics: every language-service rule has executable evidence", () => {
  const result = spawnSync(
    "pnpm",
    ["exec", "effect-tsgo", "diagnostics", "--project", FIXTURE_PROJECT],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0, "RED diagnostic project must fail");

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const entry of MANIFEST.languageServiceDiagnostics) {
    assert.match(
      output,
      new RegExp(`effect\\(${escapeRegExp(entry.name)}\\)`, "i"),
      `pinned Effect diagnostics did not report ${entry.name} from ${entry.fixture}:\n${output}`,
    );
  }
});

void test("Effect diagnostic evidence manifest covers all configured mandatory rules", () => {
  const configured = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "tsconfig.effect.json"), "utf8"),
  ).compilerOptions.plugins.find(
    (plugin) => plugin.name === "@effect/language-service",
  ).diagnosticSeverity;

  const evidenced = new Set([
    ...MANIFEST.languageServiceDiagnostics.map((entry) => entry.name),
    ...MANIFEST.projectLevelDiagnostics.map((entry) => entry.name),
    ...MANIFEST.effect4ArchitectureReplacements.map((entry) => entry.name),
  ]);

  assert.deepEqual(
    [...evidenced].sort(compareText),
    Object.keys(configured).sort(compareText),
    "every mandatory configured diagnostic must have executable or explicitly justified v4 replacement evidence",
  );

  for (const entry of MANIFEST.languageServiceDiagnostics) {
    assert.ok(
      readFileSync(resolve(FIXTURE_ROOT, entry.fixture), "utf8").length > 0,
      `diagnostic fixture is missing or empty: ${entry.fixture}`,
    );
  }
});
