#!/usr/bin/env node

import {spawn} from "node:child_process";
import {randomBytes, randomUUID, generateKeyPairSync} from "node:crypto";
import {existsSync} from "node:fs";
import {chmod, lstat, mkdir, readFile, readdir, rm, stat, statfs, writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {basename, dirname, join, resolve, sep} from "node:path";
import {request as httpsRequest} from "node:https";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUN_ID_PATTERN = /^[0-9]{8}t[0-9]{6}z-[0-9a-f]{6}$/u;
const SECRET_ROOT = "/dev/shm";
const TMPFS_MAGIC = 0x01021994;
const RUNTIME_UID = process.getuid();
const RUNTIME_GID = process.getgid();
const API_ROLE = "coffee_catalog_api_ro";
const ROLES = ["coffee_catalog_import_rw", "coffee_catalog_activate_rw", API_ROLE];
const SNAPSHOT = "snp_00000000000000000000000001";
const SUPPLIER = "sup_00000000000000000000000001";
const PRODUCT_A = "prd_00000000000000000000000001";
const VARIANT_A = "var_00000000000000000000000001";
const OFFER_A = "off_00000000000000000000000001";
const PRODUCT_B = "prd_00000000000000000000000002";
const VARIANT_B = "var_00000000000000000000000002";
const OFFER_B = "off_00000000000000000000000002";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const NOT_COVERED = [
  {
    id: "event-catalog-snapshot-activated",
    title: "CatalogSnapshotActivated.v1",
    detail: "Событие публикует catalog-activation-worker. Этот процесс его не пишет, воркер прогон не поднимает.",
  },
  {
    id: "event-catalog-mapping-changed",
    title: "CatalogMappingChanged.v2",
    detail: "Событие публикует catalog-activation-worker. Подписчик в контракте — orders-aroma-preparation, не catalog-service.",
  },
];

const secrets = [];

function remember(value) {
  if (typeof value === "string" && value.length >= 8) secrets.push(value);
  return value;
}

function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
  return out.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/gu, "[REDACTED-PEM]");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSafe(value, pattern, label) {
  assert(pattern.test(value), `${label} is not safe to interpolate`);
}

function run(command, args, {input, cwd = ROOT, inherit = false} = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {cwd, stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"]});
    const stdout = [];
    const stderr = [];
    if (!inherit) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    }
    child.on("error", rejectRun);
    child.on("close", (code) => {
      const out = inherit ? "" : Buffer.concat(stdout).toString("utf8");
      const err = inherit ? "" : Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const error = new Error(`${command} ${args[0] ?? ""} exited ${code}`);
        error.stdout = out;
        error.stderr = err;
        error.exitCode = code;
        rejectRun(error);
        return;
      }
      resolveRun({stdout: out, stderr: err});
    });
  });
}

function detail(error) {
  return redact(`${error?.message ?? error}\n${error?.stderr ?? ""}\n${error?.stdout ?? ""}`).slice(0, 4000);
}

function pem(key, type) {
  return key.export({type, format: "pem"}).toString();
}

function keyPair() {
  const generated = generateKeyPairSync("ed25519");
  return {privatePem: pem(generated.privateKey, "pkcs8"), publicPem: pem(generated.publicKey, "spki"), privateKey: generated.privateKey};
}

function newRunId() {
  const stamp = new Date().toISOString().toLowerCase().replaceAll(/[-:]/gu, "").replace(/\.\d{3}z$/u, "z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function projectName(runId) {
  assertSafe(runId, RUN_ID_PATTERN, "run id");
  return `catalog-slice-verify-${runId}`;
}

function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolveListen(false));
    server.listen({host: "127.0.0.1", port}, () => server.close(() => resolveListen(true)));
  });
}

async function freePort() {
  for (let port = 18510; port <= 18580; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("no free host port in 18510-18580");
}

async function ensureBuilt() {
  const entry = join(ROOT, "apps/catalog-service/dist/main.js");
  const yaml = join(ROOT, "node_modules/js-yaml/package.json");
  assert(existsSync(yaml), "js-yaml is missing; refusing to install");
  process.stderr.write("catalog-slice-verify: tsc -b apps/catalog-service\n");
  await run("pnpm", ["exec", "tsc", "-b", "apps/catalog-service", "--pretty", "false"], {inherit: true});
  assert(existsSync(entry), "apps/catalog-service/dist/main.js was not produced");
}

async function assertTmpfs(path) {
  const stats = await statfs(path);
  assert(stats.type === TMPFS_MAGIC, `${path} is not tmpfs; refusing to store secret material on a disk-backed filesystem`);
}

function secretDirectory(project) {
  const directory = join(SECRET_ROOT, project);
  const root = resolve(SECRET_ROOT);
  assert(directory.startsWith(`${root}${sep}`) && basename(directory) === project, "secret directory escaped");
  return directory;
}

async function ownRuntimeSecret(path) {
  await chmod(path, 0o400);
  const fileStat = await stat(path);
  assert((fileStat.mode & 0o777) === 0o400, "scoped secret mode is not 0400");
  assert(fileStat.uid === RUNTIME_UID && fileStat.gid === RUNTIME_GID, "scoped secret owner is not the runtime uid");
}

async function ensureImage(image) {
  try {
    await run("docker", ["image", "inspect", image]);
  } catch {
    process.stderr.write(`catalog-slice-verify: pull ${image.split("@")[0]}\n`);
    await run("docker", ["pull", image], {inherit: true});
  }
}

function openssl(args) {
  execFileSync("openssl", args, {stdio: "ignore"});
}

async function writeExt(path, environment, runtime) {
  const body = [
    `subjectAltName=URI:spiffe://coffee-platform/${environment}/${runtime},DNS:${runtime}.${environment}.svc.coffee-platform.internal`,
    "extendedKeyUsage=serverAuth,clientAuth",
    "basicConstraints=CA:FALSE",
    "",
  ].join("\n");
  await writeFile(path, body, {mode: 0o600});
}

async function issueCert(directory, environment, runtime, caCert, caKey, serialPath, first) {
  const key = join(directory, `${runtime}.key`);
  const csr = join(directory, `${runtime}.csr`);
  const cert = join(directory, `${runtime}.crt`);
  const ext = join(directory, `${runtime}.ext`);
  await writeExt(ext, environment, runtime);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${runtime}`]);
  openssl(["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAserial", serialPath, ...(first ? ["-CAcreateserial"] : []), "-out", cert, "-days", "1", "-sha256", "-extfile", ext]);
  return {certPem: await readFile(cert, "utf8"), keyPem: await readFile(key, "utf8")};
}

async function createTransport(directory, environment) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serial = join(directory, "ca.srl");
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert, "-days", "1", "-subj", "/CN=catalog-slice-verify-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  const caPem = await readFile(caCert, "utf8");
  const server = await issueCert(directory, environment, "catalog-service", caCert, caKey, serial, true);
  const apiPublic = await issueCert(directory, environment, "api-public", caCert, caKey, serial, false);
  const apiInternal = await issueCert(directory, environment, "api-internal", caCert, caKey, serial, false);
  const customer = await issueCert(directory, environment, "customer-service", caCert, caKey, serial, false);
  return {
    caPem,
    server,
    apiPublic,
    apiInternal,
    customer,
    expectedSan: `spiffe://coffee-platform/${environment}/catalog-service`,
  };
}

