import assert from "node:assert/strict";
import test from "node:test";
import {ProviderError} from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import {
  decryptCookieMaterial,
  encryptCookieMaterial,
  MemoryProviderSessionStore,
  providerSessionScopeHash,
} from "../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import {ProviderHttpClient} from "../../apps/aroma-gateway/dist/infrastructure/provider/http-client.js";
import {ProviderSessionManager, readProviderSafely} from "../../apps/aroma-gateway/dist/infrastructure/provider/session.js";
import {GatewayMetrics, createGatewayTelemetry, finishGatewaySpan} from "../../apps/aroma-gateway/dist/infrastructure/observability.js";
import {trace} from "@opentelemetry/api";

const scope = {scopeRef: "aroma-development", email: " Canonical@Example.test ", password: "password-from-caller"};
const cookie = Object.freeze({name: "october_session", value: "secret-cookie", domain: "aromateacoffee.ru", path: "/", expiresAt: null, secure: true, httpOnly: true, sameSite: "lax"});
const profile = {email: "canonical@example.test", wholesale: true, retail: false};
const loginResult = () => ({profile, cookies: [cookie]});
const httpOptions = {origin: "https://provider.test", timeoutMs: 1_000, maxResponseBytes: 16 * 1024, connections: 1};

function providerLoginResponse() {
  return new Response(JSON.stringify({data: profile}), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "october_session=secret-cookie; Domain=provider.test; Path=/; HttpOnly; Secure",
    },
  });
}

function pendingFetch(init, entered) {
  entered.resolve();
  return new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(new Error("normalized cancellation"));
      return;
    }
    init.signal.addEventListener("abort", () => reject(new Error("normalized cancellation")), {once: true});
  });
}

async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

function realProviderManager(client) {
  return new ProviderSessionManager({transport: client, store: new MemoryProviderSessionStore(), encryptionKey: Buffer.alloc(32, 31)});
}

function recordingTelemetry() {
  const metrics = new GatewayMetrics();
  const spans = [];
  return {
    metrics,
    spans,
    observeProviderLatency() {},
    startSpan(name, attributes = {}) {
      const span = {
        name,
        attributes: {...attributes},
        endCount: 0,
        setAttribute(key, value) { this.attributes[key] = value; return this; },
        recordException() {},
        setStatus() { return this; },
        end() { this.endCount += 1; },
      };
      spans.push(span);
      return span;
    },
  };
}

void test("session acquisition is concurrent single-flight and DB material is encrypted", async () => {
  const store = new MemoryProviderSessionStore();
  let loginCalls = 0;
  const transport = {login: async () => {loginCalls++; await new Promise(resolve => setTimeout(resolve, 10)); return loginResult();}};
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 7)});
  const [a, b] = await Promise.all([manager.acquire(scope), manager.acquire(scope)]);
  assert.equal(loginCalls, 1);
  assert.equal(store.saveCalls, 1);
  assert.equal(a.scopeHash, b.scopeHash);
  assert.equal(typeof a.read, "function");
  assert.equal("cookieHeader" in a, false);
  assert.ok(store.lastSaved);
  assert.doesNotMatch(Buffer.from(store.lastSaved.encryptedCookieMaterial).toString("utf8"), /secret-cookie/);
  assert.deepEqual(decryptCookieMaterial(store.lastSaved.encryptedCookieMaterial, Buffer.alloc(32, 7)), [cookie]);
  await manager.acquire({...scope, email: "canonical@example.test"});
  assert.equal(loginCalls, 1);
  await manager.close();
});

void test("login failure is typed, redacted, and never saved", async () => {
  const store = new MemoryProviderSessionStore();
  const transport = {login: async () => {throw new ProviderError("ProviderAuthenticationFailed");}};
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 8)});
  await assert.rejects(manager.acquire(scope), error => {
    assert.equal(error.code, "ProviderAuthenticationFailed");
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /password-from-caller|secret-cookie/);
    return true;
  });
  assert.equal(store.saveCalls, 0);
  await manager.close();
});

