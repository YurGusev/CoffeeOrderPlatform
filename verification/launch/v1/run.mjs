import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { load as parseYaml } from "js-yaml";
import {
  EXPECTED_GATES,
  splitExactCommand,
  validateChecksumManifest,
  validateKafkaNamespaceInventory,
  validateRunResultContract,
  validateLaunchContext,
  writeDefects,
} from "./report.mjs";
import {
  inspectLaunchCheckout,
  verifyControlledRollbackEvidence,
} from "./scenarios/rollback.mjs";
import { validateRoleMap } from "../../../scripts/db-bootstrap.mjs";
import {
  validateBrowserChildContext,
  validateBrowserCorrelation,
  validateBrowserFailureReceipt,
  validateBrowserParentRuntime,
} from "./scenarios/browser.mjs";
import { admitRealtimeCapacity } from "../../../tools/realtime-capacity.mjs";
import {
  loadVerifiedGateImage,
  readVerifiedRuntimeImages,
} from "../../../tools/verified-infrastructure-image.mjs";
import { artifactManifestPath } from "../../../tools/image-inventory.mjs";
import {
  cleanupLaunchRuntimeImages,
  captureRuntimeImageBaseline,
  inspectLaunchRuntimeImages,
  validateRuntimeImageOwnership,
} from "../../../tools/runtime-image-inventory.mjs";
import { validateDependencyReadiness } from "../../../tests/observability/runtime-matrix.mjs";
import { loadPlatformConfig } from "../../../scripts/config-lib.mjs";
import {
  observabilityVerificationCoverage,
  syntheticNodeNotReadyComplete,
} from "../../../tools/observability/verify.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = join(ROOT, "verification/launch/v1");
const MATRIX_PATH = join(BASE, "matrix.yaml");
const MATRIX_SCHEMA_PATH = join(BASE, "schemas/matrix.schema.json");
const RESULT_SCHEMA_PATH = join(BASE, "schemas/run-result.schema.json");
const TOTAL_TIMEOUT_MS = 120 * 60 * 1000;
const REPORT_FINALIZATION_RESERVE_MS = 120 * 1000;
const REPORT_COMMAND_RESERVE_MS = EXPECTED_GATES.at(-1)[2] * 1000;
const REPORT_TOTAL_RESERVE_MS =
  REPORT_COMMAND_RESERVE_MS + REPORT_FINALIZATION_RESERVE_MS;
const CONTROL_COMMAND_TIMEOUT_MS = 10_000;
const MAX_CONTROL_OUTPUT_BYTES = 64 * 1024;
const MAX_RUN_LOG_BYTES = 128 * 1024 * 1024;
const REDACT = "[REDACTED]";
const IDS = EXPECTED_GATES.map(([id]) => id);

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", {
  type: "string",
  validate: (value) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)),
});

export function gateBudgetMs(gateId, totalRemainingMs) {
  if (!Number.isFinite(totalRemainingMs)) return 0;
  if (gateId === "report")
    return Math.max(0, totalRemainingMs - REPORT_FINALIZATION_RESERVE_MS);
  return Math.max(0, totalRemainingMs - REPORT_TOTAL_RESERVE_MS);
}

export async function loadJsonSchema(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function validateWithSchema(value, schema, label) {
  const validate = ajv.getSchema(schema.$id) ?? ajv.compile(schema);
  if (!validate(value))
    throw new Error(
      `${label}: ${ajv.errorsText(validate.errors, { separator: "; " })}`,
    );
  return value;
}

export async function loadMatrix(path = MATRIX_PATH) {
  const [source, schema] = await Promise.all([
    readFile(path, "utf8"),
    loadJsonSchema(MATRIX_SCHEMA_PATH),
  ]);
  return validateWithSchema(parseYaml(source), schema, "matrix.yaml");
}

export async function validateRunResult(value) {
  const schema = await loadJsonSchema(RESULT_SCHEMA_PATH);
  validateWithSchema(value, schema, "run-result.json");
  validateRunResultContract(value);
  return value;
}

export function splitCommand(command) {
  return splitExactCommand(command);
}

const textualRedactions = [
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]"],
  [
    /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
    "[REDACTED-URL]",
  ],
  [
    /\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|set-cookie|client[_-]?secret)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
    `$1${REDACT}`,
  ],
  [
    /("(?:body|payload|providerResponse|provider|request|response|customerName|customer|email|phone|address|credential|secret|password|token)"\s*:\s*)("(?:\\.|[^"\\])*"|\{[^\n]*\}|\[[^\n]*\]|[^,}\n]+)/gi,
    `$1"${REDACT}"`,
  ],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACT],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, REDACT],
];
const structuredSensitiveKey =
  /"(?:body|payload|providerResponse|provider|request|response|customerName|customer|email|phone|address|credential|secret|password|token)"\s*:\s*(?:\[|\{)/i;

function bracketDepth(text, initial = 0) {
  let depth = initial;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  return Math.max(0, depth);
}

function redactLogLine(state, line, secretValues) {
  if (state.sensitiveDepth > 0) {
    state.sensitiveDepth = bracketDepth(line, state.sensitiveDepth);
    return "[REDACTED: sensitive JSON]\n";
  }
  const sensitive = structuredSensitiveKey.exec(line);
  if (sensitive) {
    const opens = [
      line.indexOf("[", sensitive.index),
      line.indexOf("{", sensitive.index),
    ].filter((index) => index >= 0);
    const at = Math.min(...opens);
    state.sensitiveDepth = bracketDepth(line.slice(at));
    return "[REDACTED: sensitive JSON]\n";
  }
  return redactText(line, secretValues);
}

export function redactText(text, secretValues = []) {
  let safe = String(text);
  for (const value of secretValues)
    if (typeof value === "string" && value.length >= 4)
      safe = safe.split(value).join(REDACT);
  for (const [pattern, replacement] of textualRedactions)
    safe = safe.replace(pattern, replacement);
  return safe;
}

export async function writeRedactedStream(
  readable,
  path,
  secretValues = [],
  maxLineBytes = 8192,
  outputBudget = null,
  onLimit = () => {},
  onLine = () => {},
) {
  const handle = await import("node:fs").then(({ createWriteStream }) =>
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  );
  let pending = "";
  let droppingLine = false;
  let outputLimitExceeded = Boolean(outputBudget?.exceeded);
  let limitSignalled = false;
  const redactionState = { sensitiveDepth: 0 };
  const decoder = new StringDecoder("utf8");
  const marker =
    "\n[REDACTED: run log budget exceeded; child terminated and remaining output discarded]\n";
  const markerSize = Buffer.byteLength(marker);
  const tripLimit = async (reason = marker) => {
    if (outputLimitExceeded || outputBudget?.exceeded) return;
    if (outputBudget) outputBudget.exceeded = true;
    outputLimitExceeded = true;
    if (!limitSignalled) {
      limitSignalled = true;
      if (outputBudget) {
        const room = Math.max(
          0,
          outputBudget.maxBytes - outputBudget.usedBytes,
        );
        const markerBytes = Buffer.from(reason).subarray(0, room);
        if (markerBytes.length) {
          outputBudget.usedBytes += markerBytes.length;
          await writeChunk(handle, markerBytes);
        }
      } else await writeChunk(handle, reason);
      onLimit();
    }
  };
  const emit = async (value) => {
    if (!value || outputLimitExceeded || outputBudget?.exceeded) return;
    onLine();
    if (!outputBudget) {
      await writeChunk(handle, value);
      return;
    }
    const bytes = Buffer.from(value, "utf8");
    if (
      outputBudget.usedBytes + bytes.length <=
      outputBudget.maxBytes - markerSize
    ) {
      outputBudget.usedBytes += bytes.length;
      await writeChunk(handle, value);
      return;
    }
    const room = Math.max(
      0,
      outputBudget.maxBytes - markerSize - outputBudget.usedBytes,
    );
    if (room) {
      const prefix = bytes.subarray(0, room);
      outputBudget.usedBytes += prefix.length;
      await writeChunk(handle, prefix);
    }
    await tripLimit();
  };
  try {
    for await (const chunk of readable) {
      if (outputBudget?.exceeded) {
        outputLimitExceeded = true;
        if (!limitSignalled) {
          limitSignalled = true;
          onLimit();
        }
      } else if (outputBudget) {
        outputBudget.observedBytes += chunk.length;
        if (outputBudget.observedBytes > outputBudget.maxBytes)
          await tripLimit();
      }
      let incoming = decoder.write(chunk);
      if (droppingLine) {
        const end = incoming.indexOf("\n");
        if (end < 0) continue;
        incoming = incoming.slice(end + 1);
        droppingLine = false;
      }
      pending += incoming;
      let boundary;
      while ((boundary = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, boundary + 1);
        pending = pending.slice(boundary + 1);
        if (Buffer.byteLength(line) > maxLineBytes)
          await tripLimit(
            "\n[REDACTED: oversized log line; parsing state uncertain; child terminated and remaining output discarded]\n",
          );
        else await emit(redactLogLine(redactionState, line, secretValues));
      }
      if (Buffer.byteLength(pending) > maxLineBytes) {
        await tripLimit(
          "\n[REDACTED: oversized log line; parsing state uncertain; child terminated and remaining output discarded]\n",
        );
        pending = "";
        droppingLine = true;
      }
    }
    pending += decoder.end();
    if (pending) {
      if (Buffer.byteLength(pending) > maxLineBytes)
        await tripLimit(
          "\n[REDACTED: oversized log line; parsing state uncertain; child terminated and remaining output discarded]\n",
        );
      else await emit(redactLogLine(redactionState, pending, secretValues));
    }
    await new Promise((resolvePromise, reject) =>
      handle.end((error) => (error ? reject(error) : resolvePromise())),
    );
  } catch (error) {
    handle.destroy();
    throw error;
  }
  return { outputLimitExceeded };
}

async function writeChunk(stream, value) {
  if (!stream.write(value, "utf8")) await once(stream, "drain");
}

function signalProcessGroup(pid, signal) {
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
    } catch {}
  }
}

function nowIso() {
  return new Date().toISOString();
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

export async function validateLaunchDataTempDir(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    throw new Error("--data-temp-dir requires an absolute canonical directory");
  await assertNoSymlinkPath(resolve("/"), path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o7777) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error("--data-temp-dir requires a private owned directory");
  return path;
}
async function ensureDirectoryTree(root, target) {
  root = resolve(root);
  target = resolve(target);
  const suffix = relative(root, target);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Evidence directory выходит за доверенный root");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error("Trust root не является обычным каталогом");
  let current = root;
  for (const component of suffix.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          `Evidence parent не является обычным каталогом: ${relative(root, current)}`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}
async function hashFile(path) {
  const digest = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    sizeBytes += chunk.length;
  }
  return { path, sha256: digest.digest("hex"), sizeBytes };
}
async function atomicJson(path, value) {
  await assertNoSymlinkPath(ROOT, path, true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await assertNoSymlinkPath(ROOT, temporary, true);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}

function runCapture(
  executable,
  args,
  cwd,
  timeoutMs = CONTROL_COMMAND_TIMEOUT_MS,
) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: true,
    });
    const out = [];
    const err = [];
    let outputBytes = 0;
    let timedOut = false;
    let overflow = false;
    let spawnError = null;
    let killTimer;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CONTROL_OUTPUT_BYTES) {
        overflow = true;
        signalProcessGroup(child.pid, "SIGTERM");
        if (!killTimer)
          killTimer = setTimeout(() => {
            signalProcessGroup(child.pid, "SIGKILL");
          }, 500);
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
      }, 500);
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      if (timedOut || overflow) {
        signalProcessGroup(child.pid, "SIGKILL");
      }
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        code: timedOut || overflow || spawnError ? null : code,
        timedOut,
        overflow,
        spawnError,
        stdout: Buffer.concat(out).toString("utf8").trim(),
        stderr: Buffer.concat(err).toString("utf8").trim(),
      });
    });
  });
}

