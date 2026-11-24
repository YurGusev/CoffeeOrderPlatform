import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as parseYaml } from "js-yaml";

const CONFIG_PATH = "config/platform.yaml";
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
export const BROWSER_CHILD_DIRECTORY_NAME =
  /^\.(?:g15-)?browser-child-[A-Za-z0-9]+$/u;
const MAX_CHILD_DIAGNOSTIC_CHARS = 4096;
const CHILD_KEYS = Object.freeze([
  "schemaVersion",
  "candidateSha",
  "baseConfigSha256",
  "runId",
  "checkoutDir",
  "sourceRepoRoot",
  "acceptedBaseCommit",
  "startedAtUtc",
  "evidenceDir",
  "githubSnapshotPath",
  "resources",
]);

function fail(code) {
  throw new Error(code);
}

function browserFail(code) {
  throw Object.assign(new Error(code), { code });
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

function gitBytes(root, ...args) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    browserFail("BROWSER_CHILD_GIT_FAILED");
  }
}

function gitAdmission(args, stage, options = {}) {
  try {
    return execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
  } catch {
    browserFail(stage);
  }
}

function exactKeys(value, expected) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    isDeepStrictEqual(
      Object.keys(value).sort((left, right) => left.localeCompare(right)),
      [...expected].sort((left, right) => left.localeCompare(right)),
    )
  );
}

export async function inspectLaunchCheckout(
  path,
  expectedSha,
  { ownedChildRoot } = {},
) {
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
  const status = git(
    canonical,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--no-renames",
    "-z",
  );
  if (ownedChildRoot !== undefined) {
    const name = ownedChildRoot.slice(canonical.length + 1);
    const info = await lstat(ownedChildRoot).catch(() => null);
    if (
      dirname(ownedChildRoot) !== canonical ||
      !BROWSER_CHILD_DIRECTORY_NAME.test(name) ||
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(ownedChildRoot)) !== ownedChildRoot ||
      git(canonical, "ls-files", "--", name).length !== 0 ||
      !status.equals(Buffer.from(`?? ${name}/\0`))
    )
      fail("ROLLBACK_CHECKOUT_DIRTY");
  } else if (status.length !== 0) fail("ROLLBACK_CHECKOUT_DIRTY");
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

function redactChildDiagnostic(text) {
  return String(text)
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED PRIVATE MATERIAL]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "Bearer [REDACTED]")
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/giu,
      "[REDACTED-URL]",
    )
    .replace(
      /\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/giu,
      "$1[REDACTED]",
    );
}

function childDiagnostic(result) {
  const sections = [];
  for (const [name, value] of [
    ["stderr", result.stderr],
    ["stdout", result.stdout],
  ]) {
    if (typeof value !== "string") continue;
    const tail = value.trimEnd().slice(-MAX_CHILD_DIAGNOSTIC_CHARS);
    if (!tail.trim()) continue;
    sections.push(`${name}:\n${tail}`);
  }
  if (sections.length === 0) return undefined;
  const text = redactChildDiagnostic(sections.join("\n"));
  return text.length > MAX_CHILD_DIAGNOSTIC_CHARS
    ? `[truncated]\n${text.slice(-MAX_CHILD_DIAGNOSTIC_CHARS)}`
    : text;
}

