import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import {
  buildBackupRestorePlan,
  cleanupOwnedRestoreDatabases,
  createOwnedRestoreDatabase,
  resolveBackupSchemaComparisonMode,
  restoreTableAclSnapshotSql,
  restoreOrdersAclInvariantSql,
  restoreRoutineAclSnapshotSql,
  quoteIdentifier,
  renderRestoreFunctionAclSql,
  renderRestoreTableAclSql,
  restoreDatabaseName,
  runStreamPair,
  runStreamRestore,
  safeBackupFailureDiagnostics,
  schemaSnapshotArguments,
  summarizeSchemaDumpDifference,
  verifyRestoreRoutineAclSnapshots,
  verifyRestoreTableAclSnapshots,
  verifyRestoreOrdersAclInvariants,
} from "./backup-restore.mjs";
import { CANONICAL_DATABASE_OWNERS } from "../../../../packages/platform-config/src/launch-database-target.ts";
import { load as parseYaml } from "js-yaml";
import {
  isBackupSocketHost,
  readBackupCredential,
  selectBackupRuntimeCredentialClaim,
  validateBackupTarget,
  validateBackupServerIdentity,
  validateBackupSocketDirectory,
  validateBackupSocketDirectoryMetadata,
} from "../../../../tools/config-bootstrap/index.mjs";
import {
  openRecoveryAdminClient,
  optionsFor,
  queryRecoveryInboxByMessageIds,
  verifyRecoveryUnknownOutcomeTrace,
} from "./backup-restore-recovery.mjs";

const context = {
  runId: "20261024T123001Z-6923b4b",
  candidateSha: "6923b4bb8439bbe613f811ac5ac488597e911fc6",
};
const ownership = JSON.parse(
  readFileSync("config/database-ownership.json", "utf8"),
);
const roleMap = JSON.parse(
  readFileSync("config/database-role-map.json", "utf8"),
);
const recipients = {
  creation_rules: [
    {
      path_regex: "secrets/platform\\.secrets\\.sops\\.yaml$",
      age: [`age1${"a".repeat(58)}`],
    },
  ],
};

function closeFakeChild(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("close", code, signal);
}

void test("G17 plan binds all source and restore databases to owner, run and SHA", () => {
  const plan = buildBackupRestorePlan(context, ownership, roleMap, recipients);
  assert.deepEqual(
    plan.owners.map(({ owner }) => owner),
    CANONICAL_DATABASE_OWNERS,
  );
  assert.equal(
    plan.owners[0].sourceDatabase,
    "coffee_verify_20261024t123001z_6923b4b_customer",
  );
  assert.equal(
    plan.owners[0].restoreDatabase,
    "coffee_restore_20261024T123001Z-6923b4b_customer",
  );
  assert.equal(
    plan.owners[0].ciphertext,
    "gates/G17_BACKUP_RESTORE/artifacts/customer.dump.age",
  );
  assert.equal(plan.candidateSha, context.candidateSha);
});

void test("G17 rejects incomplete owner mapping and invalid public age recipient", () => {
  assert.throws(
    () =>
      buildBackupRestorePlan(
        context,
        { databases: ownership.databases.slice(1) },
        roleMap,
        recipients,
      ),
    /G17_OWNER_MAP_INVALID/,
  );
  assert.throws(
    () =>
      buildBackupRestorePlan(
        context,
        { databases: [...ownership.databases, ownership.databases[0]] },
        roleMap,
        recipients,
      ),
    /G17_OWNER_MAP_INVALID/,
  );
  assert.throws(
    () =>
      buildBackupRestorePlan(context, ownership, roleMap, {
        creation_rules: [
          {
            path_regex: "secrets/platform\\.secrets\\.sops\\.yaml$",
            age: ["invalid"],
          },
        ],
      }),
    /G17_AGE_RECIPIENTS_INVALID/,
  );
});

void test("G17 failure diagnostics expose only closed database codes and SQLSTATE", () => {
  const canary =
    "SELECT password FROM private_table; RAW_DATABASE_CODE private-id";
  const error = Object.assign(new Error(canary), {
    name: "DatabaseTransactionError",
    code: "DB_QUERY_FAILED",
    sqlState: "23505",
    previousCode: "DB_CONNECTION_LOST",
    metadata: { correlationId: "private-id", password: "never" },
  });
  const diagnostic = safeBackupFailureDiagnostics(error);
  assert.deepEqual(diagnostic, {
    errorName: "DatabaseTransactionError",
    closedDatabaseErrorCode: "DB_QUERY_FAILED",
    sqlState: "23505",
    previousDatabaseCode: "DB_CONNECTION_LOST",
  });
  assert.equal(JSON.stringify(diagnostic).includes(canary), false);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /private_table|private-id|password/u,
  );
  assert.deepEqual(
    safeBackupFailureDiagnostics(
      Object.assign(new Error(canary), {
        code: "42703",
        detail: canary,
        query: "SELECT private_column FROM private_table",
      }),
    ),
    {
      errorName: "Error",
      closedDatabaseErrorCode: null,
      sqlState: "42703",
      previousDatabaseCode: null,
    },
  );
  assert.equal(
    safeBackupFailureDiagnostics(
      new Error(canary, {
        cause: { code: "42501", detail: canary },
      }),
    ).sqlState,
    "42501",
  );
  assert.equal(
    safeBackupFailureDiagnostics({ sqlState: "23505", code: "42501" }).sqlState,
    "23505",
  );
  for (const code of [12345, "DROP!", "425010", canary]) {
    assert.equal(safeBackupFailureDiagnostics({ code }).sqlState, null);
  }

  const unknown = Object.assign(new Error(canary), {
    name: "SecretErrorType",
    code: "RAW_DATABASE_CODE",
    sqlState: "DROP!",
    previousCode: "RAW_PREVIOUS_CODE",
    metadata: { sql: canary },
  });
  assert.deepEqual(safeBackupFailureDiagnostics(unknown), {
    errorName: "Error",
    closedDatabaseErrorCode: null,
    sqlState: null,
    previousDatabaseCode: null,
  });
});

void test("G17 restore names only accept current launch run and canonical owner", () => {
  assert.equal(
    restoreDatabaseName(context.runId, "integration"),
    "coffee_restore_20261024T123001Z-6923b4b_integration",
  );
  assert.throws(
    () => restoreDatabaseName("legacy", "customer"),
    /G17_IDENTITY_INVALID/,
  );
  assert.throws(
    () => restoreDatabaseName(context.runId, "legacy"),
    /G17_IDENTITY_INVALID/,
  );
});

void test("G17 quotes the exact mixed-case restore names and rejects identifier injection", () => {
  const restoreName = restoreDatabaseName(context.runId, "customer");
  assert.equal(quoteIdentifier(restoreName), `"${restoreName}"`);
  assert.equal(
    quoteIdentifier("coffee_platform_customer"),
    '"coffee_platform_customer"',
  );
  for (const invalid of [
    'coffee_restore_20261024T123001Z-6923b4b_customer"; DROP DATABASE postgres; --',
    "coffee_restore_20261024T123001Z-6923b4b_legacy",
    "coffee_restore_20261024t123001z-6923b4b_customer",
  ]) {
    assert.throws(() => quoteIdentifier(invalid), /G17_SQL_IDENTIFIER_INVALID/);
  }
});

void test("G17 schema comparison uses a fixed PostgreSQL 17 restrict key and still hashes DDL changes", () => {
  const sourceArgs = schemaSnapshotArguments("coffee_verify_run_orders");
  const restoreArgs = schemaSnapshotArguments(
    restoreDatabaseName(context.runId, "orders"),
  );
  const sourceKey = sourceArgs.find((argument) =>
    argument.startsWith("--restrict-key="),
  );
  const restoreKey = restoreArgs.find((argument) =>
    argument.startsWith("--restrict-key="),
  );
  assert.ok(sourceKey);
  assert.equal(sourceKey, restoreKey);

  const schema = (ddl) =>
    `\\restrict ${sourceKey.slice("--restrict-key=".length)}\n${ddl}\n\\unrestrict ${sourceKey.slice("--restrict-key=".length)}\n`;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  assert.equal(
    digest(schema("CREATE TABLE example (id integer);")),
    digest(schema("CREATE TABLE example (id integer);")),
  );
  assert.notEqual(
    digest(schema("CREATE TABLE example (id integer);")),
    digest(schema("CREATE TABLE example (id bigint);")),
  );
});