function verificationKeys(active, previous) {
  return {active, previous};
}

async function writeSecretFile(path, environment, material, role, rolePassword, cursor, delegation) {
  const document = {
    schemaVersion: 1,
    environment,
    runtime: "catalog-service",
    secrets: {
      postgres: {catalogApi: {username: role, password: rolePassword}},
      security: {
        catalogCursorSigningPrivateKey: cursor.privatePem,
        delegationVerificationKeys: {
          "api-public": verificationKeys(delegation.public.publicPem, keyPair().publicPem),
          "api-internal": verificationKeys(delegation.internal.publicPem, keyPair().publicPem),
        },
        serviceTransportKeys: {
          "catalog-service": JSON.stringify({caPem: material.caPem, certPem: material.server.certPem, keyPem: material.server.keyPem}),
        },
      },
      telemetry: {exporterToken: remember(randomBytes(24).toString("hex"))},
    },
  };
  remember(rolePassword);
  remember(cursor.privatePem);
  remember(delegation.public.privatePem);
  remember(delegation.internal.privatePem);
  remember(material.server.keyPem);
  remember(material.apiPublic.keyPem);
  remember(material.apiInternal.keyPem);
  remember(material.customer.keyPem);
  await writeFile(path, `${JSON.stringify(document)}\n`, {mode: 0o400});
  await ownRuntimeSecret(path);
}

function composeFile({project, runId, root, port, database, passwordFile, secretsFile, postgresImage, nodeImage, kafkaImage}) {
  const q = JSON.stringify;
  return `name: ${project}
services:
  postgres:
    image: ${postgresImage}
    pull_policy: missing
    container_name: ${project}-postgres
    init: true
    restart: "no"
    mem_limit: 1g
    environment:
      POSTGRES_USER: slice_admin
      POSTGRES_DB: ${database}
      POSTGRES_PASSWORD_FILE: /run/pg/password
      PGDATA: /var/lib/postgresql/slice
    volumes:
      - type: bind
        source: ${q(passwordFile)}
        target: /run/pg/password
        read_only: true
    tmpfs:
      - /var/lib/postgresql/slice:rw,nosuid,size=256m
    networks:
      default:
        aliases: [coffee_postgres]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U slice_admin -d ${database}"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 10s
    labels:
      com.coffee.slice: catalog
      com.coffee.slice.run: ${runId}
  kafka:
    image: ${kafkaImage}
    pull_policy: missing
    container_name: ${project}-kafka
    hostname: kafka
    init: true
    restart: "no"
    mem_limit: 1g
    environment:
      KAFKA_NODE_ID: "1"
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_LISTENERS: CONTROLLER://:29093,PLAINTEXT://:9092
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:29093
      CLUSTER_ID: "4L6g3nShT-eMCtK--X86sw"
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1"
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0"
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1"
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1"
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: "1"
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: "1"
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false"
      KAFKA_NUM_PARTITIONS: "1"
      KAFKA_LOG_DIRS: /tmp/kraft-combined-logs
      KAFKA_HEAP_OPTS: "-Xms256m -Xmx512m"
    healthcheck:
      test: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092"]
      interval: 5s
      timeout: 10s
      retries: 30
      start_period: 20s
    labels:
      com.coffee.slice: catalog
      com.coffee.slice.run: ${runId}
  catalog:
    image: ${nodeImage}
    pull_policy: missing
    container_name: ${project}-catalog
    init: true
    restart: "no"
    user: "${RUNTIME_UID}:${RUNTIME_GID}"
    working_dir: ${q(root)}
    command: ["node", "apps/catalog-service/dist/main.js"]
    mem_limit: 512m
    stop_grace_period: 15s
    security_opt: ["no-new-privileges:true"]
    environment:
      COFFEE_CONFIG_FILE: ${q(join(root, "config/platform.yaml"))}
      COFFEE_RUNTIME_SECRETS_FILE: /run/secrets/coffee-platform.yaml
      HOME: /tmp
    volumes:
      - type: bind
        source: ${q(root)}
        target: ${q(root)}
        read_only: true
      - type: bind
        source: ${q(secretsFile)}
        target: /run/secrets/coffee-platform.yaml
        read_only: true
    tmpfs:
      - /tmp:rw,nosuid,size=64m
    ports: ["127.0.0.1:${port}:4102"]
    networks: [default]
    labels:
      com.coffee.slice: catalog
      com.coffee.slice.run: ${runId}
networks:
  default:
    name: ${project}-net
    labels:
      com.coffee.slice: catalog
      com.coffee.slice.run: ${runId}
`;
}

