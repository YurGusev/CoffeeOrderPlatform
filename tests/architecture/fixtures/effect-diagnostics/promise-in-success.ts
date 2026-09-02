import { Effect } from "effect";

export const promiseInSuccess: Effect.Effect<Promise<number>> = Effect.succeed(
  Promise.resolve(1),
);