void test("session rejects a login profile that does not match the configured scoped email", async () => {
  const store = new MemoryProviderSessionStore();
  const transport = {login: async () => ({profile: {...profile, email: "other@example.test"}, cookies: [cookie]})};
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 10)});
  await assert.rejects(manager.acquire(scope), {code: "ProviderProtocolViolation"});
  assert.equal(store.saveCalls, 0);
  await manager.close();
});

void test("successful read persists rotated cookies and reuses them after restart", async () => {
  const store = new MemoryProviderSessionStore();
  const rotated = {...cookie, value: "rotated-secret-cookie"};
  const seen = [];
  const transport = {
    login: async () => loginResult(),
    read: async function* (_operation, _signal, cookies) {
      seen.push(cookies);
      yield Buffer.from("{}");
      return [rotated];
    },
  };
  const key = Buffer.alloc(32, 11);
  const first = new ProviderSessionManager({transport, store, encryptionKey: key});
  const session = await first.acquire(scope);
  for await (const _chunk of session.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  assert.equal(store.saveCalls, 2);
  assert.equal(decryptCookieMaterial(store.lastSaved.encryptedCookieMaterial, key)[0].value, "rotated-secret-cookie");
  await first.close();
  const second = new ProviderSessionManager({transport, store, encryptionKey: key});
  const restored = await second.acquire(scope);
  for await (const _chunk of restored.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  assert.equal(seen[1][0].value, "rotated-secret-cookie");
  await second.close();
});

void test("provider 401 invalidates cache and persisted session before single-flight re-login", async () => {
  const store = new MemoryProviderSessionStore();
  let loginCalls = 0;
  let readCalls = 0;
  const transport = {
    login: async () => { loginCalls++; return loginResult(); },
    read: async function* () {
      readCalls++;
      if (readCalls === 1) throw new ProviderError("ProviderAuthenticationFailed");
      yield Buffer.from("{}");
      return [];
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 12)});
  const stale = await manager.acquire(scope);
  await assert.rejects(async () => {
    for await (const _chunk of stale.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  }, {code: "ProviderAuthenticationFailed"});
  assert.equal(store.deleteCalls, 1);
  const [freshA, freshB] = await Promise.all([manager.acquire(scope), manager.acquire(scope)]);
  assert.equal(freshA, freshB);
  assert.equal(loginCalls, 2);
  for await (const _chunk of freshA.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  await manager.close();
});

void test("delayed rotation cannot restore an invalidated row or cache", async () => {
  const store = new MemoryProviderSessionStore();
  const rotationSaveEntered = Promise.withResolvers();
  const releaseRotationSave = Promise.withResolvers();
  const invalidationReadEntered = Promise.withResolvers();
  let loginCalls = 0;
  let readCalls = 0;
  const transport = {
    login: async () => { loginCalls++; return loginResult(); },
    read: async function* () {
      readCalls++;
      if (readCalls === 1) {
        yield Buffer.from("{}");
        return [{...cookie, value: "rotated-cookie"}];
      }
      if (readCalls === 2) {
        invalidationReadEntered.resolve();
        throw new ProviderError("ProviderAuthenticationFailed");
      }
      yield Buffer.from("{}");
      return [];
    },
  };
  const originalSave = store.save.bind(store);
  store.save = async (scopeHash, encrypted, expiresAt, signal) => {
    if (store.saveCalls === 1) {
      rotationSaveEntered.resolve();
      await releaseRotationSave.promise;
    }
    await originalSave(scopeHash, encrypted, expiresAt, signal);
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 13)});
  const stale = await manager.acquire(scope);
  const rotation = (async () => {
    for await (const _chunk of stale.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await rotationSaveEntered.promise;

  const invalidation = (async () => {
    for await (const _chunk of stale.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await invalidationReadEntered.promise;
  releaseRotationSave.resolve();
  await assert.rejects(rotation, {code: "ProviderSessionUnavailable"});
  await assert.rejects(invalidation, {code: "ProviderAuthenticationFailed"});
  assert.equal(store.inspect(stale.scopeHash), undefined);

  const [freshA, freshB] = await Promise.all([manager.acquire(scope), manager.acquire(scope)]);
  assert.equal(freshA, freshB);
  assert.notEqual(freshA, stale);
  assert.equal(loginCalls, 2);
  for await (const _chunk of freshA.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  await manager.close();
});

void test("a stale 401 cannot delete the session installed after re-login", async () => {
  const store = new MemoryProviderSessionStore();
  const staleReadEntered = Promise.withResolvers();
  const releaseStaleRead = Promise.withResolvers();
  let loginCalls = 0;
  let readCalls = 0;
  const transport = {
    login: async () => { loginCalls++; return {...loginResult(), cookies: [{...cookie, value: `session-${loginCalls}`}]}; },
    read: async function* () {
      readCalls++;
      if (readCalls === 1) {
        staleReadEntered.resolve();
        await releaseStaleRead.promise;
        throw new ProviderError("ProviderAuthenticationFailed");
      }
      if (readCalls === 2) throw new ProviderError("ProviderAuthenticationFailed");
      yield Buffer.from("{}");
      return [];
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 14)});
  const stale = await manager.acquire(scope);
  const staleRead = (async () => {
    for await (const _chunk of stale.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await staleReadEntered.promise;

  const invalidator = (async () => {
    for await (const _chunk of stale.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await assert.rejects(invalidator, {code: "ProviderAuthenticationFailed"});
  const [freshA, freshB] = await Promise.all([manager.acquire(scope), manager.acquire(scope)]);
  assert.equal(freshA, freshB);
  assert.notEqual(freshA, stale);
  assert.equal(loginCalls, 2);

  releaseStaleRead.resolve();
  await assert.rejects(staleRead, {code: "ProviderAuthenticationFailed"});
  assert.equal(store.deleteCalls, 1);
  const persisted = store.inspect(freshA.scopeHash);
  assert.ok(persisted);
  assert.equal(decryptCookieMaterial(persisted.encryptedCookieMaterial, Buffer.alloc(32, 14))[0].value, "session-2");

  const restarted = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 14)});
  const restored = await restarted.acquire(scope);
  assert.equal(restored.scopeHash, freshA.scopeHash);
  assert.equal(loginCalls, 2);
  await restarted.close();
  await manager.close();
});

void test("concurrent cookie rotations merge against the latest serialized state", async () => {
  const store = new MemoryProviderSessionStore();
  let readCalls = 0;
  const transport = {
    login: async () => loginResult(),
    read: async function* () {
      const call = ++readCalls;
      yield Buffer.from("{}");
      return [{...cookie, name: `rotation-${call}`, value: `value-${call}`}];
    },
  };
  const key = Buffer.alloc(32, 15);
  const manager = new ProviderSessionManager({transport, store, encryptionKey: key});
  const session = await manager.acquire(scope);
  await Promise.all([1, 2].map(async () => {
    for await (const _chunk of session.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  }));
  const persisted = store.inspect(session.scopeHash);
  assert.ok(persisted);
  assert.deepEqual(decryptCookieMaterial(persisted.encryptedCookieMaterial, key).map(item => item.name).sort(), ["october_session", "rotation-1", "rotation-2"]);
  await manager.close();
});

void test("request abort cannot cancel durable invalidation after provider 401", async () => {
  const store = new MemoryProviderSessionStore();
  let loginCalls = 0;
  const controller = new AbortController();
  const transport = {
    login: async () => { loginCalls++; return loginResult(); },
    read: async function* () {
      yield* [];
      controller.abort();
      throw new ProviderError("ProviderAuthenticationFailed");
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 16)});
  const stale = await manager.acquire(scope);
  await assert.rejects(async () => {
    for await (const _chunk of stale.read({kind: "cart"}, controller.signal)) { /* consume */ }
  }, {code: "ProviderAuthenticationFailed"});
  assert.equal(store.inspect(stale.scopeHash), undefined);
  await manager.acquire(scope);
  assert.equal(loginCalls, 2);
  await manager.close();
});

void test("a fresh acquire never joins an aborted zero-waiter flight", async () => {
  const store = new MemoryProviderSessionStore();
  const firstLoginEntered = Promise.withResolvers();
  const releaseFirstLogin = Promise.withResolvers();
  let loginCalls = 0;
  const transport = {
    login: async (_credentials, signal) => {
      loginCalls++;
      if (loginCalls === 1) {
        firstLoginEntered.resolve();
        await releaseFirstLogin.promise;
        signal.throwIfAborted();
      }
      return loginResult();
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 17)});
  const controller = new AbortController();
  const cancelled = manager.acquire(scope, controller.signal);
  await firstLoginEntered.promise;
  controller.abort();
  await assert.rejects(cancelled, {code: "ProviderCancelled"});
  const fresh = manager.acquire(scope);
  releaseFirstLogin.resolve();
  await fresh;
  assert.equal(loginCalls, 2);
  await manager.close();
});

void test("close waits for active rotation persistence before transport shutdown", async () => {
  const store = new MemoryProviderSessionStore();
  const rotationSaveEntered = Promise.withResolvers();
  const releaseRotationSave = Promise.withResolvers();
  let closed = false;
  const transport = {
    login: async () => loginResult(),
    read: async function* () {
      yield Buffer.from("{}");
      return [{...cookie, value: "rotation-before-close"}];
    },
    close: async () => { closed = true; },
  };
  const originalSave = store.save.bind(store);
  store.save = async (scopeHash, encrypted, expiresAt, signal) => {
    if (store.saveCalls === 1) {
      rotationSaveEntered.resolve();
      await releaseRotationSave.promise;
    }
    await originalSave(scopeHash, encrypted, expiresAt, signal);
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 18)});
  const session = await manager.acquire(scope);
  const read = (async () => {
    for await (const _chunk of session.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await rotationSaveEntered.promise;
  let closeResolved = false;
  const closing = manager.close().then(() => { closeResolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closeResolved, false);
  assert.equal(closed, false);
  releaseRotationSave.resolve();
  await assert.rejects(read, {code: "ProviderSessionUnavailable"});
  await closing;
  assert.equal(closed, true);
});

void test("cancellation aborts the last waiter and close cleans the pending flight", async () => {
  const store = new MemoryProviderSessionStore();
  let transportAborted = 0;
  let closed = 0;
  const transport = {
    login: async (_credentials, signal) => await new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {transportAborted++; reject(new ProviderError("ProviderUnavailable"));}, {once: true});
    }),
    close: async () => {closed++;},
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 9)});
  const controller = new AbortController();
  const pending = manager.acquire(scope, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, {code: "ProviderCancelled"});
  await manager.close();
  assert.equal(transportAborted, 1);
  assert.equal(closed, 1);
});

void test("late login completion after close cannot remember or persist cookies", async () => {
  const store = new MemoryProviderSessionStore();
  const loginEntered = Promise.withResolvers();
  const releaseLogin = Promise.withResolvers();
  const transport = {
    login: async () => {
      loginEntered.resolve();
      await releaseLogin.promise;
      return loginResult();
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 21)});
  const pending = manager.acquire(scope);
  await loginEntered.promise;
  const closing = manager.close();
  releaseLogin.resolve();
  await assert.rejects(pending, {code: "ProviderSessionUnavailable"});
  await closing;
  assert.equal(store.saveCalls, 0);
});

void test("late persisted load completion after force destroy cannot remember decrypted cookies", async () => {
  const key = Buffer.alloc(32, 22);
  const store = new MemoryProviderSessionStore();
  const scopeHash = providerSessionScopeHash(scope.scopeRef, "canonical@example.test");
  await store.save(scopeHash, encryptCookieMaterial([cookie], key), null);
  const loadEntered = Promise.withResolvers();
  const releaseLoad = Promise.withResolvers();
  const originalLoad = store.load.bind(store);
  store.load = async (...args) => {
    loadEntered.resolve();
    await releaseLoad.promise;
    return originalLoad(...args);
  };
  let loginCalls = 0;
  const manager = new ProviderSessionManager({
    transport: {login: async () => { loginCalls += 1; return loginResult(); }},
    store,
    encryptionKey: key,
  });
  const pending = manager.acquire(scope);
  await loadEntered.promise;
  manager.forceDestroy();
  releaseLoad.resolve();
  await assert.rejects(pending, {code: "ProviderSessionUnavailable"});
  assert.equal(loginCalls, 0);
  assert.equal(store.deleteCalls, 0);
});

void test("late cookie rotation completion after close or force destroy cannot save or restore cookies", async () => {
  for (const shutdown of ["close", "forceDestroy"]) {
    const store = new MemoryProviderSessionStore();
    const rotationEntered = Promise.withResolvers();
    const releaseRotation = Promise.withResolvers();
    const transport = {
      login: async () => loginResult(),
      read: async function* () {
        yield Buffer.from("{}");
        rotationEntered.resolve();
        await releaseRotation.promise;
        return [{...cookie, value: `late-${shutdown}-cookie`}];
      },
    };
    const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, shutdown === "close" ? 23 : 24)});
    const session = await manager.acquire(scope);
    const reading = (async () => {
      for await (const _chunk of session.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
    })();
    await rotationEntered.promise;
    const closing = shutdown === "close" ? manager.close() : undefined;
    if (shutdown === "forceDestroy") manager.forceDestroy();
    releaseRotation.resolve();
    await assert.rejects(reading, {code: "ProviderSessionUnavailable"});
    if (closing !== undefined) await closing;
    assert.equal(store.saveCalls, 1);
  }
});

void test("concurrent close calls share one completion promise", async () => {
  const store = new MemoryProviderSessionStore();
  let closed = 0;
  const manager = new ProviderSessionManager({
    transport: {login: async () => loginResult(), close: async () => { closed += 1; await new Promise(resolve => setImmediate(resolve)); }},
    store,
    encryptionKey: Buffer.alloc(32, 19),
  });
  const first = manager.close();
  const second = manager.close();
  assert.strictEqual(first, second);
  await first;
  assert.equal(closed, 1);
});

void test("force destroy reaches a non-cooperative active read and closes transport once", async () => {
  const store = new MemoryProviderSessionStore();
  let closed = 0;
  const entered = Promise.withResolvers();
  const transport = {
    login: async () => loginResult(),
    read: async function* () {
      yield Buffer.from("{}");
      entered.resolve();
      await new Promise(() => {});
    },
    close: async () => { closed += 1; },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 20)});
  const session = await manager.acquire(scope);
  const active = (async () => {
    for await (const _chunk of session.read({kind: "cart"}, new AbortController().signal)) { /* consume */ }
  })();
  await entered.promise;
  const closing = manager.close();
  manager.forceDestroy();
  manager.forceDestroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
  void closing;
  void active;
});

void test("safe pre-dispatch read re-authenticates once after an empty 401 and never logs in a third time", async () => {
  const store = new MemoryProviderSessionStore();
  let loginCalls = 0;
  let readCalls = 0;
  const transport = {
    login: async () => { loginCalls += 1; return {...loginResult(), cookies: [{...cookie, value: `session-${loginCalls}`}]}; },
    read: async function* () {
      readCalls += 1;
      if (readCalls === 1) throw new ProviderError("ProviderAuthenticationFailed");
      yield Buffer.from('{"ok":true}');
      return [];
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 25)});
  const result = [];
  for await (const chunk of readProviderSafely(manager, scope, {kind: "cart"}, new AbortController().signal)) result.push(chunk);
  assert.equal(Buffer.concat(result).toString(), '{"ok":true}');
  assert.equal(loginCalls, 2);
  assert.equal(readCalls, 2);
  await manager.close();
});

