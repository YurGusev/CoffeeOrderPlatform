import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createBrowserOwnerEvidence,
  validateBrowserProof,
} from "../../tools/browser-owner-evidence.mjs";

const runId = "20261025T132252Z-085cdd6";
const roleMap = {
  databases: [
    {
      name: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_customer`,
      schema: "customer",
      runtimeRoles: [
        { runtime: "customer-service", role: "coffee_customer_rw" },
      ],
    },
    {
      name: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_catalog`,
      schema: "catalog",
      runtimeRoles: [],
    },
    {
      name: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_pricing`,
      schema: "pricing",
      runtimeRoles: [{ runtime: "pricing-service", role: "coffee_pricing_rw" }],
    },
    {
      name: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_orders`,
      schema: "orders",
      runtimeRoles: [
        { runtime: "orders-service", role: "coffee_orders_service_rw" },
      ],
    },
    {
      name: `coffee_verify_${runId.toLowerCase().replace("-", "_")}_integration`,
      schema: "integration",
      runtimeRoles: [],
    },
  ],
};
const customerRef = "cus_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const orderRef = "ord_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const itemRef = "itm_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const key = "1a6b9b0a-e6ad-4d6f-a74f-95e461a5b2d7";
const requestHash = "a".repeat(64);
const actorRef = "actor:g15-browser-fixture";

function canonicalOrdersAcl() {
  return [
    {
      scope: "table",
      columnName: null,
      grantee: "coffee_orders_service_rw",
      grantor: "coffee_orders_owner",
      privilegeType: "DELETE",
      isGrantable: false,
    },
    {
      scope: "table",
      columnName: null,
      grantee: "coffee_orders_service_rw",
      grantor: "coffee_orders_owner",
      privilegeType: "INSERT",
      isGrantable: false,
    },
    {
      scope: "table",
      columnName: null,
      grantee: "coffee_orders_service_rw",
      grantor: "coffee_orders_owner",
      privilegeType: "SELECT",
      isGrantable: false,
    },
    {
      scope: "table",
      columnName: null,
      grantee: "coffee_orders_service_rw",
      grantor: "coffee_orders_owner",
      privilegeType: "UPDATE",
      isGrantable: false,
    },
  ];
}

function makeEvidence(connect) {
  return createBrowserOwnerEvidence({ connect, roleMap, actorRef, runId });
}

