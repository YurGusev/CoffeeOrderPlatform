import { execFileSync } from "node:child_process";
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
import { artifactManifestPath } from "../../../../tools/image-inventory.mjs";
import {
  BROWSER_CHILD_DIRECTORY_NAME,
  ROLLBACK_DISABLED_RECONCILE_SUBSTAGES,
  ROLLBACK_ERROR_NAMES,
  ROLLBACK_FAILURE_CODES,
  ROLLBACK_FAILURE_STAGES,
  assertLiteralFlagChange,
  attachRollbackDisabledReconcileSubstage,
  configBytes,
  createRollbackFailureReceipt,
  failureCleanupIsValid,
  inspectLaunchCheckout,
  parsedConfig,
  readRollbackParent,
  rollbackComposeProjectName,
  rollbackComposeSourceLocation,
  runManagedRollbackChild,
  sourceLocationIsValid,
  validateConfigOnlyLineage,
  validateRollbackBaseline,
  validateRollbackLineage,
} from "../../../../scripts/launch-support/rollback-context.mjs";

const CONFIG_PATH = "config/platform.yaml";
const SHA = /^[0-9a-f]{40}$/u;
const PROJECT_ROOT = resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
export {
  BROWSER_CHILD_DIRECTORY_NAME,
  ROLLBACK_DISABLED_RECONCILE_SUBSTAGES,
  ROLLBACK_FAILURE_STAGES,
  attachRollbackDisabledReconcileSubstage,
  createRollbackFailureReceipt,
  inspectLaunchCheckout,
  readRollbackParent,
  rollbackComposeProjectName,
  rollbackComposeSourceLocation,
  runManagedRollbackChild,
  validateConfigOnlyLineage,
  validateRollbackBaseline,
  validateRollbackLineage,
};
const inspectCheckout = inspectLaunchCheckout;
function fail(code) {
  throw new Error(code);
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

export async function createConfigOnlyCheckout({
  candidateRoot,
  candidateSha,
  childConfig,
  parentDirectory = tmpdir(),
}) {
  const parent = await inspectCheckout(candidateRoot, candidateSha);
  if (!Buffer.isBuffer(childConfig)) fail("ROLLBACK_CONFIG_INVALID");
  const directory = await mkdtemp(
    join(parentDirectory, "coffee-controlled-config-"),
  );
  const baselineRoot = join(directory, "B");
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--dissociate",
        "--no-hardlinks",
        parent.root,
        baselineRoot,
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    gitOutput(
      baselineRoot,
      "remote",
      "set-url",
      "origin",
      "https://github.com/YurGusev/CoffeeOrderPlatform",
    );
    gitOutput(
      baselineRoot,
      "checkout",
      "--quiet",
      "--detach",
      parent.commitSha,
    );
    await writeFile(join(baselineRoot, CONFIG_PATH), childConfig, {
      mode: 0o644,
    });
    gitOutput(baselineRoot, "add", "--", CONFIG_PATH);
    gitOutput(
      baselineRoot,
      "-c",
      "user.name=Coffee verifier",
      "-c",
      "user.email=coffee-verifier@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Изолированная конфигурация проверки",
    );
    const baselineSha = gitText(baselineRoot, "rev-parse", "HEAD");
    await validateConfigOnlyLineage({
      parentRoot: parent.root,
      parentSha: parent.commitSha,
      baselineRoot,
      baselineSha,
    });
    return { directory, baselineRoot, baselineSha };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function createRollbackBaseline({
  candidateRoot,
  candidateSha,
  parentDirectory = tmpdir(),
}) {
  const parent = await inspectCheckout(candidateRoot, candidateSha);
  const original = configBytes(parent);
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original))
    fail("ROLLBACK_CONFIG_INVALID");
  if (
    parsedConfig(parent)?.services?.["aroma-convergence"]?.mutationsEnabled !==
    false
  )
    fail("ROLLBACK_BASELINE_PARENT_FLAG_INVALID");
  const pattern =
    /^([\t ]*mutationsEnabled:[\t ]*)false([\t ]*(?:#.*)?)(\r?)$/gmu;
  if ([...text.matchAll(pattern)].length !== 1)
    fail("ROLLBACK_CONFIG_AMBIGUOUS");
  const enabled = Buffer.from(text.replace(pattern, "$1true$2$3"));
  assertLiteralFlagChange(enabled, original);
  const checkout = await createConfigOnlyCheckout({
    candidateRoot,
    candidateSha,
    childConfig: enabled,
    parentDirectory,
  });
  try {
    const lineage = await validateRollbackBaseline({
      parentRoot: candidateRoot,
      parentSha: candidateSha,
      ...checkout,
    });
    return { ...checkout, lineage };
  } catch (error) {
    await rm(checkout.directory, { recursive: true, force: true });
    throw error;
  }
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
      "user.name=Coffee rollback verifier",
      "-c",
      "user.email=coffee-rollback-verifier@example.invalid",
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
      "user.name=Coffee rollback verifier",
      "-c",
      "user.email=coffee-rollback-verifier@example.invalid",
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

function lastJsonLine(output) {
  const line = output.split(/\r?\n/u).filter(Boolean).at(-1);
  try {
    return JSON.parse(line ?? "");
  } catch {
    fail("ROLLBACK_RUNTIME_RECEIPT_INVALID");
  }
}

export function validateRollbackFailureArtifact(
  artifact,
  { runId, candidateSha, lineage },
) {
  if (
    !artifact ||
    artifact.schemaVersion !== 1 ||
    artifact.gateId !== "rollback" ||
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

export async function writeRollbackFailureArtifact({
  artifact,
  identity,
  evidenceDir,
}) {
  validateRollbackFailureArtifact(artifact, identity);
  const artifactPath = join(
    evidenceDir,
    "gates/rollback/artifacts/mutation-disable-rollback-failure.json",
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
      value?.gateId !== "rollback" ||
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
      gateId: "rollback",
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
    artifact.gateId !== "rollback" ||
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
    "gates/rollback/artifacts/mutation-disable-rollback.json",
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

export async function verifyControlledRollbackEvidence({
  parentIdentity,
  parentContextPath,
  requireCleanup = true,
}) {
  const artifacts = join(
    parentIdentity.evidenceDir,
    "gates/rollback/artifacts",
  );
  const receipt = JSON.parse(
    await readFile(join(artifacts, "rollback-parent.json"), "utf8"),
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.runId !== parentIdentity.context.runId ||
    receipt.candidateSha !== parentIdentity.context.candidateSha ||
    !SHA.test(receipt.childSha ?? "") ||
    receipt.cleanup?.checkoutRemoved !== requireCleanup ||
    receipt.cleanup?.evidenceRemoved !== requireCleanup
  )
    fail("ROLLBACK_PARENT_RECEIPT_INVALID");
  const contextBytes = await readFile(
    join(artifacts, "rollback-child-context.json"),
  );
  if (
    createHash("sha256").update(contextBytes).digest("hex") !==
    receipt.childContextSha256
  )
    fail("ROLLBACK_CHILD_CONTEXT_INVALID");
  const context = JSON.parse(contextBytes.toString("utf8"));
  if (
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(context.runId ?? "") ||
    context.runId !== receipt.childRunId ||
    context.candidateSha !== receipt.childSha ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`) ||
    context.acceptedBaseCommit !== parentIdentity.context.acceptedBaseCommit ||
    context.sourceRepoRoot !== parentIdentity.sourceRoot ||
    context.evidenceDir !==
      join(parentIdentity.sourceRoot, "evidence/launch", context.runId) ||
    context.resources?.composeProject !==
      `coffee-launch-${context.runId.toLowerCase()}` ||
    context.resources?.kafkaPrefix !== context.runId ||
    context.resources?.controlledScope !== "rollback" ||
    context.resources.controlledParentContextPath !== parentContextPath ||
    context.resources.controlledParentCandidateSha !==
      parentIdentity.context.candidateSha ||
    context.resources.controlledParentRunId !== parentIdentity.context.runId
  )
    fail("ROLLBACK_CHILD_CONTEXT_INVALID");
  const artifactBytes = await readFile(
    join(artifacts, "mutation-disable-rollback.json"),
  );
  if (
    createHash("sha256").update(artifactBytes).digest("hex") !==
    receipt.runtimeArtifactSha256
  )
    fail("ROLLBACK_RUNTIME_ARTIFACT_INVALID");
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  if (
    ![artifact.lineage?.D?.commitSha, artifact.lineage?.R?.commitSha].every(
      (sha) => SHA.test(sha ?? ""),
    )
  )
    fail("ROLLBACK_RUNTIME_ARTIFACT_INVALID");
  const parentBundle = join(artifacts, "rollback-config-lineage.bundle");
  const runtimeBundle = join(artifacts, "rollback-runtime-lineage.bundle");
  for (const [path, expected] of [
    [parentBundle, receipt.parentBundleSha256],
    [runtimeBundle, receipt.runtimeBundleSha256],
  ]) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16 * 1024 * 1024 ||
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== expected
    )
      fail("ROLLBACK_PARENT_BUNDLE_INVALID");
  }
  const temporary = await mkdtemp(join(tmpdir(), "coffee-rollback-admission-"));
  try {
    const baselineRoot = join(temporary, "B"),
      disabledRoot = join(temporary, "D"),
      restoredRoot = join(temporary, "R");
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        parentIdentity.candidateRoot,
        baselineRoot,
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    gitOutput(baselineRoot, "bundle", "verify", parentBundle);
    if (
      gitText(baselineRoot, "bundle", "list-heads", parentBundle) !==
      `${receipt.childSha} HEAD`
    )
      fail("ROLLBACK_PARENT_BUNDLE_INVALID");
    gitOutput(
      baselineRoot,
      "fetch",
      "--quiet",
      "--no-tags",
      parentBundle,
      "HEAD",
    );
    gitOutput(
      baselineRoot,
      "checkout",
      "--quiet",
      "--detach",
      receipt.childSha,
    );
    const parentLineage = await validateRollbackBaseline({
      parentRoot: parentIdentity.candidateRoot,
      parentSha: parentIdentity.context.candidateSha,
      baselineRoot,
      baselineSha: receipt.childSha,
    });
    if (
      parentLineage.parent.configSha256 !==
        parentIdentity.context.baseConfigSha256 ||
      parentLineage.baseline.configSha256 !== context.baseConfigSha256
    )
      fail("ROLLBACK_PARENT_CONFIG_INVALID");
    gitOutput(baselineRoot, "bundle", "verify", runtimeBundle);
    if (
      gitText(baselineRoot, "bundle", "list-heads", runtimeBundle) !==
      `${artifact.lineage?.R?.commitSha} HEAD`
    )
      fail("ROLLBACK_RUNTIME_BUNDLE_INVALID");
    gitOutput(
      baselineRoot,
      "fetch",
      "--quiet",
      "--no-tags",
      runtimeBundle,
      "HEAD",
    );
    for (const [root, sha] of [
      [disabledRoot, artifact.lineage.D.commitSha],
      [restoredRoot, artifact.lineage.R.commitSha],
    ]) {
      execFileSync(
        "git",
        ["clone", "--quiet", "--shared", "--no-hardlinks", baselineRoot, root],
        { stdio: "ignore", timeout: 60_000 },
      );
      gitOutput(root, "checkout", "--quiet", "--detach", sha);
    }
    const lineage = await validateRollbackLineage({
      launchIdentity: {
        candidateRoot: baselineRoot,
        context: { checkoutDir: baselineRoot, candidateSha: receipt.childSha },
      },
      disabledRoot,
      disabledSha: artifact.lineage.D.commitSha,
      restoredRoot,
      restoredSha: artifact.lineage.R.commitSha,
    });
    validateRollbackRuntimeArtifact(artifact, {
      runId: context.runId,
      candidateSha: receipt.childSha,
      lineage,
    });
    const images = await import(
      pathToFileURL(
        join(
          parentIdentity.candidateRoot,
          "tools/verified-infrastructure-image.mjs",
        ),
      ).href
    );
    const runtimeImages = await images.readVerifiedRuntimeImages({
      contextFile: parentContextPath,
    });
    const kafka = await images.loadVerifiedGateImage({
      contextFile: parentContextPath,
      target: "kafka",
      loadImage: false,
    });
    if (
      !isDeepStrictEqual(artifact.runtimeProof.imageBinding, {
        parentRunId: parentIdentity.context.runId,
        parentCandidateSha: parentIdentity.context.candidateSha,
        runtimeImages,
        kafkaImageId: kafka.imageId,
      })
    )
      fail("ROLLBACK_PARENT_IMAGE_BINDING_INVALID");
    return { receipt, artifact, context };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function writeRollbackLineageBundle({
  restoredRoot,
  candidateSha,
  restoredSha,
  evidenceDir,
  scope = "rollback",
}) {
  if (!["aroma_sandbox", "rollback"].includes(scope))
    fail("ROLLBACK_BUNDLE_SCOPE_INVALID");
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
    scope === "aroma_sandbox"
      ? "gates/aroma_sandbox/artifacts/controlled-config.bundle"
      : "gates/rollback/artifacts/rollback-config-lineage.bundle",
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

export async function runControlledRollbackChild({
  args,
  cwd,
  env,
  parentIdentity,
  parentContextPath,
  child,
}) {
  try {
    return await runManagedRollbackChild({
      args,
      cwd,
      env,
      terminationGraceMs: 150_000,
    });
  } catch (error) {
    const parent = parentIdentity.context;
    let safeFailure = {
      schemaVersion: 1,
      status: "FAIL",
      code: "ROLLBACK_CONTROLLED_CHILD_FAILURE_UNVERIFIED",
      parentRunId: parent.runId,
      parentCandidateSha: parent.candidateSha,
      childRunId: child.context.runId,
      childCandidateSha: child.context.candidateSha,
      cleanup: {
        verified: false,
        complete: false,
        failures: [],
        retainedResources: [],
        inventory: { containers: [], volumes: [], networks: [] },
      },
    };
    let contextBytes;
    try {
      const contextInfo = await lstat(child.path);
      if (
        error?.result?.joined !== true ||
        error.message !== "ROLLBACK_CHILD_FAILED" ||
        error.result.code === 0 ||
        !contextInfo.isFile() ||
        contextInfo.isSymbolicLink() ||
        contextInfo.uid !== process.getuid() ||
        (contextInfo.mode & 0o777) !== 0o400 ||
        contextInfo.size > 16384 ||
        child.path !== join(child.context.evidenceDir, "context.json") ||
        child.context.evidenceDir !==
          join(
            parentIdentity.sourceRoot,
            "evidence/launch",
            child.context.runId,
          )
      )
        fail("ROLLBACK_CONTROLLED_FAILURE_INVALID");
      const candidateContextBytes = await readFile(child.path);
      const childReport = await import(
        pathToFileURL(join(cwd, "verification/launch/v1/report.mjs")).href
      );
      const identity = await childReport.validateLaunchContext(child.path);
      if (
        candidateContextBytes.length !== contextInfo.size ||
        !isDeepStrictEqual(
          JSON.parse(candidateContextBytes.toString("utf8")),
          child.context,
        ) ||
        !isDeepStrictEqual(identity.context, child.context) ||
        identity.candidateRoot !== cwd ||
        identity.sourceRoot !== parentIdentity.sourceRoot ||
        child.context.candidateSha !== child.lineage.baseline.commitSha ||
        child.context.baseConfigSha256 !==
          child.lineage.baseline.configSha256 ||
        child.context.acceptedBaseCommit !== parent.acceptedBaseCommit ||
        child.context.resources?.controlledScope !== "rollback" ||
        child.context.resources.controlledParentContextPath !==
          parentContextPath ||
        child.context.resources.controlledParentCandidateSha !==
          parent.candidateSha ||
        child.context.resources.controlledParentRunId !== parent.runId
      )
        fail("ROLLBACK_CONTROLLED_FAILURE_INVALID");
      contextBytes = candidateContextBytes;
      const path = join(
        child.context.evidenceDir,
        "gates/rollback/artifacts/mutation-disable-rollback-failure.json",
      );
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o600 ||
        info.size > 131072 ||
        (await realpath(path)) !== path
      )
        fail("ROLLBACK_CONTROLLED_FAILURE_INVALID");
      const bytes = await readFile(path);
      if (bytes.length !== info.size)
        fail("ROLLBACK_CONTROLLED_FAILURE_INVALID");
      const failure = JSON.parse(bytes.toString("utf8"));
      validateRollbackFailureArtifact(failure, {
        runId: child.context.runId,
        candidateSha: child.context.candidateSha,
        lineage: failure.lineage,
      });
      if (
        failure.lineage?.B?.commitSha !== child.context.candidateSha ||
        failure.lineage.B.treeSha !== child.lineage.baseline.treeSha ||
        failure.lineage.B.configSha256 !== child.context.baseConfigSha256 ||
        !failureCleanupIsValid({ ...failure.cleanup, verified: true })
      )
        fail("ROLLBACK_CONTROLLED_FAILURE_INVALID");
      const cleanup = failure.cleanup;
      safeFailure = {
        schemaVersion: 1,
        status: "FAIL",
        parentRunId: parent.runId,
        parentCandidateSha: parent.candidateSha,
        childRunId: child.context.runId,
        childCandidateSha: child.context.candidateSha,
        childContextSha256: createHash("sha256")
          .update(contextBytes)
          .digest("hex"),
        sourceFailureSha256: createHash("sha256").update(bytes).digest("hex"),
        stage: failure.stage,
        code: failure.code,
        errorName: failure.errorName,
        messageSha256: failure.messageSha256,
        ...(failure.disabledReconcileSubstage
          ? { disabledReconcileSubstage: failure.disabledReconcileSubstage }
          : {}),
        ...(failure.sourceLocation
          ? {
              sourceLocation: {
                source: failure.sourceLocation.source,
                line: failure.sourceLocation.line,
                column: failure.sourceLocation.column,
              },
            }
          : {}),
        cleanup: {
          verified: cleanup.verified,
          complete: cleanup.complete,
          failures: [...cleanup.failures],
          retainedResources: cleanup.retainedResources.map(
            ({ kind, name }) => ({ kind, name }),
          ),
          inventory: Object.fromEntries(
            ["containers", "volumes", "networks"].map((kind) => [
              kind,
              [...cleanup.inventory[kind]],
            ]),
          ),
        },
      };
    } catch {
      // Missing or untrusted child data cannot establish cleanup or failure stage.
    }
    const artifacts = join(
      parentIdentity.evidenceDir,
      "gates/rollback/artifacts",
    );
    if (contextBytes)
      await writeFile(
        join(artifacts, "rollback-child-context.json"),
        contextBytes,
        { flag: "wx", mode: 0o600 },
      );
    const path = join(artifacts, "rollback-child-failure.json");
    const bytes = Buffer.from(`${JSON.stringify(safeFailure, null, 2)}\n`);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    const failure = new Error(
      safeFailure.code === "ROLLBACK_CONTROLLED_CHILD_FAILURE_UNVERIFIED"
        ? safeFailure.code
        : "ROLLBACK_CONTROLLED_CHILD_FAILED",
    );
    failure.safeDetails = {
      failureReceipt: {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
    throw failure;
  }
}

async function runControlledRollbackParent(parentIdentity, parentContextPath) {
  const { prepareBrowserChildCheckout, writeControlledChildContext } =
    await import("./browser.mjs");
  const { context, candidateRoot, evidenceDir } = parentIdentity;
  const baseline = await createRollbackBaseline({
    candidateRoot,
    candidateSha: context.candidateSha,
  });
  let child;
  let childStarted = false;
  try {
    await prepareBrowserChildCheckout(baseline.baselineRoot);
    child = await writeControlledChildContext({
      contextPath: parentContextPath,
      childRoot: baseline.baselineRoot,
      childSha: baseline.baselineSha,
      scope: "rollback",
    });
    const artifacts = join(evidenceDir, "gates/rollback/artifacts");
    const parentBundle = await writeRollbackLineageBundle({
      candidateSha: context.candidateSha,
      restoredSha: baseline.baselineSha,
      restoredRoot: baseline.baselineRoot,
      evidenceDir,
    });
    childStarted = true;
    const result = await runControlledRollbackChild({
      args: [
        join(
          baseline.baselineRoot,
          "verification/launch/v1/scenarios/rollback.mjs",
        ),
      ],
      cwd: baseline.baselineRoot,
      env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: child.path },
      parentIdentity,
      parentContextPath,
      child,
    });
    const outcome = lastJsonLine(result.stdout);
    const childArtifacts = join(
      child.context.evidenceDir,
      "gates/rollback/artifacts",
    );
    const runtimeBytes = await readFile(
      join(childArtifacts, "mutation-disable-rollback.json"),
    );
    if (
      outcome.runtimeArtifact?.sha256 !==
      createHash("sha256").update(runtimeBytes).digest("hex")
    )
      fail("ROLLBACK_RUNTIME_ARTIFACT_INVALID");
    const contextBytes = await readFile(child.path);
    const runtimeBundleBytes = await readFile(
      join(childArtifacts, "rollback-config-lineage.bundle"),
    );
    await writeFile(
      join(artifacts, "rollback-child-context.json"),
      contextBytes,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(artifacts, "mutation-disable-rollback.json"),
      runtimeBytes,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(artifacts, "rollback-runtime-lineage.bundle"),
      runtimeBundleBytes,
      { flag: "wx", mode: 0o600 },
    );
    const receipt = {
      schemaVersion: 1,
      runId: context.runId,
      candidateSha: context.candidateSha,
      childRunId: child.context.runId,
      childSha: baseline.baselineSha,
      parentBundleSha256: parentBundle.sha256,
      runtimeBundleSha256: createHash("sha256")
        .update(runtimeBundleBytes)
        .digest("hex"),
      childContextSha256: createHash("sha256")
        .update(contextBytes)
        .digest("hex"),
      runtimeArtifactSha256: createHash("sha256")
        .update(runtimeBytes)
        .digest("hex"),
      cleanup: { checkoutRemoved: false, evidenceRemoved: false },
    };
    const receiptPath = join(artifacts, "rollback-parent.json");
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await verifyControlledRollbackEvidence({
      parentIdentity,
      parentContextPath,
      requireCleanup: false,
    });
    await rm(baseline.directory, { recursive: true });
    await rm(child.context.evidenceDir, { recursive: true });
    if (
      (await lstat(baseline.directory).then(
        () => true,
        () => false,
      )) ||
      (await lstat(child.context.evidenceDir).then(
        () => true,
        () => false,
      ))
    )
      fail("ROLLBACK_CHILD_CLEANUP_INVALID");
    receipt.cleanup = { checkoutRemoved: true, evidenceRemoved: true };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    await verifyControlledRollbackEvidence({
      parentIdentity,
      parentContextPath,
    });
    return {
      schemaVersion: 1,
      controlledChild: {
        candidateSha: baseline.baselineSha,
        runId: child.context.runId,
        cleanup: receipt.cleanup,
      },
    };
  } finally {
    if (!childStarted) {
      await rm(baseline.directory, { recursive: true, force: true });
      if (child)
        await rm(child.context.evidenceDir, { recursive: true, force: true });
    } // Once the child starts, uncertain cleanup must retain its checkout and evidence.
  }
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
  const parentCheckout = await inspectCheckout(
    candidateRoot,
    context.candidateSha,
  );
  if (
    parsedConfig(parentCheckout)?.services?.["aroma-convergence"]
      ?.mutationsEnabled === false
  )
    return runControlledRollbackParent(launchIdentity, resolve(contextPath));
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
    // Образы приходят только из манифеста supply_chain. В controlled child
    // манифест принадлежит родительскому запуску, поэтому путь выводится из
    // явного parent run ID, а не из дочернего evidenceDir.
    const controlledParentRunId =
      launchIdentity.context.resources?.controlledParentRunId;
    if (
      controlledParentRunId !== undefined &&
      !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(controlledParentRunId)
    )
      fail("ROLLBACK_CONTROLLED_PARENT_INVALID");
    const artifactManifest = artifactManifestPath(
      controlledParentRunId
        ? join(
            launchIdentity.sourceRoot,
            "evidence/launch",
            controlledParentRunId,
          )
        : launchIdentity.evidenceDir,
    );
    const args = [
      join(candidateRoot, "tools/compose-smoke.mjs"),
      "--mutation-disable-rollback",
      "--reuse-images",
      "--artifact-manifest",
      artifactManifest,
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
      gateId: "rollback",
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
    if (error?.safeDetails?.failureReceipt)
      console.log(
        JSON.stringify({
          status: "FAIL",
          code: error.message,
          ...error.safeDetails,
        }),
      );
    console.error(
      error instanceof Error ? error.message : "ROLLBACK_RUNTIME_PROOF_FAILED",
    );
    process.exitCode = 1;
  }
}
