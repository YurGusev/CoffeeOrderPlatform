import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {createConnection} from "node:net";
import test from "node:test";
import {canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {
  actorRef,
  assertProblem,
  countRows,
  customerPayload,
  customerRow,
  customerScope,
  insertIdempotencyRecord,
  jsonRequest,
  liveDatabase,
  liveService,
  postCustomer,
  searchCustomers,
  blocker,
} from "./fixtures/customer-testkit.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdvisoryBarrier(client, barrierName, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.query(
      `WITH lock_key AS (SELECT hashtextextended($1, 0)::bigint AS value)
         SELECT locks.pid, locks.virtualtransaction, activity.backend_start
           FROM pg_locks AS locks
           JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
           CROSS JOIN lock_key
          WHERE locks.locktype = 'advisory' AND locks.granted = false AND locks.pid <> pg_backend_pid()
            AND locks.classid = (lock_key.value >> 32)::oid
            AND locks.objid = (lock_key.value & 4294967295)::oid
          LIMIT 1`,
      [barrierName],
    );
    if (result.rowCount === 1) return result.rows[0];
    await delay(25);
  }
  throw new Error("customer DB barrier was not reached");
}

async function waitForAdvisoryTransactionEnd(client, barrierName, waiter, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await client.query(
      `WITH lock_key AS (SELECT hashtextextended($1, 0)::bigint AS value)
         SELECT granted
           FROM pg_locks, lock_key
          WHERE pid = $2 AND virtualtransaction = $3 AND locktype = 'advisory'
            AND classid = (lock_key.value >> 32)::oid
            AND objid = (lock_key.value & 4294967295)::oid
          LIMIT 1`,
      [barrierName, waiter.pid, waiter.virtualtransaction],
    );
    const activity = await client.query(
      "SELECT backend_start, xact_start FROM pg_stat_activity WHERE pid = $1",
      [waiter.pid],
    );
    if (activity.rows[0] === undefined) return;
    const sameBackend = String(activity.rows[0].backend_start) === String(waiter.backend_start);
    if (!sameBackend || (lock.rowCount === 0 && activity.rows[0].xact_start === null)) return;
    await delay(25);
  }
  throw new Error("aborted customer transaction did not finish after barrier release");
}

async function waitForCompletedIdempotency(client, service, key, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT state, response_status, response_body
         FROM customer.idempotency_records
        WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`,
      [actorRef(service), customerScope(), key],
    );
    const row = result.rows[0];
    if (row?.state === "Completed") return row;
    await delay(25);
  }
  throw new Error("customer idempotency record did not reach Completed");
}

async function waitForNoCustomer(client, service, payload, key, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT count(*)::integer AS count
         FROM customer.idempotency_records
        WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`,
      [actorRef(service), customerScope(), key],
    );
    const customer = await client.query(
      "SELECT count(*)::integer AS count FROM customer.customers WHERE email_normalized = $1",
      [payload.email],
    );
    const related = await client.query(
      `SELECT
         (SELECT count(*) FROM customer.addresses WHERE customer_ref IN (SELECT customer_ref FROM customer.customers WHERE email_normalized = $1))::integer AS addresses,
         (SELECT count(*) FROM customer.audit_log WHERE customer_ref IN (SELECT customer_ref FROM customer.customers WHERE email_normalized = $1))::integer AS audits`,
      [payload.email],
    );
    if (Number(result.rows[0].count) === 0 && Number(customer.rows[0].count) === 0 &&
        Number(related.rows[0].addresses) === 0 && Number(related.rows[0].audits) === 0) return;
    await delay(25);
  }
  throw new Error("aborted customer transaction did not roll back");
}