void test("G17 permits only the exact independently verified owner-directed array-coercion pairs", () => {
  const approved = [
    {
      owner: "customer",
      source:
        "b1eaf9e8c0586c5752451d6f1fcdaf79f6a9d408931cf5ee6cc331fc313be8fa",
      restored:
        "46f16abdb2f0e8222638c0cf005e40c0f3da4318c3d1e6aab80505dd282e1ba9",
    },
    {
      owner: "catalog",
      source:
        "49dbcfa251f0666c608bbc9ced08a531a63f55d458348eb0d8c36068a8ea5bc2",
      restored:
        "de898f34cce90397ac994565490385b92a7e66e1d4b2dd827153e3fec1e73206",
    },
    {
      owner: "pricing",
      source:
        "c2ccb09f96da9684ea2448276965101090b288e70e357e13f43fe132c72fdeba",
      restored:
        "313a035738d1e7d968b580d09f0f3af1a2a42d47228a741192690e246da8700d",
    },
    {
      owner: "orders",
      source:
        "133b2f9d0ee84b7a9a918df1a386b4ca60a121560d2fc76fd2945d8148d12116",
      restored:
        "13c47b11f96f82e142eeaf23f2f6adad49266c63a7156bf553fb54d1bac970b0",
    },
    {
      owner: "integration",
      source:
        "e25f1c7044520b7d2d470856d5e668ba9f9cabb7c9e58caf85681e3bae0ccf01",
      restored:
        "03450e85590d6a1a7a52f6b8b88c63d4ddb15885d947faa4264a697cf946845a",
    },
  ];
  const changedSha = (sha) =>
    `${sha.slice(0, -1)}${sha.endsWith("0") ? "1" : "0"}`;
  for (const pair of approved) {
    assert.equal(
      resolveBackupSchemaComparisonMode(pair.owner, pair.source, pair.restored),
      "verified-pg17-array-coercion-v1",
    );
    assert.notEqual(changedSha(pair.source), pair.source);
    assert.notEqual(changedSha(pair.restored), pair.restored);
    assert.equal(
      resolveBackupSchemaComparisonMode(
        pair.owner,
        changedSha(pair.source),
        pair.restored,
      ),
      null,
    );
    assert.equal(
      resolveBackupSchemaComparisonMode(
        pair.owner,
        pair.source,
        changedSha(pair.restored),
      ),
      null,
    );
    for (const owner of [
      "customer",
      "catalog",
      "pricing",
      "orders",
      "integration",
    ]) {
      if (owner !== pair.owner)
        assert.equal(
          resolveBackupSchemaComparisonMode(owner, pair.source, pair.restored),
          null,
        );
    }
  }
  const [customer, catalog] = approved;
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "orders",
      customer.source,
      customer.restored,
    ),
    null,
  );
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "catalog",
      customer.source,
      customer.restored,
    ),
    null,
  );
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "customer",
      catalog.source,
      catalog.restored,
    ),
    null,
  );
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "customer",
      customer.source,
      catalog.restored,
    ),
    null,
  );
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "catalog",
      catalog.source,
      customer.restored,
    ),
    null,
  );
  assert.equal(
    resolveBackupSchemaComparisonMode(
      "customer",
      customer.source,
      customer.source,
    ),
    "raw-sha256-equality-v1",
  );
  assert.throws(
    () =>
      resolveBackupSchemaComparisonMode(
        "customer",
        "not-a-sha",
        customer.restored,
      ),
    /G17_SCHEMA_COMPARISON_INPUT_INVALID/u,
  );
});

void test("G17 schema mismatch diagnostics retain hashes and bounded line fingerprints only", () => {
  const canary = "do-not-persist-schema-value-9b82";
  const sourceDump = [
    "-- PostgreSQL database dump",
    ...Array.from(
      { length: 12 },
      (_, index) => `CREATE TABLE ${canary}_source_${index} (id integer);`,
    ),
  ].join("\n");
  const restoreDump = [
    "-- PostgreSQL database dump",
    ...Array.from(
      { length: 12 },
      (_, index) => `CREATE TABLE ${canary}_restore_${index} (id integer);`,
    ),
  ].join("\n");
  const sourceSchemaSha256 = createHash("sha256")
    .update(sourceDump)
    .digest("hex");
  const restoreSchemaSha256 = createHash("sha256")
    .update(restoreDump)
    .digest("hex");
  const diagnostic = summarizeSchemaDumpDifference({
    sourceDump,
    restoreDump,
    sourceSchemaSha256,
    restoreSchemaSha256,
    sourceBytes: Buffer.byteLength(sourceDump),
    restoreBytes: Buffer.byteLength(restoreDump),
  });
  assert.notEqual(sourceSchemaSha256, restoreSchemaSha256);
  assert.equal(diagnostic.sourceSchemaSha256, sourceSchemaSha256);
  assert.equal(diagnostic.restoreSchemaSha256, restoreSchemaSha256);
  assert.equal(diagnostic.differingLineCount, 12);
  assert.equal(diagnostic.firstDifferences.length, 8);
  assert.ok(
    diagnostic.firstDifferences.every(
      (entry) =>
        /^[a-f0-9]{64}$/u.test(entry.sourceLineSha256) &&
        /^[a-f0-9]{64}$/u.test(entry.restoreLineSha256) &&
        entry.sourceClass === "otherSql" &&
        entry.restoreClass === "otherSql",
    ),
  );
  assert.equal(JSON.stringify(diagnostic).includes(canary), false);
});

void test("G17 inbox lookup binds an array as one PostgreSQL text[] parameter", async () => {
  let call;
  const ids = ["msg-one", "msg-two"];
  const client = {
    async query(text, values) {
      call = { text, values };
      return { rows: [] };
    },
  };
  await queryRecoveryInboxByMessageIds(client, ids);
  assert.match(call.text, /message_id = ANY\(\$1::text\[\]\)/u);
  assert.deepEqual(call.values, [ids]);
});

void test("G17 admin client applies query/lock bounds and abort closes a blocked connection", async () => {
  class MockClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.connection = { stream: { destroy() {} } };
      this.ended = false;
    }
    async connect() {}
    query() {
      return new Promise((resolve, reject) => {
        this.rejectQuery = reject;
      });
    }
    async end() {
      this.ended = true;
      this.rejectQuery?.(new Error("connection closed"));
      this.emit("end");
    }
  }
  const controller = new AbortController();
  let mockClient;
  const client = await openRecoveryAdminClient({
    host: "127.0.0.1",
    port: 5432,
    database: "coffee_verify_run_orders",
    password: "synthetic-only",
    signal: controller.signal,
    ClientClass: class extends MockClient {
      constructor(options) {
        super(options);
        mockClient = this;
      }
    },
  });
  assert.equal(client, mockClient);
  assert.equal(mockClient.options.statement_timeout, 25_000);
  assert.equal(mockClient.options.query_timeout, 25_000);
  assert.equal(mockClient.options.lock_timeout, 5_000);
  const pending = mockClient.query("SELECT blocked() ");
  controller.abort(new Error("G17 deadline"));
  await assert.rejects(pending, /connection closed/u);
  assert.equal(mockClient.ended, true);
});