void test("concurrent safe reads share the re-authenticated session and a failed re-auth cannot trigger a third login", async () => {
  const store = new MemoryProviderSessionStore();
  let loginCalls = 0;
  let readCalls = 0;
  const transport = {
    login: async () => { loginCalls += 1; return {...loginResult(), cookies: [{...cookie, value: `session-${loginCalls}`}]}; },
    read: async function* () {
      const call = ++readCalls;
      if (call <= 3) throw new ProviderError("ProviderAuthenticationFailed");
      yield Buffer.from("{}");
      return [];
    },
  };
  const manager = new ProviderSessionManager({transport, store, encryptionKey: Buffer.alloc(32, 26)});
  const one = readProviderSafely(manager, scope, {kind: "cart"}, new AbortController().signal);
  const two = readProviderSafely(manager, scope, {kind: "cart"}, new AbortController().signal);
  const outcomes = await Promise.allSettled([
    (async () => { for await (const _chunk of one) { /* no-op */ } })(),
    (async () => { for await (const _chunk of two) { /* no-op */ } })(),
  ]);
  assert.equal(outcomes.some(outcome => outcome.status === "rejected"), true);
  assert.equal(loginCalls, 2);
  assert.ok(readCalls >= 2);
  await manager.close();
});

void test("safe-read consumer return closes its span exactly once", async () => {
  const telemetry = recordingTelemetry();
  const manager = new ProviderSessionManager({
    transport: {
      login: async () => loginResult(),
      read: async function* () {
        try {
          yield Buffer.from("first");
          yield Buffer.from("second");
        } finally {
          // The consumer return must close the provider iterator too.
        }
      },
      mutate: async () => ({statusCode: 200, body: Buffer.from("{}")}),
    },
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 28),
    telemetry,
  });
  for await (const _chunk of manager.readSafe(scope, {kind: "cart"}, new AbortController().signal)) break;
  const safeReadSpans = telemetry.spans.filter(span => span.name === "aroma.gateway.safe_read");
  assert.equal(safeReadSpans.length, 1);
  assert.equal(safeReadSpans[0].endCount, 1);
  await manager.close();
});