async function withInsertBarrier(migrator, {table, predicate, deferred = false, timing = "BEFORE"}, callback) {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `customer_test_barrier_${suffix}`;
  const triggerName = `${functionName}_trigger`;
  const barrierName = `customer-test-barrier-${suffix}`;
  await migrator.query(`CREATE FUNCTION customer.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $barrier$
    BEGIN
      IF NOT (${predicate}) THEN
        RETURN NEW;
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended('${barrierName}', 0));
      RETURN NEW;
    END;
  $barrier$`);
  await migrator.query(deferred
    ? `CREATE CONSTRAINT TRIGGER ${triggerName} AFTER INSERT ON ${table}
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
         EXECUTE FUNCTION customer.${functionName}()`
    : `CREATE TRIGGER ${triggerName} ${timing} INSERT ON ${table}
         FOR EACH ROW EXECUTE FUNCTION customer.${functionName}()`);
  await migrator.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [barrierName]);
  try {
    return await callback({
      barrierName,
      release: () => migrator.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [barrierName]),
    });
  } finally {
    await migrator.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [barrierName]).catch(() => {});
    await migrator.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`).catch(() => {});
    await migrator.query(`DROP FUNCTION IF EXISTS customer.${functionName}()`).catch(() => {});
  }
}

async function withFaultTrigger(migrator, {table, event, predicate}, callback) {
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `customer_test_fault_${suffix}`;
  const triggerName = `${functionName}_trigger`;
  await migrator.query(`CREATE FUNCTION customer.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fault$
    BEGIN
      RAISE EXCEPTION 'customer test fault';
    END;
  $fault$`);
  await migrator.query(`CREATE TRIGGER ${triggerName} ${event} ON ${table}
    FOR EACH ROW WHEN (${predicate}) EXECUTE FUNCTION customer.${functionName}()`);
  try {
    return await callback();
  } finally {
    await migrator.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`).catch(() => {});
    await migrator.query(`DROP FUNCTION IF EXISTS customer.${functionName}()`).catch(() => {});
  }
}

async function openLostResponseRequest(service, payload, key, correlationId) {
  const origin = new URL(service.origin);
  assert.equal(origin.protocol, "http:", "lost-response live proof requires an HTTP origin");
  const body = JSON.stringify(payload);
  const headers = new Map(Object.entries(service.headers));
  headers.set("Idempotency-Key", key);
  headers.set("X-Correlation-ID", correlationId);
  headers.set("Content-Type", "application/json");
  headers.set("Content-Length", String(Buffer.byteLength(body)));
  headers.set("Connection", "close");
  const request = [
    "POST /api/client-v1/customers HTTP/1.1",
    `Host: ${origin.host}`,
    ...[...headers].map(([name, value]) => `${name}: ${value}`),
    "",
    body,
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = createConnection({host: origin.hostname, port: Number(origin.port || 80)});
    socket.once("error", (error) => reject(error));
    socket.once("connect", () => socket.write(request, () => {
      socket.pause();
      resolve(socket);
    }));
  });
}

function assertTimestamp(value) {
  assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/);
}

function actorHeader(service) {
  return process.env.CUSTOMER_TEST_ACTOR_HEADER ??
    Object.keys(service.headers).find((key) => key.toLowerCase() === "x-actor-context") ??
    "x-actor-context";
}

function scopedHeaders(service, headers = {}) {
  return {...service, headers};
}

