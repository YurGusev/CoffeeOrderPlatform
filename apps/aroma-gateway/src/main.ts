import { createHash } from "node:crypto";
import {
  startConfiguredRuntime,
  type RuntimeComposition,
  type RuntimeCompositionContext,
} from "@coffee-platform/runtime";
import { ProviderCartReader } from "./application/cart-reader.js";
import {
  sha256CatalogHash,
  type CatalogExportBoundary,
  type CatalogStartedRecord,
  type CatalogExportBatchPersistenceInput,
  type CatalogExportSummary,
} from "./application/catalog-export.js";
import {
  createProviderCatalogSource,
  sourceIdentityForOffer,
} from "./application/provider-catalog-source.js";
import { ProviderCartMutator } from "./application/provider-cart-mutator.js";
import { GatewayMutationExecutor } from "./domain/mutation-journal.js";
import { ProviderMutationJournalStore } from "./infrastructure/database/provider-mutation-journal.js";
import { OfferBindingStore } from "./infrastructure/database/offer-binding-store.js";
import { ProviderSessionStoreAdapter } from "./infrastructure/database/provider-session-store.js";
import { ProviderHttpClient } from "./infrastructure/provider/http-client.js";
import { ProviderSessionManager } from "./infrastructure/provider/session.js";
import {
  createGatewayTelemetry,
  GatewayMetrics,
} from "./infrastructure/observability.js";
import {
  registerAromaBindingRoutes,
  registerAromaCartSnapshotRoute,
  registerAromaCatalogExportRoute,
  registerAromaMutationRoutes,
} from "./transport/http/index.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function requiredSecretString(
  context: RuntimeCompositionContext,
  path: string,
): string {
  const value = secretAt(context, path);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !value.isWellFormed() ||
    value.includes("\u0000")
  )
    throw new Error(
      `${path.toUpperCase().replaceAll(".", "_")}_NOT_CONFIGURED`,
    );
  return value;
}

function providerOrigin(context: RuntimeCompositionContext): string {
  const aroma = context.config.aroma;
  if (
    aroma.origin.scheme !== "https" ||
    aroma.origin.host.length === 0 ||
    aroma.origin.host.includes("/") ||
    aroma.origin.host.includes("\\") ||
    aroma.origin.host.includes("\u0000") ||
    aroma.origin.port !== 443 ||
    aroma.redirectsAllowed !== false
  )
    throw new Error("AROMA_ORIGIN_POLICY_INVALID");
  return `https://${aroma.origin.host}`;
}

function cartTimeoutMs(context: RuntimeCompositionContext): number {
  const profile =
    context.config.services["aroma-gateway"].deadlineProfiles["cartMs"];
  if (
    typeof profile !== "number" ||
    !Number.isSafeInteger(profile) ||
    profile <= 0
  )
    throw new Error("AROMA_CART_DEADLINE_NOT_CONFIGURED");
  return profile;
}

const gatewayMetrics = new GatewayMetrics();
const gatewayTelemetry = createGatewayTelemetry(gatewayMetrics);

