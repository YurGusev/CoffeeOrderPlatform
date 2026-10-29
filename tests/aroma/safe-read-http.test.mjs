import assert from "node:assert/strict";
import test from "node:test";
import { ProviderError } from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import {
  createHttpAromaCartClient,
  registerInternalRoutes,
} from "../../apps/api-internal/dist/index.js";
import {
  AromaObserverGatewayClient,
  GatewayClientError as ObserverError,
} from "../../apps/aroma-observer/dist/gateway-client.js";
import {
  AromaConvergenceGatewayClient,
  GatewayClientError as ConvergenceError,
} from "../../apps/aroma-convergence/dist/gateway-client.js";

const requestBody = { cartScopeRef: "aroma-primary" };
const snapshot = {
  cartScopeRef: "aroma-primary",
  providerSnapshotRef: "aroma-gateway:cart-body-sha256:" + "a".repeat(64),
  capturedAt: "2026-09-13T10:00:00Z",
  cartFingerprint: "b".repeat(64),
  lines: [{ offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV", quantity: "1" }],
};

async function runtime(t, caller, adapters) {
  const app = await createRuntime({
    name: "safe-read-http-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 15_000,
    deadlineProfiles: { defaultMs: 15_000 },
  });
  app.addHook("preHandler", async (request) => {
    request.runtimeContext.transportIdentity = {
      runtime: caller,
      environment: "test",
      san: `spiffe://test/${caller}`,
    };
  });
  registerInternalRoutes(app, adapters);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

function adapters(callerState) {
  return {
    verifyTransport: (_request, expectedCaller) =>
      callerState.value === expectedCaller,
    verifyCallerDelegation: () => {
      throw new Error("caller delegation must not be used for safe read");
    },
    signDelegation: ({ originalCaller, operationId, context }) => {
      callerState.signed = {
        originalCaller,
        operationId,
        correlationId: context.correlationId,
      };
      return `signed:${originalCaller}:${operationId}`;
    },
    customer: {
      orderInput: async () => {
        throw new Error("customer adapter must not be used");
      },
    },
    binding: {
      register: async () => {
        throw new Error("binding adapter must not be used");
      },
    },
    cart: {
      read: async (body, context, delegation) => {
        callerState.forwarded = {
          body,
          correlationId: context.correlationId,
          delegation,
        };
        return { status: 200, body: snapshot };
      },
    },
  };
}

void test("api-internal safe read derives caller from trusted transport and signs exact downstream delegation", async (t) => {
  for (const caller of ["aroma-observer", "aroma-convergence"]) {
    const state = { value: caller };
    const app = await runtime(t, caller, adapters(state));
    const response = await app.inject({
      method: "POST",
      url: "/api/internal-v1/aroma/cart-snapshots:read",
      headers: { "x-correlation-id": "corr-read" },
      payload: requestBody,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), snapshot);
    assert.equal(state.signed.originalCaller, caller);
    assert.equal(state.signed.operationId, "readAromaCartSnapshot");
    assert.equal(typeof state.signed.correlationId, "string");
    assert.deepEqual(state.forwarded.body, requestBody);
    assert.equal(
      state.forwarded.delegation,
      `signed:${caller}:readAromaCartSnapshot`,
    );
  }
});

void test("safe read rejects foreign identity, spoofed headers, malformed input, and invalid downstream DTO before provider work", async (t) => {
  const state = { value: "orders-service", calls: 0 };
  const adapter = adapters(state);
  adapter.cart.read = async () => {
    state.calls++;
    return { status: 200, body: snapshot };
  };
  const app = await runtime(t, "aroma-observer", adapter);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        payload: requestBody,
      })
    ).statusCode,
    401,
  );
  state.value = "aroma-observer";
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        headers: { "x-service-delegation": "forged" },
        payload: requestBody,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        payload: {},
      })
    ).statusCode,
    400,
  );
  adapter.cart.read = async () => {
    state.calls++;
    return { status: 200, body: { lines: [] } };
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/internal-v1/aroma/cart-snapshots:read",
        payload: requestBody,
      })
    ).statusCode,
    503,
  );
  assert.equal(state.calls, 1);
});

void test("safe read keeps R1/R2 typed provider failures at HTTP 503 instead of returning 200", async (t) => {
  const state = { value: "aroma-observer" };
  const adapter = adapters(state);
  const app = await runtime(t, "aroma-observer", adapter);
  for (const code of ["ProviderCartMappingMissing", "ProviderDecodeInvalid"]) {
    adapter.cart.read = async () => {
      throw new ProviderError(code);
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/internal-v1/aroma/cart-snapshots:read",
      payload: requestBody,
    });
    assert.equal(response.statusCode, 503);
    assert.notEqual(response.statusCode, 200);
    assert.equal(response.json().code, "AROMA_PROVIDER_UNAVAILABLE");
  }
});

