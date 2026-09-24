// This file is auto-generated from contracts/openapi/client-v1.yaml.

export const clientV1BrowserOperations = [
  {
    "method": "POST",
    "path": "/api/client-v1/orders/{orderRef}/commands/confirm",
    "operationId": "confirmOrder",
    "audience": "api-public"
  },
  {
    "method": "POST",
    "path": "/api/client-v1/customers",
    "operationId": "createCustomer",
    "audience": "api-public",
    "permission": "customer:create"
  },
  {
    "method": "POST",
    "path": "/api/client-v1/orders/drafts",
    "operationId": "createOrderDraft",
    "audience": "api-public"
  },
  {
    "method": "POST",
    "path": "/api/client-v1/pricing/quotes",
    "operationId": "createPricingQuote",
    "audience": "api-public"
  },
  {
    "method": "GET",
    "path": "/api/client-v1/orders/{orderRef}",
    "operationId": "getOrderCard",
    "audience": "api-public"
  },
  {
    "method": "DELETE",
    "path": "/api/client-v1/orders/{orderRef}/items/{itemRef}",
    "operationId": "removeOrderItem",
    "audience": "api-public"
  },
  {
    "method": "POST",
    "path": "/api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation",
    "operationId": "requestAromaReconciliation",
    "audience": "api-public"
  },
  {
    "method": "GET",
    "path": "/api/client-v1/catalog/products",
    "operationId": "searchCatalogProducts",
    "audience": "api-public",
    "permission": "catalog:read"
  },
  {
    "method": "GET",
    "path": "/api/client-v1/customers",
    "operationId": "searchCustomers",
    "audience": "api-public",
    "permission": "customer:read"
  },
  {
    "method": "GET",
    "path": "/events",
    "operationId": "streamOrderInvalidations",
    "audience": "realtime-gateway",
    "permission": "orders:read:any"
  },
  {
    "method": "PUT",
    "path": "/api/client-v1/orders/{orderRef}/items/{itemRef}",
    "operationId": "upsertOrderItem",
    "audience": "api-public"
  }
] as const;
