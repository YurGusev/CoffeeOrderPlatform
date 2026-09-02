import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadCompatibilityMatrix } from "../../scripts/check-node26-compatibility.mjs";

void test("Node 26 compatibility matrix has one exact, schema-validated baseline", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const matrix = await loadCompatibilityMatrix(root);
  assert.equal(matrix.runtime.nodeRef, "config/toolchain-versions.json#/node");
  assert.equal(matrix.policy.singleCompilerRef, "config/toolchain-versions.json#/typescript");
  assert.equal(matrix.components.length, 7);
  assert.equal(
    new Set(matrix.components.map((component) => component.id)).size,
    7,
  );
  assert.equal(
    matrix.components.filter((component) => component.required).length,
    7,
  );
  assert.equal(matrix.policy.generatedContractSource, "effect-schema-httpapi");
  assert.equal(matrix.policy.generatedOpenApi, "3.1.0");
});

void test("canonical registry compatibility report has no independent codegen candidate", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["scripts/check-node26-compatibility.mjs", "--skip-native-load", "--json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.candidate, null);
});

void test("host compatibility gate defers only the Docker-built native addon", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["scripts/check-node26-compatibility.mjs", "--skip-native-load", "--json"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(
    report.components.find((component) => component.id === "confluent-kafka")
      ?.status,
    "deferred-to-image-build",
  );
});
