import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
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
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadPlatformConfig } from "../../../../scripts/config-lib.mjs";
import {
  fixtureConfigText,
  validateBrowserFixtureGitLineage,
  validateBrowserFixtureLineage,
} from "../../../../tools/config-bootstrap/browser-fixture.mjs";
import { validateBrowserRuntimeArtifact } from "../../../../tools/browser-proof.mjs";
import { validateLaunchContext } from "../report.mjs";
import { inspectLaunchCheckout, runManagedRollbackChild } from "./rollback.mjs";

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const CHILD_REF = "refs/heads/g15-browser-child";
const ARTIFACTS = Object.freeze({
  childContext: "g15-child-context.json",
  lineage: "g15-oidc-fixture-lineage.json",
  browserRuntime: "g15-child-browser-runtime.json",
  bundle: "g15-browser-child.bundle",
  baseConfig: "g15-base-platform.yaml",
  childConfig: "g15-child-platform.yaml",
  parentRuntime: "browser-parent.json",
  parentFailure: "browser-parent-failure.json",
});
const CORRELATION_ARTIFACTS = Object.freeze({
  childContext: "browser-context.json",
  lineage: "browser-lineage.json",
  bundle: "browser-source.bundle",
  baseConfig: "browser-base.yaml",
  childConfig: "browser-config.yaml",
  receipt: "browser-correlation.json",
});
const PARENT_KEYS = Object.freeze([
  "schemaVersion",
  "gateId",
  "runId",
  "candidateSha",
  "baseConfigSha256",
  "status",
  "verificationOnly",
  "productionLogin",
  "child",
  "callbackProof",
  "cleanup",
]);
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
const BROWSER_FAILURE_ERROR_NAMES = new Set([
  "Error",
  "AssertionError",
  "AggregateError",
  "TypeError",
  "RangeError",
]);
const BROWSER_FAILURE_SIGNALS = new Set([
  "SIGABRT",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGTERM",
  "SIGHUP",
]);
const BROWSER_OPERATION_FAILURE_CLASSES = new Set([
  "timeout",
  "nonzero-exit",
  "signal",
  "spawn-error",
  "operation-error",
]);
const BROWSER_CONTAINER_SNAPSHOT_STATUSES = new Set([
  "captured",
  "partial",
  "unavailable",
  "invalid-input",
  "limit-exceeded",
]);
const BROWSER_CONTAINER_SERVICES = new Set([
  "web",
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
  "edge-nginx",
  "kafka",
  "aroma-provider-fixture",
  "postgres-proof",
  "unknown",
]);
const BROWSER_CONTAINER_STATES = new Set([
  "created",
  "dead",
  "exited",
  "paused",
  "removing",
  "restarting",
  "running",
  "unknown",
]);
const BROWSER_CONTAINER_HEALTH = new Set(["healthy", "starting", "unhealthy"]);
const BROWSER_CONTAINER_LIMIT = 32;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(root, ...args) {
  try {
    return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    }).trim();
  } catch {
    fail("G15_CHILD_GIT_FAILED");
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
    fail("G15_CHILD_GIT_FAILED");
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
    fail(stage);
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

async function assertPrivateFile(path, expectedMode, maxBytes) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== expectedMode ||
    info.size > maxBytes ||
    (await realpath(path)) !== path
  )
    fail("G15_PARENT_ARTIFACT_INVALID");
  return readFile(path);
}

async function writePrivateFile(path, bytes, mode) {
  await writeFile(path, bytes, { flag: "wx", mode });
  await chmod(path, mode);
}

async function ensureChildEvidenceDirectory(sourceRoot, runId) {
  for (const path of [
    join(sourceRoot, "evidence"),
    join(sourceRoot, "evidence/launch"),
  ]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      fail("G15_CHILD_EVIDENCE_PARENT_INVALID");
  }
  const launchDir = join(sourceRoot, "evidence/launch");
  const info = await lstat(launchDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(launchDir)) !== launchDir
  )
    fail("G15_CHILD_EVIDENCE_PARENT_INVALID");
  const evidenceDir = join(launchDir, runId);
  await mkdir(evidenceDir, { mode: 0o700 });
  const evidenceInfo = await lstat(evidenceDir);
  if (
    !evidenceInfo.isDirectory() ||
    evidenceInfo.isSymbolicLink() ||
    evidenceInfo.uid !== process.getuid() ||
    (evidenceInfo.mode & 0o077) !== 0 ||
    (await realpath(evidenceDir)) !== evidenceDir
  )
    fail("G15_CHILD_EVIDENCE_INVALID");
  return evidenceDir;
}

async function writeChildContext({
  evidenceDir,
  candidateRoot,
  sourceRoot,
  candidateSha,
  baseConfigSha256,
  runId,
  parentContext,
  parentContextPath,
}) {
  const gateArtifacts = join(evidenceDir, "gates/G15_BROWSER/artifacts");
  await mkdir(gateArtifacts, { recursive: true, mode: 0o700 });
  const context = {
    schemaVersion: 1,
    candidateSha,
    baseConfigSha256,
    runId,
    checkoutDir: candidateRoot,
    sourceRepoRoot: sourceRoot,
    acceptedBaseCommit: parentContext.acceptedBaseCommit,
    startedAtUtc: new Date().toISOString(),
    evidenceDir,
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      g08PreparationContextPath: parentContextPath,
      g15ParentCandidateSha: parentContext.candidateSha,
      g15ParentCheckoutRoot: parentContext.checkoutDir,
      g15ParentRunId: parentContext.runId,
      kafkaPrefix: runId,
    },
  };
  const path = join(evidenceDir, "context.json");
  await writePrivateFile(
    path,
    Buffer.from(`${JSON.stringify(context, null, 2)}\n`),
    0o400,
  );
  return { path, context };
}

