import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  chmod,
  writeFile,
  rm,
  access,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startBrowser } from "../../tools/browser-driver.mjs";

const nginxId = "a".repeat(64);
const browserId = "b".repeat(64);
const projectName = "coffee-g15-fixture";
const runId = "20261025T110213Z-10093ab";
const networkName = `${projectName}_coffee_edge_backend`;
const networkId = "c".repeat(64);
const browserImageId = `sha256:${"d".repeat(64)}`;
const nodeImageDigest = JSON.parse(
  await readFile(
    new URL("../../config/toolchain-versions.json", import.meta.url),
    "utf8",
  ),
).browserHelperNodeImage.split("@")[1];
const endpointCanary = "ws://0.0.0.0:43210/browserEndpointCanary123456";

async function makeFixtureHome() {
  const root = await mkdtemp(join(tmpdir(), "g15-driver-test-"));
  const homePath = join(root, "browser-home");
  const nssProfilePath = join(homePath, ".local/share/pki/nssdb");
  await mkdir(nssProfilePath, { recursive: true, mode: 0o700 });
  for (const directory of [
    homePath,
    join(homePath, ".local"),
    join(homePath, ".local/share"),
    join(homePath, ".local/share/pki"),
    nssProfilePath,
  ])
    await chmod(directory, 0o700);
  await writeFile(join(nssProfilePath, "cert9.db"), "public certificate db", {
    mode: 0o600,
  });
  await writeFile(join(nssProfilePath, "key4.db"), "empty nss key store", {
    mode: 0o600,
  });
  await writeFile(join(nssProfilePath, "pkcs11.txt"), "library=", {
    mode: 0o600,
  });
  const executablePath = join(root, "chrome");
  await writeFile(executablePath, "test executable", { mode: 0o700 });
  return { root, homePath, nssProfilePath, executablePath };
}

function makeContext(home) {
  return {
    projectName,
    runId,
    candidateSha: "e".repeat(40),
    nginxContainerId: nginxId,
    networks: { coffee_edge_backend: networkName },
    browserFixture: {
      browser: {
        homePath: home.homePath,
        nssProfilePath: home.nssProfilePath,
      },
    },
  };
}

