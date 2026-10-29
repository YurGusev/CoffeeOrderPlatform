import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPreflight } from "./preflight.mjs";
import { EXPECTED_GATES } from "../report.mjs";
import { deriveRuntimeDatabaseTarget } from "../../../../packages/platform-config/src/launch-database-target.ts";
import { deriveLaunchKafkaRegistryTarget } from "../../../../packages/platform-config/src/launch-kafka-target.ts";

const requiredIssues = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18, 19, 60, 61, 62, 63, 64,
  119, 162,
];
const expectedScripts = [
  ...new Set(
    EXPECTED_GATES.flatMap(([, command]) =>
      command.split(" && ").flatMap((part) => {
        const match = /^pnpm\s+([a-z0-9:_-]+)(?:\s|$)/.exec(part);
        return match && !["install", "exec"].includes(match[1])
          ? [match[1]]
          : [];
      }),
    ),
  ),
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const yaml = createRequire(resolve(process.cwd(), "package.json"))("js-yaml");

function withSourceStatus(execFile, sourceStatus) {
  let statusCalls = 0;
  return async (executable, args, cwd) => {
    if (
      executable === "git" &&
      args.join(" ") === "status --porcelain=v1 --untracked-files=all"
    ) {
      statusCalls += 1;
      if (statusCalls === 2) return { code: 0, stdout: sourceStatus };
    }
    return execFile(executable, args, cwd);
  };
}

async function fixture({
  legacyIssue = null,
  missingBase = false,
  repeatIssue12Cursor = false,
  missingScriptName = null,
  emptyConsumersIssue = null,
  missingConsumersIssue = null,
  databaseIsolationEnabled = true,
  kafkaNamespaceIsolationEnabled = false,
  dockerExec = async () => ({ code: 1, stdout: "" }),
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "coffee-preflight-test-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Preflight Test");
  git(root, "config", "user.email", "preflight@example.invalid");
  git(
    root,
    "remote",
    "add",
    "origin",
    "https://github.com/YurGusev/CoffeeOrderPlatform",
  );
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      devDependencies: { "js-yaml": "4.2.0" },
      scripts: Object.fromEntries(
        expectedScripts
          .filter((name) => name !== missingScriptName)
          .map((name) => [name, "fixture-command"]),
      ),
    }),
  );
  await writeFile(
    join(root, "config/toolchain-versions.json"),
    JSON.stringify({
      nodeImage: "node:26.8.1-trixie-slim@sha256:" + "b".repeat(64),
      nginxImage: "nginx:1.31.6-trixie@sha256:" + "a".repeat(64),
      nginxImageIndexDigest: "sha256:" + "a".repeat(64),
    }),
  );
  const ownership = JSON.parse(
    await readFile(
      resolve(process.cwd(), "config/database-ownership.json"),
      "utf8",
    ),
  );
  const services = Object.fromEntries(
    ownership.runtimeClaims
      .filter(({ database }) => database !== null)
      .map(({ runtime, database }) => [runtime, { database }]),
  );
  const configBytes = `schemaVersion: 1\nenvironment: development\nverification:\n  databaseIsolation:\n    enabled: ${databaseIsolationEnabled}\n  kafkaNamespaceIsolation: ${kafkaNamespaceIsolationEnabled}\nservices:\n${Object.entries(
    services,
  )
    .map(
      ([runtime, service]) =>
        `  ${runtime}:\n    database: ${service.database}`,
    )
    .join("\n")}\n`;
  await writeFile(join(root, "config/platform.yaml"), configBytes);
  await writeFile(
    join(root, "config/database-ownership.json"),
    JSON.stringify(ownership),
  );
  await writeFile(join(root, "compose.yaml"), "services:\n  kafka: {}\n");
  await writeFile(join(root, "base.txt"), "accepted base\n");
  await mkdir(join(root, "evidence/handoffs"), { recursive: true });
  await mkdir(join(root, "evidence/outputs"), { recursive: true });
  const issue2Output = "output for issue 2\n";
  await writeFile(join(root, "evidence/outputs/issue-2.txt"), issue2Output);
  const historicalIssue12Input = "historical issue 12 accepted artifact\n";
  await writeFile(
    join(root, "evidence/outputs/issue-12-first.txt"),
    historicalIssue12Input,
  );
  const supplementalIssue49Input = "supplemental issue 49 accepted artifact\n";
  await writeFile(
    join(root, "evidence/outputs/issue-49.txt"),
    supplementalIssue49Input,
  );
  const issue2Handoff = [
    "issue: 2",
    "inputs: []",
    "outputs:",
    "  - artifact: evidence/outputs/issue-2.txt",
    `    sha256: ${sha256(issue2Output)}`,
    "    consumers: [13]",
    "",
  ].join("\n");
  await writeFile(join(root, "evidence/handoffs/issue-2.yaml"), issue2Handoff);
  git(
    root,
    "add",
    "package.json",
    "config/platform.yaml",
    "config/database-ownership.json",
    "config/toolchain-versions.json",
    "compose.yaml",
    "base.txt",
    "evidence/handoffs/issue-2.yaml",
    "evidence/outputs/issue-2.txt",
    "evidence/outputs/issue-12-first.txt",
    "evidence/outputs/issue-49.txt",
  );
  git(root, "commit", "--quiet", "-m", "base");
  const baseCommit = git(root, "rev-parse", "HEAD");
  const firstIssue12 = baseCommit;
  for (const issue of requiredIssues) {
    if (issue === 2) continue;
    const artifact = `evidence/outputs/issue-${issue}.txt`;
    const content = `output for issue ${issue}\n`;
    await mkdir(join(root, "evidence/outputs"), { recursive: true });
    await writeFile(join(root, artifact), content);
    const handoff =
      issue === legacyIssue
        ? [
            `issue: ${String(issue)}`,
            "inputs: []",
            "outputs:",
            "  runtimeCount: 15",
            "",
          ].join("\n")
        : [
            `issue: ${issue}`,
            ...(issue === 4
              ? [
                  "inputs:",
                  "  - issue: 2",
                  `    acceptedMergeCommit: ${baseCommit}`,
                  "    artifact: evidence/handoffs/issue-2.yaml",
                  `    sha256: ${sha256(issue2Handoff)}`,
                ]
              : issue === 5
                ? [
                    "inputs:",
                    "  - issue: 12",
                    `    acceptedMergeCommit: ${firstIssue12}`,
                    "    artifact: evidence/outputs/issue-12-first.txt",
                    `    sha256: ${sha256(historicalIssue12Input)}`,
                  ]
                : issue === 6
                  ? [
                      "inputs:",
                      "  - issue: 49",
                      `    acceptedMergeCommit: ${baseCommit}`,
                      "    artifact: evidence/outputs/issue-49.txt",
                      `    sha256: ${sha256(supplementalIssue49Input)}`,
                    ]
                  : ["inputs: []"]),
            "outputs:",
            `  - artifact: ${artifact}`,
            `    sha256: ${sha256(content)}`,
            ...(issue === emptyConsumersIssue
              ? ["    consumers: []"]
              : issue === missingConsumersIssue
                ? []
                : ["    consumers: [13]"]),
            "",
          ].join("\n");
    await writeFile(
      join(root, `evidence/handoffs/issue-${issue}.yaml`),
      handoff,
    );
  }
  git(root, "add", "evidence");
  git(root, "commit", "--quiet", "-m", "candidate");
  const candidateSha = git(root, "rev-parse", "HEAD");
  const runId = `20261023T120000Z-${candidateSha.slice(0, 7)}`;
  const evidenceDir = join(root, "evidence/launch", runId);
  await mkdir(evidenceDir, { recursive: true });
  const context = {
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256: sha256(configBytes),
    checkoutDir: root,
    sourceRepoRoot: root,
    acceptedBaseCommit: missingBase ? null : baseCommit,
    evidenceDir,
    startedAtUtc: "2026-10-23T12:00:00.000Z",
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      kafkaPrefix: runId,
    },
  };
  const execFile = async (executable, args, cwd, options) => {
    if (executable === "gh" && args[0] === "repo")
      return {
        code: 0,
        stdout: JSON.stringify({
          nameWithOwner: "YurGusev/CoffeeOrderPlatform",
          url: "https://github.com/YurGusev/CoffeeOrderPlatform",
        }),
      };
    if (executable === "gh" && args[0] === "api") {
      const number = Number(
        args.find((arg) => arg.startsWith("number="))?.slice("number=".length),
      );
      const after = args
        .find((arg) => arg.startsWith("after="))
        ?.slice("after=".length);
      let pageInfo = { hasNextPage: false, endCursor: null };
      const pullRequests =
        number === 2
          ? [
              {
                number,
                merged: true,
                mergeCommit: { oid: baseCommit },
                baseRefName: "develop",
                url: `https://github.com/YurGusev/CoffeeOrderPlatform/pull/${number}`,
              },
            ]
          : number === 12 && !after
            ? [
                {
                  number: 999,
                  merged: true,
                  mergeCommit: { oid: firstIssue12 },
                  baseRefName: "develop",
                  url: "https://github.com/YurGusev/CoffeeOrderPlatform/pull/999",
                },
              ]
            : number === 49
              ? [
                  {
                    number: 490,
                    merged: true,
                    mergeCommit: { oid: baseCommit },
                    baseRefName: "develop",
                    url: "https://github.com/YurGusev/CoffeeOrderPlatform/pull/490",
                  },
                ]
              : number === 12
                ? [
                    {
                      number: 1,
                      merged: true,
                      mergeCommit: { oid: candidateSha },
                      baseRefName: "develop",
                      url: "https://github.com/YurGusev/CoffeeOrderPlatform/pull/1",
                    },
                  ]
                : [
                    {
                      number,
                      merged: true,
                      mergeCommit: { oid: candidateSha },
                      baseRefName: "develop",
                      url: `https://github.com/YurGusev/CoffeeOrderPlatform/pull/${number}`,
                    },
                  ];
      if (number === 12 && !after)
        pageInfo = { hasNextPage: true, endCursor: "issue-12-cursor" };
      if (number === 12 && after && repeatIssue12Cursor)
        pageInfo = { hasNextPage: true, endCursor: after };
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                number,
                state: "CLOSED",
                closedByPullRequestsReferences: {
                  nodes: pullRequests,
                  pageInfo,
                },
              },
            },
          },
        }),
      };
    }
    if (executable === "docker") return dockerExec(args, options);
    try {
      return {
        code: 0,
        stdout: execFileSync(executable, args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      };
    } catch (error) {
      return {
        code: error.status ?? 1,
        stdout: error.stdout?.toString() ?? "",
      };
    }
  };
  return { root, context, execFile };
}

