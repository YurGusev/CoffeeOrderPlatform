import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLaunchContext } from "../report.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const INTEGRATION_FILES = [
  "tests/database/pool-concurrency-live.test.mjs",
  "tests/kafka/orders-inbox-live.test.mjs",
  "tests/orders/order-store-faults.test.mjs",
  "tests/orders/owner-live.test.mjs",
  "tests/orders/reconciliation-live.test.mjs",
  "tests/catalog-pipeline/pipeline-live.test.mjs",
  "tests/catalog-pipeline/security-live.test.mjs",
];
const RECOVERY_FILES = [
  "tests/kafka/orders-inbox-live.test.mjs",
  "tests/catalog-pipeline/recovery-live.test.mjs",
  "tests/catalog-pipeline/publisher-live.test.mjs",
  "tests/catalog/recovery-live.test.mjs",
  "tests/catalog/activation-crash-live.test.mjs",
  "tests/pricing/pricing-recovery-live.test.mjs",
  "tests/orders/order-store-faults.test.mjs",
  "tests/orders/aroma-preparation-live.test.mjs",
  "tests/aroma/mutation-journal.test.mjs",
  "tests/aroma/observer-live.test.mjs",
  "tests/aroma/convergence-live.test.mjs",
];

export function parseTapSummary(output) {
  const summary = [
    ...output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm),
  ].slice(-6);
  if (summary.length !== 6) return null;
  const counts = Object.fromEntries(
    summary.map(([, name, count]) => [name, Number(count)]),
  );
  if (
    Object.keys(counts).length !== 6 ||
    counts.tests < 1 ||
    counts.pass +
      counts.fail +
      counts.cancelled +
      counts.skipped +
      counts.todo !==
      counts.tests
  )
    return null;
  return counts;
}

export function tapSummaryPassed(counts) {
  return Boolean(
    counts &&
    counts.tests > 0 &&
    counts.pass === counts.tests &&
    counts.fail === 0 &&
    counts.cancelled === 0 &&
    counts.skipped === 0 &&
    counts.todo === 0,
  );
}

async function integrationFiles() {
  const pricingFiles = (await readdir(resolve(ROOT, "tests/pricing")))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `tests/pricing/${name}`);
  if (!pricingFiles.length) throw new Error("G10: no pricing test files found");
  return [
    ...INTEGRATION_FILES.slice(0, 5),
    ...pricingFiles,
    ...INTEGRATION_FILES.slice(5),
  ];
}

function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function run(argv, env) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  printResult(result);
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0)
    throw new Error(
      `${argv.join(" ")} exited ${result.signal ?? result.status}`,
    );
  return result;
}

export async function resolveComposeProjectName(
  contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE,
  executionRoot = ROOT,
) {
  if (contextPath) {
    const { context, candidateRoot } = await validateLaunchContext(contextPath);
    const projectName = `coffee-launch-${context.runId.toLowerCase()}`;
    if (context.resources?.composeProject !== projectName)
      throw new Error(
        "launch context Compose project does not match its run ID",
      );
    if (resolve(executionRoot) !== candidateRoot)
      throw new Error(
        "owner suites require the exact launch candidate checkout",
      );
    return projectName;
  }
  return `coffee-launch-local-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

async function runSuites(files, realtimeOwnerProof = false) {
  const argv = [
    process.execPath,
    "--test",
    "--test-concurrency=1",
    "--test-reporter=tap",
    ...files,
  ];
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    env: {
      ...process.env,
      COFFEE_DB_LIVE_PROOF: "1",
      ...(realtimeOwnerProof ? { COFFEE_REALTIME_OWNER_LIVE_PROOF: "1" } : {}),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  printResult(result);
  if (result.error) throw result.error;
  const counts = parseTapSummary(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.signal || result.status !== 0 || !tapSummaryPassed(counts)) {
    throw new Error(
      `Node test suites did not pass without omissions (signal=${result.signal ?? "none"}, exit=${result.status ?? "unknown"}, summary=${JSON.stringify(counts)})`,
    );
  }
}

export async function runOwnerSuites(kind) {
  if (kind !== "integration" && kind !== "recovery")
    throw new Error("usage: owner-suites.mjs integration|recovery");
  const projectName = await resolveComposeProjectName();
  const files =
    kind === "integration" ? await integrationFiles() : RECOVERY_FILES;
  await runSuites(files, kind === "recovery");
  const proofs =
    kind === "integration"
      ? ["--customer-proof", "--recovery-proof"]
      : ["--recovery-proof"];
  for (const proof of proofs)
    run(
      [
        process.execPath,
        "tools/compose-smoke.mjs",
        proof,
        "--project-name",
        projectName,
      ],
      {},
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runOwnerSuites(process.argv[2]);
  } catch (error) {
    console.error(
      `owner-suites: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