void test("typed API-internal cart client forwards only the fixed route and bounded JSON", async () => {
  let call;
  const client = createHttpAromaCartClient({
    fetch: async (path, options) => {
      call = { path, options };
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await client.read(
    requestBody,
    { correlationId: "corr", signal: new AbortController().signal },
    "signed",
  );
  assert.deepEqual(result, { status: 200, body: snapshot });
  assert.equal(call.path, "/api/internal-v1/aroma/cart-snapshots:read");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers["x-service-delegation"], "signed");
  assert.equal(call.options.headers["x-actor-ref"], undefined);
});

const workerClients = [
  [AromaObserverGatewayClient, ObserverError],
  [AromaConvergenceGatewayClient, ConvergenceError],
];
const workerContext = () => ({
  correlationId: "corr-read-worker",
  signal: new AbortController().signal,
});
const workerOptions = { deadlineMs: 500, maxResponseBytes: 2048 };
const workerJson = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
const workerFailure = (ErrorClass, kind) => (error) => {
  assert.ok(error instanceof ErrorClass);
  assert.equal(error.kind, kind);
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  return true;
};

void test("worker read-only clients use transport identity and preserve complete historical snapshots", async (t) => {
  for (const [Client] of workerClients) {
    const caller =
      Client === AromaObserverGatewayClient
        ? "aroma-observer"
        : "aroma-convergence";
    const state = { value: caller };
    const app = await runtime(t, caller, adapters(state));
    let calls = 0;
    const client = new Client(
      {
        fetch: async (path, init) => {
          calls++;
          assert.equal(path, "/api/internal-v1/aroma/cart-snapshots:read");
          assert.equal(init.method, "POST");
          assert.equal(init.redirect, "error");
          assert.deepEqual(JSON.parse(init.body), requestBody);
          assert.deepEqual(init.headers, {
            accept: "application/json, application/problem+json",
            "content-type": "application/json",
            "x-correlation-id": "corr-read-worker",
          });
          assert.ok(init.signal instanceof AbortSignal);
          const response = await app.inject({
            method: init.method,
            url: path,
            headers: init.headers,
            payload: JSON.parse(init.body),
          });
          return new Response(response.body, {
            status: response.statusCode,
            headers: response.headers,
          });
        },
      },
      workerOptions,
    );
    assert.deepEqual(await client.read(workerContext()), snapshot);
    assert.equal(calls, 1);
    assert.equal(state.signed.originalCaller, caller);
    assert.equal(state.signed.operationId, "readAromaCartSnapshot");
    assert.equal(
      state.forwarded.delegation,
      `signed:${caller}:readAromaCartSnapshot`,
    );
    if (caller === "aroma-observer") {
      assert.equal(client.setQuantity, undefined);
      assert.equal(client.remove, undefined);
    }
    assert.deepEqual(
      await new Client(
        { fetch: async () => workerJson({ ...snapshot, lines: [] }) },
        workerOptions,
      ).read(workerContext()),
      { ...snapshot, lines: [] },
    );
  }
});

void test("worker reads never turn malformed, partial, wrong scope, non-JSON or oversized bodies into empty carts", async () => {
  for (const [Client, ErrorClass] of workerClients) {
    const cases = [
      () => workerJson({ lines: [] }),
      () => workerJson({ ...snapshot, cartScopeRef: "foreign" }),
      () => workerJson({ ...snapshot, extra: true }),
      () =>
        workerJson({
          ...snapshot,
          lines: [{ ...snapshot.lines[0], quantity: "0" }],
        }),
      () =>
        workerJson({
          ...snapshot,
          lines: [{ ...snapshot.lines[0], sourceGrindKeyHash: "G".repeat(64) }],
        }),
      () => workerJson({ ...snapshot, capturedAt: "2026-02-30T10:00:00Z" }),
      () =>
        new Response(null, { headers: { "content-type": "application/json" } }),
      () =>
        new Response("", { headers: { "content-type": "application/json" } }),
      () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
      () =>
        new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "text/plain" },
        }),
      () => new Response(JSON.stringify(snapshot)),
      () =>
        new Response(JSON.stringify(snapshot), {
          status: 302,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(2049));
            },
          }),
          {
            headers: {
              "content-type": "application/json",
              "content-length": "1",
            },
          },
        ),
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('{"lines":'));
              c.error(new Error("secret provider body"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      () =>
        new Response(Uint8Array.from([0xff]), {
          headers: { "content-type": "application/json" },
        }),
    ];
    for (const response of cases) {
      let calls = 0;
      const client = new Client(
        {
          fetch: async () => {
            calls++;
            return response();
          },
        },
        workerOptions,
      );
      await assert.rejects(
        client.read(workerContext()),
        workerFailure(ErrorClass, "InvalidResponse"),
      );
      assert.equal(calls, 1);
    }
    const bytes = Buffer.from(JSON.stringify(snapshot));
    assert.deepEqual(
      await new Client(
        {
          fetch: async () =>
            new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(bytes.subarray(0, 31));
                  c.enqueue(bytes.subarray(31));
                  c.close();
                },
              }),
              { headers: { "content-type": "application/json" } },
            ),
        },
        { ...workerOptions, maxResponseBytes: bytes.length },
      ).read(workerContext()),
      snapshot,
    );
    await assert.rejects(
      new Client(
        { fetch: async () => workerJson(snapshot) },
        { ...workerOptions, maxResponseBytes: bytes.length - 1 },
      ).read(workerContext()),
      workerFailure(ErrorClass, "InvalidResponse"),
    );
  }
});

