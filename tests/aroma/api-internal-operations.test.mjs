import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  configuredCatalogOrigin,
  configuredCatalogTls,
  createConfiguredInternalAdapters,
  createHttpAromaCatalogClient,
  createHttpAromaCartClient,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";
import {
  isAromaCatalogExportRequest,
  isAromaRemoveLineRequest,
  isAromaSetQuantityRequest,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import {
  signServiceDelegation,
  verifyServiceDelegationWithKeySet,
} from "../../packages/platform-security/dist/index.js";

const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const exportRequest = {
  snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};
const setRequest = {
  operationRef,
  cartScopeRef: "aroma-primary",
  quantity: "2",
};
const removeRequest = { operationRef, cartScopeRef: "aroma-primary" };
const mutationResponse = {
  operationRef,
  cartScopeRef: "aroma-primary",
  offerRef,
  state: "Acknowledged",
};
const cartItemNotFound = {
  type: "about:blank",
  title: "AROMA_CART_ITEM_NOT_FOUND",
  status: 404,
  code: "AROMA_CART_ITEM_NOT_FOUND",
  detail: "Cart line was not present in the fresh provider snapshot",
  instance: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
  correlationId: "00000000-0000-4000-8000-000000000000",
  errors: [],
};
const snapshot = {
  cartScopeRef: "aroma-primary",
  providerSnapshotRef: "provider-1",
  capturedAt: "2026-09-13T10:00:00Z",
  cartFingerprint: "a".repeat(64),
  lines: [{ offerRef, quantity: "2" }],
};

void test("shared AROMA request validators preserve decimal wire and reject non-canonical shapes", () => {
  assert.equal(isAromaCatalogExportRequest(exportRequest), true);
  assert.equal(
    isAromaCatalogExportRequest({ ...exportRequest, extra: true }),
    false,
  );
  assert.equal(
    isAromaCatalogExportRequest({ ...exportRequest, snapshotRef: 1 }),
    false,
  );
  assert.equal(
    isAromaSetQuantityRequest({ ...setRequest, quantity: "0.001" }),
    true,
  );
  const numericQuantity = { ...setRequest, quantity: 2 };
  assert.equal(isAromaSetQuantityRequest(numericQuantity), false);
  assert.equal(numericQuantity.quantity, 2);
  assert.equal(
    isAromaSetQuantityRequest({ ...setRequest, extra: true }),
    false,
  );
  assert.equal(isAromaRemoveLineRequest(removeRequest), true);
  assert.equal(
    isAromaRemoveLineRequest({ ...removeRequest, quantity: "1" }),
    false,
  );
});

function exportStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('{"recordType":"snapshot-started"}\n'),
      );
      controller.close();
    },
  });
}

function adapters(state) {
  return {
    verifyTransport: (_request, expected) => state.caller === expected,
    verifyCallerDelegation: () => {
      throw new Error("not used");
    },
    signDelegation: ({ originalCaller, operationId, context }) => {
      state.delegations.push({
        originalCaller,
        operationId,
        correlationId: context.correlationId,
      });
      return `delegation:${originalCaller}:${operationId}`;
    },
    customer: {
      orderInput: async () => {
        throw new Error("not used");
      },
    },
    binding: {
      register: async () => {
        throw new Error("not used");
      },
    },
    catalog: {
      export: async (body, context, delegation) => {
        state.calls.push({ operation: "export", body, context, delegation });
        return { status: 200, body: exportStream() };
      },
    },
    cart: {
      read: async (body, context, delegation) => {
        state.calls.push({ operation: "read", body, context, delegation });
        return { status: 200, body: snapshot };
      },
      setQuantity: async (pathOfferRef, body, context, delegation) => {
        state.calls.push({
          operation: "set",
          pathOfferRef,
          body,
          context,
          delegation,
        });
        return state.mutationResult ?? { status: 200, body: mutationResponse };
      },
      remove: async (pathOfferRef, body, context, delegation) => {
        state.calls.push({
          operation: "remove",
          pathOfferRef,
          body,
          context,
          delegation,
        });
        return state.mutationResult ?? { status: 200, body: mutationResponse };
      },
    },
  };
}

