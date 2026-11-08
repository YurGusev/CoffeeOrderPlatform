import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import childProcess from "node:child_process";
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import pg from "pg";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { join, resolve } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import { createRuntimeLoggingOverride } from "../../tools/observability/generate.mjs";
import { runtimeContainerLimits } from "../../scripts/config-lib.mjs";
import { canonicalRequestHash } from "../../packages/platform-idempotency/dist/index.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertLocalKafkaOffsets,
  authorizeIdentityRetirement,
  captureLocalFrontend,
  configureLocalIdentityProfile,
  createLocalComposeOverride,
  dispatchCertificateMaintenance,
  identityState,
  identitySigningKeysHash,
  inspectLocalRuntime,
  inspectOptionalDockerResource,
  isLocalRuntimeReady,
  maintainLocalCertificates,
  prepareLocalRelease,
  publishMaintenanceWarning,
  renderLocalCertificateMaintenanceUnits,
  renderLocalRuntimeUnit,
  stopLocalRuntime,
} from "../../tools/platform-service.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

void test("failed secret preparation removes only its incomplete release and permits retry", async () => {
  const temporary = await mkdtemp(
    join(tmpdir(), "coffee-release-preparation-"),
  );
  const releaseDir = join(temporary, "release");
  const secretsDir = join(temporary, "secrets");
  let database = false;
  let compose = false;
  try {
    await mkdir(releaseDir);
    await assert.rejects(
      prepareLocalRelease({
        releaseDir,
        secretsDir,
        existingRelease: false,
        prepare: async ({ secretsCreated }) => {
          await mkdir(secretsDir);
          await secretsCreated();
          throw new Error("CONFIG-SOPS: synthetic wrong key");
        },
      }),
      /CONFIG-SOPS/u,
    );
    await assert.rejects(stat(releaseDir), { code: "ENOENT" });
    await assert.rejects(stat(secretsDir), { code: "ENOENT" });
    assert.equal(database, false);
    assert.equal(compose, false);
    await mkdir(releaseDir);
    const result = await prepareLocalRelease({
      releaseDir,
      secretsDir,
      existingRelease: false,
      prepare: async ({ secretsCreated, beforeDatabase }) => {
        await mkdir(secretsDir);
        await secretsCreated();
        await writeFile(join(releaseDir, "release.json"), "{}", {
          mode: 0o400,
        });
        await chmod(releaseDir, 0o500);
        beforeDatabase();
        database = true;
        compose = true;
        return "ready-for-review";
      },
    });
    assert.equal(result, "ready-for-review");
    assert.equal((await stat(releaseDir)).mode & 0o777, 0o500);
    await assert.rejects(
      prepareLocalRelease({
        releaseDir,
        secretsDir,
        existingRelease: true,
        prepare: async () => {
          throw new Error("synthetic failure");
        },
      }),
      /synthetic failure/u,
    );
    assert.equal(
      await readFile(join(releaseDir, "release.json"), "utf8"),
      "{}",
    );
    await chmod(releaseDir, 0o700);
    await rm(releaseDir, { recursive: true });
    await mkdir(releaseDir);
    const foreign = join(temporary, "foreign");
    await mkdir(foreign);
    await writeFile(join(foreign, "sentinel"), "preserved");
    await assert.rejects(
      prepareLocalRelease({
        releaseDir,
        secretsDir,
        existingRelease: false,
        prepare: async () => {
          await rm(releaseDir, { recursive: true });
          await symlink(foreign, releaseDir);
          throw new Error("synthetic failure");
        },
      }),
      /failed to remove incomplete local release/u,
    );
    assert.equal(
      await readFile(join(foreign, "sentinel"), "utf8"),
      "preserved",
    );
    await rm(releaseDir);
    const source = await readFile(
      join(REPO_ROOT, "tools/platform-service.mjs"),
      "utf8",
    );
    const start = source.indexOf("      const own = before.filter(");
    const end = source.indexOf("      let artifacts;", start);
    assert.ok(start >= 0 && end > start);
    const operations = [];
    const record = (name, value) => async () => {
      operations.push(name);
      return value;
    };
    const imageId = `sha256:${"a".repeat(64)}`;
    const context = {
      before: [{ service: "kafka", status: "restarting", imageId }],
      OBSERVABILITY: [],
      runtimeImages: [],
      kafka: { imageId },
      keycloak: { imageId },
      existingRelease: true,
      isLocalRuntimeReady: () => false,
      secretsDir: "/fixture/secrets",
      configPath: "/fixture/platform.yaml",
      root: "/fixture",
      env: {},
      join,
      configBytes: Buffer.from("fixture"),
      writeFile: record("write"),
      lstat: async () => {
        operations.push("inspect secrets");
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      mkdir: record("create"),
      rm: record("remove"),
      secretsCreated: record("mark"),
      smoke: { bootstrapEnvironment: () => ({}) },
      bootstrap: { materializeLocalRuntimeSecrets: record("materialize", {}) },
    };
    await assert.rejects(
      runInNewContext(
        `(async () => { ${source.slice(start, end)} })()`,
        context,
      ),
      /incomplete local runtime is still running/u,
    );
    assert.deepEqual(operations, []);
  } finally {
    await chmod(releaseDir, 0o700).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
});

void test("local boot unit binds one immutable controller and its release", async (t) => {
  const sourceSha = "a".repeat(40);
  const root = `/home/example/coffee-platform/runtime/controllers/${sourceSha}`;
  const options = {
    root,
    nodePath: "/opt/node/bin/node",
    pnpmPath: "/opt/pnpm/bin/pnpm",
    flockPath: "/usr/bin/flock",
    lockPath: "/run/user/1000/coffee-platform-heavy.lock",
    contextFile: "/home/example/evidence/context.json",
    expectedServerIdentity: "7613370342949990434",
    releaseId: `${sourceSha}-${"b".repeat(16)}-${"c".repeat(12)}`,
    ageKeyFile: "/home/example/private/age-key.txt",
    ownedServiceCount: 17,
    shutdownGraceMs: 30000,
  };
  const unit = renderLocalRuntimeUnit(options);
  assert.match(unit, /^Type=oneshot$/mu);
  assert.match(unit, /^RemainAfterExit=yes$/mu);
  assert.match(unit, /^Restart=no$/mu);
  assert.match(unit, /^Wants=coffee-observability\.service$/mu);
  assert.match(unit, /^After=coffee-observability\.service$/mu);
  assert.equal(unit.match(/^ExecStart=/gmu)?.length, 1);
  assert.ok(
    unit.includes(
      `ExecStart="/usr/bin/flock" --no-fork --timeout=7200 "/run/user/1000/coffee-platform-heavy.lock" "/opt/node/bin/node" "${root}/tools/platform-service.mjs" start`,
    ),
  );
  assert.ok(unit.includes(`COFFEE_LOCAL_RELEASE_ID=${options.releaseId}`));
  assert.ok(unit.includes(`COFFEE_LAUNCH_CONTEXT_FILE=${options.contextFile}`));
  const maintenance = renderLocalCertificateMaintenanceUnits({
    ...options,
    certificateRenewBeforeHours: 6,
  });
  assert.match(maintenance.timer, /^OnCalendar=\*-\*-\* 00\/3:00:00 UTC$/mu);
  assert.match(maintenance.timer, /^Persistent=true$/mu);
  assert.match(maintenance.service, /^Type=oneshot$/mu);
  assert.match(
    maintenance.service,
    /^ExecCondition=\/usr\/bin\/systemctl --user is-active --quiet coffee-platform\.service$/mu,
  );
  assert.match(
    maintenance.service,
    /^ExecStart=.*tools\/platform-service\.mjs" dispatch-maintenance$/mu,
  );
  assert.match(
    unit,
    /^ExecReload=.*coffee-platform-heavy\.lock.* maintain-certificates$/mu,
  );
  assert.match(unit, /^ExecStopPost=.* stop$/mu);
  assert.doesNotMatch(unit, /^ExecStop=/mu);
  assert.doesNotMatch(maintenance.service, /^Requires=|^BindsTo=/mu);
  assert.throws(
    () =>
      renderLocalCertificateMaintenanceUnits({
        ...options,
        certificateRenewBeforeHours: 5,
      }),
    /interval is invalid/u,
  );
  const timeout = Number(/^TimeoutStopSec=(\d+)$/mu.exec(unit)?.[1]);
  assert.ok(Number.isSafeInteger(timeout));
  // Two bounded batch metadata calls, 17 bounded stops and one control allowance.
  assert.ok(timeout >= 2 * 10 + 17 * (30 + 5) + 10);
  assert.ok(timeout <= 12 * 60);
  assert.ok(timeout >= (17 * options.shutdownGraceMs) / 1000);
  assert.throws(
    () =>
      renderLocalRuntimeUnit({
        ...options,
        root: `${root}\nExecStart=foreign`,
      }),
    /locators are invalid/u,
  );
  assert.throws(
    () => renderLocalRuntimeUnit({ ...options, releaseId: "foreign" }),
    /locators are invalid/u,
  );
  assert.throws(
    () => renderLocalRuntimeUnit({ ...options, ownedServiceCount: 0 }),
    /locators are invalid/u,
  );
  await t.test(
    "systemd verifies the runtime and maintenance units",
    async (t) => {
      const available = spawnSync("systemd-analyze", ["--version"], {
        encoding: "utf8",
        timeout: 10000,
      });
      if (available.error?.code === "ENOENT") {
        t.skip("systemd-analyze is not installed");
        return;
      }
      assert.equal(available.status, 0, available.stderr);
      const temporary = await mkdtemp(join(tmpdir(), "coffee-unit-verify-"));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      const verificationOptions = {
        ...options,
        root: join(temporary, "controller %literal"),
        nodePath: process.execPath,
        flockPath: process.execPath,
        certificateRenewBeforeHours: 6,
      };
      const certificates =
        renderLocalCertificateMaintenanceUnits(verificationOptions);
      const files = [
        [
          "coffee-platform.service",
          renderLocalRuntimeUnit(verificationOptions),
        ],
        ["coffee-platform-certificates.service", certificates.service],
        ["coffee-platform-certificates.timer", certificates.timer],
        [
          "coffee-observability.service",
          `[Service]\nType=oneshot\nExecStart=${process.execPath} --version\n`,
        ],
      ];
      for (const [name, contents] of files)
        await writeFile(join(temporary, name), contents);
      const checked = spawnSync(
        "systemd-analyze",
        [
          "--user",
          "--generators=no",
          "--man=no",
          "verify",
          ...files.map(([name]) => join(temporary, name)),
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          env: {
            ...process.env,
            XDG_RUNTIME_DIR: temporary,
            SYSTEMD_UNIT_PATH: `${temporary}:`,
          },
        },
      );
      assert.equal(checked.status, 0, checked.stderr);
    },
  );
});

void test("certificate maintenance respects its unit, deadline and failed stop", async () => {
  await assert.rejects(
    maintainLocalCertificates({ env: {} }),
    /requires the unit reload process/u,
  );
  await assert.rejects(
    maintainLocalCertificates({
      env: { INVOCATION_ID: "a".repeat(32), SYSTEMD_EXEC_PID: "0" },
    }),
    /requires the unit reload process/u,
  );
  const root = "/fixture/controller";
  const releaseId = `${"a".repeat(40)}-${"b".repeat(16)}-${"c".repeat(12)}`;
  const env = {
    INVOCATION_ID: "a".repeat(32),
    SYSTEMD_EXEC_PID: String(process.pid),
    COFFEE_LAUNCH_CONTEXT_FILE: "/fixture/context.json",
    COFFEE_LOCAL_RELEASE_ID: releaseId,
  };
  const calls = [];
  let earliest = Date.now() + 7 * 3_600_000;
  let publicExpiry = Date.now() + 24 * 3_600_000;
  let warningFailure = false;
  let stopFailure = false;
  const options = {
    root,
    env,
    validateContext: async (path) => {
      assert.equal(path, env.COFFEE_LAUNCH_CONTEXT_FILE);
      return { candidateRoot: root };
    },
    readRelease: async () => ({ releaseId, releaseDir: "/fixture/release" }),
    loadConfig: async () => ({ security: { certificateRenewBeforeHours: 6 } }),
    readExpiry: async () => ({
      earliest,
      publicExpiry,
    }),
    stop: async () => {
      calls.push("stop");
      if (stopFailure) throw new Error("interrupted cleanup");
    },
    start: async () => {
      calls.push("start");
      return { state: "awaiting-owner-relogin" };
    },
    publish: async (event) => {
      calls.push(event.reason);
      if (warningFailure) throw new Error("warning delivery failed");
    },
  };
  assert.deepEqual(await maintainLocalCertificates(options), {
    state: "current",
    publicRenewalRequired: false,
  });
  assert.deepEqual(calls, []);
  publicExpiry = Date.now() + 5 * 3_600_000;
  assert.deepEqual(await maintainLocalCertificates(options), {
    state: "current",
    publicRenewalRequired: true,
  });
  assert.deepEqual(calls, ["public_certificate_expiring"]);
  calls.length = 0;
  warningFailure = true;
  await assert.rejects(
    maintainLocalCertificates(options),
    /warning delivery failed/u,
  );
  assert.deepEqual(calls, ["public_certificate_expiring"]);
  calls.length = 0;
  warningFailure = false;
  publicExpiry = Date.now() + 24 * 3_600_000;
  earliest = Date.now() + 5 * 3_600_000;
  assert.deepEqual(await maintainLocalCertificates(options), {
    state: "awaiting-owner-relogin",
    publicRenewalRequired: false,
  });
  assert.deepEqual(calls, ["stop", "start"]);
  calls.length = 0;
  stopFailure = true;
  await assert.rejects(
    maintainLocalCertificates(options),
    /interrupted cleanup/u,
  );
  assert.deepEqual(calls, ["stop"]);
  calls.length = 0;
  await assert.rejects(
    maintainLocalCertificates({
      ...options,
      env: { ...env, COFFEE_LOCAL_RELEASE_ID: "foreign" },
    }),
    /maintenance release differs/u,
  );
  assert.deepEqual(calls, []);
});

void test("maintenance warnings carry only allowlisted public metadata and fail closed", async () => {
  const releaseId = `${"a".repeat(40)}-${"b".repeat(16)}-${"c".repeat(12)}`;
  const ids = Array.from({ length: 6 }, (_, index) =>
    String(index + 1).padStart(64, "0"),
  );
  const imageId = `sha256:${"d".repeat(64)}`;
  const rows = ids.map((Id, index) => ({
    Id,
    Image: imageId,
    Config: {
      Labels: {
        "com.docker.compose.service":
          index === 0 ? "alert-sink" : `service-${index}`,
      },
    },
    State: { Running: true },
  }));
  const accepted = {
    root: "/accepted/observability",
    helper: { imageId },
    config: {
      environment: "development",
      telemetry: {
        namespace: "coffee-platform",
        loki: { endpoint: "http://loki:3100" },
      },
      platform: { requestDeadlineMs: 5000 },
    },
  };
  let payload;
  let senderProgram;
  let wrongReadback = false;
  const execute = (args, options) => {
    if (args[0] === "inspect") return JSON.stringify(rows);
    assert.deepEqual(args.slice(0, 3), ["exec", "-i", ids[0]]);
    assert.deepEqual(args.slice(3, 5), ["node", "-e"]);
    senderProgram = args[5];
    payload = JSON.parse(options.input);
    return JSON.stringify({
      event_id: wrongReadback ? "foreign" : payload.event.event_id,
    });
  };
  const options = {
    reason: "public_certificate_expiring",
    releaseId,
    publicNotAfter: Date.now() + 10000,
    message: "PRIVATE_CANARY",
    readObservability: async () => accepted,
    inspectTelemetry: () => ids,
    run: execute,
  };
  const delivered = await publishMaintenanceWarning(options);
  assert.equal(delivered.eventId, payload.event.event_id);
  assert.equal(payload.event.reason, "public_certificate_expiring");
  assert.equal(payload.event.severity, "warn");
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_CANARY/u);
  assert.deepEqual(
    Object.keys(payload.event).sort(),
    [
      "action",
      "environment",
      "event_id",
      "namespace",
      "public_not_after",
      "reason",
      "release_id",
      "service",
      "severity",
      "time",
    ].sort(),
  );
  const senderInput = structuredClone(payload);
  senderInput.budget = 450;
  const executeSender = async (mode) => {
    let clock = Date.parse(senderInput.event.time);
    let stdout = "";
    let stderr = "";
    const calls = [];
    const fakeProcess = {
      stdout: {
        write: (value) => {
          stdout += value;
        },
      },
      stderr: {
        write: (value) => {
          stderr += value;
        },
      },
      exitCode: undefined,
    };
    class FakeDate extends Date {
      static now() {
        return clock;
      }
    }
    const fetch = async (url, request = {}) => {
      calls.push({ url: String(url), method: request.method ?? "GET" });
      assert.ok(
        request.signal.timeout > 0 &&
          request.signal.timeout <= senderInput.budget,
      );
      if (request.method === "POST") {
        assert.equal(url.pathname, "/otlp/v1/logs");
        const body = JSON.parse(request.body);
        const resource = body.resourceLogs[0];
        assert.equal(
          resource.resource.attributes[0].value.stringValue,
          senderInput.event.service,
        );
        assert.deepEqual(
          JSON.parse(resource.scopeLogs[0].logRecords[0].body.stringValue),
          senderInput.event,
        );
        return { ok: mode !== "post_non2xx" };
      }
      assert.equal(url.pathname, "/loki/api/v1/query_range");
      assert.ok(
        url.searchParams.get("query").includes(senderInput.event.event_id),
      );
      const seen = { ...senderInput.event };
      if (mode === "foreign") seen.event_id = "foreign-event";
      if (mode === "incomplete") delete seen.severity;
      const values =
        mode === "missing"
          ? []
          : [[String(BigInt(clock) * 1000000n), JSON.stringify(seen)]];
      return {
        ok: mode !== "query_non2xx",
        json: async () => ({
          status: "success",
          data: {
            resultType: "streams",
            result: [
              { stream: { service_name: senderInput.event.service }, values },
            ],
          },
        }),
      };
    };
    await runInNewContext(senderProgram, {
      require: (name) => {
        assert.equal(name, "node:fs");
        return {
          readFileSync: (fd, encoding) => {
            assert.equal(fd, 0);
            assert.equal(encoding, "utf8");
            return JSON.stringify(senderInput);
          },
        };
      },
      process: fakeProcess,
      Date: FakeDate,
      URL,
      URLSearchParams,
      BigInt,
      AbortSignal: { timeout: (timeout) => ({ timeout }) },
      setTimeout: (callback, milliseconds) => {
        clock += milliseconds;
        callback();
      },
      fetch,
    });
    return {
      stdout,
      stderr,
      exitCode: fakeProcess.exitCode,
      calls,
      elapsed: clock - Date.parse(senderInput.event.time),
    };
  };
  const observed = await executeSender("exact");
  assert.deepEqual(JSON.parse(observed.stdout), {
    event_id: senderInput.event.event_id,
  });
  assert.equal(observed.exitCode, undefined);
  assert.equal(observed.calls.length, 2);
  for (const mode of ["foreign", "missing", "incomplete"]) {
    const rejected = await executeSender(mode);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /delivery failed/u);
    assert.ok(rejected.elapsed >= senderInput.budget);
    assert.equal(
      rejected.calls.filter((call) => call.method === "POST").length,
      1,
    );
    assert.ok(
      rejected.calls.filter((call) => call.method === "GET").length > 0,
    );
  }
  for (const mode of ["post_non2xx", "query_non2xx"]) {
    const rejected = await executeSender(mode);
    assert.equal(rejected.stdout, "");
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /delivery failed/u);
    assert.equal(rejected.calls.length, mode === "post_non2xx" ? 1 : 2);
  }
  wrongReadback = true;
  await assert.rejects(publishMaintenanceWarning(options), /readback differs/u);
  await assert.rejects(
    publishMaintenanceWarning({ ...options, reason: "foreign" }),
    /input is invalid/u,
  );

  const cause = new Error("PRIVATE_CANARY");
  const sent = [];
  const dispatch = {
    env: { COFFEE_LOCAL_RELEASE_ID: releaseId },
    unitState: async () => "active",
    reload: async () => {
      throw cause;
    },
    publish: async (value) => {
      sent.push(value);
    },
  };
  await assert.rejects(
    dispatchCertificateMaintenance(dispatch),
    (error) =>
      error.cause === cause &&
      error.warningDelivery === "delivered" &&
      !error.message.includes("PRIVATE_CANARY"),
  );
  assert.deepEqual(sent, [
    { reason: "certificate_maintenance_failed", releaseId },
  ]);
  await assert.rejects(
    dispatchCertificateMaintenance({
      ...dispatch,
      publish: async () => {
        throw new Error("private");
      },
    }),
    (error) => error.cause === cause && error.warningDelivery === "failed",
  );
  sent.length = 0;
  assert.deepEqual(
    await dispatchCertificateMaintenance({
      ...dispatch,
      unitState: async () => "inactive",
    }),
    { state: "inactive" },
  );
  assert.deepEqual(sent, []);
});

void test("identity retirement receipt fails closed after an interrupted or foreign change", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-identity-state-"));
  const identity = {
    postgresSystemIdentifier: "7613370342949990434",
    databaseName: "coffee_platform_identity",
    databaseRole: "coffee_identity_rw",
    realm: "coffee",
  };
  const options = {
    identity,
    directory,
    bootstrap: { ensurePrivateSecretDirectory: async () => {} },
  };
  const path = join(directory, "identity.json");
  const receipt = {
    ...identity,
    databaseOid: "12345",
    signingKeySha256: "a".repeat(64),
  };
  try {
    assert.equal((await identityState(options)).stage, "pending");
    await writeFile(path, JSON.stringify({ ...receipt, stage: "retiring" }), {
      mode: 0o600,
    });
    await assert.rejects(identityState(options), /retirement was interrupted/u);
    await writeFile(path, JSON.stringify({ ...receipt, stage: "retired" }));
    assert.equal((await identityState(options)).stage, "retired");
    for (const change of [
      { postgresSystemIdentifier: "1234567890" },
      { databaseName: "foreign" },
      { databaseRole: "foreign" },
      { realm: "foreign" },
    ])
      await assert.rejects(
        identityState({ ...options, identity: { ...identity, ...change } }),
        /receipt is invalid/u,
      );
    for (const sourceSha of ["a".repeat(40), "b".repeat(40)])
      assert.equal(
        (
          await identityState({
            ...options,
            identity: {
              ...identity,
              sourceSha,
              encryptedSecretsSha256: sourceSha,
            },
          })
        ).stage,
        "retired",
      );
    await writeFile(path, "{");
    await assert.rejects(identityState(options), /receipt is invalid/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("identity signing authority uses canonical RSA keys rather than JWKS order or key IDs", () => {
  const first = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ format: "jwk" });
  const second = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).publicKey.export({ format: "jwk" });
  const key = (value, kid) => ({ ...value, use: "sig", alg: "RS256", kid });
  const initial = identitySigningKeysHash({
    keys: [key(first, "one"), key(second, "two")],
  });
  assert.equal(
    identitySigningKeysHash({
      keys: [key(second, "changed"), key(first, "changed")],
    }),
    initial,
  );
  assert.notEqual(
    identitySigningKeysHash({ keys: [key(first, "one")] }),
    initial,
  );
  assert.throws(
    () =>
      identitySigningKeysHash({
        keys: [{ ...first, use: "enc", alg: "RS256" }],
      }),
    /signing keys are missing/u,
  );
});

void test("local identity bootstrap preserves profile validation while making contact fields optional", async () => {
  const config = {
    localIdentity: {
      realm: "coffee",
      bootstrapAdminUsername: "bootstrap-admin",
    },
  };
  const initial = {
    attributes: [
      {
        name: "username",
        required: { roles: ["user"] },
        validations: { length: { min: 3 } },
      },
      ...["email", "firstName", "lastName"].map((name) => ({
        name,
        required: { roles: ["user"] },
        validations: { length: { max: 255 } },
        permissions: { view: ["admin", "user"], edit: ["admin", "user"] },
      })),
    ],
    groups: [{ name: "user-metadata", displayHeader: "User metadata" }],
    unmanagedAttributePolicy: "DISABLED",
  };
  let stored = structuredClone(initial);
  let ignoreWrite = false;
  const methods = [];
  const call = async (path, options) => {
    methods.push(options.method ?? "GET");
    if (path.endsWith("/token")) {
      assert.equal(
        new URLSearchParams(options.body).get("password"),
        "fixture",
      );
      return { access_token: "transient" };
    }
    assert.equal(path, "/admin/realms/coffee/users/profile");
    assert.equal(options.token, "transient");
    if (options.method === "PUT") {
      assert.equal(options.contentType, "application/json");
      if (!ignoreWrite) stored = JSON.parse(options.body);
    }
    return structuredClone(stored);
  };
  const options = { config, bootstrapPassword: "fixture", call };
  await configureLocalIdentityProfile(options);
  const expected = structuredClone(initial);
  for (const attribute of expected.attributes.slice(1))
    delete attribute.required;
  assert.deepEqual(stored, expected);
  assert.deepEqual(methods, ["POST", "GET", "PUT", "GET"]);
  methods.length = 0;
  await configureLocalIdentityProfile(options);
  assert.deepEqual(methods, ["POST", "GET"]);
  stored = structuredClone(initial);
  ignoreWrite = true;
  await assert.rejects(
    configureLocalIdentityProfile(options),
    /profile was not preserved/u,
  );
  stored = { attributes: [] };
  await assert.rejects(
    configureLocalIdentityProfile(options),
    /attribute is ambiguous/u,
  );
});

void test("temporary identity retirement requires the actual owner session and realm administration", async () => {
  const config = {
    localIdentity: {
      realm: "coffee",
      clientId: "coffee-platform",
      operatorUsername: "owner",
      bootstrapAdminUsername: "bootstrap-admin",
    },
  };
  for (const scenario of [
    "accepted",
    "wrong-owner",
    "no-session",
    "wrong-role",
    "unmarked-admin",
    "receipt-failure",
  ]) {
    const actions = [];
    const call = async (path, options) => {
      actions.push(options.method === "DELETE" ? "delete" : path);
      if (path.endsWith("/token")) return { access_token: "transient" };
      assert.equal(options.token, "transient");
      if (path.includes("/master/users?"))
        return [
          {
            id: "temporary-id",
            username: "bootstrap-admin",
            attributes:
              scenario === "unmarked-admin"
                ? {}
                : { is_temporary_admin: ["true"] },
          },
        ];
      if (path.includes("/coffee/users?"))
        return [
          {
            id: "owner-id",
            enabled: true,
            username: scenario === "wrong-owner" ? "other" : "owner",
          },
        ];
      if (path.endsWith("/sessions"))
        return [
          {
            clients: {
              first: scenario === "no-session" ? "other" : "coffee-platform",
            },
          },
        ];
      if (path.includes("/clients?"))
        return [{ id: "manager-id", clientId: "realm-management" }];
      if (path.endsWith("/composite"))
        return [
          {
            name: scenario === "wrong-role" ? "view-users" : "realm-admin",
            clientRole: true,
          },
        ];
      if (options.method === "DELETE") {
        assert.equal(path, "/admin/realms/master/users/temporary-id");
        return undefined;
      }
      throw new Error("unexpected API request");
    };
    const attempt = authorizeIdentityRetirement({
      config,
      bootstrapPassword: "synthetic",
      call,
      beforeDelete: async () => {
        actions.push("receipt");
        if (scenario === "receipt-failure") throw new Error("receipt failed");
      },
    });
    if (scenario === "accepted") {
      await attempt;
      assert.deepEqual(actions.slice(-2), ["receipt", "delete"]);
    } else if (scenario === "receipt-failure") {
      await assert.rejects(attempt, /receipt failed/u);
      assert.equal(actions.includes("delete"), false);
    } else {
      await assert.rejects(attempt, /RECOVERY_REQUIRED/u);
      assert.equal(actions.includes("receipt"), false);
      assert.equal(actions.includes("delete"), false);
    }
  }
});

void test("local release captures frontend from the verified image and cleans only its container", async (t) => {
  const releaseDir = await mkdtemp(join(tmpdir(), "coffee-local-release-"));
  const id = "1".repeat(64);
  const imageId = `sha256:${"2".repeat(64)}`;
  const calls = [];
  let foreign = false;
  let failCopy = false;
  const run = (args) => {
    calls.push(args);
    if (args[0] === "create") return id;
    if (args[0] === "inspect")
      return JSON.stringify([
        {
          Id: id,
          Image: foreign ? `sha256:${"3".repeat(64)}` : imageId,
          Config: {
            Labels: {
              "coffee.owner": "operations",
              "coffee.lifecycle": "temporary",
            },
          },
        },
      ]);
    if (args[0] === "cp") writeFileSync(args[2], "nginx-config");
    return "";
  };
  t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    assert.equal(command, "docker");
    assert.deepEqual(args, ["cp", `${id}:/usr/share/nginx/html`, "-"]);
    if (failCopy) throw new Error("copy failed");
    writeSync(options.stdio[1], "browser-tar");
  });
  syncBuiltinESMExports();
  try {
    const captured = await captureLocalFrontend({
      root: REPO_ROOT,
      releaseDir,
      nginxImageId: imageId,
      run,
    });
    assert.equal(
      captured.nginxSha256,
      createHash("sha256").update("nginx-config").digest("hex"),
    );
    assert.equal(
      captured.browserAssetsSha256,
      createHash("sha256").update("browser-tar").digest("hex"),
    );
    assert.equal(
      (await stat(join(releaseDir, "browser-assets.tar"))).mode & 0o777,
      0o400,
    );
    assert.deepEqual(calls.at(-1), ["rm", id]);
    await rm(join(releaseDir, "nginx.conf"));
    await rm(join(releaseDir, "browser-assets.tar"));
    calls.length = 0;
    foreign = true;
    await assert.rejects(
      captureLocalFrontend({
        root: REPO_ROOT,
        releaseDir,
        nginxImageId: imageId,
        run,
      }),
      /ownership is unknown/u,
    );
    assert.ok(calls.every((args) => args[0] !== "rm"));
    calls.length = 0;
    foreign = false;
    failCopy = true;
    await assert.rejects(
      captureLocalFrontend({
        root: REPO_ROOT,
        releaseDir,
        nginxImageId: imageId,
        run,
      }),
      /copy failed/u,
    );
    assert.deepEqual(calls.at(-1), ["rm", id]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(releaseDir, { recursive: true, force: true });
  }
});