void test("G17 recovery database options use the canonical platform shutdown budget", async () => {
  const config = parseYaml(await readFile("config/platform.yaml", "utf8"));
  const credential = {
    username: "coffee_orders_convergence_rw",
    password: "synthetic-only",
  };
  const options = optionsFor(
    "coffee_verify_20261024t123001z_6923b4b_orders",
    "aroma-convergence",
    config,
    { host: "/dev/shm/coffee-g17-aaaaaaaaaaaaaaaa", port: 5432 },
    credential,
  );
  assert.equal(config.platform.shutdownGraceMs, 30_000);
  assert.equal(options.shutdownGraceMs, config.platform.shutdownGraceMs);
  assert.equal(options.user, credential.username);
  assert.equal(options.password, credential.password);
  const preparation = optionsFor(
    "coffee_verify_20261024t123001z_6923b4b_orders",
    "orders-aroma-preparation",
    config,
    { host: "/dev/shm/coffee-g17-aaaaaaaaaaaaaaaa", port: 5432 },
    { username: "coffee_orders_prepare_rw", password: "synthetic-preparation" },
  );
  assert.equal(preparation.user, "coffee_orders_prepare_rw");
  const gateway = optionsFor(
    "coffee_restore_20261024T123001Z-6923b4b_integration",
    "aroma-gateway",
    config,
    { host: "/dev/shm/coffee-g17-aaaaaaaaaaaaaaaa", port: 5432 },
    { username: "coffee_aroma_gateway_rw", password: "synthetic-gateway" },
  );
  assert.equal(gateway.user, "coffee_aroma_gateway_rw");
  assert.throws(
    () =>
      optionsFor(
        "coffee_verify_20261024t123001z_6923b4b_orders",
        "aroma-convergence",
        config,
        { host: "/dev/shm/coffee-g17-aaaaaaaaaaaaaaaa", port: 5432 },
        { username: "postgres", password: "synthetic-only" },
      ),
    /G17_RECOVERY_CONFIG_INVALID/u,
  );
});