const deriveTarget = deriveRuntimeDatabaseTarget;

void test("shared Kafka registry mapping covers all six topics and six DLQs without changing runtime claims", async () => {
  const platformConfig = yaml.load(
    await readFile(resolve(process.cwd(), "config/platform.yaml"), "utf8"),
  );
  const canonical = deriveLaunchKafkaRegistryTarget({
    config: platformConfig.kafka,
    enabled: false,
    environment: "development",
  });
  const runId = "20261023T120000Z-1234567";
  const isolated = deriveLaunchKafkaRegistryTarget({
    config: platformConfig.kafka,
    enabled: true,
    environment: "development",
    launchIdentity: {
      schemaVersion: 1,
      runId,
      candidateSha: `1234567${"1".repeat(33)}`,
      baseConfigSha256: "a".repeat(64),
    },
  });
  assert.equal(Object.keys(canonical.topics).length, 12);
  const sortNames = (left, right) => left.localeCompare(right, "en");
  assert.deepEqual(
    Object.keys(canonical.topics).sort(sortNames),
    Object.values(platformConfig.kafka.topics)
      .flatMap(({ name, dlq }) => [name, dlq])
      .sort(sortNames),
  );
  assert.deepEqual(
    Object.values(isolated.topics).sort(sortNames),
    Object.keys(canonical.topics)
      .sort(sortNames)
      .map((name) => `${runId}.${name}`),
  );
  assert.throws(
    () =>
      deriveLaunchKafkaRegistryTarget({
        config: platformConfig.kafka,
        enabled: true,
        environment: "production",
        launchIdentity: {
          schemaVersion: 1,
          runId,
          candidateSha: `1234567${"1".repeat(33)}`,
          baseConfigSha256: "a".repeat(64),
        },
      }),
    /запрещена в production/u,
  );
});

