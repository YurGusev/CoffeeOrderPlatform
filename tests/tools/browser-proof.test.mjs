import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { load } from "js-yaml";
import {
  BROWSER_REQUIRED_CHECKS,
  createBrowserNetworkMonitor,
  createObservabilityBrowserNetworkMonitor,
  matchBrowserChain,
  isAcceptedObservabilityProjection,
  validateObservabilityBrowserEvidence,
  buildRealtimeAuthCloseInvocation,
  proveNaturalSseReauthentication,
  expectedBrowserCompletedResponse,
  hasOrderRefetchAfterReady,
  hasReadForRequest,
  hasOrderRealtimeRefetch,
  matchesBrowserMutation,
  parseRealtimeAuthCloseMetric,
  proveBrowser,
  validateBrowserEvidence,
  validateBrowserRuntimeArtifact,
} from "../../tools/browser-proof.mjs";
import {
  validateOwnerBrowserProofHashes,
  validateOwnerBrowserReceipt,
  validateBrowserChildContext,
  validateBrowserChildProcess,
  validateBrowserFailureReceipt,
  validateBrowserParentRuntime,
  persistBrowserFailureFromChild,
  validateBrowserChildFailureDiagnostic,
  prepareBrowserChildCheckout,
  validateChildCleanup,
} from "../../verification/launch/v1/scenarios/browser.mjs";

const RUN_ID = "20261025T132252Z-085cdd6";
const CANDIDATE_SHA = "a".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ORDER_REF = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ITEM_REF = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";

