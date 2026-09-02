#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  "node_modules/@effect/tsgo",
  "node_modules/@effect/vitest",
  "node_modules/@hey-api/openapi-ts",
  "node_modules/dependency-cruiser",
  "node_modules/oxlint",
  "node_modules/oxlint-tsgolint",
  "node_modules/playwright",
  "node_modules/playwright-core",
  "node_modules/prettier",
  "node_modules/typescript",
  "node_modules/vite",
  "node_modules/vitest",
]);

const FORBIDDEN_STORE_PREFIXES = Object.freeze([
  "@effect+tsgo@",
  "@effect+vitest@",
  "@hey-api+openapi-ts@",
  "@oxlint+",
  "@playwright+",
  "@typescript+typescript-",
  "dependency-cruiser@",
  "oxlint-tsgolint@",
  "oxlint@",
  "playwright-core@",
  "playwright@",
  "prettier@",
  "typescript@",
  "vite@",
  "vitest@",
]);

const FORBIDDEN_BINARIES = Object.freeze([
  "depcruise",
  "effect-tsgo",
  "oxlint",
  "playwright",
  "prettier",
  "tsc",
  "tsserver",
  "vite",
  "vitest",
]);

function fail(message) {
  throw new Error(`TOOLCHAIN-FINAL-IMAGE ${message}`);
}

function parseArguments(argv) {
  const imageIndex = argv.indexOf("--image");
  const image = imageIndex === -1 ? process.env.COFFEE_RUNTIME_IMAGE : argv[imageIndex + 1];
  if (typeof image !== "string" || image.length === 0) {
    fail("--image <tag-or-digest> or COFFEE_RUNTIME_IMAGE is required");
  }
  return { image };
}

const probe = String.raw`
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const forbiddenPaths = ${JSON.stringify(FORBIDDEN_PACKAGE_PATHS)};
const forbiddenStorePrefixes = ${JSON.stringify(FORBIDDEN_STORE_PREFIXES)};
const forbiddenBinaries = new Set(${JSON.stringify(FORBIDDEN_BINARIES)});
const roots = ["/app", "/usr/local/lib/node_modules"];
const findings = new Set();

function normalized(path) {
  return path.replaceAll("\\\\", "/").replace(/\/+$/, "");
}

function inspect(path) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    return;
  }

  const label = normalized(path);
  if (forbiddenPaths.some((suffix) => label.endsWith("/" + suffix))) {
    findings.add(label);
  }

  const virtualStoreMarker = "/node_modules/.pnpm/";
  const virtualStoreIndex = label.indexOf(virtualStoreMarker);
  if (virtualStoreIndex >= 0) {
    const packageKey = label.slice(virtualStoreIndex + virtualStoreMarker.length).split("/")[0] ?? "";
    if (forbiddenStorePrefixes.some((prefix) => packageKey.startsWith(prefix))) {
      findings.add(label.slice(0, virtualStoreIndex + virtualStoreMarker.length) + packageKey);
    }
  }

  if (label.includes("/node_modules/.bin/") && forbiddenBinaries.has(basename(label))) {
    findings.add(label);
  }

  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  for (const child of readdirSync(path)) inspect(join(path, child));
}

for (const root of roots) {
  if (existsSync(root)) inspect(root);
}

if (!existsSync("/app/dist/main.js")) {
  findings.add("/app/dist/main.js is missing");
}
if (findings.size > 0) {
  console.error(JSON.stringify({ result: "failed", findings: [...findings].sort() }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  result: "passed",
  network: "none",
  runtimeEntry: "/app/dist/main.js",
  forbiddenPackageCount: forbiddenPaths.length,
  forbiddenStorePrefixCount: forbiddenStorePrefixes.length,
  forbiddenBinaryCount: forbiddenBinaries.size
}));
`;

try {
  const { image } = parseArguments(process.argv.slice(2));
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
      "--eval",
      probe,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    },
  );

  if (result.error) fail(`docker run failed: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `image ${image} contains forbidden tooling or could not be inspected:\n`
      + `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    );
  }
  process.stdout.write(result.stdout);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
