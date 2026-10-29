import { createHash, randomUUID } from "node:crypto";
import {
  execFile as nodeExecFile,
  spawn as nodeSpawn,
} from "node:child_process";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isIPv4 } from "node:net";

const execFile = promisify(nodeExecFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE_CONFIG = "config/toolchain-versions.json";
const NONCE_LABEL = "io.coffeeorderplatform.g15.browser.nonce";
const PROJECT_LABEL = "io.coffeeorderplatform.g15.browser.project";
const RUN_LABEL = "io.coffeeorderplatform.g15.browser.run";
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const SAFE_CODES = new Set([
  "G15_BROWSER_CONTEXT_INVALID",
  "G15_BROWSER_NGINX_IDENTITY_INVALID",
  "G15_BROWSER_NETWORK_INVALID",
  "G15_BROWSER_IMAGE_PIN_INVALID",
  "G15_BROWSER_IMAGE_UNAVAILABLE",
  "G15_BROWSER_FIXTURE_HOME_INVALID",
  "G15_BROWSER_CHROMIUM_INVALID",
  "G15_BROWSER_CREATE_FAILED",
  "G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED",
  "G15_BROWSER_CONTAINER_IDENTITY_INVALID",
  "G15_BROWSER_START_FAILED",
  "G15_BROWSER_EXEC_FAILED",
  "G15_BROWSER_ENDPOINT_INVALID",
  "G15_BROWSER_CONNECT_FAILED",
  "G15_BROWSER_CLEANUP_UNCONFIRMED",
  "G15_BROWSER_DOCKER_FAILED",
  "G15_BROWSER_TIMEOUT",
]);

function fail(code) {
  throw new Error(SAFE_CODES.has(code) ? code : "G15_BROWSER_DOCKER_FAILED");
}

function safeCode(error, fallback) {
  if (error?.code === "ETIMEDOUT" || error?.killed)
    return "G15_BROWSER_TIMEOUT";
  return SAFE_CODES.has(error?.message) ? error.message : fallback;
}

function validProjectName(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value);
}

function validRunId(value) {
  return (
    typeof value === "string" && /^\d{8}T\d{6}Z-[0-9a-f]{7,12}$/u.test(value)
  );
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    fail(code);
  }
}

function ipInSubnet(address, subnet) {
  if (!isIPv4(address) || typeof subnet !== "string") return false;
  const [network, prefixText, ...extra] = subnet.split("/");
  const prefix = Number(prefixText);
  if (
    !isIPv4(network) ||
    extra.length ||
    !Number.isInteger(prefix) ||
    prefix < 1 ||
    prefix > 30
  )
    return false;
  const toInt = (value) =>
    value
      .split(".")
      .reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = toInt(network);
  const addressInt = toInt(address);
  return (
    (networkInt & mask) >>> 0 === networkInt &&
    (addressInt & mask) >>> 0 === networkInt &&
    addressInt !== networkInt &&
    addressInt !== (networkInt | (~mask >>> 0)) >>> 0 &&
    !address.startsWith("127.")
  );
}

async function docker(args, { timeout = 10000 } = {}) {
  try {
    const result = await execFile("docker", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error?.code === "ETIMEDOUT") fail("G15_BROWSER_TIMEOUT");
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: typeof error?.stdout === "string" ? error.stdout : "",
      stderr: typeof error?.stderr === "string" ? error.stderr : "",
    };
  }
}

async function checked(runDocker, args, code, timeout) {
  const result = await runDocker(args, { timeout });
  if (result.code !== 0) fail(code);
  return result.stdout;
}