void test("provider readiness is local, marks real login failure, and recovers after success", async () => {
  let allowLogin = false;
  let providerCalls = 0;
  const telemetry = recordingTelemetry();
  const manager = new ProviderSessionManager({
    transport: {
      login: async () => {
        providerCalls += 1;
        if (!allowLogin) throw new ProviderError("ProviderAuthenticationFailed");
        return loginResult();
      },
      read: async function* () { yield Buffer.from("{}"); },
      mutate: async () => ({statusCode: 200, body: Buffer.from("{}")}),
    },
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 29),
    telemetry,
  });
  assert.equal(manager.isReady(), true);
  assert.equal(providerCalls, 0);
  await assert.rejects(manager.acquire(scope), {code: "ProviderAuthenticationFailed"});
  assert.equal(manager.isReady(), false);
  assert.equal(providerCalls, 1);
  allowLogin = true;
  await manager.acquire(scope);
  assert.equal(manager.isReady(), true);
  assert.equal(providerCalls, 2);
  assert.match(telemetry.metrics.render().join("\n"), /aroma_gateway_session_logins_total 1/);
  assert.match(telemetry.metrics.render().join("\n"), /aroma_gateway_session_failures_total 1/);
  assert.match(telemetry.metrics.render().join("\n"), /aroma_gateway_session_results_total\{result="login"\} 1/);
  assert.match(telemetry.metrics.render().join("\n"), /aroma_gateway_session_results_total\{result="failure"\} 1/);
  await manager.close();
});

