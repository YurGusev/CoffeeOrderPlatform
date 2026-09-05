import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function configRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-config-"));
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
  return root;
}

function run(root, env = {}) {
  const cleanEnvironment = { ...process.env };
  for (const key of [
    "COFFEE_REQUIRE_SOPS_MAC",
    "SOPS_AGE_KEY_FILE",
    "SOPS_BIN",
  ])
    delete cleanEnvironment[key];
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/check-platform-config.mjs"), "--root", root],
    {
      encoding: "utf8",
      env: { ...cleanEnvironment, ...env },
    },
  );
}

void test("GREEN: canonical config and encrypted secrets pass the foundation checker", () => {
  const result = run(REPO_ROOT);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /15 runtimes/);
});

void test("GREEN: Kafka access is directional and uses the launch group mapping", async () => {
  const document = parseYaml(
    await readFile(join(REPO_ROOT, "config/platform.yaml"), "utf8"),
    {json: true},
  );
  assert.deepEqual(document.services["orders-aroma-preparation"].kafka.producers, [
    "coffee.aroma.cart.commands.v1",
    "coffee.realtime.invalidate.v1",
  ]);
  assert.deepEqual(document.services["orders-aroma-preparation"].kafka.consumers, [
    {groupId: "orders-catalog-mapping-v2", topics: ["coffee.catalog.mapping.v2"], processing: "durable"},
    {groupId: "orders-aroma-preparation-v1", topics: ["coffee.orders.lifecycle.v1"], processing: "durable"},
    {groupId: "orders-aroma-projection-v1", topics: ["coffee.aroma.cart.events.v1"], processing: "durable"},
  ]);
  assert.deepEqual(document.services["realtime-gateway"].kafka.consumers, [
    {groupId: "realtime-gateway-v1", topics: ["coffee.realtime.invalidate.v1"], processing: "realtime"},
  ]);
});

void test("RED: legacy Kafka mode/topics/groups path is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["realtime-gateway"].kafka = {
      mode: "consumer",
      topics: ["coffee.realtime.invalidate.v1"],
      groups: ["realtime-gateway-v1"],
    };
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SCHEMA/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: realtime processing is restricted to realtime-gateway", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["orders-service"].kafka.consumers = [{
      groupId: "realtime-gateway-v1",
      topics: ["coffee.realtime.invalidate.v1"],
      processing: "realtime",
    }];
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-KAFKA-REALTIME|CONFIG-KAFKA-DIRECTION/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: realtime consumer must use the launch group id", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), {json: true});
    document.services["realtime-gateway"].kafka.consumers[0].groupId = "realtime-gateway-replica";
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-KAFKA-(REALTIME|DIRECTION)/);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

void test("RED: unknown platform key fails closed before runtime startup", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.unexpected = true;
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SCHEMA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: plaintext secret leaf is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "secrets/platform.secrets.sops.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      document.replace(/password: ENC\[[^\n]+/, "password: leaked-plaintext"),
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SCHEMA|PLAINTEXT-SECRET)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: foreign database secret cannot be granted to a stateless runtime", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.services.web.secretRefs.push("postgres.customer");
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SECRET-ALLOWLIST|DB-SECRET)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: foreign database secret cannot be granted to Catalog runtime", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "config/platform.yaml");
    const document = parseYaml(await readFile(path, "utf8"), { json: true });
    document.services["catalog-service"].secretRefs[0] =
      "postgres.ordersService";
    await writeFile(path, dumpYaml(document), "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-SECRET-ALLOWLIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: secret-like key in Compose is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "compose.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      `${document}\nservices:\n  leaked-config:\n    environment:\n      PASSWORD: leaked\n`,
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-PLAINTEXT-KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: secret-like key in CI configuration is rejected", async () => {
  const root = await configRoot();
  try {
    const directory = join(root, ".github/workflows");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "leaked.yml"),
      "name: check\njobs:\n  check:\n    password: leaked\n",
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-PLAINTEXT-KEY/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: additional dotenv and secret files are rejected", async () => {
  const root = await configRoot();
  try {
    await writeFile(join(root, ".env.local"), "PLAIN=forbidden\n", "utf8");
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-FORBIDDEN-FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: additional secret file outside the allowlist is rejected", async () => {
  const root = await configRoot();
  try {
    await writeFile(
      join(root, "runtime-secrets.yaml"),
      "not-a-secret-bundle\n",
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-FORBIDDEN-FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: malformed SOPS MAC is rejected", async () => {
  const root = await configRoot();
  try {
    const path = join(root, "secrets/platform.secrets.sops.yaml");
    const document = await readFile(path, "utf8");
    await writeFile(
      path,
      document.replace(/^    mac: .*$/mu, "    mac: invalid-mac"),
      "utf8",
    );
    const result = run(root);
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /CONFIG-(SCHEMA|SOPS-MAC)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: requested SOPS MAC verification fails closed on decrypt/MAC error", async () => {
  const root = await configRoot();
  try {
    const bin = join(root, "test-bin");
    await mkdir(bin, { recursive: true });
    const sops = join(bin, "sops");
    await writeFile(sops, "#!/bin/sh\nexit 42\n", "utf8");
    await chmod(sops, 0o755);
    const keyFile = join(root, "age.key");
    await writeFile(keyFile, "test-only-key-material\n", "utf8");
    const result = run(root, {
      COFFEE_REQUIRE_SOPS_MAC: "1",
      SOPS_AGE_KEY_FILE: keyFile,
      SOPS_BIN: sops,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /CONFIG-SOPS-MAC/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
