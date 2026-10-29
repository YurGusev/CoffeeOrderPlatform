import { startConfiguredRuntime } from "@coffee-platform/runtime";
import { createEdgeAuthComposition } from "./index.js";

await startConfiguredRuntime("edge-gateway", createEdgeAuthComposition());
