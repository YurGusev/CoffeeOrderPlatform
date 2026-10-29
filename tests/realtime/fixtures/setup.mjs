import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  readFile,
  writeFile,
  mkdir,
  chmod,
  readdir,
  rm,
  rename,
  stat,
} from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
import { createRequire } from "node:module";
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { availableParallelism, totalmem, cpus } from "node:os";
import { load as yaml, dump } from "js-yaml";
import Ajv2020 from "ajv/dist/2020.js";
import { deriveRuntimeKafkaTarget } from "../../../packages/platform-config/dist/index.js";
import { readG15FixtureLineage } from "../../../tools/config-bootstrap/browser-fixture.mjs";
import {
  loadVerifiedGateImage,
  removeVerifiedGateImage,
} from "../../../tools/verified-infrastructure-image.mjs";
import { validateLaunchContext } from "../../../verification/launch/v1/report.mjs";
import { isoNow, FULL, THRESHOLDS } from "./protocol.mjs";

export const ROOT = resolve(import.meta.dirname, "../../..");
export const LABEL = "coffee.issue12.realtime-soak";
export const PRODUCT_BUILD_TARGETS = Object.freeze([
  "packages/contracts/pricing-v1",
  "packages/contracts/orders-v1",
  "apps/realtime-gateway",
  "apps/edge-gateway",
  "apps/api-public",
]);
const STARTUP_ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AssertionError",
]);
const STARTUP_ERROR_CODES = new Set([
  "AROMA_PREPARATION_CONFIG_MISSING",
  "AROMA_PREPARATION_CONSUMER_INVALID",
  "AROMA_PREPARATION_DEPENDENCIES_MISSING",
  "AROMA_PREPARATION_NOT_CONFIGURED",
  "AROMA_VERIFICATION_CONFIG_MISSING",
  "KAFKA_CONFIG_INVALID",
  "KAFKA_CONNECTION_FAILED",
  "KAFKA_ENVELOPE_INVALID",
  "KAFKA_HANDLER_FAILED",
  "KAFKA_QUEUE_FULL",
  "KAFKA_REVOKED",
  "KAFKA_SHUTDOWN_TIMEOUT",
  "KAFKA_STOPPED",
  "OFFSET_COMMIT_OUTCOME_UNKNOWN",
  "RUNTIME_DATABASE_CONFIG_MISMATCH",
  "RUNTIME_DATABASE_SECRET_INVALID",
  "RUNTIME_DATABASE_SECRET_SCOPE",
  "RUNTIME_DUPLICATE_COMPOSITION",
  "RUNTIME_INVALID_PLATFORM_CONFIG",
  "RUNTIME_INVALID_RESOURCE_NAMES",
  "RUNTIME_INVALID_TRANSITION",
  "RUNTIME_KAFKA_SECRET_INVALID",
  "RUNTIME_KAFKA_SECRET_SCOPE",
  "RUNTIME_PUBLIC_BASE_URL_INVALID",
  "RUNTIME_RESOURCE_STOP_FAILED",
  "RUNTIME_STARTUP_DEADLINE",
  "RUNTIME_TELEMETRY_SECRET_SCOPE",
  "RUNTIME_TRANSPORT_NOT_CONFIGURED",
  "RUNTIME_UNKNOWN_DEADLINE_PROFILE",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_INVALID_ARG_TYPE",
  "ERR_REQUIRE_ESM",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ERR_SOCKET_CLOSED",
  "ERR_OUT_OF_RANGE",
]);
const STARTUP_SQL_STATES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "23502",
  "23503",
  "23505",
  "23514",
  "28P01",
  "3D000",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "57P03",
]);
export function productArgs(role, launchPath = false) {
  return [
    "--env",
    "COFFEE_CONFIG_FILE=/fixture/platform.yaml",
    "--env",
    `COFFEE_RUNTIME_SECRETS_FILE=/fixture/${role}.yaml`,
    ...(launchPath
      ? ["--env", "COFFEE_LAUNCH_CONTEXT_FILE=/fixture/launch-context.json"]
      : []),
    ...(role === "edge-gateway"
      ? ["--env", "NODE_EXTRA_CA_CERTS=/fixture/certs/ca.crt"]
      : []),
    "--IMAGE--",
    "node",
    "--enable-source-maps",
    `apps/${role}/dist/main.js`,
  ];
}

export function safeProductStartupFailure(logs, allowedPaths) {
  const allowed = new Set(
    allowedPaths.filter(
      (path) =>
        /^(?:apps|packages)\/[A-Za-z0-9._/-]+\.(?:mjs|js|ts)$/u.test(path) &&
        !path.split("/").includes(".."),
    ),
  );
  const errorNames = new Set(),
    errorCodes = new Set(),
    sqlStates = new Set(),
    sourceFrames = new Map();
  const addName = (value) => {
    if (typeof value === "string" && STARTUP_ERROR_NAMES.has(value))
      errorNames.add(value);
  };
  const inspectFields = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const err = value.err && typeof value.err === "object" ? value.err : value;
    addName(err.type);
    addName(err.name);
    if (typeof err.code === "string" && STARTUP_SQL_STATES.has(err.code))
      sqlStates.add(err.code);
    for (const key of ["code", "message"])
      if (typeof err[key] === "string")
        for (const match of err[key].matchAll(/\b[A-Z][A-Z0-9_]{2,79}\b/gu))
          if (STARTUP_ERROR_CODES.has(match[0])) errorCodes.add(match[0]);
    for (const key of ["sqlState", "sqlstate"])
      if (typeof err[key] === "string" && STARTUP_SQL_STATES.has(err[key]))
        sqlStates.add(err[key]);
    if (typeof err.message === "string")
      for (const match of err.message.matchAll(
        /\bSQLSTATE\s*[:=]?\s*([0-9A-Z]{5})\b/giu,
      ))
        if (STARTUP_SQL_STATES.has(match[1])) sqlStates.add(match[1]);
    if (typeof err.stack === "string") addFrames(err.stack);
  };
  const addFrames = (text) => {
    const pattern =
      /(?:file:\/\/)?(\/app\/(?:apps|packages)\/[A-Za-z0-9._/-]+\.(?:mjs|js|ts)):(\d+):(\d+)/gu;
    for (const match of text.matchAll(pattern)) {
      const path = match[1].slice("/app/".length),
        line = Number(match[2]),
        column = Number(match[3]);
      if (
        !allowed.has(path) ||
        path.split("/").includes("..") ||
        !Number.isSafeInteger(line) ||
        line < 1 ||
        !Number.isSafeInteger(column) ||
        column < 1
      )
        continue;
      const key = `${path}:${line}:${column}`;
      if (!sourceFrames.has(key) && sourceFrames.size < 8)
        sourceFrames.set(key, { path, line, column });
    }
  };
  for (const line of String(logs).split(/\r?\n/u).slice(-50)) {
    const text = line.slice(0, 65536);
    try {
      inspectFields(JSON.parse(text));
    } catch {}
    const headline =
      /\b(Error|TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|AggregateError|AssertionError):/u.exec(
        text,
      );
    if (headline) addName(headline[1]);
    for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{2,79}\b/gu))
      if (STARTUP_ERROR_CODES.has(match[0])) errorCodes.add(match[0]);
    for (const match of text.matchAll(
      /\bSQLSTATE\s*[:=]?\s*([0-9A-Z]{5})\b/giu,
    ))
      if (STARTUP_SQL_STATES.has(match[1])) sqlStates.add(match[1]);
    addFrames(text);
  }
  return {
    errorNames: [...errorNames].slice(0, 4),
    errorCodes: [...errorCodes].slice(0, 8),
    sqlStates: [...sqlStates].slice(0, 4),
    sourceFrames: [...sourceFrames.values()],
  };
}

