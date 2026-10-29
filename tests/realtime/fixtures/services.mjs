// Only synthetic provider/owner fixtures live here. Edge authorizer and SSE receiver
// are always the actual compiled product entrypoints, never fixture servers.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import https from "node:https";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import {
  createMutualTlsServerOptions,
  parseServiceTransportMaterial,
  verifyTransportPeer,
  verifyActorContextWithKeySet,
} from "../../../packages/platform-security/dist/index.js";

import { nowMs } from "./protocol.mjs";
const fixture = JSON.parse(await readFile("/fixture/fixture.json", "utf8"));
const kind = process.argv[2];
const send = (res, status, body, extra = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
};
const fail = (res, status, code, correlationId = randomUUID()) =>
  send(
    res,
    status,
    {
      type: "about:blank",
      title: code,
      status,
      code,
      detail: "Disposable synthetic fixture response.",
      instance: "/",
      correlationId,
      errors: [],
    },
    {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      "x-correlation-id": correlationId,
    },
  );
let server;
if (kind === "idp") {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...key.publicKey.export({ format: "jwk" }),
    kid: "issue12-idp",
    use: "sig",
    alg: "RS256",
  };
  const codes = new Map();
  const material = fixture.materials.idp;
  const jwt = (claims) => {
    const head = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid: jwk.kid }),
      ).toString("base64url"),
      body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
  };
  server = https.createServer(
    { key: material.keyPem, cert: material.certPem, minVersion: "TLSv1.3" },
    (req, res) => {
      void (async () => {
        const url = new URL(req.url, "https://idp.fixture.invalid");
        if (req.method === "GET" && url.pathname === "/health/live")
          return send(res, 200, { live: true });
        if (req.method === "GET" && url.pathname === "/keys")
          return send(res, 200, { keys: [jwk] });
        if (req.method === "GET" && url.pathname === "/authorize") {
          for (const [code, data] of codes)
            if (data.expires < nowMs()) codes.delete(code);
          assert.ok(codes.size < 1000);
          assert.equal(
            url.searchParams.get("client_id"),
            fixture.config.browserOidc.clientId,
          );
          assert.equal(
            url.searchParams.get("redirect_uri"),
            fixture.config.browserOidc.redirectUri,
          );
          assert.equal(url.searchParams.get("response_type"), "code");
          assert.equal(url.searchParams.get("code_challenge_method"), "S256");
          const nonce = url.searchParams.get("nonce"),
            state = url.searchParams.get("state"),
            challenge = url.searchParams.get("code_challenge");
          assert.ok(nonce && state && challenge);
          const code = randomUUID();
          codes.set(code, { nonce, challenge, expires: nowMs() + 60000 });
          const callback = new URL(fixture.config.browserOidc.redirectUri);
          callback.searchParams.set("code", code);
          callback.searchParams.set("state", state);
          res.writeHead(302, {
            location: callback.href,
            "cache-control": "no-store",
          });
          return res.end();
        }
        if (req.method === "POST" && url.pathname === "/token") {
          const chunks = [];
          let bytes = 0;
          for await (const c of req) {
            bytes += c.length;
            assert.ok(bytes <= 8192);
            chunks.push(c);
          }
          const p = new URLSearchParams(Buffer.concat(chunks).toString());
          const pending = codes.get(p.get("code"));
          codes.delete(p.get("code"));
          assert.ok(
            pending && pending.expires > nowMs(),
            "unknown/expired/single-use code",
          );
          assert.equal(p.get("grant_type"), "authorization_code");
          assert.equal(p.get("client_id"), fixture.config.browserOidc.clientId);
          assert.equal(
            p.get("redirect_uri"),
            fixture.config.browserOidc.redirectUri,
          );
          assert.equal(
            createHash("sha256")
              .update(p.get("code_verifier") ?? "")
              .digest("base64url"),
            pending.challenge,
          );
          const now = Math.floor(nowMs() / 1000);
          return send(res, 200, {
            id_token: jwt({
              iss: fixture.config.browserOidc.issuer,
              aud: fixture.config.browserOidc.clientId,
              sub: "synthetic-provider-subject",
              actor_ref: "actor:issue12-transport",
              permissions: ["orders:read:any", "orders:reconcile:any"],
              nonce: pending.nonce,
              iat: now,
              exp: now + 3600,
            }),
          });
        }
        return fail(res, 404, "FIXTURE_ROUTE_NOT_FOUND");
      })().catch(() => {
        if (!res.headersSent) fail(res, 400, "FIXTURE_REQUEST_REJECTED");
        else res.destroy();
      });
    },
  );
  server.listen(443, "0.0.0.0");
} else if (kind === "orders") {
  const material = parseServiceTransportMaterial(
    JSON.stringify(fixture.materials["orders-service"]),
    fixture.config.environment,
    "orders-service",
  );
  const keys = Object.values(fixture.apiKeys).map((k) => createPublicKey(k));
  server = https.createServer(
    createMutualTlsServerOptions(material),
    (req, res) => {
      try {
        const peer = verifyTransportPeer(
          req.socket.getPeerCertificate(),
          fixture.config.environment,
        );
        assert.equal(peer.runtime, "api-public");
        const token = req.headers["x-actor-context"];
        assert.equal(typeof token, "string");
        const actor = verifyActorContextWithKeySet(token, {
          publicKeys: keys,
          issuer: "api-public",
          audience: "orders-service",
          nowEpochSeconds: Math.floor(nowMs() / 1000),
          clockSkewSeconds: 5,
        });
        assert.equal(actor.originalIssuer, "edge-gateway");
        assert.equal(actor.operationId, "getOrderCard");
        assert.ok(actor.permissions.includes("orders:read:any"));
        assert.equal(actor.correlationId, req.headers["x-correlation-id"]);
        assert.equal(req.method, "GET");
        assert.match(
          req.url,
          /^\/api\/client-v1\/orders\/ord_[0-9A-HJKMNP-TV-Z]{26}$/u,
        );
        return fail(res, 404, "ORDER_NOT_FOUND", actor.correlationId);
      } catch {
        return fail(res, 403, "ACTOR_CONTEXT_INVALID");
      }
    },
  );
  server.listen(4104, "0.0.0.0");
} else throw new Error(`unknown fixture role: ${kind}`);
server.on("error", (e) => {
  console.error(e.code ?? "FIXTURE_SERVER_FAILED");
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
