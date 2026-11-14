#!/usr/bin/env node

// Единая точка входа для launch-верификации: кандидат, контекст, supply_chain,
// realtime qualification и полный прогон G00–G19 в одном корне состояния.
//
// Раскладка состояния (по умолчанию ~/coffee-platform/launch):
//   candidates/<sha>/     git worktree кандидата; evidence принадлежит ему по контракту
//   soak/<runId>/         результат realtime qualification (родитель 0700)
//   logs/<runId>/         stdout/stderr каждого шага
//   scan-cache/           COFFEE_SCAN_CACHE_DIR (база Trivy)
//   tmp/                  TMPDIR для приватного checkout runner

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_ROOT =
  process.env.COFFEE_LAUNCH_STATE ?? join(homedir(), "coffee-platform/launch");
const RUN_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
const STATE_README = `# Состояние launch-верификации

Единый корень для всего, что создаётся при проверке кандидата.

| Каталог | Что внутри | Можно удалять |
|---|---|---|
| \`candidates/<sha>/\` | git worktree кандидата и его \`evidence/launch/<runId>/\` | да, но вместе с evidence |
| \`soak/<runId>/\` | результат realtime qualification | да, воспроизводимо |
| \`logs/<runId>/\` | логи шагов (supply_chain, soak, run) | да |
| \`scan-cache/\` | база Trivy для supply_chain | да, скачается заново |

Инструмент: \`node scripts/launch-run.mjs --sha <sha>\`.
`;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const options = {
    sha: null,
    base: null,
    state: STATE_ROOT,
    skipG12: false,
    skipSoak: false,
    skipRun: false,
    keepCandidates: 2,
    keepSoak: 3,
    minFreeGiB: 15,
    signer: process.env.COFFEE_G16_SIGNER ?? null,
    systemIdentifier: "7613370342949990434",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => argv[++index];
    if (argument === "--sha") options.sha = value();
    else if (argument === "--base") options.base = value();
    else if (argument === "--state") options.state = resolve(value());
    else if (argument === "--g16-signer") options.signer = resolve(value());
    else if (argument === "--g08-expected-system-identifier")
      options.systemIdentifier = value();
    else if (argument === "--skip-supply-chain") options.skipG12 = true;
    else if (argument === "--skip-soak") options.skipSoak = true;
    else if (argument === "--skip-run") options.skipRun = true;
    else if (argument === "--keep-candidates")
      options.keepCandidates = Number(value());
    else if (argument === "--keep-soak") options.keepSoak = Number(value());
    else if (argument === "--min-free-gib")
      options.minFreeGiB = Number(value());
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(
        [
          "Использование: node scripts/launch-run.mjs --sha <commit> [опции]",
          "  --base <commit>        accepted base (по умолчанию develop)",
          "  --state <dir>          корень состояния",
          "  --g16-signer <path>    RAM signer для aroma_sandbox",
          "  --skip-supply-chain    не запускать supply_chain, взять готовый инвентарь",
          "  --skip-soak            не запускать realtime qualification",
          "  --skip-run             остановиться после soak",
          "  --keep-candidates <n>  сколько кандидатов оставлять (по умолчанию 2)",
          "  --keep-soak <n>        сколько soak-каталогов оставлять (по умолчанию 3)",
          "  --min-free-gib <n>     минимальный запас диска (по умолчанию 25)",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else fail(`неизвестный аргумент: ${argument}`);
  }
  if (
    typeof options.sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(resolveSha(options.sha))
  )
    fail("--sha обязателен и должен указывать на коммит");
  return options;
}

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function resolveSha(reference) {
  try {
    return git(["rev-parse", "--verify", `${reference}^{commit}`]);
  } catch {
    return reference;
  }
}

async function exists(path) {
  return access(path, fsConstants.F_OK).then(
    () => true,
    () => false,
  );
}

async function ensureFreeSpace(minimumGiB) {
  const info = await statfs(STATE_ROOT);
  const freeGiB = (info.bavail * info.bsize) / 1024 ** 3;
  if (freeGiB < minimumGiB) {
    let reclaimable = "";
    try {
      const report = execFileSync(
        "docker",
        ["buildx", "du", "--builder", "coffee-platform-mtu"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const match = /Reclaimable:\s*([0-9.]+)([kMG]B)/u.exec(report);
      if (match)
        reclaimable = `, освобождаемо в BuildKit: ${match[1]}${match[2]}`;
    } catch {}
    fail(
      `свободно ${freeGiB.toFixed(1)} GiB, нужно не меньше ${minimumGiB} GiB${reclaimable}; ` +
        "почистите кеш сборки: docker buildx prune --builder coffee-platform-mtu --keep-storage 6GB",
    );
  }
  return freeGiB;
}

async function ensurePinnedImages() {
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const missing = [];
  for (const reference of [toolchain.nodeImage, toolchain.nginxImage])
    try {
      execFileSync("docker", ["image", "inspect", reference], {
        stdio: "ignore",
      });
    } catch {
      missing.push(reference);
    }
  if (missing.length)
    fail(
      `нет закреплённых образов локально: ${missing.join(", ")}; ` +
        "выполните docker pull",
    );
}

function ensureSopsKey() {
  const key = process.env.SOPS_AGE_KEY_FILE;
  if (!key || !isAbsolute(key))
    fail("SOPS_AGE_KEY_FILE обязателен и должен быть абсолютным путём");
  execFileSync("test", ["-r", key]);
  return key;
}

async function createCandidateRoot(sha) {
  const root = join(STATE_ROOT, "candidates", sha);
  if (await exists(root))
    fail(
      `кандидат уже существует: ${root}; удалите его или возьмите другой sha`,
    );
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  git(["worktree", "add", "--detach", root, sha]);
  return root;
}

function runStep({ name, logFile, command, args, cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  let buffered = "";
  const write = (chunk, target, log) => {
    target.push(chunk);
    log.write(chunk);
    buffered = (buffered + chunk).toString("utf8").slice(-2048);
  };
  return (async () => {
    const log = await import("node:fs").then(({ createWriteStream }) =>
      createWriteStream(logFile, { mode: 0o600 }),
    );
    log.write(`$ ${[command, ...args].join(" ")}\n`);
    child.stdout.on("data", (chunk) => write(chunk, out, log));
    child.stderr.on("data", (chunk) => write(chunk, err, log));
    const code = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (exitCode) => resolvePromise(exitCode));
    });
    await new Promise((resolvePromise) => log.end(resolvePromise));
    return {
      name,
      code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      tail: buffered,
    };
  })();
}

async function prepareCandidate(candidateRoot) {
  const install = await runStep({
    name: "install",
    logFile: join(STATE_ROOT, "logs", "install.log"),
    command: "pnpm",
    args: ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
    cwd: candidateRoot,
  });
  if (install.code !== 0) fail(`pnpm install упал: ${install.tail}`);
  const build = await runStep({
    name: "build",
    logFile: join(STATE_ROOT, "logs", "build.log"),
    command: "pnpm",
    args: ["exec", "tsc", "-b", "--pretty", "false"],
    cwd: candidateRoot,
  });
  if (build.code !== 0) fail(`tsc -b упал: ${build.tail}`);
  for (const file of [
    "config/platform.yaml",
    "config/platform.schema.json",
    "config/toolchain-versions.json",
    "config/toolchain-versions.schema.json",
    "pnpm-lock.yaml",
  ])
    await import("node:fs/promises").then(({ chmod }) =>
      chmod(join(candidateRoot, file), 0o644).catch(() => {}),
    );
}

async function writeContext({ candidateRoot, sha, base, runId }) {
  const evidenceDir = join(candidateRoot, "evidence/launch", runId);
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const toolchain = await readFile(
    join(candidateRoot, "config/toolchain-versions.json"),
  );
  const secrets = await readFile(
    join(candidateRoot, "secrets/platform.secrets.sops.yaml"),
  );
  const lockfile = await readFile(join(candidateRoot, "pnpm-lock.yaml"));
  const config = await readFile(join(candidateRoot, "config/platform.yaml"));
  const startedAtUtc = new Date().toISOString();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const resources = {
    composeProject: `coffee-launch-${runId.toLowerCase()}`,
    kafkaPrefix: runId,
  };
  const context = {
    schemaVersion: 1,
    candidateSha: sha,
    baseConfigSha256: digest(config),
    runId,
    checkoutDir: candidateRoot,
    sourceRepoRoot: candidateRoot,
    acceptedBaseCommit: base,
    startedAtUtc,
    evidenceDir,
    githubSnapshotPath: null,
    resources,
  };
  const environment = {
    runId,
    dirty: false,
    sourceSha: sha,
    candidateSha: sha,
    capturedAt: startedAtUtc,
    timezone: "UTC",
    platform: process.platform,
    arch: process.arch,
    osRelease: (await import("node:os")).release(),
    cpuCount: (await import("node:os")).cpus().length,
    memoryBytes: (await import("node:os")).totalmem(),
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    nodeImageDigest: null,
    toolVersions: {
      docker: execFileSync("docker", ["--version"], {
        encoding: "utf8",
      }).trim(),
      compose: execFileSync("docker", ["compose", "version"], {
        encoding: "utf8",
      }).trim(),
    },
    treeSha: git(["rev-parse", `${sha}^{tree}`], candidateRoot),
    configSha256: digest(config),
    encryptedSecretsSha256: digest(secrets),
    toolchainVersionsSha256: digest(toolchain),
    lockfileSha256: digest(lockfile),
    imageDigests: null,
    resources,
    candidatePath: candidateRoot,
  };
  await writeFile(
    join(evidenceDir, "context.json"),
    `${JSON.stringify(context, null, 2)}\n`,
    { mode: 0o400 },
  );
  await writeFile(
    join(evidenceDir, "environment.json"),
    `${JSON.stringify(environment, null, 2)}\n`,
    { mode: 0o600 },
  );
  return evidenceDir;
}

async function newestQualificationReceipt(candidateRoot) {
  const root = join(candidateRoot, "evidence/launch/qualifications");
  if (!(await exists(root))) fail("нет каталога qualifications после soak");
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "qualification.json"));
  let newest = null;
  for (const path of entries)
    if (await exists(path)) {
      const info = await stat(path);
      if (!newest || info.mtimeMs > newest.mtimeMs)
        newest = { path, mtimeMs: info.mtimeMs };
    }
  if (!newest) fail("soak не создал qualification.json");
  return newest.path;
}

