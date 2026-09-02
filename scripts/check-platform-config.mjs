#!/usr/bin/env node
import {checkPlatformConfig} from './config-lib.mjs';

const rootIndex = process.argv.indexOf('--root');
const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;

try {
  const result = await checkPlatformConfig(root);
  console.log(`platform config: OK (${result.runtimeCount} runtimes, ${result.environment})`);
} catch (error) {
  console.error(`platform config: FAIL: ${error.message}`);
  process.exitCode = 1;
}
