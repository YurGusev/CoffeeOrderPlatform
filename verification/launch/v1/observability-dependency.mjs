#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  inspectOwnedTelemetry,
  readAcceptedObservabilityRelease,
  refreshLocalCollector,
} from "../../../tools/observability/service.mjs";

const USAGE =
  "usage: node verification/launch/v1/observability-dependency.mjs inspect <root>|refresh|accepted";

try {
  const [action, ...args] = process.argv.slice(2);
  if (action === "inspect") {
    if (args.length !== 1 || !args[0]) throw new Error(USAGE);
    process.stdout.write(
      JSON.stringify(inspectOwnedTelemetry({ root: args[0] })),
    );
  } else if (action === "refresh") {
    await refreshLocalCollector(JSON.parse(readFileSync(0, "utf8")));
  } else if (action === "accepted") {
    const accepted = await readAcceptedObservabilityRelease();
    process.stdout.write(
      JSON.stringify({
        root: accepted.root,
        helper: accepted.helper,
        config: accepted.config,
      }),
    );
  } else {
    throw new Error(USAGE);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
