import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { startBrowser } from "./browser-driver.mjs";

const requireWebDependency = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { AxeBuilder } = requireWebDependency("@axe-core/playwright");

const IDENTITY = Object.freeze({
  actorRef: "actor:g15-browser-fixture",
  restrictedActorRef: "actor:g15-browser-restricted",
  origin: "https://localhost:8443",
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REF = Object.freeze({
  customer: /^cus_[0-9A-HJKMNP-TV-Z]{26}$/u,
  order: /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u,
  item: /^itm_[0-9A-HJKMNP-TV-Z]{26}$/u,
});
export const BROWSER_REQUIRED_CHECKS = Object.freeze([
  "oidcLogin",
  "servedAssets",
  "customerLostResponseReplay",
  "ownerRestartReadOnlyReplay",
  "draftReplayAfterNewCard",
  "quoteLostResponseReplay",
  "draftItemPutAndEdit",
  "draftItemDelete",
  "sameOrderStaleReplay",
  "inProgressReplay",
  "notRetainedReplay",
  "lookupUnavailableReplay",
  "sseRefetch",
  "naturalSseReauthentication",
  "optimisticConflict",
  "deepLinkReload",
  "apiFallback",
  "assetFallback",
  "accessibility",
  "logoutAndActorSwitch",
  "restrictedPermissionDenied",
  "noConfirmOrReconcile",
]);
const CHECK_DETAIL_KEYS = Object.freeze({
  oidcLogin: ["authenticatedSession", "servedIngress"],
  servedAssets: ["scriptCount", "stylesheetCount"],
  customerLostResponseReplay: [
    "responseDroppedAtEdge",
    "completedReplayReadOnly",
    "pendingMetadataPiiFree",
    "replayStatus",
    "replayed",
  ],
  ownerRestartReadOnlyReplay: [
    "restartVerified",
    "sameIntentKeyRetained",
    "replayStatus",
    "replayed",
    "ownerEffectsStable",
  ],
  draftReplayAfterNewCard: [
    "secondCardCreatedFirst",
    "olderDraftReplayed",
    "olderCardDifferentFromNewCard",
    "replayStatus",
    "replayed",
  ],
  quoteLostResponseReplay: [
    "completedReplayReadOnly",
    "quoteSnapshotStable",
    "replayStatus",
    "replayed",
  ],
  draftItemPutAndEdit: [
    "createPutCompleted",
    "editPutCompleted",
    "createPutStatus",
    "editPutStatus",
    "itemCount",
  ],
  draftItemDelete: ["completed", "deleteStatus", "deletedItemCount"],
  sameOrderStaleReplay: [
    "staleGetCancelledOrIgnored",
    "historicalReplayStatus",
    "historicalReplayUsed",
    "sameOrderVerified",
    "projectionAdvanced",
    "olderReplayDidNotDowngrade",
    "ownerEffectsStable",
  ],
  inProgressReplay: ["status", "problemCode", "keyRetained", "state"],
  notRetainedReplay: [
    "absent",
    "keySha256",
    "status",
    "problemCode",
    "keyRetained",
  ],
  lookupUnavailableReplay: [
    "status",
    "problemCode",
    "restoreVerified",
    "keyRetained",
  ],
  sseRefetch: [
    "readyEvents",
    "invalidations",
    "ownerRefetches",
    "invalidationObserved",
    "sameOrderRefetched",
    "projectionCaughtUp",
  ],
  naturalSseReauthentication: [
    "authCloseCountDelta",
    "eventSourceResponseDelta",
    "streamReadyDelta",
    "lastEventIdResumed",
    "sameActor",
    "sessionCookieStable",
    "ownerRefetchAfterReady",
    "within120Seconds",
  ],
  optimisticConflict: ["status", "ownerStateUnchanged", "staleVersionRejected"],
  deepLinkReload: ["directRouteLoaded", "reloadFetchedOwner"],
  apiFallback: ["status", "jsonResponse", "indexHtml"],
  assetFallback: [
    "missingStatus",
    "missingReturnedIndex",
    "servedScriptCount",
    "servedStylesheetCount",
  ],
  accessibility: ["customer", "order"],
  logoutAndActorSwitch: [
    "logoutStatus",
    "sessionCookieCleared",
    "pendingIntentsCleared",
    "restrictedAccountSelected",
  ],
  restrictedPermissionDenied: [
    "customerReadStatus",
    "customerCreateStatus",
    "ownerWriteAbsent",
    "businessBefore",
    "businessAfter",
    "businessUnchanged",
    "keySha256",
  ],
  noConfirmOrReconcile: ["forbiddenMutationRequests"],
});
const OPERATION = Object.freeze({
  "customer.create": Object.freeze({
    method: "POST",
    path: "/api/client-v1/customers",
  }),
  "orders.draft.create": Object.freeze({
    method: "POST",
    path: "/api/client-v1/orders/drafts",
  }),
  "pricing.quote.create": Object.freeze({
    method: "POST",
    path: "/api/client-v1/pricing/quotes",
  }),
});
const STORAGE_PREFIX = "coffee-platform:intent:v1:";
const INTENT_KEYS = Object.freeze([
  "actorRef",
  "createdAt",
  "fingerprint",
  "key",
  "kind",
  "method",
  "path",
  "state",
  "version",
]);

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, keys, code) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .join("\0") !==
      [...keys].sort((left, right) => left.localeCompare(right)).join("\0")
  )
    fail(code);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateOwnerSummary(summary, tableNames) {
  exactKeys(
    summary,
    [
      "state",
      "idempotencyRows",
      "resourceSha256",
      "tableCounts",
      "businessDigest",
    ],
    "G15_BROWSER_EVIDENCE_OWNER_INVALID",
  );
  if (
    summary.state !== "Completed" ||
    summary.idempotencyRows !== 1 ||
    !/^[0-9a-f]{64}$/u.test(summary.resourceSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(summary.businessDigest ?? "")
  )
    fail("G15_BROWSER_EVIDENCE_OWNER_INVALID");
  exactKeys(
    summary.tableCounts,
    tableNames,
    "G15_BROWSER_EVIDENCE_OWNER_INVALID",
  );
  if (Object.values(summary.tableCounts).some((count) => !safeCount(count)))
    fail("G15_BROWSER_EVIDENCE_OWNER_INVALID");
}

function validateCheck(name, check) {
  const details = CHECK_DETAIL_KEYS[name];
  if (!details) fail("G15_BROWSER_EVIDENCE_INCOMPLETE");
  exactKeys(
    check,
    ["passed", ...details],
    "G15_BROWSER_EVIDENCE_CHECK_INVALID",
  );
  if (check.passed !== true) fail("G15_BROWSER_EVIDENCE_INCOMPLETE");
  for (const [key, value] of Object.entries(check)) {
    if (key === "passed") continue;
    if (name === "accessibility") {
      exactKeys(
        value,
        ["violations", "seriousOrCritical"],
        "G15_BROWSER_EVIDENCE_CHECK_INVALID",
      );
      if (!safeCount(value.violations) || value.seriousOrCritical !== 0)
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "problemCode") {
      if (
        value !== "IDEMPOTENCY_REQUEST_IN_PROGRESS" &&
        value !== "IDEMPOTENCY_RESULT_NOT_RETAINED" &&
        value !== "IDEMPOTENCY_LOOKUP_UNAVAILABLE"
      )
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "state") {
      if (value !== "Acquired") fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "keySha256") {
      if (!/^[0-9a-f]{64}$/u.test(value ?? ""))
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "status" && name === "inProgressReplay") {
      if (value !== 409) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "status" && name === "notRetainedReplay") {
      if (value !== 410) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "status" && name === "lookupUnavailableReplay") {
      if (value !== 503) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "status" && name === "optimisticConflict") {
      if (value !== 409) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (
      key === "historicalReplayStatus" &&
      name === "sameOrderStaleReplay"
    ) {
      if (value !== 200) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (
      key === "authCloseCountDelta" &&
      name === "naturalSseReauthentication"
    ) {
      if (value !== 1) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (
      [
        "replayStatus",
        "createPutStatus",
        "editPutStatus",
        "deleteStatus",
      ].includes(key)
    ) {
      if (value !== 200 && value !== 201)
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
      if (key === "replayStatus" && value !== 201)
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
      if (key !== "replayStatus" && value !== 200)
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (
      key === "status" &&
      (name === "apiFallback" || name === "assetFallback")
    ) {
      if (value !== 404) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "missingStatus") {
      if (value !== 404) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "logoutStatus") {
      if (value !== 204) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "customerReadStatus" || key === "customerCreateStatus") {
      if (value !== 403) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "businessBefore" || key === "businessAfter") {
      exactKeys(
        value,
        ["tableCounts", "businessDigest"],
        "G15_BROWSER_EVIDENCE_CHECK_INVALID",
      );
      exactKeys(
        value.tableCounts,
        ["customers", "addresses", "channelLinks", "audit"],
        "G15_BROWSER_EVIDENCE_CHECK_INVALID",
      );
      if (
        Object.values(value.tableCounts).some((count) => !safeCount(count)) ||
        !/^[0-9a-f]{64}$/u.test(value.businessDigest ?? "")
      )
        fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (typeof value === "number") {
      if (!safeCount(value)) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (key === "indexHtml" || key === "missingReturnedIndex") {
      if (value !== false) fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (typeof value !== "boolean") {
      fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    } else if (value !== true) {
      fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
    }
  }
  if (
    (name === "servedAssets" &&
      (check.scriptCount < 1 || check.stylesheetCount < 1)) ||
    (name === "draftItemPutAndEdit" && check.itemCount < 1) ||
    (name === "draftItemDelete" && check.deletedItemCount !== 0) ||
    (name === "sseRefetch" &&
      (check.readyEvents < 1 ||
        check.invalidations < 1 ||
        check.ownerRefetches < 1 ||
        check.invalidationObserved !== true ||
        check.sameOrderRefetched !== true ||
        check.projectionCaughtUp !== true)) ||
    (name === "sameOrderStaleReplay" &&
      (check.staleGetCancelledOrIgnored !== true ||
        check.historicalReplayUsed !== true ||
        check.sameOrderVerified !== true ||
        check.projectionAdvanced !== true ||
        check.olderReplayDidNotDowngrade !== true ||
        check.ownerEffectsStable !== true)) ||
    (name === "naturalSseReauthentication" &&
      (check.authCloseCountDelta !== 1 ||
        check.eventSourceResponseDelta !== 1 ||
        check.streamReadyDelta !== 1 ||
        check.lastEventIdResumed !== true ||
        check.sameActor !== true ||
        check.sessionCookieStable !== true ||
        check.ownerRefetchAfterReady !== true ||
        check.within120Seconds !== true)) ||
    (name === "assetFallback" &&
      (check.servedScriptCount < 1 || check.servedStylesheetCount < 1)) ||
    (name === "noConfirmOrReconcile" && check.forbiddenMutationRequests !== 0)
  )
    fail("G15_BROWSER_EVIDENCE_CHECK_INVALID");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeFailure(error) {
  const code = error instanceof Error ? error.message : "";
  return /^G15_[A-Z0-9_]{1,96}$/u.test(code)
    ? code
    : "G15_BROWSER_PROOF_FAILED";
}

function headerValue(headers, name) {
  const entry = Object.entries(headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function requestUrl(request) {
  return new URL(
    typeof request?.url === "function" ? request.url() : request?.url,
  );
}

function expectedPath(operation, refs = {}) {
  if (OPERATION[operation]) return OPERATION[operation].path;
  if (
    (operation === "orders.item.put" || operation === "orders.item.delete") &&
    REF.order.test(refs.orderRef ?? "") &&
    REF.item.test(refs.itemRef ?? "")
  )
    return `/api/client-v1/orders/${refs.orderRef}/items/${refs.itemRef}`;
  return null;
}

export function matchesBrowserMutation({ url, method }, operation, refs = {}) {
  try {
    const parsed = new URL(url);
    const path = expectedPath(operation, refs);
    const expectedMethod =
      OPERATION[operation]?.method ??
      (operation === "orders.item.put"
        ? "PUT"
        : operation === "orders.item.delete"
          ? "DELETE"
          : null);
    return (
      parsed.origin === IDENTITY.origin &&
      parsed.pathname === path &&
      parsed.search === "" &&
      parsed.hash === "" &&
      method === expectedMethod
    );
  } catch {
    return false;
  }
}

export function validateBrowserEvidence(evidence, { runId, candidateSha }) {
  const requiredKeys = [
    "schemaVersion",
    "runId",
    "candidateSha",
    "status",
    "verificationOnly",
    "productionLogin",
    "checks",
    "owners",
    "browser",
  ];
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join("\0") !==
      [...requiredKeys].sort().join("\0")
  )
    fail("G15_BROWSER_EVIDENCE_SCHEMA_INVALID");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.runId !== runId ||
    evidence.candidateSha !== candidateSha ||
    evidence.status !== "passed" ||
    evidence.verificationOnly !== true ||
    evidence.productionLogin !== false
  )
    fail("G15_BROWSER_EVIDENCE_IDENTITY_INVALID");
  if (
    evidence.checks === null ||
    typeof evidence.checks !== "object" ||
    Array.isArray(evidence.checks) ||
    Object.keys(evidence.checks).sort().join("\0") !==
      [...BROWSER_REQUIRED_CHECKS].sort().join("\0") ||
    Object.values(evidence.checks).some((check) => check?.passed !== true)
  )
    fail("G15_BROWSER_EVIDENCE_INCOMPLETE");
  for (const [name, check] of Object.entries(evidence.checks))
    validateCheck(name, check);
  exactKeys(
    evidence.owners,
    ["customer", "orders", "pricing"],
    "G15_BROWSER_EVIDENCE_OWNER_INVALID",
  );
  validateOwnerSummary(evidence.owners.customer, [
    "customers",
    "addresses",
    "audit",
  ]);
  validateOwnerSummary(evidence.owners.pricing, [
    "quotes",
    "quoteLines",
    "audit",
  ]);
  exactKeys(
    evidence.owners.orders,
    ["draft", "put", "delete"],
    "G15_BROWSER_EVIDENCE_OWNER_INVALID",
  );
  validateOwnerSummary(evidence.owners.orders.draft, [
    "orders",
    "items",
    "history",
    "outbox",
  ]);
  validateOwnerSummary(evidence.owners.orders.put, [
    "orders",
    "item",
    "history",
    "outbox",
  ]);
  validateOwnerSummary(evidence.owners.orders.delete, [
    "orders",
    "item",
    "history",
    "outbox",
  ]);
  exactKeys(
    evidence.browser,
    [
      "driverStatus",
      "imageIdSha256",
      "networkIdSha256",
      "cleanup",
      "browserContexts",
      "eventSourceResponses",
    ],
    "G15_BROWSER_EVIDENCE_BROWSER_INVALID",
  );
  if (
    evidence.browser.driverStatus !== "READY" ||
    !/^[0-9a-f]{64}$/u.test(evidence.browser.imageIdSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidence.browser.networkIdSha256 ?? "") ||
    evidence.browser.cleanup !== "EXACT_OWNED_CONTAINER_REMOVED" ||
    evidence.browser.browserContexts !== 1 ||
    !safeCount(evidence.browser.eventSourceResponses) ||
    evidence.browser.eventSourceResponses < 1
  )
    fail("G15_BROWSER_EVIDENCE_BROWSER_INVALID");
  return evidence;
}

export function validateBrowserRuntimeArtifact(
  artifact,
  { runId, candidateSha, baseConfigSha256, lineage },
) {
  exactKeys(
    artifact,
    [
      "schemaVersion",
      "gateId",
      "runId",
      "candidateSha",
      "baseConfigSha256",
      "status",
      "verificationOnly",
      "productionLogin",
      "lineage",
      "browserEvidence",
      "cleanup",
    ],
    "G15_BROWSER_ARTIFACT_SCHEMA_INVALID",
  );
  if (
    artifact.schemaVersion !== 1 ||
    artifact.gateId !== "browser" ||
    artifact.runId !== runId ||
    artifact.candidateSha !== candidateSha ||
    artifact.baseConfigSha256 !== baseConfigSha256 ||
    artifact.status !== "PASS" ||
    artifact.verificationOnly !== true ||
    artifact.productionLogin !== false
  )
    fail("G15_BROWSER_ARTIFACT_IDENTITY_INVALID");
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage))
    fail("G15_BROWSER_ARTIFACT_LINEAGE_INVALID");
  const expectedLineage = { ...lineage };
  delete expectedLineage.receiptPath;
  if (!isDeepStrictEqual(artifact.lineage, expectedLineage))
    fail("G15_BROWSER_ARTIFACT_LINEAGE_INVALID");
  validateBrowserEvidence(artifact.browserEvidence, {
    runId,
    candidateSha,
  });
  const cleanup = artifact.cleanup;
  exactKeys(
    cleanup,
    [
      "verified",
      "complete",
      "failures",
      "retainedResources",
      "inventory",
      "fixtureRootRemoved",
      "secretsDirRemoved",
      "composeOverrideRemoved",
    ],
    "G15_BROWSER_ARTIFACT_CLEANUP_INVALID",
  );
  if (
    cleanup.verified !== true ||
    cleanup.complete !== true ||
    cleanup.fixtureRootRemoved !== true ||
    cleanup.secretsDirRemoved !== true ||
    cleanup.composeOverrideRemoved !== true ||
    !Array.isArray(cleanup.failures) ||
    cleanup.failures.length !== 0 ||
    !Array.isArray(cleanup.retainedResources) ||
    cleanup.retainedResources.length !== 0
  )
    fail("G15_BROWSER_ARTIFACT_CLEANUP_INVALID");
  exactKeys(
    cleanup.inventory,
    ["containers", "volumes", "networks"],
    "G15_BROWSER_ARTIFACT_CLEANUP_INVALID",
  );
  if (
    Object.values(cleanup.inventory).some(
      (resources) => !Array.isArray(resources) || resources.length !== 0,
    )
  )
    fail("G15_BROWSER_ARTIFACT_CLEANUP_INVALID");
  return artifact;
}

function pageRequestPath(request) {
  try {
    return requestUrl(request).pathname;
  } catch {
    return "";
  }
}

export function hasOrderRealtimeRefetch(
  invalidations,
  reads,
  orderRef,
  baselineSequence,
) {
  if (
    !REF.order.test(orderRef ?? "") ||
    !Number.isSafeInteger(baselineSequence)
  )
    return false;
  return invalidations.some((invalidation) => {
    if (
      invalidation?.orderRef !== orderRef ||
      !Number.isSafeInteger(invalidation.sequence) ||
      invalidation.sequence <= baselineSequence ||
      !/^\d{1,19}$/u.test(invalidation.ownerVersion ?? "")
    )
      return false;
    let ownerVersion;
    try {
      ownerVersion = BigInt(invalidation.ownerVersion);
    } catch {
      return false;
    }
    return reads.some((read) => {
      if (
        read?.orderRef !== orderRef ||
        read.invalidationSequence !== invalidation.sequence ||
        !Number.isSafeInteger(read.requestSequence) ||
        read.requestSequence <= invalidation.sequence ||
        read.status !== 200 ||
        read.responseOrderRef !== orderRef ||
        !/^\d{1,19}$/u.test(read.projectionVersion ?? "")
      )
        return false;
      try {
        return BigInt(read.projectionVersion) >= ownerVersion;
      } catch {
        return false;
      }
    });
  });
}

export function hasOrderRefetchAfterReady(
  reads,
  readySequence,
  orderRef,
  minimumProjectionVersion,
) {
  if (
    !REF.order.test(orderRef ?? "") ||
    !Number.isSafeInteger(readySequence) ||
    !/^\d{1,19}$/u.test(minimumProjectionVersion ?? "")
  )
    return false;
  let minimumVersion;
  try {
    minimumVersion = BigInt(minimumProjectionVersion);
  } catch {
    return false;
  }
  return reads.some((read) => {
    if (
      read?.orderRef !== orderRef ||
      read.responseOrderRef !== orderRef ||
      read.status !== 200 ||
      !Number.isSafeInteger(read.requestSequence) ||
      read.requestSequence <= readySequence ||
      read.readySequence !== readySequence ||
      !/^\d{1,19}$/u.test(read.projectionVersion ?? "")
    )
      return false;
    try {
      return BigInt(read.projectionVersion) >= minimumVersion;
    } catch {
      return false;
    }
  });
}

export function hasReadForRequest(
  reads,
  requestId,
  orderRef,
  projectionVersion,
) {
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    !REF.order.test(orderRef ?? "") ||
    !/^\d{1,19}$/u.test(projectionVersion ?? "")
  )
    return false;
  return reads.some(
    (read) =>
      read?.requestId === requestId &&
      read.orderRef === orderRef &&
      read.responseOrderRef === orderRef &&
      read.status === 200 &&
      read.projectionVersion === projectionVersion,
  );
}

export function parseRealtimeAuthCloseMetric(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65536)
    return null;
  const samples = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("coffee_realtime_auth_close_total"));
  if (samples.length !== 1) return null;
  const match = /^coffee_realtime_auth_close_total ([0-9]+)$/u.exec(samples[0]);
  if (!match) return null;
  const value = Number(match[1]);
  return safeCount(value) ? value : null;
}

export function expectedBrowserCompletedResponse(operation, method, status) {
  const expectedStatus =
    method === "POST" &&
    ["customer.create", "orders.draft.create", "pricing.quote.create"].includes(
      operation,
    )
      ? 201
      : operation === "orders.item.put" && method === "PUT"
        ? 200
        : null;
  return expectedStatus !== null && status === expectedStatus;
}

export function buildRealtimeAuthCloseInvocation(containerId) {
  if (!/^[0-9a-f]{64}$/u.test(containerId ?? ""))
    fail("G15_REALTIME_AUTH_CONTAINER_INVALID");
  const script = `import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import {readFileSync} from "node:fs";
import {request} from "node:https";
const runtimeRequire=createRequire(createRequire("/app/package.json").resolve("@coffee-platform/runtime"));
const {load}=await import(pathToFileURL(runtimeRequire.resolve("js-yaml")).href);
const {parseServiceTransportMaterial,verifyTransportPeer}=await import(pathToFileURL(runtimeRequire.resolve("@coffee-platform/security")).href);
const fail=()=>{process.exitCode=1;};
try {
  const runtime="realtime-gateway";
  const secretPath=process.env.COFFEE_RUNTIME_SECRETS_FILE;
  const port=Number(process.env.PORT);
  if(typeof secretPath!=="string"||!Number.isInteger(port)||port<1)throw new Error();
  const document=load(readFileSync(secretPath,"utf8"),{json:true});
  const environment=document?.environment;
  const source=document?.secrets?.security?.serviceTransportKeys?.[runtime];
  const material=parseServiceTransportMaterial(source,environment,runtime);
  const text=await new Promise((resolve,reject)=>{
    const requestValue=request({host:"127.0.0.1",port,path:"/metrics",method:"GET",ca:material.caPem,cert:material.certPem,key:material.keyPem,minVersion:"TLSv1.3",rejectUnauthorized:true,timeout:2500,checkServerIdentity:(_hostname,certificate)=>{
      try{verifyTransportPeer(certificate,environment,runtime);return undefined;}catch{return new Error("transport peer identity is invalid");}
    }},(response)=>{
      const chunks=[];let length=0;
      response.on("data",(chunk)=>{length+=chunk.length;if(length>65536)requestValue.destroy(new Error("metrics response exceeded bound"));else chunks.push(chunk);});
      response.once("end",()=>response.statusCode===200?resolve(Buffer.concat(chunks).toString("utf8")):reject(new Error("metrics status invalid")));
    });
    requestValue.once("timeout",()=>requestValue.destroy(new Error("metrics timeout")));
    requestValue.once("error",reject);requestValue.end();
  });
  const samples=text.split(/\\r?\\n/u).filter((line)=>line.startsWith("coffee_realtime_auth_close_total"));
  if(samples.length!==1)throw new Error();
  const match=/^coffee_realtime_auth_close_total ([0-9]+)$/u.exec(samples[0]);
  const count=Number(match?.[1]);
  if(!Number.isSafeInteger(count)||count<0)throw new Error();
  process.stdout.write(String(count)+"\\n");
}catch{fail();}`;
  return Object.freeze({
    args: Object.freeze([
      "exec",
      containerId,
      "node",
      "--input-type=module",
      "-e",
      script,
    ]),
  });
}

export function createBrowserNetworkMonitor(cdp, page) {
  const monitor = {
    eventSourceReady: 0,
    invalidations: 0,
    eventSourceResponses: 0,
    orderGets: 0,
    scripts: 0,
    stylesheets: 0,
    forbiddenMutations: 0,
    sequence: 0,
    lastReadySequence: 0,
    latestEventId: null,
    invalidationRecords: [],
    readyRecords: [],
    eventSourceRecords: [],
    failedRequests: new Map(),
    reads: [],
  };
  const requests = new Map();
  const eventSourceRequests = new Map();
  cdp.on("Network.responseReceived", (event) => {
    const eventSource = eventSourceRequests.get(event.requestId);
    if (eventSource) {
      eventSource.status = event.response.status;
      if (event.response.status === 200) monitor.eventSourceResponses += 1;
    }
    if (event.type === "Script" && event.response.status === 200)
      monitor.scripts += 1;
    if (event.type === "Stylesheet" && event.response.status === 200)
      monitor.stylesheets += 1;
  });
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    if (
      typeof event.eventId === "string" &&
      /^msg_[0-9A-HJKMNP-TV-Z]{26}$/u.test(event.eventId)
    )
      monitor.latestEventId = event.eventId;
    if (event.eventName === "stream-ready.v1") {
      monitor.eventSourceReady += 1;
      monitor.sequence += 1;
      monitor.lastReadySequence = monitor.sequence;
      const current = [...monitor.eventSourceRecords]
        .reverse()
        .find(
          (record) => record.status === 200 && record.readySequence === null,
        );
      if (current) current.readySequence = monitor.sequence;
      monitor.readyRecords.push({
        sequence: monitor.sequence,
        at: Date.now(),
        eventSourceRequestSequence: current?.requestSequence ?? null,
      });
    }
    if (event.eventName === "resource-invalidated.v1") {
      monitor.sequence += 1;
      try {
        const data = JSON.parse(event.data);
        if (
          data !== null &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          Object.keys(data)
            .sort((left, right) => left.localeCompare(right))
            .join("\0") ===
            [
              "correlationId",
              "ownerVersion",
              "reason",
              "subjectRef",
              "subjectType",
            ]
              .sort((left, right) => left.localeCompare(right))
              .join("\0") &&
          data?.subjectType === "order" &&
          REF.order.test(data.subjectRef ?? "") &&
          /^\d{1,19}$/u.test(data.ownerVersion ?? "") &&
          ["OrderChanged", "AromaStateChanged"].includes(data.reason) &&
          UUID.test(data.correlationId ?? "")
        ) {
          monitor.invalidations += 1;
          monitor.invalidationRecords.push({
            orderRef: data.subjectRef,
            ownerVersion: data.ownerVersion,
            sequence: monitor.sequence,
          });
        }
      } catch {
        // Invalidations without the complete canonical metadata cannot prove a refetch.
      }
    }
  });
  cdp.on("Network.requestWillBeSent", (event) => {
    let parsed;
    try {
      parsed = new URL(event.request.url);
    } catch {
      return;
    }
    if (
      parsed.origin === IDENTITY.origin &&
      parsed.pathname === "/events" &&
      event.request.method === "GET"
    ) {
      monitor.sequence += 1;
      const eventSource = {
        requestSequence: monitor.sequence,
        lastEventId:
          headerValue(event.request.headers, "last-event-id") ?? null,
        latestEventIdAtRequest: monitor.latestEventId,
        status: null,
        readySequence: null,
      };
      eventSourceRequests.set(event.requestId, eventSource);
      monitor.eventSourceRecords.push(eventSource);
    }
    const match =
      parsed.origin === IDENTITY.origin &&
      event.request.method === "GET" &&
      /^\/api\/client-v1\/orders\/(ord_[0-9A-HJKMNP-TV-Z]{26})$/u.exec(
        parsed.pathname,
      );
    if (!match) return;
    monitor.sequence += 1;
    const orderRef = match[1];
    const invalidation = [...monitor.invalidationRecords]
      .reverse()
      .find((record) => record.orderRef === orderRef);
    requests.set(event.requestId, {
      orderRef,
      requestSequence: monitor.sequence,
      invalidationSequence: invalidation?.sequence ?? null,
      readySequence: monitor.lastReadySequence,
      status: null,
    });
  });
  cdp.on("Network.responseReceived", (event) => {
    const request = requests.get(event.requestId);
    if (request) request.status = event.response.status;
  });
  cdp.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    requests.delete(event.requestId);
    void cdp
      .send("Network.getResponseBody", { requestId: event.requestId })
      .then(({ body, base64Encoded }) => {
        const text = base64Encoded
          ? Buffer.from(body, "base64").toString("utf8")
          : body;
        const value = JSON.parse(text);
        if (
          value?.orderRef !== request.orderRef ||
          !/^\d{1,19}$/u.test(value.projectionVersion ?? "")
        )
          return;
        monitor.reads.push({
          requestId: event.requestId,
          orderRef: request.orderRef,
          requestSequence: request.requestSequence,
          invalidationSequence: request.invalidationSequence,
          readySequence: request.readySequence,
          status: request.status,
          responseOrderRef: value.orderRef,
          projectionVersion: value.projectionVersion,
        });
      })
      .catch(() => {});
  });
  cdp.on("Network.loadingFailed", (event) => {
    monitor.failedRequests.set(event.requestId, {
      canceled:
        event.canceled === true || event.errorText === "net::ERR_ABORTED",
    });
  });
  const attachedPages = new WeakSet();
  monitor.attachPage = (targetPage) => {
    if (attachedPages.has(targetPage)) return;
    attachedPages.add(targetPage);
    targetPage.on("request", (request) => {
      const path = pageRequestPath(request);
      if (
        request.method() === "GET" &&
        /^\/api\/client-v1\/orders\/ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(path)
      )
        monitor.orderGets += 1;
      if (/\/commands\/(?:confirm|request-aroma-reconciliation)$/u.test(path))
        monitor.forbiddenMutations += 1;
    });
  };
  monitor.attachPage(page);
  return monitor;
}