async function printSummary(runResultPath) {
  if (!(await exists(runResultPath))) {
    process.stdout.write("\nresult.json не найден — прогон не завершился\n");
    return;
  }
  const result = JSON.parse(await readFile(runResultPath, "utf8"));
  const failed = result.gates.filter((gate) => gate.status !== "PASS");
  process.stdout.write("\nГейты:\n");
  for (const gate of result.gates)
    process.stdout.write(
      `  ${gate.id.padEnd(16)} ${gate.status.padEnd(8)} ${(gate.durationMs / 1000).toFixed(0)}s\n`,
    );
  process.stdout.write(
    `\nИтого: PASS ${result.gates.length - failed.length}/${result.gates.length}\n`,
  );
  if (failed.length)
    process.stdout.write(
      `Не PASS: ${failed.map((gate) => `${gate.id}:${gate.status}`).join(", ")}\n`,
    );
}

async function pruneState({ keepCandidates, keepSoak }) {
  const candidatesRoot = join(STATE_ROOT, "candidates");
  if (await exists(candidatesRoot)) {
    const entries = (await readdir(candidatesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(candidatesRoot, entry.name));
    const sorted = [];
    for (const path of entries)
      sorted.push({ path, mtime: (await stat(path)).mtimeMs });
    sorted.sort((left, right) => right.mtime - left.mtime);
    for (const entry of sorted.slice(keepCandidates)) {
      try {
        git(["worktree", "remove", "--force", entry.path]);
      } catch {
        await rm(entry.path, { recursive: true, force: true });
      }
      process.stdout.write(`удалён кандидат ${entry.path}\n`);
    }
  }
  const soakRoot = join(STATE_ROOT, "soak");
  if (await exists(soakRoot)) {
    const entries = (await readdir(soakRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(soakRoot, entry.name));
    const sorted = [];
    for (const path of entries)
      sorted.push({ path, mtime: (await stat(path)).mtimeMs });
    sorted.sort((left, right) => right.mtime - left.mtime);
    for (const entry of sorted.slice(keepSoak))
      await rm(entry.path, { recursive: true, force: true });
  }
  git(["worktree", "prune"]);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sha = resolveSha(options.sha);
  const base = resolveSha(options.base ?? "develop");
  await mkdir(join(options.state, "logs"), { recursive: true, mode: 0o700 });
  await mkdir(join(options.state, "soak"), { recursive: true, mode: 0o700 });
  await mkdir(join(options.state, "scan-cache"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(options.state, "tmp"), { recursive: true, mode: 0o700 });
  const readmePath = join(options.state, "README.md");
  if (!(await exists(readmePath)))
    await writeFile(readmePath, STATE_README, { mode: 0o644 });

  const sopsKey = ensureSopsKey();
  const freeGiB = await ensureFreeSpace(options.minFreeGiB);
  await ensurePinnedImages();
  const lock = join(tmpdir(), "coffee-platform-trivy.lock");
  if (await exists(lock)) fail(`найден lock другого сканера: ${lock}`);

  if (git(["status", "--porcelain"]).length)
    fail("исходный репозиторий грязный; закоммитьте или уберите изменения");

  const runId = `${new Date().toISOString().replace(/[-:]/gu, "").slice(0, 15)}Z-${sha.slice(0, 7)}`;
  if (!RUN_ID_PATTERN.test(runId)) fail(`некорректный runId: ${runId}`);
  const logDir = join(options.state, "logs", runId);
  await mkdir(logDir, { recursive: true, mode: 0o700 });

  process.stdout.write(
    `кандидат ${sha.slice(0, 8)}, база ${base.slice(0, 8)}, runId ${runId}\n` +
      `состояние: ${options.state} (свободно ${freeGiB.toFixed(1)} GiB)\n`,
  );

  const candidateRoot = await createCandidateRoot(sha);
  await prepareCandidate(candidateRoot);
  const evidenceDir = await writeContext({
    candidateRoot,
    sha,
    base,
    runId,
  });

  const scanEnv = {
    SOPS_AGE_KEY_FILE: sopsKey,
    COFFEE_LAUNCH_CONTEXT_FILE: join(evidenceDir, "context.json"),
    COFFEE_SCAN_CACHE_DIR: join(options.state, "scan-cache"),
  };

  if (!options.skipG12) {
    process.stdout.write("supply_chain...\n");
    const scan = await runStep({
      name: "supply_chain",
      logFile: join(logDir, "supply_chain.log"),
      command: process.execPath,
      args: [join(candidateRoot, "tools/security-scan.mjs")],
      cwd: candidateRoot,
      env: scanEnv,
    });
    if (scan.code !== 0) fail(`supply_chain упал: ${scan.tail}`);
  }

  if (!options.skipSoak) {
    process.stdout.write("realtime qualification (soak)...\n");
    const soakDir = join(options.state, "soak", runId);
    const soak = await runStep({
      name: "soak",
      logFile: join(logDir, "soak.log"),
      command: process.execPath,
      args: [
        join(candidateRoot, "tools/realtime-capacity.mjs"),
        "--context",
        join(evidenceDir, "context.json"),
        "--result-dir",
        soakDir,
      ],
      cwd: candidateRoot,
      env: {
        SOPS_AGE_KEY_FILE: sopsKey,
        COFFEE_LAUNCH_SCRATCH: join(options.state, "soak"),
        TMPDIR: join(options.state, "tmp"),
      },
    });
    if (soak.code !== 0) fail(`soak упал: ${soak.tail}`);
  }

  if (options.skipRun) {
    process.stdout.write("остановка после soak (--skip-run)\n");
    return;
  }

  const receipt = await newestQualificationReceipt(candidateRoot);
  const args = [
    join(candidateRoot, "verification/launch/v1/run.mjs"),
    "--candidate-sha",
    sha,
    "--accepted-base-commit",
    base,
    "--realtime-qualification",
    receipt,
    "--g08-expected-system-identifier",
    options.systemIdentifier,
  ];
  if (options.signer) args.push("--g16-signer", options.signer);
  process.stdout.write("полный прогон G00–G19...\n");
  const run = await runStep({
    name: "run",
    logFile: join(logDir, "run.log"),
    command: process.execPath,
    args,
    cwd: candidateRoot,
    env: { SOPS_AGE_KEY_FILE: sopsKey },
  });
  // Runner создаёт собственный run-id, поэтому итог ищется в самом свежем
  // каталоге evidence, а не в каталоге, подготовленном обёрткой.
  const producedEvidence = await newestRunEvidence(candidateRoot, evidenceDir);
  await printSummary(join(producedEvidence, "run-result.json"));
  process.stdout.write(`\nevidence: ${producedEvidence}\nлоги: ${logDir}\n`);
  if (run.code !== 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`launch-run: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (process.env.COFFEE_LAUNCH_NO_PRUNE !== "1")
    await pruneState({
      keepCandidates: Number(process.env.COFFEE_LAUNCH_KEEP_CANDIDATES ?? 2),
      keepSoak: Number(process.env.COFFEE_LAUNCH_KEEP_SOAK ?? 3),
    }).catch(() => {});
}

async function newestRunEvidence(candidateRoot, fallback) {
  const root = join(candidateRoot, "evidence/launch");
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
  let newest = null;
  for (const path of entries) {
    const info = await stat(join(path, "run-result.json")).catch(() => null);
    if (!info) continue;
    if (!newest || info.mtimeMs > newest.mtimeMs)
      newest = { path, mtimeMs: info.mtimeMs };
  }
  return newest?.path ?? fallback;
}
