import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";
import { validateLaunchContext } from "../report.mjs";

const CONFIG_PATH = "config/platform.yaml";
const CONFIG_PATH_BYTES = Buffer.from(CONFIG_PATH);
const SHA = /^[0-9a-f]{40}$/u;
export const ROLLBACK_FAILURE_STAGES = Object.freeze([
  "preflight",
  "bootstrap",
  "build",
  "up",
  "readiness",
  "nginx",
  "initial-unknown",
  "disabled-restart",
  "disabled-reconcile",
  "disabled-owner-reconcile",
  "restored-restart",
  "restored-reconcile",
  "cleanup",
  "child-process",
]);
const ROLLBACK_FAILURE_CODES = new Set([
  "G18_PHASE_FAILED",
  "G18_CLEANUP_FAILED",
  "ROLLBACK_FAILURE_RECEIPT_INVALID",
]);
const ROLLBACK_ERROR_NAMES = new Set([
  "Error",
  "AssertionError",
  "AggregateError",
  "TypeError",
  "RangeError",
]);
export const ROLLBACK_DISABLED_RECONCILE_SUBSTAGES = Object.freeze([
  "restart",
  "config-attestation",
  "release",
  "convergence-readiness",
  "observer-readiness",
  "health",
  "facts",
]);
const PROJECT_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const ROLLBACK_COMPOSE_SOURCE_PATH = join(
  PROJECT_ROOT,
  "tools/compose-smoke.mjs",
);
const ROLLBACK_COMPOSE_SOURCE_URL = pathToFileURL(
  ROLLBACK_COMPOSE_SOURCE_PATH,
).href;
const ROLLBACK_COMPOSE_SOURCE = "tools/compose-smoke.mjs";
const MAX_SOURCE_COORDINATE = 1_000_000;

function fail(code) {
  throw new Error(code);
}

export function rollbackComposeProjectName(context) {
  if (
    !context ||
    typeof context.runId !== "string" ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(context.runId)
  ) {
    fail("ROLLBACK_LAUNCH_CONTEXT_INVALID");
  }
  const expected = `coffee-launch-${context.runId.toLowerCase()}`;
  if (context.resources?.composeProject !== expected)
    fail("ROLLBACK_COMPOSE_PROJECT_INVALID");
  return expected;
}

function git(root, ...args) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    fail("ROLLBACK_GIT_INSPECTION_FAILED");
  }
}

function gitText(root, ...args) {
  return git(root, ...args)
    .toString("utf8")
    .trim();
}

function assertNoHiddenIndexFlags(root) {
  const entries = git(root, "ls-files", "-v", "-z");
  let start = 0;
  while (start < entries.length) {
    const end = entries.indexOf(0, start);
    if (end < 0) fail("ROLLBACK_INDEX_INVALID");
    const entry = entries.subarray(start, end);
    const tag = entry[0];
    if (entry[1] !== 32 || tag === 83 || (tag >= 97 && tag <= 122))
      fail("ROLLBACK_INDEX_FLAGS_SET");
    start = end + 1;
  }
}

async function inspectCheckout(path, expectedSha) {
  if (typeof path !== "string" || !path || !SHA.test(expectedSha ?? ""))
    fail("ROLLBACK_CHECKOUT_INPUT_INVALID");
  const absolute = resolve(path);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch {
    fail("ROLLBACK_CHECKOUT_INVALID");
  }
  if (
    canonical !== absolute ||
    gitText(canonical, "rev-parse", "--show-toplevel") !== canonical
  )
    fail("ROLLBACK_CHECKOUT_INVALID");
  const head = gitText(canonical, "rev-parse", "--verify", "HEAD^{commit}");
  if (head !== expectedSha) fail("ROLLBACK_CHECKOUT_HEAD_MISMATCH");
  assertNoHiddenIndexFlags(canonical);
  const configPath = join(canonical, CONFIG_PATH);
  try {
    const info = await lstat(configPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await realpath(configPath)) !== configPath ||
      !(await readFile(configPath)).equals(
        git(canonical, "cat-file", "blob", `${head}:${CONFIG_PATH}`),
      )
    ) {
      fail("ROLLBACK_CONFIG_WORKTREE_MISMATCH");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "ROLLBACK_CONFIG_WORKTREE_MISMATCH"
    )
      throw error;
    fail("ROLLBACK_CONFIG_WORKTREE_INVALID");
  }
  if (
    git(
      canonical,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--no-renames",
    ).length !== 0
  )
    fail("ROLLBACK_CHECKOUT_DIRTY");
  const commit = gitText(
    canonical,
    "show",
    "-s",
    "--format=%H%n%P%n%T",
    head,
  ).split("\n");
  const [commitSha, parentLine, treeSha] = commit;
  if (commitSha !== head || !SHA.test(treeSha ?? ""))
    fail("ROLLBACK_COMMIT_INVALID");
  const parents = (parentLine ?? "").split(" ").filter(Boolean);
  if (parents.some((parent) => !SHA.test(parent)))
    fail("ROLLBACK_COMMIT_INVALID");
  return { root: canonical, commitSha, parents, treeSha };
}

