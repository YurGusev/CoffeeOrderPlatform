#!/usr/bin/env node
/**
 * Рычаг среза customer-service ↔ его PostgreSQL.
 *
 * Поднимает только проект grokverify-customer-<run> с пустой tmpfs-базой,
 * гоняет HTTP-контракт сервиса и сверяет строки владельца. Чужие контейнеры,
 * тома и сети не останавливает и не удаляет. Секреты прогона остаются в
 * проверенном tmpfs /dev/shm и стираются вместе с контейнерами; в evidence
 * попадают только ответы и обезличенные счётчики.
 */

import { spawn } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, join, resolve, sep } from "node:path";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POSTGRES_IMAGE =
  "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const NODE_IMAGE =
  "node:26.8.1-bookworm-slim@sha256:27f5e13512830beb5d9a574108daa6701a0a0b91528aeaf1ee84ecdcddaeeaae";
const PHONE = "+79161234567";
const OTHER_PHONE = "+79031234567";
const RUN_ID_PATTERN = /^[0-9]{8}t[0-9]{6}z-[0-9a-f]{6}$/u;
const SECRET_ROOT = "/dev/shm";
const TMPFS_MAGIC = 0x01021994;
const RUNTIME_UID = 1000;
const RUNTIME_GID = 1000;
const REQUIRED_SCENARIOS = [
  "empty-ready",
  "create-customer",
  "search-customer",
  "replay-create",
  "duplicate-email",
];

const secrets = [];

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

function run(command, args, { input, cwd = ROOT, inherit = false } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
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
  if (Array.isArray(value))
    return `[${value.map((entry) => canonical(entry)).join(",")}]`;
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
  return `grokverify-customer-${runId}`;
}

function canListen(port) {
  return new Promise((resolveListen) => {
    const server = createServer();
    server.unref();
    server.on("error", () => resolveListen(false));
    server.listen({ host: "127.0.0.1", port }, () =>
      server.close(() => resolveListen(true)),
    );
  });
}

