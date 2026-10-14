import {startConfiguredRuntime} from "@coffee-platform/runtime";
import {createRealtimeComposition} from "./runtime-composition.js";

await startConfiguredRuntime("realtime-gateway",createRealtimeComposition());
