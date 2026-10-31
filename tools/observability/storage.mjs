import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  lstatSync,
  realpathSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { loadPlatformConfig } from "../../scripts/config-lib.mjs";
import { loadVerifiedGateImage } from "../verified-infrastructure-image.mjs";

// Operations создаёт отдельную файловую систему: telemetry не может заполнить business disk.
export function provisionStorage({
  name,
  maxDiskBytes,
  storageHelperImage,
  backingDirectory,
  run = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
}) {
  if (
    !/^coffee-[a-z0-9-]+$/u.test(name) ||
    !Number.isSafeInteger(maxDiskBytes) ||
    maxDiskBytes < 268435456 ||
    !/^sha256:[0-9a-f]{64}$/u.test(storageHelperImage)
  )
    throw new Error("Invalid bounded telemetry storage specification");
  const backingVolume = `${name}-backing`;
  const lifecycle =
    /^coffee-observability-[a-f0-9-]{36}-(?:grafana|loki|prometheus|tempo)-data$/u.test(
      name,
    )
      ? "fixture"
      : "persistent";
  let directoryIdentity, parentIdentity;
  if (backingDirectory !== undefined) {
    if (
      lifecycle !== "fixture" ||
      !isAbsolute(backingDirectory) ||
      basename(backingDirectory) !== name ||
      !/^coffee-observability-[a-f0-9-]{36}-storage-[A-Za-z0-9]{6}$/u.test(
        basename(dirname(backingDirectory)),
      ) ||
      realpathSync(backingDirectory) !== backingDirectory
    )
      throw new Error("Invalid fixture backing directory");
    const parent = lstatSync(dirname(backingDirectory));
    const directory = lstatSync(backingDirectory);
    if (
      ![parent, directory].every(
        (item) =>
          item.isDirectory() &&
          !item.isSymbolicLink() &&
          item.uid === process.getuid() &&
          (item.mode & 0o777) === 0o700,
      ) ||
      readdirSync(backingDirectory).length !== 0
    )
      throw new Error("Fixture backing directory must be private and empty");
    directoryIdentity = { dev: directory.dev, ino: directory.ino };
    parentIdentity = { dev: parent.dev, ino: parent.ino };
  }
  const owned = (volume) => {
    let info;
    try {
      info = JSON.parse(run(["volume", "inspect", volume]))[0];
    } catch (error) {
      if (/no such volume/iu.test(String(error.stderr ?? error.message)))
        return undefined;
      throw error;
    }
    if (
      info?.Labels?.["coffee.owner"] !== "operations" ||
      info.Labels["coffee.lifecycle"] !== lifecycle
    )
      throw new Error("Refusing to reuse unrelated telemetry volume");
    return info;
  };
  const backing = owned(backingVolume);
  if (
    backing &&
    (backing.Driver !== "local" ||
      (backing.Options && Object.keys(backing.Options).length > 0))
  )
    throw new Error(
      "Existing telemetry backing volume has different storage options",
    );
  const previous = owned(name);
  if (backingDirectory !== undefined && (backing || previous))
    throw new Error("Refusing to reuse a fixture backing directory or volume");
  if (previous && !backing)
    throw new Error("Existing telemetry volume is missing its backing volume");
  if (previous) {
    const options = previous.Options ?? {};
    if (
      previous.Driver !== "local" ||
      options.type !== "ext4" ||
      options.o !== "nodev,nosuid,noexec" ||
      !/^\/dev\/loop[0-9]+$/u.test(options.device ?? "") ||
      Object.keys(options).length !== 3
    )
      throw new Error(
        "Existing telemetry volume has different storage backing",
      );
    if (
      run([
        "ps",
        "--all",
        "--filter",
        `volume=${name}`,
        "--format",
        "{{.ID}}",
      ]).trim()
    )
      throw new Error("Cannot rebind an active telemetry volume");
  }
  run([
    "volume",
    "create",
    "--label",
    "coffee.owner=operations",
    "--label",
    `coffee.lifecycle=${lifecycle}`,
    ...(backingDirectory === undefined
      ? []
      : [
          "--driver",
          "local",
          "--opt",
          "type=none",
          "--opt",
          "o=bind",
          "--opt",
          `device=${backingDirectory}`,
        ]),
    backingVolume,
  ]);
  let device, attached, fileIdentity;
  try {
    const attachment = JSON.parse(
      run([
        "run",
        "--rm",
        "--privileged",
        "--network",
        "none",
        "--mount",
        `type=volume,source=${backingVolume},target=/storage`,
        storageHelperImage,
        "sh",
        "-ceu",
        `
    if [ -L /storage/telemetry.ext4 ]; then exit 1; fi
    if [ -e /storage/telemetry.ext4 ]; then
      test -f /storage/telemetry.ext4
      test "$(stat -c %s /storage/telemetry.ext4)" = "$1"
      test "$(blkid -p -s TYPE -o value /storage/telemetry.ext4)" = ext4
    else
      test "$2" = false
      truncate -s "$1" /storage/telemetry.ext4
      mkfs.ext4 -q -m 0 /storage/telemetry.ext4
    fi
    existing=$(losetup -j /storage/telemetry.ext4 | cut -d : -f 1)
    if [ -n "$existing" ]; then printf '{"device":"%s","attached":false}' "$existing"; else
      candidate=$(losetup --find)
      case "$candidate" in *' (lost)') candidate="\${candidate% (lost)}" ;; esac
      case "$candidate" in /dev/loop*) minor="\${candidate#/dev/loop}" ;; *) exit 1 ;; esac
      case "$minor" in ''|*[!0-9]*) exit 1 ;; esac
      device="/dev/loop$minor"
      test "$(cat "/sys/block/loop$minor/dev")" = "7:$minor"
      test ! -L "$device"
      test -b "$device" || mknod "$device" b 7 "$minor"
      test -b "$device"
      test "$(stat -c %t:%T "$device")" = "$(printf '%x:%x' 7 "$minor")"
      losetup "$device" /storage/telemetry.ext4
      printf '{"device":"%s","attached":true}' "$device"
    fi
  `,
        "storage",
        String(maxDiskBytes),
        String(Boolean(previous)),
      ]),
    );
    ({ device, attached } = attachment);
    const validDevice =
      typeof device === "string" && /^\/dev\/loop[0-9]+$/u.test(device);
    if (!validDevice)
      throw new Error("Cannot provision bounded telemetry loop device");
    if (typeof attached !== "boolean")
      throw new Error("Cannot verify telemetry loop attachment");
    if (backingDirectory !== undefined && attached !== true)
      throw new Error("Fixture backing loop is not newly attached");
    if (backingDirectory !== undefined) {
      const file = lstatSync(`${backingDirectory}/telemetry.ext4`);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1)
        throw new Error("Fixture backing file identity invalid");
      fileIdentity = { dev: file.dev, ino: file.ino };
    }
    if (previous && previous.Options.device !== device)
      run(["volume", "rm", name]);
    const volumeLabels = previous?.Labels ?? {
      "coffee.owner": "operations",
      "coffee.lifecycle": lifecycle,
    };
    run([
      "volume",
      "create",
      "--driver",
      "local",
      "--opt",
      "type=ext4",
      "--opt",
      `device=${device}`,
      "--opt",
      "o=nodev,nosuid,noexec",
      ...Object.entries(volumeLabels).flatMap(([key, value]) => [
        "--label",
        `${key}=${value}`,
      ]),
      name,
    ]);
    return {
      volumeName: name,
      backingVolume,
      device,
      maxDiskBytes,
      ...(backingDirectory === undefined
        ? {}
        : { backingDirectory, directoryIdentity, fileIdentity }),
    };
  } catch (error) {
    if (
      attached === true &&
      typeof device === "string" &&
      /^\/dev\/loop[0-9]+$/u.test(device)
    ) {
      try {
        run([
          "run",
          "--rm",
          "--privileged",
          "--network",
          "none",
          "--mount",
          `type=volume,source=${backingVolume},target=/storage`,
          storageHelperImage,
          "sh",
          "-ceu",
          'losetup -j /storage/telemetry.ext4 | cut -d : -f 1 | grep -Fx "$1"; losetup -d "$1"',
          "storage",
          device,
        ]);
        if (backingDirectory !== undefined && fileIdentity) {
          const info = owned(backingVolume);
          const options = info?.Options ?? {};
          const dir = lstatSync(backingDirectory);
          const file = lstatSync(`${backingDirectory}/telemetry.ext4`);
          if (
            info?.Driver !== "local" ||
            Object.keys(options).length !== 3 ||
            options.type !== "none" ||
            options.o !== "bind" ||
            options.device !== backingDirectory ||
            realpathSync(backingDirectory) !== backingDirectory ||
            dir.dev !== directoryIdentity.dev ||
            dir.ino !== directoryIdentity.ino ||
            !file.isFile() ||
            file.isSymbolicLink() ||
            file.nlink !== 1 ||
            file.dev !== fileIdentity.dev ||
            file.ino !== fileIdentity.ino
          )
            throw new Error(
              "Fixture backing identity changed during failure cleanup",
            );
          run(["volume", "rm", backingVolume]);
          unlinkSync(`${backingDirectory}/telemetry.ext4`);
          rmdirSync(backingDirectory);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Telemetry storage provisioning and loop cleanup failed",
        );
      }
    } else if (backingDirectory !== undefined && attached === undefined) {
      try {
        const info = owned(backingVolume);
        const options = info?.Options ?? {};
        const parent = lstatSync(dirname(backingDirectory));
        const dir = lstatSync(backingDirectory);
        const file = lstatSync(`${backingDirectory}/telemetry.ext4`);
        if (
          info?.Driver !== "local" ||
          Object.keys(options).length !== 3 ||
          options.type !== "none" ||
          options.o !== "bind" ||
          options.device !== backingDirectory ||
          owned(name) ||
          run([
            "ps",
            "--all",
            "--filter",
            `volume=${backingVolume}`,
            "--format",
            "{{.ID}}",
          ]).trim() ||
          realpathSync(backingDirectory) !== backingDirectory ||
          parent.dev !== parentIdentity.dev ||
          parent.ino !== parentIdentity.ino ||
          ![parent, dir].every(
            (item) =>
              item.isDirectory() &&
              !item.isSymbolicLink() &&
              item.uid === process.getuid() &&
              (item.mode & 0o777) === 0o700,
          ) ||
          dir.dev !== directoryIdentity.dev ||
          dir.ino !== directoryIdentity.ino ||
          readdirSync(backingDirectory).join("\n") !== "telemetry.ext4" ||
          !file.isFile() ||
          file.isSymbolicLink() ||
          file.nlink !== 1
        )
          throw new Error("Fixture allocation identity is uncertain");
        run([
          "run",
          "--rm",
          "--privileged",
          "--network",
          "none",
          "--read-only",
          "--mount",
          `type=volume,source=${backingVolume},target=/storage,readonly`,
          storageHelperImage,
          "sh",
          "-ceu",
          'test "$(stat -c %d:%i /storage/telemetry.ext4)" = "$1"; associations=$(losetup -j /storage/telemetry.ext4); test -z "$associations"',
          "storage",
          `${file.dev}:${file.ino}`,
        ]);
        const current = lstatSync(`${backingDirectory}/telemetry.ext4`);
        if (
          current.dev !== file.dev ||
          current.ino !== file.ino ||
          !current.isFile() ||
          current.nlink !== 1
        )
          throw new Error("Fixture allocation identity changed during cleanup");
        run(["volume", "rm", backingVolume]);
        unlinkSync(`${backingDirectory}/telemetry.ext4`);
        rmdirSync(backingDirectory);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Telemetry storage provisioning failed; fixture allocation retained",
        );
      }
    }
    throw error;
  }
}

