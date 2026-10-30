#!/usr/bin/env node

import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const customerRef = process.env.FIXTURE_CUSTOMER_REF ?? "";
const displayName = process.env.FIXTURE_DISPLAY_NAME ?? "";
const peerSan = process.env.FIXTURE_PEER_SAN ?? "";
const offerRef = process.env.FIXTURE_OFFER_REF ?? "";
const policyRef = process.env.FIXTURE_POLICY_REF ?? "";
const proof = "ab".repeat(32);

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const tls = {
  ca: readFileSync(required(process.env.FIXTURE_CA, "FIXTURE_CA")),
  cert: readFileSync(required(process.env.FIXTURE_CERT, "FIXTURE_CERT")),
  key: readFileSync(required(process.env.FIXTURE_KEY, "FIXTURE_KEY")),
  requestCert: true,
  rejectUnauthorized: true,
  minVersion: "TLSv1.3",
};

function peerMatches(request) {
  const san = request.socket.getPeerCertificate()?.subjectaltname ?? "";
  return san
    .split(",")
    .map((item) => item.trim())
    .includes(`URI:${peerSan}`);
}

function send(response, status, body, type) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        request.destroy();
        rejectBody(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectBody);
  });
}

function problem(response, status, code, instance, correlationId) {
  send(
    response,
    status,
    {
      type: "about:blank",
      title: code,
      status,
      code,
      detail: code,
      instance,
      correlationId,
      errors: [],
    },
    "application/problem+json",
  );
}

const server = createServer(tls, async (request, response) => {
  const path = request.url ?? "/";
  const correlationId = String(
    request.headers["x-correlation-id"] ?? "00000000-0000-4000-8000-000000000000",
  );
  try {
    if (!peerMatches(request)) {
      problem(response, 401, "SERVICE_AUTHENTICATION_REQUIRED", path, correlationId);
      process.stdout.write(`${request.method} ${path} 401\n`);
      return;
    }
    if (request.method === "GET" && path === "/health/ready") {
      send(response, 200, "ready", "text/plain");
      process.stdout.write("GET /health/ready 200\n");
      return;
    }
    const input = /^\/api\/internal-v1\/customers\/([^/]+)\/order-input$/u.exec(path);
    if (request.method === "GET" && input) {
      const ref = decodeURIComponent(input[1] ?? "");
      if (!request.headers["x-service-delegation"]) {
        problem(response, 401, "SERVICE_AUTHENTICATION_REQUIRED", path, correlationId);
        process.stdout.write(`GET order-input 401\n`);
        return;
      }
      if (ref !== customerRef) {
        problem(response, 404, "CUSTOMER_NOT_FOUND", path, correlationId);
        process.stdout.write("GET order-input 404\n");
        return;
      }
      send(
        response,
        200,
        {
          customerRef,
          customerVersion: "1",
          displayName,
          state: "Active",
        },
        "application/json",
      );
      process.stdout.write("GET order-input 200\n");
      return;
    }
    if (request.method === "POST" && path === "/api/internal-v1/pricing/quotes:verify") {
      const parsed = JSON.parse(await readBody(request));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      send(
        response,
        200,
        {
          valid: true,
          quoteRef: parsed.quoteRef,
          policyVersionRef: policyRef,
          catalogSnapshotRevision: "1",
          customerRef: parsed.customerRef,
          expiresAt,
          currency: "RUB",
          line: {
            lineNumber: parsed.quoteLineNumber,
            productRef: parsed.productRef,
            variantRef: parsed.variantRef,
            productDisplayName: displayName,
            offerRef,
            mappingRevision: "1",
            quantity: parsed.quantity,
            unit: "piece",
            supplierUnitMinor: "100",
            unitMinor: "150",
            lineTotalMinor: "150",
            currency: "RUB",
            internalProofHash: proof,
          },
        },
        "application/json",
      );
      process.stdout.write("POST quotes:verify 200\n");
      return;
    }
    send(response, 404, "missing", "text/plain");
    process.stdout.write(`${request.method} ${path} 404\n`);
  } catch {
    send(response, 500, "error", "text/plain");
    process.stdout.write(`${request.method} ${path} 500\n`);
  }
});

server.listen(4051, "0.0.0.0", () => {
  process.stdout.write("fixture listening\n");
});
