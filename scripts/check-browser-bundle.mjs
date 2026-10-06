#!/usr/bin/env node
import { glob, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserRoot = join(root, "apps/web/dist/browser");
const INITIAL_JS_GZIP_BUDGET_BYTES = 250 * 1024;
const forbidden = [
  { rule: "BUNDLE-NODE", pattern: /(?:["']node:[^"']+["']|@coffee-platform\/runtime|process\.env)/, message: "Node/runtime code" },
  { rule: "BUNDLE-NETWORK", pattern: /\bfetch\(\s*["'`](?:\/|https?:)/, message: "network call" },
  { rule: "BUNDLE-PROVIDER", pattern: /["'`][^"'`]*(?:https?:\/\/[^"'`]*(?:aroma|provider)|(?:aroma|provider)\.(?:internal|local|ru|com)(?=[:/"'`])|localhost:\d{2,5})[^"'`]*["'`]/, message: "provider/server endpoint" },
];

if (!existsSync(browserRoot)) {
  throw new Error(`BUNDLE-MISSING browser output is absent: ${browserRoot}`);
}

const violations = [];
const files = [];
let gzipBytes = 0;
for await (const relativePath of glob("**/*.js", { cwd: browserRoot })) files.push(relativePath);
files.sort();
for (const relativePath of files) {
  const path = resolve(browserRoot, relativePath);
  const source = await readFile(path, "utf8");
  gzipBytes += gzipSync(source).byteLength;
  for (const item of forbidden) {
    if (item.pattern.test(source)) violations.push(`${item.rule} ${path}: ${item.message}`);
  }
}

if (violations.length > 0) throw new Error(violations.join("\n"));
if (gzipBytes > INITIAL_JS_GZIP_BUDGET_BYTES) {
  throw new Error(`BUNDLE-BUDGET initial JS gzip ${gzipBytes}B exceeds ${INITIAL_JS_GZIP_BUDGET_BYTES}B`);
}
console.log(`browser bundle: passed (${files.length} JS file${files.length === 1 ? "" : "s"}: ${files.join(", ")}; gzip=${gzipBytes}B/${INITIAL_JS_GZIP_BUDGET_BYTES}B)`);
