import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  stat,
  lstat,
  realpath,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { load as yaml } from "js-yaml";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import {
  ROOT,
  sourceSnapshot,
  run,
  json,
  redact,
  PRODUCT_BUILD_TARGETS,
  productArgs,
  assertFixtureKafkaNamespaceBound,
  LABEL,
  safeProductStartupFailure,
} from "./setup.mjs";
import {
  nowMs,
  SseDecoder,
  classifyResult,
  ulid,
  ulidTime,
  Histogram,
  assertCoverage,
  THRESHOLDS,
  FULL,
} from "./protocol.mjs";
import { render } from "../../../tools/nginx/generate.mjs";
import { bootstrapOwnedOrdersKafka } from "../soak.test.mjs";
import { validateLaunchDatabaseIdentity } from "../../../packages/platform-config/dist/index.js";

async function nginxStatusEndpoint() {
  return yaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
    { json: true },
  ).telemetry.nginxStatusEndpoint;
}

void test("operator-1 CLI help describes the approved profile without obsolete full5000", async () => {
  const help = await run(
    process.execPath,
    ["tests/realtime/soak.test.mjs", "--help"],
    { cwd: ROOT },
  );
  assert.match(help, /--prepare --profile operator-1/u);
  assert.match(help, /1 subscriber.*100.*1800000ms/u);
  assert.doesNotMatch(help, /5000|isolated-5000/u);
  assert.match(help, /512\/513/u);
});

void test("capacity producer rejects invalid launch context before creating resources", async () => {
  const { runRealtimeCapacity } =
    await import("../../../tools/realtime-capacity.mjs");
  const { scratchRoot } = await import("../soak.test.mjs");
  const previousScratch = process.env.COFFEE_LAUNCH_SCRATCH;
  process.env.COFFEE_LAUNCH_SCRATCH ??= await mkdtemp(
    join(tmpdir(), "realtime-invalid-scratch-"),
  );
  try {
    const resultDir = join(scratchRoot(), `realtime-invalid-${process.pid}`);
    await assert.rejects(
      runRealtimeCapacity({
        launchContextFile: "/missing/context.json",
        resultDir,
      }),
    );
    await assert.rejects(stat(resultDir), { code: "ENOENT" });
    await assert.rejects(stat(`${resultDir}.ownership.json`), {
      code: "ENOENT",
    });
  } finally {
    if (previousScratch === undefined) delete process.env.COFFEE_LAUNCH_SCRATCH;
    else process.env.COFFEE_LAUNCH_SCRATCH = previousScratch;
  }
});