void test("G14 binds a real SSE stream and later owner read to exactly one Confirm", async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({
    body: JSON.stringify({ orderRef: ORDER_REF, projectionVersion: "5" }),
    base64Encoded: false,
  });
  const monitor = createObservabilityBrowserNetworkMonitor(cdp);
  const correlationId = "00000000-0000-4000-8000-000000000015";
  const frameId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const request = (requestId, url, method = "GET", headers = {}) =>
    cdp.emit("Network.requestWillBeSent", {
      requestId,
      request: { url: `https://localhost:8443${url}`, method, headers },
    });
  request("stream", "/events");
  cdp.emit("Network.responseReceived", {
    requestId: "stream",
    response: { status: 200 },
  });
  request(
    "confirm",
    `/api/client-v1/orders/${ORDER_REF}/commands/confirm`,
    "POST",
    { "X-Correlation-ID": correlationId },
  );
  const frame = {
    eventName: "resource-invalidated.v1",
    eventId: frameId,
    data: JSON.stringify({
      subjectType: "order",
      subjectRef: ORDER_REF,
      ownerVersion: "5",
      reason: "AromaStateChanged",
      correlationId,
    }),
  };
  cdp.emit("Network.eventSourceMessageReceived", {
    ...frame,
    requestId: "foreign",
  });
  cdp.emit("Network.eventSourceMessageReceived", {
    ...frame,
    requestId: "stream",
    eventId: "bad",
  });
  assert.equal(monitor.frames.length, 0);
  cdp.emit("Network.eventSourceMessageReceived", {
    ...frame,
    requestId: "stream",
  });
  request("read", `/api/client-v1/orders/${ORDER_REF}`, "GET", {
    "x-correlation-id": correlationId,
  });
  cdp.emit("Network.responseReceived", {
    requestId: "read",
    response: { status: 200 },
  });
  cdp.emit("Network.loadingFinished", { requestId: "read" });
  await new Promise((resolve) => setImmediate(resolve));
  const telemetry = [
    {
      name: "ui.query.result",
      correlationId,
      endpoint: "/api/client-v1/orders/:ref",
      result: "http:200",
    },
  ];
  assert.equal(
    matchBrowserChain(monitor, ORDER_REF, telemetry)?.frame.frameId,
    frameId,
  );
  assert.equal(
    matchBrowserChain(monitor, ORDER_REF, [
      { ...telemetry[0], correlationId: keyForWrongCorrelation() },
    ]),
    undefined,
  );
  assert.equal(
    matchBrowserChain(monitor, "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW", telemetry),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      { ...monitor, reads: [{ ...monitor.reads[0], status: 503 }] },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      {
        ...monitor,
        reads: [{ ...monitor.reads[0], sequence: monitor.frames[0].sequence }],
      },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
  assert.equal(isAcceptedObservabilityProjection("6", "5", "4"), true);
  assert.equal(isAcceptedObservabilityProjection("4", "5", "3"), false);
  assert.equal(isAcceptedObservabilityProjection("6", "5", "5"), false);
  const secondFrame = {
    ...monitor.frames[0],
    frameId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    ownerVersion: "6",
    sequence: monitor.reads[0].sequence + 1,
  };
  const repeated = {
    ...monitor,
    frames: [...monitor.frames, secondFrame],
    reads: [
      ...monitor.reads,
      {
        ...monitor.reads[0],
        projectionVersion: "6",
        sequence: secondFrame.sequence + 1,
      },
    ],
  };
  assert.equal(
    matchBrowserChain(repeated, ORDER_REF, [...telemetry, ...telemetry])?.frame
      .frameId,
    frameId,
  );
  assert.equal(
    matchBrowserChain(repeated, ORDER_REF, telemetry, new Set([frameId]))?.frame
      .frameId,
    secondFrame.frameId,
  );
  assert.equal(
    matchBrowserChain(repeated, ORDER_REF, telemetry, new Set(), "5")?.frame
      .frameId,
    secondFrame.frameId,
  );
  assert.equal(
    matchBrowserChain(
      {
        ...repeated,
        reads: [
          repeated.reads[0],
          { ...repeated.reads[1], projectionVersion: "5" },
        ],
      },
      ORDER_REF,
      telemetry,
      new Set([frameId]),
    ),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      {
        ...monitor,
        reads: [
          { ...monitor.reads[0], sequence: monitor.reads[0].sequence + 1 },
        ],
        frames: [
          ...monitor.frames,
          {
            ...monitor.frames[0],
            sequence: monitor.reads[0].sequence,
            correlationId: keyForWrongCorrelation(),
          },
        ],
      },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      { ...monitor, reads: [{ ...monitor.reads[0], projectionVersion: "4" }] },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      {
        ...monitor,
        frames: [
          { ...monitor.frames[0], correlationId: keyForWrongCorrelation() },
        ],
      },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
  assert.equal(
    matchBrowserChain(
      {
        ...monitor,
        commands: [
          ...monitor.commands,
          { ...monitor.commands[0], kind: "request-aroma-reconciliation" },
        ],
      },
      ORDER_REF,
      telemetry,
    ),
    undefined,
  );
});

function keyForWrongCorrelation() {
  return "00000000-0000-4000-8000-000000000016";
}

void test("G14 evidence and cleanup reject extra fields, stale version and unknown cleanup", () => {
  const evidence = {
    schemaVersion: 1,
    purpose: "G14_BROWSER_CORRELATION",
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    configSha256: "a".repeat(64),
    status: "PASS",
    correlationId: keyForWrongCorrelation(),
    ownerMessageSha256: "b".repeat(64),
    realtimeMessageSha256: "c".repeat(64),
    ownerVersion: "5",
    ownerTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    realtimeTraceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    traceId: "a".repeat(32),
    confirmedVersion: "4",
    acceptedVersion: "6",
    confirmCount: 1,
    reconcileCount: 0,
    providerIsolated: true,
    mutationsEnabled: false,
    traceStatus: "NOT_PROVEN",
    browserCleanup: "EXACT_OWNED_CONTAINER_REMOVED",
  };
  const identity = {
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    configSha256: evidence.configSha256,
  };
  assert.equal(
    validateObservabilityBrowserEvidence(evidence, identity),
    evidence,
  );
  for (const change of [
    { acceptedVersion: "4" },
    { confirmCount: 2 },
    { reconcileCount: 1 },
    { traceStatus: "PASS" },
    { ownerTraceparent: "invalid" },
    { realtimeTraceparent: `00-${"c".repeat(32)}-${"b".repeat(16)}-01` },
    { traceId: "c".repeat(32) },
    { browserCleanup: "UNCONFIRMED" },
    { verificationOnly: true },
  ])
    assert.throws(() =>
      validateObservabilityBrowserEvidence(
        { ...evidence, ...change },
        identity,
      ),
    );
  assert.throws(() => validateBrowserEvidence(evidence, identity));
  const names = ["customer", "catalog", "pricing", "orders", "integration"]
    .map(
      (owner) =>
        `coffee_verify_${RUN_ID.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  const cleanup = {
    cleanup: {
      verified: true,
      complete: true,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
      fixtureRootRemoved: true,
      secretsDirRemoved: true,
      composeOverrideRemoved: true,
    },
    externalCleanup: {
      verified: true,
      databases: { verified: true, removed: names, retained: [] },
      attachment: {
        baselineAttached: false,
        attempted: true,
        removed: true,
        routePreserved: true,
      },
    },
  };
  assert.equal(
    validateChildCleanup(cleanup, { runId: RUN_ID }),
    cleanup.externalCleanup,
  );
  assert.throws(() =>
    validateChildCleanup(
      { ...cleanup, cleanup: { ...cleanup.cleanup, complete: false } },
      { runId: RUN_ID },
    ),
  );
  for (const baselineAttached of [false, true]) {
    for (const attempted of [false, true]) {
      for (const removed of [false, true]) {
        const externalCleanup = {
          ...cleanup.externalCleanup,
          attachment: {
            baselineAttached,
            attempted,
            removed,
            routePreserved: true,
          },
        };
        const candidate = { ...cleanup, externalCleanup };
        if (attempted === !baselineAttached && removed === !baselineAttached)
          assert.equal(
            validateChildCleanup(candidate, { runId: RUN_ID }),
            externalCleanup,
          );
        else
          assert.throws(() =>
            validateChildCleanup(candidate, { runId: RUN_ID }),
          );
      }
    }
  }
  assert.throws(() =>
    validateChildCleanup(
      {
        ...cleanup,
        externalCleanup: {
          ...cleanup.externalCleanup,
          attachment: { attempted: true, removed: true, routePreserved: true },
        },
      },
      { runId: RUN_ID },
    ),
  );
  assert.throws(() =>
    validateChildCleanup(
      {
        ...cleanup,
        externalCleanup: {
          ...cleanup.externalCleanup,
          attachment: {
            ...cleanup.externalCleanup.attachment,
            routePreserved: false,
          },
        },
      },
      { runId: RUN_ID },
    ),
  );
});

function validEvidence() {
  const hash = "b".repeat(64);
  const summary = (tableNames) => ({
    state: "Completed",
    idempotencyRows: 1,
    resourceSha256: hash,
    tableCounts: Object.fromEntries(tableNames.map((name) => [name, 1])),
    businessDigest: hash,
  });
  const checkDetails = {
    oidcLogin: { authenticatedSession: true, servedIngress: true },
    servedAssets: { scriptCount: 1, stylesheetCount: 1 },
    customerLostResponseReplay: {
      responseDroppedAtEdge: true,
      completedReplayReadOnly: true,
      pendingMetadataPiiFree: true,
      replayStatus: 201,
      replayed: true,
    },
    ownerRestartReadOnlyReplay: {
      restartVerified: true,
      sameIntentKeyRetained: true,
      replayStatus: 201,
      replayed: true,
      ownerEffectsStable: true,
    },
    draftReplayAfterNewCard: {
      secondCardCreatedFirst: true,
      olderDraftReplayed: true,
      olderCardDifferentFromNewCard: true,
      replayStatus: 201,
      replayed: true,
    },
    quoteLostResponseReplay: {
      completedReplayReadOnly: true,
      quoteSnapshotStable: true,
      replayStatus: 201,
      replayed: true,
    },
    draftItemPutAndEdit: {
      createPutCompleted: true,
      editPutCompleted: true,
      createPutStatus: 200,
      editPutStatus: 200,
      itemCount: 1,
    },
    draftItemDelete: {
      completed: true,
      deleteStatus: 200,
      deletedItemCount: 0,
    },
    inProgressReplay: {
      status: 409,
      problemCode: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      keyRetained: true,
      state: "Acquired",
    },
    notRetainedReplay: {
      absent: true,
      keySha256: hash,
      status: 410,
      problemCode: "IDEMPOTENCY_RESULT_NOT_RETAINED",
      keyRetained: true,
    },
    lookupUnavailableReplay: {
      status: 503,
      problemCode: "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
      restoreVerified: true,
      keyRetained: true,
    },
    sseRefetch: {
      readyEvents: 1,
      invalidations: 1,
      ownerRefetches: 1,
      invalidationObserved: true,
      sameOrderRefetched: true,
      projectionCaughtUp: true,
    },
    sameOrderStaleReplay: {
      staleGetCancelledOrIgnored: true,
      historicalReplayStatus: 200,
      historicalReplayUsed: true,
      sameOrderVerified: true,
      projectionAdvanced: true,
      olderReplayDidNotDowngrade: true,
      ownerEffectsStable: true,
    },
    naturalSseReauthentication: {
      authCloseCountDelta: 1,
      eventSourceResponseDelta: 1,
      streamReadyDelta: 1,
      lastEventIdResumed: true,
      sameActor: true,
      sessionCookieStable: true,
      ownerRefetchAfterReady: true,
      within120Seconds: true,
    },
    optimisticConflict: {
      status: 409,
      ownerStateUnchanged: true,
      staleVersionRejected: true,
    },
    deepLinkReload: { directRouteLoaded: true, reloadFetchedOwner: true },
    apiFallback: { status: 404, jsonResponse: true, indexHtml: false },
    assetFallback: {
      missingStatus: 404,
      missingReturnedIndex: false,
      servedScriptCount: 1,
      servedStylesheetCount: 1,
    },
    accessibility: {
      customer: { violations: 0, seriousOrCritical: 0 },
      order: { violations: 0, seriousOrCritical: 0 },
    },
    logoutAndActorSwitch: {
      logoutStatus: 204,
      sessionCookieCleared: true,
      pendingIntentsCleared: true,
      restrictedAccountSelected: true,
    },
    restrictedPermissionDenied: {
      customerReadStatus: 403,
      customerCreateStatus: 403,
      ownerWriteAbsent: true,
      businessBefore: {
        tableCounts: {
          customers: 1,
          addresses: 1,
          channelLinks: 1,
          audit: 1,
        },
        businessDigest: hash,
      },
      businessAfter: {
        tableCounts: {
          customers: 1,
          addresses: 1,
          channelLinks: 1,
          audit: 1,
        },
        businessDigest: hash,
      },
      businessUnchanged: true,
      keySha256: hash,
    },
    noConfirmOrReconcile: { forbiddenMutationRequests: 0 },
  };
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    status: "passed",
    verificationOnly: true,
    productionLogin: false,
    checks: Object.fromEntries(
      BROWSER_REQUIRED_CHECKS.map((name) => [
        name,
        { passed: true, ...checkDetails[name] },
      ]),
    ),
    owners: {
      customer: summary(["customers", "addresses", "audit"]),
      orders: {
        draft: summary(["orders", "items", "history", "outbox"]),
        put: summary(["orders", "item", "history", "outbox"]),
        delete: summary(["orders", "item", "history", "outbox"]),
      },
      pricing: summary(["quotes", "quoteLines", "audit"]),
    },
    browser: {
      driverStatus: "READY",
      imageIdSha256: hash,
      networkIdSha256: hash,
      cleanup: "EXACT_OWNED_CONTAINER_REMOVED",
      browserContexts: 1,
      eventSourceResponses: 1,
    },
  };
}

void test("G15 mutation matcher admits only exact approved owner writes", () => {
  assert.equal(
    matchesBrowserMutation(
      {
        url: "https://localhost:8443/api/client-v1/customers",
        method: "POST",
      },
      "customer.create",
    ),
    true,
  );
  assert.equal(
    matchesBrowserMutation(
      {
        url: "https://localhost:8443/api/client-v1/orders/drafts",
        method: "POST",
      },
      "orders.draft.create",
    ),
    true,
  );
  assert.equal(
    matchesBrowserMutation(
      {
        url: "https://localhost:8443/api/client-v1/pricing/quotes",
        method: "POST",
      },
      "pricing.quote.create",
    ),
    true,
  );
  assert.equal(
    matchesBrowserMutation(
      {
        url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/items/${ITEM_REF}`,
        method: "PUT",
      },
      "orders.item.put",
      { orderRef: ORDER_REF, itemRef: ITEM_REF },
    ),
    true,
  );
  assert.equal(
    matchesBrowserMutation(
      {
        url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/items/${ITEM_REF}`,
        method: "DELETE",
      },
      "orders.item.delete",
      { orderRef: ORDER_REF, itemRef: ITEM_REF },
    ),
    true,
  );
  for (const request of [
    { url: "https://example.invalid/api/client-v1/customers", method: "POST" },
    {
      url: "https://localhost:8443/api/client-v1/customers?x=1",
      method: "POST",
    },
    {
      url: "https://localhost:8443/api/client-v1/orders/confirm",
      method: "POST",
    },
    {
      url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/items/${ITEM_REF}`,
      method: "POST",
    },
  ])
    assert.equal(matchesBrowserMutation(request, "customer.create"), false);
  assert.equal(
    matchesBrowserMutation(
      {
        url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/items/${ITEM_REF}`,
        method: "PUT",
      },
      "orders.item.put",
      { orderRef: `${ORDER_REF}x`, itemRef: ITEM_REF },
    ),
    false,
  );
  assert.equal(
    matchesBrowserMutation(
      {
        url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/items/${ITEM_REF}?reconcile=1`,
        method: "DELETE",
      },
      "orders.item.delete",
      { orderRef: ORDER_REF, itemRef: ITEM_REF },
    ),
    false,
  );
});

