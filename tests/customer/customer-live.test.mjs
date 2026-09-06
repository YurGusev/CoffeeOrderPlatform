import assert from "node:assert/strict";
import {readFile, stat} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {request as httpsRequest} from "node:https";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {connect as tlsConnect} from "node:tls";
import {isIP} from "node:net";
import test from "node:test";
import {canonicalRequestHash} from "../../packages/platform-idempotency/dist/index.js";
import {parseServiceTransportMaterial, verifyTransportPeer} from "../../packages/platform-security/src/index.ts";
import {openBlackholeProxy} from "../../scripts/db-live-proof.mjs";
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
  signedTestHeaders,
  blocker,
} from "./fixtures/customer-testkit.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
            AND locks.classid::bigint = ((lock_key.value >> 32) & 4294967295)
            AND locks.objid::bigint = (lock_key.value & 4294967295)
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
            AND classid::bigint = ((lock_key.value >> 32) & 4294967295)
            AND objid::bigint = (lock_key.value & 4294967295)
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
  const owner = service.actorRef ?? actorRef(service);
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT state, resource_ref, response_status, response_body
         FROM customer.idempotency_records
        WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`,
      [owner, customerScope(), key],
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
  assert.equal(origin.protocol, "https:", "lost-response live proof requires an HTTPS origin");
  const body = JSON.stringify(payload);
  const dynamic = service.signingKeys === undefined ? {} : await signedTestHeaders("createCustomer", service.actorRef);
  const headers = new Map(Object.entries({...service.headers, ...dynamic}));
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
    const socket = tlsConnect({
      host: origin.hostname,
      port: Number(origin.port || 443),
      ...(isIP(origin.hostname) === 0 ? {servername: origin.hostname} : {}),
      ca: service.material.caPem,
      cert: service.material.certPem,
      key: service.material.keyPem,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      checkServerIdentity: (_hostname, certificate) => {
        try {
          verifyTransportPeer(certificate, service.environment, "customer-service");
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error("transport peer identity is invalid");
        }
      },
    });
    socket.once("error", (error) => reject(error));
    socket.once("secureConnect", () => socket.write(request, () => {
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
  return {...service, headers, dynamicAuth: false};
}

function parseHarnessHeaders(name) {
  let value;
  try {
    value = JSON.parse(process.env[name] ?? "");
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

async function unknownCommitHarnessOptions(t) {
  const required = [
    "CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE",
    "CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE",
    "CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL",
    "CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL",
    "CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_HOST",
    "CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE",
    "CUSTOMER_UNKNOWN_COMMIT_HEADERS_JSON",
    "CUSTOMER_UNKNOWN_COMMIT_ACTOR_REF",
    "CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN",
    "CUSTOMER_UNKNOWN_COMMIT_DB_ADAPTER_LOG_FILE",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    blocker(t, `unknown COMMIT/restart harness prerequisites are missing: ${missing.join(", ")}; provide the dedicated test network, scoped 0400 secrets and observer URL`);
    return undefined;
  }
  const origin = new URL(process.env.CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN);
  if (origin.protocol !== "https:") {
    blocker(t, "unknown COMMIT/restart harness requires an HTTPS Customer origin");
    return undefined;
  }
  const proxyPort = Number(process.env.CUSTOMER_UNKNOWN_COMMIT_PROXY_LISTEN_PORT ?? "5432");
  if (proxyPort !== 5432) {
    blocker(t, "unknown COMMIT/restart proxy must bind the canonical PostgreSQL port 5432; use a dedicated network alias instead of changing production config");
    return undefined;
  }
  const secretsStat = await stat(process.env.CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE).catch(() => undefined);
  if (secretsStat === undefined || (secretsStat.mode & 0o777) !== 0o400) {
    blocker(t, "CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE must be an existing scoped tmpfs file with mode 0400");
    return undefined;
  }
  let material;
  try {
    const environment = process.env.CUSTOMER_UNKNOWN_COMMIT_ENVIRONMENT ?? "development";
    const clientRuntime = process.env.CUSTOMER_UNKNOWN_COMMIT_CLIENT_RUNTIME ?? "api-public";
    material = parseServiceTransportMaterial(
      await readFile(process.env.CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE, "utf8"),
      environment,
      clientRuntime,
    );
  } catch (error) {
    blocker(t, `CUSTOMER_UNKNOWN_COMMIT_CLIENT_TRANSPORT_FILE is invalid (${error?.message ?? "transport validation failed"})`);
    return undefined;
  }
  return {
    configPath: process.env.CUSTOMER_UNKNOWN_COMMIT_CONFIG_FILE,
    secretsPath: process.env.CUSTOMER_UNKNOWN_COMMIT_SECRETS_FILE,
    databaseUrl: process.env.CUSTOMER_UNKNOWN_COMMIT_DATABASE_URL,
    targetHost: process.env.CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_HOST,
    targetPort: Number(process.env.CUSTOMER_UNKNOWN_COMMIT_DB_TARGET_PORT ?? "5432"),
    proxyHost: process.env.CUSTOMER_UNKNOWN_COMMIT_PROXY_LISTEN_HOST ?? "127.0.0.1",
    proxyPort,
    origin: process.env.CUSTOMER_UNKNOWN_COMMIT_SERVICE_ORIGIN,
    environment: process.env.CUSTOMER_UNKNOWN_COMMIT_ENVIRONMENT ?? "development",
    clientRuntime: process.env.CUSTOMER_UNKNOWN_COMMIT_CLIENT_RUNTIME ?? "api-public",
    material,
    headers: {...parseHarnessHeaders("CUSTOMER_UNKNOWN_COMMIT_HEADERS_JSON"), ...(process.env.CUSTOMER_TEST_SIGNING_KEY_FILE ? await signedTestHeaders() : {})},
    observerDatabaseUrl: process.env.CUSTOMER_UNKNOWN_COMMIT_OBSERVER_DATABASE_URL,
    actorRef: process.env.CUSTOMER_UNKNOWN_COMMIT_ACTOR_REF,
    dbAdapterLogPath: process.env.CUSTOMER_UNKNOWN_COMMIT_DB_ADAPTER_LOG_FILE,
    entry: process.env.CUSTOMER_UNKNOWN_COMMIT_ENTRY ?? `${REPOSITORY_ROOT}/apps/customer-service/dist/main.js`,
  };
}

async function harnessRequest(options, path, {method = "GET", headers = {}, body} = {}) {
  const target = new URL(path, options.origin);
  const dynamicAuth = process.env.CUSTOMER_TEST_SIGNING_KEY_FILE && method !== "GET";
  const dynamicHeaders = dynamicAuth
    ? await signedTestHeaders(method === "GET" ? "searchCustomers" : "createCustomer", options.actorRef)
    : {};
  const requestHeaders = {...(dynamicAuth ? {} : options.headers), ...dynamicHeaders, ...headers, connection: "close"};
  if (body !== undefined) {
    requestHeaders["content-type"] ??= "application/json";
    requestHeaders["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: target.hostname,
      port: Number(target.port || 443),
      path: `${target.pathname}${target.search}`,
      method,
      headers: requestHeaders,
      ca: options.material.caPem,
      cert: options.material.certPem,
      key: options.material.keyPem,
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      ...(isIP(target.hostname) === 0 ? {servername: target.hostname} : {}),
      timeout: 10_000,
      checkServerIdentity: (_hostname, certificate) => {
        try {
          verifyTransportPeer(certificate, options.environment, "customer-service");
          return undefined;
        } catch (error) {
          return error instanceof Error ? error : new Error("transport peer identity is invalid");
        }
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed;
        try { parsed = text.length === 0 ? undefined : JSON.parse(text); } catch { parsed = undefined; }
        resolve({response, status: response.statusCode, text, body: parsed});
      });
    });
    request.once("timeout", () => request.destroy(new Error("Customer harness HTTP request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

function spawnCustomerHarness(options) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COFFEE_") && !key.startsWith("SOPS_")));
  environment.COFFEE_CONFIG_FILE = options.configPath;
  environment.COFFEE_RUNTIME_SECRETS_FILE = options.secretsPath;
  environment.CUSTOMER_TEST_DB_ADAPTER_LOG_FILE = options.dbAdapterLogPath;
  const observer = fileURLToPath(new URL("./fixtures/db-adapter-command-observer.mjs", import.meta.url));
  environment.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--import=${observer}`].filter(Boolean).join(" ");
  const child = spawn(process.execPath, [options.entry], {cwd: REPOSITORY_ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"]});
  let output = "";
  const append = (chunk) => { output = `${output}${chunk}`.slice(-8_192); };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({code, signal})));
  return {child, exit, get output() { return output; }};
}