async function git(cwd, ...args) {
  const result = await runCapture("git", args, cwd);
  if (result.code !== 0)
    throw new Error(
      `git ${args[0]} завершился с кодом ${result.code}: ${redactText(result.stderr)}`,
    );
  return result.stdout;
}

async function sourceState() {
  const sourceSha = await git(ROOT, "rev-parse", "HEAD");
  const status = await git(
    ROOT,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  return { sourceSha, status };
}

export async function normalizeCandidateInputModes(candidate) {
  for (const [relativePath, mode] of [
    ["config/platform.yaml", 0o644],
    ["config/toolchain-versions.json", 0o644],
    ["pnpm-lock.yaml", 0o644],
    ["secrets/platform.secrets.sops.yaml", 0o400],
  ]) {
    const path = join(candidate, relativePath);
    await assertNoSymlinkPath(candidate, path);
    if ((await realpath(path)) !== path)
      throw new Error("CANDIDATE_INPUT_PATH_INVALID");
    const before = await lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== process.getuid() ||
      before.nlink !== 1
    )
      throw new Error("CANDIDATE_INPUT_FILE_INVALID");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid() ||
        info.nlink !== 1 ||
        info.dev !== before.dev ||
        info.ino !== before.ino
      )
        throw new Error("CANDIDATE_INPUT_FILE_INVALID");
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
}

async function makeCandidateCheckout(candidateSha) {
  const parent = await mkdtemp(join(tmpdir(), "coffee-launch-private-"));
  await chmod(parent, 0o700);
  try {
    const candidate = join(parent, "checkout");
    const clone = await runCapture(
      "git",
      ["clone", "--quiet", "--no-hardlinks", "--no-checkout", ROOT, candidate],
      parent,
    );
    if (clone.code !== 0)
      throw new Error(
        `Не удалось создать локальный checkout: ${redactText(clone.stderr)}`,
      );
    await git(
      candidate,
      "remote",
      "set-url",
      "origin",
      "https://github.com/YurGusev/CoffeeOrderPlatform",
    );
    await git(candidate, "checkout", "--quiet", "--detach", candidateSha);
    await normalizeCandidateInputModes(candidate);
    if ((await git(candidate, "rev-parse", "HEAD")) !== candidateSha)
      throw new Error("candidate checkout указывает на другой SHA");
    if (
      (await git(
        candidate,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      )) !== ""
    )
      throw new Error("candidate checkout не чистый");
    try {
      const modules = await readFile(join(candidate, ".gitmodules"), "utf8");
      if (/^\s*\[submodule\s+/m.test(modules))
        throw new Error(
          "candidate содержит submodule; локальный checkout не может доказать его точный source",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { parent, candidate };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

const PROCESS_GONE_ERRNOS = new Set(["ENOENT", "ESRCH"]);
const RSS_ERRNOS = new Set([
  ...PROCESS_GONE_ERRNOS,
  "EACCES",
  "EIO",
  "EPERM",
  "EINVAL",
  "EOVERFLOW",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "MISSING",
]);

function peakRssError(stage, errno) {
  const error = new Error("peak RSS measurement failed");
  error.rssStage = stage;
  error.rssErrno = RSS_ERRNOS.has(errno) ? errno : "UNKNOWN";
  return error;
}

function parseProcStat(value) {
  const end = value.lastIndexOf(")");
  if (end < 0) throw peakRssError("stat", "EINVAL");
  const fields = value
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const processGroup = Number(fields[2]);
  if (
    !/^[A-Ztx]$/.test(state ?? "") ||
    !Number.isSafeInteger(processGroup) ||
    processGroup < 0
  )
    throw peakRssError("stat", "EINVAL");
  return { state, processGroup };
}

async function readProcStat(pid) {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (PROCESS_GONE_ERRNOS.has(error?.code)) return null;
    if (error?.rssStage) throw error;
    throw peakRssError("stat", error?.code);
  }
}

async function readPeakRssBytes(pgid) {
  let procEntries;
  try {
    procEntries = await readdir("/proc");
  } catch (error) {
    throw peakRssError("readdir", error?.code);
  }
  let total = 0;
  let found = false;
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) throw peakRssError("stat", "EINVAL");
    const process = await readProcStat(pid);
    if (
      !process ||
      process.processGroup !== pgid ||
      process.state === "Z" ||
      process.state === "X" ||
      process.state === "x"
    )
      continue;
    let status;
    try {
      status = await readFile(`/proc/${pid}/status`, "utf8");
    } catch (error) {
      if (!PROCESS_GONE_ERRNOS.has(error?.code))
        throw peakRssError("status", error?.code);
      const current = await readProcStat(pid);
      if (
        !current ||
        current.processGroup !== pgid ||
        current.state === "Z" ||
        current.state === "X" ||
        current.state === "x"
      )
        continue;
      throw peakRssError("status", error.code);
    }
    const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (!rss) {
      const current = await readProcStat(pid);
      if (
        !current ||
        current.processGroup !== pgid ||
        current.state === "Z" ||
        current.state === "X" ||
        current.state === "x"
      )
        continue;
      throw peakRssError("vmrss", "MISSING");
    }
    const rssKiB = Number(rss[1]);
    const rssBytes = rssKiB * 1024;
    if (
      !Number.isSafeInteger(rssBytes) ||
      !Number.isSafeInteger(total + rssBytes)
    )
      throw peakRssError("vmrss", "EOVERFLOW");
    total += rssBytes;
    found = true;
  }
  return found ? total : null;
}

function sensitiveEnvironmentValues() {
  return Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /secret|token|password|credential|api[_-]?key|authorization/i.test(
          key,
        ) && value,
    )
    .map(([, value]) => value);
}

export async function executeArgv(
  argv,
  cwd,
  timeoutMs,
  stdoutPath,
  stderrPath,
  contextPath,
  outputBudget = null,
  options = {},
) {
  const startedAt = nowIso();
  const start = Date.now();
  const childEnv = { ...process.env };
  // Гейты и тесты запускают runtime, который принимает только известные
  // локаторы. Служебные COFFEE_LAUNCH_* переменные оператора не должны
  // протекать в дочерние процессы: они задаются здесь явно.
  for (const name of Object.keys(childEnv))
    if (
      name.startsWith("COFFEE_LAUNCH_") &&
      name !== "COFFEE_LAUNCH_CONTEXT_FILE"
    )
      delete childEnv[name];
  delete childEnv.COFFEE_LAUNCH_DATA_TEMP_DIR;
  if (options.dataTempDir && options.gateId === "supply_chain")
    childEnv.COFFEE_LAUNCH_DATA_TEMP_DIR = options.dataTempDir;
  if (options.dataTempDir && options.gateId === "observability")
    childEnv.TMPDIR = options.dataTempDir;
  delete childEnv.COFFEE_LAUNCH_IMAGE_OWNERSHIP;
  delete childEnv.COFFEE_AROMA_SANDBOX_SIGNER_PATH;
  if (options.g16SignerPath)
    childEnv.COFFEE_AROMA_SANDBOX_SIGNER_PATH = options.g16SignerPath;
  if (options.imageManifestPath)
    // Имя переменной — контракт гейтов; значение — путь artifact-manifest.json.
    childEnv.COFFEE_LAUNCH_IMAGE_OWNERSHIP = options.imageManifestPath;
  childEnv.pnpm_config_verify_deps_before_run = "false";
  if (Number.isSafeInteger(options.deadlineEpochMs))
    childEnv.COFFEE_LAUNCH_GATE_DEADLINE_EPOCH_MS = String(
      options.deadlineEpochMs,
    );
  if (
    contextPath &&
    (argv.join(" ") === "pnpm launch:verify:preflight" ||
      argv.join(" ") === "pnpm launch:verify:report" ||
      argv.join(" ") === "pnpm test:unit -- --coverage" ||
      argv.join(" ") === "pnpm test:integration" ||
      argv.join(" ") === "pnpm test:recovery" ||
      argv.join(" ") === "pnpm test:compose-smoke" ||
      argv.join(" ") === "pnpm test:observability" ||
      argv.join(" ") === "pnpm test:mutation-disable-rollback" ||
      argv.join(" ") === "pnpm security:scan" ||
      argv.join(" ") === "pnpm test:backup-restore" ||
      argv.join(" ") === "pnpm db:smoke" ||
      argv.join(" ") === "pnpm test:migrations:clean" ||
      argv.join(" ") === "pnpm test:migrations:forward" ||
      argv.join(" ") ===
        "pnpm test:aroma-sandbox -- --approval-file $AROMA_SANDBOX_APPROVAL_FILE")
  )
    childEnv.COFFEE_LAUNCH_CONTEXT_FILE = contextPath;
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let spawnError = null;
  const closePromise = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", resolvePromise);
  });
  let outputLimitExceeded = false;
  let outputKillTimer;
  const stopForOutputLimit = () => {
    outputLimitExceeded = true;
    signalProcessGroup(child.pid, "SIGTERM");
    if (!outputKillTimer)
      outputKillTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
      }, 500);
  };
  let resolveFirstStdoutLine = () => {};
  const firstStdoutLine = new Promise((resolve) => {
    resolveFirstStdoutLine = resolve;
  });
  const stdout = writeRedactedStream(
    child.stdout,
    stdoutPath,
    sensitiveEnvironmentValues(),
    8192,
    outputBudget,
    stopForOutputLimit,
    options.awaitFirstStdoutLine ? resolveFirstStdoutLine : undefined,
  );
  const stderrOutput = new PassThrough();
  child.stderr.pipe(stderrOutput, { end: false });
  const stderr = writeRedactedStream(
    stderrOutput,
    stderrPath,
    sensitiveEnvironmentValues(),
    8192,
    outputBudget,
    stopForOutputLimit,
  );
  let peakRssBytes = null;
  const rssSamples = { attempted: 0, valid: 0, noMatch: 0, errors: 0 };
  let rssFailure = null;
  /** @type {Promise<void> | null} */
  let sampleInFlight = null;
  let timedOut = false;
  const sample = async () => {
    if (sampleInFlight) return sampleInFlight;
    rssSamples.attempted += 1;
    sampleInFlight = (async () => {
      try {
        const current = await readPeakRssBytes(child.pid);
        if (current === null) rssSamples.noMatch += 1;
        else {
          rssSamples.valid += 1;
          peakRssBytes = Math.max(peakRssBytes ?? 0, current);
        }
      } catch (error) {
        rssSamples.errors += 1;
        // Уходящий процесс теряет VmRSS раньше состояния Z и не отменяет уже снятый пик.
        if (peakRssBytes > 0 && error?.rssErrno === "MISSING") return;
        if (!rssFailure)
          rssFailure = {
            stage: error?.rssStage ?? "scan",
            errno: error?.rssErrno ?? "UNKNOWN",
          };
      }
    })().finally(() => {
      sampleInFlight = null;
    });
    return sampleInFlight;
  };
  const streams = Promise.allSettled([stdout, stderr]);
  let guard;
  let timer;
  let sampler;
  let killTimer;
  try {
    await new Promise((resolvePromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", resolvePromise);
    });
    if (options.awaitFirstStdoutLine) {
      await Promise.race([
        firstStdoutLine,
        new Promise((_, reject) => {
          guard = setTimeout(
            () => reject(new Error("child stdout was not observed")),
            30_000,
          );
        }),
      ]);
      clearTimeout(guard);
      // Короткий timeout иначе снимает группу раньше, чем обход /proc успевает её увидеть.
      await sample();
    }
    timer = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessGroup(child.pid, "SIGKILL");
      }, 2000);
    }, timeoutMs);
    timer.unref();
    sampler = setInterval(() => void sample(), 250);
    const exitPromise = closePromise.finally(() => {
      clearTimeout(timer);
      clearInterval(sampler);
    });
    await sample();
    const exitCode = await exitPromise;
    if (timedOut) {
      if (killTimer) clearTimeout(killTimer);
      signalProcessGroup(child.pid, "SIGKILL");
    }
    await Promise.resolve(sampleInFlight);
    await sample();
    const rssDiagnostic =
      rssFailure || peakRssBytes === null
        ? `[RSS] stage=${rssFailure?.stage ?? "no-match"} errno=${rssFailure?.errno ?? "NONE"} attempted=${rssSamples.attempted} valid=${rssSamples.valid} no-match=${rssSamples.noMatch} errors=${rssSamples.errors}\n`
        : "";
    stderrOutput.end(rssDiagnostic);
    const streamResults = await streams;
    for (const result of streamResults) {
      if (result.status === "rejected") throw result.reason;
      outputLimitExceeded ||= result.value.outputLimitExceeded;
    }
    return {
      argv,
      cwd,
      startedAt,
      endedAt: nowIso(),
      exitCode,
      timedOut,
      outputLimitExceeded,
      timeoutMs,
      durationMs: Date.now() - start,
      peakRssBytes: rssFailure ? null : peakRssBytes,
      artifacts: [await hashFile(stdoutPath), await hashFile(stderrPath)],
      ...(spawnError ? { spawnError: redactText(spawnError.message) } : {}),
    };
  } catch (error) {
    clearTimeout(timer);
    clearInterval(sampler);
    clearTimeout(killTimer);
    signalProcessGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => {
      signalProcessGroup(child.pid, "SIGKILL");
    }, 2000);
    await closePromise;
    signalProcessGroup(child.pid, "SIGKILL");
    throw error;
  } finally {
    clearTimeout(guard);
    clearTimeout(timer);
    clearInterval(sampler);
    clearTimeout(killTimer);
    await Promise.resolve(sampleInFlight);
    if (!stderrOutput.writableEnded) stderrOutput.end();
    await streams;
    clearTimeout(outputKillTimer);
  }
}