export { inspectCheckout as inspectLaunchCheckout };

function treeEntries(checkout) {
  const output = git(
    checkout.root,
    "ls-tree",
    "-rz",
    "--full-tree",
    checkout.commitSha,
  );
  const entries = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    if (end < 0) fail("ROLLBACK_TREE_INVALID");
    const raw = output.subarray(start, end);
    const separator = raw.indexOf(9);
    if (separator < 0) fail("ROLLBACK_TREE_INVALID");
    entries.push({
      metadata: raw.subarray(0, separator).toString("ascii"),
      isConfig: raw.subarray(separator + 1).equals(CONFIG_PATH_BYTES),
      raw,
    });
    start = end + 1;
  }
  if (!entries.some(({ isConfig }) => isConfig))
    fail("ROLLBACK_CONFIG_MISSING");
  if (entries.filter(({ isConfig }) => isConfig).length !== 1)
    fail("ROLLBACK_CONFIG_AMBIGUOUS");
  return entries;
}

function assertOnlyConfigChanged(before, after) {
  const beforeEntries = treeEntries(before);
  const afterEntries = treeEntries(after);
  const otherBefore = beforeEntries
    .filter(({ isConfig }) => !isConfig)
    .map(({ raw }) => raw);
  const otherAfter = afterEntries
    .filter(({ isConfig }) => !isConfig)
    .map(({ raw }) => raw);
  if (
    otherBefore.length !== otherAfter.length ||
    otherBefore.some((entry, index) => !entry.equals(otherAfter[index]))
  ) {
    fail("ROLLBACK_NON_CONFIG_TREE_CHANGED");
  }
  const configBefore = beforeEntries.find(({ isConfig }) => isConfig);
  const configAfter = afterEntries.find(({ isConfig }) => isConfig);
  const configBeforeType = configBefore.metadata
    .split(" ")
    .slice(0, 2)
    .join(" ");
  const configAfterType = configAfter.metadata.split(" ").slice(0, 2).join(" ");
  if (
    configBeforeType !== configAfterType ||
    configBeforeType !== "100644 blob"
  ) {
    fail("ROLLBACK_CONFIG_MODE_CHANGED");
  }
}

function configBytes(checkout) {
  return git(
    checkout.root,
    "cat-file",
    "blob",
    `${checkout.commitSha}:${CONFIG_PATH}`,
  );
}

function parsedConfig(checkout) {
  let value;
  try {
    value = parseYaml(configBytes(checkout).toString("utf8"));
  } catch {
    fail("ROLLBACK_CONFIG_INVALID");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !value.services ||
    typeof value.services !== "object" ||
    Array.isArray(value.services) ||
    !value.services["aroma-convergence"] ||
    typeof value.services["aroma-convergence"] !== "object" ||
    Array.isArray(value.services["aroma-convergence"])
  )
    fail("ROLLBACK_CONFIG_INVALID");
  return value;
}

function configSha256(checkout) {
  return createHash("sha256").update(configBytes(checkout)).digest("hex");
}

function assertCanonicalConfigTransition(base, disabled) {
  const baseConfig = parsedConfig(base);
  const disabledConfig = parsedConfig(disabled);
  const baseTarget = baseConfig.services["aroma-convergence"];
  const disabledTarget = disabledConfig.services["aroma-convergence"];
  if (
    baseTarget.mutationsEnabled !== true ||
    disabledTarget.mutationsEnabled !== false
  )
    fail("ROLLBACK_MUTATION_FLAG_INVALID");
  const expected = {
    ...baseConfig,
    services: {
      ...baseConfig.services,
      "aroma-convergence": { ...baseTarget, mutationsEnabled: false },
    },
  };
  if (!isDeepStrictEqual(expected, disabledConfig))
    fail("ROLLBACK_EXTRA_CONFIG_CHANGE");
}