async function containerRow(runDocker, id, expected) {
  const output = await checked(
    runDocker,
    ["inspect", id],
    "G15_BROWSER_DOCKER_FAILED",
    10000,
  );
  const rows = parseJson(output, "G15_BROWSER_DOCKER_FAILED");
  if (!Array.isArray(rows) || rows.length !== 1)
    fail("G15_BROWSER_DOCKER_FAILED");
  const row = rows[0];
  const labels = row.Config?.Labels ?? {};
  if (
    row.Id !== expected.id ||
    row.Name !== `/${expected.name}` ||
    row.Image !== expected.imageId ||
    labels[NONCE_LABEL] !== expected.nonce ||
    labels[PROJECT_LABEL] !== expected.projectName ||
    labels[RUN_LABEL] !== expected.runId
  )
    fail("G15_BROWSER_CONTAINER_IDENTITY_INVALID");
  return row;
}

async function inspectNginx(runDocker, context) {
  const output = await checked(
    runDocker,
    ["inspect", context.nginxContainerId],
    "G15_BROWSER_NGINX_IDENTITY_INVALID",
    10000,
  );
  const rows = parseJson(output, "G15_BROWSER_NGINX_IDENTITY_INVALID");
  if (!Array.isArray(rows) || rows.length !== 1)
    fail("G15_BROWSER_NGINX_IDENTITY_INVALID");
  const row = rows[0];
  const labels = row.Config?.Labels ?? {};
  const networkName = context.networks?.coffee_edge_backend;
  const network = row.NetworkSettings?.Networks?.[networkName];
  if (
    row.Id !== context.nginxContainerId ||
    labels["com.docker.compose.project"] !== context.projectName ||
    labels["com.docker.compose.service"] !== "edge-nginx" ||
    row.State?.Running !== true ||
    !networkName ||
    !network?.NetworkID ||
    !isIPv4(network.IPAddress) ||
    network.IPAddress.startsWith("127.")
  )
    fail("G15_BROWSER_NGINX_IDENTITY_INVALID");

  const networkOutput = await checked(
    runDocker,
    ["network", "inspect", networkName],
    "G15_BROWSER_NETWORK_INVALID",
    10000,
  );
  const networkRows = parseJson(networkOutput, "G15_BROWSER_NETWORK_INVALID");
  const networkRow =
    Array.isArray(networkRows) && networkRows.length === 1
      ? networkRows[0]
      : null;
  const networkLabels = networkRow?.Labels ?? {};
  const subnet = networkRow?.IPAM?.Config?.find((item) => item.Subnet)?.Subnet;
  if (
    networkRow?.Id !== network.NetworkID ||
    networkRow?.Name !== networkName ||
    networkRow?.Driver !== "bridge" ||
    networkLabels["com.docker.compose.project"] !== context.projectName ||
    networkLabels["com.docker.compose.network"] !== "coffee_edge_backend" ||
    !ipInSubnet(network.IPAddress, subnet)
  )
    fail("G15_BROWSER_NETWORK_INVALID");
  return {
    networkName,
    networkId: network.NetworkID,
    bridgeAddress: network.IPAddress,
  };
}

async function pinnedImage(runDocker) {
  let toolchain;
  try {
    toolchain = JSON.parse(
      await readFile(join(REPO_ROOT, IMAGE_CONFIG), "utf8"),
    );
  } catch {
    fail("G15_BROWSER_IMAGE_PIN_INVALID");
  }
  const imageRef = toolchain.browserHelperNodeImage;
  const match =
    typeof imageRef === "string" &&
    imageRef.match(/^(node:26\.8\.1-trixie-slim)@(sha256:[0-9a-f]{64})$/u);
  if (!match) fail("G15_BROWSER_IMAGE_PIN_INVALID");
  const output = await checked(
    runDocker,
    ["image", "inspect", "--format", "{{.Id}}|{{json .RepoDigests}}", imageRef],
    "G15_BROWSER_IMAGE_UNAVAILABLE",
    10000,
  );
  const [id, digestsText, ...extra] = output.trim().split("|");
  const digests = parseJson(digestsText, "G15_BROWSER_IMAGE_UNAVAILABLE");
  if (
    extra.length ||
    !IMAGE_ID.test(id ?? "") ||
    !Array.isArray(digests) ||
    !digests.includes(`node@${match[2]}`)
  )
    fail("G15_BROWSER_IMAGE_UNAVAILABLE");
  return { imageRef, imageId: id };
}

