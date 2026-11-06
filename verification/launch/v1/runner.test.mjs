import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  captureKafkaNamespaceArtifact,
  applyLaunchImageEvidence,
  executeArgv,
  executeRun,
  finishRuntimeImageOwnership,
  gateBudgetMs,
  loadMatrix,
  normalizeCandidateInputModes,
  readLaunchImageEvidence,
  parseArgs as parseLaunchArguments,
  runGate,
  splitCommand,
  validateRunResult,
  validateLaunchDataTempDir,
  verifyGateArtifacts,
  writeRedactedStream,
} from "./run.mjs";

import {
  EXPECTED_GATES,
  finalizeReport,
  validateChecksumManifest,
  validateKafkaNamespaceInventory,
} from "./report.mjs";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
} from "../../../packages/platform-config/src/launch-database-target.ts";
import { CANONICAL_KAFKA_TOPIC_NAMES } from "../../../packages/platform-config/src/launch-kafka-target.ts";
import { parsePlatformConfig } from "../../../packages/platform-config/src/index.ts";
import {
  AdmissionError,
  assertAdmissionContractMatchesCandidate,
  canonicalHttpsOrigin,
  loadAdmissionContract,
  validateAdmission,
} from "./scenarios/aroma-approval.mjs";
import { freshOfferRefForProviderId } from "./scenarios/aroma-sandbox-catalog.mjs";
import {
  assertRoleMapGrantRows,
  formatOwnerStageFailure,
  readApprovedMigrationTarget,
} from "./scenarios/migrations.mjs";
import {
  appendAromaSandboxDesired,
  applyCanonicalMigrations,
  assertAromaApprovalForOffer,
  assertAromaCartVector,
  assertAromaControlledOfferFacts,
  canCleanupAromaAfterFailure,
  captureAromaCatalogPersistenceFailure,
  captureAromaPhaseFailureFacts,
  computeExistingAccountFingerprint,
  createAromaMutationGrant,
  createG16Checkout,
  buildG16ChildConfig,
  handleControlledG16ChildFailure,
  readApprovedG16Policy,
  createAromaProviderMutationGuard,
  inspectAromaProfile,
  loadAromaPackingWireProof,
  normalizeCleanupFailureOutcome,
  parseArguments as parseAromaArguments,
  runControlledG16Parent,
  safeAromaConvergenceEvidence,
  safeAromaDiagnostic,
  safeAromaFailureCode,
  safeAromaPhaseFailureEvidence,
  sanitizeControlledG16Recovery,
  startAcknowledgementDropProxy,
  validateAromaPackingWireProof,
  validateControlledG16Result,
  verifyControlledG16Evidence,
  waitForAromaRestartEligibility,
} from "./scenarios/aroma-sandbox.mjs";
import {
  parseTapSummary,
  tapSummaryPassed,
} from "./scenarios/owner-suites.mjs";
import { aromaSandboxResourceNames } from "./scenarios/aroma-sandbox-resources.mjs";
import {
  attachRollbackDisabledReconcileSubstage,
  createRollbackBaseline,
  createRollbackCheckouts,
  createRollbackFailureReceipt,
  inspectLaunchCheckout,
  persistRollbackFailureFromChild,
  rollbackComposeProjectName,
  runManagedRollbackChild,
  ROLLBACK_DISABLED_RECONCILE_SUBSTAGES,
  validateRollbackLineage,
  validateRollbackBaseline,
  validateRollbackFailureArtifact,
  validateRollbackRuntimeArtifact,
  writeRollbackRuntimeArtifact,
  writeRollbackLineageBundle,
} from "./scenarios/rollback.mjs";
import {
  assertRollbackFixtureBaseline,
  assertRollbackHistoryPreserved,
  shouldLoseFirstRollbackSetQuantityResponse,
} from "../../../tools/rollback-runtime-proof.mjs";
import {
  projectLaunchDatabaseTargets,
  validateRoleMap,
} from "../../../scripts/db-bootstrap.mjs";
import {
  bootstrapEnvironment,
  kafkaNamespaceLaunchIdentity,
  projectRecoveryPlatformConfig,
  readDatabaseProofCredentials,
  readRecoveryProofCredentials,
  rollbackRuntimeComposeOptions,
  rollbackRuntimeConfigProofSource,
  writeScopedComposeOverride,
  databaseProofService,
  proofDatabaseOptions,
  nativeFoundationSource,
  nativeKafkaBlackholeSource,
} from "../../../tools/compose-smoke.mjs";
import { load as parseYaml } from "js-yaml";
import {
  assertContextSnapshotUnchanged,
  changedCriticalModules,
  coverageForModule,
  parseLcovRecords,
  parseTapSummary as parseUnitTapSummary,
  parseTapSummaryDiagnostic,
  runUnitTestChild,
  snapshotReadonlyContext,
  writeUnitEvidenceArtifacts,
} from "./scenarios/unit.mjs";
import { selectFormatPaths } from "../../../scripts/format.mjs";

void test("launch controller reaches evidence preflight without compiled services", async (t) => {
  const source = fileURLToPath(new URL("../../..", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "launch-controller-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const controller = join(temporary, "controller");
  const outside = join(temporary, "outside");
  await mkdir(controller);
  await mkdir(outside);
  const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: source,
    maxBuffer: 128 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", controller], { input: archive });
  for (const path of [
    "tools/compose-smoke.mjs",
    "tools/runtime-image-inventory.mjs",
    "verification/launch/v1/run.mjs",
  ])
    await cp(join(source, path), join(controller, path));
  await rm(join(controller, "evidence/launch"), {
    recursive: true,
    force: true,
  });
  const git = (...args) =>
    execFileSync("git", args, { cwd: controller, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "isolated controller fixture",
  );
  await symlink(join(source, "node_modules"), join(controller, "node_modules"));
  await symlink(
    join(source, "apps/web/node_modules"),
    join(controller, "apps/web/node_modules"),
  );
  await cp(
    join(source, "packages/platform-config/dist"),
    join(controller, "packages/platform-config/dist"),
    { recursive: true },
  );
  const directories = [join(controller, "apps"), join(controller, "packages")];
  while (directories.length) {
    const parent = directories.pop();
    assert.ok(parent);
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      const path = join(parent, entry.name);
      if (entry.name === "dist")
        assert.equal(path, join(controller, "packages/platform-config/dist"));
      else directories.push(path);
    }
  }
  await writeFile(
    join(controller, ".git/info/exclude"),
    "/evidence/launch\n/node_modules\n/apps/web/node_modules\n",
    { flag: "a" },
  );
  await symlink(outside, join(controller, "evidence/launch"));
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: controller,
      encoding: "utf8",
    }),
    "",
  );
  const result = spawnSync(
    process.execPath,
    ["verification/launch/v1/run.mjs"],
    {
      cwd: controller,
      env: { ...process.env, TMPDIR: temporary },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /Evidence parent не является обычным каталогом: evidence\/launch/u,
  );
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
  assert.deepEqual(await readdir(outside), []);
});