void test("local runtime stop preserves observability and stops only owned containers", async () => {
  const calls = [];
  const status = [
    { service: "kafka", containerId: "kafka-id", status: "running" },
    { service: "edge-nginx", containerId: "nginx-id", status: "running" },
    { service: "orders-service", containerId: "orders-id", status: "running" },
    { service: "keycloak", containerId: "keycloak-id", status: "running" },
    { service: "grafana", containerId: "grafana-id", status: "running" },
  ];
  const result = await stopLocalRuntime({
    root: REPO_ROOT,
    inspect: async () => status,
    loadConfig: async () => ({ platform: { shutdownGraceMs: 30_000 } }),
    run: (args) => {
      calls.push(args);
      return "";
    },
  });
  assert.deepEqual(result.stopped, [
    "edge-nginx",
    "orders-service",
    "keycloak",
    "kafka",
  ]);
  assert.deepEqual(
    calls.map((args) => args.at(-1)),
    ["nginx-id", "orders-id", "keycloak-id", "kafka-id"],
  );
  assert.ok(
    calls.every(
      (args) => args[0] === "stop" && args[1] === "--time" && args[2] === "30",
    ),
  );
  const rejectedCalls = [];
  await assert.rejects(
    stopLocalRuntime({
      root: REPO_ROOT,
      inspect: async () => status,
      loadConfig: async () => ({ platform: { shutdownGraceMs: 30_000 } }),
      run: (args) => rejectedCalls.push(args),
      env: { COFFEE_LOCAL_RELEASE_ID: "foreign" },
    }),
    /stop release identity is invalid/u,
  );
  assert.deepEqual(rejectedCalls, []);
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"),
  );
  const roles = [
    ...catalog.runtimes.map((entry) => entry.name),
    "kafka",
    "keycloak",
  ];
  const image = `sha256:${"a".repeat(64)}`;
  const identity = {
    runtimeImages: catalog.runtimes.map(({ name }) => ({
      service: name,
      imageId: image,
    })),
    kafkaImageId: image,
    keycloakImageId: image,
  };
  const bound = status.map((entry) => ({ ...entry, imageId: image }));
  const releaseEnv = {
    COFFEE_LOCAL_RELEASE_ID: `${"a".repeat(40)}-${"b".repeat(16)}-${"c".repeat(12)}`,
  };
  const stopCalls = [];
  const stopOptions = {
    root: REPO_ROOT,
    inspect: async () => bound,
    loadConfig: async () => ({ platform: { shutdownGraceMs: 30_000 } }),
    loadRelease: async () => ({ identity }),
    run: (args) => {
      stopCalls.push(args);
      return "";
    },
    env: releaseEnv,
  };
  bound.find((entry) => entry.service === "kafka").imageId =
    `sha256:${"b".repeat(64)}`;
  await assert.rejects(
    stopLocalRuntime(stopOptions),
    /stop container image identity differs/u,
  );
  assert.deepEqual(stopCalls, []);
  bound.find((entry) => entry.service === "kafka").imageId = image;
  bound.find((entry) => entry.service === "orders-service").status =
    "restarting";
  await assert.rejects(
    stopLocalRuntime({
      ...stopOptions,
      env: { ...releaseEnv, SERVICE_RESULT: "signal" },
    }),
    /unit stopped after an unsuccessful operation/u,
  );
  assert.deepEqual(
    stopCalls.map((args) => args.at(-1)),
    ["nginx-id", "orders-id", "keycloak-id", "kafka-id"],
  );
  const telemetry = [
    "grafana",
    "loki",
    "prometheus",
    "tempo",
    "otel-collector",
    "alert-sink",
  ];
  const containers = [...roles, ...telemetry]
    .map((service, index) => ({
      Id: (index + 1).toString(16).padStart(64, "0"),
      Image: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
      Config: {
        Labels: {
          "com.docker.compose.project": "coffee-platform",
          "com.docker.compose.service": service,
          "com.docker.compose.project.working_dir": roles.includes(service)
            ? REPO_ROOT
            : "/separate/observability/release",
        },
      },
      State: { Status: "running" },
    }))
    .reverse();
  const exercise = async (rows, partial = false) => {
    const commands = [];
    const run = (args) => {
      commands.push(args);
      if (args[0] === "ps") return rows.map((item) => item.Id).join("\n");
      if (args[0] === "inspect")
        return JSON.stringify(partial ? rows.slice(1) : rows);
      return "";
    };
    return {
      commands,
      result: stopLocalRuntime({
        root: REPO_ROOT,
        run,
        loadConfig: async () => ({ platform: { shutdownGraceMs: 30000 } }),
      }),
    };
  };
  const valid = await exercise(containers);
  const stopped = await valid.result;
  assert.equal(valid.commands.filter((args) => args[0] === "ps").length, 1);
  assert.equal(
    valid.commands.filter((args) => args[0] === "inspect").length,
    1,
  );
  assert.equal(valid.commands.filter((args) => args[0] === "stop").length, 17);
  assert.deepEqual(stopped.stopped, [
    "edge-nginx",
    ...roles.filter(
      (role) => !["edge-nginx", "kafka", "keycloak"].includes(role),
    ),
    "keycloak",
    "kafka",
  ]);
  assert.ok(
    valid.commands
      .filter((args) => args[0] === "stop")
      .every(
        (args) =>
          !containers.some(
            (item) =>
              telemetry.includes(
                item.Config.Labels["com.docker.compose.service"],
              ) && item.Id === args.at(-1),
          ),
      ),
  );
  for (const variant of ["foreign", "duplicate", "image", "partial"]) {
    const rows = structuredClone(containers);
    const product = rows.find(
      (item) =>
        item.Config.Labels["com.docker.compose.service"] === "orders-service",
    );
    if (variant === "foreign")
      product.Config.Labels["com.docker.compose.project.working_dir"] =
        "/foreign";
    if (variant === "duplicate")
      rows.find(
        (item) =>
          item.Config.Labels["com.docker.compose.service"] === "api-public",
      ).Config.Labels["com.docker.compose.service"] = "orders-service";
    if (variant === "image") product.Image = "foreign";
    const rejected = await exercise(rows, variant === "partial");
    await assert.rejects(
      rejected.result,
      /identity is ambiguous|inspection is incomplete|does not belong/u,
    );
    assert.equal(
      rejected.commands.some((args) => args[0] === "stop"),
      false,
    );
  }
});

void test("local runtime compose binds verified images and scoped identity material", async () => {
  const { load } = await import("js-yaml");
  const config = load(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"),
  );
  const runtimes = catalog.runtimes
    .map((entry) => entry.name)
    .filter((name) => name !== "edge-nginx");
  const runtimeImages = [...runtimes, "edge-nginx"].map((service, index) => ({
    service,
    imageId: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
  }));
  const options = {
    config,
    runtimes,
    runtimeImages,
    kafkaImageId: `sha256:${"a".repeat(64)}`,
    keycloakImageId: `sha256:${"b".repeat(64)}`,
    configPath: "/private/release/platform.yaml",
    secretsDir: "/dev/shm/coffee-private",
  };
  const compose = createLocalComposeOverride(options);
  for (const entry of runtimeImages)
    assert.equal(compose.services[entry.service].image, entry.imageId);
  for (const service of [...runtimes, "kafka"]) {
    const expected = runtimeContainerLimits(config, service);
    assert.equal(compose.services[service].cpus, expected.cpus, service);
    assert.equal(
      compose.services[service].mem_limit,
      expected.mem_limit,
      service,
    );
  }
  assert.equal(compose.services.keycloak.cpus, config.localIdentity.cpuLimit);
  for (const service of [...runtimes, "edge-nginx", "kafka", "keycloak"]) {
    assert.equal(compose.services[service].restart, "on-failure:3");
    assert.deepEqual(compose.services[service].logging, {
      driver: "json-file",
      options: {
        "max-size": "8m",
        "max-file": "3",
        mode: "non-blocking",
        "max-buffer-size": String(
          config.telemetry.producer.maxRecordBytes *
            config.telemetry.producer.queueCapacity,
        ),
      },
    });
  }
  assert.equal(compose.services.kafka.image, options.kafkaImageId);
  assert.equal(compose.services.keycloak.image, options.keycloakImageId);
  assert.equal(compose.services.keycloak.read_only, true);
  assert.equal(compose.services.keycloak.environment.KC_CACHE, "local");
  assert.equal(compose.services.keycloak.healthcheck.start_period, "90000ms");
  assert.deepEqual(compose.services.keycloak.healthcheck.test, [
    "CMD",
    "wget",
    "-q",
    "--spider",
    "http://127.0.0.1:9000/health/ready",
  ]);
  assert.deepEqual(compose.services.keycloak.cap_drop, ["ALL"]);
  for (const name of ["INITIAL", "MIN", "MAX"])
    assert.equal(
      compose.services.keycloak.environment[`KC_DB_POOL_${name}_SIZE`],
      "2",
    );
  assert.equal(
    compose.services.keycloak.environment.KC_HTTP_MANAGEMENT_HOST,
    "127.0.0.1",
  );
  assert.equal(compose.services.keycloak.mem_limit, "2048m");
  assert.deepEqual(compose.services.keycloak.ports, ["127.0.0.1:9443:8443"]);
  assert.ok(compose.services.keycloak.command.includes("--import-realm"));
  assert.ok(compose.services.keycloak.environment.KC_BOOTSTRAP_ADMIN_USERNAME);
  const steady = createLocalComposeOverride({
    ...options,
    steadyIdentity: true,
  });
  assert.equal(steady.services.keycloak.image, compose.services.keycloak.image);
  assert.equal(
    steady.services.keycloak.command.includes("--import-realm"),
    false,
  );
  assert.equal(
    "KC_BOOTSTRAP_ADMIN_USERNAME" in steady.services.keycloak.environment,
    false,
  );
  assert.equal(
    steady.services.keycloak.volumes.some(
      (volume) => volume.target === "/opt/keycloak/data/import",
    ),
    false,
  );
  assert.equal(
    compose.services["edge-gateway"].environment.NODE_EXTRA_CA_CERTS,
    "/run/identity-ca/ca.crt",
  );
  assert.doesNotMatch(
    JSON.stringify(compose),
    /bootstrap-admin-password|databasePassword|operatorPassword/u,
  );
  assert.throws(
    () =>
      createLocalComposeOverride({
        ...options,
        runtimeImages: runtimeImages.slice(1),
      }),
    /image or path/u,
  );
});

void test("local runtime requires durable Kafka offsets without resetting groups", () => {
  const config = {
    kafka: { topics: { orders: { name: "orders", partitions: 2 } } },
    services: {
      orders: {
        kafka: {
          consumers: [
            {
              groupId: "orders-owner",
              topics: ["orders"],
              processing: "durable",
            },
            {
              groupId: "realtime",
              topics: ["orders"],
              processing: "ephemeral",
            },
          ],
        },
      },
    },
  };
  const calls = [];
  let output =
    "GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG CONSUMER-ID HOST CLIENT-ID\norders-owner orders 0 0 9 9 - - -\norders-owner orders 1 7 7 0 - - -\n";
  const compose = (...args) => {
    calls.push(args);
    return output;
  };
  assertLocalKafkaOffsets(config, compose);
  assert.deepEqual(calls, [
    [
      "exec",
      "-T",
      "kafka",
      "/opt/kafka/bin/kafka-consumer-groups.sh",
      "--bootstrap-server",
      "kafka:9092",
      "--command-config",
      "/etc/kafka/secrets/client.properties",
      "--describe",
      "--group",
      "orders-owner",
      "--offsets",
    ],
  ]);
  for (const invalid of [
    "",
    "Error: GroupIdNotFoundException",
    "orders-owner orders 0 0",
    "orders-owner orders 0 -\norders-owner orders 1 7",
    "orders-owner orders 0 0\norders-owner orders 0 0\norders-owner orders 1 7",
    "orders-owner foreign 0 0\norders-owner orders 1 7",
  ]) {
    output = invalid;
    assert.throws(
      () => assertLocalKafkaOffsets(config, compose),
      /requires operator verification/u,
    );
  }
  assert.throws(
    () =>
      assertLocalKafkaOffsets(config, () => {
        throw new Error("broker unavailable");
      }),
    /broker unavailable/u,
  );
});

void test("local runtime distinguishes absent Docker resources from failed inspection", () => {
  for (const [type, name, detail] of [
    ["network", "coffee_host_ingress", "network coffee_host_ingress not found"],
    [
      "volume",
      "coffee-platform_kafka_data",
      "get coffee-platform_kafka_data: no such volume",
    ],
  ]) {
    for (const stderr of [
      `Error response from daemon: ${detail}\n`,
      `Error: No such ${type}: ${name}\n`,
    ]) {
      assert.equal(
        inspectOptionalDockerResource(type, name, (args) => {
          assert.deepEqual(args, [type, "inspect", name]);
          throw Object.assign(new Error("docker inspect failed"), {
            status: 1,
            stderr,
          });
        }),
        undefined,
      );
    }
    for (const [status, stderr] of [
      [1, "permission denied"],
      [1, "Cannot connect to the Docker daemon"],
      [1, `Error response from daemon: ${detail}\npermission denied`],
      [1, `Error: No such ${type}: foreign`],
      [125, `Error response from daemon: ${detail}`],
    ]) {
      assert.throws(
        () =>
          inspectOptionalDockerResource(type, name, () => {
            throw Object.assign(new Error("docker inspect failed"), {
              status,
              stderr,
            });
          }),
        /cannot be safely inspected/u,
      );
    }
    for (const rows of [[], [{ Name: "foreign" }]])
      assert.throws(
        () =>
          inspectOptionalDockerResource(type, name, () => JSON.stringify(rows)),
        /cannot be safely inspected/u,
      );
    const resource = { Name: name, Driver: "bridge" };
    assert.deepEqual(
      inspectOptionalDockerResource(type, name, () =>
        JSON.stringify([resource]),
      ),
      resource,
    );
  }
});

void test("local runtime status admits only one container owned by its release", async () => {
  const id = "a".repeat(64);
  const imageId = `sha256:${"b".repeat(64)}`;
  const inspect = {
    Id: id,
    Image: imageId,
    Config: {
      Labels: {
        "com.docker.compose.project": "coffee-platform",
        "com.docker.compose.service": "edge-nginx",
        "com.docker.compose.project.working_dir": REPO_ROOT,
      },
      Env: ["PRIVATE_VALUE=synthetic-canary"],
    },
    State: { Status: "running", Health: { Status: "healthy" } },
  };
  const run = (args) => {
    if (args[0] === "inspect") return JSON.stringify([inspect]);
    return args.includes("label=com.docker.compose.service=edge-nginx")
      ? id
      : "";
  };
  const telemetry = {
    telemetryRoot: () => REPO_ROOT,
    inspectTelemetry: () => [],
  };
  const status = await inspectLocalRuntime({
    root: REPO_ROOT,
    run,
    ...telemetry,
  });
  assert.deepEqual(
    status.find((entry) => entry.service === "edge-nginx"),
    {
      service: "edge-nginx",
      containerId: id,
      imageId,
      status: "running",
      health: "healthy",
    },
  );
  assert.equal(status.filter((entry) => entry.status === "missing").length, 22);
  const telemetryId = "c".repeat(64);
  const sinkId = "d".repeat(64);
  const telemetryStatus = await inspectLocalRuntime({
    root: REPO_ROOT,
    run: (args) =>
      args[0] === "inspect" && [telemetryId, sinkId].includes(args[1])
        ? JSON.stringify([
            {
              ...inspect,
              Id: args[1],
              Config: {
                Labels: {
                  "com.docker.compose.service":
                    args[1] === sinkId ? "alert-sink" : "grafana",
                },
              },
              State:
                args[1] === sinkId
                  ? { Status: "running", Running: true }
                  : inspect.State,
            },
          ])
        : run(args),
    telemetryRoot: () => "/separate/observability/release",
    inspectTelemetry: ({ root }) => {
      assert.equal(root, "/separate/observability/release");
      return [telemetryId, sinkId];
    },
  });
  assert.equal(
    telemetryStatus.find((entry) => entry.service === "grafana").health,
    "healthy",
  );
  const sink = telemetryStatus.find((entry) => entry.service === "alert-sink");
  assert.equal(sink.health, "none");
  assert.equal(isLocalRuntimeReady(sink), true);
  assert.equal(isLocalRuntimeReady({ ...sink, status: "exited" }), false);
  assert.equal(isLocalRuntimeReady({ ...sink, health: "unhealthy" }), false);
  assert.equal(isLocalRuntimeReady({ ...sink, health: "unknown" }), false);
  assert.equal(
    isLocalRuntimeReady({
      service: "grafana",
      status: "running",
      health: "none",
    }),
    false,
  );
  assert.equal(
    isLocalRuntimeReady({
      service: "orders-service",
      status: "running",
      health: "unhealthy",
    }),
    false,
  );
  assert.doesNotMatch(JSON.stringify(status), /synthetic-canary/u);
  inspect.Config.Labels["com.docker.compose.project.working_dir"] = "/foreign";
  await assert.rejects(
    inspectLocalRuntime({ root: REPO_ROOT, run }),
    /does not belong/u,
  );
  await assert.rejects(
    inspectLocalRuntime({ root: REPO_ROOT, run: () => `${id}\n${id}` }),
    /ambiguous/u,
  );
});
const COMPOSE_FILE = join(REPO_ROOT, "compose.yaml");
const OBSERVABILITY_CONFIG = {
  platform: {
    shutdownGraceMs: 30000,
    health: {
      intervalMs: 5000,
      timeoutMs: 1000,
      startupGraceMs: 30000,
      failureThreshold: 3,
    },
  },
  telemetry: {
    collector: {
      otlpEndpoint: "http://otel-collector:4318",
      healthEndpoint: "http://otel-collector:13133",
      metricsEndpoint: "http://otel-collector:8888",
      memoryLimitMiB: 128,
      memorySpikeMiB: 32,
      containerMemoryMiB: 512,
    },
    producer: { maxRecordBytes: 16384, queueCapacity: 256 },
    logging: { maxSizeMiB: 8, maxFiles: 3 },
  },
};

void test("programmatic observability hooks require a bounded recovery-proof run", async () => {
  const {
    runComposeSmoke,
    isExternalRecoveryProof,
    readRecoveryProofCredentials,
  } = await import("../../tools/compose-smoke.mjs");
  const hooks = {
    exporterToken: "fixture-exporter-token",
    onReady: async () => {},
    onCleanup: async () => {},
  };
  const fixtureOptions = { recoveryProof: true, observabilityFixture: true };
  assert.equal(isExternalRecoveryProof(fixtureOptions), false);
  assert.equal(isExternalRecoveryProof({ recoveryProof: true }), true);
  const localCredentials = await readRecoveryProofCredentials(undefined);
  assert.equal(localCredentials.launchIdentity, undefined);
  assert.equal(localCredentials.postgres, undefined);
  assert.equal(localCredentials.ownership.databases.length, 5);
  assert.equal(
    Object.keys(localCredentials.databaseCredentialsByRuntime).length,
    10,
  );
  await assert.rejects(
    runComposeSmoke({ args: ["--recovery-proof", "--observability-fixture"] }),
    /requires programmatic observability hooks/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--observability-fixture"],
      observability: hooks,
    }),
    /requires programmatic observability hooks/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--observability-fixture", "--keep"],
      observability: hooks,
    }),
    /requires programmatic observability hooks/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--observability-fixture", "--no-build"],
      observability: hooks,
    }),
    /requires programmatic observability hooks/,
  );
  await assert.rejects(
    runComposeSmoke({ args: ["--stub-secrets"], observability: hooks }),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--no-build"],
      observability: hooks,
    }),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--keep"],
      observability: hooks,
    }),
    /require --recovery-proof/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof"],
      observability: { ...hooks, exporterToken: "" },
    }),
    /exporterToken must not be empty/,
  );
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof"],
      observability: { ...hooks, onReady: undefined },
    }),
    /onReady must be a function/,
  );
  let cleanupCalls = 0;
  let cleanupContext = "not-invoked";
  await assert.rejects(
    runComposeSmoke({
      args: ["--recovery-proof", "--project-name", "coffee-platform"],
      observability: {
        ...hooks,
        onCleanup: async (context) => {
          cleanupCalls += 1;
          cleanupContext = context;
        },
      },
    }),
    /main platform project/,
  );
  assert.equal(cleanupCalls, 1);
  assert.equal(cleanupContext, undefined);
});

void test("G14 verifies the exact owned PostgreSQL container before use and cleanup", async () => {
  const { assertObservabilityPostgresIdentity } =
    await import("../../tools/compose-smoke.mjs");
  const id = "a".repeat(64),
    projectName = "coffee-fixture",
    networkName = `${projectName}_coffee_postgres_data`,
    fixtureRunId = "fixture-run";
  const image = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  ).postgresFixtureImage;
  const info = {
    Id: id,
    Name: `/${projectName}-postgres-proof`,
    Config: { Image: image, Labels: { "coffee.g14.fixture": fixtureRunId } },
    NetworkSettings: {
      Networks: { bridge: {}, [networkName]: {} },
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "43210" }] },
    },
  };
  const input = {
    id,
    projectName,
    networkName,
    fixtureRunId,
    run: () => JSON.stringify([info]),
  };
  assert.doesNotThrow(() => assertObservabilityPostgresIdentity(input));
  info.Config.Labels["coffee.g14.fixture"] = "foreign";
  assert.throws(
    () => assertObservabilityPostgresIdentity(input),
    /owner changed/u,
  );
  info.Config.Labels["coffee.g14.fixture"] = fixtureRunId;
  info.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
  assert.throws(() => assertObservabilityPostgresIdentity(input), /loopback/u);
  info.NetworkSettings.Ports["5432/tcp"][0].HostIp = "127.0.0.1";
  delete info.NetworkSettings.Networks[networkName];
  assert.throws(
    () => assertObservabilityPostgresIdentity(input),
    /network mismatch/u,
  );
  assert.doesNotThrow(() =>
    assertObservabilityPostgresIdentity({
      ...input,
      allowIncompleteNetwork: true,
    }),
  );
});

void test("G14 PostgreSQL proof storage is verified tmpfs while other proof storage stays unchanged", async () => {
  const calls = [];
  let inspected = {
    "/var/lib/postgresql/data": "rw,noexec,nosuid,size=536870912",
  };
  let stat = "tmpfs|4096|131072";
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function startDatabaseProofContainer(");
  const inspect = source.indexOf(
    "function assertEphemeralDatabaseProofStorage(",
    start,
  );
  const end = source.indexOf("\nfunction bootstrapDatabaseProofRole(", inspect);
  assert.ok(start >= 0 && inspect > start && end > inspect);
  const helpers = runInNewContext(
    `(()=>{${source.slice(start, source.indexOf("\nexport function assertObservabilityPostgresIdentity(", start))}
${source.slice(inspect, end)}
return {startDatabaseProofContainer, assertEphemeralDatabaseProofStorage};})()`,
    {
      assert,
      DATABASE_PROOF_IMAGE: "fixture-postgres-image",
      runDocker(args) {
        calls.push(args);
        if (args[0] === "inspect") return JSON.stringify(inspected);
        if (args[0] === "exec") return stat;
        return "";
      },
    },
  );
  assert.equal(
    helpers.startDatabaseProofContainer(
      "g14-proof",
      "g14-network",
      { username: "admin", password: "fixture" },
      { ephemeralPgData: true },
    ),
    "g14-proof-postgres-proof",
  );
  assert.ok(calls[0].includes("--tmpfs"));
  const storage = helpers.assertEphemeralDatabaseProofStorage(
    "g14-proof-postgres-proof",
  );
  assert.equal(storage.type, "tmpfs");
  assert.equal(storage.destination, "/var/lib/postgresql/data");
  assert.equal(storage.sizeMiB, 512);
  assert.equal(storage.durability, "ephemeral");
  assert.deepEqual(
    [...calls[1]],
    [
      "inspect",
      "--format",
      "{{json .HostConfig.Tmpfs}}",
      "g14-proof-postgres-proof",
    ],
  );
  assert.deepEqual(
    [...calls[2]],
    [
      "exec",
      "g14-proof-postgres-proof",
      "stat",
      "-f",
      "-c",
      "%T|%S|%b",
      "/var/lib/postgresql/data",
    ],
  );

  calls.length = 0;
  assert.equal(
    helpers.startDatabaseProofContainer("other-proof", "other-network", {
      username: "admin",
      password: "fixture",
    }),
    "other-proof-postgres-proof",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes("--tmpfs"), false);
  assert.equal(
    calls.some((args) => args[0] === "inspect" || args[0] === "exec"),
    false,
  );

  for (const output of [
    "ext4|4096|131072",
    "tmpfs|4096|131071",
    "tmpfs|4096",
    "tmpfs|x|131072",
  ]) {
    stat = output;
    assert.throws(() =>
      helpers.assertEphemeralDatabaseProofStorage("bad-proof-postgres-proof"),
    );
  }
});

void test("launch-path PostgreSQL fixture requests a pinned image and bounded tmpfs", async () => {
  const source = await readFile(
    join(REPO_ROOT, "scripts/catalog-live-harness.mjs"),
    "utf8",
  );
  const image = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  ).postgresFixtureImage;
  assert.match(image, /^postgres:17\.11@sha256:[0-9a-f]{64}$/u);
  const calls = [];
  const start = source.indexOf("export async function withCatalogPostgres(");
  assert.ok(start >= 0);
  const fixture = runInNewContext(
    `(()=>{${source.slice(start).replace("export async function", "async function")};return withCatalogPostgres;})()`,
    {
      assert,
      process: { pid: 123 },
      performance,
      AggregateError,
      Error,
      image,
      databaseName: "coffee_platform_catalog",
      password: "fixture",
      randomBytes: () => ({ toString: () => "aabbccdd" }),
      docker: async (...args) => {
        calls.push(args);
        throw new Error("fixture stops before Docker");
      },
    },
  );
  await assert.rejects(
    fixture(async () => {}),
    /owned-container cleanup was not verified/u,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at(-1), image);
  const index = calls[0].indexOf("--tmpfs");
  assert.ok(index > 0);
  assert.equal(
    calls[0][index + 1],
    "/var/lib/postgresql/data:rw,noexec,nosuid,size=536870912",
  );
  assert.ok(calls[0].includes("127.0.0.1::5432"));
});

