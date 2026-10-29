#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { createDatabase } from "../packages/platform-database/dist/index.js";
import {
  ProviderSessionStoreAdapter,
  encryptCookieMaterial,
  providerSessionScopeHash,
} from "../apps/aroma-gateway/dist/infrastructure/database/provider-session-store.js";
import { ProviderSessionManager } from "../apps/aroma-gateway/dist/infrastructure/provider/session.js";

const { Client } = pg;
const POSTGRES_IMAGE =
  "postgres:17.11-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";
const runId = `issue10_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const container = `issue10-safe-read-pg-${runId.slice(-8)}`;
const database = `coffee_verify_${runId}_integration`;
const adminPassword = `proof-admin-${randomUUID()}`;
const migratorPassword = `proof-migrator-${randomUUID()}`;
const runtimePassword = `proof-runtime-${randomUUID()}`;
const migratorRole = "coffee_integration_migrator";
const runtimeRole = "coffee_aroma_gateway_rw";
const scope = {
  scopeRef: "aroma-primary",
  email: "proof@example.test",
  password: "not-emitted",
};
const scopeHash = providerSessionScopeHash(scope.scopeRef, scope.email);
const encryptionKey = Buffer.alloc(32, 23);
const migrationPath = new URL(
  "../apps/aroma-gateway/migrations/0001_provider_sessions.sql",
  import.meta.url,
);

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function connectionString(user, password, db) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${publishedPort}/${db}`;
}

