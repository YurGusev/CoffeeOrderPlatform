import { Ajv2020 } from "ajv/dist/2020.js";
import { Temporal } from "@js-temporal/polyfill";
import { ordersAromaMessageSchemas } from "@coffee-platform/generated-internal-v1/message-schemas.gen.js";
import {
  KafkaRuntimeError,
  type KafkaEnvelope,
  type KafkaRecord,
} from "@coffee-platform/kafka-runtime";

export type Invalidation = Readonly<{
  subjectType: "order";
  subjectRef: string;
  ownerVersion: string;
  reason: "OrderChanged" | "AromaStateChanged";
  correlationId: string;
}>;
export type RealtimeEnvelope = KafkaEnvelope<
  Omit<Invalidation, "correlationId">
>;
export const REALTIME_TOPIC = "coffee.realtime.invalidate.v1";
export const REALTIME_GROUP = "realtime-gateway-v1";
export const MESSAGE_ID = /^msg_[0-9A-HJKMNP-TV-Z]{26}$/u;
const MAX_VERSION = 9_223_372_036_854_775_807n;
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    try {
      Temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  },
});
for (const schema of Object.values(ordersAromaMessageSchemas))
  ajv.addSchema(schema);
const validate = ajv.getSchema(
  "https://coffeeorderplatform.local/contracts/schemas/events/realtime-invalidated.v1.schema.json",
);
if (validate === undefined)
  throw new Error("REALTIME_CANONICAL_SCHEMA_MISSING");
export function invalidRealtimeRecord(): never {
  throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID");
}
export function eventData(envelope: RealtimeEnvelope): Invalidation {
  const { subjectType, subjectRef, ownerVersion, reason } = envelope.payload;
  return {
    subjectType,
    subjectRef,
    ownerVersion,
    reason,
    correlationId: envelope.correlationId,
  };
}
export function invalidationFrame(envelope: RealtimeEnvelope): string {
  return `id: ${envelope.messageId}\nevent: resource-invalidated.v1\nretry: 3000\ndata: ${JSON.stringify(eventData(envelope))}\n\n`;
}
/** Strict bundled canonical schema, then producer/aggregate/transport binding. */
export function decodeRealtimeEnvelope(
  value: unknown,
  record: KafkaRecord,
  maxEventDataBytes: number,
): RealtimeEnvelope {
  if (!validate!(value)) invalidRealtimeRecord();
  const envelope = value as RealtimeEnvelope;
  if (
    record.topic !== REALTIME_TOPIC ||
    record.key !== envelope.payload.subjectRef ||
    envelope.aggregate.type !== "Order" ||
    envelope.aggregate.ref !== envelope.payload.subjectRef ||
    envelope.aggregate.version !== envelope.payload.ownerVersion ||
    envelope.payload.ownerVersion.length > 19 ||
    BigInt(envelope.payload.ownerVersion) > MAX_VERSION ||
    Buffer.byteLength(JSON.stringify(eventData(envelope)), "utf8") >
      maxEventDataBytes
  )
    invalidRealtimeRecord();
  return envelope;
}
