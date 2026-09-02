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

const EFFECT_PACKAGES = Object.freeze([
  "effect", "@effect/platform-node", "@effect/platform-browser",
  "@effect/sql-pg", "@effect/opentelemetry", "@effect/atom-react",
  "@effect/vitest", "@effect/tsgo", "pg-copy-streams",
]);
const EFFECT_OVERRIDE_PACKAGES = Object.freeze(EFFECT_PACKAGES.slice(0, 7));
const SEMVER = /^[0-9]+(?:\.[0-9]+)+(?:-[0-9A-Za-z.-]+)?$/;

const REGISTRY_FIELDS = Object.freeze([
  "node", "npm", "corepack", "pnpm", "typescript", "typesNode", "fastify",
  "postgresql", "pg", "kafka", "confluentKafkaJavaScript", "librdkafka",
  "librdkafkaSourceSha256", "react", "reactDom", "reactRouterDom",
  "tanstackQuery", "vite", "vitest", "playwright", "openapi", "fastifySwagger",
  "heyApiOpenapiTs", "spectralCli", "ajv", "pino", "opentelemetryApi",
  "dependencyCruiser", "oxlint", "oxlintTsgolint", "prettier", "sops", "age",
  "docker", "compose", "nodeImage", "kafkaImage", "scheduler",
  "opentelemetrySemanticConventions", "opentelemetryResources",
  "opentelemetrySdkMetrics", "opentelemetrySdkTraceBase",
  "opentelemetrySdkTraceNode", "opentelemetryApiLogs",
  "opentelemetrySdkLogs",
]);

const ROOT_DEV_DEPENDENCIES = Object.freeze({
  "@hey-api/openapi-ts": "heyApiOpenapiTs",
  "@types/node": "typesNode",
  "dependency-cruiser": "dependencyCruiser",
  oxlint: "oxlint",
  "oxlint-tsgolint": "oxlintTsgolint",
  prettier: "prettier",
  typescript: "typescript",
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

function registryDependencyVersion(registry, name) {
  const manifestKey = DEPENDENCY_TO_MANIFEST_KEY[name];
  if (manifestKey) return registry[manifestKey];
  if (
    registry.effectTarget?.packages &&
    Object.hasOwn(registry.effectTarget.packages, name)
  )
    return registry.effectTarget.packages[name];
  return undefined;
}

function allDependencies(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  });
}

