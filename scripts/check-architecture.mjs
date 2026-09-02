#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture as checkCoreArchitecture } from "./check-architecture-core.mjs";
import { checkEffectArchitecture } from "./effect-architecture-lib.mjs";
import { checkEffectLegacyInventory } from "./check-effect-legacy-inventory.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function checkArchitecture(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  const core = await checkCoreArchitecture(resolvedRoot);
  const effect = await checkEffectArchitecture(resolvedRoot);
  const inventoryPath = join(resolvedRoot, "config/effect-legacy-inventory.json");
  const legacy = existsSync(inventoryPath)
    ? await checkEffectLegacyInventory(resolvedRoot)
    : { skipped: true };
  return { core, effect, legacy };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkArchitecture(parseRoot(process.argv.slice(2)));
    const effectSummary = result.effect.skipped ? "Effect rules skipped" : `${result.effect.files} Effect-policy sources checked`;
    const legacySummary = result.legacy.skipped
      ? "legacy inventory skipped"
      : `${result.legacy.entries} legacy entries locked`;
    console.log(`architecture: passed; ${effectSummary}; ${legacySummary}`);
  } catch (error) {
    console.error(`architecture: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
