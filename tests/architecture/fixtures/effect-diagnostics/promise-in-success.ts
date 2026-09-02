import { Effect } from "effect";

declare const save: (value: number) => Promise<void>;

export const promiseInSuccess = Effect.succeed(1).pipe(Effect.map(save));
