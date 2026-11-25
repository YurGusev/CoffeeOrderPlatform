import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import pg from "pg";
import { test } from "node:test";
import {
  catalogBatchBytes,
  catalogBatchHash,
  catalogContentHash,
} from "../../packages/contracts/aroma-v1/dist/index.js";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import { createCatalogActivationStore } from "../../apps/catalog-activation-worker/dist/infrastructure/activation-store.js";
import { semanticFingerprint } from "../../apps/catalog-activation-worker/dist/domain/identity.js";
import { verifyReceivedGeneration } from "../../apps/catalog-activation-worker/dist/domain/verify-generation.js";

const P = "1".repeat(64);
const V = "2".repeat(64);
const O = "3".repeat(64);
const P2 = "4".repeat(64);
const V2 = "5".repeat(64);
const O2 = "6".repeat(64);
const P3 = "7".repeat(64);
const V3 = "8".repeat(64);
const O3 = "9".repeat(64);
const P4 = "a".repeat(64);
const V4 = "b".repeat(64);
const O4 = "c".repeat(64);
const S = `snp_${"0".repeat(26)}`;
const SUP = `sup_${"0".repeat(26)}`;
const PRIOR = `snp_${"1".repeat(26)}`;
const RETURNING = `snp_${"2".repeat(26)}`;