const composition: RuntimeComposition = {
  metrics: () => gatewayMetrics.render(),
  readinessChecks: [
    {
      name: "aroma-provider-session",
      check: () =>
        providerClient?.isReady() === true &&
        providerSessions?.isReady() === true,
    },
  ],
  configure: async (app, _signal, database, _kafka, context) => {
    if (database === undefined)
      throw new Error("aroma-gateway database is required");
    if (context === undefined)
      throw new Error("aroma-gateway runtime context is required");
    let client: ProviderHttpClient | undefined;
    let sessions: ProviderSessionManager | undefined;
    try {
      client = new ProviderHttpClient({
        origin: providerOrigin(context),
        timeoutMs: cartTimeoutMs(context),
        maxResponseBytes: 2 * 1024 * 1024,
        connections: context.config.services["aroma-gateway"].concurrency,
        telemetry: gatewayTelemetry,
      });
      sessions = new ProviderSessionManager({
        transport: client,
        store: new ProviderSessionStoreAdapter(database),
        encryptionKey: createHash("sha256")
          .update(
            requiredSecretString(context, "aroma.sessionEncryptionKey"),
            "utf8",
          )
          .digest(),
        telemetry: gatewayTelemetry,
      });
      providerSessions = sessions;
      providerClient = client;
      providerSessionHandle = sessions;
      const providerSession = sessions;
      const bindings = new OfferBindingStore(database);
      const credentials = {
        scopeRef: context.config.aroma.scopeRef,
        email: requiredSecretString(context, "aroma.email"),
        password: requiredSecretString(context, "aroma.password"),
      } as const;
      const catalogIdentityKey = Buffer.from(
        requiredSecretString(context, "aroma.catalogIdentityKeyV1"),
        "utf8",
      );
      const exportBoundary: CatalogExportBoundary = {
        identity: {
          resolve: (offer, exportContext) =>
            sourceIdentityForOffer(
              offer,
              exportContext.supplierRef,
              catalogIdentityKey,
            ),
        },
        hash: { sha256: sha256CatalogHash },
        persistence: {
          beginExport: (record: CatalogStartedRecord, signal) =>
            bindings.beginExport(
              record.snapshotRef,
              record.supplierRef,
              signal,
            ),
          recordBatch: (input: CatalogExportBatchPersistenceInput, signal) => {
            const supplierRef = input.identities[0]?.supplierRef;
            if (supplierRef === undefined) return;
            return bindings.recordBatch(
              input.record.snapshotRef,
              supplierRef,
              input.record,
              input.identities,
              signal,
            );
          },
          completeExport: (summary: CatalogExportSummary, signal) =>
            bindings.completeExport(summary, signal),
          failExport: (input, signal) =>
            bindings.failExport(input.record.snapshotRef, signal),
          abortExport: (snapshotRef, signal) =>
            bindings.abortExport(snapshotRef, signal),
        },
      };
      const reader = new ProviderCartReader({
        sessions,
        credentials,
        bindings,
        supplierRef: context.config.aroma.supplierRef,
        defaultPacking: context.config.aroma.defaultPacking,
        sourceIdentityKey: catalogIdentityKey,
      });
      const journal = new ProviderMutationJournalStore(database, {
        telemetry: gatewayTelemetry,
      });
      mutationJournal = journal;
      const mutator = new ProviderCartMutator({
        sessions: providerSession,
        credentials,
        bindings,
        supplierRef: context.config.aroma.supplierRef,
        sourceIdentityKey: catalogIdentityKey,
        defaultPacking: context.config.aroma.defaultPacking,
        transport: client,
      });
      const executor = new GatewayMutationExecutor(
        journal,
        mutator.execute.bind(mutator),
      );
      registerAromaBindingRoutes(
        app,
        database,
        context,
        context.config.aroma.supplierRef,
      );
      registerAromaCartSnapshotRoute(app, reader, context);
      registerAromaCatalogExportRoute(
        app,
        (supplierRef, signal) =>
          createProviderCatalogSource({
            sessions: providerSession,
            credentials,
            supplierRef,
            sourceIdentityKey: catalogIdentityKey,
            pageSize: 10,
            signal,
          }),
        exportBoundary,
        context,
        context.config.aroma.supplierRef,
        gatewayTelemetry,
      );
      registerAromaMutationRoutes(app, executor, context);
    } catch (error) {
      providerSessions = undefined;
      providerClient = undefined;
      if (sessions !== undefined) await sessions.close();
      else await client?.close();
      throw error;
    }
  },
  resources: [
    {
      name: "aroma-mutation-journal-recovery",
      start: async (signal) => {
        const journal = mutationJournal;
        if (journal === undefined)
          throw new Error("aroma-gateway mutation journal is not configured");
        await journal.recoverAfterRestart(undefined, signal);
      },
      stop: () => {
        mutationJournal = undefined;
      },
      destroy: () => {
        mutationJournal = undefined;
      },
    },
    {
      name: "aroma-provider-session",
      start: () => {
        if (providerSessions === undefined)
          throw new Error("aroma-gateway provider session is not configured");
      },
      stop: async () => {
        const current = providerSessionHandle;
        providerSessions = undefined;
        providerClient = undefined;
        await current?.close();
      },
      destroy: () => {
        const current = providerSessionHandle;
        providerSessions = undefined;
        providerClient = undefined;
        current?.forceDestroy();
      },
    },
  ],
};

let providerSessions: ProviderSessionManager | undefined;
let providerClient: ProviderHttpClient | undefined;
let mutationJournal: ProviderMutationJournalStore | undefined;
// Keep the owned handle after stop clears readiness. Runtime destroy must still
// reach the same manager if a stop deadline expires while reads are pending.
let providerSessionHandle: ProviderSessionManager | undefined;

await startConfiguredRuntime("aroma-gateway", composition);