function assertLiteralFlagChange(base, disabled) {
  let offset = 0;
  const commonLength = Math.min(base.length, disabled.length);
  while (offset < commonLength && base[offset] === disabled[offset])
    offset += 1;
  if (
    !base.subarray(offset, offset + 4).equals(Buffer.from("true")) ||
    !disabled.subarray(offset, offset + 5).equals(Buffer.from("false")) ||
    !base.subarray(offset + 4).equals(disabled.subarray(offset + 5))
  ) {
    fail("ROLLBACK_CONFIG_DIFF_NOT_LITERAL_FLAG");
  }
}

/**
 * Verify the ADR-0035 config-only B→D→R lineage without changing any checkout.
 * `launchIdentity` must be the object returned by validateLaunchContext from report.mjs.
 */
export async function validateRollbackLineage({
  launchIdentity,
  disabledRoot,
  disabledSha,
  restoredRoot,
  restoredSha,
}) {
  const context = launchIdentity?.context;
  const candidateRoot = launchIdentity?.candidateRoot;
  if (
    !context ||
    typeof candidateRoot !== "string" ||
    !SHA.test(context.candidateSha ?? "") ||
    resolve(context.checkoutDir ?? "") !== candidateRoot
  )
    fail("ROLLBACK_LAUNCH_CONTEXT_INVALID");

  const base = await inspectCheckout(candidateRoot, context.candidateSha);
  if (!SHA.test(disabledSha) || !SHA.test(restoredSha))
    fail("ROLLBACK_CHECKOUT_INPUT_INVALID");
  const disabled = await inspectCheckout(disabledRoot, disabledSha);
  const restored = await inspectCheckout(restoredRoot, restoredSha);
  if (new Set([base.root, disabled.root, restored.root]).size !== 3)
    fail("ROLLBACK_CHECKOUTS_NOT_DISTINCT");
  if (disabled.parents.length !== 1 || disabled.parents[0] !== base.commitSha)
    fail("ROLLBACK_DISABLED_PARENT_INVALID");
  if (
    restored.parents.length !== 1 ||
    restored.parents[0] !== disabled.commitSha
  )
    fail("ROLLBACK_RESTORED_PARENT_INVALID");

  assertOnlyConfigChanged(base, disabled);
  assertOnlyConfigChanged(disabled, restored);
  assertCanonicalConfigTransition(base, disabled);
  assertLiteralFlagChange(configBytes(base), configBytes(disabled));
  if (!configBytes(restored).equals(configBytes(base)))
    fail("ROLLBACK_RESTORED_CONFIG_BYTES_DIFFER");

  const receipt = (checkout) => ({
    commitSha: checkout.commitSha,
    parentShas: checkout.parents,
    treeSha: checkout.treeSha,
    configSha256: configSha256(checkout),
  });
  return {
    schemaVersion: 1,
    B: receipt(base),
    D: receipt(disabled),
    R: receipt(restored),
  };
}

function gitOutput(root, ...args) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    fail("ROLLBACK_ISOLATED_COMMIT_FAILED");
  }
}