async function waitForHarnessLog(processHandle, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(processHandle.output)) return;
    await delay(25);
  }
  throw new Error(`Customer harness log did not contain ${pattern}: ${processHandle.output}`);
}

async function waitForFilePattern(path, pattern, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    content = await readFile(path, "utf8").catch(() => "");
    if (pattern.test(content)) return content;
    await delay(25);
  }
  throw new Error(`test log did not contain ${pattern}: ${content}`);
}

async function waitForHarnessReady(options, processHandle, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.child.exitCode !== null) throw new Error(`Customer harness exited before readiness: ${processHandle.child.exitCode} ${processHandle.output}`);
    try {
      const result = await harnessRequest(options, "/health/ready");
      if (result.status === 200) return;
      lastError = new Error(`health status ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Customer harness did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function stopHarnessProcess(processHandle) {
  if (processHandle === undefined) return;
  processHandle.child.kill("SIGTERM");
  await Promise.race([
    processHandle.exit,
    delay(5_000).then(() => {
      processHandle.child.kill("SIGKILL");
      throw new Error(`Customer harness did not stop: ${processHandle.output}`);
    }),
  ]);
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
  const internalService = await liveService(t, "CUSTOMER_TEST_INTERNAL_HEADERS_JSON", "CUSTOMER_TEST_INTERNAL_TRANSPORT_FILE", "api-internal");
  if (!internalService) return;
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
  const correlationId = randomUUID();
  const result = await postCustomer(service, {
    displayName: canaries[0],
    phone: "not-a-phone",
    email: canaries[1],
    address: {line1: canaries[2], city: canaries[3], countryCode: "RU"},
    token: canaries[4],
  }, randomUUID(), {headers: {"X-Correlation-ID": correlationId}});
  assert.equal(result.response.status, 400);
  await waitForFilePattern(logPath, new RegExp(`"reqId":"${correlationId}".*"msg":"request completed"`, "u"));
  for (const canary of canaries) assert.equal(result.text.includes(canary), false);

  await new Promise((resolve) => setImmediate(resolve));
  const logText = await readFile(logPath, "utf8");
  for (const canary of canaries) assert.equal(logText.includes(canary), false);
});

void test("Customer classifies an unacknowledged COMMIT and replays it after a real restart", async (t) => {
  const options = await unknownCommitHarnessOptions(t);
  if (!options) return;
  const observer = await liveDatabase(t, options.observerDatabaseUrl);
  if (!observer) return;
  const service = {origin: options.origin, headers: options.headers, actorRef: options.actorRef};
  const proxy = await openBlackholeProxy(options.targetPort, "COMMIT", {
    targetHost: options.targetHost,
    listenHost: options.proxyHost,
    listenPort: options.proxyPort,
    dropOnce: true,
  });
  let firstProcess;
  let restartedProcess;
  const payload = customerPayload(`unknown-commit-${randomUUID()}`, {
    address: {line1: "Unknown commit address", city: "Екатеринбург", countryCode: "RU"},
  });
  const key = randomUUID();
  try {
    firstProcess = spawnCustomerHarness(options);
    await waitForHarnessReady(options, firstProcess);
    const createRequest = harnessRequest(options, "/api/client-v1/customers", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        "x-correlation-id": randomUUID(),
      },
      body: JSON.stringify(payload),
    });
    await proxy.waitForCommand("COMMIT");
    const dropped = await proxy.waitForReplyDropped();
    assert.equal(dropped.tag, "COMMIT", "the harness must observe successful PostgreSQL CommandComplete(COMMIT)");
    proxy.closeConnections();
    const first = await createRequest;
    assert.equal(first.status, 503);
    assert.equal(first.body?.code, "CUSTOMER_UNAVAILABLE");
    assert.equal(first.text.includes("DB_QUERY_FAILED"), false);
    assert.equal(first.text.includes("TRANSACTION_OUTCOME_UNKNOWN"), false);
    await waitForHarnessLog(firstProcess, /customer\.transaction_outcome_unknown/u);
    assert.match(firstProcess.output, /TRANSACTION_OUTCOME_UNKNOWN/u);
    const adapterCommands = await waitForFilePattern(options.dbAdapterLogPath, /COMMIT/u);
    assert.doesNotMatch(adapterCommands, /ROLLBACK/u, `DB adapter attempted ROLLBACK: ${String(adapterCommands)}`);
    assert.equal(proxy.observed.includes("ROLLBACK"), false, `protocol log contained ROLLBACK: ${proxy.observed.join(",")}`);

    const completed = await waitForCompletedIdempotency(observer, service, key);
    assert.equal(completed.response_status, 201);
    assert.equal(completed.response_body.customerRef, completed.resource_ref);
    assert.equal(Number((await observer.query("SELECT count(*)::integer AS count FROM customer.customers WHERE email_normalized = $1", [payload.email])).rows[0].count), 1);
    assert.equal(Number((await observer.query("SELECT count(*)::integer AS count FROM customer.addresses WHERE customer_ref = $1", [completed.resource_ref])).rows[0].count), 1);
    assert.equal(Number((await observer.query("SELECT count(*)::integer AS count FROM customer.audit_log WHERE customer_ref = $1", [completed.resource_ref])).rows[0].count), 1);

    await stopHarnessProcess(firstProcess);
    firstProcess = undefined;
    restartedProcess = spawnCustomerHarness(options);
    await waitForHarnessReady(options, restartedProcess);
    // Six-second claims plus the runtime's five-second clock skew must both expire.
    if (process.env.CUSTOMER_TEST_SIGNING_KEY_FILE) await delay(12_000);
    const replay = await harnessRequest(options, "/api/client-v1/customers", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        "idempotency-replay-only": "true",
        "x-correlation-id": randomUUID(),
      },
    });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, completed.response_body);
    assert.equal(replay.response.headers["idempotency-replayed"], "true");
    assert.equal(replay.response.headers["cache-control"], "no-store");
    assert.equal(Number((await observer.query("SELECT count(*)::integer AS count FROM customer.customers WHERE email_normalized = $1", [payload.email])).rows[0].count), 1);
  } finally {
    await stopHarnessProcess(restartedProcess).catch(() => {});
    await stopHarnessProcess(firstProcess).catch(() => {});
    await proxy.close();
  }
});