async function loadConfig() {
  const {load} = await import("js-yaml");
  const toolchain = JSON.parse(await readFile(join(ROOT, "config/toolchain-versions.json"), "utf8"));
  const config = load(await readFile(join(ROOT, "config/platform.yaml"), "utf8"));
  const environment = config?.environment;
  const service = config?.services?.["catalog-service"];
  const database = service?.database;
  const listenPort = service?.listen?.port;
  const producers = service?.kafka?.producers;
  const consumers = service?.kafka?.consumers;
  const topics = [config?.kafka?.topics?.catalogSnapshot?.name, config?.kafka?.topics?.catalogMapping?.name];
  assert(typeof environment === "string", "platform environment is missing");
  assert(typeof database === "string", "catalog database name is missing");
  assertSafe(environment, /^[a-z0-9-]+$/u, "environment");
  assertSafe(database, /^[a-z][a-z0-9_]+$/u, "database");
  assert(config?.postgres?.host === "coffee_postgres" && config?.postgres?.port === 5432, "postgres address is not coffee_postgres:5432");
  assert(listenPort === 4102, "catalog-service listen port is not 4102");
  assert(Array.isArray(producers) && producers.length === 0, "catalog-service kafka producers are not empty");
  assert(Array.isArray(consumers) && consumers.length === 0, "catalog-service kafka consumers are not empty");
  assert(topics.every((topic) => typeof topic === "string" && topic.length > 0), "catalog kafka topic names are missing");
  assert(typeof toolchain.kafkaImage === "string" && toolchain.kafkaImage.startsWith("apache/kafka:"), "kafka image pin is missing");
  for (const key of ["postgresImage", "nodeBookwormSlimImage", "kafkaImage"]) {
    assert(typeof toolchain[key] === "string" && /^[^\s@]+@sha256:[0-9a-f]{64}$/u.test(toolchain[key]), `${key} image pin is missing or invalid`);
  }
  return {environment, database, topics, postgresImage: toolchain.postgresImage, nodeImage: toolchain.nodeBookwormSlimImage, kafkaImage: toolchain.kafkaImage};
}

