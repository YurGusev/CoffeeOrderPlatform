import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { createHttpClient } from "../../../packages/platform-http/src/index.ts";
import {
  parseServiceTransportMaterial,
  signActorContext,
  signServiceDelegation,
} from "../../../packages/platform-security/src/index.ts";

export const CUSTOMER_ORIGIN =
  process.env.CUSTOMER_SERVICE_ORIGIN ?? "https://127.0.0.1:4101";
export const CUSTOMER_DATABASE_URL =
  process.env.CUSTOMER_DATABASE_URL ?? process.env.COFFEE_CUSTOMER_DATABASE_URL;

async function testSigningKeys() {
  const path = process.env.CUSTOMER_TEST_SIGNING_KEY_FILE;
  if (!path) return undefined;
  const value = JSON.parse(await readFile(path, "utf8"));
  if (typeof value?.public !== "string" || typeof value?.internal !== "string")
    throw new Error("CUSTOMER_TEST_SIGNING_KEY_FILE is invalid");
  return {
    public: createPrivateKey(value.public),
    internal: createPrivateKey(value.internal),
  };
}

function delegation(service, path, method, correlationId) {
  if (service.signingKeys === undefined || service.dynamicAuth === false)
    return undefined;
  const iat = Math.floor(Date.now() / 1_000);
  const operationId = path.startsWith("/api/internal-v1/")
    ? "getCustomerOrderInput"
    : method === "GET"
      ? "searchCustomers"
      : "createCustomer";
  if (operationId === "getCustomerOrderInput") {
    return [
      "x-service-delegation",
      signServiceDelegation(
        {
          iss: "api-internal",
          aud: "customer-service",
          originalCaller: "orders-service",
          operationId,
          correlationId,
          traceparent:
            "00-00000000000000000000000000000000-0000000000000000-00",
          iat,
          exp: iat + 5,
          jti: randomUUID(),
          kid: "api-internal-delegation-v1",
        },
        service.signingKeys.internal,
      ),
    ];
  }
  return [
    "x-actor-context",
    signActorContext(
      {
        iss: "api-public",
        aud: "customer-service",
        originalIssuer: "edge-gateway",
        sub: service.actorRef ?? "actor_customer_test",
        permissions: [
          operationId === "createCustomer"
            ? "customer:create"
            : "customer:read",
        ],
        operationId,
        correlationId,
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + 6,
        jti: randomUUID(),
        kid: "api-public-delegation-v1",
      },
      service.signingKeys.public,
    ),
  ];
}

export async function signedTestHeaders(
  operationId = "createCustomer",
  actor = process.env.CUSTOMER_TEST_ACTOR_REF ?? "actor_customer_test",
) {
  const keys = await testSigningKeys();
  if (keys === undefined)
    throw new Error("CUSTOMER_TEST_SIGNING_KEY_FILE is missing");
  const iat = Math.floor(Date.now() / 1_000);
  return {
    "x-actor-context": signActorContext(
      {
        iss: "api-public",
        aud: "customer-service",
        originalIssuer: "edge-gateway",
        sub: actor,
        permissions: [
          operationId === "createCustomer"
            ? "customer:create"
            : "customer:read",
        ],
        operationId,
        correlationId: randomUUID(),
        traceparent: "00-00000000000000000000000000000000-0000000000000000-00",
        iat,
        exp: iat + 6,
        jti: randomUUID(),
        kid: "api-public-delegation-v1",
      },
      keys.public,
    ),
  };
}

export function blocker(testContext, message) {
  if (process.env.CUSTOMER_INTEGRATION_REQUIRED === "1")
    throw new Error(`BLOCKER: ${message}`);
  testContext.skip(`BLOCKER: ${message}`);
  return undefined;
}

function parseHeaders(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, String(entry)]),
  );
}

export async function liveService(
  testContext,
  headerEnv = "CUSTOMER_TEST_HEADERS_JSON",
  transportEnv = "CUSTOMER_TEST_CLIENT_TRANSPORT_FILE",
  clientRuntime = process.env.CUSTOMER_TEST_CLIENT_RUNTIME ?? "api-public",
) {
  const origin = new URL(CUSTOMER_ORIGIN);
  if (origin.protocol !== "https:") {
    return blocker(
      testContext,
      "customer-service must use HTTPS with mTLS; plaintext live origins are forbidden",
    );
  }
  const transportPath = process.env[transportEnv];
  if (!transportPath) {
    return blocker(
      testContext,
      `${transportEnv} is missing; a scoped mTLS client material fixture is required`,
    );
  }
  let material;
  try {
    material = parseServiceTransportMaterial(
      await readFile(transportPath, "utf8"),
      process.env.CUSTOMER_TEST_ENVIRONMENT ?? "development",
      clientRuntime,
    );
  } catch (error) {
    return blocker(
      testContext,
      `${transportEnv} is invalid (${error?.message ?? "transport validation failed"})`,
    );
  }
  const client = createHttpClient({
    origin: CUSTOMER_ORIGIN,
    tls: {
      material,
      targetEnvironment: process.env.CUSTOMER_TEST_ENVIRONMENT ?? "development",
      targetRuntime: "customer-service",
    },
  });
  testContext.after(async () => client.close());
  let health;
  try {
    health = await client.fetch("/health/ready");
  } catch (error) {
    return blocker(
      testContext,
      `customer-service is not reachable at configured origin (${error?.code ?? error?.message ?? "connection failed"})`,
    );
  }
  if (!health.ok)
    return blocker(
      testContext,
      `customer-service is not ready (${health.status})`,
    );
  const signingKeys = await testSigningKeys();
  const headers = parseHeaders(headerEnv);
  if (!headers && signingKeys === undefined)
    return blocker(
      testContext,
      `${headerEnv} is missing; a real signed trust-context fixture is required`,
    );
  return {
    origin: CUSTOMER_ORIGIN,
    headers: headers ?? {},
    client,
    material,
    environment: process.env.CUSTOMER_TEST_ENVIRONMENT ?? "development",
    clientRuntime,
    signingKeys,
    actorRef: process.env.CUSTOMER_TEST_ACTOR_REF,
  };
}

