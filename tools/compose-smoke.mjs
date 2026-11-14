#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  RUNTIMES,
  inspectLaunchRuntimeImages,
  validateRuntimeImageOwnership,
} from "./runtime-image-inventory.mjs";
export {
  captureRuntimeImageBaseline,
  cleanupLaunchRuntimeImages,
  inspectLaunchRuntimeImages,
  validateRuntimeImageOwnership,
} from "./runtime-image-inventory.mjs";
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { dirname, join, resolve } from "node:path";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { parsePublicTlsHostname } from "../packages/platform-security/src/index.ts";
import {
  createDatabase,
  withTransaction,
} from "../packages/platform-database/dist/index.js";
import { defineStatement } from "../packages/platform-database/dist/owner.js";
import {
  ensureNginxSecretOwnership,
  readMigrationCredential,
  readPreparedPostgresIdentity,
} from "./config-bootstrap/index.mjs";
import {
  materializeBrowserFixture,
  readBrowserFixtureLineage,
} from "./config-bootstrap/browser-fixture.mjs";
import {
  buildRealtimeAuthCloseInvocation,
  proveBrowser,
  proveBrowserFlow,
  validateObservabilityBrowserEvidence,
  validateBrowserRuntimeArtifact,
} from "./browser-proof.mjs";
import {
  createBrowserOwnerEvidence,
  createOrderEvidence,
  validateBrowserProof,
} from "./browser-owner-evidence.mjs";
import {
  applyMigrations,
  migrationChecksum,
} from "../packages/platform-migrations/dist/index.js";
import { OfferBindingStore } from "../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";
import { OrderStore } from "../apps/orders-service/dist/infrastructure/database/order-store.js";
import { createSourceIdentity } from "../apps/aroma-gateway/dist/domain/source-identity.js";
import pg from "pg";
import {
  SERVER_IDENTITY_SQL,
  bootstrapDatabases,
  projectLaunchDatabaseTargets,
  readJson,
  renderDatabaseObjectSql,
  replaceDatabase,
  validateServerProbe,
} from "../scripts/db-bootstrap.mjs";
import {
  cleanupMigrationDatabases,
  createMigrationDatabase,
} from "../verification/launch/v1/scenarios/migrations.mjs";
import {
  createDeliveryTables,
  dropDeliveryTables,
} from "../scripts/db-live-proof.mjs";
import { createRuntimeLoggingOverride } from "./observability/generate.mjs";
import {
  createBuildInputSnapshot,
  verifyBuildInputSnapshot,
} from "./security-scan.mjs";
import { validateLaunchContext } from "../verification/launch/v1/report.mjs";
import {
  loadVerifiedGateImage,
  readVerifiedRuntimeImages,
  removeVerifiedGateImage,
} from "./verified-infrastructure-image.mjs";
import { readLaunchImageInventory } from "./image-inventory.mjs";
import {
  deriveRuntimeDatabaseTarget,
  verifyLaunchConfigBytes,
} from "../packages/platform-config/src/launch-database-target.ts";
import {
  deriveLaunchKafkaRegistryTarget,
  deriveRuntimeKafkaTarget,
} from "../packages/platform-config/src/launch-kafka-target.ts";
import {
  attachRollbackDisabledReconcileSubstage,
  createRollbackFailureReceipt,
  readRollbackParent,
  ROLLBACK_DISABLED_RECONCILE_SUBSTAGES,
  ROLLBACK_FAILURE_STAGES,
  rollbackComposeProjectName,
  rollbackComposeSourceLocation,
  validateRollbackLineage,
} from "../verification/launch/v1/scenarios/rollback.mjs";
import {
  readProviderTrace,
  readRollbackFacts,
  rollbackOwnerHttpSource,
  rollbackSafeDigest,
  assertRollbackFixtureBaseline,
  assertRollbackHistoryPreserved,
  rollbackHistoryDigest,
  readRollbackGuardedCardFacts,
  seedRollbackOrder,
  shouldLoseFirstRollbackSetQuantityResponse,
  hasProcessedRollbackOperatorWake,
  inspectProcessedRollbackOperatorWake,
  applyRollbackArmedCartDrift,
  hasCompleteSafeGetBetweenLostAndApplied,
} from "./rollback-runtime-proof.mjs";

const { Client } = pg;

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMPOSE_FILE = join(ROOT, "compose.yaml");
const GATE_DEADLINE_ENV = "COFFEE_LAUNCH_GATE_DEADLINE_EPOCH_MS";
const STANDALONE_WAIT_MS = 5 * 60_000;
// Оставляем время на finally: compose down, удаление временных секретов и БД,
// чтобы SIGKILL от runner не прервал очистку ресурсов.
export const COMPOSE_SMOKE_CLEANUP_RESERVE_MS = 60_000;
export function remainingGateWaitMs(fallbackMs = STANDALONE_WAIT_MS) {
  const raw = process.env[GATE_DEADLINE_ENV];
  if (raw === undefined) return fallbackMs;
  const deadline = Number(raw);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return fallbackMs;
  return Math.max(1, deadline - Date.now() - COMPOSE_SMOKE_CLEANUP_RESERVE_MS);
}
const BOOTSTRAP = join(ROOT, "tools/config-bootstrap/index.mjs");
const SECRETS_TMPFS_ROOT = "/dev/shm";
const EXTERNAL_POSTGRES_NETWORK = "coffee_postgres_data";
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const DATABASE_PROOF_RUNTIME = "customer-service";
const BROWSER_FAILURE_ERROR_NAMES = new Set([
  "Error",
  "AssertionError",
  "AggregateError",
  "TypeError",
  "RangeError",
]);
let rollbackTerminationSignal;
let rollbackComposeDiagnostic;
export const ROLLBACK_COMPOSE_OPERATIONS = Object.freeze([
  "kafka-up",
  "kafka-offset-bootstrap",
  "runtime-stack-up",
]);
export const ROLLBACK_BOOTSTRAP_SUBSTAGES = Object.freeze([
  "launch-context-guard",
  "resource-check",
  "platform-config",
  "credentials",
  "tmpfs-secrets",
  "compose-override",
  "database-network",
  "materialize-secrets",
  "provider-fixture",
  "compose-config",
  "pg-container",
  "db-bootstrap",
  "owner-seed",
]);
export const ROLLBACK_INITIAL_UNKNOWN_SUBSTAGES = Object.freeze([
  "health",
  "arm-marker",
  "drift-card",
  "owner-reconcile",
  "unknown-facts",
]);
const ROLLBACK_INITIAL_UNKNOWN_OPERATIONS = new Set([
  "owner-db-facts",
  "guarded-card-http",
]);
const ROLLBACK_OWNER_HTTP_FAILURE_CODES = Object.freeze([
  "ROLLBACK_ORDER_CARD_HTTP_INVALID",
  "ROLLBACK_RECONCILIATION_CARD_STATE_INVALID",
  "ROLLBACK_RECONCILIATION_HTTP_INVALID",
  "ROLLBACK_OWNER_HTTP_READ_FAILED",
  "ROLLBACK_OWNER_HTTP_RECONCILE_FAILED",
]);
const ROLLBACK_OWNER_HTTP_SIGNALS = new Set([
  "SIGABRT",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGTERM",
  "SIGHUP",
]);
const SAFE_COMPOSE_SIGNALS = new Set([
  "SIGABRT",
  "SIGINT",
  "SIGKILL",
  "SIGQUIT",
  "SIGTERM",
  "SIGHUP",
]);
const SAFE_COMPOSE_SPAWN_CODES = new Set([
  "EACCES",
  "EAGAIN",
  "EMFILE",
  "ENOENT",
]);

export function attachRollbackBootstrapSubstage(receipt, substage) {
  assert.equal(
    receipt?.stage,
    "bootstrap",
    "bootstrap substage requires a bootstrap failure receipt",
  );
  assert.ok(
    ROLLBACK_BOOTSTRAP_SUBSTAGES.includes(substage),
    "rollback bootstrap substage is not allowlisted",
  );
  return Object.freeze({ ...receipt, bootstrapSubstage: substage });
}

export function createBrowserChildFailureDiagnostic({
  runId,
  candidateSha,
  error,
  operationDiagnostic = rollbackComposeDiagnostic,
}) {
  if (
    !/^\d{8}T\d{6}Z-[0-9a-f]{7}$/u.test(runId ?? "") ||
    !COMMIT_SHA.test(candidateSha ?? "") ||
    !runId.endsWith(`-${candidateSha.slice(0, 7)}`)
  )
    throw new Error("BROWSER_CHILD_DIAGNOSTIC_IDENTITY_INVALID");
  let errorName = "Error";
  let message = "BROWSER_CHILD_FAILED";
  try {
    if (error?.cause instanceof Error) error = error.cause;
    if (BROWSER_FAILURE_ERROR_NAMES.has(error?.name)) errorName = error.name;
    if (typeof error?.message === "string") message = error.message;
  } catch {
    // The child diagnostic is deliberately closed even for hostile error objects.
  }
  const diagnostic = {
    schemaVersion: 1,
    gateId: "browser",
    outcome: "FAIL",
    runId,
    candidateSha,
    errorName,
    messageSha256: createHash("sha256").update(message).digest("hex"),
  };
  let stack;
  try {
    stack = error?.stack;
  } catch {
    // Keep the diagnostic closed if the stack cannot be read.
  }
  let sourceLocation;
  if (typeof stack === "string" && stack.length <= 131_072) {
    const sourcePath = join(ROOT, "tools/browser-proof.mjs");
    for (const frame of stack.split(/\r?\n/u).slice(1, 257)) {
      const match = /^\s*at (?:(?:.*) \()?(.+?):(\d+):(\d+)\)?$/u.exec(frame);
      if (
        !match ||
        ![sourcePath, pathToFileURL(sourcePath).href].includes(match[1])
      )
        continue;
      const line = Number(match[2]);
      const column = Number(match[3]);
      if (
        Number.isSafeInteger(line) &&
        line > 0 &&
        line <= 1_000_000 &&
        Number.isSafeInteger(column) &&
        column > 0 &&
        column <= 1_000_000
      )
        sourceLocation = { source: "tools/browser-proof.mjs", line, column };
      break;
    }
  }
  sourceLocation ??= rollbackComposeSourceLocation(error);
  if (sourceLocation) diagnostic.sourceLocation = sourceLocation;
  const operationFailure =
    projectBrowserRuntimeStackDiagnostic(operationDiagnostic);
  if (operationFailure) diagnostic.operationDiagnostic = operationFailure;
  return Object.freeze(diagnostic);
}

function projectBrowserRuntimeStackDiagnostic(value) {
  if (
    value?.operation !== "runtime-stack-up" ||
    ![
      "timeout",
      "nonzero-exit",
      "signal",
      "spawn-error",
      "operation-error",
    ].includes(value.failureClass)
  )
    return undefined;
  const sourceSnapshot = value.containerSnapshot;
  const validSnapshotStatus = new Set([
    "captured",
    "partial",
    "unavailable",
    "invalid-input",
    "limit-exceeded",
  ]);
  const sourceContainers = Array.isArray(sourceSnapshot?.containers)
    ? sourceSnapshot.containers
    : [];
  const overLimit = sourceContainers.length > ROLLBACK_CONTAINER_LIMIT;
  const containers = (overLimit ? [] : sourceContainers).map((container) => ({
    service:
      ROLLBACK_CONTAINER_SERVICES.has(container?.service) ||
      container?.service === "unknown"
        ? container.service
        : "unknown",
    state: ROLLBACK_CONTAINER_STATES.has(container?.state)
      ? container.state
      : "unknown",
    health: ROLLBACK_CONTAINER_HEALTH.has(container?.health)
      ? container.health
      : null,
    exitCode:
      Number.isInteger(container?.exitCode) &&
      container.exitCode >= 0 &&
      container.exitCode <= 255
        ? container.exitCode
        : null,
    oomKilled: container?.oomKilled === true,
  }));
  return Object.freeze({
    operation: "runtime-stack-up",
    failureClass: value.failureClass,
    exitCode:
      Number.isInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 255
        ? value.exitCode
        : null,
    signal: SAFE_COMPOSE_SIGNALS.has(value.signal) ? value.signal : null,
    timedOut: value.timedOut === true,
    containerSnapshot: {
      status: overLimit
        ? "limit-exceeded"
        : validSnapshotStatus.has(sourceSnapshot?.status)
          ? sourceSnapshot.status
          : "unavailable",
      containers,
    },
  });
}

export function attachRollbackInitialUnknownSubstage(
  receipt,
  substage,
  diagnostic,
) {
  assert.equal(
    receipt?.stage,
    "initial-unknown",
    "initial-unknown substage requires an initial-unknown failure receipt",
  );
  assert.ok(
    ROLLBACK_INITIAL_UNKNOWN_SUBSTAGES.includes(substage),
    "rollback initial-unknown substage is not allowlisted",
  );
  const safeDiagnostic =
    diagnostic && ROLLBACK_INITIAL_UNKNOWN_OPERATIONS.has(diagnostic.operation)
      ? {
          operation: diagnostic.operation,
          sqlState:
            typeof diagnostic.sqlState === "string" &&
            /^[0-9A-Z]{5}$/u.test(diagnostic.sqlState)
              ? diagnostic.sqlState
              : null,
          exitCode:
            Number.isInteger(diagnostic.exitCode) &&
            diagnostic.exitCode >= 0 &&
            diagnostic.exitCode <= 255
              ? diagnostic.exitCode
              : null,
          signal: ROLLBACK_OWNER_HTTP_SIGNALS.has(diagnostic.signal)
            ? diagnostic.signal
            : null,
          failureCode: ROLLBACK_OWNER_HTTP_FAILURE_CODES.includes(
            diagnostic.failureCode,
          )
            ? diagnostic.failureCode
            : null,
        }
      : null;
  return Object.freeze({
    ...receipt,
    initialUnknownSubstage: substage,
    ...(safeDiagnostic ? { initialUnknownDiagnostic: safeDiagnostic } : {}),
  });
}

export function createRollbackInitialUnknownDiagnostic(operation, error) {
  assert.ok(
    ROLLBACK_INITIAL_UNKNOWN_OPERATIONS.has(operation),
    "rollback initial-unknown operation is not allowlisted",
  );
  const diagnostic = {
    operation,
    sqlState: null,
    exitCode: null,
    signal: null,
    failureCode: null,
  };
  if (operation === "owner-db-facts") {
    if (typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code))
      diagnostic.sqlState = error.code;
  } else {
    if (
      Number.isInteger(error?.status) &&
      error.status >= 0 &&
      error.status <= 255
    )
      diagnostic.exitCode = error.status;
    if (ROLLBACK_OWNER_HTTP_SIGNALS.has(error?.signal))
      diagnostic.signal = error.signal;
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8")
      : typeof error?.stderr === "string"
        ? error.stderr
        : "";
    const stderrLines = stderr
      .split("\n")
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    diagnostic.failureCode =
      ROLLBACK_OWNER_HTTP_FAILURE_CODES.find(
        (code) =>
          error?.message === code || stderrLines.includes(`Error: ${code}`),
      ) ?? null;
  }
  return Object.freeze(diagnostic);
}

export function sanitizeRollbackContainerSnapshot(
  projectName,
  rows,
  standalonePostgresName,
) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(projectName ?? "") ||
    !Array.isArray(rows)
  )
    return { status: "invalid-input", containers: [] };
  if (
    standalonePostgresName !== undefined &&
    standalonePostgresName !== `${projectName}-postgres-proof`
  )
    return { status: "invalid-input", containers: [] };

  const projectLabel = "com.docker.compose.project";
  const serviceLabel = "com.docker.compose.service";
  const containers = [];
  for (const row of rows) {
    const labels = row?.Config?.Labels;
    const labelProject = labels?.[projectLabel];
    const name =
      typeof row?.Name === "string" ? row.Name.replace(/^\/+/, "") : "";
    const standalonePostgres =
      name === standalonePostgresName &&
      (labelProject === undefined || labelProject === projectName);
    if (labelProject !== projectName && !standalonePostgres) continue;

    const state = row?.State;
    const stateName = ROLLBACK_CONTAINER_STATES.has(state?.Status)
      ? state.Status
      : "unknown";
    const healthName = ROLLBACK_CONTAINER_HEALTH.has(state?.Health?.Status)
      ? state.Health.Status
      : null;
    const serviceName = standalonePostgres
      ? "postgres-proof"
      : labels?.[serviceLabel];
    containers.push({
      service: ROLLBACK_CONTAINER_SERVICES.has(serviceName)
        ? serviceName
        : "unknown",
      state: stateName,
      health: healthName,
      exitCode:
        Number.isInteger(state?.ExitCode) &&
        state.ExitCode >= 0 &&
        state.ExitCode <= 255
          ? state.ExitCode
          : null,
      oomKilled: state?.OOMKilled === true,
      startedAt:
        typeof state?.StartedAt === "string" &&
        state.StartedAt.length <= 32 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
          state.StartedAt,
        )
          ? state.StartedAt
          : null,
      finishedAt:
        typeof state?.FinishedAt === "string" &&
        state.FinishedAt.length <= 32 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(
          state.FinishedAt,
        )
          ? state.FinishedAt
          : null,
    });
    if (containers.length > ROLLBACK_CONTAINER_LIMIT)
      return { status: "limit-exceeded", containers: [] };
  }
  containers.sort(
    (left, right) =>
      ROLLBACK_CONTAINER_SERVICE_ORDER.get(left.service) -
        ROLLBACK_CONTAINER_SERVICE_ORDER.get(right.service) ||
      left.state.localeCompare(right.state) ||
      (left.exitCode ?? -1) - (right.exitCode ?? -1),
  );
  return { status: "captured", containers };
}

export function attachRollbackContainerSnapshot(
  operation,
  diagnostic,
  capture,
) {
  if (operation !== "runtime-stack-up") return diagnostic;
  let containerSnapshot;
  try {
    containerSnapshot = capture();
  } catch {
    containerSnapshot = { status: "unavailable", containers: [] };
  }
  return Object.freeze({ ...diagnostic, containerSnapshot });
}

function parseRollbackContainerInspect(output) {
  if (typeof output !== "string")
    throw new Error("ROLLBACK_CONTAINER_SNAPSHOT_INVALID");
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length !== 9)
        throw new Error("ROLLBACK_CONTAINER_SNAPSHOT_INVALID");
      const [
        name,
        project,
        service,
        stateName,
        health,
        exitCode,
        oomKilled,
        startedAt,
        finishedAt,
      ] = fields.map((field) => JSON.parse(field));
      const labels = {};
      if (typeof project === "string")
        labels["com.docker.compose.project"] = project;
      if (typeof service === "string")
        labels["com.docker.compose.service"] = service;
      return {
        Name: name,
        Config: { Labels: labels },
        State: {
          Status: stateName,
          ...(typeof health === "string" ? { Health: { Status: health } } : {}),
          ExitCode: exitCode,
          OOMKilled: oomKilled,
          StartedAt: startedAt,
          FinishedAt: finishedAt,
        },
      };
    });
}

function runDockerForRollbackContainerSnapshot(args, { timeout }) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: ROLLBACK_CONTAINER_SNAPSHOT_MAX_BUFFER,
  });
}

export function captureRollbackContainerSnapshot(
  projectName,
  standalonePostgresName,
  execDocker = runDockerForRollbackContainerSnapshot,
  now = () => Number(process.hrtime.bigint() / 1_000_000n),
) {
  if (
    !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(projectName ?? "") ||
    (standalonePostgresName !== undefined &&
      standalonePostgresName !== `${projectName}-postgres-proof`)
  )
    return { status: "invalid-input", containers: [] };
  try {
    const deadline = now() + ROLLBACK_CONTAINER_SNAPSHOT_BUDGET_MS;
    const run = (args) => {
      const timeout = deadline - now();
      if (timeout <= 0)
        throw Object.assign(new Error("ROLLBACK_CONTAINER_SNAPSHOT_TIMEOUT"), {
          code: "ETIMEDOUT",
        });
      return execDocker(args, {
        timeout,
        maxBuffer: ROLLBACK_CONTAINER_SNAPSHOT_MAX_BUFFER,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    const ids = run([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (ids.some((id) => !/^[0-9a-f]{12,64}$/u.test(id)))
      return { status: "unavailable", containers: [] };
    const rows = ids.length
      ? parseRollbackContainerInspect(
          run([
            "inspect",
            "--format",
            ROLLBACK_CONTAINER_INSPECT_FORMAT,
            ...ids,
          ]),
        )
      : [];
    if (!Array.isArray(rows)) return { status: "unavailable", containers: [] };
    let status = "captured";
    if (standalonePostgresName) {
      try {
        rows.push(
          ...parseRollbackContainerInspect(
            run([
              "inspect",
              "--format",
              ROLLBACK_CONTAINER_INSPECT_FORMAT,
              standalonePostgresName,
            ]),
          ),
        );
      } catch {
        status = "partial";
      }
    }
    const snapshot = sanitizeRollbackContainerSnapshot(
      projectName,
      rows,
      standalonePostgresName,
    );
    return status === "captured" || snapshot.status !== "captured"
      ? snapshot
      : { ...snapshot, status };
  } catch {
    return { status: "unavailable", containers: [] };
  }
}

function composeKafkaTarget(platformConfig, runtime, launchIdentity) {
  return deriveRuntimeKafkaTarget({
    config: platformConfig.kafka,
    service: platformConfig.services[runtime].kafka,
    enabled: platformConfig.verification?.kafkaNamespaceIsolation === true,
    environment: platformConfig.environment,
    ...(launchIdentity ? { launchIdentity } : {}),
  });
}

export function captureKafkaNamespaceInventory({
  projectName,
  platformConfig,
  launchIdentity,
  actualTopics,
  actualGroups,
}) {
  assert.equal(
    platformConfig.verification?.kafkaNamespaceIsolation,
    true,
    "Kafka namespace inventory requires the committed isolation policy",
  );
  assert.ok(
    launchIdentity,
    "Kafka namespace inventory requires a validated launch identity",
  );
  assert.match(
    projectName,
    /^[a-z0-9][a-z0-9_-]*$/u,
    "Kafka namespace inventory project is invalid",
  );
  assert.ok(
    Array.isArray(actualTopics) && Array.isArray(actualGroups),
    "Kafka broker inventories must be arrays",
  );
  for (const name of [...actualTopics, ...actualGroups])
    assert.match(
      name,
      /^[A-Za-z0-9._-]+$/u,
      "Kafka broker inventory contains an invalid name",
    );

  const targets = Object.keys(platformConfig.services).flatMap((runtime) => [
    composeKafkaTarget(platformConfig, runtime, launchIdentity),
  ]);
  const registryTarget = deriveLaunchKafkaRegistryTarget({
    config: platformConfig.kafka,
    enabled: platformConfig.verification?.kafkaNamespaceIsolation === true,
    environment: platformConfig.environment,
    launchIdentity,
  });
  const sortNames = (left, right) => left.localeCompare(right, "en");
  const expectedTopics = [
    ...new Set(Object.values(registryTarget.topics)),
  ].sort(sortNames);
  const expectedGroups = [
    ...new Set(targets.flatMap(({ groups }) => Object.values(groups))),
  ].sort(sortNames);
  const observedTopics = [...new Set(actualTopics)].sort(sortNames);
  const observedGroups = [...new Set(actualGroups)].sort(sortNames);
  const missingTopics = expectedTopics.filter(
    (name) => !observedTopics.includes(name),
  );
  const missingGroups = expectedGroups.filter(
    (name) => !observedGroups.includes(name),
  );
  const canonicalTopics = Object.values(platformConfig.kafka.topics).flatMap(
    ({ name, dlq }) => [name, dlq],
  );
  const canonicalGroups = targets.flatMap(({ groups }) => Object.keys(groups));
  const canonicalTopicsAbsent = canonicalTopics.every(
    (name) => !observedTopics.includes(name),
  );
  const canonicalGroupsAbsent = canonicalGroups.every(
    (name) => !observedGroups.includes(name),
  );
  assert.deepEqual(
    missingTopics,
    [],
    "Kafka broker is missing expected run-scoped topics or DLQs",
  );
  assert.deepEqual(
    missingGroups,
    [],
    "Kafka broker is missing expected run-scoped consumer groups",
  );
  assert.equal(
    canonicalTopicsAbsent,
    true,
    "Kafka broker contains a canonical business topic",
  );
  assert.equal(
    canonicalGroupsAbsent,
    true,
    "Kafka broker contains a canonical consumer group",
  );
  return {
    schemaVersion: 1,
    mode: "launch-namespace",
    runId: launchIdentity.runId,
    projectName,
    topics: {
      expectedPhysical: expectedTopics,
      actual: observedTopics,
      missing: missingTopics,
      canonicalNamesAbsent: canonicalTopicsAbsent,
    },
    groups: {
      expectedPhysical: expectedGroups,
      actual: observedGroups,
      missing: missingGroups,
      canonicalNamesAbsent: canonicalGroupsAbsent,
    },
  };
}

export function buildKafkaRegistryBootstrapScript(
  platformConfig,
  launchIdentity,
  client = "--bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties",
) {
  const target = deriveLaunchKafkaRegistryTarget({
    config: platformConfig.kafka,
    enabled: platformConfig.verification?.kafkaNamespaceIsolation === true,
    environment: platformConfig.environment,
    ...(launchIdentity ? { launchIdentity } : {}),
  });
  return Object.values(platformConfig.kafka.topics).flatMap((topic) =>
    [topic.name, topic.dlq].map(
      (logicalName) =>
        `/opt/kafka/bin/kafka-topics.sh ${client} --create --if-not-exists --topic ${JSON.stringify(target.topics[logicalName])} --partitions ${topic.partitions} --replication-factor 1 >/dev/null`,
    ),
  );
}

export function kafkaNamespaceLaunchIdentity(
  platformConfig,
  validatedLaunchContext,
) {
  if (platformConfig.verification?.kafkaNamespaceIsolation !== true)
    return undefined;
  assert.ok(
    validatedLaunchContext?.context,
    "Kafka namespace isolation requires a validated launch context",
  );
  return launchConfigIdentity(validatedLaunchContext);
}

function launchConfigIdentity(validatedLaunchContext) {
  const context = validatedLaunchContext?.context;
  assert.ok(context, "launch identity requires a validated launch context");
  return {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    baseConfigSha256: context.baseConfigSha256,
  };
}

export function hasProcessedConvergenceProjectionEvent(facts, consumerGroupId) {
  return facts.projectionInbox.some(
    (row) =>
      row.message_type === "AromaConvergenceChanged.v1" &&
      row.consumer_name === consumerGroupId &&
      row.state === "Processed",
  );
}

export function rollbackFactsRequireGuardedCard(facts, consumerGroupId) {
  return (
    facts.attempts.some((row) => row.state === "UnknownOutcome") &&
    facts.reservations.some(
      (row) => row.state === "UnknownOutcome" && !row.resolved,
    ) &&
    facts.gatewayRows.some((row) => row.state === "UnknownOutcome") &&
    hasProcessedConvergenceProjectionEvent(facts, consumerGroupId)
  );
}

export async function rollbackRecoveryGetResponse({
  rollbackMode,
  firstQuantityWriteDropped,
  releaseFile,
  cartBody,
}) {
  if (!rollbackMode || !firstQuantityWriteDropped)
    return { gated: false, statusCode: 200, body: cartBody };
  try {
    await readFile(releaseFile);
    return { gated: false, statusCode: 200, body: cartBody };
  } catch {
    // Keep the provider transport healthy while making the cart decoder reject
    // this incomplete body before any snapshot or observed state can be stored.
    return { gated: true, statusCode: 200, body: "{}" };
  }
}

const ROLLBACK_CARD_STATES = new Set([
  "NotRequested",
  "PendingObservation",
  "UnknownOutcome",
  "Blocked",
  "Converging",
  "InSync",
  "OutOfSync",
]);
const ROLLBACK_PROJECTION_STATES = new Set([
  "PendingObservation",
  "Converging",
  "InSync",
  "OutOfSync",
  "Blocked",
  "UnknownOutcome",
]);

function closedRollbackGuardedCardFacts(facts) {
  return {
    projectionState: ROLLBACK_PROJECTION_STATES.has(facts?.projectionState)
      ? facts.projectionState
      : facts?.projectionState === "Missing"
        ? "Missing"
        : "Other",
    orderPresent: facts?.orderPresent === true,
    projectionPresent: facts?.projectionPresent === true,
    currentDesiredPresent: facts?.currentDesiredPresent === true,
    currentObservedPresent: facts?.currentObservedPresent === true,
    proofAttemptPresent: facts?.proofAttemptPresent === true,
    leasePresent: facts?.leasePresent === true,
    desiredProofMatches: facts?.desiredProofMatches === true,
    observedProofMatches: facts?.observedProofMatches === true,
    observationComplete: facts?.observationComplete === true,
    observationNotFuture: facts?.observationNotFuture === true,
    observationFresh: facts?.observationFresh === true,
    freshnessEnabled: facts?.freshnessEnabled === true,
    attemptSuccessful: facts?.attemptSuccessful === true,
    attemptMatchesProjection: facts?.attemptMatchesProjection === true,
    attemptMatchesDesired: facts?.attemptMatchesDesired === true,
    attemptMatchesObserved: facts?.attemptMatchesObserved === true,
    fenceMatches: facts?.fenceMatches === true,
    leaseOwnerMatches: facts?.leaseOwnerMatches === true,
    leaseActive: facts?.leaseActive === true,
    unknownOutcomePresent: facts?.unknownOutcomePresent === true,
    unresolvedReservationPresent: facts?.unresolvedReservationPresent === true,
    currentContributionMatches: facts?.currentContributionMatches === true,
    orderBlockersPresent: facts?.orderBlockersPresent === true,
    exactLinesMatch: facts?.exactLinesMatch === true,
    latestAttemptPresent: facts?.latestAttemptPresent === true,
    latestAttemptSuccessful: facts?.latestAttemptSuccessful === true,
    latestAttemptMatchesDesired: facts?.latestAttemptMatchesDesired === true,
    latestAttemptMatchesObservedRevision:
      facts?.latestAttemptMatchesObservedRevision === true,
    latestAttemptObservedFingerprintMatchesCurrent:
      facts?.latestAttemptObservedFingerprintMatchesCurrent === true,
    latestAttemptFenceMatchesLease:
      facts?.latestAttemptFenceMatchesLease === true,
    latestAttemptOwnerMatchesLease:
      facts?.latestAttemptOwnerMatchesLease === true,
  };
}

export function createRollbackRestoredCardTimeoutDiagnostic({
  launchIdentity,
  ownerCardState,
  guardedCardFacts,
}) {
  const context = launchIdentity?.context;
  if (
    !context ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(context.runId ?? "") ||
    !COMMIT_SHA.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`)
  )
    throw new Error("ROLLBACK_RESTORED_CARD_DIAGNOSTIC_IDENTITY_INVALID");
  return {
    schemaVersion: 1,
    gateId: "rollback",
    runId: context.runId,
    candidateSha: context.candidateSha,
    stage: "restored-card",
    code: "ROLLBACK_RESTORED_CARD_IN_SYNC_TIMEOUT",
    ownerCardState: ROLLBACK_CARD_STATES.has(ownerCardState)
      ? ownerCardState
      : "Other",
    guardedCardFacts: closedRollbackGuardedCardFacts(guardedCardFacts),
  };
}

export async function writeRollbackRestoredCardTimeoutDiagnostic({
  launchIdentity,
  ownerCardState,
  guardedCardFacts,
}) {
  const context = launchIdentity?.context;
  const evidenceDir = launchIdentity?.evidenceDir;
  const expectedEvidenceDir = context?.sourceRepoRoot
    ? resolve(context.sourceRepoRoot, "evidence/launch", context.runId)
    : "";
  if (
    typeof evidenceDir !== "string" ||
    resolve(evidenceDir) !== expectedEvidenceDir ||
    resolve(context?.evidenceDir ?? "") !== expectedEvidenceDir
  )
    throw new Error("ROLLBACK_RESTORED_CARD_DIAGNOSTIC_EVIDENCE_SCOPE_INVALID");
  const artifact = createRollbackRestoredCardTimeoutDiagnostic({
    launchIdentity,
    ownerCardState,
    guardedCardFacts,
  });
  const artifactDir = join(evidenceDir, "gates/rollback/artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(
    artifactDir,
    "mutation-disable-rollback-restored-card-timeout.json",
  );
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return artifactPath;
}

export function createRollbackInitialUnknownTimeoutDiagnostic({
  launchIdentity,
  facts,
  projectionConsumerGroupId,
  correlationId,
  orderRef,
}) {
  const context = launchIdentity?.context;
  if (
    !context ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(context.runId ?? "") ||
    !COMMIT_SHA.test(context.candidateSha ?? "") ||
    !context.runId.endsWith(`-${context.candidateSha.slice(0, 7)}`) ||
    typeof projectionConsumerGroupId !== "string"
  )
    throw new Error("ROLLBACK_INITIAL_UNKNOWN_DIAGNOSTIC_IDENTITY_INVALID");
  const rows = (name) => (Array.isArray(facts?.[name]) ? facts[name] : []);
  const attemptUnknown = rows("attempts").some(
    (row) => row.state === "UnknownOutcome",
  );
  const reservationUnknownUnresolved = rows("reservations").some(
    (row) => row.state === "UnknownOutcome" && !row.resolved,
  );
  const gatewayUnknown = rows("gatewayRows").some(
    (row) => row.state === "UnknownOutcome",
  );
  const rawProjectionState = facts?.orderProjection?.state;
  const guardedCardState = facts?.guardedCardState;
  const projectionProcessed = hasProcessedConvergenceProjectionEvent(
    facts ?? { projectionInbox: [] },
    projectionConsumerGroupId,
  );
  const desiredRows = rows("desired").filter((row) => row.state === "Current");
  const unknownAttempts = rows("attempts").filter(
    (row) => row.state === "UnknownOutcome",
  );
  const currentDesired = desiredRows[0];
  const unknownAttempt = unknownAttempts[0];
  const operatorWakeStages = inspectProcessedRollbackOperatorWake({
    ordersOutbox: rows("ordersOutbox"),
    inboxRows: rows("inboxRows"),
    wakes: rows("wakes"),
    wakeInbox: rows("wakeInbox"),
    correlationId,
    desiredRevision: currentDesired?.desired_revision,
    orderRef,
    consumerName: "aroma-convergence-v1",
  });
  const count = (values, predicate) => values.filter(predicate).length;
  const hasType = (type) => (row) => row.message_type === type;
  const published = (row) => row.state === "Published";
  const processed = (row) => row.state === "Processed";
  const confirmed = hasType("OrderConfirmed.v1");
  const wake = hasType("AromaConvergenceRequested.v1");
  const result = hasType("AromaConvergenceChanged.v1");
  return {
    schemaVersion: 1,
    gateId: "rollback",
    runId: context.runId,
    candidateSha: context.candidateSha,
    stage: "initial-unknown",
    code: "ROLLBACK_INITIAL_UNKNOWN_OUTCOME_TIMEOUT",
    predicates: {
      attemptUnknown,
      reservationUnknownUnresolved,
      gatewayUnknown,
      cardUnknown: guardedCardState === "UnknownOutcome",
      projectionProcessed,
    },
    operatorWake: operatorWakeStages,
    selection: {
      currentDesiredUnique: desiredRows.length === 1,
      unknownAttemptMatchesCurrentDesired: Boolean(
        unknownAttempt &&
        currentDesired &&
        unknownAttempt.desired_revision === currentDesired.desired_revision,
      ),
    },
    rawProjectionState:
      rawProjectionState == null
        ? null
        : ROLLBACK_CARD_STATES.has(rawProjectionState)
          ? rawProjectionState
          : "Other",
    guardedCardState:
      guardedCardState == null
        ? null
        : ROLLBACK_CARD_STATES.has(guardedCardState)
          ? guardedCardState
          : "Other",
    counts: {
      attempts: rows("attempts").length,
      reservations: rows("reservations").length,
      gatewayRows: rows("gatewayRows").length,
      ordersOutbox: rows("ordersOutbox").length,
      inboxRows: rows("inboxRows").length,
      wakes: rows("wakes").length,
      wakeInbox: rows("wakeInbox").length,
      convergenceOutbox: rows("convergenceOutbox").length,
      projectionInbox: rows("projectionInbox").length,
    },
    deliveryCounts: {
      orderConfirmedPublished: count(
        rows("ordersOutbox"),
        (row) => confirmed(row) && published(row),
      ),
      preparationInboxProcessed: count(
        rows("inboxRows"),
        (row) =>
          confirmed(row) &&
          row.consumer_name === "orders-aroma-preparation-v1" &&
          processed(row),
      ),
      convergenceWakePublished: count(
        rows("wakes"),
        (row) => wake(row) && published(row),
      ),
      convergenceInboxProcessed: count(
        rows("wakeInbox"),
        (row) => row.consumer_name === "aroma-convergence-v1" && processed(row),
      ),
      convergenceResultPublished: count(
        rows("convergenceOutbox"),
        (row) => result(row) && published(row),
      ),
      projectionInboxProcessed: count(
        rows("projectionInbox"),
        (row) =>
          result(row) &&
          row.consumer_name === projectionConsumerGroupId &&
          processed(row),
      ),
    },
  };
}

export async function writeRollbackInitialUnknownTimeoutDiagnostic({
  launchIdentity,
  facts,
  projectionConsumerGroupId,
  correlationId,
  orderRef,
}) {
  const context = launchIdentity?.context;
  const evidenceDir = launchIdentity?.evidenceDir;
  const expectedEvidenceDir = context?.sourceRepoRoot
    ? resolve(context.sourceRepoRoot, "evidence/launch", context.runId)
    : "";
  if (
    typeof evidenceDir !== "string" ||
    resolve(evidenceDir) !== expectedEvidenceDir ||
    resolve(context?.evidenceDir ?? "") !== expectedEvidenceDir
  ) {
    throw new Error(
      "ROLLBACK_INITIAL_UNKNOWN_DIAGNOSTIC_EVIDENCE_SCOPE_INVALID",
    );
  }
  const artifact = createRollbackInitialUnknownTimeoutDiagnostic({
    launchIdentity,
    facts,
    projectionConsumerGroupId,
    correlationId,
    orderRef,
  });
  const artifactPath = join(
    evidenceDir,
    "gates/rollback/artifacts/mutation-disable-rollback-initial-unknown-timeout.json",
  );
  await mkdir(join(evidenceDir, "gates/rollback/artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return artifactPath;
}

export async function withEarlyRollbackGuardReceipt(
  { mutationDisableRollback, launchIdentity },
  operation,
) {
  assert.equal(
    typeof operation,
    "function",
    "early rollback guard operation is required",
  );
  try {
    return await operation();
  } catch (error) {
    if (!mutationDisableRollback || !launchIdentity?.context) throw error;
    const guardCode =
      error instanceof Error &&
      error.message.startsWith("RUNTIME_DATABASE_TARGET_INVALID:")
        ? "RUNTIME_DATABASE_TARGET_INVALID"
        : "ROLLBACK_LAUNCH_CONFIG_GUARD_REJECTED";
    const safeError = new Error(guardCode);
    safeError.rollbackFailure = attachRollbackBootstrapSubstage(
      createRollbackFailureReceipt({
        runId: launchIdentity.context.runId,
        candidateSha: launchIdentity.context.candidateSha,
        stage: "bootstrap",
        error: safeError,
        cleanup: {
          verified: true,
          complete: true,
          failures: [],
          retainedResources: [],
          inventory: { containers: [], volumes: [], networks: [] },
        },
      }),
      "launch-context-guard",
    );
    throw safeError;
  }
}

export function withRollbackComposeDiagnostic(operation, invoke, onFailure) {
  assert.ok(
    ROLLBACK_COMPOSE_OPERATIONS.includes(operation),
    "rollback Compose operation is not allowlisted",
  );
  assert.equal(
    typeof invoke,
    "function",
    "rollback Compose operation callback is required",
  );
  assert.equal(
    typeof onFailure,
    "function",
    "rollback Compose diagnostic callback is required",
  );
  try {
    return invoke();
  } catch (error) {
    const status =
      Number.isInteger(error?.status) &&
      error.status >= 0 &&
      error.status <= 255
        ? error.status
        : null;
    const signal = SAFE_COMPOSE_SIGNALS.has(error?.signal)
      ? error.signal
      : null;
    const timedOut = error?.timedOut === true || error?.code === "ETIMEDOUT";
    const failureClass = timedOut
      ? "timeout"
      : status !== null
        ? "nonzero-exit"
        : signal
          ? "signal"
          : SAFE_COMPOSE_SPAWN_CODES.has(error?.code)
            ? "spawn-error"
            : "operation-error";
    try {
      onFailure(
        Object.freeze({
          operation,
          exitCode: status,
          signal,
          timedOut,
          failureClass,
        }),
      );
    } catch {
      /* preserve the phase failure if diagnostic storage itself fails */
    }
    throw error;
  }
}

function runTrackedRollbackCompose(
  operation,
  projectName,
  secretsDir,
  args,
  options,
  standalonePostgresName,
) {
  return withRollbackComposeDiagnostic(
    operation,
    () => runCompose(projectName, secretsDir, args, options),
    (diagnostic) => {
      rollbackComposeDiagnostic = attachRollbackContainerSnapshot(
        operation,
        diagnostic,
        () =>
          captureRollbackContainerSnapshot(projectName, standalonePostgresName),
      );
    },
  );
}

function throwIfRollbackTerminationRequested() {
  if (rollbackTerminationSignal)
    throw new Error(`_STOP_REQUESTED_${rollbackTerminationSignal}`);
}
const COMPOSE_NETWORKS = [
  "coffee_host_ingress",
  "coffee_edge_backend",
  "coffee_public_api_backend",
  "coffee_internal_api",
  "coffee_postgres_data",
  "coffee_kafka_event",
  "coffee_provider_egress",
];
const DATABASE_PROOF_IMAGE = JSON.parse(
  readFileSync(join(ROOT, "config/toolchain-versions.json"), "utf8"),
).postgresFixtureImage;
const CUSTOMER_TEST_IMAGE =
  "node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146";
// Образы, которые supply_chain собирает один раз и публикует под тегами проекта запуска.
const PUBLISHED_RUNTIME_SERVICES = Object.freeze([...RUNTIMES, "edge-nginx"]);
const ROLLBACK_CONTAINER_SERVICES = new Set([
  ...RUNTIMES,
  "edge-nginx",
  "kafka",
  "aroma-provider-fixture",
  "postgres-proof",
]);
const ROLLBACK_CONTAINER_SERVICE_ORDER = new Map(
  [
    ...RUNTIMES,
    "edge-nginx",
    "kafka",
    "aroma-provider-fixture",
    "postgres-proof",
    "unknown",
  ].map((service, index) => [service, index]),
);
const ROLLBACK_CONTAINER_STATES = new Set([
  "created",
  "dead",
  "exited",
  "paused",
  "removing",
  "restarting",
  "running",
]);
const ROLLBACK_CONTAINER_HEALTH = new Set(["healthy", "starting", "unhealthy"]);
const ROLLBACK_CONTAINER_LIMIT = 32;
const ROLLBACK_CONTAINER_SNAPSHOT_BUDGET_MS = 10_000;
const ROLLBACK_CONTAINER_SNAPSHOT_MAX_BUFFER = 64 * 1024;
const ROLLBACK_CONTAINER_INSPECT_FORMAT = [
  "{{json .Name}}",
  '{{if .Config.Labels}}{{json (index .Config.Labels "com.docker.compose.project")}}{{else}}null{{end}}',
  '{{if .Config.Labels}}{{json (index .Config.Labels "com.docker.compose.service")}}{{else}}null{{end}}',
  "{{json .State.Status}}",
  "{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}",
  "{{json .State.ExitCode}}",
  "{{json .State.OOMKilled}}",
  "{{json .State.StartedAt}}",
  "{{json .State.FinishedAt}}",
].join("\t");
const RUNTIME_HEALTHCHECK = [
  "node",
  "-e",
  "import('@coffee-platform/runtime/healthcheck').then(({main}) => main(process.argv.slice(1)))",
];
const RUNTIME_HEALTH_STATUSES = [
  "node",
  "-e",
  "import('@coffee-platform/runtime/healthcheck').then(async ({readRuntimeHealthStatuses}) => { for (const status of await readRuntimeHealthStatuses(process.argv.slice(1))) console.log(status); }).catch((error) => { console.error(error instanceof Error ? error.message : 'runtime healthcheck failed'); process.exitCode = 1; })",
];
function usage() {
  return [
    "Usage: node tools/compose-smoke.mjs [options]",
    "",
    "Options:",
    "  --stub-secrets                     use empty, non-secret scoped stubs for topology-only smoke",
    "  --database-proof                  run the isolated customer PostgreSQL readiness proof",
    "  --customer-proof                 run the isolated Customer integration suite",
    "  --recovery-proof                  run the isolated 14-Node plus native-nginx PostgreSQL/Kafka recovery proof",
    "  --browser-proof                   run the isolated served-SPA, OIDC and owner recovery proof",
    "  --mutation-disable-rollback      run rollback on the isolated full-stack recovery topology with validated D/R configs",
    "  --aroma-binding-proof             run the isolated native HTTPS AROMA offer-binding proof",
    "  --aroma-cart-proof                run the isolated native mTLS safe cart-read proof with a local provider fixture",
    "  --provision-empty-postgres-network create coffee_postgres_data only when absent; never starts PostgreSQL",
    "  --no-build                         use already-built runtime images",
    "  --project-name <name>              explicit isolated Compose project name",
    "  --keep                             leave the stack and tmpfs secret directory running",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    stubSecrets: false,
    provisionNetwork: false,
    noBuild: false,
    keep: false,
    databaseProof: false,
    customerProof: false,
    recoveryProof: false,
    observabilityFixture: false,
    browserProof: false,
    mutationDisableRollback: false,
    disabledRoot: undefined,
    disabledSha: undefined,
    restoredRoot: undefined,
    restoredSha: undefined,
    aromaBindingProof: false,
    aromaCartProof: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--stub-secrets") options.stubSecrets = true;
    else if (argument === "--provision-empty-postgres-network")
      options.provisionNetwork = true;
    else if (argument === "--no-build") options.noBuild = true;
    else if (argument === "--database-proof") options.databaseProof = true;
    else if (argument === "--customer-proof") options.customerProof = true;
    else if (argument === "--recovery-proof") options.recoveryProof = true;
    else if (argument === "--observability-fixture")
      options.observabilityFixture = true;
    else if (argument === "--browser-proof") options.browserProof = true;
    else if (argument === "--mutation-disable-rollback")
      options.mutationDisableRollback = true;
    else if (argument === "--disabled-root")
      options.disabledRoot = argv[++index];
    else if (argument === "--disabled-sha") options.disabledSha = argv[++index];
    else if (argument === "--restored-root")
      options.restoredRoot = argv[++index];
    else if (argument === "--restored-sha") options.restoredSha = argv[++index];
    else if (argument === "--aroma-binding-proof")
      options.aromaBindingProof = true;
    else if (argument === "--aroma-cart-proof") options.aromaCartProof = true;
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--project-name") {
      const value = argv[++index];
      if (!value || !/^[a-z0-9][a-z0-9_-]*$/.test(value))
        throw new Error(
          "--project-name must be a lowercase Compose project name",
        );
      options.projectName = value;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option ${argument}\n\n${usage()}`);
    }
  }
  if (options.browserProof) {
    if (
      argv.length !== 1 ||
      options.stubSecrets ||
      options.provisionNetwork ||
      options.noBuild ||
      options.keep ||
      options.databaseProof ||
      options.customerProof ||
      options.recoveryProof ||
      options.mutationDisableRollback ||
      options.aromaBindingProof ||
      options.aromaCartProof ||
      options.projectName
    )
      throw new Error(
        "--browser-proof must be the only option; it selects the bounded recovery proof",
      );
    options.recoveryProof = true;
  }
  if (
    [
      options.databaseProof,
      options.customerProof,
      options.recoveryProof,
      options.mutationDisableRollback,
      options.aromaBindingProof,
      options.aromaCartProof,
    ].filter(Boolean).length > 1
  )
    throw new Error(
      "--database-proof, --customer-proof, --recovery-proof, --aroma-binding-proof and --aroma-cart-proof are mutually exclusive",
    );
  if (options.observabilityFixture && !options.recoveryProof)
    throw new Error(
      "--observability-fixture requires programmatic observability hooks and isolated --recovery-proof",
    );
  if (options.recoveryProof && options.stubSecrets)
    throw new Error(
      "--recovery-proof requires generated fixture credentials, not --stub-secrets",
    );
  if (options.mutationDisableRollback) {
    if (
      options.stubSecrets ||
      options.noBuild ||
      options.keep ||
      !options.projectName ||
      !options.disabledRoot ||
      !COMMIT_SHA.test(options.disabledSha ?? "") ||
      !options.restoredRoot ||
      !COMMIT_SHA.test(options.restoredSha ?? "")
    ) {
      throw new Error(
        "--mutation-disable-rollback requires source builds, an isolated project name and validated D/R checkouts",
      );
    }
    options.recoveryProof = true;
  }
  if (
    !options.stubSecrets &&
    !options.databaseProof &&
    !options.customerProof &&
    !options.recoveryProof &&
    !options.aromaBindingProof &&
    !options.aromaCartProof &&
    !process.env.SOPS_AGE_KEY_FILE
  ) {
    throw new Error(
      "SOPS_AGE_KEY_FILE is required for decrypted scoped secrets; use --stub-secrets only for topology smoke without DB/provider proof",
    );
  }
  return options;
}

function composeArgs(projectName, args, composeFile = COMPOSE_FILE) {
  return [
    "compose",
    "--project-name",
    projectName,
    "-f",
    COMPOSE_FILE,
    ...(composeFile === COMPOSE_FILE ? [] : ["-f", composeFile]),
    ...args,
  ];
}

function runCompose(projectName, secretsDir, args, options = {}) {
  const env = {
    ...process.env,
    COFFEE_COMPOSE_SECRETS_DIR: secretsDir,
  };
  return execFileSync(
    "docker",
    composeArgs(projectName, args, options.composeFile),
    {
      cwd: ROOT,
      env,
      encoding: "utf8",
      stdio: options.inherit
        ? "inherit"
        : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    },
  );
}

function spawnCompose(projectName, secretsDir, args, options = {}) {
  const env = {
    ...process.env,
    COFFEE_COMPOSE_SECRETS_DIR: secretsDir,
  };
  const child = spawn(
    "docker",
    composeArgs(projectName, args, options.composeFile),
    {
      cwd: ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    options.onOutput?.(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  child.stdin.end(options.input ?? "");
  const done = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({ output, errorOutput, signal });
      else
        reject(
          new Error(
            `docker compose exec exited ${code ?? signal}: ${errorOutput.trim()}`,
          ),
        );
    });
  });
  return { child, done };
}

function runDocker(args, options = {}) {
  return execFileSync("docker", args, {
    cwd: ROOT,
    encoding: "utf8",
    env:
      options.env === undefined
        ? process.env
        : { ...process.env, ...options.env },
    stdio: options.inherit
      ? "inherit"
      : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
}

function runDockerAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: ROOT,
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let errorOutput = "";
    if (!options.inherit) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        errorOutput += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`docker exited ${code ?? signal}: ${errorOutput.trim()}`),
        );
    });
  });
}

export function buildRuntimeImages(
  projectName,
  runtimes = RUNTIMES,
  builtImages = [],
  buildRoot = ROOT,
  { includeNginx = true } = {},
) {
  const sourceRoot = resolve(buildRoot);
  for (const runtime of runtimes) {
    execFileSync(
      process.execPath,
      [
        join(ROOT, "tools/docker-build.mjs"),
        "--build-arg",
        `RUNTIME=${runtime}`,
        "--target",
        "runtime",
        "--load",
        "-t",
        `${projectName}-${runtime}:latest`,
        sourceRoot,
      ],
      { cwd: ROOT, env: process.env, stdio: "inherit" },
    );
    builtImages.push(`${projectName}-${runtime}:latest`);
  }
  if (!includeNginx) return;
  execFileSync(
    process.execPath,
    [
      join(ROOT, "tools/docker-build.mjs"),
      "--file",
      "apps/edge-nginx/Dockerfile",
      "--target",
      "edge-nginx",
      "--load",
      "-t",
      `${projectName}-edge-nginx:latest`,
      sourceRoot,
    ],
    { cwd: ROOT, env: process.env, stdio: "inherit" },
  );
  builtImages.push(`${projectName}-edge-nginx:latest`);
}

export function removeBuiltRuntimeImages(images, options) {
  if (options.keep || options.noBuild) return;
  for (const image of images) {
    try {
      runDocker(["image", "rm", "--no-prune", image]);
    } catch {
      console.warn(`compose-smoke: image cleanup failed, preserved ${image}`);
    }
  }
}

export function runtimeImageBuildTargets(projectName, pending, customerOnly) {
  const references = new Set(pending.map(([reference]) => reference));
  return {
    runtimes: (customerOnly ? [DATABASE_PROOF_RUNTIME] : RUNTIMES).filter(
      (service) => references.has(`${projectName}-${service}:latest`),
    ),
    nginx: references.has(`${projectName}-edge-nginx:latest`),
  };
}

export function assertVerifiedRuntimeImages({
  projectName,
  verifiedImages,
  noBuild = false,
  directImageIds = false,
}) {
  const images = new Map(
    verifiedImages.map(({ service, imageId }) => [service, imageId]),
  );
  for (const service of [...RUNTIMES, "edge-nginx"]) {
    const expected = images.get(service);
    assert.match(
      expected ?? "",
      /^sha256:[a-f0-9]{64}$/u,
      `supply_chain image ID missing for ${service}`,
    );
    const reference = directImageIds
      ? expected
      : service === "edge-nginx" && noBuild
        ? "coffee-platform-edge-nginx:local"
        : `${projectName}-${service}:latest`;
    const actual = runDocker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      reference,
    ]).trim();
    assert.equal(
      actual,
      expected,
      `${service} image differs from the scanned supply_chain artifact`,
    );
  }
}

/**
 * Проверяет, что образы, опубликованные `supply_chain`, действительно лежат в daemon под
 * тегами проекта запуска: Compose запускает именно эти неизменяемые ID.
 */
export function assertPublishedRuntimeImages(inventory) {
  for (const image of inventory.images) {
    const actual = runDocker([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      image.tag,
    ]).trim();
    assert.equal(
      actual,
      image.imageId,
      `${image.service} image is missing from the published supply_chain inventory`,
    );
  }
}

/**
 * Доказывает, что запущенные контейнеры используют именно образы, опубликованные
 * `supply_chain`, а не пересобранные локально.
 */
export function assertRuntimeContainersMatchInventory(
  projectName,
  inventory,
  { requireComplete = true } = {},
) {
  const expected = new Map(
    inventory.images.map((image) => [image.service, image.imageId]),
  );
  const containerIds = runDocker([
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const containerId of containerIds) {
    const [service, imageId] = runDocker([
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}',
      containerId,
    ])
      .trim()
      .split("|");
    const expectedImageId = expected.get(service);
    if (expectedImageId === undefined) continue;
    assert.equal(
      imageId,
      expectedImageId,
      `${service} container runs an image outside the published supply_chain inventory`,
    );
    expected.delete(service);
  }
  // Целевые proof-стеки (--database-proof/--customer-proof/--aroma-*) поднимают
  // только часть сервисов, поэтому полнота требуется лишь для полного стека.
  if (requireComplete)
    assert.equal(
      expected.size,
      0,
      `runtime containers missing from the stack: ${[...expected.keys()].join(", ")}`,
    );
}

async function writeStubSecret(
  path,
  runtime,
  environment,
  refs,
  optionalRefs,
  databaseCredential,
  kafkaCredential,
  transportMaterial,
  publicTlsMaterial,
  securityMaterial,
) {
  // Ephemeral credentials belong only to this isolated run; placeholders do
  // not establish provider access or canonical SOPS provisioning.
  const secrets = {};
  for (const ref of refs) {
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(current, segment)) current[segment] = {};
      current = current[segment];
    }
    current[segments.at(-1)] =
      securityMaterial?.[ref] ??
      (ref === `security.serviceTransportKeys.${runtime}`
        ? transportMaterial
        : ref === "aroma.email"
          ? "aroma-safe-read@example.invalid"
          : ref === "aroma.password"
            ? "compose-aroma-fixture-password"
            : ref === "edge.tlsPrivateKey" && publicTlsMaterial !== undefined
              ? publicTlsMaterial.keyPem
              : ref === "edge.tlsCertificate" && publicTlsMaterial !== undefined
                ? publicTlsMaterial.certPem
                : ref.startsWith("postgres.") &&
                    databaseCredential !== undefined
                  ? databaseCredential
                  : ref.startsWith("kafka.") && kafkaCredential !== undefined
                    ? kafkaCredential
                    : ref.startsWith("postgres.")
                      ? {
                          username: `compose_${runtime.replaceAll("-", "_")}`,
                          password: "compose-smoke-placeholder",
                        }
                      : "compose-smoke-placeholder");
  }
  for (const ref of optionalRefs) {
    const value =
      ref === "edge.tlsCaBundle" ? publicTlsMaterial?.caPem : undefined;
    if (value === undefined) continue;
    const segments = ref.split(".");
    let current = secrets;
    for (const segment of segments.slice(0, -1)) {
      if (!Object.hasOwn(current, segment)) current[segment] = {};
      current = current[segment];
    }
    current[segments.at(-1)] = value;
  }
  const content = `${JSON.stringify({ schemaVersion: 1, environment, runtime, secrets })}\n`;
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
}

function createEd25519KeySet() {
  const keyPair = () => generateKeyPairSync("ed25519");
  const active = keyPair();
  const previous = keyPair();
  const publicPem = (key) => key.export({ type: "spki", format: "pem" });
  return {
    privateKey: active.privateKey.export({ type: "pkcs8", format: "pem" }),
    verificationKeys: {
      active: publicPem(active.publicKey),
      previous: publicPem(previous.publicKey),
    },
  };
}

function createStubSecurityMaterial() {
  const actor = createEd25519KeySet();
  const apiPublicDelegation = createEd25519KeySet();
  const apiInternalDelegation = createEd25519KeySet();
  const ordersService = createEd25519KeySet();
  const pricingService = createEd25519KeySet();
  const customerCursor = createEd25519KeySet();
  const catalogCursor = createEd25519KeySet();
  return {
    "security.actorContextEdgeSigningPrivateKey": actor.privateKey,
    "security.actorContextEdgeVerificationPublicKeys": actor.verificationKeys,
    "security.apiPublicDelegationSigningPrivateKey":
      apiPublicDelegation.privateKey,
    "security.apiInternalDelegationSigningPrivateKey":
      apiInternalDelegation.privateKey,
    "security.ordersServiceDelegationSigningPrivateKey":
      ordersService.privateKey,
    "security.serviceVerificationKeys.orders-service":
      ordersService.verificationKeys,
    "security.serviceVerificationKeys.pricing-service":
      pricingService.verificationKeys,
    "security.pricingServiceDelegationSigningPrivateKey":
      pricingService.privateKey,
    "security.customerCursorSigningPrivateKey": customerCursor.privateKey,
    "security.customerCursorVerificationPublicKeys":
      customerCursor.verificationKeys,
    "security.catalogCursorSigningPrivateKey": catalogCursor.privateKey,
    "security.delegationVerificationKeys.api-public":
      apiPublicDelegation.verificationKeys,
    "security.delegationVerificationKeys.api-internal":
      apiInternalDelegation.verificationKeys,
  };
}

async function writeCustomerProofFixtures(
  secretsDir,
  securityMaterial,
  transportMaterials,
) {
  const fixtures = {
    signing: join(secretsDir, "customer-test-signing.json"),
    publicTransport: join(secretsDir, "customer-test-api-public.json"),
    internalTransport: join(secretsDir, "customer-test-api-internal.json"),
  };
  await writeFile(
    fixtures.signing,
    JSON.stringify({
      public: securityMaterial["security.apiPublicDelegationSigningPrivateKey"],
      internal:
        securityMaterial["security.apiInternalDelegationSigningPrivateKey"],
    }) + "\n",
    { encoding: "utf8", mode: 0o400 },
  );
  await writeFile(
    fixtures.publicTransport,
    transportMaterials.service.get("api-public"),
    { encoding: "utf8", mode: 0o400 },
  );
  await writeFile(
    fixtures.internalTransport,
    transportMaterials.service.get("api-internal"),
    { encoding: "utf8", mode: 0o400 },
  );
  for (const path of Object.values(fixtures)) await chmod(path, 0o400);
  return fixtures;
}

async function createStubTransportMaterials(
  secretsDir,
  environment,
  publicHostname,
) {
  const directory = join(secretsDir, "transport-ca");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serial = join(directory, "ca.srl");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=coffee-platform-compose-smoke-ca",
    ],
    { stdio: "ignore" },
  );
  const caPem = await readFile(caCert, "utf8");
  const materials = new Map();
  for (const [index, runtime] of [...RUNTIMES, "edge-nginx"].entries()) {
    const prefix = join(directory, runtime);
    const key = `${prefix}.key`;
    const csr = `${prefix}.csr`;
    const cert = `${prefix}.crt`;
    const ext = `${prefix}.ext`;
    await writeFile(
      ext,
      [
        `subjectAltName=URI:spiffe://coffee-platform/${environment}/${runtime},DNS:${runtime}.${environment}.svc.coffee-platform.internal`,
        "extendedKeyUsage=serverAuth,clientAuth",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o400 },
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        csr,
        "-subj",
        `/CN=${runtime}`,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        ...(index === 0 ? ["-CAcreateserial"] : ["-CAserial", serial]),
        "-out",
        cert,
        "-days",
        "1",
        "-sha256",
        "-extfile",
        ext,
      ],
      { stdio: "ignore" },
    );
    const sanOutput = execFileSync(
      "openssl",
      ["x509", "-in", cert, "-noout", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    assert.match(
      sanOutput,
      new RegExp(
        `URI:spiffe://coffee-platform/${environment}/${runtime}(?:,|\\s)`,
      ),
    );
    assert.match(
      sanOutput,
      new RegExp(
        `DNS:${runtime}\\.${environment}\\.svc\\.coffee-platform\\.internal`,
      ),
    );
    materials.set(
      runtime,
      JSON.stringify({
        caPem,
        certPem: await readFile(cert, "utf8"),
        keyPem: await readFile(key, "utf8"),
      }),
    );
  }
  const publicCaKey = join(directory, "edge-public-ca.key");
  const publicCaCert = join(directory, "edge-public-ca.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      publicCaKey,
      "-out",
      publicCaCert,
      "-days",
      "1",
      "-subj",
      "/CN=coffee-platform-compose-public-ca",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    { stdio: "ignore" },
  );
  const publicCaPem = await readFile(publicCaCert, "utf8");
  const publicKey = join(directory, "edge-public.key");
  const publicCsr = join(directory, "edge-public.csr");
  const publicCert = join(directory, "edge-public.crt");
  const publicExt = join(directory, "edge-public.ext");
  await writeFile(
    publicExt,
    [
      `subjectAltName=DNS:${publicHostname}`,
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o400 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      publicKey,
      "-out",
      publicCsr,
      "-subj",
      `/CN=${publicHostname}`,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      publicCsr,
      "-CA",
      publicCaCert,
      "-CAkey",
      publicCaKey,
      "-CAcreateserial",
      "-out",
      publicCert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      publicExt,
    ],
    { stdio: "ignore" },
  );
  return {
    service: materials,
    publicTls: {
      keyPem: await readFile(publicKey, "utf8"),
      certPem: await readFile(publicCert, "utf8"),
      caPem: publicCaPem,
    },
  };
}

export async function readDatabaseProofCredentials(launchIdentity) {
  let ownership = await readJson(join(ROOT, "config/database-ownership.json"));
  let roleMap = await readJson(join(ROOT, "config/database-role-map.json"));
  if (launchIdentity)
    ({ ownership } = projectLaunchDatabaseTargets({
      ownership,
      roleMap,
      launchIdentity,
    }));
  const owner = ownership.runtimeClaims.find(
    (candidate) => candidate.runtime === DATABASE_PROOF_RUNTIME,
  );
  assert.ok(owner, `${DATABASE_PROOF_RUNTIME} database ownership is missing`);
  assert.ok(owner.role, `${DATABASE_PROOF_RUNTIME} database role is missing`);
  assert.match(owner.role, /^[a-z][a-z0-9_]*$/);
  const database = ownership.databases.find(
    (candidate) => candidate.owner === "customer",
  );
  assert.ok(
    database && owner.database === database.name,
    "customer proof database does not match the canonical customer ownership claim",
  );
  return {
    databaseName: database.name,
    launchIdentity,
    owner: {
      username: owner.role,
      password: `compose-proof-${randomUUID()}`,
    },
    admin: {
      username: `compose_admin_${randomUUID().replaceAll("-", "")}`,
      password: `compose-admin-${randomUUID()}`,
    },
  };
}

export async function readRecoveryProofCredentials(launchIdentity) {
  let ownership = await readJson(join(ROOT, "config/database-ownership.json"));
  let roleMap = await readJson(join(ROOT, "config/database-role-map.json"));
  if (launchIdentity)
    ({ ownership, roleMap } = projectLaunchDatabaseTargets({
      ownership,
      roleMap,
      launchIdentity,
    }));
  const runtimeClaims = ownership.runtimeClaims.filter(
    (claim) => claim.database !== null && claim.role !== null,
  );
  assert.equal(
    ownership.databases.length,
    5,
    "recovery proof requires five owner databases",
  );
  assert.equal(
    runtimeClaims.length,
    10,
    "recovery proof requires ten runtime database roles",
  );
  const rolePasswords = Object.fromEntries(
    roleMap.databases.flatMap((database) => [
      [database.migratorRole, `compose-migrator-${randomUUID()}`],
      ...database.runtimeRoles.map((runtime) => [
        runtime.role,
        `compose-runtime-${randomUUID()}`,
      ]),
    ]),
  );
  const admin = {
    username: `compose_admin_${randomUUID().replaceAll("-", "")}`,
    password: `compose-admin-${randomUUID()}`,
  };
  return {
    roleMap,
    ownership,
    launchIdentity,
    admin,
    rolePasswords,
    databaseCredentialsByRuntime: Object.fromEntries(
      runtimeClaims.map((claim) => [
        claim.runtime,
        { username: claim.role, password: rolePasswords[claim.role] },
      ]),
    ),
  };
}

export async function readExternalRecoveryProofCredentials(
  launchIdentity,
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  launchMetadata,
) {
  assert.ok(launchIdentity, "external recovery proof needs a launch context");
  assert.deepEqual(
    Object.keys(launchMetadata ?? {}).sort(),
    ["candidateRoot", "expectedLineage", "resources"],
    "external recovery launch metadata has a closed shape",
  );
  assert.ok(
    ["compose", "observability", "browser"].includes(
      launchMetadata.expectedLineage,
    ),
    "external recovery launch lineage is invalid",
  );
  assert.equal(typeof launchMetadata.candidateRoot, "string");
  const resources = launchMetadata.resources;
  assert.ok(
    resources !== null &&
      typeof resources === "object" &&
      !Array.isArray(resources),
    "external recovery launch resources are invalid",
  );
  const hasPreparationContextPath =
    resources !== undefined &&
    resources !== null &&
    Object.hasOwn(resources, "g08PreparationContextPath");
  const hasBrowserParentMetadata =
    resources !== undefined &&
    resources !== null &&
    ["g15ParentCandidateSha", "g15ParentCheckoutRoot", "g15ParentRunId"].some(
      (key) => Object.hasOwn(resources, key),
    );
  const browserPreparationContextPath = hasPreparationContextPath
    ? resources.g08PreparationContextPath
    : undefined;
  if (
    (hasPreparationContextPath &&
      (typeof browserPreparationContextPath !== "string" ||
        browserPreparationContextPath.length === 0)) ||
    (hasBrowserParentMetadata && !hasPreparationContextPath)
  )
    throw new Error("browser parent preparation reference is missing");
  const hasAllBrowserParentMetadata =
    resources !== undefined &&
    resources !== null &&
    ["g15ParentCandidateSha", "g15ParentCheckoutRoot", "g15ParentRunId"].every(
      (key) => Object.hasOwn(resources, key),
    );
  if (
    ["compose", "observability"].includes(launchMetadata.expectedLineage) &&
    (hasPreparationContextPath || hasBrowserParentMetadata)
  )
    throw new Error(
      "external recovery lineage metadata cannot downgrade to compose/observability",
    );
  if (
    launchMetadata.expectedLineage === "browser" &&
    (!hasPreparationContextPath || !hasAllBrowserParentMetadata)
  )
    throw new Error("browser parent preparation reference is missing");
  const configRoot = launchMetadata.candidateRoot;
  const preparationSource = hasPreparationContextPath
    ? { preparationContextPath: browserPreparationContextPath }
    : {};
  const postgres = await readPreparedPostgresIdentity({
    root: configRoot,
    contextPath,
    ...preparationSource,
  });
  assert.deepEqual(
    {
      host: postgres.host,
      port: postgres.port,
      version: postgres.version,
      database: postgres.database,
      user: postgres.user,
    },
    {
      host: "coffee_postgres",
      port: 5432,
      version: "17.11",
      database: "postgres",
      user: "coffeeuser",
    },
    "external recovery proof requires the prepared canonical PostgreSQL target",
  );
  assert.equal(
    postgres.systemIdentifier,
    APPROVED_EXTERNAL_POSTGRES.systemIdentifier,
    "external recovery proof target differs from the approved PostgreSQL system identifier",
  );
  const ownership = await readJson(
    join(configRoot, "config/database-ownership.json"),
  );
  const roleMap = await readJson(
    join(configRoot, "config/database-role-map.json"),
  );
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity,
  });
  assert.equal(projected.ownership.databases.length, 5);
  const ownerByDatabase = new Map(
    projected.ownership.databases.map((database) => [database.name, database]),
  );
  const adminOwner = projected.ownership.databases[0].owner;
  const admin = await readMigrationCredential({
    root: configRoot,
    contextPath,
    owner: adminOwner,
    kind: "admin",
    expectedSystemIdentifier: postgres.systemIdentifier,
    ...preparationSource,
  });
  const rolePasswords = {};
  for (const database of projected.roleMap.databases) {
    const ownerDatabase = ownerByDatabase.get(database.name);
    assert.ok(
      ownerDatabase,
      "external recovery database owner is not canonical",
    );
    const migrator = await readMigrationCredential({
      root: configRoot,
      contextPath,
      owner: ownerDatabase.owner,
      kind: "migrator",
      expectedSystemIdentifier: postgres.systemIdentifier,
      ...preparationSource,
    });
    assert.equal(migrator.username, database.migratorRole);
    rolePasswords[migrator.username] = migrator.password;
  }
  const runtimeClaims = projected.ownership.runtimeClaims.filter(
    (claim) => claim.database !== null && claim.role !== null,
  );
  assert.equal(runtimeClaims.length, 10);
  const databaseCredentialsByRuntime = {};
  for (const claim of runtimeClaims) {
    const ownerDatabase = ownerByDatabase.get(claim.database);
    const roleDatabase = projected.roleMap.databases.find(
      (database) => database.name === claim.database,
    );
    assert.ok(ownerDatabase && roleDatabase);
    const role = roleDatabase.runtimeRoles.find(
      (candidate) => candidate.runtime === claim.runtime,
    );
    assert.equal(role?.role, claim.role);
    const runtimeCredential = await readMigrationCredential({
      root: configRoot,
      contextPath,
      owner: ownerDatabase.owner,
      kind: "runtime",
      runtime: claim.runtime,
      expectedSystemIdentifier: postgres.systemIdentifier,
      ...preparationSource,
    });
    assert.equal(runtimeCredential.username, claim.role);
    rolePasswords[claim.role] = runtimeCredential.password;
    databaseCredentialsByRuntime[claim.runtime] = runtimeCredential;
  }
  return {
    roleMap: projected.roleMap,
    ownership: projected.ownership,
    launchIdentity,
    candidateRoot: configRoot,
    postgres,
    g08PreparationContextPath: browserPreparationContextPath,
    browserParentRoot: hasPreparationContextPath
      ? resources.g15ParentCheckoutRoot
      : undefined,
    admin,
    rolePasswords,
    databaseCredentialsByRuntime,
  };
}

export async function loadVerifiedBrowserParentModules(parentRoot) {
  const [images, report] = await Promise.all([
    import(
      pathToFileURL(join(parentRoot, "tools/verified-infrastructure-image.mjs"))
        .href
    ),
    import(
      pathToFileURL(join(parentRoot, "verification/launch/v1/report.mjs")).href
    ),
  ]);
  return { images, validateLaunchContext: report.validateLaunchContext };
}

export function projectRecoveryPlatformConfig(platformConfig, ownership) {
  const services = { ...platformConfig.services };
  for (const claim of ownership.runtimeClaims) {
    if (claim.database === null) continue;
    const owner = ownership.databases.find(
      (database) => database.name === claim.database,
    )?.owner;
    assert.ok(owner, `derived database owner is missing for ${claim.runtime}`);
    const service = platformConfig.services[claim.runtime];
    assert.ok(
      service,
      `database runtime config is missing for ${claim.runtime}`,
    );
    assert.equal(
      service.database,
      `coffee_platform_${owner}`,
      `canonical platform config database differs from ${claim.runtime} ownership before projection`,
    );
    services[claim.runtime] = { ...service, database: claim.database };
  }
  return { ...platformConfig, services };
}

export function externalRecoveryMigrationCredentialRequest(
  credentials,
  contextPath,
  owner,
) {
  return {
    root: credentials.candidateRoot ?? ROOT,
    contextPath,
    owner,
    kind: "migrator",
    expectedSystemIdentifier: credentials.postgres.systemIdentifier,
    ...(typeof credentials.g08PreparationContextPath === "string"
      ? { preparationContextPath: credentials.g08PreparationContextPath }
      : {}),
  };
}

export function retainObservabilityAfterCollectorFailure({
  observabilityBrowser,
  observability,
  cleanupHookError,
  options,
  databases,
}) {
  if (!(observabilityBrowser && observability && cleanupHookError))
    return undefined;
  options.keep = true;
  return {
    verified: false,
    removed: [],
    retained: databases.map(({ database }) => database.name),
    failure: "OBSERVABILITY_COLLECTOR_RESTORE_UNCONFIRMED",
  };
}

export function externalRecoveryCleanupSummary({
  databases,
  attachment,
  cleanupFailed = false,
}) {
  const databaseCleanup = databases ?? {
    verified: false,
    removed: [],
    retained: [],
    failure: "DATABASE_CLEANUP_NOT_CONFIRMED",
  };
  const baselineAttached = attachment?.baselineAttached === true;
  const attempted = attachment?.attempted === true;
  const removed = attachment?.absenceConfirmed === true;
  const attachmentVerified = baselineAttached
    ? !attempted && !removed && attachment.baselineConfirmed === true
    : attempted && removed;
  const routePreserved =
    typeof attachment?.routeBefore === "string" &&
    attachment.routeAfter === attachment.routeBefore;
  const verified =
    databaseCleanup.verified === true &&
    attachmentVerified &&
    routePreserved &&
    cleanupFailed !== true;
  const failure = !verified
    ? databaseCleanup.verified !== true
      ? (databaseCleanup.failure ?? "DATABASE_CLEANUP_UNVERIFIED")
      : !attachmentVerified
        ? baselineAttached
          ? "POSTGRES_BASELINE_UNVERIFIED"
          : "POSTGRES_ATTACHMENT_RETAINED"
        : !routePreserved
          ? "POSTGRES_ROUTE_UNVERIFIED"
          : "EXTERNAL_CLEANUP_FAILED"
    : undefined;
  return {
    verified,
    databases: databaseCleanup,
    attachment: { baselineAttached, attempted, removed, routePreserved },
    ...(failure ? { failure } : {}),
  };
}

export function databaseProofService(platformConfig, ownership, runtime) {
  const service = platformConfig.services[runtime];
  const claim = ownership.runtimeClaims.find(
    (candidate) => candidate.runtime === runtime,
  );
  const database =
    claim &&
    ownership.databases.find((candidate) => candidate.name === claim.database);
  assert.ok(
    service && claim && database,
    `${runtime} proof database ownership is missing`,
  );
  assert.equal(
    service.database,
    claim.database,
    `${runtime} proof config does not use its owned database target`,
  );
  return service;
}

export function bootstrapEnvironment(
  path,
  sourceEnvironment = process.env,
  root = ROOT,
) {
  const env = {};
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (!key.startsWith("COFFEE_") && !key.startsWith("SOPS_"))
      env[key] = value;
  }
  env.COFFEE_CONFIG_FILE = join(root, "config/platform.yaml");
  env.COFFEE_RUNTIME_SECRETS_FILE = path;
  if (sourceEnvironment.SOPS_AGE_KEY_FILE)
    env.SOPS_AGE_KEY_FILE = sourceEnvironment.SOPS_AGE_KEY_FILE;
  return env;
}

async function materializeSecrets(secretsDir, options) {
  const configRoot = options.configRoot ?? ROOT;
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  const kafkaCredential = await materializeKafkaTls(secretsDir);
  const platformConfig = parseYaml(
    await readFile(join(configRoot, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const publicHostname = parsePublicTlsHostname(
    platformConfig.platform?.publicBaseUrl,
  );
  const stubTransportMaterials =
    options.stubSecrets ||
    options.databaseProof ||
    options.customerProof ||
    options.recoveryProof ||
    options.aromaBindingProof ||
    options.aromaCartProof
      ? await createStubTransportMaterials(
          secretsDir,
          platformConfig.environment,
          publicHostname,
        )
      : undefined;
  const stubSecurityMaterial =
    stubTransportMaterials === undefined
      ? undefined
      : {
          ...createStubSecurityMaterial(),
          ...(options.observabilityExporterToken === undefined
            ? {}
            : {
                "telemetry.exporterToken": options.observabilityExporterToken,
              }),
        };
  for (const runtime of RUNTIMES) {
    const path = join(secretsDir, `${runtime}.yaml`);
    if (
      options.stubSecrets ||
      options.databaseProof ||
      options.customerProof ||
      options.recoveryProof ||
      options.aromaBindingProof ||
      options.aromaCartProof
    ) {
      const service = platformConfig.services[runtime];
      await writeStubSecret(
        path,
        runtime,
        platformConfig.environment,
        service.secretRefs,
        service.optionalSecretRefs ?? [],
        options.databaseProofCredentials?.[runtime] ??
          options.recoveryProofCredentials?.databaseCredentialsByRuntime?.[
            runtime
          ],
        options.stubSecrets ||
          options.recoveryProof ||
          options.aromaBindingProof ||
          options.aromaCartProof
          ? kafkaCredential
          : undefined,
        stubTransportMaterials?.service.get(runtime),
        runtime === "edge-gateway"
          ? stubTransportMaterials?.publicTls
          : undefined,
        stubSecurityMaterial,
      );
    } else {
      execFileSync(process.execPath, [BOOTSTRAP, "--runtime", runtime], {
        cwd: ROOT,
        env: bootstrapEnvironment(path, process.env, configRoot),
        encoding: "utf8",
        stdio: ["ignore", "ignore", "pipe"],
      });
      const kafkaRefs = platformConfig.services[runtime].secretRefs.filter(
        (ref) => ref.startsWith("kafka."),
      );
      const databaseCredential =
        options.recoveryProofCredentials?.databaseCredentialsByRuntime?.[
          runtime
        ];
      const databaseRefs = databaseCredential
        ? platformConfig.services[runtime].secretRefs.filter((ref) =>
            ref.startsWith("postgres."),
          )
        : [];
      if (databaseCredential) assert.ok(databaseRefs.length > 0);
      if (kafkaRefs.length > 0 || databaseRefs.length > 0) {
        const document = parseYaml(await readFile(path, "utf8"), {
          json: true,
        });
        for (const [ref, credential] of [
          ...kafkaRefs.map((ref) => [ref, kafkaCredential]),
          ...databaseRefs.map((ref) => [ref, databaseCredential]),
        ]) {
          const segments = ref.split(".");
          let target = document.secrets;
          for (const segment of segments.slice(0, -1))
            target = target[segment] ??= {};
          target[segments.at(-1)] = credential;
        }
        await chmod(path, 0o600);
        await writeFile(
          path,
          dumpYaml(document, { noRefs: true, lineWidth: 120 }),
          { encoding: "utf8", mode: 0o400 },
        );
        await chmod(path, 0o400);
      }
    }
    // Docker Compose's local file-secret backend ignores long-syntax uid/gid/mode
    // and bind-mounts the source inode. Own it by the exact non-root runtime UID
    // before Compose starts so the container can read mode 0400 without secrets
    // ever touching persistent storage.
    await chown(path, 1000, 1000);
    const fileStat = await stat(path);
    assert.equal(
      fileStat.mode & 0o777,
      0o400,
      `${runtime} scoped secret mode must be 0400`,
    );
    assert.equal(
      fileStat.uid,
      1000,
      `${runtime} scoped secret owner must be UID 1000`,
    );
    assert.equal(
      fileStat.gid,
      1000,
      `${runtime} scoped secret group must be GID 1000`,
    );
  }
  const nginxPath = join(secretsDir, "edge-nginx");
  if (
    options.stubSecrets ||
    options.databaseProof ||
    options.customerProof ||
    options.recoveryProof ||
    options.aromaBindingProof ||
    options.aromaCartProof
  ) {
    const runtime = "edge-nginx";
    const service = platformConfig.services[runtime];
    const refs = service?.secretRefs ?? [
      "edge.tlsPrivateKey",
      "edge.tlsCertificate",
      "security.serviceTransportKeys.edge-nginx",
    ];
    const optionalRefs = service?.optionalSecretRefs ?? [];
    const documentPath = join(secretsDir, "edge-nginx.yaml");
    await writeStubSecret(
      documentPath,
      runtime,
      platformConfig.environment,
      refs,
      optionalRefs,
      undefined,
      undefined,
      stubTransportMaterials.service.get(runtime),
      stubTransportMaterials.publicTls,
      stubSecurityMaterial,
    );
    const document = parseYaml(await readFile(documentPath, "utf8"), {
      json: true,
    });
    const transport = JSON.parse(
      document.secrets.security.serviceTransportKeys[runtime],
    );
    const files = {
      "public.crt": document.secrets.edge.tlsCertificate,
      "public.key": document.secrets.edge.tlsPrivateKey,
      "upstream-ca.crt": transport.caPem,
      "client.crt": transport.certPem,
      "client.key": transport.keyPem,
    };
    await mkdir(nginxPath, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(files)) {
      const path = join(nginxPath, name);
      await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
      await chmod(path, 0o400);
    }
    await ensureNginxSecretOwnership(nginxPath);
    await rm(documentPath, { force: true });
  } else {
    execFileSync(process.execPath, [BOOTSTRAP, "--runtime", "edge-nginx"], {
      cwd: ROOT,
      env: bootstrapEnvironment(nginxPath, process.env, configRoot),
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  }
  return {
    kafkaCredential,
    securityMaterial: stubSecurityMaterial,
    transportMaterials: stubTransportMaterials,
  };
}

async function materializeKafkaTls(secretsDir) {
  const kafkaDir = join(secretsDir, "kafka");
  await mkdir(kafkaDir, { recursive: true, mode: 0o700 });
  const password = randomUUID();
  const keystore = join(kafkaDir, "kafka.keystore.p12");
  const certificate = join(kafkaDir, "kafka.crt");
  const truststore = join(kafkaDir, "kafka.truststore.p12");
  execFileSync(
    "keytool",
    [
      "-genkeypair",
      "-alias",
      "kafka",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "1",
      "-dname",
      "CN=kafka",
      "-ext",
      "SAN=dns:kafka,dns:localhost,ip:127.0.0.1",
      "-keystore",
      keystore,
      "-storetype",
      "PKCS12",
      "-storepass",
      password,
      "-keypass",
      password,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "keytool",
    [
      "-exportcert",
      "-alias",
      "kafka",
      "-keystore",
      keystore,
      "-storepass",
      password,
      "-rfc",
      "-file",
      certificate,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "keytool",
    [
      "-importcert",
      "-noprompt",
      "-alias",
      "kafka",
      "-file",
      certificate,
      "-keystore",
      truststore,
      "-storetype",
      "PKCS12",
      "-storepass",
      password,
    ],
    { stdio: "ignore" },
  );
  await writeFile(join(kafkaDir, "kafka.keystore.password"), `${password}\n`, {
    encoding: "utf8",
    mode: 0o400,
  });
  await writeFile(
    join(kafkaDir, "kafka_jaas.conf"),
    [
      "KafkaServer {",
      "  org.apache.kafka.common.security.plain.PlainLoginModule required",
      `  username="kafka" password="${password}" user_kafka="${password}";`,
      "};",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o400 },
  );
  await writeFile(
    join(kafkaDir, "client.properties"),
    [
      "security.protocol=SASL_SSL",
      "sasl.mechanism=PLAIN",
      `sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="kafka" password="${password}";`,
      "ssl.truststore.type=PKCS12",
      "ssl.truststore.location=/etc/kafka/secrets/kafka.truststore.p12",
      `ssl.truststore.password=${password}`,
      "ssl.endpoint.identification.algorithm=",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o400 },
  );
  for (const path of [kafkaDir, keystore, certificate, truststore]) {
    await chown(path, 1000, 1000);
  }
  for (const name of [
    "kafka.keystore.password",
    "kafka_jaas.conf",
    "client.properties",
  ]) {
    const path = join(kafkaDir, name);
    await chown(path, 1000, 1000);
    await chmod(path, 0o400);
  }
  return {
    username: "kafka",
    password,
    caPem: await readFile(certificate, "utf8"),
  };
}

function ensureExternalNetwork(options) {
  const assertInternal = () => {
    const [network] = JSON.parse(
      runDocker(["network", "inspect", EXTERNAL_POSTGRES_NETWORK]),
    );
    assert.equal(
      network?.Internal,
      true,
      `${EXTERNAL_POSTGRES_NETWORK} must be an existing Internal network`,
    );
  };
  try {
    runDocker(["network", "inspect", EXTERNAL_POSTGRES_NETWORK]);
    assertInternal();
    return false;
  } catch {
    if (!options.provisionNetwork) {
      throw new Error(
        `${EXTERNAL_POSTGRES_NETWORK} is absent; create the pre-existing PostgreSQL network first or explicitly use --provision-empty-postgres-network`,
      );
    }
    runDocker([
      "network",
      "create",
      "--internal",
      "--label",
      "coffee.platform.compose-smoke=true",
      EXTERNAL_POSTGRES_NETWORK,
    ]);
    assertInternal();
    return true;
  }
}

export async function writeScopedComposeOverride(projectName, options = {}) {
  const loggingOverride = options.runtimeLogging
    ? createRuntimeLoggingOverride({ config: options.runtimeLogging }).services
    : undefined;
  const path = join(
    SECRETS_TMPFS_ROOT,
    `coffee-platform-compose-${projectName}-${randomUUID().slice(0, 8)}.yaml`,
  );
  const serviceOverrides = new Map();
  const service = (name) => {
    let current = serviceOverrides.get(name);
    if (!current) {
      current = {};
      serviceOverrides.set(name, current);
    }
    return current;
  };
  const specialNetworks = new Map();
  if (options.aromaBindingProof) {
    specialNetworks.set("aroma-gateway", [
      "coffee_internal_api",
      "coffee_postgres_data",
    ]);
    Object.assign(service("aroma-gateway"), {
      networks: specialNetworks.get("aroma-gateway"),
      environment: {
        NODE_OPTIONS:
          "--enable-source-maps --import=/app/dist/.aroma-proof-tls-observer.mjs",
      },
      volumes: [
        "${COFFEE_COMPOSE_SECRETS_DIR}/aroma-gateway-tls-observer.mjs:/app/dist/.aroma-proof-tls-observer.mjs:ro",
      ],
    });
  }
  if (options.aromaCartProof || options.recoveryProof) {
    specialNetworks.set("aroma-gateway", [
      "coffee_internal_api",
      "coffee_postgres_data",
      "coffee_provider_egress",
    ]);
    const gateway = service("aroma-gateway");
    gateway.networks = specialNetworks.get("aroma-gateway");
    gateway.environment = {
      ...gateway.environment,
      NODE_EXTRA_CA_CERTS: "/run/aroma-proof/provider-ca.crt",
    };
    gateway.volumes = [
      ...(gateway.volumes ?? []),
      "${COFFEE_COMPOSE_SECRETS_DIR}/aroma-cart-proof:/run/aroma-proof:ro",
    ];
    Object.assign(service("aroma-provider-fixture"), {
      image: CUSTOMER_TEST_IMAGE,
      command: ["node", "/run/aroma-proof/provider-server.mjs"],
      networks: { coffee_provider_egress: { aliases: ["aromateacoffee.ru"] } },
      volumes: [
        "${COFFEE_COMPOSE_SECRETS_DIR}/aroma-cart-proof:/run/aroma-proof",
      ],
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "const net=require('node:net'); const socket=net.connect(443, '127.0.0.1', () => { socket.destroy(); process.exit(0); }); socket.on('error', () => process.exit(1));",
        ],
        interval: "1s",
        timeout: "1s",
        retries: 30,
      },
    });
    if (options.aromaConvergenceConfigPath) {
      service("aroma-convergence").volumes = [
        ...(service("aroma-convergence").volumes ?? []),
        {
          type: "bind",
          source: resolve(options.aromaConvergenceConfigPath),
          target: "/app/config/platform.yaml",
          read_only: true,
        },
      ];
    }
  }
  if (options.browserFixture) {
    const { browserFixture, candidateRoot } = options;
    assert.ok(
      resolve(candidateRoot) === candidateRoot &&
        resolve(browserFixture.fixtureRoot) === browserFixture.fixtureRoot,
      "browser fixture mount paths must be canonical",
    );
    const edge = service("edge-gateway");
    edge.environment = {
      ...edge.environment,
      NODE_EXTRA_CA_CERTS: "/run/g15-browser/idp-ca.crt",
    };
    edge.volumes = [
      ...(edge.volumes ?? []),
      {
        type: "bind",
        source: browserFixture.browser.caCertificatePath,
        target: "/run/g15-browser/idp-ca.crt",
        read_only: true,
      },
    ];
    Object.assign(service("g15-idp"), {
      image: CUSTOMER_TEST_IMAGE,
      command: [
        "node",
        "/workspace/tests/realtime/fixtures/oidc-provider.mjs",
        "--serve-g15",
        "/workspace",
        "/run/g15-idp",
      ],
      user: "1000:1000",
      init: true,
      restart: "no",
      stop_grace_period: "5s",
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      sysctls: { "net.ipv4.ip_unprivileged_port_start": 0 },
      cpus: 1,
      mem_limit: "256m",
      pids_limit: 64,
      tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=8m"],
      networks: {
        coffee_edge_backend: { aliases: ["idp.fixture.invalid"] },
      },
      volumes: [
        {
          type: "bind",
          source: join(browserFixture.fixtureRoot, "idp"),
          target: "/run/g15-idp",
          read_only: true,
        },
        {
          type: "bind",
          source: candidateRoot,
          target: "/workspace",
          read_only: true,
        },
        {
          type: "bind",
          source: join(candidateRoot, "node_modules"),
          target: "/workspace/node_modules",
          read_only: true,
        },
      ],
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "const s=require('node:net').connect(443,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));",
        ],
        interval: "1s",
        timeout: "1s",
        retries: 30,
      },
    });
  }
  if (options.observabilityConfig) {
    assert.ok(
      options.launchContextPath,
      "observability config requires child context",
    );
    const { path: configPath, sha256 } = options.observabilityConfig;
    assert.match(sha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(
      await realpath(configPath),
      configPath,
      "observability config path must be canonical",
    );
    const before = await lstat(configPath);
    assert.ok(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.uid === process.getuid() &&
        (before.mode & 0o777) === 0o444,
      "observability config must be sealed and owned",
    );
    const bytes = await readFile(configPath);
    const after = await lstat(configPath);
    assert.ok(
      before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs,
      "observability config identity changed",
    );
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      sha256,
      "observability config hash mismatch",
    );
  }
  if (options.launchContextPath) {
    for (const runtime of RUNTIMES) {
      const current = service(runtime);
      current.environment = {
        ...current.environment,
        COFFEE_LAUNCH_CONTEXT_FILE: "/run/coffee-launch/context.json",
      };
      current.volumes = [
        ...(current.volumes ?? []),
        {
          type: "bind",
          source: resolve(options.launchContextPath),
          target: "/run/coffee-launch/context.json",
          read_only: true,
        },
        ...(options.observabilityConfig
          ? [
              {
                type: "bind",
                source: options.observabilityConfig.path,
                target: "/app/config/platform.yaml",
                read_only: true,
              },
            ]
          : []),
      ];
    }
  }
  if (options.kafkaImage !== undefined) {
    assert.match(options.kafkaImage, /^sha256:[a-f0-9]{64}$/u);
    service("kafka").image = options.kafkaImage;
    service("kafka").pull_policy = "never";
  }
  // Поддерживаются обе формы: карта service→tag из инвентаря supply_chain и массив
  // {service, imageId} из ownership integration; Compose принимает image ID напрямую.
  if (options.runtimeImages !== undefined) {
    const entries = new Map(
      Array.isArray(options.runtimeImages)
        ? options.runtimeImages.map(({ service: name, imageId }) => [
            name,
            imageId,
          ])
        : Object.entries(options.runtimeImages),
    );
    for (const [name, reference] of entries) {
      assert.match(
        reference,
        /^(?:[a-z0-9][a-z0-9._/-]*:latest|sha256:[a-f0-9]{64})$/u,
      );
      service(name).image = reference;
      service(name).pull_policy = "never";
    }
    assert.equal(
      entries.size,
      RUNTIMES.length + 1,
      "runtime image inventory must contain exact 15 services",
    );
    for (const name of [...RUNTIMES, "edge-nginx"])
      assert.ok(entries.has(name), `runtime image is missing for ${name}`);
  }
  if (options.edgeNginxImage)
    service("edge-nginx").image = options.edgeNginxImage;
  if (loggingOverride) {
    for (const [name, definition] of Object.entries(loggingOverride)) {
      if (definition.logging) service(name).logging = definition.logging;
    }
  }
  const serviceLines = [];
  if (serviceOverrides.size > 0) {
    serviceLines.push("", "services:");
    for (const [name, values] of serviceOverrides) {
      serviceLines.push(`  ${name}:`);
      for (const [key, value] of Object.entries(values)) {
        if (key === "networks" && specialNetworks.has(name)) {
          serviceLines.push(
            "    networks: !override",
            ...specialNetworks.get(name).map((network) => `      - ${network}`),
          );
        } else {
          serviceLines.push(
            ...dumpYaml({ [key]: value }, { noRefs: true })
              .trimEnd()
              .split("\n")
              .map((line) => `    ${line}`),
          );
        }
      }
    }
  }
  const content = [
    "networks:",
    ...COMPOSE_NETWORKS.flatMap((network) => [
      `  ${network}:`,
      `    name: ${network === EXTERNAL_POSTGRES_NETWORK && options.sharedPostgres ? network : `${projectName}_${network}`}`,
      `    external: ${network === EXTERNAL_POSTGRES_NETWORK ? "true" : "false"}`,
      ...(network === "coffee_provider_egress" &&
      (options.aromaCartProof || options.recoveryProof)
        ? ["    internal: true"]
        : []),
    ]),
    ...serviceLines,
    "",
  ].join("\n");
  await writeFile(path, content, { encoding: "utf8", mode: 0o400 });
  await chmod(path, 0o400);
  return path;
}

export function rollbackRuntimeComposeOptions(
  projectName,
  launchContextPath,
  configPath,
  kafkaImage,
  controlled,
) {
  return {
    ...(kafkaImage ? { kafkaImage } : {}),
    sharedPostgres: false,
    recoveryProof: true,
    launchContextPath,
    edgeNginxImage: `${projectName}-edge-nginx:latest`,
    ...(controlled
      ? {
          runtimeImages: controlled.runtimeImages,
          observabilityConfig: {
            path: configPath,
            sha256: controlled.configSha256,
          },
        }
      : configPath
        ? { aromaConvergenceConfigPath: configPath }
        : {}),
  };
}

function databaseProofNetworkNames(projectName) {
  return COMPOSE_NETWORKS.map((network) => `${projectName}_${network}`);
}

function createDatabaseProofNetwork(networkName) {
  try {
    runDocker(["network", "inspect", networkName]);
  } catch {
    runDocker(["network", "create", "--internal", networkName]);
    return true;
  }
  throw new Error(`database proof network already exists: ${networkName}`);
}

const APPROVED_EXTERNAL_POSTGRES = Object.freeze({
  containerId:
    "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f",
  imageId:
    "sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b",
  systemIdentifier: "7613370342949990434",
  dataNetworkId:
    "f1e587a5c52948bcf232cdc3e644859a7ed24db7dc4fd84be65f36a397cedf6a",
  legacyNetworkId:
    "d6e471bdc52437821abc9a060e075a153ad55003daf81eea1782d0a62f70ceb3",
});

export function isExternalRecoveryProof(options) {
  return (
    options.recoveryProof === true &&
    options.mutationDisableRollback !== true &&
    options.observabilityFixture !== true
  );
}

export function externalPostgresConnectArgs(networkId, containerId) {
  assert.match(networkId, /^[0-9a-f]{64}$/u);
  assert.match(containerId, /^[0-9a-f]{64}$/u);
  return [
    "network",
    "connect",
    "--alias",
    "coffee_postgres",
    "--gw-priority",
    "-1",
    networkId,
    containerId,
  ];
}

function inspectDockerObject(args) {
  const rows = JSON.parse(runDocker(["inspect", ...args]));
  assert.equal(rows.length, 1, "expected one Docker object");
  return rows[0];
}

function externalPostgresRoute(containerId) {
  return runDocker([
    "exec",
    containerId,
    "sh",
    "-c",
    `awk '$2 == "00000000" {print $1 ":" $3 ":" $4 ":" $7 ":" $8}' /proc/net/route | sort`,
  ]).trim();
}

function assertApprovedExternalPostgresDockerState({ attached }) {
  const container = inspectDockerObject([
    APPROVED_EXTERNAL_POSTGRES.containerId,
  ]);
  assert.equal(container.Id, APPROVED_EXTERNAL_POSTGRES.containerId);
  assert.equal(container.Image, APPROVED_EXTERNAL_POSTGRES.imageId);
  assert.equal(container.Name, "/coffee_postgres");
  const containerNetworks = container.NetworkSettings?.Networks ?? {};
  const legacy = containerNetworks.coffee_network;
  assert.equal(legacy?.NetworkID, APPROVED_EXTERNAL_POSTGRES.legacyNetworkId);
  const data = containerNetworks[EXTERNAL_POSTGRES_NETWORK];
  if (attached !== undefined) assert.equal(Boolean(data), attached);
  assert.deepEqual(
    Object.keys(containerNetworks).sort(),
    data
      ? [EXTERNAL_POSTGRES_NETWORK, "coffee_network"].sort()
      : ["coffee_network"],
  );
  if (data) {
    assert.equal(data.NetworkID, APPROVED_EXTERNAL_POSTGRES.dataNetworkId);
    assert.ok(data.Aliases?.includes("coffee_postgres"));
  }

  const dataNetwork = inspectDockerObject([
    APPROVED_EXTERNAL_POSTGRES.dataNetworkId,
  ]);
  assert.equal(dataNetwork.Id, APPROVED_EXTERNAL_POSTGRES.dataNetworkId);
  assert.equal(dataNetwork.Name, EXTERNAL_POSTGRES_NETWORK);
  const endpoints = Object.keys(dataNetwork.Containers ?? {});
  assert.deepEqual(
    endpoints.sort(),
    data ? [APPROVED_EXTERNAL_POSTGRES.containerId] : [],
  );
  const legacyNetwork = inspectDockerObject([
    APPROVED_EXTERNAL_POSTGRES.legacyNetworkId,
  ]);
  assert.equal(legacyNetwork.Id, APPROVED_EXTERNAL_POSTGRES.legacyNetworkId);
  assert.equal(legacyNetwork.Name, "coffee_network");
  assert.ok(
    legacyNetwork.Containers?.[APPROVED_EXTERNAL_POSTGRES.containerId],
    "approved PostgreSQL container is no longer attached to its original network",
  );
  return { container, dataNetwork, legacyNetwork };
}

export function prepareApprovedExternalPostgresAttachment() {
  const before = assertApprovedExternalPostgresDockerState({});
  const routeBefore = externalPostgresRoute(
    APPROVED_EXTERNAL_POSTGRES.containerId,
  );
  return {
    before,
    routeBefore,
    baselineAttached: Boolean(
      before.container.NetworkSettings.Networks[EXTERNAL_POSTGRES_NETWORK],
    ),
    baselineConfirmed: false,
    attached: false,
    attempted: false,
    absenceConfirmed: false,
  };
}

function assertExternalPostgresBaseline(attachment) {
  const after = assertApprovedExternalPostgresDockerState({ attached: true });
  assert.deepEqual(
    after.container.NetworkSettings.Networks,
    attachment.before.container.NetworkSettings.Networks,
  );
  assert.deepEqual(
    after.dataNetwork.Containers,
    attachment.before.dataNetwork.Containers,
  );
  assert.deepEqual(
    after.legacyNetwork.Containers,
    attachment.before.legacyNetwork.Containers,
  );
  const routeAfter = externalPostgresRoute(
    APPROVED_EXTERNAL_POSTGRES.containerId,
  );
  assert.equal(
    routeAfter,
    attachment.routeBefore,
    "external PostgreSQL baseline default route changed",
  );
  attachment.routeAfter = routeAfter;
}

export function attachApprovedExternalPostgres(attachment) {
  if (attachment.baselineAttached) {
    assertExternalPostgresBaseline(attachment);
    return;
  }
  attachment.attempted = true;
  runDocker(
    externalPostgresConnectArgs(
      APPROVED_EXTERNAL_POSTGRES.dataNetworkId,
      APPROVED_EXTERNAL_POSTGRES.containerId,
    ),
  );
  // Only an acknowledged connect grants ownership. If later guards fail,
  // cleanup may remove this attachment only after repeating identity checks.
  attachment.attached = true;
  const after = assertApprovedExternalPostgresDockerState({ attached: true });
  assert.deepEqual(
    after.legacyNetwork.Containers,
    attachment.before.legacyNetwork.Containers,
    "external attachment changed the original coffee_network endpoints",
  );
  assert.deepEqual(
    after.container.NetworkSettings.Networks.coffee_network,
    attachment.before.container.NetworkSettings.Networks.coffee_network,
    "external attachment changed the PostgreSQL legacy network endpoint",
  );
  const routeAfter = externalPostgresRoute(
    APPROVED_EXTERNAL_POSTGRES.containerId,
  );
  assert.equal(
    routeAfter,
    attachment.routeBefore,
    "external PostgreSQL attachment changed its original default route",
  );
  attachment.after = after;
  attachment.routeAfter = routeAfter;
}

function disconnectApprovedExternalPostgres(attachment) {
  if (!attachment?.attached) return;
  assertApprovedExternalPostgresDockerState({ attached: true });
  runDocker([
    "network",
    "disconnect",
    EXTERNAL_POSTGRES_NETWORK,
    APPROVED_EXTERNAL_POSTGRES.containerId,
  ]);
  const after = assertApprovedExternalPostgresDockerState({ attached: false });
  assert.deepEqual(
    after.legacyNetwork.Containers,
    attachment.before.legacyNetwork.Containers,
  );
  assert.deepEqual(
    after.container.NetworkSettings.Networks.coffee_network,
    attachment.before.container.NetworkSettings.Networks.coffee_network,
  );
  const routeAfter = externalPostgresRoute(
    APPROVED_EXTERNAL_POSTGRES.containerId,
  );
  attachment.routeAfter = routeAfter;
  assert.equal(routeAfter, attachment.routeBefore);
  attachment.attached = false;
  attachment.absenceConfirmed = true;
}

export function cleanupApprovedExternalPostgresAttachment(attachment) {
  if (attachment?.baselineAttached) {
    attachment.baselineConfirmed = false;
    assertExternalPostgresBaseline(attachment);
    attachment.baselineConfirmed = true;
  } else if (attachment?.attached)
    disconnectApprovedExternalPostgres(attachment);
  else if (attachment?.attempted) {
    assertApprovedExternalPostgresDockerState({ attached: false });
    attachment.absenceConfirmed = true;
  }
}

function startDatabaseProofContainer(
  projectName,
  networkName,
  credential,
  {
    initialDatabase = "coffee_platform_customer",
    publishHost = false,
    ephemeralPgData = false,
    fixtureRunId,
    onFixtureCreated,
  } = {},
) {
  const container = `${projectName}-postgres-proof`;
  const args = [
    "run",
    "--detach",
    "--name",
    container,
    ...(fixtureRunId ? ["--label", `coffee.g14.fixture=${fixtureRunId}`] : []),
    "--network",
    ...(publishHost
      ? ["bridge"]
      : [
          networkName,
          "--network-alias",
          "coffee_postgres",
          "--network-alias",
          "customer_db",
        ]),
    "--env",
    `POSTGRES_USER=${credential.username}`,
    "--env",
    `POSTGRES_PASSWORD=${credential.password}`,
    "--env",
    `POSTGRES_DB=${initialDatabase}`,
    "--health-cmd",
    `pg_isready -U ${credential.username} -d ${initialDatabase}`,
    "--health-interval",
    "1s",
    "--health-timeout",
    "1s",
    "--health-retries",
    "30",
    ...(ephemeralPgData
      ? ["--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=536870912"]
      : []),
    ...(publishHost ? ["--publish", "127.0.0.1::5432"] : []),
    DATABASE_PROOF_IMAGE,
  ];
  const createdId = runDocker(args).trim();
  if (fixtureRunId) {
    assert.match(
      createdId,
      /^[a-f0-9]{64}$/u,
      "fixture PostgreSQL ID unavailable",
    );
    onFixtureCreated(createdId);
  }
  if (publishHost) {
    runDocker([
      "network",
      "connect",
      "--alias",
      "coffee_postgres",
      "--alias",
      "customer_db",
      networkName,
      container,
    ]);
  }
  return fixtureRunId ? createdId : container;
}

export function assertObservabilityPostgresIdentity({
  id,
  projectName,
  networkName,
  fixtureRunId,
  allowIncompleteNetwork = false,
  run = runDocker,
}) {
  assert.match(id ?? "", /^[a-f0-9]{64}$/u);
  const info = JSON.parse(run(["inspect", id]))[0];
  assert.equal(info?.Id, id, "fixture PostgreSQL ID changed");
  assert.equal(
    info?.Name,
    `/${projectName}-postgres-proof`,
    "fixture PostgreSQL name changed",
  );
  assert.equal(
    info?.Config?.Labels?.["coffee.g14.fixture"],
    fixtureRunId,
    "fixture PostgreSQL owner changed",
  );
  assert.equal(
    info?.Config?.Image,
    DATABASE_PROOF_IMAGE,
    "fixture PostgreSQL image changed",
  );
  const networks = Object.keys(info?.NetworkSettings?.Networks ?? {}).sort();
  const expectedNetworks = ["bridge", networkName].sort((left, right) =>
    String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
  );
  assert.ok(
    JSON.stringify(networks) === JSON.stringify(expectedNetworks) ||
      (allowIncompleteNetwork &&
        JSON.stringify(networks) === JSON.stringify(["bridge"])),
    "fixture PostgreSQL network mismatch",
  );
  const bindings = info?.NetworkSettings?.Ports?.["5432/tcp"];
  assert.ok(
    Array.isArray(bindings) &&
      bindings.length === 1 &&
      bindings[0].HostIp === "127.0.0.1" &&
      /^[1-9][0-9]*$/u.test(bindings[0].HostPort),
    "fixture PostgreSQL must publish exactly one loopback port",
  );
}

function assertEphemeralDatabaseProofStorage(container) {
  const tmpfs = JSON.parse(
    runDocker(["inspect", "--format", "{{json .HostConfig.Tmpfs}}", container]),
  );
  const dataPath = "/var/lib/postgresql/data";
  assert.ok(
    tmpfs?.[dataPath]?.split(",").includes("size=536870912"),
    "observability PostgreSQL data tmpfs must have a 512 MiB limit",
  );
  const stat = runDocker([
    "exec",
    container,
    "stat",
    "-f",
    "-c",
    "%T|%S|%b",
    dataPath,
  ])
    .trim()
    .split("|");
  assert.equal(
    stat.length,
    3,
    "observability PostgreSQL data filesystem status must have three fields",
  );
  const [type, blockSizeText, blockCountText] = stat;
  const blockSize = Number(blockSizeText);
  const blockCount = Number(blockCountText);
  const totalBytes = blockSize * blockCount;
  assert.equal(
    type,
    "tmpfs",
    "observability PostgreSQL data directory must be an actual tmpfs filesystem",
  );
  assert.ok(
    Number.isSafeInteger(blockSize) &&
      blockSize > 0 &&
      Number.isSafeInteger(blockCount) &&
      blockCount > 0 &&
      Number.isSafeInteger(totalBytes) &&
      totalBytes === 536870912,
    "observability PostgreSQL data tmpfs must have an actual 512 MiB capacity",
  );
  return {
    type: "tmpfs",
    destination: dataPath,
    sizeMiB: 512,
    durability: "ephemeral",
  };
}

function bootstrapDatabaseProofRole(container, admin, owner, databaseName) {
  runDocker(
    [
      "exec",
      "--interactive",
      container,
      "psql",
      "--username",
      admin.username,
      "--dbname",
      databaseName,
      "--no-psqlrc",
    ],
    {
      input: [
        `CREATE ROLE "${owner.username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${owner.password}';`,
        `REVOKE ALL ON DATABASE "${databaseName}" FROM PUBLIC;`,
        `GRANT CONNECT ON DATABASE "${databaseName}" TO "${owner.username}";`,
        "",
      ].join("\n"),
    },
  );
}

function assertDatabaseProofRole(container, admin, owner, databaseName) {
  const output = runDocker(
    [
      "exec",
      "--interactive",
      container,
      "psql",
      "--username",
      admin.username,
      "--dbname",
      databaseName,
      "--tuples-only",
      "--no-align",
      "--no-psqlrc",
      "--command",
      `SELECT json_build_object('isSuperuser', rolsuper, 'canCreateDb', rolcreatedb, 'canCreateRole', rolcreaterole, 'bypassRls', rolbypassrls, 'connect', has_database_privilege('${owner.username}', '${databaseName}', 'CONNECT'), 'create', has_database_privilege('${owner.username}', '${databaseName}', 'CREATE')) FROM pg_roles WHERE rolname = '${owner.username}'`,
    ],
    { input: "" },
  ).trim();
  const role = JSON.parse(output.split("\n").at(-1));
  assert.deepEqual(
    role,
    {
      isSuperuser: false,
      canCreateDb: false,
      canCreateRole: false,
      bypassRls: false,
      connect: true,
      create: false,
    },
    "database proof owner role is over-privileged",
  );
}

function bootstrapCustomerProofRoles(container, admin, databaseName) {
  const migrator = {
    username: "coffee_customer_migrator",
    password: `compose-migrator-${randomUUID()}`,
  };
  const foreignDatabase = `${databaseName}_foreign`;
  runDocker(
    [
      "exec",
      "--interactive",
      container,
      "psql",
      "--username",
      admin.username,
      "--dbname",
      databaseName,
      "--no-psqlrc",
    ],
    {
      input: [
        `CREATE ROLE "${migrator.username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${migrator.password}';`,
        `GRANT CONNECT, CREATE ON DATABASE "${databaseName}" TO "${migrator.username}";`,
        `CREATE DATABASE "${foreignDatabase}";`,
        `REVOKE ALL ON DATABASE "${foreignDatabase}" FROM PUBLIC;`,
        "",
      ].join("\n"),
    },
  );
  return { migrator, foreignDatabase };
}

async function runCustomerIntegrationProof(
  projectName,
  secretsDir,
  credentials,
  roles,
  composeFile,
  databaseName,
  launchContextPath,
) {
  const databaseUrl = (username, password, database, host = "customer_db") =>
    `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
  const environment = [
    "run",
    "--rm",
    "--add-host",
    "customer-harness:127.0.0.1",
    "--add-host",
    "coffee_postgres:127.0.0.1",
    "--network",
    `${projectName}_coffee_public_api_backend`,
    "--network",
    `${projectName}_coffee_postgres_data`,
    "--volume",
    `${ROOT}:/workspace:ro`,
    "--volume",
    `${secretsDir}:/run/customer-secrets:ro`,
    "--volume",
    `${secretsDir}/customer-logs:/run/customer-logs:rw`,
    "--workdir",
    "/workspace",
    "--env",
    "CUSTOMER_INTEGRATION_REQUIRED=1",
    "--env",
    "CUSTOMER_TEST_ENVIRONMENT=development",
    "--env",
    "CUSTOMER_SERVICE_ORIGIN=https://customer-service:4101",
    "--env",
    "CUSTOMER_TEST_SIGNING_KEY_FILE=/run/customer-secrets/customer-test-signing.json",
    "--env",
    "CUSTOMER_TEST_CLIENT_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-public.json",
    "--env",
    "CUSTOMER_TEST_INTERNAL_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-internal.json",
    "--env",
    "CUSTOMER_DATABASE_URL",
    "--env",
    "CUSTOMER_RUNTIME_DATABASE_URL",
    "--env",
    "CUSTOMER_MIGRATOR_DATABASE_URL",
    "--env",
    "CUSTOMER_FOREIGN_DATABASE_URL",
    "--env",
    "CUSTOMER_TEST_LOG_FILE=/run/customer-logs/customer-service.log",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE=/workspace/config/platform.yaml",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE=/run/customer-secrets/customer-service.yaml",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_HOST=customer_db",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_PORT=5432",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE=/run/customer-secrets/customer-test-api-public.json",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_HEADERS_JSON={}",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_ACTOR_REF=actor_customer_test",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN=https://customer-harness:4101",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_DB_ADAPTER_LOG_FILE=/run/customer-logs/db-adapter.log",
    "--env",
    "CUSTOMER_UNKNOWN_COMMIT_ENTRY=/workspace/apps/customer-service/dist/main.js",
    ...(launchContextPath
      ? [
          "--volume",
          `${resolve(launchContextPath)}:/run/coffee-launch/context.json:ro`,
          "--env",
          "COFFEE_LAUNCH_CONTEXT_FILE=/run/coffee-launch/context.json",
        ]
      : []),
    CUSTOMER_TEST_IMAGE,
    "sh",
    "-lc",
    "node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-normalization.test.mjs && node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-schema.test.mjs && node --experimental-strip-types --test --test-concurrency=1 tests/customer/customer-live.test.mjs",
  ];
  await mkdir(join(secretsDir, "customer-logs"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(secretsDir, "customer-logs/customer-service.log"), "", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(secretsDir, "customer-logs/db-adapter.log"), "", {
    encoding: "utf8",
    mode: 0o600,
  });
  const logPath = join(secretsDir, "customer-logs/customer-service.log");
  const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
  const logProcess = spawnCompose(
    projectName,
    secretsDir,
    ["logs", "--no-log-prefix", "--follow", "customer-service"],
    { composeFile },
  );
  void logProcess.done.catch(() => {});
  logProcess.child.stdout.pipe(log);
  logProcess.child.stderr.pipe(log);
  try {
    await runDockerAsync(environment, {
      inherit: true,
      env: {
        CUSTOMER_DATABASE_URL: databaseUrl(
          credentials.owner.username,
          credentials.owner.password,
          databaseName,
        ),
        CUSTOMER_RUNTIME_DATABASE_URL: databaseUrl(
          credentials.owner.username,
          credentials.owner.password,
          databaseName,
        ),
        CUSTOMER_MIGRATOR_DATABASE_URL: databaseUrl(
          roles.migrator.username,
          roles.migrator.password,
          databaseName,
        ),
        CUSTOMER_FOREIGN_DATABASE_URL: databaseUrl(
          credentials.owner.username,
          credentials.owner.password,
          roles.foreignDatabase,
        ),
        CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL: `postgresql://${encodeURIComponent(credentials.owner.username)}:${encodeURIComponent(credentials.owner.password)}@127.0.0.1:5432/${databaseName}`,
        CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL: databaseUrl(
          credentials.owner.username,
          credentials.owner.password,
          databaseName,
          "customer_db",
        ),
      },
    });
  } finally {
    logProcess.child.kill("SIGTERM");
    log.end();
  }
}

async function waitForDockerHealthy(
  container,
  timeoutMs = remainingGateWaitMs(),
) {
  const deadline = Date.now() + timeoutMs;
  let status = "unknown";
  while (Date.now() < deadline) {
    try {
      status = runDocker([
        "inspect",
        "--format",
        "{{.State.Health.Status}}",
        container,
      ]).trim();
    } catch {
      status = "unknown";
    }
    if (status === "healthy") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${container} did not become healthy: ${status}`);
}

async function waitForDatabaseProofReady(
  container,
  admin,
  databaseName = "coffee_platform_customer",
  timeoutMs = remainingGateWaitMs(),
) {
  const deadline = Date.now() + timeoutMs;
  let postmasterStart;
  while (Date.now() < deadline) {
    try {
      const output = runDocker(
        [
          "exec",
          "--interactive",
          container,
          "psql",
          "--username",
          admin.username,
          "--dbname",
          databaseName,
          "--host",
          "127.0.0.1",
          "--tuples-only",
          "--no-align",
          "--no-psqlrc",
          "--command",
          "SELECT pg_postmaster_start_time()",
        ],
        { input: "" },
      ).trim();
      const currentStart = output.split("\n").at(-1);
      if (currentStart !== undefined && currentStart === postmasterStart)
        return;
      postmasterStart = currentStart;
    } catch {
      postmasterStart = undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${container} database did not become queryable`);
}

function publishedDatabasePort(container) {
  const output = runDocker([
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    container,
  ]).trim();
  assert.match(output, /^\d+$/, "database proof did not publish PostgreSQL");
  return Number(output);
}

async function createPostgresClient(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    statement_timeout: 2000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

async function waitForPostgresClient(
  connectionString,
  timeoutMs = remainingGateWaitMs(),
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const client = await createPostgresClient(connectionString);
      try {
        await client.query("SELECT 1");
      } finally {
        await client.end();
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `database proof host connection did not become ready: ${lastError?.message ?? "timeout"}`,
  );
}

async function bootstrapRecoveryDatabases(container, proofCredentials) {
  const port = publishedDatabasePort(container);
  const adminUrl = [
    "postgresql://",
    encodeURIComponent(proofCredentials.admin.username),
    ":",
    encodeURIComponent(proofCredentials.admin.password),
    "@127.0.0.1:",
    port,
    "/postgres",
  ].join("");
  await waitForPostgresClient(adminUrl);
  const adminClient = await createPostgresClient(adminUrl);
  try {
    const probe = (await adminClient.query(SERVER_IDENTITY_SQL)).rows[0];
    const identity = validateServerProbe(probe, {
      expectedServerIdentity: probe.system_identifier,
    });
    const connectClient = async (database) =>
      createPostgresClient(replaceDatabase(adminUrl, database));
    const result = await bootstrapDatabases({
      adminClient,
      adminUrl,
      connectClient,
      roleMap: proofCredentials.roleMap,
      ownership: proofCredentials.ownership,
      rolePasswords: proofCredentials.rolePasswords,
      expectedServerIdentity: identity.serverIdentity,
      launchIdentity: proofCredentials.launchIdentity,
    });
    assert.equal(result.databases.length, 5);
    assert.equal(result.runtimeRoleCount, 10);
    return {
      port,
      databases: result.databases,
      runtimeRoleCount: result.runtimeRoleCount,
      idempotent: result.idempotent,
    };
  } finally {
    await adminClient.end();
  }
}

function quoteRunDatabaseIdentifier(value) {
  assert.match(value, /^coffee_verify_[a-z0-9_]{1,54}$/u);
  return `"${value}"`;
}

async function externalAdminClient(credentials, postgres) {
  const client = new Client({
    host: postgres.host,
    port: postgres.port,
    database: "postgres",
    user: credentials.admin.username,
    password: credentials.admin.password,
    ssl: false,
    connectionTimeoutMillis: 3_000,
    query_timeout: 10_000,
  });
  client.on("error", () => {});
  let connectStarted = false;
  try {
    connectStarted = true;
    await client.connect();
    const probe = (await client.query(SERVER_IDENTITY_SQL)).rows[0];
    validateServerProbe(probe, {
      expectedServerIdentity: credentials.postgres.systemIdentifier,
    });
    assert.equal(probe.current_database, "postgres");
    assert.equal(probe.current_user, credentials.admin.username);
    return client;
  } catch (error) {
    if (connectStarted) {
      try {
        await client.end();
      } catch {
        // Preserve the identity/query failure; the close was attempted once.
      }
    }
    throw error;
  }
}

async function inspectExternalRunDatabase(admin, database) {
  const result = await admin.query(
    "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1",
    [database.name],
  );
  if (result.rows.length === 0) return { exists: false };
  return { exists: true, owner: result.rows[0].owner };
}

export async function externalOwnerMigrations(root, database) {
  const expectedMigrationPath = {
    customer: "apps/customer-service/migrations",
    catalog: "apps/catalog-service/migrations",
    pricing: "apps/pricing-service/migrations",
    orders: "apps/orders-service/migrations",
    integration: "apps/aroma-gateway/migrations",
  }[database.owner];
  assert.equal(
    database.migrationPath,
    expectedMigrationPath,
    "external migration path differs from the canonical database owner",
  );
  const ownerPath = resolve(root, database.migrationPath);
  assert.ok(
    ownerPath.startsWith(`${resolve(root)}/apps/`) &&
      ownerPath.endsWith("/migrations"),
    "external migration path is outside a canonical owner migration directory",
  );
  const directoryInfo = await lstat(ownerPath);
  assert.ok(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink());
  const names = (await readdir(ownerPath)).sort();
  assert.ok(names.length > 0, `${database.owner} has no migrations`);
  const migrations = [];
  for (const name of names) {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/u);
    const path = join(ownerPath, name);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    const sql = await readFile(path, "utf8");
    migrations.push({
      id: name.slice(0, -4),
      sql,
      checksum: migrationChecksum(sql),
    });
  }
  return migrations;
}

export async function applyExternalRecoveryMigrations(
  credentials,
  platformConfig,
  contextPath,
  resources,
) {
  const { postgres, ownership, roleMap } = credentials;
  assert.equal(postgres.host, platformConfig.postgres.host);
  assert.equal(postgres.port, platformConfig.postgres.port);
  assert.equal(
    postgres.systemIdentifier,
    APPROVED_EXTERNAL_POSTGRES.systemIdentifier,
  );
  assert.equal(ownership.databases.length, 5);
  assert.equal(roleMap.databases.length, 5);
  const admin = await externalAdminClient(credentials, postgres);
  const expectedNames = ownership.databases.map(({ name }) => name).sort();
  let preflightError;
  try {
    const targetState = await admin.query(
      "SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname",
      [expectedNames],
    );
    assert.deepEqual(
      targetState.rows.map(({ datname }) => datname),
      [],
      "compose/browser refuses any pre-existing run database; it never adopts databases",
    );
  } catch (error) {
    preflightError = error;
  }
  let closeError;
  try {
    await admin.end();
  } catch (error) {
    closeError = error;
  }
  if (preflightError) throw preflightError;
  if (closeError) throw closeError;

  for (const database of roleMap.databases) {
    const owner = ownership.databases.find(
      (candidate) => candidate.name === database.name,
    );
    assert.ok(owner && owner.migratorRole === database.migratorRole);
    const ownedDatabase = { ...database, owner: owner.owner };
    await createMigrationDatabase(
      ownedDatabase,
      resources,
      async () => {
        const client = await externalAdminClient(credentials, postgres);
        try {
          await client.query(
            `CREATE DATABASE ${quoteRunDatabaseIdentifier(database.name)} OWNER "${database.migratorRole}" TEMPLATE template0`,
          );
        } finally {
          await client.end();
        }
      },
      async () => {
        const client = await externalAdminClient(credentials, postgres);
        try {
          return await inspectExternalRunDatabase(client, ownedDatabase);
        } finally {
          await client.end();
        }
      },
    );
  }

  const projectedConfig = projectRecoveryPlatformConfig(
    platformConfig,
    ownership,
  );
  for (const database of roleMap.databases) {
    const ownershipClient = await externalAdminClient(credentials, postgres);
    try {
      const databaseState = await inspectExternalRunDatabase(
        ownershipClient,
        database,
      );
      assert.deepEqual(databaseState, {
        exists: true,
        owner: database.migratorRole,
      });
    } finally {
      await ownershipClient.end();
    }
    const adminConnection = new Client({
      host: postgres.host,
      port: postgres.port,
      database: database.name,
      user: credentials.admin.username,
      password: credentials.admin.password,
      ssl: false,
      connectionTimeoutMillis: 3_000,
    });
    adminConnection.on("error", () => {});
    await adminConnection.connect();
    try {
      const identity = (await adminConnection.query(SERVER_IDENTITY_SQL))
        .rows[0];
      validateServerProbe(identity, {
        expectedServerIdentity: postgres.systemIdentifier,
      });
      assert.equal(identity.current_database, database.name);
      await adminConnection.query(renderDatabaseObjectSql(database));
    } finally {
      await adminConnection.end();
    }

    const owner = ownership.databases.find(
      (candidate) => candidate.name === database.name,
    );
    const runtimeClaim = ownership.runtimeClaims.find(
      (claim) => claim.database === database.name && claim.role,
    );
    assert.ok(owner && runtimeClaim);
    const service = databaseProofService(
      projectedConfig,
      ownership,
      runtimeClaim.runtime,
    );
    const selectedMigrator = await readMigrationCredential(
      externalRecoveryMigrationCredentialRequest(
        credentials,
        contextPath,
        owner.owner,
      ),
    );
    assert.equal(selectedMigrator.username, database.migratorRole);
    const migrator = createDatabase(
      proofDatabaseOptions(
        `${owner.owner}-external-migrator`,
        service,
        postgres.port,
        selectedMigrator,
        postgres.host,
      ),
    );
    await migrator.resource.start(AbortSignal.timeout(10_000));
    try {
      await applyMigrations(
        migrator,
        await externalOwnerMigrations(ROOT, owner),
        {
          schema: database.schema,
          ledgerTable: "platform_schema_migrations",
          lockKey: `compose-smoke:${credentials.launchIdentity.runId}:${owner.owner}`,
        },
      );
    } finally {
      await migrator.resource.stop(AbortSignal.timeout(10_000));
    }

    const postMigration = new Client({
      host: postgres.host,
      port: postgres.port,
      database: database.name,
      user: credentials.admin.username,
      password: credentials.admin.password,
      ssl: false,
      connectionTimeoutMillis: 3_000,
    });
    postMigration.on("error", () => {});
    await postMigration.connect();
    try {
      await postMigration.query(renderDatabaseObjectSql(database));
    } finally {
      await postMigration.end();
    }
  }

  return {
    host: postgres.host,
    port: postgres.port,
    databases: expectedNames,
    runtimeRoleCount: ownership.runtimeClaims.filter(
      (claim) => claim.database !== null && claim.role !== null,
    ).length,
    externalPostgres: true,
  };
}

export async function cleanupExternalRecoveryDatabases(
  credentials,
  resources,
  consumersStopped,
) {
  if (consumersStopped !== true) {
    return {
      verified: false,
      removed: [],
      retained: resources.map(({ database }) => database.name),
      failure: "COMPOSE_CONSUMERS_NOT_STOPPED",
    };
  }
  const admin = await externalAdminClient(credentials, credentials.postgres);
  try {
    return await cleanupMigrationDatabases(resources, async (database) => {
      const probe = (await admin.query(SERVER_IDENTITY_SQL)).rows[0];
      validateServerProbe(probe, {
        expectedServerIdentity: credentials.postgres.systemIdentifier,
      });
      if (probe.current_database !== "postgres")
        throw new Error("external cleanup is outside the maintenance database");
      const current = await inspectExternalRunDatabase(admin, database);
      if (!current.exists || current.owner !== database.migratorRole)
        throw new Error("external run database ownership changed");
      await admin.query(
        `DROP DATABASE ${quoteRunDatabaseIdentifier(database.name)}`,
      );
      const after = await inspectExternalRunDatabase(admin, database);
      if (after.exists)
        throw new Error("external run database drop was not confirmed");
    });
  } finally {
    await admin.end();
  }
}

export function proofDatabaseOptions(
  runtime,
  service,
  port,
  credential,
  host = "127.0.0.1",
) {
  return {
    owner: runtime,
    database: service.database,
    allowedDatabase: service.database,
    host,
    port,
    user: credential.username,
    password: credential.password,
    ssl: false,
    pool: service.dbPool,
    shutdownGraceMs: 30_000,
  };
}

async function applyAromaBindingMigration(port, credentials, platformConfig) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "aroma-gateway",
  );
  const database = service.database;
  assert.equal(
    credentials.ownership.databases.find(
      (candidate) => candidate.name === database,
    )?.owner,
    "integration",
    "AROMA Gateway integration database owner is missing",
  );
  const integration = credentials.roleMap.databases.find(
    (candidate) => candidate.name === database,
  );
  assert.ok(integration, "aroma binding integration database is missing");
  const migratorPassword = credentials.rolePasswords[integration.migratorRole];
  assert.ok(migratorPassword, "aroma binding migrator password is missing");
  const migrator = createDatabase(
    proofDatabaseOptions(
      "aroma-binding-migrator",
      {
        database,
        dbPool: {
          max: 2,
          checkoutTimeoutMs: 250,
          lockTimeoutMs: 250,
          interactiveStatementTimeoutMs: 2000,
          backgroundStatementTimeoutMs: 5000,
          terminalTimeoutMs: 2000,
          transactionTimeoutMs: 10000,
          idleTimeoutMs: 30000,
          maxLifetimeMs: 1800000,
        },
      },
      port,
      { username: integration.migratorRole, password: migratorPassword },
    ),
  );
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_provider_sessions",
      "0002_provider_mutation_journal",
      "0003_offer_bindings",
      "0004_provider_offer_identity",
      "0005_catalog_export_attempts",
      "0006_provider_mutation_retention",
      "0007_provider_mutation_grind",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(
        join(ROOT, `apps/aroma-gateway/migrations/${id}.sql`),
        "utf8",
      );
      migrations.push({ id, sql, checksum: migrationChecksum(sql) });
    }
    await applyMigrations(migrator, migrations, {
      schema: "integration",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-aroma-cart-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function applyCatalogMigrations(port, credentials, platformConfig) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "catalog-supplier-sync",
  );
  const database = service?.database;
  assert.equal(
    credentials.ownership.databases.find(
      (candidate) => candidate.name === database,
    )?.owner,
    "catalog",
    "Catalog recovery proof database owner is missing",
  );
  const catalog = credentials.roleMap.databases.find(
    (candidate) => candidate.name === database,
  );
  assert.ok(catalog, "Catalog recovery proof role map is missing");
  const migratorPassword = credentials.rolePasswords[catalog.migratorRole];
  assert.ok(
    migratorPassword,
    "Catalog recovery proof migrator password is missing",
  );
  const migrator = createDatabase(
    proofDatabaseOptions("catalog-compose-migrator", service, port, {
      username: catalog.migratorRole,
      password: migratorPassword,
    }),
  );
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_supplier_snapshots",
      "0002_snapshot_batches",
      "0003_snapshot_staging",
      "0004_catalog_active",
      "0005_catalog_identity",
      "0006_catalog_outbox",
      "0007_catalog_grants",
      "0008_catalog_active_read",
      "0009_active_snapshot_freshness",
      "0010_catalog_category",
      "0011_active_catalog_category",
      "0012_active_supplier_promotions",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(
        join(ROOT, `apps/catalog-service/migrations/${id}.sql`),
        "utf8",
      );
      migrations.push({ id, sql, checksum: migrationChecksum(sql) });
    }
    await applyMigrations(migrator, migrations, {
      schema: "catalog",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-catalog-recovery-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function applyPricingMigrations(port, credentials, platformConfig) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "pricing-service",
  );
  const database = service?.database;
  assert.equal(
    credentials.ownership.databases.find(
      (candidate) => candidate.name === database,
    )?.owner,
    "pricing",
    "Pricing recovery proof database owner is missing",
  );
  const pricing = credentials.roleMap.databases.find(
    (candidate) => candidate.name === database,
  );
  assert.ok(pricing, "Pricing recovery proof role map is missing");
  const migratorPassword = credentials.rolePasswords[pricing.migratorRole];
  assert.ok(
    migratorPassword,
    "Pricing recovery proof migrator password is missing",
  );
  const migrator = createDatabase(
    proofDatabaseOptions("pricing-compose-migrator", service, port, {
      username: pricing.migratorRole,
      password: migratorPassword,
    }),
  );
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_create_pricing_policy_versions",
      "0002_create_pricing_quotes",
      "0003_create_pricing_idempotency",
      "0004_create_pricing_audit",
      "0005_quote_grind_selection",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(
        join(ROOT, `apps/pricing-service/migrations/${id}.sql`),
        "utf8",
      );
      migrations.push({ id, sql, checksum: migrationChecksum(sql) });
    }
    await applyMigrations(migrator, migrations, {
      schema: "pricing",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-pricing-recovery-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function applyOrdersMigrations(port, credentials, platformConfig) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "orders-service",
  );
  const database = service?.database;
  assert.equal(
    credentials.ownership.databases.find(
      (candidate) => candidate.name === database,
    )?.owner,
    "orders",
    "Orders recovery proof database owner is missing",
  );
  const orders = credentials.roleMap.databases.find(
    (candidate) => candidate.name === database,
  );
  assert.ok(orders, "Orders recovery proof role map is missing");
  const migratorPassword = credentials.rolePasswords[orders.migratorRole];
  assert.ok(
    migratorPassword,
    "Orders recovery proof migrator password is missing",
  );
  const migrator = createDatabase(
    proofDatabaseOptions("orders-compose-migrator", service, port, {
      username: orders.migratorRole,
      password: migratorPassword,
    }),
  );
  await migrator.resource.start(AbortSignal.timeout(10_000));
  try {
    const migrationIds = [
      "0001_create_orders",
      "0002_create_order_items",
      "0003_create_order_history",
      "0004_create_order_contributions",
      "0005_create_orders_idempotency",
      "0006_create_orders_outbox",
      "0007_order_grind_selection",
      "0008_create_orders_inbox",
      "0009_create_catalog_mapping_projection",
      "0010_create_cart_desired",
      "0011_create_cart_observed",
      "0012_create_convergence_attempts",
      "0013_create_convergence_leases",
      "0014_create_mutation_reservations",
      "0015_create_order_aroma_projections",
      "0016_create_aroma_work_schedules",
      "0017_allow_cart_outbox",
      "0018_guard_order_card_projection",
      "0019_read_guarded_aroma_card",
      "0020_guard_cart_fact_batches",
      "0021_optimize_observed_format_checks",
      "0022_terminal_cart_item_rejection",
      "0023_ascii_observed_identity",
    ];
    const migrations = [];
    for (const id of migrationIds) {
      const sql = await readFile(
        join(ROOT, `apps/orders-service/migrations/${id}.sql`),
        "utf8",
      );
      migrations.push({ id, sql, checksum: migrationChecksum(sql) });
    }
    await applyMigrations(migrator, migrations, {
      schema: "orders",
      ledgerTable: "platform_schema_migrations",
      lockKey: "compose-smoke-orders-recovery-proof",
    });
  } finally {
    await migrator.resource.stop(AbortSignal.timeout(10_000));
  }
}

function readOrdersBrokerMessages(projectName, secretsDir, composeFile, topic) {
  assert.match(
    topic?.name ?? "",
    /^[A-Za-z0-9._-]+$/u,
    "Orders recovery proof topic name is invalid",
  );
  assert.ok(
    Number.isSafeInteger(topic.partitions) && topic.partitions > 0,
    "Orders recovery proof partition count is invalid",
  );
  const offsetsOutput = runCompose(
    projectName,
    secretsDir,
    [
      "exec",
      "-T",
      "kafka",
      "sh",
      "-ec",
      `/opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic ${topic.name} --time -1`,
    ],
    { composeFile },
  );
  const endOffsets = new Map();
  for (const line of offsetsOutput.split(/\r?\n/u).filter(Boolean)) {
    const [name, partitionText, offsetText, extra] = line.split(":");
    if (
      !/^\d+$/u.test(partitionText ?? "") ||
      !/^\d+$/u.test(offsetText ?? "")
    ) {
      throw new Error("Orders recovery proof Kafka offset snapshot is invalid");
    }
    const partition = Number(partitionText);
    const offset = Number(offsetText);
    if (
      extra !== undefined ||
      name !== topic.name ||
      !Number.isSafeInteger(partition) ||
      partition < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      endOffsets.has(partition)
    ) {
      throw new Error("Orders recovery proof Kafka offset snapshot is invalid");
    }
    endOffsets.set(partition, offset);
  }
  if (
    endOffsets.size !== topic.partitions ||
    Array.from({ length: topic.partitions }, (_, partition) =>
      endOffsets.has(partition),
    ).some((present) => !present)
  ) {
    throw new Error(
      "Orders recovery proof Kafka offset snapshot is incomplete",
    );
  }
  const snapshotCount = [...endOffsets.values()].reduce(
    (total, offset) => total + offset,
    0,
  );
  if (!Number.isSafeInteger(snapshotCount) || snapshotCount > 100) {
    throw new Error(
      "Orders recovery proof Kafka offset snapshot exceeds the 100-record bound",
    );
  }
  const messages = [];
  // This proof creates a fresh per-run, un-compacted topic; offset zero is its complete record range.
  for (let partition = 0; partition < topic.partitions; partition += 1) {
    const expectedCount = endOffsets.get(partition);
    if (expectedCount === 0) continue;
    const output = runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        "kafka",
        "sh",
        "-ec",
        `/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic ${topic.name} --partition ${partition} --offset 0 --max-messages ${expectedCount} --timeout-ms 5000`,
      ],
      { composeFile },
    );
    const lines = output.split(/\r?\n/u);
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== expectedCount) {
      throw new Error(
        `Orders recovery proof Kafka snapshot expected ${expectedCount} records in partition ${partition}, received ${lines.length}`,
      );
    }
    for (const line of lines) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(
          "Orders recovery proof Kafka snapshot contains invalid JSON",
        );
      }
      if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message)
      ) {
        throw new Error(
          "Orders recovery proof Kafka snapshot contains an invalid record",
        );
      }
      messages.push(message);
    }
  }
  return messages;
}

async function assertOrdersOutboxBrokerRecovery(
  projectName,
  secretsDir,
  composeFile,
  port,
  host,
  credentials,
  platformConfig,
  kafkaTarget,
) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "orders-service",
  );
  const credential = credentials.databaseCredentialsByRuntime["orders-service"];
  assert.ok(
    service && credential,
    "Orders recovery proof runtime credentials are missing",
  );
  const lifecycleTopic = {
    ...platformConfig.kafka.topics.ordersLifecycle,
    name: kafkaTarget.topics[platformConfig.kafka.topics.ordersLifecycle.name],
  };
  const database = createDatabase(
    proofDatabaseOptions("orders-service", service, port, credential, host),
  );
  await database.resource.start(AbortSignal.timeout(10_000));
  const readOutbox = defineStatement(
    database,
    "SELECT state, message_id FROM orders.outbox_messages WHERE aggregate_ref=$1",
  );
  let stopped = false;
  try {
    runCompose(
      projectName,
      secretsDir,
      ["stop", "--timeout", "30", "orders-service"],
      { composeFile },
    );
    stopped = true;
    const store = new OrderStore(database);
    const actorRef = "compose-orders-actor";
    const meta = () => ({
      actorRef,
      identity: { actorRef, scope: "a".repeat(64), key: randomUUID() },
      correlationId: randomUUID(),
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    });
    const ref = (prefix) => `${prefix}_00000000000000000000000001`;
    const customerRef = ref("cus");
    const draft = await store.createDraft({
      ...meta(),
      customer: {
        customerRef,
        customerVersion: "1",
        displayName: "Compose owner proof",
        state: "Active",
      },
    });
    const orderRef = draft.body.orderRef;
    const item = {
      productRef: ref("prd"),
      variantRef: ref("var"),
      productDisplayName: "Compose coffee",
      unit: "piece",
      quantityMilli: "1000",
      quoteRef: ref("prq"),
      quoteLineNumber: 1,
      quoteHash: "d".repeat(64),
      internalProofHash: "e".repeat(64),
      quoteExpiresAt: Temporal.Now.instant().add({ hours: 1 }).toString(),
      policyVersionRef: ref("pvr"),
      catalogSnapshotRevision: "1",
      mappingRevision: "1",
      offerRef: ref("off"),
      unitMinor: "150",
      lineTotalMinor: "150",
      currency: "RUB",
    };
    const updated = await store.putItem({
      ...meta(),
      orderRef,
      itemRef: ref("itm"),
      expectedVersion: draft.body.version,
      request: {
        expectedVersion: draft.body.version,
        productRef: item.productRef,
        variantRef: item.variantRef,
        quantity: "1",
        quoteRef: item.quoteRef,
        quoteLineNumber: 1,
        quoteHash: item.quoteHash,
      },
      item,
    });
    const confirmed = await store.confirm({
      ...meta(),
      orderRef,
      expectedVersion: updated.body.version,
    });
    assert.equal(
      confirmed.body.status,
      "Confirmed",
      "Orders did not persist Confirm before relay restart",
    );
    const read = () =>
      withTransaction(
        database,
        { mode: "background" },
        async (tx) => (await readOutbox(tx, [orderRef])).rows[0],
      );
    const pending = await read();
    assert.equal(
      pending?.state,
      "Pending",
      "OrderConfirmed must be pending while Orders runtime is stopped",
    );
    const messageId = pending.message_id;
    assert.equal(
      readOrdersBrokerMessages(
        projectName,
        secretsDir,
        composeFile,
        lifecycleTopic,
      ).filter((event) => event.messageId === messageId).length,
      0,
      "OrderConfirmed was published before the Orders relay restarted",
    );
    runCompose(
      projectName,
      secretsDir,
      ["up", "--detach", "--wait", "--no-build", "orders-service"],
      { composeFile },
    );
    stopped = false;
    assert.equal(
      (await read())?.state,
      "Published",
      "Orders relay did not finalize the broker-acknowledged event",
    );
    const matched = () =>
      readOrdersBrokerMessages(
        projectName,
        secretsDir,
        composeFile,
        lifecycleTopic,
      ).filter(
        (event) =>
          event.messageId === messageId &&
          event.messageType === "OrderConfirmed.v1" &&
          event.payload?.orderRef === orderRef,
      );
    assert.equal(
      matched().length,
      1,
      "Kafka did not retain exactly one published OrderConfirmed event",
    );
    runCompose(
      projectName,
      secretsDir,
      ["stop", "--timeout", "30", "orders-service"],
      { composeFile },
    );
    stopped = true;
    runCompose(
      projectName,
      secretsDir,
      ["up", "--detach", "--wait", "--no-build", "orders-service"],
      { composeFile },
    );
    stopped = false;
    assert.equal(
      (await read())?.state,
      "Published",
      "Orders restart changed terminal Outbox state",
    );
    const matchedAfterRestart = matched().length;
    assert.equal(
      matchedAfterRestart,
      1,
      `Orders restart found ${matchedAfterRestart} matching finalized Outbox event(s); expected 1`,
    );
    return {
      pendingBeforeRestart: true,
      brokerAcknowledged: true,
      publishedAfterRestart: true,
      duplicateAfterFinalize: false,
    };
  } finally {
    if (stopped) {
      try {
        runCompose(
          projectName,
          secretsDir,
          ["up", "--detach", "--wait", "--no-build", "orders-service"],
          { composeFile },
        );
      } catch {
        /* preserve the original proof error; outer recovery cleanup owns the stack */
      }
    }
    await database.resource.stop(AbortSignal.timeout(10_000));
  }
}

async function seedAromaBindingSnapshot(
  port,
  credentials,
  platformConfig,
  runId,
) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "aroma-gateway",
  );
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  assert.ok(
    service && credential,
    "aroma gateway database credentials are missing",
  );
  const database = createDatabase(
    proofDatabaseOptions("aroma-gateway", service, port, credential),
  );
  await database.resource.start(AbortSignal.timeout(10_000));
  const store = new OfferBindingStore(database);
  const supplierRef = "sup_00000000000000000000000001";
  const snapshotRef = "snp_00000000000000000000000001";
  const identities = [
    {
      supplierRef,
      sourceIdentityScheme: "hmac-sha256-v1",
      sourceOfferKeyHash: "a".repeat(64),
      rawProviderOfferId: `compose-proof-raw-provider-canary-${runId}`,
    },
    {
      supplierRef,
      sourceIdentityScheme: "hmac-sha256-v1",
      sourceOfferKeyHash: "b".repeat(64),
      rawProviderOfferId: `compose-proof-raw-provider-second-${runId}`,
    },
  ];
  try {
    await store.beginExport(snapshotRef, supplierRef);
    await store.recordBatch(snapshotRef, supplierRef, identities);
    await store.completeExport(snapshotRef, "c".repeat(64));
  } catch (error) {
    await database.resource.stop(AbortSignal.timeout(10_000));
    throw error;
  }
  return {
    database,
    supplierRef,
    snapshotRef,
    identities,
    rawCanary: identities[0].rawProviderOfferId,
  };
}

async function createUntrustedAromaProofMaterial(
  secretsDir,
  environment,
  serverCaPem,
) {
  const directory = join(secretsDir, "aroma-proof-untrusted");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const key = join(directory, "caller.key");
  const csr = join(directory, "caller.csr");
  const cert = join(directory, "caller.crt");
  const ext = join(directory, "caller.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=compose-smoke-untrusted-ca",
    ],
    { stdio: "ignore" },
  );
  await writeFile(
    ext,
    `subjectAltName=URI:spiffe://coffee-platform/${environment}/catalog-activation-worker\\nextendedKeyUsage=clientAuth\\n`,
    { encoding: "utf8", mode: 0o400 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=catalog-activation-worker",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      ext,
    ],
    { stdio: "ignore" },
  );
  return JSON.stringify({
    caPem: serverCaPem,
    certPem: await readFile(cert, "utf8"),
    keyPem: await readFile(key, "utf8"),
  });
}

async function writeAromaBindingProofFixtures(
  secretsDir,
  materialized,
  environment,
  tlsObserver,
) {
  assert.ok(tlsObserver, "aroma binding TLS observer is missing");
  const directory = join(secretsDir, "aroma-proof");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const writeMaterial = async (name, value) => {
    const path = join(directory, name);
    await writeFile(path, value, { encoding: "utf8", mode: 0o400 });
    await chmod(path, 0o400);
    return path;
  };
  const caller = await writeMaterial(
    "caller.json",
    materialized.transportMaterials.service.get("catalog-activation-worker"),
  );
  const foreign = await writeMaterial(
    "foreign.json",
    materialized.transportMaterials.service.get("orders-service"),
  );
  const gateway = await writeMaterial(
    "gateway.json",
    materialized.transportMaterials.service.get("aroma-gateway"),
  );
  const apiInternal = await writeMaterial(
    "api-internal.json",
    JSON.stringify({
      material: JSON.parse(
        materialized.transportMaterials.service.get("api-internal"),
      ),
      signingKey:
        materialized.securityMaterial[
          "security.apiInternalDelegationSigningPrivateKey"
        ],
    }),
  );
  const untrusted = await writeMaterial(
    "untrusted.json",
    await createUntrustedAromaProofMaterial(
      secretsDir,
      environment,
      JSON.parse(materialized.transportMaterials.service.get("aroma-gateway"))
        .caPem,
    ),
  );
  return { directory, caller, foreign, gateway, apiInternal, untrusted };
}

function findAromaTrackedSocket(trackedSockets, suppliedSocket) {
  if (suppliedSocket === undefined || suppliedSocket === null) return undefined;
  const suppliedParent = suppliedSocket._parent;
  const hasSuppliedParent =
    suppliedParent !== undefined && suppliedParent !== null;
  return trackedSockets.find(({ socket }) => {
    if (socket === suppliedSocket) return true;
    if (hasSuppliedParent && socket === suppliedParent) return true;
    const trackedParent = socket?._parent;
    const hasTrackedParent =
      trackedParent !== undefined && trackedParent !== null;
    if (hasTrackedParent && trackedParent === suppliedSocket) return true;
    return (
      hasSuppliedParent && hasTrackedParent && trackedParent === suppliedParent
    );
  });
}

function assertAromaGatewaySocketAssociationRegression() {
  const sharedParent = {};
  const knownSocket = { _parent: sharedParent };
  const tracked = [{ socket: knownSocket, remotePort: 41001, localPort: 4301 }];
  assert.equal(
    findAromaTrackedSocket(tracked, knownSocket),
    tracked[0],
    "direct socket identity must match",
  );
  assert.equal(
    findAromaTrackedSocket(tracked, { _parent: sharedParent }),
    tracked[0],
    "shared parent identity must match",
  );
  assert.equal(
    findAromaTrackedSocket([{ socket: { _parent: undefined } }], {
      _parent: undefined,
    }),
    undefined,
    "missing parents must not match",
  );
  assert.equal(
    findAromaTrackedSocket([{ socket: knownSocket }], {}),
    undefined,
    "unknown socket must not match",
  );
}

const AROMA_BINDING_TLS_OBSERVER_SOURCE = `import {Server as TLSServer} from "node:tls";
import {Server as NetServer} from "node:net";
let sequence = 0;
const sockets = [];
${findAromaTrackedSocket.toString()}
const certificateVerificationCodes = new Set([
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
  "ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV3_ALERT_BAD_CERTIFICATE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const certificateVerificationMessage = /certificate (?:verify failed|required)|peer did not return a certificate|unknown ca|bad certificate/i;
const trackSocket = (socket) => {
  if (sockets.some(({socket: knownSocket}) => knownSocket === socket)) return;
  const tracked = {socket, remotePort: null, localPort: null};
  const refresh = () => {
    if (Number.isInteger(socket.remotePort)) tracked.remotePort = socket.remotePort;
    if (Number.isInteger(socket.localPort)) tracked.localPort = socket.localPort;
  };
  sockets.push(tracked);
  refresh();
  socket.once("connect", refresh);
  socket.once("secureConnect", refresh);
  socket.once("close", refresh);
};
const originalNetEmit = NetServer.prototype.emit;
NetServer.prototype.emit = function (event, ...args) {
  if (event === "connection" && args[0] !== undefined) trackSocket(args[0]);
  return originalNetEmit.call(this, event, ...args);
};
const originalEmit = TLSServer.prototype.emit;
const record = (error, socket, connection = {}, verificationSocket = socket) => {
  const associated = socket !== undefined && Number.isInteger(connection.remotePort) && Number.isInteger(connection.localPort);
  const errorCode = associated && typeof verificationSocket?.authorizationError === "string"
    ? verificationSocket.authorizationError
    : associated && typeof error?.code === "string" ? error.code : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const category = associated && (certificateVerificationCodes.has(errorCode) || certificateVerificationMessage.test(message))
    ? "client-certificate-verification"
    : "unassociated-tls-client-error";
  process.stderr.write("AROMA_BINDING_TLS_PROOF " + JSON.stringify({
    event: "tlsClientError",
    sequence: ++sequence,
    category,
    errorCode,
    authorizationError: associated && typeof verificationSocket?.authorizationError === "string" ? verificationSocket.authorizationError : null,
    remotePort: associated ? connection.remotePort : null,
    localPort: associated ? connection.localPort : null,
  }) + "\\n");
};
TLSServer.prototype.emit = function (event, ...args) {
  if (event === "connection" && args[0] !== undefined) trackSocket(args[0]);
  if (event === "tlsClientError") {
    const error = args[0];
    const suppliedSocket = args[1];
    const trackedSocket = findAromaTrackedSocket(sockets, suppliedSocket);
    if (trackedSocket === undefined) record(error, undefined, {}, suppliedSocket);
    else record(error, trackedSocket.socket, {remotePort: trackedSocket.remotePort, localPort: trackedSocket.localPort}, suppliedSocket);
  }
  return originalEmit.call(this, event, ...args);
};
`;

async function prepareAromaBindingTlsObserver(secretsDir) {
  const observer = join(secretsDir, "aroma-gateway-tls-observer.mjs");
  await writeFile(observer, AROMA_BINDING_TLS_OBSERVER_SOURCE, {
    encoding: "utf8",
    mode: 0o400,
  });
  await chmod(observer, 0o400);
  await chown(observer, 1000, 1000);
  return { observer };
}

function aromaBindingProofSource({
  phase,
  supplierRef,
  snapshotRef,
  identities,
  environment,
  rawCanary,
}) {
  return `import {readFile} from "node:fs/promises";
import {request as httpsRequest} from "node:https";
import {sign} from "node:crypto";

const phase = ${JSON.stringify(phase)};
const supplierRef = ${JSON.stringify(supplierRef)};
const snapshotRef = ${JSON.stringify(snapshotRef)};
const identities = ${JSON.stringify(identities.map(({ sourceOfferKeyHash }) => sourceOfferKeyHash))};
const expectedEnvironment = ${JSON.stringify(environment)};
const rawCanary = ${JSON.stringify(rawCanary)};
const operationId = "registerAromaOfferBinding";
const originalCaller = "catalog-activation-worker";
const read = async (name) => JSON.parse(await readFile("/run/aroma-proof/" + name, "utf8"));
const caller = await read("caller.json");
const foreign = await read("foreign.json");
const gateway = await read("gateway.json");
const apiInternal = await read("api-internal.json");
const untrusted = await read("untrusted.json");
const callerMaterial = caller;
const gatewayMaterial = gateway;
const apiMaterial = apiInternal.material;
const observedResponses = [];
const tlsCertificateRejectionCodes = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN",
  "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA",
  "ERR_SSL_TLSV3_ALERT_BAD_CERTIFICATE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const isTlsCertificateRejection = (error) => {
  const code = typeof error?.code === "string" ? error.code : "";
  if (tlsCertificateRejectionCodes.has(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:ssl|tls)v?[0-9]+(?:[.][0-9]+)?_alert_(?:unknown_ca|bad_certificate|certificate_required)|certificate (?:required|verify failed|has expired)|unable to verify (?:the )?first certificate|self[- ]signed certificate/i.test(message);
};
const status = async ({host, port, path, material, body, token, expectedServerRuntime, rawBody}) => new Promise((resolve, reject) => {
  let localPort;
  const options = {
    host, port, method: "POST", path, servername: host, ca: material.caPem, minVersion: "TLSv1.3", rejectUnauthorized: true,
    headers: {"content-type": "application/json", "content-length": Buffer.byteLength(rawBody ?? JSON.stringify(body ?? {}))},
    checkServerIdentity: (_hostname, certificate) => {
      const san = certificate.subjectaltname?.split(",").map((value) => value.trim()).find((value) => value.startsWith("URI:"));
      if (san !== "URI:spiffe://coffee-platform/" + expectedEnvironment + "/" + expectedServerRuntime) return new Error("target server SAN is invalid");
      return undefined;
    },
  };
  if (material.certPem !== undefined && material.keyPem !== undefined) { options.cert = material.certPem; options.key = material.keyPem; }
  if (token !== undefined) options.headers["x-service-delegation"] = token;
  const request = httpsRequest(options, (response) => {
    let value = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { value += chunk; if (value.length > 65536) request.destroy(new Error("response exceeded bound")); });
    response.once("end", () => { let parsed; try { parsed = value ? JSON.parse(value) : undefined; } catch { parsed = undefined; } const result = {kind: "http", status: response.statusCode ?? 0, body: parsed, rawBody: value}; observedResponses.push(result); resolve(result); });
  });
  request.once("socket", (socket) => {
    socket.once("connect", () => { localPort = socket.localPort; });
    socket.once("secureConnect", () => { localPort = socket.localPort; });
  });
  request.once("timeout", () => request.destroy(new Error("bounded HTTPS request timeout")));
  request.once("error", (error) => {
    if (isTlsCertificateRejection(error)) {
      resolve({kind: "tls-rejected", code: error.code ?? "certificate-rejection", localPort});
      return;
    }
    if (error instanceof Error) error.localPort = localPort;
    reject(error);
  });
  request.setTimeout(5000);
  request.end(rawBody ?? JSON.stringify(body));
});
const baseBody = {offerRef: "off_00000000000000000000000001", supplierRef, sourceIdentityScheme: "hmac-sha256-v1", sourceOfferKeyHash: identities[0], snapshotRef};
const expectedBinding = {offerRef: baseBody.offerRef, supplierRef, sourceIdentityScheme: baseBody.sourceIdentityScheme, sourceOfferKeyHash: baseBody.sourceOfferKeyHash, firstSnapshotRef: snapshotRef, state: "Bound"};
const requestApi = (body, rawBody) => status({host: "api-internal", port: 4051, path: "/api/internal-v1/aroma/offer-bindings", material: callerMaterial, body, rawBody, expectedServerRuntime: "api-internal"});
const requestGateway = (material, token, body = baseBody, rawBody) => status({host: "aroma-gateway", port: 4301, path: "/api/internal-v1/aroma/offer-bindings", material, token, body, rawBody, expectedServerRuntime: "aroma-gateway"});
const assertNoRawCanaryInResponses = () => { if (observedResponses.some(({body, rawBody}) => JSON.stringify(body ?? "").includes(rawCanary) || rawBody.includes(rawCanary))) throw new Error("raw provider canary appeared in an HTTP response"); };
const canonical = (value) => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" ? JSON.stringify(value) : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" : "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const assertNormativeBinding = (result, label) => {
  if (result.kind !== "http" || result.status !== 200) throw new Error(label + " did not return 200");
  if (canonical(result.body) !== canonical(expectedBinding)) throw new Error(label + " body was not the normative binding");
};
const assertUnavailableEndpointRejected = async () => {
  let result;
  try {
    result = await status({host: "aroma-proof-unreachable.invalid", port: 1, path: "/api/internal-v1/aroma/offer-bindings", material: callerMaterial, body: baseBody, expectedServerRuntime: "aroma-gateway"});
  } catch (error) {
    if (isTlsCertificateRejection(error)) throw new Error("unavailable endpoint was misclassified as TLS rejection");
    return {kind: "network-rejected"};
  }
  throw new Error("unavailable endpoint unexpectedly returned " + result.kind + ":" + (result.status ?? "unknown"));
};
const requestGatewayForCertificateVerification = async (material, label) => {
  let result;
  let error;
  try {
    result = await requestGateway(material, undefined);
  } catch (candidate) {
    error = candidate;
  }
  if (result?.kind === "http") throw new Error(label + " unexpectedly returned HTTP " + result.status);
  if (error !== undefined && error.code !== "ECONNRESET" && result?.kind !== "tls-rejected") throw error;
  const localPort = result?.localPort ?? error?.localPort;
  if (!Number.isInteger(localPort)) throw new Error(label + " did not expose a local probe port");
  return {kind: "gateway-certificate-rejection-pending", localPort};
};
const delegation = (overrides = {}) => { const now = Math.floor(Date.now() / 1000); return {iss: "api-internal", aud: "aroma-gateway", originalCaller, operationId, correlationId: "compose-proof-correlation", traceparent: "00-00000000000000000000000000000000-0000000000000000-00", iat: now, exp: now + 30, jti: "compose-proof-jti-" + now, kid: "api-internal-delegation-v1", ...overrides}; };
const signed = (claims) => { const payload = Buffer.from(canonical(claims)); return payload.toString("base64url") + "." + sign(null, payload, apiInternal.signingKey).toString("base64url"); };
if (phase === "replay") {
  const replay = await requestApi(baseBody);
  assertNormativeBinding(replay, "restart replay");
  assertNoRawCanaryInResponses();
  console.log(JSON.stringify({phase, replayStatus: replay.status, normativeExistingResult: true, normativeBindingBody: true}));
} else {
  const allowed = await requestApi(baseBody);
  assertNormativeBinding(allowed, "allowed caller registration");
  const replay = await requestApi(baseBody);
  assertNormativeBinding(replay, "exact replay");
  const offerConflict = await requestApi({...baseBody, sourceOfferKeyHash: identities[1]});
  const sourceConflict = await requestApi({...baseBody, offerRef: "off_00000000000000000000000002"});
  if (offerConflict.kind !== "http" || offerConflict.status !== 409 || sourceConflict.kind !== "http" || sourceConflict.status !== 409) throw new Error("binding conflict was accepted");
  const noCertificate = await requestGateway({...gateway, certPem: undefined, keyPem: undefined}, undefined);
  const untrustedCertificate = await requestGatewayForCertificateVerification(untrusted, "untrusted client certificate");
  const foreignIdentity = await requestGateway(foreign, undefined);
  const unavailableEndpoint = await assertUnavailableEndpointRejected();
  if (noCertificate.kind !== "tls-rejected" || untrustedCertificate.kind !== "gateway-certificate-rejection-pending" || unavailableEndpoint.kind !== "network-rejected" || foreignIdentity.kind !== "http" || foreignIdentity.status !== 401) throw new Error("transport identity rejection proof failed");
  const forged = signed(delegation()).split("."); forged[1] = "AA";
  const expired = signed(delegation({iat: Math.floor(Date.now() / 1000) - 30, exp: Math.floor(Date.now() / 1000) - 10}));
  const wrongCaller = signed(delegation({originalCaller: "orders-service"}));
  const wrongOperation = signed(delegation({operationId: "wrongOperation"}));
  const delegationStatuses = [];
  for (const token of [forged.join("."), expired, wrongCaller, wrongOperation]) delegationStatuses.push((await requestGateway(apiMaterial, token)).status);
  if (delegationStatuses.some((value) => value !== 403)) throw new Error("invalid delegation was accepted: " + delegationStatuses.join(","));
  const malformed = await requestApi(baseBody, "{");
  if (malformed.kind !== "http" || malformed.status !== 400) throw new Error("malformed JSON did not return contract 400");
  assertNoRawCanaryInResponses();
  console.log(JSON.stringify({phase, allowedStatus: allowed.status, replayStatus: replay.status, normativeExistingResult: true, normativeBindingBody: true, offerRefConflictStatus: offerConflict.status, sourceIdentityConflictStatus: sourceConflict.status, noClientCertificate: noCertificate.kind, untrustedClientCertificate: untrustedCertificate.kind, untrustedClientPort: untrustedCertificate.localPort, unavailableEndpoint: unavailableEndpoint.kind, foreignIdentityStatus: foreignIdentity.status, forgedDelegationStatus: delegationStatuses[0], expiredDelegationStatus: delegationStatuses[1], wrongOriginalCallerStatus: delegationStatuses[2], wrongOperationStatus: delegationStatuses[3], malformedJsonStatus: malformed.status}));
}`;
}

async function runAromaBindingProofFixture(
  projectName,
  secretsDir,
  composeFile,
  fixture,
  phase,
  snapshot,
  environment,
) {
  const beforeEvents = aromaGatewayTlsProofEvents(
    projectName,
    secretsDir,
    composeFile,
  );
  const source = aromaBindingProofSource({
    phase,
    supplierRef: snapshot.supplierRef,
    snapshotRef: snapshot.snapshotRef,
    identities: snapshot.identities,
    environment,
    rawCanary: snapshot.rawCanary,
  });
  const output = runDocker(
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      `${projectName}_coffee_internal_api`,
      "--volume",
      `${fixture.directory}:/run/aroma-proof:ro`,
      CUSTOMER_TEST_IMAGE,
      "node",
      "--input-type=module",
    ],
    { input: source },
  );
  const line = output.trim().split("\\n").filter(Boolean).at(-1);
  assert.ok(line, `aroma binding ${phase} fixture returned no evidence`);
  const result = JSON.parse(line);
  if (result.untrustedClientPort !== undefined) {
    assertAromaGatewayClientCertificateVerification(
      projectName,
      secretsDir,
      composeFile,
      beforeEvents,
      result.untrustedClientPort,
      phase,
    );
    result.untrustedClientCertificate = "tls-rejected";
    result.gatewayClientCertificateVerification = true;
    delete result.untrustedClientPort;
  }
  return result;
}

async function queryAromaBindingCount(
  port,
  snapshot,
  credentials,
  platformConfig,
) {
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "aroma-gateway",
  );
  const connectionString = [
    "postgresql://",
    encodeURIComponent(credential.username),
    ":",
    encodeURIComponent(credential.password),
    "@127.0.0.1:",
    port,
    "/",
    service.database,
  ].join("");
  const client = await createPostgresClient(connectionString);
  try {
    const result = await client.query(
      "SELECT count(*)::int AS count FROM integration.provider_offer_bindings WHERE supplier_ref = $1",
      [snapshot.supplierRef],
    );
    return result.rows[0]?.count;
  } finally {
    await client.end();
  }
}

async function assertAromaBindingTopology(
  projectName,
  secretsDir,
  composeFile,
) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  assert.equal(
    rows.length,
    2,
    "aroma binding proof must start exactly two Compose services",
  );
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const runtime of ["api-internal", "aroma-gateway"]) {
    const row = byService.get(runtime);
    assert.ok(row, `${runtime} is absent from aroma binding proof`);
    assert.equal(row.State, "running", `${runtime} is not running`);
    assert.equal(row.Health, "healthy", `${runtime} is not healthy`);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const networks = Object.keys(
      container.NetworkSettings.Networks ?? {},
    ).sort();
    const expected =
      runtime === "api-internal"
        ? [`${projectName}_coffee_internal_api`]
        : [
            `${projectName}_coffee_internal_api`,
            `${projectName}_coffee_postgres_data`,
          ].sort();
    assert.deepEqual(
      networks,
      expected,
      `${runtime} connected to an unexpected network`,
    );
    assert.equal(
      networks.some((network) => network.includes("coffee_provider_egress")),
      false,
      `${runtime} connected to provider egress`,
    );
  }
  return byService;
}

function aromaGatewayTlsProofEvents(projectName, secretsDir, composeFile) {
  const marker = "AROMA_BINDING_TLS_PROOF ";
  return runCompose(
    projectName,
    secretsDir,
    ["logs", "--no-color", "--no-log-prefix", "--tail", "200", "aroma-gateway"],
    { composeFile },
  )
    .split("\n")
    .flatMap((line) => {
      const markerIndex = line.indexOf(marker);
      if (markerIndex === -1) return [];
      try {
        return [JSON.parse(line.slice(markerIndex + marker.length))];
      } catch {
        throw new Error("Gateway TLS proof log marker is not valid JSON");
      }
    });
}

function assertAromaGatewayClientCertificateVerification(
  projectName,
  secretsDir,
  composeFile,
  beforeEvents,
  localPort,
  phase,
) {
  const beforeMaxSequence = Math.max(
    0,
    ...beforeEvents.map((event) =>
      typeof event.sequence === "number" ? event.sequence : 0,
    ),
  );
  const event = aromaGatewayTlsProofEvents(
    projectName,
    secretsDir,
    composeFile,
  ).find(
    (candidate) =>
      candidate.event === "tlsClientError" &&
      candidate.category === "client-certificate-verification" &&
      candidate.errorCode !== "unknown" &&
      typeof candidate.authorizationError === "string" &&
      candidate.sequence > beforeMaxSequence &&
      candidate.localPort === 4301 &&
      candidate.remotePort === localPort,
  );
  assert.ok(
    event,
    `aroma binding ${phase} has no Gateway-side client certificate verification error for this connection`,
  );
}

function parseComposePs(output) {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

function serviceRows(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  return parseComposePs(
    runCompose(
      projectName,
      secretsDir,
      ["ps", "--all", "--no-trunc", "--format", "json"],
      { composeFile },
    ),
  );
}

function assertHealthy(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const service of [...RUNTIMES, "edge-nginx", "kafka"]) {
    const row = byService.get(service);
    assert.ok(row, `${service} is absent from Compose ps`);
    assert.equal(row.State, "running", `${service} is not running`);
    assert.equal(row.Health, "healthy", `${service} is not healthy`);
  }
  return byService;
}

function assertTelemetryEnvironment(rows) {
  for (const runtime of RUNTIMES) {
    const row = rows.get(runtime);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const environment = Object.fromEntries(
      (container.Config.Env ?? []).map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    assert.equal(
      environment.OTEL_SERVICE_NAME,
      runtime,
      `${runtime} OTEL service identity is missing`,
    );
    assert.equal(
      environment.OTEL_PROPAGATORS,
      "tracecontext,baggage",
      `${runtime} OTEL propagators drifted`,
    );
    assert.equal(
      environment.OTEL_RESOURCE_ATTRIBUTES,
      "service.namespace=coffee-platform,deployment.environment=development",
      `${runtime} OTEL resource identity drifted`,
    );
    assert.equal(
      environment.OTEL_EXPORTER_OTLP_PROTOCOL,
      "http/protobuf",
      `${runtime} OTEL protocol drifted`,
    );
  }
}

function assertSecretMounts(
  projectName,
  secretsDir,
  rows,
  composeFile = COMPOSE_FILE,
) {
  for (const runtime of RUNTIMES) {
    const row = rows.get(runtime);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const mount = container.Mounts.find(
      (candidate) =>
        candidate.Destination === "/run/secrets/coffee-platform.yaml",
    );
    assert.ok(mount, `${runtime} scoped secret mount is absent`);
    assert.equal(
      mount.RW,
      false,
      `${runtime} scoped secret mount must be read-only`,
    );
    assert.equal(
      resolve(mount.Source),
      resolve(join(secretsDir, `${runtime}.yaml`)),
      `${runtime} secret source is not the ephemeral tmpfs directory`,
    );
    assert.equal(
      container.Config.User,
      "node",
      `${runtime} image must run as node`,
    );
    const modeOutput = runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        runtime,
        "node",
        "-e",
        "const fs=require('node:fs'); const {execFileSync}=require('node:child_process'); const s=fs.statSync(process.env.COFFEE_RUNTIME_SECRETS_FILE); const df=execFileSync('df',['-T','/run/secrets'],{encoding:'utf8'}); console.log(JSON.stringify({mode:s.mode & 0o777,uid:process.getuid(),tmpfs:df.includes('tmpfs')}));",
      ],
      { composeFile },
    ).trim();
    const mode = JSON.parse(modeOutput.split("\n").at(-1));
    assert.deepEqual(
      mode,
      { mode: 0o400, uid: 1000, tmpfs: true },
      `${runtime} scoped secret ownership/mode/tmpfs mismatch`,
    );
  }
  const nginx = rows.get("edge-nginx");
  const nginxContainer = JSON.parse(runDocker(["inspect", nginx.ID]))[0];
  const nginxSecretFiles = [
    "public.crt",
    "public.key",
    "upstream-ca.crt",
    "client.crt",
    "client.key",
  ];
  assert.equal(nginxContainer.Config.User, "101:101");
  assert.equal(
    nginxContainer.Mounts.some(
      (mount) => mount.Destination === "/run/secrets/coffee-platform.yaml",
    ),
    false,
  );
  for (const name of nginxSecretFiles) {
    const destination = `/run/secrets/edge-nginx/${name}`;
    const mount = nginxContainer.Mounts.find(
      (candidate) => candidate.Destination === destination,
    );
    assert.ok(mount, `edge-nginx scoped secret ${destination} is absent`);
    assert.equal(mount.RW, false, `${destination} must be read-only`);
    assert.equal(
      resolve(mount.Source),
      resolve(join(secretsDir, "edge-nginx", name)),
    );
  }
  const nginxSecretReadback = runCompose(
    projectName,
    secretsDir,
    [
      "exec",
      "-T",
      "edge-nginx",
      "sh",
      "-ceu",
      'for path in /run/secrets/edge-nginx/public.crt /run/secrets/edge-nginx/public.key /run/secrets/edge-nginx/upstream-ca.crt /run/secrets/edge-nginx/client.crt /run/secrets/edge-nginx/client.key; do test -r "$path"; test ! -w "$path"; test "$(stat -c \'%u:%g:%a\' "$path")" = 101:101:400; done',
    ],
    { composeFile },
  );
  assert.equal(nginxSecretReadback.trim(), "");
}

function assertKafkaDurableRetention(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  const topic = `coffee.compose.smoke.${randomUUID().replaceAll("-", "")}`;
  const message = randomUUID();
  const produceScript = [
    `topic=${topic}`,
    `message=${message}`,
    '/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic "$topic" --partitions 1 --replication-factor 1 >/dev/null',
    'printf \'%s\\n\' "$message" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$topic"',
    "printf 'broker-ack:%s' \"$message\"",
  ].join("\n");
  const before = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  assert.ok(before, "Kafka is absent before retention proof");
  const beforeContainer = JSON.parse(runDocker(["inspect", before.ID]))[0];
  const logVolume = beforeContainer.Mounts.find(
    (mount) =>
      mount.Type === "volume" && mount.Destination === "/var/lib/kafka/data",
  );
  assert.equal(
    logVolume?.Name,
    `${projectName}_kafka_data`,
    "Kafka log directory must use the project volume",
  );
  assert.ok(
    beforeContainer.Config.Env.includes(
      `KAFKA_LOG_DIRS=${logVolume.Destination}`,
    ),
    "Kafka configured log directory differs from its volume",
  );
  assert.equal(
    beforeContainer.Config.Labels?.["com.docker.compose.project"],
    projectName,
    "Kafka container is outside the requested Compose project",
  );
  const acknowledged = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", produceScript],
    { composeFile },
  ).trim();
  assert.equal(
    acknowledged,
    `broker-ack:${message}`,
    "Kafka broker acknowledgement was not observed",
  );

  runCompose(
    projectName,
    secretsDir,
    ["rm", "--force", "--stop", "--volumes", "kafka"],
    { composeFile },
  );
  runCompose(
    projectName,
    secretsDir,
    ["up", "--detach", "--wait", "--no-build", "kafka"],
    { composeFile },
  );

  const after = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  assert.ok(after, "Kafka is absent after broker recreate");
  assert.notEqual(after.ID, before.ID, "Kafka container was not recreated");
  assert.equal(after.State, "running", "Kafka is not running after recreate");
  assert.equal(after.Health, "healthy", "Kafka is not healthy after recreate");
  const afterContainer = JSON.parse(runDocker(["inspect", after.ID]))[0];
  assert.ok(
    afterContainer.Mounts.some(
      (mount) =>
        mount.Name === logVolume.Name &&
        mount.Destination === logVolume.Destination,
    ),
    "Kafka recreate changed its log volume",
  );
  assert.equal(
    afterContainer.Config.Labels?.["com.docker.compose.project"],
    projectName,
    "Kafka recreate changed the Compose project scope",
  );

  const recoveryScript = [
    `topic=${topic}`,
    `message=${message}`,
    'received=$(/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$topic" --group "$topic-recovery" --from-beginning --max-messages 1 --timeout-ms 15000 | tr -d \'\\r\')',
    'test "$received" = "$message"',
    "printf '%s' \"$received\"",
  ].join("\n");
  const retained = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", recoveryScript],
    { composeFile },
  ).trim();
  assert.equal(
    retained,
    message,
    "Kafka acknowledged record was not retained across broker recreate",
  );
  return {
    brokerAcknowledged: true,
    logDirectory: logVolume.Destination,
    volume: logVolume.Name,
    containerRecreated: true,
    sameComposeProject: true,
    recoveredHealthy: true,
    retainedRecord: true,
    replicationFactor: 1,
  };
}

function prepareRecoveryKafkaBootstrap(
  projectName,
  secretsDir,
  platformConfig,
  composeFile,
  runComposeOperation = (_operation, ...args) => runCompose(...args),
  launchIdentity,
) {
  runComposeOperation(
    "kafka-up",
    projectName,
    secretsDir,
    ["up", "--detach", "--wait", "--no-build", "kafka"],
    { composeFile, inherit: true },
  );
  const client =
    "--bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties";
  const script = [
    ...buildKafkaRegistryBootstrapScript(
      platformConfig,
      launchIdentity,
      client,
    ),
  ];
  for (const [runtime, service] of Object.entries(platformConfig.services)) {
    for (const consumer of service.kafka.consumers.filter(
      (entry) => entry.processing === "durable",
    )) {
      const target = composeKafkaTarget(
        platformConfig,
        runtime,
        launchIdentity,
      );
      for (const topic of consumer.topics) {
        // Только новый изолированный broker: durable runtime не выбирает offset сам.
        script.push(
          `/opt/kafka/bin/kafka-consumer-groups.sh ${client} --group ${JSON.stringify(target.groups[consumer.groupId])} --topic ${JSON.stringify(target.topics[topic])} --reset-offsets --to-earliest --execute >/dev/null`,
        );
      }
    }
  }
  runComposeOperation(
    "kafka-offset-bootstrap",
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", script.join("\n")],
    { composeFile },
  );
}

function prepareKafkaNamespaceRegistry(
  projectName,
  secretsDir,
  platformConfig,
  composeFile,
  launchIdentity,
) {
  runCompose(
    projectName,
    secretsDir,
    ["up", "--detach", "--wait", "--no-build", "kafka"],
    { composeFile, inherit: true },
  );
  const script = buildKafkaRegistryBootstrapScript(
    platformConfig,
    launchIdentity,
  );
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", script.join("\n")],
    { composeFile },
  );
}

async function prepareKafkaNativeFixture(
  projectName,
  secretsDir,
  runId,
  composeFile = COMPOSE_FILE,
  launchIdentity,
) {
  const platformConfig = parseYaml(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const lifecycleTopic = platformConfig.kafka.topics.ordersLifecycle.name;
  const mappingTopic = platformConfig.kafka.topics.catalogMapping.name;
  const kafkaTargets = {
    orders: composeKafkaTarget(
      platformConfig,
      "orders-service",
      launchIdentity,
    ),
    preparation: composeKafkaTarget(
      platformConfig,
      "orders-aroma-preparation",
      launchIdentity,
    ),
    activation: composeKafkaTarget(
      platformConfig,
      "catalog-activation-worker",
      launchIdentity,
    ),
  };
  const lifecyclePhysicalTopic = kafkaTargets.orders.topics[lifecycleTopic];
  const mappingPhysicalTopic = kafkaTargets.activation.topics[mappingTopic];
  const lifecyclePartitions =
    platformConfig.kafka.topics.ordersLifecycle.partitions;
  const mappingPartitions =
    platformConfig.kafka.topics.catalogMapping.partitions;
  const malformed = `delivery-proof-malformed-${runId}`;
  const malformedEnvelope = {
    envelopeVersion: "1",
    messageId: malformed,
    messageType: "DeliveryProof.LiveEvent",
    occurredAt: new Date().toISOString(),
    producer: "orders-service",
    correlationId: `correlation-${malformed}`,
    causationId: null,
    traceparent: `00-${randomUUID().replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 16)}-01`,
    aggregate: {
      type: "DeliveryProof.Aggregate",
      ref: `delivery-proof-malformed-${runId}`,
      version: "1",
    },
    payload: { value: "malformed-header", sequence: 1 },
  };
  const malformedEncoded = Buffer.from(
    JSON.stringify(malformedEnvelope),
    "utf8",
  ).toString("base64");
  const script = [
    `lifecycle=${JSON.stringify(lifecyclePhysicalTopic)}`,
    `mapping=${JSON.stringify(mappingPhysicalTopic)}`,
    `lifecyclePartitions=${lifecyclePartitions}`,
    `mappingPartitions=${mappingPartitions}`,
    `/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic "$lifecycle" --partitions "$lifecyclePartitions" --replication-factor 1 >/dev/null`,
    `/opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --create --if-not-exists --topic "$mapping" --partitions "$mappingPartitions" --replication-factor 1 >/dev/null`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group ${JSON.stringify(kafkaTargets.preparation.groups["orders-aroma-preparation-v1"])} --topic "$lifecycle" --reset-offsets --to-earliest --execute >/dev/null`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group ${JSON.stringify(kafkaTargets.preparation.groups["orders-catalog-mapping-v2"])} --topic "$mapping" --reset-offsets --to-earliest --execute >/dev/null`,
    `printf '%s;%s|%s\\n' 'messageId:null' 'native-malformed' "$(printf '%s' '${malformedEncoded}' | base64 -d)" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --property parse.headers=true --property headers.delimiter=';' --property headers.separator=',' --property headers.key.separator=':' --property null.marker=null --property parse.key=true --property key.separator='|' --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$lifecycle" >/dev/null`,
  ].join("\n");
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", script],
    { composeFile },
  );
  return {
    lifecycleTopic,
    mappingTopic,
    malformed,
    malformedEnvelope,
    kafkaTargets,
  };
}

export function nativeFoundationSource({
  runId,
  lifecycleTopic,
  mappingTopic,
  malformed,
  malformedEnvelope,
  ordersDatabase,
  kafkaTargets,
  waitMs = remainingGateWaitMs(),
}) {
  return `import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const runId = ${JSON.stringify(runId)};
const lifecycleTopic = ${JSON.stringify(lifecycleTopic)};
const mappingTopic = ${JSON.stringify(mappingTopic)};
const malformed = ${JSON.stringify(malformed)};
const malformedEnvelope = ${JSON.stringify(malformedEnvelope)};
const kafkaTargets = ${JSON.stringify(kafkaTargets)};
const ordersDatabaseTarget = ${JSON.stringify(ordersDatabase)};
if (typeof ordersDatabaseTarget !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(ordersDatabaseTarget)) throw new Error('validated Orders database target is invalid');
const runtimeRequire = createRequire(createRequire('/app/package.json').resolve('@coffee-platform/runtime'));
const importPackage = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const kafkaRequire = createRequire(runtimeRequire.resolve('@coffee-platform/kafka-runtime'));
const importKafkaPackage = (name) => import(pathToFileURL(kafkaRequire.resolve(name)).href);
const {load} = await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const configModule = await importPackage('@coffee-platform/config');
const databaseModule = await importPackage('@coffee-platform/database');
const {withTransaction} = databaseModule;
const ownerModule = await importPackage('@coffee-platform/database/owner');
const inboxModule = await importKafkaPackage('@coffee-platform/inbox');
const outboxModule = await importKafkaPackage('@coffee-platform/outbox');
const kafkaModule = await importPackage('@coffee-platform/kafka-runtime');
const nativeModule = await import(pathToFileURL(runtimeRequire.resolve('@coffee-platform/kafka-runtime')).href.replace(/index\\.js$/u, 'native.js'));
const config = await configModule.loadPlatformConfig('/app/config/platform.yaml', (text) => load(text, {json: true}));
const secret = load(await readFile('/run/secrets/coffee-platform.yaml', 'utf8'), {json: true});
const at = (path) => path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, secret.secrets);
const databaseCredential = at('postgres.ordersService');
const kafkaCredential = at('kafka.orders');
if (!databaseCredential || !kafkaCredential) throw new Error('scoped proof credentials are missing');
const ordersService = {...config.services['orders-service'], database: ordersDatabaseTarget};
const preparationService = config.services['orders-aroma-preparation'];
if (!ordersService.dbPool || !preparationService.kafka) throw new Error('proof service configuration is missing');
const delivery = config.kafka.delivery;
const databaseOptions = {
  owner: 'orders-service',
  database: ordersService.database,
  allowedDatabase: ordersService.database,
  host: config.postgres.host,
  port: config.postgres.port,
  user: databaseCredential.username,
  password: databaseCredential.password,
  ssl: config.postgres.sslMode === 'prefer' ? 'prefer' : true,
  pool: ordersService.dbPool,
  shutdownGraceMs: config.platform.shutdownGraceMs,
};
let database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const inboxOptions = {schema: 'orders', table: 'delivery_live_inbox_messages', quarantineTable: 'delivery_live_inbox_quarantine'};
const outboxOptions = {schema: 'orders', table: 'delivery_live_outbox_messages'};
let inbox = inboxModule.createSqlInboxStore(database, inboxOptions);
let outbox = outboxModule.createSqlOutboxStore(database, outboxOptions);
let ownerWrite = ownerModule.defineStatement(database, 'INSERT INTO orders.delivery_live_owner_effects (message_id, aggregate_ref, effect_value, applied_at) VALUES ($1, $2, $3, $4::timestamptz)');
const countRows = ownerModule.defineStatement(database, 'SELECT (SELECT count(*)::int FROM orders.delivery_live_owner_effects WHERE aggregate_ref = $1) AS owner_count, (SELECT count(*)::int FROM orders.delivery_live_inbox_messages WHERE message_id = ANY($2::text[])) AS inbox_count, (SELECT count(*)::int FROM orders.delivery_live_outbox_messages WHERE message_id = ANY($2::text[])) AS outbox_count, (SELECT count(*)::int FROM orders.delivery_live_inbox_quarantine WHERE reason = $3 AND envelope = $4::jsonb) AS malformed_count, (SELECT count(*)::int FROM orders.delivery_live_inbox_quarantine WHERE reason = $5 AND message_id = $6) AS conflict_count');
const waitFor = async (predicate, timeoutMs = ${waitMs}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('bounded proof wait exceeded');
};
const queryProofRows = async (aggregateRef, ids, malformedValue, conflictId) => withTransaction(database, {mode: 'background'}, (transaction) => countRows(transaction, [aggregateRef, ids, 'KAFKA_ENVELOPE_INVALID', JSON.stringify(malformedValue), 'INBOX_HASH_CONFLICT', conflictId]));
const traceparent = (id) => {
  const trace = createHash('sha256').update(id).digest('hex');
  return '00-' + trace.slice(0, 32) + '-' + trace.slice(0, 16) + '-01';
};
const envelope = (id, aggregateRef, sequence, payload) => ({
  envelopeVersion: '1', messageId: id, messageType: 'DeliveryProof.LiveEvent',
  occurredAt: new Date().toISOString(), producer: 'orders-service',
  correlationId: 'correlation-' + id, causationId: null, traceparent: traceparent(id),
  aggregate: {type: 'DeliveryProof.Aggregate', ref: aggregateRef, version: String(sequence)},
  payload: {...payload, sequence},
});
const calls = new Map();
const active = new Map();
let maxActive = 0;
const signalEventId = runId + '-sigterm';
let signalGateEntered = false;
let signalGateRelease;
const binding = {
  processing: 'durable', database, inbox,
  decode: (value) => value,
  handle: async (transaction, event, record) => {
    calls.set(event.messageId, (calls.get(event.messageId) ?? 0) + 1);
    const key = record.topic + ':' + record.partition;
    const current = (active.get(key) ?? 0) + 1;
    active.set(key, current); maxActive = Math.max(maxActive, current);
    if (event.messageId === signalEventId) {
      signalGateEntered = true;
      await new Promise((resolve) => { signalGateRelease = resolve; });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sequence = Number(event.payload?.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('proof sequence is invalid');
    await ownerWrite(transaction, [event.messageId, event.aggregate.ref, JSON.stringify(event.payload), event.occurredAt]);
    const decision = await outbox.enqueue(transaction, {
      messageId: event.messageId, messageType: event.messageType, topic: record.topic,
      aggregateRef: event.aggregate.ref, aggregateSequence: sequence, ownerVersion: event.aggregate.version,
      partitionKey: record.key, schemaVersion: event.envelopeVersion, envelope: event,
      payload: event.payload, occurredAt: event.occurredAt, correlationId: event.correlationId,
      traceparent: event.traceparent,
    });
    if (decision !== 'created') throw new Error('proof Outbox decision was ' + decision);
    active.set(key, current - 1);
  },
};
const credentials = {username: kafkaCredential.username, password: kafkaCredential.password, caPem: kafkaCredential.caPem};
const nativeOptions = {
  brokers: config.kafka.brokers, clientId: 'delivery-proof-native-' + runId, protocol: config.kafka.clientProtocol,
  username: credentials.username, password: credentials.password, sslCaPem: credentials.caPem,
  maxPending: delivery.queueCapacity, maxMessageBytes: delivery.maxMessageBytes,
  sendTimeoutMs: delivery.sendTimeoutMs, receiveTimeoutMs: delivery.receiveTimeoutMs,
  commitTimeoutMs: delivery.commitTimeoutMs, shutdownTimeoutMs: delivery.shutdownTimeoutMs,
};
const producerRuntime = kafkaModule.createKafkaRuntime({runtime: 'orders-service', config: config.kafka, service: ordersService.kafka, credentials, physicalTargets: kafkaTargets.orders});
const consumerService = preparationService.kafka;
const consumerA = kafkaModule.createKafkaRuntime({runtime: 'orders-aroma-preparation', config: config.kafka, service: consumerService, credentials, physicalTargets: kafkaTargets.preparation});
const consumerB = kafkaModule.createKafkaRuntime({runtime: 'orders-aroma-preparation', config: config.kafka, service: consumerService, credentials, physicalTargets: kafkaTargets.preparation});
consumerA.bind('orders-aroma-preparation-v1', binding);
consumerB.bind('orders-aroma-preparation-v1', binding);
await producerRuntime.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const malformedWire = JSON.stringify(malformedEnvelope);
await consumerA.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await consumerB.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await waitFor(() => consumerA.metrics().assigned > 0 && consumerB.metrics().assigned > 0);
const rebalanceBaseline = [consumerA.metrics().recoveryTotal, consumerB.metrics().recoveryTotal];
const orderedAggregate = 'delivery-proof-order-' + runId;
const orderedKey = 'delivery-proof-key-' + runId;
const ordered = [];
for (const sequence of [1, 2, 3]) {
  const id = runId + '-ordered-' + sequence;
  const ack = await producerRuntime.send(lifecycleTopic, orderedKey, envelope(id, orderedAggregate, sequence, {value: 'ordered-' + sequence}));
  if (ack.kind !== 'ack') throw new Error('native producer did not acknowledge ordered record');
  ordered.push({id, ack});
}
await waitFor(() => [...ordered].every(({id}) => (calls.get(id) ?? 0) === 1));
const partitions = new Set(ordered.map(({ack}) => ack.partition));
if (partitions.size !== 1 || maxActive !== 1) throw new Error('partition ordering or single-flight bound failed');
const offsets = ordered.map(({ack}) => BigInt(ack.offset));
if (!(offsets[0] < offsets[1] && offsets[1] < offsets[2])) throw new Error('producer offsets are not ordered');
const conflict = envelope(ordered[0].id, orderedAggregate, 9, {value: 'conflict'});
const conflictAck = await producerRuntime.send(lifecycleTopic, orderedKey, conflict);
if (conflictAck.kind !== 'ack') throw new Error('conflict fixture was not acknowledged');
await waitFor(async () => (await queryProofRows(orderedAggregate, ordered.map(({id}) => id), malformedWire, ordered[0].id)).rows[0]?.conflict_count === 1);
const normalRows = await queryProofRows(orderedAggregate, ordered.map(({id}) => id), malformedWire, ordered[0].id);
if (normalRows.rows[0]?.owner_count !== 3 || normalRows.rows[0]?.inbox_count !== 3 || normalRows.rows[0]?.outbox_count !== 3 || normalRows.rows[0]?.malformed_count !== 1 || normalRows.rows[0]?.conflict_count !== 1) throw new Error('durable normal/quarantine proof failed');
if (consumerA.metrics().recoveryTotal !== rebalanceBaseline[0] || consumerB.metrics().recoveryTotal !== rebalanceBaseline[1]) throw new Error('two-consumer rebalance recovery grew after stable assignment');
let signalReceived = false;
let activeAtSignal;
let signalStopComplete = false;
let signalStopError;
let signalStopPromise;
const signalHandler = () => {
  signalReceived = true;
  const consumerAMetrics = consumerA.metrics();
  const consumerBMetrics = consumerB.metrics();
  activeAtSignal = {
    consumerA: consumerAMetrics,
    consumerB: consumerBMetrics,
    total: consumerAMetrics.active + consumerBMetrics.active,
  };
  setTimeout(() => signalGateRelease?.(), 25).unref?.();
  signalStopPromise = Promise.all([
    consumerA.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs)),
    consumerB.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs)),
  ]).then(
    () => { signalStopComplete = true; },
    (error) => { signalStopError = error; signalStopComplete = true; },
  );
};
process.once('SIGTERM', signalHandler);
const signalAggregate = 'delivery-proof-sigterm-' + runId;
const signalEvent = envelope(signalEventId, signalAggregate, 1, {value: 'sigterm'});
const signalAck = await producerRuntime.send(lifecycleTopic, 'delivery-proof-sigterm-key-' + runId, signalEvent);
if (signalAck.kind !== 'ack') throw new Error('SIGTERM fixture event was not acknowledged');
await waitFor(() => signalGateEntered);
process.kill(process.pid, "SIGTERM");
await waitFor(() => signalStopPromise !== undefined);
await waitFor(() => signalStopComplete, delivery.shutdownTimeoutMs + delivery.revokeTimeoutMs + 1000);
if (signalStopError) throw signalStopError;
const closedMetrics = {consumerA: consumerA.metrics(), consumerB: consumerB.metrics()};
if (!signalReceived || !signalGateEntered || activeAtSignal?.total < 1) throw new Error('SIGTERM did not interrupt an active gated handler');
for (const metrics of Object.values(closedMetrics)) {
  if (metrics.assigned !== 0 || metrics.active !== 0 || metrics.pending !== 0) throw new Error('SIGTERM consumer stop left work in flight');
}
process.removeListener('SIGTERM', signalHandler);
const signalRows = await queryProofRows(signalAggregate, [signalEventId], malformedWire, ordered[0].id);
if (signalRows.rows[0]?.owner_count !== 1) throw new Error('SIGTERM fixture did not durably commit the owner effect');

const mapProducer = kafkaModule.createKafkaRuntime({runtime: 'catalog-activation-worker', config: config.kafka, service: config.services['catalog-activation-worker'].kafka, credentials, physicalTargets: kafkaTargets.activation});
await mapProducer.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const openNative = async (groupId) => {
  let native;
  let resolveAssignment;
  let rejectAssignment;
  const assigned = new Promise((resolve, reject) => {resolveAssignment = resolve; rejectAssignment = reject;});
  native = await nativeModule.createNativeConsumer({...nativeOptions, groupId, topics: [mappingTopic], autoOffsetReset: 'error', physicalTargets: kafkaTargets.preparation}, (event) => {
    if (event.type === 'assigned') void native.assign(event.partitions).then(() => resolveAssignment()).catch(rejectAssignment);
    else if (event.type === 'revoked') void native.unassign().catch(rejectAssignment);
    else rejectAssignment(new Error('native rebalance failed'));
  });
  await native.connect(); await native.subscribe([mappingTopic]);
  let assignmentDone = false;
  const buffered = [];
  void assigned.then(() => {assignmentDone = true;}, () => {assignmentDone = true;});
  await waitFor(async () => {
    buffered.push(...await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
    return assignmentDone;
  });
  await assigned;
  return {...native, poll: async (limit, signal) => buffered.length ? buffered.splice(0, limit) : native.poll(limit, signal)};
};
const commitWithPoll = async (native, record) => {
  let finished = false;
  const poller = (async () => {
    while (!finished) {
      try {
        await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
      } catch {
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })();
  try {
    return await native.commit(record.topic, record.partition, (BigInt(record.offset) + 1n).toString());
  } finally {
    finished = true;
    await poller;
  }
};
const mapId = runId + '-db-unknown';
const mapEvent = envelope(mapId, 'delivery-proof-db-unknown-' + runId, 1, {value: 'db-unknown'});
const mapAck = await mapProducer.send(mappingTopic, 'delivery-proof-map-' + runId, mapEvent);
if (mapAck.kind !== 'ack') throw new Error('mapping fixture was not acknowledged');
const firstNative = await openNative('orders-catalog-mapping-v2');
const firstRecords = [];
await waitFor(async () => {
  firstRecords.push(...await firstNative.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  return firstRecords.length === 1;
});
let unknownCode;
try {
  await kafkaModule.processKafkaRecord({...firstRecords[0], key: firstRecords[0].key ?? ''}, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async () => { throw new Error('offset commit blackhole'); },
  });
} catch (error) { unknownCode = error?.code; }
if (unknownCode !== 'OFFSET_COMMIT_OUTCOME_UNKNOWN') throw new Error('DB commit-before-offset proof returned ' + (unknownCode ?? 'no error'));
await firstNative.close();
const secondNative = await openNative('orders-catalog-mapping-v2');
const secondRecords = [];
await waitFor(async () => {
  secondRecords.push(...await secondNative.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  return secondRecords.length === 1;
});
await kafkaModule.processKafkaRecord({...secondRecords[0], key: secondRecords[0].key ?? ''}, {
  runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
  leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
  commit: async (record) => commitWithPoll(secondNative, record),
});
if (calls.get(mapId) !== 1) throw new Error('DB unknown redelivery reran committed handler');
await secondNative.close();
for (let batch = 0; batch < 5; batch++) {
  const result = await outboxModule.relayOutboxBatch(outbox, database, async (claim, signal) => {
    const sender = claim.message.topic === mappingTopic ? mapProducer : producerRuntime;
    return sender.send(claim.message.topic, claim.message.partitionKey, claim.message.envelope, signal);
  }, {nowMs: Date.now(), leaseOwner: 'delivery-proof-seed-relay', policy: delivery});
  if (result.unknown || result.failed) throw new Error('seed Outbox relay did not finalize known acknowledgements');
  if (result.claimed === 0) break;
  if (batch === 4) throw new Error('seed Outbox relay exceeded its bound');
}
await mapProducer.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));

const crashId = runId + '-outbox-crash';
const crashEvent = envelope(crashId, 'delivery-proof-outbox-crash-' + runId, 1, {value: 'outbox-crash'});
await withTransaction(database, {mode: 'background'}, (transaction) => outbox.enqueue(transaction, {
  messageId: crashId, messageType: crashEvent.messageType, topic: lifecycleTopic,
  aggregateRef: crashEvent.aggregate.ref, aggregateSequence: 1, ownerVersion: crashEvent.aggregate.version, partitionKey: orderedKey,
  schemaVersion: crashEvent.envelopeVersion, envelope: crashEvent, payload: crashEvent.payload,
  occurredAt: crashEvent.occurredAt, correlationId: crashEvent.correlationId, traceparent: crashEvent.traceparent,
}));
let brokerAckedBeforeFinalize = false;
let brokerAckMessageId;
try {
  await outboxModule.relayOutboxBatch(outbox, database, async (claim) => {
    if (claim.message.messageId !== crashEvent.messageId) throw new Error('outbox claim message ID changed before publish');
    const ack = await producerRuntime.send(claim.message.topic, claim.message.partitionKey, claim.message.envelope);
    if (ack.kind !== 'ack') throw new Error('outbox native ack was not known');
    brokerAckedBeforeFinalize = true;
    brokerAckMessageId = claim.message.messageId;
    database.resource.destroy();
    return {kind: 'ack'};
  }, {nowMs: Date.now(), leaseOwner: 'delivery-proof-crash-' + runId, policy: delivery, signal: AbortSignal.timeout(delivery.shutdownTimeoutMs)});
} catch {}
if (!brokerAckedBeforeFinalize) throw new Error('broker ack-before-finalize fixture did not reach the ack');
database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
outbox = outboxModule.createSqlOutboxStore(database, outboxOptions);
const expireLease = ownerModule.defineStatement(database, "UPDATE orders.delivery_live_outbox_messages SET lease_until = clock_timestamp() - interval '1 millisecond' WHERE message_id = $1");
await withTransaction(database, {mode: 'background'}, (transaction) => expireLease(transaction, [crashId]));
const recovered = await producerRuntime.relay(outbox, database, AbortSignal.timeout(delivery.shutdownTimeoutMs));
const stateRow = ownerModule.defineStatement(database, 'SELECT state FROM orders.delivery_live_outbox_messages WHERE message_id = $1');
const crashState = await withTransaction(database, {mode: 'background'}, (transaction) => stateRow(transaction, [crashId]));
if (recovered.published !== 1 || crashState.rows[0]?.state !== 'Published' || brokerAckMessageId !== crashEvent.messageId) throw new Error('Outbox ack-before-finalize recovery failed');
await producerRuntime.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
await database.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
console.log(JSON.stringify({
  ordered: {acknowledged: true, records: ordered.length, partition: ordered[0].ack.partition, offsets: ordered.map(({ack}) => ack.offset), maxActive},
  rebalance: {twoConsumersAssigned: true, bounded: true, recoveryTotal: [consumerA.metrics().recoveryTotal, consumerB.metrics().recoveryTotal]},
  quarantine: {malformed: true, malformedHeader: 'known-header-empty-value', conflict: true},
  sigterm: {received: signalReceived, gateEntered: signalGateEntered, activeAtSignal, closedMetrics, ownerCount: signalRows.rows[0]?.owner_count},
  dbCommitBeforeOffset: {code: unknownCode, redelivered: true, handlerCalls: calls.get(mapId)},
  outboxAckBeforeFinalize: {brokerAcked: brokerAckedBeforeFinalize, recovered: recovered.published === 1, stableMessageId: brokerAckMessageId === crashEvent.messageId},
}));`;
}

export function nativeKafkaBlackholeSource({
  runId,
  mappingTopic,
  ordersDatabase,
  physicalTargets,
}) {
  return `import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';

const runId = ${JSON.stringify(runId)};
const mappingTopic = ${JSON.stringify(mappingTopic)};
const physicalTargets = ${JSON.stringify(physicalTargets)};
const ordersDatabaseTarget = ${JSON.stringify(ordersDatabase)};
if (typeof ordersDatabaseTarget !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(ordersDatabaseTarget)) throw new Error('validated Orders database target is invalid');
const runtimeRequire = createRequire(createRequire('/app/package.json').resolve('@coffee-platform/runtime'));
const importPackage = (name) => import(pathToFileURL(runtimeRequire.resolve(name)).href);
const kafkaRequire = createRequire(runtimeRequire.resolve('@coffee-platform/kafka-runtime'));
const importKafkaPackage = (name) => import(pathToFileURL(kafkaRequire.resolve(name)).href);
const {load} = await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const configModule = await importPackage('@coffee-platform/config');
const databaseModule = await importPackage('@coffee-platform/database');
const ownerModule = await importPackage('@coffee-platform/database/owner');
const inboxModule = await importKafkaPackage('@coffee-platform/inbox');
const outboxModule = await importKafkaPackage('@coffee-platform/outbox');
const kafkaModule = await importPackage('@coffee-platform/kafka-runtime');
const nativeModule = await import(pathToFileURL(runtimeRequire.resolve('@coffee-platform/kafka-runtime')).href.replace(/index\\.js$/u, 'native.js'));
const config = await configModule.loadPlatformConfig('/app/config/platform.yaml', (text) => load(text, {json: true}));
const secret = load(await readFile('/run/secrets/coffee-platform.yaml', 'utf8'), {json: true});
const at = (path) => path.split('.').reduce((value, key) => value && typeof value === 'object' ? value[key] : undefined, secret.secrets);
const databaseCredential = at('postgres.ordersService');
const kafkaCredential = at('kafka.orders');
if (!databaseCredential || !kafkaCredential) throw new Error('scoped proof credentials are missing');
const ordersService = {...config.services['orders-service'], database: ordersDatabaseTarget};
const delivery = config.kafka.delivery;
const databaseOptions = {
  owner: 'orders-service', database: ordersService.database, allowedDatabase: ordersService.database,
  host: config.postgres.host, port: config.postgres.port, user: databaseCredential.username,
  password: databaseCredential.password, ssl: config.postgres.sslMode === 'prefer' ? 'prefer' : true,
  pool: ordersService.dbPool, shutdownGraceMs: config.platform.shutdownGraceMs,
};
const database = databaseModule.createDatabase(databaseOptions);
await database.resource.start(AbortSignal.timeout(delivery.shutdownTimeoutMs));
const inbox = inboxModule.createSqlInboxStore(database, {schema: 'orders', table: 'delivery_live_inbox_messages', quarantineTable: 'delivery_live_inbox_quarantine'});
const outbox = outboxModule.createSqlOutboxStore(database, {schema: 'orders', table: 'delivery_live_outbox_messages'});
const ownerWrite = ownerModule.defineStatement(database, 'INSERT INTO orders.delivery_live_owner_effects (message_id, aggregate_ref, effect_value, applied_at) VALUES ($1, $2, $3, $4::timestamptz)');
const ownerCount = ownerModule.defineStatement(database, 'SELECT count(*)::int AS count FROM orders.delivery_live_owner_effects WHERE message_id = $1');
const binding = {
  processing: 'durable', database, inbox,
  decode: (value) => value,
  handle: async (transaction, event) => {
    await ownerWrite(transaction, [event.messageId, event.aggregate.ref, JSON.stringify(event.payload), event.occurredAt]);
    const decision = await outbox.enqueue(transaction, {
      messageId: event.messageId, messageType: event.messageType, topic: mappingTopic,
      aggregateRef: event.aggregate.ref, aggregateSequence: Number(event.payload?.sequence), ownerVersion: event.aggregate.version,
      partitionKey: event.aggregate.ref, schemaVersion: event.envelopeVersion, envelope: event,
      payload: event.payload, occurredAt: event.occurredAt, correlationId: event.correlationId,
      traceparent: event.traceparent,
    });
    if (decision !== 'created') throw new Error('blackhole Outbox decision was ' + decision);
  },
};
const credentials = {username: kafkaCredential.username, password: kafkaCredential.password, caPem: kafkaCredential.caPem};
const openConsumer = async () => {
  let target;
  let resolveAssignment;
  let rejectAssignment;
  const assignment = new Promise((resolve, reject) => { resolveAssignment = resolve; rejectAssignment = reject; });
  target = await nativeModule.createNativeConsumer({
    brokers: config.kafka.brokers, clientId: 'delivery-proof-blackhole-' + runId, protocol: config.kafka.clientProtocol,
    username: credentials.username, password: credentials.password, sslCaPem: credentials.caPem,
    maxPending: delivery.queueCapacity, maxMessageBytes: delivery.maxMessageBytes,
    sendTimeoutMs: delivery.sendTimeoutMs, receiveTimeoutMs: delivery.receiveTimeoutMs,
    commitTimeoutMs: delivery.commitTimeoutMs, shutdownTimeoutMs: delivery.shutdownTimeoutMs,
    groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], autoOffsetReset: 'error', physicalTargets,
  }, (event) => {
    if (event.type === 'assigned') void target.assign(event.partitions).then(resolveAssignment).catch(rejectAssignment);
    else if (event.type === 'revoked') void target.unassign().catch(rejectAssignment);
    else rejectAssignment(event.error);
  });
  await target.connect();
  await target.subscribe([mappingTopic]);
  let assignmentDone = false;
  const buffered = [];
  void assignment.then(() => {assignmentDone = true;}, () => {assignmentDone = true;});
  const deadline = Date.now() + 15000;
  while (!assignmentDone && Date.now() < deadline) buffered.push(...await target.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs)));
  if (!assignmentDone) throw new Error('paused-broker assignment wait exceeded');
  await assignment;
  return {...target, poll: async (limit, signal) => buffered.length ? buffered.splice(0, limit) : target.poll(limit, signal)};
};
const commitWithPoll = async (native, record) => {
  let finished = false;
  const poller = (async () => {
    while (!finished) {
      try {
        await native.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
      } catch {
        if (!finished) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })();
  try {
    return await native.commit(record.topic, record.partition, (BigInt(record.offset) + 1n).toString());
  } finally {
    finished = true;
    await poller;
  }
};
const messageIdOf = (value) => {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value).toString('utf8'));
    return parsed && typeof parsed === 'object' && typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
  } catch {
    return undefined;
  }
};
const eventId = runId + '-broker-blackhole';
let consumer = await openConsumer();
const records = [];
const recordDeadline = Date.now() + 15000;
while (records.length === 0 && Date.now() < recordDeadline) {
  try {
    records.push(...await consumer.poll(1, AbortSignal.timeout(Math.max(1, Math.min(delivery.receiveTimeoutMs, recordDeadline - Date.now())))));
  } catch {
    /* Keep polling until the fixture's bounded deadline. */
  }
}
if (records.length !== 1 || messageIdOf(records[0].value) !== eventId) throw new Error('paused-broker fixture did not consume the expected record');
const record = {...records[0], key: records[0].key ?? ''};
let releaseGate;
const release = new Promise((resolve) => { releaseGate = resolve; });
let continueGate;
const continueCommit = new Promise((resolve) => { continueGate = resolve; });
const server = createServer((request, response) => {
  if (request.url === '/go') { continueGate(); response.end('go'); return; }
  if (request.url === '/release') { releaseGate(); response.end('release'); return; }
  response.statusCode = 404; response.end();
});
let port;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
});
let commitCode;
const commitStartedAt = Date.now();
try {
  await kafkaModule.processKafkaRecord(record, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async (processed) => {
      console.log('BLACKHOLE_READY:' + port);
      await continueCommit;
      await commitWithPoll(consumer, processed);
    },
  });
  throw new Error('paused broker unexpectedly allowed commit');
} catch (error) {
  commitCode = error?.code;
}
const commitElapsedMs = Date.now() - commitStartedAt;
if (commitCode !== 'OFFSET_COMMIT_OUTCOME_UNKNOWN') throw new Error('paused-broker commit outcome was ' + (commitCode ?? 'unknown'));
if (commitElapsedMs > delivery.commitTimeoutMs + delivery.receiveTimeoutMs + 1000) throw new Error('paused-broker commit exceeded its bounded deadline: ' + commitElapsedMs + 'ms');
const owner = await databaseModule.withTransaction(database, {mode: 'background'}, (transaction) => ownerCount(transaction, [eventId]));
if (owner.rows?.[0]?.count !== 1) throw new Error('DB commit did not precede paused-broker offset outcome');
console.log('BLACKHOLE_UNKNOWN:' + commitCode);
await release;
try {
  await consumer.poll(1, AbortSignal.timeout(delivery.receiveTimeoutMs));
} catch {}
await new Promise((resolve) => server.close(resolve));
await consumer.close();
const recoveredConsumer = await openConsumer();
const redelivery = [];
const redeliveryDeadline = Date.now() + 15000;
while (redelivery.length === 0 && Date.now() < redeliveryDeadline) {
  try {
    redelivery.push(...await recoveredConsumer.poll(1, AbortSignal.timeout(Math.max(1, Math.min(delivery.receiveTimeoutMs, redeliveryDeadline - Date.now())))));
  } catch {
    /* A committed offset is a valid bounded no-redelivery observation. */
  }
}
const redelivered = redelivery.length === 1;
if (redelivery.length > 1) throw new Error('paused-broker recovery returned more than one record');
if (redelivered && messageIdOf(redelivery[0].value) !== eventId) throw new Error('paused-broker redelivery was not the expected record');
if (redelivered) {
  await kafkaModule.processKafkaRecord({...redelivery[0], key: redelivery[0].key ?? ''}, {
    runtime: 'orders-aroma-preparation', groupId: 'orders-catalog-mapping-v2', topics: [mappingTopic], binding,
    leaseMs: delivery.leaseMs, maxMessageBytes: delivery.maxMessageBytes, signal: new AbortController().signal,
    commit: async (processed) => commitWithPoll(recoveredConsumer, processed),
  });
}
const recoveredOwner = await databaseModule.withTransaction(database, {mode: 'background'}, (transaction) => ownerCount(transaction, [eventId]));
if (recoveredOwner.rows?.[0]?.count !== 1) throw new Error('paused-broker recovery duplicated the owner effect');
await recoveredConsumer.close();
await database.resource.stop(AbortSignal.timeout(delivery.shutdownTimeoutMs));
console.log(JSON.stringify({kind: 'paused-broker', commitOutcome: commitCode, bounded: true, commitElapsedMs, redelivered, recoveryObservation: redelivered ? 'duplicate-no-second-effect' : 'offset-committed', recovered: true, recordMessageId: eventId, recordPartition: record.partition, recordOffset: record.offset}));`;
}

async function runKafkaBlackholeProof(
  projectName,
  secretsDir,
  runId,
  mappingTopic,
  ordersDatabase,
  composeFile,
  physicalTargets,
  onPaused,
) {
  const messageId = `${runId}-broker-blackhole`;
  const trace = randomUUID().replaceAll("-", "").padEnd(32, "0").slice(0, 32);
  const envelope = {
    envelopeVersion: "1",
    messageId,
    messageType: "DeliveryProof.LiveEvent",
    occurredAt: new Date().toISOString(),
    producer: "orders-service",
    correlationId: `${runId}-broker-blackhole-correlation`,
    causationId: null,
    traceparent: `00-${trace}-${trace.slice(0, 16)}-01`,
    aggregate: {
      type: "DeliveryProof.Aggregate",
      ref: `${runId}-broker-blackhole-aggregate`,
      version: "1",
    },
    payload: { sequence: 1, value: "broker-blackhole" },
  };
  const encoded = Buffer.from(JSON.stringify(envelope), "utf8").toString(
    "base64",
  );
  const physicalTopic = physicalTargets.topics[mappingTopic];
  const physicalGroup = physicalTargets.groups["orders-catalog-mapping-v2"];
  const resetAndProduce = [
    `mapping=${JSON.stringify(physicalTopic)}`,
    `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group ${JSON.stringify(physicalGroup)} --topic "$mapping" --reset-offsets --to-latest --execute >/dev/null`,
    `printf '%s|%s\\n' blackhole-${runId} "$(printf '%s' '${encoded}' | base64 -d)" | /opt/kafka/bin/kafka-console-producer.sh --sync --command-property acks=all --property parse.key=true --property key.separator='|' --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --topic "$mapping" >/dev/null`,
  ].join("\n");
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "kafka", "sh", "-ec", resetAndProduce],
    { composeFile },
  );

  const kafka = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "kafka",
  );
  const orders = serviceRows(projectName, secretsDir, composeFile).find(
    (row) => row.Service === "orders-service",
  );
  assert.ok(kafka, "Kafka is absent before paused-broker proof");
  assert.ok(orders, "orders-service is absent before paused-broker proof");
  const kafkaBefore = onPaused
    ? ownedDependencySnapshot(projectName, "kafka", kafka.ID)
    : undefined;
  const outputLines = [];
  const waiters = [];
  let outputBuffer = "";
  const onOutput = (chunk) => {
    outputBuffer += chunk;
    const lines = outputBuffer.split("\n");
    outputBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      outputLines.push(trimmed);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (trimmed.startsWith(waiters[index].prefix)) {
          const waiter = waiters.splice(index, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(trimmed);
        }
      }
    }
  };
  const waitForLine = (prefix, timeoutMs) => {
    const previous = outputLines.find((line) => line.startsWith(prefix));
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`${prefix} was not observed within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      waiters.push({ prefix, resolve, reject, timer });
    });
  };
  const child = spawnCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "orders-service", "node", "--input-type=module"],
    {
      composeFile,
      input: nativeKafkaBlackholeSource({
        runId,
        mappingTopic,
        ordersDatabase,
        physicalTargets,
      }),
      onOutput,
    },
  );
  let paused = false;
  let finished = false;
  let proofError;
  let restoreError;
  let evidence;
  const waitForKafkaApi = async (timeoutMs = remainingGateWaitMs()) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        runCompose(
          projectName,
          secretsDir,
          [
            "exec",
            "-T",
            "kafka",
            "sh",
            "-ec",
            "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties >/dev/null",
          ],
          { composeFile },
        );
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `paused-broker recovery did not restore Kafka API: ${lastError?.message ?? "timeout"}`,
    );
  };
  void child.done.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  try {
    const readyLine = await waitForLine("BLACKHOLE_READY:", 15000);
    const port = Number(readyLine.slice("BLACKHOLE_READY:".length));
    assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
    if (kafkaBefore)
      assertDependencyIdentity(projectName, "kafka", kafkaBefore);
    const pausedAt = new Date().toISOString();
    runDocker(["pause", kafka.ID]);
    paused = true;
    runDocker([
      "exec",
      orders.ID,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/go').then(() => process.exit(0)).catch(() => process.exit(1))`,
    ]);
    const unknownLine = await waitForLine("BLACKHOLE_UNKNOWN:", 15000);
    assert.equal(
      unknownLine,
      "BLACKHOLE_UNKNOWN:OFFSET_COMMIT_OUTCOME_UNKNOWN",
      "paused-broker commit did not become a bounded unknown outcome",
    );
    if (onPaused) await onPaused(pausedAt);
    runDocker(["unpause", kafka.ID]);
    paused = false;
    // Kafka's 30s health interval and 5s probe can extend beyond 30s after unpause.
    await waitForDockerHealthy(kafka.ID, 60_000);
    await waitForKafkaApi();
    if (kafkaBefore)
      assertDependencyIdentity(projectName, "kafka", kafkaBefore);
    runDocker([
      "exec",
      orders.ID,
      "node",
      "-e",
      `fetch('http://127.0.0.1:${port}/release').then(() => process.exit(0)).catch(() => process.exit(1))`,
    ]);
    await child.done;
    const finalLine = [...outputLines]
      .reverse()
      .find((line) => line.startsWith("{"));
    assert.ok(finalLine, "paused-broker proof did not return evidence JSON");
    evidence = JSON.parse(finalLine);
    assert.equal(evidence.kind, "paused-broker");
    assert.equal(evidence.commitOutcome, "OFFSET_COMMIT_OUTCOME_UNKNOWN");
    assert.ok(
      Number.isSafeInteger(evidence.commitElapsedMs) &&
        evidence.commitElapsedMs >= 0,
      "paused-broker commit elapsed bound evidence is missing",
    );
    assert.equal(evidence.bounded, true);
    assert.equal(evidence.recovered, true);
    assert.equal(evidence.recordMessageId, messageId);
    if (evidence.redelivered) {
      assert.equal(evidence.recoveryObservation, "duplicate-no-second-effect");
    } else {
      assert.equal(evidence.recoveryObservation, "offset-committed");
      const offsetOutput = runCompose(
        projectName,
        secretsDir,
        [
          "exec",
          "-T",
          "kafka",
          "sh",
          "-ec",
          `/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:9092 --command-config /etc/kafka/secrets/client.properties --group ${JSON.stringify(physicalGroup)} --describe`,
        ],
        { composeFile },
      );
      const committed = offsetOutput
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find(
          (fields) =>
            fields[0] === physicalGroup &&
            fields[1] === physicalTopic &&
            fields[2] === String(evidence.recordPartition),
        );
      assert.ok(
        committed,
        "paused-broker proof did not expose the recovered group offset",
      );
      assert.ok(
        BigInt(committed[3]) >= BigInt(evidence.recordOffset) + 1n,
        "paused-broker group offset did not advance after recovery",
      );
    }
  } catch (error) {
    proofError = error;
  } finally {
    if (paused) {
      try {
        runDocker(["unpause", kafka.ID]);
        await waitForDockerHealthy(kafka.ID, 60_000);
        await waitForKafkaApi();
      } catch (error) {
        restoreError = error;
      }
    }
    if (!finished) {
      child.child.kill("SIGTERM");
      await child.done.catch(() => undefined);
    }
  }
  if (proofError && restoreError)
    throw new AggregateError(
      [proofError, restoreError],
      "paused-broker proof and restoration failed",
    );
  if (restoreError)
    throw new Error("paused-broker restoration failed", {
      cause: restoreError,
    });
  if (proofError) throw proofError;
  return evidence;
}

async function assertReadiness(
  projectName,
  secretsDir,
  composeFile = COMPOSE_FILE,
) {
  for (const runtime of RUNTIMES) {
    await waitForRuntimeReadiness(
      projectName,
      secretsDir,
      runtime,
      200,
      remainingGateWaitMs(),
      composeFile,
    );
    runCompose(
      projectName,
      secretsDir,
      [
        "exec",
        "-T",
        runtime,
        ...RUNTIME_HEALTHCHECK,
        "/health/live",
        "/metrics",
      ],
      { composeFile },
    );
  }
  runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "edge-nginx", "nginx", "-t", "-q"],
    { composeFile },
  );
}

async function assertNginxIngress(publicHost, caPem) {
  const probe = (path) =>
    new Promise((resolveProbe, reject) => {
      const request = httpsRequest(
        {
          hostname: "127.0.0.1",
          port: 8443,
          path,
          method: "GET",
          servername: publicHost,
          ...(caPem ? { ca: caPem } : {}),
          minVersion: "TLSv1.3",
          rejectUnauthorized: true,
          timeout: 5_000,
        },
        (response) => {
          response.resume();
          response.once("end", () =>
            resolveProbe({
              status: response.statusCode,
              contentType: response.headers["content-type"],
            }),
          );
        },
      );
      request.once("timeout", () =>
        request.destroy(new Error("nginx ingress probe timed out")),
      );
      request.once("error", reject);
      request.end();
    });
  assert.equal(
    (await probe("/health/live")).status,
    200,
    "nginx TLS live route is unavailable",
  );
  const session = await probe("/auth/session");
  assert.equal(
    session.status,
    401,
    "nginx did not reach the private Edge session route",
  );
  assert.match(
    session.contentType ?? "",
    /^application\/problem\+json/,
    "session denial must remain typed",
  );
}

function runtimeHealthStatus(
  projectName,
  secretsDir,
  runtime,
  path,
  composeFile = COMPOSE_FILE,
) {
  const output = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", runtime, ...RUNTIME_HEALTH_STATUSES, path],
    { composeFile },
  ).trim();
  return Number(output.split("\n").at(-1));
}

// The ordinary healthcheck's 900 ms client deadline is shorter than a
// dependency's 1000 ms readiness deadline, so a blackhole needs a longer probe.
const DEPENDENCY_HEALTH_SOURCE = `import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {request} from 'node:https';
const require=createRequire(createRequire('/app/package.json').resolve('@coffee-platform/runtime'));
const {load}=require('js-yaml');
const {parseServiceTransportMaterial,verifyTransportPeer}=require('@coffee-platform/security');
try {
  const runtime=process.env.RUNTIME_NAME,port=Number(process.env.PORT),path=process.argv[2];
  if(!/^[a-z0-9-]+$/u.test(runtime??'')||!Number.isSafeInteger(port)||port<1||!['/health/live','/health/ready'].includes(path))throw Error();
  const document=load(await readFile(process.env.COFFEE_RUNTIME_SECRETS_FILE,'utf8'),{json:true});
  const config=load(await readFile(process.env.COFFEE_CONFIG_FILE,'utf8'),{json:true});
  const environment=document.environment;
  const material=parseServiceTransportMaterial(document.secrets.security.serviceTransportKeys[runtime],environment,runtime);
  const timeout=config.platform.health.timeoutMs+config.platform.health.intervalMs;
  const status=await new Promise((resolve,reject)=>{
    const client=request({host:'127.0.0.1',port,path,method:'GET',ca:material.caPem,cert:material.certPem,key:material.keyPem,minVersion:'TLSv1.3',rejectUnauthorized:true,timeout,
      checkServerIdentity:(_host,certificate)=>{try{verifyTransportPeer(certificate,environment,runtime);return undefined;}catch{return Error('peer identity invalid');}}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});
    client.once('timeout',()=>client.destroy(Error('request timed out')));client.once('error',reject);client.end();
  });
  if(!Number.isInteger(status))throw Error();
  console.log(status);
} catch { console.error('dependency health probe failed');process.exitCode=1; }`;

function dependencyHealthStatus(containerId, path) {
  const output = runDocker(
    ["exec", "-i", containerId, "node", "--input-type=module", "-", path],
    { input: DEPENDENCY_HEALTH_SOURCE, timeout: 10_000 },
  ).trim();
  assert.match(output, /^(?:200|503)$/u, "dependency health status invalid");
  return Number(output);
}

async function waitForDependencyHealth(containerId, path, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (dependencyHealthStatus(containerId, path) === expected)
        return expected;
    } catch {
      // A timeout or transport error is not an HTTP readiness response.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`dependency health did not reach HTTP ${expected}`);
}

function dependencyFailureLogged(containerId, dependency, since) {
  const output = runDocker(
    ["logs", "--since", since, "--tail", "200", containerId],
    { timeout: 10_000 },
  );
  return output.split("\n").some((line) => {
    try {
      const entry = JSON.parse(line);
      return (
        entry.event === "runtime.readiness.failed" &&
        entry.dependency === dependency
      );
    } catch {
      return false;
    }
  });
}

function ownedDependencySnapshot(projectName, runtime, containerId) {
  const row = assertOwnedRuntimeContainer(projectName, runtime, containerId);
  assert.match(row.Image ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(typeof row.State.StartedAt, "string");
  return row;
}

function assertDependencyIdentity(projectName, runtime, before) {
  const after = ownedDependencySnapshot(projectName, runtime, before.Id);
  assert.equal(
    after.Image,
    before.Image,
    "dependency fault changed image identity",
  );
  assert.equal(
    after.State.StartedAt,
    before.State.StartedAt,
    "dependency fault restarted runtime",
  );
  return after;
}

function sharedPostgresSnapshot() {
  const row = inspectDockerObject([APPROVED_EXTERNAL_POSTGRES.containerId]);
  assert.equal(row.Id, APPROVED_EXTERNAL_POSTGRES.containerId);
  assert.equal(row.Image, APPROVED_EXTERNAL_POSTGRES.imageId);
  assert.equal(row.Name, "/coffee_postgres");
  assert.equal(
    row.NetworkSettings?.Networks?.[EXTERNAL_POSTGRES_NETWORK]?.NetworkID,
    APPROVED_EXTERNAL_POSTGRES.dataNetworkId,
  );
  return {
    networks: row.NetworkSettings.Networks,
    route: externalPostgresRoute(row.Id),
  };
}

function ownedDefaultRoute(containerId) {
  return runDocker(
    [
      "exec",
      containerId,
      "sh",
      "-c",
      `awk '$2 == "00000000" {print $3 ":" $4 ":" $7 ":" $8}' /proc/net/route | sort`,
    ],
    { timeout: 10_000 },
  ).trim();
}

export async function proveOwnedNetworkDependency({
  projectName,
  runtime,
  containerId,
  networkName,
  dependency,
  checkName,
}) {
  const before = ownedDependencySnapshot(projectName, runtime, containerId);
  const endpoint = before.NetworkSettings?.Networks?.[networkName];
  assert.match(endpoint?.NetworkID ?? "", /^[a-f0-9]{64}$/u);
  assert.match(endpoint.IPAddress ?? "", /^(?:\d{1,3}\.){3}\d{1,3}$/u);
  assert.ok(Array.isArray(endpoint.Aliases) && endpoint.Aliases.length > 0);
  assert.ok(
    endpoint.Aliases.every((alias) => /^[a-z0-9][a-z0-9_.-]*$/u.test(alias)),
  );
  if (networkName === EXTERNAL_POSTGRES_NETWORK)
    assert.equal(endpoint.NetworkID, APPROVED_EXTERNAL_POSTGRES.dataNetworkId);
  else
    assert.ok(
      networkName === `${projectName}_coffee_internal_api` ||
        (networkName === `${projectName}_coffee_kafka_event` &&
          runtime === "orders-aroma-preparation" &&
          dependency === "kafka"),
    );
  const network = inspectDockerObject([endpoint.NetworkID]);
  assert.equal(network.Id, endpoint.NetworkID);
  assert.ok(network.Containers?.[containerId]);
  const otherEndpoints = { ...network.Containers };
  delete otherEndpoints[containerId];
  const postgres = sharedPostgresSnapshot();
  const otherNetworks = { ...before.NetworkSettings.Networks };
  delete otherNetworks[networkName];
  const route = ownedDefaultRoute(containerId);
  const beforeStatus = await waitForDependencyHealth(
    containerId,
    "/health/ready",
    200,
  );
  const since = new Date().toISOString();
  let bodyError;
  let during;
  let liveDuring;
  let attempted = false;
  let restored;
  let restoreError;
  try {
    const current = assertDependencyIdentity(projectName, runtime, before);
    assert.deepEqual(
      current.NetworkSettings.Networks,
      before.NetworkSettings.Networks,
    );
    assert.equal(
      ownedDefaultRoute(containerId),
      route,
      "runtime default route changed before fault",
    );
    assert.deepEqual(
      inspectDockerObject([endpoint.NetworkID]).Containers,
      network.Containers,
    );
    assert.deepEqual(sharedPostgresSnapshot(), postgres);
    attempted = true;
    runDocker(["network", "disconnect", endpoint.NetworkID, containerId], {
      timeout: 10_000,
    });
    const disconnected = assertDependencyIdentity(projectName, runtime, before);
    assert.equal(
      disconnected.NetworkSettings?.Networks?.[networkName],
      undefined,
    );
    during = await waitForDependencyHealth(containerId, "/health/ready", 503);
    liveDuring = await waitForDependencyHealth(
      containerId,
      "/health/live",
      200,
    );
    assert.ok(
      dependencyFailureLogged(containerId, checkName, since),
      "expected dependency failure was not observed",
    );
  } catch (error) {
    bodyError = error;
  } finally {
    if (attempted) {
      try {
        const current = inspectDockerObject([containerId]);
        const labels = current.Config?.Labels ?? {};
        assert.equal(current.Id, containerId);
        assert.equal(current.Image, before.Image);
        assert.equal(labels["com.docker.compose.project"], projectName);
        assert.equal(labels["com.docker.compose.service"], runtime);
        if (!current.NetworkSettings?.Networks?.[networkName]) {
          runDocker(
            [
              "network",
              "connect",
              ...endpoint.Aliases.flatMap((alias) => ["--alias", alias]),
              endpoint.NetworkID,
              containerId,
            ],
            { timeout: 10_000 },
          );
        }
        const after = assertDependencyIdentity(projectName, runtime, before);
        const reattached = after.NetworkSettings?.Networks?.[networkName];
        assert.equal(reattached?.NetworkID, endpoint.NetworkID);
        assert.deepEqual(
          [...reattached.Aliases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
          [...endpoint.Aliases].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        );
        assert.match(reattached.IPAddress ?? "", /^(?:\d{1,3}\.){3}\d{1,3}$/u);
        const remainingNetworks = { ...after.NetworkSettings.Networks };
        delete remainingNetworks[networkName];
        assert.deepEqual(
          remainingNetworks,
          otherNetworks,
          "unrelated runtime endpoint changed",
        );
        assert.equal(
          ownedDefaultRoute(containerId),
          route,
          "runtime default route changed after fault",
        );
        const currentNetwork = inspectDockerObject([endpoint.NetworkID]);
        const currentOthers = { ...currentNetwork.Containers };
        delete currentOthers[containerId];
        assert.deepEqual(
          currentOthers,
          otherEndpoints,
          "another network endpoint changed",
        );
        const afterStatus = await waitForDependencyHealth(
          containerId,
          "/health/ready",
          200,
        );
        restored = {
          runtime,
          dependency,
          before: beforeStatus,
          during,
          after: afterStatus,
          liveDuring,
          restored: true,
          addressChanged: reattached.IPAddress !== endpoint.IPAddress,
        };
      } catch (error) {
        restoreError = error;
      }
      try {
        assert.deepEqual(
          sharedPostgresSnapshot(),
          postgres,
          "shared PostgreSQL endpoint or route changed",
        );
      } catch (error) {
        restoreError = restoreError
          ? new AggregateError(
              [restoreError, error],
              "dependency and PostgreSQL restoration checks failed",
            )
          : error;
      }
    }
  }
  if (bodyError && restoreError)
    throw new AggregateError(
      [bodyError, restoreError],
      "dependency fault and restoration failed",
    );
  if (restoreError) throw restoreError;
  if (bodyError) throw bodyError;
  return restored;
}

function readRealtimeAuthCloseCount(projectName, containerId) {
  try {
    assertOwnedRuntimeContainer(projectName, "realtime-gateway", containerId);
    const invocation = buildRealtimeAuthCloseInvocation(containerId);
    const output = runDocker(invocation.args, { timeout: 5000 }).trim();
    if (!/^(?:0|[1-9][0-9]*)$/u.test(output))
      throw new Error("metric value is invalid");
    const count = Number(output);
    if (!Number.isSafeInteger(count)) throw new Error("metric count is unsafe");
    return count;
  } catch {
    throw new Error("BROWSER_REALTIME_AUTH_METRIC_UNAVAILABLE");
  }
}

function assertOwnedRuntimeContainer(projectName, runtime, containerId) {
  try {
    if (!/^[0-9a-f]{64}$/u.test(containerId ?? ""))
      throw new Error("runtime identity is missing");
    const inspected = JSON.parse(runDocker(["inspect", containerId]));
    if (!Array.isArray(inspected) || inspected.length !== 1)
      throw new Error("runtime identity is ambiguous");
    const row = inspected[0];
    const labels = row.Config?.Labels ?? {};
    if (
      row.Id !== containerId ||
      row.State?.Running !== true ||
      labels["com.docker.compose.project"] !== projectName ||
      labels["com.docker.compose.service"] !== runtime
    )
      throw new Error("runtime identity changed");
    return row;
  } catch {
    throw new Error("BROWSER_RUNTIME_OWNERSHIP_INVALID");
  }
}

async function restartBrowserFixtureCustomerService(
  projectName,
  secretsDir,
  containerId,
  composeFile,
) {
  assertOwnedRuntimeContainer(projectName, "customer-service", containerId);
  let restarted;
  try {
    restarted = runDocker(["restart", "--time", "10", containerId], {
      timeout: 15_000,
    }).trim();
  } catch {
    throw new Error("BROWSER_CUSTOMER_RESTART_FAILED");
  }
  if (restarted !== containerId)
    throw new Error("BROWSER_CUSTOMER_RESTART_IDENTITY_CHANGED");
  await waitForRuntimeReadiness(
    projectName,
    secretsDir,
    "customer-service",
    200,
    remainingGateWaitMs(),
    composeFile,
  );
  assertOwnedRuntimeContainer(projectName, "customer-service", containerId);
  return true;
}

function runtimeReadinessStatus(
  projectName,
  secretsDir,
  runtime,
  composeFile = COMPOSE_FILE,
) {
  return runtimeHealthStatus(
    projectName,
    secretsDir,
    runtime,
    "/health/ready",
    composeFile,
  );
}

async function waitForRuntimeReadiness(
  projectName,
  secretsDir,
  runtime,
  expected,
  timeoutMs = remainingGateWaitMs(),
  composeFile = COMPOSE_FILE,
) {
  const deadline = Date.now() + timeoutMs;
  let status = 0;
  let failure;
  while (Date.now() < deadline) {
    try {
      status = runtimeReadinessStatus(
        projectName,
        secretsDir,
        runtime,
        composeFile,
      );
      failure = undefined;
    } catch (error) {
      status = 0;
      failure = error;
    }
    if (status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${runtime} readiness did not reach ${expected}; last status was ${status}`,
    { cause: failure },
  );
}

function parseFinalJsonLine(output, code) {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  assert.ok(line, `${code}_EMPTY_OUTPUT`);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(code);
  }
}

export async function waitForRollbackFacts(
  readFacts,
  predicate,
  description,
  timeoutMs = remainingGateWaitMs(),
  onTimeout,
) {
  const deadline = Date.now() + timeoutMs;
  let lastFacts;
  while (Date.now() < deadline) {
    throwIfRollbackTerminationRequested();
    lastFacts = await readFacts();
    if (predicate(lastFacts)) return lastFacts;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const timeout = new Error(`ROLLBACK_${description}_TIMEOUT`, {
    cause: lastFacts,
  });
  try {
    await onTimeout?.(lastFacts);
  } catch {
    /* retain the original timeout if private diagnostics cannot be written */
  }
  throw timeout;
}

function serviceIdentity(rows) {
  return new Map([...rows].map(([name, row]) => [name, row.ID]));
}

function assertOnlyRuntimeRecreated(before, after, runtime) {
  assert.equal(
    before.size,
    after.size,
    "rollback service inventory changed during one-runtime config reload",
  );
  for (const [name, id] of before) {
    assert.ok(after.has(name), `rollback runtime disappeared: ${name}`);
    if (name === runtime)
      assert.notEqual(
        after.get(name),
        id,
        `rollback ${runtime} container was not recreated`,
      );
    else
      assert.equal(
        after.get(name),
        id,
        `rollback unexpectedly recreated ${name}`,
      );
  }
}

function assertOldRollbackOperationPreserved(
  facts,
  reservation,
  gateway,
  reservationState,
) {
  const currentReservation = facts.reservations.find(
    (row) => row.operation_ref === reservation.operation_ref,
  );
  const currentGateway = facts.gatewayRows.find(
    (row) => row.operation_ref === gateway.operation_ref,
  );
  assert.ok(
    currentReservation && currentGateway,
    "rollback old operation rows disappeared during rollback",
  );
  assert.deepEqual(
    {
      attempt_ref: currentReservation.attempt_ref,
      action: currentReservation.action,
      offer_ref: currentReservation.offer_ref,
      observed_before_milli: currentReservation.observed_before_milli,
      desired_milli: currentReservation.desired_milli,
      state: currentReservation.state,
      resolved: currentReservation.resolved,
    },
    {
      attempt_ref: reservation.attempt_ref,
      action: reservation.action,
      offer_ref: reservation.offer_ref,
      observed_before_milli: reservation.observed_before_milli,
      desired_milli: reservation.desired_milli,
      state: reservationState,
      resolved: true,
    },
    "rollback old Orders reservation identity or recovery state changed unexpectedly",
  );
  assert.deepEqual(
    {
      operation_kind: currentGateway.operation_kind,
      state: currentGateway.state,
      failure_code: currentGateway.failure_code,
    },
    {
      operation_kind: gateway.operation_kind,
      state: "UnknownOutcome",
      failure_code: gateway.failure_code,
    },
    "rollback immutable old Gateway journal row changed during rollback",
  );
  return { reservation: currentReservation, gateway: currentGateway };
}

function listDockerNames(args) {
  return runDocker(args).trim().split("\n").filter(Boolean).sort();
}

function inspectRollbackCleanupInventory(
  projectName,
  databaseProofContainer,
  databaseProofNetwork,
  browserProjectName,
) {
  const containers = listDockerNames([
    "ps",
    "--all",
    "--format",
    "{{.Names}}",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]);
  const namedContainers = databaseProofContainer
    ? listDockerNames(["ps", "--all", "--format", "{{.Names}}"]).filter(
        (name) => name === databaseProofContainer,
      )
    : [];
  const volumes = listDockerNames([
    "volume",
    "ls",
    "--format",
    "{{.Name}}",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]);
  const networks = listDockerNames([
    "network",
    "ls",
    "--format",
    "{{.Name}}",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
  ]);
  const namedNetworks = databaseProofNetwork
    ? listDockerNames(["network", "ls", "--format", "{{.Name}}"]).filter(
        (name) => name === databaseProofNetwork,
      )
    : [];
  const browserContainers = browserProjectName
    ? listDockerNames([
        "ps",
        "--all",
        "--format",
        "{{.Names}}",
        "--filter",
        `label=io.coffeeorderplatform.g15.browser.project=${browserProjectName}`,
      ])
    : [];
  return {
    containers: [
      ...new Set([...containers, ...namedContainers, ...browserContainers]),
    ],
    volumes,
    networks: [...new Set([...networks, ...namedNetworks])],
  };
}

async function readContainerConfigProof(
  projectName,
  secretsDir,
  composeFile,
  configRoot,
  lineage,
  phase,
) {
  const actualConfigBytes = await readFile(
    join(configRoot, "config/platform.yaml"),
  );
  const parsedConfig = parseYaml(actualConfigBytes.toString("utf8"), {
    json: true,
  });
  const mutationsEnabled =
    parsedConfig.services?.["aroma-convergence"]?.mutationsEnabled;
  const attestation = verifyLaunchConfigBytes({
    actualConfigBytes,
    baseConfigSha256: lineage.B.configSha256,
    runtime: "aroma-convergence",
    environment: parsedConfig.environment,
    databaseIsolationEnabled:
      parsedConfig.verification?.databaseIsolation?.enabled === true,
    mutationsEnabled,
  });
  assert.equal(
    attestation.phase,
    phase,
    "rollback config bytes did not match the expected ADR-0035 phase",
  );
  assert.equal(
    attestation.actualConfigSha256,
    phase === "disabled" ? lineage.D.configSha256 : lineage.R.configSha256,
    "rollback mounted config bytes do not match validated lineage",
  );
  const output = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "aroma-convergence", "node", "--input-type=module"],
    {
      composeFile,
      timeout: 10_000,
      input: rollbackRuntimeConfigProofSource(),
    },
  );
  const mounted = parseFinalJsonLine(
    output,
    "ROLLBACK_RUNTIME_CONFIG_READ_FAILED",
  );
  assert.deepEqual(
    mounted,
    { sha256: attestation.actualConfigSha256, mutationsEnabled },
    "rollback running convergence container did not load the exact validated mounted config bytes",
  );
  return { ...attestation, mutationsEnabled };
}

export function rollbackRuntimeConfigProofSource(
  packageJsonPath = "/app/package.json",
) {
  if (resolve(packageJsonPath) !== packageJsonPath)
    throw new Error("ROLLBACK_RUNTIME_PACKAGE_ROOT_INVALID");
  return `import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const runtimeRequire=createRequire(createRequire(${JSON.stringify(packageJsonPath)}).resolve('@coffee-platform/runtime'));
const {load}=await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const bytes=await readFile(process.env.COFFEE_CONFIG_FILE);const config=load(bytes.toString('utf8'));
console.log(JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex'),mutationsEnabled:config.services['aroma-convergence'].mutationsEnabled}));\n`;
}

export function validateObservabilityProviderBoundary({
  projectName,
  expectedConfigSha256,
  mounted,
  gateway,
  fixture,
  network,
  internalNetworks,
  fixtureImageId,
  fixtureDirectory,
}) {
  assert.match(expectedConfigSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.deepEqual(mounted, {
    sha256: expectedConfigSha256,
    mutationsEnabled: false,
  });
  const networkName = `${projectName}_coffee_provider_egress`;
  assert.match(network.Id ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(network.Name, networkName);
  assert.equal(network.Internal, true);
  assert.equal(network.Labels?.["com.docker.compose.project"], projectName);
  assert.equal(
    network.Labels?.["com.docker.compose.network"],
    "coffee_provider_egress",
  );
  for (const [container, service] of [
    [gateway, "aroma-gateway"],
    [fixture, "aroma-provider-fixture"],
  ]) {
    assert.match(container.Id ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(container.State?.Running, true);
    assert.equal(
      container.Config?.Labels?.["com.docker.compose.project"],
      projectName,
    );
    assert.equal(
      container.Config?.Labels?.["com.docker.compose.service"],
      service,
    );
    assert.equal(
      container.NetworkSettings?.Networks?.[networkName]?.NetworkID,
      network.Id,
    );
  }
  assert.deepEqual(Object.keys(fixture.NetworkSettings.Networks), [
    networkName,
  ]);
  assert.match(fixtureImageId ?? "", /^sha256:[0-9a-f]{64}$/u);
  assert.equal(fixture.Image, fixtureImageId);
  assert.equal(fixture.Config.Image, CUSTOMER_TEST_IMAGE);
  assert.deepEqual(fixture.Config.Cmd, [
    "node",
    "/run/aroma-proof/provider-server.mjs",
  ]);
  assert.ok(
    fixture.Mounts?.some(
      (mount) =>
        mount.Type === "bind" &&
        mount.Source === fixtureDirectory &&
        mount.Destination === "/run/aroma-proof",
    ),
  );
  assert.deepEqual(
    Object.keys(gateway.NetworkSettings.Networks).sort(),
    [
      `${projectName}_coffee_internal_api`,
      `${projectName}_coffee_postgres_data`,
      networkName,
    ].sort(),
  );
  assert.equal(internalNetworks.length, 2);
  for (const name of ["coffee_internal_api", "coffee_postgres_data"]) {
    const value = internalNetworks.find(
      (item) => item.Name === `${projectName}_${name}`,
    );
    assert.equal(value?.Internal, true);
    assert.match(value?.Id ?? "", /^[0-9a-f]{64}$/u);
    assert.equal(value?.Labels?.["com.docker.compose.project"], projectName);
    assert.equal(value?.Labels?.["com.docker.compose.network"], name);
    assert.equal(
      gateway.NetworkSettings.Networks[value.Name].NetworkID,
      value.Id,
    );
  }
  assert.ok(
    fixture.NetworkSettings.Networks[networkName].Aliases?.includes(
      "aromateacoffee.ru",
    ),
  );
  return {
    configSha256: expectedConfigSha256,
    mutationsEnabled: false,
    providerIsolated: true,
  };
}

export function attestObservabilityProviderBoundary({
  projectName,
  secretsDir,
  composeFile,
  expectedConfigSha256,
}) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  const row = (service) => {
    const matches = rows.filter(
      (value) => value.Service === service && value.State === "running",
    );
    assert.equal(matches.length, 1);
    return matches[0];
  };
  const gateway = JSON.parse(
    runDocker(["inspect", row("aroma-gateway").ID]),
  )[0];
  const fixture = JSON.parse(
    runDocker(["inspect", row("aroma-provider-fixture").ID]),
  )[0];
  row("aroma-convergence");
  const network = JSON.parse(
    runDocker(["network", "inspect", `${projectName}_coffee_provider_egress`]),
  )[0];
  const internalNetworks = ["coffee_internal_api", "coffee_postgres_data"].map(
    (name) =>
      JSON.parse(
        runDocker(["network", "inspect", `${projectName}_${name}`]),
      )[0],
  );
  const fixtureImageId = runDocker([
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    CUSTOMER_TEST_IMAGE,
  ]).trim();
  const fixtureDirectory = join(secretsDir, "aroma-cart-proof");
  const mounted = parseFinalJsonLine(
    runCompose(
      projectName,
      secretsDir,
      ["exec", "-T", "aroma-convergence", "node", "--input-type=module"],
      {
        composeFile,
        timeout: 10_000,
        input: rollbackRuntimeConfigProofSource(),
      },
    ),
    "OBSERVABILITY_RUNTIME_CONFIG_READ_FAILED",
  );
  return validateObservabilityProviderBoundary({
    projectName,
    expectedConfigSha256,
    mounted,
    gateway,
    fixture,
    network,
    internalNetworks,
    fixtureImageId,
    fixtureDirectory,
  });
}

async function runRollbackOwnerHttp(
  projectName,
  secretsDir,
  composeFile,
  orderRef,
  action,
) {
  const output = runCompose(
    projectName,
    secretsDir,
    ["exec", "-T", "api-public", "node", "--input-type=module"],
    {
      composeFile,
      timeout: 20_000,
      input: rollbackOwnerHttpSource(orderRef, action),
    },
  );
  return parseFinalJsonLine(
    output,
    `_OWNER_HTTP_${action.toUpperCase()}_FAILED`,
  );
}

async function runMutationDisableRollbackProof({
  projectName,
  secretsDir,
  composeFile,
  recoveryDatabaseProof,
  recoveryProofCredentials,
  platformConfig,
  providerFixture,
  rollbackOrder,
  baseline,
  lineage,
  disabledRoot,
  restoredRoot,
  launchContextPath,
  launchIdentity,
  markStage,
  markInitialUnknownSubstage,
  markDisabledReconcileSubstage,
  kafkaImage,
  runtimeImages,
}) {
  assert.ok(
    rollbackOrder &&
      baseline &&
      providerFixture &&
      recoveryDatabaseProof &&
      recoveryProofCredentials,
    "rollback fixtures are missing",
  );
  const verifyConvergenceImage = (override) => {
    if (!runtimeImages) return;
    const row = serviceRows(projectName, secretsDir, override).find(
      ({ Service }) => Service === "aroma-convergence",
    );
    const expected = runtimeImages.find(
      ({ service }) => service === "aroma-convergence",
    ).imageId;
    assert.ok(row?.ID, "rollback convergence container is missing");
    assert.equal(
      runDocker(["inspect", "--format", "{{.Image}}", row.ID]).trim(),
      expected,
      "rollback convergence image changed after restart",
    );
  };
  const port = recoveryDatabaseProof.port;
  const projectionConsumers = platformConfig.services[
    "orders-aroma-preparation"
  ].kafka.consumers.filter(
    (consumer) =>
      consumer.processing === "durable" &&
      consumer.topics.includes("coffee.aroma.cart.events.v1"),
  );
  assert.equal(
    projectionConsumers.length,
    1,
    "rollback convergence event must have one durable Orders projection consumer",
  );
  const projectionConsumerGroupId = projectionConsumers[0].groupId;
  let initialUnknownActive = false;
  const markInitialUnknownPhase = (substage) => {
    initialUnknownActive = substage !== null;
    markInitialUnknownSubstage(substage);
  };
  const annotateInitialUnknownFailure = (error, operation) => {
    if (initialUnknownActive && error instanceof Error) {
      try {
        Object.defineProperty(error, "rollbackInitialUnknownDiagnostic", {
          configurable: true,
          value: createRollbackInitialUnknownDiagnostic(operation, error),
        });
      } catch {
        /* preserve the original error if a runtime error is not extensible */
      }
    }
    throw error;
  };
  const facts = async (forceGuardedCard = false) => {
    let current;
    try {
      current = await readRollbackFacts({
        port,
        credentials: recoveryProofCredentials,
        platformConfig,
        orderRef: rollbackOrder.orderRef,
        offerRef: rollbackOrder.offerRef,
      });
    } catch (error) {
      annotateInitialUnknownFailure(error, "owner-db-facts");
    }
    if (
      forceGuardedCard ||
      rollbackFactsRequireGuardedCard(current, projectionConsumerGroupId)
    ) {
      let card;
      try {
        card = await runRollbackOwnerHttp(
          projectName,
          secretsDir,
          composeFile,
          rollbackOrder.orderRef,
          "read",
        );
      } catch (error) {
        annotateInitialUnknownFailure(error, "guarded-card-http");
      }
      current.guardedCardState = ROLLBACK_CARD_STATES.has(card.state)
        ? card.state
        : "Other";
    }
    return current;
  };
  assertRollbackFixtureBaseline(baseline);
  throwIfRollbackTerminationRequested();
  markStage("initial-unknown");
  markInitialUnknownPhase("health");
  const initialRows = assertHealthy(projectName, secretsDir, composeFile);
  markInitialUnknownPhase("arm-marker");
  await writeFile(providerFixture.faultArmFile, "", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  markInitialUnknownPhase("drift-card");
  const drifted = await waitForRollbackFacts(
    () => facts(true),
    (current) => current.guardedCardState === "OutOfSync",
    "INITIAL_B_DRIFT",
    remainingGateWaitMs(),
  );
  assert.equal(
    drifted.guardedCardState,
    "OutOfSync",
    "rollback armed provider drift did not reach the guarded Orders Card",
  );
  markInitialUnknownPhase("owner-reconcile");
  const initialReconcile = await runRollbackOwnerHttp(
    projectName,
    secretsDir,
    composeFile,
    rollbackOrder.orderRef,
    "reconcile",
  );
  throwIfRollbackTerminationRequested();
  assert.equal(
    initialReconcile.status,
    202,
    "rollback B-phase owner reconciliation command was not accepted",
  );
  assert.equal(
    initialReconcile.cardState,
    "OutOfSync",
    "rollback B-phase reconciliation did not start from actual guarded drift",
  );

  markInitialUnknownPhase("unknown-facts");
  const unknown = await waitForRollbackFacts(
    facts,
    (current) =>
      current.attempts.some((row) => row.state === "UnknownOutcome") &&
      current.reservations.some(
        (row) => row.state === "UnknownOutcome" && !row.resolved,
      ) &&
      current.gatewayRows.some((row) => row.state === "UnknownOutcome") &&
      current.guardedCardState === "UnknownOutcome" &&
      hasProcessedConvergenceProjectionEvent(
        current,
        projectionConsumerGroupId,
      ) &&
      hasProcessedRollbackOperatorWake({
        ordersOutbox: current.ordersOutbox,
        inboxRows: current.inboxRows,
        wakes: current.wakes,
        wakeInbox: current.wakeInbox,
        correlationId: initialReconcile.correlationId,
        desiredRevision: current.desired.find((row) => row.state === "Current")
          ?.desired_revision,
        orderRef: rollbackOrder.orderRef,
        consumerName: "aroma-convergence-v1",
      }),
    "INITIAL_UNKNOWN_OUTCOME",
    remainingGateWaitMs(),
    (current) =>
      writeRollbackInitialUnknownTimeoutDiagnostic({
        launchIdentity,
        facts: current,
        projectionConsumerGroupId,
        correlationId: initialReconcile.correlationId,
        orderRef: rollbackOrder.orderRef,
      }),
  );
  assertRollbackHistoryPreserved(baseline, unknown);
  const confirmedMessage = unknown.ordersOutbox.find(
    (row) => row.message_type === "OrderConfirmed.v1",
  );
  assert.ok(
    confirmedMessage?.state === "Published" &&
      unknown.inboxRows.some(
        (row) =>
          row.message_id === confirmedMessage.message_id &&
          row.message_type === "OrderConfirmed.v1" &&
          row.consumer_name === "orders-aroma-preparation-v1" &&
          row.state === "Processed",
      ),
    "rollback confirmed owner order was not delivered through the real preparation Inbox",
  );
  const unknownAttempt = unknown.attempts.find(
    (row) => row.state === "UnknownOutcome",
  );
  const currentDesired = unknown.desired.find((row) => row.state === "Current");
  assert.ok(
    unknownAttempt &&
      currentDesired &&
      unknownAttempt.desired_revision === currentDesired.desired_revision,
    "rollback unknown attempt does not match the current desired cart revision",
  );
  const operatorIntent = unknown.ordersOutbox.find(
    (row) =>
      row.message_type === "OrderReconciliationRequested.v1" &&
      row.correlation_id === initialReconcile.correlationId,
  );
  const operatorWake = unknown.wakes.find(
    (row) =>
      row.causation_id === operatorIntent?.message_id &&
      row.payload?.desiredRevision === currentDesired.desired_revision &&
      row.payload?.reason === "OperatorRequested",
  );
  assert.ok(
    operatorWake,
    "rollback B-phase reconciliation has no causally linked OperatorRequested wake",
  );
  assert.ok(
    hasProcessedRollbackOperatorWake({
      ordersOutbox: unknown.ordersOutbox,
      inboxRows: unknown.inboxRows,
      wakes: unknown.wakes,
      wakeInbox: unknown.wakeInbox,
      correlationId: initialReconcile.correlationId,
      desiredRevision: currentDesired.desired_revision,
      orderRef: rollbackOrder.orderRef,
      consumerName: "aroma-convergence-v1",
    }),
    "rollback B-phase unknown outcome is not causally linked through the real Orders command, preparation Inbox and convergence Inbox",
  );
  const oldReservation = unknown.reservations.find(
    (row) => row.state === "UnknownOutcome" && !row.resolved,
  );
  const oldGateway = unknown.gatewayRows.find(
    (row) => row.operation_ref === oldReservation?.operation_ref,
  );
  assert.ok(
    oldReservation && oldGateway,
    "rollback unknown reservation and immutable Gateway journal row must correlate",
  );
  assert.equal(oldReservation.action, "SetQuantity");
  assert.equal(oldReservation.offer_ref, rollbackOrder.offerRef);
  assert.equal(oldReservation.observed_before_milli, "2000");
  assert.equal(oldReservation.desired_milli, "1000");
  const firstTrace = await readProviderTrace(providerFixture.traceFile);
  assert.ok(
    firstTrace.some(
      (row) =>
        row.kind === "set-quantity" &&
        row.outcome === "response-lost-before-effect",
    ),
    "rollback provider fixture did not lose the first SetQuantity response before applying it",
  );
  const firstCounts = await readAromaCartProviderCounts(
    providerFixture.countFile,
  );
  assert.equal(
    firstCounts.put,
    1,
    "rollback initial unknown must have exactly one provider write attempt",
  );
  const unknownCard = await runRollbackOwnerHttp(
    projectName,
    secretsDir,
    composeFile,
    rollbackOrder.orderRef,
    "read",
  );
  assert.equal(
    unknownCard.state,
    "UnknownOutcome",
    "rollback owner HTTP did not expose the actual UnknownOutcome projection",
  );

  const initialConvergence = initialRows.get("aroma-convergence");
  assert.ok(
    initialConvergence?.ID,
    "rollback convergence runtime is missing before crash/restart",
  );
  runDocker([
    "stop",
    "--signal",
    "SIGKILL",
    "--timeout",
    "0",
    initialConvergence.ID,
  ]);
  throwIfRollbackTerminationRequested();
  markInitialUnknownPhase(null);
  markStage("disabled-restart");
  const disabledOverride = await writeScopedComposeOverride(
    projectName,
    rollbackRuntimeComposeOptions(
      projectName,
      launchContextPath,
      join(disabledRoot, "config/platform.yaml"),
      kafkaImage,
      runtimeImages
        ? { runtimeImages, configSha256: lineage.D.configSha256 }
        : undefined,
    ),
  );
  const composeFiles = [composeFile, disabledOverride];
  try {
    markStage("disabled-reconcile");
    markDisabledReconcileSubstage("restart");
    const beforeDisabled = new Map(
      serviceRows(projectName, secretsDir, disabledOverride).map((row) => [
        row.Service,
        row,
      ]),
    );
    runCompose(
      projectName,
      secretsDir,
      [
        "up",
        "--detach",
        "--no-build",
        "--no-deps",
        "--force-recreate",
        "aroma-convergence",
      ],
      {
        composeFile: disabledOverride,
        inherit: true,
        timeout: remainingGateWaitMs(),
      },
    );
    throwIfRollbackTerminationRequested();
    markDisabledReconcileSubstage("config-attestation");
    verifyConvergenceImage(disabledOverride);
    const disabledRuntimeConfig = await readContainerConfigProof(
      projectName,
      secretsDir,
      disabledOverride,
      disabledRoot,
      lineage,
      "disabled",
    );
    assert.equal(
      disabledRuntimeConfig.mutationsEnabled,
      false,
      "rollback disabled runtime config must disable mutations",
    );
    markDisabledReconcileSubstage("release");
    await writeFile(providerFixture.recoveryGetReleaseFile, "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    markDisabledReconcileSubstage("convergence-readiness");
    await waitForRuntimeReadiness(
      projectName,
      secretsDir,
      "aroma-convergence",
      200,
      remainingGateWaitMs(),
      disabledOverride,
    );
    throwIfRollbackTerminationRequested();
    markDisabledReconcileSubstage("observer-readiness");
    await waitForRuntimeReadiness(
      projectName,
      secretsDir,
      "aroma-observer",
      200,
      remainingGateWaitMs(),
      disabledOverride,
    );
    throwIfRollbackTerminationRequested();
    markDisabledReconcileSubstage("health");
    const disabledRecoveryRows = serviceRows(
      projectName,
      secretsDir,
      disabledOverride,
    );
    const convergenceContainer = disabledRecoveryRows.find(
      (row) => row.Service === "aroma-convergence",
    )?.ID;
    const observerContainer = disabledRecoveryRows.find(
      (row) => row.Service === "aroma-observer",
    )?.ID;
    assert.ok(
      convergenceContainer,
      "rollback disabled convergence container is absent",
    );
    assert.ok(
      observerContainer,
      "rollback disabled observer container is absent",
    );
    await waitForDockerHealthy(convergenceContainer);
    throwIfRollbackTerminationRequested();
    await waitForDockerHealthy(observerContainer);
    throwIfRollbackTerminationRequested();
    const afterDisabledRows = assertHealthy(
      projectName,
      secretsDir,
      disabledOverride,
    );
    assertOnlyRuntimeRecreated(
      serviceIdentity(beforeDisabled),
      serviceIdentity(afterDisabledRows),
      "aroma-convergence",
    );
    markDisabledReconcileSubstage("facts");
    const afterDisabled = await waitForRollbackFacts(
      facts,
      (current) =>
        current.reservations.some(
          (row) =>
            row.operation_ref === oldReservation.operation_ref &&
            row.state === "RecoveredNotApplied" &&
            row.resolved,
        ) &&
        current.gatewayRows.some(
          (row) =>
            row.operation_ref === oldReservation.operation_ref &&
            row.state === "UnknownOutcome",
        ) &&
        current.attempts.some(
          (row) =>
            row.state === "Blocked" &&
            row.failure_code === "AROMA_MUTATIONS_DISABLED",
        ) &&
        current.work?.dirty === false &&
        (current.lease?.active ?? false) === false,
      "DISABLED_RECONCILIATION",
    );
    assertRollbackHistoryPreserved(unknown, afterDisabled);
    assertOldRollbackOperationPreserved(
      afterDisabled,
      oldReservation,
      oldGateway,
      "RecoveredNotApplied",
    );
    const disabledCounts = await readAromaCartProviderCounts(
      providerFixture.countFile,
    );
    assert.equal(
      disabledCounts.put,
      firstCounts.put,
      "rollback disabled mode issued a provider mutation",
    );
    assert.equal(
      disabledCounts.post,
      firstCounts.post,
      "rollback disabled mode issued a provider add",
    );
    assert.equal(
      disabledCounts.delete,
      firstCounts.delete,
      "rollback disabled mode issued a provider removal",
    );
    assert.ok(
      disabledCounts.cart > firstCounts.cart,
      "rollback disabled mode did not prove a fresh provider GET",
    );
    assert.ok(
      afterDisabled.convergenceOutbox.length >
        unknown.convergenceOutbox.length &&
        hasProcessedConvergenceProjectionEvent(
          afterDisabled,
          projectionConsumerGroupId,
        ),
      "rollback convergence result did not traverse Kafka and the configured Orders projection Inbox",
    );
    assert.equal(
      afterDisabled.orderProjection?.state,
      "Blocked",
      "rollback disabled state did not reach the Orders Card projection",
    );
    const disabledCard = await runRollbackOwnerHttp(
      projectName,
      secretsDir,
      disabledOverride,
      rollbackOrder.orderRef,
      "read",
    );
    throwIfRollbackTerminationRequested();
    assert.equal(disabledCard.state, "Blocked");
    assert.ok(disabledCard.blockerCodes.includes("AROMA_MUTATIONS_DISABLED"));
    markDisabledReconcileSubstage(null);

    markStage("disabled-owner-reconcile");
    const reconcile = await runRollbackOwnerHttp(
      projectName,
      secretsDir,
      disabledOverride,
      rollbackOrder.orderRef,
      "reconcile",
    );
    throwIfRollbackTerminationRequested();
    assert.equal(
      reconcile.status,
      202,
      "rollback owner reconciliation command was not accepted",
    );
    const accepted = await waitForRollbackFacts(
      facts,
      (current) =>
        current.ordersOutbox.some((row) => {
          if (row.correlation_id !== reconcile.correlationId) return false;
          if (row.message_type !== "OrderReconciliationRequested.v1")
            return false;
          const prepared = current.inboxRows.some(
            (delivery) =>
              delivery.message_id === row.message_id &&
              delivery.consumer_name === "orders-aroma-preparation-v1" &&
              delivery.state === "Processed",
          );
          const wake = current.wakes.find(
            (message) =>
              message.causation_id === row.message_id &&
              message.state === "Published",
          );
          const converged =
            wake &&
            current.wakeInbox.some(
              (delivery) =>
                delivery.message_id === wake.message_id &&
                delivery.consumer_name === "aroma-convergence-v1" &&
                delivery.state === "Processed",
            );
          return prepared && converged;
        }),
      "OPERATOR_RECONCILIATION_DELIVERY",
    );
    assert.ok(
      accepted.orderProjection?.state === "Blocked" ||
        accepted.orderProjection?.state === "UnknownOutcome",
      "rollback reconciliation changed the disabled projection to an unrelated state",
    );
    assertRollbackHistoryPreserved(afterDisabled, accepted);
    const settledDisabled = await waitForRollbackFacts(
      facts,
      (current) =>
        current.work?.dirty === false &&
        (current.lease?.active ?? false) === false &&
        current.attempts.some(
          (row) => row.failure_code === "AROMA_MUTATIONS_DISABLED",
        ),
      "DISABLED_RECONCILIATION_SETTLED",
    );
    assertRollbackHistoryPreserved(accepted, settledDisabled);

    throwIfRollbackTerminationRequested();
    markStage("restored-restart");
    const restoredOverride = await writeScopedComposeOverride(
      projectName,
      rollbackRuntimeComposeOptions(
        projectName,
        launchContextPath,
        join(restoredRoot, "config/platform.yaml"),
        kafkaImage,
        runtimeImages
          ? { runtimeImages, configSha256: lineage.R.configSha256 }
          : undefined,
      ),
    );
    composeFiles.push(restoredOverride);
    const beforeRestored = new Map(
      serviceRows(projectName, secretsDir, restoredOverride).map((row) => [
        row.Service,
        row,
      ]),
    );
    runCompose(
      projectName,
      secretsDir,
      [
        "up",
        "--detach",
        "--wait",
        "--no-build",
        "--no-deps",
        "--force-recreate",
        "aroma-convergence",
      ],
      {
        composeFile: restoredOverride,
        inherit: true,
        timeout: remainingGateWaitMs(),
      },
    );
    throwIfRollbackTerminationRequested();
    verifyConvergenceImage(restoredOverride);
    await waitForRuntimeReadiness(
      projectName,
      secretsDir,
      "aroma-convergence",
      200,
      remainingGateWaitMs(),
      restoredOverride,
    );
    throwIfRollbackTerminationRequested();
    const restoredRuntimeConfig = await readContainerConfigProof(
      projectName,
      secretsDir,
      restoredOverride,
      restoredRoot,
      lineage,
      "base",
    );
    assert.equal(
      restoredRuntimeConfig.mutationsEnabled,
      true,
      "rollback restored runtime config must re-enable mutations",
    );
    const afterRestoredRows = assertHealthy(
      projectName,
      secretsDir,
      restoredOverride,
    );
    assertOnlyRuntimeRecreated(
      serviceIdentity(beforeRestored),
      serviceIdentity(afterRestoredRows),
      "aroma-convergence",
    );
    markStage("restored-reconcile");
    const restoredReconcile = await runRollbackOwnerHttp(
      projectName,
      secretsDir,
      restoredOverride,
      rollbackOrder.orderRef,
      "reconcile",
    );
    assert.equal(
      restoredReconcile.status,
      202,
      "rollback restored owner reconciliation command was not accepted",
    );
    const restored = await waitForRollbackFacts(
      facts,
      (current) =>
        current.attempts.some((row) => row.state === "VerifiedInSync") &&
        current.gatewayRows.some(
          (row) =>
            row.operation_ref !== oldReservation.operation_ref &&
            row.state === "Acknowledged",
        ) &&
        current.ordersOutbox.some(
          (row) =>
            row.message_type === "OrderReconciliationRequested.v1" &&
            row.correlation_id === restoredReconcile.correlationId &&
            current.inboxRows.some(
              (delivery) =>
                delivery.message_id === row.message_id &&
                delivery.state === "Processed",
            ) &&
            current.wakes.some(
              (wake) =>
                wake.causation_id === row.message_id &&
                wake.state === "Published" &&
                current.wakeInbox.some(
                  (delivery) =>
                    delivery.message_id === wake.message_id &&
                    delivery.state === "Processed",
                ),
            ),
        ),
      "RESTORED_IN_SYNC",
    );
    assertRollbackHistoryPreserved(settledDisabled, restored);
    const newGateway = restored.gatewayRows.find(
      (row) =>
        row.operation_ref !== oldReservation.operation_ref &&
        row.state === "Acknowledged",
    );
    const newReservation = restored.reservations.find(
      (row) => row.operation_ref === newGateway?.operation_ref,
    );
    assert.ok(
      newGateway && newReservation,
      "rollback restored ACK is not correlated with its Orders reservation",
    );
    assert.equal(newGateway.operation_kind, "SetLineQuantity");
    assert.deepEqual(
      {
        state: newReservation.state,
        resolved: newReservation.resolved,
        action: newReservation.action,
        offer_ref: newReservation.offer_ref,
        observed_before_milli: newReservation.observed_before_milli,
        desired_milli: newReservation.desired_milli,
      },
      {
        state: "Verified",
        resolved: true,
        action: "SetQuantity",
        offer_ref: rollbackOrder.offerRef,
        observed_before_milli: "2000",
        desired_milli: "1000",
      },
      "rollback fresh acknowledged operation lacks a verified matching Orders reservation",
    );
    const restoredCounts = await readAromaCartProviderCounts(
      providerFixture.countFile,
    );
    assert.equal(
      restoredCounts.put,
      firstCounts.put + 1,
      "rollback restore did not issue exactly one fresh SetQuantity",
    );
    assert.equal(
      restoredCounts.post,
      firstCounts.post,
      "rollback restore unexpectedly added a cart line",
    );
    assert.equal(
      restoredCounts.delete,
      firstCounts.delete,
      "rollback restore unexpectedly removed a cart line",
    );
    assert.ok(
      restoredCounts.cart > disabledCounts.cart,
      "rollback restored runtime did not use a fresh GET",
    );
    const finalPhysical = JSON.parse(
      await readFile(providerFixture.physicalFile, "utf8"),
    );
    assert.deepEqual(
      finalPhysical,
      { lineCount: 1, quantities: [1] },
      "rollback fake provider did not finish at the desired physical quantity",
    );
    // Orders projects the terminal convergence event in a separate Inbox transaction.
    const finalCard = await waitForRollbackFacts(
      () =>
        runRollbackOwnerHttp(
          projectName,
          secretsDir,
          restoredOverride,
          rollbackOrder.orderRef,
          "read",
        ),
      (card) => card.state === "InSync",
      "RESTORED_CARD_IN_SYNC",
      remainingGateWaitMs(),
      async (lastCard) => {
        const guardedCardFacts = await readRollbackGuardedCardFacts({
          port,
          credentials: recoveryProofCredentials,
          platformConfig,
          orderRef: rollbackOrder.orderRef,
        });
        await writeRollbackRestoredCardTimeoutDiagnostic({
          launchIdentity,
          ownerCardState: lastCard?.state,
          guardedCardFacts,
        });
      },
    );
    assert.equal(
      finalCard.state,
      "InSync",
      "rollback restored physical state did not reach the real Orders Card",
    );
    const { reservation: finalOldReservation, gateway: finalOldGateway } =
      assertOldRollbackOperationPreserved(
        restored,
        oldReservation,
        oldGateway,
        "RecoveredNotApplied",
      );
    assert.equal(
      restored.work?.dirty,
      false,
      "rollback did not finish the current desired revision",
    );
    assert.equal(
      restored.lease?.active ?? false,
      false,
      "rollback left an active convergence lease",
    );
    const trace = await readProviderTrace(providerFixture.traceFile);
    assert.ok(
      hasCompleteSafeGetBetweenLostAndApplied(trace),
      "rollback mutation after recovery was not preceded by a fresh provider GET",
    );
    return {
      schemaVersion: 1,
      candidateSha: lineage.B.commitSha,
      lineage,
      ownerHttp: {
        initialDriftState: drifted.guardedCardState,
        initialReconciliationStatus: initialReconcile.status,
        unknown: unknownCard.state,
        disabled: disabledCard.state,
        reconciliationStatus: reconcile.status,
        restoredReconciliationStatus: restoredReconcile.status,
        restored: finalCard.state,
      },
      provider: {
        kind: "local-fake",
        liveProviderAcceptance: false,
        initial: firstCounts,
        disabled: disabledCounts,
        restored: restoredCounts,
        finalPhysical,
        trace: trace.map((row) => ({
          sequence: row.sequence,
          kind: row.kind,
          outcome: row.outcome,
        })),
      },
      orders: {
        before: baseline.counts,
        unknown: unknown.counts,
        disabled: afterDisabled.counts,
        restored: restored.counts,
        historyBeforeDigest: rollbackHistoryDigest(baseline),
        historyAfterDigest: rollbackHistoryDigest(restored),
        operatorWake: {
          reason: operatorWake.payload.reason,
          causation: "reconciliation-message",
          correlationBound: true,
          preparationInboxProcessed: true,
          convergenceInboxProcessed: true,
        },
        oldOperationDigest: rollbackSafeDigest(oldReservation.operation_ref),
        oldReservationState: finalOldReservation.state,
        oldGatewayState: finalOldGateway.state,
        newOperationDigest: rollbackSafeDigest(newGateway.operation_ref),
        newReservationState: newReservation.state,
        attempts: restored.attempts.map((row) => ({
          state: row.state,
          failureCode: row.failure_code,
        })),
        inbox: {
          orderEventsProcessed: restored.inboxRows.filter(
            (row) => row.state === "Processed",
          ).length,
          convergenceEventsProcessed: restored.projectionInbox.filter(
            (row) => row.state === "Processed",
          ).length,
        },
      },
      runtime: {
        disabledConfig: disabledRuntimeConfig,
        restoredConfig: restoredRuntimeConfig,
        restart: "SIGKILL-after-durable-UnknownOutcome",
        recreatedOnly: "aroma-convergence",
        readiness: 200,
      },
    };
  } finally {
    for (const path of composeFiles.slice(1)) await rm(path, { force: true });
  }
}

async function assertDatabaseProof(
  projectName,
  secretsDir,
  container,
  composeFile = COMPOSE_FILE,
) {
  assert.equal(
    runtimeReadinessStatus(
      projectName,
      secretsDir,
      DATABASE_PROOF_RUNTIME,
      composeFile,
    ),
    200,
    "customer-service database readiness did not start healthy",
  );
  for (const path of ["/health/live", "/metrics"]) {
    assert.equal(
      runtimeHealthStatus(
        projectName,
        secretsDir,
        DATABASE_PROOF_RUNTIME,
        path,
        composeFile,
      ),
      200,
      `customer-service ${path} did not start healthy`,
    );
  }
  runDocker(["stop", container]);
  await waitForRuntimeReadiness(
    projectName,
    secretsDir,
    DATABASE_PROOF_RUNTIME,
    503,
    remainingGateWaitMs(),
    composeFile,
  );
  runDocker(["start", container]);
  await waitForDockerHealthy(container);
  await waitForRuntimeReadiness(
    projectName,
    secretsDir,
    DATABASE_PROOF_RUNTIME,
    200,
    remainingGateWaitMs(),
    composeFile,
  );
  for (const path of ["/health/live", "/metrics"]) {
    assert.equal(
      runtimeHealthStatus(
        projectName,
        secretsDir,
        DATABASE_PROOF_RUNTIME,
        path,
        composeFile,
      ),
      200,
      `customer-service ${path} did not recover`,
    );
  }
}

function assertHostExposure(
  projectName,
  secretsDir,
  rows,
  composeFile = COMPOSE_FILE,
) {
  const nginxContainer = JSON.parse(
    runDocker(["inspect", rows.get("edge-nginx").ID]),
  )[0];
  const edgeContainer = JSON.parse(
    runDocker(["inspect", rows.get("edge-gateway").ID]),
  )[0];
  const effectiveCompose = JSON.parse(
    runCompose(projectName, secretsDir, ["config", "--format", "json"], {
      composeFile,
    }),
  );
  const hostNetwork = JSON.parse(
    runDocker([
      "network",
      "inspect",
      effectiveCompose.networks.coffee_host_ingress.name,
    ]),
  )[0];
  assert.deepEqual(
    Object.keys(hostNetwork.Containers ?? {}),
    [nginxContainer.Id],
    "coffee_host_ingress must contain only edge-nginx",
  );
  const edgeNetwork = JSON.parse(
    runDocker([
      "network",
      "inspect",
      effectiveCompose.networks.coffee_edge_backend.name,
    ]),
  )[0];
  assert.ok(
    Object.hasOwn(edgeNetwork.Containers ?? {}, nginxContainer.Id),
    "edge-nginx must join coffee_edge_backend",
  );
  assert.ok(
    Object.hasOwn(edgeNetwork.Containers ?? {}, edgeContainer.Id),
    "edge-gateway must join coffee_edge_backend",
  );
  assert.equal(
    runCompose(projectName, secretsDir, ["port", "edge-nginx", "8443"], {
      composeFile,
    }).trim(),
    "127.0.0.1:8443",
    "edge-nginx must expose only the loopback HTTPS binding",
  );
  const nginxBindings =
    nginxContainer.HostConfig.PortBindings?.["8443/tcp"] ?? [];
  assert.deepEqual(
    nginxBindings.map((binding) => ({
      hostIp: binding.HostIp,
      hostPort: binding.HostPort,
    })),
    [{ hostIp: "127.0.0.1", hostPort: "8443" }],
  );
  for (const runtime of RUNTIMES) {
    const container = JSON.parse(
      runDocker(["inspect", rows.get(runtime).ID]),
    )[0];
    const bindings = Object.values(
      container.HostConfig.PortBindings ?? {},
    ).flat();
    assert.deepEqual(
      bindings,
      [],
      `${runtime} unexpectedly publishes a host port`,
    );
  }
}

function assertStopped(projectName, secretsDir, composeFile = COMPOSE_FILE) {
  for (const row of serviceRows(projectName, secretsDir, composeFile)) {
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    assert.equal(
      container.State.Running,
      false,
      `${row.Service} did not stop after SIGTERM`,
    );
    const expectedExitCodes = row.Service === "kafka" ? [0, 143] : [0];
    assert.ok(
      expectedExitCodes.includes(container.State.ExitCode),
      `${row.Service} exited with ${container.State.ExitCode}`,
    );
  }
}

async function prepareAromaCartProviderFixture(
  secretsDir,
  initialCartFixture = "add-one-get.json",
  options = {},
) {
  const directory = join(secretsDir, "aroma-cart-proof");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, "provider-ca.key");
  const caCert = join(directory, "provider-ca.crt");
  const key = join(directory, "provider.key");
  const csr = join(directory, "provider.csr");
  const cert = join(directory, "provider.crt");
  const ext = join(directory, "provider.ext");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caCert,
      "-days",
      "1",
      "-subj",
      "/CN=aroma-provider-fixture",
    ],
    { stdio: "ignore" },
  );
  await writeFile(
    ext,
    "subjectAltName=DNS:aromateacoffee.ru\nextendedKeyUsage=serverAuth\n",
    { encoding: "utf8", mode: 0o400 },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=aromateacoffee.ru",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      caCert,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      ext,
    ],
    { stdio: "ignore" },
  );
  const initialCart = JSON.parse(
    await readFile(
      join(
        ROOT,
        "evidence/aroma-provider/2026-09-12-cart-mutations",
        initialCartFixture,
      ),
      "utf8",
    ),
  );
  if (options.rollbackMode) {
    assert.ok(
      initialCart.products?.[0],
      "rollback fixture must start with one provider cart line",
    );
    initialCart.products[0].quantity = 1;
    initialCart.products[0].packing = "Aroma";
    initialCart.products[0].grind_id = "1";
  }
  await writeFile(
    join(directory, "add-one-get.json"),
    `${JSON.stringify(initialCart)}\n`,
    { encoding: "utf8", mode: 0o400 },
  );
  const scopedGateway = parseYaml(
    await readFile(join(secretsDir, "aroma-gateway.yaml"), "utf8"),
    { json: true },
  );
  const supplierRef = "sup_00000000000000000000000001";
  const catalogIdentityKey = Buffer.from(
    scopedGateway.secrets.aroma.catalogIdentityKeyV1,
    "utf8",
  );
  const grinds = Array.from({ length: 12 }, (_, index) => ({
    id: String(index + 1),
    name: `Fixture grind ${index + 1}`,
  }));
  await writeFile(
    join(directory, "catalog-grinds.json"),
    JSON.stringify(grinds) + "\n",
    { encoding: "utf8", mode: 0o400 },
  );
  await writeFile(
    join(directory, "selected-grind.json"),
    JSON.stringify({
      rawId: "1",
      sourceGrindKeyHash: createSourceIdentity({
        supplierRef,
        entityType: "grind",
        rawProviderIdentifier: "1",
        sourceIdentityKey: catalogIdentityKey,
      }).sourceIdentityHash,
    }) + "\n",
    { encoding: "utf8", mode: 0o400 },
  );
  await writeFile(
    join(directory, "provider-count.json"),
    JSON.stringify({
      login: 0,
      catalog: 0,
      cart: 0,
      post: 0,
      put: 0,
      delete: 0,
    }) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(join(directory, "provider-trace.json"), "[]\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(join(directory, "provider-physical.json"), "{}\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(directory, "provider-server.mjs"),
    `import {createServer} from "node:https";
import {readFile, writeFile} from "node:fs/promises";
const key = await readFile("/run/aroma-proof/provider.key");
const cert = await readFile("/run/aroma-proof/provider.crt");
let cart = JSON.parse(await readFile("/run/aroma-proof/add-one-get.json", "utf8"));
const grinds = JSON.parse(await readFile("/run/aroma-proof/catalog-grinds.json", "utf8"));
if (cart.products[0] !== undefined) cart.products[0].grind_id = "1";
let counts = {login: 0, catalog: 0, cart: 0, post: 0, put: 0, delete: 0};
let firstQuantityWriteDropped = false;
let faultDriftApplied = false;
const persist = () => writeFile("/run/aroma-proof/provider-count.json", JSON.stringify(counts) + String.fromCharCode(10));
const shouldLoseFirstRollbackSetQuantityResponse = ${shouldLoseFirstRollbackSetQuantityResponse.toString()};
const applyRollbackArmedCartDrift = ${applyRollbackArmedCartDrift.toString()};
const rollbackRecoveryGetResponse = ${rollbackRecoveryGetResponse.toString()};
const rollbackMode = ${options.rollbackMode === true};
let trace = [];
const record = async (kind, outcome) => { trace.push({sequence: trace.length + 1, kind, outcome}); await writeFile("/run/aroma-proof/provider-trace.json", JSON.stringify(trace) + String.fromCharCode(10)); };
const json = (response, status, body, headers = {}) => { response.writeHead(status, {"content-type": "application/json", ...headers}); response.end(body); };
const currentLine = (cartLineId) => cart.products.find((product) => String(product.id) === String(cartLineId));
const cartBytes = () => JSON.stringify(cart);
const addLine = (offerId, quantity, packing, grindId) => {
  const template = cart.products[0] ?? {id: 300001, offer: {id: Number(offerId), name: "Fixture coffee", vendor_code: "C-200-26", price: 852.6, params: []}, product_name: "Fixture coffee", preview: {path: "https://fixture.invalid/image", title: null, description: null}, offer_name: "Fixture coffee", grind_id: null, packing: packing ?? "Aroma", quantity: 1, price: 620, discount_value: 0, total_with_discount: 620, product_type: "coffee", product_slug: "fixture-coffee", category_composite_slug: "kofe/monosorta", show_on_wholesale: true, product_on_stop: false, sold_by_piece: false, disable_volume_discount: false, disable_personal_discount: false};
  cart.products = [{...template, id: 300001, offer: {...template.offer, id: Number(offerId)}, quantity: Number(quantity), packing: packing ?? "Aroma", grind_id: grindId ?? "1"}];
};
const server = createServer({key, cert}, async (request, response) => {
  if (request.method === "POST" && request.url === "/api/v1/auth/login") {
    counts.login += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const email = JSON.parse(input).email;
    json(response, 200, JSON.stringify({data: {email, wholesale: true, retail: false}}), {"set-cookie": "aroma_session=fixture-cookie; Path=/; HttpOnly; Secure"}); return;
  }
  if (request.method === "GET" && request.url === "/api/v1/cart/") {
    counts.cart += 1; await persist();
    let faultArmed = false;
    try { await readFile("/run/aroma-proof/fault-arm"); faultArmed = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    faultDriftApplied = applyRollbackArmedCartDrift({rollbackMode, faultArmed, driftApplied: faultDriftApplied, cart});
    const recoveryResponse = await rollbackRecoveryGetResponse({rollbackMode, firstQuantityWriteDropped,
      releaseFile: "/run/aroma-proof/recovery-get-release", cartBody: cartBytes()});
    if (recoveryResponse.gated) {
      await record("safe-get", "recovery-gated-incomplete-body");
      json(response, recoveryResponse.statusCode, recoveryResponse.body); return;
    }
    await writeFile("/run/aroma-proof/provider-physical.json", JSON.stringify({lineCount: cart.products.length,
      quantities: cart.products.map((product) => product.quantity)}) + String.fromCharCode(10));
    await record("safe-get", "complete"); json(response, recoveryResponse.statusCode, recoveryResponse.body); return;
  }
  if (request.method === "GET" && request.url === "/api/v1/catalog/grinds") {
    json(response, 200, JSON.stringify({data: grinds})); return;
  }
  if (request.method === "GET" && request.url?.startsWith("/api/v1/catalog/wholesale/products?")) {
    counts.catalog += 1; await persist();
    const url = new URL(request.url, "https://aromateacoffee.ru");
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1) {
      json(response, 400, JSON.stringify({error: "invalid pagination"})); return;
    }
    json(response, 200, JSON.stringify({data: [], meta: {current_page: page, total: 0, last_page: 1, per_page: perPage}})); return;
  }
  if (request.url === "/api/v1/cart/" && request.method === "POST") {
    counts.post += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const form = new URLSearchParams(input);
    addLine(form.get("offer_id"), form.get("quantity"), form.get("packing"), form.get("grind_id"));
    if (form.get("quantity") === "3") { json(response, 200, JSON.stringify({malformed: true})); return; }
    json(response, 200, cartBytes()); return;
  }
  if (request.url?.startsWith("/api/v1/cart/") && request.method === "PUT") {
    const cartLineId = request.url.slice("/api/v1/cart/".length);
    counts.put += 1; await persist();
    let input = ""; for await (const chunk of request) input += chunk;
    const payload = JSON.parse(input);
    const line = currentLine(cartLineId);
    if (line === undefined) { json(response, 404, JSON.stringify({error: "not found", field: "cartLineId"})); return; }
    ${options.rollbackMode ? `if (shouldLoseFirstRollbackSetQuantityResponse(counts.put, payload)) { firstQuantityWriteDropped = true; await record("set-quantity", "response-lost-before-effect"); response.destroy(); return; }` : ""}
    line.quantity = Number(payload.quantity);
    if (payload.packing !== undefined) line.packing = payload.packing;
    if (payload.grind_id !== undefined) line.grind_id = payload.grind_id;
    await record("set-quantity", "applied");
    if (payload.quantity === 4) { response.destroy(); return; }
    json(response, 200, cartBytes()); return;
  }
  if (request.url?.startsWith("/api/v1/cart/") && request.method === "DELETE") {
    const cartLineId = request.url.slice("/api/v1/cart/".length);
    counts.delete += 1; await persist();
    cart.products = cart.products.filter((product) => String(product.id) !== cartLineId);
    if (cart.products.length === 0) cart = {products: [], prices: {categories: [], weights: [], discounts: [], prices: [], total: {default: 0, promo: 0}}};
    await record("remove", "applied"); json(response, 200, cartBytes()); return;
  }
  json(response, 404, JSON.stringify({error: "not found"}));
});
const shutdown = () => server.close((error) => { if (error) throw error; });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(443, "0.0.0.0");
`,
    { encoding: "utf8", mode: 0o400 },
  );
  return {
    directory,
    caCert: join(directory, "provider-ca.crt"),
    countFile: join(directory, "provider-count.json"),
    traceFile: join(directory, "provider-trace.json"),
    physicalFile: join(directory, "provider-physical.json"),
    faultArmFile: join(directory, "fault-arm"),
    recoveryGetReleaseFile: join(directory, "recovery-get-release"),
  };
}

function aromaCartProofSource(environment, expectedInitialQuantity) {
  const source = String.raw`import {readFile} from "node:fs/promises";
import {request as httpsRequest} from "node:https";
const caller = JSON.parse(await readFile("/run/aroma-proof/caller.json", "utf8"));
const convergence = JSON.parse(await readFile("/run/aroma-proof/convergence.json", "utf8"));
const foreign = JSON.parse(await readFile("/run/aroma-proof/foreign.json", "utf8"));
const selectedGrind = JSON.parse(await readFile("/run/aroma-proof/selected-grind.json", "utf8"));
const expectedSan = "URI:spiffe://coffee-platform/__ENV__/api-internal";
const offerRef = "off_00000000000000000000000001";
const readPath = "/api/internal-v1/aroma/cart-snapshots:read";
const setPath = "/api/internal-v1/aroma/cart-lines/" + offerRef + ":set-quantity";
const removePath = "/api/internal-v1/aroma/cart-lines/" + offerRef + ":remove";
const requestApi = (material, path, body, headers = {}) => new Promise((resolve, reject) => {
  const raw = JSON.stringify(body);
  const options = {host: "api-internal", port: 4051, method: "POST", path, ca: material.caPem, cert: material.certPem, key: material.keyPem, servername: "api-internal", minVersion: "TLSv1.3", rejectUnauthorized: true, headers: {"content-type": "application/json", "content-length": Buffer.byteLength(raw), ...headers}, checkServerIdentity: (_hostname, certificate) => certificate.subjectaltname?.split(",").map((value) => value.trim()).includes(expectedSan) ? undefined : new Error("api-internal SAN mismatch")};
  const request = httpsRequest(options, (response) => { let value = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { value += chunk; if (value.length > 2 * 1024 * 1024) request.destroy(new Error("response exceeded bound")); }); response.once("end", () => { let parsed; try { parsed = JSON.parse(value); } catch { parsed = undefined; } resolve({status: response.statusCode ?? 0, body: parsed, responseBytes: Buffer.from(value), requestBytes: Buffer.from(raw)}); }); });
  request.setTimeout(15000, () => request.destroy(new Error("bounded probe timeout"))); request.once("error", reject); request.end(raw);
});
const readCounts = async () => JSON.parse(await readFile("/run/aroma-proof/provider-count.json", "utf8"));
const readBody = {cartScopeRef: "aroma-primary"};
const unauthorized = await requestApi(foreign, readPath, readBody);
const spoofed = await requestApi(caller, readPath, readBody, {"x-service-delegation": "forged-by-fixture"});
const malformed = await requestApi(caller, readPath, {cartScopeRef: "wrong"});
const safe = await requestApi(caller, readPath, readBody);
if (unauthorized.status !== 401 || spoofed.status !== 403 || malformed.status !== 400 || safe.status !== 200) throw new Error("safe-read authorization matrix failed: " + [unauthorized.status, spoofed.status, malformed.status, safe.status].join("/"));
if (JSON.stringify(safe.body).includes("300000") || JSON.stringify(safe.body).includes("fixture-cookie")) throw new Error("provider material crossed the API boundary");
if (safe.body?.cartScopeRef !== "aroma-primary" || safe.body?.lines?.length !== 1 || safe.body.lines[0].offerRef !== offerRef || safe.body.lines[0].quantity !== "__INITIAL_QUANTITY__" || safe.body.lines[0].sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("sanitized cart snapshot mismatch");
const setBody = {operationRef: "op_00000000000000000000000001", cartScopeRef: "aroma-primary", quantity: "2", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const set = await requestApi(convergence, setPath, setBody);
if (set.status !== 200 || set.body?.state !== "Acknowledged" || set.body?.operationRef !== setBody.operationRef || set.body?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("set mutation was not acknowledged: status=" + set.status + " state=" + String(set.body?.state ?? "none") + " code=" + String(set.body?.code ?? "none"));
const afterSet = await requestApi(caller, readPath, readBody);
if (afterSet.status !== 200 || afterSet.body?.lines?.[0]?.quantity !== "__AFTER_SET_QUANTITY__" || afterSet.body?.lines?.[0]?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("set fresh cart read-back mismatch");
const setCounts = await readCounts();
const setReplay = await requestApi(convergence, setPath, setBody);
if (setReplay.status !== 200 || Buffer.compare(set.responseBytes, setReplay.responseBytes) !== 0) throw new Error("set replay response bytes changed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(setCounts)) throw new Error("set replay dispatched a second unsafe call");
const removeBody = {operationRef: "op_00000000000000000000000002", cartScopeRef: "aroma-primary", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const remove = await requestApi(convergence, removePath, removeBody);
if (remove.status !== 200 || remove.body?.state !== "Acknowledged" || remove.body?.operationRef !== removeBody.operationRef || remove.body?.sourceGrindKeyHash !== selectedGrind.sourceGrindKeyHash) throw new Error("remove mutation was not acknowledged");
const afterRemove = await requestApi(caller, readPath, readBody);
if (afterRemove.status !== 200 || afterRemove.body?.lines?.length !== __AFTER_REMOVE_LINES__) throw new Error("remove fresh cart read-back mismatch");
const removeCounts = await readCounts();
const removeReplay = await requestApi(convergence, removePath, removeBody);
if (removeReplay.status !== 200 || Buffer.compare(remove.responseBytes, removeReplay.responseBytes) !== 0) throw new Error("remove replay response bytes changed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(removeCounts)) throw new Error("remove replay dispatched a second unsafe call");
const malformedBody = {operationRef: "op_00000000000000000000000003", cartScopeRef: "aroma-primary", quantity: "3", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const malformedMutation = await requestApi(convergence, setPath, malformedBody);
if (malformedMutation.status !== 409 || malformedMutation.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("malformed post-dispatch did not become UnknownOutcome");
const malformedCounts = await readCounts();
const malformedReplay = await requestApi(convergence, setPath, malformedBody);
if (malformedReplay.status !== 409 || malformedReplay.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("malformed UnknownOutcome replay failed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(malformedCounts)) throw new Error("malformed UnknownOutcome replay redispatched");
const lostBody = {operationRef: "op_00000000000000000000000004", cartScopeRef: "aroma-primary", quantity: "4", sourceGrindKeyHash: selectedGrind.sourceGrindKeyHash};
const lost = await requestApi(convergence, setPath, lostBody);
if (lost.status !== 409 || lost.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("lost post-dispatch did not become UnknownOutcome");
const lostCounts = await readCounts();
const lostReplay = await requestApi(convergence, setPath, lostBody);
if (lostReplay.status !== 409 || lostReplay.body?.code !== "AROMA_OPERATION_UNKNOWN_OUTCOME") throw new Error("lost UnknownOutcome replay failed");
if (JSON.stringify(await readCounts()) !== JSON.stringify(lostCounts)) throw new Error("lost UnknownOutcome replay redispatched");
const afterLost = await requestApi(caller, readPath, readBody);
if (afterLost.status !== 200 || afterLost.body?.lines?.[0]?.quantity !== "4") throw new Error("lost post-dispatch effect was not visible on fresh read-back");
console.log(JSON.stringify({unauthorizedStatus: unauthorized.status, spoofedDelegationStatus: spoofed.status, malformedStatus: malformed.status, successStatus: safe.status, sanitizedSnapshot: true, providerMaterialRedacted: true, typedSuccess: true, freshCartReadBack: true, exactReplaySameBytes: true, unknownOutcomeAfterMalformed: true, unknownOutcomeAfterLost: true, unknownReplayWithoutRedispatch: true, providerAccess: false, providerKind: "local-fake", liveProviderAcceptance: false, providerCalls: await readCounts()}));
`;
  return source
    .replace("__ENV__", environment)
    .replace("__INITIAL_QUANTITY__", expectedInitialQuantity)
    .replace(
      "__AFTER_SET_QUANTITY__",
      expectedInitialQuantity === "1" ? "2" : "4",
    )
    .replace(
      "__AFTER_REMOVE_LINES__",
      expectedInitialQuantity === "1" ? "0" : "1",
    );
}

async function runAromaCartProofFixture(
  projectName,
  secretsDir,
  composeFile,
  fixture,
  environment,
  expectedInitialQuantity = "1",
) {
  const output = runDocker(
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      `${projectName}_coffee_internal_api`,
      "--volume",
      `${fixture.directory}:/run/aroma-proof:ro`,
      CUSTOMER_TEST_IMAGE,
      "node",
      "--input-type=module",
    ],
    { input: aromaCartProofSource(environment, expectedInitialQuantity) },
  );
  const line = output.trim().split("\\n").filter(Boolean).at(-1);
  assert.ok(line, "aroma cart fixture returned no evidence");
  return JSON.parse(line);
}

async function seedAromaCartReadBinding(
  port,
  credentials,
  platformConfig,
  secretsDir,
) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "aroma-gateway",
  );
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  assert.ok(
    service && credential,
    "aroma gateway database credentials are missing",
  );
  const database = createDatabase(
    proofDatabaseOptions("aroma-gateway", service, port, credential),
  );
  await database.resource.start(AbortSignal.timeout(10_000));
  const store = new OfferBindingStore(database);
  const supplierRef = "sup_00000000000000000000000001";
  const snapshotRef = "snp_00000000000000000000000002";
  const offerRef = "off_00000000000000000000000001";
  const scopedGateway = parseYaml(
    await readFile(join(secretsDir, "aroma-gateway.yaml"), "utf8"),
    { json: true },
  );
  const catalogIdentityKey = Buffer.from(
    scopedGateway.secrets.aroma.catalogIdentityKeyV1,
    "utf8",
  );
  const sourceGrindKeyHash = createSourceIdentity({
    supplierRef,
    entityType: "grind",
    rawProviderIdentifier: "1",
    sourceIdentityKey: catalogIdentityKey,
  }).sourceIdentityHash;
  try {
    await store.beginExport(snapshotRef, supplierRef);
    await store.recordBatch(snapshotRef, supplierRef, [
      {
        supplierRef,
        sourceIdentityScheme: "hmac-sha256-v1",
        sourceOfferKeyHash: "d".repeat(64),
        rawProviderOfferId: "300000",
        rawProviderProductId: "300001",
        rawProviderVariantId: "300000",
        packing: "Aroma",
        grindId: "1",
      },
    ]);
    await store.completeExport(snapshotRef, "e".repeat(64));
    await store.register({
      offerRef,
      supplierRef,
      snapshotRef,
      sourceIdentityScheme: "hmac-sha256-v1",
      sourceOfferKeyHash: "d".repeat(64),
    });
  } catch (error) {
    await database.resource.stop(AbortSignal.timeout(10_000));
    throw error;
  }
  return { database, supplierRef, snapshotRef, offerRef, sourceGrindKeyHash };
}

async function assertAromaCartTopology(projectName, secretsDir, composeFile) {
  const rows = serviceRows(projectName, secretsDir, composeFile);
  assert.equal(
    rows.length,
    3,
    "aroma cart proof must start exactly three services",
  );
  const byService = new Map(rows.map((row) => [row.Service, row]));
  for (const runtime of [
    "api-internal",
    "aroma-gateway",
    "aroma-provider-fixture",
  ]) {
    const row = byService.get(runtime);
    assert.ok(row, `${runtime} is absent from aroma cart proof`);
    assert.equal(row.State, "running", `${runtime} is not running`);
    assert.equal(row.Health, "healthy", `${runtime} is not healthy`);
    const container = JSON.parse(runDocker(["inspect", row.ID]))[0];
    const networks = Object.keys(
      container.NetworkSettings.Networks ?? {},
    ).sort();
    const expected =
      runtime === "api-internal"
        ? [`${projectName}_coffee_internal_api`]
        : runtime === "aroma-gateway"
          ? [
              `${projectName}_coffee_internal_api`,
              `${projectName}_coffee_postgres_data`,
              `${projectName}_coffee_provider_egress`,
            ].sort()
          : [`${projectName}_coffee_provider_egress`];
    assert.deepEqual(
      networks,
      expected,
      `${runtime} connected to an unexpected network`,
    );
  }
  return byService;
}

async function readAromaCartProviderCounts(countFile) {
  const counts = JSON.parse(await readFile(countFile, "utf8"));
  assert.deepEqual(Object.keys(counts).sort(), [
    "cart",
    "catalog",
    "delete",
    "login",
    "post",
    "put",
  ]);
  return counts;
}

async function readAromaMutationJournal(
  port,
  credentials,
  platformConfig,
  operationRefs,
) {
  const service = databaseProofService(
    platformConfig,
    credentials.ownership,
    "aroma-gateway",
  );
  const credential = credentials.databaseCredentialsByRuntime["aroma-gateway"];
  const database = service.database;
  assert.ok(
    service && credential,
    "aroma gateway journal credentials are missing",
  );
  const client = new Client({
    host: "127.0.0.1",
    port,
    database,
    user: credential.username,
    password: credential.password,
    ssl: false,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT operation_ref, operation_kind, offer_ref, source_grind_key_hash, state, response_status, octet_length(response_body_bytes) AS response_bytes, outcome_hash, failure_code, caller_identity, original_caller, dispatched_at IS NOT NULL AS dispatched
       FROM integration.provider_mutation_journal
       WHERE operation_ref = ANY($1::varchar[])
       ORDER BY operation_ref`,
      [operationRefs],
    );
    return result.rows.map((row) => ({
      operationRef: row.operation_ref,
      operationKind: row.operation_kind,
      offerRef: row.offer_ref,
      sourceGrindKeyHash: row.source_grind_key_hash,
      state: row.state,
      responseStatus: row.response_status,
      responseBytes: row.response_bytes,
      outcomeHash: row.outcome_hash,
      failureCode: row.failure_code,
      callerIdentity: row.caller_identity,
      originalCaller: row.original_caller,
      dispatched: row.dispatched,
    }));
  } finally {
    await client.end();
  }
}

function assertAromaMutationJournal(rows, sourceGrindKeyHash) {
  assert.equal(
    rows.length,
    4,
    "cart mutation proof must persist exactly four journal rows",
  );
  const byRef = new Map(rows.map((row) => [row.operationRef, row]));
  const acknowledged = [
    "op_00000000000000000000000001",
    "op_00000000000000000000000002",
  ];
  for (const operationRef of acknowledged) {
    const row = byRef.get(operationRef);
    assert.ok(row, `missing acknowledged journal row ${operationRef}`);
    assert.equal(row.state, "Acknowledged");
    assert.equal(row.responseStatus, 200);
    assert.equal(row.responseBytes > 0, true);
    assert.match(row.outcomeHash, /^[a-f0-9]{64}$/u);
    assert.equal(row.failureCode, null);
    assert.equal(row.dispatched, true);
    assert.equal(row.callerIdentity, "api-internal");
    assert.equal(row.originalCaller, "aroma-convergence");
    assert.equal(row.sourceGrindKeyHash, sourceGrindKeyHash);
  }
  const unknownFailures = new Map([
    ["op_00000000000000000000000003", "AROMA_PROVIDER_INVALID_RESPONSE"],
    ["op_00000000000000000000000004", "AROMA_PROVIDER_OUTCOME_UNKNOWN"],
  ]);
  for (const [operationRef, failureCode] of unknownFailures) {
    const row = byRef.get(operationRef);
    assert.ok(row, `missing unknown-outcome journal row ${operationRef}`);
    assert.equal(row.state, "UnknownOutcome");
    assert.equal(row.responseStatus, null);
    assert.equal(row.responseBytes, null);
    assert.equal(row.outcomeHash, null);
    assert.equal(row.failureCode, failureCode);
    assert.equal(row.dispatched, true);
    assert.equal(row.callerIdentity, "api-internal");
    assert.equal(row.originalCaller, "aroma-convergence");
    assert.equal(row.sourceGrindKeyHash, sourceGrindKeyHash);
  }
  return rows;
}

export async function runBrowserProof({
  baseCandidateSha,
  observability,
  onProof,
}) {
  return runComposeSmoke({
    args: ["--recovery-proof"],
    observability,
    observabilityBrowser: {
      baseCandidateSha,
      onReady: async (context) => {
        const proof = await proveBrowserFlow(context);
        if (onProof) await onProof(proof);
        return proof;
      },
      onCleanup: async () => {},
    },
  });
}

export async function runComposeSmoke({
  args = process.argv.slice(2),
  observability,
  browser,
  observabilityBrowser,
} = {}) {
  rollbackComposeDiagnostic = undefined;
  const options = parseArguments(args);
  assert.ok(
    !(browser && observabilityBrowser),
    "observability and browser hooks are mutually exclusive",
  );
  const browserHook = browser ?? observabilityBrowser;
  if (options.observabilityFixture) {
    assert.ok(
      observability !== undefined &&
        options.recoveryProof &&
        !options.stubSecrets &&
        !options.noBuild &&
        !options.keep &&
        !options.browserProof &&
        !options.mutationDisableRollback &&
        !options.provisionNetwork,
      "--observability-fixture requires programmatic observability hooks and isolated --recovery-proof",
    );
  }
  const launchContextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  const externalRecovery =
    isExternalRecoveryProof(options) ||
    Boolean(
      launchContextPath &&
      !options.stubSecrets &&
      !options.databaseProof &&
      !options.customerProof &&
      !options.recoveryProof &&
      !options.mutationDisableRollback &&
      !options.aromaBindingProof &&
      !options.aromaCartProof,
    );
  if (observability !== undefined) {
    assert.ok(
      observability && typeof observability === "object",
      "observability hooks must be an object",
    );
    assert.ok(
      options.recoveryProof &&
        !options.stubSecrets &&
        !options.noBuild &&
        !options.keep,
      "observability hooks require --recovery-proof without --stub-secrets, --no-build or --keep",
    );
    assert.equal(
      typeof observability.exporterToken,
      "string",
      "observability exporterToken must be a string",
    );
    assert.ok(
      observability.exporterToken.length > 0,
      "observability exporterToken must not be empty",
    );
    assert.equal(
      typeof observability.onReady,
      "function",
      "observability onReady must be a function",
    );
    assert.equal(
      typeof observability.onCleanup,
      "function",
      "observability onCleanup must be a function",
    );
  }
  if (browser !== undefined) {
    assert.ok(browser && typeof browser === "object");
    assert.deepEqual(
      Object.keys(browser).sort(),
      ["baseCandidateSha", "onCleanup", "onReady"],
      "browser hook shape is closed",
    );
    assert.ok(
      options.recoveryProof &&
        !options.stubSecrets &&
        !options.noBuild &&
        !options.keep &&
        !options.mutationDisableRollback,
      "browser hooks require an ordinary --recovery-proof run",
    );
    assert.match(browser.baseCandidateSha ?? "", COMMIT_SHA);
    assert.equal(typeof browser.onReady, "function");
    assert.equal(typeof browser.onCleanup, "function");
  }
  if (observabilityBrowser !== undefined) {
    assert.deepEqual(Object.keys(observabilityBrowser).sort(), [
      "baseCandidateSha",
      "onCleanup",
      "onReady",
    ]);
    assert.ok(
      options.recoveryProof &&
        !options.stubSecrets &&
        !options.noBuild &&
        !options.keep &&
        !options.mutationDisableRollback &&
        !options.observabilityFixture,
    );
    assert.match(observabilityBrowser.baseCandidateSha ?? "", COMMIT_SHA);
    assert.equal(typeof observabilityBrowser.onReady, "function");
    assert.equal(typeof observabilityBrowser.onCleanup, "function");
  }
  if (options.browserProof)
    assert.ok(browser, "--browser-proof requires the integrated browser hook");
  assert.ok(
    !externalRecovery || !options.keep,
    "compose/browser external recovery always requires verified cleanup",
  );
  if (options.aromaBindingProof)
    assertAromaGatewaySocketAssociationRegression();
  let launchIdentity;
  let launchImageInventory = null;
  if (launchContextPath) {
    launchIdentity = await validateLaunchContext(launchContextPath);
    launchImageInventory = await readLaunchImageInventory({
      evidenceDir: launchIdentity.evidenceDir,
      context: launchIdentity.context,
      services: PUBLISHED_RUNTIME_SERVICES,
    });
    await withEarlyRollbackGuardReceipt(
      {
        mutationDisableRollback: options.mutationDisableRollback,
        launchIdentity,
      },
      async () => {
        assert.equal(
          launchIdentity.candidateRoot,
          ROOT,
          "launch context candidate must match the executing checkout",
        );
        assert.equal(
          resolve(process.cwd()),
          launchIdentity.candidateRoot,
          "Compose smoke must execute from the exact candidate checkout",
        );
        const context = launchIdentity.context;
        const configBytes = await readFile(join(ROOT, "config/platform.yaml"));
        assert.equal(
          createHash("sha256").update(configBytes).digest("hex"),
          context.baseConfigSha256,
          "launch context config hash does not match the active platform.yaml",
        );
        assert.equal(
          typeof context.resources?.composeProject,
          "string",
          "launch context Compose project is missing",
        );
        assert.ok(
          /^[a-z0-9][a-z0-9_-]*$/u.test(context.resources.composeProject),
          "launch context Compose project is invalid",
        );
        assert.equal(
          context.resources.kafkaPrefix,
          context.runId,
          "launch context Kafka prefix is invalid",
        );
        assert.equal(
          Object.hasOwn(context.resources, "databasePrefix") ||
            Object.hasOwn(context.resources, "databases"),
          false,
          "launch context must not supply database names",
        );
        const config = parseYaml(configBytes.toString("utf8"), { json: true });
        const databaseOwnership = JSON.parse(
          await readFile(join(ROOT, "config/database-ownership.json"), "utf8"),
        );
        if (options.observabilityFixture) {
          assert.equal(
            config.environment,
            "development",
            "observability fixture requires the development environment",
          );
          assert.equal(
            config.verification?.databaseIsolation?.enabled,
            false,
            "observability fixture requires canonical database isolation disabled",
          );
          assert.equal(
            config.verification?.kafkaNamespaceIsolation,
            false,
            "observability fixture requires canonical Kafka namespace isolation disabled",
          );
        } else {
          const targetConfig = {
            environment: config.environment,
            databaseIsolation: config.verification?.databaseIsolation,
            services: config.services,
          };
          const claims = databaseOwnership.runtimeClaims.filter(
            ({ database }) => database !== null,
          );
          const targets = claims.map(({ runtime }) =>
            deriveRuntimeDatabaseTarget({
              config: targetConfig,
              runtime,
              ownership: databaseOwnership,
              launchIdentity: {
                schemaVersion: 1,
                runId: context.runId,
                candidateSha: context.candidateSha,
                baseConfigSha256: context.baseConfigSha256,
              },
            }),
          );
          assert.equal(
            claims.length,
            10,
            "canonical database runtime claim count changed",
          );
          assert.equal(
            new Set(targets.map(({ owner }) => owner)).size,
            5,
            "canonical database owner count changed",
          );
          assert.equal(
            new Set(targets.map(({ database }) => database)).size,
            5,
            "derived database targets are ambiguous",
          );
          assert.ok(
            targets.every(
              ({ database, allowedDatabase }) => database === allowedDatabase,
            ),
            "derived database target is not run-scoped",
          );
        }
      },
    );
  }
  if (browserHook !== undefined)
    assert.ok(
      launchIdentity,
      "browser hooks require a validated launch context",
    );
  if (options.observabilityFixture)
    assert.ok(
      launchIdentity,
      "observability fixture requires a validated supply_chain launch context",
    );
  const projectName =
    options.projectName ??
    launchIdentity?.context.resources.composeProject ??
    `coffee-compose-smoke-${process.pid}-${randomUUID().slice(0, 8)}`;
  if (launchIdentity)
    assert.equal(
      projectName,
      launchIdentity.context.resources.composeProject,
      "Compose must use the launch context's exact project name",
    );
  let rollbackLineage;
  let rollbackParent;
  if (options.mutationDisableRollback) {
    assert.ok(launchIdentity, "rollback launch context is missing");
    assert.equal(
      launchIdentity.candidateRoot,
      ROOT,
      "rollback must execute from the exact candidate checkout",
    );
    assert.equal(
      resolve(process.cwd()),
      launchIdentity.candidateRoot,
      "rollback process cwd must be the exact candidate checkout",
    );
    const expectedProject = rollbackComposeProjectName(launchIdentity.context);
    assert.equal(
      projectName,
      expectedProject,
      "rollback must use the context's exact isolated Compose project",
    );
    rollbackLineage = await validateRollbackLineage({
      launchIdentity,
      disabledRoot: options.disabledRoot,
      disabledSha: options.disabledSha,
      restoredRoot: options.restoredRoot,
      restoredSha: options.restoredSha,
    });
    if (launchIdentity.context.resources?.controlledScope === "rollback")
      rollbackParent = await readRollbackParent(launchIdentity);
  }
  let secretsDir;
  let provisionedNetwork = false;
  let databaseProofNetwork;
  let externalPostgresAttachment;
  let verifiedKafka;
  let rollbackRuntimeImages;
  const externalRunDatabaseResources = [];
  let externalDatabaseCleanupReceipt;
  let composeDownComplete = false;
  let composeFile = COMPOSE_FILE;
  const composeFiles = [];
  let composeAttempted = false;
  const builtImages = [];
  let parentOwnedRuntimeImages = false;
  let ownedRuntimeImages;
  let ownedMissingRefs;
  let ownedImagePhase;
  let ownedImageBaseline;
  let databaseProofContainer;
  const fixturePostgresRunId = options.observabilityFixture
    ? randomUUID()
    : undefined;
  let databaseProofStorage;
  let recoveryDatabaseProof;
  let recoveryProofCredentials;
  let recoveryAdminUrl;
  let recoveryDeliveryDatabase;
  let recoveryDeliveryTables = false;
  let customerProofRoles;
  let aromaBindingSnapshot;
  let aromaBindingTlsObserver;
  let aromaBindingFixture;
  let aromaBindingEvidence;
  let aromaBindingRestartEvidence;
  let aromaBindingCleanupReceipt;
  let aromaCartProviderFixture;
  let recoveryProviderFixtureCalls;
  let rollbackOrder;
  let rollbackBaseline;
  let rollbackEvidence;
  let aromaCartFixture;
  let aromaCartSnapshot;
  let aromaCartEvidence;
  let aromaCartRestartEvidence;
  let aromaCartCleanupReceipt;
  let observabilityContext;
  let browserFixture;
  let browserFixtureRoot;
  let browserContext;
  let browserOwnerEvidence;
  let orderEvidence;
  let browserProof;
  let observabilityBrowserProof;
  let browserCallbackAttempted = false;
  let receipt;
  let primaryError;
  let cleanupHookError;
  let retainObservabilityResources = false;
  let standardCleanupError;
  const cleanupFailures = [];
  let rollbackStage = options.mutationDisableRollback ? "bootstrap" : null;
  let rollbackInitialUnknownSubstage;
  let rollbackDisabledReconcileSubstage;
  let rollbackCleanupReceipt;
  let rollbackBootstrapSubstage = options.mutationDisableRollback
    ? "resource-check"
    : null;
  const markRollbackStage = (stage) => {
    assert.ok(
      ROLLBACK_FAILURE_STAGES.includes(stage),
      "rollback internal failure stage is invalid",
    );
    rollbackStage = stage;
  };
  const markRollbackInitialUnknownSubstage = (substage) => {
    if (substage === null) {
      rollbackInitialUnknownSubstage = undefined;
      return;
    }
    assert.ok(
      ROLLBACK_INITIAL_UNKNOWN_SUBSTAGES.includes(substage),
      "rollback initial-unknown substage is not allowlisted",
    );
    rollbackInitialUnknownSubstage = substage;
  };
  const markRollbackDisabledReconcileSubstage = (substage) => {
    if (substage === null) {
      rollbackDisabledReconcileSubstage = undefined;
      return;
    }
    assert.ok(
      ROLLBACK_DISABLED_RECONCILE_SUBSTAGES.includes(substage),
      "rollback disabled reconcile substage is not allowlisted",
    );
    rollbackDisabledReconcileSubstage = substage;
  };
  const markRollbackBootstrapSubstage = (substage) => {
    assert.ok(
      ROLLBACK_BOOTSTRAP_SUBSTAGES.includes(substage),
      "rollback bootstrap substage is invalid",
    );
    rollbackBootstrapSubstage = substage;
  };
  try {
    assert.notEqual(
      projectName,
      "coffee-platform",
      "smoke must not use the main platform project",
    );
    assert.notEqual(
      projectName,
      "coffeeordersystem",
      "smoke must not use the legacy project",
    );
    for (const [resource, list] of [
      ["container", "ps"],
      ["volume", "volume"],
      ["network", "network"],
    ]) {
      const dockerArgs =
        list === "ps" ? ["ps", "--all", "--quiet"] : [list, "ls", "--quiet"];
      assert.equal(
        runDocker([
          ...dockerArgs,
          "--filter",
          `label=com.docker.compose.project=${projectName}`,
        ]).trim(),
        "",
        `smoke project already has ${resource} resources: ${projectName}; choose a new project name`,
      );
    }
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("platform-config");
    const platformConfig = parseYaml(
      await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
      { json: true },
    );
    const kafkaNamespaceIdentity = kafkaNamespaceLaunchIdentity(
      platformConfig,
      launchIdentity,
    );
    const isolatedDatabaseProof =
      options.databaseProof ||
      options.customerProof ||
      options.recoveryProof ||
      externalRecovery ||
      options.mutationDisableRollback ||
      options.aromaBindingProof ||
      options.aromaCartProof;
    const bootstrapFreshKafka =
      options.recoveryProof ||
      (externalRecovery &&
        platformConfig.verification?.kafkaNamespaceIsolation === true);
    const proofLaunchIdentity =
      launchIdentity && isolatedDatabaseProof && !options.observabilityFixture
        ? launchConfigIdentity(launchIdentity)
        : undefined;
    const proofLaunchMetadata =
      launchIdentity && externalRecovery
        ? {
            candidateRoot: launchIdentity.candidateRoot,
            resources: launchIdentity.context.resources,
            expectedLineage: browserHook
              ? "browser"
              : observability
                ? "observability"
                : "compose",
          }
        : undefined;
    if (proofLaunchIdentity) {
      assert.equal(
        platformConfig.verification?.databaseIsolation?.enabled,
        true,
        "isolated launch database proof requires the explicit database-isolation policy",
      );
    }
    if (bootstrapFreshKafka) {
      const kafkaVolume = `${projectName}_kafka_data`;
      const existingVolumes = runDocker([
        "volume",
        "ls",
        "--format",
        "{{.Name}}",
        "--filter",
        `name=${kafkaVolume}`,
      ])
        .trim()
        .split("\n");
      assert.equal(
        existingVolumes.includes(kafkaVolume),
        false,
        "recovery proof requires a fresh Kafka volume before offset bootstrap",
      );
    }
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("credentials");
    const databaseProofCredentials =
      options.databaseProof || options.customerProof
        ? await readDatabaseProofCredentials(proofLaunchIdentity)
        : undefined;
    recoveryProofCredentials =
      externalRecovery ||
      options.recoveryProof ||
      options.aromaBindingProof ||
      options.aromaCartProof
        ? externalRecovery
          ? await readExternalRecoveryProofCredentials(
              proofLaunchIdentity,
              launchContextPath,
              proofLaunchMetadata,
            )
          : await readRecoveryProofCredentials(proofLaunchIdentity)
        : undefined;
    const browserParentModules = recoveryProofCredentials?.browserParentRoot
      ? await loadVerifiedBrowserParentModules(
          recoveryProofCredentials.browserParentRoot,
        )
      : undefined;
    const needsKafka =
      platformConfig.verification?.kafkaNamespaceIsolation === true ||
      !(
        options.databaseProof ||
        options.customerProof ||
        options.aromaBindingProof ||
        options.aromaCartProof
      );
    if (needsKafka) {
      assert.ok(
        launchIdentity,
        "Kafka requires a launch context and supply_chain artifact",
      );
      // migrations already checks the exact browser parent and its OIDC-only lineage.
      const parentImages = rollbackParent
        ? await import(
            pathToFileURL(
              join(
                rollbackParent.identity.candidateRoot,
                "tools/verified-infrastructure-image.mjs",
              ),
            ).href
          )
        : null;
      verifiedKafka = await (
        parentImages?.loadVerifiedGateImage ??
        browserParentModules?.images.loadVerifiedGateImage ??
        loadVerifiedGateImage
      )({
        target: "kafka",
        contextFile:
          rollbackParent?.contextFile ??
          recoveryProofCredentials?.g08PreparationContextPath ??
          launchContextPath,
      });
      if (parentImages) {
        rollbackRuntimeImages = await parentImages.readVerifiedRuntimeImages({
          contextFile: rollbackParent.contextFile,
        });
        assertVerifiedRuntimeImages({
          projectName,
          verifiedImages: rollbackRuntimeImages,
          directImageIds: true,
        });
        for (const path of [
          join(ROOT, "config/platform.yaml"),
          join(options.disabledRoot, "config/platform.yaml"),
          join(options.restoredRoot, "config/platform.yaml"),
        ])
          await chmod(path, 0o444);
      }
    }
    const recoveryPlatformConfig =
      recoveryProofCredentials && proofLaunchIdentity
        ? projectRecoveryPlatformConfig(
            platformConfig,
            recoveryProofCredentials.ownership,
          )
        : platformConfig;
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("tmpfs-secrets");
    secretsDir = await mkdtemp(
      join(SECRETS_TMPFS_ROOT, "coffee-platform-secrets-"),
    );
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("compose-override");
    const ownershipPath = process.env.COFFEE_LAUNCH_IMAGE_OWNERSHIP;
    if (
      ownershipPath &&
      !options.noBuild &&
      !observabilityBrowser &&
      !browser &&
      !(
        options.databaseProof ||
        options.aromaBindingProof ||
        options.aromaCartProof ||
        options.mutationDisableRollback
      )
    ) {
      assert.ok(launchIdentity, "run-owned images require launch identity");
      assert.equal(
        ownershipPath,
        join(
          launchIdentity.evidenceDir,
          "gates/integration/artifacts/runtime-image-ownership.json",
        ),
      );
      assert.equal(await realpath(ownershipPath), ownershipPath);
      const info = await lstat(ownershipPath);
      assert.ok(
        info.isFile() &&
          !info.isSymbolicLink() &&
          info.uid === process.getuid() &&
          (info.mode & 0o777) === 0o400 &&
          info.size > 0 &&
          info.size <= 16384,
      );
      const ownership = JSON.parse(await readFile(ownershipPath, "utf8"));
      ownedRuntimeImages = await readVerifiedRuntimeImages({
        contextFile: launchContextPath,
      });
      assert.equal(ownership.runId, launchIdentity.context.runId);
      assert.equal(ownership.candidateSha, launchIdentity.context.candidateSha);
      assert.equal(ownership.projectName, projectName);
      assert.deepEqual(ownership.images, ownedRuntimeImages);
      assert.equal(
        createHash("sha256")
          .update(JSON.stringify(ownership.baseline))
          .digest("hex"),
        ownership.baselineSha256,
        "runtime image baseline hash mismatch",
      );
      const inventory = inspectLaunchRuntimeImages(
        projectName,
        ownedRuntimeImages,
      );
      ownedMissingRefs = validateRuntimeImageOwnership(
        inventory,
        ownership.baseline,
        ownership.phase,
      ).pending;
      ownedImagePhase = ownership.phase;
      ownedImageBaseline = ownership.baseline;
      parentOwnedRuntimeImages = true;
    }
    composeFile = await writeScopedComposeOverride(projectName, {
      sharedPostgres: !(
        options.databaseProof ||
        options.customerProof ||
        (options.recoveryProof && !externalRecovery) ||
        options.aromaBindingProof ||
        options.aromaCartProof
      ),
      aromaBindingProof: options.aromaBindingProof,
      aromaCartProof: options.aromaCartProof,
      recoveryProof: options.recoveryProof,
      launchContextPath: options.observabilityFixture
        ? undefined
        : launchContextPath,
      kafkaImage: verifiedKafka?.imageId,
      edgeNginxImage: options.noBuild
        ? undefined
        : `${projectName}-edge-nginx:latest`,
      // Приоритет источников образов: D/R-сборки rollback > ownership integration > инвентарь supply_chain.
      ...(launchImageInventory
        ? {
            runtimeImages: Object.fromEntries(
              launchImageInventory.images.map((image) => [
                image.service,
                image.tag,
              ]),
            ),
          }
        : {}),
      ...(rollbackRuntimeImages
        ? {
            runtimeImages: rollbackRuntimeImages,
            observabilityConfig: {
              path: join(ROOT, "config/platform.yaml"),
              sha256: rollbackLineage.B.configSha256,
            },
          }
        : {}),
      ...(ownedRuntimeImages ? { runtimeImages: ownedRuntimeImages } : {}),
      runtimeLogging: observability ? platformConfig : undefined,
    });
    composeFiles.push(composeFile);
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("database-network");
    if (
      options.databaseProof ||
      options.customerProof ||
      (options.recoveryProof && !externalRecovery) ||
      options.aromaBindingProof ||
      options.aromaCartProof
    ) {
      const networkNames = databaseProofNetworkNames(projectName);
      for (const networkName of networkNames) {
        try {
          runDocker(["network", "inspect", networkName]);
        } catch {
          continue;
        }
        throw new Error(
          `database proof network already exists: ${networkName}`,
        );
      }
      databaseProofNetwork = `${projectName}_${EXTERNAL_POSTGRES_NETWORK}`;
      createDatabaseProofNetwork(databaseProofNetwork);
    }
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("materialize-secrets");
    const materialized = await materializeSecrets(secretsDir, {
      ...options,
      configRoot: ROOT,
      observabilityExporterToken: observability?.exporterToken,
      databaseProofCredentials:
        databaseProofCredentials === undefined
          ? undefined
          : { [DATABASE_PROOF_RUNTIME]: databaseProofCredentials.owner },
      recoveryProofCredentials,
    });
    if (browserHook) {
      const lineage = await readBrowserFixtureLineage({
        root: ROOT,
        contextPath: launchContextPath,
        baseCandidateSha: browserHook.baseCandidateSha,
      });
      browserFixture = await materializeBrowserFixture({
        root: ROOT,
        contextPath: launchContextPath,
        lineageArtifactLoc: lineage.receiptPath,
        publicIngressCaPem: materialized.transportMaterials.publicTls.caPem,
      });
      browserFixtureRoot = dirname(browserFixture.browser.homePath);
      const initialComposeFile = composeFile;
      let observabilityConfig;
      if (observabilityBrowser) {
        const path = join(secretsDir, "g14-platform.yaml");
        const bytes = await readFile(join(ROOT, "config/platform.yaml"));
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          launchIdentity.context.baseConfigSha256,
          "observability child config hash mismatch",
        );
        await writeFile(path, bytes, { mode: 0o444, flag: "wx" });
        await chmod(path, 0o444);
        observabilityConfig = {
          path,
          sha256: launchIdentity.context.baseConfigSha256,
        };
      }
      composeFile = await writeScopedComposeOverride(projectName, {
        sharedPostgres: externalRecovery,
        recoveryProof: true,
        launchContextPath,
        kafkaImage: verifiedKafka?.imageId,
        edgeNginxImage: options.noBuild
          ? undefined
          : `${projectName}-edge-nginx:latest`,
        runtimeImages: launchImageInventory
          ? Object.fromEntries(
              launchImageInventory.images.map((image) => [
                image.service,
                image.tag,
              ]),
            )
          : undefined,
        runtimeLogging: observability ? platformConfig : undefined,
        browserFixture,
        observabilityConfig,
        candidateRoot: launchIdentity.candidateRoot,
      });
      composeFiles.push(composeFile);
      await rm(initialComposeFile, { force: true });
    }
    if (options.aromaBindingProof)
      aromaBindingTlsObserver =
        await prepareAromaBindingTlsObserver(secretsDir);
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("provider-fixture");
    if (options.aromaCartProof || options.recoveryProof) {
      aromaCartProviderFixture = await prepareAromaCartProviderFixture(
        secretsDir,
        options.mutationDisableRollback
          ? "add-one-get.json"
          : options.recoveryProof
            ? "remove-owned-get.json"
            : "add-one-get.json",
        { rollbackMode: options.mutationDisableRollback },
      );
    }
    if (options.aromaCartProof) {
      const directory = join(secretsDir, "aroma-cart-proof");
      await writeFile(
        join(directory, "caller.json"),
        materialized.transportMaterials.service.get("aroma-observer"),
        { encoding: "utf8", mode: 0o400 },
      );
      await writeFile(
        join(directory, "convergence.json"),
        materialized.transportMaterials.service.get("aroma-convergence"),
        { encoding: "utf8", mode: 0o400 },
      );
      await writeFile(
        join(directory, "foreign.json"),
        materialized.transportMaterials.service.get("orders-service"),
        { encoding: "utf8", mode: 0o400 },
      );
      aromaCartFixture = { directory };
    }
    if (options.mutationDisableRollback)
      markRollbackBootstrapSubstage("compose-config");
    runCompose(projectName, secretsDir, ["config", "--quiet"], { composeFile });
    if (externalRecovery) {
      externalPostgresAttachment = prepareApprovedExternalPostgresAttachment();
      attachApprovedExternalPostgres(externalPostgresAttachment);
    }
    if (
      !options.databaseProof &&
      !options.customerProof &&
      !options.recoveryProof &&
      !options.aromaBindingProof &&
      !options.aromaCartProof
    )
      provisionedNetwork = ensureExternalNetwork(options);
    if (
      !externalRecovery &&
      (options.databaseProof ||
        options.customerProof ||
        options.recoveryProof ||
        options.aromaBindingProof ||
        options.aromaCartProof)
    ) {
      if (options.mutationDisableRollback)
        markRollbackBootstrapSubstage("pg-container");
      const postgresCredentials =
        options.databaseProof || options.customerProof
          ? databaseProofCredentials
          : recoveryProofCredentials;
      assert.ok(
        postgresCredentials,
        "PostgreSQL proof credentials are missing",
      );
      databaseProofContainer = startDatabaseProofContainer(
        projectName,
        databaseProofNetwork,
        postgresCredentials.admin,
        {
          initialDatabase:
            options.databaseProof || options.customerProof
              ? databaseProofCredentials.databaseName
              : "postgres",
          publishHost:
            options.recoveryProof ||
            options.aromaBindingProof ||
            options.aromaCartProof,
          ephemeralPgData: observability !== undefined,
          ...(options.observabilityFixture
            ? {
                fixtureRunId: fixturePostgresRunId,
                onFixtureCreated: (id) => {
                  databaseProofContainer = id;
                },
              }
            : {}),
        },
      );
      if (options.observabilityFixture)
        assertObservabilityPostgresIdentity({
          id: databaseProofContainer,
          projectName,
          networkName: databaseProofNetwork,
          fixtureRunId: fixturePostgresRunId,
        });
      if (observability !== undefined) {
        databaseProofStorage = assertEphemeralDatabaseProofStorage(
          databaseProofContainer,
        );
      }
      await waitForDockerHealthy(databaseProofContainer);
      await waitForDatabaseProofReady(
        databaseProofContainer,
        postgresCredentials.admin,
        options.databaseProof || options.customerProof
          ? databaseProofCredentials.databaseName
          : "postgres",
      );
      if (options.mutationDisableRollback)
        markRollbackBootstrapSubstage("db-bootstrap");
      if (options.aromaBindingProof) {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(
          databaseProofContainer,
          postgresCredentials,
        );
        const port = recoveryDatabaseProof.port;
        await applyAromaBindingMigration(
          port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
        );
        aromaBindingSnapshot = await seedAromaBindingSnapshot(
          port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
          projectName,
        );
      } else if (options.aromaCartProof) {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(
          databaseProofContainer,
          postgresCredentials,
        );
        const port = recoveryDatabaseProof.port;
        await applyAromaBindingMigration(
          port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
        );
        aromaCartSnapshot = await seedAromaCartReadBinding(
          port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
          secretsDir,
        );
      } else if (options.databaseProof || options.customerProof) {
        bootstrapDatabaseProofRole(
          databaseProofContainer,
          postgresCredentials.admin,
          postgresCredentials.owner,
          databaseProofCredentials.databaseName,
        );
        assertDatabaseProofRole(
          databaseProofContainer,
          postgresCredentials.admin,
          postgresCredentials.owner,
          databaseProofCredentials.databaseName,
        );
        if (options.customerProof)
          customerProofRoles = bootstrapCustomerProofRoles(
            databaseProofContainer,
            postgresCredentials.admin,
            databaseProofCredentials.databaseName,
          );
      } else {
        recoveryDatabaseProof = await bootstrapRecoveryDatabases(
          databaseProofContainer,
          postgresCredentials,
        );
        await applyAromaBindingMigration(
          recoveryDatabaseProof.port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
        );
        await applyCatalogMigrations(
          recoveryDatabaseProof.port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
        );
        if (options.recoveryProof) {
          await applyPricingMigrations(
            recoveryDatabaseProof.port,
            recoveryProofCredentials,
            recoveryPlatformConfig,
          );
          await applyOrdersMigrations(
            recoveryDatabaseProof.port,
            recoveryProofCredentials,
            recoveryPlatformConfig,
          );
        }
        const deliveryDatabase =
          recoveryProofCredentials.roleMap.databases.find(
            (candidate) =>
              candidate.name ===
              recoveryPlatformConfig.services["orders-service"].database,
          );
        assert.ok(
          deliveryDatabase,
          "recovery proof orders database is missing",
        );
        const ordersRole = deliveryDatabase.runtimeRoles.find(
          (candidate) => candidate.runtime === "orders-service",
        );
        assert.ok(ordersRole, "recovery proof orders-service role is missing");
        recoveryAdminUrl = `postgresql://${encodeURIComponent(postgresCredentials.admin.username)}:${encodeURIComponent(postgresCredentials.admin.password)}@127.0.0.1:${recoveryDatabaseProof.port}/postgres`;
        await createDeliveryTables(
          recoveryAdminUrl,
          deliveryDatabase,
          recoveryProofCredentials.rolePasswords,
          ordersRole.role,
        );
        recoveryDeliveryDatabase = deliveryDatabase;
        recoveryDeliveryTables = true;
        if (browserHook) {
          const ownedDatabaseNames = new Set(
            recoveryProofCredentials.roleMap.databases.map(
              (database) => database.name,
            ),
          );
          const ownerConnections = async (database) => {
            assert.ok(
              ownedDatabaseNames.has(database),
              "browser owner evidence database is outside the run scope",
            );
            return createPostgresClient(
              replaceDatabase(recoveryAdminUrl, database),
            );
          };
          browserOwnerEvidence = createBrowserOwnerEvidence({
            connect: ownerConnections,
            roleMap: recoveryProofCredentials.roleMap,
            actorRef: "actor:g15-browser-fixture",
            runId: launchIdentity.context.runId,
          });
          if (observabilityBrowser)
            orderEvidence = createOrderEvidence({
              connect: ownerConnections,
              roleMap: recoveryProofCredentials.roleMap,
              runId: launchIdentity.context.runId,
            });
        }
        if (options.mutationDisableRollback) {
          markRollbackBootstrapSubstage("owner-seed");
          rollbackOrder = await seedRollbackOrder({
            port: recoveryDatabaseProof.port,
            credentials: recoveryProofCredentials,
            platformConfig: recoveryPlatformConfig,
            secretsDir,
          });
          rollbackBaseline = await readRollbackFacts({
            port: recoveryDatabaseProof.port,
            credentials: recoveryProofCredentials,
            platformConfig: recoveryPlatformConfig,
            orderRef: rollbackOrder.orderRef,
            offerRef: rollbackOrder.offerRef,
          });
          assertRollbackFixtureBaseline(rollbackBaseline);
        }
      }
    }
    if (externalRecovery) {
      recoveryDatabaseProof = await applyExternalRecoveryMigrations(
        recoveryProofCredentials,
        platformConfig,
        launchContextPath,
        externalRunDatabaseResources,
      );
      if (options.recoveryProof) {
        recoveryAdminUrl = `postgresql://${encodeURIComponent(recoveryProofCredentials.admin.username)}:${encodeURIComponent(recoveryProofCredentials.admin.password)}@${recoveryDatabaseProof.host}:${recoveryDatabaseProof.port}/postgres`;
        const deliveryDatabase =
          recoveryProofCredentials.roleMap.databases.find(
            (candidate) =>
              candidate.name ===
              recoveryPlatformConfig.services["orders-service"].database,
          );
        assert.ok(
          deliveryDatabase,
          "recovery proof orders database is missing",
        );
        const ordersRole = deliveryDatabase.runtimeRoles.find(
          (candidate) => candidate.runtime === "orders-service",
        );
        assert.ok(ordersRole, "recovery proof orders-service role is missing");
        await createDeliveryTables(
          recoveryAdminUrl,
          deliveryDatabase,
          recoveryProofCredentials.rolePasswords,
          ordersRole.role,
        );
        recoveryDeliveryDatabase = deliveryDatabase;
        recoveryDeliveryTables = true;
        if (browserHook) {
          const ownedDatabaseNames = new Set(
            recoveryProofCredentials.roleMap.databases.map(
              (database) => database.name,
            ),
          );
          const ownerConnections = async (database) => {
            assert.ok(
              ownedDatabaseNames.has(database),
              "browser owner evidence database is outside the run scope",
            );
            return createPostgresClient(
              replaceDatabase(recoveryAdminUrl, database),
            );
          };
          browserOwnerEvidence = createBrowserOwnerEvidence({
            connect: ownerConnections,
            roleMap: recoveryProofCredentials.roleMap,
            actorRef: "actor:g15-browser-fixture",
            runId: launchIdentity.context.runId,
          });
          if (observabilityBrowser)
            orderEvidence = createOrderEvidence({
              connect: ownerConnections,
              roleMap: recoveryProofCredentials.roleMap,
              runId: launchIdentity.context.runId,
            });
        }
      }
    }
    if (options.mutationDisableRollback) markRollbackStage("build");
    const bindRuntimeImages = !(
      options.databaseProof ||
      options.customerProof ||
      options.aromaBindingProof ||
      options.aromaCartProof ||
      browser ||
      options.mutationDisableRollback
    );
    const imageContextPath = observabilityBrowser
      ? recoveryProofCredentials?.g08PreparationContextPath
      : launchContextPath;
    const imageIdentity = observabilityBrowser
      ? await browserParentModules.validateLaunchContext(imageContextPath)
      : launchIdentity;
    if (launchImageInventory)
      assertPublishedRuntimeImages(launchImageInventory);
    const ownedTargets = parentOwnedRuntimeImages
      ? runtimeImageBuildTargets(
          projectName,
          ownedMissingRefs,
          options.customerProof,
        )
      : null;
    // Опубликованный инвентарь supply_chain покрывает все runtime-образы, поэтому
    // ownership-фаза не должна инициировать сборку.
    const imageMode =
      launchImageInventory ||
      ownedImagePhase === "ready" ||
      (ownedTargets &&
        ownedTargets.runtimes.length === 0 &&
        !ownedTargets.nginx)
        ? "reuse"
        : "build";
    if (!options.noBuild && !rollbackRuntimeImages && imageMode === "build") {
      let temporary;
      let snapshot;
      const imageStart = Date.now();
      try {
        if (imageMode === "build" && imageIdentity && bindRuntimeImages) {
          temporary = await mkdtemp(join(tmpdir(), "coffee-runtime-build-"));
          snapshot = await createBuildInputSnapshot({
            candidateRoot: imageIdentity.candidateRoot,
            candidateSha: imageIdentity.context.candidateSha,
            temporary,
          });
          await verifyBuildInputSnapshot(snapshot);
        }
        try {
          if (imageMode === "build")
            buildRuntimeImages(
              projectName,
              parentOwnedRuntimeImages
                ? ownedTargets.runtimes
                : options.databaseProof || options.customerProof
                  ? [DATABASE_PROOF_RUNTIME]
                  : options.aromaBindingProof || options.aromaCartProof
                    ? ["api-internal", "aroma-gateway"]
                    : RUNTIMES,
              builtImages,
              snapshot?.contextPath ?? ROOT,
              { includeNginx: !parentOwnedRuntimeImages || ownedTargets.nginx },
            );
        } finally {
          if (snapshot) await verifyBuildInputSnapshot(snapshot);
        }
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
      if (parentOwnedRuntimeImages)
        console.log(
          JSON.stringify({
            runtimeImages: imageMode,
            durationMs: Date.now() - imageStart,
          }),
        );
    }
    if (bindRuntimeImages) {
      const verifiedImages = await (
        browserParentModules?.images.readVerifiedRuntimeImages ??
        readVerifiedRuntimeImages
      )({
        contextFile: imageContextPath,
      });
      assertVerifiedRuntimeImages({
        projectName,
        verifiedImages,
        // С опубликованным инвентарём edge-nginx уже лежит под тегом проекта
        // запуска, поэтому проверяем именно его, а не локальный :local.
        noBuild: launchImageInventory ? false : options.noBuild,
        directImageIds: parentOwnedRuntimeImages,
      });
      if (parentOwnedRuntimeImages)
        validateRuntimeImageOwnership(
          inspectLaunchRuntimeImages(projectName, verifiedImages),
          ownedImageBaseline,
          "ready",
        );
    }
    if (parentOwnedRuntimeImages && options.customerProof) {
      validateRuntimeImageOwnership(
        inspectLaunchRuntimeImages(projectName, ownedRuntimeImages),
        ownedImageBaseline,
        ownedImagePhase,
      );
      for (const service of [DATABASE_PROOF_RUNTIME, "edge-nginx"]) {
        const expected = ownedRuntimeImages.find(
          (image) => image.service === service,
        ).imageId;
        assert.equal(
          runDocker([
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            expected,
          ]).trim(),
          expected,
          `${service} image differs from the scanned supply_chain artifact`,
        );
      }
    }
    throwIfRollbackTerminationRequested();
    if (options.customerProof)
      await writeCustomerProofFixtures(
        secretsDir,
        materialized.securityMaterial,
        materialized.transportMaterials,
      );
    if (options.aromaBindingProof)
      aromaBindingFixture = await writeAromaBindingProofFixtures(
        secretsDir,
        materialized,
        platformConfig.environment,
        aromaBindingTlsObserver,
      );
    const upArguments =
      options.databaseProof || options.customerProof
        ? ["up", "--detach", "--wait", "--no-build", DATABASE_PROOF_RUNTIME]
        : options.aromaBindingProof || options.aromaCartProof
          ? [
              "up",
              "--detach",
              "--wait",
              "--no-build",
              "api-internal",
              "aroma-gateway",
              ...(options.aromaCartProof ? ["aroma-provider-fixture"] : []),
            ]
          : ["up", "--detach", "--wait", "--no-build"];
    if (options.mutationDisableRollback) markRollbackStage("up");
    composeAttempted = true;
    if (bootstrapFreshKafka)
      prepareRecoveryKafkaBootstrap(
        projectName,
        secretsDir,
        platformConfig,
        composeFile,
        runTrackedRollbackCompose,
        proofLaunchIdentity,
      );
    else if (platformConfig.verification?.kafkaNamespaceIsolation === true)
      prepareKafkaNamespaceRegistry(
        projectName,
        secretsDir,
        platformConfig,
        composeFile,
        kafkaNamespaceIdentity,
      );
    try {
      runTrackedRollbackCompose(
        "runtime-stack-up",
        projectName,
        secretsDir,
        upArguments,
        { composeFile, inherit: true },
        databaseProofContainer,
      );
    } catch (error) {
      // Диагностика отказов старта: без логов контейнеров причина не видна,
      // потому что cleanup удаляет их вместе с evidence.
      try {
        const logs = execFileSync(
          "docker",
          composeArgs(
            projectName,
            ["logs", "--no-color", "--tail", "200"],
            composeFile,
          ),
          {
            cwd: ROOT,
            env: { ...process.env, COFFEE_COMPOSE_SECRETS_DIR: secretsDir },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        error.message = `${error.message}\n--- failure logs ---\n${logs}`;
      } catch {
        // логи недоступны — исходная ошибка важнее
      }
      throw error;
    }
    throwIfRollbackTerminationRequested();
    if (launchImageInventory)
      assertRuntimeContainersMatchInventory(projectName, launchImageInventory, {
        requireComplete: !(
          options.databaseProof ||
          options.customerProof ||
          options.aromaBindingProof ||
          options.aromaCartProof
        ),
      });
    if (options.mutationDisableRollback) markRollbackStage("readiness");
    const rows =
      options.databaseProof ||
      options.customerProof ||
      options.aromaBindingProof ||
      options.aromaCartProof
        ? new Map(
            serviceRows(projectName, secretsDir, composeFile).map((row) => [
              row.Service,
              row,
            ]),
          )
        : assertHealthy(projectName, secretsDir, composeFile);
    if (verifiedKafka) {
      const kafka = rows.get("kafka");
      assert.ok(kafka?.ID, "verified Kafka container is missing");
      assert.equal(
        runDocker(["inspect", "--format", "{{.Image}}", kafka.ID]).trim(),
        verifiedKafka.imageId,
        "Kafka runtime differs from the scanned supply_chain artifact",
      );
    }
    if (rollbackRuntimeImages) {
      for (const { service: name, imageId } of rollbackRuntimeImages) {
        const row = rows.get(name);
        assert.ok(row?.ID, `verified runtime container is missing: ${name}`);
        assert.equal(
          runDocker(["inspect", "--format", "{{.Image}}", row.ID]).trim(),
          imageId,
          `${name} runtime differs from the scanned parent supply_chain artifact`,
        );
      }
    }
    if (browserHook) {
      const idp = rows.get("g15-idp");
      assert.ok(idp, "browser IdP fixture is absent from Compose ps");
      assert.equal(idp.State, "running");
      assert.equal(idp.Health, "healthy");
    }
    let kafkaRetention;
    let kafkaNamespaceInventory;
    let nativeFoundation;
    let dependencyReadiness;
    if (options.aromaBindingProof) {
      assert.ok(
        aromaBindingSnapshot && aromaBindingFixture && recoveryDatabaseProof,
        "aroma binding proof fixtures are missing",
      );
      const initialRows = await assertAromaBindingTopology(
        projectName,
        secretsDir,
        composeFile,
      );
      aromaBindingEvidence = await runAromaBindingProofFixture(
        projectName,
        secretsDir,
        composeFile,
        aromaBindingFixture,
        "baseline",
        aromaBindingSnapshot,
        platformConfig.environment,
      );
      const afterRegisterCount = await queryAromaBindingCount(
        recoveryDatabaseProof.port,
        aromaBindingSnapshot,
        recoveryProofCredentials,
        recoveryPlatformConfig,
      );
      assert.equal(
        afterRegisterCount,
        1,
        "allowed registration did not create exactly one durable binding",
      );
      runCompose(
        projectName,
        secretsDir,
        ["stop", "--timeout", "30", "aroma-gateway"],
        { composeFile, inherit: true },
      );
      runCompose(
        projectName,
        secretsDir,
        ["up", "--detach", "--wait", "--no-build", "aroma-gateway"],
        { composeFile, inherit: true },
      );
      const restartedRows = await assertAromaBindingTopology(
        projectName,
        secretsDir,
        composeFile,
      );
      assert.equal(
        restartedRows.get("api-internal")?.ID,
        initialRows.get("api-internal")?.ID,
        "api-internal was restarted unexpectedly",
      );
      assert.equal(
        restartedRows.get("aroma-gateway")?.State,
        "running",
        "aroma-gateway did not restart",
      );
      aromaBindingRestartEvidence = await runAromaBindingProofFixture(
        projectName,
        secretsDir,
        composeFile,
        aromaBindingFixture,
        "replay",
        aromaBindingSnapshot,
        platformConfig.environment,
      );
      const afterRestartCount = await queryAromaBindingCount(
        recoveryDatabaseProof.port,
        aromaBindingSnapshot,
        recoveryProofCredentials,
        recoveryPlatformConfig,
      );
      assert.equal(
        afterRestartCount,
        1,
        "restart replay created a second binding",
      );
      const boundedLogs = runCompose(
        projectName,
        secretsDir,
        [
          "logs",
          "--no-color",
          "--no-log-prefix",
          "--tail",
          "200",
          "api-internal",
          "aroma-gateway",
        ],
        { composeFile },
      );
      assert.ok(
        boundedLogs.length <= 100_000,
        "proof logs exceeded the bounded redaction window",
      );
      const redactionCanaries = [
        aromaBindingSnapshot.rawCanary,
        recoveryProofCredentials.admin.password,
        recoveryProofCredentials.databaseCredentialsByRuntime["aroma-gateway"]
          .password,
        materialized.kafkaCredential.password,
      ];
      for (const canary of redactionCanaries) {
        assert.equal(
          boundedLogs.includes(canary),
          false,
          "proof logs exposed a secret or raw provider canary",
        );
        assert.equal(
          JSON.stringify({
            aromaBindingEvidence,
            aromaBindingRestartEvidence,
          }).includes(canary),
          false,
          "proof output exposed a secret or raw provider canary",
        );
      }
      aromaBindingCleanupReceipt = {
        composeProject: projectName,
        disposableDatabase: databaseProofContainer,
        fixture: "--rm",
        networks: [
          `${projectName}_coffee_internal_api`,
          `${projectName}_coffee_postgres_data`,
        ],
        boundedLogLines: 200,
        redacted: true,
      };
    } else if (options.aromaCartProof) {
      assert.ok(
        aromaCartSnapshot &&
          aromaCartFixture &&
          aromaCartProviderFixture &&
          recoveryDatabaseProof &&
          recoveryProofCredentials,
        "aroma cart proof fixtures are missing",
      );
      const initialRows = await assertAromaCartTopology(
        projectName,
        secretsDir,
        composeFile,
      );
      const selectedGrind = JSON.parse(
        await readFile(
          join(aromaCartFixture.directory, "selected-grind.json"),
          "utf8",
        ),
      );
      aromaCartEvidence = await runAromaCartProofFixture(
        projectName,
        secretsDir,
        composeFile,
        aromaCartFixture,
        platformConfig.environment,
      );
      const firstCounts = await readAromaCartProviderCounts(
        aromaCartProviderFixture.countFile,
      );
      assert.deepEqual(
        firstCounts,
        { login: 1, catalog: 0, cart: 11, post: 1, put: 2, delete: 1 },
        "cart mutation provider call counts were not exact",
      );
      const operationRefs = [
        "op_00000000000000000000000001",
        "op_00000000000000000000000002",
        "op_00000000000000000000000003",
        "op_00000000000000000000000004",
      ];
      const firstJournalRows = assertAromaMutationJournal(
        await readAromaMutationJournal(
          recoveryDatabaseProof.port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
          operationRefs,
        ),
        selectedGrind.sourceGrindKeyHash,
      );
      aromaCartEvidence = {
        ...aromaCartEvidence,
        journalRows: firstJournalRows,
        realPostgresJournal: true,
        providerAccess: false,
        providerKind: "local-fake",
        liveProviderAcceptance: false,
      };
      runCompose(
        projectName,
        secretsDir,
        ["stop", "--timeout", "30", "aroma-gateway"],
        { composeFile, inherit: true },
      );
      runCompose(
        projectName,
        secretsDir,
        ["up", "--detach", "--wait", "--no-build", "aroma-gateway"],
        { composeFile, inherit: true },
      );
      const restartedRows = await assertAromaCartTopology(
        projectName,
        secretsDir,
        composeFile,
      );
      assert.equal(
        restartedRows.get("api-internal")?.ID,
        initialRows.get("api-internal")?.ID,
        "api-internal was restarted unexpectedly",
      );
      aromaCartRestartEvidence = await runAromaCartProofFixture(
        projectName,
        secretsDir,
        composeFile,
        aromaCartFixture,
        platformConfig.environment,
        "4",
      );
      const secondCounts = await readAromaCartProviderCounts(
        aromaCartProviderFixture.countFile,
      );
      assert.deepEqual(
        secondCounts,
        { login: 1, catalog: 0, cart: 15, post: 1, put: 2, delete: 1 },
        "restart did not reuse the encrypted PostgreSQL session or replay terminal mutations",
      );
      const secondJournalRows = assertAromaMutationJournal(
        await readAromaMutationJournal(
          recoveryDatabaseProof.port,
          recoveryProofCredentials,
          recoveryPlatformConfig,
          operationRefs,
        ),
        selectedGrind.sourceGrindKeyHash,
      );
      assert.deepEqual(
        secondJournalRows,
        firstJournalRows,
        "restart changed durable mutation journal rows",
      );
      aromaCartRestartEvidence = {
        ...aromaCartRestartEvidence,
        journalRows: secondJournalRows,
        realPostgresJournal: true,
        providerAccess: false,
        providerKind: "local-fake",
        liveProviderAcceptance: false,
      };
      const boundedLogs = runCompose(
        projectName,
        secretsDir,
        [
          "logs",
          "--no-color",
          "--no-log-prefix",
          "--tail",
          "200",
          "api-internal",
          "aroma-gateway",
          "aroma-provider-fixture",
        ],
        { composeFile },
      );
      assert.ok(
        boundedLogs.length <= 100_000,
        "proof logs exceeded the bounded redaction window",
      );
      for (const canary of [
        "fixture-cookie",
        '"id": 300000',
        '"id":300000',
        recoveryProofCredentials.admin.password,
        recoveryProofCredentials.databaseCredentialsByRuntime["aroma-gateway"]
          .password,
        materialized.kafkaCredential.password,
      ]) {
        assert.equal(
          boundedLogs.includes(canary),
          false,
          "safe-read logs exposed a secret or raw provider canary",
        );
        assert.equal(
          JSON.stringify({
            aromaCartEvidence,
            aromaCartRestartEvidence,
          }).includes(canary),
          false,
          "safe-read evidence exposed a secret or raw provider canary",
        );
      }
      aromaCartCleanupReceipt = {
        composeProject: projectName,
        disposableDatabase: databaseProofContainer,
        providerFixture: "aroma-provider-fixture",
        fixture: "--rm",
        networks: [
          `${projectName}_coffee_internal_api`,
          `${projectName}_coffee_postgres_data`,
          `${projectName}_coffee_provider_egress`,
        ],
        boundedLogLines: 200,
        redacted: true,
      };
    } else if (options.databaseProof) {
      const row = rows.get(DATABASE_PROOF_RUNTIME);
      assert.ok(row, `${DATABASE_PROOF_RUNTIME} is absent from Compose ps`);
      assert.equal(row.State, "running");
      assert.equal(row.Health, "healthy");
      await assertDatabaseProof(
        projectName,
        secretsDir,
        databaseProofContainer,
        composeFile,
      );
    } else if (options.customerProof) {
      assert.ok(customerProofRoles, "customer proof roles are missing");
      await runCustomerIntegrationProof(
        projectName,
        secretsDir,
        databaseProofCredentials,
        customerProofRoles,
        composeFile,
        databaseProofCredentials.databaseName,
        proofLaunchIdentity ? launchContextPath : undefined,
      );
    } else {
      kafkaRetention = assertKafkaDurableRetention(
        projectName,
        secretsDir,
        composeFile,
      );
      assertTelemetryEnvironment(rows);
      assertSecretMounts(projectName, secretsDir, rows, composeFile);
      await assertReadiness(projectName, secretsDir, composeFile);
      if (platformConfig.verification?.kafkaNamespaceIsolation === true) {
        const actualTopics = runCompose(
          projectName,
          secretsDir,
          [
            "exec",
            "-T",
            "kafka",
            "/opt/kafka/bin/kafka-topics.sh",
            "--bootstrap-server",
            "kafka:9092",
            "--command-config",
            "/etc/kafka/secrets/client.properties",
            "--list",
          ],
          { composeFile },
        )
          .split(/\r?\n/u)
          .map((name) => name.trim())
          .filter(Boolean);
        const actualGroups = runCompose(
          projectName,
          secretsDir,
          [
            "exec",
            "-T",
            "kafka",
            "/opt/kafka/bin/kafka-consumer-groups.sh",
            "--bootstrap-server",
            "kafka:9092",
            "--command-config",
            "/etc/kafka/secrets/client.properties",
            "--list",
          ],
          { composeFile },
        )
          .split(/\r?\n/u)
          .map((name) => name.trim())
          .filter(Boolean);
        kafkaNamespaceInventory = captureKafkaNamespaceInventory({
          projectName,
          platformConfig,
          launchIdentity: {
            schemaVersion: 1,
            runId: launchIdentity.context.runId,
            candidateSha: launchIdentity.context.candidateSha,
            baseConfigSha256: launchIdentity.context.baseConfigSha256,
          },
          actualTopics,
          actualGroups,
        });
      }
      if (observability || browserHook) {
        const resolvedCompose = JSON.parse(
          runCompose(projectName, secretsDir, ["config", "--format", "json"], {
            composeFile,
          }),
        );
        const networks = Object.fromEntries(
          Object.entries(resolvedCompose.networks ?? {}).map(
            ([logicalName, network]) => {
              assert.equal(
                typeof network.name,
                "string",
                `Compose network ${logicalName} has no resolved name`,
              );
              return [logicalName, network.name];
            },
          ),
        );
        const runtimeContext = {
          projectName,
          runtimes: [...RUNTIMES],
          networks,
        };
        if (observability) {
          observabilityContext = runtimeContext;
          await observability.onReady(observabilityContext);
        }
        if (browserHook) {
          browserContext = {
            projectName,
            runId: launchIdentity.context.runId,
            candidateSha: launchIdentity.context.candidateSha,
            networks,
            throwIfStopRequested: throwIfRollbackTerminationRequested,
            readRealtimeAuthCloseCount: () =>
              readRealtimeAuthCloseCount(
                projectName,
                rows.get("realtime-gateway")?.ID,
              ),
            restartCustomerService: () =>
              restartBrowserFixtureCustomerService(
                projectName,
                secretsDir,
                rows.get("customer-service")?.ID,
                composeFile,
              ),
            nginxContainerId: rows.get("edge-nginx")?.ID,
            ownerEvidence: browserOwnerEvidence,
            ...(observabilityBrowser
              ? {
                  orderEvidence,
                  configSha256: launchIdentity.context.baseConfigSha256,
                  attestObservabilitySafety: () =>
                    attestObservabilityProviderBoundary({
                      projectName,
                      secretsDir,
                      composeFile,
                      expectedConfigSha256:
                        launchIdentity.context.baseConfigSha256,
                    }),
                }
              : {}),
            browserFixture: {
              profile: browserFixture.profile,
              runId: browserFixture.runId,
              issuer: browserFixture.issuer,
              idp: {
                hostname: browserFixture.idp.hostname,
                certificatePath: browserFixture.idp.certificatePath,
                jwksPath: browserFixture.idp.jwksPath,
              },
              publicIngressCaPath: browserFixture.publicIngressCaPath,
              browser: browserFixture.browser,
              hashes: browserFixture.hashes,
            },
          };
          assert.equal(typeof browserContext.nginxContainerId, "string");
        }
      }
      assertHostExposure(projectName, secretsDir, rows, composeFile);
      if (options.mutationDisableRollback) markRollbackStage("nginx");
      await assertNginxIngress(
        platformConfig.nginxTransport.publicHost,
        options.stubSecrets || options.recoveryProof
          ? materialized.transportMaterials.publicTls.caPem
          : parseYaml(
              await readFile(join(secretsDir, "edge-gateway.yaml"), "utf8"),
              {
                json: true,
              },
            )?.secrets?.edge?.tlsCaBundle,
      );
      if (browser) {
        throwIfRollbackTerminationRequested();
        browserCallbackAttempted = true;
        browserProof = validateBrowserProof(
          await browser.onReady(browserContext),
          {
            runId: launchIdentity.context.runId,
            candidateSha: launchIdentity.context.candidateSha,
          },
        );
      }
      if (observabilityBrowser) {
        throwIfRollbackTerminationRequested();
        browserCallbackAttempted = true;
        observabilityBrowserProof = validateObservabilityBrowserEvidence(
          await observabilityBrowser.onReady(browserContext),
          {
            runId: launchIdentity.context.runId,
            candidateSha: launchIdentity.context.candidateSha,
            configSha256: launchIdentity.context.baseConfigSha256,
          },
        );
      }
      if (options.mutationDisableRollback) {
        rollbackEvidence = await runMutationDisableRollbackProof({
          projectName,
          secretsDir,
          composeFile,
          recoveryDatabaseProof,
          recoveryProofCredentials,
          platformConfig: recoveryPlatformConfig,
          providerFixture: aromaCartProviderFixture,
          rollbackOrder,
          baseline: rollbackBaseline,
          lineage: rollbackLineage,
          disabledRoot: options.disabledRoot,
          restoredRoot: options.restoredRoot,
          launchContextPath,
          launchIdentity,
          kafkaImage: verifiedKafka.imageId,
          runtimeImages: rollbackRuntimeImages,
          markStage: markRollbackStage,
          markInitialUnknownSubstage: markRollbackInitialUnknownSubstage,
          markDisabledReconcileSubstage: markRollbackDisabledReconcileSubstage,
        });
        if (rollbackParent)
          rollbackEvidence.imageBinding = {
            parentRunId: rollbackParent.identity.context.runId,
            parentCandidateSha: rollbackParent.identity.context.candidateSha,
            runtimeImages: rollbackRuntimeImages,
            kafkaImageId: verifiedKafka.imageId,
          };
      } else if (
        options.recoveryProof &&
        (!browserHook || observabilityBrowser)
      ) {
        assert.ok(
          aromaCartProviderFixture,
          "recovery proof local provider fixture is missing",
        );
        const providerFixtureCalls = await readAromaCartProviderCounts(
          aromaCartProviderFixture.countFile,
        );
        assert.ok(
          providerFixtureCalls.catalog >= 1,
          "recovery proof did not reach the local provider fixture for Catalog traversal",
        );
        recoveryProviderFixtureCalls = providerFixtureCalls;
        runCompose(
          projectName,
          secretsDir,
          ["stop", "orders-aroma-preparation"],
          { composeFile },
        );
        let recoveryBodyFailed = false;
        let recoveryBodyError;
        try {
          const fixture = await prepareKafkaNativeFixture(
            projectName,
            secretsDir,
            projectName,
            composeFile,
            proofLaunchIdentity,
          );
          const foundationOutput = runCompose(
            projectName,
            secretsDir,
            ["exec", "-T", "orders-service", "node", "--input-type=module"],
            {
              composeFile,
              input: nativeFoundationSource({
                runId: projectName,
                ...fixture,
                ordersDatabase: databaseProofService(
                  recoveryPlatformConfig,
                  recoveryProofCredentials.ownership,
                  "orders-service",
                ).database,
              }),
            },
          ).trim();
          const foundationLine = foundationOutput
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
          assert.ok(
            foundationLine,
            "native foundation proof did not return evidence JSON",
          );
          const normalEvidence = JSON.parse(foundationLine);
          assert.equal(
            normalEvidence.sigterm?.received,
            true,
            "SIGTERM fixture did not observe the signal",
          );
          assert.equal(
            normalEvidence.sigterm?.gateEntered,
            true,
            "SIGTERM fixture did not gate a handler",
          );
          assert.ok(
            normalEvidence.sigterm?.activeAtSignal?.total >= 1,
            "SIGTERM fixture had no active handler at signal time",
          );
          assert.equal(
            normalEvidence.sigterm?.ownerCount,
            1,
            "SIGTERM fixture owner effect was not durable",
          );
          assert.ok(
            normalEvidence.sigterm?.closedMetrics,
            "SIGTERM fixture closed metrics are missing",
          );
          for (const metrics of Object.values(
            normalEvidence.sigterm.closedMetrics,
          )) {
            assert.equal(
              metrics.assigned,
              0,
              "SIGTERM fixture left a partition assigned",
            );
            assert.equal(metrics.active, 0, "SIGTERM fixture left active work");
            assert.equal(
              metrics.pending,
              0,
              "SIGTERM fixture left pending work",
            );
          }
          const ordersOutbox = await assertOrdersOutboxBrokerRecovery(
            projectName,
            secretsDir,
            composeFile,
            recoveryDatabaseProof.port,
            recoveryDatabaseProof.host ?? "127.0.0.1",
            recoveryProofCredentials,
            recoveryPlatformConfig,
            fixture.kafkaTargets.orders,
          );
          const kafkaChecks = [];
          if (observability && externalRecovery) {
            for (const runtime of RUNTIMES.filter((name) => {
              const kafka = recoveryPlatformConfig.services[name].kafka;
              return (
                name !== "orders-aroma-preparation" &&
                (kafka.producers.length > 0 || kafka.consumers.length > 0)
              );
            })) {
              const id = rows.get(runtime)?.ID;
              const before = ownedDependencySnapshot(projectName, runtime, id);
              const status = await waitForDependencyHealth(
                id,
                "/health/ready",
                200,
              );
              kafkaChecks.push({ runtime, before, status });
            }
          }
          const blackhole = await runKafkaBlackholeProof(
            projectName,
            secretsDir,
            projectName,
            fixture.mappingTopic,
            databaseProofService(
              recoveryPlatformConfig,
              recoveryProofCredentials.ownership,
              "orders-service",
            ).database,
            composeFile,
            fixture.kafkaTargets.preparation,
            kafkaChecks.length === 0
              ? undefined
              : async (kafkaSince) => {
                  for (const entry of kafkaChecks) {
                    assertDependencyIdentity(
                      projectName,
                      entry.runtime,
                      entry.before,
                    );
                    entry.during = await waitForDependencyHealth(
                      entry.before.Id,
                      "/health/ready",
                      503,
                    );
                    entry.liveDuring = await waitForDependencyHealth(
                      entry.before.Id,
                      "/health/live",
                      200,
                    );
                    assert.ok(
                      dependencyFailureLogged(
                        entry.before.Id,
                        "kafka",
                        kafkaSince,
                      ),
                      "Kafka readiness failure was not observed",
                    );
                  }
                },
          );
          if (kafkaChecks.length > 0) {
            const checks = [];
            for (const entry of kafkaChecks) {
              assertDependencyIdentity(
                projectName,
                entry.runtime,
                entry.before,
              );
              checks.push({
                runtime: entry.runtime,
                dependency: "kafka",
                before: entry.status,
                during: entry.during,
                after: await waitForDependencyHealth(
                  entry.before.Id,
                  "/health/ready",
                  200,
                ),
                liveDuring: entry.liveDuring,
                restored: true,
                addressChanged: null,
              });
            }
            dependencyReadiness = {
              status: "NOT_RUN",
              checks,
              notApplicable: [],
              localChecks: "NOT_PROVEN",
            };
          }
          nativeFoundation = { ...normalEvidence, ordersOutbox, blackhole };
        } catch (error) {
          recoveryBodyFailed = true;
          recoveryBodyError = error;
        }
        try {
          runCompose(
            projectName,
            secretsDir,
            [
              "up",
              "--detach",
              "--wait",
              "--no-build",
              "orders-aroma-preparation",
            ],
            { composeFile },
          );
          await waitForRuntimeReadiness(
            projectName,
            secretsDir,
            "orders-aroma-preparation",
            200,
            remainingGateWaitMs(),
            composeFile,
          );
        } catch (restoreError) {
          if (recoveryBodyFailed) {
            throw new AggregateError(
              [recoveryBodyError, restoreError],
              "Recovery proof and orders-aroma-preparation restoration both failed",
              { cause: recoveryBodyError },
            );
          }
          throw restoreError;
        }
        if (recoveryBodyFailed) throw recoveryBodyError;
        if (dependencyReadiness) {
          const preparation = rows.get("orders-aroma-preparation")?.ID;
          dependencyReadiness.checks.push(
            await proveOwnedNetworkDependency({
              projectName,
              runtime: "orders-aroma-preparation",
              containerId: preparation,
              networkName: `${projectName}_coffee_kafka_event`,
              dependency: "kafka",
              checkName: "kafka",
            }),
          );
          for (const runtime of RUNTIMES) {
            const service = recoveryPlatformConfig.services[runtime];
            if (service.database !== null)
              dependencyReadiness.checks.push(
                await proveOwnedNetworkDependency({
                  projectName,
                  runtime,
                  containerId: rows.get(runtime)?.ID,
                  networkName: EXTERNAL_POSTGRES_NETWORK,
                  dependency: "database",
                  checkName: "database",
                }),
              );
          }
          for (const [runtime, checkName] of [
            ["orders-service", "orders-internal-api"],
            ["aroma-observer", "aroma-observation-internal-api"],
            ["aroma-convergence", "aroma-convergence-internal-api"],
          ])
            dependencyReadiness.checks.push(
              await proveOwnedNetworkDependency({
                projectName,
                runtime,
                containerId: rows.get(runtime)?.ID,
                networkName: `${projectName}_coffee_internal_api`,
                dependency: "internal-api",
                checkName,
              }),
            );
          dependencyReadiness.notApplicable = [
            "edge-gateway",
            "api-public",
            "api-internal",
          ].map((runtime) => ({
            runtime,
            reason: "no-registered-readiness-dependency",
          }));
          dependencyReadiness.status = "PASS";
        }
      }
    }
    if (!options.keep) {
      runCompose(projectName, secretsDir, ["stop", "--timeout", "30"], {
        composeFile,
        inherit: true,
      });
      assertStopped(projectName, secretsDir, composeFile);
    }
    receipt = {
      ...(observability
        ? {
            proofKind: options.observabilityFixture
              ? "observability-fixture"
              : "observability-external",
          }
        : {}),
      project: projectName,
      runtimes:
        options.aromaBindingProof || options.aromaCartProof
          ? ["api-internal", "aroma-gateway"]
          : options.databaseProof || options.customerProof
            ? 1
            : RUNTIMES.length,
      nativeIngress:
        options.databaseProof || options.customerProof
          ? undefined
          : "edge-nginx",
      kafka:
        options.aromaBindingProof || options.aromaCartProof
          ? false
          : !(options.databaseProof || options.customerProof),
      kafkaSupplyChain: verifiedKafka,
      kafkaCompatibility:
        options.aromaBindingProof || options.aromaCartProof
          ? false
          : !(options.databaseProof || options.customerProof),
      ephemeralKafkaBroker: !(
        options.databaseProof ||
        options.customerProof ||
        options.aromaBindingProof ||
        options.aromaCartProof
      ),
      credentialSource:
        options.stubSecrets ||
        options.databaseProof ||
        options.customerProof ||
        (options.recoveryProof && !externalRecovery) ||
        options.aromaBindingProof ||
        options.aromaCartProof
          ? "local-fixture"
          : "canonical-runtime-plus-local-kafka-fixture",
      kafkaRetention:
        options.aromaBindingProof || options.aromaCartProof
          ? undefined
          : options.databaseProof || options.customerProof
            ? undefined
            : kafkaRetention,
      kafkaNamespaceInventory,
      ...(dependencyReadiness ? { dependencyReadiness } : {}),
      recoveryProof:
        options.recoveryProof && !browserHook
          ? {
              postgres: recoveryDatabaseProof,
              postgresStorage: databaseProofStorage,
              kafka: kafkaRetention,
              native: nativeFoundation,
              providerFixture: recoveryProviderFixtureCalls,
            }
          : undefined,
      ...(externalRecovery
        ? { externalCleanup: { verified: false, failure: "CLEANUP_PENDING" } }
        : {}),
      browserProof,
      ...(observabilityBrowser ? { observabilityBrowserProof } : {}),
      mutationDisableRollback: rollbackEvidence,
      aromaBindingProof: options.aromaBindingProof
        ? {
            services: ["api-internal", "aroma-gateway"],
            baseline: aromaBindingEvidence,
            restartReplay: aromaBindingRestartEvidence,
            durableBindingCount: 1,
            cleanup: aromaBindingCleanupReceipt,
          }
        : undefined,
      aromaCartProof: options.aromaCartProof
        ? {
            services: [
              "api-internal",
              "aroma-gateway",
              "aroma-provider-fixture",
            ],
            baseline: aromaCartEvidence,
            restartReplay: aromaCartRestartEvidence,
            providerCalls: {
              first: aromaCartEvidence?.providerCalls,
              restart: aromaCartRestartEvidence?.providerCalls,
            },
            cleanup: aromaCartCleanupReceipt,
          }
        : undefined,
      telemetry:
        options.aromaBindingProof || options.aromaCartProof
          ? false
          : !(options.databaseProof || options.customerProof),
      healthEndpoints: options.customerProof
        ? []
        : ["/health/live", "/health/ready", "/metrics"],
      stubSecrets:
        options.stubSecrets ||
        options.databaseProof ||
        options.customerProof ||
        options.aromaBindingProof ||
        options.aromaCartProof,
      dbIntegrationProof:
        options.databaseProof ||
        options.customerProof ||
        (options.recoveryProof && !browserHook) ||
        options.aromaBindingProof ||
        options.aromaCartProof,
      customerIntegrationProof: options.customerProof,
      hostPublish:
        options.databaseProof ||
        options.customerProof ||
        options.aromaBindingProof ||
        options.aromaCartProof
          ? []
          : ["127.0.0.1:8443:8443"],
      gracefulShutdown: true,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (observability) {
      try {
        await observability.onCleanup(observabilityContext);
      } catch (error) {
        cleanupHookError = error;
      }
    }
    if (browserFixture) {
      if (browserCallbackAttempted) {
        try {
          await browserHook.onCleanup(browserContext);
        } catch (error) {
          cleanupHookError ??= error;
        }
      }
    }
    const retainedDatabases = retainObservabilityAfterCollectorFailure({
      observabilityBrowser,
      observability,
      cleanupHookError,
      options,
      databases: externalRunDatabaseResources,
    });
    retainObservabilityResources = retainedDatabases !== undefined;
    if (retainedDatabases) externalDatabaseCleanupReceipt = retainedDatabases;
    try {
      if (
        recoveryDeliveryTables &&
        !externalRecovery &&
        !options.keep &&
        recoveryAdminUrl &&
        recoveryDeliveryDatabase &&
        recoveryProofCredentials
      ) {
        try {
          await dropDeliveryTables(
            recoveryAdminUrl,
            recoveryDeliveryDatabase,
            recoveryProofCredentials.rolePasswords,
          );
        } catch {
          cleanupFailures.push("orders-fixture-tables");
        }
      }
      for (const snapshot of [aromaBindingSnapshot, aromaCartSnapshot]) {
        if (snapshot?.database && !options.keep) {
          try {
            await snapshot.database.resource.stop(AbortSignal.timeout(10_000));
          } catch {
            if (options.mutationDisableRollback)
              cleanupFailures.push("owner-database-client");
          }
        }
      }
      if (composeAttempted && !options.keep) {
        try {
          runCompose(
            projectName,
            secretsDir,
            ["down", "--volumes", "--remove-orphans"],
            { composeFile },
          );
          composeDownComplete = true;
        } catch (error) {
          if (options.mutationDisableRollback)
            cleanupFailures.push("compose-down");
          else if (
            browserFixture ||
            externalRecovery ||
            options.observabilityFixture
          )
            cleanupHookError ??= error;
        }
      } else if (!composeAttempted && !options.keep) composeDownComplete = true;
      if (externalRecovery && !options.keep) {
        if (composeDownComplete) {
          try {
            externalDatabaseCleanupReceipt =
              await cleanupExternalRecoveryDatabases(
                recoveryProofCredentials,
                externalRunDatabaseResources,
                composeDownComplete,
              );
            if (!externalDatabaseCleanupReceipt.verified)
              cleanupHookError ??= new Error(
                "external run database cleanup is incomplete",
              );
          } catch (error) {
            externalDatabaseCleanupReceipt = {
              verified: false,
              removed: [],
              retained: externalRunDatabaseResources.map(
                ({ database }) => database.name,
              ),
              failure: "EXTERNAL_DATABASE_CLEANUP_FAILED",
            };
            cleanupHookError ??= error;
          }
          try {
            cleanupApprovedExternalPostgresAttachment(
              externalPostgresAttachment,
            );
          } catch (error) {
            cleanupHookError ??= error;
          }
        } else {
          externalDatabaseCleanupReceipt = {
            verified: false,
            removed: [],
            retained: externalRunDatabaseResources.map(
              ({ database }) => database.name,
            ),
            failure: "COMPOSE_CONSUMERS_NOT_STOPPED",
          };
          cleanupHookError ??= new Error(
            "external PostgreSQL cleanup refused while Compose consumers may remain active",
          );
        }
      }
      if (browserFixture && !retainObservabilityResources) {
        try {
          await browserFixture.cleanup();
        } catch (error) {
          cleanupHookError ??= error;
        }
      }
      if (databaseProofContainer && !options.keep) {
        try {
          if (options.observabilityFixture)
            assertObservabilityPostgresIdentity({
              id: databaseProofContainer,
              projectName,
              networkName: databaseProofNetwork,
              fixtureRunId: fixturePostgresRunId,
              allowIncompleteNetwork: true,
            });
          runDocker(["rm", "--force", "--volumes", databaseProofContainer]);
        } catch (error) {
          if (options.mutationDisableRollback)
            cleanupFailures.push("postgres-container-remove");
          if (options.observabilityFixture) cleanupHookError ??= error;
        }
      }
      if (databaseProofNetwork && !options.keep) {
        try {
          runDocker(["network", "rm", databaseProofNetwork]);
        } catch (error) {
          if (options.mutationDisableRollback)
            cleanupFailures.push("postgres-network-remove");
          if (options.observabilityFixture) cleanupHookError ??= error;
        }
      }
      if (provisionedNetwork && !options.keep) {
        try {
          runDocker(["network", "rm", EXTERNAL_POSTGRES_NETWORK]);
        } catch {
          /* never remove a network adopted by another workload */
        }
      }
      if (verifiedKafka?.imported && !options.keep) {
        try {
          assert.equal(
            composeDownComplete,
            true,
            "Kafka consumers must stop before image cleanup",
          );
          removeVerifiedGateImage({ target: "kafka", image: verifiedKafka });
        } catch (error) {
          cleanupHookError ??= error;
        }
      }
      if (!parentOwnedRuntimeImages)
        removeBuiltRuntimeImages(builtImages, options);
      if (composeFile !== COMPOSE_FILE && !options.keep)
        await rm(composeFile, { force: true });
      if (!options.keep && secretsDir)
        await rm(secretsDir, { recursive: true, force: true });
      else if (options.keep && secretsDir)
        console.log(
          `compose-smoke: kept project=${projectName} secretsDir=${secretsDir}`,
        );
    } catch (error) {
      if (options.mutationDisableRollback)
        cleanupFailures.push("temporary-artifacts");
      standardCleanupError = error;
    }
    if (options.mutationDisableRollback && !options.keep) {
      let retainedResources = { containers: [], volumes: [], networks: [] };
      let inventoryVerified = true;
      try {
        retainedResources = inspectRollbackCleanupInventory(
          projectName,
          databaseProofContainer,
          databaseProofNetwork,
        );
      } catch {
        cleanupFailures.push("resource-inventory");
        inventoryVerified = false;
      }
      const retainedList = Object.entries(retainedResources).flatMap(
        ([kind, resources]) => resources.map((name) => ({ kind, name })),
      );
      const complete =
        inventoryVerified &&
        cleanupFailures.length === 0 &&
        retainedList.length === 0 &&
        !standardCleanupError &&
        !cleanupHookError;
      rollbackCleanupReceipt = {
        verified: inventoryVerified,
        complete,
        failures: [...cleanupFailures],
        retainedResources: retainedList,
        inventory: retainedResources,
      };
      if (receipt) receipt.cleanup = rollbackCleanupReceipt;
      if (!complete)
        standardCleanupError = new Error(
          JSON.stringify({
            code: "ROLLBACK_CLEANUP_FAILED",
            failures: cleanupFailures,
            retainedResources: retainedList,
          }),
        );
    }
    if (browserHook && !options.keep) {
      let inventory = { containers: [], volumes: [], networks: [] };
      const failures = [];
      let verified = true;
      try {
        inventory = inspectRollbackCleanupInventory(
          projectName,
          databaseProofContainer,
          databaseProofNetwork,
          projectName,
        );
      } catch {
        verified = false;
        failures.push("resource-inventory");
      }
      let fixtureRootRemoved = false;
      try {
        await lstat(browserFixtureRoot);
      } catch (error) {
        fixtureRootRemoved = error?.code === "ENOENT";
      }
      if (!fixtureRootRemoved) failures.push("fixture-root-retained");
      let secretsDirRemoved = false;
      try {
        await lstat(secretsDir);
      } catch (error) {
        secretsDirRemoved = error?.code === "ENOENT";
      }
      if (!secretsDirRemoved) failures.push("secrets-tmpfs-retained");
      let composeOverrideRemoved = false;
      try {
        await lstat(composeFile);
      } catch (error) {
        composeOverrideRemoved = error?.code === "ENOENT";
      }
      if (!composeOverrideRemoved) failures.push("compose-override-retained");
      if (standardCleanupError) failures.push("compose-cleanup");
      if (cleanupHookError) failures.push("browser-cleanup");
      if (
        externalRecovery &&
        (externalDatabaseCleanupReceipt?.verified !== true ||
          (externalPostgresAttachment?.attempted === true &&
            externalPostgresAttachment.attached !== false))
      )
        failures.push("external-postgres-cleanup");
      const retainedResources = Object.entries(inventory).flatMap(
        ([kind, resources]) => resources.map((name) => ({ kind, name })),
      );
      if (retainedResources.length) failures.push("retained-resources");
      const complete =
        verified &&
        fixtureRootRemoved &&
        secretsDirRemoved &&
        composeOverrideRemoved &&
        failures.length === 0 &&
        retainedResources.length === 0;
      const cleanup = {
        verified,
        complete,
        failures,
        retainedResources,
        inventory,
        fixtureRootRemoved,
        secretsDirRemoved,
        composeOverrideRemoved,
      };
      if (receipt) receipt.cleanup = cleanup;
      if (!complete)
        standardCleanupError ??= new Error("BROWSER_CLEANUP_FAILED");
    }
  }
  let finalizedExternalCleanup;
  if (externalRecovery) {
    finalizedExternalCleanup = externalRecoveryCleanupSummary({
      databases: externalDatabaseCleanupReceipt,
      attachment: externalPostgresAttachment,
      cleanupFailed: Boolean(standardCleanupError || cleanupHookError),
    });
    if (receipt) {
      receipt.externalCleanup = finalizedExternalCleanup;
      if (receipt.recoveryProof)
        receipt.recoveryProof.externalCleanup = finalizedExternalCleanup;
    }
  }
  const errors = [primaryError, standardCleanupError, cleanupHookError].filter(
    Boolean,
  );
  const observabilityRetained = retainObservabilityResources
    ? {
        runId: launchIdentity?.context.runId,
        projectName,
        composeFile,
        secretsDir,
        browserFixtureRoot,
        databases: externalRunDatabaseResources.map(
          ({ database }) => database.name,
        ),
      }
    : undefined;
  if (options.mutationDisableRollback && errors.length > 0) {
    const cause = primaryError ?? standardCleanupError ?? cleanupHookError;
    const cleanup = rollbackCleanupReceipt ?? {
      verified: false,
      complete: false,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
    };
    const baseRollbackFailure = createRollbackFailureReceipt({
      runId: launchIdentity?.context.runId,
      candidateSha: launchIdentity?.context.candidateSha,
      stage: primaryError ? rollbackStage : "cleanup",
      error: cause,
      cleanup,
      cleanupFailed:
        cleanupFailures.length > 0 ||
        Boolean(standardCleanupError) ||
        Boolean(cleanupHookError),
    });
    const bootstrapFailure =
      primaryError && rollbackStage === "bootstrap"
        ? attachRollbackBootstrapSubstage(
            baseRollbackFailure,
            rollbackBootstrapSubstage,
          )
        : baseRollbackFailure;
    const initialUnknownFailure =
      primaryError &&
      rollbackStage === "initial-unknown" &&
      rollbackInitialUnknownSubstage
        ? attachRollbackInitialUnknownSubstage(
            bootstrapFailure,
            rollbackInitialUnknownSubstage,
            cause?.rollbackInitialUnknownDiagnostic,
          )
        : bootstrapFailure;
    const stageFailure =
      primaryError &&
      rollbackStage === "disabled-reconcile" &&
      rollbackDisabledReconcileSubstage
        ? attachRollbackDisabledReconcileSubstage(
            initialUnknownFailure,
            rollbackDisabledReconcileSubstage,
          )
        : initialUnknownFailure;
    const rollbackFailure = rollbackComposeDiagnostic
      ? { ...stageFailure, operationDiagnostic: rollbackComposeDiagnostic }
      : stageFailure;
    const surfaced =
      errors.length > 1
        ? new AggregateError(errors, "ROLLBACK_RUNTIME_PROOF_FAILED", { cause })
        : errors[0];
    surfaced.rollbackFailure = rollbackFailure;
    throw surfaced;
  }
  if (errors.length > 1) {
    const messages = errors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    const combined = new AggregateError(
      errors,
      `compose-smoke failed: ${messages.join("; cleanup also failed: ")}`,
      {
        cause: primaryError ?? standardCleanupError,
      },
    );
    if (finalizedExternalCleanup)
      combined.externalCleanup = finalizedExternalCleanup;
    if (observabilityRetained)
      combined.observabilityRetained = observabilityRetained;
    throw combined;
  }
  if (errors.length === 1) {
    if (finalizedExternalCleanup)
      errors[0].externalCleanup = finalizedExternalCleanup;
    if (observabilityRetained)
      errors[0].observabilityRetained = observabilityRetained;
    throw errors[0];
  }
  console.log(JSON.stringify(receipt));
  return receipt;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const browserProof = process.argv.slice(2).includes("--browser-proof");
  async function writeBrowserRuntimeArtifact({
    receipt,
    browserEvidence,
    baseCandidateSha,
  }) {
    const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
    if (!contextPath) throw new Error("BROWSER_LAUNCH_CONTEXT_REQUIRED");
    const launch = await validateLaunchContext(contextPath);
    if (launch.candidateRoot !== ROOT || resolve(process.cwd()) !== ROOT)
      throw new Error("BROWSER_CANDIDATE_IDENTITY_INVALID");
    const { context, evidenceDir } = launch;
    const lineageWithPath = await readBrowserFixtureLineage({
      root: ROOT,
      contextPath,
      baseCandidateSha,
    });
    const lineage = { ...lineageWithPath };
    delete lineage.receiptPath;
    const artifact = validateBrowserRuntimeArtifact(
      {
        schemaVersion: 1,
        gateId: "browser",
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        status: "PASS",
        verificationOnly: true,
        productionLogin: false,
        lineage,
        browserEvidence,
        cleanup: receipt.cleanup,
      },
      {
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        lineage: lineageWithPath,
      },
    );
    const artifactsDir = join(evidenceDir, "gates/browser/artifacts");
    for (const path of [
      evidenceDir,
      join(evidenceDir, "gates"),
      join(evidenceDir, "gates/browser"),
      artifactsDir,
    ]) {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error("BROWSER_ARTIFACT_DIRECTORY_INVALID");
    }
    const path = join(artifactsDir, "browser-runtime.json");
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
  }

  const handleTermination = (signal) => {
    rollbackTerminationSignal ??= signal;
  };
  process.once("SIGINT", handleTermination);
  process.once("SIGTERM", handleTermination);
  try {
    const args = process.argv.slice(2);
    if (args.includes("--browser-proof")) {
      if (args.length !== 1 || args[0] !== "--browser-proof")
        throw new Error("--browser-proof must be the only option");
      const baseCandidateSha = execFileSync("git", ["rev-parse", "HEAD^"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      let browserEvidence;
      const receipt = await runComposeSmoke({
        args,
        browser: {
          baseCandidateSha,
          onCleanup: async () => {},
          onReady: async (runtimeContext) => {
            const proof = await proveBrowser(runtimeContext);
            browserEvidence = proof.evidence;
            return proof.callbackProof;
          },
        },
      });
      throwIfRollbackTerminationRequested();
      await writeBrowserRuntimeArtifact({
        receipt,
        browserEvidence,
        baseCandidateSha,
      });
    } else {
      await runComposeSmoke({ args });
      throwIfRollbackTerminationRequested();
    }
  } catch (error) {
    if (browserProof) {
      try {
        const launch = await validateLaunchContext(
          process.env.COFFEE_LAUNCH_CONTEXT_FILE,
        );
        console.log(
          JSON.stringify(
            createBrowserChildFailureDiagnostic({
              runId: launch.context.runId,
              candidateSha: launch.context.candidateSha,
              error,
            }),
          ),
        );
      } catch {
        console.error(
          "compose-smoke: FAIL: _BROWSER_CHILD_DIAGNOSTIC_UNAVAILABLE",
        );
      }
    } else if (error?.rollbackFailure)
      console.log(JSON.stringify(error.rollbackFailure));
    else
      console.error(
        `compose-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`,
      );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", handleTermination);
    process.removeListener("SIGTERM", handleTermination);
  }
}
