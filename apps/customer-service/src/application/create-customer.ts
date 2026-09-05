import {randomUUID} from "node:crypto";
import {withTransaction} from "@coffee-platform/database";
import type {JsonValue} from "@coffee-platform/idempotency";
import {canonicalRequestHash, type IdempotencyKey, type IdempotencyStore} from "@coffee-platform/idempotency";
import {
  assertActorRef,
  CustomerDomainError,
  isUuid,
  monotonicUlid,
  normalizeCustomerCreate,
  type CustomerCreateInput,
  type CustomerResponse,
} from "../domain/customer.js";
import type {CustomerRepository} from "../infrastructure/postgres/customer-repository.js";
import type {CustomerIdempotencyResponse} from "../infrastructure/postgres/idempotency-repository.js";
import type {Database} from "@coffee-platform/database";

const LEASE_MS = 30_000;
const RETENTION_MS = 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TIMESTAMP = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?Z$/u;

export type CreateCustomerCommand = Readonly<{
  actorRef: string;
  scope: string;
  idempotencyKey: string;
  correlationId: string;
  body: CustomerCreateInput;
  signal?: AbortSignal;
}>;

export type CreateCustomerResult = Readonly<{
  status: 201;
  body: CustomerResponse;
  replayed: boolean;
}>;

function assertCommand(command: CreateCustomerCommand): void {
  assertActorRef(command.actorRef);
  if (command.actorRef.length > 64) throw new CustomerDomainError("VALIDATION_FAILED", "actorRef is too long for idempotency storage");
  if (!/^[0-9a-f]{64}$/u.test(command.scope)) throw new CustomerDomainError("VALIDATION_FAILED", "scope is invalid");
  if (!isUuid(command.idempotencyKey)) throw new CustomerDomainError("VALIDATION_FAILED", "idempotencyKey is invalid");
  if (!isUuid(command.correlationId)) throw new CustomerDomainError("VALIDATION_FAILED", "correlationId is invalid");
}

function normalizedJson(
  input: ReturnType<typeof normalizeCustomerCreate>,
): JsonValue {
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validStoredResponse(value: CustomerResponse): boolean {
  const body = record(value);
  if (body === null || Object.keys(body).some((key) => !["customerRef", "version", "displayName", "phone", "email", "address", "createdAt", "updatedAt"].includes(key)) ||
    typeof body["customerRef"] !== "string" || !/^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(body["customerRef"]) ||
    typeof body["version"] !== "string" || !/^[1-9][0-9]*$/u.test(body["version"]) ||
    typeof body["displayName"] !== "string" || body["displayName"].length < 1 || body["displayName"].length > 200 ||
    typeof body["createdAt"] !== "string" || !TIMESTAMP.test(body["createdAt"]) || typeof body["updatedAt"] !== "string" || !TIMESTAMP.test(body["updatedAt"])) return false;
  if (body["phone"] !== undefined && (typeof body["phone"] !== "string" || !/^\+[1-9][0-9]{7,14}$/u.test(body["phone"]))) return false;
  if (body["email"] !== undefined && (typeof body["email"] !== "string" || body["email"].length > 254 || !EMAIL.test(body["email"]))) return false;
  const address = body["address"] === undefined ? undefined : record(body["address"]);
  if (address === undefined) return true;
  return address !== null && Object.keys(address).every((key) => ["addressRef", "line1", "line2", "city", "postalCode", "countryCode"].includes(key)) &&
    typeof address["addressRef"] === "string" && /^adr_[0-9A-HJKMNP-TV-Z]{26}$/u.test(address["addressRef"]) &&
    typeof address["line1"] === "string" && address["line1"].length >= 1 && address["line1"].length <= 200 &&
    (address["line2"] === undefined || (typeof address["line2"] === "string" && address["line2"].length <= 200)) &&
    typeof address["city"] === "string" && address["city"].length >= 1 && address["city"].length <= 100 &&
    (address["postalCode"] === undefined || (typeof address["postalCode"] === "string" && address["postalCode"].length <= 32)) &&
    address["countryCode"] === "RU";
}

export async function createCustomer(
  database: Database,
  repository: CustomerRepository,
  idempotency: IdempotencyStore<CustomerIdempotencyResponse>,
  command: CreateCustomerCommand,
): Promise<CreateCustomerResult> {
  assertCommand(command);
  const input = normalizeCustomerCreate(command.body);
  const identity: IdempotencyKey = {
    actorRef: command.actorRef,
    scope: command.scope,
    key: command.idempotencyKey,
  };
  const requestHash = canonicalRequestHash(normalizedJson(input));
  const leaseOwner = randomUUID();
  const nowMs = Math.floor(performance.timeOrigin + performance.now());

  return withTransaction(database, {
    mode: "interactive",
    ...(command.signal === undefined ? {} : {signal: command.signal}),
    correlationId: command.correlationId,
  }, async transaction => {
    const acquired = await idempotency.acquire(transaction, identity, requestHash, leaseOwner, nowMs, LEASE_MS, RETENTION_MS);
    if (acquired.kind === "conflict") throw new CustomerDomainError("IDEMPOTENCY_CONFLICT", "idempotency key was used for another request");
    if (acquired.kind === "in_progress") throw new CustomerDomainError("IDEMPOTENCY_REQUEST_IN_PROGRESS", "idempotency request is still in progress");
    if (acquired.kind === "replay") {
      if (acquired.response.status !== 201 || !validStoredResponse(acquired.response.body)) {
        throw new CustomerDomainError("IDEMPOTENCY_RESULT_INVALID", "stored customer response is invalid");
      }
      return {status: 201, body: acquired.response.body, replayed: true};
    }

    const customerRef = `cus_${monotonicUlid()}`;
    const addressRef = input.address === null ? null : `adr_${monotonicUlid()}`;
    const response = await repository.createAggregate(transaction, {
      customerRef,
      addressRef,
      auditRef: `aud_${monotonicUlid()}`,
      actorRef: command.actorRef,
      correlationId: command.correlationId,
      input,
    });
    await idempotency.complete(transaction, identity, leaseOwner, {
      status: 201,
      body: response,
      resourceRef: response.customerRef,
    });
    return {status: 201, body: response, replayed: false};
  });
}
