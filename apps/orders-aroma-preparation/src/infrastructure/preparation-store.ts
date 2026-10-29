import { randomBytes, randomUUID } from "node:crypto";
import {
  withTransaction,
  type Database,
  type SqlScalar,
  type Transaction,
} from "@coffee-platform/database";
import { defineStatement } from "@coffee-platform/database/owner";
import { isAromaOwnerMessage } from "@coffee-platform/contracts-aroma-v1";
import { canonicalJson, type JsonValue } from "@coffee-platform/idempotency";
import { InboxProcessingError } from "@coffee-platform/inbox";
import type {
  KafkaEnvelope,
  KafkaRecord,
} from "@coffee-platform/kafka-runtime";
import { createSqlOutboxStore } from "@coffee-platform/outbox";
import { toInstant } from "@coffee-platform/platform-time";
import { decodeAromaPreparationEnvelope } from "../application/messages.js";
import {
  AromaPreparationError,
  buildDesired,
  jsonHash,
  type DesiredPlan,
} from "../domain/desired.js";
import {
  projectAromaCard,
  type CurrentDesired,
  type ScopeFacts,
} from "../domain/projection.js";
import type { AromaPreparationTelemetry } from "../observability.js";
import {
  decodePreparationAttemptRow,
  decodePreparationBarrierRow,
  decodePreparationBooleanRow,
  decodePreparationClockRow,
  decodePreparationContributionLine,
  decodePreparationContributionRow,
  decodePreparationDesiredRow,
  decodePreparationEnvelopeRow,
  decodePreparationExactRow,
  decodePreparationLeaseRow,
  decodePreparationLockRow,
  decodePreparationMappingRow,
  decodePreparationObservedRow,
  decodePreparationOrderRow,
  decodePreparationPresenceRow,
  decodePreparationRevisionRow,
  decodePreparationSequenceRow,
  decodePreparationWrittenRow,
  decodePreparationWorkRow,
} from "./row-schemas.js";

