import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
} from "../../../packages/platform-config/src/launch-database-target.ts";
import { CANONICAL_KAFKA_TOPIC_NAMES } from "../../../packages/platform-config/src/launch-kafka-target.ts";
import {
  assertNoSymlinkPath,
  redactText,
  validateLaunchContext,
} from "../../../scripts/launch-support/launch-context.mjs";
import { EXPECTED_GATES } from "./gate-matrix.generated.mjs";
import { decisive, reportGateStatus } from "./decision.mjs";
import {
  gateLabel,
  gateSlug,
} from "../../../scripts/launch-support/gate-identity.mjs";

export { EXPECTED_GATES };

const SUPPORTED_SCHEMA_VERSIONS = [1, 2];
const DIAGNOSTIC_PROFILES = new Set(["admission", "fast", "diagnostic"]);
const LAUNCH_REPORT_PATH_PATTERN =
  /^docs\/reports\/launch\/\d{8}T\d{6}Z-[0-9a-f]{7}\/ОТЧЁТ\.md$/u;

export function isLaunchReportPath(value) {
  return typeof value === "string" && LAUNCH_REPORT_PATH_PATTERN.test(value);
}

export function validateRunResultContract(result) {
  if (
    !result ||
    !SUPPORTED_SCHEMA_VERSIONS.includes(result.schemaVersion) ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(result.runId ?? "") ||
    !/^[0-9a-f]{40}$/.test(result.candidateSha ?? "") ||
    !/^[0-9a-f]{40}$/.test(result.sourceSha ?? "") ||
    !Array.isArray(result.gates) ||
    result.gates.length !== EXPECTED_GATES.length ||
    (result.schemaVersion === 2 &&
      !["PASS", "FAIL", "NOT_RUN", "SKIPPED_BY_FILTER"].includes(
        result.reportStatus,
      )) ||
    (result.profile !== undefined &&
      !["admission", "fast", "release", "diagnostic"].includes(
        result.profile,
      )) ||
    !["ДОПУСТИТЬ", "НЕ ДОПУСТИТЬ"].includes(result.decision)
  ) {
    throw new Error("Некорректная структура run-result.json");
  }
  for (const [
    index,
    [id, command, timeoutSeconds],
  ] of EXPECTED_GATES.entries()) {
    const gate = result.gates[index];
    if (
      gateSlug(gate?.id) !== id ||
      gate.expectedCommand !== command ||
      gate.timeoutSeconds !== timeoutSeconds ||
      !["PASS", "FAIL", "NOT_RUN", "SKIPPED_BY_FILTER"].includes(gate.status) ||
      (gate.reusedFrom !== undefined &&
        (gate.status !== "PASS" ||
          typeof gate.reusedFrom?.runId !== "string" ||
          !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(gate.reusedFrom.runId) ||
          typeof gate.reusedFrom?.evidenceDir !== "string" ||
          gate.reusedFrom.evidenceDir.length === 0 ||
          (gateSlug(gate.id) === "preflight" &&
            (!/^[0-9a-f]{64}$/u.test(
              gate.reusedFrom?.githubSnapshotSha256 ?? "",
            ) ||
              !/^[0-9a-f]{64}$/u.test(
                gate.reusedFrom?.preflightArtifactSha256 ?? "",
              ))))) ||
      !Array.isArray(gate.runs) ||
      !Array.isArray(gate.artifacts) ||
      !Number.isInteger(gate.durationMs) ||
      gate.durationMs < 0
    ) {
      throw new Error(`Некорректная запись ${id} в run-result.json`);
    }
    for (const run of gate.runs) {
      if (
        !Array.isArray(run.argv) ||
        run.argv.length === 0 ||
        typeof run.cwd !== "string" ||
        !Number.isInteger(run.timeoutMs) ||
        run.timeoutMs < 1 ||
        !Number.isInteger(run.durationMs) ||
        run.durationMs < 0 ||
        typeof run.timedOut !== "boolean" ||
        typeof run.outputLimitExceeded !== "boolean" ||
        !(run.exitCode === null || Number.isInteger(run.exitCode)) ||
        !(
          run.peakRssBytes === null ||
          (Number.isInteger(run.peakRssBytes) && run.peakRssBytes >= 0)
        ) ||
        !Array.isArray(run.artifacts)
      )
        throw new Error(`Некорректный command record ${id}`);
    }
  }
  if (
    result.schemaVersion === 2 &&
    result.reportStatus !== result.gates[EXPECTED_GATES.length - 1]?.status
  )
    throw new Error("reportStatus не совпадает со статусом report");
  if (
    result.environment.githubSnapshotSha256 !== undefined &&
    result.environment.githubSnapshotSha256 !== null &&
    !/^[0-9a-f]{64}$/u.test(result.environment.githubSnapshotSha256)
  )
    throw new Error("Некорректный githubSnapshotSha256 в environment");
  if (
    result.gates[0].reusedFrom !== undefined &&
    result.gates[0].status === "PASS" &&
    (result.environment.githubSnapshotSha256 !==
      result.gates[0].reusedFrom.githubSnapshotSha256 ||
      result.gates[0].reusedFrom.preflightArtifactSha256 === undefined)
  )
    throw new Error("reused preflight не связан с GitHub-снимком run-result");
  const environment = result.environment;
  let expectedDatabases;
  try {
    expectedDatabases = CANONICAL_DATABASE_OWNERS.map((owner) =>
      deriveLaunchDatabaseName(
        { runId: result.runId, candidateSha: result.candidateSha },
        owner,
      ),
    );
  } catch {
    throw new Error("Некорректная launch identity для run-result.json");
  }
  if (
    !environment ||
    environment.runId !== result.runId ||
    environment.dirty !== false ||
    typeof environment.candidatePath !== "string" ||
    !/^[0-9a-f]{40}$/.test(environment.treeSha ?? "") ||
    !environment.toolVersions ||
    !(
      environment.imageDigests === null ||
      Array.isArray(environment.imageDigests)
    ) ||
    environment.resources?.composeProject?.name !==
      `coffee-launch-${result.runId.toLowerCase()}` ||
    environment.resources.composeProject.created !== false ||
    JSON.stringify(
      environment.resources?.databases?.map((item) => item.name),
    ) !== JSON.stringify(expectedDatabases) ||
    environment.resources.databases.some((item) => item.created !== false) ||
    environment.resources.kafkaPrefix?.name !== result.runId ||
    environment.resources.kafkaPrefix.created !== false
  ) {
    throw new Error(
      "Некорректные environment fields или run-id resources в run-result.json",
    );
  }
  return result;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function splitExactCommand(command) {
  if (
    typeof command !== "string" ||
    !command.trim() ||
    command.includes("\n") ||
    command.includes("\r") ||
    command.includes(";")
  )
    throw new Error("Недопустимая команда matrix");
  return command.split(" && ").map((part) => {
    const tokens = part.match(/(?:[^\s"]+|"[^"\n]*")+/g) ?? [];
    const argv = tokens.map((token) =>
      token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token,
    );
    if (
      !argv.length ||
      argv.some(
        (arg) =>
          /[|;&<>`]/.test(arg) || arg.includes("$(") || arg.includes("${"),
      )
    )
      throw new Error("Команда содержит недопустимое shell-управление");
    return argv;
  });
}

export function environmentProofErrors(environment) {
  const errors = [];
  for (const key of [
    "configSha256",
    "encryptedSecretsSha256",
    "toolchainVersionsSha256",
    "lockfileSha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(environment?.[key] ?? ""))
      errors.push(`Нет SHA-256 environment proof: ${key}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(environment?.nodeImageDigest ?? ""))
    errors.push("Не собран runtime digest pinned Node image");
  if (
    !Array.isArray(environment?.imageDigests) ||
    environment.imageDigests.length !== 15 ||
    environment.imageDigests.some(
      (digest) => !/^sha256:[0-9a-f]{64}$/.test(digest),
    )
  ) {
    errors.push("Не собраны 15 фактических runtime image digests");
  }
  for (const [tool, version] of Object.entries(environment?.toolVersions ?? {}))
    if (typeof version !== "string" || !version.trim())
      errors.push(`Версия инструмента не собрана: ${tool}`);
  return errors;
}

function exactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sortedUniqueNames(value) {
  return (
    Array.isArray(value) &&
    value.every(
      (name) => typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name),
    ) &&
    JSON.stringify(value) ===
      JSON.stringify(
        [...new Set(value)].sort((left, right) =>
          left.localeCompare(right, "en"),
        ),
      )
  );
}

export function validateKafkaNamespaceInventory(
  inventory,
  { runId, projectName, expectedTopics, expectedGroups },
) {
  const registryTopics = CANONICAL_KAFKA_TOPIC_NAMES.flatMap((name) => [
    name,
    `${name}.dlq`,
  ])
    .map((name) => `${runId}.${name}`)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    !exactObjectKeys(inventory, [
      "schemaVersion",
      "mode",
      "runId",
      "projectName",
      "topics",
      "groups",
    ]) ||
    inventory.schemaVersion !== 1 ||
    inventory.mode !== "launch-namespace" ||
    inventory.runId !== runId ||
    inventory.projectName !== projectName ||
    !exactObjectKeys(inventory.topics, [
      "expectedPhysical",
      "actual",
      "missing",
      "canonicalNamesAbsent",
    ]) ||
    !exactObjectKeys(inventory.groups, [
      "expectedPhysical",
      "actual",
      "missing",
      "canonicalNamesAbsent",
    ]) ||
    JSON.stringify(expectedTopics) !== JSON.stringify(registryTopics)
  ) {
    throw new Error(
      "Kafka namespace inventory identity or closed schema is invalid",
    );
  }
  for (const [kind, section, expected] of [
    ["topic", inventory.topics, expectedTopics],
    ["group", inventory.groups, expectedGroups],
  ]) {
    if (
      !sortedUniqueNames(expected) ||
      expected.some((name) => !name.startsWith(`${runId}.`)) ||
      !sortedUniqueNames(section.expectedPhysical) ||
      JSON.stringify(section.expectedPhysical) !== JSON.stringify(expected) ||
      !sortedUniqueNames(section.actual) ||
      !Array.isArray(section.missing) ||
      section.missing.length !== 0 ||
      JSON.stringify(section.missing) !==
        JSON.stringify(
          expected.filter((name) => !section.actual.includes(name)),
        ) ||
      section.canonicalNamesAbsent !== true
    ) {
      throw new Error(
        `Kafka namespace ${kind} inventory does not match admitted physical claims`,
      );
    }
    const canonicalNames = expected.map((name) => name.slice(runId.length + 1));
    if (section.actual.some((name) => canonicalNames.includes(name)))
      throw new Error(
        `Kafka namespace ${kind} inventory contains canonical names`,
      );
  }
  return inventory;
}

async function listFiles(path, current = path) {
  const result = [];
  for (const entry of (await readdir(current, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name, "en"),
  )) {
    const target = join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(path, target)));
    else if (entry.isFile()) result.push(target);
    else
      throw new Error(
        `Evidence содержит symlink или special file: ${relative(path, target)}`,
      );
  }
  return result;
}

async function fileDigest(path, root) {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    sizeBytes += chunk.length;
  }
  return {
    path: relative(root, path).split("\\").join("/"),
    sha256: hash.digest("hex"),
    sizeBytes,
  };
}

async function validateEvidence(
  evidenceDir,
  result,
  sourceRoot,
  { publishReport = true } = {},
) {
  const errors = [];
  let fileList = [];
  try {
    fileList = await listFiles(evidenceDir);
  } catch (error) {
    errors.push(redactText(error.message));
  }
  const files = new Set(fileList);
  const resultPath = join(evidenceDir, "run-result.json");
  for (const gate of result.gates) {
    const gateDir = join(evidenceDir, "gates", gate.id);
    const gateResult = join(gateDir, "result.json");
    for (const required of [
      gateResult,
      join(gateDir, "stdout.log"),
      join(gateDir, "stderr.log"),
    ]) {
      if (!files.has(required)) {
        // Compound commands use numbered logs; an absent default log is valid only when numbered logs exist.
        if (
          required.endsWith("stdout.log") &&
          (await readdir(gateDir)).some((name) =>
            /^stdout-\d+\.log$/.test(name),
          )
        )
          continue;
        if (
          required.endsWith("stderr.log") &&
          (await readdir(gateDir)).some((name) =>
            /^stderr-\d+\.log$/.test(name),
          )
        )
          continue;
        errors.push(
          `Отсутствует обязательный файл ${relative(evidenceDir, required)}`,
        );
      }
    }
    try {
      const recordedGate = JSON.parse(await readFile(gateResult, "utf8"));
      if (JSON.stringify(recordedGate) !== JSON.stringify(gate))
        errors.push(`${gate.id}: result.json не совпадает с run-result.json`);
    } catch {
      errors.push(`${gate.id}: result.json отсутствует или повреждён`);
    }
    let expectedArgvs;
    try {
      expectedArgvs = splitExactCommand(gate.expectedCommand);
    } catch {
      errors.push(
        `${gate.id}: expectedCommand не разбирается как утверждённый argv`,
      );
      expectedArgvs = [];
    }
    if (
      gate.runs.length > expectedArgvs.length ||
      gate.runs.some(
        (run, index) =>
          JSON.stringify(run.argv) !== JSON.stringify(expectedArgvs[index]),
      )
    ) {
      errors.push(
        `${gate.id}: фактический argv не соответствует exact command`,
      );
    }
    if (
      gate.status === "PASS" &&
      gate.reusedFrom !== undefined &&
      gate.runs.length !== 0
    )
      errors.push(`${gate.id}: reused PASS не должен иметь command runs`);
    if (
      gate.status === "PASS" &&
      gate.reusedFrom === undefined &&
      gate.runs.length !== expectedArgvs.length
    )
      errors.push(`${gate.id}: PASS без полного набора argv`);
    for (const artifact of gate.artifacts) {
      const path = resolve(artifact.path);
      if (!path.startsWith(`${evidenceDir}/`) || !files.has(path)) {
        errors.push(
          `Нет артефакта или path вне evidence tree: ${artifact.path}`,
        );
        continue;
      }
      const actual = await fileDigest(path, evidenceDir);
      if (
        actual.sha256 !== artifact.sha256 ||
        actual.sizeBytes !== artifact.sizeBytes
      )
        errors.push(`SHA-256 не совпал: ${artifact.path}`);
    }
    if (
      gate.status === "PASS" &&
      gate.reusedFrom === undefined &&
      gate.runs.some(
        (run) =>
          run.exitCode !== 0 ||
          run.timedOut ||
          run.outputLimitExceeded ||
          run.peakRssBytes === null,
      )
    )
      errors.push(
        `${gate.id}: PASS не подтверждён командами/timeout/output limit/peak RSS`,
      );
    if (gate.runs.some((run) => run.cwd !== result.environment.candidatePath))
      errors.push(`${gate.id}: команда выполнена вне candidate checkout`);
  }
  const commandsPath = join(evidenceDir, "commands.ndjson");
  if (!files.has(commandsPath)) errors.push("Отсутствует commands.ndjson");
  else {
    const lines = (await readFile(commandsPath, "utf8"))
      .split(/\n/)
      .filter(Boolean);
    const logged = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          errors.push("commands.ndjson содержит некорректную JSON-строку");
          return null;
        }
      })
      .filter(Boolean);
    const actualRuns = result.gates.flatMap((gate) =>
      gate.runs.map((run) => ({ gateId: gate.id, ...run })),
    );
    if (JSON.stringify(actualRuns) !== JSON.stringify(logged))
      errors.push(
        "commands.ndjson не соответствует run-result.json или exact argv",
      );
  }
  if (
    result.gates.some(
      (gate) => gateSlug(gate.id) !== "report" && gate.status !== "PASS",
    ) &&
    result.decision === "ДОПУСТИТЬ"
  )
    errors.push("Решение допускает run с непрошедшим рабочим gate");
  if (
    result.decision === "ДОПУСТИТЬ" &&
    environmentProofErrors(result.environment).length
  )
    errors.push("Решение допускает неполное environment proof");
  const preflightPath = join(
    evidenceDir,
    "gates",
    result.gates[0].id,
    "artifacts",
    "preflight.json",
  );
  let preflight = null;
  if (
    result.gates[0].status === "PASS" &&
    result.gates[0].reusedFrom === undefined
  ) {
    try {
      preflight = JSON.parse(await readFile(preflightPath, "utf8"));
      if (
        preflight.status !== "PASS" ||
        preflight.candidateSha !== result.candidateSha ||
        preflight.runId !== result.runId ||
        preflight.checks.some((check) => check.status !== "PASS")
      ) {
        errors.push(
          "preflight artifact семантически не совпадает с результатом",
        );
      }
    } catch {
      errors.push("Нет валидного preflight artifact для PASS");
    }
  }
  if (result.gates[13].status === "PASS") {
    try {
      const context = JSON.parse(
        await readFile(join(evidenceDir, "context.json"), "utf8"),
      );
      const kafkaPlan = preflight?.checks?.find(
        (check) => check.id === "KAFKA_NAMESPACE_PLAN",
      );
      const expectedTopics = kafkaPlan?.facts?.expectedPhysical?.topics;
      const expectedGroups = kafkaPlan?.facts?.expectedPhysical?.groups;
      if (
        context.runId !== result.runId ||
        context.candidateSha !== result.candidateSha ||
        context.baseConfigSha256 !== result.environment.configSha256 ||
        kafkaPlan?.status !== "PASS" ||
        kafkaPlan.facts.committedFlagEnabled !== true ||
        kafkaPlan.facts.baseConfigShaMatchesContext !== true ||
        kafkaPlan.facts.baseConfigSha256 !== context.baseConfigSha256 ||
        kafkaPlan.facts.candidateContextValid !== true
      ) {
        throw new Error(
          "preflight Kafka plan does not bind this run, candidate and base config",
        );
      }
      const inventoryPath = join(
        evidenceDir,
        "gates",
        result.gates[13].id,
        "artifacts/kafka-namespace-inventory.json",
      );
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
      if (
        !result.gates[13].artifacts.some(
          (artifact) => resolve(artifact.path) === inventoryPath,
        )
      )
        throw new Error("compose inventory is not listed as a gate artifact");
      validateKafkaNamespaceInventory(inventory, {
        runId: context.runId,
        projectName: context.resources?.composeProject,
        expectedTopics,
        expectedGroups,
      });
    } catch {
      errors.push(
        "Нет валидного compose Kafka namespace inventory, связанного с preflight plan/context",
      );
    }
  }
  const g19 = result.gates[19];
  if (
    g19.status === "PASS" &&
    (g19.runs.length !== 1 ||
      JSON.stringify(g19.runs[0]?.argv) !==
        JSON.stringify(["pnpm", "launch:verify:report"]) ||
      g19.runs[0]?.exitCode !== 0 ||
      g19.runs[0]?.timedOut ||
      g19.runs[0]?.outputLimitExceeded)
  ) {
    errors.push(
      "report PASS не подтверждён единственным exact report argv с exit 0",
    );
  }
  if (g19.status === "PASS" && publishReport) {
    const reportPath = join(
      sourceRoot,
      "docs/reports/launch",
      result.runId,
      "ОТЧЁТ.md",
    );
    const decisionPath = join(evidenceDir, "decision.json");
    try {
      const decision = JSON.parse(await readFile(decisionPath, "utf8"));
      const report = await readFile(reportPath, "utf8");
      if (
        decision.runId !== result.runId ||
        decision.candidateSha !== result.candidateSha ||
        decision.decision !== result.decision ||
        !report.startsWith(`# ${result.decision}\n`)
      )
        errors.push("report/decision identity or decision mismatch");
    } catch {
      errors.push("report или decision.json отсутствует");
    }
  }
  if (!files.has(resultPath)) errors.push("Отсутствует run-result.json");
  return errors;
}

