import {randomUUID} from "node:crypto";
import {CatalogTelemetry} from "./observability.js";
import {AROMA_SUPPLIER_REF} from "@coffee-platform/config";
import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition, type RuntimeCompositionContext} from "@coffee-platform/runtime";
import {parseServiceTransportMaterial} from "@coffee-platform/security";
import {createCatalogImportStore, type CatalogImportStore} from "./catalog-import-store.js";
import {createHourlyScheduler, type HourlyScheduler} from "./hourly-scheduler.js";
import {InternalCatalogClient} from "./internal-api-client.js";
import {recoverIncompleteImports} from "./reconcile-imports.js";
import {runCatalogImport} from "./run-catalog-import.js";

function secretAt(context: RuntimeCompositionContext, path: string): unknown {
  let value: unknown = context.secrets;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing runtime secret ${path}`);
    value = (value as Readonly<Record<string, unknown>>)[part];
  }
  if (value === undefined) throw new Error(`missing runtime secret ${path}`);
  return value;
}

function apiInternalOrigin(context: RuntimeCompositionContext): string {
  const target = context.config.services["catalog-supplier-sync"].outbound.find(entry => entry.startsWith("api-internal:"));
  if (target === undefined) throw new Error("CATALOG_INTERNAL_API_ORIGIN_NOT_CONFIGURED");
  return `https://${target}`;
}

let telemetry = new CatalogTelemetry();
let http: HttpClient | undefined;
let scheduler: HourlyScheduler | undefined;
let store: CatalogImportStore | undefined;
let recovered = false;
let schedulerController: AbortController | undefined;
let schedulerPromise: Promise<void> | undefined;
let schedulerRunning = false;
let supervisorAlive = false;
let skippedTicks = 0;
let schedulerFailure: unknown;
let runtimeSignal: AbortSignal | undefined;
let runScheduledImport: (() => Promise<void>) | undefined;

const composition: RuntimeComposition = {
  readinessChecks: [{name: "catalog-recovery-supervisor", check: () => recovered && supervisorAlive && schedulerController?.signal.aborted === false}],
  configure: (app, processSignal, database, _kafka, context) => {
    if (database === undefined || context === undefined) throw new Error("catalog supplier sync requires database and runtime context");
    const runtime = context.config.services["catalog-supplier-sync"];
    if (runtime.scheduler === null) throw new Error("catalog scheduler configuration is required");
    const importDeadlineMs = runtime.deadlineMs;
    if (importDeadlineMs === null) throw new Error("catalog import deadline configuration is required");
    telemetry = new CatalogTelemetry(value => app.log.info(value, "catalog import diagnostic"));
    store = createCatalogImportStore(database, telemetry);
    const material = parseServiceTransportMaterial(
      secretAt(context, "security.serviceTransportKeys.catalog-supplier-sync"),
      context.config.environment,
      "catalog-supplier-sync",
    );
    http = createHttpClient({
      origin: apiInternalOrigin(context),
      tls: {material, targetEnvironment: context.config.environment, targetRuntime: "api-internal"},
      connections: 1,
      pipelining: 1,
    });
    const client = new InternalCatalogClient(http);
    runtimeSignal = processSignal;
    const run = async (): Promise<void> => {
      const signal = schedulerController?.signal;
      if (signal === undefined) throw new Error("catalog scheduler signal is unavailable");
      schedulerRunning = true;
      schedulerFailure = undefined;
      try {
        // Reconcile before every traversal, including after an unknown durable outcome.
        // A failed recovery blocks creation and HTTP export until the next tick.
        await recoverIncompleteImports(store!, signal);
        recovered = true;
        await runCatalogImport({
          supplierRef: AROMA_SUPPLIER_REF,
          signal,
          deadlineMs: importDeadlineMs,
          store: store!,
          telemetry,
          context: {correlationId: randomUUID()},
          exportCatalog: (request, exportContext) => client.export(request, exportContext),
        });
      } finally { schedulerRunning = false; }
    };
    scheduler = createHourlyScheduler({
      intervalMs: runtime.scheduler.intervalMs,
      onSkippedTick: () => {skippedTicks++;},
      onRunError: (error) => {schedulerFailure=error; telemetry.scheduledFailure();},
    });
    schedulerController = new AbortController();
    processSignal.addEventListener("abort", () => schedulerController?.abort(processSignal.reason), {once: true});
    runScheduledImport = run;
  },
  resources: [{
    name: "catalog-hourly-import",
    start: async () => {
      if (scheduler === undefined || store === undefined || http === undefined) throw new Error("catalog supplier sync is not configured");
      if (runScheduledImport === undefined || schedulerController === undefined || runtimeSignal === undefined) throw new Error("catalog scheduler callback is unavailable");
      supervisorAlive = true;
      schedulerPromise = scheduler.start(runScheduledImport, AbortSignal.any([schedulerController.signal, runtimeSignal])).then(
        () => {
          supervisorAlive = false;
          if (schedulerController?.signal.aborted === false) telemetry.supervisorFailure();
        },
        error => { supervisorAlive = false; schedulerFailure = error; telemetry.supervisorFailure(); },
      );
    },
    stop: async () => {
      supervisorAlive = false;
      schedulerController?.abort();
      try { await schedulerPromise; } finally { await http?.close(); }
    },
    destroy: () => { supervisorAlive = false; schedulerController?.abort(); },
  }],
  metrics: () => [
    ...telemetry.render(),
    "# HELP coffee_catalog_import_scheduler_running Catalog scheduler single-flight state.",
    "# TYPE coffee_catalog_import_scheduler_running gauge",
    `coffee_catalog_import_scheduler_running ${schedulerRunning ? 1 : 0}`,
    "# TYPE coffee_catalog_import_scheduler_skipped_total counter",
    `coffee_catalog_import_scheduler_skipped_total ${skippedTicks}`,
    "# TYPE coffee_catalog_import_scheduler_failure gauge",
    `coffee_catalog_import_scheduler_failure ${schedulerFailure === undefined ? 0 : 1}`,
  ],
};

await startConfiguredRuntime("catalog-supplier-sync", composition);