async function validateFixtureHome(context) {
  const home = context.browserFixture?.browser?.homePath;
  const profile = context.browserFixture?.browser?.nssProfilePath;
  if (typeof home !== "string" || typeof profile !== "string")
    fail("G15_BROWSER_FIXTURE_HOME_INVALID");
  try {
    const canonicalHome = resolve(home);
    const homeInfo = await lstat(canonicalHome);
    if (
      homeInfo.isSymbolicLink() ||
      !homeInfo.isDirectory() ||
      homeInfo.uid !== 1000 ||
      (homeInfo.mode & 0o777) !== 0o700 ||
      (await realpath(canonicalHome)) !== canonicalHome ||
      resolve(profile) !== join(canonicalHome, ".local/share/pki/nssdb")
    )
      fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    const expectedDirs = [
      canonicalHome,
      join(canonicalHome, ".local"),
      join(canonicalHome, ".local/share"),
      join(canonicalHome, ".local/share/pki"),
      resolve(profile),
    ];
    for (const directory of expectedDirs) {
      const info = await lstat(directory);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        info.uid !== 1000 ||
        (info.mode & 0o777) !== 0o700 ||
        (await realpath(directory)) !== directory
      )
        fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    }
    if ((await readdir(canonicalHome)).some((name) => name !== ".local"))
      fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    for (const [directory, expectedName] of [
      [join(canonicalHome, ".local"), "share"],
      [join(canonicalHome, ".local/share"), "pki"],
      [join(canonicalHome, ".local/share/pki"), "nssdb"],
    ]) {
      const contents = await readdir(directory);
      if (contents.length !== 1 || contents[0] !== expectedName)
        fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    }
    const names = await readdir(profile);
    if (
      !names.length ||
      names.some(
        (name) => !["cert9.db", "key4.db", "pkcs11.txt"].includes(name),
      )
    )
      fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    for (const name of names) {
      const path = join(profile, name);
      const info = await lstat(path);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.uid !== 1000 ||
        (info.mode & 0o777) !== 0o600
      )
        fail("G15_BROWSER_FIXTURE_HOME_INVALID");
    }
    return canonicalHome;
  } catch (error) {
    if (error?.message === "G15_BROWSER_FIXTURE_HOME_INVALID") throw error;
    fail("G15_BROWSER_FIXTURE_HOME_INVALID");
  }
}

async function chromiumPaths(chromium) {
  let executable;
  try {
    executable = chromium.executablePath();
    const pathInfo = await lstat(executable);
    const directory = dirname(executable);
    const directoryInfo = await stat(directory);
    const nodeModules = join(REPO_ROOT, "node_modules");
    const nodeModulesInfo = await lstat(nodeModules);
    const librariesPath = "/usr/lib/x86_64-linux-gnu";
    const librariesInfo = await lstat(librariesPath);
    await access(executable);
    await access(join(nodeModules, "playwright/index.mjs"));
    await access(librariesPath);
    if (
      pathInfo.isSymbolicLink() ||
      !pathInfo.isFile() ||
      !directoryInfo.isDirectory() ||
      (await realpath(directory)) !== directory ||
      nodeModulesInfo.isSymbolicLink() ||
      !nodeModulesInfo.isDirectory() ||
      (await realpath(nodeModules)) !== nodeModules ||
      librariesInfo.isSymbolicLink() ||
      !librariesInfo.isDirectory() ||
      (await realpath(librariesPath)) !== librariesPath
    )
      fail("G15_BROWSER_CHROMIUM_INVALID");
    return { executable, directory, nodeModules };
  } catch (error) {
    if (error?.message === "G15_BROWSER_CHROMIUM_INVALID") throw error;
    fail("G15_BROWSER_CHROMIUM_INVALID");
  }
}