function gateRecord(gate) {
  return {
    id: gate.id,
    status: "NOT_RUN",
    expectedCommand: gate.command,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    timeoutSeconds: gate.timeout,
    reason: "Ожидает выполнения",
    runs: [],
    artifacts: [],
  };
}

function decisive(gates) {
  return gates.length === 20 && gates.every((gate) => gate.status === "PASS")
    ? "ДОПУСТИТЬ"
    : "НЕ ДОПУСТИТЬ";
}

function relativeEvidencePath(path) {
  return relative(ROOT, path).split("\\").join("/");
}

async function initializeEvidence(runId) {
  const evidenceDir = join(ROOT, "evidence/launch", runId);
  await ensureDirectoryTree(ROOT, dirname(evidenceDir));
  await mkdir(evidenceDir, { recursive: false, mode: 0o700 });
  for (const gateId of IDS)
    await mkdir(join(evidenceDir, "gates", gateId, "artifacts"), {
      recursive: true,
      mode: 0o700,
    });
  return evidenceDir;
}

async function writeContext(
  evidenceDir,
  candidateSha,
  candidatePath,
  githubSnapshotPath,
  acceptedBaseCommit,
  runId,
  startedAtUtc,
  baseConfigSha256,
) {
  await assertNoSymlinkPath(ROOT, evidenceDir);
  const context = {
    schemaVersion: 1,
    candidateSha,
    baseConfigSha256,
    runId,
    checkoutDir: candidatePath,
    sourceRepoRoot: ROOT,
    acceptedBaseCommit: acceptedBaseCommit ?? null,
    startedAtUtc,
    evidenceDir,
    githubSnapshotPath: githubSnapshotPath ?? null,
    resources: {
      composeProject: `coffee-launch-${runId.toLowerCase()}`,
      kafkaPrefix: runId,
    },
  };
  const path = join(evidenceDir, "context.json");
  await assertNoSymlinkPath(ROOT, path, true);
  await writeFile(path, `${JSON.stringify(context, null, 2)}\n`, {
    mode: 0o400,
    flag: "wx",
  });
  return path;
}

async function updateGateArtifact(evidenceDir, gate) {
  const path = join(evidenceDir, "gates", gate.id, "result.json");
  const gateDir = dirname(path);
  const standardLogs = await Promise.all(
    ["stdout.log", "stderr.log"].map((name) => hashFile(join(gateDir, name))),
  );
  const generated = [
    ...standardLogs,
    ...gate.runs.flatMap((run) => run.artifacts),
  ];
  const generatedKeys = new Set(
    generated.map((artifact) => `${artifact.path}:${artifact.sha256}`),
  );
  gate.artifacts = [
    ...generated,
    ...gate.artifacts.filter(
      (artifact) => !generatedKeys.has(`${artifact.path}:${artifact.sha256}`),
    ),
  ];
  await atomicJson(path, gate);
}

export async function captureKafkaNamespaceArtifact({
  evidenceDir,
  gateDir,
  context,
  expectedTopics,
  expectedGroups,
}) {
  let receipt = null;
  const stdout = await readFile(join(gateDir, "stdout.log"), "utf8");
  const finalLine = stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .at(-1);
  try {
    const candidate = finalLine ? JSON.parse(finalLine) : null;
    if (candidate && Object.hasOwn(candidate, "kafkaNamespaceInventory"))
      receipt = candidate.kafkaNamespaceInventory;
  } catch {
    /* the final stdout line must be the machine receipt */
  }
  if (!receipt) throw new Error("missing top-level receipt");
  validateKafkaNamespaceInventory(receipt, {
    runId: context.runId,
    projectName: context.resources?.composeProject,
    expectedTopics,
    expectedGroups,
  });
  const path = join(gateDir, "artifacts/kafka-namespace-inventory.json");
  await assertNoSymlinkPath(evidenceDir, path, true);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return await hashFile(path);
}

