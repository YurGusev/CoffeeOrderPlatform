import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  permissionFlags,
  telemetryHostPort,
  validateAllPermissionManifests,
  validatePermissionManifest,
} from "../../scripts/permission-audit.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

void test("all 14 Node permission manifests match the connectivity policy; native nginx and removed web have none", async () => {
  const manifests = await validateAllPermissionManifests(root);
  assert.equal(manifests.length, 14);
  assert.equal(new Set(manifests.map((manifest) => manifest.runtime)).size, 14);
  const databaseRuntimes = new Set([
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
  ]);
  for (const manifest of manifests) {
    assert.ok(
      manifest.allowFsRead.includes("/run/coffee-launch/context.json"),
      `${manifest.runtime} cannot read its launch context`,
    );
    assert.equal(
      manifest.allowFsRead.includes("/app/config/database-ownership.json"),
      databaseRuntimes.has(manifest.runtime),
      `${manifest.runtime} database ownership read permission differs from its DB claim`,
    );
  }
  await assert.rejects(
    access(new URL("../../config/permissions/web.json", import.meta.url)),
    { code: "ENOENT" },
  );
});

void test("enforce flags allow addons only for Kafka runtimes", async () => {
  const manifest = await validatePermissionManifest(root, "api-public");
  assert.deepEqual(permissionFlags(manifest, "enforce", root).slice(0, 2), [
    "--permission",
    "--allow-net",
  ]);
  assert.ok(
    permissionFlags(manifest, "audit", root).includes("--permission-audit"),
  );
  assert.ok(permissionFlags(manifest, "audit", root).includes("--allow-net"));
  const edgeManifest = await validatePermissionManifest(root, "edge-gateway");
  assert.equal(
    permissionFlags(edgeManifest, "enforce", root).includes("--allow-net"),
    false,
  );
  assert.ok(
    permissionFlags(edgeManifest, "enforce", root, "4000").includes(
      "--allow-net",
    ),
  );
  assert.equal(
    permissionFlags(manifest, "enforce", root).some((flag) =>
      flag.startsWith("--allow-child"),
    ),
    false,
  );
  const kafkaManifest = await validatePermissionManifest(
    root,
    "orders-service",
  );
  assert.ok(
    permissionFlags(kafkaManifest, "enforce", root).includes("--allow-addons"),
  );
  const ingest = telemetryHostPort({
    telemetry: { collector: { otlpEndpoint: "http://otel-collector:4318" } },
  });
  const alternateIngest = telemetryHostPort({
    telemetry: { collector: { otlpEndpoint: "http://otel-collector:4319" } },
  });
  assert.equal(alternateIngest, "otel-collector:4319");
  assert.ok(
    permissionFlags(edgeManifest, "enforce", root, undefined, ingest).includes(
      "--allow-net",
    ),
  );
  const telemetryFlags = permissionFlags(
    manifest,
    "enforce",
    root,
    "4050",
    ingest,
  );
  assert.ok(telemetryFlags.includes("--allow-net"));
  assert.equal(
    telemetryFlags.some((flag) => flag.startsWith("--allow-net=")),
    false,
  );
  for (const endpoint of [
    "http://openobserve:5080",
    "http://token@otel-collector:4318",
    "https://otel-collector:4318",
    "http://otel-collector",
    "http://otel-collector:0",
    "http://otel-collector:not-a-port",
    "http://otel-collector:65536",
  ]) {
    assert.throws(
      () =>
        telemetryHostPort({
          telemetry: { collector: { otlpEndpoint: endpoint } },
        }),
      /invalid telemetry ingest endpoint/u,
    );
  }
});

void test("Node network permission is global rather than a host and port filter", () => {
  const denied = spawnSync(
    process.execPath,
    [
      "--permission",
      "--eval",
      "require('node:net').createServer().listen(0, '127.0.0.1')",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /ERR_ACCESS_DENIED/);
  const source = `import { createServer, createConnection } from 'node:net';
const servers = [createServer((socket) => socket.end()), createServer((socket) => socket.end())];
for (const server of servers) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
for (const server of servers) await new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
  socket.on('connect', () => { socket.end(); resolve(); });
  socket.on('error', reject);
});
await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));`;
  const allowed = spawnSync(
    process.execPath,
    ["--permission", "--allow-net", "--input-type=module", "--eval", source],
    { encoding: "utf8" },
  );
  assert.equal(allowed.status, 0, allowed.stderr);
});

void test("Node Permission Model audit permits an operation while enforce denies it", () => {
  const source =
    "import('node:fs').then(({readFileSync}) => process.stdout.write(readFileSync('/etc/hostname', 'utf8')))";
  const listener = fileURLToPath(
    new URL("../../scripts/permission-audit-listener.mjs", import.meta.url),
  );
  const audited = spawnSync(
    process.execPath,
    ["--permission-audit", "--import", listener, "--eval", source],
    { encoding: "utf8" },
  );
  assert.equal(audited.status, 0, audited.stderr);
  assert.notEqual(audited.stdout.trim(), "");
  assert.match(audited.stderr, /"event":"permission-audit"/);
  const enforced = spawnSync(
    process.execPath,
    ["--permission", "--allow-fs-read=/tmp", "--eval", source],
    { encoding: "utf8" },
  );
  assert.notEqual(enforced.status, 0);
  assert.match(
    enforced.stderr,
    /ERR_ACCESS_DENIED|Access to this API has been restricted/,
  );
});

void test("enforced runtimes can read only their exact launch context and claimed database ownership", async () => {
  const ownershipPath = join(root, "config/database-ownership.json");
  const contextPath = "/run/coffee-launch/context.json";
  const source = `import {readFileSync} from 'node:fs';
const ownershipPath=${JSON.stringify(ownershipPath)};
let ownershipBytes=0;
try { ownershipBytes=readFileSync(ownershipPath).byteLength; } catch {}
process.stdout.write(JSON.stringify({ownershipBytes,
  ownershipAllowed:process.permission.has('fs.read',ownershipPath),
  contextAllowed:process.permission.has('fs.read',${JSON.stringify(contextPath)}),
  siblingContextAllowed:process.permission.has('fs.read','/run/coffee-launch/other.json'),
  toolchainAllowed:process.permission.has('fs.read',${JSON.stringify(join(root, "config/toolchain-versions.json"))})}));`;

  const runChild = async (runtime) => {
    const manifest = await validatePermissionManifest(root, runtime);
    const child = spawnSync(
      process.execPath,
      [
        ...permissionFlags(manifest, "enforce", root),
        "--input-type=module",
        "--eval",
        source,
      ],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };

  const orders = await runChild("orders-service");
  assert.ok(orders.ownershipBytes > 0);
  assert.equal(orders.ownershipAllowed, true);
  assert.equal(orders.contextAllowed, true);
  assert.equal(orders.siblingContextAllowed, false);
  assert.equal(orders.toolchainAllowed, false);

  const publicApi = await runChild("api-public");
  assert.equal(publicApi.ownershipBytes, 0);
  assert.equal(publicApi.ownershipAllowed, false);
  assert.equal(publicApi.contextAllowed, true);
  assert.equal(publicApi.siblingContextAllowed, false);
  assert.equal(publicApi.toolchainAllowed, false);
});
