import { Effect } from "effect";

export const anyUnknownErrorContext = Effect.gen(function* () {
  yield* Effect.context<unknown>();
  return yield* Effect.fail<any>("boom");
});

export const unknownCatch = Effect.tryPromise({
  try: async () => 1,
  catch: (error) => error,
});

export const globalErrorCatch = Effect.tryPromise({
  try: async () => 1,
  catch: (error) => new Error(String(error)),
});

export const globalErrorFailure = Effect.fail(new Error("boom"));

export class NativeEffectError extends Error {}