void test("real ProviderHttpClient caller cancellation never degrades login, read, or mutate readiness", async (t) => {
  let mode = "login-abort";
  let entered = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (mode === "login-success") return providerLoginResponse();
    if ((mode === "read-success" || mode === "mutate-success") && url.endsWith("/api/v1/auth/login")) return providerLoginResponse();
    if (mode === "read-success" || mode === "mutate-success") return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    return pendingFetch(init, entered);
  });
  const client = new ProviderHttpClient(httpOptions);
  const manager = realProviderManager(client);
  t.after(() => manager.close());

  const loginController = new AbortController();
  const pendingLogin = manager.acquire(scope, loginController.signal);
  await entered.promise;
  loginController.abort(new Error("caller stopped login"));
  await assert.rejects(pendingLogin, {code: "ProviderCancelled"});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.isReady(), true);

  mode = "login-success";
  const session = await manager.acquire(scope);
  assert.equal(manager.isReady(), true);

  mode = "read-abort";
  entered = Promise.withResolvers();
  const readController = new AbortController();
  const pendingRead = collect(session.read({kind: "cart"}, readController.signal));
  await entered.promise;
  readController.abort(new Error("caller stopped read"));
  await assert.rejects(pendingRead, {code: "ProviderUnavailable"});
  assert.equal(manager.isReady(), true);

  mode = "mutate-abort";
  entered = Promise.withResolvers();
  const mutateController = new AbortController();
  const pendingMutation = session.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, mutateController.signal);
  await entered.promise;
  mutateController.abort(new Error("caller stopped mutation"));
  await assert.rejects(pendingMutation, {code: "ProviderUnavailable"});
  assert.equal(manager.isReady(), true);
});

