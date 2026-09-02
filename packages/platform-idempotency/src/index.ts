export type JsonValue = string | number | boolean | null | readonly JsonValue[] | {readonly [key: string]: JsonValue};
export type IdempotencyKey = Readonly<{
  actorRef: string;
  scope: string;
  key: string;
}>;
export type IdempotencyResponse = Readonly<{
  status: number;
  body: JsonValue;
  resourceRef?: string;
}>;
export type IdempotencyRecord<Response extends IdempotencyResponse = IdempotencyResponse> = Readonly<{
  identity: IdempotencyKey;
  requestHash: string;
  state: "Acquired" | "Completed";
  leaseOwner: string;
  leaseUntilMs: number;
  expiresAtMs: number;
  response?: Response;
}>;

export type AcquireResult<Response extends IdempotencyResponse = IdempotencyResponse> =
  | Readonly<{kind: "acquired"; record: IdempotencyRecord<Response>}>
  | Readonly<{kind: "replay"; response: Response}>
  | Readonly<{kind: "conflict"; reason: "request_hash_mismatch"}>
  | Readonly<{kind: "in_progress"; leaseUntilMs: number}>;

export class IdempotencyError extends Error {
  public readonly code: "IDEMPOTENCY_NOT_ACQUIRED" | "IDEMPOTENCY_EXPIRED";

  public constructor(code: IdempotencyError["code"], message: string) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
  }
}

function identityKey(identity: IdempotencyKey): string {
  return `${identity.actorRef}\u0000${identity.scope}\u0000${identity.key}`;
}

function validateWindow(nowMs: number, leaseMs: number, retentionMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(retentionMs) || retentionMs <= 0) {
    throw new IdempotencyError("IDEMPOTENCY_NOT_ACQUIRED", "некорректное окно idempotency");
  }
}

export interface IdempotencyStore<Response extends IdempotencyResponse = IdempotencyResponse> {
  acquire(identity: IdempotencyKey, requestHash: string, leaseOwner: string, nowMs: number, leaseMs: number, retentionMs: number): Promise<AcquireResult<Response>>;
  complete(identity: IdempotencyKey, leaseOwner: string, response: Response): Promise<void>;
  get(identity: IdempotencyKey): Promise<IdempotencyRecord<Response> | undefined>;
}

export class InMemoryIdempotencyStore<Response extends IdempotencyResponse = IdempotencyResponse> implements IdempotencyStore<Response> {
  private readonly records = new Map<string, IdempotencyRecord<Response>>();

  public async acquire(identity: IdempotencyKey, requestHash: string, leaseOwner: string, nowMs: number, leaseMs: number, retentionMs: number): Promise<AcquireResult<Response>> {
    validateWindow(nowMs, leaseMs, retentionMs);
    const mapKey = identityKey(identity);
    const existing = this.records.get(mapKey);
    if (existing !== undefined && existing.expiresAtMs <= nowMs) this.records.delete(mapKey);
    const current = this.records.get(mapKey);
    if (current !== undefined) {
      if (current.requestHash !== requestHash) return {kind: "conflict", reason: "request_hash_mismatch"};
      if (current.state === "Completed" && current.response !== undefined) return {kind: "replay", response: current.response};
      if (current.leaseUntilMs > nowMs) return {kind: "in_progress", leaseUntilMs: current.leaseUntilMs};
    }
    const record: IdempotencyRecord<Response> = {
      identity,
      requestHash,
      state: "Acquired",
      leaseOwner,
      leaseUntilMs: nowMs + leaseMs,
      expiresAtMs: nowMs + retentionMs,
    };
    this.records.set(mapKey, record);
    return {kind: "acquired", record};
  }

  public async complete(identity: IdempotencyKey, leaseOwner: string, response: Response): Promise<void> {
    const mapKey = identityKey(identity);
    const current = this.records.get(mapKey);
    if (current === undefined || current.state !== "Acquired" || current.leaseOwner !== leaseOwner) {
      throw new IdempotencyError("IDEMPOTENCY_NOT_ACQUIRED", "idempotency lease не принадлежит вызывающему");
    }
    this.records.set(mapKey, {...current, state: "Completed", response});
  }

  public async get(identity: IdempotencyKey): Promise<IdempotencyRecord<Response> | undefined> {
    return this.records.get(identityKey(identity));
  }
}
