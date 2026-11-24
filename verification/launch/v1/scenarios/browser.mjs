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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { loadPlatformConfig } from "../../../../scripts/config-lib.mjs";
import {
  fixtureConfigText,
  validateBrowserFixtureGitLineage,
  validateBrowserFixtureLineage,
} from "../../../../tools/config-bootstrap/browser-fixture.mjs";
import {
  validateBrowserRuntimeArtifact,
  validateObservabilityBrowserEvidence,
} from "../../../../tools/browser-proof.mjs";
import { validateLaunchContext } from "../../../../scripts/launch-support/launch-context.mjs";
import {
  validateBrowserChildContext,
  verifyBrowserChildBundle as verifyBrowserChildBundleAdmission,
  BROWSER_CHILD_DIRECTORY_NAME,
  inspectLaunchCheckout,
  runManagedRollbackChild,
  validateRollbackBaseline,
} from "../../../../scripts/launch-support/rollback-context.mjs";

export function verifyBrowserChildBundle(options) {
  return verifyBrowserChildBundleAdmission({
    ...options,
    validateLineage: validateBrowserFixtureGitLineage,
  });
}

const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const CHILD_REF = "refs/heads/browser-child";
export const BROWSER_CHILD_DIRECTORY_PREFIX = ".browser-child-";
const ARTIFACTS = Object.freeze({
  childContext: "child-context.json",
  lineage: "oidc-fixture-lineage.json",
  browserRuntime: "child-browser-runtime.json",
  bundle: "browser-child.bundle",
  baseConfig: "base-platform.yaml",
  childConfig: "child-platform.yaml",
  parentRuntime: "browser-parent.json",
  parentFailure: "browser-parent-failure.json",
});
export { ARTIFACTS as BROWSER_CHILD_ARTIFACTS, CHILD_REF as BROWSER_CHILD_REF };
const CORRELATION_ARTIFACTS = Object.freeze({
  childContext: "browser-context.json",
  lineage: "browser-lineage.json",
  bundle: "browser-source.bundle",
  baseConfig: "browser-base.yaml",
  childConfig: "browser-config.yaml",
  receipt: "browser-correlation.json",
});
const QUALIFICATION_ARTIFACTS = Object.freeze({
  childContext: "browser-context.json",
  lineage: "browser-lineage.json",
  bundle: "browser-source.bundle",
  baseConfig: "browser-base.yaml",
  childConfig: "browser-config.yaml",
  parentContext: "parent-context.json",
  manifest: "profile-manifest.json",
  result: "result.json",
  cleanup: "cleanup.json",
  containers: "containers.json",
  seal: "seal.json",
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
    fail("BROWSER_CHILD_GIT_FAILED");
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
    fail("BROWSER_CHILD_GIT_FAILED");
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
    fail("BROWSER_PARENT_ARTIFACT_INVALID");
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
      fail("BROWSER_CHILD_EVIDENCE_PARENT_INVALID");
  }
  const launchDir = join(sourceRoot, "evidence/launch");
  const info = await lstat(launchDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(launchDir)) !== launchDir
  )
    fail("BROWSER_CHILD_EVIDENCE_PARENT_INVALID");
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
    fail("BROWSER_CHILD_EVIDENCE_INVALID");
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
  const gateArtifacts = join(evidenceDir, "gates/browser/artifacts");
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

