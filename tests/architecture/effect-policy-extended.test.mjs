import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkEffectArchitecture } from "../../scripts/effect-architecture-policy.mjs";
import { checkEffectLegacyInventory } from "../../scripts/check-effect-legacy-inventory.mjs";
import { checkEffectToolchain } from "../../scripts/check-effect-toolchain.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function sourceRoot(path, source) {
  const root = await mkdtemp(join(tmpdir(), "coffee-effect-policy-extended-"));
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, source, "utf8");
  return root;
}

async function expectRule(path, source, ruleId) {
  const root = await sourceRoot(path, source);
  try {
    await assert.rejects(
      checkEffectArchitecture(root, { policyRoot: REPO_ROOT }),
      new RegExp(ruleId),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("RED ARCH-EFFECT-MODULE-ALLOWLIST: side-effect imports cannot bypass module policy", () =>
  expectRule(
    "apps/orders-service/src/application/side-effect.ts",
    'import "effect/unstable/workflow/Workflow";\nexport const loaded = true;\n',
    "ARCH-EFFECT-MODULE-ALLOWLIST",
  ));

void test("RED ARCH-EFFECT-SCOPED-LAYER: finalized resource cannot use Layer.effect", () =>
  expectRule(
    "packages/platform-runtime/src/layer.ts",
    'import { Effect, Layer } from "effect";\nexport const layer = Layer.effect("Resource", Effect.acquireRelease(Effect.succeed({}), () => Effect.void));\n',
    "ARCH-EFFECT-SCOPED-LAYER",
  ));

void test("RED ARCH-EFFECT-DIAGNOSTIC-WAIVER: incomplete inline disable is rejected", () =>
  expectRule(
    "apps/orders-service/src/application/waiver.ts",
    '/** @effect-diagnostics floatingEffect:off */\nexport const value = 1;\n',
    "ARCH-EFFECT-DIAGNOSTIC-WAIVER",
  ));

void test("GREEN ARCH-EFFECT-DIAGNOSTIC-WAIVER: exact temporary waiver metadata is accepted", async () => {
  const root = await sourceRoot(
    "packages/platform-runtime/src/interop/waiver.ts",
    '/** @coffee-effect-waiver rule=floatingEffect owner=#26 removeAfter=3.4 reason=temporary callback bridge */\n/** @effect-diagnostics floatingEffect:off */\nexport const value = 1;\n',
  );
  try {
    await checkEffectArchitecture(root, { policyRoot: REPO_ROOT });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function duplicateToolchainRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-effect-duplicate-"));
  for (const path of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.effect.json",
    "config/toolchain-versions.json",
    "platform/runtime-foundation-decision.json",
    "tests/effect-policy/tsconfig.json",
  ]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(REPO_ROOT, path), target);
  }

  const lockPath = join(root, "pnpm-lock.yaml");
  const lock = await readFile(lockPath, "utf8");
  const marker = "packages:\n";
  assert.ok(lock.includes(marker), "pnpm lock packages section is required");
  await writeFile(
    lockPath,
    lock.replace(marker, `${marker}\n  effect@3.22.1: {}\n`),
    "utf8",
  );
  return root;
}

void test("RED EFFECT-TOOLCHAIN-DUPLICATE: second Effect core version is rejected", async () => {
  const root = await duplicateToolchainRoot();
  try {
    await assert.rejects(
      checkEffectToolchain(root),
      /EFFECT-TOOLCHAIN-DUPLICATE/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

async function immutableLegacyWorktree() {
  const parent = await mkdtemp(join(tmpdir(), "coffee-effect-legacy-worktree-"));
  const root = join(parent, "checkout");
  runGit(REPO_ROOT, ["worktree", "add", "--detach", root, "HEAD"]);
  const inventory = JSON.parse(
    await readFile(join(root, "config/effect-legacy-inventory.json"), "utf8"),
  );
  return {
    parent,
    root,
    sourcePath: inventory.legacyProductionSourceFiles[0],
  };
}

void test("RED ARCH-EFFECT-LEGACY-GROWTH: registered legacy source is byte-for-byte immutable", async () => {
  const fixture = await immutableLegacyWorktree();
  try {
    await checkEffectLegacyInventory(fixture.root, { baseRef: "missing-base-ref" });
    const source = join(fixture.root, fixture.sourcePath);
    await writeFile(source, `${await readFile(source, "utf8")}\n// forbidden legacy edit\n`, "utf8");
    await assert.rejects(
      checkEffectLegacyInventory(fixture.root, { baseRef: "missing-base-ref" }),
      /ARCH-EFFECT-LEGACY-GROWTH.*registered legacy source differs/s,
    );
  } finally {
    runGit(REPO_ROOT, ["worktree", "remove", "--force", fixture.root]);
    await rm(fixture.parent, { recursive: true, force: true });
  }
});
