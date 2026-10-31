import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { loadPlatformConfig } from "../../scripts/config-lib.mjs";
import {
  createAlertDefinitions,
  createGrafanaAlertProvisioning,
  newRunId,
} from "./alerts.mjs";
import {
  discoverContainerLogs,
  createAlloyConfig,
  createComposeOverride,
  createRuntimeLoggingOverride,
  createBackendConfigs,
  ensureBackendOwnership,
  ensureCollectorConfigOwnership,
  prometheusMetricName,
  verifyBootstrapProbe,
  OBSERVABILITY_TARGETS,
} from "./generate.mjs";
import {
  ensurePrivateSecretDirectory,
  writePrivateSecret,
} from "../config-bootstrap/index.mjs";
import {
  loadVerifiedGateImage,
  removeVerifiedGateImage,
  readVerifiedRuntimeImages,
} from "../verified-infrastructure-image.mjs";
import { provisionStorage, removeStorage } from "./storage.mjs";
import { validateLaunchContext } from "../../verification/launch/v1/report.mjs";
import {
  validateDependencyReadiness,
  runtimeMetricFamilies,
  sanitizeRuntimeMetricMatches,
} from "../../tests/observability/runtime-matrix.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NODE_RUNTIME_TARGETS = OBSERVABILITY_TARGETS.filter(
  (runtime) => runtime !== "edge-nginx",
);
export async function validateG14TelemetrySources({
  payload,
  projectName,
  verifiedImages,
  runDocker,
}) {
  if (
    !payload ||
    payload.projectName !== projectName ||
    !Array.isArray(payload.runtimes) ||
    payload.runtimes.length !== NODE_RUNTIME_TARGETS.length ||
    !NODE_RUNTIME_TARGETS.every((role) => payload.runtimes.includes(role))
  )
    throw new Error("G14 runtime identity invalid");
  const imageByRole = new Map(
    verifiedImages.map(({ service, imageId }) => [service, imageId]),
  );
  const names = [
    "coffee_edge_backend",
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_kafka_event",
  ];
  const networkIds = new Map();
  const networks = names.map((name) => {
    const expected = `${projectName}_${name}`;
    if (payload.networks?.[name] !== expected)
      throw new Error("G14 network name invalid");
    const rows = JSON.parse(runDocker(["network", "inspect", expected]));
    const network = rows[0];
    if (
      rows.length !== 1 ||
      network?.Name !== expected ||
      !/^[a-f0-9]{64}$/u.test(network.Id ?? "") ||
      network.Internal !== true ||
      network.Labels?.["com.docker.compose.project"] !== projectName ||
      network.Labels?.["com.docker.compose.network"] !== name
    )
      throw new Error("G14 network identity invalid");
    networkIds.set(expected, network.Id);
    return expected;
  });
  const logFiles = await discoverContainerLogs({ projectName, runDocker });
  if (
    logFiles.length !== OBSERVABILITY_TARGETS.length ||
    imageByRole.size !== OBSERVABILITY_TARGETS.length
  )
    throw new Error("G14 runtime inventory incomplete");
  for (const { service, containerId } of logFiles) {
    const rows = JSON.parse(runDocker(["inspect", containerId]));
    const container = rows[0];
    if (
      rows.length !== 1 ||
      container?.Id !== containerId ||
      container.Image !== imageByRole.get(service) ||
      !networks.some(
        (name) =>
          container.NetworkSettings?.Networks?.[name]?.NetworkID ===
          networkIds.get(name),
      )
    )
      throw new Error("G14 runtime image or network invalid");
  }
  return { logFiles, networks };
}

const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const docker = (args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  }).trim();

function basicAuthorization(email, password) {
  return `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`;
}

export function parseTempoStatusConfigResponse(text) {
  const prefix = "GET /status/config\n---\n";
  if (typeof text !== "string" || !text.startsWith(prefix))
    throw new Error("Tempo configuration status response header invalid");
  const config = loadYaml(text.slice(prefix.length));
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error(
      "Tempo configuration status response must contain a mapping",
    );
  return config;
}

function verifyDockerLogRotation({
  run,
  nodeImage,
  logFile,
  maxFiles,
  maxSizeMiB,
  maxRecordBytes,
}) {
  const baseName = basename(logFile.logPath);
  const suffixes = Array.from({ length: maxFiles + 1 }, (_, suffix) => suffix);
  const probe = `const fs=require('node:fs'),base=${JSON.stringify(baseName)},suffixes=${JSON.stringify(suffixes)};const files=suffixes.map(suffix=>{const name=suffix===0?base:base+'.'+suffix;try{const stat=fs.statSync('/selected/'+name);if(!stat.isFile())throw Error('selected Docker log is not a regular file');return {suffix,bytes:stat.size};}catch(error){if(error.code==='ENOENT')return {suffix,bytes:0};throw error;}});process.stdout.write(JSON.stringify(files));`;
  const files = JSON.parse(
    run([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "64m",
      "--pids-limit",
      "16",
      "--mount",
      `type=bind,source=${dirname(logFile.logPath)},target=/selected,readonly`,
      "--entrypoint",
      "node",
      nodeImage,
      "-e",
      probe,
    ]),
  );
  const present = files
    .filter((file) => file.bytes > 0)
    .map((file) => file.suffix);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (
    !present.includes(0) ||
    !present.some((suffix) => suffix > 0) ||
    present.length > maxFiles ||
    present.includes(maxFiles) ||
    totalBytes > maxSizeMiB * maxFiles * 1024 * 1024 + maxRecordBytes * maxFiles
  )
    throw new Error(
      "synthetic producer Docker json-file rotation exceeded its configured retention bound",
    );
  return {
    status: "PASS",
    service: logFile.service,
    containerId: logFile.containerId,
    driver: "json-file",
    configuredPinoMaxRecordBytes: maxRecordBytes,
    presentSuffixes: present,
    retainedFiles: present.length,
    totalBytes,
  };
}

function assertDockerLoggingPolicy(actual, expected) {
  const options = actual?.Config ?? {};
  const expectedOptions = Object.fromEntries(
    Object.entries(expected.options).map(([name, value]) => [
      name,
      String(value),
    ]),
  );
  if (
    actual?.Type !== expected.driver ||
    Object.keys(options).length !== Object.keys(expectedOptions).length ||
    Object.entries(expectedOptions).some(
      ([name, value]) => options[name] !== value,
    )
  )
    throw new Error("synthetic container Docker logging policy mismatch");
  return { status: "PASS", driver: actual.Type, options };
}

async function api({
  fetchImpl = fetch,
  baseUrl,
  path,
  authorization,
  method = "GET",
  body,
  expected = [200],
  signal = AbortSignal.timeout(5000),
}) {
  const response = await fetchImpl(new URL(path, baseUrl), {
    method,
    headers: {
      ...(authorization === undefined ? {} : { Authorization: authorization }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (!expected.includes(response.status)) {
    throw Object.assign(
      new Error(
        `Telemetry ${method} ${new URL(path, baseUrl).pathname} returned HTTP ${response.status}`,
      ),
      { httpStatus: response.status },
    );
  }
  const text = await boundedResponseText(response, 8 * 1024 * 1024);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitFor(
  predicate,
  { timeoutMs, intervalMs = 2000, description },
) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try {
      const value = await predicate();
      if (value) return value;
      lastError = undefined;
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `${description} did not complete${lastError ? `: ${lastError.message}` : ""}`,
  );
}

function requireRunning({ run, name, secrets = [] }) {
  const state = run([
    "inspect",
    "--format",
    "{{.State.Running}}|{{.State.ExitCode}}",
    name,
  ]);
  if (!state.startsWith("true|")) {
    let logs = "";
    try {
      logs = run(["logs", "--tail", "12", name]);
    } catch {}
    const safeLogs = secrets
      .reduce(
        (result, secret) =>
          secret ? result.replaceAll(secret, "[REDACTED]") : result,
        logs,
      )
      .replace(
        /(authorization|token|password|secret)([=: ]+)\S+/giu,
        "$1$2[REDACTED]",
      )
      .replace(/o2oi_[A-Za-z0-9_-]+/gu, "[REDACTED]");
    throw Object.assign(
      new Error(
        `${name} exited before health (code ${state.split("|")[1] ?? "unknown"})${safeLogs ? `; sanitized logs: ${safeLogs.slice(-1200)}` : ""}`,
      ),
      { fatal: true },
    );
  }
}

export function captureContainerDiagnostics({
  name,
  stage = "observed",
  secrets = [],
  spawnProcess = spawnSync,
}) {
  const inspect = spawnProcess(
    "docker",
    ["inspect", "--format", "{{json .State}}", name],
    {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let state;
  if (!inspect.error && inspect.status === 0) {
    try {
      const value = JSON.parse(inspect.stdout.trim());
      state = Object.fromEntries(
        [
          "Running",
          "ExitCode",
          "OOMKilled",
          "Error",
          "StartedAt",
          "FinishedAt",
        ].map((key) => [key, value[key]]),
      );
      state.Error = redactDiagnosticText(
        String(state.Error ?? ""),
        secrets,
      ).slice(0, 500);
      if (value.Health && typeof value.Health === "object") {
        state.Health = {
          status: ["starting", "healthy", "unhealthy"].includes(
            value.Health.Status,
          )
            ? value.Health.Status
            : "unknown",
          log: (Array.isArray(value.Health.Log) ? value.Health.Log : [])
            .slice(-3)
            .map((entry) => ({
              exitCode: Number.isInteger(entry?.ExitCode)
                ? entry.ExitCode
                : null,
              output: redactDiagnosticText(
                String(entry?.Output ?? ""),
                secrets,
              ).slice(0, 900),
            })),
        };
      }
    } catch {
      state = { unavailable: true };
    }
  } else state = { unavailable: true };
  const logResult = spawnProcess("docker", ["logs", "--tail", "120", name], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = sanitizedDiagnostics(
    `${logResult.stdout ?? ""}\n${logResult.stderr ?? ""}`,
    secrets,
  );
  const startup = sanitizedStartupMilestones(
    `${logResult.stdout ?? ""}\n${logResult.stderr ?? ""}`,
    secrets,
  );
  return {
    name,
    stage,
    state,
    ...(logs ? { errorOrWarningLines: logs } : {}),
    ...(startup ? { startupLines: startup } : {}),
  };
}

function containerGeneration({ run, name }) {
  return {
    id: run(["inspect", "--format", "{{.Id}}", name]),
    state: JSON.parse(run(["inspect", "--format", "{{json .State}}", name])),
  };
}

export function assertGrafanaGeneration(initial, current) {
  if (
    !initial ||
    !current ||
    !/^[a-f0-9]{64}$/u.test(initial.Id ?? "") ||
    !initial.State?.StartedAt ||
    initial.RestartCount !== 0 ||
    initial.State.Running !== true ||
    initial.State.OOMKilled !== false ||
    current.Id !== initial.Id ||
    current.State?.StartedAt !== initial.State.StartedAt ||
    current.RestartCount !== 0 ||
    current.State.Running !== true ||
    current.State.OOMKilled !== false
  )
    throw new Error(
      "Grafana crossed its initial process generation or became unhealthy",
    );
}

export function stopContainerGracefully({ run, name, graceMs }) {
  if (
    typeof run !== "function" ||
    typeof name !== "string" ||
    !name ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 1000
  )
    throw new Error("infrastructure stop inputs invalid");
  const stopSeconds = Math.floor(graceMs / 1000);
  const startedAt = performance.now();
  run(["stop", "--time", String(stopSeconds), name]);
  const elapsedMs = Math.ceil(performance.now() - startedAt);
  const { state } = containerGeneration({ run, name });
  const exitCode = Number.isSafeInteger(state.ExitCode) ? state.ExitCode : null;
  const oomKilled =
    typeof state.OOMKilled === "boolean" ? state.OOMKilled : null;
  const stopped = state.Running === false;
  return {
    status:
      stopped && exitCode === 0 && oomKilled === false && elapsedMs <= graceMs
        ? "PASS"
        : "FAIL",
    graceBudgetMs: graceMs,
    dockerStopSeconds: stopSeconds,
    elapsedMs,
    stopped,
    exitCode,
    oomKilled,
    forcedKill: exitCode === 137,
  };
}

function startedAtUs(state) {
  const startedAtMs = Date.parse(state?.StartedAt ?? "");
  if (!Number.isFinite(startedAtMs))
    throw new Error("container process start time is unavailable");
  return startedAtMs * 1000;
}

const MEMORY_LIMITER_METRICS = {
  refused: "otelcol_processor_memory_limiter_refused_spans",
  accepted: "otelcol_processor_memory_limiter_accepted_spans",
};
const MEMORY_MIB_BYTES = 1024 * 1024;
const MEMORY_SAMPLER_STALE_MS = 100;
const MEMORY_SAMPLE_FIELDS = [
  "sequence",
  "currentBytes",
  "maxBytes",
  "kernelPeakBytes",
  "anonBytes",
  "fileBytes",
  "kernelBytes",
  "oom",
  "oomKill",
  "sampledAtMs",
];

function safeCollectorMemorySample(sample) {
  if (!sample || typeof sample !== "object") return undefined;
  const safe = {};
  for (const key of MEMORY_SAMPLE_FIELDS) {
    if (Number.isSafeInteger(sample[key]) && sample[key] >= 0)
      safe[key] = sample[key];
  }
  return Object.keys(safe).length ? safe : undefined;
}

function collectorMemorySampleFailure(code, message, sample) {
  const error = new Error(message);
  error.diagnosticCode = code;
  error.failureSample = safeCollectorMemorySample(sample);
  return error;
}

export function parseCollectorMemoryLimiterMetrics(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error(
      "collector memory-limiter metrics response exceeded its bound",
    );
  const totals = { refused: 0, accepted: 0 };
  const preferred = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match =
      /^(otelcol_processor_memory_limiter_(?:refused|accepted)_spans(?:_total)?)(?:\{([^}]*)\})?\s+([^\s]+)(?:\s|$)/u.exec(
        line,
      );
    if (!match) continue;
    const key = match[1].includes("_refused_") ? "refused" : "accepted";
    const labels = Object.fromEntries(
      (match[2] ?? "")
        .split(",")
        .filter(Boolean)
        .map((part) => {
          const label =
            /^(processor|otel_scope_name)="([^"\\]*(?:\\.[^"\\]*)*)"$/u.exec(
              part.trim(),
            );
          return label ? [label[1], label[2]] : ["", ""];
        })
        .filter(([name]) => name),
    );
    if (labels.processor !== "memory_limiter") continue;
    const amount = Number(match[3]);
    if (!Number.isFinite(amount) || amount < 0)
      throw new Error("collector memory-limiter counter was invalid");
    const normalizedName = match[1].replace(/_total$/u, "");
    const baseName = MEMORY_LIMITER_METRICS[key];
    if (normalizedName !== baseName) continue;
    const isTotal = match[1].endsWith("_total");
    if (isTotal) {
      totals[key] = amount;
      preferred.add(key);
    } else if (!preferred.has(key)) {
      totals[key] = amount;
    }
  }
  return totals;
}

export function validateCollectorMemorySample(
  sample,
  {
    nowMs,
    receivedAtMs,
    previousSequence,
    containerMemoryMiB,
    guardBytes,
    staleMs = MEMORY_SAMPLER_STALE_MS,
  },
) {
  const expectedMaxBytes =
    Number.isSafeInteger(containerMemoryMiB) && containerMemoryMiB > 0
      ? containerMemoryMiB * MEMORY_MIB_BYTES
      : undefined;
  if (
    !sample ||
    typeof sample !== "object" ||
    Object.keys(sample).some(
      (key) => !MEMORY_SAMPLE_FIELDS.includes(key) && key !== "receivedAtMs",
    ) ||
    !Number.isSafeInteger(sample.sequence) ||
    sample.sequence < 1 ||
    !Number.isSafeInteger(sample.currentBytes) ||
    sample.currentBytes < 0 ||
    !Number.isSafeInteger(expectedMaxBytes) ||
    !Number.isSafeInteger(sample.maxBytes) ||
    sample.maxBytes !== expectedMaxBytes ||
    sample.currentBytes > sample.maxBytes ||
    !Number.isSafeInteger(sample.kernelPeakBytes) ||
    sample.kernelPeakBytes < 0 ||
    !Number.isSafeInteger(sample.anonBytes) ||
    sample.anonBytes < 0 ||
    !Number.isSafeInteger(sample.fileBytes) ||
    sample.fileBytes < 0 ||
    !Number.isSafeInteger(sample.kernelBytes) ||
    sample.kernelBytes < 0 ||
    !Number.isSafeInteger(sample.oom) ||
    sample.oom < 0 ||
    !Number.isSafeInteger(sample.oomKill) ||
    sample.oomKill < 0 ||
    !Number.isSafeInteger(sample.sampledAtMs) ||
    sample.sampledAtMs < 1 ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(receivedAtMs) ||
    receivedAtMs > nowMs ||
    nowMs - receivedAtMs > staleMs ||
    (previousSequence !== undefined && sample.sequence !== previousSequence + 1)
  )
    throw collectorMemorySampleFailure(
      "COLLECTOR_MEMORY_SAMPLE_INVALID",
      "collector memory sampler sample was invalid or stale",
      sample,
    );
  if (!Number.isSafeInteger(guardBytes) || guardBytes <= 0)
    throw collectorMemorySampleFailure(
      "COLLECTOR_MEMORY_POLICY_INVALID",
      "collector memory guard policy was invalid",
      sample,
    );
  if (
    Math.max(sample.currentBytes, sample.kernelPeakBytes) >= guardBytes ||
    sample.oom > 0 ||
    sample.oomKill > 0
  )
    throw collectorMemorySampleFailure(
      "COLLECTOR_MEMORY_SAFETY_GUARD",
      `collector memory safety guard was reached: currentBytes=${sample.currentBytes}, kernelPeakBytes=${sample.kernelPeakBytes}, guardBytes=${guardBytes}, oom=${sample.oom}, oomKill=${sample.oomKill}`,
      sample,
    );
  return sample;
}

const collectorMemorySamplerScript = `
set -eu
token="$1"
case "$token" in *[!a-f0-9]*|'') exit 2 ;; esac
umask 077
stop_path="/tmp/collector-memory-stop-$token"
pid=$$
exec 3<&0
printf '{"kind":"started","pid":%s}\\n' "$pid"
(
  while IFS= read -r command; do
    if [ "$command" = "$token" ]; then : > "$stop_path"; break; fi
  done
) <&3 &
reader=$!
exec 3<&-
sequence=0
while [ ! -e "$stop_path" ] && [ "$sequence" -lt 3400 ]; do
  current=$(/busybox cat /sys/fs/cgroup/memory.current) || exit 1
  maximum=$(/busybox cat /sys/fs/cgroup/memory.max) || exit 1
  kernel_peak=$(/busybox cat /sys/fs/cgroup/memory.peak) || exit 1
  stats=$(/busybox awk '$1=="anon"{a=$2}$1=="file"{f=$2}$1=="kernel"{k=$2}END{if(a==""||f==""||k=="")exit 1;printf "%s %s %s",a,f,k}' /sys/fs/cgroup/memory.stat) || exit 1
  set -- $stats
  anon=$1
  file=$2
  kernel=$3
  oom=$(/busybox awk '$1=="oom"{print $2}' /sys/fs/cgroup/memory.events) || exit 1
  oom_kill=$(/busybox awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory.events) || exit 1
  sampled_at=$(( $(/busybox date +%s) * 1000 ))
  sequence=$((sequence + 1))
  printf '{"kind":"sample","sequence":%s,"currentBytes":%s,"maxBytes":%s,"kernelPeakBytes":%s,"anonBytes":%s,"fileBytes":%s,"kernelBytes":%s,"oom":%s,"oomKill":%s,"sampledAtMs":%s}\\n' "$sequence" "$current" "$maximum" "$kernel_peak" "$anon" "$file" "$kernel" "\${oom:-0}" "\${oom_kill:-0}" "$sampled_at"
  /busybox sleep 0.05
done
kill "$reader" 2>/dev/null || true
/busybox rm -f "$stop_path"
printf '{"kind":"stopped","sequence":%s}\\n' "$sequence"
`;

function startCollectorMemorySampler({ name, token, config }) {
  const collector = config.telemetry.collector;
  const containerMemoryMiB = collector.containerMemoryMiB;
  const guardBytes =
    (containerMemoryMiB - collector.memorySpikeMiB) * MEMORY_MIB_BYTES;
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      name,
      "/busybox",
      "sh",
      "-c",
      collectorMemorySamplerScript,
      "collector-memory-sampler",
      token,
    ],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let buffer = "";
  let previousSequence;
  let samplerPid;
  let latest;
  let peakBytes = 0;
  let stopped = false;
  let closed = false;
  let failure;
  let lineCount = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (failure) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 4096) {
      failure = new Error("collector memory sampler output exceeded its bound");
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      if (++lineCount > 3500 || Buffer.byteLength(line) > 1024) {
        failure = new Error(
          "collector memory sampler output exceeded its bound",
        );
        return;
      }
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        failure = new Error("collector memory sampler output was invalid");
        return;
      }
      if (
        record.kind === "started" &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 1 &&
        samplerPid === undefined
      ) {
        samplerPid = record.pid;
      } else if (record.kind === "sample") {
        try {
          if (
            Object.keys(record).some(
              (key) => !["kind", ...MEMORY_SAMPLE_FIELDS].includes(key),
            )
          )
            throw collectorMemorySampleFailure(
              "COLLECTOR_MEMORY_SAMPLE_INVALID",
              "collector memory sampler sample was invalid or stale",
              record,
            );
          const sample = Object.fromEntries(
            MEMORY_SAMPLE_FIELDS.map((key) => [key, record[key]]),
          );
          const receivedAtMs = performance.now();
          peakBytes = Math.max(
            peakBytes,
            Number.isSafeInteger(sample.currentBytes) ? sample.currentBytes : 0,
            Number.isSafeInteger(sample.kernelPeakBytes)
              ? sample.kernelPeakBytes
              : 0,
          );
          validateCollectorMemorySample(sample, {
            nowMs: receivedAtMs,
            receivedAtMs,
            previousSequence,
            containerMemoryMiB,
            guardBytes,
          });
          previousSequence = sample.sequence;
          latest = { ...sample, receivedAtMs };
        } catch (error) {
          failure = error;
          return;
        }
      } else if (
        record.kind === "stopped" &&
        record.sequence === previousSequence
      ) {
        stopped = true;
      } else {
        failure = new Error("collector memory sampler record was invalid");
        return;
      }
    }
  });
  child.on("error", () => {
    failure ??= new Error("collector memory sampler process failed");
  });
  child.on("close", (code) => {
    closed = true;
    if (code !== 0 || !stopped)
      failure ??= new Error("collector memory sampler did not stop cleanly");
  });
  const latestSample = () => {
    if (failure) throw failure;
    if (!latest) throw new Error("collector memory sampler is not ready");
    const nowMs = performance.now();
    validateCollectorMemorySample(latest, {
      nowMs,
      receivedAtMs: latest.receivedAtMs,
      containerMemoryMiB,
      guardBytes,
    });
    return latest;
  };
  const waitForFreshSample = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (
        latest &&
        performance.now() - latest.receivedAtMs <= MEMORY_SAMPLER_STALE_MS
      )
        return latestSample();
      await sleep(25);
    }
    throw new Error("collector memory sampler did not become ready");
  };
  const stopSampler = async ({ run }) => {
    if (closed) return child.exitCode === 0;
    if (child.exitCode === null) {
      child.stdin.write(`${token}\n`);
      child.stdin.end();
    }
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) await sleep(25);
    if (child.exitCode === null && Number.isSafeInteger(samplerPid)) {
      const killScript =
        'p="$1"; t="$2"; case "$p" in *[!0-9]*|"") exit 2 ;; esac; [ "$p" -gt 1 ] || exit 2; c=$(/busybox tr "\\000" " " < "/proc/$p/cmdline") || exit 3; case "$c" in *"$t"*) /busybox kill -TERM "$p" ;; *) exit 4 ;; esac';
      try {
        run([
          "exec",
          name,
          "/busybox",
          "sh",
          "-c",
          killScript,
          "collector-memory-kill",
          String(samplerPid),
          token,
        ]);
      } catch {
        failure ??= new Error("collector memory sampler cleanup failed");
      }
      const killDeadline = Date.now() + 3000;
      while (!closed && Date.now() < killDeadline) await sleep(25);
    }
    return closed && child.exitCode === 0;
  };
  return {
    latestSample,
    waitForFreshSample,
    stopSampler,
    get peakBytes() {
      return peakBytes;
    },
    get failure() {
      return failure;
    },
    diagnostics() {
      const latestSafe = safeCollectorMemorySample(latest);
      const failureSample = safeCollectorMemorySample(failure?.failureSample);
      return {
        containerLimitMiB: containerMemoryMiB,
        maxBytes: containerMemoryMiB * MEMORY_MIB_BYTES,
        guardBytes,
        guardReserveMiB: collector.memorySpikeMiB,
        peakBytes,
        ...(latestSafe ? { latestSample: latestSafe } : {}),
        ...(failure
          ? {
              failureCode: [
                "COLLECTOR_MEMORY_SAMPLE_INVALID",
                "COLLECTOR_MEMORY_POLICY_INVALID",
                "COLLECTOR_MEMORY_SAFETY_GUARD",
              ].includes(failure.diagnosticCode)
                ? failure.diagnosticCode
                : "COLLECTOR_MEMORY_SAMPLER_FAILED",
            }
          : {}),
        ...(failureSample ? { failureSample } : {}),
      };
    },
  };
}

async function boundedResponseText(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes + 1 - total;
      const part = value.subarray(0, remaining);
      chunks.push(Buffer.from(part));
      total += part.byteLength;
      if (total > maxBytes || part.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total > maxBytes)
    throw new Error("telemetry response exceeded its evidence bound");
  return Buffer.concat(chunks).toString("utf8");
}

export async function collectorMemorySelfTelemetry({
  baseUrl,
  config,
  run,
  name,
  generation,
  allowUnmaterializedRefused = false,
  fetchImpl = fetch,
}) {
  const healthPort = new URL(config.telemetry.collector.healthEndpoint).port;
  run([
    "exec",
    name,
    "/busybox",
    "wget",
    "-q",
    "-O",
    "/dev/null",
    "-T",
    String(Math.max(1, Math.ceil(config.platform.health.timeoutMs / 1000))),
    `http://127.0.0.1:${healthPort}/-/ready`,
  ]);
  const sinceUs = Math.max(
    startedAtUs(generation.state),
    (Date.now() - 120000) * 1000,
  );
  const counters = {};
  for (const [key, metric] of Object.entries(MEMORY_LIMITER_METRICS)) {
    const records = await queryPrometheusRange({
      baseUrl,
      expression: `${metric}_total{service_name="otel-collector",component_id="otelcol.processor.memory_limiter.main"}`,
      startTimeUs: sinceUs,
      fetchImpl,
    });
    const latest = records
      .filter(
        (record) =>
          record.component_id === "otelcol.processor.memory_limiter.main",
      )
      .sort((a, b) => b._timestamp - a._timestamp)[0];
    if (!latest && key === "refused" && allowUnmaterializedRefused) continue;
    if (!latest || latest._timestamp <= sinceUs || latest.value < 0)
      throw Object.assign(
        new Error(`Alloy memory limiter ${key} counter unavailable`),
        { code: "COLLECTOR_METRIC_NOT_READY" },
      );
    counters[key] = latest.value;
  }
  const current = containerGeneration({ run, name });
  if (
    current.id !== generation.id ||
    current.state.StartedAt !== generation.state.StartedAt ||
    current.state.Running !== true ||
    current.state.OOMKilled === true
  )
    throw new Error(
      "collector memory proof crossed a process generation or unhealthy state",
    );
  const refusedNotMaterialized = counters.refused === undefined;
  if (refusedNotMaterialized && counters.accepted <= 0)
    throw Object.assign(
      new Error("Alloy accepted spans counter has no positive baseline"),
      { code: "COLLECTOR_METRIC_NOT_READY" },
    );
  if (refusedNotMaterialized) counters.refused = 0;
  return {
    counters,
    refusedNotMaterialized,
    sampledAt: new Date().toISOString(),
    containerId: current.id,
    startedAt: current.state.StartedAt,
  };
}

async function captureCollectorMemoryStartupBaseline({ run, name, config }) {
  const generation = containerGeneration({ run, name });
  const sampler = startCollectorMemorySampler({
    name,
    token: randomBytes(16).toString("hex"),
    config,
  });
  let sample;
  let failureCode;
  try {
    if (
      generation.state.Running !== true ||
      generation.state.OOMKilled === true
    )
      failureCode = "COLLECTOR_GENERATION_UNHEALTHY";
    else sample = await sampler.waitForFreshSample(30000);
  } catch (error) {
    failureCode = [
      "COLLECTOR_MEMORY_SAMPLE_INVALID",
      "COLLECTOR_MEMORY_POLICY_INVALID",
      "COLLECTOR_MEMORY_SAFETY_GUARD",
    ].includes(error.diagnosticCode)
      ? error.diagnosticCode
      : "COLLECTOR_MEMORY_SAMPLER_FAILED";
  }
  let stopped = false;
  try {
    stopped = await sampler.stopSampler({ run });
  } catch {
    failureCode ??= "COLLECTOR_MEMORY_SAMPLER_CLEANUP_FAILED";
  }
  const after = containerGeneration({ run, name });
  const diagnostics = sampler.diagnostics();
  const sameGeneration =
    generation.id === after.id &&
    generation.state.StartedAt === after.state.StartedAt &&
    after.state.Running === true &&
    after.state.OOMKilled !== true;
  const status =
    sample && stopped && !sampler.failure && sameGeneration ? "PASS" : "FAIL";
  return {
    status,
    stage: "initial-healthy-baseline",
    containerGeneration: {
      id: generation.id,
      startedAt: generation.state.StartedAt,
      sameGenerationAfterCapture: sameGeneration,
    },
    limits: {
      containerLimitMiB: config.telemetry.collector.containerMemoryMiB,
      cgroupGuardBytes:
        (config.telemetry.collector.containerMemoryMiB -
          config.telemetry.collector.memorySpikeMiB) *
        MEMORY_MIB_BYTES,
    },
    ...(sample ? { sample: safeCollectorMemorySample(sample) } : {}),
    sampler: diagnostics,
    ...(failureCode
      ? { failureCode }
      : !stopped
        ? { failureCode: "COLLECTOR_MEMORY_SAMPLER_CLEANUP_FAILED" }
        : {}),
    samplerStopped: stopped,
  };
}

export function isCollectorMemoryRefusal(response) {
  return (
    response?.httpStatus === 503 &&
    response.otlpCode === 14 &&
    response.refusal === true
  );
}