export async function writeControlledChildContext({
  contextPath,
  childRoot,
  childSha,
  scope,
  signer,
  parentIdentity,
  validateAromaSandboxLineage,
}) {
  // The parent already validated its launch context before starting the signer.
  // Reuse that identity so this helper does not repeat the git-based validation
  // (and, importantly, does not import the top-level-await entry module).
  if (
    parentIdentity &&
    (typeof parentIdentity.evidenceDir !== "string" ||
      resolve(contextPath) !== join(parentIdentity.evidenceDir, "context.json"))
  )
    fail("CONTROLLED_PARENT_CONTEXT_MISMATCH");
  const launch = parentIdentity ?? (await validateLaunchContext(contextPath));
  if (
    launch.candidateRoot !== PROJECT_ROOT ||
    resolve(process.cwd()) !== launch.candidateRoot
  )
    fail("CONTROLLED_PARENT_EXECUTION_MISMATCH");
  let lineage;
  if (scope === "rollback") {
    lineage = await validateRollbackBaseline({
      parentRoot: launch.candidateRoot,
      parentSha: launch.context.candidateSha,
      baselineRoot: childRoot,
      baselineSha: childSha,
    });
  } else if (scope === "aroma_sandbox") {
    // Do not import ./aroma-sandbox.mjs here: it is the TLA entry module, and
    // importing it from its own async execution deadlocks the gate.
    if (typeof validateAromaSandboxLineage !== "function")
      fail("CONTROLLED_AROMA_VALIDATOR_REQUIRED");
    lineage = await validateAromaSandboxLineage({
      sourceRoot: launch.sourceRoot,
      candidateRoot: launch.candidateRoot,
      candidateSha: launch.context.candidateSha,
      baselineRoot: childRoot,
      baselineSha: childSha,
      ...signer,
    });
  } else fail("CONTROLLED_SCOPE_INVALID");
  if (
    (scope === "rollback"
      ? lineage.parent.configSha256
      : lineage.parentConfigSha256) !== launch.context.baseConfigSha256
  )
    fail("CONTROLLED_PARENT_CONFIG_INVALID");
  const config = gitBytes(
    childRoot,
    "cat-file",
    "blob",
    `${childSha}:config/platform.yaml`,
  );
  const runId = newChildRunId(childSha);
  const evidenceDir = await ensureChildEvidenceDirectory(
    launch.sourceRoot,
    runId,
  );
  const context = {
    schemaVersion: 1,
    candidateSha: childSha,
    baseConfigSha256: sha256(config),
    runId,
    checkoutDir: childRoot,
    sourceRepoRoot: launch.sourceRoot,
    acceptedBaseCommit: launch.context.acceptedBaseCommit,
    startedAtUtc: new Date().toISOString(),
    evidenceDir,
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      kafkaPrefix: runId,
      controlledScope: scope,
      controlledParentContextPath: resolve(contextPath),
      controlledParentCandidateSha: launch.context.candidateSha,
      controlledParentRunId: launch.context.runId,
    },
  };
  const path = join(evidenceDir, "context.json");
  try {
    await writePrivateFile(
      path,
      Buffer.from(`${JSON.stringify(context, null, 2)}\n`),
      0o400,
    );
    return { path, context, lineage };
  } catch (error) {
    await rm(evidenceDir, { recursive: true, force: true });
    throw error;
  }
}

function lastJsonLine(stdout) {
  const line = stdout
    .split(/\r?\n/u)
    .filter((value) => value.trim())
    .at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch {
    fail("BROWSER_CHILD_RECEIPT_INVALID");
  }
}

