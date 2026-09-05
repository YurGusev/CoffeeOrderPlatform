#!/usr/bin/env node
/**
 * Проверка единственного TS7-native toolchain baseline.
 *
 * Этот checker намеренно не выполняет install/build: он проверяет identity
 * файлов, которые уже должны быть закоммичены, и поэтому одинаково работает
 * в clean clone и в CI до materialization runtime images.
 */
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED = Object.freeze({
  node: "26.8.1",
  npm: "11.19.0",
  corepack: "0.35.0",
  pnpm: "11.24.0",
  typescript: "7.0.2",
  fastify: "5.12.1",
  postgresql: "17.11",
  pg: "8.23.0",
  libphonenumberJs: "1.13.12",
  pgCopyStreams: "7.0.0",
  typesPg: "8.23.1",
  typesPgCopyStreams: "1.2.5",
  kafka: "4.3.1",
  confluentKafkaJavaScript: "1.10.0",
  librdkafka: "2.15.0",
  librdkafkaSourceSha256:
    "259015220cdca708afe838b5aa79ebf1a5fb710fb4179cf918d390aed85d5dbc",
  react: "19.2.8",
  reactDom: "19.2.8",
  reactRouterDom: "7.18.3",
  tanstackQuery: "5.102.8",
  vite: "8.2.2",
  vitest: "4.1.11",
  playwright: "1.62.1",
  openapi: "3.2.0",
  fastifySwagger: "9.8.1",
  heyApiOpenapiTs: "0.0.0-next-20260824173136",
  spectralCli: "6.16.3",
  ajv: "8.20.0",
  pino: "10.3.1",
  opentelemetryApi: "1.9.1",
  dependencyCruiser: "18.2.0",
  oxlint: "1.80.0",
  oxlintTsgolint: "7.0.2001",
  prettier: "3.9.6",
  sops: "3.13.3",
  age: "1.3.2",
  docker: "29.7.2",
  compose: "5.4.0",
});

const ROOT_DEV_DEPENDENCIES = Object.freeze({
  "@hey-api/openapi-ts": "0.0.0-next-20260824173136",
  "@types/node": "26.4.0",
  "dependency-cruiser": "18.2.0",
  oxlint: "1.80.0",
  "oxlint-tsgolint": "7.0.2001",
  prettier: "3.9.6",
  typescript: "7.0.2",
});

const DEPENDENCY_TO_MANIFEST_KEY = Object.freeze({
  "@confluentinc/kafka-javascript": "confluentKafkaJavaScript",
  "@fastify/swagger": "fastifySwagger",
  "@hey-api/openapi-ts": "heyApiOpenapiTs",
  "@tanstack/react-query": "tanstackQuery",
  "dependency-cruiser": "dependencyCruiser",
  fastify: "fastify",
  oxlint: "oxlint",
  "oxlint-tsgolint": "oxlintTsgolint",
  pg: "pg",
  "libphonenumber-js": "libphonenumberJs",
  "pg-copy-streams": "pgCopyStreams",
  "@types/pg": "typesPg",
  "@types/pg-copy-streams": "typesPgCopyStreams",
  playwright: "playwright",
  prettier: "prettier",
  react: "react",
  "react-dom": "reactDom",
  "react-router-dom": "reactRouterDom",
  spectral: "spectralCli",
  "@stoplight/spectral-cli": "spectralCli",
  typescript: "typescript",
  vite: "vite",
  vitest: "vitest",
});

const FORBIDDEN_COMPILER_PACKAGES = new Set([
  "typescript-eslint",
  "ts-node",
  "tsx",
  "@typescript/native-preview",
]);

function fail(rule, message) {
  const error = new Error(`${rule} ${message}`);
  error.ruleId = rule;
  throw error;
}

async function readText(path, rule = "TOOLCHAIN-FILE") {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    fail(rule, `${path}: cannot read: ${error.message}`);
  }
}

async function readJson(path, rule = "TOOLCHAIN-FILE") {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(rule, `${path}: strict JSON is required: ${error.message}`);
  }
}

async function walk(root) {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(path)));
    else result.push(path);
  }
  return result;
}