async function appFor(t, caller) {
  const state = { caller, calls: [], delegations: [] };
  const app = await createRuntime({
    name: "api-internal-operations-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 15_000,
    deadlineProfiles: { defaultMs: 15_000 },
  });
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {
      runtime: state.caller,
      environment: "test",
      san: `spiffe://test/${state.caller}`,
    };
  });
  registerInternalRoutes(app, adapters(state));
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return { app, state };
}

void test("all four aroma operation mounts use exact caller and delegation capabilities", async (t) => {
  const { app, state } = await appFor(t, "catalog-supplier-sync");
  const exported = await app.inject({
    method: "POST",
    url: "/api/internal-v1/aroma/catalog-exports",
    payload: exportRequest,
    headers: { "x-correlation-id": "corr-export" },
  });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers["content-type"], /^application\/x-ndjson/);
  assert.equal(state.delegations.at(-1).operationId, "exportAromaCatalog");
  assert.equal(
    state.delegations.at(-1).originalCaller,
    "catalog-supplier-sync",
  );

  state.caller = "aroma-convergence";
  const operations = [
    {
      url: "/api/internal-v1/aroma/cart-snapshots:read",
      payload: { cartScopeRef: "aroma-primary" },
      operation: "readAromaCartSnapshot",
    },
    {
      url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
      payload: setRequest,
      operation: "setAromaCartLineQuantity",
    },
    {
      url: `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
      payload: removeRequest,
      operation: "removeAromaCartLine",
    },
  ];
  for (const entry of operations) {
    const response = await app.inject({
      method: "POST",
      url: entry.url,
      payload: entry.payload,
    });
    assert.equal(response.statusCode, 200, `${entry.operation} status`);
    assert.equal(state.delegations.at(-1).operationId, entry.operation);
    assert.equal(state.delegations.at(-1).originalCaller, "aroma-convergence");
  }
  assert.deepEqual(
    state.calls.map((entry) => entry.operation),
    ["export", "read", "set", "remove"],
  );
});

void test("configured Catalog pricing delegation verifies caller claims before owner access", async (t) => {
  const orders = generateKeyPairSync("ed25519");
  const pricing = generateKeyPairSync("ed25519");
  const apiInternal = generateKeyPairSync("ed25519");
  const pem = (key, type) => key.export({ type, format: "pem" });
  const context = {
    config: {
      environment: "development",
      services: {
        "api-internal": {
          outbound: ["catalog-service:4102"],
        },
      },
    },
    secrets: {
      security: {
        apiInternalDelegationSigningPrivateKey: pem(
          apiInternal.privateKey,
          "pkcs8",
        ),
        serviceVerificationKeys: {
          "orders-service": {
            active: pem(orders.publicKey, "spki"),
            previous: pem(orders.publicKey, "spki"),
          },
          "pricing-service": {
            active: pem(pricing.publicKey, "spki"),
            previous: pem(pricing.publicKey, "spki"),
          },
        },
      },
    },
  };
  assert.equal(
    configuredCatalogOrigin(context),
    "https://catalog-service:4102",
  );
  assert.throws(
    () => configuredCatalogTls(context),
    /scoped service transport material is required/u,
  );

  const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const pricingInput = {
    productRef,
    variantRef,
    offerRef,
    snapshotRevision: "17",
    supplierUnitMinor: "1200",
    currency: "RUB",
    unit: "gram",
    availability: "Available",
    mappingRevision: "2",
    displayName: "Coffee Arabica",
  };
  const bindingRequest = {
    offerRef,
    supplierRef: "sup_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    snapshotRef: "snp_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    sourceIdentityScheme: "hmac-sha256-v1",
    sourceOfferKeyHash: "c".repeat(64),
  };
  const bindingResponse = {
    offerRef: bindingRequest.offerRef,
    supplierRef: bindingRequest.supplierRef,
    sourceIdentityScheme: bindingRequest.sourceIdentityScheme,
    sourceOfferKeyHash: bindingRequest.sourceOfferKeyHash,
    firstSnapshotRef: bindingRequest.snapshotRef,
    state: "Bound",
  };
  const gatewayCartLines = [{ offerRef, quantity: "2" }];
  const gatewaySnapshot = {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"a".repeat(64)}`,
    capturedAt: "2026-09-13T10:00:00Z",
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(gatewayCartLines), "utf8")
      .digest("hex"),
    lines: gatewayCartLines,
  };
  const ownerCalls = [];
  let bindingFetchResponse;
  const configured = createConfiguredInternalAdapters(context, {
    fetch: async (path, options) => {
      ownerCalls.push({ path, options });
      if (path === "/api/internal-v1/aroma/offer-bindings")
        return bindingFetchResponse ?? Response.json(bindingResponse);
      if (path === "/api/internal-v1/aroma/catalog-exports")
        return new Response(exportStream(), {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        });
      if (path === "/api/internal-v1/aroma/cart-snapshots:read")
        return Response.json(gatewaySnapshot);
      return Response.json(pricingInput);
    },
  });
  const app = await createRuntime({
    name: "api-internal-configured-catalog-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
    deadlineProfiles: { defaultMs: 5_000 },
  });
  let transportRuntime = "pricing-service";
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {
      runtime: transportRuntime,
      environment: "test",
      san: `spiffe://test/${transportRuntime}`,
    };
  });
  registerInternalRoutes(app, configured);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));

  const path = `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
  const now = Math.floor(Date.now() / 1_000);
  const callerClaims = {
    iss: "pricing-service",
    aud: "api-internal",
    originalCaller: "pricing-service",
    operationId: "getCatalogPricingInput",
    correlationId: randomUUID(),
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    iat: now,
    exp: now + 30,
    jti: randomUUID(),
    kid: "test-pricing-v1",
  };
  const badCallerToken = signServiceDelegation(
    { ...callerClaims, operationId: "readAromaCartSnapshot" },
    pricing.privateKey,
  );
  const rejected = await app.inject({
    method: "GET",
    url: path,
    headers: { "x-service-delegation": badCallerToken },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().code, "SERVICE_DELEGATION_INVALID");
  assert.equal(ownerCalls.length, 0);

  const callerToken = signServiceDelegation(callerClaims, pricing.privateKey);
  const accepted = await app.inject({
    method: "GET",
    url: path,
    headers: { "x-service-delegation": callerToken },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), pricingInput);
  assert.equal(ownerCalls.length, 1);
  assert.equal(ownerCalls[0].path, path);
  assert.equal(ownerCalls[0].options.method, "GET");
  assert.equal(ownerCalls[0].options.body, undefined);

  const outgoing = verifyServiceDelegationWithKeySet(
    ownerCalls[0].options.headers["x-service-delegation"],
    {
      publicKeys: [apiInternal.publicKey],
      issuer: "api-internal",
      audience: "catalog-service",
      nowEpochSeconds: Math.floor(Date.now() / 1_000),
      clockSkewSeconds: 5,
    },
  );
  assert.equal(outgoing.originalCaller, "pricing-service");
  assert.equal(outgoing.operationId, "getCatalogPricingInput");
  assert.equal(
    outgoing.correlationId,
    ownerCalls[0].options.headers["x-correlation-id"],
  );

  const gatewayOperations = [
    {
      caller: "catalog-activation-worker",
      operationId: "registerAromaOfferBinding",
      path: "/api/internal-v1/aroma/offer-bindings",
      correlationId: "10000000-0000-4000-8000-000000000001",
      requestPath: "/api/internal-v1/aroma/offer-bindings",
      payload: bindingRequest,
      responseBody: bindingResponse,
      contentType: "application/json",
      accept: "application/json",
    },
    {
      caller: "catalog-supplier-sync",
      operationId: "exportAromaCatalog",
      path: "/api/internal-v1/aroma/catalog-exports",
      correlationId: "10000000-0000-4000-8000-000000000002",
      requestPath: "/api/internal-v1/aroma/catalog-exports",
      payload: exportRequest,
      contentType: "application/json",
      accept: "application/x-ndjson",
    },
    {
      caller: "aroma-convergence",
      operationId: "readAromaCartSnapshot",
      path: "/api/internal-v1/aroma/cart-snapshots:read",
      correlationId: "10000000-0000-4000-8000-000000000003",
      requestPath: "/api/internal-v1/aroma/cart-snapshots:read",
      payload: { cartScopeRef: "aroma-primary" },
      responseBody: gatewaySnapshot,
      contentType: "application/json",
      accept: "application/json",
    },
  ];
  const gatewayRequestHeaders = {
    traceparent: "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
  };
  const gatewayResponseIndexes = [];
  for (const entry of gatewayOperations) {
    transportRuntime = entry.caller;
    const response = await app.inject({
      method: "POST",
      url: entry.requestPath,
      payload: entry.payload,
      headers: {
        "x-correlation-id": entry.correlationId,
        ...gatewayRequestHeaders,
      },
    });
    assert.equal(ownerCalls.at(-1)?.path, entry.path);
    assert.equal(
      response.statusCode,
      200,
      `${entry.operationId} status: ${response.body}`,
    );
    if (entry.responseBody !== undefined)
      assert.deepEqual(response.json(), entry.responseBody);
    else
      assert.match(response.headers["content-type"], /^application\/x-ndjson/u);
    gatewayResponseIndexes.push(ownerCalls.length - 1);
  }

  for (let index = 0; index < gatewayOperations.length; index += 1) {
    const entry = gatewayOperations[index];
    const call = ownerCalls[gatewayResponseIndexes[index]];
    assert.equal(call.path, entry.path);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.headers["content-type"], entry.contentType);
    assert.equal(call.options.headers.accept, entry.accept);
    assert.equal(call.options.headers["x-correlation-id"], entry.correlationId);
    assert.equal(
      call.options.headers.traceparent,
      gatewayRequestHeaders.traceparent,
    );
    assert.deepEqual(JSON.parse(call.options.body), entry.payload);
    const gatewayClaims = verifyServiceDelegationWithKeySet(
      call.options.headers["x-service-delegation"],
      {
        publicKeys: [apiInternal.publicKey],
        issuer: "api-internal",
        audience: "aroma-gateway",
        nowEpochSeconds: Math.floor(Date.now() / 1_000),
        clockSkewSeconds: 5,
      },
    );
    assert.equal(gatewayClaims.originalCaller, entry.caller);
    assert.equal(gatewayClaims.operationId, entry.operationId);
    assert.equal(gatewayClaims.correlationId, entry.correlationId);
    assert.equal(gatewayClaims.traceparent, gatewayRequestHeaders.traceparent);
  }

  transportRuntime = "catalog-activation-worker";
  const registerBinding = () =>
    app.inject({
      method: "POST",
      url: "/api/internal-v1/aroma/offer-bindings",
      payload: bindingRequest,
      headers: {
        "x-correlation-id": "10000000-0000-4000-8000-000000000004",
        ...gatewayRequestHeaders,
      },
    });
  const bindingProblem = (status, code) =>
    Response.json(
      {
        type: "about:blank",
        title: code,
        status,
        code,
        detail: "binding-upstream-private-canary",
        instance: "/api/internal-v1/aroma/offer-bindings",
        correlationId: "10000000-0000-4000-8000-000000000004",
        errors: [],
      },
      { status: 409 },
    );

  bindingFetchResponse = bindingProblem(409, "AROMA_BINDING_CONFLICT");
  const conflict = await registerBinding();
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "AROMA_BINDING_CONFLICT");
  assert.equal(
    conflict.json().detail,
    "immutable binding request was rejected",
  );
  assert.equal(conflict.headers["cache-control"], "no-store");
  assert.doesNotMatch(conflict.body, /binding-upstream-private-canary/u);

  for (const problemValue of [
    bindingProblem(503, "AROMA_BINDING_CONFLICT"),
    bindingProblem(409, "AROMA_BINDING_PRIVATE_FAILURE"),
  ]) {
    bindingFetchResponse = problemValue;
    const unavailable = await registerBinding();
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.json().code, "AROMA_PROVIDER_UNAVAILABLE");
    assert.equal(unavailable.headers["cache-control"], "no-store");
    assert.doesNotMatch(unavailable.body, /binding-upstream-private-canary/u);
  }
});

void test("deterministic Gateway cart-item 404 survives api-internal fanout", async (t) => {
  const { app, state } = await appFor(t, "aroma-convergence");
  state.mutationResult = { status: 404, body: cartItemNotFound };
  const response = await app.inject({
    method: "POST",
    url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
    payload: setRequest,
  });
  assert.equal(response.statusCode, 404);
  assert.equal(
    response.headers["content-type"].startsWith("application/problem+json"),
    true,
  );
  assert.equal(response.json().code, "AROMA_CART_ITEM_NOT_FOUND");
  assert.equal(state.calls.at(-1).operation, "set");
});

void test("forbidden caller, forged delegation, wrong operation shape, and malformed requests fail before downstream calls", async (t) => {
  const { app, state } = await appFor(t, "orders-service");
  const before = state.calls.length;
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/catalog-exports",
        payload: exportRequest,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/catalog-exports",
        headers: { "x-service-delegation": "forged" },
        payload: exportRequest,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-lines/not-an-offer:set-quantity",
        payload: setRequest,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
        payload: { ...removeRequest, operationRef: "op_wrong" },
      })
    ).statusCode,
    401,
  );
  assert.equal(state.calls.length, before);

  state.caller = "catalog-supplier-sync";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/catalog-exports",
        payload: { ...exportRequest, extra: true },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/catalog-exports",
        payload: { ...exportRequest, snapshotRef: 1 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
        payload: setRequest,
      })
    ).statusCode,
    401,
  );
  state.caller = "aroma-convergence";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/catalog-exports",
        payload: exportRequest,
      })
    ).statusCode,
    401,
  );
  for (const [url, payload] of [
    [
      `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
      { ...setRequest, quantity: 2 },
    ],
    [
      `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
      { ...setRequest, extra: true },
    ],
    [
      `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
      { ...removeRequest, quantity: "1" },
    ],
  ]) {
    assert.equal(
      (await app.inject({ method: "POST", url, payload })).statusCode,
      400,
    );
  }
  assert.equal(state.calls.length, before);
});

