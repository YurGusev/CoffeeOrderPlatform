import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {access} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {permissionFlags, telemetryHostPort, validateAllPermissionManifests, validatePermissionManifest} from "../../scripts/permission-audit.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

void test("all 14 Node permission manifests match the connectivity policy; native nginx and removed web have none", async () => {
  const manifests = await validateAllPermissionManifests(root);
  assert.equal(manifests.length, 14);
  assert.equal(new Set(manifests.map((manifest) => manifest.runtime)).size, 14);
  await assert.rejects(access(new URL("../../config/permissions/web.json", import.meta.url)), {code: "ENOENT"});
});

void test("enforce flags allow addons only for Kafka runtimes", async () => {
  const manifest = await validatePermissionManifest(root, "api-public");
  assert.deepEqual(permissionFlags(manifest, "enforce", root).slice(0, 2), ["--permission", "--allow-net=customer-service:4101,catalog-service:4102,pricing-service:4103,orders-service:4104"]);
  assert.ok(permissionFlags(manifest, "audit", root).includes("--permission-audit"));
  assert.equal(permissionFlags(manifest, "enforce", root).some((flag) => flag.startsWith("--allow-child")), false);
  const kafkaManifest = await validatePermissionManifest(root, "orders-service");
  assert.ok(permissionFlags(kafkaManifest, "enforce", root).includes("--allow-addons"));
  const ingest = telemetryHostPort({telemetry: {collector: {otlpEndpoint: 'http://otel-collector:4318'}}});
  const alternateIngest = telemetryHostPort({telemetry: {collector: {otlpEndpoint: 'http://otel-collector:4319'}}});
  assert.equal(alternateIngest, "otel-collector:4319");
  const telemetryFlags = permissionFlags(manifest, 'enforce', root, '4050', ingest);
  assert.ok(telemetryFlags.includes('--allow-net=customer-service:4101,catalog-service:4102,pricing-service:4103,orders-service:4104,otel-collector:4318,0.0.0.0:4050'));
  assert.equal(telemetryFlags.some(flag => flag.includes('openobserve')), false);
  for (const endpoint of ['http://openobserve:5080', 'http://token@otel-collector:4318', 'https://otel-collector:4318', 'http://otel-collector', 'http://otel-collector:0', 'http://otel-collector:not-a-port', 'http://otel-collector:65536']) {
    assert.throws(() => telemetryHostPort({telemetry: {collector: {otlpEndpoint: endpoint}}}), /invalid telemetry ingest endpoint/u);
  }
});

void test("Node Permission Model audit permits an operation while enforce denies it", () => {
  const source = "import('node:fs').then(({readFileSync}) => process.stdout.write(readFileSync('/etc/hostname', 'utf8')))";
  const listener = fileURLToPath(new URL("../../scripts/permission-audit-listener.mjs", import.meta.url));
  const audited = spawnSync(process.execPath, ["--permission-audit", "--import", listener, "--eval", source], {encoding: "utf8"});
  assert.equal(audited.status, 0, audited.stderr);
  assert.notEqual(audited.stdout.trim(), "");
  assert.match(audited.stderr, /"event":"permission-audit"/);
  const enforced = spawnSync(process.execPath, ["--permission", "--allow-fs-read=/tmp", "--eval", source], {encoding: "utf8"});
  assert.notEqual(enforced.status, 0);
  assert.match(enforced.stderr, /ERR_ACCESS_DENIED|Access to this API has been restricted/);
});
