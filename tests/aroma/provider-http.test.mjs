import assert from "node:assert/strict";
import test from "node:test";
import { ProviderHttpClient } from "../../apps/aroma-gateway/dist/infrastructure/provider/http-client.js";
import {
  cookieHeader,
  deserializeCookieMaterial,
} from "../../apps/aroma-gateway/dist/infrastructure/provider/cookie-jar.js";

const options = {
  origin: "https://provider.test",
  timeoutMs: 1_000,
  maxResponseBytes: 16,
  connections: 1,
};
const signal = () => new AbortController().signal;
const collect = async (source) => {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};

void test("Provider policy фиксирует GET path/headers и не следует redirects", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response(null, {
      status: 302,
      headers: { location: "https://forbidden.test/secret" },
    });
  });
  await assert.rejects(
    collect(
      client.read({ kind: "catalog-page", page: 2, pageSize: 1 }, signal()),
    ),
    { code: "ProviderProtocolViolation" },
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://provider.test/api/v1/catalog/wholesale/products?page=2&per_page=1",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(calls[0].init.headers, { accept: "application/json" });
  await assert.rejects(
    collect(
      client.read(
        { kind: "catalog-page", page: "//forbidden.test", pageSize: 1 },
        signal(),
      ),
    ),
    { code: "ProviderProtocolViolation" },
  );
  await assert.rejects(
    collect(
      client.read({ kind: "proxy", url: "https://forbidden.test" }, signal()),
    ),
    { code: "ProviderProtocolViolation" },
  );
  assert.equal(calls.length, 1);
  for (const origin of [
    "http://provider.test",
    "https://provider.test:444",
    "https://user:secret@provider.test",
    "https://provider.test/path",
    "https://provider.test?secret=canary",
  ]) {
    assert.throws(() => new ProviderHttpClient({ ...options, origin }), {
      code: "ProviderProtocolViolation",
    });
  }
});

void test("Provider policy проверяет объявленный и фактический размер до полной сборки", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let cancelled = 0;
  let reads = 0;
  let declared = true;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new Uint8Array(17));
            },
            cancel() {
              cancelled++;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            "content-type": "application/json",
            ...(declared ? { "content-length": "17" } : {}),
          },
        },
      ),
  );
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderResponseTooLarge",
  });
  assert.equal(reads, 0);
  assert.equal(cancelled, 1);
  declared = false;
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderResponseTooLarge",
    responseBytesReceived: true,
  });
  assert.equal(reads, 1);
  assert.equal(cancelled, 2);
});

void test("Provider read сохраняет backpressure и закрывает body при остановке consumer", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let reads = 0;
  let cancelled = false;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream(
          {
            pull(controller) {
              reads++;
              controller.enqueue(Buffer.from("{}"));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  const source = client.read({ kind: "cart" }, signal());
  assert.equal(reads, 0);
  await source.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  await source.return();
  assert.equal(cancelled, true);
});

void test("Provider read returns validated cookie rotation only after the complete body", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "october_session=rotated-secret; Domain=provider.test; Path=/; HttpOnly",
        },
      }),
  );
  const source = client.read({ kind: "cart" }, signal());
  const body = await source.next();
  assert.equal(Buffer.from(body.value).toString(), "{}");
  const completed = await source.next();
  assert.equal(completed.done, true);
  assert.equal(completed.value[0].name, "october_session");
  assert.equal(completed.value[0].value, "rotated-secret");
});

void test("Provider read accepts the observed hyphenated cookie Expires without weakening domain checks", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "october_session=rotated-secret; Domain=provider.test; Path=/; Expires=Tue, 14-Sep-2027 10:11:12 GMT; Secure; HttpOnly",
        },
      }),
  );
  const source = client.read({ kind: "cart" }, signal());
  await source.next();
  const completed = await source.next();
  assert.equal(completed.done, true);
  assert.equal(completed.value[0].expiresAt, "2027-09-14T10:11:12Z");
  assert.equal(completed.value[0].domain, "provider.test");
  assert.equal(completed.value[0].secure, true);
});

