import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

void test("Node 26 executes a repository admin TypeScript script natively", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(process.execPath, ["scripts/native-ts-smoke.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    runtime: process.version,
    nativeTypeScript: true,
  });
});
