#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNERSHIP_DIGEST =
  "4c2cc9268534b1bfc35322d64e7dd98aaabe0a39db4d435ffcc3b6c858769dc2";

function fail(message) {
  const error = new Error(`BOUND-DB-CLAIM ${message}`);
  error.ruleId = "BOUND-DB-CLAIM";
  throw error;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: cannot read strict JSON: ${error.message}`);
  }
}

async function walk(path) {
  if (!existsSync(path)) return [];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(child)));
    else result.push(child);
  }
  return result;
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    if (seen.has(value)) fail(`${label}: duplicate ${key} ${value}`);
    seen.add(value);
  }
  return seen;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function checkDatabaseOwnership(root = REPO_ROOT) {
  const configRoot = join(root, "config");
  const ownership = await readJson(join(configRoot, "database-ownership.json"));
  const catalog = await readJson(join(configRoot, "service-catalog.json"));
  const databases = ownership.databases;
  const claims = ownership.runtimeClaims;
  if (!Array.isArray(databases) || databases.length !== 5)
    fail("exact five owner databases required");
  if (!Array.isArray(claims) || claims.length !== 15)
    fail("exact fifteen runtime claims required");
  uniqueBy(databases, "name", "databases");
  uniqueBy(databases, "owner", "databases");
  const claimNames = uniqueBy(claims, "runtime", "runtimeClaims");
  const catalogByRuntime = new Map(
    catalog.runtimes.map((runtime) => [runtime.name, runtime]),
  );
  if (catalogByRuntime.size !== 15 || claimNames.size !== 15)
    fail("runtime inventory differs from service catalog");

  const databaseByName = new Map(
    databases.map((database) => [database.name, database]),
  );
  const deniedDatabases = new Set(ownership.deny.databases);
  const deniedRoles = new Set(ownership.deny.roles);
  for (const claim of claims) {
    const runtime = catalogByRuntime.get(claim.runtime);
    if (!runtime) fail(`${claim.runtime}: unknown runtime`);
    const expected = runtime.database;
    if (expected === null) {
      if (
        claim.database !== null ||
        claim.role !== null ||
        claim.secretRef !== null
      )
        fail(`${claim.runtime}: DB-less runtime has a database claim`);
      continue;
    }
    if (claim.database !== expected.name || claim.role !== expected.role)
      fail(
        `${claim.runtime}: ${claim.database}/${claim.role} differs from service catalog ${expected.name}/${expected.role}`,
      );
    if (!databaseByName.has(claim.database))
      fail(`${claim.runtime}: unknown database ${claim.database}`);
    if (deniedDatabases.has(claim.database))
      fail(`${claim.runtime}: legacy database ${claim.database} is forbidden`);
    if (deniedRoles.has(claim.role))
      fail(
        `${claim.runtime}: shared/superuser role ${claim.role} is forbidden`,
      );
    if (!runtime.secretRefs.includes(claim.secretRef))
      fail(
        `${claim.runtime}: database secretRef ${claim.secretRef} is not in its allowlist`,
      );
  }

  const declaredMigrationPaths = new Set(
    databases.map((database) => database.migrationPath),
  );
  for (const path of (await walk(join(root, "apps"))).filter((value) =>
    value.endsWith(".sql"),
  )) {
    const repositoryPath = relative(root, path).replaceAll("\\", "/");
    const migrationRoot = [...declaredMigrationPaths].find((candidate) =>
      repositoryPath.startsWith(`${candidate}/`),
    );
    if (!migrationRoot)
      fail(`${repositoryPath}: migration is outside an owner migration path`);
  }

  const environmentPath = join(root, "runtime-environment.json");
  if (existsSync(environmentPath)) {
    const environment = await readJson(environmentPath);
    if (!Array.isArray(environment.bindings))
      fail("runtime-environment.json: bindings array required");
    const claimByRuntime = new Map(
      claims.map((claim) => [claim.runtime, claim]),
    );
    for (const binding of environment.bindings) {
      const claim = claimByRuntime.get(binding.runtime);
      if (!claim)
        fail(`runtime-environment.json: unknown runtime ${binding.runtime}`);
      if (binding.database !== claim.database || binding.role !== claim.role) {
        fail(
          `${binding.runtime}: environment claims ${binding.database}/${binding.role}, expected ${claim.database}/${claim.role}`,
        );
      }
    }
  }

  const scanCandidates = [
    ...(await walk(join(root, "apps"))),
    ...(await walk(join(root, ".github"))),
    ...(await walk(join(root, "fixtures"))),
    ...(await readdir(root, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(compose.*\.(?:ya?ml)|runtime-environment\.json)$/.test(entry.name),
      )
      .map((entry) => join(root, entry.name)),
  ].filter((path) => /\.(?:json|ya?ml|env|sql|ts|mts|js|mjs)$/.test(path));
  for (const path of scanCandidates) {
    const text = await readFile(path, "utf8");
    for (const denied of deniedDatabases) {
      if (text.includes(denied))
        fail(`${relative(root, path)} contains forbidden database ${denied}`);
    }
    for (const denied of deniedRoles) {
      if (
        new RegExp(`(?:role|username|user)[^\\n]{0,80}${denied}`, "i").test(
          text,
        )
      )
        fail(`${relative(root, path)} contains forbidden role ${denied}`);
    }
  }
  const ownershipDigest = createHash("sha256")
    .update(stable(ownership))
    .digest("hex");
  if (ownershipDigest !== OWNERSHIP_DIGEST)
    fail(
      "database ownership manifest differs from the accepted exact authority",
    );
  return { databaseCount: databases.length, runtimeClaimCount: claims.length };
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  return index === -1 ? REPO_ROOT : resolve(argv[index + 1]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkDatabaseOwnership(
      parseRoot(process.argv.slice(2)),
    );
    console.log(
      `database ownership: passed (${result.databaseCount} databases, ${result.runtimeClaimCount} runtime claims)`,
    );
  } catch (error) {
    console.error(`database ownership: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
