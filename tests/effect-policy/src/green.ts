import { Context, Effect, Layer } from "effect";

export class PolicyClock extends Context.Service<PolicyClock, {
  readonly now: Effect.Effect<bigint>;
}>()("@coffee-platform/effect-policy/PolicyClock") {}

export const readPolicyClock: Effect.Effect<bigint, never, PolicyClock> = Effect.gen(function* () {
  const clock = yield* PolicyClock;
  return yield* clock.now;
});

export const PolicyClockTest = Layer.succeed(PolicyClock, {
  now: Effect.succeed(0n),
});
