import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import {createConnection} from "node:net";
import test from "node:test";
import {createRuntime} from "../../packages/platform-runtime/src/index.ts";
import {verifyActorContextWithKeySet} from "../../packages/platform-security/src/index.ts";
import {createConfiguredEdgeAuthAdapters, createEdgeAuthComposition} from "../../apps/edge-gateway/dist/index.js";
import {OidcDependencyUnavailableError} from "../../apps/edge-gateway/dist/oidc-auth.js";
import {registerEdgeAuthRoutes} from "../../apps/edge-gateway/dist/routes.js";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://app.fixture.invalid";
const LOGIN_BINDING = "b".repeat(43);

function fixture({peer = true, operation = {operationId: "getOrderCard", audience: "api-public", requiredPermission: "orders:read"}, session = {actorRef: "actor:fixture", permissions: ["orders:read"], csrf: "csrf-fixture", expiresAt: NOW + 120_000}} = {}) {
  const calls = {begin: [], complete: [], verifyCsrf: [], logout: [], resolve: []};
  const sessions = new Map([["session-fixture", session]]);
  const authority = {
    begin: async (returnTo) => { calls.begin.push(returnTo); return {authorizationUrl: "https://idp.fixture.invalid/authorize?state=state-fixture", state: "state-fixture", loginBinding: LOGIN_BINDING}; },
    complete: async (state, code, loginBinding) => { calls.complete.push([state, code, loginBinding]); return {sessionId: "session-fixture", csrf: "csrf-fixture", actorRef: session.actorRef, expiresAt: session.expiresAt, returnTo: "/app/orders"}; },
    session: (id) => sessions.get(id),
    verifyCsrf: (id, token) => { calls.verifyCsrf.push([id, token]); return id === "session-fixture" && token === "csrf-fixture"; },
    logout: (id) => { calls.logout.push(id); return sessions.delete(id); },
  };
  const adapters = {
    authority,
    verifyNginxPeer: () => peer,
    resolveOperation: (method, rawTarget) => { calls.resolve.push([method, rawTarget]); return operation ?? undefined; },
    signActorContext: (claims) => { calls.claims = claims; return "signed.actor.context"; },
    now: () => NOW,
    origin: ORIGIN,
  };
  return {calls, sessions, adapters};
}

async function makeApp(t, f, composition) {
  const app = await createRuntime({name: "edge-auth-test", host: "127.0.0.1", port: 0, shutdownGraceMs: 500, deadlineMs: 5_000});
  if (composition === undefined) registerEdgeAuthRoutes(app, f.adapters);
  else await composition.configure(app, new AbortController().signal);
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

const sessionCookie = "__Host-coffee-session=session-fixture";
const csrfCookie = "__Host-coffee-csrf=csrf-fixture";

function rawRequest(app) {
  const address = app.server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection({host: "127.0.0.1", port: address.port}, () => {
      socket.write("GET /_edge/authorize HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Original-Method: GET\r\nX-Original-URI: /api/client-v1/orders/order-1\r\nX-Original-URI: /forged\r\nCookie: __Host-coffee-session=session-fixture\r\nConnection: close\r\n\r\n");
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1])));
    socket.on("error", reject);
  });
}

void test("runtime composition registers routes and signs a verifiable Ed25519 actor assertion", async (t) => {
  const f = fixture();
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const pem = privateKey.export({type: "pkcs8", format: "pem"});
  const configured = createConfiguredEdgeAuthAdapters(
    {secrets: {security: {actorContextEdgeSigningPrivateKey: pem}}},
    f.adapters.authority,
    ORIGIN,
    f.adapters.resolveOperation,
  );
  assert.equal(configured.verifyNginxPeer({runtimeContext: {transportIdentity: {runtime: "edge-nginx"}}}), true);
  assert.equal(configured.verifyNginxPeer({runtimeContext: {transportIdentity: {runtime: "other"}}}), false);
  assert.equal(configured.verifyNginxPeer({}), false);

  // The actual runtime fixture has no TLS identity; isolate the route's peer gate while
  // independently testing the production adapter's exact transport identity check above.
  const app = await makeApp(t, f, createEdgeAuthComposition({...configured, now: () => NOW, verifyNginxPeer: () => true}));
  const authorized = await app.inject({method: "GET", url: "/_edge/authorize", headers: {
    "x-original-method": "GET", "x-original-uri": "/api/client-v1/orders/order-1", cookie: sessionCookie,
  }});
  assert.equal(authorized.statusCode, 204);
  const claims = verifyActorContextWithKeySet(authorized.headers["x-actor-context"], {
    publicKeys: [publicKey], issuer: "edge-gateway", audience: "api-public",
    nowEpochSeconds: NOW / 1_000, clockSkewSeconds: 0,
  });
  assert.equal(claims.sub, "actor:fixture");
  assert.deepEqual(claims.permissions, ["orders:read"]);
  assert.equal(claims.operationId, "getOrderCard");
  assert.equal(claims.originalIssuer, "edge-gateway");
  assert.equal(claims.kid, "edge-actor-context-v1");
  assert.equal(claims.traceparent, "00-00000000000000000000000000000000-0000000000000000-00");
  assert.equal(claims.iat, NOW / 1_000);
  assert.equal(claims.exp, (NOW + 60_000) / 1_000);
  assert.ok(claims.jti.length > 0);

  const missingSecret = createConfiguredEdgeAuthAdapters(
    {secrets: {}}, f.adapters.authority, ORIGIN, f.adapters.resolveOperation,
  );
  assert.throws(() => missingSecret.signActorContext({}), /EDGE_ACTOR_CONTEXT_SIGNING_KEY_NOT_CONFIGURED/u);
});