export async function verifyGateArtifacts(
  gate,
  record,
  evidenceDir,
  realtimeQualification,
) {
  const gateDir = join(evidenceDir, "gates", gate.id);
  const context = JSON.parse(
    await readFile(join(evidenceDir, "context.json"), "utf8"),
  );
  const additions = [];
  if (gate.id === "db_boundaries") {
    const failure =
      "db_boundaries live database-boundary receipt does not match the current run or exact 10/40-case contract";
    if (
      gate.command !== "pnpm db:smoke" ||
      record.runs?.length !== 1 ||
      record.runs[0]?.exitCode !== 0 ||
      record.runs[0]?.timedOut ||
      record.runs[0]?.outputLimitExceeded
    )
      return failure;
    const path = join(gateDir, "artifacts/result.json");
    let receipt;
    let migration;
    let preparationBytes;
    let stdoutReceipt;
    try {
      await assertNoSymlinkPath(evidenceDir, path);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o777) !== 0o600
      )
        return failure;
      receipt = JSON.parse(await readFile(path, "utf8"));
      const stdout = await readFile(join(gateDir, "stdout.log"), "utf8");
      const envelope = JSON.parse(stdout);
      if (
        !envelope ||
        typeof envelope !== "object" ||
        Array.isArray(envelope) ||
        Object.keys(envelope).length !== 1 ||
        !Object.hasOwn(envelope, "databaseBoundaryReceipt") ||
        !envelope.databaseBoundaryReceipt ||
        typeof envelope.databaseBoundaryReceipt !== "object"
      )
        return failure;
      stdoutReceipt = envelope.databaseBoundaryReceipt;
      const migrationPath = join(
        evidenceDir,
        "gates/migrations/artifacts/result.json",
      );
      const preparationPath = join(
        evidenceDir,
        "gates/migrations/artifacts/canonical-preparation.json",
      );
      await assertNoSymlinkPath(evidenceDir, migrationPath);
      await assertNoSymlinkPath(evidenceDir, preparationPath);
      const migrationInfo = await lstat(migrationPath);
      const preparationInfo = await lstat(preparationPath);
      if (
        !migrationInfo.isFile() ||
        migrationInfo.isSymbolicLink() ||
        migrationInfo.uid !== process.getuid() ||
        (migrationInfo.mode & 0o777) !== 0o600 ||
        !preparationInfo.isFile() ||
        preparationInfo.isSymbolicLink() ||
        preparationInfo.uid !== process.getuid() ||
        (preparationInfo.mode & 0o777) !== 0o400 ||
        preparationInfo.size > 16 * 1024
      )
        return failure;
      migration = JSON.parse(await readFile(migrationPath, "utf8"));
      preparationBytes = await readFile(preparationPath);
    } catch {
      return failure;
    }
    const ownership = JSON.parse(
      await readFile(join(ROOT, "config/database-ownership.json"), "utf8"),
    );
    const roleMap = JSON.parse(
      await readFile(join(ROOT, "config/database-role-map.json"), "utf8"),
    );
    const currentConfig = await readFile(join(ROOT, "config/platform.yaml"));
    const expectedConfigSha = createHash("sha256")
      .update(currentConfig)
      .digest("hex");
    if (context.baseConfigSha256 !== expectedConfigSha) return failure;
    try {
      validateRoleMap(roleMap, ownership);
    } catch {
      return failure;
    }
    if (!migration || !Array.isArray(migration.owners)) return failure;
    const expectedOwners = ownership.databases
      .map(({ owner }) => owner)
      .sort((left, right) => left.localeCompare(right));
    const expectedDatabases = Object.fromEntries(
      expectedOwners.map((owner) => [
        owner,
        `coffee_verify_${context.runId.toLowerCase().replace("-", "_")}_${owner}`,
      ]),
    );
    const exactKeys = (value, keys) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(
          [...keys].sort((left, right) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        );
    const canonical = (value) =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]),
            )
          : value;
    const sameValue = (left, right) =>
      JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const expectedMigrationOwners = [...migration.owners].sort((a, b) =>
      a.owner.localeCompare(b.owner),
    );
    const safeHash = (value) => /^[0-9a-f]{64}$/u.test(value ?? "");
    const prepSha = createHash("sha256").update(preparationBytes).digest("hex");
    const expectedRoleTuples = [];
    for (const database of roleMap.databases) {
      const owned = ownership.databases.find(
        (entry) => entry.name === database.name,
      );
      if (!owned) return failure;
      for (const runtime of database.runtimeRoles) {
        const claim = ownership.runtimeClaims.find(
          (entry) => entry.runtime === runtime.runtime,
        );
        const table = Object.entries(runtime.tables).find(([, grants]) =>
          grants.includes("SELECT"),
        )?.[0];
        if (
          !claim ||
          claim.database !== owned.name ||
          claim.role !== runtime.role ||
          !claim.secretRef ||
          !table
        )
          return failure;
        expectedRoleTuples.push({
          runtime: runtime.runtime,
          owner: owned.owner,
          role: runtime.role,
          database: expectedDatabases[owned.owner],
          schema: database.schema,
          table,
        });
      }
    }
    const expectedOwn = expectedRoleTuples
      .map(({ runtime, owner, role, database, schema, table }) => ({
        runtime,
        owner,
        database,
        role,
        schema,
        table,
        operation: "SELECT",
        outcome: "allowed",
      }))
      .sort((left, right) => left.runtime.localeCompare(right.runtime));
    const expectedForeign = expectedRoleTuples
      .flatMap((runtime) =>
        expectedOwners
          .filter((owner) => owner !== runtime.owner)
          .map((owner) => ({
            runtime: runtime.runtime,
            owner: runtime.owner,
            databaseOwner: owner,
            role: runtime.role,
            database: expectedDatabases[owner],
            sqlState: "42501",
            outcome: "permission-denied",
          })),
      )
      .sort((left, right) =>
        `${left.runtime}:${left.database}`.localeCompare(
          `${right.runtime}:${right.database}`,
        ),
      );
    const own = Array.isArray(receipt.ownOperations)
      ? [...receipt.ownOperations].sort((left, right) =>
          left.runtime.localeCompare(right.runtime),
        )
      : null;
    const foreign = Array.isArray(receipt.foreignConnectionDenials)
      ? [...receipt.foreignConnectionDenials].sort((left, right) =>
          `${left.runtime}:${left.database}`.localeCompare(
            `${right.runtime}:${right.database}`,
          ),
        )
      : null;
    const expectedOwnerPairs = expectedOwners.map((owner) => ({
      owner,
      database: expectedDatabases[owner],
    }));
    const migrationOwners = Array.isArray(receipt.migrationOwners)
      ? [...receipt.migrationOwners].sort((a, b) =>
          a.owner.localeCompare(b.owner),
        )
      : null;
    const migrationResultHash = createHash("sha256")
      .update(JSON.stringify(migrationOwners ?? []))
      .digest("hex");
    const databaseNames = Object.values(expectedDatabases).sort((left, right) =>
      left.localeCompare(right),
    );
    if (
      !exactKeys(receipt, [
        "schemaVersion",
        "status",
        "stage",
        "runId",
        "candidateSha",
        "baseConfigSha256",
        "preparationSha256",
        "migrationResultSha256",
        "systemIdentifier",
        "owners",
        "migrationOwners",
        "ownOperations",
        "foreignConnectionDenials",
        "ownOperationCount",
        "foreignDeniedCount",
        "caseCount",
        "cleanup",
      ]) ||
      !sameValue(stdoutReceipt, receipt) ||
      receipt.schemaVersion !== 1 ||
      receipt.status !== "PASS" ||
      receipt.stage !== "live-boundaries" ||
      receipt.runId !== context.runId ||
      receipt.candidateSha !== context.candidateSha ||
      receipt.baseConfigSha256 !== context.baseConfigSha256 ||
      receipt.preparationSha256 !== prepSha ||
      receipt.preparationSha256 !== migration.preparationSha256 ||
      receipt.systemIdentifier !== migration.systemIdentifier ||
      !/^[0-9]{1,20}$/u.test(receipt.systemIdentifier ?? "") ||
      !safeHash(receipt.migrationResultSha256) ||
      receipt.migrationResultSha256 !== migrationResultHash ||
      !Array.isArray(receipt.owners) ||
      !sameValue(receipt.owners, expectedOwnerPairs) ||
      !migration ||
      migration.stage !== "forward" ||
      migration.status !== "PASS" ||
      migration.runId !== context.runId ||
      migration.candidateSha !== context.candidateSha ||
      migration.baseConfigSha256 !== context.baseConfigSha256 ||
      migration.cleanup?.verified !== true ||
      JSON.stringify(migration.cleanup?.retained) !== "[]" ||
      JSON.stringify(migration.cleanup?.removed) !==
        JSON.stringify(databaseNames) ||
      migration.acceptedPrefixCommit !==
        "e278aeb10e57d37485542f8668f078456074b038" ||
      JSON.stringify(migration.legacyTargetsExcluded) !==
        JSON.stringify(["coffeeorder_staging", "coffeeorderdb"]) ||
      !Array.isArray(migration.owners) ||
      !migrationOwners ||
      !sameValue(migrationOwners, expectedMigrationOwners) ||
      !migrationOwners.every((owner) =>
        exactKeys(owner, [
          "owner",
          "database",
          "migrationCount",
          "prefixCount",
          "ledgerSha256",
          "schemaFingerprint",
          "aclFingerprint",
        ]),
      ) ||
      !migrationOwners.every(
        (owner) =>
          owner.migrationCount ===
            {
              catalog: 12,
              customer: 3,
              integration: 7,
              orders: 24,
              pricing: 5,
            }[owner.owner] &&
          owner.prefixCount ===
            { catalog: 8, customer: 2, integration: 7, orders: 6, pricing: 4 }[
              owner.owner
            ] &&
          safeHash(owner.ledgerSha256) &&
          safeHash(owner.schemaFingerprint) &&
          safeHash(owner.aclFingerprint),
      ) ||
      !sameValue(
        expectedMigrationOwners.map(({ owner, database }) => ({
          owner,
          database,
        })),
        expectedOwnerPairs,
      ) ||
      expectedRoleTuples.length !== 10 ||
      !own ||
      !sameValue(own, expectedOwn) ||
      !foreign ||
      !sameValue(foreign, expectedForeign) ||
      receipt.ownOperationCount !== 10 ||
      receipt.foreignDeniedCount !== 40 ||
      receipt.caseCount !== 50 ||
      !exactKeys(receipt.cleanup, ["verified", "removed", "retained"]) ||
      receipt.cleanup.verified !== true ||
      JSON.stringify(receipt.cleanup.removed) !==
        JSON.stringify(databaseNames) ||
      !Array.isArray(receipt.cleanup.retained) ||
      receipt.cleanup.retained.length !== 0
    )
      return failure;
    additions.push(await hashFile(path));
  }
  if (gate.id === "migrations") {
    const path = join(gateDir, "artifacts/result.json");
    let receipt;
    try {
      receipt = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return "migrations oracle receipt is missing or invalid";
    }
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
      return "migrations oracle receipt is missing or invalid";
    const expectedOwners = [
      ["catalog", 12],
      ["customer", 3],
      ["integration", 7],
      ["orders", 24],
      ["pricing", 5],
    ];
    const expectedDatabases = expectedOwners
      .map(
        ([owner]) =>
          `coffee_verify_${context.runId.toLowerCase().replace("-", "_")}_${owner}`,
      )
      .sort();
    const validOwners =
      Array.isArray(receipt.owners) &&
      receipt.owners.length === expectedOwners.length &&
      receipt.owners.every(
        (owner) => owner && typeof owner === "object" && !Array.isArray(owner),
      ) &&
      JSON.stringify(
        receipt.owners
          .map(({ owner, database }) => [owner, database])
          .sort(([left], [right]) => left.localeCompare(right)),
      ) ===
        JSON.stringify(
          expectedOwners
            .map(([owner]) => [
              owner,
              `coffee_verify_${context.runId.toLowerCase().replace("-", "_")}_${owner}`,
            ])
            .sort(([left], [right]) => left.localeCompare(right)),
        ) &&
      receipt.owners.every((owner) => {
        const count = expectedOwners.find(
          ([name]) => name === owner.owner,
        )?.[1];
        return (
          owner.migrationCount === count &&
          /^[0-9a-f]{64}$/u.test(owner.ledgerSha256 ?? "") &&
          /^[0-9a-f]{64}$/u.test(owner.schemaFingerprint ?? "") &&
          /^[0-9a-f]{64}$/u.test(owner.aclFingerprint ?? "")
        );
      });
    if (
      receipt.schemaVersion !== 1 ||
      receipt.status !== "PASS" ||
      receipt.stage !== "forward" ||
      receipt.runId !== context.runId ||
      receipt.candidateSha !== context.candidateSha ||
      receipt.baseConfigSha256 !== context.baseConfigSha256 ||
      !/^[0-9]{1,20}$/u.test(receipt.systemIdentifier ?? "") ||
      receipt.acceptedPrefixCommit !==
        "e278aeb10e57d37485542f8668f078456074b038" ||
      !/^[0-9a-f]{64}$/u.test(receipt.preparationSha256 ?? "") ||
      !/^[0-9a-f]{64}$/u.test(receipt.cleanSha256 ?? "") ||
      !validOwners ||
      receipt.cleanup?.verified !== true ||
      receipt.cleanup?.retained?.length !== 0 ||
      JSON.stringify(receipt.cleanup?.removed) !==
        JSON.stringify(expectedDatabases) ||
      JSON.stringify(receipt.legacyTargetsExcluded) !==
        JSON.stringify(["coffeeorder_staging", "coffeeorderdb"])
    )
      return "migrations oracle receipt does not match the validated context or cleanup contract";
    additions.push(await hashFile(path));
  }
  if (gate.id === "observability") {
    const failure =
      "observability browser correlation child lineage or cleanup is invalid";
    if (
      gate.command !== "pnpm test:observability" ||
      record.runs?.length !== 1 ||
      !isDeepStrictEqual(record.runs[0]?.argv, [
        "pnpm",
        "test:observability",
      ]) ||
      record.runs[0]?.outputLimitExceeded
    )
      return failure;
    try {
      const child = await validateBrowserCorrelation({
        evidenceDir,
        parentContext: context,
      });
      for (const path of child.files) {
        await assertNoSymlinkPath(evidenceDir, path);
        record.artifacts.push(await hashFile(path));
      }
      if (record.runs[0]?.timedOut) return failure;
      const names = [
        "alert-transitions.json",
        "correlation-proof.json",
        "redaction-scan.json",
        "queue-loss-counters.json",
        "retention-result.json",
        "runtime-health-matrix.json",
        "result.json",
      ];
      const documents = {};
      for (const name of names) {
        const path = join(gateDir, "artifacts/observability", name);
        await assertNoSymlinkPath(evidenceDir, path);
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > 4 * 1024 * 1024
        )
          return failure;
        documents[name] = JSON.parse(await readFile(path, "utf8"));
        additions.push(await hashFile(path));
      }
      const result = documents["result.json"];
      const correlation = documents["correlation-proof.json"];
      const traceNotProven = correlation.launchPath?.traceStatus !== "PASS";
      if (
        result.status !== (traceNotProven ? "FAIL" : "PASS") ||
        !/^[0-9a-f-]{36}$/u.test(result.runId ?? "") ||
        !names.every(
          (name) =>
            documents[name].status ===
              (traceNotProven && name === "correlation-proof.json"
                ? "NOT_PROVEN"
                : name === "result.json"
                  ? result.status
                  : "PASS") && documents[name].runId === result.runId,
        ) ||
        result.provenance?.sourceHashStable !== true ||
        result.provenance.start?.baseSha !== context.candidateSha ||
        result.provenance.start?.configSha256 !== context.baseConfigSha256 ||
        result.provenance.start?.sourceFiles?.status !== "PASS" ||
        !syntheticNodeNotReadyComplete(result.syntheticNodeNotReady) ||
        !isDeepStrictEqual(
          result.syntheticNodeNotReady,
          documents["alert-transitions.json"].syntheticNodeNotReady,
        ) ||
        !isDeepStrictEqual(result.browserCorrelationChild, child.receipt) ||
        correlation.launchPath?.correlationId !==
          child.receipt.proof.correlationId ||
        (!traceNotProven &&
          correlation.launchPath?.traceId !== child.receipt.proof.traceId) ||
        (traceNotProven &&
          correlation.launchPath?.traceStatus !== "NOT_PROVEN") ||
        correlation.launchPath?.browserRefetchMatched !== true ||
        correlation.launchPath?.ownerCausation !== true ||
        result.runtimeMetricMatrix?.composeReceipt?.postgres
          ?.externalPostgres !== true ||
        result.runtimeMetricMatrix?.composeReceipt?.externalCleanup
          ?.verified !== true ||
        !isDeepStrictEqual(result.cleanupErrors, [])
      )
        return failure;
      if (traceNotProven) {
        record.artifacts.push(...additions);
        return "observability W3C trace is not proven";
      }
      const qualificationPath = join(
        gateDir,
        "artifacts/realtime-capacity.json",
      );
      await assertNoSymlinkPath(evidenceDir, qualificationPath);
      const qualificationInfo = await lstat(qualificationPath);
      if (
        record.runs[0]?.exitCode !== 0 ||
        !qualificationInfo.isFile() ||
        qualificationInfo.isSymbolicLink() ||
        qualificationInfo.uid !== process.getuid() ||
        (qualificationInfo.mode & 0o777) !== 0o600 ||
        qualificationInfo.size > 65536 ||
        !realtimeQualification ||
        !isDeepStrictEqual(
          JSON.parse(await readFile(qualificationPath, "utf8")),
          realtimeQualification,
        )
      )
        return failure;
      const active = await validateLaunchContext(
        join(evidenceDir, "context.json"),
      );
      const expectedImages = await readVerifiedRuntimeImages({
        contextFile: join(evidenceDir, "context.json"),
      });
      const expectedAdmission = {
        runId: realtimeQualification.receipt.runId,
        candidateSha: realtimeQualification.receipt.candidateSha,
        baseConfigSha256: realtimeQualification.receipt.baseConfigSha256,
        receiptSha256: realtimeQualification.receiptSha256,
        admittedAt: realtimeQualification.admittedAt,
      };
      const expectedConfig = await loadPlatformConfig(active.candidateRoot);
      validateDependencyReadiness(
        result.runtimeMetricMatrix?.composeReceipt?.dependencyReadiness,
        expectedConfig,
      );
      const computedCoverage = observabilityVerificationCoverage(result, {
        config: expectedConfig,
        sourceHashStable: result.provenance?.sourceHashStable === true,
        backendArtifactsComplete: names.every(
          (name) => documents[name].status === "PASS",
        ),
      });
      if (
        !isDeepStrictEqual(result.qualificationAdmission, expectedAdmission) ||
        !isDeepStrictEqual(result.verifiedRuntimeImages, expectedImages) ||
        !isDeepStrictEqual(result.launchPathProof, correlation.launchPath) ||
        !isDeepStrictEqual(
          result.fullSystemObservability,
          documents["runtime-health-matrix.json"].fullSystemObservability,
        ) ||
        !isDeepStrictEqual(
          result.fullSystemObservability,
          computedCoverage.fullSystemObservability,
        ) ||
        !/^[a-f0-9]{64}$/u.test(result.provenance?.start?.identityHash ?? "") ||
        result.provenance?.start?.identityHash !==
          result.provenance?.end?.identityHash ||
        correlation.launchPath?.telemetrySubproof?.status !== "OBSERVED" ||
        correlation.launchPath?.telemetrySubproof?.ordinaryApiMeasurement
          ?.status !== "MEASURED" ||
        correlation.launchPath?.telemetrySubproof?.carrier !==
          child.receipt.proof.ownerTraceparent
      )
        return failure;
      if (result.fullSystemObservability?.status !== "PASS") {
        record.artifacts.push(...additions);
        return "observability full-system SLO, chaos and capacity proof is not complete";
      }
    } catch {
      return failure;
    }
  }
  if (gate.id === "browser") {
    const failure =
      "browser parent wrapper does not admit a joined child, exact fixture lineage, browser proof and cleanup";
    const failedChildAttempt =
      gate.command === "pnpm test:playwright" &&
      record.runs?.length === 1 &&
      isDeepStrictEqual(record.runs[0]?.argv, ["pnpm", "test:playwright"]) &&
      (record.runs[0]?.exitCode !== 0 ||
        record.runs[0]?.timedOut ||
        record.runs[0]?.outputLimitExceeded);
    if (failedChildAttempt) {
      try {
        const launch = await validateLaunchContext(
          join(evidenceDir, "context.json"),
        );
        if (
          launch.context.runId !== context.runId ||
          launch.context.candidateSha !== context.candidateSha ||
          launch.context.baseConfigSha256 !== context.baseConfigSha256
        )
          return failure;
        const artifactRoot = join(gateDir, "artifacts");
        const childContextPath = join(artifactRoot, "g15-child-context.json");
        await assertNoSymlinkPath(evidenceDir, childContextPath);
        const childContextInfo = await lstat(childContextPath);
        if (
          !childContextInfo.isFile() ||
          childContextInfo.isSymbolicLink() ||
          childContextInfo.uid !== process.getuid() ||
          (childContextInfo.mode & 0o777) !== 0o400
        )
          return failure;
        const childContext = JSON.parse(
          await readFile(childContextPath, "utf8"),
        );
        validateBrowserChildContext(
          childContext,
          launch.context,
          launch.candidateRoot,
        );
        const failurePath = join(artifactRoot, "browser-parent-failure.json");
        await assertNoSymlinkPath(evidenceDir, failurePath);
        const failureInfo = await lstat(failurePath);
        if (
          !failureInfo.isFile() ||
          failureInfo.isSymbolicLink() ||
          failureInfo.uid !== process.getuid() ||
          (failureInfo.mode & 0o777) !== 0o600
        )
          return failure;
        const receipt = JSON.parse(await readFile(failurePath, "utf8"));
        validateBrowserFailureReceipt(receipt, {
          parentContext: launch.context,
          childContext,
        });
        record.artifacts.push(await hashFile(failurePath));
      } catch {
        // The original `browser` failure remains authoritative if diagnostics fail validation.
      }
      return failure;
    }
    if (
      gate.command !== "pnpm test:playwright" ||
      record.runs?.length !== 1 ||
      !isDeepStrictEqual(record.runs[0]?.argv, ["pnpm", "test:playwright"]) ||
      record.runs[0]?.exitCode !== 0 ||
      record.runs[0]?.timedOut ||
      record.runs[0]?.outputLimitExceeded
    )
      return failure;
    try {
      const launch = await validateLaunchContext(
        join(evidenceDir, "context.json"),
      );
      if (
        launch.context.runId !== context.runId ||
        launch.context.candidateSha !== context.candidateSha ||
        launch.context.baseConfigSha256 !== context.baseConfigSha256
      )
        return failure;
      await inspectLaunchCheckout(
        launch.candidateRoot,
        launch.context.candidateSha,
      );
      const stdout = await readFile(join(gateDir, "stdout.log"), "utf8");
      const finalLine = stdout
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .at(-1);
      const stdoutReceipt = finalLine ? JSON.parse(finalLine) : null;
      await validateBrowserParentRuntime({
        evidenceDir,
        parentContext: launch.context,
        stdoutReceipt,
      });
    } catch {
      return failure;
    }
    const artifactRoot = join(gateDir, "artifacts");
    for (const name of [
      "browser-parent.json",
      "g15-child-context.json",
      "g15-oidc-fixture-lineage.json",
      "g15-child-browser-runtime.json",
      "g15-browser-child.bundle",
      "g15-base-platform.yaml",
      "g15-child-platform.yaml",
    ])
      additions.push(await hashFile(join(artifactRoot, name)));
  }
  if (gate.id === "preflight") {
    const path = join(gateDir, "artifacts/preflight.json");
    let output;
    try {
      output = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return "preflight missing or invalid artifacts/preflight.json";
    }
    const kafkaPlan = output.checks?.find(
      (check) => check.id === "KAFKA_NAMESPACE_PLAN",
    );
    const valid =
      output.schemaVersion === 1 &&
      output.gateId === gate.id &&
      output.runId === context.runId &&
      output.candidateSha === context.candidateSha &&
      output.status === "PASS" &&
      Array.isArray(output.checks) &&
      output.checks.every((check) => check.status === "PASS") &&
      kafkaPlan?.status === "PASS" &&
      kafkaPlan.facts?.committedFlagEnabled === true &&
      kafkaPlan.facts?.baseConfigShaMatchesContext === true &&
      kafkaPlan.facts?.baseConfigSha256 === context.baseConfigSha256 &&
      kafkaPlan.facts?.candidateContextValid === true &&
      Array.isArray(kafkaPlan.facts?.expectedPhysical?.topics) &&
      Array.isArray(kafkaPlan.facts?.expectedPhysical?.groups);
    if (!valid)
      return "preflight result is FAIL or does not identify this run/candidate";
    additions.push(await hashFile(path));
  }
  const composeCommandSucceeded =
    record.runs.length === 1 &&
    record.runs.every(
      (run) => run.exitCode === 0 && !run.timedOut && !run.outputLimitExceeded,
    );
  if (gate.id === "compose" && composeCommandSucceeded) {
    const preflightPath = join(
      evidenceDir,
      "gates/preflight/artifacts/preflight.json",
    );
    let preflight;
    try {
      preflight = JSON.parse(await readFile(preflightPath, "utf8"));
    } catch {
      return "compose missing preflight Kafka namespace plan";
    }
    const kafkaPlan = preflight.checks?.find(
      (check) => check.id === "KAFKA_NAMESPACE_PLAN",
    );
    const expectedTopics = kafkaPlan?.facts?.expectedPhysical?.topics;
    const expectedGroups = kafkaPlan?.facts?.expectedPhysical?.groups;
    if (
      preflight.status !== "PASS" ||
      preflight.runId !== context.runId ||
      preflight.candidateSha !== context.candidateSha ||
      kafkaPlan?.status !== "PASS" ||
      kafkaPlan.facts.committedFlagEnabled !== true ||
      kafkaPlan.facts.baseConfigSha256 !== context.baseConfigSha256 ||
      kafkaPlan.facts.baseConfigShaMatchesContext !== true ||
      kafkaPlan.facts.candidateContextValid !== true
    )
      return "compose has no context-bound committed Kafka namespace plan";
    try {
      additions.push(
        await captureKafkaNamespaceArtifact({
          evidenceDir,
          gateDir,
          context,
          expectedTopics,
          expectedGroups,
        }),
      );
    } catch {
      return "compose missing or invalid Kafka namespace inventory receipt";
    }
  }
  if (gate.id === "aroma_sandbox" && record.status !== "FAIL") {
    try {
      const contextPath = join(evidenceDir, "context.json");
      const parentIdentity = await validateLaunchContext(contextPath);
      const { verifyControlledAromaSandboxEvidence } =
        await import("./scenarios/aroma-sandbox.mjs");
      await verifyControlledAromaSandboxEvidence({
        parentIdentity,
        parentContextPath: contextPath,
      });
    } catch {
      return "aroma_sandbox controlled child failed parent binding, signature, runtime proof or cleanup validation";
    }
    for (const name of [
      "controlled-parent.json",
      "controlled-child-context.json",
      "controlled-child-result.json",
      "controlled-approval.json.age",
      "controlled-approval.sig.age",
      "controlled-config.bundle",
      "controlled-config.bundle.json",
    ])
      additions.push(await hashFile(join(gateDir, "artifacts", name)));
  }
  if (gate.id === "rollback" && record.status !== "FAIL") {
    try {
      const contextPath = join(evidenceDir, "context.json");
      const parentIdentity = await validateLaunchContext(contextPath);
      await verifyControlledRollbackEvidence({
        parentIdentity,
        parentContextPath: contextPath,
      });
    } catch {
      return "rollback controlled child failed parent binding, lineage, runtime proof, images or cleanup validation";
    }
    for (const name of [
      "rollback-parent.json",
      "rollback-child-context.json",
      "mutation-disable-rollback.json",
      "rollback-config-lineage.bundle",
      "rollback-runtime-lineage.bundle",
    ])
      additions.push(await hashFile(join(gateDir, "artifacts", name)));
  }
  if (gate.id === "report") {
    const result = JSON.parse(
      await readFile(join(evidenceDir, "decision.json"), "utf8").catch(
        () => "null",
      ),
    );
    if (
      !result ||
      result.runId !== context.runId ||
      result.candidateSha !== context.candidateSha ||
      !["ДОПУСТИТЬ", "НЕ ДОПУСТИТЬ"].includes(result.decision)
    )
      return "report decision.json отсутствует или относится к другому run/SHA";
    const reportPath = join(
      context.sourceRepoRoot,
      "docs/reports/launch",
      context.runId,
      "ОТЧЁТ.md",
    );
    const checksumPath = join(evidenceDir, "checksums.sha256");
    try {
      await access(reportPath);
      await access(checksumPath);
    } catch {
      return "report не создал ОТЧЁТ.md и checksums.sha256";
    }
    try {
      await validateChecksumManifest(
        evidenceDir,
        context.sourceRepoRoot,
        context.runId,
      );
    } catch (error) {
      return `report checksums manifest invalid: ${redactText(error.message)}`;
    }
  }
  record.artifacts.push(...additions);
  return null;
}

