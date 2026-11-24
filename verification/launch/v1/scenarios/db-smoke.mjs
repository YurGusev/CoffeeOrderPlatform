#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlatformConfig } from "../../../../scripts/config-lib.mjs";
import { readJson } from "../../../../scripts/db-bootstrap.mjs";
import { runDatabaseSmoke } from "../../../../scripts/db-smoke.mjs";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const DEFAULT_OWNERSHIP = join(REPO_ROOT, "config/database-ownership.json");
const DEFAULT_ROLE_MAP = join(REPO_ROOT, "config/database-role-map.json");

function fail(message) {
  throw new Error(`DB-SMOKE ${message}`);
}

async function main(argv) {
  const contextPath = process.env.COFFEE_LAUNCH_CONTEXT_FILE;
  if (argv.length !== 0 || !contextPath)
    fail(
      "live smoke requires the launch runner context; use scripts/db-smoke.mjs --plan for the offline plan",
    );
  const roleMap = await readJson(DEFAULT_ROLE_MAP);
  const ownership = await readJson(DEFAULT_OWNERSHIP);
  const { Client } = await import("pg").catch(() => {
    fail(
      "the pg dependency is required only for context-bound live smoke; no network was attempted",
    );
  });
  const config = await loadPlatformConfig(REPO_ROOT);
  const { runDatabaseBoundaryStage } = await import("./migrations.mjs");
  await runDatabaseBoundaryStage({
    root: REPO_ROOT,
    contextPath,
    verifyBoundaries: async ({
      databases,
      expectedSystemIdentifier,
      context,
    }) => {
      const databaseByOwner = Object.fromEntries(
        databases.map(({ owner, database }) => [owner, database]),
      );
      const runtimeCredentials = new Map();
      return runDatabaseSmoke({
        roleMap,
        ownership,
        databaseByOwner,
        runId: context.runId,
        expectedSystemIdentifier,
        host: config.postgres.host,
        port: config.postgres.port,
        readRuntimeCredential: async ({ owner, runtime: runtimeName }) => {
          if (!runtimeCredentials.has(runtimeName)) {
            const { readMigrationCredential } =
              await import("../../../../tools/config-bootstrap/index.mjs");
            runtimeCredentials.set(
              runtimeName,
              await readMigrationCredential({
                root: REPO_ROOT,
                contextPath,
                owner,
                kind: "runtime",
                runtime: runtimeName,
                expectedSystemIdentifier,
              }),
            );
          }
          return runtimeCredentials.get(runtimeName);
        },
        connectClient: async ({ host, port, database, username, password }) => {
          const client = new Client({
            host,
            port,
            database,
            user: username,
            password,
            ssl: false,
            connectionTimeoutMillis: 3_000,
          });
          try {
            await client.connect();
            return client;
          } catch (error) {
            await client.end().catch(() => {});
            throw error;
          }
        },
      });
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
