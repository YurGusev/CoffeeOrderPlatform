import {
  withTransaction,
  type Database,
  type Transaction,
  type SqlScalar,
} from "@coffee-platform/database";
import { defineStatement } from "@coffee-platform/database/owner";
import { createSqlOutboxStore } from "@coffee-platform/outbox";
import { nowInstant } from "@coffee-platform/platform-time";
import type {
  AromaOfferBindingRequest,
  AromaOfferBindingResponse,
} from "@coffee-platform/contracts-aroma-v1";
import {
  newCatalogRef,
  snapshotActivatedMessage,
  mappingChangedMessage,
} from "../events.js";
import { semanticFingerprint, type SourceIdentity } from "../identity.js";
import {
  CatalogActivationError,
  verifyReceivedGeneration,
  type ReceivedGeneration,
  type VerifiedGeneration,
} from "../verify-generation.js";

type Snapshot = ReceivedGeneration["snapshot"];
type IdentityRow = Readonly<{
  entity_type: string;
  source_identity_hash: string;
  stable_ref: string;
  semantic_fingerprint: string;
  first_seen_snapshot_ref: string;
}>;
type BindingRow = Readonly<{
  source_offer_key_hash: string;
  offer_ref: string;
  first_snapshot_ref: string;
}>;
type StateRow = Readonly<{
  active_snapshot_ref: string | null;
  active_snapshot_revision: string | null;
}>;
type MappingRow = Readonly<{
  variant_ref: string;
  product_ref: string;
  offer_ref: string | null;
  mapping_state: "Active" | "Missing" | "Stopped";
  mapping_revision: string;
  availability: string;
}>;
type Binding = (
  request: AromaOfferBindingRequest,
) => Promise<AromaOfferBindingResponse>;
type RunResult = Readonly<
  | { kind: "idle" }
  | { kind: "pending"; snapshotRef: string }
  | { kind: "rejected"; snapshotRef: string; code: string }
  | { kind: "superseded"; snapshotRef: string }
  | { kind: "activated"; snapshotRef: string; snapshotRevision: string }
>;
const options = (signal?: AbortSignal) => ({
  mode: "background" as const,
  ...(signal === undefined ? {} : { signal }),
});
const SCHEME = "hmac-sha256-v1";