function replaceMutationFlag(configBytes) {
  const source = configBytes.toString("utf8");
  let config;
  try {
    config = parseYaml(source);
  } catch {
    fail("ROLLBACK_CONFIG_INVALID");
  }
  if (config?.services?.["aroma-convergence"]?.mutationsEnabled !== true)
    fail("ROLLBACK_BASE_MUTATIONS_NOT_ENABLED");
  const matches = [
    ...source.matchAll(
      /^([\t ]*mutationsEnabled:[\t ]*)true([\t ]*(?:#.*)?)(\r?)$/gmu,
    ),
  ];
  if (matches.length !== 1) fail("ROLLBACK_MUTATION_FLAG_AMBIGUOUS");
  const match = matches[0];
  const changed = `${source.slice(0, match.index)}${match[1]}false${match[2]}${match[3]}${source.slice(match.index + match[0].length)}`;
  return Buffer.from(changed, "utf8");
}

/** Create disposable clean D/R clones; the candidate checkout itself is read-only. */
export async function createRollbackCheckouts({
  candidateRoot,
  candidateSha,
  parentDirectory = tmpdir(),
}) {
  if (typeof candidateRoot !== "string" || !SHA.test(candidateSha ?? ""))
    fail("ROLLBACK_CHECKOUT_INPUT_INVALID");
  const candidate = await inspectCheckout(candidateRoot, candidateSha);
  const directory = await mkdtemp(join(parentDirectory, "coffee-g18-lineage-"));
  const disabledRoot = join(directory, "D");
  const restoredRoot = join(directory, "R");
  try {
    gitOutput(directory, "--version");
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        candidate.root,
        disabledRoot,
      ],
      {
        stdio: "ignore",
        timeout: 60_000,
      },
    );
    gitOutput(
      disabledRoot,
      "checkout",
      "--quiet",
      "--detach",
      candidate.commitSha,
    );
    const originalConfig = configBytes(candidate);
    await writeFile(
      join(disabledRoot, CONFIG_PATH),
      replaceMutationFlag(originalConfig),
      { mode: 0o644 },
    );
    gitOutput(disabledRoot, "add", "--", CONFIG_PATH);
    gitOutput(
      disabledRoot,
      "-c",
      "user.name=Coffee G18 verifier",
      "-c",
      "user.email=coffee-g18-verifier@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Проверка отключения мутаций AROMA",
    );
    const disabledSha = gitText(disabledRoot, "rev-parse", "HEAD");

    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        disabledRoot,
        restoredRoot,
      ],
      {
        stdio: "ignore",
        timeout: 60_000,
      },
    );
    gitOutput(restoredRoot, "checkout", "--quiet", "--detach", disabledSha);
    await writeFile(join(restoredRoot, CONFIG_PATH), originalConfig, {
      mode: 0o644,
    });
    gitOutput(restoredRoot, "add", "--", CONFIG_PATH);
    gitOutput(
      restoredRoot,
      "-c",
      "user.name=Coffee G18 verifier",
      "-c",
      "user.email=coffee-g18-verifier@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Проверка возврата конфигурации AROMA",
    );
    const restoredSha = gitText(restoredRoot, "rev-parse", "HEAD");
    return { directory, disabledRoot, disabledSha, restoredRoot, restoredSha };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function runManagedRollbackChild({
  args,
  cwd,
  env,
  timeoutMs = 1_800_000,
  terminationGraceMs = 30_000,
  timeoutGate,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow = false;
    let timedOut = false;
    let interruptedBy;
    let killTimer;
    let timer;
    let closed = false;
    const append = (list, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 32 * 1024 * 1024) {
        overflow = true;
        stopChild("SIGTERM");
        return;
      }
      list.push(chunk);
    };
    const sendSignal = (signal) => {
      if (!child.pid || closed) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    };
    const stopChild = (signal) => {
      try {
        sendSignal(signal);
      } catch {
        /* close/timeout reports the bounded child failure */
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          try {
            sendSignal("SIGKILL");
          } catch {
            /* still await close */
          }
        }, terminationGraceMs);
        killTimer.unref();
      }
    };
    const signalHandler = (signal) => {
      interruptedBy ??= signal;
      stopChild(signal);
    };
    const armTimeout = () => {
      timer = setTimeout(() => {
        timedOut = true;
        stopChild("SIGTERM");
      }, timeoutMs);
    };
    if (timeoutGate === undefined) armTimeout();
    else {
      void Promise.resolve(timeoutGate).then(
        () => {
          if (!closed) armTimeout();
        },
        () => {
          if (!closed) stopChild("SIGKILL");
        },
      );
    }
    process.once("SIGINT", signalHandler);
    process.once("SIGTERM", signalHandler);
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.once("error", () => {
      /* close or spawn error is converted to a finite failure below */
    });
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      process.removeListener("SIGINT", signalHandler);
      process.removeListener("SIGTERM", signalHandler);
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        joined: true,
      };
      if (timedOut || interruptedBy || overflow || code !== 0) {
        const error = new Error(
          timedOut
            ? "ROLLBACK_CHILD_TIMEOUT"
            : interruptedBy
              ? `ROLLBACK_CHILD_INTERRUPTED_${interruptedBy}`
              : overflow
                ? "ROLLBACK_CHILD_OUTPUT_LIMIT"
                : "ROLLBACK_CHILD_FAILED",
        );
        error.result = result;
        rejectPromise(error);
      } else resolvePromise(result);
    });
  });
}

function lastJsonLine(output) {
  const line = output.split(/\r?\n/u).filter(Boolean).at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch {
    fail("ROLLBACK_RUNTIME_RECEIPT_INVALID");
  }
}

