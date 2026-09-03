import {Effect} from "effect";

export const result = Effect.succeed("bad").pipe(Effect.provide(undefined));