export function createCatalogActivationStore(database: Database): Readonly<{
  runOnce: (bind: Binding, signal?: AbortSignal) => Promise<RunResult>;
  runSnapshot: (
    snapshotRef: string,
    bind: Binding,
    signal?: AbortSignal,
  ) => Promise<RunResult>;
}> {
  const query = <Row>(sql: string) =>
    defineStatement<Row, readonly SqlScalar[]>(database, sql);
  const candidate =
    query<Snapshot>(`SELECT * FROM catalog.supplier_snapshots WHERE state='Received'
    ORDER BY received_at,snapshot_ref FOR UPDATE SKIP LOCKED LIMIT 1`);
  const candidateByRef = query<Snapshot>(
    "SELECT * FROM catalog.supplier_snapshots WHERE state='Received' AND snapshot_ref=$1 FOR UPDATE SKIP LOCKED",
  );
  const activeByRef = query<StateRow>(
    "SELECT active_snapshot_ref,active_snapshot_revision FROM catalog.catalog_state WHERE id=true AND active_snapshot_ref=$1",
  );
  const byRef = query<Snapshot>(
    `SELECT * FROM catalog.supplier_snapshots WHERE snapshot_ref=$1 AND state='Received' FOR UPDATE SKIP LOCKED`,
  );
  const state = query<StateRow>(
    "SELECT active_snapshot_ref,active_snapshot_revision FROM catalog.catalog_state WHERE id=true FOR UPDATE",
  );
  const supersededByActive = query<Readonly<{ stale: boolean }>>(`SELECT
    (active.received_at,active.snapshot_ref) >= (next.received_at,next.snapshot_ref) AS stale
    FROM catalog.supplier_snapshots active CROSS JOIN catalog.supplier_snapshots next
    WHERE active.snapshot_ref=$1 AND next.snapshot_ref=$2`);
  const markStale = query<never>(
    "UPDATE catalog.supplier_snapshots SET state='Superseded' WHERE snapshot_ref=$1 AND state='Received'",
  );
  const batches = query<ReceivedGeneration["batches"][number]>(
    "SELECT batch_number,offer_count,uncompressed_bytes,batch_hash,previous_batch_hash FROM catalog.snapshot_batches WHERE snapshot_ref=$1 ORDER BY batch_number",
  );
  const products = query<ReceivedGeneration["products"][number]>(
    "SELECT source_product_key_hash,image_url FROM catalog.snapshot_products WHERE snapshot_ref=$1",
  );
  const variants = query<ReceivedGeneration["variants"][number]>(
    "SELECT source_variant_key_hash,source_product_key_hash,display_name,unit FROM catalog.snapshot_variants WHERE snapshot_ref=$1",
  );
  const offers = query<ReceivedGeneration["offers"][number]>(
    "SELECT source_offer_key_hash,source_variant_key_hash,batch_number,item_index,supplier_unit_minor,currency,supplier_promotions,grind_options,source_identity_scheme FROM catalog.snapshot_offers WHERE snapshot_ref=$1 ORDER BY batch_number,item_index",
  );
  const availability = query<ReceivedGeneration["availability"][number]>(
    "SELECT source_offer_key_hash,availability FROM catalog.snapshot_availability WHERE snapshot_ref=$1",
  );
  const identityRows = query<IdentityRow>(
    "SELECT entity_type,source_identity_hash,stable_ref,semantic_fingerprint,first_seen_snapshot_ref FROM catalog.source_identities WHERE supplier_ref=$1",
  );
  const insertIdentity = query<never>(`INSERT INTO catalog.source_identities
    (supplier_ref,entity_type,source_identity_scheme,source_identity_hash,stable_ref,semantic_fingerprint,first_seen_snapshot_ref,last_seen_snapshot_ref,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7,'Present')`);
  const bound = query<BindingRow>(
    "SELECT source_offer_key_hash,offer_ref,first_snapshot_ref FROM catalog.offer_binding_acks WHERE snapshot_ref=$1",
  );
  const boundOffer = query<BindingRow>(
    "SELECT source_offer_key_hash,offer_ref,first_snapshot_ref FROM catalog.offer_binding_acks WHERE snapshot_ref=$1 AND source_offer_key_hash=$2",
  );
  const insertAck =
    query<never>(`INSERT INTO catalog.offer_binding_acks(snapshot_ref,source_offer_key_hash,offer_ref,state,first_snapshot_ref,acked_at)
    VALUES($1,$2,$3,'Bound',$4,clock_timestamp()) ON CONFLICT (snapshot_ref,source_offer_key_hash) DO NOTHING`);
  const rejectRow =
    query<never>(`UPDATE catalog.supplier_snapshots SET state='Rejected',failure_code=$2,
    declared_batch_count=NULL,declared_product_count=NULL,declared_variant_count=NULL,declared_offer_count=NULL,
    content_hash=NULL,received_at=NULL WHERE snapshot_ref=$1 AND state='Received'`);
  const outbox = createSqlOutboxStore(database, { schema: "catalog" });
  const insertProducts =
    query<never>(`INSERT INTO catalog.products(snapshot_ref,product_ref,display_name,display_name_sort_key)
    SELECT DISTINCT ON (p.source_product_key_hash) $1::varchar(30),identity.stable_ref,v.display_name,lower(v.display_name)
    FROM catalog.snapshot_products p JOIN catalog.snapshot_variants v USING(snapshot_ref,source_product_key_hash)
    JOIN catalog.source_identities identity ON identity.supplier_ref=$2 AND identity.entity_type='product'
      AND identity.source_identity_scheme='hmac-sha256-v1' AND identity.source_identity_hash=p.source_product_key_hash
    WHERE p.snapshot_ref=$1::varchar(30) ORDER BY p.source_product_key_hash,v.source_variant_key_hash`);
  const insertVariants =
    query<never>(`INSERT INTO catalog.variants(snapshot_ref,variant_ref,product_ref,unit,image_url,grind_options)
    SELECT $1::varchar(30),variant_identity.stable_ref,product_identity.stable_ref,v.unit,p.image_url,o.grind_options
    FROM catalog.snapshot_variants v JOIN catalog.snapshot_products p USING(snapshot_ref,source_product_key_hash)
    JOIN catalog.snapshot_offers o USING(snapshot_ref,source_variant_key_hash)
    JOIN catalog.source_identities variant_identity ON variant_identity.supplier_ref=$2 AND variant_identity.entity_type='variant'
      AND variant_identity.source_identity_scheme='hmac-sha256-v1' AND variant_identity.source_identity_hash=v.source_variant_key_hash
    JOIN catalog.source_identities product_identity ON product_identity.supplier_ref=$2 AND product_identity.entity_type='product'
      AND product_identity.source_identity_scheme='hmac-sha256-v1' AND product_identity.source_identity_hash=v.source_product_key_hash
    WHERE v.snapshot_ref=$1::varchar(30)`);
  const insertMappings = query<never>(`INSERT INTO catalog.offer_mappings
    (snapshot_ref,variant_ref,offer_ref,mapping_revision,mapping_state,supplier_unit_minor,currency,effective_at)
    SELECT $1::varchar(30),variant_identity.stable_ref,
      CASE WHEN a.availability='Stopped' THEN NULL ELSE offer_identity.stable_ref END,
      CASE WHEN old.mapping_state IS NOT DISTINCT FROM CASE WHEN a.availability='Stopped' THEN 'Stopped' ELSE 'Active' END
        AND old.offer_ref IS NOT DISTINCT FROM CASE WHEN a.availability='Stopped' THEN NULL ELSE offer_identity.stable_ref END
        AND old_a.state IS NOT DISTINCT FROM a.availability THEN old.mapping_revision ELSE COALESCE(old.mapping_revision,0)+1 END,
      CASE WHEN a.availability='Stopped' THEN 'Stopped' ELSE 'Active' END,
      CASE WHEN a.availability='Stopped' THEN NULL ELSE o.supplier_unit_minor::bigint END,
      CASE WHEN a.availability='Stopped' THEN NULL ELSE o.currency END,$4::timestamptz
    FROM catalog.snapshot_offers o JOIN catalog.snapshot_availability a USING(snapshot_ref,source_offer_key_hash)
    JOIN catalog.source_identities variant_identity ON variant_identity.supplier_ref=$2 AND variant_identity.entity_type='variant'
      AND variant_identity.source_identity_scheme='hmac-sha256-v1' AND variant_identity.source_identity_hash=o.source_variant_key_hash
    JOIN catalog.source_identities offer_identity ON offer_identity.supplier_ref=$2 AND offer_identity.entity_type='offer'
      AND offer_identity.source_identity_scheme='hmac-sha256-v1' AND offer_identity.source_identity_hash=o.source_offer_key_hash
    LEFT JOIN catalog.offer_mappings old ON old.snapshot_ref=$3 AND old.variant_ref=variant_identity.stable_ref
    LEFT JOIN catalog.availability old_a ON old_a.snapshot_ref=$3 AND old_a.variant_ref=old.variant_ref
    WHERE o.snapshot_ref=$1::varchar(30)`);
  const insertAvailability =
    query<never>(`INSERT INTO catalog.availability(snapshot_ref,variant_ref,state,checked_at)
    SELECT $1::varchar(30),identity.stable_ref,a.availability,$3::timestamptz FROM catalog.snapshot_availability a
    JOIN catalog.snapshot_offers o USING(snapshot_ref,source_offer_key_hash)
    JOIN catalog.source_identities identity ON identity.supplier_ref=$2 AND identity.entity_type='variant'
      AND identity.source_identity_scheme='hmac-sha256-v1' AND identity.source_identity_hash=o.source_variant_key_hash
    WHERE a.snapshot_ref=$1::varchar(30)`);
  const previousMappings =
    query<MappingRow>(`SELECT m.variant_ref,v.product_ref,m.offer_ref,m.mapping_state,
    m.mapping_revision,a.state AS availability FROM catalog.offer_mappings m
    JOIN catalog.variants v USING(snapshot_ref,variant_ref) JOIN catalog.availability a USING(snapshot_ref,variant_ref)
    WHERE m.snapshot_ref=$1`);
  const currentMappings = previousMappings;
  const nextProductEventSequence = query<
    Readonly<{ next_sequence: string }>
  >(`SELECT (COALESCE(MAX(aggregate_sequence),0)+1)::text AS next_sequence
    FROM catalog.outbox_messages WHERE aggregate_ref=$1`);
  const copyMissingProducts =
    query<never>(`INSERT INTO catalog.products(snapshot_ref,product_ref,display_name,display_name_sort_key)
    SELECT $1::varchar(30),p.product_ref,p.display_name,p.display_name_sort_key FROM catalog.products p
    WHERE p.snapshot_ref=$2 AND NOT EXISTS(SELECT 1 FROM catalog.products n WHERE n.snapshot_ref=$1 AND n.product_ref=p.product_ref)`);
  const copyMissingVariants =
    query<never>(`INSERT INTO catalog.variants(snapshot_ref,variant_ref,product_ref,unit,image_url,grind_options)
    SELECT $1::varchar(30),v.variant_ref,v.product_ref,v.unit,v.image_url,v.grind_options FROM catalog.variants v
    WHERE v.snapshot_ref=$2 AND NOT EXISTS(SELECT 1 FROM catalog.variants n WHERE n.snapshot_ref=$1 AND n.variant_ref=v.variant_ref)`);
  const markMissing = query<never>(`INSERT INTO catalog.offer_mappings
    (snapshot_ref,variant_ref,offer_ref,mapping_revision,mapping_state,supplier_unit_minor,currency,effective_at)
    SELECT $1::varchar(30),old.variant_ref,NULL,
      CASE WHEN old.mapping_state='Missing' THEN old.mapping_revision ELSE old.mapping_revision+1 END,
      'Missing',NULL,NULL,$3::timestamptz FROM catalog.offer_mappings old
    WHERE old.snapshot_ref=$2 AND NOT EXISTS(SELECT 1 FROM catalog.offer_mappings new
      WHERE new.snapshot_ref=$1 AND new.variant_ref=old.variant_ref)`);
  const markMissingAvailability =
    query<never>(`INSERT INTO catalog.availability(snapshot_ref,variant_ref,state,checked_at)
    SELECT $1::varchar(30),v.variant_ref,'Unavailable',$3::timestamptz FROM catalog.variants v
    WHERE v.snapshot_ref=$2 AND NOT EXISTS(SELECT 1 FROM catalog.availability a
      WHERE a.snapshot_ref=$1 AND a.variant_ref=v.variant_ref)`);
  const markOld = query<never>(
    "UPDATE catalog.supplier_snapshots SET state='Superseded' WHERE snapshot_ref=$1 AND state='Active'",
  );
  const activate = query<never>(
    "UPDATE catalog.supplier_snapshots SET state='Active' WHERE snapshot_ref=$1 AND state='Received'",
  );
  const switchPointer =
    query<never>(`UPDATE catalog.catalog_state SET active_snapshot_ref=$1,active_snapshot_revision=$2,
    active_content_hash=$3,updated_at=clock_timestamp() WHERE id=true`);
  const updateKnown =
    query<never>(`UPDATE catalog.source_identities SET last_seen_snapshot_ref=$2,state=$5
    WHERE supplier_ref=$1 AND source_identity_hash=$3 AND entity_type=$4 AND source_identity_scheme='hmac-sha256-v1'`);
  const updateMissing = query<never>(
    "UPDATE catalog.source_identities SET state='Missing' WHERE supplier_ref=$1 AND last_seen_snapshot_ref<>$2 AND state IN ('Present','Stopped')",
  );

  async function load(
    tx: Transaction,
    snapshot: Snapshot,
  ): Promise<VerifiedGeneration> {
    const ref = [snapshot.snapshot_ref];
    return verifyReceivedGeneration({
      snapshot,
      batches: (await batches(tx, ref)).rows,
      products: (await products(tx, ref)).rows,
      variants: (await variants(tx, ref)).rows,
      offers: (await offers(tx, ref)).rows,
      availability: (await availability(tx, ref)).rows,
    });
  }

  function identities(generation: VerifiedGeneration): SourceIdentity[] {
    const result: SourceIdentity[] = [];
    for (const row of generation.products)
      result.push({
        entityType: "product",
        sourceHash: row.source_product_key_hash,
      });
    for (const row of generation.variants)
      result.push({
        entityType: "variant",
        sourceHash: row.source_variant_key_hash,
        parentHash: row.source_product_key_hash,
        unit: row.unit,
      });
    for (const row of generation.offers)
      result.push({
        entityType: "offer",
        sourceHash: row.source_offer_key_hash,
        parentHash: row.source_variant_key_hash,
      });
    return result.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType) ||
        left.sourceHash.localeCompare(right.sourceHash),
    );
  }

  async function reserve(
    tx: Transaction,
    generation: VerifiedGeneration,
  ): Promise<
    Map<string, Readonly<{ stableRef: string; firstSnapshotRef: string }>>
  > {
    const known = new Map(
      (await identityRows(tx, [generation.snapshot.supplier_ref])).rows.map(
        (row) => [`${row.entity_type}:${row.source_identity_hash}`, row],
      ),
    );
    const refs = new Map<
      string,
      Readonly<{ stableRef: string; firstSnapshotRef: string }>
    >();
    const missing: Array<
      SourceIdentity & { stableRef: string; fingerprint: string }
    > = [];
    for (const identity of identities(generation)) {
      const key = `${identity.entityType}:${identity.sourceHash}`;
      const fingerprint = semanticFingerprint(identity);
      const old = known.get(key);
      if (old !== undefined && old.semantic_fingerprint !== fingerprint)
        throw new CatalogActivationError("SOURCE_IDENTITY_COLLISION");
      const stableRef =
        old?.stable_ref ??
        newCatalogRef(
          identity.entityType === "product"
            ? "prd"
            : identity.entityType === "variant"
              ? "var"
              : "off",
        );
      refs.set(key, {
        stableRef,
        firstSnapshotRef:
          old?.first_seen_snapshot_ref ?? generation.snapshot.snapshot_ref,
      });
      if (old === undefined)
        missing.push({ ...identity, stableRef, fingerprint });
    }
    for (const identity of missing)
      await insertIdentity(tx, [
        generation.snapshot.supplier_ref,
        identity.entityType,
        SCHEME,
        identity.sourceHash,
        identity.stableRef,
        identity.fingerprint,
        generation.snapshot.snapshot_ref,
      ]);
    return refs;
  }

  async function prepare(
    signal?: AbortSignal,
    snapshotRef?: string,
  ): Promise<
    | RunResult
    | Readonly<{
        kind: "prepared";
        generation: VerifiedGeneration;
        unbound: readonly BindingRow[];
      }>
  > {
    return withTransaction(database, options(signal), async (tx) => {
      const snapshot =
        snapshotRef === undefined
          ? (await candidate(tx, [])).rows[0]
          : (await candidateByRef(tx, [snapshotRef])).rows[0];
      if (snapshot === undefined) return { kind: "idle" } as const;
      const pointer = (await state(tx, [])).rows[0];
      if (pointer === undefined)
        throw new CatalogActivationError("ACTIVATION_POINTER_MISSING");
      if (
        pointer.active_snapshot_ref !== null &&
        (
          await supersededByActive(tx, [
            pointer.active_snapshot_ref,
            snapshot.snapshot_ref,
          ])
        ).rows[0]?.stale
      ) {
        await markStale(tx, [snapshot.snapshot_ref]);
        return {
          kind: "superseded",
          snapshotRef: snapshot.snapshot_ref,
        } as const;
      }
      try {
        const generation = await load(tx, snapshot);
        const refs = await reserve(tx, generation);
        const acks = new Map(
          (await bound(tx, [snapshot.snapshot_ref])).rows.map((row) => [
            row.source_offer_key_hash,
            row,
          ]),
        );
        const unbound = generation.offers
          .filter((offer) => !acks.has(offer.source_offer_key_hash))
          .map((offer) => ({
            source_offer_key_hash: offer.source_offer_key_hash,
            offer_ref: refs.get(`offer:${offer.source_offer_key_hash}`)!
              .stableRef,
            first_snapshot_ref: refs.get(
              `offer:${offer.source_offer_key_hash}`,
            )!.firstSnapshotRef,
          }));
        return { kind: "prepared", generation, unbound } as const;
      } catch (error) {
        if (!(error instanceof CatalogActivationError)) throw error;
        await rejectRow(tx, [snapshot.snapshot_ref, error.code]);
        return {
          kind: "rejected",
          snapshotRef: snapshot.snapshot_ref,
          code: error.code,
        } as const;
      }
    });
  }

  async function materialize(
    tx: Transaction,
    generation: VerifiedGeneration,
    previous: string | null,
    revision: string,
    at: string,
  ): Promise<void> {
    const snapshotRef = generation.snapshot.snapshot_ref;
    const supplierRef = generation.snapshot.supplier_ref;
    const productRows = await insertProducts(tx, [snapshotRef, supplierRef]);
    const variantRows = await insertVariants(tx, [snapshotRef, supplierRef]);
    if (
      productRows.rowCount !== generation.products.length ||
      variantRows.rowCount !== generation.variants.length
    ) {
      throw new CatalogActivationError("ACTIVATION_INVALID_REFERENCE");
    }
    const mappingRows = await insertMappings(tx, [
      snapshotRef,
      supplierRef,
      previous,
      at,
    ]);
    const availabilityRows = await insertAvailability(tx, [
      snapshotRef,
      supplierRef,
      at,
    ]);
    if (
      mappingRows.rowCount !== generation.variants.length ||
      availabilityRows.rowCount !== generation.variants.length
    ) {
      throw new CatalogActivationError("ACTIVATION_INVALID_REFERENCE");
    }
    if (previous !== null) {
      await copyMissingProducts(tx, [snapshotRef, previous]);
      await copyMissingVariants(tx, [snapshotRef, previous]);
      await markMissing(tx, [snapshotRef, previous, at]);
      await markMissingAvailability(tx, [snapshotRef, previous, at]);
    }
    const stoppedOffers = new Set(
      generation.availability
        .filter((row) => row.availability === "Stopped")
        .map((row) => row.source_offer_key_hash),
    );
    for (const identity of identities(generation)) {
      await updateKnown(tx, [
        supplierRef,
        snapshotRef,
        identity.sourceHash,
        identity.entityType,
        identity.entityType === "offer" &&
        stoppedOffers.has(identity.sourceHash)
          ? "Stopped"
          : "Present",
      ]);
    }
    await updateMissing(tx, [supplierRef, snapshotRef]);
    if (previous !== null) await markOld(tx, [previous]);
    await activate(tx, [snapshotRef]);
    await switchPointer(tx, [
      snapshotRef,
      revision,
      generation.snapshot.content_hash,
    ]);
  }

  async function finalize(
    snapshotRef: string,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return withTransaction(database, options(signal), async (tx) => {
      const snapshot = (await byRef(tx, [snapshotRef])).rows[0];
      if (snapshot === undefined) return { kind: "idle" } as const;
      const pointer = (await state(tx, [])).rows[0];
      if (pointer === undefined)
        throw new CatalogActivationError("ACTIVATION_POINTER_MISSING");
      if (
        pointer.active_snapshot_ref !== null &&
        (
          await supersededByActive(tx, [
            pointer.active_snapshot_ref,
            snapshotRef,
          ])
        ).rows[0]?.stale
      ) {
        await markStale(tx, [snapshotRef]);
        return { kind: "superseded", snapshotRef } as const;
      }
      let generation: VerifiedGeneration;
      try {
        generation = await load(tx, snapshot);
      } catch (error) {
        if (!(error instanceof CatalogActivationError)) throw error;
        await rejectRow(tx, [snapshotRef, error.code]);
        return { kind: "rejected", snapshotRef, code: error.code } as const;
      }
      const acks = (await bound(tx, [snapshotRef])).rows;
      if (acks.length !== generation.offers.length)
        return { kind: "pending", snapshotRef } as const;
      const known = new Map(
        (await identityRows(tx, [snapshot.supplier_ref])).rows.map((row) => [
          `${row.entity_type}:${row.source_identity_hash}`,
          row,
        ]),
      );
      for (const row of acks) {
        const identity = known.get(`offer:${row.source_offer_key_hash}`);
        if (
          identity?.stable_ref !== row.offer_ref ||
          identity.first_seen_snapshot_ref !== row.first_snapshot_ref
        ) {
          throw new CatalogActivationError("ACTIVATION_BINDING_MISMATCH");
        }
      }
      const old =
        pointer.active_snapshot_ref === null
          ? []
          : (await previousMappings(tx, [pointer.active_snapshot_ref])).rows;
      const previous = new Map(old.map((row) => [row.variant_ref, row]));
      const revision = String(
        BigInt(pointer.active_snapshot_revision ?? "0") + 1n,
      );
      const at = nowInstant().toString();
      await materialize(
        tx,
        generation,
        pointer.active_snapshot_ref,
        revision,
        at,
      );
      const current = [...(await currentMappings(tx, [snapshotRef])).rows].sort(
        (left, right) =>
          left.product_ref.localeCompare(right.product_ref) ||
          left.variant_ref.localeCompare(right.variant_ref),
      );
      const snapshotEvent = snapshotActivatedMessage({
        supplierRef: snapshot.supplier_ref,
        snapshotRef,
        snapshotRevision: revision,
        occurredAt: at,
        productCount: generation.products.length,
        variantCount: generation.variants.length,
        offerCount: generation.offers.length,
        batchCount: generation.batches.length,
        contentHash: snapshot.content_hash!,
      });
      if ((await outbox.enqueue(tx, snapshotEvent)) !== "created")
        throw new Error("ACTIVATION_OUTBOX_CONFLICT");
      for (const row of current) {
        const prior = previous.get(row.variant_ref);
        if (
          prior?.offer_ref === row.offer_ref &&
          prior.mapping_state === row.mapping_state &&
          prior.availability === row.availability
        )
          continue;
        const productSequence = (
          await nextProductEventSequence(tx, [row.product_ref])
        ).rows[0]?.next_sequence;
        if (productSequence === undefined)
          throw new CatalogActivationError(
            "ACTIVATION_OUTBOX_SEQUENCE_MISSING",
          );
        const event = mappingChangedMessage({
          supplierRef: snapshot.supplier_ref,
          snapshotRef,
          snapshotRevision: revision,
          occurredAt: at,
          productRef: row.product_ref,
          variantRef: row.variant_ref,
          offerRef: row.offer_ref,
          mappingRevision: String(row.mapping_revision),
          mappingState: row.mapping_state,
          availability: row.availability as
            "Available" | "Unavailable" | "Stopped",
          productSequence,
        });
        if ((await outbox.enqueue(tx, event)) !== "created")
          throw new Error("ACTIVATION_OUTBOX_CONFLICT");
      }
      return {
        kind: "activated",
        snapshotRef,
        snapshotRevision: revision,
      } as const;
    });
  }

  async function finishPrepared(
    work: Awaited<ReturnType<typeof prepare>>,
    bind: Binding,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (work.kind !== "prepared") return work;
    const snapshot = work.generation.snapshot;
    for (const offer of work.unbound) {
      if (signal?.aborted)
        return { kind: "pending", snapshotRef: snapshot.snapshot_ref };
      const request: AromaOfferBindingRequest = {
        offerRef: offer.offer_ref,
        supplierRef: snapshot.supplier_ref,
        snapshotRef: offer.first_snapshot_ref,
        sourceIdentityScheme: SCHEME,
        sourceOfferKeyHash: offer.source_offer_key_hash,
      };
      const response = await bind(request);
      if (
        response.state !== "Bound" ||
        response.offerRef !== request.offerRef ||
        response.supplierRef !== request.supplierRef ||
        response.sourceIdentityScheme !== request.sourceIdentityScheme ||
        response.sourceOfferKeyHash !== request.sourceOfferKeyHash ||
        response.firstSnapshotRef !== offer.first_snapshot_ref
      ) {
        throw new CatalogActivationError("ACTIVATION_BINDING_MISMATCH");
      }
      await withTransaction(database, options(signal), async (tx) => {
        const existing = (
          await boundOffer(tx, [
            snapshot.snapshot_ref,
            offer.source_offer_key_hash,
          ])
        ).rows[0];
        if (existing !== undefined) {
          if (
            existing.offer_ref !== response.offerRef ||
            existing.first_snapshot_ref !== response.firstSnapshotRef
          ) {
            throw new CatalogActivationError("ACTIVATION_BINDING_MISMATCH");
          }
          return;
        }
        await insertAck(tx, [
          snapshot.snapshot_ref,
          offer.source_offer_key_hash,
          response.offerRef,
          response.firstSnapshotRef,
        ]);
      });
    }
    return finalize(snapshot.snapshot_ref, signal);
  }
  async function runOnce(
    bind: Binding,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return finishPrepared(await prepare(signal), bind, signal);
  }
  async function runSnapshot(
    snapshotRef: string,
    bind: Binding,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (!/^snp_[0-9A-HJKMNP-TV-Z]{26}$/u.test(snapshotRef))
      throw new CatalogActivationError("ACTIVATION_INVALID_SNAPSHOT");
    const work = await prepare(signal, snapshotRef);
    if (work.kind !== "idle") return finishPrepared(work, bind, signal);
    return withTransaction(database, options(signal), async (tx) => {
      const active = (await activeByRef(tx, [snapshotRef])).rows[0];
      return active?.active_snapshot_revision === null || active === undefined
        ? ({ kind: "idle" } as const)
        : ({
            kind: "activated",
            snapshotRef,
            snapshotRevision: active.active_snapshot_revision,
          } as const);
    });
  }
  return { runOnce, runSnapshot };
}
