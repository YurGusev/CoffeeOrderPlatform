#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const POSTGRES_IMAGE =
  "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const NODE_IMAGE =
  "node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae";
const RUN_ID_PATTERN = /^[0-9]{8}t[0-9]{6}z-[0-9a-f]{6}$/u;
const SECRET_ROOT = "/dev/shm";
const TMPFS_MAGIC = 0x01021994;
const RUNTIME_UID = 1000;
const RUNTIME_GID = 1000;
const LABEL = "orders";
const FIXTURE = {
  customerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  otherCustomerRef: "cus_01ARZ3NDEKTSV4RRFFQ69G5FAW",
  quoteRef: "prq_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  productRef: "prd_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  variantRef: "var_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  offerRef: "off_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  policyRef: "pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  itemRef: "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  displayName: "Slice Verify",
  quoteHash: "ab".repeat(32),
};
const ROLES = [
  "coffee_orders_service_rw",
  "coffee_orders_prepare_rw",
  "coffee_orders_observer_rw",
  "coffee_orders_convergence_rw",
];
const TOPICS = [
  ["coffee.orders.lifecycle.v1", "12"],
  ["coffee.aroma.cart.commands.v1", "24"],
  ["coffee.realtime.invalidate.v1", "24"],
];
const REQUIRED = [
  "empty-ready",
  "create-draft",
  "replay-draft",
  "put-item",
  "get-card",
  "delete-item",
  "confirm-empty",
  "confirm-order",
  "reconcile-blocked",
];
const NOT_COVERED = [
  {
    id: "reconcile-accepted",
    title: "Успешный запрос сверки AROMA",
    detail:
      "OrderReconciliationRequested.v1 пишется только при проекции OutOfSync, Blocked или UnknownOutcome. Её создаёт orders-aroma-preparation, не этот процесс.",
  },
  {
    id: "health-live",
    title: "GET /health/live",
    detail: "Рычаг опрашивает только /health/ready.",
  },
  {
    id: "metrics",
    title: "GET /metrics",
    detail: "Метрики runtime этот прогон не снимает.",
  },
  {
    id: "inbox",
    title: "Разбор inbox",
    detail:
      "У orders-service в config/platform.yaml список consumers пуст. Inbox той же базы читают другие процессы.",
  },
];
const PERMISSION = {
  createOrderDraft: "orders:create",
  getOrderCard: "orders:read:any",
  upsertOrderItem: "orders:edit:any",
  removeOrderItem: "orders:edit:any",
  confirmOrder: "orders:confirm:any",
  requestAromaReconciliation: "orders:reconcile:any",
};

const secrets = [];
const require = createRequire(join(ROOT, "package.json"));

function remember(value) {
  if (typeof value === "string" && value.length >= 8) secrets.push(value);
  return value;
}

function redact(text) {
  let out = String(text ?? "");
  for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
  return out.replace(
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/gu,
    "[REDACTED-PEM]",
  );
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

function run(command, args, { input, cwd = ROOT, inherit = false, timeoutMs, env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timer;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    if (!inherit) {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    }
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = inherit ? "" : Buffer.concat(stdout).toString("utf8");
      const err = inherit ? "" : Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        const error = new Error(`${command} ${args[0] ?? ""} exited ${code}`);
        error.stdout = out;
        error.stderr = err;
        rejectRun(error);
        return;
      }
      resolveRun({ stdout: out, stderr: err });
    });
  });
}

function detail(error) {
  return redact(
    `${error?.message ?? error}\n${error?.stderr ?? ""}\n${error?.stdout ?? ""}`,
  ).slice(0, 4000);
}

function canonical(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(",")}]`;
  assert(typeof value === "object", "claim value is not canonical");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}

function signActor(claims, privateKey) {
  const payload = Buffer.from(canonical(claims), "utf8");
  return `${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
}

function pem(key, type) {
  return key.export({ type, format: "pem" }).toString();
}

function keyPair() {
  const generated = generateKeyPairSync("ed25519");
  return {
    privatePem: pem(generated.privateKey, "pkcs8"),
    publicPem: pem(generated.publicKey, "spki"),
    privateKey: generated.privateKey,
  };
}

function newRunId() {
  const stamp = new Date()
    .toISOString()
    .toLowerCase()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}z$/u, "z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function projectName(runId) {
  assertSafe(runId, RUN_ID_PATTERN, "run id");
  return `orders-slice-verify-${runId}`;
}

function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolveListen(false));
    server.listen({ host: "127.0.0.1", port }, () => server.close(() => resolveListen(true)));
  });
}