void test("persisted cookie material cannot inject request headers", () => {
  const material = JSON.stringify([
    {
      name: "october_session",
      value: "ok\r\nX-Injected: yes",
      domain: "provider.test",
      path: "/",
      expiresAt: null,
      secure: true,
      httpOnly: true,
      sameSite: null,
    },
  ]);
  assert.throws(() => deserializeCookieMaterial(material), {
    code: "ProviderProtocolViolation",
  });
  assert.equal(
    cookieHeader(
      [
        {
          name: "october_session",
          value: "ok\r\nX-Injected: yes",
          domain: "provider.test",
          path: "/",
          expiresAt: null,
          secure: true,
          httpOnly: true,
          sameSite: null,
        },
      ],
      "provider.test",
    ),
    "",
  );
});

void test("Provider cart safe GET waits at least 250 ms after releasing the failed body", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let calls = 0;
  let cancelledAt;
  const callTimes = [];
  t.mock.method(globalThis, "fetch", async () => {
    callTimes.push(performance.now());
    calls++;
    if (calls === 1)
      return new Response(
        new ReadableStream({
          cancel() {
            cancelledAt = performance.now();
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    return new Response("{}", {
      headers: { "content-type": "application/json" },
    });
  });
  assert.equal(await collect(client.read({ kind: "cart" }, signal())), "{}");
  assert.equal(calls, 2);
  assert.equal(typeof cancelledAt, "number");
  assert.ok(
    callTimes[1] - cancelledAt >= 250,
    `retry delay was ${callTimes[1] - cancelledAt} ms`,
  );
});

void test("Provider safe GET retry принадлежит только cart и не распространяется на catalog/user/mutations", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("provider unavailable");
  });
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderUnavailable",
  });
  assert.equal(calls, 2);
  await assert.rejects(
    collect(
      client.read({ kind: "catalog-page", page: 1, pageSize: 1 }, signal()),
    ),
    { code: "ProviderUnavailable" },
  );
  await assert.rejects(collect(client.read({ kind: "user" }, signal())), {
    code: "ProviderUnavailable",
  });
  await assert.rejects(
    client.mutate(
      { kind: "add-cart-line", offerId: "1", quantity: 1 },
      signal(),
    ),
    { code: "ProviderUnavailable" },
  );
  assert.equal(calls, 5);
});

void test("Provider cart retry abort during delay запрещает второй dispatch", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  const controller = new AbortController();
  let calls = 0;
  let delayStarted;
  const delayStartedPromise = new Promise((resolve) => {
    delayStarted = resolve;
  });
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 250) delayStarted();
    return originalSetTimeout(callback, delay, ...args);
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("provider unavailable");
  });
  const pending = collect(client.read({ kind: "cart" }, controller.signal));
  await delayStartedPromise;
  controller.abort();
  await assert.rejects(pending, { code: "ProviderUnavailable" });
  assert.equal(calls, 1);
});