function mount(source, target, readonly = true) {
  return [
    "--mount",
    `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`,
  ];
}

function buildCreateArgs({
  context,
  name,
  nonce,
  imageId,
  paths,
  home,
  cidfile,
}) {
  return [
    "create",
    "--cidfile",
    cidfile,
    "--name",
    name,
    "--label",
    `${NONCE_LABEL}=${nonce}`,
    "--label",
    `${PROJECT_LABEL}=${context.projectName}`,
    "--label",
    `${RUN_LABEL}=${context.runId}`,
    "--pull=never",
    "--user",
    "1000:1000",
    "--cpus=2",
    "--memory=2048m",
    "--memory-swap=2048m",
    "--pids-limit=128",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=700",
    "--network",
    `container:${context.nginxContainerId}`,
    "--workdir",
    "/tmp",
    "--env",
    "HOME=/home/node",
    ...mount(paths.directory, paths.directory),
    ...mount("/usr/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu"),
    ...mount(paths.nodeModules, paths.nodeModules),
    ...mount(home, "/home/node", false),
    imageId,
    "node",
    "--input-type=module",
    "--eval",
    "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)",
  ];
}

function serverSource(chromiumModule, executable) {
  const moduleUrl = pathToFileURL(chromiumModule).href;
  return `import{chromium}from${JSON.stringify(moduleUrl)};const s=await chromium.launchServer({host:'0.0.0.0',port:0,headless:true,executablePath:${JSON.stringify(executable)}});process.stdout.write(s.wsEndpoint()+'\\n');process.stdin.resume();process.stdin.once('end',async()=>{await s.close();process.exit(0)});`;
}

function parseEndpoint(line, bridgeAddress) {
  let url;
  try {
    url = new URL(line.trim());
  } catch {
    fail("G15_BROWSER_ENDPOINT_INVALID");
  }
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "0.0.0.0" ||
    url.username ||
    url.password ||
    !url.port ||
    !/^\/[A-Za-z0-9_-]{8,}$/u.test(url.pathname) ||
    url.search ||
    url.hash
  )
    fail("G15_BROWSER_ENDPOINT_INVALID");
  const hash = createHash("sha256").update(line.trim()).digest("hex");
  url.hostname = bridgeAddress;
  return { endpoint: url.toString(), endpointSha256: hash };
}