void test("worker read cancellation, deadline and typed provider rejection never retry or leak diagnostics", async () => {
  for (const [Client, ErrorClass] of workerClients) {
    const controller = new AbortController();
    controller.abort(new Error("secret"));
    let calls = 0;
    const client = new Client(
      {
        fetch: async () => {
          calls++;
          return workerJson(snapshot);
        },
      },
      workerOptions,
    );
    await assert.rejects(
      client.read({ ...workerContext(), signal: controller.signal }),
      workerFailure(ErrorClass, "TransportUnavailable"),
    );
    assert.equal(calls, 0);
    for (const phase of ["fetch", "body"]) {
      let signal,
        canceled = false;
      const timed = new Client(
        {
          fetch: async (_path, init) => {
            calls++;
            signal = init.signal;
            if (phase === "fetch") return new Promise(() => {});
            return new Response(
              new ReadableStream({
                cancel() {
                  canceled = true;
                },
              }),
              { headers: { "content-type": "application/json" } },
            );
          },
        },
        { ...workerOptions, deadlineMs: 20 },
      );
      const before = calls;
      await assert.rejects(
        timed.read(workerContext()),
        workerFailure(ErrorClass, "TransportUnavailable"),
      );
      assert.equal(calls, before + 1);
      assert.equal(signal.aborted, true);
      if (phase === "body") assert.equal(canceled, true);
    }
    const lost = new Client(
      {
        fetch: async () => {
          throw new Error("https://provider.invalid cookie=password");
        },
      },
      workerOptions,
    );
    await assert.rejects(lost.read(workerContext()), (error) => {
      workerFailure(ErrorClass, "TransportUnavailable")(error);
      assert.doesNotMatch(
        JSON.stringify(error) + error.stack,
        /cookie|password|provider\.invalid/,
      );
      return true;
    });
    const problem = {
      type: "about:blank",
      title: "secret",
      status: 503,
      code: "AROMA_PROVIDER_UNAVAILABLE",
      detail: "cookie=password",
      instance: "https://provider.invalid",
      correlationId: "00000000-0000-4000-8000-000000000000",
      errors: [],
    };
    const rejected = new Client(
      {
        fetch: async () =>
          new Response(JSON.stringify(problem), {
            status: 503,
            headers: { "content-type": "application/problem+json" },
          }),
      },
      workerOptions,
    );
    await assert.rejects(rejected.read(workerContext()), (error) => {
      workerFailure(ErrorClass, "Rejected")(error);
      assert.equal(error.status, 503);
      assert.equal(error.problemCode, "AROMA_PROVIDER_UNAVAILABLE");
      assert.doesNotMatch(
        JSON.stringify(error) + error.stack,
        /secret|cookie|password|provider\.invalid/,
      );
      return true;
    });
  }
});

void test("worker context forbids caller identity, credentials, URL or delegation and requires bounded options", async () => {
  for (const [Client, ErrorClass] of workerClients) {
    let calls = 0;
    const http = {
      fetch: async () => {
        calls++;
        return workerJson(snapshot);
      },
    };
    const client = new Client(http, workerOptions);
    for (const patch of [
      { actor: "operator" },
      { credentials: "secret" },
      { url: "https://foreign.invalid" },
      { "x-service-delegation": "forged" },
      { signal: undefined },
      { correlationId: "bad\r\nAuthorization: secret" },
      { traceparent: "invalid" },
    ]) {
      await assert.rejects(
        client.read({ ...workerContext(), ...patch }),
        workerFailure(ErrorClass, "InvalidRequest"),
      );
    }
    assert.equal(calls, 0);
    for (const patch of [
      { deadlineMs: 0 },
      { deadlineMs: 0.1 },
      { deadlineMs: 2147483648 },
      { maxResponseBytes: 0 },
      { maxResponseBytes: Infinity },
      { maxResponseBytes: -1 },
    ]) {
      assert.throws(
        () => new Client(http, { ...workerOptions, ...patch }),
        workerFailure(ErrorClass, "InvalidRequest"),
      );
    }
  }
});
