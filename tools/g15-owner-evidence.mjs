import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const ACTOR_REF = "actor:g15-browser-fixture";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const DATABASE_OWNERS = Object.freeze([
  "customer",
  "catalog",
  "pricing",
  "orders",
  "integration",
]);
const REF = Object.freeze({
  customer: /^cus_[0-9A-HJKMNP-TV-Z]{26}$/u,
  quote: /^prq_[0-9A-HJKMNP-TV-Z]{26}$/u,
  order: /^ord_[0-9A-HJKMNP-TV-Z]{26}$/u,
  item: /^itm_[0-9A-HJKMNP-TV-Z]{26}$/u,
});
const TABLE_ACL_SQL = `
  WITH target AS (
    SELECT c.oid, c.relowner, c.relacl
    FROM pg_class c
    WHERE c.oid = to_regclass($1)
  ), acl_rows AS (
    SELECT 'table'::text AS scope, NULL::text AS column_name,
           e.grantee, e.grantor, e.privilege_type, e.is_grantable
    FROM target t
    CROSS JOIN LATERAL aclexplode(
      COALESCE(t.relacl, acldefault('r', t.relowner))
    ) e
    UNION ALL
    SELECT 'column'::text AS scope, a.attname AS column_name,
           e.grantee, e.grantor, e.privilege_type, e.is_grantable
    FROM target t
    JOIN pg_attribute a
      ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN LATERAL aclexplode(a.attacl) e
  )
  SELECT scope, column_name AS "columnName",
         CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END AS grantee,
         pg_get_userbyid(grantor) AS grantor,
         privilege_type AS "privilegeType", is_grantable AS "isGrantable"
  FROM acl_rows
  ORDER BY scope, column_name NULLS FIRST, grantee, grantor, privilege_type
`;

const OWNER = Object.freeze({
  customer: Object.freeze({
    owner: "customer",
    schema: "customer",
    runtime: "customer-service",
    role: "coffee_customer_rw",
    table: "customer.idempotency_records",
  }),
  pricing: Object.freeze({
    owner: "pricing",
    schema: "pricing",
    runtime: "pricing-service",
    role: "coffee_pricing_rw",
    table: "pricing.pricing_idempotency_records",
  }),
  orders: Object.freeze({
    owner: "orders",
    schema: "orders",
    runtime: "orders-service",
    role: "coffee_orders_service_rw",
    table: "orders.idempotency_records",
  }),
});
const CUSTOMER_BUSINESS_TABLES = Object.freeze([
  Object.freeze({
    name: "customers",
    sql: "SELECT customer_ref AS pk, xmin::text AS version FROM customer.customers ORDER BY customer_ref",
  }),
  Object.freeze({
    name: "addresses",
    sql: "SELECT address_ref AS pk, xmin::text AS version FROM customer.addresses ORDER BY address_ref",
  }),
  Object.freeze({
    name: "channelLinks",
    sql: "SELECT channel_link_ref AS pk, xmin::text AS version FROM customer.channel_links ORDER BY channel_link_ref",
  }),
  Object.freeze({
    name: "audit",
    sql: "SELECT audit_ref AS pk, xmin::text AS version FROM customer.audit_log ORDER BY audit_ref",
  }),
]);

