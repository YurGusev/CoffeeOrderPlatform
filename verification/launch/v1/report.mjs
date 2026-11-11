import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_DATABASE_OWNERS,
  deriveLaunchDatabaseName,
} from "../../../packages/platform-config/src/launch-database-target.ts";
import { CANONICAL_KAFKA_TOPIC_NAMES } from "../../../packages/platform-config/src/launch-kafka-target.ts";

// G19 must work even when G00/G01 failed before candidate dependencies were installed.
// Keep this small validation contract local and builtin-only.
const PROJECT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
// G12 inner budget 33 min + post-processing/headroom.
const G12_GATE_TIMEOUT_SECONDS = 2100;
export const EXPECTED_GATES = [
  ["G00_PREFLIGHT", "pnpm launch:verify:preflight", 900],
  ["G01_INSTALL", "pnpm install --frozen-lockfile", 900],
  ["G02_GENERATED", "pnpm contracts:check-generated", 900],
  ["G03_STATIC", "pnpm format:check && pnpm lint && pnpm typecheck", 900],
  ["G04_UNIT", "pnpm test:unit -- --coverage", 900],
  [
    "G05_CONTRACTS",
    "pnpm contracts:check-generated && pnpm contracts:breaking && pnpm contracts:test",
    900,
  ],
  ["G06_ARCHITECTURE", "pnpm architecture:check", 900],
  [
    "G07_CONFIG_SECURITY",
    "pnpm versions:check && pnpm config:check && pnpm security:secrets",
    900,
  ],
  ["G12_SUPPLY_CHAIN", "pnpm security:scan", G12_GATE_TIMEOUT_SECONDS],
  [
    "G08_MIGRATIONS",
    "pnpm test:migrations:clean && pnpm test:migrations:forward",
    1800,
  ],
  ["G09_DB_BOUNDARIES", "pnpm db:smoke", 1800],
  ["G10_INTEGRATION", "pnpm test:integration", 1800],
  ["G11_RECOVERY", "pnpm test:recovery", 1800],
  ["G13_COMPOSE", "pnpm test:compose-smoke", 1800],
  ["G14_OBSERVABILITY", "pnpm test:observability", 1800],
  ["G15_BROWSER", "pnpm test:playwright", 1800],
  [
    "G16_AROMA_SANDBOX",
    'pnpm test:aroma-sandbox -- --approval-file "$AROMA_SANDBOX_APPROVAL_FILE"',
    1800,
  ],
  ["G17_BACKUP_RESTORE", "pnpm test:backup-restore", 1800],
  ["G18_ROLLBACK", "pnpm test:mutation-disable-rollback", 1800],
  ["G19_REPORT", "pnpm launch:verify:report", 900],
];

function redactText(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      "[REDACTED-URL]",
    )
    .replace(
      /\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|client[_-]?secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    );
}

export function validateRunResultContract(result) {
  if (
    !result ||
    result.schemaVersion !== 1 ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(result.runId ?? "") ||
    !/^[0-9a-f]{40}$/.test(result.candidateSha ?? "") ||
    !/^[0-9a-f]{40}$/.test(result.sourceSha ?? "") ||
    !Array.isArray(result.gates) ||
    result.gates.length !== EXPECTED_GATES.length ||
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
      gate?.id !== id ||
      gate.expectedCommand !== command ||
      gate.timeoutSeconds !== timeoutSeconds ||
      !["PASS", "FAIL", "NOT_RUN"].includes(gate.status) ||
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

async function validateEvidence(evidenceDir, result, sourceRoot) {
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
    if (gate.status === "PASS" && gate.runs.length !== expectedArgvs.length)
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
    result.gates.some((gate) => gate.status !== "PASS") &&
    result.decision === "ДОПУСТИТЬ"
  )
    errors.push("Решение допускает run с непрошедшим mandatory gate");
  if (
    result.decision === "ДОПУСТИТЬ" &&
    environmentProofErrors(result.environment).length
  )
    errors.push("Решение допускает неполное environment proof");
  const preflightPath = join(
    evidenceDir,
    "gates",
    "G00_PREFLIGHT",
    "artifacts",
    "preflight.json",
  );
  let preflight = null;
  if (result.gates[0].status === "PASS") {
    try {
      preflight = JSON.parse(await readFile(preflightPath, "utf8"));
      if (
        preflight.status !== "PASS" ||
        preflight.candidateSha !== result.candidateSha ||
        preflight.runId !== result.runId ||
        preflight.checks.some((check) => check.status !== "PASS")
      ) {
        errors.push(
          "G00 preflight artifact семантически не совпадает с результатом",
        );
      }
    } catch {
      errors.push("Нет валидного G00 preflight artifact для PASS");
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
          "G00 Kafka plan does not bind this run, candidate and base config",
        );
      }
      const inventoryPath = join(
        evidenceDir,
        "gates/G13_COMPOSE/artifacts/kafka-namespace-inventory.json",
      );
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
      if (
        !result.gates[13].artifacts.some(
          (artifact) => resolve(artifact.path) === inventoryPath,
        )
      )
        throw new Error("G13 inventory is not listed as a gate artifact");
      validateKafkaNamespaceInventory(inventory, {
        runId: context.runId,
        projectName: context.resources?.composeProject,
        expectedTopics,
        expectedGroups,
      });
    } catch {
      errors.push(
        "Нет валидного G13 Kafka namespace inventory, связанного с G00 plan/context",
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
      "G19 PASS не подтверждён единственным exact report argv с exit 0",
    );
  }
  if (g19.status === "PASS") {
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
        errors.push("G19 report/decision identity or decision mismatch");
    } catch {
      errors.push("G19 report или decision.json отсутствует");
    }
  }
  if (!files.has(resultPath)) errors.push("Отсутствует run-result.json");
  return errors;
}