export async function writeDefects(evidenceDir, sourceRoot, result) {
  const defects = [];
  for (const gate of result.gates.filter((entry) => entry.status === "FAIL")) {
    const checkFailures = [];
    if (gateSlug(gate.id) === "preflight") {
      try {
        const preflight = JSON.parse(
          await readFile(
            join(evidenceDir, "gates", gate.id, "artifacts/preflight.json"),
            "utf8",
          ),
        );
        for (const check of preflight.checks ?? [])
          if (check.status !== "PASS") checkFailures.push(check);
      } catch {
        /* the generic gate defect below records a missing artifact */
      }
    }
    const groups = checkFailures.length
      ? checkFailures
      : [
          {
            id: gate.id,
            status: "FAIL",
            sanitizedFacts: gate.reason || "Missing machine evidence",
          },
        ];
    for (const [index, check] of groups.entries()) {
      const checkId =
        String(check.id ?? gate.id)
          .replace(/[^A-Za-z0-9_-]/g, "-")
          .slice(0, 48) || gate.id;
      const defectId = `DEF-${gate.id}-${checkId}-${result.runId}`;
      const facts = redactText(
        JSON.stringify(
          check.sanitizedFacts ??
            check.facts ??
            check.reason ??
            gate.reason ??
            "",
        ),
      ).slice(0, 1200);
      const defect = {
        defectId,
        gateId: gate.id,
        blockerId: checkId,
        runId: result.runId,
        candidateSha: result.candidateSha,
        severity: "P2",
        ownerArea: gate.id,
        exactCommand: gate.expectedCommand,
        expected: "Mandatory gate проходит с проверяемым evidence",
        actual:
          facts ||
          redactText(
            gate.reason || `exit=${gate.runs.at(-1)?.exitCode ?? "unknown"}`,
          ),
        evidence: `evidence/launch/${result.runId}/gates/${gate.id}/`,
        reproduction: gate.expectedCommand,
        impact: "Launch gate закрыт до отдельного исправления и нового run-id.",
        acceptanceTest: `Повторить ${gate.id} на новом candidate SHA после fix PR.`,
      };
      const fileName = index === 0 ? "defect.json" : `defect-${checkId}.json`;
      const defectPath = join(
        evidenceDir,
        "gates",
        gate.id,
        "artifacts",
        fileName,
      );
      await writeRegularNoFollow(evidenceDir, defectPath, json(defect));
      defects.push({
        gateId: gate.id,
        defectId,
        blockerId: checkId,
        path: relative(sourceRoot, defectPath).split("\\").join("/"),
      });
    }
  }
  await writeRegularNoFollow(
    evidenceDir,
    join(evidenceDir, "defects.json"),
    json(
      defects.map(({ gateId, defectId, blockerId }) => ({
        gateId,
        defectId,
        blockerId,
      })),
    ),
  );
  return defects;
}

