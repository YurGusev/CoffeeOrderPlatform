#!/usr/bin/env node

// Быстрая локальная перепроверка гейтов без кандидата, supply_chain и soak.
// Запускает команды гейтов из matrix.yaml в текущем checkout и останавливается
// на первой ошибке, чтобы исправлять линт, типы и юнит-тесты за минуты,
// а не после полного цикла launch-верификации.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = resolve(REPO_ROOT, "verification/launch/v1/matrix.yaml");
const LAUNCH_EVIDENCE_ROOT = join(REPO_ROOT, "evidence/launch");

// unit-сценарий проверяет readonly launch context и checkout identity, поэтому
// для него создаётся временный context на текущем коммите.
async function createLaunchContext() {
  const gitText = (args) =>
    execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const candidateSha = gitText(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (
    gitText([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--no-renames",
    ]).length
  )
    throw new Error(
      "unit требует чистый checkout: временный launch context не совпадёт с candidate",
    );
  const config = await readFile(join(REPO_ROOT, "config/platform.yaml"));
  await mkdir(LAUNCH_EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  let runId;
  let evidenceDir;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date(Date.now() + attempt * 1000);
    runId = `${now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z")}-${candidateSha.slice(0, 7)}`;
    evidenceDir = join(LAUNCH_EVIDENCE_ROOT, runId);
    try {
      await mkdir(evidenceDir, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST" || attempt === 4) throw error;
    }
  }
  await mkdir(join(evidenceDir, "gates/unit/artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  const context = {
    schemaVersion: 1,
    candidateSha,
    baseConfigSha256: createHash("sha256").update(config).digest("hex"),
    runId,
    checkoutDir: REPO_ROOT,
    sourceRepoRoot: REPO_ROOT,
    acceptedBaseCommit: candidateSha,
    startedAtUtc: new Date().toISOString(),
    evidenceDir,
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      kafkaPrefix: runId,
    },
  };
  const contextPath = join(evidenceDir, "context.json");
  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, {
    mode: 0o400,
  });
  return { contextPath, evidenceDir };
}

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
          "  unit требует чистый checkout: временный launch context создаётся сам",
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

function run(command, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn("sh", ["-c", command], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
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
    const context = gate.id === "unit" ? await createLaunchContext() : null;
    let result;
    try {
      result = await run(
        gate.command,
        context ? { COFFEE_LAUNCH_CONTEXT_FILE: context.contextPath } : {},
      );
    } catch (error) {
      if (context)
        await rm(context.evidenceDir, { recursive: true, force: true });
      throw error;
    }
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.code === 0) {
      if (context)
        await rm(context.evidenceDir, { recursive: true, force: true });
      process.stdout.write(`  PASS ${seconds}s\n`);
      continue;
    }
    if (context) process.stdout.write(`  evidence: ${context.evidenceDir}\n`);
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
