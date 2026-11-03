import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createConnection } from "node:net";
import test from "node:test";
import { createRuntime } from "../../packages/platform-runtime/dist/index.js";
import { verifyActorContextWithKeySet } from "../../packages/platform-security/dist/index.js";
import {
  createConfiguredEdgeAuthAdapters,
  createEdgeAuthComposition,
  resolveBrowserOperation,
} from "../../apps/edge-gateway/dist/index.js";
import { OidcDependencyUnavailableError } from "../../apps/edge-gateway/dist/oidc-auth.js";
import { registerEdgeAuthRoutes } from "../../apps/edge-gateway/dist/routes.js";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://app.fixture.invalid";
const LOGIN_BINDING = "b".repeat(43);

function fixture({
  peer = true,
  operation = {
    operationId: "getOrderCard",
    audience: "api-public",
    requiredPermission: "orders:read",
  },
  session = {
    actorRef: "actor:fixture",
    permissions: ["orders:read"],
    csrf: "csrf-fixture",
    expiresAt: NOW + 120_000,
  },
} = {}) {
  const calls = {
    begin: [],
    complete: [],
    verifyCsrf: [],
    logout: [],
    resolve: [],
  };
  const sessions = new Map([["session-fixture", session]]);
  const authority = {
    begin: async (returnTo) => {
      calls.begin.push(returnTo);
      return {
        authorizationUrl:
          "https://idp.fixture.invalid/authorize?state=state-fixture",
        state: "state-fixture",
        loginBinding: LOGIN_BINDING,
      };
    },
    complete: async (state, code, loginBinding, issuer) => {
      calls.complete.push([state, code, loginBinding, issuer]);
      return {
        sessionId: "session-fixture",
        csrf: "csrf-fixture",
        actorRef: session.actorRef,
        expiresAt: session.expiresAt,
        returnTo: "/app/orders",
      };
    },
    session: (id) => sessions.get(id),
    verifyCsrf: (id, token) => {
      calls.verifyCsrf.push([id, token]);
      return id === "session-fixture" && token === "csrf-fixture";
    },
    logout: (id) => {
      calls.logout.push(id);
      return sessions.delete(id);
    },
  };
  const adapters = {
    authority,
    verifyNginxPeer: () => peer,
    resolveOperation: (method, rawTarget) => {
      calls.resolve.push([method, rawTarget]);
      return operation ?? undefined;
    },
    signActorContext: (claims) => {
      calls.claims = claims;
      return "signed.actor.context";
    },
    now: () => NOW,
    origin: ORIGIN,
  };
  return { calls, sessions, adapters };
}

async function makeApp(t, f, composition, context) {
  const app = await createRuntime({
    name: "edge-auth-test",
    host: "127.0.0.1",
    port: 0,
    shutdownGraceMs: 500,
    deadlineMs: 5_000,
  });
  if (composition === undefined) registerEdgeAuthRoutes(app, f.adapters);
  else
    await composition.configure(
      app,
      new AbortController().signal,
      undefined,
      undefined,
      context,
    );
  await app.runtimeController.start();
  t.after(() => app.runtimeController.closeRuntime("SIGTERM"));
  return app;
}

const sessionCookie = "__Host-coffee-session=session-fixture";
const csrfCookie = "__Host-coffee-csrf=csrf-fixture";

function rawRequest(app) {
  const address = app.server.address();
  return new Promise((resolve, reject) => {
    const socket = createConnection(
      { host: "127.0.0.1", port: address.port },
      () => {
        socket.write(
          "GET /_edge/authorize HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Original-Method: GET\r\nX-Original-URI: /api/client-v1/orders/order-1\r\nX-Original-URI: /forged\r\nCookie: __Host-coffee-session=session-fixture\r\nConnection: close\r\n\r\n",
        );
      },
    );
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () =>
      resolve(Number(/^HTTP\/1\.1 (\d{3})/u.exec(response)?.[1])),
    );
    socket.on("error", reject);
  });
}

