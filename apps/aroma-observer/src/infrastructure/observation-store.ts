import {randomBytes, randomUUID} from "node:crypto";
import {DatabaseTransactionError, withTransaction, type Database, type SqlScalar, type Transaction} from "@coffee-platform/database";
import {defineStatement} from "@coffee-platform/database/owner";
import {isAromaOwnerMessage, normalizeAromaCartSnapshot, type NormalizedAromaCartSnapshot} from "@coffee-platform/contracts-aroma-v1";
import {createSqlOutboxStore} from "@coffee-platform/outbox";
import type {AromaObserverGatewayClient} from "../gateway-client.js";
import type {AromaObserverTelemetry} from "../observability.js";
import {decodeObserverBooleanRow, decodeObserverClockRow, decodeObserverLockRow, decodeObserverPermitRow,
  decodeObserverRevisionRow, decodeObserverSequenceRow} from "./row-schemas.js";

export type AromaObservationOptions = Readonly<{
  ownerInstanceId: string;
  intervalMs: number;
  leaseMs: number;
  maxSnapshotAgeMs: number;
  maxLines: number;
}>;
export type AromaObservationStore = Readonly<{
  recover(signal: AbortSignal): Promise<void>;
  runOnce(gateway: Pick<AromaObserverGatewayClient, "read">, signal: AbortSignal): Promise<"idle" | "observed" | "failed">;
}>;
class OwnershipLost extends Error {
  public constructor() {super("AROMA_OBSERVATION_OWNERSHIP_LOST");}
}
function messageRef(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${randomBytes(16).toString("hex")}`);
  let encoded = "";
  for (let i = 0; i < 26; i++) {encoded = alphabet[Number(value & 31n)]! + encoded; value >>= 5n;}
  return `msg_${encoded}`;
}
function validateOptions(options: AromaObservationOptions): void {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u.test(options.ownerInstanceId) ||
      [options.intervalMs, options.leaseMs, options.maxSnapshotAgeMs, options.maxLines]
        .some(value => !Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)) {
    throw new TypeError("AROMA_OBSERVATION_OPTIONS_INVALID");
  }
}

/** Orders-owned, safe-read-only observer. PostgreSQL owns scheduling, expiry and
 * revisions. The exact persisted lease timestamp is the per-claim fence: owner
 * identity alone would let a late callback overwrite a newer same-owner claim.
 * Neither recover nor a failed read changes the last complete Current fact. */
export function createAromaObservationStore(database: Database, options: AromaObservationOptions, telemetry?: AromaObserverTelemetry): AromaObservationStore {
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
  const lock = statement("SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('orders:aroma-primary'))) AS acquired", decodeObserverLockRow);
  const recoverSchedule = command(`INSERT INTO orders.observation_schedule
    (cart_scope_ref,next_observation_at) VALUES ('aroma-primary',clock_timestamp())
    ON CONFLICT (cart_scope_ref) DO NOTHING`);
  const claim = statement(`UPDATE orders.observation_schedule
    SET lease_owner=$1::uuid,lease_until=clock_timestamp()+$2*interval '1 millisecond',updated_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND next_observation_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    RETURNING lease_until::text`, decodeObserverPermitRow);
  const permit = statement(`SELECT EXISTS(SELECT 1 FROM orders.observation_schedule
    WHERE cart_scope_ref='aroma-primary' AND lease_owner=$1::uuid AND lease_until=$2::timestamptz
      AND lease_until>clock_timestamp()) AS valid`, decodeObserverBooleanRow);
  const freshness = statement(`SELECT ($1::timestamptz<=clock_timestamp()
    AND $1::timestamptz>=clock_timestamp()-$2*interval '1 millisecond'
    AND NOT EXISTS(SELECT 1 FROM orders.cart_observed_revisions
      WHERE cart_scope_ref='aroma-primary' AND state='Current' AND captured_at>$1::timestamptz)) AS valid`, decodeObserverBooleanRow);
  const nextRevision = statement(`SELECT (COALESCE(max(observed_revision),0)+1)::text AS revision
    FROM orders.cart_observed_revisions WHERE cart_scope_ref='aroma-primary'`, decodeObserverRevisionRow);
  const supersede = command(`UPDATE orders.cart_observed_revisions SET state='Superseded'
    WHERE cart_scope_ref='aroma-primary' AND state='Current'`);
  const insertRevision = command(`INSERT INTO orders.cart_observed_revisions
    (cart_scope_ref,observed_revision,state,provider_snapshot_ref,cart_fingerprint,captured_at,source_kind)
    VALUES ('aroma-primary',$1,'Current',$2,$3,$4::timestamptz,'Observer')`);
  const insertLines = command(`INSERT INTO orders.cart_observed_lines
    (cart_scope_ref,observed_revision,offer_ref,source_grind_key_hash,quantity_milli,sanitized_line_hash)
    SELECT 'aroma-primary',$1,line."offerRef",line."sourceGrindKeyHash",line."quantityMilli"::bigint,line."sanitizedLineHash"
    FROM jsonb_to_recordset($2::jsonb) AS line("offerRef" text,"sourceGrindKeyHash" text,"quantityMilli" text,"sanitizedLineHash" text)`);
  const nextSequence = statement(`SELECT (COALESCE(max(aggregate_sequence),0)+1)::text AS sequence
    FROM orders.outbox_messages WHERE aggregate_ref='aroma-primary'`, decodeObserverSequenceRow);
  const clock = statement(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`, decodeObserverClockRow);
  const reschedule = command(`UPDATE orders.observation_schedule SET
    next_observation_at=clock_timestamp()+$3*interval '1 millisecond',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE cart_scope_ref='aroma-primary' AND lease_owner=$1::uuid AND lease_until=$2::timestamptz
      AND lease_until>clock_timestamp()`);
  const outbox = createSqlOutboxStore(database, {schema: "orders", envelopeBytes: true});
  const transaction = <T>(signal: AbortSignal, callback: (tx: Transaction) => Promise<T>): Promise<T> =>
    withTransaction(database, {mode: "background", signal}, async tx => {await lock(tx, []); return callback(tx);});
  let running = false;

  async function recover(signal: AbortSignal): Promise<void> {
      // Restart preserves a live lease and a scheduled backoff; expired leases
      // are reclaimed by the same conditional claim, never by startup takeover.
      try {
        await (telemetry ? telemetry.observe("aroma.observer.recovery", () => transaction(signal, async tx => {await recoverSchedule(tx, []);})) : transaction(signal, async tx => {await recoverSchedule(tx, []);}));
        telemetry?.recovery("ready");
      } catch (error) {telemetry?.recovery("error"); throw error;}
    }
  async function runOnceCore(gateway: Pick<AromaObserverGatewayClient, "read">, signal: AbortSignal): Promise<"idle" | "observed" | "failed"> {
      if (running) return "idle";
      running = true;
      try {
        const acquired = (await (telemetry ? telemetry.observe("aroma.observer.lease", () => transaction(signal, tx => claim(tx, [config.ownerInstanceId, config.leaseMs]))) : transaction(signal, tx => claim(tx, [config.ownerInstanceId, config.leaseMs])))).rows[0];
        if (acquired === undefined) return "idle";
        const fence = [config.ownerInstanceId, acquired.lease_until] as const;
        // Final permit immediately before the single read. Both transactions
        // have committed/released connections and advisory locks before I/O.
        if ((await (telemetry ? telemetry.observe("aroma.observer.lease", () => transaction(signal, tx => permit(tx, fence))) : transaction(signal, tx => permit(tx, fence)))).rows[0]?.valid !== true) {telemetry?.fenceFailure(); return "idle";}
        const correlationId = randomUUID();
        const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
        let normalized: NormalizedAromaCartSnapshot | undefined;
        try {
          const value = await (telemetry ? telemetry.observe("aroma.observer.provider.read", () => gateway.read({signal, correlationId, traceparent})) : gateway.read({signal, correlationId, traceparent}));
          normalized = normalizeAromaCartSnapshot(value);
          if (normalized.lines.length > config.maxLines) normalized = undefined;
        } catch (error) {
          // Only the network/DTO phase is classified as a failed safe read.
          // DB and unknown-COMMIT errors always escape to runtime recovery.
          if (error instanceof DatabaseTransactionError) throw error;
          normalized = undefined;
        }
        try {
          const persist = () => transaction(signal, async tx => {
            if ((await permit(tx, fence)).rows[0]?.valid !== true) {telemetry?.fenceFailure(); return "idle" as const;}
            let result: "observed" | "failed" = "failed";
            if (normalized !== undefined &&
                (await freshness(tx, [normalized.snapshot.capturedAt, config.maxSnapshotAgeMs])).rows[0]?.valid === true) {
              const revision = (await nextRevision(tx, [])).rows[0]!.revision;
              await supersede(tx, []);
              await insertRevision(tx, [revision, normalized.snapshot.providerSnapshotRef,
                normalized.snapshot.cartFingerprint, normalized.snapshot.capturedAt]);
              // One bounded bulk statement keeps the completion transaction short
              // even at the configured maximum; absent grind remains SQL NULL.
              await insertLines(tx, [revision, JSON.stringify(normalized.lines)]);
              const occurredAt = (await clock(tx, [])).rows[0]!.now;
              const payload = {cartScopeRef: "aroma-primary", observedRevision: revision,
                observedAt: normalized.snapshot.capturedAt, observationState: "Complete", cartFingerprint: normalized.snapshot.cartFingerprint};
              const envelope = {envelopeVersion: "1", messageId: messageRef(), messageType: "AromaObservationChanged.v1",
                occurredAt, producer: "aroma-observer", correlationId, causationId: null, traceparent,
                aggregate: {type: "AromaCart", ref: "aroma-primary", version: revision}, payload};
              if (!isAromaOwnerMessage(envelope)) throw new Error("AROMA_OBSERVATION_EVENT_INVALID");
              const sequence = BigInt((await nextSequence(tx, [])).rows[0]!.sequence);
              const enqueued = await outbox.enqueue(tx, {messageId: envelope.messageId, messageType: envelope.messageType,
                topic: "coffee.aroma.cart.events.v1", aggregateRef: "aroma-primary", aggregateSequence: sequence,
                ownerVersion: revision, partitionKey: "aroma-primary", schemaVersion: "1", envelope, payload, occurredAt, correlationId, traceparent});
              if (enqueued !== "created") throw new Error("AROMA_OBSERVATION_OUTBOX_CONFLICT");
              result = "observed";
            }
            // Also fence after all writes: expiry inside the short completion
            // transaction rolls the entire Observed/lines/Outbox/schedule back.
            if ((await reschedule(tx, [...fence, config.intervalMs])).rowCount !== 1) throw new OwnershipLost();
            return result;
          });
          const result = await (telemetry ? telemetry.observe("aroma.observer.persist", persist) : persist());
          if (result === "observed" && normalized !== undefined) telemetry?.observed(normalized.snapshot.capturedAt);
          return result;
        } catch (error) {
          if (error instanceof OwnershipLost) {telemetry?.fenceFailure(); return "idle";}
          throw error;
        }
      } finally {running = false;}
    }
  async function runOnce(gateway: Pick<AromaObserverGatewayClient, "read">, signal: AbortSignal): Promise<"idle" | "observed" | "failed"> {
    try {
      const result = await (telemetry ? telemetry.observe("aroma.observer.observation", () => runOnceCore(gateway, signal)) : runOnceCore(gateway, signal));
      telemetry?.result(result);
      return result;
    } catch (error) {telemetry?.result("failed"); throw error;}
  }
  return {recover, runOnce};
}
