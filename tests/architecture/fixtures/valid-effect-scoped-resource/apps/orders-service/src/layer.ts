import {Effect, Layer} from "effect";

export const resource = Layer.scoped("Resource", Effect.succeed("owned"));