void test("G15 natural SSE wait propagates a stop request immediately", async () => {
  let stopChecks = 0;
  const runtimeContext = {
    async readRealtimeAuthCloseCount() {
      return 4;
    },
    throwIfStopRequested() {
      stopChecks += 1;
      throw new Error("G18_STOP_REQUESTED_SIGTERM");
    },
    ownerEvidence: {
      async snapshot() {
        return { state: "Completed" };
      },
    },
  };
  const browserContext = {
    async cookies() {
      return [{ name: "__Host-coffee-session", value: "session-fixture" }];
    },
  };
  const page = {
    getByText() {
      return {
        async waitFor() {},
        async textContent() {
          return "Заказ ord_01ARZ3NDEKTSV4RRFFQ69G5FAV · версия представления 7";
        },
      };
    },
  };

  await assert.rejects(
    proveNaturalSseReauthentication({
      page,
      browserContext,
      monitor: {
        eventSourceResponses: 1,
        eventSourceReady: 1,
        eventSourceRecords: [],
        reads: [],
      },
      runtimeContext,
      orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      idempotencyKey: "fixture-idempotency-key",
    }),
    /G15_BROWSER_STOP_REQUESTED/u,
  );
  assert.equal(stopChecks, 1);
});

void test("G15 browser proof requires the Compose stop capability", async () => {
  await assert.rejects(
    proveBrowser({
      projectName: "coffee-g15-proof",
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
      ownerEvidence: {
        snapshot() {},
        assertAbsent() {},
        seedInProgress() {},
        withLookupUnavailable() {},
      },
      readRealtimeAuthCloseCount() {},
      restartCustomerService() {},
    }),
    /G15_BROWSER_RUNTIME_CONTEXT_INVALID/u,
  );
});