void test("runtime composition registers routes and signs a verifiable Ed25519 actor assertion", async (t) => {
  const f = fixture();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const configured = createConfiguredEdgeAuthAdapters(
    { secrets: { security: { actorContextEdgeSigningPrivateKey: pem } } },
    f.adapters.authority,
    ORIGIN,
    f.adapters.resolveOperation,
  );
  assert.equal(
    configured.verifyNginxPeer({
      runtimeContext: { transportIdentity: { runtime: "edge-nginx" } },
    }),
    true,
  );
  assert.equal(
    configured.verifyNginxPeer({
      runtimeContext: { transportIdentity: { runtime: "other" } },
    }),
    false,
  );
  assert.equal(configured.verifyNginxPeer({}), false);

  // The actual runtime fixture has no TLS identity; isolate the route's peer gate while
  // independently testing the production adapter's exact transport identity check above.
  const app = await makeApp(
    t,
    f,
    createEdgeAuthComposition({
      ...configured,
      now: () => NOW,
      verifyNginxPeer: () => true,
    }),
  );
  const authorized = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers: {
      "x-original-method": "GET",
      "x-original-uri": "/api/client-v1/orders/order-1",
      cookie: sessionCookie,
    },
  });
  assert.equal(authorized.statusCode, 204);
  const claims = verifyActorContextWithKeySet(
    authorized.headers["x-actor-context"],
    {
      publicKeys: [publicKey],
      issuer: "edge-gateway",
      audience: "api-public",
      nowEpochSeconds: NOW / 1_000,
      clockSkewSeconds: 0,
    },
  );
  assert.equal(claims.sub, "actor:fixture");
  assert.deepEqual(claims.permissions, ["orders:read"]);
  assert.equal(claims.operationId, "getOrderCard");
  assert.equal(claims.originalIssuer, "edge-gateway");
  assert.equal(claims.kid, "edge-actor-context-v1");
  assert.equal(
    claims.traceparent,
    "00-00000000000000000000000000000000-0000000000000000-00",
  );
  assert.equal(claims.iat, NOW / 1_000);
  assert.equal(claims.exp, (NOW + 60_000) / 1_000);
  assert.ok(claims.jti.length > 0);

  const missingSecret = createConfiguredEdgeAuthAdapters(
    { secrets: {} },
    f.adapters.authority,
    ORIGIN,
    f.adapters.resolveOperation,
  );
  assert.throws(
    () => missingSecret.signActorContext({}),
    /EDGE_ACTOR_CONTEXT_SIGNING_KEY_NOT_CONFIGURED/u,
  );
});

void test("default edge composition registers routes but has no active authentication profile", async (t) => {
  const app = await makeApp(t, fixture(), createEdgeAuthComposition(), {
    config: { browserOidc: null },
  });
  const assertNoBrowserAuthority = (result) => {
    const cookies = [].concat(result.headers["set-cookie"] ?? []);
    assert.equal(result.headers["x-actor-context"], undefined);
    assert.equal(
      cookies.some((cookie) => /__Host-coffee-(?:session|csrf)=/u.test(cookie)),
      false,
    );
  };
  const login = await app.inject({ method: "GET", url: "/auth/login" });
  assert.equal(login.statusCode, 503);
  assertNoBrowserAuthority(login);

  const callback = await app.inject({
    method: "GET",
    url: "/auth/callback?state=forged-state&code=forged-code",
    headers: { cookie: `__Host-coffee-login=${LOGIN_BINDING}` },
  });
  assert.equal(callback.statusCode, 401);
  assertNoBrowserAuthority(callback);

  const session = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: sessionCookie },
  });
  assert.equal(session.statusCode, 401);
  assertNoBrowserAuthority(session);

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      origin: ORIGIN,
      cookie: `${sessionCookie}; ${csrfCookie}`,
      "x-csrf-token": "csrf-fixture",
    },
  });
  assert.equal(logout.statusCode, 401);
  assertNoBrowserAuthority(logout);

  const denied = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers: {
      "x-original-method": "GET",
      "x-original-uri": "/api/client-v1/orders/order-1",
      cookie: sessionCookie,
    },
  });
  assert.equal(denied.statusCode, 401);
  assertNoBrowserAuthority(denied);
});