export function createG14BrowserNetworkMonitor(cdp) {
  const streams = new Map();
  const requests = new Map();
  const result = { sequence: 0, commands: [], frames: [], reads: [] };
  cdp.on("Network.requestWillBeSent", (event) => {
    let url;
    try {
      url = new URL(event.request.url);
    } catch {
      return;
    }
    if (url.origin !== IDENTITY.origin || url.search || url.hash) return;
    const sequence = ++result.sequence;
    if (url.pathname === "/events" && event.request.method === "GET") {
      streams.set(event.requestId, { status: null });
      return;
    }
    const command =
      /^\/api\/client-v1\/orders\/(ord_[0-9A-HJKMNP-TV-Z]{26})\/commands\/(confirm|request-aroma-reconciliation)$/u.exec(
        url.pathname,
      );
    if (command) {
      result.commands.push({
        orderRef: command[1],
        kind: command[2],
        method: event.request.method,
        correlationId: headerValue(event.request.headers, "x-correlation-id"),
        sequence,
      });
      return;
    }
    const order =
      /^\/api\/client-v1\/orders\/(ord_[0-9A-HJKMNP-TV-Z]{26})$/u.exec(
        url.pathname,
      );
    if (order && event.request.method === "GET")
      requests.set(event.requestId, {
        orderRef: order[1],
        correlationId: headerValue(event.request.headers, "x-correlation-id"),
        sequence,
        status: null,
      });
  });
  cdp.on("Network.responseReceived", (event) => {
    const stream = streams.get(event.requestId);
    if (stream) stream.status = event.response.status;
    const request = requests.get(event.requestId);
    if (request) request.status = event.response.status;
  });
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    if (
      streams.get(event.requestId)?.status !== 200 ||
      event.eventName !== "resource-invalidated.v1" ||
      !/^msg_[0-9A-HJKMNP-TV-Z]{26}$/u.test(event.eventId ?? "")
    )
      return;
    try {
      const data = JSON.parse(event.data);
      exactKeys(
        data,
        [
          "subjectType",
          "subjectRef",
          "ownerVersion",
          "reason",
          "correlationId",
        ],
        "G14_FRAME_INVALID",
      );
      if (
        data.subjectType !== "order" ||
        !REF.order.test(data.subjectRef ?? "") ||
        !/^[1-9]\d{0,18}$/u.test(data.ownerVersion ?? "") ||
        !["OrderChanged", "AromaStateChanged"].includes(data.reason) ||
        !UUID.test(data.correlationId ?? "")
      )
        return;
      result.frames.push({
        orderRef: data.subjectRef,
        ownerVersion: data.ownerVersion,
        correlationId: data.correlationId,
        frameId: event.eventId,
        sequence: ++result.sequence,
      });
    } catch {
      /* Invalid frames cannot prove the chain. */
    }
  });
  cdp.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    requests.delete(event.requestId);
    void cdp
      .send("Network.getResponseBody", { requestId: event.requestId })
      .then(({ body, base64Encoded }) => {
        const data = JSON.parse(
          base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body,
        );
        if (
          data.orderRef === request.orderRef &&
          /^[1-9]\d{0,18}$/u.test(data.projectionVersion ?? "")
        )
          result.reads.push({
            ...request,
            projectionVersion: data.projectionVersion,
          });
      })
      .catch(() => {});
  });
  return result;
}