async function freePort() {
  for (let port = 18410; port <= 18480; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error("no free host port in 18410-18480");
}

async function ensureBuilt() {
  const entry = join(ROOT, "apps/customer-service/dist/main.js");
  const yaml = join(ROOT, "node_modules/js-yaml/package.json");
  if (!existsSync(yaml)) {
    const stats = await statfs(ROOT);
    const free = stats.bavail * stats.bsize;
    assert(
      free >= 3 * 1024 ** 3,
      `free disk ${free} bytes is below 3 GiB; refusing to install`,
    );
    process.stderr.write("grokverify: pnpm install --frozen-lockfile\n");
    await run("pnpm", ["install", "--frozen-lockfile"], { inherit: true });
  }
  process.stderr.write("grokverify: tsc -b apps/customer-service\n");
  await run(
    "pnpm",
    ["exec", "tsc", "-b", "apps/customer-service", "--pretty", "false"],
    { inherit: true },
  );
  assert(
    existsSync(entry),
    "apps/customer-service/dist/main.js was not produced",
  );
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

async function ownRuntimeSecret(path) {
  await chmod(path, 0o400);
  await chown(path, RUNTIME_UID, RUNTIME_GID);
  const fileStat = await stat(path);
  assert((fileStat.mode & 0o777) === 0o400, "scoped secret mode is not 0400");
  assert(
    fileStat.uid === RUNTIME_UID && fileStat.gid === RUNTIME_GID,
    "scoped secret owner is not the runtime uid",
  );
}

async function ensureImage(image) {
  try {
    await run("docker", ["image", "inspect", image]);
  } catch {
    process.stderr.write(`grokverify: pull ${image.split("@")[0]}\n`);
    await run("docker", ["pull", image], { inherit: true });
  }
}

function openssl(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

async function writeExt(path, environment, runtime) {
  const body = [
    `subjectAltName=URI:spiffe://coffee-platform/${environment}/${runtime},DNS:${runtime}.${environment}.svc.coffee-platform.internal`,
    "extendedKeyUsage=serverAuth,clientAuth",
    "basicConstraints=CA:FALSE",
    "",
  ].join("\n");
  await writeFile(path, body, { mode: 0o600 });
}

async function issueCert(
  directory,
  environment,
  runtime,
  caCert,
  caKey,
  serialPath,
  first,
) {
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
    "/CN=grokverify-customer-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  const caPem = await readFile(caCert, "utf8");
  const server = await issueCert(
    directory,
    environment,
    "customer-service",
    caCert,
    caKey,
    serial,
    true,
  );
  const apiPublic = await issueCert(
    directory,
    environment,
    "api-public",
    caCert,
    caKey,
    serial,
    false,
  );
  const catalog = await issueCert(
    directory,
    environment,
    "catalog-service",
    caCert,
    caKey,
    serial,
    false,
  );
  return {
    caPem,
    server,
    apiPublic,
    catalog,
    expectedSan: `spiffe://coffee-platform/${environment}/customer-service`,
  };
}

function verificationKeys(active, previous) {
  return { active, previous };
}

async function writeSecretFile(
  path,
  environment,
  material,
  role,
  rolePassword,
  cursor,
  delegation,
) {
  const document = {
    schemaVersion: 1,
    environment,
    runtime: "customer-service",
    secrets: {
      postgres: { customer: { username: role, password: rolePassword } },
      security: {
        customerCursorSigningPrivateKey: cursor.privatePem,
        customerCursorVerificationPublicKeys: verificationKeys(
          cursor.publicPem,
          keyPair().publicPem,
        ),
        delegationVerificationKeys: {
          "api-public": verificationKeys(
            delegation.public.publicPem,
            keyPair().publicPem,
          ),
          "api-internal": verificationKeys(
            delegation.internal.publicPem,
            keyPair().publicPem,
          ),
        },
        serviceTransportKeys: {
          "customer-service": JSON.stringify({
            caPem: material.caPem,
            certPem: material.server.certPem,
            keyPem: material.server.keyPem,
          }),
        },
      },
      telemetry: { exporterToken: remember(randomBytes(24).toString("hex")) },
    },
  };
  remember(rolePassword);
  remember(cursor.privatePem);
  remember(delegation.public.privatePem);
  remember(delegation.internal.privatePem);
  remember(material.server.keyPem);
  remember(material.apiPublic.keyPem);
  remember(material.catalog.keyPem);
  await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o400 });
  await ownRuntimeSecret(path);
}

function composeFile({
  project,
  runId,
  root,
  port,
  database,
  passwordFile,
  secretsFile,
}) {
  const q = JSON.stringify;
  return `name: ${project}
services:
  postgres:
    image: ${POSTGRES_IMAGE}
    pull_policy: missing
    container_name: ${project}-postgres
    init: true
    restart: "no"
    mem_limit: 1g
    environment:
      POSTGRES_USER: grokverify_admin
      POSTGRES_DB: ${database}
      POSTGRES_PASSWORD_FILE: /run/pg/password
      PGDATA: /var/lib/postgresql/grokverify
    volumes:
      - type: bind
        source: ${q(passwordFile)}
        target: /run/pg/password
        read_only: true
    tmpfs:
      - /var/lib/postgresql/grokverify:rw,nosuid,size=256m
    networks:
      default:
        aliases: [coffee_postgres]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U grokverify_admin -d ${database}"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 10s
    labels:
      com.coffee.grokverify: customer
      com.coffee.grokverify.run: ${runId}
  customer:
    image: ${NODE_IMAGE}
    pull_policy: missing
    container_name: ${project}-customer
    init: true
    restart: "no"
    user: "1000:1000"
    working_dir: ${q(root)}
    command: ["node", "apps/customer-service/dist/main.js"]
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
    ports: ["127.0.0.1:${port}:4101"]
    networks: [default]
    labels:
      com.coffee.grokverify: customer
      com.coffee.grokverify.run: ${runId}
networks:
  default:
    name: ${project}-net
    labels:
      com.coffee.grokverify: customer
      com.coffee.grokverify.run: ${runId}
`;
}

async function loadConfig() {
  const { load } = await import("js-yaml");
  const config = load(
    await readFile(join(ROOT, "config/platform.yaml"), "utf8"),
  );
  const environment = config?.environment;
  const database = config?.services?.["customer-service"]?.database;
  const listenPort = config?.services?.["customer-service"]?.listen?.port;
  assert(typeof environment === "string", "platform environment is missing");
  assert(typeof database === "string", "customer database name is missing");
  assertSafe(environment, /^[a-z0-9-]+$/u, "environment");
  assertSafe(database, /^[a-z][a-z0-9_]+$/u, "database");
  assert(
    config?.postgres?.host === "coffee_postgres" &&
      config?.postgres?.port === 5432,
    "postgres address is not coffee_postgres:5432",
  );
  assert(listenPort === 4101, "customer-service listen port is not 4101");
  return { environment, database };
}

async function migrationSql() {
  const directory = join(ROOT, "apps/customer-service/migrations");
  const names = (await readFileNames(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert(names.length > 0, "customer migrations are missing");
  const parts = [];
  for (const name of names)
    parts.push(await readFile(join(directory, name), "utf8"));
  const sql = parts.join("\n");
  const match =
    /GRANT USAGE ON SCHEMA customer TO ([a-z_][a-z0-9_]*)\s*;/u.exec(sql);
  assert(
    match?.[1],
    "customer migration does not grant schema usage to a runtime role",
  );
  return { sql, role: match[1], names };
}

async function readFileNames(directory) {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}

function httpsCall({
  port,
  ca,
  cert,
  key,
  servername,
  expectedSan,
  method,
  path,
  headers,
  body,
}) {
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
          return san === expectedSan
            ? undefined
            : new Error("peer identity mismatch");
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
    request.setTimeout(5_000, () => request.destroy(new Error("timeout")));
    request.on("error", rejectCall);
    if (body !== undefined) request.write(body);
    request.end();
  });
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
      aud: "customer-service",
      originalIssuer: "edge-gateway",
      sub: "actor_grokverify",
      permissions: [
        operationId === "createCustomer" ? "customer:create" : "customer:read",
      ],
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

function customerBody(suffix, overrides = {}) {
  return {
    displayName: `Grok Verify ${suffix}`,
    phone: PHONE,
    email: `grok-${suffix}@example.test`,
    ...overrides,
  };
}

function maskEmail(value) {
  const at = value.indexOf("@");
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

function maskPhone(value) {
  return `${value.slice(0, 2)}******${value.slice(-4)}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "node tools/grokverify-customer.mjs [--keep]\nnode tools/grokverify-customer.mjs --down <run-id>\n",
    );
    return 0;
  }
  if (args[0] === "--down") {
    const runId = args[1];
    assert(
      args.length === 2 && RUN_ID_PATTERN.test(runId ?? ""),
      "--down requires one run id",
    );
    await tearDown(runId, { keepEvidence: true });
    process.stderr.write(`grokverify: removed grokverify-customer-${runId}\n`);
    return 0;
  }
  assert(
    args.length === 0 || (args.length === 1 && args[0] === "--keep"),
    "unknown arguments",
  );
  const keep = args[0] === "--keep";
  await run("docker", ["ps", "-q"]);
  await ensureBuilt();
  const { environment, database } = await loadConfig();
  const migrations = await migrationSql();
  const runId = newRunId();
  const project = projectName(runId);
  const port = await freePort();
  await assertTmpfs(SECRET_ROOT);
  const directory = secretDirectory(project);
  const evidenceDir = join(ROOT, "evidence/grokverify", runId);
  const httpLog = [];
  const dbLog = {};
  const scenarios = [];
  const resultPath = join(evidenceDir, "result.json");
  const writeResult = async (status) => {
    const passed = new Set(
      scenarios
        .filter((scenario) => scenario.status === "pass")
        .map((scenario) => scenario.id),
    );
    const requiredDone = REQUIRED_SCENARIOS.every((id) => passed.has(id));
    const failed =
      scenarios.some((scenario) => scenario.status === "fail") ||
      status === "fail";
    const overall = failed
      ? "fail"
      : status === "pass" && requiredDone
        ? "pass"
        : "incomplete";
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      resultPath,
      `${JSON.stringify({ slice: "customer-service", boundary: database, runId, status: overall, scenarios }, null, 2)}\n`,
    );
    await writeFile(
      join(evidenceDir, "http.ndjson"),
      httpLog.map((line) => JSON.stringify(line)).join("\n") +
        (httpLog.length ? "\n" : ""),
    );
    await writeFile(
      join(evidenceDir, "db.json"),
      `${JSON.stringify(dbLog, null, 2)}\n`,
    );
    return overall;
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertTmpfs(directory);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const password = remember(randomBytes(24).toString("hex"));
    const rolePassword = remember(randomBytes(24).toString("hex"));
    const passwordFile = join(directory, "pg-password");
    const secretsFile = join(directory, "customer-service.yaml");
    const composePath = join(directory, "compose.yaml");
    await writeFile(passwordFile, `${password}\n`, { mode: 0o400 });
    await chmod(passwordFile, 0o400);
    const transport = await createTransport(
      join(directory, "certs"),
      environment,
    );
    const delegation = { public: keyPair(), internal: keyPair() };
    const cursor = keyPair();
    await writeSecretFile(
      secretsFile,
      environment,
      transport,
      migrations.role,
      rolePassword,
      cursor,
      delegation,
    );
    await writeFile(
      composePath,
      composeFile({
        project,
        runId,
        root: ROOT,
        port,
        database,
        passwordFile,
        secretsFile,
      }),
      { mode: 0o600 },
    );
    const runMeta = {
      runId,
      project,
      network: `${project}-net`,
      containers: [`${project}-postgres`, `${project}-customer`],
      port,
      database,
      migrations: migrations.names,
    };
    await writeFile(
      join(evidenceDir, "run.json"),
      `${JSON.stringify(runMeta, null, 2)}\n`,
    );
    let head = null;
    try {
      head = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      head = null;
    }
    let dirty = true;
    try {
      dirty =
        (await run("git", ["status", "--porcelain"])).stdout.trim().length > 0;
    } catch {
      dirty = true;
    }
    await writeFile(
      join(evidenceDir, "environment.json"),
      `${JSON.stringify(
        {
          slice: "customer-service",
          boundary: `customer-service -> PostgreSQL ${database}`,
          images: { postgres: POSTGRES_IMAGE, node: NODE_IMAGE },
          hostPort: port,
          containerPort: 4101,
          databasePublished: false,
          project,
          node: process.version,
          commit: head,
          dirty,
        },
        null,
        2,
      )}\n`,
    );

    const servername = `customer-service.${environment}.svc.coffee-platform.internal`;
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
      },
    ) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers = { "x-correlation-id": correlationId };
      if (idempotencyKey !== undefined)
        headers["idempotency-key"] = idempotencyKey;
      if (operationId !== undefined)
        headers["x-actor-context"] = actorToken(
          delegation.public.privateKey,
          operationId,
          correlationId,
        );
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
          expectedSan: transport.expectedSan,
          method,
          path,
          headers,
          body: payload,
        });
      } catch (error) {
        outcome = {
          status: 0,
          headers: {},
          text: "",
          json: null,
          error: error?.code ?? "error",
        };
      }
      httpLog.push({
        scenario,
        method,
        path,
        status: outcome.status,
        error: outcome.error,
        request: body ?? null,
        response:
          outcome.json ?? (outcome.text ? outcome.text.slice(0, 500) : null),
        contentType: header(outcome.headers, "content-type") ?? null,
        idempotencyReplayed:
          header(outcome.headers, "idempotency-replayed") ?? null,
      });
      return outcome;
    };

    const snapshot = async (scenario, email) => {
      const { stdout } = await run(
        "docker",
        [
          "exec",
          "-i",
          `${project}-postgres`,
          "psql",
          "-U",
          "grokverify_admin",
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
      'customers', (SELECT count(*)::int FROM customer.customers),
      'audits', (SELECT count(*)::int FROM customer.audit_log),
      'idempotencyCompleted', (SELECT count(*)::int FROM customer.idempotency_records WHERE state = 'Completed'),
      'idempotencyRows', (SELECT count(*)::int FROM customer.idempotency_records),
      'customerRef', (SELECT customer_ref FROM customer.customers ORDER BY created_at LIMIT 1),
      'status', (SELECT status FROM customer.customers ORDER BY created_at LIMIT 1),
      'version', (SELECT version::text FROM customer.customers ORDER BY created_at LIMIT 1),
      'emailMatches', (SELECT bool_and(email_normalized = ${sqlLiteral(email)}) FROM customer.customers)
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

    async function waitReady() {
      const deadline = Date.now() + 45_000;
      let last = "not-started";
      while (Date.now() < deadline) {
        const health = await call("startup", {
          method: "GET",
          path: "/health/ready",
        });
        last = health.error ?? `${health.status} ${health.json?.status ?? ""}`;
        if (health.status === 200 && health.json?.status === "ready") return;
        const state = await run("docker", [
          "inspect",
          "--format",
          "{{.State.Status}}",
          `${project}-customer`,
        ])
          .then((result) => result.stdout.trim())
          .catch(() => "missing");
        if (state === "exited" || state === "dead") break;
        await delay(500);
      }
      throw new Error(`customer-service did not become ready (${last})`);
    }

    await ensureImage(POSTGRES_IMAGE);
    await ensureImage(NODE_IMAGE);
    process.stderr.write(`grokverify: up ${project} on 127.0.0.1:${port}\n`);
    await run("docker", [
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "up",
      "-d",
      "postgres",
    ]);
    await waitHealthy(`${project}-postgres`);
    const bootstrap = `BEGIN;\nCREATE ROLE "${migrations.role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${rolePassword}';\nGRANT CONNECT ON DATABASE "${database}" TO "${migrations.role}";\nREVOKE ALL ON DATABASE "${database}" FROM PUBLIC;\n${migrations.sql}\nCOMMIT;\n`;
    await run(
      "docker",
      [
        "exec",
        "-i",
        `${project}-postgres`,
        "psql",
        "-U",
        "grokverify_admin",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
        "--no-psqlrc",
      ],
      { input: bootstrap },
    );
    await run("docker", [
      "compose",
      "-p",
      project,
      "-f",
      composePath,
      "up",
      "-d",
      "customer",
    ]);
    await waitReady();

    const suffix = runId.slice(-6);
    const created = customerBody(suffix);
    const steps = [
      [
        "empty-ready",
        "Пустая база: сервис готов, поиск ничего не находит",
        async () => {
          const health = await call("empty-ready", {
            method: "GET",
            path: "/health/ready",
          });
          assert(
            health.status === 200 &&
              health.json?.status === "ready" &&
              health.json?.runtime === "customer-service",
            `ready returned ${health.status}`,
          );
          const search = await call("empty-ready", {
            method: "GET",
            path: `/api/client-v1/customers?query=${encodeURIComponent(created.displayName)}`,
            operationId: "searchCustomers",
          });
          assert(
            search.status === 200 &&
              search.json?.items?.length === 0 &&
              search.json?.nextCursor === null,
            `empty search returned ${search.status}`,
          );
          const db = await snapshot("empty-ready", created.email);
          assert(
            db.customers === 0 && db.audits === 0 && db.idempotencyRows === 0,
            "empty database was not empty",
          );
        },
      ],
      [
        "create-customer",
        "Создание клиента сохраняет строку владельца",
        async () => {
          const bare = await httpsCall({
            port,
            ca: transport.caPem,
            servername,
            expectedSan: transport.expectedSan,
            method: "POST",
            path: "/api/client-v1/customers",
            headers: {
              "content-type": "application/json",
              "content-length": String(
                Buffer.byteLength(JSON.stringify(created)),
              ),
            },
            body: JSON.stringify(created),
          })
            .then(() => ({ status: 1 }))
            .catch(() => ({ status: 0 }));
          httpLog.push({
            scenario: "create-customer",
            method: "POST",
            path: "/api/client-v1/customers",
            status: bare.status,
            error: bare.status === 0 ? "tls-rejected" : null,
            request: created,
            response: null,
            contentType: null,
            idempotencyReplayed: null,
          });
          assert(
            bare.status === 0,
            "request without a client certificate was accepted",
          );
          const foreign = await call("create-customer", {
            method: "POST",
            path: "/api/client-v1/customers",
            body: created,
            operationId: "createCustomer",
            material: transport.catalog,
            idempotencyKey: randomUUID(),
          });
          assert(
            foreign.status === 401 &&
              foreign.json?.code === "AUTHENTICATION_REQUIRED",
            `foreign certificate returned ${foreign.status} ${foreign.json?.code}`,
          );
          const unsigned = await call("create-customer", {
            method: "POST",
            path: "/api/client-v1/customers",
            body: created,
            idempotencyKey: randomUUID(),
          });
          assert(
            unsigned.status === 401 &&
              unsigned.json?.code === "AUTHENTICATION_REQUIRED",
            `unsigned create returned ${unsigned.status}`,
          );
          const invalid = await call("create-customer", {
            method: "POST",
            path: "/api/client-v1/customers",
            body: {},
            operationId: "createCustomer",
            idempotencyKey: randomUUID(),
          });
          assert(
            invalid.status === 400 &&
              invalid.json?.code === "VALIDATION_FAILED",
            `invalid body returned ${invalid.status} ${invalid.json?.code}`,
          );
          const before = await snapshot(
            "create-customer-rejected",
            created.email,
          );
          assert(
            before.customers === 0 && before.audits === 0,
            "rejected requests wrote rows",
          );
          const key = randomUUID();
          const correlationId = randomUUID();
          const payload = JSON.stringify(created);
          const headers = {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload)),
            "idempotency-key": key,
            "x-correlation-id": correlationId,
            "x-actor-context": actorToken(
              delegation.public.privateKey,
              "createCustomer",
              correlationId,
            ),
          };
          const response = await httpsCall({
            port,
            ca: transport.caPem,
            cert: transport.apiPublic.certPem,
            key: transport.apiPublic.keyPem,
            servername,
            expectedSan: transport.expectedSan,
            method: "POST",
            path: "/api/client-v1/customers",
            headers,
            body: payload,
          });
          httpLog.push({
            scenario: "create-customer",
            method: "POST",
            path: "/api/client-v1/customers",
            status: response.status,
            request: created,
            response: response.json,
            contentType: header(response.headers, "content-type") ?? null,
            idempotencyReplayed:
              header(response.headers, "idempotency-replayed") ?? null,
          });
          assert(
            response.status === 201,
            `create returned ${response.status} ${response.json?.code ?? ""}`,
          );
          assert(
            header(response.headers, "content-type")?.startsWith(
              "application/json",
            ),
            "create content-type is not json",
          );
          assert(
            header(response.headers, "idempotency-replayed") === undefined,
            "first create was marked replayed",
          );
          assert(
            /^cus_[0-9A-HJKMNP-TV-Z]{26}$/u.test(
              response.json?.customerRef ?? "",
            ),
            "customerRef is missing",
          );
          assert(response.json?.version === "1", "created version is not 1");
          assert(
            response.json?.displayName === created.displayName,
            "displayName was not stored",
          );
          assert(
            response.json?.email === created.email,
            "email was not stored",
          );
          assert(response.json?.phone === PHONE, "phone was not stored");
          const db = await snapshot("create-customer", created.email);
          assert(
            db.customers === 1 &&
              db.audits === 1 &&
              db.idempotencyCompleted === 1 &&
              db.idempotencyRows === 1,
            "owner rows after create did not match",
          );
          assert(
            db.customerRef === response.json.customerRef &&
              db.status === "Active" &&
              db.version === "1" &&
              db.emailMatches === true,
            "database row does not match the HTTP response",
          );
          return { key, customerRef: response.json.customerRef, payload };
        },
      ],
    ];

    let createdState;
    for (const [id, title, runScenario] of steps) {
      try {
        createdState = (await runScenario()) ?? createdState;
        scenarios.push({ id, title, status: "pass" });
      } catch (error) {
        scenarios.push({ id, title, status: "fail", detail: detail(error) });
        throw error;
      }
      await writeResult();
    }

    const rest = [
      [
        "search-customer",
        "Поиск по имени возвращает этого клиента",
        async () => {
          const search = await call("search-customer", {
            method: "GET",
            path: `/api/client-v1/customers?query=${encodeURIComponent(created.displayName)}`,
            operationId: "searchCustomers",
          });
          assert(search.status === 200, `search returned ${search.status}`);
          assert(
            search.json?.items?.length === 1,
            "search did not return one customer",
          );
          const item = search.json.items[0];
          assert(
            item.customerRef === createdState.customerRef,
            "search returned a different customer",
          );
          assert(
            item.displayName === created.displayName,
            "search displayName mismatch",
          );
          assert(
            item.email === maskEmail(created.email),
            "search email was not masked",
          );
          assert(
            item.phone === maskPhone(PHONE),
            "search phone was not masked",
          );
          assert(search.json.nextCursor === null, "unexpected search cursor");
          const db = await snapshot("search-customer", created.email);
          assert(db.customers === 1, "search changed the customer count");
        },
      ],
      [
        "replay-create",
        "Повтор того же создания не создаёт вторую строку",
        async () => {
          const correlationId = randomUUID();
          const headers = {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(createdState.payload)),
            "idempotency-key": createdState.key,
            "x-correlation-id": correlationId,
            "x-actor-context": actorToken(
              delegation.public.privateKey,
              "createCustomer",
              correlationId,
            ),
          };
          const replay = await httpsCall({
            port,
            ca: transport.caPem,
            cert: transport.apiPublic.certPem,
            key: transport.apiPublic.keyPem,
            servername,
            expectedSan: transport.expectedSan,
            method: "POST",
            path: "/api/client-v1/customers",
            headers,
            body: createdState.payload,
          });
          httpLog.push({
            scenario: "replay-create",
            method: "POST",
            path: "/api/client-v1/customers",
            status: replay.status,
            request: created,
            response: replay.json,
            contentType: header(replay.headers, "content-type") ?? null,
            idempotencyReplayed:
              header(replay.headers, "idempotency-replayed") ?? null,
          });
          assert(
            replay.status === 201 &&
              replay.json?.customerRef === createdState.customerRef,
            `replay returned ${replay.status}`,
          );
          assert(
            header(replay.headers, "idempotency-replayed") === "true",
            "replay was not marked",
          );
          const other = {
            ...created,
            displayName: `${created.displayName} Other`,
          };
          const otherBody = JSON.stringify(other);
          const conflictCorrelation = randomUUID();
          const conflict = await httpsCall({
            port,
            ca: transport.caPem,
            cert: transport.apiPublic.certPem,
            key: transport.apiPublic.keyPem,
            servername,
            expectedSan: transport.expectedSan,
            method: "POST",
            path: "/api/client-v1/customers",
            headers: {
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(otherBody)),
              "idempotency-key": createdState.key,
              "x-correlation-id": conflictCorrelation,
              "x-actor-context": actorToken(
                delegation.public.privateKey,
                "createCustomer",
                conflictCorrelation,
              ),
            },
            body: otherBody,
          });
          httpLog.push({
            scenario: "replay-create",
            method: "POST",
            path: "/api/client-v1/customers",
            status: conflict.status,
            request: other,
            response: conflict.json,
            contentType: header(conflict.headers, "content-type") ?? null,
            idempotencyReplayed:
              header(conflict.headers, "idempotency-replayed") ?? null,
          });
          assert(
            conflict.status === 409 &&
              conflict.json?.code === "IDEMPOTENCY_CONFLICT",
            `idempotency conflict returned ${conflict.status} ${conflict.json?.code}`,
          );
          const db = await snapshot("replay-create", created.email);
          assert(
            db.customers === 1 &&
              db.audits === 1 &&
              db.idempotencyRows === 1 &&
              db.customerRef === createdState.customerRef,
            "replay changed owner rows",
          );
        },
      ],
      [
        "duplicate-email",
        "Тот же email повторно отклоняется",
        async () => {
          const duplicate = customerBody(`${suffix}-dup`, {
            email: created.email,
            phone: OTHER_PHONE,
            displayName: `Grok Verify ${suffix} Dup`,
          });
          const response = await postCustomer("duplicate-email", duplicate);
          assert(
            response.status === 409 &&
              response.json?.code === "CUSTOMER_EMAIL_CONFLICT",
            `duplicate email returned ${response.status} ${response.json?.code}`,
          );
          const db = await snapshot("duplicate-email", created.email);
          assert(
            db.customers === 1 &&
              db.audits === 1 &&
              db.idempotencyCompleted === 1 &&
              db.idempotencyRows === 1,
            "duplicate email wrote another row",
          );
        },
      ],
    ];

    async function postCustomer(scenario, body) {
      const payload = JSON.stringify(body);
      const correlationId = randomUUID();
      const response = await httpsCall({
        port,
        ca: transport.caPem,
        cert: transport.apiPublic.certPem,
        key: transport.apiPublic.keyPem,
        servername,
        expectedSan: transport.expectedSan,
        method: "POST",
        path: "/api/client-v1/customers",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "idempotency-key": randomUUID(),
          "x-correlation-id": correlationId,
          "x-actor-context": actorToken(
            delegation.public.privateKey,
            "createCustomer",
            correlationId,
          ),
        },
        body: payload,
      });
      httpLog.push({
        scenario,
        method: "POST",
        path: "/api/client-v1/customers",
        status: response.status,
        request: body,
        response: response.json,
        contentType: header(response.headers, "content-type") ?? null,
        idempotencyReplayed:
          header(response.headers, "idempotency-replayed") ?? null,
      });
      return response;
    }

    for (const [id, title, runScenario] of rest) {
      try {
        await runScenario();
        scenarios.push({ id, title, status: "pass" });
      } catch (error) {
        scenarios.push({ id, title, status: "fail", detail: detail(error) });
        throw error;
      }
      await writeResult();
    }
    scenarios.push({
      id: "order-input",
      title: "Внутренний order-input для Orders",
      status: "not-covered",
      detail: "Граница api-internal → customer-service в этот срез не входит.",
    });
    const overall = await writeResult("pass");
    process.stdout.write(
      `${JSON.stringify({ runId, status: overall, evidence: evidenceDir, scenarios }, null, 2)}\n`,
    );
    return overall === "pass" ? 0 : 1;
  } catch (error) {
    scenarios.push({
      id: "run",
      title: "Прогон",
      status: "fail",
      detail: detail(error),
    });
    await writeResult("fail");
    process.stderr.write(`${detail(error)}\n`);
    process.stdout.write(
      `${JSON.stringify({ runId, status: "fail", evidence: evidenceDir }, null, 2)}\n`,
    );
    return 1;
  } finally {
    await saveLogs(`${project}-customer`, join(evidenceDir, "service.log"));
    if (!keep) await tearDown(runId, { keepEvidence: true });
    else
      process.stderr.write(
        `grokverify: kept ${project}; remove with node tools/grokverify-customer.mjs --down ${runId}\n`,
      );
  }
}

