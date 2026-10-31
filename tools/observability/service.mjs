import { execFileSync } from "node:child_process";
import { readFile, realpath, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlatformConfig } from "../../scripts/config-lib.mjs";
import {
  materializeCollectorSecrets,
  materializeGrafanaAdminSecret,
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
    throw new Error("G12 candidate checkout does not match this installation");
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
  if (action === "start") {
    const fs = await deps.statfs("/", { bigint: true });
    if (fs.bavail * fs.bsize < (fs.blocks * fs.bsize) / 5n + 536870912n)
      throw new Error("insufficient root filesystem reserve");
    for (const reference of [
      storageHelper.imageId,
      grafana.imageId,
      imageRefs.otelCollectorImage,
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