function newChildRunId(candidateSha) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${timestamp}-${candidateSha.slice(0, 7)}`;
}

function lastJsonLine(stdout) {
  const line = stdout
    .split(/\r?\n/u)
    .filter((value) => value.trim())
    .at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch {
    fail("G15_CHILD_RECEIPT_INVALID");
  }
}

function failureSourceLocationIsValid(value) {
  return (
    exactKeys(value, ["source", "line", "column"]) &&
    value.source === "tools/compose-smoke.mjs" &&
    Number.isSafeInteger(value.line) &&
    value.line > 0 &&
    value.line <= 1_000_000 &&
    Number.isSafeInteger(value.column) &&
    value.column > 0 &&
    value.column <= 1_000_000
  );
}

function browserOperationDiagnosticIsValid(value) {
  if (
    !exactKeys(value, [
      "operation",
      "failureClass",
      "exitCode",
      "signal",
      "timedOut",
      "containerSnapshot",
    ]) ||
    value.operation !== "runtime-stack-up" ||
    !BROWSER_OPERATION_FAILURE_CLASSES.has(value.failureClass) ||
    (value.exitCode !== null &&
      (!Number.isSafeInteger(value.exitCode) ||
        value.exitCode < 0 ||
        value.exitCode > 255)) ||
    (value.signal !== null && !BROWSER_FAILURE_SIGNALS.has(value.signal)) ||
    typeof value.timedOut !== "boolean" ||
    !exactKeys(value.containerSnapshot, ["status", "containers"]) ||
    !BROWSER_CONTAINER_SNAPSHOT_STATUSES.has(value.containerSnapshot.status) ||
    !Array.isArray(value.containerSnapshot.containers) ||
    value.containerSnapshot.containers.length > BROWSER_CONTAINER_LIMIT
  )
    return false;
  return value.containerSnapshot.containers.every(
    (container) =>
      exactKeys(container, [
        "service",
        "state",
        "health",
        "exitCode",
        "oomKilled",
      ]) &&
      BROWSER_CONTAINER_SERVICES.has(container.service) &&
      BROWSER_CONTAINER_STATES.has(container.state) &&
      (container.health === null ||
        BROWSER_CONTAINER_HEALTH.has(container.health)) &&
      (container.exitCode === null ||
        (Number.isSafeInteger(container.exitCode) &&
          container.exitCode >= 0 &&
          container.exitCode <= 255)) &&
      typeof container.oomKilled === "boolean",
  );
}

export function validateBrowserChildFailureDiagnostic(
  diagnostic,
  { runId, candidateSha },
) {
  const expectedKeys = [
    "schemaVersion",
    "gateId",
    "outcome",
    "runId",
    "candidateSha",
    "errorName",
    "messageSha256",
  ];
  if (Object.hasOwn(diagnostic ?? {}, "sourceLocation"))
    expectedKeys.push("sourceLocation");
  if (Object.hasOwn(diagnostic ?? {}, "operationDiagnostic"))
    expectedKeys.push("operationDiagnostic");
  if (
    !exactKeys(diagnostic, expectedKeys) ||
    diagnostic.schemaVersion !== 1 ||
    diagnostic.gateId !== "G15_BROWSER" ||
    diagnostic.outcome !== "FAIL" ||
    diagnostic.runId !== runId ||
    diagnostic.candidateSha !== candidateSha ||
    !BROWSER_FAILURE_ERROR_NAMES.has(diagnostic.errorName) ||
    !/^[0-9a-f]{64}$/u.test(diagnostic.messageSha256 ?? "") ||
    (Object.hasOwn(diagnostic ?? {}, "sourceLocation") &&
      !failureSourceLocationIsValid(diagnostic.sourceLocation)) ||
    (Object.hasOwn(diagnostic ?? {}, "operationDiagnostic") &&
      !browserOperationDiagnosticIsValid(diagnostic.operationDiagnostic))
  )
    fail("G15_CHILD_FAILURE_DIAGNOSTIC_INVALID");
  return true;
}

export async function persistBrowserFailureFromChild({
  error,
  parentContext,
  childContext,
  evidenceDir,
}) {
  const processResult = error?.result;
  if (
    processResult?.joined !== true ||
    (processResult.signal !== null &&
      !BROWSER_FAILURE_SIGNALS.has(processResult.signal)) ||
    (processResult.signal === null &&
      (!Number.isSafeInteger(processResult.code) ||
        processResult.code <= 0 ||
        processResult.code > 255))
  )
    return undefined;
  let diagnostic;
  try {
    diagnostic = lastJsonLine(processResult.stdout ?? "");
    validateBrowserChildFailureDiagnostic(diagnostic, {
      runId: childContext.runId,
      candidateSha: childContext.candidateSha,
    });
  } catch {
    return undefined;
  }
  const receipt = {
    schemaVersion: 1,
    gateId: "G15_BROWSER",
    outcome: "FAIL",
    parentRunId: parentContext.runId,
    parentCandidateSha: parentContext.candidateSha,
    childRunId: childContext.runId,
    childCandidateSha: childContext.candidateSha,
    errorName: diagnostic.errorName,
    messageSha256: diagnostic.messageSha256,
    ...(diagnostic.sourceLocation === undefined
      ? {}
      : { sourceLocation: diagnostic.sourceLocation }),
    ...(diagnostic.operationDiagnostic === undefined
      ? {}
      : { operationDiagnostic: diagnostic.operationDiagnostic }),
  };
  const artifactsDir = join(evidenceDir, "gates/G15_BROWSER/artifacts");
  for (const directory of [
    evidenceDir,
    join(evidenceDir, "gates"),
    join(evidenceDir, "gates/G15_BROWSER"),
    artifactsDir,
  ]) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory
    )
      fail("G15_ARTIFACT_DIRECTORY_INVALID");
  }
  const path = join(artifactsDir, ARTIFACTS.parentFailure);
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await writePrivateFile(path, bytes, 0o600);
  return { path, sha256: sha256(bytes) };
}

export function validateBrowserFailureReceipt(
  receipt,
  { parentContext, childContext },
) {
  const expectedKeys = [
    "schemaVersion",
    "gateId",
    "outcome",
    "parentRunId",
    "parentCandidateSha",
    "childRunId",
    "childCandidateSha",
    "errorName",
    "messageSha256",
  ];
  if (Object.hasOwn(receipt ?? {}, "sourceLocation"))
    expectedKeys.push("sourceLocation");
  if (Object.hasOwn(receipt ?? {}, "operationDiagnostic"))
    expectedKeys.push("operationDiagnostic");
  if (
    !exactKeys(receipt, expectedKeys) ||
    receipt.schemaVersion !== 1 ||
    receipt.gateId !== "G15_BROWSER" ||
    receipt.outcome !== "FAIL" ||
    receipt.parentRunId !== parentContext.runId ||
    receipt.parentCandidateSha !== parentContext.candidateSha ||
    receipt.childRunId !== childContext.runId ||
    receipt.childCandidateSha !== childContext.candidateSha ||
    !BROWSER_FAILURE_ERROR_NAMES.has(receipt.errorName) ||
    !SHA256.test(receipt.messageSha256 ?? "") ||
    (Object.hasOwn(receipt, "sourceLocation") &&
      !failureSourceLocationIsValid(receipt.sourceLocation)) ||
    (Object.hasOwn(receipt, "operationDiagnostic") &&
      !browserOperationDiagnosticIsValid(receipt.operationDiagnostic))
  )
    fail("G15_BROWSER_FAILURE_RECEIPT_INVALID");
  return true;
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
    fail("G15_CHILD_CONTEXT_INVALID");
}

export function validateBrowserChildProcess(
  processResult,
  childContext,
  childRuntime,
  stdoutReceipt,
) {
  const callbackProof = {
    schemaVersion: 1,
    runId: childContext.runId,
    candidateSha: childContext.candidateSha,
    status: "passed",
    verificationOnly: true,
    productionLogin: false,
  };
  if (
    !processResult ||
    !exactKeys(processResult, [
      "exitCode",
      "signal",
      "timedOut",
      "outputLimitExceeded",
      "joined",
    ]) ||
    processResult.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut !== false ||
    processResult.outputLimitExceeded !== false ||
    processResult.joined !== true ||
    !isDeepStrictEqual(stdoutReceipt?.browserProof, callbackProof) ||
    !isDeepStrictEqual(stdoutReceipt?.cleanup, childRuntime.cleanup) ||
    childRuntime.status !== "PASS" ||
    !isDeepStrictEqual(childRuntime.callbackProof, callbackProof)
  )
    fail("G15_CHILD_PROCESS_NOT_ADMITTED");
  return callbackProof;
}

export async function verifyBrowserChildBundle({
  bundlePath,
  baseCandidateSha,
  childContext,
  lineageReceipt,
  baseConfigBytes,
  childConfigBytes,
}) {
  const tempRoot = await mkdtemp(join(tmpdir(), "coffee-g15-admission-"));
  const objectStore = join(tempRoot, "objects.git");
  const checkoutRoot = join(tempRoot, "checkout");
  try {
    gitAdmission(
      ["init", "--bare", objectStore],
      "G15_BUNDLE_STORE_INIT_FAILED",
      { stdio: "ignore", timeout: 30_000 },
    );
    gitAdmission(
      [
        "--git-dir",
        objectStore,
        "fetch",
        "--no-tags",
        childContext.sourceRepoRoot,
        `${baseCandidateSha}:refs/heads/g15-base`,
      ],
      "G15_BUNDLE_BASE_MISSING",
      { stdio: "ignore", timeout: 60_000 },
    );
    gitAdmission(
      ["-C", objectStore, "bundle", "verify", bundlePath],
      "G15_BUNDLE_VERIFY_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    gitAdmission(
      [
        "-C",
        objectStore,
        "fetch",
        "--no-tags",
        bundlePath,
        `${CHILD_REF}:${CHILD_REF}`,
      ],
      "G15_BUNDLE_FETCH_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    const heads = gitAdmission(
      ["bundle", "list-heads", bundlePath],
      "G15_BUNDLE_HEADS_FAILED",
      { cwd: objectStore, encoding: "utf8", timeout: 30_000 },
    )
      .trim()
      .split(/\s+/u);
    if (!isDeepStrictEqual(heads, [childContext.candidateSha, CHILD_REF]))
      fail("G15_BUNDLE_REF_INVALID");
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
      "G15_BUNDLE_CHECKOUT_FAILED",
      { stdio: "ignore", timeout: 60_000 },
    );
    const checked = await validateBrowserFixtureGitLineage({
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
      fail("G15_BUNDLE_LINEAGE_MISMATCH");
    return checked.receipt;
  } catch (error) {
    if (error?.code?.startsWith("G15_")) throw error;
    fail("G15_BUNDLE_ADMISSION_FAILED");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function prepareBrowserChildCheckout(childRoot) {
  const canonicalRoot = resolve(childRoot);
  const rootInfo = await lstat(canonicalRoot).catch(() => null);
  if (
    !rootInfo?.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== process.getuid() ||
    (await realpath(canonicalRoot)) !== canonicalRoot
  )
    fail("G15_CHILD_CHECKOUT_INVALID");
  for (const [relativePath, mode] of [
    ["config/platform.yaml", 0o644],
    ["secrets/platform.secrets.sops.yaml", 0o400],
  ]) {
    const path = join(canonicalRoot, relativePath);
    const info = await lstat(path).catch(() => null);
    if (
      !info?.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      (await realpath(path)) !== path
    )
      fail("G15_CHILD_FILE_INVALID");
    await chmod(path, mode);
    const securedInfo = await lstat(path).catch(() => null);
    if (
      !securedInfo?.isFile() ||
      securedInfo.isSymbolicLink() ||
      securedInfo.uid !== process.getuid() ||
      securedInfo.dev !== info.dev ||
      securedInfo.ino !== info.ino ||
      securedInfo.nlink !== 1 ||
      (securedInfo.mode & 0o777) !== mode ||
      securedInfo.size !== info.size
    )
      fail("G15_CHILD_FILE_INVALID");
  }
  const commands = [
    {
      command: "pnpm",
      args: ["install", "--offline", "--frozen-lockfile"],
      stage: "G15_CHILD_INSTALL_FAILED",
      timeout: 300_000,
    },
    {
      command: "pnpm",
      args: ["exec", "tsc", "-b", "--pretty", "false"],
      stage: "G15_CHILD_TYPECHECK_FAILED",
      timeout: 600_000,
    },
    {
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        "await import('./tools/compose-smoke.mjs')",
      ],
      stage: "G15_CHILD_ENTRYPOINT_IMPORT_FAILED",
      timeout: 30_000,
    },
  ];
  for (const { command, args, stage, timeout } of commands) {
    try {
      execFileSync(command, args, {
        cwd: childRoot,
        stdio: "ignore",
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      fail(stage);
    }
  }
}

export async function validateBrowserParentRuntime({
  evidenceDir,
  parentContext,
  stdoutReceipt,
}) {
  if (!SHA256.test(parentContext?.baseConfigSha256 ?? ""))
    fail("G15_PARENT_CONFIG_HASH_INVALID");
  const artifactsDir = join(evidenceDir, "gates/G15_BROWSER/artifacts");
  const parentBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.parentRuntime),
    0o600,
    64 * 1024,
  );
  const parent = JSON.parse(parentBytes.toString("utf8"));
  if (
    !exactKeys(parent, PARENT_KEYS) ||
    parent.schemaVersion !== 1 ||
    parent.gateId !== "G15_BROWSER" ||
    parent.status !== "PASS" ||
    parent.verificationOnly !== true ||
    parent.productionLogin !== false ||
    parent.runId !== parentContext.runId ||
    parent.candidateSha !== parentContext.candidateSha ||
    !SHA256.test(parent.baseConfigSha256 ?? "") ||
    parent.baseConfigSha256 !== parentContext.baseConfigSha256
  )
    fail("G15_PARENT_RECEIPT_INVALID");
  const child = parent.child;
  if (
    !exactKeys(child, [
      "runId",
      "candidateSha",
      "baseCandidateSha",
      "baseConfigSha256",
      "process",
      "checkoutPath",
      "checkoutRemoved",
      "evidenceRemoved",
      "childContextSha256",
      "lineageSha256",
      "browserRuntimeSha256",
      "bundleSha256",
      "baseConfigSha256Artifact",
      "childConfigSha256Artifact",
    ]) ||
    child.baseCandidateSha !== parent.candidateSha ||
    !SHA.test(child.candidateSha ?? "") ||
    !SHA256.test(child.baseConfigSha256 ?? "") ||
    child.checkoutRemoved !== true ||
    child.evidenceRemoved !== true
  )
    fail("G15_CHILD_RECEIPT_INVALID");
  const childContextBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.childContext),
    0o400,
    16 * 1024,
  );
  const childContext = JSON.parse(childContextBytes.toString("utf8"));
  const parentCheckoutRoot = resolve(parentContext.checkoutDir);
  validateBrowserChildContext(childContext, parentContext, parentCheckoutRoot);
  if (
    child.runId !== childContext.runId ||
    child.candidateSha !== childContext.candidateSha ||
    child.baseConfigSha256 !== childContext.baseConfigSha256 ||
    child.checkoutPath !== childContext.checkoutDir ||
    child.childContextSha256 !== sha256(childContextBytes)
  )
    fail("G15_CHILD_CONTEXT_MISMATCH");
  for (const path of [childContext.checkoutDir, childContext.evidenceDir]) {
    try {
      await lstat(path);
      fail("G15_CHILD_TEMPORARY_RETAINED");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const lineageBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.lineage),
    0o400,
    16 * 1024,
  );
  const lineage = JSON.parse(lineageBytes.toString("utf8"));
  const browserBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.browserRuntime),
    0o600,
    2 * 1024 * 1024,
  );
  const childRuntime = JSON.parse(browserBytes.toString("utf8"));
  const bundlePath = join(artifactsDir, ARTIFACTS.bundle);
  const bundleBytes = await assertPrivateFile(
    bundlePath,
    0o400,
    MAX_BUNDLE_BYTES,
  );
  const baseConfigBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.baseConfig),
    0o400,
    1024 * 1024,
  );
  const childConfigBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.childConfig),
    0o400,
    1024 * 1024,
  );
  if (
    child.lineageSha256 !== sha256(lineageBytes) ||
    child.browserRuntimeSha256 !== sha256(browserBytes) ||
    child.bundleSha256 !== sha256(bundleBytes) ||
    child.baseConfigSha256Artifact !== sha256(baseConfigBytes) ||
    child.childConfigSha256Artifact !== sha256(childConfigBytes)
  )
    fail("G15_CHILD_ARTIFACT_HASH_MISMATCH");
  validateBrowserRuntimeArtifact(childRuntime, {
    runId: childContext.runId,
    candidateSha: childContext.candidateSha,
    baseConfigSha256: childContext.baseConfigSha256,
    lineage,
  });
  const callbackProof = validateBrowserChildProcess(
    child.process,
    childContext,
    childRuntime,
    stdoutReceipt,
  );
  if (
    !isDeepStrictEqual(parent.callbackProof, callbackProof) ||
    !isDeepStrictEqual(parent.cleanup, childRuntime.cleanup) ||
    !isDeepStrictEqual(stdoutReceipt?.parentReceipt, {
      schemaVersion: 1,
      runId: parent.runId,
      candidateSha: parent.candidateSha,
      childRunId: child.runId,
      childCandidateSha: child.candidateSha,
      bundleSha256: child.bundleSha256,
      checkoutRemoved: true,
      evidenceRemoved: true,
    })
  )
    fail("G15_PARENT_OUTPUT_MISMATCH");
  const verifiedLineage = await verifyBrowserChildBundle({
    bundlePath,
    baseCandidateSha: parent.candidateSha,
    childContext,
    lineageReceipt: lineage,
    baseConfigBytes,
    childConfigBytes,
  });
  return {
    parent,
    childContext,
    lineage: verifiedLineage,
    childRuntime,
    bundleSha256: child.bundleSha256,
  };
}

export async function validateBrowserCorrelation({
  evidenceDir,
  parentContext,
}) {
  const directory = join(evidenceDir, "gates/G14_OBSERVABILITY/artifacts");
  const bytes = {};
  for (const [key, mode, limit] of [
    ["receipt", 0o600, 64 * 1024],
    ["childContext", 0o400, 16 * 1024],
    ["lineage", 0o400, 16 * 1024],
    ["bundle", 0o400, MAX_BUNDLE_BYTES],
    ["baseConfig", 0o400, 1024 * 1024],
    ["childConfig", 0o400, 1024 * 1024],
  ])
    bytes[key] = await assertPrivateFile(
      join(directory, CORRELATION_ARTIFACTS[key]),
      mode,
      limit,
    );
  const receipt = JSON.parse(bytes.receipt);
  const childContext = JSON.parse(bytes.childContext);
  const lineage = JSON.parse(bytes.lineage);
  validateBrowserChildContext(
    childContext,
    parentContext,
    resolve(parentContext.checkoutDir),
  );
  const expectedNames = [
    "customer",
    "catalog",
    "pricing",
    "orders",
    "integration",
  ]
    .map(
      (owner) =>
        `coffee_verify_${childContext.runId.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  if (
    receipt.schemaVersion !== 1 ||
    receipt.status !== "PASS" ||
    receipt.runId !== parentContext.runId ||
    receipt.candidateSha !== parentContext.candidateSha ||
    receipt.baseConfigSha256 !== parentContext.baseConfigSha256 ||
    receipt.childRunId !== childContext.runId ||
    receipt.childCandidateSha !== childContext.candidateSha ||
    receipt.childContextSha256 !== sha256(bytes.childContext) ||
    receipt.lineageSha256 !== sha256(bytes.lineage) ||
    receipt.bundleSha256 !== sha256(bytes.bundle) ||
    receipt.baseConfigArtifactSha256 !== sha256(bytes.baseConfig) ||
    receipt.childConfigArtifactSha256 !== sha256(bytes.childConfig) ||
    receipt.baseConfigArtifactSha256 !== parentContext.baseConfigSha256 ||
    receipt.childConfigArtifactSha256 !== childContext.baseConfigSha256 ||
    receipt.checkoutRemoved !== true ||
    receipt.evidenceRemoved !== true ||
    receipt.proof?.verified !== true ||
    !/^[0-9a-f-]{36}$/u.test(receipt.proof.correlationId ?? "") ||
    !/^[0-9a-f]{32}$/u.test(receipt.proof.traceId ?? "") ||
    receipt.proof.browserRefetchMatched !== true ||
    receipt.proof.sseFrameMatched !== true ||
    receipt.proof.ownerCausation !== true ||
    receipt.cleanup?.verified !== true ||
    receipt.cleanup.databases?.verified !== true ||
    !isDeepStrictEqual(receipt.cleanup.databases.removed, expectedNames) ||
    !isDeepStrictEqual(receipt.cleanup.databases.retained, []) ||
    !(
      (receipt.cleanup.attachment?.baselineAttached === false &&
        receipt.cleanup.attachment.attempted === true &&
        receipt.cleanup.attachment.removed === true) ||
      (receipt.cleanup.attachment?.baselineAttached === true &&
        receipt.cleanup.attachment.attempted === false &&
        receipt.cleanup.attachment.removed === false)
    ) ||
    receipt.cleanup.attachment.routePreserved !== true ||
    dirname(childContext.checkoutDir) !== resolve(parentContext.checkoutDir) ||
    !childContext.checkoutDir.startsWith(
      join(resolve(parentContext.checkoutDir), ".g15-browser-child-"),
    )
  )
    fail("G14_BROWSER_CORRELATION_RECEIPT_INVALID");
  for (const path of [childContext.checkoutDir, childContext.evidenceDir]) {
    try {
      await lstat(path);
      fail("G14_BROWSER_CHILD_RETAINED");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await verifyBrowserChildBundle({
    bundlePath: join(directory, CORRELATION_ARTIFACTS.bundle),
    baseCandidateSha: parentContext.candidateSha,
    childContext,
    lineageReceipt: lineage,
    baseConfigBytes: bytes.baseConfig,
    childConfigBytes: bytes.childConfig,
  });
  return {
    receipt,
    files: Object.values(CORRELATION_ARTIFACTS).map((name) =>
      join(directory, name),
    ),
  };
}

export async function runBrowserParent({ runCorrelation } = {}) {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextPath) fail("G15_LAUNCH_CONTEXT_REQUIRED");
  const launch = await validateLaunchContext(contextPath);
  const { context: parentContext, candidateRoot, evidenceDir } = launch;
  if (
    resolve(process.cwd()) !== candidateRoot ||
    candidateRoot !== PROJECT_ROOT
  )
    fail("G15_PARENT_CANDIDATE_INVALID");
  const parentCheckout = await inspectLaunchCheckout(
    candidateRoot,
    parentContext.candidateSha,
  );
  if (
    !SHA.test(parentContext.acceptedBaseCommit ?? "") ||
    !SHA256.test(parentContext.baseConfigSha256 ?? "") ||
    parentContext.candidateSha !== parentCheckout.commitSha
  )
    fail("G15_PARENT_CONTEXT_INVALID");
  const baseConfigBytes = gitBytes(
    candidateRoot,
    "cat-file",
    "blob",
    `${parentContext.candidateSha}:config/platform.yaml`,
  );
  if (sha256(baseConfigBytes) !== parentContext.baseConfigSha256)
    fail("G15_PARENT_CONFIG_INVALID");
  const baseConfigText = baseConfigBytes.toString("utf8");
  if (!Buffer.from(baseConfigText, "utf8").equals(baseConfigBytes))
    fail("G15_PARENT_CONFIG_INVALID");
  const baseConfig = await loadPlatformConfig(
    candidateRoot,
    join(candidateRoot, "config/platform.yaml"),
  );
  if (baseConfig.browserOidc !== null) fail("G15_PARENT_PROFILE_MUST_BE_NULL");
  const variantBytes = Buffer.from(fixtureConfigText(baseConfigText), "utf8");
  const variantHash = sha256(variantBytes);
  const childRoot = await mkdtemp(join(candidateRoot, ".g15-browser-child-"));
  let childEvidenceDir;
  let childContext;
  let childSha;
  let childRunId;
  let childProcessResult;
  let successfulChild = false;
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        candidateRoot,
        childRoot,
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
    git(
      childRoot,
      "remote",
      "set-url",
      "origin",
      "https://github.com/YurGusev/CoffeeOrderPlatform",
    );
    if (git(childRoot, "rev-parse", "HEAD") !== parentContext.candidateSha)
      fail("G15_CHILD_BASE_MISMATCH");
    await writeFile(join(childRoot, "config/platform.yaml"), variantBytes, {
      mode: 0o644,
    });
    git(childRoot, "add", "--", "config/platform.yaml");
    execFileSync(
      "git",
      [
        "-C",
        childRoot,
        "-c",
        "user.name=Coffee G15 verifier",
        "-c",
        "user.email=coffee-g15-verifier@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Изолированный G15 browser profile",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    childSha = git(childRoot, "rev-parse", "HEAD");
    const childInfo = await inspectLaunchCheckout(childRoot, childSha);
    if (
      childInfo.parents.length !== 1 ||
      childInfo.parents[0] !== parentContext.candidateSha
    )
      fail("G15_CHILD_PARENT_INVALID");
    await prepareBrowserChildCheckout(childRoot);
    await inspectLaunchCheckout(childRoot, childSha);
    childRunId = newChildRunId(childSha);
    childEvidenceDir = await ensureChildEvidenceDirectory(
      candidateRoot,
      childRunId,
    );
    const contextRecord = await writeChildContext({
      evidenceDir: childEvidenceDir,
      candidateRoot: childRoot,
      sourceRoot: candidateRoot,
      candidateSha: childSha,
      baseConfigSha256: variantHash,
      runId: childRunId,
      parentContext,
      parentContextPath: contextPath,
    });
    childContext = contextRecord.context;
    await validateLaunchContext(contextRecord.path);
    const lineage = await validateBrowserFixtureLineage({
      root: candidateRoot,
      contextPath: contextRecord.path,
      baseCandidateSha: parentContext.candidateSha,
    });
    const artifactsDir = join(
      evidenceDir,
      runCorrelation
        ? "gates/G14_OBSERVABILITY/artifacts"
        : "gates/G15_BROWSER/artifacts",
    );
    const artifacts = runCorrelation ? CORRELATION_ARTIFACTS : ARTIFACTS;
    const lineageBytes = await readFile(lineage.receiptPath);
    await writePrivateFile(
      join(artifactsDir, artifacts.lineage),
      lineageBytes,
      0o400,
    );
    await writePrivateFile(
      join(artifactsDir, artifacts.childContext),
      await readFile(contextRecord.path),
      0o400,
    );
    await writePrivateFile(
      join(artifactsDir, artifacts.baseConfig),
      baseConfigBytes,
      0o400,
    );
    await writePrivateFile(
      join(artifactsDir, artifacts.childConfig),
      variantBytes,
      0o400,
    );

    if (runCorrelation) {
      const result = await runCorrelation(contextRecord.path);
      if (
        result?.cleanupVerified !== true ||
        result?.launchPath?.verified !== true ||
        result?.cleanup?.verified !== true
      )
        fail("G14_BROWSER_CORRELATION_CLEANUP_INVALID");
      git(childRoot, "update-ref", CHILD_REF, childContext.candidateSha);
      const bundlePath = join(artifactsDir, artifacts.bundle);
      execFileSync(
        "git",
        [
          "-C",
          childRoot,
          "bundle",
          "create",
          bundlePath,
          CHILD_REF,
          `^${parentContext.candidateSha}`,
        ],
        { stdio: "ignore", timeout: 120_000 },
      );
      await chmod(bundlePath, 0o400);
      if ((await stat(bundlePath)).size > MAX_BUNDLE_BYTES)
        fail("G15_BUNDLE_SIZE_LIMIT");
      const contextBytes = await readFile(contextRecord.path);
      const bundleBytes = await readFile(bundlePath);
      const childReceipt = {
        schemaVersion: 1,
        status: "PASS",
        runId: parentContext.runId,
        candidateSha: parentContext.candidateSha,
        baseConfigSha256: parentContext.baseConfigSha256,
        childRunId,
        childCandidateSha: childSha,
        childContextSha256: sha256(contextBytes),
        lineageSha256: sha256(lineageBytes),
        bundleSha256: sha256(bundleBytes),
        baseConfigArtifactSha256: sha256(baseConfigBytes),
        childConfigArtifactSha256: sha256(variantBytes),
        checkoutRemoved: true,
        evidenceRemoved: true,
        cleanup: result.cleanup,
        proof: {
          verified: result.launchPath.verified,
          correlationId: result.launchPath.correlationId,
          traceId: result.launchPath.traceId,
          browserRefetchMatched: result.launchPath.refetchReceipt?.matched,
          sseFrameMatched: result.launchPath.sseFrameMatched,
          ownerCausation: result.launchPath.projectionReceipt?.causationMatched,
        },
      };
      await rm(childRoot, { recursive: true, force: false });
      await rm(childEvidenceDir, { recursive: true, force: false });
      successfulChild = true;
      await verifyBrowserChildBundle({
        bundlePath,
        baseCandidateSha: parentContext.candidateSha,
        childContext,
        lineageReceipt: JSON.parse(lineageBytes),
        baseConfigBytes,
        childConfigBytes: variantBytes,
      });
      await writePrivateFile(
        join(artifactsDir, artifacts.receipt),
        Buffer.from(`${JSON.stringify(childReceipt, null, 2)}\n`),
        0o600,
      );
      return { result, browserChild: childReceipt };
    }

    childProcessResult = await runManagedRollbackChild({
      args: [join(childRoot, "tools/compose-smoke.mjs"), "--browser-proof"],
      cwd: childRoot,
      env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: contextRecord.path },
      timeoutMs: 1_800_000,
      terminationGraceMs: 120_000,
    });
    if (childProcessResult.code !== 0 || childProcessResult.joined !== true)
      fail("G15_CHILD_PROCESS_FAILED");
    const stdoutReceipt = lastJsonLine(childProcessResult.stdout);
    const childRuntimePath = join(
      childEvidenceDir,
      "gates/G15_BROWSER/artifacts/browser-runtime.json",
    );
    const childRuntimeInfo = await lstat(childRuntimePath);
    if (
      !childRuntimeInfo.isFile() ||
      childRuntimeInfo.isSymbolicLink() ||
      childRuntimeInfo.uid !== process.getuid() ||
      (childRuntimeInfo.mode & 0o777) !== 0o600
    )
      fail("G15_CHILD_RUNTIME_ARTIFACT_INVALID");
    const childRuntimeBytes = await readFile(childRuntimePath);
    const childRuntime = JSON.parse(childRuntimeBytes.toString("utf8"));
    validateBrowserRuntimeArtifact(childRuntime, {
      runId: childContext.runId,
      candidateSha: childContext.candidateSha,
      baseConfigSha256: childContext.baseConfigSha256,
      lineage: lineage,
    });
    const callbackProof = validateBrowserChildProcess(
      {
        exitCode: childProcessResult.code,
        signal: childProcessResult.signal,
        timedOut: false,
        outputLimitExceeded: false,
        joined: childProcessResult.joined,
      },
      childContext,
      childRuntime,
      stdoutReceipt,
    );

    git(childRoot, "update-ref", CHILD_REF, childContext.candidateSha);
    const artifactsDirParent = join(evidenceDir, "gates/G15_BROWSER/artifacts");
    const bundlePath = join(artifactsDirParent, ARTIFACTS.bundle);
    execFileSync(
      "git",
      [
        "-C",
        childRoot,
        "bundle",
        "create",
        bundlePath,
        CHILD_REF,
        `^${parentContext.candidateSha}`,
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
    await chmod(bundlePath, 0o400);
    const bundleStat = await stat(bundlePath);
    if (bundleStat.size > MAX_BUNDLE_BYTES) fail("G15_BUNDLE_SIZE_LIMIT");
    await writePrivateFile(
      join(artifactsDirParent, ARTIFACTS.browserRuntime),
      childRuntimeBytes,
      0o600,
    );

    const childContextBytes = await readFile(contextRecord.path);
    const processReceipt = {
      exitCode: childProcessResult.code,
      signal: childProcessResult.signal,
      timedOut: false,
      outputLimitExceeded: false,
      joined: childProcessResult.joined,
    };
    const childReceipt = {
      runId: childContext.runId,
      candidateSha: childContext.candidateSha,
      baseCandidateSha: parentContext.candidateSha,
      baseConfigSha256: childContext.baseConfigSha256,
      process: processReceipt,
      checkoutPath: childContext.checkoutDir,
      checkoutRemoved: true,
      evidenceRemoved: true,
      childContextSha256: sha256(childContextBytes),
      lineageSha256: sha256(lineageBytes),
      browserRuntimeSha256: sha256(childRuntimeBytes),
      bundleSha256: sha256(await readFile(bundlePath)),
      baseConfigSha256Artifact: sha256(baseConfigBytes),
      childConfigSha256Artifact: sha256(variantBytes),
    };
    const parentArtifact = {
      schemaVersion: 1,
      gateId: "G15_BROWSER",
      runId: parentContext.runId,
      candidateSha: parentContext.candidateSha,
      baseConfigSha256: parentContext.baseConfigSha256,
      status: "PASS",
      verificationOnly: true,
      productionLogin: false,
      child: childReceipt,
      callbackProof,
      cleanup: childRuntime.cleanup,
    };
    await rm(childRoot, { recursive: true, force: false });
    await rm(childEvidenceDir, { recursive: true, force: false });
    successfulChild = true;
    await writePrivateFile(
      join(artifactsDirParent, ARTIFACTS.parentRuntime),
      Buffer.from(`${JSON.stringify(parentArtifact, null, 2)}\n`),
      0o600,
    );
    const runnerReceipt = {
      browserProof: callbackProof,
      cleanup: childRuntime.cleanup,
      parentReceipt: {
        schemaVersion: 1,
        runId: parentContext.runId,
        candidateSha: parentContext.candidateSha,
        childRunId,
        childCandidateSha: childSha,
        bundleSha256: childReceipt.bundleSha256,
        checkoutRemoved: true,
        evidenceRemoved: true,
      },
    };
    const admitted = await validateBrowserParentRuntime({
      evidenceDir,
      parentContext,
      stdoutReceipt: runnerReceipt,
    });
    return { ...runnerReceipt, parent: admitted.parent };
  } catch (error) {
    if (successfulChild) throw error;
    // Retain an uncertain child checkout and its evidence as a failure witness.
    if (!runCorrelation && childContext && childRunId && childSha) {
      try {
        await persistBrowserFailureFromChild({
          error,
          parentContext,
          childContext,
          evidenceDir,
        });
      } catch {
        // The original child failure remains authoritative if its receipt cannot be written.
      }
    }
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const receipt = await runBrowserParent();
    console.log(JSON.stringify(receipt));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "G15_PARENT_FAILED");
    process.exitCode = 1;
  }
}