async function aggregateLogs(paths, target) {
  const { createReadStream, createWriteStream } = await import("node:fs");
  const output = createWriteStream(target, { flags: "wx", mode: 0o600 });
  try {
    for (const path of paths) {
      for await (const chunk of createReadStream(path))
        await writeChunk(output, chunk);
    }
    await new Promise((resolvePromise, reject) =>
      output.end((error) => (error ? reject(error) : resolvePromise())),
    );
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function saveCommandsNdjson(evidenceDir, gates) {
  const lines = [];
  for (const gate of gates)
    for (const run of gate.runs)
      lines.push(JSON.stringify({ gateId: gate.id, ...run }));
  const path = join(evidenceDir, "commands.ndjson");
  await writeFile(path, `${lines.join("\n")}${lines.length ? "\n" : ""}`, {
    mode: 0o600,
  });
  return path;
}

function dependencyStatus(gate, records) {
  const failed = gate.predecessors.filter(
    (id) => records.find((entry) => entry.id === id)?.status !== "PASS",
  );
  return failed;
}

function formatPnpmVersion(output) {
  const match = output.match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? "unknown";
}

function assertRuntimeImageBaselineHash(ownership) {
  if (!ownership.baseline) return;
  const hash = createHash("sha256")
    .update(JSON.stringify(ownership.baseline))
    .digest("hex");
  if (hash !== ownership.baselineSha256)
    throw new Error("runtime image baseline hash mismatch");
}

export function finishRuntimeImageOwnership(
  ownership,
  ownerGate,
  cleanup = cleanupLaunchRuntimeImages,
) {
  try {
    assertRuntimeImageBaselineHash(ownership);
    cleanup(
      ownership.projectName,
      ownership.images,
      undefined,
      ownership.baseline,
    );
    ownership.phase = "cleaned";
    return true;
  } catch (error) {
    ownership.phase = "cleanup-failed";
    ownerGate.status = "FAIL";
    ownerGate.reason = `Runtime image cleanup failed: ${redactText(error.message)}`;
    return false;
  }
}

export async function runGate(
  gate,
  record,
  evidenceDir,
  candidate,
  contextPath,
  runStart,
  runEpochMs,
  outputBudget,
  migrationsExpectedSystemIdentifier,
  realtimeQualificationPath,
  imageManifestPath,
  g16SignerPath,
  dataTempDir,
) {
  if (outputBudget.exceeded && gate.id !== "report") {
    record.reason =
      "NOT_RUN: исчерпан общий budget stdout/stderr; downstream commands не запускаются";
    record.endedAt = nowIso();
    await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
      mode: 0o600,
    });
    await writeFile(
      join(evidenceDir, "gates", gate.id, "stderr.log"),
      `${record.reason}\n`,
      { mode: 0o600 },
    );
    await updateGateArtifact(evidenceDir, record);
    return;
  }
  const failedPredecessors = dependencyStatus(gate, runStart);
  if (failedPredecessors.length && gate.id !== "report") {
    record.reason = `NOT_RUN: predecessor не PASS: ${failedPredecessors.join(", ")}`;
    record.endedAt = nowIso();
    await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
      mode: 0o600,
    });
    await writeFile(
      join(evidenceDir, "gates", gate.id, "stderr.log"),
      `${record.reason}\n`,
      { mode: 0o600 },
    );
    await updateGateArtifact(evidenceDir, record);
    return;
  }
  if (gate.id === "aroma_sandbox" && !g16SignerPath) {
    record.reason =
      "NOT_RUN: --g16-signer отсутствует; controlled-live aroma_sandbox требует RAM signer";
    record.endedAt = nowIso();
    await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
      mode: 0o600,
    });
    await writeFile(
      join(evidenceDir, "gates", gate.id, "stderr.log"),
      `${record.reason}\n`,
      { mode: 0o600 },
    );
    await updateGateArtifact(evidenceDir, record);
    return;
  }
  record.startedAt = nowIso();
  record.reason = "";
  const started = Date.now();
  let realtimeQualification;
  if (gate.id === "observability") {
    try {
      if (!realtimeQualificationPath)
        throw new Error("qualification receipt is required");
      const admitted = await admitRealtimeCapacity({
        receiptPath: realtimeQualificationPath,
        contextFile: contextPath,
      });
      realtimeQualification = { ...admitted, admittedAt: nowIso() };
      const path = join(
        evidenceDir,
        "gates",
        gate.id,
        "artifacts",
        "realtime-capacity.json",
      );
      await writeFile(
        path,
        `${JSON.stringify(realtimeQualification, null, 2)}\n`,
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      record.artifacts.push(await hashFile(path));
      if (Date.now() - started >= gate.timeout * 1000)
        throw new Error(
          "qualification admission exhausted the observability budget",
        );
    } catch (error) {
      record.status = "FAIL";
      record.reason = `observability realtime qualification admission failed: ${redactText(error.message)}`;
      record.durationMs = Date.now() - started;
      record.endedAt = nowIso();
      await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
        mode: 0o600,
      });
      await writeFile(
        join(evidenceDir, "gates", gate.id, "stderr.log"),
        `${record.reason}\n`,
        { mode: 0o600 },
      );
      await updateGateArtifact(evidenceDir, record);
      return;
    }
  }
  if (gate.id === "migrations") {
    if (
      typeof migrationsExpectedSystemIdentifier !== "string" ||
      !/^[0-9]{1,20}$/u.test(migrationsExpectedSystemIdentifier)
    )
      record.reason =
        "migrations: требуется утверждённый system identifier PostgreSQL";
    else {
      try {
        const { context } = await validateLaunchContext(contextPath);
        await writeFile(
          join(
            evidenceDir,
            "gates",
            gate.id,
            "artifacts",
            "approved-target.json",
          ),
          `${JSON.stringify({
            schemaVersion: 1,
            runId: context.runId,
            candidateSha: context.candidateSha,
            baseConfigSha256: context.baseConfigSha256,
            systemIdentifier: migrationsExpectedSystemIdentifier,
          })}\n`,
          { flag: "wx", mode: 0o400 },
        );
      } catch {
        record.reason = "migrations: не удалось сохранить утверждённый target";
      }
    }
    if (record.reason) {
      record.status = "FAIL";
      record.durationMs = Date.now() - started;
      record.endedAt = nowIso();
      await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
        mode: 0o600,
      });
      await writeFile(
        join(evidenceDir, "gates", gate.id, "stderr.log"),
        `${record.reason}\n`,
        { mode: 0o600 },
      );
      await updateGateArtifact(evidenceDir, record);
      return;
    }
  }
  const commands = splitCommand(gate.command);
  for (let index = 0; index < commands.length; index += 1) {
    const argv = commands[index];
    const logBase = join(evidenceDir, "gates", gate.id);
    const stdoutPath = join(
      logBase,
      `stdout${commands.length > 1 ? `-${index + 1}` : ""}.log`,
    );
    const stderrPath = join(
      logBase,
      `stderr${commands.length > 1 ? `-${index + 1}` : ""}.log`,
    );
    const remainingTotal = TOTAL_TIMEOUT_MS - (Date.now() - runEpochMs);
    const timeoutMs = Math.min(
      Math.max(
        1,
        gate.timeout * 1000 -
          (["migrations", "observability"].includes(gate.id)
            ? Date.now() - started
            : 0),
      ),
      Math.max(1, gateBudgetMs(gate.id, remainingTotal)),
    );
    let run;
    try {
      run = await executeArgv(
        argv,
        candidate,
        timeoutMs,
        stdoutPath,
        stderrPath,
        contextPath,
        outputBudget,
        {
          imageManifestPath,
          gateId: gate.id,
          dataTempDir,
          g16SignerPath:
            gate.id === "aroma_sandbox" ? g16SignerPath : undefined,
          deadlineEpochMs: Date.now() + timeoutMs,
        },
      );
    } catch (error) {
      run = {
        argv,
        cwd: candidate,
        startedAt: nowIso(),
        endedAt: nowIso(),
        exitCode: null,
        timedOut: false,
        outputLimitExceeded: false,
        timeoutMs,
        durationMs: 0,
        peakRssBytes: null,
        artifacts: [],
      };
      record.reason = `Ошибка запуска/сбора evidence: ${redactText(error.message)}`;
    }
    record.runs.push(run);
    if (
      run.exitCode !== 0 ||
      run.timedOut ||
      run.outputLimitExceeded ||
      run.peakRssBytes === null ||
      record.reason
    ) {
      record.status = "FAIL";
      if (!record.reason)
        record.reason = run.outputLimitExceeded
          ? "Превышен общий предел stdout/stderr; process group остановлена, evidence обрезано с маркером"
          : run.timedOut
            ? "Превышен timeout"
            : run.peakRssBytes === null
              ? "Не удалось измерить peak RSS"
              : `Команда завершилась с кодом ${run.exitCode}`;
      break;
    }
  }
  if (commands.length > 1) {
    const logBase = join(evidenceDir, "gates", gate.id);
    await aggregateLogs(
      record.runs.map((_, index) => join(logBase, `stdout-${index + 1}.log`)),
      join(logBase, "stdout.log"),
    );
    await aggregateLogs(
      record.runs.map((_, index) => join(logBase, `stderr-${index + 1}.log`)),
      join(logBase, "stderr.log"),
    );
  }
  const artifactError = await verifyGateArtifacts(
    gate,
    record,
    evidenceDir,
    realtimeQualification,
  );
  if (artifactError) {
    record.status = "FAIL";
    record.reason = record.reason
      ? `${record.reason}; ${artifactError}`
      : artifactError;
  }
  record.durationMs = Date.now() - started;
  record.endedAt = nowIso();
  if (gate.id === "observability" && record.durationMs > gate.timeout * 1000) {
    record.status = "FAIL";
    record.reason = record.reason
      ? `${record.reason}; Превышен timeout observability`
      : "Превышен timeout observability";
  }
  if (record.status !== "FAIL") record.status = "PASS";
  await updateGateArtifact(evidenceDir, record);
}

