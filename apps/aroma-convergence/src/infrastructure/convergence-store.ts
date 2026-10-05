import {isCatalogPricingInput} from "@coffee-platform/contracts-catalog-v1";
import {randomBytes, randomUUID} from "node:crypto";
import {Readable} from "node:stream";
import {withTransaction, type Database, type Transaction, type SqlScalar} from "@coffee-platform/database";
import {defineCopy, defineStatement} from "@coffee-platform/database/owner";
import {canonicalRequestHash, type JsonValue} from "@coffee-platform/idempotency";
import {createSqlOutboxStore} from "@coffee-platform/outbox";
import {normalizeAromaCartSnapshot, isAromaMutationResponse, type NormalizedAromaCartSnapshot} from "@coffee-platform/contracts-aroma-v1";
import type {KafkaEnvelope} from "@coffee-platform/kafka-runtime";
import {firstCartDifference, reconcileReservation, type PhysicalLine, type CartDifference} from "../cart-plan.js";
import {GatewayClientError, type AromaConvergenceGatewayClient, type GatewayCallContext} from "../gateway-client.js";
import {assertAromaResultEnvelope, decodeAromaConvergenceEnvelope} from "../application/messages.js";
import type {AromaConvergenceTelemetry} from "../observability.js";
import {decodeConvergenceAbandonedRow, decodeConvergenceBlockerRow, decodeConvergenceCatalogSourceRow,
  decodeConvergenceClockRow, decodeConvergenceFenceRow, decodeConvergenceLineRow, decodeConvergenceLockRow,
  decodeConvergenceProvenanceRow, decodeConvergenceRemainingRow, decodeConvergenceReservationRow,
  decodeConvergenceRevisionRow, decodeConvergenceSafeRow, decodeConvergenceSequenceRow, decodeConvergenceValidRow, decodeConvergenceWorkRow} from "./row-schemas.js";

export type AromaConvergenceOptions = Readonly<{
  ownerInstanceId: string; mutationsEnabled: boolean; leaseMs: number; heartbeatIntervalMs: number;
  providerDeadlineMs: number; safetyMarginMs: number; retryBackoffMs: number; maxSnapshotAgeMs: number; maxLines: number;
}>;
type Gateway = Pick<AromaConvergenceGatewayClient, "read" | "setQuantity" | "remove" | "catalogInput">;
type Terminal = "NoOpInSync" | "VerifiedInSync" | "OutOfSync" | "Blocked" | "UnknownOutcome" | "Failed";
type Work = {desired_revision: string; desired_hash: string; wake_revision: string};
type Attempt = Work & {attempt_ref: string; fence_epoch: string; observed_start_revision: string | null};
class OwnershipLost extends Error {constructor() {super("AROMA_CONVERGENCE_OWNERSHIP_LOST");}}
function physical(row: {offer_ref: string; source_grind_key_hash: string | null; quantity_milli: string}): PhysicalLine {
  return {offerRef: row.offer_ref, quantityMilli: row.quantity_milli,
    ...(row.source_grind_key_hash === null ? {} : {sourceGrindKeyHash: row.source_grind_key_hash})};
}
function ref(prefix: string, ms: string): string {
  let value = (BigInt(ms) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let encoded = "";
  for (let i = 0; i < 26; i++) {encoded = alphabet[Number(value & 31n)]! + encoded; value >>= 5n;}
  return `${prefix}_${encoded}`;
}
function validateOptions(options: AromaConvergenceOptions): void {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u.test(options.ownerInstanceId) ||
      typeof options.mutationsEnabled !== "boolean") throw new TypeError("AROMA_CONVERGENCE_OPTIONS_INVALID");
  for (const [key, value] of Object.entries(options)) {
    if (key === "ownerInstanceId" || key === "mutationsEnabled") continue;
    if (!Number.isSafeInteger(value) || (value as number) < (key === "safetyMarginMs" ? 0 : 1) || (value as number) > 2_147_483_647) {
      throw new TypeError("AROMA_CONVERGENCE_OPTIONS_INVALID");
    }
  }
  if (options.heartbeatIntervalMs >= options.leaseMs || options.maxLines > 10_000) throw new TypeError("AROMA_CONVERGENCE_OPTIONS_INVALID");
}

/** Orders-owned short transactions only. An unresolved reservation is a cart-wide
 * barrier across owners/fences; neither Kafka delivery nor an acknowledgement is
 * authority to repeat an unsafe operation or to assert physical equality. */
