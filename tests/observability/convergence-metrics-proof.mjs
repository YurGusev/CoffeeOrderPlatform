import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { load as yaml } from "js-yaml";
import { metrics } from "@opentelemetry/api";
import {
  createDatabase,
  withTransaction,
} from "../../packages/platform-database/dist/index.js";
import { defineStatement } from "../../packages/platform-database/dist/owner.js";
import { createTelemetryResource } from "../../packages/platform-observability/dist/index.js";
import { createSqlInboxStore } from "../../packages/platform-inbox/dist/index.js";
import { createSqlOutboxStore } from "../../packages/platform-outbox/dist/index.js";
import { createKafkaRuntime } from "../../packages/platform-kafka-runtime/dist/index.js";
import { decodeAromaConvergenceEnvelope } from "../../apps/aroma-convergence/dist/application/messages.js";
import { AromaConvergenceTelemetry } from "../../apps/aroma-convergence/dist/telemetry/index.js";
import { createAromaConvergenceStore } from "../../apps/aroma-convergence/dist/infrastructure/convergence-store.js";
import {
  deriveRuntimeDatabaseTarget,
  deriveRuntimeKafkaTarget,
  verifyLaunchConfigBytes,
} from "../../packages/platform-config/dist/index.js";
import { readLaunchDatabaseIdentity } from "../../packages/platform-runtime/dist/index.js";

const PROOF_FILE = "/fixture/aroma-convergence-proof.yaml";
const CONFIG_FILE = "/fixture/platform.yaml";
const METRIC_BARRIER_TIMEOUT_MS = 95000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const delay = (ms) => sleep(ms);

