import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { cpus, totalmem } from "node:os";
import { spawn } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY = "YurGusev/CoffeeOrderPlatform";
const REQUIRED_ISSUES = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18, 19, 60, 61, 62, 63, 64,
  119, 162, 210,
];
const SUPPLEMENTED_ISSUES = [2, 3, 10, 14, 19, 162];
const HANDOFF_SUPPLEMENT_PATH =
  "verification/launch/v1/accepted-handoff-supplement.json";
const SENSITIVE_OVERRIDE_NAMES = [
  "DATABASE_URL",
  "COFFEE_DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "POSTGRES_HOST",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
];

const check = (id, pass, facts = {}) => ({
  id,
  status: pass ? "PASS" : "FAIL",
  facts,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");
const isSha = (value) =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const safeRepoPath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !isAbsolute(value) &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

async function ensureSafeDirectoryTree(root, target, createMissing = false) {
  const canonicalRoot = resolve(root);
  if ((await realpath(canonicalRoot).catch(() => null)) !== canonicalRoot)
    return false;
  const rootInfo = await lstat(canonicalRoot).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) return false;
  const relativeTarget = relative(canonicalRoot, resolve(target));
  if (
    !relativeTarget ||
    relativeTarget.startsWith(`..${sep}`) ||
    relativeTarget === ".." ||
    isAbsolute(relativeTarget)
  )
    return relativeTarget === "";
  let current = canonicalRoot;
  for (const segment of relativeTarget.split(sep)) {
    current = resolve(current, segment);
    let info = await lstat(current).catch(() => null);
    if (!info && createMissing) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") return false;
      }
      info = await lstat(current).catch(() => null);
    }
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(current).catch(() => null)) !== current
    )
      return false;
  }
  return true;
}

async function safeArtifactPath(context, contextPath) {
  if (!context || typeof context !== "object") return null;
  if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(context.runId ?? ""))
    return null;
  const sourceRoot = resolve(context.sourceRepoRoot ?? "");
  const evidenceDir = resolve(context.evidenceDir ?? "");
  const expectedEvidenceDir = resolve(
    sourceRoot,
    "evidence",
    "launch",
    context.runId,
  );
  const expectedContextPath = resolve(expectedEvidenceDir, "context.json");
  if (
    !isAbsolute(context.sourceRepoRoot ?? "") ||
    !isAbsolute(context.evidenceDir ?? "") ||
    evidenceDir !== expectedEvidenceDir ||
    resolve(contextPath) !== expectedContextPath
  )
    return null;
  if (!(await ensureSafeDirectoryTree(sourceRoot, expectedEvidenceDir)))
    return null;
  const contextInfo = await lstat(expectedContextPath).catch(() => null);
  if (
    !contextInfo?.isFile() ||
    contextInfo.isSymbolicLink() ||
    (await realpath(expectedContextPath).catch(() => null)) !==
      expectedContextPath
  )
    return null;
  const artifactDir = resolve(
    expectedEvidenceDir,
    "gates",
    "preflight",
    "artifacts",
  );
  if (!(await ensureSafeDirectoryTree(sourceRoot, artifactDir, true)))
    return null;
  return resolve(artifactDir, "preflight.json");
}

function capture(
  executable,
  args,
  cwd,
  {
    timeoutMs = 0,
    captureStderr = false,
    outputLimit = 8 * 1024 * 1024,
    env,
  } = {},
) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", captureStderr ? "pipe" : "ignore"],
    });
    const streams = { stdout: [], stderr: [] };
    let size = 0;
    let settled = false;
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ]) {
      if (!stream) continue;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > outputLimit) child.kill("SIGKILL");
        else streams[name].push(chunk);
      });
    }
    child.once("error", () =>
      finish({ code: 127, stdout: "", stderr: "", timedOut }),
    );
    child.once("close", (code) =>
      finish({
        code: timedOut ? 124 : (code ?? 1),
        stdout: Buffer.concat(streams.stdout).toString("utf8"),
        stderr: Buffer.concat(streams.stderr).toString("utf8"),
        timedOut,
      }),
    );
  });
}

async function command(deps, executable, args, cwd, options) {
  return deps.execFile(executable, args, cwd, options);
}

const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_PROBE_TIMEOUT_MS = 60_000;
const DOCKER_OUTPUT_LIMIT = 1024 * 1024;
const DOCKER_ENV_OVERRIDES = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
];
const DOCKER_ID = /^sha256:[0-9a-f]{64}$/;
const DOCKER_CONTAINER_ID = /^[0-9a-f]{64}$/;
const RUN_ID_LABEL = "com.coffeeorderplatform.launch.run-id";
const PROBE_ID_LABEL = "com.coffeeorderplatform.launch.probe-id";

function sanitizedDockerEnv(env) {
  const result = { ...env };
  for (const name of DOCKER_ENV_OVERRIDES) delete result[name];
  return result;
}

function parseDockerContexts(stdout) {
  try {
    const value = JSON.parse(stdout);
    return Array.isArray(value) && value.length === 1 ? value[0] : null;
  } catch {
    return null;
  }
}

function isLocalUnixEndpoint(value) {
  try {
    const endpoint = new URL(value);
    return (
      endpoint.protocol === "unix:" &&
      endpoint.hostname === "" &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.port === "" &&
      endpoint.search === "" &&
      endpoint.hash === "" &&
      endpoint.pathname.startsWith("/") &&
      !endpoint.pathname.includes("%") &&
      !endpoint.pathname.split("/").includes("..")
    );
  } catch {
    return false;
  }
}

async function dockerContextEndpoint(io, contextName) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(contextName)) return null;
  const inspected = await command(
    io,
    "docker",
    ["context", "inspect", contextName],
    io.cwd,
    {
      timeoutMs: DOCKER_TIMEOUT_MS,
      outputLimit: DOCKER_OUTPUT_LIMIT,
      env: sanitizedDockerEnv(io.env),
    },
  );
  if (inspected.code !== 0 || inspected.timedOut) return null;
  return parseDockerContexts(inspected.stdout)?.Endpoints?.docker?.Host ?? null;
}

async function localDockerEndpoint(io) {
  let endpoint;
  if (typeof io.env.DOCKER_CONTEXT === "string" && io.env.DOCKER_CONTEXT) {
    endpoint = await dockerContextEndpoint(io, io.env.DOCKER_CONTEXT);
  } else if (typeof io.env.DOCKER_HOST === "string" && io.env.DOCKER_HOST) {
    endpoint = io.env.DOCKER_HOST;
  } else {
    const selected = await command(io, "docker", ["context", "show"], io.cwd, {
      timeoutMs: DOCKER_TIMEOUT_MS,
      outputLimit: DOCKER_OUTPUT_LIMIT,
      env: sanitizedDockerEnv(io.env),
    });
    const contextName =
      selected.code === 0 && !selected.timedOut ? selected.stdout.trim() : "";
    endpoint = contextName
      ? await dockerContextEndpoint(io, contextName)
      : null;
  }
  return isLocalUnixEndpoint(endpoint) ? endpoint : null;
}

function dockerCommand(io, endpoint, args, options = {}) {
  return command(io, "docker", ["--host", endpoint, ...args], io.cwd, {
    ...options,
    outputLimit: DOCKER_OUTPUT_LIMIT,
    env: sanitizedDockerEnv(io.env),
  });
}

function pinnedImage(value, name) {
  if (typeof value !== "string") return null;
  const match = new RegExp(
    `^${name}:([0-9]+\\.[0-9]+\\.[0-9]+)[^@]*@sha256:([0-9a-f]{64})$`,
  ).exec(value);
  return match
    ? { ref: value, version: match[1], digest: `sha256:${match[2]}` }
    : null;
}

function inspectImage(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    return null;
  }
}

