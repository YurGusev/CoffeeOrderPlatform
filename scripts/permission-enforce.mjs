#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runPermissionMode } from "./permission-audit.mjs";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await runPermissionMode("enforce", process.argv.slice(2));
    process.exitCode = result.code;
  } catch (error) {
    console.error(`permission enforce: FAIL: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
