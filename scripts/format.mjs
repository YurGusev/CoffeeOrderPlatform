#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORMATTABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".css",
  ".scss",
  ".html",
]);
const EXCLUDED_ROOTS = [
  "docs/",
  "evidence/",
  "secrets/",
  "packages/generated/",
  "packages/platform-ui/provenance/",
  ".codex/",
  ".git/",
];
const EXCLUDED_FILES = new Set([
  "apps/edge-gateway/src/client-operations.gen.ts",
]);

export function selectFormatPaths(gitPaths, existingPaths = gitPaths) {
  const existing = new Set(existingPaths);
  return [
    ...new Set(
      gitPaths.filter((path) => {
        if (
          !existing.has(path) ||
          EXCLUDED_FILES.has(path) ||
          path === "pnpm-lock.yaml" ||
          !FORMATTABLE_EXTENSIONS.has(resolveExtension(path))
        )
          return false;
        if (EXCLUDED_ROOTS.some((prefix) => path.startsWith(prefix)))
          return false;
        return !path
          .split("/")
          .some(
            (part) =>
              part === "node_modules" || part === "dist" || part === "coverage",
          );
      }),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function resolveExtension(path) {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot) : "";
}

function main(argv) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--write")) {
    process.stderr.write("usage: node scripts/format.mjs [--write]\n");
    process.exitCode = 2;
    return;
  }
  const mode = argv[0] === "--write" ? "--write" : "--check";
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: ROOT },
  );
  const gitPaths = output.toString("utf8").split("\0").filter(Boolean);
  const existingPaths = gitPaths.filter((path) => {
    try {
      return lstatSync(resolve(ROOT, path)).isFile();
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
  });
  const paths = selectFormatPaths(gitPaths, existingPaths);
  if (paths.length === 0) {
    process.stderr.write(
      "format: no tracked or non-ignored source files found\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    execFileSync("pnpm", ["exec", "prettier", mode, "--", ...paths], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (error) {
    if (Number.isInteger(error.status)) process.exitCode = error.status;
    else throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2));