export const hash = (text) => createHash("sha256").update(text).digest("hex");
async function readFixtureLaunchPath(launchPath) {
  if (launchPath?.launchContextFile === undefined) return undefined;
  assert.ok(
    Object.keys(launchPath).every((key) =>
      ["exporterToken", "launchContextFile"].includes(key),
    ),
  );
  const contextPath = resolve(launchPath.launchContextFile);
  const active = await validateLaunchContext(contextPath);
  const resources = active.context.resources;
  assert.equal(typeof resources?.g15ParentCandidateSha, "string");
  assert.equal(resources.g15ParentCheckoutRoot, active.sourceRoot);
  const lineage = await readG15FixtureLineage({
    root: active.sourceRoot,
    contextPath,
    baseCandidateSha: resources.g15ParentCandidateSha,
  });
  const launchIdentity = {
    schemaVersion: active.context.schemaVersion,
    runId: active.context.runId,
    candidateSha: active.context.candidateSha,
    baseConfigSha256: active.context.baseConfigSha256,
  };
  assert.deepEqual(
    {
      schemaVersion: lineage.schemaVersion,
      runId: lineage.runId,
      candidateSha: lineage.candidateSha,
      baseConfigSha256: lineage.configSha256,
    },
    launchIdentity,
  );
  return {
    contextPath,
    candidateRoot: active.candidateRoot,
    parentCandidateRoot: resources.g15ParentCheckoutRoot,
    databaseOwnershipFile: join(
      active.candidateRoot,
      "config/database-ownership.json",
    ),
    launchIdentity,
    lineageReceiptSha256: hash(await readFile(lineage.receiptPath)),
  };
}

function assertFixtureLaunchConfig(config, configBytes, launchPath) {
  if (!launchPath) return;
  assert.equal(hash(configBytes), launchPath.launchIdentity.baseConfigSha256);
  assert.equal(config.environment, "development");
  assert.equal(config.postgres.host, "coffee_postgres");
  assert.equal(config.platform.publicBaseUrl, "https://localhost:8443");
  assert.equal(config.nginxTransport.publicHost, "localhost");
  assert.equal(
    config.telemetry.collector.otlpEndpoint,
    "http://otel-collector:4318",
  );
  assert.equal(config.verification.databaseIsolation.enabled, true);
  assert.equal(config.verification.kafkaNamespaceIsolation, true);
  assert.deepEqual(config.browserOidc, {
    issuer: "https://idp.fixture.invalid",
    clientId: "issue12-fixture",
    authorizationUrl: "https://idp.fixture.invalid/authorize",
    tokenUrl: "https://idp.fixture.invalid/token",
    jwksUrl: "https://idp.fixture.invalid/keys",
    redirectUri: "https://localhost:8443/auth/callback",
    allowedAlgorithms: ["RS256"],
    actorRefClaim: "actor_ref",
    permissionsClaim: "permissions",
  });
}

export async function readCgroupMemory(pid, reader = readFile) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "owned host PID");
  const group = /^0::(\/[^\n]*)$/mu.exec(
    await reader(`/proc/${pid}/cgroup`, "utf8"),
  )?.[1];
  assert.ok(
    group && !group.split("/").includes(".."),
    "measurable cgroup path",
  );
  const directory = resolve("/sys/fs/cgroup", `.${group}`);
  const texts = await Promise.all(
    [
      "memory.current",
      "memory.max",
      "memory.peak",
      "memory.stat",
      "memory.events",
    ].map((name) => reader(join(directory, name), "utf8")),
  );
  const number = (text) => {
    assert.match(text.trim(), /^\d+$/u, "measured cgroup integer");
    const value = Number(text.trim());
    assert.ok(Number.isSafeInteger(value), "safe cgroup integer");
    return value;
  };
  const fields = (text) =>
    Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => {
          const parts = /^([a-z0-9_]+) (\d+)$/u.exec(line);
          assert.ok(parts, "measured cgroup field");
          return [parts[1], number(parts[2])];
        }),
    );
  return {
    currentBytes: number(texts[0]),
    maxBytes: texts[1].trim() === "max" ? "max" : number(texts[1]),
    peakBytes: number(texts[2]),
    stat: fields(texts[3]),
    events: fields(texts[4]),
  };
}
export async function run(
  command,
  args,
  {
    cwd = ROOT,
    timeout = 120000,
    input,
    env,
    outputLimit = 8 * 1024 * 1024,
    includeStderr = false,
  } = {},
) {
  assert.ok(
    Number.isSafeInteger(outputLimit) &&
      outputLimit > 0 &&
      outputLimit <= 128 * 1024 * 1024,
    "bounded command output limit",
  );
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      exceeded = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (c) => {
      if (exceeded) return;
      stdout += c;
      if (stdout.length + stderr.length > outputLimit) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (c) => {
      if (exceeded) return;
      stderr += c;
      if (stdout.length + stderr.length > outputLimit) {
        exceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || exceeded)
        reject(
          Object.assign(
            new Error(
              `${command} failed (exit=${code}, signal=${signal}, outputLimitExceeded=${exceeded}): ${redact(stderr || stdout).slice(-4000)}`,
            ),
            { code: "FIXTURE_COMMAND_FAILED" },
          ),
        );
      else resolveRun(stdout + (includeStderr ? stderr : ""));
    });
    child.stdin.end(input);
  });
}
export function redact(text) {
  return String(text)
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]+-----/gu,
      "[redacted generated material]",
    )
    .replace(
      /(?:__Host-coffee-(?:session|csrf|login)=)[^;\s"']+/gu,
      "[redacted synthetic cookie]",
    )
    .replace(
      /(?:password|id_token|x-actor-context)["']?\s*[:=]\s*[^\n,]+/giu,
      "[redacted synthetic credential]",
    );
}
export const docker = (...args) => run("docker", args);
export async function json(path, value, mode = 0o644) {
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, JSON.stringify(value, null, 2) + "\n", {
      mode,
      flag: "wx",
    });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}
