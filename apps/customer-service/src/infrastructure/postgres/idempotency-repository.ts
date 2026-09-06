import {createSqlIdempotencyStore, type SqlIdempotencyStore} from "@coffee-platform/idempotency";
import type {Database} from "@coffee-platform/database";
import type {CustomerResponse} from "../../domain/customer.js";

export type CustomerIdempotencyResponse = Readonly<{
  status: number;
  body: CustomerResponse;
  resourceRef?: string;
}>;

export function createCustomerIdempotencyRepository(database: Database): SqlIdempotencyStore<CustomerIdempotencyResponse> {
  return createSqlIdempotencyStore<CustomerIdempotencyResponse>(database, {
    schema: "customer",
    table: "idempotency_records",
  });
}