void test("G15 owner snapshot is run-bound, allowlisted, and returns only hashes/counts", async () => {
  const calls = [];
  const evidence = makeEvidence(async (database) => ({
    async query(sql, values = []) {
      calls.push({ database, sql, values });
      if (sql.includes("FROM customer.idempotency_records"))
        return {
          rows: [
            { state: "Completed", resource_ref: customerRef, version: "77" },
          ],
        };
      if (sql.includes("FROM customer.customers"))
        return { rows: [{ pk: customerRef, version: "41" }] };
      if (sql.includes("FROM customer.audit_log"))
        return {
          rows: [{ pk: "aud_01ARZ3NDEKTSV4RRFFQ69G5FAV", version: "42" }],
        };
      return { rows: [] };
    },
    async end() {},
  }));

  const result = await evidence.snapshot({
    operation: "customer.create",
    idempotencyKey: key,
  });

  assert.equal(calls[0].database, roleMap.databases[0].name);
  assert.deepEqual(calls[0].values, [
    actorRef,
    createHash("sha256").update("POST\n/api/client-v1/customers").digest("hex"),
    key,
  ]);
  assert.equal(result.state, "Completed");
  assert.equal(result.idempotencyRows, 1);
  assert.equal(result.tableCounts.customers, 1);
  assert.equal(result.tableCounts.audit, 1);
  assert.match(result.businessDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    result.keySha256,
    createHash("sha256").update(key).digest("hex"),
  );
  assert.equal(JSON.stringify(result).includes(customerRef), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(
    JSON.stringify(result).includes("aud_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    false,
  );
});

void test("G15 customer business snapshot covers fixed run DB tables without returning identifiers", async () => {
  const calls = [];
  const canary = "G15_CUSTOMER_PII_CANARY";
  const evidence = makeEvidence(async (database) => ({
    async query(sql) {
      calls.push({ database, sql });
      if (sql.includes("FROM customer.customers"))
        return { rows: [{ pk: customerRef, version: "41" }] };
      if (sql.includes("FROM customer.addresses"))
        return {
          rows: [{ pk: "addr_01ARZ3NDEKTSV4RRFFQ69G5FAV", version: "42" }],
        };
      if (sql.includes("FROM customer.channel_links"))
        return {
          rows: [{ pk: "chl_01ARZ3NDEKTSV4RRFFQ69G5FAV", version: "43" }],
        };
      if (sql.includes("FROM customer.audit_log"))
        return {
          rows: [{ pk: "aud_01ARZ3NDEKTSV4RRFFQ69G5FAV", version: "44" }],
        };
      throw new Error(canary);
    },
    async end() {},
  }));

  const result = await evidence.snapshotCustomerBusiness();

  assert.equal(calls.length, 4);
  assert.ok(
    calls.every(({ database }) => database === roleMap.databases[0].name),
  );
  assert.deepEqual(
    calls.map(({ sql }) => sql.match(/FROM ([a-z_.]+)/u)?.[1]),
    [
      "customer.customers",
      "customer.addresses",
      "customer.channel_links",
      "customer.audit_log",
    ],
  );
  assert.deepEqual(result.tableCounts, {
    customers: 1,
    addresses: 1,
    channelLinks: 1,
    audit: 1,
  });
  assert.match(result.businessDigest, /^[0-9a-f]{64}$/u);
  const serialized = JSON.stringify(result);
  for (const sensitiveValue of [
    customerRef,
    "addr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "chl_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "aud_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    canary,
  ])
    assert.equal(serialized.includes(sensitiveValue), false);
});

void test("G15 customer business digest includes channel-link row versions", async () => {
  let channelLinkVersion = "43";
  const evidence = makeEvidence(async () => ({
    async query(sql) {
      if (sql.includes("FROM customer.channel_links"))
        return {
          rows: [
            {
              pk: "chl_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              version: channelLinkVersion,
            },
          ],
        };
      return { rows: [] };
    },
    async end() {},
  }));

  const before = await evidence.snapshotCustomerBusiness();
  channelLinkVersion = "44";
  const after = await evidence.snapshotCustomerBusiness();

  assert.deepEqual(before.tableCounts, after.tableCounts);
  assert.notEqual(before.businessDigest, after.businessDigest);
});

void test("G15 owner capability rejects unknown owners, malformed refs, and noncanonical role maps before connecting", async () => {
  let connects = 0;
  const evidence = makeEvidence(async () => {
    connects += 1;
    throw new Error("unexpected database connection");
  });
  await assert.rejects(
    evidence.snapshot({ operation: "orders.confirm", idempotencyKey: key }),
    { message: "G15_OWNER_OPERATION_INVALID" },
  );
  await assert.rejects(
    evidence.snapshot({
      operation: "orders.item.put",
      idempotencyKey: key,
      orderRef: "not-a-run-order",
      itemRef,
    }),
    { message: "G15_OWNER_INPUT_INVALID" },
  );
  assert.equal(connects, 0);

  const wrongRoleMap = structuredClone(roleMap);
  wrongRoleMap.databases[0].runtimeRoles[0].role = "coffee_admin";
  assert.throws(
    () =>
      createBrowserOwnerEvidence({
        connect: async () => {},
        roleMap: wrongRoleMap,
        actorRef,
        runId,
      }),
    /coffee_customer_rw/u,
  );
});

void test("G15 Acquired fixture uses the exact orders operation scope and no business payload", async () => {
  let insert;
  const evidence = makeEvidence(async (database) => ({
    async query(sql, values = []) {
      assert.equal(database, roleMap.databases[3].name);
      insert = { sql, values };
      return { rows: [] };
    },
    async end() {},
  }));
  const result = await evidence.seedInProgress({
    operation: "orders.item.put",
    idempotencyKey: key,
    orderRef,
    itemRef,
    requestHash,
  });
  const scope = createHash("sha256")
    .update(`PUT\n/api/client-v1/orders/${orderRef}/items/${itemRef}`)
    .digest("hex");
  assert.match(insert.sql, /^INSERT INTO orders\.idempotency_records/u);
  assert.deepEqual(insert.values, [
    actorRef,
    scope,
    key,
    requestHash,
    insert.values[4],
  ]);
  assert.match(insert.values[4], UUID_PATTERN);
  assert.equal(result.state, "Acquired");
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes(orderRef), false);
});

void test("G15 absent lookup is confirmed without inserting state", async () => {
  let queries = 0;
  const evidence = makeEvidence(async () => ({
    async query() {
      queries += 1;
      return { rows: [] };
    },
    async end() {},
  }));
  const result = await evidence.assertAbsent({
    operation: "pricing.quote.create",
    idempotencyKey: key,
  });
  assert.equal(result.absent, true);
  assert.equal(result.operation, "pricing.quote.create");
  assert.equal(queries, 1);
});

void test("G15 owner evidence converts database errors to finite codes", async () => {
  const evidence = makeEvidence(async () => ({
    async query() {
      throw new Error("password=G15_DATABASE_ERROR_CANARY");
    },
    async end() {},
  }));
  await assert.rejects(
    evidence.snapshot({
      operation: "customer.create",
      idempotencyKey: key,
    }),
    { message: "G15_OWNER_DB_QUERY_FAILED" },
  );
});

void test("G15 lookup fault restores owner SELECT before returning or rethrowing", async (t) => {
  for (const callbackThrows of [false, true]) {
    await t.test(`callbackThrows=${callbackThrows}`, async () => {
      let allowed = true;
      let revoked = 0;
      let granted = 0;
      const acl = canonicalOrdersAcl();
      const beforeAcl = structuredClone(acl);
      const evidence = makeEvidence(async (database) => ({
        async query(sql) {
          assert.equal(database, roleMap.databases[3].name);
          if (sql.includes("SELECT state FROM orders.idempotency_records"))
            return { rows: [{ state: "Completed" }] };
          if (sql.includes("WITH target AS")) return { rows: acl };
          if (sql.includes("has_table_privilege"))
            return { rows: [{ allowed }] };
          if (sql.startsWith("REVOKE SELECT")) {
            allowed = false;
            acl.splice(
              0,
              acl.length,
              ...acl.filter((row) => row.privilegeType !== "SELECT"),
            );
            revoked += 1;
            return { rows: [] };
          }
          if (sql.startsWith("GRANT SELECT")) {
            allowed = true;
            acl.push(beforeAcl.find((row) => row.privilegeType === "SELECT"));
            acl.sort((a, b) => a.privilegeType.localeCompare(b.privilegeType));
            granted += 1;
            return { rows: [] };
          }
          throw new Error("unrecognized evidence query");
        },
        async end() {},
      }));
      const exerciseError = new Error("browser flow stopped");
      const operation = evidence.withLookupUnavailable({
        operation: "orders.draft.create",
        idempotencyKey: key,
        exercise: async () => {
          assert.equal(allowed, false);
          if (callbackThrows) throw exerciseError;
          return {
            status: 503,
            problemCode: "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
          };
        },
      });
      if (callbackThrows)
        await assert.rejects(operation, {
          message: "G15_OWNER_LOOKUP_EXERCISE_FAILED",
        });
      else
        assert.deepEqual(await operation, {
          operation: "orders.draft.create",
          keySha256: createHash("sha256").update(key).digest("hex"),
          status: 503,
          problemCode: "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
          restoreVerified: true,
        });
      assert.equal(allowed, true);
      assert.equal(revoked, 1);
      assert.equal(granted, 1);
      assert.deepEqual(acl, beforeAcl);
    });
  }
});

void test("G15 lookup fault refuses noncanonical SELECT ACL before mutation", async (t) => {
  const mutations = [
    [
      "PUBLIC SELECT",
      {
        scope: "table",
        columnName: null,
        grantee: "PUBLIC",
        grantor: "coffee_orders_owner",
        privilegeType: "SELECT",
        isGrantable: false,
      },
    ],
    [
      "grant option",
      {
        scope: "table",
        columnName: null,
        grantee: "coffee_orders_service_rw",
        grantor: "coffee_orders_owner",
        privilegeType: "SELECT",
        isGrantable: true,
      },
    ],
    [
      "column SELECT",
      {
        scope: "column",
        columnName: "actor_ref",
        grantee: "coffee_orders_service_rw",
        grantor: "coffee_orders_owner",
        privilegeType: "SELECT",
        isGrantable: false,
      },
    ],
  ];
  for (const [name, extraGrant] of mutations) {
    await t.test(name, async () => {
      let revoked = 0;
      const acl = canonicalOrdersAcl();
      if (name === "PUBLIC SELECT")
        acl.splice(
          acl.findIndex(
            (row) =>
              row.grantee === "coffee_orders_service_rw" &&
              row.privilegeType === "SELECT",
          ),
          1,
        );
      acl.push(extraGrant);
      const evidence = makeEvidence(async () => ({
        async query(sql) {
          if (sql.includes("SELECT state FROM orders.idempotency_records"))
            return { rows: [{ state: "Completed" }] };
          if (sql.includes("has_table_privilege"))
            return { rows: [{ allowed: true }] };
          if (sql.includes("WITH target AS")) return { rows: acl };
          if (sql.startsWith("REVOKE SELECT")) {
            revoked += 1;
            return { rows: [] };
          }
          throw new Error("unexpected query");
        },
        async end() {},
      }));
      await assert.rejects(
        evidence.withLookupUnavailable({
          operation: "orders.draft.create",
          idempotencyKey: key,
          exercise: async () => {
            throw new Error("must not run");
          },
        }),
        { message: "G15_OWNER_LOOKUP_ACL_NONCANONICAL" },
      );
      assert.equal(revoked, 0);
    });
  }
});

void test("G15 owner lookup fails closed if SELECT restoration cannot be verified", async () => {
  let allowed = true;
  const acl = canonicalOrdersAcl();
  const evidence = makeEvidence(async () => ({
    async query(sql) {
      if (sql.includes("SELECT state FROM orders.idempotency_records"))
        return { rows: [{ state: "Completed" }] };
      if (sql.includes("WITH target AS")) return { rows: acl };
      if (sql.includes("has_table_privilege")) return { rows: [{ allowed }] };
      if (sql.startsWith("REVOKE SELECT")) {
        allowed = false;
        acl.splice(
          0,
          acl.length,
          ...acl.filter((row) => row.privilegeType !== "SELECT"),
        );
        return { rows: [] };
      }
      if (sql.startsWith("GRANT SELECT"))
        throw new Error("password=G15_RESTORE_CANARY");
      throw new Error("unexpected query");
    },
    async end() {},
  }));
  await assert.rejects(
    evidence.withLookupUnavailable({
      operation: "orders.draft.create",
      idempotencyKey: key,
      exercise: async () => ({
        status: 503,
        problemCode: "IDEMPOTENCY_LOOKUP_UNAVAILABLE",
      }),
    }),
    { message: "G15_OWNER_LOOKUP_RESTORE_FAILED" },
  );
  assert.equal(allowed, false);
});

void test("G15 callback proof is exact and bound to this run and candidate", () => {
  const proof = {
    schemaVersion: 1,
    runId,
    candidateSha: "a".repeat(40),
    status: "passed",
    verificationOnly: true,
    productionLogin: false,
  };
  assert.deepEqual(
    validateBrowserProof(proof, {
      runId,
      candidateSha: proof.candidateSha,
    }),
    proof,
  );
  assert.throws(
    () =>
      validateBrowserProof(proof, {
        runId: "20261025T132253Z-085cdd7",
        candidateSha: proof.candidateSha,
      }),
    { message: "G15_BROWSER_PROOF_IDENTITY_INVALID" },
  );
  assert.throws(
    () =>
      validateBrowserProof(
        { ...proof, recoveryProof: true },
        { runId, candidateSha: proof.candidateSha },
      ),
    { message: "G15_BROWSER_PROOF_SCHEMA_INVALID" },
  );
});

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