export function runManagedRollbackChild({
  args,
  cwd,
  env,
  timeoutMs = 1_800_000,
  terminationGraceMs = 30_000,
  timeoutGate,
  onIpc,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: onIpc
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let overflow = false;
    let ipcFailed = false;
    let ipcBusy = false;
    let ipcCompleted = false;
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
    if (onIpc)
      child.on("disconnect", () => {
        if (!ipcCompleted) ipcFailed = true;
      });
    if (onIpc)
      child.on("message", (message, handle) => {
        if (
          handle ||
          ipcBusy ||
          !message ||
          typeof message !== "object" ||
          Buffer.byteLength(JSON.stringify(message)) > 32768
        ) {
          ipcFailed = true;
          stopChild("SIGTERM");
          return;
        }
        ipcBusy = true;
        Promise.resolve()
          .then(() => onIpc(message))
          .then(
            (payload) => {
              if (message.stage === "cleanup") ipcCompleted = true;
              if (child.connected)
                child.send(
                  { ok: true, stage: message.stage, payload },
                  () => {},
                );
            },
            () => {
              ipcFailed = true;
              if (child.connected)
                child.send({ ok: false, stage: message.stage }, () => {});
            },
          )
          .finally(() => {
            ipcBusy = false;
          });
      });
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
      if (timedOut || interruptedBy || overflow || ipcFailed || code !== 0) {
        const error = new Error(
          timedOut
            ? "ROLLBACK_CHILD_TIMEOUT"
            : interruptedBy
              ? `ROLLBACK_CHILD_INTERRUPTED_${interruptedBy}`
              : overflow
                ? "ROLLBACK_CHILD_OUTPUT_LIMIT"
                : ipcFailed
                  ? "ROLLBACK_CHILD_IPC_FAILED"
                  : "ROLLBACK_CHILD_FAILED",
        );
        error.result = result;
        const diagnostic = childDiagnostic(result);
        if (diagnostic !== undefined) error.diagnostic = diagnostic;
        rejectPromise(error);
      } else resolvePromise(result);
    });
  });
}

export function validateBrowserChildContext(
  childContext,
  parentContext,
  parentCandidateRoot,
) {
  if (
    !exactKeys(childContext, CHILD_KEYS) ||
    childContext.schemaVersion !== 1 ||
    !RUN_ID.test(childContext.runId ?? "") ||
    childContext.runId === parentContext.runId ||
    !SHA.test(childContext.candidateSha ?? "") ||
    !SHA256.test(childContext.baseConfigSha256 ?? "") ||
    childContext.sourceRepoRoot !== parentCandidateRoot ||
    childContext.acceptedBaseCommit !== parentContext.acceptedBaseCommit ||
    childContext.evidenceDir !==
      join(parentCandidateRoot, "evidence/launch", childContext.runId) ||
    !exactKeys(childContext.resources, [
      "composeProject",
      "g08PreparationContextPath",
      "g15ParentCandidateSha",
      "g15ParentCheckoutRoot",
      "g15ParentRunId",
      "kafkaPrefix",
    ]) ||
    childContext.resources?.composeProject !==
      `coffee-launch-${childContext.runId.toLowerCase()}` ||
    childContext.resources?.g08PreparationContextPath !==
      join(parentContext.evidenceDir, "context.json") ||
    childContext.resources?.g15ParentCandidateSha !==
      parentContext.candidateSha ||
    childContext.resources?.g15ParentCheckoutRoot !== parentCandidateRoot ||
    childContext.resources?.g15ParentRunId !== parentContext.runId ||
    childContext.resources?.kafkaPrefix !== childContext.runId
  )
    browserFail("BROWSER_CHILD_CONTEXT_INVALID");
}

export function browserChildBundleRef(heads, candidateSha) {
  const [sha, ref, ...rest] = heads;
  if (
    rest.length !== 0 ||
    sha !== candidateSha ||
    (ref !== "refs/heads/browser-child" &&
      ref !== "refs/heads/g15-browser-child")
  )
    browserFail("BROWSER_BUNDLE_REF_INVALID");
  return ref;
}

