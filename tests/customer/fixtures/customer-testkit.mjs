import {createHash, randomUUID} from "node:crypto";
import {Client} from "pg";

export const CUSTOMER_ORIGIN = process.env.CUSTOMER_SERVICE_ORIGIN ?? "http://127.0.0.1:4101";
export const CUSTOMER_DATABASE_URL = process.env.CUSTOMER_DATABASE_URL ?? process.env.COFFEE_CUSTOMER_DATABASE_URL;

export function blocker(testContext, message) {
  if (process.env.CUSTOMER_INTEGRATION_REQUIRED === "1") throw new Error(`BLOCKER: ${message}`);
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
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export async function liveService(testContext, headerEnv = "CUSTOMER_TEST_HEADERS_JSON") {
  let health;
  try {
    health = await fetch(new URL("/health/ready", CUSTOMER_ORIGIN));
  } catch (error) {
    return blocker(testContext, `customer-service is not reachable at configured origin (${error?.code ?? error?.message ?? "connection failed"})`);
  }
  if (!health.ok) return blocker(testContext, `customer-service is not ready (${health.status})`);
  const headers = parseHeaders(headerEnv);
  if (!headers) return blocker(testContext, `${headerEnv} is missing; a real signed trust-context fixture is required`);
  return {origin: CUSTOMER_ORIGIN, headers};
}

export async function liveDatabase(testContext, url = CUSTOMER_DATABASE_URL) {
  if (!url) return blocker(testContext, "CUSTOMER_DATABASE_URL is missing; live PostgreSQL is required");
  const client = new Client(url);
  try {
    await client.connect();
  } catch (error) {
    return blocker(testContext, `live PostgreSQL is not available (${error?.code ?? error?.message ?? "connection failed"})`);
  }
  testContext.after(async () => client.end());
  return client;
}

export async function jsonRequest(service, path, {method = "GET", body, headers = {}, signal} = {}) {
  const requestHeaders = new Headers(service.headers);
  for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  const request = {
    method,
    headers: requestHeaders,
    signal,
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(new URL(path, service.origin), request);
  const text = await response.text();
  let parsed;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return {response, text, body: parsed};
}

export function customerPayload(seed, overrides = {}) {
  const digits = createHash("sha256").update(seed).digest("hex").slice(0, 7).split("").map((digit) => Number.parseInt(digit, 16) % 10).join("");
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
  if (process.env.CUSTOMER_TEST_ACTOR_REF) return process.env.CUSTOMER_TEST_ACTOR_REF;
  const token = service && Object.entries(service.headers).find(([key]) => key.toLowerCase() === "x-actor-context")?.[1];
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8"));
    if (typeof claims.sub === "string" && claims.sub.length > 0) return claims.sub;
  } catch {
    // The service verifies the signed fixture; this decode only selects the assertion's owner row.
  }
  return "actor_customer_test";
}

export function customerScope() {
  return createHash("sha256").update("POST\n/api/client-v1/customers", "utf8").digest("hex");
}

export async function postCustomer(service, payload, key = idempotencyKey(), options = {}) {
  return jsonRequest(service, "/api/client-v1/customers", {
    method: "POST",
    body: payload,
    signal: options.signal,
    headers: {
      "Idempotency-Key": key,
      "X-Correlation-ID": randomUUID(),
      ...(options.headers),
    },
  });
}

export async function searchCustomers(service, query, {limit, cursor, headers} = {}) {
  const params = new URLSearchParams({query});
  if (limit !== undefined) params.set("limit", String(limit));
  if (cursor !== undefined) params.set("cursor", cursor);
  return jsonRequest(service, `/api/client-v1/customers?${params}`, {headers});
}

export function assertProblem(assert, result, status, code) {
  assert.equal(result.response.status, status);
  assert.equal(result.body?.code, code);
  assert.equal(result.response.headers.get("content-type")?.split(";", 1)[0], "application/problem+json");
}

export async function insertIdempotencyRecord(client, {actor = actorRef(), key, requestHash, leaseUntil = "future"}) {
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
  const allowed = new Set(["customers", "addresses", "audit_log", "idempotency_records"]);
  if (!allowed.has(table)) throw new Error(`unsupported test table ${table}`);
  const result = await client.query(`SELECT count(*)::integer AS count FROM customer.${table} WHERE ${column} = $1`, [value]);
  return Number(result.rows[0].count);
}