void test("G15 retains the primary browser error after all cleanup attempts", async () => {
  const canary = "browser-private-canary";
  const primary = new TypeError(`selector=${canary}`);
  primary.stack = [
    `TypeError: selector=${canary}`,
    `    at browserStep (${pathToFileURL(join(REPO_ROOT, "tools/browser-proof.mjs")).href}:1234:17)`,
  ].join("\n");
  const calls = [];
  let thrown = primary;
  const cdp = {
    async send() {
      throw thrown;
    },
    async detach() {
      calls.push("detach");
      throw new Error(`cleanup=${canary}`);
    },
  };
  const context = {
    async newPage() {
      return {};
    },
    async newCDPSession() {
      return cdp;
    },
    async close() {
      calls.push("context.close");
    },
  };
  const driver = {
    browser: {
      async newContext() {
        return context;
      },
    },
    witness: { status: "READY" },
    async close() {
      calls.push("driver.close");
      return "EXACT_OWNED_CONTAINER_REMOVED";
    },
  };
  const key = Symbol.for("coffee.g15-primary-error-regression");
  globalThis[key] = async () => driver;
  const url = `data:text/javascript,${encodeURIComponent('export const startBrowser=globalThis[Symbol.for("coffee.g15-primary-error-regression")];')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "./browser-driver.mjs" &&
        context.parentURL?.includes("?g15-primary-error-regression")
        ? { url, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const { proveBrowser: proveWithDriver } =
      await import("../../tools/browser-proof.mjs?g15-primary-error-regression");
    const runtimeContext = {
      projectName: "coffee-g15-proof",
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
      throwIfStopRequested() {},
      ownerEvidence: {
        snapshot() {},
        assertAbsent() {},
        seedInProgress() {},
        withLookupUnavailable() {},
      },
      readRealtimeAuthCloseCount() {},
      restartCustomerService() {},
    };
    await assert.rejects(
      proveWithDriver(runtimeContext),
      (error) => error === primary,
    );
    assert.deepEqual(calls, ["detach", "context.close", "driver.close"]);
    calls.length = 0;
    thrown = { secret: canary };
    await assert.rejects(proveWithDriver(runtimeContext), {
      message: "G15_BROWSER_PROOF_FAILED",
    });
    assert.deepEqual(calls, ["detach", "context.close", "driver.close"]);
    const { createBrowserChildFailureDiagnostic } =
      await import("../../tools/compose-smoke.mjs");
    const identity = {
      runId: RUN_ID,
      candidateSha: `${RUN_ID.slice(-7)}${"a".repeat(33)}`,
    };
    const diagnostic = createBrowserChildFailureDiagnostic({
      ...identity,
      error: primary,
    });
    assert.equal(diagnostic.errorName, "TypeError");
    assert.equal(
      diagnostic.messageSha256,
      createHash("sha256").update(primary.message).digest("hex"),
    );
    assert.deepEqual(diagnostic.sourceLocation, {
      source: "tools/browser-proof.mjs",
      line: 1234,
      column: 17,
    });
    assert.equal(
      validateBrowserChildFailureDiagnostic(diagnostic, identity),
      true,
    );
    const parentContext = {
      runId: "20261025T130001Z-1111111",
      candidateSha: "1".repeat(40),
    };
    assert.equal(
      validateBrowserFailureReceipt(
        {
          schemaVersion: diagnostic.schemaVersion,
          gateId: diagnostic.gateId,
          outcome: diagnostic.outcome,
          parentRunId: parentContext.runId,
          parentCandidateSha: parentContext.candidateSha,
          childRunId: identity.runId,
          childCandidateSha: identity.candidateSha,
          errorName: diagnostic.errorName,
          messageSha256: diagnostic.messageSha256,
          sourceLocation: diagnostic.sourceLocation,
        },
        { parentContext, childContext: identity },
      ),
      true,
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /browser-private-canary|selector|stack/u,
    );
    assert.throws(
      () =>
        validateBrowserChildFailureDiagnostic(
          {
            ...diagnostic,
            sourceLocation: {
              ...diagnostic.sourceLocation,
              source: "tools/foreign.mjs",
            },
          },
          identity,
        ),
      { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
    );
    const localPath = join(REPO_ROOT, "tools/browser-proof.mjs");
    const projection = (stack) =>
      createBrowserChildFailureDiagnostic({
        ...identity,
        error: Object.assign(new Error(canary), { stack }),
      }).sourceLocation;
    assert.deepEqual(projection(`Error\n    at f (${localPath}:9:2)`), {
      source: "tools/browser-proof.mjs",
      line: 9,
      column: 2,
    });
    for (const stack of [
      `Error\n    at f (/tmp/tools/browser-proof.mjs:9:2)`,
      `Error\n    at f (${localPath}:1000001:2)`,
      `Error\n${"    at x (node:internal/test:1:1)\n".repeat(256)}    at f (${localPath}:9:2)`,
      `Error\n${"x".repeat(131_072)}\n    at f (${localPath}:9:2)`,
    ])
      assert.equal(projection(stack), undefined);
  } finally {
    hook.deregister();
    delete globalThis[key];
  }
});

void test("G15 completed-response faults admit only the actual operation statuses", () => {
  assert.equal(
    expectedBrowserCompletedResponse("customer.create", "POST", 201),
    true,
  );
  assert.equal(
    expectedBrowserCompletedResponse("orders.draft.create", "POST", 201),
    true,
  );
  assert.equal(
    expectedBrowserCompletedResponse("pricing.quote.create", "POST", 201),
    true,
  );
  assert.equal(
    expectedBrowserCompletedResponse("orders.item.put", "PUT", 200),
    true,
  );
  assert.equal(
    expectedBrowserCompletedResponse("orders.item.put", "PUT", 201),
    false,
  );
  assert.equal(
    expectedBrowserCompletedResponse("customer.create", "POST", 200),
    false,
  );
  assert.equal(
    expectedBrowserCompletedResponse("orders.item.delete", "DELETE", 204),
    false,
  );
});

void test("G15 generated metrics probe resolves runtime YAML and uses docker exec argv", async () => {
  const containerId = "a".repeat(64);
  const invocation = buildRealtimeAuthCloseInvocation(containerId);
  assert.deepEqual(invocation.args.slice(0, 5), [
    "exec",
    containerId,
    "node",
    "--input-type=module",
    "-e",
  ]);
  assert.equal(invocation.args.includes("-T"), false);
  const source = invocation.args[5];
  assert.match(source, /createRequire\("\/app\/package\.json"\)/u);
  assert.match(source, /runtimeRequire\.resolve\("js-yaml"\)/u);
  assert.match(
    source,
    /runtimeRequire\.resolve\("@coffee-platform\/security"\)/u,
  );
  assert.match(
    source,
    /document\?\.secrets\?\.security\?\.serviceTransportKeys\?\.\[runtime\]/u,
  );
  assert.match(source, /COFFEE_RUNTIME_SECRETS_FILE/u);
  const documents = [
    `environment: development\nsecrets:\n  security:\n    serviceTransportKeys:\n      realtime-gateway:\n        caPem: public-ca\n        certPem: client-cert\n        keyPem: client-key\n`,
    `environment: development\nsecrets: { security: { serviceTransportKeys: { realtime-gateway: { caPem: public-ca, certPem: client-cert, keyPem: client-key } } } }\n`,
  ];
  for (const yaml of documents) {
    const document = load(yaml);
    assert.equal(document.environment, "development");
    assert.equal(
      document.secrets.security.serviceTransportKeys["realtime-gateway"].keyPem,
      "client-key",
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "g15-metric-probe-"));
  try {
    const sourcePath = join(directory, "probe.mjs");
    await writeFile(sourcePath, source, { mode: 0o600, flag: "wx" });
    const syntax = spawnSync(process.execPath, ["--check", sourcePath], {
      encoding: "utf8",
    });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.throws(
    () => buildRealtimeAuthCloseInvocation("not-a-container-id"),
    /G15_REALTIME_AUTH_CONTAINER_INVALID/u,
  );
});

void test("G15 SSE proof requires an exact post-invalidation read of that order at the announced version", () => {
  const otherOrder = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW";
  const invalidations = [
    { orderRef: otherOrder, ownerVersion: "11", sequence: 10 },
    { orderRef: ORDER_REF, ownerVersion: "12", sequence: 12 },
  ];
  const otherOrderRead = {
    orderRef: otherOrder,
    invalidationSequence: 10,
    requestSequence: 11,
    status: 200,
    responseOrderRef: otherOrder,
    projectionVersion: "11",
  };
  const matchingRead = {
    orderRef: ORDER_REF,
    invalidationSequence: 12,
    requestSequence: 13,
    status: 200,
    responseOrderRef: ORDER_REF,
    projectionVersion: "12",
  };

  assert.equal(
    hasOrderRealtimeRefetch(invalidations, [otherOrderRead], ORDER_REF, 9),
    false,
  );
  assert.equal(
    hasOrderRealtimeRefetch(
      invalidations,
      [{ ...matchingRead, requestSequence: 11 }],
      ORDER_REF,
      9,
    ),
    false,
  );
  assert.equal(
    hasOrderRealtimeRefetch(
      invalidations,
      [{ ...matchingRead, projectionVersion: "11" }],
      ORDER_REF,
      9,
    ),
    false,
  );
  assert.equal(
    hasOrderRealtimeRefetch(invalidations, [matchingRead], ORDER_REF, 11),
    true,
  );
});

void test("G15 natural reauthentication proof binds resumed owner GET to the new ready event", () => {
  const readySequence = 20;
  const goodRead = {
    orderRef: ORDER_REF,
    responseOrderRef: ORDER_REF,
    status: 200,
    requestSequence: 22,
    readySequence,
    projectionVersion: "15",
  };
  assert.equal(
    hasOrderRefetchAfterReady([goodRead], readySequence, ORDER_REF, "15"),
    true,
  );
  assert.equal(
    hasOrderRefetchAfterReady(
      [{ ...goodRead, orderRef: "ord_01ARZ3NDEKTSV4RRFFQ69G5FAW" }],
      readySequence,
      ORDER_REF,
      "15",
    ),
    false,
  );
  assert.equal(
    hasOrderRefetchAfterReady(
      [{ ...goodRead, requestSequence: readySequence }],
      readySequence,
      ORDER_REF,
      "15",
    ),
    false,
  );
  assert.equal(
    hasOrderRefetchAfterReady(
      [{ ...goodRead, readySequence: readySequence - 1 }],
      readySequence,
      ORDER_REF,
      "15",
    ),
    false,
  );
  assert.equal(
    hasOrderRefetchAfterReady(
      [{ ...goodRead, projectionVersion: "14" }],
      readySequence,
      ORDER_REF,
      "15",
    ),
    false,
  );
});

void test("G15 stale GET receipt is correlated to the exact held network request", async () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({
    body: JSON.stringify({ orderRef: ORDER_REF, projectionVersion: "12" }),
    base64Encoded: false,
  });
  const page = new EventEmitter();
  const monitor = createBrowserNetworkMonitor(cdp, page);
  cdp.emit("Network.requestWillBeSent", {
    requestId: "held-order-get",
    request: {
      url: `https://localhost:8443/api/client-v1/orders/${ORDER_REF}`,
      method: "GET",
      headers: {},
    },
  });
  cdp.emit("Network.responseReceived", {
    requestId: "held-order-get",
    response: { status: 200 },
  });
  cdp.emit("Network.loadingFinished", { requestId: "held-order-get" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(monitor.reads.length, 1);
  assert.equal(monitor.reads[0].requestId, "held-order-get");
  assert.equal(monitor.reads[0].projectionVersion, "12");
  assert.equal(
    hasReadForRequest(monitor.reads, "held-order-get", ORDER_REF, "12"),
    true,
  );
  assert.equal(
    hasReadForRequest(monitor.reads, "different-request", ORDER_REF, "12"),
    false,
  );
});

