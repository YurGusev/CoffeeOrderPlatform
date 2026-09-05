import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

void test("GREEN: versioned contract import is accepted by Dependency Cruiser 18.2.0 wrapper", () => {
  const result = run("check-architecture.mjs", join(FIXTURES, "valid-import"));
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /Dependency Cruiser 18\.2\.0/);
});

void test("RED BOUND-CONTRACT-AUDIENCE: browser cannot reach internal types through a domain re-export", () => {
  const result = run("check-architecture.mjs", join(FIXTURES, "invalid-browser-transitive-internal"));
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

void test("GREEN: exact TS7 toolchain manifest, lockfile and config baseline passes", () => {
  const result = run("check-toolchain-versions.mjs");
  assert.equal(result.status, 0, output(result));
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
    await mkdir(directory, {recursive: true});
    for (const moduleName of ["pg", "pg-copy-streams", "@coffee-platform/database/owner", "../../../packages/platform-database/dist/internal.js", "@effect/sql-pg"]) {
      await writeFile(join(directory, "handler.ts"), `import * as forbidden from ${JSON.stringify(moduleName)};\nvoid forbidden;\n`);
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /BOUND-DB-CLIENT/);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

void test("RED BOUND-KAFKA-CLIENT: handlers cannot bypass bounded delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "coffee-kafka-boundary-"));
  const directory = join(root, "apps/orders-service/src");
  try {
    await mkdir(directory, {recursive: true});
    for (const moduleName of ["@confluentinc/kafka-javascript", "@confluentinc/kafka-javascript/promisified", "../../../packages/platform-kafka-runtime/dist/native.js"]) {
      await writeFile(join(directory, "handler.ts"), `import * as forbidden from ${JSON.stringify(moduleName)};\nvoid forbidden;\n`);
      const result = run("check-architecture.mjs", root);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), /BOUND-KAFKA-CLIENT/);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
