import {Effect} from "effect";

export const mutation = Effect.succeed("send").pipe(Effect.retry("unsafe"));