void test("real ProviderHttpClient close and forceDestroy cancellation never degrade in-flight login, read, or mutate", async (t) => {
  let mode = "success";
  let entered = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (mode === "success" && url.endsWith("/api/v1/auth/login")) return providerLoginResponse();
    if (mode === "success") return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    return pendingFetch(init, entered);
  });

  for (const shutdown of ["close", "forceDestroy"]) {
    for (const operation of ["login", "read", "mutate"]) {
      mode = "success";
      entered = Promise.withResolvers();
      const client = new ProviderHttpClient(httpOptions);
      const manager = realProviderManager(client);
      let pending;
      if (operation === "login") {
        mode = "shutdown";
        pending = manager.acquire(scope);
      } else {
        const session = await manager.acquire(scope);
        mode = "shutdown";
        entered = Promise.withResolvers();
        pending = operation === "read"
          ? collect(session.read({kind: "cart"}, new AbortController().signal))
          : session.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, new AbortController().signal);
      }
      await entered.promise;
      if (shutdown === "close") {
        const closing = manager.close();
        await assert.rejects(pending, {code: "ProviderUnavailable"});
        await closing;
      } else {
        manager.forceDestroy();
        await assert.rejects(pending, {code: "ProviderUnavailable"});
        await manager.close();
      }
      assert.equal(manager.isReady(), false);
    }
  }
});

