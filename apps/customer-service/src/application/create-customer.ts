import type { CustomerCreateRequest } from "@coffee-platform/contracts-customer-v1";
import {
  assertActorRef,
  CustomerDomainError,
  isUuid,
  normalizeCustomerCreate,
} from "../domain/customer.js";
import type {
  CustomerStore,
  CustomerStoreCreateResult,
} from "../infrastructure/postgres/customer-store.js";

export type CreateCustomerCommand = Readonly<{
  actorRef: string;
  scope: string;
  idempotencyKey: string;
  correlationId: string;
  body: CustomerCreateRequest;
  signal?: AbortSignal;
}>;

export type CreateCustomerResult = CustomerStoreCreateResult;

function assertCommand(command: CreateCustomerCommand): void {
  assertActorRef(command.actorRef);
  if (command.actorRef.length > 64)
    throw new CustomerDomainError(
      "VALIDATION_FAILED",
      "actorRef is too long for idempotency storage",
    );
  if (!/^[0-9a-f]{64}$/u.test(command.scope))
    throw new CustomerDomainError("VALIDATION_FAILED", "scope is invalid");
  if (!isUuid(command.idempotencyKey))
    throw new CustomerDomainError(
      "VALIDATION_FAILED",
      "idempotencyKey is invalid",
    );
  if (!isUuid(command.correlationId))
    throw new CustomerDomainError(
      "VALIDATION_FAILED",
      "correlationId is invalid",
    );
}

export async function createCustomer(
  store: CustomerStore,
  command: CreateCustomerCommand,
): Promise<CreateCustomerResult> {
  assertCommand(command);
  const input = normalizeCustomerCreate(command.body);
  return store.create({
    actorRef: command.actorRef,
    scope: command.scope,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    input,
    ...(command.signal === undefined ? {} : { signal: command.signal }),
  });
}
