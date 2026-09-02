export type JsonValue = string | number | boolean | null | readonly JsonValue[] | {readonly [key: string]: JsonValue};
export type OutboxMessage = Readonly<{
  messageId: string;
  messageType: string;
  aggregateRef: string;
  aggregateVersion: string;
  partitionKey: string;
  schemaVersion: string;
  payload: JsonValue;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  traceparent?: string;
}>;
export type OutboxState = "Pending" | "Publishing" | "Published" | "Failed";
export type OutboxClaim = Readonly<{
  message: OutboxMessage;
  state: OutboxState;
  attempts: number;
  leaseOwner: string;
  leaseUntilMs: number;
}>;

export class OutboxError extends Error {
  public readonly code: "OUTBOX_DUPLICATE" | "OUTBOX_LEASE_INVALID" | "OUTBOX_TERMINAL";

  public constructor(code: OutboxError["code"], message: string) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
  }
}

export interface OutboxStore {
  enqueue(message: OutboxMessage): Promise<"created" | "duplicate">;
  claim(nowMs: number, leaseOwner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]>;
  markPublished(messageId: string, leaseOwner: string): Promise<void>;
  markFailed(messageId: string, leaseOwner: string, nowMs: number, retryAtMs: number, maxAttempts: number): Promise<OutboxState>;
}

type Stored = OutboxClaim & Readonly<{retryAtMs: number}>;

function uniqueKey(message: OutboxMessage): string {
  return `${message.messageType}\u0000${message.aggregateRef}\u0000${message.aggregateVersion}`;
}

function assertPositive(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new OutboxError("OUTBOX_LEASE_INVALID", `${name} должен быть положительным целым числом`);
}

export class InMemoryOutboxStore implements OutboxStore {
  private readonly records = new Map<string, Stored>();
  private readonly uniqueMessages = new Map<string, string>();

  public async enqueue(message: OutboxMessage): Promise<"created" | "duplicate"> {
    const existingById = this.records.get(message.messageId);
    if (existingById !== undefined) {
      if (uniqueKey(existingById.message) !== uniqueKey(message)) throw new OutboxError("OUTBOX_DUPLICATE", "messageId уже используется другой message");
      return "duplicate";
    }
    const key = uniqueKey(message);
    if (this.uniqueMessages.has(key)) return "duplicate";
    const record: Stored = {message, state: "Pending", attempts: 0, leaseOwner: "", leaseUntilMs: 0, retryAtMs: 0};
    this.records.set(message.messageId, record);
    this.uniqueMessages.set(key, message.messageId);
    return "created";
  }

  public async claim(nowMs: number, leaseOwner: string, limit: number, leaseMs: number): Promise<readonly OutboxClaim[]> {
    assertPositive("limit", limit);
    assertPositive("leaseMs", leaseMs);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new OutboxError("OUTBOX_LEASE_INVALID", "nowMs некорректен");
    const eligible = [...this.records.values()]
      .filter((record) => (record.state === "Pending" || (record.state === "Publishing" && record.leaseUntilMs <= nowMs)) && record.retryAtMs <= nowMs)
      .sort((left, right) => left.message.occurredAt.localeCompare(right.message.occurredAt) || left.message.messageId.localeCompare(right.message.messageId))
      .slice(0, limit);
    const claims: OutboxClaim[] = [];
    for (const record of eligible) {
      const updated: Stored = {...record, state: "Publishing", attempts: record.attempts + 1, leaseOwner, leaseUntilMs: nowMs + leaseMs};
      this.records.set(record.message.messageId, updated);
      claims.push(updated);
    }
    return claims;
  }

  public async markPublished(messageId: string, leaseOwner: string): Promise<void> {
    const record = this.requireLease(messageId, leaseOwner);
    this.records.set(messageId, {...record, state: "Published", leaseOwner: "", leaseUntilMs: 0});
  }

  public async markFailed(messageId: string, leaseOwner: string, nowMs: number, retryAtMs: number, maxAttempts: number): Promise<OutboxState> {
    assertPositive("maxAttempts", maxAttempts);
    const record = this.requireLease(messageId, leaseOwner);
    if (record.attempts >= maxAttempts) {
      this.records.set(messageId, {...record, state: "Failed", leaseOwner: "", leaseUntilMs: 0});
      return "Failed";
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(retryAtMs) || retryAtMs < nowMs) throw new OutboxError("OUTBOX_LEASE_INVALID", "retry window некорректен");
    this.records.set(messageId, {...record, state: "Pending", leaseOwner: "", leaseUntilMs: 0, retryAtMs});
    return "Pending";
  }

  private requireLease(messageId: string, leaseOwner: string): Stored {
    const record = this.records.get(messageId);
    if (record === undefined || record.state !== "Publishing" || record.leaseOwner !== leaseOwner) throw new OutboxError("OUTBOX_LEASE_INVALID", "outbox lease недействителен");
    return record;
  }
}
