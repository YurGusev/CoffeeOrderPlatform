import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { PolicyClockTest, readPolicyClock } from "./src/green.js";

it.layer(PolicyClockTest)("runs an Effect test with the scoped test Layer", (layerIt) => {
  layerIt.effect("reads the deterministic policy clock", () =>
    Effect.gen(function* () {
      expect(yield* readPolicyClock).toBe(0n);
    }),
  );
});
