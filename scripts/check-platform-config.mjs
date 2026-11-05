#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import {
  checkPlatformConfig,
  ConfigError,
  runtimeContainerLimits,
} from "./config-lib.mjs";

const rootIndex = process.argv.indexOf("--root");
const root =
  (rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined) ??
  fileURLToPath(new URL("..", import.meta.url));

try {
  const result = await checkPlatformConfig(root);
  const compose = parseYaml(
    await readFile(join(root, "compose.yaml"), "utf8"),
    { json: true },
  );
  for (const service of [...Object.keys(result.config.services), "kafka"]) {
    const expected = runtimeContainerLimits(result.config, service);
    const actual = compose.services[service];
    if (
      actual.cpus !== expected.cpus ||
      actual.mem_limit !== expected.mem_limit
    )
      throw new ConfigError(
        "CONFIG-CONTAINER-LIMITS",
        `${service}: reference Compose differs from platform.yaml`,
      );
  }
  console.log(
    `platform config: OK (${result.runtimeCount} runtimes, ${result.environment})`,
  );
} catch (error) {
  console.error(`platform config: FAIL: ${error.message}`);
  process.exitCode = 1;
}