async function readSelector(stream) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk;
    assert.ok(
      Buffer.byteLength(input) <= 4096,
      "bounded convergence proof selector",
    );
  }
  const value = JSON.parse(input);
  assert.equal(value.schemaVersion, 1);
  assert.match(value.wakeMessageId, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(value.rootMessageId, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(
    value.correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.match(value.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/iu);
  assert.match(
    value.metricBarrierId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  return value;
}

function expectedMetricsForBarrier(phase) {
  const common = [
    {
      name: "coffee_aroma_attempt_results_total",
      attributes: { result: "unknown_outcome" },
      value: 1,
    },
    { name: "coffee_aroma_unknown_outcomes_total", attributes: {}, value: 1 },
  ];
  if (phase === "unknown-current")
    return [
      ...common,
      {
        name: "coffee_aroma_unknown_outcomes_current",
        attributes: {},
        value: 1,
      },
    ];
  assert.equal(phase, "recovered-terminal");
  return [
    ...common,
    {
      name: "coffee_aroma_unknown_outcomes_current",
      attributes: {},
      values: [1, 0],
    },
    {
      name: "coffee_aroma_recovery_results_total",
      attributes: { result: "recovered_applied" },
      value: 1,
    },
  ];
}

function metricBarrierPath(barrierId, phase, suffix) {
  assert.match(
    barrierId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.ok(["unknown-current", "recovered-terminal"].includes(phase));
  assert.ok(["checkpoint", "ack"].includes(suffix));
  return `/results/convergence-metric-${barrierId}-${phase}.${suffix}.json`;
}

async function writeAtomicJson(path, value) {
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, JSON.stringify(value) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}

async function waitForMetricBarrier(selector, phase) {
  const barrierId = selector.metricBarrierId,
    checkpointPath = metricBarrierPath(barrierId, phase, "checkpoint");
  const ackPath = metricBarrierPath(barrierId, phase, "ack");
  const expectedMetrics = expectedMetricsForBarrier(phase);
  await writeAtomicJson(checkpointPath, {
    schemaVersion: 1,
    barrierId,
    phase,
    expectedMetrics,
  });
  const deadline = Date.now() + METRIC_BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let acknowledgement;
    try {
      acknowledgement = JSON.parse(await readFile(ackPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw new Error("CONVERGENCE_METRIC_BARRIER_ACK_INVALID");
    }
    if (acknowledgement !== undefined) {
      assert.deepEqual(Object.keys(acknowledgement).sort(), [
        "barrierId",
        "phase",
        "schemaVersion",
        "status",
      ]);
      assert.equal(acknowledgement.schemaVersion, 1);
      assert.equal(acknowledgement.barrierId, barrierId);
      assert.equal(acknowledgement.phase, phase);
      assert.ok(["PASS", "FAIL"].includes(acknowledgement.status));
      assert.equal(
        acknowledgement.status,
        "PASS",
        "parent did not confirm exported owner metric samples",
      );
      return;
    }
    await delay(100);
  }
  throw new Error("CONVERGENCE_METRIC_BARRIER_TIMEOUT");
}

function metricValue(lines, name, label) {
  const prefix =
    label === undefined ? `${name} ` : `${name}{result="${label}"} `;
  const line = lines.find((value) => value.startsWith(prefix));
  return line === undefined ? undefined : Number(line.slice(prefix.length));
}

function snapshot(lines) {
  const canonical = lines
    .map((line) => ({
      offerRef: line.offerRef,
      quantity: line.quantity,
      ...(line.sourceGrindKeyHash === undefined
        ? {}
        : { sourceGrindKeyHash: line.sourceGrindKeyHash }),
    }))
    .sort(
      (left, right) =>
        left.offerRef.localeCompare(right.offerRef) ||
        (left.sourceGrindKeyHash ?? "").localeCompare(
          right.sourceGrindKeyHash ?? "",
        ),
    );
  const fingerprint = sha256(JSON.stringify(canonical));
  return {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${fingerprint}`,
    capturedAt: new Date().toISOString(),
    cartFingerprint: fingerprint,
    lines: canonical,
  };
}

async function readSnapshot(database, statement, parameters = []) {
  return withTransaction(database, { mode: "background" }, async (tx) => {
    const result = await statement(tx, parameters);
    return result.rows;
  });
}

async function waitForMetric(
  telemetry,
  name,
  label,
  expected,
  timeoutMs = 5000,
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = metricValue(telemetry.render(), name, label);
    if (value === expected) return value;
    await delay(20);
  }
  assert.fail(`owner metric ${name} did not reach expected fixture value`);
}

export async function resolveConvergenceTargets({
  configBytes,
  contextPath,
  ownershipPath = "/fixture/database-ownership.json",
}) {
  const config = yaml(configBytes.toString("utf8"), { json: true });
  const service = config.services["aroma-convergence"];
  const isolation = config.verification?.databaseIsolation?.enabled === true;
  assert.equal(
    isolation,
    Boolean(contextPath),
    "convergence proof requires matching launch isolation and context",
  );
  assert.equal(
    isolation,
    config.verification?.kafkaNamespaceIsolation === true,
    "convergence proof requires matching Kafka isolation",
  );
  const launchIdentity = contextPath
    ? await readLaunchDatabaseIdentity(contextPath)
    : undefined;
  if (launchIdentity)
    verifyLaunchConfigBytes({
      actualConfigBytes: configBytes,
      baseConfigSha256: launchIdentity.baseConfigSha256,
      runtime: "aroma-convergence",
      environment: config.environment,
      databaseIsolationEnabled: isolation,
      mutationsEnabled: service.mutationsEnabled,
    });
  const databaseTarget = launchIdentity
    ? deriveRuntimeDatabaseTarget({
        config: {
          environment: config.environment,
          databaseIsolation: config.verification?.databaseIsolation,
          services: config.services,
        },
        runtime: "aroma-convergence",
        ownership: JSON.parse(await readFile(ownershipPath, "utf8")),
        launchIdentity,
      })
    : { database: service.database, allowedDatabase: service.database };
  const physicalTargets = deriveRuntimeKafkaTarget({
    config: config.kafka,
    service: service.kafka,
    enabled: isolation,
    environment: config.environment,
    ...(launchIdentity ? { launchIdentity } : {}),
  });
  return { config, service, databaseTarget, physicalTargets };
}

export async function runConvergenceMetricsProof({
  proofFile = PROOF_FILE,
  configFile = CONFIG_FILE,
  selector,
} = {}) {
  let phase = "scoped-input";
  const proof = JSON.parse(await readFile(proofFile, "utf8"));
  const { config, service, databaseTarget, physicalTargets } =
    await resolveConvergenceTargets({
      configBytes: await readFile(configFile),
      contextPath: process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    });
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.runtime, "aroma-convergence");
  assert.equal(proof.environment, config.environment);
  const credential = proof.secrets?.postgres?.aromaConvergence;
  const kafkaCredential = proof.secrets?.kafka?.orders;
  const exporterToken = proof.secrets?.telemetry?.exporterToken;
  assert.ok(
    selector && typeof selector === "object",
    "actual Kafka wake selector is required",
  );
  assert.equal(selector.schemaVersion, 1);
  assert.match(selector.wakeMessageId, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(selector.rootMessageId, /^[A-Za-z0-9_-]{1,128}$/u);
  assert.match(
    selector.correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.match(selector.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/iu);
  assert.match(
    selector.metricBarrierId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  assert.ok(
    service?.aromaConvergence && service?.dbPool,
    "fixture convergence runtime settings present",
  );
  assert.ok(
    credential &&
      typeof credential.username === "string" &&
      typeof credential.password === "string",
    "scoped fixture DB credential present",
  );
  assert.ok(
    kafkaCredential &&
      typeof kafkaCredential.username === "string" &&
      typeof kafkaCredential.password === "string" &&
      typeof kafkaCredential.caPem === "string",
    "scoped fixture Kafka credential present",
  );
  assert.equal(typeof exporterToken, "string");
  assert.ok(exporterToken.length > 0);

  const database = createDatabase({
    owner: "aroma-convergence",
    database: databaseTarget.database,
    allowedDatabase: databaseTarget.allowedDatabase,
    host: config.postgres.host,
    port: config.postgres.port,
    user: credential.username,
    password: credential.password,
    ssl: config.postgres.sslMode === "prefer" ? "prefer" : true,
    pool: service.dbPool,
    shutdownGraceMs: config.platform.shutdownGraceMs,
  });
  const telemetry = new AromaConvergenceTelemetry();
  const telemetryConfig = {
    ...config.telemetry,
    environment: config.environment,
  };
  assert.equal(telemetryConfig.environment, config.environment);
  const telemetryResource = createTelemetryResource(
    telemetryConfig,
    "aroma-convergence",
    exporterToken,
    () => telemetry.render(),
  );
  const kafka = createKafkaRuntime({
    runtime: "aroma-convergence",
    config: config.kafka,
    service: service.kafka,
    physicalTargets,
    credentials: {
      username: kafkaCredential.username,
      password: kafkaCredential.password,
      caPem: kafkaCredential.caPem,
    },
  });
  const signal = AbortSignal.timeout(30000);
  let databaseStarted = false,
    telemetryStarted = false,
    kafkaStarted = false,
    proofResult,
    proofFailure;
  const cleanupFailures = [];
  try {
    phase = "telemetry-start";
    telemetryResource.start();
    telemetryStarted = true;
    phase = "database-start";
    await database.resource.start(signal);
    databaseStarted = true;
    phase = "prepared-desired-read";
    const desired = defineStatement(
      database,
      `SELECT d.offer_ref,d.quantity_milli::text,d.source_grind_key_hash,
      m.product_ref,m.variant_ref,m.catalog_snapshot_revision::text,m.mapping_revision::text
      FROM orders.cart_desired_revisions r JOIN orders.cart_desired_lines d
        ON d.cart_scope_ref=r.cart_scope_ref AND d.desired_revision=r.desired_revision
      JOIN orders.catalog_mapping_projection m ON m.offer_ref=d.offer_ref
      WHERE r.cart_scope_ref='aroma-primary' AND r.state='Current' AND m.mapping_state='Active' AND m.availability='Available'
      ORDER BY d.offer_ref,d.source_grind_key_hash NULLS FIRST`,
    );
    const desiredRows = await readSnapshot(database, desired);
    assert.equal(
      desiredRows.length,
      1,
      "one real prepared Desired line is ready for synthetic convergence proof",
    );
    const target = desiredRows[0];
    const simulatedCart = [];
    let mutationCalls = 0;
    const gateway = {
      catalogInput: async (productRef, variantRef, context) => {
        context.signal.throwIfAborted();
        assert.equal(productRef, target.product_ref);
        assert.equal(variantRef, target.variant_ref);
        return {
          productRef,
          variantRef,
          offerRef: target.offer_ref,
          snapshotRevision: target.catalog_snapshot_revision,
          supplierUnitMinor: "1",
          currency: "RUB",
          unit: "piece",
          availability: "Available",
          mappingRevision: target.mapping_revision,
          displayName: "Synthetic fixture",
          ...(target.source_grind_key_hash === null
            ? {}
            : {
                grindOptions: [
                  {
                    sourceGrindKeyHash: target.source_grind_key_hash,
                    displayName: "Synthetic grind",
                  },
                ],
              }),
        };
      },
      read: async (context) => {
        context.signal.throwIfAborted();
        return snapshot(simulatedCart);
      },
      setQuantity: async (offerRef, request, context) => {
        context.signal.throwIfAborted();
        mutationCalls++;
        const line = {
          offerRef,
          quantity: request.quantity,
          ...(request.sourceGrindKeyHash === undefined
            ? {}
            : { sourceGrindKeyHash: request.sourceGrindKeyHash }),
        };
        const index = simulatedCart.findIndex(
          (value) =>
            value.offerRef === offerRef &&
            value.sourceGrindKeyHash === request.sourceGrindKeyHash,
        );
        if (index === -1) simulatedCart.push(line);
        else simulatedCart[index] = line;
        throw new Error("controlled synthetic response loss");
      },
      remove: async () => {
        throw new Error("unexpected synthetic removal");
      },
    };
    const serviceOptions = {
      ...service.aromaConvergence,
      ownerInstanceId: randomUUID(),
      mutationsEnabled: true,
      providerDeadlineMs: 1000,
      safetyMarginMs: 50,
      retryBackoffMs: 1,
    };
    const consumer = service.kafka.consumers.find(
      (value) => value.groupId === "aroma-convergence-v1",
    );
    assert.ok(
      consumer &&
        consumer.processing === "durable" &&
        consumer.topics.includes(config.kafka.topics.aromaCommands.name),
      "configured convergence wake consumer is durable",
    );
    const firstStore = createAromaConvergenceStore(
      database,
      serviceOptions,
      telemetry,
    );
    kafka.bind(consumer.groupId, {
      processing: "durable",
      database,
      inbox: createSqlInboxStore(database, {
        schema: "orders",
        consumerName: consumer.groupId,
      }),
      decode: decodeAromaConvergenceEnvelope,
      handle: (tx, envelope, _record, handlerSignal) =>
        firstStore.handleWake(tx, envelope, handlerSignal),
    });
    phase = "kafka-start";
    await kafka.resource.start(signal);
    kafkaStarted = true;
    assert.equal(
      await kafka.readiness.check(signal),
      true,
      "actual convergence consumer is broker-ready",
    );
    const wakeStatement = defineStatement(
      database,
      `SELECT o.message_id,o.message_type,o.topic,o.state,o.correlation_id,o.causation_id,o.traceparent,
      i.state AS inbox_state,i.envelope AS inbox_envelope
      FROM orders.outbox_messages o LEFT JOIN orders.inbox_messages i
        ON i.consumer_name='aroma-convergence-v1' AND i.message_id=o.message_id WHERE o.message_id=$1`,
    );
    phase = "actual-wake-inbox";
    let wakeRow;
    const wakeDeadline = Date.now() + 15000;
    while (Date.now() < wakeDeadline) {
      const rows = await readSnapshot(database, wakeStatement, [
        selector.wakeMessageId,
      ]);
      if (rows[0]?.inbox_state === "Processed") {
        wakeRow = rows[0];
        break;
      }
      await delay(50);
    }
    assert.ok(
      wakeRow,
      "real convergence Kafka consumer commits selected wake in SQL Inbox",
    );
    assert.equal(wakeRow.message_type, "AromaConvergenceRequested.v1");
    assert.equal(wakeRow.topic, config.kafka.topics.aromaCommands.name);
    assert.equal(wakeRow.state, "Published");
    assert.equal(wakeRow.causation_id, selector.rootMessageId);
    assert.equal(wakeRow.correlation_id, selector.correlationId);
    assert.equal(wakeRow.traceparent, selector.traceparent);
    assert.ok(
      wakeRow.inbox_envelope && typeof wakeRow.inbox_envelope === "object",
    );
    assert.equal(wakeRow.inbox_envelope.messageId, selector.wakeMessageId);
    assert.equal(wakeRow.inbox_envelope.causationId, selector.rootMessageId);
    assert.equal(wakeRow.inbox_envelope.correlationId, selector.correlationId);
    assert.equal(wakeRow.inbox_envelope.traceparent, selector.traceparent);
    const wakeReceipt = {
      messageType: wakeRow.message_type,
      topic: wakeRow.topic,
      outboxState: wakeRow.state,
      inboxState: wakeRow.inbox_state,
      messageIdSha256: sha256(wakeRow.message_id),
      rootCausationSha256: sha256(wakeRow.causation_id),
      correlationMatched: true,
      traceparentMatched: true,
    };
    const firstOwnerPhaseSignal = AbortSignal.timeout(15000);
    const resultTopic = config.kafka.topics.aromaEvents.name;
    const resultEventsStatement = defineStatement(
      database,
      `SELECT message_id,message_type,topic,state,correlation_id,causation_id,traceparent,published_at
      FROM orders.outbox_messages WHERE causation_id=$1 AND correlation_id=$2
        AND message_type IN ('AromaConvergenceChanged.v1','AromaObservationChanged.v1')
      ORDER BY occurred_at,message_id`,
    );
    const resultOutbox = createSqlOutboxStore(database, {
      schema: "orders",
      envelopeBytes: true,
      topics: [resultTopic],
    });
    const relayWakeEvents = async (phaseSignal) => {
      const totals = {
        claimed: 0,
        published: 0,
        failed: 0,
        unknown: 0,
        quarantined: 0,
      };
      let rows = [];
      for (let cycle = 0; cycle < 100; cycle++) {
        const batch = await kafka.relay(resultOutbox, database, phaseSignal);
        for (const key of Object.keys(totals)) totals[key] += batch[key];
        assert.equal(
          batch.failed,
          0,
          "actual convergence Outbox relay has no failed records",
        );
        assert.equal(
          batch.unknown,
          0,
          "actual convergence Outbox relay has no unknown acknowledgements",
        );
        assert.equal(
          batch.quarantined,
          0,
          "actual convergence Outbox relay has no quarantined records",
        );
        rows = await readSnapshot(database, resultEventsStatement, [
          wakeRow.message_id,
          selector.correlationId,
        ]);
        if (rows.length > 0 && rows.every((row) => row.state === "Published"))
          return { rows, totals };
        await delay(25);
      }
      assert.fail(
        "actual convergence result Outbox was not acknowledged by Kafka",
      );
    };
    phase = "unknown-outcome-attempt";
    assert.equal(
      await firstStore.runOnce(gateway, firstOwnerPhaseSignal),
      "attempted",
    );
    assert.equal(
      mutationCalls,
      1,
      "controlled Gateway loses exactly one response after applying the synthetic cart change",
    );
    phase = "unknown-outcome-kafka-relay";
    const firstRelay = await relayWakeEvents(firstOwnerPhaseSignal);
    assert.ok(
      firstRelay.rows.some(
        (row) => row.message_type === "AromaConvergenceChanged.v1",
      ),
      "unknown-outcome result is published through actual Kafka",
    );

    const facts = defineStatement(
      database,
      `SELECT a.state AS attempt_state,r.state AS reservation_state
      FROM orders.convergence_attempts a LEFT JOIN orders.mutation_reservations r ON r.attempt_ref=a.attempt_ref
      ORDER BY a.started_at,a.attempt_ref`,
    );
    const firstFacts = await readSnapshot(database, facts);
    assert.equal(firstFacts.length, 1);
    assert.equal(firstFacts[0].attempt_state, "UnknownOutcome");
    assert.equal(firstFacts[0].reservation_state, "UnknownOutcome");
    phase = "unknown-outcome-metric-window";
    await waitForMetric(
      telemetry,
      "coffee_aroma_unknown_outcomes_current",
      undefined,
      1,
    );
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_attempt_results_total",
        "unknown_outcome",
      ),
      1,
    );
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_unknown_outcomes_total",
        undefined,
      ),
      1,
    );

    // Allow the existing PeriodicExportingMetricReader to export the real unresolved gauge before recovery.
    await delay(telemetryConfig.producer.batchIntervalMs + 100);
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_unknown_outcomes_current",
        undefined,
      ),
      1,
    );
    await metrics
      .getMeterProvider()
      .forceFlush({ timeoutMillis: telemetryConfig.producer.flushTimeoutMs });
    phase = "unknown-outcome-metric-export-barrier";
    await waitForMetricBarrier(selector, "unknown-current");
    const reservationWindow = defineStatement(
      database,
      "SELECT bool_and(reserved_until<=clock_timestamp()) AS ended FROM orders.mutation_reservations WHERE state='UnknownOutcome'",
    );
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await readSnapshot(database, reservationWindow))[0]?.ended === true)
        break;
      await delay(20);
    }
    assert.equal(
      (await readSnapshot(database, reservationWindow))[0]?.ended,
      true,
      "actual reservation safety window elapsed before reconciliation",
    );

    phase = "owner-recovery";
    const recoveryPhaseSignal = AbortSignal.timeout(15000);
    const recoveryStore = createAromaConvergenceStore(
      database,
      { ...serviceOptions, ownerInstanceId: randomUUID() },
      telemetry,
    );
    assert.equal(
      await recoveryStore.runOnce(gateway, recoveryPhaseSignal),
      "attempted",
    );
    assert.equal(
      mutationCalls,
      1,
      "recovery observes the applied synthetic mutation without repeating it",
    );
    await waitForMetric(
      telemetry,
      "coffee_aroma_unknown_outcomes_current",
      undefined,
      0,
    );
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_unknown_outcomes_total",
        undefined,
      ),
      1,
    );
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_recovery_results_total",
        "recovered_applied",
      ),
      1,
    );
    phase = "recovered-result-kafka-relay";
    const finalRelay = await relayWakeEvents(recoveryPhaseSignal);
    const resultRows = finalRelay.rows.filter(
      (row) => row.message_type === "AromaConvergenceChanged.v1",
    );
    assert.ok(
      resultRows.length >= 2,
      "unknown-outcome and recovered terminal results are committed to the real owner Outbox",
    );
    assert.ok(
      resultRows.some(
        (row) =>
          row.causation_id === wakeRow.message_id &&
          row.correlation_id === selector.correlationId &&
          row.traceparent === selector.traceparent,
      ),
    );
    assert.ok(
      finalRelay.rows.every(
        (row) =>
          row.topic === resultTopic &&
          row.state === "Published" &&
          row.causation_id === wakeRow.message_id &&
          row.correlation_id === selector.correlationId &&
          row.traceparent === selector.traceparent,
      ),
    );
    const finalFacts = await readSnapshot(database, facts);
    assert.deepEqual(
      finalFacts.map((row) => row.attempt_state),
      ["UnknownOutcome", "NoOpInSync"],
    );
    assert.deepEqual(
      finalFacts.map((row) => row.reservation_state),
      ["RecoveredApplied", null],
    );
    await delay(telemetryConfig.producer.batchIntervalMs + 100);
    await metrics
      .getMeterProvider()
      .forceFlush({ timeoutMillis: telemetryConfig.producer.flushTimeoutMs });
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_unknown_outcomes_current",
        undefined,
      ),
      0,
    );
    assert.equal(
      metricValue(
        telemetry.render(),
        "coffee_aroma_recovery_results_total",
        "recovered_applied",
      ),
      1,
    );
    phase = "recovered-metric-export-barrier";
    await waitForMetricBarrier(selector, "recovered-terminal");

    proofResult = {
      verified: true,
      owner: "aroma-convergence",
      attemptStates: finalFacts.map((row) => row.attempt_state),
      reservationRecovery: "RecoveredApplied",
      unknownOutcomeTerminalCount: 1,
      unknownOutcomeCounter: 1,
      unknownOutcomesCurrent: [1, 0],
      recoveredAppliedCounter: 1,
      controlledGatewayMutationCalls: mutationCalls,
      externalProviderUsed: false,
      periodicMetricWindowElapsed: true,
      wakeReceipt,
      resultRelayReceipt: {
        topic: resultTopic,
        consumerGroup: consumer.groupId,
        wakeMessageIdSha256: wakeReceipt.messageIdSha256,
        resultMessages: finalRelay.rows.map((row) => ({
          messageType: row.message_type,
          state: row.state,
          messageIdSha256: sha256(row.message_id),
          causationIdSha256: sha256(row.causation_id),
          correlationMatched: row.correlation_id === selector.correlationId,
          traceparentMatched: row.traceparent === selector.traceparent,
        })),
        kafkaRelayPublishedCount:
          firstRelay.totals.published + finalRelay.totals.published,
        selectedOutboxPublishedCount: finalRelay.rows.length,
        allSelectedMessagesPublished: true,
      },
      expectedTelemetry: {
        ownerMetrics: expectedMetricsForBarrier("recovered-terminal"),
      },
    };
  } catch {
    proofFailure = Object.assign(
      new Error("CONVERGENCE_METRICS_PROOF_FAILED"),
      { proofPhase: phase },
    );
  } finally {
    phase = "resource-stop";
    try {
      if (kafkaStarted) await kafka.resource.stop(AbortSignal.timeout(10000));
      else kafka.resource.destroy();
    } catch {
      cleanupFailures.push("kafka-stop");
    }
    try {
      if (databaseStarted)
        await database.resource.stop(AbortSignal.timeout(5000));
      else database.resource.destroy();
    } catch {
      cleanupFailures.push("database-stop");
    }
    try {
      if (telemetryStarted)
        await telemetryResource.stop(AbortSignal.timeout(5000));
      else telemetryResource.destroy();
    } catch {
      cleanupFailures.push("telemetry-stop");
    }
  }
  if (proofFailure) {
    if (cleanupFailures.length) proofFailure.cleanupFailed = true;
    throw proofFailure;
  }
  if (cleanupFailures.length)
    throw Object.assign(new Error("CONVERGENCE_METRICS_PROOF_CLEANUP_FAILED"), {
      proofPhase: "resource-stop",
    });
  return proofResult;
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(
        await runConvergenceMetricsProof({
          selector: await readSelector(process.stdin),
        }),
      ),
    );
  } catch (error) {
    const stages = [
      "scoped-input",
      "telemetry-start",
      "database-start",
      "prepared-desired-read",
      "kafka-start",
      "actual-wake-inbox",
      "unknown-outcome-attempt",
      "unknown-outcome-kafka-relay",
      "unknown-outcome-metric-window",
      "unknown-outcome-metric-export-barrier",
      "owner-recovery",
      "recovered-result-kafka-relay",
      "recovered-metric-export-barrier",
      "resource-stop",
    ];
    const stage =
      error !== null &&
      typeof error === "object" &&
      "proofPhase" in error &&
      stages.includes(error.proofPhase)
        ? error.proofPhase
        : "unknown";
    const cleanupFailed =
      error !== null &&
      typeof error === "object" &&
      error.cleanupFailed === true;
    console.error(
      JSON.stringify({
        verified: false,
        code: "CONVERGENCE_METRICS_PROOF_FAILED",
        stage,
        ...(cleanupFailed ? { cleanupCode: "RESOURCE_STOP_FAILED" } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
