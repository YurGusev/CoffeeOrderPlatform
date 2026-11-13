import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { loadPlatformConfig } from "../../scripts/config-lib.mjs";
import {
  materializeCollectorSecrets,
  materializeGrafanaAdminSecret,
  writePrivateSecret,
} from "../config-bootstrap/index.mjs";
import { loadVerifiedGateImage } from "../verified-infrastructure-image.mjs";
import { validateLaunchContext } from "../../verification/launch/v1/report.mjs";
import {
  assertTelemetryNetworks,
  discoverContainerLogs,
  generate,
  verifyBootstrapProbe,
} from "./generate.mjs";
import { provisionStorage } from "./storage.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROJECT = "coffee-platform";
const STORES = ["grafana", "loki", "prometheus", "tempo"];
const SERVICES = [...STORES, "alert-sink", "otel-collector"];
const VOLUMES = Object.fromEntries(
  STORES.map((name) => [name, `coffee-observability-${name}-data`]),
);

const executeDocker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 120000 });
const runDocker = (args) =>
  executeDocker(
    args[0] === "run" ? ["run", "--pull=never", ...args.slice(1)] : args,
  );

export function inspectOwnedTelemetry({ root = ROOT, run = runDocker } = {}) {
  const containers = [];
  const byService = new Map();
  for (const service of SERVICES) {
    const output = String(
      run([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.docker.compose.project=${PROJECT}`,
        "--filter",
        `label=com.docker.compose.service=${service}`,
      ]),
    ).trim();
    const ids = output ? output.split(/\s+/u) : [];
    if (ids.length > 1 || ids.some((id) => !/^[a-f0-9]{64}$/u.test(id)))
      throw new Error(`${service}: ambiguous telemetry container`);
    if (!ids.length) continue;
    const rows = JSON.parse(run(["inspect", ids[0]]));
    const item = rows[0];
    const labels = item?.Config?.Labels;
    if (
      rows.length !== 1 ||
      item?.Id !== ids[0] ||
      labels?.["com.docker.compose.project"] !== PROJECT ||
      labels?.["com.docker.compose.service"] !== service ||
      labels?.["com.docker.compose.project.working_dir"] !== root
    )
      throw new Error(
        `${service}: telemetry container does not belong to this installation`,
      );
    containers.push(ids[0]);
    byService.set(service, ids[0]);
  }
  if (new Set(containers).size !== containers.length)
    throw new Error("telemetry container identity is duplicated");
  const inspectVolume = (name) => {
    let output;
    try {
      output = run(["volume", "inspect", name]);
    } catch (error) {
      if (/no such volume/iu.test(String(error.stderr ?? error.message)))
        return undefined;
      throw error;
    }
    const rows = JSON.parse(output);
    const item = rows[0];
    if (
      rows.length !== 1 ||
      item?.Name !== name ||
      item.Driver !== "local" ||
      item.Labels?.["coffee.owner"] !== "operations" ||
      item.Labels["coffee.lifecycle"] !== "persistent"
    )
      throw new Error(
        `${name}: telemetry volume does not belong to this installation`,
      );
    return item;
  };
  for (const [store, name] of Object.entries(VOLUMES)) {
    const backing = inspectVolume(`${name}-backing`);
    const volume = inspectVolume(name);
    if (volume && !backing)
      throw new Error(`${name}: telemetry backing volume is missing`);
    if (backing && Object.keys(backing.Options ?? {}).length)
      throw new Error(
        `${name}: telemetry backing volume has unexpected options`,
      );
    if (volume) {
      const options = volume.Options ?? {};
      if (
        Object.keys(options).length !== 3 ||
        options.type !== "ext4" ||
        options.o !== "nodev,nosuid,noexec" ||
        !/^\/dev\/loop[0-9]+$/u.test(options.device ?? "")
      )
        throw new Error(`${name}: telemetry volume has unexpected options`);
    }
    const allowed = new Set(
      [byService.get(store), byService.get("otel-collector")].filter(Boolean),
    );
    for (const [item, referencesAllowed] of [
      [backing, new Set()],
      [volume, allowed],
    ]) {
      if (!item) continue;
      const output = String(
        run([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `volume=${item.Name}`,
        ]),
      ).trim();
      const references = output ? output.split(/\s+/u) : [];
      if (
        references.some(
          (id) => !/^[a-f0-9]{64}$/u.test(id) || !referencesAllowed.has(id),
        )
      )
        throw new Error(
          `${item.Name}: telemetry volume has an unrelated container reference`,
        );
    }
  }
  const checkpointName = `${PROJECT}_collector_checkpoints`;
  let checkpoint;
  try {
    checkpoint = JSON.parse(run(["volume", "inspect", checkpointName]));
  } catch (error) {
    if (!/no such volume/iu.test(String(error.stderr ?? error.message)))
      throw error;
  }
  if (checkpoint) {
    const volume = checkpoint[0];
    if (
      checkpoint.length !== 1 ||
      volume?.Name !== checkpointName ||
      volume.Driver !== "local" ||
      volume.Labels?.["com.docker.compose.project"] !== PROJECT ||
      volume.Labels["com.docker.compose.volume"] !== "collector_checkpoints" ||
      Object.keys(volume.Options ?? {}).length
    )
      throw new Error(
        `${checkpointName}: Collector checkpoint volume does not belong to this installation`,
      );
    const output = String(
      run([
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `volume=${checkpointName}`,
      ]),
    ).trim();
    const references = output ? output.split(/\s+/u) : [];
    if (references.some((id) => id !== byService.get("otel-collector")))
      throw new Error(
        `${checkpointName}: checkpoint volume has an unrelated container reference`,
      );
  }
  return containers;
}

export function collectorRefreshOverride(generated, existing, networks) {
  const stable = (collector) => {
    const copy = structuredClone(collector);
    const configMount = copy.volumes.filter(
      (mount) => mount.target === "/etc/alloy/config.alloy",
    );
    if (
      configMount.length !== 1 ||
      configMount[0].type !== "bind" ||
      configMount[0].read_only !== true
    )
      throw new Error("Collector configuration mount is invalid");
    configMount[0].source = "<scoped-collector-config>";
    copy.volumes = copy.volumes.filter(
      (mount) =>
        !/^\/var\/lib\/docker\/containers\/[a-f0-9]{64}$/u.test(
          mount.target ?? "",
        ),
    );
    if (
      !isDeepStrictEqual(copy.networks, ["coffee_observability"]) &&
      !isDeepStrictEqual(copy.networks, networks)
    )
      throw new Error("Collector networks are invalid");
    delete copy.networks;
    return copy;
  };
  if (
    !isDeepStrictEqual(
      stable(existing.services["otel-collector"]),
      stable(generated.services["otel-collector"]),
    )
  )
    throw new Error(
      "Collector specification differs from the accepted release",
    );
  return generated;
}

export async function readAcceptedCollector({
  generator,
  verified,
  contextFile,
}) {
  if (generator.COLLECTOR_RECEIPT_REQUIRED === undefined) return null;
  if (generator.COLLECTOR_RECEIPT_REQUIRED !== true)
    throw new Error("invalid accepted Collector receipt contract");
  return verified({ target: "otel-collector", contextFile, loadImage: false });
}

export async function readAcceptedObservabilityRelease() {
  const unit = (property) =>
    execFileSync(
      "systemctl",
      [
        "--user",
        "show",
        "coffee-observability.service",
        `--property=${property}`,
        "--value",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    ).trim();
  const root = unit("WorkingDirectory");
  const match = unit("Environment").match(
    /(?:^|\s)COFFEE_LAUNCH_CONTEXT_FILE=([^\s]+)(?=\s|$)/u,
  );
  if (
    !root ||
    resolve(root) !== root ||
    (await realpath(root)) !== root ||
    !match
  )
    throw new Error("accepted observability release is unavailable");
  const releases = join(
    homedir(),
    ".local/share/coffee-platform/observability/releases",
  );
  const releaseSha = root.slice(releases.length + 1);
  const rootInfo = await lstat(root);
  if (
    dirname(root) !== releases ||
    !/^[0-9a-f]{40}$/u.test(releaseSha) ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    rootInfo.uid !== process.getuid() ||
    (rootInfo.mode & 0o022) !== 0
  )
    throw new Error("observability release ownership is invalid");
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  if (
    git(["rev-parse", "HEAD"]) !== releaseSha ||
    git(["status", "--porcelain", "--untracked-files=all"])
  )
    throw new Error("observability source identity is not clean");
  const old = async (path) => import(pathToFileURL(join(root, path)).href);
  const { validateLaunchContext: validate } = await old(
    "verification/launch/v1/report.mjs",
  );
  const active = await validate(match[1]);
  if (active.candidateRoot !== root)
    throw new Error("observability context does not bind its release");
  if (active.context.candidateSha !== releaseSha)
    throw new Error("observability context source differs");
  const { loadVerifiedGateImage: verified } = await old(
    "tools/verified-infrastructure-image.mjs",
  );
  const generator = await old("tools/observability/generate.mjs");
  const [helper, grafana, collector] = await Promise.all([
    verified({
      target: "storage-helper",
      contextFile: match[1],
      loadImage: false,
    }),
    verified({ target: "grafana", contextFile: match[1], loadImage: false }),
    readAcceptedCollector({ generator, verified, contextFile: match[1] }),
  ]);
  const { loadPlatformConfig: loadConfig } = await old(
    "scripts/config-lib.mjs",
  );
  const config = await loadConfig(root);
  const refs = JSON.parse(
    await readFile(join(root, "config/toolchain-versions.json"), "utf8"),
  );
  await generator.verifyBootstrapProbe({
    expectedSha256: refs.bootstrapProbeSha256,
  });
  return { root, helper, grafana, collector, generator, config, refs };
}

/** Refresh only the accepted observability release's Collector log mounts. */
export async function refreshLocalCollector({ expectedRuntimes } = {}) {
  const { root, helper, grafana, collector, generator, config, refs } =
    await readAcceptedObservabilityRelease();
  if (
    !collector &&
    !/@sha256:[a-f0-9]{64}$/u.test(refs.otelCollectorImage ?? "")
  )
    throw new Error("accepted Collector image pin is invalid");
  const images = JSON.parse(
    runDocker([
      "image",
      "inspect",
      collector?.imageId ?? refs.otelCollectorImage,
    ]),
  );
  if (
    images.length !== 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(images[0]?.Id ?? "") ||
    (collector && images[0].Id !== collector.imageId)
  )
    throw new Error("Collector image is unavailable");
  const snapshot = () => {
    const ids = inspectOwnedTelemetry({ root, run: runDocker });
    if (ids.length !== SERVICES.length)
      throw new Error("observability containers are incomplete");
    const rows = ids.map((id) => JSON.parse(runDocker(["inspect", id]))[0]);
    const entries = Object.fromEntries(
      rows.map((row) => [
        row.Config.Labels["com.docker.compose.service"],
        { id: row.Id, image: row.Image },
      ]),
    );
    const volumes = JSON.parse(
      runDocker([
        "volume",
        "inspect",
        ...Object.values(VOLUMES),
        ...Object.values(VOLUMES).map((name) => `${name}-backing`),
        `${PROJECT}_collector_checkpoints`,
      ]),
    );
    return {
      entries,
      volumes,
      collectorMounts: rows.find(
        (row) =>
          row.Config.Labels["com.docker.compose.service"] === "otel-collector",
      )?.Mounts,
    };
  };
  const before = snapshot();
  if (before.entries["otel-collector"]?.image !== images[0].Id)
    throw new Error("Collector image identity differs");
  const logs = await generator.discoverContainerLogs({
    projectName: PROJECT,
    runDocker,
  });
  if (
    logs.length !== expectedRuntimes.length ||
    logs.some(
      ({ service, containerId }) =>
        !expectedRuntimes.some(
          (entry) =>
            entry.service === service && entry.containerId === containerId,
        ),
    )
  )
    throw new Error("runtime log sources differ from the verified containers");
  generator.assertTelemetryNetworks({
    projectName: PROJECT,
    logFiles: logs,
    runDocker,
  });
  const dir = "/dev/shm/coffee-platform-observability";
  const directory = await lstat(dir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700 ||
    (await realpath(dir)) !== dir ||
    (await statfs(dir)).type !== 0x01021994
  )
    throw new Error("observability scope is invalid");
  for (const path of [
    join(dir, "compose.override.yaml"),
    "/dev/shm/coffee-platform-observability-secrets/collector.json",
  ]) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o777) !== 0o400
    )
      throw new Error("observability scoped input is invalid");
  }
  const configPath = join(dir, "collector-runtime.alloy");
  const overridePath = join(dir, "collector-runtime.override.yaml");
  const secrets = JSON.parse(
    await readFile(
      "/dev/shm/coffee-platform-observability-secrets/collector.json",
      "utf8",
    ),
  );
  const existing = loadYaml(
    await readFile(join(dir, "compose.override.yaml"), "utf8"),
  );
  const backendConfigPaths = Object.fromEntries(
    ["datasources", "alerts", "contacts", "loki", "prometheus", "tempo"].map(
      (name) => [
        name,
        join(
          dir,
          `${name === "alerts" || name === "contacts" ? `grafana-${name}` : name}.yaml`,
        ),
      ],
    ),
  );
  const generated = generator.createComposeOverride({
    config,
    imageRefs: refs,
    otelCollectorImage: collector?.imageId,
    grafanaImage: grafana.imageId,
    alertSinkImage: helper.imageId,
    logFiles: logs,
    collectorConfigPath: configPath,
    storageVolumes: VOLUMES,
    backendConfigPaths,
    grafanaAdminSecretPath:
      "/dev/shm/coffee-platform-grafana-bootstrap/admin-secret",
    alertSinkPath: join(root, "tools/observability/alert-sink.mjs"),
  });
  for (const name of SERVICES) generated.services[name].restart = "on-failure";
  const override = collectorRefreshOverride(
    generated,
    existing,
    generator.TELEMETRY_NETWORKS,
  );
  await writePrivateSecret(
    configPath,
    generator.createAlloyConfig({ config, logFiles: logs, ...secrets }),
  );
  generator.ensureCollectorConfigOwnership({
    collectorConfigPath: configPath,
    nodeImage: helper.imageId,
    runDocker,
  });
  await writePrivateSecret(
    overridePath,
    dumpYaml(override, { noRefs: true, lineWidth: 120 }),
  );
  runDocker([
    "compose",
    "--project-name",
    PROJECT,
    "--project-directory",
    root,
    "--file",
    join(root, "compose.yaml"),
    "--file",
    overridePath,
    "up",
    "--remove-orphans=false",
    "--no-deps",
    "--force-recreate",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    String(
      Math.ceil(
        (config.platform.health.startupGraceMs +
          config.platform.health.intervalMs *
            config.platform.health.failureThreshold +
          config.platform.shutdownGraceMs) /
          1000,
      ),
    ),
    "otel-collector",
  ]);
  const after = snapshot();
  const mounted = (destination, predicate) => {
    const matches = after.collectorMounts.filter(
      (mount) => mount.Destination === destination,
    );
    return matches.length === 1 && predicate(matches[0]);
  };
  if (
    after.entries["otel-collector"]?.image !== images[0].Id ||
    SERVICES.filter((name) => name !== "otel-collector").some(
      (name) =>
        JSON.stringify(before.entries[name]) !==
        JSON.stringify(after.entries[name]),
    ) ||
    JSON.stringify(before.volumes) !== JSON.stringify(after.volumes) ||
    !mounted(
      "/var/lib/alloy",
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === `${PROJECT}_collector_checkpoints`,
    ) ||
    !mounted(
      "/etc/alloy/config.alloy",
      (mount) =>
        mount.Type === "bind" &&
        mount.Source === configPath &&
        mount.RW === false,
    ) ||
    Object.entries(VOLUMES).some(
      ([name, volume]) =>
        !mounted(
          `/telemetry-storage/${name}`,
          (mount) =>
            mount.Type === "volume" &&
            mount.Name === volume &&
            mount.RW === false,
        ),
    ) ||
    logs.some(
      ({ containerId, logPath }) =>
        !mounted(
          `/var/lib/docker/containers/${containerId}`,
          (mount) =>
            mount.Type === "bind" &&
            mount.Source === dirname(logPath) &&
            mount.RW === false,
        ),
    )
  )
    throw new Error("observability identity changed during Collector refresh");
}

export async function runService(action, overrides = {}) {
  const deps = {
    validateLaunchContext,
    realpath,
    loadPlatformConfig,
    readFile,
    verifyBootstrapProbe,
    loadVerifiedGateImage,
    statfs,
    discoverContainerLogs,
    assertTelemetryNetworks,
    inspectOwnedTelemetry,
    materializeCollectorSecrets,
    materializeGrafanaAdminSecret,
    provisionStorage,
    generate,
    executeDocker,
    ...overrides,
  };
  const runDocker = (args) =>
    deps.executeDocker(
      args[0] === "run" ? ["run", "--pull=never", ...args.slice(1)] : args,
    );
  if (!["start", "stop"].includes(action))
    throw new Error("usage: node tools/observability/service.mjs start|stop");
  const contextFile = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (!contextFile) throw new Error("COFFEE_LAUNCH_CONTEXT_FILE is required");
  const active = await deps.validateLaunchContext(contextFile);
  if (active.candidateRoot !== (await deps.realpath(ROOT)))
    throw new Error(
      "supply_chain candidate checkout does not match this installation",
    );
  const config = await deps.loadPlatformConfig(ROOT);
  const imageRefs = JSON.parse(
    await deps.readFile(join(ROOT, "config/toolchain-versions.json"), "utf8"),
  );
  if (process.versions.node !== imageRefs.node)
    throw new Error("Node version does not match the toolchain pin");
  await deps.verifyBootstrapProbe({
    expectedSha256: imageRefs.bootstrapProbeSha256,
  });
  const storageHelper = await deps.loadVerifiedGateImage({
    target: "storage-helper",
    contextFile,
    loadImage: false,
  });
  const grafana = await deps.loadVerifiedGateImage({
    target: "grafana",
    contextFile,
    loadImage: false,
  });
  const collector = await deps.loadVerifiedGateImage({
    target: "otel-collector",
    contextFile,
    loadImage: false,
  });
  if (action === "start") {
    const fs = await deps.statfs("/", { bigint: true });
    if (fs.bavail * fs.bsize < (fs.blocks * fs.bsize) / 5n + 536870912n)
      throw new Error("insufficient root filesystem reserve");
    for (const reference of [
      storageHelper.imageId,
      grafana.imageId,
      collector.imageId,
      imageRefs.lokiImage,
      imageRefs.prometheusImage,
      imageRefs.tempoImage,
    ]) {
      const images = JSON.parse(runDocker(["image", "inspect", reference]));
      if (
        images.length !== 1 ||
        !/^sha256:[a-f0-9]{64}$/u.test(images[0]?.Id ?? "") ||
        (reference.startsWith("sha256:") && images[0].Id !== reference)
      )
        throw new Error("required verified telemetry image is unavailable");
    }
  }
  const knownLogs =
    action === "start"
      ? await deps.discoverContainerLogs({
          projectName: PROJECT,
          allowMissing: true,
          runDocker,
        })
      : [];
  if (action === "start")
    deps.assertTelemetryNetworks({
      projectName: PROJECT,
      logFiles: knownLogs,
      runDocker,
    });
  const ids = deps.inspectOwnedTelemetry({ run: runDocker });
  if (action === "start") {
    const bootstrapEnv = { ...process.env };
    delete bootstrapEnv.COFFEE_LAUNCH_CONTEXT_FILE;
    if (
      bootstrapEnv.COFFEE_CONFIG_FILE &&
      resolve(bootstrapEnv.COFFEE_CONFIG_FILE) !==
        join(ROOT, "config/platform.yaml")
    )
      throw new Error(
        "config-bootstrap must use this installation’s canonical platform.yaml",
      );
    await deps.materializeCollectorSecrets({ root: ROOT, env: bootstrapEnv });
    await deps.materializeGrafanaAdminSecret({ root: ROOT, env: bootstrapEnv });
  }
  if (ids.length) {
    runDocker([
      "stop",
      "--time",
      String(Math.ceil(config.platform.shutdownGraceMs / 1000)),
      ...ids,
    ]);
    runDocker(["rm", ...ids]);
  }
  if (action === "stop") return;
  for (const name of STORES)
    deps.provisionStorage({
      name: VOLUMES[name],
      maxDiskBytes: config.telemetry[name].maxDiskBytes,
      storageHelperImage: storageHelper.imageId,
      run: runDocker,
    });
  const generated = await deps.generate({
    root: ROOT,
    projectName: PROJECT,
    storageVolumes: VOLUMES,
    runDocker: deps.executeDocker,
  });
  const compose = [
    "compose",
    "--project-name",
    PROJECT,
    "--project-directory",
    ROOT,
    "--file",
    join(ROOT, "compose.yaml"),
    "--file",
    generated.composeOverridePath,
  ];
  const waitSeconds = Math.ceil(
    (config.platform.health.startupGraceMs +
      config.platform.health.intervalMs *
        config.platform.health.failureThreshold +
      config.platform.shutdownGraceMs) /
      1000,
  );
  runDocker([
    ...compose,
    "up",
    "--remove-orphans=false",
    "--no-deps",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    String(waitSeconds),
    ...STORES,
    "alert-sink",
  ]);
  runDocker([
    ...compose,
    "up",
    "--remove-orphans=false",
    "--no-deps",
    "--no-build",
    "--pull",
    "never",
    "--wait",
    "--wait-timeout",
    String(waitSeconds),
    "otel-collector",
  ]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.length !== 3)
      throw new Error("usage: node tools/observability/service.mjs start|stop");
    await runService(process.argv[2]);
    console.log(`observability ${process.argv[2]}: complete`);
  } catch (error) {
    console.error(`observability lifecycle: ${error.message}`);
    process.exitCode = 1;
  }
}