export type AromaPreparationOptions = Readonly<{
  batchSize: number;
  maxOrders: number;
  maxLines: number;
  maxSnapshotAgeMs: number;
}>;
export type AromaPreparationStore = Readonly<{
  handle(
    transaction: Transaction,
    envelope: KafkaEnvelope,
    source: Pick<KafkaRecord, "key">,
    signal: AbortSignal,
  ): Promise<void>;
  recover(signal: AbortSignal): Promise<void>;
  runOnce(signal: AbortSignal): Promise<"idle" | "prepared">;
}>;
function permanent(reason: string): never {
  throw new InboxProcessingError({ kind: "permanent", reason });
}
function messageRef(ms: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value =
    (BigInt(ms) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = alphabet[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `msg_${suffix}`;
}
function instant(value: string): string {
  return toInstant(value.replace(" ", "T")).toString();
}

/** No Inbox ownership here: handle runs inside the real Kafka binding's acquired
 * transaction. Every lock, revision, projection, history and Outbox is local to
 * Orders. This module has no Gateway/network dependency. */
export function createAromaPreparationStore(
  database: Database,
  options: AromaPreparationOptions,
  telemetry?: AromaPreparationTelemetry,
): AromaPreparationStore {
  for (const value of Object.values(options))
    if (
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value >= Number.MAX_SAFE_INTEGER
    )
      throw new AromaPreparationError("AROMA_PREPARATION_OPTIONS_INVALID");
  for (const key of [
    "batchSize",
    "maxOrders",
    "maxLines",
    "maxSnapshotAgeMs",
  ] as const)
    if (options[key] === undefined)
      throw new AromaPreparationError("AROMA_PREPARATION_OPTIONS_INVALID");
  const config = { ...options };
  const sql = <Row>(text: string, decode: (value: unknown) => Row) => {
    const execute = defineStatement<unknown, readonly SqlScalar[]>(
      database,
      text,
    );
    return async (
      transaction: Transaction,
      parameters: readonly SqlScalar[],
    ) => {
      const result = await execute(transaction, parameters);
      return { ...result, rows: result.rows.map(decode) };
    };
  };
  const command = (text: string) =>
    defineStatement<never, readonly SqlScalar[]>(database, text);
  const lock = sql(
    "SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))) AS acquired",
    decodePreparationLockRow,
  );
  const clock = sql(
    "SELECT clock_timestamp()::text AS now,(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms",
    decodePreparationClockRow,
  );
  const readMapping = sql(
    `SELECT mapping_revision::text,catalog_snapshot_revision::text,payload_hash FROM orders.catalog_mapping_projection
    WHERE product_ref=$1 AND variant_ref=$2 FOR UPDATE`,
    decodePreparationMappingRow,
  );
  const saveMapping =
    command(`INSERT INTO orders.catalog_mapping_projection(product_ref,variant_ref,offer_ref,mapping_revision,catalog_snapshot_revision,mapping_state,availability,effective_at,source_message_id,payload_hash)
    VALUES($1,$2,$3,$4::bigint,$5::bigint,$6,$7,$8::timestamptz,$9,$10)
    ON CONFLICT(product_ref,variant_ref) DO UPDATE SET offer_ref=EXCLUDED.offer_ref,mapping_revision=EXCLUDED.mapping_revision,
      catalog_snapshot_revision=EXCLUDED.catalog_snapshot_revision,mapping_state=EXCLUDED.mapping_state,availability=EXCLUDED.availability,
      effective_at=EXCLUDED.effective_at,source_message_id=EXCLUDED.source_message_id,payload_hash=EXCLUDED.payload_hash`);
  const contributions = sql(
    `SELECT c.order_ref,c.contribution_revision::text,c.order_version::text FROM orders.order_desired_contributions c
    JOIN orders.orders o USING(order_ref) WHERE c.state='Current' AND o.status='Confirmed' ORDER BY c.order_ref LIMIT $1`,
    decodePreparationContributionRow,
  );
  const contributionLines = sql(
    `WITH bounded AS (
    SELECT l.* FROM orders.order_desired_contribution_lines l JOIN orders.order_desired_contributions c USING(order_ref,contribution_revision)
    JOIN orders.orders o USING(order_ref) WHERE c.state='Current' AND o.status='Confirmed'
    ORDER BY l.order_ref,l.offer_ref,l.source_grind_key_hash NULLS FIRST LIMIT $1
  ) SELECT l.order_ref,l.contribution_revision::text,l.offer_ref,l.source_grind_key_hash,l.quantity_milli::text,l.contribution_hash,l.item_refs,
    json_agg(json_build_object('itemRef',refs.ref,'found',i.item_ref IS NOT NULL,'productRef',i.product_ref,'variantRef',i.variant_ref,
      'offerRef',i.offer_ref,'grind',i.source_grind_key_hash,'quantity',i.quantity_milli::text,'mappingOffer',m.offer_ref,
      'mappingRevision',m.mapping_revision::text,'mappingState',m.mapping_state,'availability',m.availability) ORDER BY refs.ref) AS items
    FROM bounded l CROSS JOIN LATERAL unnest(l.item_refs) refs(ref)
    LEFT JOIN orders.order_items i ON i.order_ref=l.order_ref AND i.item_ref=refs.ref
    LEFT JOIN orders.catalog_mapping_projection m ON m.product_ref=i.product_ref AND m.variant_ref=i.variant_ref
    GROUP BY l.line_id,l.order_ref,l.contribution_revision,l.offer_ref,l.source_grind_key_hash,l.quantity_milli,l.contribution_hash,l.item_refs
    ORDER BY l.order_ref,l.offer_ref,l.source_grind_key_hash NULLS FIRST`,
    decodePreparationContributionLine,
  );
  const desired = sql(
    "SELECT desired_revision::text,desired_hash,created_at::text FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'",
    decodePreparationDesiredRow,
  );
  const nextDesired = sql(
    "SELECT (COALESCE(max(desired_revision),0)+1)::text AS revision FROM orders.cart_desired_revisions WHERE cart_scope_ref='aroma-primary'",
    decodePreparationRevisionRow,
  );
  const supersede = command(
    "UPDATE orders.cart_desired_revisions SET state='Superseded' WHERE cart_scope_ref='aroma-primary' AND state='Current'",
  );
  const insertDesired = sql(
    "INSERT INTO orders.cart_desired_revisions(cart_scope_ref,desired_revision,state,desired_hash,source_max_order_version) VALUES('aroma-primary',$1::bigint,'Current',$2,$3::bigint) RETURNING desired_revision::text,desired_hash,created_at::text",
    decodePreparationDesiredRow,
  );
  const insertLines =
    command(`INSERT INTO orders.cart_desired_lines(cart_scope_ref,desired_revision,offer_ref,source_grind_key_hash,quantity_milli,contribution_hash,contributing_order_refs)
    SELECT 'aroma-primary',$1::bigint,x->>'offerRef',x->>'sourceGrindKeyHash',(x->>'quantityMilli')::bigint,x->>'contributionHash',x->'contributingOrderRefs'
    FROM jsonb_array_elements($2::jsonb) x`);
  const insertBlockers =
    command(`INSERT INTO orders.cart_desired_blockers(cart_scope_ref,desired_revision,order_ref,product_ref,variant_ref,code,mapping_revision)
    SELECT 'aroma-primary',$1::bigint,x->>'orderRef',x->>'productRef',x->>'variantRef',x->>'code',(x->>'mappingRevision')::bigint FROM jsonb_array_elements($2::jsonb) x`);
  const insertFacts =
    command(`INSERT INTO orders.cart_desired_order_facts(cart_scope_ref,desired_revision,order_ref,contribution_revision,contribution_hash)
    SELECT 'aroma-primary',$1::bigint,x->>'orderRef',(x->>'contributionRevision')::bigint,x->>'contributionHash' FROM jsonb_array_elements($2::jsonb) x`);
  const sequence = sql(
    "SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence FROM orders.outbox_messages WHERE aggregate_ref=$1",
    decodePreparationSequenceRow,
  );
  const wake =
    command(`INSERT INTO orders.convergence_work(cart_scope_ref,desired_revision,dirty,wake_revision,reason,next_attempt_at)
    VALUES('aroma-primary',$1::bigint,true,1,$2,clock_timestamp()) ON CONFLICT(cart_scope_ref) DO UPDATE SET
    desired_revision=EXCLUDED.desired_revision,dirty=true,wake_revision=orders.convergence_work.wake_revision+1,reason=EXCLUDED.reason,
    next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()`);
  const work = sql(
    "SELECT desired_revision::text,dirty FROM orders.convergence_work WHERE cart_scope_ref='aroma-primary'",
    decodePreparationWorkRow,
  );
  const impacted = sql(
    `SELECT o.order_ref,o.version::text,o.status FROM orders.orders o WHERE o.status='Confirmed' AND (
    EXISTS(SELECT 1 FROM orders.cart_desired_order_facts f WHERE f.order_ref=o.order_ref AND f.cart_scope_ref='aroma-primary') OR
    EXISTS(SELECT 1 FROM orders.order_desired_contributions c WHERE c.order_ref=o.order_ref AND c.state='Current') OR
    EXISTS(SELECT 1 FROM orders.order_aroma_projections p WHERE p.order_ref=o.order_ref AND p.cart_scope_ref='aroma-primary'))
    ORDER BY o.order_ref LIMIT $1`,
    decodePreparationOrderRow,
  );
  const observed = sql(
    `SELECT observed_revision::text,cart_fingerprint,captured_at::text,
    complete AND captured_at<=clock_timestamp() AND captured_at>=clock_timestamp()-($1::bigint*interval '1 millisecond') AS fresh
    FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary' AND state='Current'`,
    decodePreparationObservedRow,
  );
  const lease = sql(
    "SELECT fence_epoch::text,owner_instance_id::text,expires_at>clock_timestamp() AS active FROM orders.convergence_leases WHERE cart_scope_ref='aroma-primary'",
    decodePreparationLeaseRow,
  );
  const attempt = sql(
    `SELECT attempt_ref,desired_revision::text,desired_hash,fence_epoch::text,state,owner_instance_id::text,
    observed_start_revision::text,observed_end_revision::text,failure_code,blocker_codes FROM orders.convergence_attempts
    WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1::bigint ORDER BY fence_epoch DESC,started_at DESC,attempt_ref DESC LIMIT 1`,
    decodePreparationAttemptRow,
  );
  const reservations = sql(
    `SELECT
    EXISTS(SELECT 1 FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' AND state IN('Reserved','Dispatched','Acknowledged','UnknownOutcome')) AS unresolved,
    EXISTS(SELECT 1 FROM orders.mutation_reservations WHERE cart_scope_ref='aroma-primary' AND state='UnknownOutcome') AS unknown`,
    decodePreparationBarrierRow,
  );
  const exactLines = sql(
    `WITH wanted AS (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_desired_lines WHERE cart_scope_ref='aroma-primary' AND desired_revision=$1::bigint),
    actual AS (SELECT offer_ref,source_grind_key_hash,quantity_milli FROM orders.cart_observed_lines WHERE cart_scope_ref='aroma-primary' AND observed_revision=$2::bigint)
    SELECT NOT EXISTS((SELECT * FROM wanted EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM wanted)) AS exact`,
    decodePreparationExactRow,
  );
  const writeCard = sql(
    `SELECT projection_version::text,material_change,
    snapshot || jsonb_build_object(
      'projection_version',snapshot->>'projection_version','desired_revision',snapshot->>'desired_revision',
      'observed_revision',snapshot->>'observed_revision','verified_desired_revision',snapshot->>'verified_desired_revision',
      'verified_observed_revision',snapshot->>'verified_observed_revision','fence_epoch',snapshot->>'fence_epoch') AS snapshot
    FROM orders.write_card_projection($1,$2::jsonb)`,
    decodePreparationWrittenRow,
  );
  const history = command(
    "INSERT INTO orders.order_aroma_projection_history(order_ref,projection_version,projection) VALUES($1,$2::bigint,$3::jsonb)",
  );
  // Orders serializes timestamps to milliseconds; DB facts retain microseconds.
  const confirm = sql(
    `SELECT EXISTS(SELECT 1 FROM orders.order_desired_contributions c JOIN orders.orders o USING(order_ref)
    WHERE c.order_ref=$1 AND c.contribution_revision=$2::bigint AND c.order_version=$3::bigint AND c.state='Current'
      AND o.status='Confirmed' AND o.customer_ref=$4 AND date_trunc('milliseconds',o.confirmed_at)=$5::timestamptz) AS valid`,
    decodePreparationBooleanRow,
  );
  const validIntent = sql(
    `SELECT EXISTS(SELECT 1 FROM orders.orders o JOIN orders.order_history h USING(order_ref)
    JOIN orders.outbox_messages b ON b.aggregate_ref=o.order_ref AND b.owner_version=h.order_version::text
    WHERE o.order_ref=$1 AND o.status='Confirmed' AND o.version >= $2::bigint AND h.event_type='ReconciliationRequested'
      AND h.order_version=$2::bigint AND date_trunc('milliseconds',h.occurred_at)=$3::timestamptz AND b.message_id=$4
      AND b.message_type='OrderReconciliationRequested.v1' AND b.envelope=$5::jsonb) AS valid`,
    decodePreparationBooleanRow,
  );
  // Accepted intent is recoverable even if Kafka/Inbox retention removed a delivery.
  // Causation in the immutable cart Outbox is the durable per-intent dedup marker.
  const pendingIntents = sql(
    `SELECT b.envelope FROM orders.outbox_messages b JOIN orders.orders o ON o.order_ref=b.aggregate_ref
    JOIN orders.order_history h ON h.order_ref=o.order_ref AND h.order_version=b.owner_version::bigint AND h.event_type='ReconciliationRequested'
    WHERE b.message_type='OrderReconciliationRequested.v1' AND o.status='Confirmed' AND NOT EXISTS(
      SELECT 1 FROM orders.outbox_messages sent WHERE sent.message_type='AromaConvergenceRequested.v1' AND sent.causation_id=b.message_id)
    ORDER BY h.occurred_at,b.message_id LIMIT $1`,
    decodePreparationEnvelopeRow,
  );
  const alreadyWoken = sql(
    "SELECT EXISTS(SELECT 1 FROM orders.outbox_messages WHERE message_type='AromaConvergenceRequested.v1' AND causation_id=$1) AS present",
    decodePreparationPresenceRow,
  );
  const outbox = createSqlOutboxStore(database, {
    schema: "orders",
    envelopeBytes: true,
  });

  async function emit(
    tx: Transaction,
    payload: JsonValue,
    realtimeOrder?: Readonly<{ ref: string; version: string }>,
    source?: KafkaEnvelope,
  ): Promise<void> {
    const time = (await clock(tx, [])).rows[0]!;
    const aggregateRef = realtimeOrder?.ref ?? "aroma-primary";
    const aggregateSequence = (await sequence(tx, [aggregateRef])).rows[0]!
      .sequence;
    const ownerVersion = realtimeOrder?.version ?? aggregateSequence;
    const messageType = realtimeOrder
      ? "RealtimeInvalidated.v1"
      : "AromaConvergenceRequested.v1";
    const messageId = messageRef(time.ms);
    const envelope = {
      envelopeVersion: "1",
      messageId,
      messageType,
      occurredAt: instant(time.now),
      producer: "orders-aroma-preparation",
      correlationId: source?.correlationId ?? randomUUID(),
      causationId: source?.messageId ?? null,
      traceparent:
        source?.traceparent ??
        `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
      aggregate: {
        type: realtimeOrder ? "Order" : "AromaCart",
        ref: aggregateRef,
        version: ownerVersion,
      },
      payload,
    };
    if (!isAromaOwnerMessage(envelope))
      throw new AromaPreparationError("AROMA_PREPARATION_OUTBOX_INVALID");
    const result = await outbox.enqueue(tx, {
      messageId,
      messageType,
      topic: realtimeOrder
        ? "coffee.realtime.invalidate.v1"
        : "coffee.aroma.cart.commands.v1",
      aggregateRef,
      aggregateSequence: BigInt(aggregateSequence),
      ownerVersion,
      partitionKey: aggregateRef,
      schemaVersion: "1",
      envelope: envelope as JsonValue,
      payload,
      occurredAt: envelope.occurredAt,
      correlationId: envelope.correlationId,
      ...(envelope.causationId === null
        ? {}
        : { causationId: envelope.causationId }),
      traceparent: envelope.traceparent,
    });
    if (result !== "created")
      throw new AromaPreparationError("AROMA_PREPARATION_OUTBOX_CONFLICT");
  }
  async function request(
    tx: Transaction,
    current: CurrentDesired | undefined,
    reason: string,
    source?: KafkaEnvelope,
  ): Promise<void> {
    await wake(tx, [current?.desired_revision ?? null, reason]);
    if (current)
      await emit(
        tx,
        {
          cartScopeRef: "aroma-primary",
          desiredRevision: current.desired_revision,
          reason,
          orderRef:
            source?.aggregate.type === "Order" ? source.aggregate.ref : null,
        },
        undefined,
        source,
      );
  }
  async function prepare(
    tx: Transaction,
    reason: string,
    source?: KafkaEnvelope,
  ): Promise<
    Readonly<{
      plan: DesiredPlan;
      current?: CurrentDesired & Readonly<{ created_at: string }>;
      changed: boolean;
    }>
  > {
    const inputs = (await contributions(tx, [config.maxOrders + 1])).rows;
    if (inputs.length > config.maxOrders)
      throw new AromaPreparationError("AROMA_PREPARATION_CARDINALITY");
    const lines = (await contributionLines(tx, [config.maxLines + 1])).rows;
    const plan = buildDesired(inputs, lines, config.maxOrders, config.maxLines);
    const previous = (await desired(tx, [])).rows[0];
    if (
      (!previous && inputs.length === 0) ||
      previous?.desired_hash === plan.hash
    ) {
      if (previous)
        telemetry?.desired(previous.desired_revision, previous.created_at);
      return {
        plan,
        ...(previous ? { current: previous } : {}),
        changed: false,
      };
    }
    const revision = (await nextDesired(tx, [])).rows[0]!.revision;
    await supersede(tx, []);
    const current = (
      await insertDesired(tx, [revision, plan.hash, plan.sourceMaxOrderVersion])
    ).rows[0]!;
    telemetry?.desired(current.desired_revision, current.created_at);
    await insertLines(tx, [revision, JSON.stringify(plan.lines)]);
    await insertBlockers(tx, [revision, JSON.stringify(plan.blockers)]);
    await insertFacts(tx, [revision, JSON.stringify(plan.orders)]);
    await request(tx, current, reason, source);
    return { plan, current, changed: true };
  }
  async function recompute(
    tx: Transaction,
    reason: string,
    source?: KafkaEnvelope,
  ) {
    try {
      const result = await (telemetry
        ? telemetry.observe("orders.aroma_preparation.recompute", () =>
            prepare(tx, reason, source),
          )
        : prepare(tx, reason, source));
      telemetry?.result("recompute", result.changed ? "changed" : "unchanged");
      return result;
    } catch (error) {
      telemetry?.result("recompute", "error");
      throw error;
    }
  }
  async function projectionsCore(
    tx: Transaction,
    plan: DesiredPlan,
    current: CurrentDesired | undefined,
    signal: AbortSignal,
    source?: KafkaEnvelope,
  ): Promise<boolean> {
    const orders = (await impacted(tx, [config.maxOrders + 1])).rows;
    if (orders.length > config.maxOrders)
      throw new AromaPreparationError("AROMA_PREPARATION_CARDINALITY");
    const obs = (await observed(tx, [config.maxSnapshotAgeMs])).rows[0];
    const currentLease = (await lease(tx, [])).rows[0];
    const currentAttempt = current
      ? (await attempt(tx, [current.desired_revision])).rows[0]
      : undefined;
    const barrier = (await reservations(tx, [])).rows[0]!;
    const matching =
      current && obs
        ? (
            await exactLines(tx, [
              current.desired_revision,
              obs.observed_revision,
            ])
          ).rows[0]!.exact
        : false;
    const facts: ScopeFacts = {
      ...(current ? { desired: current } : {}),
      ...(obs
        ? { observed: { ...obs, captured_at: instant(obs.captured_at) } }
        : {}),
      ...(currentAttempt ? { attempt: currentAttempt } : {}),
      fence_epoch: currentLease?.fence_epoch ?? null,
      owner_instance_id: currentLease?.owner_instance_id ?? null,
      lease_active: currentLease?.active ?? false,
      unresolved: barrier.unresolved,
      unknown: barrier.unknown,
      exactLines: matching,
    };
    let changed = false;
    // maxOrders/maxLines bound the owner transaction; no memory-only cursor can
    // strand a removed Order. All historical/current/previous projection refs join.
    for (const order of orders) {
      signal.throwIfAborted();
      const material = projectAromaCard(
        order.order_ref,
        plan,
        facts,
        source?.messageId ?? "aroma-preparation-recovery",
      );
      const result = (
        await writeCard(tx, [order.order_ref, JSON.stringify(material)])
      ).rows[0]!;
      if (!result.material_change) continue;
      changed = true;
      await history(tx, [
        order.order_ref,
        result.projection_version,
        canonicalJson(result.snapshot),
      ]);
      await emit(
        tx,
        {
          subjectType: "order",
          subjectRef: order.order_ref,
          ownerVersion: result.projection_version,
          reason: "AromaStateChanged",
        },
        { ref: order.order_ref, version: result.projection_version },
        source,
      );
    }
    return changed;
  }
  async function projections(
    tx: Transaction,
    plan: DesiredPlan,
    current: CurrentDesired | undefined,
    signal: AbortSignal,
    source?: KafkaEnvelope,
  ): Promise<boolean> {
    try {
      const changed = await (telemetry
        ? telemetry.observe("orders.aroma_preparation.projection", () =>
            projectionsCore(tx, plan, current, signal, source),
          )
        : projectionsCore(tx, plan, current, signal, source));
      telemetry?.result("projection", changed ? "changed" : "unchanged");
      return changed;
    } catch (error) {
      telemetry?.result("projection", "error");
      throw error;
    }
  }
  async function validateIntent(
    tx: Transaction,
    envelope: KafkaEnvelope,
  ): Promise<void> {
    const payload = envelope.payload as Record<string, string>;
    if (
      !(
        await validIntent(tx, [
          payload["orderRef"]!,
          payload["orderVersion"]!,
          payload["requestedAt"]!,
          envelope.messageId,
          canonicalJson(envelope as JsonValue),
        ])
      ).rows[0]!.valid
    )
      permanent("AROMA_RECONCILIATION_SOURCE_INVALID");
  }
  async function reconcile(
    tx: Transaction,
    envelope: KafkaEnvelope,
    current: CurrentDesired | undefined,
  ): Promise<boolean> {
    await validateIntent(tx, envelope);
    if ((await alreadyWoken(tx, [envelope.messageId])).rows[0]!.present)
      return false;
    if (!current) {
      const pending = (await work(tx, [])).rows[0];
      if (!pending || !pending.dirty)
        await wake(tx, [null, "OperatorRequested"]);
      return !pending || !pending.dirty;
    }
    await request(tx, current, "OperatorRequested", envelope);
    return true;
  }
  async function handleCore(
    tx: Transaction,
    input: KafkaEnvelope,
    source: Pick<KafkaRecord, "key">,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const envelope = decodeAromaPreparationEnvelope(input);
    if (source.key !== envelope.aggregate.ref)
      permanent("AROMA_PREPARATION_KEY_INVALID");
    await lock(tx, []);
    const payload = envelope.payload as Record<string, string | null>;
    let reason = "Recovery";
    if (envelope.messageType === "CatalogMappingChanged.v2") {
      const previous = (
        await readMapping(tx, [payload["productRef"]!, payload["variantRef"]!])
      ).rows[0];
      const revision = BigInt(payload["mappingRevision"]!);
      if (previous && revision < BigInt(previous.mapping_revision)) return;
      const hash = jsonHash(payload);
      if (previous && revision === BigInt(previous.mapping_revision)) {
        if (previous.payload_hash !== hash)
          permanent("AROMA_MAPPING_REVISION_CONFLICT");
        return;
      }
      if (
        previous &&
        BigInt(payload["catalogSnapshotRevision"]!) <
          BigInt(previous.catalog_snapshot_revision)
      )
        permanent("AROMA_MAPPING_SNAPSHOT_REGRESSION");
      await saveMapping(tx, [
        payload["productRef"]!,
        payload["variantRef"]!,
        payload["offerRef"] ?? null,
        payload["mappingRevision"]!,
        payload["catalogSnapshotRevision"]!,
        payload["mappingState"]!,
        payload["availability"]!,
        payload["effectiveAt"]!,
        envelope.messageId,
        hash,
      ]);
      reason = "CatalogChanged";
    } else if (envelope.messageType === "OrderConfirmed.v1") {
      if (
        !(
          await confirm(tx, [
            payload["orderRef"]!,
            payload["contributionRevision"]!,
            payload["orderVersion"]!,
            payload["customerRef"]!,
            payload["confirmedAt"]!,
          ])
        ).rows[0]!.valid
      )
        permanent("AROMA_CONFIRMATION_SOURCE_INVALID");
      reason = "OrderConfirmed";
    } else if (envelope.messageType === "OrderReconciliationRequested.v1") {
      // Reject a forged/stale accepted-command chain before any Desired effect.
      await validateIntent(tx, envelope);
      reason = "OperatorRequested";
      // The accepted core History/Outbox retains the intent while cart facts
      // are pending. Never acknowledge its Inbox before creating a real wake.
      if (!(await desired(tx, [])).rows[0])
        throw new InboxProcessingError({
          kind: "transient",
          reason: "AROMA_RECONCILIATION_FACTS_PENDING",
        });
    }
    const prepared = await recompute(tx, reason, envelope);
    if (envelope.messageType === "OrderReconciliationRequested.v1")
      await reconcile(tx, envelope, prepared.current);
    await projections(tx, prepared.plan, prepared.current, signal, envelope);
  }
  async function handle(
    tx: Transaction,
    input: KafkaEnvelope,
    source: Pick<KafkaRecord, "key">,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await (telemetry
        ? telemetry.observe("orders.aroma_preparation.inbox", () =>
            handleCore(tx, input, source, signal),
          )
        : handleCore(tx, input, source, signal));
      const type = input.messageType;
      telemetry?.result(
        "inbox",
        type === "CatalogMappingChanged.v2"
          ? "catalog_changed"
          : type === "OrderConfirmed.v1"
            ? "order_confirmed"
            : type === "OrderReconciliationRequested.v1"
              ? "reconciliation_requested"
              : "other",
      );
    } catch (error) {
      telemetry?.result("inbox", "error");
      throw error;
    }
  }
  async function runOnceCore(
    signal: AbortSignal,
  ): Promise<"idle" | "prepared"> {
    signal.throwIfAborted();
    return withTransaction(
      database,
      { mode: "background", signal },
      async (tx) => {
        await lock(tx, []);
        const prepared = await recompute(tx, "Recovery");
        let changed = prepared.changed;
        const intents = (await pendingIntents(tx, [config.batchSize])).rows;
        for (const intent of intents) {
          signal.throwIfAborted();
          const envelope = decodeAromaPreparationEnvelope(intent.envelope);
          changed =
            (await reconcile(tx, envelope, prepared.current)) || changed;
        }
        // Repair a durable wake lost before delivery/retention, without blindly
        // waking an already-completed same-hash Desired on every poll.
        if (prepared.current) {
          const pending = (await work(tx, [])).rows[0];
          if (
            !pending ||
            pending.desired_revision !== prepared.current.desired_revision
          ) {
            await request(tx, prepared.current, "Recovery");
            changed = true;
          }
        }
        changed =
          (await projections(tx, prepared.plan, prepared.current, signal)) ||
          changed;
        return changed ? "prepared" : "idle";
      },
    );
  }
  async function runOnce(signal: AbortSignal): Promise<"idle" | "prepared"> {
    try {
      const result = await (telemetry
        ? telemetry.observe("orders.aroma_preparation.recovery", () =>
            runOnceCore(signal),
          )
        : runOnceCore(signal));
      telemetry?.result(
        "recovery",
        result === "prepared" ? "completed" : "idle",
      );
      return result;
    } catch (error) {
      telemetry?.result("recovery", "error");
      throw error;
    }
  }
  return {
    handle,
    runOnce,
    async recover(signal) {
      await runOnce(signal);
    },
  };
}