function failureCleanupIsValid(cleanup) {
  if (
    !cleanup ||
    typeof cleanup.complete !== "boolean" ||
    typeof cleanup.verified !== "boolean" ||
    !Array.isArray(cleanup.failures) ||
    !Array.isArray(cleanup.retainedResources) ||
    !cleanup.inventory ||
    !["containers", "volumes", "networks"].every((kind) =>
      Array.isArray(cleanup.inventory[kind]),
    )
  )
    return false;
  if (!cleanup.verified) return cleanup.complete === false;
  return (
    ["containers", "volumes", "networks"].every((kind) =>
      cleanup.inventory[kind].every(
        (name) =>
          typeof name === "string" &&
          /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name),
      ),
    ) &&
    cleanup.retainedResources.every(
      (resource) =>
        resource &&
        ["containers", "volumes", "networks"].includes(resource.kind) &&
        typeof resource.name === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(resource.name),
    ) &&
    cleanup.failures.every((value) =>
      [
        "orders-fixture-tables",
        "owner-database-client",
        "compose-down",
        "postgres-container-remove",
        "postgres-network-remove",
        "resource-inventory",
        "temporary-artifacts",
      ].includes(value),
    )
  );
}

function sourceLocationIsValid(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 3 &&
    value.source === ROLLBACK_COMPOSE_SOURCE &&
    Number.isSafeInteger(value.line) &&
    value.line > 0 &&
    value.line <= MAX_SOURCE_COORDINATE &&
    Number.isSafeInteger(value.column) &&
    value.column > 0 &&
    value.column <= MAX_SOURCE_COORDINATE
  );
}

export function rollbackComposeSourceLocation(error) {
  let stack;
  try {
    stack = error?.stack;
  } catch {
    return undefined;
  }
  if (typeof stack !== "string" || stack.length > 131_072) return undefined;
  for (const frame of stack.split(/\r?\n/u).slice(1, 257)) {
    const match = /^\s*at (?:(?:.*) \()?(.+?):(\d+):(\d+)\)?$/u.exec(frame);
    if (
      !match ||
      ![ROLLBACK_COMPOSE_SOURCE_PATH, ROLLBACK_COMPOSE_SOURCE_URL].includes(
        match[1],
      )
    )
      continue;
    const line = Number(match[2]);
    const column = Number(match[3]);
    const location = {
      source: ROLLBACK_COMPOSE_SOURCE,
      line,
      column,
    };
    return sourceLocationIsValid(location)
      ? Object.freeze(location)
      : undefined;
  }
  return undefined;
}

export function validateRollbackFailureArtifact(
  artifact,
  { runId, candidateSha, lineage },
) {
  if (
    !artifact ||
    artifact.schemaVersion !== 1 ||
    artifact.gateId !== "G18_ROLLBACK" ||
    artifact.outcome !== "FAIL" ||
    artifact.runId !== runId ||
    artifact.candidateSha !== candidateSha ||
    !isDeepStrictEqual(artifact.lineage, lineage) ||
    !ROLLBACK_FAILURE_STAGES.includes(artifact.stage) ||
    !ROLLBACK_FAILURE_CODES.has(artifact.code) ||
    !ROLLBACK_ERROR_NAMES.has(artifact.errorName) ||
    (artifact.disabledReconcileSubstage !== undefined &&
      (artifact.stage !== "disabled-reconcile" ||
        !ROLLBACK_DISABLED_RECONCILE_SUBSTAGES.includes(
          artifact.disabledReconcileSubstage,
        ))) ||
    (artifact.sourceLocation !== undefined &&
      !sourceLocationIsValid(artifact.sourceLocation)) ||
    !/^[0-9a-f]{64}$/u.test(artifact.messageSha256 ?? "") ||
    !failureCleanupIsValid(artifact.cleanup)
  )
    fail("ROLLBACK_FAILURE_ARTIFACT_INVALID");
  return true;
}

export function createRollbackFailureReceipt({
  runId,
  candidateSha,
  stage,
  error,
  cleanup,
  cleanupFailed = false,
}) {
  if (
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runId ?? "") ||
    !SHA.test(candidateSha ?? "") ||
    !runId.endsWith(`-${candidateSha.slice(0, 7)}`)
  )
    fail("ROLLBACK_FAILURE_RECEIPT_INVALID");
  const errorName = ROLLBACK_ERROR_NAMES.has(error?.name)
    ? error.name
    : "Error";
  const message =
    typeof error?.message === "string" ? error.message : "G18_PHASE_FAILED";
  const receipt = {
    schemaVersion: 1,
    gateId: "G18_ROLLBACK",
    outcome: "FAIL",
    runId,
    candidateSha,
    stage: ROLLBACK_FAILURE_STAGES.includes(stage) ? stage : "child-process",
    code: cleanupFailed ? "G18_CLEANUP_FAILED" : "G18_PHASE_FAILED",
    errorName,
    messageSha256: createHash("sha256").update(message).digest("hex"),
    cleanup,
  };
  const sourceLocation = rollbackComposeSourceLocation(error);
  if (sourceLocation) receipt.sourceLocation = sourceLocation;
  if (!failureCleanupIsValid(cleanup)) fail("ROLLBACK_FAILURE_RECEIPT_INVALID");
  return Object.freeze(receipt);
}

