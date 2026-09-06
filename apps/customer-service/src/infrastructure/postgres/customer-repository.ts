import type {Database, SqlScalar, Transaction} from "@coffee-platform/database";
import {defineStatement, type OwnerStatement} from "@coffee-platform/database/owner";
import {
  auditAfterHash,
  type CustomerOrderInput,
  CustomerDomainError,
  type CustomerResponse,
  type CustomerSearchMode,
  type NormalizedCustomerCreate,
} from "../../domain/customer.js";
import {assertCustomerRow} from "./customer-row-schema.js";

type CustomerRow = Readonly<{
  customer_ref: unknown;
  version: unknown;
  display_name: unknown;
  phone_e164: unknown;
  email_normalized: unknown;
  created_at: unknown;
  updated_at: unknown;
}>;

type SearchRow = Readonly<{
  customer_ref: unknown;
  version: unknown;
  display_name: unknown;
  display_name_search: unknown;
  phone_e164: unknown;
  email_normalized: unknown;
}>;

type OrderInputRow = Readonly<{
  customer_ref: unknown;
  version: unknown;
  display_name: unknown;
  status: unknown;
}>;

type ConflictRow = Readonly<{phone_e164: unknown}>;

export type CustomerAggregateWrite = Readonly<{
  customerRef: string;
  addressRef: string | null;
  auditRef: string;
  actorRef: string;
  correlationId: string;
  input: NormalizedCustomerCreate;
}>;

export type CustomerSearchRow = Readonly<{
  customerRef: string;
  version: string;
  displayName: string;
  name: string;
  phoneE164: string | null;
  emailNormalized: string | null;
}>;

export class CustomerStorageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CustomerStorageError";
  }
}

