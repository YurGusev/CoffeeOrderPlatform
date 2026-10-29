import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { load as parseYaml } from "js-yaml";
import { canonicalRequestHash } from "../packages/platform-idempotency/dist/index.js";
import pg from "pg";
import {
  createDatabase,
  withTransaction,
} from "../packages/platform-database/dist/index.js";
import { defineStatement } from "../packages/platform-database/dist/owner.js";
import { OfferBindingStore } from "../apps/aroma-gateway/dist/infrastructure/database/offer-binding-store.js";
import { OrderStore } from "../apps/orders-service/dist/infrastructure/database/order-store.js";
import { createSourceIdentity } from "../apps/aroma-gateway/dist/domain/source-identity.js";

const { Client } = pg;
const COUNT_SQL = `SELECT
  (SELECT count(*)::text FROM orders.convergence_attempts) AS attempts,
  (SELECT count(*)::text FROM orders.mutation_reservations) AS reservations,
  (SELECT count(*)::text FROM orders.cart_desired_revisions) AS desired,
  (SELECT count(*)::text FROM orders.cart_observed_revisions) AS observed,
  (SELECT count(*)::text FROM orders.inbox_messages) AS inbox,
  (SELECT count(*)::text FROM orders.outbox_messages) AS outbox`;
const GUARDED_CARD_FACTS_SQL = `WITH snapshot AS MATERIALIZED (
  SELECT clock_timestamp() AS captured_at
)
SELECT
  CASE
    WHEN projection.state IS NULL THEN 'Missing'
    WHEN projection.state IN ('PendingObservation','Converging','InSync','OutOfSync','Blocked','UnknownOutcome') THEN projection.state
    ELSE 'Other'
  END AS projection_state,
  COALESCE(core.order_ref IS NOT NULL, false) AS order_present,
  COALESCE(projection.order_ref IS NOT NULL, false) AS projection_present,
  COALESCE(desired.desired_revision IS NOT NULL, false) AS current_desired_present,
  COALESCE(observed.observed_revision IS NOT NULL, false) AS current_observed_present,
  COALESCE(attempt.attempt_ref IS NOT NULL, false) AS proof_attempt_present,
  COALESCE(lease.cart_scope_ref IS NOT NULL, false) AS lease_present,
  COALESCE(desired.desired_revision = projection.verified_desired_revision
    AND desired.desired_hash = projection.verified_desired_hash, false) AS desired_proof_matches,
  COALESCE(observed.observed_revision = projection.verified_observed_revision
    AND observed.cart_fingerprint = projection.verified_cart_fingerprint, false) AS observed_proof_matches,
  COALESCE(observed.complete, false) AS observation_complete,
  COALESCE(observed.captured_at <= snapshot.captured_at, false) AS observation_not_future,
  COALESCE(observed.captured_at >= snapshot.captured_at - $2::integer * interval '1 millisecond', false) AS observation_fresh,
  COALESCE($2::integer > 0, false) AS freshness_enabled,
  COALESCE(attempt.state IN ('NoOpInSync','VerifiedInSync'), false) AS attempt_successful,
  COALESCE(attempt.attempt_ref = projection.attempt_ref
    AND projection.verified_attempt_ref = projection.attempt_ref, false) AS attempt_matches_projection,
  COALESCE(attempt.desired_revision = desired.desired_revision
    AND attempt.desired_hash = desired.desired_hash, false) AS attempt_matches_desired,
  COALESCE(CASE WHEN attempt.state = 'NoOpInSync'
    THEN attempt.observed_start_revision = observed.observed_revision
    ELSE attempt.observed_end_revision = observed.observed_revision END, false) AS attempt_matches_observed,
  COALESCE(attempt.fence_epoch = projection.fence_epoch
    AND lease.fence_epoch = attempt.fence_epoch, false) AS fence_matches,
  COALESCE(lease.owner_instance_id = attempt.owner_instance_id, false) AS lease_owner_matches,
  COALESCE(lease.expires_at > snapshot.captured_at, false) AS lease_active,
  COALESCE(EXISTS (
    SELECT 1 FROM orders.mutation_reservations AS reservation
    WHERE reservation.cart_scope_ref = 'aroma-primary' AND reservation.state = 'UnknownOutcome'
  ), false) AS unknown_outcome_present,
  COALESCE(EXISTS (
    SELECT 1 FROM orders.mutation_reservations AS reservation
    WHERE reservation.cart_scope_ref = 'aroma-primary'
      AND reservation.state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome')
  ), false) AS unresolved_reservation_present,
  COALESCE(EXISTS (
    SELECT 1 FROM orders.cart_desired_order_facts AS facts
    JOIN orders.order_desired_contributions AS contribution
      ON contribution.order_ref = facts.order_ref
      AND contribution.contribution_revision = facts.contribution_revision
      AND contribution.state = 'Current'
    WHERE facts.cart_scope_ref = 'aroma-primary'
      AND facts.desired_revision = desired.desired_revision
      AND facts.order_ref = core.order_ref
  ), false) AS current_contribution_matches,
  COALESCE(EXISTS (
    SELECT 1 FROM orders.cart_desired_blockers AS blocker
    WHERE blocker.cart_scope_ref = 'aroma-primary'
      AND blocker.desired_revision = desired.desired_revision
      AND blocker.order_ref = core.order_ref
  ), false) AS order_blockers_present,
  COALESCE(NOT EXISTS (
    SELECT 1
    FROM (
      SELECT offer_ref, source_grind_key_hash, quantity_milli
      FROM orders.cart_desired_lines
      WHERE cart_scope_ref = 'aroma-primary' AND desired_revision = desired.desired_revision
    ) AS desired_line
    FULL JOIN (
      SELECT offer_ref, source_grind_key_hash, quantity_milli
      FROM orders.cart_observed_lines
      WHERE cart_scope_ref = 'aroma-primary' AND observed_revision = observed.observed_revision
    ) AS observed_line
      ON desired_line.offer_ref = observed_line.offer_ref
      AND desired_line.source_grind_key_hash IS NOT DISTINCT FROM observed_line.source_grind_key_hash
    WHERE desired_line.quantity_milli IS DISTINCT FROM observed_line.quantity_milli
  ), false) AS exact_lines_match,
  COALESCE(latest_attempt.attempt_ref IS NOT NULL, false) AS latest_attempt_present,
  COALESCE(latest_attempt.state IN ('NoOpInSync','VerifiedInSync'), false) AS latest_attempt_successful,
  COALESCE(latest_attempt.desired_revision = desired.desired_revision
    AND latest_attempt.desired_hash = desired.desired_hash, false) AS latest_attempt_matches_desired,
  COALESCE(CASE WHEN latest_attempt.state = 'NoOpInSync'
    THEN latest_attempt.observed_start_revision
    ELSE latest_attempt.observed_end_revision END = observed.observed_revision, false) AS latest_attempt_matches_observed_revision,
  COALESCE(latest_attempt_observation.cart_fingerprint = observed.cart_fingerprint, false) AS latest_attempt_observed_fingerprint_matches_current,
  COALESCE(latest_attempt.fence_epoch = lease.fence_epoch, false) AS latest_attempt_fence_matches_lease,
  COALESCE(latest_attempt.owner_instance_id = lease.owner_instance_id, false) AS latest_attempt_owner_matches_lease
FROM (SELECT $1::varchar(30) AS order_ref) AS requested
CROSS JOIN snapshot
LEFT JOIN orders.orders AS core ON core.order_ref = requested.order_ref
LEFT JOIN orders.order_aroma_projections AS projection ON projection.order_ref = core.order_ref
LEFT JOIN orders.cart_desired_revisions AS desired
  ON desired.cart_scope_ref = 'aroma-primary' AND desired.state = 'Current'
LEFT JOIN orders.cart_observed_revisions AS observed
  ON observed.cart_scope_ref = 'aroma-primary' AND observed.state = 'Current'
LEFT JOIN orders.convergence_attempts AS attempt
  ON attempt.attempt_ref = projection.verified_attempt_ref
LEFT JOIN orders.convergence_leases AS lease ON lease.cart_scope_ref = 'aroma-primary'
LEFT JOIN LATERAL (
  SELECT attempt.attempt_ref,attempt.desired_revision,attempt.desired_hash,attempt.fence_epoch,
    attempt.state,attempt.owner_instance_id,attempt.observed_start_revision,attempt.observed_end_revision
  FROM orders.convergence_attempts AS attempt
  WHERE attempt.cart_scope_ref='aroma-primary' AND attempt.desired_revision=desired.desired_revision
  ORDER BY attempt.fence_epoch DESC,attempt.started_at DESC,attempt.attempt_ref DESC
  LIMIT 1
) AS latest_attempt ON true
LEFT JOIN orders.cart_observed_revisions AS latest_attempt_observation
  ON latest_attempt_observation.cart_scope_ref='aroma-primary'
  AND latest_attempt_observation.observed_revision = CASE WHEN latest_attempt.state='NoOpInSync'
    THEN latest_attempt.observed_start_revision ELSE latest_attempt.observed_end_revision END`;