void test("launch data temporary directory is private, canonical and gate scoped", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-data-temp-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateDir = join(directory, "data");
  await mkdir(privateDir, { mode: 0o700 });
  assert.deepEqual(parseLaunchArguments(["--data-temp-dir", privateDir]), {
    dataTempDir: privateDir,
  });
  for (const args of [
    ["--data-temp-dir"],
    ["--data-temp-dir", "relative"],
    ["--data-temp-dir", `${privateDir}/../data`],
    ["--data-temp-dir", privateDir, "--data-temp-dir", privateDir],
  ])
    assert.throws(() => parseLaunchArguments(args), /data-temp-dir/u);
  assert.equal(await validateLaunchDataTempDir(privateDir), privateDir);
  await assert.rejects(validateLaunchDataTempDir(join(directory, "missing")));
  await assert.rejects(
    executeRun({ dataTempDir: "relative" }),
    /data-temp-dir/u,
  );
  const link = join(directory, "link");
  await symlink(privateDir, link);
  await assert.rejects(validateLaunchDataTempDir(link));
  await mkdir(join(privateDir, "nested"), { mode: 0o700 });
  await assert.rejects(validateLaunchDataTempDir(join(link, "nested")));
  await chmod(privateDir, 0o755);
  await assert.rejects(validateLaunchDataTempDir(privateDir), /private owned/u);
  await chmod(privateDir, 0o700);
  const uid = process.getuid();
  t.mock.method(process, "getuid", () => uid + 1);
  await assert.rejects(validateLaunchDataTempDir(privateDir), /private owned/u);
  t.mock.restoreAll();

  const prior = {
    TMPDIR: process.env.TMPDIR,
    COFFEE_LAUNCH_DATA_TEMP_DIR: process.env.COFFEE_LAUNCH_DATA_TEMP_DIR,
  };
  process.env.TMPDIR = "/tmp/launch-original-temp";
  process.env.COFFEE_LAUNCH_DATA_TEMP_DIR = "/tmp/untrusted-inherited";
  try {
    for (const [index, [gateId, expectedTmp, expectedData, configured]] of [
      ["G12_SUPPLY_CHAIN", "/tmp/launch-original-temp", privateDir, true],
      ["G14_OBSERVABILITY", privateDir, null, true],
      ["G10_INTEGRATION", "/tmp/launch-original-temp", null, true],
      ["G12_SUPPLY_CHAIN", "/tmp/launch-original-temp", null, false],
    ].entries()) {
      const stdout = join(directory, `${gateId}-${index}.out`);
      const stderr = join(directory, `${gateId}-${index}.err`);
      const run = await executeArgv(
        [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({tmp:process.env.TMPDIR,data:process.env.COFFEE_LAUNCH_DATA_TEMP_DIR??null}))",
        ],
        directory,
        10_000,
        stdout,
        stderr,
        undefined,
        null,
        { gateId, dataTempDir: configured ? privateDir : undefined },
      );
      assert.equal(run.exitCode, 0);
      assert.deepEqual(JSON.parse(await readFile(stdout, "utf8")), {
        tmp: expectedTmp,
        data: expectedData,
      });
    }
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

void test("image cleanup completes before ownership can pass; unknown cleanup fails the gate", () => {
  const ownership = {
    projectName: "coffee-launch-test",
    images: [],
    phase: "ready",
  };
  const gate = { status: "PASS" };
  assert.equal(
    finishRuntimeImageOwnership(ownership, gate, () => {
      assert.equal(ownership.phase, "ready");
      throw new Error("cannot inspect image");
    }),
    false,
  );
  assert.equal(ownership.phase, "cleanup-failed");
  assert.equal(gate.status, "FAIL");
  assert.match(gate.reason, /cannot inspect image/);
  ownership.phase = "ready";
  gate.status = "PASS";
  assert.equal(
    finishRuntimeImageOwnership(ownership, gate, () => {
      assert.equal(ownership.phase, "ready");
    }),
    true,
  );
  assert.equal(ownership.phase, "cleaned");
  ownership.phase = "ready";
  ownership.baseline = [
    { imageId: `sha256:${"a".repeat(64)}`, references: ["foreign:latest"] },
  ];
  ownership.baselineSha256 = "0".repeat(64);
  gate.status = "PASS";
  let called = false;
  assert.equal(
    finishRuntimeImageOwnership(ownership, gate, () => {
      called = true;
    }),
    false,
  );
  assert.equal(called, false);
  assert.equal(gate.status, "FAIL");
  assert.match(gate.reason, /baseline hash mismatch/u);
  ownership.phase = "ready";
  ownership.baselineSha256 = createHash("sha256")
    .update(JSON.stringify(ownership.baseline))
    .digest("hex");
  gate.status = "PASS";
  assert.equal(
    finishRuntimeImageOwnership(
      ownership,
      gate,
      (_project, _images, _run, baseline) => {
        assert.deepEqual(baseline, ownership.baseline);
      },
    ),
    true,
  );
});

void test("G19 runs image cleanup before writing the final decision", async () => {
  const source = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
  const gates = source.indexOf(
    "for (let index = 0; index < matrix.gates.length",
  );
  const report = source.indexOf('if (gate.id === "G19_REPORT")', gates);
  const cleanup = source.indexOf(
    "imageCleanupVerified = finishRuntimeImageOwnership(",
    report,
  );
  const defects = source.indexOf(
    "await writeDefects(evidenceDir, ROOT, result)",
    report,
  );
  assert.ok(
    gates >= 0 && report > gates && cleanup > report && defects > cleanup,
  );
});

void test("runner passes image ownership only when explicitly selected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-image-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = join(directory, "ownership.json");
  for (const { name, options, expected } of [
    { name: "normal", options: {}, expected: "" },
    {
      name: "owned",
      options: { imageOwnershipPath: marker },
      expected: marker,
    },
  ]) {
    const stdout = join(directory, `${name}.out`);
    const result = await executeArgv(
      [
        process.execPath,
        "-e",
        "process.stdout.write(process.env.COFFEE_LAUNCH_IMAGE_OWNERSHIP || '')",
      ],
      directory,
      5000,
      stdout,
      join(directory, `${name}.err`),
      undefined,
      null,
      options,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(await readFile(stdout, "utf8"), expected);
  }
});

const rollbackGit = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

void test("formatter selects only existing active source files from the Git path set", () => {
  const gitPaths = [
    "apps/catalog/src/catalog.ts",
    "apps/catalog/dist/catalog.js",
    "apps/catalog/coverage/lcov.json",
    "apps/catalog/node_modules/dependency/index.js",
    "config/platform.yaml",
    "docs/adr/decision.ts",
    "evidence/launch/result.json",
    "secrets/platform.secrets.sops.yaml",
    "packages/generated/contracts.ts",
    "packages/platform-ui/provenance/proof.json",
    "packages/platform-ui/src/styles/global.css",
    "packages/platform-ui/src/styles/tokens.css",
    ".codex/settings.json",
    ".git/config.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/format.mjs",
    "tests/config/fixture.jsonc",
    "verification/launch/matrix.yaml",
    "apps/catalog/src/deleted.ts",
    "README.md",
  ];
  const existingPaths = gitPaths.filter(
    (path) => path !== "apps/catalog/src/deleted.ts",
  );
  assert.deepEqual(selectFormatPaths(gitPaths, existingPaths), [
    "apps/catalog/src/catalog.ts",
    "config/platform.yaml",
    "package.json",
    "scripts/format.mjs",
    "tests/config/fixture.jsonc",
    "verification/launch/matrix.yaml",
  ]);
});

async function rollbackGitFixture(t, variant = "valid") {
  const directory = await mkdtemp(join(tmpdir(), "launch-g18-lineage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "history");
  await mkdir(source);
  rollbackGit(source, "init", "-q", "-b", "main");
  rollbackGit(source, "config", "user.name", "Launch fixture");
  rollbackGit(source, "config", "user.email", "launch-fixture@example.invalid");
  const baseConfig =
    variant === "shared-alias"
      ? "# Зафиксированный config-кандидат B\nservices:\n  aroma-convergence: &shared\n    mutationsEnabled: true\n    endpoint: fixture\n  other-service: *shared\nother:\n  stable: true\n"
      : "# Зафиксированный config-кандидат B\nservices:\n  aroma-convergence:\n    mutationsEnabled: true\n    endpoint: fixture\nother:\n  stable: true\n";
  const disabledConfig = baseConfig.replace(
    "mutationsEnabled: true",
    "mutationsEnabled: false",
  );
  await mkdir(join(source, "config"));
  await writeFile(join(source, "config/platform.yaml"), baseConfig);
  await writeFile(join(source, "stable.txt"), "unchanged\n");
  rollbackGit(source, "add", "-A");
  rollbackGit(source, "commit", "-qm", "B product candidate");
  const candidateSha = rollbackGit(source, "rev-parse", "HEAD");

  if (variant === "wrong-parent")
    rollbackGit(
      source,
      "commit",
      "--allow-empty",
      "-qm",
      "unexpected intermediate",
    );
  await writeFile(join(source, "config/platform.yaml"), disabledConfig);
  if (variant === "extra-file")
    await writeFile(join(source, "unexpected.txt"), "extra\n");
  if (variant === "extra-config")
    await writeFile(
      join(source, "config/platform.yaml"),
      disabledConfig.replace("stable: true", "stable: false"),
    );
  if (variant === "extra-comment")
    await writeFile(
      join(source, "config/platform.yaml"),
      `${disabledConfig}# added comment\n`,
    );
  if (variant === "format-change")
    await writeFile(
      join(source, "config/platform.yaml"),
      disabledConfig.replace(
        "mutationsEnabled: false",
        "mutationsEnabled:   false",
      ),
    );
  rollbackGit(source, "add", "-A");
  if (variant === "mode-change")
    rollbackGit(source, "update-index", "--chmod=+x", "stable.txt");
  if (variant === "merge") {
    const tree = rollbackGit(source, "write-tree");
    const baseTree = rollbackGit(source, "rev-parse", `${candidateSha}^{tree}`);
    const side = execFileSync(
      "git",
      ["commit-tree", baseTree, "-p", candidateSha],
      {
        cwd: source,
        encoding: "utf8",
        input: "merge side fixture\n",
        stdio: ["pipe", "pipe", "ignore"],
      },
    ).trim();
    const merged = execFileSync(
      "git",
      ["commit-tree", tree, "-p", candidateSha, "-p", side],
      {
        cwd: source,
        encoding: "utf8",
        input: "merge fixture\n",
        stdio: ["pipe", "pipe", "ignore"],
      },
    ).trim();
    rollbackGit(source, "update-ref", "refs/heads/main", merged);
  } else {
    rollbackGit(source, "commit", "-qm", "D mutations disabled");
  }
  const disabledSha = rollbackGit(source, "rev-parse", "HEAD");

  const restoredBytes =
    variant === "restored-byte-diff"
      ? `${baseConfig}# restored formatting difference\n`
      : baseConfig;
  await writeFile(join(source, "config/platform.yaml"), restoredBytes);
  rollbackGit(source, "add", "config/platform.yaml");
  rollbackGit(source, "commit", "-qm", "R config restored");
  const restoredSha = rollbackGit(source, "rev-parse", "HEAD");

  const roots = {};
  for (const [name, sha] of [
    ["candidate", candidateSha],
    ["disabled", disabledSha],
    ["restored", restoredSha],
  ]) {
    const root = join(directory, name);
    execFileSync("git", ["clone", "-q", source, root], { stdio: "ignore" });
    rollbackGit(root, "checkout", "-q", "--detach", sha);
    roots[name] = root;
  }
  if (variant.startsWith("dirty-")) {
    const status = variant.slice("dirty-".length);
    const dirtyFile = join(roots.disabled, "stable.txt");
    if (status === "untracked")
      await writeFile(join(roots.disabled, "untracked.txt"), "dirty\n");
    else {
      await writeFile(dirtyFile, "dirty\n");
      if (status === "staged") rollbackGit(roots.disabled, "add", "stable.txt");
    }
  }
  if (
    variant === "assume-unchanged-config" ||
    variant === "skip-worktree-config"
  ) {
    rollbackGit(
      roots.disabled,
      "update-index",
      variant === "assume-unchanged-config"
        ? "--assume-unchanged"
        : "--skip-worktree",
      "config/platform.yaml",
    );
    await writeFile(
      join(roots.disabled, "config/platform.yaml"),
      disabledConfig.replace(
        "mutationsEnabled: false",
        "mutationsEnabled: true",
      ),
    );
  }
  if (variant === "symlink-config") {
    await rm(join(roots.disabled, "config/platform.yaml"));
    await symlink(
      join(roots.disabled, "stable.txt"),
      join(roots.disabled, "config/platform.yaml"),
    );
  }
  return {
    roots,
    candidateSha,
    disabledSha,
    restoredSha,
    launchIdentity: {
      context: { candidateSha, checkoutDir: roots.candidate },
      candidateRoot: roots.candidate,
    },
  };
}

void test("owner-suite TAP summary rejects empty or omitted integration/recovery results", () => {
  const tap = (tests, pass, fail, cancelled, skipped, todo) =>
    [tests, pass, fail, cancelled, skipped, todo]
      .map(
        (count, index) =>
          `# ${["tests", "pass", "fail", "cancelled", "skipped", "todo"][index]} ${count}`,
      )
      .join("\n");
  const passed = parseTapSummary(tap(2, 2, 0, 0, 0, 0));
  assert.deepEqual(passed, {
    tests: 2,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  assert.equal(tapSummaryPassed(passed), true);
  for (const summary of [
    tap(0, 0, 0, 0, 0, 0),
    tap(1, 0, 0, 0, 1, 0),
    tap(1, 0, 0, 0, 0, 1),
    tap(2, 1, 1, 0, 0, 0),
    tap(1, 0, 0, 1, 0, 0),
    "# pass 1\n# fail 0",
  ]) {
    assert.equal(tapSummaryPassed(parseTapSummary(summary)), false, summary);
  }
});

void test("G18 baseline child changes only the approved parent mutation flag", async (t) => {
  const fixture = await rollbackGitFixture(t);
  const base = await createRollbackBaseline({
    candidateRoot: fixture.roots.disabled,
    candidateSha: fixture.disabledSha,
  });
  t.after(() => rm(base.directory, { recursive: true, force: true }));
  assert.equal(base.lineage.parent.commitSha, fixture.disabledSha);
  assert.equal(base.lineage.baseline.commitSha, base.baselineSha);
  await assert.rejects(
    validateRollbackBaseline({
      parentRoot: fixture.roots.disabled,
      parentSha: fixture.disabledSha,
      baselineRoot: base.baselineRoot,
      baselineSha: "0".repeat(40),
    }),
    /ROLLBACK_CHECKOUT_HEAD_MISMATCH/u,
  );
  await assert.rejects(
    createRollbackBaseline({
      candidateRoot: fixture.roots.candidate,
      candidateSha: fixture.candidateSha,
    }),
    /ROLLBACK_BASELINE_PARENT_FLAG_INVALID/u,
  );
  await writeFile(
    join(base.baselineRoot, "config/platform.yaml"),
    "services: {}\n",
  );
  await assert.rejects(
    validateRollbackBaseline({
      parentRoot: fixture.roots.disabled,
      parentSha: fixture.disabledSha,
      baselineRoot: base.baselineRoot,
      baselineSha: base.baselineSha,
    }),
    /ROLLBACK_CONFIG_WORKTREE_MISMATCH/u,
  );
});

void test("controlled config checkout retains Git objects after borrowed parent cleanup", async (t) => {
  const fixture = await rollbackGitFixture(t);
  const directory = await mkdtemp(join(tmpdir(), "launch-borrowed-parent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, "parent");
  execFileSync(
    "git",
    [
      "clone",
      "--quiet",
      "--shared",
      "--no-hardlinks",
      fixture.roots.disabled,
      parent,
    ],
    { stdio: "ignore" },
  );
  assert.equal(
    (
      await readFile(join(parent, ".git/objects/info/alternates"), "utf8")
    ).trim(),
    join(fixture.roots.disabled, ".git/objects"),
  );
  const child = await createRollbackBaseline({
    candidateRoot: parent,
    candidateSha: fixture.disabledSha,
    parentDirectory: directory,
  });
  await rm(parent, { recursive: true, force: true });
  assert.equal(
    rollbackGit(child.baselineRoot, "show", `${child.baselineSha}:stable.txt`),
    "unchanged",
  );
  assert.equal(
    rollbackGit(
      child.baselineRoot,
      "show",
      `${fixture.disabledSha}:stable.txt`,
    ),
    "unchanged",
  );
  await rm(fixture.roots.disabled, { recursive: true, force: true });
  assert.equal(
    rollbackGit(
      child.baselineRoot,
      "show",
      `${fixture.disabledSha}:config/platform.yaml`,
    ).includes("mutationsEnabled: false"),
    true,
  );
  assert.equal(
    rollbackGit(
      child.baselineRoot,
      "show",
      `${child.baselineSha}:config/platform.yaml`,
    ).includes("mutationsEnabled: true"),
    true,
  );
  assert.equal(
    rollbackGit(child.baselineRoot, "rev-parse", "HEAD^"),
    fixture.disabledSha,
  );
});

void test("G18 validates only a clean config-only B→D→R lineage", async (t) => {
  const good = await rollbackGitFixture(t);
  const receipt = await validateRollbackLineage({
    launchIdentity: good.launchIdentity,
    disabledRoot: good.roots.disabled,
    disabledSha: good.disabledSha,
    restoredRoot: good.roots.restored,
    restoredSha: good.restoredSha,
  });
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.B.commitSha, good.candidateSha);
  assert.equal(receipt.D.commitSha, good.disabledSha);
  assert.deepEqual(receipt.D.parentShas, [good.candidateSha]);
  assert.equal(receipt.R.commitSha, good.restoredSha);
  assert.deepEqual(receipt.R.parentShas, [good.disabledSha]);
  for (const state of [receipt.B, receipt.D, receipt.R]) {
    assert.match(state.treeSha, /^[0-9a-f]{40}$/u);
    assert.match(state.configSha256, /^[0-9a-f]{64}$/u);
  }
  await assert.rejects(
    validateRollbackLineage({
      launchIdentity: good.launchIdentity,
      disabledRoot: good.roots.disabled,
      disabledSha: "0".repeat(40),
      restoredRoot: good.roots.restored,
      restoredSha: good.restoredSha,
    }),
    /ROLLBACK_CHECKOUT_HEAD_MISMATCH/u,
  );
  await assert.rejects(
    validateRollbackLineage({
      launchIdentity: {
        ...good.launchIdentity,
        context: {
          ...good.launchIdentity.context,
          candidateSha: "0".repeat(40),
        },
      },
      disabledRoot: good.roots.disabled,
      disabledSha: good.disabledSha,
      restoredRoot: good.roots.restored,
      restoredSha: good.restoredSha,
    }),
    /ROLLBACK_CHECKOUT_HEAD_MISMATCH/u,
  );

  const rejected = [
    ["wrong-parent", "ROLLBACK_DISABLED_PARENT_INVALID"],
    ["extra-file", "ROLLBACK_NON_CONFIG_TREE_CHANGED"],
    ["extra-config", "ROLLBACK_EXTRA_CONFIG_CHANGE"],
    ["extra-comment", "ROLLBACK_CONFIG_DIFF_NOT_LITERAL_FLAG"],
    ["format-change", "ROLLBACK_CONFIG_DIFF_NOT_LITERAL_FLAG"],
    ["shared-alias", "ROLLBACK_EXTRA_CONFIG_CHANGE"],
    ["merge", "ROLLBACK_DISABLED_PARENT_INVALID"],
    ["mode-change", "ROLLBACK_NON_CONFIG_TREE_CHANGED"],
    ["restored-byte-diff", "ROLLBACK_RESTORED_CONFIG_BYTES_DIFFER"],
    ["dirty-staged", "ROLLBACK_CHECKOUT_DIRTY"],
    ["dirty-unstaged", "ROLLBACK_CHECKOUT_DIRTY"],
    ["dirty-untracked", "ROLLBACK_CHECKOUT_DIRTY"],
    ["assume-unchanged-config", "ROLLBACK_INDEX_FLAGS_SET"],
    ["skip-worktree-config", "ROLLBACK_INDEX_FLAGS_SET"],
    ["symlink-config", "ROLLBACK_CONFIG_WORKTREE_MISMATCH"],
  ];
  for (const [variant, code] of rejected) {
    const fixture = await rollbackGitFixture(t, variant);
    await assert.rejects(
      validateRollbackLineage({
        launchIdentity: fixture.launchIdentity,
        disabledRoot: fixture.roots.disabled,
        disabledSha: fixture.disabledSha,
        restoredRoot: fixture.roots.restored,
        restoredSha: fixture.restoredSha,
      }),
      new RegExp(code),
      variant,
    );
  }
});

void test("G18 creates isolated config commits without changing the B checkout", async (t) => {
  const good = await rollbackGitFixture(t);
  const before = rollbackGit(
    good.roots.candidate,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  const created = await createRollbackCheckouts({
    candidateRoot: good.roots.candidate,
    candidateSha: good.candidateSha,
  });
  t.after(() => rm(created.directory, { recursive: true, force: true }));
  assert.equal(
    rollbackGit(good.roots.candidate, "rev-parse", "HEAD"),
    good.candidateSha,
  );
  assert.equal(
    rollbackGit(
      good.roots.candidate,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ),
    before,
  );
  const receipt = await validateRollbackLineage({
    launchIdentity: good.launchIdentity,
    ...created,
  });
  assert.deepEqual(receipt.D.parentShas, [good.candidateSha]);
  assert.deepEqual(receipt.R.parentShas, [created.disabledSha]);
  const evidenceDir = await mkdtemp(join(tmpdir(), "launch-g18-bundle-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const bundle = await writeRollbackLineageBundle({
    ...created,
    candidateSha: good.candidateSha,
    evidenceDir,
  });
  assert.equal(
    bundle.sha256,
    createHash("sha256")
      .update(await readFile(bundle.path))
      .digest("hex"),
  );
  await rm(created.directory, { recursive: true, force: true });
  rollbackGit(good.roots.candidate, "fetch", bundle.path, "HEAD");
  assert.equal(
    rollbackGit(good.roots.candidate, "rev-parse", "FETCH_HEAD"),
    created.restoredSha,
  );
  assert.equal(
    rollbackGit(good.roots.candidate, "rev-parse", `${created.restoredSha}^`),
    created.disabledSha,
  );
  assert.equal(
    rollbackGit(good.roots.candidate, "rev-parse", `${created.disabledSha}^`),
    good.candidateSha,
  );
  assert.equal(
    createHash("sha256")
      .update(
        execFileSync(
          "git",
          ["show", `${created.disabledSha}:config/platform.yaml`],
          { cwd: good.roots.candidate },
        ),
      )
      .digest("hex"),
    receipt.D.configSha256,
  );
  assert.equal(
    rollbackGit(
      good.roots.candidate,
      "diff",
      "--name-only",
      good.candidateSha,
      created.disabledSha,
    ),
    "config/platform.yaml",
  );
  assert.equal(
    rollbackGit(
      good.roots.candidate,
      "diff",
      good.candidateSha,
      created.restoredSha,
    ),
    "",
  );
});

void test("private candidate normalizes reader modes independently of clone umask", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "launch-candidate-modes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, "checkout");
  await mkdir(join(candidate, "config"), { recursive: true, mode: 0o700 });
  await mkdir(join(candidate, "secrets"), { mode: 0o700 });
  const paths = [
    "config/platform.yaml",
    "config/toolchain-versions.json",
    "pnpm-lock.yaml",
    "secrets/platform.secrets.sops.yaml",
  ];
  for (const path of paths) {
    await writeFile(join(candidate, path), `fixture ${path}\n`);
    await chmod(join(candidate, path), 0o664);
  }
  execFileSync("git", ["init", "--quiet"], { cwd: candidate });
  execFileSync("git", ["add", "--", ...paths], { cwd: candidate });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: candidate },
  );
  const outside = join(root, "outside");
  await writeFile(outside, "untouched", { mode: 0o600 });
  await chmod(outside, 0o600);
  await normalizeCandidateInputModes(candidate);
  for (const path of paths) {
    assert.equal(
      (await stat(join(candidate, path))).mode & 0o777,
      path.startsWith("secrets/") ? 0o400 : 0o644,
    );
    assert.equal(
      await readFile(join(candidate, path), "utf8"),
      `fixture ${path}\n`,
    );
  }
  assert.equal(
    execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: candidate,
      encoding: "utf8",
    }),
    "",
  );
  await unlink(join(candidate, "config/platform.yaml"));
  await symlink(outside, join(candidate, "config/platform.yaml"));
  await assert.rejects(normalizeCandidateInputModes(candidate), /Symlink/u);
  assert.equal((await stat(outside)).mode & 0o777, 0o600);
  assert.equal(await readFile(outside, "utf8"), "untouched");
});

void test("G08 approved target is explicit, private and bound to the current run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "launch-g08-approved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactDir = join(root, "gates/G08_MIGRATIONS/artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const path = join(artifactDir, "approved-target.json");
  const context = {
    runId: "20261029T000000Z-abcdef0",
    candidateSha: "abcdef0" + "1".repeat(33),
    baseConfigSha256: "a".repeat(64),
  };
  const value = {
    schemaVersion: 1,
    ...context,
    systemIdentifier: "7613370342949990434",
  };
  assert.deepEqual(
    parseLaunchArguments([
      "--g08-expected-system-identifier",
      value.systemIdentifier,
    ]),
    { g08ExpectedSystemIdentifier: value.systemIdentifier },
  );
  for (const identifier of [undefined, "", "abc", "1".repeat(21)])
    assert.throws(
      () =>
        parseLaunchArguments([
          "--g08-expected-system-identifier",
          ...(identifier === undefined ? [] : [identifier]),
        ]),
      /system identifier/u,
    );
  await assert.rejects(
    readApprovedMigrationTarget(context, root),
    /APPROVED_TARGET_INVALID/u,
  );
  await writeFile(path, JSON.stringify(value), { mode: 0o400 });
  assert.equal(
    (await readApprovedMigrationTarget(context, root)).systemIdentifier,
    value.systemIdentifier,
  );
  for (const altered of [
    { ...value, runId: "foreign" },
    { ...value, systemIdentifier: "invalid" },
    { ...value, extra: true },
  ]) {
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify(altered));
    await chmod(path, 0o400);
    await assert.rejects(
      readApprovedMigrationTarget(context, root),
      /APPROVED_TARGET_INVALID/u,
    );
  }
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(
    readApprovedMigrationTarget(context, root),
    /APPROVED_TARGET_INVALID/u,
  );
  await rm(path);
  const source = join(root, "outside");
  await writeFile(source, JSON.stringify(value), { mode: 0o400 });
  await symlink(source, path);
  await assert.rejects(
    readApprovedMigrationTarget(context, root),
    /APPROVED_TARGET_INVALID/u,
  );
});

void test("G08 stops before its command when the approved identity is unavailable", async (t) => {
  const root = await mkdtemp(
    join(process.cwd(), "evidence/launch/g08-runner-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const gate = {
    id: "G08_MIGRATIONS",
    command: "pnpm test:migrations:clean && pnpm test:migrations:forward",
    timeout: 1800,
    predecessors: [],
  };
  await mkdir(join(root, "gates", gate.id, "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  const record = {
    id: gate.id,
    status: "NOT_RUN",
    runs: [],
    artifacts: [],
    durationMs: 0,
  };
  await runGate(
    gate,
    record,
    root,
    process.cwd(),
    "/missing",
    [],
    Date.now(),
    { exceeded: false },
    undefined,
  );
  assert.equal(record.status, "FAIL");
  assert.match(record.reason, /system identifier/u);
  assert.deepEqual(record.runs, []);
  await assert.rejects(
    access(
      join(root, "gates", gate.id, "artifacts", "canonical-preparation.json"),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    access(join(root, "gates", gate.id, "artifacts", "approved-target.json")),
    { code: "ENOENT" },
  );
});

void test("G18 accepts only the canonical launch-context Compose project string", () => {
  const context = {
    runId: "20261024T120000Z-1234567",
    resources: { composeProject: "coffee-launch-20261024t120000z-1234567" },
  };
  assert.equal(
    rollbackComposeProjectName(context),
    context.resources.composeProject,
  );
  assert.throws(
    () =>
      rollbackComposeProjectName({
        ...context,
        resources: {
          composeProject: {
            name: context.resources.composeProject,
            created: false,
          },
        },
      }),
    /ROLLBACK_COMPOSE_PROJECT_INVALID/u,
  );
  assert.throws(
    () =>
      rollbackComposeProjectName({
        ...context,
        resources: { composeProject: "coffee-launch-foreign" },
      }),
    /ROLLBACK_COMPOSE_PROJECT_INVALID/u,
  );
});

void test("G18 local provider injects UnknownOutcome only for the first numeric SetQuantity wire", () => {
  assert.equal(
    shouldLoseFirstRollbackSetQuantityResponse(1, { quantity: 1 }),
    true,
  );
  assert.equal(
    shouldLoseFirstRollbackSetQuantityResponse(1, { quantity: "1" }),
    false,
  );
  assert.equal(
    shouldLoseFirstRollbackSetQuantityResponse(2, { quantity: 1 }),
    false,
  );
  assert.equal(
    shouldLoseFirstRollbackSetQuantityResponse(1, { quantity: 2 }),
    false,
  );
});

void test("G18 captures the fixture baseline before delayed runtimes and preserves immutable owner history", () => {
  const baseline = {
    counts: {},
    attempts: [],
    reservations: [],
    gatewayRows: [],
    desired: [
      {
        cart_scope_ref: "aroma-primary",
        desired_revision: "1",
        desired_hash: "a".repeat(64),
        source_max_order_version: "2",
        created_at: "before",
      },
      {
        cart_scope_ref: "aroma-primary",
        desired_revision: "2",
        desired_hash: "c".repeat(64),
        source_max_order_version: "3",
        created_at: "after",
      },
    ],
    observed: [
      {
        cart_scope_ref: "aroma-primary",
        observed_revision: "1",
        provider_snapshot_ref: "snapshot-1",
        cart_fingerprint: "d".repeat(64),
        captured_at: "before",
        saved_at: "before",
        source_kind: "Provider",
        source_attempt_ref: null,
        fence_epoch: "1",
        complete: true,
      },
      {
        cart_scope_ref: "aroma-primary",
        observed_revision: "2",
        provider_snapshot_ref: "snapshot-2",
        cart_fingerprint: "e".repeat(64),
        captured_at: "after",
        saved_at: "after",
        source_kind: "Provider",
        source_attempt_ref: null,
        fence_epoch: "1",
        complete: true,
      },
    ],
    inbox: [
      {
        consumer_name: "aroma-convergence",
        message_id: "message-1",
        message_type: "Fixture.v1",
        partition_key: "one",
        schema_version: 1,
        owner_version: "1",
        payload_hash: "1".repeat(64),
        envelope_hash: "2".repeat(64),
        envelope: {},
        received_at: "before",
      },
      {
        consumer_name: "aroma-convergence",
        message_id: "message-2",
        message_type: "Fixture.v1",
        partition_key: "two",
        schema_version: 1,
        owner_version: "1",
        payload_hash: "3".repeat(64),
        envelope_hash: "4".repeat(64),
        envelope: {},
        received_at: "after",
      },
    ],
    outbox: [
      {
        message_id: "confirmed",
        message_type: "OrderConfirmed.v1",
        envelope_hash: "b".repeat(64),
        state: "Pending",
      },
    ],
    gateway: [],
  };
  assert.equal(assertRollbackFixtureBaseline(baseline), true);
  const current = {
    ...baseline,
    attempts: [{ attempt_ref: "att_new", state: "UnknownOutcome" }],
    desired: baseline.desired.map((row) => ({ ...row, state: "Superseded" })),
    outbox: [
      { ...baseline.outbox[0], state: "Published" },
      {
        message_id: "wake",
        message_type: "AromaConvergenceRequested.v1",
        envelope_hash: "c".repeat(64),
      },
    ],
  };
  assert.equal(assertRollbackHistoryPreserved(baseline, current), true);
  assert.throws(
    () => assertRollbackHistoryPreserved(baseline, { ...current, desired: [] }),
    /history dropped/u,
  );
  assert.throws(
    () =>
      assertRollbackHistoryPreserved(baseline, {
        ...current,
        desired: current.desired.map((row) =>
          row.desired_revision === "1"
            ? { ...row, desired_hash: "d".repeat(64) }
            : row,
        ),
      }),
    /immutable history changed/u,
  );
  for (const collection of ["desired", "observed", "inbox"]) {
    const first = current[collection][0];
    const replacement =
      collection === "desired"
        ? { ...first, desired_revision: "3" }
        : collection === "observed"
          ? { ...first, observed_revision: "3" }
          : { ...first, message_id: "replacement" };
    assert.throws(
      () =>
        assertRollbackHistoryPreserved(baseline, {
          ...current,
          [collection]: [replacement, ...current[collection].slice(1)],
        }),
      /history dropped/u,
      `${collection} replacement must not hide a missing composite key`,
    );
  }
});

void test("G18 requires a structured runtime receipt with verified lineage, phases and cleanup", async (t) => {
  const candidateSha = "1".repeat(40);
  const lineage = {
    B: {
      commitSha: candidateSha,
      parentShas: [],
      treeSha: "8".repeat(40),
      configSha256: "a".repeat(64),
    },
    D: {
      commitSha: "2".repeat(40),
      parentShas: [candidateSha],
      treeSha: "9".repeat(40),
      configSha256: "b".repeat(64),
    },
    R: {
      commitSha: "3".repeat(40),
      parentShas: ["2".repeat(40)],
      treeSha: "0".repeat(40),
      configSha256: "a".repeat(64),
    },
  };
  const artifact = {
    schemaVersion: 1,
    gateId: "G18_ROLLBACK",
    runId: "20261024T120000Z-1234567",
    candidateSha,
    lineage,
    cleanup: {
      complete: true,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
    },
    runtimeProof: {
      schemaVersion: 1,
      candidateSha,
      lineage,
      ownerHttp: {
        unknown: "UnknownOutcome",
        disabled: "Blocked",
        restored: "InSync",
      },
      provider: { kind: "local-fake", liveProviderAcceptance: false },
      runtime: {
        disabledConfig: {
          baseConfigSha256: lineage.B.configSha256,
          actualConfigSha256: lineage.D.configSha256,
          phase: "disabled",
          mutationsEnabled: false,
        },
        restoredConfig: {
          baseConfigSha256: lineage.B.configSha256,
          actualConfigSha256: lineage.R.configSha256,
          phase: "base",
          mutationsEnabled: true,
        },
      },
      orders: {
        oldReservationState: "RecoveredNotApplied",
        oldGatewayState: "UnknownOutcome",
        newReservationState: "Verified",
        oldOperationDigest: "4".repeat(64),
        newOperationDigest: "5".repeat(64),
        historyBeforeDigest: "6".repeat(64),
        historyAfterDigest: "7".repeat(64),
      },
    },
  };
  assert.equal(
    validateRollbackRuntimeArtifact(artifact, {
      runId: artifact.runId,
      candidateSha,
      lineage,
    }),
    true,
  );
  assert.throws(
    () =>
      validateRollbackRuntimeArtifact(
        {
          ...artifact,
          cleanup: { complete: false, retainedResources: ["container"] },
        },
        { runId: artifact.runId, candidateSha, lineage },
      ),
    /ARTIFACT_IDENTITY_INVALID/u,
  );
  assert.throws(
    () =>
      validateRollbackRuntimeArtifact(
        {
          ...artifact,
          runtimeProof: { ...artifact.runtimeProof, provider: undefined },
        },
        { runId: artifact.runId, candidateSha, lineage },
      ),
    /ARTIFACT_PHASE_INVALID/u,
  );
  assert.throws(
    () =>
      validateRollbackRuntimeArtifact(
        {
          ...artifact,
          runtimeProof: {
            ...artifact.runtimeProof,
            runtime: {
              ...artifact.runtimeProof.runtime,
              disabledConfig: {
                ...artifact.runtimeProof.runtime.disabledConfig,
                actualConfigSha256: lineage.B.configSha256,
              },
            },
          },
        },
        { runId: artifact.runId, candidateSha, lineage },
      ),
    /ARTIFACT_PHASE_INVALID/u,
  );
  const evidenceDir = await mkdtemp(join(tmpdir(), "launch-g18-artifact-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const receipt = await writeRollbackRuntimeArtifact({
    artifact,
    identity: { runId: artifact.runId, candidateSha, lineage },
    evidenceDir,
  });
  const written = await readFile(receipt.path);
  assert.equal(
    receipt.path,
    join(
      evidenceDir,
      "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback.json",
    ),
  );
  assert.equal(
    receipt.sha256,
    createHash("sha256").update(written).digest("hex"),
  );
  assert.equal(receipt.sizeBytes, written.length);
  assert.deepEqual(JSON.parse(written.toString("utf8")), artifact);
});

void test("G18 projects only canonical owner databases into the verified launch namespace", async () => {
  const ownership = JSON.parse(
    await readFile(
      new URL("../../../config/database-ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const roleMap = JSON.parse(
    await readFile(
      new URL("../../../config/database-role-map.json", import.meta.url),
      "utf8",
    ),
  );
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T120000Z-1234567",
    candidateSha: `1234567${"8".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  const beforeOwnership = structuredClone(ownership);
  const beforeRoleMap = structuredClone(roleMap);
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity,
  });
  const expectedByOwner = new Map(
    CANONICAL_DATABASE_OWNERS.map((owner) => [
      owner,
      deriveLaunchDatabaseName(launchIdentity, owner),
    ]),
  );
  assert.deepEqual(
    ownership,
    beforeOwnership,
    "G18 database projection must not mutate canonical ownership input",
  );
  assert.deepEqual(
    roleMap,
    beforeRoleMap,
    "G18 database projection must not mutate canonical role-map input",
  );
  assert.deepEqual(
    projected.ownership.databases.map(({ owner, name }) => [owner, name]),
    CANONICAL_DATABASE_OWNERS.map((owner) => [
      owner,
      expectedByOwner.get(owner),
    ]),
  );
  assert.deepEqual(
    projected.roleMap.databases.map(({ name, migratorRole, runtimeRoles }) => ({
      name,
      migratorRole,
      runtimeRoles,
    })),
    beforeRoleMap.databases.map((database) => ({
      name: expectedByOwner.get(
        ownership.databases.find((owner) => owner.name === database.name).owner,
      ),
      migratorRole: database.migratorRole,
      runtimeRoles: database.runtimeRoles,
    })),
  );
  for (const [index, claim] of projected.ownership.runtimeClaims.entries()) {
    const canonicalClaim = ownership.runtimeClaims[index];
    if (canonicalClaim.database === null) {
      assert.equal(claim.database, null);
      continue;
    }
    const owner = ownership.databases.find(
      (database) => database.name === canonicalClaim.database,
    )?.owner;
    assert.equal(
      claim.database,
      expectedByOwner.get(owner),
      `${claim.runtime} projected outside its canonical owner target`,
    );
  }
  assert.deepEqual(
    validateRoleMap(projected.roleMap, projected.ownership, { launchIdentity }),
    {
      databaseCount: 5,
      migratorRoleCount: 5,
      runtimeRoleCount: 10,
    },
  );
  assert.throws(
    () => validateRoleMap(projected.roleMap, projected.ownership),
    /ownership database differs from the approved namespace/u,
    "derived names must remain unavailable to canonical-only bootstrap callers",
  );
});

void test("all native recovery and AROMA DB clients use the same owned target with and without launch context", async () => {
  const config = parseYaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
    { json: true },
  );
  const ownership = JSON.parse(
    await readFile(
      new URL("../../../config/database-ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const roleMap = JSON.parse(
    await readFile(
      new URL("../../../config/database-role-map.json", import.meta.url),
      "utf8",
    ),
  );
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T120000Z-1234567",
    candidateSha: `1234567${"8".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity,
  });
  const isolatedConfig = projectRecoveryPlatformConfig(
    config,
    projected.ownership,
  );
  const ordersDatabase = deriveLaunchDatabaseName(launchIdentity, "orders");
  const integration = deriveLaunchDatabaseName(launchIdentity, "integration");
  const ordinaryOrdersService = databaseProofService(
    config,
    ownership,
    "orders-service",
  );
  const isolatedOrdersService = databaseProofService(
    isolatedConfig,
    projected.ownership,
    "orders-service",
  );
  const ordinaryGatewayService = databaseProofService(
    config,
    ownership,
    "aroma-gateway",
  );
  const isolatedGatewayService = databaseProofService(
    isolatedConfig,
    projected.ownership,
    "aroma-gateway",
  );
  assert.equal(ordinaryOrdersService.database, "coffee_platform_orders");
  assert.equal(isolatedOrdersService.database, ordersDatabase);
  assert.equal(ordinaryGatewayService.database, "coffee_platform_integration");
  assert.equal(isolatedGatewayService.database, integration);
  assert.equal(
    proofDatabaseOptions("orders-service", isolatedOrdersService, 5432, {
      username: "fixture",
      password: "fixture",
    }).allowedDatabase,
    ordersDatabase,
  );

  assert.throws(
    () => databaseProofService(config, projected.ownership, "orders-service"),
    /does not use its owned database target/u,
    "a canonical Orders config must not silently pair with projected recovery ownership",
  );
  assert.throws(
    () => databaseProofService(config, projected.ownership, "aroma-gateway"),
    /does not use its owned database target/u,
    "canonical AROMA fixture config must not silently pair with projected ownership",
  );

  const fixture = {
    lifecycleTopic: "orders-lifecycle",
    mappingTopic: "catalog-mapping",
    malformed: "fixture-malformed",
    malformedEnvelope: { messageId: "fixture-malformed" },
  };
  const foundation = nativeFoundationSource({
    runId: "fixture-run",
    ...fixture,
    ordersDatabase: isolatedOrdersService.database,
  });
  const blackhole = nativeKafkaBlackholeSource({
    runId: "fixture-run",
    mappingTopic: fixture.mappingTopic,
    ordersDatabase: isolatedOrdersService.database,
  });
  for (const source of [foundation, blackhole]) {
    assert.ok(
      source.includes(
        `const ordersDatabaseTarget = ${JSON.stringify(ordersDatabase)}`,
      ),
    );
    assert.match(
      source,
      /database: ordersService\.database,\s*allowedDatabase: ordersService\.database/u,
    );
    assert.match(
      source,
      /const ordersService = \{\.\.\.config\.services\['orders-service'\], database: ordersDatabaseTarget\}/u,
    );
  }
  for (const service of [isolatedGatewayService]) {
    assert.equal(
      service.database,
      integration,
      "binding/cart migrators, seeders, readers and journal queries must use the projected integration owner DB",
    );
  }
});

void test("isolated owner proofs target the derived customer database across bootstrap and runtime config", async () => {
  const config = parseYaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
    { json: true },
  );
  const validatedRun = {
    candidateRoot: "/tmp/validated-candidate",
    context: {
      schemaVersion: 1,
      runId: "20261024T120000Z-1234567",
      candidateSha: `1234567${"8".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
      resources: {
        composeProject: "coffee-proof-20261024t120000z-1234567",
        kafkaPrefix: "proof-20261024t120000z-1234567",
      },
    },
  };
  const identity = kafkaNamespaceLaunchIdentity(
    {
      ...config,
      verification: {
        ...config.verification,
        kafkaNamespaceIsolation: true,
      },
    },
    validatedRun,
  );
  const customer = await readDatabaseProofCredentials(identity);
  const recovery = await readRecoveryProofCredentials(identity);
  assert.deepEqual(recovery.launchIdentity, identity);
  assert.deepEqual(Object.keys(recovery.launchIdentity).sort(), [
    "baseConfigSha256",
    "candidateSha",
    "runId",
    "schemaVersion",
  ]);
  const recoveryConfig = projectRecoveryPlatformConfig(
    config,
    recovery.ownership,
  );
  const customerDatabase = deriveLaunchDatabaseName(identity, "customer");
  assert.equal(customer.databaseName, customerDatabase);
  assert.equal(customer.owner.username, "coffee_customer_rw");
  assert.equal(
    recovery.ownership.runtimeClaims.find(
      (claim) => claim.runtime === "customer-service",
    ).database,
    customerDatabase,
  );
  assert.equal(
    recoveryConfig.services["customer-service"].database,
    customerDatabase,
  );
  assert.equal(
    recovery.roleMap.databases.find(
      (database) => database.name === customerDatabase,
    ).name,
    customerDatabase,
  );
  for (const claim of recovery.ownership.runtimeClaims.filter(
    (claim) => claim.database !== null,
  )) {
    assert.equal(
      recoveryConfig.services[claim.runtime].database,
      claim.database,
      `${claim.runtime} must use its projected owner database`,
    );
  }
});

void test("trusted bootstrap environment excludes launch context and inherited database credentials", () => {
  const env = bootstrapEnvironment("/tmp/scoped-runtime-secrets.yaml", {
    PATH: "/bin",
    COFFEE_LAUNCH_CONTEXT_FILE: "/tmp/context.json",
    COFFEE_DB_ADMIN_URL: "postgresql://must-not-forward",
    COFFEE_RUNTIME_SECRETS_FILE: "/tmp/foreign-secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age-key",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    COFFEE_CONFIG_FILE: join(process.cwd(), "config/platform.yaml"),
    COFFEE_RUNTIME_SECRETS_FILE: "/tmp/scoped-runtime-secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age-key",
  });
});

void test("G18 B, D and R overrides bind the identical launch context and project-scoped nginx image", async (t) => {
  const contextPath = "/tmp/coffee-launch-context-proof.json";
  const projectName = "coffee-launch-proof-20261024t120000z-1234567";
  const configs = [
    undefined,
    "/tmp/disabled-checkout/config/platform.yaml",
    "/tmp/restored-checkout/config/platform.yaml",
  ];
  const paths = [];
  t.after(async () =>
    Promise.all(paths.map((path) => rm(path, { force: true }))),
  );
  for (const [index, configPath] of configs.entries()) {
    const options = rollbackRuntimeComposeOptions(
      projectName,
      contextPath,
      configPath,
    );
    const overridePath = await writeScopedComposeOverride(projectName, options);
    paths.push(overridePath);
    const source = await readFile(overridePath, "utf8");
    assert.equal(
      (
        source.match(
          /COFFEE_LAUNCH_CONTEXT_FILE: \/run\/coffee-launch\/context\.json/gu,
        ) ?? []
      ).length,
      14,
    );
    assert.equal(
      (source.match(/source: \/tmp\/coffee-launch-context-proof\.json/gu) ?? [])
        .length,
      14,
    );
    assert.match(
      source,
      new RegExp(`image: ${projectName}-edge-nginx:latest`, "u"),
    );
    if (index === 0)
      assert.doesNotMatch(
        source,
        /source: \/tmp\/(?:disabled|restored)-checkout\/config\/platform\.yaml/u,
      );
    else
      assert.match(
        source,
        new RegExp(`source: ${configPath.replaceAll("/", "\\/")}`, "u"),
      );
  }
});

void test("G18 runtime config proof resolves js-yaml from the deployed runtime package", async (t) => {
  const flatRoot = await mkdtemp(join(tmpdir(), "g18-flat-runtime-layout-"));
  t.after(() => rm(flatRoot, { recursive: true, force: true }));
  const runtimeRoot = join(flatRoot, "node_modules/@coffee-platform/runtime");
  const yamlRoot = join(runtimeRoot, "node_modules/js-yaml");
  const configPath = join(flatRoot, "config/platform.yaml");
  const configBytes = Buffer.from(
    '{"services":{"aroma-convergence":{"mutationsEnabled":false}}}\n',
  );
  await mkdir(yamlRoot, { recursive: true });
  await mkdir(join(flatRoot, "config"), { recursive: true });
  await writeFile(join(flatRoot, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(runtimeRoot, "package.json"),
    '{"name":"@coffee-platform/runtime","main":"index.js"}\n',
  );
  await writeFile(join(runtimeRoot, "index.js"), "export {};\n");
  await writeFile(
    join(yamlRoot, "package.json"),
    '{"name":"js-yaml","type":"module","exports":"./index.js"}\n',
  );
  await writeFile(
    join(yamlRoot, "index.js"),
    "export const load = (text) => JSON.parse(text);\n",
  );
  await writeFile(configPath, configBytes);
  await assert.rejects(access(join(flatRoot, "node_modules/js-yaml")), {
    code: "ENOENT",
  });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      rollbackRuntimeConfigProofSource(join(flatRoot, "package.json")),
    ],
    {
      cwd: flatRoot,
      encoding: "utf8",
      timeout: 5_000,
      env: { PATH: process.env.PATH, COFFEE_CONFIG_FILE: configPath },
    },
  );
  assert.deepEqual(JSON.parse(output), {
    sha256: createHash("sha256").update(configBytes).digest("hex"),
    mutationsEnabled: false,
  });
});

void test("G18 persists only sanitized child failure JSON and fails closed on missing receipt", async (t) => {
  const good = await rollbackGitFixture(t);
  const lineage = await validateRollbackLineage({
    launchIdentity: good.launchIdentity,
    disabledRoot: good.roots.disabled,
    disabledSha: good.disabledSha,
    restoredRoot: good.roots.restored,
    restoredSha: good.restoredSha,
  });
  const evidenceDir = await mkdtemp(
    join(tmpdir(), "launch-g18-failure-artifact-"),
  );
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const identity = {
    runId: `20261024T120000Z-${good.candidateSha.slice(0, 7)}`,
    candidateSha: good.candidateSha,
  };
  const cleanup = {
    verified: true,
    complete: true,
    failures: [],
    retainedResources: [],
    inventory: { containers: [], volumes: [], networks: [] },
  };
  const rawCanary = "provider-secret-canary-must-not-persist";
  const payload = createRollbackFailureReceipt({
    ...identity,
    stage: "initial-unknown",
    error: Object.assign(new Error(rawCanary), { name: "AssertionError" }),
    cleanup,
  });
  assert.equal(JSON.stringify(payload).includes(rawCanary), false);
  const source = `console.log(${JSON.stringify(JSON.stringify(payload))});console.error(${JSON.stringify(rawCanary)});process.exitCode=1;`;
  const error = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", source],
    cwd: process.cwd(),
    env: process.env,
  }).catch((cause) => cause);
  assert.ok(error instanceof Error);
  assert.equal(error.result.joined, true);
  const persisted = await persistRollbackFailureFromChild({
    error,
    identity,
    lineage,
    evidenceDir,
  });
  const failureBytes = await readFile(persisted.receipt.path);
  assert.equal(
    persisted.receipt.sha256,
    createHash("sha256").update(failureBytes).digest("hex"),
  );
  assert.equal(persisted.receipt.sizeBytes, failureBytes.length);
  assert.equal(failureBytes.includes(rawCanary), false);
  assert.equal(JSON.parse(failureBytes.toString()).stage, "initial-unknown");
  assert.deepEqual(JSON.parse(failureBytes.toString()).lineage, lineage);

  const invalidEvidence = await mkdtemp(
    join(tmpdir(), "launch-g18-invalid-failure-"),
  );
  t.after(() => rm(invalidEvidence, { recursive: true, force: true }));
  const invalidSource = `console.log(${JSON.stringify(rawCanary)});console.error(${JSON.stringify(rawCanary)});process.exitCode=1;`;
  const invalidError = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", invalidSource],
    cwd: process.cwd(),
    env: process.env,
  }).catch((cause) => cause);
  assert.ok(invalidError instanceof Error);
  const invalid = await persistRollbackFailureFromChild({
    error: invalidError,
    identity,
    lineage,
    evidenceDir: invalidEvidence,
  });
  const invalidBytes = await readFile(invalid.receipt.path);
  const invalidArtifact = JSON.parse(invalidBytes.toString());
  assert.equal(invalidArtifact.code, "ROLLBACK_FAILURE_RECEIPT_INVALID");
  assert.equal(invalidArtifact.stage, "child-process");
  assert.equal(invalidArtifact.cleanup.verified, false);
  assert.equal(invalidBytes.includes(rawCanary), false);

  const disabledReceipt = createRollbackFailureReceipt({
    ...identity,
    stage: "disabled-reconcile",
    error: new Error("G18_PHASE_FAILED"),
    cleanup,
  });
  const disabledPayload = attachRollbackDisabledReconcileSubstage(
    disabledReceipt,
    "config-attestation",
  );
  assert.ok(
    ROLLBACK_DISABLED_RECONCILE_SUBSTAGES.includes(
      disabledPayload.disabledReconcileSubstage,
    ),
  );
  assert.throws(
    () =>
      validateRollbackFailureArtifact(
        {
          ...disabledPayload,
          stage: "initial-unknown",
          lineage,
        },
        { ...identity, lineage },
      ),
    /ROLLBACK_FAILURE_ARTIFACT_INVALID/u,
  );
  assert.throws(
    () =>
      attachRollbackDisabledReconcileSubstage(
        disabledReceipt,
        "arbitrary-payload",
      ),
    /SUBSTAGE_INVALID/u,
  );
  const disabledEvidence = await mkdtemp(
    join(tmpdir(), "launch-g18-disabled-failure-"),
  );
  t.after(() => rm(disabledEvidence, { recursive: true, force: true }));
  const disabledSource = `console.log(${JSON.stringify(JSON.stringify(disabledPayload))});process.exitCode=1;`;
  const disabledError = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", disabledSource],
    cwd: process.cwd(),
    env: process.env,
  }).catch((cause) => cause);
  const disabledPersisted = await persistRollbackFailureFromChild({
    error: disabledError,
    identity,
    lineage,
    evidenceDir: disabledEvidence,
  });
  const disabledArtifact = JSON.parse(
    (await readFile(disabledPersisted.receipt.path)).toString(),
  );
  assert.equal(disabledArtifact.stage, "disabled-reconcile");
  assert.equal(
    disabledArtifact.disabledReconcileSubstage,
    "config-attestation",
  );

  const invalidSubstageEvidence = await mkdtemp(
    join(tmpdir(), "launch-g18-invalid-disabled-substage-"),
  );
  t.after(() => rm(invalidSubstageEvidence, { recursive: true, force: true }));
  const invalidSubstagePayload = {
    ...disabledPayload,
    disabledReconcileSubstage: "untrusted-detail",
  };
  const invalidSubstageSource = `console.log(${JSON.stringify(JSON.stringify(invalidSubstagePayload))});process.exitCode=1;`;
  const invalidSubstageError = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", invalidSubstageSource],
    cwd: process.cwd(),
    env: process.env,
  }).catch((cause) => cause);
  const invalidSubstagePersisted = await persistRollbackFailureFromChild({
    error: invalidSubstageError,
    identity,
    lineage,
    evidenceDir: invalidSubstageEvidence,
  });
  const invalidSubstageArtifact = JSON.parse(
    (await readFile(invalidSubstagePersisted.receipt.path)).toString(),
  );
  assert.equal(
    invalidSubstageArtifact.code,
    "ROLLBACK_FAILURE_RECEIPT_INVALID",
  );
  assert.equal(invalidSubstageArtifact.stage, "child-process");
  assert.equal(
    Object.hasOwn(invalidSubstageArtifact, "disabledReconcileSubstage"),
    false,
  );

  const wrongStageEvidence = await mkdtemp(
    join(tmpdir(), "launch-g18-wrong-disabled-stage-"),
  );
  t.after(() => rm(wrongStageEvidence, { recursive: true, force: true }));
  const wrongStagePayload = {
    ...disabledPayload,
    stage: "initial-unknown",
  };
  const wrongStageSource = `console.log(${JSON.stringify(JSON.stringify(wrongStagePayload))});process.exitCode=1;`;
  const wrongStageError = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", wrongStageSource],
    cwd: process.cwd(),
    env: process.env,
  }).catch((cause) => cause);
  const wrongStagePersisted = await persistRollbackFailureFromChild({
    error: wrongStageError,
    identity,
    lineage,
    evidenceDir: wrongStageEvidence,
  });
  const wrongStageArtifact = JSON.parse(
    (await readFile(wrongStagePersisted.receipt.path)).toString(),
  );
  assert.equal(wrongStageArtifact.code, "ROLLBACK_FAILURE_RECEIPT_INVALID");
  assert.equal(wrongStageArtifact.stage, "child-process");
  assert.equal(
    Object.hasOwn(wrongStageArtifact, "disabledReconcileSubstage"),
    false,
  );
});

void test("G18 joins SIGTERM cleanup and timed-out child processes before caller cleanup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-g18-child-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const readPublished = async (path, label) => {
    const deadline = Date.now() + 20_000;
    let published;
    while (published === undefined) {
      try {
        published = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        if (Date.now() >= deadline) assert.fail(label);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return published;
  };
  const ready = join(directory, "ready.json");
  const readyTemporary = `${ready}.tmp`;
  const finished = join(directory, "finished.json");
  const finishedTemporary = `${finished}.tmp`;
  const childSource = `import {renameSync, writeFileSync} from 'node:fs';
process.once('SIGTERM', async () => {
  await new Promise((resolve) => setTimeout(resolve, 40));
  writeFileSync(${JSON.stringify(finishedTemporary)}, JSON.stringify({pid:process.pid,finished:true}));
  renameSync(${JSON.stringify(finishedTemporary)}, ${JSON.stringify(finished)});
  process.exit(0);
});
writeFileSync(${JSON.stringify(readyTemporary)}, JSON.stringify({pid:process.pid}));
renameSync(${JSON.stringify(readyTemporary)}, ${JSON.stringify(ready)});
setInterval(() => {}, 1000);`;
  const helperUrl = new URL("./scenarios/rollback.mjs", import.meta.url).href;
  const controllerSource = `import {runManagedRollbackChild} from ${JSON.stringify(helperUrl)};
try { await runManagedRollbackChild({args:['--input-type=module','-e',${JSON.stringify(childSource)}],cwd:${JSON.stringify(directory)},env:process.env,timeoutMs:120000}); }
catch(error) { console.log(JSON.stringify({joined:error.result?.joined===true,code:error.message})); }`;
  const controller = spawn(
    process.execPath,
    ["--input-type=module", "-e", controllerSource],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let controllerOutput = "";
  controller.stdout.setEncoding("utf8");
  controller.stdout.on("data", (chunk) => {
    controllerOutput += chunk;
  });
  const controllerClosed = new Promise((resolve, reject) => {
    controller.once("error", reject);
    controller.once("close", (code, signal) => resolve({ code, signal }));
  });
  const readyProcess = JSON.parse(
    await readPublished(ready, "G18 stub child did not start before signal"),
  );
  assert.equal(process.kill(readyProcess.pid, 0), true);
  controller.kill("SIGTERM");
  const closed = await controllerClosed;
  assert.deepEqual(closed, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(controllerOutput.trim()), {
    joined: true,
    code: "ROLLBACK_CHILD_INTERRUPTED_SIGTERM",
  });
  const finishedProcess = JSON.parse(await readFile(finished, "utf8"));
  assert.equal(finishedProcess.pid, readyProcess.pid);
  assert.equal(finishedProcess.finished, true);
  assert.throws(() => process.kill(readyProcess.pid, 0), { code: "ESRCH" });

  let releaseTimeout;
  let abandonTimeout;
  const timeoutGate = new Promise((resolve, reject) => {
    releaseTimeout = resolve;
    abandonTimeout = reject;
  });
  const timeoutReady = join(directory, "timeout-ready.json");
  const timeoutTemporary = `${timeoutReady}.tmp`;
  const timeoutSource = `import {renameSync, writeFileSync} from 'node:fs';
process.once('SIGTERM', async () => { await new Promise(resolve => setTimeout(resolve, 40)); process.exit(0); });
writeFileSync(${JSON.stringify(timeoutTemporary)}, JSON.stringify({pid:process.pid}));
renameSync(${JSON.stringify(timeoutTemporary)}, ${JSON.stringify(timeoutReady)});
setInterval(() => {}, 1000);`;
  const timedOut = runManagedRollbackChild({
    args: ["--input-type=module", "-e", timeoutSource],
    cwd: directory,
    env: process.env,
    timeoutMs: 100,
    terminationGraceMs: 1000,
    timeoutGate,
  });
  let released = false;
  try {
    const timeoutProcess = JSON.parse(
      await readPublished(
        timeoutReady,
        "G18 timeout child did not publish readiness",
      ),
    );
    assert.equal(process.kill(timeoutProcess.pid, 0), true);
    releaseTimeout();
    released = true;
    await assert.rejects(
      timedOut,
      (error) =>
        error.message === "ROLLBACK_CHILD_TIMEOUT" &&
        error.result?.joined === true,
    );
    assert.throws(() => process.kill(timeoutProcess.pid, 0), { code: "ESRCH" });
  } finally {
    if (!released) {
      abandonTimeout(new Error("G18 timeout child was not armed"));
      await timedOut.catch(() => {});
    }
  }
});

void test("managed G14 child IPC joins ordered stages without exposing producer token", async () => {
  const token = "private-ipc-producer-token";
  const source = `const request=(stage,payload)=>new Promise((resolve,reject)=>{process.once('message',m=>m.ok&&m.stage===stage?resolve(m.payload):reject(Error('rejected')));process.send({stage,payload});});
try { const init=await request('init',null); if(typeof init.token!=='string'||!init.token||JSON.stringify([process.argv,process.env]).includes(init.token))throw Error('token privacy'); await request('roles-ready',null); await request('browser-proof',null); await request('cleanup',null); process.disconnect(); console.log('done'); } catch { try { await request('cleanup',null); } catch {} process.disconnect(); process.exitCode=1; }`;
  const stages = [];
  const result = await runManagedRollbackChild({
    args: ["--input-type=module", "-e", source],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    onIpc: async ({ stage }) => {
      stages.push(stage);
      return stage === "init" ? { token } : null;
    },
  });
  assert.deepEqual(stages, ["init", "roles-ready", "browser-proof", "cleanup"]);
  assert.equal(result.stdout.trim(), "done");
  assert.equal(JSON.stringify(result).includes(token), false);
  const failures = [];
  await assert.rejects(
    runManagedRollbackChild({
      args: ["--input-type=module", "-e", source],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
      onIpc: async ({ stage }) => {
        failures.push(stage);
        if (stage === "roles-ready") throw Error("private failure");
        return stage === "init" ? { token } : null;
      },
    }),
    (error) =>
      error.message === "ROLLBACK_CHILD_IPC_FAILED" &&
      !JSON.stringify(error.result).includes(token),
  );
  assert.deepEqual(failures, ["init", "roles-ready", "cleanup"]);
  await assert.rejects(
    runManagedRollbackChild({
      args: ["--input-type=module", "-e", "process.disconnect()"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 5000,
      onIpc: async () => null,
    }),
    (error) =>
      error.message === "ROLLBACK_CHILD_IPC_FAILED" && error.result.joined,
  );
  await assert.rejects(
    runManagedRollbackChild({
      args: [
        "--input-type=module",
        "-e",
        "process.send({stage:'init'});setInterval(()=>{},1000)",
      ],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 100,
      terminationGraceMs: 500,
      onIpc: async () => null,
    }),
    (error) =>
      error.message === "ROLLBACK_CHILD_TIMEOUT" && error.result.joined,
  );
});

async function aromaApprovalFixture(overrides = {}) {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const runId = `20261023T120000Z-${sha.slice(0, 7)}`;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const approval = {
    schemaVersion: 1,
    runId,
    candidateSha: sha,
    mode: "controlled-live-existing-account",
    exceptionAuthority: "user-2026-10-23",
    origin: "https://aroma-sandbox.example",
    accountFingerprint: `sha256:${"a".repeat(64)}`,
    issuedAtUtc: "2026-10-23T11:30:00.000Z",
    expiresAtUtc: "2026-10-23T13:30:00.000Z",
    approver: "release-owner",
    keyId: "test-ed25519",
    offerRef: `off_${"0".repeat(26)}`,
    maximumQuantity: "2",
  };
  Object.assign(approval, overrides.approval);
  const bytes = Buffer.from(JSON.stringify(approval));
  const signature = sign(null, bytes, privateKey).toString("base64");
  const policy = {
    mode: "controlled-live-existing-account",
    origin: "https://aroma-sandbox.example",
    accountFingerprint: `sha256:${"a".repeat(64)}`,
    credentialRefs: ["aroma.email", "aroma.password"],
    existingAccountException: {
      authority: "user-2026-10-23",
      origin: "https://aroma-sandbox.example",
      accountFingerprint: `sha256:${"a".repeat(64)}`,
    },
    productionOrigins: ["https://aromateacoffee.ru"],
    productionAccountFingerprints: [`sha256:${"b".repeat(64)}`],
    trustedApprovers: [
      {
        keyId: "test-ed25519",
        approver: "release-owner",
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
      },
    ],
  };
  Object.assign(policy, overrides.policy);
  const identity = {
    environment: "development",
    credentialsAvailable: true,
    context: { runId, candidateSha: sha },
  };
  Object.assign(identity, overrides.identity);
  const encryptedSecrets = {
    environments: {
      development: {
        aroma: {
          email: "ENC[AES256_GCM,data:a,iv:b,tag:c,type:str]",
          password: "ENC[AES256_GCM,data:d,iv:e,tag:f,type:str]",
        },
      },
    },
  };
  return {
    approval,
    bytes,
    signature,
    privateKey,
    policy,
    identity,
    encryptedSecrets,
    now,
    validateApproval: (await loadAdmissionContract(process.cwd()))
      .validateApproval,
  };
}

function assertAdmissionCode(fixture, code, changes = {}) {
  assert.throws(
    () =>
      validateAdmission({
        approvalBytes: fixture.bytes,
        signatureBase64: fixture.signature,
        policy: fixture.policy,
        identity: fixture.identity,
        encryptedSecrets: fixture.encryptedSecrets,
        now: fixture.now,
        validateApproval: fixture.validateApproval,
        ...changes,
      }),
    (error) => error instanceof AdmissionError && error.code === code,
  );
}

void test("matrix keeps all mandatory launch gates, exact order, commands and timeout classes", async () => {
  const { gates } = await loadMatrix();
  assert.equal(gates.length, 20);
  assert.ok(gates.every((gate) => gate.mandatory === true));
  assert.deepEqual(
    gates.map(({ id, command, timeout }) => [id, command, timeout]),
    EXPECTED_GATES,
  );
  const matrixSchema = JSON.parse(
    await readFile(
      new URL("./schemas/matrix.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const resultSchema = JSON.parse(
    await readFile(
      new URL("./schemas/run-result.schema.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [id, command, timeout] of EXPECTED_GATES) {
    assert.equal(matrixSchema.$defs[id].allOf[1].properties.id.const, id);
    assert.equal(
      matrixSchema.$defs[id].allOf[1].properties.command.const,
      command,
    );
    assert.equal(
      matrixSchema.$defs[id].allOf[1].properties.timeout.const,
      timeout,
    );
    assert.equal(resultSchema.$defs[id].allOf[1].properties.id.const, id);
    assert.equal(
      resultSchema.$defs[id].allOf[1].properties.expectedCommand.const,
      command,
    );
    assert.equal(
      resultSchema.$defs[id].allOf[1].properties.timeoutSeconds.const,
      timeout,
    );
  }
  assert.deepEqual(
    gates.map((gate) => gate.id),
    [
      "G00_PREFLIGHT",
      "G01_INSTALL",
      "G02_GENERATED",
      "G03_STATIC",
      "G04_UNIT",
      "G05_CONTRACTS",
      "G06_ARCHITECTURE",
      "G07_CONFIG_SECURITY",
      "G12_SUPPLY_CHAIN",
      "G08_MIGRATIONS",
      "G09_DB_BOUNDARIES",
      "G10_INTEGRATION",
      "G11_RECOVERY",
      "G13_COMPOSE",
      "G14_OBSERVABILITY",
      "G15_BROWSER",
      "G16_AROMA_SANDBOX",
      "G17_BACKUP_RESTORE",
      "G18_ROLLBACK",
      "G19_REPORT",
    ],
  );
  const expectedIds = gates.map((gate) => gate.id);
  for (const schema of [matrixSchema, resultSchema]) {
    assert.deepEqual(
      schema.properties.gates.prefixItems.map((item) =>
        item.$ref.split("/").at(-1),
      ),
      expectedIds,
    );
  }
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const positions = new Map(expectedIds.map((id, index) => [id, index]));
  for (const gate of gates) {
    assert.ok(
      gate.predecessors.every(
        (predecessor) => positions.get(predecessor) < positions.get(gate.id),
      ),
      `${gate.id} predecessors must precede it`,
    );
  }
  assert.deepEqual(byId.get("G12_SUPPLY_CHAIN").predecessors, [
    "G07_CONFIG_SECURITY",
  ]);
  assert.deepEqual(byId.get("G10_INTEGRATION").predecessors, [
    "G09_DB_BOUNDARIES",
    "G12_SUPPLY_CHAIN",
  ]);
  assert.deepEqual(byId.get("G13_COMPOSE").predecessors, [
    "G11_RECOVERY",
    "G12_SUPPLY_CHAIN",
  ]);
  const statusesAfterFailure = (failedId, candidateGates = gates) => {
    const statuses = new Map();
    for (const gate of candidateGates) {
      if (gate.id === failedId) {
        statuses.set(gate.id, "FAIL");
        continue;
      }
      if (gate.predecessors.some((id) => statuses.get(id) !== "PASS")) {
        statuses.set(gate.id, "NOT_RUN");
      } else {
        statuses.set(gate.id, "PASS");
      }
    }
    return statuses;
  };
  const assertSupplyChainBlocksConsumers = (candidateGates) => {
    const statuses = statusesAfterFailure("G12_SUPPLY_CHAIN", candidateGates);
    assert.equal(statuses.get("G08_MIGRATIONS"), "PASS");
    assert.equal(statuses.get("G09_DB_BOUNDARIES"), "PASS");
    for (const id of ["G10_INTEGRATION", "G11_RECOVERY", "G13_COMPOSE"]) {
      assert.equal(statuses.get(id), "NOT_RUN");
    }
    return statuses;
  };
  assertSupplyChainBlocksConsumers(gates);
  const withoutSupplyChainIntegrationEdge = gates.map((gate) =>
    gate.id === "G10_INTEGRATION"
      ? {
          ...gate,
          predecessors: gate.predecessors.filter(
            (predecessor) => predecessor !== "G12_SUPPLY_CHAIN",
          ),
        }
      : gate,
  );
  assert.throws(
    () => assertSupplyChainBlocksConsumers(withoutSupplyChainIntegrationEdge),
    assert.AssertionError,
  );
  const afterRecoveryFailure = statusesAfterFailure("G11_RECOVERY");
  assert.equal(afterRecoveryFailure.get("G13_COMPOSE"), "NOT_RUN");
  assert.deepEqual(
    [...byId.get("G19_REPORT").predecessors].sort((left, right) =>
      left.localeCompare(right),
    ),
    expectedIds.slice(0, -1).sort((left, right) => left.localeCompare(right)),
  );
  assert.equal(
    gates[3].command,
    "pnpm format:check && pnpm lint && pnpm typecheck",
  );
  assert.deepEqual(
    gates.slice(0, 8).map((gate) => gate.timeout),
    Array(8).fill(900),
  );
  assert.deepEqual(
    gates.slice(8, 18).map((gate) => gate.timeout),
    Array(10).fill(1800),
  );
  assert.deepEqual(splitCommand(gates[3].command), [
    ["pnpm", "format:check"],
    ["pnpm", "lint"],
    ["pnpm", "typecheck"],
  ]);
});

void test("G09 accepts only exact context-bound 10/40 runtime database evidence", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "launch-g09-offline-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const runId = "20261025T120000Z-1234567";
  const candidateSha = "1".repeat(40);
  const configBytes = await readFile(
    new URL("../../../config/platform.yaml", import.meta.url),
  );
  const baseConfigSha256 = createHash("sha256")
    .update(configBytes)
    .digest("hex");
  await writeFile(
    join(evidenceDir, "context.json"),
    JSON.stringify({
      runId,
      candidateSha,
      baseConfigSha256,
    }),
  );
  const gate = { id: "G09_DB_BOUNDARIES", command: "pnpm db:smoke" };
  const record = {
    runs: [
      {
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
      },
    ],
    artifacts: [],
  };
  const artifactDir = join(evidenceDir, "gates/G09_DB_BOUNDARIES/artifacts");
  await mkdir(artifactDir, { recursive: true });
  const roleMap = JSON.parse(
    await readFile(
      new URL("../../../config/database-role-map.json", import.meta.url),
      "utf8",
    ),
  );
  const ownership = JSON.parse(
    await readFile(
      new URL("../../../config/database-ownership.json", import.meta.url),
      "utf8",
    ),
  );
  const owners = ownership.databases
    .map(({ owner }) => owner)
    .sort((left, right) => left.localeCompare(right));
  const databaseByOwner = Object.fromEntries(
    owners.map((owner) => [
      owner,
      `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`,
    ]),
  );
  const migrationOwners = owners.map((owner) => ({
    owner,
    database: databaseByOwner[owner],
    migrationCount: {
      catalog: 12,
      customer: 3,
      integration: 7,
      orders: 24,
      pricing: 5,
    }[owner],
    prefixCount: {
      catalog: 8,
      customer: 2,
      integration: 7,
      orders: 6,
      pricing: 4,
    }[owner],
    ledgerSha256: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    aclFingerprint: "d".repeat(64),
  }));
  const systemIdentifier = "7613370342949990434";
  const preparation = {
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256,
    preparation: { candidateSha, bundle: { resultingSha256: "a".repeat(64) } },
  };
  const preparationBytes = Buffer.from(JSON.stringify(preparation));
  const preparationSha256 = createHash("sha256")
    .update(preparationBytes)
    .digest("hex");
  const migrationReceipt = {
    schemaVersion: 1,
    status: "PASS",
    stage: "forward",
    runId,
    candidateSha,
    baseConfigSha256,
    preparationSha256,
    systemIdentifier,
    acceptedPrefixCommit: "e278aeb10e57d37485542f8668f078456074b038",
    owners: migrationOwners,
    cleanup: {
      verified: true,
      removed: Object.values(databaseByOwner).sort((left, right) =>
        left.localeCompare(right),
      ),
      retained: [],
    },
    legacyTargetsExcluded: ["coffeeorder_staging", "coffeeorderdb"],
  };
  const migrationArtifactDir = join(
    evidenceDir,
    "gates/G08_MIGRATIONS/artifacts",
  );
  await mkdir(migrationArtifactDir, { recursive: true });
  await writeFile(
    join(migrationArtifactDir, "result.json"),
    JSON.stringify(migrationReceipt),
    { mode: 0o600 },
  );
  await writeFile(
    join(migrationArtifactDir, "canonical-preparation.json"),
    preparationBytes,
    { mode: 0o400 },
  );
  const runtimeEntries = roleMap.databases.flatMap((database) => {
    const owner = ownership.databases.find(
      (entry) => entry.name === database.name,
    ).owner;
    return database.runtimeRoles.map((runtime) => ({
      runtime: runtime.runtime,
      owner,
      role: runtime.role,
      database: databaseByOwner[owner],
      schema: database.schema,
      table: Object.entries(runtime.tables).find(([, grants]) =>
        grants.includes("SELECT"),
      )[0],
    }));
  });
  const ownOperations = runtimeEntries
    .map((runtime) => ({
      ...runtime,
      operation: "SELECT",
      outcome: "allowed",
    }))
    .sort((left, right) => left.runtime.localeCompare(right.runtime));
  const foreignConnectionDenials = runtimeEntries
    .flatMap((runtime) =>
      owners
        .filter((owner) => owner !== runtime.owner)
        .map((owner) => ({
          runtime: runtime.runtime,
          owner: runtime.owner,
          databaseOwner: owner,
          role: runtime.role,
          database: databaseByOwner[owner],
          sqlState: "42501",
          outcome: "permission-denied",
        })),
    )
    .sort((left, right) =>
      `${left.runtime}:${left.database}`.localeCompare(
        `${right.runtime}:${right.database}`,
      ),
    );
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    stage: "live-boundaries",
    runId,
    candidateSha,
    baseConfigSha256,
    preparationSha256,
    migrationResultSha256: createHash("sha256")
      .update(JSON.stringify(migrationOwners))
      .digest("hex"),
    systemIdentifier,
    owners: owners.map((owner) => ({
      owner,
      database: databaseByOwner[owner],
    })),
    migrationOwners,
    ownOperations,
    foreignConnectionDenials,
    ownOperationCount: 10,
    foreignDeniedCount: 40,
    caseCount: 50,
    cleanup: {
      verified: true,
      removed: Object.values(databaseByOwner).sort((left, right) =>
        left.localeCompare(right),
      ),
      retained: [],
    },
  };
  const migrationPath = join(migrationArtifactDir, "result.json");
  const gatePath = join(artifactDir, "result.json");
  const stdoutPath = join(evidenceDir, "gates/G09_DB_BOUNDARIES/stdout.log");
  const prettyEnvelope = `${JSON.stringify(
    { databaseBoundaryReceipt: receipt },
    null,
    2,
  )}\n`;
  assert(Buffer.byteLength(prettyEnvelope) > 8192);
  assert(
    prettyEnvelope
      .split(/\r?\n/u)
      .every((line) => Buffer.byteLength(line) <= 8192),
  );
  const available = await verifyGateArtifacts(gate, record, evidenceDir);
  assert.match(
    available,
    /receipt does not match/u,
    "missing receipt fails closed",
  );
  const redacted = await writeRedactedStream(
    Readable.from([prettyEnvelope]),
    stdoutPath,
  );
  assert.equal(redacted.outputLimitExceeded, false);
  assert.equal(await readFile(stdoutPath, "utf8"), prettyEnvelope);
  await writeFile(gatePath, JSON.stringify(receipt), { mode: 0o600 });
  assert.equal(await verifyGateArtifacts(gate, record, evidenceDir), null);
  assert.equal(record.artifacts.length, 1);

  for (const invalidStdout of [
    `pnpm db:smoke\n${prettyEnvelope}`,
    `${prettyEnvelope}trailing garbage\n`,
    `${JSON.stringify(
      {
        databaseBoundaryReceipt: {
          ...receipt,
          foreignDeniedCount: receipt.foreignDeniedCount + 1,
        },
      },
      null,
      2,
    )}\n`,
  ]) {
    await writeFile(stdoutPath, invalidStdout, { mode: 0o600 });
    assert.match(
      await verifyGateArtifacts(
        gate,
        { ...record, artifacts: [] },
        evidenceDir,
      ),
      /receipt does not match/u,
    );
  }
  await writeFile(stdoutPath, prettyEnvelope, { mode: 0o600 });

  for (const mutate of [
    (value) => {
      value.foreignConnectionDenials[0].sqlState = "3D000";
    },
    (value) => {
      value.ownOperations[0].table = "unapproved_table";
    },
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.cleanup.retained.push(value.cleanup.removed[0]);
    },
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    await writeFile(gatePath, JSON.stringify(invalid), { mode: 0o600 });
    assert.match(
      await verifyGateArtifacts(
        gate,
        { ...record, artifacts: [] },
        evidenceDir,
      ),
      /receipt does not match/u,
    );
  }
  await writeFile(
    migrationPath,
    JSON.stringify({ ...migrationReceipt, status: "FAIL" }),
  );
  await writeFile(gatePath, JSON.stringify(receipt), { mode: 0o600 });
  assert.match(
    await verifyGateArtifacts(gate, { ...record, artifacts: [] }, evidenceDir),
    /receipt does not match/u,
  );
});

void test("G08 rejects receipts without exact derived targets and cleanup", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "launch-g08-receipt-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const context = {
    runId: "20261025T120000Z-1111111",
    candidateSha: "1".repeat(40),
    baseConfigSha256: "a".repeat(64),
  };
  await writeFile(join(evidenceDir, "context.json"), JSON.stringify(context));
  const artifactDir = join(evidenceDir, "gates/G08_MIGRATIONS/artifacts");
  await mkdir(artifactDir, { recursive: true });
  const owners = [
    ["catalog", 12],
    ["customer", 3],
    ["integration", 7],
    ["orders", 24],
    ["pricing", 5],
  ].map(([owner, migrationCount]) => ({
    owner,
    database: `coffee_verify_20261025t120000z_1111111_${owner}`,
    migrationCount,
    ledgerSha256: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    aclFingerprint: "d".repeat(64),
  }));
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    stage: "forward",
    ...context,
    preparationSha256: "e".repeat(64),
    cleanSha256: "f".repeat(64),
    systemIdentifier: "7613370342949990434",
    acceptedPrefixCommit: "e278aeb10e57d37485542f8668f078456074b038",
    owners,
    cleanup: {
      verified: true,
      removed: owners.map(({ database }) => database).sort(),
      retained: [],
    },
    legacyTargetsExcluded: ["coffeeorder_staging", "coffeeorderdb"],
  };
  const path = join(artifactDir, "result.json");
  await writeFile(path, JSON.stringify(receipt));
  const gate = { id: "G08_MIGRATIONS" };
  const record = { artifacts: [], runs: [] };
  assert.equal(await verifyGateArtifacts(gate, record, evidenceDir), null);
  assert.equal(record.artifacts.length, 1);

  const staleInventory = structuredClone(receipt);
  staleInventory.owners.find(
    ({ owner }) => owner === "catalog",
  ).migrationCount = 9;
  await writeFile(path, JSON.stringify(staleInventory));
  assert.match(
    await verifyGateArtifacts(gate, { artifacts: [], runs: [] }, evidenceDir),
    /receipt does not match/u,
  );

  const invalid = structuredClone(receipt);
  invalid.cleanup.removed.pop();
  await writeFile(path, JSON.stringify(invalid));
  assert.match(
    await verifyGateArtifacts(gate, { artifacts: [], runs: [] }, evidenceDir),
    /cleanup contract/u,
  );
});

void test("G08 ACL oracle distinguishes table and exact column UPDATE grants", async () => {
  const roleDatabase = JSON.parse(
    await readFile("config/database-role-map.json", "utf8"),
  ).databases.find(({ schema }) => schema === "orders");
  const expectedRows = roleDatabase.runtimeRoles.flatMap((runtime) => [
    ...Object.entries(runtime.tables).flatMap(([table, privileges]) =>
      privileges
        .filter(
          (privilege) =>
            !(privilege === "UPDATE" && runtime.columnUpdates?.[table]),
        )
        .map((privilege) => ({
          grant_scope: "table",
          grantee: runtime.role,
          table_name: table,
          privilege_type: privilege,
          column_name: null,
        })),
    ),
    ...Object.entries(runtime.columnUpdates ?? {}).flatMap(([table, columns]) =>
      columns.map((column) => ({
        grant_scope: "column",
        grantee: runtime.role,
        table_name: table,
        privilege_type: "UPDATE",
        column_name: column,
      })),
    ),
  ]);
  assert.doesNotThrow(() => assertRoleMapGrantRows(roleDatabase, expectedRows));

  const tableSelect = expectedRows.find(
    (row) =>
      row.grantee === "coffee_orders_service_rw" &&
      row.grant_scope === "table" &&
      row.table_name === "orders" &&
      row.privilege_type === "SELECT",
  );
  assert.ok(tableSelect, "table SELECT is represented only by the table ACL");
  assert.throws(
    () =>
      assertRoleMapGrantRows(roleDatabase, [
        ...expectedRows,
        {
          ...tableSelect,
          grant_scope: "column",
          column_name: "status",
        },
      ]),
    /ROLE_MAP_EXTRA_GRANT: coffee_orders_service_rw:column:orders:SELECT:status/u,
  );

  assert.throws(
    () =>
      assertRoleMapGrantRows(roleDatabase, [
        ...expectedRows,
        {
          grant_scope: "table",
          grantee: "coffee_orders_service_rw",
          table_name: "orders",
          privilege_type: "UPDATE",
          column_name: null,
        },
      ]),
    /ROLE_MAP_EXTRA_GRANT: coffee_orders_service_rw:table:orders:UPDATE/u,
  );
  assert.throws(
    () =>
      assertRoleMapGrantRows(roleDatabase, [
        ...expectedRows,
        {
          grant_scope: "column",
          grantee: "coffee_orders_service_rw",
          table_name: "orders",
          privilege_type: "UPDATE",
          column_name: "created_at",
        },
      ]),
    /ROLE_MAP_EXTRA_GRANT: coffee_orders_service_rw:column:orders:UPDATE:created_at/u,
  );
  assert.throws(
    () =>
      assertRoleMapGrantRows(
        roleDatabase,
        expectedRows.map((row) =>
          row.grantee === "coffee_orders_service_rw" &&
          row.grant_scope === "table" &&
          row.table_name === "orders" &&
          row.privilege_type === "SELECT"
            ? { ...row, is_grantable: true }
            : row,
        ),
      ),
    /ROLE_MAP_EXTRA_GRANT: coffee_orders_service_rw:table:orders:SELECT/u,
  );
  const missingColumn = expectedRows.filter(
    (row) =>
      !(
        row.grantee === "coffee_orders_service_rw" &&
        row.grant_scope === "column" &&
        row.column_name === "status"
      ),
  );
  assert.throws(
    () => assertRoleMapGrantRows(roleDatabase, missingColumn),
    /ROLE_MAP_GRANT_MISSING: coffee_orders_service_rw:column:orders:UPDATE:status/u,
  );
});

void test("G08 forward owner diagnostics expose only bounded failure facts", () => {
  const formatted = formatOwnerStageFailure("orders", "seed", {
    sqlState: "23503",
    code: "DB_QUERY_FAILED",
    message: "secret-canary raw SQL and parameter value",
  });
  assert.equal(
    formatted.message,
    "G08_MIGRATIONS OWNER_STAGE_FAILED: orders:seed:23503",
  );
  assert.equal(formatted.message.includes("secret-canary"), false);
  assert.equal(
    formatOwnerStageFailure("catalog", "current", {
      code: "DB_QUERY_FAILED",
      message: "secret-canary",
    }).message,
    "G08_MIGRATIONS OWNER_STAGE_FAILED: catalog:current:UNKNOWN",
  );
  assert.throws(
    () => formatOwnerStageFailure("coffeeorderdb", "seed", { code: "23503" }),
    /Invalid G08 owner stage/u,
  );
  assert.throws(
    () => formatOwnerStageFailure("orders", "cleanup", { code: "23503" }),
    /Invalid G08 owner stage/u,
  );
});

void test("G15 runner requires the exact command and a context-bound live artifact", async (t) => {
  const evidenceDir = await mkdtemp(join(tmpdir(), "launch-g15-mock-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const runId = "20261025T120000Z-1234567";
  const candidateSha = "1".repeat(40);
  await writeFile(
    join(evidenceDir, "context.json"),
    JSON.stringify({
      runId,
      candidateSha,
      baseConfigSha256: "a".repeat(64),
    }),
  );
  await mkdir(join(evidenceDir, "gates/G15_BROWSER/artifacts"), {
    recursive: true,
  });
  await writeFile(
    join(evidenceDir, "gates/G15_BROWSER/stdout.log"),
    "Vite preview with intercepted owner APIs exited successfully\n",
  );
  await writeFile(
    join(evidenceDir, "gates/G15_BROWSER/artifacts/browser-proof.json"),
    JSON.stringify({
      status: "PASS",
      runId: "20261024T120000Z-7654321",
      candidateSha: "2".repeat(40),
      transport: "mocked-owner-routes",
    }),
  );
  const record = {
    runs: [
      {
        argv: ["pnpm", "test:playwright"],
        exitCode: 0,
        timedOut: false,
        outputLimitExceeded: false,
      },
    ],
  };
  assert.equal(
    await verifyGateArtifacts(
      { id: "G15_BROWSER", command: "pnpm test:playwright" },
      record,
      evidenceDir,
    ),
    "G15 parent wrapper does not admit a joined child, exact fixture lineage, browser proof and cleanup",
  );
  assert.notEqual(
    await verifyGateArtifacts(
      {
        id: "G15_BROWSER",
        command: "node apps/web/test/operator-flow.spec.ts",
      },
      record,
      evidenceDir,
    ),
    null,
  );
});

void test("G15 failed gate records only a matching child failure receipt", async (t) => {
  const sourceRoot = process.cwd();
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
  }).trim();
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  const runId = `${stamp}-${randomBytes(4).toString("hex").slice(0, 7)}`;
  const childRunId = `${stamp}-${randomBytes(4).toString("hex").slice(0, 7)}`;
  const evidenceDir = join(sourceRoot, "evidence/launch", runId);
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const artifactDir = join(evidenceDir, "gates/G15_BROWSER/artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const contextFor = (id, parentContext) => ({
    schemaVersion: 1,
    candidateSha,
    baseConfigSha256: "a".repeat(64),
    checkoutDir: sourceRoot,
    sourceRepoRoot: sourceRoot,
    acceptedBaseCommit: null,
    startedAtUtc: "2026-10-26T00:00:00.000Z",
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${id.toLowerCase()}`,
      kafkaPrefix: id,
      ...(parentContext
        ? {
            g08PreparationContextPath: join(
              parentContext.evidenceDir,
              "context.json",
            ),
            g15ParentCandidateSha: parentContext.candidateSha,
            g15ParentCheckoutRoot: parentContext.checkoutDir,
            g15ParentRunId: parentContext.runId,
          }
        : {}),
    },
    runId: id,
    evidenceDir: join(sourceRoot, "evidence/launch", id),
  });
  const context = contextFor(runId);
  const childContext = contextFor(childRunId, context);
  const writeJSON = (path, value, mode) =>
    writeFile(path, JSON.stringify(value), { mode });
  await writeJSON(join(evidenceDir, "context.json"), context, 0o400);
  await writeJSON(
    join(artifactDir, "g15-child-context.json"),
    childContext,
    0o400,
  );
  const failurePath = join(artifactDir, "browser-parent-failure.json");
  const failureReceipt = {
    schemaVersion: 1,
    gateId: "G15_BROWSER",
    outcome: "FAIL",
    parentRunId: runId,
    parentCandidateSha: candidateSha,
    childRunId,
    childCandidateSha: candidateSha,
    errorName: "AssertionError",
    messageSha256: "b".repeat(64),
    operationDiagnostic: {
      operation: "runtime-stack-up",
      failureClass: "nonzero-exit",
      exitCode: 1,
      signal: null,
      timedOut: false,
      containerSnapshot: {
        status: "captured",
        containers: [
          {
            service: "orders-service",
            state: "exited",
            health: "unhealthy",
            exitCode: 1,
            oomKilled: false,
          },
        ],
      },
    },
  };
  await writeJSON(failurePath, failureReceipt, 0o600);
  const gate = { id: "G15_BROWSER", command: "pnpm test:playwright" };
  const recordFor = (exitCode) => ({
    status: exitCode === 0 ? "PASS" : "FAIL",
    artifacts: [],
    runs: [{ argv: ["pnpm", "test:playwright"], exitCode }],
  });
  const failedRecord = recordFor(1);
  const rejection =
    "G15 parent wrapper does not admit a joined child, exact fixture lineage, browser proof and cleanup";

  assert.equal(
    await verifyGateArtifacts(gate, failedRecord, evidenceDir),
    rejection,
  );
  const failureBytes = await readFile(failurePath);
  assert.deepEqual(failedRecord.artifacts, [
    {
      path: failurePath,
      sha256: createHash("sha256").update(failureBytes).digest("hex"),
      sizeBytes: failureBytes.length,
    },
  ]);
  assert.equal(failedRecord.status, "FAIL");

  const successfulRecord = recordFor(0);
  assert.equal(
    await verifyGateArtifacts(gate, successfulRecord, evidenceDir),
    rejection,
  );
  assert.deepEqual(successfulRecord.artifacts, []);

  await writeJSON(
    failurePath,
    { ...failureReceipt, childCandidateSha: "f".repeat(40) },
    0o600,
  );
  const wrongIdentity = { ...failedRecord, artifacts: [] };
  assert.equal(
    await verifyGateArtifacts(gate, wrongIdentity, evidenceDir),
    rejection,
  );
  assert.deepEqual(wrongIdentity.artifacts, []);
  assert.equal(wrongIdentity.status, "FAIL");
});

function syntheticControlledG16Result(context, policy, image) {
  const names = aromaSandboxResourceNames(context.runId);
  const phase = (name, fields = {}) => ({
    phase: name,
    status: "PASS",
    ...fields,
  });
  return {
    gate: "G16_AROMA_SANDBOX",
    status: "PASS",
    code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
    ...context,
    accountFingerprint: policy.accountFingerprint,
    selected: { offerRef: "offer" },
    cleanup: { removed: true, retained: false },
    resourceIDs: {
      runId: context.runId,
      image,
      imageId: `sha256:${"4".repeat(64)}`,
      container: { name: names.container, id: "5".repeat(64) },
      network: { name: names.network, id: "6".repeat(64) },
      databaseSystemIdentifier: "123",
    },
    baselineFingerprint: "baseline",
    finalFingerprint: "baseline",
    mutationJournalRows: 3,
    unknownOperationRef: "unknown",
    phases: [
      phase("baseline-read", {
        cartFingerprint: "baseline",
        lineCount: 0,
        capturedAtUtc: "2026-10-31T12:35:00.000Z",
      }),
      phase("noop", {
        workDirty: false,
        observedLineCount: 0,
        gatewayJournalRows: 0,
      }),
      phase("single-mutation", {
        workDirty: false,
        gateway: { operationKind: "SetLineQuantity", state: "Acknowledged" },
        observedLines: [{ offerRef: "offer", quantityMilli: "1000" }],
      }),
      phase("lost-response", {
        workDirty: true,
        reservation: {
          state: "UnknownOutcome",
          resolved: false,
          operationRef: "unknown",
        },
        gateway: { state: "Acknowledged" },
        droppedAcknowledgementCount: 1,
      }),
      phase("restart-reconcile", {
        workDirty: false,
        reservation: { resolved: true, operationRef: "unknown" },
        oldOperationJournalRows: 1,
      }),
      phase("restore", {
        workDirty: false,
        gateway: { operationKind: "RemoveLine", state: "Acknowledged" },
        observedLineCount: 0,
      }),
      phase("final-read", {
        cartFingerprint: "baseline",
        matchesBaseline: true,
        lineCount: 0,
      }),
    ],
  };
}

void test("G16 controlled result requires bound phases, restore and owned cleanup", () => {
  const context = {
    runId: "20261031T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
  };
  const policy = { accountFingerprint: `sha256:${"2".repeat(64)}` };
  const image = `postgres:17.11-alpine@sha256:${"3".repeat(64)}`;
  const value = syntheticControlledG16Result(context, policy, image);
  assert.equal(
    validateControlledG16Result(value, context, policy, image),
    value,
  );
  for (const mutate of [
    (v) => {
      v.candidateSha = "f".repeat(40);
    },
    (v) => {
      v.resourceIDs.image = "postgres:17.11-alpine";
    },
    (v) => {
      v.resourceIDs.imageId = "";
    },
    (v) => {
      v.cleanup.removed = false;
    },
    (v) => {
      v.cleanup.retained = true;
    },
    (v) => {
      v.phases[3].reservation.resolved = true;
    },
    (v) => {
      v.phases[4].oldOperationJournalRows = 2;
    },
    (v) => {
      v.phases[5].status = "FAIL";
    },
    (v) => {
      v.finalFingerprint = "different";
    },
    (v) => {
      v.phases.pop();
    },
  ]) {
    const altered = structuredClone(value);
    mutate(altered);
    assert.throws(
      () => validateControlledG16Result(altered, context, policy, image),
      /G16_CHILD_RESULT_INVALID/u,
    );
  }
});

void test("G16 parent persists sanitized recovery from a failed managed child", async (t) => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const parent = {
    runId: "20261031T120000Z-1234567",
    candidateSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  };
  const childContext = {
    runId: "20261031T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
  };
  const policy = await readApprovedG16Policy(root, parent.candidateSha);
  const image = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  ).postgresImage;
  const names = aromaSandboxResourceNames(childContext.runId);
  const outcome = {
    gate: "G16_AROMA_SANDBOX",
    status: "FAIL",
    code: "RECOVERY_REQUIRED",
    ...childContext,
    mode: policy.mode,
    origin: policy.origin,
    accountFingerprint: policy.accountFingerprint,
    secret: "NO_LEAK_SENTINEL",
    recovery: {
      runId: childContext.runId,
      stage: "phases",
      failureCode: "AROMA_RESTART_RECOVERY_FAILED",
      diagnostic: { substage: "selection", ownerCode: "NO_LEAK_SENTINEL" },
      cartState: "UNRESOLVED_OR_NONBASELINE",
      mutationsDisabled: true,
      requiredAction: "CONTROLLED_G16_RECOVERY_BEFORE_RESOURCE_CLEANUP",
      cleanup: { removed: false, retained: true },
      resourceIDs: {
        runId: childContext.runId,
        image,
        imageId: `sha256:${"4".repeat(64)}`,
        container: {
          name: names.container,
          id: "5".repeat(64),
          label: "coffee.g16.run-id",
        },
        network: {
          name: names.network,
          id: "6".repeat(64),
          label: "coffee.g16.run-id",
        },
        databaseSystemIdentifier: "7613370342949990434",
      },
    },
    failureEvidence: {
      partialPhaseEvidence: [
        {
          phase: "baseline-read",
          status: "PASS",
          capturedAtUtc: "2026-10-31T12:00:00Z",
        },
        {
          phase: "single-mutation",
          status: "FAIL",
          capturedAtUtc: "2026-10-31T12:01:00Z",
        },
      ],
      convergenceEvidence: {
        latestAttempt: {
          state: "UnknownOutcome",
          failureCode: "AROMA_OPERATION_UNKNOWN_OUTCOME",
          blockerCodes: [],
          selectedAction: "SetQuantity",
          selectedOfferMatches: true,
        },
        reservationStateCounts: [{ state: "UnknownOutcome", count: 1 }],
        gatewayJournalStateCounts: [],
      },
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "coffee-g16-failure-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, line, signerApproved, expected] of [
    ["valid", JSON.stringify(outcome), true, "RECOVERY_REQUIRED"],
    ["malformed", "{NO_LEAK_SENTINEL", true, "G16_CHILD_FAILURE_UNVERIFIED"],
    [
      "unapproved",
      JSON.stringify(outcome),
      false,
      "G16_CHILD_FAILURE_UNVERIFIED",
    ],
    [
      "foreign",
      JSON.stringify({ ...outcome, candidateSha: "0".repeat(40) }),
      true,
      "G16_CHILD_FAILURE_UNVERIFIED",
    ],
  ]) {
    const artifacts = join(directory, name);
    await mkdir(artifacts, { mode: 0o700 });
    const source = `process.stdout.write(${JSON.stringify(`${line}\n`)});process.stderr.write('NO_LEAK_SENTINEL');process.exitCode=1`;
    let failure;
    try {
      await runManagedRollbackChild({
        args: ["--input-type=module", "-e", source],
        cwd: root,
        env: process.env,
      }).catch((error) =>
        handleControlledG16ChildFailure({
          error,
          parent,
          childContext,
          candidateRoot: root,
          signerApproved,
          approvalRequests: 1,
          artifacts,
        }),
      );
      assert.fail("failed child must reject");
    } catch (error) {
      failure = error;
    }
    assert.equal(failure.message, expected);
    assert.equal(safeAromaFailureCode(failure), expected);
    const path = join(artifacts, "controlled-child-failure.json");
    const bytes = await readFile(path);
    const receipt = JSON.parse(bytes);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      failure.safeDetails.failureReceipt.sha256,
    );
    assert.equal(receipt.status, "FAIL");
    assert.equal(receipt.code, expected);
    assert.equal(receipt.childFailure, "ROLLBACK_CHILD_FAILED");
    assert.equal(bytes.includes("NO_LEAK_SENTINEL"), false);
    assert.equal(
      JSON.stringify(failure.safeDetails).includes("NO_LEAK_SENTINEL"),
      false,
    );
    if (name === "valid") {
      assert.equal(receipt.recovery.resourceIDs.container.id, "5".repeat(64));
      assert.equal(receipt.failureEvidence.partialPhaseEvidence.length, 2);
      assert.deepEqual(failure.safeDetails.recovery, receipt.recovery);
    } else assert.equal(receipt.recovery, undefined);
  }
  for (const mutate of [
    (value) => {
      value.runId = "foreign";
    },
    (value) => {
      value.candidateSha = "0".repeat(40);
    },
    (value) => {
      value.accountFingerprint = "foreign";
    },
    (value) => {
      value.recovery.resourceIDs.network.id = "foreign";
    },
    (value) => {
      value.recovery.cleanup.retained = false;
    },
    (value) => {
      value.failureEvidence.partialPhaseEvidence.at(-1).status = "PASS";
    },
  ]) {
    const altered = structuredClone(outcome);
    mutate(altered);
    assert.equal(
      sanitizeControlledG16Recovery(altered, childContext, policy, image),
      null,
    );
  }
});