void test("G17 outbox fixture isolates lifecycle claims while retaining production predecessor ordering", async () => {
  const recoverySource = await readFile(
    new URL("./backup-restore-recovery.mjs", import.meta.url),
    "utf8",
  );
  const outboxSource = await readFile(
    "packages/platform-outbox/src/index.ts",
    "utf8",
  );
  const claim = outboxSource.match(
    /this\.claimStatement\s*=\s*defineStatement\s*\(\s*database\s*,\s*`([\s\S]*?)`\s*,?\s*\);/u,
  )?.[1];
  assert.ok(claim, "production SQL claim statement must remain inspectable");
  assert.doesNotMatch(
    claim,
    /this\.finalizeStatement/u,
    "claim capture must stop before the next statement",
  );
  const predecessor = claim.match(
    /AND NOT EXISTS \(([\s\S]*?)\)\s*ORDER BY/u,
  )?.[1];
  assert.ok(predecessor, "claim must retain aggregate predecessor ordering");
  assert.match(
    predecessor,
    /predecessor\.aggregate_ref = current\.aggregate_ref/u,
  );
  assert.match(
    predecessor,
    /predecessor\.aggregate_sequence < current\.aggregate_sequence/u,
  );
  assert.match(predecessor, /predecessor\.state <> 'Published'/u);
  assert.doesNotMatch(predecessor, /topic/u);

  assert.match(recoverySource, /async function seedDraftOutboxAggregate\(/u);
  assert.match(
    recoverySource,
    /recoveryFixtureRef\("ord", `\$\{runId\}:outbox-aggregate`\)/u,
  );
  assert.match(
    recoverySource,
    /seedDraftOutboxAggregate\(\{\s*admin,\s*runId,\s*customerRef: primary\.customerRef,/u,
  );
  assert.match(
    recoverySource,
    /VALUES\(\$1,'Draft',1,1,\$2,1,'G17 isolated fixture'/u,
  );
  const outboxStart = recoverySource.indexOf("const outboxMessages =");
  const outboxEnd = recoverySource.indexOf(
    "for (const message of outboxMessages)",
    outboxStart,
  );
  assert.ok(outboxStart >= 0 && outboxEnd > outboxStart);
  const outboxFixture = recoverySource.slice(outboxStart, outboxEnd);
  assert.match(outboxFixture, /aggregateRef: outboxOrderRef,/u);
  assert.match(outboxFixture, /partitionKey: outboxOrderRef,/u);
  assert.doesNotMatch(outboxFixture, /aggregateRef: orderRef,/u);
  assert.match(
    recoverySource,
    /sent\.length === 1 && sent\[0\] === outboxMessages\[0\]\.messageId/u,
  );
  assert.match(
    recoverySource,
    /outboxById\.get\(completedOutboxId\) === "Published"/u,
  );
  assert.match(
    recoverySource,
    /outboxById\.get\(pendingOutboxId\) === "Pending"/u,
  );
});

void test("G17 runtime credential selection is closed over canonical owner claims", async () => {
  const map = JSON.parse(
    await readFile("config/database-role-map.json", "utf8"),
  );
  const claims = JSON.parse(
    await readFile("config/database-ownership.json", "utf8"),
  );
  assert.deepEqual(
    selectBackupRuntimeCredentialClaim({
      owner: "orders",
      runtime: "orders-aroma-preparation",
      roleMap: map,
      ownership: claims,
    }),
    {
      username: "coffee_orders_prepare_rw",
      secretRef: "postgres.ordersPreparation",
    },
  );
  assert.deepEqual(
    selectBackupRuntimeCredentialClaim({
      owner: "orders",
      runtime: "aroma-convergence",
      roleMap: map,
      ownership: claims,
    }),
    {
      username: "coffee_orders_convergence_rw",
      secretRef: "postgres.aromaConvergence",
    },
  );
  assert.deepEqual(
    selectBackupRuntimeCredentialClaim({
      owner: "integration",
      runtime: "aroma-gateway",
      roleMap: map,
      ownership: claims,
    }),
    { username: "coffee_aroma_gateway_rw", secretRef: "postgres.aromaGateway" },
  );
  assert.throws(
    () =>
      selectBackupRuntimeCredentialClaim({
        owner: "integration",
        runtime: "aroma-convergence",
        roleMap: map,
        ownership: claims,
      }),
    /CONFIG-G17-RUNTIME/u,
  );
  assert.throws(
    () =>
      selectBackupRuntimeCredentialClaim({
        owner: "orders",
        runtime: "arbitrary-runtime",
        roleMap: map,
        ownership: claims,
      }),
    /CONFIG-G17-RUNTIME/u,
  );
});

void test("G17 restores canonical function ACLs and fails on source/restore drift", async () => {
  const realOwnership = JSON.parse(
    await readFile("config/database-ownership.json", "utf8"),
  );
  const realRoleMap = JSON.parse(
    await readFile("config/database-role-map.json", "utf8"),
  );
  const plan = buildBackupRestorePlan(
    context,
    realOwnership,
    realRoleMap,
    recipients,
  );
  const orders = plan.owners.find(({ owner }) => owner === "orders");
  const sql = renderRestoreFunctionAclSql(orders);
  assert.match(
    sql,
    /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "orders" FROM PUBLIC/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION "orders"\.write_card_projection\(text,jsonb\) TO "coffee_orders_service_rw","coffee_orders_prepare_rw"/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION "orders"\.read_card_projection\(text,integer\) TO "coffee_orders_service_rw"/u,
  );
  assert.match(
    restoreRoutineAclSnapshotSql("orders"),
    /aclexplode\(COALESCE\(p\.proacl,acldefault\('f',p\.proowner\)\)\)/u,
  );
  const source = JSON.stringify([
    [
      "orders",
      "write_card_projection",
      "f",
      "text, jsonb",
      "coffee_orders_migrator",
      "coffee_orders_migrator",
      "EXECUTE",
      true,
    ],
    [
      "orders",
      "write_card_projection",
      "f",
      "text, jsonb",
      "coffee_orders_migrator",
      "coffee_orders_prepare_rw",
      "EXECUTE",
      false,
    ],
  ]);
  assert.deepEqual(
    verifyRestoreRoutineAclSnapshots(source, source),
    JSON.parse(source),
  );
  assert.throws(
    () => verifyRestoreRoutineAclSnapshots(source, "[]"),
    /G17_ROUTINE_ACL_MISMATCH/u,
  );
  assert.throws(
    () => verifyRestoreRoutineAclSnapshots("not-json", "[]"),
    /G17_ROUTINE_ACL_QUERY_INVALID/u,
  );
});

void test("G17 restores and compares closed source table/column ACLs", () => {
  const realOwnership = JSON.parse(
    readFileSync("config/database-ownership.json", "utf8"),
  );
  const realRoleMap = JSON.parse(
    readFileSync("config/database-role-map.json", "utf8"),
  );
  const orders = buildBackupRestorePlan(
    context,
    realOwnership,
    realRoleMap,
    recipients,
  ).owners.find(({ owner }) => owner === "orders");
  const source = JSON.stringify([
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      orders.migratorRole,
      "SELECT",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      orders.migratorRole,
      "MAINTAIN",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_service_rw",
      "SELECT",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_service_rw",
      "INSERT",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_service_rw",
      "DELETE",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      "status",
      orders.migratorRole,
      "coffee_orders_service_rw",
      "UPDATE",
      false,
    ],
    [
      "orders",
      "r",
      orders.migratorRole,
      "version",
      orders.migratorRole,
      "coffee_orders_service_rw",
      "UPDATE",
      false,
    ],
    [
      "cart_desired_order_facts",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_prepare_rw",
      "SELECT",
      false,
    ],
    [
      "cart_desired_order_facts",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_prepare_rw",
      "INSERT",
      false,
    ],
    [
      "cart_desired_order_facts",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_convergence_rw",
      "SELECT",
      false,
    ],
  ]);
  const sql = renderRestoreTableAclSql(orders, source);
  assert.match(
    restoreTableAclSnapshotSql("orders"),
    /aclexplode\(COALESCE\(a\.attacl,acldefault\('c',r\.relowner\)\)\)/u,
  );
  assert.match(restoreTableAclSnapshotSql("orders"), /__EMPTY_ACL__/u);
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON TABLE "orders"\."orders" FROM PUBLIC,/u,
  );
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON TABLE "orders"\."orders" FROM PUBLIC,/u,
  );
  assert.match(
    sql,
    /GRANT UPDATE \("status"\) ON TABLE "orders"\."orders" TO "coffee_orders_service_rw"/u,
  );
  assert.doesNotMatch(sql, /GRANT UPDATE \("projection_version"\)/u);
  assert.match(
    sql,
    /GRANT INSERT, SELECT ON TABLE "orders"\."cart_desired_order_facts" TO "coffee_orders_prepare_rw"/u,
  );
  assert.match(
    sql,
    /GRANT SELECT ON TABLE "orders"\."cart_desired_order_facts" TO "coffee_orders_convergence_rw"/u,
  );
  assert.deepEqual(
    verifyRestoreTableAclSnapshots(source, source, orders),
    JSON.parse(source),
  );

  const broadUpdate = JSON.stringify([
    ...JSON.parse(source),
    [
      "orders",
      "r",
      orders.migratorRole,
      null,
      orders.migratorRole,
      "coffee_orders_service_rw",
      "UPDATE",
      false,
    ],
  ]);
  const projectionBypass = JSON.stringify([
    ...JSON.parse(source),
    [
      "orders",
      "r",
      orders.migratorRole,
      "projection_version",
      orders.migratorRole,
      "coffee_orders_service_rw",
      "UPDATE",
      false,
    ],
  ]);
  const missingRecoveryGrant = JSON.stringify(
    JSON.parse(source).filter(
      (row) =>
        !(
          row[0] === "cart_desired_order_facts" &&
          row[5] === "coffee_orders_convergence_rw"
        ),
    ),
  );
  assert.throws(
    () => verifyRestoreTableAclSnapshots(source, broadUpdate, orders),
    /G17_TABLE_ACL_MISMATCH/u,
  );
  assert.throws(
    () => verifyRestoreTableAclSnapshots(source, projectionBypass, orders),
    /G17_TABLE_ACL_MISMATCH/u,
  );
  assert.throws(
    () => verifyRestoreTableAclSnapshots(source, missingRecoveryGrant, orders),
    /G17_TABLE_ACL_MISMATCH/u,
  );
  assert.throws(
    () =>
      renderRestoreTableAclSql(
        orders,
        JSON.stringify([
          ...JSON.parse(source),
          [
            "orders",
            "r",
            orders.migratorRole,
            null,
            orders.migratorRole,
            "unexpected_role",
            "SELECT",
            false,
          ],
        ]),
      ),
    /G17_TABLE_ACL_UNSUPPORTED/u,
  );
  assert.throws(
    () =>
      renderRestoreTableAclSql(
        orders,
        JSON.stringify([
          ...JSON.parse(source),
          [
            "orders",
            "r",
            orders.migratorRole,
            null,
            "postgres",
            "coffee_orders_service_rw",
            "SELECT",
            false,
          ],
        ]),
      ),
    /G17_TABLE_ACL_UNSUPPORTED/u,
  );
  assert.throws(
    () =>
      renderRestoreTableAclSql(
        orders,
        JSON.stringify([
          ...JSON.parse(source),
          [
            "orders",
            "r",
            orders.migratorRole,
            null,
            orders.migratorRole,
            "__EMPTY_ACL__",
            "__EMPTY_ACL__",
            false,
          ],
        ]),
      ),
    /G17_TABLE_ACL_UNSUPPORTED/u,
  );
  assert.throws(
    () =>
      renderRestoreTableAclSql(
        orders,
        JSON.stringify([
          ...JSON.parse(source),
          [
            "orders",
            "r",
            orders.migratorRole,
            null,
            orders.migratorRole,
            "coffee_orders_service_rw",
            "MAINTAIN",
            true,
          ],
        ]),
      ),
    /G17_TABLE_ACL_UNSUPPORTED/u,
  );
  assert.throws(
    () =>
      renderRestoreTableAclSql(
        orders,
        JSON.stringify([
          ...JSON.parse(source),
          [
            "orders",
            "r",
            orders.migratorRole,
            null,
            orders.migratorRole,
            "coffee_orders_service_rw",
            "CREATE",
            false,
          ],
        ]),
      ),
    /G17_TABLE_ACL_UNSUPPORTED/u,
  );
  assert.throws(
    () => renderRestoreTableAclSql(orders, "[]"),
    /G17_TABLE_ACL_QUERY_INVALID/u,
  );
});

void test("G17 checks restored Orders ACL behavior, including projection guard and recovery roles", () => {
  const realOwnership = JSON.parse(
    readFileSync("config/database-ownership.json", "utf8"),
  );
  const realRoleMap = JSON.parse(
    readFileSync("config/database-role-map.json", "utf8"),
  );
  const orders = buildBackupRestorePlan(
    context,
    realOwnership,
    realRoleMap,
    recipients,
  ).owners.find(({ owner }) => owner === "orders");
  const sql = restoreOrdersAclInvariantSql(orders);
  assert.match(
    sql,
    /has_table_privilege\('coffee_orders_service_rw','orders\.orders','UPDATE'\)/u,
  );
  assert.match(
    sql,
    /has_column_privilege\('coffee_orders_service_rw','orders\.orders','projection_version','UPDATE'\)/u,
  );
  assert.match(
    sql,
    /has_table_privilege\('coffee_orders_prepare_rw','orders\.cart_desired_order_facts','INSERT'\)/u,
  );
  assert.match(
    sql,
    /has_column_privilege\('coffee_orders_convergence_rw','orders\.convergence_work','dirty','UPDATE'\)/u,
  );
  const valid = [
    false,
    true,
    true,
    false,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ];
  assert.deepEqual(
    verifyRestoreOrdersAclInvariants(JSON.stringify(valid)),
    valid,
  );
  assert.throws(
    () =>
      verifyRestoreOrdersAclInvariants(
        JSON.stringify([...valid.slice(0, 3), true, ...valid.slice(4)]),
      ),
    /G17_TABLE_ACL_INVARIANT_FAILED/u,
  );
  assert.throws(
    () => verifyRestoreOrdersAclInvariants("not-json"),
    /G17_TABLE_ACL_PROBE_INVALID/u,
  );
});

void test("G17 CREATE unknown outcome never claims or drops a colliding database", async () => {
  const foreign = {
    database: "coffee_restore_20261024T123001Z-6923b4b_customer",
    oid: "9042",
    owner: "foreign_owner",
    marker: "another-run",
  };
  const created = [];
  const createAttempts = [];
  await assert.rejects(
    createOwnedRestoreDatabase({
      ownerPlan: {
        owner: "customer",
        restoreDatabase: foreign.database,
        migratorRole: "coffee_customer_migrator",
      },
      identity: context,
      created,
      createAttempts,
      createDatabase: async () => {
        // Simulate another actor creating this exact name after the absence read,
        // while this runner receives no reliable CREATE acknowledgement.
        throw Object.assign(new Error("connection lost after CREATE"), {
          code: "ECONNRESET",
        });
      },
      readOwnership: async () => foreign,
      setMarker: async () => assert.fail("must not mark a foreign database"),
    }),
    /G17_RESTORE_CREATE_OUTCOME_UNKNOWN/,
  );
  let dropCalls = 0;
  const cleanup = await cleanupOwnedRestoreDatabases({
    created,
    createAttempts,
    verifyServer: async () => assert.fail("unknown CREATE is not owned"),
    readOwnership: async () => foreign,
    dropDatabase: async () => dropCalls++,
  });
  assert.deepEqual(created, []);
  assert.equal(createAttempts[0].state, "CREATE_UNKNOWN_OUTCOME");
  assert.equal(dropCalls, 0);
  assert.deepEqual(cleanup, {
    verified: false,
    removed: [],
    retained: [
      { database: foreign.database, reason: "CREATE_UNKNOWN_OUTCOME" },
    ],
  });
});

void test("G17 restore ownership is registered only after marker provenance is read back", async () => {
  const database = "coffee_restore_20261024T123001Z-6923b4b_customer";
  const created = [];
  const createAttempts = [];
  let actual = null;
  const record = await createOwnedRestoreDatabase({
    ownerPlan: {
      owner: "customer",
      restoreDatabase: database,
      migratorRole: "coffee_customer_migrator",
    },
    identity: context,
    created,
    createAttempts,
    createDatabase: async () => {
      actual = {
        database,
        oid: "9050",
        owner: "coffee_customer_migrator",
        marker: null,
      };
    },
    readOwnership: async () => actual,
    setMarker: async (name, marker) => {
      assert.equal(name, database);
      actual = { ...actual, marker };
    },
  });
  assert.deepEqual(created, [record]);
  assert.equal(createAttempts[0].state, "OWNED");
  assert.equal(record.oid, "9050");
  assert.equal(record.owner, "coffee_customer_migrator");
  assert.match(
    record.marker,
    /^coffee-g17:20261024T123001Z-6923b4b:6923b4bb8439bbe613f811ac5ac488597e911fc6:customer:/u,
  );
});

void test("G17 cleanup retains a database whose OID, owner, or marker changed", async () => {
  const expected = {
    database: "coffee_restore_20261024T123001Z-6923b4b_customer",
    oid: "9043",
    owner: "coffee_customer_migrator",
    marker: `coffee-g17:${context.runId}:${context.candidateSha}:customer:synthetic`,
  };
  const created = [expected];
  for (const foreignRecord of [
    { ...expected, oid: "9044" },
    { ...expected, owner: "foreign_owner" },
    { ...expected, marker: "foreign-run" },
  ]) {
    let dropCalls = 0;
    let serverChecks = 0;
    const cleanup = await cleanupOwnedRestoreDatabases({
      created,
      createAttempts: [
        { database: expected.database, owner: "customer", state: "OWNED" },
      ],
      verifyServer: async () => serverChecks++,
      readOwnership: async () => foreignRecord,
      dropDatabase: async () => dropCalls++,
    });
    assert.equal(serverChecks, 1);
    assert.equal(dropCalls, 0);
    assert.deepEqual(cleanup, {
      verified: false,
      removed: [],
      retained: [{ database: expected.database, reason: "OWNERSHIP_MISMATCH" }],
    });
  }
});

void test("G17 cleanup drops only a same-server, same-OID owner and marker", async () => {
  const expected = {
    database: "coffee_restore_20261024T123001Z-6923b4b_customer",
    oid: "9045",
    owner: "coffee_customer_migrator",
    marker: `coffee-g17:${context.runId}:${context.candidateSha}:customer:synthetic`,
  };
  let exists = true;
  let dropCalls = 0;
  const cleanup = await cleanupOwnedRestoreDatabases({
    created: [expected],
    createAttempts: [
      { database: expected.database, owner: "customer", state: "OWNED" },
    ],
    verifyServer: async () => {},
    readOwnership: async () => (exists ? expected : null),
    dropDatabase: async () => {
      dropCalls++;
      exists = false;
    },
  });
  assert.equal(dropCalls, 1);
  assert.deepEqual(cleanup, {
    verified: true,
    removed: [expected.database],
    retained: [],
  });
});

void test("G17 stream pipeline stores ciphertext only and restores the dump from a pipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-g17-stream-test-"));
  const artifact = join(directory, "owner.dump.age");
  const plaintext = Buffer.from("synthetic custom-format dump\n");
  let restored = Buffer.alloc(0);
  const io = {
    spawn(command, args) {
      const child = new EventEmitter();
      child.pid = process.pid;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {};
      child.stdout = new PassThrough();
      if (command === "dump-fixture") {
        queueMicrotask(() => {
          child.stdout.end(plaintext);
          closeFakeChild(child, 0);
        });
      } else if (command === "age-encrypt-fixture") {
        const chunks = [];
        child.stdin = new PassThrough();
        child.stdin.on("data", (chunk) => chunks.push(chunk));
        child.stdin.on("end", () => {
          child.stdout.end(Buffer.concat(chunks).map((value) => value ^ 0xff));
          closeFakeChild(child, 0);
        });
      } else if (command === "age-decrypt-fixture") {
        const encrypted = readFileSync(args[0]);
        child.stdout.end(encrypted.map((value) => value ^ 0xff));
        queueMicrotask(() => closeFakeChild(child, 0));
      } else if (command === "restore-fixture") {
        child.stdin = new PassThrough();
        const chunks = [];
        child.stdin.on("data", (chunk) => chunks.push(chunk));
        child.stdin.on("end", () => {
          restored = Buffer.concat(chunks);
          closeFakeChild(child, 0);
        });
      } else throw new Error(`unexpected fixture command: ${command}`);
      return child;
    },
  };
  try {
    await runStreamPair({
      io,
      first: { command: "dump-fixture", args: [], env: {} },
      second: { command: "age-encrypt-fixture", args: [], env: {} },
      outputPath: artifact,
      cwd: directory,
      labels: ["DUMP", "AGE"],
    });
    const encrypted = await readFile(artifact);
    assert.ok(!encrypted.includes(plaintext));
    assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    await runStreamRestore({
      io,
      ageCommand: { command: "age-decrypt-fixture", args: [artifact], env: {} },
      restoreCommand: { command: "restore-fixture", args: [], env: {} },
      cwd: directory,
    });
    assert.deepEqual(restored, plaintext);
    assert.deepEqual(await readdir(directory), ["owner.dump.age"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G17 timeout terminates both streaming processes and keeps partial evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-g17-timeout-test-"));
  const artifact = join(directory, "partial.dump.age");
  const children = [];
  const io = {
    spawn() {
      const child = new EventEmitter();
      child.pid = 99999999;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      child.stdin = new PassThrough();
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        if (signal !== "SIGKILL") return;
        child.stdout.destroy();
        child.stdin.destroy();
        queueMicrotask(() => closeFakeChild(child, null, signal));
      };
      children.push(child);
      return child;
    },
  };
  try {
    await assert.rejects(
      runStreamPair({
        io,
        first: { command: "dump", args: [], env: {} },
        second: { command: "age", args: [], env: {} },
        outputPath: artifact,
        cwd: directory,
        timeoutMs: 20,
        labels: ["DUMP", "AGE"],
      }),
    );
    assert.equal(children.length, 2);
    assert.ok(
      children.every(
        ({ signals }) =>
          signals[0] === "SIGTERM" && signals.includes("SIGKILL"),
      ),
    );
    assert.ok((await readdir(directory)).includes("partial.dump.age"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test(
  "G17 external gate cancellation terminates both streaming processes",
  { timeout: 10_000, skip: process.platform !== "linux" },
  async () => {
    await readFile("/proc/self/stat", "utf8");
    const directory = await mkdtemp(join(tmpdir(), "coffee-g17-cancel-test-"));
    const markers = [join(directory, "left"), join(directory, "right")];
    const childScript = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)`;
    const gateScript = `
    import { spawn } from 'node:child_process';
    import { runStreamPair } from ${JSON.stringify(new URL("./backup-restore.mjs", import.meta.url).href)};
    const fixture = (path) => ({ command: process.execPath, args: ['-e', ${JSON.stringify(childScript)}, path], env: process.env });
    await runStreamPair({ io: { spawn }, first: fixture(${JSON.stringify(markers[0])}), second: fixture(${JSON.stringify(markers[1])}), outputPath: ${JSON.stringify(join(directory, "output"))}, cwd: ${JSON.stringify(directory)}, labels: ['DUMP', 'AGE'] });
  `;
    const gate = spawn(
      process.execPath,
      ["--input-type=module", "-e", gateScript],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    const gateClosed = new Promise((resolvePromise) =>
      gate.once("close", resolvePromise),
    );
    const gatePid = gate.pid;
    const pids = [];
    try {
      if (typeof gatePid !== "number") throw new Error("G17_GATE_SPAWN_FAILED");
      const deadline = Date.now() + 5_000;
      while (pids.length < markers.length && Date.now() < deadline) {
        for (const marker of markers.slice(pids.length)) {
          const pid = await readFile(marker, "utf8").catch(() => null);
          if (pid === null) break;
          pids.push(Number(pid));
        }
        if (pids.length < markers.length)
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      assert.equal(
        pids.length,
        2,
        "both fixture processes must start before cancellation",
      );
      process.kill(-gatePid, "SIGTERM");
      await gateClosed;
      try {
        process.kill(-gatePid, "SIGKILL");
      } catch {}
      const running = async (pid) => {
        const status = await readFile(`/proc/${pid}/stat`, "utf8").catch(
          () => null,
        );
        return status !== null && !/^\d+ \(.*\) Z /u.test(status);
      };
      const exitDeadline = Date.now() + 2_000;
      while (
        (await Promise.all(pids.map(running))).some(Boolean) &&
        Date.now() < exitDeadline
      )
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      assert.deepEqual(await Promise.all(pids.map(running)), [false, false]);
    } finally {
      if (typeof gatePid === "number") {
        try {
          process.kill(-gatePid, "SIGKILL");
        } catch {}
      }
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await gateClosed;
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test("G17 child failures retain a finite process code without exposing stderr", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "coffee-g17-process-error-test-"),
  );
  let dumpChild;
  const io = {
    spawn(command) {
      const child = new EventEmitter();
      child.pid = process.pid;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new PassThrough();
      if (command === "dump") {
        dumpChild = child;
        queueMicrotask(() => {
          child.stdout.end();
          const encryptChild = children[1];
          encryptChild.exitCode = 0;
          child.exitCode = 7;
          closeFakeChild(child, 7);
        });
      } else {
        child.stdin = new PassThrough();
        child.stdout.end();
        child.stdin.on("finish", () =>
          queueMicrotask(() => closeFakeChild(child, 0)),
        );
      }
      child.kill = (signal) => {
        child.signalCode = signal;
      };
      return child;
    },
  };
  const children = [];
  const spawn = io.spawn.bind(io);
  io.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  try {
    await assert.rejects(
      runStreamPair({
        io,
        first: { command: "dump", args: [], env: {} },
        second: { command: "age", args: [], env: {} },
        outputPath: join(directory, "ciphertext"),
        cwd: directory,
        labels: ["PG_DUMP", "AGE_ENCRYPT"],
      }),
      { code: "G17_PROCESS_PG_DUMP_EXIT_7" },
    );
    assert.equal(dumpChild.exitCode, 7);
    assert.ok(
      children.every(
        ({ exitCode, signalCode }) => exitCode !== null || signalCode !== null,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G17 uses only the repository's public age recipient policy", async () => {
  const sopsPolicy = parseYaml(await readFile(".sops.yaml", "utf8"));
  const plan = buildBackupRestorePlan(context, ownership, roleMap, sopsPolicy);
  assert.equal(plan.age.version, "1.3.2");
  assert.ok(plan.age.recipients.length > 0);
  assert.ok(
    plan.owners.every(
      ({ owner, sourceDatabase, restoreDatabase }) =>
        sourceDatabase.endsWith(`_${owner}`) &&
        restoreDatabase.endsWith(`_${owner}`),
    ),
  );
});

void test("G17 trusted bootstrap rejects an unbound source/restore target before secret access", async () => {
  await assert.rejects(
    readBackupCredential({
      runId: context.runId,
      candidateSha: context.candidateSha,
      owner: "customer",
      sourceDatabase: "coffee_platform_customer",
      restoreDatabase: "coffee_restore_other_customer",
      host: "coffee_postgres",
      port: 5432,
      expectedSystemIdentifier: "123456",
      env: {},
    }),
    /CONFIG-G17-DATABASE/,
  );
});

void test("G17 trusted bootstrap requires the exact readonly launch context before secret access", async () => {
  await assert.rejects(
    readBackupCredential({
      runId: context.runId,
      candidateSha: context.candidateSha,
      owner: "customer",
      sourceDatabase: `coffee_verify_${context.runId.toLowerCase().replace("-", "_")}_customer`,
      restoreDatabase: `coffee_restore_${context.runId}_customer`,
      host: "coffee_postgres",
      port: 5432,
      expectedSystemIdentifier: "123456",
      contextPath: "",
      env: {},
    }),
    /CONFIG-G17-CONTEXT/,
  );
});

void test("G17 credential reads reject missing, symlinked, and writable contexts before candidate access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coffee-g17-context-guard-"));
  const contextFile = join(directory, "context.json");
  const contextLink = join(directory, "context-link.json");
  const candidateRoot = join(directory, "candidate-does-not-exist");
  const sourceDatabase = `coffee_verify_${context.runId.toLowerCase().replace("-", "_")}_customer`;
  const restoreDatabase = `coffee_restore_${context.runId}_customer`;
  const base = {
    root: candidateRoot,
    runId: context.runId,
    candidateSha: context.candidateSha,
    owner: "customer",
    sourceDatabase,
    restoreDatabase,
    host: "coffee_postgres",
    port: 5432,
    expectedSystemIdentifier: "123456",
    env: {},
  };
  try {
    await writeFile(contextFile, "{}\n", { mode: 0o400 });
    await chmod(contextFile, 0o400);
    await symlink(contextFile, contextLink);

    await assert.rejects(
      readBackupCredential({
        ...base,
        contextPath: join(directory, "missing.json"),
      }),
      /CONFIG-G17-PATH/,
    );
    await assert.rejects(
      readBackupCredential({ ...base, contextPath: contextLink }),
      /CONFIG-G17-PATH/,
    );
    await chmod(contextFile, 0o600);
    await assert.rejects(
      readBackupCredential({ ...base, contextPath: contextFile }),
      /CONFIG-G17-CONTEXT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("G17 validates a real source/candidate context, exact config bytes, private socket and closed G00 identity", async (t) => {
  const sourceRoot = resolve(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  const candidateRoot = await mkdtemp(join(tmpdir(), "coffee-g17-candidate-"));
  const socketHost = `/dev/shm/coffee-g17-${randomBytes(8).toString("hex")}`;
  const runStamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  let evidenceDir;
  try {
    execFileSync(
      "git",
      ["clone", "--shared", "--no-checkout", sourceRoot, candidateRoot],
      { stdio: "ignore" },
    );
    execFileSync("git", ["-C", candidateRoot, "checkout", "--detach", "HEAD"], {
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-C",
        candidateRoot,
        "remote",
        "set-url",
        "origin",
        "https://github.com/YurGusev/CoffeeOrderPlatform.git",
      ],
      { stdio: "ignore" },
    );
    assert.notEqual(candidateRoot, sourceRoot);
    assert.equal(
      execFileSync(
        "git",
        ["-C", candidateRoot, "remote", "get-url", "origin"],
        { encoding: "utf8" },
      ).trim(),
      "https://github.com/YurGusev/CoffeeOrderPlatform.git",
    );
    await copyFile(
      join(sourceRoot, "config/platform.schema.json"),
      join(candidateRoot, "config/platform.schema.json"),
    );
    await copyFile(
      join(sourceRoot, "config/database-ownership.json"),
      join(candidateRoot, "config/database-ownership.json"),
    );
    await copyFile(
      join(sourceRoot, "config/database-role-map.json"),
      join(candidateRoot, "config/database-role-map.json"),
    );
    let configYaml = await readFile(
      join(sourceRoot, "config/platform.yaml"),
      "utf8",
    );
    const isolationPattern =
      /(  databaseIsolation:\n    enabled: )(?:true|false)/u;
    assert.match(configYaml, isolationPattern);
    configYaml = configYaml.replace(isolationPattern, "$1true");
    assert.match(configYaml, /  host: coffee_postgres/u);
    configYaml = configYaml.replace(
      "  host: coffee_postgres",
      `  host: ${socketHost}`,
    );
    await writeFile(join(candidateRoot, "config/platform.yaml"), configYaml);
    await chmod(join(candidateRoot, "config/platform.yaml"), 0o644);
    await chmod(join(candidateRoot, "config/platform.schema.json"), 0o644);
    execFileSync("git", [
      "-C",
      candidateRoot,
      "add",
      "config/platform.schema.json",
      "config/platform.yaml",
      "config/database-ownership.json",
      "config/database-role-map.json",
    ]);
    execFileSync(
      "git",
      [
        "-C",
        candidateRoot,
        "-c",
        "user.name=G17 fixture",
        "-c",
        "user.email=g17-fixture@example.invalid",
        "commit",
        "-m",
        `G17 isolated target fixture ${randomBytes(4).toString("hex")}`,
      ],
      { stdio: "ignore" },
    );

    const candidateSha = execFileSync(
      "git",
      ["-C", candidateRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const runId = `${runStamp}-${candidateSha.slice(0, 7)}`;
    const configBytes = await readFile(
      join(candidateRoot, "config/platform.yaml"),
    );
    const contextPath = join(
      sourceRoot,
      "evidence/launch",
      runId,
      "context.json",
    );
    evidenceDir = dirname(contextPath);
    const preflightIdentityPath = join(
      evidenceDir,
      "gates/G00_PREFLIGHT/artifacts/postgres-server-identity.json",
    );
    await mkdir(dirname(preflightIdentityPath), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(socketHost, { mode: 0o700 });

    const launchContext = {
      schemaVersion: 1,
      runId,
      candidateSha,
      baseConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
      sourceRepoRoot: sourceRoot,
      evidenceDir,
      checkoutDir: candidateRoot,
    };
    const identity = {
      schemaVersion: 1,
      runId,
      candidateSha,
      host: socketHost,
      port: 5432,
      version: "17.11",
      systemIdentifier: "7654321098765432109",
    };
    await writeFile(contextPath, `${JSON.stringify(launchContext)}\n`, {
      mode: 0o400,
    });
    await chmod(contextPath, 0o400);
    await writeFile(preflightIdentityPath, `${JSON.stringify(identity)}\n`, {
      mode: 0o400,
    });
    await chmod(preflightIdentityPath, 0o400);

    const validated = await validateBackupTarget({
      root: candidateRoot,
      contextPath,
      runId,
      candidateSha,
      host: socketHost,
      port: 5432,
      expectedSystemIdentifier: identity.systemIdentifier,
    });
    assert.equal(validated.target.host, socketHost);
    assert.equal(validated.target.systemIdentifier, identity.systemIdentifier);
    assert.equal(validated.config.verification.databaseIsolation.enabled, true);

    const encryptedSecrets = parseYaml(
      await readFile(
        join(candidateRoot, "secrets/platform.secrets.sops.yaml"),
        "utf8",
      ),
    );
    const decryptFixture = (value, path = []) => {
      if (typeof value === "string")
        return value.startsWith("ENC[")
          ? `g17-fixture-${path.join("-")}`
          : value;
      if (Array.isArray(value))
        return value.map((entry, index) =>
          decryptFixture(entry, [...path, index]),
        );
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "sops")
            .map(([key, entry]) => [
              key,
              decryptFixture(entry, [...path, key]),
            ]),
        );
      return value;
    };
    const decryptedSecrets = decryptFixture(encryptedSecrets);
    const adminPassword = "g17-admin-credential-canary";
    decryptedSecrets.environments.development.bootstrap.postgresAdminPassword =
      adminPassword;
    const candidateOwnership = JSON.parse(
      await readFile(
        join(candidateRoot, "config/database-ownership.json"),
        "utf8",
      ),
    );
    const candidateRoleMap = JSON.parse(
      await readFile(
        join(candidateRoot, "config/database-role-map.json"),
        "utf8",
      ),
    );
    const runtimeClaim = selectBackupRuntimeCredentialClaim({
      owner: "integration",
      runtime: "aroma-gateway",
      roleMap: candidateRoleMap,
      ownership: candidateOwnership,
    });
    const runtimePassword = "g17-runtime-credential-canary";
    const runtimeSecretPath = [
      ...runtimeClaim.secretRef.split("."),
      "password",
    ];
    const runtimeSecret = runtimeSecretPath
      .slice(0, -1)
      .reduce(
        (value, key) => value[key],
        decryptedSecrets.environments.development,
      );
    runtimeSecret[runtimeSecretPath.at(-1)] = runtimePassword;
    const fixtureBin = join(candidateRoot, "test-bin");
    const plaintextPath = join(candidateRoot, "decrypted-test-fixture.json");
    const sopsInvocationPath = join(candidateRoot, "sops-invoked");
    await mkdir(fixtureBin, { mode: 0o700 });
    await writeFile(plaintextPath, JSON.stringify(decryptedSecrets), {
      mode: 0o600,
    });
    const fakeSopsPath = join(fixtureBin, "sops");
    await writeFile(
      fakeSopsPath,
      `#!/bin/sh\nprintf 'called\\n' >> '${sopsInvocationPath}'\nexec /bin/cat '${plaintextPath}'\n`,
      { mode: 0o700 },
    );
    await chmod(fakeSopsPath, 0o700);
    const credentialOptions = {
      root: candidateRoot,
      contextPath,
      runId,
      candidateSha,
      owner: "integration",
      sourceDatabase: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_integration`,
      restoreDatabase: `coffee_restore_${runId}_integration`,
      host: socketHost,
      port: 5432,
      expectedSystemIdentifier: identity.systemIdentifier,
      env: { PATH: `${fixtureBin}:${process.env.PATH ?? ""}` },
    };
    const candidateConfigPath = join(candidateRoot, "config/platform.yaml");
    await chmod(candidateConfigPath, 0o664);
    await assert.rejects(
      readBackupCredential(credentialOptions),
      (error) => error.ruleId === "CONFIG-G17-CONFIG",
    );
    assert.equal(
      (await readdir(candidateRoot)).includes("sops-invoked"),
      false,
    );
    await chmod(candidateConfigPath, 0o644);
    assert.deepEqual(await readBackupCredential(credentialOptions), {
      username: "postgres",
      password: adminPassword,
    });
    assert.equal((await readdir(candidateRoot)).includes("sops-invoked"), true);
    assert.deepEqual(
      await readBackupCredential({
        ...credentialOptions,
        runtime: "aroma-gateway",
      }),
      { username: runtimeClaim.username, password: runtimePassword },
    );

    await rm(sopsInvocationPath, { force: true });
    await rm(candidateConfigPath);
    await assert.rejects(
      readBackupCredential(credentialOptions),
      (error) => error.ruleId === "CONFIG-G17-CONFIG",
    );
    assert.equal(
      (await readdir(candidateRoot)).includes("sops-invoked"),
      false,
      "missing candidate config must fail before invoking SOPS",
    );
    await writeFile(candidateConfigPath, configBytes);
    await chmod(candidateConfigPath, 0o644);

    await chmod(contextPath, 0o600);
    await writeFile(
      contextPath,
      `${JSON.stringify({ ...launchContext, baseConfigSha256: "0".repeat(64) })}\n`,
    );
    await chmod(contextPath, 0o400);
    await assert.rejects(
      validateBackupTarget({
        root: candidateRoot,
        contextPath,
        runId,
        candidateSha,
        host: socketHost,
        port: 5432,
      }),
      /CONFIG-G17-CONFIG/u,
    );
    await chmod(contextPath, 0o600);
    await writeFile(contextPath, `${JSON.stringify(launchContext)}\n`);
    await chmod(contextPath, 0o400);

    await chmod(preflightIdentityPath, 0o600);
    await writeFile(
      preflightIdentityPath,
      `${JSON.stringify({ ...identity, systemIdentifier: "1" })}\n`,
    );
    await chmod(preflightIdentityPath, 0o400);
    await assert.rejects(
      validateBackupTarget({
        root: candidateRoot,
        contextPath,
        runId,
        candidateSha,
        host: socketHost,
        port: 5432,
        expectedSystemIdentifier: identity.systemIdentifier,
      }),
      /CONFIG-G17-SERVER-IDENTITY/u,
    );
    await chmod(preflightIdentityPath, 0o600);
    await writeFile(preflightIdentityPath, "{ malformed G00 identity\n");
    await chmod(preflightIdentityPath, 0o400);
    await assert.rejects(
      validateBackupTarget({
        root: candidateRoot,
        contextPath,
        runId,
        candidateSha,
        host: socketHost,
        port: 5432,
        expectedSystemIdentifier: identity.systemIdentifier,
      }),
      (error) => error.ruleId === "CONFIG-G17-SERVER-IDENTITY",
    );
    await rm(sopsInvocationPath, { force: true });
    await assert.rejects(
      readBackupCredential(credentialOptions),
      (error) => error.ruleId === "CONFIG-G17-SERVER-IDENTITY",
    );
    assert.equal(
      (await readdir(candidateRoot)).includes("sops-invoked"),
      false,
      "malformed G00 identity must fail before invoking SOPS",
    );
    await chmod(preflightIdentityPath, 0o600);
    await writeFile(preflightIdentityPath, `${JSON.stringify(identity)}\n`);
    await chmod(preflightIdentityPath, 0o400);

    await rm(sopsInvocationPath, { force: true });
    const preflightIdentityBytes = await readFile(preflightIdentityPath);
    const preflightIdentityMode =
      (await stat(preflightIdentityPath)).mode & 0o777;
    const originalReadFile = fsPromises.readFile.bind(fsPromises);
    let preflightIdentityDeletionTriggered = false;
    const preflightIdentityReadRaceMock = t.mock.method(
      fsPromises,
      "readFile",
      async (...args) => {
        if (
          preflightIdentityDeletionTriggered ||
          resolve(String(args[0])) !== preflightIdentityPath
        )
          return originalReadFile(...args);
        const bytes = await originalReadFile(...args);
        preflightIdentityDeletionTriggered = true;
        await rm(preflightIdentityPath);
        return bytes;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        readBackupCredential(credentialOptions),
        (error) => error.ruleId === "CONFIG-G17-SERVER-IDENTITY",
      );
      assert.equal(preflightIdentityDeletionTriggered, true);
      assert.equal(
        await fsPromises.lstat(preflightIdentityPath).catch(() => null),
        null,
      );
      assert.equal(
        (await readdir(candidateRoot)).includes("sops-invoked"),
        false,
        "removed G00 identity must fail before invoking SOPS",
      );
    } finally {
      preflightIdentityReadRaceMock.mock.restore();
      syncBuiltinESMExports();
      if (preflightIdentityDeletionTriggered) {
        await writeFile(preflightIdentityPath, preflightIdentityBytes);
        await chmod(preflightIdentityPath, preflightIdentityMode);
        assert.deepEqual(
          await readFile(preflightIdentityPath),
          preflightIdentityBytes,
        );
        assert.equal(
          (await stat(preflightIdentityPath)).mode & 0o777,
          preflightIdentityMode,
        );
      }
    }

    await assert.rejects(
      validateBackupTarget({
        root: candidateRoot,
        contextPath,
        runId: `${runStamp}-0000000`,
        candidateSha,
        host: socketHost,
        port: 5432,
      }),
      /CONFIG-G17-CONTEXT/u,
    );
  } finally {
    await rm(socketHost, { recursive: true, force: true });
    if (evidenceDir) await rm(evidenceDir, { recursive: true, force: true });
    await rm(candidateRoot, { recursive: true, force: true });
  }
});

void test("G17 Unix socket endpoint is restricted to private canonical directories", async () => {
  const host = `/dev/shm/coffee-g17-${randomBytes(8).toString("hex")}`;
  const target = `/dev/shm/coffee-g17-${randomBytes(8).toString("hex")}`;
  const link = `/dev/shm/coffee-g17-${randomBytes(8).toString("hex")}`;
  const missing = `/dev/shm/coffee-g17-${randomBytes(8).toString("hex")}`;
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await assert.rejects(
    validateBackupSocketDirectory(missing),
    /CONFIG-G17-SOCKET-PATH/,
  );
  await mkdir(host, { mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    assert.equal(isBackupSocketHost(host), true);
    assert.equal(await validateBackupSocketDirectory(host), host);
    assert.equal(
      validateBackupSocketDirectoryMetadata({
        isDirectory: () => true,
        uid: process.getuid() + 1,
        mode: 0o40700,
      }),
      false,
    );
    assert.equal(isBackupSocketHost("/tmp/coffee-g17-aaaaaaaaaaaaaaaa"), false);
    await symlink(target, link);
    await assert.rejects(
      validateBackupSocketDirectory(link),
      /CONFIG-G17-SOCKET-PATH/,
    );
    await chmod(host, 0o755);
    await assert.rejects(
      validateBackupSocketDirectory(host),
      /CONFIG-G17-SOCKET-OWNER/,
    );
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true });
  }
});

void test("G17 recovery proof requires GET first and forbids replay of the old operation", () => {
  assert.deepEqual(
    verifyRecoveryUnknownOutcomeTrace(
      [{ kind: "GET" }, { kind: "MUTATION", operationRef: "op_new" }],
      "op_old",
    ),
    { firstAction: "GET", oldOperationRefReplayed: false },
  );
  assert.throws(
    () =>
      verifyRecoveryUnknownOutcomeTrace(
        [{ kind: "MUTATION", operationRef: "op_old" }, { kind: "GET" }],
        "op_old",
      ),
    /G17_UNKNOWN_OUTCOME_RECOVERY_NOT_GET_FIRST/,
  );
  assert.throws(
    () =>
      verifyRecoveryUnknownOutcomeTrace(
        [{ kind: "GET" }, { kind: "MUTATION", operationRef: "op_old" }],
        "op_old",
      ),
    /G17_UNKNOWN_OUTCOME_OLD_OPERATION_REPLAYED/,
  );
});

void test("G17 target identity is closed and bound to this run, candidate, and YAML endpoint", () => {
  const identity = {
    schemaVersion: 1,
    runId: context.runId,
    candidateSha: context.candidateSha,
    host: "coffee_postgres",
    port: 5432,
    version: "17.11",
    systemIdentifier: "123456",
  };
  const config = {
    environment: "development",
    verification: { databaseIsolation: { enabled: true } },
    postgres: { host: identity.host, port: identity.port },
  };
  assert.deepEqual(validateBackupServerIdentity(identity, context, config), {
    host: identity.host,
    port: identity.port,
    systemIdentifier: identity.systemIdentifier,
  });
  const socketHost = `/dev/shm/coffee-g17-${"c".repeat(16)}`;
  const socketConfig = {
    ...config,
    postgres: { ...config.postgres, host: socketHost },
  };
  assert.deepEqual(
    validateBackupServerIdentity(
      { ...identity, host: socketHost },
      context,
      socketConfig,
    ),
    {
      host: socketHost,
      port: identity.port,
      systemIdentifier: identity.systemIdentifier,
    },
  );
  assert.throws(
    () =>
      validateBackupServerIdentity(
        identity,
        { ...context, runId: "20261024T123000Z-0000000" },
        config,
      ),
    /CONFIG-G17-SERVER-IDENTITY/,
  );
  for (const [key, value] of [
    ["runId", "20261024T123000Z-0000000"],
    ["candidateSha", "0".repeat(40)],
    ["host", "other-postgres"],
    ["version", "17.10"],
  ]) {
    assert.throws(
      () =>
        validateBackupServerIdentity(
          { ...identity, [key]: value },
          context,
          config,
        ),
      /CONFIG-G17-SERVER-IDENTITY/,
    );
  }
  assert.throws(
    () =>
      validateBackupServerIdentity(
        { ...identity, unexpected: true },
        context,
        config,
      ),
    /CONFIG-G17-SERVER-IDENTITY/,
  );
  assert.throws(
    () =>
      validateBackupServerIdentity(identity, context, {
        ...config,
        environment: "production",
      }),
    /CONFIG-G17-SERVER-IDENTITY/,
  );
  assert.throws(
    () =>
      validateBackupServerIdentity(identity, context, {
        ...config,
        verification: { databaseIsolation: { enabled: false } },
      }),
    /CONFIG-G17-SERVER-IDENTITY/,
  );
});
