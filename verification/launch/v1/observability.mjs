#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { runObservabilityVerification } from "../../../tools/observability/verify.mjs";
import { runBrowserParent } from "./scenarios/browser.mjs";

try {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  let probePath = "/usr/bin/busybox";
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--probe" || !isAbsolute(args[1]))
      throw new Error(
        "usage: node verification/launch/v1/observability.mjs [--probe <absolutePath>]",
      );
    probePath = args[1];
  }
  const evidence = await runObservabilityVerification({
    probePath,
    runBrowserParent,
  });
  console.log(JSON.stringify(evidence));
} catch (error) {
  if (error.evidence) console.error(JSON.stringify(error.evidence));
  else
    console.error(JSON.stringify({ status: "FAIL", failure: error.message }));
  process.exitCode = 1;
}