export function attachRollbackDisabledReconcileSubstage(receipt, substage) {
  if (
    receipt?.stage !== "disabled-reconcile" ||
    !ROLLBACK_DISABLED_RECONCILE_SUBSTAGES.includes(substage)
  )
    fail("ROLLBACK_DISABLED_RECONCILE_SUBSTAGE_INVALID");
  return Object.freeze({ ...receipt, disabledReconcileSubstage: substage });
}

export async function writeRollbackFailureArtifact({
  artifact,
  identity,
  evidenceDir,
}) {
  validateRollbackFailureArtifact(artifact, identity);
  const artifactPath = join(
    evidenceDir,
    "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback-failure.json",
  );
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const artifactStat = await stat(artifactPath);
  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  return { path: artifactPath, sha256: digest, sizeBytes: artifactStat.size };
}

export async function persistRollbackFailureFromChild({
  error,
  identity,
  lineage,
  evidenceDir,
}) {
  let failure;
  try {
    const value = lastJsonLine(error?.result?.stdout ?? "");
    if (
      value?.schemaVersion !== 1 ||
      value?.gateId !== "G18_ROLLBACK" ||
      value?.outcome !== "FAIL" ||
      value?.runId !== identity.runId ||
      value?.candidateSha !== identity.candidateSha ||
      !ROLLBACK_FAILURE_STAGES.includes(value.stage) ||
      !ROLLBACK_FAILURE_CODES.has(value.code) ||
      !ROLLBACK_ERROR_NAMES.has(value.errorName) ||
      (value.disabledReconcileSubstage !== undefined &&
        (value.stage !== "disabled-reconcile" ||
          !ROLLBACK_DISABLED_RECONCILE_SUBSTAGES.includes(
            value.disabledReconcileSubstage,
          ))) ||
      (value.sourceLocation !== undefined &&
        !sourceLocationIsValid(value.sourceLocation)) ||
      !/^[0-9a-f]{64}$/u.test(value.messageSha256 ?? "") ||
      !failureCleanupIsValid(value.cleanup)
    )
      fail("ROLLBACK_FAILURE_RECEIPT_INVALID");
    failure = value;
  } catch {
    failure = {
      schemaVersion: 1,
      gateId: "G18_ROLLBACK",
      outcome: "FAIL",
      runId: identity.runId,
      candidateSha: identity.candidateSha,
      stage: "child-process",
      code: "ROLLBACK_FAILURE_RECEIPT_INVALID",
      errorName: "Error",
      messageSha256: createHash("sha256")
        .update("ROLLBACK_FAILURE_RECEIPT_INVALID")
        .digest("hex"),
      cleanup: {
        verified: false,
        complete: false,
        failures: [],
        retainedResources: [],
        inventory: { containers: [], volumes: [], networks: [] },
      },
    };
  }
  const artifact = { ...failure, lineage };
  const receipt = await writeRollbackFailureArtifact({
    artifact,
    identity: {
      runId: identity.runId,
      candidateSha: identity.candidateSha,
      lineage,
    },
    evidenceDir,
  });
  return { artifact, receipt };
}