void test("G00 fails closed on missing or guessed accepted base", async () => {
  const result = await runPreflight({
    schemaVersion: 1,
    runId: "bad",
    candidateSha: "bad",
  });
  assert.equal(result.status, "FAIL");
  assert.deepEqual(
    result.checks.map(({ id }) => id),
    ["CONTEXT"],
  );
});

void test("G00 rejects unknown fields in the accepted handoff supplement", async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const supplement = JSON.parse(
    await readFile(
      resolve(
        process.cwd(),
        "verification/launch/v1/accepted-handoff-supplement.json",
      ),
      "utf8",
    ),
  );
  await mkdir(join(data.root, "verification/launch/v1"), { recursive: true });
  await writeFile(
    join(data.root, "verification/launch/v1/accepted-handoff-supplement.json"),
    JSON.stringify({ ...supplement, unexpected: true }),
  );
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    deriveRuntimeDatabaseTarget: deriveTarget,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(
    result.checks.find(({ id }) => id === "ACCEPTED_HANDOFF_SUPPLEMENT").status,
    "FAIL",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_2").status,
    "FAIL",
  );
});

void test("G00 accepts the exact GitHub merges and accepted blobs in the scoped supplement", async () => {
  const cwd = process.cwd();
  const supplement = JSON.parse(
    await readFile(
      resolve(cwd, "verification/launch/v1/accepted-handoff-supplement.json"),
      "utf8",
    ),
  );
  const mergeByIssue = new Map(
    supplement.records.map(({ issue, acceptanceSource }) => [
      issue,
      acceptanceSource,
    ]),
  );
  const candidateSha = git(cwd, "rev-parse", "HEAD");
  const startedAtUtc = "2026-10-23T12:00:00.000Z";
  const runId = "20261023T120000Z-" + candidateSha.slice(0, 7);
  const context = {
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256: sha256(
      await readFile(resolve(cwd, "config/platform.yaml")),
    ),
    checkoutDir: cwd,
    sourceRepoRoot: cwd,
    acceptedBaseCommit: mergeByIssue.get(2).mergeCommit,
    evidenceDir: resolve(cwd, "evidence/launch", runId),
    startedAtUtc,
    resources: {
      composeProject: "coffee-launch-" + runId.toLowerCase(),
      kafkaPrefix: runId,
    },
  };
  const runWith = async ({
    acceptedMergeOverride = null,
    wrongBlobHash = false,
    ancestryFailure = false,
  } = {}) => {
    let targetAncestryCalls = 0;
    const execFile = async (executable, args, directory) => {
      if (executable === "gh" && args[0] === "repo")
        return {
          code: 0,
          stdout: JSON.stringify({
            nameWithOwner: "YurGusev/CoffeeOrderPlatform",
            url: "https://github.com/YurGusev/CoffeeOrderPlatform",
          }),
        };
      if (executable === "gh" && args[0] === "api") {
        const number = Number(
          args
            .find((arg) => arg.startsWith("number="))
            ?.slice("number=".length),
        );
        const accepted = mergeByIssue.get(number) ?? {
          pullRequest: number,
          mergeCommit: candidateSha,
        };
        const mergeCommit =
          number === 10 && acceptedMergeOverride
            ? acceptedMergeOverride
            : accepted.mergeCommit;
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                issue: {
                  number,
                  state: "CLOSED",
                  closedByPullRequestsReferences: {
                    nodes: [
                      {
                        number: accepted.pullRequest,
                        merged: true,
                        mergeCommit: { oid: mergeCommit },
                        baseRefName: "develop",
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        };
      }
      if (
        executable === "git" &&
        args.join(" ") === "status --porcelain=v1 --untracked-files=all"
      )
        return { code: 0, stdout: "" };
      if (
        ancestryFailure &&
        executable === "git" &&
        args[0] === "merge-base" &&
        args[1] === "--is-ancestor" &&
        args[2] === mergeByIssue.get(10).mergeCommit &&
        args[3] === candidateSha &&
        ++targetAncestryCalls === 1
      ) {
        return { code: 1, stdout: "" };
      }
      if (executable === "docker") return { code: 1, stdout: "" };
      try {
        return {
          code: 0,
          stdout: execFileSync(executable, args, {
            cwd: directory,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        };
      } catch (error) {
        return {
          code: error.status ?? 1,
          stdout: error.stdout?.toString() ?? "",
        };
      }
    };
    const readSupplement = async (path, options) => {
      if (
        !wrongBlobHash ||
        resolve(path) !==
          resolve(
            cwd,
            "verification/launch/v1/accepted-handoff-supplement.json",
          )
      )
        return readFile(path, options);
      const modified = structuredClone(supplement);
      modified.records.find(({ issue }) => issue === 10).artifacts[0].sha256 =
        "0".repeat(64);
      return JSON.stringify(modified);
    };
    return runPreflight(context, {
      cwd,
      execFile,
      readFile: readSupplement,
      env: {},
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
      deriveRuntimeDatabaseTarget: deriveTarget,
      now: () => startedAtUtc,
    });
  };
  const result = await runWith();
  assert.equal(
    result.checks.find(({ id }) => id === "ACCEPTED_HANDOFF_SUPPLEMENT").status,
    "PASS",
  );
  for (const issue of [2, 3, 10, 14, 19, 162]) {
    assert.equal(
      result.checks.find(({ id }) => id === "HANDOFF_" + issue).status,
      "PASS",
      "issue #" + issue,
    );
  }
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_10").facts
      .historicalRuntimeProof,
    "not-inferred",
  );
  assert.match(
    result.checks.find(({ id }) => id === "HANDOFF_14").facts.coverage,
    /design artifacts only/,
  );

  const mergeMismatch = await runWith({ acceptedMergeOverride: candidateSha });
  assert.match(
    mergeMismatch.checks.find(({ id }) => id === "HANDOFF_10").facts.failures[0]
      .reason,
    /fresh GitHub accepted PR\/merge/,
  );
  const blobMismatch = await runWith({ wrongBlobHash: true });
  assert.ok(
    blobMismatch.checks
      .find(({ id }) => id === "HANDOFF_10")
      .facts.failures.some(({ reason }) =>
        /artifact blob SHA-256 mismatch/.test(reason),
      ),
  );
  const ancestryMismatch = await runWith({ ancestryFailure: true });
  assert.equal(
    ancestryMismatch.checks.find(({ id }) => id === "GITHUB_PREDECESSORS")
      .status,
    "FAIL",
  );
  assert.equal(
    ancestryMismatch.checks.find(({ id }) => id === "HANDOFF_10").status,
    "FAIL",
  );
});

void test("G00 requires the canonical enabled database-isolation policy", async (t) => {
  const data = await fixture({ databaseIsolationEnabled: false });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    deriveRuntimeDatabaseTarget: deriveTarget,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  const check = result.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION");
  assert.equal(check.status, "FAIL");
  assert.equal(check.facts.databaseIsolationPolicyEnabled, false);
  assert.equal(check.facts.allRuntimeDatabaseTargetsRunScoped, false);
});

void test("G00 admits Kafka namespace claims only from the committed flag and exact launch context", async (t) => {
  const data = await fixture({ kafkaNamespaceIsolationEnabled: true });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const deriveRuntimeKafkaTarget = ({
    launchIdentity,
    enabled,
    environment,
  }) => {
    assert.equal(enabled, true);
    assert.equal(environment, "development");
    return {
      topics: { orders: `${launchIdentity.runId}.coffee.orders.lifecycle.v1` },
      groups: { "orders-worker": `${launchIdentity.runId}.orders-worker` },
    };
  };
  const canonicalRegistryNames = [
    "coffee.catalog.snapshot.v1",
    "coffee.catalog.snapshot.v1.dlq",
    "coffee.catalog.mapping.v2",
    "coffee.catalog.mapping.v2.dlq",
    "coffee.orders.lifecycle.v1",
    "coffee.orders.lifecycle.v1.dlq",
    "coffee.aroma.cart.commands.v1",
    "coffee.aroma.cart.commands.v1.dlq",
    "coffee.aroma.cart.events.v1",
    "coffee.aroma.cart.events.v1.dlq",
    "coffee.realtime.invalidate.v1",
    "coffee.realtime.invalidate.v1.dlq",
  ];
  const deriveLaunchKafkaRegistryTarget = ({
    launchIdentity,
    enabled,
    environment,
  }) => {
    assert.equal(enabled, true);
    assert.equal(environment, "development");
    return {
      topics: Object.fromEntries(
        canonicalRegistryNames.map((name) => [
          name,
          `${launchIdentity.runId}.${name}`,
        ]),
      ),
    };
  };
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    deriveRuntimeDatabaseTarget: deriveTarget,
    deriveRuntimeKafkaTarget,
    deriveLaunchKafkaRegistryTarget,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  const admitted = result.checks.find(
    ({ id }) => id === "KAFKA_NAMESPACE_PLAN",
  );
  assert.equal(admitted.status, "PASS");
  assert.deepEqual(
    admitted.facts.expectedPhysical.topics,
    [
      ...new Set([
        `${data.context.runId}.coffee.orders.lifecycle.v1`,
        ...canonicalRegistryNames.map(
          (name) => `${data.context.runId}.${name}`,
        ),
      ]),
    ].sort(),
  );
  assert.equal(admitted.facts.expectedPhysical.topics.length, 12);
  for (const name of canonicalRegistryNames.filter((name) =>
    name.endsWith(".dlq"),
  ))
    assert.ok(
      admitted.facts.expectedPhysical.topics.includes(
        `${data.context.runId}.${name}`,
      ),
      name,
    );
  assert.deepEqual(admitted.facts.expectedPhysical.groups, [
    `${data.context.runId}.orders-worker`,
  ]);

  const mutatedContext = { ...data.context, baseConfigSha256: "0".repeat(64) };
  const rejected = await runPreflight(mutatedContext, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    deriveRuntimeDatabaseTarget: deriveTarget,
    deriveRuntimeKafkaTarget,
    deriveLaunchKafkaRegistryTarget,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(
    rejected.checks.find(({ id }) => id === "KAFKA_NAMESPACE_PLAN").status,
    "FAIL",
  );
});

void test("G00 verifies fresh GitHub closure and historical hashes while selecting latest merge by ancestry", async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    deriveRuntimeDatabaseTarget: deriveTarget,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(result.status, "FAIL");
  assert.equal(result.githubSnapshot.sha256.length, 64);
  assert.equal(result.githubSnapshot.issues.length, requiredIssues.length + 1);
  assert.equal(
    result.githubSnapshot.issues.find(({ number }) => number === 12)
      .acceptedMergeCommit,
    data.context.candidateSha,
  );
  assert.equal(
    result.githubSnapshot.issues.find(({ number }) => number === 12)
      .pullRequests.length,
    2,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "GITHUB_PREDECESSORS").status,
    "PASS",
    JSON.stringify(
      result.checks.find(({ id }) => id === "GITHUB_PREDECESSORS"),
      null,
      2,
    ),
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_12").status,
    "PASS",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_4").status,
    "PASS",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_5").status,
    "PASS",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_6").status,
    "PASS",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_7").status,
    "PASS",
    "empty consumers is valid when represented as an array",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "EXACT_GATE_SCRIPTS").status,
    "PASS",
  );
  assert.equal(
    result.githubSnapshot.issues.find(({ number }) => number === 49)
      .supplementalHandoffInput,
    true,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION").facts
      .allRuntimeDatabaseTargetsRunScoped,
    true,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION").facts
      .composeProjectSyntaxValid,
    true,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION").facts
      .runScopedResourceNames,
    true,
  );
  const uppercase = await runPreflight(
    {
      ...data.context,
      resources: {
        ...data.context.resources,
        composeProject: `coffee-launch-${data.context.runId}`,
      },
    },
    {
      cwd: data.root,
      execFile: data.execFile,
      env: {},
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
      deriveRuntimeDatabaseTarget: deriveTarget,
    },
  );
  assert.equal(
    uppercase.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION").facts
      .composeProjectSyntaxValid,
    false,
  );
  assert.equal(
    uppercase.checks.find(({ id }) => id === "CONFIG_AND_ISOLATION").facts
      .runScopedResourceNames,
    false,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY")
      .status,
    "FAIL",
  );
  assert.equal(
    result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY").facts
      .declaredBomPinned,
    true,
  );
  assert.deepEqual(
    result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY").facts
      .actualRuntimeProof,
    {
      endpointKind: "unsupported",
      daemon: { os: null, architecture: null },
      node: {
        status: "NOT_RUN",
        imageId: null,
        repoDigest: null,
        os: null,
        architecture: null,
        version: null,
        failure: "Docker endpoint is not a local unix socket",
      },
      nativeNginx: {
        status: "NOT_RUN",
        imageId: null,
        repoDigest: null,
        os: null,
        architecture: null,
        version: null,
        failure: "Docker endpoint is not a local unix socket",
      },
    },
  );
});

function nativeDocker({
  wrongNodeDigest = false,
  nodeVersion = "v26.8.1\n",
  nginxVersion = "nginx version: nginx/1.31.6\n",
  unavailable = null,
  createFailure = null,
  startTimeout = null,
  cleanupFailure = null,
  daemonOs = "linux",
  daemonArch = "amd64",
  contextEndpoint = "unix:///var/run/docker.sock",
  contextName = "default",
} = {}) {
  const calls = [];
  const options = [];
  let created = 0;
  const nodeDigest = "sha256:" + "b".repeat(64);
  const nginxDigest = "sha256:" + "a".repeat(64);
  const nodeId = "1".repeat(64);
  const nginxId = "2".repeat(64);
  const exec = async (args, commandOptions) => {
    calls.push(args);
    options.push(commandOptions);
    if (args[0] === "context" && args[1] === "show")
      return { code: 0, stdout: `${contextName}\n` };
    if (args[0] === "context" && args[1] === "inspect")
      return {
        code: 0,
        stdout: JSON.stringify([
          { Name: args[2], Endpoints: { docker: { Host: contextEndpoint } } },
        ]),
      };
    const commandIndex = args[0] === "--host" ? 2 : 0;
    const verb = args[commandIndex];
    const commandArgs = args.slice(commandIndex);
    if (verb === "version")
      return {
        code: 0,
        stdout: JSON.stringify({ Os: daemonOs, Arch: daemonArch }),
      };
    if (verb === "image" && commandArgs[1] === "inspect") {
      const service = commandArgs[2].startsWith("node:") ? "node" : "nginx";
      if (unavailable === service) return { code: 1, stdout: "" };
      const digestValue =
        service === "node"
          ? wrongNodeDigest
            ? "sha256:" + "c".repeat(64)
            : nodeDigest
          : nginxDigest;
      const id = service === "node" ? nodeId : nginxId;
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Id: `sha256:${id}`,
            RepoDigests: [`${service}@${digestValue}`],
            Os: "linux",
            Architecture: "amd64",
          },
        ]),
      };
    }
    if (verb === "create") {
      if (createFailure)
        return { code: 125, stdout: "", stderr: createFailure };
      created += 1;
      return { code: 0, stdout: (created === 1 ? nodeId : nginxId) + "\n" };
    }
    if (verb === "start") {
      if (startTimeout === args.at(-1))
        return { code: 124, stdout: "", stderr: "", timedOut: true };
      const isNode = args.at(-1) === nodeId;
      return {
        code: 0,
        stdout: isNode ? nodeVersion : "",
        stderr: isNode ? "" : nginxVersion,
      };
    }
    if (verb === "rm")
      return cleanupFailure ? { code: 1, stdout: "" } : { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  };
  return { calls, options, exec };
}