void test("runtime Edge enables OIDC only with an explicit provider and actor claim mapping", async (t) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const app = await makeApp(t, fixture(), createEdgeAuthComposition(), {
    config: {
      platform: { publicBaseUrl: ORIGIN },
      browserOidc: {
        issuer: "https://idp.fixture.invalid",
        clientId: "client-fixture",
        authorizationUrl: "https://idp.fixture.invalid/authorize",
        tokenUrl: "https://idp.fixture.invalid/token",
        jwksUrl: "https://idp.fixture.invalid/jwks",
        redirectUri: `${ORIGIN}/auth/callback`,
        allowedAlgorithms: ["RS256"],
        actorRefClaim: "actor_ref",
        permissionsClaim: "platform_permissions",
      },
    },
    secrets: {
      security: {
        actorContextEdgeSigningPrivateKey: privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      },
    },
  });
  const login = await app.inject({ method: "GET", url: "/auth/login" });
  assert.equal(login.statusCode, 303);
  assert.match(
    login.headers.location,
    /^https:\/\/idp\.fixture\.invalid\/authorize\?/u,
  );
  assert.equal(
    new URL(login.headers.location).searchParams.get("client_id"),
    "client-fixture",
  );
});

void test("configured Edge authorizer uses generated operation permission before signing", async (t) => {
  const f = fixture({
    session: {
      actorRef: "actor:fixture",
      permissions: ["catalog:read"],
      csrf: "csrf-fixture",
      expiresAt: NOW + 120_000,
    },
  });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const configured = createConfiguredEdgeAuthAdapters(
    {
      secrets: {
        security: {
          actorContextEdgeSigningPrivateKey: privateKey.export({
            type: "pkcs8",
            format: "pem",
          }),
        },
      },
    },
    f.adapters.authority,
    ORIGIN,
  );
  const app = await makeApp(
    t,
    f,
    createEdgeAuthComposition({
      ...configured,
      now: () => NOW,
      verifyNginxPeer: () => true,
    }),
  );
  const headers = {
    "x-original-method": "GET",
    "x-original-uri": "/api/client-v1/catalog/products?query=coffee",
    cookie: sessionCookie,
  };
  const allowed = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers,
  });
  assert.equal(allowed.statusCode, 204);
  const signed = verifyActorContextWithKeySet(
    allowed.headers["x-actor-context"],
    {
      publicKeys: [publicKey],
      issuer: "edge-gateway",
      audience: "api-public",
      nowEpochSeconds: NOW / 1_000,
      clockSkewSeconds: 0,
    },
  );
  assert.equal(signed.operationId, "searchCatalogProducts");
  assert.deepEqual(signed.permissions, ["catalog:read"]);
  assert.equal(signed.correlationId, allowed.headers["x-correlation-id"]);
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers: {
          ...headers,
          "x-original-uri": "/api/client-v1/orders/order-1",
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers: {
          ...headers,
          "x-original-method": "POST",
          "x-original-uri": "/api/client-v1/orders/drafts",
        },
      })
    ).statusCode,
    403,
  );
});

