import { Context, Effect } from "effect";

interface ProbeDatabase {
  readonly ProbeDatabase: unique symbol;
}

interface ProbeDatabaseService {
  readonly ping: Effect.Effect<void>;
}

const ProbeDatabase: Context.Service<ProbeDatabase, ProbeDatabaseService> =
  Context.Service<ProbeDatabase, ProbeDatabaseService>("@coffee-platform/effect-diagnostics/ProbeDatabase");

export const missingContext: Effect.Effect<void> = ProbeDatabase.pipe(
  Effect.flatMap((database) => database.ping),
);