export function validateRollbackRuntimeArtifact(
  artifact,
  { runId, candidateSha, lineage },
) {
  const { B, D, R } = artifact?.lineage ?? {};
  if (
    !artifact ||
    artifact.schemaVersion !== 1 ||
    artifact.gateId !== "G18_ROLLBACK" ||
    artifact.runId !== runId ||
    artifact.candidateSha !== candidateSha ||
    !isDeepStrictEqual(artifact.lineage, lineage) ||
    B?.commitSha !== candidateSha ||
    !SHA.test(B?.treeSha ?? "") ||
    !SHA.test(D?.commitSha ?? "") ||
    !SHA.test(D?.treeSha ?? "") ||
    !SHA.test(R?.commitSha ?? "") ||
    !SHA.test(R?.treeSha ?? "") ||
    D?.parentShas?.length !== 1 ||
    D.parentShas[0] !== B.commitSha ||
    R?.parentShas?.length !== 1 ||
    R.parentShas[0] !== D.commitSha ||
    B?.parentShas?.some((parent) => !SHA.test(parent)) ||
    D.parentShas.some((parent) => !SHA.test(parent)) ||
    R.parentShas.some((parent) => !SHA.test(parent)) ||
    ![B?.configSha256, D?.configSha256, R?.configSha256].every((value) =>
      /^[0-9a-f]{64}$/u.test(value ?? ""),
    ) ||
    B.configSha256 === D.configSha256 ||
    B.configSha256 !== R.configSha256 ||
    artifact.runtimeProof?.schemaVersion !== 1 ||
    artifact.runtimeProof?.candidateSha !== candidateSha ||
    !isDeepStrictEqual(artifact.runtimeProof?.lineage, artifact.lineage) ||
    artifact.cleanup?.complete !== true ||
    !Array.isArray(artifact.cleanup?.failures) ||
    artifact.cleanup.failures.length !== 0 ||
    !Array.isArray(artifact.cleanup?.retainedResources) ||
    artifact.cleanup.retainedResources.length !== 0 ||
    !artifact.cleanup?.inventory ||
    !["containers", "volumes", "networks"].every(
      (kind) =>
        Array.isArray(artifact.cleanup.inventory[kind]) &&
        artifact.cleanup.inventory[kind].length === 0,
    )
  ) {
    fail("ROLLBACK_RUNTIME_ARTIFACT_IDENTITY_INVALID");
  }
  const proof = artifact.runtimeProof;
  if (
    proof.provider?.kind !== "local-fake" ||
    proof.provider.liveProviderAcceptance !== false ||
    proof.runtime?.disabledConfig?.mutationsEnabled !== false ||
    proof.runtime?.disabledConfig?.baseConfigSha256 !==
      lineage.B.configSha256 ||
    proof.runtime?.disabledConfig?.actualConfigSha256 !==
      lineage.D.configSha256 ||
    proof.runtime?.disabledConfig?.phase !== "disabled" ||
    proof.runtime?.restoredConfig?.mutationsEnabled !== true ||
    proof.runtime?.restoredConfig?.baseConfigSha256 !==
      lineage.B.configSha256 ||
    proof.runtime?.restoredConfig?.actualConfigSha256 !==
      lineage.R.configSha256 ||
    proof.runtime?.restoredConfig?.phase !== "base" ||
    proof.ownerHttp?.unknown !== "UnknownOutcome" ||
    proof.ownerHttp?.disabled !== "Blocked" ||
    proof.ownerHttp?.restored !== "InSync" ||
    proof.orders?.oldReservationState !== "RecoveredNotApplied" ||
    proof.orders?.oldGatewayState !== "UnknownOutcome" ||
    proof.orders?.newReservationState !== "Verified" ||
    !/^[0-9a-f]{64}$/u.test(proof.orders?.oldOperationDigest ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof.orders?.newOperationDigest ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof.orders?.historyBeforeDigest ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof.orders?.historyAfterDigest ?? "")
  ) {
    fail("ROLLBACK_RUNTIME_ARTIFACT_PHASE_INVALID");
  }
  return true;
}

export async function writeRollbackRuntimeArtifact({
  artifact,
  identity,
  evidenceDir,
}) {
  validateRollbackRuntimeArtifact(artifact, identity);
  const artifactPath = join(
    evidenceDir,
    "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback.json",
  );
  await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  const artifactStat = await stat(artifactPath);
  const digest = createHash("sha256")
    .update(await readFile(artifactPath))
    .digest("hex");
  return { path: artifactPath, sha256: digest, sizeBytes: artifactStat.size };
}