void test("observability refuses to launch when qualification is missing", async () => {
  const { parseArgs, runGate } =
    await import("../../../verification/launch/v1/run.mjs");
  assert.equal(
    parseArgs(["--realtime-qualification", "/absolute/qualification.json"])
      .realtimeQualificationPath,
    "/absolute/qualification.json",
  );
  assert.throws(() => parseArgs(["--realtime-qualification", "relative.json"]));
  assert.throws(() =>
    parseArgs([
      "--realtime-qualification",
      "/one",
      "--realtime-qualification",
      "/two",
    ]),
  );
  const parent = join(ROOT, "evidence/launch");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const evidence = await mkdtemp(join(parent, "capacity-runner-"));
  try {
    const gate = {
      id: "observability",
      command: "pnpm test:observability",
      timeout: 1800,
      predecessors: [],
    };
    await mkdir(join(evidence, "gates", gate.id, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
    const record = {
      id: gate.id,
      status: "NOT_RUN",
      runs: [],
      artifacts: [],
      durationMs: 0,
    };
    await runGate(
      gate,
      record,
      evidence,
      ROOT,
      "/missing",
      [],
      Date.now(),
      { exceeded: false },
      undefined,
      undefined,
    );
    assert.equal(record.status, "FAIL");
    assert.match(record.reason, /qualification receipt is required/u);
    assert.deepEqual(record.runs, []);
  } finally {
    await rm(evidence, { recursive: true, force: true });
  }
});

void test("qualification claims use one user authority across concurrent packet copies", async () => {
  const source = await readFile(
    new URL("../../../tools/realtime-capacity.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function claimQualification(");
  const end = source.indexOf(
    "\n\nexport async function admitRealtimeCapacity",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const home = await mkdtemp(join(tmpdir(), "coffee-capacity-claims-"));
  try {
    const claim = runInNewContext(
      `(()=>{${source.slice(start, end)};return claimQualification;})()`,
      {
        assert,
        resolve,
        join,
        mkdir,
        lstat,
        realpath,
        writeFile,
        process,
        userInfo: () => ({ homedir: home }),
      },
    );
    const outcomes = await Promise.allSettled([
      claim("i12-0123456789abcdef", "a".repeat(64)),
      claim("i12-0123456789abcdef", "a".repeat(64)),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    assert.equal(rejected.reason.code, "EEXIST");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test("prepared qualification rejects an unbound image inventory before Docker", async () => {
  const { verifyPrepared } = await import("./setup.mjs");
  const dir = await mkdtemp(join(tmpdir(), "coffee-realtime-unbound-"));
  try {
    await mkdir(join(dir, "private"));
    const profile = "{}\n";
    const fixture = "{}\n";
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const manifest = JSON.stringify({
      mode: "full",
      profile: "operator-1",
      profileSha256: digest(profile),
      fixtureSha256: digest(fixture),
      qualification: { runtimeImages: [] },
    });
    await writeFile(join(dir, "profile.json"), profile);
    await writeFile(join(dir, "private/fixture.json"), fixture);
    await writeFile(join(dir, "profile-manifest.json"), manifest);
    await assert.rejects(
      verifyPrepared(dir, digest(manifest)),
      /verified child lineage/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("product startup diagnostics keep only allowlisted error codes and real source frames", () => {
  const source = "apps/orders-aroma-preparation/src/runtime-composition.ts";
  const logs = [
    JSON.stringify({
      level: 50,
      err: {
        type: "TypeError",
        code: "23505",
        sqlState: "08006",
        message: "startup-canary-secret ERR_CANARY_TOKEN",
        stack: `TypeError: startup-canary-secret\n    at configure (/app/${source}:21:13)\n    at leaked (/app/apps/orders-aroma-preparation/src/private-canary-token.ts:4:9)`,
      },
    }),
    `Error: AROMA_PREPARATION_CONFIG_MISSING startup-canary-secret SQLSTATE: 08006\n    at start (/app/${source}:56:17)`,
  ].join("\n");
  const result = safeProductStartupFailure(logs, [source]);
  assert.deepEqual(result, {
    errorNames: ["TypeError", "Error"],
    errorCodes: ["AROMA_PREPARATION_CONFIG_MISSING"],
    sqlStates: ["23505", "08006"],
    sourceFrames: [
      { path: source, line: 21, column: 13 },
      { path: source, line: 56, column: 17 },
    ],
  });
  assert.ok(
    result.errorNames.length <= 4 &&
      result.errorCodes.length <= 8 &&
      result.sqlStates.length <= 4 &&
      result.sourceFrames.length <= 8,
    "startup error projection is bounded",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /startup-canary-secret|private-canary-token|ERR_CANARY_TOKEN|\/app\//u,
  );
});

void test("launch-path initializes offsets only for durable Orders owners on an owned empty tmpfs broker", async () => {
  const config = yaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  config.verification.kafkaNamespaceIsolation = false;
  const expected = [];
  for (const serviceName of ["orders-service", "orders-aroma-preparation"])
    for (const consumer of config.services[serviceName].kafka.consumers.filter(
      (value) => value.processing === "durable",
    ))
      for (const topic of consumer.topics)
        expected.push({ groupId: consumer.groupId, topic });
  const state = {
    Id: "sha256:synthetic-broker",
    Image: "sha256:synthetic-image",
    State: { Running: true },
    Config: { Labels: { [LABEL]: "owned-run" } },
    HostConfig: { Tmpfs: { "/var/lib/kafka/data": "rw,size=1073741824" } },
    Mounts: [{ Type: "tmpfs", Destination: "/var/lib/kafka/data" }],
  };
  const reset = [];
  let cliCalls = 0,
    receipt;
  let activeConfig = config;
  let activeLaunchIdentity;
  const definitionForTopic = (physicalName) =>
    Object.values(activeConfig.kafka.topics).find((definition) =>
      Object.keys(activeConfig.services).some((runtime) => {
        const target = assertFixtureKafkaNamespaceBound(
          activeConfig,
          runtime,
          activeLaunchIdentity,
        );
        return target.topics[definition.name] === physicalName;
      }),
    );
  const runKafka = async (_broker, args) => {
    cliCalls++;
    if (args[0] === "sh") return "mounted\n";
    if (args[0].endsWith("kafka-get-offsets.sh")) {
      const topic = args[args.indexOf("--topic") + 1],
        definition = definitionForTopic(topic);
      assert.ok(definition, `configured topic: ${topic}`);
      return Array.from(
        { length: definition.partitions },
        (_, partition) => `${topic}:${partition}:0`,
      ).join("\n");
    }
    const groupId = args[args.indexOf("--group") + 1];
    if (args.includes("--reset-offsets")) {
      reset.push({ groupId, topic: args[args.indexOf("--topic") + 1] });
      return "";
    }
    const initialized = reset.filter((item) => item.groupId === groupId);
    return initialized
      .flatMap((item) => {
        const definition = definitionForTopic(item.topic);
        assert.ok(definition, `configured topic: ${item.topic}`);
        return Array.from(
          { length: definition.partitions },
          (_, partition) => `${groupId} ${item.topic} ${partition} 0 0 0 - -`,
        );
      })
      .join("\n");
  };
  const result = await bootstrapOwnedOrdersKafka({
    broker: "owned-kafka",
    runId: "owned-run",
    config,
    inspectBroker: async () => state,
    runKafka,
    writeReceipt: async (value) => {
      receipt = value;
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.broker.freshTmpfsData, true);
  assert.deepEqual(
    reset,
    expected.map(({ groupId, topic }) => ({ groupId, topic })),
  );
  assert.ok(
    result.topics.every((topic) =>
      topic.partitions.every((partition) => partition.endOffset === "0"),
    ),
  );
  assert.ok(
    result.groups.every((group) =>
      group.partitions.every(
        (partition) =>
          partition.currentOffset === "0" &&
          partition.endOffset === "0" &&
          partition.lag === "0",
      ),
    ),
  );
  assert.deepEqual(receipt, result);
  assert.ok(cliCalls > 0);
  reset.length = 0;
  const launchPath = await bootstrapOwnedOrdersKafka({
    broker: "owned-kafka",
    runId: "owned-run",
    config,
    owners: ["orders-service", "orders-aroma-preparation", "aroma-convergence"],
    inspectBroker: async () => state,
    runKafka,
    writeReceipt: async () => {},
  });
  const convergence = config.services["aroma-convergence"].kafka.consumers.find(
    (value) => value.groupId === "aroma-convergence-v1",
  );
  assert.ok(convergence);
  assert.deepEqual(
    reset
      .filter((item) => item.groupId === "aroma-convergence-v1")
      .map((item) => item.topic),
    convergence.topics,
  );
  assert.ok(
    launchPath.groups.some(
      (group) =>
        group.groupId === "aroma-convergence-v1" &&
        group.topic === convergence.topics[0] &&
        group.partitions.every((partition) => partition.currentOffset === "0"),
    ),
  );
  const namespaceConfig = structuredClone(config);
  namespaceConfig.verification.kafkaNamespaceIsolation = true;
  const namespaceBefore = structuredClone(namespaceConfig);
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261026T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
    baseConfigSha256: "b".repeat(64),
  };
  activeConfig = namespaceConfig;
  activeLaunchIdentity = launchIdentity;
  const namespaceReset = [];
  const namespaceResult = await bootstrapOwnedOrdersKafka({
    broker: "owned-kafka",
    runId: "owned-run",
    config: namespaceConfig,
    launchIdentity,
    inspectBroker: async () => state,
    runKafka: async (_broker, args) => {
      const output = await runKafka(_broker, args);
      if (args.includes("--reset-offsets"))
        namespaceReset.push({
          groupId: args[args.indexOf("--group") + 1],
          topic: args[args.indexOf("--topic") + 1],
        });
      return output;
    },
    writeReceipt: async () => {},
  });
  assert.ok(namespaceReset.length > 0);
  assert.ok(
    namespaceReset.every(
      ({ groupId, topic }) =>
        groupId.startsWith(`${launchIdentity.runId}.`) &&
        topic.startsWith(`${launchIdentity.runId}.`),
    ),
    "broker commands use run-scoped physical topic and group names",
  );
  assert.ok(
    namespaceResult.groups.every(
      ({ groupId, topic }) =>
        groupId.startsWith(`${launchIdentity.runId}.`) &&
        topic.startsWith(`${launchIdentity.runId}.`),
    ),
  );
  assert.deepEqual(namespaceConfig, namespaceBefore);
  let namespaceBrokerInspections = 0;
  await assert.rejects(
    bootstrapOwnedOrdersKafka({
      broker: "unbound-kafka",
      runId: "owned-run",
      config: namespaceConfig,
      inspectBroker: async () => {
        namespaceBrokerInspections++;
        return state;
      },
      runKafka,
      writeReceipt: async () => {},
    }),
    /readonly launch identity/u,
  );
  assert.equal(
    namespaceBrokerInspections,
    0,
    "enabled namespace mode fails before contacting an unbound broker",
  );
  const callsBeforeGuard = cliCalls;
  await assert.rejects(
    bootstrapOwnedOrdersKafka({
      broker: "other-kafka",
      runId: "owned-run",
      config,
      inspectBroker: async () => ({
        ...state,
        Config: { Labels: { [LABEL]: "foreign-run" } },
      }),
      runKafka,
      writeReceipt: async () => {},
    }),
    /limited to this fixture broker/u,
  );
  await assert.rejects(
    bootstrapOwnedOrdersKafka({
      broker: "reused-kafka",
      runId: "owned-run",
      config,
      inspectBroker: async () => ({ ...state, HostConfig: { Tmpfs: {} } }),
      runKafka,
      writeReceipt: async () => {},
    }),
    /newly launched tmpfs broker/u,
  );
  assert.equal(
    cliCalls,
    callsBeforeGuard,
    "ownership guards reject foreign or reused brokers before Kafka commands",
  );
  let mountCommands = 0;
  await assert.rejects(
    bootstrapOwnedOrdersKafka({
      broker: "unmounted-kafka",
      runId: "owned-run",
      config,
      inspectBroker: async () => state,
      runKafka: async (_broker, args) => {
        mountCommands++;
        return args[0] === "sh" ? "not-mounted\n" : runKafka(_broker, args);
      },
      writeReceipt: async () => {},
    }),
    /active tmpfs mount/u,
  );
  assert.equal(
    mountCommands,
    1,
    "a broker without an active tmpfs mount is rejected before topic or group changes",
  );
});

void test("fixture Kafka namespace maps runtime claims without changing logical config", async () => {
  const config = yaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
  );
  config.verification.kafkaNamespaceIsolation = true;
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261026T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
    baseConfigSha256: "b".repeat(64),
  };
  const before = structuredClone(config);
  assert.throws(
    () => assertFixtureKafkaNamespaceBound(config, "orders-service"),
    /launch identity/u,
  );
  const target = assertFixtureKafkaNamespaceBound(
    config,
    "orders-service",
    launchIdentity,
  );
  const logicalTopics = config.services["orders-service"].kafka.producers;
  const logicalGroups = config.services["orders-service"].kafka.consumers.map(
    ({ groupId }) => groupId,
  );
  const preparationTarget = assertFixtureKafkaNamespaceBound(
    config,
    "orders-aroma-preparation",
    launchIdentity,
  );
  const preparationTopics = config.services[
    "orders-aroma-preparation"
  ].kafka.consumers.flatMap(({ topics }) => topics);
  assert.deepEqual(
    [...preparationTopics].sort((left, right) => left.localeCompare(right)),
    [
      config.kafka.topics.catalogMapping.name,
      config.kafka.topics.ordersLifecycle.name,
      config.kafka.topics.aromaEvents.name,
    ].sort((left, right) => left.localeCompare(right)),
  );
  for (const logicalTopic of preparationTopics)
    assert.equal(
      preparationTarget.topics[logicalTopic],
      `${launchIdentity.runId}.${logicalTopic}`,
      "preparation claims map through the active child identity",
    );
  assert.ok(
    logicalTopics.every((name) =>
      target.topics[name]?.startsWith(`${launchIdentity.runId}.`),
    ),
  );
  assert.ok(
    logicalGroups.every((name) =>
      target.groups[name]?.startsWith(`${launchIdentity.runId}.`),
    ),
  );
  assert.deepEqual(config, before, "logical config remains unchanged");
  const realtimeConsumers = config.services["realtime-gateway"].kafka.consumers;
  assert.equal(realtimeConsumers.length, 1);
  const realtimeTarget = assertFixtureKafkaNamespaceBound(
    config,
    "realtime-gateway",
    launchIdentity,
  );
  assert.equal(
    realtimeTarget.groups[realtimeConsumers[0].groupId],
    `${launchIdentity.runId}.${realtimeConsumers[0].groupId}`,
    "the realtime replay probe uses the launch-scoped physical consumer group",
  );
  const ownerBrowserSource = await readFile(
    new URL("./owner-browser.mjs", import.meta.url),
    "utf8",
  );
  const groupStart = ownerBrowserSource.indexOf(
    '        const consumers =\n          setup.config.services["realtime-gateway"].kafka.consumers;',
  );
  const groupEnd = ownerBrowserSource.indexOf(
    "        return await bounded(",
    groupStart,
  );
  assert.ok(groupStart >= 0 && groupEnd > groupStart);
  const replayGroup = runInNewContext(
    `(()=>{${ownerBrowserSource.slice(groupStart, groupEnd)}return [group, physicalTopic, ack.topic];})()`,
    {
      assert,
      assertFixtureKafkaNamespaceBound,
      ack: { topic: config.kafka.topics.realtimeInvalidate.name },
      setup: { config, launchIdentity },
    },
  );
  assert.equal(
    replayGroup[0],
    realtimeTarget.groups[realtimeConsumers[0].groupId],
  );
  assert.equal(
    replayGroup[1],
    `${launchIdentity.runId}.${config.kafka.topics.realtimeInvalidate.name}`,
  );
  assert.equal(replayGroup[2], config.kafka.topics.realtimeInvalidate.name);

  const rowStart = ownerBrowserSource.indexOf(
    "            const row = text",
    groupEnd,
  );
  const rowEnd = ownerBrowserSource.indexOf("\n            if (", rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const findOffset = (text) =>
    runInNewContext(
      `(()=>{${ownerBrowserSource.slice(rowStart, rowEnd)}return row;})()`,
      {
        group: replayGroup[0],
        physicalTopic: replayGroup[1],
        ack: { partition: 1 },
        text,
      },
    );
  const matchingRow = `${replayGroup[0]} ${replayGroup[1]} 1 0 7 0 - -`;
  assert.deepEqual(
    JSON.parse(JSON.stringify(findOffset(matchingRow))),
    matchingRow.split(/\s+/u),
  );
  assert.equal(
    findOffset(`foreign-group ${replayGroup[1]} 1 0 7 0 - -`),
    undefined,
  );
  assert.equal(
    findOffset(`${replayGroup[0]} foreign-topic 1 0 7 0 - -`),
    undefined,
  );
});

void test("catalog harness keeps default setup and scopes launch PostgreSQL ownership", async () => {
  const source = await readFile(
    new URL("../../../scripts/catalog-live-harness.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function withCatalogPostgres(");
  assert.ok(start >= 0);
  const implementation = source.slice(start).replace(/^export /u, "");
  const cid = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const launchIdentity = validateLaunchDatabaseIdentity({
    schemaVersion: 1,
    runId: "20261026T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
    baseConfigSha256: "c".repeat(64),
  });

  async function execute({
    skipCatalogInitialization,
    driftField,
    launchOutput,
    identityOverride = launchIdentity,
    includeLaunchIdentity = true,
  }) {
    const calls = [],
      queries = [],
      starts = [],
      stops = [],
      readiness = [];
    let inspectCount = 0;
    let removed = false;
    let callbackInvoked = false;
    const expectedName = `coffee-catalog-${process.pid}-00000000`;
    const expectedLabel = skipCatalogInitialization
      ? `${identityOverride?.runId ?? launchIdentity.runId}-${"01".repeat(8)}`
      : `${expectedName}-${"01".repeat(8)}`;
    const docker = async (...args) => {
      calls.push(args);
      if (args[0] === "run") return { stdout: launchOutput ?? `${cid}\n` };
      if (args[0] === "inspect") {
        inspectCount++;
        const fields = [
          cid,
          `/${expectedName}`,
          imageId,
          "postgres:17.11",
          expectedLabel,
          JSON.stringify([{ HostIp: "127.0.0.1", HostPort: "45432" }]),
          JSON.stringify({
            "/var/lib/postgresql/data": "rw,noexec,nosuid,size=536870912",
          }),
        ];
        if (driftField !== undefined && inspectCount >= 3) {
          const replacement = {
            id: ["f".repeat(64), 0],
            name: ["/foreign-postgres", 1],
            imageId: [`sha256:${"d".repeat(64)}`, 2],
            configuredImage: ["postgres:17.10", 3],
            label: ["foreign-run", 4],
            tmpfs: [JSON.stringify({}), 6],
          }[driftField];
          if (replacement) fields[replacement[1]] = replacement[0];
          else
            fields[5] = JSON.stringify([
              {
                HostIp: driftField === "hostIp" ? "0.0.0.0" : "127.0.0.1",
                HostPort: driftField === "hostPort" ? "5433" : "45432",
              },
            ]);
        }
        return {
          stdout: `${fields.join("|")}\n`,
        };
      }
      if (args[0] === "exec") {
        assert.deepEqual(args, [
          "exec",
          cid,
          "stat",
          "-f",
          "-c",
          "%T|%S|%b",
          "/var/lib/postgresql/data",
        ]);
        return { stdout: "tmpfs|4096|131072\n" };
      }
      if (args[0] === "ps") return { stdout: removed ? "" : `${cid}\n` };
      if (args[0] === "rm") {
        removed = true;
        return { stdout: "" };
      }
      throw new Error(`unexpected docker command: ${args[0]}`);
    };
    class FakeClient {
      constructor(options) {
        this.options = options;
      }
      async connect() {
        readiness.push(this.options.database);
      }
      async query(sql) {
        queries.push({ database: this.options.database, sql });
        return { rows: [] };
      }
      async end() {}
    }
    const randomBytes = (size) => Buffer.alloc(size, size === 4 ? 0 : 1);
    const context = {
      assert,
      AbortController,
      AbortSignal,
      AggregateError,
      Client: FakeClient,
      createDatabase: ({ owner, database }) => ({
        resource: {
          async start() {
            starts.push({ owner, database });
          },
          async stop() {
            stops.push({ owner, database });
          },
        },
      }),
      databaseName: "coffee_platform_catalog",
      docker,
      image: "postgres:17.11",
      migrations: async () => [],
      password: "fake-only",
      performance,
      pool: {},
      proveMigrations: async () => ({
        firstApply: [],
        secondApply: [],
        migrationProof: { verified: true },
      }),
      randomBytes,
      process,
      validateLaunchDatabaseIdentity,
      waitForPostgres: async (_port, database) => readiness.push(database),
    };
    const invoke = runInNewContext(
      `(()=>{${implementation};return withCatalogPostgres;})()`,
      context,
    );
    const callback = async (input) => {
      callbackInvoked = true;
      return {
        ...input,
        runLabel: input.runLabel,
      };
    };
    const options = skipCatalogInitialization
      ? {
          skipCatalogInitialization: true,
          ...(includeLaunchIdentity
            ? { launchIdentity: identityOverride }
            : {}),
        }
      : {};
    try {
      const result = await invoke(callback, options);
      return {
        result,
        calls,
        queries,
        starts,
        stops,
        readiness,
        removed,
        callbackInvoked,
      };
    } catch (error) {
      return {
        error,
        calls,
        queries,
        starts,
        stops,
        readiness,
        removed,
        callbackInvoked,
      };
    }
  }

  const isolated = await execute({ skipCatalogInitialization: true });
  assert.equal(isolated.error, undefined);
  assert.equal(isolated.result.catalogInitialized, false);
  assert.equal(isolated.result.databaseName, "postgres");
  assert.equal(isolated.result.launchIdentity.runId, launchIdentity.runId);
  assert.deepEqual(isolated.readiness, ["postgres", "postgres"]);
  assert.deepEqual(isolated.queries, []);
  assert.deepEqual(isolated.starts, []);
  assert.equal(
    isolated.calls.filter(([command]) => command === "rm").length,
    1,
  );
  assert.equal(isolated.removed, true);

  for (const identityOptions of [
    { includeLaunchIdentity: false },
    {
      identityOverride: {
        ...launchIdentity,
        runId: "not-a-launch-run",
      },
    },
  ]) {
    const invalid = await execute({
      skipCatalogInitialization: true,
      ...identityOptions,
    });
    assert.ok(invalid.error);
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.callbackInvoked, false);
  }

  const ordinary = await execute({ skipCatalogInitialization: false });
  assert.equal(ordinary.error, undefined);
  assert.equal(ordinary.result.catalogInitialized, true);
  assert.equal(ordinary.result.databaseName, "coffee_platform_catalog");
  assert.ok(ordinary.queries.some(({ sql }) => sql.startsWith("CREATE ROLE")));
  assert.deepEqual(
    ordinary.starts
      .map(({ owner }) => owner)
      .sort((left, right) => left.localeCompare(right)),
    ["catalog-migrator-proof", "catalog-supplier-sync"],
  );
  assert.equal(ordinary.result.cleanup.containerRemoved, true);

  for (const driftField of [
    "id",
    "name",
    "imageId",
    "configuredImage",
    "label",
    "hostIp",
    "hostPort",
    "tmpfs",
  ]) {
    const drifted = await execute({
      skipCatalogInitialization: true,
      driftField,
    });
    assert.ok(drifted.error, `${driftField} drift must fail closed`);
    assert.equal(drifted.callbackInvoked, false);
    assert.equal(
      drifted.calls.filter(([command]) => command === "rm").length,
      0,
    );
    assert.equal(drifted.removed, false);
  }
  const unknown = await execute({
    skipCatalogInitialization: true,
    launchOutput: "short-container-id\n",
  });
  assert.ok(unknown.error);
  assert.equal(unknown.callbackInvoked, false);
  assert.equal(
    unknown.calls.some(([command]) => command === "ps"),
    false,
  );
  assert.equal(
    unknown.calls.some(([command]) => command === "rm"),
    false,
  );
});

void test("operator-1 CLI requires a frozen manifest and never admits old full5000", async () => {
  const { parse, scratchRoot } = await import("../soak.test.mjs");
  const previousTmpdir = process.env.TMPDIR;
  const previousScratch = process.env.COFFEE_LAUNCH_SCRATCH;
  let portableTmpdir;
  try {
    delete process.env.TMPDIR;
    delete process.env.COFFEE_LAUNCH_SCRATCH;
    assert.throws(
      () => parse(["--smoke"]),
      /каталог soak задаётся явно/u,
      "без объявленного scratch каталог soak не угадывается",
    );
    const declaredScratch = await mkdtemp(
      join(tmpdir(), "realtime-declared-scratch-"),
    );
    process.env.COFFEE_LAUNCH_SCRATCH = declaredScratch;
    const defaultScratch = scratchRoot(),
      defaultOptions = parse(["--smoke"]);
    assert.equal(defaultScratch, resolve(declaredScratch));
    assert.ok(
      relative(defaultScratch, defaultOptions.resultDir).startsWith(
        "realtime-soak-",
      ),
      "declared scratch используется по умолчанию",
    );
    assert.throws(
      () =>
        parse(["--smoke", "--result-dir", `${defaultScratch}-sibling/result`]),
      /declared Hermes scratch/u,
      "a prefix-sharing sibling is outside scratch",
    );
    delete process.env.COFFEE_LAUNCH_SCRATCH;
    portableTmpdir = await mkdtemp(join(tmpdir(), "realtime-operator-cli-"));
    process.env.TMPDIR = ROOT;
    assert.throws(
      () => parse(["--smoke", "--result-dir", join(ROOT, "README.md")]),
      /outside the repository/u,
      "TMPDIR cannot authorize tracked repository output",
    );
    process.env.TMPDIR = portableTmpdir;
    const dir = join(portableTmpdir, "operator-1-cli-proof");
    const prepared = parse([
      "--prepare",
      "--profile",
      "operator-1",
      "--result-dir",
      dir,
    ]);
    assert.equal(prepared.profile, "operator-1");
    assert.equal(prepared.mode, "full");
    assert.equal(prepared.prepareOnly, true);
    assert.equal(
      parse(["--smoke"]).resultDir.startsWith(`${portableTmpdir}/`),
      true,
      "explicit TMPDIR remains the declared scratch root",
    );
    assert.throws(
      () =>
        parse(["--smoke", "--result-dir", `${portableTmpdir}-sibling/result`]),
      /declared Hermes scratch/u,
      "an explicit TMPDIR prefix sibling remains outside scratch",
    );
    assert.throws(
      () => parse(["--profile", "operator-1", "--result-dir", dir]),
      /first --prepare/u,
    );
    assert.throws(
      () =>
        parse(["--prepare", "--profile", "isolated-5000", "--result-dir", dir]),
      /profile/u,
    );
    assert.throws(() => parse(["--prepared", dir]), /approval/u);
    const approved = parse([
      "--prepared",
      dir,
      "--approve-manifest",
      "a".repeat(64),
    ]);
    assert.equal(approved.profile, "operator-1");
    assert.throws(
      () =>
        parse([
          "--prepared",
          dir,
          "--approve-manifest",
          "a".repeat(64),
          "--smoke",
        ]),
      /assert/u,
    );
    assert.throws(
      () =>
        parse([
          "--prepare",
          "--profile",
          "operator-1",
          "--smoke-duration-ms",
          "1000",
          "--result-dir",
          dir,
        ]),
      /never shorten/u,
    );
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousScratch === undefined) delete process.env.COFFEE_LAUNCH_SCRATCH;
    else process.env.COFFEE_LAUNCH_SCRATCH = previousScratch;
    if (portableTmpdir)
      await rm(portableTmpdir, { recursive: true, force: true });
  }
});

void test("prepared operator-1 keeps ordinary budgets, 100 subjects, one shard and rejects input drift", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    '  assert.deepEqual(\n    config.services["realtime-gateway"].realtime,',
  );
  const end = source.indexOf("\n  const nginxSchema = JSON.parse(", start);
  assert.ok(start >= 0 && end > start);
  const document = yaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
    { json: true },
  );
  for (const profile of ["reference-512", "operator-1"]) {
    const config = structuredClone(document),
      memory = 536870912;
    const thresholds = runInNewContext(
      source.slice(start, end) + "\nthresholds;",
      {
        assert: {
          ...assert,
          deepEqual: (actual, expected, message) =>
            assert.deepEqual(
              JSON.parse(JSON.stringify(actual)),
              JSON.parse(JSON.stringify(expected)),
              message,
            ),
        },
        config,
        launchPath: undefined,
        options: { profile },
        THRESHOLDS,
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(thresholds)), {
      ...THRESHOLDS,
      nginxRssBytes: memory,
      realtimeRssBytes: memory,
    });
    const expected = structuredClone(document);
    expected.browserOidc = {
      issuer: "https://idp.fixture.invalid",
      clientId: "realtime-browser-fixture",
      authorizationUrl: "https://idp.fixture.invalid/authorize",
      tokenUrl: "https://idp.fixture.invalid/token",
      jwksUrl: "https://idp.fixture.invalid/keys",
      redirectUri: "https://localhost:8443/auth/callback",
      allowedAlgorithms: ["RS256"],
      actorRefClaim: "actor_ref",
      permissionsClaim: "permissions",
    };

    assert.deepEqual(
      JSON.parse(JSON.stringify(config)),
      JSON.parse(JSON.stringify(expected)),
    );
  }
  const fixtureStart = source.indexOf("  const fixture = {");
  const fixtureEnd = source.indexOf("\n  if (ownerPath)", fixtureStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart);
  const driverSource = await readFile(
    new URL("./driver.mjs", import.meta.url),
    "utf8",
  );
  const distributionStart = driverSource.indexOf("    const count =");
  const distributionEnd = driverSource.indexOf(
    "    const worker = new Worker",
    distributionStart,
  );
  assert.ok(distributionStart >= 0 && distributionEnd > distributionStart);
  for (const [mode, clients, expectedShards] of [
    ["smoke", 1, 1],
    ["smoke", 2, 2],
    ["smoke", 512, 2],
    ["full", 1, 1],
  ]) {
    const fixture = runInNewContext(
      source.slice(fixtureStart, fixtureEnd) + "\nfixture;",
      {
        config: {},
        credentials: {},
        materials: {},
        actor: { verification: {} },
        api: { verification: {} },
        launchPath: undefined,
        thresholds: {},
        FULL,
        options: {
          mode,
          profile: mode === "full" ? "operator-1" : "reference-512",
          smoke: { clients, rate: 100, durationMs: 120000 },
        },
      },
    );
    assert.equal(fixture.subjects, 100);
    assert.equal(
      fixture.shards,
      expectedShards,
      "each shard has a live client that can produce a shutdown receipt",
    );
    let assigned = 0;
    for (let shard = 0; shard < fixture.shards; shard++) {
      const result = runInNewContext(
        driverSource.slice(distributionStart, distributionEnd) +
          "\n({count,clientOffset});",
        { fixture, shard },
      );
      assert.ok(result.count > 0);
      assert.equal(result.clientOffset, assigned);
      assigned += result.count;
    }
    assert.equal(assigned, clients);
  }
  const { verifyPrepared } = await import("./setup.mjs");
  const dir = await mkdtemp(join(tmpdir(), "coffee-realtime-freeze-"));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  try {
    await mkdir(join(dir, "private"));
    await writeFile(join(dir, "profile.json"), "{}");
    await writeFile(join(dir, "private/fixture.json"), "{}");
    for (const field of ["profileSha256", "fixtureSha256"]) {
      const manifest = JSON.stringify({
        mode: "full",
        profile: "operator-1",
        profileSha256: hash("{}"),
        fixtureSha256: hash("{}"),
        [field]: hash("changed"),
      });
      await writeFile(join(dir, "profile-manifest.json"), manifest);
      await assert.rejects(
        verifyPrepared(dir, hash(manifest)),
        field === "profileSha256"
          ? /prepared profile hash drift/u
          : /prepared fixture input hash drift/u,
      );
    }
    await mkdir(join(dir, "private/app"), { recursive: true });
    const sourceHash = hash(await readFile(join(ROOT, "package.json"), "utf8"));
    await writeFile(
      join(dir, "private/app/package.json"),
      "changed frozen source",
    );
    const manifest = JSON.stringify({
      mode: "full",
      profile: "operator-1",
      profileSha256: hash("{}"),
      fixtureSha256: hash("{}"),
      sources: { "package.json": sourceHash },
    });
    await writeFile(join(dir, "profile-manifest.json"), manifest);
    await assert.rejects(
      verifyPrepared(dir, hash(manifest)),
      /prepared source drift: package\.json/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("supply_chain Kafka proof is checked before fixture writes and frozen by immutable ID", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const prepareStart = source.indexOf("export async function prepare("),
    prepareEnd = source.indexOf(
      "\nexport function assertFixtureKafkaNamespaceBound",
      prepareStart,
    );
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const effects = [],
    missingArtifact = new Error("supply_chain artifact unavailable");
  const prepare = runInNewContext(
    `(()=>{${source.slice(prepareStart, prepareEnd).replace(/^export /u, "")};return prepare;})()`,
    {
      readFixtureLaunchPath: async () => null,
      loadVerifiedGateImage: async (options) => {
        effects.push(["verify", options]);
        throw missingArtifact;
      },
      join: (...parts) => parts.join("/"),
      mkdir: async (...args) => effects.push(["mkdir", ...args]),
      docker: async (...args) => effects.push(["docker", ...args]),
      run: async (...args) => effects.push(["run", ...args]),
    },
  );
  await assert.rejects(prepare("/results", {}), (error) => {
    assert.equal(error, missingArtifact);
    return true;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(effects)), [
    ["verify", { target: "kafka", loadImage: false }],
  ]);
  let childContextProof;
  const parentRootPrepare = runInNewContext(
    `(()=>{${source.slice(prepareStart, prepareEnd).replace(/^export /u, "")};return prepare;})()`,
    {
      assert,
      ROOT: "/parent-checkout",
      readFixtureLaunchPath: async () => ({
        parentCandidateRoot: "/parent-checkout",
        candidateRoot: "/child-checkout",
        contextPath: "/child/evidence/context.json",
        launchIdentity: {
          schemaVersion: 1,
          runId: "20261026T123456Z-abcdef0",
          candidateSha: `abcdef0${"1".repeat(33)}`,
          baseConfigSha256: "b".repeat(64),
        },
        lineageReceiptSha256: "d".repeat(64),
      }),
      loadVerifiedGateImage: async (options) => {
        childContextProof = options;
        throw missingArtifact;
      },
      join: (...parts) => parts.join("/"),
    },
  );
  await assert.rejects(
    parentRootPrepare("/results", {
      launchPath: { launchContextFile: "/child/evidence/context.json" },
    }),
    (error) => error === missingArtifact,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(childContextProof)), {
    target: "kafka",
    contextFile: "/child/evidence/context.json",
    loadImage: false,
  });
  assert.match(
    source,
    /const kafkaArtifactProof = await loadVerifiedGateImage\(\{\s*target: "kafka",\s*\.\.\.\(launchPath \? \{ contextFile: launchPath\.contextPath \} : \{\}\),\s*loadImage: false,\s*\}\);/u,
  );
  assert.match(
    source,
    /const images = \{\s*node: nodeImage,\s*nginx: toolchain\.nginxImage,\s*\};/u,
  );
  assert.match(source, /images\.kafka = kafkaArtifact\.imageId/u);

  const proofStart = source.indexOf("  const kafkaArtifactProof ="),
    proofEnd = source.indexOf("  const privateDir", proofStart),
    importStart = source.indexOf(
      "  const kafkaArtifact = await loadVerifiedGateImage({",
    ),
    compareEnd = source.indexOf("\n    // Immutable IDs", importStart),
    catchStart = source.indexOf("} catch (error) {", compareEnd),
    catchEnd = source.indexOf("\n  }\n}", catchStart);
  assert.ok(
    proofStart >= 0 &&
      proofEnd > proofStart &&
      importStart > proofEnd &&
      compareEnd > importStart &&
      catchStart > compareEnd &&
      catchEnd > catchStart,
  );
  const proofSource = source.slice(proofStart, proofEnd),
    importAndCompareSource = source.slice(importStart, compareEnd),
    cleanupCatchSource = source.slice(catchStart, catchEnd + 4),
    fieldValues = (imageId, imported) => ({
      imageId,
      manifestDigest: `sha256:${"b".repeat(64)}`,
      receiptSha256: "c".repeat(64),
      ociArtifactSha256: "d".repeat(64),
      baseImage: `apache/kafka:4.3.2@sha256:${"1".repeat(64)}`,
      candidateSha: "e".repeat(40),
      runId: "g12-fixture",
      importTag: "coffee-g12-0123456789ab-kafka:latest",
      imported,
    });
  for (const imported of [true, false]) {
    const proof = fieldValues(`sha256:${"a".repeat(64)}`, false),
      importedImage = fieldValues(`sha256:${"f".repeat(64)}`, imported),
      removals = [],
      dockerCalls = [],
      manifests = [],
      calls = [];
    const runMismatch = runInNewContext(
      `(async()=>{${proofSource}${importAndCompareSource}${cleanupCatchSource}})()`,
      {
        assert,
        AggregateError,
        launchPath: null,
        loadVerifiedGateImage: async (options) => {
          calls.push(JSON.parse(JSON.stringify(options)));
          return options.loadImage === false ? proof : importedImage;
        },
        removeVerifiedGateImage: (options) => {
          removals.push(options);
          if (!imported) return false;
          return true;
        },
        json: (...args) => manifests.push(args),
      },
    );
    await assert.rejects(
      runMismatch,
      /supply_chain Kafka artifact changed during fixture preparation/u,
    );
    assert.deepEqual(calls, [
      { target: "kafka", loadImage: false },
      { target: "kafka" },
    ]);
    assert.equal(removals.length, 1);
    assert.equal(removals[0].target, "kafka");
    assert.deepEqual(removals[0].image, importedImage);
    assert.deepEqual(manifests, []);
    if (!imported) assert.deepEqual(dockerCalls, []);
  }

  const dir = await mkdtemp(join(tmpdir(), "coffee-g12-kafka-freeze-"));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const imageId = `sha256:${"a".repeat(64)}`;
  const artifact = {
    imageId,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    receiptSha256: "c".repeat(64),
    ociArtifactSha256: "d".repeat(64),
    baseImage: "apache/kafka:4.3.2@sha256:fixture",
    candidateSha: "e".repeat(40),
    runId: "g12-fixture",
    importTag: "coffee-g12-0123456789ab-kafka:latest",
    imported: false,
  };
  try {
    await mkdir(join(dir, "private/app"), { recursive: true });
    const profile = "{}",
      fixture = "{}",
      platform = "config",
      nginx = "nginx",
      native = "native";
    await writeFile(join(dir, "profile.json"), profile);
    await writeFile(join(dir, "private/fixture.json"), fixture);
    await writeFile(join(dir, "private/platform.yaml"), platform);
    await writeFile(join(dir, "private/nginx.conf"), nginx);
    await writeFile(join(dir, "private/app/native.bin"), native);
    const manifest = {
      mode: "full",
      profile: "operator-1",
      profileSha256: hash(profile),
      fixtureSha256: hash(fixture),
      sources: {},
      supportingSources: {},
      compiled: {},
      nativeAdapter: { snapshotPath: "native.bin", sha256: hash(native) },
      configSha256: hash(platform),
      nginxSha256: hash(nginx),
      kafkaSupplyChain: artifact,
      images: { kafka: imageId },
      imageIds: { kafka: imageId },
    };
    const manifestText = JSON.stringify(manifest);
    await writeFile(join(dir, "profile-manifest.json"), manifestText);

    for (const scenario of ["missing", "foreign-receipt"]) {
      const dockerCalls = [];
      const loader =
        scenario === "missing"
          ? async () => {
              throw new Error("supply_chain receipt missing");
            }
          : async () => ({ ...artifact, receiptSha256: "f".repeat(64) });
      const verify = runInNewContext(
        `(()=>{${source
          .slice(
            source.indexOf("export async function verifyPrepared("),
            source.indexOf(
              "\nexport async function erasePrivate(",
              source.indexOf("export async function verifyPrepared("),
            ),
          )
          .replace(/^export /u, "")};return verifyPrepared;})()`,
        {
          assert,
          join,
          readFile,
          hash,
          docker: async (...args) => {
            dockerCalls.push(args);
            return imageId;
          },
          loadVerifiedGateImage: loader,
        },
      );
      await assert.rejects(
        verify(dir, hash(manifestText)),
        scenario === "missing"
          ? /supply_chain receipt missing/u
          : /prepared supply_chain Kafka identity drift: receiptSha256/u,
      );
      assert.deepEqual(dockerCalls, [], `${scenario} must fail before Docker`);
    }

    const dockerCalls = [];
    const verify = runInNewContext(
      `(()=>{${source
        .slice(
          source.indexOf("export async function verifyPrepared("),
          source.indexOf(
            "\nexport async function erasePrivate(",
            source.indexOf("export async function verifyPrepared("),
          ),
        )
        .replace(/^export /u, "")};return verifyPrepared;})()`,
      {
        assert,
        join,
        readFile,
        hash,
        docker: async (...args) => {
          dockerCalls.push(args);
          return imageId;
        },
        loadVerifiedGateImage: async (options) => {
          assert.deepEqual(JSON.parse(JSON.stringify(options)), {
            target: "kafka",
            loadImage: false,
          });
          return artifact;
        },
      },
    );
    await verify(dir, hash(manifestText));
    assert.deepEqual(dockerCalls, [
      ["image", "inspect", "--format", "{{.Id}}", imageId],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("qualification retains its images and private witness until all consumers stop", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function erasePrivate(");
  const end = source.indexOf("\n", source.indexOf("\n}", start) + 2);
  const root = await mkdtemp(join(tmpdir(), "coffee-realtime-cleanup-"));
  const runId = "i12-0123456789abcdef";
  const candidateSha = "a".repeat(40);
  const roles = [
    "edge-gateway",
    "api-public",
    "realtime-gateway",
    "edge-nginx",
  ];
  const tags = roles.map((role) => `${runId}-runtime-${role}:latest`);
  const images = Object.fromEntries(
    roles.map((role, i) => [role, `sha256:${String(i).repeat(64)}`]),
  );
  const manifest = {
    runId,
    qualification: { candidateSha, builtTags: tags },
    images,
  };
  const calls = [];
  try {
    await mkdir(join(root, "private"));
    await writeFile(
      join(root, "profile-manifest.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      join(root, "runtime-image-ownership.json"),
      JSON.stringify({ runId, candidateSha, plannedTags: tags }),
    );
    const cleanup = runInNewContext(
      `(()=>{${source.slice(start, end).replace(/^export /u, "")};return erasePrivate;})()`,
      {
        assert,
        join,
        readFile,
        rm,
        hash: (value) => createHash("sha256").update(value).digest("hex"),
        verifyPrepared: async () => calls.push("verify"),
        docker: async (...args) => {
          calls.push(args);
          if (args[1] === "inspect")
            return images[roles[tags.indexOf(args.at(-1))]];
          return "";
        },
      },
    );
    await assert.rejects(
      cleanup(root, { consumersStopped: true }),
      /ownership witness required/u,
    );
    assert.ok((await stat(join(root, "private"))).isDirectory());
    await writeFile(
      `${root}.ownership.json`,
      JSON.stringify({ runId, parentCandidateSha: candidateSha }),
    );
    for (const consumersStopped of [false, undefined]) {
      await assert.rejects(
        cleanup(root, { consumersStopped }),
        /consumers must be stopped/u,
      );
      assert.deepEqual(calls, []);
      assert.ok((await stat(join(root, "private"))).isDirectory());
    }
    await writeFile(
      `${root}.ownership.json`,
      JSON.stringify({ runId: "foreign" }),
    );
    await assert.rejects(cleanup(root, { consumersStopped: true }));
    assert.deepEqual(calls, []);
    assert.ok((await stat(join(root, "private"))).isDirectory());
    await writeFile(
      `${root}.ownership.json`,
      JSON.stringify({ runId, parentCandidateSha: candidateSha }),
    );
    await cleanup(root, { consumersStopped: true });
    assert.equal(calls[0], "verify");
    assert.equal(
      calls.filter((item) => Array.isArray(item) && item[1] === "inspect")
        .length,
      4,
    );
    assert.deepEqual(
      calls
        .filter((item) => Array.isArray(item) && item[1] === "rm")
        .map((item) => item.at(-1)),
      tags,
    );
    await assert.rejects(stat(join(root, "private")), { code: "ENOENT" });
  } finally {
    await rm(`${root}.ownership.json`, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

void test("supply_chain cleanup does not remove preexisting images or hide preparation failure", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("export async function erasePrivate("),
    end = source.indexOf("\n", source.indexOf("\n}", start) + 2);
  assert.ok(start >= 0 && end > start);
  const dir = await mkdtemp(join(tmpdir(), "coffee-g12-kafka-cleanup-"));
  const artifact = {
    imageId: `sha256:${"a".repeat(64)}`,
    manifestDigest: `sha256:${"b".repeat(64)}`,
    receiptSha256: "c".repeat(64),
    ociArtifactSha256: "d".repeat(64),
    baseImage: "apache/kafka:4.3.2@sha256:fixture",
    candidateSha: "e".repeat(40),
    runId: "g12-fixture",
    importTag: "coffee-g12-0123456789ab-kafka:latest",
  };
  try {
    await mkdir(join(dir, "private"));
    await writeFile(
      join(dir, "profile-manifest.json"),
      JSON.stringify({ kafkaSupplyChain: { ...artifact, imported: false } }),
    );
    const removalCalls = [],
      dockerRemovalCalls = [],
      { removeVerifiedGateImage } =
        await import("../../../tools/verified-infrastructure-image.mjs"),
      cleanup = runInNewContext(
        `(()=>{${source.slice(start, end).replace(/^export /u, "")};return erasePrivate;})()`,
        {
          assert,
          join,
          readFile,
          rm,
          loadVerifiedGateImage: async (options) => {
            assert.deepEqual(JSON.parse(JSON.stringify(options)), {
              target: "kafka",
              loadImage: false,
            });
            return { ...artifact, imported: false };
          },
          removeVerifiedGateImage: (options) => {
            removalCalls.push(options);
            return removeVerifiedGateImage({
              ...options,
              run: (...args) => dockerRemovalCalls.push(args),
            });
          },
        },
      );
    await cleanup(dir);
    assert.equal(removalCalls.length, 1);
    assert.equal(removalCalls[0].image.imported, false);
    assert.deepEqual(dockerRemovalCalls, []);

    await mkdir(join(dir, "private"));
    await writeFile(
      join(dir, "profile-manifest.json"),
      JSON.stringify({
        kafkaSupplyChain: {
          ...artifact,
          receiptSha256: "f".repeat(64),
          imported: true,
        },
      }),
    );
    await assert.rejects(
      cleanup(dir),
      /realtime Kafka cleanup identity drift/u,
    );
    assert.equal(removalCalls.length, 1);
    await assert.rejects(stat(join(dir, "private")), { code: "ENOENT" });

    const original = new Error("preparation failure");
    const catchStart = source.indexOf(
      "catch (error) {",
      source.indexOf("const kafkaArtifact = await loadVerifiedGateImage"),
    );
    const catchEnd = source.indexOf("\n  }\n}", catchStart);
    assert.ok(catchStart >= 0 && catchEnd > catchStart);
    const catchBody = source.slice(
      catchStart + "catch (error) {".length,
      catchEnd,
    );
    const preserveFailure = runInNewContext(`(async(error)=>{${catchBody}})`, {
      AggregateError,
      kafkaArtifact: { ...artifact, imported: true },
      removeVerifiedGateImage: () => {
        throw new Error("cleanup failure");
      },
    });
    await assert.rejects(preserveFailure(original), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors[1].message, "cleanup failure");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("operator-1 manifest declares the actual one-subscriber measurement and 100 subjects", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("    const manifest = {"),
    end = source.indexOf("\n    if (nativeAdapter !== undefined)", start);
  assert.ok(start >= 0 && end > start);
  const config = yaml(
    await readFile(
      new URL("../../../config/platform.yaml", import.meta.url),
      "utf8",
    ),
    { json: true },
  );
  const manifest = await runInNewContext(
    `(async()=>{${source.slice(start, end)};return manifest;})()`,
    {
      options: { runId: "operator-proof", mode: "full", profile: "operator-1" },
      FULL,
      THRESHOLDS,
      thresholds: THRESHOLDS,
      config,
      isoNow: () => "2026-10-13T00:00:00Z",
      process: { arch: "x64", platform: "linux", version: "fixture" },
      availableParallelism: () => 1,
      cpus: () => [],
      totalmem: () => 1,
      readFile: async () => "",
      join,
      hash: (value) => createHash("sha256").update(value).digest("hex"),
      resultDir: "/results",
      privateDir: "/private",
      fingerprints: {},
      fingerprint: "fixture",
      images: {},
      imageIds: {},
      kafkaArtifact: {
        imageId: "sha256:fixture-kafka-image",
        manifestDigest: "sha256:fixture-kafka-manifest",
        receiptSha256: "fixture-receipt-sha256",
        ociArtifactSha256: "fixture-oci-sha256",
        baseImage: "registry.example/kafka@sha256:fixture-base",
        candidateSha: "fixture-candidate",
        runId: "fixture-run",
        importTag: "fixture-import-tag",
        imported: false,
      },
      nginx: "fixture",
      snapshot: { sources: {} },
      compiled: {},
      launchPath: undefined,
      qualification: undefined,
    },
  );
  assert.equal(manifest.subjects, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(manifest.measurement)), {
    clients: 1,
    rate: 100,
    durationMs: 1800000,
  });
  assert.match(manifest.claims, /1.*subscriber/u);
  assert.doesNotMatch(manifest.claims, /5000/u);
  assert.match(manifest.subjectDistribution, /100 subjects/u);
});

void test("operator-1 admission prephase proves 512/513 and releases the boundary cohort before measurement", async () => {
  const source = await readFile(
    new URL("./driver.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function admissionPrephase(cookie) {"),
    end = source.indexOf("\nasync function preflight() {", start);
  assert.ok(
    start >= 0 && end > start,
    "separate admission prephase is required for the one-subscriber measurement",
  );
  let live = 0,
    opened = 0;
  const streams = [],
    result = { checks: {}, checkDetails: {} };
  const admission = runInNewContext(
    `(()=>{${source.slice(start, end)};return admissionPrephase;})()`,
    {
      assert,
      result,
      THRESHOLDS,
      isoNow: () => "2026-10-14T00:00:00Z",
      allStreams: streams,
      fixture: {
        config: {
          nginxTransport: { limits: { sseAdmissionConnections: 512 } },
        },
      },
      openStream: (cookie) => {
        assert.equal(cookie, "synthetic-session");
        opened++;
        if (live === 512)
          return {
            ready: Promise.reject(
              Object.assign(new Error("capacity"), {
                status: 503,
                headers: { "content-type": "application/problem+json" },
                body: JSON.stringify({ code: "REALTIME_CAPACITY_EXCEEDED" }),
              }),
            ),
            closed: Promise.resolve(),
            response: { destroyed: true },
            close() {},
          };
        live++;
        let closed = false;
        const stream = {
          connectionId: `boundary-${opened}`,
          ready: Promise.resolve(),
          closed: Promise.resolve(),
          close() {
            if (!closed) {
              closed = true;
              live--;
            }
          },
        };
        return stream;
      },
      gatewayMetrics: async () => [{ value: live }],
      connectionMetric: (rows) => rows[0],
      until: async (predicate) => {
        assert.equal(
          Boolean(await predicate()),
          true,
          "admission cleanup must finish before returning",
        );
      },
    },
  );
  await admission("synthetic-session");
  assert.equal(opened, 513);
  assert.equal(live, 0);
  assert.equal(result.checks.admission, true);
  assert.equal(result.checkDetails.admission.live, 512);
  assert.equal(result.checkDetails.admission.rejectedConnection, 513);
  assert.equal(result.checkDetails.admission.uniqueConnectionIds, 512);
  assert.equal(result.checkDetails.admission.beforeSseHeaders, true);
  assert.equal(result.checkDetails.admission.cleanupVerified, true);
  assert.match(
    source,
    /await admissionPrephase\(cookie\)/u,
    "actual preflight invokes the separate boundary proof",
  );
  const measurement = source.slice(
    source.indexOf("async function measurement(cookie){"),
  );
  assert.doesNotMatch(
    measurement,
    /fixture\.clients===5000|result\.checks\.admission=false/u,
    "measurement cannot replace the separate receipt or execute the obsolete5000 path",
  );
});

void test("operator-1 driver result carries subject count required by classifier", async () => {
  const source = await readFile(
    new URL("./driver.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const result = {"),
    end = source.indexOf("\nconst workers =", start);
  assert.ok(start >= 0 && end > start);
  const result = runInNewContext(source.slice(start, end) + "\nresult;", {
    fixture: { mode: "full", profile: "operator-1", ...FULL, subjects: 100 },
  });
  assert.equal(result.subjects, 100);
});

void test("fixture log redaction covers JSON keys, headers and generated private material", () => {
  for (const field of ["password", "id_token", "x-actor-context"])
    for (const wire of [
      JSON.stringify({ [field]: "synthetic-secret" }),
      `${field}=synthetic-secret`,
      `${field}: synthetic-secret`,
    ])
      assert.ok(!redact(wire).includes("synthetic-secret"));
  assert.ok(
    !redact("__Host-coffee-session=synthetic-secret;").includes(
      "synthetic-secret",
    ),
  );
  assert.ok(
    !redact(
      "-----BEGIN PRIVATE KEY-----\nsynthetic-secret\n-----END PRIVATE KEY-----",
    ).includes("synthetic-secret"),
  );
});

void test("observer shutdown joins the active monitor promise and suppresses later roles", async () => {
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const scheduleStart = source.indexOf("  function scheduleObservers() {");
  const stopStart = source.indexOf(
    "  async function stopObservers() {",
    scheduleStart,
  );
  const end = source.indexOf("\n  let timer;", stopStart);
  assert.ok(scheduleStart >= 0 && stopStart > scheduleStart && end > stopStart);
  let releaseMonitor;
  const monitorGate = new Promise((resolve) => {
    releaseMonitor = resolve;
  });
  let monitorCalls = 0,
    controlCalls = 0,
    virtualMs = 0;
  const context = {
    driverRunning: true,
    observersStopping: false,
    observerRunning: false,
    observerWork: Promise.resolve(),
    timer: 1,
    clearInterval: () => {},
    handleControl: async () => {
      controlCalls++;
    },
    monitor: async () => {
      monitorCalls++;
      await monitorGate;
    },
  };
  const observers = runInNewContext(
    `(()=>{${source.slice(scheduleStart, end)};return {scheduleObservers,stopObservers};})()`,
    context,
  );
  const work = observers.scheduleObservers();
  assert.equal(monitorCalls, 1);
  assert.equal(controlCalls, 1);
  assert.equal(
    context.observerWork,
    work,
    "retain the exact scheduled observer promise",
  );
  let joined = false;
  const stopping = observers.stopObservers().then(() => {
    joined = true;
  });
  assert.equal(context.driverRunning, false);
  assert.equal(context.observersStopping, true);
  assert.equal(observers.scheduleObservers(), work);
  assert.equal(monitorCalls, 1);
  assert.equal(controlCalls, 1);
  await Promise.resolve();
  assert.equal(joined, false, "cleanup remains blocked by the pending monitor");
  virtualMs = 6001;
  releaseMonitor();
  await stopping;
  assert.ok(
    virtualMs > 5000,
    "the fixture models work beyond the former quiesce timeout without sleeping",
  );
  assert.equal(joined, true);
  assert.equal(context.observerWork, work);
});

void test("observer shutdown joins monitor after immediate control rejection and preserves its error", async () => {
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const scheduleStart = source.indexOf("  function scheduleObservers() {");
  const stopStart = source.indexOf(
    "  async function stopObservers() {",
    scheduleStart,
  );
  const end = source.indexOf("\n  let timer;", stopStart);
  assert.ok(scheduleStart >= 0 && stopStart > scheduleStart && end > stopStart);
  const originalFailure = new Error("synthetic control observer write failure");
  let releaseMonitor;
  const monitorGate = new Promise((resolve) => {
    releaseMonitor = resolve;
  });
  const context = {
    driverRunning: true,
    observersStopping: false,
    observerRunning: false,
    observerWork: Promise.resolve(),
    timer: 1,
    hostFatal: undefined,
    clearInterval: () => {},
    handleControl: async () => {
      throw originalFailure;
    },
    monitor: async () => {
      await monitorGate;
    },
  };
  const observers = runInNewContext(
    `(()=>{${source.slice(scheduleStart, end)};return {scheduleObservers,stopObservers};})()`,
    context,
  );
  const work = observers.scheduleObservers();
  let joined = false;
  const stopping = observers.stopObservers().then(() => {
    joined = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    context.observerRunning,
    true,
    "a rejected control branch does not release the active monitor",
  );
  assert.equal(joined, false, "stop waits for the deferred monitor branch");
  assert.equal(
    context.hostFatal,
    undefined,
    "the branch rejection is retained until both observers settle",
  );
  releaseMonitor();
  await stopping;
  assert.equal(joined, true);
  assert.equal(context.observerWork, work);
  assert.equal(
    context.hostFatal,
    originalFailure,
    "the original rejection is preserved",
  );
  assert.equal(context.observerRunning, false);

  const monitorStart = source.indexOf("  async function monitor() {"),
    monitorEnd = source.indexOf(
      "  async function handleControl() {",
      monitorStart,
    );
  assert.ok(monitorStart >= 0 && monitorEnd > monitorStart);
  for (const [role, running, oomKilled, ignored] of [
    ["driver", false, false, true],
    ["driver", true, false, false],
    ["driver", false, true, false],
    ["edge-nginx", false, false, false],
  ]) {
    let inspections = 0;
    const failures = [];
    const sampleContext = {
      assert,
      monitorBusy: false,
      driverRunning: true,
      observersStopping: false,
      hostFatal: undefined,
      options: { fixtureCheck: role === "driver" },
      realtimeStopped: false,
      controlBusy: false,
      inspectRole: async (observed) => {
        assert.equal(observed, role);
        return {
          c: { id: "owned-target", memory: 1 },
          s: {
            State: {
              Running: inspections++ === 0 ? true : running,
              Pid: 1,
              OOMKilled: inspections === 1 ? false : oomKilled,
            },
          },
        };
      },
      readCgroupMemory: async () => ({ maxBytes: 1, events: { oom_kill: 0 } }),
      docker: async (command) => {
        assert.equal(command, "top");
        return "PID COMMAND\n";
      },
      isoNow: () => "2026-10-13T00:00:00.000Z",
      samples: [],
      dir: "/synthetic",
      join,
      writeFile: async () => {},
      json: async (_, receipt) => failures.push(receipt),
      redact: (value) => value,
      owned: [],
    };
    const monitor = runInNewContext(
      `(()=>{${source.slice(monitorStart, monitorEnd)};return monitor;})()`,
      sampleContext,
    );
    await monitor();
    assert.equal(sampleContext.monitorBusy, false);
    assert.equal(
      failures.length,
      ignored ? 0 : 1,
      `${role}: ignore only a confirmed stopped non-OOM driver`,
    );
    assert.equal(sampleContext.hostFatal === undefined, ignored);
    assert.equal(
      inspections,
      role === "driver" ? 2 : 1,
      "empty measurements recheck only the driver",
    );
  }
});

void test("shutdown close receipt requires a decoded reset frame before the server close", async () => {
  const source = await readFile(
    new URL("./clients.mjs", import.meta.url),
    "utf8",
  );
  const frameStart = source.indexOf(
    '        if (frame.event === "stream-reset.v1") {',
  );
  const frameEnd = source.indexOf(
    '\n        if (frame.event !== "resource-invalidated.v1") return;',
    frameStart,
  );
  const closeStart = source.indexOf(
    "        if (closed || s.normalClose || !s.established) return;",
  );
  const closeEnd = source.indexOf("\n        const age =", closeStart);
  assert.ok(
    frameStart >= 0 &&
      frameEnd > frameStart &&
      closeStart >= 0 &&
      closeEnd > closeStart,
  );
  const frameCode = source.slice(frameStart, frameEnd),
    closeCode = source.slice(closeStart, closeEnd);
  const runClose = async (sawReset) => {
    const failures = [],
      receipts = [],
      messages = [],
      state = { shutdownResetAt: undefined, agent: { destroy() {} } };
    const context = {
      frame: { event: "stream-reset.v1" },
      shutdownArmed: true,
      measuring: false,
      state,
      nowMs: () => 55,
      closed: false,
      s: {
        closeObserved: false,
        counted: false,
        normalClose: false,
        established: true,
        connectionId: "connection-1",
      },
      shutdownReceipts: receipts,
      streams: [{ closed: Promise.resolve() }],
      states: [state],
      client: 0,
      workerData: { clientOffset: 0 },
      index: 0,
      counts: new Int32Array(new SharedArrayBuffer(4)),
      Atomics,
      fatal: (error, code) => failures.push({ message: error.message, code }),
      isoAt: (ms) => new Date(ms).toISOString(),
      parentPort: {
        postMessage: (message) => messages.push(message),
        close() {},
      },
    };
    if (sawReset) runInNewContext(`(()=>{${frameCode}})()`, context);
    context.nowMs = () => 66;
    runInNewContext(`(()=>{${closeCode}})()`, context);
    await new Promise((resolve) => setImmediate(resolve));
    return { failures, receipts, messages, state };
  };
  const withoutReset = await runClose(false);
  assert.equal(withoutReset.failures[0]?.code, "SHUTDOWN_RESET_MISSING");
  assert.deepEqual(withoutReset.receipts, []);
  const withReset = await runClose(true);
  assert.deepEqual(withReset.failures, []);
  assert.equal(withReset.receipts.length, 1);
  assert.equal(withReset.receipts[0].resetAt, new Date(55).toISOString());
  assert.equal(
    withReset.receipts[0].elapsedMs,
    11,
    "close uses the timestamp of the decoded reset frame",
  );
  assert.equal(withReset.messages[0].type, "shutdown-closed");
});

void test("prepared fixture pins the official nginx image and freezes its resolved ID", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /nginx:\s*toolchain\.nginxImage/u);
  assert.match(
    source,
    /imageIds\[name\]\s*=\s*\(\s*await docker\(\s*"image",\s*"inspect",\s*"--format",\s*"\{\{\.Id\}\}",\s*image\s*\)\s*\)\.trim\(\)/u,
  );
  assert.match(
    source,
    /for\s*\(const\s*\[name,\s*image\]\s*of\s*Object\.entries\(manifest\.images\)\)\s*assert\.equal\(\s*\(\s*await docker\(\s*"image",\s*"inspect",\s*"--format",\s*"\{\{\.Id\}\}",\s*name === "kafka" \? manifest\.imageIds\.kafka : image,?\s*\)\s*\)\.trim\(\),\s*manifest\.imageIds\[name\]/u,
  );
  assert.doesNotMatch(source, /nginx-native|nativeNginx|verifyNginxBuild/u);
});

void test("cgroup memory collector preserves raw usage and OOM events without substituting Docker RSS", async () => {
  const setup = await import("./setup.mjs");
  assert.equal(
    typeof setup.readCgroupMemory,
    "function",
    "raw cgroup memory collector is required",
  );
  const values = new Map([
    ["/proc/41/cgroup", "0::/owned-fixture\n"],
    ["/sys/fs/cgroup/owned-fixture/memory.current", "256\n"],
    ["/sys/fs/cgroup/owned-fixture/memory.max", "512\n"],
    ["/sys/fs/cgroup/owned-fixture/memory.peak", "900\n"],
    [
      "/sys/fs/cgroup/owned-fixture/memory.stat",
      "anon 128\nfile 64\nsock 32\nslab 16\n",
    ],
    [
      "/sys/fs/cgroup/owned-fixture/memory.events",
      "oom 2\noom_kill 1\nmax 3\n",
    ],
  ]);
  const reader = async (path) => {
    if (!values.has(path))
      throw Object.assign(new Error("missing measured cgroup file"), {
        code: "ENOENT",
      });
    return values.get(path);
  };
  assert.deepEqual(await setup.readCgroupMemory(41, reader), {
    currentBytes: 256,
    maxBytes: 512,
    peakBytes: 900,
    stat: { anon: 128, file: 64, sock: 32, slab: 16 },
    events: { oom: 2, oom_kill: 1, max: 3 },
  });
  values.delete("/sys/fs/cgroup/owned-fixture/memory.current");
  await assert.rejects(() => setup.readCgroupMemory(41, reader), {
    code: "ENOENT",
  });
  values.set("/proc/41/cgroup", "0::/../../outside\n");
  await assert.rejects(() => setup.readCgroupMemory(41, reader), /cgroup path/);
});

void test("host OOM failure identifies the exact observed role even when its master remains running", async () => {
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const check = source.match(
    /assert\.equal\(\s*s\.State\.OOMKilled,\s*false,\s*`[^`]+`,?\s*\);/u,
  )?.[0];
  assert.ok(check);
  for (const role of ["edge-nginx", "realtime-gateway"]) {
    assert.throws(
      () =>
        runInNewContext(check, {
          assert,
          role,
          s: { State: { Running: true, OOMKilled: true } },
        }),
      (error) => error.message.includes(role) && error.message.includes("OOM"),
    );
    runInNewContext(check, {
      assert,
      role,
      s: { State: { Running: true, OOMKilled: false } },
    });
  }
});

void test("raw cgroup OOM kill rejects a stale clean Docker state", async () => {
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const check = source.match(
    /assert\.equal\(\s*memory\.events\.oom_kill,\s*0,\s*`[^`]+`,?\s*\);/u,
  )?.[0];
  assert.ok(check, "raw cgroup OOM kill must remain a failure");
  assert.throws(
    () =>
      runInNewContext(check, {
        assert,
        role: "edge-nginx",
        memory: { events: { oom_kill: 1 } },
        s: { State: { OOMKilled: false } },
      }),
    /edge-nginx.*OOM/,
  );
  runInNewContext(check, {
    assert,
    role: "edge-nginx",
    memory: { events: { oom_kill: 0 } },
  });
});

void test("owner browser proof cannot execute CLI on import or replace full capacity proof", async () => {
  const { runTransportFixture } = await import("../soak.test.mjs");
  assert.equal(typeof runTransportFixture, "function");
  await assert.rejects(
    () =>
      runTransportFixture(
        { mode: "full" },
        {
          exercise: async () => {
            throw new Error("must not execute");
          },
        },
      ),
    /owner browser proof is smoke-only/,
  );
});

void test("nginx TLS cache and downstream write buffer are bounded without changing authorization TTL", async () => {
  const profile = JSON.parse(
    await readFile(
      new URL("../../nginx/fixtures/profile.json", import.meta.url),
      "utf8",
    ),
  );
  const statusEndpoint = await nginxStatusEndpoint();
  const config = render(
    {
      ...profile,
      tls: { ...profile.tls, sessionCacheMiB: 4, bufferBytes: 4096 },
    },
    [
      { path: "/events", method: "GET" },
      { path: "/api/client-v1/orders/{orderRef}", method: "GET" },
    ],
    statusEndpoint,
  );
  assert.match(config, /ssl_buffer_size 4096;/);
  assert.match(config, /ssl_session_cache shared:coffee_public_tls:4m;/);
  assert.match(config, /ssl_session_timeout 5m;/);
  assert.doesNotMatch(config, /ssl_verify_client off/);
  const events = config.match(/location = \/events \{([\s\S]*?)\n    \}/u)?.[1];
  const apiStart = config.indexOf("location ~ ^/api/client-v1/orders/");
  const apiEnd = config.indexOf("\n    }", apiStart);
  const api =
    apiStart >= 0 && apiEnd > apiStart ? config.slice(apiStart, apiEnd) : "";
  assert.ok(events && api, "event and API upstream locations are rendered");
  assert.match(events, /proxy_buffering off;/);
  assert.match(events, /gzip off;/);
  assert.match(events, /proxy_pass_header X-Accel-Buffering;/);
  assert.doesNotMatch(
    config,
    /proxy_buffer_size/u,
    "SSE uses the normal page-sized upstream response buffer",
  );
});

void test("event-loop sample records the failing maximum before enforcing the unchanged threshold", async () => {
  const source = await readFile(
    new URL("./driver.mjs", import.meta.url),
    "utf8",
  );
  const sampleStart = source.indexOf("  async function sample() {");
  const sampleEnd = source.indexOf(
    "\n  while (performance.now() - start < fixture.durationMs) {",
    sampleStart,
  );
  assert.ok(
    sampleStart >= 0 && sampleEnd > sampleStart,
    "actual driver sample function is available",
  );
  const sampleSource = source.slice(sampleStart, sampleEnd);
  const sampleFunction = (context) =>
    runInNewContext(`(()=>{${sampleSource};return sample;})()`, context);
  const setup = ({ loopValue, previous }) => ({
    assert,
    THRESHOLDS,
    result: { eventLoopP95Ms: previous, checkDetails: {} },
    sampleRunning: false,
    headroomErrors: 0,
    fatal: undefined,
    gatewayMetrics: async () => [],
    connectionMetric: () => ({ value: 512 }),
    metric: () => ({ value: 0 }),
    loopMetric: () => ({ value: loopValue }),
    fixture: { clients: 512 },
    slowBefore: 0,
    headroom: async () => [],
    cookie: "fixture",
    record: async () => {},
    performance: { now: () => 0 },
    start: 0,
    counts: [],
    workers: [],
  });

  assert.equal(
    THRESHOLDS.eventLoopP95Ms,
    100,
    "the event-loop SLO remains 100 ms",
  );
  const failed = setup({ loopValue: 798.49, previous: 40.108 });
  await sampleFunction(failed)();
  assert.equal(
    failed.result.eventLoopP95Ms,
    798.49,
    "the failing observation is retained in the result",
  );
  assert.match(
    failed.fatal?.message ?? "",
    /gateway event-loop p95 >100ms/u,
    "the original SLO assertion still fails",
  );
  assert.equal(failed.headroomErrors, 1);
  assert.equal(failed.sampleRunning, false);

  const healthy = setup({ loopValue: 20, previous: 40.108 });
  await sampleFunction(healthy)();
  assert.equal(healthy.fatal, undefined);
  assert.equal(
    healthy.result.eventLoopP95Ms,
    40.108,
    "successful samples retain the previous maximum",
  );
  assert.equal(healthy.headroomErrors, 0);
  assert.equal(healthy.sampleRunning, false);
});

void test("operator-1 full requires separate 512 admission, 100 subjects and bounded observed re-auth", () => {
  const clientReceipts = [
    {
      client: 0,
      connectionId: "connection-0",
      resetAt: "2026-10-12T00:00:00.000Z",
      serverClosedAt: "2026-10-12T00:00:00.010Z",
      elapsedMs: 10,
    },
  ];
  const shutdown = {
    ok: true,
    state: { ExitCode: 0 },
    elapsedMs: 100,
    clients: 1,
    liveBefore: 1,
    gatewayLiveBefore: 1,
    armedClients: 1,
    armedLive: 1,
    closedClients: 1,
    workerErrors: 0,
    timedOut: false,
    forcedClientClose: false,
    clientReceipts,
    shardReceipts: [{ shard: 0, clients: 1, live: 0 }],
  };
  const good = {
    mode: "full",
    profile: "operator-1",
    subjects: 100,
    durationMs: 1800000,
    clients: 1,
    rate: 100,
    published: 180000,
    minLive: 1,
    maxLive: 1,
    disconnects: 0,
    reconnects: 0,
    eventLatencyP95Ms: 999,
    eventLoopP95Ms: 99,
    coverageChecks: 1,
    protocolFrames: 1,
    checks: {
      admission: true,
      slow: true,
      replay: true,
      evicted: true,
      reset: true,
      reload: true,
      headroom: true,
      cleanup: true,
      shutdown: true,
      budgets: true,
    },
    cleanupVerified: true,
    checkDetails: { shutdown },
  };
  assert.equal(
    classifyResult(good).status,
    "FAIL",
    "zero reconnects over 30 min cannot prove mandatory retained-actor expiry",
  );
  const renewed = {
    ...good,
    minLive: 0,
    disconnects: 1,
    reconnects: 1,
    checks: { ...good.checks, reauth: true },
    checkDetails: {
      shutdown,
      admission: {
        live: 512,
        rejectedConnection: 513,
        status: 503,
        code: "REALTIME_CAPACITY_EXCEEDED",
        beforeSseHeaders: true,
      },
      expectedMaximum: Object.fromEntries(
        Array.from({ length: 100 }, (_, n) => [
          `ord_${String(n + 1).padStart(26, "0")}`,
          "1",
        ]),
      ),
      reauth: {
        recoveredClients: 1,
        samples: 1,
        unexpectedDisconnects: 0,
        pending: 0,
        authCloseDelta: 1,
        finalLive: 1,
        maxGapMs: 4500,
        gapP95Ms: 4000,
        retryMs: 3000,
        readyTimeoutMs: 10000,
        sessionRefreshes: 2,
        sessionRefreshIntervalMs: 600000,
      },
    },
  };
  assert.equal(classifyResult(renewed).status, "PASS");
  assert.equal(
    classifyResult({ ...renewed, mode: "smoke" }).status,
    "smoke-not-launch-proof",
  );
  for (const change of [
    { profile: "isolated-5000", clients: 5000, maxLive: 5000 },
    { profile: "reference-512" },
    { durationMs: 1000 },
    { maxLive: 2 },
    { published: 1 },
    { subjects: 25 },
    { eventLoopP95Ms: 101 },
    { eventLatencyP95Ms: 1001 },
    { cleanupVerified: false },
    { checks: {} },
    { disconnects: 2 },
  ])
    assert.equal(classifyResult({ ...renewed, ...change }).status, "FAIL");
  for (const change of [
    { recoveredClients: 0 },
    { samples: 0 },
    { unexpectedDisconnects: 1 },
    { pending: 1 },
    { authCloseDelta: 0 },
    { authCloseDelta: 2 },
    { finalLive: 0 },
    { maxGapMs: 13001 },
    { gapP95Ms: null },
    { sessionRefreshes: 1 },
    { sessionRefreshIntervalMs: 900000 },
  ])
    assert.equal(
      classifyResult({
        ...renewed,
        checkDetails: {
          ...renewed.checkDetails,
          reauth: { ...renewed.checkDetails.reauth, ...change },
        },
      }).status,
      "FAIL",
    );
  assert.equal(
    classifyResult({
      ...renewed,
      checkDetails: {
        ...renewed.checkDetails,
        admission: { ...renewed.checkDetails.admission, live: 511 },
      },
    }).status,
    "FAIL",
  );
  assert.equal(
    classifyResult({
      ...renewed,
      checkDetails: { ...renewed.checkDetails, expectedMaximum: {} },
    }).status,
    "FAIL",
  );
  for (const change of [
    {
      clients: 0,
      liveBefore: 0,
      gatewayLiveBefore: 0,
      armedClients: 0,
      armedLive: 0,
      closedClients: 0,
      clientReceipts: [],
      shardReceipts: [],
    },
    {
      clientReceipts: [
        { ...clientReceipts[0], resetAt: undefined },
        ...clientReceipts.slice(1),
      ],
    },
    {
      clientReceipts: [
        { ...clientReceipts[0], elapsedMs: 11 },
        ...clientReceipts.slice(1),
      ],
    },
    { clientReceipts: clientReceipts.slice(1) },
    { workerErrors: 1 },
    { timedOut: true },
    { forcedClientClose: true },
  ])
    assert.equal(
      classifyResult({
        ...renewed,
        checkDetails: {
          ...renewed.checkDetails,
          shutdown: { ...shutdown, ...change },
        },
      }).status,
      "FAIL",
    );
});
void test("SSE decoder handles UTF-8 and split transport frames, prohibits service ids and unknown fields", () => {
  const frames = [];
  const validator = (name, data) => {
    assert.equal(name, "stream-ready.v1");
    assert.deepEqual(Object.keys(data).sort(), ["connectedAt", "connectionId"]);
  };
  const d = new SseDecoder(validator, (f) => frames.push(f));
  const wire = Buffer.from(
    'event: stream-ready.v1\ndata: {"connectionId":"тест","connectedAt":"2026-10-07T00:00:00Z"}\n\n',
  );
  for (const byte of wire) d.push(Buffer.from([byte]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.connectionId, "тест");
  d.push(
    Buffer.from(
      'event: stream-ready.v1\nretry: 3000\ndata: {"connectionId":"retry","connectedAt":"2026-10-07T00:00:00Z"}\n\n',
    ),
  );
  assert.equal(frames.length, 2);
  assert.throws(
    () =>
      d.push(Buffer.from("event: stream-ready.v1\nretry: 1000\ndata: {}\n\n")),
    /retry/,
  );
  assert.throws(
    () =>
      d.push(
        Buffer.from("id: forbidden\nevent: stream-ready.v1\ndata: {}\n\n"),
      ),
    /service record/,
  );
  assert.throws(
    () => new SseDecoder(validator, () => {}).push(Buffer.alloc(65537, 65)),
    /frame budget/,
  );
});
void test("SSE invalidation parse cache is exact, validator-scoped, mutable-safe, and bounded at 64", () => {
  const originalParse = JSON.parse;
  let parses = 0,
    validations = 0;
  JSON.parse = (...args) => {
    parses++;
    return originalParse(...args);
  };
  const baseData = {
    subjectRef: "ord_00000000000000000000000001",
    ownerVersion: "1",
  };
  const wire = (
    id,
    data,
    fields = `id: ${id}\nevent: resource-invalidated.v1\nretry: 3000`,
  ) => `${fields}\ndata: ${JSON.stringify(data)}\n\n`;
  const id = "msg_00000000000000000000000000",
    raw = wire(id, baseData),
    frames = [];
  const validate = (event, data) => {
    validations++;
    assert.equal(event, "resource-invalidated.v1");
    assert.deepEqual(Object.keys(data).sort(), ["ownerVersion", "subjectRef"]);
    assert.match(data.subjectRef, /^ord_[0-9a-hjkmnp-tv-z]{26}$/u);
    assert.match(data.ownerVersion, /^[1-9][0-9]*$/u);
  };
  try {
    const decoder = new SseDecoder(validate, (frame) => {
      frames.push(frame);
      if (frames.length === 1) {
        frame.id = "mutated";
        frame.data.subjectRef = "mutated";
      }
    });
    decoder.push(Buffer.from(raw));
    assert.equal(parses, 1);
    assert.equal(validations, 1);
    new SseDecoder(validate, (frame) => frames.push(frame)).push(
      Buffer.from(raw),
    );
    assert.equal(
      parses,
      1,
      "separate decoders sharing a validator reuse the parsed frame",
    );
    assert.equal(validations, 2, "cache hit still executes its validator");
    assert.equal(frames[1].id, id);
    assert.equal(
      frames[1].data.subjectRef,
      baseData.subjectRef,
      "callback mutation cannot poison cached data",
    );

    const changedId = wire("msg_00000000000000000000000001", baseData);
    decoder.push(Buffer.from(changedId));
    assert.equal(parses, 2, "changed id changes the raw cache key");
    assert.equal(validations, 3);
    const reordered = wire(
      id,
      baseData,
      `event: resource-invalidated.v1\nid: ${id}\nretry: 3000`,
    );
    decoder.push(Buffer.from(reordered));
    assert.equal(parses, 3, "changed field order changes the raw cache key");
    assert.equal(validations, 4);
    assert.throws(
      () =>
        decoder.push(
          Buffer.from(wire(id, { ...baseData, subjectRef: "business-data" })),
        ),
      /ord_/u,
    );
    assert.equal(parses, 4, "changed payload cannot reuse the cached parse");
    assert.equal(validations, 5);
    assert.throws(
      () =>
        decoder.push(Buffer.from(wire(id, { ...baseData, totalMinor: 100 }))),
      /totalMinor/u,
    );
    assert.equal(parses, 5, "additional business data is parsed and rejected");
    assert.equal(validations, 6);
    assert.throws(
      () =>
        decoder.push(
          Buffer.from(`${raw.slice(0, -2)}\nx-extra: forbidden\n\n`),
        ),
      /unknown SSE field/u,
    );
    assert.equal(parses, 5, "unknown field is rejected before data parse");
    assert.equal(validations, 6);

    let otherValidations = 0;
    const otherValidator = () => {
      otherValidations++;
      throw new Error("different validator rejected cached frame");
    };
    assert.throws(
      () => new SseDecoder(otherValidator, () => {}).push(Buffer.from(raw)),
      /different validator rejected/u,
    );
    assert.equal(
      parses,
      6,
      "a different validator identity has an independent cache",
    );
    assert.equal(otherValidations, 1);

    let evictionValidations = 0;
    const evictionValidator = (event, data) => {
      evictionValidations++;
      assert.equal(event, "resource-invalidated.v1");
      assert.match(data.ownerVersion, /^[1-9][0-9]*$/u);
    };
    const evictionDecoder = new SseDecoder(evictionValidator, () => {}),
      distinct = [];
    for (let n = 0; n < 65; n++) {
      const frameId = `msg_${String(n).padStart(26, "0")}`;
      distinct.push(
        wire(frameId, {
          subjectRef: baseData.subjectRef,
          ownerVersion: String(n + 1),
        }),
      );
      evictionDecoder.push(Buffer.from(distinct[n]));
    }
    const beforeEvictionRetry = parses;
    evictionDecoder.push(Buffer.from(distinct[0]));
    assert.equal(
      parses,
      beforeEvictionRetry + 1,
      "inserting the 65th raw frame evicts the oldest cache entry",
    );
    assert.equal(evictionValidations, 66);
  } finally {
    JSON.parse = originalParse;
  }
});
void test("generated wire validation formats errors only on rejection and still checks cache hits", async () => {
  const script = `
    import assert from 'node:assert/strict';
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    import Ajv2020 from 'ajv/dist/2020.js';
    const fs=createRequire(import.meta.url)('node:fs/promises'),read=fs.readFile;
    fs.readFile=(path,...args)=>path==='/fixture/fixture.json'?Promise.resolve(JSON.stringify({config:{environment:'test'},materials:{'edge-nginx':{caPem:'synthetic-ca'}}})):read(path,...args);
    syncBuiltinESMExports();
    const {wireValidator}=await import(${JSON.stringify(new URL("./transport.mjs", import.meta.url).href)});
    const {SseDecoder}=await import(${JSON.stringify(new URL("./protocol.mjs", import.meta.url).href)});
    let schemaCalls=0,formatterCalls=0;
    const originalCompile=Ajv2020.prototype.compile,originalErrorsText=Ajv2020.prototype.errorsText,formatted=[];
    Ajv2020.prototype.compile=function(...args){
      const compiled=originalCompile.apply(this,args);
      const counted=(...values)=>{schemaCalls++;return compiled(...values);};
      Object.defineProperty(counted,'errors',{get:()=>compiled.errors,set:value=>{compiled.errors=value;}});
      return counted;
    };
    Ajv2020.prototype.errorsText=function(...args){formatterCalls++;const result=originalErrorsText.apply(this,args);formatted.push(result);return result;};
    try{
      const validate=wireValidator(),decoder=new SseDecoder(validate,()=>{});
      const id='msg_01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const invalidation={subjectType:'order',subjectRef:'ord_01ARZ3NDEKTSV4RRFFQ69G5FAV',ownerVersion:'1',reason:'OrderChanged',correlationId:'77777777-7777-4777-8777-777777777777'};
      const frame=(event,data,frameId)=>[...(frameId?[\`id: \${frameId}\`]:[]),\`event: \${event}\`,...(frameId?['retry: 3000']:[]),\`data: \${JSON.stringify(data)}\`,'',''].join('\\n');
      decoder.push(Buffer.from(frame('stream-ready.v1',{connectionId:'77777777-7777-4777-8777-777777777777',connectedAt:'2026-10-13T00:00:00.000Z'})));
      decoder.push(Buffer.from(frame('stream-reset.v1',{reason:'REPLAY_UNAVAILABLE'})));
      const raw=frame('resource-invalidated.v1',invalidation,id);
      decoder.push(Buffer.from(raw));decoder.push(Buffer.from(raw));
      assert.equal(schemaCalls,4,'the generated validator runs for ready, reset, invalidation, and the exact raw-cache hit');
      assert.equal(formatterCalls,0,'valid frames do not format assertion messages');

      const invalid={...invalidation,totalMinor:1};
      assert.throws(()=>validate('resource-invalidated.v1',invalid),error=>{
        assert.equal(error.name,'AssertionError');assert.equal(error.code,'ERR_ASSERTION');
        assert.equal(error.actual,false);assert.equal(error.expected,true);assert.equal(error.operator,'==');
        assert.equal(error.message,\`generated wire validator rejected resource-invalidated.v1: \${formatted.at(-1)}\`);
        return true;
      });
      assert.equal(schemaCalls,5,'an invalid business field still reaches the generated schema');
      assert.equal(formatterCalls,1,'a rejected generated schema formats its message once');

      assert.throws(()=>validate('unknown-event.v1',{}),error=>{
        assert.equal(error.name,'AssertionError');assert.equal(error.code,'ERR_ASSERTION');
        assert.equal(error.actual,undefined);assert.equal(error.expected,true);assert.equal(error.operator,'==');
        assert.equal(error.message,\`generated wire validator rejected unknown-event.v1: \${formatted.at(-1)}\`);
        return true;
      });
      assert.equal(schemaCalls,5,'unknown events do not invoke a generated schema');
      assert.equal(formatterCalls,2,'unknown-event failure retains the original assertion formatter');
      console.log(JSON.stringify({schemaCalls,formatterCalls,framesValidated:4,failures:2}));
    }finally{
      Ajv2020.prototype.compile=originalCompile;Ajv2020.prototype.errorsText=originalErrorsText;
    }
  `;
  const result = JSON.parse(
    await run(process.execPath, ["--input-type=module", "-e", script]),
  );
  assert.deepEqual(result, {
    schemaCalls: 5,
    formatterCalls: 2,
    framesValidated: 4,
    failures: 2,
  });
});
void test("expected maximum version is enforced for every subject and client", () => {
  const expected = new Int32Array([7, 9]);
  assert.equal(
    assertCoverage([new Int32Array([7, 9]), new Int32Array([8, 10])], expected),
    4,
  );
  assert.throws(
    () => assertCoverage([new Int32Array([7, 8])], expected),
    /silent loss/,
  );
});
void test("checkpoint coverage keeps late maxima pending through the shared absolute deadline", async () => {
  const source = await readFile(
    new URL("./clients.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf('      if (message.type === "checkpoint") {'),
    end = source.indexOf('\n      if (message.type === "stats") {', start);
  assert.ok(start >= 0 && end > start);
  const checkpoint = source.slice(start, end);
  const makeRun = ({ received, states, deadlineAt = 15000 }) => {
    let clock = 1000;
    const tasks = [],
      failures = [],
      messages = [];
    const context = {
      message: {
        type: "checkpoint",
        checkpoint: 1,
        expected: [5, 7],
        checkpointIssuedAt: 1000,
        checkAt: 2000,
        deadlineAt,
      },
      seen: received,
      states,
      measuring: true,
      closed: false,
      coverageChecks: 0,
      index: 0,
      nowMs: () => clock,
      later: (fn, ms) => tasks.push({ fn, at: clock + ms }),
      assertCoverage,
      parentPort: { postMessage: (m) => messages.push(m) },
      fatal: (error, code) => failures.push({ error, code }),
    };
    runInNewContext(`(()=>{${checkpoint}})()`, context);
    return {
      context,
      tasks,
      failures,
      messages,
      setClock: (n) => {
        clock = n;
      },
      tick: () => {
        const task = tasks.shift();
        assert.ok(task, "scheduled coverage scan");
        clock = task.at;
        task.fn();
      },
    };
  };
  const late = makeRun({
    received: [new Int32Array([4, 7]), new Int32Array([5, 6])],
    states: [{ gapAt: 1500 }, { gapAt: undefined }],
  });
  late.tick();
  assert.deepEqual(
    late.failures,
    [],
    "a pending re-auth gap is not mislabeled silent loss",
  );
  assert.equal(late.messages.length, 0);
  late.setClock(2300);
  late.context.seen[0][0] = 8;
  late.context.seen[1][1] = 9;
  late.tasks.shift().fn();
  assert.deepEqual(late.failures, []);
  assert.equal(
    late.context.coverageChecks,
    4,
    "all clients and expected subjects are checked",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(late.messages)),
    [{ type: "coverage", shard: 0, checkpoint: 1, checks: 4 }],
    "higher-than-expected maxima complete coverage",
  );
  const rareLate = new Histogram();
  for (let n = 0; n < 99; n++) rareLate.add(10);
  rareLate.add(1200);
  assert.equal(
    rareLate.p95(),
    10,
    "one late event remains visible in the histogram without suppressing pending coverage",
  );
  assert.equal(rareLate.max, 1200);

  const missing = makeRun({
    received: [new Int32Array([4, 7])],
    states: [{ gapAt: undefined }],
  });
  missing.tick();
  assert.deepEqual(missing.failures, []);
  assert.equal(missing.messages.length, 0);
  while (missing.tasks.length > 0 && missing.failures.length === 0)
    missing.tick();
  assert.equal(missing.failures[0]?.code, "COVERAGE_UNAVAILABLE");
  assert.equal(
    missing.context.nowMs(),
    15000,
    "coverage fails at the absolute deadline",
  );
  const delayedFirstScan = makeRun({
    received: [new Int32Array([5, 7])],
    states: [{ gapAt: undefined }],
  });
  delayedFirstScan.setClock(15001);
  delayedFirstScan.tasks.shift().fn();
  assert.equal(
    delayedFirstScan.failures[0]?.code,
    "COVERAGE_UNAVAILABLE",
    "a scan delayed past deadline cannot pass on a late frame",
  );
  assert.deepEqual(delayedFirstScan.messages, []);

  const driver = await readFile(
    new URL("./driver.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    (
      driver.match(
        /deadlineAt:\s*checkpointIssuedAt\s*\+\s*recoveryBudget\s*\+\s*THRESHOLDS\.eventLatencyP95Ms/gu,
      ) ?? []
    ).length,
    2,
    "periodic and final checkpoints share the same deadline",
  );
  const finalWaitStart = driver.indexOf(
    "  await until(\n    () => {\n      if (fatal) throw fatal;\n      return (\n        covered.size === checkpoint",
  );
  const finalWaitEnd = driver.indexOf(
    "\n  for (const [id, set] of covered)",
    finalWaitStart,
  );
  assert.ok(finalWaitStart >= 0 && finalWaitEnd > finalWaitStart);
  const finalWait = driver.slice(finalWaitStart, finalWaitEnd);
  assert.match(
    finalWait,
    /timeout:\s*recoveryBudget\s*\+\s*THRESHOLDS\.eventLatencyP95Ms/u,
    "the complete checkpoint set retains its 14s bound",
  );
  let waitPasses = 0;
  const covered = new Map([
    [1, new Set([0])],
    [2, new Set([0, 1])],
  ]);
  await runInNewContext(`(async()=>{${finalWait};return true;})()`, {
    until: async (predicate) => {
      waitPasses++;
      if (waitPasses === 1) {
        assert.equal(
          predicate(),
          false,
          "final checkpoint alone cannot release the waiter",
        );
        covered.get(1).add(1);
      }
      assert.equal(
        predicate(),
        true,
        "the previous checkpoint releases the waiter when it completes",
      );
    },
    fatal: undefined,
    covered,
    checkpoint: 2,
    fixture: { shards: 2 },
    recoveryBudget: 13000,
    THRESHOLDS,
  });
  assert.equal(waitPasses, 1);
  const deadlineGuard = checkpoint.indexOf(
      "if (nowMs() >= message.deadlineAt)",
    ),
    waitingClients = checkpoint.indexOf("for (const client of waiting)");
  assert.ok(
    deadlineGuard >= 0 && waitingClients > deadlineGuard,
    "an overdue scan fails closed before observing a late-arriving maximum",
  );
  assert.match(
    source,
    /later\(scanCoverage,\s*Math\.max\(0,\s*message\.checkAt\s*-\s*nowMs\(\)\)\)/u,
    "the first scan retains the one-second histogram checkpoint",
  );
});
void test("synthetic ULID carries producer timestamp without inventing received latency", () => {
  const t = nowMs();
  const id = ulid(t, 5n);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(ulidTime(id), t);
  const maximum = ulid(0xffffffffffff, 0n);
  assert.equal(ulidTime(maximum), 0xffffffffffff);
  assert.throws(() => ulidTime(`8${maximum.slice(1)}`));
  const h = new Histogram();
  for (const n of [1, 2, 3, 4, 5]) h.add(n);
  assert.equal(h.p95(), 5);
  assert.equal(h.count, 5);
  const gaps = new Histogram(13000);
  gaps.add(12500);
  gaps.add(13000);
  assert.equal(
    gaps.p95(),
    13000,
    "all permitted recovery latencies remain measurable",
  );
  gaps.add(13001);
  assert.equal(
    gaps.p95(),
    Infinity,
    "overflow is not clipped into the permitted recovery budget",
  );
});
void test("client latency diagnostics separate replay without removing it from admission p95", async () => {
  const source = await readFile(
    new URL("./clients.mjs", import.meta.url),
    "utf8",
  );
  const measured = source.match(
    /if \(measuring\) \{\s*const latency = nowMs\(\) - ulidTime\(frame\.id\.slice\(4\)\);[\s\S]*?frames\+\+;\s*\}/u,
  )?.[0];
  assert.ok(measured);
  const context = {
    measuring: true,
    replaying: true,
    histogram: new Histogram(),
    liveHistogram: new Histogram(),
    replayHistogram: new Histogram(),
    frames: 0,
    state: { gapAt: 1000 },
    frame: { id: `msg_${ulid(1000, 1n)}` },
    nowMs: () => 4000,
    ulidTime,
  };
  runInNewContext(measured, context);
  // A live frame may follow ready in the same chunk, before the ready promise
  // continuation clears gapAt. The wire boundary, not promise timing, decides.
  context.replaying = false;
  context.frame.id = `msg_${ulid(3990, 2n)}`;
  runInNewContext(measured, context);
  assert.equal(context.histogram.count, 2);
  assert.equal(
    context.histogram.p95(),
    3000,
    "replay still fails unchanged 1000ms admission threshold",
  );
  assert.equal(context.replayHistogram.count, 1);
  assert.equal(context.replayHistogram.p95(), 3000);
  assert.equal(context.liveHistogram.count, 1);
  assert.equal(context.liveHistogram.p95(), 10);
  assert.equal(context.frames, 2);
});
void test("realtime upstream TLS peer state is shared and bounded without changing auth or connection deadlines", async () => {
  const profile = JSON.parse(
    await readFile(
      new URL("../../nginx/fixtures/profile.json", import.meta.url),
      "utf8",
    ),
  );
  const text = render(
    profile,
    [{ path: "/events", method: "GET" }],
    await nginxStatusEndpoint(),
  );
  assert.match(
    text,
    /upstream realtime_gateway \{ zone realtime_tls_state 64k; server /u,
  );
  assert.match(text, /upstream edge_gateway \{ server /u);
  assert.match(text, /upstream api_public \{ server /u);
  assert.match(text, /proxy_connect_timeout 1s;/u);
  assert.match(text, /auth_request \/_edge\/authorize;/u);
  assert.match(text, /proxy_set_header X-Actor-Context \$edge_actor_context;/u);
  assert.match(text, /proxy_next_upstream off;/u);
  assert.match(text, /proxy_cache off;/u);
});
void test("cold product snapshot builds all declared API contract dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "realtime-cold-build-"));
  try {
    const { target } = await sourceSnapshot(dir);
    await run(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "-b",
        ...PRODUCT_BUILD_TARGETS,
        "--force",
        "--pretty",
        "false",
      ],
      { cwd: target, timeout: 120000 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
void test("driver setup links without host-only modules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "realtime-driver-link-"));
  try {
    const loader = join(dir, "deny-host.mjs");
    const output = join(dir, "result.json");
    await writeFile(
      loader,
      `
const denied = new Set([
  new URL(${JSON.stringify(new URL("../../../tools/config-bootstrap/browser-fixture.mjs", import.meta.url).href)}).href,
  new URL(${JSON.stringify(new URL("../../../tools/verified-infrastructure-image.mjs", import.meta.url).href)}).href,
  new URL(${JSON.stringify(new URL("../../../verification/launch/v1/report.mjs", import.meta.url).href)}).href,
]);
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (denied.has(result.url)) throw new Error("host-only module requested");
  return result;
}
`,
    );
    const program = `
const setup = await import(process.argv[1]);
if (typeof setup.assertFixtureKafkaNamespaceBound !== "function") throw new Error("Kafka guard missing");
try { setup.assertFixtureKafkaNamespaceBound({services: {}}, "orders-service"); throw new Error("Kafka guard accepted missing service"); }
catch (error) { if (!String(error.message).includes("configured Kafka runtime exists")) throw error; }
await setup.json(process.argv[2], {linked: true});
`;
    const child = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--loader",
        loader,
        "--input-type=module",
        "-e",
        program,
        new URL("./setup.mjs", import.meta.url).href,
        output,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      linked: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("product launch uses the runtime-supported configuration locators", () => {
  for (const role of ["edge-gateway", "api-public", "realtime-gateway"])
    assert.deepEqual(productArgs(role), [
      "--env",
      "COFFEE_CONFIG_FILE=/fixture/platform.yaml",
      "--env",
      `COFFEE_RUNTIME_SECRETS_FILE=/fixture/${role}.yaml`,
      ...(role === "edge-gateway"
        ? ["--env", "NODE_EXTRA_CA_CERTS=/fixture/certs/ca.crt"]
        : []),
      "--IMAGE--",
      "node",
      "--enable-source-maps",
      `apps/${role}/dist/main.js`,
    ]);
  assert.ok(
    productArgs("orders-service", true).includes(
      "COFFEE_LAUNCH_CONTEXT_FILE=/fixture/launch-context.json",
    ),
  );
  for (const [role, port] of [
    ["edge-gateway", 4000],
    ["api-public", 4050],
    ["realtime-gateway", 4401],
  ]) {
    const args = productArgs(role, true, { port });
    assert.deepEqual(args, [
      "--env",
      "COFFEE_CONFIG_FILE=/app/config/platform.yaml",
      "--env",
      "COFFEE_RUNTIME_SECRETS_FILE=/run/secrets/coffee-platform.yaml",
      "--env",
      "COFFEE_LAUNCH_CONTEXT_FILE=/run/coffee-launch/context.json",
      "--env",
      `PORT=${port}`,
      "--env",
      `OTEL_SERVICE_NAME=${role}`,
      "--env",
      "OTEL_PROPAGATORS=tracecontext,baggage",
      "--env",
      "OTEL_RESOURCE_ATTRIBUTES=service.namespace=coffee-platform,deployment.environment=development",
      "--env",
      "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
      ...(role === "edge-gateway"
        ? ["--env", "NODE_EXTRA_CA_CERTS=/run/g15-browser/idp-ca.crt"]
        : []),
      "--IMAGE--",
    ]);
  }
  assert.throws(() => productArgs("orders-service", true, { port: 4104 }));
  assert.throws(() => productArgs("edge-gateway", false, { port: 4000 }));
  assert.throws(() => productArgs("edge-gateway", true, { port: 0 }));
});
void test("browser realtime launch path binds child identity to verified parent lineage", async () => {
  const source = await readFile(
    new URL("./setup.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function readFixtureLaunchPath(");
  const end = source.indexOf("\n\nfunction assertFixtureLaunchConfig", start);
  assert.ok(start >= 0 && end > start);
  const functionSource = source.slice(start, end);
  const contextPath = "/child/evidence/context.json";
  const receiptPath = "/child/evidence/gates/browser/artifacts/lineage.json";
  const baseCandidateSha = "d".repeat(40);
  const receiptBytes = Buffer.from("synthetic browser lineage receipt\n");
  const active = {
    context: {
      schemaVersion: 1,
      runId: "20261026T123456Z-abcdef0",
      candidateSha: `abcdef0${"1".repeat(33)}`,
      baseConfigSha256: "b".repeat(64),
      resources: {
        g15ParentCandidateSha: baseCandidateSha,
        g15ParentCheckoutRoot: "/source",
        g15ParentRunId: "20261026T123400Z-ddddddd",
        g08PreparationContextPath: "/source/evidence/context.json",
      },
    },
    sourceRoot: "/source",
    candidateRoot: "/child",
  };
  const lineage = {
    schemaVersion: 1,
    runId: active.context.runId,
    candidateSha: active.context.candidateSha,
    configSha256: active.context.baseConfigSha256,
    baseConfigSha256: "c".repeat(64),
    receiptPath,
  };
  const sandbox = {
    assert,
    resolve,
    join,
    contextPath,
    validateLaunchContext: async (path) => {
      if (path === contextPath) return active;
      assert.equal(path, "/source/evidence/context.json");
      return {
        candidateRoot: "/source",
        context: {
          runId: active.context.resources.g15ParentRunId,
          candidateSha: baseCandidateSha,
          baseConfigSha256: lineage.baseConfigSha256,
        },
      };
    },
    stat: async () => ({ uid: 1000, mode: 0o400 }),
    process: { getuid: () => 1000 },
    readBrowserFixtureLineage: async (input) => {
      assert.deepEqual(JSON.parse(JSON.stringify(input)), {
        root: "/source",
        contextPath,
        baseCandidateSha,
      });
      return lineage;
    },
    readFile: async (path) => {
      assert.equal(path, receiptPath);
      return receiptBytes;
    },
    hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
  };
  const invocation = `(async()=>{${functionSource};return await readFixtureLaunchPath({launchContextFile:contextPath})})()`;
  const launchPath = await runInNewContext(invocation, sandbox);
  assert.equal(launchPath.parentCandidateRoot, "/source");
  assert.equal(launchPath.candidateRoot, "/child");
  assert.equal(
    launchPath.launchIdentity.baseConfigSha256,
    active.context.baseConfigSha256,
  );
  assert.equal(
    launchPath.lineageReceiptSha256,
    createHash("sha256").update(receiptBytes).digest("hex"),
  );
  lineage.configSha256 = "f".repeat(64);
  await assert.rejects(runInNewContext(invocation, sandbox));
});

void test("product launch scopes fixture mounts and proves role-local read access", async () => {
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  async function launch("),
    end = source.indexOf("\n\n  async function inspectRole", start);
  assert.ok(start >= 0 && end > start);
  const launchSource = source.slice(start, end);
  const driverLaunchContext = {
    schemaVersion: 1,
    runId: "20261026T123456Z-abcdef0",
    candidateSha: `abcdef0${"1".repeat(33)}`,
    baseConfigSha256: "b".repeat(64),
    checkoutDir: "/child-checkout",
    sourceRepoRoot: "/parent-checkout",
    acceptedBaseCommit: "c".repeat(40),
    startedAtUtc: "2026-10-26T12:34:56.000Z",
    evidenceDir: "/parent-checkout/evidence/launch/20261026T123456Z-abcdef0",
    githubSnapshotPath: null,
    resources: {
      composeProject: "coffee-launch-20261026t123456z-abcdef0",
      kafkaPrefix: "20261026T123456Z-abcdef0",
    },
  };
  const driverIdentity = Object.fromEntries(
    ["schemaVersion", "runId", "candidateSha", "baseConfigSha256"].map(
      (key) => [key, driverLaunchContext[key]],
    ),
  );
  const driverPlatformBytes = Buffer.from("synthetic child platform config\n");
  const driverOwnershipBytes = Buffer.from('{"schemaVersion":1}\n');
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const driverConfigSha256 = digest(driverPlatformBytes);
  const driverOwnershipSha256 = digest(driverOwnershipBytes);
  const invoke = async (
    role,
    reportedMounts,
    launchPath = false,
    driverProbeInputs = {},
    component = false,
    native = false,
  ) => {
    const calls = [],
      execCalls = [],
      receipts = [],
      owned = [];
    const context = {
      options: { runId: "synthetic-run" },
      network: "synthetic-net",
      LABEL: "synthetic-label",
      ROOT: "/candidate",
      hooks: component ? { launchPath: {} } : {},
      readFile: async () =>
        driverProbeInputs.sourceBytes ?? driverOwnershipBytes,
      hash: digest,
      setup: {
        snapshot: "/fixture-snapshot",
        privateDir: "/private",
        ...(launchPath
          ? {
              launchIdentity: driverIdentity,
              launchContextFile: "/evidence/context.json",
              databaseOwnershipFile:
                "/candidate/config/database-ownership.json",
            }
          : {}),
        images: { node: "node-image" },
        manifest: {
          containerBudgets: {},
          ...(native ? { qualification: {} } : {}),
          configSha256: driverConfigSha256,
          databaseOwnershipSha256: driverOwnershipSha256,
          supportingSources: {
            "config/database-ownership.json": driverOwnershipSha256,
          },
        },
      },
      dir: "/results",
      owned,
      containerReceipts: receipts,
      assert,
      join,
      structuredClone,
      run: async (_command, args) => {
        calls.push(args);
        return "synthetic-container";
      },
      docker: async (...args) => {
        if (args[0] === "inspect")
          return JSON.stringify([
            {
              Config: {
                Labels: { "synthetic-label": "synthetic-run" },
                ...(native
                  ? {
                      Entrypoint: driverProbeInputs.entrypoint ?? [
                        "node",
                        "scripts/permission-enforce.mjs",
                      ],
                      Cmd: ["--entry", "dist/main.js"],
                    }
                  : {}),
              },
              HostConfig: {
                NanoCpus: 2000000000,
                Memory: 536870912,
                Ulimits: [{ Name: "nofile", Hard: 4096 }],
              },
              State: { Running: true },
              Image: driverProbeInputs.image ?? "sha256:synthetic",
              Mounts: reportedMounts,
              NetworkSettings: { Networks: {} },
            },
          ]);
        if (args[0] === "exec") {
          execCalls.push(args);
          if (component || native) {
            const reads = new Map([
              [
                native ? "/app/config/platform.yaml" : "/fixture/platform.yaml",
                driverPlatformBytes,
              ],
              [
                native
                  ? "/run/secrets/coffee-platform.yaml"
                  : `/fixture/${role}.yaml`,
                Buffer.from("scoped secret"),
              ],
              ...(native
                ? [
                    [
                      "/run/coffee-launch/context.json",
                      Buffer.from("child context"),
                    ],
                    ...(role === "edge-gateway"
                      ? [
                          [
                            "/run/g15-browser/idp-ca.crt",
                            Buffer.from("fixture ca"),
                          ],
                        ]
                      : []),
                  ]
                : []),
              ...(driverProbeInputs.missingOwnership
                ? []
                : native
                  ? []
                  : [
                      [
                        "/fixture/database-ownership.json",
                        driverProbeInputs.ownershipBytes ??
                          driverOwnershipBytes,
                      ],
                    ]),
              ...(driverProbeInputs.foreignSecret
                ? [
                    [
                      `/fixture/${role === "orders-service" ? "orders-aroma-preparation" : "orders-service"}.yaml`,
                      Buffer.from("foreign secret"),
                    ],
                  ]
                : []),
            ]);
            let report, failure;
            await runInNewContext(
              `(async()=>{${args.at(-1)};await new Promise(setImmediate)})()`,
              {
                require: (specifier) => {
                  if (specifier === "node:fs/promises")
                    return {
                      readFile: async (path) => {
                        if (!reads.has(path))
                          throw new Error("missing fixture");
                        return reads.get(path);
                      },
                    };
                  if (specifier === "node:crypto") return { createHash };
                  throw new Error(`unexpected probe import: ${specifier}`);
                },
                console: {
                  log: (value) => {
                    report = JSON.parse(value);
                  },
                  error: (value) => {
                    failure = value;
                  },
                },
                process: { exitCode: 0 },
                setImmediate,
              },
            );
            if (failure) throw new Error(String(failure));
            assert.ok(report, "component scoped probe executes");
            return JSON.stringify(report);
          }
          if (role === "driver" && launchPath) {
            const reads = new Map([
              [
                "/fixture/platform.yaml",
                driverProbeInputs.platformBytes ?? driverPlatformBytes,
              ],
              [
                "/run/coffee-launch/database-ownership.json",
                driverProbeInputs.ownershipBytes ?? driverOwnershipBytes,
              ],
              [
                "/run/coffee-launch/context.json",
                Buffer.from(
                  JSON.stringify(
                    driverProbeInputs.launchContext ?? driverLaunchContext,
                  ),
                ),
              ],
            ]);
            let report, failure;
            await runInNewContext(
              `(async()=>{${args.at(-1)};await new Promise(setImmediate)})()`,
              {
                require: (specifier) => {
                  if (specifier === "node:fs/promises")
                    return {
                      readFile: async (path) => {
                        if (!reads.has(path))
                          throw Object.assign(new Error("missing fixture"), {
                            code: "ENOENT",
                          });
                        return reads.get(path);
                      },
                    };
                  if (specifier === "node:crypto") return { createHash };
                  throw new Error(`unexpected probe import: ${specifier}`);
                },
                console: {
                  log: (value) => {
                    report = JSON.parse(value);
                  },
                  error: (value) => {
                    failure = value;
                  },
                },
                process: { exitCode: 0 },
                setImmediate,
              },
            );
            if (failure) throw new Error(String(failure));
            assert.ok(
              report,
              `driver identity and digest probe executes: ${String(failure)}`,
            );
            return JSON.stringify(report);
          }
          return JSON.stringify({
            readablePaths: [
              "/fixture/platform.yaml",
              `/fixture/${role}.yaml`,
              ...(launchPath
                ? [
                    "/fixture/database-ownership.json",
                    "/fixture/launch-context.json",
                  ]
                : []),
              ...(role === "edge-gateway" ? ["/fixture/certs/ca.crt"] : []),
            ],
            deniedPaths: [
              "/fixture/fixture.json",
              `/fixture/${role === "edge-gateway" ? "realtime-gateway" : role === "orders-service" ? "orders-aroma-preparation" : role === "orders-aroma-preparation" ? "orders-service" : "edge-gateway"}.yaml`,
              "/fixture/certs/ca.key",
              "/results/private/fixture.json",
            ],
            configSha256: context.setup.manifest.configSha256,
          });
        }
        throw new Error(`unexpected docker call: ${args[0]}`);
      },
      json: async (_path, value) => {
        context.savedReceipts = structuredClone(value);
      },
    };
    const launchArgs =
      role === "idp"
        ? ["--IMAGE--", "node", "services.mjs", "idp"]
        : role === "driver"
          ? [
              ...(driverProbeInputs.driverArgs ?? []),
              "--IMAGE--",
              "node",
              "--input-type=module",
              "-e",
              "void 0",
            ]
          : [
              ...productArgs(
                role,
                launchPath,
                native ? { port: 4000 } : undefined,
              ),
            ];
    await runInNewContext(
      `(async()=>{${launchSource}\nawait launch('${role}','${native ? "sha256:synthetic" : "node-image"}',${JSON.stringify(launchArgs)});})()`,
      context,
    );
    return { calls, execCalls, receipts, owned, context };
  };
  const expected = (role, launchPath = false, component = false) => {
    if (role === "driver" && launchPath)
      return [
        {
          Type: "bind",
          Source: "/fixture-snapshot",
          Destination: "/app",
          RW: false,
        },
        {
          Type: "bind",
          Source: "/private",
          Destination: "/fixture",
          RW: false,
        },
        {
          Type: "bind",
          Source: "/results",
          Destination: "/results",
          RW: true,
        },
        {
          Type: "bind",
          Source: "/candidate/config/database-ownership.json",
          Destination: "/run/coffee-launch/database-ownership.json",
          RW: false,
        },
        {
          Type: "bind",
          Source: "/evidence/context.json",
          Destination: "/run/coffee-launch/context.json",
          RW: false,
        },
      ].sort((a, b) => a.Destination.localeCompare(b.Destination));
    return [
      {
        Type: "bind",
        Source: "/fixture-snapshot",
        Destination: "/app",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/private/platform.yaml",
        Destination: "/fixture/platform.yaml",
        RW: false,
      },
      {
        Type: "bind",
        Source: `/private/${role}.yaml`,
        Destination: `/fixture/${role}.yaml`,
        RW: false,
      },
      ...(launchPath || component
        ? [
            {
              Type: "bind",
              Source: "/candidate/config/database-ownership.json",
              Destination: "/fixture/database-ownership.json",
              RW: false,
            },
          ]
        : []),
      ...(launchPath
        ? [
            {
              Type: "bind",
              Source: "/evidence/context.json",
              Destination: "/fixture/launch-context.json",
              RW: false,
            },
          ]
        : []),
      ...(role === "edge-gateway"
        ? [
            {
              Type: "bind",
              Source: "/private/certs/ca.crt",
              Destination: "/fixture/certs/ca.crt",
              RW: false,
            },
          ]
        : []),
    ].sort((a, b) => a.Destination.localeCompare(b.Destination));
  };
  for (const role of ["edge-gateway", "api-public", "realtime-gateway"]) {
    const value = await invoke(role, expected(role));
    assert.equal(value.calls.length, 1);
    assert.ok(
      !value.calls[0].some((arg) =>
        arg.includes("src=/private,dst=/fixture,readonly"),
      ),
    );
    assert.ok(
      !value.calls[0].some((arg) => arg.includes("src=/results,dst=/results")),
    );
    assert.equal(value.receipts[0].scopedMounts.readOnly, true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(value.receipts[0].scopedMounts.readablePaths)),
      [
        "/fixture/platform.yaml",
        `/fixture/${role}.yaml`,
        ...(role === "edge-gateway" ? ["/fixture/certs/ca.crt"] : []),
      ],
    );
    assert.equal(value.receipts[0].scopedMounts.deniedPaths.length, 4);
    const probe = String(value.execCalls[0].at(-1));
    for (const path of [
      "/fixture/platform.yaml",
      `/fixture/${role}.yaml`,
      "/fixture/fixture.json",
      "/fixture/certs/ca.key",
      "/results/private/fixture.json",
    ])
      assert.ok(probe.includes(path));
  }
  for (const role of ["edge-gateway", "api-public", "realtime-gateway"]) {
    const mounts = [
      {
        Type: "bind",
        Source: "/private/platform.yaml",
        Destination: "/app/config/platform.yaml",
        RW: false,
      },
      {
        Type: "bind",
        Source: `/private/${role}.yaml`,
        Destination: "/run/secrets/coffee-platform.yaml",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/evidence/context.json",
        Destination: "/run/coffee-launch/context.json",
        RW: false,
      },
      ...(role === "edge-gateway"
        ? [
            {
              Type: "bind",
              Source: "/private/certs/ca.crt",
              Destination: "/run/g15-browser/idp-ca.crt",
              RW: false,
            },
          ]
        : []),
    ];
    const value = await invoke(role, mounts, true, {}, false, true);
    assert.ok(!value.calls[0].includes("--entrypoint"));
    assert.ok(!value.calls[0].some((arg) => arg.includes("dst=/app,readonly")));
    assert.equal(value.calls[0].at(-1), "sha256:synthetic");
    await assert.rejects(
      invoke(
        role,
        [
          ...mounts,
          {
            Type: "bind",
            Source: "/fixture-snapshot",
            Destination: "/app",
            RW: false,
          },
        ],
        true,
        {},
        false,
        true,
      ),
      /fixture mount scope/u,
    );
    await assert.rejects(
      invoke(role, mounts, true, { image: "sha256:foreign" }, false, true),
      /verified image identity/u,
    );
    await assert.rejects(
      invoke(role, mounts, true, { entrypoint: ["node"] }, false, true),
    );
  }
  for (const role of [
    "edge-gateway",
    "api-public",
    "realtime-gateway",
    "orders-service",
  ]) {
    const value = await invoke(role, expected(role, true), true);
    assert.deepEqual(
      JSON.parse(JSON.stringify(value.receipts[0].scopedMounts.readablePaths)),
      [
        "/fixture/platform.yaml",
        `/fixture/${role}.yaml`,
        "/fixture/database-ownership.json",
        "/fixture/launch-context.json",
        ...(role === "edge-gateway" ? ["/fixture/certs/ca.crt"] : []),
      ],
    );
    assert.ok(
      value.calls[0].includes(
        "COFFEE_LAUNCH_CONTEXT_FILE=/fixture/launch-context.json",
      ),
    );
    assert.equal(
      value.receipts[0].scopedMounts.configSha256,
      driverConfigSha256,
    );
  }
  for (const role of ["orders-service", "orders-aroma-preparation"]) {
    const value = await invoke(
      role,
      expected(role, false, true),
      false,
      {},
      true,
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(value.receipts[0].scopedMounts.readablePaths)),
      [
        "/fixture/platform.yaml",
        `/fixture/${role}.yaml`,
        "/fixture/database-ownership.json",
      ],
    );
    assert.equal(
      value.receipts[0].scopedMounts.ownershipSha256,
      driverOwnershipSha256,
    );
    assert.ok(!value.calls[0].some((arg) => arg.includes("launch-context")));
    await assert.rejects(
      invoke(
        role,
        expected(role, false, true),
        false,
        { sourceBytes: Buffer.from("changed") },
        true,
      ),
      /component ownership source changed/u,
    );
    for (const input of [
      { missingOwnership: true },
      { ownershipBytes: Buffer.from("changed") },
      { foreignSecret: true },
    ])
      await assert.rejects(
        invoke(role, expected(role, false, true), false, input, true),
      );
    await assert.rejects(
      invoke(role, expected(role), false, {}, true),
      /fixture mount scope/u,
    );
  }
  const ownerSource = await readFile(
    new URL("../../observability/launch-path.mjs", import.meta.url),
    "utf8",
  );
  const ownerStart = ownerSource.indexOf("          const owner = {");
  const ownerEnd = ownerSource.indexOf(
    "          registerOwner(owner);",
    ownerStart,
  );
  assert.ok(ownerStart >= 0 && ownerEnd > ownerStart);
  const owner = runInNewContext(
    `(()=>{${ownerSource.slice(ownerStart, ownerEnd)}return owner;})()`,
    { f: { externalAttachment: {} }, nginxImage: "image", stop: () => {} },
  );
  const externalDriver = await invoke(
    "driver",
    expected("driver", true),
    true,
    {
      driverArgs: owner.driverArgs,
    },
  );
  const contextEnv = externalDriver.calls[0].find((arg) =>
    arg.startsWith("COFFEE_LAUNCH_CONTEXT_FILE="),
  );
  assert.equal(
    contextEnv,
    `COFFEE_LAUNCH_CONTEXT_FILE=${expected("driver", true).find((mount) => mount.Source === "/evidence/context.json").Destination}`,
  );
  const launchDriver = await invoke("driver", expected("driver", true), true);
  assert.equal(launchDriver.execCalls.length, 1);
  const driverMounts = launchDriver.calls[0].filter((arg) =>
    arg.startsWith("type=bind,"),
  );
  assert.equal(driverMounts.length, 5);
  assert.ok(
    driverMounts.every((mount) => !mount.includes(",dst=/fixture/")),
    "driver file mounts must not be nested inside the read-only fixture mount",
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(launchDriver.receipts[0].scopedMounts)),
    {
      readOnly: true,
      readablePaths: [
        "/fixture/platform.yaml",
        "/run/coffee-launch/database-ownership.json",
        "/run/coffee-launch/context.json",
      ],
      configSha256: driverConfigSha256,
      databaseOwnershipSha256: driverOwnershipSha256,
      launchIdentity: driverIdentity,
    },
  );
  assert.ok(
    launchDriver.calls[0].includes(
      "type=bind,src=/candidate/config/database-ownership.json,dst=/run/coffee-launch/database-ownership.json,readonly",
    ),
  );
  assert.ok(
    launchDriver.calls[0].includes(
      "type=bind,src=/evidence/context.json,dst=/run/coffee-launch/context.json,readonly",
    ),
  );
  await assert.rejects(
    invoke("driver", expected("driver", true), true, {
      launchContext: { ...driverLaunchContext, runId: "foreign-run" },
    }),
    /driver fixture mount verification failed/u,
  );
  await assert.rejects(
    invoke("driver", expected("driver", true), true, {
      platformBytes: Buffer.from("changed child config\n"),
    }),
    /driver fixture mount verification failed/u,
  );
  await assert.rejects(
    invoke("driver", expected("driver", true), true, {
      ownershipBytes: Buffer.from("changed ownership\n"),
    }),
    /driver fixture mount verification failed/u,
  );
  const fixtureMounts = [
    {
      Type: "bind",
      Source: "/fixture-snapshot",
      Destination: "/app",
      RW: false,
    },
    { Type: "bind", Source: "/private", Destination: "/fixture", RW: false },
    { Type: "bind", Source: "/results", Destination: "/results", RW: true },
  ];
  const fixture = await invoke("idp", fixtureMounts);
  assert.ok(
    JSON.stringify(fixture.calls[0]).includes(
      "src=/private,dst=/fixture,readonly",
    ),
    JSON.stringify(fixture.calls[0]),
  );
  assert.ok(
    JSON.stringify(fixture.calls[0]).includes("src=/results,dst=/results"),
    JSON.stringify(fixture.calls[0]),
  );
  assert.equal(
    fixture.execCalls.length,
    0,
    "fixture roles retain their prior mounts without product scope probes",
  );
  await assert.rejects(
    invoke("edge-gateway", [
      ...expected("edge-gateway"),
      { Type: "bind", Source: "/private", Destination: "/fixture", RW: false },
      { Type: "bind", Source: "/results", Destination: "/results", RW: true },
    ]),
    /edge-gateway fixture mount scope/u,
  );
});
void test("command evidence remains bounded with an explicit capture limit", async () => {
  const args = ["-e", "process.stdout.write('x'.repeat(4096))"];
  await assert.rejects(run(process.execPath, args, { outputLimit: 1024 }), {
    code: "FIXTURE_COMMAND_FAILED",
  });
  assert.equal(
    (await run(process.execPath, args, { outputLimit: 8192 })).length,
    4096,
  );
  assert.equal(
    await run(
      process.execPath,
      ["-e", "process.stderr.write('synthetic stderr log')"],
      { includeStderr: true },
    ),
    "synthetic stderr log",
  );
});

void test("cross-process control JSON publishes a complete replacement rather than truncating the readable inode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "realtime-control-json-"));
  try {
    const path = join(dir, "control.json");
    await json(path, { id: "previous", ok: false });
    const previous = await stat(path);
    const next = { id: "next", ok: true };
    await json(path, next);
    assert.notEqual(
      (await stat(path)).ino,
      previous.ino,
      "publish via atomic rename, not truncate/write",
    );
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test("cleanup receipts preserve secondary failures when the driver already failed", async () => {
  // Execute the actual orchestrator finally body without launching QA resources.
  const source = await readFile(
    new URL("../soak.test.mjs", import.meta.url),
    "utf8",
  );
  const start = source.lastIndexOf(
    "    const cleanupStart = performance.now(),",
  );
  const end = source.indexOf("\n  }\n  return result;", start);
  assert.ok(start >= 0 && end > start);
  for (const [networkFailed, privateFailed] of [
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ])
    for (const ownerMode of ["absent", "stopped", "failed"]) {
      const artifacts = new Map(),
        result = {
          mode: "smoke",
          checks: {},
          error: {
            code: "HEADROOM_LATENCY_EXCEEDED",
            message: "primary failure",
          },
        };
      await runInNewContext(`(async()=>{${source.slice(start, end)}})()`, {
        assert,
        performance,
        owned: [],
        networkCreated: true,
        retainedPreparation: false,
        redact,
        network: "synthetic-network",
        LABEL: "synthetic-label",
        options: { runId: "synthetic-run", mode: "smoke" },
        dir: "synthetic",
        result,
        join,
        classifyResult,
        hooks: {},
        ownerResource:
          ownerMode === "absent"
            ? undefined
            : {
                stop: async () => {
                  if (ownerMode === "failed")
                    throw new Error("synthetic owner cleanup failure");
                },
              },
        docker: async (...args) => {
          if (networkFailed)
            throw new Error("synthetic network cleanup failure");
          if (args[1] === "inspect")
            return JSON.stringify([
              { Labels: { "synthetic-label": "synthetic-run" } },
            ]);
          return "";
        },
        erasePrivate: async () => {
          if (privateFailed)
            throw new Error("synthetic private cleanup failure");
        },
        json: async (path, data) => {
          artifacts.set(path, structuredClone(data));
        },
        console: { log() {}, error() {} },
      });
      const receipt = artifacts.get(join("synthetic", "cleanup.json"));
      assert.equal(
        result.error.code,
        "HEADROOM_LATENCY_EXCEEDED",
        "secondary error must not replace the driver failure",
      );
      assert.equal(receipt.network.removed, !networkFailed);
      assert.equal(receipt.syntheticPrivateMaterialRemoved, !privateFailed);
      assert.equal(receipt.owner.created, ownerMode !== "absent");
      assert.equal(receipt.owner.removed, ownerMode !== "failed");
      if (ownerMode === "failed")
        assert.match(receipt.owner.error, /synthetic owner cleanup failure/u);
      assert.equal(
        receipt.verified,
        !networkFailed && !privateFailed && ownerMode !== "failed",
      );
      assert.equal(result.cleanupVerified, receipt.verified);
    }
  const ownerSource = await readFile(
    new URL("./owner-browser.mjs", import.meta.url),
    "utf8",
  );
  const stopStart = ownerSource.indexOf("      const stop = async () => {"),
    stopEnd = ownerSource.indexOf("\n      };", stopStart);
  const steps = [];
  const stop = runInNewContext(
    `(${ownerSource.slice(stopStart, stopEnd).trim().replace("const stop = ", "")}\n})`,
    {
      assert,
      AggregateError,
      nginxImage: "synthetic-image",
      network: "synthetic-network",
      f: { container: "synthetic-owner" },
      app: {
        runtimeController: {
          closeRuntime: async () => {
            steps.push("owner");
            throw new Error("primary shutdown");
          },
        },
      },
      client: {
        close: async () => {
          steps.push("client");
          throw new Error("secondary client");
        },
      },
      attached: true,
      imageBuilt: true,
      docker: async (...args) => {
        steps.push(args[0]);
        throw new Error(`secondary ${args[0]}`);
      },
    },
  );
  await assert.rejects(stop(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, "primary shutdown");
    assert.equal(error.errors.length, 4);
    return true;
  });
  assert.deepEqual(steps, ["owner", "client", "network", "image"]);
  assert.ok(
    ownerSource.indexOf("registerOwner({ stop })") <
      ownerSource.indexOf("const connectionPath = join(setup.privateDir"),
    "owner registration precedes publisher credential creation",
  );
  const startupStart = source.indexOf("      if (hooks.startOwner)"),
    startupEnd = source.indexOf("\n      const brokerEnv", startupStart);
  assert.ok(startupStart >= 0 && startupEnd > startupStart);
  const startup = source.slice(startupStart, startupEnd);
  const artifacts = new Map(),
    primary = new Error("primary owner startup");
  const failed = await runInNewContext(
    `(async()=>{let ownerResource;try{${startup}}catch(error){result.error={code:'OWNER_START_FAILED',message:error.message};}${source.slice(start, end)}return result;})()`,
    {
      assert,
      performance,
      AggregateError,
      redact,
      join,
      classifyResult,
      owned: [],
      networkCreated: false,
      retainedPreparation: false,
      setup: {},
      network: "synthetic",
      dir: "synthetic",
      options: { mode: "smoke" },
      result: { mode: "smoke", checks: {} },
      hooks: {
        startOwner: async ({ registerOwner }) => {
          registerOwner({
            stop: async () => {
              throw new AggregateError(
                [new Error("secondary owner"), new Error("secondary image")],
                "owner fixture cleanup failed",
              );
            },
          });
          throw primary;
        },
      },
      erasePrivate: async () => {},
      json: async (path, data) => artifacts.set(path, structuredClone(data)),
      console: { log() {}, error() {} },
    },
  );
  const receipt = artifacts.get(join("synthetic", "cleanup.json"));
  assert.equal(failed.error.message, primary.message);
  assert.equal(receipt.owner.created, true);
  assert.equal(receipt.owner.removed, false);
  assert.equal(receipt.owner.failures.length, 2);
  assert.equal(failed.cleanupVerified, false);
});

void test("positive owner browser keeps frozen compiled transport bytes and private EOF is explicit-only", async () => {
  const source = await readFile(
    new URL("./owner-browser.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
      '      runtimeRelative = "apps/realtime-gateway/dist/runtime-composition.js";',
    ),
    end = source.indexOf("      const gateway =", start);
  assert.ok(start >= 0 && end > start);
  const original = await readFile(
    new URL(
      "../../../apps/realtime-gateway/dist/runtime-composition.js",
      import.meta.url,
    ),
  );
  for (const scenario of ["positive", "private-eof", "reauth"]) {
    let bytes = original,
      writes = 0;
    const context = {
      assert,
      join,
      Buffer,
      scenario,
      runtimeRelative: undefined,
      runtimeTransformedSha256: undefined,
      privateFraming: undefined,
      setup: {
        snapshot: "/snapshot",
        manifest: {
          compiled: {
            "apps/realtime-gateway/dist/runtime-composition.js": createHash(
              "sha256",
            )
              .update(original)
              .digest("hex"),
          },
        },
      },
      dir: "/results",
      hash: (value) => createHash("sha256").update(value).digest("hex"),
      stat: async () => ({ mode: 0o444 }),
      chmod: async () => {},
      readFile: async (path) =>
        path === "/results/profile-manifest.json" ? Buffer.from("{}") : bytes,
      writeFile: async (_path, value) => {
        writes++;
        bytes = value;
      },
    };
    await runInNewContext(
      `(async()=>{${source.slice(start, end)}})()`,
      context,
    );
    assert.equal(
      writes,
      scenario === "private-eof" ? 1 : 0,
      "only explicit private EOF proof may transform the frozen runtime",
    );
    if (scenario !== "private-eof") {
      assert.deepEqual(bytes, original);
      assert.equal(context.privateFraming, undefined);
    } else {
      assert.notDeepEqual(bytes, original);
      assert.notEqual(
        context.privateFraming.originalSha256,
        context.privateFraming.transformedSha256,
      );
    }
  }
});

void test("owner browser verifies every frozen source before issuing either scenario receipt", async () => {
  const source = await readFile(
    new URL("./owner-browser.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("        const sourceAfter = {};"),
    end = source.indexOf("        const compiledAfter = {};", start);
  assert.ok(
    start >= 0 && end > start,
    "both owner browser scenarios must verify the entire frozen source manifest",
  );
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  for (const scenario of ["positive", "private-eof", "reauth"])
    for (const drift of [false, true]) {
      const verify = () =>
        runInNewContext(
          `(async()=>{${source.slice(start, end)};return sourceAfter;})()`,
          {
            assert,
            join,
            hash,
            scenario,
            setup: {
              snapshot: "/snapshot",
              manifest: {
                sources: {
                  "apps/realtime-gateway/src/main.ts": hash("original"),
                  "package.json": hash("manifest"),
                },
              },
            },
            readFile: async (path) =>
              path.endsWith("main.ts")
                ? drift
                  ? "changed"
                  : "original"
                : "manifest",
          },
        );
      if (drift)
        await assert.rejects(
          verify,
          /owner browser source snapshot drift: apps\/realtime-gateway\/src\/main\.ts/u,
        );
      else
        assert.deepEqual(JSON.parse(JSON.stringify(await verify())), {
          "apps/realtime-gateway/src/main.ts": hash("original"),
          "package.json": hash("manifest"),
        });
    }
  assert.match(
    source,
    /proof\.sourceIntegrity\s*=\s*\{\s*before:\s*setup\.manifest\.sources,\s*after:\s*sourceAfter,\s*unchanged:\s*true,\s*\}/u,
  );
});

void test("owner browser response body rejection is captured immediately without counting a successful GET", async () => {
  const source = await readFile(
    new URL("./owner-browser.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
      "        const captureOwnerResponse = (response) => {",
    ),
    end = source.indexOf("\n        };", start) + 10;
  const pending = [],
    responses = [],
    httpFailures = [],
    bodyFailures = [];
  const callback = runInNewContext(
    `(${source.slice(start, end).trim().replace("const captureOwnerResponse = ", "")}\n)`,
    {
      assert,
      URL,
      path: "/api/client-v1/orders/fixture",
      pending,
      responses,
      httpFailures,
      bodyFailures,
      summary: (value) => value,
    },
  );
  callback({
    url: () => "https://fixture/api/client-v1/orders/fixture",
    request: () => ({ method: () => "GET" }),
    status: () => 200,
    json: async () => {
      throw new Error("synthetic body aborted");
    },
  });
  await assert.doesNotReject(Promise.all(pending));
  assert.equal(bodyFailures.length, 1);
  assert.equal(bodyFailures[0].message, "synthetic body aborted");
  assert.deepEqual(responses, []);
  const drainStart = source.indexOf(
      "        const drainResponses = async () => {",
    ),
    drainEnd = source.indexOf("\n        };", drainStart) + 10;
  assert.ok(drainStart >= 0 && drainEnd > drainStart);
  const drainResponses = await runInNewContext(
    `(async()=>{${source.slice(drainStart, drainEnd)};return drainResponses;})()`,
    { assert, pending, bodyFailures },
  );
  await assert.rejects(drainResponses(), /owner GET body read failed/u);
  bodyFailures.length = 0;
  const tailStart = source.indexOf("        const sources = {};"),
    tailEnd = source.indexOf("\n      } finally", tailStart),
    published = [];
  const tail = source.slice(tailStart, tailEnd);
  await assert.rejects(
    runInNewContext(`(async()=>{${tail}})()`, {
      assert,
      join,
      ROOT: "/unit",
      readFile: async () => "",
      hash: () => "unit",
      drainResponses,
      responses,
      bodyFailures,
      pending,
      before: {},
      after: {},
      frame: {},
      baselineRelay: {},
      relay: {},
      duplicate: {},
      restart: {},
      currentReplay: {},
      stale: {},
      nginxWitness: {},
      dir: "unit",
      page: {
        evaluate: async () => {
          callback({
            url: () => "https://fixture/api/client-v1/orders/fixture",
            request: () => ({ method: () => "GET" }),
            status: () => 200,
            json: async () => {
              throw new Error("late body aborted");
            },
          });
          await Promise.all(pending);
          return [];
        },
        off() {},
      },
      context: { close: async () => {} },
      browser: { close: async () => {} },
      captureOwnerResponse: callback,
      json: async (path, value) => published.push(value),
    }),
    /owner GET body read failed/u,
  );
  assert.equal(bodyFailures.at(-1).message, "late body aborted");
  assert.deepEqual(
    published,
    [],
    "late body failure must not publish verified receipt",
  );
});

void test("SSE reconnect retains only its own browser-like TLS session and still sends a fresh HTTP request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "realtime-tls-session-"));
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-days",
      "1",
    ]);
    const script = `
      import assert from 'node:assert/strict';
      import https from 'node:https';
      import tls from 'node:tls';
      import {createRequire,syncBuiltinESMExports} from 'node:module';
      import {randomUUID} from 'node:crypto';
      const fs=createRequire(import.meta.url)('node:fs/promises'),read=fs.readFile;
      const caPem=await read(${JSON.stringify(join(dir, "cert.pem"))},'utf8'),key=await read(${JSON.stringify(join(dir, "key.pem"))},'utf8');
      const calls=[];
      const server=https.createServer({cert:caPem,key,minVersion:'TLSv1.3'},(req,res)=>{
        calls.push({resumed:req.socket.isSessionReused(),cookie:req.headers.cookie,cursor:req.headers['last-event-id']});
        res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});
        res.write('event: stream-ready.v1\\ndata: '+JSON.stringify({connectionId:randomUUID(),connectedAt:new Date().toISOString()})+'\\n\\n');
      });
      await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
      fs.readFile=(path,...args)=>path==='/fixture/fixture.json'?Promise.resolve(JSON.stringify({config:{environment:'test'},materials:{'edge-nginx':{caPem}}})):read(path,...args);
      syncBuiltinESMExports();
      const original=https.request;
      https.request=(options,callback)=>original({...options,hostname:'127.0.0.1',port:server.address().port},callback);
      const {openStream,tlsOptions}=await import(${JSON.stringify(new URL("./transport.mjs", import.meta.url).href)});
      const sharedSecureContext=tls.createSecureContext(tlsOptions('edge-nginx'));
      const first=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:1,secureContext:sharedSecureContext}),second=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:1,secureContext:sharedSecureContext});
      assert.equal(first.options.secureContext,sharedSecureContext);assert.equal(second.options.secureContext,sharedSecureContext);
      try{
        for(const [agent,cookie,lastEventId]of [[first,'first-session',undefined],[first,'fresh-session','msg_01ARZ3NDEKTSV4RRFFQ69G5FAV'],[second,'other-client',undefined]]){
          const stream=openStream(cookie,{agent,lastEventId});await stream.ready;
          assert.equal(stream.request.socket.authorized,true,'shared SecureContext preserves peer verification');assert.equal(stream.request.socket.getProtocol(),'TLSv1.3');
          stream.close();await stream.closed;
        }
        assert.deepEqual(calls.map(c=>c.resumed),[false,true,false],'fresh first admission; TLS resume only for the same client; no cross-client session sharing');
        assert.deepEqual(calls.map(c=>c.cookie),['first-session','fresh-session','other-client'],'each reconnect still makes a new authenticated HTTP request');
        assert.equal(calls[1].cursor,'msg_01ARZ3NDEKTSV4RRFFQ69G5FAV');
        console.log(JSON.stringify({resumed:calls.map(c=>c.resumed),requests:calls.length}));
      }finally{first.destroy();second.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    `;
    const result = JSON.parse(
      await run(process.execPath, ["--input-type=module", "-e", script]),
    );
    assert.deepEqual(result, { resumed: [false, true, false], requests: 3 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