void test("typed gateway clients keep export streaming and propagate cancellation without buffering", async () => {
  const calls = [];
  let pulls = 0;
  const client = createHttpAromaCatalogClient({
    fetch: async (path, options) => {
      calls.push({ path, options });
      const body = new ReadableStream({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode("chunk\n"));
        },
        cancel() {
          calls.push({ cancelled: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });
  const controller = new AbortController();
  const result = await client.export(
    exportRequest,
    { correlationId: "corr", signal: controller.signal },
    "signed-export",
  );
  assert.equal(result.status, 200);
  assert.equal(pulls <= 1, true);
  assert.equal(calls[0].path, "/api/internal-v1/aroma/catalog-exports");
  assert.equal(
    calls[0].options.headers["x-service-delegation"],
    "signed-export",
  );
  assert.equal(calls[0].options.signal, controller.signal);
  const reader = result.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "chunk\n");
  await reader.cancel();
  controller.abort();
  assert.equal(controller.signal.aborted, true);
});

void test("typed cart client mounts exact mutation routes and forwards request cancellation", async () => {
  const calls = [];
  const cart = createHttpAromaCartClient({
    fetch: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify(mutationResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const signal = new AbortController().signal;
  await cart.setQuantity(
    offerRef,
    setRequest,
    { correlationId: "corr", signal },
    "signed-set",
  );
  await cart.remove(
    offerRef,
    removeRequest,
    { correlationId: "corr", signal },
    "signed-remove",
  );
  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      `/api/internal-v1/aroma/cart-lines/${offerRef}:set-quantity`,
      `/api/internal-v1/aroma/cart-lines/${offerRef}:remove`,
    ],
  );
  assert.equal(calls[0].options.headers["x-service-delegation"], "signed-set");
  assert.equal(
    calls[1].options.headers["x-service-delegation"],
    "signed-remove",
  );
});
