import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import { parsePlatformConfig } from "../../../../packages/platform-config/src/index.ts";
import { validateLaunchContext } from "../../../../scripts/launch-support/launch-context.mjs";
import { inspectLaunchCheckout } from "../../../../scripts/launch-support/rollback-context.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_SUFFIX = /\.(?:[cm]?js|tsx?)$/u;
const SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
const NODE_SIGNALS = new Set([
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGCHLD",
  "SIGCONT",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGIO",
  "SIGKILL",
  "SIGPIPE",
  "SIGPROF",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSTOP",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGUSR1",
  "SIGUSR2",
  "SIGVTALRM",
  "SIGXCPU",
  "SIGXFSZ",
]);

export function changedCriticalModules(paths, modules) {
  return modules.filter((module) =>
    paths.some(
      (path) =>
        module.sourceRoots.some((root) => path.startsWith(`${root}/`)) &&
        SOURCE_SUFFIX.test(path) &&
        !/\.d\.(?:ts|mts|cts)$/u.test(path),
    ),
  );
}

export function parseLcovRecords(text) {
  const records = [];
  let record = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("SF:")) {
      if (record) throw new Error("LCOV_RECORD_NOT_CLOSED");
      record = {
        path: line.slice(3),
        LF: null,
        LH: null,
        FNF: null,
        FNH: null,
        BRF: null,
        BRH: null,
      };
    } else if (line === "end_of_record") {
      const safePath =
        typeof record?.path === "string" &&
        record.path.length > 0 &&
        !record.path.includes("\\") &&
        !record.path.split("/").includes("..");
      if (
        !record ||
        !safePath ||
        Object.values(record)
          .slice(1)
          .some((value) => !Number.isSafeInteger(value) || value < 0)
      )
        throw new Error("LCOV_RECORD_INVALID");
      if (
        record.LH > record.LF ||
        record.FNH > record.FNF ||
        record.BRH > record.BRF
      )
        throw new Error("LCOV_HITS_EXCEED_FOUND");
      records.push(record);
      record = null;
    } else if (record && /^(?:LF|LH|FNF|FNH|BRF|BRH):/u.test(line)) {
      const [key, raw] = line.split(":", 2);
      if (record[key] !== null || !/^\d+$/u.test(raw ?? ""))
        throw new Error("LCOV_COUNTER_INVALID");
      record[key] = Number(raw);
    }
  }
  if (
    record ||
    records.length === 0 ||
    new Set(records.map(({ path }) => path)).size !== records.length
  )
    throw new Error("LCOV_REPORT_INCOMPLETE");
  return records;
}

export function coverageForModule(records, expectedFiles, module, thresholds) {
  const absoluteRecordPath = (path) =>
    isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
  const selected = records.filter(({ path }) =>
    module.coverageRoots.some((root) => {
      const absoluteRoot = resolve(ROOT, root);
      const absolutePath = absoluteRecordPath(path);
      const withinRoot =
        absolutePath === absoluteRoot ||
        absolutePath.startsWith(`${absoluteRoot}${sep}`);
      return (
        withinRoot &&
        absolutePath.endsWith(`.${module.format}`) &&
        !absolutePath.split(sep).includes("generated") &&
        !absolutePath.endsWith(".gen.js")
      );
    }),
  );
  const reported = new Set(
    selected.map(({ path }) => absoluteRecordPath(path)),
  );
  if (
    expectedFiles.some((path) => !reported.has(resolve(ROOT, path))) ||
    selected.length !== expectedFiles.length
  )
    throw new Error(`COVERAGE_FILE_SET_MISMATCH:${module.id}`);
  const sum = (key) =>
    selected.reduce((total, item) => {
      const next = total + item[key];
      if (!Number.isSafeInteger(next))
        throw new Error("LCOV_AGGREGATE_COUNTER_INVALID");
      return next;
    }, 0);
  const pairs = [
    ["lines", sum("LH"), sum("LF")],
    ["functions", sum("FNH"), sum("FNF")],
    ["branches", sum("BRH"), sum("BRF")],
  ];
  return Object.freeze({
    id: module.id,
    metrics: Object.freeze(
      Object.fromEntries(
        pairs.map(([name, hit, found]) => [
          name,
          Object.freeze({
            hit,
            found,
            percent: found === 0 ? 0 : (hit * 100) / found,
            required: thresholds[name],
          }),
        ]),
      ),
    ),
    passed: pairs.every(
      ([name, hit, found]) =>
        found > 0 && hit * 100 >= thresholds[name] * found,
    ),
  });
}