function failureSourceLocationIsValid(value) {
  return (
    exactKeys(value, ["source", "line", "column"]) &&
    ["tools/compose-smoke.mjs", "tools/browser-proof.mjs"].includes(
      value.source,
    ) &&
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
    diagnostic.gateId !== "browser" ||
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
    fail("BROWSER_CHILD_FAILURE_DIAGNOSTIC_INVALID");
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
    gateId: "browser",
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
  const artifactsDir = join(evidenceDir, "gates/browser/artifacts");
  for (const directory of [
    evidenceDir,
    join(evidenceDir, "gates"),
    join(evidenceDir, "gates/browser"),
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
      fail("BROWSER_ARTIFACT_DIRECTORY_INVALID");
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
    receipt.gateId !== "browser" ||
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
    fail("BROWSER_FAILURE_RECEIPT_INVALID");
  return true;
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
    fail("BROWSER_CHILD_PROCESS_NOT_ADMITTED");
  return callbackProof;
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
    fail("BROWSER_CHILD_CHECKOUT_INVALID");
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
      fail("BROWSER_CHILD_FILE_INVALID");
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
      fail("BROWSER_CHILD_FILE_INVALID");
  }
  const commands = [
    {
      command: "pnpm",
      args: ["install", "--offline", "--frozen-lockfile"],
      stage: "BROWSER_CHILD_INSTALL_FAILED",
      timeout: 300_000,
    },
    {
      command: "pnpm",
      args: ["exec", "tsc", "-b", "--pretty", "false"],
      stage: "BROWSER_CHILD_TYPECHECK_FAILED",
      timeout: 600_000,
    },
    {
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        "await import('./tools/compose-smoke.mjs')",
      ],
      stage: "BROWSER_CHILD_ENTRYPOINT_IMPORT_FAILED",
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

export function validateOwnerBrowserProofHashes(hashes) {
  const scenarios = ["positive", "private-eof", "reauth"];
  if (
    !exactKeys(hashes, scenarios) ||
    !scenarios.every((name) => SHA256.test(hashes[name] ?? ""))
  )
    fail("BROWSER_OWNER_BROWSER_PROOF_INVALID");
  return scenarios;
}

export function validateOwnerBrowserReceipt(
  receipt,
  scenario,
  identity,
  lineageSha256,
) {
  if (
    !exactKeys(receipt, [
      "launchIdentity",
      "manifest",
      "cleanup",
      "externalCleanup",
      "proof",
      "manifestSha256",
      "cleanupSha256",
      "proofSha256",
    ]) ||
    !isDeepStrictEqual(receipt.launchIdentity, identity) ||
    ![receipt.manifest, receipt.cleanup, receipt.proof].every(
      (value) => typeof value === "string",
    ) ||
    sha256(Buffer.from(receipt.manifest)) !== receipt.manifestSha256 ||
    sha256(Buffer.from(receipt.cleanup)) !== receipt.cleanupSha256 ||
    sha256(Buffer.from(receipt.proof)) !== receipt.proofSha256
  )
    fail("BROWSER_OWNER_BROWSER_RECEIPT_INVALID");
  let manifest, cleanup, proof;
  try {
    manifest = JSON.parse(receipt.manifest);
    cleanup = JSON.parse(receipt.cleanup);
    proof = JSON.parse(receipt.proof);
  } catch {
    fail("BROWSER_OWNER_BROWSER_RECEIPT_INVALID");
  }
  const roles = [
    "kafka",
    "idp",
    "edge-gateway",
    "api-public",
    "realtime-gateway",
    "edge-nginx",
    "driver",
  ];
  const changed = Object.keys(proof.compiledIntegrity?.before ?? {}).filter(
    (path) =>
      proof.compiledIntegrity.before[path] !==
      proof.compiledIntegrity.after?.[path],
  );
  if (
    !isDeepStrictEqual(manifest.launchIdentity, identity) ||
    manifest.configSha256 !== identity.baseConfigSha256 ||
    manifest.lineageReceiptSha256 !== lineageSha256 ||
    cleanup.verified !== true ||
    cleanup.network?.created !== true ||
    cleanup.network?.removed !== true ||
    cleanup.network?.name !== `${manifest.runId}-net` ||
    cleanup.owner?.removed !== true ||
    cleanup.syntheticPrivateMaterialRemoved !== true ||
    !Array.isArray(cleanup.receipts) ||
    cleanup.receipts.length !== roles.length ||
    !roles.every(
      (role) =>
        cleanup.receipts.filter(
          (entry) =>
            entry.role === role &&
            entry.removed === true &&
            entry.logsCaptured === true,
        ).length === 1,
    ) ||
    receipt.externalCleanup?.verified !== true ||
    receipt.externalCleanup.databases?.verified !== true ||
    proof.verified !== true ||
    proof.scenario !== scenario ||
    proof.launchProof !== false ||
    proof.sourceIntegrity?.unchanged !== true ||
    !isDeepStrictEqual(proof.sourceIntegrity?.before, manifest.sources) ||
    !isDeepStrictEqual(proof.sourceIntegrity?.after, manifest.sources) ||
    !isDeepStrictEqual(proof.compiledIntegrity?.before, manifest.compiled) ||
    !isDeepStrictEqual(
      Object.keys(proof.compiledIntegrity?.after ?? {}).sort(),
      Object.keys(manifest.compiled ?? {}).sort(),
    ) ||
    (scenario === "private-eof"
      ? proof.compiledIntegrity.unchanged !== false ||
        changed.length !== 1 ||
        changed[0] !== "apps/realtime-gateway/dist/runtime-composition.js" ||
        proof.privateFraming?.triggered !== true ||
        proof.privateFraming.sourceManifestSha256 !== receipt.manifestSha256 ||
        proof.privateFraming.originalSha256 !== manifest.compiled[changed[0]] ||
        proof.privateFraming.transformedSha256 !==
          proof.compiledIntegrity.after[changed[0]]
      : proof.compiledIntegrity?.unchanged !== true ||
        changed.length !== 0 ||
        proof.privateFraming !== undefined) ||
    (scenario === "reauth" && proof.reauth?.authCloseDelta !== 1)
  )
    fail("BROWSER_OWNER_BROWSER_PROOF_INVALID");
  return receipt;
}

export async function validateBrowserParentRuntime({
  evidenceDir,
  parentContext,
  stdoutReceipt,
}) {
  if (!SHA256.test(parentContext?.baseConfigSha256 ?? ""))
    fail("BROWSER_PARENT_CONFIG_HASH_INVALID");
  const artifactsDir = join(evidenceDir, "gates/browser/artifacts");
  const parentBytes = await assertPrivateFile(
    join(artifactsDir, ARTIFACTS.parentRuntime),
    0o600,
    64 * 1024,
  );
  const parent = JSON.parse(parentBytes.toString("utf8"));
  if (
    !exactKeys(parent, PARENT_KEYS) ||
    parent.schemaVersion !== 1 ||
    parent.gateId !== "browser" ||
    parent.status !== "PASS" ||
    parent.verificationOnly !== true ||
    parent.productionLogin !== false ||
    parent.runId !== parentContext.runId ||
    parent.candidateSha !== parentContext.candidateSha ||
    !SHA256.test(parent.baseConfigSha256 ?? "") ||
    parent.baseConfigSha256 !== parentContext.baseConfigSha256
  )
    fail("BROWSER_PARENT_RECEIPT_INVALID");
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
      "ownerProofs",
    ]) ||
    child.baseCandidateSha !== parent.candidateSha ||
    !SHA.test(child.candidateSha ?? "") ||
    !SHA256.test(child.baseConfigSha256 ?? "") ||
    child.checkoutRemoved !== true ||
    child.evidenceRemoved !== true
  )
    fail("BROWSER_CHILD_RECEIPT_INVALID");
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
    fail("BROWSER_CHILD_CONTEXT_MISMATCH");
  for (const path of [childContext.checkoutDir, childContext.evidenceDir]) {
    try {
      await lstat(path);
      fail("BROWSER_CHILD_TEMPORARY_RETAINED");
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
    fail("BROWSER_CHILD_ARTIFACT_HASH_MISMATCH");
  const identity = {
    schemaVersion: childContext.schemaVersion,
    runId: childContext.runId,
    candidateSha: childContext.candidateSha,
    baseConfigSha256: childContext.baseConfigSha256,
  };
  for (const scenario of validateOwnerBrowserProofHashes(child.ownerProofs)) {
    const bytes = await assertPrivateFile(
      join(artifactsDir, `owner-${scenario}.json`),
      0o600,
      8 * 1024 * 1024,
    );
    if (child.ownerProofs[scenario] !== sha256(bytes))
      fail("BROWSER_OWNER_BROWSER_PROOF_INVALID");
    validateOwnerBrowserReceipt(
      JSON.parse(bytes),
      scenario,
      identity,
      sha256(lineageBytes),
    );
  }
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
    fail("BROWSER_PARENT_OUTPUT_MISMATCH");
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
  const directory = join(evidenceDir, "gates/observability/artifacts");
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
    receipt.status !== "NOT_PROVEN" ||
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
    !BROWSER_CHILD_DIRECTORY_NAME.test(basename(childContext.checkoutDir))
  )
    fail("OBSERVABILITY_BROWSER_CORRELATION_RECEIPT_INVALID");
  try {
    validateObservabilityBrowserEvidence(receipt.proof, {
      runId: childContext.runId,
      candidateSha: childContext.candidateSha,
      configSha256: childContext.baseConfigSha256,
    });
  } catch {
    fail("OBSERVABILITY_BROWSER_CORRELATION_RECEIPT_INVALID");
  }
  for (const path of [childContext.checkoutDir, childContext.evidenceDir]) {
    try {
      await lstat(path);
      fail("OBSERVABILITY_BROWSER_CHILD_RETAINED");
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

export function validateChildCleanup(result, childContext) {
  const names = ["customer", "catalog", "pricing", "orders", "integration"]
    .map(
      (owner) =>
        `coffee_verify_${childContext.runId.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  const external = result?.externalCleanup;
  if (
    result?.cleanup?.verified !== true ||
    result.cleanup.complete !== true ||
    result.cleanup.fixtureRootRemoved !== true ||
    result.cleanup.secretsDirRemoved !== true ||
    result.cleanup.composeOverrideRemoved !== true ||
    result.cleanup.failures?.length !== 0 ||
    result.cleanup.retainedResources?.length !== 0 ||
    !isDeepStrictEqual(result.cleanup.inventory, {
      containers: [],
      volumes: [],
      networks: [],
    }) ||
    external?.verified !== true ||
    external.databases?.verified !== true ||
    !isDeepStrictEqual(external.databases.removed, names) ||
    !isDeepStrictEqual(external.databases.retained, []) ||
    !(
      (external.attachment?.baselineAttached === false &&
        external.attachment.attempted === true &&
        external.attachment.removed === true) ||
      (external.attachment?.baselineAttached === true &&
        external.attachment.attempted === false &&
        external.attachment.removed === false)
    ) ||
    external.attachment.routePreserved !== true
  )
    fail("OBSERVABILITY_BROWSER_CORRELATION_CLEANUP_INVALID");
  return external;
}

export async function runBrowserParent({
  runCorrelation,
  runQualification,
  qualificationRunId,
} = {}) {
  if (runQualification !== undefined) {
    if (
      typeof runQualification !== "function" ||
      runCorrelation ||
      !/^i12-[a-f0-9]{16}$/u.test(qualificationRunId ?? "")
    )
      fail("REALTIME_QUALIFICATION_CALLBACK_INVALID");
  } else if (qualificationRunId !== undefined)
    fail("REALTIME_QUALIFICATION_CALLBACK_INVALID");
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextPath) fail("BROWSER_LAUNCH_CONTEXT_REQUIRED");
  const launch = await validateLaunchContext(contextPath);
  const { context: parentContext, candidateRoot, evidenceDir } = launch;
  if (
    resolve(process.cwd()) !== candidateRoot ||
    candidateRoot !== PROJECT_ROOT
  )
    fail("BROWSER_PARENT_CANDIDATE_INVALID");
  const parentCheckout = await inspectLaunchCheckout(
    candidateRoot,
    parentContext.candidateSha,
  );
  if (
    !SHA.test(parentContext.acceptedBaseCommit ?? "") ||
    !SHA256.test(parentContext.baseConfigSha256 ?? "") ||
    parentContext.candidateSha !== parentCheckout.commitSha
  )
    fail("BROWSER_PARENT_CONTEXT_INVALID");
  const baseConfigBytes = gitBytes(
    candidateRoot,
    "cat-file",
    "blob",
    `${parentContext.candidateSha}:config/platform.yaml`,
  );
  if (sha256(baseConfigBytes) !== parentContext.baseConfigSha256)
    fail("BROWSER_PARENT_CONFIG_INVALID");
  const baseConfigText = baseConfigBytes.toString("utf8");
  if (!Buffer.from(baseConfigText, "utf8").equals(baseConfigBytes))
    fail("BROWSER_PARENT_CONFIG_INVALID");
  const baseConfig = await loadPlatformConfig(
    candidateRoot,
    join(candidateRoot, "config/platform.yaml"),
  );
  if (baseConfig.browserOidc !== null)
    fail("BROWSER_PARENT_PROFILE_MUST_BE_NULL");
  const variantBytes = Buffer.from(fixtureConfigText(baseConfigText), "utf8");
  const variantHash = sha256(variantBytes);
  const childRoot = await mkdtemp(
    join(candidateRoot, BROWSER_CHILD_DIRECTORY_PREFIX),
  );
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
      fail("BROWSER_CHILD_BASE_MISMATCH");
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
        "user.name=Coffee browser verifier",
        "-c",
        "user.email=coffee-browser-verifier@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "Изолированный browser profile",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    childSha = git(childRoot, "rev-parse", "HEAD");
    const childInfo = await inspectLaunchCheckout(childRoot, childSha);
    if (
      childInfo.parents.length !== 1 ||
      childInfo.parents[0] !== parentContext.candidateSha
    )
      fail("BROWSER_CHILD_PARENT_INVALID");
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
    let artifactsDir;
    if (runQualification) {
      // evidence/launch приходит из git worktree с umask хоста (обычно 0775),
      // а квалификация публикует приватные артефакты. Выравниваем режим
      // собственного evidence-дерева, не ослабляя проверку.
      for (const directory of [
        join(parentContext.sourceRepoRoot, "evidence"),
        join(parentContext.sourceRepoRoot, "evidence/launch"),
        join(parentContext.sourceRepoRoot, "evidence/launch/qualifications"),
      ]) {
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        const info = await lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid() ||
          (await realpath(directory)) !== directory
        )
          fail("REALTIME_QUALIFICATION_DIRECTORY_INVALID");
        await chmod(directory, 0o700);
        const secured = await lstat(directory);
        if ((secured.mode & 0o777) !== 0o700)
          fail("REALTIME_QUALIFICATION_DIRECTORY_INVALID");
      }
      artifactsDir = join(
        parentContext.sourceRepoRoot,
        "evidence/launch/qualifications",
        qualificationRunId,
      );
      await mkdir(artifactsDir, { mode: 0o700 });
    } else {
      artifactsDir = join(
        evidenceDir,
        runCorrelation
          ? "gates/observability/artifacts"
          : "gates/browser/artifacts",
      );
    }
    const artifacts = runQualification
      ? QUALIFICATION_ARTIFACTS
      : runCorrelation
        ? CORRELATION_ARTIFACTS
        : ARTIFACTS;
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

    if (runQualification) {
      const result = await runQualification(contextRecord.path);
      if (
        result?.runId !== qualificationRunId ||
        typeof result?.resultDir !== "string"
      )
        fail("REALTIME_QUALIFICATION_RESULT_INVALID");
      const { classifyResult } =
        await import("../../../../tests/realtime/fixtures/protocol.mjs");
      const copied = {};
      for (const [key, name, limit] of [
        ["manifest", "profile-manifest.json", 16 * 1024 * 1024],
        ["result", "result.json", 4 * 1024 * 1024],
        ["cleanup", "cleanup.json", 1024 * 1024],
        ["containers", "containers.json", 1024 * 1024],
      ]) {
        const path = join(result.resultDir, name);
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid() ||
          info.size > limit ||
          (await realpath(path)) !== path
        )
          fail("REALTIME_QUALIFICATION_RAW_INVALID");
        copied[key] = await readFile(path);
        await writePrivateFile(
          join(artifactsDir, artifacts[key]),
          copied[key],
          0o400,
        );
      }
      const rawResult = JSON.parse(copied.result);
      const rawCleanup = JSON.parse(copied.cleanup);
      const rawContainers = JSON.parse(copied.containers);
      const manifest = JSON.parse(copied.manifest);
      const roles = [
        "kafka",
        "idp",
        "orders-fixture",
        "edge-gateway",
        "api-public",
        "realtime-gateway",
        "edge-nginx",
        "driver",
      ];
      if (
        rawResult.status !== "PASS" ||
        rawResult.launchProof !== true ||
        rawResult.cleanupVerified !== true ||
        rawCleanup.verified !== true ||
        rawCleanup.network?.created !== true ||
        rawCleanup.network?.removed !== true ||
        rawCleanup.network?.name !== `${qualificationRunId}-net` ||
        rawCleanup.owner?.removed !== true ||
        rawCleanup.syntheticPrivateMaterialRemoved !== true ||
        !Array.isArray(rawCleanup.receipts) ||
        !Array.isArray(rawContainers) ||
        rawCleanup.receipts.length !== roles.length ||
        rawContainers.length !== roles.length ||
        !roles.every((role) => {
          const containers = rawContainers.filter(
            (entry) => entry.role === role,
          );
          const receipts = rawCleanup.receipts.filter(
            (entry) => entry.role === role,
          );
          return (
            containers.length === 1 &&
            receipts.length === 1 &&
            receipts[0].id === containers[0].id &&
            receipts[0].removed === true &&
            receipts[0].logsCaptured === true
          );
        }) ||
        classifyResult(rawResult).status !== "PASS" ||
        rawResult.manifestSha256 !== sha256(copied.manifest) ||
        !manifest.qualification ||
        manifest.runId !== qualificationRunId
      )
        fail("REALTIME_QUALIFICATION_RESULT_INVALID");
      const parentContextBytes = await readFile(contextPath);
      await writePrivateFile(
        join(artifactsDir, artifacts.parentContext),
        parentContextBytes,
        0o400,
      );
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
      const bundleBytes = await assertPrivateFile(
        bundlePath,
        0o400,
        MAX_BUNDLE_BYTES,
      );
      const contextBytes = await readFile(contextRecord.path);
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
      const seal = {
        schemaVersion: 1,
        status: "SEALED",
        runId: qualificationRunId,
        parentRunId: parentContext.runId,
        candidateSha: parentContext.candidateSha,
        baseConfigSha256: parentContext.baseConfigSha256,
        childRunId,
        childCandidateSha: childSha,
        checkoutRemoved: true,
        evidenceRemoved: true,
        hashes: {
          parentContext: sha256(parentContextBytes),
          childContext: sha256(contextBytes),
          lineage: sha256(lineageBytes),
          bundle: sha256(bundleBytes),
          baseConfig: sha256(baseConfigBytes),
          childConfig: sha256(variantBytes),
          ...Object.fromEntries(
            Object.entries(copied).map(([key, bytes]) => [key, sha256(bytes)]),
          ),
        },
      };
      await writePrivateFile(
        join(artifactsDir, artifacts.seal),
        Buffer.from(`${JSON.stringify(seal, null, 2)}\n`),
        0o400,
      );
      return { qualificationSeal: seal, artifactsDir };
    }

    if (runCorrelation) {
      const result = await runCorrelation(contextRecord.path);
      validateChildCleanup(result, childContext);
      validateObservabilityBrowserEvidence(result.browserProof, {
        runId: childContext.runId,
        candidateSha: childContext.candidateSha,
        configSha256: childContext.baseConfigSha256,
      });
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
        fail("BROWSER_BUNDLE_SIZE_LIMIT");
      const contextBytes = await readFile(contextRecord.path);
      const bundleBytes = await readFile(bundlePath);
      const childReceipt = {
        schemaVersion: 1,
        status: "NOT_PROVEN",
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
        cleanup: result.externalCleanup,
        proof: result.browserProof,
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
      fail("BROWSER_CHILD_PROCESS_FAILED");
    const stdoutReceipt = lastJsonLine(childProcessResult.stdout);
    const childRuntimePath = join(
      childEvidenceDir,
      "gates/browser/artifacts/browser-runtime.json",
    );
    const childRuntimeInfo = await lstat(childRuntimePath);
    if (
      !childRuntimeInfo.isFile() ||
      childRuntimeInfo.isSymbolicLink() ||
      childRuntimeInfo.uid !== process.getuid() ||
      (childRuntimeInfo.mode & 0o777) !== 0o600
    )
      fail("BROWSER_CHILD_RUNTIME_ARTIFACT_INVALID");
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

    const ownerResult = await runManagedRollbackChild({
      args: [
        "--test",
        "--test-concurrency=1",
        "--test-reporter=tap",
        "tests/realtime/fixtures/owner-browser.mjs",
      ],
      cwd: candidateRoot,
      env: {
        ...process.env,
        COFFEE_LAUNCH_CONTEXT_FILE: contextRecord.path,
        COFFEE_OWNER_BROWSER: "1",
      },
      timeoutMs: 1_800_000,
      terminationGraceMs: 120_000,
    });
    const { parseTapSummary, tapSummaryPassed } =
      await import("./owner-suites.mjs");
    const counts = parseTapSummary(
      `${ownerResult.stdout ?? ""}\n${ownerResult.stderr ?? ""}`,
    );
    if (
      ownerResult.code !== 0 ||
      ownerResult.joined !== true ||
      ownerResult.signal !== null ||
      !tapSummaryPassed(counts) ||
      counts.tests !== 3
    )
      fail("BROWSER_OWNER_BROWSER_PROCESS_FAILED");
    const ownerProofs = {};
    const identity = {
      schemaVersion: childContext.schemaVersion,
      runId: childContext.runId,
      candidateSha: childContext.candidateSha,
      baseConfigSha256: childContext.baseConfigSha256,
    };
    for (const scenario of ["positive", "private-eof", "reauth"]) {
      const name = `owner-${scenario}.json`;
      const bytes = await assertPrivateFile(
        join(childEvidenceDir, "gates/browser/artifacts", name),
        0o600,
        8 * 1024 * 1024,
      );
      validateOwnerBrowserReceipt(
        JSON.parse(bytes),
        scenario,
        identity,
        sha256(lineageBytes),
      );
      await writePrivateFile(join(artifactsDir, name), bytes, 0o600);
      ownerProofs[scenario] = sha256(bytes);
    }

    git(childRoot, "update-ref", CHILD_REF, childContext.candidateSha);
    const artifactsDirParent = join(evidenceDir, "gates/browser/artifacts");
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
    if (bundleStat.size > MAX_BUNDLE_BYTES) fail("BROWSER_BUNDLE_SIZE_LIMIT");
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
      ownerProofs,
    };
    const parentArtifact = {
      schemaVersion: 1,
      gateId: "browser",
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
    // Child evidence остаётся свидетелем отказа; временный checkout удаляется
    // в finally на всех путях, чтобы не пачкать candidate root.
    if (
      !runCorrelation &&
      !runQualification &&
      childContext &&
      childRunId &&
      childSha
    ) {
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
  } finally {
    await rm(childRoot, { recursive: true, force: true });
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
    console.error(
      error instanceof Error ? error.message : "BROWSER_PARENT_FAILED",
    );
    process.exitCode = 1;
  }
}
