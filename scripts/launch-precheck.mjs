#!/usr/bin/env node

// Быстрая локальная перепроверка гейтов без кандидата, supply_chain и soak.
// Запускает команды гейтов из matrix.yaml в текущем checkout и останавливается
// на первой ошибке, чтобы исправлять линт, типы и юнит-тесты за минуты,
// а не после полного цикла launch-верификации.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = resolve(REPO_ROOT, "verification/launch/v1/matrix.yaml");

// Гейты, которые можно проверить без кандидата, Docker-образов и soak.
const FAST_GATES = new Set([
  "install",
  "generated",
  "static",
  "unit",
  "contracts",
  "architecture",
  "config_security",
]);

function parseArguments(argv) {
  const options = { gates: [], list: false, keepGoing: false, tailLines: 40 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--keep-going") options.keepGoing = true;
    else if (argument === "--gate") options.gates.push(argv[++index]);
    else if (argument === "--tail") options.tailLines = Number(argv[++index]);
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Использование: node scripts/launch-precheck.mjs [--gate <id>]... [--keep-going]",
          "  --gate <id>    проверить только указанный гейт (можно повторять)",
          "  --keep-going   не останавливаться на первой ошибке",
          "  --list         показать проверяемые гейты",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else throw new Error(`неизвестный аргумент: ${argument}`);
  }
  return options;
}

async function loadGates() {
  const matrix = load(await readFile(MATRIX, "utf8"));
  return matrix.gates
    .filter((gate) => FAST_GATES.has(gate.id))
    .map((gate) => ({ id: gate.id, command: gate.command }));
}

function run(command) {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", command], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const started = Date.now();
    child.once("error", () =>
      resolvePromise({ code: 1, output, durationMs: 0 }),
    );
    child.once("close", (code) =>
      resolvePromise({ code, output, durationMs: Date.now() - started }),
    );
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const gates = await loadGates();
  if (options.list) {
    for (const gate of gates) process.stdout.write(`${gate.id}\n`);
    return 0;
  }
  const selected = options.gates.length
    ? gates.filter((gate) => options.gates.includes(gate.id))
    : gates;
  if (selected.length === 0)
    throw new Error("нет подходящих гейтов для проверки");

  const failures = [];
  for (const gate of selected) {
    process.stdout.write(`→ ${gate.id}: ${gate.command}\n`);
    const result = await run(gate.command);
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.code === 0) {
      process.stdout.write(`  PASS ${seconds}s\n`);
      continue;
    }
    const tail = result.output.trimEnd().split("\n").slice(-options.tailLines);
    process.stdout.write(`  FAIL ${seconds}s\n${tail.join("\n")}\n`);
    failures.push(gate.id);
    if (!options.keepGoing) break;
  }
  if (failures.length) {
    process.stdout.write(`\nпровалено: ${failures.join(", ")}\n`);
    return 1;
  }
  process.stdout.write(`\nпроверено гейтов: ${selected.length}\n`);
  return 0;
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`launch-precheck: ${error.message}\n`);
  return 1;
});