void test("real ProviderHttpClient auth, protocol, and unavailable failures degrade then a real success recovers readiness", async (t) => {
  let mode = "login-auth-failure";
  t.mock.method(globalThis, "fetch", async (url) => {
    if (mode === "success" && url.endsWith("/api/v1/auth/login")) return providerLoginResponse();
    if (mode === "success") return new Response("{}", {status: 200, headers: {"content-type": "application/json"}});
    if (mode === "login-auth-failure") {
      return new Response(JSON.stringify({error: "validation failed", errors: {email: ["invalid"]}}), {status: 422, headers: {"content-type": "application/json"}});
    }
    if (mode === "mutation-auth-response") {
      return new Response(JSON.stringify({error: "unauthorized", errors: {session: ["expired"]}}), {status: 401, headers: {"content-type": "application/json"}});
    }
    if (mode === "read-protocol-failure") return new Response(null, {status: 302, headers: {location: "https://forbidden.test"}});
    throw new Error("provider unavailable");
  });

  const loginClient = new ProviderHttpClient(httpOptions);
  const loginManager = realProviderManager(loginClient);
  await assert.rejects(loginManager.acquire(scope), {code: "ProviderAuthenticationFailed"});
  assert.equal(loginManager.isReady(), false);
  mode = "success";
  await loginManager.acquire(scope);
  assert.equal(loginManager.isReady(), true);
  await loginManager.close();

  mode = "success";
  const readClient = new ProviderHttpClient(httpOptions);
  const readManager = realProviderManager(readClient);
  const readSession = await readManager.acquire(scope);
  mode = "read-protocol-failure";
  await assert.rejects(collect(readSession.read({kind: "catalog-page", page: 1, pageSize: 1}, new AbortController().signal)), {code: "ProviderProtocolViolation"});
  assert.equal(readManager.isReady(), false);
  mode = "success";
  assert.equal(await collect(readSession.read({kind: "catalog-page", page: 1, pageSize: 1}, new AbortController().signal)), "{}");
  assert.equal(readManager.isReady(), true);
  await readManager.close();

  mode = "success";
  const mutationClient = new ProviderHttpClient(httpOptions);
  const mutationManager = realProviderManager(mutationClient);
  const mutationSession = await mutationManager.acquire(scope);
  mode = "mutation-unavailable";
  await assert.rejects(mutationSession.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, new AbortController().signal), {code: "ProviderUnavailable"});
  assert.equal(mutationManager.isReady(), false);
  mode = "success";
  const mutationResult = await mutationSession.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, new AbortController().signal);
  assert.equal(mutationResult.statusCode, 200);
  assert.equal(mutationManager.isReady(), true);
  await mutationManager.close();

  mode = "success";
  const rejectedMutationClient = new ProviderHttpClient(httpOptions);
  const rejectedMutationManager = realProviderManager(rejectedMutationClient);
  const rejectedMutationSession = await rejectedMutationManager.acquire(scope);
  mode = "mutation-auth-response";
  const authRejection = await rejectedMutationSession.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, new AbortController().signal);
  assert.equal(authRejection.statusCode, 401);
  assert.equal(rejectedMutationManager.isReady(), false);
  mode = "success";
  assert.equal((await rejectedMutationSession.mutate({kind: "add-cart-line", offerId: "1", quantity: 1}, new AbortController().signal)).statusCode, 200);
  assert.equal(rejectedMutationManager.isReady(), true);
  await rejectedMutationManager.close();
});