export function matchG14BrowserChain(
  monitor,
  orderRef,
  telemetry,
  excludedFrames = new Set(),
  confirmedVersion = "0",
) {
  if (!REF.order.test(orderRef ?? "") || monitor.commands.length !== 1)
    return undefined;
  const command = monitor.commands[0];
  if (
    command.orderRef !== orderRef ||
    command.kind !== "confirm" ||
    command.method !== "POST" ||
    !UUID.test(command.correlationId ?? "")
  )
    return undefined;
  const correlatedReads = monitor.reads.filter(
    (read) =>
      read.orderRef === orderRef &&
      read.correlationId === command.correlationId &&
      read.status === 200,
  );
  const correlatedTelemetry = telemetry.filter(
    (item) =>
      item.name === "ui.query.result" &&
      item.correlationId === command.correlationId &&
      item.endpoint === "/api/client-v1/orders/:ref" &&
      item.result === "http:200",
  );
  if (correlatedTelemetry.length === 0) return undefined;
  for (const frame of monitor.frames) {
    if (
      excludedFrames.has(frame.frameId) ||
      frame.orderRef !== orderRef ||
      frame.correlationId !== command.correlationId ||
      frame.sequence <= command.sequence
    )
      continue;
    const read = correlatedReads.find(
      (item) =>
        item.sequence > frame.sequence &&
        !monitor.frames.some(
          (later) =>
            later.orderRef === orderRef &&
            later.sequence > frame.sequence &&
            later.sequence < item.sequence,
        ) &&
        BigInt(item.projectionVersion) >= BigInt(frame.ownerVersion) &&
        BigInt(item.projectionVersion) > BigInt(confirmedVersion),
    );
    if (read) return { command, frame, read };
  }
  return undefined;
}

export function isG14AcceptedProjection(
  acceptedVersion,
  readVersion,
  confirmedVersion,
) {
  return (
    BigInt(acceptedVersion) >= BigInt(readVersion) &&
    BigInt(readVersion) > BigInt(confirmedVersion)
  );
}

export function validateG14BrowserEvidence(
  evidence,
  { runId, candidateSha, configSha256 },
) {
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "purpose",
      "runId",
      "candidateSha",
      "configSha256",
      "status",
      "correlationId",
      "ownerMessageSha256",
      "realtimeMessageSha256",
      "ownerVersion",
      "ownerTraceparent",
      "realtimeTraceparent",
      "traceId",
      "confirmedVersion",
      "acceptedVersion",
      "confirmCount",
      "reconcileCount",
      "providerIsolated",
      "mutationsEnabled",
      "traceStatus",
      "browserCleanup",
    ],
    "G14_BROWSER_EVIDENCE_SCHEMA_INVALID",
  );
  if (
    evidence.schemaVersion !== 1 ||
    evidence.purpose !== "G14_BROWSER_CORRELATION" ||
    evidence.runId !== runId ||
    evidence.candidateSha !== candidateSha ||
    evidence.configSha256 !== configSha256 ||
    evidence.status !== "PASS" ||
    !UUID.test(evidence.correlationId ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidence.ownerMessageSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidence.realtimeMessageSha256 ?? "") ||
    !/^[1-9]\d{0,18}$/u.test(evidence.ownerVersion ?? "") ||
    !/^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u.test(
      evidence.ownerTraceparent ?? "",
    ) ||
    evidence.realtimeTraceparent !== evidence.ownerTraceparent ||
    evidence.traceId !== evidence.ownerTraceparent.slice(3, 35) ||
    !/^[1-9]\d{0,18}$/u.test(evidence.confirmedVersion ?? "") ||
    !/^[1-9]\d{0,18}$/u.test(evidence.acceptedVersion ?? "") ||
    BigInt(evidence.acceptedVersion) < BigInt(evidence.ownerVersion) ||
    BigInt(evidence.acceptedVersion) <= BigInt(evidence.confirmedVersion) ||
    evidence.confirmCount !== 1 ||
    evidence.reconcileCount !== 0 ||
    evidence.providerIsolated !== true ||
    evidence.mutationsEnabled !== false ||
    evidence.traceStatus !== "NOT_PROVEN" ||
    evidence.browserCleanup !== "EXACT_OWNED_CONTAINER_REMOVED"
  )
    fail("G14_BROWSER_EVIDENCE_INVALID");
  return evidence;
}

