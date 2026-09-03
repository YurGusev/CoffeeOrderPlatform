import {Effect, Layer} from "effect";

export const layer = Layer.provide(Layer.succeed("Test", Effect.succeed("ok")));