async function freePort() {
  for (let port = 18510; port <= 18580; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("no free host port in 18510-18580");
}

async function assertTmpfs(path) {
  const stats = await statfs(path);
  assert(
    stats.type === TMPFS_MAGIC,
    `${path} is not tmpfs; refusing to store secret material on a disk-backed filesystem`,
  );
}

function secretDirectory(project) {
  const directory = join(SECRET_ROOT, project);
  const root = resolve(SECRET_ROOT);
  assert(
    directory.startsWith(`${root}${sep}`) && basename(directory) === project,
    "secret directory escaped",
  );
  return directory;
}

async function ownRuntime(path, mode) {
  await chmod(path, mode);
  await chown(path, RUNTIME_UID, RUNTIME_GID);
}

function openssl(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

async function writeExt(path, environment, runtime) {
  await writeFile(
    path,
    [
      `subjectAltName=URI:spiffe://coffee-platform/${environment}/${runtime},DNS:${runtime}.${environment}.svc.coffee-platform.internal`,
      "extendedKeyUsage=serverAuth,clientAuth",
      "basicConstraints=CA:FALSE",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

async function issueCert(directory, environment, runtime, caCert, caKey, serialPath, first) {
  const key = join(directory, `${runtime}.key`);
  const csr = join(directory, `${runtime}.csr`);
  const cert = join(directory, `${runtime}.crt`);
  const ext = join(directory, `${runtime}.ext`);
  await writeExt(ext, environment, runtime);
  openssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    `/CN=${runtime}`,
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAserial",
    serialPath,
    ...(first ? ["-CAcreateserial"] : []),
    "-out",
    cert,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    ext,
  ]);
  return {
    certPem: await readFile(cert, "utf8"),
    keyPem: await readFile(key, "utf8"),
  };
}

async function createTransport(directory, environment) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, "ca.key");
  const caCert = join(directory, "ca.crt");
  const serial = join(directory, "ca.srl");
  openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCert,
    "-days",
    "1",
    "-subj",
    "/CN=orders-slice-verify-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  const caPem = await readFile(caCert, "utf8");
  const server = await issueCert(directory, environment, "orders-service", caCert, caKey, serial, true);
  const apiPublic = await issueCert(directory, environment, "api-public", caCert, caKey, serial, false);
  const catalog = await issueCert(directory, environment, "catalog-service", caCert, caKey, serial, false);
  const internal = await issueCert(directory, environment, "api-internal", caCert, caKey, serial, false);
  return { caPem, server, apiPublic, catalog, internal };
}

async function kafkaMaterial(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const storePassword = remember(randomBytes(18).toString("hex"));
  const users = {
    broker: remember(randomBytes(18).toString("hex")),
    orders: remember(randomBytes(18).toString("hex")),
    inspector: remember(randomBytes(18).toString("hex")),
  };
  const kt = (args) => run("keytool", args, { cwd: dir });
  await kt([
    "-genkeypair",
    "-alias",
    "kafka",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "2",
    "-dname",
    "CN=kafka",
    "-ext",
    "SAN=dns:kafka,dns:localhost",
    "-keystore",
    "kafka.keystore.p12",
    "-storetype",
    "PKCS12",
    "-storepass",
    storePassword,
    "-keypass",
    storePassword,
  ]);
  await kt([
    "-exportcert",
    "-alias",
    "kafka",
    "-keystore",
    "kafka.keystore.p12",
    "-storepass",
    storePassword,
    "-rfc",
    "-file",
    "kafka.crt",
  ]);
  await kt([
    "-importcert",
    "-noprompt",
    "-alias",
    "kafka",
    "-file",
    "kafka.crt",
    "-keystore",
    "kafka.truststore.p12",
    "-storetype",
    "PKCS12",
    "-storepass",
    storePassword,
  ]);
  const listed = Object.entries(users)
    .map(([name, password]) => `user_${name}="${password}"`)
    .join(" ");
  await writeFile(join(dir, "kafka.keystore.password"), `${storePassword}\n`, { mode: 0o600 });
  await writeFile(
    join(dir, "kafka_jaas.conf"),
    `KafkaServer { org.apache.kafka.common.security.plain.PlainLoginModule required username="broker" password="${users.broker}" ${listed}; };\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, "client.properties"),
    [
      "security.protocol=SASL_SSL",
      "sasl.mechanism=PLAIN",
      `sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="inspector" password="${users.inspector}";`,
      "ssl.truststore.type=PKCS12",
      "ssl.truststore.location=/etc/kafka/secrets/kafka.truststore.p12",
      `ssl.truststore.password=${storePassword}`,
      "ssl.endpoint.identification.algorithm=https",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const caPem = await readFile(join(dir, "kafka.crt"), "utf8");
  for (const name of await readdir(dir)) await ownRuntime(join(dir, name), 0o400);
  await ownRuntime(dir, 0o700);
  return { username: "orders", password: users.orders, caPem };
}

async function loadConfig() {
  const { load } = await import("js-yaml");
  const toolchain = JSON.parse(
    await readFile(join(ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const config = load(await readFile(join(ROOT, "config/platform.yaml"), "utf8"));
  const environment = config?.environment;
  const service = config?.services?.["orders-service"];
  const database = service?.database;
  const listenPort = service?.listen?.port;
  assert(typeof environment === "string", "platform environment is missing");
  assert(typeof database === "string", "orders database name is missing");
  assertSafe(environment, /^[a-z0-9-]+$/u, "environment");
  assertSafe(database, /^[a-z][a-z0-9_]+$/u, "database");
  assert(
    config?.postgres?.host === "coffee_postgres" && config?.postgres?.port === 5432,
    "postgres address is not coffee_postgres:5432",
  );
  assert(listenPort === 4104, "orders-service listen port is not 4104");
  assert(
    Array.isArray(service?.outbound) && service.outbound.includes("api-internal:4051"),
    "orders-service outbound is not api-internal:4051",
  );
  assert(config?.kafka?.brokers?.join(",") === "kafka:9092", "kafka broker is not kafka:9092");
  assert(config?.kafka?.clientProtocol === "SASL_SSL", "kafka protocol is not SASL_SSL");
  assert(typeof toolchain.kafkaImage === "string", "kafka image pin is missing");
  return { environment, database, kafkaImage: toolchain.kafkaImage };
}

async function migrationSql() {
  const directory = join(ROOT, "apps/orders-service/migrations");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  assert(names.length > 0, "orders migrations are missing");
  const parts = [];
  for (const name of names) parts.push(await readFile(join(directory, name), "utf8"));
  const sql = parts.join("\n");
  assert(
    sql.includes("GRANT USAGE ON SCHEMA orders TO coffee_orders_service_rw"),
    "orders migration does not grant schema usage to coffee_orders_service_rw",
  );
  return { sql, names };
}

function hostNodeLaunch() {
  const linker = "/lib64/ld-linux-x86-64.so.2";
  const libDir = "/lib/x86_64-linux-gnu";
  assert(existsSync(linker), "host dynamic linker /lib64/ld-linux-x86-64.so.2 is missing");
  assert(existsSync(libDir), "host library directory /lib/x86_64-linux-gnu is missing");
  const nodeRoot = dirname(dirname(process.execPath));
  assert(existsSync(join(nodeRoot, "bin/node")), "the runner Node prefix does not contain bin/node");
  return { linker, libDir, nodeRoot };
}

async function ensureDependencies() {
  const yaml = join(ROOT, "node_modules/js-yaml/package.json");
  if (!existsSync(yaml)) {
    const stats = await statfs(ROOT);
    assert(stats.bavail * stats.bsize >= 3 * 1024 ** 3, "free disk is below 3 GiB");
    process.stderr.write("orders-slice-verify: pnpm install --frozen-lockfile\n");
    await run("pnpm", ["install", "--frozen-lockfile"], { inherit: true });
  }
  process.stderr.write("orders-slice-verify: tsc -b apps/orders-service\n");
  await run("pnpm", ["exec", "tsc", "-b", "apps/orders-service", "--pretty", "false"], {
    inherit: true,
  });
  assert(
    existsSync(join(ROOT, "apps/orders-service/dist/main.js")),
    "apps/orders-service/dist/main.js was not produced",
  );
  hostNodeLaunch();
  const probe = () => run(process.execPath, ["-e", "require('@confluentinc/kafka-javascript')"]);
  try {
    await probe();
    return;
  } catch (error) {
    process.stderr.write(
      `orders-slice-verify: kafka binding is not loadable by the runner Node (${redact(error.message)})\n`,
    );
  }
  const pkg = dirname(require.resolve("@confluentinc/kafka-javascript/package.json"));
  const prebuild = join(pkg, "node_modules/.bin/node-pre-gyp");
  assert(existsSync(prebuild), "node-pre-gyp is not installed for @confluentinc/kafka-javascript");
  const arBin = join(SECRET_ROOT, "orders-slice-verify-ar");
  await mkdir(arBin, { recursive: true, mode: 0o700 });
  await rm(join(arBin, "ar"), { force: true });
  await symlink(join(dirname(fileURLToPath(import.meta.url)), "ar-mri"), join(arBin, "ar"));
  process.stderr.write("orders-slice-verify: build kafka binding with the runner Node\n");
  await run(prebuild, ["install", "--fallback-to-build"], {
    cwd: pkg,
    inherit: true,
    env: { ...process.env, PATH: `${arBin}:${process.env.PATH ?? ""}` },
  });
  await probe();
  await rm(arBin, { recursive: true, force: true });
}

function header(headers, name) {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function actorToken(privateKey, operationId, correlationId) {
  const now = Math.floor(Date.now() / 1000);
  const trace = randomBytes(16).toString("hex");
  const span = randomBytes(8).toString("hex");
  return signActor(
    {
      iss: "api-public",
      aud: "orders-service",
      originalIssuer: "edge-gateway",
      sub: "actor_orders_slice",
      permissions: [PERMISSION[operationId]],
      operationId,
      correlationId,
      traceparent: `00-${trace}-${span}-01`,
      iat: now,
      exp: now + 30,
      jti: randomUUID(),
      kid: "api-public-delegation-v1",
    },
    privateKey,
  );
}

function httpsCall({ port, ca, cert, key, servername, expectedSan, method, path, headers, body }) {
  return new Promise((resolveCall, rejectCall) => {
    const request = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers,
        ca,
        ...(cert === undefined ? {} : { cert, key }),
        minVersion: "TLSv1.3",
        rejectUnauthorized: true,
        servername,
        checkServerIdentity: (_host, certificate) => {
          const san = String(certificate.subjectaltname ?? "")
            .split(",")
            .map((item) => item.trim())
            .find((item) => item.startsWith("URI:"))
            ?.slice(4);
          return san === expectedSan ? undefined : new Error("peer identity mismatch");
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text.length === 0 ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolveCall({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json,
          });
        });
      },
    );
    request.setTimeout(8_000, () => request.destroy(new Error("timeout")));
    request.on("error", rejectCall);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function itemBody(version) {
  return {
    expectedVersion: version,
    productRef: FIXTURE.productRef,
    variantRef: FIXTURE.variantRef,
    quantity: "1",
    quoteRef: FIXTURE.quoteRef,
    quoteLineNumber: 1,
    quoteHash: FIXTURE.quoteHash,
  };
}

function composeFile(input) {
  const q = JSON.stringify;
  const labels = `com.coffee.slice: ${LABEL}\n      com.coffee.slice.run: ${input.runId}`;
  const kafkaEnv = {
    KAFKA_NODE_ID: "1",
    KAFKA_PROCESS_ROLES: "broker,controller",
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL",
    KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:29093",
    KAFKA_LISTENERS: "SASL_SSL://:9092,CONTROLLER://:29093",
    KAFKA_ADVERTISED_LISTENERS: "SASL_SSL://kafka:9092",
    KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
    KAFKA_INTER_BROKER_LISTENER_NAME: "SASL_SSL",
    KAFKA_SSL_KEYSTORE_TYPE: "PKCS12",
    KAFKA_SSL_KEYSTORE_FILENAME: "kafka.keystore.p12",
    KAFKA_SSL_KEY_CREDENTIALS: "kafka.keystore.password",
    KAFKA_SSL_KEYSTORE_CREDENTIALS: "kafka.keystore.password",
    KAFKA_SSL_TRUSTSTORE_TYPE: "PKCS12",
    KAFKA_SSL_TRUSTSTORE_FILENAME: "kafka.truststore.p12",
    KAFKA_SSL_TRUSTSTORE_CREDENTIALS: "kafka.keystore.password",
    KAFKA_SSL_CLIENT_AUTH: "requested",
    KAFKA_SASL_ENABLED_MECHANISMS: "PLAIN",
    KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL: "PLAIN",
    KAFKA_OPTS: "-Djava.security.auth.login.config=/etc/kafka/secrets/kafka_jaas.conf",
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
    KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false",
    KAFKA_NUM_PARTITIONS: "3",
    KAFKA_LOG_DIRS: "/var/lib/kafka/data",
    KAFKA_HEAP_OPTS: "-Xms256m -Xmx512m",
  };
  const kafkaEnvironment = Object.entries(kafkaEnv)
    .map(([key, value]) => `      ${key}: ${q(value)}`)
    .join("\n");
  return `name: ${input.project}
services:
  postgres:
    image: ${POSTGRES_IMAGE}
    pull_policy: missing
    container_name: ${input.project}-postgres
    init: true
    restart: "no"
    mem_limit: 1g
    environment:
      POSTGRES_USER: slice_admin
      POSTGRES_DB: ${input.database}
      POSTGRES_PASSWORD_FILE: /run/pg/password
      PGDATA: /var/lib/postgresql/orders-slice
    volumes:
      - type: bind
        source: ${q(input.passwordFile)}
        target: /run/pg/password
        read_only: true
    tmpfs:
      - /var/lib/postgresql/orders-slice:rw,nosuid,size=512m
    networks:
      default:
        aliases: [coffee_postgres]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U slice_admin -d ${input.database}"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 10s
    labels:
      ${labels}
  kafka:
    image: ${input.kafkaImage}
    pull_policy: missing
    container_name: ${input.project}-kafka
    init: true
    restart: "no"
    user: "1000:1000"
    mem_limit: 1536m
    environment:
${kafkaEnvironment}
    volumes:
      - type: bind
        source: ${q(input.kafkaDir)}
        target: /etc/kafka/secrets
        read_only: true
    tmpfs:
      - /var/lib/kafka/data:rw,uid=1000,gid=1000,mode=0700,size=536870912
    networks:
      default:
        aliases: [kafka]
    labels:
      ${labels}
  internal:
    image: ${NODE_IMAGE}
    pull_policy: missing
    container_name: ${input.project}-internal
    init: true
    restart: "no"
    user: "1000:1000"
    working_dir: ${q(ROOT)}
    command: ["node", ".cursor/skills/orders-slice-verify/internal-fixture.mjs"]
    mem_limit: 256m
    environment:
      HOME: /tmp
      FIXTURE_CA: /run/fixture/ca.crt
      FIXTURE_CERT: /run/fixture/api-internal.crt
      FIXTURE_KEY: /run/fixture/api-internal.key
      FIXTURE_CUSTOMER_REF: ${q(FIXTURE.customerRef)}
      FIXTURE_DISPLAY_NAME: ${q(FIXTURE.displayName)}
      FIXTURE_PEER_SAN: ${q(input.peerSan)}
      FIXTURE_OFFER_REF: ${q(FIXTURE.offerRef)}
      FIXTURE_POLICY_REF: ${q(FIXTURE.policyRef)}
    volumes:
      - type: bind
        source: ${q(ROOT)}
        target: ${q(ROOT)}
        read_only: true
      - type: bind
        source: ${q(input.certDir)}
        target: /run/fixture
        read_only: true
    tmpfs:
      - /tmp:rw,nosuid,size=32m
    networks:
      default:
        aliases: [api-internal]
    labels:
      ${labels}
  orders:
    image: ${NODE_IMAGE}
    pull_policy: missing
    container_name: ${input.project}-orders
    restart: "no"
    user: "1000:1000"
    working_dir: ${q(ROOT)}
    entrypoint: [${q(input.host.linker)}]
    command: ["--library-path", ${q(input.host.libDir)}, "/host-node/bin/node", "apps/orders-service/dist/main.js"]
    mem_limit: 768m
    stop_grace_period: 15s
    security_opt: ["no-new-privileges:true"]
    environment:
      COFFEE_CONFIG_FILE: ${q(join(ROOT, "config/platform.yaml"))}
      COFFEE_RUNTIME_SECRETS_FILE: /run/secrets/coffee-platform.yaml
      HOME: /tmp
    volumes:
      - type: bind
        source: ${q(ROOT)}
        target: ${q(ROOT)}
        read_only: true
      - type: bind
        source: ${q(input.secretsFile)}
        target: /run/secrets/coffee-platform.yaml
        read_only: true
      - type: bind
        source: ${q("/lib64")}
        target: /lib64
        read_only: true
      - type: bind
        source: ${q(input.host.libDir)}
        target: ${q(input.host.libDir)}
        read_only: true
      - type: bind
        source: ${q(input.host.nodeRoot)}
        target: /host-node
        read_only: true
    tmpfs:
      - /tmp:rw,nosuid,size=64m
    ports: ["127.0.0.1:${input.port}:4104"]
    networks: [default]
    labels:
      ${labels}
networks:
  default:
    name: ${input.project}-net
    labels:
      com.coffee.slice: ${LABEL}
      com.coffee.slice.run: ${input.runId}
`;
}

function counts(scenarios) {
  return {
    passed: scenarios.filter((item) => item.status === "pass").length,
    failed: scenarios.filter((item) => item.status === "fail").length,
    notCovered: scenarios.filter((item) => item.status === "not-covered").length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "node .cursor/skills/orders-slice-verify/run.mjs [--keep]\nnode .cursor/skills/orders-slice-verify/run.mjs --down <run-id>\n",
    );
    return 0;
  }
  if (args[0] === "--down") {
    const runId = args[1];
    assert(args.length === 2 && RUN_ID_PATTERN.test(runId ?? ""), "--down requires one run id");
    await tearDown(runId);
    process.stderr.write(`orders-slice-verify: removed orders-slice-verify-${runId}\n`);
    return 0;
  }
  assert(args.length === 0 || (args.length === 1 && args[0] === "--keep"), "unknown arguments");
  const keep = args[0] === "--keep";
  await run("docker", ["ps", "-q"]);
  await ensureDependencies();
  const { environment, database, kafkaImage } = await loadConfig();
  const migrations = await migrationSql();
  const runId = newRunId();
  const project = projectName(runId);
  const port = await freePort();
  await assertTmpfs(SECRET_ROOT);
  const directory = secretDirectory(project);
  const evidenceDir = join(ROOT, "evidence/orders-slice-verify", runId);
  const httpLog = [];
  const dbLog = {};
  const scenarios = [];
  const world = {};
  let overall = "fail";
  const writeResult = async (status) => {
    for (const item of NOT_COVERED) {
      if (!scenarios.some((scenario) => scenario.id === item.id)) {
        scenarios.push({ ...item, status: "not-covered" });
      }
    }
    const tally = counts(scenarios);
    const requiredDone = REQUIRED.every((id) =>
      scenarios.some((scenario) => scenario.id === id && scenario.status === "pass"),
    );
    const failed = scenarios.some((scenario) => scenario.status === "fail") || status === "fail";
    overall = failed ? "fail" : status === "pass" && requiredDone ? "pass" : "incomplete";
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(evidenceDir, "result.json"),
      `${JSON.stringify({ slice: "orders-service", boundary: database, runId, status: overall, ...tally, scenarios }, null, 2)}\n`,
    );
    await writeFile(
      join(evidenceDir, "http.ndjson"),
      `${httpLog.map((line) => JSON.stringify(line)).join("\n")}${httpLog.length ? "\n" : ""}`,
    );
    await writeFile(join(evidenceDir, "db.json"), `${JSON.stringify(dbLog, null, 2)}\n`);
    return overall;
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertTmpfs(directory);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const password = remember(randomBytes(24).toString("hex"));
    const rolePassword = remember(randomBytes(24).toString("hex"));
    const passwordFile = join(directory, "pg-password");
    const secretsFile = join(directory, "orders-service.yaml");
    const composePath = join(directory, "compose.yaml");
    const certDir = join(directory, "certs");
    const kafkaDir = join(directory, "kafka");
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
    await ownRuntime(passwordFile, 0o400);
    const transport = await createTransport(certDir, environment);
    for (const name of await readdir(certDir)) await ownRuntime(join(certDir, name), 0o400);
    await ownRuntime(certDir, 0o700);
    const kafka = await kafkaMaterial(kafkaDir);
    const delegation = keyPair();
    remember(delegation.privatePem);
    remember(transport.server.keyPem);
    remember(transport.apiPublic.keyPem);
    remember(transport.catalog.keyPem);
    remember(transport.internal.keyPem);
    const signing = keyPair();
    remember(signing.privatePem);
    const document = {
      schemaVersion: 1,
      environment,
      runtime: "orders-service",
      secrets: {
        postgres: {
          ordersService: { username: ROLES[0], password: rolePassword },
        },
        kafka: { orders: kafka },
        security: {
          ordersServiceDelegationSigningPrivateKey: signing.privatePem,
          delegationVerificationKeys: {
            "api-public": {
              active: delegation.publicPem,
              previous: keyPair().publicPem,
            },
          },
          serviceTransportKeys: {
            "orders-service": JSON.stringify({
              caPem: transport.caPem,
              certPem: transport.server.certPem,
              keyPem: transport.server.keyPem,
            }),
          },
        },
        telemetry: { exporterToken: remember(randomBytes(24).toString("hex")) },
      },
    };
    await writeFile(secretsFile, `${JSON.stringify(document)}\n`, { mode: 0o600 });
    await ownRuntime(secretsFile, 0o400);
    const peerSan = `spiffe://coffee-platform/${environment}/orders-service`;
    await writeFile(
      composePath,
      composeFile({
        project,
        runId,
        port,
        database,
        kafkaImage,
        passwordFile,
        secretsFile,
        certDir,
        kafkaDir,
        peerSan,
        host: hostNodeLaunch(),
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(evidenceDir, "run.json"),
      `${JSON.stringify(
        {
          runId,
          project,
          network: `${project}-net`,
          containers: [
            `${project}-postgres`,
            `${project}-kafka`,
            `${project}-internal`,
            `${project}-orders`,
          ],
          port,
          database,
          migrations: migrations.names,
          topics: TOPICS.map(([name]) => name),
        },
        null,
        2,
      )}\n`,
    );
    let head = null;
    try {
      head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      head = null;
    }
    let dirty = true;
    try {
      dirty = (await run("git", ["status", "--porcelain"])).stdout.trim().length > 0;
    } catch {
      dirty = true;
    }
    await writeFile(
      join(evidenceDir, "environment.json"),
      `${JSON.stringify(
        {
          slice: "orders-service",
          boundary: `orders-service -> PostgreSQL ${database} + Kafka SASL_SSL + fixture api-internal`,
          images: { postgres: POSTGRES_IMAGE, node: NODE_IMAGE, kafka: kafkaImage },
          hostPort: port,
          containerPort: 4104,
          databasePublished: false,
          kafkaPublished: false,
          providersCalled: [],
          project,
          node: process.version,
          commit: head,
          dirty,
          migrationFiles: migrations.names.length,
        },
        null,
        2,
      )}\n`,
    );
    const servername = `orders-service.${environment}.svc.coffee-platform.internal`;
    const expectedSan = peerSan;
    const call = async (
      scenario,
      {
        method,
        path,
        body,
        operationId,
        material = transport.apiPublic,
        correlationId = randomUUID(),
        idempotencyKey,
        extraHeaders,
      },
    ) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { "x-correlation-id": correlationId, ...(extraHeaders ?? {}) };
      if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
      if (operationId !== undefined) {
        headers["x-actor-context"] = actorToken(
          delegation.privateKey,
          operationId,
          correlationId,
        );
      }
      if (payload !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(Buffer.byteLength(payload));
      }
      let outcome;
      try {
        outcome = await httpsCall({
          port,
          ca: transport.caPem,
          cert: material?.certPem,
          key: material?.keyPem,
          servername,
          expectedSan,
          method,
          path,
          headers,
          body: payload,
        });
      } catch (error) {
        outcome = { status: 0, headers: {}, text: "", json: null, error: error?.code ?? "error" };
      }
      httpLog.push({
        scenario,
        method,
        path,
        status: outcome.status,
        error: outcome.error ?? null,
        request: body ?? null,
        response: outcome.json ?? (outcome.text ? outcome.text.slice(0, 500) : null),
        contentType: header(outcome.headers, "content-type") ?? null,
        idempotencyReplayed: header(outcome.headers, "idempotency-replayed") ?? null,
      });
      return outcome;
    };
    const snapshot = async (scenario) => {
      const { stdout } = await run(
        "docker",
        [
          "exec",
          "-i",
          `${project}-postgres`,
          "psql",
          "-U",
          "slice_admin",
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-q",
          "-t",
          "-A",
          "--no-psqlrc",
        ],
        {
          input: `SELECT json_build_object(
            'orders', (SELECT count(*)::int FROM orders.orders),
            'items', (SELECT count(*)::int FROM orders.order_items),
            'history', (SELECT count(*)::int FROM orders.order_history),
            'idempotencyCompleted', (SELECT count(*)::int FROM orders.idempotency_records WHERE state = 'Completed'),
            'idempotencyRows', (SELECT count(*)::int FROM orders.idempotency_records),
            'outbox', (SELECT count(*)::int FROM orders.outbox_messages),
            'outboxPublished', (SELECT count(*)::int FROM orders.outbox_messages WHERE state = 'Published'),
            'messageTypes', COALESCE((SELECT json_agg(message_type ORDER BY aggregate_sequence) FROM orders.outbox_messages), '[]'::json),
            'status', (SELECT status FROM orders.orders LIMIT 1),
            'version', (SELECT version::text FROM orders.orders LIMIT 1),
            'orderRef', (SELECT order_ref FROM orders.orders LIMIT 1)
          );\n`,
        },
      );
      const row = JSON.parse(stdout.trim());
      dbLog[scenario] = row;
      return row;
    };
    async function waitHealthy(container) {
      const deadline = Date.now() + 60_000;
      let status = "missing";
      while (Date.now() < deadline) {
        try {
          status = (
            await run("docker", [
              "inspect",
              "--format",
              "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
              container,
            ])
          ).stdout.trim();
        } catch {
          status = "missing";
        }
        if (status === "healthy") return;
        if (status === "exited" || status === "dead") break;
        await delay(500);
      }
      throw new Error(`${container} did not become healthy (${status})`);
    }
    async function waitLogs(container, needle, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const logs = await run("docker", ["logs", container]).catch((error) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        }));
        if (`${logs.stdout}${logs.stderr}`.includes(needle)) return;
        const state = await run("docker", ["inspect", "--format", "{{.State.Status}}", container])
          .then((result) => result.stdout.trim())
          .catch(() => "missing");
        if (state === "exited" || state === "dead") break;
        await delay(500);
      }
      throw new Error(`${container} did not log ${needle}`);
    }
    async function waitKafka() {
      const deadline = Date.now() + 90_000;
      let last = "not-started";
      while (Date.now() < deadline) {
        try {
          await run(
            "docker",
            [
              "exec",
              `${project}-kafka`,
              "/opt/kafka/bin/kafka-topics.sh",
              "--bootstrap-server",
              "kafka:9092",
              "--command-config",
              "/etc/kafka/secrets/client.properties",
              "--list",
            ],
            { timeoutMs: 15_000 },
          );
          return;
        } catch (error) {
          last = redact(error.stderr || error.message).slice(0, 300);
        }
        const state = await run("docker", ["inspect", "--format", "{{.State.Status}}", `${project}-kafka`])
          .then((result) => result.stdout.trim())
          .catch(() => "missing");
        if (state === "exited" || state === "dead") break;
        await delay(1000);
      }
      throw new Error(`kafka did not accept SASL_SSL (${last})`);
    }
    async function waitReady() {
      const deadline = Date.now() + 60_000;
      let last = "not-started";
      while (Date.now() < deadline) {
        const health = await call("startup", { method: "GET", path: "/health/ready" });
        last = health.error ?? `${health.status} ${health.json?.status ?? ""}`;
        if (health.status === 200 && health.json?.status === "ready") return health;
        const state = await run("docker", ["inspect", "--format", "{{.State.Status}}", `${project}-orders`])
          .then((result) => result.stdout.trim())
          .catch(() => "missing");
        if (state === "exited" || state === "dead") break;
        await delay(500);
      }
      throw new Error(`orders-service did not become ready (${last})`);
    }
    await ensureImage(POSTGRES_IMAGE);
    await ensureImage(NODE_IMAGE);
    await ensureImage(kafkaImage);
    process.stderr.write(`orders-slice-verify: up ${project} on 127.0.0.1:${port}\n`);
    await run("docker", ["compose", "-p", project, "-f", composePath, "up", "-d", "postgres", "kafka", "internal"]);
    await waitHealthy(`${project}-postgres`);
    await waitLogs(`${project}-internal`, "fixture listening", 30_000);
    await waitKafka();
    for (const [topic, partitions] of TOPICS) {
      await run("docker", [
        "exec",
        `${project}-kafka`,
        "/opt/kafka/bin/kafka-topics.sh",
        "--bootstrap-server",
        "kafka:9092",
        "--command-config",
        "/etc/kafka/secrets/client.properties",
        "--create",
        "--if-not-exists",
        "--topic",
        topic,
        "--partitions",
        partitions,
        "--replication-factor",
        "1",
      ]);
    }
    const roleSql = ROLES.map((role, index) =>
      index === 0
        ? `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${rolePassword}';\nGRANT CONNECT ON DATABASE "${database}" TO "${role}";`
        : `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`,
    ).join("\n");
    const bootstrap = `${roleSql}\nREVOKE ALL ON DATABASE "${database}" FROM PUBLIC;\n${migrations.sql}\n`;
    await run(
      "docker",
      [
        "exec",
        "-i",
        `${project}-postgres`,
        "psql",
        "-U",
        "slice_admin",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "--no-psqlrc",
      ],
      { input: bootstrap },
    );
    await run("docker", ["compose", "-p", project, "-f", composePath, "up", "-d", "orders"]);
    const ready = await waitReady();
    const published = (
      await run("docker", ["port", `${project}-orders`, "4104/tcp"])
    ).stdout.trim();
    const owned = (
      await run("docker", [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.coffee.slice.run"}}',
        `${project}-orders`,
      ])
    ).stdout.trim();
    const doctor = {
      ok:
        ready.status === 200 &&
        ready.json?.status === "ready" &&
        ready.json?.runtime === "orders-service" &&
        published.includes(`127.0.0.1:${port}`) &&
        owned === runId,
      httpStatus: ready.status,
      runtime: ready.json?.runtime ?? null,
      readyStatus: ready.json?.status ?? null,
      portOwned: published.includes(`127.0.0.1:${port}`) && owned === runId,
      migrationFiles: migrations.names.length,
    };
    await writeFile(join(evidenceDir, "doctor.json"), `${JSON.stringify(doctor, null, 2)}\n`);
    assert(doctor.ok, `doctor failed ${JSON.stringify(doctor)}`);

    const plan = [
      ["empty-ready", "Пустая база: сервис готов", async () => {
        const health = await call("empty-ready", { method: "GET", path: "/health/ready" });
        assert(
          health.status === 200 &&
            health.json?.status === "ready" &&
            health.json?.runtime === "orders-service",
          `ready returned ${health.status}`,
        );
        const db = await snapshot("empty-ready");
        assert(
          db.orders === 0 && db.items === 0 && db.outbox === 0 && db.idempotencyRows === 0,
          "empty database was not empty",
        );
      }],
      ["create-draft", "Создание черновика сохраняет строку владельца", async () => {
        const created = { customerRef: FIXTURE.customerRef };
        const bare = await httpsCall({
          port,
          ca: transport.caPem,
          servername,
          expectedSan,
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(JSON.stringify(created))),
          },
          body: JSON.stringify(created),
        })
          .then(() => ({ status: 1 }))
          .catch(() => ({ status: 0 }));
        httpLog.push({
          scenario: "create-draft",
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          status: bare.status,
          error: bare.status === 0 ? "tls-rejected" : null,
          request: created,
          response: null,
          contentType: null,
          idempotencyReplayed: null,
        });
        assert(bare.status === 0, "request without a client certificate was accepted");
        const foreign = await call("create-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: created,
          operationId: "createOrderDraft",
          material: transport.catalog,
          idempotencyKey: randomUUID(),
        });
        assert(
          foreign.status === 401 && foreign.json?.code === "AUTHENTICATION_REQUIRED",
          `foreign certificate returned ${foreign.status} ${foreign.json?.code}`,
        );
        const unsigned = await call("create-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: created,
          idempotencyKey: randomUUID(),
        });
        assert(
          unsigned.status === 401 && unsigned.json?.code === "AUTHENTICATION_REQUIRED",
          `unsigned create returned ${unsigned.status}`,
        );
        const invalid = await call("create-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: {},
          operationId: "createOrderDraft",
          idempotencyKey: randomUUID(),
        });
        assert(
          invalid.status === 400 && invalid.json?.code === "VALIDATION_FAILED",
          `invalid body returned ${invalid.status} ${invalid.json?.code}`,
        );
        const rejected = await snapshot("create-draft-rejected");
        assert(rejected.orders === 0 && rejected.idempotencyRows === 0, "rejected requests wrote rows");
        const key = randomUUID();
        const response = await call("create-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: created,
          operationId: "createOrderDraft",
          idempotencyKey: key,
        });
        assert(response.status === 201, `create returned ${response.status} ${response.json?.code ?? ""}`);
        assert(/^ord_[0-9A-HJKMNP-TV-Z]{26}$/u.test(response.json?.orderRef ?? ""), "orderRef is missing");
        assert(response.json?.status === "Draft" && response.json?.version === "1", "draft version is not 1");
        assert(response.json?.customer?.customerRef === FIXTURE.customerRef, "customer snapshot mismatch");
        assert(response.json?.customer?.displayName === FIXTURE.displayName, "display name mismatch");
        assert(response.json?.items?.length === 0, "new draft is not empty");
        assert(header(response.headers, "idempotency-replayed") === undefined, "first create was marked replayed");
        const db = await snapshot("create-draft");
        assert(
          db.orders === 1 &&
            db.items === 0 &&
            db.idempotencyCompleted === 1 &&
            db.outbox === 0 &&
            db.status === "Draft" &&
            db.version === "1" &&
            db.orderRef === response.json.orderRef,
          "owner rows after create did not match",
        );
        world.orderRef = response.json.orderRef;
        world.version = response.json.version;
        world.createKey = key;
        world.createBody = created;
      }],
      ["replay-draft", "Повтор того же создания не создаёт второй заказ", async () => {
        const replay = await call("replay-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: world.createBody,
          operationId: "createOrderDraft",
          idempotencyKey: world.createKey,
        });
        assert(
          replay.status === 201 && replay.json?.orderRef === world.orderRef,
          `replay returned ${replay.status}`,
        );
        assert(header(replay.headers, "idempotency-replayed") === "true", "replay was not marked");
        const conflict = await call("replay-draft", {
          method: "POST",
          path: "/api/client-v1/orders/drafts",
          body: { customerRef: FIXTURE.otherCustomerRef },
          operationId: "createOrderDraft",
          idempotencyKey: world.createKey,
        });
        assert(
          conflict.status === 409 && conflict.json?.code === "IDEMPOTENCY_CONFLICT",
          `idempotency conflict returned ${conflict.status} ${conflict.json?.code}`,
        );
        const db = await snapshot("replay-draft");
        assert(db.orders === 1 && db.idempotencyRows === 1 && db.orderRef === world.orderRef, "replay changed owner rows");
      }],
      ["put-item", "Позиция черновика сохраняется после проверки цены", async () => {
        const response = await call("put-item", {
          method: "PUT",
          path: `/api/client-v1/orders/${world.orderRef}/items/${FIXTURE.itemRef}`,
          body: itemBody(world.version),
          operationId: "upsertOrderItem",
          idempotencyKey: randomUUID(),
        });
        assert(response.status === 200, `put returned ${response.status} ${response.json?.code ?? ""}`);
        assert(response.json?.items?.length === 1, "put did not store one item");
        assert(response.json.items[0].itemRef === FIXTURE.itemRef, "itemRef mismatch");
        assert(response.json.items[0].displayName === FIXTURE.displayName, "item name mismatch");
        world.version = response.json.version;
        const db = await snapshot("put-item");
        assert(db.items === 1 && db.status === "Draft" && db.version === world.version, "item row mismatch");
      }],
      ["get-card", "Чтение карточки возвращает тот же черновик", async () => {
        const response = await call("get-card", {
          method: "GET",
          path: `/api/client-v1/orders/${world.orderRef}`,
          operationId: "getOrderCard",
        });
        assert(response.status === 200, `get returned ${response.status} ${response.json?.code ?? ""}`);
        assert(
          response.json?.orderRef === world.orderRef &&
            response.json?.status === "Draft" &&
            response.json?.version === world.version &&
            response.json?.items?.length === 1 &&
            response.json?.aroma?.state === "NotRequested",
          "card did not match the stored draft",
        );
        const db = await snapshot("get-card");
        assert(db.orders === 1 && db.items === 1, "get changed owner rows");
      }],
      ["delete-item", "Удаление позиции оставляет пустой черновик", async () => {
        const response = await call("delete-item", {
          method: "DELETE",
          path: `/api/client-v1/orders/${world.orderRef}/items/${FIXTURE.itemRef}`,
          operationId: "removeOrderItem",
          idempotencyKey: randomUUID(),
          extraHeaders: { "if-match-version": world.version },
        });
        assert(response.status === 200, `delete returned ${response.status} ${response.json?.code ?? ""}`);
        assert(response.json?.items?.length === 0 && response.json?.status === "Draft", "delete left an item");
        world.version = response.json.version;
        const db = await snapshot("delete-item");
        assert(db.items === 0 && db.status === "Draft" && db.outbox === 0, "delete row mismatch");
      }],
      ["confirm-empty", "Пустой черновик не подтверждается", async () => {
        const before = await snapshot("confirm-empty-before");
        const response = await call("confirm-empty", {
          method: "POST",
          path: `/api/client-v1/orders/${world.orderRef}/commands/confirm`,
          body: { expectedVersion: world.version },
          operationId: "confirmOrder",
          idempotencyKey: randomUUID(),
        });
        assert(
          response.status === 422 && response.json?.code === "ORDER_EMPTY",
          `empty confirm returned ${response.status} ${response.json?.code}`,
        );
        const db = await snapshot("confirm-empty");
        assert(
          db.status === "Draft" &&
            db.version === world.version &&
            db.items === 0 &&
            db.outbox === 0 &&
            db.idempotencyRows === before.idempotencyRows,
          "empty confirm changed the draft",
        );
      }],
      ["confirm-order", "Подтверждение пишет Confirmed и публикует OrderConfirmed.v1", async () => {
        const put = await call("confirm-order", {
          method: "PUT",
          path: `/api/client-v1/orders/${world.orderRef}/items/${FIXTURE.itemRef}`,
          body: itemBody(world.version),
          operationId: "upsertOrderItem",
          idempotencyKey: randomUUID(),
        });
        assert(put.status === 200 && put.json?.items?.length === 1, `restore put returned ${put.status}`);
        world.version = put.json.version;
        const key = randomUUID();
        const response = await call("confirm-order", {
          method: "POST",
          path: `/api/client-v1/orders/${world.orderRef}/commands/confirm`,
          body: { expectedVersion: world.version },
          operationId: "confirmOrder",
          idempotencyKey: key,
        });
        assert(response.status === 200, `confirm returned ${response.status} ${response.json?.code ?? ""}`);
        assert(response.json?.status === "Confirmed", "confirm did not set Confirmed");
        assert(header(response.headers, "idempotency-replayed") === undefined, "first confirm was marked replayed");
        world.version = response.json.version;
        const replay = await call("confirm-order", {
          method: "POST",
          path: `/api/client-v1/orders/${world.orderRef}/commands/confirm`,
          body: { expectedVersion: put.json.version },
          operationId: "confirmOrder",
          idempotencyKey: key,
        });
        assert(replay.status === 200 && replay.json?.status === "Confirmed", `confirm replay returned ${replay.status}`);
        assert(header(replay.headers, "idempotency-replayed") === "true", "confirm replay was not marked");
        const conflict = await call("confirm-order", {
          method: "POST",
          path: `/api/client-v1/orders/${world.orderRef}/commands/confirm`,
          body: { expectedVersion: world.version },
          operationId: "confirmOrder",
          idempotencyKey: key,
        });
        assert(
          conflict.status === 409 && conflict.json?.code === "IDEMPOTENCY_CONFLICT",
          `confirm conflict returned ${conflict.status} ${conflict.json?.code}`,
        );
        let db = await snapshot("confirm-order");
        const deadline = Date.now() + 30_000;
        while (db.outboxPublished !== 1 && Date.now() < deadline) {
          await delay(500);
          db = await snapshot("confirm-order");
        }
        assert(
          db.status === "Confirmed" &&
            db.version === world.version &&
            db.items === 1 &&
            db.outbox === 1 &&
            db.outboxPublished === 1 &&
            db.messageTypes?.[0] === "OrderConfirmed.v1",
          `outbox after confirm was ${JSON.stringify({ status: db.status, outbox: db.outbox, published: db.outboxPublished, types: db.messageTypes })}`,
        );
        const consumed = await run(
          "docker",
          [
            "exec",
            `${project}-kafka`,
            "/opt/kafka/bin/kafka-console-consumer.sh",
            "--bootstrap-server",
            "kafka:9092",
            "--topic",
            "coffee.orders.lifecycle.v1",
            "--from-beginning",
            "--max-messages",
            "1",
            "--timeout-ms",
            "20000",
            "--command-config",
            "/etc/kafka/secrets/client.properties",
          ],
          { timeoutMs: 30_000 },
        );
        const line = consumed.stdout
          .split("\n")
          .map((item) => item.trim())
          .find((item) => item.startsWith("{"));
        const message = JSON.parse(line ?? "");
        const event = {
          topic: "coffee.orders.lifecycle.v1",
          messageType: message.messageType ?? null,
          orderRefMatches:
            message.payload?.orderRef === world.orderRef || message.aggregate?.ref === world.orderRef,
        };
        dbLog["confirm-order-kafka"] = event;
        assert(
          event.messageType === "OrderConfirmed.v1" && event.orderRefMatches === true,
          "kafka message did not match the confirmed order",
        );
      }],
      ["reconcile-blocked", "Сверка до наблюдения отклоняется и не пишет событие", async () => {
        const response = await call("reconcile-blocked", {
          method: "POST",
          path: `/api/client-v1/orders/${world.orderRef}/commands/request-aroma-reconciliation`,
          body: { expectedVersion: world.version, reason: "slice" },
          operationId: "requestAromaReconciliation",
          idempotencyKey: randomUUID(),
        });
        assert(
          response.status === 409 && response.json?.code === "AROMA_RECONCILIATION_NOT_ALLOWED",
          `reconcile returned ${response.status} ${response.json?.code}`,
        );
        const db = await snapshot("reconcile-blocked");
        assert(
          db.status === "Confirmed" &&
            db.version === world.version &&
            db.outbox === 1 &&
            db.messageTypes?.length === 1 &&
            db.messageTypes[0] === "OrderConfirmed.v1",
          "blocked reconcile wrote another event",
        );
      }],
    ];

    for (const [id, title, runScenario] of plan) {
      try {
        await runScenario();
        scenarios.push({ id, title, status: "pass" });
      } catch (error) {
        scenarios.push({ id, title, status: "fail", detail: detail(error) });
        const index = plan.findIndex((item) => item[0] === id);
        for (const [restId, restTitle] of plan.slice(index + 1)) {
          scenarios.push({ id: restId, title: restTitle, status: "not-run" });
        }
        throw error;
      }
      await writeResult("incomplete");
    }
    const result = await writeResult("pass");
    const tally = counts(scenarios);
    process.stdout.write(
      `orders-slice-verify ${runId} ${result} ${tally.passed} passed, ${tally.failed} failed, ${tally.notCovered} not-covered\n`,
    );
    return result === "pass" ? 0 : 1;
  } catch (error) {
    if (!scenarios.some((item) => item.status === "fail")) {
      scenarios.push({ id: "run", title: "Прогон", status: "fail", detail: detail(error) });
    }
    await writeResult("fail").catch(() => {});
    process.stderr.write(`${detail(error)}\n`);
    const tally = counts(scenarios);
    process.stdout.write(
      `orders-slice-verify ${runId} fail ${tally.passed} passed, ${tally.failed} failed, ${tally.notCovered} not-covered\n`,
    );
    return 1;
  } finally {
    await saveLogs(`${project}-orders`, join(evidenceDir, "service.log"));
    await saveLogs(`${project}-internal`, join(evidenceDir, "fixture.log"));
    await saveLogs(`${project}-kafka`, join(evidenceDir, "kafka.log"));
    if (!keep) await tearDown(runId);
    else process.stderr.write(`orders-slice-verify: kept ${project}; remove with node .cursor/skills/orders-slice-verify/run.mjs --down ${runId}\n`);
  }
}