export async function proveG14Browser(runtimeContext) {
  if (
    !runtimeContext ||
    typeof runtimeContext.attestG14Safety !== "function" ||
    typeof runtimeContext.g14OrderEvidence !== "function" ||
    typeof runtimeContext.throwIfStopRequested !== "function" ||
    !/^[0-9a-f]{40}$/u.test(runtimeContext.candidateSha ?? "") ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runtimeContext.runId ?? "") ||
    !/^[0-9a-f]{64}$/u.test(runtimeContext.configSha256 ?? "")
  )
    fail("G14_BROWSER_CONTEXT_INVALID");
  const driver = await startBrowser(runtimeContext);
  let context;
  let cdp;
  let cleanup;
  let evidence;
  try {
    context = await driver.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript(() => {
      const events = [];
      Object.defineProperty(window, "__g14Telemetry", { value: events });
      window.addEventListener("coffee:browser-telemetry", (event) => {
        const { name, correlationId, endpoint, result } = event.detail;
        events.push({ name, correlationId, endpoint, result });
      });
    });
    const observedCommands = [];
    context.on("page", (targetPage) => {
      targetPage.on("request", (request) => {
        if (
          /\/commands\/(?:confirm|request-aroma-reconciliation)$/u.test(
            pageRequestPath(request),
          )
        )
          observedCommands.push(request);
      });
    });
    const page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    const monitor = createG14BrowserNetworkMonitor(cdp);
    const login = page.waitForResponse(
      (response) =>
        responseMatches(response, "/auth/session", "GET") &&
        response.status() === 200,
      { timeout: 30000 },
    );
    await page.goto(
      `${IDENTITY.origin}/auth/login?returnTo=${encodeURIComponent("/app/customers")}`,
      { waitUntil: "domcontentloaded" },
    );
    await login;
    await page.getByText(IDENTITY.actorRef, { exact: true }).waitFor();
    const { dialog } = await createCustomerForm(
      page,
      randomUUID().slice(0, 12),
    );
    await dialog.getByRole("button", { name: "Создать и выбрать" }).click();
    await page.getByRole("button", { name: "Создать черновик" }).click();
    await page.waitForURL(/\/app\/orders\/ord_[0-9A-HJKMNP-TV-Z]{26}$/u);
    const orderRef = new URL(page.url()).pathname.split("/").at(-1);
    if (!REF.order.test(orderRef ?? "")) fail("G14_BROWSER_ORDER_INVALID");
    await page.getByRole("link", { name: "Открыть каталог" }).click();
    await page
      .getByRole("textbox", { name: "Название товара" })
      .fill("Капучино");
    await page.getByRole("button", { name: "Найти" }).click();
    const product = page.locator("article.product-card").filter({
      has: page.getByRole("heading", { name: "Капучино", exact: true }),
    });
    await product
      .getByRole("textbox", { name: "Количество для Капучино" })
      .fill("2");
    await product.getByRole("button", { name: "Добавить" }).click();
    await page.getByRole("link", { name: "К заказу" }).click();
    await page.getByRole("button", { name: "Подтвердить заказ" }).click();
    runtimeContext.throwIfStopRequested();
    const safety = await runtimeContext.attestG14Safety();
    assert.deepEqual(safety, {
      configSha256: runtimeContext.configSha256,
      mutationsEnabled: false,
      providerIsolated: true,
    });
    const confirmation = page.waitForResponse(
      (response) =>
        responseMatches(
          response,
          `/api/client-v1/orders/${orderRef}/commands/confirm`,
          "POST",
        ),
      { timeout: 30000 },
    );
    await page
      .getByRole("dialog", { name: "Подтвердить заказ?" })
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    const confirmedResponse = await confirmation;
    assert.equal(confirmedResponse.status(), 200);
    const confirmed = await confirmedResponse.json();
    if (
      confirmed.orderRef !== orderRef ||
      confirmed.status !== "Confirmed" ||
      !/^[1-9]\d{0,18}$/u.test(confirmed.projectionVersion ?? "")
    )
      fail("G14_BROWSER_CONFIRM_INVALID");
    const deadline = Date.now() + 30000;
    let matched;
    let owner;
    while (Date.now() < deadline && !owner) {
      runtimeContext.throwIfStopRequested();
      const telemetry = await page.evaluate(() => window.__g14Telemetry);
      const excludedFrames = new Set();
      while (
        (matched = matchG14BrowserChain(
          monitor,
          orderRef,
          telemetry,
          excludedFrames,
          confirmed.projectionVersion,
        ))
      ) {
        try {
          owner = await runtimeContext.g14OrderEvidence({
            orderRef,
            correlationId: matched.command.correlationId,
            frameId: matched.frame.frameId,
            ownerVersion: matched.frame.ownerVersion,
          });
          break;
        } catch (error) {
          if (error?.message !== "G14_OWNER_CHAIN_NOT_PROVEN") throw error;
          excludedFrames.add(matched.frame.frameId);
        }
      }
      if (!owner) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!matched || !owner) fail("G14_BROWSER_CHAIN_NOT_PROVEN");
    const acceptedVersion = await visibleOrderProjectionVersion(page, orderRef);
    if (
      !isG14AcceptedProjection(
        acceptedVersion,
        matched.read.projectionVersion,
        confirmed.projectionVersion,
      )
    )
      fail("G14_BROWSER_VERSION_NOT_ACCEPTED");
    if (
      monitor.commands.length !== 1 ||
      observedCommands.length !== 1 ||
      observedCommands[0].method() !== "POST" ||
      requestUrl(observedCommands[0]).origin !== IDENTITY.origin ||
      pageRequestPath(observedCommands[0]) !==
        `/api/client-v1/orders/${orderRef}/commands/confirm`
    )
      fail("G14_BROWSER_EXTRA_COMMAND");
    evidence = {
      schemaVersion: 1,
      purpose: "G14_BROWSER_CORRELATION",
      runId: runtimeContext.runId,
      candidateSha: runtimeContext.candidateSha,
      configSha256: safety.configSha256,
      status: "PASS",
      correlationId: matched.command.correlationId,
      ...owner,
      confirmedVersion: confirmed.projectionVersion,
      acceptedVersion,
      confirmCount: 1,
      reconcileCount: 0,
      providerIsolated: true,
      mutationsEnabled: false,
      traceStatus: "NOT_PROVEN",
      browserCleanup: null,
    };
  } finally {
    let cleanupError;
    try {
      await cdp?.detach();
    } catch {
      cleanupError = true;
    }
    try {
      await context?.close();
    } catch {
      cleanupError = true;
    }
    try {
      cleanup = await driver.close();
    } catch {
      cleanupError = true;
    }
    if (cleanupError || cleanup !== "EXACT_OWNED_CONTAINER_REMOVED")
      fail("G14_BROWSER_CLEANUP_UNCONFIRMED");
  }
  evidence.browserCleanup = cleanup;
  return validateG14BrowserEvidence(evidence, {
    runId: runtimeContext.runId,
    candidateSha: runtimeContext.candidateSha,
    configSha256: runtimeContext.configSha256,
  });
}

function waitFor(predicate, code, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(code));
      setTimeout(poll, 50);
    };
    poll();
  });
}

function waitForAsync(
  predicate,
  code,
  timeoutMs = 20000,
  intervalMs = 250,
  shouldStop = () => {},
) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        shouldStop();
      } catch (error) {
        reject(error);
        return;
      }
      try {
        if (await predicate()) return resolve();
        if (Date.now() - started >= timeoutMs) return reject(new Error(code));
        setTimeout(poll, intervalMs);
      } catch {
        reject(new Error(code));
      }
    };
    void poll();
  });
}

async function sessionCookieValue(browserContext) {
  const cookies = await browserContext.cookies(IDENTITY.origin);
  const sessionCookies = cookies.filter(
    (cookie) => cookie.name === "__Host-coffee-session",
  );
  assert.equal(sessionCookies.length, 1);
  assert.ok(sessionCookies[0].value.length > 0);
  return sessionCookies[0].value;
}

async function visibleOrderProjectionVersion(page, orderRef) {
  const description = page.getByText(
    new RegExp(`^Заказ ${orderRef} · версия представления ([0-9]{1,19})$`, "u"),
  );
  await description.waitFor({ timeout: 15000 });
  const text = await description.textContent();
  const match =
    /^Заказ ord_[0-9A-HJKMNP-TV-Z]{26} · версия представления ([0-9]{1,19})$/u.exec(
      text ?? "",
    );
  if (!match) fail("G15_BROWSER_ORDER_VERSION_UNAVAILABLE");
  return match[1];
}

function responseMatches(response, path, method, replayOnly = false) {
  try {
    if (response.request().method() !== method) return false;
    const url = requestUrl(response.request());
    if (url.origin !== IDENTITY.origin || url.pathname !== path) return false;
    return (
      !replayOnly ||
      headerValue(response.request().headers(), "idempotency-replay-only") ===
        "true"
    );
  } catch {
    return false;
  }
}

async function problemCode(response) {
  try {
    const value = await response.json();
    return typeof value?.code === "string" ? value.code : null;
  } catch {
    return null;
  }
}

function snapshotSummary(snapshot) {
  return Object.freeze({
    state: snapshot.state,
    idempotencyRows: snapshot.idempotencyRows,
    resourceSha256: snapshot.resourceSha256,
    tableCounts: { ...snapshot.tableCounts },
    businessDigest: snapshot.businessDigest,
  });
}

async function completedSnapshot(ownerEvidence, operation, key, refs) {
  const snapshot = await ownerEvidence.snapshot({
    operation,
    idempotencyKey: key,
    ...refs,
  });
  assert.equal(snapshot.state, "Completed");
  assert.equal(snapshot.idempotencyRows, 1);
  assert.match(snapshot.keySha256, /^[0-9a-f]{64}$/u);
  assert.match(snapshot.businessDigest, /^[0-9a-f]{64}$/u);
  return snapshot;
}

async function readPendingIntent(page, { method, path, sensitiveValues = [] }) {
  return page.evaluate(
    ({ prefix, expectedMethod, expectedPath, sensitive }) => {
      const intents = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const storageKey = sessionStorage.key(index);
        if (!storageKey?.startsWith(prefix)) continue;
        try {
          const value = JSON.parse(
            sessionStorage.getItem(storageKey) ?? "null",
          );
          if (value?.method === expectedMethod && value?.path === expectedPath)
            intents.push({
              value,
              storageKeyMatches: storageKey === `${prefix}${value.key}`,
              piiFound: sensitive.some((needle) =>
                JSON.stringify(value).includes(needle),
              ),
            });
        } catch {
          return { invalid: true };
        }
      }
      if (intents.length !== 1) return { invalid: true };
      const [{ value, storageKeyMatches, piiFound }] = intents;
      return {
        actorRef: value.actorRef,
        createdAt: value.createdAt,
        fingerprint: value.fingerprint,
        key: value.key,
        kind: value.kind,
        method: value.method,
        path: value.path,
        state: value.state,
        version: value.version,
        storageKeyMatches,
        piiFound,
        exactKeys:
          Object.keys(value).sort().join("\0") ===
          [...INTENT_KEYS].sort().join("\0"),
      };
    },
    {
      prefix: STORAGE_PREFIX,
      expectedMethod: method,
      expectedPath: path,
      sensitive: sensitiveValues,
    },
  );
}

function assertSafeIntent(intent, method, path) {
  assert.equal(intent.invalid, undefined);
  assert.equal(intent.actorRef, IDENTITY.actorRef);
  assert.equal(intent.createdAt.length > 0, true);
  assert.match(intent.fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(intent.key, UUID);
  assert.equal(intent.method, method);
  assert.equal(intent.path, path);
  assert.equal(intent.state, "ambiguous");
  assert.equal(intent.version, 1);
  assert.equal(intent.storageKeyMatches, true);
  assert.equal(intent.piiFound, false);
  assert.equal(intent.exactKeys, true);
}

function keyFromPausedRequest(request) {
  const key = headerValue(request.headers, "idempotency-key");
  if (!UUID.test(key ?? "")) fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
  return key;
}

async function armFetchFault(cdp, { origin, path, method, stage, onTarget }) {
  let settled = false;
  let resolveTarget;
  let rejectTarget;
  const target = new Promise((resolve, reject) => {
    resolveTarget = resolve;
    rejectTarget = reject;
  });
  const eventName = "Fetch.requestPaused";
  const handler = async (event) => {
    let matches = false;
    try {
      const url = new URL(event.request.url);
      matches =
        url.origin === origin &&
        url.pathname === path &&
        url.search === "" &&
        event.request.method === method;
    } catch {
      matches = false;
    }
    if (!matches) {
      try {
        if (stage === "Response")
          await cdp.send("Fetch.continueResponse", {
            requestId: event.requestId,
          });
        else
          await cdp.send("Fetch.continueRequest", {
            requestId: event.requestId,
          });
      } catch {
        if (!settled) {
          settled = true;
          rejectTarget(new Error("G15_BROWSER_FAULT_CONTINUE_FAILED"));
        }
      }
      return;
    }
    if (settled) {
      try {
        if (stage === "Response")
          await cdp.send("Fetch.continueResponse", {
            requestId: event.requestId,
          });
        else
          await cdp.send("Fetch.continueRequest", {
            requestId: event.requestId,
          });
      } catch {
        // The first exact target remains the sole admitted fault.
      }
      return;
    }
    settled = true;
    try {
      const result = await onTarget(event);
      if (stage === "Response")
        await cdp.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Failed",
        });
      else
        await cdp.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Failed",
        });
      resolveTarget({ ...result, requestId: event.requestId });
    } catch {
      try {
        await cdp.send("Fetch.failRequest", {
          requestId: event.requestId,
          errorReason: "Failed",
        });
      } catch {
        // Preserve a finite producer failure.
      }
      rejectTarget(new Error("G15_BROWSER_FAULT_TARGET_FAILED"));
    }
  };
  cdp.on(eventName, handler);
  try {
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: `${origin}${path}`, requestStage: stage }],
    });
  } catch {
    cdp.removeListener(eventName, handler);
    fail("G15_BROWSER_FAULT_ENABLE_FAILED");
  }
  return Object.freeze({
    target,
    async stop() {
      cdp.removeListener(eventName, handler);
      try {
        await cdp.send("Fetch.disable");
      } catch {
        fail("G15_BROWSER_FAULT_DISABLE_FAILED");
      }
    },
  });
}