export async function readLaunchImageEvidence({
  contextFile,
  evidenceDir,
  result,
  readRuntimeImages = readVerifiedRuntimeImages,
  readStorageImage = loadVerifiedGateImage,
}) {
  const context = JSON.parse(await readFile(contextFile, "utf8"));
  if (
    context.runId !== result.runId ||
    context.candidateSha !== result.candidateSha ||
    context.baseConfigSha256 !== result.environment.configSha256 ||
    resolve(context.evidenceDir ?? "") !== resolve(evidenceDir)
  )
    throw new Error("G12_IMAGE_CONTEXT_MISMATCH");
  const preflightGate = result.gates.find((entry) => entry.id === "preflight");
  if (preflightGate?.status !== "PASS")
    throw new Error("G12_IMAGE_PREFLIGHT_NOT_PASSED");
  const path = join(evidenceDir, "gates/preflight/artifacts/preflight.json");
  await assertNoSymlinkPath(evidenceDir, path);
  const bytes = await readFile(path);
  const matchingArtifacts = preflightGate.artifacts.filter(
    (entry) => resolve(entry.path) === path,
  );
  if (
    matchingArtifacts.length !== 1 ||
    matchingArtifacts[0].sha256 !==
      createHash("sha256").update(bytes).digest("hex") ||
    matchingArtifacts[0].sizeBytes !== bytes.length
  )
    throw new Error("G12_IMAGE_PREFLIGHT_HASH_MISMATCH");
  const preflight = JSON.parse(bytes.toString("utf8"));
  const checks = preflight.checks?.filter(
    (entry) => entry.id === "NATIVE_IMAGE_RUNTIME_IDENTITY",
  );
  const native = checks?.[0]?.facts?.actualRuntimeProof?.node;
  const declaredNode = checks?.[0]?.facts?.declaredBomImages?.node;
  if (
    preflight.schemaVersion !== 1 ||
    preflight.gateId !== "preflight" ||
    preflight.status !== "PASS" ||
    preflight.runId !== context.runId ||
    preflight.candidateSha !== context.candidateSha ||
    checks?.length !== 1 ||
    checks[0].status !== "PASS" ||
    native?.status !== "PASS" ||
    native.cleanupSucceeded !== true ||
    native.os !== "linux" ||
    native.architecture !== "amd64" ||
    !/^sha256:[a-f0-9]{64}$/u.test(native.imageId ?? "")
  )
    throw new Error("G12_IMAGE_NATIVE_PROOF_INVALID");
  const [images, storage] = await Promise.all([
    readRuntimeImages({ contextFile }),
    readStorageImage({
      target: "storage-helper",
      contextFile,
      loadImage: false,
    }),
  ]);
  const digest = /@(?<digest>sha256:[a-f0-9]{64})$/u.exec(
    storage.baseImage ?? "",
  )?.groups?.digest;
  if (
    storage.runId !== context.runId ||
    storage.candidateSha !== context.candidateSha ||
    declaredNode !== storage.baseImage ||
    !digest ||
    !native.repoDigest?.endsWith(`@${digest}`)
  )
    throw new Error("G12_IMAGE_NODE_BASE_MISMATCH");
  return {
    nodeImageDigest: native.imageId,
    imageDigests: images.map(({ imageId }) => imageId),
  };
}

