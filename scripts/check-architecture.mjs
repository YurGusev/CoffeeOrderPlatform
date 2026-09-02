#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkArchitecture as checkCoreArchitecture } from "./check-architecture-core.mjs";

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
  try {
    return await checkCoreArchitecture(resolve(root));
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
    const effectSummary = `Effect policy ${result.effectPolicy.checked} files (${result.effectPolicy.legacyChecked} legacy)`;
    console.log(result.skipped
      ? `architecture: passed (${result.reason}; ${effectSummary})`
      : `architecture: passed with Dependency Cruiser ${ACCEPTED_DEPENDENCY_CRUISER}; ${effectSummary}`);
  } catch (error) {
    console.error(`architecture: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