function createFakeDocker({
  nginxService = "edge-nginx",
  failRemove = false,
  failCreate = false,
  throwCreate = false,
  failRecoveryInspect = false,
  mismatchedContainerLabel = false,
} = {}) {
  const calls = [];
  let containerExists = false;
  let running = false;
  let labels = {};
  let name = "";
  const runDocker = async (args) => {
    calls.push(args);
    if (args[0] === "image")
      return {
        code: 0,
        stdout: `${browserImageId}|["node@${nodeImageDigest}"]\n`,
      };
    if (args[0] === "inspect" && args[1] === nginxId)
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Id: nginxId,
            Config: {
              Labels: {
                "com.docker.compose.project": projectName,
                "com.docker.compose.service": nginxService,
              },
            },
            State: { Running: true },
            NetworkSettings: {
              Networks: {
                [networkName]: {
                  NetworkID: networkId,
                  IPAddress: "172.28.0.3",
                },
              },
            },
          },
        ]),
      };
    if (args[0] === "network" && args[1] === "inspect")
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Id: networkId,
            Name: networkName,
            Driver: "bridge",
            Labels: {
              "com.docker.compose.project": projectName,
              "com.docker.compose.network": "coffee_edge_backend",
            },
            IPAM: { Config: [{ Subnet: "172.28.0.0/16" }] },
          },
        ]),
      };
    if (args[0] === "create") {
      if (failCreate) return { code: 1, stdout: "" };
      containerExists = true;
      name = args[args.indexOf("--name") + 1];
      labels = {};
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label") {
          const [key, ...value] = args[index + 1].split("=");
          labels[key] = value.join("=");
        }
      }
      if (mismatchedContainerLabel)
        labels["io.coffeeorderplatform.g15.browser.nonce"] = "f".repeat(32);
      if (throwCreate) throw new Error("private create response canary");
      return { code: 0, stdout: `${browserId}\n` };
    }
    if (args[0] === "container" && args[1] === "start") {
      running = true;
      return { code: 0, stdout: "" };
    }
    if (args[0] === "inspect" && [browserId, name].includes(args[1])) {
      if (!containerExists)
        return { code: 1, stdout: "", stderr: "Error: No such object" };
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Id: browserId,
            Name: `/${name}`,
            Image: browserImageId,
            Config: { Labels: labels },
            State: { Running: running },
          },
        ]),
      };
    }
    if (args[0] === "container" && args[1] === "inspect" && args[2] === name) {
      if (failRecoveryInspect)
        return { code: 1, stdout: "", stderr: "daemon unavailable" };
      if (!containerExists)
        return { code: 1, stdout: "", stderr: "Error: No such object" };
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Id: browserId,
            Name: `/${name}`,
            Image: browserImageId,
            Config: { Labels: labels },
            State: { Running: running },
          },
        ]),
      };
    }
    if (args[0] === "container" && args[1] === "stop") {
      running = false;
      return { code: 0, stdout: "" };
    }
    if (args[0] === "container" && args[1] === "rm") {
      if (failRemove) return { code: 1, stdout: "" };
      containerExists = false;
      return { code: 0, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return {
    calls,
    runDocker,
    get containerExists() {
      return containerExists;
    },
  };
}

function fakeServerProcess(endpoint = endpointCanary) {
  const server = new EventEmitter();
  server.stdin = new PassThrough();
  server.stdout = new PassThrough();
  server.stderr = new PassThrough();
  server.exitCode = null;
  server.stdin.once("finish", () => {
    server.exitCode = 0;
    server.emit("exit", 0);
  });
  process.nextTick(() => server.stdout.write(`${endpoint}\n`));
  return server;
}

function fakeChromium(executablePath, { connectError } = {}) {
  const calls = [];
  return {
    calls,
    executablePath: () => executablePath,
    async connect(endpoint) {
      calls.push(endpoint);
      if (connectError) throw new Error(`${connectError}:${endpoint}`);
      return { async close() {} };
    },
  };
}

void test("browser driver binds Chromium to the verified edge namespace and keeps its endpoint private", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker();
  const chromium = fakeChromium(home.executablePath);
  const server = fakeServerProcess();
  const result = await startBrowser(makeContext(home), {
    runDocker: fakeDocker.runDocker,
    spawnProcess: () => server,
    chromium,
  });

  assert.equal(result.witness.status, "READY");
  assert.equal(result.witness.endpointStored, false);
  assert.match(result.witness.endpointSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    JSON.stringify(result.witness).includes("browserEndpointCanary"),
    false,
  );
  assert.match(chromium.calls[0], /^ws:\/\/172\.28\.0\.3:43210\//u);
  const createArgs = fakeDocker.calls.find(([command]) => command === "create");
  assert.ok(createArgs);
  assert.equal(
    createArgs[createArgs.indexOf("--network") + 1],
    `container:${nginxId}`,
  );
  assert.ok(createArgs.includes("--read-only"));
  assert.ok(createArgs.includes("--cap-drop=ALL"));
  assert.ok(createArgs.includes("--security-opt=no-new-privileges"));
  assert.ok(createArgs.includes("--cpus=2"));
  assert.ok(createArgs.includes("--memory=2048m"));
  assert.ok(createArgs.includes("--pids-limit=128"));
  assert.equal(
    createArgs.some((value) => value === "-p" || value.startsWith("-p")),
    false,
  );
  assert.ok(
    createArgs.includes(`type=bind,src=${home.homePath},dst=/home/node`),
  );

  assert.equal(await result.close(), "EXACT_OWNED_CONTAINER_REMOVED");
  assert.equal(fakeDocker.containerExists, false);
});

void test("browser driver rejects a foreign nginx identity before creating a container", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({ nginxService: "api-public" });
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: fakeDocker.runDocker,
      chromium: fakeChromium(home.executablePath),
      spawnProcess: () => assert.fail("browser process must not start"),
    }),
    { message: "BROWSER_NGINX_IDENTITY_INVALID" },
  );
  assert.equal(
    fakeDocker.calls.some(([command]) => command === "create"),
    false,
  );
});

void test("browser driver rejects a network name scoped to a different Compose project", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker();
  const context = makeContext(home);
  context.networks.coffee_edge_backend = "another-project_coffee_edge_backend";
  await assert.rejects(
    startBrowser(context, {
      runDocker: fakeDocker.runDocker,
      spawnProcess: () => assert.fail("browser process must not start"),
      chromium: fakeChromium(home.executablePath),
    }),
    { message: "BROWSER_CONTEXT_INVALID" },
  );
  assert.equal(
    fakeDocker.calls.some(([command]) => command === "create"),
    false,
  );
});

void test("browser driver preserves a created container whose exact ownership labels differ", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({ mismatchedContainerLabel: true });
  let cidfile;
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: async (args, options) => {
        if (args[0] === "create") cidfile = args[args.indexOf("--cidfile") + 1];
        return fakeDocker.runDocker(args, options);
      },
      spawnProcess: () =>
        assert.fail("server must not start for an unowned container"),
      chromium: fakeChromium(home.executablePath),
    }),
    { message: "BROWSER_CONTAINER_IDENTITY_INVALID" },
  );
  assert.equal(fakeDocker.containerExists, true);
  assert.equal(
    fakeDocker.calls.some(
      (args) => args[0] === "container" && ["stop", "rm"].includes(args[1]),
    ),
    false,
  );
  await rm(cidfile.slice(0, cidfile.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
});

void test("browser driver sanitizes connect errors and removes its exact owned container", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker();
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: fakeDocker.runDocker,
      spawnProcess: () => fakeServerProcess(),
      chromium: fakeChromium(home.executablePath, {
        connectError: "transport-secret-canary",
      }),
    }),
    (error) => {
      assert.equal(error.message, "BROWSER_CONNECT_FAILED");
      assert.equal(error.message.includes("transport-secret-canary"), false);
      assert.equal(error.message.includes("browserEndpointCanary"), false);
      return true;
    },
  );
  assert.equal(fakeDocker.containerExists, false);
});

