import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mock } from "node:test";
import { createHourlyScheduler as realScheduler } from "../../apps/catalog-supplier-sync/dist/hourly-scheduler.js";
import { CatalogOutcomeUnknown } from "../../apps/catalog-supplier-sync/dist/reconcile-imports.js";

const mode = process.argv[2];
let composition;
let run;
let endSupervisor;
let failSupervisor;
let controller;
let unavailable = false;
let incomplete = false;
let exports = 0;
/** @type {Promise<void> | undefined} */
let schedulerCompletion;
let clock = 0;
let ticks = 0;
const events = [];
const diagnostics = [];
let registered,
  parsedTransport,
  fakeHttp,
  runCalls = 0,
  relayCalls = 0,
  httpCloses = 0,
  fetchCalls = 0,
  releaseSleep;
mock.module("../../packages/platform-runtime/dist/index.js", {
  namedExports: {
    startConfiguredRuntime: async (_name, value) => {
      composition = value;
    },
  },
});
if (mode === "catalog-activation-worker") {
  mock.module("../../packages/platform-security/dist/index.js", {
    namedExports: {
      parseServiceTransportMaterial: (value, environment, runtime) => {
        parsedTransport = { value, environment, runtime };
        return { fixture: true };
      },
    },
  });
  mock.module("../../packages/platform-http/dist/index.js", {
    namedExports: {
      createHttpClient: (options) => {
        events.push({ kind: "http", options });
        return fakeHttp;
      },
    },
  });
} else if (mode !== "catalog-service") {
  mock.module("../../packages/platform-security/dist/index.js", {
    namedExports: { parseServiceTransportMaterial: () => ({}) },
  });
  mock.module("../../packages/platform-http/dist/index.js", {
    namedExports: { createHttpClient: () => ({ close: async () => {} }) },
  });
}
mock.module(
  "../../apps/catalog-supplier-sync/dist/infrastructure/catalog-import-store.js",
  {
    namedExports: {
      createCatalogImportStore: () => ({
        listIncomplete: async () => {
          events.push("recover");
          if (unavailable) throw new Error("DB_CONNECTION_LOST");
          return incomplete ? [{ snapshot_ref: "old" }] : [];
        },
        reject: async () => {
          events.push("reject-old");
          incomplete = false;
        },
      }),
    },
  },
);
mock.module("../../apps/catalog-supplier-sync/dist/run-catalog-import.js", {
  namedExports: {
    runCatalogImport: async () => {
      events.push("export");
      exports++;
      if (exports === 1) {
        incomplete = true;
        throw new CatalogOutcomeUnknown("batch");
      }
      if (exports === 2 && mode.startsWith("readiness"))
        throw new Error("SNAPSHOT_FAILED_PROVIDER_TIMEOUT");
    },
  },
});
mock.module("../../apps/catalog-supplier-sync/dist/hourly-scheduler.js", {
  namedExports: {
    createHourlyScheduler: (options) => ({
      start: (callback, signal) => {
        run = callback;
        if (mode === "scheduler-recovery") {
          schedulerCompletion = realScheduler({
            ...options,
            now: () => clock,
            wait: async (milliseconds) => {
              clock += milliseconds;
              ticks++;
              if (ticks === 1) unavailable = true;
              if (ticks === 2) unavailable = false;
              if (ticks === 3) controller.abort();
            },
          }).start(callback, signal);
          return schedulerCompletion;
        }
        return new Promise((resolve, reject) => {
          endSupervisor = resolve;
          failSupervisor = reject;
        });
      },
    }),
  },
});
if (mode === "catalog-service") {
  mock.module("../../apps/catalog-service/dist/http/index.js", {
    namedExports: {
      createCatalogAdapters: (
        _database,
        security,
        signer,
        snapshotProofMaxAgeMs,
      ) => ({ security, signer, snapshotProofMaxAgeMs }),
      registerCatalogRoutes: (_app, adapters) => {
        registered = adapters;
      },
    },
  });
  const pairs = [
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("ed25519"),
    generateKeyPairSync("ed25519"),
  ];
  const cursorPair = generateKeyPairSync("ed25519");
  const publicPem = (key) =>
    key.publicKey.export({ type: "spki", format: "pem" });
  const privatePem = (key) =>
    key.privateKey.export({ type: "pkcs8", format: "pem" });
  const secrets = {
    security: {
      delegationVerificationKeys: {
        "api-public": {
          active: publicPem(pairs[0]),
          previous: publicPem(pairs[1]),
        },
        "api-internal": {
          active: publicPem(pairs[2]),
          previous: publicPem(pairs[3]),
        },
      },
      catalogCursorSigningPrivateKey: privatePem(cursorPair),
    },
  };
  const context = {
    config: {
      security: {
        catalogCursor: {
          activeKid: "catalog-test",
          maxAgeSeconds: 60,
          clockSkewSeconds: 5,
        },
      },
      services: {
        "catalog-service": { catalogSnapshotProof: { maxAgeMs: 60_000 } },
      },
    },
    secrets,
  };
  await import("../../apps/catalog-service/dist/main.js");
  const configure = composition.configure;
  assert.ok(configure);
  const app = {};
  const processSignal = new AbortController().signal;
  assert.throws(
    () => configure(app, processSignal, undefined, undefined, context),
    /database is required/u,
  );
  assert.throws(
    () =>
      configure(app, processSignal, {}, undefined, {
        ...context,
        secrets: {
          security: {
            ...secrets.security,
            delegationVerificationKeys: {
              "api-public": { active: publicPem(pairs[0]) },
            },
          },
        },
      }),
    /NOT_CONFIGURED/u,
  );
  assert.throws(() =>
    configure(app, processSignal, {}, undefined, {
      ...context,
      secrets: {
        security: {
          ...secrets.security,
          catalogCursorSigningPrivateKey: "not-a-private-key",
        },
      },
    }),
  );
  assert.throws(
    () =>
      configure(app, processSignal, {}, undefined, {
        ...context,
        config: {
          ...context.config,
          security: {
            catalogCursor: {
              activeKid: "",
              maxAgeSeconds: 60,
              clockSkewSeconds: 5,
            },
          },
        },
      }),
    /SECURITY_CATALOG_CURSOR_POLICY_INVALID/u,
  );
  assert.equal(
    registered,
    undefined,
    "invalid scoped keys and cursor policy fail before route registration",
  );
  await configure(app, processSignal, {}, undefined, context);
  assert.equal(registered.snapshotProofMaxAgeMs, 60_000);
  const verify = registered.security;
  assert.equal(
    verify.verifyTransport(
      { runtimeContext: { transportIdentity: { runtime: "api-public" } } },
      "api-public",
    ),
    true,
  );
  assert.equal(
    verify.verifyTransport(
      { runtimeContext: { transportIdentity: { runtime: "api-internal" } } },
      "api-public",
    ),
    false,
  );
  assert.equal(
    verify.verifyTransport({ runtimeContext: null }, "api-internal"),
    false,
  );
  const now = Math.floor(Date.now() / 1_000);
  const token = (claims, key) => {
    const payload = Buffer.from(JSON.stringify(claims));
    return `${payload.toString("base64url")}.${sign(null, payload, key.privateKey).toString("base64url")}`;
  };
  const actor = {
    iss: "api-public",
    aud: "catalog-service",
    originalIssuer: "edge-gateway",
    sub: "usr_test",
    permissions: ["catalog:read"],
    operationId: "searchCatalogProducts",
    correlationId: "correlation-test",
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    iat: now,
    exp: now + 60,
    jti: "actor-test",
    kid: "previous",
  };
  assert.equal(
    verify.verifyPublicDelegation(
      token(actor, pairs[1]),
      "searchCatalogProducts",
      processSignal,
    ).operationId,
    "searchCatalogProducts",
    "previous public key remains accepted during rotation",
  );
  assert.throws(
    () =>
      verify.verifyPublicDelegation(
        token(actor, pairs[1]),
        "otherOperation",
        processSignal,
      ),
    /ACTOR_CONTEXT_INVALID/u,
  );
  assert.throws(() =>
    verify.verifyPublicDelegation(
      token({ ...actor, aud: "other-owner" }, pairs[1]),
      "searchCatalogProducts",
      processSignal,
    ),
  );
  const internal = {
    iss: "api-internal",
    aud: "catalog-service",
    originalCaller: "pricing-service",
    operationId: "getCatalogPricingInput",
    correlationId: "correlation-test",
    traceparent: actor.traceparent,
    iat: now,
    exp: now + 60,
    jti: "service-test",
    kid: "previous",
  };
  assert.equal(
    verify.verifyInternalDelegation(
      token(internal, pairs[3]),
      "getCatalogPricingInput",
      processSignal,
    ).originalCaller,
    "pricing-service",
    "previous internal key remains accepted during rotation",
  );
  assert.throws(
    () =>
      verify.verifyInternalDelegation(
        token(internal, pairs[3]),
        "otherOperation",
        processSignal,
      ),
    /SERVICE_DELEGATION_INVALID/u,
  );
  assert.throws(() =>
    verify.verifyInternalDelegation(
      token({ ...internal, aud: "other-owner" }, pairs[3]),
      "getCatalogPricingInput",
      processSignal,
    ),
  );
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() =>
    verify.verifyPublicDelegation(
      token(actor, pairs[1]),
      "searchCatalogProducts",
      aborted.signal,
    ),
  );
  console.log(`composition ${mode}: PASS`);
} else if (mode === "catalog-activation-worker") {
  const cycleDiagnostics = [];
  const originalConsoleError = console.error;
  console.error = (...values) => {
    if (values[0] === "catalog activation cycle failed")
      cycleDiagnostics.push(values);
    else originalConsoleError(...values);
  };
  const bindingRequest = {
    offerRef: "off_00000000000000000000000001",
    supplierRef: "sup_00000000000000000000000001",
    snapshotRef: "snp_00000000000000000000000001",
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "a".repeat(64),
  };
  const bindingResponse = {
    offerRef: bindingRequest.offerRef,
    supplierRef: bindingRequest.supplierRef,
    sourceIdentityScheme: bindingRequest.sourceIdentityScheme,
    sourceOfferKeyHash: bindingRequest.sourceOfferKeyHash,
    firstSnapshotRef: bindingRequest.snapshotRef,
    state: "Bound",
  };
  const sleepEntered = [Promise.withResolvers(), Promise.withResolvers()];
  let sleepIndex = 0;
  fakeHttp = {
    fetch: async (path, options) => {
      fetchCalls++;
      assert.equal(path, "/api/internal-v1/aroma/offer-bindings");
      assert.equal(options.method, "POST");
      return fetchCalls === 1
        ? new Response("", { status: 503 })
        : new Response(JSON.stringify(bindingResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
    },
    close: async () => {
      httpCloses++;
    },
  };
  mock.module("../../packages/platform-outbox/dist/index.js", {
    namedExports: {
      createSqlOutboxStore: (database, options) => ({ database, options }),
    },
  });
  mock.module(
    "../../apps/catalog-activation-worker/dist/infrastructure/activation-store.js",
    {
      namedExports: {
        createCatalogActivationStore: (_database) => ({
          runOnce: async (bind) => {
            runCalls++;
            return bind(bindingRequest);
          },
        }),
      },
    },
  );
  mock.module("node:timers/promises", {
    namedExports: {
      setTimeout: (_milliseconds, _value, { signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () =>
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          signal?.addEventListener("abort", onAbort, { once: true });
          releaseSleep = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          sleepEntered[sleepIndex++]?.resolve();
        }),
    },
  });
  await import("../../apps/catalog-activation-worker/dist/main.js");
  const configure = composition.configure;
  assert.ok(configure);
  const processController = new AbortController();
  const database = { fixture: "database" };
  const kafka = {
    relay: async (outbox, actualDatabase, signal) => {
      assert.equal(outbox.options.schema, "catalog");
      assert.equal(actualDatabase, database);
      assert.equal(signal.aborted, false);
      relayCalls++;
    },
  };
  const app = { log: { info: () => {} } };
  assert.throws(
    () => configure(app, processController.signal, undefined, kafka, {}),
    { message: "CATALOG_ACTIVATION_DEPENDENCIES_MISSING" },
  );
  const context = (
    outbound,
    secrets = {
      security: {
        serviceTransportKeys: {
          "catalog-activation-worker": "fixture-transport",
        },
      },
    },
  ) => ({
    config: {
      environment: "development",
      services: {
        "catalog-activation-worker": { outbound, kafka: { producers: [] } },
      },
    },
    secrets,
  });
  assert.throws(
    () =>
      configure(app, processController.signal, database, kafka, context([])),
    { message: "CATALOG_INTERNAL_API_ORIGIN_NOT_CONFIGURED" },
  );
  assert.throws(
    () =>
      configure(
        app,
        processController.signal,
        database,
        kafka,
        context(["api-internal:4051"], {}),
      ),
    { message: "CATALOG_TRANSPORT_SECRET_MISSING" },
  );
  assert.equal(
    events.some((event) => event.kind === "http"),
    false,
    "invalid target and missing scoped material fail before HTTP client creation",
  );
  await configure(
    app,
    processController.signal,
    database,
    kafka,
    context(["api-internal:4051"]),
  );
  assert.deepEqual(parsedTransport, {
    value: "fixture-transport",
    environment: "development",
    runtime: "catalog-activation-worker",
  });
  assert.equal(events.at(-1).options.origin, "https://api-internal:4051");
  assert.equal(events.at(-1).options.tls.targetRuntime, "api-internal");
  assert.equal(events.at(-1).options.tls.targetEnvironment, "development");
  assert.equal(events.at(-1).options.connections, 1);
  assert.equal(events.at(-1).options.pipelining, 1);
  const resource = composition.resources[0];
  const ready = () => composition.readinessChecks[0].check();
  const metrics = () => composition.metrics();
  const assertSupervisorMetrics = (up, failed) => {
    assert.ok(
      metrics().includes(`coffee_catalog_activation_supervisor_up ${up}`),
    );
    assert.ok(
      metrics().includes(`coffee_catalog_activation_cycle_failed ${failed}`),
    );
  };
  assert.equal(ready(), false);
  assertSupervisorMetrics(0, 0);
  let stopped = false;
  try {
    resource.start();
    await sleepEntered[0].promise;
    assert.equal(
      relayCalls,
      1,
      "committed Catalog events relay even when a new Gateway binding fails",
    );
    assert.equal(fetchCalls, 1);
    assert.equal(
      ready(),
      false,
      "failed binding keeps supervisor readiness closed",
    );
    assertSupervisorMetrics(1, 1);
    releaseSleep();
    await sleepEntered[1].promise;
    assert.equal(runCalls, 2);
    assert.equal(relayCalls, 2);
    assert.equal(fetchCalls, 2);
    assert.equal(ready(), true, "successful retry restores readiness");
    assertSupervisorMetrics(1, 0);
    processController.abort(new Error("fixture stop"));
    await resource.stop();
    stopped = true;
    assert.equal(
      httpCloses,
      1,
      "stop joins the supervisor and closes its HTTP client",
    );
    assert.equal(ready(), false);
    assertSupervisorMetrics(0, 0);
    const stoppedCalls = runCalls;
    resource.destroy();
    resource.destroy();
    assert.equal(
      ready(),
      false,
      "destroy after stop remains idempotently not ready",
    );
    assertSupervisorMetrics(0, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      runCalls,
      stoppedCalls,
      "stop prevents further activation cycles",
    );
    assert.deepEqual(
      cycleDiagnostics,
      [["catalog activation cycle failed", "CatalogBindingClientError"]],
      "supervisor diagnostics exclude binding response details",
    );
  } finally {
    try {
      if (!stopped) {
        processController.abort(new Error("fixture cleanup"));
        await resource.stop();
      }
    } finally {
      console.error = originalConsoleError;
    }
  }
  console.log(`composition ${mode}: PASS`);
} else {
  await import("../../apps/catalog-supplier-sync/dist/main.js");
  controller = new AbortController();
  await composition.configure(
    {
      log: {
        info: (value) => diagnostics.push(value),
        error: (value) => diagnostics.push(value),
        warn: (value) => diagnostics.push(value),
      },
    },
    controller.signal,
    {},
    undefined,
    {
      config: {
        environment: "test",
        services: {
          "catalog-supplier-sync": {
            outbound: ["api-internal:4051"],
            scheduler: { intervalMs: 3600000 },
            deadlineMs: 30000,
          },
        },
      },
      secrets: {
        security: { serviceTransportKeys: { "catalog-supplier-sync": {} } },
      },
    },
  );
  const resource = composition.resources[0];
  await resource.start(controller.signal);
  if (mode === "scheduler-recovery") {
    await schedulerCompletion;
    assert.equal(exports, 2);
    assert.equal(ticks, 3);
    assert.deepEqual(events, [
      "recover",
      "export",
      "recover",
      "recover",
      "reject-old",
      "export",
    ]);
  } else if (mode === "recovery") {
    await assert.rejects(run, /OutcomeUnknown/u);
    unavailable = true;
    await assert.rejects(
      run,
      /DB_CONNECTION_LOST/u,
      "DB loss must block the second export",
    );
    assert.equal(exports, 1);
    unavailable = false;
    await run();
    assert.deepEqual(events, [
      "recover",
      "export",
      "recover",
      "recover",
      "reject-old",
      "export",
    ]);
  } else {
    assert.ok(
      composition.readinessChecks?.length,
      "startup recovery and supervisor need a readiness check",
    );
    const ready = () =>
      composition.readinessChecks.every(
        (check) => check.check(controller.signal) === true,
      );
    assert.equal(ready(), false, "not ready before startup recovery");
    await assert.rejects(run, /OutcomeUnknown/u);
    // Recovery completed; an ordinary traversal failure is not a dead supervisor.
    assert.equal(ready(), true);
    await assert.rejects(run, /SNAPSHOT_FAILED_PROVIDER_TIMEOUT/u);
    assert.equal(
      ready(),
      true,
      "ordinary provider failure must not kill readiness",
    );
    await run();
    assert.equal(ready(), true);
    if (mode === "readiness-reject")
      failSupervisor(new Error("fixture supervisor failed"));
    else endSupervisor();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      ready(),
      false,
      "terminated supervisor must not advertise ready",
    );
  }
  endSupervisor?.();
  await resource.stop(controller.signal);
  console.log(`composition ${mode}: PASS`);
}
