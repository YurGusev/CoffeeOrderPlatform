export type InboxMessage = Readonly<{
  messageId: string;
  messageType: string;
  receivedAt: string;
}>;
export type InboxState = "Processing" | "Processed" | "Quarantined";
export type InboxRecord = Readonly<{
  message: InboxMessage;
  state: InboxState;
  leaseOwner: string;
  leaseUntilMs: number;
  processedAt?: string;
  failureReason?: string;
}>;
export type InboxBeginResult =
  | Readonly<{kind: "acquired"; record: InboxRecord}>
  | Readonly<{kind: "duplicate"; state: "Processed" | "Quarantined"}>
  | Readonly<{kind: "in_progress"; leaseUntilMs: number}>;

export class InboxError extends Error {
  public readonly code: "INBOX_LEASE_INVALID" | "INBOX_QUARANTINED";

  public constructor(code: InboxError["code"], message: string) {
    super(message);
    this.name = "InboxError";
    this.code = code;
  }
}

export interface InboxStore {
  begin(message: InboxMessage, leaseOwner: string, nowMs: number, leaseMs: number): Promise<InboxBeginResult>;
  markProcessed(messageId: string, leaseOwner: string, processedAt: string): Promise<void>;
  quarantine(messageId: string, leaseOwner: string, reason: string): Promise<void>;
  release(messageId: string, leaseOwner: string): Promise<void>;
}

export type InboxFailure = Readonly<{
  kind: "invalid" | "permanent" | "transient";
  reason: string;
}>;

export class InboxProcessingError extends Error {
  public readonly failure: InboxFailure;

  public constructor(failure: InboxFailure) {
    super(failure.reason);
    this.name = "InboxProcessingError";
    this.failure = failure;
  }
}

export type ConsumeResult = Readonly<{kind: "processed" | "duplicate" | "in_progress" | "quarantined"}>;

export async function consumeOnce(
  store: InboxStore,
  message: InboxMessage,
  leaseOwner: string,
  nowMs: number,
  leaseMs: number,
  processedAt: string,
  handler: () => Promise<void>,
): Promise<ConsumeResult> {
  const begin = await store.begin(message, leaseOwner, nowMs, leaseMs);
  if (begin.kind === "duplicate") return {kind: begin.state === "Quarantined" ? "quarantined" : "duplicate"};
  if (begin.kind === "in_progress") return begin;
  try {
    await handler();
    await store.markProcessed(message.messageId, leaseOwner, processedAt);
    return {kind: "processed"};
  } catch (error) {
    const failure = error instanceof InboxProcessingError ? error.failure : {kind: "transient", reason: "обработчик завершился с ошибкой"} as const;
    if (failure.kind === "invalid" || failure.kind === "permanent") {
      await store.quarantine(message.messageId, leaseOwner, failure.reason);
      return {kind: "quarantined"};
    }
    await store.release(message.messageId, leaseOwner);
    throw error;
  }
}

type StoredInboxRecord = InboxRecord;

export class InMemoryInboxStore implements InboxStore {
  private readonly records = new Map<string, StoredInboxRecord>();

  public async begin(message: InboxMessage, leaseOwner: string, nowMs: number, leaseMs: number): Promise<InboxBeginResult> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new InboxError("INBOX_LEASE_INVALID", "некорректное окно Inbox");
    const current = this.records.get(message.messageId);
    if (current?.state === "Processed" || current?.state === "Quarantined") return {kind: "duplicate", state: current.state};
    if (current?.state === "Processing" && current.leaseUntilMs > nowMs) return {kind: "in_progress", leaseUntilMs: current.leaseUntilMs};
    const record: StoredInboxRecord = {message, state: "Processing", leaseOwner, leaseUntilMs: nowMs + leaseMs};
    this.records.set(message.messageId, record);
    return {kind: "acquired", record};
  }

  public async markProcessed(messageId: string, leaseOwner: string, processedAt: string): Promise<void> {
    const record = this.requireLease(messageId, leaseOwner);
    this.records.set(messageId, {...record, state: "Processed", leaseOwner: "", leaseUntilMs: 0, processedAt});
  }

  public async quarantine(messageId: string, leaseOwner: string, reason: string): Promise<void> {
    const record = this.requireLease(messageId, leaseOwner);
    if (reason.length === 0) throw new InboxError("INBOX_QUARANTINED", "причина quarantine обязательна");
    this.records.set(messageId, {...record, state: "Quarantined", leaseOwner: "", leaseUntilMs: 0, failureReason: reason});
  }

  public async release(messageId: string, leaseOwner: string): Promise<void> {
    const record = this.requireLease(messageId, leaseOwner);
    this.records.delete(messageId);
    void record;
  }

  private requireLease(messageId: string, leaseOwner: string): StoredInboxRecord {
    const record = this.records.get(messageId);
    if (record === undefined || record.state !== "Processing" || record.leaseOwner !== leaseOwner) throw new InboxError("INBOX_LEASE_INVALID", "Inbox lease недействителен");
    return record;
  }
}