async function filesBelow(root, extension) {
  const absoluteRoot = resolve(ROOT, root);
  const result = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`COVERAGE_SYMLINK_REJECTED:${relative(ROOT, path)}`);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        path.endsWith(`.${extension}`) &&
        !path.split(sep).includes("generated") &&
        !path.endsWith(".gen.js")
      )
        result.push(path);
    }
  }
  await visit(absoluteRoot);
  return result.sort((left, right) => left.localeCompare(right));
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function snapshotReadonlyContext(contextPath) {
  const before = await lstat(contextPath);
  assert(
    before.isFile() && !before.isSymbolicLink() && before.size <= 16 * 1024,
    "LAUNCH_CONTEXT_FILE_INVALID",
  );
  assert.equal(before.mode & 0o777, 0o400, "LAUNCH_CONTEXT_MODE_INVALID");
  if (typeof process.getuid === "function")
    assert.equal(before.uid, process.getuid(), "LAUNCH_CONTEXT_OWNER_INVALID");
  const bytes = await readFile(contextPath);
  const after = await lstat(contextPath);
  assert(
    after.isFile() &&
      !after.isSymbolicLink() &&
      after.dev === before.dev &&
      after.ino === before.ino &&
      after.uid === before.uid &&
      after.mode === before.mode &&
      after.size === before.size,
    "LAUNCH_CONTEXT_CHANGED_DURING_READ",
  );
  return {
    path: resolve(contextPath),
    dev: before.dev,
    ino: before.ino,
    uid: before.uid,
    mode: before.mode,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function assertContextSnapshotUnchanged(expected, actual, stage) {
  assert.deepEqual(actual, expected, `LAUNCH_CONTEXT_CHANGED_DURING_${stage}`);
}

async function validatedRunContext() {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  assert.equal(typeof contextPath, "string", "LAUNCH_CONTEXT_REQUIRED");
  const before = await snapshotReadonlyContext(contextPath);
  const identity = await validateLaunchContext(contextPath);
  const after = await snapshotReadonlyContext(contextPath);
  assert.deepEqual(after, before, "LAUNCH_CONTEXT_CHANGED_DURING_VALIDATION");
  const { context, candidateRoot } = identity;
  assert.match(context.acceptedBaseCommit ?? "", SHA);
  assert.match(context.runId ?? "", RUN_ID);
  assert.equal(candidateRoot, ROOT, "LAUNCH_CHECKOUT_MISMATCH");
  const checkout = await inspectLaunchCheckout(
    candidateRoot,
    context.candidateSha,
  );
  git([
    "merge-base",
    "--is-ancestor",
    context.acceptedBaseCommit,
    context.candidateSha,
  ]);
  const configBytes = await readFile(
    join(candidateRoot, "config/platform.yaml"),
  );
  assert.equal(
    createHash("sha256").update(configBytes).digest("hex"),
    context.baseConfigSha256,
    "LAUNCH_CONFIG_SHA_MISMATCH",
  );
  const yaml = parseYaml(configBytes.toString("utf8"), { json: true });
  const parsed = parsePlatformConfig(yaml);
  assert(parsed.unitCoverage, "UNIT_COVERAGE_POLICY_MISSING");
  return {
    context,
    contextPath,
    contextSnapshot: before,
    candidateRoot: checkout.root,
    policy: parsed.unitCoverage,
  };
}

export function parseTapSummary(text) {
  const diagnostic = parseTapSummaryDiagnostic(text);
  if (diagnostic.code) throw new Error(diagnostic.code);
  return diagnostic.summary;
}

export function parseTapSummaryDiagnostic(text) {
  const read = (name) => {
    const match = new RegExp(`^# ${name} (\\d+)$`, "mu").exec(text);
    return match ? Number(match[1]) : null;
  };
  const summary = Object.fromEntries(
    ["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((name) => [
      name,
      read(name),
    ]),
  );
  const total =
    summary.pass +
    summary.fail +
    summary.cancelled +
    summary.skipped +
    summary.todo;
  if (
    Object.values(summary).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    summary.tests < 1 ||
    !Number.isSafeInteger(total) ||
    summary.tests !== total
  ) {
    return { summary, code: "UNIT_TAP_SUMMARY_INVALID" };
  }
  if (summary.fail || summary.cancelled || summary.skipped || summary.todo)
    return { summary, code: "UNIT_TESTS_FAILED_OR_SKIPPED" };
  return { summary, code: null };
}

export async function writeUnitEvidenceArtifacts(context, artifacts) {
  if (
    !context ||
    !RUN_ID.test(context.runId ?? "") ||
    !SHA.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`) ||
    !isAbsolute(context.sourceRepoRoot ?? "")
  ) {
    throw new Error("UNIT_EVIDENCE_IDENTITY_INVALID");
  }
  const sourceRepoRoot = resolve(context.sourceRepoRoot);
  const evidenceDir = resolve(sourceRepoRoot, "evidence/launch", context.runId);
  if (resolve(context.evidenceDir ?? "") !== evidenceDir)
    throw new Error("UNIT_EVIDENCE_SCOPE_INVALID");
  const directories = [
    sourceRepoRoot,
    join(sourceRepoRoot, "evidence"),
    join(sourceRepoRoot, "evidence/launch"),
    evidenceDir,
    join(evidenceDir, "gates"),
    join(evidenceDir, "gates/unit"),
    join(evidenceDir, "gates/unit/artifacts"),
  ];
  if (sourceRepoRoot !== context.sourceRepoRoot)
    throw new Error("UNIT_EVIDENCE_DIRECTORY_INVALID");
  for (const [index, directory] of directories.entries()) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error("UNIT_EVIDENCE_DIRECTORY_INVALID");
    if (
      index >= 3 &&
      ((info.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid()))
    )
      throw new Error("UNIT_EVIDENCE_DIRECTORY_INVALID");
  }
  const allowed = new Set([
    "unit.tap",
    "coverage.lcov",
    "unit-diagnostics.json",
  ]);
  const receipts = [];
  for (const [name, contents] of Object.entries(artifacts)) {
    if (
      !allowed.has(name) ||
      !(typeof contents === "string" || Buffer.isBuffer(contents))
    )
      throw new Error("UNIT_EVIDENCE_ARTIFACT_INVALID");
    const path = join(directories.at(-1), name);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new Error("UNIT_EVIDENCE_ARTIFACT_MODE_INVALID");
    receipts.push({
      name,
      path,
      sha256: createHash("sha256").update(contents).digest("hex"),
      sizeBytes: info.size,
    });
  }
  return receipts;
}

export function runUnitTestChild(args) {
  const env = { ...process.env };
  delete env.SOPS_AGE_KEY_FILE;
  delete env.AROMA_SANDBOX_APPROVAL_FILE;
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 840_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function runUnitCoverage(argv = process.argv.slice(2)) {
  assert(
    (argv.length === 1 && argv[0] === "--coverage") ||
      (argv.length === 2 && argv[0] === "--" && argv[1] === "--coverage"),
    "USAGE:pnpm test:unit -- --coverage",
  );
  const { context, contextPath, contextSnapshot, candidateRoot, policy } =
    await validatedRunContext();
  const changedPaths = git([
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=ACMRTD",
    context.acceptedBaseCommit,
    context.candidateSha,
  ])
    .split("\n")
    .filter(Boolean);
  const modules = changedCriticalModules(changedPaths, policy.criticalModules);
  const testFiles = policy.testFiles.map((path) => resolve(ROOT, path));
  for (let index = 0; index < testFiles.length; index++) {
    const relativePath = relative(ROOT, testFiles[index]);
    assert(
      relativePath &&
        !relativePath.startsWith(`..${sep}`) &&
        !isAbsolute(relativePath),
    );
    await readFile(testFiles[index]);
  }
  const build = spawnSync("pnpm", ["exec", "tsc", "-b", "--pretty", "false"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (build.status !== 0)
    throw new Error(
      `UNIT_BUILD_FAILED:${build.status ?? build.error?.code ?? "unknown"}`,
    );
  assertContextSnapshotUnchanged(
    contextSnapshot,
    await snapshotReadonlyContext(contextPath),
    "BUILD",
  );
  const expectedByModule = new Map();
  for (const module of modules) {
    const files = [];
    for (const root of module.coverageRoots) {
      const found = await filesBelow(root, module.format);
      if (found.length === 0)
        throw new Error(`COVERAGE_ARTIFACTS_MISSING:${module.id}`);
      files.push(...found);
    }
    expectedByModule.set(module.id, files);
  }
  const temp = await mkdtemp(join(tmpdir(), "coffee-g04-"));
  try {
    await inspectLaunchCheckout(candidateRoot, context.candidateSha);
    const tapPath = join(temp, "unit.tap");
    const lcovPath = join(temp, "coverage.lcov");
    const args = [
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-include-all",
      "--test-coverage-exclude=**/generated/**",
      "--test-coverage-exclude=**/*.gen.js",
      "--test-reporter=tap",
      `--test-reporter-destination=${tapPath}`,
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      ...testFiles,
    ];
    const run = runUnitTestChild(args);
    const rawOutputs = {};
    for (const [name, path] of [
      ["unit.tap", tapPath],
      ["coverage.lcov", lcovPath],
    ]) {
      try {
        rawOutputs[name] = await readFile(path);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await writeUnitEvidenceArtifacts(context, rawOutputs);
    const tapDiagnostic = parseTapSummaryDiagnostic(
      (rawOutputs["unit.tap"] ?? Buffer.alloc(0)).toString("utf8"),
    );
    const finiteSignal = NODE_SIGNALS.has(run.signal) ? run.signal : null;
    const finiteSpawnError = [
      "ENOENT",
      "EACCES",
      "ETIMEDOUT",
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    ].includes(run.error?.code)
      ? run.error.code
      : run.error
        ? "OTHER"
        : null;
    const diagnostic = {
      schemaVersion: 1,
      gateId: "unit",
      runId: context.runId,
      candidateSha: context.candidateSha,
      node: {
        exitCode:
          Number.isSafeInteger(run.status) &&
          run.status >= 0 &&
          run.status <= 255
            ? run.status
            : null,
        signal: finiteSignal,
        spawnError: finiteSpawnError,
      },
      outputs: {
        unitTap: Boolean(rawOutputs["unit.tap"]),
        lcov: Boolean(rawOutputs["coverage.lcov"]),
      },
      tap: tapDiagnostic,
    };
    await writeUnitEvidenceArtifacts(context, {
      "unit-diagnostics.json": `${JSON.stringify(diagnostic, null, 2)}\n`,
    });
    await inspectLaunchCheckout(candidateRoot, context.candidateSha);
    const contextAfterTests = await validatedRunContext();
    assertContextSnapshotUnchanged(
      contextSnapshot,
      contextAfterTests.contextSnapshot,
      "TESTS",
    );
    assert.equal(
      contextAfterTests.context.candidateSha,
      context.candidateSha,
      "LAUNCH_CONTEXT_CHANGED_DURING_TESTS",
    );
    if (tapDiagnostic.code)
      throw new Error(`${tapDiagnostic.code}:evidence=unit/artifacts`);
    if (run.status !== 0)
      throw new Error(
        `UNIT_NODE_TEST_FAILED:${diagnostic.node.exitCode ?? diagnostic.node.signal ?? diagnostic.node.spawnError ?? "unknown"}:evidence=unit/artifacts`,
      );
    const lcov = parseLcovRecords(
      rawOutputs["coverage.lcov"]?.toString("utf8") ?? "",
    );
    const coverage = modules.map((module) =>
      coverageForModule(
        lcov,
        expectedByModule.get(module.id) ?? [],
        module,
        policy.thresholds,
      ),
    );
    for (const module of coverage)
      process.stdout.write(
        `${module.id}: ${Object.entries(module.metrics)
          .map(
            ([name, metric]) =>
              `${name} ${metric.hit}/${metric.found} ${metric.percent.toFixed(2)}% (min ${metric.required}%)`,
          )
          .join(", ")}\n`,
      );
    process.stdout.write(
      `unit tests: ${tapDiagnostic.summary.pass}/${tapDiagnostic.summary.tests}; skipped/todo/cancelled: 0\n`,
    );
    if (coverage.some(({ passed }) => !passed))
      throw new Error("UNIT_COVERAGE_THRESHOLD_FAILED");
    return tapDiagnostic.summary;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runUnitCoverage().catch((error) => {
    process.stderr.write(`${error?.message ?? "UNIT_COVERAGE_FAILED"}\n`);
    process.exitCode = 1;
  });
}
