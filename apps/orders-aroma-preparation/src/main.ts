import { startConfiguredRuntime } from "@coffee-platform/runtime";
import { createAromaPreparationComposition } from "./runtime-composition.js";

await startConfiguredRuntime(
  "orders-aroma-preparation",
  createAromaPreparationComposition(),
);