async function writeEnvironment(evidenceDir, result) {
  const env = {
    runId: result.runId,
    dirty: false,
    sourceSha: result.sourceSha,
    candidateSha: result.candidateSha,
    capturedAt: result.startedAt,
    timezone: result.environment.timezone,
    platform: result.environment.platform,
    arch: result.environment.arch,
    osRelease: result.environment.osRelease,
    cpuCount: result.environment.cpuCount,
    memoryBytes: result.environment.memoryBytes,
    node: result.environment.node,
    pnpm: result.environment.pnpm,
    treeSha: result.environment.treeSha,
    nodeImageDigest: result.environment.nodeImageDigest,
    toolVersions: result.environment.toolVersions,
    configSha256: result.environment.configSha256,
    encryptedSecretsSha256: result.environment.encryptedSecretsSha256,
    toolchainVersionsSha256: result.environment.toolchainVersionsSha256,
    lockfileSha256: result.environment.lockfileSha256,
    imageDigests: result.environment.imageDigests,
    resources: result.environment.resources,
    candidatePath: result.environment.candidatePath,
  };
  await atomicJson(join(evidenceDir, "environment.json"), env);
}

export async function applyLaunchImageEvidence({
  contextFile,
  evidenceDir,
  result,
  gate,
  record,
  workloadDeadline,
  readEvidence = readLaunchImageEvidence,
  persist = writeEnvironment,
  now = Date.now,
}) {
  const originalNodeDigest = result.environment.nodeImageDigest;
  const originalImageDigests = result.environment.imageDigests;
  let environmentWritten = false;
  try {
    const images = await readEvidence({ contextFile, evidenceDir, result });
    record.durationMs = now() - Date.parse(record.startedAt);
    record.endedAt = nowIso();
    if (record.durationMs > gate.timeout * 1000 || now() >= workloadDeadline)
      throw new Error(
        "supply_chain image evidence validation exceeded its budget",
      );
    result.environment.nodeImageDigest = images.nodeImageDigest;
    result.environment.imageDigests = images.imageDigests;
    await persist(evidenceDir, result);
    environmentWritten = true;
    record.durationMs = now() - Date.parse(record.startedAt);
    record.endedAt = nowIso();
    if (record.durationMs > gate.timeout * 1000 || now() >= workloadDeadline)
      throw new Error(
        "supply_chain image evidence validation exceeded its budget",
      );
  } catch (error) {
    let failure = error;
    result.environment.nodeImageDigest = originalNodeDigest;
    result.environment.imageDigests = originalImageDigests;
    if (environmentWritten) {
      try {
        await persist(evidenceDir, result);
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "supply_chain image evidence rollback failed",
        );
      }
    }
    record.durationMs = now() - Date.parse(record.startedAt);
    record.endedAt = nowIso();
    record.status = "FAIL";
    record.reason = `supply_chain image evidence validation failed: ${redactText(failure.message)}`;
  }
}

