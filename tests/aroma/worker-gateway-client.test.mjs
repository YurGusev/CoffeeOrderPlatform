import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { normalizeAromaCartSnapshot } from "../../packages/contracts/aroma-v1/dist/index.js";
import {
  AromaConvergenceGatewayClient,
  GatewayClientError,
} from "../../apps/aroma-convergence/dist/gateway-client.js";
import {
  AromaObserverGatewayClient,
  GatewayClientError as ObserverGatewayClientError,
} from "../../apps/aroma-observer/dist/gateway-client.js";

const offerRef = "off_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const grind = "a".repeat(64);
const traceparent = "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01";
const context = () => ({
  correlationId: "corr-worker",
  traceparent,
  signal: new AbortController().signal,
});
const options = { deadlineMs: 500, maxResponseBytes: 2048 };
const MAX_RESPONSE_BYTES = 2_097_152;
const setBody = { operationRef, cartScopeRef: "aroma-primary", quantity: "3" };
const removeBody = { operationRef, cartScopeRef: "aroma-primary" };
const ack = {
  operationRef,
  cartScopeRef: "aroma-primary",
  offerRef,
  state: "Acknowledged",
};
const json = (body, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": type },
  });
const invoke = (client, method, body, ctx = context()) =>
  client[method](offerRef, body, ctx);
const expectError =
  (kind, ErrorClass = GatewayClientError) =>
  (error) => {
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.kind, kind);
    assert.equal(
      error.code,
      {
        InvalidRequest: "AROMA_GATEWAY_INVALID_REQUEST",
        TransportUnavailable: "AROMA_GATEWAY_TRANSPORT_UNAVAILABLE",
        Rejected: "AROMA_GATEWAY_REJECTED",
        InvalidResponse: "AROMA_GATEWAY_INVALID_RESPONSE",
      }[kind],
    );
    assert.equal(error.message, error.code);
    assert.equal(error.cause, undefined);
    return true;
  };

function largeGrindCart() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const lines = Array.from({ length: 10_000 }, (_, index) => {
    let value = index;
    let ref = "";
    do {
      ref = alphabet[value % 32] + ref;
      value = Math.floor(value / 32);
    } while (value > 0);
    return {
      offerRef: `off_${ref.padStart(26, "0")}`,
      quantity: "1.000",
      sourceGrindKeyHash: grind,
    };
  });
  return {
    cartScopeRef: "aroma-primary",
    providerSnapshotRef: `aroma-gateway:cart-body-sha256:${"b".repeat(64)}`,
    capturedAt: "2026-10-03T00:00:00Z",
    cartFingerprint: createHash("sha256")
      .update(JSON.stringify(lines), "utf8")
      .digest("hex"),
    lines,
  };
}

void test("observer and convergence accept 10000 grind lines with fingerprint under 2 MiB and reject larger bodies", async () => {
  const snapshot = largeGrindCart();
  assert.equal(normalizeAromaCartSnapshot(snapshot).lines.length, 10_000);
  const serialized = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serialized) > 1_048_576);
  assert.ok(Buffer.byteLength(serialized) < MAX_RESPONSE_BYTES);
  const oversized = `${serialized}${" ".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(serialized) + 1)}`;
  for (const [GatewayClient, ErrorClass] of [
    [AromaObserverGatewayClient, ObserverGatewayClientError],
    [AromaConvergenceGatewayClient, GatewayClientError],
  ]) {
    let calls = 0;
    const client = new GatewayClient(
      {
        fetch: async () => {
          calls++;
          return new Response(serialized, {
            headers: { "content-type": "application/json" },
          });
        },
      },
      { ...options, maxResponseBytes: MAX_RESPONSE_BYTES },
    );
    const read = await client.read(context());
    assert.equal(read.lines.length, 10_000);
    assert.equal(
      read.lines.every((line) => line.sourceGrindKeyHash === grind),
      true,
    );
    assert.equal(read.cartFingerprint, snapshot.cartFingerprint);
    const overLimit = new GatewayClient(
      {
        fetch: async () =>
          new Response(oversized, {
            headers: { "content-type": "application/json" },
          }),
      },
      { ...options, maxResponseBytes: MAX_RESPONSE_BYTES },
    );
    await assert.rejects(
      overLimit.read(context()),
      expectError("InvalidResponse", ErrorClass),
    );
    assert.equal(calls, 1);
  }
});

