import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogActivationBindingClient,
  CatalogBindingClientError,
} from "../../apps/catalog-activation-worker/src/gateway-binding-client.ts";

const request = {
  offerRef: "off_00000000000000000000000001",
  supplierRef: "sup_00000000000000000000000001",
  snapshotRef: "snp_00000000000000000000000001",
  sourceIdentityScheme: "hmac-sha256-v1",
  sourceOfferKeyHash: "a".repeat(64),
};
const responseBody = {
  offerRef: request.offerRef,
  supplierRef: request.supplierRef,
  sourceIdentityScheme: request.sourceIdentityScheme,
  sourceOfferKeyHash: request.sourceOfferKeyHash,
  firstSnapshotRef: request.snapshotRef,
  state: "Bound",
};

function clientWith(fetch) {
  return new CatalogActivationBindingClient({ fetch });
}

void test("posts typed binding request to fixed internal route and parses actual JSON response", async () => {
  let captured;
  const client = clientWith(async (path, options) => {
    captured = { path, options };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const actual = await client.register(request, {
    correlationId: "3f32ba17-5217-4a7d-83d4-f4c92fc73b20",
  });

  assert.deepEqual(actual, responseBody);
  assert.equal(captured.path, "/api/internal-v1/aroma/offer-bindings");
  assert.equal(captured.options.method, "POST");
  assert.equal(
    captured.options.headers["x-correlation-id"],
    "3f32ba17-5217-4a7d-83d4-f4c92fc73b20",
  );
  assert.deepEqual(JSON.parse(captured.options.body), request);
  assert.equal(captured.options.deadlineMs, 5_000);
  assert.equal("authorization" in captured.options.headers, false);
});

void test("rejects an unknown response shape without exposing response data", async () => {
  const client = clientWith(
    async () =>
      new Response(
        JSON.stringify({ ...responseBody, providerCredential: "secret" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  await assert.rejects(client.register(request), (error) => {
    assert.ok(error instanceof CatalogBindingClientError);
    assert.equal(error.code, "GATEWAY_BINDING_INVALID_RESPONSE");
    assert.equal(error.message, error.code);
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});

void test("fails closed when the configured internal request deadline expires", async () => {
  const client = clientWith(async (_path, options) => {
    assert.equal(options.deadlineMs, 5_000);
    throw new DOMException("aborted", "TimeoutError");
  });

  await assert.rejects(client.register(request), (error) => {
    assert.ok(error instanceof CatalogBindingClientError);
    assert.equal(error.code, "GATEWAY_BINDING_DEADLINE_EXCEEDED");
    assert.equal(error.message, error.code);
    return true;
  });
});

void test("rejects invalid request before any network call", async () => {
  let calls = 0;
  const client = clientWith(async () => {
    calls += 1;
    return new Response(JSON.stringify(responseBody), { status: 200 });
  });

  await assert.rejects(client.register({ ...request, extra: "not allowed" }), {
    code: "GATEWAY_BINDING_INVALID_REQUEST",
  });
  assert.equal(calls, 0);
});
