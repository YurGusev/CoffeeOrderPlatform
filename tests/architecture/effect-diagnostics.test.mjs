import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE_PROJECT = resolve(
  REPO_ROOT,
  "tests/architecture/fixtures/effect-diagnostics/tsconfig.json",
);

void test("RED Effect diagnostics: configured errors are emitted by the pinned language service", () => {
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
  for (const expected of [
    "floatingEffect",
    "missingEffectError",
    "missingEffectContext",
    "promiseInEffectSuccess",
  ]) {
    assert.match(
      output,
      new RegExp(expected, "i"),
      `pinned Effect diagnostics did not report ${expected}:\n${output}`,
    );
  }
});
