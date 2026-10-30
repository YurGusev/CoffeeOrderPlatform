// Only synthetic provider/owner fixtures live here. Edge authorizer and SSE receiver
// are always the actual compiled product entrypoints, never fixture servers.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createMutualTlsServerOptions,
  parseServiceTransportMaterial,
  verifyTransportPeer,
  verifyActorContextWithKeySet,
} from "../../../packages/platform-security/dist/index.js";

import { nowMs } from "./protocol.mjs";
import { createOidcProviderServer } from "./oidc-provider.mjs";
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
    kid: "realtime-idp",
    use: "sig",
    alg: "RS256",
  };
  const material = fixture.materials.idp;
  server = createOidcProviderServer({
    tlsKeyPem: material.keyPem,
    tlsCertificatePem: material.certPem,
    profile: fixture.config.browserOidc,
    signingKey: key.privateKey,
    jwk,
    actorRef: "actor:realtime-transport",
    permissions: ["orders:read:any", "orders:reconcile:any"],
    onFail: (res, status, code) => fail(res, status, code),
  });
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