export function removeStorage({
  storage,
  storageHelperImage,
  run = (args) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
}) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(storageHelperImage))
    throw new Error("Invalid verified telemetry storage helper image");
  if (
    !/^coffee-observability-[a-f0-9-]{36}-(?:grafana|loki|prometheus|tempo)-data$/u.test(
      storage.volumeName,
    ) ||
    storage.backingVolume !== `${storage.volumeName}-backing` ||
    !/^\/dev\/loop[0-9]+$/u.test(storage.device)
  )
    throw new Error("Cleanup is restricted to disposable G14 storage");
  if (storage.backingDirectory !== undefined) {
    const path = storage.backingDirectory;
    if (
      !isAbsolute(path) ||
      basename(path) !== storage.volumeName ||
      realpathSync(path) !== path ||
      !/^coffee-observability-[a-f0-9-]{36}-storage-[A-Za-z0-9]{6}$/u.test(
        basename(dirname(path)),
      )
    )
      throw new Error("Invalid fixture backing directory");
    const parent = lstatSync(dirname(path));
    const dir = lstatSync(path);
    const file = lstatSync(`${path}/telemetry.ext4`);
    if (
      ![parent, dir].every(
        (item) =>
          item.isDirectory() &&
          !item.isSymbolicLink() &&
          item.uid === process.getuid() &&
          (item.mode & 0o777) === 0o700,
      ) ||
      dir.dev !== storage.directoryIdentity?.dev ||
      dir.ino !== storage.directoryIdentity?.ino ||
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      file.dev !== storage.fileIdentity?.dev ||
      file.ino !== storage.fileIdentity?.ino
    )
      throw new Error("Fixture backing path identity changed");
  }
  for (const volume of [storage.volumeName, storage.backingVolume]) {
    const info = JSON.parse(run(["volume", "inspect", volume]))[0];
    if (
      info?.Labels?.["coffee.owner"] !== "operations" ||
      info.Labels["coffee.lifecycle"] !== "fixture"
    )
      throw new Error("Refusing to remove unrelated telemetry volume");
    if (storage.backingDirectory !== undefined) {
      const options = info.Options ?? {};
      const expected =
        volume === storage.backingVolume
          ? { type: "none", o: "bind", device: storage.backingDirectory }
          : { type: "ext4", o: "nodev,nosuid,noexec", device: storage.device };
      if (
        info.Driver !== "local" ||
        Object.keys(options).length !== 3 ||
        Object.keys(expected).some((key) => options[key] !== expected[key])
      )
        throw new Error("Fixture volume storage options changed");
    }
  }
  run(["volume", "rm", storage.volumeName]);
  // Сопоставление backing file проверяется до detach; чужой loop device не трогаем.
  run([
    "run",
    "--rm",
    "--privileged",
    "--network",
    "none",
    "--mount",
    `type=volume,source=${storage.backingVolume},target=/storage`,
    storageHelperImage,
    "sh",
    "-ceu",
    'losetup -j /storage/telemetry.ext4 | cut -d : -f 1 | grep -Fx "$1"; losetup -d "$1"',
    "storage",
    storage.device,
  ]);
  run(["volume", "rm", storage.backingVolume]);
  if (storage.backingDirectory !== undefined) {
    unlinkSync(`${storage.backingDirectory}/telemetry.ext4`);
    rmdirSync(storage.backingDirectory);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--name");
    if (index < 0 || !process.argv[index + 1])
      throw new Error("--name is required");
    const storeIndex = process.argv.indexOf("--store");
    const store = process.argv[storeIndex + 1];
    if (
      storeIndex < 0 ||
      !["grafana", "loki", "prometheus", "tempo"].includes(store)
    )
      throw new Error("--store must be grafana, loki, prometheus or tempo");
    const config = await loadPlatformConfig();
    const image = await loadVerifiedGateImage({ target: "storage-helper" });
    console.log(
      JSON.stringify(
        provisionStorage({
          name: process.argv[index + 1],
          maxDiskBytes: config.telemetry[store].maxDiskBytes,
          storageHelperImage: image.imageId,
        }),
      ),
    );
  } catch (error) {
    console.error(`telemetry storage: ${error.message}`);
    process.exitCode = 1;
  }
}