void test("smoke removes only project-scoped images built by this run", async (t) => {
  const { buildRuntimeImages, removeBuiltRuntimeImages } =
    await import("../../tools/compose-smoke.mjs");
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push([command, args]);
    if (args.includes("RUNTIME=second")) throw new Error("build interrupted");
    return "";
  });
  syncBuiltinESMExports();
  try {
    const images = [];
    assert.throws(
      () =>
        buildRuntimeImages("coffee-cleanup-proof", ["first", "second"], images),
      /interrupted/,
    );
    assert.deepEqual(images, ["coffee-cleanup-proof-first:latest"]);
    calls.length = 0;
    removeBuiltRuntimeImages(images, { keep: true });
    removeBuiltRuntimeImages(images, { noBuild: true });
    assert.deepEqual(calls, []);
    removeBuiltRuntimeImages(images, {});
    assert.deepEqual(calls, [
      [
        "docker",
        ["image", "rm", "--no-prune", "coffee-cleanup-proof-first:latest"],
      ],
    ]);
    calls.length = 0;
    const complete = [];
    buildRuntimeImages("coffee-cleanup-proof", ["first"], complete);
    assert.deepEqual(complete, [
      "coffee-cleanup-proof-first:latest",
      "coffee-cleanup-proof-edge-nginx:latest",
    ]);
    calls.length = 0;
    buildRuntimeImages(
      "coffee-g14-child-proof",
      ["first"],
      [],
      "/private/g14-child-C",
    );
    assert.equal(calls[0][1].at(-1), "/private/g14-child-C");
    calls.length = 0;
    const missingOnly = [];
    buildRuntimeImages(
      "coffee-local-build",
      ["first"],
      missingOnly,
      "/private/source",
      { includeNginx: false },
    );
    assert.deepEqual(missingOnly, ["coffee-local-build-first:latest"]);
    assert.equal(calls.length, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("canonical image loads enforce BuildKit policy and normalize exporter timestamps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "coffee-image-wrapper-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const capture = join(dir, "capture.json");
  const callsPath = join(dir, "calls.jsonl");
  const document = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  const policy = document.platform.buildkit;
  const pins = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const fixture = {
    Config: { Image: pins.buildkitImage },
    HostConfig: {
      Memory: policy.memoryMiB * 1048576,
      MemorySwap: policy.memorySwapMiB * 1048576,
      NanoCpus: 0,
      CpuPeriod: 100000,
      CpuQuota: policy.cpus * 100000,
      NetworkMode: "coffee_platform_build_mtu",
    },
    Mounts: [
      {
        Type: "volume",
        Name: "buildx_buildkit_coffee-platform-mtu0_state",
        Destination: "/var/lib/buildkit",
      },
    ],
  };
  const toml = `[worker]\n[worker.oci]\ngc = true\nmax-parallelism = ${policy.maxParallelism}\nmaxUsedSpace = '${policy.maxUsedSpaceGiB}GiB'\nminFreeSpace = '${policy.minFreeSpaceGiB}GiB'\nreservedSpace = '${policy.reservedSpaceGiB}GiB'\n`;
  const workers = [
    {
      gcPolicy: [
        {
          all: true,
          reservedSpace: policy.reservedSpaceGiB * 1073741824,
          maxUsedSpace: policy.maxUsedSpaceGiB * 1073741824,
          minFreeSpace: policy.minFreeSpaceGiB * 1073741824,
        },
      ],
    },
  ];
  const fakeDocker = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const drift = process.env.COFFEE_WRAPPER_DRIFT;
const call = {args};
if (args[0] === 'buildx' && args[1] === 'create') call.config = fs.readFileSync(args[args.indexOf('--buildkitd-config') + 1], 'utf8');
fs.appendFileSync(process.env.COFFEE_WRAPPER_CALLS, JSON.stringify(call) + '\\n');
if (args[0] === 'network' && args[1] === 'inspect') {
  console.log(JSON.stringify([{Options: {'com.docker.network.driver.mtu': '1280'}}]));
} else if (args[0] === 'buildx' && args[1] === 'inspect') {
  if (process.env.COFFEE_WRAPPER_MISSING === '1' && !fs.readFileSync(process.env.COFFEE_WRAPPER_CALLS, 'utf8').includes('"create"')) {
    console.error('ERROR: no builder "coffee-platform-mtu" found'); process.exit(1);
  }
  if (drift === 'unavailable') {console.error('Cannot connect to Docker'); process.exit(1);}
  console.log('Name: coffee-platform-mtu\\nDriver: ' + (drift === 'driver' ? 'docker' : 'docker-container') + '\\nName: coffee-platform-mtu0');
  if (drift === 'nodes') console.log('Name: foreign-node');
} else if (args[0] === 'inspect') {
  const row = ${JSON.stringify(fixture)};
  if (drift === 'image') row.Config.Image = 'moby/buildkit:latest';
  if (drift === 'memory') row.HostConfig.Memory = 0;
  if (drift === 'swap') row.HostConfig.MemorySwap = 0;
  if (drift === 'cpu') {row.HostConfig.CpuQuota = 0; row.HostConfig.CpuPeriod = 0;}
  if (drift === 'network') row.HostConfig.NetworkMode = 'host';
  if (drift === 'volume') row.Mounts[0].Name = 'foreign';
  console.log(JSON.stringify([row]));
} else if (args[0] === 'exec' && args[2] === 'cat') {
  let text = ${JSON.stringify(toml)};
  if (drift === 'parallelism') text = text.replace('max-parallelism = ${policy.maxParallelism}', 'max-parallelism = 8');
  console.log(text);
} else if (args[0] === 'exec' && args[2] === 'buildctl') {
  const workers = ${JSON.stringify(workers)};
  if (drift === 'gc') workers[0].gcPolicy[0].maxUsedSpace = 0;
  console.log(JSON.stringify(workers));
} else if (args[0] === 'buildx' && args[1] === 'build') {
  fs.writeFileSync(process.env.COFFEE_WRAPPER_CAPTURE, JSON.stringify({args, epoch: process.env.SOURCE_DATE_EPOCH ?? null}));
}
`;
  await writeFile(join(dir, "docker"), fakeDocker, { mode: 0o755 });
  await writeFile(join(dir, "getent"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(join(dir, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const previous = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = "123";
  t.after(() => {
    if (previous === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = previous;
  });
  const runWrapper = async (args, env = {}) => {
    await rm(capture, { force: true });
    await writeFile(callsPath, "");
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "tools/docker-build.mjs"), ...args],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          COFFEE_WRAPPER_CAPTURE: capture,
          COFFEE_WRAPPER_CALLS: callsPath,
          ...env,
        },
        encoding: "utf8",
      },
    );
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { result, calls };
  };
  for (const { args, normalized } of [
    {
      args: [
        "--target",
        "runtime",
        "--build-arg",
        "RUNTIME=edge-gateway",
        "--load",
        ".",
      ],
      normalized: true,
    },
    { args: ["--target", "edge-nginx", "--load", "."], normalized: true },
    {
      args: ["--target", "runtime", "--output", "type=oci,dest=custom", "."],
      normalized: false,
    },
    {
      args: [
        "--target",
        "runtime",
        "--load",
        "--output=type=oci,dest=custom",
        ".",
      ],
      normalized: false,
    },
  ]) {
    const { result, calls } = await runWrapper(args);
    assert.ok(
      !calls.some(({ args }) => args[0] === "buildx" && args[1] === "create"),
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(actual.epoch, normalized ? null : "123");
    assert.equal(process.env.SOURCE_DATE_EPOCH, "123");
    assert.equal(
      actual.args.includes(
        "type=docker,source-date-epoch=0,rewrite-timestamp=true",
      ),
      normalized,
    );
    assert.equal(actual.args.includes("--load"), args.includes("--load"));
    assert.ok(
      !actual.args.some((value) => value.startsWith("SOURCE_DATE_EPOCH=")),
    );
  }
  const created = await runWrapper(["--load", "."], {
    COFFEE_WRAPPER_MISSING: "1",
  });
  assert.equal(created.result.status, 0, created.result.stderr);
  const creation = created.calls.find(
    ({ args }) => args[0] === "buildx" && args[1] === "create",
  );
  assert.ok(creation);
  for (const value of [
    `image=${pins.buildkitImage}`,
    "network=coffee_platform_build_mtu",
    `memory=${policy.memoryMiB}m`,
    `memory-swap=${policy.memorySwapMiB}m`,
    "cpu-period=100000",
    `cpu-quota=${policy.cpus * 100000}`,
  ])
    assert.ok(creation.args.includes(value), value);
  assert.ok(
    creation.args.includes("--allow-insecure-entitlement=network.host"),
  );
  assert.match(creation.config, /\[registry\."docker\.io"\]/u);
  assert.ok(creation.config.includes(policy.registryCaFile));
  assert.match(creation.config, /gc = true/u);
  assert.ok(
    creation.config.includes(`max-parallelism = ${policy.maxParallelism}`),
  );
  for (const [key, value] of [
    ["reservedSpace", policy.reservedSpaceGiB],
    ["maxUsedSpace", policy.maxUsedSpaceGiB],
    ["minFreeSpace", policy.minFreeSpaceGiB],
  ])
    assert.ok(creation.config.includes(`${key} = "${value}GiB"`));
  await assert.rejects(
    stat(creation.args[creation.args.indexOf("--buildkitd-config") + 1]),
    { code: "ENOENT" },
  );
  for (const drift of [
    "driver",
    "nodes",
    "image",
    "memory",
    "swap",
    "cpu",
    "network",
    "volume",
    "parallelism",
    "gc",
    "unavailable",
  ]) {
    const failed = await runWrapper(["--load", "."], {
      COFFEE_WRAPPER_DRIFT: drift,
    });
    assert.notEqual(failed.result.status, 0, drift);
    assert.match(failed.result.stderr, /BuildKit/u);
    assert.ok(
      !failed.calls.some(
        ({ args }) =>
          ["create", "build"].includes(args[1]) ||
          ["rm", "stop", "update"].includes(args[0]),
      ),
      drift,
    );
    await assert.rejects(readFile(capture), { code: "ENOENT" });
  }
});

void test("smoke accepts only runtime image IDs verified by G12 before startup", async (t) => {
  const { assertVerifiedRuntimeImages } =
    await import("../../tools/compose-smoke.mjs");
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"),
  );
  const verifiedImages = catalog.runtimes.map(({ name }, index) => ({
    service: name,
    imageId: `sha256:${(index + 1).toString(16).padStart(64, "0")}`,
  }));
  const expected = new Map(
    verifiedImages.map(({ service, imageId }) => [
      `coffee-test-${service}:latest`,
      imageId,
    ]),
  );
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push([command, args]);
    assert.equal(command, "docker");
    assert.deepEqual(args.slice(0, 4), [
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
    ]);
    return `${expected.get(args[4])}\n`;
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() =>
      assertVerifiedRuntimeImages({
        projectName: "coffee-test",
        verifiedImages,
      }),
    );
    assert.equal(calls.length, 15);
    expected.set(
      "coffee-platform-edge-nginx:local",
      verifiedImages.at(-1).imageId,
    );
    assert.doesNotThrow(() =>
      assertVerifiedRuntimeImages({
        projectName: "coffee-test",
        verifiedImages,
        noBuild: true,
      }),
    );
    assert.equal(calls.at(-1)[1].at(-1), "coffee-platform-edge-nginx:local");
    const source = await readFile(
      join(REPO_ROOT, "tools/compose-smoke.mjs"),
      "utf8",
    );
    const binding = source.indexOf("const verifiedImages = await (");
    const build = source.indexOf(
      "buildRuntimeImages(",
      source.indexOf('markRollbackStage("build")'),
    );
    assert.ok(build >= 0 && binding > build);
    assert.ok(
      source.indexOf("verifyBuildInputSnapshot(snapshot)", build) < binding,
    );
    const predicate = source.match(
      /const bindRuntimeImages =\s*([^;]+);/u,
    )?.[1];
    assert.ok(predicate);
    for (const flag of [
      "databaseProof",
      "customerProof",
      "aromaBindingProof",
      "aromaCartProof",
      "mutationDisableRollback",
    ])
      assert.equal(
        runInNewContext(predicate, {
          options: { [flag]: true },
          browser: undefined,
        }),
        false,
      );
    assert.equal(
      runInNewContext(predicate, { options: {}, browser: {} }),
      false,
    );
    assert.equal(
      runInNewContext(predicate, { options: {}, browser: undefined }),
      true,
    );
    assert.ok(source.includes("if (imageIdentity && bindRuntimeImages)"));
    assert.ok(binding < source.indexOf("composeAttempted = true;", binding));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("smoke rejects mismatched or missing G12 runtime IDs before startup", async (t) => {
  const { assertVerifiedRuntimeImages } =
    await import("../../tools/compose-smoke.mjs");
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"),
  );
  const verifiedImages = catalog.runtimes.map(({ name }) => ({
    service: name,
    imageId: `sha256:${"a".repeat(64)}`,
  }));
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (command, args) => {
    calls.push([command, args]);
    return `sha256:${"b".repeat(64)}\n`;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        assertVerifiedRuntimeImages({
          projectName: "coffee-test",
          verifiedImages,
        }),
      /differs from the scanned G12 artifact/u,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(0, 2), ["image", "inspect"]);
    calls.length = 0;
    assert.throws(
      () =>
        assertVerifiedRuntimeImages({
          projectName: "coffee-test",
          verifiedImages: [],
        }),
      /G12 image ID missing/u,
    );
    assert.deepEqual(calls, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("G14 retains scoped resources when collector restoration is unconfirmed", async (t) => {
  const {
    retainG14AfterCollectorFailure,
    externalRecoveryCleanupSummary,
    removeBuiltRuntimeImages,
  } = await import("../../tools/compose-smoke.mjs");
  const options = { keep: false, noBuild: false };
  const databases = [{ database: { name: "coffee_verify_run_orders" } }];
  const receipt = retainG14AfterCollectorFailure({
    g14Browser: {},
    observability: {},
    cleanupHookError: new Error("IPC disconnected"),
    options,
    databases,
  });
  assert.equal(options.keep, true);
  assert.deepEqual(receipt, {
    verified: false,
    removed: [],
    retained: ["coffee_verify_run_orders"],
    failure: "G14_COLLECTOR_RESTORE_UNCONFIRMED",
  });
  const calls = [];
  t.mock.method(childProcess, "execFileSync", (...args) => calls.push(args));
  syncBuiltinESMExports();
  try {
    removeBuiltRuntimeImages(["sha256:example"], options);
    assert.deepEqual(calls, []);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const summary = externalRecoveryCleanupSummary({
    databases: receipt,
    attachment: {
      baselineAttached: false,
      attempted: true,
      attached: true,
      routeBefore: "route",
      routeAfter: "route",
    },
    cleanupFailed: true,
  });
  assert.equal(summary.verified, false);
  assert.equal(summary.attachment.removed, false);
  const normal = { keep: false };
  assert.equal(
    retainG14AfterCollectorFailure({
      g14Browser: undefined,
      observability: {},
      cleanupHookError: new Error("error"),
      options: normal,
      databases,
    }),
    undefined,
  );
  assert.equal(normal.keep, false);
  assert.equal(
    retainG14AfterCollectorFailure({
      g14Browser: {},
      observability: {},
      cleanupHookError: undefined,
      options: normal,
      databases,
    }),
    undefined,
  );
  assert.equal(normal.keep, false);
});

void test("G14 seals the child config for every Node runtime and rejects mismatch", async (t) => {
  const { writeScopedComposeOverride } =
    await import("../../tools/compose-smoke.mjs");
  const { load } = await import("js-yaml");
  const dir = await mkdtemp(join(tmpdir(), "g14-child-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const context = join(dir, "context.json");
  const config = join(dir, "platform.yaml");
  await writeFile(context, "{}", { mode: 0o400 });
  await writeFile(config, "child: true\n", { mode: 0o444 });
  await chmod(config, 0o444);
  const sha256 = createHash("sha256")
    .update(await readFile(config))
    .digest("hex");
  const override = await writeScopedComposeOverride("coffee-g14-config", {
    launchContextPath: context,
    g14Config: { path: config, sha256 },
  });
  t.after(() => rm(override, { force: true }));
  const services = load(await readFile(override, "utf8")).services;
  for (const runtime of RUNTIMES) {
    assert.equal(
      services[runtime].environment.COFFEE_LAUNCH_CONTEXT_FILE,
      "/run/coffee-launch/context.json",
    );
    assert.deepEqual(
      services[runtime].volumes.filter(
        ({ target }) => target === "/app/config/platform.yaml",
      ),
      [
        {
          type: "bind",
          source: config,
          target: "/app/config/platform.yaml",
          read_only: true,
        },
      ],
    );
    assert.equal(
      services[runtime].volumes.find(
        ({ target }) => target === "/run/coffee-launch/context.json",
      ).source,
      context,
    );
  }
  await assert.rejects(
    writeScopedComposeOverride("coffee-g14-config", {
      launchContextPath: context,
      g14Config: { path: config, sha256: "a".repeat(64) },
    }),
    /G14 config hash mismatch/u,
  );
  await chmod(config, 0o644);
  await assert.rejects(
    writeScopedComposeOverride("coffee-g14-config", {
      launchContextPath: context,
      g14Config: { path: config, sha256 },
    }),
    /G14 config must be sealed and owned/u,
  );
});

void test("all smoke modes isolate networks and can bind a readonly launch context", async (t) => {
  const { writeScopedComposeOverride } =
    await import("../../tools/compose-smoke.mjs");
  const contextPath = join(
    tmpdir(),
    `coffee-launch-context-${process.pid}.json`,
  );
  await writeFile(contextPath, "{}\n", { mode: 0o400 });
  t.after(() => rm(contextPath, { force: true }));
  for (const [sharedPostgres, recoveryLogging] of [
    [true, false],
    [false, false],
    [false, true],
  ]) {
    const path = await writeScopedComposeOverride("coffee-scope-proof", {
      sharedPostgres,
      launchContextPath: contextPath,
      kafkaImage: `sha256:${"a".repeat(64)}`,
      edgeNginxImage: "coffee-scope-proof-edge-nginx:latest",
      ...(recoveryLogging
        ? { recoveryProof: true, runtimeLogging: OBSERVABILITY_CONFIG }
        : {}),
    });
    try {
      const result = spawnSync(
        "docker",
        [
          "compose",
          "-p",
          "coffee-scope-proof",
          "-f",
          COMPOSE_FILE,
          "-f",
          path,
          "config",
          "--format",
          "json",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, COFFEE_COMPOSE_SECRETS_DIR: "/dev/shm" },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const config = JSON.parse(result.stdout);
      assert.equal(config.services.kafka.image, `sha256:${"a".repeat(64)}`);
      assert.equal(config.services.kafka.pull_policy, "never");
      assert.equal(config.services.kafka.build, undefined);
      for (const [name, network] of Object.entries(config.networks)) {
        assert.equal(
          network.name,
          name === "coffee_postgres_data" && sharedPostgres
            ? name
            : `coffee-scope-proof_${name}`,
        );
      }
      assert.equal(config.networks.coffee_postgres_data.external, true);
      assert.equal(
        config.services["edge-nginx"].image,
        "coffee-scope-proof-edge-nginx:latest",
      );
      assert.equal(
        config.services["orders-service"].environment
          .COFFEE_LAUNCH_CONTEXT_FILE,
        "/run/coffee-launch/context.json",
      );
      assert.ok(
        config.services["orders-service"].volumes.some(
          ({ source, target, read_only }) =>
            source === contextPath &&
            target === "/run/coffee-launch/context.json" &&
            read_only,
        ),
      );
      if (recoveryLogging) {
        const expectedLogging = createRuntimeLoggingOverride({
          config: OBSERVABILITY_CONFIG,
        }).services;
        for (const [service, expected] of Object.entries(expectedLogging)) {
          assert.deepEqual(
            config.services[service].logging,
            expected.logging,
            `${service} Docker logging policy`,
          );
        }
        assert.equal(
          config.services["aroma-provider-fixture"].logging,
          undefined,
        );
      } else assert.equal(config.services["edge-gateway"].logging, undefined);
    } finally {
      await rm(path);
    }
  }
});

void test("local container controls exclude shared PostgreSQL and refuse deletion of running groups", async () => {
  const directory = await mkdtemp("/dev/shm/coffee-controls-proof-");
  const docker = join(directory, "docker");
  await writeFile(
    docker,
    `#!/bin/sh
case "$1" in
  ps)
    case "$*" in
      *service=api*) echo 'api-id api' ;;
      *) printf 'db-id postgres\\napi-id api\\nui-id blazorui\\n' ;;
    esac ;;
  inspect)
    case "$*" in *Running*) echo true ;; *) printf '%s\\n' "$*" ;; esac ;;
  start|stop) printf '%s\\n' "$*" ;;
  container) echo 'unsafe delete reached' >&2; exit 99 ;;
  *) exit 98 ;;