export async function validateChecksumManifest(
  evidenceDir,
  sourceRoot,
  runId,
  { publishReport = true } = {},
) {
  evidenceDir = resolve(evidenceDir);
  sourceRoot = resolve(sourceRoot);
  if (
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(runId) ||
    resolve(sourceRoot, "evidence/launch", runId) !== evidenceDir
  ) {
    throw new Error(
      "Checksum evidence scope не совпадает с source root/run ID",
    );
  }
  await assertNoSymlinkPath(sourceRoot, evidenceDir);
  const manifestPath = join(evidenceDir, "checksums.sha256");
  const reportPath = join(sourceRoot, "docs/reports/launch", runId, "ОТЧЁТ.md");
  const evidenceFiles = await listFiles(evidenceDir);
  const expectedPaths = evidenceFiles.filter((file) => file !== manifestPath);
  if (publishReport) expectedPaths.push(reportPath);
  const rows = [];
  for (const file of expectedPaths) {
    const resolved = resolve(file);
    if (!resolved.startsWith(`${sourceRoot}/`))
      throw new Error("Manifest target escapes source root");
    let current = sourceRoot;
    for (const component of relative(sourceRoot, resolved).split(/[\\/]/)) {
      current = join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error(
          `Symlink запрещён в checksum target: ${relative(sourceRoot, current)}`,
        );
    }
    const info = await lstat(resolved);
    if (!info.isFile())
      throw new Error(
        `Checksum target не regular file: ${relative(sourceRoot, resolved)}`,
      );
    rows.push(await fileDigest(resolved, sourceRoot));
  }
  rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const expectedText = `${rows.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`;
  const actualText = await readFile(manifestPath, "utf8");
  if (actualText !== expectedText)
    throw new Error(
      "checksums.sha256 не покрывает точный набор файлов либо содержит duplicate/path/hash tampering",
    );
  return rows;
}