const GUARDED_CARD_PROJECTION_STATES = new Set([
  "PendingObservation",
  "Converging",
  "InSync",
  "OutOfSync",
  "Blocked",
  "UnknownOutcome",
]);

function canonicalHash(value) {
  try {
    return canonicalRequestHash(value);
  } catch {
    return undefined;
  }
}

function outboxEnvelopeHashesMatch(row, envelope) {
  const envelopeHash = canonicalHash(envelope);
  return (
    envelopeHash !== undefined &&
    row.envelope_hash === envelopeHash &&
    row.payload_hash === envelopeHash
  );
}

function inboxEnvelopeHashesMatch(row, envelope) {
  const envelopeHash = canonicalHash(envelope);
  const payloadHash = canonicalHash(envelope?.payload);
  return (
    envelopeHash !== undefined &&
    payloadHash !== undefined &&
    row.envelope_hash === envelopeHash &&
    row.payload_hash === payloadHash
  );
}

export function shouldLoseFirstRollbackSetQuantityResponse(putCount, payload) {
  return putCount === 1 && payload?.quantity === 1;
}

export function applyRollbackArmedCartDrift({
  rollbackMode,
  faultArmed,
  driftApplied,
  cart,
}) {
  if (driftApplied) return true;
  if (!rollbackMode || !faultArmed) return false;
  if (
    !Array.isArray(cart?.products) ||
    cart.products.length !== 1 ||
    cart.products[0]?.quantity !== 1
  ) {
    throw new Error("G18_FAULT_CART_BASELINE_INVALID");
  }
  cart.products[0].quantity = 2;
  return true;
}

export function assertRollbackFixtureBaseline(baseline) {
  assert.ok(
    baseline && baseline.counts && Array.isArray(baseline.attempts),
    "G18 pre-runtime baseline is missing",
  );
  assert.equal(
    baseline.attempts.length,
    0,
    "G18 owner fixture began with convergence attempts",
  );
  assert.equal(
    baseline.reservations.length,
    0,
    "G18 owner fixture began with mutation reservations",
  );
  assert.equal(
    baseline.gatewayRows.length,
    0,
    "G18 owner fixture began with Gateway journal rows",
  );
  return true;
}

