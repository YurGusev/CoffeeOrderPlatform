import type { Effect as EffectType } from "effect";
import { Context, Effect, Layer } from "effect";

class MissingLayerService extends Context.Service<MissingLayerService>()(
  "@coffee-platform/effect-diagnostics/MissingLayerService",
  { make: Effect.succeed({}) },
) {
  static readonly Default = Layer.effect(this, this.make);
}

declare const layerWithMissingRequirement: Layer.Layer<
  MissingLayerService,
  never,
  MissingLayerService
>;

// @ts-expect-error -- RED fixture intentionally drops a required Layer service.
export const missingLayerContext: Layer.Layer<MissingLayerService> =
  layerWithMissingRequirement;

export const implicitEffectFnParameter = Effect.fn("implicitEffectFnParameter")(
  (input) => Effect.succeed(input),
);

class FileSystem extends Context.Service<
  FileSystem,
  { readonly write: (value: string) => EffectType.Effect<void> }
>()("@coffee-platform/effect-diagnostics/FileSystem") {}

export class LeakingCache extends Context.Service<
  LeakingCache,
  {
    readonly read: EffectType.Effect<string, never, FileSystem>;
    readonly save: () => EffectType.Effect<void, never, FileSystem>;
  }
>()("@coffee-platform/effect-diagnostics/LeakingCache") {}

class ServiceA extends Context.Service<ServiceA>()(
  "@coffee-platform/effect-diagnostics/ServiceA",
  { make: Effect.succeed({}) },
) {
  static readonly Default = Layer.effect(this, this.make);
}

class ServiceB extends Context.Service<ServiceB>()(
  "@coffee-platform/effect-diagnostics/ServiceB",
  { make: Effect.succeed({}) },
) {
  static readonly Default = Layer.effect(this, this.make);
}

export const multipleProvide = Effect.void.pipe(
  Effect.provide(ServiceA.Default),
  Effect.provide(ServiceB.Default),
);

export const strictProvide = Effect.void.pipe(
  Effect.provide(ServiceA.Default),
);