async function preflightFindings(evidenceDir, gateId, reusedFrom = null) {
  try {
    const root = reusedFrom
      ? resolve(ROOT, reusedFrom.evidenceDir)
      : evidenceDir;
    const value = JSON.parse(
      await readFile(
        join(root, "gates", gateId, "artifacts/preflight.json"),
        "utf8",
      ),
    );
    const failures = (value.checks ?? []).filter(
      (check) => check.status !== "PASS",
    );
    return {
      status: value.status,
      checks: failures.map(
        (check) =>
          `${redactText(check.id)}: ${redactText(JSON.stringify(check.sanitizedFacts ?? check.facts ?? "нет facts")).slice(0, 500)}`,
      ),
    };
  } catch {
    return { status: "NOT_RUN/нет артефакта", checks: [] };
  }
}

async function sandboxFingerprint(evidenceDir, gate) {
  if (gate.status !== "PASS") return null;
  for (const artifact of gate.artifacts) {
    if (
      !/sandbox|aroma/i.test(artifact.path) ||
      !artifact.path.endsWith(".json")
    )
      continue;
    try {
      const value = JSON.parse(await readFile(artifact.path, "utf8"));
      const stack = [value];
      while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== "object") continue;
        for (const [key, entry] of Object.entries(current)) {
          if (
            ["accountFingerprint", "sandboxAccountFingerprint"].includes(key) &&
            typeof entry === "string"
          )
            return redactText(entry).slice(0, 200);
          if (entry && typeof entry === "object") stack.push(entry);
        }
      }
    } catch {
      /* the artifact is linked below and remains a gate validation concern */
    }
  }
  return null;
}