void test("G16 signer locator requires a single absolute path", () => {
  assert.deepEqual(
    parseLaunchArguments(["--g16-signer", "/tmp/g16-operator.mjs"]),
    { g16SignerPath: "/tmp/g16-operator.mjs" },
  );
  for (const args of [
    ["--g16-signer"],
    ["--g16-signer", "relative"],
    ["--g16-signer", "/a", "--g16-signer", "/b"],
  ])
    assert.throws(() => parseLaunchArguments(args), /g16-signer/u);
});

void test("G16 parent joins a refused signer without touching foreign tmpfs", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-g16-refusal-test-"));
  const foreign = await mkdtemp("/dev/shm/coffee-g16-operator-");
  try {
    const signer = join(root, "signer.mjs");
    const joined = join(root, "signer-joined");
    const child = join(root, "child-must-not-exist");
    const foreignMarker = join(foreign, "foreign-resource");
    await writeFile(foreignMarker, "preserve");
    await writeFile(
      signer,
      `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(joined)}, "joined"); process.exit(0); });
process.stdout.write(JSON.stringify({ mode: "INVALID", approvalFile: ${JSON.stringify(join(foreign, "approval.json"))}, approver: "g16-operator" }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    await assert.rejects(
      runControlledG16Parent({
        parentIdentity: {
          context: {},
          sourceRoot: root,
          candidateRoot: child,
          evidenceDir: root,
        },
        parentContextPath: join(root, "missing-context"),
        signerPath: signer,
      }),
      /G16_SIGNER_READY_INVALID/u,
    );
    assert.equal(await readFile(joined, "utf8"), "joined");
    assert.equal(await readFile(foreignMarker, "utf8"), "preserve");
    await assert.rejects(access(child), { code: "ENOENT" });
    await assert.rejects(access(join(root, "gates")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

void test("G16 controlled evidence rejects unknown cleanup and altered child context", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-g16-parent-test-"));
  try {
    const artifacts = join(root, "gates/G16_AROMA_SANDBOX/artifacts");
    await mkdir(artifacts, { recursive: true });
    const parentIdentity = {
      evidenceDir: root,
      sourceRoot: root,
      candidateRoot: root,
      context: {
        runId: "20261031T123456Z-abcdef0",
        candidateSha: `abcdef0${"1".repeat(33)}`,
      },
    };
    const receipt = {
      schemaVersion: 1,
      ...parentIdentity.context,
      signerSha256: "a".repeat(64),
      cleanup: {
        checkoutRemoved: true,
        evidenceRemoved: true,
        signerRemoved: false,
      },
    };
    const path = join(artifacts, "controlled-parent.json");
    await writeFile(path, JSON.stringify(receipt));
    await assert.rejects(
      verifyControlledG16Evidence({
        parentIdentity,
        parentContextPath: "/parent",
      }),
      /G16_PARENT_RECEIPT_INVALID/u,
    );
    receipt.cleanup.signerRemoved = true;
    receipt.childContextSha256 = "b".repeat(64);
    await writeFile(path, JSON.stringify(receipt));
    await writeFile(join(artifacts, "controlled-child-context.json"), "{}");
    await assert.rejects(
      verifyControlledG16Evidence({
        parentIdentity,
        parentContextPath: "/parent",
      }),
      /G16_PARENT_ARTIFACT_HASH_INVALID/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("G16 controlled evidence verifies signed child bundle and rejects altered binding", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "coffee-g16-evidence-test-"));
  let child;
  let parentEvidenceDir;
  const previousAgeKey = process.env.SOPS_AGE_KEY_FILE;
  try {
    const candidateRoot = join(temporary, "parent");
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-hardlinks",
        process.cwd(),
        candidateRoot,
      ],
      { stdio: "ignore" },
    );
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: candidateRoot,
        encoding: "utf8",
      }).trim();
    git(
      "remote",
      "set-url",
      "origin",
      "https://github.com/YurGusev/CoffeeOrderPlatform",
    );
    const ageKey = join(temporary, "synthetic-age-key");
    execFileSync("age-keygen", ["-o", ageKey], { stdio: "ignore" });
    await chmod(ageKey, 0o600);
    const recipient = execFileSync("age-keygen", ["-y", ageKey], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    await writeFile(
      join(candidateRoot, ".sops.yaml"),
      `creation_rules:\n  - path_regex: secrets/platform\\.secrets\\.sops\\.yaml$\n    age:\n      - ${recipient}\n`,
    );
    git("add", "--", ".sops.yaml");
    git(
      "-c",
      "user.name=G16 synthetic test",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "synthetic recipient",
    );
    const candidateSha = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "--detach", candidateSha);
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const keyId = `g16-${createHash("sha256")
      .update(keys.publicKey.export({ type: "spki", format: "der" }))
      .digest("hex")
      .slice(0, 20)}`;
    const signer = { publicKeyPem, keyId, approver: "g16-operator" };
    child = await createG16Checkout({ candidateRoot, candidateSha, ...signer });
    const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const sourceRoot = await fsPromises.realpath(process.cwd());
    const parentRunId = `20261031T123400Z-${candidateSha.slice(0, 7)}`;
    const evidenceDir = join(sourceRoot, "evidence/launch", parentRunId);
    const parentContextPath = join(evidenceDir, "context.json");
    await mkdir(evidenceDir, { mode: 0o700 });
    parentEvidenceDir = evidenceDir;
    const parent = {
      schemaVersion: 1,
      runId: parentRunId,
      candidateSha,
      acceptedBaseCommit: candidateSha,
      checkoutDir: candidateRoot,
      sourceRepoRoot: sourceRoot,
      evidenceDir,
      baseConfigSha256: hash(
        await readFile(join(candidateRoot, "config/platform.yaml")),
      ),
    };
    await writeFile(parentContextPath, JSON.stringify(parent), { mode: 0o400 });
    const runId = `20261031T123456Z-${child.baselineSha.slice(0, 7)}`;
    const context = {
      runId,
      candidateSha: child.baselineSha,
      sourceRepoRoot: sourceRoot,
      acceptedBaseCommit: candidateSha,
      baseConfigSha256: hash(
        await readFile(join(child.baselineRoot, "config/platform.yaml")),
      ),
      evidenceDir: join(sourceRoot, "evidence/launch", runId),
      resources: {
        composeProject: `coffee-launch-${runId.toLowerCase()}`,
        kafkaPrefix: runId,
        controlledScope: "G16",
        controlledParentContextPath: parentContextPath,
        controlledParentCandidateSha: candidateSha,
        controlledParentRunId: parent.runId,
      },
    };
    const policy = await readApprovedG16Policy(candidateRoot, candidateSha);
    const toolchain = JSON.parse(
      await readFile(
        join(candidateRoot, "config/toolchain-versions.json"),
        "utf8",
      ),
    );
    const outcome = syntheticControlledG16Result(
      context,
      policy,
      toolchain.postgresImage,
    );
    const approval = {
      schemaVersion: 1,
      runId,
      candidateSha: child.baselineSha,
      mode: policy.mode,
      origin: policy.origin,
      exceptionAuthority: "user-2026-10-23",
      accountFingerprint: policy.accountFingerprint,
      offerRef: "offer",
      maximumQuantity: "2",
      approver: signer.approver,
      keyId,
      issuedAtUtc: "2026-10-31T12:34:00.000Z",
      expiresAtUtc: "2026-10-31T13:34:00.000Z",
    };
    const approvalBytes = Buffer.from(JSON.stringify(approval));
    const signature = Buffer.from(
      sign(null, approvalBytes, keys.privateKey).toString("base64"),
    );
    const bundle = await writeRollbackLineageBundle({
      candidateSha,
      restoredRoot: child.baselineRoot,
      restoredSha: child.baselineSha,
      evidenceDir,
      scope: "G16",
    });
    const artifacts = join(evidenceDir, "gates/G16_AROMA_SANDBOX/artifacts");
    const encrypt = (bytes) =>
      execFileSync("age", ["--recipient", recipient], {
        input: bytes,
        stdio: ["pipe", "pipe", "pipe"],
      });
    const approvalCiphertext = encrypt(approvalBytes);
    const signatureCiphertext = encrypt(signature);
    const files = [
      ["controlled-child-context.json", Buffer.from(JSON.stringify(context))],
      ["controlled-child-result.json", Buffer.from(JSON.stringify(outcome))],
      ["controlled-approval.json.age", approvalCiphertext],
      ["controlled-approval.sig.age", signatureCiphertext],
    ];
    for (const [name, bytes] of files)
      await writeFile(join(artifacts, name), bytes, { mode: 0o600 });
    const receipt = {
      schemaVersion: 1,
      ...parent,
      childRunId: runId,
      childSha: child.baselineSha,
      signer,
      signerSha256: "a".repeat(64),
      bundleSha256: bundle.sha256,
      childContextSha256: hash(files[0][1]),
      childResultSha256: hash(files[1][1]),
      approvalSha256: hash(approvalBytes),
      signatureSha256: hash(signature),
      approvalCiphertextSha256: hash(approvalCiphertext),
      signatureCiphertextSha256: hash(signatureCiphertext),
      cleanup: {
        checkoutRemoved: true,
        evidenceRemoved: true,
        signerRemoved: true,
      },
    };
    const receiptPath = join(artifacts, "controlled-parent.json");
    await writeFile(receiptPath, JSON.stringify(receipt));
    const parentIdentity = {
      candidateRoot,
      sourceRoot,
      evidenceDir,
      context: parent,
    };
    const verifyEvidence = (key = ageKey) =>
      verifyControlledG16Evidence({
        parentIdentity,
        parentContextPath,
        env: { ...process.env, SOPS_AGE_KEY_FILE: key },
      });
    assert.equal(
      await access(join(artifacts, "controlled-approval.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(
      await access(join(artifacts, "controlled-approval.sig")).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.equal(approvalCiphertext.includes(approvalBytes), false);
    assert.equal(signatureCiphertext.includes(signature), false);
    assert.equal((await verifyEvidence()).childSha, child.baselineSha);
    process.env.SOPS_AGE_KEY_FILE = ageKey;
    const gate = { id: "G16_AROMA_SANDBOX" };
    const pendingRecord = () => ({
      status: "NOT_RUN",
      runs: [],
      artifacts: [],
    });
    const accepted = pendingRecord();
    assert.equal(await verifyGateArtifacts(gate, accepted, evidenceDir), null);
    assert.equal(accepted.artifacts.length, 7);
    const ciphertextPath = join(artifacts, "controlled-approval.json.age");
    await unlink(ciphertextPath);
    const missing = pendingRecord();
    assert.match(
      await verifyGateArtifacts(gate, missing, evidenceDir),
      /G16 controlled child failed/u,
    );
    assert.deepEqual(missing.artifacts, []);
    await writeFile(ciphertextPath, approvalCiphertext, { mode: 0o600 });
    delete receipt.cleanup.signerRemoved;
    await writeFile(receiptPath, JSON.stringify(receipt));
    const missingCleanup = pendingRecord();
    assert.match(
      await verifyGateArtifacts(gate, missingCleanup, evidenceDir),
      /G16 controlled child failed/u,
    );
    assert.deepEqual(missingCleanup.artifacts, []);
    receipt.cleanup.signerRemoved = false;
    await writeFile(receiptPath, JSON.stringify(receipt));
    const forgedCleanup = pendingRecord();
    assert.match(
      await verifyGateArtifacts(gate, forgedCleanup, evidenceDir),
      /G16 controlled child failed/u,
    );
    assert.deepEqual(forgedCleanup.artifacts, []);
    receipt.cleanup.signerRemoved = true;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await chmod(join(artifacts, "controlled-approval.json.age"), 0o644);
    await assert.rejects(
      verifyEvidence(),
      /G16_APPROVAL_CIPHERTEXT_MODE_INVALID/u,
    );
    await chmod(join(artifacts, "controlled-approval.json.age"), 0o600);
    for (const name of await fsPromises.readdir(artifacts)) {
      const persisted = await readFile(join(artifacts, name));
      assert.equal(persisted.includes(approvalBytes), false, name);
      assert.equal(persisted.includes(signature), false, name);
    }
    context.resources.controlledParentRunId = "foreign";
    files[0][1] = Buffer.from(JSON.stringify(context));
    await writeFile(join(artifacts, files[0][0]), files[0][1]);
    receipt.childContextSha256 = hash(files[0][1]);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyEvidence(), /G16_CHILD_CONTEXT_INVALID/u);
    context.resources.controlledParentRunId = parent.runId;
    files[0][1] = Buffer.from(JSON.stringify(context));
    await writeFile(join(artifacts, files[0][0]), files[0][1]);
    receipt.childContextSha256 = hash(files[0][1]);
    approval.offerRef = "other";
    const forged = Buffer.from(JSON.stringify(approval));
    const forgedCiphertext = encrypt(forged);
    await writeFile(
      join(artifacts, "controlled-approval.json.age"),
      forgedCiphertext,
    );
    receipt.approvalSha256 = hash(forged);
    receipt.approvalCiphertextSha256 = hash(forgedCiphertext);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyEvidence(), /G16_APPROVAL_PROOF_INVALID/u);
    await writeFile(
      join(artifacts, "controlled-approval.json.age"),
      approvalCiphertext,
    );
    receipt.approvalSha256 = hash(approvalBytes);
    receipt.approvalCiphertextSha256 = hash(approvalCiphertext);
    const otherKey = generateKeyPairSync("ed25519").privateKey;
    const forgedSignature = Buffer.from(
      sign(null, approvalBytes, otherKey).toString("base64"),
    );
    const forgedSignatureCiphertext = encrypt(forgedSignature);
    await writeFile(
      join(artifacts, "controlled-approval.sig.age"),
      forgedSignatureCiphertext,
    );
    receipt.signatureSha256 = hash(forgedSignature);
    receipt.signatureCiphertextSha256 = hash(forgedSignatureCiphertext);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyEvidence(), /G16_APPROVAL_PROOF_INVALID/u);
    await writeFile(
      join(artifacts, "controlled-approval.sig.age"),
      signatureCiphertext,
    );
    receipt.signatureSha256 = hash(signature);
    receipt.signatureCiphertextSha256 = hash(signatureCiphertext);
    const wrongKey = join(temporary, "synthetic-wrong-key");
    execFileSync("age-keygen", ["-o", wrongKey], { stdio: "ignore" });
    await chmod(wrongKey, 0o600);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyEvidence(wrongKey), /G16_AGE_PREFLIGHT_FAILED/u);
    const damaged = Buffer.from(approvalCiphertext);
    damaged[damaged.length - 1] ^= 1;
    await writeFile(join(artifacts, "controlled-approval.json.age"), damaged);
    await assert.rejects(verifyEvidence(), /G16_PARENT_ARTIFACT_HASH_INVALID/u);
    receipt.approvalCiphertextSha256 = hash(damaged);
    await writeFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(verifyEvidence(), /G16_AGE_OPERATION_FAILED/u);
  } finally {
    if (previousAgeKey === undefined) delete process.env.SOPS_AGE_KEY_FILE;
    else process.env.SOPS_AGE_KEY_FILE = previousAgeKey;
    if (child) await rm(child.directory, { recursive: true, force: true });
    if (parentEvidenceDir)
      await rm(parentEvidenceDir, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  }
});

void test("G16 child config preserves parent except approved policy and mutation flag", async () => {
  const fixture = await aromaApprovalFixture();
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = `g16-${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 20)}`;
  const parentBytes = Buffer.from(
    "environment: development\nverification:\n  aromaSandbox: null\nservices:\n  aroma-convergence:\n    mutationsEnabled: false\n    unrelated: preserved\n",
  );
  const { trustedApprovers: _unusedApprovers, ...historicalPolicy } =
    fixture.policy;
  const input = {
    parentBytes,
    historicalPolicy,
    publicKeyPem,
    keyId,
    approver: "g16-operator",
  };
  const child = parseYaml(buildG16ChildConfig(input).toString("utf8"));
  assert.equal(child.services["aroma-convergence"].mutationsEnabled, true);
  assert.equal(child.services["aroma-convergence"].unrelated, "preserved");
  assert.deepEqual(child.verification.aromaSandbox.trustedApprovers, [
    { keyId, approver: "g16-operator", publicKeyPem },
  ]);
  const { trustedApprovers: _childApprovers, ...childPolicy } =
    child.verification.aromaSandbox;
  assert.deepEqual(childPolicy, historicalPolicy);
  assert.throws(
    () => buildG16ChildConfig({ ...input, keyId: "g16-foreign" }),
    /G16_APPROVER_IDENTITY_INVALID/u,
  );
  assert.throws(
    () =>
      buildG16ChildConfig({
        ...input,
        parentBytes: Buffer.from(
          parentBytes
            .toString()
            .replace("mutationsEnabled: false", "mutationsEnabled: true"),
        ),
      }),
    /G16_PARENT_CONFIG_INVALID/u,
  );
  assert.throws(
    () =>
      buildG16ChildConfig({
        ...input,
        historicalPolicy: {
          ...historicalPolicy,
          existingAccountException: {
            ...fixture.policy.existingAccountException,
            authority: "foreign",
          },
        },
      }),
    /G16_HISTORICAL_POLICY_INVALID/u,
  );
});

void test("G16 historical approval requires the exact committed proof artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coffee-approved-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const path = join(root, "evidence/aroma-provider/controlled-account.json");
  await mkdir(dirname(path), { recursive: true });
  const bytes = await readFile(
    new URL(
      "../../../evidence/aroma-provider/controlled-account.json",
      import.meta.url,
    ),
  );
  await writeFile(path, bytes);
  git("add", ".");
  git("commit", "-qm", "approved proof");
  const sha = git("rev-parse", "HEAD");
  const policy = await readApprovedG16Policy(root, sha);
  assert.equal(policy.existingAccountException.authority, "user-2026-10-23");
  assert.equal(Object.hasOwn(policy, "trustedApprovers"), false);
  await writeFile(path, `${bytes.toString()} `);
  await assert.rejects(
    readApprovedG16Policy(root, sha),
    /G16_APPROVED_POLICY_BLOB_INVALID/u,
  );
  git("add", ".");
  git("commit", "-qm", "altered proof");
  await assert.rejects(
    readApprovedG16Policy(root, git("rev-parse", "HEAD")),
    /G16_APPROVED_POLICY_BLOB_INVALID/u,
  );
});

void test("signed AROMA approval admits only the policy-bound controlled-live authorization", async () => {
  const fixture = await aromaApprovalFixture();
  const admitted = validateAdmission({
    approvalBytes: fixture.bytes,
    signatureBase64: fixture.signature,
    policy: fixture.policy,
    identity: fixture.identity,
    encryptedSecrets: fixture.encryptedSecrets,
    now: fixture.now,
    validateApproval: fixture.validateApproval,
    expectedOfferRef: fixture.approval.offerRef,
    expectedQuantity: 2,
  });
  assert.equal(admitted.status, "PASS");
  assert.equal(admitted.code, "SIGNED_APPROVAL_ADMITTED");
  assert.equal(
    canonicalHttpsOrigin("https://aroma-sandbox.example"),
    "https://aroma-sandbox.example",
  );
  for (const origin of [
    "http://aroma-sandbox.example",
    "https://user@aroma-sandbox.example",
    "https://aroma-sandbox.example/path",
    "https://aroma-sandbox.example?x=1",
    "https://aroma-sandbox.example#x",
    "https://aroma-sandbox.example:8443",
    "https://aroma-sandbox.example.",
    "https://AROMA-SANDBOX.EXAMPLE",
  ]) {
    assert.equal(canonicalHttpsOrigin(origin), null, origin);
  }
});

void test("signed AROMA approval rejects invalid signatures and run/candidate bindings", async () => {
  const fixture = await aromaApprovalFixture();
  const corruptedSignature = `${fixture.signature[0] === "A" ? "B" : "A"}${fixture.signature.slice(1)}`;
  assertAdmissionCode(fixture, "SIGNATURE_INVALID", {
    signatureBase64: corruptedSignature,
  });
  assertAdmissionCode(fixture, "SIGNATURE_ENCODING_INVALID", {
    signatureBase64: `\u00c1${fixture.signature.slice(1)}`,
  });
  for (const field of ["runId", "candidateSha"]) {
    const approval = {
      ...fixture.approval,
      [field]:
        field === "runId"
          ? `20261023T120000Z-${"f".repeat(7)}`
          : "f".repeat(40),
    };
    const bytes = Buffer.from(JSON.stringify(approval));
    assertAdmissionCode(fixture, "APPROVAL_BINDING_MISMATCH", {
      approvalBytes: bytes,
      signatureBase64: sign(null, bytes, fixture.privateKey).toString("base64"),
    });
  }
  for (const field of ["origin", "accountFingerprint"]) {
    const approval = {
      ...fixture.approval,
      [field]:
        field === "origin"
          ? "https://other-sandbox.example"
          : `sha256:${"c".repeat(64)}`,
    };
    const bytes = Buffer.from(JSON.stringify(approval));
    assertAdmissionCode(fixture, "APPROVAL_BINDING_MISMATCH", {
      approvalBytes: bytes,
      signatureBase64: sign(null, bytes, fixture.privateKey).toString("base64"),
    });
  }
});

void test("signed AROMA approval enforces expiry, trust, deny-lists and operation bounds", async () => {
  const fixture = await aromaApprovalFixture();
  const expired = {
    ...fixture.approval,
    expiresAtUtc: "2026-10-23T11:59:59.000Z",
  };
  const expiredBytes = Buffer.from(JSON.stringify(expired));
  assertAdmissionCode(fixture, "APPROVAL_EXPIRED", {
    approvalBytes: expiredBytes,
    signatureBase64: sign(null, expiredBytes, fixture.privateKey).toString(
      "base64",
    ),
  });
  const future = {
    ...fixture.approval,
    issuedAtUtc: "2026-10-23T12:00:01.000Z",
    expiresAtUtc: "2026-10-23T13:00:01.000Z",
  };
  const futureBytes = Buffer.from(JSON.stringify(future));
  assertAdmissionCode(fixture, "APPROVAL_TIME_INVALID", {
    approvalBytes: futureBytes,
    signatureBase64: sign(null, futureBytes, fixture.privateKey).toString(
      "base64",
    ),
  });
  assertAdmissionCode(fixture, "OFFER_BINDING_MISMATCH", {
    expectedOfferRef: `off_${"1".repeat(26)}`,
  });
  assertAdmissionCode(fixture, "QUANTITY_BINDING_MISMATCH", {
    expectedQuantity: 8,
  });
  assertAdmissionCode(fixture, "PRODUCTION_ENVIRONMENT_DENIED", {
    identity: { ...fixture.identity, environment: "production" },
  });
  const productionOrigin = {
    ...fixture.policy,
    origin: "https://api.aromateacoffee.ru",
  };
  assertAdmissionCode(fixture, "POLICY_EXCEPTION_INVALID", {
    policy: productionOrigin,
  });
  const productionAccount = {
    ...fixture.policy,
    accountFingerprint: fixture.policy.productionAccountFingerprints[0],
  };
  assertAdmissionCode(fixture, "POLICY_EXCEPTION_INVALID", {
    policy: productionAccount,
  });
  const duplicateApprover = {
    ...fixture.policy,
    trustedApprovers: [
      ...fixture.policy.trustedApprovers,
      { ...fixture.policy.trustedApprovers[0], keyId: "second-key" },
    ],
  };
  assertAdmissionCode(fixture, "POLICY_DUPLICATE_OR_INVALID_APPROVER", {
    policy: duplicateApprover,
  });
  const duplicateKey = {
    ...fixture.policy,
    trustedApprovers: [
      ...fixture.policy.trustedApprovers,
      {
        ...fixture.policy.trustedApprovers[0],
        keyId: "second-key",
        approver: "second-owner",
      },
    ],
  };
  assertAdmissionCode(fixture, "POLICY_DUPLICATE_OR_INVALID_APPROVER", {
    policy: duplicateKey,
  });
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const wrongKeyType = {
    ...fixture.policy,
    trustedApprovers: [
      {
        ...fixture.policy.trustedApprovers[0],
        publicKeyPem: rsa.publicKey.export({ type: "spki", format: "pem" }),
      },
    ],
  };
  assertAdmissionCode(fixture, "APPROVER_KEY_TYPE_INVALID", {
    policy: wrongKeyType,
  });
  const privatePem = {
    ...fixture.policy,
    trustedApprovers: [
      {
        ...fixture.policy.trustedApprovers[0],
        publicKeyPem: fixture.privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      },
    ],
  };
  assertAdmissionCode(fixture, "APPROVER_KEY_INVALID", { policy: privatePem });
  const invalidRefs = {
    ...fixture.policy,
    credentialRefs: ["aroma.sandbox.email", "aroma.sandbox.password"],
  };
  assertAdmissionCode(fixture, "POLICY_CREDENTIAL_REFS_INVALID", {
    policy: invalidRefs,
  });

  const productionException = {
    ...fixture.policy,
    origin: "https://aromateacoffee.ru",
    accountFingerprint: fixture.policy.productionAccountFingerprints[0],
    existingAccountException: {
      authority: "user-2026-10-23",
      origin: "https://aromateacoffee.ru",
      accountFingerprint: fixture.policy.productionAccountFingerprints[0],
    },
  };
  const approvedProductionTarget = {
    ...fixture.approval,
    origin: productionException.origin,
    accountFingerprint: productionException.accountFingerprint,
  };
  const bytes = Buffer.from(JSON.stringify(approvedProductionTarget));
  const admitted = validateAdmission({
    approvalBytes: bytes,
    signatureBase64: sign(null, bytes, fixture.privateKey).toString("base64"),
    policy: productionException,
    identity: fixture.identity,
    encryptedSecrets: fixture.encryptedSecrets,
    now: fixture.now,
    validateApproval: fixture.validateApproval,
  });
  assert.equal(admitted.status, "PASS");
  const unboundException = {
    ...productionException,
    existingAccountException: {
      ...productionException.existingAccountException,
      authority: "other-authority",
    },
  };
  assertAdmissionCode(fixture, "POLICY_EXCEPTION_INVALID", {
    policy: unboundException,
  });
});

void test("signed AROMA approval validates exact schema and requires existing encrypted credentials", async () => {
  const fixture = await aromaApprovalFixture();
  for (const mutation of [
    { ...fixture.approval, extra: "field" },
    { ...fixture.approval, offerRef: "off_O" },
    { ...fixture.approval, maximumQuantity: "1.5" },
    { ...fixture.approval, maximumQuantity: "0" },
    { ...fixture.approval, maximumQuantity: "3" },
    { ...fixture.approval, mode: "sandbox" },
    { ...fixture.approval, exceptionAuthority: "other-authority" },
  ]) {
    const bytes = Buffer.from(JSON.stringify(mutation));
    assertAdmissionCode(fixture, "APPROVAL_SCHEMA_INVALID", {
      approvalBytes: bytes,
      signatureBase64: sign(null, bytes, fixture.privateKey).toString("base64"),
    });
  }
  const missingCredential = { environments: { development: { aroma: {} } } };
  const notRun = validateAdmission({
    approvalBytes: fixture.bytes,
    signatureBase64: fixture.signature,
    policy: fixture.policy,
    identity: fixture.identity,
    encryptedSecrets: missingCredential,
    now: fixture.now,
    validateApproval: fixture.validateApproval,
  });
  assert.deepEqual(notRun, {
    status: "NOT_RUN",
    code: "SCOPED_SANDBOX_CREDENTIALS_ABSENT",
  });
  assert.deepEqual(validateAdmission({ policy: null }), {
    status: "NOT_RUN",
    code: "SANDBOX_POLICY_ABSENT",
  });
});

void test("AROMA existing-account fingerprint binds canonical identity without exposing email", () => {
  const input = {
    catalogIdentityKeyV1: "catalog-key-fixture",
    origin: "https://aromateacoffee.ru",
    scopeRef: "aroma-primary",
    authenticatedEmail: " Owner@Example.Test ",
    credentialEmail: "owner@example.test",
  };
  const fingerprint = computeExistingAccountFingerprint(input);
  assert.equal(
    fingerprint,
    "sha256:652c01c6c63475cd1ffb518997c4414b893d853d70775b4a4e15f553c2d5ac37",
  );
  assert.ok(!fingerprint.includes("owner@example.test"));
  assert.throws(
    () =>
      computeExistingAccountFingerprint({
        ...input,
        credentialEmail: "different@example.test",
      }),
    /AROMA_ACCOUNT_FINGERPRINT_INPUT_INVALID/,
  );
  assert.throws(
    () =>
      computeExistingAccountFingerprint({
        ...input,
        origin: "http://aromateacoffee.ru",
      }),
    /AROMA_ACCOUNT_FINGERPRINT_INPUT_INVALID/,
  );
});

void test("AROMA profile admission compares authenticated and configured email before returning only its HMAC", async () => {
  const input = {
    catalogIdentityKeyV1: "catalog-key-fixture",
    origin: "https://aromateacoffee.ru",
    scopeRef: "aroma-primary",
    authenticatedEmail: " Owner@Example.Test ",
    credentialEmail: "owner@example.test",
  };
  const accountFingerprint = computeExistingAccountFingerprint(input);
  const options = {
    sessions: {},
    credentials: { scopeRef: input.scopeRef, email: input.credentialEmail },
    identityKey: Buffer.from(input.catalogIdentityKeyV1),
    decodeUser: (profile) => profile,
    readProviderSafely: async function* () {
      yield Buffer.from(
        JSON.stringify({
          email: input.authenticatedEmail,
          wholesale: true,
          retail: false,
        }),
      );
    },
    policy: { origin: input.origin, accountFingerprint },
    signal: new AbortController().signal,
  };
  const admitted = await inspectAromaProfile(options);
  assert.deepEqual(admitted, {
    accountFingerprint,
    wholesale: true,
    retail: false,
  });
  assert.ok(!JSON.stringify(admitted).includes(input.credentialEmail));
  await assert.rejects(
    inspectAromaProfile({
      ...options,
      credentials: { ...options.credentials, email: "different@example.test" },
    }),
    /AROMA_ACCOUNT_FINGERPRINT_INPUT_INVALID/,
  );
});

void test("AROMA mutation capability is approval-bound, single-use, phase-ordered, quantity-limited and expiring", () => {
  const offerRef = `off_${"0".repeat(26)}`;
  const expiresAtUtc = new Date(Date.now() + 60_000).toISOString();
  const capability = "a".repeat(64);
  const grant = createAromaMutationGrant({
    offerRef,
    maximumQuantity: "2",
    expiresAtUtc,
    capability,
  });
  const issuedAt = 1_700_000_000_000;
  assert.throws(
    () =>
      createAromaMutationGrant({
        offerRef,
        maximumQuantity: "2",
        expiresAtUtc: new Date(issuedAt + 2 * 60 * 60 * 1000 + 1).toISOString(),
        capability,
        now: () => issuedAt,
      }),
    /AROMA_GRANT_INVALID/,
  );
  assert.throws(
    () => grant.authorize("lost-response"),
    /AROMA_PHASE_ORDER_INVALID/,
  );
  grant.authorize("single-mutation");
  assert.equal(
    grant.claim({
      providedCapability: "b".repeat(64),
      phase: "single-mutation",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "1",
    }),
    false,
  );
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "single-mutation",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "2",
    }),
    false,
  );
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "single-mutation",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "1",
    }),
    true,
  );
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "single-mutation",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "1",
    }),
    false,
  );
  grant.authorize("lost-response");
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "lost-response",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "2",
      sourceGrindKeyHash: "f".repeat(64),
    }),
    false,
  );
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "lost-response",
      operation: "SetLineQuantity",
      offerRef,
      quantity: "2",
    }),
    true,
  );
  grant.authorize("restore");
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "restore",
      operation: "RemoveLine",
      offerRef: `off_${"1".repeat(26)}`,
    }),
    false,
  );
  assert.equal(
    grant.claim({
      providedCapability: capability,
      phase: "restore",
      operation: "RemoveLine",
      offerRef,
    }),
    true,
  );
  let clock = Date.now();
  const expired = createAromaMutationGrant({
    offerRef,
    maximumQuantity: "2",
    expiresAtUtc: new Date(clock + 30_000).toISOString(),
    capability,
    now: () => clock,
  });
  clock += 31_000;
  assert.throws(
    () => expired.authorize("single-mutation"),
    /AROMA_APPROVAL_EXPIRED/,
  );
  assert.equal(
    safeAromaFailureCode(new Error("SELECT secret FROM users")),
    "AROMA_SANDBOX_FAILED",
  );
});

void test("AROMA full-cart guards fail closed and recovery cleanup requires baseline plus resolved durable state", () => {
  const offerRef = `off_${"0".repeat(26)}`;
  const baseline = { cartFingerprint: "baseline", lines: [] };
  assert.deepEqual(assertAromaCartVector(baseline, []), []);
  assert.throws(
    () => assertAromaCartVector({ lines: [{ offerRef, quantity: "1" }] }, []),
    /AROMA_FOREIGN_CART_CHANGE/,
  );
  assert.throws(
    () =>
      assertAromaCartVector(
        {
          lines: [
            { offerRef, quantity: "1", sourceGrindKeyHash: "a".repeat(64) },
          ],
        },
        [],
      ),
    /AROMA_CART_CONTAINS_UNSUPPORTED_LINE/,
  );
  assert.equal(
    canCleanupAromaAfterFailure({
      snapshot: baseline,
      baselineFingerprint: "baseline",
      unresolvedReservations: 0,
      dirtyWorkRows: 0,
    }),
    true,
  );
  assert.equal(
    canCleanupAromaAfterFailure({
      snapshot: baseline,
      baselineFingerprint: "baseline",
      unresolvedReservations: 1,
      dirtyWorkRows: 0,
    }),
    false,
  );
  assert.equal(
    canCleanupAromaAfterFailure({
      snapshot: baseline,
      baselineFingerprint: "baseline",
      unresolvedReservations: 0,
      dirtyWorkRows: 1,
    }),
    false,
  );
  assert.equal(
    canCleanupAromaAfterFailure({
      snapshot: { cartFingerprint: "other", lines: [] },
      baselineFingerprint: "baseline",
      unresolvedReservations: 0,
      dirtyWorkRows: 0,
    }),
    false,
  );
  assert.equal(
    canCleanupAromaAfterFailure({
      snapshot: {
        cartFingerprint: "baseline",
        lines: [{ offerRef, quantity: "1" }],
      },
      baselineFingerprint: "baseline",
      unresolvedReservations: 0,
      dirtyWorkRows: 0,
    }),
    false,
  );
});

void test("G16 requires the selected offer's explicit binding packing and null grind before approval or grant", () => {
  const binding = {
    offerRef: `off_${"0".repeat(26)}`,
    supplierRef: `sup_${"1".repeat(26)}`,
    packing: "Aroma",
    grindId: null,
  };
  assert.equal(
    assertAromaControlledOfferFacts(binding, {
      offerRef: binding.offerRef,
      supplierRef: binding.supplierRef,
      defaultPacking: "Aroma",
    }),
    binding,
  );
  for (const invalid of [
    null,
    { ...binding, packing: undefined },
    { ...binding, packing: null },
    { ...binding, packing: "Other" },
    { ...binding, grindId: undefined },
    { ...binding, grindId: "fine" },
    { ...binding, offerRef: `off_${"2".repeat(26)}` },
    { ...binding, supplierRef: `sup_${"3".repeat(26)}` },
  ]) {
    assert.throws(
      () =>
        assertAromaControlledOfferFacts(invalid, {
          offerRef: binding.offerRef,
          supplierRef: binding.supplierRef,
          defaultPacking: "Aroma",
        }),
      /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
    );
  }
  assert.equal(
    safeAromaFailureCode(new Error("AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN")),
    "AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN",
  );
});

void test("G16 exact raw-offer reverse lookup rejects foreign and stale approved refs", () => {
  const offerRef = `off_${"0".repeat(26)}`;
  const binding = {
    offerRef,
    supplierRef: `sup_${"1".repeat(26)}`,
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "a".repeat(64),
    state: "Bound",
  };
  const sourceIdentity = { ...binding, rawProviderOfferId: "445" };
  assert.equal(
    freshOfferRefForProviderId(binding, sourceIdentity, binding.supplierRef),
    offerRef,
  );
  assert.equal(
    freshOfferRefForProviderId(
      binding,
      sourceIdentity,
      binding.supplierRef,
      offerRef,
    ),
    offerRef,
  );
  assert.throws(
    () =>
      freshOfferRefForProviderId(
        binding,
        sourceIdentity,
        binding.supplierRef,
        `off_${"2".repeat(26)}`,
      ),
    /AROMA_SANDBOX_CATALOG_CHECK_FAILED/u,
  );
  for (const invalid of [
    null,
    { ...binding, state: "Pending" },
    { ...binding, supplierRef: `sup_${"3".repeat(26)}` },
    { ...binding, sourceIdentityScheme: "other" },
    { ...binding, sourceOfferKeyHash: "bad" },
  ]) {
    assert.throws(
      () =>
        freshOfferRefForProviderId(
          invalid,
          sourceIdentity,
          binding.supplierRef,
        ),
      /AROMA_SANDBOX_CATALOG_CHECK_FAILED/u,
    );
  }
  assert.throws(
    () =>
      freshOfferRefForProviderId(
        binding,
        { ...sourceIdentity, rawProviderOfferId: "447" },
        binding.supplierRef,
      ),
    /AROMA_SANDBOX_CATALOG_CHECK_FAILED/u,
  );
});

void test("G16 accepts only pinned offer-445 wire facts when source binding facts are absent", async () => {
  const root = process.cwd();
  const factsPath = join(
    root,
    "evidence/aroma-provider/2026-10-24-packing/packing-wire-facts.json",
  );
  const receiptPath = join(
    root,
    "evidence/aroma-provider/2026-10-24-packing/packing-probe-94dc4950-4c10-4c7c-ab2d-62e46ccb9d46.json",
  );
  const facts = JSON.parse(await readFile(factsPath, "utf8"));
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const proof = await loadAromaPackingWireProof(root);
  assert.deepEqual(proof, {
    providerOfferId: "445",
    packing: "Aroma",
    grindId: null,
    accountFingerprint:
      "sha256:2f8dd83aa108ac1734086d80886592520ec814ae4912bc0f0dcfc2deeceffe2f",
    receiptSha256:
      "63a9ad4b968dfdc4e405c1d31705596ec68c00c0243c1d04ef04c3a4d1160284",
    operatorSha256:
      "64b37305ce8abe73201caea5c8c8a63f5cba51eced58dde4549031a95e4760e2",
  });
  const binding = {
    offerRef: `off_${"0".repeat(26)}`,
    supplierRef: `sup_${"1".repeat(26)}`,
    rawProviderOfferId: "445",
  };
  assert.equal(
    assertAromaControlledOfferFacts(binding, {
      offerRef: binding.offerRef,
      supplierRef: binding.supplierRef,
      defaultPacking: "Aroma",
      accountFingerprint: proof.accountFingerprint,
      wireProof: proof,
    }),
    binding,
  );
  assert.equal(Object.hasOwn(binding, "packing"), false);
  assert.equal(Object.hasOwn(binding, "grindId"), false);
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(binding, {
        offerRef: binding.offerRef,
        supplierRef: binding.supplierRef,
        defaultPacking: "Aroma",
      }),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(binding, {
        offerRef: binding.offerRef,
        supplierRef: binding.supplierRef,
        defaultPacking: "Aroma",
        accountFingerprint: "sha256:wrong",
        wireProof: proof,
      }),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(
        { ...binding, rawProviderOfferId: "447" },
        {
          offerRef: binding.offerRef,
          supplierRef: binding.supplierRef,
          defaultPacking: "Aroma",
          accountFingerprint: proof.accountFingerprint,
          wireProof: proof,
        },
      ),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(binding, {
        offerRef: `off_${"2".repeat(26)}`,
        supplierRef: binding.supplierRef,
        defaultPacking: "Aroma",
        accountFingerprint: proof.accountFingerprint,
        wireProof: proof,
      }),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(
        { ...binding, packing: "Other", grindId: null },
        {
          offerRef: binding.offerRef,
          supplierRef: binding.supplierRef,
          defaultPacking: "Aroma",
          accountFingerprint: proof.accountFingerprint,
          wireProof: proof,
        },
      ),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  assert.throws(
    () =>
      assertAromaControlledOfferFacts(
        { ...binding, packing: "Aroma", grindId: "fine" },
        {
          offerRef: binding.offerRef,
          supplierRef: binding.supplierRef,
          defaultPacking: "Aroma",
          accountFingerprint: proof.accountFingerprint,
          wireProof: proof,
        },
      ),
    /AROMA_CONTROLLED_OFFER_FACTS_NOT_PROVEN/u,
  );
  for (const invalidFacts of [
    { ...facts, unexpected: true },
    { ...facts, providerOfferId: "447" },
    { ...facts, accountFingerprint: "sha256:wrong" },
    { ...facts, receiptSha256: "0".repeat(64) },
    { ...facts, operatorSha256: "0".repeat(64) },
    { ...facts, status: "NOT_PROVEN" },
    { ...facts, packing: "Other" },
    { ...facts, grindId: "fine" },
    { ...facts, quantity: 2 },
    { ...facts, baselineRestored: false },
  ])
    assert.throws(
      () => validateAromaPackingWireProof(invalidFacts, receipt),
      /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
    );
  for (const invalidReceipt of [
    { ...receipt, unexpected: true },
    { ...receipt, status: "FAIL" },
    { ...receipt, createdLineProven: false },
    { ...receipt, cleanupStatus: "NOT_CONFIRMED" },
    { ...receipt, accountFingerprint: "sha256:wrong" },
  ]) {
    assert.throws(
      () => validateAromaPackingWireProof(facts, invalidReceipt),
      /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
    );
  }

  let grants = 0;
  const gateway = {
    activateGrant() {
      grants++;
    },
  };
  assert.throws(
    () =>
      gateway.activateGrant(
        assertAromaApprovalForOffer(null, binding.offerRef),
      ),
    /AROMA_APPROVAL_OPERATION_SCOPE_INVALID/u,
  );
  assert.equal(grants, 0);
});

void test("G16 rejects missing, tampered, or symlinked packing proof sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "g16-packing-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "evidence/aroma-provider/2026-10-24-packing");
  await mkdir(directory, { recursive: true });
  const factsBytes = await readFile(
    join(
      process.cwd(),
      "evidence/aroma-provider/2026-10-24-packing/packing-wire-facts.json",
    ),
  );
  const receiptBytes = await readFile(
    join(
      process.cwd(),
      "evidence/aroma-provider/2026-10-24-packing/packing-probe-94dc4950-4c10-4c7c-ab2d-62e46ccb9d46.json",
    ),
  );
  const factsPath = join(directory, "packing-wire-facts.json");
  const receiptPath = join(
    directory,
    "packing-probe-94dc4950-4c10-4c7c-ab2d-62e46ccb9d46.json",
  );
  await assert.rejects(
    loadAromaPackingWireProof(root),
    /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
  );
  await writeFile(factsPath, factsBytes);
  await assert.rejects(
    loadAromaPackingWireProof(root),
    /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
  );
  await writeFile(receiptPath, receiptBytes);
  await writeFile(factsPath, Buffer.concat([factsBytes, Buffer.from(" ")]));
  await assert.rejects(
    loadAromaPackingWireProof(root),
    /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
  );
  await writeFile(factsPath, factsBytes);
  await writeFile(receiptPath, Buffer.concat([receiptBytes, Buffer.from(" ")]));
  await assert.rejects(
    loadAromaPackingWireProof(root),
    /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
  );
  await rm(factsPath);
  await symlink(receiptPath, factsPath);
  await assert.rejects(
    loadAromaPackingWireProof(root),
    /AROMA_PACKING_WIRE_PROOF_NOT_PROVEN/u,
  );
});

void test("G16 binds the mutator preparation GET and unsafe call to the approved cart phase and exact expiry", async () => {
  const [
    { ProviderCartMutator },
    { GatewayMutationExecutor },
    { decodeCartSnapshot },
  ] = await Promise.all([
    import("../../../apps/aroma-gateway/dist/application/provider-cart-mutator.js"),
    import("../../../apps/aroma-gateway/dist/domain/mutation-journal.js"),
    import("../../../apps/aroma-gateway/dist/infrastructure/provider/decoder.js"),
  ]);
  const offerRef = `off_${"0".repeat(26)}`;
  const operationRef = `op_${"1".repeat(26)}`;
  const identity = {
    offerRef,
    supplierRef: `sup_${"2".repeat(26)}`,
    rawProviderOfferId: "300000",
    rawProviderProductId: "300001",
    rawProviderVariantId: "300000",
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "a".repeat(64),
  };
  const rawCart = (products) =>
    Buffer.from(
      JSON.stringify({
        products,
        prices: {
          categories: [],
          weights: [],
          discounts: [],
          prices: [],
          total: { default: 0, promo: 0 },
        },
      }),
    );
  const ownLine = (quantity, extra = {}) => ({
    id: 300001,
    offer: { id: 300000, price: 10 },
    quantity,
    packing: "Aroma",
    grind_id: null,
    ...extra,
  });
  const credentials = {
    scopeRef: "aroma-primary",
    email: "operator@example.test",
    password: "unread",
  };
  const request = {
    operationRef,
    cartScopeRef: "aroma-primary",
    operationKind: "SetLineQuantity",
    offerRef,
    quantityMilli: "2",
  };
  const addRequest = { ...request, quantityMilli: "1" };
  const delegation = {
    transportCaller: "api-internal",
    issuer: "api-internal",
    audience: "aroma-gateway",
    originalCaller: "aroma-convergence",
    operationId: "setAromaCartLineQuantity",
    callerIdentity: "api-internal",
    correlationId: "123e4567-e89b-12d3-a456-426614174000",
  };

  for (const changedBody of [
    rawCart([ownLine(5)]),
    rawCart([{ ...ownLine(1), offer: { id: 900000, price: 10 } }]),
    rawCart([ownLine(1, { packing: "Other" })]),
    rawCart([ownLine(1, { grind_id: "8" })]),
  ]) {
    let unsafeCalls = 0;
    const session = {
      async *read() {
        yield changedBody;
      },
      async mutate() {
        unsafeCalls += 1;
        throw new Error("unsafe call must not happen");
      },
    };
    const sourceSessions = { acquire: async () => session };
    const sourceBindings = { resolveProviderOffer: async () => identity };
    const guard = createAromaProviderMutationGuard({
      phase: "lost-response",
      offerRef,
      expectedLines: [{ offerRef, quantity: "1" }],
      expiresAtEpochMs: Date.now() + 60_000,
      defaultPacking: "Aroma",
      decodeCartSnapshot,
      sessions: sourceSessions,
      bindings: sourceBindings,
    });
    const mutator = new ProviderCartMutator({
      sessions: guard.sessions,
      credentials,
      bindings: guard.bindings,
      supplierRef: identity.supplierRef,
      defaultPacking: "Aroma",
      transport: {
        mutate: async () => {
          unsafeCalls += 1;
          throw new Error("unsafe call must not happen");
        },
      },
    });
    await assert.rejects(
      mutator.prepare(request, new AbortController().signal),
      /AROMA_PREPARATION_CART_CHANGED/,
    );
    assert.equal(unsafeCalls, 0);
  }

  const makeExecutor = ({
    expiresAtEpochMs,
    now,
    readBody = rawCart([]),
    onRead,
    onMutate,
  }) => {
    let unknown;
    let unsafeCalls = 0;
    const session = {
      async *read() {
        yield readBody;
        onRead?.();
      },
      async mutate(operation, signal) {
        unsafeCalls += 1;
        return onMutate(operation, signal);
      },
    };
    const guard = createAromaProviderMutationGuard({
      phase: "single-mutation",
      offerRef,
      expectedLines: [],
      expiresAtEpochMs,
      defaultPacking: "Aroma",
      decodeCartSnapshot,
      sessions: { acquire: async () => session },
      bindings: { resolveProviderOffer: async () => identity },
      now,
    });
    const mutator = new ProviderCartMutator({
      sessions: guard.sessions,
      credentials,
      bindings: guard.bindings,
      supplierRef: identity.supplierRef,
      defaultPacking: "Aroma",
      transport: {
        mutate: async () => {
          throw new Error("session mutation seam missing");
        },
      },
    });
    const journal = {
      async reserve() {
        return unknown
          ? { kind: "UnknownOutcome", outcome: unknown }
          : { kind: "Reserved", reservation: {} };
      },
      async markDispatched() {
        return { kind: "DispatchPermitted", permit: {} };
      },
      async markUnknown(_permit, failureCode) {
        unknown = { state: "UnknownOutcome", failureCode, replayed: false };
        return unknown;
      },
      async acknowledge() {
        throw new Error("unexpected acknowledgement");
      },
      async reject() {
        throw new Error("unexpected rejection");
      },
    };
    const executor = new GatewayMutationExecutor(
      journal,
      mutator.execute.bind(mutator),
    );
    return {
      executor,
      get unsafeCalls() {
        return unsafeCalls;
      },
    };
  };

  let clock = 100;
  const expiredDuringPrepare = makeExecutor({
    expiresAtEpochMs: 105,
    now: () => clock,
    onRead: () => {
      clock = 106;
    },
    onMutate: async () => {
      throw new Error("unsafe call must not happen");
    },
  });
  const beforeDispatchOutcome = await expiredDuringPrepare.executor.execute(
    addRequest,
    delegation,
  );
  assert.equal(beforeDispatchOutcome.state, "UnknownOutcome");
  assert.equal(expiredDuringPrepare.unsafeCalls, 0);

  const expiresAtEpochMs = Date.now() + 500;
  const expiresInFlight = makeExecutor({
    expiresAtEpochMs,
    onMutate: async (_operation, signal) =>
      await new Promise((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
  });
  const dispatchedOutcome = await expiresInFlight.executor.execute(
    addRequest,
    delegation,
  );
  assert.equal(dispatchedOutcome.state, "UnknownOutcome");
  assert.equal(expiresInFlight.unsafeCalls, 1);
  assert.equal(
    (await expiresInFlight.executor.execute(addRequest, delegation)).state,
    "UnknownOutcome",
  );
  assert.equal(
    expiresInFlight.unsafeCalls,
    1,
    "replay of an uncertain operation must not redispatch the old operation",
  );
});

void test("G16 restart waits for exact DB-clock reservation eligibility within the canonical bound", async () => {
  const calls = [];
  const pauses = [];
  let monotonic = 10;
  const operationRef = `op_${"1".repeat(26)}`;
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            eligible_at: "2026-10-23T12:00:15.000Z",
            wait_ms: calls.length === 1 ? "25" : "0",
          },
        ],
      };
    },
  };
  const result = await waitForAromaRestartEligibility({
    ordersClient: client,
    operationRef,
    providerDeadlineMs: 10_000,
    safetyMarginMs: 5_000,
    retryBackoffMs: 5_000,
    signal: new AbortController().signal,
    monotonicNow: () => monotonic,
    pause: async (milliseconds) => {
      pauses.push(milliseconds);
      monotonic += milliseconds;
    },
  });
  assert.deepEqual(result, {
    eligibleAtUtc: "2026-10-23T12:00:15.000Z",
    waitMs: 25,
  });
  assert.deepEqual(pauses, [25]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].values, [operationRef]);
  assert.match(
    calls[0].sql,
    /GREATEST\(w\.next_attempt_at,r\.reserved_until\)/u,
  );
  assert.match(
    calls[0].sql,
    /r\.state='UnknownOutcome' AND r\.resolved_at IS NULL/u,
  );

  await assert.rejects(
    waitForAromaRestartEligibility({
      ordersClient: {
        query: async () => ({
          rows: [{ eligible_at: "2026-10-23T12:00:15.000Z", wait_ms: "22000" }],
        }),
      },
      operationRef,
      providerDeadlineMs: 10_000,
      safetyMarginMs: 5_000,
      retryBackoffMs: 5_000,
      pause: async () => {
        throw new Error("must reject wait beyond bound");
      },
    }),
    /AROMA_RESTART_ELIGIBILITY_UNAVAILABLE/,
  );
});

void test("G16 resolves only the exact approval environment placeholder and fails closed when absent", () => {
  assert.deepEqual(
    parseAromaArguments(
      ["--approval-file", "$AROMA_SANDBOX_APPROVAL_FILE"],
      {},
    ),
    { approvalFile: null },
  );
  assert.deepEqual(
    parseAromaArguments(["--approval-file", "$AROMA_SANDBOX_APPROVAL_FILE"], {
      AROMA_SANDBOX_APPROVAL_FILE: "/tmp/approval.json",
    }),
    { approvalFile: "/tmp/approval.json" },
  );
  assert.throws(
    () =>
      parseAromaArguments(["--approval-file", "$AROMA_SANDBOX_APPROVAL_FILE"], {
        AROMA_SANDBOX_APPROVAL_FILE: "relative.json",
      }),
    /AROMA_APPROVAL_FILE_PATH_MUST_BE_ABSOLUTE/,
  );
  assert.deepEqual(
    parseAromaArguments(["--", "--approval-file", "/tmp/approval.json"], {}),
    { approvalFile: "/tmp/approval.json" },
  );
});

void test("G16 cleanup failure always changes the gate decision to FAIL", () => {
  assert.deepEqual(
    normalizeCleanupFailureOutcome({
      status: "PASS",
      code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
      cleanup: { removed: false, failed: true },
    }),
    {
      status: "FAIL",
      code: "AROMA_RESOURCE_CLEANUP_FAILED",
      stage: "cleanup",
      cleanup: { removed: false, failed: true },
    },
  );
  assert.deepEqual(
    normalizeCleanupFailureOutcome({
      status: "PASS",
      code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
      cleanup: { removed: true },
    }),
    {
      status: "PASS",
      code: "CONTROLLED_LIVE_SCENARIO_COMPLETE",
      cleanup: { removed: true },
    },
  );
});

void test("G16 phase failure keeps bounded convergence evidence and strips unknown codes and payload fields", async () => {
  const secret = "PRIVATE_PROVIDER_BODY_CANARY";
  const rawConvergenceEvidence = {
    latestAttempt: {
      state: "Blocked",
      failure_code: "AROMA_MAPPING_NOT_AVAILABLE",
      blocker_codes: ["AROMA_MAPPING_NOT_AVAILABLE", secret],
      selected_action: "SetQuantity",
      selected_offer_matches: true,
      selected_offer_ref: secret,
      message: secret,
    },
    reservationStateCounts: [
      { state: "UnknownOutcome", count: "1" },
      { state: secret, count: "9" },
    ],
    gatewayJournalStateCounts: [{ state: "Acknowledged", count: "1" }],
    rawRows: secret,
  };
  const convergenceEvidence = safeAromaConvergenceEvidence(
    rawConvergenceEvidence,
  );
  assert.deepEqual(convergenceEvidence, {
    latestAttempt: {
      state: "Blocked",
      failureCode: "AROMA_MAPPING_NOT_AVAILABLE",
      blockerCodes: ["AROMA_MAPPING_NOT_AVAILABLE"],
      selectedAction: "SetQuantity",
      selectedOfferMatches: true,
    },
    reservationStateCounts: [{ state: "UnknownOutcome", count: 1 }],
    gatewayJournalStateCounts: [{ state: "Acknowledged", count: 1 }],
  });
  const failureEvidence = safeAromaPhaseFailureEvidence({
    completedPhases: [
      {
        phase: "baseline-read",
        status: "PASS",
        capturedAtUtc: "2026-10-23T18:45:55.113155109Z",
        providerPayload: secret,
      },
      {
        phase: "noop",
        status: "PASS",
        capturedAtUtc: "2026-10-23T12:00:00.000Z",
        providerPayload: secret,
      },
    ],
    failedPhase: "single-mutation",
    failedAtUtc: "2026-10-23T12:00:01.000Z",
    convergenceEvidence: rawConvergenceEvidence,
  });
  assert.deepEqual(failureEvidence, {
    partialPhaseEvidence: [
      {
        phase: "baseline-read",
        status: "PASS",
        capturedAtUtc: "2026-10-23T18:45:55.113155109Z",
      },
      {
        phase: "noop",
        status: "PASS",
        capturedAtUtc: "2026-10-23T12:00:00.000Z",
      },
      {
        phase: "single-mutation",
        status: "FAIL",
        capturedAtUtc: "2026-10-23T12:00:01.000Z",
      },
    ],
    convergenceEvidence,
  });
  assert.doesNotMatch(JSON.stringify(failureEvidence), new RegExp(secret, "u"));
  const previousNoopEvidence = safeAromaConvergenceEvidence({
    latestAttempt: {
      state: "NoOpInSync",
      failure_code: null,
      blocker_codes: [],
      selected_action: null,
      selected_offer_matches: null,
    },
    reservationStateCounts: [],
    gatewayJournalStateCounts: [],
  });
  const failedPhaseError = new Error("private failure after possible dispatch");
  failedPhaseError.phaseFailureFacts = await captureAromaPhaseFailureFacts({
    completedPhases: [
      {
        phase: "noop",
        status: "PASS",
        capturedAtUtc: "2026-10-23T12:00:00.000Z",
      },
    ],
    failedPhase: "single-mutation",
    readLatestEvidence: async () => {
      throw new Error(secret);
    },
  });
  const consumedBySandboxRun = safeAromaPhaseFailureEvidence(
    failedPhaseError.phaseFailureFacts,
  );
  assert.equal(
    consumedBySandboxRun.partialPhaseEvidence.at(-1).phase,
    "single-mutation",
  );
  assert.equal(consumedBySandboxRun.partialPhaseEvidence.at(-1).status, "FAIL");
  assert.equal(consumedBySandboxRun.convergenceEvidence, undefined);
  assert.equal(
    JSON.stringify(consumedBySandboxRun).includes(
      previousNoopEvidence.latestAttempt.state,
    ),
    false,
  );
  assert.doesNotMatch(
    JSON.stringify(consumedBySandboxRun),
    new RegExp(secret, "u"),
  );
  assert.equal(
    safeAromaPhaseFailureEvidence({
      completedPhases: [],
      failedPhase: "private",
      failedAtUtc: "2026-10-23T12:00:01.000Z",
    }),
    null,
  );
  assert.equal(
    safeAromaPhaseFailureEvidence({
      completedPhases: [],
      failedPhase: "single-mutation",
      failedAtUtc: "2026-10-23T12:00:01.1234567890Z",
    }),
    null,
  );
});

void test("G16 real catalog export preserves safe recordBatch failure facts through importer terminal record", async () => {
  const { DatabaseTransactionError } =
    await import("../../../packages/platform-database/dist/index.js");
  const {
    CATALOG_SOURCE_IDENTITY_SCHEME,
    createCatalogExportStream,
    sha256CatalogHash,
  } =
    await import("../../../apps/aroma-gateway/dist/application/catalog-export.js");
  const { newSnapshotRef, runCatalogImport } =
    await import("../../../apps/catalog-supplier-sync/dist/run-catalog-import.js");
  const { readNdjson } =
    await import("../../../apps/catalog-supplier-sync/dist/ndjson-reader.js");
  const { aromaCatalogErrorFacts, createAromaCatalogStageFailure } =
    await import("./scenarios/aroma-sandbox-catalog.mjs");
  const secretMessage = "private SQL statement and provider response";
  const databaseError = new DatabaseTransactionError(
    "DB_QUERY_FAILED",
    {},
    "23505",
  );
  databaseError.message = secretMessage;
  const snapshotRef = newSnapshotRef();
  const supplierRef = "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const events = [];
  let persistenceFailureFacts = null;
  const capturePersistenceFailure = captureAromaCatalogPersistenceFailure(
    async () => {
      events.push("recordBatch");
      throw databaseError;
    },
    (error) => {
      persistenceFailureFacts = aromaCatalogErrorFacts(error);
    },
  );
  const stream = createCatalogExportStream({
    source: {
      async *[Symbol.asyncIterator]() {
        yield {
          displayName: "Coffee",
          unit: "piece",
          supplierUnitMinor: "100",
          currency: "RUB",
          availability: "Available",
          imageUrl: null,
          supplierPromotions: [],
          product: 1,
          variant: 1,
        };
      },
    },
    request: {
      snapshotRef,
      supplierRef,
      providerSnapshotRef: "g16-test-export",
    },
    boundary: {
      identity: () => ({
        supplierRef,
        sourceIdentityScheme: CATALOG_SOURCE_IDENTITY_SCHEME,
        sourceProductKeyHash: "1".repeat(64),
        sourceVariantKeyHash: "2".repeat(64),
        sourceOfferKeyHash: "3".repeat(64),
        rawProviderProductId: "product-1",
        rawProviderVariantId: "variant-1",
        rawProviderOfferId: "offer-1",
      }),
      hash: sha256CatalogHash,
      persistence: {
        beginExport: async () => {
          events.push("beginExport");
        },
        recordBatch: capturePersistenceFailure,
        completeExport: async () => {
          events.push("completeExport");
        },
        failExport: async ({ errorCode }) => {
          events.push(`failExport:${errorCode}`);
        },
      },
    },
    signal: new AbortController().signal,
    limits: { maxOffersPerBatch: 1 },
  });
  const emitted = [];
  let importerError;
  try {
    await runCatalogImport({
      store: {
        async create() {},
        async acceptStarted() {
          events.push("acceptStarted");
        },
        async reject(_ref, code) {
          events.push(`reject:${code}`);
        },
      },
      supplierRef,
      snapshotRef,
      signal: new AbortController().signal,
      deadlineMs: 10_000,
      context: { correlationId: "g16-diagnostic-test" },
      exportCatalog: async function* () {
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          emitted.push(bytes.toString("utf8"));
          yield* readNdjson(Readable.from([bytes]));
        }
      },
    });
  } catch (error) {
    importerError = error;
  }

  assert.equal(importerError?.code, "SNAPSHOT_FAILED_INVALID_STREAM");
  assert.deepEqual(events, [
    "beginExport",
    "acceptStarted",
    "recordBatch",
    "failExport:INVALID_STREAM",
    "reject:INVALID_STREAM",
  ]);
  assert.deepEqual(persistenceFailureFacts, {
    ownerCode: "DB_QUERY_FAILED",
    sqlState: "23505",
  });
  const failure = createAromaCatalogStageFailure(
    "catalog-import",
    importerError,
    persistenceFailureFacts,
  );
  const diagnostic = safeAromaDiagnostic(failure);
  assert.deepEqual(diagnostic, {
    substage: "catalog-import",
    ownerCode: "SNAPSHOT_FAILED_INVALID_STREAM",
    sqlState: "23505",
    causeCode: "DB_QUERY_FAILED",
  });
  assert.equal(safeAromaFailureCode(failure), "AROMA_CATALOG_STAGE_FAILED");
  assert.equal(
    emitted.some((line) => line.includes(secretMessage)),
    false,
  );
  assert.throws(
    () => createAromaCatalogStageFailure("/tmp/private", importerError),
    /AROMA_CATALOG_STAGE_INVALID/u,
  );
  assert.equal(
    safeAromaDiagnostic(
      Object.assign(new Error("leak"), {
        safeDiagnostic: {
          substage: "catalog-import",
          ownerCode: "private provider payload",
        },
      }),
    ),
    null,
  );
});

void test("AROMA Desired fixture appends only monotonic revision, line and work facts atomically", async () => {
  const calls = [];
  const ownerClient = {
    async query(sql, parameters = []) {
      calls.push({ sql: String(sql).replace(/\s+/gu, " ").trim(), parameters });
      return calls
        .at(-1)
        .sql.startsWith("SELECT (COALESCE(max(desired_revision)")
        ? { rows: [{ revision: "1" }] }
        : { rows: [] };
    },
  };
  const { revision, desiredHash } = await appendAromaSandboxDesired(
    ownerClient,
    [{ offerRef: `off_${"0".repeat(26)}`, quantityMilli: "1000" }],
  );
  assert.equal(revision, "1");
  assert.match(desiredHash, /^[a-f0-9]{64}$/u);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-1).sql, "COMMIT");
  const writes = calls
    .map(({ sql }) => sql)
    .filter((sql) => /^(?:INSERT|UPDATE) /u.test(sql));
  assert.deepEqual(
    writes.map((sql) => sql.match(/(?:INTO|UPDATE) orders\.([a-z_]+)/u)?.[1]),
    [
      "cart_desired_revisions",
      "cart_desired_revisions",
      "cart_desired_lines",
      "convergence_work",
    ],
  );
  assert.ok(
    writes.every(
      (sql) =>
        !/cart_observed|convergence_attempt|mutation_reservation|convergence_lease|recovery/u.test(
          sql,
        ),
    ),
  );
  await assert.rejects(
    appendAromaSandboxDesired(ownerClient, [
      { offerRef: `off_${"0".repeat(26)}`, quantityMilli: "3000" },
    ]),
    /AROMA_DESIRED_FIXTURE_INVALID/,
  );
});

void test("G16 migration helper creates its checksum ledger before grants and rolls back DDL with ledger rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coffee-g16-migrations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "apps/catalog-service/migrations");
  await mkdir(directory, { recursive: true });
  const migrations = [
    [
      "0001_supplier_snapshots.sql",
      "CREATE TABLE catalog.supplier_snapshots(value text);",
    ],
    [
      "0007_catalog_grants.sql",
      "REVOKE ALL ON TABLE catalog.platform_schema_migrations;",
    ],
  ];
  for (const [name, sql] of migrations)
    await writeFile(join(directory, name), sql);
  const migrationTools =
    await import("../../../packages/platform-migrations/dist/index.js");
  const makeClient = ({ failOnGrant = false } = {}) => {
    const calls = [];
    let ledgerCreated = false;
    let staged = [];
    const committed = [];
    const client = {
      calls,
      committed,
      async query(sql, parameters = []) {
        calls.push({
          sql: String(sql).replace(/\s+/gu, " ").trim(),
          parameters,
        });
        if (sql === "BEGIN") {
          staged = [];
          return { rows: [] };
        }
        if (sql === "COMMIT") {
          committed.push(...staged);
          staged = [];
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          staged = [];
          return { rows: [] };
        }
        if (
          String(sql).includes(
            "CREATE TABLE IF NOT EXISTS catalog.platform_schema_migrations",
          )
        ) {
          ledgerCreated = true;
          return { rows: [] };
        }
        if (
          String(sql).startsWith(
            "SELECT id,checksum FROM catalog.platform_schema_migrations",
          )
        )
          return { rows: [...committed, ...staged] };
        if (
          String(sql).startsWith(
            "INSERT INTO catalog.platform_schema_migrations",
          )
        ) {
          staged.push({ id: parameters[0], checksum: parameters[1] });
          return { rows: [] };
        }
        if (String(sql).startsWith("REVOKE ALL")) {
          assert.equal(
            ledgerCreated,
            true,
            "grants migration must see its ledger table",
          );
          if (failOnGrant) {
            const error = new Error("raw SQL details must not escape");
            error.code = "42P01";
            throw error;
          }
        }
        return { rows: [] };
      },
    };
    return client;
  };
  const success = makeClient();
  assert.equal(
    await applyCanonicalMigrations(root, success, "catalog", migrationTools),
    2,
  );
  assert.equal(success.calls[0].sql, "BEGIN");
  const ledgerCreateIndex = success.calls.findIndex(({ sql }) =>
    sql.includes(
      "CREATE TABLE IF NOT EXISTS catalog.platform_schema_migrations",
    ),
  );
  const grantIndex = success.calls.findIndex(({ sql }) =>
    sql.startsWith("REVOKE ALL"),
  );
  assert.ok(ledgerCreateIndex >= 0 && ledgerCreateIndex < grantIndex);
  assert.equal(success.committed.length, 2);
  assert.deepEqual(
    success.committed.map(({ id }) => id),
    ["0001_supplier_snapshots", "0007_catalog_grants"],
  );
  assert.deepEqual(
    success.committed.map(({ checksum }) => checksum),
    migrations.map(([, sql]) => migrationTools.migrationChecksum(sql)),
  );
  assert.equal(success.calls.at(-1).sql, "COMMIT");

  const failure = makeClient({ failOnGrant: true });
  await assert.rejects(
    applyCanonicalMigrations(root, failure, "catalog", migrationTools),
    (error) => {
      assert.equal(error.message, "AROMA_MIGRATION_SQLSTATE_42P01");
      assert.deepEqual(error.safeDiagnostic, {
        migrationId: "0007_catalog_grants",
        sqlState: "42P01",
      });
      return true;
    },
  );
  assert.equal(
    failure.committed.length,
    0,
    "preceding DDL and ledger row roll back atomically",
  );
  assert.equal(failure.calls.at(-1).sql, "ROLLBACK");
});

void test("private AROMA proxy drops only a complete validated Gateway acknowledgment", async (t) => {
  const offerRef = `off_${"0".repeat(26)}`;
  const operationRef = `op_${"1".repeat(26)}`;
  let upstreamMutations = 0;
  const gateway = createServer(async (request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ availability: "Available" }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstreamMutations += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        operationRef: body.operationRef,
        cartScopeRef: "aroma-primary",
        offerRef,
        state: "Acknowledged",
      }),
    );
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const target = gateway.address();
  assert.ok(target && typeof target !== "string");
  const proxy = await startAcknowledgementDropProxy({
    upstreamPort: target.port,
  });
  t.after(() => proxy.close());
  const request = (ref) =>
    fetch(
      `${proxy.url}/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationRef: ref,
          cartScopeRef: "aroma-primary",
          quantity: "1",
        }),
      },
    );
  await assert.rejects(
    request(operationRef),
    /fetch failed|socket hang up|reset/i,
  );
  assert.equal(upstreamMutations, 1);
  assert.deepEqual(proxy.droppedAcknowledgements, [
    { operationRef, offerRef, state: "Acknowledged", responseDropped: true },
  ]);
  const second = await request(`op_${"2".repeat(26)}`);
  assert.equal(second.status, 200);
  assert.equal(upstreamMutations, 2);
  assert.equal(proxy.droppedAcknowledgements.length, 1);
  const catalog = await fetch(
    `${proxy.url}/api/internal-v1/catalog/products/prd_${"2".repeat(26)}/variants/var_${"3".repeat(26)}/pricing-input`,
  );
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), { availability: "Available" });
  assert.equal(proxy.droppedAcknowledgements.length, 1);
});

