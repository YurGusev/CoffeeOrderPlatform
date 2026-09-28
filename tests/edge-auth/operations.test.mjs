import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {clientV1BrowserOperations} from "../../apps/edge-gateway/src/client-operations.gen.ts";
import {resolveBrowserOperation} from "../../apps/edge-gateway/dist/index.js";

void test("client-v1 browser operation inventory is contract-derived and permissions are explicit", () => {
  assert.deepEqual(clientV1BrowserOperations.map(({audience: _audience, ...operation}) => operation), [
    {method: "POST", path: "/api/client-v1/orders/{orderRef}/commands/confirm", operationId: "confirmOrder", permission: "orders:confirm:any"},
    {method: "POST", path: "/api/client-v1/customers", operationId: "createCustomer", permission: "customer:create"},
    {method: "POST", path: "/api/client-v1/orders/drafts", operationId: "createOrderDraft", permission: "orders:create"},
    {method: "POST", path: "/api/client-v1/pricing/quotes", operationId: "createPricingQuote", permission: "pricing:create"},
    {method: "GET", path: "/api/client-v1/orders/{orderRef}", operationId: "getOrderCard", permission: "orders:read:any"},
    {method: "DELETE", path: "/api/client-v1/orders/{orderRef}/items/{itemRef}", operationId: "removeOrderItem", permission: "orders:edit:any"},
    {method: "POST", path: "/api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation", operationId: "requestAromaReconciliation", permission: "orders:reconcile:any"},
    {method: "GET", path: "/api/client-v1/catalog/products", operationId: "searchCatalogProducts", permission: "catalog:read"},
    {method: "GET", path: "/api/client-v1/customers", operationId: "searchCustomers", permission: "customer:read"},
    {method: "GET", path: "/events", operationId: "streamOrderInvalidations", permission: "orders:read:any"},
    {method: "PUT", path: "/api/client-v1/orders/{orderRef}/items/{itemRef}", operationId: "upsertOrderItem", permission: "orders:edit:any"},
  ]);

  const permissionByOperation = Object.fromEntries(clientV1BrowserOperations
    .filter((operation) => operation.permission !== undefined)
    .map(({operationId, permission}) => [operationId, permission]));
  assert.deepEqual(permissionByOperation, {
    createCustomer: "customer:create",
    confirmOrder: "orders:confirm:any",
    createOrderDraft: "orders:create",
    createPricingQuote: "pricing:create",
    getOrderCard: "orders:read:any",
    removeOrderItem: "orders:edit:any",
    requestAromaReconciliation: "orders:reconcile:any",
    searchCatalogProducts: "catalog:read",
    searchCustomers: "customer:read",
    streamOrderInvalidations: "orders:read:any",
    upsertOrderItem: "orders:edit:any",
  });
  assert.equal(clientV1BrowserOperations.length, 11);
  assert.equal(clientV1BrowserOperations.filter((operation) => operation.permission === undefined).length, 0);
  assert.equal(clientV1BrowserOperations.find((operation) => operation.path === "/events")?.audience, "realtime-gateway");
  assert.ok(clientV1BrowserOperations.filter((operation) => operation.path !== "/events").every((operation) => operation.audience === "api-public"));
});

void test("contract resolver binds exact method, audience and permission; unbound operations fail closed", () => {
  assert.deepEqual(resolveBrowserOperation("GET", "/api/client-v1/catalog/products?query=coffee"), {
    operationId: "searchCatalogProducts", audience: "api-public", requiredPermission: "catalog:read",
  });
  assert.deepEqual(resolveBrowserOperation("GET", "/events?lastEventId=event-1"), {
    operationId: "streamOrderInvalidations", audience: "realtime-gateway", requiredPermission: "orders:read:any",
  });
  assert.deepEqual(resolveBrowserOperation("POST", "/api/client-v1/orders/drafts"), {
    operationId: "createOrderDraft", audience: "api-public", requiredPermission: "orders:create",
  });
  for (const [method, path] of [
    ["HEAD", "/events"], ["POST", "/events"], ["GET", "/api/agent-v1/orders"],
    ["GET", "/api/client-v1/catalog/products/extra"], ["GET", "/api/client-v1/orders/%2e%2e"],
    ["PUT", "/api/client-v1/orders/ord_1/items/../../confirm"],
  ]) assert.equal(resolveBrowserOperation(method, path), undefined, `${method} ${path} must be denied`);
});

void test("Edge authorizer has no business-owner client imports or direct outbound calls", async () => {
  for (const name of ["index", "main", "routes"]) {
    const source = await readFile(new URL(`../../apps/edge-gateway/src/${name}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfrom\s+["'](?:@coffee-platform\/(?:platform-http|generated-(?:customer|catalog|orders|pricing)|contracts-(?:customer|catalog|orders|pricing))|(?:node:)?(?:http|https|net|tls)(?:["'/]))/);
    assert.doesNotMatch(source, /\b(?:globalThis\.)?fetch\s*\(/);
  }
});
