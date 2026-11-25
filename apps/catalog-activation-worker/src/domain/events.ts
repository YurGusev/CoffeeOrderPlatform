import { randomBytes, randomUUID } from "node:crypto";
import type { OutboxMessage } from "@coffee-platform/outbox";
import { nowInstant } from "@coffee-platform/platform-time";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newCatalogRef(prefix: "prd" | "var" | "off" | "msg"): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(nowInstant().epochMilliseconds, 0, 6);
  randomBytes(10).copy(bytes, 6);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

type Shared = Readonly<{
  supplierRef: string;
  snapshotRef: string;
  snapshotRevision: string;
  occurredAt: string;
}>;
type Snapshot = Shared &
  Readonly<{
    productCount: number;
    variantCount: number;
    offerCount: number;
    batchCount: number;
    contentHash: string;
  }>;
type Mapping = Shared &
  Readonly<{
    productRef: string;
    variantRef: string;
    offerRef: string | null;
    mappingRevision: string;
    productSequence?: string;
    mappingState: "Active" | "Missing" | "Stopped";
    availability: "Available" | "Unavailable" | "Stopped";
  }>;

function createMessage(
  messageType: string,
  topic: string,
  key: string,
  aggregateType: string,
  aggregateRef: string,
  aggregateSequence: bigint,
  ownerVersion: string,
  occurredAt: string,
  payload: OutboxMessage["payload"],
): OutboxMessage {
  const messageId = newCatalogRef("msg");
  const correlationId = randomUUID();
  const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
  return {
    messageId,
    messageType,
    topic,
    aggregateRef,
    aggregateSequence,
    ownerVersion,
    partitionKey: key,
    schemaVersion: "1",
    payload,
    occurredAt,
    correlationId,
    traceparent,
    envelope: {
      envelopeVersion: "1",
      messageId,
      messageType,
      occurredAt,
      producer: "catalog-activation-worker",
      correlationId,
      causationId: null,
      traceparent,
      aggregate: {
        type: aggregateType,
        ref: aggregateRef,
        version: ownerVersion,
      },
      payload,
    },
  };
}

export function snapshotActivatedMessage(value: Snapshot): OutboxMessage {
  if (!/^[1-9][0-9]*$/u.test(value.snapshotRevision))
    throw new Error("INVALID_SNAPSHOT_REVISION");
  const payload = {
    supplierRef: value.supplierRef,
    snapshotRef: value.snapshotRef,
    snapshotRevision: value.snapshotRevision,
    activatedAt: value.occurredAt,
    productCount: value.productCount,
    variantCount: value.variantCount,
    offerCount: value.offerCount,
    batchCount: value.batchCount,
    contentHash: value.contentHash,
  };
  return createMessage(
    "CatalogSnapshotActivated.v1",
    "coffee.catalog.snapshot.v1",
    value.supplierRef,
    "CatalogSnapshot",
    value.snapshotRef,
    1n,
    value.snapshotRevision,
    value.occurredAt,
    payload,
  );
}

export function mappingChangedMessage(value: Mapping): OutboxMessage {
  const productSequence = value.productSequence ?? value.mappingRevision;
  if (
    (value.mappingState === "Active") !== (value.offerRef !== null) ||
    !/^[1-9][0-9]*$/u.test(value.mappingRevision) ||
    !/^[1-9][0-9]*$/u.test(productSequence)
  ) {
    throw new Error("INVALID_MAPPING_EVENT");
  }
  const payload = {
    productRef: value.productRef,
    variantRef: value.variantRef,
    offerRef: value.offerRef,
    catalogSnapshotRevision: value.snapshotRevision,
    mappingRevision: value.mappingRevision,
    mappingState: value.mappingState,
    availability: value.availability,
    effectiveAt: value.occurredAt,
  };
  return createMessage(
    "CatalogMappingChanged.v2",
    "coffee.catalog.mapping.v2",
    value.productRef,
    "CatalogMapping",
    value.productRef,
    BigInt(productSequence),
    productSequence,
    value.occurredAt,
    payload,
  );
}