void test("AROMA admission reads only contract files matching the candidate commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "launch-aroma-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contractFiles = [
    "config/platform.yaml",
    "config/platform.schema.json",
    "config/nginx-profile.schema.json",
    "secrets/platform.secrets.sops.yaml",
    "verification/launch/v1/schemas/aroma-approval.schema.json",
  ];
  for (const path of contractFiles) {
    const target = join(root, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, `committed ${path}\n`);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", ...contractFiles], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Launch Test",
      "-c",
      "user.email=launch@example.invalid",
      "commit",
      "-qm",
      "candidate",
    ],
    { cwd: root },
  );
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();

  assert.doesNotThrow(() =>
    assertAdmissionContractMatchesCandidate(root, candidateSha),
  );
  const generated = join(root, "verification/generated/types.d.ts");
  await mkdir(join(generated, ".."), { recursive: true });
  await writeFile(generated, "generated outside admission contract\n");
  assert.doesNotThrow(() =>
    assertAdmissionContractMatchesCandidate(root, candidateSha),
  );

  const configPath = join(root, "config/platform.yaml");
  await writeFile(configPath, "changed trusted policy\n");
  assert.throws(
    () => assertAdmissionContractMatchesCandidate(root, candidateSha),
    /ADMISSION_CONTRACT_DIFFERS_FROM_CANDIDATE/,
  );
  await writeFile(configPath, "committed config/platform.yaml\n");

  const approvalSentinel = join(root, "approval.json");
  const hiddenKey = generateKeyPairSync("ed25519").publicKey;
  const hiddenOrigin = "https://sandbox.aroma.invalid";
  const hiddenFingerprint = `sha256:${"c".repeat(64)}`;
  const hiddenPolicy = JSON.stringify({
    environment: "staging",
    verification: {
      aromaSandbox: {
        mode: "controlled-live-existing-account",
        origin: hiddenOrigin,
        accountFingerprint: hiddenFingerprint,
        credentialRefs: ["aroma.email", "aroma.password"],
        existingAccountException: {
          authority: "user-2026-10-23",
          origin: hiddenOrigin,
          accountFingerprint: hiddenFingerprint,
        },
        productionOrigins: [],
        productionAccountFingerprints: [],
        trustedApprovers: [
          {
            keyId: "synthetic-key",
            approver: "synthetic-owner",
            publicKeyPem: hiddenKey.export({ type: "spki", format: "pem" }),
          },
        ],
        resourceLimits: { postgresMemoryMiB: 1024, postgresTmpfsMiB: 512 },
      },
    },
  });
  await writeFile(
    configPath,
    "environment: staging\nverification:\n  aromaSandbox: null\n",
  );
  execFileSync("git", ["add", "config/platform.yaml"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Launch Test",
      "-c",
      "user.email=launch@example.invalid",
      "commit",
      "-qm",
      "null policy candidate",
    ],
    { cwd: root },
  );
  const nullPolicySha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  await writeFile(configPath, hiddenPolicy);
  execFileSync(
    "git",
    ["update-index", "--assume-unchanged", "--", "config/platform.yaml"],
    { cwd: root },
  );
  assert.throws(
    () => assertAdmissionContractMatchesCandidate(root, nullPolicySha),
    /ADMISSION_CONTRACT_INDEX_FLAGS_INVALID/,
  );
  assert.equal(
    await readFile(approvalSentinel).then(
      () => true,
      () => false,
    ),
    false,
  );
  execFileSync(
    "git",
    ["update-index", "--no-assume-unchanged", "--", "config/platform.yaml"],
    { cwd: root },
  );
  await writeFile(
    configPath,
    "environment: staging\nverification:\n  aromaSandbox: null\n",
  );

  const schemaPath = join(root, "config/platform.schema.json");
  await writeFile(schemaPath, "staged trusted schema\n");
  execFileSync("git", ["add", "config/platform.schema.json"], { cwd: root });
  assert.throws(
    () => assertAdmissionContractMatchesCandidate(root, candidateSha),
    /ADMISSION_CONTRACT_DIFFERS_FROM_CANDIDATE/,
  );

  for (const path of [
    "config/platform.schema.json",
    "verification/launch/v1/schemas/aroma-approval.schema.json",
  ]) {
    execFileSync("git", ["update-index", "--skip-worktree", "--", path], {
      cwd: root,
    });
    assert.throws(
      () => assertAdmissionContractMatchesCandidate(root, candidateSha),
      /ADMISSION_CONTRACT_INDEX_FLAGS_INVALID/,
    );
    execFileSync("git", ["update-index", "--no-skip-worktree", "--", path], {
      cwd: root,
    });
  }

  const inventoryPath = join(root, "secrets/platform.secrets.sops.yaml");
  await writeFile(inventoryPath, "ciphertext bytes changed\n");
  assert.throws(
    () => assertAdmissionContractMatchesCandidate(root, candidateSha),
    /ADMISSION_CONTRACT_DIFFERS_FROM_CANDIDATE/,
  );

  const incompleteRoot = await mkdtemp(
    join(tmpdir(), "launch-aroma-missing-contract-"),
  );
  t.after(() => rm(incompleteRoot, { recursive: true, force: true }));
  const missingPath = "secrets/platform.secrets.sops.yaml";
  const committedPaths = contractFiles.filter((path) => path !== missingPath);
  for (const path of committedPaths) {
    const target = join(incompleteRoot, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, `committed ${path}\n`);
  }
  execFileSync("git", ["init", "-q"], { cwd: incompleteRoot });
  execFileSync("git", ["add", ...committedPaths], { cwd: incompleteRoot });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Launch Test",
      "-c",
      "user.email=launch@example.invalid",
      "commit",
      "-qm",
      "incomplete candidate",
    ],
    { cwd: incompleteRoot },
  );
  const incompleteSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: incompleteRoot,
    encoding: "utf8",
  }).trim();
  assert.throws(
    () =>
      assertAdmissionContractMatchesCandidate(incompleteRoot, incompleteSha),
    /ADMISSION_CONTRACT_MISSING_FROM_CANDIDATE/,
  );
  const untrackedMissingPath = join(incompleteRoot, missingPath);
  await mkdir(join(untrackedMissingPath, ".."), { recursive: true });
  await writeFile(untrackedMissingPath, "untracked trusted inventory\n");
  assert.throws(
    () =>
      assertAdmissionContractMatchesCandidate(incompleteRoot, incompleteSha),
    /ADMISSION_CONTRACT_MISSING_FROM_CANDIDATE/,
  );
});

