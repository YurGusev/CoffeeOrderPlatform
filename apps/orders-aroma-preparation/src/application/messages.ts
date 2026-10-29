import { isAromaOwnerMessage } from "@coffee-platform/contracts-aroma-v1";
import type { KafkaEnvelope } from "@coffee-platform/kafka-runtime";

const MAX_INT64 = 9_223_372_036_854_775_807n;
function invalid(): never {
  throw new TypeError("AROMA_PREPARATION_ENVELOPE_INVALID");
}
function version(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value) ||
    BigInt(value) > MAX_INT64
  )
    invalid();
  return value;
}

/** Canonical bundled schemas first; metadata follows the actual producer, not
 * the business mapping revision or terminal-hint observed revision. */
export function decodeAromaPreparationEnvelope(value: unknown): KafkaEnvelope {
  if (!isAromaOwnerMessage(value)) invalid();
  const envelope = value as KafkaEnvelope<Record<string, unknown>>;
  const payload = envelope.payload;
  version(envelope.aggregate.version);
  switch (envelope.messageType) {
    case "CatalogMappingChanged.v2":
      if (
        envelope.aggregate.type !== "CatalogMapping" ||
        envelope.aggregate.ref !== payload["productRef"]
      )
        invalid();
      // Catalog aggregate sequence is independent of mappingRevision.
      break;
    case "OrderConfirmed.v1":
    case "OrderReconciliationRequested.v1":
      if (
        envelope.aggregate.type !== "Order" ||
        envelope.aggregate.ref !== payload["orderRef"] ||
        envelope.aggregate.version !== version(payload["orderVersion"])
      )
        invalid();
      if (envelope.messageType === "OrderConfirmed.v1")
        version(payload["contributionRevision"]);
      break;
    case "AromaObservationChanged.v1":
      if (
        envelope.aggregate.type !== "AromaCart" ||
        envelope.aggregate.ref !== payload["cartScopeRef"]
      )
        invalid();
      version(payload["observedRevision"]);
      // Observer uses Observed revision; convergence uses its cart event sequence.
      if (
        envelope.producer === "aroma-observer" &&
        envelope.aggregate.version !== payload["observedRevision"]
      )
        invalid();
      break;
    case "AromaConvergenceChanged.v1":
      if (
        envelope.aggregate.type !== "AromaCart" ||
        envelope.aggregate.ref !== payload["cartScopeRef"]
      )
        invalid();
      version(payload["desiredRevision"]);
      // Zero Observed is a legitimate terminal failure before any successful GET.
      break;
    default:
      invalid();
  }
  for (const name of [
    "mappingRevision",
    "catalogSnapshotRevision",
    "observedRevision",
  ]) {
    const revision = payload[name];
    if (
      revision !== undefined &&
      (typeof revision !== "string" ||
        !/^(0|[1-9][0-9]*)$/u.test(revision) ||
        BigInt(revision) > MAX_INT64)
    )
      invalid();
  }
  return envelope;
}
