#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const NETWORK = "coffee_platform_build_mtu";
const BUILDER = "coffee-platform-mtu";
const DEFAULT_MTU = 1280;

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function detectedMtu() {
  try {
    const address = output("getent", ["ahostsv4", "deb.debian.org"])
      .split("\n")[0]
      .trim()
      .split(/\s+/)[0];
    const route = output("ip", ["route", "get", address]);
    const device = route.match(/\bdev\s+(\S+)/)?.[1];
    if (!device) return DEFAULT_MTU;
    const mtu = Number(output("cat", [`/sys/class/net/${device}/mtu`]));
    return Number.isInteger(mtu) && mtu >= 1280 ? mtu : DEFAULT_MTU;
  } catch {
    return DEFAULT_MTU;
  }
}

function ensureNetwork(mtu) {
  const inspect = spawnSync("docker", ["network", "inspect", NETWORK], {
    encoding: "utf8",
  });
  if (inspect.status !== 0) {
    execFileSync(
      "docker",
      [
        "network",
        "create",
        "--driver",
        "bridge",
        "--opt",
        `com.docker.network.driver.mtu=${mtu}`,
        NETWORK,
      ],
      { stdio: "inherit" },
    );
    return;
  }
  const current = JSON.parse(inspect.stdout)[0]?.Options?.[
    "com.docker.network.driver.mtu"
  ];
  if (current !== String(mtu)) {
    throw new Error(
      `Docker network ${NETWORK} has MTU ${current ?? "unknown"}, expected ${mtu}. ` +
        "Remove it only after stopping attached project builders.",
    );
  }
}

function ensureBuilder() {
  const inspect = spawnSync("docker", ["buildx", "inspect", BUILDER], {
    stdio: "ignore",
  });
  if (inspect.status !== 0) {
    execFileSync(
      "docker",
      [
        "buildx",
        "create",
        "--name",
        BUILDER,
        "--driver",
        "docker-container",
        "--driver-opt",
        `network=${NETWORK}`,
      ],
      { stdio: "inherit" },
    );
  }
  execFileSync("docker", ["buildx", "inspect", BUILDER, "--bootstrap"], {
    stdio: "inherit",
  });
}

const mtu = detectedMtu();
ensureNetwork(mtu);
ensureBuilder();

const extraArgs = process.argv.slice(2);
const args = [
  "buildx",
  "build",
  "--builder",
  BUILDER,
  "--allow",
  "network.host",
  ...extraArgs,
];
const result = spawnSync("docker", args, { stdio: "inherit" });
process.exitCode = result.status ?? 1;
