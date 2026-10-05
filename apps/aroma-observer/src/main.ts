import {startConfiguredRuntime} from "@coffee-platform/runtime";
import {createAromaObserverComposition} from "./runtime-composition.js";

await startConfiguredRuntime("aroma-observer",createAromaObserverComposition());
