import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {clientV1BrowserOperations} from "../../apps/edge-gateway/src/client-operations.gen.ts";
import {resolveBrowserOperation} from "../../apps/edge-gateway/dist/index.js";

void test("client-v1 browser operation inventory is contract-derived and permissions are explicit", () => {
  assert.deepEqual(clientV1BrowserOperations.map(({audience: _audience, ...operation}) => operation), [
    {method: "POST", path: "/api/client-v1/orders/{orderRef}/commands/confirm", operationId: "confirmOrder"},
    {method: "POST", path: "/api/client-v1/customers", operationId: "createCustomer", permission: "customer:create"},
    {method: "POST", path: "/api/client-v1/orders/drafts", operationId: "createOrderDraft"},
    {method: "POST", path: "/api/client-v1/pricing/quotes", operationId: "createPricingQuote"},
    {method: "GET", path: "/api/client-v1/orders/{orderRef}", operationId: "getOrderCard"},
    {method: "DELETE", path: "/api/client-v1/orders/{orderRef}/items/{itemRef}", operationId: "removeOrderItem"},
    {method: "POST", path: "/api/client-v1/orders/{orderRef}/commands/request-aroma-reconciliation", operationId: "requestAromaReconciliation"},
    {method: "GET", path: "/api/client-v1/catalog/products", operationId: "searchCatalogProducts", permission: "catalog:read"},
    {method: "GET", path: "/api/client-v1/customers", operationId: "searchCustomers", permission: "customer:read"},
    {method: "GET", path: "/events", operationId: "streamOrderInvalidations", permission: "orders:read:any"},
    {method: "PUT", path: "/api/client-v1/orders/{orderRef}/items/{itemRef}", operationId: "upsertOrderItem"},
  ]);

  const permissionByOperation = Object.fromEntries(clientV1BrowserOperations
    .filter((operation) => operation.permission !== undefined)
    .map(({operationId, permission}) => [operationId, permission]));
  assert.deepEqual(permissionByOperation, {
    createCustomer: "customer:create",
    searchCatalogProducts: "catalog:read",
    searchCustomers: "customer:read",
    streamOrderInvalidations: "orders:read:any",
  });
  assert.equal(clientV1BrowserOperations.length, 11);
  assert.equal(clientV1BrowserOperations.filter((operation) => operation.permission === undefined).length, 7);
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
  assert.equal(resolveBrowserOperation("POST", "/api/client-v1/orders/drafts"), undefined);
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
