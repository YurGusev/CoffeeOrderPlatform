import { Data, Effect } from "effect";

class ProbeFailure extends Data.TaggedError("ProbeFailure")<{}> {}

declare const failingEffect: Effect.Effect<number, ProbeFailure>;

export const missingError: () => Effect.Effect<number> = () => failingEffect;
