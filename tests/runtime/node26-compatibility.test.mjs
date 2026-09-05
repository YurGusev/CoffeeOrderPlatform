import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadCompatibilityMatrix } from "../../scripts/check-node26-compatibility.mjs";

void test("Node 26 compatibility matrix has one exact, schema-validated baseline", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const matrix = await loadCompatibilityMatrix(root);
  assert.equal(matrix.runtime.node, "26.8.1");
  assert.equal(matrix.policy.singleCompiler, "typescript@7.0.2");
  assert.equal(matrix.components.length, 8);
  assert.equal(
    new Set(matrix.components.map((component) => component.id)).size,
    8,
  );
  assert.equal(
    matrix.components.filter((component) => component.required).length,
    7,
  );
  assert.equal(
    matrix.components.find((component) => component.id === "openapi-codegen")
      ?.authoritative,
    false,
  );
});

void test("candidate OpenAPI codegen is reported as blocked by its TypeScript 7 load failure", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    ["scripts/check-node26-compatibility.mjs", "--json"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  const output = result.stdout.trim() || result.stderr.trim();
  assert.notEqual(output, "", result.stderr);
  const report = JSON.parse(output);
  assert.equal(report.candidate?.id, "openapi-codegen");
  assert.equal(report.candidate?.status, "blocked");
  assert.match(
    report.candidate?.details?.reason ?? "",
    /sole TypeScript 7 compiler/,
  );
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