function sqlLiteral(value) {
  assertSafe(value, /^[a-z0-9.+@-]+$/u, "sql literal");
  return `'${value}'`;
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

async function tearDown(runId, { keepEvidence = true } = {}) {
  void keepEvidence;
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
        `grokverify: compose down warning ${redact(error.stderr || error.message).slice(0, 500)}\n`,
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
        "label=com.coffee.grokverify=customer",
        "--filter",
        `label=com.coffee.grokverify.run=${runId}`,
      ])
    ).stdout;
  } catch {
    ids = "";
  }
  for (const id of ids.split("\n").filter(Boolean)) {
    const name = (
      await run("docker", ["inspect", "--format", "{{.Name}}", id])
    ).stdout
      .trim()
      .replace(/^\//u, "");
    assert(name.startsWith(`${project}-`), `refusing to remove ${name}`);
    await run("docker", ["rm", "-f", id]);
  }
  await removeNetwork(`${project}-net`, runId);
  await removeProjectVolumes(project);
  if (existsSync(directory)) {
    assert(
      directory === secretDirectory(project),
      "refusing to delete secret directory",
    );
    const info = await lstat(directory);
    if (info.isSymbolicLink()) await rm(directory);
    else {
      await assertTmpfs(directory);
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
        '{{index .Labels "com.coffee.grokverify"}}|{{index .Labels "com.coffee.grokverify.run"}}',
        name,
      ])
    ).stdout.trim();
  } catch {
    return;
  }
  assert(labels === `customer|${runId}`, `refusing to remove network ${name}`);
  await run("docker", ["network", "rm", name]).catch(() => {});
}

async function removeProjectVolumes(project) {
  assert(
    project.startsWith("grokverify-customer-"),
    "refusing to remove foreign volumes",
  );
  let names = "";
  try {
    names = (
      await run("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
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
