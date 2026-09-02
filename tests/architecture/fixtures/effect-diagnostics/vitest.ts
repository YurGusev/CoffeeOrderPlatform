import { it } from "@effect/vitest";
import { Effect } from "effect";

it("RED fixture: ordinary Vitest callback does not execute Effect", () =>
  Effect.void,
);
