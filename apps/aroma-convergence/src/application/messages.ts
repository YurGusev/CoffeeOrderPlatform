import { isAromaOwnerMessage } from "@coffee-platform/contracts-aroma-v1";
import type { KafkaEnvelope } from "@coffee-platform/kafka-runtime";

export function decodeAromaConvergenceEnvelope(value: unknown): KafkaEnvelope {
  if (
    !isAromaOwnerMessage(value) ||
    (value as KafkaEnvelope).messageType !== "AromaConvergenceRequested.v1"
  )
    throw new TypeError("AROMA_CONVERGENCE_ENVELOPE_INVALID");
  const envelope = value as KafkaEnvelope;
  const payload = envelope.payload as {
    cartScopeRef: string;
    desiredRevision: string;
  };
  if (envelope.aggregate.ref !== payload.cartScopeRef) {
    throw new TypeError("AROMA_CONVERGENCE_KEY_INVALID");
  }
  return envelope;
}

export function assertAromaResultEnvelope(
  value: unknown,
  observation: boolean,
): asserts value is KafkaEnvelope {
  if (
    !isAromaOwnerMessage(value) ||
    (value as KafkaEnvelope).messageType !==
      (observation
        ? "AromaObservationChanged.v1"
        : "AromaConvergenceChanged.v1")
  ) {
    throw new TypeError("AROMA_CONVERGENCE_EVENT_INVALID");
  }
}