void test("worker mutations forward only exact fixed routes, integer package quantity and selected grind", async () => {
  const calls = [];
  const client = new AromaConvergenceGatewayClient(
    {
      fetch: async (path, init) => {
        calls.push({ path, init });
        const body = JSON.parse(init.body);
        return json({
          ...ack,
          ...(body.sourceGrindKeyHash === undefined
            ? {}
            : { sourceGrindKeyHash: body.sourceGrindKeyHash }),
        });
      },
    },
    options,
  );
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    for (const selected of [undefined, grind]) {
      const request = {
        ...body,
        ...(selected === undefined ? {} : { sourceGrindKeyHash: selected }),
      };
      assert.deepEqual(await invoke(client, method, request), {
        ...ack,
        ...(selected === undefined ? {} : { sourceGrindKeyHash: selected }),
      });
      const { path, init } = calls.at(-1);
      assert.equal(
        path,
        `/api/internal-v1/aroma/cart-lines/${offerRef}:${method === "setQuantity" ? "set-quantity" : "remove"}`,
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.deepEqual(JSON.parse(init.body), request);
      assert.deepEqual(init.headers, {
        accept: "application/json, application/problem+json",
        "content-type": "application/json",
        "x-correlation-id": "corr-worker",
        traceparent,
      });
      assert.ok(init.signal instanceof AbortSignal);
    }
  }
  assert.equal(calls.length, 4);
});

void test("invalid mutation offer, quantity, grind, operation, scope or extra fields fail before fetch", async () => {
  let calls = 0;
  const client = new AromaConvergenceGatewayClient(
    {
      fetch: async () => {
        calls++;
        return json(ack);
      },
    },
    options,
  );
  for (const badOffer of [
    "off_invalid",
    offerRef + "/other",
    "https://provider.invalid",
    offerRef.toLowerCase(),
  ]) {
    for (const [method, body] of [
      ["setQuantity", setBody],
      ["remove", removeBody],
    ]) {
      await assert.rejects(
        client[method](badOffer, body, context()),
        expectError("InvalidRequest"),
      );
    }
  }
  for (const quantity of [
    "0",
    "-1",
    "01",
    "3.0",
    "2.5",
    "0.001",
    "1e3",
    3,
    "",
    "NaN",
  ]) {
    await assert.rejects(
      invoke(client, "setQuantity", { ...setBody, quantity }),
      expectError("InvalidRequest"),
    );
  }
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    for (const patch of [
      { operationRef: "bad" },
      { cartScopeRef: "other" },
      { sourceGrindKeyHash: "G".repeat(64) },
      { sourceGrindKeyHash: null },
      { sourceGrindKeyHash: "a".repeat(63) },
      { extra: true },
    ]) {
      await assert.rejects(
        invoke(client, method, { ...body, ...patch }),
        expectError("InvalidRequest"),
      );
    }
  }
  await assert.rejects(
    invoke(client, "remove", { ...removeBody, quantity: "1" }),
    expectError("InvalidRequest"),
  );
  assert.equal(calls, 0);
});

void test("wrong mutation echo including grind presence is invalid, never acknowledged success", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    for (const selected of [undefined, grind]) {
      const request = {
        ...body,
        ...(selected === undefined ? {} : { sourceGrindKeyHash: selected }),
      };
      const good = {
        ...ack,
        ...(selected === undefined ? {} : { sourceGrindKeyHash: selected }),
      };
      const missingGrind = { ...good };
      delete missingGrind.sourceGrindKeyHash;
      const responses = [
        { ...good, operationRef: "op_01ARZ3NDEKTSV4RRFFQ69G5FAA" },
        { ...good, offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAA" },
        { ...good, cartScopeRef: "foreign" },
        { ...good, sourceGrindKeyHash: "b".repeat(64) },
        { ...good, state: "Verified" },
        { ...good, extra: true },
        selected === undefined
          ? { ...good, sourceGrindKeyHash: grind }
          : missingGrind,
      ];
      for (const response of responses) {
        let calls = 0;
        const client = new AromaConvergenceGatewayClient(
          {
            fetch: async () => {
              calls++;
              return json(response);
            },
          },
          options,
        );
        await assert.rejects(
          invoke(client, method, request),
          expectError("InvalidResponse"),
        );
        assert.equal(calls, 1);
      }
    }
  }
});

void test("mutation timeout, lost response and partial body are sanitized with no retries", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    for (const [fetchResponse, kind] of [
      [
        async () => {
          throw new Error("https://provider.invalid/password cookie=secret");
        },
        "TransportUnavailable",
      ],
      [
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode('{"operationRef":'),
                );
                controller.error(new Error("cookie=secret"));
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
        "InvalidResponse",
      ],
      [async () => new Promise(() => {}), "TransportUnavailable"],
    ]) {
      let calls = 0;
      const client = new AromaConvergenceGatewayClient(
        {
          fetch: (...args) => {
            calls++;
            return fetchResponse(...args);
          },
        },
        { ...options, deadlineMs: 20 },
      );
      await assert.rejects(invoke(client, method, body), expectError(kind));
      assert.equal(calls, 1);
    }
  }
});