void test("G15 auth-close metric parser accepts exactly one bounded unlabeled sample", () => {
  assert.equal(
    parseRealtimeAuthCloseMetric(
      "# TYPE coffee_realtime_auth_close_total counter\ncoffee_realtime_auth_close_total 7\n",
    ),
    7,
  );
  assert.equal(
    parseRealtimeAuthCloseMetric(
      'coffee_realtime_auth_close_total{runtime="realtime-gateway"} 7\n',
    ),
    null,
  );
  assert.equal(
    parseRealtimeAuthCloseMetric(
      "coffee_realtime_auth_close_total 7\ncoffee_realtime_auth_close_total 8\n",
    ),
    null,
  );
  assert.equal(
    parseRealtimeAuthCloseMetric(
      `coffee_realtime_auth_close_total ${Number.MAX_SAFE_INTEGER + 1}\n`,
    ),
    null,
  );
});

void test("G15 SSE monitor records the native Last-Event-ID used for reconnect", () => {
  const cdp = new EventEmitter();
  cdp.send = async () => ({ body: "", base64Encoded: false });
  const page = new EventEmitter();
  const monitor = createBrowserNetworkMonitor(cdp, page);
  cdp.emit("Network.requestWillBeSent", {
    requestId: "event-source-one",
    request: {
      url: "https://localhost:8443/events",
      method: "GET",
      headers: {},
    },
  });
  cdp.emit("Network.responseReceived", {
    requestId: "event-source-one",
    type: "EventSource",
    response: { status: 200 },
  });
  cdp.emit("Network.eventSourceMessageReceived", {
    eventName: "stream-ready.v1",
    eventId: "",
    data: "{}",
  });
  const eventId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  cdp.emit("Network.eventSourceMessageReceived", {
    eventName: "resource-invalidated.v1",
    eventId,
    data: JSON.stringify({
      subjectType: "order",
      subjectRef: ORDER_REF,
      ownerVersion: "15",
      reason: "OrderChanged",
      correlationId: "00000000-0000-4000-8000-000000000015",
    }),
  });
  cdp.emit("Network.requestWillBeSent", {
    requestId: "event-source-two",
    request: {
      url: "https://localhost:8443/events",
      method: "GET",
      headers: { "Last-Event-ID": eventId },
    },
  });
  cdp.emit("Network.responseReceived", {
    requestId: "event-source-two",
    type: "EventSource",
    response: { status: 200 },
  });
  cdp.emit("Network.eventSourceMessageReceived", {
    eventName: "stream-ready.v1",
    eventId: "",
    data: "{}",
  });

  const resumed = monitor.eventSourceRecords.at(-1);
  assert.equal(resumed.lastEventId, eventId);
  assert.equal(resumed.latestEventIdAtRequest, eventId);
  assert.equal(resumed.readySequence, monitor.lastReadySequence);
  assert.equal(monitor.eventSourceResponses, 2);
  assert.equal(monitor.eventSourceReady, 2);
});

void test("G15 mutation monitor attaches forbidden-write checks to every browser page", () => {
  const cdp = new EventEmitter();
  const initialPage = new EventEmitter();
  const secondPage = new EventEmitter();
  const monitor = createBrowserNetworkMonitor(cdp, initialPage);

  monitor.attachPage(secondPage);
  secondPage.emit("request", {
    url: () =>
      `https://localhost:8443/api/client-v1/orders/${ORDER_REF}/commands/confirm`,
    method: () => "POST",
  });
  secondPage.emit("request", {
    url: () => `https://localhost:8443/api/client-v1/orders/${ORDER_REF}`,
    method: () => "GET",
  });

  assert.equal(monitor.forbiddenMutations, 1);
  assert.equal(monitor.orderGets, 1);

  cdp.emit("Network.eventSourceMessageReceived", {
    eventName: "resource-invalidated.v1",
    data: JSON.stringify({
      subjectType: "order",
      subjectRef: ORDER_REF,
      ownerVersion: "12",
      reason: "OrderChanged",
      correlationId: "00000000-0000-4000-8000-000000000012",
      extra: "must not be accepted",
    }),
  });
  assert.equal(monitor.invalidations, 0);
  assert.deepEqual(monitor.invalidationRecords, []);
});

void test("G15 evidence validator binds the complete passed receipt to its run", () => {
  const evidence = validEvidence();
  assert.equal(
    validateBrowserEvidence(evidence, {
      runId: RUN_ID,
      candidateSha: CANDIDATE_SHA,
    }),
    evidence,
  );
  assert.throws(
    () =>
      validateBrowserEvidence(evidence, {
        runId: "20261025T132300Z-085cdd6",
        candidateSha: CANDIDATE_SHA,
      }),
    /G15_BROWSER_EVIDENCE_IDENTITY_INVALID/u,
  );
  assert.throws(
    () =>
      validateBrowserEvidence(evidence, {
        runId: RUN_ID,
        candidateSha: "b".repeat(40),
      }),
    /G15_BROWSER_EVIDENCE_IDENTITY_INVALID/u,
  );
});

