import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import test from "node:test";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function configRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-orders-signing-"));
  await cp(join(REPO_ROOT, "config"), join(root, "config"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "platform"), join(root, "platform"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "secrets"), join(root, "secrets"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "compose.yaml"), join(root, "compose.yaml"));
  await cp(join(REPO_ROOT, ".sops.yaml"), join(root, ".sops.yaml"));
  await mkdir(join(root, "apps/pricing-service/migrations"), {
    recursive: true,
  });
  await cp(
    join(
      REPO_ROOT,
      "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql",
    ),
    join(
      root,
      "apps/pricing-service/migrations/0001_create_pricing_policy_versions.sql",
    ),
  );
  return root;
}

function checkConfig(root) {
  const env = { ...process.env };
  for (const key of [
    "COFFEE_REQUIRE_SOPS_MAC",
    "SOPS_AGE_KEY_FILE",
    "SOPS_BIN",
  ])
    delete env[key];
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/check-platform-config.mjs"), "--root", root],
    {
      encoding: "utf8",
      env,
    },
  );
}

void test("Orders delegation signing keys are scoped and signer material is encrypted only for development", async () => {
  const platform = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
    { json: true },
  );
  const catalog = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-catalog.json"), "utf8"),
  );
  const profile = JSON.parse(
    await readFile(
      join(REPO_ROOT, "platform/launch-v1-runtime-profile.json"),
      "utf8",
    ),
  );
  const schema = JSON.parse(
    await readFile(
      join(REPO_ROOT, "secrets/platform-secrets.schema.json"),
      "utf8",
    ),
  );
  const ordersRefs = [
    "postgres.ordersService",
    "kafka.orders",
    "security.ordersServiceDelegationSigningPrivateKey",
    "security.delegationVerificationKeys.api-public",
    "security.serviceTransportKeys.orders-service",
    "telemetry.exporterToken",
  ];

  assert.deepEqual(platform.services["orders-service"].secretRefs, ordersRefs);
  assert.deepEqual(
    catalog.runtimes.find(({ name }) => name === "orders-service").secretRefs,
    ordersRefs,
  );
  assert.deepEqual(
    profile.runtimes.find(({ name }) => name === "orders-service").secretRefs,
    ordersRefs,
  );
  assert.equal(
    platform.services["api-internal"].secretRefs.includes(
      "security.ordersServiceDelegationSigningPrivateKey",
    ),
    false,
  );
  assert.ok(
    platform.services["api-internal"].secretRefs.includes(
      "security.serviceVerificationKeys.orders-service",
    ),
  );
  assert.equal(
    schema.$defs.security.properties.ordersServiceDelegationSigningPrivateKey
      .$ref,
    "#/$defs/encrypted",
  );
  assert.equal(
    schema.$defs.security.required.includes(
      "ordersServiceDelegationSigningPrivateKey",
    ),
    false,
    "environments without a provisioned Orders signer remain valid; runtime bootstrap enforces referenced secrets",
  );

  const encrypted = parseYaml(
    await readFile(
      join(REPO_ROOT, "secrets/platform.secrets.sops.yaml"),
      "utf8",
    ),
    { json: true },
  );
  for (const environment of ["development", "staging", "production"]) {
    const security = encrypted.environments[environment].security;
    assert.ok(security.serviceVerificationKeys["orders-service"].active);
    assert.ok(security.serviceVerificationKeys["orders-service"].previous);
    assert.ok(security.delegationVerificationKeys["api-public"].active);
    assert.ok(security.delegationVerificationKeys["api-public"].previous);
    if (environment === "development") {
      assert.equal(
        typeof security.ordersServiceDelegationSigningPrivateKey,
        "string",
      );
      assert.ok(
        security.ordersServiceDelegationSigningPrivateKey.startsWith("ENC["),
      );
    } else {
      assert.equal(
        Object.hasOwn(security, "ordersServiceDelegationSigningPrivateKey"),
        false,
        `${environment} signing material must not be provisioned by this change`,
      );
    }
  }
});

void test("missing Orders signing material fails config bootstrap closed", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "secrets/platform.secrets.sops.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    delete document.environments.development.security
      .ordersServiceDelegationSigningPrivateKey;
    await writeFile(path, dumpYaml(document), "utf8");

    const result = checkConfig(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SECRET-REF/u);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /orders-service\.security\.ordersServiceDelegationSigningPrivateKey/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("isolated Compose fixture supplies the scoped Orders signer that matches its public verifier", async () => {
  const source = await readFile(
    join(REPO_ROOT, "tools/compose-smoke.mjs"),
    "utf8",
  );
  assert.ok(
    /"security\.ordersServiceDelegationSigningPrivateKey": ordersService\.privateKey/u.test(
      source,
    ),
  );
  assert.ok(
    /"security\.serviceVerificationKeys\.orders-service": ordersService\.verificationKeys/u.test(
      source,
    ),
  );
});