async function migrationFiles() {
  const directory = join(ROOT, "apps/catalog-service/migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  assert(names.length > 0, "catalog migrations are missing");
  const files = [];
  for (const name of names) files.push({name, sql: await readFile(join(directory, name), "utf8")});
  const sql = files.map((file) => file.sql).join("\n");
  for (const role of ROLES) assert(sql.includes(role), `catalog migrations do not name ${role}`);
  return files;
}

function httpsCall({port, ca, cert, key, servername, expectedSan, method, path, headers, body}) {
  return new Promise((resolveCall, rejectCall) => {
    const request = httpsRequest({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers,
      ca,
      ...(cert === undefined ? {} : {cert, key}),
      minVersion: "TLSv1.3",
      rejectUnauthorized: true,
      servername,
      checkServerIdentity: (_host, certificate) => {
        const san = String(certificate.subjectaltname ?? "").split(",").map((item) => item.trim()).find((item) => item.startsWith("URI:"))?.slice(4);
        return san === expectedSan ? undefined : new Error("peer identity mismatch");
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text.length === 0 ? null : JSON.parse(text); } catch { json = null; }
        resolveCall({status: response.statusCode ?? 0, headers: response.headers, text, json});
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("timeout")));
    request.on("error", rejectCall);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function traceparent() {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function actorToken(signActorContext, privateKey, correlationId) {
  const now = Math.floor(Date.now() / 1000);
  return signActorContext({
    iss: "api-public",
    aud: "catalog-service",
    originalIssuer: "edge-gateway",
    sub: "actor_catalog_slice",
    permissions: ["catalog:read"],
    operationId: "searchCatalogProducts",
    correlationId,
    traceparent: traceparent(),
    iat: now,
    exp: now + 30,
    jti: randomUUID(),
    kid: "api-public-delegation-v1",
  }, privateKey);
}

function serviceToken(signServiceDelegation, privateKey, originalCaller, correlationId) {
  const now = Math.floor(Date.now() / 1000);
  return signServiceDelegation({
    iss: "api-internal",
    aud: "catalog-service",
    originalCaller,
    operationId: "getCatalogPricingInput",
    correlationId,
    traceparent: traceparent(),
    iat: now,
    exp: now + 30,
    jti: randomUUID(),
    kid: "api-internal-delegation-v1",
  }, privateKey);
}

function fixtureSql() {
  return `INSERT INTO catalog.supplier_snapshots (
  snapshot_ref, supplier_ref, provider_snapshot_ref, state,
  declared_batch_count, declared_product_count, declared_variant_count, declared_offer_count,
  content_hash, received_at
) VALUES (
  '${SNAPSHOT}', '${SUPPLIER}', 'fixture-local', 'Active',
  1, 2, 2, 2, '${HASH_A}', clock_timestamp()
);
INSERT INTO catalog.products (snapshot_ref, product_ref, display_name, display_name_sort_key) VALUES
  ('${SNAPSHOT}', '${PRODUCT_A}', 'Kenya Coffee', 'kenya coffee'),
  ('${SNAPSHOT}', '${PRODUCT_B}', 'Kenya Filter', 'kenya filter');
INSERT INTO catalog.variants (snapshot_ref, variant_ref, product_ref, unit, image_url, grind_options) VALUES
  ('${SNAPSHOT}', '${VARIANT_A}', '${PRODUCT_A}', 'piece', 'https://catalog.example.test/coffee.png', '[{"sourceGrindKeyHash":"${HASH_B}","displayName":"filter"}]'::jsonb),
  ('${SNAPSHOT}', '${VARIANT_B}', '${PRODUCT_B}', 'gram', NULL, NULL);
INSERT INTO catalog.offer_mappings (
  snapshot_ref, variant_ref, offer_ref, mapping_revision, mapping_state, supplier_unit_minor, currency, effective_at
) VALUES
  ('${SNAPSHOT}', '${VARIANT_A}', '${OFFER_A}', 3, 'Active', 12500, 'RUB', clock_timestamp()),
  ('${SNAPSHOT}', '${VARIANT_B}', '${OFFER_B}', 4, 'Active', 8000, 'RUB', clock_timestamp());
INSERT INTO catalog.availability (snapshot_ref, variant_ref, state, checked_at) VALUES
  ('${SNAPSHOT}', '${VARIANT_A}', 'Available', clock_timestamp()),
  ('${SNAPSHOT}', '${VARIANT_B}', 'Available', clock_timestamp());
UPDATE catalog.catalog_state
   SET active_snapshot_ref = '${SNAPSHOT}', active_snapshot_revision = 7, active_content_hash = '${HASH_A}'
 WHERE id = true;
`;
}

function counts(scenarios) {
  return {
    passed: scenarios.filter((scenario) => scenario.status === "passed").length,
    failed: scenarios.filter((scenario) => scenario.status === "failed").length,
    notCovered: scenarios.filter((scenario) => scenario.status === "not-covered").length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("node .cursor/skills/catalog-slice-verify/run.mjs [--keep]\nnode .cursor/skills/catalog-slice-verify/run.mjs --down <run-id>\n");
    return 0;
  }
  if (args[0] === "--down") {
    const runId = args[1];
    assert(args.length === 2 && RUN_ID_PATTERN.test(runId ?? ""), "--down requires one run id");
    await tearDown(runId);
    process.stderr.write(`catalog-slice-verify: removed catalog-slice-verify-${runId}\n`);
    return 0;
  }
  assert(args.length === 0 || (args.length === 1 && args[0] === "--keep"), "unknown arguments");
  const keep = args[0] === "--keep";
  await run("docker", ["ps", "-q"]);
  await ensureBuilt();
  const {environment, database, topics, postgresImage, nodeImage, kafkaImage} = await loadConfig();
  const migrations = await migrationFiles();
  const {signActorContext, signServiceDelegation} = await import("../../../packages/platform-security/dist/index.js");
  const {isCatalogProblem, isCatalogPricingInput, isCatalogSearchResponse} = await import("../../../packages/contracts/catalog-v1/dist/index.js");
  const runId = newRunId();
  const project = projectName(runId);
  const port = await freePort();
  await assertTmpfs(SECRET_ROOT);
  const directory = secretDirectory(project);
  const evidenceDir = join(ROOT, "evidence/catalog-slice-verify", runId);
  const httpLog = [];
  const dbLog = {};
  const scenarios = [];
  const executable = [];
  let transport;
  let delegation;
  let servername;
  const writeResult = async (status) => {
    const tally = counts(scenarios);
    const failed = tally.failed > 0 || status === "fail";
    const overall = failed ? "fail" : status === "pass" ? "pass" : "incomplete";
    await mkdir(evidenceDir, {recursive: true, mode: 0o700});
    await writeFile(join(evidenceDir, "result.json"), `${JSON.stringify({
      slice: "catalog-service",
      boundary: database,
      runId,
      status: overall,
      passed: tally.passed,
      failed: tally.failed,
      notCovered: tally.notCovered,
      scenarios,
    }, null, 2)}\n`);
    await writeFile(join(evidenceDir, "http.ndjson"), httpLog.map((line) => JSON.stringify(line)).join("\n") + (httpLog.length ? "\n" : ""));
    await writeFile(join(evidenceDir, "db.json"), `${JSON.stringify(dbLog, null, 2)}\n`);
    return overall;
  };
  const call = async (scenario, {method, path, material, correlationId = randomUUID(), actor = false, caller}) => {
    const headers = {"x-correlation-id": correlationId};
    if (actor) headers["x-actor-context"] = actorToken(signActorContext, delegation.public.privateKey, correlationId);
    if (caller !== undefined) headers["x-service-delegation"] = serviceToken(signServiceDelegation, delegation.internal.privateKey, caller, correlationId);
    let outcome;
    try {
      outcome = await httpsCall({
        port, ca: transport.caPem, cert: material?.certPem, key: material?.keyPem, servername,
        expectedSan: transport.expectedSan, method, path, headers,
      });
    } catch (error) {
      outcome = {status: 0, headers: {}, text: "", json: null, error: error?.code ?? error?.message ?? "error"};
    }
    httpLog.push({
      scenario, method, path, status: outcome.status,
      error: outcome.error ?? null,
      code: outcome.json?.code ?? null,
      response: outcome.json ?? (outcome.text ? outcome.text.slice(0, 500) : null),
    });
    return outcome;
  };
  const psql = async (sql, tuplesOnly = false) => run("docker", [
    "exec", "-i", `${project}-postgres`, "psql", "-U", "slice_admin", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-q", "--no-psqlrc", ...(tuplesOnly ? ["-t", "-A"] : []),
  ], {input: sql.endsWith("\n") ? sql : `${sql}\n`});
  const snapshot = async (scenario, sql) => {
    const {stdout} = await psql(sql, true);
    const row = JSON.parse(stdout.trim());
    dbLog[scenario] = row;
    return row;
  };
  const expectProblem = (outcome, status, code) => {
    assert(outcome.status === status && outcome.json?.code === code, `${status} ${code} returned ${outcome.status} ${outcome.json?.code ?? outcome.error ?? ""}`);
    assert(isCatalogProblem(outcome.json), `${code} body is outside catalog-v1 problem schema`);
  };
  try {
    await mkdir(directory, {recursive: true, mode: 0o700});
    await assertTmpfs(directory);
    await mkdir(evidenceDir, {recursive: true, mode: 0o700});
    const password = remember(randomBytes(24).toString("hex"));
    const rolePassword = remember(randomBytes(24).toString("hex"));
    const rolePasswords = {
      coffee_catalog_import_rw: remember(randomBytes(24).toString("hex")),
      coffee_catalog_activate_rw: remember(randomBytes(24).toString("hex")),
      [API_ROLE]: rolePassword,
    };
    const passwordFile = join(directory, "pg-password");
    const secretsFile = join(directory, "catalog-service.yaml");
    const composePath = join(directory, "compose.yaml");
    await writeFile(passwordFile, `${password}\n`, {mode: 0o400});
    await chmod(passwordFile, 0o400);
    transport = await createTransport(join(directory, "certs"), environment);
    delegation = {public: keyPair(), internal: keyPair()};
    const cursor = keyPair();
    await writeSecretFile(secretsFile, environment, transport, API_ROLE, rolePassword, cursor, delegation);
    await writeFile(composePath, composeFile({project, runId, root: ROOT, port, database, passwordFile, secretsFile, postgresImage, nodeImage, kafkaImage}), {mode: 0o600});
    servername = `catalog-service.${environment}.svc.coffee-platform.internal`;
    const runMeta = {
      runId, project, network: `${project}-net`,
      containers: [`${project}-postgres`, `${project}-kafka`, `${project}-catalog`],
      port, database, topics, migrations: migrations.map((file) => file.name),
    };
    await writeFile(join(evidenceDir, "run.json"), `${JSON.stringify(runMeta, null, 2)}\n`);
    let head = null;
    try { head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim(); } catch { head = null; }
    let dirty = true;
    try { dirty = (await run("git", ["status", "--porcelain"])).stdout.trim().length > 0; } catch { dirty = true; }
    await writeFile(join(evidenceDir, "environment.json"), `${JSON.stringify({
      slice: "catalog-service",
      boundary: `catalog-service -> PostgreSQL ${database}; local Kafka offsets`,
      images: {postgres: postgresImage, node: nodeImage, kafka: kafkaImage},
      hostPort: port,
      containerPort: 4102,
      databasePublished: false,
      kafkaPublished: false,
      kafkaProtocol: "PLAINTEXT",
      project, node: process.version, commit: head, dirty,
    }, null, 2)}\n`);
    await writeResult("incomplete");

    async function waitHealthy(container) {
      const deadline = Date.now() + 90_000;
      let status = "missing";
      while (Date.now() < deadline) {
        try {
          status = (await run("docker", ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", container])).stdout.trim();
        } catch { status = "missing"; }
        if (status === "healthy") return;
        if (status === "exited" || status === "dead") break;
        await delay(500);
      }
      throw new Error(`${container} did not become healthy (${status})`);
    }

    async function waitReady() {
      const deadline = Date.now() + 60_000;
      let last = "not-started";
      while (Date.now() < deadline) {
        const health = await call("startup", {method: "GET", path: "/health/ready", material: transport.apiPublic});
        last = health.error ?? `${health.status} ${health.json?.status ?? ""}`;
        if (health.status === 200 && health.json?.status === "ready" && health.json?.runtime === "catalog-service") return;
        const state = await run("docker", ["inspect", "--format", "{{.State.Status}}", `${project}-catalog`]).then((result) => result.stdout.trim()).catch(() => "missing");
        if (state === "exited" || state === "dead") break;
        await delay(500);
      }
      throw new Error(`catalog-service did not become ready (${last})`);
    }

    async function published(container, privatePort) {
      const {stdout} = await run("docker", ["inspect", "--format", "{{json .NetworkSettings.Ports}}", container]);
      const ports = JSON.parse(stdout.trim() || "null");
      const binding = ports?.[`${privatePort}/tcp`];
      return Array.isArray(binding) && binding.length > 0;
    }

    await ensureImage(postgresImage);
    await ensureImage(nodeImage);
    await ensureImage(kafkaImage);
    process.stderr.write(`catalog-slice-verify: up ${project} on 127.0.0.1:${port}\n`);
    await run("docker", ["compose", "-p", project, "-f", composePath, "up", "-d", "postgres", "kafka"]);
    await waitHealthy(`${project}-postgres`);
    const roleSql = ROLES.map((role) => {
      const secret = rolePasswords[role];
      assertSafe(secret, /^[0-9a-f]+$/u, "role password");
      return `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${secret}';`;
    }).join("\n");
    await psql(`BEGIN;\n${roleSql}\nGRANT CONNECT ON DATABASE "${database}" TO "${API_ROLE}";\nREVOKE ALL ON DATABASE "${database}" FROM PUBLIC;\nCOMMIT;\n`);
    let ledger = false;
    for (const file of migrations) {
      if (!ledger && file.sql.includes("platform_schema_migrations")) {
        await psql(`CREATE TABLE IF NOT EXISTS catalog.platform_schema_migrations (
          id text PRIMARY KEY,
          checksum char(64) NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
        );`);
        ledger = true;
      }
      await psql(file.sql);
    }
    assert(ledger, "catalog migrations never mentioned the schema ledger");
    await run("docker", ["compose", "-p", project, "-f", composePath, "up", "-d", "catalog"]);
    let kafkaReady = true;
    try {
      await Promise.all([waitReady(), waitHealthy(`${project}-kafka`)]);
      for (const topic of topics) {
        await run("docker", ["exec", `${project}-kafka`, "/opt/kafka/bin/kafka-topics.sh", "--create", "--if-not-exists", "--topic", topic, "--bootstrap-server", "localhost:9092", "--partitions", "1", "--replication-factor", "1"]);
      }
    } catch (error) {
      kafkaReady = false;
      dbLog.kafkaStartup = detail(error);
      await waitReady();
    }
    const catalogBinding = JSON.parse((await run("docker", ["inspect", "--format", "{{json (index .NetworkSettings.Ports \"4102/tcp\")}}", `${project}-catalog`])).stdout.trim());
    const doctor = {
      ok: false,
      portOwned: catalogBinding?.[0]?.HostIp === "127.0.0.1" && Number(catalogBinding?.[0]?.HostPort) === port,
      postgresPublished: await published(`${project}-postgres`, 5432),
      kafkaPublished: await published(`${project}-kafka`, 9092),
      readyRuntime: "catalog-service",
    };
    doctor.ok = doctor.portOwned && doctor.postgresPublished === false && doctor.kafkaPublished === false;
    await writeFile(join(evidenceDir, "doctor.json"), `${JSON.stringify(doctor, null, 2)}\n`);
    assert(doctor.ok, `doctor rejected the instance ${JSON.stringify(doctor)}`);

    const searchPath = "/api/client-v1/catalog/products";
    const pricingPath = (productRef, variantRef) => `/api/internal-v1/catalog/products/${productRef}/variants/${variantRef}/pricing-input`;
    executable.push(
      ["health-live", "GET /health/live", async () => {
        const health = await call("health-live", {method: "GET", path: "/health/live", material: transport.apiPublic});
        assert(health.status === 200 && health.json?.status === "live" && health.json?.runtime === "catalog-service", `live returned ${health.status}`);
      }],
      ["health-ready", "GET /health/ready", async () => {
        const health = await call("health-ready", {method: "GET", path: "/health/ready", material: transport.apiPublic});
        assert(health.status === 200 && health.json?.status === "ready" && health.json?.runtime === "catalog-service", `ready returned ${health.status}`);
      }],
      ["metrics", "GET /metrics", async () => {
        const metrics = await call("metrics", {method: "GET", path: "/metrics", material: transport.apiPublic});
        assert(metrics.status === 200 && metrics.text.includes("runtime_admission_rejected_total"), `metrics returned ${metrics.status}`);
      }],
      ["empty-search", "Пустой снимок отклоняет поиск", async () => {
        const search = await call("empty-search", {method: "GET", path: `${searchPath}?query=kenya`, material: transport.apiPublic, actor: true});
        expectProblem(search, 503, "CATALOG_SNAPSHOT_INCOMPLETE");
        const db = await snapshot("empty-search", `SELECT json_build_object(
          'products', (SELECT count(*)::int FROM catalog.products),
          'outbox', (SELECT count(*)::int FROM catalog.outbox_messages),
          'activeRevision', (SELECT active_snapshot_revision FROM catalog.catalog_state WHERE id)
        );`);
        assert(db.products === 0 && db.outbox === 0 && db.activeRevision === null, "empty catalog was not empty");
      }],
      ["search-rejected", "Поиск отвергает чужой транспорт и неверный запрос", async () => {
        const bare = await httpsCall({
          port, ca: transport.caPem, servername, expectedSan: transport.expectedSan,
          method: "GET", path: `${searchPath}?query=kenya`, headers: {},
        }).then(() => ({status: 1, json: null, error: null, text: "", headers: {}})).catch((error) => ({status: 0, json: null, error: error?.code ?? "tls-rejected", text: "", headers: {}}));
        httpLog.push({scenario: "search-rejected", method: "GET", path: searchPath, status: bare.status, error: bare.error, code: null, response: null});
        assert(bare.status === 0, "search without a client certificate was accepted");
        const foreign = await call("search-rejected", {method: "GET", path: `${searchPath}?query=kenya`, material: transport.customer, actor: true});
        expectProblem(foreign, 401, "AUTHENTICATION_REQUIRED");
        const unsigned = await call("search-rejected", {method: "GET", path: `${searchPath}?query=kenya`, material: transport.apiPublic});
        expectProblem(unsigned, 401, "AUTHENTICATION_REQUIRED");
        const invalid = await call("search-rejected", {method: "GET", path: `${searchPath}?query=a`, material: transport.apiPublic, actor: true});
        expectProblem(invalid, 400, "VALIDATION_FAILED");
        const cursor = await call("search-rejected", {method: "GET", path: `${searchPath}?query=kenya&cursor=not-a-cursor`, material: transport.apiPublic, actor: true});
        expectProblem(cursor, 400, "INVALID_CURSOR");
        const db = await snapshot("search-rejected", `SELECT json_build_object('products', (SELECT count(*)::int FROM catalog.products), 'outbox', (SELECT count(*)::int FROM catalog.outbox_messages));`);
        assert(db.products === 0 && db.outbox === 0, "rejected search wrote rows");
      }],
      ["search-page", "Поиск возвращает фикстуру и курсор", async () => {
        await psql(fixtureSql());
        const page = await call("search-page", {method: "GET", path: `${searchPath}?query=kenya&limit=1`, material: transport.apiPublic, actor: true});
        assert(page.status === 200 && isCatalogSearchResponse(page.json), `search page returned ${page.status} ${page.json?.code ?? ""}`);
        assert(page.json.snapshotRevision === "7" && page.json.items.length === 1 && page.json.items[0].productRef === PRODUCT_A && page.json.items[0].variantRef === VARIANT_A, "first page was not Kenya Coffee");
        assert(page.json.items[0].displayName === "Kenya Coffee" && page.json.items[0].unit === "piece" && page.json.items[0].availability === "Available" && page.json.items[0].mappingAvailable === true, "first page fields diverged");
        assert(page.json.items[0].imageUrl === "https://catalog.example.test/coffee.png" && page.json.items[0].grindOptions?.[0]?.displayName === "filter", "grind option was dropped");
        assert(typeof page.json.nextCursor === "string" && page.json.nextCursor.length > 0, "first page did not return a cursor");
        const next = await call("search-page", {method: "GET", path: `${searchPath}?query=kenya&limit=1&cursor=${encodeURIComponent(page.json.nextCursor)}`, material: transport.apiPublic, actor: true});
        assert(next.status === 200 && isCatalogSearchResponse(next.json), `cursor page returned ${next.status} ${next.json?.code ?? ""}`);
        assert(next.json.items.length === 1 && next.json.items[0].productRef === PRODUCT_B && next.json.items[0].unit === "gram" && next.json.nextCursor === null, "second page was not Kenya Filter");
        const stopped = await call("search-page", {method: "GET", path: `${searchPath}?query=kenya&availability=Stopped`, material: transport.apiPublic, actor: true});
        assert(stopped.status === 200 && isCatalogSearchResponse(stopped.json) && stopped.json.items.length === 0 && stopped.json.snapshotRevision === "7" && stopped.json.nextCursor === null, "stopped filter was not empty");
        const db = await snapshot("search-page", `SELECT json_build_object(
          'products', (SELECT count(*)::int FROM catalog.products),
          'variants', (SELECT count(*)::int FROM catalog.variants),
          'outbox', (SELECT count(*)::int FROM catalog.outbox_messages),
          'activeRevision', (SELECT active_snapshot_revision::text FROM catalog.catalog_state WHERE id)
        );`);
        assert(db.products === 2 && db.variants === 2 && db.outbox === 0 && db.activeRevision === "7", "fixture counts diverged");
      }],
      ["pricing-rejected", "Pricing-input отвергает чужой транспорт и делегацию", async () => {
        const path = pricingPath(PRODUCT_A, VARIANT_A);
        const publicCert = await call("pricing-rejected", {method: "GET", path, material: transport.apiPublic, caller: "pricing-service"});
        expectProblem(publicCert, 401, "SERVICE_AUTHENTICATION_REQUIRED");
        const unsigned = await call("pricing-rejected", {method: "GET", path, material: transport.apiInternal});
        expectProblem(unsigned, 401, "SERVICE_AUTHENTICATION_REQUIRED");
        const foreignCaller = await call("pricing-rejected", {method: "GET", path, material: transport.apiInternal, caller: "orders-service"});
        expectProblem(foreignCaller, 403, "SERVICE_DELEGATION_INVALID");
        const invalid = await call("pricing-rejected", {method: "GET", path: pricingPath("not-a-product", VARIANT_A), material: transport.apiInternal, caller: "pricing-service"});
        expectProblem(invalid, 400, "VALIDATION_FAILED");
      }],
      ["pricing-input", "Pricing-input читает фикстуру для обоих вызывающих", async () => {
        const path = pricingPath(PRODUCT_A, VARIANT_A);
        const pricing = await call("pricing-input", {method: "GET", path, material: transport.apiInternal, caller: "pricing-service"});
        assert(pricing.status === 200 && isCatalogPricingInput(pricing.json), `pricing-service returned ${pricing.status} ${pricing.json?.code ?? ""}`);
        assert(pricing.json.productRef === PRODUCT_A && pricing.json.variantRef === VARIANT_A && pricing.json.offerRef === OFFER_A, "pricing product diverged");
        assert(pricing.json.supplierUnitMinor === "12500" && pricing.json.currency === "RUB" && pricing.json.snapshotRevision === "7" && pricing.json.mappingRevision === "3", "pricing money diverged");
        assert(pricing.json.availability === "Available" && pricing.json.unit === "piece" && pricing.json.displayName === "Kenya Coffee" && pricing.json.grindOptions?.[0]?.sourceGrindKeyHash === HASH_B, "pricing grind diverged");
        const convergence = await call("pricing-input", {method: "GET", path, material: transport.apiInternal, caller: "aroma-convergence"});
        assert(convergence.status === 200 && isCatalogPricingInput(convergence.json) && convergence.json.offerRef === OFFER_A && convergence.json.snapshotRevision === "7", `aroma-convergence returned ${convergence.status} ${convergence.json?.code ?? ""}`);
        const missing = await call("pricing-input", {method: "GET", path: pricingPath(PRODUCT_A, "var_00000000000000000000000099"), material: transport.apiInternal, caller: "pricing-service"});
        expectProblem(missing, 404, "CATALOG_PRODUCT_NOT_FOUND");
      }],
      ["outbox-silent", "Роль чтения не пишет outbox", async () => {
        const db = await snapshot("outbox-silent", `SELECT json_build_object(
          'outbox', (SELECT count(*)::int FROM catalog.outbox_messages),
          'apiCanInsert', has_table_privilege('${API_ROLE}', 'catalog.outbox_messages', 'INSERT'),
          'apiCanSelectActive', has_table_privilege('${API_ROLE}', 'catalog.active_products', 'SELECT')
        );`);
        assert(db.outbox === 0 && db.apiCanInsert === false && db.apiCanSelectActive === true, "catalog api role can write the outbox or cannot read the active catalog");
      }],
      ["kafka-silent", "Топики каталога остаются пустыми", async () => {
        assert(kafkaReady, dbLog.kafkaStartup ?? "kafka did not become healthy");
        const offsets = [];
        for (const topic of topics) {
          const {stdout} = await run("docker", ["exec", `${project}-kafka`, "/opt/kafka/bin/kafka-get-offsets.sh", "--bootstrap-server", "localhost:9092", "--topic", topic]);
          offsets.push(stdout.trim());
          assert(stdout.trim().split("\n").every((line) => line.endsWith(":0")), `${topic} offset moved: ${stdout.trim()}`);
        }
        const groups = (await run("docker", ["exec", `${project}-kafka`, "/opt/kafka/bin/kafka-consumer-groups.sh", "--bootstrap-server", "localhost:9092", "--list"])).stdout;
        assert(!groups.includes("catalog-service"), `catalog-service joined a consumer group: ${groups.trim()}`);
        dbLog["kafka-silent"] = {offsets, groups: groups.trim()};
      }],
    );

    for (const [id, title, runScenario] of executable) {
      try {
        await runScenario();
        scenarios.push({id, title, status: "passed"});
      } catch (error) {
        scenarios.push({id, title, status: "failed", detail: detail(error)});
      }
      await writeResult("incomplete");
    }
    for (const item of NOT_COVERED) scenarios.push({...item, status: "not-covered"});
    const overall = await writeResult("pass");
    const tally = counts(scenarios);
    for (const scenario of scenarios) process.stdout.write(`catalog-slice-verify ${runId} ${scenario.id} ${scenario.status}\n`);
    process.stdout.write(`catalog-slice-verify ${runId} ${overall} ${tally.passed} passed, ${tally.failed} failed, ${tally.notCovered} not-covered\n`);
    return overall === "pass" ? 0 : 1;
  } catch (error) {
    if (!scenarios.some((scenario) => scenario.id === "startup")) scenarios.push({id: "startup", title: "Старт среза", status: "failed", detail: detail(error)});
    const pending = executable.length > 0 ? executable : [
      ["health-live", "GET /health/live"],
      ["health-ready", "GET /health/ready"],
      ["metrics", "GET /metrics"],
      ["empty-search", "Пустой снимок отклоняет поиск"],
      ["search-rejected", "Поиск отвергает чужой транспорт и неверный запрос"],
      ["search-page", "Поиск возвращает фикстуру и курсор"],
      ["pricing-rejected", "Pricing-input отвергает чужой транспорт и делегацию"],
      ["pricing-input", "Pricing-input читает фикстуру для обоих вызывающих"],
      ["outbox-silent", "Роль чтения не пишет outbox"],
      ["kafka-silent", "Топики каталога остаются пустыми"],
    ];
    for (const [id, title] of pending) {
      if (!scenarios.some((scenario) => scenario.id === id)) scenarios.push({id, title, status: "not-covered", detail: "прогон не дошёл до сценария"});
    }
    for (const item of NOT_COVERED) {
      if (!scenarios.some((scenario) => scenario.id === item.id)) scenarios.push({...item, status: "not-covered"});
    }
    await writeResult("fail");
    const tally = counts(scenarios);
    for (const scenario of scenarios) process.stdout.write(`catalog-slice-verify ${runId} ${scenario.id} ${scenario.status}\n`);
    process.stdout.write(`catalog-slice-verify ${runId} fail ${tally.passed} passed, ${tally.failed} failed, ${tally.notCovered} not-covered\n`);
    process.stderr.write(`${detail(error)}\n`);
    return 1;
  } finally {
    await saveLogs(`${project}-catalog`, join(evidenceDir, "service.log"));
    await saveLogs(`${project}-kafka`, join(evidenceDir, "kafka.log"));
    if (!keep) await tearDown(runId);
    else process.stderr.write(`catalog-slice-verify: kept ${project}; remove with node .cursor/skills/catalog-slice-verify/run.mjs --down ${runId}\n`);
  }
}

async function saveLogs(container, file) {
  try {
    const {stdout, stderr} = await run("docker", ["logs", container]);
    const text = redact(`${stdout}${stderr}`);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, text.length > 200_000 ? text.slice(-200_000) : text);
  } catch {
    await mkdir(dirname(file), {recursive: true}).catch(() => {});
    await writeFile(file, "").catch(() => {});
  }
}

async function tearDown(runId) {
  assertSafe(runId, RUN_ID_PATTERN, "run id");
  const project = projectName(runId);
  const directory = secretDirectory(project);
  const composePath = join(directory, "compose.yaml");
  if (existsSync(composePath)) {
    await run("docker", ["compose", "-p", project, "-f", composePath, "down", "--volumes", "--remove-orphans"]).catch((error) => {
      process.stderr.write(`catalog-slice-verify: compose down warning ${redact(error.stderr || error.message).slice(0, 500)}\n`);
    });
  }
  let ids = "";
  try {
    ids = (await run("docker", ["ps", "-aq", "--filter", "label=com.coffee.slice=catalog", "--filter", `label=com.coffee.slice.run=${runId}`])).stdout;
  } catch { ids = ""; }
  for (const id of ids.split("\n").filter(Boolean)) {
    const name = (await run("docker", ["inspect", "--format", "{{.Name}}", id])).stdout.trim().replace(/^\//u, "");
    assert(name.startsWith(`${project}-`), `refusing to remove ${name}`);
    await run("docker", ["rm", "-f", id]);
  }
  await removeNetwork(`${project}-net`, runId);
  await removeProjectVolumes(project);
  if (existsSync(directory)) {
    assert(directory === secretDirectory(project), "refusing to delete secret directory");
    const info = await lstat(directory);
    if (info.isSymbolicLink()) await rm(directory);
    else {
      await assertTmpfs(directory);
      await rm(directory, {recursive: true, force: true});
    }
  }
}

async function removeNetwork(name, runId) {
  let labels = "";
  try {
    labels = (await run("docker", ["network", "inspect", "--format", "{{index .Labels \"com.coffee.slice\"}}|{{index .Labels \"com.coffee.slice.run\"}}", name])).stdout.trim();
  } catch { return; }
  assert(labels === `catalog|${runId}`, `refusing to remove network ${name}`);
  await run("docker", ["network", "rm", name]).catch(() => {});
}

async function removeProjectVolumes(project) {
  assert(project.startsWith("catalog-slice-verify-"), "refusing to remove foreign volumes");
  let names = "";
  try {
    names = (await run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`])).stdout;
  } catch { return; }
  for (const name of names.split("\n").filter(Boolean)) {
    const projectLabel = (await run("docker", ["volume", "inspect", "--format", "{{index .Labels \"com.docker.compose.project\"}}", name])).stdout.trim();
    assert(projectLabel === project, `refusing to remove volume ${name}`);
    await run("docker", ["volume", "rm", name]).catch(() => {});
  }
}

let code = 1;
try {
  code = await main();
} catch (error) {
  process.stderr.write(`${redact(error?.message ?? error)}\n`);
  code = 1;
}
process.exitCode = code;