let publishedPort;
async function connect(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

async function waitFor(url) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connect(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError ?? new Error("PostgreSQL readiness timeout");
}

function createDbAdapter() {
  return createDatabase({
    owner: "aroma-gateway",
    database,
    allowedDatabase: database,
    host: "127.0.0.1",
    port: publishedPort,
    user: runtimeRole,
    password: runtimePassword,
    ssl: false,
    pool: {
      max: 2,
      checkoutTimeoutMs: 250,
      lockTimeoutMs: 250,
      interactiveStatementTimeoutMs: 2_000,
      backgroundStatementTimeoutMs: 5_000,
      terminalTimeoutMs: 2_000,
      transactionTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      maxLifetimeMs: 1_800_000,
    },
    shutdownGraceMs: 30_000,
  });
}

function loginTransport(counter) {
  return {
    login: async () => {
      counter.count += 1;
      return {
        profile: { email: scope.email, wholesale: true, retail: false },
        cookies: [
          {
            name: "proof_session",
            value: "proof-cookie-not-emitted",
            domain: "aroma.origin.host",
            path: "/",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            secure: true,
            httpOnly: true,
            sameSite: "lax",
          },
        ],
      };
    },
  };
}

async function main() {
  let databaseAdapter;
  let admin;
  let removed = false;
  try {
    docker([
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=postgres",
      "--env",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "--env",
      "POSTGRES_DB=postgres",
      "--health-cmd",
      "pg_isready -U postgres -d postgres",
      "--health-interval",
      "1s",
      "--health-timeout",
      "1s",
      "--health-retries",
      "30",
      POSTGRES_IMAGE,
    ]);
    const inspect = JSON.parse(docker(["inspect", container]))[0];
    publishedPort = Number(
      inspect.NetworkSettings.Ports["5432/tcp"][0].HostPort,
    );
    const adminUrl = connectionString("postgres", adminPassword, "postgres");
    admin = await waitFor(adminUrl);
    await admin.query(
      `CREATE ROLE "${migratorRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${migratorPassword}'`,
    );
    await admin.query(
      `CREATE ROLE "${runtimeRole}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${runtimePassword}'`,
    );
    await admin.query(
      `CREATE DATABASE "${database}" OWNER "${migratorRole}" TEMPLATE template0`,
    );
    await admin.end();
    admin = undefined;

    const migrator = await connect(
      connectionString(migratorRole, migratorPassword, database),
    );
    await migrator.query(await readFile(migrationPath, "utf8"));
    await migrator.end();
    const runtime = await connect(
      connectionString(runtimeRole, runtimePassword, database),
    );
    const privileges = (
      await runtime.query(
        "SELECT has_table_privilege(current_user, 'integration.provider_sessions', 'SELECT') AS select, has_table_privilege(current_user, 'integration.provider_sessions', 'INSERT') AS insert, has_table_privilege(current_user, 'integration.provider_sessions', 'UPDATE') AS update, has_table_privilege(current_user, 'integration.provider_sessions', 'DELETE') AS delete",
      )
    ).rows[0];
    if (
      !privileges.select ||
      !privileges.insert ||
      !privileges.update ||
      !privileges.delete
    )
      throw new Error(
        "runtime role does not have the exact provider session privilege set",
      );
    await runtime.end();

    databaseAdapter = createDbAdapter();
    await databaseAdapter.resource.start(AbortSignal.timeout(10_000));
    const store = new ProviderSessionStoreAdapter(databaseAdapter);
    const expiresAt = new Date(Date.now() + 1_200_000).toISOString();
    const encrypted = encryptCookieMaterial(
      [
        {
          name: "proof_session",
          value: "proof-cookie-not-emitted",
          domain: "aroma.origin.host",
          path: "/",
          expiresAt,
          secure: true,
          httpOnly: true,
          sameSite: "lax",
        },
      ],
      encryptionKey,
    );
    await store.save(scopeHash, encrypted, expiresAt);
    const first = await store.load(scopeHash);
    if (first === undefined)
      throw new Error("first PostgreSQL session load returned no row");
    const managerOneLogins = { count: 0 };
    const managerOne = new ProviderSessionManager({
      transport: loginTransport(managerOneLogins),
      store,
      encryptionKey,
    });
    await managerOne.acquire(scope);
    await managerOne.close();
    const managerTwoLogins = { count: 0 };
    const managerTwo = new ProviderSessionManager({
      transport: loginTransport(managerTwoLogins),
      store,
      encryptionKey,
    });
    await managerTwo.acquire(scope);
    await managerTwo.close();
    if (managerOneLogins.count !== 0 || managerTwoLogins.count !== 0)
      throw new Error(
        "new session manager did not reuse PostgreSQL persistence",
      );

    await store.save(scopeHash, new Uint8Array(64), expiresAt);
    const invalidLogins = { count: 0 };
    const invalidManager = new ProviderSessionManager({
      transport: loginTransport(invalidLogins),
      store,
      encryptionKey,
    });
    await invalidManager.acquire(scope);
    await invalidManager.close();
    if (invalidLogins.count !== 1)
      throw new Error(
        "invalid ciphertext was not cleaned up and replaced by login",
      );

    const expired = new Date(Date.now() - 60_000).toISOString();
    await store.save(scopeHash, encrypted, expired);
    const expiredLogins = { count: 0 };
    const expiredManager = new ProviderSessionManager({
      transport: loginTransport(expiredLogins),
      store,
      encryptionKey,
    });
    await expiredManager.acquire(scope);
    await expiredManager.close();
    if (expiredLogins.count !== 1)
      throw new Error("expired session was not rejected");

    await store.delete(scopeHash);
    if ((await store.load(scopeHash)) !== undefined)
      throw new Error("provider session cleanup did not remove the row");
    await databaseAdapter.resource.stop(AbortSignal.timeout(10_000));
    databaseAdapter = undefined;
    docker(["rm", "--force", container]);
    removed = true;
    console.log(
      JSON.stringify(
        {
          status: "passed",
          proof: "postgres-provider-session-round-trip",
          container,
          database,
          runtimeRole,
          publishedPort,
          checks: {
            encryptedPersistenceAcrossManagerInstances: true,
            invalidCiphertextCleanup: true,
            expiredMaterialRejected: true,
            explicitDeleteCleanup: true,
            exactPrivileges: privileges,
          },
          cleanup: { containerRemoved: removed, sessionRowsAfterCleanup: 0 },
        },
        null,
        2,
      ),
    );
  } finally {
    if (admin !== undefined) await admin.end();
    if (databaseAdapter !== undefined)
      await databaseAdapter.resource.stop(AbortSignal.timeout(10_000));
    if (!removed) {
      try {
        docker(["rm", "--force", container]);
      } catch {
        /* cleanup is best effort after a primary failure */
      }
    }
  }
}

await main();
