#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  stat,
  lstat,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { availableParallelism, cpus, totalmem, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadPlatformConfig } from "../../../scripts/config-lib.mjs";
import { validateLaunchContext } from "./report.mjs";
import { runManagedRollbackChild } from "./scenarios/rollback.mjs";
import {
  parse,
  runTransportFixture,
} from "../../../tests/realtime/soak.test.mjs";
import { hash, ROOT } from "../../../tests/realtime/fixtures/setup.mjs";
import { classifyResult } from "../../../tests/realtime/fixtures/protocol.mjs";
import {
  runBrowserParent,
  validateBrowserChildContext,
  verifyBrowserChildBundle,
} from "./scenarios/browser.mjs";
import {
  loadVerifiedGateImage,
  readVerifiedRuntimeImages,
} from "../../../tools/verified-infrastructure-image.mjs";

async function readPacketFile(directory, name, limit) {
  const path = join(directory, name);
  const info = await lstat(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o400 &&
      info.size > 0 &&
      info.size <= limit &&
      (await realpath(path)) === path,
    "qualification artifact invalid",
  );
  return await readFile(path);
}

async function claimQualification(runId, receiptSha256) {
  const home = resolve(userInfo().homedir);
  let directory = home;
  for (const component of [
    ".local",
    "state",
    "coffee-platform",
    "realtime-claims",
  ]) {
    directory = join(directory, component);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    assert.ok(
      info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid() &&
        (info.mode & 0o022) === 0 &&
        (await realpath(directory)) === directory,
      "qualification claim directory invalid",
    );
  }
  const path = join(directory, `${runId}.json`);
  await writeFile(path, `${JSON.stringify({ runId, receiptSha256 })}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  return path;
}

export async function admitRealtimeCapacity({ receiptPath, contextFile }) {
  assert.ok(isAbsolute(receiptPath) && isAbsolute(contextFile));
  const directory = dirname(receiptPath);
  assert.equal(basename(receiptPath), "qualification.json");
  const info = await lstat(directory);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o077) === 0 &&
      (await realpath(directory)) === directory,
  );
  const receiptBytes = await readPacketFile(
    directory,
    "qualification.json",
    64 * 1024,
  );
  const receipt = JSON.parse(receiptBytes);
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "baseConfigSha256",
      "candidateSha",
      "elapsedMs",
      "endedAt",
      "runId",
      "schemaVersion",
      "sealSha256",
      "startedAt",
      "status",
    ].sort(),
  );
  assert.match(receipt.runId ?? "", /^i12-[a-f0-9]{16}$/u);
  assert.equal(basename(directory), receipt.runId);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, "PASS");
  const active = await validateLaunchContext(contextFile);
  const config = await loadPlatformConfig(active.candidateRoot);
  const policy = config.verification.realtimeQualification;
  const startMs = Date.parse(receipt.startedAt);
  const endMs = Date.parse(receipt.endedAt);
  const now = Date.now();
  assert.ok(
    Number.isFinite(startMs) &&
      Number.isFinite(endMs) &&
      startMs <= endMs &&
      endMs <= now &&
      endMs - startMs <= policy.budgetSeconds * 1000 &&
      now - endMs <= policy.maximumAgeSeconds * 1000,
  );
  assert.ok(
    Number.isFinite(receipt.elapsedMs) &&
      receipt.elapsedMs >= 0 &&
      receipt.elapsedMs <= policy.budgetSeconds * 1000,
  );
  assert.equal(receipt.candidateSha, active.context.candidateSha);
  assert.equal(receipt.baseConfigSha256, active.context.baseConfigSha256);
  const sealBytes = await readPacketFile(directory, "seal.json", 64 * 1024);
  assert.equal(hash(sealBytes), receipt.sealSha256);
  const seal = JSON.parse(sealBytes);
  assert.deepEqual(
    Object.keys(seal).sort(),
    [
      "baseConfigSha256",
      "candidateSha",
      "checkoutRemoved",
      "childCandidateSha",
      "childRunId",
      "evidenceRemoved",
      "hashes",
      "parentRunId",
      "runId",
      "schemaVersion",
      "status",
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(seal.hashes ?? {}).sort(),
    [
      "baseConfig",
      "bundle",
      "childConfig",
      "childContext",
      "cleanup",
      "containers",
      "lineage",
      "manifest",
      "parentContext",
      "result",
    ].sort(),
  );
  assert.equal(seal.schemaVersion, 1);
  assert.equal(seal.status, "SEALED");
  assert.equal(seal.runId, receipt.runId);
  assert.equal(seal.candidateSha, active.context.candidateSha);
  assert.equal(seal.baseConfigSha256, active.context.baseConfigSha256);
  assert.equal(seal.checkoutRemoved, true);
  assert.equal(seal.evidenceRemoved, true);
  const files = {};
  for (const [key, name, limit] of [
    ["parentContext", "parent-context.json", 16 * 1024],
    ["childContext", "browser-context.json", 16 * 1024],
    ["lineage", "browser-lineage.json", 16 * 1024],
    ["bundle", "browser-source.bundle", 64 * 1024 * 1024],
    ["baseConfig", "browser-base.yaml", 1024 * 1024],
    ["childConfig", "browser-config.yaml", 1024 * 1024],
    ["manifest", "profile-manifest.json", 16 * 1024 * 1024],
    ["result", "result.json", 4 * 1024 * 1024],
    ["cleanup", "cleanup.json", 1024 * 1024],
    ["containers", "containers.json", 1024 * 1024],
  ]) {
    files[key] = await readPacketFile(directory, name, limit);
    assert.equal(hash(files[key]), seal.hashes?.[key]);
  }
  const parent = JSON.parse(files.parentContext);
  const child = JSON.parse(files.childContext);
  const lineage = JSON.parse(files.lineage);
  assert.equal(parent.runId, seal.parentRunId);
  assert.equal(parent.candidateSha, active.context.candidateSha);
  assert.equal(parent.baseConfigSha256, active.context.baseConfigSha256);
  assert.equal(child.runId, seal.childRunId);
  assert.equal(child.candidateSha, seal.childCandidateSha);
  validateBrowserChildContext(child, parent, resolve(parent.checkoutDir));
  assert.equal(hash(files.baseConfig), active.context.baseConfigSha256);
  assert.equal(hash(files.childConfig), child.baseConfigSha256);
  for (const path of [child.checkoutDir, child.evidenceDir])
    assert.equal(
      await lstat(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
      null,
      "qualification child retained",
    );
  await verifyBrowserChildBundle({
    bundlePath: join(directory, "browser-source.bundle"),
    baseCandidateSha: active.context.candidateSha,
    childContext: child,
    lineageReceipt: lineage,
    baseConfigBytes: files.baseConfig,
    childConfigBytes: files.childConfig,
    baseSourceRoot: active.candidateRoot,
  });
  const manifest = JSON.parse(files.manifest);
  const result = JSON.parse(files.result);
  const cleanup = JSON.parse(files.cleanup);
  const containers = JSON.parse(files.containers);
  assert.equal(manifest.runId, receipt.runId);
  assert.equal(
    manifest.qualification?.candidateSha,
    active.context.candidateSha,
  );
  assert.equal(
    manifest.qualification?.baseConfigSha256,
    active.context.baseConfigSha256,
  );
  assert.equal(
    manifest.qualification?.toolchainSha256,
    hash(
      await readFile(
        join(active.candidateRoot, "config/toolchain-versions.json"),
      ),
    ),
  );
  assert.equal(
    manifest.qualification?.lockfileSha256,
    hash(await readFile(join(active.candidateRoot, "pnpm-lock.yaml"))),
  );
  assert.equal(manifest.configSha256, child.baseConfigSha256);
  assert.equal(manifest.launchIdentity?.candidateSha, child.candidateSha);
  assert.equal(manifest.lineageReceiptSha256, hash(files.lineage));
  const verifiedImages = await readVerifiedRuntimeImages({ contextFile });
  assert.deepEqual(manifest.qualification.runtimeImages, verifiedImages);
  const kafka = await loadVerifiedGateImage({
    target: "kafka",
    contextFile,
    loadImage: false,
  });
  assert.equal(manifest.kafkaSupplyChain?.imageId, kafka.imageId);
  const host = {
    architecture: process.arch,
    platform: process.platform,
    availableParallelism: availableParallelism(),
    cpus: cpus().map((cpu) => cpu.model),
    memoryBytes: totalmem(),
    node: process.version,
    driverHostFdLimit: await readFile("/proc/self/limits", "utf8"),
  };
  assert.deepEqual(manifest.hardware, host);
  assert.equal(result.manifestSha256, hash(files.manifest));
  assert.equal(result.status, "PASS");
  assert.equal(result.launchProof, true);
  assert.equal(result.classification, "full-profile");
  assert.equal(result.cleanupVerified, true);
  assert.equal(classifyResult(result).status, "PASS");
  assert.ok(
    receipt.elapsedMs >= result.durationMs &&
      endMs - startMs >= result.durationMs,
    "qualification measurement exceeds total elapsed time",
  );
  assert.equal(cleanup.verified, true);
  assert.equal(cleanup.network?.created, true);
  assert.equal(cleanup.network?.removed, true);
  assert.equal(cleanup.network?.name, `${receipt.runId}-net`);
  assert.equal(cleanup.owner?.removed, true);
  assert.equal(cleanup.syntheticPrivateMaterialRemoved, true);
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
  assert.ok(
    Array.isArray(containers) &&
      Array.isArray(cleanup.receipts) &&
      containers.length === roles.length &&
      cleanup.receipts.length === roles.length,
  );
  for (const role of roles) {
    const matches = containers.filter((entry) => entry.role === role);
    const removed = cleanup.receipts.filter((entry) => entry.role === role);
    assert.equal(matches.length, 1);
    assert.equal(removed.length, 1);
    assert.equal(matches[0].name, `${receipt.runId}-${role}`);
    assert.match(matches[0].id ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(removed[0].id, matches[0].id);
    assert.equal(removed[0].removed, true);
    assert.equal(removed[0].logsCaptured, true);
    if (
      ["edge-gateway", "api-public", "realtime-gateway", "edge-nginx"].includes(
        role,
      )
    ) {
      const expected = verifiedImages.find((entry) => entry.service === role);
      assert.equal(matches[0].image, expected?.imageId);
      assert.equal(manifest.images?.[role], expected?.imageId);
      const nginx = role === "edge-nginx";
      assert.deepEqual(
        matches[0].native?.entrypoint,
        nginx ? ["nginx"] : ["node", "scripts/permission-enforce.mjs"],
      );
      assert.deepEqual(
        matches[0].native?.command,
        nginx ? ["-g", "daemon off;"] : ["--entry", "dist/main.js"],
      );
      const expectedMounts = nginx
        ? ["/run/secrets/edge-nginx"]
        : [
            "/app/config/platform.yaml",
            "/run/secrets/coffee-platform.yaml",
            "/run/coffee-launch/context.json",
            ...(role === "edge-gateway" ? ["/run/g15-browser/idp-ca.crt"] : []),
          ];
      assert.deepEqual(
        matches[0].native?.mounts
          ?.map((mount) => ({ Destination: mount.Destination, RW: mount.RW }))
          .sort((a, b) =>
            a.Destination < b.Destination
              ? -1
              : a.Destination > b.Destination
                ? 1
                : 0,
          ),
        expectedMounts
          .map((Destination) => ({ Destination, RW: false }))
          .sort((a, b) =>
            a.Destination < b.Destination
              ? -1
              : a.Destination > b.Destination
                ? 1
                : 0,
          ),
      );
    }
  }
  assert.equal(
    containers.find((entry) => entry.role === "kafka").image,
    kafka.imageId,
  );
  assert.ok(
    Date.now() >= endMs &&
      Date.now() - endMs <= policy.maximumAgeSeconds * 1000,
    "qualification expired during admission",
  );
  const claimPath = await claimQualification(receipt.runId, hash(receiptBytes));
  return { receipt, receiptSha256: hash(receiptBytes), claimPath };
}

function writeSoakFailure(result) {
  if (!result.error) return;
  const diagnostic = result.error.diagnostic ?? result.error.message;
  if (typeof diagnostic === "string" && diagnostic)
    process.stderr.write(`soak failed: ${diagnostic}\n`);
}

async function runWorker(contextFile, resultDir, runId) {
  assert.match(runId, /^i12-[a-f0-9]{16}$/u);
  const prepare = parse([
    "--prepare",
    "--profile",
    "operator-1",
    "--result-dir",
    resultDir,
  ]);
  prepare.runId = runId;
  prepare.qualification = true;
  prepare.launchPath = { launchContextFile: contextFile };
  const prepared = await runTransportFixture(prepare);
  writeSoakFailure(prepared);
  assert.equal(prepared.status, "prepared-not-launch-proof");
  assert.equal(prepared.error, null);
  const manifestBytes = await readFile(
    join(resultDir, "profile-manifest.json"),
  );
  const manifestSha256 = hash(manifestBytes);
  assert.equal(manifestSha256, prepared.manifestSha256);
  assert.ok(
    JSON.parse(manifestBytes).qualification,
    "verified runtime image binding required",
  );
  const options = parse([
    "--prepared",
    resultDir,
    "--approve-manifest",
    manifestSha256,
  ]);
  options.runId = runId;
  const result = await runTransportFixture(options);
  writeSoakFailure(result);
  assert.equal(result.status, "PASS");
  assert.equal(result.launchProof, true);
  assert.equal(result.cleanupVerified, true);
  assert.equal(classifyResult(result).status, "PASS");
  return { runId, resultDir };
}

export async function runRealtimeCapacity({ launchContextFile, resultDir }) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  assert.ok(isAbsolute(launchContextFile) && isAbsolute(resultDir));
  const options = parse([
    "--prepare",
    "--profile",
    "operator-1",
    "--result-dir",
    resultDir,
  ]);
  const active = await validateLaunchContext(launchContextFile);
  assert.equal(active.candidateRoot, ROOT);
  const config = await loadPlatformConfig(
    ROOT,
    join(ROOT, "config/platform.yaml"),
  );
  const budgetMs =
    config.verification.realtimeQualification.budgetSeconds * 1000;
  const parent = dirname(options.resultDir);
  assert.equal(
    await realpath(parent),
    parent,
    "qualification result parent must not contain symlinks",
  );
  const parentInfo = await stat(parent);
  assert.ok(
    parentInfo.isDirectory() &&
      parentInfo.uid === process.getuid() &&
      (parentInfo.mode & 0o022) === 0,
  );
  const runId = `i12-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const witnessPath = `${options.resultDir}.ownership.json`;
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
  await writeFile(
    witnessPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        parentCandidateSha: active.context.candidateSha,
        network: `${runId}-net`,
        containerNames: roles.map((role) => `${runId}-${role}`),
        runtimeImageTags: [
          "edge-gateway",
          "api-public",
          "realtime-gateway",
          "edge-nginx",
        ].map((role) => `${runId}-runtime-${role}:latest`),
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o400 },
  );
  const remainingMs = Math.floor(budgetMs - (performance.now() - started));
  assert.ok(remainingMs > 0, "qualification budget expired before preparation");
  const child = await runManagedRollbackChild({
    args: [
      fileURLToPath(import.meta.url),
      "--worker",
      launchContextFile,
      options.resultDir,
      runId,
    ],
    cwd: ROOT,
    env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: launchContextFile },
    timeoutMs: remainingMs,
    terminationGraceMs: 30_000,
  });
  const artifactsDir = join(
    active.sourceRoot,
    "evidence/launch/qualifications",
    runId,
  );
  const sealBytes = await readFile(join(artifactsDir, "seal.json"));
  const seal = JSON.parse(sealBytes);
  assert.equal(seal.status, "SEALED");
  assert.equal(seal.runId, runId);
  const stdoutReceipt = JSON.parse(
    child.stdout.split(/\r?\n/u).filter(Boolean).at(-1),
  );
  assert.deepEqual(stdoutReceipt.qualificationSeal, seal);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs <= budgetMs, "qualification budget exceeded");
  const receipt = {
    schemaVersion: 1,
    status: "PASS",
    runId,
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs,
    candidateSha: active.context.candidateSha,
    baseConfigSha256: active.context.baseConfigSha256,
    sealSha256: hash(sealBytes),
  };
  const receiptPath = join(artifactsDir, "qualification.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  return { receipt, receiptPath, witnessPath };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--worker") {
      assert.equal(args.length, 4);
      assert.equal(process.env.COFFEE_LAUNCH_CONTEXT_FILE, args[1]);
      const result = await runBrowserParent({
        qualificationRunId: args[3],
        runQualification: (contextFile) =>
          runWorker(contextFile, args[2], args[3]),
      });
      console.log(JSON.stringify(result));
    } else {
      assert.equal(args.length, 4);
      assert.equal(args[0], "--context");
      assert.equal(args[2], "--result-dir");
      console.log(
        JSON.stringify(
          await runRealtimeCapacity({
            launchContextFile: args[1],
            resultDir: args[3],
          }),
        ),
      );
    }
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "realtime capacity failed",
    );
    if (typeof error?.diagnostic === "string" && error.diagnostic)
      console.error(error.diagnostic);
    process.exitCode = 1;
  }
}
