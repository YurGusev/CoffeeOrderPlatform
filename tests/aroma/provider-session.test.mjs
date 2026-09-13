import assert from "node:assert/strict";
import test from "node:test";
import {ProviderError} from "../../apps/aroma-gateway/dist/domain/provider-errors.js";
import {
  decryptCookieMaterial,
  MemoryProviderSessionStore,
} from "../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import {ProviderSessionManager} from "../../apps/aroma-gateway/dist/infrastructure/provider/session.js";

const scope = {scopeRef: "aroma-development", email: " Canonical@Example.test ", password: "password-from-caller"};
const cookie = Object.freeze({name: "october_session", value: "secret-cookie", domain: "aromateacoffee.ru", path: "/", expiresAt: null, secure: true, httpOnly: true, sameSite: "lax"});
const profile = {email: "canonical@example.test", wholesale: true, retail: false};
const loginResult = () => ({profile, cookies: [cookie]});

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