function spawnServer(spawnProcess, cid, source) {
  try {
    return spawnProcess(
      "docker",
      ["exec", "-i", cid, "node", "--input-type=module", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    fail("G15_BROWSER_EXEC_FAILED");
  }
}

async function readEndpoint(server, timeoutMs = 15000) {
  return await new Promise((resolvePromise, rejectPromise) => {
    let line = "";
    const timeout = setTimeout(() => finish("G15_BROWSER_TIMEOUT"), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timeout);
      server.stdout?.removeListener("data", onData);
      server.removeListener?.("error", onError);
      if (error) rejectPromise(new Error(error));
      else resolvePromise(value);
    };
    const onData = (chunk) => {
      line += chunk.toString("utf8");
      if (line.length > 2048) return finish("G15_BROWSER_ENDPOINT_INVALID");
      const newline = line.indexOf("\n");
      if (newline >= 0) finish(null, line.slice(0, newline));
    };
    const onError = () => finish("G15_BROWSER_EXEC_FAILED");
    server.stdout?.on("data", onData);
    server.stderr?.on("data", () => {});
    server.once?.("error", onError);
    server.once?.("exit", (code) => {
      if (code !== null && code !== undefined)
        finish("G15_BROWSER_EXEC_FAILED");
    });
  });
}

async function stopAndRemove(runDocker, expected) {
  let row;
  try {
    row = await containerRow(runDocker, expected.id, expected);
  } catch {
    fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
  }
  if (row.State?.Running) {
    const stopped = await runDocker(
      ["container", "stop", "--time", "2", expected.id],
      { timeout: 5000 },
    );
    if (stopped.code !== 0) {
      try {
        const afterStop = await containerRow(runDocker, expected.id, expected);
        if (afterStop.State?.Running) fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
      } catch {
        fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
      }
    }
  }
  const beforeRemove = await containerRow(runDocker, expected.id, expected);
  if (beforeRemove.State?.Running) fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
  const removed = await runDocker(["container", "rm", expected.id], {
    timeout: 5000,
  });
  if (removed.code !== 0) fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
  const absent = await runDocker(["inspect", expected.id], { timeout: 5000 });
  if (absent.code === 0 || !/No such object/iu.test(absent.stderr ?? ""))
    fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
}

async function recoverCreate(runDocker, name, expected, cidfile) {
  let id = "";
  try {
    id = (await readFile(cidfile, "utf8")).trim();
  } catch {
    // The nonce-specific name inspection below is the other ownership witness.
  }
  const result = await runDocker(["container", "inspect", name], {
    timeout: 5000,
  });
  if (result.code !== 0) return null;
  const rows = parseJson(
    result.stdout,
    "G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED",
  );
  if (!Array.isArray(rows) || rows.length !== 1)
    fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
  const row = rows[0];
  const foundId = row.Id;
  if (!CONTAINER_ID.test(foundId ?? "") || (id && id !== foundId))
    fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
  const actual = { ...expected, id: foundId };
  try {
    await containerRow(runDocker, foundId, actual);
  } catch {
    fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
  }
  return actual;
}

/** Start a remote Chromium instance with its network namespace bound to edge-nginx. */
export async function startG15Browser(
  runtimeContext,
  {
    runDocker = docker,
    spawnProcess = nodeSpawn,
    chromium: injectedChromium,
  } = {},
) {
  if (
    !runtimeContext ||
    !validProjectName(runtimeContext.projectName) ||
    !validRunId(runtimeContext.runId) ||
    !CONTAINER_ID.test(runtimeContext.nginxContainerId ?? "") ||
    runtimeContext.networks?.coffee_edge_backend !==
      `${runtimeContext.projectName}_coffee_edge_backend`
  )
    fail("G15_BROWSER_CONTEXT_INVALID");

  let chromium = injectedChromium;
  if (!chromium) {
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      fail("G15_BROWSER_CHROMIUM_INVALID");
    }
  }
  const [nginx, image, home, paths] = await Promise.all([
    inspectNginx(runDocker, runtimeContext),
    pinnedImage(runDocker),
    validateFixtureHome(runtimeContext),
    chromiumPaths(chromium),
  ]);
  const nonce = randomUUID().replaceAll("-", "");
  const name = `coffee-g15-browser-${nonce.slice(0, 16)}`;
  let workDir;
  let expected;
  let server;
  let browser;
  let ambiguousCreate = false;
  let cleanupStarted = false;
  const witness = {
    status: "STARTING",
    containerId: null,
    imageId: image.imageId,
    nginxContainerId: runtimeContext.nginxContainerId,
    networkId: nginx.networkId,
    networkName: nginx.networkName,
    bridgeAddress: nginx.bridgeAddress,
    endpointSha256: null,
    endpointStored: false,
  };

  const clean = async () => {
    if (cleanupStarted) return witness.cleanup;
    cleanupStarted = true;
    if (ambiguousCreate) {
      witness.cleanup = "UNCONFIRMED";
      fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
    }
    let cleanupFailed = false;
    try {
      await browser?.close();
    } catch {
      cleanupFailed = true;
    }
    browser = null;
    try {
      if (server?.stdin && !server.stdin.destroyed) server.stdin.end();
      if (server) {
        await new Promise((resolvePromise, rejectPromise) => {
          const timer = setTimeout(
            () => rejectPromise(new Error("G15_BROWSER_TIMEOUT")),
            8000,
          );
          const onExit = (code) => {
            clearTimeout(timer);
            server.removeListener("exit", onExit);
            if (code === 0) resolvePromise();
            else rejectPromise(new Error("G15_BROWSER_EXEC_FAILED"));
          };
          server.once("exit", onExit);
          if (server.exitCode !== null) onExit(server.exitCode);
        });
      }
    } catch {
      cleanupFailed = true;
    }
    try {
      if (expected) await stopAndRemove(runDocker, expected);
      witness.cleanup = expected
        ? "EXACT_OWNED_CONTAINER_REMOVED"
        : "NO_CONTAINER_CREATED";
    } catch {
      cleanupFailed = true;
      witness.cleanup = "UNCONFIRMED";
    }
    if (!cleanupFailed && workDir) {
      try {
        await rm(workDir, { recursive: true, force: false });
      } catch {
        cleanupFailed = true;
        witness.cleanup = "UNCONFIRMED";
      }
    }
    if (cleanupFailed) fail("G15_BROWSER_CLEANUP_UNCONFIRMED");
    return witness.cleanup;
  };

  try {
    workDir = await mkdtemp(join(tmpdir(), "coffee-g15-browser-"));
    const cidfile = join(workDir, "container.cid");
    const createArgs = buildCreateArgs({
      context: runtimeContext,
      name,
      nonce,
      imageId: image.imageId,
      paths,
      home,
      cidfile,
    });
    const ownership = {
      name,
      imageId: image.imageId,
      nonce,
      projectName: runtimeContext.projectName,
      runId: runtimeContext.runId,
    };
    const recoverAttempt = async () => {
      try {
        expected = await recoverCreate(runDocker, name, ownership, cidfile);
      } catch {
        expected = undefined;
      }
      if (expected) {
        ambiguousCreate = false;
        witness.containerId = expected.id;
      }
      return expected;
    };

    // Until exact identity is recovered, a failed or timed-out create may still
    // finish later. Keep its nonce and cidfile as the only cleanup evidence.
    ambiguousCreate = true;
    let create;
    try {
      create = await runDocker(createArgs, { timeout: 30000 });
    } catch {
      if (!(await recoverAttempt()))
        fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
      fail("G15_BROWSER_CREATE_FAILED");
    }
    if (create.code !== 0) {
      if (!(await recoverAttempt()))
        fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
      fail("G15_BROWSER_CREATE_FAILED");
    }
    const cid = create.stdout.trim();
    if (!CONTAINER_ID.test(cid)) {
      if (!(await recoverAttempt()))
        fail("G15_BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
      fail("G15_BROWSER_CREATE_FAILED");
    }
    expected = {
      id: cid,
      name,
      imageId: image.imageId,
      nonce,
      projectName: runtimeContext.projectName,
      runId: runtimeContext.runId,
    };
    await containerRow(runDocker, cid, expected);
    ambiguousCreate = false;
    witness.containerId = cid;
    const started = await runDocker(["container", "start", cid], {
      timeout: 15000,
    });
    if (started.code !== 0) fail("G15_BROWSER_START_FAILED");
    const source = serverSource(
      join(paths.nodeModules, "playwright/index.mjs"),
      paths.executable,
    );
    server = spawnServer(spawnProcess, cid, source);
    const line = await readEndpoint(server);
    const parsed = parseEndpoint(line, nginx.bridgeAddress);
    witness.endpointSha256 = parsed.endpointSha256;
    try {
      browser = await chromium.connect(parsed.endpoint, { timeout: 15000 });
    } catch {
      fail("G15_BROWSER_CONNECT_FAILED");
    }
    witness.status = "READY";
    return { browser, close: clean, witness };
  } catch (error) {
    const code = safeCode(error, "G15_BROWSER_DOCKER_FAILED");
    try {
      await clean();
    } catch {
      // Keep the original safe failure while the witness records uncertain cleanup.
    }
    fail(code);
  }
}