void test("provider login, mutation, and read failures record latency and error spans", async (t) => {
  const spans = [];
  const latencies = [];
  const telemetry = {
    metrics: { increment() {}, result() {} },
    observeProviderLatency(value) {
      latencies.push(value);
    },
    startSpan(name) {
      const observed = { name, statuses: 0, exceptions: 0, ends: 0 };
      spans.push(observed);
      return {
        setAttribute() {},
        setStatus() {
          observed.statuses++;
        },
        recordException() {
          observed.exceptions++;
        },
        end() {
          observed.ends++;
        },
      };
    },
  };
  const client = new ProviderHttpClient({ ...options, telemetry });
  t.after(() => client.close());
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("provider unavailable");
  });

  await assert.rejects(
    client.login(
      { email: "operator@example.test", password: "not-emitted" },
      signal(),
    ),
    { code: "ProviderUnavailable" },
  );
  await assert.rejects(
    client.mutate(
      { kind: "add-cart-line", offerId: "1", quantity: 1 },
      signal(),
    ),
    { code: "ProviderUnavailable" },
  );
  await assert.rejects(
    collect(
      client.read({ kind: "catalog-page", page: 1, pageSize: 1 }, signal()),
    ),
    { code: "ProviderUnavailable" },
  );

  assert.equal(latencies.length, 3);
  assert.deepEqual(
    spans.map(({ name, statuses, exceptions, ends }) => ({
      name,
      statuses,
      exceptions,
      ends,
    })),
    [
      {
        name: "aroma.gateway.provider.login",
        statuses: 1,
        exceptions: 1,
        ends: 1,
      },
      {
        name: "aroma.gateway.provider.mutation",
        statuses: 1,
        exceptions: 1,
        ends: 1,
      },
      {
        name: "aroma.gateway.provider.read",
        statuses: 1,
        exceptions: 1,
        ends: 1,
      },
    ],
  );
});

void test("Provider cart retry shutdown during delay запрещает второй dispatch", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let calls = 0;
  let delayStarted;
  const delayStartedPromise = new Promise((resolve) => {
    delayStarted = resolve;
  });
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    if (delay === 250) delayStarted();
    return originalSetTimeout(callback, delay, ...args);
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("provider unavailable");
  });
  const pending = collect(client.read({ kind: "cart" }, signal()));
  await delayStartedPromise;
  await client.close();
  await assert.rejects(pending, { code: "ProviderUnavailable" });
  assert.equal(calls, 1);
});

void test("Provider failures нормализованы, partial не становится empty, safe GET retry limited to two pre-body attempts", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  let calls = 0;
  let response;
  const mocked = t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return response();
  });
  response = () => {
    throw new Error("cookie=secret-provider-canary");
  };
  await assert.rejects(
    collect(client.read({ kind: "cart" }, signal())),
    (error) => {
      assert.equal(error.code, "ProviderUnavailable");
      assert.equal(error.responseBytesReceived, false);
      assert.doesNotMatch(
        String(error.stack) + JSON.stringify(error),
        /secret-provider-canary/,
      );
      return true;
    },
  );
  assert.equal(calls, 2);
  for (const [status, code] of [
    [401, "ProviderAuthenticationFailed"],
    [403, "ProviderAuthorizationFailed"],
    [503, "ProviderUnavailable"],
  ]) {
    response = () => new Response("secret-provider-canary", { status });
    await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
      code,
    });
  }
  response = () =>
    new Response("", { headers: { "content-type": "application/json" } });
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderReadIncomplete",
  });
  response = () =>
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (this.sent)
              controller.error(new Error("secret-provider-canary"));
            else {
              this.sent = true;
              controller.enqueue(Buffer.from("{"));
            }
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-type": "application/json" } },
    );
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderReadIncomplete",
    responseBytesReceived: true,
  });
  assert.equal(mocked.mock.callCount(), 9);
});

void test("Provider cancellation и shutdown запрещают dispatch и прерывают pending fetch", async (t) => {
  const client = new ProviderHttpClient(options);
  t.after(() => client.close());
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("secret-provider-canary")),
          { once: true },
        );
      }),
  );
  await assert.rejects(
    collect(client.read({ kind: "cart" }, AbortSignal.abort())),
    { code: "ProviderUnavailable" },
  );
  assert.equal(mocked.mock.callCount(), 0);
  const pending = assert.rejects(
    collect(client.read({ kind: "cart" }, signal())),
    { code: "ProviderUnavailable" },
  );
  await client.close();
  await pending;
  await assert.rejects(collect(client.read({ kind: "cart" }, signal())), {
    code: "ProviderUnavailable",
  });
  assert.equal(mocked.mock.callCount(), 1);
});