export async function writeDefects(evidenceDir, sourceRoot, result) {
  const defects = [];
  for (const gate of result.gates.filter((entry) => entry.status === "FAIL")) {
    const checkFailures = [];
    if (gate.id === "G00_PREFLIGHT") {
      try {
        const preflight = JSON.parse(
          await readFile(
            join(evidenceDir, "gates/G00_PREFLIGHT/artifacts/preflight.json"),
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

export async function validateChecksumManifest(evidenceDir, sourceRoot, runId) {
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
  expectedPaths.push(reportPath);
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

async function preflightFindings(evidenceDir) {
  try {
    const value = JSON.parse(
      await readFile(
        join(evidenceDir, "gates/G00_PREFLIGHT/artifacts/preflight.json"),
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
  for (const gate of result.gates) {
    const duration = (gate.durationMs / 1000).toFixed(3);
    lines.push(
      `| ${gate.id} | ${gate.status} | \`${gate.expectedCommand.replaceAll("|", "\\|")}\` | ${duration} | ${redactText(
        gate.reason || "—",
      )
        .replaceAll("|", "\\|")
        .replaceAll("\n", " ")} |`,
    );
  }
  lines.push(
    "",
    "## Предварительная проверка G00",
    "",
    `Статус: ${preflight.status}. Артефакт: [preflight.json](../../../../evidence/launch/${result.runId}/gates/G00_PREFLIGHT/artifacts/preflight.json).`,
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
    `G16: ${result.gates[16].status}; account fingerprint: ${fingerprint ?? "нет доказательства в принятом evidence"}. Credentials не включаются в отчёт.`,
  );
  lines.push(
    "",
    "## Backup RPO и restore time",
    "",
    `G17: ${result.gates[17].status}; требование: RPO на момент dump, restore не более 10 минут для каждой БД и 30 минут суммарно. Фактические измерения: ${result.gates[17].status === "NOT_RUN" ? "NOT_RUN — доказательства нет" : "см. связанные G17 artifacts; runner не подменяет отсутствующие измерения расчетными значениями"}.`,
  );
  lines.push(
    "",
    "## Observability и rollback",
    "",
    `G14 observability: ${result.gates[14].status} — ${redactText(result.gates[14].reason || "нет причины отказа")}.`,
    `G18 rollback: ${result.gates[18].status} — ${redactText(result.gates[18].reason || "нет причины отказа")}.`,
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
    "- G16 без проверенного detached signature verifier и signed approval не выполняет provider-вызов.",
    "- Непрошедшие gates сохраняют FAIL или NOT_RUN; автоматического retry нет.",
    "",
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

async function assertNoSymlinkPath(root, target, allowMissing = false) {
  root = resolve(root);
  target = resolve(target);
  const suffix = relative(root, target);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(root, suffix) !== target
  )
    throw new Error("Evidence path выходит за доверенный root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Trust root не является обычным каталогом");
  let current = root;
  for (const component of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error(`Symlink запрещён: ${relative(root, current)}`);
  }
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

function gitValue(directory, ...args) {
  const result = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Git identity validation failed: ${redactText(result.stderr || result.error?.message || "unknown error")}`,
    );
  return result.stdout.trim();
}

async function verifiedRepositoryRoot(directory) {
  const root = resolve(directory ?? "");
  const canonical = await realpath(root);
  if (canonical !== root)
    throw new Error("Repository root должен быть canonical path без symlink");
  if (
    (await realpath(gitValue(root, "rev-parse", "--show-toplevel"))) !==
    canonical
  )
    throw new Error("Git top-level не совпадает с repository root");
  const origin = gitValue(root, "remote", "get-url", "origin")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (origin !== "https://github.com/YurGusev/CoffeeOrderPlatform")
    throw new Error(
      "Repository origin не является canonical CoffeeOrderPlatform GitHub origin",
    );
  return canonical;
}

export async function validateLaunchContext(contextFile) {
  const contextPath = resolve(contextFile);
  const contextInfo = await lstat(contextPath);
  if (
    !contextInfo.isFile() ||
    contextInfo.isSymbolicLink() ||
    contextInfo.size > 16 * 1024
  )
    throw new Error(
      "Launch context должен быть обычным файлом не более 16 KiB",
    );
  if ((await realpath(contextPath)) !== contextPath)
    throw new Error("Launch context содержит symlink в пути");
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  if (
    context.schemaVersion !== 1 ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(context.runId ?? "") ||
    !/^[0-9a-f]{40}$/.test(context.candidateSha ?? "")
  ) {
    throw new Error("Некорректный launch context v1");
  }
  const sourceRoot = await verifiedRepositoryRoot(context.sourceRepoRoot);
  const evidenceDir = resolve(sourceRoot, "evidence/launch", context.runId);
  if (
    resolve(context.evidenceDir ?? "") !== evidenceDir ||
    contextPath !== join(evidenceDir, "context.json")
  )
    throw new Error("Context path не совпадает с source root/run ID");
  await assertNoSymlinkPath(sourceRoot, contextPath);
  const candidateRoot = await verifiedRepositoryRoot(context.checkoutDir);
  if (
    candidateRoot !== resolve(context.checkoutDir) ||
    gitValue(candidateRoot, "rev-parse", "HEAD") !== context.candidateSha
  ) {
    throw new Error(
      "Candidate checkout root/SHA не совпадает с launch context",
    );
  }
  const executingRoot = await verifiedRepositoryRoot(PROJECT_ROOT);
  if (executingRoot !== sourceRoot && executingRoot !== candidateRoot)
    throw new Error(
      "Report module не запущен из source root или точного candidate checkout",
    );
  return { context, sourceRoot, evidenceDir, candidateRoot };
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
) {
  const decisionPath = join(evidenceDir, "decision.json");
  const resultPath = join(evidenceDir, "run-result.json");
  const reportPath = join(
    sourceRoot,
    "docs/reports/launch",
    result.runId,
    "ОТЧЁТ.md",
  );
  const mandatoryPass =
    result.gates.length === 20 &&
    result.gates.every((gate) => gate.status === "PASS");
  result.decision =
    mandatoryPass &&
    evidenceErrors.length === 0 &&
    environmentErrors.length === 0
      ? "ДОПУСТИТЬ"
      : "НЕ ДОПУСТИТЬ";
  await writeRegularNoFollow(evidenceDir, resultPath, json(result));
  await writeRegularNoFollow(
    evidenceDir,
    decisionPath,
    json({
      decision: result.decision,
      runId: result.runId,
      candidateSha: result.candidateSha,
      mandatoryGatesPass: mandatoryPass,
      evidenceErrors: [...evidenceErrors, ...environmentErrors],
    }),
  );
  const handoffPath = join(evidenceDir, "handoff.yaml");
  const artifactHashes = [];
  for (const file of await listFiles(evidenceDir))
    if (file !== handoffPath && file !== join(evidenceDir, "checksums.sha256"))
      artifactHashes.push(await fileDigest(file, evidenceDir));
  artifactHashes.sort((a, b) => a.path.localeCompare(b.path, "en"));
  // JSON is YAML 1.2 and lets G19 run before candidate dependencies exist.
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
      mandatoryGatesPass: mandatoryPass,
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
  const checksumRows = [];
  for (const file of await listFiles(evidenceDir))
    if (file !== join(evidenceDir, "checksums.sha256"))
      checksumRows.push(await fileDigest(file, sourceRoot));
  checksumRows.push(await fileDigest(reportPath, sourceRoot));
  checksumRows.sort((a, b) => a.path.localeCompare(b.path, "en"));
  await writeRegularNoFollow(
    evidenceDir,
    join(evidenceDir, "checksums.sha256"),
    `${checksumRows.map((row) => `${row.sha256}  ${row.path}`).join("\n")}\n`,
  );
  return reportPath;
}

export async function finalizeReport(evidenceDir, expectedSourceRoot = null) {
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
  await assertNoSymlinkPath(sourceRoot, reportTarget, true);
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
    "G19: source descriptor отсутствует в точном candidate commit или недоступен";
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
  let evidenceErrors = await validateEvidence(evidenceDir, result, sourceRoot);
  if (sourceDescriptor.status !== "BOUND") evidenceErrors.push(descriptorError);
  const environmentErrors = environmentProofErrors(result.environment);
  const preflight = await preflightFindings(evidenceDir);
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
  );
  try {
    await validateChecksumManifest(evidenceDir, sourceRoot, result.runId);
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
    );
  }
  try {
    await validateChecksumManifest(evidenceDir, sourceRoot, result.runId);
  } catch (error) {
    evidenceErrors = [...evidenceErrors, redactText(error.message)];
  }
  return { result, reportPath, errors: evidenceErrors, environmentErrors };
}

async function main(args) {
  if (args[0] === "--finalize") {
    const requestedEvidenceDir = resolve(args[1] ?? "");
    const { context, sourceRoot, evidenceDir } = await validateLaunchContext(
      join(requestedEvidenceDir, "context.json"),
    );
    if (requestedEvidenceDir !== evidenceDir)
      throw new Error("--finalize path не совпадает с launch context");
    const finalized = await finalizeReport(context.evidenceDir, sourceRoot);
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