function customerRow(row: CustomerRow): Readonly<{
  customerRef: string;
  version: string;
  displayName: string;
  phoneE164: string | null;
  emailNormalized: string | null;
  createdAt: string;
  updatedAt: string;
}> {
  assertCustomerRow(row, "customer");
  const value = row as Readonly<{
    customer_ref: string;
    version: string;
    display_name: string;
    phone_e164: string | null;
    email_normalized: string | null;
    created_at: string;
    updated_at: string;
  }>;
  return {
    customerRef: value.customer_ref,
    version: value.version,
    displayName: value.display_name,
    phoneE164: value.phone_e164,
    emailNormalized: value.email_normalized,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function searchRow(row: SearchRow): CustomerSearchRow {
  assertCustomerRow(row, "search");
  const value = row as Readonly<{
    customer_ref: string;
    version: string;
    display_name: string;
    display_name_search: string;
    phone_e164: string | null;
    email_normalized: string | null;
  }>;
  return {
    customerRef: value.customer_ref,
    version: value.version,
    displayName: value.display_name,
    name: value.display_name_search,
    phoneE164: value.phone_e164,
    emailNormalized: value.email_normalized,
  };
}

function resultRow<Row>(result: Readonly<{rows: readonly Row[]; rowCount: number}>, message: string): Row {
  const row = result.rows[0];
  if (row === undefined) throw new CustomerStorageError(message);
  return row;
}

export class CustomerRepository {
  private readonly insertCustomer: OwnerStatement<CustomerRow, readonly SqlScalar[]>;
  private readonly findPhoneConflict: OwnerStatement<ConflictRow, readonly SqlScalar[]>;
  private readonly findEmailConflict: OwnerStatement<ConflictRow, readonly SqlScalar[]>;
  private readonly insertAddress: OwnerStatement<Readonly<{address_ref: string}>, readonly SqlScalar[]>;
  private readonly insertAudit: OwnerStatement<Readonly<{audit_ref: string}>, readonly SqlScalar[]>;
  private readonly searchByName: OwnerStatement<SearchRow, readonly SqlScalar[]>;
  private readonly searchByPhone: OwnerStatement<SearchRow, readonly SqlScalar[]>;
  private readonly searchByEmail: OwnerStatement<SearchRow, readonly SqlScalar[]>;
  private readonly readOrderInput: OwnerStatement<OrderInputRow, readonly SqlScalar[]>;

  public constructor(database: Database) {
    this.insertCustomer = defineStatement(database, `
      INSERT INTO customer.customers
        (customer_ref, version, display_name, display_name_search, phone_e164, email_normalized, status,
         created_at, updated_at, created_by_actor_ref, updated_by_actor_ref)
      VALUES ($1, 1, $2, $3, $4, $5, 'Active', clock_timestamp(), clock_timestamp(), $6, $6)
      ON CONFLICT DO NOTHING
      RETURNING customer_ref, version::text, display_name, phone_e164, email_normalized,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at`);
    this.findPhoneConflict = defineStatement(database, `
      SELECT phone_e164
      FROM customer.customers
      WHERE status = 'Active' AND phone_e164 = $1
      LIMIT 1`);
    this.findEmailConflict = defineStatement(database, `
      SELECT phone_e164
      FROM customer.customers
      WHERE status = 'Active' AND email_normalized = $1
      LIMIT 1`);
    this.insertAddress = defineStatement(database, `
      INSERT INTO customer.addresses
        (address_ref, customer_ref, kind, line1, line2, city, postal_code, country_code, version,
         is_active, created_at, updated_at, created_by_actor_ref, updated_by_actor_ref)
      VALUES ($1, $2, 'Delivery', $3, $4, $5, $6, $7, 1, true, clock_timestamp(), clock_timestamp(), $8, $8)
      RETURNING address_ref`);
    this.insertAudit = defineStatement(database, `
      INSERT INTO customer.audit_log
        (audit_ref, customer_ref, operation, actor_ref, correlation_id, occurred_at, before_hash, after_hash)
      VALUES ($1, $2, 'CustomerCreated', $3, $4, clock_timestamp(), NULL, $5)
      RETURNING audit_ref`);
    this.searchByName = defineStatement(database, `
      SELECT customer_ref, version::text, display_name, display_name_search, phone_e164, email_normalized
      FROM customer.customers
      WHERE status = 'Active'
        AND display_name_search LIKE $1 || '%' ESCAPE CHR(92)
        AND ($2::varchar IS NULL OR (display_name_search, customer_ref) > ($2::varchar, $3::varchar))
      ORDER BY display_name_search ASC, customer_ref ASC
      LIMIT $4`);
    this.searchByPhone = defineStatement(database, `
      SELECT customer_ref, version::text, display_name, display_name_search, phone_e164, email_normalized
      FROM customer.customers
      WHERE status = 'Active' AND phone_e164 = $1
        AND ($2::varchar IS NULL OR (display_name_search, customer_ref) > ($2::varchar, $3::varchar))
      ORDER BY display_name_search ASC, customer_ref ASC
      LIMIT $4`);
    this.searchByEmail = defineStatement(database, `
      SELECT customer_ref, version::text, display_name, display_name_search, phone_e164, email_normalized
      FROM customer.customers
      WHERE status = 'Active' AND email_normalized = $1
        AND ($2::varchar IS NULL OR (display_name_search, customer_ref) > ($2::varchar, $3::varchar))
      ORDER BY display_name_search ASC, customer_ref ASC
      LIMIT $4`);
    this.readOrderInput = defineStatement(database, `
      SELECT customer_ref, version::text, display_name, status
      FROM customer.customers
      WHERE customer_ref = $1`);
  }

  public async createAggregate(transaction: Transaction, write: CustomerAggregateWrite): Promise<CustomerResponse> {
    const inserted = await this.insertCustomer(transaction, [
      write.customerRef,
      write.input.displayName,
      write.input.displayNameSearch,
      write.input.phoneE164,
      write.input.emailNormalized,
      write.actorRef,
    ]);
    if (inserted.rowCount !== 1) {
      if (write.input.phoneE164 !== null) {
        const conflict = await this.findPhoneConflict(transaction, [write.input.phoneE164]);
        if (conflict.rowCount === 1) {
          assertCustomerRow(conflict.rows[0], "conflict");
          throw new CustomerDomainError("CUSTOMER_PHONE_CONFLICT", "active customer already owns this phone");
        }
      }
      if (write.input.emailNormalized !== null) {
        const conflict = await this.findEmailConflict(transaction, [write.input.emailNormalized]);
        if (conflict.rowCount === 1) {
          assertCustomerRow(conflict.rows[0], "conflict");
          throw new CustomerDomainError("CUSTOMER_EMAIL_CONFLICT", "active customer already owns this email");
        }
      }
      throw new CustomerStorageError("customer insert was ignored without a contact conflict");
    }
    const row = customerRow(resultRow(inserted, "customer insert returned no row"));
    if (write.addressRef !== null && write.input.address !== null) {
      const address = await this.insertAddress(transaction, [
        write.addressRef,
        write.customerRef,
        write.input.address.line1,
        write.input.address.line2,
        write.input.address.city,
        write.input.address.postalCode,
        write.input.address.countryCode,
        write.actorRef,
      ]);
      if (address.rowCount !== 1) throw new CustomerStorageError("address insert failed");
    }
    const audit = await this.insertAudit(transaction, [
      write.auditRef,
      write.customerRef,
      write.actorRef,
      write.correlationId,
      auditAfterHash({customerRef: write.customerRef, ...(write.addressRef === null ? {} : {addressRef: write.addressRef})}),
    ]);
    if (audit.rowCount !== 1) throw new CustomerStorageError("audit insert failed");
    return {
      customerRef: row.customerRef,
      version: row.version,
      displayName: row.displayName,
      ...(row.phoneE164 === null ? {} : {phone: row.phoneE164}),
      ...(row.emailNormalized === null ? {} : {email: row.emailNormalized}),
      ...(write.addressRef === null || write.input.address === null ? {} : {
        address: {
          addressRef: write.addressRef,
          line1: write.input.address.line1,
          ...(write.input.address.line2 === null ? {} : {line2: write.input.address.line2}),
          city: write.input.address.city,
          ...(write.input.address.postalCode === null ? {} : {postalCode: write.input.address.postalCode}),
          countryCode: write.input.address.countryCode,
        },
      }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async search(
    transaction: Transaction,
    mode: CustomerSearchMode,
    value: string,
    cursor: Readonly<{name: string; customerRef: string}> | null,
    limit: number,
  ): Promise<readonly CustomerSearchRow[]> {
    const name = cursor?.name ?? null;
    const customerRef = cursor?.customerRef ?? null;
    const result = mode === "name"
      ? await this.searchByName(transaction, [value, name, customerRef, limit])
      : mode === "phone"
        ? await this.searchByPhone(transaction, [value, name, customerRef, limit])
        : await this.searchByEmail(transaction, [value, name, customerRef, limit]);
    return result.rows.map(searchRow);
  }

  public async getOrderInput(transaction: Transaction, customerRef: string): Promise<CustomerOrderInput | null> {
    const result = await this.readOrderInput(transaction, [customerRef]);
    const row = result.rows[0];
    if (row === undefined) return null;
    assertCustomerRow(row, "orderInput");
    const value = row as Readonly<{customer_ref: string; version: string; display_name: string; status: "Active" | "Inactive"}>;
    return {
      customerRef: value.customer_ref,
      customerVersion: value.version,
      displayName: value.display_name,
      state: value.status,
    };
  }
}
