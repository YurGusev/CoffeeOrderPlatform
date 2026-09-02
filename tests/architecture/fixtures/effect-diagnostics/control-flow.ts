import { Effect } from "effect";

export const nestedRuntime = Effect.gen(function* () {
  const run = () => Effect.runSync(Effect.succeed(1));
  return run();
});

export const tryCatchGenerator = Effect.gen(function* () {
  try {
    return yield* Effect.succeed(1);
  } catch {
    return 0;
  }
});

export const manualAbortController = Effect.gen(function* () {
  return new AbortController().signal;
});

export const asyncFunction = async () => {
  await Promise.resolve(1);
};

export const outdatedApi = Effect.gen(function* () {
  // @ts-expect-error -- RED fixture intentionally invokes removed Effect v3 API.
  return yield* Effect.runtime();
});