function inspectRollbackWakeDelivery(
  wake,
  wakeInbox,
  desiredRevision,
  consumerName,
) {
  const envelope = wake?.envelope;
  const payload = wake?.payload;
  const version = wake?.owner_version;
  const canonical =
    wake?.message_type === "AromaConvergenceRequested.v1" &&
    wake.state === "Published" &&
    wake.topic === "coffee.aroma.cart.commands.v1" &&
    wake.aggregate_ref === "aroma-primary" &&
    wake.partition_key === "aroma-primary" &&
    wake.schema_version === "1" &&
    typeof wake.message_id === "string" &&
    wake.message_id !== "" &&
    typeof wake.aggregate_sequence === "string" &&
    /^\d+$/u.test(wake.aggregate_sequence) &&
    wake.aggregate_sequence !== "0" &&
    version === wake.aggregate_sequence &&
    typeof wake.envelope_hash === "string" &&
    /^[0-9a-f]{64}$/u.test(wake.envelope_hash) &&
    typeof wake.payload_hash === "string" &&
    /^[0-9a-f]{64}$/u.test(wake.payload_hash) &&
    outboxEnvelopeHashesMatch(wake, envelope) &&
    typeof wake.correlation_id === "string" &&
    wake.correlation_id !== "" &&
    (wake.causation_id === null ||
      (typeof wake.causation_id === "string" && wake.causation_id !== "")) &&
    envelope?.envelopeVersion === "1" &&
    envelope.messageId === wake.message_id &&
    envelope.messageType === wake.message_type &&
    envelope.producer === "orders-aroma-preparation" &&
    envelope.correlationId === wake.correlation_id &&
    envelope.causationId === wake.causation_id &&
    envelope.aggregate?.type === "AromaCart" &&
    envelope.aggregate.ref === "aroma-primary" &&
    envelope.aggregate.version === version &&
    payload?.cartScopeRef === "aroma-primary" &&
    payload.desiredRevision === desiredRevision &&
    ["Recovery", "OrderConfirmed", "OperatorRequested"].includes(
      payload.reason,
    ) &&
    isDeepStrictEqual(envelope.payload, payload);
  const inboxProcessed =
    canonical &&
    Array.isArray(wakeInbox) &&
    wakeInbox.some(
      (delivery) =>
        delivery.consumer_name === consumerName &&
        delivery.message_id === wake.message_id &&
        delivery.message_type === wake.message_type &&
        delivery.partition_key === wake.partition_key &&
        delivery.schema_version === wake.schema_version &&
        delivery.owner_version === version &&
        delivery.state === "Processed" &&
        isDeepStrictEqual(delivery.envelope, envelope) &&
        inboxEnvelopeHashesMatch(delivery, envelope),
    );
  return { canonical, inboxProcessed };
}

/** Require one durable, canonical cart wake and its exact processed convergence Inbox delivery. */
export function hasProcessedRollbackWakeForDesiredRevision({
  wakes,
  wakeInbox,
  desiredRevision,
  consumerName,
}) {
  if (
    !Array.isArray(wakes) ||
    !Array.isArray(wakeInbox) ||
    typeof desiredRevision !== "string" ||
    !/^\d+$/u.test(desiredRevision) ||
    typeof consumerName !== "string" ||
    consumerName === ""
  )
    return false;
  return wakes.some((wake) => {
    const proof = inspectRollbackWakeDelivery(
      wake,
      wakeInbox,
      desiredRevision,
      consumerName,
    );
    return proof.canonical && proof.inboxProcessed;
  });
}

function isCanonicalPublishedRollbackIntent(intent, correlationId, orderRef) {
  const envelope = intent?.envelope;
  const payload = intent?.payload;
  const version = intent?.owner_version;
  return (
    intent?.message_type === "OrderReconciliationRequested.v1" &&
    intent.state === "Published" &&
    intent.topic === "coffee.orders.lifecycle.v1" &&
    intent.aggregate_ref === orderRef &&
    intent.partition_key === orderRef &&
    intent.schema_version === "1" &&
    intent.correlation_id === correlationId &&
    intent.causation_id === null &&
    typeof intent.message_id === "string" &&
    intent.message_id !== "" &&
    typeof intent.aggregate_sequence === "string" &&
    /^\d+$/u.test(intent.aggregate_sequence) &&
    intent.aggregate_sequence !== "0" &&
    typeof version === "string" &&
    /^\d+$/u.test(version) &&
    version !== "0" &&
    typeof intent.envelope_hash === "string" &&
    /^[0-9a-f]{64}$/u.test(intent.envelope_hash) &&
    typeof intent.payload_hash === "string" &&
    /^[0-9a-f]{64}$/u.test(intent.payload_hash) &&
    outboxEnvelopeHashesMatch(intent, envelope) &&
    envelope?.envelopeVersion === "1" &&
    envelope.messageId === intent.message_id &&
    envelope.messageType === intent.message_type &&
    envelope.producer === "orders-service" &&
    envelope.correlationId === correlationId &&
    envelope.causationId === null &&
    envelope.aggregate?.type === "Order" &&
    envelope.aggregate.ref === orderRef &&
    envelope.aggregate.version === version &&
    payload?.orderRef === orderRef &&
    payload.orderVersion === version &&
    typeof payload.requestedAt === "string" &&
    payload.requestedAt !== "" &&
    isDeepStrictEqual(envelope.payload, payload)
  );
}

