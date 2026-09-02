import {Effect} from "effect";

export const service = Effect.gen(function* () {
  const value = yield* Effect.succeed("owned");
  return value;
});
