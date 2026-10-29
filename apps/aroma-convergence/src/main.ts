import { startConfiguredRuntime } from "@coffee-platform/runtime";
import { createAromaConvergenceComposition } from "./runtime-composition.js";

await startConfiguredRuntime(
  "aroma-convergence",
  createAromaConvergenceComposition(),
);
