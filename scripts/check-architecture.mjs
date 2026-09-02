#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture as checkCoreArchitecture } from "./check-architecture-core.mjs";
import { checkEffectArchitecture } from "./effect-architecture-policy.mjs";
import { checkEffectLegacyInventory } from "./check-effect-legacy-inventory.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCEPTED_DEPENDENCY_CRUISER = "18.2.0";

function preservePublicRuleIds(error) {
  if (error instanceof Error && error.message.startsWith("ARCH-TIME ")) {
    error.message = error.message.replace(/^ARCH-TIME\b/, "ARCH-TEMPORAL");
    error.ruleId = "ARCH-TEMPORAL";
  }
  return error;
}

export async function checkArchitecture(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  try {
    const core = await checkCoreArchitecture(resolvedRoot);
    const effect = await checkEffectArchitecture(resolvedRoot, { policyRoot: REPO_ROOT });
    const inventoryPath = join(resolvedRoot, "config/effect-legacy-inventory.json");
    const legacy = existsSync(inventoryPath)
      ? await checkEffectLegacyInventory(resolvedRoot)
      : { skipped: true };
    return { core, effect, legacy };
  } catch (error) {
    throw preservePublicRuleIds(error);
  }
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkArchitecture(parseRoot(process.argv.slice(2)));
    const coreSummary = result.core.skipped
      ? result.core.reason
      : `Dependency Cruiser ${ACCEPTED_DEPENDENCY_CRUISER}`;
    const effectSummary = `${result.effect.checked} Effect-policy sources checked`;
    const legacySummary = result.legacy.skipped
      ? "legacy inventory skipped"
      : `${result.legacy.entries} legacy entries locked`;
    console.log(`architecture: passed with ${coreSummary}; ${effectSummary}; ${legacySummary}`);
  } catch (error) {
    console.error(`architecture: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