export async function verifyBrowserChildBundle({
  bundlePath,
  baseCandidateSha,
  childContext,
  lineageReceipt,
  baseConfigBytes,
  childConfigBytes,
  baseSourceRoot = childContext.sourceRepoRoot,
  validateLineage,
}) {
  if (
    baseSourceRoot !== childContext.sourceRepoRoot &&
    (gitText(baseSourceRoot, "rev-parse", "HEAD") !== baseCandidateSha ||
      !gitBytes(
        baseSourceRoot,
        "cat-file",
        "blob",
        `${baseCandidateSha}:config/platform.yaml`,
      ).equals(baseConfigBytes))
  )
    browserFail("BROWSER_BUNDLE_BASE_MISMATCH");
  const tempRoot = await mkdtemp(join(tmpdir(), "coffee-browser-admission-"));
  const objectStore = join(tempRoot, "objects.git");
  const checkoutRoot = join(tempRoot, "checkout");
  try {
    gitAdmission(
      ["init", "--bare", objectStore],
      "BROWSER_BUNDLE_STORE_INIT_FAILED",
      { stdio: "ignore", timeout: 30_000 },
    );
    gitAdmission(
      [
        "--git-dir",
        objectStore,
        "fetch",
        "--no-tags",
        baseSourceRoot,
        `${baseCandidateSha}:refs/heads/browser-base`,
      ],
      "BROWSER_BUNDLE_BASE_MISSING",
      { stdio: "ignore", timeout: 60_000 },
    );
    gitAdmission(
      ["-C", objectStore, "bundle", "verify", bundlePath],
      "BROWSER_BUNDLE_VERIFY_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    const heads = gitAdmission(
      ["bundle", "list-heads", bundlePath],
      "BROWSER_BUNDLE_HEADS_FAILED",
      { cwd: objectStore, encoding: "utf8", timeout: 30_000 },
    )
      .trim()
      .split(/\s+/u);
    const bundleRef = browserChildBundleRef(heads, childContext.candidateSha);
    gitAdmission(
      [
        "-C",
        objectStore,
        "fetch",
        "--no-tags",
        bundlePath,
        `${bundleRef}:${bundleRef}`,
      ],
      "BROWSER_BUNDLE_FETCH_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    gitAdmission(
      [
        "--git-dir",
        objectStore,
        "worktree",
        "add",
        "--detach",
        checkoutRoot,
        childContext.candidateSha,
      ],
      "BROWSER_BUNDLE_CHECKOUT_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    const checked = await validateLineage({
      candidateRoot: checkoutRoot,
      baseCandidateSha,
      candidateSha: childContext.candidateSha,
      runId: childContext.runId,
      configSha256: childContext.baseConfigSha256,
    });
    if (
      !isDeepStrictEqual(checked.receipt, lineageReceipt) ||
      !gitBytes(
        checkoutRoot,
        "cat-file",
        "blob",
        `${baseCandidateSha}:config/platform.yaml`,
      ).equals(baseConfigBytes) ||
      !gitBytes(
        checkoutRoot,
        "cat-file",
        "blob",
        `${childContext.candidateSha}:config/platform.yaml`,
      ).equals(childConfigBytes)
    )
      browserFail("BROWSER_BUNDLE_LINEAGE_MISMATCH");
    return checked.receipt;
  } catch (error) {
    if (error?.code?.startsWith("BROWSER_")) throw error;
    browserFail("BROWSER_BUNDLE_ADMISSION_FAILED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const CONFIG_PATH_BYTES = Buffer.from(CONFIG_PATH);
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROLLBACK_COMPOSE_SOURCE_PATH = join(
  PROJECT_ROOT,
  "tools/compose-smoke.mjs",
);
const ROLLBACK_COMPOSE_SOURCE_URL = pathToFileURL(
  ROLLBACK_COMPOSE_SOURCE_PATH,
).href;
const ROLLBACK_COMPOSE_SOURCE = "tools/compose-smoke.mjs";
const MAX_SOURCE_COORDINATE = 1_000_000;

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
export const ROLLBACK_FAILURE_CODES = new Set([
  "ROLLBACK_PHASE_FAILED",
  "ROLLBACK_CLEANUP_FAILED",
  "ROLLBACK_FAILURE_RECEIPT_INVALID",
]);
export const ROLLBACK_ERROR_NAMES = new Set([
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

export function configBytes(checkout) {
  return git(
    checkout.root,
    "cat-file",
    "blob",
    `${checkout.commitSha}:${CONFIG_PATH}`,
  );
}

export function parsedConfig(checkout) {
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

export function assertLiteralFlagChange(base, disabled) {
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

  const base = await inspectLaunchCheckout(candidateRoot, context.candidateSha);
  if (!SHA.test(disabledSha) || !SHA.test(restoredSha))
    fail("ROLLBACK_CHECKOUT_INPUT_INVALID");
  const disabled = await inspectLaunchCheckout(disabledRoot, disabledSha);
  const restored = await inspectLaunchCheckout(restoredRoot, restoredSha);
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

export async function validateConfigOnlyLineage({
  parentRoot,
  parentSha,
  baselineRoot,
  baselineSha,
}) {
  const parent = await inspectLaunchCheckout(parentRoot, parentSha);
  const baseline = await inspectLaunchCheckout(baselineRoot, baselineSha);
  if (baseline.parents.length !== 1 || baseline.parents[0] !== parent.commitSha)
    fail("ROLLBACK_BASELINE_PARENT_INVALID");
  assertOnlyConfigChanged(parent, baseline);
  return { parent, baseline };
}

/** Validate the approved parent(false) → rollback baseline(true) transition. */
export async function validateRollbackBaseline({
  parentRoot,
  parentSha,
  baselineRoot,
  baselineSha,
}) {
  const { parent, baseline } = await validateConfigOnlyLineage({
    parentRoot,
    parentSha,
    baselineRoot,
    baselineSha,
  });
  assertCanonicalConfigTransition(baseline, parent);
  assertLiteralFlagChange(configBytes(baseline), configBytes(parent));
  return {
    parent: {
      commitSha: parent.commitSha,
      treeSha: parent.treeSha,
      configSha256: configSha256(parent),
    },
    baseline: {
      commitSha: baseline.commitSha,
      treeSha: baseline.treeSha,
      configSha256: configSha256(baseline),
    },
  };
}

export async function readRollbackParent(launchIdentity) {
  const { context, sourceRoot, candidateRoot } = launchIdentity;
  const resources = context.resources;
  if (
    resources?.controlledScope !== "rollback" ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(
      resources.controlledParentRunId ?? "",
    ) ||
    !SHA.test(resources.controlledParentCandidateSha ?? "")
  )
    fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
  const parentPath = join(
    sourceRoot,
    "evidence/launch",
    resources.controlledParentRunId,
    "context.json",
  );
  if (
    resources.controlledParentContextPath !== parentPath ||
    (await realpath(parentPath)) !== parentPath
  )
    fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
  const info = await lstat(parentPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o400 ||
    info.size > 16384
  )
    fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
  const parentContext = JSON.parse(await readFile(parentPath, "utf8"));
  if (
    parentContext.runId !== resources.controlledParentRunId ||
    parentContext.candidateSha !== resources.controlledParentCandidateSha ||
    parentContext.sourceRepoRoot !== sourceRoot
  )
    fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
  const lineage = await validateRollbackBaseline({
    parentRoot: parentContext.checkoutDir,
    parentSha: parentContext.candidateSha,
    baselineRoot: candidateRoot,
    baselineSha: context.candidateSha,
  });
  if (
    lineage.parent.configSha256 !== parentContext.baseConfigSha256 ||
    lineage.baseline.configSha256 !== context.baseConfigSha256
  )
    fail("ROLLBACK_CONTROLLED_CONFIG_INVALID");
  const parentReport = await import(
    pathToFileURL(
      join(parentContext.checkoutDir, "verification/launch/v1/report.mjs"),
    ).href
  );
  const parentIdentity = await parentReport.validateLaunchContext(parentPath);
  if (
    parentIdentity.sourceRoot !== sourceRoot ||
    parentIdentity.candidateRoot !== parentContext.checkoutDir
  )
    fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
  return { contextFile: parentPath, identity: parentIdentity, lineage };
}

export function failureCleanupIsValid(cleanup) {
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

export function sourceLocationIsValid(value) {
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
    typeof error?.message === "string"
      ? error.message
      : "ROLLBACK_PHASE_FAILED";
  const receipt = {
    schemaVersion: 1,
    gateId: "rollback",
    outcome: "FAIL",
    runId,
    candidateSha,
    stage: ROLLBACK_FAILURE_STAGES.includes(stage) ? stage : "child-process",
    code: cleanupFailed ? "ROLLBACK_CLEANUP_FAILED" : "ROLLBACK_PHASE_FAILED",
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
