import {randomUUID} from "node:crypto";
import {withTransaction, type Database} from "@coffee-platform/database";
import {canonicalRequestHash, type IdempotencyKey, type JsonValue, type IdempotencyStore} from "@coffee-platform/idempotency";
import {isCustomerResponse} from "@coffee-platform/contracts-customer-v1";
import {
  CustomerDomainError,
  escapeLikePrefix,
  monotonicUlid,
  type CustomerOrderInput,
  type CustomerResponse,
  type CustomerSearch,
  type NormalizedCustomerCreate,
} from "../../domain/customer.js";
import {CustomerRepository, type CustomerSearchRow} from "./customer-repository.js";
import type {CustomerIdempotencyResponse} from "./idempotency-repository.js";

const LEASE_MS = 30_000;
const RETENTION_MS = 86_400_000;

export type CustomerStoreCreateCommand = Readonly<{
  actorRef: string;
  scope: string;
  idempotencyKey: string;
  correlationId: string;
  input: NormalizedCustomerCreate;
  signal?: AbortSignal;
}>;

export type CustomerStoreCreateResult = Readonly<{
  status: 201;
  body: CustomerResponse;
  replayed: boolean;
}>;

export type CustomerStoreReplayResult =
  | Readonly<{kind: "completed"; response: Readonly<{status: number; body: JsonValue; resourceRef?: string}>}>
  | Readonly<{kind: "in_progress"}>
  | Readonly<{kind: "not_retained"}>
  | Readonly<{kind: "invalid"}>;

function normalizedJson(input: NormalizedCustomerCreate): JsonValue {
  return {
    displayName: input.displayName,
    ...(input.phoneE164 === null ? {} : {phone: input.phoneE164}),
    ...(input.emailNormalized === null ? {} : {email: input.emailNormalized}),
    ...(input.address === null ? {} : {
      address: {
        line1: input.address.line1,
        ...(input.address.line2 === null ? {} : {line2: input.address.line2}),
        city: input.address.city,
        ...(input.address.postalCode === null ? {} : {postalCode: input.address.postalCode}),
        countryCode: input.address.countryCode,
      },
    }),
  };
}

function nowMs(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

export class CustomerStore {
  private readonly database: Database;
  private readonly repository: CustomerRepository;
  private readonly idempotency: IdempotencyStore<CustomerIdempotencyResponse>;

  public constructor(database: Database, repository: CustomerRepository, idempotency: IdempotencyStore<CustomerIdempotencyResponse>) {
    this.database = database;
    this.repository = repository;
    this.idempotency = idempotency;
  }

  public async create(command: CustomerStoreCreateCommand): Promise<CustomerStoreCreateResult> {
    const identity: IdempotencyKey = {
      actorRef: command.actorRef,
      scope: command.scope,
      key: command.idempotencyKey,
    };
    const requestHash = canonicalRequestHash(normalizedJson(command.input));
    const leaseOwner = randomUUID();
    return withTransaction(this.database, {
      mode: "interactive",
      ...(command.signal === undefined ? {} : {signal: command.signal}),
      correlationId: command.correlationId,
    }, async transaction => {
      const acquired = await this.idempotency.acquire(transaction, identity, requestHash, leaseOwner, nowMs(), LEASE_MS, RETENTION_MS);
      if (acquired.kind === "conflict") throw new CustomerDomainError("IDEMPOTENCY_CONFLICT", "idempotency key was used for another request");
      if (acquired.kind === "in_progress") throw new CustomerDomainError("IDEMPOTENCY_REQUEST_IN_PROGRESS", "idempotency request is still in progress");
      if (acquired.kind === "replay") {
        if (acquired.response.status !== 201 || !isCustomerResponse(acquired.response.body)) {
          throw new CustomerDomainError("IDEMPOTENCY_RESULT_INVALID", "stored customer response is invalid");
        }
        return {status: 201, body: acquired.response.body, replayed: true};
      }

      const customerRef = `cus_${monotonicUlid()}`;
      const addressRef = command.input.address === null ? null : `adr_${monotonicUlid()}`;
      const response = await this.repository.createAggregate(transaction, {
        customerRef,
        addressRef,
        auditRef: `aud_${monotonicUlid()}`,
        actorRef: command.actorRef,
        correlationId: command.correlationId,
        input: command.input,
      });
      await this.idempotency.complete(transaction, identity, leaseOwner, {
        status: 201,
        body: response,
        resourceRef: response.customerRef,
      });
      return {status: 201, body: response, replayed: false};
    });
  }

  public async replay(identity: IdempotencyKey, signal: AbortSignal, correlationId: string): Promise<CustomerStoreReplayResult> {
    return withTransaction(this.database, {
      mode: "interactive",
      signal,
      correlationId,
    }, async transaction => {
      const record = await this.idempotency.get(transaction, identity);
      if (record === undefined) return {kind: "not_retained"} as const;
      if (record.state === "Acquired") return {kind: "in_progress"} as const;
      if (record.expiresAtMs <= nowMs()) return {kind: "not_retained"} as const;
      if (record.response === undefined) return {kind: "invalid"} as const;
      return {
        kind: "completed",
        response: {
          status: record.response.status,
          body: record.response.body,
          ...(record.response.resourceRef === undefined ? {} : {resourceRef: record.response.resourceRef}),
        },
      } as const;
    });
  }

  public async search(search: CustomerSearch, cursor: Readonly<{name: string; customerRef: string}> | null, limit: number, signal?: AbortSignal): Promise<readonly CustomerSearchRow[]> {
    return withTransaction(this.database, {
      mode: "interactive",
      ...(signal === undefined ? {} : {signal}),
    }, transaction => this.repository.search(transaction, search.mode, search.mode === "name" ? escapeLikePrefix(search.value) : search.value, cursor, limit));
  }

  public async getOrderInput(customerRef: string, signal?: AbortSignal): Promise<CustomerOrderInput | null> {
    return withTransaction(this.database, {
      mode: "interactive",
      ...(signal === undefined ? {} : {signal}),
    }, transaction => this.repository.getOrderInput(transaction, customerRef));
  }
}