void test("pnpm forwards the approval-file argument after its separator to the offline CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-aroma-approval-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const approvalFile = join(directory, "approval.json");
  for (const contextPath of ["", join(directory, "missing-context.json")]) {
    const result = spawnSync(
      "pnpm",
      ["launch:verify:aroma-approval", "--", "--approval-file", approvalFile],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 16 * 1024,
        env: {
          ...process.env,
          COFFEE_LAUNCH_CONTEXT_FILE: contextPath,
          pnpm_config_verify_deps_before_run: "false",
        },
      },
    );
    assert.equal(result.status, 78, result.stderr);
    assert.match(
      result.stdout,
      /"approvalAdmission":"NOT_RUN","code":"LAUNCH_CONTEXT_ABSENT"/,
    );
  }
});

void test("G04, G08, G09, G10, G11, G12, G13, G14, G17 and G18 forward the verified launch context to gate commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-owner-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextPath = "/tmp/coffee-launch-context-proof.json";
  const scripts = Object.fromEntries(
    [
      ["test:integration", 41],
      ["test:recovery", 43],
      ["test:compose-smoke", 47],
      ["test:observability", 48],
      ["test:mutation-disable-rollback", 45],
      ["security:scan", 49],
      ["test:backup-restore", 51],
      ["test:migrations:clean", 55],
      ["test:migrations:forward", 57],
      ["db:smoke", 59],
    ].map(([name, code]) => [
      name,
      `node -e "process.exit(process.env.COFFEE_LAUNCH_CONTEXT_FILE === '${contextPath}' ? ${code} : 91)"`,
    ]),
  );
  scripts["test:unit"] =
    `node -e "process.exit(process.env.COFFEE_LAUNCH_CONTEXT_FILE === '${contextPath}' && process.argv.includes('--coverage') ? 53 : 91)"`;
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "launch-owner-context-fixture",
      version: "1.0.0",
      packageManager: "pnpm@11.24.0",
      scripts,
    }),
  );
  for (const [command, expectedExit] of [
    ["test:integration", 41],
    ["test:recovery", 43],
    ["test:compose-smoke", 47],
    ["test:observability", 48],
    ["test:mutation-disable-rollback", 45],
    ["security:scan", 49],
    ["test:backup-restore", 51],
    ["test:migrations:clean", 55],
    ["test:migrations:forward", 57],
    ["db:smoke", 59],
  ]) {
    const result = await executeArgv(
      ["pnpm", command],
      directory,
      30_000,
      join(directory, `${command}.stdout.log`),
      join(directory, `${command}.stderr.log`),
      contextPath,
    );
    assert.equal(result.exitCode, expectedExit, command);
    await assert.rejects(access(join(directory, "node_modules")), {
      code: "ENOENT",
    });
  }
  const unit = await executeArgv(
    ["pnpm", "test:unit", "--", "--coverage"],
    directory,
    30_000,
    join(directory, "test-unit.stdout.log"),
    join(directory, "test-unit.stderr.log"),
    contextPath,
  );
  assert.equal(unit.exitCode, 53);
});