const OPERATION = Object.freeze({
  "customer.create": Object.freeze({
    owner: "customer",
    resource: "customer",
    method: "POST",
    path: () => "/api/client-v1/customers",
    tables: Object.freeze([
      Object.freeze({
        name: "customers",
        sql: "SELECT customer_ref AS pk, xmin::text AS version FROM customer.customers WHERE customer_ref = $1",
      }),
      Object.freeze({
        name: "addresses",
        sql: "SELECT address_ref AS pk, xmin::text AS version FROM customer.addresses WHERE customer_ref = $1",
      }),
      Object.freeze({
        name: "audit",
        sql: "SELECT audit_ref AS pk, xmin::text AS version FROM customer.audit_log WHERE customer_ref = $1",
      }),
    ]),
  }),
  "pricing.quote.create": Object.freeze({
    owner: "pricing",
    resource: "quote",
    method: "POST",
    path: () => "/api/client-v1/pricing/quotes",
    tables: Object.freeze([
      Object.freeze({
        name: "quotes",
        sql: "SELECT quote_ref AS pk, xmin::text AS version FROM pricing.pricing_quotes WHERE quote_ref = $1",
      }),
      Object.freeze({
        name: "quoteLines",
        sql: "SELECT quote_ref || ':' || line_number::text AS pk, xmin::text AS version FROM pricing.pricing_quote_lines WHERE quote_ref = $1",
      }),
      Object.freeze({
        name: "audit",
        sql: "SELECT audit_ref AS pk, xmin::text AS version FROM pricing.pricing_audit_records WHERE quote_ref = $1",
      }),
    ]),
  }),
  "orders.draft.create": Object.freeze({
    owner: "orders",
    resource: "order",
    method: "POST",
    path: () => "/api/client-v1/orders/drafts",
    tables: Object.freeze([
      Object.freeze({
        name: "orders",
        sql: "SELECT order_ref AS pk, xmin::text AS version FROM orders.orders WHERE order_ref = $1",
      }),
      Object.freeze({
        name: "items",
        sql: "SELECT order_ref || ':' || item_ref AS pk, xmin::text AS version FROM orders.order_items WHERE order_ref = $1",
      }),
      Object.freeze({
        name: "history",
        sql: "SELECT history_ref AS pk, xmin::text AS version FROM orders.order_history WHERE order_ref = $1",
      }),
      Object.freeze({
        name: "outbox",
        sql: "SELECT message_id AS pk, envelope_hash AS version FROM orders.outbox_messages WHERE aggregate_ref = $1",
      }),
    ]),
  }),
  "orders.item.put": Object.freeze({
    owner: "orders",
    resource: "order",
    method: "PUT",
    path: ({ orderRef, itemRef }) =>
      `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    tables: Object.freeze([
      Object.freeze({
        name: "orders",
        sql: "SELECT order_ref AS pk, xmin::text AS version FROM orders.orders WHERE order_ref = $1",
      }),
      Object.freeze({
        name: "item",
        sql: "SELECT order_ref || ':' || item_ref AS pk, xmin::text AS version FROM orders.order_items WHERE order_ref = $1 AND item_ref = $2",
        item: true,
      }),
      Object.freeze({
        name: "history",
        sql: "SELECT history_ref AS pk, xmin::text AS version FROM orders.order_history WHERE order_ref = $1 AND item_ref = $2",
        item: true,
      }),
      Object.freeze({
        name: "outbox",
        sql: "SELECT message_id AS pk, envelope_hash AS version FROM orders.outbox_messages WHERE aggregate_ref = $1",
      }),
    ]),
  }),
  "orders.item.delete": Object.freeze({
    owner: "orders",
    resource: "order",
    method: "DELETE",
    path: ({ orderRef, itemRef }) =>
      `/api/client-v1/orders/${orderRef}/items/${itemRef}`,
    tables: Object.freeze([
      Object.freeze({
        name: "orders",
        sql: "SELECT order_ref AS pk, xmin::text AS version FROM orders.orders WHERE order_ref = $1",
      }),
      Object.freeze({
        name: "item",
        sql: "SELECT order_ref || ':' || item_ref AS pk, xmin::text AS version FROM orders.order_items WHERE order_ref = $1 AND item_ref = $2",
        item: true,
      }),
      Object.freeze({
        name: "history",
        sql: "SELECT history_ref AS pk, xmin::text AS version FROM orders.order_history WHERE order_ref = $1 AND item_ref = $2",
        item: true,
      }),
      Object.freeze({
        name: "outbox",
        sql: "SELECT message_id AS pk, envelope_hash AS version FROM orders.outbox_messages WHERE aggregate_ref = $1",
      }),
    ]),
  }),
});

class G15OwnerEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = "G15OwnerEvidenceError";
  }
}

function fail(code) {
  throw new G15OwnerEvidenceError(code);
}

function safeOperationError(error, fallback) {
  return error instanceof G15OwnerEvidenceError
    ? error
    : new G15OwnerEvidenceError(fallback);
}

function exactKeys(value, keys, code) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .join("\0") !==
      [...keys].sort((left, right) => left.localeCompare(right)).join("\0")
  )
    fail(code);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateRequest(operation, input, methodName) {
  const descriptor = OPERATION[operation];
  if (!descriptor) fail("G15_OWNER_OPERATION_INVALID");
  const keys =
    descriptor.owner === "orders" && operation.startsWith("orders.item.")
      ? ["operation", "idempotencyKey", "orderRef", "itemRef"]
      : ["operation", "idempotencyKey"];
  if (methodName === "seedInProgress") keys.push("requestHash");
  exactKeys(input, keys, "G15_OWNER_INPUT_INVALID");
  if (input.operation !== operation || !UUID.test(input.idempotencyKey ?? ""))
    fail("G15_OWNER_INPUT_INVALID");
  if (methodName === "seedInProgress" && !SHA256.test(input.requestHash ?? ""))
    fail("G15_OWNER_INPUT_INVALID");
  let orderRef, itemRef;
  if (operation.startsWith("orders.item.")) {
    orderRef = input.orderRef;
    itemRef = input.itemRef;
    if (!REF.order.test(orderRef ?? "") || !REF.item.test(itemRef ?? ""))
      fail("G15_OWNER_INPUT_INVALID");
  }
  return {
    descriptor,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    orderRef,
    itemRef,
    scope: sha256(
      `${descriptor.method}\n${descriptor.path({ orderRef, itemRef })}`,
    ),
  };
}

function runDatabaseName(runId, owner) {
  return `coffee_verify_${runId.toLowerCase().replace("-", "_")}_${owner}`;
}

function validateSchema(roleMap, runId) {
  assert.ok(roleMap && Array.isArray(roleMap.databases));
  assert.equal(roleMap.databases.length, DATABASE_OWNERS.length);
  const expectedNames = DATABASE_OWNERS.map((owner) =>
    runDatabaseName(runId, owner),
  ).sort();
  const actualNames = roleMap.databases.map((database) => database.name).sort();
  assert.deepEqual(actualNames, expectedNames);
  const databaseByOwner = {};
  for (const [owner, expected] of Object.entries(OWNER)) {
    const database = roleMap.databases.find(
      (candidate) => candidate.name === runDatabaseName(runId, owner),
    );
    assert.ok(database, "G15 owner database is missing");
    assert.equal(database.schema, expected.schema);
    assert.equal(database.name, runDatabaseName(runId, expected.owner));
    const runtime = database.runtimeRoles.find(
      (candidate) => candidate.runtime === expected.runtime,
    );
    assert.ok(runtime, "G15 owner runtime role is missing");
    assert.equal(runtime.role, expected.role);
    assert.ok(
      Object.values(OPERATION).some((operation) => operation.owner === owner),
    );
    databaseByOwner[owner] = database.name;
  }
  return databaseByOwner;
}

async function withClient(connect, database, operation) {
  let client;
  try {
    client = await connect(database);
  } catch {
    fail("G15_OWNER_DB_CONNECT_FAILED");
  }
  let primary;
  let result;
  try {
    result = await operation(client);
  } catch (error) {
    primary = safeOperationError(error, "G15_OWNER_DB_QUERY_FAILED");
  }
  let closeError;
  try {
    await client.end();
  } catch {
    closeError = new G15OwnerEvidenceError("G15_OWNER_DB_CLOSE_FAILED");
  }
  if (primary && closeError) fail("G15_OWNER_DB_CLOSE_FAILED");
  if (primary) throw primary;
  if (closeError) throw closeError;
  return result;
}

function safeExerciseResult(result) {
  exactKeys(
    result,
    ["status", "problemCode"],
    "G15_OWNER_LOOKUP_RESULT_INVALID",
  );
  if (
    result.status !== 503 ||
    result.problemCode !== "IDEMPOTENCY_LOOKUP_UNAVAILABLE"
  )
    fail("G15_OWNER_LOOKUP_RESULT_INVALID");
  return { status: result.status, problemCode: result.problemCode };
}

function validateLookupAcl(rows, role) {
  if (!Array.isArray(rows) || rows.length === 0)
    fail("G15_OWNER_LOOKUP_ACL_INVALID");
  for (const row of rows) {
    exactKeys(
      row,
      [
        "scope",
        "columnName",
        "grantee",
        "grantor",
        "privilegeType",
        "isGrantable",
      ],
      "G15_OWNER_LOOKUP_ACL_INVALID",
    );
    if (
      (row.scope !== "table" && row.scope !== "column") ||
      typeof row.grantee !== "string" ||
      typeof row.grantor !== "string" ||
      typeof row.privilegeType !== "string" ||
      typeof row.isGrantable !== "boolean" ||
      (row.scope === "column" && typeof row.columnName !== "string") ||
      (row.scope === "table" && row.columnName !== null)
    )
      fail("G15_OWNER_LOOKUP_ACL_INVALID");
  }
  const selectGrants = rows.filter(
    (row) =>
      (row.grantee === role || row.grantee === "PUBLIC") &&
      row.privilegeType === "SELECT",
  );
  const roleTableSelect = selectGrants.filter(
    (row) => row.grantee === role && row.scope === "table",
  );
  const roleColumnSelect = selectGrants.some(
    (row) => row.grantee === role && row.scope === "column",
  );
  const publicSelect = selectGrants.some((row) => row.grantee === "PUBLIC");
  if (
    roleTableSelect.length !== 1 ||
    roleTableSelect[0].isGrantable !== false ||
    roleColumnSelect ||
    publicSelect
  )
    fail("G15_OWNER_LOOKUP_ACL_NONCANONICAL");
  return rows;
}

/**
 * Create a capability bound to the five run-scoped recovery databases.
 * The caller retains the URL/credentials and receives no SQL-bearing handle.
 */
export function createG15OwnerEvidence({ connect, roleMap, actorRef, runId }) {
  assert.equal(typeof connect, "function");
  assert.equal(actorRef, ACTOR_REF);
  assert.match(runId ?? "", /^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7}$/u);
  const databaseByOwner = validateSchema(roleMap, runId);

  async function snapshot(input) {
    const operation = input?.operation;
    const parsed = validateRequest(operation, input, "snapshot");
    const spec = OWNER[parsed.descriptor.owner];
    return withClient(
      connect,
      databaseByOwner[parsed.descriptor.owner],
      async (client) => {
        const idempotency = await client.query(
          `SELECT state, resource_ref, xmin::text AS version FROM ${spec.table} WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`,
          [ACTOR_REF, parsed.scope, parsed.idempotencyKey],
        );
        assert.ok(
          idempotency.rows.length <= 1,
          "G15 idempotency key is not unique",
        );
        const row = idempotency.rows[0];
        const state = row?.state ?? null;
        if (state !== null && state !== "Acquired" && state !== "Completed")
          fail("G15_OWNER_STATE_INVALID");
        const resourceRef = row?.resource_ref ?? null;
        if (
          resourceRef !== null &&
          !REF[parsed.descriptor.resource].test(resourceRef)
        )
          fail("G15_OWNER_RESOURCE_INVALID");

        const tableCounts = {};
        const digestRows = [];
        if (resourceRef !== null) {
          for (const table of parsed.descriptor.tables) {
            const values = table.item
              ? [resourceRef, parsed.itemRef]
              : [resourceRef];
            const result = await client.query(table.sql, values);
            const rows = result.rows ?? [];
            tableCounts[table.name] = rows.length;
            for (const item of rows) {
              assert.equal(typeof item.pk, "string");
              assert.equal(typeof item.version, "string");
              digestRows.push([table.name, item.pk, item.version]);
            }
          }
        } else {
          for (const table of parsed.descriptor.tables)
            tableCounts[table.name] = 0;
        }
        const eventRows =
          row === undefined ? [] : [[row.state, resourceRef, row.version]];
        return Object.freeze({
          operation,
          state,
          idempotencyRows: idempotency.rows.length,
          keySha256: sha256(parsed.idempotencyKey),
          resourceSha256: resourceRef === null ? null : sha256(resourceRef),
          tableCounts: Object.freeze(tableCounts),
          businessDigest: digest({ rows: digestRows, idempotency: eventRows }),
        });
      },
    );
  }

  async function assertAbsent(input) {
    const evidence = await snapshot(input);
    if (evidence.idempotencyRows !== 0 || evidence.state !== null)
      fail("G15_OWNER_EXPECTED_ABSENT");
    return Object.freeze({
      operation: evidence.operation,
      absent: true,
      keySha256: evidence.keySha256,
    });
  }

  async function snapshotCustomerBusiness() {
    return withClient(connect, databaseByOwner.customer, async (client) => {
      const tableCounts = {};
      const digestRows = [];
      for (const table of CUSTOMER_BUSINESS_TABLES) {
        const result = await client.query(table.sql);
        if (!Array.isArray(result.rows))
          fail("G15_OWNER_CUSTOMER_SNAPSHOT_INVALID");
        tableCounts[table.name] = result.rows.length;
        for (const row of result.rows) {
          if (
            typeof row.pk !== "string" ||
            row.pk.length === 0 ||
            typeof row.version !== "string" ||
            row.version.length === 0
          )
            fail("G15_OWNER_CUSTOMER_SNAPSHOT_INVALID");
          digestRows.push([table.name, row.pk, row.version]);
        }
      }
      return Object.freeze({
        tableCounts: Object.freeze(tableCounts),
        businessDigest: digest(digestRows),
      });
    });
  }

  async function seedInProgress(input) {
    const parsed = validateRequest(input?.operation, input, "seedInProgress");
    const spec = OWNER[parsed.descriptor.owner];
    return withClient(
      connect,
      databaseByOwner[parsed.descriptor.owner],
      async (client) => {
        const leaseOwner = randomUUID();
        await client.query(
          `INSERT INTO ${spec.table} (actor_ref, scope, idempotency_key, request_hash, state, lease_owner, lease_until, created_at, expires_at) VALUES ($1, $2, $3, $4, 'Acquired', $5::uuid, clock_timestamp() + interval '5 minutes', clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
          [
            ACTOR_REF,
            parsed.scope,
            parsed.idempotencyKey,
            parsed.requestHash,
            leaseOwner,
          ],
        );
        return Object.freeze({
          operation: input.operation,
          state: "Acquired",
          keySha256: sha256(parsed.idempotencyKey),
          requestHash: parsed.requestHash,
        });
      },
    );
  }

  async function withLookupUnavailable(input) {
    exactKeys(
      input,
      [
        "operation",
        "idempotencyKey",
        ...(input?.orderRef ? ["orderRef", "itemRef"] : []),
        "exercise",
      ],
      "G15_OWNER_INPUT_INVALID",
    );
    assert.equal(typeof input.exercise, "function");
    const { descriptor, ...identity } = validateRequest(
      input.operation,
      Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== "exercise"),
      ),
      "snapshot",
    );
    const spec = OWNER[descriptor.owner];
    return withClient(
      connect,
      databaseByOwner[descriptor.owner],
      async (client) => {
        const existing = await client.query(
          `SELECT state FROM ${spec.table} WHERE actor_ref = $1 AND scope = $2 AND idempotency_key = $3`,
          [ACTOR_REF, identity.scope, identity.idempotencyKey],
        );
        if (existing.rows?.length !== 1)
          fail("G15_OWNER_LOOKUP_RECORD_REQUIRED");
        const privilege = await client.query(
          "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
          [spec.role, spec.table],
        );
        if (privilege.rows?.[0]?.allowed !== true)
          fail("G15_OWNER_LOOKUP_PRIVILEGE_NOT_PRESENT");
        const aclResult = await client.query(TABLE_ACL_SQL, [spec.table]);
        const originalAcl = validateLookupAcl(aclResult.rows, spec.role);
        let restoreNeeded = false;
        let exerciseResult;
        let primary;
        try {
          restoreNeeded = true;
          await client.query(
            `REVOKE SELECT ON TABLE ${spec.table} FROM ${spec.role}`,
          );
          const afterRevoke = await client.query(
            "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
            [spec.role, spec.table],
          );
          if (afterRevoke.rows?.[0]?.allowed !== false)
            fail("G15_OWNER_LOOKUP_REVOKE_NOT_EFFECTIVE");
        } catch (error) {
          primary = safeOperationError(error, "G15_OWNER_LOOKUP_SETUP_FAILED");
        }
        if (!primary) {
          try {
            exerciseResult = safeExerciseResult(await input.exercise());
          } catch (error) {
            primary = safeOperationError(
              error,
              "G15_OWNER_LOOKUP_EXERCISE_FAILED",
            );
          }
        }
        let restoreFailure;
        if (restoreNeeded) {
          try {
            await client.query(
              `GRANT SELECT ON TABLE ${spec.table} TO ${spec.role}`,
            );
            const restored = await client.query(
              "SELECT has_table_privilege($1, $2, 'SELECT') AS allowed",
              [spec.role, spec.table],
            );
            if (restored.rows?.[0]?.allowed !== true)
              fail("G15_OWNER_LOOKUP_RESTORE_UNVERIFIED");
            const restoredAcl = await client.query(TABLE_ACL_SQL, [spec.table]);
            assert.deepEqual(
              validateLookupAcl(restoredAcl.rows, spec.role),
              originalAcl,
              "G15 owner SELECT ACL did not return to its original state",
            );
          } catch {
            restoreFailure = new G15OwnerEvidenceError(
              "G15_OWNER_LOOKUP_RESTORE_FAILED",
            );
          }
        }
        if (primary && restoreFailure) fail("G15_OWNER_LOOKUP_RESTORE_FAILED");
        if (primary) throw primary;
        if (restoreFailure) throw restoreFailure;
        return Object.freeze({
          operation: input.operation,
          keySha256: sha256(identity.idempotencyKey),
          ...exerciseResult,
          restoreVerified: true,
        });
      },
    );
  }

  return Object.freeze({
    snapshot,
    snapshotCustomerBusiness,
    assertAbsent,
    seedInProgress,
    withLookupUnavailable,
  });
}

export function validateG15BrowserProof(proof, { runId, candidateSha }) {
  exactKeys(
    proof,
    [
      "schemaVersion",
      "runId",
      "candidateSha",
      "status",
      "verificationOnly",
      "productionLogin",
    ],
    "G15_BROWSER_PROOF_SCHEMA_INVALID",
  );
  if (
    proof.schemaVersion !== 1 ||
    proof.runId !== runId ||
    proof.candidateSha !== candidateSha ||
    proof.status !== "passed" ||
    proof.verificationOnly !== true ||
    proof.productionLogin !== false
  )
    fail("G15_BROWSER_PROOF_IDENTITY_INVALID");
  return Object.freeze({ ...proof });
}
