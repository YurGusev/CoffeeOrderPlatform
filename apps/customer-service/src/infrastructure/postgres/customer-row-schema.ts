import {Ajv2020} from "ajv/dist/2020.js";
import type {ValidateFunction} from "ajv";

const REF = "^cus_[0-9A-HJKMNP-TV-Z]{26}$";
const VERSION = "^[1-9][0-9]*$";
const TIMESTAMP = "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?Z$";

const customerRowSchema = {
  type: "object", additionalProperties: false,
  required: ["customer_ref", "version", "display_name", "phone_e164", "email_normalized", "created_at", "updated_at"],
  properties: {
    customer_ref: {type: "string", pattern: REF}, version: {type: "string", pattern: VERSION}, display_name: {type: "string", minLength: 1, maxLength: 200},
    phone_e164: {type: ["string", "null"], pattern: "^\\+[1-9][0-9]{7,14}$"}, email_normalized: {type: ["string", "null"], minLength: 1, maxLength: 254},
    created_at: {type: "string", pattern: TIMESTAMP}, updated_at: {type: "string", pattern: TIMESTAMP},
  },
} as const;

const searchRowSchema = {
  type: "object", additionalProperties: false,
  required: ["customer_ref", "version", "display_name", "display_name_search", "phone_e164", "email_normalized"],
  properties: {
    customer_ref: {type: "string", pattern: REF}, version: {type: "string", pattern: VERSION}, display_name: {type: "string", minLength: 1, maxLength: 200},
    display_name_search: {type: "string", minLength: 1, maxLength: 200}, phone_e164: {type: ["string", "null"], pattern: "^\\+[1-9][0-9]{7,14}$"},
    email_normalized: {type: ["string", "null"], minLength: 1, maxLength: 254},
  },
} as const;

const orderInputRowSchema = {
  type: "object", additionalProperties: false,
  required: ["customer_ref", "version", "display_name", "status"],
  properties: {
    customer_ref: {type: "string", pattern: REF}, version: {type: "string", pattern: VERSION}, display_name: {type: "string", minLength: 1, maxLength: 200},
    status: {type: "string", enum: ["Active", "Inactive"]},
  },
} as const;

const conflictRowSchema = {
  type: "object", additionalProperties: false, required: ["phone_e164"],
  properties: {phone_e164: {type: ["string", "null"], pattern: "^\\+[1-9][0-9]{7,14}$"}},
} as const;

const ajv: Ajv2020 = new Ajv2020({allErrors: true, strict: true});
export type CustomerRowKind = "customer" | "search" | "orderInput" | "conflict";
const validators: Readonly<Record<CustomerRowKind, ValidateFunction>> = {
  customer: ajv.compile(customerRowSchema),
  search: ajv.compile(searchRowSchema),
  orderInput: ajv.compile(orderInputRowSchema),
  conflict: ajv.compile(conflictRowSchema),
};

export function assertCustomerRow(value: unknown, kind: CustomerRowKind): void {
  if (!validators[kind](value)) throw new Error("CUSTOMER_STORAGE_ROW_INVALID");
}