async function walk(dir, filter = () => true) {
  const files = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (!filter(p, ent)) continue;
    if (ent.isDirectory()) files.push(...(await walk(p, filter)));
    else if (ent.isFile()) files.push(p);
  }
  return files;
}
export async function sourceSnapshot(privateDir, { launchPath = false } = {}) {
  const target = join(privateDir, "app");
  await mkdir(target);
  const filter = (p) =>
    !/(?:^|\/)(?:dist|\.git|\.env[^/]*|\.tsbuildinfo|secrets)(?:\/|$)/u.test(
      p,
    ) && !p.endsWith(".tsbuildinfo");
  for (const name of ["packages", "types", "node_modules"]) {
    if (name === "node_modules") {
      const source = join(ROOT, name),
        destination = join(target, name);
      const [sourceStat, targetStat] = await Promise.all([
        stat(source),
        stat(target),
      ]);
      // Hardlinks keep ordinary local snapshots cheap; isolated read-only checkouts may put work on tmpfs.
      await run("cp", [
        sourceStat.dev === targetStat.dev ? "-al" : "-a",
        source,
        destination,
      ]);
    } else
      await cp(join(ROOT, name), join(target, name), {
        recursive: true,
        verbatimSymlinks: true,
        filter,
      });
  }
  const appNames = [
    "edge-gateway",
    "realtime-gateway",
    "api-public",
    ...(launchPath
      ? [
          "api-internal",
          "orders-service",
          "orders-aroma-preparation",
          "aroma-convergence",
        ]
      : []),
  ];
  for (const name of appNames)
    await cp(join(ROOT, "apps", name), join(target, "apps", name), {
      recursive: true,
      verbatimSymlinks: true,
      filter,
    });
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
  ])
    await cp(join(ROOT, name), join(target, name));
  await cp(
    join(ROOT, "tests/realtime/fixtures"),
    join(target, "tests/realtime/fixtures"),
    { recursive: true },
  );
  if (launchPath) {
    await mkdir(join(target, "tests/observability"), { recursive: true });
    await cp(
      join(ROOT, "tests/observability/convergence-metrics-proof.mjs"),
      join(target, "tests/observability/convergence-metrics-proof.mjs"),
    );
  }
  await cp(join(ROOT, "contracts"), join(target, "contracts"), {
    recursive: true,
    filter,
  });
  const sources = {};
  for (const tree of ["packages", "apps", "types", "tests", "contracts"])
    for (const p of await walk(join(target, tree), filter)) {
      if (p.includes("/node_modules/")) continue;
      sources[relative(target, p)] = hash(await readFile(p));
    }
  for (const p of [
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "pnpm-workspace.yaml",
  ])
    sources[p] = hash(await readFile(join(target, p)));
  return { target, sources };
}
async function certificates(dir, environment, { launchPath = false } = {}) {
  await mkdir(dir, { recursive: true });
  const ssl = async (...args) => run("openssl", args, { cwd: dir });
  await ssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=issue12-disposable-ca",
    "-days",
    "2",
  );
  const ca = await readFile(join(dir, "ca.crt"), "utf8"),
    materials = {},
    fingerprints = {};
  const names = [
    "edge-nginx",
    "edge-gateway",
    "realtime-gateway",
    "api-public",
    "orders-service",
    ...(launchPath ? ["api-internal", "orders-aroma-preparation"] : []),
    "idp",
    "public",
  ];
  for (const name of names) {
    const dns =
      name === "public"
        ? "localhost"
        : name === "idp"
          ? "idp.fixture.invalid"
          : `${name}.${environment}.svc.coffee-platform.internal`;
    const identity =
      name === "public" || name === "idp"
        ? ""
        : `,URI:spiffe://coffee-platform/${environment}/${name}`;
    await writeFile(
      join(dir, `${name}.ext`),
      `subjectAltName=DNS:${dns},DNS:${name}${identity}\nextendedKeyUsage=serverAuth,clientAuth\n`,
    );
    await ssl(
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${name}`,
    );
    await ssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
    );
    const certPem = await readFile(join(dir, `${name}.crt`), "utf8"),
      keyPem = await readFile(join(dir, `${name}.key`), "utf8");
    materials[name] = { certPem, keyPem, caPem: ca };
    fingerprints[name] = new X509Certificate(certPem).fingerprint256;
  }
  return { materials, fingerprints };
}
async function kafkaMaterial(dir, { launchPath = false } = {}) {
  await mkdir(dir, { recursive: true });
  const password = randomUUID();
  const kt = async (...args) => run("keytool", args, { cwd: dir });
  await kt(
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
    "SAN=dns:kafka,dns:localhost,ip:127.0.0.1",
    "-keystore",
    "kafka.keystore.p12",
    "-storetype",
    "PKCS12",
    "-storepass",
    password,
    "-keypass",
    password,
  );
  await kt(
    "-exportcert",
    "-alias",
    "kafka",
    "-keystore",
    "kafka.keystore.p12",
    "-storepass",
    password,
    "-rfc",
    "-file",
    "kafka.crt",
  );
  await kt(
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
    password,
  );
  const credentials = {};
  for (const name of [
    "broker",
    "realtime",
    "publisher",
    "inspector",
    ...(launchPath ? ["orders"] : []),
  ])
    credentials[name] = { username: name, password: randomUUID() };
  const users = Object.entries(credentials)
    .map(([n, v]) => `user_${n}="${v.password}"`)
    .join(" ");
  await writeFile(join(dir, "kafka.keystore.password"), password + "\n");
  await writeFile(
    join(dir, "kafka_jaas.conf"),
    `KafkaServer { org.apache.kafka.common.security.plain.PlainLoginModule required username="broker" password="${credentials.broker.password}" ${users}; };\n`,
  );
  await writeFile(
    join(dir, "client.properties"),
    `security.protocol=SASL_SSL\nsasl.mechanism=PLAIN\nsasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required username="inspector" password="${credentials.inspector.password}";\nssl.truststore.type=PKCS12\nssl.truststore.location=/etc/kafka/secrets/kafka.truststore.p12\nssl.truststore.password=${password}\nssl.endpoint.identification.algorithm=https\n`,
  );
  const caPem = await readFile(join(dir, "kafka.crt"), "utf8");
  const client = await readFile(join(dir, "client.properties"), "utf8");
  await writeFile(
    join(dir, "publisher.properties"),
    client
      .replace('username="inspector"', 'username="publisher"')
      .replace(credentials.inspector.password, credentials.publisher.password),
  );
  for (const value of Object.values(credentials)) value.caPem = caPem;
  for (const name of await readdir(dir)) await chmod(join(dir, name), 0o400);
  return {
    credentials,
    fingerprint: new X509Certificate(caPem).fingerprint256,
  };
}
function setRef(object, ref, value) {
  const parts = ref.split(".");
  let current = object;
  for (const p of parts.slice(0, -1))
    current = current[p] ??= Object.create(null);
  current[parts.at(-1)] = value;
}
function keyset() {
  const a = generateKeyPairSync("ed25519"),
    b = generateKeyPairSync("ed25519");
  return {
    private: a.privateKey.export({ type: "pkcs8", format: "pem" }),
    verification: {
      active: a.publicKey.export({ type: "spki", format: "pem" }),
      previous: b.publicKey.export({ type: "spki", format: "pem" }),
    },
  };
}

export async function prepare(resultDir, options) {
  const launchPath = await readFixtureLaunchPath(options.launchPath);
  if (launchPath) assert.equal(ROOT, launchPath.parentCandidateRoot);
  // Validate the frozen G12 artifact before generating private credentials or
  // starting the comparatively expensive native runtime build. This pass is
  // read-only with respect to Docker; the later import pass repeats validation.
  const kafkaArtifactProof = await loadVerifiedGateImage({
    target: "kafka",
    ...(launchPath ? { contextFile: launchPath.contextPath } : {}),
    loadImage: false,
  });
  if (launchPath) {
    assert.deepEqual(
      kafkaArtifactProof.launchIdentity,
      launchPath.launchIdentity,
    );
    assert.equal(
      kafkaArtifactProof.lineageReceiptSha256,
      launchPath.lineageReceiptSha256,
    );
  }
  const privateDir = join(resultDir, "private");
  await mkdir(privateDir, { mode: 0o700 });
  const configRoot = launchPath?.candidateRoot ?? ROOT;
  const configBytes = await readFile(join(configRoot, "config/platform.yaml"));
  const configText = configBytes.toString("utf8");
  const config = yaml(configText, { json: true });
  if (options.launchPath && !launchPath) {
    config.postgres.host = "coffee_postgres";
    if (options.launchPath.telemetryConfig) {
      const telemetryConfig =
        options.launchPath.telemetryConfig.telemetry ??
        options.launchPath.telemetryConfig;
      config.telemetry = structuredClone(telemetryConfig);
    }
    if (options.launchPath.telemetryEndpoint)
      config.telemetry.collector.otlpEndpoint =
        options.launchPath.telemetryEndpoint;
  }
  assertFixtureLaunchConfig(config, configBytes, launchPath);
  assertFixtureKafkaNamespaceBound(
    config,
    "realtime-gateway",
    launchPath?.launchIdentity,
  );
  assert.equal(
    config.nginxTransport.limits.sseAdmissionConnections,
    512,
    "reference admission must remain 512",
  );
  assert.equal(
    config.nginxTransport.limits.workerConnections,
    2048,
    "reference worker budget drift",
  );
  assert.equal(
    config.nginxTransport.limits.workerProcesses,
    1,
    "reference native worker count drift",
  );
  assert.deepEqual(
    config.services["realtime-gateway"].realtime,
    {
      shutdownGraceMs: 20000,
      maxConnections: 512,
      queueMaxRecords: 64,
      queueMaxBytes: 262144,
      totalQueueMaxRecords: 262144,
      totalQueueMaxBytes: 67108864,
      ringMaxRecords: 10000,
      ringMaxBytes: 16777216,
      ringMaxAgeMs: 300000,
      coalesceMs: 250,
      writeTimeoutMs: 5000,
      heartbeatMs: 15000,
      authCheckMs: 30000,
      maxEventDataBytes: 2048,
      rssBudgetBytes: 536870912,
      fdBudget: 12288,
    },
    "frozen gateway config budgets drift",
  );
  const thresholds = { ...THRESHOLDS };
  if (!launchPath) {
    config.platform.publicBaseUrl = "https://localhost:8443";
    config.nginxTransport.publicHost = "localhost";
    config.browserOidc = {
      issuer: "https://idp.fixture.invalid",
      clientId: "issue12-fixture",
      authorizationUrl: "https://idp.fixture.invalid/authorize",
      tokenUrl: "https://idp.fixture.invalid/token",
      jwksUrl: "https://idp.fixture.invalid/keys",
      redirectUri: "https://localhost:8443/auth/callback",
      allowedAlgorithms: ["RS256"],
      actorRefClaim: "actor_ref",
      permissionsClaim: "permissions",
    };
  }
  const nginxSchema = JSON.parse(
    await readFile(join(ROOT, "config/nginx-profile.schema.json"), "utf8"),
  );
  const platformSchema = JSON.parse(
    await readFile(join(ROOT, "config/platform.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addSchema(
    nginxSchema,
    "https://coffee-platform.invalid/schemas/nginx-profile.schema.json",
  );
  const validate = ajv.compile(platformSchema);
  assert.ok(validate(config), ajv.errorsText(validate.errors));
  await json(join(resultDir, "profile.json"), config);
  const privateConfigBytes = launchPath
    ? configBytes
    : Buffer.from(dump(config, { noRefs: true }));
  await writeFile(join(privateDir, "platform.yaml"), privateConfigBytes, {
    mode: 0o400,
  });
  await chmod(join(privateDir, "platform.yaml"), 0o400);
  const { render, readRoutes } =
    await import("../../../tools/nginx/generate.mjs");
  assert.equal(
    typeof render,
    "function",
    "dependency: parent must expose the same native nginx renderer",
  );
  const openapi = yaml(
    await readFile(join(ROOT, "contracts/openapi/client-v1.yaml"), "utf8"),
    { json: true },
  );
  const nginx = render(
    config.nginxTransport,
    readRoutes(openapi),
    config.telemetry.nginxStatusEndpoint,
  );
  await writeFile(join(privateDir, "nginx.conf"), nginx);
  const { materials, fingerprints } = await certificates(
    join(privateDir, "certs"),
    config.environment,
    { launchPath: Boolean(options.launchPath) },
  );
  const { credentials, fingerprint } = await kafkaMaterial(
    join(privateDir, "kafka"),
    { launchPath: Boolean(options.launchPath) },
  );
  const actor = keyset(),
    api = keyset(),
    orders = options.launchPath ? keyset() : undefined,
    internal = options.launchPath ? keyset() : undefined,
    pricing = options.launchPath ? keyset() : undefined;
  const synthetic = {
    "security.actorContextEdgeSigningPrivateKey": actor.private,
    "security.actorContextEdgeVerificationPublicKeys": actor.verification,
    "security.apiPublicDelegationSigningPrivateKey": api.private,
    ...(orders
      ? { "security.ordersServiceDelegationSigningPrivateKey": orders.private }
      : {}),
    "edge.oidcClientSecret": "synthetic-public-pkce-fixture",
    "edge.tlsCaBundle": materials.idp.caPem,
    "telemetry.exporterToken":
      options.launchPath?.exporterToken ?? "synthetic-no-export",
  };
  for (const service of ["edge-gateway", "realtime-gateway", "api-public"]) {
    const secrets = {};
    for (const ref of config.services[service].secretRefs) {
      const value =
        ref === `security.serviceTransportKeys.${service}`
          ? JSON.stringify(materials[service])
          : ref === "kafka.realtime"
            ? credentials.realtime
            : synthetic[ref];
      assert.notEqual(
        value,
        undefined,
        `unhandled scoped synthetic ref: ${service}/${ref}`,
      );
      setRef(secrets, ref, value);
    }
    if (service === "edge-gateway")
      setRef(secrets, "edge.tlsCaBundle", materials.idp.caPem);
    await json(
      join(privateDir, `${service}.yaml`),
      {
        schemaVersion: 1,
        environment: config.environment,
        runtime: service,
        secrets,
      },
      0o400,
    );
  }
  if (options.launchPath) {
    const service = "api-internal",
      secrets = {};
    for (const ref of config.services[service].secretRefs) {
      const value =
        ref === "security.apiInternalDelegationSigningPrivateKey"
          ? internal.private
          : ref === "security.serviceVerificationKeys.orders-service"
            ? orders.verification
            : ref === "security.serviceVerificationKeys.pricing-service"
              ? pricing.verification
              : ref === "security.serviceTransportKeys.api-internal"
                ? JSON.stringify(materials[service])
                : ref === "telemetry.exporterToken"
                  ? synthetic["telemetry.exporterToken"]
                  : undefined;
      assert.notEqual(
        value,
        undefined,
        `unhandled scoped synthetic ref: ${service}/${ref}`,
      );
      setRef(secrets, ref, value);
    }
    await json(
      join(privateDir, `${service}.yaml`),
      {
        schemaVersion: 1,
        environment: config.environment,
        runtime: service,
        secrets,
      },
      0o400,
    );
  }
  const nginxDir = join(privateDir, "nginx-secrets");
  await mkdir(nginxDir, { mode: 0o755 });
  for (const [name, value] of Object.entries({
    "public.crt": materials.public.certPem,
    "public.key": materials.public.keyPem,
    "client.crt": materials["edge-nginx"].certPem,
    "client.key": materials["edge-nginx"].keyPem,
    "upstream-ca.crt": materials["edge-nginx"].caPem,
  }))
    await writeFile(join(nginxDir, name), value, { mode: 0o644 });
  const snapshot = await sourceSnapshot(privateDir, {
    launchPath: Boolean(options.launchPath),
  });
  const compilerPackage = JSON.parse(
    await readFile(
      join(snapshot.target, "node_modules/typescript/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    compilerPackage.version,
    JSON.parse(
      await readFile(join(ROOT, "config/toolchain-versions.json"), "utf8"),
    ).typescript,
    "exact pinned TS7 compiler required",
  );
  const targets = options.fixtureCheck
    ? [
        "packages/platform-kafka-runtime",
        "packages/platform-security",
        "packages/generated/client-v1",
      ]
    : options.launchPath
      ? [
          ...PRODUCT_BUILD_TARGETS,
          "packages/platform-http",
          "apps/api-internal",
          "apps/orders-service",
          "apps/orders-aroma-preparation",
          "apps/aroma-convergence",
        ]
      : PRODUCT_BUILD_TARGETS;
  // Invoke the already installed native compiler directly. pnpm exec in a moved
  // workspace can auto-install; installing or mutating hardlinked modules is forbidden.
  const compiler = await run(
    process.execPath,
    [
      "node_modules/typescript/bin/tsc",
      "-b",
      ...targets,
      "--force",
      "--pretty",
      "false",
    ],
    { cwd: snapshot.target, timeout: 120000 },
  );
  await writeFile(join(resultDir, "build.log"), compiler);
  const fixture = {
    config,
    credentials,
    materials,
    actorKeys: actor.verification,
    apiKeys: api.verification,
    mode: options.mode,
    profile: options.profile,
    ...(options.mode === "full" ? FULL : options.smoke),
    subjects: 100,
    shards: options.mode === "full" ? 1 : Math.min(2, options.smoke.clients),
    thresholds,
    resultDir: "/results",
    fixtureCheck: options.fixtureCheck,
    ...(launchPath
      ? {
          launchIdentity: launchPath.launchIdentity,
          lineageReceiptSha256: launchPath.lineageReceiptSha256,
          launchContextFile: launchPath.contextPath,
        }
      : {}),
  };
  if (options.launchPath)
    fixture.launchPath = {
      ordersServiceSigningPrivateKey: orders.private,
      exporterToken: options.launchPath.exporterToken ?? "synthetic-no-export",
    };
  await json(join(privateDir, "fixture.json"), fixture, 0o400);
  const toolchain = JSON.parse(
    await readFile(join(ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const dockerfile = await readFile(
    join(ROOT, "apps/edge-nginx/Dockerfile"),
    "utf8",
  );
  const nodeImage = /FROM (node:[^ ]+)/u.exec(dockerfile)?.[1];
  assert.ok(nodeImage);
  const compose = yaml(await readFile(join(ROOT, "compose.yaml"), "utf8"), {
    json: true,
  });
  const images = {
    node: nodeImage,
    nginx: toolchain.nginxImage,
  };
  assert.equal(
    compose.services.kafka.image,
    "coffee-platform-kafka:verified-artifact-required",
  );
  assert.equal(compose.services.kafka.pull_policy, "never");
  const imageIds = {};
  let nativeAdapter;
  if (!options.fixtureCheck) {
    // The pinned Node 26 image has no Confluent prebuilt addon. Build the existing
    // canonical runtime recipe; never install into or mutate hardlinked modules.
    const tag = `${options.runId}-native`;
    await run(
      "pnpm",
      [
        "image:build",
        "--target",
        "runtime",
        "--build-arg",
        "RUNTIME=realtime-gateway",
        "--tag",
        tag,
        "--load",
        ".",
      ],
      { timeout: 600000 },
    );
    images.node = (
      await docker("image", "inspect", "--format", "{{.Id}}", tag)
    ).trim();
    const probe = `const {createRequire}=require('node:module');const {dirname}=require('node:path');const app=createRequire('/app/package.json');const rt=createRequire(app.resolve('@coffee-platform/runtime'));const kafka=createRequire(rt.resolve('@coffee-platform/kafka-runtime'));const n=kafka('@confluentinc/kafka-javascript');console.log(JSON.stringify({node:process.version,abi:process.versions.modules,architecture:process.arch,path:dirname(kafka.resolve('@confluentinc/kafka-javascript/package.json'))+'/build/Release/confluent-kafka-javascript.node',packageVersion:kafka('@confluentinc/kafka-javascript/package.json').version,producer:typeof n.RdKafka.Producer,librdkafka:n.RdKafka.librdkafkaVersion}));`;
    nativeAdapter = JSON.parse(
      await docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        images.node,
        "--input-type=commonjs",
        "-e",
        probe,
      ),
    );
    assert.equal(nativeAdapter.node, process.version);
    assert.equal(nativeAdapter.architecture, process.arch);
    assert.equal(nativeAdapter.producer, "function");
    const packagePath = createRequire(
      join(snapshot.target, "packages/platform-kafka-runtime/package.json"),
    ).resolve("@confluentinc/kafka-javascript/package.json");
    assert.ok(
      packagePath.startsWith(snapshot.target + "/"),
      "native copy must stay inside owned snapshot",
    );
    assert.equal(
      nativeAdapter.packageVersion,
      JSON.parse(await readFile(packagePath, "utf8")).version,
    );
    assert.equal(
      nativeAdapter.librdkafka,
      /ARG LIBRDKAFKA_VERSION=([^\s]+)/u.exec(
        await readFile(join(ROOT, "Dockerfile"), "utf8"),
      )?.[1],
    );
    const destination = join(dirname(packagePath), "build/Release");
    await mkdir(destination, { recursive: true });
    const extraction = (
      await docker(
        "create",
        "--label",
        `${LABEL}=${options.runId}`,
        "--entrypoint",
        "node",
        images.node,
      )
    ).trim();
    try {
      assert.equal(
        JSON.parse(await docker("inspect", extraction))[0].Config.Labels[LABEL],
        options.runId,
      );
      await docker(
        "cp",
        `${extraction}:${nativeAdapter.path}`,
        join(destination, "confluent-kafka-javascript.node"),
      );
    } finally {
      await docker("rm", extraction);
      assert.equal(
        (
          await docker(
            "ps",
            "--all",
            "--filter",
            `id=${extraction}`,
            "--format",
            "{{.ID}}",
          )
        ).trim(),
        "",
      );
    }
    nativeAdapter.snapshotPath = relative(
      snapshot.target,
      join(destination, "confluent-kafka-javascript.node"),
    );
    nativeAdapter.sha256 = hash(
      await readFile(join(destination, "confluent-kafka-javascript.node")),
    );
    nativeAdapter.image = images.node;
    await json(join(resultDir, "native-adapter.json"), nativeAdapter);
  }
  for (const [name, image] of Object.entries(images)) {
    try {
      imageIds[name] = (
        await docker("image", "inspect", "--format", "{{.Id}}", image)
      ).trim();
    } catch (error) {
      if (error.code !== "FIXTURE_COMMAND_FAILED") throw error;
      await run("docker", ["pull", image], { timeout: 180000 });
      imageIds[name] = (
        await docker("image", "inspect", "--format", "{{.Id}}", image)
      ).trim();
    }
  }
  const compiled = {};
  for (const tree of ["packages", "apps"])
    for (const p of await walk(
      join(snapshot.target, tree),
      (p) => !p.includes("/node_modules/"),
    ))
      if (p.includes("/dist/") && p.endsWith(".js"))
        compiled[relative(snapshot.target, p)] = hash(await readFile(p));
  const kafkaArtifact = await loadVerifiedGateImage({
    target: "kafka",
    ...(launchPath ? { contextFile: launchPath.contextPath } : {}),
  });
  try {
    for (const field of [
      "imageId",
      "manifestDigest",
      "receiptSha256",
      "ociArtifactSha256",
      "baseImage",
      "candidateSha",
      "runId",
      "importTag",
    ])
      assert.equal(
        kafkaArtifact[field],
        kafkaArtifactProof[field],
        "G12 Kafka artifact changed during fixture preparation",
      );
    if (launchPath) {
      assert.deepEqual(kafkaArtifact.launchIdentity, launchPath.launchIdentity);
      assert.equal(
        kafkaArtifact.lineageReceiptSha256,
        launchPath.lineageReceiptSha256,
      );
      assert.deepEqual(
        kafkaArtifactProof.launchIdentity,
        kafkaArtifact.launchIdentity,
      );
      assert.equal(
        kafkaArtifactProof.lineageReceiptSha256,
        kafkaArtifact.lineageReceiptSha256,
      );
    }
    // Immutable IDs also handle a preexisting verified image without trusting tags.
    images.kafka = kafkaArtifact.imageId;
    imageIds.kafka = kafkaArtifact.imageId;
    const manifest = {
      schema: "coffee.realtime.transport-soak-manifest/v1",
      runId: options.runId,
      createdAt: isoNow(),
      mode: options.mode,
      profile: options.profile,
      claims:
        options.mode === "full"
          ? "1 live SSE subscriber, 100 ACKed invalidations/s, 30min TTL-preserving re-auth; separate 512/513 admission prephase"
          : "smoke-not-launch-proof",
      measurement: options.mode === "full" ? FULL : options.smoke,
      subjects: 100,
      subjectDistribution:
        "four sequential versions per subject burst, 100 subjects per four seconds; check every subject/client maximum",
      latencyPath:
        "wall clock encoded in actual producer messageId immediately before SASL_SSL send -> Kafka ACK/consumer -> real hub -> mTLS nginx upstream -> TLS client decoded frame (includes producer delivery)",
      thresholds,
      hardware: {
        architecture: process.arch,
        platform: process.platform,
        availableParallelism: availableParallelism(),
        cpus: cpus().map((c) => c.model),
        memoryBytes: totalmem(),
        node: process.version,
        driverHostFdLimit: await readFile("/proc/self/limits", "utf8"),
      },
      containerBudgets: {
        "edge-nginx": {
          cpus: 2,
          memory: thresholds.nginxRssBytes,
          nofile: 16384,
        },
        "realtime-gateway": {
          cpus: 2,
          memory: thresholds.realtimeRssBytes,
          nofile: 12288,
        },
        "edge-gateway": { cpus: 2, memory: 536870912, nofile: 4096 },
        "api-public": { cpus: 2, memory: 536870912, nofile: 4096 },
        driver: { cpus: 8, memory: 2147483648, nofile: 32768 },
        kafka: { cpus: 2, memory: 2147483648, nofile: 8192 },
      },
      limits: config.nginxTransport.limits,
      realtime: config.services["realtime-gateway"].realtime,
      trustChain: {
        browserTls: "generated CA -> localhost nginx certificate",
        authorizer:
          "actual edge-gateway main + OIDC HTTPS fixture/RS256/PKCE + in-memory sessions; no authority injection",
        actor:
          "actual Edge-generated compact Ed25519; generated scoped active/previous verifier",
        receiver:
          "actual realtime-gateway main; mTLS SPIFFE edge-nginx independent of actor signature",
        broker:
          "apache Kafka KRaft SASL_SSL/PLAIN, different generated broker/realtime/publisher/inspector credentials",
        apiHeadroom:
          "actual api-public, mTLS/delegation validated fixture orders-owner 404, not owner/business capacity proof",
        fingerprints,
        kafkaCertificate: fingerprint,
      },
      authExpiry: {
        actorMaxTtlSeconds: 60,
        sessionTtlMs: 900000,
        sessionLoginIntervalMs: 600000,
        authSweepMs: config.services["realtime-gateway"].realtime.authCheckMs,
        retryMs: 3000,
        readyTimeoutMs: 10000,
        policy:
          "no actor or session TTL extension; actual OIDC login before session expiry; measure every auth close/re-auth gap and replay, fail unexpected/pressure close or missing recovery",
      },
      images,
      imageIds,
      kafkaSupplyChain: kafkaArtifact,
      ...(launchPath
        ? {
            launchContextFile: launchPath.contextPath,
            launchIdentity: launchPath.launchIdentity,
            lineageReceiptSha256: launchPath.lineageReceiptSha256,
            databaseOwnershipSha256: hash(
              await readFile(launchPath.databaseOwnershipFile),
            ),
          }
        : {}),
      profileSha256: hash(await readFile(join(resultDir, "profile.json"))),
      fixtureSha256: hash(await readFile(join(privateDir, "fixture.json"))),
      configSha256: hash(await readFile(join(privateDir, "platform.yaml"))),
      nginxSha256: hash(nginx),
      sources: snapshot.sources,
      compiled,
      supportingSources: {},
      resultFiles: [
        "profile-manifest.json",
        "profile.json",
        "build.log",
        "result.json",
        "samples.jsonl",
        "protocol.jsonl",
        "reauth.jsonl",
        "worker-results.json",
        "containers.json",
        "cleanup.json",
      ],
    };
    if (nativeAdapter !== undefined) manifest.nativeAdapter = nativeAdapter;
    for (const p of [
      "Dockerfile",
      "patches/librdkafka-resume-wakeup.patch",
      ".dockerignore",
      "tools/docker-build.mjs",
      "apps/edge-nginx/Dockerfile",
      "config/platform.yaml",
      "config/database-ownership.json",
      "config/platform.schema.json",
      "config/nginx-profile.schema.json",
      "config/toolchain-versions.json",
      "compose.yaml",
      "tools/nginx/generate.mjs",
      "apps/edge-nginx/snippets/upstream-tls.conf",
      "apps/edge-nginx/snippets/business-headers.conf",
      "tests/realtime/soak.test.mjs",
    ])
      manifest.supportingSources[p] =
        p === "config/platform.yaml"
          ? hash(configBytes)
          : hash(await readFile(join(ROOT, p)));
    await json(join(resultDir, "profile-manifest.json"), manifest);
    return {
      manifest,
      privateDir,
      snapshot: snapshot.target,
      images,
      config,
      ...(launchPath
        ? {
            launchIdentity: launchPath.launchIdentity,
            lineageReceiptSha256: launchPath.lineageReceiptSha256,
            launchContextFile: launchPath.contextPath,
            databaseOwnershipFile: launchPath.databaseOwnershipFile,
          }
        : {}),
    };
  } catch (error) {
    try {
      removeVerifiedGateImage({ target: "kafka", image: kafkaArtifact });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "REALTIME_KAFKA_PREPARATION_CLEANUP_FAILED",
      );
    }
    throw error;
  }
}

export function assertFixtureKafkaNamespaceBound(
  config,
  runtime,
  launchIdentity,
) {
  const service = config.services?.[runtime]?.kafka;
  assert.ok(service, `configured Kafka runtime exists: ${runtime}`);
  return deriveRuntimeKafkaTarget({
    config: config.kafka,
    service,
    enabled: config.verification?.kafkaNamespaceIsolation === true,
    environment: config.environment,
    ...(launchIdentity ? { launchIdentity } : {}),
  });
}
export async function verifyPrepared(resultDir, approvedSha) {
  const manifestText = await readFile(
    join(resultDir, "profile-manifest.json"),
    "utf8",
  );
  assert.equal(
    hash(manifestText),
    approvedSha,
    "manifest approval hash mismatch",
  );
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.mode, "full");
  assert.equal(manifest.profile, "operator-1");
  assert.equal(
    hash(await readFile(join(resultDir, "profile.json"))),
    manifest.profileSha256,
    "prepared profile hash drift",
  );
  assert.equal(
    hash(await readFile(join(resultDir, "private/fixture.json"))),
    manifest.fixtureSha256,
    "prepared fixture input hash drift",
  );
  let launchPath;
  if (manifest.launchContextFile) {
    launchPath = await readFixtureLaunchPath({
      launchContextFile: manifest.launchContextFile,
    });
    assert.deepEqual(manifest.launchIdentity, launchPath.launchIdentity);
    assert.equal(
      manifest.lineageReceiptSha256,
      launchPath.lineageReceiptSha256,
    );
    assert.equal(
      manifest.databaseOwnershipSha256,
      hash(await readFile(launchPath.databaseOwnershipFile)),
    );
  }
  for (const [p, h] of Object.entries({
    ...manifest.sources,
    ...manifest.supportingSources,
  })) {
    const sourceRoot =
      p === "config/platform.yaml" && launchPath
        ? launchPath.candidateRoot
        : ROOT;
    assert.equal(
      hash(await readFile(join(sourceRoot, p))),
      h,
      `source changed since frozen manifest: ${p}`,
    );
  }
  const privateDir = join(resultDir, "private"),
    snapshot = join(privateDir, "app");
  for (const [p, h] of Object.entries(manifest.sources ?? {}))
    assert.equal(
      hash(await readFile(join(snapshot, p))),
      h,
      `prepared source drift: ${p}`,
    );
  assert.equal(
    hash(await readFile(join(privateDir, "platform.yaml"))),
    manifest.configSha256,
  );
  assert.equal(
    hash(await readFile(join(privateDir, "nginx.conf"))),
    manifest.nginxSha256,
  );
  for (const [p, h] of Object.entries(manifest.compiled))
    assert.equal(
      hash(await readFile(join(snapshot, p))),
      h,
      `prepared compiled hash drift: ${p}`,
    );
  assert.equal(
    hash(await readFile(join(snapshot, manifest.nativeAdapter.snapshotPath))),
    manifest.nativeAdapter.sha256,
    "prepared native adapter hash drift",
  );
  const currentKafkaArtifact = await loadVerifiedGateImage({
    target: "kafka",
    ...(launchPath ? { contextFile: launchPath.contextPath } : {}),
    loadImage: false,
  });
  for (const field of [
    "imageId",
    "manifestDigest",
    "receiptSha256",
    "ociArtifactSha256",
    "baseImage",
    "candidateSha",
    "runId",
    "importTag",
  ])
    assert.equal(
      manifest.kafkaSupplyChain?.[field],
      currentKafkaArtifact[field],
      `prepared G12 Kafka identity drift: ${field}`,
    );
  if (launchPath) {
    assert.deepEqual(
      currentKafkaArtifact.launchIdentity,
      launchPath.launchIdentity,
    );
    assert.equal(
      currentKafkaArtifact.lineageReceiptSha256,
      launchPath.lineageReceiptSha256,
    );
    assert.deepEqual(
      currentKafkaArtifact.launchIdentity,
      manifest.launchIdentity,
    );
    assert.equal(
      currentKafkaArtifact.lineageReceiptSha256,
      manifest.lineageReceiptSha256,
    );
  }
  assert.equal(typeof manifest.kafkaSupplyChain.imported, "boolean");
  assert.equal(
    manifest.images?.kafka,
    currentKafkaArtifact.imageId,
    "prepared Kafka runtime must use the verified immutable image ID",
  );
  assert.equal(
    manifest.imageIds?.kafka,
    currentKafkaArtifact.imageId,
    "prepared Kafka image ID drift",
  );
  for (const [name, image] of Object.entries(manifest.images))
    assert.equal(
      (
        await docker(
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          name === "kafka" ? manifest.imageIds.kafka : image,
        )
      ).trim(),
      manifest.imageIds[name],
      `prepared image drift: ${name}`,
    );
  return {
    manifest,
    privateDir,
    snapshot,
    images: manifest.images,
    config: JSON.parse(await readFile(join(resultDir, "profile.json"), "utf8")),
    ...(launchPath
      ? {
          launchIdentity: launchPath.launchIdentity,
          lineageReceiptSha256: launchPath.lineageReceiptSha256,
          launchContextFile: launchPath.contextPath,
          databaseOwnershipFile: launchPath.databaseOwnershipFile,
        }
      : {}),
  };
}
export async function erasePrivate(resultDir) {
  try {
    const manifest = await readFile(
      join(resultDir, "profile-manifest.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (manifest?.kafkaSupplyChain) {
      const launchPath = manifest.launchContextFile
        ? await readFixtureLaunchPath({
            launchContextFile: manifest.launchContextFile,
          })
        : undefined;
      if (launchPath) {
        assert.deepEqual(manifest.launchIdentity, launchPath.launchIdentity);
        assert.equal(
          manifest.lineageReceiptSha256,
          launchPath.lineageReceiptSha256,
        );
        assert.equal(
          manifest.databaseOwnershipSha256,
          hash(await readFile(launchPath.databaseOwnershipFile)),
        );
      }
      const image = await loadVerifiedGateImage({
        target: "kafka",
        ...(launchPath ? { contextFile: launchPath.contextPath } : {}),
        loadImage: false,
      });
      if (launchPath) {
        assert.deepEqual(image.launchIdentity, launchPath.launchIdentity);
        assert.equal(
          image.lineageReceiptSha256,
          launchPath.lineageReceiptSha256,
        );
        assert.deepEqual(image.launchIdentity, manifest.launchIdentity);
        assert.equal(image.lineageReceiptSha256, manifest.lineageReceiptSha256);
      }
      for (const field of [
        "imageId",
        "runId",
        "candidateSha",
        "receiptSha256",
        "ociArtifactSha256",
        "importTag",
      ])
        assert.equal(
          manifest.kafkaSupplyChain[field],
          image[field],
          "realtime Kafka cleanup identity drift",
        );
      assert.equal(typeof manifest.kafkaSupplyChain.imported, "boolean");
      removeVerifiedGateImage({
        target: "kafka",
        image: { ...image, imported: manifest.kafkaSupplyChain.imported },
      });
    }
  } finally {
    await rm(join(resultDir, "private"), { recursive: true, force: true });
  }
}
