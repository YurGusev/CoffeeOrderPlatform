import {
  assertCustomerRef,
  CustomerDomainError,
  type CustomerOrderInput,
} from "../domain/customer.js";
import type {CustomerStore} from "../infrastructure/postgres/customer-store.js";

export async function getCustomerOrderInput(
  store: CustomerStore,
  customerRef: string,
  signal?: AbortSignal,
): Promise<CustomerOrderInput> {
  try {
    assertCustomerRef(customerRef);
  } catch {
    throw new CustomerDomainError("CUSTOMER_NOT_FOUND", "customer was not found");
  }
  const result = await store.getOrderInput(customerRef, signal);
  if (result === null) throw new CustomerDomainError("CUSTOMER_NOT_FOUND", "customer was not found");
  return result;
}