void test("browser driver rejects WebSocket endpoint userinfo before connecting", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker();
  const chromium = fakeChromium(home.executablePath);
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: fakeDocker.runDocker,
      spawnProcess: () =>
        fakeServerProcess(
          "ws://username:privateCanary@0.0.0.0:43210/browserEndpointCanary123456",
        ),
      chromium,
    }),
    (error) => {
      assert.equal(error.message, "BROWSER_ENDPOINT_INVALID");
      assert.equal(error.message.includes("privateCanary"), false);
      return true;
    },
  );
  assert.deepEqual(chromium.calls, []);
  assert.equal(fakeDocker.containerExists, false);
});

void test("browser driver fails closed when exact-container cleanup cannot be confirmed", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({ failRemove: true });
  const result = await startBrowser(makeContext(home), {
    runDocker: fakeDocker.runDocker,
    spawnProcess: () => fakeServerProcess(),
    chromium: fakeChromium(home.executablePath),
  });
  await assert.rejects(result.close(), {
    message: "BROWSER_CLEANUP_UNCONFIRMED",
  });
  assert.equal(fakeDocker.containerExists, true);
  assert.equal(result.witness.cleanup, "UNCONFIRMED");
});

void test("browser driver retains cidfile ownership evidence after an ambiguous create", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({ failCreate: true });
  let cidfile;
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: async (args, options) => {
        if (args[0] === "create") cidfile = args[args.indexOf("--cidfile") + 1];
        return fakeDocker.runDocker(args, options);
      },
      chromium: fakeChromium(home.executablePath),
      spawnProcess: () =>
        assert.fail("server must not start after an unknown create"),
    }),
    { message: "BROWSER_CREATE_OWNERSHIP_UNCONFIRMED" },
  );
  assert.ok(cidfile);
  await access(cidfile.slice(0, cidfile.lastIndexOf("/")));
  await rm(cidfile.slice(0, cidfile.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
});

void test("browser driver recovers and removes a late container after create throws", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({ throwCreate: true });
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: fakeDocker.runDocker,
      chromium: fakeChromium(home.executablePath),
      spawnProcess: () =>
        assert.fail("server must not start after create throws"),
    }),
    { message: "BROWSER_CREATE_FAILED" },
  );
  assert.equal(fakeDocker.containerExists, false);
  assert.equal(
    fakeDocker.calls.some(
      (args) => args[0] === "container" && args[1] === "rm",
    ),
    true,
  );
});

void test("browser driver retains a thrown-create witness when recovery inspect fails", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({
    throwCreate: true,
    failRecoveryInspect: true,
  });
  let cidfile;
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: async (args, options) => {
        if (args[0] === "create") cidfile = args[args.indexOf("--cidfile") + 1];
        return fakeDocker.runDocker(args, options);
      },
      chromium: fakeChromium(home.executablePath),
      spawnProcess: () =>
        assert.fail("server must not start after create throws"),
    }),
    (error) => {
      assert.equal(error.message, "BROWSER_CREATE_OWNERSHIP_UNCONFIRMED");
      assert.equal(error.message.includes("NO_CONTAINER_CREATED"), false);
      return true;
    },
  );
  assert.equal(fakeDocker.containerExists, true);
  assert.equal(
    fakeDocker.calls.some(
      (args) => args[0] === "container" && ["stop", "rm"].includes(args[1]),
    ),
    false,
  );
  await access(cidfile.slice(0, cidfile.lastIndexOf("/")));
  await rm(cidfile.slice(0, cidfile.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
});

void test("browser driver never cleans a foreign container found after create throws", async (t) => {
  const home = await makeFixtureHome();
  t.after(() => rm(home.root, { recursive: true, force: true }));
  const fakeDocker = createFakeDocker({
    throwCreate: true,
    mismatchedContainerLabel: true,
  });
  let cidfile;
  await assert.rejects(
    startBrowser(makeContext(home), {
      runDocker: async (args, options) => {
        if (args[0] === "create") cidfile = args[args.indexOf("--cidfile") + 1];
        return fakeDocker.runDocker(args, options);
      },
      chromium: fakeChromium(home.executablePath),
      spawnProcess: () =>
        assert.fail("server must not start after create throws"),
    }),
    { message: "BROWSER_CREATE_OWNERSHIP_UNCONFIRMED" },
  );
  assert.equal(fakeDocker.containerExists, true);
  assert.equal(
    fakeDocker.calls.some(
      (args) => args[0] === "container" && ["stop", "rm"].includes(args[1]),
    ),
    false,
  );
  await access(cidfile.slice(0, cidfile.lastIndexOf("/")));
  await rm(cidfile.slice(0, cidfile.lastIndexOf("/")), {
    recursive: true,
    force: true,
  });
});