export function createAromaConvergenceStore(database: Database, options: AromaConvergenceOptions, telemetry?: AromaConvergenceTelemetry): Readonly<{
  recover(signal: AbortSignal): Promise<void>;
  handleWake(transaction: Transaction, envelope: KafkaEnvelope, signal: AbortSignal): Promise<void>;
  runOnce(gateway: Gateway, signal: AbortSignal): Promise<"idle" | "attempted">;
}> {
  validateOptions(options);
  const config = {...options};
  const statement = <Row>(sql: string, decode: (value: unknown) => Row) => {
    const execute = defineStatement<unknown, readonly SqlScalar[]>(database, sql);
    return async (transaction: Transaction, parameters: readonly SqlScalar[]) => {
      const result = await execute(transaction, parameters);
      return {...result, rows: result.rows.map(decode)};
    };
  };
  const command = (sql: string) => defineStatement<never, readonly SqlScalar[]>(database, sql);
  const lock = statement("SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))) AS acquired", decodeConvergenceLockRow);
  const clock = statement(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now,
    floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`, decodeConvergenceClockRow);
  const work = statement(`SELECT w.desired_revision::text,d.desired_hash,w.wake_revision::text
    FROM orders.convergence_work w JOIN orders.cart_desired_revisions d
      ON d.cart_scope_ref=w.cart_scope_ref AND d.desired_revision=w.desired_revision AND d.state='Current'
    WHERE w.cart_scope_ref='aroma-primary' AND w.dirty AND w.next_attempt_at<=clock_timestamp()`, decodeConvergenceWorkRow);
  const acquire = statement(`WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    INSERT INTO orders.convergence_leases
    (cart_scope_ref,owner_instance_id,fence_epoch,acquired_at,heartbeat_at,expires_at)
    SELECT 'aroma-primary',$1::uuid,1,lease_clock.now,lease_clock.now,lease_clock.now+$2*interval '1 millisecond'
    FROM lease_clock
    ON CONFLICT(cart_scope_ref) DO UPDATE SET owner_instance_id=EXCLUDED.owner_instance_id,
      fence_epoch=orders.convergence_leases.fence_epoch+1,acquired_at=EXCLUDED.acquired_at,
      heartbeat_at=EXCLUDED.heartbeat_at,expires_at=EXCLUDED.expires_at
    WHERE orders.convergence_leases.expires_at<=clock_timestamp() RETURNING fence_epoch::text`, decodeConvergenceFenceRow);
  const guard = statement(`SELECT EXISTS(SELECT 1 FROM orders.convergence_leases l
    JOIN orders.cart_desired_revisions d ON d.cart_scope_ref=l.cart_scope_ref AND d.state='Current'
    WHERE l.cart_scope_ref='aroma-primary' AND l.owner_instance_id=$1::uuid AND l.fence_epoch=$2
      AND l.expires_at>clock_timestamp() AND d.desired_revision=$3 AND d.desired_hash=$4
      AND ($5::bigint IS NULL OR EXISTS(SELECT 1 FROM orders.cart_observed_revisions o
        WHERE o.cart_scope_ref=l.cart_scope_ref AND o.state='Current' AND o.observed_revision=$5))) AS valid`, decodeConvergenceValidRow);
  const heartbeat = statement(`WITH lease_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
    UPDATE orders.convergence_leases l
    SET heartbeat_at=lease_clock.now,expires_at=GREATEST(l.expires_at,lease_clock.now+$3*interval '1 millisecond')
    FROM lease_clock
    WHERE l.cart_scope_ref='aroma-primary' AND l.owner_instance_id=$1::uuid AND l.fence_epoch=$2 AND l.expires_at>clock_timestamp()
      AND EXISTS(SELECT 1 FROM orders.cart_desired_revisions d WHERE d.cart_scope_ref=l.cart_scope_ref
        AND d.state='Current' AND d.desired_revision=$4 AND d.desired_hash=$5) RETURNING l.fence_epoch::text`, decodeConvergenceFenceRow);
  const release = command(`UPDATE orders.convergence_leases SET expires_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND owner_instance_id=$1::uuid AND fence_epoch=$2 AND expires_at>clock_timestamp()`);
  const desiredLines = statement(`SELECT offer_ref,source_grind_key_hash,quantity_milli::text
    FROM orders.cart_desired_lines WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1`, decodeConvergenceLineRow);
  const observedMatchesDesired = statement(`SELECT NOT EXISTS (
    SELECT 1 FROM
      (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_desired_lines
        WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1) d
    FULL JOIN
      (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_observed_lines
        WHERE cart_scope_ref='aroma-primary' AND observed_revision=$2) o
      ON d.offer_ref COLLATE "C"=o.offer_ref COLLATE "C"
        AND COALESCE(d.source_grind_key_hash::text,'') COLLATE "C"=COALESCE(o.source_grind_key_hash::text,'') COLLATE "C"
    WHERE d.offer_ref IS NULL OR o.offer_ref IS NULL
      OR d.quantity_milli IS DISTINCT FROM o.quantity_milli OR d.quantity_milli<=0
      OR d.quantity_milli%1000<>0 OR d.quantity_milli/1000>9007199254740991
  ) AS valid`, decodeConvergenceValidRow);
  const observedLines = statement(`SELECT offer_ref,source_grind_key_hash,quantity_milli::text
    FROM orders.cart_observed_lines WHERE cart_scope_ref='aroma-primary' AND observed_revision=$1`, decodeConvergenceLineRow);
  const blockers = statement(`SELECT DISTINCT code FROM orders.cart_desired_blockers
    WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1 ORDER BY code`, decodeConvergenceBlockerRow);
  const mapping = statement(`SELECT count(*)=1 AND bool_and(mapping_state='Active' AND availability='Available') AS safe
    FROM orders.catalog_mapping_projection WHERE offer_ref=$1`, decodeConvergenceSafeRow);
  const catalogSource = statement(`SELECT product_ref,variant_ref,catalog_snapshot_revision::text,mapping_revision::text
    FROM orders.catalog_mapping_projection WHERE offer_ref=$1 AND mapping_state='Active' AND availability='Available'
    ORDER BY product_ref,variant_ref LIMIT 1`, decodeConvergenceCatalogSourceRow);
  const unresolved = statement(`SELECT operation_ref,attempt_ref,offer_ref,source_grind_key_hash,desired_milli::text,
    observed_before_milli::text,observed_before_revision::text,action,state,
    reserved_until<=clock_timestamp() AS window_ended,
    floor(extract(epoch FROM provider_deadline_at-clock_timestamp())*1000)::bigint::text AS remaining_ms
    FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary'
      AND state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome')`, decodeConvergenceReservationRow);
  const start = command(`INSERT INTO orders.convergence_attempts
    (attempt_ref,cart_scope_ref,desired_revision,desired_hash,owner_instance_id,fence_epoch,state)
    VALUES($1,'aroma-primary',$2,$3,$4::uuid,$5,'Started')`);
  const abandon = statement(`UPDATE orders.convergence_attempts a
    SET state=CASE WHEN EXISTS(SELECT 1 FROM orders.mutation_reservations r WHERE r.attempt_ref=a.attempt_ref
      AND r.state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome')) THEN 'UnknownOutcome' ELSE 'Failed' END,
      ended_at=clock_timestamp(),failure_code='AROMA_WORKER_INTERRUPTED'
    WHERE a.state IN ('Started','Observed','MutationReserved','MutationDispatched')
      AND NOT EXISTS(SELECT 1 FROM orders.convergence_leases l WHERE l.cart_scope_ref=a.cart_scope_ref
        AND l.owner_instance_id=a.owner_instance_id AND l.fence_epoch=a.fence_epoch AND l.expires_at>clock_timestamp())
    RETURNING a.attempt_ref,a.desired_revision::text,a.observed_start_revision::text,a.state`, decodeConvergenceAbandonedRow);
  const abandonedReservation = command(`UPDATE orders.mutation_reservations r SET state='UnknownOutcome'
    WHERE state IN ('Reserved','Dispatched','Acknowledged') AND EXISTS(SELECT 1 FROM orders.convergence_attempts a
      WHERE a.attempt_ref=r.attempt_ref AND a.state='UnknownOutcome')`);
  const deferBarrier = command(`UPDATE orders.convergence_work SET next_attempt_at=GREATEST(clock_timestamp()+$1*interval '1 millisecond',
      (SELECT reserved_until FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary'
        AND state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome'))),updated_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND dirty`);
  const wake = command(`UPDATE orders.convergence_work SET next_attempt_at=LEAST(next_attempt_at,clock_timestamp()),updated_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND dirty AND desired_revision=$1`);
  const consume = command(`UPDATE orders.convergence_work SET dirty=$3,
      next_attempt_at=clock_timestamp()+$4*interval '1 millisecond',updated_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1 AND wake_revision=$2`);
  const freshness = statement(`SELECT ($1::timestamptz<=clock_timestamp()
      AND $1::timestamptz>=clock_timestamp()-$2*interval '1 millisecond'
      AND NOT EXISTS(SELECT 1 FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'
        AND state='Current' AND captured_at>$1::timestamptz)) AS valid`, decodeConvergenceValidRow);
  const nextObserved = statement(`SELECT (COALESCE(max(observed_revision),0)+1)::text AS revision
    FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'`, decodeConvergenceRevisionRow);
  const supersede = command(`UPDATE orders.cart_observed_revisions SET state='Superseded'
    WHERE cart_scope_ref='aroma-primary' AND state='Current'`);
  const observed = command(`INSERT INTO orders.cart_observed_revisions
    (cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind,source_attempt_ref,fence_epoch)
    VALUES('aroma-primary',$1,'Current',$2,$3,$4::timestamptz,'Convergence',$5,$6)`);
  const observedLinesInsert = defineCopy(database, "cart_observed_lines",
    ["cart_scope_ref", "observed_revision", "offer_ref", "source_grind_key_hash", "quantity_milli", "sanitized_line_hash"], "orders");
  const saw = command(`UPDATE orders.convergence_attempts SET state='Observed',observed_start_revision=$2
    WHERE attempt_ref=$1 AND state='Started'`);
  const selected = command(`UPDATE orders.convergence_attempts SET state='MutationReserved',selected_action=$2,
    selected_offer_ref=$3,selected_source_grind_key_hash=$4 WHERE attempt_ref=$1 AND state='Observed'`);
  const reserve = command(`INSERT INTO orders.mutation_reservations
    (operation_ref,attempt_ref,cart_scope_ref,desired_revision,fence_epoch,observed_before_revision,action,offer_ref,
      source_grind_key_hash,observed_before_milli,desired_milli,target_provider_quantity,request_hash,
      reserved_at,reserved_until,provider_deadline_at,safety_margin_ms,state)
    SELECT $1,$2,'aroma-primary',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,t.now,
      t.now+($13::integer+$14::integer)*interval '1 millisecond',t.now+$13::integer*interval '1 millisecond',$14,'Reserved'
    FROM (SELECT clock_timestamp() AS now OFFSET 0) t`);
  const extend = command(`UPDATE orders.convergence_leases SET expires_at=GREATEST(expires_at,
      (SELECT reserved_until FROM orders.mutation_reservations WHERE operation_ref=$3))
    WHERE cart_scope_ref='aroma-primary' AND owner_instance_id=$1::uuid AND fence_epoch=$2`);
  const dispatch = statement(`UPDATE orders.mutation_reservations SET state='Dispatched',dispatched_at=clock_timestamp()
    WHERE operation_ref=$1 AND state='Reserved' AND provider_deadline_at>clock_timestamp()
    RETURNING floor(extract(epoch FROM provider_deadline_at-clock_timestamp())*1000)::bigint::text AS remaining_ms`, decodeConvergenceRemainingRow);
  const dispatched = command(`UPDATE orders.convergence_attempts SET state='MutationDispatched' WHERE attempt_ref=$1 AND state='MutationReserved'`);
  const resolve = command(`UPDATE orders.mutation_reservations SET state=$2,
    resolved_at=CASE WHEN $2::varchar IN ('Verified','Rejected','RecoveredApplied','RecoveredNotApplied') THEN clock_timestamp() ELSE NULL END,
    gateway_outcome_hash=COALESCE($3,gateway_outcome_hash)
    WHERE operation_ref=$1 AND state IN ('Reserved','Dispatched','Acknowledged','UnknownOutcome')`);
  const end = command(`UPDATE orders.convergence_attempts SET state=$2,ended_at=clock_timestamp(),
    observed_end_revision=$3,failure_code=$4,blocker_codes=$5::jsonb
    WHERE attempt_ref=$1 AND state IN ('Started','Observed','MutationReserved','MutationDispatched')`);
  const currentObserved = statement(`SELECT observed_revision::text AS revision
    FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'`, decodeConvergenceRevisionRow);
  const sequence = statement(`SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence
    FROM orders.outbox_messages WHERE aggregate_ref='aroma-primary'`, decodeConvergenceSequenceRow);
  const provenance = statement(`SELECT envelope FROM orders.inbox_messages
    WHERE consumer_name='aroma-convergence-v1' AND message_type='AromaConvergenceRequested.v1'
      AND state='Processed' AND payload->>'desiredRevision'=$1 ORDER BY received_at DESC,message_id DESC LIMIT 1`, decodeConvergenceProvenanceRow);
  const outbox = createSqlOutboxStore(database, {schema: "orders", envelopeBytes: true});
  let running = false;
  const transaction = <T>(signal: AbortSignal, callback: (tx: Transaction) => Promise<T>): Promise<T> =>
    withTransaction(database, {mode: "background", signal}, async tx => {await lock(tx, []); return callback(tx);});
  async function check(tx: Transaction, attempt: Attempt, observedRevision: string | null = null): Promise<void> {
    const verify = async (): Promise<void> => {
      if ((await guard(tx, [config.ownerInstanceId, attempt.fence_epoch, attempt.desired_revision, attempt.desired_hash, observedRevision])).rows[0]?.valid !== true) throw new OwnershipLost();
    };
    try {await (telemetry ? telemetry.observe("aroma.convergence.fence", verify) : verify());}
    catch (error) {if (error instanceof OwnershipLost) telemetry?.fenceFailure(); throw error;}
  }
  async function event(tx: Transaction, payload: JsonValue, observation: boolean, source?: KafkaEnvelope): Promise<void> {
    const time = (await clock(tx, [])).rows[0]!;
    const aggregateSequence = (await sequence(tx, [])).rows[0]!.sequence;
    const messageType = observation ? "AromaObservationChanged.v1" : "AromaConvergenceChanged.v1";
    const ownerVersion = observation ? (payload as {observedRevision: string}).observedRevision : aggregateSequence;
    const messageId = ref("msg", time.ms);
    const envelope = {envelopeVersion: "1", messageId, messageType, occurredAt: time.now, producer: "aroma-convergence",
      correlationId: source?.correlationId ?? randomUUID(), causationId: source?.messageId ?? null,
      traceparent: source?.traceparent ?? `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
      aggregate: {type: "AromaCart", ref: "aroma-primary", version: ownerVersion}, payload};
    assertAromaResultEnvelope(envelope, observation);
    if (await outbox.enqueue(tx, {messageId, messageType, topic: "coffee.aroma.cart.events.v1", aggregateRef: "aroma-primary",
      aggregateSequence: BigInt(aggregateSequence), ownerVersion, partitionKey: "aroma-primary", schemaVersion: "1",
      envelope: envelope as JsonValue, payload, occurredAt: time.now, correlationId: envelope.correlationId,
      ...(envelope.causationId === null ? {} : {causationId: envelope.causationId}), traceparent: envelope.traceparent}) !== "created") {
      throw new TypeError("AROMA_CONVERGENCE_OUTBOX_CONFLICT");
    }
  }
  async function abandoned(tx: Transaction): Promise<void> {
    const rows = (await abandon(tx, [])).rows;
    await abandonedReservation(tx, []);
    for (const row of rows) {
      const recovery = row.state === "UnknownOutcome" ? "unknown_outcome" : "failed";
      telemetry?.recovery(recovery);
      const time = (await clock(tx, [])).rows[0]!;
      const source = (await provenance(tx, [row.desired_revision])).rows[0]?.envelope;
      await event(tx, {cartScopeRef: "aroma-primary", desiredRevision: row.desired_revision,
        observedRevision: row.observed_start_revision ?? "0", attemptRef: row.attempt_ref, attemptState: row.state,
        changedAt: time.now, blockerCodes: ["AROMA_WORKER_INTERRUPTED"]}, false, source);
    }
  }
  async function saveSnapshot(tx: Transaction, attempt: Attempt, value: unknown, source?: KafkaEnvelope): Promise<{revision: string; normalized: NormalizedAromaCartSnapshot}> {
    await check(tx, attempt);
    const normalized = normalizeAromaCartSnapshot(value);
    if (normalized.lines.length > config.maxLines || (await freshness(tx, [normalized.snapshot.capturedAt, config.maxSnapshotAgeMs])).rows[0]?.valid !== true) {
      throw new TypeError("AROMA_OBSERVATION_INVALID");
    }
    const revision = (await nextObserved(tx, [])).rows[0]!.revision;
    await supersede(tx, []);
    await observed(tx, [revision, normalized.snapshot.providerSnapshotRef, normalized.snapshot.cartFingerprint,
      normalized.snapshot.capturedAt, attempt.attempt_ref, attempt.fence_epoch]);
    // Одна COPY в конечную таблицу внутри той же transaction сохраняет FK и statement guards.
    const copyText = Buffer.from(normalized.lines.map(line =>
      `aroma-primary\t${revision}\t${line.offerRef}\t${line.sourceGrindKeyHash ?? "\\N"}\t${line.quantityMilli}\t${line.sanitizedLineHash}\n`).join(""), "utf8");
    await observedLinesInsert(tx, Readable.from([copyText]));
    await event(tx, {cartScopeRef: "aroma-primary", observedRevision: revision, observedAt: normalized.snapshot.capturedAt,
      observationState: "Complete", cartFingerprint: normalized.snapshot.cartFingerprint}, true, source);
    // A large complete vector/event write can outlive the lease. Roll back the
    // entire observation instead of publishing a Current fact under expired ownership.
    await check(tx, attempt, revision);
    return {revision, normalized};
  }
  async function terminal(tx: Transaction, attempt: Attempt, state: Terminal, revision: string | null, codes: readonly string[], source?: KafkaEnvelope,
    retryCleanup = false): Promise<void> {
    await check(tx, attempt, revision);
    const time = (await clock(tx, [])).rows[0]!;
    await end(tx, [attempt.attempt_ref, state, revision, codes[0] ?? null, JSON.stringify([...new Set(codes)].sort())]);
    const fallback = revision ?? (await currentObserved(tx, [])).rows[0]?.revision ?? "0";
    await event(tx, {cartScopeRef: "aroma-primary", desiredRevision: attempt.desired_revision, observedRevision: fallback,
      attemptRef: attempt.attempt_ref, attemptState: state, changedAt: time.now, blockerCodes: [...new Set(codes)].sort()}, false, source);
    const retry = retryCleanup || state === "OutOfSync" || state === "UnknownOutcome" || state === "Failed";
    telemetry?.attempt(state === "NoOpInSync" ? "no_op_in_sync" : state === "VerifiedInSync" ? "verified_in_sync" : state === "OutOfSync" ? "out_of_sync" : state === "Blocked" ? "blocked" : state === "UnknownOutcome" ? "unknown_outcome" : "failed");
    telemetry?.blocker(codes.length);
    await consume(tx, [attempt.desired_revision, attempt.wake_revision, retry, config.retryBackoffMs]);
    // Last DB-side fence/expiry check is the conditional release, in the same
    // short transaction as terminal Attempt, event and durable work consumption.
    if ((await release(tx, [config.ownerInstanceId, attempt.fence_epoch])).rowCount !== 1) throw new OwnershipLost();
  }
  async function recoverCore(signal: AbortSignal): Promise<void> {
    await transaction(signal, async tx => {await abandoned(tx);});
  }
  async function recover(signal: AbortSignal): Promise<void> {
    try {
      await (telemetry ? telemetry.observe("aroma.convergence.recovery", () => recoverCore(signal)) : recoverCore(signal));
      telemetry?.recovery("completed");
    } catch (error) {telemetry?.recovery("failed"); throw error;}
  }
  async function handleWakeCore(tx: Transaction, envelope: KafkaEnvelope, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const decoded = decodeAromaConvergenceEnvelope(envelope);
    await lock(tx, []);
    // Preparation owns intent and wake_revision. A delivery is not new intent.
    await wake(tx, [(decoded.payload as {desiredRevision: string}).desiredRevision]);
  }
  async function handleWake(tx: Transaction, envelope: KafkaEnvelope, signal: AbortSignal): Promise<void> {
    await (telemetry ? telemetry.observe("aroma.convergence.inbox", () => handleWakeCore(tx, envelope, signal)) : handleWakeCore(tx, envelope, signal));
  }
  async function runOnceCore(gateway: Gateway, signal: AbortSignal): Promise<"idle" | "attempted"> {
    signal.throwIfAborted();
    if (running) return "idle";
    running = true;
    let attempt: Attempt | undefined;
    let source: KafkaEnvelope | undefined;
    const lost = new AbortController();
    const requestSignal = AbortSignal.any([signal, lost.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let heartbeatTask: Promise<void> = Promise.resolve();
    let heartbeatFailure: unknown;
    const ping = (): void => {
      timer = setTimeout(() => {
        if (attempt === undefined || lost.signal.aborted) return;
        const owned = attempt;
        const heartbeatCall = () => transaction(requestSignal, async tx => {
          if ((await heartbeat(tx, [config.ownerInstanceId, owned.fence_epoch, config.leaseMs, owned.desired_revision, owned.desired_hash])).rowCount !== 1) throw new OwnershipLost();
        });
        heartbeatTask = (telemetry ? telemetry.observe("aroma.convergence.lease", heartbeatCall) : heartbeatCall()).then(() => {if (!lost.signal.aborted) ping();}, (error: unknown) => {
          if (error instanceof OwnershipLost) telemetry?.heartbeatFailure();
          if (!(error instanceof OwnershipLost) && !requestSignal.aborted) heartbeatFailure = error;
          lost.abort(error);
        });
      }, config.heartbeatIntervalMs);
    };
    const finishHeartbeat = async (): Promise<void> => {
      await heartbeatTask;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    };
    const boundedCall = async <T>(call: (context: GatewayCallContext) => Promise<T>, ms: number): Promise<T> => {
      const callSignal = AbortSignal.any([requestSignal, AbortSignal.timeout(Math.max(1, Math.floor(ms)))]);
      callSignal.throwIfAborted();
      let rejectAbort: (() => void) | undefined;
      const abort = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new OwnershipLost());
        callSignal.addEventListener("abort", rejectAbort, {once: true});
      });
      try {
        callSignal.throwIfAborted();
        return await Promise.race([call({correlationId: source?.correlationId ?? randomUUID(), signal: callSignal,
          ...(source === undefined ? {} : {traceparent: source.traceparent})}), abort]);
      } finally {if (rejectAbort !== undefined) callSignal.removeEventListener("abort", rejectAbort);}
    };
    try {
      const acquireAttempt = () => transaction(signal, async tx => {
        const pending = (await work(tx, [])).rows[0];
        if (pending === undefined) return undefined;
        const barrier = (await unresolved(tx, [])).rows[0];
        if (barrier !== undefined && !barrier.window_ended) {await deferBarrier(tx, [config.retryBackoffMs]); return undefined;}
        const lease = (await acquire(tx, [config.ownerInstanceId, config.leaseMs])).rows[0];
        if (lease === undefined) {telemetry?.leaseFailure(); return undefined;}
        await abandoned(tx);
        const time = (await clock(tx, [])).rows[0]!;
        const created = {...pending, attempt_ref: ref("att", time.ms), fence_epoch: lease.fence_epoch, observed_start_revision: null};
        await start(tx, [created.attempt_ref, created.desired_revision, created.desired_hash, config.ownerInstanceId, created.fence_epoch]);
        source = (await provenance(tx, [pending.desired_revision])).rows[0]?.envelope;
        return created;
      });
      attempt = await (telemetry ? telemetry.observe("aroma.convergence.lease", acquireAttempt) : acquireAttempt());
      if (attempt === undefined) return "idle";
      const owned = attempt;
      ping();
      let before: unknown;
      try {before = await (telemetry ? telemetry.observe("aroma.convergence.provider.read", () => boundedCall(context => gateway.read(context), config.providerDeadlineMs)) : boundedCall(context => gateway.read(context), config.providerDeadlineMs));}
      catch {
        telemetry?.providerFailure();
        await transaction(signal, tx => terminal(tx, owned, "Failed", null, ["AROMA_OBSERVATION_UNAVAILABLE"], source));
        return "attempted";
      }
      telemetry?.providerSuccess();
      // Commit complete preflight independently; invalid/partial input rolls back.
      let baseline: {revision: string; normalized: NormalizedAromaCartSnapshot};
      try {
        baseline = await transaction(signal, async tx => {
          const saved = await saveSnapshot(tx, owned, before, source);
          await saw(tx, [owned.attempt_ref, saved.revision]);
          return saved;
        });
      } catch (error) {
        if (error instanceof OwnershipLost) throw error;
        if (!(error instanceof TypeError) && !(error instanceof Error && error.message === "AROMA_OBSERVATION_INVALID")) throw error;
        telemetry?.providerFailure();
        await transaction(signal, tx => terminal(tx, owned, "Failed", null, ["AROMA_OBSERVATION_INVALID"], source));
        return "attempted";
      }
      owned.observed_start_revision = baseline.revision;
      telemetry?.observed(baseline.normalized.snapshot.capturedAt);
      const selection = await transaction(signal, async tx => {
        await check(tx, owned, baseline.revision);
        let recoveredApplied = false;
        const barrier = (await unresolved(tx, [])).rows[0];
        if (barrier !== undefined) {
          if (!barrier.window_ended) throw new OwnershipLost();
          const prior = (await observedLines(tx, [barrier.observed_before_revision])).rows.map(physical);
          const recovery = reconcileReservation({offerRef: barrier.offer_ref,
            ...(barrier.source_grind_key_hash === null ? {} : {sourceGrindKeyHash: barrier.source_grind_key_hash}),
            quantityMilli: barrier.desired_milli, observedBeforeMilli: barrier.observed_before_milli}, prior, baseline.normalized.lines);
          if (recovery === "AROMA_EXTERNAL_CHANGE") {
            telemetry?.recovery("external_change");
            await resolve(tx, [barrier.operation_ref, "UnknownOutcome", null]);
            await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_EXTERNAL_CHANGE"], source);
            return null;
          }
          telemetry?.recovery(recovery === "RecoveredApplied" ? "recovered_applied" : "recovered_not_applied");
          await resolve(tx, [barrier.operation_ref, recovery, null]);
          recoveredApplied = recovery === "RecoveredApplied";
        }
        const codes = (await blockers(tx, [owned.desired_revision])).rows.map(row => row.code);
        if (codes.length === 0) {
          const equality = (await observedMatchesDesired(tx, [owned.desired_revision, baseline.revision])).rows[0];
          if (equality === undefined) throw new TypeError("AROMA_CONVERGENCE_DATABASE_ROW_INVALID");
          if (equality.valid) {
            await terminal(tx, owned, "NoOpInSync", baseline.revision, [], source);
            return null;
          }
        }
        const target = (await desiredLines(tx, [owned.desired_revision])).rows.map(physical);
        const catalogBlockers = codes.length !== 0 && codes.every(code => code === "MAPPING_CHANGED" || code === "MAPPING_MISSING" ||
          code === "MAPPING_STOPPED" || code === "PRODUCT_UNAVAILABLE");
        let diff: CartDifference | null;
        try {diff = firstCartDifference(target, baseline.normalized.lines, catalogBlockers);}
        catch {await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_QUANTITY_NOT_SUPPORTED"], source); return null;}
        const cleanup = diff !== null && (diff.action === "Remove" || BigInt(diff.quantityMilli) < BigInt(diff.observedBeforeMilli));
        if (codes.length !== 0 && !(catalogBlockers && cleanup)) {
          await terminal(tx, owned, "Blocked", baseline.revision, codes, source); return null;
        }
        if (diff === null) {await terminal(tx, owned, "NoOpInSync", baseline.revision, [], source); return null;}
        // Applied recovery consumes only fresh reconciliation proof. A changed
        // Desired requires a later Attempt; never combine it with another mutation.
        if (recoveredApplied) {
          await terminal(tx, owned, codes.length === 0 ? "OutOfSync" : "Blocked", baseline.revision, codes, source,
            catalogBlockers && cleanup);
          return null;
        }
        if (!config.mutationsEnabled) {await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_MUTATIONS_DISABLED"], source); return null;}
        const positive = diff.action === "SetQuantity" && BigInt(diff.quantityMilli) > BigInt(diff.observedBeforeMilli);
        if (positive && (await mapping(tx, [diff.offerRef])).rows[0]?.safe !== true) {
          await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_MAPPING_NOT_AVAILABLE"], source); return null;
        }
        const catalog = positive ? (await catalogSource(tx, [diff.offerRef])).rows[0] : undefined;
        if (positive && catalog === undefined) {
          await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_MAPPING_NOT_AVAILABLE"], source); return null;
        }
        return {diff, catalog, blockerCodes: codes, cleanupAllowed: catalogBlockers};
      });
      if (selection === null) return "attempted";
      const {diff, catalog} = selection;
      if (catalog !== undefined) {
        // Read the owner's current complete snapshot before reserving a positive mutation.
        // Network IO holds no Orders transaction or advisory lock.
        let valid = false;
        try {
          const proof = await (telemetry ? telemetry.observe("aroma.convergence.provider.catalog_proof", () => boundedCall(context => gateway.catalogInput(catalog.product_ref, catalog.variant_ref, context), 2_000)) : boundedCall(context => gateway.catalogInput(catalog.product_ref, catalog.variant_ref, context), 2_000));
          valid = isCatalogPricingInput(proof) && proof.offerRef === diff.offerRef && proof.productRef === catalog.product_ref && proof.variantRef === catalog.variant_ref &&
            proof.availability === "Available" && BigInt(proof.snapshotRevision) >= BigInt(catalog.catalog_snapshot_revision) &&
            proof.mappingRevision === catalog.mapping_revision &&
            (diff.sourceGrindKeyHash === undefined || proof.grindOptions?.filter(option => option.sourceGrindKeyHash === diff.sourceGrindKeyHash).length === 1);
        } catch { /* Missing, unavailable or malformed proof fails closed. */ }
        if (!valid) telemetry?.providerFailure();
        if (!valid) {
          await transaction(signal, async tx => {
            await check(tx, owned, baseline.revision);
            await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_MAPPING_NOT_AVAILABLE"], source);
          });
          return "attempted";
        }
      }
      const checkCatalog = async (tx: Transaction): Promise<void> => {
        if (catalog === undefined) return;
        const current = (await catalogSource(tx, [diff.offerRef])).rows[0];
        if ((await mapping(tx, [diff.offerRef])).rows[0]?.safe !== true || current === undefined ||
            current.product_ref !== catalog.product_ref || current.variant_ref !== catalog.variant_ref ||
            current.catalog_snapshot_revision !== catalog.catalog_snapshot_revision || current.mapping_revision !== catalog.mapping_revision) throw new OwnershipLost();
      };
      const operation = await transaction(signal, async tx => {
        await check(tx, owned, baseline.revision);
        await checkCatalog(tx);
        const time = (await clock(tx, [])).rows[0]!;
        const operationRef = ref("op", time.ms);
        const request = {operationRef, cartScopeRef: "aroma-primary" as const,
          ...(diff.sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash: diff.sourceGrindKeyHash}),
          ...(diff.action === "Remove" ? {} : {quantity: diff.providerQuantity!})};
        await selected(tx, [owned.attempt_ref, diff.action, diff.offerRef, diff.sourceGrindKeyHash ?? null]);
        await (telemetry ? telemetry.observe("aroma.convergence.reservation", () => reserve(tx, [operationRef, owned.attempt_ref, owned.desired_revision, owned.fence_epoch, baseline.revision, diff.action,
          diff.offerRef, diff.sourceGrindKeyHash ?? null, diff.observedBeforeMilli, diff.quantityMilli, diff.providerQuantity ?? null,
          canonicalRequestHash({offerRef: diff.offerRef, action: diff.action, request}), config.providerDeadlineMs, config.safetyMarginMs])) : reserve(tx, [operationRef, owned.attempt_ref, owned.desired_revision, owned.fence_epoch, baseline.revision, diff.action,
          diff.offerRef, diff.sourceGrindKeyHash ?? null, diff.observedBeforeMilli, diff.quantityMilli, diff.providerQuantity ?? null,
          canonicalRequestHash({offerRef: diff.offerRef, action: diff.action, request}), config.providerDeadlineMs, config.safetyMarginMs]));
        await extend(tx, [config.ownerInstanceId, owned.fence_epoch, operationRef]);
        return {operationRef, diff, request};
      });
      const dispatchStart = performance.now();
      const remaining = await transaction(signal, async tx => {
        await check(tx, owned, baseline.revision);
        // Mapping may change after reservation. Never dispatch under a stale proof.
        await checkCatalog(tx);
        const row = (await dispatch(tx, [operation.operationRef])).rows[0];
        if (row === undefined || Number(row.remaining_ms) <= 0) throw new OwnershipLost();
        await dispatched(tx, [owned.attempt_ref]);
        return Number(row.remaining_ms);
      });
      // The DB deadline was fixed at reservation. Deduct local elapsed monotonic
      // time after dispatch commit; never restart the budget from providerDeadlineMs.
      let ack: unknown;
      try {
        requestSignal.throwIfAborted();
        const budget = remaining - (performance.now() - dispatchStart);
        if (budget <= 0) throw new OwnershipLost();
        telemetry?.mutation(operation.diff.action === "Remove" ? "remove" : "set_quantity");
        ack = await (telemetry ? telemetry.observe("aroma.convergence.provider.mutation", () => boundedCall(context => operation.diff.action === "Remove"
          ? gateway.remove(operation.diff.offerRef, operation.request, context)
          : gateway.setQuantity(operation.diff.offerRef, {...operation.request, quantity: operation.diff.providerQuantity!}, context), budget)) : boundedCall(context => operation.diff.action === "Remove"
          ? gateway.remove(operation.diff.offerRef, operation.request, context)
          : gateway.setQuantity(operation.diff.offerRef, {...operation.request, quantity: operation.diff.providerQuantity!}, context), budget));
        if (!isAromaMutationResponse(ack) || ack.operationRef !== operation.operationRef || ack.offerRef !== operation.diff.offerRef ||
            ack.sourceGrindKeyHash !== operation.diff.sourceGrindKeyHash) throw new TypeError("AROMA_MUTATION_INVALID");
      } catch (error) {
        const definitiveRejection = error instanceof GatewayClientError && error.kind === "Rejected" &&
          error.status === 404 && error.problemCode === "AROMA_CART_ITEM_NOT_FOUND";
        if (!definitiveRejection) telemetry?.providerFailure();
        await transaction(signal, async tx => {
          await check(tx, owned, baseline.revision);
          if (definitiveRejection) {
            await resolve(tx, [operation.operationRef, "Rejected", canonicalRequestHash({status: 404, problemCode: "AROMA_CART_ITEM_NOT_FOUND"})]);
            await terminal(tx, owned, "Blocked", baseline.revision, ["AROMA_CART_ITEM_NOT_FOUND"], source);
          } else {
            await resolve(tx, [operation.operationRef, "UnknownOutcome", null]);
            await terminal(tx, owned, "UnknownOutcome", baseline.revision, ["AROMA_OPERATION_UNKNOWN_OUTCOME"], source);
          }
        });
        return "attempted";
      }
      telemetry?.providerSuccess();
      // Acknowledgement is a durable transport fact, not physical success.
      // Restart from this window must still enter reconcile-only on a new fence.
      await transaction(signal, async tx => {
        await check(tx, owned, baseline.revision);
        await resolve(tx, [operation.operationRef, "Acknowledged", canonicalRequestHash(ack as JsonValue)]);
      });
      let verification: unknown;
      try {verification = await (telemetry ? telemetry.observe("aroma.convergence.provider.verification", () => boundedCall(context => gateway.read(context), config.providerDeadlineMs)) : boundedCall(context => gateway.read(context), config.providerDeadlineMs));}
      catch {
        telemetry?.providerFailure();
        await transaction(signal, async tx => {
          await check(tx, owned, baseline.revision);
          await resolve(tx, [operation.operationRef, "UnknownOutcome", canonicalRequestHash(ack as JsonValue)]);
          await terminal(tx, owned, "UnknownOutcome", baseline.revision, ["AROMA_VERIFICATION_UNAVAILABLE"], source);
        });
        return "attempted";
      }
      telemetry?.providerSuccess();
      try {
        await transaction(signal, async tx => {
          await check(tx, owned, baseline.revision);
          const saved = await saveSnapshot(tx, owned, verification, source);
          const applied = reconcileReservation(operation.diff, baseline.normalized.lines, saved.normalized.lines);
          telemetry?.recovery(applied === "RecoveredApplied" ? "recovered_applied" : applied === "RecoveredNotApplied" ? "recovered_not_applied" : "external_change");
          if (applied === "AROMA_EXTERNAL_CHANGE") {
            await resolve(tx, [operation.operationRef, "UnknownOutcome", canonicalRequestHash(ack as JsonValue)]);
            await terminal(tx, owned, "UnknownOutcome", saved.revision, ["AROMA_EXTERNAL_CHANGE"], source);
            return;
          }
          await resolve(tx, [operation.operationRef, applied === "RecoveredApplied" ? "Verified" : "RecoveredNotApplied", canonicalRequestHash(ack as JsonValue)]);
          const target = (await desiredLines(tx, [owned.desired_revision])).rows.map(physical);
          const equal = firstCartDifference(target, saved.normalized.lines) === null;
          const retryCleanup = applied === "RecoveredApplied" && selection.cleanupAllowed &&
            firstCartDifference(target, saved.normalized.lines, true) !== null;
          await terminal(tx, owned, selection.blockerCodes.length !== 0 ? "Blocked" : equal && applied === "RecoveredApplied" ? "VerifiedInSync" : "OutOfSync",
            saved.revision, selection.blockerCodes, source, retryCleanup);
        });
      } catch (error) {
        if (error instanceof OwnershipLost) throw error;
        if (!(error instanceof TypeError) && !(error instanceof Error && error.message === "AROMA_OBSERVATION_INVALID")) throw error;
        telemetry?.providerFailure();
        await transaction(signal, async tx => {
          await check(tx, owned, baseline.revision);
          await resolve(tx, [operation.operationRef, "UnknownOutcome", canonicalRequestHash(ack as JsonValue)]);
          await terminal(tx, owned, "UnknownOutcome", baseline.revision, ["AROMA_VERIFICATION_INVALID"], source);
        });
      }
      return "attempted";
    } catch (error) {
      if (error instanceof OwnershipLost) return attempt === undefined ? "idle" : "attempted";
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      lost.abort();
      try {await finishHeartbeat();}
      finally {running = false;}
    }
  }
  async function runOnce(gateway: Gateway, signal: AbortSignal): Promise<"idle" | "attempted"> {
    return telemetry ? telemetry.observe("aroma.convergence.attempt", () => runOnceCore(gateway, signal)) : runOnceCore(gateway, signal);
  }
  return {recover, handleWake, runOnce};
}