export async function writeRollbackLineageBundle({
  restoredRoot,
  candidateSha,
  restoredSha,
  evidenceDir,
}) {
  await inspectCheckout(restoredRoot, restoredSha);
  if (!SHA.test(candidateSha ?? "")) fail("ROLLBACK_CHECKOUT_INPUT_INVALID");
  const temporaryBundle = join(
    restoredRoot,
    ".git",
    "rollback-config-lineage.bundle",
  );
  gitOutput(
    restoredRoot,
    "bundle",
    "create",
    temporaryBundle,
    "HEAD",
    `^${candidateSha}`,
  );
  gitOutput(restoredRoot, "bundle", "verify", temporaryBundle);
  if (
    gitOutput(restoredRoot, "bundle", "list-heads", temporaryBundle) !==
    `${restoredSha} HEAD`
  )
    fail("ROLLBACK_LINEAGE_BUNDLE_INVALID");
  const metadata = await lstat(temporaryBundle);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 16 * 1024 * 1024
  )
    fail("ROLLBACK_LINEAGE_BUNDLE_INVALID");
  const bytes = await readFile(temporaryBundle);
  const path = join(
    evidenceDir,
    "gates/G18_ROLLBACK/artifacts/rollback-config-lineage.bundle",
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  const receipt = {
    schemaVersion: 1,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    prerequisiteCommit: candidateSha,
    restoredCommit: restoredSha,
  };
  await writeFile(`${path}.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

async function assertRollbackContainersStopped(projectName) {
  const output = execFileSync(
    "docker",
    [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    },
  ).trim();
  if (output) fail("ROLLBACK_COMPOSE_CONTAINERS_STILL_OWN_MOUNTS");
}

/** Runtime gate entry point. The Compose proof performs lineage validation again before creating resources. */
export async function runRollbackScenario(
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
) {
  if (!contextPath) fail("ROLLBACK_LAUNCH_CONTEXT_MISSING");
  const launchIdentity = await validateLaunchContext(contextPath);
  if (
    launchIdentity.candidateRoot !== PROJECT_ROOT ||
    resolve(process.cwd()) !== launchIdentity.candidateRoot
  ) {
    fail("ROLLBACK_CANDIDATE_EXECUTION_MISMATCH");
  }
  const { context, candidateRoot } = launchIdentity;
  const expectedProject = rollbackComposeProjectName(context);
  if (context.candidateSha !== gitText(candidateRoot, "rev-parse", "HEAD"))
    fail("ROLLBACK_CANDIDATE_HEAD_MISMATCH");
  const checkouts = await createRollbackCheckouts({
    candidateRoot,
    candidateSha: context.candidateSha,
  });
  let childJoined = true;
  let childStarted = false;
  let lineage;
  try {
    lineage = await validateRollbackLineage({ launchIdentity, ...checkouts });
    await writeRollbackLineageBundle({
      ...checkouts,
      candidateSha: context.candidateSha,
      evidenceDir: context.evidenceDir,
    });
    const args = [
      join(candidateRoot, "tools/compose-smoke.mjs"),
      "--mutation-disable-rollback",
      "--project-name",
      expectedProject,
      "--disabled-root",
      checkouts.disabledRoot,
      "--disabled-sha",
      checkouts.disabledSha,
      "--restored-root",
      checkouts.restoredRoot,
      "--restored-sha",
      checkouts.restoredSha,
    ];
    childJoined = false;
    childStarted = true;
    const result = await runManagedRollbackChild({
      args,
      cwd: candidateRoot,
      terminationGraceMs: 120_000,
      env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: resolve(contextPath) },
    });
    childJoined = result.joined;
    const composeReceipt = lastJsonLine(result.stdout);
    const artifact = {
      schemaVersion: 1,
      gateId: "G18_ROLLBACK",
      runId: context.runId,
      candidateSha: context.candidateSha,
      lineage,
      runtimeProof: composeReceipt.mutationDisableRollback,
      cleanup: composeReceipt.cleanup,
    };
    const runtimeArtifact = await writeRollbackRuntimeArtifact({
      artifact,
      identity: {
        runId: context.runId,
        candidateSha: context.candidateSha,
        lineage,
      },
      evidenceDir: context.evidenceDir,
    });
    return { schemaVersion: 1, lineage, runtimeArtifact };
  } catch (error) {
    childJoined ||= error?.result?.joined === true;
    if (childStarted) {
      await persistRollbackFailureFromChild({
        error,
        identity: { runId: context.runId, candidateSha: context.candidateSha },
        lineage,
        evidenceDir: context.evidenceDir,
      });
    }
    if (error?.message === "ROLLBACK_BASE_MUTATIONS_NOT_ENABLED")
      fail("ROLLBACK_BASE_MUTATIONS_NOT_ENABLED");
    fail(
      error?.message?.startsWith("ROLLBACK_CHILD_INTERRUPTED_")
        ? error.message
        : "ROLLBACK_RUNTIME_PROOF_FAILED",
    );
  } finally {
    if (!childJoined) fail("ROLLBACK_CHILD_NOT_JOINED");
    if (childStarted) await assertRollbackContainersStopped(expectedProject);
    await rm(checkouts.directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(JSON.stringify(await runRollbackScenario()));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "ROLLBACK_RUNTIME_PROOF_FAILED",
    );
    process.exitCode = 1;
  }
}