async function ensureImage(image) {
  try {
    await run("docker", ["image", "inspect", image]);
  } catch {
    process.stderr.write(`orders-slice-verify: pull ${image.split("@")[0]}\n`);
    await run("docker", ["pull", image], { inherit: true });
  }
}

async function saveLogs(container, file) {
  try {
    const { stdout, stderr } = await run("docker", ["logs", container]);
    const text = redact(`${stdout}${stderr}`);
    await writeFile(file, text.length > 200_000 ? text.slice(-200_000) : text);
  } catch {
    await writeFile(file, "").catch(() => {});
  }
}

async function tearDown(runId) {
  assertSafe(runId, RUN_ID_PATTERN, "run id");
  const project = projectName(runId);
  const directory = secretDirectory(project);
  const composePath = join(directory, "compose.yaml");
  if (existsSync(composePath)) {
    await run("docker", [
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "down",
      "--volumes",
      "--remove-orphans",
    ]).catch((error) => {
      process.stderr.write(
        `orders-slice-verify: compose down warning ${redact(error.stderr || error.message).slice(0, 500)}\n`,
      );
    });
  }
  let ids = "";
  try {
    ids = (
      await run("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=com.coffee.slice=${LABEL}`,
        "--filter",
        `label=com.coffee.slice.run=${runId}`,
      ])
    ).stdout;
  } catch {
    ids = "";
  }
  for (const id of ids.split("\n").filter(Boolean)) {
    const name = (await run("docker", ["inspect", "--format", "{{.Name}}", id])).stdout
      .trim()
      .replace(/^\//u, "");
    assert(name.startsWith(`${project}-`), `refusing to remove ${name}`);
    await run("docker", ["rm", "-f", id]);
  }
  await removeNetwork(`${project}-net`, runId);
  await removeProjectVolumes(project);
  if (existsSync(directory)) {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) await rm(directory);
    else {
      await assertTmpfs(directory);
      await chmod(directory, 0o700);
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function removeNetwork(name, runId) {
  let labels = "";
  try {
    labels = (
      await run("docker", [
        "network",
        "inspect",
        "--format",
        '{{index .Labels "com.coffee.slice"}}|{{index .Labels "com.coffee.slice.run"}}',
        name,
      ])
    ).stdout.trim();
  } catch {
    return;
  }
  assert(labels === `${LABEL}|${runId}`, `refusing to remove network ${name}`);
  await run("docker", ["network", "rm", name]).catch(() => {});
}

async function removeProjectVolumes(project) {
  assert(project.startsWith("orders-slice-verify-"), "refusing to remove foreign volumes");
  let names = "";
  try {
    names = (
      await run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`])
    ).stdout;
  } catch {
    return;
  }
  for (const name of names.split("\n").filter(Boolean)) {
    const projectLabel = (
      await run("docker", [
        "volume",
        "inspect",
        "--format",
        '{{index .Labels "com.docker.compose.project"}}',
        name,
      ])
    ).stdout.trim();
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