async function checkPackageManifests(root, registry) {
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
      const expectedVersion = registryDependencyVersion(registry, name);
      if (expectedVersion !== undefined)
        exact(value, expectedVersion, `${pathLabel}:${name}`);
      if (name === "redis")
        fail("TOOLCHAIN-PEER", `${pathLabel}: redis must not be materialized`);
      if (name === "typescript") {
        typescriptManifestCount += 1;
        if (path !== join(root, "package.json"))
          fail(
            "TS7-SINGLE-COMPILER",
            `${pathLabel}: TypeScript may only be declared at repository root`,
          );
        exact(value, registry.typescript, `${pathLabel}:${name}`);
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
    if (path === join(root, "package.json")) {
      exact(manifest.engines?.node, registry.node, "package.json.engines.node");
      exact(manifest.engines?.npm, registry.npm, "package.json.engines.npm");
      exact(manifest.engines?.pnpm, registry.pnpm, "package.json.engines.pnpm");
      exact(
        manifest.packageManager,
        `pnpm@${registry.pnpm}`,
        "package.json.packageManager",
      );
      for (const [name, registryKey] of Object.entries(ROOT_DEV_DEPENDENCIES)) {
        exact(
          manifest.devDependencies?.[name],
          registry[registryKey],
          `package.json.devDependencies.${name}`,
        );
      }
      for (const name of ["effect", "@effect/tsgo", "@effect/vitest"]) {
        exact(
          manifest.devDependencies?.[name],
          registryDependencyVersion(registry, name),
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

function lockResolvedVersion(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(
      `(?:^|\\n)      ['"]?${escaped}['"]?:\\n(?:        [^\\n]+\\n)*        version: ([^\\n]+)`,
      "m",
    ),
  );
  return match?.[1]?.trim();
}

function parseOverrides(document) {
  const lines = document.split("\n");
  const start = lines.indexOf("overrides:");
  if (start === -1) return null;
  const result = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("  ")) break;
    const match = line.match(/^  (?:'([^']+)'|"([^"]+)"|([^:]+)):\s*(\S+)\s*$/);
    if (match) result.set(match[1] ?? match[2] ?? match[3], match[4]);
  }
  return result;
}

function checkOverrides(overrides, registry, source) {
  if (
    !overrides ||
    overrides.size !== EFFECT_OVERRIDE_PACKAGES.length ||
    EFFECT_OVERRIDE_PACKAGES.some((name) => !overrides.has(name))
  )
    fail("TOOLCHAIN-PEER", `${source} Effect override set changed`);
  for (const name of EFFECT_OVERRIDE_PACKAGES)
    exact(
      overrides.get(name),
      registry.effectTarget.packages[name],
      `${source} override ${name}`,
    );
}

async function checkWorkspaceOverrides(root, registry) {
  const path = join(root, "pnpm-workspace.yaml");
  if (!existsSync(path)) return;
  checkOverrides(
    parseOverrides(await readText(path, "TOOLCHAIN-PEER")),
    registry,
    "pnpm-workspace.yaml",
  );
}

async function checkLockfile(root, manifest, registry) {
  const lockPath = join(root, "pnpm-lock.yaml");
  const lockfile = await readText(lockPath);
  if (!/^lockfileVersion:\s*["']9\.0["']\s*$/m.test(lockfile))
    fail("TOOLCHAIN-LOCK", "pnpm-lock.yaml must use lockfileVersion 9.0");
  const rootBlock = importerBlock(lockfile, ".");
  for (const [name, version] of allDependencies(manifest)) {
    const specifier = lockSpecifier(rootBlock, name);
    if (specifier === undefined)
      fail("TOOLCHAIN-LOCK", `root importer is missing ${name}`);
    const expectedVersion = registryDependencyVersion(registry, name);
    exact(specifier, expectedVersion ?? version, `pnpm-lock.yaml importer .:${name}`);
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
      const expectedVersion = registryDependencyVersion(registry, name);
      exact(specifier, expectedVersion ?? version, `pnpm-lock.yaml importer ${importer}:${name}`);
    }
  }

  const tsVersions = new Set();
  for (const match of lockfile.matchAll(
    /^  ['"]?typescript@([^'":()\s]+)['"]?(?::|\()/gm,
  ))
    tsVersions.add(match[1]);
  if (tsVersions.size !== 1 || !tsVersions.has(registry.typescript)) {
    fail(
      "TS7-SINGLE-COMPILER",
      `pnpm-lock.yaml TypeScript packages must be exactly ${registry.typescript}, got ${[...tsVersions].join(", ") || "none"}`,
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

  checkOverrides(
    parseOverrides(lockfile),
    registry,
    "pnpm-lock.yaml",
  );

  for (const name of EFFECT_PACKAGES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const versions = new Set(
      [...lockfile.matchAll(
        new RegExp(`^  ['"]?${escaped}@([^'":()\\s]+)['"]?(?::|\\()`, "gm"),
      )].map((match) => match[1]),
    );
    if (versions.size === 0) continue;
    if (versions.size !== 1 || !versions.has(registry.effectTarget.packages[name]))
      fail(
        "TOOLCHAIN-LOCK",
        `pnpm-lock.yaml ${name} versions must be exactly ${registry.effectTarget.packages[name]}, got ${[...versions].join(", ")}`,
      );
  }

  const resolvedEffectVitest = lockResolvedVersion(rootBlock, "@effect/vitest");
  if (
    !resolvedEffectVitest?.includes(`effect@${registry.effectTarget.packages.effect}`) ||
    !resolvedEffectVitest.includes(`vitest@${registry.vitest}`)
  )
    fail(
      "TOOLCHAIN-PEER",
      "pnpm-lock.yaml @effect/vitest must resolve direct effect and vitest peers",
    );
  if (/^  ['"]?redis@/m.test(lockfile))
    fail("TOOLCHAIN-PEER", "pnpm-lock.yaml must not materialize redis");
}

async function checkManifest(root) {
  const manifest = await readJson(join(root, "config/toolchain-versions.json"));
  exact(manifest.schemaVersion, 2, "config/toolchain-versions.json.schemaVersion");
  for (const key of REGISTRY_FIELDS) {
    if (typeof manifest[key] !== "string" || manifest[key].length === 0)
      fail("TOOLCHAIN-REGISTRY", `config/toolchain-versions.json.${key}: non-empty registry value required`);
  }
  for (const key of ["nodeImage", "kafkaImage"]) {
    if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(manifest[key]))
      fail("TOOLCHAIN-IMAGE", `config/toolchain-versions.json.${key}: exact digest required`);
  }
  const target = manifest.effectTarget;
  if (!target || typeof target !== "object") fail("TOOLCHAIN-REGISTRY", "effectTarget: registry target required");
  if (target.authorityRef !== "docs/adr/ADR-0024-effect-native-platform.md" ||
      target.materializationOwner !== "issue-49" || target.generatedOpenApi !== "3.1.0")
    fail("TOOLCHAIN-REGISTRY", "effectTarget: Effect materialization projection changed");
  if (!target.packages || typeof target.packages !== "object")
    fail("TOOLCHAIN-REGISTRY", "effectTarget.packages: package set required");
  if (JSON.stringify(Object.keys(target.packages)) !== JSON.stringify(EFFECT_PACKAGES))
    fail("TOOLCHAIN-REGISTRY", "effectTarget.packages: exact package set changed");
  if (!Object.values(target.packages).every((value) => typeof value === "string" && SEMVER.test(value)))
    fail("TOOLCHAIN-REGISTRY", "effectTarget.packages: exact semver values required");
  if (new Set(EFFECT_PACKAGES.slice(0, -2).map((name) => target.packages[name])).size !== 1)
    fail("TOOLCHAIN-REGISTRY", "effectTarget.packages: Effect packages must share one release version");
  const registrySchema = await readJson(join(root, "config/toolchain-versions.schema.json"));
  const hasNumericVersionConst = (value) => {
    if (Array.isArray(value)) return value.some(hasNumericVersionConst);
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
      (key === "const" && typeof child === "string" && SEMVER.test(child)) || hasNumericVersionConst(child),
    );
  };
  if (hasNumericVersionConst(registrySchema))
    fail("TOOLCHAIN-REGISTRY", "toolchain-versions.schema.json must not duplicate exact version pins");
  const foundation = await readJson(join(root, "platform/runtime-foundation-decision.json"));
  if (foundation.schemaVersion !== 2)
    fail("TOOLCHAIN-REGISTRY", "runtime-foundation-decision.json.schemaVersion must be 2");
  const effectDecision = foundation.effectPlatformDecision;
  if (!effectDecision || effectDecision.bomRef !== "config/toolchain-versions.json" ||
      JSON.stringify(effectDecision.packageAuthority) !== JSON.stringify(EFFECT_PACKAGES) ||
      Object.hasOwn(effectDecision, "bom") || Object.hasOwn(effectDecision, "versions"))
    fail("TOOLCHAIN-REGISTRY", "runtime foundation must reference the canonical Effect package registry");
  for (const field of ["openApiGenerator", "openApiGeneratorPlugin", "generatorMode"]) {
    if (Object.hasOwn(foundation.toolchainDecision ?? {}, field))
      fail("TOOLCHAIN-REGISTRY", `runtime foundation removed field ${field} is forbidden`);
  }
  return manifest;
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
      if (document.extends !== "../../tsconfig.base.json")
        fail("TS7-REFERENCES", `${label} must extend ../../tsconfig.base.json`);
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

async function checkForbiddenNodeRedis(root) {
  const sourcePaths = [
    ...(await walk(join(root, "apps"))),
    ...(await walk(join(root, "packages"))),
  ].filter((path) => /\.(?:mjs|ts|tsx|js|jsx)$/.test(path));
  for (const path of sourcePaths) {
    const source = await readText(path, "TOOLCHAIN-PEER");
    if (/\bNodeRedis\b/.test(source))
      fail(
        "TOOLCHAIN-PEER",
        `${relative(root, path).replaceAll("\\", "/")}: NodeRedis import is forbidden`,
      );
  }
}

export async function checkToolchainVersions(root = REPO_ROOT) {
  const resolvedRoot = resolve(root);
  const registry = await checkManifest(resolvedRoot);
  await checkPackageManifests(resolvedRoot, registry);
  await checkWorkspaceOverrides(resolvedRoot, registry);
  const packageJson = await readJson(join(resolvedRoot, "package.json"));
  await checkLockfile(resolvedRoot, packageJson, registry);
  await checkForbiddenNodeRedis(resolvedRoot);
  exact(
    (
      await readText(join(resolvedRoot, ".node-version"), "TOOLCHAIN-PIN")
    ).trim(),
    registry.node,
    ".node-version",
  );
  await checkTsConfigs(resolvedRoot);
  await checkFinalImages(resolvedRoot);
  return { typescript: registry.typescript, node: registry.node };
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
