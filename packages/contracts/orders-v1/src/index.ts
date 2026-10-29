import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchema } from "ajv";
import type {
  OrderCardResponse,
  OrderConfirmRequest,
  OrderDraftCreateRequest,
  OrderItemPutRequest,
  ProblemDetails,
  ReconciliationAcceptedResponse,
  ReconciliationRequest,
} from "@coffee-platform/generated-client-v1";
import {
  clientV1ParameterSchemas,
  clientV1Schemas,
} from "@coffee-platform/generated-client-v1/runtime-schemas.gen.js";

export type {
  OrderCardResponse,
  OrderConfirmRequest,
  OrderDraftCreateRequest,
  OrderItemPutRequest,
  ReconciliationAcceptedResponse,
  ReconciliationRequest,
} from "@coffee-platform/generated-client-v1";
export type { ProblemDetails } from "@coffee-platform/generated-client-v1";

type OrdersRuntimeSchemas = Readonly<
  Record<
    | "createRequest"
    | "itemPutRequest"
    | "confirmRequest"
    | "reconciliationRequest"
    | "cardResponse"
    | "reconciliationAcceptedResponse"
    | "problem"
    | "orderRef"
    | "itemRef"
    | "quoteRef"
    | "productRef"
    | "variantRef"
    | "idempotencyKey"
    | "ifMatchVersion"
    | "replayOnly",
    AnySchema
  >
>;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value: string) => {
    const temporal = (
      globalThis as {
        Temporal?: { Instant?: { from: (input: string) => unknown } };
      }
    ).Temporal;
    if (temporal?.Instant?.from === undefined) return false;
    try {
      temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  },
});
ajv.addFormat("uri-reference", {
  type: "string",
  validate: (value: string) =>
    URL.canParse(value, "https://coffeeorderplatform.local"),
});

export const ordersContractSchemas: OrdersRuntimeSchemas = Object.freeze({
  createRequest: clientV1Schemas.OrderDraftCreateRequest,
  itemPutRequest: clientV1Schemas.OrderItemPutRequest,
  confirmRequest: clientV1Schemas.OrderConfirmRequest,
  reconciliationRequest: clientV1Schemas.ReconciliationRequest,
  cardResponse: clientV1Schemas.OrderCardResponse,
  reconciliationAcceptedResponse:
    clientV1Schemas.ReconciliationAcceptedResponse,
  problem: clientV1Schemas.ProblemDetails,
  orderRef: clientV1Schemas.OrderRef,
  itemRef: clientV1Schemas.ItemRef,
  quoteRef: clientV1Schemas.QuoteRef,
  productRef: clientV1Schemas.ProductRef,
  variantRef: clientV1Schemas.VariantRef,
  idempotencyKey: clientV1ParameterSchemas.IdempotencyKey,
  ifMatchVersion: clientV1ParameterSchemas.IfMatchVersion,
  replayOnly: clientV1ParameterSchemas.ReplayOnly,
});

const validators = {
  createRequest: ajv.compile(ordersContractSchemas.createRequest),
  itemPutRequest: ajv.compile(ordersContractSchemas.itemPutRequest),
  confirmRequest: ajv.compile(ordersContractSchemas.confirmRequest),
  reconciliationRequest: ajv.compile(
    ordersContractSchemas.reconciliationRequest,
  ),
  cardResponse: ajv.compile(ordersContractSchemas.cardResponse),
  reconciliationAcceptedResponse: ajv.compile(
    ordersContractSchemas.reconciliationAcceptedResponse,
  ),
  problem: ajv.compile(ordersContractSchemas.problem),
  orderRef: ajv.compile(ordersContractSchemas.orderRef),
  itemRef: ajv.compile(ordersContractSchemas.itemRef),
  quoteRef: ajv.compile(ordersContractSchemas.quoteRef),
  productRef: ajv.compile(ordersContractSchemas.productRef),
  variantRef: ajv.compile(ordersContractSchemas.variantRef),
  idempotencyKey: ajv.compile(ordersContractSchemas.idempotencyKey),
  ifMatchVersion: ajv.compile(ordersContractSchemas.ifMatchVersion),
  replayOnly: ajv.compile(ordersContractSchemas.replayOnly),
};

export function isOrderDraftCreateRequest(
  value: unknown,
): value is OrderDraftCreateRequest {
  return validators.createRequest(value) as boolean;
}
export function isOrderItemPutRequest(
  value: unknown,
): value is OrderItemPutRequest {
  return validators.itemPutRequest(value) as boolean;
}
export function isOrderConfirmRequest(
  value: unknown,
): value is OrderConfirmRequest {
  return validators.confirmRequest(value) as boolean;
}
export function isReconciliationRequest(
  value: unknown,
): value is ReconciliationRequest {
  return validators.reconciliationRequest(value) as boolean;
}
export function isOrderCardResponse(
  value: unknown,
): value is OrderCardResponse {
  return validators.cardResponse(value) as boolean;
}
export function isReconciliationAcceptedResponse(
  value: unknown,
): value is ReconciliationAcceptedResponse {
  return validators.reconciliationAcceptedResponse(value) as boolean;
}
export function isOrdersProblem(value: unknown): value is ProblemDetails {
  return validators.problem(value) as boolean;
}
export function isOrderRef(value: unknown): value is string {
  return validators.orderRef(value) as boolean;
}
export function isItemRef(value: unknown): value is string {
  return validators.itemRef(value) as boolean;
}
export function isQuoteRef(value: unknown): value is string {
  return validators.quoteRef(value) as boolean;
}
export function isProductRef(value: unknown): value is string {
  return validators.productRef(value) as boolean;
}
export function isVariantRef(value: unknown): value is string {
  return validators.variantRef(value) as boolean;
}
export function isOrdersIdempotencyKey(value: unknown): value is string {
  return validators.idempotencyKey(value) as boolean;
}
export function isIfMatchVersion(value: unknown): value is string {
  return validators.ifMatchVersion(value) as boolean;
}
export function isOrdersReplayOnly(value: unknown): value is true {
  return validators.replayOnly(value) as boolean;
}

export const contractPackage = {
  id: "@coffee-platform/contracts-orders-v1",
  source: {
    manifest: "contracts/manifest.yaml",
    openapi: [
      "contracts/openapi/client-v1.yaml",
      "contracts/openapi/internal-v1.yaml",
    ],
    schemas: "contracts/schemas",
  },
} as const;