async function armCompletedResponseLoss({
  page,
  cdp,
  ownerEvidence,
  operation,
  path,
  refs,
  method = "POST",
  action,
}) {
  const fault = await armFetchFault(cdp, {
    origin: IDENTITY.origin,
    path,
    method,
    stage: "Response",
    async onTarget(event) {
      if (
        !expectedBrowserCompletedResponse(
          operation,
          method,
          event.responseStatusCode,
        )
      )
        fail("G15_BROWSER_COMPLETED_RESPONSE_STATUS_INVALID");
      const key = keyFromPausedRequest(event.request);
      const before = await completedSnapshot(
        ownerEvidence,
        operation,
        key,
        refs,
      );
      return { key, before };
    },
  });
  try {
    await action();
    const captured = await withTimeout(
      fault.target,
      "G15_BROWSER_RESPONSE_FAULT_TIMEOUT",
    );
    await page
      .getByText("Исход команды неизвестен")
      .waitFor({ timeout: 15000 });
    const intent = await readPendingIntent(page, { method, path });
    assertSafeIntent(intent, method, path);
    assert.equal(intent.key, captured.key);
    return { ...captured, intent };
  } finally {
    await fault.stop();
  }
}

async function holdNextOrderGetResponse(cdp, orderRef) {
  const path = `/api/client-v1/orders/${orderRef}`;
  let settled = false;
  let resolveTarget;
  let rejectTarget;
  const target = new Promise((resolve, reject) => {
    resolveTarget = resolve;
    rejectTarget = reject;
  });
  const handler = async (event) => {
    let parsed;
    try {
      parsed = new URL(event.request.url);
    } catch {
      return;
    }
    if (
      parsed.origin !== IDENTITY.origin ||
      parsed.pathname !== path ||
      event.request.method !== "GET" ||
      event.responseStatusCode !== 200
    ) {
      try {
        await cdp.send("Fetch.continueResponse", {
          requestId: event.requestId,
        });
      } catch {
        if (!settled) {
          settled = true;
          rejectTarget(new Error("G15_BROWSER_STALE_GET_CONTINUE_FAILED"));
        }
      }
      return;
    }
    if (settled) {
      try {
        await cdp.send("Fetch.continueResponse", {
          requestId: event.requestId,
        });
      } catch {
        // Only the first exact GET is deliberately held.
      }
      return;
    }
    settled = true;
    try {
      const payload = await cdp.send("Fetch.getResponseBody", {
        requestId: event.requestId,
      });
      const text = payload.base64Encoded
        ? Buffer.from(payload.body, "base64").toString("utf8")
        : payload.body;
      if (Buffer.byteLength(text, "utf8") > 65536)
        fail("G15_BROWSER_STALE_GET_BODY_INVALID");
      const body = JSON.parse(text);
      if (
        typeof event.networkId !== "string" ||
        event.networkId.length === 0 ||
        body?.orderRef !== orderRef ||
        !/^\d{1,19}$/u.test(body.projectionVersion ?? "")
      )
        fail("G15_BROWSER_STALE_GET_BODY_INVALID");
      resolveTarget({
        requestId: event.requestId,
        networkId: event.networkId,
        responseProjectionVersion: body.projectionVersion,
      });
    } catch {
      try {
        await cdp.send("Fetch.continueResponse", {
          requestId: event.requestId,
        });
      } catch {
        // Preserve the finite parsing failure.
      }
      rejectTarget(new Error("G15_BROWSER_STALE_GET_BODY_INVALID"));
    }
  };
  cdp.on("Fetch.requestPaused", handler);
  try {
    await cdp.send("Fetch.enable", {
      patterns: [
        { urlPattern: `${IDENTITY.origin}${path}`, requestStage: "Response" },
      ],
    });
  } catch {
    cdp.removeListener("Fetch.requestPaused", handler);
    fail("G15_BROWSER_STALE_GET_ENABLE_FAILED");
  }
  return Object.freeze({
    target,
    async release(networkId, monitor) {
      const failure = monitor.failedRequests.get(networkId);
      if (failure?.canceled) return "CANCELLED";
      try {
        await cdp.send("Fetch.continueResponse", {
          requestId: await target.then((value) => value.requestId),
        });
        return "RELEASED";
      } catch {
        await waitFor(
          () => monitor.failedRequests.has(networkId),
          "G15_BROWSER_STALE_GET_RELEASE_UNRESOLVED",
          5000,
        );
        return monitor.failedRequests.get(networkId)?.canceled
          ? "CANCELLED"
          : "FAILED";
      }
    },
    async stop() {
      cdp.removeListener("Fetch.requestPaused", handler);
      try {
        await cdp.send("Fetch.disable");
      } catch {
        fail("G15_BROWSER_STALE_GET_DISABLE_FAILED");
      }
    },
  });
}

async function armRequestAbort({ page, cdp, method, path, action }) {
  const fault = await armFetchFault(cdp, {
    origin: IDENTITY.origin,
    path,
    method,
    stage: "Request",
    onTarget(event) {
      return { key: keyFromPausedRequest(event.request) };
    },
  });
  try {
    await action();
    const captured = await withTimeout(
      fault.target,
      "G15_BROWSER_REQUEST_FAULT_TIMEOUT",
    );
    await page
      .getByText("Исход команды неизвестен")
      .waitFor({ timeout: 15000 });
    const intent = await readPendingIntent(page, { method, path });
    assertSafeIntent(intent, method, path);
    assert.equal(intent.key, captured.key);
    return { ...captured, intent };
  } finally {
    await fault.stop();
  }
}

