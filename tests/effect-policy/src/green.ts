import { Context, Effect, Layer } from "effect";

export interface PolicyClock {
  readonly PolicyClock: unique symbol;
}

export interface PolicyClockService {
  readonly now: Effect.Effect<bigint>;
}

export const PolicyClock: Context.Service<PolicyClock, PolicyClockService> =
  Context.Service<PolicyClock, PolicyClockService>("@coffee-platform/effect-policy/PolicyClock");

export const readPolicyClock: Effect.Effect<bigint, never, PolicyClock> = Effect.gen(function* () {
  const clock = yield* PolicyClock;
  return yield* clock.now;
});

export const PolicyClockTest: Layer.Layer<PolicyClock> = Layer.succeed(PolicyClock, {
  now: Effect.succeed(0n),
});
