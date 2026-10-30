import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import pg from "pg";
import { metrics, trace } from "@opentelemetry/api";
import { createRuntime } from "../../packages/platform-runtime/src/index.ts";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { registerOrdersRoutes } from "../../apps/orders-service/dist/http/index.js";
import { OrderStore } from "../../apps/orders-service/dist/infrastructure/database/order-store.js";
import { withCatalogPostgres } from "../../scripts/catalog-live-harness.mjs";

const root = new URL("../../", import.meta.url);
const migrations = [
  "0001_create_orders.sql",
  "0002_create_order_items.sql",
  "0003_create_order_history.sql",
  "0004_create_order_contributions.sql",
  "0005_create_orders_idempotency.sql",
  "0006_create_orders_outbox.sql",
  "0007_order_grind_selection.sql",
  "0008_create_orders_inbox.sql",
  "0009_create_catalog_mapping_projection.sql",
  "0010_create_cart_desired.sql",
  "0011_create_cart_observed.sql",
  "0012_create_convergence_attempts.sql",
  "0013_create_convergence_leases.sql",
  "0014_create_mutation_reservations.sql",
  "0015_create_order_aroma_projections.sql",
  "0016_create_aroma_work_schedules.sql",
  "0017_allow_cart_outbox.sql",
  "0018_guard_order_card_projection.sql",
  "0019_read_guarded_aroma_card.sql",
  "0020_guard_cart_fact_batches.sql",
  "0021_optimize_observed_format_checks.sql",
  "0022_terminal_cart_item_rejection.sql",
  "0023_ascii_observed_identity.sql",
];
const pool = {
  max: 4,
  checkoutTimeoutMs: 2_000,
  lockTimeoutMs: 1_000,
  interactiveStatementTimeoutMs: 5_000,
  backgroundStatementTimeoutMs: 10_000,
  terminalTimeoutMs: 3_000,
  transactionTimeoutMs: 20_000,
  idleTimeoutMs: 30_000,
  maxLifetimeMs: 1_800_000,
};
const ref = (prefix) => `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FAV`;
const hash = (character) => character.repeat(64);
const customerRef = ref("cus");
const productRef = ref("prd");
const variantRef = ref("var");
const quoteRef = ref("prq");
const offerRef = ref("off");
const policyVersionRef = ref("pvr");
const correlationId = randomUUID();
const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
const confirmKey = randomUUID();
const orderPath = (orderRef) => `/api/client-v1/orders/${orderRef}`;
const confirmPath = (orderRef) => `${orderPath(orderRef)}/commands/confirm`;
const selectedLine = Object.freeze({
  lineNumber: 2,
  productRef,
  variantRef,
  productDisplayName: "Live lifecycle coffee",
  offerRef,
  mappingRevision: "7",
  quantity: "1.5",
  unit: "kilogram",
  supplierUnitMinor: "900",
  unitMinor: "1200",
  lineTotalMinor: "1800",
  currency: "RUB",
  internalProofHash: hash("b"),
});

function tokenActor(token) {
  if (token === "synthetic-api-public-actor-a")
    return {
      sub: "live-owner-actor-a",
      permissions: [
        "orders:create",
        "orders:edit:any",
        "orders:read:any",
        "orders:confirm:any",
        "orders:reconcile:any",
      ],
    };
  if (token === "synthetic-api-public-actor-b")
    return { sub: "live-owner-actor-b", permissions: ["orders:confirm:any"] };
  if (token === "synthetic-api-public-actor-b-all")
    return {
      sub: "live-owner-actor-b",
      permissions: [
        "orders:create",
        "orders:edit:any",
        "orders:read:any",
        "orders:confirm:any",
        "orders:reconcile:any",
      ],
    };
  if (token === "synthetic-api-public-no-confirm")
    return { sub: "live-owner-actor-a", permissions: ["orders:read:any"] };
  if (token === "synthetic-api-public-edit-only")
    return { sub: "live-owner-actor-a", permissions: ["orders:edit:any"] };
  return undefined;
}

async function createOwnerApp(database, counters, options = {}) {
  const store =
    options.store ?? new OrderStore(database, { maxSnapshotAgeMs: 15000 });
  let replayLookups = 0;
  const countedStore = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "replay")
        return (...args) => {
          replayLookups += 1;
          return value.apply(target, args);
        };
      if (
        ["precheck", "preflightPut", "putItem"].includes(property) &&
        options.phaseMeasurement !== undefined
      )
        return (...args) => {
          const started = performance.now();
          const commandContext = options.phaseMeasurement.getContext(
            property,
            args,
          );
          const phaseContext =
            commandContext === undefined
              ? undefined
              : { ...commandContext, phase: property, phaseStartedMs: started };
          const record = (outcome) => {
            try {
              const ended = performance.now();
              options.phaseMeasurement.record(
                property,
                ended - started,
                phaseContext,
                outcome,
                started,
                ended,
              );
            } catch {
              /* diagnostics cannot alter store behavior */
            }
          };
          let result;
          try {
            result = options.phaseMeasurement.run(phaseContext, () =>
              value.apply(target, args),
            );
          } catch (error) {
            record("rejected");
            throw error;
          }
          if (
            result !== null &&
            typeof result === "object" &&
            typeof result.then === "function"
          ) {
            void result.then(
              () => record("fulfilled"),
              () => record("rejected"),
            );
            return result;
          }
          record("fulfilled");
          return result;
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const app = await createRuntime({
    name: "orders-owner-live-proof",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 5_000,
    deadlineMs: options.deadlineMs ?? 10_000,
    deadlineProfiles: { defaultMs: options.deadlineMs ?? 10_000 },
    ...(options.concurrency === undefined
      ? {}
      : { concurrency: options.concurrency }),
  });
  registerOrdersRoutes(app, {
    // Synthetic trusted api-public fixture for this isolated test only; it is not an IdP.
    verifyTransport: (_request, caller) => caller === "api-public",
    verifyPublicDelegation: async (token, operation, requestCorrelationId) => {
      const actor = tokenActor(token);
      if (!actor) throw new Error("SYNTHETIC_ACTOR_NOT_FOUND");
      return {
        iss: "api-public",
        aud: "orders-service",
        originalIssuer: "edge-gateway",
        sub: actor.sub,
        permissions: actor.permissions,
        operationId: operation,
        correlationId: requestCorrelationId,
        traceparent,
      };
    },
    signInternalDelegation: (request) => {
      options.onSign?.();
      return `synthetic-internal:${request.operationId}`;
    },
    owner: {
      store: countedStore,
      customer: options.customer ?? {
        async getOrderInput(request) {
          counters.customer += 1;
          assert.equal(request.customerRef, customerRef);
          return {
            customerRef,
            customerVersion: "3",
            displayName: options.customerDisplayName ?? "Live owner customer",
            state: "Active",
          };
        },
      },
      pricing: options.pricing ?? {
        async verify(request) {
          counters.pricing += 1;
          assert.deepEqual(
            {
              quoteRef: request.quoteRef,
              hash: request.hash,
              customerRef: request.customerRef,
              quoteLineNumber: request.quoteLineNumber,
              productRef: request.productRef,
              variantRef: request.variantRef,
              quantity: request.quantity,
            },
            {
              quoteRef,
              hash: hash("a"),
              customerRef,
              quoteLineNumber: selectedLine.lineNumber,
              productRef,
              variantRef,
              quantity: selectedLine.quantity,
            },
            "fake Pricing must verify only the exactly selected persisted quote line",
          );
          return {
            valid: true,
            quoteRef,
            policyVersionRef,
            catalogSnapshotRevision: "11",
            customerRef,
            expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            currency: "RUB",
            line: selectedLine,
          };
        },
      },
    },
  });
  await app.runtimeController.start();
  return { app, getReplayLookups: () => replayLookups };
}

function requestHeaders(token, key = randomUUID()) {
  return {
    "x-correlation-id": correlationId,
    traceparent,
    "x-actor-context": token,
    "idempotency-key": key,
  };
}