void test("default edge composition registers routes but has no active authentication profile", async (t) => {
  const app = await makeApp(t, fixture(), createEdgeAuthComposition());
  assert.equal((await app.inject({method: "GET", url: "/auth/login"})).statusCode, 503);
  const denied = await app.inject({method: "GET", url: "/_edge/authorize", headers: {
    "x-original-method": "GET", "x-original-uri": "/api/client-v1/orders/order-1", cookie: sessionCookie,
  }});
  assert.equal(denied.statusCode, 401);
});

void test("configured Edge authorizer uses generated operation permission before signing", async (t) => {
  const f = fixture({session: {actorRef: "actor:fixture", permissions: ["catalog:read"], csrf: "csrf-fixture", expiresAt: NOW + 120_000}});
  const {privateKey, publicKey} = generateKeyPairSync("ed25519");
  const configured = createConfiguredEdgeAuthAdapters(
    {secrets: {security: {actorContextEdgeSigningPrivateKey: privateKey.export({type: "pkcs8", format: "pem"})}}},
    f.adapters.authority, ORIGIN,
  );
  const app = await makeApp(t, f, createEdgeAuthComposition({...configured, now: () => NOW, verifyNginxPeer: () => true}));
  const headers = {"x-original-method": "GET", "x-original-uri": "/api/client-v1/catalog/products?query=coffee", cookie: sessionCookie};
  const allowed = await app.inject({method: "GET", url: "/_edge/authorize", headers});
  assert.equal(allowed.statusCode, 204);
  const signed = verifyActorContextWithKeySet(allowed.headers["x-actor-context"], {
    publicKeys: [publicKey], issuer: "edge-gateway", audience: "api-public", nowEpochSeconds: NOW / 1_000, clockSkewSeconds: 0,
  });
  assert.equal(signed.operationId, "searchCatalogProducts");
  assert.deepEqual(signed.permissions, ["catalog:read"]);
  assert.equal(signed.correlationId, allowed.headers["x-correlation-id"]);
  assert.equal((await app.inject({method: "GET", url: "/_edge/authorize", headers: {...headers, "x-original-uri": "/api/client-v1/orders/order-1"}})).statusCode, 403);
  assert.equal((await app.inject({method: "GET", url: "/_edge/authorize", headers: {...headers, "x-original-method": "POST", "x-original-uri": "/api/client-v1/orders/drafts"}})).statusCode, 403);
});

void test("login and callback use authority state, local return path, no-store and secure host cookies", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const login = await app.inject({method: "GET", url: "/auth/login?returnTo=%2Fapp%2Forders"});
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, "https://idp.fixture.invalid/authorize?state=state-fixture");
  assert.equal(login.headers["cache-control"], "no-store");
  assert.equal(login.headers["set-cookie"], `__Host-coffee-login=${LOGIN_BINDING}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`);
  assert.deepEqual(f.calls.begin, ["/app/orders"]);

  const callback = await app.inject({method: "GET", url: "/auth/callback?state=state-fixture&code=fixture-code", headers: {cookie: `__Host-coffee-login=${LOGIN_BINDING}`}});
  assert.equal(callback.statusCode, 303);
  assert.equal(callback.headers.location, "/app/orders");
  assert.deepEqual(f.calls.complete, [["state-fixture", "fixture-code", LOGIN_BINDING]]);
  const cookies = callback.headers["set-cookie"];
  assert.equal(cookies.length, 3);
  assert.match(cookies[0], /^__Host-coffee-session=session-fixture; Path=\/; Secure; HttpOnly; SameSite=Lax$/u);
  assert.match(cookies[1], /^__Host-coffee-csrf=csrf-fixture; Path=\/; Secure; SameSite=Lax$/u);
  assert.match(cookies[2], /^__Host-coffee-login=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Lax$/u);
});

void test("callback without the browser's login-binding cookie never invokes the authority", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const callback = await app.inject({method: "GET", url: "/auth/callback?state=state-fixture&code=fixture-code"});
  assert.equal(callback.statusCode, 401);
  assert.deepEqual(f.calls.complete, []);
});

