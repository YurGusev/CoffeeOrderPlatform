export type KafkaHeaders = Readonly<Record<string, string>>;
export type KafkaEnvelope<Payload = unknown> = Readonly<{
  messageId: string;
  messageType: string;
  schemaVersion: string;
  aggregateRef: string;
  aggregateVersion?: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  traceparent: string;
  payload: Payload;
}>;

export type KafkaRecord = Readonly<{
  topic: string;
  partition: number;
  offset: string;
  key: string;
  value: unknown;
  headers: KafkaHeaders;
}>;

export class KafkaRuntimeError extends Error {
  public readonly code: "KAFKA_CONFIG_INVALID" | "KAFKA_ENVELOPE_INVALID" | "KAFKA_HANDLER_FAILED";

  public constructor(code: KafkaRuntimeError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KafkaRuntimeError";
    this.code = code;
  }
}

export type KafkaRuntimeConfig = Readonly<{
  brokers: readonly string[];
  clientId: string;
  autoTopicCreation: false;
  maxInFlight: number;
}>;

export function validateKafkaRuntimeConfig(value: unknown): KafkaRuntimeConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", "Kafka config должен быть объектом");
  const source = value as Record<string, unknown>;
  const expected = ["brokers", "clientId", "autoTopicCreation", "maxInFlight"] as const;
  for (const key of Object.keys(source)) if (!(expected as readonly string[]).includes(key)) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", `неизвестный Kafka key ${key}`);
  for (const key of expected) if (!Object.hasOwn(source, key)) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", `отсутствует Kafka key ${key}`);
  if (!Array.isArray(source["brokers"]) || source["brokers"].length === 0 || source["brokers"].some((broker) => typeof broker !== "string" || broker.length === 0)) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", "brokers должны быть непустым массивом строк");
  if (typeof source["clientId"] !== "string" || source["clientId"].length === 0) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", "clientId должен быть непустой строкой");
  if (source["autoTopicCreation"] !== false) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", "auto topic creation должен быть выключен");
  if (typeof source["maxInFlight"] !== "number" || !Number.isSafeInteger(source["maxInFlight"]) || source["maxInFlight"] <= 0) throw new KafkaRuntimeError("KAFKA_CONFIG_INVALID", "maxInFlight должен быть положительным целым числом");
  return Object.freeze({brokers: [...source["brokers"]], clientId: source["clientId"], autoTopicCreation: false, maxInFlight: source["maxInFlight"]});
}

export type PayloadParser<Payload> = (value: unknown) => Payload;

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", `${key} должен быть непустой строкой`);
  return value;
}

export function parseEnvelope<Payload>(value: unknown, parsePayload: PayloadParser<Payload>): KafkaEnvelope<Payload> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", "Kafka envelope должен быть объектом");
  const source = value as Record<string, unknown>;
  const expected = ["messageId", "messageType", "schemaVersion", "aggregateRef", "aggregateVersion", "occurredAt", "correlationId", "causationId", "traceparent", "payload"] as const;
  for (const key of Object.keys(source)) if (!(expected as readonly string[]).includes(key)) throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", `неизвестное поле ${key}`);
  for (const key of ["messageId", "messageType", "schemaVersion", "aggregateRef", "occurredAt", "correlationId", "traceparent"] as const) {
    if (!Object.hasOwn(source, key)) throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", `отсутствует поле ${key}`);
  }
  if (Object.hasOwn(source, "aggregateVersion") && source["aggregateVersion"] !== undefined && typeof source["aggregateVersion"] !== "string") throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", "aggregateVersion должен быть строкой");
  if (Object.hasOwn(source, "causationId") && source["causationId"] !== undefined && typeof source["causationId"] !== "string") throw new KafkaRuntimeError("KAFKA_ENVELOPE_INVALID", "causationId должен быть строкой");
  return Object.freeze({
    messageId: stringField(source, "messageId"),
    messageType: stringField(source, "messageType"),
    schemaVersion: stringField(source, "schemaVersion"),
    aggregateRef: stringField(source, "aggregateRef"),
    ...(source["aggregateVersion"] === undefined ? {} : {aggregateVersion: stringField(source, "aggregateVersion")}),
    occurredAt: stringField(source, "occurredAt"),
    correlationId: stringField(source, "correlationId"),
    ...(source["causationId"] === undefined ? {} : {causationId: stringField(source, "causationId")}),
    traceparent: stringField(source, "traceparent"),
    payload: parsePayload(source["payload"]),
  });
}

export type KafkaProducer = Readonly<{
  send(topic: string, key: string, value: KafkaEnvelope): Promise<void>;
  close(): Promise<void>;
}>;
export type KafkaConsumer = Readonly<{
  subscribe(topics: readonly string[], groupId: string): Promise<void>;
  run(handler: (record: KafkaRecord) => Promise<void>): Promise<void>;
  commit(record: KafkaRecord): Promise<void>;
  close(): Promise<void>;
}>;

export async function processKafkaRecord(
  record: KafkaRecord,
  decode: (value: unknown) => Promise<KafkaEnvelope>,
  handler: (message: KafkaEnvelope, record: KafkaRecord) => Promise<void>,
  commit: (record: KafkaRecord) => Promise<void>,
): Promise<void> {
  try {
    const message = await decode(record.value);
    await handler(message, record);
    await commit(record);
  } catch (error) {
    if (error instanceof KafkaRuntimeError) throw error;
    throw new KafkaRuntimeError("KAFKA_HANDLER_FAILED", "обработка Kafka record завершилась ошибкой", {cause: error});
  }
}