// Load the immutable pre-#11 owner writers into a scratch module graph. This
// proves migration of real old writes, rather than data from the upgraded writer.
async function withLegacyOwners(run) {
  const revision = "e278aeb10e57d37485542f8668f078456074b038";
  const paths = [
    "apps/orders-service/src/infrastructure/database/order-store.ts",
    "apps/orders-service/src/infrastructure/database/row-schemas.ts",
    "apps/orders-service/src/domain/order-card.ts",
    "apps/orders-service/src/domain/order-contribution.ts",
    "apps/orders-service/src/domain/order-state.ts",
    "apps/orders-service/src/observability.ts",
    "apps/pricing-service/src/infrastructure/database/pricing-store.ts",
    "apps/pricing-service/src/domain/pricing-formula.ts",
    "apps/pricing-service/src/domain/quote-proof.ts",
    "apps/pricing-service/src/observability.ts",
    "apps/pricing-service/src/application/create-pricing-quote.ts",
  ];
  const scratch = await mkdtemp(join(tmpdir(), "grind-upgrade-"));
  const modules = new Map(
    paths.map((file, index) => [
      resolve(root.pathname, file),
      join(scratch, `${index}.mjs`),
    ]),
  );
  try {
    for (const file of paths) {
      const old = spawnSync("git", ["show", `${revision}:${file}`], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(old.status, 0, old.stderr);
      const absolute = resolve(root.pathname, file);
      const require = createRequire(
        absolute.replace("/src/", "/dist/").replace(/\.ts$/u, ".js"),
      );
      const compiled = stripTypeScriptTypes(old.stdout);
      await writeFile(
        modules.get(absolute),
        compiled.replace(
          /from\s+(["'])([^"']+)\1/gu,
          (_match, _quote, specifier) => {
            if (specifier.startsWith("node:")) return `from "${specifier}"`;
            const legacy = specifier.startsWith(".")
              ? modules.get(
                  resolve(dirname(absolute), specifier).replace(
                    /\.js$/u,
                    ".ts",
                  ),
                )
              : undefined;
            return `from "${pathToFileURL(legacy ?? require.resolve(specifier)).href}"`;
          },
        ),
      );
    }
    const orders = await import(
      pathToFileURL(modules.get(resolve(root.pathname, paths[0]))).href
    );
    const pricing = await import(
      pathToFileURL(modules.get(resolve(root.pathname, paths[6]))).href
    );
    const application = await import(
      pathToFileURL(modules.get(resolve(root.pathname, paths[10]))).href
    );
    await run(
      orders.OrderStore,
      pricing.PricingStore,
      application.createPricingQuote,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

void test(
  "LIVE: owner peak 100 concurrent buyers with 10 positions persists one effect per command",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    const config = parseYaml(
      await readFile(new URL("config/platform.yaml", root), "utf8"),
      { json: true },
    );
    const settings = config.services["orders-service"];
    const receiptPath = join(
      process.env.TMPDIR ?? tmpdir(),
      `realtime-owner-peak-${process.pid}.json`,
    );
    const receipt = {
      scope:
        "Orders routes/application/OrderStore/PostgreSQL/Outbox; synthetic Customer/Pricing/public delegation, Fastify inject, not client-v1 ingress or VK/Agent/LLM E2E",
      requestedFlows: 100,
      positionsPerFlow: 10,
      started: 0,
      completed: 0,
      failed: 0,
      peakConcurrentFlows: 0,
      commands: [],
      flows: [],
      failures: [],
      pool: settings.dbPool,
      deadlineMs: settings.deadlineMs,
      concurrency: settings.concurrency,
      callerRetries: 0,
      peakDatabaseMetrics: { active: 0, waiting: 0, pending: 0 },
    };
    const phaseSamples = { precheck: [], preflightPut: [], putItem: [] };
    const correlatedPhaseCounts = { precheck: 0, preflightPut: 0, putItem: 0 };
    const phaseOutcomes = { fulfilled: 0, rejected: 0 };
    const commandContexts = new Map();
    const slowPhaseWitnesses = [];
    const phaseContext = new AsyncLocalStorage();
    const databaseSamples = {
      phaseToClient: [],
      poolConnect: [],
      acquired: [],
      leaseHeld: [],
      queries: {},
    };
    const slowDatabaseWitnesses = { waitAcquire: [], leaseHeld: [], sql: [] };
    const boundedWitness = (list, witness) => {
      list.push(witness);
      list.sort((a, b) => b.durationMs - a.durationMs);
      if (list.length > 24) list.length = 24;
    };
    const timingWitness = (
      kind,
      startedAtMs,
      endedAtMs,
      context,
      detail = {},
    ) => {
      const list = slowDatabaseWitnesses[kind];
      boundedWitness(list, {
        kind,
        flow: context.flow,
        command: context.name,
        ordinal: context.ordinal,
        diagnosticId: context.diagnosticId,
        correlationId: context.correlationId,
        phase: context.phase,
        startedAtMs,
        endedAtMs,
        durationMs: Number((endedAtMs - startedAtMs).toFixed(3)),
        ...detail,
      });
    };
    const summarize = (values) => {
      const ordered = [...values].sort((a, b) => a - b);
      const percentile = (p) =>
        ordered.length === 0
          ? null
          : Number(ordered[Math.ceil(ordered.length * p) - 1].toFixed(3));
      return {
        count: ordered.length,
        p50: percentile(0.5),
        p95: percentile(0.95),
        max: ordered.length === 0 ? null : Number(ordered.at(-1).toFixed(3)),
      };
    };
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    const phaseMeasurement = {
      getContext: (phase, args) => {
        const identityKey =
          phase === "putItem" ? args[0]?.identity?.key : args[0]?.key;
        const context =
          typeof identityKey === "string"
            ? commandContexts.get(identityKey)
            : undefined;
        return context;
      },
      run: (context, operation) =>
        context === undefined
          ? operation()
          : phaseContext.run(context, operation),
      record(phase, durationMs, context, outcome, startedAtMs, endedAtMs) {
        phaseSamples[phase].push(durationMs);
        phaseOutcomes[outcome]++;
        if (context?.correlationId !== undefined)
          correlatedPhaseCounts[phase]++;
        boundedWitness(slowPhaseWitnesses, {
          phase,
          startedAtMs,
          endedAtMs,
          durationMs: Number(durationMs.toFixed(3)),
          outcome,
          ...(context === undefined
            ? {}
            : {
                flow: context.flow,
                command: context.name,
                ordinal: context.ordinal,
                diagnosticId: context.diagnosticId,
                correlationId: context.correlationId,
              }),
        });
      },
    };
    try {
      await withCatalogPostgres(
        async ({ adminClient: admin, port, databaseName }) => {
          const password = `orders-peak-${randomUUID().replaceAll("-", "")}`;
          await admin.query(
            `CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`,
          );
          for (const role of [
            "coffee_orders_prepare_rw",
            "coffee_orders_observer_rw",
            "coffee_orders_convergence_rw",
          ])
            await admin.query(`CREATE ROLE ${role} NOLOGIN`);
          for (const migration of migrations)
            await admin.query(
              await readFile(
                new URL(`apps/orders-service/migrations/${migration}`, root),
                "utf8",
              ),
            );
          const database = createDatabase({
            owner: "orders-peak-proof",
            database: databaseName,
            allowedDatabase: databaseName,
            host: "127.0.0.1",
            port,
            user: "coffee_orders_service_rw",
            password,
            ssl: false,
            pool: settings.dbPool,
            shutdownGraceMs: config.platform.shutdownGraceMs,
          });
          await database.resource.start(AbortSignal.timeout(5_000));
          const activeClientRestorers = new Set();
          let originalPoolConnect,
            originalPoolConnectDescriptor,
            poolHookInstalled = false;
          let runtime;
          try {
            originalPoolConnect = pg.Pool.prototype.connect;
            originalPoolConnectDescriptor = Object.getOwnPropertyDescriptor(
              pg.Pool.prototype,
              "connect",
            );
            const classifyQuery = (args) => {
              const sql =
                typeof args[0] === "string"
                  ? args[0]
                  : args[0] !== null && typeof args[0] === "object"
                    ? args[0].text
                    : "";
              const match =
                typeof sql === "string"
                  ? sql
                      .trimStart()
                      .match(
                        /^(BEGIN|COMMIT|ROLLBACK|SET|SELECT|INSERT|UPDATE|DELETE|WITH)\b/iu,
                      )
                  : null;
              return match?.[1]?.toUpperCase() ?? "OTHER";
            };
            pg.Pool.prototype.connect = function (...args) {
              if (this.options?.application_name !== "orders-peak-proof")
                return originalPoolConnect.apply(this, args);
              const context = phaseContext.getStore();
              const requestedAt = performance.now();
              const result = originalPoolConnect.apply(this, args);
              if (
                context === undefined ||
                result === null ||
                typeof result !== "object" ||
                typeof result.then !== "function"
              )
                return result;
              const recordConnect = (outcome, client) => {
                try {
                  const resolvedAt = performance.now();
                  const poolConnectMs = resolvedAt - requestedAt;
                  const phaseToClientMs = resolvedAt - context.phaseStartedMs;
                  databaseSamples.poolConnect.push(poolConnectMs);
                  databaseSamples.phaseToClient.push(phaseToClientMs);
                  timingWitness(
                    "waitAcquire",
                    context.phaseStartedMs,
                    resolvedAt,
                    context,
                    {
                      outcome,
                      poolConnectMs: Number(poolConnectMs.toFixed(3)),
                      poolConnectStartedAtMs: requestedAt,
                      poolConnectEndedAtMs: resolvedAt,
                    },
                  );
                  if (outcome !== "fulfilled" || client === undefined) return;
                  databaseSamples.acquired.push(phaseToClientMs);
                  const acquiredAt = resolvedAt;
                  const queryDescriptor = Object.getOwnPropertyDescriptor(
                    client,
                    "query",
                  );
                  const releaseDescriptor = Object.getOwnPropertyDescriptor(
                    client,
                    "release",
                  );
                  const originalQuery = client.query,
                    originalRelease = client.release;
                  const restore = () => {
                    try {
                      if (queryDescriptor === undefined) delete client.query;
                      else
                        Object.defineProperty(client, "query", queryDescriptor);
                    } catch {}
                    try {
                      if (releaseDescriptor === undefined)
                        delete client.release;
                      else
                        Object.defineProperty(
                          client,
                          "release",
                          releaseDescriptor,
                        );
                    } catch {}
                    activeClientRestorers.delete(restore);
                  };
                  activeClientRestorers.add(restore);
                  try {
                    Object.defineProperty(client, "query", {
                      configurable: true,
                      writable: true,
                      value: function (...queryArgs) {
                        const queryContext = phaseContext.getStore() ?? context;
                        const verb = classifyQuery(queryArgs),
                          queryStart = performance.now();
                        const queryResult = originalQuery.apply(
                          this,
                          queryArgs,
                        );
                        if (
                          queryResult !== null &&
                          typeof queryResult === "object" &&
                          typeof queryResult.then === "function"
                        ) {
                          const recordQuery = (outcome) => {
                            try {
                              const queryEndedAt = performance.now(),
                                durationMs = queryEndedAt - queryStart;
                              const key = `${queryContext.phase ?? "unknown"}:${verb}:${outcome}`;
                              (databaseSamples.queries[key] ??= []).push(
                                durationMs,
                              );
                              timingWitness(
                                "sql",
                                queryStart,
                                queryEndedAt,
                                queryContext,
                                { verb, outcome },
                              );
                            } catch {
                              /* diagnostic observers cannot alter query behavior */
                            }
                          };
                          void queryResult.then(
                            () => recordQuery("fulfilled"),
                            () => recordQuery("rejected"),
                          );
                        }
                        return queryResult;
                      },
                    });
                    Object.defineProperty(client, "release", {
                      configurable: true,
                      writable: true,
                      value: function (...releaseArgs) {
                        const releaseContext =
                          phaseContext.getStore() ?? context;
                        const releasedAt = performance.now(),
                          leaseHeldMs = releasedAt - acquiredAt;
                        try {
                          databaseSamples.leaseHeld.push(leaseHeldMs);
                          timingWitness(
                            "leaseHeld",
                            acquiredAt,
                            releasedAt,
                            releaseContext,
                            {
                              outcome:
                                releaseArgs[0] === true
                                  ? "destroyed"
                                  : "released",
                            },
                          );
                        } catch {
                          /* diagnostic recording cannot delay pool cleanup */
                        }
                        restore();
                        return originalRelease.apply(this, releaseArgs);
                      },
                    });
                  } catch {
                    restore();
                  }
                } catch {
                  /* diagnostic observers cannot alter pool behavior */
                }
              };
              void result.then(
                (client) => recordConnect("fulfilled", client),
                () => recordConnect("rejected"),
              );
              return result;
            };
            poolHookInstalled = true;
            const counters = { customer: 0, pricing: 0 };
            const customers = new Set(
              Array.from(
                { length: 100 },
                (_, n) => `cus_${String(n + 1).padStart(26, "0")}`,
              ),
            );
            const quoteExpiresAt = new Date(
              Date.now() + 60 * 60_000,
            ).toISOString();
            let active = 0,
              release;
            const barrier = new Promise((resolveBarrier) => {
              release = resolveBarrier;
            });
            try {
              runtime = await createOwnerApp(database, counters, {
                phaseMeasurement,
                deadlineMs: settings.deadlineMs,
                concurrency: settings.concurrency,
                customer: {
                  async getOrderInput(request) {
                    counters.customer++;
                    assert.ok(customers.has(request.customerRef));
                    return {
                      customerRef: request.customerRef,
                      customerVersion: "3",
                      displayName: "Synthetic peak customer",
                      state: "Active",
                    };
                  },
                },
                pricing: {
                  async verify(request) {
                    counters.pricing++;
                    assert.ok(customers.has(request.customerRef));
                    assert.equal(
                      request.quoteRef,
                      request.customerRef.replace("cus_", "prq_"),
                    );
                    assert.equal(request.hash, hash("a"));
                    assert.equal(request.quantity, selectedLine.quantity);
                    assert.ok(
                      request.quoteLineNumber >= 1 &&
                        request.quoteLineNumber <= 10,
                    );
                    const suffix = String(request.quoteLineNumber).padStart(
                      26,
                      "0",
                    );
                    assert.equal(request.productRef, `prd_${suffix}`);
                    assert.equal(request.variantRef, `var_${suffix}`);
                    return {
                      valid: true,
                      quoteRef: request.quoteRef,
                      policyVersionRef,
                      catalogSnapshotRevision: "11",
                      customerRef: request.customerRef,
                      expiresAt: quoteExpiresAt,
                      currency: "RUB",
                      line: {
                        ...selectedLine,
                        lineNumber: request.quoteLineNumber,
                        productRef: request.productRef,
                        variantRef: request.variantRef,
                        offerRef: `off_${suffix}`,
                      },
                    };
                  },
                },
              });
              const actor = "synthetic-api-public-actor-a";
              const sampleDatabase = () => {
                const sample = database.metrics();
                for (const key of ["active", "waiting", "pending"])
                  receipt.peakDatabaseMetrics[key] = Math.max(
                    receipt.peakDatabaseMetrics[key],
                    sample[key],
                  );
              };
              const command = async (flow, name, request) => {
                sampleDatabase();
                const ordinal = receipt.commands.length + 1,
                  diagnosticId = randomUUID(),
                  correlationId = request.headers["x-correlation-id"],
                  idempotencyKey = request.headers["idempotency-key"],
                  start = performance.now();
                const row = {
                  flow,
                  name,
                  ordinal,
                  diagnosticId,
                  correlationId,
                  startMs: start,
                  outcome: "pending",
                };
                const context = {
                  flow,
                  name,
                  ordinal,
                  diagnosticId,
                  correlationId,
                  startMs: start,
                };
                commandContexts.set(idempotencyKey, context);
                if (name === "PUT")
                  row.putOrdinal = request.payload?.quoteLineNumber;
                receipt.commands.push(row);
                try {
                  let response;
                  try {
                    response = await runtime.app.inject(request);
                  } catch (error) {
                    row.outcome = "rejected";
                    row.rejection = {
                      name: error?.name ?? "Error",
                      ...(typeof error?.code === "string" &&
                      /^[A-Z0-9_]{1,64}$/u.test(error.code)
                        ? { code: error.code }
                        : {}),
                    };
                    throw error;
                  }
                  row.status = response.statusCode;
                  if (response.statusCode >= 400) {
                    row.outcome = "rejected";
                    row.code = response.json().code;
                    row.rejection = { kind: "http", code: row.code };
                  } else row.outcome = "completed";
                  sampleDatabase();
                  assert.equal(
                    response.statusCode,
                    name.startsWith("Draft") ? 201 : 200,
                    response.body,
                  );
                  return response;
                } finally {
                  try {
                    sampleDatabase();
                  } catch {}
                  row.endMs = performance.now();
                  row.elapsedMs = row.endMs - start;
                  commandContexts.delete(idempotencyKey);
                }
              };
              const flows = [...customers].map((customerRef, flow) =>
                (async () => {
                  await barrier;
                  receipt.started++;
                  active++;
                  receipt.peakConcurrentFlows = Math.max(
                    receipt.peakConcurrentFlows,
                    active,
                  );
                  const quoteRef = customerRef.replace("cus_", "prq_");
                  const start = performance.now();
                  const flowRow = { flow, customerRef, startMs: start };
                  receipt.flows.push(flowRow);
                  try {
                    const create = {
                      method: "POST",
                      url: "/api/client-v1/orders/drafts",
                      headers: requestHeaders(actor),
                      payload: { customerRef },
                    };
                    const draft = await command(flow, "Draft", create),
                      orderRef = draft.json().orderRef;
                    const draftReplay = await command(flow, "Draft replay", {
                      ...create,
                      headers: {
                        ...create.headers,
                        "idempotency-replay-only": "true",
                      },
                      payload: undefined,
                    });
                    assert.equal(draftReplay.statusCode, 201);
                    assert.equal(
                      draftReplay.headers["idempotency-replayed"],
                      "true",
                    );
                    assert.deepEqual(draftReplay.json(), draft.json());
                    for (let line = 1; line <= 10; line++) {
                      const suffix = String(line).padStart(26, "0");
                      const response = await command(flow, "PUT", {
                        method: "PUT",
                        url: `${orderPath(orderRef)}/items/itm_${suffix}`,
                        headers: requestHeaders(actor),
                        payload: {
                          expectedVersion: String(line),
                          productRef: `prd_${suffix}`,
                          variantRef: `var_${suffix}`,
                          quantity: selectedLine.quantity,
                          quoteRef,
                          quoteLineNumber: line,
                          quoteHash: hash("a"),
                        },
                      });
                      assert.equal(response.json().version, String(line + 1));
                    }
                    const confirm = {
                      method: "POST",
                      url: confirmPath(orderRef),
                      headers: requestHeaders(actor),
                      payload: { expectedVersion: "11" },
                    };
                    await command(flow, "Confirm", confirm); // Discard the first body: simulate a lost reply after owner commit.
                    const replay = await command(flow, "Confirm replay", {
                      ...confirm,
                      headers: {
                        ...confirm.headers,
                        "idempotency-replay-only": "true",
                      },
                      payload: undefined,
                    });
                    assert.equal(
                      replay.headers["idempotency-replayed"],
                      "true",
                    );
                    assert.equal(replay.json().version, "12");
                    assert.equal(replay.json().items.length, 10);
                    receipt.completed++;
                    flowRow.status = "completed";
                    flowRow.orderRef = orderRef;
                    return {
                      orderRef,
                      customerRef,
                      elapsedMs: performance.now() - start,
                    };
                  } catch (error) {
                    receipt.failed++;
                    flowRow.status = "failed";
                    receipt.failures.push({ flow, message: error.message });
                    throw error;
                  } finally {
                    active--;
                    flowRow.endMs = performance.now();
                    flowRow.elapsedMs = flowRow.endMs - start;
                  }
                })(),
              );
              receipt.startedAt = new Date().toISOString();
              const start = performance.now();
              eventLoopDelay.enable();
              release();
              let settled;
              try {
                settled = await Promise.allSettled(flows);
              } finally {
                eventLoopDelay.disable();
              }
              receipt.elapsedMs = performance.now() - start;
              receipt.endedAt = new Date().toISOString();
              receipt.databaseMetrics = database.metrics();
              const eventLoopMs = (value) =>
                Number.isFinite(value)
                  ? Number((value / 1e6).toFixed(3))
                  : null;
              receipt.eventLoopDelayMs = {
                mean: eventLoopMs(eventLoopDelay.mean),
                p95: eventLoopMs(eventLoopDelay.percentile(95)),
                max: eventLoopMs(eventLoopDelay.max),
              };
              const completed = settled
                  .filter((result) => result.status === "fulfilled")
                  .map((result) => result.value),
                times = completed
                  .map((result) => result.elapsedMs)
                  .sort((a, b) => a - b);
              receipt.throughputOrdersPerSecond =
                (completed.length * 1000) / receipt.elapsedMs;
              receipt.latencyMs = Object.fromEntries(
                [50, 95, 99].map((p) => [
                  `p${p}`,
                  times[Math.ceil((times.length * p) / 100) - 1] ?? null,
                ]),
              );
              receipt.poolOrLockFailures = receipt.commands
                .filter((row) => row.code !== undefined)
                .map(({ flow, name, status, code }) => ({
                  flow,
                  name,
                  status,
                  code,
                }));
              const counts = (rows) => ({
                total: rows.length,
                successes: rows.filter(
                  (row) => Number.isInteger(row.status) && row.status < 400,
                ).length,
                refusals: rows.filter(
                  (row) => Number.isInteger(row.status) && row.status >= 400,
                ).length,
                statusCodes: rows
                  .filter((row) => Number.isInteger(row.status))
                  .reduce((out, row) => {
                    const key = `${row.status}:${row.code ?? "success"}`;
                    out[key] = (out[key] ?? 0) + 1;
                    return out;
                  }, {}),
              });
              receipt.commandCounts = counts(receipt.commands);
              receipt.draftCounts = counts(
                receipt.commands.filter((row) => row.name === "Draft"),
              );
              receipt.rejectedCommandCount = receipt.commands.filter(
                (row) => row.outcome === "rejected",
              ).length;
              assert.equal(receipt.peakConcurrentFlows, 100);
              assert.equal(receipt.started, 100);
              assert.equal(receipt.failed, 0, JSON.stringify(receipt.failures));
              assert.equal(receipt.completed, 100);
              assert.deepEqual(receipt.commandCounts, {
                total: 1400,
                successes: 1400,
                refusals: 0,
                statusCodes: { "201:success": 200, "200:success": 1200 },
              });
              assert.deepEqual(receipt.databaseMetrics, {
                active: 0,
                idle: 4,
                waiting: 0,
                saturationTotal: 0,
                pending: 0,
              });
              assert.ok(
                receipt.peakDatabaseMetrics.active <= settings.dbPool.max,
              );
              assert.ok(
                receipt.peakDatabaseMetrics.waiting <=
                  (settings.dbPool.maxWaiting ?? 0),
              );
              assert.equal(
                new Set(completed.map((row) => row.orderRef)).size,
                100,
              );
              const durable = (
                await admin.query(`SELECT
          (SELECT count(*)::int FROM orders.orders WHERE status='Confirmed' AND version=12) orders,
          (SELECT count(DISTINCT customer_ref)::int FROM orders.orders) customers,
          (SELECT count(*)::int FROM orders.order_items) positions,
          (SELECT count(*)::int FROM orders.order_history) history,
          (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_version=12 AND contribution_revision=1) contributions,
          (SELECT count(*)::int FROM orders.order_desired_contribution_lines) contribution_lines,
          (SELECT count(*)::int FROM orders.outbox_messages WHERE message_type='OrderConfirmed.v1' AND owner_version='12' AND state='Pending') outbox,
          (SELECT count(*)::int FROM orders.idempotency_records WHERE state='Completed') idempotency`)
              ).rows[0];
              assert.deepEqual(durable, {
                orders: 100,
                customers: 100,
                positions: 1000,
                history: 1200,
                contributions: 100,
                contribution_lines: 1000,
                outbox: 100,
                idempotency: 1200,
              });
              assert.deepEqual(
                counters,
                { customer: 100, pricing: 1000 },
                "replays and Confirm do not repeat upstream proof reads",
              );
              const workloadComplete =
                receipt.completed === 100 &&
                receipt.failed === 0 &&
                receipt.commands.length === 1400 &&
                receipt.commands.every((row) => row.outcome === "completed");
              const expectedPhaseCalls = {
                precheck: 200,
                preflightPut: 1000,
                putItem: 1000,
              };
              const queryCount = Object.values(databaseSamples.queries).reduce(
                (total, values) => total + values.length,
                0,
              );
              const commitCount = Object.entries(databaseSamples.queries)
                .filter(([key]) => key.endsWith(":COMMIT:fulfilled"))
                .reduce((total, [, values]) => total + values.length, 0);
              receipt.workloadResult = {
                complete: workloadComplete,
                completedFlows: receipt.completed,
                failedFlows: receipt.failed,
                commands: receipt.commands.length,
              };
              receipt.diagnosticCoverage = {
                expectedPhaseCalls,
                observedPhaseCalls: Object.fromEntries(
                  Object.entries(phaseSamples).map(([phase, values]) => [
                    phase,
                    values.length,
                  ]),
                ),
                correlatedPhaseCalls: { ...correlatedPhaseCounts },
                phaseOutcomes: { ...phaseOutcomes },
                acquiredConnections: databaseSamples.acquired.length,
                heldLeases: databaseSamples.leaseHeld.length,
                queryRecords: queryCount,
                commitRecords: commitCount,
                commandContextsRemaining: commandContexts.size,
              };
              if (!workloadComplete)
                receipt.diagnosticCoverage.measurementUnavailable =
                  "full diagnostic coverage is asserted only after all 100 flows complete; workload remains failed";
              else {
                assert.deepEqual(
                  receipt.diagnosticCoverage.observedPhaseCalls,
                  expectedPhaseCalls,
                  "all expected real Store phases were observed",
                );
                assert.deepEqual(
                  receipt.diagnosticCoverage.correlatedPhaseCalls,
                  expectedPhaseCalls,
                  "every Store phase carries its command correlation context",
                );
                assert.equal(
                  receipt.diagnosticCoverage.phaseOutcomes.fulfilled,
                  2200,
                );
                assert.equal(
                  receipt.diagnosticCoverage.phaseOutcomes.rejected,
                  0,
                );
                assert.equal(
                  receipt.diagnosticCoverage.acquiredConnections,
                  2200,
                  "each real Store phase acquired one database client",
                );
                assert.equal(
                  receipt.diagnosticCoverage.heldLeases,
                  2200,
                  "each acquired database client was released",
                );
                assert.ok(
                  queryCount > 0,
                  "real PostgreSQL query observations are required",
                );
                assert.ok(
                  commitCount > 0,
                  "real COMMIT query observations are required",
                );
                assert.equal(
                  receipt.diagnosticCoverage.commandContextsRemaining,
                  0,
                );
              }
              receipt.durable = durable;
              receipt.counters = counters;
              receipt.verified = true;
            } finally {
              if (runtime)
                await runtime.app.runtimeController.closeRuntime("SIGTERM");
            }
          } finally {
            try {
              if (poolHookInstalled) {
                if (originalPoolConnectDescriptor === undefined)
                  delete pg.Pool.prototype.connect;
                else
                  Object.defineProperty(
                    pg.Pool.prototype,
                    "connect",
                    originalPoolConnectDescriptor,
                  );
                assert.equal(
                  pg.Pool.prototype.connect,
                  originalPoolConnect,
                  "Pool.connect hook restored to the inherited/original function",
                );
              }
              for (const restore of activeClientRestorers) restore();
            } finally {
              await database.resource.stop(AbortSignal.timeout(5_000));
            }
          }
        },
      );
    } finally {
      eventLoopDelay.disable();
      if (receipt.diagnosticCoverage === undefined) {
        receipt.workloadResult = {
          complete: receipt.completed === 100 && receipt.failed === 0,
          completedFlows: receipt.completed,
          failedFlows: receipt.failed,
          commands: receipt.commands.length,
        };
        receipt.diagnosticCoverage = {
          expectedPhaseCalls: {
            precheck: 200,
            preflightPut: 1000,
            putItem: 1000,
          },
          observedPhaseCalls: Object.fromEntries(
            Object.entries(phaseSamples).map(([phase, values]) => [
              phase,
              values.length,
            ]),
          ),
          correlatedPhaseCalls: { ...correlatedPhaseCounts },
          phaseOutcomes: { ...phaseOutcomes },
          acquiredConnections: databaseSamples.acquired.length,
          heldLeases: databaseSamples.leaseHeld.length,
          queryRecords: Object.values(databaseSamples.queries).reduce(
            (total, values) => total + values.length,
            0,
          ),
          commitRecords: Object.entries(databaseSamples.queries)
            .filter(([key]) => key.endsWith(":COMMIT:fulfilled"))
            .reduce((total, [, values]) => total + values.length, 0),
          commandContextsRemaining: commandContexts.size,
          measurementUnavailable:
            "workload or setup did not reach the diagnostic coverage assertion; failure is preserved",
        };
      }
      const percentile = (values, p) =>
        values.length === 0
          ? null
          : Number(
              [...values]
                .sort((a, b) => a - b)
                [Math.ceil(values.length * p) - 1].toFixed(3),
            );
      receipt.storePhaseLatency = Object.fromEntries(
        Object.entries(phaseSamples).map(([phase, values]) => [
          phase,
          {
            count: values.length,
            p50: percentile(values, 0.5),
            p95: percentile(values, 0.95),
            max:
              values.length === 0
                ? null
                : Number(Math.max(...values).toFixed(3)),
          },
        ]),
      );
      receipt.slowPhaseWitnesses = slowPhaseWitnesses;
      receipt.poolTimingDefinitions = {
        phaseStartToClient:
          "phase start through owner prelude/FIFO admission and pg pool queue/physical client acquisition until connect resolves; not pure FIFO",
        poolConnect:
          "original pg.Pool.connect invocation through Promise resolution; may include pool queue and physical connection setup",
        leaseHeld:
          "client connect resolution through client.release invocation",
      };
      receipt.poolTimingLatencyMs = {
        phaseStartToClient: summarize(databaseSamples.phaseToClient),
        poolConnect: summarize(databaseSamples.poolConnect),
        acquired: summarize(databaseSamples.acquired),
        leaseHeld: summarize(databaseSamples.leaseHeld),
        queries: Object.fromEntries(
          Object.entries(databaseSamples.queries).map(([kind, values]) => [
            kind,
            summarize(values),
          ]),
        ),
      };
      receipt.slowDatabaseWitnesses = slowDatabaseWitnesses;
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
      console.log(
        JSON.stringify({
          ownerPeakReceipt: receiptPath,
          verified: receipt.verified === true,
          launchProof: false,
        }),
      );
    }
  },
);

void test(
  "LIVE: nullable upgrades preserve real legacy hashes, snapshots and exact/bodyless replay without repeating Confirm",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    const { PricingStore } =
      await import("../../apps/pricing-service/dist/infrastructure/database/pricing-store.js");
    const { hashPublicQuote, hashInternalQuote } =
      await import("../../apps/pricing-service/dist/domain/quote-proof.js");
    const { computeOrderContribution } =
      await import("../../apps/orders-service/dist/domain/order-contribution.js");
    const { createPricingQuote } =
      await import("../../apps/pricing-service/dist/application/create-pricing-quote.js");
    await withLegacyOwners(
      async (LegacyOrderStore, LegacyPricingStore, legacyCreatePricingQuote) =>
        withCatalogPostgres(
          async ({ adminClient: admin, port, databaseName }) => {
            await admin.query(
              "CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD 'orders-upgrade'; CREATE ROLE coffee_pricing_rw LOGIN PASSWORD 'pricing-upgrade'",
            );
            for (const role of [
              "coffee_orders_prepare_rw",
              "coffee_orders_observer_rw",
              "coffee_orders_convergence_rw",
            ])
              await admin.query(`CREATE ROLE ${role} NOLOGIN`);
            for (const id of migrations.filter(
              (id) => id < "0007_order_grind_selection.sql",
            ))
              await admin.query(
                await readFile(
                  new URL(`apps/orders-service/migrations/${id}`, root),
                  "utf8",
                ),
              );
            for (const id of [
              "0001_create_pricing_policy_versions",
              "0002_create_pricing_quotes",
              "0003_create_pricing_idempotency",
              "0004_create_pricing_audit",
            ])
              await admin.query(
                await readFile(
                  new URL(`apps/pricing-service/migrations/${id}.sql`, root),
                  "utf8",
                ),
              );
            const db = (owner, user, password) =>
              createDatabase({
                owner,
                database: databaseName,
                allowedDatabase: databaseName,
                host: "127.0.0.1",
                port,
                user,
                password,
                ssl: false,
                pool,
                shutdownGraceMs: 40_000,
              });
            const database = db(
                "orders-upgrade",
                "coffee_orders_service_rw",
                "orders-upgrade",
              ),
              pricingDatabase = db(
                "pricing-upgrade",
                "coffee_pricing_rw",
                "pricing-upgrade",
              );
            let runtime;
            try {
              const oldPricing = new LegacyPricingStore(pricingDatabase),
                policy = await oldPricing.readActivePolicy();
              const identity = {
                actorRef: "pricing-upgrade",
                scope: hash("c"),
                key: randomUUID(),
              };
              const request = {
                customerRef,
                lines: [{ productRef, variantRef, quantity: "1.500" }],
              };
              const command = {
                identity,
                request,
                correlationId,
                signDelegation: () => "synthetic-delegation",
              };
              const quote = await legacyCreatePricingQuote(
                oldPricing,
                {
                  async getPricingInput() {
                    return {
                      productRef,
                      variantRef,
                      displayName: "Legacy coffee",
                      unit: "kilogram",
                      offerRef,
                      mappingRevision: "7",
                      supplierUnitMinor: "900",
                      snapshotRevision: "11",
                      currency: "RUB",
                      availability: "Available",
                    };
                  },
                },
                command,
              );
              const counters = { customer: 0, pricing: 0 };
              const historicalStore = new LegacyOrderStore(database);
              // The fixture pairs the historical writer with the current application. Bridge only the new PUT preflight by composing its old read operations; historical storage writes remain untouched.
              const historicalApplicationStore = new Proxy(historicalStore, {
                get(target, property, receiver) {
                  if (property === "preflightPut")
                    return async (
                      identity,
                      hash,
                      orderRef,
                      permissions,
                      requestCorrelationId,
                      signal,
                    ) => {
                      let checked;
                      try {
                        checked = await target.precheck(
                          identity,
                          hash,
                          requestCorrelationId,
                          signal,
                        );
                      } catch {
                        return { kind: "lookup_unavailable" };
                      }
                      if (checked.kind !== "proceed") return checked;
                      const card = await target.getCard(orderRef, {
                        permissions,
                        correlationId: requestCorrelationId,
                        signal,
                      });
                      return {
                        kind: "proceed",
                        customerRef: card.customer.customerRef,
                      };
                    };
                  const value = Reflect.get(target, property, receiver);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                },
              });
              runtime = await createOwnerApp(database, counters, {
                store: historicalApplicationStore,
              });
              const actor = "synthetic-api-public-actor-a";
              const draft = await runtime.app.inject({
                method: "POST",
                url: "/api/client-v1/orders/drafts",
                headers: requestHeaders(actor),
                payload: { customerRef },
              });
              assert.equal(draft.statusCode, 201, draft.body);
              const orderRef = draft.json().orderRef,
                putKey = randomUUID(),
                confirmKey = randomUUID();
              const putUrl = `${orderPath(orderRef)}/items/${ref("itm")}`;
              const payload = {
                expectedVersion: "1",
                productRef,
                variantRef,
                quantity: selectedLine.quantity,
                quoteRef,
                quoteLineNumber: selectedLine.lineNumber,
                quoteHash: hash("a"),
              };
              const put = await runtime.app.inject({
                method: "PUT",
                url: putUrl,
                headers: requestHeaders(actor, putKey),
                payload,
              });
              assert.equal(put.statusCode, 200, put.body);
              const confirmed = await runtime.app.inject({
                method: "POST",
                url: confirmPath(orderRef),
                headers: requestHeaders(actor, confirmKey),
                payload: { expectedVersion: "2" },
              });
              assert.equal(confirmed.statusCode, 200, confirmed.body);
              assert.deepEqual(
                counters,
                { customer: 1, pricing: 1 },
                "Confirm performs no network calls",
              );
              const oldPutReplay = await runtime.app.inject({
                method: "PUT",
                url: putUrl,
                headers: {
                  ...requestHeaders(actor, putKey),
                  "idempotency-replay-only": "true",
                },
              });
              const oldConfirmReplay = await runtime.app.inject({
                method: "POST",
                url: confirmPath(orderRef),
                headers: {
                  ...requestHeaders(actor, confirmKey),
                  "idempotency-replay-only": "true",
                },
              });
              assert.equal(oldPutReplay.statusCode, 200, oldPutReplay.body);
              assert.equal(
                oldConfirmReplay.statusCode,
                200,
                oldConfirmReplay.body,
              );
              assert.deepEqual(oldPutReplay.json(), put.json());
              assert.deepEqual(oldConfirmReplay.json(), confirmed.json());
              const snapshot = async (schema, tables) => {
                const result = {};
                for (const table of tables)
                  result[table] = (
                    await admin.query(
                      `SELECT (to_jsonb(t)-'source_grind_key_hash'-'grind_display_name'-'line_id'${table === "outbox_messages" ? "-'order_ref'" : ""})::text AS bytes FROM ${schema}.${table} t ORDER BY 1`,
                    )
                  ).rows;
                return result;
              };
              const orderTables = [
                "orders",
                "order_items",
                "order_history",
                "order_desired_contributions",
                "order_desired_contribution_lines",
                "idempotency_records",
                "outbox_messages",
              ];
              const priceTables = [
                "pricing_quotes",
                "pricing_quote_lines",
                "pricing_idempotency_records",
                "pricing_audit_records",
              ];
              const oldOrders = await snapshot("orders", orderTables),
                oldPrices = await snapshot("pricing", priceTables);
              await runtime.app.runtimeController.closeRuntime("SIGTERM");
              runtime = undefined;
              for (const id of migrations.filter(
                (id) => id >= "0007_order_grind_selection.sql",
              ))
                await admin.query(
                  await readFile(
                    new URL(`apps/orders-service/migrations/${id}`, root),
                    "utf8",
                  ),
                );
              await admin.query(
                await readFile(
                  new URL(
                    "apps/pricing-service/migrations/0005_quote_grind_selection.sql",
                    root,
                  ),
                  "utf8",
                ),
              );
              assert.deepEqual(
                await snapshot("orders", orderTables),
                oldOrders,
                "all old Orders/History/Desired/Outbox/idempotency bytes remain unchanged",
              );
              assert.deepEqual(
                await snapshot("pricing", priceTables),
                oldPrices,
                "all old quote/proof/audit/idempotency bytes remain unchanged",
              );
              for (const table of [
                "orders.order_items",
                "pricing.pricing_quote_lines",
              ])
                assert.deepEqual(
                  (
                    await admin.query(
                      `SELECT source_grind_key_hash,grind_display_name FROM ${table}`,
                    )
                  ).rows,
                  [{ source_grind_key_hash: null, grind_display_name: null }],
                );
              const contribution = (
                await admin.query(
                  "SELECT contribution_hash FROM orders.order_desired_contribution_lines",
                )
              ).rows[0].contribution_hash;
              assert.equal(
                computeOrderContribution([
                  {
                    itemRef: ref("itm"),
                    offerRef,
                    productRef,
                    variantRef,
                    quantityMilli: "1500",
                    quoteRef,
                    quoteLineNumber: 2,
                  },
                ]).hash,
                contribution,
              );
              assert.equal(hashPublicQuote(quote.body), quote.body.hash);
              assert.equal(
                hashInternalQuote(quote.body, policy, [
                  {
                    lineNumber: 1,
                    offerRef,
                    mappingRevision: "7",
                    supplierUnitMinor: "900",
                    catalogSnapshotRevision: "11",
                    markupBasisPoints: "3000",
                    minimumMarginMinor: "0",
                  },
                ]),
                (
                  await admin.query(
                    "SELECT internal_proof_hash FROM pricing.pricing_quotes",
                  )
                ).rows[0].internal_proof_hash,
              );
              const prices = new PricingStore(pricingDatabase);
              assert.deepEqual(
                (await prices.precheck(identity, undefined)).body,
                quote.body,
                "Pricing bodyless replay preserves old shape/hash",
              );
              assert.deepEqual(
                await createPricingQuote(
                  prices,
                  {
                    async getPricingInput() {
                      assert.fail(
                        "no-selection idempotency hash changed: unexpected Catalog read",
                      );
                    },
                  },
                  command,
                ),
                { ...quote, replayed: true },
              );
              runtime = await createOwnerApp(database, counters);
              for (const [url, key, original] of [
                [putUrl, putKey, oldPutReplay],
                [confirmPath(orderRef), confirmKey, oldConfirmReplay],
              ]) {
                const method = url === putUrl ? "PUT" : "POST";
                const replay = await runtime.app.inject({
                  method,
                  url,
                  headers: {
                    ...requestHeaders(actor, key),
                    "idempotency-replay-only": "true",
                  },
                });
                assert.equal(replay.statusCode, 200, replay.body);
                assert.equal(replay.headers["idempotency-replayed"], "true");
                assert.equal(
                  replay.body,
                  original.body,
                  "old HTTP response bytes are not recalculated or extended with null fields",
                );
              }
              const replay = await runtime.app.inject({
                method: "PUT",
                url: putUrl,
                headers: requestHeaders(actor, putKey),
                payload,
              });
              assert.equal(replay.body, oldPutReplay.body);
              assert.equal(replay.headers["idempotency-replayed"], "true");
              assert.deepEqual(counters, { customer: 1, pricing: 1 });
              assert.deepEqual(
                await snapshot("orders", orderTables),
                oldOrders,
                "replay does not repeat Confirm, events or historical writes",
              );
              assert.deepEqual(
                await snapshot("pricing", priceTables),
                oldPrices,
              );
              const verified = await prices.verify({
                request: {
                  quoteRef: quote.body.quoteRef,
                  hash: quote.body.hash,
                  customerRef,
                  quoteLineNumber: 1,
                  productRef,
                  variantRef,
                  quantity: "1.5",
                },
                actorRef: "orders-service",
                correlationId,
              });
              assert.equal("sourceGrindKeyHash" in verified.line, false);
              for (const [role, table] of [
                ["coffee_orders_service_rw", "pricing.pricing_quotes"],
                ["coffee_pricing_rw", "orders.order_items"],
              ]) {
                await admin.query("BEGIN");
                try {
                  await admin.query(`SET LOCAL ROLE ${role}`);
                  await assert.rejects(admin.query(`SELECT * FROM ${table}`), {
                    code: "42501",
                  });
                } finally {
                  await admin.query("ROLLBACK");
                }
              }
            } finally {
              if (runtime)
                await runtime.app.runtimeController.closeRuntime("SIGTERM");
              await database.resource.stop(AbortSignal.timeout(5_000));
              await pricingDatabase.resource.stop(AbortSignal.timeout(5_000));
            }
          },
        ),
    );
  },
);

void test(
  "LIVE: selected Catalog facts flow through Pricing verify transport and Orders HTTP/Card/contribution with tamper and isolation rejection",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "disposable PostgreSQL required"
        : false,
  },
  async () => {
    const { PricingStore } =
      await import("../../apps/pricing-service/dist/infrastructure/database/pricing-store.js");
    const { createPricingQuote } =
      await import("../../apps/pricing-service/dist/application/create-pricing-quote.js");
    const { createPricingQuoteClient } =
      await import("../../apps/orders-service/dist/infrastructure/pricing-client.js");
    await withCatalogPostgres(
      async ({ adminClient: admin, port, databaseName }) => {
        await admin.query(
          "CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD 'orders-selected'; CREATE ROLE coffee_pricing_rw LOGIN PASSWORD 'pricing-selected'",
        );
        for (const role of [
          "coffee_orders_prepare_rw",
          "coffee_orders_observer_rw",
          "coffee_orders_convergence_rw",
        ])
          await admin.query(`CREATE ROLE ${role} NOLOGIN`);
        for (const id of migrations)
          await admin.query(
            await readFile(
              new URL(`apps/orders-service/migrations/${id}`, root),
              "utf8",
            ),
          );
        for (const id of [
          "0001_create_pricing_policy_versions",
          "0002_create_pricing_quotes",
          "0003_create_pricing_idempotency",
          "0004_create_pricing_audit",
          "0005_quote_grind_selection",
        ])
          await admin.query(
            await readFile(
              new URL(`apps/pricing-service/migrations/${id}.sql`, root),
              "utf8",
            ),
          );
        const db = (owner, user, password) =>
          createDatabase({
            owner,
            database: databaseName,
            allowedDatabase: databaseName,
            host: "127.0.0.1",
            port,
            user,
            password,
            ssl: false,
            pool,
            shutdownGraceMs: 40_000,
          });
        const database = db(
            "orders-selected",
            "coffee_orders_service_rw",
            "orders-selected",
          ),
          pricingDatabase = db(
            "pricing-selected",
            "coffee_pricing_rw",
            "pricing-selected",
          );
        const counters = { customer: 0, pricing: 0, catalog: 0 };
        let runtime;
        try {
          const prices = new PricingStore(pricingDatabase),
            actor = "synthetic-api-public-actor-a";
          const grindOptions = [
            { sourceGrindKeyHash: hash("a"), displayName: "Средний" },
            { sourceGrindKeyHash: hash("b"), displayName: "Крупный" },
          ];
          const catalog = {
            async getPricingInput() {
              counters.catalog++;
              return {
                productRef,
                variantRef,
                displayName: "Coffee",
                offerRef,
                mappingRevision: "7",
                snapshotRevision: "11",
                supplierUnitMinor: "900",
                currency: "RUB",
                unit: "kilogram",
                availability: "Available",
                grindOptions,
              };
            },
          };
          const request = {
            customerRef,
            lines: [
              { productRef, variantRef, quantity: "1.5" },
              ...grindOptions.map((option) => ({
                productRef,
                variantRef,
                quantity: "1.5",
                sourceGrindKeyHash: option.sourceGrindKeyHash,
              })),
            ],
          };
          const identity = {
            actorRef: "selected-pricing",
            scope: hash("c"),
            key: randomUUID(),
          };
          const command = {
            request,
            identity,
            correlationId,
            signDelegation: () => "synthetic-delegation",
          };
          const quote = await createPricingQuote(prices, catalog, command);
          assert.deepEqual(
            quote.body.lines.map((line) => [
              line.sourceGrindKeyHash,
              line.grindDisplayName,
            ]),
            [
              [undefined, undefined],
              [hash("a"), "Средний"],
              [hash("b"), "Крупный"],
            ],
          );
          const noCatalog = counters.catalog;
          assert.deepEqual(await createPricingQuote(prices, catalog, command), {
            ...quote,
            replayed: true,
          });
          await assert.rejects(
            createPricingQuote(prices, catalog, {
              ...command,
              request: {
                ...request,
                lines: [request.lines[0], request.lines[2]],
              },
            }),
            { code: "IDEMPOTENCY_CONFLICT" },
          );
          assert.equal(
            counters.catalog,
            noCatalog,
            "same key/different selected line rejected before external reads",
          );
          await assert.rejects(
            createPricingQuote(prices, catalog, {
              ...command,
              identity: { ...identity, key: randomUUID() },
              request: {
                customerRef,
                lines: [
                  {
                    productRef,
                    variantRef,
                    quantity: "1.5",
                    sourceGrindKeyHash: hash("f"),
                  },
                ],
              },
            }),
            { code: "PRICING_GRIND_NOT_AVAILABLE" },
          );
          const pricing = createPricingQuoteClient({
            async fetch(path, options) {
              counters.pricing++;
              assert.equal(path, "/api/internal-v1/pricing/quotes:verify");
              try {
                return Response.json(
                  await prices.verify({
                    request: JSON.parse(options.body),
                    actorRef: "orders-service",
                    correlationId,
                    signal: options.signal,
                  }),
                );
              } catch (error) {
                if (error.code !== "PRICING_QUOTE_SCOPE_MISMATCH") throw error;
                return new Response(
                  JSON.stringify({
                    type: "about:blank",
                    title: error.code,
                    status: 409,
                    code: error.code,
                    detail: "Scope mismatch",
                    instance: path,
                    correlationId,
                    errors: [],
                  }),
                  {
                    status: 409,
                    headers: { "content-type": "application/problem+json" },
                  },
                );
              }
            },
          });
          runtime = await createOwnerApp(database, counters, { pricing });
          const newDraft = async () => {
            const result = await runtime.app.inject({
              method: "POST",
              url: "/api/client-v1/orders/drafts",
              headers: requestHeaders(actor),
              payload: { customerRef },
            });
            assert.equal(result.statusCode, 201, result.body);
            return result.json().orderRef;
          };
          const orderRef = await newDraft();
          const payload = (index, version) => ({
            expectedVersion: version,
            productRef,
            variantRef,
            quantity: "1.5",
            quoteRef: quote.body.quoteRef,
            quoteLineNumber: index + 1,
            quoteHash: quote.body.hash,
            ...(index === 0
              ? {}
              : {
                  sourceGrindKeyHash:
                    grindOptions[index - 1].sourceGrindKeyHash,
                }),
          });
          const target = `${orderPath(orderRef)}/items/${ref("itm")}`;
          const beforeMalformed = { ...counters };
          const malformed = await runtime.app.inject({
            method: "PUT",
            url: target,
            headers: requestHeaders(actor),
            payload: {
              ...payload(1, "1"),
              grindDisplayName: "Browser assigned",
            },
          });
          assert.equal(malformed.statusCode, 400, malformed.body);
          assert.deepEqual(counters, beforeMalformed);
          for (const wrong of [
            { ...payload(1, "1"), sourceGrindKeyHash: undefined },
            { ...payload(0, "1"), sourceGrindKeyHash: hash("a") },
            { ...payload(1, "1"), sourceGrindKeyHash: hash("b") },
          ]) {
            const response = await runtime.app.inject({
              method: "PUT",
              url: target,
              headers: requestHeaders(actor),
              payload: wrong,
            });
            assert.equal(response.statusCode, 409, response.body);
            assert.equal(response.json().code, "ORDER_QUOTE_SCOPE_MISMATCH");
            assert.equal(
              (
                await admin.query(
                  "SELECT count(*)::int n FROM orders.order_items WHERE order_ref=$1",
                  [orderRef],
                )
              ).rows[0].n,
              0,
            );
          }
          let card;
          for (let index = 0; index < 3; index++) {
            const response = await runtime.app.inject({
              method: "PUT",
              url: `${orderPath(orderRef)}/items/itm_${String(index + 1).padStart(26, "0")}`,
              headers: requestHeaders(actor),
              payload: payload(index, String(index + 1)),
            });
            assert.equal(response.statusCode, 200, response.body);
            card = response.json();
          }
          assert.deepEqual(
            card.items.map((line) => [
              line.sourceGrindKeyHash,
              line.grindDisplayName,
            ]),
            [
              [undefined, undefined],
              [hash("a"), "Средний"],
              [hash("b"), "Крупный"],
            ],
          );
          const beforeConfirm = { ...counters };
          const confirmed = await runtime.app.inject({
            method: "POST",
            url: confirmPath(orderRef),
            headers: requestHeaders(actor),
            payload: { expectedVersion: "4" },
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          assert.deepEqual(
            counters,
            beforeConfirm,
            "Confirm has no external calls",
          );
          await runtime.app.runtimeController.closeRuntime("SIGTERM");
          runtime = undefined;
          runtime = await createOwnerApp(database, counters, { pricing });
          const restarted = await runtime.app.inject({
            method: "GET",
            url: orderPath(orderRef),
            headers: requestHeaders(actor),
          });
          assert.equal(restarted.statusCode, 200, restarted.body);
          assert.deepEqual(restarted.json().items, confirmed.json().items);
          const otherOrder = await newDraft();
          const put = await runtime.app.inject({
            method: "PUT",
            url: `${orderPath(otherOrder)}/items/${ref("itm")}`,
            headers: requestHeaders(actor),
            payload: payload(1, "1"),
          });
          assert.equal(put.statusCode, 200, put.body);
          const otherConfirm = await runtime.app.inject({
            method: "POST",
            url: confirmPath(otherOrder),
            headers: requestHeaders(actor),
            payload: { expectedVersion: "2" },
          });
          assert.equal(otherConfirm.statusCode, 200, otherConfirm.body);
          const physical = (
            await admin.query(
              "SELECT offer_ref,source_grind_key_hash,sum(quantity_milli)::text quantity_milli FROM orders.order_desired_contribution_lines GROUP BY offer_ref,source_grind_key_hash ORDER BY source_grind_key_hash NULLS FIRST",
            )
          ).rows;
          assert.deepEqual(physical, [
            {
              offer_ref: offerRef,
              source_grind_key_hash: null,
              quantity_milli: "1500",
            },
            {
              offer_ref: offerRef,
              source_grind_key_hash: hash("a"),
              quantity_milli: "3000",
            },
            {
              offer_ref: offerRef,
              source_grind_key_hash: hash("b"),
              quantity_milli: "1500",
            },
          ]);
          await assert.rejects(
            admin.query(
              "UPDATE pricing.pricing_quote_lines SET source_grind_key_hash=NULL,grind_display_name=NULL WHERE quote_ref=$1 AND line_number=2",
              [quote.body.quoteRef],
            ),
            { code: "23505" },
          );
          await assert.rejects(
            admin.query(
              "UPDATE pricing.pricing_quote_lines SET grind_display_name=NULL WHERE quote_ref=$1 AND line_number=2",
              [quote.body.quoteRef],
            ),
            { code: "23514" },
          );
          await assert.rejects(
            admin.query(
              `INSERT INTO orders.order_desired_contribution_lines(order_ref,contribution_revision,offer_ref,quantity_milli,contribution_hash,item_refs)
        SELECT order_ref,contribution_revision,offer_ref,quantity_milli,contribution_hash,item_refs FROM orders.order_desired_contribution_lines WHERE order_ref=$1 AND source_grind_key_hash IS NULL`,
              [orderRef],
            ),
            { code: "23505" },
          );
          const verify = {
            request: {
              quoteRef: quote.body.quoteRef,
              hash: quote.body.hash,
              customerRef,
              quoteLineNumber: 2,
              productRef,
              variantRef,
              quantity: "1.5",
              sourceGrindKeyHash: hash("a"),
            },
            actorRef: "orders-service",
            correlationId,
          };
          for (const [column, changed, original] of [
            ["source_grind_key_hash", hash("f"), hash("a")],
            ["grind_display_name", "Tampered", "Средний"],
          ]) {
            await admin.query(
              `UPDATE pricing.pricing_quote_lines SET ${column}=$2 WHERE quote_ref=$1 AND line_number=2`,
              [quote.body.quoteRef, changed],
            );
            await assert.rejects(prices.verify(verify), {
              code: "PRICING_QUOTE_HASH_MISMATCH",
            });
            await admin.query(
              `UPDATE pricing.pricing_quote_lines SET ${column}=$2 WHERE quote_ref=$1 AND line_number=2`,
              [quote.body.quoteRef, original],
            );
          }
          assert.equal(
            (await prices.verify(verify)).line.grindDisplayName,
            "Средний",
          );
        } finally {
          if (runtime)
            await runtime.app.runtimeController.closeRuntime("SIGTERM");
          await database.resource.stop(AbortSignal.timeout(5_000));
          await pricingDatabase.resource.stop(AbortSignal.timeout(5_000));
        }
      },
    );
  },
);

void test(
  "live owner HTTP lifecycle and durable confirm replay after response loss and app restart",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "set COFFEE_DB_LIVE_PROOF=1 to run isolated PostgreSQL owner proof"
        : false,
  },
  async () => {
    await withCatalogPostgres(async ({ adminClient, port, databaseName }) => {
      const password = `orders-live-${randomUUID().replaceAll("-", "")}`;
      await adminClient.query(
        `CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`,
      );
      for (const role of [
        "coffee_orders_prepare_rw",
        "coffee_orders_observer_rw",
        "coffee_orders_convergence_rw",
      ])
        await adminClient.query(`CREATE ROLE ${role} NOLOGIN`);
      for (const migration of migrations) {
        await adminClient.query(
          await readFile(
            new URL(`apps/orders-service/migrations/${migration}`, root),
            "utf8",
          ),
        );
      }
      const database = createDatabase({
        owner: "orders-owner-live-proof",
        database: databaseName,
        allowedDatabase: databaseName,
        host: "127.0.0.1",
        port,
        user: "coffee_orders_service_rw",
        password,
        ssl: false,
        pool,
        shutdownGraceMs: 40_000,
      });
      await database.resource.start(AbortSignal.timeout(5_000));
      const counters = { customer: 0, pricing: 0 };
      let runtime;
      try {
        runtime = await createOwnerApp(database, counters);
        const { app } = runtime;
        const createResponse = await app.inject({
          method: "POST",
          url: "/api/client-v1/orders/drafts",
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: { customerRef },
        });
        assert.equal(createResponse.statusCode, 201);
        const draft = createResponse.json();
        const orderRef = draft.orderRef;
        assert.equal(draft.status, "Draft");
        assert.equal(draft.version, "1");
        assert.deepEqual(
          draft.allowedActions,
          ["edit-items"],
          "saved Draft card reflects verified edit permission",
        );

        const emptyConfirm = await app.inject({
          method: "POST",
          url: confirmPath(orderRef),
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: { expectedVersion: "1" },
        });
        assert.equal(emptyConfirm.statusCode, 422);
        assert.equal(emptyConfirm.json().code, "ORDER_EMPTY");
        assert.equal(emptyConfirm.headers["idempotency-replayed"], undefined);
        const unchangedDraft = await adminClient.query(
          "SELECT status, version::text AS version FROM orders.orders WHERE order_ref = $1",
          [orderRef],
        );
        assert.deepEqual(unchangedDraft.rows[0], {
          status: "Draft",
          version: "1",
        });
        assert.deepEqual(
          counters,
          { customer: 1, pricing: 0 },
          "empty Confirm must not call upstream owners",
        );

        const itemRef = ref("itm");
        const putResponse = await app.inject({
          method: "PUT",
          url: `${orderPath(orderRef)}/items/${itemRef}`,
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: {
            expectedVersion: "1",
            productRef,
            variantRef,
            quantity: selectedLine.quantity,
            quoteRef,
            quoteLineNumber: selectedLine.lineNumber,
            quoteHash: hash("a"),
          },
        });
        assert.equal(putResponse.statusCode, 200);
        assert.equal(putResponse.json().status, "Draft");
        assert.equal(putResponse.json().version, "2");
        assert.deepEqual(
          putResponse.json().allowedActions,
          ["edit-items", "confirm"],
          "saved item card reflects verified permissions",
        );
        assert.equal(counters.customer, 1);
        assert.equal(counters.pricing, 1);

        // Corrupt only this disposable database to prove the owner validates persisted rows,
        // rather than assuming every selected item remains consistent with its money facts.
        const itemTotalCheck =
          await adminClient.query(`SELECT conname FROM pg_constraint
        WHERE conrelid = 'orders.order_items'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%ceil%'`);
        assert.equal(itemTotalCheck.rowCount, 1);
        const constraintName = itemTotalCheck.rows[0].conname;
        assert.match(constraintName, /^[a-z][a-z0-9_]*$/u);
        await adminClient.query(
          `ALTER TABLE orders.order_items DROP CONSTRAINT ${constraintName}`,
        );
        await adminClient.query(
          "UPDATE orders.order_items SET line_total_minor = line_total_minor + 1 WHERE order_ref = $1",
          [orderRef],
        );
        const invalidCard = await app.inject({
          method: "GET",
          url: orderPath(orderRef),
          headers: requestHeaders("synthetic-api-public-actor-a"),
        });
        assert.equal(
          invalidCard.statusCode,
          500,
          "inconsistent persisted item money must not become a successful Card",
        );
        assert.equal(invalidCard.json().code, "INTERNAL_ERROR");
        await adminClient.query(
          "UPDATE orders.order_items SET line_total_minor = 1800 WHERE order_ref = $1",
          [orderRef],
        );

        const confirmRequest = {
          method: "POST",
          url: confirmPath(orderRef),
          headers: requestHeaders("synthetic-api-public-actor-a", confirmKey),
          payload: { expectedVersion: "2" },
        };
        const firstConfirm = await app.inject(confirmRequest);
        assert.equal(firstConfirm.statusCode, 200);
        assert.deepEqual(
          counters,
          { customer: 1, pricing: 1 },
          "Confirm must use only frozen persisted snapshots",
        );

        // Read durable owner state before discarding the first HTTP response and restarting the route process.
        const durable = await adminClient.query(
          `SELECT
        (SELECT count(*)::int FROM orders.order_history WHERE order_ref = $1 AND event_type = 'OrderConfirmed') AS confirmed_history,
        (SELECT count(*)::int FROM orders.order_desired_contributions WHERE order_ref = $1) AS desired,
        (SELECT count(*)::int FROM orders.order_desired_contribution_lines WHERE order_ref = $1) AS desired_lines,
        (SELECT count(*)::int FROM orders.outbox_messages WHERE aggregate_ref = $1 AND message_type = 'OrderConfirmed.v1') AS outbox`,
          [orderRef],
        );
        assert.deepEqual(durable.rows[0], {
          confirmed_history: 1,
          desired: 1,
          desired_lines: 1,
          outbox: 1,
        });

        // Intentionally do not consume the committed response body, modeling a lost reply before restarting.
        void firstConfirm;
        await app.runtimeController.closeRuntime("SIGTERM");
        runtime = undefined;
        runtime = await createOwnerApp(database, counters);
        const restarted = runtime;
        const replayHeaders = {
          ...requestHeaders("synthetic-api-public-actor-a", confirmKey),
          "idempotency-replay-only": "true",
        };

        const lookupsBeforeDenied = restarted.getReplayLookups();
        const deniedReplay = await restarted.app.inject({
          method: "POST",
          url: confirmPath(orderRef),
          headers: {
            ...replayHeaders,
            "x-actor-context": "synthetic-api-public-no-confirm",
          },
        });
        assert.equal(deniedReplay.statusCode, 403);
        assert.equal(
          restarted.getReplayLookups(),
          lookupsBeforeDenied,
          "authorization must precede durable replay lookup",
        );

        const otherActorReplay = await restarted.app.inject({
          method: "POST",
          url: confirmPath(orderRef),
          headers: {
            ...replayHeaders,
            "x-actor-context": "synthetic-api-public-actor-b",
          },
        });
        assert.equal(
          otherActorReplay.statusCode,
          410,
          "idempotency identity is actor scoped",
        );
        const otherPathReplay = await restarted.app.inject({
          method: "POST",
          url: confirmPath(ref("ord")),
          headers: replayHeaders,
        });
        assert.equal(
          otherPathReplay.statusCode,
          410,
          "idempotency identity is exact HTTP-path scoped",
        );
        const replay = await restarted.app.inject({
          method: "POST",
          url: confirmPath(orderRef),
          headers: replayHeaders,
        });
        assert.equal(replay.statusCode, 200);
        assert.equal(replay.headers["idempotency-replayed"], "true");
        assert.deepEqual(
          counters,
          { customer: 1, pricing: 1 },
          "Confirm replay must not call Customer or Pricing",
        );

        const read = await restarted.app.inject({
          method: "GET",
          url: orderPath(orderRef),
          headers: requestHeaders("synthetic-api-public-actor-a"),
        });
        assert.equal(read.statusCode, 200);
        const persistedCard = read.json();
        assert.equal(persistedCard.status, "Confirmed");
        assert.equal(persistedCard.version, "3");
        assert.equal(persistedCard.items.length, 1);
        assert.deepEqual(
          replay.json(),
          persistedCard,
          "bodyless replay returns the durable confirmed response",
        );

        // Exercise DELETE through the real HTTP handler and durable Store, not by calling deleteItem directly.
        const deleteDraftResponse = await restarted.app.inject({
          method: "POST",
          url: "/api/client-v1/orders/drafts",
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: { customerRef },
        });
        assert.equal(deleteDraftResponse.statusCode, 201);
        const deleteOrderRef = deleteDraftResponse.json().orderRef;
        assert.deepEqual(deleteDraftResponse.json().allowedActions, [
          "edit-items",
        ]);
        const deleteItemRef = ref("itm");
        const deleteUrl = `${orderPath(deleteOrderRef)}/items/${deleteItemRef}`;
        const deletePut = await restarted.app.inject({
          method: "PUT",
          url: deleteUrl,
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: {
            expectedVersion: "1",
            productRef,
            variantRef,
            quantity: selectedLine.quantity,
            quoteRef,
            quoteLineNumber: selectedLine.lineNumber,
            quoteHash: hash("a"),
          },
        });
        assert.equal(deletePut.statusCode, 200);
        assert.deepEqual(deletePut.json().allowedActions, [
          "edit-items",
          "confirm",
        ]);
        const deleteKey = randomUUID();
        const deleteHeaders = requestHeaders(
          "synthetic-api-public-actor-a",
          deleteKey,
        );
        const lookupsBeforeInvalid = restarted.getReplayLookups();
        const missingVersion = await restarted.app.inject({
          method: "DELETE",
          url: deleteUrl,
          headers: deleteHeaders,
        });
        assert.equal(missingVersion.statusCode, 400);
        const replayWithVersion = await restarted.app.inject({
          method: "DELETE",
          url: deleteUrl,
          headers: {
            ...deleteHeaders,
            "idempotency-replay-only": "true",
            "if-match-version": "2",
          },
        });
        assert.equal(replayWithVersion.statusCode, 400);
        assert.equal(
          restarted.getReplayLookups(),
          lookupsBeforeInvalid,
          "invalid DELETE must not look up durable replay",
        );
        const firstDelete = await restarted.app.inject({
          method: "DELETE",
          url: deleteUrl,
          headers: { ...deleteHeaders, "if-match-version": "2" },
        });
        assert.equal(firstDelete.statusCode, 200);
        assert.equal(firstDelete.json().version, "3");
        assert.deepEqual(firstDelete.json().allowedActions, ["edit-items"]);
        const deleteRowsBeforeReplay = await adminClient.query(
          "SELECT count(*)::int AS total FROM orders.order_history WHERE order_ref = $1",
          [deleteOrderRef],
        );
        const deniedDeleteReplay = await restarted.app.inject({
          method: "DELETE",
          url: deleteUrl,
          headers: {
            ...deleteHeaders,
            "idempotency-replay-only": "true",
            "x-actor-context": "synthetic-api-public-no-confirm",
          },
        });
        assert.equal(deniedDeleteReplay.statusCode, 403);
        assert.equal(
          restarted.getReplayLookups(),
          lookupsBeforeInvalid,
          "current auth denial must precede replay lookup",
        );
        const exactDeleteReplay = await restarted.app.inject({
          method: "DELETE",
          url: deleteUrl,
          headers: {
            ...deleteHeaders,
            "idempotency-replay-only": "true",
            "x-actor-context": "synthetic-api-public-edit-only",
          },
        });
        assert.equal(exactDeleteReplay.statusCode, 200);
        assert.equal(exactDeleteReplay.headers["idempotency-replayed"], "true");
        assert.deepEqual(
          exactDeleteReplay.json(),
          firstDelete.json(),
          "replay returns saved body, not a recalculated card",
        );
        const deleteRowsAfterReplay = await adminClient.query(
          "SELECT count(*)::int AS total FROM orders.order_history WHERE order_ref = $1",
          [deleteOrderRef],
        );
        assert.deepEqual(
          deleteRowsAfterReplay.rows,
          deleteRowsBeforeReplay.rows,
          "replay must not duplicate history",
        );
        const currentRead = await restarted.app.inject({
          method: "GET",
          url: orderPath(deleteOrderRef),
          headers: requestHeaders("synthetic-api-public-no-confirm"),
        });
        assert.equal(currentRead.statusCode, 200);
        assert.deepEqual(
          currentRead.json().allowedActions,
          [],
          "GET recomputes current permissions; replay does not",
        );

        const reconciliation = await restarted.app.inject({
          method: "POST",
          url: `${orderPath(orderRef)}/commands/request-aroma-reconciliation`,
          headers: requestHeaders("synthetic-api-public-actor-a"),
          payload: { expectedVersion: "3", reason: "operator-request" },
        });
        assert.equal(reconciliation.statusCode, 409);
        assert.equal(
          reconciliation.json().code,
          "AROMA_RECONCILIATION_NOT_ALLOWED",
        );
        assert.notEqual(
          reconciliation.statusCode,
          202,
          "pre-#11 reconciliation must not claim acceptance",
        );
      } finally {
        if (runtime !== undefined)
          await runtime.app.runtimeController
            .closeRuntime("SIGTERM")
            .catch(() => undefined);
        await database.resource
          .stop(AbortSignal.timeout(5_000))
          .catch(() => database.resource.destroy());
      }
    });
  },
);

void test(
  "live owner replay-only matrix preserves five command results and rejects unresolved lookups without effects or leaks",
  {
    timeout: 180_000,
    skip:
      process.env.COFFEE_DB_LIVE_PROOF !== "1"
        ? "set COFFEE_DB_LIVE_PROOF=1 to run isolated PostgreSQL owner proof"
        : false,
  },
  async () => {
    const piiCanary = "orders-private-customer-canary";
    const logChunks = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = function (chunk, ...args) {
      logChunks.push(
        Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk),
      );
      return originalWrite(chunk, ...args);
    };
    const spans = [];
    const measurements = [];
    assert.equal(
      trace.setGlobalTracerProvider({
        getTracer: () => ({
          startSpan(name) {
            const span = {
              name,
              attributes: {},
              setAttribute(key, value) {
                this.attributes[key] = value;
              },
              setStatus(value) {
                this.status = value;
              },
              end() {
                this.ended = true;
              },
              spanContext: () => ({
                traceId: "1".repeat(32),
                spanId: "2".repeat(16),
                traceFlags: 1,
              }),
            };
            spans.push(span);
            return span;
          },
        }),
      }),
      true,
    );
    assert.equal(
      metrics.setGlobalMeterProvider({
        getMeter: () => ({
          createCounter: (name) => ({
            add: (value, attributes) =>
              measurements.push({ name, value, attributes }),
          }),
          createHistogram: (name) => ({
            record: (value, attributes) =>
              measurements.push({ name, value, attributes }),
          }),
        }),
      }),
      true,
    );
    const tables = [
      "orders",
      "order_items",
      "order_history",
      "order_desired_contributions",
      "order_desired_contribution_lines",
      "idempotency_records",
      "outbox_messages",
    ];
    try {
      await withCatalogPostgres(async ({ adminClient, port, databaseName }) => {
        const password = `orders-live-${randomUUID().replaceAll("-", "")}`;
        await adminClient.query(
          `CREATE ROLE coffee_orders_service_rw LOGIN PASSWORD '${password}'`,
        );
        for (const role of [
          "coffee_orders_prepare_rw",
          "coffee_orders_observer_rw",
          "coffee_orders_convergence_rw",
        ])
          await adminClient.query(`CREATE ROLE ${role} NOLOGIN`);
        for (const migration of migrations) {
          await adminClient.query(
            await readFile(
              new URL(`apps/orders-service/migrations/${migration}`, root),
              "utf8",
            ),
          );
        }
        const database = createDatabase({
          owner: "orders-replay-live-proof",
          database: databaseName,
          allowedDatabase: databaseName,
          host: "127.0.0.1",
          port,
          user: "coffee_orders_service_rw",
          password,
          ssl: false,
          pool,
          shutdownGraceMs: 40_000,
        });
        await database.resource.start(AbortSignal.timeout(5_000));
        const counters = { customer: 0, pricing: 0 };

        let signs = 0;
        let runtime;
        const snapshot = async () => {
          const rows = [];
          for (const table of tables) {
            rows.push([
              table,
              (
                await adminClient.query(
                  `SELECT to_jsonb(t) AS value FROM orders.${table} AS t ORDER BY to_jsonb(t)::text`,
                )
              ).rows,
            ]);
          }
          return Object.fromEntries(rows);
        };
        try {
          runtime = await createOwnerApp(database, counters, {
            customerDisplayName: piiCanary,
            onSign: () => {
              signs += 1;
            },
          });
          const { app } = runtime;
          const actor = "synthetic-api-public-actor-a";
          const createUrl = "/api/client-v1/orders/drafts";
          const createKey = randomUUID();
          const created = await app.inject({
            method: "POST",
            url: createUrl,
            headers: requestHeaders(actor, createKey),
            payload: { customerRef },
          });
          assert.equal(created.statusCode, 201, created.body);
          const orderRef = created.json().orderRef;
          const itemRef = ref("itm");
          const itemUrl = `${orderPath(orderRef)}/items/${itemRef}`;
          const putBody = (expectedVersion) => ({
            expectedVersion,
            productRef,
            variantRef,
            quantity: selectedLine.quantity,
            quoteRef,
            quoteLineNumber: selectedLine.lineNumber,
            quoteHash: hash("a"),
          });
          const put = async (version, key = randomUUID()) =>
            app.inject({
              method: "PUT",
              url: itemUrl,
              headers: requestHeaders(actor, key),
              payload: putBody(version),
            });
          const putKey = randomUUID();
          const firstPut = await put("1", putKey);
          assert.equal(firstPut.statusCode, 200, firstPut.body);
          const deleteKey = randomUUID();
          const removed = await app.inject({
            method: "DELETE",
            url: itemUrl,
            headers: {
              ...requestHeaders(actor, deleteKey),
              "if-match-version": "2",
            },
          });
          assert.equal(removed.statusCode, 200, removed.body);
          assert.equal((await put("3")).statusCode, 200);
          const confirmKey = randomUUID();
          const confirmed = await app.inject({
            method: "POST",
            url: confirmPath(orderRef),
            headers: requestHeaders(actor, confirmKey),
            payload: { expectedVersion: "4" },
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          await adminClient.query(
            "SELECT * FROM orders.write_card_projection($1,$2::jsonb)",
            [
              orderRef,
              JSON.stringify({
                order_ref: orderRef,
                cart_scope_ref: "aroma-primary",
                desired_revision: "0",
                desired_hash: null,
                observed_revision: "0",
                observed_cart_fingerprint: null,
                verified_desired_revision: null,
                verified_desired_hash: null,
                verified_observed_revision: null,
                verified_cart_fingerprint: null,
                attempt_ref: null,
                verified_attempt_ref: null,
                fence_epoch: null,
                state: "OutOfSync",
                blocker_codes: [],
                last_observed_at: null,
                source_message_id: "persisted-replay-fixture",
              }),
            ],
          );
          const reconcileUrl = `${orderPath(orderRef)}/commands/request-aroma-reconciliation`;
          const reconcileKey = randomUUID();
          const reconciled = await app.inject({
            method: "POST",
            url: reconcileUrl,
            headers: requestHeaders(actor, reconcileKey),
            payload: { expectedVersion: "5", reason: "operator request" },
          });
          assert.equal(reconciled.statusCode, 202, reconciled.body);

          // Model lost replies: every operation was committed by the first process,
          // while all bodyless lookups run against a fresh owner process/store.
          await app.runtimeController.closeRuntime("SIGTERM");
          runtime = await createOwnerApp(database, counters, {
            customerDisplayName: piiCanary,
            onSign: () => {
              signs += 1;
            },
          });
          const replayApp = runtime.app;

          // Read-only lookup must return the historical result, not the current Order Card.
          const cases = [
            {
              name: "Draft",
              method: "POST",
              url: createUrl,
              key: createKey,
              original: created,
              otherUrl: confirmPath(orderRef),
            },
            {
              name: "PUT",
              method: "PUT",
              url: itemUrl,
              key: putKey,
              original: firstPut,
              otherUrl: `${orderPath(orderRef)}/items/${ref("itm").slice(0, -1)}W`,
            },
            {
              name: "DELETE",
              method: "DELETE",
              url: itemUrl,
              key: deleteKey,
              original: removed,
              otherUrl: `${orderPath(orderRef)}/items/${ref("itm").slice(0, -1)}W`,
            },
            {
              name: "Confirm",
              method: "POST",
              url: confirmPath(orderRef),
              key: confirmKey,
              original: confirmed,
              otherUrl: confirmPath(ref("ord")),
            },
            {
              name: "Reconcile",
              method: "POST",
              url: reconcileUrl,
              key: reconcileKey,
              original: reconciled,
              otherUrl: `${orderPath(ref("ord"))}/commands/request-aroma-reconciliation`,
            },
          ];
          // Use the command's actual idempotency key: no alternate key can imply its effect.
          for (const entry of cases) {
            assert.notEqual(
              entry.otherUrl,
              entry.url,
              `${entry.name}: alternate path must be distinct`,
            );
            entry.scope = createHash("sha256")
              .update(`${entry.method}\n${entry.url}`)
              .digest("hex");
            const stored = await adminClient.query(
              "SELECT resource_ref, response_status FROM orders.idempotency_records WHERE actor_ref=$1 AND scope=$2 AND idempotency_key=$3",
              ["live-owner-actor-a", entry.scope, entry.key],
            );
            assert.deepEqual(
              stored.rows,
              [
                {
                  resource_ref: orderRef,
                  response_status: entry.original.statusCode,
                },
              ],
              entry.name,
            );
          }
          const lookupKeys = new Set(cases.map((entry) => entry.key));
          const check = async (
            entry,
            expectedStatus,
            expectedCode,
            {
              key = entry.key,
              token = actor,
              url = entry.url,
              method = entry.method,
              replayOnly = true,
              payload,
              extraHeaders = {},
            } = {},
          ) => {
            lookupKeys.add(key);
            const before = await snapshot();
            const beforeCalls = { ...counters, signs };
            const beforeLookups = runtime.getReplayLookups();
            const beforeSignals = {
              spans: spans.length,
              metrics: measurements.length,
              logs: logChunks.length,
            };
            const currentCorrelation = randomUUID();
            const response = await replayApp.inject({
              method,
              url,
              headers: {
                ...requestHeaders(token, key),
                "x-correlation-id": currentCorrelation,
                ...(replayOnly ? { "idempotency-replay-only": "true" } : {}),
                ...extraHeaders,
              },
              ...(payload === undefined ? {} : { payload }),
            });
            assert.equal(
              response.statusCode,
              expectedStatus,
              `${entry.name}: ${expectedCode ?? "Completed"}: ${response.body}`,
            );
            assert.equal(
              response.headers["cache-control"],
              "no-store",
              entry.name,
            );
            assert.equal(
              response.headers["x-correlation-id"],
              currentCorrelation,
              entry.name,
            );
            assert.equal(
              response.headers["idempotency-replayed"],
              expectedCode === undefined ? "true" : undefined,
              entry.name,
            );
            if (expectedCode === undefined)
              assert.deepEqual(
                response.json(),
                entry.original.json(),
                entry.name,
              );
            else {
              assert.equal(response.json().code, expectedCode, entry.name);
              assert.ok(
                !response.body.includes(piiCanary) &&
                  !response.body.includes(key),
                `${entry.name}: error body must not expose canaries`,
              );
            }
            assert.deepEqual(
              await snapshot(),
              before,
              `${entry.name}: lookup must not write owner/History/Outbox/idempotency rows`,
            );
            assert.deepEqual(
              { ...counters, signs },
              beforeCalls,
              `${entry.name}: lookup must not call Customer/Pricing or sign a business request`,
            );
            assert.equal(
              runtime.getReplayLookups() - beforeLookups,
              expectedCode === "ACTOR_CONTEXT_INVALID" ||
                expectedCode === "VALIDATION_FAILED"
                ? 0
                : 1,
            );
            const recentSpans = spans.slice(beforeSignals.spans);
            const recentMetrics = measurements.slice(beforeSignals.metrics);
            const recentLogs = logChunks.slice(beforeSignals.logs);
            assert.ok(
              recentSpans.some(
                (span) => span.name.startsWith("orders.http.") && span.ended,
              ),
              `${entry.name}: missing HTTP span`,
            );
            if (
              replayOnly &&
              expectedCode !== "ACTOR_CONTEXT_INVALID" &&
              expectedCode !== "VALIDATION_FAILED"
            ) {
              assert.ok(
                recentSpans.some(
                  (span) =>
                    span.name === "orders.transaction.replay" && span.ended,
                ),
                `${entry.name}: missing lookup span`,
              );
              assert.ok(
                recentMetrics.some(
                  (row) =>
                    row.name === "orders.operation.total" &&
                    row.attributes["orders.operation"] ===
                      "orders.transaction.replay",
                ),
                `${entry.name}: missing lookup metric`,
              );
            }
            assert.ok(
              recentLogs.some(
                (chunk) =>
                  chunk.includes('"msg":"incoming request"') &&
                  chunk.includes(currentCorrelation),
              ),
              `${entry.name}: missing correlated request log`,
            );
            const emitted = JSON.stringify({
              spans: recentSpans,
              metrics: recentMetrics,
              logs: recentLogs,
            });
            for (const canary of [piiCanary, ...lookupKeys])
              assert.ok(
                !emitted.includes(canary),
                `${entry.name}: telemetry/logs leaked a canary`,
              );
          };
          for (const entry of cases) {
            await check(entry, entry.original.statusCode);
            await check(entry, entry.original.statusCode);
            for (const expired of [false, true]) {
              const key = randomUUID();
              await adminClient.query(
                `INSERT INTO orders.idempotency_records
              (actor_ref,scope,idempotency_key,request_hash,state,lease_owner,lease_until,created_at,expires_at)
              VALUES ('live-owner-actor-a',$1,$2,$3,'Acquired',$4,
                clock_timestamp() + CASE WHEN $5::boolean THEN interval '-1 hour' ELSE interval '1 hour' END,
                clock_timestamp() - interval '2 hours',clock_timestamp() + interval '2 hours')`,
                [entry.scope, key, hash("a"), randomUUID(), expired],
              );
              await check(entry, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS", {
                key,
              });
            }
            await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {
              key: randomUUID(),
            });
            for (const variant of [
              "expired",
              "invalid-body",
              "invalid-expiry",
            ]) {
              const key = randomUUID();
              await adminClient.query(
                `INSERT INTO orders.idempotency_records
              (actor_ref,scope,idempotency_key,request_hash,state,lease_owner,lease_until,created_at,expires_at,
                completed_at,response_status,response_body,resource_ref)
              SELECT actor_ref,scope,$2,request_hash,state,lease_owner,lease_until,created_at,expires_at,
                completed_at,response_status,response_body,resource_ref
              FROM orders.idempotency_records WHERE idempotency_key=$1`,
                [entry.key, key],
              );
              if (variant === "invalid-body")
                await adminClient.query(
                  "UPDATE orders.idempotency_records SET response_body=$2::jsonb WHERE idempotency_key=$1",
                  [key, JSON.stringify({ corrupt: piiCanary, key })],
                );
              else if (variant === "invalid-expiry")
                await adminClient.query(
                  "UPDATE orders.idempotency_records SET lease_until='infinity'::timestamptz,expires_at='infinity'::timestamptz WHERE idempotency_key=$1",
                  [key],
                );
              else
                await adminClient.query(
                  `UPDATE orders.idempotency_records SET created_at=clock_timestamp()-interval '3 hours',
              lease_until=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour'
              WHERE idempotency_key=$1`,
                  [key],
                );
              await check(
                entry,
                variant === "expired" ? 410 : 500,
                variant === "expired"
                  ? "IDEMPOTENCY_RESULT_NOT_RETAINED"
                  : "IDEMPOTENCY_RESULT_INVALID",
                { key },
              );
            }
            await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {
              token: "synthetic-api-public-actor-b-all",
            });
            await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {
              url: entry.otherUrl,
            });
            if (entry.name === "PUT" || entry.name === "DELETE") {
              await check(entry, 410, "IDEMPOTENCY_RESULT_NOT_RETAINED", {
                method: entry.name === "PUT" ? "DELETE" : "PUT",
              });
            }
            // Denial precedes the lookup and leaves the owner completely unchanged.
            await check(entry, 403, "ACTOR_CONTEXT_INVALID", {
              token: "synthetic-api-public-no-confirm",
            });
            await check(entry, 400, "VALIDATION_FAILED", {
              payload: { expectedVersion: "1" },
            });
            await check(entry, 400, "VALIDATION_FAILED", {
              extraHeaders: { "if-match-version": "1" },
            });
            await check(entry, 400, "VALIDATION_FAILED", { replayOnly: false });
          }
          await adminClient.query(
            "REVOKE SELECT ON orders.idempotency_records FROM coffee_orders_service_rw",
          );
          try {
            for (const entry of cases)
              await check(entry, 503, "IDEMPOTENCY_LOOKUP_UNAVAILABLE");
          } finally {
            await adminClient.query(
              "GRANT SELECT ON orders.idempotency_records TO coffee_orders_service_rw",
            );
          }
          assert.ok(
            spans.some(
              (span) => span.name === "orders.transaction.replay" && span.ended,
            ),
          );
          assert.ok(
            measurements.some(
              (row) =>
                row.name === "orders.operation.total" &&
                row.attributes["orders.operation"] ===
                  "orders.transaction.replay",
            ),
          );
          assert.ok(
            logChunks.some((chunk) =>
              chunk.includes('"msg":"incoming request"'),
            ),
            "must capture actual Fastify logs",
          );
          const telemetry = JSON.stringify({
            spans: spans.map(({ name, attributes, status }) => ({
              name,
              attributes,
              status,
            })),
            measurements,
          });
          const logs = logChunks.join("");
          for (const canary of [piiCanary, ...lookupKeys]) {
            assert.ok(
              !telemetry.includes(canary),
              "lookup telemetry must not contain private facts or idempotency key",
            );
            assert.ok(
              !logs.includes(canary),
              "lookup logs must not contain private facts or idempotency key",
            );
          }
          // Key storage in orders.idempotency_records is normative, not a redaction failure.
          for (const table of ["order_history", "outbox_messages"]) {
            const rows = JSON.stringify((await snapshot())[table]);
            assert.ok(
              cases.every((entry) => !rows.includes(entry.key)),
              `${table} must not copy an idempotency key`,
            );
            assert.ok(
              !rows.includes(piiCanary),
              `${table} must not copy customer PII`,
            );
          }
        } finally {
          if (runtime !== undefined)
            await runtime.app.runtimeController.closeRuntime("SIGTERM");
          await database.resource.stop(AbortSignal.timeout(5_000));
        }
      });
    } finally {
      process.stdout.write = originalWrite;
    }
  },
);