void test("login and callback use authority state, local return path, no-store and secure host cookies", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const login = await app.inject({
    method: "GET",
    url: "/auth/login?returnTo=%2Fapp%2Forders",
  });
  assert.equal(login.statusCode, 303);
  assert.equal(
    login.headers.location,
    "https://idp.fixture.invalid/authorize?state=state-fixture",
  );
  assert.equal(login.headers["cache-control"], "no-store");
  assert.equal(
    login.headers["set-cookie"],
    `__Host-coffee-login=${LOGIN_BINDING}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.deepEqual(f.calls.begin, ["/app/orders"]);

  const callback = await app.inject({
    method: "GET",
    url: "/auth/callback?state=state-fixture&code=fixture-code&iss=https%3A%2F%2Fidp.fixture.invalid&session_state=opaque-session",
    headers: { cookie: `__Host-coffee-login=${LOGIN_BINDING}` },
  });
  assert.equal(callback.statusCode, 303);
  assert.equal(callback.headers.location, "/app/orders");
  assert.deepEqual(f.calls.complete, [
    [
      "state-fixture",
      "fixture-code",
      LOGIN_BINDING,
      "https://idp.fixture.invalid",
    ],
  ]);
  const cookies = callback.headers["set-cookie"];
  assert.equal(cookies.length, 3);
  assert.match(
    cookies[0],
    /^__Host-coffee-session=session-fixture; Path=\/; Secure; HttpOnly; SameSite=Lax$/u,
  );
  assert.match(
    cookies[1],
    /^__Host-coffee-csrf=csrf-fixture; Path=\/; Secure; SameSite=Lax$/u,
  );
  assert.match(
    cookies[2],
    /^__Host-coffee-login=; Path=\/; Max-Age=0; Secure; HttpOnly; SameSite=Lax$/u,
  );

  for (const extra of [
    "&unknown=value",
    "&state=duplicate",
    "&code=duplicate",
    "&iss=first&iss=second",
    "&session_state=first&session_state=second",
    `&iss=${"x".repeat(4_097)}`,
    `&session_state=${"x".repeat(4_097)}`,
    "&session_state=contains+space",
  ]) {
    const rejected = await app.inject({
      method: "GET",
      url: `/auth/callback?state=state-fixture&code=fixture-code${extra}`,
      headers: { cookie: `__Host-coffee-login=${LOGIN_BINDING}` },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().code, "INVALID_AUTH_REQUEST");
    assert.match(rejected.headers["set-cookie"], /^__Host-coffee-login=;/u);
    assert.equal(f.calls.complete.length, 1);
  }

  for (const attempt of [
    {
      authorizationUrl: "http://idp.fixture.invalid/authorize",
      loginBinding: LOGIN_BINDING,
    },
    {
      authorizationUrl: "https://idp.fixture.invalid/authorize",
      loginBinding: "invalid-binding",
    },
  ]) {
    const invalid = fixture();
    invalid.adapters.authority.begin = async () => attempt;
    const invalidApp = await makeApp(t, invalid);
    const rejected = await invalidApp.inject({
      method: "GET",
      url: "/auth/login",
    });
    assert.equal(rejected.statusCode, 503);
    assert.equal(rejected.json().code, "AUTH_UNAVAILABLE");
    assert.equal(rejected.headers.location, undefined);
    assert.equal(rejected.headers["set-cookie"], undefined);
    assert.equal(rejected.headers["cache-control"], "no-store");
  }

  const unsafeCallback = fixture();
  unsafeCallback.adapters.authority.complete = async (state, code, binding) => {
    unsafeCallback.calls.complete.push([state, code, binding]);
    return {
      sessionId: "session-fixture",
      csrf: "csrf-fixture",
      actorRef: "actor:fixture",
      expiresAt: NOW + 120_000,
      returnTo: "https://attacker.fixture.invalid/collect",
    };
  };
  const unsafeCallbackApp = await makeApp(t, unsafeCallback);
  const unsafe = await unsafeCallbackApp.inject({
    method: "GET",
    url: "/auth/callback?state=state-fixture&code=fixture-code",
    headers: { cookie: `__Host-coffee-login=${LOGIN_BINDING}` },
  });
  assert.equal(unsafe.statusCode, 401);
  assert.equal(unsafe.json().code, "AUTHENTICATION_REQUIRED");
  assert.equal(unsafe.headers.location, undefined);
  assert.equal(
    unsafe.headers["set-cookie"],
    "__Host-coffee-login=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
  );
  assert.deepEqual(unsafeCallback.calls.complete, [
    ["state-fixture", "fixture-code", LOGIN_BINDING],
  ]);
});

void test("callback without the browser's login-binding cookie never invokes the authority", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const callback = await app.inject({
    method: "GET",
    url: "/auth/callback?state=state-fixture&code=fixture-code",
  });
  assert.equal(callback.statusCode, 401);
  assert.deepEqual(f.calls.complete, []);
});

void test("callback reports provider outages as service unavailable, without issuing cookies", async (t) => {
  const provider = fixture();
  provider.adapters.authority.complete = async () => {
    throw new OidcDependencyUnavailableError();
  };
  const providerApp = await makeApp(t, provider);
  const providerCallback = await providerApp.inject({
    method: "GET",
    url: "/auth/callback?state=state-fixture&code=fixture-code",
    headers: { cookie: `__Host-coffee-login=${LOGIN_BINDING}` },
  });
  assert.equal(providerCallback.statusCode, 503);
  assert.equal(providerCallback.json().code, "AUTH_UNAVAILABLE");
  assert.match(
    providerCallback.headers["set-cookie"],
    /^__Host-coffee-login=;/u,
  );
});

void test("session exposes only server identity and expiry; logout requires same-origin session-bound CSRF", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const session = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: sessionCookie },
  });
  assert.equal(session.statusCode, 200);
  assert.deepEqual(session.json(), {
    actorRef: "actor:fixture",
    expiresAt: new Date(NOW + 120_000).toISOString(),
  });
  assert.equal(session.headers["cache-control"], "no-store");

  const rejected = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: ORIGIN,
      "x-csrf-token": "wrong",
    },
  });
  assert.equal(rejected.statusCode, 403);
  assert.deepEqual(f.calls.logout, []);

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: ORIGIN,
      "x-csrf-token": "csrf-fixture",
    },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal(logout.headers["set-cookie"].length, 3);
  assert.deepEqual(f.calls.logout, ["session-fixture"]);

  const unknownSession = await app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: "__Host-coffee-session=unknown-session" },
  });
  assert.equal(unknownSession.statusCode, 401);
  assert.equal(unknownSession.json().code, "AUTHENTICATION_REQUIRED");
  assert.equal(unknownSession.json().actorRef, undefined);

  const unavailable = fixture();
  unavailable.adapters.authority.session = () => {
    throw new Error("private session store detail");
  };
  const unavailableApp = await makeApp(t, unavailable);
  const unavailableSession = await unavailableApp.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: sessionCookie },
  });
  assert.equal(unavailableSession.statusCode, 503);
  assert.equal(unavailableSession.json().code, "AUTH_UNAVAILABLE");
  assert.equal(unavailableSession.json().detail.includes("private"), false);
  assert.equal(unavailableSession.json().actorRef, undefined);

  const failedLogout = fixture();
  failedLogout.adapters.authority.logout = (id) => {
    failedLogout.calls.logout.push(id);
    throw new Error("private logout store detail");
  };
  const failedLogoutApp = await makeApp(t, failedLogout);
  const logoutUnavailable = await failedLogoutApp.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: ORIGIN,
      "x-csrf-token": "csrf-fixture",
    },
  });
  assert.equal(logoutUnavailable.statusCode, 503);
  assert.equal(logoutUnavailable.json().code, "AUTH_UNAVAILABLE");
  assert.equal(logoutUnavailable.json().detail.includes("private"), false);
  assert.equal(logoutUnavailable.headers["set-cookie"], undefined);
  assert.deepEqual(failedLogout.calls.logout, ["session-fixture"]);

  const rejectedLogout = fixture();
  rejectedLogout.adapters.authority.logout = (id) => {
    rejectedLogout.calls.logout.push(id);
    return false;
  };
  const rejectedLogoutApp = await makeApp(t, rejectedLogout);
  const logoutRejected = await rejectedLogoutApp.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: ORIGIN,
      "x-csrf-token": "csrf-fixture",
    },
  });
  assert.equal(logoutRejected.statusCode, 401);
  assert.equal(logoutRejected.json().code, "AUTHENTICATION_REQUIRED");
  assert.equal(logoutRejected.headers["set-cookie"], undefined);
  assert.deepEqual(rejectedLogout.calls.logout, ["session-fixture"]);
});

void test("private authorizer requires nginx peer, contract operation, clean raw target and session", async (t) => {
  const f = fixture();
  const app = await makeApp(t, f);
  const headers = {
    "x-original-method": "GET",
    "x-original-uri": "/api/client-v1/orders/order-1",
    cookie: sessionCookie,
  };
  const authorized = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers,
  });
  assert.equal(authorized.statusCode, 204);
  assert.equal(authorized.headers["x-actor-context"], "signed.actor.context");
  assert.equal(
    authorized.headers["x-correlation-id"],
    f.calls.claims.correlationId,
  );
  assert.equal(f.calls.claims.sub, "actor:fixture");
  assert.equal(f.calls.claims.aud, "api-public");
  assert.equal(f.calls.claims.operationId, "getOrderCard");
  assert.deepEqual(f.calls.claims.permissions, ["orders:read"]);
  assert.equal(f.calls.claims.iat, NOW / 1_000);
  assert.equal(f.calls.claims.exp, (NOW + 60_000) / 1_000);

  const badPath = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers: { ...headers, "x-original-uri": "/api/%252e%252e/orders" },
  });
  assert.equal(badPath.statusCode, 403);
  assert.equal(f.calls.resolve.length, 1);

  let signerCalls = 0;
  const expired = fixture({
    session: {
      actorRef: "actor:fixture",
      permissions: ["orders:read"],
      csrf: "csrf-fixture",
      expiresAt: NOW,
    },
  });
  expired.adapters.signActorContext = () => {
    signerCalls += 1;
    return "signed.actor.context";
  };
  const expiredApp = await makeApp(t, expired);
  const expiredResult = await expiredApp.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers,
  });
  assert.equal(expiredResult.statusCode, 401);
  assert.equal(expiredResult.json().code, "AUTHENTICATION_REQUIRED");
  assert.equal(signerCalls, 0);
  assert.equal(expiredResult.headers["x-actor-context"], undefined);

  for (const sign of [
    () => "",
    () => {
      throw new Error("private signing key detail");
    },
  ]) {
    const failedSigning = fixture();
    failedSigning.adapters.signActorContext = sign;
    const failedSigningApp = await makeApp(t, failedSigning);
    const result = await failedSigningApp.inject({
      method: "GET",
      url: "/_edge/authorize",
      headers,
    });
    assert.equal(result.statusCode, 503);
    assert.equal(result.json().code, "AUTH_UNAVAILABLE");
    assert.equal(result.json().detail.includes("private"), false);
    assert.equal(result.headers["x-actor-context"], undefined);
    assert.equal(result.headers["cache-control"], "no-store");
  }
});

void test("authorization fails closed on peer, unknown operation, forged headers, duplicates and CSRF failures", async (t) => {
  const deniedPeer = fixture({ peer: false });
  const peerApp = await makeApp(t, deniedPeer);
  const base = {
    "x-original-method": "GET",
    "x-original-uri": "/api/client-v1/orders/order-1",
    cookie: sessionCookie,
  };
  assert.equal(
    (
      await peerApp.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers: base,
      })
    ).statusCode,
    401,
  );

  const unknown = fixture({ operation: null });
  const unknownApp = await makeApp(t, unknown);
  assert.equal(
    (
      await unknownApp.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers: base,
      })
    ).statusCode,
    403,
  );

  const forgedApp = await makeApp(t, fixture());
  assert.equal(
    (
      await forgedApp.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers: { ...base, "x-audience": "api-public" },
      })
    ).statusCode,
    403,
  );
  const duplicateApp = await makeApp(t, fixture());
  const duplicate = await rawRequest(duplicateApp);
  assert.equal(duplicate, 403);

  const mutation = fixture({
    operation: {
      operationId: "confirmOrder",
      audience: "api-public",
      requiredPermission: "orders:confirm",
    },
  });
  const mutationApp = await makeApp(t, mutation);
  const noCsrf = await mutationApp.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers: { ...base, "x-original-method": "POST" },
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(mutation.calls.claims, undefined);
});

void test("mutation authorization caps signed expiry at session expiry and requires the session permission", async (t) => {
  const f = fixture({
    operation: {
      operationId: "confirmOrder",
      audience: "api-public",
      requiredPermission: "orders:confirm",
    },
    session: {
      actorRef: "actor:fixture",
      permissions: ["orders:read"],
      csrf: "csrf-fixture",
      expiresAt: NOW + 30_000,
    },
  });
  const app = await makeApp(t, f);
  const denied = await app.inject({
    method: "GET",
    url: "/_edge/authorize",
    headers: {
      "x-original-method": "POST",
      "x-original-uri": "/api/client-v1/orders/order-1/commands/confirm",
      cookie: `${sessionCookie}; ${csrfCookie}`,
      origin: ORIGIN,
      "x-csrf-token": "csrf-fixture",
    },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(f.calls.claims, undefined);
});

void test("Edge enforces every accepted client-v1 permission from the contract map", async (t) => {
  const operations = [
    [
      "POST",
      "/api/client-v1/orders/drafts",
      "orders:create",
      "createOrderDraft",
    ],
    ["GET", "/api/client-v1/orders/order-1", "orders:read:any", "getOrderCard"],
    [
      "PUT",
      "/api/client-v1/orders/order-1/items/item-1",
      "orders:edit:any",
      "upsertOrderItem",
    ],
    [
      "DELETE",
      "/api/client-v1/orders/order-1/items/item-1",
      "orders:edit:any",
      "removeOrderItem",
    ],
    [
      "POST",
      "/api/client-v1/orders/order-1/commands/confirm",
      "orders:confirm:any",
      "confirmOrder",
    ],
    [
      "POST",
      "/api/client-v1/orders/order-1/commands/request-aroma-reconciliation",
      "orders:reconcile:any",
      "requestAromaReconciliation",
    ],
    [
      "POST",
      "/api/client-v1/pricing/quotes",
      "pricing:create",
      "createPricingQuote",
    ],
    [
      "POST",
      "/api/client-v1/pricing/catalog-preview",
      "catalog:read",
      "previewCatalogPrices",
    ],
  ];
  for (const [method, path, permission, operationId] of operations) {
    assert.deepEqual(resolveBrowserOperation(method, path), {
      operationId,
      audience: "api-public",
      requiredPermission: permission,
    });
    for (const permissions of [[], [permission]]) {
      const f = fixture({
        operation: undefined,
        session: {
          actorRef: "actor:fixture",
          permissions,
          csrf: "csrf-fixture",
          expiresAt: NOW + 120_000,
        },
      });
      f.adapters.resolveOperation = resolveBrowserOperation;
      const app = await makeApp(t, f);
      const headers = {
        "x-original-method": method,
        "x-original-uri": path,
        cookie: sessionCookie,
      };
      if (method !== "GET")
        Object.assign(headers, {
          cookie: `${sessionCookie}; ${csrfCookie}`,
          origin: ORIGIN,
          "x-csrf-token": "csrf-fixture",
        });
      const response = await app.inject({
        method: "GET",
        url: "/_edge/authorize",
        headers,
      });
      assert.equal(
        response.statusCode,
        permissions.length === 0 ? 403 : 204,
        `${operationId} with ${permissions.join(",")}`,
      );
      if (permissions.length === 0) assert.equal(f.calls.claims, undefined);
      else {
        assert.equal(f.calls.claims.operationId, operationId);
        assert.deepEqual(f.calls.claims.permissions, [permission]);
      }
    }
  }
});