function exact(value, expected, label) {
  if (value !== expected)
    fail(
      "TOOLCHAIN-PIN",
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`,
    );
}

function isFloatingSpec(value) {
  if (value === "latest" || value === "*" || value === "") return true;
  if (/^(?:\^|~|[<>=]|\*|x|X)/.test(value)) return true;
  if (/(?:\*|x|X)(?:\.|$)/.test(value)) return true;
  if (/^(?:git\+|git:|https?:|file:|link:|npm:)/.test(value)) return true;
  return false;
}

function checkDependencySpec(value, label) {
  if (typeof value !== "string")
    fail("TOOLCHAIN-PIN", `${label}: dependency specifier must be a string`);
  // workspace:* is the lockfile protocol for an internal package link. It does
  // not select a registry version and is the only wildcard accepted here.
  if (value.startsWith("workspace:")) {
    if (value !== "workspace:*")
      fail(
        "TOOLCHAIN-PIN",
        `${label}: only workspace:* is allowed for local links`,
      );
    return;
  }
  if (isFloatingSpec(value))
    fail(
      "TOOLCHAIN-PIN",
      `${label}: floating or non-registry specifier ${value}`,
    );
}

function allDependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
}

async function checkPackageManifests(root) {
  const manifestPaths = [
    join(root, "package.json"),
    ...(await walk(join(root, "apps"))),
    ...(await walk(join(root, "packages"))),
  ].filter((path) => path.endsWith("package.json"));
  if (!existsSync(join(root, "package.json")))
    fail("TOOLCHAIN-FILE", "package.json is missing");

  let typescriptManifestCount = 0;
  for (const path of manifestPaths) {
    const manifest = await readJson(path);
    const pathLabel = relative(root, path).replaceAll("\\", "/");
    if (manifest.type !== "module")
      fail("TS7-ESM", `${pathLabel}: package type must be module`);
    if (pathLabel.startsWith("apps/")) {
      if (
        Object.hasOwn(manifest, "types") ||
        Object.hasOwn(manifest, "typings")
      )
        fail(
          "TS7-APP-DECLARATIONS",
          `${pathLabel}: apps must not publish a declaration entrypoint`,
        );
      const hasDeclarationExport = (value) => {
        if (typeof value === "string") return value.endsWith(".d.ts");
        if (Array.isArray(value)) return value.some(hasDeclarationExport);
        if (value === null || typeof value !== "object") return false;
        if (Object.hasOwn(value, "types")) return true;
        return Object.values(value).some(hasDeclarationExport);
      };
      if (
        Object.hasOwn(manifest, "exports") &&
        hasDeclarationExport(manifest.exports)
      )
        fail(
          "TS7-APP-DECLARATIONS",
          `${pathLabel}: apps must not expose declarations through exports`,
        );
    }
    for (const [name, value] of allDependencies(manifest)) {
      checkDependencySpec(value, `${pathLabel}:${name}`);
      const manifestKey = DEPENDENCY_TO_MANIFEST_KEY[name];
      if (manifestKey)
        exact(value, EXPECTED[manifestKey], `${pathLabel}:${name}`);
      if (name === "pg-copy-streams" && pathLabel !== "packages/platform-database/package.json")
        fail("DATABASE-COPY-SCOPE", `${pathLabel}: COPY driver belongs to platform-database`);
      if (name === "typescript") {
        typescriptManifestCount += 1;
        if (path !== join(root, "package.json"))
          fail(
            "TS7-SINGLE-COMPILER",
            `${pathLabel}: TypeScript may only be declared at repository root`,
          );
        exact(value, EXPECTED.typescript, `${pathLabel}:${name}`);
      }
      if (
        FORBIDDEN_COMPILER_PACKAGES.has(name) ||
        name.startsWith("@typescript-eslint/")
      ) {
        fail(
          "TS7-SINGLE-COMPILER",
          `${pathLabel}: forbidden compiler lane package ${name}`,
        );
      }
    }
    if (pathLabel === "packages/platform-database/package.json") {
      exact(manifest.dependencies?.pg, EXPECTED.pg, `${pathLabel}:pg`);
      exact(manifest.dependencies?.["pg-copy-streams"], EXPECTED.pgCopyStreams, `${pathLabel}:pg-copy-streams`);
      exact(manifest.devDependencies?.["@types/pg"], EXPECTED.typesPg, `${pathLabel}:@types/pg`);
      exact(manifest.devDependencies?.["@types/pg-copy-streams"], EXPECTED.typesPgCopyStreams, `${pathLabel}:@types/pg-copy-streams`);
    }
    if (path === join(root, "package.json")) {
      exact(manifest.engines?.node, EXPECTED.node, "package.json.engines.node");
      exact(manifest.engines?.npm, EXPECTED.npm, "package.json.engines.npm");
      exact(manifest.engines?.pnpm, EXPECTED.pnpm, "package.json.engines.pnpm");
      exact(
        manifest.packageManager,
        `pnpm@${EXPECTED.pnpm}`,
        "package.json.packageManager",
      );
      for (const [name, expected] of Object.entries(ROOT_DEV_DEPENDENCIES)) {
        exact(
          manifest.devDependencies?.[name],
          expected,
          `package.json.devDependencies.${name}`,
        );
      }
    }
  }
  exact(
    typescriptManifestCount,
    1,
    "package manifests TypeScript declaration count",
  );
}

function importerBlock(lockfile, importer) {
  const marker = importer === "." ? "  .:" : `  ${importer}:`;
  if (lockfile.includes(`\n${marker} {}`)) return "";
  const start = lockfile.indexOf(`\n${marker}\n`);
  if (start === -1)
    fail("TOOLCHAIN-LOCK", `pnpm-lock.yaml importer ${importer} is missing`);
  const bodyStart = start + marker.length + 2;
  const nextImporter = lockfile.slice(bodyStart).search(/^  \S/m);
  // The first next-level importer starts at column two. A root importer is
  // followed by another importer; the final importer is followed by packages.
  const end = nextImporter === -1 ? lockfile.length : bodyStart + nextImporter;
  return lockfile.slice(bodyStart, end);
}

function lockSpecifier(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(
      `(?:^|\\n)      ['"]?${escaped}['"]?:\\n        specifier: ([^\\n]+)`,
      "m",
    ),
  );
  return match?.[1]?.trim();
}