function collectorMemorySpan({
  traceId,
  spanId,
  runId,
  name,
  paddingBytes = 512,
}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "g14-memory-proof" } },
            { key: "g14_run_id", value: { stringValue: runId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "g14-memory-proof" },
            spans: [
              {
                traceId,
                spanId,
                name,
                kind: 1,
                startTimeUnixNano: String(Date.now() * 1e6),
                endTimeUnixNano: String(Date.now() * 1e6 + 1),
                attributes: [
                  { key: "g14_run_id", value: { stringValue: runId } },
                  { key: "g14_memory_marker", value: { stringValue: name } },
                  ...(paddingBytes > 512
                    ? [
                        {
                          key: "g14_memory_padding",
                          value: { stringValue: "x".repeat(paddingBytes) },
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

async function sendCollectorMemorySpan({
  collectorIp,
  config,
  token,
  runId,
  name,
  paddingBytes = 512,
}) {
  const endpoint = `http://${collectorIp}:${new URL(config.telemetry.collector.otlpEndpoint).port}/v1/traces`;
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const body = JSON.stringify(
    collectorMemorySpan({ traceId, spanId, runId, name, paddingBytes }),
  );
  const wireBytes = Buffer.byteLength(body) + 1024;
  if (wireBytes > 512 * 1024)
    throw new Error("collector memory proof packet exceeded its bound");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
    signal: AbortSignal.timeout(1000),
  });
  const responseText = await boundedResponseText(response, 4096);
  let otlpCode;
  let refusal = false;
  try {
    const payload = JSON.parse(responseText);
    otlpCode = Number.isSafeInteger(payload?.code) ? payload.code : undefined;
    refusal = /refused due to high memory usage/iu.test(
      String(payload?.message ?? ""),
    );
  } catch {
    /* Неструктурированный ответ сохраняется только как HTTP-статус. */
  }
  return {
    httpStatus: response.status,
    ...(otlpCode === undefined ? {} : { otlpCode }),
    refusal,
    wireBytes,
    ...(name === "g14.collector.memory.recovered" ? { traceId } : {}),
  };
}

async function runCollectorMemoryProof({
  run,
  collectorName,
  tempoName,
  collectorIp,
  prometheusUrl,
  config,
  collectorConfig,
  token,
  runId,
  sampler,
  progress,
  cleanupErrors,
  cleanError,
}) {
  progress.stage = "startup";
  if (
    config.telemetry.collector.memoryLimitMiB !== 256 ||
    config.telemetry.collector.memorySpikeMiB !== 64 ||
    config.telemetry.collector.memoryCheckIntervalMs !== 1000 ||
    config.telemetry.collector.retryWindowMs !== 15000 ||
    !collectorConfig.includes('limit = "256MiB"') ||
    !collectorConfig.includes('spike_limit = "64MiB"') ||
    !collectorConfig.includes('check_interval = "1000ms"')
  )
    throw new Error(
      "generated Collector memory-limiter policy did not match the calibrated configured limits",
    );
  const generation = containerGeneration({ run, name: collectorName });
  if (generation.state.Running !== true || generation.state.OOMKilled === true)
    throw new Error(
      "collector memory proof requires a healthy running Collector",
    );
  const startupDeadline = Date.now() + 30000;
  const baselineMemory = await sampler.waitForFreshSample(
    startupDeadline - Date.now(),
  );
  progress.baselineSample = safeCollectorMemorySample(baselineMemory);
  progress.stage = "self-telemetry-baseline";
  let telemetry;
  while (Date.now() < startupDeadline) {
    if (
      generation.state.Running !== true ||
      generation.state.OOMKilled === true
    )
      throw new Error(
        "Collector memory proof startup reached an unhealthy state",
      );
    try {
      telemetry = await collectorMemorySelfTelemetry({
        baseUrl: prometheusUrl,
        config,
        run,
        name: collectorName,
        generation,
        allowUnmaterializedRefused: true,
      });
      await sampler.waitForFreshSample(1000);
      break;
    } catch (error) {
      if (
        error.code !== "COLLECTOR_METRIC_NOT_READY" &&
        !["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH"].includes(
          error.cause?.code,
        )
      )
        throw error;
      await sleep(250);
    }
  }
  if (!telemetry)
    throw new Error("Collector memory proof startup readiness timed out");
  progress.baselineCounters = {
    refused: telemetry.counters.refused,
    accepted: telemetry.counters.accepted,
  };
  let lastTelemetryAt = Date.now();
  let refusalConfirmed = false;
  const refreshTelemetry = async (force, requireRefused = refusalConfirmed) => {
    if (force || Date.now() - lastTelemetryAt >= 1000) {
      telemetry = await collectorMemorySelfTelemetry({
        baseUrl: prometheusUrl,
        config,
        run,
        name: collectorName,
        generation,
        allowUnmaterializedRefused: !requireRefused,
      });
      lastTelemetryAt = Date.now();
    }
    await sampler.waitForFreshSample(1000);
    return telemetry;
  };
  const baseline = telemetry;
  const startedAt = Date.now();
  const totalWireCap = 256 * 1024 * 1024;
  const deadlineAt = startedAt + 60000;
  let packetCount = 0;
  let wireBytes = 0;
  let refusal;
  const tempoGeneration = containerGeneration({ run, name: tempoName });
  if (
    !/^[a-f0-9]{12,64}$/u.test(tempoName) ||
    !/^[a-f0-9]{64}$/u.test(tempoGeneration.id) ||
    !tempoGeneration.id.startsWith(tempoName)
  )
    throw new Error("memory proof Tempo container identity invalid");
  tempoName = tempoGeneration.id;
  const tempoLabels = JSON.parse(
    run(["inspect", "--format", "{{json .Config.Labels}}", tempoName]),
  );
  if (
    tempoGeneration.state.Running !== true ||
    tempoGeneration.state.Paused !== false ||
    tempoGeneration.state.OOMKilled === true ||
    tempoLabels?.["com.docker.compose.project"] !==
      `coffee-observability-${runId}` ||
    tempoLabels?.["com.docker.compose.service"] !== "tempo"
  )
    throw new Error("memory proof Tempo ownership or generation invalid");
  let tempoPaused = false,
    tempoRestorationError;
  const resumeTempo = () => {
    if (!tempoPaused) return;
    const before = containerGeneration({ run, name: tempoName });
    if (
      before.id !== tempoGeneration.id ||
      before.state.StartedAt !== tempoGeneration.state.StartedAt ||
      before.state.Running !== true
    )
      throw new Error("memory proof Tempo generation changed before resume");
    if (before.state.Paused === true) run(["unpause", tempoName]);
    const after = containerGeneration({ run, name: tempoName });
    if (
      after.id !== tempoGeneration.id ||
      after.state.StartedAt !== tempoGeneration.state.StartedAt ||
      after.state.Running !== true ||
      after.state.Paused !== false ||
      after.state.OOMKilled === true
    )
      throw new Error("memory proof Tempo resume failed");
    tempoPaused = false;
  };
  progress.stage = "pressure";
  progress.packetCount = 0;
  progress.wireBytes = 0;
  try {
    tempoPaused = true;
    run(["pause", tempoName]);
    const paused = containerGeneration({ run, name: tempoName });
    if (
      paused.id !== tempoGeneration.id ||
      paused.state.StartedAt !== tempoGeneration.state.StartedAt ||
      paused.state.Paused !== true
    )
      throw new Error("memory proof Tempo pause failed");
    while (Date.now() < deadlineAt && wireBytes + 512 * 1024 <= totalWireCap) {
      await sampler.waitForFreshSample(1000);
      await refreshTelemetry(false);
      progress.attempted = packetCount + 1;
      progress.pendingMaxWireBytes = 512 * 1024;
      const response = await sendCollectorMemorySpan({
        collectorIp,
        config,
        token,
        runId,
        name: "g14.collector.memory.pressure",
        paddingBytes: 200 * 1024,
      });
      delete progress.pendingMaxWireBytes;
      packetCount += 1;
      wireBytes += response.wireBytes;
      progress.packetCount = packetCount;
      progress.wireBytes = wireBytes;
      progress.elapsedMs = Date.now() - startedAt;
      await sampler.waitForFreshSample(1000);
      if (response.httpStatus === 503) {
        if (!isCollectorMemoryRefusal(response))
          throw new Error(
            "Collector returned an unproven memory-refusal response",
          );
        progress.refusal = {
          httpStatus: 503,
          otlpCode: 14,
          packetCount,
          wireBytes,
        };
        progress.stage = "refusal-observed";
        resumeTempo();
        let refusedSpansDelta = 0;
        const confirmationDeadline =
          Date.now() + Math.max(30000, config.platform.health.intervalMs * 4);
        while (Date.now() < confirmationDeadline && refusedSpansDelta <= 0) {
          try {
            const afterRefusal = await refreshTelemetry(true, true);
            refusedSpansDelta =
              afterRefusal.counters.refused - baseline.counters.refused;
          } catch (error) {
            if (error.code !== "COLLECTOR_METRIC_NOT_READY") throw error;
          }
          if (refusedSpansDelta <= 0) await sleep(1000);
        }
        if (refusedSpansDelta <= 0)
          throw new Error("Alloy refused spans counter did not advance");
        refusalConfirmed = true;
        refusal = {
          httpStatus: 503,
          otlpCode: 14,
          refusedSpansDelta,
          packetCount,
          wireBytes,
          observedAt: new Date().toISOString(),
        };
        progress.refusal = {
          httpStatus: 503,
          otlpCode: 14,
          refusedSpansDelta,
          packetCount,
          wireBytes,
        };
        progress.stage = "refusal-confirmed";
        break;
      }
      if (response.httpStatus !== 200)
        throw new Error(
          "Collector pressure request returned an unexpected status",
        );
      if (wireBytes > totalWireCap)
        throw new Error("Collector pressure request exceeded its wire budget");
      await sleep(25);
    }
  } finally {
    try {
      resumeTempo();
    } catch (error) {
      tempoRestorationError = error;
    }
    if (tempoRestorationError)
      cleanupErrors.push(
        "Tempo memory restore: " + cleanError(tempoRestorationError),
      );
  }
  if (tempoRestorationError) throw tempoRestorationError;
  if (!refusal)
    throw new Error(
      "Collector memory refusal was not reached within the bounded pressure window",
    );

  const refusalAt = Date.now();
  progress.stage = "retry-expiry-and-recovery";
  const recoveryDeadline = refusalAt + 60000;
  for (const offsetMs of [1000, 6000, 21000]) {
    const target = refusalAt + offsetMs;
    while (Date.now() < target) {
      await sampler.waitForFreshSample(1000);
      await refreshTelemetry(false);
      await sleep(Math.min(100, target - Date.now()));
    }
    await refreshTelemetry(true);
  }

  let recovery;
  while (!recovery && Date.now() < recoveryDeadline) {
    await sampler.waitForFreshSample(1000);
    const beforeRecovery = await refreshTelemetry(true);
    const response = await sendCollectorMemorySpan({
      collectorIp,
      config,
      token,
      runId,
      name: "g14.collector.memory.recovery-probe",
    });
    await sampler.waitForFreshSample(1000);
    if (response.httpStatus === 200) {
      let afterRecovery = await refreshTelemetry(true);
      let acceptedSpansDelta =
        afterRecovery.counters.accepted - beforeRecovery.counters.accepted;
      const confirmationDeadline = Math.min(
        recoveryDeadline,
        Date.now() + 30000,
      );
      while (acceptedSpansDelta <= 0 && Date.now() < confirmationDeadline) {
        await sampler.waitForFreshSample(1000);
        await sleep(1000);
        afterRecovery = await refreshTelemetry(true);
        acceptedSpansDelta =
          afterRecovery.counters.accepted - beforeRecovery.counters.accepted;
      }
      if (acceptedSpansDelta > 0) {
        recovery = {
          httpStatus: 200,
          acceptedSpansDelta,
          observedAt: new Date().toISOString(),
        };
        progress.recovery = { httpStatus: 200, acceptedSpansDelta };
        progress.stage = "recovery-accepted";
      } else
        throw new Error(
          "Collector recovery acceptance counter did not increase",
        );
    } else if (!isCollectorMemoryRefusal(response)) {
      throw new Error(
        "Collector recovery request returned an unproven memory-refusal response",
      );
    } else {
      await sleep(1000);
    }
  }
  if (!recovery)
    throw new Error(
      "Collector did not accept a recovery span within the bounded retry window",
    );
  const finalMemory = await sampler.waitForFreshSample(1000);
  return {
    status: "NOT_RUN",
    containerGeneration: {
      id: generation.id,
      startedAt: generation.state.StartedAt,
    },
    limits: {
      hardLimitMiB: config.telemetry.collector.memoryLimitMiB,
      spikeLimitMiB: config.telemetry.collector.memorySpikeMiB,
      softLimitMiB:
        config.telemetry.collector.memoryLimitMiB -
        config.telemetry.collector.memorySpikeMiB,
      containerLimitMiB: config.telemetry.collector.containerMemoryMiB,
      cgroupGuardBytes:
        (config.telemetry.collector.containerMemoryMiB -
          config.telemetry.collector.memorySpikeMiB) *
        MEMORY_MIB_BYTES,
      guardReserveMiB: config.telemetry.collector.memorySpikeMiB,
      samplerIntervalMs: 50,
      samplerFreshnessMs: MEMORY_SAMPLER_STALE_MS,
      maxPacketBytes: 512 * 1024,
      maxWireBytes: totalWireCap,
      maxWireBytesPerSecond: 32 * 1024 * 1024,
      deadlineMs: 60000,
    },
    cgroup: {
      baseline: safeCollectorMemorySample(baselineMemory),
      baselineBytes: baselineMemory.currentBytes,
      peakBytes: sampler.peakBytes,
      maxBytes: baselineMemory.maxBytes,
      final: safeCollectorMemorySample(finalMemory),
      oom: finalMemory.oom,
      oomKill: finalMemory.oomKill,
    },
    metrics: {
      processor: "memory_limiter",
      refused: MEMORY_LIMITER_METRICS.refused,
      accepted: MEMORY_LIMITER_METRICS.accepted,
      baseline,
      afterRecovery: telemetry,
    },
    pressure: { packetCount, wireBytes, elapsedMs: Date.now() - startedAt },
    refusal,
    recovery,
    durableExportProven: false,
  };
}

function metricTimestampUs(record) {
  const raw = Object.entries(record ?? []).find(
    ([key, value]) =>
      /^(?:_timestamp|timestamp|@timestamp)$/iu.test(key) &&
      (typeof value === "number" || typeof value === "string"),
  )?.[1];
  if (typeof raw === "number") {
    if (raw > 1e14) return raw;
    if (raw > 1e11) return raw * 1000;
    return raw * 1e6;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed * 1000 : undefined;
  }
  return undefined;
}

function latestMetricSample(records, { service, afterUs, beforeUs }) {
  return records
    .map((record) => ({
      timestampUs: metricTimestampUs(record),
      service: metricRecordAttribute(record, "service_name"),
      instanceId: metricRecordAttribute(record, "service_instance_id"),
      value: metricValues([record])[0],
    }))
    .filter(
      (sample) =>
        sample.service === service &&
        Number.isFinite(sample.timestampUs) &&
        sample.value !== undefined &&
        (afterUs === undefined || sample.timestampUs > afterUs) &&
        (beforeUs === undefined || sample.timestampUs < beforeUs),
    )
    .sort((left, right) => right.timestampUs - left.timestampUs)[0];
}

export async function readinessMetricSamples({
  baseUrl,
  services,
  afterUs,
  fetchImpl = fetch,
}) {
  const records = await queryPrometheusRange({
    baseUrl,
    expression: "runtime_ready",
    startTimeUs: afterUs,
    fetchImpl,
  });
  return services.map((service) => ({
    service,
    sample: latestMetricSample(records, { service, afterUs }),
  }));
}

async function waitForProcessMetric({
  baseUrl,
  stream,
  service,
  afterUs,
  beforeUs,
  description,
}) {
  return waitFor(
    async () => {
      const samples = await queryPrometheusRange({
        baseUrl,
        expression: stream,
        startTimeUs: afterUs,
        endTimeUs: beforeUs ?? Date.now() * 1000,
      });
      return (
        latestMetricSample(samples, { service, afterUs, beforeUs }) ?? false
      );
    },
    { timeoutMs: 60000, intervalMs: 1000, description },
  );
}

async function fixtureDiagnostics(baseUrl) {
  const response = await fetch(new URL("/test/diagnostics", baseUrl), {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok)
    throw new Error(
      `synthetic runtime diagnostics returned HTTP ${response.status}`,
    );
  const diagnostics = await response.json();
  const counters = [
    "dropped",
    "exportFailures",
    "shutdownLoss",
    "serializationRejected",
    "queueOverflows",
  ];
  if (
    !Number.isInteger(diagnostics.processId) ||
    !Number.isFinite(diagnostics.processStartTimeSeconds) ||
    counters.some(
      (counter) =>
        !Number.isSafeInteger(diagnostics[counter]) || diagnostics[counter] < 0,
    )
  )
    throw new Error(
      "synthetic runtime diagnostics did not expose typed process identity and loss counters",
    );
  const counterValues = Object.fromEntries(
    counters.map((counter) => [counter, diagnostics[counter]]),
  );
  return {
    processId: diagnostics.processId,
    processStartTimeSeconds: diagnostics.processStartTimeSeconds,
    ...counterValues,
    counters: counterValues,
  };
}

function redactDiagnosticText(value, secrets) {
  return secrets
    .reduce(
      (result, secret) =>
        secret ? result.replaceAll(secret, "[REDACTED]") : result,
      value,
    )
    .replace(/\b(Basic|Bearer)\s+[^\s"']+/giu, "$1 [REDACTED]")
    .replace(
      /(authorization|token|password|secret)([=: ]+)\S+/giu,
      "$1$2[REDACTED]",
    )
    .replace(/o2oi_[A-Za-z0-9_-]+/gu, "[REDACTED]");
}

function sanitizedDiagnostics(value, secrets) {
  return redactDiagnosticText(value, secrets)
    .split("\n")
    .filter((line) =>
      /\b(error|warn|failed|unauthorized|forbidden|queue is full)\b/iu.test(
        line,
      ),
    )
    .slice(-10)
    .map((line) => line.slice(0, 900))
    .join("\n");
}

function sanitizedStartupMilestones(value, secrets) {
  const lines = redactDiagnosticText(value, secrets)
    .split("\n")
    .filter((line) =>
      /\b(start(?:ing|ed)?|listen(?:ing)?|server|sqlite|migrat(?:e|ion)|ready|initiali[sz]e|bind(?:ing)?)\b/iu.test(
        line,
      ),
    )
    .slice(-12)
    .map((line) => line.slice(0, 400))
    .join("\n");
  return Buffer.from(lines).subarray(-1997).toString("utf8");
}

export async function readSinkEvents(path) {
  const events = [];
  for (const suffix of [".2", ".1", ""]) {
    let content;
    try {
      content = await readFile(`${path}${suffix}`, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new Error("alert evidence exceeded its configured bound");
    events.push(
      ...content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }
  return events;
}

async function fixtureRequest({
  baseUrl,
  path = "/synthetic",
  method = "POST",
  body,
  runId,
}) {
  const traceId = runId.replaceAll("-", "").padEnd(32, "0");
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      "x-correlation-id": runId,
      traceparent: `00-${traceId}-0123456789abcdef-01`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(
      `synthetic runtime ${method} ${path} returned HTTP ${response.status}`,
    );
  return response.status === 204 ? undefined : response.json();
}

function inspectProducerRedaction({
  name,
  runId,
  redactionCanary,
  maxRecordBytes,
}) {
  const tailRecords = Math.max(1, Math.floor((512 * 1024) / maxRecordBytes));
  const result = spawnSync(
    "docker",
    ["logs", "--tail", String(tailRecords), name],
    {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      "could not inspect the synthetic producer Docker log for redaction evidence",
    );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const records = output.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  let matchingRunId = false;
  let redactedToken = false;
  const visit = (value, depth = 0) => {
    if (depth >= 8 || value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (child === runId) matchingRunId = true;
      if (key.toLowerCase() === "token" && child === "[REDACTED]")
        redactedToken = true;
      visit(child, depth + 1);
    }
  };
  records.forEach((record) => visit(record));
  return {
    matchingRunId,
    redactedToken,
    canaryLeaked: output.includes(redactionCanary),
    recordsScanned: records.length,
  };
}

const SENSITIVE_TELEMETRY_FIELD =
  /password|passwd|credential|api.?key|token|secret|authorization|cookie|session|private.?key|email|phone|actor|address|(?:client|remote|source|forwarded).?ip|(?:request|callback|target).?(?:uri|url)|payload|request.?body/iu;

function containsSensitiveField(value, depth = 0) {
  if (value === null || typeof value !== "object") return false;
  if (depth >= 8) return true;
  return Object.entries(value).some(
    ([key, child]) =>
      SENSITIVE_TELEMETRY_FIELD.test(key) ||
      (key === "key" &&
        typeof child === "string" &&
        SENSITIVE_TELEMETRY_FIELD.test(child)) ||
      containsSensitiveField(child, depth + 1),
  );
}

function metricValues(records) {
  return records.flatMap((record) =>
    Object.entries(record ?? [])
      .filter(
        ([key, value]) =>
          /^(?:value|_value)$/iu.test(key) && typeof value === "number",
      )
      .map(([, value]) => value),
  );
}

export function traceSpanInventory(records) {
  const inventory = {};
  for (const record of records) {
    const service = record?.service_name;
    const spanName = record?.operation_name;
    if (
      typeof service !== "string" ||
      service.length === 0 ||
      typeof spanName !== "string" ||
      spanName.length === 0
    )
      continue;
    inventory[service] ??= new Set();
    inventory[service].add(spanName);
  }
  return Object.fromEntries(
    Object.entries(inventory).map(([service, names]) => [
      service,
      [...names].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ]),
  );
}

export async function waitForSameTraceSpans({
  baseUrl,
  traceId,
  expectedSpanNames,
  fetchImpl = fetch,
  timeoutMs = 60000,
  intervalMs = 2000,
  onObservation,
  inspectSpan,
}) {
  if (!/^[0-9a-f]{32}$/u.test(traceId))
    throw new TypeError("traceId must be 32 lowercase hexadecimal characters");
  if (
    !expectedSpanNames ||
    Object.keys(expectedSpanNames).length === 0 ||
    Object.entries(expectedSpanNames).some(
      ([role, names]) =>
        !role ||
        !Array.isArray(names) ||
        names.length === 0 ||
        names.some((name) => typeof name !== "string" || name.length === 0),
    )
  )
    throw new TypeError("expectedSpanNames must contain nonempty role spans");
  let lastSuccessful = null;
  return waitFor(
    async () => {
      let result;
      try {
        result = await api({
          baseUrl,
          path: `/api/traces/${traceId}`,
          fetchImpl,
          expected: [200, 404],
        });
      } catch (error) {
        const errorClass = [
          "Error",
          "TypeError",
          "AbortError",
          "TimeoutError",
        ].includes(error?.name)
          ? error.name
          : null;
        const httpStatus =
          Number.isInteger(error?.httpStatus) &&
          error.httpStatus >= 100 &&
          error.httpStatus <= 599
            ? error.httpStatus
            : null;
        onObservation?.({
          lastAttempt: {
            outcome: "QUERY_ERROR",
            rowCount: null,
            total: null,
            isPartial: null,
            matchedExpectedSpanCount: null,
            missingExpectedSpanNames: null,
            errorClass,
            httpStatus,
          },
          lastSuccessful,
        });
        throw error;
      }
      const groups =
        result?.batches ??
        result?.resourceSpans ??
        result?.trace?.resourceSpans ??
        [];
      if (!Array.isArray(groups))
        throw new Error("Tempo trace response has invalid resource spans");
      const found = [];
      for (const group of groups) {
        const service = group.resource?.attributes?.find(
          (attribute) => attribute.key === "service.name",
        )?.value?.stringValue;
        for (const scope of group.scopeSpans ??
          group.instrumentationLibrarySpans ??
          []) {
          for (const span of scope.spans ?? []) {
            const spanTrace = /^[0-9a-f]{32}$/iu.test(span.traceId ?? "")
              ? span.traceId.toLowerCase()
              : Buffer.from(span.traceId ?? "", "base64").toString("hex");
            if (spanTrace !== traceId)
              throw new Error("Tempo returned a span from a different trace");
            inspectSpan?.(span, group.resource);
            found.push({
              service_name: service,
              operation_name: span.name,
              trace_id: spanTrace,
            });
          }
        }
      }
      const inventory = traceSpanInventory(found);
      const missingExpectedSpanNames = Object.entries(
        expectedSpanNames,
      ).flatMap(([service, names]) =>
        names
          .filter((name) => !inventory[service]?.includes(name))
          .map((name) => `${service}:${name}`),
      );
      const observation = {
        outcome:
          missingExpectedSpanNames.length === 0 ? "COMPLETE" : "MISSING_SPANS",
        rowCount: found.length,
        total: found.length,
        isPartial: result?.metrics?.failedBlocks > 0,
        matchedExpectedSpanCount:
          Object.values(expectedSpanNames).reduce(
            (count, names) => count + names.length,
            0,
          ) - missingExpectedSpanNames.length,
        missingExpectedSpanNames,
        errorClass: null,
        httpStatus: null,
      };
      lastSuccessful = observation;
      onObservation?.({ lastAttempt: observation, lastSuccessful });
      return missingExpectedSpanNames.length === 0 && !observation.isPartial
        ? { traceRows: found, spanInventory: inventory }
        : false;
    },
    {
      timeoutMs,
      intervalMs,
      description: "all expected same-trace runtime spans in Tempo",
    },
  );
}

export function validateG14ComponentCleanup(component, runId) {
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(runId ?? ""))
    throw new Error("G14 component child identity invalid");
  const expected = ["customer", "catalog", "pricing", "orders", "integration"]
    .map(
      (owner) =>
        `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`,
    )
    .sort();
  if (
    component?.cleanupVerified !== true ||
    component.cleanup?.verified !== true ||
    component.cleanup.databases?.verified !== true ||
    !isDeepStrictEqual(component.cleanup.databases.removed, expected) ||
    !isDeepStrictEqual(component.cleanup.databases.retained, []) ||
    component.cleanup.attachment?.routePreserved !== true
  )
    throw new Error("G14 component diagnostic cleanup is unverified");
  return component.cleanup;
}

const G14_DURABLE_SPANS = {
  "orders-service": ["Outbox.relay", "Kafka.produce"],
  "orders-aroma-preparation": [
    "Kafka.consume",
    "Inbox.consumeOnce",
    "Outbox.relay",
    "Kafka.produce",
  ],
  "realtime-gateway": ["Kafka.consume"],
};

async function waitForG14CausalTraces({
  proof,
  anchors,
  apiAnchors,
  baseUrl,
  startTimeUs,
  fetchImpl,
  timeoutMs,
  intervalMs,
  inspectSpan,
}) {
  const decodeId = (value, length) => {
    if (typeof value !== "string") return "";
    if (new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)) return value;
    const decoded = Buffer.from(value, "base64").toString("hex");
    return decoded.length === length ? decoded : "";
  };
  return waitFor(
    async () => {
      const readTrace = async (traceId) => {
        const result = await api({
          baseUrl,
          path: `/api/traces/${traceId}`,
          fetchImpl,
          expected: [200, 404],
        });
        const groups =
          result?.batches ??
          result?.resourceSpans ??
          result?.trace?.resourceSpans ??
          [];
        if (!Array.isArray(groups) || result?.metrics?.failedBlocks > 0)
          throw new Error("G14 trace response incomplete");
        const spans = [];
        for (const group of groups) {
          const role = group.resource?.attributes?.find(
            ({ key }) => key === "service.name",
          )?.value?.stringValue;
          for (const scope of group.scopeSpans ??
            group.instrumentationLibrarySpans ??
            [])
            for (const span of scope.spans ?? []) {
              if (decodeId(span.traceId, 32) !== traceId)
                throw new Error("G14 trace identity mismatch");
              spans.push({ role, span, resource: group.resource });
            }
        }
        return spans;
      };
      const root = await readTrace(proof.traceId);
      if (!root.length) return false;
      const rootIds = new Set([
        proof.ownerTraceparent.slice(36, 52),
        ...root.map(({ span }) => decodeId(span.spanId, 16)).filter(Boolean),
      ]);
      const durable = [...root];
      const hasDurable = () =>
        Object.entries(G14_DURABLE_SPANS).every(([role, names]) =>
          names.every((name) =>
            durable.some(
              (item) => item.role === role && item.span.name === name,
            ),
          ),
        );
      const traceIds = new Set([proof.traceId]);
      const durableLinks = [];
      if (!hasDurable()) {
        const query = new URLSearchParams({
          q: `{ link:traceID = "${proof.traceId}" }`,
          start: String(Math.floor(startTimeUs / 1e6)),
          end: String(Math.ceil(Date.now() / 1000)),
          limit: "50",
        });
        const result = await api({
          baseUrl,
          path: `/api/search?${query}`,
          fetchImpl,
        });
        if (
          !Array.isArray(result?.traces) ||
          result.traces.length >= 50 ||
          result?.metrics?.failedBlocks > 0
        )
          throw new Error("G14 linked trace search incomplete");
        for (const candidate of result.traces) {
          const traceId = candidate.traceID ?? candidate.traceId;
          if (!/^[a-f0-9]{32}$/u.test(traceId ?? "") || traceIds.has(traceId))
            continue;
          const spans = await readTrace(traceId);
          const linked = spans
            .flatMap(({ span }) => span.links ?? [])
            .find(
              (link) =>
                decodeId(link.traceId, 32) === proof.traceId &&
                rootIds.has(decodeId(link.spanId, 16)),
            );
          if (linked) {
            durable.push(...spans);
            traceIds.add(traceId);
            durableLinks.push({
              traceId,
              linkedTraceId: proof.traceId,
              linkedSpanId: decodeId(linked.spanId, 16),
            });
          }
        }
      }
      if (!hasDurable()) return false;
      const durableSpanKeys = new Set([
        `${proof.traceId}:${proof.ownerTraceparent.slice(36, 52)}`,
        ...durable
          .map(
            ({ span }) =>
              `${decodeId(span.traceId, 32)}:${decodeId(span.spanId, 16)}`,
          )
          .filter((key) => /^[a-f0-9]{32}:[a-f0-9]{16}$/u.test(key)),
      ]);
      const requestTraces = new Set();
      const requestBindings = [];
      for (const anchor of anchors) {
        const spans =
          anchor.traceId === proof.traceId
            ? root
            : await readTrace(anchor.traceId);
        if (
          !spans.some(
            ({ role, span }) =>
              role === "orders-service" &&
              decodeId(span.spanId, 16) === anchor.spanId,
          )
        )
          continue;
        if (
          !["HTTP POST", "db.transaction"].every((name) =>
            spans.some(
              (item) =>
                item.role === "orders-service" && item.span.name === name,
            ),
          )
        )
          continue;
        const apiAnchor = apiAnchors.find(
          (candidate) =>
            candidate.traceId === anchor.traceId &&
            spans.some(
              ({ role, span }) =>
                role === "api-public" &&
                decodeId(span.spanId, 16) === candidate.spanId,
            ),
        );
        if (!apiAnchor) continue;
        let connection = null;
        if (!traceIds.has(anchor.traceId)) {
          const requestSpanKeys = new Set(
            spans
              .map(
                ({ span }) =>
                  `${decodeId(span.traceId, 32)}:${decodeId(span.spanId, 16)}`,
              )
              .filter((key) => /^[a-f0-9]{32}:[a-f0-9]{16}$/u.test(key)),
          );
          for (const { span } of spans) {
            const match = (span.links ?? []).find((link) =>
              durableSpanKeys.has(
                `${decodeId(link.traceId, 32)}:${decodeId(link.spanId, 16)}`,
              ),
            );
            if (match) {
              connection = {
                sourceTraceId: anchor.traceId,
                sourceSpanId: decodeId(span.spanId, 16),
                targetTraceId: decodeId(match.traceId, 32),
                targetSpanId: decodeId(match.spanId, 16),
              };
              break;
            }
          }
          if (!connection)
            for (const { span } of durable) {
              const match = (span.links ?? []).find((link) =>
                requestSpanKeys.has(
                  `${decodeId(link.traceId, 32)}:${decodeId(link.spanId, 16)}`,
                ),
              );
              if (match) {
                connection = {
                  sourceTraceId: decodeId(span.traceId, 32),
                  sourceSpanId: decodeId(span.spanId, 16),
                  targetTraceId: decodeId(match.traceId, 32),
                  targetSpanId: decodeId(match.spanId, 16),
                };
                break;
              }
            }
          if (!connection || !/^[a-f0-9]{16}$/u.test(connection.sourceSpanId))
            continue;
        }
        for (const { span, resource } of spans) inspectSpan(span, resource);
        requestTraces.add(anchor.traceId);
        requestBindings.push({
          traceId: anchor.traceId,
          spanId: anchor.spanId,
          role: "orders-service",
          apiSpanId: apiAnchor.spanId,
          connection,
        });
      }
      if (!requestTraces.size) return false;
      for (const { span, resource } of durable) inspectSpan(span, resource);
      return {
        durableTraceIds: [...traceIds].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        durableLinks,
        requestTraceIds: [...requestTraces].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
        requestBindings,
        spanCount: durable.length,
        spans: Object.fromEntries(
          Object.entries(G14_DURABLE_SPANS).map(([role, names]) => [
            role,
            names,
          ]),
        ),
      };
    },
    {
      timeoutMs,
      intervalMs,
      description: "G14 carrier-linked and CID-log-bound traces",
    },
  );
}

export async function collectG14BrowserTelemetry({
  proof,
  startTimeUs,
  lokiUrl,
  tempoUrl,
  nativeNginxContainerId,
  nativeNginxImageId,
  ordersContainerId,
  ordersImageId,
  apiContainerId,
  apiImageId,
  secrets = [],
  fetchImpl = fetch,
  timeoutMs = 55000,
  intervalMs = 2000,
}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 55000 ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(startTimeUs) ||
    !/^[a-f0-9]{64}$/u.test(nativeNginxContainerId ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(nativeNginxImageId ?? "") ||
    !/^[a-f0-9]{64}$/u.test(ordersContainerId ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(ordersImageId ?? "") ||
    !/^[a-f0-9]{64}$/u.test(apiContainerId ?? "") ||
    !/^sha256:[a-f0-9]{64}$/u.test(apiImageId ?? "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      proof?.correlationId ?? "",
    ) ||
    !/^[0-9a-f]{32}$/u.test(proof?.traceId ?? "") ||
    !/^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/u.test(
      proof?.ownerTraceparent ?? "",
    ) ||
    proof.realtimeTraceparent !== proof.ownerTraceparent ||
    proof.traceId !== proof.ownerTraceparent.slice(3, 35) ||
    !/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u.test(proof?.runId ?? "") ||
    !/^[0-9a-f]{40}$/u.test(proof?.candidateSha ?? "") ||
    !/^[0-9a-f]{64}$/u.test(proof?.configSha256 ?? "")
  )
    throw new TypeError("G14 telemetry proof input invalid");
  const failure = (reason) => ({
    status: "NOT_PROVEN",
    reason,
    runId: proof.runId,
    candidateSha: proof.candidateSha,
    configSha256: proof.configSha256,
  });
  const sensitive = (value) =>
    secrets.some(
      (secret) =>
        typeof secret === "string" &&
        secret.length > 0 &&
        (JSON.stringify(value) ?? "").includes(secret),
    );
  const rejectPrivacy = () => {
    const error = new Error("G14_TELEMETRY_PRIVACY");
    error.fatal = true;
    throw error;
  };
  const requiredLogs = ["edge-nginx", "api-public", "orders-service"];
  const nativeLogPath = `/var/lib/docker/containers/${nativeNginxContainerId}/${nativeNginxContainerId}-json.log`;
  const ordersLogPath = `/var/lib/docker/containers/${ordersContainerId}/${ordersContainerId}-json.log`;
  const apiLogPath = `/var/lib/docker/containers/${apiContainerId}/${apiContainerId}-json.log`;
  const deadline = AbortSignal.timeout(Math.ceil(timeoutMs));
  const deadlineAt = Date.now() + timeoutMs;
  const boundedFetch = (url, options) =>
    fetchImpl(url, {
      ...options,
      signal: AbortSignal.any([options.signal, deadline]),
    });
  const logsPromise = waitFor(
    async () => {
      const endTimeUs = Date.now() * 1000;
      const rows = await queryLokiLogs({
        baseUrl: lokiUrl,
        runId: proof.correlationId,
        startTimeUs,
        endTimeUs,
        fetchImpl: boundedFetch,
      });
      if (rows.some((row) => containsSensitiveField(row) || sensitive(row)))
        rejectPrivacy();
      const matched = rows.filter((row) =>
        row.service_name === "edge-nginx"
          ? row.correlation_id === proof.correlationId
          : ["api-public", "orders-service"].includes(row.service_name) &&
            (row.correlationId === proof.correlationId ||
              row.req?.correlationId === proof.correlationId),
      );
      const counts = Object.fromEntries(
        requiredLogs.map((role) => [
          role,
          matched.filter((row) => row.service_name === role).length,
        ]),
      );
      if (!requiredLogs.every((role) => counts[role] > 0)) return false;
      const orderRows = matched.filter(
        (row) => row.service_name === "orders-service",
      );
      if (orderRows.some((row) => row.log_file_path !== ordersLogPath)) {
        const error = new Error("G14_OWNER_LOG_IDENTITY_INVALID");
        error.fatal = true;
        throw error;
      }
      const apiRows = matched.filter(
        (row) => row.service_name === "api-public",
      );
      if (apiRows.some((row) => row.log_file_path !== apiLogPath)) {
        const error = new Error("G14_API_LOG_IDENTITY_INVALID");
        error.fatal = true;
        throw error;
      }
      const apiAnchors = [
        ...new Map(
          apiRows
            .filter(
              (row) =>
                /^[a-f0-9]{32}$/u.test(row.traceId ?? "") &&
                /^[a-f0-9]{16}$/u.test(row.spanId ?? ""),
            )
            .map(({ traceId, spanId }) => [
              `${traceId}:${spanId}`,
              { traceId, spanId },
            ]),
        ).values(),
      ];
      if (apiAnchors.length > 50) {
        const error = new Error("G14_API_TRACE_ANCHORS_EXCEED_LIMIT");
        error.fatal = true;
        throw error;
      }
      if (!apiAnchors.length) return false;
      const traceAnchors = [
        ...new Map(
          orderRows
            .filter(
              (row) =>
                /^[a-f0-9]{32}$/u.test(row.traceId ?? "") &&
                /^[a-f0-9]{16}$/u.test(row.spanId ?? ""),
            )
            .map(({ traceId, spanId }) => [
              `${traceId}:${spanId}`,
              { traceId, spanId },
            ]),
        ).values(),
      ];
      if (traceAnchors.length > 50) {
        const error = new Error("G14_OWNER_TRACE_ANCHORS_EXCEED_LIMIT");
        error.fatal = true;
        throw error;
      }
      if (!traceAnchors.length) return false;
      const requests = new Map();
      let excluded = 0;
      let duplicates = 0;
      for (const row of rows.filter(
        (record) => record.service_name === "edge-nginx",
      )) {
        if (
          row.correlation_id !== proof.correlationId ||
          row.log_file_path !== nativeLogPath ||
          typeof row.route !== "string" ||
          typeof row.method !== "string"
        ) {
          const error = new Error("G14_NATIVE_LOG_IDENTITY_INVALID");
          error.fatal = true;
          throw error;
        }
        if (
          row.route !== "client.orders" ||
          !["GET", "POST", "PUT", "DELETE"].includes(row.method)
        ) {
          excluded += 1;
          continue;
        }
        if (
          !/^[a-f0-9]{32}$/u.test(row.request_id ?? "") ||
          !Number.isInteger(row.status) ||
          row.status < 100 ||
          row.status > 599 ||
          typeof row.duration_seconds !== "number" ||
          !Number.isFinite(row.duration_seconds) ||
          row.duration_seconds < 0 ||
          !["OK", ""].includes(row.request_completion)
        ) {
          const error = new Error("G14_NATIVE_LOG_MEASUREMENT_INVALID");
          error.fatal = true;
          throw error;
        }
        const record = {
          method: row.method,
          status: row.status,
          duration: row.duration_seconds,
          completion: row.request_completion,
        };
        if (requests.has(row.request_id)) {
          if (!isDeepStrictEqual(requests.get(row.request_id), record)) {
            const error = new Error("G14_NATIVE_LOG_DUPLICATE_CONFLICT");
            error.fatal = true;
            throw error;
          }
          duplicates += 1;
        } else requests.set(row.request_id, record);
      }
      const entries = [...requests.values()];
      const completed = entries.filter(
        ({ completion, status }) => completion === "OK" && status !== 499,
      );
      if (
        !["GET", "POST"].every((method) =>
          completed.some(
            (entry) => entry.method === method && entry.status === 200,
          ),
        )
      )
        return false;
      const durations = completed
        .map(({ duration }) => duration)
        .sort((a, b) => a - b);
      const rank = (fraction) =>
        durations[Math.ceil(durations.length * fraction) - 1];
      const statusCounts = {};
      for (const { status } of entries)
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      return {
        counts,
        traceAnchors,
        apiAnchors,
        measurement: {
          status: "MEASURED",
          scope:
            "observed subset, verified CID, native edge-nginx, client.orders, observation window",
          unit: "seconds",
          percentile: "nearest-rank",
          windowStartUtc: new Date(startTimeUs / 1000).toISOString(),
          windowEndUtc: new Date(endTimeUs / 1000).toISOString(),
          sampleCount: durations.length,
          successCount: completed.filter(
            ({ status }) => status >= 200 && status < 400,
          ).length,
          errorCount: completed.filter(({ status }) => status >= 400).length,
          abortedCount: entries.filter(({ status }) => status === 499).length,
          incompleteCount: entries.filter(
            ({ status, completion }) => status !== 499 && completion === "",
          ).length,
          excludedCount: excluded,
          duplicateCount: duplicates,
          statusCounts,
          min: durations[0],
          max: durations.at(-1),
          p50: rank(0.5),
          p95: rank(0.95),
        },
      };
    },
    { timeoutMs, intervalMs, description: "G14 browser CID logs" },
  );
  const tracePromise = logsPromise.then(({ traceAnchors, apiAnchors }) =>
    waitForG14CausalTraces({
      baseUrl: tempoUrl,
      proof,
      anchors: traceAnchors,
      apiAnchors,
      startTimeUs,
      fetchImpl: boundedFetch,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      intervalMs,
      inspectSpan: (span, resource) => {
        if (
          containsSensitiveField(span) ||
          containsSensitiveField(resource) ||
          sensitive(span) ||
          sensitive(resource)
        )
          rejectPrivacy();
      },
    }),
  );
  const [logs, trace] = await Promise.allSettled([logsPromise, tracePromise]);
  if (logs.status !== "fulfilled" || trace.status !== "fulfilled") {
    const errors = [logs, trace].filter(
      (result) => result.status === "rejected",
    );
    return failure(
      errors.some(({ reason }) => reason?.message === "G14_TELEMETRY_PRIVACY")
        ? "PRIVACY_REJECTED"
        : "MISSING_OR_QUERY_FAILED",
    );
  }
  if (trace.value.spanCount === 0) return failure("MISSING_OR_QUERY_FAILED");
  return {
    status: "OBSERVED",
    runId: proof.runId,
    candidateSha: proof.candidateSha,
    configSha256: proof.configSha256,
    correlationId: proof.correlationId,
    traceId: proof.traceId,
    carrier: proof.ownerTraceparent,
    nativeSource: {
      role: "edge-nginx",
      containerId: nativeNginxContainerId,
      imageId: nativeNginxImageId,
    },
    ownerSource: {
      role: "orders-service",
      containerId: ordersContainerId,
      imageId: ordersImageId,
    },
    apiSource: {
      role: "api-public",
      containerId: apiContainerId,
      imageId: apiImageId,
    },
    logCounts: logs.value.counts,
    ordinaryApiMeasurement: logs.value.measurement,
    spans: trace.value.spans,
    durableTraceIds: trace.value.durableTraceIds,
    durableLinks: trace.value.durableLinks,
    requestTraceIds: trace.value.requestTraceIds,
    requestBindings: trace.value.requestBindings,
    spanCount: trace.value.spanCount,
  };
}

export async function queryLokiLogs({
  baseUrl,
  runId,
  startTimeUs,
  endTimeUs = Date.now() * 1000,
  fetchImpl = fetch,
}) {
  if (
    !/^[0-9a-f-]{32,36}$/iu.test(runId ?? "") ||
    !Number.isFinite(startTimeUs) ||
    !Number.isFinite(endTimeUs) ||
    endTimeUs <= startTimeUs ||
    endTimeUs - startTimeUs > 24 * 60 * 60 * 1e6
  )
    throw new TypeError("Loki query range invalid");
  const query = new URLSearchParams({
    query: `{service_name=~".+"} |= ${JSON.stringify(runId)}`,
    start: String(Math.floor(startTimeUs * 1000)),
    end: String(Math.floor(endTimeUs * 1000)),
    limit: "1000",
    direction: "forward",
  });
  const result = await api({
    baseUrl,
    path: `/loki/api/v1/query_range?${query}`,
    fetchImpl,
  });
  if (
    result?.status !== "success" ||
    result.data?.resultType !== "streams" ||
    !Array.isArray(result.data.result)
  )
    throw new Error("Loki returned an invalid range response");
  const records = [];
  for (const stream of result.data.result) {
    if (
      !stream.stream ||
      typeof stream.stream !== "object" ||
      !Array.isArray(stream.values)
    )
      throw new Error("Loki stream invalid");
    for (const value of stream.values) {
      if (
        !Array.isArray(value) ||
        typeof value[0] !== "string" ||
        !/^\d+$/u.test(value[0]) ||
        typeof value[1] !== "string"
      )
        throw new Error("Loki log entry invalid");
      const timestampUs = Number(BigInt(value[0]) / 1000n);
      if (timestampUs < startTimeUs || timestampUs > endTimeUs)
        throw new Error("Loki log outside requested range");
      let body;
      try {
        body = JSON.parse(value[1]);
      } catch {
        throw new Error("Loki log body is not JSON");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new Error("Loki log body is invalid");
      records.push({
        ...stream.stream,
        ...value[2],
        ...body,
        _timestamp: timestampUs,
      });
    }
  }
  if (records.length >= 1000)
    throw new Error("Loki response reached the query limit");
  return records;
}

export async function queryPrometheusRange({
  baseUrl,
  expression,
  startTimeUs,
  endTimeUs = Date.now() * 1000,
  fetchImpl = fetch,
}) {
  if (
    typeof expression !== "string" ||
    expression.length === 0 ||
    expression.length > 4096 ||
    !Number.isFinite(startTimeUs) ||
    !Number.isFinite(endTimeUs) ||
    endTimeUs <= startTimeUs ||
    endTimeUs - startTimeUs > 24 * 60 * 60 * 1e6
  )
    throw new TypeError("Prometheus query range invalid");
  const read = async (queryExpression) => {
    const query = new URLSearchParams({
      query: queryExpression,
      start: String(startTimeUs / 1e6),
      end: String(endTimeUs / 1e6),
      step: "5",
    });
    const result = await api({
      baseUrl,
      path: `/api/v1/query_range?${query}`,
      fetchImpl,
    });
    if (
      result?.status !== "success" ||
      result.data?.resultType !== "matrix" ||
      !Array.isArray(result.data.result)
    )
      throw new Error("Prometheus returned an invalid range response");
    const records = [];
    for (const series of result.data.result) {
      if (
        !series.metric ||
        typeof series.metric !== "object" ||
        !Array.isArray(series.values)
      )
        throw new Error("Prometheus series invalid");
      for (const pair of series.values) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !Number.isFinite(pair[0]) ||
          typeof pair[1] !== "string" ||
          !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(pair[1]) ||
          !Number.isFinite(Number(pair[1]))
        )
          throw new Error("Prometheus sample invalid");
        const evaluationUs = pair[0] * 1e6;
        if (evaluationUs < startTimeUs || evaluationUs > endTimeUs)
          throw new Error("Prometheus sample outside requested range");
        const labels = Object.fromEntries(
          Object.entries(series.metric)
            .filter(([name]) => name !== "__name__")
            .sort(([a], [b]) => a.localeCompare(b)),
        );
        records.push({ labels, evaluationUs, value: Number(pair[1]) });
      }
    }
    return records;
  };
  const [values, timestamps] = await Promise.all([
    read(expression),
    read(`timestamp(${expression})`),
  ]);
  const key = (record) =>
    `${JSON.stringify(record.labels)}:${record.evaluationUs}`;
  const sourceTimes = new Map(
    timestamps.map((record) => [key(record), record.value * 1e6]),
  );
  return values
    .map((record) => {
      const timestamp = sourceTimes.get(key(record));
      if (!Number.isFinite(timestamp) || timestamp > record.evaluationUs)
        throw new Error("Prometheus source timestamp unavailable or invalid");
      return { ...record.labels, _timestamp: timestamp, value: record.value };
    })
    .filter(
      (record) =>
        record._timestamp >= startTimeUs && record._timestamp <= endTimeUs,
    );
}

export async function waitForOwnedMetricFamilySamples({
  baseUrl,
  family,
  startTimeUs,
  fetchImpl = fetch,
  timeoutMs = 60000,
  intervalMs = 2000,
}) {
  const attributeFilters = Object.entries(family.attributes ?? {}).map(
    ([key, value]) => {
      if (!/^[a-z][a-z0-9_]*$/u.test(key) || typeof value !== "string")
        throw new TypeError("metric filter invalid");
      return `${key}=${JSON.stringify(value)}`;
    },
  );
  let latestObservation;
  try {
    return await waitFor(
      async () => {
        const matches = [];
        const componentStates = [];
        latestObservation = {
          name: family.name,
          owners: [...family.owners],
          components: componentStates,
        };
        for (const component of family.components) {
          const stream = `${prometheusMetricName(family.name)}${component}`;
          const state = {
            component,
            streamPresent: false,
            presentOwners: [],
            missingOwners: [...family.owners],
            sampleCount: 0,
          };
          componentStates.push(state);
          try {
            const records = await queryPrometheusRange({
              baseUrl,
              expression: `${stream}{${attributeFilters.join(",")}}`,
              startTimeUs,
              fetchImpl,
            });
            const selected = records.filter(
              (record) =>
                record._timestamp > startTimeUs &&
                family.owners.includes(
                  record[family.ownerLabel ?? "service_name"],
                ),
            );
            state.streamPresent = records.length > 0;
            state.presentOwners = family.owners.filter((owner) =>
              selected.some(
                (record) =>
                  record[family.ownerLabel ?? "service_name"] === owner,
              ),
            );
            state.missingOwners = family.owners.filter(
              (owner) => !state.presentOwners.includes(owner),
            );
            state.sampleCount = selected.length;
            if (selected.length)
              matches.push({
                stream,
                sampleCount: selected.length,
                services: state.presentOwners,
              });
          } catch (error) {
            state.queryFailure = {
              outcome: "QUERY_FAILED",
              ...(["Error", "TypeError", "AbortError", "TimeoutError"].includes(
                error?.name,
              )
                ? { errorClass: error.name }
                : {}),
              ...(Number.isInteger(error?.httpStatus)
                ? { httpStatus: error.httpStatus }
                : {}),
            };
            throw error;
          }
        }
        return matches.length === family.components.length &&
          matches.every((match) =>
            family.owners.every((owner) => match.services.includes(owner)),
          )
          ? matches
          : false;
      },
      {
        timeoutMs,
        intervalMs,
        description: `Prometheus metric family ${family.name} from every owning runtime`,
      },
    );
  } catch (error) {
    if (error !== null && typeof error === "object" && latestObservation)
      error.metricFamilyObservation = latestObservation;
    throw error;
  }
}

function metricRecordAttribute(record, name) {
  const direct =
    record?.[name] ??
    record?.[`attributes_${name}`] ??
    record?.[`attributes.${name}`] ??
    record?.attributes?.[name];
  return typeof direct === "string" || typeof direct === "number"
    ? direct
    : undefined;
}

const CONVERGENCE_METRIC_CONTRACT = [
  {
    name: "coffee_aroma_attempt_results_total",
    attributes: { result: "unknown_outcome" },
    value: 1,
  },
  { name: "coffee_aroma_unknown_outcomes_total", attributes: {}, value: 1 },
  {
    name: "coffee_aroma_unknown_outcomes_current",
    attributes: {},
    values: [1, 0],
  },
  {
    name: "coffee_aroma_recovery_results_total",
    attributes: { result: "recovered_applied" },
    value: 1,
  },
];

export async function waitForConvergenceMetricSamples({
  baseUrl,
  expectedMetrics,
  startTimeUs,
  onObservation,
  fetchImpl = fetch,
  timeoutMs = 60000,
  intervalMs = 2000,
}) {
  return waitFor(
    async () => {
      const observed = {};
      const diagnostics = {};
      let complete = true;
      for (const expected of expectedMetrics) {
        const stream = prometheusMetricName(expected.name);
        const filters = Object.entries(expected.attributes ?? {}).map(
          ([key, value]) => {
            if (!/^[a-z][a-z0-9_]*$/u.test(key) || typeof value !== "string")
              throw new TypeError("metric filter invalid");
            return `${key}=${JSON.stringify(value)}`;
          },
        );
        const samples = await queryPrometheusRange({
          baseUrl,
          expression: `${stream}{service_name="aroma-convergence"${filters.length ? "," + filters.join(",") : ""}}`,
          startTimeUs,
          fetchImpl,
        });
        const matching = samples.filter(
          (sample) =>
            sample._timestamp > startTimeUs &&
            sample.service_name === "aroma-convergence" &&
            Object.entries(expected.attributes ?? {}).every(
              ([name, value]) => sample[name] === value,
            ),
        );
        const values = metricValues(matching);
        const wanted = expected.values ?? [expected.value];
        const missingValues = wanted.filter((value) => !values.includes(value));
        diagnostics[expected.name] = {
          streamPresent: samples.length > 0,
          queryRows: samples.length,
          ownerRows: samples.filter(
            (sample) => sample.service_name === "aroma-convergence",
          ).length,
          attrMatchedRows: matching.length,
          observedValues: [...new Set(values)]
            .sort((a, b) => a - b)
            .slice(0, 16),
          expectedValues: wanted,
          missingValues,
          latestTimestampUs: matching.length
            ? Math.max(...matching.map((sample) => sample._timestamp))
            : null,
        };
        if (missingValues.length) complete = false;
        observed[expected.name] = {
          stream,
          owner: "aroma-convergence",
          sampleCount: matching.length,
          observedValues: values,
          expectedValues: wanted,
        };
      }
      onObservation?.(diagnostics);
      return complete ? observed : false;
    },
    {
      timeoutMs,
      intervalMs,
      description: "real aroma-convergence owner metrics from Prometheus",
    },
  );
}

function validConvergenceMetricContract(metrics, phase) {
  const expected =
    phase === "unknown-current"
      ? CONVERGENCE_METRIC_CONTRACT.slice(0, 3).map((metric) =>
          metric.values
            ? { name: metric.name, attributes: metric.attributes, value: 1 }
            : metric,
        )
      : CONVERGENCE_METRIC_CONTRACT;
  if (!Array.isArray(metrics) || metrics.length !== expected.length)
    return false;
  return expected.every((expectedMetric) => {
    const actual = metrics.find(
      (metric) => metric?.name === expectedMetric.name,
    );
    return (
      actual !== undefined &&
      JSON.stringify(actual.attributes ?? {}) ===
        JSON.stringify(expectedMetric.attributes) &&
      actual.value === expectedMetric.value &&
      JSON.stringify(actual.values) === JSON.stringify(expectedMetric.values)
    );
  });
}

function hasExactValue(value, expected, depth = 0) {
  if (value === expected) return true;
  if (depth >= 8 || value === null || typeof value !== "object") return false;
  return Object.values(value)
    .slice(0, 100)
    .some((child) => hasExactValue(child, expected, depth + 1));
}

export function isExporterMetricForSignal(sample, metricName) {
  const componentSignal =
    /^otelcol\.exporter\.otlphttp\.(logs|metrics|traces)$/u.exec(
      sample.component_id ?? "",
    )?.[1];
  if (
    !componentSignal ||
    (metricName.includes("_queue_") && sample.data_type !== componentSignal) ||
    (sample.data_type !== undefined && sample.data_type !== componentSignal)
  )
    return false;
  const expectedSignal = metricName.endsWith("_log_records")
    ? "logs"
    : metricName.endsWith("_metric_points")
      ? "metrics"
      : metricName.endsWith("_spans")
        ? "traces"
        : componentSignal;
  return componentSignal === expectedSignal;
}

export async function verifyCollectorQueueMetrics({
  baseUrl,
  startTimeUs,
  lossStartTimeUs = startTimeUs,
  lossEndTimeUs,
  queueCapacity,
  fetchImpl = fetch,
  timeoutMs = 60000,
  intervalMs = 2000,
}) {
  const metricNames = [
    "otelcol_exporter_queue_size",
    "otelcol_exporter_queue_capacity",
    "otelcol_exporter_enqueue_failed_log_records",
    "otelcol_exporter_enqueue_failed_metric_points",
    "otelcol_exporter_enqueue_failed_spans",
    "otelcol_exporter_send_failed_log_records",
    "otelcol_exporter_send_failed_metric_points",
    "otelcol_exporter_send_failed_spans",
    "otelcol_exporter_sent_log_records",
    "otelcol_exporter_sent_metric_points",
    "otelcol_exporter_sent_spans",
  ];
  let lastObservation = null;
  try {
    return await waitFor(
      async () => {
        const samplesByMetric = {};
        for (const metricName of metricNames) {
          const isCounter =
            metricName.includes("_sent_") ||
            metricName.includes("_send_failed_") ||
            metricName.includes("_enqueue_failed_");
          const stream = `${metricName}${isCounter ? "_total" : ""}`;
          const processScopedLossMetric =
            metricName.includes("_send_failed_") ||
            metricName.includes("_enqueue_failed_");
          const samples = await queryPrometheusRange({
            fetchImpl,
            baseUrl,
            expression: `${stream}{service_name="otel-collector"}`,
            startTimeUs: processScopedLossMetric
              ? lossStartTimeUs
              : startTimeUs,
            ...(processScopedLossMetric && lossEndTimeUs !== undefined
              ? { endTimeUs: lossEndTimeUs }
              : {}),
          });
          const selected = samples.filter((sample) =>
            isExporterMetricForSignal(sample, metricName),
          );
          const values = metricValues(selected);
          const timestampsUs = selected
            .map(metricTimestampUs)
            .filter(Number.isFinite);
          samplesByMetric[metricName] = {
            stream,
            available: selected.length > 0,
            sampleCount: selected.length,
            values,
            timestampsUs,
          };
        }
        const queue = samplesByMetric.otelcol_exporter_queue_size.values;
        const capacity = samplesByMetric.otelcol_exporter_queue_capacity.values;
        const sent = ["log_records", "metric_points", "spans"].flatMap(
          (signal) => samplesByMetric[`otelcol_exporter_sent_${signal}`].values,
        );
        const requiredFreshMetrics = [
          "otelcol_exporter_queue_size",
          "otelcol_exporter_queue_capacity",
          "otelcol_exporter_sent_log_records",
          "otelcol_exporter_sent_metric_points",
          "otelcol_exporter_sent_spans",
        ];
        const missingFreshRequiredMetrics = requiredFreshMetrics.filter(
          (metric) =>
            !samplesByMetric[metric].timestampsUs.some(
              (timestamp) => timestamp > startTimeUs,
            ),
        );
        const freshQueueSamples = missingFreshRequiredMetrics.length === 0;
        const positiveOutageLossMetrics = [
          "otelcol_exporter_send_failed_log_records",
          "otelcol_exporter_send_failed_metric_points",
          "otelcol_exporter_send_failed_spans",
        ].filter(
          (metric) =>
            samplesByMetric[metric].timestampsUs.some(
              (timestamp) =>
                timestamp >= lossStartTimeUs &&
                (lossEndTimeUs === undefined || timestamp < lossEndTimeUs),
            ) && samplesByMetric[metric].values.some((value) => value > 0),
        );
        const outageLossSamples = positiveOutageLossMetrics.length > 0;
        const lossWindowEndedAtRestart =
          lossEndTimeUs !== undefined && lossEndTimeUs === startTimeUs;
        lastObservation = {
          metrics: Object.fromEntries(
            metricNames.map((metricName) => {
              const sample = samplesByMetric[metricName];
              return [
                metricName,
                {
                  available: sample.available,
                  sampleCount: sample.sampleCount,
                  latestTimestampUs: sample.timestampsUs.length
                    ? Math.max(...sample.timestampsUs)
                    : null,
                  ...(sample.values.length
                    ? {
                        minimum: Math.min(...sample.values),
                        maximum: Math.max(...sample.values),
                      }
                    : {}),
                },
              ];
            }),
          ),
          missingFreshRequiredMetrics,
          positiveOutageLossMetrics,
          outageLossObserved: outageLossSamples,
          queueWithinBounds:
            queue.length > 0 &&
            queue.every((value) => value >= 0 && value <= queueCapacity),
          configuredCapacityObserved: capacity.some(
            (value) => value === queueCapacity,
          ),
          positiveSentMetrics: [
            "otelcol_exporter_sent_log_records",
            "otelcol_exporter_sent_metric_points",
            "otelcol_exporter_sent_spans",
          ].filter((metric) =>
            samplesByMetric[metric].values.some((value) => value > 0),
          ),
          freshRequiredMetricsObserved: freshQueueSamples,
        };
        if (
          queue.length === 0 ||
          capacity.length === 0 ||
          !capacity.some((value) => value === queueCapacity) ||
          queue.some((value) => value < 0 || value > queueCapacity) ||
          !outageLossSamples ||
          !sent.some((value) => value > 0) ||
          !freshQueueSamples
        )
          return false;
        return {
          status: "PASS",
          service: "otel-collector",
          queueCapacity,
          queueSampleCount: queue.length,
          queueMaximum: Math.max(...queue),
          capacitySampleCount: capacity.length,
          postRestartMetricTimestampsStrictlyAfterStartedAt:
            lossWindowEndedAtRestart,
          historicalLossMetricWindowEndedAtRestart: lossWindowEndedAtRestart,
          sendFailureSamples: Object.fromEntries(
            ["log_records", "metric_points", "spans"].map((signal) => [
              signal,
              samplesByMetric[`otelcol_exporter_send_failed_${signal}`],
            ]),
          ),
          sentSamples: Object.fromEntries(
            ["log_records", "metric_points", "spans"].map((signal) => [
              signal,
              samplesByMetric[`otelcol_exporter_sent_${signal}`],
            ]),
          ),
          enqueueFailureSamples: Object.fromEntries(
            ["log_records", "metric_points", "spans"].map((signal) => [
              signal,
              samplesByMetric[`otelcol_exporter_enqueue_failed_${signal}`],
            ]),
          ),
          optionalMetricStreamsAbsent: ["log_records", "metric_points", "spans"]
            .flatMap((signal) => [
              `otelcol_exporter_enqueue_failed_${signal}`,
              `otelcol_exporter_send_failed_${signal}`,
              `otelcol_exporter_sent_${signal}`,
            ])
            .filter((metricName) => !samplesByMetric[metricName].available),
        };
      },
      {
        timeoutMs,
        intervalMs,
        description:
          "Collector self-scrape queue, send-failure, and recovery counters",
      },
    );
  } catch (error) {
    if (error instanceof Error && lastObservation !== null)
      error.message += `; last bounded observation=${JSON.stringify(lastObservation)}`;
    throw error;
  }
}

function collectorExpiredRetryDropEvidence({ name, startTimeUs }) {
  const since = new Date(Math.floor(startTimeUs / 1000)).toISOString();
  const logs = spawnSync("docker", ["logs", "--since", since, name], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (logs.error || logs.status !== 0)
    throw new Error(
      "could not inspect Collector logs for expired retry evidence",
    );
  return parseCollectorExpiredRetryDrops(
    `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
  );
}

export function parseCollectorExpiredRetryDrops(text) {
  const droppedLines = text
    .split("\n")
    .filter(
      (line) =>
        /Exporting failed\. Dropping data\./iu.test(line) &&
        /no more retries left/iu.test(line),
    );
  const droppedItems = droppedLines.reduce((total, line) => {
    const raw =
      line.match(/(?:^|\s)dropped_items=(\d+)(?=\s|$)/u)?.[1] ??
      line.match(/"dropped_items"\s*:\s*(\d+)(?=\s*[,}])/u)?.[1];
    const count = Number(raw ?? 0);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(total + count))
      throw new Error("Collector dropped item count is invalid");
    return total + count;
  }, 0);
  if (droppedLines.length === 0 || droppedItems === 0)
    throw new Error(
      "Collector outage did not reach the configured retry expiry and report a dropped batch",
    );
  return {
    status: "PASS",
    expiredRetryDropEvents: droppedLines.length,
    droppedItems,
  };
}

async function fixtureHealth({ baseUrl, path, budgetMs }) {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(budgetMs),
  });
  const latencyMs = performance.now() - started;
  if (!response.ok || latencyMs >= budgetMs)
    throw new Error(
      `fixture health ${path} failed HTTP ${response.status} in ${Math.round(latencyMs)}ms`,
    );
  return Math.round(latencyMs);
}

async function sourceDirectoryDigest(root, directory) {
  const files = [];
  const visit = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  const absolute = join(root, directory);
  await visit(absolute);
  if (files.length === 0)
    return { status: "UNAVAILABLE", fileCount: 0, sha256: null };
  const digest = createHash("sha256");
  for (const file of files) {
    const relativePath = file.slice(absolute.length + 1);
    const content = await readFile(file);
    digest
      .update(relativePath)
      .update("\0")
      .update(createHash("sha256").update(content).digest())
      .update("\0");
  }
  return {
    status: "PASS",
    fileCount: files.length,
    sha256: digest.digest("hex"),
  };
}

export async function sourceIdentity(root = REPO_ROOT) {
  const [configBytes, bomBytes] = await Promise.all([
    readFile(join(root, "config/platform.yaml")),
    readFile(join(root, "config/toolchain-versions.json")),
  ]);
  const bom = JSON.parse(bomBytes);
  let baseSha = null;
  let sourceFiles = [];
  let sourceListAvailable = false;
  try {
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    sourceFiles = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "buffer" },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    sourceListAvailable = sourceFiles.length > 0;
  } catch {}
  const sourceDigest = createHash("sha256");
  let missingFiles = 0;
  for (const relativePath of sourceFiles) {
    sourceDigest.update(relativePath).update("\0");
    try {
      sourceDigest.update(
        createHash("sha256")
          .update(await readFile(join(root, relativePath)))
          .digest(),
      );
    } catch {
      missingFiles += 1;
      sourceDigest.update("missing");
    }
    sourceDigest.update("\0");
  }
  const runtimeArtifacts = Object.fromEntries(
    await Promise.all(
      [
        "packages/platform-runtime/dist",
        "packages/platform-observability/dist",
      ].map(async (directory) => [
        directory,
        await sourceDirectoryDigest(root, directory),
      ]),
    ),
  );
  const configSha256 = createHash("sha256").update(configBytes).digest("hex");
  const bomSha256 = createHash("sha256").update(bomBytes).digest("hex");
  const sourceSha256 = sourceListAvailable ? sourceDigest.digest("hex") : null;
  const identityHash =
    sourceSha256 &&
    Object.values(runtimeArtifacts).every((value) => value.status === "PASS")
      ? createHash("sha256")
          .update(
            JSON.stringify({
              sourceSha256,
              configSha256,
              bomSha256,
              runtimeArtifacts,
            }),
          )
          .digest("hex")
      : null;
  return {
    baseSha,
    configSha256,
    bomSha256,
    imageRefs: Object.fromEntries(
      [
        "otelCollectorImage",
        "grafanaImage",
        "lokiImage",
        "prometheusImage",
        "tempoImage",
        "nodeImage",
        "kafkaImage",
        "nginxImage",
      ]
        .filter((key) => bom[key] !== undefined)
        .map((key) => [key, bom[key]]),
    ),
    sourceFiles: {
      status:
        sourceListAvailable && missingFiles === 0 ? "PASS" : "UNAVAILABLE",
      fileCount: sourceFiles.length,
      missingFileCount: missingFiles,
      sha256: sourceSha256,
    },
    runtimeArtifacts,
    identityHash,
  };
}

export async function readG14Qualification(evidenceDir, context, config) {
  const path = join(
    evidenceDir,
    "gates/G14_OBSERVABILITY/artifacts/realtime-capacity.json",
  );
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 65536 ||
    (await realpath(path)) !== path
  )
    throw new Error("G14 qualification admission file invalid");
  const admission = JSON.parse(await readFile(path, "utf8"));
  const receipt = admission.receipt;
  const admittedAt = Date.parse(admission.admittedAt);
  const endedAt = Date.parse(receipt?.endedAt);
  if (
    receipt?.status !== "PASS" ||
    !/^i12-[a-f0-9]{16}$/u.test(receipt.runId ?? "") ||
    receipt.candidateSha !== context.candidateSha ||
    receipt.baseConfigSha256 !== context.baseConfigSha256 ||
    !/^[a-f0-9]{64}$/u.test(admission.receiptSha256 ?? "") ||
    !Number.isFinite(admittedAt) ||
    !Number.isFinite(endedAt) ||
    admittedAt < endedAt ||
    admittedAt > Date.now() ||
    admittedAt - endedAt >
      config.verification.realtimeQualification.maximumAgeSeconds * 1000 ||
    !Number.isFinite(receipt.elapsedMs) ||
    receipt.elapsedMs < 0 ||
    receipt.elapsedMs >
      config.verification.realtimeQualification.budgetSeconds * 1000
  )
    throw new Error("G14 qualification admission mismatch");
  const claimPath = join(
    resolve(userInfo().homedir),
    ".local/state/coffee-platform/realtime-claims",
    `${receipt.runId}.json`,
  );
  if (admission.claimPath !== claimPath)
    throw new Error("G14 qualification claim path mismatch");
  const claimInfo = await lstat(claimPath);
  if (
    !claimInfo.isFile() ||
    claimInfo.isSymbolicLink() ||
    claimInfo.uid !== process.getuid() ||
    (claimInfo.mode & 0o777) !== 0o400 ||
    claimInfo.size > 4096 ||
    (await realpath(claimPath)) !== claimPath
  )
    throw new Error("G14 qualification claim invalid");
  const claim = JSON.parse(await readFile(claimPath, "utf8"));
  if (
    !isDeepStrictEqual(claim, {
      runId: receipt.runId,
      receiptSha256: admission.receiptSha256,
    })
  )
    throw new Error("G14 qualification claim mismatch");
  return {
    runId: receipt.runId,
    candidateSha: receipt.candidateSha,
    baseConfigSha256: receipt.baseConfigSha256,
    receiptSha256: admission.receiptSha256,
    admittedAt: admission.admittedAt,
  };
}

export function observabilityVerificationCoverage(
  evidence,
  { config, sourceHashStable = false, backendArtifactsComplete = false } = {},
) {
  const launchRoles = [
    ...new Set(
      (evidence.launchPathProof?.roles ?? [])
        .map(({ role }) => role)
        .filter((role) => typeof role === "string"),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const launchNodeRuntimes = launchRoles.filter((role) =>
    NODE_RUNTIME_TARGETS.includes(role),
  );
  const metricApplicability = evidence.metricApplicability ?? {};
  const convergenceProof = metricApplicability.aromaConvergenceProof;
  const matrixNodeRuntimes =
    evidence.runtimeMetricMatrix?.status === "PASS"
      ? (evidence.runtimeMetricMatrix.runtimeMetrics?.roles ?? [])
          .map(({ role }) => role)
          .filter((role) => NODE_RUNTIME_TARGETS.includes(role))
      : [];
  const matrix = evidence.runtimeMetricMatrix;
  const expectedImages = evidence.verifiedRuntimeImages;
  const parentSource = evidence.provenanceStart;
  const matrixSource = matrix?.source;
  const matrixBound =
    /^[a-f0-9]{40}$/u.test(parentSource?.baseSha ?? "") &&
    /^[a-f0-9]{64}$/u.test(parentSource?.configSha256 ?? "") &&
    /^[a-f0-9]{64}$/u.test(parentSource?.identityHash ?? "") &&
    /^[a-f0-9]{64}$/u.test(parentSource?.bomSha256 ?? "") &&
    matrixSource?.identityHash === parentSource.identityHash &&
    matrixSource.baseSha === parentSource.baseSha &&
    matrixSource.configSha256 === parentSource.configSha256 &&
    matrixSource.bomSha256 === parentSource.bomSha256 &&
    matrix?.configuration?.platformConfigSha256 === parentSource.configSha256 &&
    matrix.configuration.bomSha256 === parentSource.bomSha256;
  const roles = matrix?.runtimeMetrics?.roles;
  const images = matrix?.images;
  let readiness = false;
  let metricFamilies = false;
  try {
    readiness = !!validateDependencyReadiness(
      matrix?.composeReceipt?.dependencyReadiness,
      config,
    );
  } catch {
    /* incomplete evidence remains NOT_RUN */
  }
  try {
    const families = runtimeMetricFamilies(config);
    const actual = matrix?.runtimeMetrics?.otlpFamilies;
    metricFamilies =
      Array.isArray(actual) &&
      actual.length === families.length &&
      families.every((family) => {
        const matches = actual.filter((item) => item.name === family.name);
        if (
          matches.length !== 1 ||
          matches[0].status !== "PASS" ||
          !isDeepStrictEqual(matches[0].owners, family.owners) ||
          !isDeepStrictEqual(matches[0].components, family.components) ||
          !isDeepStrictEqual(matches[0].attributes, family.attributes)
        )
          return false;
        sanitizeRuntimeMetricMatches(family, matches[0].matches);
        return true;
      });
  } catch {
    /* incomplete metric evidence remains NOT_RUN */
  }
  const expectedRoleSet = new Set(NODE_RUNTIME_TARGETS);
  const exactRoles =
    Array.isArray(roles) &&
    roles.length === expectedRoleSet.size &&
    roles.every(
      (item) => item.status === "PASS" && expectedRoleSet.delete(item.role),
    ) &&
    expectedRoleSet.size === 0;
  const expectedImageMap = new Map(
    (Array.isArray(expectedImages) ? expectedImages : []).map(
      ({ service, imageId }) => [service, imageId],
    ),
  );
  const exactImages =
    Array.isArray(expectedImages) &&
    expectedImages.length === OBSERVABILITY_TARGETS.length &&
    expectedImageMap.size === OBSERVABILITY_TARGETS.length &&
    Array.isArray(images) &&
    images.length === OBSERVABILITY_TARGETS.length &&
    images.every(
      (item) =>
        item.status === "PASS" &&
        expectedImageMap.get(item.role) === item.imageId &&
        expectedImageMap.delete(item.role),
    ) &&
    expectedImageMap.size === 0;
  const browser = evidence.launchPathProof;
  const telemetry = browser?.telemetrySubproof;
  const child = evidence.browserCorrelationChild?.proof;
  const nginx = expectedImages?.find(({ service }) => service === "edge-nginx");
  const orders = expectedImages?.find(
    ({ service }) => service === "orders-service",
  );
  const api = expectedImages?.find(({ service }) => service === "api-public");
  const measurement = telemetry?.ordinaryApiMeasurement;
  const measured =
    measurement?.status === "MEASURED" &&
    Number.isSafeInteger(measurement.sampleCount) &&
    measurement.sampleCount >= 2 &&
    Number.isSafeInteger(measurement.successCount) &&
    measurement.successCount >= 2 &&
    measurement.successCount <= measurement.sampleCount &&
    [measurement.min, measurement.p50, measurement.p95, measurement.max].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) &&
    measurement.min <= measurement.p50 &&
    measurement.p50 <= measurement.p95 &&
    measurement.p95 <= measurement.max &&
    Number.isFinite(Date.parse(measurement.windowStartUtc)) &&
    Number.isFinite(Date.parse(measurement.windowEndUtc)) &&
    Date.parse(measurement.windowStartUtc) <=
      Date.parse(measurement.windowEndUtc);
  const trace =
    evidence.browserCorrelationChild?.checkoutRemoved === true &&
    evidence.browserCorrelationChild?.evidenceRemoved === true &&
    evidence.browserCorrelationChild?.cleanup?.verified === true &&
    child?.status === "PASS" &&
    child.browserCleanup === "EXACT_OWNED_CONTAINER_REMOVED" &&
    browser?.browserRefetchMatched === true &&
    browser.ownerCausation === true &&
    browser.traceStatus === "PASS" &&
    telemetry?.status === "OBSERVED" &&
    telemetry.runId === child?.runId &&
    typeof child?.runId === "string" &&
    telemetry.candidateSha === child?.candidateSha &&
    /^[a-f0-9]{40}$/u.test(child?.candidateSha ?? "") &&
    telemetry.configSha256 === child?.configSha256 &&
    /^[a-f0-9]{64}$/u.test(child?.configSha256 ?? "") &&
    telemetry.correlationId === child?.correlationId &&
    telemetry.traceId === child?.traceId &&
    telemetry.carrier === child?.ownerTraceparent &&
    child?.ownerTraceparent === child?.realtimeTraceparent &&
    measured &&
    telemetry.nativeSource?.role === "edge-nginx" &&
    telemetry.nativeSource.imageId === nginx?.imageId &&
    /^[a-f0-9]{64}$/u.test(telemetry.nativeSource.containerId ?? "") &&
    telemetry.ownerSource?.role === "orders-service" &&
    telemetry.ownerSource.imageId === orders?.imageId &&
    /^[a-f0-9]{64}$/u.test(telemetry.ownerSource.containerId ?? "") &&
    telemetry.apiSource?.role === "api-public" &&
    telemetry.apiSource.imageId === api?.imageId &&
    /^[a-f0-9]{64}$/u.test(telemetry.apiSource.containerId ?? "") &&
    Number.isSafeInteger(telemetry.logCounts?.["api-public"]) &&
    telemetry.logCounts["api-public"] > 0 &&
    Array.isArray(telemetry.durableTraceIds) &&
    telemetry.durableTraceIds.includes(child?.traceId) &&
    new Set(telemetry.durableTraceIds).size ===
      telemetry.durableTraceIds.length &&
    telemetry.durableTraceIds.every((id) => /^[a-f0-9]{32}$/u.test(id)) &&
    Array.isArray(telemetry.durableLinks) &&
    telemetry.durableLinks.length === telemetry.durableTraceIds.length - 1 &&
    telemetry.durableLinks.every(
      (link) =>
        link.linkedTraceId === child.traceId &&
        link.traceId !== child.traceId &&
        telemetry.durableTraceIds.includes(link.traceId) &&
        /^[a-f0-9]{16}$/u.test(link.linkedSpanId ?? ""),
    ) &&
    new Set(telemetry.durableLinks.map((link) => link.traceId)).size ===
      telemetry.durableLinks.length &&
    Array.isArray(telemetry.requestTraceIds) &&
    telemetry.requestTraceIds.length > 0 &&
    telemetry.requestTraceIds.every((id) => /^[a-f0-9]{32}$/u.test(id)) &&
    Array.isArray(telemetry.requestBindings) &&
    telemetry.requestTraceIds.every((id) =>
      telemetry.requestBindings.some(
        (binding) =>
          binding.traceId === id &&
          binding.role === "orders-service" &&
          /^[a-f0-9]{16}$/u.test(binding.spanId ?? "") &&
          /^[a-f0-9]{16}$/u.test(binding.apiSpanId ?? "") &&
          (telemetry.durableTraceIds.includes(id) ||
            (binding.connection &&
              /^[a-f0-9]{16}$/u.test(binding.connection.sourceSpanId ?? "") &&
              /^[a-f0-9]{16}$/u.test(binding.connection.targetSpanId ?? "") &&
              ((binding.connection.sourceTraceId === id &&
                telemetry.durableTraceIds.includes(
                  binding.connection.targetTraceId,
                )) ||
                (binding.connection.targetTraceId === id &&
                  telemetry.durableTraceIds.includes(
                    binding.connection.sourceTraceId,
                  ))))),
      ),
    ) &&
    Object.entries(G14_DURABLE_SPANS).every(([role, names]) =>
      names.every((name) => telemetry.spans?.[role]?.includes(name)),
    );
  const qualification = evidence.qualificationAdmission;
  const admitted =
    /^i12-[a-f0-9]{16}$/u.test(qualification?.runId ?? "") &&
    /^[a-f0-9]{64}$/u.test(qualification?.receiptSha256 ?? "") &&
    Number.isFinite(Date.parse(qualification?.admittedAt)) &&
    qualification.candidateSha === evidence.provenanceStart?.baseSha &&
    qualification.baseConfigSha256 === evidence.provenanceStart?.configSha256;
  const fullSystem =
    evidence.status === "PASS" &&
    sourceHashStable &&
    backendArtifactsComplete &&
    evidence.syntheticNodeNotReady?.forMs ===
      config?.telemetry?.alerts?.notReady?.forMs &&
    evidence.syntheticNodeNotReady?.threshold ===
      config?.telemetry?.alerts?.notReady?.threshold &&
    evidence.syntheticNodeNotReady?.ruleUid ===
      `g14-v${config?.telemetry?.alerts?.version}-service-not-ready-synthetic` &&
    evidence.provenanceStart?.sourceFiles?.status === "PASS" &&
    observabilityGateComplete(evidence) &&
    admitted &&
    matrix?.status === "PASS" &&
    matrix.cleanupVerified === true &&
    matrix.composeReceipt?.postgres?.externalPostgres === true &&
    matrix.composeReceipt?.externalCleanup?.verified === true &&
    exactRoles &&
    matrixBound &&
    exactImages &&
    metricFamilies &&
    ["unknown-current", "recovered-terminal"].every(
      (phase) => convergenceProof?.[phase]?.status === "PASS",
    ) &&
    readiness &&
    trace;
  return {
    verificationScope: fullSystem ? "launch" : "operations-component",
    statusAppliesTo: fullSystem
      ? "G14 launch verification"
      : "mandatory Operations backend and instrumentation gates",
    fullSystemG14: {
      status: fullSystem ? "PASS" : "NOT_RUN",
      owner: "#13",
      reason: fullSystem
        ? "Verified launch evidence and separately admitted realtime qualification."
        : "Issue #64 verifies functional telemetry; full-system SLO, chaos, capacity and business launch acceptance remain owned by #13.",
      requiredNodeRuntimeCount: NODE_RUNTIME_TARGETS.length,
      launchPathNodeRuntimes: launchNodeRuntimes,
      metricMatrixNodeRuntimes: matrixNodeRuntimes,
      launchPathNativeNginx: launchRoles.includes("edge-nginx"),
      launchPathKafkaRole: launchRoles.includes("kafka"),
      convergenceMetricProof: {
        ownerRuntime: "aroma-convergence",
        processKind: "driver-container SQL-backed proof helper",
        status: ["unknown-current", "recovered-terminal"].every(
          (phase) => convergenceProof?.[phase]?.status === "PASS",
        )
          ? "PASS"
          : "NOT_RUN",
      },
      observedOwnerMetricFamilies: Object.keys(metricApplicability)
        .filter((name) => name !== "aromaConvergenceProof")
        .sort(),
      nodeRuntimesNotClaimedAsLive: NODE_RUNTIME_TARGETS.filter(
        (role) =>
          !launchNodeRuntimes.includes(role) &&
          !matrixNodeRuntimes.includes(role),
      ),
    },
  };
}

function diskPressureComplete(evidence) {
  return (
    evidence.diskPressureStatus === "PASS" &&
    evidence.diskPressure?.status === "PASS" &&
    ["loki", "grafana", "prometheus", "tempo"].every(
      (name) => evidence.diskPressure?.backends?.[name]?.status === "PASS",
    )
  );
}

async function persistEvidence({
  root,
  evidence,
  secrets = [],
  launchEvidenceDir,
  config,
}) {
  const dir = join(root, "evidence/observability", evidence.runId);
  const sanitize = (value) =>
    secrets.reduce(
      (result, secret) =>
        secret ? result.replaceAll(secret, "[REDACTED]") : result,
      value,
    );
  const statusArtifact = (status, details = {}) => ({
    ...details,
    runId: evidence.runId,
    status,
    ...(status === "NOT_RUN"
      ? {
          reason: sanitize(
            evidence.failure ??
              evidence.limitations[0] ??
              "criterion was not exercised",
          ),
        }
      : {}),
  });
  const provenanceEnd = await sourceIdentity(root);
  const provenanceStart = evidence.provenanceStart;
  const sourceHashStable =
    provenanceStart?.identityHash !== null &&
    provenanceStart?.identityHash === provenanceEnd.identityHash;
  if (
    evidence.status === "PASS" &&
    (!sourceHashStable || provenanceStart?.sourceFiles?.status !== "PASS")
  ) {
    evidence.status = "FAIL";
    evidence.failure =
      "tested source or compiled runtime digest was unavailable or changed during verification";
  }
  const alertState = evidence.alertTransitions ?? "NOT_RUN";
  const redaction = evidence.redactionScan;
  const outage = evidence.outageRestart;
  const runtimeHealthGates = [
    evidence.runtimeMetricMatrix?.status,
    evidence.runtimeMetricMatrix?.loggingPolicy?.status,
    evidence.runtimeShutdownStatus,
    evidence.networkIsolation?.status,
    evidence.networkIsolation?.launchPathNetworkStatus,
    evidence.outage?.status,
    evidence.telemetryHealth?.recoveryStatus,
    evidence.telemetryHealth?.dockerLogRotation?.status,
    evidence.telemetryHealth?.producerLoggingPolicy?.status,
    evidence.telemetryHealth?.collectorLoggingPolicy?.status,
    evidence.telemetryHealth?.launchPathCollectorConfig,
    evidence.telemetryHealth?.launchPathOutageStatus,
    evidence.telemetryHealth?.collectorMemoryProof?.status,
    evidence.collectorQueueMetrics?.status,
    evidence.processCounterRestart?.status,
    diskPressureComplete(evidence) ? "PASS" : "NOT_RUN",
    evidence.nativeNginxAlert?.status,
  ];
  const runtimeHealthStatus =
    runtimeHealthGates.every((status) => status === "PASS") && outage
      ? "PASS"
      : evidence.status === "FAIL"
        ? "FAIL"
        : "NOT_RUN";
  const backendArtifactsComplete =
    alertState === "PASS" &&
    redaction?.status === "PASS" &&
    evidence.launchPathCorrelation === "PASS" &&
    runtimeHealthStatus === "PASS" &&
    outage?.queueDrops > 0 &&
    outage.producerExportFailureObserved === true &&
    outage.collectorExpiredRetryDrop?.status === "PASS" &&
    typeof evidence.retention === "object" &&
    evidence.retention.ttlRemovedRecord &&
    diskPressureComplete(evidence);
  const verificationCoverage = observabilityVerificationCoverage(evidence, {
    config,
    sourceHashStable,
    backendArtifactsComplete,
  });
  if (
    evidence.status === "PASS" &&
    verificationCoverage.fullSystemG14.status !== "PASS"
  ) {
    evidence.status = "FAIL";
    evidence.failure =
      "G14 full-system evidence or qualification admission incomplete";
  }
  const documents = {
    "alert-transitions.json": statusArtifact(alertState, {
      alerts: evidence.alerts,
      inputMetrics: evidence.alertInputs ?? {},
      syntheticNodeNotReady: evidence.syntheticNodeNotReady ?? {
        status: "NOT_RUN",
      },
      nativeNginxAvailability: evidence.nativeNginxAlert ?? {
        status: "NOT_RUN",
      },
    }),
    "correlation-proof.json": statusArtifact(
      evidence.launchPathCorrelation ?? "NOT_RUN",
      {
        syntheticTraceCorrelation:
          evidence.phases?.signals === "PASS" && evidence.signalProof?.traceId
            ? "PASS"
            : "NOT_RUN",
        syntheticSignals: evidence.signals ?? [],
        launchPath: evidence.launchPathProof ?? {},
      },
    ),
    "redaction-scan.json": statusArtifact(
      redaction?.status ?? "NOT_RUN",
      redaction ?? {},
    ),
    "queue-loss-counters.json": statusArtifact(
      outage?.queueDrops > 0 &&
        outage.producerExportFailureObserved === true &&
        outage.collectorExpiredRetryDrop?.status === "PASS" &&
        evidence.collectorQueueMetrics?.status === "PASS" &&
        evidence.processCounterRestart?.status === "PASS" &&
        evidence.telemetryHealth?.collectorMemoryProof?.status === "PASS"
        ? "PASS"
        : "NOT_RUN",
      {
        ...(outage?.queueDrops === undefined
          ? {}
          : {
              droppedRecords: outage.queueDrops,
              producerExportFailureObserved:
                outage.producerExportFailureObserved,
            }),
        collectorExpiredRetryDrop: outage?.collectorExpiredRetryDrop ?? {},
        collector: evidence.collectorQueueMetrics ?? {},
        collectorMemoryProof:
          evidence.telemetryHealth?.collectorMemoryProof ?? {},
        collectorMemoryDiagnostics:
          evidence.telemetryHealth?.collectorMemoryDiagnostics ?? {},
        processCounterRestart: evidence.processCounterRestart ?? {},
      },
    ),
    "retention-result.json": statusArtifact(
      typeof evidence.retention === "object" &&
        evidence.retention.ttlRemovedRecord &&
        diskPressureComplete(evidence)
        ? "PASS"
        : "NOT_RUN",
      {
        ...(typeof evidence.retention === "object" ? evidence.retention : {}),
        diskPressure: evidence.diskPressure ?? {},
      },
    ),
    "runtime-health-matrix.json": statusArtifact(runtimeHealthStatus, {
      ...verificationCoverage,
      ...outage,
      gracefulShutdown: evidence.runtimeShutdown ?? "NOT_RUN",
      telemetryHealth: evidence.telemetryHealth ?? {},
      metricApplicability: evidence.metricApplicability ?? {},
      runtimeMetricMatrix: evidence.runtimeMetricMatrix ?? {
        status: "NOT_RUN",
      },
      processCounterRestart: evidence.processCounterRestart ?? {},
      collectorMemoryProof:
        evidence.telemetryHealth?.collectorMemoryProof ?? {},
      collectorMemoryDiagnostics:
        evidence.telemetryHealth?.collectorMemoryDiagnostics ?? {},
      diskPressure: evidence.diskPressure ?? {},
      nativeNginxAvailability: evidence.nativeNginxAlert ?? {
        status: "NOT_RUN",
      },
      networkIsolation: evidence.networkIsolation ?? "NOT_RUN",
      executionMode: evidence.executionMode,
    }),
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const [name, artifact] of Object.entries(documents))
    await writeFile(join(dir, name), `${JSON.stringify(artifact, null, 2)}\n`, {
      mode: 0o600,
    });
  if (evidence.hostTransport !== undefined)
    await writeFile(
      join(dir, "host-transport.json"),
      `${JSON.stringify(evidence.hostTransport, null, 2)}\n`,
      { mode: 0o600 },
    );
  const result = {
    ...evidence,
    ...verificationCoverage,
    failure:
      evidence.failure === undefined ? undefined : sanitize(evidence.failure),
    provenance: {
      start: provenanceStart ?? null,
      end: provenanceEnd,
      sourceHashStable,
    },
    commands: [{ argv: [process.execPath, ...process.argv.slice(1)] }],
  };
  const resultBytes = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(join(dir, "result.json"), resultBytes, { mode: 0o600 });
  let directory = dir;
  if (launchEvidenceDir) {
    directory = join(
      launchEvidenceDir,
      "gates/G14_OBSERVABILITY/artifacts/observability",
    );
    await mkdir(directory, { mode: 0o700 });
    for (const name of [...Object.keys(documents), "result.json"])
      await writeFile(join(directory, name), await readFile(join(dir, name)), {
        flag: "wx",
        mode: 0o600,
      });
  }
  return {
    directory,
    resultSha256: createHash("sha256").update(resultBytes).digest("hex"),
  };
}

export async function persistVerificationResult({
  root,
  evidence,
  secrets,
  launchEvidenceDir,
  config,
  persist = persistEvidence,
  cleanError = (error) => String(error?.message ?? error),
}) {
  try {
    const persisted = await persist({
      root,
      evidence,
      secrets,
      launchEvidenceDir,
      config,
    });
    evidence.evidenceDirectory = persisted.directory;
    evidence.resultSha256 = persisted.resultSha256;
  } catch (error) {
    evidence.status = "FAIL";
    evidence.failure = `cannot persist evidence: ${cleanError(error)}`;
  }
}

export function observabilityGateComplete(evidence) {
  const phases = [
    "startup",
    "signals",
    "alerts",
    "outage",
    "persistence",
    "backupRestore",
    "runtimeMatrix",
    "memory",
    "retention",
    "launchPath",
    "diskRecovery",
  ];
  const required = [
    evidence.alertTransitions,
    evidence.launchPathCorrelation,
    evidence.nativeNginxAlert?.status,
    evidence.redactionScan?.status,
    evidence.networkIsolation?.status,
    evidence.networkIsolation?.launchPathNetworkStatus,
    evidence.telemetryHealth?.dockerLogRotation?.status,
    evidence.telemetryHealth?.producerLoggingPolicy?.status,
    evidence.telemetryHealth?.collectorLoggingPolicy?.status,
    evidence.telemetryHealth?.launchPathCollectorConfig,
    evidence.telemetryHealth?.launchPathOutageStatus,
    evidence.telemetryHealth?.collectorMemoryProof?.status,
    evidence.collectorQueueMetrics?.status,
    evidence.processCounterRestart?.status,
    evidence.diskPressureStatus,
    evidence.runtimeShutdownStatus,
  ];
  return (
    Array.isArray(evidence.cleanupErrors) &&
    evidence.cleanupErrors.length === 0 &&
    phases.every((phase) => evidence.phases?.[phase] === "PASS") &&
    required.every((status) => status === "PASS") &&
    syntheticNodeNotReadyComplete(evidence.syntheticNodeNotReady) &&
    diskPressureComplete(evidence)
  );
}

export function alertEpisodeStartMs(episodeId) {
  if (typeof episodeId !== "string" || !/^[a-f0-9]{16}:/u.test(episodeId))
    return NaN;
  return Date.parse(episodeId.slice(17));
}

export function syntheticNodeNotReadyComplete(receipt) {
  const start = alertEpisodeStartMs(receipt?.firing?.episodeId);
  return (
    receipt?.status === "PASS" &&
    receipt.service === "g14-synthetic" &&
    /^g14-v[1-9][0-9]*-service-not-ready-synthetic$/u.test(
      receipt.ruleUid ?? "",
    ) &&
    receipt.forMs === 300000 &&
    receipt.threshold === 0 &&
    receipt.nativeProbeAbsent === true &&
    receipt.cleanupVerified === true &&
    receipt.productionRuleUnchanged === true &&
    Number.isFinite(receipt.activationMs) &&
    Number.isFinite(receipt.recoveryMs) &&
    receipt.recoveryMs > receipt.activationMs &&
    receipt.baseline?.value === 1 &&
    Number.isFinite(receipt.baseline.timestampUs) &&
    receipt.baseline.timestampUs < receipt.activationMs * 1000 &&
    receipt.failed?.value === 0 &&
    Number.isFinite(receipt.failed.timestampUs) &&
    receipt.failed.timestampUs > receipt.activationMs * 1000 &&
    receipt.recovered?.value === 1 &&
    Number.isFinite(receipt.recovered.timestampUs) &&
    receipt.recovered.timestampUs > receipt.recoveryMs * 1000 &&
    Number.isFinite(start) &&
    start >= receipt.activationMs + receipt.forMs &&
    Date.parse(receipt.firing.receivedAt) >= start &&
    Date.parse(receipt.firing.receivedAt) < receipt.recoveryMs &&
    receipt.failed.timestampUs <=
      Date.parse(receipt.firing.receivedAt) * 1000 &&
    receipt.resolved?.episodeId === receipt.firing.episodeId &&
    Date.parse(receipt.resolved.receivedAt) >= receipt.recoveryMs
  );
}

export function parseLokiWalMetrics(text) {
  const readMetric = (name) => {
    const values = text.split("\n").flatMap((line) => {
      const match = new RegExp(
        `^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)(?:\\s|$)`,
        "u",
      ).exec(line);
      return match ? [Number(match[1])] : [];
    });
    if (values.length !== 1 || !Number.isFinite(values[0]) || values[0] < 0)
      throw new Error(`Loki native ${name} unavailable or ambiguous`);
    return values[0];
  };
  const failures = readMetric("loki_ingester_wal_disk_full_failures_total");
  const usageRatio = readMetric("loki_ingester_wal_disk_usage_percent");
  if (usageRatio > 1)
    throw new Error("Loki native WAL disk usage ratio is invalid");
  return { failures, usageRatio };
}

export function parsePrometheusWalFailures(text) {
  const values = text.split("\n").flatMap((line) => {
    const match =
      /^prometheus_tsdb_wal_writes_failed_total(?:\{[^}]*\})?\s+([0-9.eE+-]+)(?:\s|$)/u.exec(
        line,
      );
    return match ? [Number(match[1])] : [];
  });
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] < 0)
    throw new Error(
      "Prometheus native WAL failure counter unavailable or ambiguous",
    );
  return values[0];
}

export function durationMilliseconds(value) {
  if (typeof value !== "string" || !value) return NaN;
  let offset = 0,
    total = 0;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/gu)) {
    if (match.index !== offset) return NaN;
    total += Number(match[1]) * units[match[2]];
    offset += match[0].length;
  }
  return offset === value.length && Number.isSafeInteger(total) ? total : NaN;
}

export async function verifySyntheticAlertTransitions({
  config,
  definitions,
  provisioning,
  baseUrls,
  authorization,
  folderUid,
  producerUrl,
  runId,
  alertPath,
  signal,
  onActivated,
}) {
  let syntheticCleanupVerified = true;
  const syntheticWait = (predicate, options) =>
    waitFor(async () => {
      if (signal?.aborted)
        throw Object.assign(new Error("synthetic alert worker interrupted"), {
          fatal: true,
        });
      return predicate();
    }, options);
  const nonDisk = definitions.filter(
    (rule) => rule.key !== "diskWatermark" && rule.key !== "notReady",
  );
  const syntheticRule = createAlertDefinitions({
    config,
    readinessServices: ["g14-synthetic"],
  }).find((rule) => rule.key === "notReady");
  const productionRule = definitions.find((rule) => rule.key === "notReady");
  const syntheticGroup = "g14-synthetic";
  const groupPath = `/api/v1/provisioning/folder/${encodeURIComponent(folderUid)}/rule-groups/${syntheticGroup}`;
  const syntheticPath = `/api/v1/provisioning/alert-rules/${encodeURIComponent(syntheticRule.name)}`;
  const productionPath = `/api/v1/provisioning/alert-rules/${encodeURIComponent(productionRule.name)}`;
  const productionBefore = await api({
    baseUrl: baseUrls.grafana,
    authorization,
    path: productionPath,
  });
  const readSynthetic = async (afterUs) =>
    (
      await readinessMetricSamples({
        baseUrl: baseUrls.prometheus,
        services: ["g14-synthetic"],
        afterUs,
      })
    )[0].sample;
  const query = async (expression) => {
    const params = new URLSearchParams({ query: expression });
    const response = await api({
      baseUrl: baseUrls.prometheus,
      path: `/api/v1/query?${params}`,
    });
    if (
      response?.status !== "success" ||
      response.data?.resultType !== "vector" ||
      !Array.isArray(response.data?.result)
    )
      throw new Error("synthetic readiness query returned invalid data");
    return response.data.result;
  };
  await fixtureRequest({
    baseUrl: producerUrl,
    path: "/test/state",
    body: { active: false },
    runId,
  });
  await fixtureRequest({ baseUrl: producerUrl, runId });
  const baselineStartUs = Date.now() * 1000;
  const baseline = await syntheticWait(
    async () => {
      const sample = await readSynthetic(baselineStartUs);
      const native = await query(
        'probe_success{service_name="otel-collector",probe_owner="edge-nginx"}',
      );
      const value = await query(syntheticRule.query);
      return sample?.value === 1 &&
        native.length === 0 &&
        value.length === 1 &&
        value[0]?.value?.[1] === "1"
        ? sample
        : false;
    },
    {
      timeoutMs: 120000,
      intervalMs: 2000,
      description: "fresh synthetic readiness baseline without native probe",
    },
  );
  await api({
    baseUrl: baseUrls.grafana,
    authorization,
    path: groupPath,
    expected: [404],
  });
  await api({
    baseUrl: baseUrls.grafana,
    authorization,
    path: syntheticPath,
    expected: [404],
  });
  const template = structuredClone(
    provisioning.alerts.groups[0].rules.find(
      (rule) => rule.uid === productionRule.name,
    ),
  );
  template.uid = syntheticRule.name;
  template.title = syntheticRule.name;
  template.data.find((item) => item.refId === "A").model.expr =
    syntheticRule.query;
  let syntheticReceipt;
  const firing = new Map();
  try {
    syntheticCleanupVerified = false;
    await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: groupPath,
      method: "PUT",
      body: {
        folderUid,
        title: syntheticGroup,
        interval: config.telemetry.alerts.evaluationIntervalMs / 1000,
        rules: [
          {
            ...template,
            orgID: 1,
            folderUID: folderUid,
            ruleGroup: syntheticGroup,
          },
        ],
      },
    });
    const installedGroup = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: groupPath,
    });
    const installed = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: syntheticPath,
    });
    if (
      installedGroup?.interval !==
        config.telemetry.alerts.evaluationIntervalMs / 1000 ||
      installed?.uid !== syntheticRule.name ||
      installed?.title !== syntheticRule.name ||
      installed?.for !== productionBefore.for ||
      installed?.data?.find((item) => item.refId === "A")?.model?.expr !==
        syntheticRule.query ||
      installed?.data?.find((item) => item.refId === "B")?.model?.expression !==
        `$A ${syntheticRule.operator} ${syntheticRule.threshold}`
    )
      throw new Error(
        "synthetic Grafana readiness rule differs from configured policy",
      );
    const alertRules = [...nonDisk, syntheticRule];
    await syntheticWait(
      async () => {
        const events = (await readSinkEvents(alertPath)).filter((item) =>
          alertRules.some((rule) => rule.name === item.name),
        );
        return events.every(
          (item) =>
            item.status !== "firing" ||
            events.some(
              (later) =>
                later.status === "resolved" &&
                later.episodeId === item.episodeId,
            ),
        );
      },
      {
        timeoutMs: 420000,
        intervalMs: 5000,
        description: "alert episodes resolved before controlled activation",
      },
    );
    const activationMs = Date.now();
    await fixtureRequest({
      baseUrl: producerUrl,
      path: "/test/state",
      body: { active: true },
      runId,
    });
    await fixtureRequest({ baseUrl: producerUrl, runId });
    const failed = await syntheticWait(
      async () => {
        const sample = await readSynthetic(activationMs * 1000);
        return sample?.value === 0 ? sample : false;
      },
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "fresh synthetic readiness 1 to 0",
      },
    );
    await onActivated({ activationMs, baseline, failed });
    const maxForMs = Math.max(...alertRules.map((rule) => rule.forMs));
    await syntheticWait(
      async () => {
        const events = await readSinkEvents(alertPath);
        for (const rule of alertRules) {
          const event = events.find(
            (item) =>
              item.name === rule.name &&
              item.status === "firing" &&
              alertEpisodeStartMs(item.episodeId) >=
                activationMs + rule.forMs &&
              Date.parse(item.receivedAt) >=
                alertEpisodeStartMs(item.episodeId),
          );
          if (event) firing.set(rule.name, event.episodeId);
        }
        const sample = await readSynthetic((Date.now() - 30000) * 1000);
        const native = await query(
          'probe_success{service_name="otel-collector",probe_owner="edge-nginx"}',
        );
        const value = await query(syntheticRule.query);
        return (
          firing.size === alertRules.length &&
          sample?.value === 0 &&
          native.length === 0 &&
          value.length === 1 &&
          value[0]?.value?.[1] === "0"
        );
      },
      {
        timeoutMs:
          maxForMs + 5 * config.telemetry.alerts.evaluationIntervalMs + 130000,
        intervalMs: 5000,
        description: "synthetic Grafana alert firing episodes",
      },
    );
    const recoveryMs = Date.now();
    await fixtureRequest({
      baseUrl: producerUrl,
      path: "/test/state",
      body: { active: false },
      runId,
    });
    await fixtureRequest({ baseUrl: producerUrl, runId });
    const recovered = await syntheticWait(
      async () => {
        const sample = await readSynthetic(recoveryMs * 1000);
        const native = await query(
          'probe_success{service_name="otel-collector",probe_owner="edge-nginx"}',
        );
        const value = await query(syntheticRule.query);
        return sample?.value === 1 &&
          native.length === 0 &&
          value.length === 1 &&
          value[0]?.value?.[1] === "1"
          ? sample
          : false;
      },
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "fresh synthetic readiness 0 to 1",
      },
    );
    const resolved = await syntheticWait(
      async () => {
        const events = await readSinkEvents(alertPath);
        return alertRules.every((rule) =>
          events.some(
            (item) =>
              item.name === rule.name &&
              item.status === "resolved" &&
              item.episodeId === firing.get(rule.name) &&
              Date.parse(item.receivedAt) >= recoveryMs,
          ),
        )
          ? events.find(
              (item) =>
                item.name === syntheticRule.name &&
                item.status === "resolved" &&
                item.episodeId === firing.get(syntheticRule.name) &&
                Date.parse(item.receivedAt) >= recoveryMs,
            )
          : false;
      },
      {
        timeoutMs:
          maxForMs + 5 * config.telemetry.alerts.evaluationIntervalMs + 130000,
        intervalMs: 5000,
        description: "synthetic Grafana alert resolved episodes",
      },
    );
    const syntheticFiring = (await readSinkEvents(alertPath)).find(
      (item) =>
        item.name === syntheticRule.name &&
        item.status === "firing" &&
        item.episodeId === firing.get(syntheticRule.name),
    );
    syntheticReceipt = {
      status: "PASS",
      service: "g14-synthetic",
      ruleUid: syntheticRule.name,
      forMs: syntheticRule.forMs,
      threshold: syntheticRule.threshold,
      nativeProbeAbsent: true,
      activationMs,
      recoveryMs,
      baseline,
      failed,
      recovered,
      firing: {
        episodeId: syntheticFiring.episodeId,
        receivedAt: syntheticFiring.receivedAt,
      },
      resolved: {
        episodeId: resolved.episodeId,
        receivedAt: resolved.receivedAt,
      },
    };
  } finally {
    let syntheticResetVerified = false;
    try {
      await fixtureRequest({
        baseUrl: producerUrl,
        path: "/test/state",
        body: { active: false },
        runId,
      });
      syntheticResetVerified = true;
    } finally {
      await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: groupPath,
        method: "DELETE",
        expected: [204, 404],
      });
      await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: groupPath,
        expected: [404],
      });
      await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: syntheticPath,
        expected: [404],
      });
      const productionAfter = await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: productionPath,
      });
      syntheticCleanupVerified =
        syntheticResetVerified &&
        productionAfter?.uid === productionBefore.uid &&
        productionAfter?.title === productionBefore.title &&
        productionAfter?.for === productionBefore.for &&
        productionAfter?.condition === productionBefore.condition &&
        productionAfter?.noDataState === productionBefore.noDataState &&
        productionAfter?.execErrState === productionBefore.execErrState &&
        isDeepStrictEqual(productionAfter?.data, productionBefore.data) &&
        productionAfter?.data?.find((item) => item.refId === "A")?.model
          ?.expr === productionRule.query;
    }
  }
  if (!syntheticCleanupVerified)
    throw new Error("synthetic readiness alert cleanup was not verified");
  const syntheticNodeNotReady = {
    ...syntheticReceipt,
    cleanupVerified: true,
    productionRuleUnchanged: true,
  };
  if (!syntheticNodeNotReadyComplete(syntheticNodeNotReady))
    throw new Error("synthetic Node readiness alert evidence invalid");
  return {
    syntheticNodeNotReady,
    alerts: nonDisk.map((rule) => ({
      key: rule.key,
      name: rule.name,
      episodeId: firing.get(rule.name),
      forMs: rule.forMs,
      firing: true,
      resolved: true,
    })),
  };
}

export async function startSyntheticAlertWorker({
  root,
  config,
  definitions,
  provisioning,
  baseUrls,
  authorization,
  folderUid,
  producerUrl,
  runId,
  alertPath,
  runChild,
}) {
  const runManagedRollbackChild =
    runChild ??
    (await import("../../verification/launch/v1/scenarios/rollback.mjs"))
      .runManagedRollbackChild;
  let resolveSyntheticActivation;
  const syntheticActivation = new Promise((resolve) => {
    resolveSyntheticActivation = resolve;
  });
  let syntheticStage = "init";
  let syntheticReceipt;
  const syntheticScript = `import {verifySyntheticAlertTransitions} from './tools/observability/verify.mjs';
const abort = new AbortController();
process.once('disconnect', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
const request=(stage,payload)=>new Promise((resolve,reject)=>{
 const disconnected=()=>{process.removeListener('message',received);reject(new Error('ALERT_WORKER_DISCONNECTED'));};
 const received=(message,handle)=>{if(!handle&&message?.stage!==stage)return;process.removeListener('message',received);process.removeListener('disconnect',disconnected);if(handle||!message||message.ok!==true)reject(new Error('ALERT_WORKER_REJECTED'));else resolve(message.payload);};
 process.once('disconnect',disconnected);process.on('message',received);
 process.send({stage,payload},error=>{if(error){process.removeListener('message',received);process.removeListener('disconnect',disconnected);reject(new Error('ALERT_WORKER_SEND_FAILED'));}});
});
try {
 const input=await request('init',null);
 const result=await verifySyntheticAlertTransitions({...input,signal:abort.signal,onActivated:async value=>{await request('activated',value);process.send({stage:'running',payload:null});}});
 await request('cleanup',result);
 if(process.connected)process.disconnect();
} catch(error) { if(process.connected)process.disconnect(); throw error; }`;
  const syntheticWorker = runManagedRollbackChild({
    args: ["--input-type=module", "--eval", syntheticScript],
    cwd: root,
    env: process.env,
    onIpc: async (message) => {
      if (
        Object.keys(message).sort().join(",") !== "payload,stage" ||
        message.stage !== syntheticStage
      )
        throw new Error("synthetic alert worker stage invalid");
      if (syntheticStage === "init") {
        if (message.payload !== null)
          throw new Error("synthetic alert worker init invalid");
        syntheticStage = "activated";
        return {
          config,
          definitions,
          provisioning,
          baseUrls,
          authorization,
          folderUid,
          producerUrl,
          runId,
          alertPath,
        };
      }
      if (syntheticStage === "activated") {
        const { activationMs, baseline, failed } = message.payload ?? {};
        if (
          !Number.isFinite(activationMs) ||
          baseline?.value !== 1 ||
          failed?.value !== 0 ||
          failed.timestampUs <= activationMs * 1000
        )
          throw new Error("synthetic alert activation invalid");
        syntheticStage = "running";
        return null;
      }
      if (syntheticStage === "running") {
        if (message.payload !== null)
          throw new Error("synthetic alert worker running invalid");
        syntheticStage = "cleanup";
        resolveSyntheticActivation();
        return null;
      }
      const expectedAlerts = definitions.filter(
        (rule) => rule.key !== "diskWatermark" && rule.key !== "notReady",
      );
      if (
        !syntheticNodeNotReadyComplete(
          message.payload?.syntheticNodeNotReady,
        ) ||
        !Array.isArray(message.payload?.alerts) ||
        message.payload.alerts.length !== expectedAlerts.length ||
        expectedAlerts.some(
          (rule) =>
            !message.payload.alerts.some(
              (alert) =>
                alert.key === rule.key &&
                alert.name === rule.name &&
                alert.forMs === rule.forMs &&
                typeof alert.episodeId === "string" &&
                alert.firing === true &&
                alert.resolved === true,
            ),
        )
      )
        throw new Error("synthetic alert completion invalid");
      syntheticReceipt = message.payload;
      syntheticStage = "done";
      return null;
    },
  }).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await Promise.race([
    syntheticActivation,
    syntheticWorker.then(({ error }) => {
      throw (
        error ?? new Error("synthetic alert worker ended before activation")
      );
    }),
  ]);

  return {
    wait: async () => {
      const { error } = await syntheticWorker;
      if (error || syntheticStage !== "done" || !syntheticReceipt)
        throw error ?? new Error("synthetic alert cleanup was not verified");
      return syntheticReceipt;
    },
  };
}

export async function runObservabilityVerification({
  root = REPO_ROOT,
  run = docker,
  probePath = "/usr/bin/busybox",
} = {}) {
  if (resolve(root) !== REPO_ROOT)
    throw new Error(
      "G14 launch context candidate root differs from verifier root",
    );
  const runId = newRunId();
  const project = `coffee-observability-${runId}`;
  const provenanceStart = await sourceIdentity(root);
  const workDir = await mkdtemp(`/dev/shm/${project}-`);
  const backendNetwork = `${project}-backend`;
  const producerNetwork = `${project}-producer`;
  const producerName = `${project}-synthetic-runtime`;
  const composeFile = join(workDir, "compose.yaml");
  const alertDir = join(workDir, "alert-evidence");
  const alertPath = join(alertDir, "episodes.jsonl");
  const secretPath = join(workDir, "grafana-admin");
  const collectorConfigPath = join(workDir, "collector.alloy");
  const storage = {};
  const restoreStorage = {};
  let backupDir, storageRoot;
  const storageDirectories = [];
  const cleanupErrors = [];
  const secrets = [];
  const evidence = {
    runId,
    status: "FAIL",
    startedAt: new Date().toISOString(),
    provenanceStart,
    alerts: [],
    signals: [],
    limitations: [],
    phases: {
      startup: "NOT_RUN",
      signals: "NOT_RUN",
      alerts: "NOT_RUN",
      outage: "NOT_RUN",
      persistence: "NOT_RUN",
      backupRestore: "NOT_RUN",
      runtimeMatrix: "NOT_RUN",
      memory: "NOT_RUN",
      retention: "NOT_RUN",
      launchPath: "NOT_RUN",
      diskRecovery: "NOT_RUN",
    },
  };
  let config,
    toolchain,
    storageHelper,
    verifiedGrafana,
    launchEvidenceDir,
    formalContext,
    activePhase = "startup",
    producerCreated = false,
    producerNetworkCreated = false,
    composeStarted = false;
  let diskPressureIdentity;
  const compose = (args) =>
    run(["compose", "--project-name", project, "--file", composeFile, ...args]);
  const timeoutForHealth = () =>
    Math.max(60000, config.platform.health.startupGraceMs + 30000);
  const cleanError = (error) =>
    secrets.reduce(
      (value, secret) =>
        secret ? value.replaceAll(secret, "[REDACTED]") : value,
      String(error?.message ?? error),
    );
  const startPhase = (name) => {
    activePhase = name;
    evidence.phases[name] = "RUNNING";
    process.stderr.write(
      `${JSON.stringify({ phase: name, startedAtUtc: new Date().toISOString() })}\n`,
    );
  };
  try {
    config = await loadPlatformConfig(root);
    const validatedLaunch = await validateLaunchContext(
      process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    );
    if (validatedLaunch.candidateRoot !== REPO_ROOT)
      throw new Error(
        "G14 launch context candidate root differs from verifier root",
      );
    if (config.verification.databaseIsolation.enabled)
      launchEvidenceDir = validatedLaunch.evidenceDir;
    formalContext = validatedLaunch.context;
    toolchain = JSON.parse(
      await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
    );
    for (const key of [
      "otelCollectorImage",
      "grafanaImage",
      "lokiImage",
      "prometheusImage",
      "tempoImage",
      "nodeImage",
    ])
      if (!/@sha256:[a-f0-9]{64}$/u.test(toolchain[key] ?? ""))
        throw new Error(`${key} must be an immutable BOM image ref`);
    const probe = await verifyBootstrapProbe({
      probePath,
      expectedSha256: toolchain.bootstrapProbeSha256,
    });
    evidence.bootstrapProbe = probe;
    storageHelper = await loadVerifiedGateImage({
      target: "storage-helper",
      contextFile: process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    });
    evidence.storageHelper = {
      imageId: storageHelper.imageId,
      receiptSha256: storageHelper.receiptSha256,
      candidateSha: storageHelper.candidateSha,
    };
    verifiedGrafana = await loadVerifiedGateImage({
      target: "grafana",
      contextFile: process.env.COFFEE_LAUNCH_CONTEXT_FILE,
    });
    evidence.grafanaImage = {
      imageId: verifiedGrafana.imageId,
      receiptSha256: verifiedGrafana.receiptSha256,
      candidateSha: verifiedGrafana.candidateSha,
      runId: verifiedGrafana.runId,
    };
    const producerToken = randomBytes(32).toString("base64url");
    const adminPassword = randomBytes(32).toString("base64url");
    const redactionCanary = `g14-secret-${randomBytes(24).toString("hex")}`;
    secrets.push(producerToken, adminPassword, redactionCanary);
    await ensurePrivateSecretDirectory(workDir);
    await ensurePrivateSecretDirectory(alertDir);
    await writePrivateSecret(secretPath, `${adminPassword}\n`);
    const fixtureConfig = structuredClone(config);
    fixtureConfig.telemetry.environment = fixtureConfig.environment;
    const fixturePath = join(workDir, "fixture.json");
    await writePrivateSecret(
      fixturePath,
      `${JSON.stringify({ config: fixtureConfig, runId, exporterToken: producerToken, redactionCanary })}\n`,
    );
    storageRoot = await mkdtemp(join(tmpdir(), `${project}-storage-`));
    for (const name of ["grafana", "loki", "prometheus", "tempo"]) {
      const volumeName = `${project}-${name}-data`;
      const backingDirectory = join(storageRoot, volumeName);
      await mkdir(backingDirectory, { mode: 0o700 });
      storageDirectories.push(backingDirectory);
      storage[name] = provisionStorage({
        name: volumeName,
        maxDiskBytes: config.telemetry[name].maxDiskBytes,
        storageHelperImage: storageHelper.imageId,
        backingDirectory,
        run,
      });
    }
    const storageVolumes = Object.fromEntries(
      Object.entries(storage).map(([name, value]) => [name, value.volumeName]),
    );
    ensureBackendOwnership({
      storageVolumes,
      grafanaAdminSecretPath: secretPath,
      nodeImage: toolchain.nodeImage,
      runDocker: run,
    });
    run([
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--opt",
      "com.docker.network.bridge.enable_ip_masquerade=false",
      "--label",
      "coffee.owner=operations",
      "--label",
      `coffee.g14.run-id=${runId}`,
      producerNetwork,
    ]);
    producerNetworkCreated = true;
    const logging = createRuntimeLoggingOverride({ config }).services[
      "edge-gateway"
    ].logging;
    run([
      "run",
      "-d",
      "--name",
      producerName,
      "--network",
      producerNetwork,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=8m",
      "--cpus",
      "0.5",
      "--memory",
      "256m",
      "--pids-limit",
      "32",
      "--security-opt",
      "no-new-privileges:true",
      "--cap-drop",
      "ALL",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--log-driver",
      logging.driver,
      ...Object.entries(logging.options).flatMap(([name, value]) => [
        "--log-opt",
        `${name}=${value}`,
      ]),
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.service=edge-gateway",
      "--mount",
      `type=bind,source=${join(root, "node_modules")},target=/repo/node_modules,readonly`,
      "--mount",
      `type=bind,source=${join(root, "packages")},target=/repo/packages,readonly`,
      "--mount",
      `type=bind,source=${join(root, "tests/observability/fixture.mjs")},target=/fixture.mjs,readonly`,
      "--mount",
      `type=bind,source=${fixturePath},target=/fixture-config.json,readonly`,
      "--entrypoint",
      "node",
      toolchain.nodeImage,
      "/fixture.mjs",
      "/fixture-config.json",
    ]);
    producerCreated = true;
    const logFiles = await discoverContainerLogs({
      projectName: project,
      runtimes: ["edge-gateway"],
      runDocker: run,
    });
    const collector = createAlloyConfig({
      config,
      logFiles,
      exporterToken: producerToken,
    });
    await writePrivateSecret(collectorConfigPath, collector);
    ensureCollectorConfigOwnership({
      collectorConfigPath,
      nodeImage: toolchain.nodeImage,
      runDocker: run,
    });
    const provisioning = createGrafanaAlertProvisioning(config, {
      notificationUrl: config.telemetry.alerts.notificationEndpoint,
    });
    const definitions = createAlertDefinitions({ config });
    const configs = { ...createBackendConfigs(config), ...provisioning };
    const backendConfigPaths = {};
    for (const [name, value] of Object.entries(configs)) {
      const path = join(workDir, `${name}.yaml`);
      await writeFile(path, dumpYaml(value, { noRefs: true, lineWidth: 120 }), {
        mode: 0o444,
      });
      backendConfigPaths[name] = path;
    }
    const generated = createComposeOverride({
      config,
      imageRefs: toolchain,
      grafanaImage: verifiedGrafana.imageId,
      alertSinkImage: storageHelper.imageId,
      logFiles,
      collectorConfigPath,
      probePath,
      storageVolumes,
      backendConfigPaths,
      grafanaAdminSecretPath: secretPath,
      alertEvidenceDir: alertDir,
      observabilityNetworkName: backendNetwork,
    });
    const services = Object.fromEntries(
      [
        "grafana",
        "loki",
        "prometheus",
        "tempo",
        "otel-collector",
        "alert-sink",
      ].map((name) => [name, generated.services[name]]),
    );
    services["otel-collector"].networks = ["backend", "producer"];
    for (const name of ["grafana", "loki", "prometheus", "tempo", "alert-sink"])
      services[name].networks = ["backend"];
    const fixtureCompose = {
      services,
      networks: {
        backend: { name: backendNetwork, internal: true },
        producer: { name: producerNetwork, external: true },
      },
      volumes: generated.volumes,
    };
    await writeFile(
      composeFile,
      dumpYaml(fixtureCompose, { noRefs: true, lineWidth: 120 }),
      { mode: 0o600 },
    );
    composeStarted = true;
    compose([
      "up",
      "-d",
      "grafana",
      "loki",
      "prometheus",
      "tempo",
      "alert-sink",
      "otel-collector",
    ]);
    const containerIds = {};
    const baseUrls = {};
    let grafanaGeneration;
    for (const name of [
      "grafana",
      "loki",
      "prometheus",
      "tempo",
      "otel-collector",
    ]) {
      const id = compose(["ps", "--quiet", name]).trim();
      if (!/^[a-f0-9]{12,64}$/u.test(id))
        throw new Error(`${name} container identity unavailable`);
      containerIds[name] = id;
      const info = JSON.parse(run(["inspect", id]))[0];
      if (name === "grafana") {
        assertGrafanaGeneration(info, info);
        grafanaGeneration = info;
      }
      const expectedNetworks = (
        name === "otel-collector"
          ? [backendNetwork, producerNetwork]
          : [backendNetwork]
      ).sort();
      const actualNetworks = Object.keys(
        info?.NetworkSettings?.Networks ?? {},
      ).sort();
      if (
        info?.State?.Running !== true ||
        Object.values(info.HostConfig?.PortBindings ?? {}).flat().length !==
          0 ||
        JSON.stringify(actualNetworks) !== JSON.stringify(expectedNetworks) ||
        !info.NetworkSettings?.Networks?.[backendNetwork]?.IPAddress
      )
        throw new Error(`${name} container isolation invalid`);
      const endpoint =
        name === "otel-collector"
          ? config.telemetry.collector.healthEndpoint
          : config.telemetry[name].endpoint;
      baseUrls[name] =
        `http://${info.NetworkSettings.Networks[backendNetwork].IPAddress}:${new URL(endpoint).port}`;
    }
    const producerInfo = JSON.parse(run(["inspect", producerName]))[0];
    if (
      JSON.stringify(
        Object.keys(producerInfo?.NetworkSettings?.Networks ?? {}),
      ) !== JSON.stringify([producerNetwork]) ||
      Object.values(producerInfo?.HostConfig?.PortBindings ?? {}).flat()
        .length !== 0
    )
      throw new Error("producer container isolation invalid");
    const producerIp =
      producerInfo.NetworkSettings.Networks[producerNetwork].IPAddress;
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(producerIp))
      throw new Error("fixture producer address unavailable");
    evidence.telemetryHealth ??= {};
    const collectorInfo = JSON.parse(
      run(["inspect", containerIds["otel-collector"]]),
    )[0];
    evidence.telemetryHealth.collectorLoggingPolicy = assertDockerLoggingPolicy(
      collectorInfo.HostConfig.LogConfig,
      logging,
    );
    const producerUrl = `http://${producerIp}:4310`;
    const blockedTargets = ["grafana", "loki", "prometheus", "tempo"].flatMap(
      (name) => [config.telemetry[name].endpoint, baseUrls[name]],
    );
    const isolation = JSON.parse(
      run([
        "exec",
        producerName,
        "node",
        "-e",
        "Promise.all(process.argv.slice(1).map(async u=>{try{await fetch(u,{signal:AbortSignal.timeout(1500)});return false}catch{return true}})).then(x=>process.stdout.write(JSON.stringify(x)))",
        ...blockedTargets,
      ]),
    );
    if (
      !Array.isArray(isolation) ||
      isolation.length !== blockedTargets.length ||
      isolation.some((blocked) => blocked !== true)
    )
      throw new Error("synthetic producer can access a private backend");
    const sinkId = compose(["ps", "--quiet", "alert-sink"]).trim();
    const sinkInfo = JSON.parse(run(["inspect", sinkId]))[0];
    if (
      JSON.stringify(Object.keys(sinkInfo?.NetworkSettings?.Networks ?? {})) !==
        JSON.stringify([backendNetwork]) ||
      Object.values(sinkInfo?.HostConfig?.PortBindings ?? {}).flat().length !==
        0
    )
      throw new Error("alert sink isolation invalid");
    evidence.networkIsolation = {
      status: "PASS",
      backendDnsAndIpsBlockedFromProducer: true,
      hostBindingsAbsent: true,
    };
    const healthPaths = {
      grafana: "/api/health",
      loki: "/ready",
      prometheus: "/-/ready",
      tempo: "/ready",
      "otel-collector": "/-/ready",
    };
    const waitHealth = async (name, timeoutMs = timeoutForHealth()) =>
      waitFor(
        async () => {
          requireRunning({ run, name: containerIds[name], secrets });
          if (name === "otel-collector") {
            const port = new URL(config.telemetry.collector.healthEndpoint)
              .port;
            run([
              "exec",
              containerIds[name],
              "/busybox",
              "wget",
              "-q",
              "-O",
              "/dev/null",
              "-T",
              String(
                Math.max(1, Math.ceil(config.platform.health.timeoutMs / 1000)),
              ),
              `http://127.0.0.1:${port}/-/ready`,
            ]);
            return true;
          }
          const response = await fetch(
            new URL(healthPaths[name], baseUrls[name]),
            { signal: AbortSignal.timeout(config.platform.health.timeoutMs) },
          );
          return response.ok;
        },
        { timeoutMs, intervalMs: 1000, description: `${name} private health` },
      );
    for (const name of Object.keys(healthPaths))
      await waitHealth(name, name === "grafana" ? 180000 : undefined);
    await waitFor(
      async () => {
        requireRunning({ run, name: producerName, secrets });
        return (
          await fetch(new URL(config.platform.health.readyPath, producerUrl), {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      },
      {
        timeoutMs: 30000,
        intervalMs: 500,
        description: "synthetic producer readiness",
      },
    );
    const authorization = basicAuthorization("admin", adminPassword);
    const anonymous = await fetch(
      new URL("/api/datasources", baseUrls.grafana),
      { signal: AbortSignal.timeout(5000) },
    );
    if (anonymous.status !== 401 && anonymous.status !== 403)
      throw new Error("Grafana accepted anonymous datasource access");
    const datasource = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: "/api/datasources",
    });
    if (
      !Array.isArray(datasource) ||
      ["loki", "prometheus", "tempo"].some(
        (uid) => !datasource.some((item) => item.uid === uid),
      )
    )
      throw new Error("Grafana datasource provisioning incomplete");
    for (const rule of definitions) {
      const actual = await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.name)}`,
      });
      const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/u.exec(
        actual?.for ?? "",
      );
      const forMs =
        duration && duration[0]
          ? (Number(duration[1] ?? 0) * 3600 +
              Number(duration[2] ?? 0) * 60 +
              Number(duration[3] ?? 0)) *
            1000
          : NaN;
      if (
        actual?.uid !== rule.name ||
        actual?.title !== rule.name ||
        forMs !== rule.forMs ||
        actual?.data?.find((item) => item.refId === "A")?.model?.expr !==
          rule.query
      )
        throw new Error(
          `Grafana provisioned rule ${rule.name} differs from configured query or hold window`,
        );
    }
    const folderUid = `g14${runId.replaceAll("-", "").slice(0, 20)}`;
    const folder = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: "/api/folders",
      method: "POST",
      body: { uid: folderUid, title: `G14 ${runId}` },
      expected: [200, 201],
    });
    if (folder?.uid !== folderUid)
      throw new Error("Grafana fixture folder identity mismatch");
    evidence.phases.startup = "PASS";
    evidence.startup = {
      status: "PASS",
      containerIds,
      storageVolumes,
      logContainerId: logFiles[0].containerId,
      privateBackendNetwork: backendNetwork,
      noHostBindings: true,
      grafanaDatasourceUids: ["loki", "prometheus", "tempo"],
    };

    startPhase("signals");
    const startTimeUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId });
    const traceId = runId.replaceAll("-", "");
    const readLogs = () =>
      queryLokiLogs({ baseUrl: baseUrls.loki, runId, startTimeUs });
    const logs = await waitFor(
      async () => {
        const found = await readLogs();
        return found.some(
          (record) =>
            hasExactValue(record, runId) &&
            !hasExactValue(record, redactionCanary),
        )
          ? found
          : false;
      },
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "exact synthetic run-id in Loki",
      },
    );
    if (
      logs.some(
        (record) =>
          hasExactValue(record, redactionCanary) ||
          containsSensitiveField(record),
      )
    )
      throw new Error("Loki redaction failed");
    const producerRedaction = inspectProducerRedaction({
      name: producerName,
      runId,
      redactionCanary,
      maxRecordBytes: config.telemetry.producer.maxRecordBytes,
    });
    if (
      !producerRedaction.matchingRunId ||
      !producerRedaction.redactedToken ||
      producerRedaction.canaryLeaked
    )
      throw new Error("synthetic producer log redaction failed");
    const trace = await waitForSameTraceSpans({
      baseUrl: baseUrls.tempo,
      traceId,
      expectedSpanNames: { "g14-synthetic": ["HTTP POST"] },
      timeoutMs: 120000,
    });
    const metric = await waitFor(
      async () => {
        const records = await queryPrometheusRange({
          baseUrl: baseUrls.prometheus,
          expression: 'runtime_ready{service_name="g14-synthetic"}',
          startTimeUs,
        });
        return (
          records.find(
            (record) =>
              record.service_name === "g14-synthetic" &&
              record._timestamp > startTimeUs,
          ) ?? false
        );
      },
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "fresh synthetic runtime metric in Prometheus",
      },
    );
    evidence.signals = [
      "Loki exact run-id log",
      "Tempo exact trace",
      "Prometheus fresh runtime_ready",
    ];
    evidence.redactionScan = {
      status: "PASS",
      canaryAbsent: true,
      sensitiveFieldsAbsent: true,
      producer: producerRedaction,
    };
    evidence.signalProof = {
      traceId,
      traceInventory: trace.spanInventory,
      metricTimestampUs: metric._timestamp,
      metricValue: metric.value,
      logCount: logs.length,
      runId,
    };
    const rotationRecords = Math.ceil(
      ((config.telemetry.logging.maxSizeMiB *
        config.telemetry.logging.maxFiles +
        config.telemetry.logging.maxSizeMiB / 2) *
        1024 *
        1024) /
        12000,
    );
    const rotation = await fixtureRequest({
      baseUrl: producerUrl,
      path: "/test/log-burst",
      body: { count: rotationRecords },
      runId,
    });
    if (rotation.accepted !== rotationRecords || rotation.producerDropped !== 0)
      throw new Error("fixture logging rotation burst was incomplete");
    evidence.telemetryHealth ??= {};
    evidence.telemetryHealth.dockerLogRotation = verifyDockerLogRotation({
      run,
      nodeImage: toolchain.nodeImage,
      logFile: logFiles[0],
      maxFiles: config.telemetry.logging.maxFiles,
      maxSizeMiB: config.telemetry.logging.maxSizeMiB,
      maxRecordBytes: config.telemetry.producer.maxRecordBytes,
    });
    evidence.telemetryHealth.producerLoggingPolicy = assertDockerLoggingPolicy(
      producerInfo.HostConfig.LogConfig,
      logging,
    );
    evidence.phases.signals = "PASS";

    startPhase("alerts");
    const syntheticWorker = await startSyntheticAlertWorker({
      root,
      config,
      definitions,
      provisioning,
      baseUrls,
      authorization,
      folderUid,
      producerUrl,
      runId,
      alertPath,
    });

    startPhase("runtimeMatrix");
    const { verifyRuntimeMetricMatrix } =
      await import("../../tests/observability/runtime-matrix.mjs");
    const matrixProject = validatedLaunch.context.resources.composeProject;
    let collectorReconfigured = false;
    const configureCollector = async (selectedLogs, networks = []) => {
      if (selectedLogs !== logFiles) collectorReconfigured = true;
      const text = createAlloyConfig({
        config,
        logFiles: selectedLogs,
        exporterToken: producerToken,
      });
      await writePrivateSecret(collectorConfigPath, text);
      ensureCollectorConfigOwnership({
        collectorConfigPath,
        nodeImage: toolchain.nodeImage,
        runDocker: run,
      });
      const override = createComposeOverride({
        config,
        imageRefs: toolchain,
        grafanaImage: verifiedGrafana.imageId,
        alertSinkImage: storageHelper.imageId,
        logFiles: selectedLogs,
        collectorConfigPath,
        probePath,
        storageVolumes,
        backendConfigPaths,
        grafanaAdminSecretPath: secretPath,
        alertEvidenceDir: alertDir,
        observabilityNetworkName: backendNetwork,
      });
      services["otel-collector"].volumes =
        override.services["otel-collector"].volumes;
      await writeFile(
        composeFile,
        dumpYaml(fixtureCompose, { noRefs: true, lineWidth: 120 }),
        { mode: 0o600 },
      );
      compose(["up", "-d", "--no-deps", "--force-recreate", "otel-collector"]);
      containerIds["otel-collector"] = compose([
        "ps",
        "--quiet",
        "otel-collector",
      ]).trim();
      if (!/^[a-f0-9]{12,64}$/u.test(containerIds["otel-collector"]))
        throw new Error("recreated Alloy container identity unavailable");
      const info = JSON.parse(
        run(["inspect", containerIds["otel-collector"]]),
      )[0];
      const address =
        info?.NetworkSettings?.Networks?.[backendNetwork]?.IPAddress;
      if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address ?? ""))
        throw new Error("recreated Alloy backend address unavailable");
      baseUrls["otel-collector"] =
        `http://${address}:${new URL(config.telemetry.collector.healthEndpoint).port}`;
      for (const network of new Set(networks))
        run([
          "network",
          "connect",
          "--alias",
          "otel-collector",
          network,
          containerIds["otel-collector"],
        ]);
      await waitHealth("otel-collector");
      collectorReconfigured = selectedLogs !== logFiles;
    };
    try {
      evidence.runtimeMetricMatrix = await verifyRuntimeMetricMatrix({
        config,
        exporterToken: producerToken,
        projectName: matrixProject,
        runDocker: run,
        sourceIdentity,
        nodeVersion: toolchain.node,
        nginxVersion: toolchain.nginxVersion,
        verifyMetricFamily: (family) =>
          waitForOwnedMetricFamilySamples({
            baseUrl: baseUrls.prometheus,
            family,
            startTimeUs: family.startTimeUs,
          }),
        onRolesReady: async ({ logFiles: runtimeLogs, networks }) => {
          const syntheticReceipt = await syntheticWorker.wait();
          evidence.syntheticNodeNotReady =
            syntheticReceipt.syntheticNodeNotReady;
          evidence.alerts = [...syntheticReceipt.alerts];
          await configureCollector(runtimeLogs, Object.values(networks));
          const sinceUs = Date.now() * 1000;
          const nginx = runtimeLogs.find(
            (item) => item.service === "edge-nginx",
          );
          if (!nginx) throw new Error("runtime matrix is missing native nginx");
          const readinessRule = definitions.find(
            (rule) => rule.key === "notReady",
          );
          const readRuleValue = async () => {
            const query = new URLSearchParams({ query: readinessRule.query });
            const response = await api({
              baseUrl: baseUrls.prometheus,
              path: `/api/v1/query?${query}`,
            });
            const result = response?.data?.result;
            if (
              response?.status !== "success" ||
              response.data?.resultType !== "vector" ||
              !Array.isArray(result) ||
              result.length !== 1 ||
              !Array.isArray(result[0].value) ||
              result[0].value.length !== 2 ||
              !["0", "1"].includes(result[0].value[1])
            )
              throw new Error(
                "production readiness rule query returned an invalid value",
              );
            return Number(result[0].value[1]);
          };
          const readProbes = async (fromUs) => {
            const readiness = await readinessMetricSamples({
              baseUrl: baseUrls.prometheus,
              services: NODE_RUNTIME_TARGETS,
              afterUs: fromUs,
            });
            const probes = await queryPrometheusRange({
              baseUrl: baseUrls.prometheus,
              expression:
                'probe_success{service_name="otel-collector",probe_owner="edge-nginx"}',
              startTimeUs: fromUs,
            });
            const latest = probes
              .filter(
                (sample) =>
                  sample.probe_owner === "edge-nginx" &&
                  sample._timestamp > fromUs,
              )
              .sort((a, b) => b._timestamp - a._timestamp)[0];
            return { readiness, nginx: latest };
          };
          await waitFor(
            async () => {
              const current = await readProbes(sinceUs);
              return (
                current.readiness.every((item) => item.sample?.value === 1) &&
                current.nginx?.value === 1 &&
                (await readRuleValue()) === 1
              );
            },
            {
              timeoutMs: 120000,
              intervalMs: 3000,
              description: "fresh readiness for all 14 runtimes and real nginx",
            },
          );
          const stableMs =
            config.telemetry.alerts.evaluationIntervalMs +
            config.platform.health.intervalMs;
          let stableSince = Date.now();
          await waitFor(
            async () => {
              try {
                const events = (await readSinkEvents(alertPath)).filter(
                  (item) => item.name === readinessRule.name,
                );
                const unresolved = events.some(
                  (item) =>
                    item.status === "firing" &&
                    !events.some(
                      (later) =>
                        later.status === "resolved" &&
                        later.episodeId === item.episodeId,
                    ),
                );
                const current = await readProbes((Date.now() - 30000) * 1000);
                if (
                  unresolved ||
                  !current.readiness.every(
                    (item) => item.sample?.value === 1,
                  ) ||
                  current.nginx?.value !== 1 ||
                  (await readRuleValue()) !== 1
                )
                  stableSince = Date.now();
                return Date.now() - stableSince >= stableMs;
              } catch (error) {
                stableSince = Date.now();
                throw error;
              }
            },
            {
              timeoutMs:
                stableMs + 4 * config.telemetry.alerts.evaluationIntervalMs,
              intervalMs: 3000,
              description: "stable resolved production readiness alert",
            },
          );
          const stoppedAtMs = Date.now();
          let nginxStopped = false;
          try {
            const stopped = stopContainerGracefully({
              run,
              name: nginx.containerId,
              graceMs: config.platform.shutdownGraceMs,
            });
            if (stopped.status !== "PASS")
              throw new Error("native nginx graceful stop failed");
            nginxStopped = true;
            await waitFor(
              async () =>
                (await readProbes(stoppedAtMs * 1000)).nginx?.value === 0,
              {
                timeoutMs: 120000,
                intervalMs: 3000,
                description: "fresh real nginx probe changes 1 to 0",
              },
            );
            const event = await waitFor(
              async () => {
                try {
                  const current = await readProbes((Date.now() - 30000) * 1000);
                  if (
                    !current.readiness.every(
                      (item) => item.sample?.value === 1,
                    ) ||
                    current.nginx?.value !== 0 ||
                    (await readRuleValue()) !== 0
                  )
                    throw new Error(
                      "production readiness inputs were not continuously fresh and stable during nginx stop",
                    );
                  return (await readSinkEvents(alertPath)).find(
                    (item) =>
                      item.name === readinessRule.name &&
                      item.status === "firing" &&
                      alertEpisodeStartMs(item.episodeId) >=
                        stoppedAtMs + readinessRule.forMs &&
                      Date.parse(item.receivedAt) >=
                        alertEpisodeStartMs(item.episodeId),
                  );
                } catch (error) {
                  throw Object.assign(error, { fatal: true });
                }
              },
              {
                timeoutMs:
                  readinessRule.forMs +
                  5 * config.telemetry.alerts.evaluationIntervalMs,
                intervalMs: 5000,
                description:
                  "production nginx readiness firing after configured hold",
              },
            );
            const restartedAtMs = Date.now();
            run(["start", nginx.containerId]);
            nginxStopped = false;
            await waitFor(
              async () =>
                (await readProbes(restartedAtMs * 1000)).nginx?.value === 1 &&
                (await readRuleValue()) === 1,
              {
                timeoutMs: 120000,
                intervalMs: 3000,
                description: "fresh real nginx probe changes 0 to 1",
              },
            );
            await waitFor(
              async () =>
                (await readSinkEvents(alertPath)).some(
                  (item) =>
                    item.name === readinessRule.name &&
                    item.status === "resolved" &&
                    item.episodeId === event.episodeId &&
                    Date.parse(item.receivedAt) >= restartedAtMs,
                ),
              {
                timeoutMs: 5 * config.telemetry.alerts.evaluationIntervalMs,
                intervalMs: 5000,
                description: "same production readiness episode resolved",
              },
            );
            evidence.nativeNginxAlert = {
              status: "PASS",
              episodeId: event.episodeId,
              forMs: readinessRule.forMs,
              stoppedAtMs,
              restartedAtMs,
              sequence: [1, 0, 1],
              nodeOwners: NODE_RUNTIME_TARGETS.length,
            };
            evidence.alertReadiness = "PASS";
            evidence.alerts.push({
              key: readinessRule.key,
              name: readinessRule.name,
              episodeId: event.episodeId,
              forMs: readinessRule.forMs,
              firing: true,
              resolved: true,
              actualOwner: "edge-nginx",
            });
          } finally {
            if (nginxStopped) run(["start", nginx.containerId]);
          }
        },
        onCleanup: async () => {
          if (collectorReconfigured) await configureCollector(logFiles);
        },
      });
      evidence.phases.runtimeMatrix = "PASS";
    } catch (error) {
      evidence.phases.runtimeMatrix = "FAIL";
      evidence.runtimeMetricMatrix = error.runtimeMetricMatrix ?? {
        status: "FAIL",
      };
      evidence.runtimeMatrixFailure = cleanError(error);
    } finally {
      if (collectorReconfigured) await configureCollector(logFiles);
    }

    let syntheticReceipt;
    try {
      syntheticReceipt = await syntheticWorker.wait();
    } catch (error) {
      evidence.phases.alerts = "FAIL";
      evidence.alertTransitions = "FAIL";
      throw error;
    }
    if (!evidence.syntheticNodeNotReady) {
      evidence.syntheticNodeNotReady = syntheticReceipt.syntheticNodeNotReady;
      evidence.alerts = [...syntheticReceipt.alerts];
    }
    try {
      const diskRule = definitions.find((rule) => rule.key === "diskWatermark");
      const diskFile = "/data/disk-watermark-fill";
      const diskWriter = (script) =>
        run([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--user",
          "472:472",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "64m",
          "--pids-limit",
          "16",
          "--mount",
          `type=volume,source=${storage.grafana.volumeName},target=/data`,
          "--entrypoint",
          "node",
          toolchain.nodeImage,
          "-e",
          script,
          diskFile,
        ]);
      const priorDiskEvents = (await readSinkEvents(alertPath)).filter(
        (item) => item.name === diskRule.name,
      );
      if (
        priorDiskEvents.some(
          (item) =>
            item.status === "firing" &&
            !priorDiskEvents.some(
              (later) =>
                later.status === "resolved" &&
                later.episodeId === item.episodeId,
            ),
        )
      )
        throw new Error("disk alert has an unresolved episode before pressure");
      const pressureStartedMs = Date.now();
      diskPressureIdentity = JSON.parse(
        diskWriter(
          `const fs=require('node:fs'),fd=fs.openSync(process.argv[1],'wx',0o600),s=fs.fstatSync(fd);fs.closeSync(fd);process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino}));`,
        ),
      );
      diskWriter(
        `const fs=require('node:fs'),p=process.argv[1],expected=${JSON.stringify(diskPressureIdentity)},fd=fs.openSync(p,'r+'),actual=fs.fstatSync(fd);if(actual.dev!==expected.dev||actual.ino!==expected.ino)throw Error('pressure file identity changed');const s=fs.statfsSync('/data'),target=Math.floor(s.blocks*s.bsize*0.82),used=(s.blocks-s.bfree)*s.bsize,n=target-used;if(n<=0)throw Error('disk baseline already above fixture target');const buf=Buffer.alloc(1024*1024);for(let i=0;i<n;i+=buf.length)fs.writeSync(fd,buf,0,Math.min(buf.length,n-i));fs.fsyncSync(fd);fs.closeSync(fd);`,
      );
      await waitFor(
        async () => {
          const selector =
            '{service_name="otel-collector",mountpoint="/telemetry-storage/grafana"}';
          const [free, size] = await Promise.all(
            ["node_filesystem_free_bytes", "node_filesystem_size_bytes"].map(
              (name) =>
                queryPrometheusRange({
                  baseUrl: baseUrls.prometheus,
                  expression: `${name}${selector}`,
                  startTimeUs: pressureStartedMs * 1000,
                }),
            ),
          );
          return free.some(
            (sample) =>
              sample._timestamp > pressureStartedMs * 1000 &&
              size.some(
                (total) =>
                  total._timestamp === sample._timestamp &&
                  total.device === sample.device &&
                  total.mountpoint === sample.mountpoint &&
                  total.value > 0 &&
                  (1 - sample.value / total.value) * 100 >=
                    config.telemetry.diskWatermarkPercent,
              ),
          );
        },
        {
          timeoutMs: 120000,
          intervalMs: 2000,
          description: "actual Grafana volume usage above disk watermark",
        },
      );
      const diskFiring = await waitFor(
        async () =>
          (await readSinkEvents(alertPath)).find(
            (item) =>
              item.name === diskRule.name &&
              item.status === "firing" &&
              alertEpisodeStartMs(item.episodeId) >= pressureStartedMs &&
              Date.parse(item.receivedAt) >=
                alertEpisodeStartMs(item.episodeId),
          ),
        {
          timeoutMs: 5 * config.telemetry.alerts.evaluationIntervalMs + 60000,
          intervalMs: 5000,
          description: "Grafana disk watermark firing episode",
        },
      );
      diskWriter(
        `const fs=require('node:fs'),p=process.argv[1],s=fs.lstatSync(p),expected=${JSON.stringify(diskPressureIdentity)};if(!s.isFile()||s.isSymbolicLink()||s.dev!==expected.dev||s.ino!==expected.ino)throw Error('pressure file identity changed');fs.unlinkSync(p);`,
      );
      diskPressureIdentity = undefined;
      await waitFor(
        async () =>
          (await readSinkEvents(alertPath)).some(
            (item) =>
              item.name === diskRule.name &&
              item.status === "resolved" &&
              item.episodeId === diskFiring.episodeId,
          ),
        {
          timeoutMs: 5 * config.telemetry.alerts.evaluationIntervalMs + 60000,
          intervalMs: 5000,
          description: "Grafana disk watermark resolved episode",
        },
      );
      const nativeAlertIndex = evidence.alerts.findIndex(
        (item) => item.key === "notReady",
      );
      evidence.alerts.splice(
        nativeAlertIndex < 0 ? evidence.alerts.length : nativeAlertIndex,
        0,
        {
          key: diskRule.key,
          name: diskRule.name,
          episodeId: diskFiring.episodeId,
          firing: true,
          resolved: true,
        },
      );
      evidence.alertTransitions = "NOT_RUN";
      evidence.phases.alerts = "PARTIAL";
      evidence.alertReadiness ??= "NOT_RUN";
    } catch (error) {
      evidence.phases.alerts = "FAIL";
      evidence.alertTransitions = "FAIL";
      evidence.alertFailure = cleanError(error);
      if (diskPressureIdentity) {
        run([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--user",
          "472:472",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "64m",
          "--pids-limit",
          "16",
          "--mount",
          `type=volume,source=${storage.grafana.volumeName},target=/data`,
          "--entrypoint",
          "node",
          toolchain.nodeImage,
          "-e",
          `const fs=require('node:fs'),p='/data/disk-watermark-fill',expected=${JSON.stringify(diskPressureIdentity)},s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.dev!==expected.dev||s.ino!==expected.ino)throw Error('pressure file identity changed');fs.unlinkSync(p)`,
        ]);
        diskPressureIdentity = undefined;
      }
    }

    if (
      evidence.alerts.length === 6 &&
      evidence.alertReadiness === "PASS" &&
      syntheticNodeNotReadyComplete(evidence.syntheticNodeNotReady)
    ) {
      evidence.phases.alerts = "PASS";
      evidence.alertTransitions = "PASS";
    }
    assertGrafanaGeneration(
      grafanaGeneration,
      JSON.parse(run(["inspect", containerIds.grafana]))[0],
    );

    startPhase("launchPath");
    const { runLaunchPath } =
      await import("../../tests/observability/launch-path.mjs");
    const launchStartedAtUs = Date.now() * 1000;
    let launchNetwork,
      launchCollectorStopped = false;
    const previousTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = workDir;
    try {
      const executeLaunchPath = (launchContextFile) =>
        runLaunchPath({
          ...(launchContextFile ? { launchContextFile } : {}),
          telemetry: {
            config: config.telemetry,
            endpoint: config.telemetry.collector.otlpEndpoint,
            exporterToken: producerToken,
          },
          resultDir: join(workDir, "launch-path"),
          onNetwork: async ({ networkName }) => {
            launchNetwork = networkName;
            const targets = ["grafana", "loki", "prometheus", "tempo"].flatMap(
              (name) => [config.telemetry[name].endpoint, baseUrls[name]],
            );
            const blocked = JSON.parse(
              run([
                "run",
                "--rm",
                "--network",
                networkName,
                "--read-only",
                "--tmpfs",
                "/tmp:rw,noexec,nosuid,nodev,size=8m",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--memory",
                "64m",
                "--pids-limit",
                "16",
                "--entrypoint",
                "node",
                toolchain.nodeImage,
                "-e",
                "Promise.all(process.argv.slice(1).map(async u=>{try{await fetch(u,{signal:AbortSignal.timeout(1500)});return false}catch{return true}})).then(x=>process.stdout.write(JSON.stringify(x)))",
                ...targets,
              ]),
            );
            if (
              !Array.isArray(blocked) ||
              blocked.length !== targets.length ||
              blocked.some((value) => value !== true)
            )
              throw new Error(
                "launch-path application network can reach an isolated backend",
              );
            evidence.networkIsolation.launchPathNetworkStatus = "PASS";
            run([
              "network",
              "connect",
              "--alias",
              "otel-collector",
              networkName,
              containerIds["otel-collector"],
            ]);
          },
          onNetworkCleanup: async () => {
            if (!launchNetwork) return;
            const attached = JSON.parse(
              run([
                "inspect",
                "--format",
                "{{json .NetworkSettings.Networks}}",
                containerIds["otel-collector"],
              ]),
            );
            if (attached?.[launchNetwork])
              run([
                "network",
                "disconnect",
                "--force",
                launchNetwork,
                containerIds["otel-collector"],
              ]);
            launchNetwork = undefined;
          },
          onRolesReady: async ({ logFiles: launchLogs }) => {
            if (
              !Array.isArray(launchLogs) ||
              !launchLogs.some((item) => item.service === "edge-nginx")
            )
              throw new Error("launch path lacks real nginx log source");
            await configureCollector(launchLogs, [launchNetwork]);
            evidence.telemetryHealth.launchPathCollectorConfig = "PASS";
            const stopped = stopContainerGracefully({
              run,
              name: containerIds["otel-collector"],
              graceMs: config.platform.shutdownGraceMs,
            });
            if (stopped.status !== "PASS")
              throw new Error("Alloy failed graceful stop for launch outage");
            launchCollectorStopped = true;
          },
          observeBaseline: async (baseline, { probeNativeAccess }) => {
            const requiredRoles = [
              "kafka",
              "orders-service",
              "orders-aroma-preparation",
              "api-internal",
              "api-public",
              "realtime-gateway",
              "edge-gateway",
              "edge-nginx",
            ];
            const nodes = [
              "edge-gateway",
              "api-public",
              "api-internal",
              "orders-service",
              "orders-aroma-preparation",
              "realtime-gateway",
            ];
            if (
              !launchCollectorStopped ||
              baseline?.verified !== true ||
              baseline.sourceEvents < 2 ||
              baseline.sourceBrokerAckCount !== baseline.sourceEvents ||
              baseline.sourceInboxCommitted !== true ||
              baseline.projectionPresent !== true ||
              baseline.realtimeOutboxPersisted !== true ||
              baseline.sseReady !== true ||
              baseline.ownerRefetch?.status !== 200 ||
              baseline.ownerRefetch?.requestAndResponseCorrelationMatched !==
                true ||
              baseline.ownerRefetch?.requestAndResponseTraceparentMatched !==
                true ||
              nodes.some((role) => baseline.nodeReadiness?.[role] !== 200) ||
              requiredRoles.some(
                (role) =>
                  !baseline.roles?.some(
                    (item) => item.role === role && item.running === true,
                  ),
              )
            )
              throw new Error(
                "business owner path did not remain healthy during Alloy outage",
              );
            run(["start", containerIds["otel-collector"]]);
            launchCollectorStopped = false;
            await waitHealth("otel-collector");
            const native = await probeNativeAccess();
            const nativeLogs = await waitFor(
              async () => {
                const found = await queryLokiLogs({
                  baseUrl: baseUrls.loki,
                  runId: native.correlationId,
                  startTimeUs: launchStartedAtUs,
                });
                return found.some(
                  (record) =>
                    record.service_name === "edge-nginx" &&
                    hasExactValue(record, native.correlationId),
                )
                  ? found
                  : false;
              },
              {
                timeoutMs: 120000,
                intervalMs: 2000,
                description: "real nginx correlated log after Alloy restart",
              },
            );
            evidence.telemetryHealth.launchPathOutageStatus = "PASS";
            evidence.launchPathOutage = {
              status: "PASS",
              sourceEvents: baseline.sourceEvents,
              ownerRefetchStatus: baseline.ownerRefetch.status,
              nativeAccessRows: nativeLogs.length,
              collectorStopped: true,
              collectorRestarted: true,
            };
          },
          onConvergenceMetrics: async ({
            barrierId,
            phase,
            expectedMetrics,
          }) => {
            if (
              !["unknown-current", "recovered-terminal"].includes(phase) ||
              !validConvergenceMetricContract(expectedMetrics, phase)
            )
              throw new Error(
                "convergence barrier differs from required metric contract",
              );
            const observations = await waitForConvergenceMetricSamples({
              baseUrl: baseUrls.prometheus,
              expectedMetrics,
              startTimeUs: launchStartedAtUs,
            });
            evidence.convergenceBarriers ??= {};
            evidence.convergenceBarriers[phase] = {
              status: "PASS",
              barrierId,
              observations,
            };
            return { status: "PASS" };
          },
          observeProof: async (proof) => {
            if (
              proof?.verified !== true ||
              !/^[0-9a-f-]{36}$/iu.test(proof.correlationId ?? "") ||
              !/^[0-9a-f]{32}$/iu.test(proof.traceId ?? "")
            )
              throw new Error("launch fixture correlation proof invalid");
            const expectedTelemetry = proof.expectedTelemetry;
            const ownerMessageSha256 =
              proof.ownerBrokerReceipt?.messageIdSha256;
            const wakeMessageSha256 = proof.wakeReceipt?.messageIdSha256;
            const convergenceWake = proof.convergenceMetricReceipt?.wakeReceipt;
            const resultRelay =
              proof.convergenceMetricReceipt?.resultRelayReceipt;
            const resultMessages = resultRelay?.resultMessages;
            const projection = proof.projectionReceipt;
            const hasHash = (value) =>
              typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
            const causalProofValid =
              proof.command?.status === 202 &&
              proof.command?.ownerOutboxMatched === true &&
              proof.command?.traceparentMatched === true &&
              proof.command?.rootCausation === true &&
              hasHash(ownerMessageSha256) &&
              proof.ownerMessageSha256 === ownerMessageSha256 &&
              proof.ownerBrokerReceipt?.state === "Published" &&
              proof.wakeReceipt?.messageType ===
                "AromaConvergenceRequested.v1" &&
              proof.wakeReceipt?.state === "Published" &&
              proof.wakeReceipt?.causationMatched === true &&
              proof.wakeReceipt?.causationMessageSha256 ===
                ownerMessageSha256 &&
              hasHash(wakeMessageSha256) &&
              convergenceWake?.messageIdSha256 === wakeMessageSha256 &&
              convergenceWake?.rootCausationSha256 === ownerMessageSha256 &&
              convergenceWake?.outboxState === "Published" &&
              convergenceWake?.inboxState === "Processed" &&
              convergenceWake?.correlationMatched === true &&
              convergenceWake?.traceparentMatched === true &&
              resultRelay?.wakeMessageIdSha256 === wakeMessageSha256 &&
              resultRelay?.allSelectedMessagesPublished === true &&
              Array.isArray(resultMessages) &&
              resultMessages.length > 0 &&
              resultRelay.selectedOutboxPublishedCount ===
                resultMessages.length &&
              resultMessages.every(
                (message) =>
                  message?.state === "Published" &&
                  message.causationIdSha256 === wakeMessageSha256 &&
                  message.correlationMatched === true &&
                  message.traceparentMatched === true &&
                  hasHash(message.messageIdSha256),
              ) &&
              hasHash(projection?.resultMessageSha256) &&
              resultMessages.some(
                (message) =>
                  message?.messageIdSha256 === projection.resultMessageSha256,
              ) &&
              projection?.resultCausationMatched === true &&
              projection?.resultCausationMessageSha256 === wakeMessageSha256 &&
              projection?.inboxState === "Processed" &&
              projection?.outboxState === "Published" &&
              projection?.causationMatched === true &&
              projection?.causationMessageSha256 ===
                projection?.resultMessageSha256 &&
              hasHash(projection?.realtimeMessageSha256) &&
              projection?.realtimeMessageSha256 ===
                proof.realtimeMessageSha256 &&
              proof.refetchReceipt?.status === 200 &&
              proof.refetchReceipt?.matched === true &&
              proof.refetchReceipt?.frameMessageSha256 ===
                projection?.realtimeMessageSha256 &&
              proof.sseReceipt?.frameMatched === true &&
              proof.sseReceipt?.correlationId === proof.correlationId &&
              proof.transport?.realAromaConvergenceConsumer === true;
            if (
              !causalProofValid ||
              proof.projectionReceipt?.inboxState !== "Processed" ||
              proof.projectionReceipt?.outboxState !== "Published" ||
              proof.projectionReceipt?.traceparentMatched !== true ||
              proof.projectionReceipt?.causationMatched !== true ||
              proof.command?.rootCausation !== true ||
              proof.sseReceipt?.frameMatched !== true ||
              proof.sseReceipt?.correlationId !== proof.correlationId ||
              proof.refetchReceipt?.matched !== true ||
              proof.refetchReceipt?.requestAndResponseCorrelationMatched !==
                true ||
              proof.refetchReceipt?.correlationId !== proof.correlationId ||
              proof.refetchReceipt?.traceparentSha256 !==
                proof.traceparentSha256 ||
              proof.transport?.realKafka !== true ||
              proof.transport?.realOrdersService !== true ||
              proof.transport?.realOrdersAromaPreparation !== true ||
              proof.transport?.edge !== "nginx -> Edge -> api-public" ||
              !expectedTelemetry ||
              !Array.isArray(expectedTelemetry.nativeLogRoles) ||
              !expectedTelemetry.nativeLogRoles.includes("edge-nginx") ||
              !expectedTelemetry.traceSpanNames ||
              !Array.isArray(expectedTelemetry.separateRealtimeSpanNames) ||
              !proof.roles?.some((role) => role.role === "edge-nginx") ||
              proof.convergenceMetricReceipt?.verified !== true ||
              proof.convergenceMetricReceipt.owner !== "aroma-convergence" ||
              proof.convergenceMetricReceipt.unknownOutcomeCounter !== 1 ||
              proof.convergenceMetricReceipt.unknownOutcomesCurrent?.join(
                ",",
              ) !== "1,0" ||
              proof.convergenceMetricReceipt.recoveredAppliedCounter !== 1 ||
              proof.convergenceMetricReceipt.attemptStates?.join(",") !==
                "UnknownOutcome,NoOpInSync" ||
              !validConvergenceMetricContract(expectedTelemetry.ownerMetrics)
            )
              throw new Error(
                "launch-path fixture receipts did not prove the actual Kafka, owner, projection, SSE and refetch boundaries",
              );

            const logs = await waitFor(
              async () => {
                const found = await queryLokiLogs({
                  baseUrl: baseUrls.loki,
                  runId: proof.correlationId,
                  startTimeUs: launchStartedAtUs,
                });
                return found.some((row) =>
                  hasExactValue(row, proof.correlationId),
                ) &&
                  found.some(
                    (row) =>
                      row.service_name === "edge-nginx" &&
                      hasExactValue(row, proof.correlationId),
                  )
                  ? found
                  : false;
              },
              {
                timeoutMs: 120000,
                intervalMs: 2000,
                description: "real owner and native nginx correlation in Loki",
              },
            );
            const trace = await waitForSameTraceSpans({
              baseUrl: baseUrls.tempo,
              traceId: proof.traceId,
              expectedSpanNames: expectedTelemetry.traceSpanNames,
              timeoutMs: 120000,
            });
            const separate = {};
            for (const spanName of expectedTelemetry.separateRealtimeSpanNames) {
              const query = new URLSearchParams({
                q: `{resource.service.name="realtime-gateway" && name=${JSON.stringify(spanName)}}`,
                start: String(Math.floor(launchStartedAtUs / 1e6)),
                end: String(Math.ceil(Date.now() / 1000)),
                limit: "100",
              });
              separate[spanName] = await waitFor(
                async () => {
                  const result = await api({
                    baseUrl: baseUrls.tempo,
                    path: `/api/search?${query}`,
                  });
                  if (!Array.isArray(result?.traces))
                    throw new Error(
                      "Tempo search returned invalid trace inventory",
                    );
                  for (const row of result.traces) {
                    const candidate = row.traceID ?? row.traceId;
                    if (!/^[a-f0-9]{32}$/u.test(candidate ?? "")) continue;
                    try {
                      await waitForSameTraceSpans({
                        baseUrl: baseUrls.tempo,
                        traceId: candidate,
                        expectedSpanNames: { "realtime-gateway": [spanName] },
                        timeoutMs: 2000,
                        intervalMs: 250,
                      });
                      return candidate;
                    } catch {}
                  }
                  return false;
                },
                {
                  timeoutMs: 120000,
                  intervalMs: 2000,
                  description: `actual separate SSE span ${spanName}`,
                },
              );
            }
            const families = [
              {
                name: "db.client.connection.checkout_wait",
                owners: [
                  "orders-service",
                  "orders-aroma-preparation",
                  "aroma-convergence",
                ],
                components: ["_count", "_sum", "_bucket"],
              },
              {
                name: "db.client.connection.waiting",
                owners: ["orders-service"],
                components: [""],
              },
              {
                name: "messaging.kafka.consumer.lag",
                owners: ["orders-aroma-preparation", "realtime-gateway"],
                components: [""],
              },
              {
                name: "messaging.kafka.event.age",
                owners: [
                  "orders-aroma-preparation",
                  "realtime-gateway",
                  "aroma-convergence",
                ],
                components: ["_count", "_sum", "_bucket"],
              },
              {
                name: "messaging.outbox.oldest_unpublished.age",
                owners: ["orders-service", "orders-aroma-preparation"],
                components: [""],
              },
              {
                name: "messaging.inbox.received.age",
                owners: ["orders-aroma-preparation", "aroma-convergence"],
                components: ["_count", "_sum", "_bucket"],
              },
              ...[
                "coffee_realtime_invalidation_attempts_total",
                "coffee_realtime_invalidation_dropped_total",
                "coffee_realtime_connections",
                "coffee_realtime_queue_records",
                "coffee_realtime_queue_bytes",
              ].map((name) => ({
                name,
                owners: ["realtime-gateway"],
                components: [""],
              })),
              {
                name: "runtime_http_requests_total",
                owners: ["api-public", "orders-service"],
                components: [""],
              },
              {
                name: "runtime_http_request_duration_ms",
                owners: ["api-public", "orders-service"],
                components: ["_count", "_sum", "_bucket"],
              },
              ...[
                "coffee_aroma_attempt_results_total",
                "coffee_aroma_unknown_outcomes_total",
                "coffee_aroma_unknown_outcomes_current",
                "coffee_aroma_recovery_results_total",
              ].map((name) => ({
                name,
                owners: ["aroma-convergence"],
                components: [""],
              })),
            ];
            const applicability = {};
            for (const family of families)
              applicability[family.name] =
                await waitForOwnedMetricFamilySamples({
                  baseUrl: baseUrls.prometheus,
                  family,
                  startTimeUs: launchStartedAtUs,
                });
            const serialized = JSON.stringify({
              logs,
              traceRows: trace.traceRows,
            });
            if (
              secrets.some((secret) => serialized.includes(secret)) ||
              /"(?:payload|request_body)"\s*:/iu.test(serialized)
            )
              throw new Error("launch telemetry exposed secret or raw payload");
            if (
              !["unknown-current", "recovered-terminal"].every(
                (phase) =>
                  evidence.convergenceBarriers?.[phase]?.status === "PASS",
              )
            )
              throw new Error(
                "both real convergence metric barriers are required",
              );
            evidence.metricApplicability = {
              ...applicability,
              aromaConvergenceProof: evidence.convergenceBarriers,
            };
            evidence.launchPathCorrelation = "PASS";
            evidence.launchPathProof = {
              verified: true,
              correlationId: proof.correlationId,
              traceId: proof.traceId,
              roles: proof.roles.map(({ role, containerId, imageId }) => ({
                role,
                containerId,
                imageId,
              })),
              traceInventory: trace.spanInventory,
              separateRealtimeTraces: separate,
              nativeLogCount: logs.filter(
                (row) => row.service_name === "edge-nginx",
              ).length,
              ownerCausation: proof.projectionReceipt.causationMatched,
              browserRefetchMatched: proof.refetchReceipt.matched,
            };
          },
        });
      if (!config.verification.databaseIsolation.enabled)
        throw new Error(
          "G14 browser correlation requires isolated launch databases",
        );
      const { runBrowserParent } =
        await import("../../verification/launch/v1/scenarios/browser.mjs");
      let browserTelemetry;
      const child = await runBrowserParent({
        runCorrelation: async (contextPath) => {
          const identity = await validateLaunchContext(contextPath);
          // This synthetic diagnostic remains separate from the actual browser proof.
          try {
            const component = await executeLaunchPath(contextPath);
            const externalCleanup = validateG14ComponentCleanup(
              component,
              identity.context.runId,
            );
            if (evidence.launchPathOutage?.status !== "PASS")
              throw new Error(
                "launch component diagnostic outage proof failed",
              );
            evidence.launchPathComponent = {
              ...evidence.launchPathProof,
              purpose: "SYNTHETIC_COMPONENT_DIAGNOSTIC",
              parentRunId: validatedLaunch.context.runId,
              parentCandidateSha: validatedLaunch.context.candidateSha,
              childRunId: identity.context.runId,
              childCandidateSha: identity.context.candidateSha,
              childConfigSha256: identity.context.baseConfigSha256,
              externalCleanup,
            };
          } finally {
            delete evidence.launchPathProof;
            evidence.launchPathCorrelation = "NOT_PROVEN";
          }
          const { runManagedRollbackChild } =
            await import("../../verification/launch/v1/scenarios/rollback.mjs");
          const { validateG14BrowserEvidence } =
            await import("../browser-proof.mjs");
          const verifiedImages = await readVerifiedRuntimeImages({
            contextFile: process.env.COFFEE_LAUNCH_CONTEXT_FILE,
          });
          evidence.verifiedRuntimeImages = verifiedImages;
          const expectedProject = identity.context.resources.composeProject;
          if (
            expectedProject !==
            `coffee-launch-${identity.context.runId.toLowerCase()}`
          )
            throw new Error("G14 child project identity invalid");
          let stage = "init";
          let observedProof;
          let browserTelemetryStartedAtUs;
          let browserNginxContainerId;
          let browserOrdersContainerId;
          let browserApiContainerId;
          let childEnded = false;
          let collectorNeedsRestore = false;
          let collectorTasks = Promise.resolve();
          const changeCollector = (selectedLogs, networks = []) => {
            if (selectedLogs !== logFiles) collectorNeedsRestore = true;
            const task = collectorTasks
              .catch(() => {})
              .then(() => configureCollector(selectedLogs, networks));
            collectorTasks = task;
            return task.then(() => {
              if (selectedLogs === logFiles) collectorNeedsRestore = false;
            });
          };
          const script = `import {runG14BrowserProof} from './tools/compose-smoke.mjs';
import {validateLaunchContext} from './verification/launch/v1/report.mjs';
const identity=await validateLaunchContext(process.env.COFFEE_LAUNCH_CONTEXT_FILE);
const runId=identity.context.runId;
const request=(stage,payload)=>new Promise((resolve,reject)=>{
 const disconnected=()=>{process.removeListener('message',received);reject(new Error('G14_IPC_DISCONNECTED'));};
 const received=(message,handle)=>{process.removeListener('disconnect',disconnected);if(handle||!message||message.stage!==stage||message.ok!==true)reject(new Error('G14_IPC_REJECTED'));else resolve(message.payload);};
 process.once('disconnect',disconnected);process.once('message',received);
 process.send({stage,runId,payload},error=>{if(error){process.removeListener('message',received);process.removeListener('disconnect',disconnected);reject(new Error('G14_IPC_SEND_FAILED'));}});
});
const init=await request('init',null);
const observability={exporterToken:init.exporterToken,onReady:context=>request('roles-ready',context),onCleanup:()=>request('cleanup',null)};
try {
 const r=await runG14BrowserProof({baseCandidateSha:process.argv[1],observability,onProof:proof=>request('browser-proof',proof)});
 if(process.connected)process.disconnect();console.log(JSON.stringify({g14BrowserProof:r.g14BrowserProof,cleanup:r.cleanup,externalCleanup:r.externalCleanup}));
} catch(error) {
 if(error.g14Retained)console.log(JSON.stringify({g14Retained:error.g14Retained}));
 if(process.connected)process.disconnect();throw error;
}`;
          let childResult;
          let retainedInfo;
          let restoreError;
          try {
            childResult = await runManagedRollbackChild({
              args: [
                "--input-type=module",
                "--eval",
                script,
                provenanceStart.baseSha,
              ],
              cwd: identity.candidateRoot,
              env: { ...process.env, COFFEE_LAUNCH_CONTEXT_FILE: contextPath },
              terminationGraceMs: 120_000,
              onIpc: async (message) => {
                if (
                  Object.keys(message).sort().join(",") !==
                    "payload,runId,stage" ||
                  message.runId !== identity.context.runId ||
                  (message.stage !== stage &&
                    !(
                      message.stage === "cleanup" &&
                      ["roles-ready", "browser-proof"].includes(stage)
                    ))
                )
                  throw new Error("G14 IPC stage invalid");
                if (message.stage === "cleanup") {
                  if (message.payload !== null)
                    throw new Error("G14 IPC cleanup invalid");
                  if (collectorNeedsRestore) await changeCollector(logFiles);
                  stage = "done";
                  return null;
                }
                if (stage === "init") {
                  if (message.payload !== null)
                    throw new Error("G14 IPC init invalid");
                  stage = "roles-ready";
                  return { exporterToken: producerToken };
                }
                if (stage === "roles-ready") {
                  const { logFiles: childLogs, networks } =
                    await validateG14TelemetrySources({
                      payload: message.payload,
                      projectName: expectedProject,
                      verifiedImages,
                      runDocker: run,
                    });
                  if (childEnded) throw new Error("G14 child already ended");
                  browserNginxContainerId = childLogs.find(
                    ({ service }) => service === "edge-nginx",
                  )?.containerId;
                  browserOrdersContainerId = childLogs.find(
                    ({ service }) => service === "orders-service",
                  )?.containerId;
                  browserApiContainerId = childLogs.find(
                    ({ service }) => service === "api-public",
                  )?.containerId;
                  await changeCollector(childLogs, networks);
                  browserTelemetryStartedAtUs = Date.now() * 1000;
                  stage = "browser-proof";
                  return null;
                }
                if (stage === "browser-proof") {
                  observedProof = validateG14BrowserEvidence(message.payload, {
                    runId: identity.context.runId,
                    candidateSha: identity.context.candidateSha,
                    configSha256: identity.context.baseConfigSha256,
                  });
                  browserTelemetry = await collectG14BrowserTelemetry({
                    proof: observedProof,
                    startTimeUs: browserTelemetryStartedAtUs,
                    nativeNginxContainerId: browserNginxContainerId,
                    nativeNginxImageId: verifiedImages.find(
                      ({ service }) => service === "edge-nginx",
                    )?.imageId,
                    ordersContainerId: browserOrdersContainerId,
                    ordersImageId: verifiedImages.find(
                      ({ service }) => service === "orders-service",
                    )?.imageId,
                    apiContainerId: browserApiContainerId,
                    apiImageId: verifiedImages.find(
                      ({ service }) => service === "api-public",
                    )?.imageId,
                    lokiUrl: baseUrls.loki,
                    tempoUrl: baseUrls.tempo,
                    secrets,
                  });
                  stage = "cleanup";
                  return null;
                }
                throw new Error("G14 IPC unexpected stage");
              },
            });
          } catch (error) {
            let retained;
            try {
              retained = JSON.parse(
                error.result?.stdout?.trim().split(/\r?\n/u).at(-1) ?? "{}",
              ).g14Retained;
            } catch {
              /* the child may have exited before reporting */
            }
            const safePath = (path) =>
              typeof path === "string" &&
              path.startsWith("/dev/shm/") &&
              resolve(path) === path;
            const valid =
              retained?.runId === identity.context.runId &&
              retained.projectName === expectedProject &&
              [
                retained.composeFile,
                retained.secretsDir,
                retained.browserFixtureRoot,
              ].every((path) => path === undefined || safePath(path)) &&
              Array.isArray(retained.databases) &&
              retained.databases.length <= 5 &&
              retained.databases.every((name) =>
                /^coffee_verify_[a-z0-9_]+$/u.test(name),
              );
            retainedInfo = {
              runId: identity.context.runId,
              projectName: expectedProject,
              cleanup: "UNKNOWN",
              ...(valid
                ? {
                    composeFile: retained.composeFile,
                    secretsDir: retained.secretsDir,
                    browserFixtureRoot: retained.browserFixtureRoot,
                    databases: retained.databases,
                  }
                : {}),
            };
            error.g14Retained = retainedInfo;
            throw error;
          } finally {
            childEnded = true;
            try {
              if (collectorNeedsRestore) await changeCollector(logFiles);
            } catch (error) {
              error.g14Retained = retainedInfo ?? {
                runId: identity.context.runId,
                projectName: expectedProject,
                cleanup: "UNKNOWN",
              };
              restoreError = error;
              cleanupErrors.push(`G14 collector restore: ${cleanError(error)}`);
            }
          }
          if (restoreError) throw restoreError;
          if (stage !== "done" || !observedProof)
            throw new Error("G14 IPC incomplete");
          const result = JSON.parse(
            childResult.stdout.trim().split(/\r?\n/u).at(-1),
          );
          if (!isDeepStrictEqual(result.g14BrowserProof, observedProof))
            throw new Error("G14 IPC proof differs from child result");
          return result;
        },
      });
      evidence.browserCorrelationChild = child.browserChild;
      const traceObserved =
        browserTelemetry?.status === "OBSERVED" &&
        browserTelemetry.ordinaryApiMeasurement?.status === "MEASURED" &&
        browserTelemetry.correlationId ===
          child.browserChild.proof.correlationId &&
        browserTelemetry.traceId === child.browserChild.proof.traceId &&
        browserTelemetry.carrier === child.browserChild.proof.ownerTraceparent;
      evidence.launchPathProof = {
        correlationId: child.browserChild.proof.correlationId,
        traceId: child.browserChild.proof.traceId,
        browserRefetchMatched: true,
        ownerCausation: true,
        telemetrySubproof: browserTelemetry,
        traceStatus: traceObserved ? "PASS" : "NOT_PROVEN",
      };
      evidence.launchPathCorrelation = traceObserved ? "PASS" : "NOT_PROVEN";
      if (!traceObserved)
        evidence.limitations.push(
          "G14 parent W3C and CID-bound trace evidence is NOT_PROVEN.",
        );
      evidence.phases.launchPath = traceObserved ? "PASS" : "NOT_RUN";
    } catch (error) {
      evidence.phases.launchPath = "FAIL";
      evidence.launchPathFailure = cleanError(error);
      if (error.g14Retained) evidence.launchPathRetained = error.g14Retained;
      if (error.externalCleanup)
        evidence.launchPathExternalCleanup = error.externalCleanup;
    } finally {
      if (launchCollectorStopped) {
        run(["start", containerIds["otel-collector"]]);
        launchCollectorStopped = false;
      }
      if (collectorReconfigured) await configureCollector(logFiles);
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
    }

    startPhase("memory");
    let memorySampler;
    const progress = {};
    try {
      const initial = await captureCollectorMemoryStartupBaseline({
        run,
        name: containerIds["otel-collector"],
        config,
      });
      progress.initial = initial;
      if (initial.status !== "PASS")
        throw new Error("Alloy memory baseline failed");
      memorySampler = startCollectorMemorySampler({
        name: containerIds["otel-collector"],
        token: randomBytes(16).toString("hex"),
        config,
      });
      const memory = await runCollectorMemoryProof({
        run,
        collectorName: containerIds["otel-collector"],
        tempoName: containerIds.tempo,
        collectorIp: new URL(baseUrls["otel-collector"]).hostname,
        prometheusUrl: baseUrls.prometheus,
        config,
        collectorConfig: createAlloyConfig({
          config,
          logFiles,
          exporterToken: producerToken,
        }),
        token: producerToken,
        runId,
        sampler: memorySampler,
        progress,
        cleanupErrors,
        cleanError,
      });
      const samplerStopped = await memorySampler.stopSampler({ run });
      if (!samplerStopped || memorySampler.failure)
        throw new Error("Alloy memory sampler cleanup failed");
      memorySampler = undefined;
      const generationBeforeMarker = containerGeneration({
        run,
        name: containerIds["otel-collector"],
      });
      if (
        generationBeforeMarker.id !== memory.containerGeneration.id ||
        generationBeforeMarker.state.StartedAt !==
          memory.containerGeneration.startedAt ||
        generationBeforeMarker.state.Running !== true ||
        generationBeforeMarker.state.OOMKilled === true
      )
        throw new Error("Alloy process changed before memory recovery marker");
      const marker = await waitFor(
        async () => {
          let response;
          try {
            response = await sendCollectorMemorySpan({
              collectorIp: new URL(baseUrls["otel-collector"]).hostname,
              config,
              token: producerToken,
              runId,
              name: "g14.collector.memory.recovered",
            });
          } catch {
            throw Object.assign(
              new Error("Alloy recovery marker request failed"),
              { fatal: true },
            );
          }
          if (isCollectorMemoryRefusal(response)) return false;
          if (
            response.httpStatus !== 200 ||
            !/^[0-9a-f]{32}$/u.test(response.traceId ?? "")
          )
            throw Object.assign(
              new Error(
                "Alloy recovery marker returned an unexpected response",
              ),
              { fatal: true },
            );
          return response;
        },
        {
          timeoutMs: 60000,
          intervalMs: 1000,
          description: "Alloy memory recovery marker admission",
        },
      );
      await waitForSameTraceSpans({
        baseUrl: baseUrls.tempo,
        traceId: marker.traceId,
        expectedSpanNames: {
          "g14-memory-proof": ["g14.collector.memory.recovered"],
        },
        timeoutMs: 120000,
      });
      const generationAfterMarker = containerGeneration({
        run,
        name: containerIds["otel-collector"],
      });
      if (
        generationAfterMarker.id !== memory.containerGeneration.id ||
        generationAfterMarker.state.StartedAt !==
          memory.containerGeneration.startedAt ||
        generationAfterMarker.state.Running !== true ||
        generationAfterMarker.state.OOMKilled === true
      )
        throw new Error("Alloy process changed after memory recovery marker");
      memory.status = "PASS";
      memory.samplerStopped = true;
      memory.durableExportProven = true;
      memory.recoveryTraceId = marker.traceId;
      evidence.telemetryHealth ??= {};
      evidence.telemetryHealth.collectorMemoryProof = memory;
      evidence.phases.memory = "PASS";
    } catch (error) {
      evidence.phases.memory = "FAIL";
      evidence.memoryFailure = cleanError(error);
      evidence.telemetryHealth ??= {};
      evidence.telemetryHealth.collectorMemoryDiagnostics = {
        status: "FAIL",
        progress,
        ...(memorySampler ? { sampler: memorySampler.diagnostics() } : {}),
      };
      const tempo = containerGeneration({ run, name: containerIds.tempo });
      if (tempo.state.Running !== true || tempo.state.Paused !== false)
        throw new Error("memory proof left Tempo unavailable");
    } finally {
      if (memorySampler && !(await memorySampler.stopSampler({ run }))) {
        evidence.phases.memory = "FAIL";
        if (evidence.telemetryHealth?.collectorMemoryProof)
          evidence.telemetryHealth.collectorMemoryProof.status = "FAIL";
        evidence.memoryFailure = [
          evidence.memoryFailure,
          "Alloy memory sampler cleanup failed",
        ]
          .filter(Boolean)
          .join("; ");
      }
    }

    startPhase("outage");
    const outageStartUs = Date.now() * 1000;
    const stoppedLoki = stopContainerGracefully({
      run,
      name: containerIds.loki,
      graceMs: config.platform.shutdownGraceMs,
    });
    if (stoppedLoki.status !== "PASS")
      throw new Error("Loki graceful stop failed");
    let collectorExpiredRetryDrop, dropFailure;
    const outageId = newRunId();
    try {
      const outageRequest = await fixtureRequest({
        baseUrl: producerUrl,
        runId: outageId,
      });
      if (outageRequest?.accepted !== true)
        throw new Error("producer request failed during Loki outage");
      await fixtureHealth({
        baseUrl: producerUrl,
        path: config.platform.health.readyPath,
        budgetMs: config.platform.requestDeadlineMs,
      });
      const retryWait =
        config.telemetry.collector.retryWindowMs +
        config.telemetry.collector.exportTimeoutMs +
        config.telemetry.collector.batchTimeoutMs +
        config.telemetry.collector.retryMaxMs +
        config.platform.health.intervalMs;
      await sleep(retryWait);
      try {
        collectorExpiredRetryDrop = collectorExpiredRetryDropEvidence({
          name: containerIds["otel-collector"],
          startTimeUs: outageStartUs,
        });
      } catch (error) {
        dropFailure = cleanError(error);
      }
    } finally {
      run(["start", containerIds.loki]);
    }
    await waitHealth("loki");
    const recoveryId = newRunId();
    const recoveryAtUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId: recoveryId });
    await waitFor(
      async () =>
        (
          await queryLokiLogs({
            baseUrl: baseUrls.loki,
            runId: recoveryId,
            startTimeUs: recoveryAtUs,
          })
        ).some((record) => hasExactValue(record, recoveryId)),
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "new exact request log in Loki after recovery",
      },
    );
    const checkpointId = newRunId();
    const checkpointAtUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId: checkpointId });
    const checkpointRecords = () =>
      queryLokiLogs({
        baseUrl: baseUrls.loki,
        runId: checkpointId,
        startTimeUs: checkpointAtUs,
      }).then((records) =>
        records.filter(
          (record) =>
            hasExactValue(record, checkpointId) &&
            hasExactValue(record, "synthetic observability sample"),
        ),
      );
    await waitFor(async () => (await checkpointRecords()).length === 1, {
      timeoutMs: 120000,
      intervalMs: 2000,
      description: "unique checkpoint marker before Alloy restart",
    });
    const baselineDiagnostics = await fixtureDiagnostics(producerUrl);
    const beforeCollector = containerGeneration({
      run,
      name: containerIds["otel-collector"],
    });
    const stoppedCollector = stopContainerGracefully({
      run,
      name: containerIds["otel-collector"],
      graceMs: config.platform.shutdownGraceMs,
    });
    if (stoppedCollector.status !== "PASS")
      throw new Error("Alloy graceful stop failed during outage");
    let failedDiagnostics;
    try {
      await fixtureRequest({
        baseUrl: producerUrl,
        path: "/test/burst",
        body: { count: config.telemetry.producer.queueCapacity * 4 },
        runId,
      });
      for (let count = 0; count < 4; count += 1)
        await fixtureHealth({
          baseUrl: producerUrl,
          path: config.platform.health.readyPath,
          budgetMs: config.platform.requestDeadlineMs,
        });
      failedDiagnostics = await waitFor(
        async () => {
          const current = await fixtureDiagnostics(producerUrl);
          return current.exportFailures > baselineDiagnostics.exportFailures &&
            current.dropped > baselineDiagnostics.dropped
            ? current
            : false;
        },
        {
          timeoutMs:
            config.telemetry.producer.exportTimeoutMs +
            config.telemetry.producer.batchIntervalMs +
            config.telemetry.producer.diagnosticIntervalMs,
          intervalMs: 500,
          description:
            "producer export failure and bounded queue drop during Alloy outage",
        },
      );
    } finally {
      run(["start", containerIds["otel-collector"]]);
    }
    await waitHealth("otel-collector");
    const afterCollector = containerGeneration({
      run,
      name: containerIds["otel-collector"],
    });
    const collectorRestartedUs = startedAtUs(afterCollector.state);
    if (
      afterCollector.id !== beforeCollector.id ||
      collectorRestartedUs <= startedAtUs(beforeCollector.state)
    )
      throw new Error(
        "Alloy restart did not create a new generation in the same container",
      );
    const restartMarkerId = newRunId();
    const restartMarkerAtUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId: restartMarkerId });
    await waitFor(
      async () =>
        (
          await queryLokiLogs({
            baseUrl: baseUrls.loki,
            runId: restartMarkerId,
            startTimeUs: restartMarkerAtUs,
          })
        ).some((record) => hasExactValue(record, restartMarkerId)),
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "new log after Alloy restart",
      },
    );
    if ((await checkpointRecords()).length !== 1)
      throw new Error("Alloy graceful restart replayed the checkpoint marker");
    evidence.telemetryHealth ??= {};
    evidence.telemetryHealth.collectorFilelogCheckpoint = {
      status: "PASS",
      restart: "graceful-same-container",
      markerCorrelationId: checkpointId,
      markerRecordsBeforeRestart: 1,
      markerRecordsAfterRestart: 1,
      postRestartCorrelationId: restartMarkerId,
    };
    try {
      evidence.collectorQueueMetrics = await verifyCollectorQueueMetrics({
        baseUrl: baseUrls.prometheus,
        startTimeUs: collectorRestartedUs,
        lossStartTimeUs: outageStartUs,
        lossEndTimeUs: collectorRestartedUs,
        queueCapacity: config.telemetry.collector.queueCapacity,
      });
    } catch (error) {
      evidence.collectorQueueFailure = cleanError(error);
    }
    evidence.outageRestart = {
      loki: "restarted",
      collector: "restarted",
      producerExportFailureObserved: true,
      queueDrops: failedDiagnostics.dropped - baselineDiagnostics.dropped,
      collectorExpiredRetryDrop: collectorExpiredRetryDrop ?? {
        status: "FAIL",
        reason: dropFailure,
      },
    };
    evidence.telemetryHealth.recoveryStatus = "PASS";
    evidence.outage = {
      status: "PARTIAL",
      producerAcceptedDuringLokiOutage: true,
      lokiRecovered: true,
      collectorProcessRestarted: true,
      producerQueueDrops: evidence.outageRestart.queueDrops,
    };
    evidence.phases.outage = "PARTIAL";

    startPhase("diskRecovery");
    let lokiPressureIdentity;
    const pressureFile = "/data/loki-wal-fill";
    const lokiWriter = (script) =>
      run([
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--user",
        "10001:10001",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "64m",
        "--pids-limit",
        "16",
        "--mount",
        `type=volume,source=${storage.loki.volumeName},target=/data`,
        "--entrypoint",
        "node",
        toolchain.nodeImage,
        "-e",
        script,
        pressureFile,
      ]);
    const removeLokiPressure = () => {
      if (!lokiPressureIdentity) return;
      lokiWriter(
        `const fs=require('node:fs'),p=process.argv[1],s=fs.lstatSync(p),expected=${JSON.stringify(lokiPressureIdentity)};if(!s.isFile()||s.isSymbolicLink()||s.dev!==expected.dev||s.ino!==expected.ino)throw Error('Loki pressure file identity changed');fs.unlinkSync(p);`,
      );
      lokiPressureIdentity = undefined;
    };
    const sendLog = async (id) => {
      const now = Date.now();
      const body = {
        resourceLogs: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: `g14-pressure-${id}` },
                },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "g14-pressure" },
                logRecords: [
                  {
                    timeUnixNano: String(BigInt(now) * 1000000n),
                    body: { stringValue: JSON.stringify({ g14_run_id: id }) },
                  },
                ],
              },
            ],
          },
        ],
      };
      return fetch(new URL("/otlp/v1/logs", baseUrls.loki), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    };
    try {
      const baselineId = newRunId();
      const baselineAtUs = Date.now() * 1000;
      if (!(await sendLog(baselineId)).ok)
        throw new Error("Loki rejected baseline native write");
      await waitFor(
        async () =>
          (
            await queryLokiLogs({
              baseUrl: baseUrls.loki,
              runId: baselineId,
              startTimeUs: baselineAtUs,
            })
          ).some((record) => hasExactValue(record, baselineId)),
        {
          timeoutMs: 120000,
          intervalMs: 2000,
          description: "Loki baseline native write",
        },
      );
      const lokiConfigText = await api({
        baseUrl: baseUrls.loki,
        path: "/config",
      });
      const lokiConfig =
        typeof lokiConfigText === "string"
          ? loadYaml(lokiConfigText)
          : lokiConfigText;
      if (
        lokiConfig?.ingester?.wal?.disk_full_threshold !==
        config.telemetry.diskWatermarkPercent / 100
      )
        throw new Error(
          "Loki native WAL threshold does not match configured watermark",
        );
      const nativeWalMetrics = async () => {
        const response = await fetch(new URL("/metrics", baseUrls.loki), {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
          throw new Error(`Loki native metrics HTTP ${response.status}`);
        return parseLokiWalMetrics(
          await boundedResponseText(response, 8 * 1024 * 1024),
        );
      };
      const filesystemIdentity = () =>
        JSON.parse(
          lokiWriter(
            `const fs=require('node:fs'),s=fs.statSync('/data');process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino}));`,
          ),
        );
      const filesystemBefore = filesystemIdentity();
      const lokiGeneration = containerGeneration({
        run,
        name: containerIds.loki,
      });
      const nativeBefore = await nativeWalMetrics();
      const pressureAtUs = Date.now() * 1000;
      lokiPressureIdentity = JSON.parse(
        lokiWriter(
          `const fs=require('node:fs'),fd=fs.openSync(process.argv[1],'wx',0o600),s=fs.fstatSync(fd);fs.closeSync(fd);process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino}));`,
        ),
      );
      lokiWriter(
        `const fs=require('node:fs'),p=process.argv[1],expected=${JSON.stringify(lokiPressureIdentity)},fd=fs.openSync(p,'r+'),a=fs.fstatSync(fd);if(a.dev!==expected.dev||a.ino!==expected.ino)throw Error('Loki pressure file identity changed');const s=fs.statfsSync('/data'),n=Math.floor(s.blocks*s.bsize*0.82)-(s.blocks-s.bfree)*s.bsize;if(n<=0)throw Error('Loki disk baseline above target');const b=Buffer.alloc(1024*1024);for(let i=0;i<n;i+=b.length)fs.writeSync(fd,b,0,Math.min(b.length,n-i));fs.fsyncSync(fd);fs.closeSync(fd);`,
      );
      await waitFor(
        async () => {
          const selector =
            '{service_name="otel-collector",mountpoint="/telemetry-storage/loki"}';
          const [free, size] = await Promise.all(
            ["node_filesystem_free_bytes", "node_filesystem_size_bytes"].map(
              (name) =>
                queryPrometheusRange({
                  baseUrl: baseUrls.prometheus,
                  expression: `${name}${selector}`,
                  startTimeUs: pressureAtUs,
                }),
            ),
          );
          return free.some((sample) =>
            size.some(
              (total) =>
                total._timestamp === sample._timestamp &&
                total.device === sample.device &&
                total.value > 0 &&
                (1 - sample.value / total.value) * 100 >=
                  config.telemetry.diskWatermarkPercent,
            ),
          );
        },
        {
          timeoutMs: 120000,
          intervalMs: 2000,
          description: "Loki volume reaches configured native WAL watermark",
        },
      );

      await waitHealth("loki");
      await waitFor(
        async () =>
          (await nativeWalMetrics()).usageRatio >=
          config.telemetry.diskWatermarkPercent / 100,
        {
          timeoutMs: 60000,
          intervalMs: 2000,
          description: "fresh native Loki WAL disk-usage observation",
        },
      );
      let nativeFailure, attemptedResponse;
      try {
        const response = await sendLog(newRunId());
        attemptedResponse = response.status;
        if (!response.ok) {
          const reason = await boundedResponseText(response, 4096);
          if (response.status >= 400 && /wal|disk|throttl|space/iu.test(reason))
            nativeFailure = {
              status: response.status,
              storageReasonObserved: true,
            };
        }
      } catch (error) {
        if (!["TimeoutError", "AbortError"].includes(error?.name)) throw error;
        attemptedResponse = "TIMEOUT_UNKNOWN_ACK";
      }
      evidence.diskPressure = {
        status: "RUNNING",
        backends: {},
        requestOutcome: attemptedResponse,
      };
      if (!nativeFailure) {
        const after = await waitFor(
          async () => {
            const metrics = await nativeWalMetrics();
            return metrics.failures > nativeBefore.failures &&
              metrics.usageRatio >= config.telemetry.diskWatermarkPercent / 100
              ? metrics
              : false;
          },
          {
            timeoutMs: 60000,
            intervalMs: 2000,
            description: "native Loki WAL disk-full failure counter increment",
          },
        );
        nativeFailure = {
          counterBefore: nativeBefore.failures,
          counterAfter: after.failures,
          usageRatio: after.usageRatio,
          usagePercent: after.usageRatio * 100,
          requestOutcome: attemptedResponse,
        };
      }
      const generationAfterPressure = containerGeneration({
        run,
        name: containerIds.loki,
      });
      if (
        generationAfterPressure.id !== lokiGeneration.id ||
        generationAfterPressure.state.StartedAt !==
          lokiGeneration.state.StartedAt ||
        generationAfterPressure.state.Running !== true ||
        generationAfterPressure.state.OOMKilled === true
      )
        throw new Error(
          "Loki native disk pressure crossed a process generation",
        );
      removeLokiPressure();
      const filesystemAfter = filesystemIdentity();
      if (
        filesystemAfter.dev !== filesystemBefore.dev ||
        filesystemAfter.ino !== filesystemBefore.ino
      )
        throw new Error(
          "Loki filesystem identity changed during native recovery",
        );
      const marker = newRunId();
      const markerAtUs = Date.now() * 1000;
      await waitFor(
        async () => {
          try {
            return (await sendLog(marker)).ok;
          } catch (error) {
            if (["TimeoutError", "AbortError"].includes(error?.name))
              return false;
            throw error;
          }
        },
        {
          timeoutMs: 60000,
          intervalMs: 2000,
          description: "native Loki WAL resumes after disk relief",
        },
      );
      await waitFor(
        async () =>
          (
            await queryLokiLogs({
              baseUrl: baseUrls.loki,
              runId: marker,
              startTimeUs: markerAtUs,
            })
          ).some((record) => hasExactValue(record, marker)),
        {
          timeoutMs: 120000,
          intervalMs: 2000,
          description: "Loki native write recovers after disk relief",
        },
      );
      const generationAfterRecovery = containerGeneration({
        run,
        name: containerIds.loki,
      });
      if (
        generationAfterRecovery.id !== lokiGeneration.id ||
        generationAfterRecovery.state.StartedAt !==
          lokiGeneration.state.StartedAt ||
        generationAfterRecovery.state.Running !== true ||
        generationAfterRecovery.state.OOMKilled === true
      )
        throw new Error(
          "Loki native disk recovery crossed a process generation",
        );
      evidence.diskPressure.backends.loki = {
        status: "PASS",
        store: "loki",
        configuredPercent: config.telemetry.diskWatermarkPercent,
        nativeFailure,
        recoveryMarker: marker,
        nativeRecovery: true,
        fileIdentityChecked: true,
        sameContainerGeneration: true,
        sameFilesystem: true,
      };
      const pressureOwners = { grafana: 472, prometheus: 65534, tempo: 10001 };
      for (const name of ["grafana", "prometheus", "tempo"]) {
        const pressureEvidence = (evidence.diskPressure.backends[name] = {
          status: "RUNNING",
          responses: [],
        });
        const uid = pressureOwners[name];
        const pressurePath = `/data/${name}-native-pressure`;
        const writer = (script) =>
          run([
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--user",
            `${uid}:${uid}`,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--memory",
            "64m",
            "--pids-limit",
            "16",
            "--mount",
            `type=volume,source=${storage[name].volumeName},target=/data`,
            "--entrypoint",
            "node",
            toolchain.nodeImage,
            "-e",
            script,
            pressurePath,
          ]);
        const filesystem = () =>
          JSON.parse(
            writer(
              "const f=require('node:fs'),s=f.statSync('/data'),v=f.statfsSync('/data');process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino,bavail:v.bavail,bfree:v.bfree,bsize:v.bsize}));",
            ),
          );
        const processBefore = containerGeneration({
          run,
          name: containerIds[name],
        });
        const assertGeneration = () => {
          const current = containerGeneration({
            run,
            name: containerIds[name],
          });
          if (
            current.id !== processBefore.id ||
            current.state.StartedAt !== processBefore.state.StartedAt ||
            current.state.Running !== true ||
            current.state.OOMKilled !== false
          )
            throw new Error(`${name} pressure crossed a process generation`);
        };
        assertGeneration();
        const makeMarker = () => ({
          id: newRunId(),
          traceId: randomBytes(16).toString("hex"),
          timeMs: Date.now(),
        });
        const sendMarker = async (marker, count = 1) => {
          let endpoint, body;
          if (name === "grafana") {
            endpoint = new URL("/api/folders", baseUrls.grafana);
            body = {
              uid: `g14p${marker.id.replaceAll("-", "").slice(0, 20)}`,
              title: `G14 pressure ${marker.id}`,
            };
          } else if (name === "prometheus") {
            endpoint = new URL("/api/v1/otlp/v1/metrics", baseUrls.prometheus);
            body = {
              resourceMetrics: [
                {
                  resource: {
                    attributes: [
                      {
                        key: "service.name",
                        value: { stringValue: `g14-disk-${marker.id}` },
                      },
                    ],
                  },
                  scopeMetrics: [
                    {
                      scope: { name: "g14-disk-pressure" },
                      metrics: Array.from({ length: count }, (_, i) => ({
                        name: `g14_disk_pressure_${i}`,
                        gauge: {
                          dataPoints: [
                            {
                              timeUnixNano: String(
                                BigInt(marker.timeMs) * 1000000n,
                              ),
                              asDouble: 1,
                            },
                          ],
                        },
                      })),
                    },
                  ],
                },
              ],
            };
          } else {
            endpoint = new URL(
              `http://${new URL(baseUrls.tempo).hostname}:${new URL(config.telemetry.tempo.otlpEndpoint).port}/v1/traces`,
            );
            const at = BigInt(marker.timeMs) * 1000000n;
            body = {
              resourceSpans: [
                {
                  resource: {
                    attributes: [
                      {
                        key: "service.name",
                        value: { stringValue: "g14-disk-pressure" },
                      },
                    ],
                  },
                  scopeSpans: [
                    {
                      scope: { name: "g14-disk-pressure" },
                      spans: Array.from({ length: count }, (_, i) => ({
                        traceId: marker.traceId,
                        spanId: randomBytes(8).toString("hex"),
                        name: `g14.disk.pressure.${i}`,
                        kind: 1,
                        startTimeUnixNano: String(at),
                        endTimeUnixNano: String(at + 1000n),
                      })),
                    },
                  ],
                },
              ],
            };
          }
          const response = await fetch(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(name === "grafana" ? { authorization } : {}),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
          });
          return {
            status: response.status,
            body: await boundedResponseText(response, 4096),
          };
        };
        const verifyMarker = async (marker) => {
          if (name === "grafana") {
            const uid = `g14p${marker.id.replaceAll("-", "").slice(0, 20)}`;
            const folder = await api({
              baseUrl: baseUrls.grafana,
              authorization,
              path: `/api/folders/${uid}`,
            });
            return (
              folder?.uid === uid &&
              folder.title === `G14 pressure ${marker.id}`
            );
          }
          if (name === "prometheus") {
            const timeUs = marker.timeMs * 1000;
            const samples = await queryPrometheusRange({
              baseUrl: baseUrls.prometheus,
              expression: `g14_disk_pressure_0{service_name="g14-disk-${marker.id}"}`,
              startTimeUs: timeUs - 5000000,
              endTimeUs: Math.max(Date.now() * 1000, timeUs + 5000000),
            });
            return samples.some(
              (sample) => sample.value === 1 && sample._timestamp === timeUs,
            );
          }
          await waitForSameTraceSpans({
            baseUrl: baseUrls.tempo,
            traceId: marker.traceId,
            expectedSpanNames: { "g14-disk-pressure": ["g14.disk.pressure.0"] },
            timeoutMs: 120000,
          });
          return true;
        };
        const walFailures = async () => {
          const response = await fetch(
            new URL("/metrics", baseUrls.prometheus),
            { signal: AbortSignal.timeout(5000) },
          );
          if (!response.ok)
            throw new Error(
              `Prometheus native metrics HTTP ${response.status}`,
            );
          return parsePrometheusWalFailures(
            await boundedResponseText(response, 8 * 1024 * 1024),
          );
        };
        const hasDiskLog = (since, pattern) => {
          const result = spawnSync(
            "docker",
            ["logs", "--since", since, "--tail", "1000", containerIds[name]],
            { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
          );
          if (result.error || result.status !== 0)
            throw new Error(`${name} native log unavailable`);
          return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
            .split("\n")
            .some((line) => pattern.test(line));
        };
        let identity;
        const removePressure = () => {
          if (!identity) return;
          writer(
            `const f=require('node:fs'),p=process.argv[1],e=${JSON.stringify(identity)},s=f.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.dev!==e.dev||s.ino!==e.ino)throw Error('pressure identity changed');f.unlinkSync(p);`,
          );
          identity = undefined;
        };
        try {
          const before = makeMarker();
          const baselineResponse = await sendMarker(before);
          if (![200, 201, 202, 204].includes(baselineResponse.status))
            throw new Error(`${name} rejected baseline write`);
          await waitFor(() => verifyMarker(before), {
            timeoutMs: 120000,
            intervalMs: 2000,
            description: `${name} baseline marker`,
          });
          const fsBefore = filesystem();
          const walBefore =
            name === "prometheus" ? await walFailures() : undefined;
          Object.assign(pressureEvidence, {
            baseline: before,
            filesystemBefore: fsBefore,
            ...(name === "prometheus" ? { walBefore } : {}),
          });
          identity = JSON.parse(
            writer(
              "const f=require('node:fs'),fd=f.openSync(process.argv[1],'wx',0o600),s=f.fstatSync(fd);f.closeSync(fd);process.stdout.write(JSON.stringify({dev:s.dev,ino:s.ino}));",
            ),
          );
          const fill = JSON.parse(
            writer(
              `const f=require('node:fs'),fd=f.openSync(process.argv[1],'r+'),s=f.fstatSync(fd),e=${JSON.stringify(identity)};if(s.dev!==e.dev||s.ino!==e.ino)throw Error('pressure identity changed');const b=Buffer.alloc(1048576);let n=0,reason='';try{while(n<${config.telemetry[name].maxDiskBytes}){const k=f.writeSync(fd,b,0,Math.min(b.length,${config.telemetry[name].maxDiskBytes}-n));if(k<=0)throw Error('short write');n+=k}f.fsyncSync(fd)}catch(x){if(x.code!=='ENOSPC')throw x;reason=x.code}finally{f.closeSync(fd)}const v=f.statfsSync('/data');process.stdout.write(JSON.stringify({bytes:n,reason,bavail:v.bavail,bfree:v.bfree,bsize:v.bsize}));`,
            ),
          );
          pressureEvidence.fill = fill;
          if (fill.reason !== "ENOSPC" || fill.bavail !== 0)
            throw new Error(`${name} fixture did not reach ENOSPC`);
          const pressureAt = new Date().toISOString();
          pressureEvidence.pressureAt = pressureAt;
          let nativeFailure, walPressure;
          const attempts = name === "grafana" ? 3 : 40;
          for (let i = 0; i < attempts; i++) {
            const marker = makeMarker();
            const counterBefore =
              name === "prometheus" ? await walFailures() : undefined;
            const response = await sendMarker(
              marker,
              name === "grafana" ? 1 : 100,
            );
            pressureEvidence.responses.push(response);
            if (name === "grafana") {
              if (
                response.status === 500 &&
                hasDiskLog(
                  pressureAt,
                  /(?:database or disk is full|SQLITE_FULL)/iu,
                )
              )
                nativeFailure = { httpStatus: 500, sqliteDiskFullLog: true };
            } else if (name === "prometheus") {
              walPressure = await walFailures();
              if (walPressure > counterBefore) {
                await sleep(1000);
                const visible = await verifyMarker(marker);
                if (!visible)
                  nativeFailure = {
                    counterBefore,
                    counterAfter: walPressure,
                    marker: marker.id,
                    markerVisible: false,
                    httpStatus: response.status,
                    backendErrno: "NOT_OBSERVED",
                  };
              }
            } else if (
              hasDiskLog(
                pressureAt,
                /(?:\/var\/tempo\/(?:live-wal|wal)\/.*no space left on device|no space left on device.*\/var\/tempo\/(?:live-wal|wal)\/)/iu,
              )
            ) {
              nativeFailure = {
                walDiskFullLog: true,
                httpStatus: response.status,
              };
            }
            const fsPressure = filesystem();
            pressureEvidence.filesystemPressure = fsPressure;
            if (nativeFailure) pressureEvidence.nativeFailure = nativeFailure;
            if (
              fsPressure.dev !== fsBefore.dev ||
              fsPressure.ino !== fsBefore.ino
            )
              throw new Error(
                `${name} filesystem identity changed during pressure`,
              );
            // Native rollback can release blocks before the pressure file is removed.
            if (!nativeFailure && fsPressure.bavail !== 0)
              throw new Error(
                `${name} filesystem pressure ended before a native storage failure`,
              );
            assertGeneration();
            if (nativeFailure) break;
            await sleep(1000);
          }
          if (!nativeFailure)
            throw new Error(
              `${name} native storage failure not observed within bounded attempts`,
            );
          if (name === "prometheus") walPressure = await walFailures();
          removePressure();
          const fsAfter = filesystem();
          if (
            fsAfter.dev !== fsBefore.dev ||
            fsAfter.ino !== fsBefore.ino ||
            fsAfter.bavail <= 0
          )
            throw new Error(`${name} filesystem identity or relief invalid`);
          const after = makeMarker();
          const recoveredResponse = await sendMarker(after);
          if (![200, 201, 202, 204].includes(recoveredResponse.status))
            throw new Error(`${name} rejected recovery write`);
          await waitFor(() => verifyMarker(after), {
            timeoutMs: 120000,
            intervalMs: 2000,
            description: `${name} recovery marker`,
          });
          await waitFor(() => verifyMarker(before), {
            timeoutMs: 120000,
            intervalMs: 2000,
            description: `${name} baseline retained`,
          });
          assertGeneration();
          const walAfter =
            name === "prometheus" ? await walFailures() : undefined;
          if (name === "prometheus" && walAfter !== walPressure)
            throw new Error(
              "Prometheus WAL failure counter did not stabilize after relief",
            );
          Object.assign(pressureEvidence, {
            status: "PASS",
            nativeFailure,
            recoveryMarker: after,
            filesystemAfter: fsAfter,
            sameContainerGeneration: true,
            backendErrno: name === "prometheus" ? "NOT_OBSERVED" : undefined,
            ...(name === "prometheus" ? { walPressure, walAfter } : {}),
          });
        } catch (error) {
          Object.assign(pressureEvidence, {
            status: "FAIL",
            failure: cleanError(error),
          });
          throw error;
        } finally {
          try {
            removePressure();
          } catch (error) {
            cleanupErrors.push(
              `${name} pressure cleanup: ${cleanError(error)}`,
            );
          }
        }
      }
      evidence.diskPressure.status = "PASS";
      evidence.diskPressureStatus = "PASS";
      evidence.phases.diskRecovery = "PASS";
    } catch (error) {
      evidence.phases.diskRecovery = "FAIL";
      evidence.diskPressureStatus = "FAIL";
      evidence.diskRecoveryFailure = cleanError(error);
      evidence.diskPressure = {
        ...evidence.diskPressure,
        status: "FAIL",
        failure: evidence.diskRecoveryFailure,
      };
    } finally {
      removeLokiPressure();
    }

    startPhase("persistence");
    const producerBefore = containerGeneration({ run, name: producerName });
    const producerBeforeDiagnostics = await fixtureDiagnostics(producerUrl);
    if (
      producerBeforeDiagnostics.dropped <= 0 ||
      producerBeforeDiagnostics.exportFailures <= 0
    )
      throw new Error(
        "producer loss counters were not positive before restart",
      );
    const producerBeforeUs = startedAtUs(producerBefore.state);
    const beforeStart = await waitForProcessMetric({
      baseUrl: baseUrls.prometheus,
      stream: "runtime_process_start_time_seconds",
      service: "g14-synthetic",
      afterUs: producerBeforeUs,
      description: "producer start time before restart",
    });
    for (const metric of [
      "telemetry_records_dropped_total",
      "telemetry_export_failures_total",
    ]) {
      const sample = await waitForProcessMetric({
        baseUrl: baseUrls.prometheus,
        stream: metric,
        service: "g14-synthetic",
        afterUs: producerBeforeUs,
        description: `producer loss counter ${metric} before restart`,
      });
      if (sample.value <= 0)
        throw new Error(`producer loss metric ${metric} was not positive`);
    }
    run(["restart", producerName]);
    await waitFor(
      async () =>
        (
          await fetch(new URL(config.platform.health.readyPath, producerUrl), {
            signal: AbortSignal.timeout(1000),
          })
        ).ok,
      {
        timeoutMs: 30000,
        intervalMs: 500,
        description: "producer readiness after restart",
      },
    );
    const producerAfter = containerGeneration({ run, name: producerName });
    const producerAfterUs = startedAtUs(producerAfter.state);
    const producerAfterDiagnostics = await fixtureDiagnostics(producerUrl);
    if (
      producerAfter.id !== producerBefore.id ||
      producerAfterUs <= producerBeforeUs ||
      producerAfterDiagnostics.processStartTimeSeconds <=
        producerBeforeDiagnostics.processStartTimeSeconds ||
      Object.values(producerAfterDiagnostics.counters).some(
        (value) => value !== 0,
      )
    )
      throw new Error("producer process loss counters did not reset");
    await fixtureRequest({ baseUrl: producerUrl, runId });
    const afterStart = await waitForProcessMetric({
      baseUrl: baseUrls.prometheus,
      stream: "runtime_process_start_time_seconds",
      service: "g14-synthetic",
      afterUs: producerAfterUs,
      description: "producer start time after restart",
    });
    if (
      afterStart.value <= beforeStart.value ||
      Math.abs(
        afterStart.value - producerAfterDiagnostics.processStartTimeSeconds,
      ) > 0.001
    )
      throw new Error("producer metric did not identify the new process");
    evidence.processCounterRestart = {
      status: "PASS",
      beforeStartTimeSeconds: beforeStart.value,
      afterStartTimeSeconds: afterStart.value,
      beforeCounters: producerBeforeDiagnostics.counters,
      afterCounters: producerAfterDiagnostics.counters,
    };
    await configureCollector(logFiles);
    if ((await checkpointRecords()).length !== 1)
      throw new Error("Alloy recreation replayed the checkpoint marker");
    const beforeCrash = containerGeneration({
      run,
      name: containerIds["otel-collector"],
    });
    run(["kill", "--signal", "KILL", containerIds["otel-collector"]]);
    const crashed = containerGeneration({
      run,
      name: containerIds["otel-collector"],
    });
    if (crashed.state.Running !== true)
      run(["start", containerIds["otel-collector"]]);
    await waitFor(
      async () => {
        const current = containerGeneration({
          run,
          name: containerIds["otel-collector"],
        });
        return (
          current.state.Running === true &&
          startedAtUs(current.state) > startedAtUs(beforeCrash.state)
        );
      },
      {
        timeoutMs: 60000,
        intervalMs: 1000,
        description: "Alloy recovery after abrupt process crash",
      },
    );
    await waitHealth("otel-collector");
    const crashMarker = newRunId();
    const crashMarkerAtUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId: crashMarker });
    await waitFor(
      async () =>
        (
          await queryLokiLogs({
            baseUrl: baseUrls.loki,
            runId: crashMarker,
            startTimeUs: crashMarkerAtUs,
          })
        ).some((record) => hasExactValue(record, crashMarker)),
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "filelog continues after Alloy crash",
      },
    );
    evidence.telemetryHealth.collectorFilelogCheckpoint.recreation = "PASS";
    evidence.telemetryHealth.collectorFilelogCheckpoint.crashRecovery = "PASS";
    evidence.telemetryHealth.collectorFilelogCheckpoint.abruptCrashExactlyOnce =
      "NOT_CLAIMED";
    if (
      evidence.collectorQueueMetrics?.status === "PASS" &&
      collectorExpiredRetryDrop?.status === "PASS"
    ) {
      evidence.outage.status = "PASS";
      evidence.phases.outage = "PASS";
    }
    const persistenceId = newRunId();
    const persistenceAtUs = Date.now() * 1000;
    await fixtureRequest({ baseUrl: producerUrl, runId: persistenceId });
    const persistenceLogs = () =>
      queryLokiLogs({
        baseUrl: baseUrls.loki,
        runId: persistenceId,
        startTimeUs: persistenceAtUs,
      });
    await waitFor(
      async () =>
        (await persistenceLogs()).some((record) =>
          hasExactValue(record, persistenceId),
        ),
      {
        timeoutMs: 120000,
        intervalMs: 2000,
        description: "unique Loki persistence marker before restart",
      },
    );
    const producerStop = stopContainerGracefully({
      run,
      name: producerName,
      graceMs: config.platform.shutdownGraceMs,
    });
    if (producerStop.status !== "PASS")
      throw new Error("synthetic producer graceful stop failed");
    evidence.telemetryHealth.infrastructureGracefulStops = {
      collector: stoppedCollector,
      lokiOutage: stoppedLoki,
    };
    assertGrafanaGeneration(
      grafanaGeneration,
      JSON.parse(run(["inspect", containerIds.grafana]))[0],
    );
    for (const name of ["grafana", "loki", "prometheus", "tempo"]) {
      const stopped = stopContainerGracefully({
        run,
        name: containerIds[name],
        graceMs: config.platform.shutdownGraceMs,
      });
      evidence.telemetryHealth.infrastructureGracefulStops[name] = stopped;
      if (stopped.status !== "PASS")
        throw new Error(`${name} graceful stop failed`);
      run(["start", containerIds[name]]);
      await waitHealth(name);
    }
    const persistedLogs = await persistenceLogs();
    if (!persistedLogs.some((record) => hasExactValue(record, persistenceId)))
      throw new Error("Loki did not retain exact marker after restart");
    await waitForSameTraceSpans({
      baseUrl: baseUrls.tempo,
      traceId,
      expectedSpanNames: { "g14-synthetic": ["HTTP POST"] },
      timeoutMs: 120000,
    });
    const persistedMetrics = await queryPrometheusRange({
      baseUrl: baseUrls.prometheus,
      expression: 'runtime_ready{service_name="g14-synthetic"}',
      startTimeUs,
    });
    if (
      !persistedMetrics.some(
        (item) =>
          item._timestamp === metric._timestamp && item.value === metric.value,
      )
    )
      throw new Error(
        "Prometheus did not retain the same metric sample after restart",
      );
    const persistedFolder = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: `/api/folders/${folderUid}`,
    });
    if (
      persistedFolder?.uid !== folderUid ||
      persistedFolder?.title !== `G14 ${runId}`
    )
      throw new Error("Grafana fixture data missing after restart");
    const persistedDatasources = await api({
      baseUrl: baseUrls.grafana,
      authorization,
      path: "/api/datasources",
    });
    if (
      !Array.isArray(persistedDatasources) ||
      ["loki", "prometheus", "tempo"].some(
        (uid) => !persistedDatasources.some((item) => item.uid === uid),
      )
    )
      throw new Error("Grafana datasources missing after restart");
    evidence.persistence = {
      status: "PASS",
      exactTraceId: traceId,
      exactMetricTimestampUs: metric._timestamp,
      exactRunId: persistenceId,
      grafanaFolderUid: folderUid,
      grafanaDatasourceUids: ["loki", "prometheus", "tempo"],
    };
    evidence.phases.persistence = "PASS";
    startPhase("backupRestore");
    // Backends are stopped together so the archives represent one quiescent fixture.
    const backupNames = ["grafana", "loki", "prometheus", "tempo"];
    const originalVolumes = structuredClone(fixtureCompose.volumes);
    let backendStopStarted = false;
    let backupRestorationError;
    try {
      backupDir = await mkdtemp(join(tmpdir(), `${project}-backup-`));
      const restoreProject = `coffee-observability-${newRunId()}`;
      for (const name of backupNames) {
        const volumeName = `${restoreProject}-${name}-data`;
        const backingDirectory = join(storageRoot, volumeName);
        await mkdir(backingDirectory, { mode: 0o700 });
        storageDirectories.push(backingDirectory);
        restoreStorage[name] = provisionStorage({
          name: volumeName,
          maxDiskBytes: config.telemetry[name].maxDiskBytes,
          storageHelperImage: storageHelper.imageId,
          backingDirectory,
          run,
        });
      }
      backendStopStarted = true;
      for (const name of ["otel-collector", ...backupNames]) {
        const stopped = stopContainerGracefully({
          run,
          name: containerIds[name],
          graceMs: config.platform.shutdownGraceMs,
        });
        if (stopped.status !== "PASS")
          throw new Error(`${name} did not stop for telemetry backup`);
      }
      for (const name of backupNames) {
        // Cap each private archive to twice its source quota, including tar metadata.
        const blocks = Math.ceil(
          (2 * config.telemetry[name].maxDiskBytes) / 512,
        );
        run([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "DAC_OVERRIDE",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "128m",
          "--pids-limit",
          "32",
          "--mount",
          `type=volume,source=${storage[name].volumeName},target=/source,readonly`,
          "--mount",
          `type=bind,source=${backupDir},target=/backup`,
          storageHelper.imageId,
          "sh",
          "-ceu",
          'umask 077; ulimit -f "$1"; tar -cpf "/backup/$2.tar" -C /source .',
          "backup",
          String(blocks),
          name,
        ]);
        run([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "CHOWN",
          "--cap-add",
          "FOWNER",
          "--cap-add",
          "DAC_OVERRIDE",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "128m",
          "--pids-limit",
          "32",
          "--mount",
          `type=volume,source=${restoreStorage[name].volumeName},target=/restore`,
          "--mount",
          `type=bind,source=${backupDir},target=/backup,readonly`,
          storageHelper.imageId,
          "sh",
          "-ceu",
          'tar -xpf "/backup/$1.tar" -C /restore',
          "restore",
          name,
        ]);
        fixtureCompose.volumes[`${name}_data`].name =
          restoreStorage[name].volumeName;
      }
      await writeFile(
        composeFile,
        dumpYaml(fixtureCompose, { noRefs: true, lineWidth: 120 }),
        { mode: 0o600 },
      );
      compose([
        "up",
        "-d",
        "--no-deps",
        "--force-recreate",
        ...backupNames,
        "otel-collector",
      ]);
      for (const name of [...backupNames, "otel-collector"]) {
        containerIds[name] = compose(["ps", "--quiet", name]).trim();
        if (!/^[a-f0-9]{12,64}$/u.test(containerIds[name]))
          throw new Error(`${name} restored container identity unavailable`);
        const info = JSON.parse(run(["inspect", containerIds[name]]))[0];
        const ip = info?.NetworkSettings?.Networks?.[backendNetwork]?.IPAddress;
        if (!ip)
          throw new Error(`${name} restored network identity unavailable`);
        const endpoint =
          name === "otel-collector"
            ? config.telemetry.collector.healthEndpoint
            : config.telemetry[name].endpoint;
        baseUrls[name] = `http://${ip}:${new URL(endpoint).port}`;
        await waitHealth(name);
      }
      await waitFor(
        async () =>
          (await persistenceLogs()).some((record) =>
            hasExactValue(record, persistenceId),
          ),
        {
          timeoutMs: 120000,
          intervalMs: 2000,
          description: "Loki marker after backup restore",
        },
      );
      await waitForSameTraceSpans({
        baseUrl: baseUrls.tempo,
        traceId,
        expectedSpanNames: { "g14-synthetic": ["HTTP POST"] },
        timeoutMs: 120000,
      });
      const restoredMetrics = await queryPrometheusRange({
        baseUrl: baseUrls.prometheus,
        expression: 'runtime_ready{service_name="g14-synthetic"}',
        startTimeUs,
      });
      if (
        !restoredMetrics.some(
          (item) =>
            item._timestamp === metric._timestamp &&
            item.value === metric.value,
        )
      )
        throw new Error("Prometheus marker missing after backup restore");
      const restoredFolder = await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: `/api/folders/${folderUid}`,
      });
      if (
        restoredFolder?.uid !== folderUid ||
        restoredFolder?.title !== `G14 ${runId}`
      )
        throw new Error("Grafana folder missing after backup restore");
      const restoredDatasources = await api({
        baseUrl: baseUrls.grafana,
        authorization,
        path: "/api/datasources",
      });
      if (
        !Array.isArray(restoredDatasources) ||
        ["loki", "prometheus", "tempo"].some(
          (uid) => !restoredDatasources.some((item) => item.uid === uid),
        )
      )
        throw new Error("Grafana datasources missing after backup restore");
      for (const rule of definitions) {
        const actual = await api({
          baseUrl: baseUrls.grafana,
          authorization,
          path: `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.name)}`,
        });
        if (
          actual?.uid !== rule.name ||
          actual?.title !== rule.name ||
          durationMilliseconds(actual?.for) !== rule.forMs ||
          actual?.data?.find((item) => item.refId === "A")?.model?.expr !==
            rule.query
        )
          throw new Error(
            `Grafana rule ${rule.name} missing or changed after backup restore`,
          );
      }
      evidence.backupRestore = {
        status: "PASS",
        exactRunId: persistenceId,
        exactTraceId: traceId,
        exactMetricTimestampUs: metric._timestamp,
        grafanaFolderUid: folderUid,
        restoredVolumes: Object.fromEntries(
          backupNames.map((name) => [name, restoreStorage[name].volumeName]),
        ),
      };
      evidence.phases.backupRestore = "PASS";
    } finally {
      try {
        fixtureCompose.volumes = originalVolumes;
        if (backendStopStarted) {
          await writeFile(
            composeFile,
            dumpYaml(fixtureCompose, { noRefs: true, lineWidth: 120 }),
            { mode: 0o600 },
          );
          compose([
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            ...backupNames,
            "otel-collector",
          ]);
          for (const name of [...backupNames, "otel-collector"]) {
            containerIds[name] = compose(["ps", "--quiet", name]).trim();
            const info = JSON.parse(run(["inspect", containerIds[name]]))[0];
            const ip =
              info?.NetworkSettings?.Networks?.[backendNetwork]?.IPAddress;
            if (!/^[a-f0-9]{12,64}$/u.test(containerIds[name]) || !ip) {
              backupRestorationError ??= new Error(
                `${name} original container identity unavailable after restore proof`,
              );
            } else {
              const endpoint =
                name === "otel-collector"
                  ? config.telemetry.collector.healthEndpoint
                  : config.telemetry[name].endpoint;
              baseUrls[name] = `http://${ip}:${new URL(endpoint).port}`;
              await waitHealth(name);
            }
          }
        }
      } catch (error) {
        backupRestorationError ??= error;
      }
      if (backupRestorationError)
        cleanupErrors.push(
          "backup restore: " + cleanError(backupRestorationError),
        );
    }
    if (backupRestorationError) throw backupRestorationError;
    evidence.runtimeShutdownStatus = "PASS";
    evidence.runtimeShutdown = {
      status: "PASS",
      producer: producerStop,
      infrastructure: evidence.telemetryHealth.infrastructureGracefulStops,
    };
    startPhase("retention");
    try {
      const readEffective = async () => {
        const [lokiText, tempoText, flags] = await Promise.all([
          api({ baseUrl: baseUrls.loki, path: "/config" }),
          api({ baseUrl: baseUrls.tempo, path: "/status/config" }),
          api({ baseUrl: baseUrls.prometheus, path: "/api/v1/status/flags" }),
        ]);
        const lokiEffective =
          typeof lokiText === "string" ? loadYaml(lokiText) : lokiText;
        const tempoEffective = parseTempoStatusConfigResponse(tempoText);
        return {
          lokiMs: durationMilliseconds(
            lokiEffective?.limits_config?.retention_period,
          ),
          prometheusMs: durationMilliseconds(
            flags?.data?.["storage.tsdb.retention.time"],
          ),
          tempoMs: durationMilliseconds(
            tempoEffective?.backend_worker?.compaction?.block_retention,
          ),
        };
      };
      const expectedEffective = {
        lokiMs: config.telemetry.loki.retentionDays * 86400000,
        prometheusMs: config.telemetry.prometheus.retentionDays * 86400000,
        tempoMs: config.telemetry.tempo.retentionDays * 86400000,
      };
      const actualEffective = await readEffective();
      if (
        Object.keys(expectedEffective).some(
          (key) => actualEffective[key] !== expectedEffective[key],
        )
      )
        throw new Error(
          "backend effective production retention differs from configured days",
        );
      const configSourceSha256 = createHash("sha256")
        .update(await readFile(join(root, "config/platform.yaml")))
        .digest("hex");
      const schemaSourceSha256 = createHash("sha256")
        .update(await readFile(join(root, "config/platform.schema.json")))
        .digest("hex");
      const profileHash = (value) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const recreateBackend = async (name) => {
        compose(["up", "-d", "--no-deps", "--force-recreate", name]);
        containerIds[name] = compose(["ps", "--quiet", name]).trim();
        if (!/^[a-f0-9]{12,64}$/u.test(containerIds[name]))
          throw new Error(`${name} recreation identity unavailable`);
        const info = JSON.parse(run(["inspect", containerIds[name]]))[0];
        const address =
          info?.NetworkSettings?.Networks?.[backendNetwork]?.IPAddress;
        if (!/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(address ?? ""))
          throw new Error(`${name} recreation address unavailable`);
        baseUrls[name] =
          `http://${address}:${new URL(config.telemetry[name].endpoint).port}`;
        await waitHealth(name);
      };
      const retentionRestorers = [];
      const retentionObservers = [];
      const retentionRestoreErrors = [];
      let retentionOperationError;
      let cancelObservation = false;
      const observeRetention = (task) => {
        const tracked = task.then(
          () => ({ status: "PASS" }),
          (error) => {
            cancelObservation = true;
            return { status: "FAIL", error };
          },
        );
        retentionObservers.push(tracked);
      };
      evidence.retention = {
        status: "RUNNING",
        productionEffective: actualEffective,
        loki: "NOT_RUN",
        prometheus: "NOT_RUN",
        tempo: "NOT_RUN",
      };
      try {
        const originalLokiConfig = configs.loki;
        const originalLokiBytes = await readFile(backendConfigPaths.loki);
        const originalLokiHash = createHash("sha256")
          .update(originalLokiBytes)
          .digest("hex");
        const lokiProfile = structuredClone(originalLokiConfig);
        lokiProfile.ingester.chunk_idle_period = "10s";
        lokiProfile.ingester.flush_check_period = "5s";
        lokiProfile.compactor.compaction_interval = "30s";
        lokiProfile.compactor.retention_delete_delay = "30s";
        lokiProfile.chunk_store_config ??= {};
        lokiProfile.chunk_store_config.chunk_cache_config ??= {};
        lokiProfile.chunk_store_config.chunk_cache_config.embedded_cache ??= {};
        lokiProfile.chunk_store_config.chunk_cache_config.embedded_cache.enabled = true;
        lokiProfile.chunk_store_config.chunk_cache_config.embedded_cache.ttl =
          "30s";
        const readLokiKnobs = async () => {
          const text = await api({ baseUrl: baseUrls.loki, path: "/config" });
          const actual = typeof text === "string" ? loadYaml(text) : text;
          return {
            retention: durationMilliseconds(
              actual?.limits_config?.retention_period,
            ),
            chunkIdle: durationMilliseconds(
              actual?.ingester?.chunk_idle_period,
            ),
            flushCheck: durationMilliseconds(
              actual?.ingester?.flush_check_period,
            ),
            compaction: durationMilliseconds(
              actual?.compactor?.compaction_interval,
            ),
            deleteDelay: durationMilliseconds(
              actual?.compactor?.retention_delete_delay,
            ),
            chunkCacheTtl: durationMilliseconds(
              actual?.chunk_store_config?.chunk_cache_config?.embedded_cache
                ?.ttl,
            ),
            chunkCacheEnabled:
              actual?.chunk_store_config?.chunk_cache_config?.embedded_cache
                ?.enabled === true,
            retentionEnabled: actual?.compactor?.retention_enabled,
          };
        };
        const originalLokiKnobs = await readLokiKnobs();
        if (
          Object.entries(originalLokiKnobs).some(([key, value]) =>
            key === "retentionEnabled" || key === "chunkCacheEnabled"
              ? typeof value !== "boolean"
              : !Number.isSafeInteger(value) || value < 0,
          )
        )
          throw new Error("Loki original retention cadence is unavailable");
        const writeLokiConfig = async (value) => {
          await rm(backendConfigPaths.loki);
          await writeFile(
            backendConfigPaths.loki,
            dumpYaml(value, { noRefs: true, lineWidth: 120 }),
            { mode: 0o444 },
          );
        };
        const lokiStagingProfile = structuredClone(lokiProfile);
        lokiStagingProfile.compactor.retention_enabled = false;
        let lokiRestorationError;
        retentionRestorers.push(async () => {
          try {
            await writeLokiConfig(originalLokiConfig);
            await recreateBackend("loki");
            const restoredLokiKnobs = await readLokiKnobs();
            if (
              Object.keys(originalLokiKnobs).some(
                (key) => restoredLokiKnobs[key] !== originalLokiKnobs[key],
              ) ||
              createHash("sha256")
                .update(await readFile(backendConfigPaths.loki))
                .digest("hex") !== originalLokiHash
            )
              lokiRestorationError = new Error(
                "Loki production retention restoration failed",
              );
          } catch (error) {
            lokiRestorationError ??= error;
          }
          if (lokiRestorationError)
            cleanupErrors.push(
              "Loki retention restore: " + cleanError(lokiRestorationError),
            );
          if (lokiRestorationError)
            retentionRestoreErrors.push(lokiRestorationError);
        });
        await writeLokiConfig(lokiStagingProfile);
        await recreateBackend("loki");
        const activeLoki = await readLokiKnobs();
        const expectedLoki = {
          retention: expectedEffective.lokiMs,
          chunkIdle: 10000,
          flushCheck: 5000,
          compaction: 30000,
          deleteDelay: 30000,
          chunkCacheTtl: 30000,
          chunkCacheEnabled: true,
          retentionEnabled: false,
        };
        if (
          Object.keys(expectedLoki).some(
            (key) => activeLoki[key] !== expectedLoki[key],
          )
        )
          throw new Error("Loki fixture staging profile was not effective");
        const retentionId = newRunId();
        const sampleMs =
          Date.now() -
          (config.telemetry.loki.retentionDays + 1) * 24 * 60 * 60 * 1000;
        const sampleUs = sampleMs * 1000;
        const selectorStartUs = sampleUs - 60 * 1000000;
        const selectorEndUs = sampleUs + 60 * 1000000;
        const body = {
          resourceLogs: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: `g14-retention-${retentionId}` },
                  },
                  {
                    key: "service.namespace",
                    value: { stringValue: config.telemetry.namespace },
                  },
                  {
                    key: "service.version",
                    value: { stringValue: config.telemetry.releaseDigest },
                  },
                  {
                    key: "deployment.environment",
                    value: { stringValue: config.environment },
                  },
                ],
              },
              scopeLogs: [
                {
                  scope: { name: "g14-retention" },
                  logRecords: [
                    {
                      timeUnixNano: String(BigInt(sampleMs) * 1000000n),
                      observedTimeUnixNano: String(BigInt(sampleMs) * 1000000n),
                      body: {
                        stringValue: JSON.stringify({
                          g14_run_id: retentionId,
                          retention_marker: true,
                        }),
                      },
                    },
                  ],
                },
              ],
            },
          ],
        };
        await api({
          baseUrl: baseUrls.loki,
          path: "/otlp/v1/logs",
          method: "POST",
          body,
          expected: [200, 204],
        });
        const oldLogs = () =>
          queryLokiLogs({
            baseUrl: baseUrls.loki,
            runId: retentionId,
            startTimeUs: selectorStartUs,
            endTimeUs: selectorEndUs,
          });
        await waitFor(
          async () =>
            (await oldLogs()).some((record) =>
              hasExactValue(record, retentionId),
            ),
          {
            timeoutMs: 120000,
            intervalMs: 2000,
            description: "Loki backdated retention marker visible",
          },
        );
        // The native flush queues chunks; a clean restart also builds the TSDB head
        // immediately instead of waiting for the fixed 15-minute rotation period.
        await api({
          baseUrl: baseUrls.loki,
          path: "/flush",
          method: "POST",
          expected: [204],
        });
        const lokiFlushStop = stopContainerGracefully({
          run,
          name: containerIds.loki,
          graceMs: config.platform.shutdownGraceMs,
        });
        if (lokiFlushStop.status !== "PASS")
          throw new Error("Loki failed graceful shutdown after native flush");
        run(["start", containerIds.loki]);
        await waitHealth("loki");
        await waitFor(
          async () =>
            (await oldLogs()).some((record) =>
              hasExactValue(record, retentionId),
            ),
          {
            timeoutMs: 120000,
            intervalMs: 2000,
            description:
              "Loki flushed retention marker visible before cleanup activation",
          },
        );
        const originalPrometheusCommand = [...services.prometheus.command];
        const originalFlags = (
          await api({
            baseUrl: baseUrls.prometheus,
            path: "/api/v1/status/flags",
          })
        )?.data;
        const profileFlagNames = [
          "storage.tsdb.retention.time",
          "storage.tsdb.min-block-duration",
          "storage.tsdb.max-block-duration",
        ];
        if (
          profileFlagNames.some(
            (name) =>
              !Number.isSafeInteger(
                durationMilliseconds(originalFlags?.[name]),
              ),
          )
        )
          throw new Error(
            "Prometheus original retention cadence is unavailable",
          );
        const prometheusProfile = originalPrometheusCommand.filter(
          (arg) => !arg.startsWith("--storage.tsdb.retention.time="),
        );
        prometheusProfile.push(
          "--storage.tsdb.retention.time=2m",
          "--storage.tsdb.min-block-duration=1m",
          "--storage.tsdb.max-block-duration=1m",
        );
        evidence.retention.productionEffective = actualEffective;
        const saveCompose = () =>
          writeFile(
            composeFile,
            dumpYaml(fixtureCompose, { noRefs: true, lineWidth: 120 }),
            { mode: 0o600 },
          );
        let prometheusRestorationError;
        retentionRestorers.push(async () => {
          try {
            services.prometheus.command = originalPrometheusCommand;
            await saveCompose();
            await recreateBackend("prometheus");
            const restoredFlags = (
              await api({
                baseUrl: baseUrls.prometheus,
                path: "/api/v1/status/flags",
              })
            )?.data;
            const restoredCompose = loadYaml(
              await readFile(composeFile, "utf8"),
            );
            if (
              profileFlagNames.some(
                (name) =>
                  durationMilliseconds(restoredFlags?.[name]) !==
                  durationMilliseconds(originalFlags[name]),
              ) ||
              profileHash(restoredCompose?.services?.prometheus?.command) !==
                profileHash(originalPrometheusCommand)
            )
              prometheusRestorationError = new Error(
                "Prometheus production retention restoration failed",
              );
          } catch (error) {
            prometheusRestorationError ??= error;
          }
          if (prometheusRestorationError)
            cleanupErrors.push(
              "Prometheus retention restore: " +
                cleanError(prometheusRestorationError),
            );
          if (prometheusRestorationError)
            retentionRestoreErrors.push(prometheusRestorationError);
        });
        services.prometheus.command = prometheusProfile;
        await saveCompose();
        await recreateBackend("prometheus");
        const activeFlags = (
          await api({
            baseUrl: baseUrls.prometheus,
            path: "/api/v1/status/flags",
          })
        )?.data;
        if (
          durationMilliseconds(activeFlags?.["storage.tsdb.retention.time"]) !==
            120000 ||
          durationMilliseconds(
            activeFlags?.["storage.tsdb.min-block-duration"],
          ) !== 60000 ||
          durationMilliseconds(
            activeFlags?.["storage.tsdb.max-block-duration"],
          ) !== 60000
        )
          throw new Error(
            "Prometheus fixture retention profile was not effective",
          );
        const originalTempoConfig = configs.tempo;
        const tempoProfile = structuredClone(originalTempoConfig);
        tempoProfile.backend_worker.compaction.block_retention = "2m";
        tempoProfile.backend_scheduler.provider = {
          retention: { interval: "30s" },
        };
        tempoProfile.live_store.max_block_duration = "30s";
        tempoProfile.live_store.complete_block_timeout = "1m";
        tempoProfile.live_store.flush_op_timeout = "30s";
        tempoProfile.live_store.block_reclaim_grace = "1m";
        tempoProfile.storage.trace.blocklist_poll = "30s";
        tempoProfile.query_frontend = { search: { query_backend_after: "1m" } };
        const originalTempoBytes = await readFile(backendConfigPaths.tempo);
        const originalTempoHash = createHash("sha256")
          .update(originalTempoBytes)
          .digest("hex");
        const readTempoKnobs = async () => {
          const text = await api({
            baseUrl: baseUrls.tempo,
            path: "/status/config",
          });
          const actual = parseTempoStatusConfigResponse(text);
          return {
            retention: durationMilliseconds(
              actual?.backend_worker?.compaction?.block_retention,
            ),
            interval: durationMilliseconds(
              actual?.backend_scheduler?.provider?.retention?.interval,
            ),
            maxBlock: durationMilliseconds(
              actual?.live_store?.max_block_duration,
            ),
            complete: durationMilliseconds(
              actual?.live_store?.complete_block_timeout,
            ),
            cleanup: durationMilliseconds(actual?.live_store?.flush_op_timeout),
            reclaim: durationMilliseconds(
              actual?.live_store?.block_reclaim_grace,
            ),
            poll: durationMilliseconds(actual?.storage?.trace?.blocklist_poll),
            queryAfter: durationMilliseconds(
              actual?.query_frontend?.search?.query_backend_after,
            ),
          };
        };
        const originalTempoKnobs = await readTempoKnobs();
        if (
          Object.values(originalTempoKnobs).some(
            (value) => !Number.isSafeInteger(value) || value <= 0,
          )
        )
          throw new Error("Tempo original retention cadence is unavailable");
        const writeTempoConfig = async (value) => {
          await rm(backendConfigPaths.tempo);
          await writeFile(
            backendConfigPaths.tempo,
            dumpYaml(value, { noRefs: true, lineWidth: 120 }),
            { mode: 0o444 },
          );
        };
        let tempoRestorationError;
        retentionRestorers.push(async () => {
          try {
            await writeTempoConfig(originalTempoConfig);
            await recreateBackend("tempo");
            const restoredTempoKnobs = await readTempoKnobs();
            if (
              Object.keys(originalTempoKnobs).some(
                (key) => restoredTempoKnobs[key] !== originalTempoKnobs[key],
              ) ||
              createHash("sha256")
                .update(await readFile(backendConfigPaths.tempo))
                .digest("hex") !== originalTempoHash
            )
              tempoRestorationError = new Error(
                "Tempo production retention restoration failed",
              );
          } catch (error) {
            tempoRestorationError ??= error;
          }
          if (tempoRestorationError)
            cleanupErrors.push(
              "Tempo retention restore: " + cleanError(tempoRestorationError),
            );
          if (tempoRestorationError)
            retentionRestoreErrors.push(tempoRestorationError);
        });
        await writeTempoConfig(tempoProfile);
        await recreateBackend("tempo");
        const activeTempo = await readTempoKnobs();
        const expectedTempo = {
          retention: 120000,
          interval: 30000,
          maxBlock: 30000,
          complete: 60000,
          cleanup: 30000,
          reclaim: 60000,
          poll: 30000,
          queryAfter: 60000,
        };
        if (
          Object.keys(expectedTempo).some(
            (key) => activeTempo[key] !== expectedTempo[key],
          )
        )
          throw new Error("Tempo fixture retention profile was not effective");
        const otlpUrl = `http://${new URL(baseUrls.tempo).hostname}:${new URL(config.telemetry.tempo.otlpEndpoint).port}`;
        const putTrace = async (name) => {
          const id = randomBytes(16).toString("hex");
          const now = Date.now();
          const data = {
            resourceSpans: [
              {
                resource: {
                  attributes: [
                    {
                      key: "service.name",
                      value: { stringValue: "g14-retention" },
                    },
                  ],
                },
                scopeSpans: [
                  {
                    scope: { name: "g14-retention" },
                    spans: [
                      {
                        traceId: id,
                        spanId: randomBytes(8).toString("hex"),
                        name,
                        kind: 1,
                        startTimeUnixNano: String(BigInt(now) * 1000000n),
                        endTimeUnixNano: String(BigInt(now) * 1000000n + 1000n),
                      },
                    ],
                  },
                ],
              },
            ],
          };
          await api({
            baseUrl: otlpUrl,
            path: "/v1/traces",
            method: "POST",
            body: data,
            expected: [200, 202, 204],
          });
          return id;
        };
        await waitFor(
          async () =>
            (await oldLogs()).some((record) =>
              hasExactValue(record, retentionId),
            ),
          {
            timeoutMs: 120000,
            intervalMs: 2000,
            description:
              "Loki flushed marker remains visible before retention activation",
          },
        );
        const retentionActivatedAtMs = Date.now();
        await writeLokiConfig(lokiProfile);
        await recreateBackend("loki");
        expectedLoki.retentionEnabled = true;
        const retentionLoki = await readLokiKnobs();
        if (
          Object.keys(expectedLoki).some(
            (key) => retentionLoki[key] !== expectedLoki[key],
          )
        )
          throw new Error("Loki fixture retention profile was not effective");
        for (const name of ["loki", "prometheus", "tempo"])
          await waitHealth(name);
        const finalFlags = (
          await api({
            baseUrl: baseUrls.prometheus,
            path: "/api/v1/status/flags",
          })
        )?.data;
        const finalTempo = await readTempoKnobs();
        if (
          durationMilliseconds(finalFlags?.["storage.tsdb.retention.time"]) !==
            120000 ||
          durationMilliseconds(
            finalFlags?.["storage.tsdb.min-block-duration"],
          ) !== 60000 ||
          durationMilliseconds(
            finalFlags?.["storage.tsdb.max-block-duration"],
          ) !== 60000 ||
          Object.keys(expectedTempo).some(
            (key) => finalTempo[key] !== expectedTempo[key],
          )
        )
          throw new Error(
            "backend fixture retention profile changed before observation",
          );
        evidence.retention.lokiObservation = { effective: retentionLoki };
        observeRetention(
          (async () => {
            const absentSince = { value: undefined };
            let retentionSuccessAtSeconds;
            await waitFor(
              async () => {
                if (cancelObservation)
                  throw Object.assign(
                    new Error("retention observation interrupted"),
                    { fatal: true },
                  );
                try {
                  const metrics = await api({
                    baseUrl: baseUrls.loki,
                    path: "/metrics",
                  });
                  const lastSuccess =
                    typeof metrics === "string" &&
                    /^loki_compactor_apply_retention_last_successful_run_timestamp_seconds\s+([0-9.eE+-]+)\s*$/mu.exec(
                      metrics,
                    );
                  retentionSuccessAtSeconds = Number(lastSuccess?.[1]);
                  Object.assign(evidence.retention.lokiObservation, {
                    observedAt: new Date().toISOString(),
                    retentionSuccessAtSeconds: Number.isFinite(
                      retentionSuccessAtSeconds,
                    )
                      ? retentionSuccessAtSeconds
                      : null,
                  });
                  if (
                    !Number.isFinite(retentionSuccessAtSeconds) ||
                    retentionSuccessAtSeconds * 1000 < retentionActivatedAtMs
                  )
                    throw new Error(
                      "Loki compactor has not completed a retention run in this profile",
                    );
                  const old = await oldLogs();
                  const controlId = newRunId();
                  const controlMs = Date.now();
                  const control = structuredClone(body);
                  control.resourceLogs[0].resource.attributes[0].value.stringValue = `g14-retention-control-${controlId}`;
                  const record =
                    control.resourceLogs[0].scopeLogs[0].logRecords[0];
                  record.timeUnixNano = record.observedTimeUnixNano = String(
                    BigInt(controlMs) * 1000000n,
                  );
                  record.body.stringValue = JSON.stringify({
                    g14_run_id: controlId,
                    retention_control: true,
                  });
                  await api({
                    baseUrl: baseUrls.loki,
                    path: "/otlp/v1/logs",
                    method: "POST",
                    body: control,
                    expected: [200, 204],
                  });
                  const current = await queryLokiLogs({
                    baseUrl: baseUrls.loki,
                    runId: controlId,
                    startTimeUs: (controlMs - 1000) * 1000,
                  });
                  const currentControlVisible = current.some(
                    (item) =>
                      hasExactValue(item, controlId) &&
                      item._timestamp === controlMs * 1000,
                  );
                  const oldMarkerVisible = old.some((record) =>
                    hasExactValue(record, retentionId),
                  );
                  Object.assign(evidence.retention.lokiObservation, {
                    currentControlVisible,
                    oldMarkerVisible,
                  });
                  if (!currentControlVisible)
                    throw new Error(
                      "Loki fresh current-data control is unavailable",
                    );
                  if (oldMarkerVisible) {
                    absentSince.value = undefined;
                    return false;
                  }
                  absentSince.value ??= Date.now();
                  return Date.now() - absentSince.value >= 60 * 1000;
                } catch (error) {
                  absentSince.value = undefined;
                  throw error;
                }
              },
              {
                timeoutMs: 6 * 60 * 1000,
                intervalMs: 5000,
                description:
                  "Loki native TTL removes exact old marker and retains current control",
              },
            );
            evidence.retention.loki = {
              status: "PASS",
              retentionDays: config.telemetry.loki.retentionDays,
              fixtureOnly: true,
              sourceConfigSha256: configSourceSha256,
              schemaSourceSha256,
              profileSha256: profileHash(lokiProfile),
              stagingProfileSha256: profileHash(lokiStagingProfile),
              profile: {
                chunkIdle: "10s",
                flushCheck: "5s",
                compaction: "30s",
                deleteDelay: "30s",
                chunkCacheTtl: "30s",
                chunkCacheEnabled: true,
              },
              nativeFlushAndCleanRestart: true,
              markerId: retentionId,
              sampleTimestampMs: sampleMs,
              visibleBeforeExpiry: true,
              absentObservationWindowMs: 60 * 1000,
              currentControlVisible: true,
              retentionSuccessAtSeconds,
            };
          })(),
        );
        const tempoMarkerAtMs = Date.now();
        const expiredTraceId = await putTrace("g14.retention.expired");
        evidence.retention.tempoObservation = {
          effective: activeTempo,
          traceId: expiredTraceId,
        };
        await waitForSameTraceSpans({
          baseUrl: baseUrls.tempo,
          traceId: expiredTraceId,
          expectedSpanNames: { "g14-retention": ["g14.retention.expired"] },
          timeoutMs: 120000,
        });
        observeRetention(
          (async () => {
            let traceAbsentSince;
            await waitFor(
              async () => {
                if (cancelObservation)
                  throw Object.assign(
                    new Error("retention observation interrupted"),
                    { fatal: true },
                  );
                try {
                  const response = await fetch(
                    new URL(`/api/traces/${expiredTraceId}`, baseUrls.tempo),
                    { signal: AbortSignal.timeout(5000) },
                  );
                  evidence.retention.tempoObservation = {
                    effective: activeTempo,
                    traceId: expiredTraceId,
                    observedAt: new Date().toISOString(),
                    markerAgeMs: Date.now() - tempoMarkerAtMs,
                    httpStatus: response.status,
                  };
                  if (response.status !== 200 && response.status !== 404)
                    throw new Error(
                      `Tempo retention query HTTP ${response.status}`,
                    );
                  if (response.status === 200) {
                    const result = JSON.parse(
                      await boundedResponseText(response, 8 * 1024 * 1024),
                    );
                    if (result?.metrics?.failedBlocks > 0)
                      throw new Error("Tempo retention query is partial");
                    const groups =
                      result?.batches ??
                      result?.resourceSpans ??
                      result?.trace?.resourceSpans;
                    if (!Array.isArray(groups))
                      throw new Error(
                        "Tempo retention query returned invalid trace data",
                      );
                    evidence.retention.tempoObservation.oldTraceVisible =
                      groups.length > 0;
                    if (groups.length > 0) {
                      traceAbsentSince = undefined;
                      return false;
                    }
                  }
                  evidence.retention.tempoObservation.oldTraceVisible = false;
                  if (Date.now() < tempoMarkerAtMs + 120000)
                    throw Object.assign(
                      new Error(
                        "Tempo trace disappeared before fixture retention elapsed",
                      ),
                      { fatal: true },
                    );
                  const controlId = await putTrace("g14.retention.control");
                  await waitForSameTraceSpans({
                    baseUrl: baseUrls.tempo,
                    traceId: controlId,
                    expectedSpanNames: {
                      "g14-retention": ["g14.retention.control"],
                    },
                    timeoutMs: 30000,
                    intervalMs: 1000,
                  });
                  traceAbsentSince ??= Date.now();
                  Object.assign(evidence.retention.tempoObservation, {
                    liveControlVisible: true,
                    absentForMs: Date.now() - traceAbsentSince,
                  });
                  return Date.now() - traceAbsentSince >= 2 * 60 * 1000;
                } catch (error) {
                  traceAbsentSince = undefined;
                  throw error;
                }
              },
              {
                timeoutMs: 6 * 60 * 1000,
                intervalMs: 10000,
                description: "Tempo TTL removes exact trace with live control",
              },
            );
            evidence.retention.tempo = {
              status: "PASS",
              fixtureOnly: true,
              sourceConfigSha256: configSourceSha256,
              schemaSourceSha256,
              profileSha256: profileHash(tempoProfile),
              traceId: expiredTraceId,
              visibleBeforeExpiry: true,
              liveControlVisible: true,
              profile: {
                retention: "2m",
                retentionInterval: "30s",
                completeBlockTimeout: "1m",
                cleanupInterval: "30s",
                blocklistPoll: "30s",
              },
            };
          })(),
        );
        const metricId = newRunId();
        const metricTimeMs = Date.now();
        const metricTimeUs = metricTimeMs * 1000;
        const metricName = "g14_retention_marker";
        const metricBody = {
          resourceMetrics: [
            {
              resource: {
                attributes: [
                  {
                    key: "service.name",
                    value: { stringValue: `g14-retention-${metricId}` },
                  },
                ],
              },
              scopeMetrics: [
                {
                  scope: { name: "g14-retention" },
                  metrics: [
                    {
                      name: metricName,
                      gauge: {
                        dataPoints: [
                          {
                            timeUnixNano: String(
                              BigInt(metricTimeMs) * 1000000n,
                            ),
                            asDouble: 1,
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          ],
        };
        await api({
          baseUrl: baseUrls.prometheus,
          path: "/api/v1/otlp/v1/metrics",
          method: "POST",
          body: metricBody,
          expected: [200, 202, 204],
        });
        const metricExpression = `${metricName}{service_name="g14-retention-${metricId}"}`;
        const metricQuery = () =>
          queryPrometheusRange({
            baseUrl: baseUrls.prometheus,
            expression: metricExpression,
            startTimeUs: metricTimeUs - 5 * 1000000,
            endTimeUs: metricTimeUs + 5 * 1000000,
          });
        await waitFor(
          async () =>
            (await metricQuery()).some(
              (sample) =>
                sample.value === 1 && sample._timestamp === metricTimeUs,
            ),
          {
            timeoutMs: 120000,
            intervalMs: 2000,
            description: "Prometheus retention marker visible",
          },
        );
        observeRetention(
          (async () => {
            let metricAbsentSince;
            await waitFor(
              async () => {
                if (cancelObservation)
                  throw Object.assign(
                    new Error("retention observation interrupted"),
                    { fatal: true },
                  );
                try {
                  const samples = await metricQuery();
                  const freshUs = (Date.now() - 30000) * 1000;
                  const live = await queryPrometheusRange({
                    baseUrl: baseUrls.prometheus,
                    expression: 'probe_success{probe_owner="prometheus"}',
                    startTimeUs: freshUs,
                  });
                  if (
                    !live.some(
                      (sample) =>
                        sample.value === 1 && sample._timestamp > freshUs,
                    )
                  )
                    throw new Error(
                      "Prometheus current-data control unavailable",
                    );
                  if (
                    samples.some(
                      (sample) =>
                        sample.value === 1 &&
                        sample._timestamp === metricTimeUs,
                    )
                  ) {
                    metricAbsentSince = undefined;
                    return false;
                  }
                  if (Date.now() < metricTimeMs + 120000)
                    throw Object.assign(
                      new Error(
                        "Prometheus marker disappeared before fixture retention elapsed",
                      ),
                      { fatal: true },
                    );
                  metricAbsentSince ??= Date.now();
                  return (
                    Date.now() - metricAbsentSince >=
                    2 * config.platform.health.intervalMs
                  );
                } catch (error) {
                  metricAbsentSince = undefined;
                  throw error;
                }
              },
              {
                timeoutMs: 6 * 60 * 1000,
                intervalMs: 5000,
                description:
                  "Prometheus TTL removes exact marker with live control",
              },
            );
            evidence.retention.prometheus = {
              status: "PASS",
              fixtureOnly: true,
              profile: { retention: "2m", minBlock: "1m", maxBlock: "1m" },
              sourceConfigSha256: configSourceSha256,
              schemaSourceSha256,
              profileSha256: profileHash(prometheusProfile),
              markerId: metricId,
              sampleTimestampUs: metricTimeUs,
              visibleBeforeExpiry: true,
              liveControlVisible: true,
            };
          })(),
        );
        const results = await Promise.allSettled(retentionObservers);
        const failed = results.find(
          (result) =>
            result.status === "rejected" || result.value.status === "FAIL",
        );
        if (failed)
          throw failed.status === "rejected"
            ? failed.reason
            : failed.value.error;
      } catch (error) {
        retentionOperationError = error;
      } finally {
        cancelObservation = true;
        await Promise.allSettled(retentionObservers);
        for (const restore of retentionRestorers) await restore();
      }
      try {
        evidence.retention.restoredEffective = await readEffective();
      } catch (error) {
        retentionRestoreErrors.push(error);
        cleanupErrors.push("retention readback: " + cleanError(error));
      }
      if (retentionOperationError) throw retentionOperationError;
      if (retentionRestoreErrors.length)
        throw new AggregateError(
          retentionRestoreErrors,
          "retention restoration failed",
        );
      if (
        Object.keys(expectedEffective).some(
          (key) =>
            evidence.retention.restoredEffective[key] !==
            expectedEffective[key],
        )
      )
        throw new Error("backend production retention did not restore");
      if (
        ["loki", "prometheus", "tempo"].every(
          (name) => evidence.retention[name]?.status === "PASS",
        )
      ) {
        evidence.retention.status = "PASS";
        evidence.retention.ttlRemovedRecord = true;
        evidence.phases.retention = "PASS";
      }
    } catch (error) {
      evidence.retention = {
        ...(typeof evidence.retention === "object" ? evidence.retention : {}),
        status: "FAIL",
      };
      evidence.phases.retention = "FAIL";
      evidence.retentionFailure = cleanError(error);
    }
    evidence.failure =
      [
        evidence.alertFailure && `alerts: ${evidence.alertFailure}`,
        evidence.runtimeMatrixFailure &&
          `runtimeMatrix: ${evidence.runtimeMatrixFailure}`,
        evidence.launchPathFailure &&
          `launchPath: ${evidence.launchPathFailure}`,
        evidence.memoryFailure && `memory: ${evidence.memoryFailure}`,
        evidence.retentionFailure && `retention: ${evidence.retentionFailure}`,
        evidence.diskRecoveryFailure &&
          `diskRecovery: ${evidence.diskRecoveryFailure}`,
      ]
        .filter(Boolean)
        .join("; ") ||
      "G14 verification incomplete: required phase or evidence missing";
  } catch (error) {
    evidence.phases[activePhase] = "FAIL";
    evidence.failure = `${activePhase}: ${cleanError(error)}`;
    if (activePhase === "startup" && composeStarted) {
      evidence.startupDiagnostics = [
        "grafana",
        "loki",
        "prometheus",
        "tempo",
        "otel-collector",
        "alert-sink",
      ].map((service) => {
        try {
          const id = compose(["ps", "--all", "--quiet", service]).trim();
          if (!/^[a-f0-9]{12,64}$/u.test(id))
            return { service, unavailable: true };
          return {
            service,
            ...captureContainerDiagnostics({
              name: id,
              stage: "startup",
              secrets,
            }),
          };
        } catch {
          return { service, unavailable: true };
        }
      });
    }
  } finally {
    if (diskPressureIdentity && storage.grafana && toolchain) {
      try {
        run([
          "run",
          "--rm",
          "--network",
          "none",
          "--read-only",
          "--user",
          "472:472",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--memory",
          "64m",
          "--pids-limit",
          "16",
          "--mount",
          `type=volume,source=${storage.grafana.volumeName},target=/data`,
          "--entrypoint",
          "node",
          toolchain.nodeImage,
          "-e",
          `const fs=require('node:fs'),p='/data/disk-watermark-fill',expected=${JSON.stringify(diskPressureIdentity)};try{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.dev!==expected.dev||s.ino!==expected.ino)throw Error('pressure file identity changed');fs.unlinkSync(p)}catch(e){if(e.code!=='ENOENT')throw e}`,
        ]);
      } catch (error) {
        cleanupErrors.push(`pressure cleanup: ${cleanError(error)}`);
      }
    }
    if (composeStarted) {
      try {
        compose(["down"]);
      } catch (error) {
        cleanupErrors.push(`compose cleanup: ${cleanError(error)}`);
      }
      const checkpoint = `${project}_collector_checkpoints`;
      try {
        const info = JSON.parse(run(["volume", "inspect", checkpoint]))[0];
        if (
          info?.Labels?.["com.docker.compose.project"] !== project ||
          info?.Labels?.["com.docker.compose.volume"] !==
            "collector_checkpoints"
        )
          cleanupErrors.push(
            "checkpoint cleanup: checkpoint ownership mismatch",
          );
        else run(["volume", "rm", checkpoint]);
      } catch (error) {
        if (!/no such volume/iu.test(String(error.stderr ?? error.message)))
          cleanupErrors.push(`checkpoint cleanup: ${cleanError(error)}`);
      }
    }
    if (producerCreated) {
      try {
        run(["rm", "-f", producerName]);
      } catch (error) {
        cleanupErrors.push(`producer cleanup: ${cleanError(error)}`);
      }
    }
    if (producerNetworkCreated) {
      try {
        run(["network", "rm", producerNetwork]);
      } catch (error) {
        cleanupErrors.push(`network cleanup: ${cleanError(error)}`);
      }
    }
    for (const item of [
      ...Object.values(restoreStorage),
      ...Object.values(storage),
    ].reverse()) {
      try {
        removeStorage({
          storage: item,
          storageHelperImage: storageHelper.imageId,
          run,
        });
      } catch (error) {
        cleanupErrors.push(`storage cleanup: ${cleanError(error)}`);
      }
    }
    for (const directory of storageDirectories) {
      try {
        await rmdir(directory);
      } catch (error) {
        if (error.code !== "ENOENT")
          cleanupErrors.push(`storage directory cleanup: ${cleanError(error)}`);
      }
    }
    if (storageRoot) {
      try {
        await rmdir(storageRoot);
      } catch (error) {
        cleanupErrors.push(`storage root cleanup: ${cleanError(error)}`);
      }
    }
    if (verifiedGrafana) {
      try {
        removeVerifiedGateImage({ target: "grafana", image: verifiedGrafana });
      } catch (error) {
        cleanupErrors.push(`Grafana image cleanup: ${cleanError(error)}`);
      }
    }
    if (storageHelper) {
      try {
        removeVerifiedGateImage({
          target: "storage-helper",
          image: storageHelper,
        });
      } catch (error) {
        cleanupErrors.push(`verified image cleanup: ${cleanError(error)}`);
      }
    }
    if (backupDir) {
      try {
        await rm(backupDir, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(`backup cleanup: ${cleanError(error)}`);
      }
    }
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`temporary cleanup: ${cleanError(error)}`);
    }
    evidence.cleanupErrors = cleanupErrors;
    if (launchEvidenceDir && formalContext && config) {
      try {
        evidence.qualificationAdmission = await readG14Qualification(
          launchEvidenceDir,
          formalContext,
          config,
        );
      } catch {
        evidence.qualificationAdmission = undefined;
      }
    }
    if (observabilityGateComplete(evidence)) {
      evidence.status = "PASS";
      delete evidence.failure;
    }
    evidence.completedAt = new Date().toISOString();
    await persistVerificationResult({
      root,
      evidence,
      secrets,
      launchEvidenceDir,
      config,
      cleanError,
    });
  }
  if (evidence.status !== "PASS")
    throw Object.assign(
      new Error(evidence.failure ?? "G14 verification did not pass"),
      { evidence },
    );
  return evidence;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "--") args.shift();
    let probePath = "/usr/bin/busybox";
    if (args.length > 0) {
      if (args.length !== 2 || args[0] !== "--probe" || !isAbsolute(args[1]))
        throw new Error(
          "usage: node tools/observability/verify.mjs [--probe <absolutePath>]",
        );
      probePath = args[1];
    }
    const evidence = await runObservabilityVerification({ probePath });
    console.log(JSON.stringify(evidence));
  } catch (error) {
    if (error.evidence) console.error(JSON.stringify(error.evidence));
    else
      console.error(JSON.stringify({ status: "FAIL", failure: error.message }));
    process.exitCode = 1;
  }
}