void test("mutation abort before dispatch is zero calls; abort after dispatch cancels fetch/body once", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    const controller = new AbortController();
    controller.abort(new Error("secret"));
    let calls = 0;
    const client = new AromaConvergenceGatewayClient(
      {
        fetch: async () => {
          calls++;
          return json(ack);
        },
      },
      options,
    );
    await assert.rejects(
      invoke(client, method, body, { ...context(), signal: controller.signal }),
      expectError("TransportUnavailable"),
    );
    assert.equal(calls, 0);
    for (const phase of ["fetch", "body"]) {
      const aborter = new AbortController();
      let seenSignal,
        canceled = false;
      const active = new AromaConvergenceGatewayClient(
        {
          fetch: async (_path, init) => {
            calls++;
            seenSignal = init.signal;
            setTimeout(() => aborter.abort(new Error("credential")), 10);
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
        options,
      );
      const before = calls;
      await assert.rejects(
        invoke(active, method, body, { ...context(), signal: aborter.signal }),
        expectError("TransportUnavailable"),
      );
      assert.equal(calls, before + 1);
      assert.equal(seenSignal.aborted, true);
      if (phase === "body") assert.equal(canceled, true);
    }
  }
});

void test("mutation rejects empty, invalid, non-JSON, oversized and redirected responses", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    const cases = [
      () =>
        new Response(null, { headers: { "content-type": "application/json" } }),
      () =>
        new Response("", { headers: { "content-type": "application/json" } }),
      () =>
        new Response("{", { headers: { "content-type": "application/json" } }),
      () =>
        new Response(JSON.stringify(ack), {
          headers: { "content-type": "text/plain" },
        }),
      () => json(ack, 201),
      () => json(ack, 302),
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
    ];
    for (const response of cases) {
      let calls = 0;
      const client = new AromaConvergenceGatewayClient(
        {
          fetch: async () => {
            calls++;
            return response();
          },
        },
        options,
      );
      await assert.rejects(
        invoke(client, method, body),
        expectError("InvalidResponse"),
      );
      assert.equal(calls, 1);
    }
  }
});

void test("only schema-valid whitelisted ProblemDetails with matching status becomes sanitized rejection", async () => {
  const problem = (code, status) => ({
    type: "about:blank",
    title: "secret",
    status,
    code,
    detail: "cookie=secret",
    instance: "https://provider.invalid/secret",
    correlationId: "00000000-0000-4000-8000-000000000000",
    errors: [],
  });
  const allowed = [
    ["VALIDATION_FAILED", 400],
    ["SERVICE_AUTHENTICATION_REQUIRED", 401],
    ["SERVICE_DELEGATION_INVALID", 403],
    ["AROMA_CART_ITEM_NOT_FOUND", 404],
    ["AROMA_OPERATION_REF_CONFLICT", 409],
    ["AROMA_OPERATION_IN_PROGRESS", 409],
    ["AROMA_OPERATION_UNKNOWN_OUTCOME", 409],
    ["AROMA_PROVIDER_UNAVAILABLE", 503],
  ];
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    for (const [code, status] of allowed) {
      let calls = 0;
      const client = new AromaConvergenceGatewayClient(
        {
          fetch: async () => {
            calls++;
            return json(
              problem(code, status),
              status,
              "application/problem+json",
            );
          },
        },
        options,
      );
      await assert.rejects(invoke(client, method, body), (error) => {
        expectError("Rejected")(error);
        assert.equal(error.status, status);
        assert.equal(error.problemCode, code);
        assert.doesNotMatch(
          JSON.stringify(error) + error.stack,
          /secret|cookie|provider\.invalid/,
        );
        return true;
      });
      assert.equal(calls, 1);
    }
    for (const [response, type] of [
      [problem("FOREIGN_SECRET", 409), "application/problem+json"],
      [problem("AROMA_CART_ITEM_NOT_FOUND", 409), "application/problem+json"],
      [
        problem("AROMA_OPERATION_REF_CONFLICT", 503),
        "application/problem+json",
      ],
      [problem("AROMA_OPERATION_REF_CONFLICT", 409), "application/json"],
      [
        { code: "AROMA_OPERATION_REF_CONFLICT", status: 409 },
        "application/problem+json",
      ],
    ]) {
      const client = new AromaConvergenceGatewayClient(
        { fetch: async () => json(response, 409, type) },
        options,
      );
      await assert.rejects(
        invoke(client, method, body),
        expectError("InvalidResponse"),
      );
    }
  }
});

void test("mutation echoes are bound to dispatched values, not a caller-modified request object", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    const mutable = { ...body, sourceGrindKeyHash: grind };
    const client = new AromaConvergenceGatewayClient(
      {
        fetch: async () => {
          mutable.operationRef = "op_01ARZ3NDEKTSV4RRFFQ69G5FAA";
          mutable.sourceGrindKeyHash = "b".repeat(64);
          return json({ ...ack, sourceGrindKeyHash: grind });
        },
      },
      options,
    );
    assert.deepEqual(await invoke(client, method, mutable), {
      ...ack,
      sourceGrindKeyHash: grind,
    });
  }
});