function hasProcessedRollbackPreparationInbox(intent, inboxRows) {
  const version = intent.owner_version;
  const envelope = intent.envelope;
  return inboxRows.some(
    (delivery) =>
      delivery.consumer_name === "orders-aroma-preparation-v1" &&
      delivery.message_id === intent.message_id &&
      delivery.message_type === intent.message_type &&
      delivery.partition_key === intent.partition_key &&
      delivery.schema_version === intent.schema_version &&
      delivery.owner_version === version &&
      delivery.state === "Processed" &&
      isDeepStrictEqual(delivery.envelope, envelope) &&
      inboxEnvelopeHashesMatch(delivery, envelope),
  );
}

/** Return safe proof stages for the same strict intent→wake→Inbox predicate. */
export function inspectProcessedRollbackOperatorWake({
  ordersOutbox,
  inboxRows,
  wakes,
  wakeInbox,
  correlationId,
  desiredRevision,
  orderRef,
  consumerName,
}) {
  const stages = {
    matchedIntentForCorrelation: false,
    canonicalPublishedIntent: false,
    exactPreparationInboxProcessed: false,
    causationLinkedWake: false,
    correlationRevisionReasonMatched: false,
    canonicalWake: false,
    exactConvergenceInboxProcessed: false,
    operatorWakeProcessed: false,
  };
  if (
    !Array.isArray(ordersOutbox) ||
    !Array.isArray(inboxRows) ||
    !Array.isArray(wakes) ||
    !Array.isArray(wakeInbox) ||
    typeof correlationId !== "string" ||
    correlationId === "" ||
    typeof orderRef !== "string" ||
    orderRef === "" ||
    typeof desiredRevision !== "string" ||
    !/^\d+$/u.test(desiredRevision) ||
    typeof consumerName !== "string" ||
    consumerName === ""
  )
    return stages;

  for (const intent of ordersOutbox) {
    if (
      intent?.message_type !== "OrderReconciliationRequested.v1" ||
      intent.correlation_id !== correlationId ||
      intent.aggregate_ref !== orderRef
    )
      continue;
    stages.matchedIntentForCorrelation = true;
    if (!isCanonicalPublishedRollbackIntent(intent, correlationId, orderRef))
      continue;
    stages.canonicalPublishedIntent = true;
    if (!hasProcessedRollbackPreparationInbox(intent, inboxRows)) continue;
    stages.exactPreparationInboxProcessed = true;
    for (const wake of wakes) {
      if (wake?.causation_id !== intent.message_id) continue;
      stages.causationLinkedWake = true;
      if (
        wake.correlation_id !== correlationId ||
        wake.payload?.desiredRevision !== desiredRevision ||
        wake.payload?.reason !== "OperatorRequested"
      )
        continue;
      stages.correlationRevisionReasonMatched = true;
      const proof = inspectRollbackWakeDelivery(
        wake,
        wakeInbox,
        desiredRevision,
        consumerName,
      );
      stages.canonicalWake ||= proof.canonical;
      stages.exactConvergenceInboxProcessed ||=
        proof.canonical && proof.inboxProcessed;
      if (proof.canonical && proof.inboxProcessed)
        stages.operatorWakeProcessed = true;
    }
  }
  return stages;
}

/** Tie a processed cart wake to the real accepted Orders reconciliation command. */
export function hasProcessedRollbackOperatorWake(input) {
  return inspectProcessedRollbackOperatorWake(input).operatorWakeProcessed;
}

const immutable = {
  attempts: [
    "attempt_ref",
    "cart_scope_ref",
    "desired_revision",
    "desired_hash",
    "owner_instance_id",
    "fence_epoch",
    "started_at",
  ],
  desired: [
    "cart_scope_ref",
    "desired_revision",
    "desired_hash",
    "source_max_order_version",
    "created_at",
  ],
  observed: [
    "cart_scope_ref",
    "observed_revision",
    "provider_snapshot_ref",
    "cart_fingerprint",
    "captured_at",
    "saved_at",
    "source_kind",
    "source_attempt_ref",
    "fence_epoch",
    "complete",
  ],
  inbox: [
    "consumer_name",
    "message_id",
    "message_type",
    "partition_key",
    "schema_version",
    "owner_version",
    "payload_hash",
    "envelope_hash",
    "envelope",
    "received_at",
  ],
  outbox: [
    "message_id",
    "message_type",
    "topic",
    "aggregate_ref",
    "aggregate_sequence",
    "owner_version",
    "partition_key",
    "schema_version",
    "envelope_hash",
    "payload_hash",
    "correlation_id",
    "causation_id",
    "traceparent",
    "occurred_at",
  ],
  reservations: [
    "operation_ref",
    "attempt_ref",
    "action",
    "offer_ref",
    "observed_before_milli",
    "desired_milli",
  ],
  gateway: [
    "operation_ref",
    "operation_kind",
    "offer_ref",
    "request_hash",
    "created_at",
  ],
};

export function assertRollbackHistoryPreserved(before, after) {
  for (const [collection, fields] of Object.entries(immutable)) {
    const keyFields =
      collection === "desired"
        ? ["cart_scope_ref", "desired_revision"]
        : collection === "observed"
          ? ["cart_scope_ref", "observed_revision"]
          : collection === "inbox"
            ? ["consumer_name", "message_id"]
            : [fields[0]];
    const keyOf = (row) => JSON.stringify(keyFields.map((field) => row[field]));
    const currentById = new Map(
      (after[collection] ?? []).map((row) => [keyOf(row), row]),
    );
    for (const prior of before[collection] ?? []) {
      const current = currentById.get(keyOf(prior));
      assert.ok(
        current,
        `G18 ${collection} history dropped a previously observed row`,
      );
      if (
        !isDeepStrictEqual(
          fields.map((field) => current[field]),
          fields.map((field) => prior[field]),
        )
      ) {
        throw new Error(`G18 ${collection} immutable history changed`);
      }
    }
  }
  return true;
}

