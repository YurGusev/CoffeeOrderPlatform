import assert from "node:assert/strict";
import {once} from "node:events";
import {createServer} from "node:http";
import test from "node:test";
import {TastyHttpClient} from "../../apps/tasty-gateway/dist/infrastructure/provider/http-client.js";
import {TastyProviderSession, TastySessionError} from "../../apps/tasty-gateway/dist/infrastructure/provider/session.js";

void test("session использует bounded HTTP transport и fail-closed policy", {timeout: 10000}, async (t) => {
  const credentials = {login: "fixture-user", password: "fixture-password-secret", device: {device_name: "test", device_os: "test", device_browser: "test", device_timezone: "UTC"}};
  const signal = () => new AbortController().signal;
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return {promise, resolve}; };
  const requests = [];
  const allRequests = [];
  let mode = "success";
  let loginCount = 0;
  let heldRead;
  let readStarted = deferred();
  const server = createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => {
      const body = Buffer.concat(parts).toString();
      requests.push({path: request.url, method: request.method, authorization: request.headers.authorization, body});
      allRequests.push({path: request.url, method: request.method});
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/auth/login") {
        loginCount++;
        if (mode === "login-403") { response.writeHead(403); response.end('{"secret":"fixture-password-secret"}'); return; }
        if (mode === "bad-json") { response.end('{"secret":"fixture-password-secret"'); return; }
        if (mode === "bad-ttl") { response.end('{"data":{"access_token":"fixture-token-secret","token_type":"Bearer","expires_in":0}}'); return; }
        if (mode === "bad-shape") { response.end('{"data":{"access_token":"fixture-token-secret","token_type":"Basic","expires_in":2}}'); return; }
        response.end(JSON.stringify({data: {access_token: `fixture-token-${loginCount}`, token_type: mode === "uppercase" ? "Bearer" : "bearer", expires_in: 2, profile: {private: "fixture-profile-secret"}}}));
        return;
      }
      if (mode === "unauthorized") { response.writeHead(401); response.end('{"secret":"fixture-token-secret"}'); return; }
      if (mode === "stale" && request.url === "/api/v1/catalog/cart" && request.headers.authorization === "Bearer fixture-token-1") {
        heldRead = response;
        readStarted.resolve();
        return;
      }
      response.end('{"ok":true}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const nativeFetch = globalThis.fetch;
  const port = server.address().port;
  globalThis.fetch = (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.tastycoffee.ru");
    return nativeFetch(`http://127.0.0.1:${port}${target.pathname}${target.search}`, init);
  };
  let clock = 0;
  Object.defineProperty(performance, "now", {configurable: true, value: () => clock});
  const client = () => new TastyHttpClient({timeoutMs: 10000, maxResponseBytes: 4096});
  const reset = () => { requests.length = 0; loginCount = 0; mode = "success"; clock = 0; heldRead = undefined; readStarted = deferred(); };
  const rejects = (action, code) => assert.rejects(action, (error) => {
    assert.ok(error instanceof TastySessionError);
    assert.equal(error.code, code);
    const exposed = Object.getOwnPropertyNames(error).map((key) => String(error[key])).join(" ");
    assert.doesNotMatch(exposed, /fixture-password-secret|fixture-token|fixture-profile-secret/);
    assert.equal("cause" in error, false);
    return true;
  });
  try {
    await t.test("валидный login, reuse, локальный TTL и ранняя проверка входа", async () => {
      reset();
      const session = new TastyProviderSession(client(), async (s) => { assert.ok(s instanceof AbortSignal); return credentials; });
      await rejects(() => session.read("other", signal()), "TASTY_SESSION_INVALID_INPUT");
      await rejects(() => session.read("cart", {}), "TASTY_SESSION_INVALID_INPUT");
      assert.equal(requests.length, 0);
      assert.equal(await session.read("cart", signal()), '{"ok":true}');
      assert.equal(await session.read("catalog", signal()), '{"ok":true}');
      assert.equal(loginCount, 1);
      assert.deepEqual(JSON.parse(requests[0].body), credentials);
      assert.equal(requests[0].authorization, undefined);
      assert.equal(requests[1].authorization, "Bearer fixture-token-1");
      assert.equal(requests[2].authorization, "Bearer fixture-token-1");
      clock = 2001;
      await session.read("cart", signal());
      assert.equal(loginCount, 2);
      assert.equal(requests.at(-1).authorization, "Bearer fixture-token-2");
    });

    await t.test("локальный пример с Bearer в ответе также принят", async () => {
      reset(); mode = "uppercase";
      const session = new TastyProviderSession(client(), async () => credentials);
      assert.equal(await session.read("cart", signal()), '{"ok":true}');
      assert.equal(requests[1].authorization, "Bearer fixture-token-1");
      assert.equal(loginCount, 1);
    });

    await t.test("один login: отмена одного waiter не отменяет другого", async () => {
      reset();
      const gate = deferred();
      const entered = deferred();
      let loads = 0;
      let loaderSignal;
      const session = new TastyProviderSession(client(), async (s) => { loads++; loaderSignal = s; entered.resolve(); await gate.promise; return credentials; });
      const cancelled = new AbortController();
      const first = session.read("cart", cancelled.signal);
      const firstRejected = rejects(() => first, "TASTY_SESSION_CANCELLED");
      const second = session.read("catalog", signal());
      await entered.promise;
      cancelled.abort();
      await firstRejected;
      assert.equal(loaderSignal.aborted, false);
      gate.resolve();
      assert.equal(await second, '{"ok":true}');
      assert.equal(loads, 1);
      assert.equal(loginCount, 1);
      assert.equal(requests.filter((r) => r.method === "GET").length, 1);
    });

    await t.test("401 блокирует текущую identity без повторной отправки", async () => {
      reset(); mode = "unauthorized";
      const session = new TastyProviderSession(client(), async () => credentials);
      await rejects(() => session.read("cart", signal()), "TASTY_SESSION_UNAUTHORIZED");
      await rejects(() => session.read("cart", signal()), "TASTY_SESSION_BLOCKED");
      assert.equal(loginCount, 1);
      assert.equal(requests.filter((r) => r.method === "GET").length, 1);
    });

    await t.test("поздний 401 старой identity не блокирует новую", async () => {
      reset(); mode = "stale";
      const session = new TastyProviderSession(client(), async () => credentials);
      const old = session.read("cart", signal());
      const oldRejected = rejects(() => old, "TASTY_SESSION_UNAUTHORIZED");
      await readStarted.promise;
      clock = 2001;
      assert.equal(await session.read("catalog", signal()), '{"ok":true}');
      assert.equal(loginCount, 2);
      heldRead.writeHead(401); heldRead.end('{"secret":"fixture-token-secret"}');
      await oldRejected;
      assert.equal(await session.read("catalog", signal()), '{"ok":true}');
      assert.equal(loginCount, 2);
      assert.equal(requests.at(-1).authorization, "Bearer fixture-token-2");
    });

    await t.test("ошибки login блокируют повтор и не раскрывают секреты", async () => {
      for (const [name, code] of [["login-403", "TASTY_SESSION_FAILED"], ["bad-json", "TASTY_SESSION_FAILED"], ["bad-ttl", "TASTY_SESSION_LOGIN_INVALID"], ["bad-shape", "TASTY_SESSION_LOGIN_INVALID"]]) {
        reset(); mode = name;
        const session = new TastyProviderSession(client(), async () => credentials);
        await rejects(() => session.read("cart", signal()), code);
        await rejects(() => session.read("cart", signal()), "TASTY_SESSION_BLOCKED");
        assert.equal(loginCount, 1);
        assert.equal(requests.filter((r) => r.method === "GET").length, 0);
      }
    });

    await t.test("синхронный переход за deadline не запускает login", async () => {
      reset();
      const session = new TastyProviderSession(client(), async () => { clock = 10001; return credentials; });
      await rejects(() => session.read("cart", signal()), "TASTY_SESSION_TIMEOUT");
      await rejects(() => session.read("cart", signal()), "TASTY_SESSION_BLOCKED");
      assert.equal(requests.length, 0);
    });

    await t.test("instances изолированы; timeout loader не отправляет поздний login", async () => {
      reset();
      const first = new TastyProviderSession(client(), async () => credentials);
      const second = new TastyProviderSession(client(), async () => credentials);
      await first.read("cart", signal());
      await second.read("cart", signal());
      assert.equal(loginCount, 2);
      const late = deferred();
      let loaderSignal;
      const timed = new TastyProviderSession(new TastyHttpClient({timeoutMs: 50, maxResponseBytes: 4096}), async (s) => { loaderSignal = s; return late.promise; });
      await rejects(() => timed.read("cart", signal()), "TASTY_SESSION_TIMEOUT");
      assert.ok(loaderSignal instanceof AbortSignal);
      assert.equal(loaderSignal.aborted, true);
      late.resolve(credentials);
      await new Promise((resolve) => setImmediate(resolve));
      await rejects(() => timed.read("cart", signal()), "TASTY_SESSION_BLOCKED");
      assert.equal(loginCount, 2);
    });
    assert.equal(allRequests.some((r) => /\/(refresh|logout)$/.test(r.path)), false);
  } finally {
    delete performance.now;
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