void test("Provider login использует только observed JSON contract, принимает cookie в Gateway и не retry-ит 422", async (t) => {
  const client = new ProviderHttpClient({
    ...options,
    maxResponseBytes: 2_048,
  });
  t.after(() => client.close());
  const calls = [];
  let response = () =>
    new Response(
      JSON.stringify({
        error: "validation failed",
        errors: { email: ["invalid"] },
      }),
      {
        status: 422,
        headers: { "content-type": "application/json" },
      },
    );
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return response();
  });
  await assert.rejects(
    client.login(
      { email: "canonical@example.test", password: "caller-secret" },
      signal(),
    ),
    { code: "ProviderAuthenticationFailed" },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://provider.test/api/v1/auth/login");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.deepEqual(calls[0].init.headers, {
    accept: "application/json",
    "content-type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    email: "canonical@example.test",
    password: "caller-secret",
  });
  response = () =>
    new Response(
      JSON.stringify({
        data: {
          email: "canonical@example.test",
          wholesale: true,
          retail: false,
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "aroma_auth=secret-cookie; Path=/; HttpOnly; Secure",
        },
      },
    );
  const result = await client.login(
    { email: "canonical@example.test", password: "caller-secret" },
    signal(),
  );
  assert.equal(result.profile.email, "canonical@example.test");
  assert.equal(result.cookies[0].name, "aroma_auth");
  assert.equal(result.cookies[0].value, "secret-cookie");
  assert.equal(calls.length, 2);
});

void test("Provider mutation transport uses the exact observed cart URLs and typed payloads", async (t) => {
  const client = new ProviderHttpClient({
    ...options,
    maxResponseBytes: 1_024,
  });
  t.after(() => client.close());
  const calls = [];
  const cookie = {
    name: "october_session",
    value: "secret",
    domain: "provider.test",
    path: "/",
    expiresAt: null,
    secure: true,
    httpOnly: true,
    sameSite: "lax",
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await client.mutate(
    { kind: "add-cart-line", offerId: "300000", quantity: 1, packing: "Aroma" },
    signal(),
    [cookie],
  );
  await client.mutate(
    {
      kind: "set-cart-line-quantity",
      cartLineId: "300001",
      quantity: 2,
      packing: "Aroma",
    },
    signal(),
    [cookie],
  );
  await client.mutate(
    { kind: "remove-cart-line", cartLineId: "300001" },
    signal(),
    [cookie],
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://provider.test/api/v1/cart/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(
    calls[0].init.headers["content-type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(calls[0].init.headers.cookie, "october_session=secret");
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(calls[0].init.body)),
    { offer_id: "300000", quantity: "1", packing: "Aroma" },
  );

  assert.equal(calls[1].url, "https://provider.test/api/v1/cart/300001");
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    quantity: 2,
    packing: "Aroma",
  });

  assert.equal(calls[2].url, "https://provider.test/api/v1/cart/300001");
  assert.equal(calls[2].init.method, "DELETE");
  assert.equal("body" in calls[2].init, false);
});

void test("Provider mutation transport decodes a typed provider rejection without retry", async (t) => {
  const client = new ProviderHttpClient({
    ...options,
    maxResponseBytes: 2_048,
  });
  t.after(() => client.close());
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: "duplicate",
        errors: { offer_id: ["already in cart"] },
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    );
  });
  const result = await client.mutate(
    { kind: "add-cart-line", offerId: "300000", quantity: 1 },
    signal(),
  );
  assert.equal(result.statusCode, 422);
  assert.deepEqual(result.rejection, {
    statusCode: 422,
    effect: "unknown",
    errorFieldNames: ["offer_id"],
  });
  assert.equal(calls, 1);
});

void test("provider client readiness is local and closes without a provider call", async () => {
  const client = new ProviderHttpClient(options);
  assert.equal(client.isReady(), true);
  await client.close();
  assert.equal(client.isReady(), false);
});