export async function liveDatabase(testContext, url = CUSTOMER_DATABASE_URL) {
  if (!url)
    return blocker(
      testContext,
      "CUSTOMER_DATABASE_URL is missing; live PostgreSQL is required",
    );
  const client = new Client(url);
  try {
    await client.connect();
  } catch (error) {
    return blocker(
      testContext,
      `live PostgreSQL is not available (${error?.code ?? error?.message ?? "connection failed"})`,
    );
  }
  testContext.after(async () => client.end());
  return client;
}

export async function jsonRequest(
  service,
  path,
  { method = "GET", body, headers = {}, signal } = {},
) {
  const requestHeaders = new Headers(service.headers);
  const correlationId = requestHeaders.get("x-correlation-id") ?? randomUUID();
  const generated = delegation(service, path, method, correlationId);
  if (
    generated !== undefined &&
    !Object.keys(headers).some((key) => key.toLowerCase() === generated[0])
  )
    requestHeaders.set(generated[0], generated[1]);
  for (const [key, value] of Object.entries(headers))
    requestHeaders.set(key, value);
  if (body !== undefined)
    requestHeaders.set("content-type", "application/json");
  const request = {
    method,
    headers: requestHeaders,
    signal,
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response =
    service.client === undefined
      ? await fetch(new URL(path, service.origin), request)
      : await service.client.fetch(path, request);
  const text = await response.text();
  let parsed;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { response, text, body: parsed };
}

export function customerPayload(seed, overrides = {}) {
  const digits = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 7)
    .split("")
    .map((digit) => Number.parseInt(digit, 16) % 10)
    .join("");
  return {
    displayName: `Customer ${seed}`,
    phone: `+7999${digits}`,
    email: `customer-${seed.toLowerCase()}@example.test`,
    ...overrides,
  };
}

export function idempotencyKey() {
  return randomUUID();
}

export function actorRef(service) {
  if (process.env.CUSTOMER_TEST_ACTOR_REF)
    return process.env.CUSTOMER_TEST_ACTOR_REF;
  const token =
    service &&
    Object.entries(service.headers).find(
      ([key]) => key.toLowerCase() === "x-actor-context",
    )?.[1];
  try {
    const claims = JSON.parse(
      Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"),
    );
    if (typeof claims.sub === "string" && claims.sub.length > 0)
      return claims.sub;
  } catch {
    // The service verifies the signed fixture; this decode only selects the assertion's owner row.
  }
  return "actor_customer_test";
}

export function customerScope() {
  return createHash("sha256")
    .update("POST\n/api/client-v1/customers", "utf8")
    .digest("hex");
}

export async function postCustomer(
  service,
  payload,
  key = idempotencyKey(),
  options = {},
) {
  return jsonRequest(service, "/api/client-v1/customers", {
    method: "POST",
    body: payload,
    signal: options.signal,
    headers: {
      "Idempotency-Key": key,
      "X-Correlation-ID": randomUUID(),
      ...options.headers,
    },
  });
}

export async function searchCustomers(
  service,
  query,
  { limit, cursor, headers } = {},
) {
  const params = new URLSearchParams({ query });
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor !== undefined) params.set("cursor", cursor);
  return jsonRequest(service, `/api/client-v1/customers?${params}`, {
    headers,
  });
}

export function assertProblem(assert, result, status, code) {
  assert.equal(result.response.status, status);
  assert.equal(result.body?.code, code);
  assert.equal(
    result.response.headers.get("content-type")?.split(";", 1)[0],
    "application/problem+json",
  );
}

export async function insertIdempotencyRecord(
  client,
  { actor = actorRef(), key, requestHash, leaseUntil = "future" },
) {
  await client.query(
    `INSERT INTO customer.idempotency_records
      (actor_ref, scope, idempotency_key, request_hash, state, lease_owner, lease_until, created_at, expires_at)
     VALUES ($1, $2, $3, $4, 'Acquired', $5, ${leaseUntil === "expired" ? "clock_timestamp() - interval '1 second'" : "clock_timestamp() + interval '30 seconds'"}, ${leaseUntil === "expired" ? "clock_timestamp() - interval '2 seconds'" : "clock_timestamp()"}, clock_timestamp() + interval '24 hours')`,
    [actor, customerScope(), key, requestHash, randomUUID()],
  );
}

export async function customerRow(client, customerRef) {
  const result = await client.query(
    `SELECT customer_ref, version, display_name, display_name_search, phone_e164, email_normalized,
            status, created_by_actor_ref, updated_by_actor_ref
       FROM customer.customers WHERE customer_ref = $1`,
    [customerRef],
  );
  return result.rows[0];
}

export async function countRows(client, table, column, value) {
  const allowed = new Set([
    "customers",
    "addresses",
    "audit_log",
    "idempotency_records",
  ]);
  if (!allowed.has(table)) throw new Error(`unsupported test table ${table}`);
  const result = await client.query(
    `SELECT count(*)::integer AS count FROM customer.${table} WHERE ${column} = $1`,
    [value],
  );
  return Number(result.rows[0].count);
}