esac
`,
    "utf8",
  );
  await chmod(docker, 0o700);
  const run = (...args) =>
    spawnSync(
      "bash",
      [join(REPO_ROOT, "tools/coffee-containers.sh"), ...args],
      {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      },
    );
  try {
    const status = run("legacy", "status");
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /api-id ui-id/);
    assert.doesNotMatch(status.stdout, /db-id/);
    const start = run("legacy", "start");
    assert.equal(start.status, 0);
    assert.equal(
      start.stdout.trim(),
      "start api-id",
      "disabled UI must remain stopped",
    );
    const stop = run("legacy", "stop");
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout.trim(), "stop --time 30 api-id ui-id");
    const removal = run("legacy", "remove");
    assert.equal(removal.status, 1);
    assert.match(removal.stderr, /Сначала/);
    assert.doesNotMatch(removal.stderr, /unsafe delete/);
    assert.equal(run("legacy", "remove", "--volumes").status, 2);
    assert.equal(run("unknown", "stop").status, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const RUNTIMES = [
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
];

const NETWORKS = {
  "edge-gateway": ["coffee_edge_backend"],
  "api-public": ["coffee_edge_backend", "coffee_public_api_backend"],
  "api-internal": ["coffee_internal_api"],

  "customer-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "catalog-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "catalog-supplier-sync": ["coffee_internal_api", "coffee_postgres_data"],
  "catalog-activation-worker": [
    "coffee_postgres_data",
    "coffee_kafka_event",
    "coffee_internal_api",
  ],
  "pricing-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
  ],
  "orders-service": [
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "orders-aroma-preparation": ["coffee_postgres_data", "coffee_kafka_event"],
  "aroma-observer": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "aroma-convergence": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_kafka_event",
  ],
  "aroma-gateway": [
    "coffee_internal_api",
    "coffee_postgres_data",
    "coffee_provider_egress",
  ],
  "realtime-gateway": ["coffee_edge_backend", "coffee_kafka_event"],
};

const SCOPED_SECRET_NAMES = [
  ...RUNTIMES.map((runtime) => `runtime-${runtime}`),
  "edge-nginx-public-cert",
  "edge-nginx-public-key",
  "edge-nginx-upstream-ca",
  "edge-nginx-client-cert",
  "edge-nginx-client-key",
];

function composeConfig(projectName) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      ...(projectName === undefined ? [] : ["--project-name", projectName]),
      "-f",
      COMPOSE_FILE,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.error,
    undefined,
    `Docker is required for topology validation: ${result.error?.message ?? ""}`,
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

void test("Compose materializes 14 Node runtimes, native nginx, and Kafka", () => {
  const config = composeConfig();
  const platformConfig = parseYaml(
    readFileSync(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(config.services).sort((left, right) =>
      left.localeCompare(right),
    ),
    [...RUNTIMES, "edge-nginx", "kafka"].sort((left, right) =>
      left.localeCompare(right),
    ),
  );
  assert.equal(config.services["api-agent"], undefined);
  assert.equal(config.services["config-bootstrap"], undefined);
  assert.equal(config.services.postgres, undefined);
  const nginx = config.services["edge-nginx"];
  assert.equal(nginx.build.dockerfile, "apps/edge-nginx/Dockerfile");
  assert.deepEqual(Object.keys(nginx.depends_on).sort(), [
    "api-public",
    "edge-gateway",
    "realtime-gateway",
  ]);
  for (const dependency of Object.values(nginx.depends_on))
    assert.equal(dependency.condition, "service_healthy");
  assert.equal(nginx.user, "101:101");
  assert.equal(nginx.read_only, true);
  assert.equal(nginx.init, true);
  assert.equal(nginx.volumes, undefined);
  assert.equal(nginx.cpus, 2, "native nginx must have the accepted CPU bound");
  assert.equal(
    nginx.mem_limit,
    "536870912",
    "native nginx must have the accepted 512 MiB memory bound",
  );
  assert.deepEqual(nginx.ulimits?.nofile, { soft: 16384, hard: 16384 });
  assert.deepEqual(nginx.tmpfs, ["/tmp:rw,noexec,nosuid,nodev,size=8m"]);
  assert.deepEqual(Object.keys(nginx.networks).sort(), [
    "coffee_edge_backend",
    "coffee_host_ingress",
  ]);
  assert.deepEqual(
    nginx.ports.map(({ target, published, host_ip }) => ({
      target,
      published,
      host_ip,
    })),
    [{ target: 8443, published: "8443", host_ip: "127.0.0.1" }],
  );
  assert.deepEqual(
    nginx.secrets.map(({ target, uid, gid, mode }) => ({
      target,
      uid,
      gid,
      mode,
    })),
    [
      {
        target: "/run/secrets/edge-nginx/public.crt",
        uid: "101",
        gid: "101",
        mode: "0400",
      },
      {
        target: "/run/secrets/edge-nginx/public.key",
        uid: "101",
        gid: "101",
        mode: "0400",
      },
      {
        target: "/run/secrets/edge-nginx/upstream-ca.crt",
        uid: "101",
        gid: "101",
        mode: "0400",
      },
      {
        target: "/run/secrets/edge-nginx/client.crt",
        uid: "101",
        gid: "101",
        mode: "0400",
      },
      {
        target: "/run/secrets/edge-nginx/client.key",
        uid: "101",
        gid: "101",
        mode: "0400",
      },
    ],
  );

  for (const runtime of RUNTIMES) {
    const service = config.services[runtime];
    assert.deepEqual(
      Object.keys(service.networks).sort((left, right) =>
        left.localeCompare(right),
      ),
      [...NETWORKS[runtime]].sort((left, right) => left.localeCompare(right)),
      runtime,
    );
    assert.equal(service.stop_grace_period, "30s", runtime);
    assert.equal(service.user, "node", runtime);
    assert.equal(service.init, true, runtime);
    assert.equal(service.read_only, true, runtime);
    assert.deepEqual(
      service.tmpfs,
      ["/tmp:rw,noexec,nosuid,nodev", "/run/secrets:rw,noexec,nosuid,nodev"],
      runtime,
    );
    assert.equal(service.volumes, undefined, runtime);
    assert.deepEqual(
      service.healthcheck.test.slice(0, 1),
      ["CMD-SHELL"],
      runtime,
    );
    const limits = runtimeContainerLimits(platformConfig, runtime);
    assert.equal(service.cpus, limits.cpus, runtime);
    assert.equal(
      Number(service.mem_limit),
      Number.parseInt(limits.mem_limit) * 1048576,
      runtime,
    );
    assert.equal(service.healthcheck.interval, "30s", runtime);
    assert.equal(service.healthcheck.start_interval, "5s", runtime);
    assert.equal(service.environment.RUNTIME_NAME, runtime, runtime);
    assert.equal(
      service.environment.COFFEE_CONFIG_FILE,
      "/app/config/platform.yaml",
      runtime,
    );
    assert.equal(
      service.environment.COFFEE_RUNTIME_SECRETS_FILE,
      "/run/secrets/coffee-platform.yaml",
      runtime,
    );
    assert.equal(service.environment.OTEL_SERVICE_NAME, runtime, runtime);
    assert.equal(
      service.environment.OTEL_PROPAGATORS,
      "tracecontext,baggage",
      runtime,
    );
    assert.equal(
      service.environment.OTEL_RESOURCE_ATTRIBUTES,
      "service.namespace=coffee-platform,deployment.environment=development",
      runtime,
    );
    assert.equal(
      service.environment.OTEL_EXPORTER_OTLP_PROTOCOL,
      "http/protobuf",
      runtime,
    );
    assert.deepEqual(
      service.secrets,
      [
        {
          source: `runtime-${runtime}`,
          target: "/run/secrets/coffee-platform.yaml",
          uid: "1000",
          gid: "1000",
          mode: "0400",
        },
      ],
      runtime,
    );
    assert.equal(service.ports, undefined, runtime);
  }
  assert.deepEqual(
    Object.keys(config.secrets).sort((left, right) =>
      left.localeCompare(right),
    ),
    [...SCOPED_SECRET_NAMES].sort((left, right) => left.localeCompare(right)),
  );
  for (const runtime of RUNTIMES) {
    const source = config.secrets[`runtime-${runtime}`].file;
    assert.match(
      source,
      /^\/dev\/shm\//,
      `${runtime} secret source must be ephemeral tmpfs`,
    );
    assert.equal(
      source.includes("/CoffeeOrderPlatform"),
      false,
      `${runtime} secret source must not be persistent workspace storage`,
    );
  }
});

void test("Compose networks enforce the launch planes and external PostgreSQL attachment", () => {
  const config = composeConfig();
  assert.deepEqual(Object.keys(config.networks).sort(), [
    "coffee_edge_backend",
    "coffee_host_ingress",
    "coffee_internal_api",
    "coffee_kafka_event",
    "coffee_postgres_data",
    "coffee_provider_egress",
    "coffee_public_api_backend",
  ]);
  assert.equal(config.networks.coffee_postgres_data.external, true);
  assert.equal(
    config.networks.coffee_postgres_data.name,
    "coffee_postgres_data",
  );
  assert.equal(config.networks.coffee_postgres_data.internal, undefined);
  assert.equal(config.networks.coffee_host_ingress.name, "coffee_host_ingress");
  assert.notEqual(config.networks.coffee_host_ingress.internal, true);
  assert.deepEqual(
    Object.entries(config.services)
      .filter(([, service]) =>
        Object.hasOwn(service.networks, "coffee_host_ingress"),
      )
      .map(([name]) => name),
    ["edge-nginx"],
    "only edge-nginx may join the host-reachable ingress network",
  );
  assert.notEqual(config.networks.coffee_provider_egress.internal, true);
  for (const name of [
    "coffee_edge_backend",
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_kafka_event",
  ]) {
    assert.equal(config.networks[name].internal, true, name);
  }
});

void test("Compose keeps forbidden trust-plane connections absent (negative topology)", () => {
  const config = composeConfig();
  const forbidden = {
    "edge-gateway": [
      "coffee_public_api_backend",
      "coffee_internal_api",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "api-public": [
      "coffee_internal_api",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "api-internal": [
      "coffee_public_api_backend",
      "coffee_postgres_data",
      "coffee_kafka_event",
      "coffee_provider_egress",
    ],
    "customer-service": ["coffee_kafka_event", "coffee_provider_egress"],
    "aroma-gateway": ["coffee_kafka_event"],
  };
  for (const runtime of RUNTIMES) {
    const attached = new Set(Object.keys(config.services[runtime].networks));
    assert.equal(
      attached.has("coffee_network"),
      false,
      `${runtime} must not join legacy coffee_network`,
    );
    for (const network of forbidden[runtime] ?? []) {
      assert.equal(
        attached.has(network),
        false,
        `${runtime} must not join ${network}`,
      );
    }
  }
  const providerMembers = RUNTIMES.filter((runtime) =>
    Object.hasOwn(config.services[runtime].networks, "coffee_provider_egress"),
  );
  assert.deepEqual(providerMembers, ["aroma-gateway"]);
});

void test("Kafka requires the verified G12 artifact and preserves single-node KRaft without host publish", async () => {
  const config = composeConfig();
  const kafka = config.services.kafka;
  assert.equal(kafka.image, "coffee-platform-kafka:verified-artifact-required");
  assert.equal(kafka.pull_policy, "never");
  assert.equal(kafka.cpus, 2);
  assert.equal(Number(kafka.mem_limit), 2048 * 1048576);
  assert.equal(kafka.build, undefined);
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  assert.equal(
    toolchain.kafkaImage,
    "apache/kafka:4.3.2@sha256:852a0d49fc4e656b022e7f23785411802c9a088c78a7c5e39f33969de9c227a7",
  );
  assert.deepEqual(Object.keys(kafka.networks), ["coffee_kafka_event"]);
  assert.equal(kafka.ports, undefined);
  assert.equal(kafka.environment.KAFKA_PROCESS_ROLES, "broker,controller");
  assert.equal(
    kafka.environment.KAFKA_LISTENER_SECURITY_PROTOCOL_MAP,
    "CONTROLLER:PLAINTEXT,SASL_SSL:SASL_SSL",
  );
  assert.equal(
    kafka.environment.KAFKA_LISTENERS,
    "SASL_SSL://:9092,CONTROLLER://:29093",
  );
  assert.equal(
    kafka.environment.KAFKA_ADVERTISED_LISTENERS,
    "SASL_SSL://kafka:9092",
  );
  assert.equal(kafka.environment.KAFKA_INTER_BROKER_LISTENER_NAME, "SASL_SSL");
  assert.equal(kafka.environment.KAFKA_AUTO_CREATE_TOPICS_ENABLE, "false");
  assert.match(kafka.healthcheck.test[1], /kafka-broker-api-versions/);
  assert.match(kafka.healthcheck.test[1], /^KAFKA_JVM_PERFORMANCE_OPTS='/);
  for (const option of [
    "-XX:+UseSerialGC",
    "-XX:TieredStopAtLevel=1",
    "-XX:ActiveProcessorCount=1",
    "-XX:SharedArchiveFile=/opt/kafka/kafka.jsa",
    "-XX:CICompilerCount=1",
    "-Xbatch",
  ])
    assert.ok(kafka.healthcheck.test[1].includes(option), option);
  assert.match(
    kafka.healthcheck.test[1],
    /--command-config \/etc\/kafka\/secrets\/client\.properties/,
  );
  assert.equal(kafka.environment.KAFKA_JVM_PERFORMANCE_OPTS, undefined);
  assert.equal(kafka.healthcheck.interval, "30s");
  assert.equal(kafka.healthcheck.start_interval, "5s");
});

void test("Kafka data uses a project-scoped named volume", async () => {
  const config = composeConfig();
  const scopedConfig = composeConfig("coffee-topology-volume-scope");
  const kafkaData = config.volumes?.kafka_data;
  assert.equal(
    config.services.kafka.environment.KAFKA_LOG_DIRS,
    "/var/lib/kafka/data",
  );
  assert.deepEqual(kafkaData, { name: "coffee-platform_kafka_data" });
  assert.equal(
    scopedConfig.volumes?.kafka_data?.name,
    "coffee-topology-volume-scope_kafka_data",
  );
  assert.deepEqual(
    config.services.kafka.volumes.filter(
      ({ target }) => target === "/var/lib/kafka/data",
    ),
    [
      {
        type: "volume",
        source: "kafka_data",
        target: "/var/lib/kafka/data",
        volume: {},
      },
    ],
  );
  const source = await readFile(COMPOSE_FILE, "utf8");
  assert.doesNotMatch(source, /(^|\n)  kafka_data:\n(?:    .*\n)*    name:/);
});

void test("observability overlay keeps separate backends private and bounds exact Docker log mounts", async () => {
  const { createComposeOverride, createRuntimeLoggingOverride } =
    await import("../../tools/observability/generate.mjs");
  const { loadPlatformConfig } = await import("../../scripts/config-lib.mjs");
  const config = await loadPlatformConfig(REPO_ROOT);
  const imageRefs = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const backends = ["grafana", "loki", "prometheus", "tempo"];
  const storageVolumes = Object.fromEntries(
    backends.map((name) => [name, `coffee-topology-${name}-data`]),
  );
  const backendConfigPaths = Object.fromEntries(
    [
      ...backends.filter((name) => name !== "grafana"),
      "datasources",
      "alerts",
      "contacts",
    ].map((name) => [name, `/dev/shm/observability/${name}.yaml`]),
  );
  const id = "a".repeat(64);
  const overlay = createComposeOverride({
    config,
    imageRefs,
    logFiles: [
      {
        service: "edge-nginx",
        containerId: id,
        logPath: `/var/lib/docker/containers/${id}/${id}-json.log`,
      },
    ],
    collectorConfigPath: "/dev/shm/observability/collector.alloy",
    grafanaAdminSecretPath: "/dev/shm/observability/admin-secret",
    otelCollectorImage: `sha256:${"c".repeat(64)}`,
    grafanaImage: `sha256:${"b".repeat(64)}`,
    alertSinkImage: `sha256:${"a".repeat(64)}`,
    storageVolumes,
    backendConfigPaths,
  });
  const collector = overlay.services["otel-collector"];
  assert.equal(overlay.services.grafana.image, `sha256:${"b".repeat(64)}`);
  assert.notEqual(overlay.services.grafana.image, imageRefs.grafanaImage);
  assert.ok(
    overlay.services.grafana.volumes.some(
      ({ target }) => target === "/var/lib/grafana",
    ),
  );
  assert.ok(
    overlay.services.grafana.volumes.every(
      ({ target }) =>
        target !== "/opt/grafana/plugins" &&
        !"/opt/grafana/plugins".startsWith(`${target}/`),
    ),
  );
  assert.equal(
    overlay.services["alert-sink"].image,
    `sha256:${"a".repeat(64)}`,
  );
  assert.notEqual(overlay.services["alert-sink"].image, imageRefs.nodeImage);
  assert.equal(overlay.services.openobserve, undefined);
  assert.equal(collector.image, `sha256:${"c".repeat(64)}`);
  assert.equal(collector.user, "0:0");
  assert.ok(
    collector.command.includes("--server.http.listen-addr=127.0.0.1:13133"),
  );
  assert.match(collector.healthcheck.test.at(-1), /\/-\/ready$/u);
  assert.deepEqual(collector.networks, [
    "coffee_observability",
    "coffee_edge_backend",
    "coffee_public_api_backend",
    "coffee_internal_api",
    "coffee_kafka_event",
  ]);
  const uid = {
    grafana: "472:472",
    loki: "10001:10001",
    prometheus: "65534:65534",
    tempo: "10001:10001",
  };
  for (const name of ["otel-collector", ...backends]) {
    const service = overlay.services[name];
    assert.equal(service.ports, undefined);
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.security_opt, ["no-new-privileges:true"]);
    assert.equal(
      service.stop_grace_period,
      `${config.platform.shutdownGraceMs}ms`,
    );
    assert.ok(
      service.volumes.some(
        ({ source, target, read_only }) =>
          source === "/usr/bin/busybox" && target === "/busybox" && read_only,
      ),
    );
    assert.equal(
      service.volumes.some(({ source }) =>
        ["/", "/proc", "/sys", "/var/run/docker.sock"].includes(source),
      ),
      false,
    );
  }
  for (const name of backends) {
    const service = overlay.services[name];
    assert.equal(
      service.image,
      name === "grafana"
        ? `sha256:${"b".repeat(64)}`
        : imageRefs[`${name}Image`],
    );
    assert.equal(service.user, uid[name]);
    assert.equal(
      service.mem_limit,
      `${config.telemetry[name].memoryLimitMiB}m`,
    );
    assert.deepEqual(service.networks, ["coffee_observability"]);
    assert.deepEqual(overlay.volumes[`${name}_data`], {
      external: true,
      name: storageVolumes[name],
    });
    assert.ok(
      collector.volumes.some(
        ({ source, target, read_only }) =>
          source === `${name}_data` &&
          target === `/telemetry-storage/${name}` &&
          read_only,
      ),
    );
  }
  assert.equal(
    overlay.services.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED,
    "false",
  );
  assert.equal(
    overlay.services.grafana.environment.GF_ANALYTICS_REPORTING_ENABLED,
    "false",
  );
  assert.equal(
    overlay.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD__FILE,
    "/run/secrets/admin-secret",
  );
  assert.equal(
    overlay.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD,
    undefined,
  );
  assert.deepEqual(
    collector.volumes.filter(({ read_only }) => read_only !== true),
    [
      {
        type: "volume",
        source: "collector_checkpoints",
        target: "/var/lib/alloy",
        volume: { nocopy: true },
      },
    ],
  );
  assert.ok(
    collector.volumes.some(
      ({ source, target, read_only }) =>
        source === `/var/lib/docker/containers/${id}` &&
        target === `/var/lib/docker/containers/${id}` &&
        read_only,
    ),
  );
  assert.deepEqual(overlay.networks.coffee_observability, {
    name: "coffee_observability",
    internal: true,
  });
  const logging = createRuntimeLoggingOverride({
    config: OBSERVABILITY_CONFIG,
  });
  for (const name of ["edge-gateway", "kafka"])
    assert.deepEqual(logging.services[name].logging.options, {
      "max-size": "8m",
      "max-file": "3",
      mode: "non-blocking",
      "max-buffer-size": "4194304",
    });
});

void test("Node production image is exact, non-root, and keeps build tooling out of final stage", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  assert.ok(toolchain.nodeImage.startsWith("node:26.8.1-alpine@sha256:"));
  assert.ok(dockerfile.includes(`ARG NODE_IMAGE=${toolchain.nodeImage}`));
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS build/);
  assert.match(dockerfile, /FROM \$\{NODE_IMAGE\} AS runtime/);
  assert.match(dockerfile, /pnpm --filter .* deploy --prod/);
  const deploy = dockerfile.indexOf(
    'pnpm --filter "@coffee-platform/${RUNTIME}" deploy',
  );
  const removeInstallerState = dockerfile.indexOf(
    "rm -f /runtime/node_modules/.modules.yaml",
  );
  const nativeProbe = dockerfile.indexOf(
    "Deployed Kafka native addon is missing",
  );
  const runtimeCopy = dockerfile.indexOf("COPY --from=build /runtime");
  assert.ok(
    deploy >= 0 &&
      deploy < removeInstallerState &&
      removeInstallerState < nativeProbe &&
      nativeProbe < runtimeCopy,
  );
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /COPY --from=build \/runtime/);
  const runtimeStage = dockerfile.slice(
    dockerfile.indexOf("FROM ${NODE_IMAGE} AS runtime"),
  );
  assert.match(
    runtimeStage,
    /apk add --no-cache --upgrade ca-certificates libcrypto3 libssl3 zlib zstd-libs lz4-libs libsasl libcurl/,
  );
  assert.match(runtimeStage, /ENV LD_LIBRARY_PATH=\/usr\/local\/lib/);
  assert.match(
    runtimeStage,
    /COPY --from=librdkafka-build \/usr\/local\/lib\/librdkafka\.so\*/,
  );
  assert.doesNotMatch(runtimeStage, /gcompat|libc6-compat|glibc/u);
  assert.match(
    dockerfile,
    /COPY platform\/launch-v1-connectivity-policy\.json \.\/platform\/launch-v1-connectivity-policy\.json/,
  );
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node", "scripts\/permission-enforce\.mjs"\]/,
  );
  assert.match(dockerfile, /CMD \["--entry", "dist\/main\.js"\]/);
});

void test("otel-collector layer removes volatile dpkg state for reproducible image identity", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  const start = dockerfile.indexOf(
    "FROM ${OTEL_COLLECTOR_IMAGE} AS otel-collector",
  );
  const end = dockerfile.indexOf(
    "# G12 supplies the verified, signed vendor plugin context",
  );
  assert.ok(start >= 0 && end > start);
  const stage = dockerfile.slice(start, end);
  assert.match(stage, /RUN --network=none dpkg --purge apt libapt-pkg6\.0t64/);
  assert.match(
    stage,
    /rm -f \/var\/log\/dpkg\.log \/var\/log\/alternatives\.log \/var\/log\/apt\/history\.log \/var\/log\/apt\/term\.log/,
  );
  assert.match(stage, /rm -rf \/var\/cache\/ldconfig/);
});

void test("Confluent Node 26 addon links dynamically to separately pinned librdkafka", async () => {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /AS librdkafka-build/);
  assert.match(dockerfile, /LIBRDKAFKA_VERSION=2\.15\.0/);
  assert.match(
    dockerfile,
    /LIBRDKAFKA_SOURCE_SHA256=259015220cdca708afe838b5aa79ebf1a5fb710fb4179cf918d390aed85d5dbc/,
  );
  assert.match(dockerfile, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /CKJS_LINKING=dynamic BUILD_LIBRDKAFKA=0/);
  assert.match(dockerfile, /ldd .*confluent-kafka-javascript\.node/);
  assert.doesNotMatch(dockerfile, /\/ckjs|librdkafka-static\.a/);
});

void test("recovery proof preserves the body error when orders-aroma-preparation restore also fails", async () => {
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(`        runCompose(
          projectName,
          secretsDir,
          ["stop", "orders-aroma-preparation"],`);
  const end = source.indexOf("\n      }\n    }\n    if (!options.keep)", start);
  assert.ok(start >= 0 && end > start);
  const recoveryBlock = source.slice(start, end);
  const bodyError = new Error("BODY_SECRET_CANARY");
  const restoreError = new Error("RESTORE_SECRET_CANARY");
  const readinessError = new Error("READINESS_SECRET_CANARY");
  const run = ({
    bodyFails = false,
    restoreFails = false,
    readinessFails = false,
  } = {}) => {
    const calls = [];
    const promise = runInNewContext(
      `(async()=>{${recoveryBlock};return nativeFoundation;})()`,
      {
        AggregateError,
        assert,
        bodyError,
        restoreError,
        readinessError,
        proofLaunchIdentity: undefined,
        projectName: "synthetic-project",
        secretsDir: "synthetic-secrets",
        composeFile: "synthetic-compose",
        recoveryDatabaseProof: { port: 5432 },
        recoveryProofCredentials: {},
        platformConfig: {},
        recoveryPlatformConfig: {},
        databaseProofService: () => ({ database: "synthetic-db" }),
        nativeFoundation: undefined,
        prepareKafkaNativeFixture: async () => {
          if (bodyFails) throw bodyError;
          return {
            mappingTopic: "synthetic-topic",
            kafkaTargets: { orders: {}, preparation: {} },
          };
        },
        nativeFoundationSource: () => "synthetic-source",
        runCompose: (_project, _secrets, args) => {
          calls.push(args[0] === "up" ? "restore-up" : args[0]);
          if (args[0] === "up" && restoreFails) throw restoreError;
          if (args[0] === "exec")
            return JSON.stringify({
              sigterm: {
                received: true,
                gateEntered: true,
                activeAtSignal: { total: 1 },
                ownerCount: 1,
                closedMetrics: {
                  consumer: { assigned: 0, active: 0, pending: 0 },
                },
              },
            });
          return "";
        },
        assertOrdersOutboxBrokerRecovery: async () => ({ recovered: true }),
        runKafkaBlackholeProof: async () => ({ recovered: true }),
        waitForRuntimeReadiness: async () => {
          calls.push("readiness");
          if (readinessFails) throw readinessError;
        },
      },
    );
    return { calls, promise };
  };

  const bodyOnly = run({ bodyFails: true });
  await assert.rejects(bodyOnly.promise, (error) => error === bodyError);
  assert.deepEqual(bodyOnly.calls, ["stop", "restore-up", "readiness"]);
  await assert.rejects(
    run({ restoreFails: true }).promise,
    (error) => error === restoreError,
  );
  await assert.rejects(
    run({ readinessFails: true }).promise,
    (error) => error === readinessError,
  );
  await assert.rejects(
    run({ bodyFails: true, restoreFails: true }).promise,
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual([...error.errors], [bodyError, restoreError]);
      assert.equal(error.cause, bodyError);
      assert.equal(
        error.message,
        "Recovery proof and orders-aroma-preparation restoration both failed",
      );
      assert.doesNotMatch(
        error.message,
        /BODY_SECRET_CANARY|RESTORE_SECRET_CANARY/u,
      );
      return true;
    },
  );
  const success = run();
  await success.promise;
  assert.deepEqual(success.calls, ["stop", "exec", "restore-up", "readiness"]);
});

void test("Orders recovery reads a complete bounded snapshot from every configured Kafka partition", () => {
  const source = readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  return source.then((text) => {
    const start = text.indexOf("function readOrdersBrokerMessages(");
    const end = text.indexOf(
      "\nasync function assertOrdersOutboxBrokerRecovery",
      start,
    );
    assert.ok(start >= 0 && end > start);
    const readerSource = text.slice(start, end);
    const topic = { name: "coffee.orders.lifecycle.v1", partitions: 2 };
    const commandError = new Error("synthetic Kafka command failure");
    const makeReader = ({ offsets, records = {}, failCommand = false }) => {
      const commands = [];
      const reader = runInNewContext(`(${readerSource})`, {
        assert,
        runCompose: (_project, _secrets, args) => {
          const script = args.at(-1);
          commands.push(script);
          if (script.includes("kafka-get-offsets.sh")) return offsets;
          if (failCommand) throw commandError;
          const partition = Number(script.match(/--partition (\d+)/u)?.[1]);
          return records[partition] ?? "";
        },
      });
      return {
        commands,
        reader: () =>
          reader(
            "synthetic-project",
            "synthetic-secrets",
            "synthetic-compose",
            topic,
          ),
      };
    };

    const complete = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:2\n`,
      records: { 1: '{"messageId":"one"}\n{"messageId":"two"}\n' },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(complete.reader())), [
      { messageId: "one" },
      { messageId: "two" },
    ]);
    assert.equal(
      complete.commands.length,
      2,
      "empty partitions need no consumer process",
    );
    assert.match(
      complete.commands[1],
      /--partition 1 --offset 0 --max-messages 2 --timeout-ms 5000/u,
    );
    assert.doesNotMatch(
      complete.commands.join(" "),
      /--group|2>\/dev\/null|\|\| true/u,
    );

    const empty = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:0\n`,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(empty.reader())), []);
    assert.equal(empty.commands.length, 1);

    for (const offsets of [
      `${topic.name}:0:1\n`,
      `${topic.name}:0:1\n${topic.name}:0:1\n${topic.name}:1:0\n`,
      `${topic.name}:0:-1\n${topic.name}:1:0\n`,
      `${topic.name}:0:\n${topic.name}:1:0\n`,
      `${topic.name}:0:0x1\n${topic.name}:1:0\n`,
      `${topic.name}:0:101\n${topic.name}:1:0\n`,
    ]) {
      const invalid = makeReader({ offsets });
      assert.throws(invalid.reader, /offset snapshot/u);
      assert.equal(
        invalid.commands.length,
        1,
        "invalid snapshots must fail before reading records",
      );
    }

    const incomplete = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:2\n`,
      records: { 1: '{"messageId":"one"}\n' },
    });
    assert.throws(
      incomplete.reader,
      /expected 2 records in partition 1, received 1/u,
    );

    const failed = makeReader({
      offsets: `${topic.name}:0:0\n${topic.name}:1:1\n`,
      failCommand: true,
    });
    assert.throws(failed.reader, (error) => error === commandError);
  });
});

void test("verified infrastructure image loader accepts only context-bound Kafka artifacts", async (t) => {
  const { loadVerifiedGateImage } =
    await import("../../tools/verified-infrastructure-image.mjs");
  const { RUNTIME_NAMES } =
    await import("../../packages/platform-config/src/index.ts");
  const root = await mkdtemp("/tmp/coffee-kafka-artifact-proof-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = join(root, "candidate");
  const evidenceDir = join(root, "evidence");
  const supplyChainDir = join(
    evidenceDir,
    "gates/G12_SUPPLY_CHAIN/artifacts/supply-chain",
  );
  await mkdir(join(candidateRoot, "config"), { recursive: true, mode: 0o700 });
  await mkdir(join(candidateRoot, "evidence/security"), { recursive: true });
  await writeFile(
    join(candidateRoot, "evidence/security/cve-2026-78661.json"),
    await readFile(
      new URL("../../evidence/security/cve-2026-78661.json", import.meta.url),
    ),
  );
  await mkdir(join(supplyChainDir, "artifacts"), {
    recursive: true,
    mode: 0o700,
  });
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const runId = "20261029T120000Z-abcdef0";
  const candidateSha = `abcdef0${"1".repeat(33)}`;
  const imageId = `sha256:${"2".repeat(64)}`;
  const manifestDigest = `sha256:${"3".repeat(64)}`;
  const platformManifestDigest = `sha256:${"4".repeat(64)}`;
  const platformBytes = Buffer.from(
    JSON.stringify({
      verification: {
        securityScan: {
          enabled: true,
          cpu: 2,
          memoryMiB: 2048,
          parallel: 1,
          minimumFreeDiskGiB: 20,
          maximumDatabaseAgeHours: 24,
          approvedFixed: [],
          egressRepositories: [
            "ghcr.io/aquasecurity/trivy-db",
            "mirror.gcr.io/aquasec/trivy-java-db",
          ],
        },
      },
    }),
  );
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: platformManifestDigest,
        size: 123,
        platform: { os: "linux", architecture: "amd64" },
      },
    ],
  };
  const indexBytes = Buffer.from(JSON.stringify(index));
  const grafanaImage = `grafana:fixture@sha256:${hash(indexBytes)}`;
  const pins = Object.fromEntries(
    ["loki", "tempo", "prometheus"].map((name) => [
      name,
      {
        version: "1.0.0",
        zipSha256: hash(`${name}-zip`),
        manifestSha256: hash(`${name}-manifest`),
        binarySha256: hash(`${name}-binary`),
      },
    ]),
  );
  const toolchain = {
    kafkaImage: `apache/kafka:4.3.2@sha256:${hash(indexBytes)}`,
    grafanaImage,
    grafanaPlugins: pins,
    grafanaSigningKeySourceSha256: hash("key"),
    grafanaSigningKeyFingerprint: "A".repeat(40),
    grafanaTempoModule: {
      version: "fixture",
      h1: "fixture",
      revision: "a".repeat(40),
      fixCommits: ["b".repeat(40), "c".repeat(40)],
      replacement: null,
    },
  };
  const toolchainBytes = Buffer.from(JSON.stringify(toolchain));
  const lockfileBytes = Buffer.from("lock fixture");
  const context = {
    schemaVersion: 1,
    runId,
    candidateSha,
    baseConfigSha256: hash(platformBytes),
  };
  const environment = {
    runId,
    candidateSha,
    candidatePath: candidateRoot,
    dirty: false,
    configSha256: context.baseConfigSha256,
    treeSha: "5".repeat(40),
    toolchainVersionsSha256: hash(toolchainBytes),
    lockfileSha256: hash(lockfileBytes),
  };
  for (const [path, bytes] of [
    [join(candidateRoot, "config/platform.yaml"), platformBytes],
    [join(candidateRoot, "config/toolchain-versions.json"), toolchainBytes],
    [join(candidateRoot, "pnpm-lock.yaml"), lockfileBytes],
  ]) {
    await writeFile(path, bytes, { mode: 0o644 });
    await chmod(path, 0o644);
  }
  await writeFile(
    join(evidenceDir, "environment.json"),
    JSON.stringify(environment),
    { mode: 0o600 },
  );
  const ociArtifact = Buffer.from("mock OCI artifact bytes");
  const baseMaterial = {
    sourceRef: `apache/kafka:4.3.2@sha256:${hash(indexBytes)}`,
    platformManifestDigest,
    indexArtifact: {
      path: "artifacts/kafka-base-index.json",
      sha256: hash(indexBytes),
      sizeBytes: indexBytes.length,
    },
  };
  const receipt = {
    schemaVersion: 1,
    gate: "G12_SUPPLY_CHAIN",
    status: "PASS",
    runId,
    candidateSha,
    treeSha: environment.treeSha,
    configSha256: context.baseConfigSha256,
    toolchainVersionsSha256: environment.toolchainVersionsSha256,
    lockfileSha256: environment.lockfileSha256,
    target: "kafka",
    importTag: `coffee-g12-${hash(Buffer.from(runId)).slice(0, 12)}-kafka:latest`,
    baseImage: baseMaterial.sourceRef,
    imageId,
    manifestDigest,
    platformManifestDigest,
    provenanceStatus: "INCOMPLETE_LOCAL_CONTEXT",
    provenanceSha256: "6".repeat(64),
    attestationSha256: "7".repeat(64),
    buildInputBinding: {
      status: "OBSERVED",
      sourceCommit: candidateSha,
      sourceTreeSha: environment.treeSha,
      archiveSha256: "8".repeat(64),
      archiveSizeBytes: 123,
      extractedTreeSha256: "9".repeat(64),
      extractedBytes: 123,
      sourceKind: "git-archive-local-context",
      buildkitMaterialsCompleteness: "INCOMPLETE_LOCAL_CONTEXT",
      invocation: {
        entryPoint: "docker buildx build",
        builder: "coffee-platform-mtu",
        target: "kafka",
        platform: "linux/amd64",
        provenance: "mode=min",
        output: "oci-layout-directory",
      },
    },
    ociArtifact: {
      path: "artifacts/kafka.oci.tar",
      sha256: hash(ociArtifact),
      sizeBytes: ociArtifact.length,
      layoutTreeSha256: "a".repeat(64),
      layoutBytes: 123,
    },
    baseMaterial,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const result = {
    gate: "G12_SUPPLY_CHAIN",
    status: "PASS",
    code: "G12_SCAN_CLEAN",
    runId,
    candidateSha,
    kafka: {
      path: "artifacts/kafka-receipt.json",
      receiptSha256: hash(receiptBytes),
      imageId,
      importTag: receipt.importTag,
      manifestDigest,
      ociArtifactPath: "artifacts/kafka.oci.tar",
      ociArtifactSha256: hash(ociArtifact),
    },
    provenance: {
      status: "PASS",
      sourceRevision: candidateSha,
      treeSha: environment.treeSha,
      configSha256: context.baseConfigSha256,
      toolchainVersionsSha256: environment.toolchainVersionsSha256,
      lockfileSha256: environment.lockfileSha256,
      images: [
        {
          service: "kafka",
          imageId,
          manifestDigest,
          platformManifestDigest,
          provenanceStatus: "PASS",
          metadataSha256: receipt.provenanceSha256,
          attestationSha256: receipt.attestationSha256,
          baseMaterial,
        },
      ],
    },
  };
  const grafanaId = `sha256:${hash("grafana-image")}`;
  const grafanaBase = {
    sourceRef: grafanaImage,
    platformManifestDigest,
    indexArtifact: {
      path: "artifacts/grafana-base-index.json",
      sha256: hash(indexBytes),
      sizeBytes: indexBytes.length,
    },
  };
  const vendorPlugins = {
    treeSha256: hash("plugins"),
    treeBytes: 1,
    signingKeySourceSha256: toolchain.grafanaSigningKeySourceSha256,
    signingKeyFingerprint: toolchain.grafanaSigningKeyFingerprint,
    plugins: pins,
    effectiveFiles: Object.fromEntries(
      Object.keys(pins).map((name) => [
        name,
        {
          path: `/opt/grafana/plugins/${name}/gpx_grafana-${name}-datasource_linux_amd64`,
          sha256: pins[name].binarySha256,
          sizeBytes: 1,
          layerDigest: platformManifestDigest,
        },
      ]),
    ),
  };
  const grafanaReceipt = {
    ...receipt,
    target: "grafana",
    importTag: `coffee-g12-${hash(Buffer.from(runId)).slice(0, 12)}-grafana:latest`,
    baseImage: grafanaImage,
    imageId: grafanaId,
    baseMaterial: grafanaBase,
    buildInputBinding: {
      ...receipt.buildInputBinding,
      sourceKind: "git-archive-plus-verified-plugins",
      invocation: {
        ...receipt.buildInputBinding.invocation,
        target: "grafana",
      },
      vendorPlugins,
    },
    ociArtifact: { ...receipt.ociArtifact, path: "artifacts/grafana.oci.tar" },
  };
  const grafanaReceiptBytes = Buffer.from(JSON.stringify(grafanaReceipt));
  result.grafana = {
    path: "artifacts/grafana-receipt.json",
    receiptSha256: hash(grafanaReceiptBytes),
    imageId: grafanaId,
    importTag: grafanaReceipt.importTag,
    manifestDigest,
    ociArtifactPath: grafanaReceipt.ociArtifact.path,
    ociArtifactSha256: grafanaReceipt.ociArtifact.sha256,
  };
  result.provenance.images.push({
    service: "grafana",
    imageId: grafanaId,
    manifestDigest,
    platformManifestDigest,
    provenanceStatus: "PASS",
    metadataSha256: grafanaReceipt.provenanceSha256,
    attestationSha256: grafanaReceipt.attestationSha256,
    baseMaterial: grafanaBase,
  });
  const services = [
    ...RUNTIME_NAMES,
    "grafana",
    "keycloak",
    "storage-helper",
    "edge-nginx",
    "kafka",
    "otel-collector",
    "loki",
    "prometheus",
    "tempo",
    "lockfile",
  ];
  result.reports = [];
  for (const service of services) {
    const existing = result.provenance.images.find(
      (entry) => entry.service === service,
    );
    const scannedImageId = existing?.imageId ?? `sha256:${hash(service)}`;
    if (!existing && service !== "lockfile") {
      const upstream = [
        "otel-collector",
        "loki",
        "prometheus",
        "tempo",
      ].includes(service);
      result.provenance.images.push(
        upstream
          ? {
              service,
              imageId: scannedImageId,
              manifestDigest,
              sourceReference: `${service}:fixture@${manifestDigest}`,
              identityStatus: "PINNED_DIGEST_VERIFIED",
            }
          : {
              service,
              imageId: scannedImageId,
              manifestDigest,
              platformManifestDigest,
              provenanceStatus: "PASS",
              metadataSha256: hash(`${service}-metadata`),
              attestationSha256: hash(`${service}-attestation`),
            },
      );
    }
    for (const suffix of ["sbom.cdx.json", "vulnerabilities.json"]) {
      const name = `${service}.${suffix}`;
      const contents = Buffer.from(
        JSON.stringify(
          suffix === "vulnerabilities.json"
            ? {
                Results: [],
                Metadata:
                  service === "lockfile" ? {} : { ImageID: scannedImageId },
              }
            : {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                components: [],
              },
        ),
      );
      await writeFile(join(supplyChainDir, "artifacts", name), contents, {
        mode: 0o600,
      });
      result.reports.push({
        path: name,
        sha256: hash(contents),
        findings: { high: 0, critical: 0 },
      });
    }
  }
  result.findings = { high: 0, critical: 0 };
  result.evaluation = {
    rawHigh: 0,
    resolvedFixed: 0,
    resolvedNotAffected: 0,
    unresolvedHigh: 0,
    critical: 0,
  };
  const decision = {
    schemaVersion: 1,
    gate: "G12_SUPPLY_CHAIN",
    runId,
    candidateSha,
    treeSha: environment.treeSha,
    configSha256: context.baseConfigSha256,
    toolchainVersionsSha256: environment.toolchainVersionsSha256,
    lockfileSha256: environment.lockfileSha256,
    imageId: grafanaId,
    manifestDigest,
    platformManifestDigest,
    rawReportSha256: result.reports.find(
      (entry) => entry.path === "grafana.vulnerabilities.json",
    ).sha256,
    approvedFixed: [],
    vendorPlugins,
    module: toolchain.grafanaTempoModule,
    decisions: [],
    notAffected: [],
    proofSha256:
      "bfdd89d4fef959e52f8e898be3b24b97a7e37298317f6850d7952d85e7215d50",
    evaluatedAt: "2026-10-30T00:00:00.000Z",
    openVex: null,
  };
  const decisionBytes = Buffer.from(JSON.stringify(decision));
  result.adjudication = {
    path: "artifacts/grafana-adjudication.json",
    sha256: hash(decisionBytes),
  };
  await writeFile(
    join(supplyChainDir, "artifacts/grafana-receipt.json"),
    grafanaReceiptBytes,
    { mode: 0o600 },
  );
  await writeFile(
    join(supplyChainDir, "artifacts/grafana-adjudication.json"),
    decisionBytes,
    { mode: 0o600 },
  );
  for (const [path, bytes] of [
    [join(supplyChainDir, "result.json"), Buffer.from(JSON.stringify(result))],
    [join(supplyChainDir, "artifacts/kafka-receipt.json"), receiptBytes],
    [join(supplyChainDir, "artifacts/kafka.oci.tar"), ociArtifact],
    [join(supplyChainDir, "artifacts/kafka-base-index.json"), indexBytes],
  ])
    await writeFile(path, bytes, { mode: 0o600 });
  const validated = await loadVerifiedGateImage({
    target: "kafka",
    contextFile: join(evidenceDir, "context.json"),
    loadImage: false,
    validateContext: async () => ({ context, candidateRoot, evidenceDir }),
  });
  assert.deepEqual(validated, {
    imageId,
    manifestDigest,
    receiptSha256: hash(receiptBytes),
    ociArtifactSha256: hash(ociArtifact),
    baseImage: receipt.baseImage,
    candidateSha,
    runId,
    importTag: receipt.importTag,
    imported: false,
  });
  await assert.rejects(loadVerifiedGateImage({ target: "openobserve" }), {
    message: "G12_KAFKA_TARGET_INVALID",
  });
});