void test("G15 runtime artifact binds full evidence, fixture lineage and cleanup", () => {
  const lineage = {
    schemaVersion: 1,
    profile: "verification-only-pkce-jwks-v1",
    runId: RUN_ID,
    baseCandidateSha: "1".repeat(40),
    candidateSha: CANDIDATE_SHA,
    candidateTreeSha: "2".repeat(40),
    baseConfigSha256: "3".repeat(64),
    configSha256: "4".repeat(64),
    configBlobSha: "5".repeat(40),
    issuer: "https://idp.fixture.invalid",
  };
  const cleanup = {
    verified: true,
    complete: true,
    failures: [],
    retainedResources: [],
    inventory: { containers: [], volumes: [], networks: [] },
    fixtureRootRemoved: true,
    secretsDirRemoved: true,
    composeOverrideRemoved: true,
  };
  const artifact = {
    schemaVersion: 1,
    gateId: "browser",
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    baseConfigSha256: "6".repeat(64),
    status: "PASS",
    verificationOnly: true,
    productionLogin: false,
    lineage,
    browserEvidence: validEvidence(),
    cleanup,
  };
  const expected = {
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    baseConfigSha256: artifact.baseConfigSha256,
    lineage: { ...lineage, receiptPath: "/private/lineage.json" },
  };
  assert.equal(validateBrowserRuntimeArtifact(artifact, expected), artifact);
  assert.throws(
    () =>
      validateBrowserRuntimeArtifact(
        { ...artifact, candidateSha: "7".repeat(40) },
        expected,
      ),
    /G15_BROWSER_ARTIFACT_IDENTITY_INVALID/u,
  );
  assert.throws(
    () =>
      validateBrowserRuntimeArtifact(
        {
          ...artifact,
          lineage: { ...lineage, baseCandidateSha: "8".repeat(40) },
        },
        expected,
      ),
    /G15_BROWSER_ARTIFACT_LINEAGE_INVALID/u,
  );
  assert.throws(
    () =>
      validateBrowserRuntimeArtifact(
        {
          ...artifact,
          cleanup: {
            ...cleanup,
            retainedResources: [{ kind: "containers", name: "foreign" }],
          },
        },
        expected,
      ),
    /G15_BROWSER_ARTIFACT_CLEANUP_INVALID/u,
  );
});

void test("G15 parent admits only a joined successful child with matching cleanup receipt", () => {
  const childContext = { runId: RUN_ID, candidateSha: CANDIDATE_SHA };
  const callbackProof = {
    schemaVersion: 1,
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    status: "passed",
    verificationOnly: true,
    productionLogin: false,
  };
  const cleanup = {
    verified: true,
    complete: true,
    failures: [],
    retainedResources: [],
    inventory: { containers: [], volumes: [], networks: [] },
    fixtureRootRemoved: true,
    secretsDirRemoved: true,
    composeOverrideRemoved: true,
  };
  const childRuntime = { status: "PASS", callbackProof, cleanup };
  const stdoutReceipt = { browserProof: callbackProof, cleanup };
  const processResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    joined: true,
  };
  assert.deepEqual(
    validateBrowserChildProcess(
      processResult,
      childContext,
      childRuntime,
      stdoutReceipt,
    ),
    callbackProof,
  );
  for (const invalidResult of [
    { ...processResult, exitCode: 1 },
    { ...processResult, signal: "SIGTERM" },
    { ...processResult, timedOut: true },
    { ...processResult, joined: false },
  ]) {
    assert.throws(
      () =>
        validateBrowserChildProcess(
          invalidResult,
          childContext,
          childRuntime,
          stdoutReceipt,
        ),
      { code: "G15_CHILD_PROCESS_NOT_ADMITTED" },
    );
  }
  assert.throws(
    () =>
      validateBrowserChildProcess(processResult, childContext, childRuntime, {
        ...stdoutReceipt,
        cleanup: { ...cleanup, verified: false },
      }),
    { code: "G15_CHILD_PROCESS_NOT_ADMITTED" },
  );
  assert.throws(
    () =>
      validateBrowserChildProcess(
        processResult,
        childContext,
        { ...childRuntime, status: "FAIL" },
        stdoutReceipt,
      ),
    { code: "G15_CHILD_PROCESS_NOT_ADMITTED" },
  );
});

