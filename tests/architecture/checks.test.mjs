import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkStaticSource } from "../../scripts/check-architecture.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURES = join(REPO_ROOT, "tests/architecture/fixtures");

function run(script, root = REPO_ROOT) {
  return spawnSync(
    process.execPath,
    [join(REPO_ROOT, "scripts", script), "--root", root],
    { encoding: "utf8" },
  );
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function runLintProfile(singleThreaded) {
  const args = ["--type-aware", "--deny-warnings", "--format=json"];
  if (singleThreaded) args.push("--threads=1");
  args.push("apps", "packages", "scripts", "tests");
  return spawnSync(join(REPO_ROOT, "node_modules/.bin/oxlint"), args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function normalizedDiagnostics(result) {
  const report = JSON.parse(result.stdout);
  return report.diagnostics
    .map((diagnostic) => ({
      code: diagnostic.code,
      filename: diagnostic.filename,
      labels: diagnostic.labels.map((label) => ({
        column: label.start?.column,
        endColumn: label.end?.column,
        endLine: label.end?.line,
        label: label.label,
        line: label.start?.line,
        message: label.message,
        warning: label.warning,
      })),
      message: diagnostic.message,
      severity: diagnostic.severity,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

async function authorityRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-issue2-"));
  await cp(join(REPO_ROOT, "config"), join(root, "config"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "platform"), join(root, "platform"), {
    recursive: true,
  });
  return root;
}

async function toolchainRoot() {
  const root = await mkdtemp(join(tmpdir(), "coffee-issue3-toolchain-"));
  for (const file of [
    "package.json",
    ".node-version",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "tsconfig.base.json",
  ]) {
    await cp(join(REPO_ROOT, file), join(root, file));
  }
  await cp(join(REPO_ROOT, "config"), join(root, "config"), {
    recursive: true,
  });
  await cp(join(REPO_ROOT, "platform"), join(root, "platform"), {
    recursive: true,
  });
  await mkdir(join(root, "patches"));
  await cp(
    join(REPO_ROOT, "patches/librdkafka-resume-wakeup.patch"),
    join(root, "patches/librdkafka-resume-wakeup.patch"),
  );
  return root;
}

async function mutateJson(path, mutation) {
  const document = JSON.parse(await readFile(path, "utf8"));
  mutation(document);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

void test("GREEN: accepted manifests pass all direct checkers deterministically", async () => {
  for (const script of [
    "check-service-catalog.mjs",
    "check-database-ownership.mjs",
    "check-architecture.mjs",
  ]) {
    const first = run(script);
    const second = run(script);
    assert.equal(first.status, 0, output(first));
    assert.deepEqual(
      [first.status, first.stdout, first.stderr],
      [second.status, second.stdout, second.stderr],
    );
  }
});

void test("RED BOUND-DB-CLIENT: realtime infrastructure cannot import owner database capabilities", () => {
  assert.throws(
    () =>
      checkStaticSource(
        "apps/realtime-gateway/src/infrastructure/database.ts",
        'import * as owner from "@coffee-platform/database/owner"; export const forbidden=owner;',
      ),
    /BOUND-DB-CLIENT/,
  );
});

void test("RED BOUND-REALTIME-SQL: realtime infrastructure cannot contain SQL", () => {
  assert.throws(
    () =>
      checkStaticSource(
        "apps/realtime-gateway/src/infrastructure/query.ts",
        'export const forbidden="SELECT 1";',
      ),
    /BOUND-REALTIME-SQL/,
  );
});

void test("RED BOUND-IMPORT: Orders cannot import Catalog internal repository", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-import-orders-catalog"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-IMPORT/);
  assert.match(output(result), /orders-service.*catalog-service/s);
});

void test("RED BOUND-IMPORT: Catalog cannot import Orders infrastructure DB", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-import-catalog-orders"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-IMPORT/);
  assert.match(output(result), /catalog-service.*orders-service/s);
});

for (const { name, path, source, rule } of [
  {
    name: "external Confirm requirement",
    path: "apps/orders-service/src/application/confirm-order.ts",
    source:
      "export async function confirmOrder(customerClient) { return customerClient.getOrderInput(); }",
    rule: "ARCH-ORDERS-CONFIRM-BOUNDARY",
  },
  {
    name: "unnamed third Confirm requirement",
    path: "apps/orders-service/src/application/confirm-order.ts",
    source:
      "export async function confirmOrder(store: Pick<OrderStore, 'replay'|'precheck'|'confirm'>, input: CommandContext&Readonly<{orderRef:string}>, external: unknown) { return store.confirm(input); }",
    rule: "ARCH-ORDERS-CONFIRM-BOUNDARY",
  },
  {
    name: "Kafka publish in owner transaction",
    path: "apps/orders-service/src/infrastructure/database/order-store.ts",
    source:
      "export async function confirm(tx, kafkaProducer) { await kafkaProducer.publish({messageType: 'OrderConfirmed.v1'}); }",
    rule: "ARCH-ORDERS-OUTBOX",
  },
  {
    name: "aliased broker publish in owner transaction",
    path: "apps/orders-service/src/infrastructure/database/order-store.ts",
    source:
      "export async function confirm(tx, broker) { await broker.publish({messageType: 'OrderConfirmed.v1'}); }",
    rule: "ARCH-ORDERS-OUTBOX",
  },
  {
    name: "automatic frozen-offer remapping",
    path: "apps/orders-service/src/domain/order-contribution.ts",
    source:
      "export function remap(items, catalog) { return items.map(item => ({...item, offerRef: catalog[item.productRef]})); }",
    rule: "ARCH-ORDERS-FROZEN-OFFER",
  },
  {
    name: "aliased frozen-offer remapping",
    path: "apps/orders-service/src/domain/order-contribution.ts",
    source:
      "export function remap(items, lookup) { return items.map(item => ({...item, offerRef: lookup[item.productRef]})); }",
    rule: "ARCH-ORDERS-FROZEN-OFFER",
  },
  {
    name: "revision-equality InSync",
    path: "apps/orders-service/src/domain/order-card.ts",
    source:
      "export const isInSync = (desiredRevision, observedRevision) => desiredRevision === observedRevision;",
    rule: "ARCH-ORDERS-INSYNC-PROOF",
  },
  {
    name: "aliased revision-equality InSync",
    path: "apps/orders-service/src/domain/order-card.ts",
    source:
      "export const isInSync = (desired, observed) => desired.version === observed.version;",
    rule: "ARCH-ORDERS-INSYNC-PROOF",
  },
]) {
  void test(`RED ${rule}: Orders rejects ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "coffee-orders-boundary-"));
    try {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), source);
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), new RegExp(rule));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const targetRuntime of [
  "catalog-activation-worker",
  "api-internal",
  "orders-service",
  "pricing-service",
  "customer-service",
]) {
  void test(`RED BOUND-IMPORT: catalog-supplier-sync -> ${targetRuntime}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "coffee-catalog-boundary-"));
    const source = "apps/catalog-supplier-sync/src/boundary.ts";
    const target = `apps/${targetRuntime}/src/internal.ts`;
    try {
      await mkdir(join(root, "apps/catalog-supplier-sync/src"), {
        recursive: true,
      });
      await mkdir(join(root, `apps/${targetRuntime}/src`), { recursive: true });
      await writeFile(
        join(root, target),
        'export const internal = "private";\n',
      );
      await writeFile(
        join(root, source),
        `import {internal} from "../../${targetRuntime}/src/internal.js";\nvoid internal;\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.ok(output(result).includes("BOUND-IMPORT"), output(result));
      assert.ok(
        output(result).includes(`${source} -> ${target}`),
        output(result),
      );
      assert.doesNotMatch(
        output(result),
        /unavailable|did not return an AST graph/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const targetRuntime of [
  "catalog-service",
  "customer-service",
  "orders-service",
  "aroma-gateway",
]) {
  void test(`RED BOUND-IMPORT: pricing-service -> ${targetRuntime}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "coffee-pricing-boundary-"));
    const source = "apps/pricing-service/src/application/boundary.ts";
    const target = `apps/${targetRuntime}/src/internal.ts`;
    try {
      await mkdir(join(root, "apps/pricing-service/src/application"), {
        recursive: true,
      });
      await mkdir(join(root, `apps/${targetRuntime}/src`), { recursive: true });
      await writeFile(
        join(root, target),
        'export const internal = "private";\n',
      );
      await writeFile(
        join(root, source),
        `import {internal} from "../../../${targetRuntime}/src/internal.js";\nvoid internal;\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /BOUND-IMPORT/u);
      assert.ok(
        output(result).includes(`${source} -> ${target}`),
        output(result),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test("GREEN: Catalog importer uses allowed contract and platform packages", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-catalog-packages-"));
  try {
    await mkdir(join(root, "apps/catalog-supplier-sync/src/infrastructure"), {
      recursive: true,
    });
    await symlink(
      join(REPO_ROOT, "apps/catalog-supplier-sync/node_modules"),
      join(root, "apps/catalog-supplier-sync/node_modules"),
      "dir",
    );
    await writeFile(
      join(
        root,
        "apps/catalog-supplier-sync/src/infrastructure/catalog-import-store.ts",
      ),
      [
        'import {catalogBatchHash} from "@coffee-platform/contracts-aroma-v1";',
        'import {withTransaction} from "@coffee-platform/database";',
        'import {defineCopy} from "@coffee-platform/database/owner";',
        'import type {HttpClient} from "@coffee-platform/platform-http";',
        "void [catalogBatchHash,withTransaction,defineCopy];",
        "export type Client = HttpClient;",
      ].join("\n"),
    );
    const result = run("check-architecture.mjs", root);
    assert.equal(result.status, 0, output(result));
    assert.match(output(result), /passed with Dependency Cruiser/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: Catalog importer implementation stays in owner infrastructure", async () => {
  const ownerPath = join(
    REPO_ROOT,
    "apps/catalog-supplier-sync/src/infrastructure/catalog-import-store.ts",
  );
  const legacyPath = join(
    REPO_ROOT,
    "apps/catalog-supplier-sync/src/catalog-import-store.ts",
  );
  assert.equal(
    existsSync(legacyPath),
    false,
    "SQL owner imports must not remain in the application root",
  );
  assert.match(
    await readFile(ownerPath, "utf8"),
    /@coffee-platform\/database\/owner/u,
  );
});

void test("GREEN: Catalog activation SQL stays in owner infrastructure", async () => {
  const ownerPath = join(
    REPO_ROOT,
    "apps/catalog-activation-worker/src/infrastructure/activation-store.ts",
  );
  const legacyPath = join(
    REPO_ROOT,
    "apps/catalog-activation-worker/src/activation-store.ts",
  );
  assert.equal(
    existsSync(legacyPath),
    false,
    "Catalog activation SQL must not remain in the application root",
  );
  assert.match(
    await readFile(ownerPath, "utf8"),
    /@coffee-platform\/database\/owner/u,
  );
});

for (const [source, rule] of [
  [
    'export const staging = "SELECT * FROM catalog.snapshot_offers";',
    "ARCH-CATALOG-API-BOUNDARY",
  ],
  [
    'export const directTable = "SELECT * FROM catalog.catalog_state";',
    "ARCH-CATALOG-API-BOUNDARY",
  ],
  [
    'import type {HttpClient} from "@coffee-platform/platform-http"; export type ProviderClient = HttpClient;',
    "ARCH-CATALOG-API-BOUNDARY",
  ],
  [
    'export const foreign = "postgresql://localhost/coffee_platform_pricing";',
    "ARCH-POSTGRES-URL",
  ],
]) {
  void test(`RED ARCH-CATALOG-API-BOUNDARY: catalog-service rejects ${source.slice(0, 40)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "coffee-catalog-api-boundary-"));
    try {
      await mkdir(join(root, "apps/catalog-service/src/infrastructure"), {
        recursive: true,
      });
      await writeFile(
        join(
          root,
          "apps/catalog-service/src/infrastructure/catalog-read-store.ts",
        ),
        `${source}\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), new RegExp(rule, "u"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void test("RED BOUND-DB-CLAIM: architecture rejects write-capable Catalog API role", async () => {
  const root = await authorityRoot();
  try {
    await writeFile(
      join(root, "runtime-environment.json"),
      JSON.stringify({
        bindings: [
          {
            runtime: "catalog-service",
            database: "coffee_platform_catalog",
            role: "coffee_catalog_activate_rw",
          },
        ],
      }),
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-DB-CLAIM.*catalog-service/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: versioned contract import is accepted by Dependency Cruiser 18.2.0 wrapper", () => {
  const result = run("check-architecture.mjs", join(FIXTURES, "valid-import"));
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /Dependency Cruiser 18\.2\.0/);
});

void test("RED BOUND-CONTRACT-AUDIENCE: browser cannot reach internal types through a domain re-export", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-browser-transitive-internal"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-CONTRACT-AUDIENCE/);
});

void test("RED BOUND-DB-CLAIM: Orders cannot receive Customer database URL/role", async () => {
  const root = await authorityRoot();
  try {
    await cp(
      join(FIXTURES, "invalid-db/runtime-environment.json"),
      join(root, "runtime-environment.json"),
    );
    const result = run("check-database-ownership.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(
      output(result),
      /BOUND-DB-CLAIM.*orders-service.*coffee_platform_customer/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: runtime with its own database and role is accepted", async () => {
  const root = await authorityRoot();
  try {
    await cp(
      join(FIXTURES, "valid-db/runtime-environment.json"),
      join(root, "runtime-environment.json"),
    );
    const result = run("check-database-ownership.mjs", root);
    assert.equal(result.status, 0, output(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: Catalog event consumer uses the named versioned interaction contract", async () => {
  const policy = JSON.parse(
    await readFile(join(REPO_ROOT, "config/service-interactions.json"), "utf8"),
  );
  const edge = policy.interactions.find(
    (interaction) => interaction.id === "catalog-mapping-preparation",
  );
  assert.deepEqual(
    { from: edge.from, to: edge.to, mode: edge.mode, contract: edge.contract },
    {
      from: "catalog-activation-worker",
      to: "orders-aroma-preparation",
      mode: "event",
      contract: "CatalogMappingChanged.v2",
    },
  );
  const result = run("check-service-catalog.mjs");
  assert.equal(result.status, 0, output(result));
});

void test("RED BOUND-DB-CLAIM: two database owners cannot share one owner identity", async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, "config/database-ownership.json");
    await mutateJson(path, (document) => {
      document.databases[1].owner = "customer";
    });
    const result = run("check-database-ownership.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-DB-CLAIM.*duplicate owner customer/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED BOUND-INTERACTION: Catalog to Orders DB edge is rejected", async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, "config/service-interactions.json");
    await mutateJson(path, (document) =>
      document.interactions.push({
        id: "catalog-orders-db",
        from: "catalog-service",
        to: "orders-service",
        mode: "db",
        contract: "none",
        operations: ["SELECT"],
        timeout: "none",
        retryOwner: "none",
        dataExposure: "orders-db",
      }),
    );
    const result = run("check-service-catalog.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(
      output(result),
      /BOUND-INTERACTION.*catalog-orders-db.*forbidden mode db/s,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED BOUND-SECRET: api-public cannot receive a foreign Postgres secret", async () => {
  const root = await authorityRoot();
  try {
    const path = join(root, "config/service-catalog.json");
    await mutateJson(path, (document) => {
      document.runtimes
        .find((runtime) => runtime.name === "api-public")
        .secretRefs.push("postgres.ordersService");
    });
    const result = run("check-service-catalog.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-SECRET.*api-public/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-TEMPORAL: business source cannot construct mutable Date", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-native-time"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-TEMPORAL/);
});

void test("RED ARCH-FORBIDDEN-HTTP: Axios source import is rejected", () => {
  const result = run("check-architecture.mjs", join(FIXTURES, "invalid-axios"));
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-FORBIDDEN-HTTP/);
});

void test("RED ARCH-FORBIDDEN-HTTP: Axios package dependency is rejected", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-axios-dependency"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-FORBIDDEN-HTTP/);
});

void test("RED ARCH-FORBIDDEN-NATIVE: SQLite/FFI/VFS source import is rejected", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-native-module"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-FORBIDDEN-NATIVE/);
});

void test("RED BOUND-IMPORT: unallowlisted @coffee-platform namespace is rejected", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-platform-namespace"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /BOUND-IMPORT/);
  assert.match(output(result), /@coffee-platform\/customer-shared-business/);
});

void test("RED TS7 static baseline rules reject non-erasable, CommonJS and extensionless imports", () => {
  const cases = [
    ["invalid-ts7-enum", "TS7-ERASABLE"],
    ["invalid-ts7-commonjs", "TS7-ESM"],
    ["invalid-ts7-import", "TS7-ESM"],
    ["invalid-ts7-any", "TS7-UNSAFE-ANY"],
    ["invalid-ts7-brand", "TS7-BRAND-CAST"],
    ["invalid-ts7-switch", "TS7-EXHAUSTIVE-SWITCH"],
    ["invalid-ts7-promise", "TS7-PROMISE"],
    ["invalid-ts7-version-mix", "TS7-VERSION-MIX"],
    ["invalid-ts7-eval", "TS7-EVAL"],
  ];
  for (const [fixture, rule] of cases) {
    const result = run("check-architecture.mjs", join(FIXTURES, fixture));
    assert.notEqual(result.status, 0, `${fixture}: ${output(result)}`);
    assert.match(output(result), new RegExp(rule), fixture);
  }
});

void test("RED ARCH-PERMISSION: every materialized runtime must declare all permission classes", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-permission-manifest"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-PERMISSION/);
  assert.match(output(result), /missing/);
});

void test("GREEN ARCH-PERMISSION: native nginx image needs no Node permission manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-native-permission-"));
  try {
    await mkdir(join(root, "apps", "edge-nginx"), { recursive: true });
    await mkdir(join(root, "config"));
    await writeFile(
      join(root, "apps", "edge-nginx", "Dockerfile"),
      "FROM scratch\n",
    );
    await writeFile(
      join(root, "config", "platform.yaml"),
      "schemaVersion: 1\n",
    );
    const result = run("check-architecture.mjs", root);
    assert.equal(result.status, 0, output(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("ARCH-PERMISSION: source-only decoders stay offline; a main or package requires permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-offline-decoder-"));
  const app = join(root, "apps/tasty-gateway");
  try {
    await mkdir(join(app, "src/infrastructure/provider"), { recursive: true });
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/platform.yaml"), "schemaVersion: 1\n");
    await writeFile(
      join(app, "src/infrastructure/provider/decoder.ts"),
      "export const decode = (value: unknown): unknown => value;\n",
    );
    const offline = run("check-architecture.mjs", root);
    assert.equal(offline.status, 0, output(offline));
    for (const file of ["src/main.ts", "package.json"]) {
      const path = join(app, file);
      await writeFile(path, file.endsWith(".json") ? "{}\n" : "export {};\n");
      const runtime = run("check-architecture.mjs", root);
      assert.notEqual(runtime.status, 0, output(runtime));
      assert.match(output(runtime), /ARCH-PERMISSION/);
      await rm(path);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED: native librdkafka source patch cannot drift from its pinned checksum", async () => {
  const root = await toolchainRoot();
  try {
    const path = join(root, "patches/librdkafka-resume-wakeup.patch");
    await writeFile(path, (await readFile(path, "utf8")) + "\n");
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /LIBRDKAFKA-PATCH/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: exact TS7 toolchain manifest, lockfile and config baseline passes", async () => {
  const result = run("check-toolchain-versions.mjs");
  assert.equal(result.status, 0, output(result));
  const root = await toolchainRoot();
  try {
    const cache = join(root, "apps/web/node_modules/.vite/deps");
    await mkdir(cache, { recursive: true });
    await writeFile(
      join(cache, "package.json"),
      "not a source manifest",
      "utf8",
    );
    const cached = run("check-toolchain-versions.mjs", root);
    assert.equal(cached.status, 0, output(cached));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("GREEN: canonical and single-threaded Oxlint profiles have identical diagnostics and exit code", () => {
  const canonical = runLintProfile(false);
  const singleThreaded = runLintProfile(true);
  assert.equal(
    canonical.status,
    singleThreaded.status,
    `${output(canonical)}\n${output(singleThreaded)}`,
  );
  assert.deepEqual(
    normalizedDiagnostics(canonical),
    normalizedDiagnostics(singleThreaded),
  );
});

void test("RED TOOLCHAIN-PIN: floating dependency specifier is rejected", async () => {
  const root = await toolchainRoot();
  try {
    await mutateJson(join(root, "package.json"), (document) => {
      document.devDependencies.typescript = "^7.0.2";
    });
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TOOLCHAIN-PIN/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-BASELINE: baseUrl compiler option is rejected", async () => {
  const root = await toolchainRoot();
  try {
    await cp(
      join(FIXTURES, "invalid-ts7-baseurl", "tsconfig.json"),
      join(root, "tsconfig.json"),
    );
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-BASELINE/);
    assert.match(output(result), /baseUrl/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-BACKEND: backend baseline cannot drift from ES2025/NodeNext", async () => {
  const root = await toolchainRoot();
  try {
    await mutateJson(join(root, "tsconfig.base.json"), (document) => {
      document.compilerOptions.module = "ESNext";
    });
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-BACKEND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-FRONTEND: web project cannot use the backend profile or emit", async () => {
  const root = await toolchainRoot();
  try {
    await cp(join(REPO_ROOT, "apps", "web"), join(root, "apps", "web"), {
      recursive: true,
    });
    await mutateJson(join(root, "apps", "web", "tsconfig.json"), (document) => {
      document.compilerOptions.module = "NodeNext";
    });
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-FRONTEND/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-REFERENCES: platform packages must emit isolated declarations", async () => {
  const root = await toolchainRoot();
  try {
    await cp(
      join(REPO_ROOT, "packages", "platform-runtime"),
      join(root, "packages", "platform-runtime"),
      { recursive: true },
    );
    await mutateJson(
      join(root, "packages", "platform-runtime", "tsconfig.json"),
      (document) => {
        document.compilerOptions.isolatedDeclarations = false;
      },
    );
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-REFERENCES/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-APP-DECLARATIONS: apps cannot publish cross-service declaration entrypoints", async () => {
  const root = await toolchainRoot();
  try {
    await cp(join(REPO_ROOT, "apps", "web"), join(root, "apps", "web"), {
      recursive: true,
    });
    await mutateJson(join(root, "apps", "web", "package.json"), (document) => {
      document.types = "./dist/main.d.ts";
    });
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-APP-DECLARATIONS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TS7-SINGLE-COMPILER: second TypeScript package is rejected", async () => {
  const root = await toolchainRoot();
  try {
    await cp(join(REPO_ROOT, "apps"), join(root, "apps"), { recursive: true });
    await cp(join(REPO_ROOT, "apps", "web"), join(root, "apps", "rogue"), {
      recursive: true,
    });
    await mutateJson(
      join(root, "apps", "rogue", "package.json"),
      (document) => {
        document.devDependencies = { typescript: "7.0.2" };
      },
    );
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TS7-SINGLE-COMPILER/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED TOOLCHAIN-FINAL-IMAGE: build dependencies cannot enter final image", async () => {
  const root = await toolchainRoot();
  try {
    await cp(
      join(FIXTURES, "invalid-final-image", "Dockerfile"),
      join(root, "Dockerfile"),
    );
    const result = run("check-toolchain-versions.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /TOOLCHAIN-FINAL-IMAGE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("JSON Schema Draft 2020-12 accepts configuration and SPA runtime profile", () => {
  const code = String.raw`
from pathlib import Path
import json
from jsonschema import Draft202012Validator
for schema_path in sorted(Path('config').glob('*.schema.json')):
    Draft202012Validator.check_schema(json.loads(schema_path.read_text()))
for path in sorted(Path('config').glob('*.json')):
    if path.name.endswith('.schema.json'):
        continue
    doc=json.loads(path.read_text())
    schema=json.loads(path.with_name(doc['$schema'][2:]).read_text())
    Draft202012Validator(schema).validate(doc)
profile_path = Path('platform/launch-v1-runtime-profile.json')
profile = json.loads(profile_path.read_text())
profile_schema = json.loads(profile_path.with_name(profile['$schema'][2:]).read_text())
Draft202012Validator.check_schema(profile_schema)
Draft202012Validator(profile_schema).validate(profile)
`;
  const result = spawnSync("python3", ["-c", code], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, output(result));
});

void test("RED BOUND-DB-CLIENT: handlers cannot import raw pg or SQL capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-db-boundary-"));
  const directory = join(root, "apps/orders-service/src");
  try {
    await mkdir(directory, { recursive: true });
    for (const moduleName of [
      "pg",
      "pg-copy-streams",
      "@coffee-platform/database/owner",
      "../../../packages/platform-database/dist/internal.js",
      "@effect/sql-pg",
    ]) {
      await writeFile(
        join(directory, "handler.ts"),
        `import * as forbidden from ${JSON.stringify(moduleName)};\nvoid forbidden;\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /BOUND-DB-CLIENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED BOUND-KAFKA-CLIENT: handlers cannot bypass bounded delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-kafka-boundary-"));
  const directory = join(root, "apps/orders-service/src");
  try {
    await mkdir(directory, { recursive: true });
    for (const moduleName of [
      "@confluentinc/kafka-javascript",
      "@confluentinc/kafka-javascript/promisified",
      "../../../packages/platform-kafka-runtime/dist/native.js",
    ]) {
      await writeFile(
        join(directory, "handler.ts"),
        `import * as forbidden from ${JSON.stringify(moduleName)};\nvoid forbidden;\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /BOUND-KAFKA-CLIENT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-POSTGRES-URL: app source cannot contain a literal PostgreSQL URL", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-postgres-url"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-POSTGRES-URL/);
});

void test("RED ARCH-TYPED-PROVIDER-HTTP: AROMA Gateway fetch stays in the typed provider client", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-provider-fetch"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
});

void test("RED ARCH-TYPED-PROVIDER-HTTP: AROMA Gateway cannot add a generic proxy", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-provider-proxy"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
});

void test("RED ARCH-TYPED-PROVIDER-HTTP: alternate HTTP clients cannot bypass the typed provider client", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-provider-http-"));
  const directory = join(root, "apps/aroma-gateway/src");
  try {
    await mkdir(directory, { recursive: true });
    for (const moduleName of [
      "node-fetch",
      "cross-fetch",
      "got",
      "ky",
      "superagent",
      "node:http2",
    ]) {
      await writeFile(
        join(directory, "bad.ts"),
        `import * as client from ${JSON.stringify(moduleName)};\nvoid client;\n`,
      );
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
    }
    await rm(join(directory, "bad.ts"));
    const typedClient = join(
      directory,
      "infrastructure/provider/http-client.ts",
    );
    await mkdir(join(directory, "infrastructure/provider"), {
      recursive: true,
    });
    await writeFile(
      typedClient,
      'import * as client from "node-fetch";\nvoid client;\n',
    );
    let result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
    await rm(typedClient);
    for (const bucket of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      await writeFile(
        join(root, "apps/aroma-gateway/package.json"),
        JSON.stringify({ [bucket]: { "cross-fetch": "1.0.0" } }),
      );
      result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, `${bucket}: ${output(result)}`);
      assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-GENERIC-RETRY: generic retry dependency is forbidden", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-generic-retry-dependency"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-GENERIC-RETRY/);
});

void test("RED ARCH-GENERIC-RETRY: unsafe provider mutation cannot use a generic retry wrapper", () => {
  const result = run(
    "check-architecture.mjs",
    join(FIXTURES, "invalid-generic-retry-wrapper"),
  );
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), /ARCH-GENERIC-RETRY/);
});

void test("RED ARCH-TYPED-PROVIDER-HTTP: provider transport imports stay in the typed HTTP client", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-provider-http-import-"));
  try {
    const directory = join(root, "apps/aroma-gateway/src/application");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "provider.ts"),
      'import { Agent } from "undici";\nvoid Agent;\n',
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /ARCH-TYPED-PROVIDER-HTTP/);
    assert.match(output(result), /undici/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED BOUND-IMPORT: a runtime cannot import a foreign owner's database URL module", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-foreign-db-url-import-"));
  try {
    const orders = join(root, "apps/orders-service/src");
    const catalog = join(root, "apps/catalog-service/src");
    await mkdir(orders, { recursive: true });
    await mkdir(catalog, { recursive: true });
    await writeFile(
      join(catalog, "database-url.ts"),
      "export const databaseUrl = process.env.DATABASE_URL;\n",
    );
    await writeFile(
      join(orders, "main.ts"),
      'import { databaseUrl } from "../../catalog-service/src/database-url.js";\nvoid databaseUrl;\n',
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /BOUND-IMPORT/);
    assert.match(output(result), /orders-service.*catalog-service/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-CATALOG-WRITER: foreign app cannot mutate active Catalog tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-second-catalog-writer-"));
  try {
    const directory = join(root, "apps/orders-service/src/infrastructure");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "rogue-writer.ts"),
      'const query = "UPDATE catalog.catalog_state SET active_snapshot_ref = $1";\nvoid query;\n',
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /ARCH-CATALOG-WRITER/);
    assert.match(output(result), /orders-service/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("RED ARCH-CATALOG-WRITER: packages rogue writer is rejected while catalog-service migrations remain allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-packages-catalog-writer-"));
  const migrationRoot = await mkdtemp(
    join(tmpdir(), "coffee-catalog-migration-owner-"),
  );
  try {
    const directory = join(root, "packages/rogue/src");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "writer.ts"),
      'const query = "UPDATE catalog.catalog_state SET active_snapshot_ref = $1";\nvoid query;\n',
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /ARCH-CATALOG-WRITER/);
    assert.ok(
      output(result).includes("packages/rogue/src/writer.ts"),
      output(result),
    );

    const migrations = join(migrationRoot, "apps/catalog-service/migrations");
    await mkdir(migrations, { recursive: true });
    await writeFile(
      join(migrations, "0001-catalog.sql"),
      "CREATE TABLE catalog.products (id text PRIMARY KEY);\n",
    );
    const acceptedMigration = run("check-architecture.mjs", migrationRoot);
    assert.equal(acceptedMigration.status, 0, output(acceptedMigration));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(migrationRoot, { recursive: true, force: true });
  }
});

void test("RED ARCH-CATALOG-EVENT-ROWS: Catalog event schemas cannot publish full Catalog rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-catalog-event-rows-"));
  try {
    const directory = join(root, "contracts/schemas/events");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "catalog-snapshot-activated.v1.schema.json"),
      JSON.stringify({
        title: "CatalogSnapshotActivated.v1",
        properties: {
          payload: {
            type: "object",
            properties: {
              snapshotRef: { type: "string" },
              products: {
                type: "array",
                items: {
                  type: "object",
                  properties: { productRef: { type: "string" } },
                },
              },
            },
          },
        },
      }),
    );
    const result = run("check-architecture.mjs", root);
    assert.notEqual(result.status, 0, output(result));
    assert.match(output(result), /ARCH-CATALOG-EVENT-ROWS/);
    assert.match(output(result), /products/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