function fixture() {
  const product = { source_product_key_hash: P, image_url: null };
  const variant = {
    source_variant_key_hash: V,
    source_product_key_hash: P,
    display_name: "Кофе",
    unit: "piece",
  };
  const offer = {
    source_offer_key_hash: O,
    source_variant_key_hash: V,
    batch_number: 0,
    item_index: 0,
    supplier_unit_minor: "12345",
    currency: "RUB",
    supplier_promotions: [],
    grind_options: [],
    source_identity_scheme: "hmac-sha256-v1",
  };
  const availability = { source_offer_key_hash: O, availability: "Available" };
  const items = [
    {
      sourceProductKeyHash: P,
      sourceVariantKeyHash: V,
      sourceOfferKeyHash: O,
      displayName: "Кофе",
      unit: "piece",
      supplierUnitMinor: "12345",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
  ];
  const batchHash = catalogBatchHash(items);
  return {
    snapshot: {
      snapshot_ref: S,
      supplier_ref: SUP,
      state: "Received",
      next_batch_number: 1,
      declared_batch_count: 1,
      declared_product_count: 1,
      declared_variant_count: 1,
      declared_offer_count: 1,
      received_batch_count: 1,
      received_product_count: 1,
      received_variant_count: 1,
      received_offer_count: 1,
      content_hash: catalogContentHash([batchHash]),
    },
    batches: [
      {
        batch_number: 0,
        offer_count: 1,
        uncompressed_bytes: catalogBatchBytes(items),
        batch_hash: batchHash,
        previous_batch_hash: null,
      },
    ],
    products: [product],
    variants: [variant],
    offers: [offer],
    availability: [availability],
  };
}

function coldActivationFixture() {
  const items = [
    {
      sourceProductKeyHash: P,
      sourceVariantKeyHash: V,
      sourceOfferKeyHash: O,
      displayName: "Кофе",
      unit: "piece",
      supplierUnitMinor: "12345",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
    {
      sourceProductKeyHash: P2,
      sourceVariantKeyHash: V2,
      sourceOfferKeyHash: O2,
      displayName: "Какао",
      unit: "gram",
      supplierUnitMinor: "67890",
      currency: "RUB",
      availability: "Unavailable",
      imageUrl: "https://catalog.example/image",
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
  ];
  const batchHash = catalogBatchHash(items);
  return {
    snapshot: {
      snapshot_ref: S,
      supplier_ref: SUP,
      state: "Received",
      next_batch_number: 1,
      declared_batch_count: 1,
      declared_product_count: 2,
      declared_variant_count: 2,
      declared_offer_count: 2,
      received_batch_count: 1,
      received_product_count: 2,
      received_variant_count: 2,
      received_offer_count: 2,
      content_hash: catalogContentHash([batchHash]),
    },
    batches: [
      {
        batch_number: 0,
        offer_count: 2,
        uncompressed_bytes: catalogBatchBytes(items),
        batch_hash: batchHash,
        previous_batch_hash: null,
      },
    ],
    products: [
      { source_product_key_hash: P, image_url: null },
      {
        source_product_key_hash: P2,
        image_url: "https://catalog.example/image",
      },
    ],
    variants: [
      {
        source_variant_key_hash: V,
        source_product_key_hash: P,
        display_name: "Кофе",
        unit: "piece",
      },
      {
        source_variant_key_hash: V2,
        source_product_key_hash: P2,
        display_name: "Какао",
        unit: "gram",
      },
    ],
    offers: [
      {
        source_offer_key_hash: O,
        source_variant_key_hash: V,
        batch_number: 0,
        item_index: 0,
        supplier_unit_minor: "12345",
        currency: "RUB",
        supplier_promotions: [],
        grind_options: [],
        source_identity_scheme: "hmac-sha256-v1",
      },
      {
        source_offer_key_hash: O2,
        source_variant_key_hash: V2,
        batch_number: 0,
        item_index: 1,
        supplier_unit_minor: "67890",
        currency: "RUB",
        supplier_promotions: [],
        grind_options: [],
        source_identity_scheme: "hmac-sha256-v1",
      },
    ],
    availability: [
      { source_offer_key_hash: O, availability: "Available" },
      { source_offer_key_hash: O2, availability: "Unavailable" },
    ],
  };
}

function successorActivationFixture() {
  const items = [
    {
      sourceProductKeyHash: P,
      sourceVariantKeyHash: V,
      sourceOfferKeyHash: O,
      displayName: "Кофе",
      unit: "piece",
      supplierUnitMinor: "12345",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
    {
      sourceProductKeyHash: P2,
      sourceVariantKeyHash: V2,
      sourceOfferKeyHash: O2,
      displayName: "Какао",
      unit: "gram",
      supplierUnitMinor: "67890",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
    {
      sourceProductKeyHash: P3,
      sourceVariantKeyHash: V3,
      sourceOfferKeyHash: O3,
      displayName: "Эспрессо",
      unit: "gram",
      supplierUnitMinor: "98765",
      currency: "RUB",
      availability: "Stopped",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
  ];
  const batchHash = catalogBatchHash(items);
  return {
    snapshot: {
      snapshot_ref: S,
      supplier_ref: SUP,
      state: "Received",
      next_batch_number: 1,
      declared_batch_count: 1,
      declared_product_count: 3,
      declared_variant_count: 3,
      declared_offer_count: 3,
      received_batch_count: 1,
      received_product_count: 3,
      received_variant_count: 3,
      received_offer_count: 3,
      content_hash: catalogContentHash([batchHash]),
    },
    batches: [
      {
        batch_number: 0,
        offer_count: items.length,
        uncompressed_bytes: catalogBatchBytes(items),
        batch_hash: batchHash,
        previous_batch_hash: null,
      },
    ],
    products: [
      { source_product_key_hash: P, image_url: null },
      { source_product_key_hash: P2, image_url: null },
      { source_product_key_hash: P3, image_url: null },
    ],
    variants: [
      {
        source_variant_key_hash: V,
        source_product_key_hash: P,
        display_name: "Кофе",
        unit: "piece",
      },
      {
        source_variant_key_hash: V2,
        source_product_key_hash: P2,
        display_name: "Какао",
        unit: "gram",
      },
      {
        source_variant_key_hash: V3,
        source_product_key_hash: P3,
        display_name: "Эспрессо",
        unit: "gram",
      },
    ],
    offers: items.map((item, item_index) => ({
      source_offer_key_hash: item.sourceOfferKeyHash,
      source_variant_key_hash: item.sourceVariantKeyHash,
      batch_number: 0,
      item_index,
      supplier_unit_minor: item.supplierUnitMinor,
      currency: item.currency,
      supplier_promotions: [],
      grind_options: [],
      source_identity_scheme: "hmac-sha256-v1",
    })),
    availability: items.map((item) => ({
      source_offer_key_hash: item.sourceOfferKeyHash,
      availability: item.availability,
    })),
  };
}

function returningActivationFixture() {
  const items = [
    {
      sourceProductKeyHash: P4,
      sourceVariantKeyHash: V4,
      sourceOfferKeyHash: O4,
      displayName: "Возврат",
      unit: "gram",
      supplierUnitMinor: "32100",
      currency: "RUB",
      availability: "Available",
      imageUrl: null,
      supplierPromotions: [],
      grindOptions: [],
      sourceIdentityScheme: "hmac-sha256-v1",
    },
  ];
  const batchHash = catalogBatchHash(items);
  return {
    snapshot: {
      snapshot_ref: RETURNING,
      supplier_ref: SUP,
      state: "Received",
      next_batch_number: 1,
      declared_batch_count: 1,
      declared_product_count: 1,
      declared_variant_count: 1,
      declared_offer_count: 1,
      received_batch_count: 1,
      received_product_count: 1,
      received_variant_count: 1,
      received_offer_count: 1,
      content_hash: catalogContentHash([batchHash]),
    },
    batches: [
      {
        batch_number: 0,
        offer_count: 1,
        uncompressed_bytes: catalogBatchBytes(items),
        batch_hash: batchHash,
        previous_batch_hash: null,
      },
    ],
    products: [{ source_product_key_hash: P4, image_url: null }],
    variants: [
      {
        source_variant_key_hash: V4,
        source_product_key_hash: P4,
        display_name: "Возврат",
        unit: "gram",
      },
    ],
    offers: [
      {
        source_offer_key_hash: O4,
        source_variant_key_hash: V4,
        batch_number: 0,
        item_index: 0,
        supplier_unit_minor: "32100",
        currency: "RUB",
        supplier_promotions: [],
        grind_options: [],
        source_identity_scheme: "hmac-sha256-v1",
      },
    ],
    availability: [{ source_offer_key_hash: O4, availability: "Available" }],
  };
}

function previousIdentity(entityType, sourceHash, stableRef, parentHash, unit) {
  const identity = {
    entityType,
    sourceHash,
    ...(parentHash === undefined ? {} : { parentHash }),
    ...(unit === undefined ? {} : { unit }),
  };
  return {
    entity_type: entityType,
    source_identity_hash: sourceHash,
    stable_ref: stableRef,
    semantic_fingerprint: semanticFingerprint(identity),
    first_seen_snapshot_ref: PRIOR,
    last_seen_snapshot_ref: PRIOR,
    state: "Present",
  };
}

function stableRef(prefix, digit) {
  return `${prefix}_${digit.repeat(26)}`;
}

function fails(generation, code) {
  assert.throws(
    () => verifyReceivedGeneration(generation),
    (error) => error.code === code,
    code,
  );
}

function mockActivationDatabase(t, options = {}) {
  const { rowCountMismatch = null, wrongOfferReference = false } = options;
  const input = options.input ?? coldActivationFixture();
  const activeSnapshotRef = options.activeSnapshotRef ?? null;
  const activeSnapshotRevision = options.activeSnapshotRevision ?? null;
  const previousMappings = options.previousMappings ?? [];
  const queries = [];
  const identityRows = [...(options.identityRows ?? [])];
  const acknowledgements = [];
  let acknowledgementInsertedSinceRelease = false;
  const writes = new Map();
  const outboxMessages = [];
  const productSequences = new Map();
  const pointer = {
    active_snapshot_ref: activeSnapshotRef,
    active_snapshot_revision: activeSnapshotRevision,
  };
  const connection = new EventEmitter();
  connection.query = async (query) => {
    const sql = typeof query === "string" ? query : query.text;
    const values = typeof query === "string" ? [] : query.values;
    queries.push({ sql, values });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      return { rows: [], rowCount: 0, command: sql };
    if (sql.startsWith("SET LOCAL "))
      return { rows: [], rowCount: 0, command: "SET" };
    if (sql === "SELECT 1")
      return { rows: [{ "?column?": 1 }], rowCount: 1, command: "SELECT" };
    if (
      sql.includes("FROM catalog.supplier_snapshots WHERE state='Received'") &&
      sql.includes("ORDER BY received_at,snapshot_ref")
    )
      return { rows: [input.snapshot], rowCount: 1, command: "SELECT" };
    if (
      sql.includes(
        "FROM catalog.supplier_snapshots WHERE state='Received' AND snapshot_ref=$1",
      )
    )
      return { rows: [input.snapshot], rowCount: 1, command: "SELECT" };
    if (
      sql.includes(
        "FROM catalog.supplier_snapshots WHERE snapshot_ref=$1 AND state='Received'",
      )
    )
      return { rows: [input.snapshot], rowCount: 1, command: "SELECT" };
    if (sql.includes("FROM catalog.catalog_state WHERE id=true FOR UPDATE"))
      return { rows: [{ ...pointer }], rowCount: 1, command: "SELECT" };
    if (sql.includes("AS stale"))
      return { rows: [{ stale: false }], rowCount: 1, command: "SELECT" };
    if (sql.includes("FROM catalog.snapshot_batches WHERE snapshot_ref=$1"))
      return {
        rows: input.batches,
        rowCount: input.batches.length,
        command: "SELECT",
      };
    if (sql.includes("FROM catalog.snapshot_products WHERE snapshot_ref=$1"))
      return {
        rows: input.products,
        rowCount: input.products.length,
        command: "SELECT",
      };
    if (sql.includes("FROM catalog.snapshot_variants WHERE snapshot_ref=$1"))
      return {
        rows: input.variants,
        rowCount: input.variants.length,
        command: "SELECT",
      };
    if (sql.includes("FROM catalog.snapshot_offers WHERE snapshot_ref=$1"))
      return {
        rows: input.offers,
        rowCount: input.offers.length,
        command: "SELECT",
      };
    if (
      sql.includes("FROM catalog.snapshot_availability WHERE snapshot_ref=$1")
    )
      return {
        rows: input.availability,
        rowCount: input.availability.length,
        command: "SELECT",
      };
    if (sql.includes("FROM catalog.source_identities WHERE supplier_ref=$1")) {
      const rows = wrongOfferReference
        ? identityRows.map((row) =>
            row.entity_type === "offer"
              ? { ...row, stable_ref: `off_${"9".repeat(26)}` }
              : row,
          )
        : identityRows;
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    if (
      sql.includes(
        "FROM catalog.offer_binding_acks WHERE snapshot_ref=$1 AND source_offer_key_hash=$2",
      )
    ) {
      const row = acknowledgements.find(
        (item) =>
          item.snapshot_ref === values[0] &&
          item.source_offer_key_hash === values[1],
      );
      return {
        rows: row === undefined ? [] : [row],
        rowCount: row === undefined ? 0 : 1,
        command: "SELECT",
      };
    }
    if (sql.includes("FROM catalog.offer_binding_acks WHERE snapshot_ref=$1")) {
      const rows = acknowledgements.filter(
        (item) => item.snapshot_ref === values[0],
      );
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    if (sql.includes("INSERT INTO catalog.source_identities")) {
      const inserted = JSON.parse(values[3]);
      identityRows.push(
        ...inserted.map((row) => ({
          ...row,
          first_seen_snapshot_ref: values[2],
        })),
      );
      return { rows: [], rowCount: inserted.length, command: "INSERT" };
    }
    if (sql.includes("INSERT INTO catalog.offer_binding_acks")) {
      acknowledgements.push({
        snapshot_ref: values[0],
        source_offer_key_hash: values[1],
        offer_ref: values[2],
        first_snapshot_ref: values[3],
      });
      acknowledgementInsertedSinceRelease = true;
      return { rows: [], rowCount: 1, command: "INSERT" };
    }
    if (
      sql.includes("INSERT INTO catalog.offer_mappings") &&
      sql.includes("FROM catalog.offer_mappings old")
    ) {
      const current = writes.get("mappings") ?? [];
      const currentVariants = new Set(current.map((row) => row.variant_ref));
      const missing = previousMappings
        .filter((row) => !currentVariants.has(row.variant_ref))
        .map((row) => ({
          variant_ref: row.variant_ref,
          offer_ref: null,
          mapping_revision:
            row.mapping_state === "Missing"
              ? row.mapping_revision
              : String(BigInt(row.mapping_revision) + 1n),
          mapping_state: "Missing",
          supplier_unit_minor: null,
          currency: null,
        }));
      writes.set("mappings", [...current, ...missing]);
      return { rows: [], rowCount: missing.length, command: "INSERT" };
    }
    if (
      sql.includes("INSERT INTO catalog.availability") &&
      sql.includes("FROM catalog.variants v")
    ) {
      const current = writes.get("availability") ?? [];
      const currentVariants = new Set(current.map((row) => row.variant_ref));
      const missing = previousMappings
        .filter((row) => !currentVariants.has(row.variant_ref))
        .map((row) => ({
          variant_ref: row.variant_ref,
          availability: "Unavailable",
        }));
      writes.set("availability", [...current, ...missing]);
      return { rows: [], rowCount: missing.length, command: "INSERT" };
    }
    if (
      sql.includes("INSERT INTO catalog.products") &&
      sql.includes("FROM catalog.products p")
    )
      return { rows: [], rowCount: 0, command: "INSERT" };
    if (
      sql.includes("INSERT INTO catalog.variants") &&
      sql.includes("FROM catalog.variants v")
    )
      return { rows: [], rowCount: 0, command: "INSERT" };
    for (const [name, marker, jsonIndex] of [
      ["products", "INSERT INTO catalog.products", 1],
      ["variants", "INSERT INTO catalog.variants", 1],
      ["mappings", "INSERT INTO catalog.offer_mappings", 2],
      ["availability", "INSERT INTO catalog.availability", 2],
    ]) {
      if (sql.startsWith(marker)) {
        const rows = JSON.parse(values[jsonIndex]);
        writes.set(name, rows);
        const rowCount =
          rowCountMismatch === name ? rows.length - 1 : rows.length;
        return { rows: [], rowCount, command: "INSERT" };
      }
    }
    if (
      sql.includes(
        "UPDATE catalog.source_identities identity SET last_seen_snapshot_ref=$2",
      )
    ) {
      const updates = JSON.parse(values[2]);
      writes.set("knownUpdates", updates);
      for (const update of updates) {
        const row = identityRows.find(
          (item) =>
            item.entity_type === update.entity_type &&
            item.source_identity_hash === update.source_identity_hash,
        );
        if (row !== undefined) {
          row.last_seen_snapshot_ref = values[1];
          row.state = update.state;
        }
      }
      return {
        rows: [],
        rowCount:
          rowCountMismatch === "updateKnown"
            ? updates.length - 1
            : updates.length,
        command: "UPDATE",
      };
    }
    if (
      sql.includes(
        "SELECT m.variant_ref,v.product_ref,m.offer_ref,m.mapping_state",
      )
    ) {
      if (values[0] === activeSnapshotRef)
        return {
          rows: previousMappings,
          rowCount: previousMappings.length,
          command: "SELECT",
        };
      const variantRows = writes.get("variants") ?? [];
      const availabilityRows = new Map(
        (writes.get("availability") ?? []).map((row) => [
          row.variant_ref,
          row.availability,
        ]),
      );
      const previousProducts = new Map(
        previousMappings.map((row) => [row.variant_ref, row.product_ref]),
      );
      const rows = (writes.get("mappings") ?? []).map((mapping) => ({
        variant_ref: mapping.variant_ref,
        product_ref:
          variantRows.find((row) => row.variant_ref === mapping.variant_ref)
            ?.product_ref ?? previousProducts.get(mapping.variant_ref),
        offer_ref: mapping.offer_ref,
        mapping_state: mapping.mapping_state,
        mapping_revision: mapping.mapping_revision,
        availability: availabilityRows.get(mapping.variant_ref),
      }));
      return { rows, rowCount: rows.length, command: "SELECT" };
    }
    if (
      sql.includes(
        "SELECT (COALESCE(MAX(aggregate_sequence),0)+1)::text AS next_sequence",
      )
    ) {
      const next = (productSequences.get(values[0]) ?? 0) + 1;
      productSequences.set(values[0], next);
      return {
        rows: [{ next_sequence: String(next) }],
        rowCount: 1,
        command: "SELECT",
      };
    }
    if (
      sql.includes('SELECT aggregate_sequence FROM "catalog"."outbox_messages"')
    ) {
      const latest = outboxMessages
        .filter((row) => row.aggregateRef === values[0])
        .at(-1);
      return {
        rows:
          latest === undefined
            ? []
            : [{ aggregate_sequence: latest.aggregateSequence }],
        rowCount: latest === undefined ? 0 : 1,
        command: "SELECT",
      };
    }
    if (sql.includes('FROM "catalog"."outbox_messages" WHERE message_id = $1'))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (sql.includes('FROM "catalog"."outbox_messages"'))
      return { rows: [], rowCount: 0, command: "SELECT" };
    if (sql.startsWith('INSERT INTO "catalog"."outbox_messages"')) {
      outboxMessages.push({
        messageId: values[0],
        messageType: values[1],
        aggregateRef: values[3],
        aggregateSequence: values[4],
      });
      return {
        rows: [{ message_id: values[0] }],
        rowCount: 1,
        command: "INSERT",
      };
    }
    const normalizedSql = sql.replace(/\s+/gu, " ").trim();
    if (
      normalizedSql ===
      "UPDATE catalog.source_identities SET state='Missing' WHERE supplier_ref=$1 AND last_seen_snapshot_ref<>$2 AND state IN ('Present','Stopped')"
    ) {
      for (const row of identityRows)
        if (
          row.last_seen_snapshot_ref !== values[1] &&
          ["Present", "Stopped"].includes(row.state)
        )
          row.state = "Missing";
      return { rows: [], rowCount: identityRows.length, command: "UPDATE" };
    }
    if (
      normalizedSql ===
      "UPDATE catalog.supplier_snapshots SET state='Active' WHERE snapshot_ref=$1 AND state='Received'"
    )
      return { rows: [], rowCount: 1, command: "UPDATE" };
    if (
      normalizedSql ===
      "UPDATE catalog.supplier_snapshots SET state='Superseded' WHERE snapshot_ref=$1 AND state='Active'"
    )
      return { rows: [], rowCount: 1, command: "UPDATE" };
    if (
      normalizedSql ===
      "UPDATE catalog.catalog_state SET active_snapshot_ref=$1,active_snapshot_revision=$2, active_content_hash=$3,updated_at=clock_timestamp() WHERE id=true"
    ) {
      pointer.active_snapshot_ref = values[0];
      pointer.active_snapshot_revision = values[1];
      return { rows: [], rowCount: 1, command: "UPDATE" };
    }
    throw new Error(`unhandled activation SQL: ${sql}`);
  };
  connection.release = () => {
    if (acknowledgementInsertedSinceRelease) {
      acknowledgementInsertedSinceRelease = false;
      options.afterAckInsertCommit?.();
    }
  };
  t.mock.method(pg.Pool.prototype, "connect", async () => connection);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const database = createDatabase({
    owner: "catalog-activation-worker",
    database: "coffee_platform_catalog",
    allowedDatabase: "coffee_platform_catalog",
    host: "127.0.0.1",
    port: 5432,
    user: "test",
    password: "test-only",
    ssl: false,
    pool: {
      max: 2,
      checkoutTimeoutMs: 100,
      lockTimeoutMs: 100,
      interactiveStatementTimeoutMs: 1000,
      backgroundStatementTimeoutMs: 1000,
      terminalTimeoutMs: 100,
      transactionTimeoutMs: 2000,
      idleTimeoutMs: 5000,
      maxLifetimeMs: 10_000,
    },
    shutdownGraceMs: 5000,
  });
  t.after(() => database.resource.destroy());
  return {
    acknowledgements,
    database,
    queries,
    writes,
    identityRows,
    outboxMessages,
  };
}

async function activateMockSnapshot(t, options) {
  const harness = mockActivationDatabase(t, options);
  await harness.database.resource.start(new AbortController().signal);
  const store = createCatalogActivationStore(harness.database);
  const result = await store.runSnapshot(S, async (request) => ({
    ...request,
    firstSnapshotRef: request.snapshotRef,
    state: "Bound",
  }));
  return { ...harness, result };
}

void test("reconstitutes canonical items and validates all durable hashes/counts", () => {
  const input = fixture();
  const result = verifyReceivedGeneration(input);
  assert.equal(result.snapshot.snapshot_ref, S);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].sourceOfferKeyHash, O);
});

void test("missing or out-of-order batch fails closed", () => {
  const generation = fixture();
  generation.batches = [];
  fails(generation, "ACTIVATION_BATCH_SEQUENCE_MISMATCH");
  const other = fixture();
  other.batches[0].batch_number = 1;
  fails(other, "ACTIVATION_BATCH_SEQUENCE_MISMATCH");
});

void test("durable batch bytes/hash or terminal content hash cannot be trusted", () => {
  const bytes = fixture();
  bytes.batches[0].uncompressed_bytes++;
  fails(bytes, "ACTIVATION_BATCH_HASH_MISMATCH");
  const hash = fixture();
  hash.batches[0].batch_hash = "0".repeat(64);
  fails(hash, "ACTIVATION_BATCH_HASH_MISMATCH");
  const terminal = fixture();
  terminal.snapshot.content_hash = "0".repeat(64);
  fails(terminal, "ACTIVATION_CONTENT_HASH_MISMATCH");
});

void test("counts, orphan references and duplicate source identities reject generation", () => {
  const counts = fixture();
  counts.snapshot.declared_variant_count = 2;
  fails(counts, "ACTIVATION_COUNT_MISMATCH");
  const orphan = fixture();
  orphan.variants[0].source_product_key_hash = "4".repeat(64);
  fails(orphan, "ACTIVATION_INVALID_REFERENCE");
  const duplicate = fixture();
  duplicate.offers.push({ ...duplicate.offers[0] });
  duplicate.availability.push({ ...duplicate.availability[0] });
  duplicate.snapshot.declared_offer_count = 2;
  duplicate.snapshot.received_offer_count = 2;
  fails(duplicate, "SOURCE_IDENTITY_COLLISION");
});

void test("invalid enums, money and currency reject even when SQL checks were bypassed", () => {
  const money = fixture();
  money.offers[0].supplier_unit_minor = "-1";
  fails(money, "ACTIVATION_INVALID_MONEY");
  const currency = fixture();
  currency.offers[0].currency = "USD";
  fails(currency, "ACTIVATION_INVALID_CURRENCY");
  const availability = fixture();
  availability.availability[0].availability = "UNKNOWN";
  fails(availability, "ACTIVATION_INVALID_ENUM");
});

void test("unreferenced entities and multiple offers for one variant fail closed", () => {
  const product = fixture();
  product.products.push({
    source_product_key_hash: "4".repeat(64),
    image_url: null,
  });
  product.snapshot.declared_product_count =
    product.snapshot.received_product_count = 2;
  fails(product, "ACTIVATION_INVALID_REFERENCE");
  const variant = fixture();
  variant.variants.push({
    ...variant.variants[0],
    source_variant_key_hash: "5".repeat(64),
  });
  variant.snapshot.declared_variant_count =
    variant.snapshot.received_variant_count = 2;
  fails(variant, "ACTIVATION_INVALID_REFERENCE");
  const ambiguous = fixture();
  ambiguous.offers.push({
    ...ambiguous.offers[0],
    source_offer_key_hash: "6".repeat(64),
    item_index: 1,
  });
  ambiguous.availability.push({
    ...ambiguous.availability[0],
    source_offer_key_hash: "6".repeat(64),
  });
  ambiguous.snapshot.declared_offer_count =
    ambiguous.snapshot.received_offer_count = 2;
  fails(ambiguous, "ACTIVATION_AMBIGUOUS_MAPPING");
});

void test("cold activation writes one verified JSONB batch per catalog surface and marks known identities", async (t) => {
  const { queries, result, writes, identityRows } = await activateMockSnapshot(
    t,
    {},
  );
  assert.deepEqual(result, {
    kind: "activated",
    snapshotRef: S,
    snapshotRevision: "1",
  });
  const stableRef = (entityType, sourceHash) =>
    identityRows.find(
      (row) =>
        row.entity_type === entityType &&
        row.source_identity_hash === sourceHash,
    ).stable_ref;
  const productRef = stableRef("product", P);
  const productRef2 = stableRef("product", P2);
  const variantRef = stableRef("variant", V);
  const variantRef2 = stableRef("variant", V2);
  const offerRef = stableRef("offer", O);
  const offerRef2 = stableRef("offer", O2);
  for (const [ref, prefix] of [
    [productRef, "prd"],
    [productRef2, "prd"],
    [variantRef, "var"],
    [variantRef2, "var"],
    [offerRef, "off"],
    [offerRef2, "off"],
  ])
    assert.match(ref, new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u"));
  assert.deepEqual(writes.get("products"), [
    { product_ref: productRef, display_name: "Кофе" },
    { product_ref: productRef2, display_name: "Какао" },
  ]);
  assert.deepEqual(writes.get("variants"), [
    {
      variant_ref: variantRef,
      product_ref: productRef,
      unit: "piece",
      image_url: null,
      grind_options: [],
    },
    {
      variant_ref: variantRef2,
      product_ref: productRef2,
      unit: "gram",
      image_url: "https://catalog.example/image",
      grind_options: [],
    },
  ]);
  assert.deepEqual(writes.get("mappings"), [
    {
      variant_ref: variantRef,
      offer_ref: offerRef,
      mapping_revision: "1",
      mapping_state: "Active",
      supplier_unit_minor: "12345",
      currency: "RUB",
    },
    {
      variant_ref: variantRef2,
      offer_ref: offerRef2,
      mapping_revision: "1",
      mapping_state: "Active",
      supplier_unit_minor: "67890",
      currency: "RUB",
    },
  ]);
  assert.deepEqual(writes.get("availability"), [
    { variant_ref: variantRef, availability: "Available" },
    { variant_ref: variantRef2, availability: "Unavailable" },
  ]);
  assert.deepEqual(writes.get("knownUpdates"), [
    { entity_type: "offer", source_identity_hash: O, state: "Present" },
    { entity_type: "offer", source_identity_hash: O2, state: "Present" },
    { entity_type: "product", source_identity_hash: P, state: "Present" },
    { entity_type: "product", source_identity_hash: P2, state: "Present" },
    { entity_type: "variant", source_identity_hash: V, state: "Present" },
    { entity_type: "variant", source_identity_hash: V2, state: "Present" },
  ]);
  for (const marker of [
    "INSERT INTO catalog.products",
    "INSERT INTO catalog.variants",
    "INSERT INTO catalog.offer_mappings",
    "INSERT INTO catalog.availability",
    "UPDATE catalog.source_identities identity SET last_seen_snapshot_ref=$2",
  ]) {
    const matching = queries.filter(({ sql }) => sql.startsWith(marker));
    assert.equal(
      matching.length,
      1,
      `${marker} should be issued once as a batch`,
    );
    assert.match(matching[0].sql, /jsonb_to_recordset\(/u);
  }
});

void test("runOnce selects the Received candidate and completes its binding", async (t) => {
  const harness = mockActivationDatabase(t);
  await harness.database.resource.start(new AbortController().signal);
  const store = createCatalogActivationStore(harness.database);
  const bindingRequests = [];
  const result = await store.runOnce(async (request) => {
    bindingRequests.push(request);
    return {
      ...request,
      firstSnapshotRef: request.snapshotRef,
      state: "Bound",
    };
  });

  assert.deepEqual(result, {
    kind: "activated",
    snapshotRef: S,
    snapshotRevision: "1",
  });
  assert.ok(
    harness.queries.some(({ sql }) =>
      sql.includes(
        "ORDER BY received_at,snapshot_ref FOR UPDATE SKIP LOCKED LIMIT 1",
      ),
    ),
    "runOnce must select the Received candidate instead of requiring an explicit snapshot reference",
  );
  assert.ok(
    harness.queries.some(({ sql }) =>
      sql.includes("UPDATE catalog.catalog_state SET active_snapshot_ref=$1"),
    ),
    "activation must publish the active snapshot pointer",
  );
  assert.equal(
    bindingRequests.length,
    2,
    "runOnce must request bindings for each offer in the Received candidate",
  );
  assert.ok(bindingRequests.every((request) => request.snapshotRef === S));
  assert.ok(harness.outboxMessages.length > 0);
});

void test("runOnce waits on an incomplete ACK set and reuses committed bindings", async (t) => {
  const controller = new AbortController();
  let interruptedAfterFirstAck = false;
  const harness = mockActivationDatabase(t, {
    afterAckInsertCommit: () => {
      if (interruptedAfterFirstAck) return;
      interruptedAfterFirstAck = true;
      controller.abort();
    },
  });
  await harness.database.resource.start(new AbortController().signal);
  const store = createCatalogActivationStore(harness.database);
  const requests = [];
  const first = await store.runOnce(async (request) => {
    requests.push(request);
    return {
      ...request,
      firstSnapshotRef: request.snapshotRef,
      state: "Bound",
    };
  }, controller.signal);

  assert.deepEqual(first, { kind: "pending", snapshotRef: S });
  assert.equal(interruptedAfterFirstAck, true);
  assert.equal(harness.acknowledgements.length, 1);
  const committedAck = structuredClone(harness.acknowledgements[0]);
  assert.equal(committedAck.snapshot_ref, S);
  assert.equal(committedAck.source_offer_key_hash, O);

  const second = await store.runOnce(async (request) => {
    requests.push(request);
    return {
      ...request,
      firstSnapshotRef: request.snapshotRef,
      state: "Bound",
    };
  });
  assert.deepEqual(second, {
    kind: "activated",
    snapshotRef: S,
    snapshotRevision: "1",
  });
  assert.deepEqual(
    requests.map((request) => request.sourceOfferKeyHash),
    [O, O2],
    "the resumed pass skips the first offer whose ACK was already committed",
  );
  assert.deepEqual(harness.acknowledgements[0], committedAck);
  assert.deepEqual(
    harness.acknowledgements
      .map((ack) => ack.source_offer_key_hash)
      .sort((left, right) => left.localeCompare(right)),
    [O, O2].sort((left, right) => left.localeCompare(right)),
    "each offer keeps exactly one durable binding ACK",
  );
  const insertedAckHashes = harness.queries
    .filter(({ sql }) => sql.includes("INSERT INTO catalog.offer_binding_acks"))
    .map(({ values }) => values[1]);
  assert.deepEqual(insertedAckHashes, [O, O2]);
});

void test("successor activation preserves stable refs and mapping revisions, and records changed, missing, and stopped offers", async (t) => {
  const originalPoolConnect = pg.Pool.prototype.connect;
  const originalPoolEnd = pg.Pool.prototype.end;
  const productRefs = {
    p: stableRef("prd", "0"),
    p2: stableRef("prd", "1"),
    p3: stableRef("prd", "2"),
  };
  const variantRefs = {
    v: stableRef("var", "0"),
    v2: stableRef("var", "1"),
    v3: stableRef("var", "2"),
    missing: stableRef("var", "3"),
  };
  const offerRefs = {
    same: stableRef("off", "0"),
    changedPrior: stableRef("off", "1"),
    stopped: stableRef("off", "2"),
    missing: stableRef("off", "3"),
  };
  const identityRows = [
    previousIdentity("product", P, productRefs.p),
    previousIdentity("product", P2, productRefs.p2),
    previousIdentity("product", P3, productRefs.p3),
    previousIdentity("variant", V, variantRefs.v, P, "piece"),
    previousIdentity("variant", V2, variantRefs.v2, P2, "gram"),
    previousIdentity("variant", V3, variantRefs.v3, P3, "gram"),
    previousIdentity("offer", O, offerRefs.same, V),
    previousIdentity("offer", O3, offerRefs.stopped, V3),
    previousIdentity("product", P4, stableRef("prd", "3")),
    previousIdentity("variant", V4, variantRefs.missing, P4, "gram"),
    previousIdentity("offer", O4, offerRefs.missing, V4),
  ];
  const previousMappings = [
    {
      variant_ref: variantRefs.v,
      product_ref: productRefs.p,
      offer_ref: offerRefs.same,
      mapping_state: "Active",
      mapping_revision: "7",
      availability: "Available",
    },
    {
      variant_ref: variantRefs.v2,
      product_ref: productRefs.p2,
      offer_ref: offerRefs.changedPrior,
      mapping_state: "Active",
      mapping_revision: "8",
      availability: "Available",
    },
    {
      variant_ref: variantRefs.v3,
      product_ref: productRefs.p3,
      offer_ref: offerRefs.stopped,
      mapping_state: "Active",
      mapping_revision: "2",
      availability: "Available",
    },
    {
      variant_ref: variantRefs.missing,
      product_ref: stableRef("prd", "3"),
      offer_ref: offerRefs.missing,
      mapping_state: "Active",
      mapping_revision: "4",
      availability: "Available",
    },
  ];
  let identityRowsAfterMissing;
  await t.test(
    "successor records changed, stopped, and missing offers while preserving stable refs",
    async (subtest) => {
      const harness = mockActivationDatabase(subtest, {
        input: successorActivationFixture(),
        activeSnapshotRef: PRIOR,
        activeSnapshotRevision: "11",
        previousMappings,
        identityRows,
      });
      await harness.database.resource.start(new AbortController().signal);
      const store = createCatalogActivationStore(harness.database);
      const result = await store.runSnapshot(S, async (request) => ({
        ...request,
        firstSnapshotRef: request.snapshotRef,
        state: "Bound",
      }));
      assert.deepEqual(result, {
        kind: "activated",
        snapshotRef: S,
        snapshotRevision: "12",
      });
      const mappings = new Map(
        harness.writes.get("mappings").map((row) => [row.variant_ref, row]),
      );
      assert.deepEqual(mappings.get(variantRefs.v), {
        variant_ref: variantRefs.v,
        offer_ref: offerRefs.same,
        mapping_revision: "7",
        mapping_state: "Active",
        supplier_unit_minor: "12345",
        currency: "RUB",
      });
      assert.equal(mappings.get(variantRefs.v2).mapping_state, "Active");
      assert.equal(mappings.get(variantRefs.v2).mapping_revision, "9");
      assert.notEqual(
        mappings.get(variantRefs.v2).offer_ref,
        offerRefs.changedPrior,
      );
      assert.deepEqual(mappings.get(variantRefs.v3), {
        variant_ref: variantRefs.v3,
        offer_ref: null,
        mapping_revision: "3",
        mapping_state: "Stopped",
        supplier_unit_minor: null,
        currency: null,
      });
      assert.deepEqual(mappings.get(variantRefs.missing), {
        variant_ref: variantRefs.missing,
        offer_ref: null,
        mapping_revision: "5",
        mapping_state: "Missing",
        supplier_unit_minor: null,
        currency: null,
      });
      const newOffer = harness.identityRows.find(
        (row) => row.entity_type === "offer" && row.source_identity_hash === O2,
      );
      assert.equal(newOffer.stable_ref, mappings.get(variantRefs.v2).offer_ref);
      assert.equal(newOffer.first_seen_snapshot_ref, S);
      const mappingEvents = harness.outboxMessages.filter(
        (row) => row.messageType === "CatalogMappingChanged.v2",
      );
      assert.equal(
        mappingEvents.length,
        3,
        "unchanged mapping emits no event; changed, stopped, and missing mappings do",
      );
      assert.deepEqual(
        harness.writes
          .get("knownUpdates")
          .filter((row) => row.entity_type === "offer"),
        [
          { entity_type: "offer", source_identity_hash: O, state: "Present" },
          { entity_type: "offer", source_identity_hash: O2, state: "Present" },
          { entity_type: "offer", source_identity_hash: O3, state: "Stopped" },
        ],
      );
      assert.equal(
        harness.identityRows.find(
          (row) =>
            row.entity_type === "offer" && row.source_identity_hash === O4,
        ).state,
        "Missing",
      );
      identityRowsAfterMissing = structuredClone(harness.identityRows);
    },
  );
  assert.equal(
    pg.Pool.prototype.connect,
    originalPoolConnect,
    "successor subtest restores Pool.connect",
  );
  assert.equal(
    pg.Pool.prototype.end,
    originalPoolEnd,
    "successor subtest restores Pool.end",
  );

  await t.test(
    "returning offer reuses its stable ref after Missing",
    async (subtest) => {
      const returningHarness = mockActivationDatabase(subtest, {
        input: returningActivationFixture(),
        activeSnapshotRef: S,
        activeSnapshotRevision: "12",
        previousMappings: [
          {
            variant_ref: variantRefs.missing,
            product_ref: stableRef("prd", "3"),
            offer_ref: null,
            mapping_state: "Missing",
            mapping_revision: "5",
            availability: "Unavailable",
          },
        ],
        identityRows: identityRowsAfterMissing,
      });
      await returningHarness.database.resource.start(
        new AbortController().signal,
      );
      const returningStore = createCatalogActivationStore(
        returningHarness.database,
      );
      const returned = await returningStore.runSnapshot(
        RETURNING,
        async (request) => ({
          ...request,
          firstSnapshotRef: request.snapshotRef,
          state: "Bound",
        }),
      );
      assert.deepEqual(returned, {
        kind: "activated",
        snapshotRef: RETURNING,
        snapshotRevision: "13",
      });
      const returnedMapping = returningHarness.writes.get("mappings")[0];
      assert.deepEqual(returnedMapping, {
        variant_ref: variantRefs.missing,
        offer_ref: offerRefs.missing,
        mapping_revision: "6",
        mapping_state: "Active",
        supplier_unit_minor: "32100",
        currency: "RUB",
      });
      assert.equal(
        returningHarness.identityRows.find(
          (row) =>
            row.entity_type === "offer" && row.source_identity_hash === O4,
        ).stable_ref,
        offerRefs.missing,
      );
    },
  );
  assert.equal(
    pg.Pool.prototype.connect,
    originalPoolConnect,
    "returning subtest restores Pool.connect",
  );
  assert.equal(
    pg.Pool.prototype.end,
    originalPoolEnd,
    "returning subtest restores Pool.end",
  );
});

void test("activation rolls back when a materialization batch reports the wrong row count", async (t) => {
  for (const mismatch of [
    "products",
    "variants",
    "mappings",
    "availability",
    "updateKnown",
  ]) {
    await t.test(mismatch, async (subtest) => {
      const { database, queries } = mockActivationDatabase(subtest, {
        rowCountMismatch: mismatch,
      });
      await database.resource.start(new AbortController().signal);
      const store = createCatalogActivationStore(database);
      await assert.rejects(
        store.runSnapshot(S, async (request) => ({
          ...request,
          firstSnapshotRef: request.snapshotRef,
          state: "Bound",
        })),
        (error) => error.code === "ACTIVATION_INVALID_REFERENCE",
      );
      assert.deepEqual(
        queries
          .map(({ sql }) => sql)
          .filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
          .slice(-2),
        ["BEGIN", "ROLLBACK"],
      );
    });
  }
});

void test("activation rejects an acknowledgement whose stable offer reference changed before finalization", async (t) => {
  const { database, queries } = mockActivationDatabase(t, {
    wrongOfferReference: true,
  });
  await database.resource.start(new AbortController().signal);
  const store = createCatalogActivationStore(database);
  await assert.rejects(
    store.runSnapshot(S, async (request) => ({
      ...request,
      firstSnapshotRef: request.snapshotRef,
      state: "Bound",
    })),
    (error) => error.code === "ACTIVATION_BINDING_MISMATCH",
  );
  assert.deepEqual(
    queries
      .map(({ sql }) => sql)
      .filter((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql))
      .slice(-2),
    ["BEGIN", "ROLLBACK"],
  );
});
