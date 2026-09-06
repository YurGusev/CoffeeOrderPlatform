#!/usr/bin/env node

import {checkPlatformConfig} from "./config-lib.mjs";

try {
  const result = await checkPlatformConfig();
  console.log(`security material: OK (${result.environment}, encrypted repository leaves and runtime scopes)`);
} catch (error) {
  console.error(`security material: FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
