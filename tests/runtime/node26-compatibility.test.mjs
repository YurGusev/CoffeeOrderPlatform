import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

void test("точный кандидат OpenAPI codegen загружается с единственным TS7", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      "scripts/check-node26-compatibility.mjs",
      "--skip-native-load",
      "--strict-candidate",
      "--json",
    ],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim() || result.stderr.trim();
  assert.notEqual(output, "", result.stderr);
  const report = JSON.parse(output);
  assert.equal(report.candidate?.id, "openapi-codegen");
  assert.equal(report.candidate?.status, "candidate-loaded");
});

void test("кандидат генерирует повторяемые transport types, компилируемые строгим TS7", async (t) => {
  const { createClient } = await import("@hey-api/openapi-ts");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "coffee-codegen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = {
    openapi: "3.2.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: "Проверка допуска генератора", version: "1.0.0" },
    paths: {
      "/probe": {
        post: {
          operationId: "probe",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Card" },
              },
            },
          },
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Result" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Version: { type: "string", pattern: "^(0|[1-9][0-9]*)$" },
        Card: {
          type: "object",
          additionalProperties: false,
          required: ["version", "state", "cause"],
          properties: {
            version: { $ref: "#/components/schemas/Version" },
            state: { type: "string", enum: ["Draft", "Confirmed"] },
            cause: { type: ["string", "null"] },
            optional: { type: "string" },
          },
        },
        Result: {
          oneOf: [
            { $ref: "#/components/schemas/Card" },
            {
              type: "object",
              additionalProperties: false,
              required: ["code"],
              properties: { code: { type: "string", const: "REJECTED" } },
            },
          ],
        },
      },
    },
  };
  for (const output of ["a", "b"])
    await createClient({
      input,
      output: { path: join(directory, output), module: { extension: ".js" } },
      plugins: ["@hey-api/typescript"],
    });
  for (const output of ["a", "b"])
    assert.deepEqual((await readdir(join(directory, output))).sort(), [
      "index.ts",
      "types.gen.ts",
    ]);
  for (const file of ["index.ts", "types.gen.ts"])
    assert.equal(
      await readFile(join(directory, "a", file), "utf8"),
      await readFile(join(directory, "b", file), "utf8"),
    );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    join(directory, "check.ts"),
    `
import type { Card, Result, ProbeData } from './a/index.js';
const card: Card = { version: '1', state: 'Draft', cause: null };
const result: Result = { code: 'REJECTED' };
const request: ProbeData = { body: card, url: '/probe' };
// @ts-expect-error Версия остаётся decimal string.
const numeric: Card = { ...card, version: 1 };
// @ts-expect-error State остаётся закрытым union.
const invalid: Card = { ...card, state: 'Unknown' };
// @ts-expect-error Required не теряется.
const missing: Card = { version: '1', state: 'Draft' };
void [result, request, numeric, invalid, missing];
`,
  );
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: { noEmit: true, types: [] },
      include: ["**/*.ts"],
    }),
  );
  const compile = spawnSync(
    join(root, "node_modules/.bin/tsc"),
    ["-p", join(directory, "tsconfig.json")],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(compile.status, 0, compile.stdout || compile.stderr);
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