function imageRepository(value) {
  const repository = value.split("@")[0].split(":")[0];
  return repository.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

function nativeImageMetadata(image, pinned, hostArch) {
  const repos = Array.isArray(image?.RepoDigests) ? image.RepoDigests : [];
  const repoDigest =
    repos.find((item) => {
      const [repository, digestValue] = String(item).split("@");
      return (
        repository &&
        imageRepository(repository) === imageRepository(pinned.ref) &&
        digestValue === pinned.digest
      );
    }) ?? null;
  return {
    valid:
      DOCKER_ID.test(image?.Id ?? "") &&
      repoDigest !== null &&
      image?.Os === "linux" &&
      image?.Architecture === "amd64" &&
      hostArch === "x64",
    id: DOCKER_ID.test(image?.Id ?? "") ? image.Id : null,
    repoDigest,
    os: typeof image?.Os === "string" ? image.Os : null,
    architecture:
      typeof image?.Architecture === "string" ? image.Architecture : null,
  };
}

async function inspectCreatedContainer(io, endpoint, name, runId, probeId) {
  const inspected = await dockerCommand(
    io,
    endpoint,
    ["container", "inspect", name],
    { timeoutMs: DOCKER_TIMEOUT_MS },
  );
  if (inspected.code !== 0) return null;
  const container = inspectImage(inspected.stdout);
  const labels = container?.Config?.Labels;
  return labels?.[RUN_ID_LABEL] === runId &&
    labels?.[PROBE_ID_LABEL] === probeId &&
    DOCKER_CONTAINER_ID.test(container.Id ?? "")
    ? container.Id
    : null;
}

async function nativeImageProbe(
  io,
  endpoint,
  pinned,
  service,
  args,
  hostArch,
  runId,
) {
  const notRun = {
    status: "NOT_RUN",
    imageId: null,
    repoDigest: null,
    os: null,
    architecture: null,
    version: null,
  };
  if (!pinned || process.platform !== "linux")
    return { ...notRun, failure: "unsupported host or invalid pinned image" };
  const inspected = await dockerCommand(
    io,
    endpoint,
    ["image", "inspect", pinned.ref],
    { timeoutMs: DOCKER_TIMEOUT_MS },
  );
  if (inspected.code !== 0 || inspected.timedOut)
    return {
      ...notRun,
      failure: inspected.timedOut
        ? "image inspection timed out"
        : "pinned image is not available locally",
    };
  const image = nativeImageMetadata(
    inspectImage(inspected.stdout),
    pinned,
    hostArch,
  );
  if (!image.valid)
    return {
      ...notRun,
      ...image,
      failure: "pinned image metadata does not match native linux/amd64",
    };

  const probeId = randomUUID();
  const containerName = `coffee-launch-${runId.toLowerCase()}-${service}-${probeId}`;
  const createArgs = [
    "create",
    "--name",
    containerName,
    "--label",
    `${RUN_ID_LABEL}=${runId}`,
    "--label",
    `${PROBE_ID_LABEL}=${probeId}`,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "256m",
    "--entrypoint",
    service,
    pinned.ref,
    ...args,
  ];
  const created = await dockerCommand(io, endpoint, createArgs, {
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  let containerId =
    created.code === 0 && DOCKER_CONTAINER_ID.test(created.stdout.trim())
      ? created.stdout.trim()
      : null;
  if (!containerId)
    containerId = await inspectCreatedContainer(
      io,
      endpoint,
      containerName,
      runId,
      probeId,
    );
  if (!containerId)
    return {
      ...notRun,
      ...image,
      failure: created.timedOut
        ? "container creation timed out"
        : "container creation failed",
    };

  let version = null;
  let failure = null;
  let cleanupSucceeded = false;
  try {
    const started = await dockerCommand(
      io,
      endpoint,
      ["start", "--attach", containerId],
      { timeoutMs: DOCKER_PROBE_TIMEOUT_MS, captureStderr: true },
    );
    const output = `${started.stdout ?? ""}\n${started.stderr ?? ""}`;
    const match =
      service === "node"
        ? /^v([0-9]+\.[0-9]+\.[0-9]+)$/m.exec(output)
        : /\bnginx\/([0-9]+\.[0-9]+\.[0-9]+)/.exec(output);
    version = match?.[1] ?? null;
    if (started.code !== 0 || started.timedOut || version !== pinned.version)
      failure = started.timedOut
        ? "version probe timed out"
        : "version probe failed or mismatched";
  } catch {
    failure = "version probe failed";
  } finally {
    try {
      const removed = await dockerCommand(
        io,
        endpoint,
        ["rm", "--force", containerId],
        { timeoutMs: DOCKER_TIMEOUT_MS },
      );
      cleanupSucceeded = removed.code === 0 && !removed.timedOut;
    } catch {
      cleanupSucceeded = false;
    }
  }
  if (!cleanupSucceeded) failure = "probe container cleanup failed";
  return {
    status: failure ? "FAIL" : "PASS",
    imageId: image.id,
    repoDigest: image.repoDigest,
    os: image.os,
    architecture: image.architecture,
    version,
    cleanupSucceeded,
    failure,
  };
}

async function nativeImageRuntimeProof(io, toolchain, context) {
  const nodePin = pinnedImage(toolchain?.nodeImage, "node");
  const nginxPin = pinnedImage(toolchain?.nginxImage, "nginx");
  const hostArch = process.arch;
  const notRun = {
    status: "NOT_RUN",
    imageId: null,
    repoDigest: null,
    os: null,
    architecture: null,
    version: null,
  };
  const endpoint = await localDockerEndpoint(io);
  if (!endpoint) {
    const failure = "Docker endpoint is not a local unix socket";
    return {
      node: { ...notRun, failure },
      nativeNginx: { ...notRun, failure },
      daemon: { os: null, architecture: null },
      endpointKind: "unsupported",
      passed: false,
    };
  }
  const daemonResult = await dockerCommand(
    io,
    endpoint,
    ["version", "--format", "{{json .Server}}"],
    { timeoutMs: DOCKER_TIMEOUT_MS },
  );
  let daemon;
  try {
    daemon = JSON.parse(daemonResult.stdout);
  } catch {
    daemon = null;
  }
  const daemonValid =
    daemonResult.code === 0 &&
    !daemonResult.timedOut &&
    daemon?.Os === "linux" &&
    daemon?.Arch === "amd64" &&
    process.platform === "linux" &&
    hostArch === "x64";
  const daemonFacts = {
    os: typeof daemon?.Os === "string" ? daemon.Os : null,
    architecture: typeof daemon?.Arch === "string" ? daemon.Arch : null,
  };
  if (!daemonValid) {
    const failure = daemonResult.timedOut
      ? "Docker daemon inspection timed out"
      : "Docker daemon is not native linux/amd64";
    return {
      node: { ...notRun, failure },
      nativeNginx: { ...notRun, failure },
      daemon: daemonFacts,
      endpointKind: "local-unix-only",
      passed: false,
    };
  }
  const node = await nativeImageProbe(
    io,
    endpoint,
    nodePin,
    "node",
    ["--version"],
    hostArch,
    context.runId,
  );
  const nativeNginx = await nativeImageProbe(
    io,
    endpoint,
    nginxPin,
    "nginx",
    ["-v"],
    hostArch,
    context.runId,
  );
  return {
    node,
    nativeNginx,
    daemon: daemonFacts,
    endpointKind: "local-unix-only",
    passed: node.status === "PASS" && nativeNginx.status === "PASS",
  };
}

async function git(deps, cwd, ...args) {
  const result = await command(deps, "git", args, cwd);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function gitObject(deps, cwd, revisionAndPath) {
  const result = await command(deps, "git", ["show", revisionAndPath], cwd);
  return result.code === 0 ? result.stdout : null;
}

function parseHandoff(text, expectedIssue, yamlLoad) {
  let handoff;
  try {
    handoff = yamlLoad(text);
  } catch {
    return null;
  }
  const inputs = handoff?.inputs;
  const outputs = handoff?.outputs;
  if (
    handoff?.issue !== expectedIssue ||
    !Array.isArray(inputs) ||
    !Array.isArray(outputs) ||
    outputs.length === 0
  )
    return null;
  if (
    inputs.some(
      (input) =>
        !/^\d+$/.test(String(input.issue ?? "")) ||
        !isSha(input.acceptedMergeCommit) ||
        !safeRepoPath(input.artifact) ||
        !/^[a-f0-9]{64}$/.test(String(input.sha256 ?? "")),
    )
  )
    return null;
  if (
    outputs.some(
      (output) =>
        !safeRepoPath(output.artifact) ||
        !/^[a-f0-9]{64}$/.test(String(output.sha256 ?? "")) ||
        !Array.isArray(output.consumers) ||
        output.consumers.some(
          (consumer) => !Number.isInteger(consumer) || consumer < 1,
        ),
    )
  )
    return null;
  return { inputs, outputs };
}

async function isAncestor(deps, cwd, ancestor, descendant) {
  if (!isSha(ancestor) || !isSha(descendant)) return false;
  const result = await command(
    deps,
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    cwd,
  );
  return result.code === 0;
}

function latestAncestorMerge(rows) {
  const valid = rows.filter(
    (row) =>
      row.merged === true &&
      row.baseRefName === "develop" &&
      isSha(row.mergeCommit?.oid),
  );
  if (!valid.length) return null;
  const maximal = valid.filter(
    (candidate) =>
      !valid.some(
        (other) =>
          other !== candidate &&
          candidate.mergeCommit.oid !== other.mergeCommit.oid &&
          candidate.ancestors?.includes(other.mergeCommit.oid),
      ),
  );
  if (maximal.length !== 1)
    return {
      ambiguous: true,
      candidates: maximal.map((item) => item.mergeCommit.oid),
    };
  return maximal[0];
}

function requiredPnpmScripts(gates) {
  if (
    !Array.isArray(gates) ||
    gates.length !== 20 ||
    gates.some((gate) => !Array.isArray(gate) || typeof gate[1] !== "string")
  )
    return null;
  const names = new Set();
  for (const [, command] of gates) {
    for (const segment of command.split(" && ")) {
      const match = /^pnpm\s+([a-z0-9:_-]+)(?:\s|$)/.exec(segment);
      if (match && !["install", "exec"].includes(match[1])) names.add(match[1]);
    }
  }
  return names.size > 0
    ? [...names].sort((left, right) => left.localeCompare(right))
    : null;
}

async function githubIssue(deps, number) {
  const query =
    "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){issue(number:$number){number state closedByPullRequestsReferences(first:100,after:$after){nodes{number merged mergeCommit{oid} baseRefName} pageInfo{hasNextPage endCursor}}}}}";
  let after = null;
  let issue = null;
  const prs = [];
  let morePages = true;
  while (morePages) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      "owner=YurGusev",
      "-F",
      "name=CoffeeOrderPlatform",
      "-F",
      `number=${number}`,
    ];
    if (after) args.push("-F", `after=${after}`);
    const result = await command(deps, "gh", args, deps.cwd);
    if (result.code !== 0) return { error: "GitHub API request failed" };
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return { error: "GitHub API returned invalid JSON" };
    }
    const current = payload.data?.repository?.issue;
    if (!current || current.number !== number)
      return { error: "GitHub issue snapshot is incomplete" };
    if (issue && issue.state !== current.state)
      return { error: "GitHub issue changed during pagination" };
    issue = { number, state: current.state };
    const connection = current.closedByPullRequestsReferences;
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      return { error: "GitHub PR references are incomplete" };
    prs.push(
      ...connection.nodes.map((pr) => ({
        number: pr.number,
        merged: pr.merged,
        mergeCommit: { oid: pr.mergeCommit?.oid ?? null },
        baseRefName: pr.baseRefName,
      })),
    );
    morePages = connection.pageInfo.hasNextPage;
    if (!morePages) break;
    if (
      !connection.pageInfo.endCursor ||
      connection.pageInfo.endCursor === after
    )
      return { error: "GitHub pagination cursor is invalid" };
    after = connection.pageInfo.endCursor;
  }
  return { issue, prs };
}

async function evaluateHandoff(
  deps,
  cwd,
  issue,
  mergeCommit,
  acceptedMergesByIssue,
  candidateSha,
  yamlLoad,
) {
  const path = `evidence/handoffs/issue-${issue}.yaml`;
  const source = await gitObject(deps, cwd, `${mergeCommit}:${path}`);
  if (source === null)
    return check(`HANDOFF_${issue}`, false, {
      coverage: "missing handoff at accepted merge",
    });
  const parsed = parseHandoff(source, issue, yamlLoad);
  if (!parsed)
    return check(`HANDOFF_${issue}`, false, {
      coverage:
        "legacy/unsupported schema or missing acceptedMergeCommit/hash/consumers; historical proof not inferred",
    });
  const failures = [];
  for (const [index, input] of parsed.inputs.entries()) {
    if (!(await isAncestor(deps, cwd, input.acceptedMergeCommit, mergeCommit)))
      failures.push({
        inputIndex: index,
        reason: "accepted input merge is not an ancestor of handoff merge",
      });
    if (!(await isAncestor(deps, cwd, input.acceptedMergeCommit, candidateSha)))
      failures.push({
        inputIndex: index,
        reason: "accepted input merge is not an ancestor of candidate",
      });
    const knownMerges = acceptedMergesByIssue.get(Number(input.issue));
    if (!knownMerges?.has(input.acceptedMergeCommit))
      failures.push({
        inputIndex: index,
        reason:
          "input merge is not present in fresh accepted GitHub merge references",
      });
    const object = await gitObject(
      deps,
      cwd,
      `${input.acceptedMergeCommit}:${input.artifact}`,
    );
    if (object === null || digest(object) !== input.sha256)
      failures.push({
        inputIndex: index,
        reason: "historical input SHA-256 mismatch or missing",
      });
  }
  for (const [index, output] of parsed.outputs.entries()) {
    const object = await gitObject(
      deps,
      cwd,
      `${mergeCommit}:${output.artifact}`,
    );
    if (object === null || digest(object) !== output.sha256)
      failures.push({
        outputIndex: index,
        reason: "output SHA-256 does not match accepted merge",
      });
  }
  return check(`HANDOFF_${issue}`, failures.length === 0, {
    acceptedMergeCommit: mergeCommit,
    inputCount: parsed.inputs.length,
    outputCount: parsed.outputs.length,
    consumersValidated: parsed.outputs.every((output) =>
      Array.isArray(output.consumers),
    ),
    failures,
  });
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function acceptedHandoffSupplementValid(supplement) {
  if (
    !hasExactKeys(supplement, [
      "schemaVersion",
      "purpose",
      "authorization",
      "records",
    ]) ||
    supplement.schemaVersion !== 1 ||
    supplement.purpose !== "G00_CORRECTIVE_ACCEPTED_HANDOFF_SUPPLEMENT" ||
    !hasExactKeys(supplement.authorization, [
      "date",
      "authority",
      "requestText",
      "proposalReference",
      "scope",
    ]) ||
    supplement.authorization.date !== "2026-10-24" ||
    supplement.authorization.authority !==
      "explicit-user-approval-in-current-task" ||
    supplement.authorization.requestText !== "Разрешаю точный supplement" ||
    supplement.authorization.proposalReference !==
      "evidence/launch-preparation/2026-10-24/remaining-gates-authority-proposal.md" ||
    JSON.stringify(supplement.authorization.scope) !==
      JSON.stringify(SUPPLEMENTED_ISSUES) ||
    !Array.isArray(supplement.records) ||
    supplement.records.length !== SUPPLEMENTED_ISSUES.length
  )
    return false;
  const issues = [];
  for (const record of supplement.records) {
    if (
      !hasExactKeys(record, [
        "issue",
        "acceptanceSource",
        "handoff",
        "artifactSource",
        "artifacts",
      ]) ||
      !hasExactKeys(record.acceptanceSource, [
        "issue",
        "pullRequest",
        "mergeCommit",
      ]) ||
      !hasExactKeys(record.artifactSource, ["issue", "mergeCommit"]) ||
      !Number.isInteger(record.issue) ||
      !hasExactKeys(record.acceptanceSource, [
        "issue",
        "pullRequest",
        "mergeCommit",
      ]) ||
      record.acceptanceSource.issue !== record.issue ||
      !Number.isInteger(record.acceptanceSource.pullRequest) ||
      !isSha(record.acceptanceSource.mergeCommit) ||
      !Number.isInteger(record.artifactSource.issue) ||
      !isSha(record.artifactSource.mergeCommit) ||
      !Array.isArray(record.artifacts) ||
      record.artifacts.length === 0
    )
      return false;
    if (record.issue === 14) {
      if (record.handoff !== null || record.artifactSource.issue !== 19)
        return false;
    } else if (
      !hasExactKeys(record.handoff, ["path", "sha256"]) ||
      record.handoff.path !== `evidence/handoffs/issue-${record.issue}.yaml` ||
      !/^[a-f0-9]{64}$/.test(record.handoff.sha256) ||
      record.artifactSource.issue !== record.issue ||
      record.artifactSource.mergeCommit !== record.acceptanceSource.mergeCommit
    )
      return false;
    const paths = new Set();
    for (const artifact of record.artifacts) {
      if (
        !hasExactKeys(artifact, ["path", "sha256"]) ||
        !safeRepoPath(artifact.path) ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
        paths.has(artifact.path)
      )
        return false;
      paths.add(artifact.path);
    }
    issues.push(record.issue);
  }
  return JSON.stringify(issues) === JSON.stringify(SUPPLEMENTED_ISSUES);
}

function expectedSupplementPaths(issue, source) {
  if (!source) return null;
  let handoff;
  try {
    handoff = source.yamlLoad(source.text);
  } catch {
    return null;
  }
  if (issue === 2 || issue === 162)
    return Array.isArray(handoff?.outputs)
      ? handoff.outputs.map((item) => item.artifact)
      : null;
  if (issue === 3) {
    const output = handoff?.outputs;
    return hasExactKeys(output, [
      "runtimeCount",
      "ownerDatabaseCount",
      "runtimeRoleCount",
      "dockerHostPorts",
      "config",
      "encryptedSecrets",
      "compose",
      "toolchain",
      "toolchainProfileParity",
      "consumers",
    ])
      ? [
          output.config,
          output.encryptedSecrets,
          output.compose,
          output.toolchain,
          output.toolchainProfileParity,
        ]
      : null;
  }
  if (issue === 10)
    return Array.isArray(handoff?.currentOutputs)
      ? handoff.currentOutputs.map((item) => item.artifact)
      : null;
  if (issue === 19) {
    const outputs = handoff?.outputs;
    return ["manifests", "schemas", "verificationCode"].every((key) =>
      Array.isArray(outputs?.[key]),
    )
      ? ["manifests", "schemas", "verificationCode"].flatMap((key) =>
          outputs[key].map((item) => item.path),
        )
      : null;
  }
  if (issue === 14) {
    const inputs = handoff?.inputs;
    return Array.isArray(inputs?.decisions) &&
      Array.isArray(inputs?.launchAuthority)
      ? [...inputs.decisions, ...inputs.launchAuthority]
      : null;
  }
  return null;
}

async function evaluateAcceptedHandoffSupplement(
  deps,
  cwd,
  record,
  acceptedByIssue,
  candidateSha,
  yamlLoad,
) {
  const failures = [];
  const accepted = acceptedByIssue.get(record.issue);
  if (
    !accepted ||
    accepted.number !== record.acceptanceSource.pullRequest ||
    accepted.mergeCommit.oid !== record.acceptanceSource.mergeCommit
  ) {
    failures.push({
      reason:
        "fresh GitHub accepted PR/merge does not match the owner-approved supplement",
    });
  }
  if (
    !(await isAncestor(
      deps,
      cwd,
      record.acceptanceSource.mergeCommit,
      candidateSha,
    ))
  ) {
    failures.push({
      reason: "accepted GitHub merge is not an ancestor of candidate",
    });
  }
  const handoffBytes = await gitObject(
    deps,
    cwd,
    `${record.acceptanceSource.mergeCommit}:${record.handoff?.path ?? `evidence/handoffs/issue-${record.issue}.yaml`}`,
  );
  if (record.issue === 14) {
    if (handoffBytes !== null)
      failures.push({
        reason: "issue #14 unexpectedly has an accepted handoff",
      });
  } else if (
    handoffBytes === null ||
    digest(handoffBytes) !== record.handoff.sha256
  ) {
    failures.push({
      reason: "accepted historical handoff blob SHA-256 mismatch",
    });
  }
  let artifactCommit = record.acceptanceSource.mergeCommit;
  let artifactHandoffText = handoffBytes;
  if (record.issue === 14) {
    const source = await gitObject(
      deps,
      cwd,
      `${record.artifactSource.mergeCommit}:evidence/handoffs/issue-${record.artifactSource.issue}.yaml`,
    );
    artifactCommit = record.artifactSource.mergeCommit;
    artifactHandoffText = source;
  }
  const expectedPaths = expectedSupplementPaths(
    record.issue,
    artifactHandoffText === null
      ? null
      : { text: artifactHandoffText, yamlLoad },
  );
  const actualPaths = record.artifacts.map(({ path }) => path);
  if (
    !expectedPaths ||
    JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
  ) {
    failures.push({
      reason:
        "supplement artifacts do not exactly match the approved accepted handoff scope",
    });
  }
  if (record.issue === 14) {
    const acceptedDesignSource = acceptedByIssue.get(19);
    if (
      record.artifactSource.mergeCommit !==
        acceptedDesignSource?.mergeCommit?.oid ||
      !(await isAncestor(
        deps,
        cwd,
        record.artifactSource.mergeCommit,
        candidateSha,
      ))
    ) {
      failures.push({
        reason:
          "issue #14 design artifacts are not from the fresh accepted #19 merge",
      });
    }
  }
  for (const artifact of record.artifacts) {
    const object = await gitObject(
      deps,
      cwd,
      `${artifactCommit}:${artifact.path}`,
    );
    if (object === null || digest(object) !== artifact.sha256)
      failures.push({
        path: artifact.path,
        reason: "accepted artifact blob SHA-256 mismatch or missing",
      });
  }
  return check(`HANDOFF_${record.issue}`, failures.length === 0, {
    acceptedMergeCommit: record.acceptanceSource.mergeCommit,
    acceptanceSource: `GitHub PR #${record.acceptanceSource.pullRequest} merged into develop`,
    artifactCount: record.artifacts.length,
    failures,
    historicalRuntimeProof: "not-inferred",
    supplementAuthorization: "explicit-user-approval-in-current-task",
    ...(record.issue === 14
      ? {
          coverage:
            "accepted #19 design artifacts only; no #14 runtime handoff",
        }
      : {}),
  });
}

export async function runPreflight(context, deps = {}) {
  const io = {
    execFile: deps.execFile ?? capture,
    cwd: deps.cwd ?? process.cwd(),
    realpath: deps.realpath ?? realpath,
    stat: deps.stat ?? stat,
    readFile: deps.readFile ?? readFile,
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date().toISOString()),
    yamlLoad: deps.yamlLoad,
    yamlVersion: deps.yamlVersion,
    expectedGates: deps.expectedGates,
  };
  const checks = [];
  const startedAt =
    typeof context?.startedAtUtc === "string"
      ? new Date(context.startedAtUtc)
      : null;
  const expectedRunId =
    startedAt &&
    Number.isFinite(startedAt.getTime()) &&
    isSha(context?.candidateSha)
      ? `${startedAt
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}Z$/, "Z")}-${context.candidateSha.slice(0, 7)}`
      : null;
  const basic =
    context &&
    context.schemaVersion === 1 &&
    typeof context.runId === "string" &&
    /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/.test(context.runId) &&
    isSha(context.candidateSha) &&
    /^[0-9a-f]{64}$/.test(context.baseConfigSha256 ?? "") &&
    context.runId === expectedRunId &&
    typeof context.checkoutDir === "string" &&
    isAbsolute(context.checkoutDir) &&
    typeof context.sourceRepoRoot === "string" &&
    isAbsolute(context.sourceRepoRoot) &&
    typeof context.evidenceDir === "string" &&
    isAbsolute(context.evidenceDir) &&
    (context.acceptedBaseCommit === null || isSha(context.acceptedBaseCommit));
  checks.push(
    check("CONTEXT", basic, {
      schemaVersion: context?.schemaVersion ?? null,
      acceptedBaseCommitPresent: isSha(context?.acceptedBaseCommit),
    }),
  );
  if (!basic)
    return {
      schemaVersion: 1,
      gateId: "preflight",
      runId: context?.runId ?? "unknown",
      candidateSha: context?.candidateSha ?? "unknown",
      status: "FAIL",
      checks,
      limitations: [
        "Недопустимый или неполный runner context; проверка остановлена fail-closed.",
      ],
      githubSnapshot: null,
    };

  const cwd = await io.realpath(io.cwd).catch(() => io.cwd);
  const checkoutDir = await io
    .realpath(context.checkoutDir)
    .catch(() => context.checkoutDir);
  const top = await git(io, cwd, "rev-parse", "--show-toplevel");
  const head = await git(io, cwd, "rev-parse", "HEAD");
  const status = await git(
    io,
    cwd,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  const ignored = await git(
    io,
    cwd,
    "status",
    "--ignored",
    "--short",
    "--untracked-files=all",
  );
  const ignoredBuildPaths = (ignored ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3).replace(/\/$/, ""))
    .filter((path) =>
      path
        .split("/")
        .some(
          (part) =>
            ["node_modules", "dist", "build"].includes(part) ||
            /(^|[-_.])generated($|[-_.])/.test(part),
        ),
    );
  const exactCheckout = Boolean(
    top &&
    (await io.realpath(top).catch(() => top)) === checkoutDir &&
    cwd === checkoutDir,
  );
  checks.push(
    check(
      "CANDIDATE_CHECKOUT",
      exactCheckout &&
        head === context.candidateSha &&
        status === "" &&
        ignoredBuildPaths.length === 0,
      {
        candidateShaMatchesHead: head === context.candidateSha,
        checkoutIsCwd: cwd === checkoutDir,
        trackedAndUntrackedClean: status === "",
        ignoredBuildArtifactsAbsent: ignoredBuildPaths.length === 0,
      },
    ),
  );

  const origin = await git(io, cwd, "remote", "get-url", "origin");
  const originOk =
    origin === "https://github.com/YurGusev/CoffeeOrderPlatform" ||
    origin === "https://github.com/YurGusev/CoffeeOrderPlatform.git" ||
    origin === "git@github.com:YurGusev/CoffeeOrderPlatform.git";
  const repoView = await command(
    io,
    "gh",
    ["repo", "view", "--json", "nameWithOwner,url"],
    cwd,
  );
  let view;
  try {
    view = repoView.code === 0 ? JSON.parse(repoView.stdout) : null;
  } catch {
    view = null;
  }
  const githubRepoOk =
    view?.nameWithOwner === REPOSITORY &&
    view?.url === "https://github.com/YurGusev/CoffeeOrderPlatform";
  checks.push(
    check("REPOSITORY_AUTHORITY", originOk && githubRepoOk, {
      originCanonical: originOk,
      ghRepositoryCanonical: githubRepoOk,
    }),
  );

  const baseAncestor = await isAncestor(
    io,
    cwd,
    context.acceptedBaseCommit,
    context.candidateSha,
  );
  const baseObject = context.acceptedBaseCommit
    ? await git(
        io,
        cwd,
        "rev-parse",
        "--verify",
        `${context.acceptedBaseCommit}^{commit}`,
      )
    : null;
  checks.push(
    check(
      "ACCEPTED_BASE",
      baseAncestor && baseObject === context.acceptedBaseCommit,
      {
        acceptedBaseCommitPresent: isSha(context.acceptedBaseCommit),
        ancestorOfCandidate: baseAncestor,
      },
    ),
  );

  const sourceHead = await git(io, context.sourceRepoRoot, "rev-parse", "HEAD");
  const sourceStatus = await git(
    io,
    context.sourceRepoRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  );
  const sourceOrigin = await git(
    io,
    context.sourceRepoRoot,
    "remote",
    "get-url",
    "origin",
  );
  const sourceOriginOk = [
    "https://github.com/YurGusev/CoffeeOrderPlatform",
    "https://github.com/YurGusev/CoffeeOrderPlatform.git",
    "git@github.com:YurGusev/CoffeeOrderPlatform.git",
  ].includes(sourceOrigin);
  const sourceRootReal = await io
    .realpath(context.sourceRepoRoot)
    .catch(() => null);
  const sourceStatusLines = (sourceStatus ?? "").split(/\r?\n/).filter(Boolean);
  const currentRunEvidencePrefix = `evidence/launch/${context.runId}/`;
  const sourceChangesOutsideRunEvidence = sourceStatusLines.filter((line) => {
    if (!line.startsWith("?? ")) return true;
    const path = line.slice(3);
    return !safeRepoPath(path) || !path.startsWith(currentRunEvidencePrefix);
  });
  const sourceRootMatches =
    sourceRootReal === resolve(context.sourceRepoRoot) &&
    sourceHead === context.candidateSha &&
    sourceChangesOutsideRunEvidence.length === 0 &&
    sourceOriginOk;
  let yamlLoad = io.yamlLoad ?? null;
  let yamlVersion = io.yamlVersion ?? null;
  if (sourceRootMatches && !yamlLoad) {
    try {
      const requireFromSource = createRequire(
        resolve(context.sourceRepoRoot, "package.json"),
      );
      const yaml = requireFromSource("js-yaml");
      const manifest = JSON.parse(
        await io.readFile(
          resolve(context.sourceRepoRoot, "package.json"),
          "utf8",
        ),
      );
      const installed = JSON.parse(
        await io.readFile(
          resolve(context.sourceRepoRoot, "node_modules/js-yaml/package.json"),
          "utf8",
        ),
      );
      if (
        manifest.devDependencies?.["js-yaml"] === installed.version &&
        typeof yaml.load === "function"
      ) {
        yamlLoad = yaml.load;
        yamlVersion = installed.version;
      }
    } catch {
      /* missing or mismatched control-plane parser fails closed */
    }
  }
  let expectedGates = io.expectedGates ?? null;
  if (sourceRootMatches && !expectedGates) {
    try {
      const report = await import(
        pathToFileURL(
          resolve(context.sourceRepoRoot, "verification/launch/v1/report.mjs"),
        ).href
      );
      expectedGates = report.EXPECTED_GATES;
    } catch {
      /* no trusted canonical gate command catalog */
    }
  }
  const requiredScripts = requiredPnpmScripts(expectedGates);
  let packageManifest = null;
  try {
    packageManifest = JSON.parse(
      await io.readFile(resolve(cwd, "package.json"), "utf8"),
    );
  } catch {
    /* missing package manifest is typed below */
  }
  const availableScripts = packageManifest?.scripts ?? {};
  const missingScripts =
    requiredScripts?.filter(
      (name) =>
        typeof availableScripts[name] !== "string" ||
        !availableScripts[name].trim(),
    ) ?? [];
  checks.push(
    check(
      "EXACT_GATE_SCRIPTS",
      Boolean(requiredScripts) && missingScripts.length === 0,
      {
        canonicalGateCatalogAvailable: Boolean(requiredScripts),
        requiredScriptNames: requiredScripts ?? [],
        missingScriptNames: missingScripts,
      },
    ),
  );
  const bootstrapReady =
    sourceRootMatches &&
    typeof yamlLoad === "function" &&
    typeof yamlVersion === "string";
  checks.push(
    check("SOURCE_TOOLING_BOOTSTRAP", bootstrapReady, {
      sourceRootMatchesCandidate: sourceHead === context.candidateSha,
      sourceCheckoutCleanOutsideRunEvidence:
        sourceChangesOutsideRunEvidence.length === 0,
      currentRunEvidenceUntrackedEntries:
        sourceStatusLines.length - sourceChangesOutsideRunEvidence.length,
      unrelatedOrTrackedSourceChanges: sourceChangesOutsideRunEvidence.length,
      sourceOriginCanonical: sourceOriginOk,
      yamlParser: bootstrapReady ? "js-yaml" : null,
      yamlParserVersion: bootstrapReady ? yamlVersion : null,
      yamlParserSource: bootstrapReady ? "sourceRepoRoot/node_modules" : null,
    }),
  );

  const configBytes = await io
    .readFile(resolve(cwd, "config/platform.yaml"))
    .catch(() => Buffer.alloc(0));
  const config = Buffer.isBuffer(configBytes)
    ? configBytes.toString("utf8")
    : String(configBytes);
  const compose = await io
    .readFile(resolve(cwd, "compose.yaml"), "utf8")
    .catch(() => "");
  const legacyTargets = /coffeeorderdb/i.test(config + compose);
  const composeProject = context.resources?.composeProject;
  const composeProjectSyntaxValid =
    typeof composeProject === "string" &&
    /^[a-z0-9][a-z0-9_-]*$/.test(composeProject);
  const contextHasNoDatabaseInputs =
    !Object.hasOwn(context.resources ?? {}, "databasePrefix") &&
    !Object.hasOwn(context.resources ?? {}, "databases") &&
    !Object.hasOwn(context, "databaseNames");
  const runIdOk =
    composeProject === `coffee-launch-${context.runId.toLowerCase()}` &&
    context.resources?.kafkaPrefix === context.runId &&
    contextHasNoDatabaseInputs;
  let parsedConfig = null;
  let parsedCompose = null;
  try {
    if (typeof yamlLoad === "function") {
      parsedConfig = yamlLoad(config);
      parsedCompose = yamlLoad(compose);
    }
  } catch {
    /* malformed configuration remains failed evidence */
  }
  const configuredDatabaseTargets = [];
  let databaseTargetPlanValid = false;
  try {
    const ownership = JSON.parse(
      await io.readFile(resolve(cwd, "config/database-ownership.json"), "utf8"),
    );
    const deriveRuntimeDatabaseTarget =
      deps.deriveRuntimeDatabaseTarget ??
      (
        await import(
          pathToFileURL(
            resolve(
              context.checkoutDir,
              "packages/platform-config/src/launch-database-target.ts",
            ),
          ).href
        )
      ).deriveRuntimeDatabaseTarget;
    const launchIdentity = {
      schemaVersion: 1,
      runId: context.runId,
      candidateSha: context.candidateSha,
      baseConfigSha256: context.baseConfigSha256,
    };
    const claims = ownership.runtimeClaims.filter(
      (claim) => claim.database !== null,
    );
    for (const { runtime } of claims) {
      const target = deriveRuntimeDatabaseTarget({
        config: {
          environment: parsedConfig.environment,
          databaseIsolation: parsedConfig.verification?.databaseIsolation,
          services: parsedConfig.services,
        },
        runtime,
        ownership,
        launchIdentity,
      });
      configuredDatabaseTargets.push({
        service: runtime,
        owner: target.owner,
        database: target.database,
        allowedDatabase: target.allowedDatabase,
      });
    }
    databaseTargetPlanValid =
      claims.length === 10 &&
      new Set(configuredDatabaseTargets.map(({ owner }) => owner)).size === 5 &&
      new Set(configuredDatabaseTargets.map(({ database }) => database))
        .size === 5 &&
      configuredDatabaseTargets.every(
        ({ database, allowedDatabase }) => database === allowedDatabase,
      );
  } catch {
    /* invalid policy/ownership/context stays failed evidence */
  }
  const baseConfigBytesMatch = digest(configBytes) === context.baseConfigSha256;
  const scopedDatabaseTargets = databaseTargetPlanValid && baseConfigBytesMatch;
  let kafkaNamespacePlan = null;
  let kafkaNamespacePlanValid = false;
  try {
    if (
      parsedConfig?.verification?.kafkaNamespaceIsolation === true &&
      parsedConfig.environment !== "production" &&
      baseConfigBytesMatch &&
      exactCheckout &&
      head === context.candidateSha
    ) {
      const deriveRuntimeKafkaTarget =
        deps.deriveRuntimeKafkaTarget ??
        (
          await import(
            pathToFileURL(
              resolve(
                context.checkoutDir,
                "packages/platform-config/src/launch-kafka-target.ts",
              ),
            ).href
          )
        ).deriveRuntimeKafkaTarget;
      const deriveLaunchKafkaRegistryTarget =
        deps.deriveLaunchKafkaRegistryTarget ??
        (
          await import(
            pathToFileURL(
              resolve(
                context.checkoutDir,
                "packages/platform-config/src/launch-kafka-target.ts",
              ),
            ).href
          )
        ).deriveLaunchKafkaRegistryTarget;
      const launchIdentity = {
        schemaVersion: 1,
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
      };
      const targets = Object.entries(parsedConfig.services ?? {}).map(
        ([, service]) =>
          deriveRuntimeKafkaTarget({
            config: parsedConfig.kafka,
            service: service.kafka,
            enabled: true,
            environment: parsedConfig.environment,
            launchIdentity,
          }),
      );
      const registryTarget = deriveLaunchKafkaRegistryTarget({
        config: parsedConfig.kafka,
        enabled: true,
        environment: parsedConfig.environment,
        launchIdentity,
      });
      const sortNames = (left, right) => left.localeCompare(right, "en");
      const expectedTopics = [
        ...new Set([
          ...targets.flatMap(({ topics }) => Object.values(topics)),
          ...Object.values(registryTarget.topics),
        ]),
      ].sort(sortNames);
      const expectedGroups = [
        ...new Set(targets.flatMap(({ groups }) => Object.values(groups))),
      ].sort(sortNames);
      if (
        !expectedTopics.length ||
        !expectedGroups.length ||
        [...expectedTopics, ...expectedGroups].some(
          (name) => !name.startsWith(`${context.runId}.`),
        )
      ) {
        throw new Error("invalid derived Kafka namespace claims");
      }
      kafkaNamespacePlan = {
        runId: context.runId,
        candidateSha: context.candidateSha,
        baseConfigSha256: context.baseConfigSha256,
        expectedTopics,
        expectedGroups,
      };
      kafkaNamespacePlanValid = true;
    }
  } catch {
    /* committed plan, context and shared runtime mapping must all validate */
  }
  checks.push(
    check("KAFKA_NAMESPACE_PLAN", kafkaNamespacePlanValid, {
      committedFlagEnabled:
        parsedConfig?.verification?.kafkaNamespaceIsolation === true,
      baseConfigShaMatchesContext: baseConfigBytesMatch,
      baseConfigSha256: context.baseConfigSha256,
      candidateContextValid: exactCheckout && head === context.candidateSha,
      expectedPhysical: kafkaNamespacePlan
        ? {
            topics: kafkaNamespacePlan.expectedTopics,
            groups: kafkaNamespacePlan.expectedGroups,
          }
        : null,
    }),
  );
  const postgresComposeServices = Object.entries(parsedCompose?.services ?? {})
    .filter(
      ([name, service]) =>
        /postgres/i.test(name) ||
        /(^|\/)postgres(?:[:@]|$)/i.test(String(service?.image ?? "")),
    )
    .map(([name]) => name);
  const configEvidenceValid =
    parsedConfig?.schemaVersion === 1 &&
    Object.keys(parsedCompose?.services ?? {}).length > 0 &&
    parsedConfig?.verification?.databaseIsolation?.enabled === true;
  const overrideNames = [
    ...SENSITIVE_OVERRIDE_NAMES,
    "COFFEE_PLATFORM_CONFIG",
    "COFFEE_CONFIG_FILE",
    "PLATFORM_CONFIG_FILE",
    "CONFIG_FILE",
  ];
  const overridePresent = overrideNames.filter((name) =>
    Object.hasOwn(io.env, name),
  );
  const contextPathsOk = await Promise.all(
    [context.sourceRepoRoot, context.evidenceDir, context.checkoutDir].map(
      async (value) =>
        (await io.realpath(value).catch(() => null)) === resolve(value),
    ),
  );
  const expectedEvidence = resolve(
    context.sourceRepoRoot,
    "evidence/launch",
    context.runId,
  );
  const outputPathOk =
    resolve(context.evidenceDir) === expectedEvidence &&
    contextPathsOk.every(Boolean);
  const preinstallItems = [];
  for (const path of ["node_modules", "dist", "build"]) {
    if (
      await io
        .stat(resolve(cwd, path))
        .then(() => true)
        .catch(() => false)
    )
      preinstallItems.push(path);
  }
  checks.push(
    check(
      "CONFIG_AND_ISOLATION",
      runIdOk &&
        composeProjectSyntaxValid &&
        outputPathOk &&
        !legacyTargets &&
        overridePresent.length === 0 &&
        preinstallItems.length === 0 &&
        configEvidenceValid &&
        scopedDatabaseTargets &&
        postgresComposeServices.length === 0,
      {
        runScopedResourceNames: runIdOk,
        composeProjectSyntaxValid,
        evidenceDirectoryBoundToRun: outputPathOk,
        legacyDatabaseTargetAbsent: !legacyTargets,
        fullConfigParsedFromCanonicalPath: configEvidenceValid,
        allRuntimeDatabaseTargetsRunScoped: scopedDatabaseTargets,
        baseConfigShaMatchesContext: baseConfigBytesMatch,
        databaseIsolationPolicyEnabled:
          parsedConfig?.verification?.databaseIsolation?.enabled === true,
        databaseTargetPlanValid,
        databaseTargetEvidence: configuredDatabaseTargets.map(
          ({ service, owner, database, allowedDatabase }) => ({
            service,
            owner,
            database,
            allowedDatabase,
            matchesRunScope: database === allowedDatabase,
          }),
        ),
        contextContainsNoDatabaseInputs: contextHasNoDatabaseInputs,
        postgresComposeServiceAbsent: postgresComposeServices.length === 0,
        businessDatabaseOverridesAbsent: overridePresent.length === 0,
        preinstallArtifactsAbsent: preinstallItems.length === 0,
        postgresServiceStarted: false,
      },
    ),
  );

  const snapshotStartedAtUtc = io.now();
  const issueRecords = [];
  const acceptedByIssue = new Map();
  const acceptedMergesByIssue = new Map();
  for (const number of REQUIRED_ISSUES) {
    const record = await githubIssue(io, number);
    if (record.error) {
      issueRecords.push({ number, error: record.error });
      continue;
    }
    const candidates = [];
    for (const pr of record.prs)
      if (
        pr.merged === true &&
        pr.baseRefName === "develop" &&
        isSha(pr.mergeCommit?.oid) &&
        (await isAncestor(io, cwd, pr.mergeCommit.oid, context.candidateSha))
      )
        candidates.push(pr);
    for (const candidate of candidates) {
      candidate.ancestors = [];
      for (const other of candidates)
        if (
          other !== candidate &&
          (await isAncestor(
            io,
            cwd,
            candidate.mergeCommit.oid,
            other.mergeCommit.oid,
          ))
        )
          candidate.ancestors.push(other.mergeCommit.oid);
    }
    const latest = latestAncestorMerge(candidates);
    const snapshotIssue = {
      number,
      state: record.issue.state,
      pullRequests: record.prs,
      acceptedMergeCommit: latest?.mergeCommit?.oid ?? null,
      ambiguousAcceptedMerges: latest?.ambiguous ? latest.candidates : [],
    };
    issueRecords.push(snapshotIssue);
    acceptedByIssue.set(number, latest?.ambiguous ? null : latest);
    acceptedMergesByIssue.set(
      number,
      new Set(candidates.map((candidate) => candidate.mergeCommit.oid)),
    );
  }
  const referencedInputIssues = new Set();
  if (typeof yamlLoad === "function") {
    for (const number of REQUIRED_ISSUES) {
      const accepted = acceptedByIssue.get(number);
      if (!accepted?.mergeCommit?.oid) continue;
      const source = await gitObject(
        io,
        cwd,
        `${accepted.mergeCommit.oid}:evidence/handoffs/issue-${number}.yaml`,
      );
      const parsed =
        source === null ? null : parseHandoff(source, number, yamlLoad);
      for (const input of parsed?.inputs ?? []) {
        const inputIssue = Number(input.issue);
        if (!REQUIRED_ISSUES.includes(inputIssue))
          referencedInputIssues.add(inputIssue);
      }
    }
  }
  for (const number of [...referencedInputIssues].sort(
    (left, right) => left - right,
  )) {
    const record = await githubIssue(io, number);
    if (record.error) {
      issueRecords.push({
        number,
        error: record.error,
        supplementalHandoffInput: true,
      });
      acceptedMergesByIssue.set(number, new Set());
      continue;
    }
    const mergedDevelop = record.prs.filter(
      (pr) =>
        pr.merged === true &&
        pr.baseRefName === "develop" &&
        isSha(pr.mergeCommit?.oid),
    );
    issueRecords.push({
      number,
      state: record.issue.state,
      pullRequests: record.prs,
      supplementalHandoffInput: true,
    });
    acceptedMergesByIssue.set(
      number,
      new Set(
        record.issue.state === "CLOSED"
          ? mergedDevelop.map((pr) => pr.mergeCommit.oid)
          : [],
      ),
    );
  }
  const issueFailures = issueRecords.filter(
    (record) =>
      REQUIRED_ISSUES.includes(record.number) &&
      (record.error ||
        record.state !== "CLOSED" ||
        !record.acceptedMergeCommit ||
        record.ambiguousAcceptedMerges?.length),
  );
  const fetchedRequiredIssueCount = issueRecords.filter((record) =>
    REQUIRED_ISSUES.includes(record.number),
  ).length;
  checks.push(
    check(
      "GITHUB_PREDECESSORS",
      issueFailures.length === 0 &&
        fetchedRequiredIssueCount === REQUIRED_ISSUES.length,
      {
        requiredIssueCount: REQUIRED_ISSUES.length,
        fetchedIssueCount: fetchedRequiredIssueCount,
        closedWithDevelopMergeAncestorCount: issueRecords.filter(
          (record) =>
            record.state === "CLOSED" &&
            record.acceptedMergeCommit &&
            !record.ambiguousAcceptedMerges?.length,
        ).length,
        failures: issueFailures.map(
          ({ number, error, state, ambiguousAcceptedMerges }) => ({
            number,
            error: error ?? null,
            state: state ?? null,
            ambiguousAcceptedMerges: ambiguousAcceptedMerges ?? [],
          }),
        ),
      },
    ),
  );
  const snapshot = {
    repository: REPOSITORY,
    fetchedAtUtc: snapshotStartedAtUtc,
    issues: issueRecords,
  };
  const snapshotText = `${JSON.stringify(snapshot, null, 2)}\n`;
  const githubSnapshot = {
    repository: REPOSITORY,
    fetchedAtUtc: snapshotStartedAtUtc,
    sha256: digest(snapshotText),
    issues: issueRecords,
  };

  let handoffSupplement = null;
  try {
    handoffSupplement = JSON.parse(
      await io.readFile(resolve(cwd, HANDOFF_SUPPLEMENT_PATH), "utf8"),
    );
  } catch {
    /* absent or invalid supplement fails its fixed issue scope closed */
  }
  const handoffSupplementValid =
    acceptedHandoffSupplementValid(handoffSupplement);
  checks.push(
    check("ACCEPTED_HANDOFF_SUPPLEMENT", handoffSupplementValid, {
      path: HANDOFF_SUPPLEMENT_PATH,
      issueScope: SUPPLEMENTED_ISSUES,
      closedSchema: handoffSupplementValid,
      authorization: handoffSupplementValid
        ? handoffSupplement.authorization.authority
        : null,
    }),
  );
  const supplementByIssue = new Map(
    (handoffSupplementValid ? handoffSupplement.records : []).map((record) => [
      record.issue,
      record,
    ]),
  );
  const handoffChecks = [];
  for (const number of REQUIRED_ISSUES) {
    const accepted = acceptedByIssue.get(number);
    if (!accepted?.mergeCommit?.oid) {
      handoffChecks.push(
        check(`HANDOFF_${number}`, false, {
          coverage:
            "no unique accepted develop merge ancestor; handoff not treated as verified",
        }),
      );
      continue;
    }
    if (SUPPLEMENTED_ISSUES.includes(number)) {
      const supplement = supplementByIssue.get(number);
      handoffChecks.push(
        bootstrapReady && handoffSupplementValid && supplement
          ? await evaluateAcceptedHandoffSupplement(
              io,
              cwd,
              supplement,
              acceptedByIssue,
              context.candidateSha,
              yamlLoad,
            )
          : check(`HANDOFF_${number}`, false, {
              coverage:
                "approved accepted-handoff supplement unavailable or invalid; historical proof not inferred",
            }),
      );
    } else {
      handoffChecks.push(
        bootstrapReady
          ? await evaluateHandoff(
              io,
              cwd,
              number,
              accepted.mergeCommit.oid,
              acceptedMergesByIssue,
              context.candidateSha,
              yamlLoad,
            )
          : check(`HANDOFF_${number}`, false, {
              coverage:
                "source-root YAML tooling unavailable; historical proof not inferred",
            }),
      );
    }
  }
  checks.push(...handoffChecks);

  const cpuInfo = await io.readFile("/proc/cpuinfo", "utf8").catch(() => "");
  const cpuFlags =
    cpuInfo.match(/^flags\s*:\s*(.+)$/m)?.[1]?.split(/\s+/) ?? [];
  const nativeCapacity = {
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    avx: cpuFlags.includes("avx"),
    aes: cpuFlags.includes("aes"),
    capacityEvidenceAccepted: false,
  };
  checks.push(check("NATIVE_CAPACITY_SCOPE", true, nativeCapacity));
  let toolchain = null;
  try {
    toolchain = JSON.parse(
      await io.readFile(resolve(cwd, "config/toolchain-versions.json"), "utf8"),
    );
  } catch {
    /* declared image remains unknown */
  }
  const declaredNodeImage =
    typeof toolchain?.nodeImage === "string" ? toolchain.nodeImage : null;
  const declaredNginxImage =
    typeof toolchain?.nginxImage === "string" ? toolchain.nginxImage : null;
  const declaredNginxImagePinned = Boolean(
    declaredNginxImage &&
    /@sha256:[0-9a-f]{64}$/.test(declaredNginxImage) &&
    toolchain.nginxImageIndexDigest ===
      declaredNginxImage.slice(declaredNginxImage.indexOf("@") + 1),
  );
  const declaredBomPinned = Boolean(
    declaredNodeImage &&
    /@sha256:[0-9a-f]{64}$/.test(declaredNodeImage) &&
    declaredNginxImagePinned,
  );
  let actualRuntimeProof;
  try {
    actualRuntimeProof = await nativeImageRuntimeProof(io, toolchain, context);
  } catch {
    actualRuntimeProof = {
      node: { status: "FAIL", failure: "Docker proof failed" },
      nativeNginx: { status: "FAIL", failure: "Docker proof failed" },
      daemon: { os: null, architecture: null },
      endpointKind: "unsupported",
      passed: false,
    };
  }
  checks.push(
    check(
      "NATIVE_IMAGE_RUNTIME_IDENTITY",
      declaredBomPinned && actualRuntimeProof.passed,
      {
        declaredBomImages: {
          node: declaredNodeImage,
          nativeNginx: declaredNginxImage,
        },
        declaredBomIndexDigest: toolchain?.nginxImageIndexDigest ?? null,
        declaredBomPinned,
        actualRuntimeProof: {
          endpointKind: actualRuntimeProof.endpointKind,
          daemon: actualRuntimeProof.daemon,
          node: actualRuntimeProof.node,
          nativeNginx: actualRuntimeProof.nativeNginx,
        },
        runtimeImageIds: {
          node: actualRuntimeProof.node.imageId ?? null,
          nativeNginx: actualRuntimeProof.nativeNginx.imageId ?? null,
        },
        scope:
          "pinned Node and nginx base-image digest, image ID, linux/amd64 metadata and runtime version only; no application-image, capacity or deployment proof",
      },
    ),
  );
  const limitations = [
    "G00 проверяет read-only GitHub, Git и локальные config/evidence; Docker запускает только локальные pinned Node/nginx base images с версиями, без PostgreSQL/SQL, Compose, provider, сети, mount, secret или port.",
  ];
  limitations.push(
    "Native base-image proof не покрывает application images и capacity; пропуск этих проверок остаётся отдельным launch blocker.",
  );
  if (!nativeCapacity.avx || !nativeCapacity.aes)
    limitations.push(
      `Native host: ${nativeCapacity.cpuCount} CPU, ${nativeCapacity.memoryBytes} bytes RAM, AVX=${nativeCapacity.avx}, AES=${nativeCapacity.aes}; capacity evidence не принимается, QEMU capacity не подменяет native.`,
    );
  if (context.githubSnapshotPath)
    limitations.push(
      "Переданный githubSnapshotPath записан только как reference; offline snapshot не использовался как authority.",
    );
  return {
    schemaVersion: 1,
    gateId: "preflight",
    runId: context.runId,
    candidateSha: context.candidateSha,
    status: checks.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
    checks,
    limitations,
    githubSnapshot,
  };
}

async function main() {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextPath || !isAbsolute(contextPath)) {
    console.error(
      "G00_PREFLIGHT FAIL: отсутствует абсолютный COFFEE_LAUNCH_CONTEXT_FILE",
    );
    process.exitCode = 1;
    return;
  }
  let context;
  try {
    context = JSON.parse(await readFile(contextPath, "utf8"));
  } catch {
    console.error(
      "G00_PREFLIGHT FAIL: runner context недоступен или некорректен",
    );
    process.exitCode = 1;
    return;
  }
  const result = await runPreflight(context);
  const artifactPath = await safeArtifactPath(context, contextPath);
  if (
    !artifactPath ||
    !constants.O_NOFOLLOW ||
    !(await ensureSafeDirectoryTree(
      resolve(context.sourceRepoRoot),
      dirname(artifactPath),
    ))
  ) {
    console.error(
      "G00_PREFLIGHT FAIL: artifact path не является реальным каталогом текущего runner run-id",
    );
    process.exitCode = 1;
    return;
  }
  let artifact;
  try {
    artifact = await open(
      artifactPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await artifact.writeFile(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    console.error(
      "G00_PREFLIGHT FAIL: невозможно безопасно сохранить artifact текущего run-id",
    );
    process.exitCode = 1;
    return;
  } finally {
    await artifact?.close().catch(() => {});
  }
  console.log(
    `G00_PREFLIGHT ${result.status}: ${result.checks.filter((item) => item.status === "PASS").length}/${result.checks.length} checks; run=${result.runId}; sha=${result.candidateSha}`,
  );
  process.exitCode = result.status === "PASS" ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
)
  await main();