void test("failed re-auth records safe-read failure without counting a successful login", async () => {
  let loginCalls = 0;
  const telemetry = recordingTelemetry();
  const manager = new ProviderSessionManager({
    transport: {
      login: async () => {
        loginCalls += 1;
        if (loginCalls > 1) throw new ProviderError("ProviderAuthenticationFailed");
        return loginResult();
      },
      read: async function* () { yield* []; throw new ProviderError("ProviderAuthenticationFailed"); },
      mutate: async () => ({statusCode: 200, body: Buffer.from("{}")}),
    },
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 30),
    telemetry,
  });
  await assert.rejects((async () => {
    for await (const _chunk of manager.readSafe(scope, {kind: "cart"}, new AbortController().signal)) { /* no-op */ }
  })(), {code: "ProviderAuthenticationFailed"});
  const rendered = telemetry.metrics.render().join("\n");
  assert.equal(loginCalls, 2);
  assert.match(rendered, /aroma_gateway_safe_read_failures_total 1/);
  assert.match(rendered, /aroma_gateway_session_logins_total 1/);
  assert.match(rendered, /aroma_gateway_session_failures_total 1/);
  await manager.close();
});

void test("Gateway metrics render only the finite allowlist and redact canaries", () => {
  const metrics = new GatewayMetrics();
  metrics.increment("sessionAttempts");
  metrics.increment("safeReadBytes", 12);
  metrics.increment("mutationUnknown");
  const rendered = metrics.render().join("\n");
  assert.match(rendered, /aroma_gateway_session_attempts_total 1/);
  assert.match(rendered, /aroma_gateway_safe_read_bytes_total 12/);
  assert.match(rendered, /aroma_gateway_mutation_outcomes_total\{result="unknown"\} 1/);
  assert.doesNotMatch(rendered, /secret-cookie|password-from-caller|canonical@example.test/);
  assert.equal(metrics.metricNames().every(name => /^aroma_gateway_[a-z0-9_]+$/.test(name)), true);
});

void test("session readiness is local and telemetry spans contain no credential or provider-body canary", async () => {
  const manager = new ProviderSessionManager({
    transport: {login: async () => loginResult(), read: async function* () { yield Buffer.from("{}"); }, mutate: async () => ({statusCode: 200, body: Buffer.from("{}")})},
    store: new MemoryProviderSessionStore(),
    encryptionKey: Buffer.alloc(32, 27),
  });
  assert.equal(manager.isReady(), true);
  const spans = [];
  trace.setGlobalTracerProvider({getTracer: () => ({startSpan: (name, _options) => {
    const span = {name, attributes: {}, events: [], setAttribute: (key, value) => { span.attributes[key] = value; return span; }, recordException: error => { span.events.push(error); }, setStatus: () => span, end: () => undefined};
    spans.push(span);
    return span;
  }})});
  const metrics = new GatewayMetrics();
  const telemetry = createGatewayTelemetry(metrics);
  const span = telemetry.startSpan("canary", {cookie: "secret-cookie", password: "password-from-caller", safe: "provider-body-pii"});
  finishGatewaySpan(span, new Error("secret-cookie password-from-caller provider-body-pii"));
  const output = JSON.stringify(spans);
  assert.doesNotMatch(output, /secret-cookie|password-from-caller|provider-body-pii/);
  await manager.close();
  assert.equal(manager.isReady(), false);
});