void test("mutation deadline covers a stalled body and late transport responses are discarded", async () => {
  for (const [method, body] of [
    ["setQuantity", setBody],
    ["remove", removeBody],
  ]) {
    let canceled = false,
      calls = 0;
    const client = new AromaConvergenceGatewayClient(
      {
        fetch: async () => {
          calls++;
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
      { ...options, deadlineMs: 20 },
    );
    await assert.rejects(
      invoke(client, method, body),
      expectError("TransportUnavailable"),
    );
    assert.equal(calls, 1);
    assert.equal(canceled, true);
    let resolve,
      lateCanceled = false;
    const late = new AromaConvergenceGatewayClient(
      {
        fetch: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      { ...options, deadlineMs: 20 },
    );
    await assert.rejects(
      invoke(late, method, body),
      expectError("TransportUnavailable"),
    );
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            lateCanceled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await new Promise((done) => setImmediate(done));
    assert.equal(lateCanceled, true);
  }
});

void test("Catalog proof uses the existing bounded read-only route with exact identities and no delegation", async () => {
  const productRef = "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    variantRef = "var_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const proof = {
    productRef,
    variantRef,
    offerRef,
    snapshotRevision: "1",
    mappingRevision: "1",
    supplierUnitMinor: "1",
    currency: "RUB",
    unit: "piece",
    availability: "Available",
    displayName: "Fixture",
  };
  let calls = 0;
  const client = new AromaConvergenceGatewayClient(
    {
      fetch: async (path, init) => {
        calls++;
        assert.equal(
          path,
          `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
        );
        assert.equal(init.method, "GET");
        assert.equal(init.body, undefined);
        assert.equal(init.headers["x-service-delegation"], undefined);
        return json(proof);
      },
    },
    options,
  );
  assert.deepEqual(
    await client.catalogInput(productRef, variantRef, context()),
    proof,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    client.catalogInput("prd_invalid", variantRef, context()),
    expectError("InvalidRequest"),
  );
  assert.equal(calls, 1);
  for (const body of [
    { ...proof, productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAA" },
    { ...proof, variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAA" },
    { ...proof, extra: true },
  ]) {
    let badCalls = 0;
    const bad = new AromaConvergenceGatewayClient(
      {
        fetch: async (path, init) => {
          badCalls++;
          assert.equal(
            path,
            `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
          );
          assert.equal(init.method, "GET");
          assert.equal(init.body, undefined);
          return json(body);
        },
      },
      options,
    );
    await assert.rejects(
      bad.catalogInput(productRef, variantRef, context()),
      expectError("InvalidResponse"),
    );
    assert.equal(badCalls, 1);
  }

  const proofJson = JSON.stringify(proof);
  const maxGetResponseBytes = 64 * 1024;
  const oversizedProof = `${proofJson}${" ".repeat(
    maxGetResponseBytes - Buffer.byteLength(proofJson, "utf8") + 1,
  )}`;
  assert.equal(
    Buffer.byteLength(oversizedProof, "utf8"),
    maxGetResponseBytes + 1,
  );
  let oversizedCalls = 0;
  const oversizedClient = new AromaConvergenceGatewayClient(
    {
      fetch: async (path, init) => {
        oversizedCalls++;
        assert.equal(
          path,
          `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
        );
        assert.equal(init.method, "GET");
        assert.equal(init.body, undefined);
        return new Response(oversizedProof, {
          headers: { "content-type": "application/json" },
        });
      },
    },
    options,
  );
  await assert.rejects(
    oversizedClient.catalogInput(productRef, variantRef, context()),
    expectError("InvalidResponse"),
  );
  assert.equal(oversizedCalls, 1);

  let stalledCalls = 0,
    stalledBodyCanceled = false;
  const stalledClient = new AromaConvergenceGatewayClient(
    {
      fetch: async (path, init) => {
        stalledCalls++;
        assert.equal(
          path,
          `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`,
        );
        assert.equal(init.method, "GET");
        assert.equal(init.body, undefined);
        return new Response(
          new ReadableStream({
            cancel() {
              stalledBodyCanceled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
    options,
  );
  const startedAt = Date.now();
  let guardTimer;
  try {
    await Promise.race([
      assert.rejects(
        stalledClient.catalogInput(productRef, variantRef, context()),
        expectError("TransportUnavailable"),
      ),
      new Promise((_, reject) => {
        guardTimer = setTimeout(
          () => reject(new Error("Catalog proof GET exceeded its test guard")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(guardTimer);
  }
  assert.ok(Date.now() - startedAt < 5_000);
  assert.equal(stalledCalls, 1);
  assert.equal(stalledBodyCanceled, true);
});
