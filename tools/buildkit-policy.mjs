export const BUILDKIT_NAME = "coffee-platform-mtu";
export const BUILDKIT_NETWORK = "coffee_platform_build_mtu";

export function buildkitPolicy(config, versions) {
  if (
    !/^moby\/buildkit@sha256:[0-9a-f]{64}$/u.test(versions.buildkitImage ?? "")
  )
    throw new Error(
      "BuildKit image должен быть закреплён immutable digest в toolchain BOM",
    );
  const policy = config.platform.buildkit;
  const workerSettings = [
    "gc = true",
    `max-parallelism = ${policy.maxParallelism}`,
    `reservedSpace = "${policy.reservedSpaceGiB}GiB"`,
    `maxUsedSpace = "${policy.maxUsedSpaceGiB}GiB"`,
    `minFreeSpace = "${policy.minFreeSpaceGiB}GiB"`,
  ];
  const registries = ["auth.docker.io", "docker.io"].map(
    (registry) =>
      `[registry.${JSON.stringify(registry)}]\nca = [${JSON.stringify(policy.registryCaFile)}]`,
  );
  const driverOptions = {
    image: versions.buildkitImage,
    network: BUILDKIT_NETWORK,
    memory: `${policy.memoryMiB}m`,
    "memory-swap": `${policy.memorySwapMiB}m`,
    "cpu-period": "100000",
    "cpu-quota": String(Math.round(policy.cpus * 100_000)),
  };
  return {
    parameters: policy,
    image: versions.buildkitImage,
    workerSettings,
    toml: [...registries, "[worker.oci]", ...workerSettings, ""].join("\n"),
    createArguments: (path) => [
      "buildx",
      "create",
      "--name",
      BUILDKIT_NAME,
      "--node",
      `${BUILDKIT_NAME}0`,
      "--driver",
      "docker-container",
      "--buildkitd-config",
      path,
      "--buildkitd-flags",
      "--allow-insecure-entitlement=network.host",
      ...Object.entries(driverOptions).flatMap(([key, value]) => [
        "--driver-opt",
        `${key}=${value}`,
      ]),
    ],
  };
}

export async function verifyBuildkitPolicy(expected, runDocker) {
  const policy = expected.parameters;
  const { workerSettings } = expected;
  const registration = await runDocker(["buildx", "inspect", BUILDKIT_NAME]);
  if (
    !/^Driver:\s+docker-container$/mu.test(registration) ||
    [...registration.matchAll(/^Name:\s+(\S+)/gmu)]
      .map((match) => match[1])
      .join("\n") !== `${BUILDKIT_NAME}\n${BUILDKIT_NAME}0`
  )
    throw new Error(
      "BuildKit driver/nodes отличаются от управляемого профиля; builder не изменён",
    );
  await runDocker(["buildx", "inspect", BUILDKIT_NAME, "--bootstrap"]);
  const containerName = `buildx_buildkit_${BUILDKIT_NAME}0`;
  const [container] = JSON.parse(await runDocker(["inspect", containerName]));
  const host = container.HostConfig;
  const cpus =
    host.NanoCpus > 0 ? host.NanoCpus / 1e9 : host.CpuQuota / host.CpuPeriod;
  if (
    container.Config.Image !== expected.image ||
    host.NetworkMode !== BUILDKIT_NETWORK ||
    host.Memory !== policy.memoryMiB * 1_048_576 ||
    host.MemorySwap !== policy.memorySwapMiB * 1_048_576 ||
    !(Math.abs(cpus - policy.cpus) <= 0.00001) ||
    !container.Mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === `${containerName}_state` &&
        mount.Destination === "/var/lib/buildkit",
    )
  )
    throw new Error(
      "BuildKit image, сеть, state volume или CPU/RAM отличаются от policy; автоматическое пересоздание запрещено",
    );
  const toml = await runDocker([
    "exec",
    containerName,
    "cat",
    "/etc/buildkit/buildkitd.toml",
  ]);
  // Buildx переписывает порядок полей и кавычки TOML при копировании config.
  const worker = toml
    .split(/(?=^\[)/mu)
    .find((block) => block.startsWith("[worker.oci]\n"));
  const normalize = (lines) =>
    lines
      .map((line) => line.replace(/[\s'"]/gu, ""))
      .filter(Boolean)
      .sort()
      .join("\n");
  if (
    !worker ||
    normalize(worker.split("\n").slice(1)) !== normalize(workerSettings)
  )
    throw new Error(
      "BuildKit OCI GC/parallelism config отличается от policy; builder не изменён",
    );
  const workers = JSON.parse(
    await runDocker([
      "exec",
      containerName,
      "buildctl",
      "debug",
      "workers",
      "--format",
      "{{json .}}",
    ]),
  );
  if (
    workers.length !== 1 ||
    !workers[0].gcPolicy.some(
      (rule) =>
        rule.all &&
        rule.reservedSpace === policy.reservedSpaceGiB * 1_073_741_824 &&
        rule.maxUsedSpace === policy.maxUsedSpaceGiB * 1_073_741_824 &&
        rule.minFreeSpace === policy.minFreeSpaceGiB * 1_073_741_824,
    )
  )
    throw new Error(
      "Effective BuildKit GC отличается от policy; сборка отменена",
    );
}