void test("callback reports provider outages as service unavailable, without issuing cookies", async (t) => {
  const provider = fixture();
  provider.adapters.authority.complete = async () => { throw new OidcDependencyUnavailableError(); };
  const providerApp = await makeApp(t, provider);
  const providerCallback = await providerApp.inject({method: "GET", url: "/auth/callback?state=state-fixture&code=fixture-code", headers: {cookie: `__Host-coffee-login=${LOGIN_BINDING}`}});
  assert.equal(providerCallback.statusCode, 503);
  assert.equal(providerCallback.json().code, "AUTH_UNAVAILABLE");
  assert.match(providerCallback.headers["set-cookie"], /^__Host-coffee-login=;/u);
});

void test("session exposes only server identity and expiry; logout requires same-origin session-bound CSRF", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const session = await app.inject({method: "GET", url: "/auth/session", headers: {cookie: sessionCookie}});
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), {actorRef: "actor:fixture", expiresAt: new Date(NOW + 120_000).toISOString()});
  assert.equal(session.headers["cache-control"], "no-store");

  const rejected = await app.inject({method: "POST", url: "/auth/logout", headers: {cookie: `${sessionCookie}; ${csrfCookie}`, origin: ORIGIN, "x-csrf-token": "wrong"}});
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual(f.calls.logout, []);

  const logout = await app.inject({method: "POST", url: "/auth/logout", headers: {cookie: `${sessionCookie}; ${csrfCookie}`, origin: ORIGIN, "x-csrf-token": "csrf-fixture"}});
  assert.equal(logout.statusCode, 204);
  assert.equal(logout.headers["set-cookie"].length, 3);
  assert.deepEqual(f.calls.logout, ["session-fixture"]);
});

void test("private authorizer requires nginx peer, contract operation, clean raw target and session", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const headers = {"x-original-method": "GET", "x-original-uri": "/api/client-v1/orders/order-1", cookie: sessionCookie};
  const authorized = await app.inject({method: "GET", url: "/_edge/authorize", headers});
  assert.equal(authorized.statusCode, 204);
  assert.equal(authorized.headers["x-actor-context"], "signed.actor.context");
  assert.equal(authorized.headers["x-correlation-id"], f.calls.claims.correlationId);
  assert.equal(f.calls.claims.sub, "actor:fixture");
  assert.equal(f.calls.claims.aud, "api-public");
  assert.equal(f.calls.claims.operationId, "getOrderCard");
  assert.deepEqual(f.calls.claims.permissions, ["orders:read"]);
  assert.equal(f.calls.claims.iat, NOW / 1_000);
  assert.equal(f.calls.claims.exp, (NOW + 60_000) / 1_000);

  const badPath = await app.inject({method: "GET", url: "/_edge/authorize", headers: {...headers, "x-original-uri": "/api/%252e%252e/orders"}});
  assert.equal(badPath.statusCode, 403);
  assert.equal(f.calls.resolve.length, 1);
});

void test("authorization fails closed on peer, unknown operation, forged headers, duplicates and CSRF failures", async (t) => {
  const deniedPeer = fixture({peer: false});
  const peerApp = await makeApp(t, deniedPeer);
  const base = {"x-original-method": "GET", "x-original-uri": "/api/client-v1/orders/order-1", cookie: sessionCookie};
  assert.equal((await peerApp.inject({method: "GET", url: "/_edge/authorize", headers: base})).statusCode, 401);

  const unknown = fixture({operation: null});
  const unknownApp = await makeApp(t, unknown);
  assert.equal((await unknownApp.inject({method: "GET", url: "/_edge/authorize", headers: base})).statusCode, 403);

  const forgedApp = await makeApp(t, fixture());
  assert.equal((await forgedApp.inject({method: "GET", url: "/_edge/authorize", headers: {...base, "x-audience": "api-public"}})).statusCode, 403);
  const duplicateApp = await makeApp(t, fixture());
  const duplicate = await rawRequest(duplicateApp);
  assert.equal(duplicate, 403);

  const mutation = fixture({operation: {operationId: "confirmOrder", audience: "api-public", requiredPermission: "orders:confirm"}});
  const mutationApp = await makeApp(t, mutation);
  const noCsrf = await mutationApp.inject({method: "GET", url: "/_edge/authorize", headers: {...base, "x-original-method": "POST"}});
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(mutation.calls.claims, undefined);
});

void test("mutation authorization caps signed expiry at session expiry and requires the session permission", async (t) => {
  const f = fixture({operation: {operationId: "confirmOrder", audience: "api-public", requiredPermission: "orders:confirm"}, session: {actorRef: "actor:fixture", permissions: ["orders:read"], csrf: "csrf-fixture", expiresAt: NOW + 30_000}});
  const app = await makeApp(t, f);
  const denied = await app.inject({method: "GET", url: "/_edge/authorize", headers: {
    "x-original-method": "POST", "x-original-uri": "/api/client-v1/orders/order-1/commands/confirm", cookie: `${sessionCookie}; ${csrfCookie}`, origin: ORIGIN, "x-csrf-token": "csrf-fixture",
  }});
  assert.equal(denied.statusCode, 403);
  assert.equal(f.calls.claims, undefined);
});
