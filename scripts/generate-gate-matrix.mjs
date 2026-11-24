#!/usr/bin/env node
/**
 * Генерирует EXPECTED_GATES из matrix.yaml, чтобы список гейтов имел один
 * источник истины. --check сверяет байты и не пишет файл.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { format as formatPrettier } from "prettier";
import { GATE_SLUG_PATTERN } from "./launch-support/gate-identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX_PATH = resolve(ROOT, "verification/launch/v1/matrix.yaml");
const OUTPUT_PATH = resolve(
  ROOT,
  "verification/launch/v1/gate-matrix.generated.mjs",
);
const EXPECTED_GATE_COUNT = 20;

function readMatrix(source) {
  const matrix = parseYaml(source);
  if (
    matrix?.version !== 1 ||
    !Array.isArray(matrix.gates) ||
    matrix.gates.length !== EXPECTED_GATE_COUNT
  )
    throw new Error(
      `matrix.yaml должен содержать version 1 и ровно ${EXPECTED_GATE_COUNT} гейтов`,
    );
  const ids = new Set();
  return matrix.gates.map((gate) => {
    if (typeof gate.id !== "string" || !GATE_SLUG_PATTERN.test(gate.id))
      throw new Error(`matrix.yaml: id гейта не является slug: ${gate.id}`);
    if (ids.has(gate.id))
      throw new Error(`matrix.yaml: повторный id гейта: ${gate.id}`);
    ids.add(gate.id);
    if (typeof gate.command !== "string" || !gate.command.trim())
      throw new Error(`matrix.yaml: пустая команда гейта ${gate.id}`);
    if (!Number.isInteger(gate.timeout) || gate.timeout < 1)
      throw new Error(`matrix.yaml: некорректный timeout гейта ${gate.id}`);
    return [gate.id, gate.command, gate.timeout];
  });
}

async function expectedSource() {
  const rows = readMatrix(await readFile(MATRIX_PATH, "utf8"));
  const source =
    "// Сгенерировано scripts/generate-gate-matrix.mjs из matrix.yaml; не редактировать вручную.\n" +
    `export const EXPECTED_GATES = ${JSON.stringify(rows)};\n`;
  return formatPrettier(source, { filepath: OUTPUT_PATH });
}

async function currentSource() {
  try {
    return await readFile(OUTPUT_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main(args) {
  if (args.some((arg) => arg !== "--check"))
    throw new Error(
      `Неизвестный аргумент: ${args.find((arg) => arg !== "--check")}`,
    );
  const expected = await expectedSource();
  if (args.includes("--check")) {
    const current = await currentSource();
    if (current === expected) {
      console.log("matrix: EXPECTED_GATES совпадает с matrix.yaml");
      return;
    }
    console.error(
      "matrix: gate-matrix.generated.mjs не совпадает с matrix.yaml; выполните node scripts/generate-gate-matrix.mjs",
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(OUTPUT_PATH, expected);
  console.log("matrix: gate-matrix.generated.mjs обновлён из matrix.yaml");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`matrix: ${error.message}`);
    process.exitCode = 1;
  }
}