void test("Customer create is atomic and exact replay is byte-identical", async (t) => {
  const service = await liveService(t);
  const client = await liveDatabase(t);
  if (!service || !client) return;

  const seed = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = customerPayload(seed, {
    displayName: `  Иван\u00a0\t Петров  `,
    address: {line1: "  ул. Тестовая 1 ", line2: " ", city: " Екатеринбург ", postalCode: " ", countryCode: "RU"},
  });
  const key = randomUUID();
  const first = await postCustomer(service, payload, key);
  assert.equal(first.response.status, 201);
  assert.equal(first.body.version, "1");
  assert.match(first.body.customerRef, /^cus_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(first.body.displayName, "Иван Петров");
  assert.equal(first.body.phone, payload.phone);
  assert.equal(first.body.email, payload.email.toLowerCase());
  assert.match(first.body.address.addressRef, /^adr_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(Object.hasOwn(first.body.address, "line2"), false);
  assert.equal(Object.hasOwn(first.body.address, "postalCode"), false);
  assert.equal(first.body.address.countryCode, "RU");
  assertTimestamp(first.body.createdAt);
  assertTimestamp(first.body.updatedAt);

  const row = await customerRow(client, first.body.customerRef);
  assert.ok(row);
  assert.equal(row.version, "1");
  assert.equal(row.display_name, "Иван Петров");
  assert.equal(row.display_name_search, "иван петров");
  assert.equal(row.phone_e164, payload.phone);
  assert.equal(row.email_normalized, payload.email.toLowerCase());
  assert.equal(row.status, "Active");
  assert.ok(row.created_by_actor_ref);
  if (process.env.CUSTOMER_TEST_ACTOR_REF) assert.equal(row.created_by_actor_ref, actorRef(service));
  assert.equal(await countRows(client, "addresses", "customer_ref", first.body.customerRef), 1);
  assert.equal(await countRows(client, "audit_log", "customer_ref", first.body.customerRef), 1);
  const idempotency = await client.query(
    "SELECT state, request_hash, resource_ref, response_status, response_body FROM customer.idempotency_records WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3",
    [actorRef(service), customerScope(), key],
  );
  assert.equal(idempotency.rowCount, 1);
  assert.equal(idempotency.rows[0].state, "Completed");
  assert.equal(idempotency.rows[0].resource_ref, first.body.customerRef);
  assert.equal(idempotency.rows[0].response_status, 201);
  assert.deepEqual(idempotency.rows[0].response_body, first.body);

  const replay = await postCustomer(service, payload, key);
  assert.equal(replay.response.status, 201);
  assert.equal(replay.text, first.text);
  assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
  const lookup = await jsonRequest(service, "/api/client-v1/customers", {
    method: "POST",
    headers: {"Idempotency-Key": key, "Idempotency-Replay-Only": "true"},
  });
  assert.equal(lookup.response.status, 201);
  assert.equal(lookup.text, first.text);
  assert.equal(lookup.response.headers.get("idempotency-replayed"), "true");
  assert.equal(await countRows(client, "customers", "customer_ref", first.body.customerRef), 1);
  assert.equal(await countRows(client, "addresses", "customer_ref", first.body.customerRef), 1);
  assert.equal(await countRows(client, "audit_log", "customer_ref", first.body.customerRef), 1);
});

void test("A PostgreSQL fault after every required Customer write rolls back the aggregate and idempotency", async (t) => {
  const service = await liveService(t);
  const client = await liveDatabase(t);
  const migrator = await liveDatabase(t, process.env.CUSTOMER_MIGRATOR_DATABASE_URL);
  if (!service || !client || !migrator) return;

  for (const stage of ["acquire", "customer", "address", "audit", "complete"]) {
    const suffix = `${stage}-${randomUUID().replaceAll("-", "")}`;
    const line1 = `Fault address ${suffix}`;
    const payload = customerPayload(`fault-${suffix}`, {address: {line1, city: "Fault city", countryCode: "RU"}});
    const key = randomUUID();
    const correlationId = randomUUID();
    const trigger = stage === "acquire"
      ? {table: "customer.idempotency_records", event: "AFTER INSERT", predicate: `NEW.idempotency_key = '${key}'::uuid`}
      : stage === "customer"
        ? {table: "customer.customers", event: "AFTER INSERT", predicate: `NEW.email_normalized = '${payload.email}'`}
        : stage === "address"
          ? {table: "customer.addresses", event: "AFTER INSERT", predicate: `NEW.line1 = '${line1}'`}
          : stage === "audit"
            ? {table: "customer.audit_log", event: "AFTER INSERT", predicate: `NEW.correlation_id = '${correlationId}'::uuid`}
            : {table: "customer.idempotency_records", event: "AFTER UPDATE OF state", predicate: `NEW.idempotency_key = '${key}'::uuid AND NEW.state = 'Completed'`};
    await withFaultTrigger(migrator, trigger, async () => {
      const failed = await postCustomer(service, payload, key, {headers: {"X-Correlation-ID": correlationId}});
      assertProblem(assert, failed, 503, "CUSTOMER_UNAVAILABLE");
      const customer = await client.query("SELECT count(*)::integer AS count FROM customer.customers WHERE email_normalized = $1", [payload.email]);
      assert.equal(Number(customer.rows[0].count), 0, stage);
      const address = await client.query("SELECT count(*)::integer AS count FROM customer.addresses WHERE line1 = $1", [line1]);
      assert.equal(Number(address.rows[0].count), 0, stage);
      const audit = await client.query("SELECT count(*)::integer AS count FROM customer.audit_log WHERE correlation_id = $1", [correlationId]);
      assert.equal(Number(audit.rows[0].count), 0, stage);
      const idempotency = await client.query("SELECT count(*)::integer AS count FROM customer.idempotency_records WHERE idempotency_key = $1", [key]);
      assert.equal(Number(idempotency.rows[0].count), 0, stage);
    });
  }
});

void test("Customer idempotency rejects a changed body and keeps an expired lease in progress", async (t) => {
  const service = await liveService(t);
  const client = await liveDatabase(t);
  if (!service || !client) return;

  const seed = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const payload = customerPayload(seed);
  const key = randomUUID();
  const created = await postCustomer(service, payload, key);
  assert.equal(created.response.status, 201);
  const changed = await postCustomer(service, {...payload, displayName: `${payload.displayName} changed`}, key);
  assertProblem(assert, changed, 409, "IDEMPOTENCY_CONFLICT");

  const inProgressKey = randomUUID();
  const normalizedHash = canonicalRequestHash(payload);
  await insertIdempotencyRecord(client, {actor: actorRef(service), key: inProgressKey, requestHash: normalizedHash, leaseUntil: "expired"});
  const inProgress = await postCustomer(service, payload, inProgressKey);
  assertProblem(assert, inProgress, 409, "IDEMPOTENCY_REQUEST_IN_PROGRESS");
});

void test("Concurrent phone and email ownership is decided by PostgreSQL unique constraints", async (t) => {
  const service = await liveService(t);
  if (!service) return;
  const seed = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const phone = customerPayload(`${seed}-phone`).phone;
  const phoneResults = await Promise.all([
    postCustomer(service, customerPayload(`${seed}-phone-a`, {phone}), randomUUID()),
    postCustomer(service, customerPayload(`${seed}-phone-b`, {phone}), randomUUID()),
  ]);
  assert.deepEqual(phoneResults.map((result) => result.response.status).sort((left, right) => left - right), [201, 409]);
  assert.equal(phoneResults.find((result) => result.response.status === 409).body.code, "CUSTOMER_PHONE_CONFLICT");

  const email = customerPayload(`${seed}-email`).email;
  const emailResults = await Promise.all([
    postCustomer(service, customerPayload(`${seed}-email-a`, {email}), randomUUID()),
    postCustomer(service, customerPayload(`${seed}-email-b`, {email}), randomUUID()),
  ]);
  assert.deepEqual(emailResults.map((result) => result.response.status).sort((left, right) => left - right), [201, 409]);
  assert.equal(emailResults.find((result) => result.response.status === 409).body.code, "CUSTOMER_EMAIL_CONFLICT");
});

void test("Customer search uses exact contact modes, escaped prefix and cursor pagination", async (t) => {
  const service = await liveService(t);
  if (!service) return;
  const suffix = randomUUID().slice(0, 8);
  const prefix = `zz-${suffix}`;
  const created = [];
  for (const letter of ["A", "B", "C"]) {
    const result = await postCustomer(service, customerPayload(`${suffix}-${letter}`, {displayName: `${prefix} ${letter}`}));
    assert.equal(result.response.status, 201);
    created.push(result.body);
  }

  const first = await searchCustomers(service, prefix, {limit: 2});
  assert.equal(first.response.status, 200);
  assert.equal(first.body.items.length, 2);
  assert.ok(first.body.nextCursor);
  assert.ok(first.body.items.every((item) => /^\+7\*{6}\d{4}$/.test(item.phone)));
  assert.ok(first.body.items.every((item) => /^[^@]\*+@example\.test$/.test(item.email)));

  const second = await searchCustomers(service, prefix, {limit: 2, cursor: first.body.nextCursor});
  assert.equal(second.response.status, 200);
  assert.equal(second.body.items.length, 1);
  const ids = [...first.body.items, ...second.body.items].map((item) => item.customerRef);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(ids, [...ids].sort((left, right) => {
    const a = [...first.body.items, ...second.body.items].find((item) => item.customerRef === left);
    const b = [...first.body.items, ...second.body.items].find((item) => item.customerRef === right);
    return `${a.displayName}\u0000${a.customerRef}`.localeCompare(`${b.displayName}\u0000${b.customerRef}`);
  }));
  assert.deepEqual(new Set(created.map((item) => item.customerRef)), new Set(ids));

  const crossQuery = await searchCustomers(service, `${prefix}-different`, {limit: 2, cursor: first.body.nextCursor});
  assertProblem(assert, crossQuery, 400, "INVALID_CURSOR");
  const corrupted = await searchCustomers(service, prefix, {limit: 2, cursor: `${first.body.nextCursor.slice(0, -1)}!`});
  assertProblem(assert, corrupted, 400, "INVALID_CURSOR");

  const wildcardPrefix = `wild-${suffix}`;
  const literal = await postCustomer(service, customerPayload(`${suffix}-literal`, {displayName: `${wildcardPrefix}%literal`}));
  const wildcard = await postCustomer(service, customerPayload(`${suffix}-wildcard`, {displayName: `${wildcardPrefix}Xliteral`}));
  assert.equal(literal.response.status, 201);
  assert.equal(wildcard.response.status, 201);
  const escaped = await searchCustomers(service, `${wildcardPrefix}%`, {limit: 50});
  assert.equal(escaped.response.status, 200);
  assert.deepEqual(escaped.body.items.map((item) => item.customerRef), [literal.body.customerRef]);

  const byPhone = await searchCustomers(service, created[0].phone, {limit: 50});
  assert.equal(byPhone.response.status, 200);
  assert.deepEqual(byPhone.body.items.map((item) => item.customerRef), [created[0].customerRef]);
  const byEmail = await searchCustomers(service, created[0].email, {limit: 50});
  assert.equal(byEmail.response.status, 200);
  assert.deepEqual(byEmail.body.items.map((item) => item.customerRef), [created[0].customerRef]);
});

void test("Customer private order snapshot is minimal and service-authorized", async (t) => {
  const publicService = await liveService(t);
  if (!publicService) return;
  const internalHeadersRaw = process.env.CUSTOMER_TEST_INTERNAL_HEADERS_JSON;
  if (!internalHeadersRaw) {
    blocker(t, "CUSTOMER_TEST_INTERNAL_HEADERS_JSON is missing; signed Orders delegation is required");
    return;
  }
  let internalHeaders;
  try {
    internalHeaders = JSON.parse(internalHeadersRaw);
  } catch {
    throw new Error("CUSTOMER_TEST_INTERNAL_HEADERS_JSON must be valid JSON");
  }
  const internalService = scopedHeaders(publicService, internalHeaders);
  const payload = customerPayload(`${Date.now()}-${randomUUID().slice(0, 8)}`);
  const created = await postCustomer(publicService, payload);
  assert.equal(created.response.status, 201);
  const result = await jsonRequest(internalService, `/api/internal-v1/customers/${created.body.customerRef}/order-input`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    customerRef: created.body.customerRef,
    customerVersion: "1",
    displayName: created.body.displayName,
    state: "Active",
  });
  assert.equal(Object.hasOwn(result.body, "phone"), false);
  assert.equal(Object.hasOwn(result.body, "email"), false);
  assert.equal(Object.hasOwn(result.body, "address"), false);

  const browserAttempt = await jsonRequest(publicService, `/api/internal-v1/customers/${created.body.customerRef}/order-input`);
  assert.equal(browserAttempt.response.status, 401);
  assert.equal(browserAttempt.body.code, "SERVICE_AUTHENTICATION_REQUIRED");
});

void test("Customer lost response after durable DB commit is recovered by same-key bodyless replay", async (t) => {
  const service = await liveService(t);
  const client = await liveDatabase(t);
  const migrator = await liveDatabase(t, process.env.CUSTOMER_MIGRATOR_DATABASE_URL);
  if (!service || !client || !migrator) return;

  const payload = customerPayload(`lost-response-${randomUUID()}`);
  const key = randomUUID();
  const correlationId = randomUUID();
  await withInsertBarrier(
    migrator,
    {table: "customer.audit_log", predicate: `NEW.correlation_id = '${correlationId}'::uuid`, deferred: true},
    async ({barrierName, release}) => {
      const socket = await openLostResponseRequest(service, payload, key, correlationId);
      await waitForAdvisoryBarrier(migrator, barrierName);
      socket.destroy();
      await release();
      const stored = await waitForCompletedIdempotency(client, service, key);

      const replay = await jsonRequest(service, "/api/client-v1/customers", {
        method: "POST",
        headers: {"Idempotency-Key": key, "Idempotency-Replay-Only": "true", "X-Correlation-ID": randomUUID()},
      });
      assert.equal(replay.response.status, 201);
      assert.equal(replay.response.headers.get("idempotency-replayed"), "true");
      assert.deepEqual(replay.body, stored.response_body);
      assert.equal(await countRows(client, "customers", "email_normalized", payload.email), 1);
    },
  );
});

void test("Customer abort after DB work starts rolls back and releases the service pool", async (t) => {
  const service = await liveService(t);
  const client = await liveDatabase(t);
  const migrator = await liveDatabase(t, process.env.CUSTOMER_MIGRATOR_DATABASE_URL);
  if (!service || !client || !migrator) return;

  const payload = customerPayload(`abort-${randomUUID()}`);
  const key = randomUUID();
  await withInsertBarrier(
    migrator,
    {table: "customer.customers", predicate: `NEW.email_normalized = '${payload.email}'`, timing: "AFTER"},
    async ({barrierName, release}) => {
      const controller = new AbortController();
      const request = postCustomer(service, payload, key, {signal: controller.signal});
      const waiter = await waitForAdvisoryBarrier(migrator, barrierName);
      controller.abort(new DOMException("customer DB timeout", "TimeoutError"));
      await assert.rejects(request, (error) => error?.name === "AbortError" || error?.name === "TimeoutError");
      await release();
      await waitForAdvisoryTransactionEnd(migrator, barrierName, waiter);
      await waitForNoCustomer(client, service, payload, key);
    },
  );

  const recovered = await postCustomer(service, customerPayload(`pool-release-${randomUUID()}`));
  assert.equal(recovered.response.status, 201);
});

void test("Customer rejects missing, forged and spoofed actor context, and honors abort", async (t) => {
  const service = await liveService(t);
  if (!service) return;
  const payload = customerPayload(`${Date.now()}-${randomUUID().slice(0, 8)}`);
  const missing = await postCustomer(scopedHeaders(service, {}), payload);
  assertProblem(assert, missing, 401, "AUTHENTICATION_REQUIRED");
  const forged = await postCustomer(scopedHeaders(service, {[actorHeader(service)]: "forged.actor.context"}), customerPayload(`${Date.now()}-${randomUUID().slice(0, 8)}`));
  assertProblem(assert, forged, 403, "ACTOR_CONTEXT_INVALID");

  const spoofed = await postCustomer(service, customerPayload(`${Date.now()}-${randomUUID().slice(0, 8)}`), randomUUID(), {
    headers: {"X-Actor-Ref": "spoofed-actor", "X-Actor-Permissions": "customer:admin"},
  });
  assertProblem(assert, spoofed, 403, "ACTOR_CONTEXT_INVALID");

  const controller = new AbortController();
  controller.abort(new Error("test cancellation"));
  await assert.rejects(
    postCustomer(service, customerPayload(`${Date.now()}-${randomUUID().slice(0, 8)}`), randomUUID(), {signal: controller.signal}),
    (error) => error?.name === "Error" || error?.name === "AbortError",
  );
});

void test("Customer problem details and configured logs do not contain PII canaries", async (t) => {
  const logPath = process.env.CUSTOMER_TEST_LOG_FILE;
  if (!logPath) {
    blocker(t, "CUSTOMER_TEST_LOG_FILE is missing; PII log proof requires the real service log file");
    return;
  }
  const service = await liveService(t);
  if (!service) return;
  const canaries = ["pii-phone-79991230001", "pii@example.test", "pii-address-unique", "pii-password", "pii-token", randomUUID()];
  const result = await postCustomer(service, {
    displayName: canaries[0],
    phone: "not-a-phone",
    email: canaries[1],
    address: {line1: canaries[2], city: canaries[3], countryCode: "RU"},
    token: canaries[4],
  });
  assert.equal(result.response.status, 400);
  for (const canary of canaries) assert.equal(result.text.includes(canary), false);

  await new Promise((resolve) => setImmediate(resolve));
  const logText = await readFile(logPath, "utf8");
  for (const canary of canaries) assert.equal(logText.includes(canary), false);
});