export function rollbackHistoryDigest(facts) {
  const safe = {};
  for (const [collection, fields] of Object.entries(immutable)) {
    safe[collection] = (facts[collection] ?? [])
      .map((row) =>
        Object.fromEntries(fields.map((field) => [field, row[field]])),
      )
      .map((row) => sha(JSON.stringify(row)))
      .sort();
  }
  return sha(JSON.stringify(safe));
}

function dbOptions(runtime, platformConfig, port, credential) {
  const service = platformConfig.services[runtime];
  assert.ok(
    service?.database && credential?.username && credential?.password,
    `${runtime} owner DB fixture inputs missing`,
  );
  return {
    owner: runtime,
    database: service.database,
    allowedDatabase: service.database,
    host: "127.0.0.1",
    port,
    user: credential.username,
    password: credential.password,
    ssl: false,
    pool: service.dbPool,
    shutdownGraceMs: 30_000,
  };
}

const ref = (prefix, value = 1) =>
  `${prefix}_${String(value).padStart(26, "0")}`;
const sha = (value) =>
  createHash("sha256").update(String(value), "utf8").digest("hex");

/** Fixture setup uses owner APIs/owner-scoped SQL only; runtime events are generated later by the real stack. */
export async function seedRollbackOrder({
  port,
  credentials,
  platformConfig,
  secretsDir,
}) {
  const gatewayDb = createDatabase(
    dbOptions(
      "aroma-gateway",
      platformConfig,
      port,
      credentials.databaseCredentialsByRuntime["aroma-gateway"],
    ),
  );
  const prepDb = createDatabase(
    dbOptions(
      "orders-aroma-preparation",
      platformConfig,
      port,
      credentials.databaseCredentialsByRuntime["orders-aroma-preparation"],
    ),
  );
  const ordersDb = createDatabase(
    dbOptions(
      "orders-service",
      platformConfig,
      port,
      credentials.databaseCredentialsByRuntime["orders-service"],
    ),
  );
  const databases = [gatewayDb, prepDb, ordersDb];
  try {
    for (const database of databases)
      await database.resource.start(AbortSignal.timeout(10_000));
    const scopedGateway = parseYaml(
      await readFile(join(secretsDir, "aroma-gateway.yaml"), "utf8"),
      { json: true },
    );
    const sourceIdentityKey = Buffer.from(
      scopedGateway.secrets.aroma.catalogIdentityKeyV1,
      "utf8",
    );
    const supplierRef = "sup_00000000000000000000000001";
    const snapshotRef = `snp_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 26)
      .toUpperCase()
      .replaceAll(/[ILOU]/gu, "A")}`;
    const offerRef = "off_00000000000000000000000001";
    const sourceGrindKeyHash = createSourceIdentity({
      supplierRef,
      entityType: "grind",
      rawProviderIdentifier: "1",
      sourceIdentityKey,
    }).sourceIdentityHash;
    const bindingStore = new OfferBindingStore(gatewayDb);
    await bindingStore.beginExport(snapshotRef, supplierRef);
    await bindingStore.recordBatch(snapshotRef, supplierRef, [
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
    await bindingStore.completeExport(snapshotRef, "e".repeat(64));
    await bindingStore.register({
      offerRef,
      supplierRef,
      snapshotRef,
      sourceIdentityScheme: "hmac-sha256-v1",
      sourceOfferKeyHash: "d".repeat(64),
    });

    const productRef = ref("prd"),
      variantRef = ref("var");
    const map = defineStatement(
      prepDb,
      `INSERT INTO orders.catalog_mapping_projection
      (product_ref,variant_ref,offer_ref,mapping_revision,catalog_snapshot_revision,mapping_state,availability,effective_at,source_message_id,payload_hash)
      VALUES($1,$2,$3,1,1,'Active','Available',clock_timestamp(),'g18-owner-fixture',$4)`,
    );
    await withTransaction(prepDb, { mode: "background" }, (tx) =>
      map(tx, [productRef, variantRef, offerRef, "f".repeat(64)]),
    );

    const store = new OrderStore(ordersDb);
    const actorRef = "g18-runtime-fixture";
    const meta = () => ({
      actorRef,
      identity: { actorRef, scope: "a".repeat(64), key: randomUUID() },
      correlationId: randomUUID(),
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    });
    const customer = {
      customerRef: ref("cus"),
      customerVersion: "1",
      displayName: "G18 isolated runtime fixture",
      state: "Active",
    };
    const draft = await store.createDraft({ ...meta(), customer });
    const item = {
      productRef,
      variantRef,
      productDisplayName: "G18 fixture coffee",
      unit: "piece",
      quantityMilli: "1000",
      quoteRef: ref("prq"),
      quoteLineNumber: 1,
      quoteHash: "a".repeat(64),
      internalProofHash: "b".repeat(64),
      quoteExpiresAt: Temporal.Now.instant().add({ hours: 1 }).toString(),
      policyVersionRef: ref("pvr"),
      catalogSnapshotRevision: "1",
      mappingRevision: "1",
      offerRef,
      unitMinor: "150",
      lineTotalMinor: "150",
      currency: "RUB",
      sourceGrindKeyHash,
      grindDisplayName: "Fixture grind 1",
    };
    const updated = await store.putItem({
      ...meta(),
      orderRef: draft.body.orderRef,
      itemRef: ref("itm"),
      expectedVersion: draft.body.version,
      request: {
        expectedVersion: draft.body.version,
        productRef,
        variantRef,
        quantity: "1",
        quoteRef: item.quoteRef,
        quoteLineNumber: 1,
        quoteHash: item.quoteHash,
        sourceGrindKeyHash,
      },
      item,
    });
    const confirmed = await store.confirm({
      ...meta(),
      orderRef: draft.body.orderRef,
      expectedVersion: updated.body.version,
      cardPermissions: ["orders:confirm:any"],
    });
    assert.equal(confirmed.body.status, "Confirmed");
    return {
      orderRef: draft.body.orderRef,
      offerRef,
      sourceGrindKeyHash,
      desiredQuantityMilli: "1000",
    };
  } finally {
    await Promise.allSettled(
      databases.map((database) =>
        database.resource.stop(AbortSignal.timeout(10_000)),
      ),
    );
  }
}

export async function readRollbackFacts({
  port,
  credentials,
  platformConfig,
  orderRef,
  offerRef,
}) {
  // aroma-convergence is the canonical runtime owner/read role for convergence facts,
  // Inbox projections, Desired/Observed, and owner-scoped outbox evidence.
  const orders = new Client({
    host: "127.0.0.1",
    port,
    database: platformConfig.services["aroma-convergence"].database,
    user: credentials.databaseCredentialsByRuntime["aroma-convergence"]
      .username,
    password:
      credentials.databaseCredentialsByRuntime["aroma-convergence"].password,
    ssl: false,
  });
  const gateway = new Client({
    host: "127.0.0.1",
    port,
    database: platformConfig.services["aroma-gateway"].database,
    user: credentials.databaseCredentialsByRuntime["aroma-gateway"].username,
    password:
      credentials.databaseCredentialsByRuntime["aroma-gateway"].password,
    ssl: false,
  });
  await Promise.all([orders.connect(), gateway.connect()]);
  try {
    const [
      counts,
      attempts,
      reservations,
      desiredHistory,
      observedHistory,
      ordersOutbox,
      orderProjection,
      gatewayRows,
      work,
      lease,
      convergenceOutbox,
    ] = await Promise.all([
      orders.query(COUNT_SQL),
      orders.query(`SELECT attempt_ref,cart_scope_ref,desired_revision::text,desired_hash,owner_instance_id::text,fence_epoch::text,
        started_at::text,state,failure_code,blocker_codes,selected_action,selected_offer_ref,observed_start_revision::text,observed_end_revision::text
        FROM orders.convergence_attempts WHERE cart_scope_ref='aroma-primary' ORDER BY started_at,attempt_ref`),
      orders.query(`SELECT operation_ref,attempt_ref,state,action,offer_ref,observed_before_milli::text,desired_milli::text,resolved_at IS NOT NULL AS resolved
        FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' ORDER BY reserved_at,operation_ref`),
      orders.query(`SELECT cart_scope_ref,desired_revision::text,state,desired_hash,source_max_order_version::text,created_at::text
        FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' ORDER BY desired_revision`),
      orders.query(`SELECT cart_scope_ref,observed_revision::text,state,provider_snapshot_ref,cart_fingerprint,captured_at::text,saved_at::text,
        source_kind,source_attempt_ref,fence_epoch::text,complete
        FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary' ORDER BY observed_revision`),
      orders.query(
        `SELECT message_id,message_type,topic,aggregate_ref,aggregate_sequence::text,owner_version::text,partition_key,schema_version,
          envelope_hash,payload_hash,correlation_id,causation_id,envelope,payload,state
        FROM orders.outbox_messages WHERE aggregate_ref=$1 ORDER BY aggregate_sequence`,
        [orderRef],
      ),
      orders.query(
        "SELECT state,blocker_codes,desired_revision::text,observed_revision::text FROM orders.order_aroma_projections WHERE order_ref=$1",
        [orderRef],
      ),
      gateway.query(
        `SELECT operation_ref,operation_kind,offer_ref,request_hash,created_at::text,state,failure_code FROM integration.provider_mutation_journal
        WHERE cart_scope_ref='aroma-primary' AND offer_ref=$1 ORDER BY created_at,operation_ref`,
        [offerRef],
      ),
      orders.query(
        "SELECT desired_revision::text,dirty,wake_revision::text,reason FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
      ),
      orders.query(
        "SELECT owner_instance_id::text,expires_at>clock_timestamp() AS active FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
      ),
      orders.query(`SELECT message_id,message_type,state,causation_id FROM orders.outbox_messages
        WHERE aggregate_ref='aroma-primary' AND message_type='AromaConvergenceChanged.v1' ORDER BY aggregate_sequence`),
    ]);
    const orderMessageIds = ordersOutbox.rows.map((row) => row.message_id);
    const [orderInboxRows, wakes] = await Promise.all([
      orderMessageIds.length === 0
        ? Promise.resolve({ rows: [] })
        : orders.query(
            `SELECT consumer_name,message_id,message_type,partition_key,schema_version,owner_version::text,payload_hash,envelope_hash,envelope,received_at::text,state
          FROM orders.inbox_messages WHERE message_id=ANY($1::text[])`,
            [orderMessageIds],
          ),
      orders.query(`SELECT message_id,message_type,topic,aggregate_ref,aggregate_sequence::text,owner_version::text,
          partition_key,schema_version,envelope_hash,payload_hash,correlation_id,causation_id,payload,envelope,state
        FROM orders.outbox_messages WHERE aggregate_ref='aroma-primary' AND message_type='AromaConvergenceRequested.v1'
        ORDER BY aggregate_sequence,message_id`),
    ]);
    const wakeIds = wakes.rows.map((row) => row.message_id);
    const wakeInbox =
      wakeIds.length === 0
        ? { rows: [] }
        : await orders.query(
            `SELECT consumer_name,message_id,message_type,partition_key,schema_version,owner_version::text,payload_hash,envelope_hash,envelope,received_at::text,state
        FROM orders.inbox_messages WHERE message_id=ANY($1::text[])`,
            [wakeIds],
          );
    const convergenceEventIds = convergenceOutbox.rows.map(
      (row) => row.message_id,
    );
    const projectionInbox =
      convergenceEventIds.length === 0
        ? { rows: [] }
        : await orders.query(
            `SELECT consumer_name,message_id,message_type,partition_key,schema_version,owner_version::text,payload_hash,envelope_hash,envelope,received_at::text,state
        FROM orders.inbox_messages WHERE message_id=ANY($1::text[])`,
            [convergenceEventIds],
          );
    const inboxHistory = [
      ...orderInboxRows.rows,
      ...wakeInbox.rows,
      ...projectionInbox.rows,
    ];
    const outboxHistory = await orders.query(
      `SELECT message_id,message_type,topic,aggregate_ref,aggregate_sequence::text,owner_version::text,
      partition_key,schema_version,envelope_hash,payload_hash,correlation_id,causation_id,traceparent,occurred_at::text,state
      FROM orders.outbox_messages WHERE aggregate_ref=$1 OR
        (aggregate_ref='aroma-primary' AND message_type IN ('AromaConvergenceChanged.v1','AromaConvergenceRequested.v1'))
      ORDER BY message_id`,
      [orderRef],
    );
    return {
      counts: counts.rows[0],
      attempts: attempts.rows,
      reservations: reservations.rows,
      ordersOutbox: ordersOutbox.rows,
      inboxRows: orderInboxRows.rows,
      wakes: wakes.rows,
      wakeInbox: wakeInbox.rows,
      convergenceOutbox: convergenceOutbox.rows,
      projectionInbox: projectionInbox.rows,
      orderProjection: orderProjection.rows[0] ?? null,
      gatewayRows: gatewayRows.rows,
      work: work.rows[0] ?? null,
      lease: lease.rows[0] ?? null,
      desired: desiredHistory.rows,
      observed: observedHistory.rows,
      inbox: inboxHistory,
      outbox: outboxHistory.rows,
      gateway: gatewayRows.rows,
    };
  } finally {
    await Promise.allSettled([orders.end(), gateway.end()]);
  }
}

/** Read only the Orders preparation role's guarded Card predicates for timeout evidence. */
export async function readRollbackGuardedCardFacts({
  port,
  credentials,
  platformConfig,
  orderRef,
}) {
  const preparationCredential =
    credentials?.databaseCredentialsByRuntime?.["orders-aroma-preparation"];
  const maxSnapshotAgeMs =
    platformConfig?.services?.["aroma-convergence"]?.aromaConvergence
      ?.maxSnapshotAgeMs;
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof orderRef !== "string" ||
    !orderRef ||
    typeof preparationCredential?.username !== "string" ||
    !preparationCredential.username ||
    typeof preparationCredential.password !== "string" ||
    !Number.isInteger(maxSnapshotAgeMs) ||
    maxSnapshotAgeMs < 0
  )
    throw new Error("G18_GUARDED_CARD_FACTS_INPUT_INVALID");

  const client = new Client({
    host: "127.0.0.1",
    port,
    database: platformConfig.services["orders-aroma-preparation"].database,
    user: preparationCredential.username,
    password: preparationCredential.password,
    ssl: false,
    connectionTimeoutMillis: 1_000,
    query_timeout: 2_000,
    statement_timeout: 2_000,
  });
  try {
    await client.connect();
    const result = await client.query(GUARDED_CARD_FACTS_SQL, [
      orderRef,
      maxSnapshotAgeMs,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error("G18_GUARDED_CARD_FACTS_MISSING");
    return {
      projectionState: GUARDED_CARD_PROJECTION_STATES.has(row.projection_state)
        ? row.projection_state
        : row.projection_state === "Missing"
          ? "Missing"
          : "Other",
      orderPresent: row.order_present === true,
      projectionPresent: row.projection_present === true,
      currentDesiredPresent: row.current_desired_present === true,
      currentObservedPresent: row.current_observed_present === true,
      proofAttemptPresent: row.proof_attempt_present === true,
      leasePresent: row.lease_present === true,
      desiredProofMatches: row.desired_proof_matches === true,
      observedProofMatches: row.observed_proof_matches === true,
      observationComplete: row.observation_complete === true,
      observationNotFuture: row.observation_not_future === true,
      observationFresh: row.observation_fresh === true,
      freshnessEnabled: row.freshness_enabled === true,
      attemptSuccessful: row.attempt_successful === true,
      attemptMatchesProjection: row.attempt_matches_projection === true,
      attemptMatchesDesired: row.attempt_matches_desired === true,
      attemptMatchesObserved: row.attempt_matches_observed === true,
      fenceMatches: row.fence_matches === true,
      leaseOwnerMatches: row.lease_owner_matches === true,
      leaseActive: row.lease_active === true,
      unknownOutcomePresent: row.unknown_outcome_present === true,
      unresolvedReservationPresent: row.unresolved_reservation_present === true,
      currentContributionMatches: row.current_contribution_matches === true,
      orderBlockersPresent: row.order_blockers_present === true,
      exactLinesMatch: row.exact_lines_match === true,
      latestAttemptPresent: row.latest_attempt_present === true,
      latestAttemptSuccessful: row.latest_attempt_successful === true,
      latestAttemptMatchesDesired: row.latest_attempt_matches_desired === true,
      latestAttemptMatchesObservedRevision:
        row.latest_attempt_matches_observed_revision === true,
      latestAttemptObservedFingerprintMatchesCurrent:
        row.latest_attempt_observed_fingerprint_matches_current === true,
      latestAttemptFenceMatchesLease:
        row.latest_attempt_fence_matches_lease === true,
      latestAttemptOwnerMatchesLease:
        row.latest_attempt_owner_matches_lease === true,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function readProviderTrace(traceFile) {
  const value = JSON.parse(await readFile(traceFile, "utf8"));
  assert.ok(
    Array.isArray(value) &&
      value.every(
        (row) =>
          Number.isSafeInteger(row.sequence) &&
          ["safe-get", "set-quantity", "remove"].includes(row.kind) &&
          typeof row.outcome === "string",
      ),
  );
  return value;
}

export function hasCompleteSafeGetBetweenLostAndApplied(trace) {
  if (!Array.isArray(trace)) return false;
  const lostIndex = trace.findIndex(
    (row) =>
      row.kind === "set-quantity" &&
      row.outcome === "response-lost-before-effect",
  );
  if (lostIndex < 0) return false;
  const appliedIndex = trace.findIndex(
    (row, index) =>
      index > lostIndex &&
      row.kind === "set-quantity" &&
      row.outcome === "applied",
  );
  return (
    appliedIndex > lostIndex &&
    trace
      .slice(lostIndex + 1, appliedIndex)
      .some((row) => row.kind === "safe-get" && row.outcome === "complete")
  );
}

export function rollbackSafeDigest(value) {
  return sha(value);
}

/** Run the Orders Card/reconciliation HTTP path from api-public using its scoped mTLS identity and a synthetic, correctly signed actor delegation. */
export function rollbackOwnerHttpSource(orderRef, action) {
  assert.match(orderRef, /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u);
  assert.ok(["read", "reconcile"].includes(action));
  return `import {createPrivateKey,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHttpClient} from '@coffee-platform/platform-http';
import {signActorContext} from '@coffee-platform/security';
import {configuredOrdersOrigin,configuredOrdersTls} from './dist/index.js';
const runtimeRequire=createRequire(import.meta.resolve('@coffee-platform/runtime'));
const {load}=await import(pathToFileURL(runtimeRequire.resolve('js-yaml')).href);
const config=load(await readFile(process.env.COFFEE_CONFIG_FILE,'utf8'),{json:true});
const document=load(await readFile(process.env.COFFEE_RUNTIME_SECRETS_FILE,'utf8'),{json:true});
const context={config,secrets:document.secrets};
const client=createHttpClient({origin:configuredOrdersOrigin(context),tls:configuredOrdersTls(context)});
const orderRef=${JSON.stringify(orderRef)};
const traceparent='00-11111111111111111111111111111111-2222222222222222-01';
const actor={iss:'edge-gateway',sub:'g18-synthetic-operator',permissions:['orders:read:any','orders:reconcile:any']};
const request=async(operation,method,body)=>{
  const now=Math.floor(Date.now()/1000),correlationId=randomUUID();
  const token=signActorContext({iss:'api-public',aud:'orders-service',originalIssuer:actor.iss,sub:actor.sub,permissions:actor.permissions,
    operationId:operation,correlationId,traceparent,iat:now,exp:now+5,jti:randomUUID(),kid:'api-public-delegation-v1'},
    createPrivateKey(document.secrets.security.apiPublicDelegationSigningPrivateKey));
  const headers={'x-actor-context':token,'x-correlation-id':correlationId,traceparent,'accept':'application/json, application/problem+json'};
  if(operation==='requestAromaReconciliation'){headers['content-type']='application/json';headers['idempotency-key']=randomUUID();}
  const response=await client.fetch('/api/client-v1/orders/'+orderRef+(operation==='requestAromaReconciliation'?'/commands/request-aroma-reconciliation':''),
    {method,headers,signal:AbortSignal.timeout(8000),redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;try{value=await response.json();}catch{value=null;}
  return {status:response.status,value,correlationId};
};
try{
  const card=await request('getOrderCard','GET');
  if(card.status!==200||card.value?.orderRef!==orderRef||typeof card.value?.version!=='string'||!card.value?.aroma) throw new Error('G18_ORDER_CARD_HTTP_INVALID');
  if(${JSON.stringify(action)}==='read') console.log(JSON.stringify({status:card.status,state:card.value.aroma.state,version:card.value.version,
    blockerCodes:card.value.aroma.blockers.map(value=>value.code)}));
  else {
    if(!['UnknownOutcome','Blocked','OutOfSync'].includes(card.value.aroma.state)) throw new Error('G18_RECONCILIATION_CARD_STATE_INVALID');
    const accepted=await request('requestAromaReconciliation','POST',{expectedVersion:card.value.version,reason:'G18 isolated rollback recovery'});
    if(accepted.status!==202||accepted.value?.orderRef!==orderRef||accepted.value?.aromaState!==card.value.aroma.state) throw new Error('G18_RECONCILIATION_HTTP_INVALID');
    console.log(JSON.stringify({status:accepted.status,cardState:card.value.aroma.state,version:accepted.value.orderVersion,correlationId:accepted.correlationId}));
  }
} finally {await client.close();}
`;
}