void test("G04 classifies changed critical source roots and enforces emitted-JS LCOV and no skipped unit tests", () => {
  const modules = [
    {
      id: "orders",
      sourceRoots: ["apps/orders-service/src"],
      coverageRoots: ["apps/orders-service/dist"],
      format: "js",
    },
    {
      id: "bootstrap",
      sourceRoots: ["tools/config-bootstrap"],
      coverageRoots: ["tools/config-bootstrap"],
      format: "mjs",
    },
  ];
  assert.deepEqual(
    changedCriticalModules(
      [
        "apps/orders-service/src/domain/order.js",
        "tests/orders/order-card.test.mjs",
        "apps/orders-service/migrations/0001.sql",
      ],
      modules,
    ).map(({ id }) => id),
    ["orders"],
  );
  assert.deepEqual(
    changedCriticalModules(
      ["apps/orders-service/src/domain/order.d.ts"],
      modules,
    ),
    [],
  );
  assert.deepEqual(
    changedCriticalModules(
      ["apps/orders-service/src/domain/removed-handler.js"],
      modules,
    ).map(({ id }) => id),
    ["orders"],
  );
  assert.deepEqual(
    changedCriticalModules(["tools/config-bootstrap/index.mjs"], modules).map(
      ({ id }) => id,
    ),
    ["bootstrap"],
  );
  const file = join(process.cwd(), "apps/orders-service/dist/domain/order.js");
  const records = parseLcovRecords(
    `TN:\nSF:${file}\nLF:100\nLH:90\nFNF:10\nFNH:9\nBRF:20\nBRH:17\nend_of_record\n`,
  );
  const result = coverageForModule(records, [file], modules[0], {
    lines: 90,
    functions: 90,
    branches: 85,
  });
  assert.equal(result.passed, true);
  const extraRecord = (path) =>
    `TN:\nSF:${path}\nLF:10000\nLH:10000\nFNF:1000\nFNH:1000\nBRF:1000\nBRH:1000\nend_of_record\n`;
  const ignoredRecords = parseLcovRecords(
    [
      extraRecord(`${file.slice(0, -3)}.d.ts`),
      extraRecord(
        join(process.cwd(), "apps/orders-service/dist/generated/runtime.js"),
      ),
      extraRecord(
        join(process.cwd(), "apps/orders-service/dist/internal.gen.js"),
      ),
    ].join(""),
  );
  const withIgnoredRecords = coverageForModule(
    [...records, ...ignoredRecords],
    [file],
    modules[0],
    { lines: 90, functions: 90, branches: 85 },
  );
  assert.deepEqual(
    withIgnoredRecords.metrics,
    result.metrics,
    "declarations and generated artifacts must not alter emitted-JS module metrics",
  );
  const unexpectedJs = parseLcovRecords(
    extraRecord(join(process.cwd(), "apps/orders-service/dist/unexpected.js")),
  );
  assert.throws(
    () =>
      coverageForModule([...records, ...unexpectedJs], [file], modules[0], {
        lines: 90,
        functions: 90,
        branches: 85,
      }),
    /COVERAGE_FILE_SET_MISMATCH/u,
  );
  const catalog = {
    id: "catalog",
    sourceRoots: ["apps/catalog-service/src"],
    coverageRoots: ["apps/catalog-service/dist"],
    format: "js",
  };
  const catalogFile = join(
    process.cwd(),
    "apps/catalog-service/dist/events.js",
  );
  const catalogRecord = (sourcePath) =>
    parseLcovRecords(
      `TN:\nSF:${sourcePath}\nLF:10\nLH:9\nFNF:2\nFNH:2\nBRF:4\nBRH:4\nend_of_record\n`,
    );
  const absoluteCatalog = coverageForModule(
    catalogRecord(catalogFile),
    [catalogFile],
    catalog,
    { lines: 90, functions: 90, branches: 85 },
  );
  const relativeCatalog = coverageForModule(
    catalogRecord("apps/catalog-service/dist/events.js"),
    [catalogFile],
    catalog,
    { lines: 90, functions: 90, branches: 85 },
  );
  assert.deepEqual(relativeCatalog.metrics, absoluteCatalog.metrics);
  assert.equal(relativeCatalog.passed, absoluteCatalog.passed);
  assert.throws(
    () =>
      coverageForModule(records, [file, `${file}.missing.js`], modules[0], {
        lines: 90,
        functions: 90,
        branches: 85,
      }),
    /COVERAGE_FILE_SET_MISMATCH/u,
  );
  assert.deepEqual(
    parseUnitTapSummary(
      "TAP version 13\n1..2\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
    ),
    { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
  );
  assert.throws(
    () =>
      parseUnitTapSummary(
        "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n",
      ),
    /UNIT_TESTS_FAILED_OR_SKIPPED/u,
  );
  assert.deepEqual(
    parseTapSummaryDiagnostic(
      "TAP version 13\n1..1\n# tests 1\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n",
    ),
    {
      summary: {
        tests: 1,
        pass: 0,
        fail: 0,
        cancelled: 0,
        skipped: 1,
        todo: 0,
      },
      code: "UNIT_TESTS_FAILED_OR_SKIPPED",
    },
  );
  assert.throws(
    () =>
      parseLcovRecords(
        "TN:\nSF:../outside.js\nLF:1\nLH:1\nFNF:1\nFNH:1\nBRF:1\nBRH:1\nend_of_record\n",
      ),
    /LCOV_RECORD_INVALID/u,
  );
  assert.throws(
    () =>
      parseLcovRecords(
        "TN:\nSF:apps/catalog-service/../../outside.js\nLF:1\nLH:1\nFNF:1\nFNH:1\nBRF:1\nBRH:1\nend_of_record\n",
      ),
    /LCOV_RECORD_INVALID/u,
  );
  const validRecord = `TN:\nSF:${file}\nLF:100\nLH:90\nFNF:10\nFNH:9\nBRF:20\nBRH:17\nend_of_record\n`;
  for (const malformed of [
    validRecord.replace("LH:90", "LH:101"),
    validRecord.replace("FNH:9", "FNH:11"),
    validRecord.replace("BRH:17", "BRH:21"),
  ]) {
    assert.throws(() => parseLcovRecords(malformed), /LCOV_HITS_EXCEED_FOUND/u);
  }
  const hugeRecords = parseLcovRecords(
    ["one.js", "two.js"]
      .map(
        (name) =>
          `TN:\nSF:${join(process.cwd(), "apps/orders-service/dist", name)}\nLF:9007199254740991\nLH:9007199254740991\nFNF:1\nFNH:1\nBRF:1\nBRH:1\nend_of_record\n`,
      )
      .join(""),
  );
  const hugeFiles = hugeRecords.map(({ path }) => path);
  assert.throws(
    () =>
      coverageForModule(hugeRecords, hugeFiles, modules[0], {
        lines: 90,
        functions: 90,
        branches: 85,
      }),
    /LCOV_AGGREGATE_COUNTER_INVALID/u,
  );
});

void test("G04 preserves private run-scoped TAP/LCOV diagnostics once without overwriting", async (t) => {
  const sourceRepoRoot = await mkdtemp(
    join(tmpdir(), "launch-g04-artifact-root-"),
  );
  t.after(() => rm(sourceRepoRoot, { recursive: true, force: true }));
  const candidateSha = "a".repeat(40);
  const runId = `20261024T120000Z-${candidateSha.slice(0, 7)}`;
  const evidenceDir = join(sourceRepoRoot, "evidence/launch", runId);
  const artifactsDir = join(evidenceDir, "gates/G04_UNIT/artifacts");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  const context = { runId, candidateSha, sourceRepoRoot, evidenceDir };
  const contents = {
    "unit.tap": "private TAP\n",
    "coverage.lcov": "private LCOV\n",
    "unit-diagnostics.json": "{}\n",
  };
  const receipts = await writeUnitEvidenceArtifacts(context, contents);
  assert.deepEqual(
    receipts
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right)),
    Object.keys(contents).sort((left, right) => left.localeCompare(right)),
  );
  assert.deepEqual(
    receipts
      .map(({ path }) => path)
      .sort((left, right) => left.localeCompare(right)),
    Object.keys(contents)
      .map((name) => join(artifactsDir, name))
      .sort((left, right) => left.localeCompare(right)),
  );
  for (const name of Object.keys(contents)) {
    const path = join(artifactsDir, name);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), contents[name]);
  }
  await assert.rejects(
    writeUnitEvidenceArtifacts(context, { "unit.tap": "replacement\n" }),
    { code: "EEXIST" },
  );
  assert.equal(
    await readFile(join(artifactsDir, "unit.tap"), "utf8"),
    contents["unit.tap"],
  );
  await assert.rejects(
    writeUnitEvidenceArtifacts(
      { ...context, runId: "20261024T120001Z-bbbbbbb" },
      { "unit.tap": "wrong run\n" },
    ),
    /UNIT_EVIDENCE_IDENTITY_INVALID/u,
  );
});