function withTimeout(promise, code, timeoutMs = 20000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function replayFromUi(page, { path, method = "POST", expectedStatus }) {
  const responsePromise = page.waitForResponse(
    (response) => responseMatches(response, path, method, true),
    { timeout: 20000 },
  );
  await page
    .getByRole("button", { name: "Проверить результат команды" })
    .click();
  const response = await responsePromise;
  assert.equal(response.status(), expectedStatus);
  return {
    status: response.status(),
    problemCode: expectedStatus >= 400 ? await problemCode(response) : null,
    replayed:
      headerValue(response.headers(), "idempotency-replayed") === "true",
  };
}

async function createCustomerForm(page, suffix) {
  await page.getByRole("button", { name: "Новый клиент" }).click();
  const dialog = page.getByRole("dialog", { name: "Новый клиент" });
  await dialog
    .getByRole("textbox", { name: "Имя", exact: true })
    .fill(`G15 synthetic ${suffix}`);
  const syntheticEmail = `g15-${suffix}@example.invalid`;
  await dialog
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(syntheticEmail);
  return { dialog, syntheticEmail };
}

async function verifyPiiFreeIntent(page, path, email, name) {
  const intent = await readPendingIntent(page, {
    method: "POST",
    path,
    sensitiveValues: [email, name],
  });
  assertSafeIntent(intent, "POST", path);
  assert.equal(intent.piiFound, false);
  return intent;
}

async function replaySnapshotIsStable(
  ownerEvidence,
  operation,
  key,
  before,
  refs,
) {
  const after = await completedSnapshot(ownerEvidence, operation, key, refs);
  assert.equal(after.businessDigest, before.businessDigest);
  assert.equal(after.resourceSha256, before.resourceSha256);
  assert.deepEqual(after.tableCounts, before.tableCounts);
  return snapshotSummary(after);
}

function installResourceMonitor(cdp, page) {
  return createBrowserNetworkMonitor(cdp, page);
}

async function accessibilityPass(page) {
  const result = await new AxeBuilder({ page }).analyze();
  assert.equal(
    result.violations.some(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    ),
    false,
  );
  return {
    violations: result.violations.length,
    seriousOrCritical: 0,
  };
}

async function waitOrderRealtime(monitor, before) {
  await waitFor(
    () =>
      hasOrderRealtimeRefetch(
        monitor.invalidationRecords,
        monitor.reads,
        before.orderRef,
        before.sequence,
      ),
    "G15_BROWSER_SSE_REFETCH_TIMEOUT",
    30000,
  );
  return {
    invalidationObserved: true,
    sameOrderRefetched: true,
    projectionCaughtUp: true,
  };
}

export async function proveNaturalSseReauthentication({
  page,
  browserContext,
  monitor,
  runtimeContext,
  orderRef,
  itemRef,
  idempotencyKey,
}) {
  const baselineCount = await runtimeContext.readRealtimeAuthCloseCount();
  if (!safeCount(baselineCount)) fail("G15_BROWSER_AUTH_METRIC_INVALID");
  const baselineResponses = monitor.eventSourceResponses;
  const baselineReady = monitor.eventSourceReady;
  const baselineRequestSequence =
    monitor.eventSourceRecords.at(-1)?.requestSequence ?? 0;
  const cookieBefore = await sessionCookieValue(browserContext);
  const versionBefore = await visibleOrderProjectionVersion(page, orderRef);
  const businessBefore = await runtimeContext.ownerEvidence.snapshot({
    operation: "orders.item.put",
    idempotencyKey,
    orderRef,
    itemRef,
  });
  assert.equal(businessBefore.state, "Completed");
  const startedAt = Date.now();
  const shouldStop = () => {
    try {
      runtimeContext.throwIfStopRequested();
    } catch {
      fail("G15_BROWSER_STOP_REQUESTED");
    }
  };
  let observedCount = baselineCount;
  await waitForAsync(
    async () => {
      observedCount = await runtimeContext.readRealtimeAuthCloseCount();
      if (!safeCount(observedCount) || observedCount < baselineCount)
        fail("G15_BROWSER_AUTH_METRIC_INVALID");
      if (observedCount > baselineCount + 1)
        fail("G15_BROWSER_AUTH_CLOSE_COUNT_UNEXPECTED");
      return observedCount === baselineCount + 1;
    },
    "G15_BROWSER_AUTH_CLOSE_TIMEOUT",
    120000,
    2000,
    shouldStop,
  );
  await waitForAsync(
    () =>
      monitor.eventSourceResponses === baselineResponses + 1 &&
      monitor.eventSourceReady === baselineReady + 1 &&
      monitor.eventSourceRecords.some(
        (record) =>
          record.requestSequence > baselineRequestSequence &&
          record.status === 200 &&
          record.readySequence !== null,
      ),
    "G15_BROWSER_AUTH_RECONNECT_TIMEOUT",
    15000,
    250,
    shouldStop,
  );
  const reconnected = monitor.eventSourceRecords.find(
    (record) =>
      record.requestSequence > baselineRequestSequence &&
      record.status === 200 &&
      record.readySequence !== null,
  );
  assert.ok(reconnected);
  assert.ok(reconnected.lastEventId);
  assert.equal(reconnected.lastEventId, reconnected.latestEventIdAtRequest);
  const refetched = await waitForAsync(
    () =>
      hasOrderRefetchAfterReady(
        monitor.reads,
        reconnected.readySequence,
        orderRef,
        versionBefore,
      ),
    "G15_BROWSER_AUTH_OWNER_REFETCH_TIMEOUT",
    15000,
    250,
    shouldStop,
  ).then(() => true);
  assert.equal(refetched, true);
  await page.getByText(IDENTITY.actorRef, { exact: true }).waitFor();
  const cookieAfter = await sessionCookieValue(browserContext);
  assert.equal(cookieAfter, cookieBefore);
  assert.equal(
    await runtimeContext.readRealtimeAuthCloseCount(),
    baselineCount + 1,
  );
  const businessAfter = await runtimeContext.ownerEvidence.snapshot({
    operation: "orders.item.put",
    idempotencyKey,
    orderRef,
    itemRef,
  });
  assert.equal(businessAfter.businessDigest, businessBefore.businessDigest);
  assert.deepEqual(businessAfter.tableCounts, businessBefore.tableCounts);
  assert.equal(businessAfter.resourceSha256, businessBefore.resourceSha256);
  return {
    authCloseCountDelta: 1,
    eventSourceResponseDelta: monitor.eventSourceResponses - baselineResponses,
    streamReadyDelta: monitor.eventSourceReady - baselineReady,
    lastEventIdResumed: true,
    sameActor: true,
    sessionCookieStable: true,
    ownerRefetchAfterReady: true,
    within120Seconds: Date.now() - startedAt <= 120000,
  };
}

async function snapshotForAbsent(ownerEvidence, operation, key) {
  const result = await ownerEvidence.assertAbsent({
    operation,
    idempotencyKey: key,
  });
  assert.equal(result.absent, true);
  return { absent: true, keySha256: result.keySha256 };
}

async function abortedCustomerIntent(page, suffix) {
  await page.goto(`${IDENTITY.origin}/app/customers`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Клиенты" }).waitFor();
  const { dialog, syntheticEmail } = await createCustomerForm(page, suffix);
  const name = `G15 synthetic ${suffix}`;
  const path = OPERATION["customer.create"].path;
  const pageCdp = await page.context().newCDPSession(page);
  let aborted;
  try {
    aborted = await armRequestAbort({
      page,
      cdp: pageCdp,
      method: "POST",
      path,
      action: () =>
        dialog.getByRole("button", { name: "Создать и выбрать" }).click(),
    });
  } finally {
    await pageCdp.detach();
  }
  const intent = await verifyPiiFreeIntent(page, path, syntheticEmail, name);
  assert.equal(intent.key, aborted.key);
  return intent;
}

async function replayExpectedProblem(
  page,
  { path, expectedStatus, expectedCode },
) {
  const replay = await replayFromUi(page, {
    path,
    method: "POST",
    expectedStatus,
  });
  assert.equal(replay.problemCode, expectedCode);
  const intent = await readPendingIntent(page, { method: "POST", path });
  assert.equal(intent.key.length > 0, true);
  assert.equal(intent.state, "ambiguous");
  return {
    status: replay.status,
    problemCode: replay.problemCode,
    keyRetained: true,
  };
}

async function logoutAndRestrictedLogin(page, browserContext, idpHost) {
  await page.getByRole("button", { name: "Выйти" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Выйти из операторской платформы?",
  });
  const responsePromise = page.waitForResponse(
    (response) => responseMatches(response, "/auth/logout", "POST"),
    { timeout: 20000 },
  );
  await dialog.getByRole("button", { name: "Завершить сессию" }).click();
  const logout = await responsePromise;
  assert.equal(logout.status(), 204);
  await page
    .getByRole("link", { name: "Войти через защищённый контур" })
    .waitFor();
  const cookiesAfterLogout = await browserContext.cookies(IDENTITY.origin);
  assert.equal(
    cookiesAfterLogout.some(
      (cookie) => cookie.name === "__Host-coffee-session",
    ),
    false,
  );
  const pendingCountAfterLogout = await page.evaluate(
    (prefix) =>
      Object.keys(sessionStorage).filter((key) => key.startsWith(prefix))
        .length,
    STORAGE_PREFIX,
  );
  assert.equal(pendingCountAfterLogout, 0);
  await browserContext.clearCookies();
  await browserContext.addCookies([
    {
      name: "g15_fixture_account",
      value: "restricted",
      domain: idpHost,
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto(
    `${IDENTITY.origin}/auth/login?returnTo=${encodeURIComponent("/app/customers")}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByRole("heading", { name: "Клиенты" }).waitFor();
  await page.getByText(IDENTITY.restrictedActorRef, { exact: true }).waitFor();
  return {
    logoutStatus: logout.status(),
    sessionCookieCleared: true,
    pendingIntentsCleared: true,
    restrictedAccountSelected: true,
  };
}

export async function proveBrowser(runtimeContext) {
  if (
    !runtimeContext ||
    typeof runtimeContext.projectName !== "string" ||
    typeof runtimeContext.runId !== "string" ||
    !/^[0-9a-f]{40}$/u.test(runtimeContext.candidateSha ?? "") ||
    typeof runtimeContext.throwIfStopRequested !== "function" ||
    typeof runtimeContext.ownerEvidence?.snapshot !== "function" ||
    typeof runtimeContext.ownerEvidence?.assertAbsent !== "function" ||
    typeof runtimeContext.ownerEvidence?.seedInProgress !== "function" ||
    typeof runtimeContext.ownerEvidence?.withLookupUnavailable !== "function" ||
    typeof runtimeContext.readRealtimeAuthCloseCount !== "function" ||
    typeof runtimeContext.restartCustomerService !== "function"
  )
    fail("G15_BROWSER_RUNTIME_CONTEXT_INVALID");

  let driver;
  let browserContext;
  let cdp;
  let failure;
  let cleanupFailureCode;
  let proofResult;
  let driverClosed = false;
  const evidence = {
    schemaVersion: 1,
    runId: runtimeContext.runId,
    candidateSha: runtimeContext.candidateSha,
    status: "passed",
    verificationOnly: true,
    productionLogin: false,
    checks: {},
    owners: {},
    browser: {},
  };
  const setCheck = (name, details = {}) => {
    evidence.checks[name] = Object.freeze({ passed: true, ...details });
  };
  try {
    driver = await startBrowser(runtimeContext);
    browserContext = await driver.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await browserContext.newPage();
    cdp = await browserContext.newCDPSession(page);
    await cdp.send("Network.enable");
    const monitor = installResourceMonitor(cdp, page);
    browserContext.on("page", (targetPage) => monitor.attachPage(targetPage));
    const servedAssets = [];
    page.on("response", (response) => {
      try {
        const url = requestUrl(response.request());
        if (url.origin !== IDENTITY.origin) return;
        if (url.pathname.endsWith(".js") || url.pathname.endsWith(".mjs"))
          servedAssets.push({ type: "script", status: response.status() });
        if (url.pathname.endsWith(".css"))
          servedAssets.push({ type: "stylesheet", status: response.status() });
      } catch {
        // Ignore non-URL browser events; only bounded counts enter evidence.
      }
    });

    const loginResponse = page.waitForResponse(
      (response) =>
        responseMatches(response, "/auth/session", "GET") &&
        response.status() === 200,
      { timeout: 30000 },
    );
    await page.goto(
      `${IDENTITY.origin}/auth/login?returnTo=${encodeURIComponent("/app/customers")}`,
      { waitUntil: "domcontentloaded" },
    );
    const session = await loginResponse;
    assert.equal(session.status(), 200);
    await page.getByRole("heading", { name: "Клиенты" }).waitFor();
    await page.getByText(IDENTITY.actorRef, { exact: true }).waitFor();
    await waitFor(
      () => monitor.eventSourceReady > 0 && monitor.eventSourceResponses > 0,
      "G15_BROWSER_SSE_NOT_READY",
    );
    setCheck("oidcLogin", { authenticatedSession: true, servedIngress: true });
    const customerA11y = await accessibilityPass(page);

    const nameSuffix = randomUUID().slice(0, 12);
    const customerName = `G15 synthetic ${nameSuffix}`;
    const customerEmail = `g15-${nameSuffix}@example.invalid`;
    const { dialog: customerDialog } = await createCustomerForm(
      page,
      nameSuffix,
    );
    const customerLost = await armCompletedResponseLoss({
      page,
      cdp,
      ownerEvidence: runtimeContext.ownerEvidence,
      operation: "customer.create",
      path: OPERATION["customer.create"].path,
      action: () =>
        customerDialog
          .getByRole("button", { name: "Создать и выбрать" })
          .click(),
    });
    await verifyPiiFreeIntent(
      page,
      OPERATION["customer.create"].path,
      customerEmail,
      customerName,
    );
    const customerBeforeRestart = await runtimeContext.ownerEvidence.snapshot({
      operation: "customer.create",
      idempotencyKey: customerLost.key,
    });
    assert.equal(customerBeforeRestart.state, "Completed");
    assert.equal(await runtimeContext.restartCustomerService(), true);
    const customerAfterRestart = await runtimeContext.ownerEvidence.snapshot({
      operation: "customer.create",
      idempotencyKey: customerLost.key,
    });
    assert.equal(
      customerAfterRestart.businessDigest,
      customerBeforeRestart.businessDigest,
    );
    assert.deepEqual(
      customerAfterRestart.tableCounts,
      customerBeforeRestart.tableCounts,
    );
    assert.equal(
      customerAfterRestart.resourceSha256,
      customerBeforeRestart.resourceSha256,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .waitFor();
    const customerReplayResponse = page.waitForResponse(
      (response) =>
        responseMatches(
          response,
          OPERATION["customer.create"].path,
          "POST",
          true,
        ),
      { timeout: 30000 },
    );
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    const customerReplay = await customerReplayResponse;
    assert.equal(customerReplay.status(), 201);
    assert.equal(
      headerValue(customerReplay.request().headers(), "idempotency-key"),
      customerLost.key,
    );
    assert.equal(
      headerValue(customerReplay.headers(), "idempotency-replayed"),
      "true",
    );
    await page.getByRole("heading", { name: "Новый заказ" }).waitFor();
    const customerRef = new URL(page.url()).searchParams.get("customerRef");
    assert.match(customerRef ?? "", REF.customer);
    const customerAfter = await replaySnapshotIsStable(
      runtimeContext.ownerEvidence,
      "customer.create",
      customerLost.key,
      customerLost.before,
    );
    evidence.owners.customer = customerAfter;
    setCheck("ownerRestartReadOnlyReplay", {
      restartVerified: true,
      sameIntentKeyRetained:
        headerValue(customerReplay.request().headers(), "idempotency-key") ===
        customerLost.key,
      replayStatus: customerReplay.status(),
      replayed:
        headerValue(customerReplay.headers(), "idempotency-replayed") ===
        "true",
      ownerEffectsStable:
        customerAfter.businessDigest === customerBeforeRestart.businessDigest,
    });
    setCheck("customerLostResponseReplay", {
      responseDroppedAtEdge: true,
      completedReplayReadOnly: true,
      pendingMetadataPiiFree: true,
      replayStatus: customerReplay.status(),
      replayed:
        headerValue(customerReplay.headers(), "idempotency-replayed") ===
        "true",
    });

    const draftPath = OPERATION["orders.draft.create"].path;
    const draftLost = await armCompletedResponseLoss({
      page,
      cdp,
      ownerEvidence: runtimeContext.ownerEvidence,
      operation: "orders.draft.create",
      path: draftPath,
      action: () =>
        page.getByRole("button", { name: "Создать черновик" }).click(),
    });
    const secondCardPage = await browserContext.newPage();
    await secondCardPage.goto(
      `${IDENTITY.origin}/app/orders/new?customerRef=${encodeURIComponent(customerRef)}`,
      { waitUntil: "domcontentloaded" },
    );
    await secondCardPage
      .getByRole("button", { name: "Создать черновик" })
      .waitFor();
    const secondDraftResponse = secondCardPage.waitForResponse(
      (response) => responseMatches(response, draftPath, "POST"),
      { timeout: 30000 },
    );
    await secondCardPage
      .getByRole("button", { name: "Создать черновик" })
      .click();
    const secondDraft = await secondDraftResponse;
    assert.equal(secondDraft.status(), 201);
    await secondCardPage.waitForURL(
      /\/app\/orders\/ord_[0-9A-HJKMNP-TV-Z]{26}$/u,
    );
    const secondOrderRef = new URL(secondCardPage.url()).pathname
      .split("/")
      .at(-1);
    assert.match(secondOrderRef ?? "", REF.order);
    await secondCardPage.close();

    const draftReplayResponse = page.waitForResponse(
      (response) => responseMatches(response, draftPath, "POST", true),
      { timeout: 30000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .waitFor();
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    const draftReplay = await draftReplayResponse;
    assert.equal(draftReplay.status(), 201);
    assert.equal(
      headerValue(draftReplay.headers(), "idempotency-replayed"),
      "true",
    );
    await page.waitForURL(/\/app\/orders\/ord_[0-9A-HJKMNP-TV-Z]{26}$/u);
    const orderRef = new URL(page.url()).pathname.split("/").at(-1);
    assert.match(orderRef ?? "", REF.order);
    assert.notEqual(orderRef, secondOrderRef);
    const draftAfter = await replaySnapshotIsStable(
      runtimeContext.ownerEvidence,
      "orders.draft.create",
      draftLost.key,
      draftLost.before,
    );
    evidence.owners.orders = { draft: draftAfter };
    setCheck("draftReplayAfterNewCard", {
      secondCardCreatedFirst: true,
      olderDraftReplayed: true,
      olderCardDifferentFromNewCard: true,
      replayStatus: draftReplay.status(),
      replayed:
        headerValue(draftReplay.headers(), "idempotency-replayed") === "true",
    });

    await page.getByRole("link", { name: "Открыть каталог" }).click();
    await page.getByRole("heading", { name: "Поиск товаров" }).waitFor();
    await page
      .getByRole("textbox", { name: "Название товара" })
      .fill("Капучино");
    const catalogSearch = page.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.origin === IDENTITY.origin &&
          url.pathname === "/api/client-v1/catalog/products" &&
          response.status() === 200
        );
      },
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Найти" }).click();
    const catalogResponse = await catalogSearch;
    const catalog = await catalogResponse.json();
    assert.ok(
      catalog.items.some(
        (item) =>
          item.displayName === "Капучино" &&
          item.availability === "Available" &&
          item.mappingAvailable === true,
      ),
    );
    const productCard = page.locator("article.product-card").filter({
      has: page.getByRole("heading", { name: "Капучино", exact: true }),
    });
    await productCard.waitFor();
    await productCard
      .getByRole("textbox", { name: "Количество для Капучино" })
      .fill("2");
    const quotePath = OPERATION["pricing.quote.create"].path;
    const quoteLost = await armCompletedResponseLoss({
      page,
      cdp,
      ownerEvidence: runtimeContext.ownerEvidence,
      operation: "pricing.quote.create",
      path: quotePath,
      action: () =>
        productCard.getByRole("button", { name: "Добавить" }).click(),
    });
    const quoteReplayResponse = page.waitForResponse(
      (response) => responseMatches(response, quotePath, "POST", true),
      { timeout: 30000 },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .waitFor();
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    const quoteReplay = await quoteReplayResponse;
    assert.equal(quoteReplay.status(), 201);
    assert.equal(
      headerValue(quoteReplay.headers(), "idempotency-replayed"),
      "true",
    );
    await page.getByRole("heading", { name: "Результат найден" }).waitFor();
    const quoteAfter = await replaySnapshotIsStable(
      runtimeContext.ownerEvidence,
      "pricing.quote.create",
      quoteLost.key,
      quoteLost.before,
    );
    evidence.owners.pricing = quoteAfter;
    setCheck("quoteLostResponseReplay", {
      completedReplayReadOnly: true,
      quoteSnapshotStable: true,
      replayStatus: quoteReplay.status(),
      replayed:
        headerValue(quoteReplay.headers(), "idempotency-replayed") === "true",
    });

    const itemPathPattern = new RegExp(
      `^/api/client-v1/orders/${orderRef}/items/(itm_[0-9A-HJKMNP-TV-Z]{26})$`,
      "u",
    );
    const putResponsePromise = page.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.origin === IDENTITY.origin &&
          url.pathname.match(itemPathPattern) !== null &&
          response.request().method() === "PUT"
        );
      },
      { timeout: 30000 },
    );
    const productCardAfterReplay = page.locator("article.product-card").filter({
      has: page.getByRole("heading", { name: "Капучино", exact: true }),
    });
    await productCardAfterReplay
      .getByRole("button", { name: "Добавить" })
      .click();
    const putResponse = await putResponsePromise;
    assert.equal(putResponse.status(), 200);
    const putRequestUrl = requestUrl(putResponse.request());
    const itemMatch = itemPathPattern.exec(putRequestUrl.pathname);
    const itemRef = itemMatch?.[1];
    assert.match(itemRef ?? "", REF.item);
    const putKey = headerValue(
      putResponse.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(putKey ?? "")) fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const putSnapshot = await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      putKey,
      { orderRef, itemRef },
    );
    assert.ok(putSnapshot.tableCounts.item >= 1);
    await page.getByText("Товар добавлен").waitFor();
    await page.getByRole("link", { name: "К заказу" }).first().click();
    await page.getByRole("heading", { name: customerName }).waitFor();
    await page.locator(`[aria-label="Позиция заказа ${itemRef}"]`).waitFor();

    const stalePage = await browserContext.newPage();
    const staleCdp = await browserContext.newCDPSession(stalePage);
    await staleCdp.send("Network.enable");
    await stalePage.goto(`${IDENTITY.origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await stalePage.getByRole("heading", { name: customerName }).waitFor();
    const conflictFault = await armFetchFault(staleCdp, {
      origin: IDENTITY.origin,
      path: `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
      method: "PUT",
      stage: "Request",
      onTarget(event) {
        return { key: keyFromPausedRequest(event.request) };
      },
    });
    const staleItem = stalePage.locator(
      `[aria-label="Позиция заказа ${itemRef}"]`,
    );
    await staleItem
      .getByRole("textbox", { name: "Количество Капучино" })
      .fill("4");
    const staleUpdate = staleItem.getByRole("button", { name: "Обновить" });
    await staleUpdate.click();
    const stalePut = await withTimeout(
      conflictFault.target,
      "G15_BROWSER_CONFLICT_BARRIER_TIMEOUT",
    );
    await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      putKey,
      { orderRef, itemRef },
    );
    const currentItem = page.locator(
      `[aria-label="Позиция заказа ${itemRef}"]`,
    );
    await currentItem
      .getByRole("textbox", { name: "Количество Капучино" })
      .fill("3");
    const currentBeforeRealtime = {
      sequence: monitor.sequence,
      orderRef,
    };
    const currentPutResponse = page.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.pathname ===
            `/api/client-v1/orders/${orderRef}/items/${itemRef}` &&
          response.request().method() === "PUT"
        );
      },
      { timeout: 30000 },
    );
    await currentItem.getByRole("button", { name: "Обновить" }).click();
    const currentPut = await currentPutResponse;
    assert.equal(currentPut.status(), 200);
    const currentKey = headerValue(
      currentPut.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(currentKey ?? ""))
      fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const currentSnapshot = await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      currentKey,
      { orderRef, itemRef },
    );
    const realtimeResult = await waitOrderRealtime(
      monitor,
      currentBeforeRealtime,
    );
    await staleCdp.send("Fetch.continueRequest", {
      requestId: stalePut.requestId,
    });
    await conflictFault.stop();
    const conflictResponse = await stalePage.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.pathname ===
            `/api/client-v1/orders/${orderRef}/items/${itemRef}` &&
          response.request().method() === "PUT"
        );
      },
      { timeout: 30000 },
    );
    assert.equal(conflictResponse.status(), 409);
    assert.equal(await problemCode(conflictResponse), "ORDER_VERSION_CONFLICT");
    await stalePage
      .getByRole("dialog", { name: "Заказ изменился на сервере" })
      .waitFor();
    const afterConflict = await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      currentKey,
      { orderRef, itemRef },
    );
    assert.equal(afterConflict.businessDigest, currentSnapshot.businessDigest);
    evidence.owners.orders.put = snapshotSummary(currentSnapshot);
    setCheck("draftItemPutAndEdit", {
      createPutCompleted: true,
      editPutCompleted: true,
      createPutStatus: putResponse.status(),
      editPutStatus: currentPut.status(),
      itemCount: currentSnapshot.tableCounts.item,
    });
    setCheck("optimisticConflict", {
      status: conflictResponse.status(),
      ownerStateUnchanged: true,
      staleVersionRejected: true,
    });
    setCheck("sseRefetch", {
      readyEvents: monitor.eventSourceReady,
      invalidations: monitor.invalidations,
      ownerRefetches: monitor.orderGets,
      ...realtimeResult,
    });
    await staleCdp.detach();
    await stalePage.close();

    const staleVersion = await visibleOrderProjectionVersion(page, orderRef);
    const heldGet = await holdNextOrderGetResponse(cdp, orderRef);
    await page.getByRole("link", { name: "Открыть каталог" }).click();
    await page.getByRole("heading", { name: "Поиск товаров" }).waitFor();
    const heldGetResult = await withTimeout(
      heldGet.target,
      "G15_BROWSER_STALE_GET_NOT_STARTED",
      30000,
    );
    assert.equal(heldGetResult.responseProjectionVersion, staleVersion);
    await page.getByRole("link", { name: "К заказу" }).click();
    await page.getByRole("heading", { name: customerName }).waitFor();
    assert.equal(
      await visibleOrderProjectionVersion(page, orderRef),
      staleVersion,
    );
    const staleGetBaseline = { sequence: monitor.sequence, orderRef };
    const currentItemForStaleGet = page.locator(
      `[aria-label="Позиция заказа ${itemRef}"]`,
    );
    await currentItemForStaleGet
      .getByRole("textbox", { name: "Количество Капучино" })
      .fill("4");
    const staleGetWriteResponse = page.waitForResponse(
      (response) =>
        responseMatches(
          response,
          `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
          "PUT",
        ),
      { timeout: 30000 },
    );
    await currentItemForStaleGet
      .getByRole("button", { name: "Обновить" })
      .click();
    const staleGetWrite = await staleGetWriteResponse;
    assert.equal(staleGetWrite.status(), 200);
    const staleGetWriteKey = headerValue(
      staleGetWrite.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(staleGetWriteKey ?? ""))
      fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const staleGetWriteCard = await staleGetWrite.json();
    assert.equal(staleGetWriteCard.orderRef, orderRef);
    assert.ok(
      BigInt(staleGetWriteCard.projectionVersion) > BigInt(staleVersion),
    );
    await waitOrderRealtime(monitor, staleGetBaseline);
    const currentVersion = await visibleOrderProjectionVersion(page, orderRef);
    assert.equal(currentVersion, staleGetWriteCard.projectionVersion);
    let staleGetOutcome = await heldGet.release(
      heldGetResult.networkId,
      monitor,
    );
    if (staleGetOutcome === "RELEASED") {
      await waitFor(
        () =>
          hasReadForRequest(
            monitor.reads,
            heldGetResult.networkId,
            orderRef,
            staleVersion,
          ) || monitor.failedRequests.has(heldGetResult.networkId),
        "G15_BROWSER_STALE_GET_COMPLETION_UNRESOLVED",
        5000,
      );
      if (monitor.failedRequests.get(heldGetResult.networkId)?.canceled)
        staleGetOutcome = "CANCELLED";
    }
    assert.ok(["CANCELLED", "RELEASED"].includes(staleGetOutcome));
    assert.equal(
      await visibleOrderProjectionVersion(page, orderRef),
      currentVersion,
    );
    const staleGetAfter = await runtimeContext.ownerEvidence.snapshot({
      operation: "orders.item.put",
      idempotencyKey: staleGetWriteKey,
      orderRef,
      itemRef,
    });
    assert.equal(staleGetAfter.state, "Completed");
    await heldGet.stop();

    const replayPath = `/api/client-v1/orders/${orderRef}/items/${itemRef}`;
    const lostSameOrderPut = await armCompletedResponseLoss({
      page,
      cdp,
      ownerEvidence: runtimeContext.ownerEvidence,
      operation: "orders.item.put",
      path: replayPath,
      method: "PUT",
      refs: { orderRef, itemRef },
      action: async () => {
        const row = page.locator(`[aria-label="Позиция заказа ${itemRef}"]`);
        await row
          .getByRole("textbox", { name: "Количество Капучино" })
          .fill("5");
        await row.getByRole("button", { name: "Обновить" }).click();
      },
    });
    const newerPage = await browserContext.newPage();
    await newerPage.goto(`${IDENTITY.origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await newerPage.getByRole("heading", { name: customerName }).waitFor();
    const newerRow = newerPage.locator(
      `[aria-label="Позиция заказа ${itemRef}"]`,
    );
    await newerRow
      .getByRole("textbox", { name: "Количество Капучино" })
      .waitFor();
    await newerRow
      .getByRole("textbox", { name: "Количество Капучино" })
      .fill("6");
    const newerPutResponse = newerPage.waitForResponse(
      (response) => responseMatches(response, replayPath, "PUT"),
      { timeout: 30000 },
    );
    const newerBeforeRealtime = { sequence: monitor.sequence, orderRef };
    await newerRow.getByRole("button", { name: "Обновить" }).click();
    const newerPut = await newerPutResponse;
    assert.equal(newerPut.status(), 200);
    const newerPutKey = headerValue(
      newerPut.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(newerPutKey ?? ""))
      fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const newerCard = await newerPut.json();
    assert.equal(newerCard.orderRef, orderRef);
    assert.ok(BigInt(newerCard.projectionVersion) > BigInt(currentVersion));
    const newerSnapshot = await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      newerPutKey,
      { orderRef, itemRef },
    );
    await waitOrderRealtime(monitor, newerBeforeRealtime);
    await newerPage.close();

    const historicalBefore = await runtimeContext.ownerEvidence.snapshot({
      operation: "orders.item.put",
      idempotencyKey: lostSameOrderPut.key,
      orderRef,
      itemRef,
    });
    assert.equal(historicalBefore.state, "Completed");
    const historicalResponse = page.waitForResponse(
      (response) => responseMatches(response, replayPath, "PUT", true),
      { timeout: 30000 },
    );
    await page
      .getByRole("button", { name: "Проверить результат команды" })
      .click();
    const historicalReplay = await historicalResponse;
    assert.equal(historicalReplay.status(), 200);
    assert.equal(
      headerValue(historicalReplay.headers(), "idempotency-replayed"),
      "true",
    );
    const historicalCard = await historicalReplay.json();
    assert.equal(historicalCard.orderRef, orderRef);
    assert.ok(
      BigInt(historicalCard.projectionVersion) <
        BigInt(newerCard.projectionVersion),
    );
    const historicalAfter = await replaySnapshotIsStable(
      runtimeContext.ownerEvidence,
      "orders.item.put",
      lostSameOrderPut.key,
      snapshotSummary(historicalBefore),
      { orderRef, itemRef },
    );
    assert.equal(
      await visibleOrderProjectionVersion(page, orderRef),
      newerCard.projectionVersion,
    );
    evidence.owners.orders.put = snapshotSummary(newerSnapshot);
    setCheck("sameOrderStaleReplay", {
      staleGetCancelledOrIgnored: true,
      historicalReplayStatus: historicalReplay.status(),
      historicalReplayUsed:
        headerValue(historicalReplay.headers(), "idempotency-replayed") ===
        "true",
      sameOrderVerified: true,
      projectionAdvanced: true,
      olderReplayDidNotDowngrade: true,
      ownerEffectsStable:
        historicalAfter.businessDigest === historicalBefore.businessDigest,
    });

    setCheck(
      "naturalSseReauthentication",
      await proveNaturalSseReauthentication({
        page,
        browserContext,
        monitor,
        runtimeContext,
        orderRef,
        itemRef,
        idempotencyKey: newerPutKey,
      }),
    );

    const deleteItem = page.locator(`[aria-label="Позиция заказа ${itemRef}"]`);
    const deleteResponsePromise = page.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.pathname ===
            `/api/client-v1/orders/${orderRef}/items/${itemRef}` &&
          response.request().method() === "DELETE"
        );
      },
      { timeout: 30000 },
    );
    await deleteItem
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    const deleteDialog = page.getByRole("dialog", { name: "Удалить позицию?" });
    await deleteDialog
      .getByRole("button", { name: "Удалить", exact: true })
      .click();
    const deleteResponse = await deleteResponsePromise;
    assert.equal(deleteResponse.status(), 200);
    const deleteKey = headerValue(
      deleteResponse.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(deleteKey ?? ""))
      fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const deleteSnapshot = await completedSnapshot(
      runtimeContext.ownerEvidence,
      "orders.item.delete",
      deleteKey,
      { orderRef, itemRef },
    );
    assert.equal(deleteSnapshot.tableCounts.item, 0);
    evidence.owners.orders.delete = snapshotSummary(deleteSnapshot);
    setCheck("draftItemDelete", {
      completed: true,
      deleteStatus: deleteResponse.status(),
      deletedItemCount: 0,
    });

    await page.goto(`${IDENTITY.origin}/app/orders/${orderRef}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: customerName }).waitFor();
    const getCountBeforeReload = monitor.orderGets;
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: customerName }).waitFor();
    assert.ok(monitor.orderGets > getCountBeforeReload);
    setCheck("deepLinkReload", {
      directRouteLoaded: true,
      reloadFetchedOwner: true,
    });
    const orderA11y = await accessibilityPass(page);
    setCheck("accessibility", { customer: customerA11y, order: orderA11y });

    const fallback = await page.evaluate(async () => {
      const api = await fetch("/api/client-v1/g15-missing-route", {
        headers: { Accept: "application/json" },
      });
      const apiType = api.headers.get("content-type") ?? "";
      const apiText = await api.text();
      const asset = await fetch("/assets/g15-missing-proof.js");
      const assetText = await asset.text();
      return {
        apiStatus: api.status,
        apiJson: apiType.includes("json"),
        apiIndex: /<\s*!doctype\s+html|<html/iu.test(apiText),
        assetStatus: asset.status,
        assetIndex: /<\s*!doctype\s+html|<html/iu.test(assetText),
      };
    });
    assert.equal(fallback.apiStatus, 404);
    assert.equal(fallback.apiJson, true);
    assert.equal(fallback.apiIndex, false);
    assert.equal(fallback.assetStatus, 404);
    assert.equal(fallback.assetIndex, false);
    assert.ok(
      servedAssets.some(
        (asset) => asset.type === "script" && asset.status === 200,
      ),
    );
    assert.ok(
      servedAssets.some(
        (asset) => asset.type === "stylesheet" && asset.status === 200,
      ),
    );
    setCheck("servedAssets", {
      scriptCount: servedAssets.filter(
        (asset) => asset.type === "script" && asset.status === 200,
      ).length,
      stylesheetCount: servedAssets.filter(
        (asset) => asset.type === "stylesheet" && asset.status === 200,
      ).length,
    });
    setCheck("apiFallback", {
      status: fallback.apiStatus,
      jsonResponse: fallback.apiJson,
      indexHtml: false,
    });
    setCheck("assetFallback", {
      missingStatus: fallback.assetStatus,
      missingReturnedIndex: false,
      servedScriptCount: servedAssets.filter(
        (asset) => asset.type === "script" && asset.status === 200,
      ).length,
      servedStylesheetCount: servedAssets.filter(
        (asset) => asset.type === "stylesheet" && asset.status === 200,
      ).length,
    });

    const inProgressPage = await browserContext.newPage();
    await inProgressPage.goto(IDENTITY.origin, {
      waitUntil: "domcontentloaded",
    });
    const inProgressIntent = await abortedCustomerIntent(
      inProgressPage,
      randomUUID().slice(0, 12),
    );
    const seeded = await runtimeContext.ownerEvidence.seedInProgress({
      operation: "customer.create",
      idempotencyKey: inProgressIntent.key,
      requestHash: sha256("G15 synthetic acquired fixture request"),
    });
    assert.equal(seeded.state, "Acquired");
    const inProgress = await replayExpectedProblem(inProgressPage, {
      path: OPERATION["customer.create"].path,
      expectedStatus: 409,
      expectedCode: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    });
    assert.equal(inProgress.keyRetained, true);
    setCheck("inProgressReplay", { ...inProgress, state: "Acquired" });
    await inProgressPage.close();

    const absentPage = await browserContext.newPage();
    const absentIntent = await abortedCustomerIntent(
      absentPage,
      randomUUID().slice(0, 12),
    );
    const absent = await snapshotForAbsent(
      runtimeContext.ownerEvidence,
      "customer.create",
      absentIntent.key,
    );
    const notRetained = await replayExpectedProblem(absentPage, {
      path: OPERATION["customer.create"].path,
      expectedStatus: 410,
      expectedCode: "IDEMPOTENCY_RESULT_NOT_RETAINED",
    });
    setCheck("notRetainedReplay", {
      ...absent,
      status: notRetained.status,
      problemCode: notRetained.problemCode,
      keyRetained: notRetained.keyRetained,
    });
    await absentPage.close();

    const unavailablePage = await browserContext.newPage();
    const unavailableIntent = await abortedCustomerIntent(
      unavailablePage,
      randomUUID().slice(0, 12),
    );
    const unavailableSeed = await runtimeContext.ownerEvidence.seedInProgress({
      operation: "customer.create",
      idempotencyKey: unavailableIntent.key,
      requestHash: sha256("G15 synthetic unavailable fixture request"),
    });
    assert.equal(unavailableSeed.state, "Acquired");
    const unavailable =
      await runtimeContext.ownerEvidence.withLookupUnavailable({
        operation: "customer.create",
        idempotencyKey: unavailableIntent.key,
        exercise: async () => {
          const response = await replayFromUi(unavailablePage, {
            path: OPERATION["customer.create"].path,
            expectedStatus: 503,
          });
          return { status: response.status, problemCode: response.problemCode };
        },
      });
    assert.equal(unavailable.restoreVerified, true);
    const unavailableAfter = await runtimeContext.ownerEvidence.snapshot({
      operation: "customer.create",
      idempotencyKey: unavailableIntent.key,
    });
    assert.equal(unavailableAfter.state, "Acquired");
    const unavailableRetained = await readPendingIntent(unavailablePage, {
      method: "POST",
      path: OPERATION["customer.create"].path,
    });
    assert.equal(unavailableRetained.key, unavailableIntent.key);
    setCheck("lookupUnavailableReplay", {
      status: unavailable.status,
      problemCode: unavailable.problemCode,
      restoreVerified: unavailable.restoreVerified,
      keyRetained: true,
    });
    await unavailablePage.close();

    const logoutIntent = await abortedCustomerIntent(
      page,
      randomUUID().slice(0, 12),
    );
    assert.match(logoutIntent.key, UUID);
    const logout = await logoutAndRestrictedLogin(
      page,
      browserContext,
      runtimeContext.browserFixture.idp.hostname,
    );
    setCheck("logoutAndActorSwitch", logout);
    const restrictedSearch = page.getByRole("textbox", {
      name: "Имя, телефон или email",
    });
    await restrictedSearch.fill("g15");
    const customerBusinessBefore =
      await runtimeContext.ownerEvidence.snapshotCustomerBusiness();
    const deniedRead = page.waitForResponse(
      (response) => {
        const url = requestUrl(response.request());
        return (
          url.origin === IDENTITY.origin &&
          url.pathname === "/api/client-v1/customers" &&
          response.request().method() === "GET"
        );
      },
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Найти" }).click();
    const deniedReadResponse = await deniedRead;
    assert.equal(deniedReadResponse.status(), 403);

    await createCustomerForm(page, `restricted-${randomUUID().slice(0, 8)}`);
    const deniedWriteResponse = page.waitForResponse(
      (response) =>
        responseMatches(response, OPERATION["customer.create"].path, "POST"),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Создать и выбрать" }).click();
    const deniedWrite = await deniedWriteResponse;
    assert.equal(deniedWrite.status(), 403);
    const deniedKey = headerValue(
      deniedWrite.request().headers(),
      "idempotency-key",
    );
    if (!UUID.test(deniedKey ?? ""))
      fail("G15_BROWSER_IDEMPOTENCY_KEY_INVALID");
    const deniedAbsent = await snapshotForAbsent(
      runtimeContext.ownerEvidence,
      "customer.create",
      deniedKey,
    );
    const customerBusinessAfter =
      await runtimeContext.ownerEvidence.snapshotCustomerBusiness();
    assert.deepEqual(customerBusinessAfter, customerBusinessBefore);
    setCheck("restrictedPermissionDenied", {
      customerReadStatus: deniedReadResponse.status(),
      customerCreateStatus: deniedWrite.status(),
      ownerWriteAbsent: deniedAbsent.absent,
      businessBefore: customerBusinessBefore,
      businessAfter: customerBusinessAfter,
      businessUnchanged: true,
      keySha256: deniedAbsent.keySha256,
    });
    assert.equal(monitor.forbiddenMutations, 0);
    setCheck("noConfirmOrReconcile", { forbiddenMutationRequests: 0 });

    assert.ok(monitor.eventSourceReady > 0);
    assert.ok(monitor.eventSourceResponses > 0);
    assert.ok(monitor.invalidations > 0);
    assert.ok(monitor.orderGets > 1);
    evidence.browser = {
      driverStatus: driver.witness.status,
      imageIdSha256: sha256(driver.witness.imageId),
      networkIdSha256: sha256(driver.witness.networkId),
      cleanup: null,
      browserContexts: 1,
      eventSourceResponses: monitor.eventSourceResponses,
    };
    await cdp.detach();
    cdp = null;
    await browserContext.close();
    browserContext = null;
    evidence.browser.cleanup = await driver.close();
    driverClosed = true;
    assert.equal(evidence.browser.cleanup, "EXACT_OWNED_CONTAINER_REMOVED");
    const validated = validateBrowserEvidence(evidence, {
      runId: runtimeContext.runId,
      candidateSha: runtimeContext.candidateSha,
    });
    proofResult = {
      callbackProof: {
        schemaVersion: 1,
        runId: runtimeContext.runId,
        candidateSha: runtimeContext.candidateSha,
        status: "passed",
        verificationOnly: true,
        productionLogin: false,
      },
      evidence: validated,
    };
  } catch (error) {
    evidence.status = "failed";
    evidence.failureCode = safeFailure(error);
    failure = error instanceof Error ? error : new Error(evidence.failureCode);
  } finally {
    try {
      await cdp?.detach();
    } catch {
      cleanupFailureCode ??= "G15_BROWSER_CDP_CLEANUP_FAILED";
    }
    try {
      await browserContext?.close();
    } catch {
      cleanupFailureCode ??= "G15_BROWSER_CONTEXT_CLEANUP_FAILED";
    }
    try {
      if (driver && !driverClosed && driver.witness.status === "READY") {
        const cleanup = await driver.close();
        if (cleanup !== "EXACT_OWNED_CONTAINER_REMOVED")
          cleanupFailureCode ??= "G15_BROWSER_DRIVER_CLEANUP_FAILED";
        driverClosed = true;
      }
    } catch {
      cleanupFailureCode ??= "G15_BROWSER_DRIVER_CLEANUP_FAILED";
    }
  }
  if (failure) throw failure;
  if (cleanupFailureCode) throw new Error(cleanupFailureCode);
  return proofResult;
}