void test("G15 browser CLI mode is isolated and requires its integrated hook", async () => {
  const { runComposeSmoke } = await import("../../tools/compose-smoke.mjs");
  for (const args of [
    ["--browser-proof", "--stub-secrets"],
    ["--browser-proof", "--no-build"],
    ["--browser-proof", "--keep"],
    ["--browser-proof", "--database-proof"],
    ["--browser-proof", "--customer-proof"],
    ["--browser-proof", "--recovery-proof"],
    ["--browser-proof", "--mutation-disable-rollback"],
    ["--browser-proof", "--aroma-binding-proof"],
    ["--browser-proof", "--aroma-cart-proof"],
    ["--browser-proof", "--provision-empty-postgres-network"],
    ["--browser-proof", "--project-name", "coffee-fixture"],
  ])
    await assert.rejects(
      runComposeSmoke({ args }),
      /--browser-proof must be the only option/u,
    );
  await assert.rejects(
    runComposeSmoke({ args: ["--browser-proof"] }),
    /requires the integrated browser hook/u,
  );
});

void test("G15 Compose service rows retain the full container ID", async () => {
  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function parseComposePs(");
  const end = source.indexOf("\nfunction assertHealthy(", start);
  assert.ok(start >= 0 && end > start);
  const fullId = "a".repeat(64);
  let observed;
  const { serviceRows } = runInNewContext(
    `(()=>{${source.slice(start, end)}; return {serviceRows};})()`,
    {
      COMPOSE_FILE: "compose.yaml",
      runCompose(projectName, secretsDir, args, options) {
        observed = {
          projectName,
          secretsDir,
          args: Array.from(args),
          composeFile: options.composeFile,
        };
        return JSON.stringify({ ID: fullId, Service: "edge-nginx" });
      },
    },
  );

  const rows = serviceRows("coffee-g15-proof", "/dev/shm/secrets");
  assert.deepEqual(observed, {
    projectName: "coffee-g15-proof",
    secretsDir: "/dev/shm/secrets",
    args: ["ps", "--all", "--no-trunc", "--format", "json"],
    composeFile: "compose.yaml",
  });
  assert.equal(rows.find((row) => row.Service === "edge-nginx")?.ID, fullId);
});

void test("G18 Compose failure diagnostics preserve the original error and expose only finite process facts", async () => {
  const { ROLLBACK_COMPOSE_OPERATIONS, withRollbackComposeDiagnostic } =
    await import("../../tools/compose-smoke.mjs");
  const { createRollbackFailureReceipt, validateRollbackFailureArtifact } =
    await import("../../verification/launch/v1/scenarios/rollback.mjs");
  const { persistRollbackFailureFromChild } =
    await import("../../verification/launch/v1/scenarios/rollback.mjs");
  assert.deepEqual(ROLLBACK_COMPOSE_OPERATIONS, [
    "kafka-up",
    "kafka-offset-bootstrap",
    "runtime-stack-up",
  ]);
  const sensitiveCanary = "RAW_STDERR_SECRET_CANARY docker command line";
  for (const operation of ROLLBACK_COMPOSE_OPERATIONS) {
    const sourceError = Object.assign(new Error(sensitiveCanary), {
      status: 23,
      signal: null,
      stdout: Buffer.from(sensitiveCanary),
      stderr: Buffer.from(sensitiveCanary),
    });
    let diagnostic;
    assert.throws(
      () =>
        withRollbackComposeDiagnostic(
          operation,
          () => {
            throw sourceError;
          },
          (value) => {
            diagnostic = value;
          },
        ),
      (error) => error === sourceError,
      "diagnostic wrapper must preserve the original phase error",
    );
    assert.deepEqual(diagnostic, {
      operation,
      exitCode: 23,
      signal: null,
      timedOut: false,
      failureClass: "nonzero-exit",
    });
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /RAW_STDERR_SECRET_CANARY|docker command line/u,
    );
  }
  for (const [properties, expected] of [
    [
      { code: "ETIMEDOUT", signal: "SIGTERM", killed: true },
      {
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        failureClass: "timeout",
      },
    ],
    [
      { signal: "SIGKILL", killed: true },
      {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: false,
        failureClass: "signal",
      },
    ],
    [
      { code: "ENOENT" },
      {
        exitCode: null,
        signal: null,
        timedOut: false,
        failureClass: "spawn-error",
      },
    ],
  ]) {
    let diagnostic;
    const sourceError = Object.assign(new Error(sensitiveCanary), properties);
    assert.throws(
      () =>
        withRollbackComposeDiagnostic(
          "kafka-up",
          () => {
            throw sourceError;
          },
          (value) => {
            diagnostic = value;
          },
        ),
      (error) => error === sourceError,
    );
    assert.deepEqual(diagnostic, { operation: "kafka-up", ...expected });
  }
  let failureCallbackCalled = false;
  assert.equal(
    withRollbackComposeDiagnostic(
      "runtime-stack-up",
      () => "ok",
      () => {
        failureCallbackCalled = true;
      },
    ),
    "ok",
  );
  assert.equal(failureCallbackCalled, false);
  assert.throws(
    () =>
      withRollbackComposeDiagnostic(
        "untrusted-command",
        () => {},
        () => {},
      ),
    /G18 Compose operation is not allowlisted/u,
  );

  const source = await readFile(
    new URL("../../tools/compose-smoke.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function prepareRecoveryKafkaBootstrap(");
  const end =
    source.indexOf("\n}\n\nfunction prepareKafkaNamespaceRegistry(", start) + 2;
  assert.ok(start >= 0 && end > start);
  const bootstrap = runInNewContext(`(${source.slice(start, end)})`, {
    runCompose() {
      assert.fail("bootstrap bypassed the tracked Compose operation");
    },
    buildKafkaRegistryBootstrapScript(config, _identity, client) {
      return Object.values(config.kafka.topics).flatMap(
        ({ name, dlq, partitions }) =>
          [name, dlq].map(
            (topic) =>
              `/opt/kafka/bin/kafka-topics.sh ${client} --create --if-not-exists --topic ${JSON.stringify(topic)} --partitions ${partitions} --replication-factor 1 >/dev/null`,
          ),
      );
    },
  });
  const operations = [];
  const topicConfigs = Object.fromEntries(
    [
      "coffee.catalog.snapshot.v1",
      "coffee.catalog.mapping.v2",
      "coffee.orders.lifecycle.v1",
      "coffee.aroma.cart.commands.v1",
      "coffee.aroma.cart.events.v1",
      "coffee.realtime.invalidate.v1",
    ].map((name, index) => [
      `topic-${index}`,
      { name, dlq: `${name}.dlq`, partitions: 1 },
    ]),
  );
  let bootstrapScript = "";
  bootstrap(
    "fixture-project",
    "/fixture-secrets",
    { kafka: { topics: topicConfigs }, services: {} },
    "/fixture-compose",
    (operation, project, secrets, args) => {
      operations.push(operation);
      assert.equal(project, "fixture-project");
      assert.equal(secrets, "/fixture-secrets");
      assert.equal(args[0], operation === "kafka-up" ? "up" : "exec");
      if (operation === "kafka-offset-bootstrap") bootstrapScript = args.at(-1);
    },
  );
  assert.deepEqual(operations, ["kafka-up", "kafka-offset-bootstrap"]);
  assert.equal(
    (bootstrapScript.match(/--create --if-not-exists --topic/g) ?? []).length,
    12,
  );
  for (const { name, dlq } of Object.values(topicConfigs)) {
    assert.ok(bootstrapScript.includes(`--topic ${JSON.stringify(name)}`));
    assert.ok(bootstrapScript.includes(`--topic ${JSON.stringify(dlq)}`));
  }

  const directory = await mkdtemp(
    join(tmpdir(), "g18-safe-failure-diagnostic-"),
  );
  try {
    const candidateSha = "1".repeat(40);
    const runId = `20261024T120000Z-${candidateSha.slice(0, 7)}`;
    const original = Object.assign(new Error(sensitiveCanary), { status: 17 });
    let operationDiagnostic;
    assert.throws(
      () =>
        withRollbackComposeDiagnostic(
          "kafka-offset-bootstrap",
          () => {
            throw original;
          },
          (value) => {
            operationDiagnostic = value;
          },
        ),
      (error) => error === original,
    );
    const cleanup = {
      verified: true,
      complete: true,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
    };
    const composeSourceUrl = pathToFileURL(
      join(REPO_ROOT, "tools/compose-smoke.mjs"),
    ).href;
    original.stack = [
      `Error: ${sensitiveCanary}`,
      "    at ignored (/tmp/compose-smoke.mjs:7:9)",
      `    at run (${composeSourceUrl}:4321:17)`,
      `    at later (${composeSourceUrl}:7654:21)`,
    ].join("\n");
    const receipt = {
      ...createRollbackFailureReceipt({
        runId,
        candidateSha,
        stage: "up",
        error: original,
        cleanup,
      }),
      operationDiagnostic,
    };
    assert.deepEqual(receipt.sourceLocation, {
      source: "tools/compose-smoke.mjs",
      line: 4321,
      column: 17,
    });
    assert.equal(
      receipt.messageSha256,
      createHash("sha256").update(original.message).digest("hex"),
    );
    assert.equal(
      validateRollbackFailureArtifact(
        { ...receipt, lineage: {} },
        { runId, candidateSha, lineage: {} },
      ),
      true,
    );
    for (const sourceLocation of [
      {
        ...receipt.sourceLocation,
        source: `${REPO_ROOT}/tools/compose-smoke.mjs`,
      },
      { ...receipt.sourceLocation, column: 0 },
      { ...receipt.sourceLocation, line: 1_000_001 },
      { ...receipt.sourceLocation, privatePath: REPO_ROOT },
    ]) {
      assert.throws(
        () =>
          validateRollbackFailureArtifact(
            { ...receipt, lineage: {}, sourceLocation },
            { runId, candidateSha, lineage: {} },
          ),
        /ROLLBACK_FAILURE_ARTIFACT_INVALID/u,
      );
    }
    for (const stack of [
      `Error: ${sensitiveCanary}\n    at run (${pathToFileURL("/tmp/compose-smoke.mjs").href}:8:2)`,
      `Error: ${sensitiveCanary}\n    at run (${composeSourceUrl}.evil:8:2)`,
      `Error: ${sensitiveCanary}\n    at run (${composeSourceUrl}:0:2)`,
    ]) {
      const noLocation = createRollbackFailureReceipt({
        runId,
        candidateSha,
        stage: "up",
        error: Object.assign(new Error(sensitiveCanary), { stack }),
        cleanup,
      });
      assert.equal(Object.hasOwn(noLocation, "sourceLocation"), false);
    }
    const childError = new Error("child exited");
    childError.result = {
      stdout: `${JSON.stringify(receipt)}\n`,
      joined: true,
    };
    const persisted = await persistRollbackFailureFromChild({
      error: childError,
      identity: { runId, candidateSha },
      lineage: {},
      evidenceDir: directory,
    });
    assert.deepEqual(
      persisted.artifact.operationDiagnostic,
      operationDiagnostic,
    );
    const artifactBytes = await readFile(persisted.receipt.path, "utf8");
    assert.doesNotMatch(
      artifactBytes,
      /RAW_STDERR_SECRET_CANARY|docker command line|file:\/\//u,
    );
    assert.match(
      artifactBytes,
      /"sourceLocation": \{\n\s+"source": "tools\/compose-smoke\.mjs",\n\s+"line": 4321,\n\s+"column": 17/u,
    );
    assert.match(artifactBytes, /"operation": "kafka-offset-bootstrap"/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G18 runtime-stack failure snapshots only bounded project container state before cleanup", async () => {
  const {
    attachRollbackContainerSnapshot,
    captureRollbackContainerSnapshot,
    sanitizeRollbackContainerSnapshot,
    withRollbackComposeDiagnostic,
  } = await import("../../tools/compose-smoke.mjs");
  const { createRollbackFailureReceipt, persistRollbackFailureFromChild } =
    await import("../../verification/launch/v1/scenarios/rollback.mjs");
  const projectName = "coffee-launch-fixture";
  const postgresName = `${projectName}-postgres-proof`;
  const canary = "RAW_CONTAINER_ENV_SECRET_CANARY";
  const rows = [
    {
      Id: "container-id-must-not-persist",
      Name: "/orders-service-1",
      Config: {
        Env: [`SECRET=${canary}`],
        Cmd: [canary],
        Labels: {
          "com.docker.compose.project": projectName,
          "com.docker.compose.service": "orders-service",
        },
      },
      State: {
        Status: "exited",
        Health: { Status: "unhealthy" },
        ExitCode: 1,
        OOMKilled: true,
        Error: canary,
        StartedAt: "2026-10-24T13:13:16.123456789Z",
        FinishedAt: "2026-10-24T13:14:17Z",
      },
    },
    {
      Id: canary,
      Name: "/foreign-container",
      Config: {
        Env: [canary],
        Labels: {
          "com.docker.compose.project": "foreign-project",
          "com.docker.compose.service": "foreign-service-name",
        },
      },
      State: { Status: "exited", Error: canary },
    },
    {
      Id: canary,
      Name: "/unknown-service-name",
      Config: {
        Labels: {
          "com.docker.compose.project": projectName,
          "com.docker.compose.service": "unrecognized-service-name",
        },
      },
      State: {
        Status: canary,
        Health: { Status: canary },
        ExitCode: 999,
        OOMKilled: canary,
        StartedAt: canary,
        FinishedAt: canary,
        Error: canary,
      },
    },
    {
      Id: "postgres-container-id",
      Name: `/${postgresName}`,
      Config: { Env: [canary], Labels: {} },
      State: {
        Status: "running",
        Health: { Status: "healthy" },
        ExitCode: 0,
        OOMKilled: false,
      },
    },
    {
      Id: canary,
      Name: `/${postgresName}-foreign`,
      Config: { Labels: { "com.docker.compose.project": "foreign-project" } },
      State: { Status: "running" },
    },
  ];
  const snapshot = sanitizeRollbackContainerSnapshot(
    projectName,
    rows,
    postgresName,
  );
  assert.deepEqual(snapshot, {
    status: "captured",
    containers: [
      {
        service: "orders-service",
        state: "exited",
        health: "unhealthy",
        exitCode: 1,
        oomKilled: true,
        startedAt: "2026-10-24T13:13:16.123456789Z",
        finishedAt: "2026-10-24T13:14:17Z",
      },
      {
        service: "postgres-proof",
        state: "running",
        health: "healthy",
        exitCode: 0,
        oomKilled: false,
        startedAt: null,
        finishedAt: null,
      },
      {
        service: "unknown",
        state: "unknown",
        health: null,
        exitCode: null,
        oomKilled: false,
        startedAt: null,
        finishedAt: null,
      },
    ],
  });
  assert.ok(snapshot.containers.length <= 32);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /RAW_CONTAINER_ENV_SECRET_CANARY|foreign-project|foreign-service-name|container-id|unknown-service-name/u,
  );
  const overflow = sanitizeRollbackContainerSnapshot(
    projectName,
    Array.from({ length: 33 }, (_, index) => ({
      Config: {
        Labels: {
          "com.docker.compose.project": projectName,
          "com.docker.compose.service": "invalid-service",
        },
      },
      Name: `/invalid-${index}`,
      State: { Status: "created" },
    })),
  );
  assert.deepEqual(overflow, { status: "limit-exceeded", containers: [] });

  const inspectFields = [
    "/orders-service-1",
    projectName,
    "orders-service",
    "exited",
    "unhealthy",
    1,
    true,
    "2026-10-24T13:13:16Z",
    "2026-10-24T13:14:17Z",
  ];
  const callOptions = [];
  const captured = captureRollbackContainerSnapshot(
    projectName,
    undefined,
    (args, options) => {
      callOptions.push(options);
      if (args[0] === "ps") return `${"a".repeat(64)}\n`;
      assert.deepEqual(args.slice(0, 2), ["inspect", "--format"]);
      const format = args[2];
      assert.match(format, /com\.docker\.compose\.project/u);
      assert.match(format, /com\.docker\.compose\.service/u);
      assert.doesNotMatch(format, /Env|Error|Health\.Log|\.Id/u);
      return `${inspectFields.map((value) => JSON.stringify(value)).join("\t")}\n`;
    },
  );
  assert.deepEqual(
    captured.containers.map((row) => row.service),
    ["orders-service"],
  );
  assert.ok(callOptions.length <= 2);
  for (const options of callOptions) {
    assert.ok(options.timeout > 0 && options.timeout <= 10_000);
    assert.equal(options.maxBuffer, 64 * 1024);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  }

  const timeoutCalls = [];
  const clockValues = [0, 0, 7_000];
  const timedOutSnapshot = captureRollbackContainerSnapshot(
    projectName,
    undefined,
    (args, options) => {
      timeoutCalls.push({ args, options });
      if (args[0] === "ps") return `${"b".repeat(64)}\n`;
      throw Object.assign(new Error(canary), { code: "ETIMEDOUT" });
    },
    () => clockValues.shift() ?? 7_000,
  );
  assert.deepEqual(timedOutSnapshot, { status: "unavailable", containers: [] });
  assert.deepEqual(
    timeoutCalls.map((call) => call.options.timeout),
    [10_000, 3_000],
  );
  assert.ok(timeoutCalls.every((call) => call.options.maxBuffer === 64 * 1024));

  const original = Object.assign(
    new Error("phase failure whose body is not persisted"),
    { status: 19, stderr: Buffer.from(canary) },
  );
  let operationDiagnostic;
  assert.throws(
    () =>
      withRollbackComposeDiagnostic(
        "runtime-stack-up",
        () => {
          throw original;
        },
        (diagnostic) => {
          operationDiagnostic = attachRollbackContainerSnapshot(
            "runtime-stack-up",
            diagnostic,
            () => snapshot,
          );
        },
      ),
    (error) => error === original,
  );
  assert.equal(operationDiagnostic.exitCode, 19);
  assert.equal(operationDiagnostic.operation, "runtime-stack-up");
  assert.deepEqual(operationDiagnostic.containerSnapshot, snapshot);
  let cleanupContinued = false;
  let timedOutOperationDiagnostic;
  assert.throws(
    () =>
      withRollbackComposeDiagnostic(
        "runtime-stack-up",
        () => {
          throw original;
        },
        (diagnostic) => {
          timedOutOperationDiagnostic = attachRollbackContainerSnapshot(
            "runtime-stack-up",
            diagnostic,
            () =>
              captureRollbackContainerSnapshot(
                projectName,
                undefined,
                (args) => {
                  if (args[0] === "ps") return `${"c".repeat(64)}\n`;
                  throw Object.assign(new Error(canary), { code: "ETIMEDOUT" });
                },
              ),
          );
        },
      ),
    (error) => error === original,
  );
  cleanupContinued = true;
  assert.equal(cleanupContinued, true);
  assert.equal(timedOutOperationDiagnostic.exitCode, 19);
  assert.deepEqual(timedOutOperationDiagnostic.containerSnapshot, {
    status: "unavailable",
    containers: [],
  });
  let unavailableDiagnostic;
  assert.throws(
    () =>
      withRollbackComposeDiagnostic(
        "runtime-stack-up",
        () => {
          throw original;
        },
        (diagnostic) => {
          unavailableDiagnostic = attachRollbackContainerSnapshot(
            "runtime-stack-up",
            diagnostic,
            () => {
              throw new Error(canary);
            },
          );
        },
      ),
    (error) => error === original,
  );
  assert.deepEqual(unavailableDiagnostic.containerSnapshot, {
    status: "unavailable",
    containers: [],
  });

  const directory = await mkdtemp(
    join(tmpdir(), "g18-container-failure-diagnostic-"),
  );
  try {
    const candidateSha = "2".repeat(40);
    const runId = `20261024T120000Z-${candidateSha.slice(0, 7)}`;
    const cleanup = {
      verified: true,
      complete: true,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
    };
    const receipt = {
      ...createRollbackFailureReceipt({
        runId,
        candidateSha,
        stage: "up",
        error: original,
        cleanup,
      }),
      operationDiagnostic,
    };
    const childError = new Error("proof child failed");
    childError.result = {
      stdout: `${JSON.stringify(receipt)}\n`,
      joined: true,
    };
    const persisted = await persistRollbackFailureFromChild({
      error: childError,
      identity: { runId, candidateSha },
      lineage: {},
      evidenceDir: directory,
    });
    assert.equal(persisted.artifact.operationDiagnostic.exitCode, 19);
    assert.deepEqual(
      persisted.artifact.operationDiagnostic.containerSnapshot,
      snapshot,
    );
    const artifactBytes = await readFile(persisted.receipt.path, "utf8");
    assert.doesNotMatch(
      artifactBytes,
      /RAW_CONTAINER_ENV_SECRET_CANARY|container-id|unknown-service-name|foreign-service-name/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G18 accepts a nullable startup wake only for the exact current cart revision and processed Inbox message", async () => {
  const { hasProcessedRollbackWakeForDesiredRevision } =
    await import("../../tools/rollback-runtime-proof.mjs");
  const desiredRevision = "7";
  const payload = {
    cartScopeRef: "aroma-primary",
    desiredRevision,
    reason: "Recovery",
    orderRef: null,
  };
  const envelope = {
    envelopeVersion: "1",
    messageId: "wake-7",
    messageType: "AromaConvergenceRequested.v1",
    producer: "orders-aroma-preparation",
    correlationId: "correlation-7",
    causationId: null,
    aggregate: { type: "AromaCart", ref: "aroma-primary", version: "12" },
    payload,
  };
  const envelopeHash = canonicalRequestHash(envelope);
  const payloadHash = canonicalRequestHash(payload);
  const wake = {
    message_id: "wake-7",
    message_type: envelope.messageType,
    topic: "coffee.aroma.cart.commands.v1",
    aggregate_ref: "aroma-primary",
    aggregate_sequence: "12",
    owner_version: "12",
    partition_key: "aroma-primary",
    schema_version: "1",
    envelope_hash: envelopeHash,
    payload_hash: envelopeHash,
    correlation_id: "correlation-7",
    causation_id: null,
    payload,
    envelope,
    state: "Published",
  };
  const delivery = {
    consumer_name: "aroma-convergence-v1",
    message_id: "wake-7",
    message_type: envelope.messageType,
    partition_key: "aroma-primary",
    schema_version: "1",
    owner_version: "12",
    payload_hash: payloadHash,
    envelope_hash: envelopeHash,
    envelope,
    state: "Processed",
  };
  const accepts = (
    candidateWake = wake,
    candidateDelivery = delivery,
    revision = desiredRevision,
  ) =>
    hasProcessedRollbackWakeForDesiredRevision({
      wakes: [candidateWake],
      wakeInbox: [candidateDelivery],
      desiredRevision: revision,
      consumerName: "aroma-convergence-v1",
    });

  assert.equal(
    accepts(),
    true,
    "a Recovery wake may legitimately have no causation id",
  );
  assert.equal(
    accepts({ ...wake, aggregate_ref: "another-cart" }),
    false,
    "a cross-cart wake must not prove this cart",
  );
  const wrongRevision = "8";
  assert.equal(
    accepts({
      ...wake,
      payload: { ...payload, desiredRevision: wrongRevision },
      envelope: {
        ...envelope,
        payload: { ...payload, desiredRevision: wrongRevision },
      },
    }),
    false,
    "a wake for a different desired revision must not prove the current attempt",
  );
  assert.equal(
    accepts(wake, { ...delivery, message_id: "other-wake" }),
    false,
    "a different Inbox message id must not prove delivery of this wake",
  );
  assert.equal(
    accepts(wake, { ...delivery, state: "Processing" }),
    false,
    "an unprocessed Inbox row must not prove durable completion",
  );
  assert.notEqual(
    envelopeHash,
    payloadHash,
    "the fixture must represent the distinct Outbox/Inbox hash semantics",
  );
  assert.equal(
    accepts(wake, { ...delivery, payload_hash: envelopeHash }),
    false,
    "the Inbox payload hash is over the payload, not the full envelope hash stored by Outbox",
  );
  assert.equal(
    accepts(wake, {
      ...delivery,
      envelope: {
        ...envelope,
        payload: { ...payload, reason: "OperatorRequested" },
      },
    }),
    false,
    "a changed Inbox envelope must fail even if its message identifiers match",
  );
});

void test("G18 initial-unknown timeout persists a run-bound private fact summary and preserves the timeout", async () => {
  const {
    createRollbackInitialUnknownTimeoutDiagnostic,
    waitForRollbackFacts,
    writeRollbackInitialUnknownTimeoutDiagnostic,
  } = await import("../../tools/compose-smoke.mjs");
  const directory = await mkdtemp(
    join(tmpdir(), "g18-initial-unknown-timeout-"),
  );
  try {
    const candidateSha = "3".repeat(40);
    const runId = `20261024T120000Z-${candidateSha.slice(0, 7)}`;
    const evidenceDir = join(directory, "evidence/launch", runId);
    const launchIdentity = {
      context: { runId, candidateSha, sourceRepoRoot: directory, evidenceDir },
      evidenceDir,
    };
    const consumer = "orders-aroma-projection-v1";
    const canary = "PRIVATE_G18_PROVIDER_BODY_CANARY";
    const facts = {
      attempts: [{ state: "Started", attempt_ref: canary }],
      reservations: [
        { state: "UnknownOutcome", resolved: false, operation_ref: canary },
      ],
      gatewayRows: [{ state: "UnknownOutcome", response_body: canary }],
      orderProjection: { state: "UnknownOutcome", payload: canary },
      guardedCardState: "OutOfSync",
      ordersOutbox: [
        {
          message_type: "OrderConfirmed.v1",
          state: "Published",
          message_id: canary,
        },
      ],
      inboxRows: [
        {
          message_type: "OrderConfirmed.v1",
          consumer_name: "orders-aroma-preparation-v1",
          state: "Processed",
          envelope: canary,
        },
      ],
      wakes: [
        {
          message_type: "AromaConvergenceRequested.v1",
          state: "Published",
          payload: canary,
        },
      ],
      wakeInbox: [
        {
          consumer_name: "aroma-convergence-v1",
          state: "Processed",
          message_id: canary,
        },
      ],
      convergenceOutbox: [
        {
          message_type: "AromaConvergenceChanged.v1",
          state: "Published",
          envelope: canary,
        },
      ],
      projectionInbox: [
        {
          consumer_name: consumer,
          message_type: "AromaConvergenceChanged.v1",
          state: "Failed",
          envelope: canary,
        },
        {
          consumer_name: consumer,
          message_type: "AromaConvergenceChanged.v1",
          state: "Processed",
          envelope: canary,
        },
      ],
    };
    const diagnostic = createRollbackInitialUnknownTimeoutDiagnostic({
      launchIdentity,
      facts,
      projectionConsumerGroupId: consumer,
      correlationId: canary,
      orderRef: canary,
    });
    assert.deepEqual(diagnostic.predicates, {
      attemptUnknown: false,
      reservationUnknownUnresolved: true,
      gatewayUnknown: true,
      cardUnknown: false,
      projectionProcessed: true,
    });
    assert.deepEqual(diagnostic.operatorWake, {
      matchedIntentForCorrelation: false,
      canonicalPublishedIntent: false,
      exactPreparationInboxProcessed: false,
      causationLinkedWake: false,
      correlationRevisionReasonMatched: false,
      canonicalWake: false,
      exactConvergenceInboxProcessed: false,
      operatorWakeProcessed: false,
    });
    assert.deepEqual(diagnostic.selection, {
      currentDesiredUnique: false,
      unknownAttemptMatchesCurrentDesired: false,
    });
    assert.equal(diagnostic.rawProjectionState, "UnknownOutcome");
    assert.equal(diagnostic.guardedCardState, "OutOfSync");
    const guardedUnknown = createRollbackInitialUnknownTimeoutDiagnostic({
      launchIdentity,
      facts: {
        ...facts,
        orderProjection: { state: "OutOfSync" },
        guardedCardState: "UnknownOutcome",
      },
      projectionConsumerGroupId: consumer,
    });
    assert.equal(
      guardedUnknown.predicates.cardUnknown,
      true,
      "the timeout fact must report the guarded HTTP Card, not raw projection state",
    );
    assert.deepEqual(diagnostic.counts, {
      attempts: 1,
      reservations: 1,
      gatewayRows: 1,
      ordersOutbox: 1,
      inboxRows: 1,
      wakes: 1,
      wakeInbox: 1,
      convergenceOutbox: 1,
      projectionInbox: 2,
    });
    assert.deepEqual(diagnostic.deliveryCounts, {
      orderConfirmedPublished: 1,
      preparationInboxProcessed: 1,
      convergenceWakePublished: 1,
      convergenceInboxProcessed: 1,
      convergenceResultPublished: 1,
      projectionInboxProcessed: 1,
    });
    assert.equal(diagnostic.runId, runId);
    assert.equal(diagnostic.candidateSha, candidateSha);
    assert.equal(diagnostic.stage, "initial-unknown");
    assert.equal(diagnostic.code, "G18_INITIAL_UNKNOWN_OUTCOME_TIMEOUT");

    const desiredRevision = "7";
    const orderRef = canary;
    const correlationId = canary;
    const intentPayload = {
      orderRef,
      orderVersion: "9",
      requestedAt: "2026-10-24T00:00:00.000Z",
    };
    const intentEnvelope = {
      envelopeVersion: "1",
      messageId: canary,
      messageType: "OrderReconciliationRequested.v1",
      producer: "orders-service",
      correlationId,
      causationId: null,
      aggregate: { type: "Order", ref: orderRef, version: "9" },
      payload: intentPayload,
    };
    const intentHash = canonicalRequestHash(intentEnvelope);
    const intentPayloadHash = canonicalRequestHash(intentPayload);
    const intent = {
      message_id: canary,
      message_type: intentEnvelope.messageType,
      topic: "coffee.orders.lifecycle.v1",
      aggregate_ref: orderRef,
      aggregate_sequence: "3",
      owner_version: "9",
      partition_key: orderRef,
      schema_version: "1",
      envelope_hash: intentHash,
      payload_hash: intentHash,
      correlation_id: correlationId,
      causation_id: null,
      envelope: intentEnvelope,
      payload: intentPayload,
      state: "Published",
    };
    const preparationDelivery = {
      consumer_name: "orders-aroma-preparation-v1",
      message_id: canary,
      message_type: intent.message_type,
      partition_key: orderRef,
      schema_version: "1",
      owner_version: "9",
      payload_hash: intentPayloadHash,
      envelope_hash: intentHash,
      envelope: intentEnvelope,
      state: "Processed",
    };
    const wakePayload = {
      cartScopeRef: "aroma-primary",
      desiredRevision,
      reason: "OperatorRequested",
      orderRef,
    };
    const wakeEnvelope = {
      envelopeVersion: "1",
      messageId: canary,
      messageType: "AromaConvergenceRequested.v1",
      producer: "orders-aroma-preparation",
      correlationId,
      causationId: canary,
      aggregate: { type: "AromaCart", ref: "aroma-primary", version: "12" },
      payload: wakePayload,
    };
    const wakeHash = canonicalRequestHash(wakeEnvelope);
    const wakePayloadHash = canonicalRequestHash(wakePayload);
    const operatorWake = {
      message_id: canary,
      message_type: wakeEnvelope.messageType,
      topic: "coffee.aroma.cart.commands.v1",
      aggregate_ref: "aroma-primary",
      aggregate_sequence: "12",
      owner_version: "12",
      partition_key: "aroma-primary",
      schema_version: "1",
      envelope_hash: wakeHash,
      payload_hash: wakeHash,
      correlation_id: correlationId,
      causation_id: canary,
      payload: wakePayload,
      envelope: wakeEnvelope,
      state: "Published",
    };
    const wakeDelivery = {
      consumer_name: "aroma-convergence-v1",
      message_id: canary,
      message_type: operatorWake.message_type,
      partition_key: operatorWake.partition_key,
      schema_version: "1",
      owner_version: "12",
      payload_hash: wakePayloadHash,
      envelope_hash: wakeHash,
      envelope: wakeEnvelope,
      state: "Processed",
    };
    const operatorFacts = {
      ...facts,
      attempts: [
        ...facts.attempts,
        { state: "UnknownOutcome", desired_revision: desiredRevision },
      ],
      desired: [{ state: "Current", desired_revision: desiredRevision }],
      ordersOutbox: [intent],
      inboxRows: [preparationDelivery],
      wakes: [operatorWake],
      wakeInbox: [wakeDelivery],
    };
    const completeChain = createRollbackInitialUnknownTimeoutDiagnostic({
      launchIdentity,
      facts: operatorFacts,
      projectionConsumerGroupId: consumer,
      correlationId,
      orderRef,
    });
    assert.deepEqual(completeChain.operatorWake, {
      matchedIntentForCorrelation: true,
      canonicalPublishedIntent: true,
      exactPreparationInboxProcessed: true,
      causationLinkedWake: true,
      correlationRevisionReasonMatched: true,
      canonicalWake: true,
      exactConvergenceInboxProcessed: true,
      operatorWakeProcessed: true,
    });
    assert.deepEqual(completeChain.selection, {
      currentDesiredUnique: true,
      unknownAttemptMatchesCurrentDesired: true,
    });
    const partialChain = createRollbackInitialUnknownTimeoutDiagnostic({
      launchIdentity,
      facts: {
        ...operatorFacts,
        wakes: [
          {
            ...operatorWake,
            causation_id: null,
            envelope: { ...wakeEnvelope, causationId: null },
          },
        ],
      },
      projectionConsumerGroupId: consumer,
      correlationId,
      orderRef,
    });
    assert.deepEqual(partialChain.operatorWake, {
      matchedIntentForCorrelation: true,
      canonicalPublishedIntent: true,
      exactPreparationInboxProcessed: true,
      causationLinkedWake: false,
      correlationRevisionReasonMatched: false,
      canonicalWake: false,
      exactConvergenceInboxProcessed: false,
      operatorWakeProcessed: false,
    });
    assert.doesNotMatch(
      JSON.stringify(completeChain),
      new RegExp(canary, "u"),
      "timeout proof breakdown must never serialize correlation, order, message or payload canaries",
    );

    const artifactPath = await writeRollbackInitialUnknownTimeoutDiagnostic({
      launchIdentity,
      facts,
      projectionConsumerGroupId: consumer,
      correlationId: canary,
      orderRef: canary,
    });
    assert.equal(
      artifactPath,
      join(
        evidenceDir,
        "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback-initial-unknown-timeout.json",
      ),
    );
    const artifactBytes = await readFile(artifactPath, "utf8");
    assert.deepEqual(JSON.parse(artifactBytes), diagnostic);
    assert.doesNotMatch(
      artifactBytes,
      /PRIVATE_G18_PROVIDER_BODY_CANARY|attempt_ref|operation_ref|message_id|envelope|response_body/u,
    );
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    await assert.rejects(
      writeRollbackInitialUnknownTimeoutDiagnostic({
        launchIdentity,
        facts,
        projectionConsumerGroupId: consumer,
        correlationId: canary,
        orderRef: canary,
      }),
      { code: "EEXIST" },
    );
    assert.equal(
      await readFile(artifactPath, "utf8"),
      artifactBytes,
      "existing timeout evidence must never be overwritten",
    );
    await assert.rejects(
      writeRollbackInitialUnknownTimeoutDiagnostic({
        launchIdentity: { ...launchIdentity, evidenceDir: directory },
        facts,
        projectionConsumerGroupId: consumer,
        correlationId: canary,
        orderRef: canary,
      }),
      /EVIDENCE_SCOPE_INVALID/u,
    );

    const originalFacts = { private: canary };
    await assert.rejects(
      waitForRollbackFacts(
        async () => originalFacts,
        () => false,
        "INITIAL_UNKNOWN_OUTCOME",
        50,
        async () => {
          throw new Error(canary);
        },
      ),
      (error) =>
        error.message === "G18_INITIAL_UNKNOWN_OUTCOME_TIMEOUT" &&
        error.cause === originalFacts,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G18 restored-card timeout records bounded guarded facts only after timeout", async (t) => {
  const { waitForRollbackFacts, writeRollbackRestoredCardTimeoutDiagnostic } =
    await import("../../tools/compose-smoke.mjs");
  const { readRollbackGuardedCardFacts } =
    await import("../../tools/rollback-runtime-proof.mjs");
  const pg = (await import("pg")).default;
  const directory = await mkdtemp(join(tmpdir(), "g18-restored-card-timeout-"));
  const candidateSha = "4".repeat(40);
  const maxSnapshotAgeMs = 15_000;
  const orderRef = "ord_01J8G18TIMEOUTFIXTURE000000000";
  const canary = "RAW_G18_DATABASE_ROW_CANARY";
  const platformConfig = {
    services: {
      "orders-aroma-preparation": { database: "coffee_platform_orders" },
      "aroma-convergence": { aromaConvergence: { maxSnapshotAgeMs } },
    },
  };
  const credentials = {
    databaseCredentialsByRuntime: {
      "orders-aroma-preparation": {
        username: "coffee_orders_prepare_rw",
        password: "SCOPED_PREPARATION_SECRET_CANARY",
      },
    },
  };
  const row = {
    projection_state: "InSync",
    order_present: true,
    projection_present: true,
    current_desired_present: true,
    current_observed_present: true,
    proof_attempt_present: false,
    lease_present: true,
    desired_proof_matches: false,
    observed_proof_matches: true,
    observation_complete: true,
    observation_not_future: true,
    observation_fresh: false,
    freshness_enabled: true,
    attempt_successful: false,
    attempt_matches_projection: false,
    attempt_matches_desired: false,
    attempt_matches_observed: false,
    fence_matches: false,
    lease_owner_matches: false,
    lease_active: true,
    unknown_outcome_present: true,
    unresolved_reservation_present: true,
    current_contribution_matches: false,
    order_blockers_present: true,
    exact_lines_match: false,
    latest_attempt_present: true,
    latest_attempt_successful: true,
    latest_attempt_matches_desired: true,
    latest_attempt_matches_observed_revision: false,
    latest_attempt_observed_fingerprint_matches_current: true,
    latest_attempt_fence_matches_lease: true,
    latest_attempt_owner_matches_lease: true,
    provider_body: canary,
    attempt_ref: canary,
  };
  const calls = { connections: [], queries: [], ends: 0, failQuery: false };
  t.mock.method(pg.Client.prototype, "connect", async function () {
    calls.connections.push({
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      password: this.password,
      connectionTimeoutMillis: this._connectionTimeoutMillis,
      query_timeout: this.connectionParameters.query_timeout,
      statement_timeout: this.connectionParameters.statement_timeout,
    });
  });
  t.mock.method(pg.Client.prototype, "query", async function (sql, values) {
    calls.queries.push({ sql, values });
    if (calls.failQuery) throw new Error(canary);
    return { rows: [row] };
  });
  t.mock.method(pg.Client.prototype, "end", async () => {
    calls.ends += 1;
  });
  let dateNowValues = [];
  let dateNowFallback = 0;
  t.mock.method(Date, "now", () => dateNowValues.shift() ?? dateNowFallback);
  const useTimeoutClock = () => {
    dateNowValues = [2_000, 2_000, 2_001];
    dateNowFallback = 2_001;
  };

  const makeIdentity = (stamp) => {
    const runId = `${stamp}-${candidateSha.slice(0, 7)}`;
    const evidenceDir = join(directory, "evidence/launch", runId);
    return {
      context: {
        runId,
        candidateSha,
        sourceRepoRoot: directory,
        evidenceDir,
      },
      evidenceDir,
    };
  };
  try {
    dateNowValues = [1_000, 1_000];
    dateNowFallback = 1_000;
    await waitForRollbackFacts(
      async () => ({ state: "InSync" }),
      (card) => card.state === "InSync",
      "RESTORED_CARD_IN_SYNC",
      20,
      async () =>
        assert.fail("timeout diagnostics ran on successful Card read"),
    );
    assert.deepEqual(calls.queries, []);

    const launchIdentity = makeIdentity("20261026T120000Z");
    useTimeoutClock();
    await assert.rejects(
      waitForRollbackFacts(
        async () => ({ state: "OutOfSync" }),
        (card) => card.state === "InSync",
        "RESTORED_CARD_IN_SYNC",
        1,
        async (lastCard) => {
          const guardedCardFacts = await readRollbackGuardedCardFacts({
            port: 55432,
            credentials,
            platformConfig,
            orderRef,
          });
          await writeRollbackRestoredCardTimeoutDiagnostic({
            launchIdentity,
            ownerCardState: lastCard.state,
            guardedCardFacts,
          });
        },
      ),
      (error) => error.message === "G18_RESTORED_CARD_IN_SYNC_TIMEOUT",
    );
    assert.equal(calls.queries.length, 1);
    assert.equal(calls.ends, 1);
    assert.deepEqual(calls.connections[0], {
      host: "127.0.0.1",
      port: 55432,
      database: "coffee_platform_orders",
      user: "coffee_orders_prepare_rw",
      password: "SCOPED_PREPARATION_SECRET_CANARY",
      connectionTimeoutMillis: 1_000,
      query_timeout: 2_000,
      statement_timeout: 2_000,
    });
    assert.deepEqual(calls.queries[0].values, [orderRef, maxSnapshotAgeMs]);
    assert.equal(
      (calls.queries[0].sql.match(/clock_timestamp\(\)/gu) ?? []).length,
      1,
    );
    assert.match(calls.queries[0].sql, /orders\.order_desired_contributions/u);
    assert.match(calls.queries[0].sql, /orders\.mutation_reservations/u);
    const latestAttemptQuery = calls.queries[0].sql.match(
      /LEFT JOIN LATERAL \(([\s\S]*?)\) AS latest_attempt ON true/u,
    )?.[1];
    assert.ok(
      latestAttemptQuery,
      "latest attempt must be selected independently",
    );
    assert.match(
      latestAttemptQuery,
      /WHERE attempt\.cart_scope_ref='aroma-primary' AND attempt\.desired_revision=desired\.desired_revision/u,
    );
    assert.match(
      latestAttemptQuery,
      /ORDER BY attempt\.fence_epoch DESC,attempt\.started_at DESC,attempt\.attempt_ref DESC\s+LIMIT 1/u,
    );
    assert.doesNotMatch(latestAttemptQuery, /WHERE[\s\S]*attempt\.state/u);
    assert.match(
      calls.queries[0].sql,
      /latest_attempt_observation\.observed_revision = CASE WHEN latest_attempt\.state='NoOpInSync'\s+THEN latest_attempt\.observed_start_revision ELSE latest_attempt\.observed_end_revision END/u,
    );

    const artifactPath = join(
      launchIdentity.evidenceDir,
      "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback-restored-card-timeout.json",
    );
    const artifactBytes = await readFile(artifactPath, "utf8");
    const artifact = JSON.parse(artifactBytes);
    assert.deepEqual(Object.keys(artifact), [
      "schemaVersion",
      "gateId",
      "runId",
      "candidateSha",
      "stage",
      "code",
      "ownerCardState",
      "guardedCardFacts",
    ]);
    assert.equal(artifact.ownerCardState, "OutOfSync");
    assert.equal(
      artifact.guardedCardFacts.projectionState,
      "InSync",
      "owner HTTP Card state must come from the last HTTP read, not SQL projection state",
    );
    assert.deepEqual(Object.keys(artifact.guardedCardFacts), [
      "projectionState",
      "orderPresent",
      "projectionPresent",
      "currentDesiredPresent",
      "currentObservedPresent",
      "proofAttemptPresent",
      "leasePresent",
      "desiredProofMatches",
      "observedProofMatches",
      "observationComplete",
      "observationNotFuture",
      "observationFresh",
      "freshnessEnabled",
      "attemptSuccessful",
      "attemptMatchesProjection",
      "attemptMatchesDesired",
      "attemptMatchesObserved",
      "fenceMatches",
      "leaseOwnerMatches",
      "leaseActive",
      "unknownOutcomePresent",
      "unresolvedReservationPresent",
      "currentContributionMatches",
      "orderBlockersPresent",
      "exactLinesMatch",
      "latestAttemptPresent",
      "latestAttemptSuccessful",
      "latestAttemptMatchesDesired",
      "latestAttemptMatchesObservedRevision",
      "latestAttemptObservedFingerprintMatchesCurrent",
      "latestAttemptFenceMatchesLease",
      "latestAttemptOwnerMatchesLease",
    ]);
    for (const [key, value] of Object.entries(artifact.guardedCardFacts)) {
      if (key === "projectionState")
        assert.ok(
          [
            "Missing",
            "PendingObservation",
            "Converging",
            "InSync",
            "OutOfSync",
            "Blocked",
            "UnknownOutcome",
            "Other",
          ].includes(value),
        );
      else assert.equal(typeof value, "boolean", key);
    }
    assert.equal(artifact.guardedCardFacts.proofAttemptPresent, false);
    assert.equal(artifact.guardedCardFacts.observationFresh, false);
    assert.equal(artifact.guardedCardFacts.leaseActive, true);
    assert.equal(artifact.guardedCardFacts.currentContributionMatches, false);
    assert.equal(artifact.guardedCardFacts.orderBlockersPresent, true);
    assert.equal(artifact.guardedCardFacts.latestAttemptPresent, true);
    assert.equal(artifact.guardedCardFacts.latestAttemptSuccessful, true);
    assert.equal(artifact.guardedCardFacts.latestAttemptMatchesDesired, true);
    assert.equal(
      artifact.guardedCardFacts.latestAttemptMatchesObservedRevision,
      false,
    );
    assert.equal(
      artifact.guardedCardFacts.latestAttemptObservedFingerprintMatchesCurrent,
      true,
      "a new observed revision with the same fingerprint keeps the historical fingerprint match",
    );
    assert.equal(
      artifact.guardedCardFacts.latestAttemptFenceMatchesLease,
      true,
    );
    assert.equal(
      artifact.guardedCardFacts.latestAttemptOwnerMatchesLease,
      true,
    );
    assert.doesNotMatch(
      artifactBytes,
      /RAW_G18_DATABASE_ROW_CANARY|SCOPED_PREPARATION_SECRET_CANARY|ord_01J8G18TIMEOUTFIXTURE/u,
    );
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    assert.equal(
      (
        await stat(
          join(launchIdentity.evidenceDir, "gates/G18_ROLLBACK/artifacts"),
        )
      ).mode & 0o777,
      0o700,
    );
    await assert.rejects(
      writeRollbackRestoredCardTimeoutDiagnostic({
        launchIdentity,
        ownerCardState: "OutOfSync",
        guardedCardFacts: row,
      }),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(artifactPath, "utf8"), artifactBytes);

    const latestAttemptScenarios = [
      {
        stamp: "20261026T120002Z",
        fields: {
          projection_state: "OutOfSync",
          proof_attempt_present: false,
          latest_attempt_present: true,
          latest_attempt_successful: true,
          latest_attempt_matches_desired: true,
          latest_attempt_matches_observed_revision: false,
          latest_attempt_observed_fingerprint_matches_current: false,
          latest_attempt_fence_matches_lease: false,
          latest_attempt_owner_matches_lease: false,
        },
        expected: {
          projectionState: "OutOfSync",
          proofAttemptPresent: false,
          latestAttemptSuccessful: true,
          latestAttemptMatchesObservedRevision: false,
          latestAttemptObservedFingerprintMatchesCurrent: false,
        },
      },
      {
        stamp: "20261026T120003Z",
        fields: {
          projection_state: "OutOfSync",
          proof_attempt_present: false,
          attempt_successful: true,
          latest_attempt_present: true,
          latest_attempt_successful: false,
          latest_attempt_matches_desired: true,
          latest_attempt_matches_observed_revision: true,
          latest_attempt_observed_fingerprint_matches_current: true,
          latest_attempt_fence_matches_lease: true,
          latest_attempt_owner_matches_lease: true,
        },
        expected: {
          projectionState: "OutOfSync",
          proofAttemptPresent: false,
          attemptSuccessful: true,
          latestAttemptSuccessful: false,
          latestAttemptMatchesObservedRevision: true,
          latestAttemptObservedFingerprintMatchesCurrent: true,
        },
      },
    ];
    for (const scenario of latestAttemptScenarios) {
      Object.assign(row, scenario.fields);
      const scenarioIdentity = makeIdentity(scenario.stamp);
      useTimeoutClock();
      await assert.rejects(
        waitForRollbackFacts(
          async () => ({ state: "OutOfSync" }),
          (card) => card.state === "InSync",
          "RESTORED_CARD_IN_SYNC",
          1,
          async (lastCard) => {
            const guardedCardFacts = await readRollbackGuardedCardFacts({
              port: 55432,
              credentials,
              platformConfig,
              orderRef,
            });
            await writeRollbackRestoredCardTimeoutDiagnostic({
              launchIdentity: scenarioIdentity,
              ownerCardState: lastCard.state,
              guardedCardFacts,
            });
          },
        ),
        (error) => error.message === "G18_RESTORED_CARD_IN_SYNC_TIMEOUT",
      );
      const scenarioArtifact = JSON.parse(
        await readFile(
          join(
            scenarioIdentity.evidenceDir,
            "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback-restored-card-timeout.json",
          ),
          "utf8",
        ),
      );
      for (const [key, expected] of Object.entries(scenario.expected))
        assert.equal(scenarioArtifact.guardedCardFacts[key], expected, key);
    }

    await assert.rejects(
      writeRollbackRestoredCardTimeoutDiagnostic({
        launchIdentity: { ...launchIdentity, evidenceDir: directory },
        ownerCardState: "OutOfSync",
        guardedCardFacts: row,
      }),
      /G18_RESTORED_CARD_DIAGNOSTIC_EVIDENCE_SCOPE_INVALID/u,
    );

    const failedIdentity = makeIdentity("20261026T120001Z");
    calls.failQuery = true;
    useTimeoutClock();
    await assert.rejects(
      waitForRollbackFacts(
        async () => ({ state: "OutOfSync" }),
        (card) => card.state === "InSync",
        "RESTORED_CARD_IN_SYNC",
        1,
        async (lastCard) => {
          const guardedCardFacts = await readRollbackGuardedCardFacts({
            port: 55432,
            credentials,
            platformConfig,
            orderRef,
          });
          await writeRollbackRestoredCardTimeoutDiagnostic({
            launchIdentity: failedIdentity,
            ownerCardState: lastCard.state,
            guardedCardFacts,
          });
        },
      ),
      (error) => {
        assert.equal(error.message, "G18_RESTORED_CARD_IN_SYNC_TIMEOUT");
        assert.doesNotMatch(error.message, new RegExp(canary, "u"));
        return true;
      },
    );
    assert.equal(calls.queries.length, 4);
    assert.equal(calls.ends, 4);
    await assert.rejects(
      readFile(
        join(
          failedIdentity.evidenceDir,
          "gates/G18_ROLLBACK/artifacts/mutation-disable-rollback-restored-card-timeout.json",
        ),
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G18 initial-unknown failure records only a closed substage and owner HTTP source parses", async () => {
  const {
    attachRollbackInitialUnknownSubstage,
    createRollbackInitialUnknownDiagnostic,
    ROLLBACK_INITIAL_UNKNOWN_SUBSTAGES,
  } = await import("../../tools/compose-smoke.mjs");
  const { rollbackOwnerHttpSource } =
    await import("../../tools/rollback-runtime-proof.mjs");
  const receipt = {
    stage: "initial-unknown",
    errorName: "Error",
    messageSha256: "a".repeat(64),
  };
  for (const substage of ROLLBACK_INITIAL_UNKNOWN_SUBSTAGES) {
    const attached = attachRollbackInitialUnknownSubstage(receipt, substage);
    assert.equal(attached.initialUnknownSubstage, substage);
    assert.equal(attached.messageSha256, receipt.messageSha256);
    assert.equal(Object.isFrozen(attached), true);
  }
  assert.throws(
    () => attachRollbackInitialUnknownSubstage(receipt, "raw-error-message"),
    /not allowlisted/u,
  );
  assert.throws(
    () =>
      attachRollbackInitialUnknownSubstage(
        { ...receipt, stage: "up" },
        "health",
      ),
    /requires an initial-unknown/u,
  );
  const canary = "PRIVATE_G18_ERROR_BODY_CANARY";
  const dbDiagnostic = createRollbackInitialUnknownDiagnostic(
    "owner-db-facts",
    Object.assign(new Error(canary), { code: "42501" }),
  );
  assert.deepEqual(dbDiagnostic, {
    operation: "owner-db-facts",
    sqlState: "42501",
    exitCode: null,
    signal: null,
    failureCode: null,
  });
  const httpDiagnostic = createRollbackInitialUnknownDiagnostic(
    "guarded-card-http",
    Object.assign(new Error(canary), {
      status: 1,
      signal: null,
      stderr: Buffer.from(
        `${canary}\r\nError: G18_ORDER_CARD_HTTP_INVALID\r\n    at child (file:///private/path)`,
      ),
    }),
  );
  assert.deepEqual(httpDiagnostic, {
    operation: "guarded-card-http",
    sqlState: null,
    exitCode: 1,
    signal: null,
    failureCode: "G18_ORDER_CARD_HTTP_INVALID",
  });
  const exactMessageDiagnostic = createRollbackInitialUnknownDiagnostic(
    "guarded-card-http",
    Object.assign(new Error("G18_ORDER_CARD_HTTP_INVALID"), {
      status: 1,
      stderr: Buffer.from("quoted code is not needed"),
    }),
  );
  assert.equal(
    exactMessageDiagnostic.failureCode,
    "G18_ORDER_CARD_HTTP_INVALID",
    "the exact allowlisted Error.message remains recognized",
  );
  for (const stderr of [
    `const source = "Error: G18_ORDER_CARD_HTTP_INVALID";`,
    "Other child failure",
    "Error: G18_ORDER_CARD_HTTP_INVALID extra",
  ]) {
    const misleadingDiagnostic = createRollbackInitialUnknownDiagnostic(
      "guarded-card-http",
      Object.assign(new Error(canary), {
        status: 1,
        stderr: Buffer.from(stderr),
      }),
    );
    assert.equal(
      misleadingDiagnostic.failureCode,
      null,
      "quoted, unrelated, or suffixed stderr must not classify as an error code",
    );
  }
  const unknownChildDiagnostic = createRollbackInitialUnknownDiagnostic(
    "guarded-card-http",
    Object.assign(new Error(canary), {
      status: 1,
      stderr: Buffer.from(canary),
    }),
  );
  assert.equal(
    unknownChildDiagnostic.failureCode,
    null,
    "unrecognized child output must not enter the finite receipt",
  );
  const diagnosed = attachRollbackInitialUnknownSubstage(
    receipt,
    "drift-card",
    httpDiagnostic,
  );
  assert.deepEqual(diagnosed.initialUnknownDiagnostic, httpDiagnostic);
  assert.doesNotMatch(JSON.stringify(diagnosed), new RegExp(canary, "u"));
  assert.throws(
    () =>
      createRollbackInitialUnknownDiagnostic(
        "arbitrary-operation",
        new Error(canary),
      ),
    /not allowlisted/u,
  );

  for (const action of ["read", "reconcile"]) {
    const source = rollbackOwnerHttpSource(
      "ord_00000000000000000000000001",
      action,
    );
    const checked = spawnSync(
      process.execPath,
      ["--check", "--input-type=module"],
      {
        input: source,
        encoding: "utf8",
      },
    );
    assert.equal(
      checked.status,
      0,
      `generated ${action} owner HTTP source must parse as Node ESM`,
    );
    assert.match(
      source,
      /from '\.\/dist\/index\.js'/u,
      "owner HTTP source must import the flattened runtime package",
    );
    assert.match(
      source,
      /runtimeRequire\.resolve\('js-yaml'\)/u,
      "transitive YAML parser must resolve through the runtime package that owns it",
    );
    assert.doesNotMatch(
      source,
      /from '\.\/apps\/api-public\/dist\/index\.js'/u,
    );
  }

  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.match(dockerfile, /WORKDIR \/app/u);
  assert.match(dockerfile, /COPY --from=build \/runtime \.\//u);
  assert.match(dockerfile, /CMD \["--entry", "dist\/main\.js"\]/u);
  const flatRuntime = await mkdtemp(join(tmpdir(), "g18-flat-owner-http-"));
  try {
    await mkdir(join(flatRuntime, "dist"), { recursive: true });
    await writeFile(
      join(flatRuntime, "dist/index.js"),
      "export const configuredOrdersOrigin=()=> 'https://orders-service:4104'; export const configuredOrdersTls=()=>({material:{},targetEnvironment:'test',targetRuntime:'orders-service'});\n",
    );
    for (const [name, source] of [
      [
        "@coffee-platform/platform-http",
        "export const createHttpClient=()=>({fetch:async()=>new Response(JSON.stringify({orderRef:'ord_00000000000000000000000001',version:'1',aroma:{state:'UnknownOutcome',blockers:[]}}),{status:200}),close:async()=>{}});\n",
      ],
      [
        "@coffee-platform/security",
        "export const signActorContext=()=> 'synthetic-token';\n",
      ],
    ]) {
      const moduleDirectory = join(flatRuntime, "node_modules", name);
      await mkdir(moduleDirectory, { recursive: true });
      await writeFile(
        join(moduleDirectory, "package.json"),
        JSON.stringify({ type: "module", exports: "./index.js" }),
      );
      await writeFile(join(moduleDirectory, "index.js"), source);
    }
    const runtimePackage = join(
      flatRuntime,
      "node_modules",
      "@coffee-platform",
      "runtime",
    );
    const runtimeYaml = join(runtimePackage, "node_modules", "js-yaml");
    await mkdir(join(runtimePackage, "dist"), { recursive: true });
    await writeFile(
      join(runtimePackage, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" }),
    );
    await writeFile(join(runtimePackage, "dist/index.js"), "export {};\n");
    await mkdir(runtimeYaml, { recursive: true });
    await writeFile(
      join(runtimeYaml, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    await writeFile(
      join(runtimeYaml, "index.js"),
      "export const load=value=>JSON.parse(value);\n",
    );
    assert.equal(
      await stat(join(flatRuntime, "node_modules", "js-yaml")).then(
        () => true,
        () => false,
      ),
      false,
      "flat fixture intentionally omits the runtime-transitive YAML parser from API-public top-level dependencies",
    );
    const { privateKey } = generateKeyPairSync("ed25519");
    const configPath = join(flatRuntime, "config.json");
    const secretsPath = join(flatRuntime, "scoped-secrets.json");
    await writeFile(
      configPath,
      JSON.stringify({
        services: { "api-public": { outbound: ["orders-service:4104"] } },
      }),
    );
    await writeFile(
      secretsPath,
      JSON.stringify({
        secrets: {
          security: {
            apiPublicDelegationSigningPrivateKey: privateKey
              .export({ type: "pkcs8", format: "pem" })
              .toString(),
          },
        },
      }),
    );
    const execution = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: flatRuntime,
      env: {
        ...process.env,
        COFFEE_CONFIG_FILE: configPath,
        COFFEE_RUNTIME_SECRETS_FILE: secretsPath,
      },
      input: rollbackOwnerHttpSource("ord_00000000000000000000000001", "read"),
      encoding: "utf8",
    });
    assert.equal(
      execution.status,
      0,
      `generated ESM must resolve from flat /app layout: ${execution.stderr}`,
    );
    assert.deepEqual(JSON.parse(execution.stdout.trim()), {
      status: 200,
      state: "UnknownOutcome",
      version: "1",
      blockerCodes: [],
    });
    assert.equal(
      await stat(join(flatRuntime, "apps")).then(
        () => true,
        () => false,
      ),
      false,
      "flat fixture must not accidentally provide the source-workspace path",
    );
  } finally {
    await rm(flatRuntime, { recursive: true, force: true });
  }
});

void test("G18 fake provider holds a decoder-invalid HTTP 200 after lost PUT until D attestation release", async () => {
  const { rollbackRecoveryGetResponse } =
    await import("../../tools/compose-smoke.mjs");
  const {
    applyRollbackArmedCartDrift,
    shouldLoseFirstRollbackSetQuantityResponse,
    hasCompleteSafeGetBetweenLostAndApplied,
  } = await import("../../tools/rollback-runtime-proof.mjs");
  const { decodeCartSnapshot } =
    await import("../../apps/aroma-gateway/dist/infrastructure/provider/decoder.js");
  const { ProviderSessionManager } =
    await import("../../apps/aroma-gateway/dist/infrastructure/provider/session.js");
  const { MemoryProviderSessionStore } =
    await import("../../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js");
  const directory = await mkdtemp(join(tmpdir(), "g18-recovery-get-gate-"));
  try {
    const lost = {
      kind: "set-quantity",
      outcome: "response-lost-before-effect",
    };
    const gated = {
      kind: "safe-get",
      outcome: "recovery-gated-incomplete-body",
    };
    const applied = { kind: "set-quantity", outcome: "applied" };
    assert.equal(
      hasCompleteSafeGetBetweenLostAndApplied([lost, gated, applied]),
      false,
      "a decoder-gated incomplete response must not prove the recovery GET",
    );
    assert.equal(
      hasCompleteSafeGetBetweenLostAndApplied([
        lost,
        gated,
        { kind: "safe-get", outcome: "complete" },
        applied,
      ]),
      true,
      "a later complete fresh GET must prove the recovery barrier",
    );
    const releaseFile = join(directory, "recovery-get-release");
    const payload = { quantity: 1 };
    const completeCart = JSON.parse(
      await readFile(
        join(
          REPO_ROOT,
          "evidence/aroma-provider/2026-09-12-cart-mutations/add-one-get.json",
        ),
        "utf8",
      ),
    );
    assert.equal(completeCart.products.length, 1);
    completeCart.products[0].quantity = 1;
    completeCart.products[0].packing = "Aroma";
    completeCart.products[0].grind_id = "1";
    let driftApplied = false;
    driftApplied = applyRollbackArmedCartDrift({
      rollbackMode: true,
      faultArmed: false,
      driftApplied,
      cart: completeCart,
    });
    assert.equal(
      driftApplied,
      false,
      "an unarmed fixture must preserve the confirmed quantity-one baseline",
    );
    let firstQuantityWriteDropped = false;
    const initial = await rollbackRecoveryGetResponse({
      rollbackMode: true,
      firstQuantityWriteDropped,
      releaseFile,
      cartBody: JSON.stringify(completeCart),
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(
      decodeCartSnapshot(JSON.parse(initial.body)).lines[0].quantity,
      1,
      "initial safe GET must pass before the deliberate lost PUT",
    );

    for (let get = 0; get < 3; get += 1) {
      driftApplied = applyRollbackArmedCartDrift({
        rollbackMode: true,
        faultArmed: true,
        driftApplied,
        cart: completeCart,
      });
      assert.equal(
        driftApplied,
        true,
        "the drift latch must stay set across sequential GET assignments",
      );
      assert.equal(
        completeCart.products[0].quantity,
        2,
        "an armed repeated GET must not change the physical quantity twice",
      );
    }
    const driftBody = JSON.stringify(completeCart);
    assert.equal(
      decodeCartSnapshot(JSON.parse(driftBody)).lines[0].quantity,
      2,
      "the first post-arm GET must expose a complete quantity-two cart to the observer",
    );

    firstQuantityWriteDropped = shouldLoseFirstRollbackSetQuantityResponse(
      1,
      payload,
    );
    assert.equal(
      firstQuantityWriteDropped,
      true,
      "fixture must drop exactly its first quantity-one PUT",
    );
    const held = await rollbackRecoveryGetResponse({
      rollbackMode: true,
      firstQuantityWriteDropped,
      releaseFile,
      cartBody: driftBody,
    });
    assert.deepEqual(
      held,
      { gated: true, statusCode: 200, body: "{}" },
      "post-loss recovery GET must remain decoder-gated before D attestation release",
    );
    assert.throws(
      () => decodeCartSnapshot(JSON.parse(held.body)),
      (error) =>
        ["ProviderDecodeInvalid", "ProviderDecodeIncomplete"].includes(
          error.code,
        ),
      "the gate body must be rejected before a provider cart snapshot can be produced",
    );
    const manager = new ProviderSessionManager({
      transport: {
        login: async () => ({
          profile: {
            email: "fixture@example.test",
            wholesale: true,
            retail: false,
          },
          cookies: [
            {
              name: "fixture",
              value: "synthetic",
              domain: "provider.test",
              path: "/",
              expiresAt: null,
              secure: true,
              httpOnly: true,
              sameSite: "lax",
            },
          ],
        }),
        read: async function* () {
          yield Buffer.from(held.body);
          return [];
        },
        mutate: async () => ({ statusCode: 200, body: new Uint8Array() }),
      },
      store: new MemoryProviderSessionStore(),
      encryptionKey: Buffer.alloc(32, 17),
    });
    try {
      const sessionScope = {
        scopeRef: "aroma-development",
        email: "fixture@example.test",
        password: "synthetic",
      };
      const chunks = [];
      for await (const chunk of manager.readSafe(sessionScope, {
        kind: "cart",
      }))
        chunks.push(chunk);
      const readBody = Buffer.concat(chunks).toString("utf8");
      assert.equal(readBody, held.body);
      assert.equal(
        manager.isReady(),
        true,
        "HTTP 200 incomplete body must keep provider transport/session readiness healthy",
      );
      assert.throws(
        () => decodeCartSnapshot(JSON.parse(readBody)),
        (error) =>
          ["ProviderDecodeInvalid", "ProviderDecodeIncomplete"].includes(
            error.code,
          ),
      );
      assert.equal(
        manager.isReady(),
        true,
        "decoder failure must not retroactively degrade a successful provider GET",
      );
    } finally {
      await manager.close();
    }

    await writeFile(releaseFile, "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const released = await rollbackRecoveryGetResponse({
      rollbackMode: true,
      firstQuantityWriteDropped,
      releaseFile,
      cartBody: driftBody,
    });
    assert.deepEqual(
      released,
      { gated: false, statusCode: 200, body: driftBody },
      "D recovery must receive a fresh complete GET after release",
    );
    assert.equal(
      decodeCartSnapshot(JSON.parse(released.body)).lines[0].quantity,
      2,
    );

    await rm(releaseFile);
    const ordinary = await rollbackRecoveryGetResponse({
      rollbackMode: false,
      firstQuantityWriteDropped,
      releaseFile,
      cartBody: driftBody,
    });
    assert.deepEqual(
      ordinary,
      { gated: false, statusCode: 200, body: driftBody },
      "ordinary provider fixtures must not inherit the rollback gate",
    );
    assert.equal(
      applyRollbackArmedCartDrift({
        rollbackMode: false,
        faultArmed: true,
        driftApplied: false,
        cart: completeCart,
      }),
      false,
      "ordinary provider mode must ignore a fault-arm marker",
    );
    completeCart.products[0].quantity = 1;
    driftApplied = applyRollbackArmedCartDrift({
      rollbackMode: true,
      faultArmed: true,
      driftApplied,
      cart: completeCart,
    });
    assert.equal(
      driftApplied,
      true,
      "the latch must remain set after the real write restores quantity one",
    );
    assert.equal(
      completeCart.products[0].quantity,
      1,
      "a later GET must not re-inject drift after recovery",
    );
    driftApplied = applyRollbackArmedCartDrift({
      rollbackMode: true,
      faultArmed: true,
      driftApplied,
      cart: completeCart,
    });
    assert.equal(driftApplied, true);
    assert.equal(
      completeCart.products[0].quantity,
      1,
      "the fault must remain one-shot on every later GET",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G18 fault is armed only after B health and D recovery GET release follows mounted-config attestation", async () => {
  const source = await readFile(
    join(REPO_ROOT, "tools/compose-smoke.mjs"),
    "utf8",
  );
  const start = source.indexOf(
    "async function runMutationDisableRollbackProof(",
  );
  const end = source.indexOf("\nasync function assertDatabaseProof(", start);
  assert.ok(start >= 0 && end > start, "G18 lifecycle function was not found");
  const proof = source.slice(start, end);
  const healthy = proof.indexOf(
    "const initialRows = assertHealthy(projectName, secretsDir, composeFile)",
  );
  const arm = proof.indexOf("writeFile(providerFixture.faultArmFile");
  const drift = proof.indexOf('"INITIAL_B_DRIFT"');
  const command = proof.indexOf('"reconcile"', drift);
  assert.ok(
    healthy >= 0 && arm > healthy && drift > arm && command > drift,
    "B must be healthy before host arming, then wait for observed drift before the real owner command",
  );

  const disabledStage = proof.indexOf('markStage("disabled-reconcile")');
  const disabledUpMatch =
    /runCompose\s*\(\s*projectName\s*,\s*secretsDir\s*,\s*\[\s*"up"\s*,/u.exec(
      proof.slice(disabledStage),
    );
  const disabledUpStart =
    disabledStage < 0 || disabledUpMatch === null
      ? -1
      : disabledStage + disabledUpMatch.index;
  const disabledUpEnd = proof.indexOf(
    "composeFile: disabledOverride",
    disabledUpStart,
  );
  assert.ok(disabledUpStart >= 0 && disabledUpEnd > disabledUpStart);
  assert.doesNotMatch(
    proof.slice(disabledUpStart, disabledUpEnd),
    /"--wait"/u,
    "D startup must not block waiting for readiness while its first recovery GET is gated",
  );
  const disabledAttestationMatch =
    /readContainerConfigProof\s*\(\s*projectName\s*,\s*secretsDir\s*,\s*disabledOverride\b/u.exec(
      proof.slice(disabledUpEnd),
    );
  const disabledAttestation =
    disabledAttestationMatch === null
      ? -1
      : disabledUpEnd + disabledAttestationMatch.index;
  const release = proof.indexOf(
    "writeFile(providerFixture.recoveryGetReleaseFile",
    disabledAttestation,
  );
  const readinessMatch =
    /waitForRuntimeReadiness\s*\(\s*projectName\s*,\s*secretsDir\s*,\s*"aroma-convergence"/u.exec(
      proof.slice(release),
    );
  const readiness =
    readinessMatch === null ? -1 : release + readinessMatch.index;
  const observerReadinessMatch =
    /waitForRuntimeReadiness\s*\(\s*projectName\s*,\s*secretsDir\s*,\s*"aroma-observer"/u.exec(
      proof.slice(readiness),
    );
  const observerReadiness =
    observerReadinessMatch === null
      ? -1
      : readiness + observerReadinessMatch.index;
  const containerRows = proof.indexOf(
    "const disabledRecoveryRows = serviceRows(",
    observerReadiness,
  );
  const convergenceHealthWait = proof.indexOf(
    "await waitForDockerHealthy(convergenceContainer)",
    containerRows,
  );
  const observerHealthWait = proof.indexOf(
    "await waitForDockerHealthy(observerContainer)",
    convergenceHealthWait,
  );
  const allHealthy = proof.indexOf(
    "const afterDisabledRows = assertHealthy",
    observerHealthWait,
  );
  assert.ok(
    disabledAttestation > disabledUpEnd &&
      release > disabledAttestation &&
      readiness > release &&
      observerReadiness > readiness &&
      containerRows > observerReadiness &&
      convergenceHealthWait > containerRows &&
      observerHealthWait > convergenceHealthWait &&
      allHealthy > observerHealthWait,
    "D must attest config, release GET, await HTTP readiness and both Docker healthchecks before full health",
  );
  assert.match(proof, /assert\.ok\(\s*convergenceContainer,/u);
  assert.match(proof, /assert\.ok\(\s*observerContainer,/u);

  const finalReadStart = proof.indexOf(
    "const finalCard = await waitForRollbackFacts(",
  );
  const finalReadEnd = proof.indexOf(
    "const { reservation: finalOldReservation",
    finalReadStart,
  );
  assert.ok(finalReadStart >= 0 && finalReadEnd > finalReadStart);
  const { waitForRollbackFacts } =
    await import("../../tools/compose-smoke.mjs");
  const readFinalCard = (readCard, timeoutMs = 1_000) =>
    runInNewContext(
      `(async () => { ${proof.slice(finalReadStart, finalReadEnd)} return finalCard; })()`,
      {
        assert,
        projectName: "restored-project",
        secretsDir: "/fixture/scoped-secrets",
        restoredOverride: "/fixture/restored-compose.yaml",
        rollbackOrder: { orderRef: "restored-order" },
        runRollbackOwnerHttp: (...args) => {
          assert.deepEqual(args, [
            "restored-project",
            "/fixture/scoped-secrets",
            "/fixture/restored-compose.yaml",
            "restored-order",
            "read",
          ]);
          return readCard();
        },
        waitForRollbackFacts: (readFacts, predicate, description) => {
          assert.equal(description, "RESTORED_CARD_IN_SYNC");
          return waitForRollbackFacts(
            readFacts,
            predicate,
            description,
            timeoutMs,
          );
        },
      },
    );
  let cardReads = 0;
  const acceptedCard = { status: 200, state: "InSync" };
  assert.equal(
    await readFinalCard(async () =>
      ++cardReads === 1 ? { status: 200, state: "OutOfSync" } : acceptedCard,
    ),
    acceptedCard,
    "G18 must return the actual owner HTTP Card after its asynchronous projection catches up",
  );
  assert.equal(cardReads, 2);
  await assert.rejects(
    readFinalCard(async () => ({ status: 200, state: "OutOfSync" }), 50),
    { message: "G18_RESTORED_CARD_IN_SYNC_TIMEOUT" },
    "a permanently guarded Card must still fail G18",
  );
  const ownerError = new Error("G18_OWNER_HTTP_READ_FAILED");
  await assert.rejects(
    readFinalCard(async () => {
      throw ownerError;
    }),
    (error) => error === ownerError,
  );
});

void test("G18 operator wake proves real command correlation, preparation delivery and exact causation", async () => {
  const { hasProcessedRollbackOperatorWake } =
    await import("../../tools/rollback-runtime-proof.mjs");
  const correlationId = "reconcile-correlation";
  const orderRef = "ord_00000000000000000000000001";
  const desiredRevision = "7";
  const intentPayload = {
    orderRef,
    orderVersion: "9",
    requestedAt: "2026-10-24T00:00:00.000Z",
  };
  const intentEnvelope = {
    envelopeVersion: "1",
    messageId: "intent-message",
    messageType: "OrderReconciliationRequested.v1",
    producer: "orders-service",
    correlationId,
    causationId: null,
    aggregate: { type: "Order", ref: orderRef, version: "9" },
    payload: intentPayload,
  };
  const intentHash = canonicalRequestHash(intentEnvelope);
  const intentPayloadHash = canonicalRequestHash(intentPayload);
  const intent = {
    message_id: "intent-message",
    message_type: intentEnvelope.messageType,
    topic: "coffee.orders.lifecycle.v1",
    aggregate_ref: orderRef,
    aggregate_sequence: "3",
    owner_version: "9",
    partition_key: orderRef,
    schema_version: "1",
    envelope_hash: intentHash,
    payload_hash: intentHash,
    correlation_id: correlationId,
    causation_id: null,
    envelope: intentEnvelope,
    payload: intentPayload,
    state: "Published",
  };
  const preparationDelivery = {
    consumer_name: "orders-aroma-preparation-v1",
    message_id: intent.message_id,
    message_type: intent.message_type,
    partition_key: intent.partition_key,
    schema_version: intent.schema_version,
    owner_version: intent.owner_version,
    payload_hash: intentPayloadHash,
    envelope_hash: intentHash,
    envelope: intentEnvelope,
    state: "Processed",
  };
  const wakePayload = {
    cartScopeRef: "aroma-primary",
    desiredRevision,
    reason: "OperatorRequested",
    orderRef,
  };
  const wakeEnvelope = {
    envelopeVersion: "1",
    messageId: "wake-message",
    messageType: "AromaConvergenceRequested.v1",
    producer: "orders-aroma-preparation",
    correlationId,
    causationId: intent.message_id,
    aggregate: { type: "AromaCart", ref: "aroma-primary", version: "12" },
    payload: wakePayload,
  };
  const wakeHash = canonicalRequestHash(wakeEnvelope);
  const wakePayloadHash = canonicalRequestHash(wakePayload);
  const wake = {
    message_id: "wake-message",
    message_type: wakeEnvelope.messageType,
    topic: "coffee.aroma.cart.commands.v1",
    aggregate_ref: "aroma-primary",
    aggregate_sequence: "12",
    owner_version: "12",
    partition_key: "aroma-primary",
    schema_version: "1",
    envelope_hash: wakeHash,
    payload_hash: wakeHash,
    correlation_id: correlationId,
    causation_id: intent.message_id,
    payload: wakePayload,
    envelope: wakeEnvelope,
    state: "Published",
  };
  const convergenceDelivery = {
    consumer_name: "aroma-convergence-v1",
    message_id: wake.message_id,
    message_type: wake.message_type,
    partition_key: wake.partition_key,
    schema_version: wake.schema_version,
    owner_version: wake.owner_version,
    payload_hash: wakePayloadHash,
    envelope_hash: wakeHash,
    envelope: wakeEnvelope,
    state: "Processed",
  };
  const proof = (changes = {}) =>
    hasProcessedRollbackOperatorWake({
      ordersOutbox: [intent],
      inboxRows: [preparationDelivery],
      wakes: [wake],
      wakeInbox: [convergenceDelivery],
      correlationId,
      desiredRevision,
      orderRef,
      consumerName: "aroma-convergence-v1",
      ...changes,
    });

  assert.equal(
    proof(),
    true,
    "a matching real operator command and both processed Inbox deliveries must prove causation",
  );
  assert.equal(
    proof({ wakes: [{ ...wake, causation_id: null }] }),
    false,
    "startup wake cannot substitute for operator causation",
  );
  assert.equal(
    proof({ correlationId: "other-correlation" }),
    false,
    "a different accepted command cannot prove the wake",
  );
  assert.equal(
    proof({ inboxRows: [{ ...preparationDelivery, state: "Processing" }] }),
    false,
    "the operator intent must be processed by the preparation Inbox",
  );
  assert.equal(
    proof({
      wakeInbox: [{ ...convergenceDelivery, message_id: "other-wake" }],
    }),
    false,
    "the exact operator wake must be processed by the convergence Inbox",
  );
  assert.equal(
    proof({
      inboxRows: [
        { ...preparationDelivery, payload_hash: intent.payload_hash },
      ],
    }),
    false,
    "the preparation Inbox payload_hash must hash only the payload, not the Outbox envelope",
  );
  assert.equal(
    proof({
      wakeInbox: [{ ...convergenceDelivery, payload_hash: wake.payload_hash }],
    }),
    false,
    "the convergence Inbox payload_hash must hash only the payload, not the Outbox envelope",
  );
  assert.equal(
    proof({
      wakeInbox: [
        {
          ...convergenceDelivery,
          envelope: {
            ...wakeEnvelope,
            payload: { ...wakePayload, reason: "Recovery" },
          },
        },
      ],
    }),
    false,
    "corrupt Inbox envelope content must fail despite matching identity fields",
  );
  assert.equal(
    proof({ ordersOutbox: [{ ...intent, aggregate_ref: "another-order" }] }),
    false,
    "another Order's reconciliation intent cannot prove this Cart command",
  );
});

void test("Kafka namespace inventory proves exact physical claims and rejects canonical broker names", async () => {
  const {
    buildKafkaRegistryBootstrapScript,
    captureKafkaNamespaceInventory,
    kafkaNamespaceLaunchIdentity,
  } = await import("../../tools/compose-smoke.mjs");
  const candidateSha = "a".repeat(40);
  const contextIdentity = {
    schemaVersion: 1,
    runId: `20261024T120000Z-${candidateSha.slice(0, 7)}`,
    candidateSha,
    baseConfigSha256: "b".repeat(64),
  };
  const platformConfig = {
    environment: "development",
    verification: { kafkaNamespaceIsolation: true },
    kafka: {
      topics: {
        catalogSnapshot: {
          name: "coffee.catalog.snapshot.v1",
          dlq: "coffee.catalog.snapshot.v1.dlq",
          partitions: 1,
        },
        catalogMapping: {
          name: "coffee.catalog.mapping.v2",
          dlq: "coffee.catalog.mapping.v2.dlq",
          partitions: 1,
        },
        ordersLifecycle: {
          name: "coffee.orders.lifecycle.v1",
          dlq: "coffee.orders.lifecycle.v1.dlq",
          partitions: 1,
        },
        aromaCartCommands: {
          name: "coffee.aroma.cart.commands.v1",
          dlq: "coffee.aroma.cart.commands.v1.dlq",
          partitions: 1,
        },
        aromaCartEvents: {
          name: "coffee.aroma.cart.events.v1",
          dlq: "coffee.aroma.cart.events.v1.dlq",
          partitions: 1,
        },
        realtimeInvalidate: {
          name: "coffee.realtime.invalidate.v1",
          dlq: "coffee.realtime.invalidate.v1.dlq",
          partitions: 1,
        },
      },
    },
    services: {
      "orders-service": {
        kafka: {
          producers: ["coffee.orders.lifecycle.v1"],
          consumers: [
            {
              groupId: "orders-lifecycle-v1",
              processing: "durable",
              topics: ["coffee.orders.lifecycle.v1"],
            },
          ],
        },
      },
    },
  };
  const launchIdentity = kafkaNamespaceLaunchIdentity(platformConfig, {
    context: contextIdentity,
  });
  assert.deepEqual(launchIdentity, contextIdentity);
  assert.throws(
    () => kafkaNamespaceLaunchIdentity(platformConfig, undefined),
    /validated launch context/u,
  );
  const runGroup = `${launchIdentity.runId}.orders-lifecycle-v1`;
  const sortNames = (left, right) => left.localeCompare(right, "en");
  const expectedTopics = [
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
  ]
    .map((name) => `${launchIdentity.runId}.${name}`)
    .sort(sortNames);
  const enabledBootstrap = buildKafkaRegistryBootstrapScript(
    platformConfig,
    launchIdentity,
  );
  assert.equal(enabledBootstrap.length, 12);
  assert.deepEqual(
    enabledBootstrap
      .map((line) => line.match(/--topic "([^"]+)"/u)?.[1])
      .sort(sortNames),
    expectedTopics,
  );
  const disabledBootstrap = buildKafkaRegistryBootstrapScript({
    ...platformConfig,
    verification: { kafkaNamespaceIsolation: false },
  });
  assert.equal(disabledBootstrap.length, 12);
  assert.deepEqual(
    disabledBootstrap
      .map((line) => line.match(/--topic "([^"]+)"/u)?.[1])
      .sort(sortNames),
    [
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
    ].sort(sortNames),
  );
  const receipt = captureKafkaNamespaceInventory({
    projectName: "coffee-launch-fixture",
    platformConfig,
    launchIdentity,
    actualTopics: expectedTopics,
    actualGroups: [runGroup],
  });
  assert.deepEqual(receipt.topics.expectedPhysical, expectedTopics);
  assert.deepEqual(receipt.groups.expectedPhysical, [runGroup]);
  assert.equal(receipt.topics.canonicalNamesAbsent, true);
  assert.equal(receipt.groups.canonicalNamesAbsent, true);
  assert.throws(
    () =>
      captureKafkaNamespaceInventory({
        projectName: "coffee-launch-fixture",
        platformConfig,
        launchIdentity,
        actualTopics: [...expectedTopics, "coffee.orders.lifecycle.v1"],
        actualGroups: [runGroup],
      }),
    /canonical business topic/u,
  );
  assert.throws(
    () =>
      captureKafkaNamespaceInventory({
        projectName: "coffee-launch-fixture",
        platformConfig,
        launchIdentity,
        actualTopics: expectedTopics.filter(
          (name) =>
            name !== `${launchIdentity.runId}.coffee.catalog.snapshot.v1.dlq`,
        ),
        actualGroups: [runGroup],
      }),
    /missing expected run-scoped topics/u,
  );
  assert.throws(
    () =>
      captureKafkaNamespaceInventory({
        projectName: "coffee-launch-fixture",
        platformConfig,
        actualTopics: expectedTopics,
        actualGroups: [runGroup],
      }),
    /validated launch identity/u,
  );
});

void test("G18 convergence projection delivery requires AromaConvergenceChanged on the configured Orders projection group", async () => {
  const {
    hasProcessedConvergenceProjectionEvent,
    rollbackFactsRequireGuardedCard,
  } = await import("../../tools/compose-smoke.mjs");
  const { load } = await import("js-yaml");
  const platformConfig = load(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  const projectionConsumer = platformConfig.services[
    "orders-aroma-preparation"
  ].kafka.consumers.find(
    (consumer) =>
      consumer.processing === "durable" &&
      consumer.topics.includes("coffee.aroma.cart.events.v1"),
  );
  assert.equal(projectionConsumer?.groupId, "orders-aroma-projection-v1");
  const convergenceEvent = {
    message_type: "AromaConvergenceChanged.v1",
    consumer_name: projectionConsumer.groupId,
    state: "Processed",
  };
  assert.equal(
    hasProcessedConvergenceProjectionEvent(
      { projectionInbox: [convergenceEvent] },
      projectionConsumer.groupId,
    ),
    true,
  );
  assert.equal(
    hasProcessedConvergenceProjectionEvent(
      {
        projectionInbox: [
          { ...convergenceEvent, consumer_name: "orders-aroma-preparation-v1" },
        ],
      },
      projectionConsumer.groupId,
    ),
    false,
  );
  assert.equal(
    hasProcessedConvergenceProjectionEvent(
      {
        projectionInbox: [
          { ...convergenceEvent, message_type: "AromaConvergenceRequested.v1" },
        ],
      },
      projectionConsumer.groupId,
    ),
    false,
  );
  const cardFacts = {
    attempts: [{ state: "UnknownOutcome" }],
    reservations: [{ state: "UnknownOutcome", resolved: false }],
    gatewayRows: [{ state: "UnknownOutcome" }],
    projectionInbox: [convergenceEvent],
  };
  assert.equal(
    rollbackFactsRequireGuardedCard(cardFacts, projectionConsumer.groupId),
    true,
    "the guarded HTTP Card is queried after the other four initial predicates are ready",
  );
  assert.equal(
    rollbackFactsRequireGuardedCard(
      {
        ...cardFacts,
        reservations: [{ state: "RecoveredNotApplied", resolved: true }],
      },
      projectionConsumer.groupId,
    ),
    false,
  );
  assert.equal(
    rollbackFactsRequireGuardedCard(
      {
        ...cardFacts,
        projectionInbox: [{ ...convergenceEvent, state: "Failed" }],
      },
      projectionConsumer.groupId,
    ),
    false,
  );
});

void test("G18 early database projection guard emits a finite bootstrap receipt before resource setup", async (t) => {
  const {
    attachRollbackBootstrapSubstage,
    ROLLBACK_BOOTSTRAP_SUBSTAGES,
    withEarlyRollbackGuardReceipt,
  } = await import("../../tools/compose-smoke.mjs");
  const { deriveRuntimeDatabaseTarget } =
    await import("../../packages/platform-config/src/launch-database-target.ts");
  const { createRollbackFailureReceipt, persistRollbackFailureFromChild } =
    await import("../../verification/launch/v1/scenarios/rollback.mjs");
  const { load } = await import("js-yaml");
  const candidateSha = "3".repeat(40);
  const runId = `20261024T151732Z-${candidateSha.slice(0, 7)}`;
  const launchIdentity = {
    context: { runId, candidateSha, baseConfigSha256: "4".repeat(64) },
  };
  const config = load(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  const ownership = JSON.parse(
    await readFile(join(REPO_ROOT, "config/database-ownership.json"), "utf8"),
  );
  const targetConfig = {
    environment: config.environment,
    databaseIsolation: { enabled: false },
    services: config.services,
  };
  let guardError;
  await assert.rejects(
    withEarlyRollbackGuardReceipt(
      { mutationDisableRollback: true, launchIdentity },
      async () => {
        const claims = ownership.runtimeClaims.filter(
          ({ database }) => database !== null,
        );
        return claims.map(({ runtime }) =>
          deriveRuntimeDatabaseTarget({
            config: targetConfig,
            runtime,
            ownership,
            launchIdentity: {
              schemaVersion: 1,
              runId,
              candidateSha,
              baseConfigSha256: launchIdentity.context.baseConfigSha256,
            },
          }),
        );
      },
    ),
    (error) => {
      guardError = error;
      return true;
    },
  );
  assert.equal(guardError.message, "RUNTIME_DATABASE_TARGET_INVALID");
  assert.deepEqual(guardError.rollbackFailure.cleanup, {
    verified: true,
    complete: true,
    failures: [],
    retainedResources: [],
    inventory: { containers: [], volumes: [], networks: [] },
  });
  assert.equal(guardError.rollbackFailure.stage, "bootstrap");
  assert.equal(
    guardError.rollbackFailure.bootstrapSubstage,
    "launch-context-guard",
  );
  assert.equal(guardError.rollbackFailure.code, "G18_PHASE_FAILED");
  assert.equal(
    guardError.rollbackFailure.messageSha256,
    createHash("sha256")
      .update("RUNTIME_DATABASE_TARGET_INVALID")
      .digest("hex"),
  );
  assert.doesNotMatch(
    JSON.stringify(guardError.rollbackFailure),
    /launch database isolation|raw|secret/u,
  );

  const bootstrapReceipt = createRollbackFailureReceipt({
    runId,
    candidateSha,
    stage: "bootstrap",
    error: new Error("fixture"),
    cleanup: {
      verified: true,
      complete: true,
      failures: [],
      retainedResources: [],
      inventory: { containers: [], volumes: [], networks: [] },
    },
  });
  const canary = "RAW_BOOTSTRAP_DETAIL_CANARY";
  for (const substage of ROLLBACK_BOOTSTRAP_SUBSTAGES) {
    const tagged = attachRollbackBootstrapSubstage(bootstrapReceipt, substage);
    assert.equal(tagged.bootstrapSubstage, substage);
    assert.deepEqual(
      Object.keys(tagged).sort(),
      [...Object.keys(bootstrapReceipt), "bootstrapSubstage"].sort(),
    );
    assert.doesNotMatch(JSON.stringify(tagged), new RegExp(canary, "u"));
  }
  assert.throws(
    () =>
      attachRollbackBootstrapSubstage(
        bootstrapReceipt,
        `provider-fixture:${canary}`,
      ),
    /G18 bootstrap substage is not allowlisted/u,
  );
  assert.throws(
    () =>
      attachRollbackBootstrapSubstage(
        { ...bootstrapReceipt, stage: "up" },
        "provider-fixture",
      ),
    /bootstrap substage requires a bootstrap failure receipt/u,
  );

  const ordinaryError = new Error("ordinary launch database guard failure");
  await assert.rejects(
    withEarlyRollbackGuardReceipt(
      { mutationDisableRollback: false, launchIdentity },
      () => {
        throw ordinaryError;
      },
    ),
    (error) => error === ordinaryError,
    "non-G18 guard failures must remain unchanged",
  );

  const evidenceDir = await mkdtemp(join(tmpdir(), "g18-early-guard-receipt-"));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const childError = new Error("child failed before Docker setup");
  childError.result = {
    stdout: `${JSON.stringify(guardError.rollbackFailure)}\n`,
    joined: true,
  };
  const persisted = await persistRollbackFailureFromChild({
    error: childError,
    identity: { runId, candidateSha },
    lineage: {},
    evidenceDir,
  });
  assert.equal(persisted.artifact.stage, "bootstrap");
  assert.equal(persisted.artifact.bootstrapSubstage, "launch-context-guard");
  assert.equal(persisted.artifact.code, "G18_PHASE_FAILED");
  assert.equal(persisted.artifact.cleanup.complete, true);
  assert.deepEqual(persisted.artifact.cleanup.inventory, {
    containers: [],
    volumes: [],
    networks: [],
  });
});

void test("G13/G15 external PostgreSQL attachment is exact and keeps the shared data network", async (t) => {
  const {
    externalRecoveryMigrationCredentialRequest,
    externalPostgresConnectArgs,
    isExternalRecoveryProof,
    runComposeSmoke,
    writeScopedComposeOverride,
  } = await import("../../tools/compose-smoke.mjs");
  const networkId =
    "f1e587a5c52948bcf232cdc3e644859a7ed24db7dc4fd84be65f36a397cedf6a";
  const containerId =
    "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f";
  assert.deepEqual(externalPostgresConnectArgs(networkId, containerId), [
    "network",
    "connect",
    "--alias",
    "coffee_postgres",
    "--gw-priority",
    "-1",
    networkId,
    containerId,
  ]);
  assert.throws(
    () => externalPostgresConnectArgs("coffee_postgres_data", containerId),
    { name: "AssertionError" },
  );
  assert.equal(isExternalRecoveryProof({ recoveryProof: true }), true);
  assert.equal(
    isExternalRecoveryProof({
      recoveryProof: true,
      observabilityFixture: true,
    }),
    false,
    "bounded G14 fixture uses disposable PostgreSQL and never selects external G08 credentials",
  );
  assert.equal(
    isExternalRecoveryProof({
      recoveryProof: true,
      mutationDisableRollback: true,
    }),
    false,
    "G18 remains on its separate disposable diagnostic path",
  );
  assert.equal(isExternalRecoveryProof({ aromaCartProof: true }), false);
  assert.deepEqual(
    externalRecoveryMigrationCredentialRequest(
      {
        g08PreparationContextPath: "/parent/evidence/launch/run/context.json",
        postgres: { systemIdentifier: "7613370342949990434" },
      },
      "/child/evidence/launch/run/context.json",
      "orders",
    ),
    {
      root: REPO_ROOT,
      contextPath: "/child/evidence/launch/run/context.json",
      owner: "orders",
      kind: "migrator",
      expectedSystemIdentifier: "7613370342949990434",
      preparationContextPath: "/parent/evidence/launch/run/context.json",
    },
  );
  assert.equal(
    externalRecoveryMigrationCredentialRequest(
      {
        candidateRoot: "/validated-child",
        postgres: { systemIdentifier: "7613370342949990434" },
      },
      "/child/context.json",
      "orders",
    ).root,
    "/validated-child",
  );
  assert.deepEqual(
    externalRecoveryMigrationCredentialRequest(
      { postgres: { systemIdentifier: "7613370342949990434" } },
      "/g13/evidence/launch/run/context.json",
      "orders",
    ),
    {
      root: REPO_ROOT,
      contextPath: "/g13/evidence/launch/run/context.json",
      owner: "orders",
      kind: "migrator",
      expectedSystemIdentifier: "7613370342949990434",
    },
  );
  await assert.rejects(
    runComposeSmoke({ args: ["--recovery-proof", "--keep"] }),
    /always requires verified cleanup/u,
  );

  const contextPath = join(
    tmpdir(),
    `coffee-external-pg-context-${process.pid}.json`,
  );
  await writeFile(contextPath, "{}\n", { mode: 0o400 });
  t.after(() => rm(contextPath, { force: true }));
  const override = await writeScopedComposeOverride("coffee-external-pg", {
    sharedPostgres: true,
    recoveryProof: true,
    launchContextPath: contextPath,
  });
  t.after(() => rm(override, { force: true }));
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      "coffee-external-pg",
      "-f",
      COMPOSE_FILE,
      "-f",
      override,
      "config",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, COFFEE_COMPOSE_SECRETS_DIR: "/dev/shm" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.networks.coffee_postgres_data.external, true);
  assert.equal(
    config.networks.coffee_postgres_data.name,
    "coffee_postgres_data",
  );
  const baseline = composeConfig();
  for (const runtime of RUNTIMES) {
    assert.equal(
      Object.hasOwn(config.services[runtime].networks, "coffee_postgres_data"),
      Object.hasOwn(
        baseline.services[runtime].networks,
        "coffee_postgres_data",
      ),
      `${runtime} database network membership must remain canonical`,
    );
  }
});

void test("G13/G14 use current G08 context while malformed browser lineage fails before PostgreSQL", async (t) => {
  const { readExternalRecoveryProofCredentials } =
    await import("../../tools/compose-smoke.mjs");
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261026T000000Z-1234567",
    candidateSha: `1234567${"0".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  let connectCalls = 0;
  t.mock.method(pg.Client.prototype, "connect", async () => {
    connectCalls += 1;
    throw new Error("unexpected PostgreSQL connection");
  });

  await assert.rejects(
    readExternalRecoveryProofCredentials(launchIdentity, "/", {
      candidateRoot: REPO_ROOT,
      expectedLineage: "G13",
      resources: {
        composeProject: "coffee-launch-g13-fixture",
        kafkaPrefix: "20261026T000000Z-1234567",
      },
    }),
    (error) =>
      ["CONFIG-G08-BUNDLE", "CONFIG-G08-CONTEXT"].includes(error?.ruleId),
    "ordinary G13 must enter the current-context G08 reader",
  );

  await assert.rejects(
    readExternalRecoveryProofCredentials(launchIdentity, "/", {
      candidateRoot: REPO_ROOT,
      expectedLineage: "G14",
      resources: { g08PreparationContextPath: "/foreign/context.json" },
    }),
    /cannot downgrade to G13\/G14/u,
  );

  for (const resources of [
    {
      composeProject: "coffee-launch-g15-fixture",
      kafkaPrefix: "20261026T000000Z-1234567",
    },
    {
      g15ParentRunId: "20261026T000000Z-1234567",
    },
    {
      g08PreparationContextPath: "/parent/evidence/launch/run/context.json",
      g15ParentRunId: "20261026T000000Z-1234567",
    },
    {
      g08PreparationContextPath: null,
      g15ParentRunId: "20261026T000000Z-1234567",
    },
  ]) {
    await assert.rejects(
      readExternalRecoveryProofCredentials(launchIdentity, "/", {
        candidateRoot: REPO_ROOT,
        expectedLineage: "G15",
        resources,
      }),
      /G15 G08 parent preparation reference is missing/u,
    );
  }
  assert.equal(connectCalls, 0, "context failures must precede PostgreSQL");
});

void test("external PostgreSQL attachment cleanup requires acknowledged ownership and rechecks identity", async (t) => {
  const {
    attachApprovedExternalPostgres,
    cleanupApprovedExternalPostgresAttachment,
    externalRecoveryCleanupSummary,
    prepareApprovedExternalPostgresAttachment,
  } = await import("../../tools/compose-smoke.mjs");
  const containerId =
    "267958ce276e65d96c4a5d2cfc4541de35f9785de3dd15c04c34798cf7b1c85f";
  const dataNetworkId =
    "f1e587a5c52948bcf232cdc3e644859a7ed24db7dc4fd84be65f36a397cedf6a";
  const legacyNetworkId =
    "d6e471bdc52437821abc9a060e075a153ad55003daf81eea1782d0a62f70ceb3";
  const imageId =
    "sha256:1bea307dfb3ee30541a7acf7de14b58bcd6948da98e5d31a04c627c4d35ec64b";
  const initialRoute =
    "00000000:00000000:00000000:00000000:00000000:00000000:0";

  async function exercise(
    connectOutcome,
    { badIdentity = false, baselineAttached = false, prepare = false } = {},
  ) {
    let attached = baselineAttached;
    let route = initialRoute;
    let image = imageId;
    let drift = "";
    const calls = [];
    t.mock.method(childProcess, "execFileSync", (_command, args) => {
      calls.push([...args]);
      if (args[0] === "network" && args[1] === "connect") {
        if (connectOutcome === "failure-after-foreign-attach") {
          attached = true;
          throw Object.assign(new Error("connect outcome unknown"), {
            status: 1,
          });
        }
        attached = true;
        if (connectOutcome === "wrong-route") route = `${initialRoute}:bad`;
        if (badIdentity) image = "sha256:foreign";
        return "";
      }
      if (args[0] === "network" && args[1] === "disconnect") {
        attached = false;
        route = initialRoute;
        return "";
      }
      if (args[0] === "inspect" && args[1] === containerId) {
        return JSON.stringify([
          {
            Id: containerId,
            Image: drift === "identity" ? "sha256:foreign" : image,
            Name: "/coffee_postgres",
            NetworkSettings: {
              Networks: {
                coffee_network: { NetworkID: legacyNetworkId },
                ...(attached
                  ? {
                      coffee_postgres_data: {
                        NetworkID:
                          drift === "network" ? "foreign" : dataNetworkId,
                        Aliases:
                          drift === "alias" ? ["foreign"] : ["coffee_postgres"],
                        EndpointID:
                          drift === "endpoint" ? "foreign" : "approved",
                      },
                    }
                  : {}),
              },
            },
          },
        ]);
      }
      if (args[0] === "inspect" && args[1] === dataNetworkId) {
        return JSON.stringify([
          {
            Id: dataNetworkId,
            Name: "coffee_postgres_data",
            Containers: attached
              ? {
                  [containerId]: {},
                  ...(drift === "extra-endpoint" ? { foreign: {} } : {}),
                }
              : {},
          },
        ]);
      }
      if (args[0] === "inspect" && args[1] === legacyNetworkId) {
        return JSON.stringify([
          {
            Id: legacyNetworkId,
            Name: "coffee_network",
            Containers: { [containerId]: {} },
          },
        ]);
      }
      if (args[0] === "exec" && args[1] === containerId)
        return drift === "route" ? "foreign-route" : route;
      throw new Error(`unexpected fake Docker operation: ${args[0]}`);
    });
    syncBuiltinESMExports();

    const attachment =
      baselineAttached || prepare
        ? prepareApprovedExternalPostgresAttachment()
        : {
            before: {
              container: {
                NetworkSettings: {
                  Networks: { coffee_network: { NetworkID: legacyNetworkId } },
                },
              },
              legacyNetwork: { Containers: { [containerId]: {} } },
            },
            routeBefore: initialRoute,
            attached: false,
            attempted: false,
          };
    return {
      attachment,
      calls,
      get attached() {
        return attached;
      },
      setDrift: (value) => {
        drift = value;
      },
      prepare: () => prepareApprovedExternalPostgresAttachment(),
      runAttach: () => attachApprovedExternalPostgres(attachment),
      cleanup: () => cleanupApprovedExternalPostgresAttachment(attachment),
    };
  }

  try {
    const detached = await exercise("success", { prepare: true });
    assert.equal(detached.attachment.baselineAttached, false);
    detached.runAttach();
    detached.cleanup();
    assert.equal(detached.attached, false);
    assert.deepEqual(
      detached.calls
        .filter((args) => args[0] === "network")
        .map((args) => args[1]),
      ["connect", "disconnect"],
    );
    assert.equal(
      externalRecoveryCleanupSummary({
        databases: { verified: true, removed: [] },
        attachment: detached.attachment,
      }).verified,
      true,
    );

    const baseline = await exercise("success", { baselineAttached: true });
    assert.equal(baseline.attachment.baselineAttached, true);
    baseline.runAttach();
    baseline.cleanup();
    assert.equal(baseline.attached, true);
    assert.equal(
      baseline.calls.some((args) => args[0] === "network"),
      false,
    );
    assert.equal(
      externalRecoveryCleanupSummary({
        databases: { verified: true, removed: [] },
        attachment: baseline.attachment,
      }).verified,
      true,
    );
    assert.deepEqual(
      externalRecoveryCleanupSummary({
        databases: { verified: true, removed: [] },
        attachment: baseline.attachment,
      }).attachment,
      {
        baselineAttached: true,
        attempted: false,
        removed: false,
        routePreserved: true,
      },
    );

    for (const drift of [
      "identity",
      "network",
      "alias",
      "endpoint",
      "extra-endpoint",
      "route",
    ]) {
      const changed = await exercise("success", { baselineAttached: true });
      changed.runAttach();
      changed.setDrift(drift);
      assert.throws(changed.cleanup, undefined, drift);
      assert.equal(changed.attached, true);
      assert.equal(
        changed.calls.some((args) => args[0] === "network"),
        false,
      );
      assert.equal(
        externalRecoveryCleanupSummary({
          databases: { verified: true, removed: [] },
          attachment: changed.attachment,
        }).verified,
        false,
      );
      const beforeAttach = await exercise("success", {
        baselineAttached: true,
      });
      beforeAttach.setDrift(drift);
      assert.throws(beforeAttach.runAttach, undefined, drift);
      assert.equal(
        beforeAttach.calls.some((args) => args[0] === "network"),
        false,
      );
    }
    for (const drift of ["identity", "network", "alias", "extra-endpoint"]) {
      const rejected = await exercise("success", { baselineAttached: true });
      rejected.setDrift(drift);
      assert.throws(rejected.prepare, undefined, drift);
      assert.equal(
        rejected.calls.some((args) => args[0] === "network"),
        false,
      );
    }

    const failed = await exercise("failure-after-foreign-attach");
    assert.throws(failed.runAttach, /connect outcome unknown/u);
    assert.equal(failed.attachment.attached, false);
    assert.throws(failed.cleanup);
    assert.equal(failed.attached, true, "foreign attachment must be retained");
    const failedSummary = externalRecoveryCleanupSummary({
      databases: { verified: true, removed: [] },
      attachment: failed.attachment,
    });
    assert.equal(failedSummary.attachment.removed, false);
    assert.equal(failedSummary.verified, false);
    assert.equal(
      failed.calls.some(
        (args) => args[0] === "network" && args[1] === "disconnect",
      ),
      false,
      "a failed connect acknowledgement must never authorize disconnect",
    );

    const wrongRoute = await exercise("wrong-route");
    assert.throws(wrongRoute.runAttach, /original default route/u);
    assert.equal(wrongRoute.attachment.attached, true);
    wrongRoute.cleanup();
    assert.equal(wrongRoute.attached, false);
    assert.equal(wrongRoute.attachment.attached, false);
    assert.equal(wrongRoute.attachment.absenceConfirmed, true);
    const successfulSummary = externalRecoveryCleanupSummary({
      databases: { verified: true, removed: [] },
      attachment: wrongRoute.attachment,
    });
    assert.equal(successfulSummary.attachment.removed, true);
    assert.equal(successfulSummary.verified, true);
    assert.equal(
      wrongRoute.calls.filter(
        (args) => args[0] === "network" && args[1] === "disconnect",
      ).length,
      1,
      "acknowledged attachment is removed after repeated target guards",
    );

    const wrongIdentity = await exercise("success", { badIdentity: true });
    assert.throws(wrongIdentity.runAttach);
    assert.equal(wrongIdentity.attachment.attached, true);
    assert.throws(wrongIdentity.cleanup);
    assert.equal(wrongIdentity.attached, true);
    assert.equal(
      wrongIdentity.calls.some(
        (args) => args[0] === "network" && args[1] === "disconnect",
      ),
      false,
      "identity mismatch must retain the attachment for operator review",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

void test("external PostgreSQL cleanup retains run databases until consumers are confirmed stopped", async (t) => {
  const { cleanupExternalRecoveryDatabases } =
    await import("../../tools/compose-smoke.mjs");
  const owners = ["customer", "catalog", "pricing", "orders", "integration"];
  const databases = owners.map((owner) => ({
    name: `coffee_verify_20261030t120000z_123abcd_${owner}`,
    migratorRole: `coffee_${owner}_migrator`,
  }));
  const resources = databases.map((database) => ({
    database,
    state: "created-acknowledged",
  }));
  const credentials = {
    postgres: {
      host: "coffee_postgres",
      port: 5432,
      systemIdentifier: "7613370342949990434",
    },
    admin: { username: "coffeeuser", password: "fixture-only" },
  };
  const remaining = new Map(
    databases.map((database) => [database.name, database.migratorRole]),
  );
  const queries = [];
  let connections = 0;
  t.mock.method(pg.Client.prototype, "connect", async function () {
    connections += 1;
  });
  t.mock.method(pg.Client.prototype, "end", async function () {});
  t.mock.method(pg.Client.prototype, "query", async function (sql, args) {
    queries.push(sql);
    if (sql.includes("system_identifier"))
      return {
        rows: [
          {
            current_database: "postgres",
            current_user: "coffeeuser",
            server_version: "17.11",
            system_identifier: "7613370342949990434",
            is_superuser: true,
          },
        ],
      };
    if (sql.includes("pg_stat_activity")) return { rows: [] };
    if (sql.includes("pg_get_userbyid"))
      return {
        rows: remaining.has(args[0]) ? [{ owner: remaining.get(args[0]) }] : [],
      };
    const match = /^DROP DATABASE "([a-z0-9_]+)"$/u.exec(sql);
    if (match) {
      assert.ok(remaining.delete(match[1]));
      return { rows: [] };
    }
    throw new Error("unexpected fake PostgreSQL query");
  });
  try {
    for (const stopped of [false, undefined]) {
      const receipt = await cleanupExternalRecoveryDatabases(
        credentials,
        resources,
        stopped,
      );
      assert.deepEqual(receipt, {
        verified: false,
        removed: [],
        retained: databases.map(({ name }) => name),
        failure: "COMPOSE_CONSUMERS_NOT_STOPPED",
      });
    }
    assert.equal(
      connections,
      0,
      "no activity probe or DROP is allowed without consumer cleanup proof",
    );
    assert.deepEqual(queries, []);
    const receipt = await cleanupExternalRecoveryDatabases(
      credentials,
      resources,
      true,
    );
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.removed, databases.map(({ name }) => name).sort());
    assert.deepEqual(receipt.retained, []);
    assert.equal(
      queries.filter((sql) => sql.startsWith("DROP DATABASE")).length,
      5,
    );
    assert.equal(remaining.size, 0);
  } finally {
    t.mock.restoreAll();
  }
});

void test("external PostgreSQL preflight closes admin clients once and never creates on failure", async (t) => {
  const { applyExternalRecoveryMigrations } =
    await import("../../tools/compose-smoke.mjs");
  const owners = ["customer", "catalog", "pricing", "orders", "integration"];
  const databases = owners.map((owner) => ({
    owner,
    name: `coffee_verify_${owner}`,
    migratorRole: `coffee_${owner}_migrator`,
  }));
  const credentials = {
    postgres: {
      host: "coffee_postgres",
      port: 5432,
      systemIdentifier: "7613370342949990434",
    },
    ownership: { databases },
    roleMap: { databases },
    admin: { username: "coffeeuser", password: "fixture-only" },
    launchIdentity: { context: { runId: "fixture-run" } },
  };
  const platformConfig = {
    postgres: { host: "coffee_postgres", port: 5432 },
  };

  async function rejectedPreflight({
    identityError,
    identityMismatch = false,
    targetError,
    existing,
  }) {
    const identityFailure = identityError ?? null;
    const targetFailure = targetError ?? null;
    const calls = { connect: 0, end: 0, queries: [], create: 0 };
    const closeFailure = new Error("fixture close failure");
    t.mock.method(pg.Client.prototype, "connect", async function () {
      calls.connect += 1;
    });
    t.mock.method(pg.Client.prototype, "query", async function (sql) {
      calls.queries.push(sql);
      if (sql.includes("system_identifier")) {
        if (identityFailure) throw identityFailure;
        return {
          rows: [
            {
              current_database: "postgres",
              current_user: "coffeeuser",
              server_version: "17.11",
              system_identifier: identityMismatch
                ? "7613370342949990435"
                : "7613370342949990434",
              is_superuser: true,
            },
          ],
        };
      }
      if (sql.includes("SELECT datname FROM pg_database")) {
        if (targetFailure) throw targetFailure;
        return { rows: existing ? [{ datname: databases[0].name }] : [] };
      }
      if (/^\s*CREATE\s+DATABASE/iu.test(sql)) calls.create += 1;
      throw new Error("unexpected fake PostgreSQL query");
    });
    t.mock.method(pg.Client.prototype, "end", async function () {
      calls.end += 1;
      throw closeFailure;
    });
    let error;
    try {
      await applyExternalRecoveryMigrations(
        credentials,
        platformConfig,
        "/fixture/context.json",
        [],
      );
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error, "preflight is expected to fail");
    assert.equal(calls.end, 1);
    assert.equal(calls.create, 0);
    assert.equal(
      calls.queries.some((sql) => /^\s*CREATE\s+DATABASE/iu.test(sql)),
      false,
    );
    t.mock.restoreAll();
    return { calls, error };
  }

  const identityFailure = new Error("identity query sentinel");
  const identity = await rejectedPreflight({ identityError: identityFailure });
  assert.equal(identity.error, identityFailure);
  assert.equal(identity.calls.connect, 1);

  const mismatchedIdentity = await rejectedPreflight({
    identityMismatch: true,
  });
  assert.match(mismatchedIdentity.error.message, /identity/u);
  assert.equal(mismatchedIdentity.calls.connect, 1);

  const targetFailure = new Error("preflight query sentinel");
  const target = await rejectedPreflight({ targetError: targetFailure });
  assert.equal(target.error, targetFailure);
  assert.equal(target.calls.connect, 1);

  const existing = await rejectedPreflight({ existing: true });
  assert.equal(existing.error.name, "AssertionError");
  assert.equal(existing.calls.connect, 1);

  const { externalRecoveryCleanupSummary } =
    await import("../../tools/compose-smoke.mjs");
  const success = externalRecoveryCleanupSummary({
    databases: { verified: true, removed: databases.map(({ name }) => name) },
    attachment: {
      attempted: true,
      attached: false,
      absenceConfirmed: true,
      routeBefore: "default-route",
      routeAfter: "default-route",
    },
  });
  assert.equal(success.verified, true);
  assert.equal(success.attachment.removed, true);
  const failedCleanup = externalRecoveryCleanupSummary({
    databases: { verified: true, removed: databases.map(({ name }) => name) },
    attachment: {
      attempted: true,
      attached: true,
      routeBefore: "default-route",
      routeAfter: "default-route",
    },
  });
  assert.equal(failedCleanup.verified, false);
  assert.equal(failedCleanup.failure, "POSTGRES_ATTACHMENT_RETAINED");
});

void test("external recovery projection accepts canonical mapping once and rejects re-projection", async () => {
  const { projectRecoveryPlatformConfig } =
    await import("../../tools/compose-smoke.mjs");
  const { load: parseYaml } = await import("js-yaml");
  const { projectLaunchDatabaseTargets } =
    await import("../../scripts/db-bootstrap.mjs");
  const config = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
  );
  const ownership = JSON.parse(
    await readFile(join(REPO_ROOT, "config/database-ownership.json"), "utf8"),
  );
  const roleMap = JSON.parse(
    await readFile(join(REPO_ROOT, "config/database-role-map.json"), "utf8"),
  );
  const launchIdentity = {
    schemaVersion: 1,
    runId: "20261024T120000Z-a12bc34",
    candidateSha: `a12bc34${"0".repeat(33)}`,
    baseConfigSha256: "a".repeat(64),
  };
  const projected = projectLaunchDatabaseTargets({
    ownership,
    roleMap,
    launchIdentity,
  });
  const result = projectRecoveryPlatformConfig(config, projected.ownership);
  assert.equal(
    result.services["orders-service"].database,
    "coffee_verify_20261024t120000z_a12bc34_orders",
  );
  assert.equal(
    config.services["orders-service"].database,
    "coffee_platform_orders",
  );
  assert.throws(
    () => projectRecoveryPlatformConfig(result, projected.ownership),
    /canonical platform config database differs/u,
  );
});

void test("catalog slice preserves secret ownership and uses host identity and supplied image pins", async (t) => {
  const source = await readFile(
    join(REPO_ROOT, ".cursor/skills/catalog-slice-verify/run.mjs"),
    "utf8",
  );
  const compose = runInNewContext(
    source.slice(
      source.indexOf("function composeFile("),
      source.indexOf("async function loadConfig("),
    ) + "\ncomposeFile;",
    { RUNTIME_UID: 23456, RUNTIME_GID: 34567, join },
  );
  const toolchain = JSON.parse(
    await readFile(join(REPO_ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  const yaml = compose({
    project: "catalog-test",
    runId: "test",
    root: REPO_ROOT,
    port: 18510,
    database: "catalog_test",
    passwordFile: "/dev/shm/password",
    secretsFile: "/dev/shm/catalog",
    postgresImage: toolchain.postgresImage,
    nodeImage: toolchain.nodeBookwormSlimImage,
    kafkaImage: toolchain.kafkaImage,
  });
  assert.ok(yaml.includes('user: "23456:34567"'));
  for (const image of [
    toolchain.postgresImage,
    toolchain.nodeBookwormSlimImage,
    toolchain.kafkaImage,
  ]) {
    assert.ok(yaml.includes(`image: ${image}`));
  }
  const directory = await mkdtemp(join(tmpdir(), "catalog-secret-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "secret");
  await writeFile(path, "fixture", { mode: 0o600 });
  const before = await stat(path);
  const ownRuntimeSecret = runInNewContext(
    source.slice(
      source.indexOf("async function ownRuntimeSecret("),
      source.indexOf("async function ensureImage("),
    ) + "\nownRuntimeSecret;",
    {
      chmod,
      stat,
      assert: assert.ok,
      RUNTIME_UID: before.uid,
      RUNTIME_GID: before.gid,
    },
  );
  await ownRuntimeSecret(path);
  const after = await stat(path);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  assert.equal(after.mode & 0o777, 0o400);
});

void test("G14 provider boundary rejects enabled mutations and non-isolated fixture", async () => {
  const { validateG14ProviderBoundary } =
    await import("../../tools/compose-smoke.mjs");
  const projectName = "coffee-g14";
  const networkName = `${projectName}_coffee_provider_egress`;
  const network = {
    Name: networkName,
    Id: "b".repeat(64),
    Internal: true,
    Labels: {
      "com.docker.compose.project": projectName,
      "com.docker.compose.network": "coffee_provider_egress",
    },
  };
  const container = (service, networks) => ({
    Id: "a".repeat(64),
    State: { Running: true },
    Config: {
      Labels: {
        "com.docker.compose.project": projectName,
        "com.docker.compose.service": service,
      },
    },
    NetworkSettings: { Networks: networks },
  });
  const fixture = container("aroma-provider-fixture", {
    [networkName]: { NetworkID: network.Id, Aliases: ["aromateacoffee.ru"] },
  });
  fixture.Image = `sha256:${"d".repeat(64)}`;
  fixture.Config.Image =
    "node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146";
  fixture.Config.Cmd = ["node", "/run/aroma-proof/provider-server.mjs"];
  fixture.Mounts = [
    {
      Type: "bind",
      Source: "/dev/shm/fixture",
      Destination: "/run/aroma-proof",
    },
  ];
  const internalNetworks = ["coffee_internal_api", "coffee_postgres_data"].map(
    (name, index) => ({
      Name: `${projectName}_${name}`,
      Id: String(index).repeat(64),
      Internal: true,
      Labels: {
        "com.docker.compose.project": projectName,
        "com.docker.compose.network": name,
      },
    }),
  );
  const gateway = container("aroma-gateway", {
    [networkName]: { NetworkID: network.Id },
    ...Object.fromEntries(
      internalNetworks.map((item) => [item.Name, { NetworkID: item.Id }]),
    ),
  });
  const input = {
    projectName,
    expectedConfigSha256: "c".repeat(64),
    mounted: { sha256: "c".repeat(64), mutationsEnabled: false },
    gateway,
    fixture,
    network,
    internalNetworks,
    fixtureImageId: fixture.Image,
    fixtureDirectory: "/dev/shm/fixture",
  };
  assert.equal(validateG14ProviderBoundary(input).providerIsolated, true);
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      mounted: { ...input.mounted, mutationsEnabled: true },
    }),
  );
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      mounted: { ...input.mounted, sha256: "d".repeat(64) },
    }),
  );
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      network: { ...network, Internal: false },
    }),
  );
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      fixtureImageId: `sha256:${"e".repeat(64)}`,
    }),
  );
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      internalNetworks: [
        { ...internalNetworks[0], Internal: false },
        internalNetworks[1],
      ],
    }),
  );
  assert.throws(() =>
    validateG14ProviderBoundary({
      ...input,
      fixture: {
        ...fixture,
        NetworkSettings: {
          Networks: { [networkName]: { NetworkID: network.Id, Aliases: [] } },
        },
      },
    }),
  );
});