// Hold each source directory open so a renamed or replaced path cannot redirect copying.
export async function executeRun(options = {}) {
  const runnerStartedAt = Date.now();
  const dataTempDir =
    options.dataTempDir === undefined
      ? undefined
      : await validateLaunchDataTempDir(options.dataTempDir);
  const matrix = await loadMatrix();
  const state = await sourceState();
  if (state.status)
    throw new Error(
      "Исходный каталог dirty; fail-closed: runner остановлен до создания checkout",
    );
  const candidateSha = options.candidateSha ?? state.sourceSha;
  if (!/^[0-9a-f]{40}$/.test(candidateSha))
    throw new Error("candidate SHA должен быть полным lowercase SHA-1");
  const resolved = await git(
    ROOT,
    "rev-parse",
    "--verify",
    `${candidateSha}^{commit}`,
  );
  if (resolved !== candidateSha)
    throw new Error("candidate SHA не является разрешимым commit object");
  const checkout = await makeCandidateCheckout(candidateSha);
  let imageOwnership;
  let imageOwnershipPath;
  let launchArtifactManifestPath;
  let imageCleanupVerified = false;
  let imageCleanupReported = false;
  try {
    const startedAt = nowIso();
    const runId = `${startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${candidateSha.slice(0, 7)}`;
    const evidenceDir = await initializeEvidence(runId);
    const baseConfigSha256 = (
      await hashFile(join(checkout.candidate, "config/platform.yaml"))
    ).sha256;
    const contextPath = await writeContext(
      evidenceDir,
      candidateSha,
      checkout.candidate,
      options.githubSnapshotPath,
      options.acceptedBaseCommit,
      runId,
      startedAt,
      baseConfigSha256,
    );
    const version = async (command, args) =>
      runCapture(command, args, checkout.candidate)
        .then((output) =>
          output.code === 0 ? redactText(output.stdout || output.stderr) : null,
        )
        .catch(() => null);
    const [
      pnpmVersion,
      dockerVersion,
      composeVersion,
      postgresVersion,
      kafkaVersion,
      browserVersion,
    ] = await Promise.all([
      version("pnpm", ["--version"]),
      version("docker", ["--version"]),
      version("docker", ["compose", "version", "--short"]),
      version("psql", ["--version"]),
      version("kafka-topics", ["--version"]),
      version("chromium", ["--version"]),
    ]);
    const optionalSha256 = async (path) => {
      try {
        return (await hashFile(path)).sha256;
      } catch {
        return null;
      }
    };
    const [encryptedSecretsSha256, toolchainVersionsSha256, lockfileSha256] =
      await Promise.all([
        optionalSha256(
          join(checkout.candidate, "secrets/platform.secrets.sops.yaml"),
        ),
        optionalSha256(
          join(checkout.candidate, "config/toolchain-versions.json"),
        ),
        optionalSha256(join(checkout.candidate, "pnpm-lock.yaml")),
      ]);
    const databaseOwnership = JSON.parse(
      await readFile(
        join(checkout.candidate, "config/database-ownership.json"),
        "utf8",
      ),
    );
    const { deriveLaunchDatabaseName } = await import(
      pathToFileURL(
        join(
          checkout.candidate,
          "packages/platform-config/src/launch-database-target.ts",
        ),
      ).href
    );
    const launchIdentity = {
      schemaVersion: 1,
      runId,
      candidateSha,
      baseConfigSha256,
    };
    const databaseNames = databaseOwnership.databases.map(({ owner }) =>
      deriveLaunchDatabaseName(launchIdentity, owner),
    );
    if (databaseNames.length !== 5 || new Set(databaseNames).size !== 5)
      throw new Error("canonical launch database owner set is invalid");
    const treeSha = await git(checkout.candidate, "rev-parse", "HEAD^{tree}");
    const result = {
      schemaVersion: 1,
      runId,
      candidateSha,
      sourceSha: state.sourceSha,
      startedAt,
      endedAt: startedAt,
      environment: {
        runId,
        dirty: false,
        platform: process.platform,
        osRelease: release(),
        arch: process.arch,
        cpuCount: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        pnpm: formatPnpmVersion(pnpmVersion ?? "unknown"),
        nodeImageDigest: null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        candidatePath: checkout.candidate,
        toolVersions: {
          docker: dockerVersion,
          compose: composeVersion,
          postgres: postgresVersion,
          kafka: kafkaVersion,
          browser: browserVersion,
        },
        treeSha,
        configSha256: baseConfigSha256,
        encryptedSecretsSha256,
        toolchainVersionsSha256,
        lockfileSha256,
        imageDigests: null,
        resources: {
          composeProject: {
            name: `coffee-launch-${runId.toLowerCase()}`,
            created: false,
          },
          databases: databaseNames.map((name) => ({ name, created: false })),
          kafkaPrefix: { name: runId, created: false },
        },
      },
      gates: matrix.gates.map(gateRecord),
      decision: "НЕ ДОПУСТИТЬ",
    };
    const resultPath = join(evidenceDir, "run-result.json");
    const save = async () => {
      result.endedAt = nowIso();
      result.decision = decisive(result.gates);
      await validateRunResult(result);
      await atomicJson(resultPath, result);
    };
    await writeEnvironment(evidenceDir, result);
    await save();
    const runEpochMs = runnerStartedAt;
    const outputBudget = {
      maxBytes: Math.floor(MAX_RUN_LOG_BYTES / 2),
      usedBytes: 0,
      observedBytes: 0,
      exceeded: false,
    };
    const totalDeadline = runEpochMs + TOTAL_TIMEOUT_MS;
    const workloadDeadline = totalDeadline - REPORT_TOTAL_RESERVE_MS;
    for (let index = 0; index < matrix.gates.length; index += 1) {
      const gate = matrix.gates[index];
      const record = result.gates[index];
      if (
        gate.id === "integration" &&
        !outputBudget.exceeded &&
        Date.now() < workloadDeadline &&
        dependencyStatus(gate, result.gates).length === 0
      ) {
        try {
          const images = await readVerifiedRuntimeImages({
            contextFile: contextPath,
          });
          const projectName = `coffee-launch-${runId.toLowerCase()}`;
          const inventory = inspectLaunchRuntimeImages(projectName, images);
          const baseline = captureRuntimeImageBaseline(inventory);
          imageOwnership = {
            runId,
            candidateSha,
            projectName,
            images,
            baseline,
            baselineSha256: createHash("sha256")
              .update(JSON.stringify(baseline))
              .digest("hex"),
            phase: "baseline",
          };
          const path = join(
            evidenceDir,
            "gates/integration/artifacts/runtime-image-ownership.json",
          );
          await atomicJson(path, imageOwnership);
          await chmod(path, 0o400);
          imageOwnershipPath = path;
        } catch (error) {
          record.status = "FAIL";
          record.reason = `Runtime image ownership preflight failed: ${redactText(error.message)}`;
          record.endedAt = nowIso();
          await writeFile(
            join(evidenceDir, "gates", gate.id, "stdout.log"),
            "",
            { mode: 0o600 },
          );
          await writeFile(
            join(evidenceDir, "gates", gate.id, "stderr.log"),
            `${record.reason}\n`,
            { mode: 0o600 },
          );
          await updateGateArtifact(evidenceDir, record);
          await save();
          continue;
        }
      }
      if (gate.id === "report") {
        if (imageOwnershipPath) {
          const ownerGate = result.gates.find(
            (item) => item.id === "integration",
          );
          imageCleanupVerified = finishRuntimeImageOwnership(
            imageOwnership,
            ownerGate,
          );
          imageCleanupReported = !imageCleanupVerified;
          await atomicJson(imageOwnershipPath, imageOwnership);
          await chmod(imageOwnershipPath, 0o400);
          ownerGate.artifacts.push(await hashFile(imageOwnershipPath));
          await updateGateArtifact(evidenceDir, ownerGate);
        }
        await writeDefects(evidenceDir, ROOT, result);
        await atomicJson(
          join(evidenceDir, "gates", gate.id, "result.json"),
          record,
        );
        await save();
      }
      if (Date.now() >= workloadDeadline && gate.id !== "report") {
        record.reason =
          "NOT_RUN: остановлено для резерва report и финализации внутри общего лимита 120 минут";
        record.endedAt = nowIso();
        await writeFile(join(evidenceDir, "gates", gate.id, "stdout.log"), "", {
          mode: 0o600,
        });
        await writeFile(
          join(evidenceDir, "gates", gate.id, "stderr.log"),
          `${record.reason}\n`,
          { mode: 0o600 },
        );
        await updateGateArtifact(evidenceDir, record);
        await save();
        continue;
      }
      await runGate(
        gate,
        record,
        evidenceDir,
        checkout.candidate,
        contextPath,
        result.gates,
        runEpochMs,
        outputBudget,
        options.migrationsExpectedSystemIdentifier,
        options.realtimeQualificationPath,
        launchArtifactManifestPath,
        options.g16SignerPath,
        dataTempDir,
      );
      if (gate.id === "supply_chain" && record.status === "PASS") {
        await applyLaunchImageEvidence({
          contextFile: contextPath,
          evidenceDir,
          result,
          gate,
          record,
          workloadDeadline,
        });
        if (record.status === "PASS")
          launchArtifactManifestPath = artifactManifestPath(evidenceDir);
        await updateGateArtifact(evidenceDir, record);
      }
      if (
        gate.id === "integration" &&
        imageOwnershipPath &&
        record.status === "PASS"
      ) {
        try {
          validateRuntimeImageOwnership(
            inspectLaunchRuntimeImages(
              imageOwnership.projectName,
              imageOwnership.images,
            ),
            imageOwnership.baseline,
            "ready",
          );
          imageOwnership.phase = "ready";
          await atomicJson(imageOwnershipPath, imageOwnership);
          await chmod(imageOwnershipPath, 0o400);
        } catch (error) {
          record.status = "FAIL";
          record.reason = `Runtime image retention failed: ${redactText(error.message)}`;
          await updateGateArtifact(evidenceDir, record);
        }
      }
      await saveCommandsNdjson(evidenceDir, result.gates);
      await save();
    }
    result.decision = decisive(result.gates);
    await save();
    const reportResult = await runCapture(
      process.execPath,
      [join(BASE, "report.mjs"), "--finalize", evidenceDir],
      ROOT,
      Math.max(1, TOTAL_TIMEOUT_MS - (Date.now() - runnerStartedAt)),
    ).catch((error) => ({ code: 1, stderr: error.message }));
    if (reportResult.code !== 0) {
      const reportGate = result.gates[19];
      reportGate.status = "FAIL";
      reportGate.reason = `Финализация отчёта завершилась с кодом ${reportResult.code}`;
      reportGate.endedAt = nowIso();
      await updateGateArtifact(evidenceDir, reportGate);
      await save();
      await runCapture(
        process.execPath,
        [join(BASE, "report.mjs"), "--finalize", evidenceDir],
        ROOT,
        Math.max(1, TOTAL_TIMEOUT_MS - (Date.now() - runnerStartedAt)),
      ).catch(() => {});
    }
    const finalResult = JSON.parse(await readFile(resultPath, "utf8"));
    return {
      result: finalResult,
      evidenceDir,
      candidatePath: checkout.candidate,
    };
  } finally {
    try {
      if (imageOwnershipPath && !imageCleanupVerified) {
        assertRuntimeImageBaselineHash(imageOwnership);
        cleanupLaunchRuntimeImages(
          imageOwnership.projectName,
          imageOwnership.images,
          undefined,
          imageOwnership.baseline,
        );
        imageOwnership.phase = imageCleanupReported
          ? "cleanup-failed"
          : "cleaned";
        await atomicJson(imageOwnershipPath, imageOwnership);
        await chmod(imageOwnershipPath, 0o400);
      }
    } finally {
      await rm(checkout.parent, { recursive: true, force: true });
    }
  }
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--candidate-sha") options.candidateSha = argv[++index];
    else if (argv[index] === "--github-snapshot")
      options.githubSnapshotPath = resolve(argv[++index]);
    else if (argv[index] === "--accepted-base-commit")
      options.acceptedBaseCommit = argv[++index];
    else if (argv[index] === "--g16-signer") {
      const path = argv[++index];
      if (
        options.g16SignerPath !== undefined ||
        typeof path !== "string" ||
        !isAbsolute(path)
      )
        throw new Error("--g16-signer requires one absolute path");
      options.g16SignerPath = resolve(path);
    } else if (argv[index] === "--data-temp-dir") {
      const path = argv[++index];
      if (
        options.dataTempDir !== undefined ||
        typeof path !== "string" ||
        !isAbsolute(path) ||
        resolve(path) !== path
      )
        throw new Error("--data-temp-dir requires one absolute canonical path");
      options.dataTempDir = path;
    } else if (argv[index] === "--realtime-qualification") {
      const path = argv[++index];
      if (options.realtimeQualificationPath !== undefined)
        throw new Error("--realtime-qualification may be specified only once");
      if (typeof path !== "string" || !isAbsolute(path))
        throw new Error(
          "--realtime-qualification requires an absolute receipt path",
        );
      options.realtimeQualificationPath = path;
    } else if (argv[index] === "--g08-expected-system-identifier") {
      const identifier = argv[++index];
      if (!/^[0-9]{1,20}$/u.test(identifier ?? ""))
        throw new Error(
          "--g08-expected-system-identifier требует утверждённый system identifier",
        );
      options.migrationsExpectedSystemIdentifier = identifier;
    } else throw new Error(`Неизвестный аргумент: ${argv[index]}`);
  }
  return options;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { result, evidenceDir } = await executeRun(
      parseArgs(process.argv.slice(2)),
    );
    console.log(
      `${result.decision}: ${result.runId} (${relativeEvidencePath(evidenceDir)})`,
    );
    if (result.decision !== "ДОПУСТИТЬ") process.exitCode = 1;
  } catch (error) {
    console.error(
      redactText(error.stack ?? error.message, sensitiveEnvironmentValues()),
    );
    process.exitCode = 1;
  }
}
