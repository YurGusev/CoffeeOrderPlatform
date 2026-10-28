import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import test from "node:test";
import {TastyHttpClient, TastyHttpError} from "../../apps/tasty-gateway/dist/infrastructure/provider/http-client.js";

void test("ограниченный transport работает только с разрешёнными путями и не раскрывает секреты", async (t) => {
  let scenario = "success";
  let bodyReady;
  const requests = [];
  const token = "fixture-token-secret";
  const password = "fixture-password-secret";
  const credentials = {login: "fixture-user", password, device: {device_name: "test", device_os: "test", device_browser: "test", device_timezone: "UTC"}};
  const server = createServer((request, response) => {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => {
      requests.push({path: request.url, method: request.method, headers: request.headers, body: Buffer.concat(parts).toString()});
      if (scenario === "stall-headers") return;
      if (scenario === "redirect") { response.writeHead(302, {location: "/forbidden-target"}); response.end(); return; }
      if (scenario === "401") { response.writeHead(401, {"content-type": "application/json"}); response.end(`{"secret":"${token}"}`); return; }
      if (scenario === "html") { response.writeHead(200, {"content-type": "text/html"}); response.end("<html>secret</html>"); return; }
      if (scenario === "declared") { response.writeHead(200, {"content-type": "application/json", "content-length": "10000"}); response.end("{}"); return; }
      response.writeHead(200, {"content-type": "application/json"});
      if (scenario === "stall-body") { response.flushHeaders(); response.write('{"x":'); bodyReady?.(); return; }
      if (scenario === "streamed") { response.write('"'); response.end("x".repeat(100)); return; }
      if (scenario === "utf8") { response.end(Buffer.from([0xff])); return; }
      if (scenario === "invalid") { response.end(`{"secret":"${password}`); return; }
      response.end('{"price":490.800}');
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const nativeFetch = globalThis.fetch;
  const port = server.address().port;
  globalThis.fetch = (url, init) => {
    assert.equal(new URL(url).origin, "https://api.tastycoffee.ru");
    if (scenario === "transport") return Promise.reject(new Error(`${token} ${password}`));
    return nativeFetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, init);
  };
  const client = new TastyHttpClient({timeoutMs: 150, maxResponseBytes: 64});
  assert.equal(client.timeoutMs, 150);
  assert.throws(() => { client.timeoutMs = 1; }, TypeError);
  const signal = () => new AbortController().signal;
  const rejects = async (action, code, status) => {
    await assert.rejects(action, (error) => {
      assert.ok(error instanceof TastyHttpError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      const values = Object.getOwnPropertyNames(error).map((key) => String(error[key])).join(" ");
      assert.equal(values.includes(token), false);
      assert.equal(values.includes(password), false);
      assert.equal("cause" in error, false);
      return true;
    });
  };
  try {
    await t.test("успешные catalog/cart/login сохраняют текст и передают только нужные headers", async () => {
      for (const op of ["catalog", "cart"]) assert.equal(await client.read(op, token, signal()), '{"price":490.800}');
      assert.equal(await client.login(credentials, signal()), '{"price":490.800}');
      assert.deepEqual(requests.map((x) => [x.method, x.path]), [["GET", "/api/v1/catalog/products"], ["GET", "/api/v1/catalog/cart"], ["POST", "/api/v1/auth/login"]]);
      assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
      assert.equal(requests[1].headers.authorization, `Bearer ${token}`);
      assert.equal(requests[2].headers.authorization, undefined);
      assert.deepEqual(JSON.parse(requests[2].body), credentials);
    });
    await t.test("неверные операции, секреты и лимиты отклоняются до fetch", async () => {
      const before = requests.length;
      for (const op of ["unknown", "/api/v1/auth/logout"]) await rejects(() => client.read(op, token, signal()), "TASTY_HTTP_INVALID_INPUT");
      for (const bad of ["", "token\r\nX: bad", "has space"]) await rejects(() => client.read("cart", bad, signal()), "TASTY_HTTP_INVALID_INPUT");
      await rejects(() => client.login({...credentials, device: {...credentials.device, device_name: ""}}, signal()), "TASTY_HTTP_INVALID_INPUT");
      for (const options of [{timeoutMs: 0, maxResponseBytes: 1}, {timeoutMs: 2147483648, maxResponseBytes: 1}, {timeoutMs: 1, maxResponseBytes: 0}, {timeoutMs: 1, maxResponseBytes: Infinity}]) assert.throws(() => new TastyHttpClient(options), {code: "TASTY_HTTP_INVALID_INPUT"});
      assert.equal(requests.length, before);
    });
    await t.test("HTTP и некорректные ответы классифицируются безопасно", async () => {
      for (const [name, code, status] of [["401", "TASTY_HTTP_REJECTED", 401], ["html", "TASTY_HTTP_INVALID_JSON"], ["invalid", "TASTY_HTTP_INVALID_JSON"], ["utf8", "TASTY_HTTP_INVALID_JSON"], ["declared", "TASTY_HTTP_TOO_LARGE"], ["streamed", "TASTY_HTTP_TOO_LARGE"], ["transport", "TASTY_HTTP_TRANSPORT"]]) {
        scenario = name;
        const before = requests.length;
        await rejects(() => client.read("catalog", token, signal()), code, status);
        assert.equal(requests.length, before + (name === "transport" ? 0 : 1));
      }
      scenario = "redirect";
      const before = requests.length;
      await rejects(() => client.read("catalog", token, signal()), "TASTY_HTTP_REDIRECT");
      assert.equal(requests.length, before + 1);
      assert.equal(requests.some((x) => x.path === "/forbidden-target"), false);
    });
    await t.test("буферизованный ответ не обходит абсолютный deadline", async () => {
      const savedFetch = globalThis.fetch;
      const savedParse = JSON.parse;
      const savedClock = Object.getOwnPropertyDescriptor(performance, "now");
      let now = 0;
      let calls = 0;
      Object.defineProperty(performance, "now", {configurable: true, value: () => now});
      try {
        globalThis.fetch = async () => { calls++; now = 200; return new Response("{}", {headers: {"content-type": "application/json"}}); };
        await rejects(() => client.read("catalog", token, signal()), "TASTY_HTTP_TIMEOUT");
        assert.equal(calls, 1);
        now = 0; calls = 0;
        globalThis.fetch = async () => { calls++; return new Response("{}", {headers: {"content-type": "application/json"}}); };
        JSON.parse = (...args) => { const result = savedParse(...args); now = 200; return result; };
        await rejects(() => client.read("catalog", token, signal()), "TASTY_HTTP_TIMEOUT");
        assert.equal(calls, 1);
        now = 0; calls = 0;
        const controller = new AbortController();
        JSON.parse = (...args) => { const result = savedParse(...args); controller.abort(); now = 200; return result; };
        await rejects(() => client.read("catalog", token, controller.signal), "TASTY_HTTP_CANCELLED");
        assert.equal(calls, 1);
      } finally {
        globalThis.fetch = savedFetch;
        JSON.parse = savedParse;
        if (savedClock === undefined) delete performance.now;
        else Object.defineProperty(performance, "now", savedClock);
      }
    });
    await t.test("deadline и caller cancellation действуют до и после headers", async () => {
      for (const name of ["stall-headers", "stall-body"]) {
        scenario = name;
        await rejects(() => client.read("cart", token, signal()), "TASTY_HTTP_TIMEOUT");
        const controller = new AbortController();
        const ready = new Promise((resolve) => { bodyReady = resolve; });
        const pending = client.read("cart", token, controller.signal);
        if (name === "stall-body") await ready;
        setTimeout(() => controller.abort(), 30);
        await rejects(() => pending, "TASTY_HTTP_CANCELLED");
      }
      const controller = new AbortController(); controller.abort();
      await rejects(() => client.read("cart", token, controller.signal), "TASTY_HTTP_CANCELLED");
    });
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