function reportMarkdown(
  result,
  evidenceRows,
  defects,
  errors,
  environmentErrors,
  preflight,
  fingerprint,
) {
  const lines = [
    `# ${result.decision}`,
    "",
    `- Run ID: \`${result.runId}\``,
    `- Профиль запуска: \`${result.profile ?? "release (legacy)"}\``,
    `- Candidate SHA: \`${result.candidateSha}\``,
    `- Source SHA: \`${result.sourceSha}\``,
    `- Время UTC: ${result.startedAt} — ${result.endedAt}`,
    `- Окружение: ${result.environment.platform} ${result.environment.osRelease}/${result.environment.arch}; CPU ${result.environment.cpuCount}; RAM ${result.environment.memoryBytes} байт; Node ${result.environment.node}; pnpm ${result.environment.pnpm}; timezone ${result.environment.timezone}`,
    `- Tool versions: ${Object.entries(result.environment.toolVersions)
      .map(([name, version]) => `${name}=${version ?? "недоступен"}`)
      .join(", ")}`,
    `- Git tree SHA: \`${result.environment.treeSha}\`; SHA-256 config/pins/lock: \`${result.environment.configSha256 ?? "не собран"}\` / \`${result.environment.toolchainVersionsSha256 ?? "не собран"}\` / \`${result.environment.lockfileSha256 ?? "не собран"}\`; encrypted secrets file: \`${result.environment.encryptedSecretsSha256 ?? "не собран"}\``,
    `- Runtime images: Node image ${result.environment.nodeImageDigest ?? "NOT_COLLECTED"}; остальные digests ${result.environment.imageDigests?.join(", ") || "NOT_COLLECTED"}`,
    "",
    "| Gate | Статус | Команда | Длительность, с | Причина |",
    "|---|---|---|---:|---|",
  ];
  for (const [index, gate] of result.gates.entries()) {
    const duration = (gate.durationMs / 1000).toFixed(3);
    const label = gateLabel(index, gateSlug(gate.id) ?? gate.id);
    lines.push(
      `| ${label} | ${gate.status} | \`${gate.expectedCommand.replaceAll("|", "\\|")}\` | ${duration} | ${redactText(
        gate.reason || "—",
      )
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ")} |`,
    );
  }
  lines.push(
    "",
    "## Предварительная проверка preflight",
    "",
    `Статус: ${preflight.status}. Артефакт: [preflight.json](../../../../evidence/launch/${result.gates[0].reusedFrom?.runId ?? result.runId}/gates/${result.gates[0].id}/artifacts/preflight.json).`,
  );
  if (preflight.checks.length)
    lines.push(...preflight.checks.map((check) => `- ${check}`));
  else if (preflight.status !== "PASS")
    lines.push(
      "Проваленные проверки не представлены: preflight artifact отсутствует или невалиден.",
    );
  else lines.push("Все проверки preflight имеют PASS.");
  lines.push(
    "",
    "## Sandbox fingerprint",
    "",
    `aroma_sandbox: ${result.gates[16].status}; account fingerprint: ${fingerprint ?? "нет доказательства в принятом evidence"}. Credentials не включаются в отчёт.`,
  );
  lines.push(
    "",
    "## Backup RPO и restore time",
    "",
    `backup_restore: ${result.gates[17].status}; требование: RPO на момент dump, restore не более 10 минут для каждой БД и 30 минут суммарно. Фактические измерения: ${result.gates[17].status === "NOT_RUN" ? "NOT_RUN — доказательства нет" : "см. связанные backup_restore artifacts; runner не подменяет отсутствующие измерения расчетными значениями"}.`,
  );
  lines.push(
    "",
    "## Observability и rollback",
    "",
    `observability: ${result.gates[14].status} — ${redactText(result.gates[14].reason || "нет причины отказа")}.`,
    `rollback: ${result.gates[18].status} — ${redactText(result.gates[18].reason || "нет причины отказа")}.`,
  );
  lines.push(
    "",
    "## Evidence links",
    "",
    `[Полное evidence дерево](../../../../evidence/launch/${result.runId}/), [commands.ndjson](../../../../evidence/launch/${result.runId}/commands.ndjson), [handoff.yaml](../../../../evidence/launch/${result.runId}/handoff.yaml), [checksums.sha256](../../../../evidence/launch/${result.runId}/checksums.sha256).`,
    "",
  );
  lines.push(
    "## Дефекты",
    "",
    defects.length
      ? "| Gate | Blocker | Локальный defect | Evidence |"
      : "Дефектов с результатом FAIL нет.",
    "",
  );
  if (defects.length) {
    lines.push("|---|---|---|");
    for (const defect of defects)
      lines.push(
        `| ${defect.gateId} | ${defect.blockerId} | [${defect.defectId}](../../../../${defect.path}) | \`${defect.path}\` |`,
      );
  }
  lines.push(
    "",
    "## Ошибки проверки evidence",
    "",
    errors.length
      ? errors.map((error) => `- ${redactText(error)}`).join("\n")
      : "Ошибок проверки evidence нет.",
    "",
    "## Хэши артефактов",
    "",
    "Отчёт не хэширует сам себя; его SHA-256 включён в `checksums.sha256`.",
    "",
    "| Файл | SHA-256 | Размер, байт |",
    "|---|---|---:|",
  );
  for (const item of evidenceRows)
    lines.push(`| \`${item.path}\` | \`${item.sha256}\` | ${item.sizeBytes} |`);
  const unproven = result.gates
    .filter((gate) => gate.status !== "PASS")
    .map((gate) => `${gate.id}: ${gate.status}`);
  lines.push(
    "",
    "## Открытые риски и непроверенное поведение",
    "",
    ...environmentErrors.map((error) => `- Environment: ${error}`),
    ...unproven.map((entry) => `- ${entry}`),
    "- aroma_sandbox без проверенного detached signature verifier и signed approval не выполняет provider-вызов.",
    "- Непрошедшие gates сохраняют FAIL, NOT_RUN или SKIPPED_BY_FILTER; автоматического retry нет.",
    "- PASS с reusedFrom взят из identity-совпавшего источника; его evidence не переносится в этот run.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

async function ensureDirectoryTreeNoFollow(root, target) {
  root = resolve(root);
  target = resolve(target);
  const suffix = relative(root, target);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Output directory escapes trusted root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Output root must be a regular directory");
  let current = root;
  for (const component of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          `Output parent is not a regular directory: ${relative(root, current)}`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

async function writeRegularNoFollow(root, target, contents) {
  await assertNoSymlinkPath(root, target, true);
  let exists = false;
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile())
      throw new Error(
        `Output target is not a regular file: ${relative(root, target)}`,
      );
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number")
    throw new Error("Filesystem does not support O_NOFOLLOW");
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_NOFOLLOW |
    (exists ? fsConstants.O_TRUNC : fsConstants.O_CREAT | fsConstants.O_EXCL);
  const handle = await open(target, flags, 0o600);
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

async function writeFinalFiles(
  evidenceDir,
  sourceRoot,
  result,
  defects,
  evidenceErrors,
  environmentErrors,
  preflight,
  fingerprint,
  sourceDescriptor,
  { publishReport = true } = {},
) {
  const decisionPath = join(evidenceDir, "decision.json");
  const resultPath = join(evidenceDir, "run-result.json");
  const reportPath = join(
    sourceRoot,
    "docs/reports/launch",
    result.runId,
    "ОТЧЁТ.md",
  );
  // Решение выносится по 19 рабочим гейтам; reportStatus публикуется отдельно.
  const workingGatesPass =
    decisive(result.gates, result.profile) === "ДОПУСТИТЬ";
  result.decision =
    workingGatesPass &&
    evidenceErrors.length === 0 &&
    environmentErrors.length === 0
      ? "ДОПУСТИТЬ"
      : "НЕ ДОПУСТИТЬ";
  result.reportStatus = reportGateStatus(result.gates);
  await writeRegularNoFollow(evidenceDir, resultPath, json(result));
  await writeRegularNoFollow(
    evidenceDir,
    decisionPath,
    json({
      decision: result.decision,
      runId: result.runId,
      candidateSha: result.candidateSha,
      mandatoryGatesPass: workingGatesPass,
      reportStatus: result.reportStatus,
      evidenceErrors: [...evidenceErrors, ...environmentErrors],
    }),
  );
  const handoffPath = join(evidenceDir, "handoff.yaml");
  const artifactHashes = [];
  for (const file of await listFiles(evidenceDir))
    if (file !== handoffPath && file !== join(evidenceDir, "checksums.sha256"))
      artifactHashes.push(await fileDigest(file, evidenceDir));
  artifactHashes.sort((a, b) => a.path.localeCompare(b.path, "en"));
  // JSON is YAML 1.2 and lets report run before candidate dependencies exist.
  await writeRegularNoFollow(
    evidenceDir,
    handoffPath,
    json({
      issue: 13,
      kind: "DERIVED_RUN_HANDOFF",
      runId: result.runId,
      candidateSha: result.candidateSha,
      sourceSha: result.sourceSha,
      sourceDescriptorPath: "evidence/handoffs/issue-13.yaml",
      sourceDescriptorSha256: sourceDescriptor.sha256,
      sourceDescriptorStatus: sourceDescriptor.status,
      decision: result.decision,
      mandatoryGatesPass: workingGatesPass,
      reportStatus: result.reportStatus,
      evidenceErrors: [...evidenceErrors, ...environmentErrors].map(redactText),
      limits: {
        gateTimeoutSeconds: Object.fromEntries(
          result.gates.map((gate) => [gate.id, gate.timeoutSeconds]),
        ),
        otherLimitsSource:
          "evidence/handoffs/issue-13.yaml#consumerContract.limitsSeconds",
      },
      gates: result.gates.map((gate) => ({
        id: gate.id,
        status: gate.status,
        expectedCommand: gate.expectedCommand,
        durationMs: gate.durationMs,
        reason: redactText(gate.reason || ""),
        runs: gate.runs.map((run) => ({
          argv: run.argv,
          timeoutMs: run.timeoutMs,
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          outputLimitExceeded: run.outputLimitExceeded,
        })),
      })),
      artifactHashes,
      limitations:
        sourceDescriptor.status === "BOUND"
          ? []
          : [
              "Source descriptor absent from exact candidate commit or unavailable; source binding is NOT_PROVEN.",
            ],
    }),
  );
  const rows = [];
  if (publishReport) {
    for (const file of await listFiles(evidenceDir))
      if (file !== join(evidenceDir, "checksums.sha256"))
        rows.push(await fileDigest(file, evidenceDir));
    rows.sort((a, b) => a.path.localeCompare(b.path, "en"));
    await ensureDirectoryTreeNoFollow(sourceRoot, dirname(reportPath));
    await writeRegularNoFollow(
      sourceRoot,
      reportPath,
      reportMarkdown(
        result,
        rows,
        defects,
        evidenceErrors,
        environmentErrors,
        preflight,
        fingerprint,
      ),
    );
  }
  const checksumRows = [];
  for (const file of await listFiles(evidenceDir))
    if (file !== join(evidenceDir, "checksums.sha256"))
      checksumRows.push(await fileDigest(file, sourceRoot));
  if (publishReport)
    checksumRows.push(await fileDigest(reportPath, sourceRoot));
  checksumRows.sort((a, b) => a.path.localeCompare(b.path, "en"));
  await writeRegularNoFollow(
    evidenceDir,
    join(evidenceDir, "checksums.sha256"),
    `${checksumRows.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`,
  );
  return publishReport ? reportPath : null;
}

export async function finalizeReport(
  evidenceDir,
  expectedSourceRoot = null,
  options = {},
) {
  evidenceDir = resolve(evidenceDir);
  const contextPath = join(evidenceDir, "context.json");
  const contextInfo = await lstat(contextPath);
  if (!contextInfo.isFile() || contextInfo.isSymbolicLink())
    throw new Error("context.json должен быть обычным evidence-файлом");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const sourceRoot = resolve(context.sourceRepoRoot ?? "");
  if (expectedSourceRoot && sourceRoot !== resolve(expectedSourceRoot))
    throw new Error("sourceRepoRoot не совпадает с доверенным repository root");
  await assertNoSymlinkPath(sourceRoot, evidenceDir);
  if (resolve(context.evidenceDir ?? "") !== evidenceDir)
    throw new Error(
      "context evidenceDir не совпадает с фактическим evidence path",
    );
  const resultPath = join(evidenceDir, "run-result.json");
  const resultInfo = await lstat(resultPath);
  if (!resultInfo.isFile() || resultInfo.isSymbolicLink())
    throw new Error(
      "run-result.json должен быть обычным evidence-файлом; symlink запрещён",
    );
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  validateRunResultContract(result);
  const publishReport =
    options.publishReport ?? !DIAGNOSTIC_PROFILES.has(result.profile);
  if (
    context.schemaVersion !== 1 ||
    context.runId !== result.runId ||
    context.candidateSha !== result.candidateSha ||
    resolve(sourceRoot, "evidence/launch", result.runId) !== evidenceDir ||
    context.checkoutDir !== result.environment.candidatePath
  ) {
    throw new Error("context/result identity или evidence scope не совпадают");
  }
  await listFiles(evidenceDir);
  const reportTarget = join(
    sourceRoot,
    "docs/reports/launch",
    result.runId,
    "ОТЧЁТ.md",
  );
  if (publishReport) await assertNoSymlinkPath(sourceRoot, reportTarget, true);
  const descriptor = spawnSync(
    "git",
    ["show", `${result.candidateSha}:evidence/handoffs/issue-13.yaml`],
    {
      cwd: result.environment.candidatePath,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const sourceDescriptor =
    descriptor.status === 0 && !descriptor.error
      ? {
          status: "BOUND",
          sha256: createHash("sha256").update(descriptor.stdout).digest("hex"),
        }
      : { status: "NOT_PROVEN", sha256: null };
  const descriptorError =
    "report: source descriptor отсутствует в точном candidate commit или недоступен";
  if (sourceDescriptor.status !== "BOUND") {
    const gate = result.gates[19];
    gate.status = "FAIL";
    if (!String(gate.reason ?? "").includes(descriptorError))
      gate.reason = [gate.reason, descriptorError].filter(Boolean).join("; ");
    await writeRegularNoFollow(
      evidenceDir,
      join(evidenceDir, "gates", gate.id, "result.json"),
      json(gate),
    );
  }
  const defects = await writeDefects(evidenceDir, sourceRoot, result);
  let evidenceErrors = await validateEvidence(evidenceDir, result, sourceRoot, {
    publishReport,
  });
  if (sourceDescriptor.status !== "BOUND") evidenceErrors.push(descriptorError);
  const environmentErrors = environmentProofErrors(result.environment);
  const preflight = await preflightFindings(
    evidenceDir,
    result.gates[0].id,
    result.gates[0].reusedFrom ?? null,
  );
  const fingerprint = await sandboxFingerprint(evidenceDir, result.gates[16]);
  let reportPath = await writeFinalFiles(
    evidenceDir,
    sourceRoot,
    result,
    defects,
    evidenceErrors,
    environmentErrors,
    preflight,
    fingerprint,
    sourceDescriptor,
    { publishReport },
  );
  try {
    await validateChecksumManifest(evidenceDir, sourceRoot, result.runId, {
      publishReport,
    });
  } catch (error) {
    evidenceErrors = [...evidenceErrors, redactText(error.message)];
    reportPath = await writeFinalFiles(
      evidenceDir,
      sourceRoot,
      result,
      defects,
      evidenceErrors,
      environmentErrors,
      preflight,
      fingerprint,
      sourceDescriptor,
      { publishReport },
    );
  }
  try {
    await validateChecksumManifest(evidenceDir, sourceRoot, result.runId, {
      publishReport,
    });
  } catch (error) {
    evidenceErrors = [...evidenceErrors, redactText(error.message)];
  }
  return { result, reportPath, errors: evidenceErrors, environmentErrors };
}

async function main(args) {
  const finalizeMode =
    args[0] === "--finalize"
      ? {}
      : args[0] === "--finalize-evidence"
        ? { publishReport: false }
        : null;
  if (finalizeMode) {
    const requestedEvidenceDir = resolve(args[1] ?? "");
    const { context, sourceRoot, evidenceDir } = await validateLaunchContext(
      join(requestedEvidenceDir, "context.json"),
    );
    if (requestedEvidenceDir !== evidenceDir)
      throw new Error(`${args[0]} path не совпадает с launch context`);
    const finalized = await finalizeReport(
      context.evidenceDir,
      sourceRoot,
      finalizeMode,
    );
    process.exitCode = finalized.errors.length ? 1 : 0;
    return;
  }
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextPath) throw new Error("COFFEE_LAUNCH_CONTEXT_FILE не задан");
  const { context, sourceRoot } = await validateLaunchContext(contextPath);
  const finalized = await finalizeReport(context.evidenceDir, sourceRoot);
  process.exitCode = finalized.errors.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(redactText(error.stack ?? error.message));
    process.exitCode = 1;
  }
}