void test("G04 rejects a symlinked evidence/launch ancestor before writing artifacts", async (t) => {
  const sourceRepoRoot = await mkdtemp(
    join(tmpdir(), "launch-g04-symlink-root-"),
  );
  const outsideRoot = await mkdtemp(
    join(tmpdir(), "launch-g04-symlink-target-"),
  );
  t.after(() =>
    Promise.all([
      rm(sourceRepoRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]),
  );
  const candidateSha = "a".repeat(40);
  const runId = `20261024T120000Z-${candidateSha.slice(0, 7)}`;
  const evidenceDir = join(sourceRepoRoot, "evidence/launch", runId);
  const outsideLaunch = join(outsideRoot, "launch");
  const outsideArtifactsDir = join(
    outsideLaunch,
    runId,
    "gates/G04_UNIT/artifacts",
  );
  await mkdir(join(sourceRepoRoot, "evidence"), { recursive: true });
  await mkdir(outsideArtifactsDir, { recursive: true, mode: 0o700 });
  await symlink(outsideLaunch, join(sourceRepoRoot, "evidence/launch"));
  await assert.rejects(
    writeUnitEvidenceArtifacts(
      { runId, candidateSha, sourceRepoRoot, evidenceDir },
      { "unit.tap": "must not escape\n" },
    ),
    /UNIT_EVIDENCE_DIRECTORY_INVALID/u,
  );
  await assert.rejects(readFile(join(outsideArtifactsDir, "unit.tap")), {
    code: "ENOENT",
  });
});

void test("G04 unit child excludes bootstrap and operator locators while preserving the launch context and coverage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-g04-child-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = {
    SOPS_AGE_KEY_FILE: "/synthetic/bootstrap-key",
    AROMA_SANDBOX_APPROVAL_FILE: "/synthetic/operator-approval",
    COFFEE_LAUNCH_CONTEXT_FILE: "/synthetic/context",
    NODE_V8_COVERAGE: directory,
    COFFEE_G04_ENV_TEST: "ordinary-value",
  };
  const original = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    const child = runUnitTestChild([
      "-e",
      `process.stdout.write(JSON.stringify({
        noSops: !Object.hasOwn(process.env, "SOPS_AGE_KEY_FILE"),
        noApproval: !Object.hasOwn(process.env, "AROMA_SANDBOX_APPROVAL_FILE"),
        context: process.env.COFFEE_LAUNCH_CONTEXT_FILE === "/synthetic/context",
        coverage: process.env.NODE_V8_COVERAGE === ${JSON.stringify(directory)},
        ordinary: process.env.COFFEE_G04_ENV_TEST === "ordinary-value"
      }))`,
    ]);
    assert.equal(child.status, 0);
    assert.deepEqual(JSON.parse(child.stdout), {
      noSops: true,
      noApproval: true,
      context: true,
      coverage: true,
      ordinary: true,
    });
    for (const [key, value] of Object.entries(values))
      assert.equal(process.env[key], value);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

void test("G04 requires an owned read-only context and reuses the full clean-checkout guard", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-g04-context-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextPath = join(directory, "context.json");
  await writeFile(contextPath, "{}\n", { mode: 0o600 });
  await assert.rejects(
    snapshotReadonlyContext(contextPath),
    /LAUNCH_CONTEXT_MODE_INVALID/u,
  );
  await chmod(contextPath, 0o400);
  const initialContext = await snapshotReadonlyContext(contextPath);
  assert.match(initialContext.sha256, /^[0-9a-f]{64}$/u);
  const replacementPath = join(directory, "replacement.json");
  await writeFile(replacementPath, "{}\n", { mode: 0o400 });
  await rename(replacementPath, contextPath);
  const replacement = await snapshotReadonlyContext(contextPath);
  assert.equal(replacement.sha256, initialContext.sha256);
  assert.notEqual(replacement.ino, initialContext.ino);
  assert.throws(
    () => assertContextSnapshotUnchanged(initialContext, replacement, "TESTS"),
    /LAUNCH_CONTEXT_CHANGED_DURING_TESTS/u,
  );

  const dirty = await rollbackGitFixture(t, "dirty-unstaged");
  await assert.rejects(
    inspectLaunchCheckout(dirty.roots.disabled, dirty.disabledSha),
    /ROLLBACK_CHECKOUT_DIRTY/u,
  );
  const hidden = await rollbackGitFixture(t, "skip-worktree-config");
  await assert.rejects(
    inspectLaunchCheckout(hidden.roots.disabled, hidden.disabledSha),
    /ROLLBACK_INDEX_FLAGS_SET/u,
  );
});

void test("G04 coverage floors and critical artifact mapping are strict platform policy", async () => {
  const config = parseYaml(
    await readFile(join(process.cwd(), "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const parsed = parsePlatformConfig(config);
  assert.deepEqual(parsed.unitCoverage.thresholds, {
    lines: 90,
    functions: 90,
    branches: 85,
  });
  assert.equal(parsed.unitCoverage.testFiles.length, 60);
  assert.ok(
    parsed.unitCoverage.testFiles.includes(
      "verification/launch/v1/scenarios/backup-restore.test.mjs",
    ),
  );
  for (const suite of [
    "tests/aroma/catalog-export.test.mjs",
    "tests/realtime/auth.test.mjs",
    "tests/realtime/contract.test.mjs",
    "tests/realtime/replay.test.mjs",
    "tests/realtime/backpressure.test.mjs",
  ])
    assert.ok(parsed.unitCoverage.testFiles.includes(suite), suite);
  const unapprovedSuite = structuredClone(config);
  unapprovedSuite.verification.unitCoverage.testFiles[59] =
    "verification/launch/v1/scenarios/other.test.mjs";
  assert.throws(
    () => parsePlatformConfig(unapprovedSuite),
    /уникальных путей локальных/u,
  );
  const lowered = structuredClone(config);
  lowered.verification.unitCoverage.thresholds.branches = 84;
  assert.throws(() => parsePlatformConfig(lowered), /floors 90\/90\/85/u);
  const remapped = structuredClone(config);
  remapped.verification.unitCoverage.criticalModules[0].coverageRoots = [
    "tests",
  ];
  assert.throws(() => parsePlatformConfig(remapped), /artifact mapping/u);
});

void test("workload cutoff reserves the declared G19 timeout and final report window", () => {
  const reservedMs = 900_000 + 120_000;
  assert.equal(gateBudgetMs("G00_PREFLIGHT", reservedMs), 0);
  assert.equal(gateBudgetMs("G19_REPORT", reservedMs), 900_000);
  assert.equal(gateBudgetMs("G19_REPORT", 900_000), 780_000);
});

void test("G19 accepts only a complete run-scoped Kafka namespace inventory matching G00 claims", () => {
  const runId = "20261023T120000Z-1234567";
  const expectedTopics = [
    "coffee.catalog.snapshot.v1",
    "coffee.catalog.snapshot.v1.dlq",
    "coffee.catalog.mapping.v2",
    "coffee.catalog.mapping.v2.dlq",
    "coffee.orders.lifecycle.v1",
    "coffee.orders.lifecycle.v1.dlq",
    "coffee.aroma.cart.commands.v1",
    "coffee.aroma.cart.commands.v1.dlq",
    "coffee.aroma.cart.events.v1",
    "coffee.aroma.cart.events.v1.dlq",
    "coffee.realtime.invalidate.v1",
    "coffee.realtime.invalidate.v1.dlq",
  ]
    .map((name) => `${runId}.${name}`)
    .sort();
  const expectedGroups = [`${runId}.orders-worker`];
  const valid = {
    schemaVersion: 1,
    mode: "launch-namespace",
    runId,
    projectName: `coffee-launch-${runId.toLowerCase()}`,
    topics: {
      expectedPhysical: expectedTopics,
      actual: expectedTopics,
      missing: [],
      canonicalNamesAbsent: true,
    },
    groups: {
      expectedPhysical: expectedGroups,
      actual: expectedGroups,
      missing: [],
      canonicalNamesAbsent: true,
    },
  };
  const identity = {
    runId,
    projectName: valid.projectName,
    expectedTopics,
    expectedGroups,
  };
  assert.equal(validateKafkaNamespaceInventory(valid, identity), valid);
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        { ...valid, runId: "20261023T120001Z-1234567" },
        identity,
      ),
    /closed schema/u,
  );
  const omittedDlq = expectedTopics
    .filter((name) => !name.endsWith(".dlq"))
    .concat(expectedTopics.filter((name) => name.endsWith(".dlq")).slice(0, -1))
    .sort();
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        {
          ...valid,
          topics: {
            ...valid.topics,
            actual: omittedDlq,
            missing: expectedTopics.filter(
              (name) => !omittedDlq.includes(name),
            ),
          },
        },
        identity,
      ),
    /physical claims/u,
  );
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        {
          ...valid,
          topics: {
            ...valid.topics,
            actual: [...expectedTopics, "coffee.orders.lifecycle.v1"],
          },
        },
        identity,
      ),
    /canonical names/u,
  );
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        {
          ...valid,
          groups: {
            ...valid.groups,
            actual: [...expectedGroups, "orders-worker"],
          },
        },
        identity,
      ),
    /canonical names/u,
  );
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        {
          ...valid,
          topics: {
            ...valid.topics,
            expectedPhysical: [`${runId}.tampered`],
            actual: [`${runId}.tampered`],
          },
        },
        identity,
      ),
    /physical claims/u,
  );
  assert.throws(
    () =>
      validateKafkaNamespaceInventory(
        {
          ...valid,
          topics: {
            expectedPhysical: expectedTopics,
            actual: [],
            missing: expectedTopics,
            canonicalNamesAbsent: true,
          },
          groups: {
            expectedPhysical: expectedGroups,
            actual: [],
            missing: expectedGroups,
            canonicalNamesAbsent: true,
          },
        },
        identity,
      ),
    /physical claims/u,
  );
});

void test("G13 persists only the top-level validated Kafka inventory from successful stdout", async (t) => {
  const evidenceDir = await mkdtemp(
    join(tmpdir(), "launch-g13-kafka-inventory-"),
  );
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const gateDir = join(evidenceDir, "gates/G13_COMPOSE");
  await mkdir(join(gateDir, "artifacts"), { recursive: true });
  const runId = "20261023T120000Z-1234567";
  const projectName = `coffee-launch-${runId.toLowerCase()}`;
  const expectedTopics = CANONICAL_KAFKA_TOPIC_NAMES.flatMap((name) => [
    name,
    `${name}.dlq`,
  ])
    .map((name) => `${runId}.${name}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  const expectedGroups = [`${runId}.orders-worker`];
  const receipt = {
    schemaVersion: 1,
    mode: "launch-namespace",
    runId,
    projectName,
    topics: {
      expectedPhysical: expectedTopics,
      actual: expectedTopics,
      missing: [],
      canonicalNamesAbsent: true,
    },
    groups: {
      expectedPhysical: expectedGroups,
      actual: expectedGroups,
      missing: [],
      canonicalNamesAbsent: true,
    },
  };
  await writeFile(
    join(gateDir, "stdout.log"),
    `progress line\n${JSON.stringify({ kafkaNamespaceInventory: receipt })}\n`,
  );
  const artifact = await captureKafkaNamespaceArtifact({
    evidenceDir,
    gateDir,
    context: { runId, resources: { composeProject: projectName } },
    expectedTopics,
    expectedGroups,
  });
  assert.equal(
    artifact.path,
    join(gateDir, "artifacts/kafka-namespace-inventory.json"),
  );
  assert.deepEqual(JSON.parse(await readFile(artifact.path, "utf8")), receipt);
  await writeFile(
    join(gateDir, "stdout.log"),
    `${JSON.stringify({ kafkaNamespaceInventory: {} })}\n`,
  );
  await assert.rejects(
    captureKafkaNamespaceArtifact({
      evidenceDir,
      gateDir,
      context: { runId, resources: { composeProject: projectName } },
      expectedTopics,
      expectedGroups,
    }),
    /closed schema/u,
  );
});

void test("command splitting rejects shell control and substitutions", () => {
  assert.throws(
    () => splitCommand("pnpm safe; rm -rf ."),
    /Недопустимая команда/,
  );
  assert.throws(
    () => splitCommand("pnpm safe && echo $(id)"),
    /shell-управление/,
  );
  assert.throws(() => splitCommand("pnpm safe | cat"), /shell-управление/);
});

void test("run result validates exact gate order and command identities", async () => {
  const { gates } = await loadMatrix();
  const result = {
    schemaVersion: 1,
    runId: "20261023T120000Z-1234567",
    candidateSha: `1234567${"1".repeat(33)}`,
    sourceSha: "2".repeat(40),
    startedAt: "2026-10-23T12:00:00Z",
    endedAt: "2026-10-23T12:00:00Z",
    environment: {
      runId: "20261023T120000Z-1234567",
      dirty: false,
      platform: "linux",
      osRelease: "test",
      arch: "x64",
      cpuCount: 1,
      memoryBytes: 1,
      node: "v26.8.1",
      pnpm: "11.24.0",
      nodeImageDigest: null,
      timezone: "UTC",
      candidatePath: "/tmp/checkout",
      treeSha: "3".repeat(40),
      toolVersions: {
        docker: null,
        compose: null,
        postgres: null,
        kafka: null,
        browser: null,
      },
      configSha256: null,
      encryptedSecretsSha256: null,
      toolchainVersionsSha256: null,
      lockfileSha256: null,
      imageDigests: null,
      resources: {
        composeProject: {
          name: "coffee-launch-20261023t120000z-1234567",
          created: false,
        },
        databases: CANONICAL_DATABASE_OWNERS.map((owner) => ({
          name: deriveLaunchDatabaseName(
            {
              runId: "20261023T120000Z-1234567",
              candidateSha: `1234567${"1".repeat(33)}`,
            },
            owner,
          ),
          created: false,
        })),
        kafkaPrefix: { name: "20261023T120000Z-1234567", created: false },
      },
    },
    gates: gates.map((gate) => ({
      id: gate.id,
      status: "NOT_RUN",
      expectedCommand: gate.command,
      startedAt: null,
      endedAt: null,
      durationMs: 0,
      timeoutSeconds: gate.timeout,
      reason: "not run",
      runs: [],
      artifacts: [],
    })),
    decision: "НЕ ДОПУСТИТЬ",
  };
  await validateRunResult(result);
  [result.gates[0], result.gates[1]] = [result.gates[1], result.gates[0]];
  await assert.rejects(validateRunResult(result), /must be equal to constant/);
});

void test("builtin report finalizes a complete fail-closed result without candidate dependencies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source");
  const descriptorPath = join(sourceRoot, "evidence/handoffs/issue-13.yaml");
  const descriptorBytes =
    "issue: 13\nstatus: source-descriptor-before-formal-verification\n";
  await mkdir(join(sourceRoot, "evidence/handoffs"), { recursive: true });
  await writeFile(descriptorPath, descriptorBytes);
  execFileSync("git", ["init", "--quiet", sourceRoot]);
  execFileSync("git", [
    "-C",
    sourceRoot,
    "add",
    "evidence/handoffs/issue-13.yaml",
  ]);
  execFileSync("git", [
    "-C",
    sourceRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const candidateSha = execFileSync(
    "git",
    ["-C", sourceRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const runId = `20261023T120000Z-${candidateSha.slice(0, 7)}`;
  const evidenceDir = join(sourceRoot, "evidence", "launch", runId);
  await writeFile(
    descriptorPath,
    "modified checkout descriptor; must not be used\n",
  );
  const gates = EXPECTED_GATES.map(([id, expectedCommand, timeoutSeconds]) => ({
    id,
    status: id === "G12_SUPPLY_CHAIN" ? "FAIL" : "NOT_RUN",
    expectedCommand,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    timeoutSeconds,
    reason:
      id === "G12_SUPPLY_CHAIN"
        ? "G12 scan failed"
        : "NOT_RUN: workload budget exhausted; G19 reserve remains",
    runs: [],
    artifacts: [],
  }));
  const result = {
    schemaVersion: 1,
    runId: runId,
    candidateSha: candidateSha,
    sourceSha: "2".repeat(40),
    startedAt: "2026-10-23T12:00:00Z",
    endedAt: "2026-10-23T12:00:00Z",
    environment: {
      runId: runId,
      dirty: false,
      platform: "linux",
      osRelease: "fixture",
      arch: "x64",
      cpuCount: 1,
      memoryBytes: 1024,
      node: process.version,
      pnpm: "unknown",
      nodeImageDigest: null,
      timezone: "UTC",
      candidatePath: sourceRoot,
      treeSha: "3".repeat(40),
      toolVersions: {
        docker: null,
        compose: null,
        postgres: null,
        kafka: null,
        browser: null,
      },
      configSha256: null,
      encryptedSecretsSha256: null,
      toolchainVersionsSha256: null,
      lockfileSha256: null,
      imageDigests: null,
      resources: {
        composeProject: {
          name: `coffee-launch-${runId.toLowerCase()}`,
          created: false,
        },
        databases: CANONICAL_DATABASE_OWNERS.map((owner) => ({
          name: deriveLaunchDatabaseName(
            {
              runId: runId,
              candidateSha: candidateSha,
            },
            owner,
          ),
          created: false,
        })),
        kafkaPrefix: { name: runId, created: false },
      },
    },
    gates,
    decision: "НЕ ДОПУСТИТЬ",
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, "context.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceRepoRoot: sourceRoot,
      evidenceDir,
      runId: result.runId,
      candidateSha: result.candidateSha,
      checkoutDir: result.environment.candidatePath,
    }),
  );
  await writeFile(join(evidenceDir, "run-result.json"), JSON.stringify(result));
  await writeFile(join(evidenceDir, "commands.ndjson"), "");
  for (const gate of gates) {
    const gateDir = join(evidenceDir, "gates", gate.id);
    await mkdir(join(gateDir, "artifacts"), { recursive: true });
    await writeFile(join(gateDir, "result.json"), JSON.stringify(gate));
    await writeFile(join(gateDir, "stdout.log"), "");
    await writeFile(join(gateDir, "stderr.log"), "");
  }
  const finalized = await finalizeReport(evidenceDir);
  assert.equal(finalized.result.decision, "НЕ ДОПУСТИТЬ");
  assert.equal(
    finalized.result.gates.find((gate) => gate.id === "G12_SUPPLY_CHAIN")
      .status,
    "FAIL",
  );
  for (const id of ["G10_INTEGRATION", "G11_RECOVERY", "G13_COMPOSE"]) {
    assert.equal(
      finalized.result.gates.find((gate) => gate.id === id).status,
      "NOT_RUN",
    );
  }
  assert.equal(finalized.errors.length, 0);
  const handoffPath = join(evidenceDir, "handoff.yaml");
  const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
  assert.equal(handoff.sourceDescriptorStatus, "BOUND");
  assert.equal(handoff.sourceDescriptorPath, "evidence/handoffs/issue-13.yaml");
  assert.equal(
    handoff.sourceDescriptorSha256,
    createHash("sha256").update(descriptorBytes).digest("hex"),
  );
  assert.equal(handoff.runId, runId);
  assert.equal(handoff.candidateSha, candidateSha);
  assert.equal(handoff.decision, "НЕ ДОПУСТИТЬ");
  assert.equal(handoff.gates.length, 20);
  assert.equal(
    handoff.gates.find((gate) => gate.id === "G12_SUPPLY_CHAIN").status,
    "FAIL",
  );
  assert.equal(
    handoff.gates.find((gate) => gate.id === "G14_OBSERVABILITY").status,
    "NOT_RUN",
  );
  assert.equal(handoff.limits.gateTimeoutSeconds.G14_OBSERVABILITY, 1800);
  for (const name of ["run-result.json", "decision.json"]) {
    const row = handoff.artifactHashes.find(({ path }) => path === name);
    const bytes = await readFile(join(evidenceDir, name));
    assert.equal(row.sha256, createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(
    handoff.artifactHashes.some(({ path }) =>
      ["handoff.yaml", "checksums.sha256"].includes(path),
    ),
    false,
  );
  assert.match(
    await readFile(join(evidenceDir, "checksums.sha256"), "utf8"),
    /handoff\.yaml$/m,
  );
  await rename(join(sourceRoot, ".git"), join(directory, "saved-git"));
  const unbound = await finalizeReport(evidenceDir);
  const unboundHandoff = JSON.parse(await readFile(handoffPath, "utf8"));
  assert.equal(unboundHandoff.sourceDescriptorStatus, "NOT_PROVEN");
  assert.equal(unboundHandoff.sourceDescriptorSha256, null);
  assert.equal(unbound.result.decision, "НЕ ДОПУСТИТЬ");
  assert.equal(unbound.result.gates[19].status, "FAIL");
  assert.match(unbound.result.gates[19].reason, /source descriptor/u);
  assert.equal(
    unbound.result.gates.find((gate) => gate.id === "G12_SUPPLY_CHAIN").status,
    "FAIL",
  );
  assert.ok(unbound.errors.some((error) => /source descriptor/u.test(error)));
  assert.equal(unboundHandoff.gates[19].status, "FAIL");
  const repeatedUnbound = await finalizeReport(evidenceDir);
  assert.equal(
    repeatedUnbound.result.gates[19].reason,
    unbound.result.gates[19].reason,
  );
  await rename(join(directory, "saved-git"), join(sourceRoot, ".git"));
  await finalizeReport(evidenceDir);
  assert.equal(
    JSON.parse(await readFile(handoffPath, "utf8")).sourceDescriptorStatus,
    "BOUND",
  );
  const report = await readFile(finalized.reportPath, "utf8");
  assert.match(report, /^# НЕ ДОПУСТИТЬ/m);
  assert.doesNotMatch(report, /\n\n$/);
  assert.match(
    report,
    /## Sandbox fingerprint[\s\S]*G16: NOT_RUN; account fingerprint: нет доказательства/,
  );
  assert.match(
    report,
    /## Backup RPO и restore time[\s\S]*G17: NOT_RUN;[\s\S]*NOT_RUN — доказательства нет/,
  );
  assert.match(
    report,
    /## Observability и rollback[\s\S]*G14 observability: NOT_RUN[\s\S]*G18 rollback: NOT_RUN/,
  );
  assert.match(
    report,
    /## Открытые риски и непроверенное поведение[\s\S]*runtime image digests/,
  );
  assert.match(report, /Не собран runtime digest pinned Node image/);
  assert.match(
    await readFile(join(evidenceDir, "checksums.sha256"), "utf8"),
    /ОТЧЁТ\.md$/m,
  );
  await validateChecksumManifest(evidenceDir, sourceRoot, result.runId);
  const checksumCheck = spawnSync(
    "sha256sum",
    ["-c", join(evidenceDir, "checksums.sha256")],
    { cwd: sourceRoot, encoding: "utf8" },
  );
  assert.equal(checksumCheck.status, 0, checksumCheck.stderr);
  await writeFile(
    join(evidenceDir, "commands.ndjson"),
    `${JSON.stringify({ gateId: "G00_PREFLIGHT", argv: ["pnpm", "forged"] })}\n`,
  );
  const tampered = await finalizeReport(evidenceDir);
  assert.ok(tampered.errors.some((error) => /commands\.ndjson/.test(error)));
  assert.equal(tampered.result.decision, "НЕ ДОПУСТИТЬ");

  const reportGate = gates[19];
  reportGate.status = "PASS";
  reportGate.reason = "";
  reportGate.startedAt = "2026-10-23T12:00:00Z";
  reportGate.endedAt = "2026-10-23T12:00:00Z";
  reportGate.runs = [
    {
      argv: ["pnpm", "launch:verify:report"],
      cwd: result.environment.candidatePath,
      startedAt: reportGate.startedAt,
      endedAt: reportGate.endedAt,
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false,
      timeoutMs: 900000,
      durationMs: 1,
      peakRssBytes: 1024,
      artifacts: [],
    },
  ];
  await writeFile(
    join(evidenceDir, "commands.ndjson"),
    `${JSON.stringify({ gateId: reportGate.id, ...reportGate.runs[0] })}\n`,
  );
  await writeFile(join(evidenceDir, "run-result.json"), JSON.stringify(result));
  await writeFile(
    join(evidenceDir, "gates", reportGate.id, "result.json"),
    JSON.stringify(reportGate),
  );
  const exactReportCommand = await finalizeReport(evidenceDir);
  assert.equal(exactReportCommand.errors.length, 0);
  const finalHandoff = JSON.parse(await readFile(handoffPath, "utf8"));
  assert.equal(finalHandoff.gates[19].status, "PASS");
  assert.deepEqual(finalHandoff.gates[19].runs[0].argv, [
    "pnpm",
    "launch:verify:report",
  ]);
  assert.equal(finalHandoff.gates[19].runs[0].exitCode, 0);
  assert.equal(
    finalHandoff.gates.find((gate) => gate.id === "G12_SUPPLY_CHAIN").status,
    "FAIL",
  );
  assert.equal(finalHandoff.decision, "НЕ ДОПУСТИТЬ");

  reportGate.runs[0].argv = ["pnpm", "forged-report"];
  await writeFile(
    join(evidenceDir, "commands.ndjson"),
    `${JSON.stringify({ gateId: reportGate.id, ...reportGate.runs[0] })}\n`,
  );
  await writeFile(join(evidenceDir, "run-result.json"), JSON.stringify(result));
  await writeFile(
    join(evidenceDir, "gates", reportGate.id, "result.json"),
    JSON.stringify(reportGate),
  );
  const forgedReportCommand = await finalizeReport(evidenceDir);
  assert.ok(
    forgedReportCommand.errors.some((error) =>
      /фактический argv|G19 PASS/.test(error),
    ),
  );

  const baseConfigSha256 = "4".repeat(64);
  result.environment.configSha256 = baseConfigSha256;
  await writeFile(
    join(evidenceDir, "context.json"),
    JSON.stringify({
      schemaVersion: 1,
      sourceRepoRoot: sourceRoot,
      evidenceDir,
      runId,
      candidateSha: result.candidateSha,
      baseConfigSha256,
      checkoutDir: result.environment.candidatePath,
      resources: {
        composeProject: result.environment.resources.composeProject.name,
      },
    }),
  );
  const commonRun = (gate, argv) => ({
    argv,
    cwd: result.environment.candidatePath,
    startedAt: "2026-10-23T12:00:00Z",
    endedAt: "2026-10-23T12:00:00Z",
    exitCode: 0,
    timedOut: false,
    outputLimitExceeded: false,
    timeoutMs: 900000,
    durationMs: 1,
    peakRssBytes: 1024,
    artifacts: [],
  });
  const preflightGate = gates[0];
  preflightGate.status = "PASS";
  preflightGate.reason = "";
  preflightGate.runs = [
    commonRun(preflightGate, ["pnpm", "launch:verify:preflight"]),
  ];
  gates[13].status = "PASS";
  gates[13].reason = "";
  gates[13].runs = [commonRun(gates[13], ["pnpm", "test:compose-smoke"])];
  reportGate.runs[0] = commonRun(reportGate, ["pnpm", "launch:verify:report"]);
  const expectedTopics = [`${runId}.orders`];
  const expectedGroups = [`${runId}.orders-worker`];
  await writeFile(
    join(evidenceDir, "gates/G00_PREFLIGHT/artifacts/preflight.json"),
    JSON.stringify({
      schemaVersion: 1,
      gateId: "G00_PREFLIGHT",
      runId,
      candidateSha: result.candidateSha,
      status: "PASS",
      checks: [
        {
          id: "KAFKA_NAMESPACE_PLAN",
          status: "PASS",
          facts: {
            committedFlagEnabled: true,
            baseConfigShaMatchesContext: true,
            baseConfigSha256,
            candidateContextValid: true,
            expectedPhysical: {
              topics: expectedTopics,
              groups: expectedGroups,
            },
          },
        },
      ],
      limitations: [],
    }),
  );
  await writeFile(
    join(evidenceDir, "commands.ndjson"),
    [
      { gateId: preflightGate.id, ...preflightGate.runs[0] },
      { gateId: gates[13].id, ...gates[13].runs[0] },
      { gateId: reportGate.id, ...reportGate.runs[0] },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await writeFile(join(evidenceDir, "run-result.json"), JSON.stringify(result));
  for (const gate of [preflightGate, gates[13], reportGate])
    await writeFile(
      join(evidenceDir, "gates", gate.id, "result.json"),
      JSON.stringify(gate),
    );
  const missingKafkaInventory = await finalizeReport(evidenceDir);
  assert.ok(
    missingKafkaInventory.errors.some((error) =>
      /G13 Kafka namespace inventory/u.test(error),
    ),
  );
});

void test("candidate report and owner suites accept only the exact launch candidate context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-g19-candidate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source");
  const candidateRoot = join(directory, "candidate");
  const initializeRepo = async (root) => {
    await mkdir(root, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Launch fixture"], {
      cwd: root,
    });
    execFileSync(
      "git",
      ["config", "user.email", "launch-fixture@example.invalid"],
      { cwd: root },
    );
    execFileSync(
      "git",
      [
        "remote",
        "add",
        "origin",
        "https://github.com/YurGusev/CoffeeOrderPlatform",
      ],
      { cwd: root },
    );
  };
  await initializeRepo(sourceRoot);
  await writeFile(join(sourceRoot, "source.txt"), "authoring root\n");
  execFileSync("git", ["add", "source.txt"], { cwd: sourceRoot });
  execFileSync("git", ["commit", "-qm", "source fixture"], { cwd: sourceRoot });
  await initializeRepo(candidateRoot);
  const candidateReport = join(
    candidateRoot,
    "verification/launch/v1/report.mjs",
  );
  await mkdir(join(candidateRoot, "verification/launch/v1"), {
    recursive: true,
  });
  await writeFile(
    candidateReport,
    await readFile(new URL("./report.mjs", import.meta.url)),
  );
  const helperPaths = [
    "launch-database-target.ts",
    "launch-database-target.js",
    "launch-kafka-target.ts",
    "launch-kafka-target.js",
  ].map((name) => `packages/platform-config/src/${name}`);
  await mkdir(join(candidateRoot, "packages/platform-config/src"), {
    recursive: true,
  });
  for (const helperPath of helperPaths)
    await writeFile(
      join(candidateRoot, helperPath),
      await readFile(new URL(`../../../${helperPath}`, import.meta.url)),
    );
  await writeFile(join(candidateRoot, "candidate.txt"), "candidate checkout\n");
  await mkdir(join(candidateRoot, "evidence/handoffs"), { recursive: true });
  await writeFile(
    join(candidateRoot, "evidence/handoffs/issue-13.yaml"),
    "issue: 13\n",
  );
  execFileSync("git", ["add", "."], { cwd: candidateRoot });
  execFileSync("git", ["commit", "-qm", "candidate fixture"], {
    cwd: candidateRoot,
  });
  const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: candidateRoot,
    encoding: "utf8",
  }).trim();
  const runId = `20261023T120000Z-${candidateSha.slice(0, 7)}`;
  const evidenceDir = join(sourceRoot, "evidence/launch", runId);
  const gates = EXPECTED_GATES.map(([id, expectedCommand, timeoutSeconds]) => ({
    id,
    status: "NOT_RUN",
    expectedCommand,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    timeoutSeconds,
    reason: "NOT_RUN: fixture",
    runs: [],
    artifacts: [],
  }));
  gates[0].status = "FAIL";
  gates[0].reason = "GitHub preflight blockers";
  const result = {
    schemaVersion: 1,
    runId,
    candidateSha,
    sourceSha: "2".repeat(40),
    startedAt: "2026-10-23T12:00:00Z",
    endedAt: "2026-10-23T12:00:00Z",
    environment: {
      runId,
      dirty: false,
      platform: "linux",
      osRelease: "fixture",
      arch: "x64",
      cpuCount: 1,
      memoryBytes: 1024,
      node: process.version,
      pnpm: "unknown",
      nodeImageDigest: null,
      timezone: "UTC",
      candidatePath: candidateRoot,
      treeSha: "3".repeat(40),
      toolVersions: {
        docker: null,
        compose: null,
        postgres: null,
        kafka: null,
        browser: null,
      },
      configSha256: null,
      encryptedSecretsSha256: null,
      toolchainVersionsSha256: null,
      lockfileSha256: null,
      imageDigests: null,
      resources: {
        composeProject: {
          name: `coffee-launch-${runId.toLowerCase()}`,
          created: false,
        },
        databases: CANONICAL_DATABASE_OWNERS.map((owner) => ({
          name: deriveLaunchDatabaseName({ runId, candidateSha }, owner),
          created: false,
        })),
        kafkaPrefix: { name: runId, created: false },
      },
    },
    gates,
    decision: "НЕ ДОПУСТИТЬ",
  };
  await mkdir(evidenceDir, { recursive: true });
  const contextPath = join(evidenceDir, "context.json");
  await writeFile(
    contextPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceRepoRoot: sourceRoot,
      evidenceDir,
      runId,
      candidateSha,
      checkoutDir: candidateRoot,
      resources: {
        composeProject: `coffee-launch-${runId.toLowerCase()}`,
        kafkaPrefix: runId,
      },
    }),
  );
  const ownerSuitesSource = await readFile(
    new URL("./scenarios/owner-suites.mjs", import.meta.url),
  );
  const sourceReport = join(sourceRoot, "verification/launch/v1/report.mjs");
  const sourceOwnerSuites = join(
    sourceRoot,
    "verification/launch/v1/scenarios/owner-suites.mjs",
  );
  const candidateOwnerSuites = join(
    candidateRoot,
    "verification/launch/v1/scenarios/owner-suites.mjs",
  );
  await mkdir(join(sourceRoot, "verification/launch/v1/scenarios"), {
    recursive: true,
  });
  await writeFile(
    sourceReport,
    await readFile(new URL("./report.mjs", import.meta.url)),
  );
  await mkdir(join(sourceRoot, "packages/platform-config/src"), {
    recursive: true,
  });
  for (const helperPath of helperPaths)
    await writeFile(
      join(sourceRoot, helperPath),
      await readFile(new URL(`../../../${helperPath}`, import.meta.url)),
    );
  await writeFile(sourceOwnerSuites, ownerSuitesSource);
  await mkdir(join(candidateRoot, "verification/launch/v1/scenarios"), {
    recursive: true,
  });
  await writeFile(candidateOwnerSuites, ownerSuitesSource);
  const sourceSuitesModule = await import(pathToFileURL(sourceOwnerSuites));
  const candidateSuitesModule = await import(
    pathToFileURL(candidateOwnerSuites)
  );
  await assert.rejects(
    sourceSuitesModule.resolveComposeProjectName(contextPath),
    /exact launch candidate checkout/,
  );
  assert.equal(
    await candidateSuitesModule.resolveComposeProjectName(contextPath),
    `coffee-launch-${runId.toLowerCase()}`,
  );
  await writeFile(join(evidenceDir, "run-result.json"), JSON.stringify(result));
  await writeFile(join(evidenceDir, "commands.ndjson"), "");
  for (const gate of gates) {
    const gateDir = join(evidenceDir, "gates", gate.id);
    await mkdir(join(gateDir, "artifacts"), { recursive: true });
    await writeFile(join(gateDir, "result.json"), JSON.stringify(gate));
    await writeFile(join(gateDir, "stdout.log"), "");
    await writeFile(join(gateDir, "stderr.log"), "");
  }
  await writeFile(
    join(evidenceDir, "gates/G00_PREFLIGHT/artifacts/preflight.json"),
    JSON.stringify({
      schemaVersion: 1,
      gateId: "G00_PREFLIGHT",
      runId,
      candidateSha,
      status: "FAIL",
      checks: [
        {
          id: "GITHUB_PREDECESSORS",
          status: "FAIL",
          facts: { failureCount: 1, missingAcceptedMerge: "#12" },
        },
      ],
      limitations: [],
    }),
  );
  await writeFile(
    join(evidenceDir, "gates/G00_PREFLIGHT/result.json"),
    JSON.stringify(gates[0]),
  );
  const executed = spawnSync(process.execPath, [candidateReport], {
    cwd: candidateRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      COFFEE_LAUNCH_CONTEXT_FILE: join(evidenceDir, "context.json"),
    },
  });
  assert.equal(executed.status, 0, executed.stderr);
  const reportPath = join(sourceRoot, "docs/reports/launch", runId, "ОТЧЁТ.md");
  assert.match(await readFile(reportPath, "utf8"), /^# НЕ ДОПУСТИТЬ/m);
  assert.match(
    await readFile(reportPath, "utf8"),
    /GITHUB_PREDECESSORS: \{"failureCount":1,"missingAcceptedMerge":"#12"\}/,
  );

  const symlinkTargets = [
    join(evidenceDir, "run-result.json"),
    join(evidenceDir, "defects.json"),
    join(evidenceDir, "decision.json"),
    join(evidenceDir, "handoff.yaml"),
    join(evidenceDir, "checksums.sha256"),
    join(evidenceDir, "gates/G00_PREFLIGHT/artifacts/defect.json"),
    reportPath,
  ];
  for (const [index, target] of symlinkTargets.entries()) {
    const outside = join(directory, `outside-${index}.txt`);
    await writeFile(outside, `foreign bytes ${index}\n`);
    let originalContents = null;
    try {
      originalContents = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rm(target, { force: true });
    await symlink(outside, target);
    const rejected = spawnSync(process.execPath, [candidateReport], {
      cwd: candidateRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        COFFEE_LAUNCH_CONTEXT_FILE: join(evidenceDir, "context.json"),
      },
    });
    assert.notEqual(rejected.status, 0, `symlink target accepted: ${target}`);
    assert.match(
      rejected.stderr,
      /symlink|symbolic/i,
      `rejection was not caused by symlink: ${target}; stderr=${rejected.stderr}`,
    );
    assert.equal(await readFile(outside, "utf8"), `foreign bytes ${index}\n`);
    await rm(target);
    if (originalContents !== null) await writeFile(target, originalContents);
  }
});

void test("checksum manifest requires the exact complete regular-file set with hashes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-checksums-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceRoot = join(directory, "source");
  const runId = "20261023T120000Z-1234567";
  const evidenceDir = join(sourceRoot, "evidence", "launch", runId);
  const reportPath = join(
    sourceRoot,
    "docs",
    "reports",
    "launch",
    runId,
    "ОТЧЁТ.md",
  );
  await mkdir(evidenceDir, { recursive: true });
  await mkdir(join(sourceRoot, "docs", "reports", "launch", runId), {
    recursive: true,
  });
  await writeFile(join(evidenceDir, "run-result.json"), "result\n");
  await writeFile(reportPath, "report\n");
  const manifestPath = join(evidenceDir, "checksums.sha256");
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const rows = await Promise.all(
    [join(evidenceDir, "run-result.json"), reportPath].map(
      async (path) =>
        `${await digest(path)}  ${path.slice(sourceRoot.length + 1)}`,
    ),
  );
  rows.sort((a, b) => a.localeCompare(b, "en"));
  const validManifest = `${rows.join("\n")}\n`;
  await writeFile(manifestPath, validManifest);
  await validateChecksumManifest(evidenceDir, sourceRoot, runId);
  await writeFile(manifestPath, `${validManifest}${rows[0]}\n`);
  await assert.rejects(
    validateChecksumManifest(evidenceDir, sourceRoot, runId),
    /exact set|duplicate|tampering/,
  );
  await writeFile(manifestPath, validManifest);
  await writeFile(join(evidenceDir, "unlisted.json"), "unlisted\n");
  await assert.rejects(
    validateChecksumManifest(evidenceDir, sourceRoot, runId),
    /exact set|duplicate|tampering/,
  );
  await rm(join(evidenceDir, "unlisted.json"));
  await writeFile(join(evidenceDir, "run-result.json"), "tampered\n");
  await assert.rejects(
    validateChecksumManifest(evidenceDir, sourceRoot, runId),
    /exact set|duplicate|tampering/,
  );
  await writeFile(join(evidenceDir, "run-result.json"), "result\n");
  await symlink(reportPath, join(evidenceDir, "outside-link"));
  await assert.rejects(
    validateChecksumManifest(evidenceDir, sourceRoot, runId),
    /symlink|Symlink/,
  );
});

void test("stream redaction catches secrets split across chunks and preserves UTF-8", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-redaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stdout.log");
  await writeRedactedStream(
    Readable.from([
      Buffer.from("Текст authorization: Bearer canary-"),
      Buffer.from("secret-value\nmail test@example.com\n"),
    ]),
    path,
    ["canary-secret-value"],
  );
  const output = await readFile(path, "utf8");
  assert.match(output, /Текст/);
  assert.doesNotMatch(output, /canary-secret-value|test@example\.com/);
  assert.match(output, /\[REDACTED\]/);
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.name);
  process.on("warning", onWarning);
  try {
    await writeRedactedStream(
      Readable.from(Array.from({ length: 256 }, () => `${"x".repeat(4095)}\n`)),
      join(directory, "backpressure.log"),
    );
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.equal(warnings.includes("MaxListenersExceededWarning"), false);
  } finally {
    process.off("warning", onWarning);
  }
});

void test("oversized log lines fail closed when redaction parsing state is uncertain", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-redaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stdout.log");
  let killed = 0;
  const result = await writeRedactedStream(
    Readable.from(["123456789012", "PRIVATE-TAIL", "\nvisible\n"]),
    path,
    [],
    8,
    null,
    () => {
      killed += 1;
    },
  );
  const output = await readFile(path, "utf8");
  assert.doesNotMatch(output, /PRIVATE-TAIL/);
  assert.doesNotMatch(output, /visible/);
  assert.match(output, /parsing state uncertain/);
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(killed, 1);
});

void test("oversized lines with sensitive JSON openers fail closed across chunks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-redaction-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    [
      Buffer.from('{"body": {'),
      Buffer.from("X".repeat(9000) + "\n"),
      Buffer.from('"privateValue":"PRIVATE_PROVIDER_BODY_CANARY"}\n'),
    ],
    [
      Buffer.from("X".repeat(8190)),
      Buffer.from('"body": {'),
      Buffer.from("Y".repeat(100) + "\n"),
      Buffer.from('"privateValue":"PRIVATE_PROVIDER_BODY_CANARY"}\n'),
    ],
  ];
  for (const [index, chunks] of cases.entries()) {
    const path = join(directory, `stdout-${index}.log`);
    const result = await writeRedactedStream(
      Readable.from(chunks),
      path,
      [],
      8192,
      null,
      () => {},
    );
    const output = await readFile(path, "utf8");
    assert.equal(result.outputLimitExceeded, true);
    assert.doesNotMatch(output, /PRIVATE_PROVIDER_BODY_CANARY/);
    assert.match(output, /parsing state uncertain/);
  }
});

void test("combined stdout/stderr budget writes a marker and fails the gate capture", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-log-budget-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  const budget = {
    maxBytes: 2048,
    usedBytes: 0,
    observedBytes: 0,
    exceeded: false,
  };
  const run = await executeArgv(
    [
      process.execPath,
      "-e",
      "setInterval(()=>process.stdout.write('X'.repeat(1024)),1)",
    ],
    directory,
    3000,
    stdoutPath,
    stderrPath,
    undefined,
    budget,
  );
  assert.equal(run.outputLimitExceeded, true);
  assert.notEqual(run.exitCode, 0);
  const output = await readFile(stdoutPath, "utf8");
  assert.match(output, /run log budget exceeded/);
  assert.ok(
    (await readFile(stdoutPath)).length + (await readFile(stderrPath)).length <=
      budget.maxBytes,
  );
});

void test("G00 and G19 pnpm commands keep exact argv and do not auto-install before execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-pnpm-preinstall-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const localDependency = join(directory, "local-dependency");
  await mkdir(localDependency);
  await writeFile(
    join(localDependency, "package.json"),
    JSON.stringify({ name: "local-dependency", version: "1.0.0" }),
  );
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "launch-pnpm-fixture",
      version: "1.0.0",
      packageManager: "pnpm@11.24.0",
      scripts: {
        "launch:verify:preflight": "node preflight.mjs",
        "launch:verify:report": "node report.mjs",
      },
      dependencies: { "local-dependency": "file:./local-dependency" },
    }),
  );
  await writeFile(
    join(directory, "preflight.mjs"),
    "process.exit(process.env.pnpm_config_verify_deps_before_run === 'false' ? 23 : 91);\n",
  );
  await writeFile(
    join(directory, "report.mjs"),
    "process.exit(process.env.pnpm_config_verify_deps_before_run === 'false' ? 37 : 92);\n",
  );
  for (const [command, expectedExit, name] of [
    [["pnpm", "launch:verify:preflight"], 23, "preflight"],
    [["pnpm", "launch:verify:report"], 37, "report"],
  ]) {
    const result = await executeArgv(
      command,
      directory,
      30_000,
      join(directory, `${String(name)}.stdout.log`),
      join(directory, `${String(name)}.stderr.log`),
    );
    assert.deepEqual(result.argv, command);
    assert.equal(result.exitCode, expectedExit);
    assert.equal(result.timedOut, false);
    assert.equal(result.outputLimitExceeded, false);
    await assert.rejects(access(join(directory, "node_modules")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(directory, "pnpm-lock.yaml")), {
      code: "ENOENT",
    });
  }
});

void test("multiline request and provider JSON bodies stay redacted across line boundaries", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-redaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "stdout.log");
  await writeRedactedStream(
    Readable.from([
      '{"level":"info","request":{\n',
      '"headers":{"authorization":"Bearer canary-value"},\n',
      '"body":{"email":"private@example.com"}},"msg":"safe"}\n',
      '{"msg":"visible"}\n',
    ]),
    path,
    [],
  );
  const output = await readFile(path, "utf8");
  assert.doesNotMatch(output, /canary-value|private@example\.com/);
  assert.match(output, /visible/);
});

void test(
  "missing first stdout line terminates the child and flushes stderr",
  { skip: process.platform !== "linux" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "launch-stdout-guard-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const leaderExits of [false, true]) {
      const runDirectory = join(directory, String(leaderExits));
      await mkdir(runDirectory);
      const pidPath = join(runDirectory, "pid");
      const descendantPath = join(runDirectory, "descendant-pid");
      const stderrPath = join(runDirectory, "stderr.log");
      let pid;
      let stopped = false;
      try {
        const descendant = `process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(descendantPath)},String(process.pid));setInterval(()=>{},1000)`;
        await assert.rejects(
          executeArgv(
            [
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});process.stderr.write('guard stderr\\n');setInterval(()=>{if(${leaderExits} && require('node:fs').existsSync(${JSON.stringify(descendantPath)}))process.exit(0)},10)`,
            ],
            runDirectory,
            60_000,
            join(runDirectory, "stdout.log"),
            stderrPath,
            undefined,
            null,
            { awaitFirstStdoutLine: true },
          ),
          /child stdout was not observed/,
        );
        pid = Number(await readFile(pidPath, "utf8"));
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        const descendantPid = Number(await readFile(descendantPath, "utf8"));
        assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
        const running = async (reader = readFile) => {
          const status = await reader(
            `/proc/${descendantPid}/stat`,
            "utf8",
          ).catch((error) => {
            if (error.code === "ENOENT" || error.code === "ESRCH") return null;
            throw error;
          });
          return status !== null && !/^\d+ \(.*\) Z /u.test(status);
        };
        for (const code of ["ENOENT", "ESRCH", "EACCES"]) {
          const result = running(async () => {
            throw Object.assign(new Error("synthetic proc read failure"), {
              code,
            });
          });
          if (code === "EACCES") await assert.rejects(result, { code });
          else assert.equal(await result, false);
        }
        const exitDeadline = Date.now() + 2_000;
        while ((await running()) && Date.now() < exitDeadline)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        assert.equal(await running(), false);
        stopped = true;
        assert.match(await readFile(stderrPath, "utf8"), /guard stderr/);
      } finally {
        if (!stopped && pid === undefined) {
          pid = Number(await readFile(pidPath, "utf8").catch(() => ""));
        }
        if (
          !stopped &&
          typeof pid === "number" &&
          Number.isSafeInteger(pid) &&
          pid > 0
        ) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      }
    }
  },
);

