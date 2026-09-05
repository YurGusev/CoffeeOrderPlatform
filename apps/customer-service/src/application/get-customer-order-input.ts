import {withTransaction, type Database} from "@coffee-platform/database";
import {
  assertCustomerRef,
  CustomerDomainError,
  type CustomerOrderInput,
} from "../domain/customer.js";
import type {CustomerRepository} from "../infrastructure/postgres/customer-repository.js";

export async function getCustomerOrderInput(
  database: Database,
  repository: CustomerRepository,
  customerRef: string,
  signal?: AbortSignal,
): Promise<CustomerOrderInput> {
  try {
    assertCustomerRef(customerRef);
  } catch {
    throw new CustomerDomainError("CUSTOMER_NOT_FOUND", "customer was not found");
  }
  const result = await withTransaction(database, {
    mode: "interactive",
    ...(signal === undefined ? {} : {signal}),
  }, transaction => repository.getOrderInput(transaction, customerRef));
  if (result === null) throw new CustomerDomainError("CUSTOMER_NOT_FOUND", "customer was not found");
  return result;
}