const dockerVerb = (args) => args[args[0] === "--host" ? 2 : 0];

void test("G00 proves pinned native base images with isolated version-only containers", async (t) => {
  const docker = nativeDocker();
  const data = await fixture({ dockerExec: docker.exec });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  const proof = result.checks.find(
    ({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY",
  );
  assert.equal(proof.status, "PASS");
  assert.equal(proof.facts.actualRuntimeProof.node.version, "26.8.1");
  assert.equal(proof.facts.actualRuntimeProof.nativeNginx.version, "1.31.6");
  assert.equal(
    proof.facts.actualRuntimeProof.node.imageId,
    `sha256:${"1".repeat(64)}`,
  );
  assert.equal(
    proof.facts.actualRuntimeProof.nativeNginx.imageId,
    `sha256:${"2".repeat(64)}`,
  );
  assert.deepEqual(proof.facts.actualRuntimeProof.daemon, {
    os: "linux",
    architecture: "amd64",
  });
  const creates = docker.calls.filter((args) => dockerVerb(args) === "create");
  assert.equal(creates.length, 2);
  for (const args of creates) {
    assert.match(
      args[args.indexOf("--name") + 1],
      /^coffee-launch-[a-z0-9-]+$/,
    );
    assert.ok(args.includes("--network") && args.includes("none"));
    assert.ok(
      args.includes("--read-only") &&
        args.includes("--cap-drop") &&
        args.includes("ALL"),
    );
    assert.ok(
      args.includes("--security-opt") && args.includes("no-new-privileges"),
    );
    assert.ok(
      args.includes("--pids-limit") &&
        args.includes("64") &&
        args.includes("--memory") &&
        args.includes("256m"),
    );
    assert.ok(
      args.includes("--label") &&
        args.some((value) =>
          value.startsWith("com.coffeeorderplatform.launch.run-id="),
        ),
    );
    assert.equal(
      args[args.indexOf("--entrypoint") + 1],
      args.some((value) => value.startsWith("node:")) ? "node" : "nginx",
    );
    const imageIndex = args.findIndex(
      (value) => value.startsWith("node:") || value.startsWith("nginx:"),
    );
    assert.deepEqual(args.slice(imageIndex + 1), [
      imageIndex >= 0 && args[imageIndex].startsWith("node:")
        ? "--version"
        : "-v",
    ]);
    assert.ok(
      !args.some((value) =>
        ["--mount", "--publish", "-p", "--env"].includes(value),
      ),
    );
    assert.ok(
      !args.some((value) => ["sh", "bash", "-c", "/bin/sh"].includes(value)),
    );
  }
  assert.equal(
    docker.calls
      .filter((args) =>
        ["image", "create", "start", "container", "rm", "version"].includes(
          args[args[0] === "--host" ? 2 : 0],
        ),
      )
      .every(
        (args) =>
          args.slice(0, 2).join(" ") === "--host unix:///var/run/docker.sock",
      ),
    true,
  );
  assert.equal(
    docker.calls.filter((args) => dockerVerb(args) === "rm").length,
    2,
  );
  assert.equal(
    docker.calls.some((args) => args[args[0] === "--host" ? 2 : 0] === "pull"),
    false,
  );
  assert.equal(
    docker.calls
      .filter((args) => args[args[0] === "--host" ? 2 : 0] === "start")
      .every((args) => args.includes("--attach")),
    true,
  );
  assert.equal(
    docker.options.every(
      ({ timeoutMs }) => timeoutMs === 30_000 || timeoutMs === 60_000,
    ),
    true,
  );
  assert.equal(
    docker.options.every(({ outputLimit }) => outputLimit === 1024 * 1024),
    true,
  );
  assert.equal(
    docker.options[
      docker.calls.findIndex(
        (args) => args[args[0] === "--host" ? 2 : 0] === "start",
      )
    ].captureStderr,
    true,
  );
  assert.equal(
    docker.options.every(({ env }) =>
      [
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ].every((name) => env?.[name] === undefined),
    ),
    true,
  );
  assert.deepEqual(
    docker.calls.find(
      (args) => args[args[0] === "--host" ? 2 : 0] === "version",
    ),
    [
      "--host",
      "unix:///var/run/docker.sock",
      "version",
      "--format",
      "{{json .Server}}",
    ],
  );
});

void test("G00 rejects a remote or emulated Docker daemon architecture", async (t) => {
  const docker = nativeDocker({ daemonArch: "arm64" });
  const data = await fixture({ dockerExec: docker.exec });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
  });
  const proof = result.checks.find(
    ({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY",
  );
  assert.equal(proof.status, "FAIL");
  assert.deepEqual(proof.facts.actualRuntimeProof.daemon, {
    os: "linux",
    architecture: "arm64",
  });
  assert.equal(
    docker.calls.some((args) => args[args[0] === "--host" ? 2 : 0] === "image"),
    false,
  );
});

void test("G00 refuses remote Docker endpoints before image or container operations", async (t) => {
  const cases = [
    {
      docker: nativeDocker(),
      env: { DOCKER_HOST: "tcp://remote.example:2376" },
    },
    {
      docker: nativeDocker({
        contextEndpoint: "ssh://remote.example",
        contextName: "remote",
      }),
      env: { DOCKER_CONTEXT: "remote" },
    },
    {
      docker: nativeDocker({ contextEndpoint: "tcp://remote.example:2376" }),
      env: {},
    },
  ];
  for (const { docker, env } of cases) {
    const data = await fixture({ dockerExec: docker.exec });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const result = await runPreflight(data.context, {
      cwd: data.root,
      execFile: data.execFile,
      env,
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
    });
    const proof = result.checks.find(
      ({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY",
    );
    assert.equal(proof.status, "FAIL");
    assert.equal(proof.facts.actualRuntimeProof.endpointKind, "unsupported");
    assert.equal(
      JSON.stringify(proof.facts.actualRuntimeProof).includes("remote.example"),
      false,
    );
    assert.equal(
      docker.calls.some((args) =>
        ["create", "start", "rm", "version", "image"].includes(
          args[args[0] === "--host" ? 2 : 0],
        ),
      ),
      false,
    );
  }
});

void test("G00 rejects mismatched native image digest or runtime version", async (t) => {
  for (const docker of [
    nativeDocker({ wrongNodeDigest: true }),
    nativeDocker({ nodeVersion: "v99.0.0\n" }),
  ]) {
    const data = await fixture({ dockerExec: docker.exec });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const result = await runPreflight(data.context, {
      cwd: data.root,
      execFile: data.execFile,
      env: {},
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
    });
    assert.equal(
      result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY")
        .status,
      "FAIL",
    );
    assert.equal(
      docker.calls.filter((args) => dockerVerb(args) === "rm").length,
      docker.calls.filter((args) => dockerVerb(args) === "create").length,
    );
  }
});

void test("G00 leaves missing-image and colliding-name containers untouched", async (t) => {
  const unavailable = nativeDocker({ unavailable: "node" });
  const collision = nativeDocker({
    createFailure: "container name is already in use",
  });
  for (const [docker, expectedRemovals] of [
    [unavailable, 1],
    [collision, 0],
  ]) {
    const data = await fixture({ dockerExec: docker.exec });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const result = await runPreflight(data.context, {
      cwd: data.root,
      execFile: data.execFile,
      env: {},
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
    });
    assert.equal(
      result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY")
        .status,
      "FAIL",
    );
    assert.equal(
      docker.calls.filter((args) => dockerVerb(args) === "rm").length,
      expectedRemovals,
    );
  }
});

void test("G00 cleans up a timed-out version probe and fails on cleanup errors", async (t) => {
  const timedOut = nativeDocker({ startTimeout: "1".repeat(64) });
  const cleanupFailed = nativeDocker({ cleanupFailure: true });
  for (const docker of [timedOut, cleanupFailed]) {
    const data = await fixture({ dockerExec: docker.exec });
    t.after(() => rm(data.root, { recursive: true, force: true }));
    const result = await runPreflight(data.context, {
      cwd: data.root,
      execFile: data.execFile,
      env: {},
      yamlLoad: yaml.load,
      yamlVersion: "4.2.0",
      expectedGates: EXPECTED_GATES,
    });
    assert.equal(
      result.checks.find(({ id }) => id === "NATIVE_IMAGE_RUNTIME_IDENTITY")
        .status,
      "FAIL",
    );
    assert.equal(
      docker.calls.filter((args) => dockerVerb(args) === "rm").length,
      2,
    );
  }
});

void test("G00 rejects a repeated GitHub pagination cursor", async (t) => {
  const data = await fixture({ repeatIssue12Cursor: true });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(
    result.checks.find(({ id }) => id === "GITHUB_PREDECESSORS").status,
    "FAIL",
  );
  assert.equal(
    result.checks
      .find(({ id }) => id === "GITHUB_PREDECESSORS")
      .facts.failures.find(({ number }) => number === 12).error,
    "GitHub pagination cursor is invalid",
  );
});

void test("G00 fails when an exact matrix script is absent", async (t) => {
  const missingScriptName = "test:unit";
  const data = await fixture({ missingScriptName });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  const scriptsCheck = result.checks.find(
    ({ id }) => id === "EXACT_GATE_SCRIPTS",
  );
  assert.equal(scriptsCheck.status, "FAIL");
  assert.deepEqual(scriptsCheck.facts.missingScriptNames, [missingScriptName]);
});

void test("G00 rejects missing consumers while allowing an empty consumers array", async (t) => {
  const data = await fixture({
    missingConsumersIssue: 5,
    emptyConsumersIssue: 7,
  });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_7").status,
    "PASS",
  );
  const missing = result.checks.find(({ id }) => id === "HANDOFF_5");
  assert.equal(missing.status, "FAIL");
  assert.match(
    missing.facts.coverage,
    /missing acceptedMergeCommit\/hash\/consumers/,
  );
});

void test("G00 does not infer legacy handoff proof and rejects a missing accepted base", async (t) => {
  const data = await fixture({ legacyIssue: 3, missingBase: true });
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const result = await runPreflight(data.context, {
    cwd: data.root,
    execFile: data.execFile,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  });
  assert.equal(result.status, "FAIL");
  assert.equal(
    result.checks.find(({ id }) => id === "ACCEPTED_BASE").status,
    "FAIL",
  );
  assert.match(
    result.checks.find(({ id }) => id === "HANDOFF_3").facts.coverage,
    /historical proof not inferred/,
  );
  assert.equal(
    result.checks.find(({ id }) => id === "HANDOFF_4").status,
    "PASS",
  );
});

void test("G00 source bootstrap permits only untracked evidence under the current run", async (t) => {
  const data = await fixture();
  t.after(() => rm(data.root, { recursive: true, force: true }));
  const currentRunEvidence = [
    `?? evidence/launch/${data.context.runId}/context.json`,
    `?? evidence/launch/${data.context.runId}/environment.json`,
    `?? evidence/launch/${data.context.runId}/run-result.json`,
    `?? evidence/launch/${data.context.runId}/gates/G00_PREFLIGHT/stdout.log`,
    `?? evidence/launch/${data.context.runId}/gates/G00_PREFLIGHT/stderr.log`,
  ].join("\n");
  const dependencies = {
    cwd: data.root,
    env: {},
    yamlLoad: yaml.load,
    yamlVersion: "4.2.0",
    expectedGates: EXPECTED_GATES,
    now: () => "2026-10-23T12:00:00.000Z",
  };
  const allowed = await runPreflight(data.context, {
    ...dependencies,
    execFile: withSourceStatus(data.execFile, currentRunEvidence),
  });
  assert.equal(
    allowed.checks.find(({ id }) => id === "SOURCE_TOOLING_BOOTSTRAP").status,
    "PASS",
  );

  const rejectedStatuses = [
    "?? unrelated.txt",
    `?? evidence/launch/${data.context.runId}-other/context.json`,
    " M base.txt",
  ];
  for (const sourceStatus of rejectedStatuses) {
    const result = await runPreflight(data.context, {
      ...dependencies,
      execFile: withSourceStatus(data.execFile, sourceStatus),
    });
    assert.equal(
      result.checks.find(({ id }) => id === "SOURCE_TOOLING_BOOTSTRAP").status,
      "FAIL",
      sourceStatus,
    );
  }
});

void test("G00 CLI refuses a symlinked artifacts directory without writing outside evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "coffee-preflight-symlink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = "20261023T120000Z-abcdef0";
  const evidenceDir = join(root, "evidence", "launch", runId);
  const artifactDir = join(evidenceDir, "gates", "G00_PREFLIGHT", "artifacts");
  const outsideDir = join(root, "outside");
  await mkdir(join(evidenceDir, "gates", "G00_PREFLIGHT"), { recursive: true });
  await mkdir(outsideDir);
  await symlink(outsideDir, artifactDir);
  const contextPath = join(evidenceDir, "context.json");
  await writeFile(
    contextPath,
    JSON.stringify({
      schemaVersion: 1,
      runId,
      candidateSha: "invalid",
      sourceRepoRoot: root,
      evidenceDir,
    }),
  );

  const cliPath = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
  const runCli = () =>
    spawnSync(process.execPath, [cliPath], {
      encoding: "utf8",
      env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: contextPath },
    });
  const directoryEscape = runCli();
  assert.equal(directoryEscape.status, 1);
  assert.match(directoryEscape.stderr, /artifact path/);
  const externalArtifact = join(outsideDir, "preflight.json");
  await assert.rejects(access(externalArtifact));

  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await symlink(externalArtifact, join(artifactDir, "preflight.json"));
  const fileEscape = runCli();
  assert.equal(fileEscape.status, 1);
  assert.match(fileEscape.stderr, /безопасно сохранить artifact/);
  await assert.rejects(access(externalArtifact));
});