void test("deadline terminates the exact child process group and records peak RSS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-deadline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Родитель собирает завершение ребёнка, чтобы проверка не зависела от скорости PID 1.
  const result = await executeArgv(
    [
      process.execPath,
      "-e",
      "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.once('exit',()=>process.exit(143));process.on('SIGTERM',()=>{});console.log(c.pid);setInterval(()=>{},1000)",
    ],
    directory,
    100,
    join(directory, "stdout.log"),
    join(directory, "stderr.log"),
    undefined,
    null,
    { awaitFirstStdoutLine: true },
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.peakRssBytes > 0);
  const childPid = Number(
    (await readFile(join(directory, "stdout.log"), "utf8")).trim(),
  );
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
});

void test(
  "RSS sampler distinguishes proc races from errors, serializes scans, and keeps failure evidence within budget",
  { concurrency: false },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "launch-rss-sampler-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const originalReadFile = fsPromises.readFile;
    const originalReaddir = fsPromises.readdir;
    const state = {
      targetPid: null,
      records: [],
      statReads: new Map(),
      statusReads: new Map(),
      statusHook: null,
      activeStatusReads: 0,
      maxActiveStatusReads: 0,
      readdirDelayMs: 0,
      unknownEntryGone: false,
      readdirErrno: null,
      procScans: 0,
    };
    const procError = (code) =>
      Object.assign(new Error("private proc detail"), { code });
    const fakeDirent = (name) => ({ name, isDirectory: () => true });
    const fakeStat = (pid, stateName = "R", processGroup = state.targetPid) =>
      `${pid} (fixture) ${stateName} 1 ${processGroup} ${processGroup} 0`;
    const recordFor = (pid) =>
      state.records.find((record) => state.targetPid + record.offset === pid);
    t.mock.method(fsPromises, "readdir", async (path, ...args) => {
      if (path === "/proc") {
        state.procScans += 1;
        if (state.readdirErrno) throw procError(state.readdirErrno);
        if (state.readdirDelayMs) {
          const delay = state.readdirDelayMs;
          state.readdirDelayMs = 0;
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, delay),
          );
        }
        if (!state.targetPid) return [];
        if (state.unknownEntryGone && args[0]?.withFileTypes)
          throw procError("ENOENT");
        const names = [
          "self",
          ...state.records.map((record) =>
            String(state.targetPid + record.offset),
          ),
        ];
        return args[0]?.withFileTypes ? names.map(fakeDirent) : names;
      }
      return originalReaddir(path, ...args);
    });
    t.mock.method(fsPromises, "readFile", async (path, ...args) => {
      const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(String(path));
      if (!match || !state.targetPid) return originalReadFile(path, ...args);
      const pid = Number(match[1]);
      const kind = match[2];
      const record = recordFor(pid);
      if (!record) return originalReadFile(path, ...args);
      if (kind === "stat") {
        const reads = (state.statReads.get(pid) ?? 0) + 1;
        state.statReads.set(pid, reads);
        if (
          record.kind === "stat-exit" ||
          (record.kind === "status-exit" && reads > 1)
        )
          throw procError(record.errno);
        return fakeStat(
          pid,
          record.kind === "zombie"
            ? "Z"
            : record.kind === "dead-lowercase"
              ? "x"
              : record.kind === "traced-unrelated"
                ? "t"
                : "R",
          record.kind === "group-mismatch" || record.kind === "traced-unrelated"
            ? state.targetPid + 500
            : state.targetPid,
        );
      }
      const reads = (state.statusReads.get(pid) ?? 0) + 1;
      state.statusReads.set(pid, reads);
      if (state.statusHook) return state.statusHook(record, reads);
      if (record.kind === "status-exit" || record.kind === "status-error")
        throw procError(
          record.errnos?.[Math.min(reads - 1, record.errnos.length - 1)] ??
            record.errno,
        );
      if (record.kind === "missing-vmrss") return "Name:\tfixture\n";
      return "Name:\tfixture\nVmRSS:\t128 kB\n";
    });
    syncBuiltinESMExports();
    try {
      const originalProcessKill = process.kill.bind(process);
      const killCalls = [];
      t.mock.method(process, "kill", (pid, signal) => {
        killCalls.push({ pid, signal, at: Date.now() });
        return originalProcessKill(pid, signal);
      });
      let runNumber = 0;
      const runFixture = async ({
        records,
        durationMs = 600,
        timeoutMs = 5000,
        readdirDelayMs = 0,
        statusHook = null,
        outputBudget = null,
        unknownEntryGone = false,
        readdirErrno = null,
      }) => {
        runNumber += 1;
        state.targetPid = null;
        state.records = records;
        state.statReads = new Map();
        state.statusReads = new Map();
        state.statusHook = statusHook;
        state.activeStatusReads = 0;
        state.maxActiveStatusReads = 0;
        state.readdirDelayMs = readdirDelayMs;
        state.unknownEntryGone = unknownEntryGone;
        state.readdirErrno = readdirErrno;
        state.procScans = 0;
        const runDirectory = join(directory, String(runNumber));
        await mkdir(runDirectory);
        const pidPath = join(runDirectory, "pid");
        const script = `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setTimeout(()=>process.exit(0),${durationMs});setInterval(()=>{},1000);`;
        const stdoutPath = join(runDirectory, "stdout.log");
        const stderrPath = join(runDirectory, "stderr.log");
        const runPromise = executeArgv(
          [process.execPath, "-e", script],
          runDirectory,
          timeoutMs,
          stdoutPath,
          stderrPath,
          null,
          outputBudget,
        );
        let pid;
        for (let attempt = 0; attempt < 300; attempt += 1) {
          try {
            pid = Number(await originalReadFile(pidPath, "utf8"));
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            await new Promise((resolvePromise) =>
              setTimeout(resolvePromise, 10),
            );
          }
        }
        assert(
          Number.isSafeInteger(pid) && pid > 0,
          "fixture child PID was not observed",
        );
        state.targetPid = pid;
        const result = await runPromise;
        return {
          result,
          stderr: await originalReadFile(stderrPath, "utf8"),
        };
      };

      const races = await runFixture({
        unknownEntryGone: true,
        records: [
          { offset: 0, kind: "live" },
          { offset: 1, kind: "stat-exit", errno: "ENOENT" },
          { offset: 2, kind: "stat-exit", errno: "ESRCH" },
          { offset: 3, kind: "zombie" },
          { offset: 4, kind: "status-exit", errno: "ENOENT" },
          { offset: 5, kind: "status-exit", errno: "ESRCH" },
          { offset: 6, kind: "traced-unrelated" },
          { offset: 7, kind: "dead-lowercase" },
        ],
      });
      assert.equal(races.result.peakRssBytes, 128 * 1024);
      assert.equal(races.result.outputLimitExceeded, false);
      assert.equal(races.stderr, "");

      const directoryError = await runFixture({
        records: [{ offset: 0, kind: "live" }],
        readdirErrno: "EIO",
      });
      assert.equal(directoryError.result.peakRssBytes, null);
      assert.match(
        directoryError.stderr,
        /^\[RSS\] stage=readdir errno=EIO attempted=\d+ valid=0 no-match=\d+ errors=\d+\n$/,
      );

      const accessDenied = await runFixture({
        records: [
          {
            offset: 0,
            kind: "status-error",
            errnos: ["EACCES", "EIO"],
          },
        ],
      });
      assert.equal(accessDenied.result.peakRssBytes, null);
      assert.match(
        accessDenied.stderr,
        /^\[RSS\] stage=status errno=EACCES attempted=\d+ valid=0 no-match=1 errors=\d+\n$/,
      );
      assert.doesNotMatch(accessDenied.stderr, /private proc detail|\/proc\//);

      const descriptorLimit = await runFixture({
        records: [{ offset: 0, kind: "status-error", errno: "EMFILE" }],
      });
      assert.equal(descriptorLimit.result.peakRssBytes, null);
      assert.match(
        descriptorLimit.stderr,
        /^\[RSS\] stage=status errno=EMFILE attempted=\d+ valid=0 no-match=1 errors=\d+\n$/,
      );

      const missingRss = await runFixture({
        records: [{ offset: 0, kind: "missing-vmrss" }],
      });
      assert.equal(missingRss.result.peakRssBytes, null);
      assert.match(
        missingRss.stderr,
        /^\[RSS\] stage=vmrss errno=MISSING attempted=\d+ valid=0 no-match=1 errors=\d+\n$/,
      );

      const noGroup = await runFixture({
        records: [{ offset: 0, kind: "group-mismatch" }],
      });
      assert.equal(noGroup.result.peakRssBytes, null);
      assert.match(
        noGroup.stderr,
        /^\[RSS\] stage=no-match errno=NONE attempted=\d+ valid=0 no-match=\d+ errors=0\n$/,
      );

      const delayed = await runFixture({
        durationMs: 850,
        records: [{ offset: 0, kind: "delayed" }],
        statusHook: async (_record, reads) => {
          state.activeStatusReads += 1;
          state.maxActiveStatusReads = Math.max(
            state.maxActiveStatusReads,
            state.activeStatusReads,
          );
          try {
            if (reads <= 2)
              await new Promise((resolvePromise) =>
                setTimeout(resolvePromise, 350),
              );
            if (reads > 1) throw procError("EIO");
            return "Name:\tfixture\nVmRSS:\t512 kB\n";
          } finally {
            state.activeStatusReads -= 1;
          }
        },
      });
      assert.equal(state.maxActiveStatusReads, 1);
      assert.equal(delayed.result.exitCode, 0);
      assert.equal(delayed.result.peakRssBytes, null);
      assert.match(
        delayed.stderr,
        /^\[RSS\] stage=status errno=EIO attempted=\d+ valid=1 no-match=1 errors=\d+\n$/,
      );
      assert(
        delayed.result.durationMs >= 1000,
        "late failed scan was not awaited",
      );

      const signalsBeforeInitialScan = killCalls.length;
      const delayedInitial = await runFixture({
        durationMs: 50,
        timeoutMs: 200,
        readdirDelayMs: 350,
        records: [{ offset: 0, kind: "status-error", errno: "EIO" }],
      });
      assert.equal(delayedInitial.result.exitCode, 0);
      assert.equal(delayedInitial.result.timedOut, false);
      assert.equal(delayedInitial.result.peakRssBytes, null);
      assert.match(
        delayedInitial.stderr,
        /^\[RSS\] stage=status errno=EIO attempted=2 valid=0 no-match=0 errors=2\n$/,
      );
      assert.equal(
        state.procScans,
        Number(/attempted=(\d+)/.exec(delayedInitial.stderr)?.[1]),
        "RSS scan started after its diagnostic was formed",
      );
      assert.equal(
        killCalls
          .slice(signalsBeforeInitialScan)
          .some(({ signal }) => signal === "SIGTERM" || signal === "SIGKILL"),
        false,
        "a child that exited before its deadline received a timeout signal",
      );

      const bounded = await runFixture({
        records: [{ offset: 0, kind: "group-mismatch" }],
        outputBudget: {
          maxBytes: 40,
          usedBytes: 0,
          observedBytes: 0,
          exceeded: false,
        },
      });
      const returnedAt = Date.now();
      assert.equal(bounded.result.peakRssBytes, null);
      assert.equal(bounded.result.outputLimitExceeded, true);
      assert(Buffer.byteLength(bounded.stderr) <= 40);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 550));
      assert.equal(
        killCalls.some(
          ({ pid, signal, at }) =>
            pid < 0 && signal === "SIGKILL" && at > returnedAt,
        ),
        false,
        "output-limit SIGKILL timer fired after executeArgv returned",
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  },
);

void test("G14 cannot pass without sealed browser correlation lineage", async () => {
  const evidenceDir = await mkdtemp(
    join(tmpdir(), "coffee-browser-correlation-"),
  );
  try {
    await mkdir(join(evidenceDir, "gates/G14_OBSERVABILITY/artifacts"), {
      recursive: true,
    });
    await writeFile(join(evidenceDir, "context.json"), "{}\n", { mode: 0o600 });
    const failure = await verifyGateArtifacts(
      { id: "G14_OBSERVABILITY", command: "pnpm test:observability" },
      {
        runs: [
          {
            argv: ["pnpm", "test:observability"],
            exitCode: 0,
            timedOut: false,
            outputLimitExceeded: false,
          },
        ],
        artifacts: [],
      },
      evidenceDir,
    );
    assert.match(
      failure,
      /browser correlation child lineage or cleanup is invalid/u,
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

void test("G12 image hydration binds native G00 proof and verified runtime receipts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "launch-image-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contextFile = join(directory, "context.json");
  const preflightPath = join(
    directory,
    "gates/G00_PREFLIGHT/artifacts/preflight.json",
  );
  await mkdir(join(directory, "gates/G00_PREFLIGHT/artifacts"), {
    recursive: true,
  });
  const runId = "20261101T000000Z-abcdef0";
  const candidateSha = `abcdef0${"1".repeat(33)}`;
  const configSha256 = "2".repeat(64);
  const base = `node:26.8.1-alpine@sha256:${"3".repeat(64)}`;
  const nodeImageId = `sha256:${"4".repeat(64)}`;
  const proof = {
    schemaVersion: 1,
    gateId: "G00_PREFLIGHT",
    status: "PASS",
    runId,
    candidateSha,
    checks: [
      {
        id: "NATIVE_IMAGE_RUNTIME_IDENTITY",
        status: "PASS",
        facts: {
          declaredBomImages: { node: base },
          actualRuntimeProof: {
            node: {
              status: "PASS",
              imageId: nodeImageId,
              repoDigest: `node@sha256:${"3".repeat(64)}`,
              os: "linux",
              architecture: "amd64",
              cleanupSucceeded: true,
            },
          },
        },
      },
    ],
  };
  const context = {
    runId,
    candidateSha,
    baseConfigSha256: configSha256,
    evidenceDir: directory,
  };
  await writeFile(contextFile, JSON.stringify(context));
  const g00 = { id: "G00_PREFLIGHT", status: "PASS", artifacts: [] };
  const result = {
    runId,
    candidateSha,
    environment: { configSha256 },
    gates: [g00],
  };
  const images = Array.from({ length: 15 }, (_, index) => ({
    service: `role-${index}`,
    imageId: `sha256:${String(index.toString(16)).padStart(64, "0")}`,
  }));
  const options = {
    contextFile,
    evidenceDir: directory,
    result,
    readRuntimeImages: async () => images,
    readStorageImage: async () => ({ runId, candidateSha, baseImage: base }),
  };
  const writeProof = async (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(preflightPath, bytes);
    g00.artifacts = [
      {
        path: preflightPath,
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ];
  };
  await writeProof(proof);
  assert.deepEqual(await readLaunchImageEvidence(options), {
    nodeImageDigest: nodeImageId,
    imageDigests: images.map(({ imageId }) => imageId),
  });
  for (const change of [
    (value) => {
      value.runId = "20261101T000001Z-abcdef0";
    },
    (value) => {
      value.candidateSha = "f".repeat(40);
    },
    (value) => {
      value.checks[0].facts.actualRuntimeProof.node.imageId = "invalid";
    },
    (value) => {
      value.checks[0].facts.actualRuntimeProof.node.repoDigest = `node@sha256:${"f".repeat(64)}`;
    },
    (value) => {
      value.checks[0].facts.actualRuntimeProof.node.cleanupSucceeded = false;
    },
  ]) {
    const altered = structuredClone(proof);
    change(altered);
    await writeProof(altered);
    await assert.rejects(readLaunchImageEvidence(options));
  }
  await writeProof(proof);
  await writeFile(preflightPath, `${JSON.stringify(proof)} `);
  await assert.rejects(
    readLaunchImageEvidence(options),
    /G12_IMAGE_PREFLIGHT_HASH_MISMATCH/u,
  );
  await writeProof(proof);
  await assert.rejects(
    readLaunchImageEvidence({
      ...options,
      readStorageImage: async () => ({
        runId: "foreign",
        candidateSha,
        baseImage: base,
      }),
    }),
    /G12_IMAGE_NODE_BASE_MISMATCH/u,
  );
  await assert.rejects(
    readLaunchImageEvidence({
      ...options,
      readRuntimeImages: async () => {
        throw new Error("G12_RUNTIME_IMAGE_PROVENANCE_INVALID");
      },
    }),
    /G12_RUNTIME_IMAGE_PROVENANCE_INVALID/u,
  );
});

void test("G12 image hydration persists atomically and fails closed on error or deadline", async () => {
  for (const scenario of [
    "success",
    "reader-error",
    "write-error",
    "late-read",
    "late-write",
  ]) {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const previous = { nodeImageDigest: null, imageDigests: null };
    const result = { environment: { ...previous } };
    const record = {
      status: "PASS",
      reason: "",
      startedAt: new Date(now).toISOString(),
    };
    const images = {
      nodeImageDigest: `sha256:${"1".repeat(64)}`,
      imageDigests: Array(15).fill(`sha256:${"2".repeat(64)}`),
    };
    const persisted = [];
    await applyLaunchImageEvidence({
      contextFile: "/fixture/context.json",
      evidenceDir: "/fixture",
      result,
      gate: { timeout: 1800 },
      record,
      workloadDeadline: now + 2000000,
      now: () => now,
      readEvidence: async () => {
        if (scenario === "reader-error") throw new Error("invalid receipt");
        if (scenario === "late-read") now += 1800001;
        return images;
      },
      persist: async (_directory, current) => {
        if (scenario === "write-error") throw new Error("write failed");
        persisted.push(structuredClone(current.environment));
        if (scenario === "late-write" && persisted.length === 1) now += 1800001;
      },
    });
    if (scenario === "success") {
      assert.equal(record.status, "PASS");
      assert.deepEqual(result.environment, images);
      assert.deepEqual(persisted, [images]);
    } else {
      assert.equal(record.status, "FAIL", scenario);
      assert.deepEqual(result.environment, previous, scenario);
      assert.match(record.reason, /G12 image evidence validation failed/u);
      assert.deepEqual(
        persisted,
        scenario === "late-write" ? [images, previous] : [],
        scenario,
      );
    }
  }
});