void test("G15 parent and child configuration identities require SHA-256 hashes", async () => {
  const parentRoot = "/tmp/g15-parent-candidate";
  const parentContext = {
    runId: "20261025T130000Z-1234567",
    candidateSha: CANDIDATE_SHA,
    baseConfigSha256: "6".repeat(64),
    checkoutDir: parentRoot,
    evidenceDir: `${parentRoot}/evidence/launch/20261025T130000Z-1234567`,
    acceptedBaseCommit: "b".repeat(40),
  };
  const childContext = {
    schemaVersion: 1,
    candidateSha: CANDIDATE_SHA,
    baseConfigSha256: "6".repeat(64),
    runId: RUN_ID,
    checkoutDir: `${parentRoot}/.g15-browser-child-${RUN_ID}`,
    sourceRepoRoot: parentRoot,
    acceptedBaseCommit: parentContext.acceptedBaseCommit,
    startedAtUtc: new Date().toISOString(),
    evidenceDir: `${parentRoot}/evidence/launch/${RUN_ID}`,
    githubSnapshotPath: null,
    resources: {
      composeProject: `coffee-launch-${RUN_ID.toLowerCase()}`,
      g08PreparationContextPath: `${parentContext.evidenceDir}/context.json`,
      g15ParentCandidateSha: parentContext.candidateSha,
      g15ParentCheckoutRoot: parentRoot,
      g15ParentRunId: parentContext.runId,
      kafkaPrefix: RUN_ID,
    },
  };
  assert.equal(
    validateBrowserChildContext(childContext, parentContext, parentRoot),
    undefined,
  );
  assert.throws(
    () =>
      validateBrowserChildContext(
        { ...childContext, baseConfigSha256: CANDIDATE_SHA },
        parentContext,
        parentRoot,
      ),
    { code: "G15_CHILD_CONTEXT_INVALID" },
  );

  const evidenceDir = await mkdtemp(join(tmpdir(), "g15-parent-sha-"));
  try {
    await assert.rejects(
      validateBrowserParentRuntime({
        evidenceDir,
        parentContext: {
          ...parentContext,
          candidateSha: CANDIDATE_SHA,
          baseConfigSha256: CANDIDATE_SHA,
        },
        stdoutReceipt: {},
      }),
      { code: "G15_PARENT_CONFIG_HASH_INVALID" },
    );
    await assert.rejects(
      validateBrowserParentRuntime({
        evidenceDir,
        parentContext: {
          ...parentContext,
          candidateSha: CANDIDATE_SHA,
          baseConfigSha256: "6".repeat(64),
        },
        stdoutReceipt: {},
      }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

void test("G15 child failure receipt keeps only scoped hashes and fixed source location", async () => {
  const { createBrowserChildFailureDiagnostic } =
    await import("../../tools/compose-smoke.mjs");
  const parentCandidateSha = "1".repeat(40);
  const parentContext = {
    runId: `20261025T130001Z-${parentCandidateSha.slice(0, 7)}`,
    candidateSha: parentCandidateSha,
  };
  const childContext = {
    runId: RUN_ID,
    candidateSha: `${RUN_ID.slice(-7)}${"a".repeat(33)}`,
  };
  const canary = "G15_RAW_CHILD_ERROR_CANARY";
  const childFailure = Object.assign(new TypeError(canary), {
    stack: [
      `TypeError: ${canary}`,
      `    at run (${pathToFileURL(join(REPO_ROOT, "tools/compose-smoke.mjs")).href}:1234:17)`,
    ].join("\n"),
  });
  const operationDiagnosticInput = {
    operation: "runtime-stack-up",
    failureClass: "nonzero-exit",
    exitCode: 1,
    signal: null,
    timedOut: false,
    containerSnapshot: {
      status: "captured",
      containers: [
        {
          service: "orders-service",
          state: "exited",
          health: "unhealthy",
          exitCode: 1,
          oomKilled: false,
          name: "container-id-canary",
          startedAt: "2026-10-26T01:02:03.000Z",
          raw: canary,
        },
      ],
      raw: canary,
    },
    raw: canary,
  };
  const diagnostic = createBrowserChildFailureDiagnostic({
    ...childContext,
    error: childFailure,
    operationDiagnostic: operationDiagnosticInput,
  });
  const aggregateDiagnostic = createBrowserChildFailureDiagnostic({
    ...childContext,
    error: new AggregateError(
      [childFailure, new Error(`cleanup ${canary}`)],
      `aggregate ${canary}`,
      { cause: childFailure },
    ),
    operationDiagnostic: operationDiagnosticInput,
  });
  assert.deepEqual(aggregateDiagnostic, diagnostic);
  assert.equal(diagnostic.errorName, "TypeError");
  assert.equal(
    diagnostic.messageSha256,
    createHash("sha256").update(canary).digest("hex"),
  );
  assert.doesNotMatch(
    JSON.stringify(aggregateDiagnostic),
    new RegExp(canary, "u"),
  );
  const fallbackDiagnostic = createBrowserChildFailureDiagnostic({
    ...childContext,
    error: new AggregateError([childFailure], "aggregate", { cause: canary }),
  });
  assert.equal(fallbackDiagnostic.errorName, "AggregateError");
  assert.equal(
    fallbackDiagnostic.messageSha256,
    createHash("sha256").update("aggregate").digest("hex"),
  );
  assert.equal(
    validateBrowserChildFailureDiagnostic(diagnostic, childContext),
    true,
  );
  assert.deepEqual(diagnostic.sourceLocation, {
    source: "tools/compose-smoke.mjs",
    line: 1234,
    column: 17,
  });
  assert.deepEqual(diagnostic.operationDiagnostic, {
    operation: "runtime-stack-up",
    failureClass: "nonzero-exit",
    exitCode: 1,
    signal: null,
    timedOut: false,
    containerSnapshot: {
      status: "captured",
      containers: [
        {
          service: "orders-service",
          state: "exited",
          health: "unhealthy",
          exitCode: 1,
          oomKilled: false,
        },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(canary, "u"));
  assert.doesNotMatch(JSON.stringify(diagnostic), /container-id-canary/u);
  assert.throws(
    () =>
      validateBrowserChildFailureDiagnostic(
        { ...diagnostic, rawStack: childFailure.stack },
        childContext,
      ),
    { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
  );
  assert.throws(
    () =>
      validateBrowserChildFailureDiagnostic(
        { ...diagnostic, runId: parentContext.runId },
        childContext,
      ),
    { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
  );
  assert.throws(
    () =>
      validateBrowserChildFailureDiagnostic(
        {
          ...diagnostic,
          operationDiagnostic: {
            ...diagnostic.operationDiagnostic,
            rawStderr: canary,
          },
        },
        childContext,
      ),
    { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
  );
  assert.throws(
    () =>
      validateBrowserChildFailureDiagnostic(
        {
          ...diagnostic,
          operationDiagnostic: {
            ...diagnostic.operationDiagnostic,
            failureClass: "not-finite",
          },
        },
        childContext,
      ),
    { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
  );
  assert.throws(
    () =>
      validateBrowserChildFailureDiagnostic(
        {
          ...diagnostic,
          operationDiagnostic: {
            ...diagnostic.operationDiagnostic,
            containerSnapshot: {
              ...diagnostic.operationDiagnostic.containerSnapshot,
              containers: Array.from(
                { length: 33 },
                () =>
                  diagnostic.operationDiagnostic.containerSnapshot
                    .containers[0],
              ),
            },
          },
        },
        childContext,
      ),
    { code: "G15_CHILD_FAILURE_DIAGNOSTIC_INVALID" },
  );

  const tempRoot = await mkdtemp(join(tmpdir(), "g15-child-failure-"));
  const evidenceDir = join(tempRoot, "evidence");
  const artifactsDir = join(evidenceDir, "gates/browser/artifacts");
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
  try {
    const error = Object.assign(new Error("child exited"), {
      result: {
        code: 1,
        signal: null,
        stdout: `${JSON.stringify(diagnostic)}\n`,
        stderr: canary,
        joined: true,
      },
    });
    const persisted = await persistBrowserFailureFromChild({
      error,
      parentContext,
      childContext,
      evidenceDir,
    });
    assert.ok(persisted);
    assert.equal((await stat(persisted.path)).mode & 0o777, 0o600);
    const receiptText = await readFile(persisted.path, "utf8");
    const receipt = JSON.parse(receiptText);
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      gateId: "browser",
      outcome: "FAIL",
      parentRunId: parentContext.runId,
      parentCandidateSha: parentContext.candidateSha,
      childRunId: childContext.runId,
      childCandidateSha: childContext.candidateSha,
      errorName: diagnostic.errorName,
      messageSha256: diagnostic.messageSha256,
      sourceLocation: diagnostic.sourceLocation,
      operationDiagnostic: diagnostic.operationDiagnostic,
    });
    assert.equal(
      validateBrowserFailureReceipt(receipt, {
        parentContext,
        childContext,
      }),
      true,
    );
    assert.doesNotMatch(receiptText, new RegExp(canary, "u"));
    assert.doesNotMatch(receiptText, /container-id-canary/u);
    assert.equal(receipt.outcome, "FAIL");
    assert.throws(
      () =>
        validateBrowserFailureReceipt(
          { ...receipt, childCandidateSha: parentCandidateSha },
          { parentContext, childContext },
        ),
      { code: "G15_BROWSER_FAILURE_RECEIPT_INVALID" },
    );
    await assert.rejects(
      persistBrowserFailureFromChild({
        error,
        parentContext,
        childContext,
        evidenceDir,
      }),
      { code: "EEXIST" },
    );

    const invalidIdentityError = Object.assign(new Error("child exited"), {
      result: {
        code: 1,
        signal: null,
        stdout: `${JSON.stringify({
          ...diagnostic,
          candidateSha: parentCandidateSha,
        })}\n`,
        joined: true,
      },
    });
    assert.equal(
      await persistBrowserFailureFromChild({
        error: invalidIdentityError,
        parentContext,
        childContext,
        evidenceDir: join(tempRoot, "missing-evidence"),
      }),
      undefined,
    );

    const invalidError = Object.assign(new Error("child exited"), {
      result: {
        code: 1,
        signal: null,
        stdout: `${JSON.stringify({
          ...diagnostic,
          operationDiagnostic: {
            ...diagnostic.operationDiagnostic,
            rawMessage: canary,
          },
        })}\n`,
        joined: true,
      },
    });
    assert.equal(
      await persistBrowserFailureFromChild({
        error: invalidError,
        parentContext,
        childContext,
        evidenceDir: join(tempRoot, "missing-evidence"),
      }),
      undefined,
    );
    assert.equal(
      JSON.parse(await readFile(persisted.path, "utf8")).outcome,
      "FAIL",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

void test("G15 child preparation builds ignored modules before importing the Compose entrypoint", async (t) => {
  const childRoot = await mkdtemp(join(tmpdir(), "g15-child-module-load-"));
  const bin = join(childRoot, "bin");
  const oldPath = process.env.PATH;
  const commandLog = join(childRoot, "pnpm-commands.log");
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    delete process.env.G15_PNPM_COMMAND_LOG;
    await rm(childRoot, { recursive: true, force: true });
  });
  await mkdir(join(childRoot, "tools"), { recursive: true });
  await mkdir(join(childRoot, "config"));
  const platformConfigPath = join(childRoot, "config/platform.yaml");
  await writeFile(platformConfigPath, "synthetic config\n");
  await chmod(platformConfigPath, 0o664);
  await mkdir(join(childRoot, "secrets"));
  const secretBundlePath = join(
    childRoot,
    "secrets/platform.secrets.sops.yaml",
  );
  await writeFile(secretBundlePath, "synthetic encrypted bundle\n");
  await chmod(secretBundlePath, 0o660);
  await mkdir(bin);
  await writeFile(
    join(childRoot, "tools/compose-smoke.mjs"),
    "import { built } from '../packages/platform-database/dist/index.js';\nif (!built) throw new Error('missing build');\n",
  );
  await writeFile(
    join(bin, "pnpm"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$G15_PNPM_COMMAND_LOG"\nif [ "$1" = exec ]; then mkdir -p packages/platform-database/dist; printf \'export const built = true;\\n\' > packages/platform-database/dist/index.js; fi\n',
  );
  await chmod(join(bin, "pnpm"), 0o700);
  process.env.G15_PNPM_COMMAND_LOG = commandLog;
  process.env.PATH = `${bin}:${oldPath ?? ""}`;

  await prepareBrowserChildCheckout(childRoot);
  assert.equal((await lstat(platformConfigPath)).mode & 0o777, 0o644);
  assert.equal((await lstat(secretBundlePath)).mode & 0o777, 0o400);

  assert.equal(
    await readFile(commandLog, "utf8"),
    "install --offline --frozen-lockfile\nexec tsc -b --pretty false\n",
  );
});

void test("G15 evidence validator rejects extra fields and incomplete checks", () => {
  const withExtraField = { ...validEvidence(), rawRequest: "must not persist" };
  assert.throws(
    () =>
      validateBrowserEvidence(withExtraField, {
        runId: RUN_ID,
        candidateSha: CANDIDATE_SHA,
      }),
    /G15_BROWSER_EVIDENCE_SCHEMA_INVALID/u,
  );

  const missingCheck = validEvidence();
  delete missingCheck.checks.logoutAndActorSwitch;
  assert.throws(
    () =>
      validateBrowserEvidence(missingCheck, {
        runId: RUN_ID,
        candidateSha: CANDIDATE_SHA,
      }),
    /G15_BROWSER_EVIDENCE_INCOMPLETE/u,
  );

  const failedCheck = validEvidence();
  failedCheck.checks.optimisticConflict = { passed: false };
  assert.throws(
    () =>
      validateBrowserEvidence(failedCheck, {
        runId: RUN_ID,
        candidateSha: CANDIDATE_SHA,
      }),
    /G15_BROWSER_EVIDENCE_INCOMPLETE/u,
  );

  const leakedOwnerEvidence = validEvidence();
  leakedOwnerEvidence.owners.customer.resourceRef = "cus_private_reference";
  assert.throws(
    () =>
      validateBrowserEvidence(leakedOwnerEvidence, {
        runId: RUN_ID,
        candidateSha: CANDIDATE_SHA,
      }),
    /G15_BROWSER_EVIDENCE_OWNER_INVALID/u,
  );
});

void test("G15 owner proof rejects altered config, hashes, transport and cleanup", () => {
  const hashes = {
    positive: "1".repeat(64),
    "private-eof": "2".repeat(64),
    reauth: "3".repeat(64),
  };
  assert.deepEqual(validateOwnerBrowserProofHashes(hashes), [
    "positive",
    "private-eof",
    "reauth",
  ]);
  const missing = {
    positive: hashes.positive,
    "private-eof": hashes["private-eof"],
  };
  assert.throws(() => validateOwnerBrowserProofHashes(missing));
  assert.throws(() =>
    validateOwnerBrowserProofHashes({ ...hashes, reauth: "invalid" }),
  );
  const identity = {
    schemaVersion: 1,
    runId: RUN_ID,
    candidateSha: CANDIDATE_SHA,
    baseConfigSha256: "a".repeat(64),
  };
  const lineage = "b".repeat(64);
  const compiled = {
    "apps/realtime-gateway/dist/runtime-composition.js": "c".repeat(64),
  };
  const sources = { "package.json": "d".repeat(64) };
  const manifest = {
    launchIdentity: identity,
    configSha256: identity.baseConfigSha256,
    lineageReceiptSha256: lineage,
    runId: "proof-run",
    compiled,
    sources,
  };
  const cleanup = {
    verified: true,
    network: { created: true, removed: true, name: "proof-run-net" },
    owner: { removed: true },
    syntheticPrivateMaterialRemoved: true,
    receipts: [
      "kafka",
      "idp",
      "edge-gateway",
      "api-public",
      "realtime-gateway",
      "edge-nginx",
      "driver",
    ].map((role) => ({ role, removed: true, logsCaptured: true })),
  };
  const proof = {
    verified: true,
    scenario: "positive",
    launchProof: false,
    sourceIntegrity: { before: sources, after: sources, unchanged: true },
    compiledIntegrity: { before: compiled, after: compiled, unchanged: true },
  };
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const build = (m = manifest, c = cleanup, p = proof) => {
    const receipt = {
      launchIdentity: identity,
      manifest: JSON.stringify(m),
      cleanup: JSON.stringify(c),
      proof: JSON.stringify(p),
      externalCleanup: { verified: true, databases: { verified: true } },
    };
    for (const key of ["manifest", "cleanup", "proof"])
      receipt[`${key}Sha256`] = digest(receipt[key]);
    return receipt;
  };
  assert.ok(
    validateOwnerBrowserReceipt(build(), "positive", identity, lineage),
  );
  for (const receipt of [
    build({ ...manifest, configSha256: "e".repeat(64) }),
    build({ ...manifest, lineageReceiptSha256: "e".repeat(64) }),
    build(manifest, { ...cleanup, receipts: cleanup.receipts.slice(1) }),
    build(manifest, cleanup, {
      ...proof,
      compiledIntegrity: {
        ...proof.compiledIntegrity,
        after: {
          ...compiled,
          "apps/realtime-gateway/dist/runtime-composition.js": "e".repeat(64),
        },
      },
    }),
    { ...build(), proofSha256: "e".repeat(64) },
    {
      ...build(),
      externalCleanup: { verified: false, databases: { verified: true } },
    },
  ])
    assert.throws(() =>
      validateOwnerBrowserReceipt(receipt, "positive", identity, lineage),
    );
  assert.throws(() =>
    validateOwnerBrowserReceipt(build(), "reauth", identity, lineage),
  );
});
