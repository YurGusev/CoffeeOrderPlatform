#!/usr/bin/env node
/**
 * Real transport proof, not a node:test unit suite. Run explicitly:
 *   node tests/realtime/soak.test.mjs --smoke --profile reference-512 --result-dir "$TMPDIR/realtime-smoke"
 *   node tests/realtime/soak.test.mjs --fixture-check --result-dir "$TMPDIR/realtime-fixtures"
 *   node tests/realtime/soak.test.mjs --prepare --profile operator-1 --result-dir "$TMPDIR/realtime-full"
 * Inspect/freeze profile-manifest.json, then use its SHA256 (no unattended full run):
 *   node tests/realtime/soak.test.mjs --prepared "$TMPDIR/realtime-full" --approve-manifest <sha256>
 * Full operator-1 is 1/100/s/1800000ms. Smoke can never return full PASS.
 * Private material is only newly generated synthetic fixture material, deleted after a run.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  prepare,
  verifyPrepared,
  erasePrivate,
  run,
  docker,
  json,
  hash,
  LABEL,
  ROOT,
  redact,
  productArgs,
  readCgroupMemory,
  safeProductStartupFailure,
} from "./fixtures/setup.mjs";
import {
  nowMs,
  isoNow,
  parseTime,
  classifyResult,
  driverFailure,
  FULL,
  THRESHOLDS,
  ulid,
} from "./fixtures/protocol.mjs";
import Ajv2020 from "ajv/dist/2020.js";
import { assertFixtureKafkaNamespaceBound } from "./fixtures/setup.mjs";

async function verifyBrokerFixture(broker, dir, config, launchIdentity) {
  const runtimeTarget = assertFixtureKafkaNamespaceBound(
    config,
    "realtime-gateway",
    launchIdentity,
  );
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat(
    "date-time",
    (v) => typeof v === "string" && Number.isFinite(parseTime(v)),
  );
  ajv.addFormat("uuid", (v) =>
    /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu.test(v),
  );
  let eventSchema;
  for (const p of [
    "common/identifiers.v1.schema.json",
    "common/money-version-time.v1.schema.json",
    "common/message-envelope.v1.schema.json",
    "events/realtime-invalidated.v1.schema.json",
  ]) {
    const schema = JSON.parse(
      await readFile(join(ROOT, "contracts/schemas", p), "utf8"),
    );
    ajv.addSchema(schema);
    if (p.startsWith("events/")) eventSchema = schema;
  }
  const validate = ajv.getSchema(eventSchema.$id),
    base = JSON.parse(
      await readFile(
        join(
          ROOT,
          "contracts/fixtures/positive/events/realtime-invalidated.v1.json",
        ),
        "utf8",
      ),
    );
  const records = Array.from({ length: 10 }, (_, n) => {
    const e = structuredClone(base);
    e.messageId = `msg_${ulid(nowMs(), BigInt(n + 1))}`;
    e.occurredAt = isoNow();
    e.aggregate.ref =
      e.payload.subjectRef = `ord_${ulid(1700000000000, BigInt(n + 1))}`;
    e.aggregate.version = e.payload.ownerVersion = String(n + 1);
    e.correlationId = randomUUID();
    assert.ok(validate(e), ajv.errorsText(validate.errors));
    return e;
  });
  await run(
    "docker",
    [
      "exec",
      "--interactive",
      broker,
      "/opt/kafka/bin/kafka-console-producer.sh",
      "--bootstrap-server",
      "kafka:9092",
      "--command-config",
      "/etc/kafka/secrets/publisher.properties",
      "--topic",
      runtimeTarget.topics["coffee.realtime.invalidate.v1"],
      "--property",
      "parse.key=true",
      "--property",
      "key.separator=|",
      "--producer-property",
      "acks=all",
    ],
    {
      input:
        records
          .map((e) => `${e.payload.subjectRef}|${JSON.stringify(e)}`)
          .join("\n") + "\n",
      timeout: 30000,
    },
  );
  const wire = await run(
    "docker",
    [
      "exec",
      broker,
      "/opt/kafka/bin/kafka-console-consumer.sh",
      "--bootstrap-server",
      "kafka:9092",
      "--command-config",
      "/etc/kafka/secrets/client.properties",
      "--topic",
      runtimeTarget.topics["coffee.realtime.invalidate.v1"],
      "--from-beginning",
      "--max-messages",
      "10",
      "--timeout-ms",
      "10000",
      "--formatter-property",
      "print.key=true",
      "--formatter-property",
      "key.separator=|",
    ],
    { timeout: 20000 },
  );
  await writeFile(join(dir, "fixture-consumer.log"), wire);
  const received = wire
    .trim()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("|");
      assert.ok(i > 0, `consumer key framing: ${line.slice(0, 180)}`);
      return { key: line.slice(0, i), envelope: JSON.parse(line.slice(i + 1)) };
    });
  assert.equal(received.length, 10);
  for (const expected of records) {
    const actual = received.find(
      (r) => r.envelope.messageId === expected.messageId,
    );
    assert.ok(actual, "real Kafka record missing");
    assert.equal(actual.key, expected.payload.subjectRef);
    assert.deepEqual(actual.envelope, expected);
  }
  const proof = {
    status: "fixture-transport-only-not-launch-proof",
    launchProof: false,
    sent: records.length,
    received: received.length,
    protocol: "SASL_SSL",
    producer:
      "pinned Apache Kafka Java CLI, generated publisher credentials, acks=all",
    consumer:
      "pinned Apache Kafka Java CLI, generated inspector credentials, actual broker offsets",
    records: received,
  };
  await json(join(dir, "fixture-transport.json"), proof);
  return proof;
}

export async function bootstrapOwnedOrdersKafka({
  broker,
  runId,
  config,
  inspectBroker,
  runKafka,
  writeReceipt,
  owners = ["orders-service", "orders-aroma-preparation"],
  launchIdentity,
}) {
  const runtimeTargets = new Map(
    owners.map((owner) => [
      owner,
      assertFixtureKafkaNamespaceBound(config, owner, launchIdentity),
    ]),
  );
  const inspected = await inspectBroker(broker),
    state = Array.isArray(inspected) ? inspected[0] : inspected;
  assert.ok(
    state && state.State?.Running === true,
    "owner Kafka bootstrap requires a running broker",
  );
  assert.equal(
    state.Config?.Labels?.[LABEL],
    runId,
    "owner Kafka bootstrap is limited to this fixture broker",
  );
  assert.ok(
    state.HostConfig?.Tmpfs?.["/var/lib/kafka/data"],
    "owner Kafka bootstrap requires a newly launched tmpfs broker",
  );
  const mountCheck = await runKafka(broker, [
    "sh",
    "-c",
    "grep -Eq '^[^ ]+ /var/lib/kafka/data tmpfs ' /proc/mounts && printf mounted",
  ]);
  assert.equal(
    mountCheck.trim(),
    "mounted",
    "owner Kafka data directory is an active tmpfs mount",
  );
  assert.ok(
    Array.isArray(owners) &&
      owners.length > 0 &&
      owners.every((name) =>
        [
          "orders-service",
          "orders-aroma-preparation",
          "aroma-convergence",
        ].includes(name),
      ),
    "Kafka bootstrap owners are an explicit bounded fixture allowlist",
  );
  const groups = [];
  for (const serviceName of owners) {
    const service = config.services[serviceName];
    assert.ok(service, `configured owner runtime exists: ${serviceName}`);
    for (const consumer of service.kafka.consumers.filter(
      (candidate) => candidate.processing === "durable",
    )) {
      for (const topicName of consumer.topics) {
        const topic = Object.values(config.kafka.topics).find(
          (candidate) => candidate.name === topicName,
        );
        assert.ok(topic, `configured durable owner topic exists: ${topicName}`);
        const runtimeTarget = runtimeTargets.get(serviceName);
        const physicalTopic = runtimeTarget?.topics[topicName];
        const physicalGroup = runtimeTarget?.groups[consumer.groupId];
        assert.equal(typeof physicalTopic, "string");
        assert.equal(typeof physicalGroup, "string");
        if (
          !groups.some(
            (item) =>
              item.groupId === physicalGroup && item.topic === physicalTopic,
          )
        )
          groups.push({
            service: serviceName,
            groupId: physicalGroup,
            topic: physicalTopic,
            partitions: topic.partitions,
          });
      }
    }
  }
  assert.ok(
    groups.length > 0,
    "actual Orders owners have durable Kafka consumers",
  );
  const cli = [
    "/opt/kafka/bin/kafka-consumer-groups.sh",
    "--bootstrap-server",
    "kafka:9092",
    "--command-config",
    "/etc/kafka/secrets/client.properties",
  ];
  const topics = [
    ...new Map(
      groups.map((item) => [
        item.topic,
        { name: item.topic, partitions: item.partitions },
      ]),
    ).values(),
  ];
  const emptyTopics = [];
  for (const topic of topics) {
    const output = await runKafka(broker, [
      "/opt/kafka/bin/kafka-get-offsets.sh",
      "--bootstrap-server",
      "kafka:9092",
      "--command-config",
      "/etc/kafka/secrets/client.properties",
      "--topic",
      topic.name,
      "--time",
      "-1",
    ]);
    const offsets = output
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const match = /^([^:]+):(\d+):(\d+)$/u.exec(line.trim());
        assert.ok(
          match,
          `Kafka end-offset output is bounded for ${topic.name}`,
        );
        assert.equal(match[1], topic.name);
        return { partition: Number(match[2]), endOffset: match[3] };
      })
      .sort((a, b) => a.partition - b.partition);
    assert.equal(
      offsets.length,
      topic.partitions,
      `new owner topic partition count: ${topic.name}`,
    );
    assert.deepEqual(
      offsets.map((item) => item.partition),
      Array.from({ length: topic.partitions }, (_, index) => index),
    );
    assert.ok(
      offsets.every((item) => item.endOffset === "0"),
      `new owner topic has no records before producer startup: ${topic.name}`,
    );
    emptyTopics.push({ topic: topic.name, partitions: offsets });
  }
  const initializedGroups = [];
  for (const group of groups) {
    await runKafka(broker, [
      ...cli,
      "--group",
      group.groupId,
      "--topic",
      group.topic,
      "--reset-offsets",
      "--to-earliest",
      "--execute",
    ]);
    const output = await runKafka(broker, [
      ...cli,
      "--describe",
      "--group",
      group.groupId,
    ]);
    const offsets = output
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u))
      .filter(
        (parts) =>
          parts[0] === group.groupId &&
          parts[1] === group.topic &&
          /^\d+$/u.test(parts[2] ?? ""),
      )
      .map((parts) => ({
        partition: Number(parts[2]),
        currentOffset: /^\d+$/u.test(parts[3] ?? "") ? parts[3] : null,
        endOffset: /^\d+$/u.test(parts[4] ?? "") ? parts[4] : null,
        lag: /^\d+$/u.test(parts[5] ?? "") ? parts[5] : null,
      }))
      .sort((a, b) => a.partition - b.partition);
    assert.equal(
      offsets.length,
      group.partitions,
      `initialized durable group partitions: ${group.groupId}`,
    );
    assert.deepEqual(
      offsets.map((item) => item.partition),
      Array.from({ length: group.partitions }, (_, index) => index),
    );
    assert.ok(
      offsets.every(
        (item) =>
          item.currentOffset === "0" &&
          item.endOffset === "0" &&
          item.lag === "0",
      ),
      `durable group starts at offset zero on empty topic: ${group.groupId}`,
    );
    initializedGroups.push({
      service: group.service,
      groupId: group.groupId,
      topic: group.topic,
      partitions: offsets,
    });
  }
  const receipt = {
    verified: true,
    fixtureOnly: true,
    broker: {
      containerId: state.Id,
      imageId: state.Image,
      runLabel: runId,
      freshTmpfsData: true,
      tmpfsMountVerified: true,
    },
    topics: emptyTopics,
    groups: initializedGroups,
  };
  await writeReceipt(receipt);
  return receipt;
}

export function scratchRoot() {
  const declared = process.env.COFFEE_LAUNCH_SCRATCH ?? process.env.TMPDIR;
  if (declared === undefined || declared.length === 0)
    throw new Error(
      "COFFEE_LAUNCH_SCRATCH или TMPDIR обязателен: каталог soak задаётся явно",
    );
  return resolve(declared);
}

export function parse(args) {
  const options = {
    mode: "full",
    profile: "reference-512",
    prepareOnly: false,
    fixtureCheck: false,
    smoke: { clients: 512, rate: 100, durationMs: 10000 },
    runId: `i12-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
  };
  const valued = new Set([
    "--profile",
    "--result-dir",
    "--prepared",
    "--approve-manifest",
    "--smoke-clients",
    "--smoke-duration-ms",
  ]);
  const flags = new Set(["--smoke", "--prepare", "--fixture-check", "--help"]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    assert.ok(valued.has(arg) || flags.has(arg), `unknown argument ${arg}`);
    assert.ok(!seen.has(arg), `duplicate argument ${arg}`);
    seen.add(arg);
    const value = valued.has(arg) ? args[++i] : true;
    if (valued.has(arg))
      assert.ok(
        typeof value === "string" && !value.startsWith("--"),
        `value required for ${arg}`,
      );
    if (arg === "--smoke") options.mode = "smoke";
    if (arg === "--prepare") options.prepareOnly = true;
    if (arg === "--fixture-check") {
      options.fixtureCheck = true;
      options.mode = "smoke";
    }
    if (arg === "--profile") options.profile = value;
    if (arg === "--result-dir") options.resultDir = resolve(value);
    if (arg === "--prepared") options.prepared = resolve(value);
    if (arg === "--approve-manifest") options.approval = value;
    if (arg === "--smoke-clients") {
      assert.match(value, /^[1-9][0-9]*$/u);
      options.smoke.clients = Number(value);
    }
    if (arg === "--smoke-duration-ms") {
      assert.match(value, /^[1-9][0-9]*$/u);
      options.smoke.durationMs = Number(value);
    }
    if (arg === "--help") options.help = true;
  }
  if (options.help) return options;
  assert.ok(
    ["reference-512", "operator-1"].includes(options.profile),
    "unsupported transport profile",
  );
  if (options.prepared) {
    assert.ok(
      options.approval,
      "full run requires exact frozen manifest SHA256 approval",
    );
    assert.match(options.approval, /^[a-f0-9]{64}$/u);
    assert.ok(
      !options.prepareOnly && options.mode === "full" && !options.resultDir,
    );
    options.profile = "operator-1";
  } else if (options.mode === "full") {
    assert.equal(
      options.profile,
      "operator-1",
      "full mode requires explicit --profile operator-1; reference remains512",
    );
    assert.ok(
      options.prepareOnly,
      "first --prepare, inspect/freeze manifest, then --prepared PATH --approve-manifest SHA256",
    );
  }
  assert.ok(
    options.smoke.clients <= 512 &&
      options.smoke.durationMs >= 1000 &&
      options.smoke.durationMs <= 120000,
    "smoke limits: 1..512 clients, 1000..120000ms; no launch claim",
  );
  assert.ok(
    options.mode === "smoke" ||
      (!seen.has("--smoke-clients") && !seen.has("--smoke-duration-ms")),
    "never shorten full thresholds",
  );
  options.resultDir ??=
    options.prepared ?? join(scratchRoot(), `realtime-soak-${options.runId}`);
  const scratch = scratchRoot(),
    rel = relative(scratch, options.resultDir),
    repoRelative = relative(ROOT, options.resultDir);
  assert.ok(
    rel && !rel.startsWith("..") && !rel.startsWith("/"),
    "result artifacts must be in declared Hermes scratch, never tracked evidence/docs",
  );
  assert.ok(
    repoRelative === ".." ||
      repoRelative.startsWith(`..${sep}`) ||
      isAbsolute(repoRelative),
    "result artifacts must stay outside the repository",
  );
  return options;
}
export async function bounded(
  fn,
  { timeout = 30000, interval = 250, label = "condition" } = {},
) {
  const end = performance.now() + timeout;
  let last;
  while (performance.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(interval, Math.max(0, end - performance.now()))),
    );
  }
  throw Object.assign(new Error(`${label}: ${last?.message ?? "timeout"}`), {
    code: "FIXTURE_READINESS_TIMEOUT",
  });
}
function nginxErrorCategory(value) {
  const text = String(value ?? "").toLowerCase();
  if (/host not found in upstream|could not be resolved/u.test(text))
    return "upstream_resolution";
  if (/cannot load certificate|certificate.*failed/u.test(text))
    return "certificate_load";
  if (/ssl_ctx_use_privatekey|private key.*failed/u.test(text))
    return "tls_key_load";
  if (/permission denied/u.test(text)) return "permission_denied";
  if (/no such file|bio_new_file|open\(\).*failed/u.test(text))
    return "file_open";
  if (/unknown directive|invalid number of arguments/u.test(text))
    return "invalid_directive";
  if (/bind\(\).*failed|address already in use/u.test(text))
    return "bind_failed";
  if (/resolver/u.test(text)) return "resolver_failure";
  return text ? "nginx_error" : "unavailable";
}
async function nginxStartupDiagnostic({ name, id, state, stage }) {
  const safeState = {
    Running: Boolean(state?.Running),
    ExitCode: Number.isInteger(state?.ExitCode) ? state.ExitCode : null,
    OOMKilled: Boolean(state?.OOMKilled),
    Error: nginxErrorCategory(state?.Error),
    StartedAt: typeof state?.StartedAt === "string" ? state.StartedAt : "",
    FinishedAt: typeof state?.FinishedAt === "string" ? state.FinishedAt : "",
  };
  let errorOrWarningLines = "";
  try {
    const logs = await run("docker", ["logs", "--tail", "20", id], {
      timeout: 5000,
      outputLimit: 2048,
      includeStderr: true,
    });
    assert.ok(
      Buffer.byteLength(logs, "utf8") <= 2048,
      "bounded nginx startup logs",
    );
    const entries = logs
      .split("\n")
      .map((line) => {
        const text = line.trim();
        const nginx =
          /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} \[(emerg|alert|crit|error)\] \d+#\d+:\s*(.*)$/u.exec(
            text,
          );
        if (nginx)
          return `[${nginx[1]}] category=${nginxErrorCategory(nginx[2])}`;
        const missing =
          /(?:^|:\s*)exec:\s*([A-Za-z0-9._-]{1,40}):\s*not found$/iu.exec(text);
        if (missing && new Set(["nginx", "-e", "sh", "bash"]).has(missing[1]))
          return `[error] category=entrypoint_command_missing executable=${missing[1]}`;
        return null;
      })
      .filter(Boolean)
      .slice(0, 20);
    errorOrWarningLines = entries.join("\n").slice(0, 2048);
  } catch {
    /* retain only safe inspect state if bounded log capture is unavailable */
  }
  return {
    name,
    stage,
    state: safeState,
    ...(errorOrWarningLines ? { errorOrWarningLines } : {}),
  };
}
export async function runTransportFixture(options, hooks = {}) {
  if (hooks.exercise || hooks.startOwner || hooks.launchPath) {
    assert.equal(
      options.mode,
      "smoke",
      "owner browser proof is smoke-only, never full capacity acceptance",
    );
    assert.equal(options.smoke.clients, 1);
    assert.ok(
      !options.prepared && !options.prepareOnly && !options.fixtureCheck,
    );
    if (hooks.launchPath) {
      assert.equal(typeof hooks.launchPath.startOwner, "function");
      assert.equal(typeof hooks.launchPath.exercise, "function");
    } else {
      assert.equal(typeof hooks.exercise, "function");
      assert.equal(typeof hooks.startOwner, "function");
    }
  }
  const dir = options.resultDir,
    network = `${options.runId}-net`,
    owned = [],
    containerReceipts = [],
    samples = [];
  let setup,
    ownerResource,
    retainedPreparation = false,
    networkCreated = false,
    driverExit,
    driverRunning = false,
    hostFatal,
    controlBusy = false,
    monitorBusy = false,
    realtimeStopped = false,
    observersStopping = false,
    observerRunning = false,
    observerWork = Promise.resolve();
  const result = {
    schema: "coffee.realtime.transport-soak-result/v1",
    mode: options.mode,
    profile: options.profile,
    clients: options.mode === "full" ? FULL.clients : options.smoke.clients,
    rate: 100,
    durationMs: 0,
    published: 0,
    minLive: 0,
    maxLive: 0,
    disconnects: 0,
    reconnects: 0,
    eventLatencyP95Ms: null,
    eventLoopP95Ms: null,
    protocolFrames: 0,
    coverageChecks: 0,
    checks: {},
    cleanupVerified: false,
    error: null,
  };
  async function launch(
    role,
    image,
    args,
    {
      cpus = 2,
      memory = 536870912,
      nofile = 4096,
      aliases = [],
      fixtures = true,
    } = {},
  ) {
    const name = `${options.runId}-${role}`;
    const scopedProduct = [
      "edge-gateway",
      "api-public",
      "realtime-gateway",
    ].includes(role);
    const nativeProduct =
      scopedProduct && Boolean(setup.manifest.qualification);
    const scopedOwner = [
      "api-internal",
      "orders-service",
      "orders-aroma-preparation",
    ].includes(role);
    const componentOwnership = Boolean(
      hooks.launchPath &&
      !setup.launchIdentity &&
      ["orders-service", "orders-aroma-preparation"].includes(role),
    );
    const ownershipFile = setup.launchIdentity
      ? setup.databaseOwnershipFile
      : componentOwnership
        ? join(ROOT, "config/database-ownership.json")
        : undefined;
    const expectedOwnershipSha256 = componentOwnership
      ? setup.manifest.supportingSources["config/database-ownership.json"]
      : undefined;
    if (componentOwnership)
      assert.equal(
        hash(await readFile(ownershipFile)),
        expectedOwnershipSha256,
        "component ownership source changed",
      );
    const scopedLaunchDriver =
      role === "driver" && Boolean(setup.launchIdentity);
    const base = [
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      `${LABEL}=${options.runId}`,
      "--network",
      network,
      "--init",
      "--cpus",
      String(cpus),
      "--memory",
      String(memory),
      "--memory-swap",
      String(memory),
      "--ulimit",
      `nofile=${nofile}:${nofile}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
    ];
    for (const a of aliases) base.push("--network-alias", a);
    if (fixtures) {
      if (!nativeProduct) base.push("--entrypoint", "docker-entrypoint.sh");
      base.push(
        "--user",
        "1000:1000",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=67108864,uid=1000,gid=1000",
      );
      if (nativeProduct) {
        base.push(
          "--mount",
          `type=bind,src=${setup.privateDir}/platform.yaml,dst=/app/config/platform.yaml,readonly`,
          "--mount",
          `type=bind,src=${setup.privateDir}/${role}.yaml,dst=/run/secrets/coffee-platform.yaml,readonly`,
          "--mount",
          `type=bind,src=${setup.launchContextFile},dst=/run/coffee-launch/context.json,readonly`,
        );
        if (role === "edge-gateway")
          base.push(
            "--mount",
            `type=bind,src=${setup.privateDir}/certs/ca.crt,dst=/run/g15-browser/idp-ca.crt,readonly`,
          );
      } else if (scopedProduct || scopedOwner) {
        base.push(
          "--mount",
          `type=bind,src=${setup.snapshot},dst=/app,readonly`,
          "--mount",
          `type=bind,src=${setup.privateDir}/platform.yaml,dst=/fixture/platform.yaml,readonly`,
          "--mount",
          `type=bind,src=${setup.privateDir}/${role}.yaml,dst=/fixture/${role}.yaml,readonly`,
        );
        if (ownershipFile)
          base.push(
            "--mount",
            `type=bind,src=${ownershipFile},dst=/fixture/database-ownership.json,readonly`,
          );
        if (setup.launchIdentity) {
          base.push(
            "--mount",
            `type=bind,src=${setup.launchContextFile},dst=/fixture/launch-context.json,readonly`,
          );
          const contextEnv =
            "COFFEE_LAUNCH_CONTEXT_FILE=/fixture/launch-context.json";
          const suppliedContextEnv = args.filter((value) =>
            value.startsWith("COFFEE_LAUNCH_CONTEXT_FILE="),
          );
          assert.ok(
            suppliedContextEnv.length <= 1 &&
              suppliedContextEnv.every((value) => value === contextEnv),
            "runtime launch context locator is exact and unique",
          );
          if (suppliedContextEnv.length === 0) base.push("--env", contextEnv);
        }
        if (scopedProduct && role === "edge-gateway")
          base.push(
            "--mount",
            `type=bind,src=${setup.privateDir}/certs/ca.crt,dst=/fixture/certs/ca.crt,readonly`,
          );
      } else
        base.push(
          "--mount",
          `type=bind,src=${setup.snapshot},dst=/app,readonly`,
          "--mount",
          `type=bind,src=${setup.privateDir},dst=/fixture,readonly`,
          "--mount",
          `type=bind,src=${dir},dst=/results`,
        );
      if (scopedLaunchDriver)
        base.push(
          "--mount",
          `type=bind,src=${setup.databaseOwnershipFile},dst=/run/coffee-launch/database-ownership.json,readonly`,
          "--mount",
          `type=bind,src=${setup.launchContextFile},dst=/run/coffee-launch/context.json,readonly`,
        );
      base.push("--workdir", "/app");
    }
    const id = (
      await run(
        "docker",
        [
          ...base,
          ...args.slice(0, args.indexOf("--IMAGE--")),
          image,
          ...args.slice(args.indexOf("--IMAGE--") + 1),
        ],
        { timeout: 30000 },
      )
    ).trim();
    owned.push({ role, name, id, cpus, memory, nofile });
    const inspect = JSON.parse(await docker("inspect", id))[0];
    if (nativeProduct) {
      assert.equal(inspect.Image, image, `${role} verified image identity`);
      assert.deepEqual(inspect.Config.Entrypoint, [
        "node",
        "scripts/permission-enforce.mjs",
      ]);
      assert.deepEqual(inspect.Config.Cmd, ["--entry", "dist/main.js"]);
    }
    if (role === "edge-nginx" && setup.manifest.qualification) {
      assert.equal(inspect.Image, image, "nginx verified image identity");
      assert.deepEqual(inspect.Config.Entrypoint, ["nginx"]);
      assert.deepEqual(inspect.Config.Cmd, ["-g", "daemon off;"]);
      assert.deepEqual(
        inspect.Mounts.map(({ Type, Source, Destination, RW }) => ({
          Type,
          Source,
          Destination,
          RW,
        })),
        [
          {
            Type: "bind",
            Source: join(setup.privateDir, "nginx-secrets"),
            Destination: "/run/secrets/edge-nginx",
            RW: false,
          },
        ],
        "native nginx uses its baked configuration and snippets",
      );
    }
    assert.equal(inspect.Config.Labels[LABEL], options.runId);
    assert.equal(inspect.HostConfig.NanoCpus, cpus * 1000000000);
    assert.equal(inspect.HostConfig.Memory, memory);
    assert.equal(
      inspect.HostConfig.Ulimits.find((l) => l.Name === "nofile").Hard,
      nofile,
    );
    if (role === "edge-nginx" && !inspect.State.Running) {
      const diagnostic = await nginxStartupDiagnostic({
        name,
        id,
        state: inspect.State,
        stage: "product-owner-start",
      });
      throw Object.assign(
        new Error(`${role} container exited during startup`),
        { containerDiagnostics: [diagnostic] },
      );
    }
    assert.equal(
      inspect.State.Running,
      true,
      `${role} container exited during startup`,
    );
    const receipt = {
      role,
      id,
      name,
      image: inspect.Image,
      resourceLimits: {
        cpus: inspect.HostConfig.NanoCpus / 1000000000,
        memoryBytes: inspect.HostConfig.Memory,
        nofile: inspect.HostConfig.Ulimits,
      },
      networks: inspect.NetworkSettings.Networks,
    };
    if (
      nativeProduct ||
      (role === "edge-nginx" && setup.manifest.qualification)
    )
      receipt.native = {
        entrypoint: inspect.Config.Entrypoint,
        command: inspect.Config.Cmd,
        mounts: inspect.Mounts.map(({ Destination, RW }) => ({
          Destination,
          RW,
        })),
      };
    if (scopedProduct || scopedOwner) {
      const expectedMounts = (
        nativeProduct
          ? [
              {
                Type: "bind",
                Source: join(setup.privateDir, "platform.yaml"),
                Destination: "/app/config/platform.yaml",
                RW: false,
              },
              {
                Type: "bind",
                Source: join(setup.privateDir, `${role}.yaml`),
                Destination: "/run/secrets/coffee-platform.yaml",
                RW: false,
              },
              {
                Type: "bind",
                Source: setup.launchContextFile,
                Destination: "/run/coffee-launch/context.json",
                RW: false,
              },
              ...(role === "edge-gateway"
                ? [
                    {
                      Type: "bind",
                      Source: join(setup.privateDir, "certs/ca.crt"),
                      Destination: "/run/g15-browser/idp-ca.crt",
                      RW: false,
                    },
                  ]
                : []),
            ]
          : [
              {
                Type: "bind",
                Source: join(setup.snapshot),
                Destination: "/app",
                RW: false,
              },
              {
                Type: "bind",
                Source: join(setup.privateDir, "platform.yaml"),
                Destination: "/fixture/platform.yaml",
                RW: false,
              },
              {
                Type: "bind",
                Source: join(setup.privateDir, `${role}.yaml`),
                Destination: `/fixture/${role}.yaml`,
                RW: false,
              },
              ...(ownershipFile
                ? [
                    {
                      Type: "bind",
                      Source: ownershipFile,
                      Destination: "/fixture/database-ownership.json",
                      RW: false,
                    },
                  ]
                : []),
              ...(setup.launchIdentity
                ? [
                    {
                      Type: "bind",
                      Source: setup.launchContextFile,
                      Destination: "/fixture/launch-context.json",
                      RW: false,
                    },
                  ]
                : []),
              ...(scopedProduct && role === "edge-gateway"
                ? [
                    {
                      Type: "bind",
                      Source: join(setup.privateDir, "certs/ca.crt"),
                      Destination: "/fixture/certs/ca.crt",
                      RW: false,
                    },
                  ]
                : []),
            ]
      ).sort((a, b) => a.Destination.localeCompare(b.Destination));
      const actualMounts = inspect.Mounts.map(
        ({ Type, Source, Destination, RW }) => ({
          Type,
          Source,
          Destination,
          RW,
        }),
      ).sort((a, b) => a.Destination.localeCompare(b.Destination));
      assert.deepEqual(
        actualMounts,
        expectedMounts,
        `${role} fixture mount scope`,
      );
      const foreignRole =
        role === "edge-gateway"
          ? "realtime-gateway"
          : role === "orders-service"
            ? "orders-aroma-preparation"
            : role === "orders-aroma-preparation"
              ? "orders-service"
              : "edge-gateway";
      const readablePaths = nativeProduct
        ? [
            "/app/config/platform.yaml",
            "/run/secrets/coffee-platform.yaml",
            "/run/coffee-launch/context.json",
            ...(role === "edge-gateway" ? ["/run/g15-browser/idp-ca.crt"] : []),
          ]
        : [
            "/fixture/platform.yaml",
            `/fixture/${role}.yaml`,
            ...(ownershipFile ? ["/fixture/database-ownership.json"] : []),
            ...(setup.launchIdentity ? ["/fixture/launch-context.json"] : []),
            ...(scopedProduct && role === "edge-gateway"
              ? ["/fixture/certs/ca.crt"]
              : []),
          ];
      const deniedPaths = [
        "/fixture/fixture.json",
        `/fixture/${foreignRole}.yaml`,
        "/fixture/certs/ca.key",
        "/results/private/fixture.json",
      ];
      const expectedConfigSha256 = setup.manifest.configSha256;
      const configPath = nativeProduct
        ? "/app/config/platform.yaml"
        : "/fixture/platform.yaml";
      const probe = `const fs=require('node:fs/promises');const crypto=require('node:crypto');const readable=${JSON.stringify(readablePaths)},denied=${JSON.stringify(deniedPaths)},expectedConfigSha256=${JSON.stringify(expectedConfigSha256)},expectedOwnershipSha256=${JSON.stringify(expectedOwnershipSha256)};(async()=>{const canRead=[];for(const p of readable)try{await fs.readFile(p);canRead.push(p)}catch{}const canReadDenied=[];for(const p of denied)try{await fs.readFile(p);canReadDenied.push(p)}catch{}const configSha256=crypto.createHash('sha256').update(await fs.readFile(${JSON.stringify(configPath)})).digest('hex');const ownershipSha256=expectedOwnershipSha256===undefined?undefined:crypto.createHash('sha256').update(await fs.readFile('/fixture/database-ownership.json')).digest('hex');if(canRead.length!==readable.length||canReadDenied.length||configSha256!==expectedConfigSha256||ownershipSha256!==expectedOwnershipSha256)throw new Error('scoped fixture mount access mismatch');console.log(JSON.stringify({readablePaths:canRead,deniedPaths:denied,configSha256,...(ownershipSha256?{ownershipSha256}:{})}))})().catch(e=>{console.error(e.message);process.exitCode=1});`;
      const scope = JSON.parse(
        await docker(
          "exec",
          "--user",
          "1000:1000",
          id,
          "node",
          "--input-type=commonjs",
          "-e",
          probe,
        ),
      );
      assert.deepEqual(scope.readablePaths, readablePaths);
      assert.deepEqual(scope.deniedPaths, deniedPaths);
      assert.equal(scope.configSha256, expectedConfigSha256);
      if (componentOwnership)
        assert.equal(scope.ownershipSha256, expectedOwnershipSha256);
      receipt.scopedMounts = {
        readOnly: true,
        readablePaths: scope.readablePaths,
        deniedPaths: scope.deniedPaths,
        configSha256: scope.configSha256,
        ...(componentOwnership
          ? { ownershipSha256: scope.ownershipSha256 }
          : {}),
      };
    }
    if (scopedLaunchDriver) {
      const expectedMounts = [
        {
          Type: "bind",
          Source: join(setup.snapshot),
          Destination: "/app",
          RW: false,
        },
        {
          Type: "bind",
          Source: join(setup.privateDir),
          Destination: "/fixture",
          RW: false,
        },
        {
          Type: "bind",
          Source: join(dir),
          Destination: "/results",
          RW: true,
        },
        {
          Type: "bind",
          Source: setup.databaseOwnershipFile,
          Destination: "/run/coffee-launch/database-ownership.json",
          RW: false,
        },
        {
          Type: "bind",
          Source: setup.launchContextFile,
          Destination: "/run/coffee-launch/context.json",
          RW: false,
        },
      ].sort((a, b) => a.Destination.localeCompare(b.Destination));
      const actualMounts = inspect.Mounts.map(
        ({ Type, Source, Destination, RW }) => ({
          Type,
          Source,
          Destination,
          RW,
        }),
      ).sort((a, b) => a.Destination.localeCompare(b.Destination));
      assert.deepEqual(actualMounts, expectedMounts, "driver fixture mounts");
      const readablePaths = [
        "/fixture/platform.yaml",
        "/run/coffee-launch/database-ownership.json",
        "/run/coffee-launch/context.json",
      ];
      const expectedConfigSha256 = setup.manifest.configSha256;
      const expectedOwnershipSha256 = setup.manifest.databaseOwnershipSha256;
      const expectedLaunchIdentity = setup.launchIdentity;
      const probe = `const fs=require('node:fs/promises');const crypto=require('node:crypto');const expectedConfigSha256=${JSON.stringify(expectedConfigSha256)},expectedOwnershipSha256=${JSON.stringify(expectedOwnershipSha256)},expectedLaunchIdentity=${JSON.stringify(expectedLaunchIdentity)};(async()=>{const configSha256=crypto.createHash('sha256').update(await fs.readFile('/fixture/platform.yaml')).digest('hex');const ownershipSha256=crypto.createHash('sha256').update(await fs.readFile('/run/coffee-launch/database-ownership.json')).digest('hex');const context=JSON.parse(await fs.readFile('/run/coffee-launch/context.json','utf8'));const launchIdentity={schemaVersion:context.schemaVersion,runId:context.runId,candidateSha:context.candidateSha,baseConfigSha256:context.baseConfigSha256};for(const key of ['schemaVersion','runId','candidateSha','baseConfigSha256'])if(launchIdentity[key]!==expectedLaunchIdentity[key])throw new Error('launch identity mismatch');if(configSha256!==expectedConfigSha256||ownershipSha256!==expectedOwnershipSha256)throw new Error('fixture digest mismatch');console.log(JSON.stringify({readablePaths:${JSON.stringify(readablePaths)},configSha256,ownershipSha256,launchIdentity}))})().catch(()=>{console.error('driver fixture mount verification failed');process.exitCode=1});`;
      const scope = JSON.parse(
        await docker(
          "exec",
          "--user",
          "1000:1000",
          id,
          "node",
          "--input-type=commonjs",
          "-e",
          probe,
        ),
      );
      assert.deepEqual(scope.readablePaths, readablePaths);
      assert.equal(scope.configSha256, expectedConfigSha256);
      assert.equal(scope.ownershipSha256, expectedOwnershipSha256);
      assert.deepEqual(
        JSON.parse(JSON.stringify(scope.launchIdentity)),
        JSON.parse(JSON.stringify(expectedLaunchIdentity)),
      );
      receipt.scopedMounts = {
        readOnly: true,
        readablePaths,
        configSha256: scope.configSha256,
        databaseOwnershipSha256: scope.ownershipSha256,
        launchIdentity: scope.launchIdentity,
      };
    }
    containerReceipts.push(receipt);
    await json(join(dir, "containers.json"), containerReceipts);
    return name;
  }

  async function inspectRole(role) {
    const c = owned.find((c) => c.role === role);
    assert.ok(c, `owned role missing ${role}`);
    const s = JSON.parse(await docker("inspect", c.id))[0];
    assert.equal(s.Config.Labels[LABEL], options.runId);
    return { c, s };
  }
  async function captureLaunchFailure(error) {
    if (!hooks.launchPath) return undefined;
    const containers = [];
    const diagnostics = Array.isArray(error.containerDiagnostics)
      ? [...error.containerDiagnostics]
      : [];
    for (const c of owned) {
      try {
        const s = JSON.parse(await docker("inspect", c.id))[0];
        assert.equal(s.Config.Labels[LABEL], options.runId);
        let cgroup;
        if (Number.isSafeInteger(s.State.Pid) && s.State.Pid > 0) {
          try {
            const sample = await readCgroupMemory(s.State.Pid);
            cgroup = {
              currentBytes: sample.currentBytes,
              maxBytes: sample.maxBytes,
              peakBytes: sample.peakBytes,
              oomEvents: sample.events.oom,
              oomKillEvents: sample.events.oom_kill,
              oomGroupKillEvents: sample.events.oom_group_kill,
            };
          } catch (failure) {
            cgroup = { unavailableCode: failure.code ?? failure.name };
          }
        }
        containers.push({
          role: c.role,
          running: Boolean(s.State.Running),
          exitCode: Number.isInteger(s.State.ExitCode)
            ? s.State.ExitCode
            : null,
          oomKilled: Boolean(s.State.OOMKilled),
          ...(cgroup ? { cgroup } : {}),
        });
        if (
          !s.State.Running &&
          Number.isInteger(s.State.ExitCode) &&
          s.State.ExitCode !== 0 &&
          !diagnostics.some((item) => item.name === c.name)
        ) {
          let startupFailure = {
            logCapture: "unavailable",
            errorNames: [],
            errorCodes: [],
            sqlStates: [],
            sourceFrames: [],
          };
          try {
            const logs = await run("docker", ["logs", "--tail", "50", c.id], {
              includeStderr: true,
              outputLimit: 65536,
              timeout: 5000,
            });
            startupFailure = {
              logCapture: "captured",
              ...safeProductStartupFailure(logs, [
                ...Object.keys(setup.manifest.sources ?? {}),
                ...Object.keys(setup.manifest.compiled ?? {}),
              ]),
            };
          } catch {
            /* retain only the safe inspect state when bounded log capture fails */
          }
          diagnostics.push({
            name: c.name,
            stage: "product-owner-start",
            state: {
              Running: false,
              ExitCode: s.State.ExitCode,
              OOMKilled: Boolean(s.State.OOMKilled),
            },
            startupFailure,
          });
        }
      } catch (failure) {
        containers.push({
          role: c.role,
          stateUnavailableCode: failure.code ?? failure.name,
        });
      }
    }
    if (diagnostics.length) error.containerDiagnostics = diagnostics;
    const command = error.launchPathCommand;
    if (!command) return undefined;
    const kernelOom = containers.some(
      (item) =>
        item.oomKilled ||
        item.cgroup?.oomKillEvents > 0 ||
        item.cgroup?.oomGroupKillEvents > 0,
    );
    const outcome = kernelOom
      ? "kernel_oom_evidence"
      : command.signal === "SIGKILL" && command.elapsedMs >= command.timeoutMs
        ? "host_docker_cli_timeout_sigkill"
        : command.signal === "SIGKILL"
          ? "docker_cli_sigkill_before_timeout_or_external"
          : command.exitCode === 127
            ? "container_exec_failure"
            : command.exitCode === 137
              ? "remote_exec_exit_137_without_cgroup_oom_evidence"
              : "command_failure";
    return { command, outcome, containers };
  }
  async function roleLogFiles(roles) {
    const logFiles = [];
    for (const role of roles) {
      const { s } = await inspectRole(role);
      assert.ok(s.State.Running, `${role} remains running for telemetry proof`);
      assert.ok(s.LogPath, `${role} exposes a Docker log path`);
      logFiles.push({ service: role, containerId: s.Id, logPath: s.LogPath });
    }
    return logFiles;
  }
  async function monitor() {
    if (monitorBusy || !driverRunning || observersStopping) return;
    monitorBusy = true;
    let observedRole, memory;
    try {
      const snapshot = { at: isoNow(), containers: [] };
      for (const role of options.fixtureCheck
        ? ["driver"]
        : ["edge-nginx", "realtime-gateway", "driver"]) {
        if (role === "realtime-gateway" && realtimeStopped) continue;
        observedRole = role;
        memory = undefined;
        const { c, s } = await inspectRole(role);
        if (!s.State.Running) {
          if (
            role === "realtime-gateway" &&
            s.State.ExitCode === 0 &&
            controlBusy
          )
            continue;
          if (role === "driver") continue;
          throw new Error(`${role} exited unexpectedly (${s.State.ExitCode})`);
        }
        memory = await readCgroupMemory(s.State.Pid);
        assert.equal(
          memory.maxBytes,
          c.memory,
          `${role} effective cgroup memory limit`,
        );
        assert.equal(
          memory.events.oom_kill,
          0,
          `${role} raw cgroup OOM kill event`,
        );
        assert.equal(
          s.State.OOMKilled,
          false,
          `${role} cgroup OOM: OOMKilled=true even if the main process remains running`,
        );
        const pids = (await docker("top", c.id, "-eo", "pid,comm"))
          .trim()
          .split("\n")
          .slice(1)
          .map((l) => l.trim().split(/\s+/u)[0]);
        let rss = 0,
          fdMax = 0;
        for (const pid of pids) {
          let status;
          try {
            status = await readFile(`/proc/${pid}/status`, "utf8");
          } catch (e) {
            if (e.code === "ENOENT") continue;
            throw e;
          }
          if (/^State:\s+[ZX]/mu.test(status)) continue;
          const m = /^VmRSS:\s+(\d+) kB$/mu.exec(status);
          rss += m ? Number(m[1]) * 1024 : 0;
          // Scope the fallback to this exact owned process, not every /proc
          // entry (reload diagnostics/exiting workers have different lifetimes).
          let count;
          try {
            count = (await readdir(`/proc/${pid}/fd`)).length;
          } catch (e) {
            if (e.code !== "EACCES") throw e;
            const namespacePid = /^NSpid:\s+([\d\s]+)$/mu
                .exec(status)?.[1]
                .trim()
                .split(/\s+/u)
                .at(-1),
              uid = /^Uid:\s+(\d+)/mu.exec(status)?.[1];
            assert.match(namespacePid ?? "", /^\d+$/u, "owned namespace PID");
            assert.match(uid ?? "", /^\d+$/u, "owned process UID");
            try {
              count = Number(
                (
                  await docker(
                    "exec",
                    "--user",
                    uid,
                    c.id,
                    "sh",
                    "-c",
                    `p=/proc/${namespacePid}/fd; [ -r "$p" ] && [ -x "$p" ] || { printf 'FD_DIRECTORY_UNREADABLE pid=${pid} namespacePid=${namespacePid} uid=${uid}\\n' >&2; exit 1; }; set -- "$p"/*; [ "$1" != "$p/*" ] || { printf 'FD_DIRECTORY_EMPTY\\n' >&2; exit 1; }; printf '%s\\n' "$#"`,
                  )
                ).trim(),
              );
            } catch (failure) {
              const after = await readFile(`/proc/${pid}/status`, "utf8").catch(
                (e) => {
                  if (e.code === "ENOENT") return "";
                  throw e;
                },
              );
              if (after === "" || /^State:\s+[ZX]/mu.test(after)) continue;
              throw failure;
            }
          }
          assert.ok(
            Number.isSafeInteger(count) && count >= 0,
            "measured FD count",
          );
          fdMax = Math.max(fdMax, count);
        }
        if (role === "driver" && (rss === 0 || fdMax === 0)) {
          const { s: after } = await inspectRole(role);
          if (!after.State.Running) {
            assert.equal(
              after.State.OOMKilled,
              false,
              "driver cgroup OOM after process sampling",
            );
            continue;
          }
        }
        assert.ok(
          rss > 0 && fdMax > 0,
          "owned live process measurements cannot be empty",
        );
        const ceiling =
          role === "edge-nginx"
            ? THRESHOLDS.nginxFd
            : role === "realtime-gateway"
              ? THRESHOLDS.realtimeFd
              : THRESHOLDS.driverFd;
        const rssCeiling =
          role === "edge-nginx"
            ? setup.manifest.thresholds.nginxRssBytes
            : role === "realtime-gateway"
              ? setup.manifest.thresholds.realtimeRssBytes
              : THRESHOLDS.driverRssBytes;
        assert.ok(
          rss <= rssCeiling,
          `${role} measured RSS ${rss}>${rssCeiling}`,
        );
        assert.ok(fdMax <= ceiling, `${role} measured FD ${fdMax}>${ceiling}`);
        const usage = await docker(
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          c.id,
        );
        snapshot.containers.push({
          role,
          rssBytes: rss,
          fdMax,
          fdCeiling: ceiling,
          rssCeiling,
          memory,
          stats: JSON.parse(usage),
        });
      }
      samples.push(snapshot);
      await writeFile(
        join(dir, "host-samples.jsonl"),
        JSON.stringify(snapshot) + "\n",
        { flag: "a" },
      );
    } catch (e) {
      hostFatal = e;
      await json(join(dir, "observer-failure.json"), {
        phase: "monitor",
        role: observedRole,
        memory,
        code: e.code ?? e.name,
        message: redact(e.message),
      });
      const driver = owned.find((c) => c.role === "driver");
      if (driver)
        await docker("kill", "--signal", "SIGTERM", driver.id).catch(() => {});
    } finally {
      monitorBusy = false;
    }
  }
  async function handleControl() {
    if (controlBusy || !driverRunning || observersStopping) return;
    let req;
    try {
      req = JSON.parse(
        await readFile(join(dir, "control-request.json"), "utf8"),
      );
      const prev = JSON.parse(
        await readFile(join(dir, "control-response.json"), "utf8").catch(
          () => "{}",
        ),
      );
      if (prev.id === req.id) return;
    } catch (e) {
      if (e.code === "ENOENT") return;
      hostFatal = e;
      await json(join(dir, "observer-failure.json"), {
        phase: "control-read",
        code: e.code ?? e.name,
        message: redact(e.message),
      });
      return;
    }
    controlBusy = true;
    const receipt = { id: req.id, action: req.action, ok: false };
    try {
      if (req.action === "reload") {
        const { c, s } = await inspectRole("edge-nginx");
        const before = (await docker("top", c.id, "-eo", "pid,args"))
          .trim()
          .split("\n")
          .filter((l) => l.includes("nginx: worker process"))
          .map((l) => Number(l.trim().split(/\s+/u)[0]));
        assert.ok(before.length > 0);
        await docker("exec", c.id, "nginx", "-t", "-q");
        const start = performance.now();
        await docker("kill", "--signal", "HUP", c.id);
        const expectedNewWorkers =
          setup.config.nginxTransport.limits.workerProcesses;
        const after = await bounded(
          async () => {
            const ps = (await docker("top", c.id, "-eo", "pid,args"))
              .trim()
              .split("\n")
              .filter((l) => l.includes("nginx: worker process"))
              .map((l) => Number(l.trim().split(/\s+/u)[0]));
            return ps.filter((p) => !before.includes(p)).length ===
              expectedNewWorkers
              ? ps
              : false;
          },
          {
            timeout: 10000,
            label: "nginx real reload complete new worker generation",
          },
        );
        receipt.beforeWorkers = before;
        receipt.afterWorkers = after;
        receipt.expectedNewWorkers = expectedNewWorkers;
        receipt.newWorkers = after.filter((p) => !before.includes(p));
        receipt.elapsedMs = performance.now() - start;
        receipt.masterHostPid = s.State.Pid;
        // Existing SSE sockets belong to old draining workers; population continuity is checked by driver.
        receipt.drainPolicy =
          "actual HUP worker generation; old SSE workers drain without forced truncation";
      } else if (req.action === "shutdown" || req.action === "restart") {
        const { c } = await inspectRole("realtime-gateway");
        const start = performance.now();
        await docker("kill", "--signal", "SIGTERM", c.id);
        const state = await bounded(
          async () => {
            const { s } = await inspectRole("realtime-gateway");
            return !s.State.Running ? s.State : false;
          },
          {
            timeout: THRESHOLDS.shutdownMs,
            label: "actual realtime graceful shutdown",
          },
        );
        assert.equal(state.ExitCode, 0, "graceful root exit code");
        assert.equal(state.OOMKilled, false);
        receipt.elapsedMs = performance.now() - start;
        receipt.state = state;
        realtimeStopped = true;
        if (req.action === "restart") {
          await docker("start", c.id);
          const { s } = await inspectRole("realtime-gateway");
          assert.equal(s.State.Running, true);
          assert.equal(s.State.OOMKilled, false);
          receipt.restartedHostPid = s.State.Pid;
          realtimeStopped = false;
        }
      } else throw new Error(`unapproved fixture control ${req.action}`);
      receipt.ok = true;
    } catch (e) {
      receipt.error = redact(e.message);
      hostFatal = e;
      await json(join(dir, "observer-failure.json"), {
        phase: "control",
        code: e.code ?? e.name,
        message: redact(e.message),
      });
    }
    await json(join(dir, "control-response.json"), receipt);
    controlBusy = false;
  }
  function scheduleObservers() {
    if (!driverRunning || observersStopping || observerRunning)
      return observerWork;
    observerRunning = true;
    observerWork = Promise.allSettled([handleControl(), monitor()])
      .then((results) => {
        for (const result of results)
          if (result.status === "rejected") hostFatal ??= result.reason;
      })
      .finally(() => {
        observerRunning = false;
      });
    return observerWork;
  }
  async function stopObservers() {
    observersStopping = true;
    driverRunning = false;
    if (timer) clearInterval(timer);
    await observerWork;
  }
  let timer;
  try {
    if (options.prepared) {
      assert.ok((await stat(dir)).isDirectory());
      setup = await verifyPrepared(dir, options.approval);
      options.runId = setup.manifest.runId;
    } else {
      await mkdir(dir, { mode: 0o700, recursive: false });
      setup = await prepare(dir, options);
    }
    const manifestSha = hash(
      await readFile(join(dir, "profile-manifest.json")),
    );
    result.manifestSha256 = manifestSha;
    if (options.prepareOnly) {
      retainedPreparation = true;
      result.status = "prepared-not-launch-proof";
      result.launchProof = false;
      result.artifacts = dir;
      await json(join(dir, "result.json"), result);
      console.log(
        JSON.stringify({
          status: result.status,
          launchProof: false,
          manifest: join(dir, "profile-manifest.json"),
          manifestSha256: manifestSha,
          run: `node tests/realtime/soak.test.mjs --prepared ${dir} --approve-manifest ${manifestSha}`,
          syntheticPrivateMaterialRetainedForApprovedRun: true,
        }),
      );
    } else {
      if (!options.fixtureCheck) {
        const main = await readFile(
          join(setup.snapshot, "apps/realtime-gateway/dist/main.js"),
          "utf8",
        );
        assert.match(
          main,
          /startConfiguredRuntime\([\s\S]*realtime-gateway[\s\S]*,/u,
          "DEPENDENCY: actual realtime main composition not wired; refusing fake /events receiver",
        );
      }
      await docker(
        "network",
        "create",
        "--label",
        `${LABEL}=${options.runId}`,
        network,
      );
      networkCreated = true;
      if (hooks.launchPath?.onNetwork)
        await hooks.launchPath.onNetwork({ networkName: network });
      const registerOwner = (resource) => {
        assert.equal(ownerResource, undefined);
        assert.equal(typeof resource.stop, "function");
        ownerResource = resource;
      };
      if (hooks.launchPath)
        ownerResource = await hooks.launchPath.startOwner({
          setup,
          network,
          dir,
          registerOwner,
        });
      if (hooks.startOwner)
        ownerResource = await hooks.startOwner({
          setup,
          network,
          dir,
          registerOwner: (resource) => {
            assert.equal(ownerResource, undefined);
            assert.equal(typeof resource.stop, "function");
            ownerResource = resource;
          },
        });
      const brokerEnv = Object.entries({
        KAFKA_NODE_ID: "1",
        KAFKA_PROCESS_ROLES: "broker,controller",
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
          "CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL",
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
        KAFKA_OPTS:
          "-Djava.security.auth.login.config=/etc/kafka/secrets/kafka_jaas.conf",
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
        KAFKA_AUTO_CREATE_TOPICS_ENABLE: "false",
        KAFKA_NUM_PARTITIONS: "3",
        KAFKA_LOG_DIRS: "/var/lib/kafka/data",
        KAFKA_HEAP_OPTS: "-Xms256m -Xmx768m",
      }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
      const broker = await launch(
        "kafka",
        setup.images.kafka,
        [
          "--user",
          "1000:1000",
          "--mount",
          `type=bind,src=${setup.privateDir}/kafka,dst=/etc/kafka/secrets,readonly`,
          "--tmpfs",
          "/var/lib/kafka/data:rw,uid=1000,gid=1000,mode=0700,size=1073741824",
          ...brokerEnv,
          "--IMAGE--",
        ],
        {
          cpus: 2,
          memory: 2147483648,
          nofile: 8192,
          aliases: ["kafka"],
          fixtures: false,
        },
      );
      await bounded(
        async () => {
          await docker(
            "exec",
            broker,
            "/opt/kafka/bin/kafka-topics.sh",
            "--bootstrap-server",
            "kafka:9092",
            "--command-config",
            "/etc/kafka/secrets/client.properties",
            "--list",
          );
          return true;
        },
        { timeout: 90000, interval: 500, label: "real SASL_SSL Kafka broker" },
      );
      const realtimeTopic = setup.config.kafka.topics.realtimeInvalidate;
      const realtimeTarget = assertFixtureKafkaNamespaceBound(
        setup.config,
        "realtime-gateway",
        setup.launchIdentity,
      );
      const topics = new Map([
        [realtimeTarget.topics[realtimeTopic.name], realtimeTopic.partitions],
      ]);
      if (ownerResource?.startServices)
        for (const service of [
          "orders-service",
          "orders-aroma-preparation",
          "realtime-gateway",
          "aroma-convergence",
        ])
          for (const name of [
            ...setup.config.services[service].kafka.producers,
            ...setup.config.services[service].kafka.consumers.flatMap(
              (consumer) => consumer.topics,
            ),
          ]) {
            const topic = Object.values(setup.config.kafka.topics).find(
              (item) => item.name === name,
            );
            assert.ok(topic, `configured Kafka topic is defined: ${name}`);
            const runtimeTarget = assertFixtureKafkaNamespaceBound(
              setup.config,
              service,
              setup.launchIdentity,
            );
            topics.set(runtimeTarget.topics[name], topic.partitions);
          }
      for (const [topic, partitions] of topics)
        await docker(
          "exec",
          broker,
          "/opt/kafka/bin/kafka-topics.sh",
          "--bootstrap-server",
          "kafka:9092",
          "--command-config",
          "/etc/kafka/secrets/client.properties",
          "--create",
          "--topic",
          topic,
          "--partitions",
          String(partitions),
          "--replication-factor",
          "1",
        );
      if (ownerResource?.startServices) {
        await bootstrapOwnedOrdersKafka({
          broker,
          runId: options.runId,
          config: setup.config,
          launchIdentity: setup.launchIdentity,
          ...(hooks.launchPath
            ? {
                owners: [
                  "orders-service",
                  "orders-aroma-preparation",
                  "aroma-convergence",
                ],
              }
            : {}),
          inspectBroker: async (name) =>
            JSON.parse(await docker("inspect", name))[0],
          runKafka: async (name, args) => docker("exec", name, ...args),
          writeReceipt: (receipt) =>
            json(join(dir, "orders-kafka-offset-bootstrap.json"), receipt),
        });
        await ownerResource.startServices({
          setup,
          network,
          dir,
          broker,
          launch,
        });
      }

      await launch(
        "idp",
        setup.images.node,
        ["--IMAGE--", "node", "tests/realtime/fixtures/services.mjs", "idp"],
        { aliases: ["idp.fixture.invalid"] },
      );
      if (!options.fixtureCheck) {
        if (!ownerResource)
          await launch(
            "orders-fixture",
            setup.images.node,
            [
              "--IMAGE--",
              "node",
              "tests/realtime/fixtures/services.mjs",
              "orders",
            ],
            { aliases: ["orders-service"] },
          );
        await launch(
          "edge-gateway",
          setup.manifest.qualification
            ? setup.images["edge-gateway"]
            : setup.images.node,
          productArgs(
            "edge-gateway",
            Boolean(setup.launchIdentity),
            setup.manifest.qualification
              ? { port: setup.config.services["edge-gateway"].listen.port }
              : undefined,
          ),
          { aliases: ["edge-gateway"] },
        );
        await launch(
          "api-public",
          setup.manifest.qualification
            ? setup.images["api-public"]
            : setup.images.node,
          [
            ...(ownerResource?.host
              ? ["--add-host", `orders-service:${ownerResource.host}`]
              : []),
            ...productArgs(
              "api-public",
              Boolean(setup.launchIdentity),
              setup.manifest.qualification
                ? { port: setup.config.services["api-public"].listen.port }
                : undefined,
            ),
          ],
          { aliases: ["api-public"] },
        );
        await launch(
          "realtime-gateway",
          setup.manifest.qualification
            ? setup.images["realtime-gateway"]
            : setup.images.node,
          productArgs(
            "realtime-gateway",
            Boolean(setup.launchIdentity),
            setup.manifest.qualification
              ? { port: setup.config.services["realtime-gateway"].listen.port }
              : undefined,
          ),
          {
            memory: setup.manifest.containerBudgets["realtime-gateway"].memory,
            nofile: 12288,
            aliases: ["realtime-gateway"],
          },
        );
        await launch(
          "edge-nginx",
          ownerResource?.nginxImage ?? setup.images.nginx,
          [
            ...(hooks.exercise || hooks.launchPath
              ? ["--publish", "127.0.0.1:8443:8443"]
              : []),
            "--user",
            "101:101",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,size=67108864,uid=101,gid=101",
            ...(setup.manifest.qualification
              ? []
              : [
                  "--mount",
                  `type=bind,src=${setup.privateDir}/nginx.conf,dst=/etc/nginx/nginx.conf,readonly`,
                ]),
            "--mount",
            `type=bind,src=${setup.privateDir}/nginx-secrets,dst=/run/secrets/edge-nginx,readonly`,
            ...(setup.manifest.qualification
              ? []
              : [
                  "--mount",
                  `type=bind,src=${ROOT}/apps/edge-nginx/snippets,dst=/etc/nginx/snippets,readonly`,
                ]),
            "--IMAGE--",
            ...(setup.manifest.qualification
              ? []
              : [
                  ...(ownerResource?.nginxImage ? [] : ["nginx"]),
                  "-e",
                  "stderr",
                  "-g",
                  "daemon off; error_log stderr warn;",
                ]),
          ],
          {
            memory: setup.manifest.containerBudgets["edge-nginx"].memory,
            nofile: 16384,
            aliases: ["edge-nginx"],
            fixtures: false,
          },
        );
      }
      if (!options.fixtureCheck) {
        const { c } = await inspectRole("edge-nginx");
        const workerPids = await bounded(
          async () => {
            const pids = (await docker("top", c.id, "-eo", "pid,args"))
              .trim()
              .split("\n")
              .filter((l) => l.includes("nginx: worker process"))
              .map((l) => Number(l.trim().split(/\s+/u)[0]));
            return pids.length ===
              setup.config.nginxTransport.limits.workerProcesses
              ? pids
              : false;
          },
          {
            timeout: 10000,
            label: "configured native nginx worker population",
          },
        );
        await json(join(dir, "nginx-workers.json"), {
          configuredWorkers: setup.config.nginxTransport.limits.workerProcesses,
          workerPids,
          containerId: c.id,
          cpus: c.cpus,
        });
      }
      if (options.fixtureCheck) {
        const brokerProof = await verifyBrokerFixture(
          broker,
          dir,
          setup.config,
          setup.launchIdentity,
        );
        result.published = brokerProof.sent;
      }
      await launch(
        "driver",
        setup.images.node,
        [
          ...(ownerResource?.driverArgs ?? []),
          "--IMAGE--",
          "node",
          ...(hooks.exercise || hooks.launchPath
            ? ["--input-type=module", "-e", "setInterval(()=>{},1000)"]
            : [
                options.fixtureCheck
                  ? "tests/realtime/fixtures/fixture-check.mjs"
                  : "tests/realtime/fixtures/driver.mjs",
              ]),
        ],
        { cpus: 8, memory: 2147483648, nofile: 32768 },
      );
      driverRunning = true;
      timer = setInterval(() => {
        void scheduleObservers();
      }, 500);
      timer.unref();
      const start = performance.now();
      if (hooks.exercise || hooks.launchPath) {
        if (hooks.launchPath?.onRolesReady)
          await hooks.launchPath.onRolesReady({
            networkName: network,
            logFiles: await roleLogFiles([
              "orders-service",
              "orders-aroma-preparation",
              "api-internal",
              "api-public",
              "realtime-gateway",
              "edge-gateway",
              "edge-nginx",
            ]),
          });
        const exercise = hooks.launchPath
          ? hooks.launchPath.exercise
          : hooks.exercise;
        const proof = await exercise({
          setup,
          network,
          dir,
          broker,
          driver: owned.find((c) => c.role === "driver").name,
        });
        if (hooks.launchPath) {
          result.launchPath = proof;
          assert.equal(
            result.launchPath.verified,
            true,
            "actual launch-path assertions must complete",
          );
        } else {
          result.ownerBrowser = proof;
          assert.equal(
            result.ownerBrowser.verified,
            true,
            "actual owner/browser assertions must complete",
          );
        }
        await stopObservers();
        if (hostFatal) throw hostFatal;
        result.totalElapsedMs = performance.now() - start;
      } else {
        await bounded(
          async () => {
            const { s } = await inspectRole("driver");
            return !s.State.Running ? s.State : false;
          },
          {
            timeout:
              (options.mode === "full"
                ? FULL.durationMs
                : options.smoke.durationMs) + 240000,
            interval: 500,
            label: "bounded isolated transport harness",
          },
        ).then((s) => {
          driverExit = s.ExitCode;
          assert.equal(s.OOMKilled, false);
        });
        await stopObservers();
        if (hostFatal) throw hostFatal;
        const measured = JSON.parse(
          await readFile(join(dir, "driver-result.json"), "utf8"),
        );
        Object.assign(result, measured);
        result.totalElapsedMs = performance.now() - start;
        result.driverExit = driverExit;
        result.checks.budgets = samples.length > 0 && !hostFatal;
        result.checkDetails ??= {};
        result.checkDetails.containerSamples = samples.length;
        if (options.fixtureCheck && !result.error)
          assert.equal(
            result.published,
            10,
            "nonempty live fixture verification",
          );
        if (driverExit !== 0 && !result.error)
          throw new Error(`real driver exited ${driverExit}`);
      }
    }
  } catch (e) {
    const launchFailure = await captureLaunchFailure(e);
    result.error = {
      code: e.code ?? "HARNESS_FAILED",
      message: redact(e.message),
    };
    if (Array.isArray(e.containerDiagnostics))
      result.containerDiagnostics = e.containerDiagnostics;
    if (e.launchFailure) result.launchFailure = e.launchFailure;
    else if (launchFailure) result.launchFailure = launchFailure;
    result.status = "FAIL";
    result.launchProof = false;
  } finally {
    await stopObservers();
    const cleanupStart = performance.now(),
      receipts = [];
    let networkRemoved = !networkCreated,
      syntheticPrivateMaterialRemoved = false;
    const ownerCleanup = {
      created: Boolean(ownerResource),
      removed: !ownerResource,
    };
    for (const c of [...owned].reverse()) {
      try {
        const { s } = await inspectRole(c.role);
        assert.equal(s.Config.Labels[LABEL], options.runId);
        let logsCaptured = false;
        try {
          const logs = await run("docker", ["logs", c.id], {
            timeout: 15000,
            outputLimit: 128 * 1024 * 1024,
            includeStderr: true,
          });
          await writeFile(join(dir, `${c.role}.log`), redact(logs));
          logsCaptured = true;
        } catch (e) {
          const error = redact(e.message);
          await json(join(dir, `${c.role}.log-failure.json`), {
            code: "FIXTURE_LOG_CAPTURE_FAILED",
            error,
          });
          result.error ??= {
            code: "FIXTURE_LOG_CAPTURE_FAILED",
            message: error,
          };
        }
        await run("docker", ["rm", "--force", "--volumes", c.id], {
          timeout: 15000,
        });
        const surviving = await docker(
          "ps",
          "--all",
          "--filter",
          `id=${c.id}`,
          "--format",
          "{{.ID}}",
        );
        assert.equal(surviving.trim(), "");
        receipts.push({ role: c.role, id: c.id, removed: true, logsCaptured });
      } catch (e) {
        receipts.push({
          role: c.role,
          id: c.id,
          removed: false,
          error: redact(e.message),
        });
        result.error ??= { code: "FIXTURE_CLEANUP_FAILED", message: e.message };
      }
    }
    if (ownerResource) {
      try {
        await ownerResource.stop();
        ownerCleanup.removed = true;
      } catch (e) {
        ownerCleanup.error = redact(e.message);
        ownerCleanup.failures = (
          e instanceof AggregateError ? e.errors : [e]
        ).map((error) => redact(error.message));
        result.error ??= {
          code: "OWNER_FIXTURE_CLEANUP_FAILED",
          message: ownerCleanup.error,
        };
      }
    }
    if (networkCreated) {
      try {
        const data = JSON.parse(await docker("network", "inspect", network))[0];
        assert.equal(data.Labels[LABEL], options.runId);
        await docker("network", "rm", network);
        const remaining = await docker(
          "network",
          "ls",
          "--filter",
          `name=^${network}$`,
          "--format",
          "{{.Name}}",
        );
        assert.equal(remaining.trim(), "");
        networkRemoved = true;
      } catch (e) {
        result.error ??= { code: "NETWORK_CLEANUP_FAILED", message: e.message };
      }
    }
    if (!retainedPreparation) {
      try {
        await erasePrivate(dir, {
          consumersStopped:
            receipts.every((receipt) => receipt.removed) &&
            ownerCleanup.removed &&
            networkRemoved,
        });
        syntheticPrivateMaterialRemoved = true;
      } catch (e) {
        result.error ??= {
          code: "SYNTHETIC_MATERIAL_CLEANUP_FAILED",
          message: e.message,
        };
      }
    }
    result.cleanupVerified =
      receipts.every((r) => r.removed) &&
      ownerCleanup.removed &&
      networkRemoved &&
      (retainedPreparation || syntheticPrivateMaterialRemoved);
    result.artifacts = dir;
    try {
      await json(join(dir, "cleanup.json"), {
        durationMs: performance.now() - cleanupStart,
        receipts,
        owner: ownerCleanup,
        network: {
          name: network,
          created: networkCreated,
          removed: networkRemoved,
        },
        syntheticPrivateMaterialRemoved,
        verified: result.cleanupVerified,
      });
      if (retainedPreparation) {
        result.status = "prepared-not-launch-proof";
        result.launchProof = false;
      } else if (options.fixtureCheck && !result.error) {
        result.status = "fixture-transport-only-not-launch-proof";
        result.launchProof = false;
      } else if (hooks.exercise || hooks.launchPath) {
        result.status =
          result.error || !result.cleanupVerified
            ? "FAIL"
            : hooks.launchPath
              ? "owner-launch-path-proof-only"
              : "owner-browser-proof-only";
        result.launchProof = false;
      } else Object.assign(result, classifyResult(result));
      result.classification = hooks.launchPath
        ? "owner-launch-path-not-capacity-proof"
        : hooks.exercise
          ? "owner-browser-not-capacity-proof"
          : options.mode === "smoke"
            ? "smoke-not-launch-proof"
            : retainedPreparation
              ? "prepared-not-launch-proof"
              : "full-profile";
      await json(join(dir, "result.json"), result);
      console.log(
        JSON.stringify({
          status: result.status,
          classification: result.classification,
          launchProof: result.launchProof,
          artifact: join(dir, "result.json"),
          manifest: join(dir, "profile-manifest.json"),
          error: result.error,
        }),
      );
    } catch (e) {
      console.error(`artifact write failed: ${e.message}`);
      result.error ??= { code: "ARTIFACT_WRITE_FAILED", message: e.message };
    }
  }
  return result;
}

void test("driver failure keeps a bounded native diagnostic instead of only a code", () => {
  const diagnostic =
    'NATIVE_OPERATION_FAILED operation=produce phase=request nativeCode=-999 nativeMessage="broker unavailable"';
  const failure = driverFailure(
    Object.assign(new Error(diagnostic), {
      code: "NATIVE_OPERATION_FAILED",
      diagnostic,
    }),
  );
  assert.deepEqual(failure, {
    code: "NATIVE_OPERATION_FAILED",
    message: diagnostic,
    diagnostic,
  });
  assert.equal(
    driverFailure({ code: 7, message: "", diagnostic: "" }).code,
    "TRANSPORT_PROOF_FAILED",
  );
  const bounded = driverFailure({
    code: "NATIVE_OPERATION_FAILED",
    message: "bounded",
    diagnostic: "d".repeat(4096),
  });
  assert.equal(bounded.diagnostic.length, 1024);
  assert.equal(bounded.message, "bounded");
});

if (
  process.env.NODE_TEST_CONTEXT === undefined &&
  resolve(process.argv[1] ?? "") === import.meta.filename
) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help)
      console.log(
        "Полный operator-1: 1 subscriber /100 ACKed invalidations per sec /100 subjects /1800000ms; отдельная admission prephase512/513.\n--smoke [--profile reference-512] [--smoke-clients N] [--smoke-duration-ms N] --result-dir SCRATCH (не full proof)\n--fixture-check --result-dir SCRATCH (только TLS/IdP и SASL_SSL broker fixture, не product proof)\n--prepare --profile operator-1 --result-dir SCRATCH\n--prepared SCRATCH --approve-manifest SHA256 (точный frozen manifest; штатные expiry/re-auth/replay/reset обязательны)",
      );
    else {
      const result = await runTransportFixture(options);
      process.exitCode = result.error || result.status === "FAIL" ? 1 : 0;
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
