import {Effect} from "effect";

export const background = Effect.fork(Effect.succeed("unowned"));