async function checkLockfile(root, manifest) {
  const lockPath = join(root, "pnpm-lock.yaml");
  const lockfile = await readText(lockPath);
  if (!/^lockfileVersion:\s*["']9\.0["']\s*$/m.test(lockfile))
    fail("TOOLCHAIN-LOCK", "pnpm-lock.yaml must use lockfileVersion 9.0");
  const rootBlock = importerBlock(lockfile, ".");
  for (const [name, version] of allDependencies(manifest)) {
    const specifier = lockSpecifier(rootBlock, name);
    if (specifier === undefined)
      fail("TOOLCHAIN-LOCK", `root importer is missing ${name}`);
    exact(specifier, version, `pnpm-lock.yaml importer .:${name}`);
  }

  const workspaceManifests = [
    ...(await walk(join(root, "apps"))),
    ...(await walk(join(root, "packages"))),
  ].filter((path) => path.endsWith("package.json"));
  for (const path of workspaceManifests) {
    const workspaceManifest = await readJson(path);
    const importer = relative(root, dirname(path)).replaceAll("\\", "/") || ".";
    const block = importerBlock(lockfile, importer);
    for (const [name, version] of allDependencies(workspaceManifest)) {
      const specifier = lockSpecifier(block, name);
      if (specifier === undefined)
        fail(
          "TOOLCHAIN-LOCK",
          `pnpm-lock.yaml importer ${importer} is missing ${name}`,
        );
      exact(specifier, version, `pnpm-lock.yaml importer ${importer}:${name}`);
    }
  }

  const tsVersions = new Set();
  for (const match of lockfile.matchAll(
    /^  ['"]?typescript@([^'":()\s]+)['"]?(?::|\()/gm,
  ))
    tsVersions.add(match[1]);
  if (tsVersions.size !== 1 || !tsVersions.has(EXPECTED.typescript)) {
    fail(
      "TS7-SINGLE-COMPILER",
      `pnpm-lock.yaml TypeScript packages must be exactly ${EXPECTED.typescript}, got ${[...tsVersions].join(", ") || "none"}`,
    );
  }
  if (
    /(?:^|\n)\s{2}['"]?(?:@typescript\/native-preview|typescript-eslint|@typescript-eslint\/)/m.test(
      lockfile,
    )
  ) {
    fail(
      "TS7-SINGLE-COMPILER",
      "pnpm-lock.yaml contains a forbidden compiler lane",
    );
  }
}

async function checkManifest(root) {
  const manifest = await readJson(join(root, "config/toolchain-versions.json"));
  const foundation = await readJson(
    join(root, "platform/runtime-foundation-decision.json"),
  );
  for (const [key, expected] of Object.entries(EXPECTED))
    exact(manifest[key], expected, `config/toolchain-versions.json.${key}`);
  exact(
    manifest.nodeImage,
    foundation.productionImage?.reference,
    "config/toolchain-versions.json.nodeImage",
  );
  exact(
    manifest.kafkaImage,
    "apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837",
    "config/toolchain-versions.json.kafkaImage",
  );
  if (
    !/^node:26\.8\.1-bookworm-slim@sha256:[0-9a-f]{64}$/.test(
      manifest.nodeImage,
    )
  )
    fail("TOOLCHAIN-IMAGE", "nodeImage must use an exact digest");
  if (!/^apache\/kafka:4\.3\.1@sha256:[0-9a-f]{64}$/.test(manifest.kafkaImage))
    fail("TOOLCHAIN-IMAGE", "kafkaImage must use an exact digest");
}

function checkTsConfigDocument(document, pathLabel) {
  const options = document.compilerOptions ?? {};
  if (Object.hasOwn(document, "baseUrl") || Object.hasOwn(options, "baseUrl"))
    fail("TS7-BASELINE", `${pathLabel}: baseUrl is forbidden`);
  if (options.module === "commonjs" || options.module === "CommonJS")
    fail("TS7-ESM", `${pathLabel}: CommonJS module output is forbidden`);
  if (pathLabel === "tsconfig.json") {
    if (JSON.stringify(document.files) !== "[]")
      fail("TS7-REFERENCES", "root tsconfig.json must have files=[]");
    if (!Array.isArray(document.references) || document.references.length === 0)
      fail(
        "TS7-REFERENCES",
        "root tsconfig.json must contain project references",
      );
  }
}

function exactTsOption(options, key, expected, pathLabel, rule) {
  if (JSON.stringify(options[key]) !== JSON.stringify(expected))
    fail(
      rule,
      `${pathLabel}.compilerOptions.${key} must be ${JSON.stringify(expected)}, got ${JSON.stringify(options[key])}`,
    );
}

async function checkTsConfigs(root) {
  const paths = [
    join(root, "tsconfig.json"),
    join(root, "tsconfig.base.json"),
    ...(await walk(join(root, "apps"))),
    ...(await walk(join(root, "packages"))),
  ].filter((path) => path.endsWith(".json") && path.includes("tsconfig"));
  for (const path of paths) {
    const label = relative(root, path).replaceAll("\\", "/");
    const document = await readJson(path, "TS7-BASELINE");
    checkTsConfigDocument(document, label);
    const options = document.compilerOptions ?? {};
    if (label === "tsconfig.base.json") {
      exactTsOption(options, "target", "ES2025", label, "TS7-BACKEND");
      exactTsOption(options, "module", "NodeNext", label, "TS7-BACKEND");
      exactTsOption(
        options,
        "moduleResolution",
        "NodeNext",
        label,
        "TS7-BACKEND",
      );
      exactTsOption(options, "lib", ["ES2025"], label, "TS7-BACKEND");
      for (const key of [
        "strict",
        "noUncheckedIndexedAccess",
        "exactOptionalPropertyTypes",
        "noUncheckedSideEffectImports",
        "noImplicitOverride",
        "noImplicitReturns",
        "noFallthroughCasesInSwitch",
        "noPropertyAccessFromIndexSignature",
        "useUnknownInCatchVariables",
        "forceConsistentCasingInFileNames",
        "verbatimModuleSyntax",
        "isolatedModules",
        "erasableSyntaxOnly",
      ]) {
        if (options[key] !== true)
          fail("TS7-BASELINE", `${label}.compilerOptions.${key} must be true`);
      }
      if (options.skipLibCheck !== false)
        fail(
          "TS7-BASELINE",
          `${label}.compilerOptions.skipLibCheck must be false`,
        );
    }
    if (label.startsWith("apps/") && label.endsWith("/tsconfig.json")) {
      if (document.extends !== "../../tsconfig.base.json")
        fail("TS7-REFERENCES", `${label} must extend ../../tsconfig.base.json`);
      if (label === "apps/web/tsconfig.json") {
        exactTsOption(options, "target", "ES2025", label, "TS7-FRONTEND");
        exactTsOption(options, "module", "ESNext", label, "TS7-FRONTEND");
        exactTsOption(
          options,
          "moduleResolution",
          "Bundler",
          label,
          "TS7-FRONTEND",
        );
        exactTsOption(
          options,
          "lib",
          ["ES2025", "DOM", "DOM.Iterable"],
          label,
          "TS7-FRONTEND",
        );
        if (options.noEmit !== true)
          fail("TS7-FRONTEND", `${label}.compilerOptions.noEmit must be true`);
        if (
          options.declaration === true ||
          options.emitDeclarationOnly === true
        )
          fail(
            "TS7-APP-DECLARATIONS",
            `${label}: frontend apps must not emit declarations`,
          );
      } else {
        if (options.noEmit === true)
          fail(
            "TS7-BACKEND",
            `${label}: backend projects must emit runtime JavaScript`,
          );
        for (const [key, expected] of [
          ["target", "ES2025"],
          ["module", "NodeNext"],
          ["moduleResolution", "NodeNext"],
          ["lib", ["ES2025"]],
        ]) {
          if (Object.hasOwn(options, key))
            exactTsOption(options, key, expected, label, "TS7-BACKEND");
        }
      }
    }
    if (label === "apps/web/tsconfig.runtime.json") {
      if (document.extends !== "../../tsconfig.base.json")
        fail("TS7-BACKEND", `${label} must extend ../../tsconfig.base.json`);
      if (options.noEmit === true)
        fail("TS7-BACKEND", `${label} must emit the runnable web shell`);
      if (options.composite !== true)
        fail("TS7-BACKEND", `${label}.compilerOptions.composite must be true`);
    }
    if (label.startsWith("packages/")) {
      const base = relative(dirname(path), join(root, "tsconfig.base.json")).replaceAll("\\", "/");
      if (document.extends !== base)
        fail("TS7-REFERENCES", `${label} must extend ${base}`);
      for (const key of ["composite", "declaration", "isolatedDeclarations"]) {
        if (options[key] !== true)
          fail(
            "TS7-REFERENCES",
            `${label}.compilerOptions.${key} must be true for technical/contract packages`,
          );
      }
    }
  }
}

function finalDockerStage(text) {
  const stages = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const from = line.match(/^\s*FROM\s+(.+?)(?:\s+AS\s+([\w.-]+))?\s*$/i);
    if (from) {
      current = { name: from[2] ?? null, lines: [] };
      stages.push(current);
    } else if (current) current.lines.push(line);
  }
  return stages.at(-1);
}

async function checkFinalImages(root) {
  const dockerfiles = (await walk(root)).filter((path) => {
    const label = relative(root, path).replaceAll("\\", "/");
    return (
      !label.startsWith("node_modules/") &&
      !label.startsWith("docs/") &&
      !label.startsWith("tests/") &&
      (/(?:^|\/)Dockerfile(?:\..*)?$/.test(label) ||
        label.endsWith(".Dockerfile"))
    );
  });
  const buildTool =
    /\b(?:typescript|tsc|oxlint|tsgolint|openapi-ts|prettier|spectral)\b/i;
  for (const path of dockerfiles) {
    const stage = finalDockerStage(await readText(path));
    if (!stage) continue;
    const pathLabel = relative(root, path).replaceAll("\\", "/");
    for (const line of stage.lines) {
      const content = line.replace(/#.*$/, "");
      if (buildTool.test(content))
        fail(
          "TOOLCHAIN-FINAL-IMAGE",
          `${pathLabel}: build tool appears in the final image stage`,
        );
      if (
        /^\s*RUN\s+.*(?:npm|pnpm|yarn)\s+install\b/i.test(content) &&
        !/(?:--omit=dev|--production|--prod)\b/i.test(content)
      ) {
        fail(
          "TOOLCHAIN-FINAL-IMAGE",
          `${pathLabel}: final image installs development dependencies`,
        );
      }
      if (
        /^\s*COPY\s+--from=(?:builder|build|toolchain)\b.*\bnode_modules\b/i.test(
          content,
        )
      ) {
        fail(
          "TOOLCHAIN-FINAL-IMAGE",
          `${pathLabel}: final image copies builder node_modules`,
        );
      }
    }
  }
}

export async function checkToolchainVersions(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  await checkManifest(resolvedRoot);
  await checkPackageManifests(resolvedRoot);
  const packageJson = await readJson(join(resolvedRoot, "package.json"));
  await checkLockfile(resolvedRoot, packageJson);
  exact(
    (
      await readText(join(resolvedRoot, ".node-version"), "TOOLCHAIN-PIN")
    ).trim(),
    EXPECTED.node,
    ".node-version",
  );
  await checkTsConfigs(resolvedRoot);
  await checkFinalImages(resolvedRoot);
  return { typescript: EXPECTED.typescript, node: EXPECTED.node };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkToolchainVersions(
      parseRoot(process.argv.slice(2)),
    );
    console.log(
      `toolchain versions: passed (Node ${result.node}, TypeScript ${result.typescript})`,
    );
  } catch (error) {
    console.error(`toolchain versions: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
