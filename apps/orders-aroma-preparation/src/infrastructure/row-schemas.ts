import {toInstant} from "@coffee-platform/platform-time";
import {Ajv2020} from "ajv/dist/2020.js";
import type {ValidateFunction} from "ajv";
import {isAromaOwnerMessage} from "@coffee-platform/contracts-aroma-v1";
import type {JsonValue} from "@coffee-platform/idempotency";
import type {Contribution, ContributionLine} from "../domain/desired.js";
import type {Attempt, CurrentDesired, CurrentObserved} from "../domain/projection.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const REF = (prefix: string): string => `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`;
const HASH = "^[0-9a-f]{64}$";
const INT64 = "^(?:0|[1-9][0-9]*)$";
const POSITIVE_INT64 = "^[1-9][0-9]*$";
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export type ClockRow = Readonly<{now: string; ms: string}>;
export type DesiredRow = CurrentDesired & Readonly<{created_at: string}>;
export type MappingRow = Readonly<{mapping_revision: string; catalog_snapshot_revision: string; payload_hash: string}>;
export type OrderRow = Readonly<{order_ref: string; version: string; status: string}>;
export type LeaseRow = Readonly<{fence_epoch: string; owner_instance_id: string; active: boolean}>;
export type WrittenRow = Readonly<{projection_version: string; material_change: boolean; snapshot: JsonValue}>;
export type RevisionRow = Readonly<{revision: string}>;
export type SequenceRow = Readonly<{sequence: string}>;
export type WorkRow = Readonly<{desired_revision: string | null; dirty: boolean}>;
export type ContributionSqlRow = ContributionLine;
export type ObservationRow = CurrentObserved;
export type AttemptSqlRow = Attempt;
export type ReservationBarrierRow = Readonly<{unresolved: boolean; unknown: boolean}>;
export type BooleanRow = Readonly<{valid: boolean}>;
export type PresenceRow = Readonly<{present: boolean}>;
export type ExactRow = Readonly<{exact: boolean}>;
export type EnvelopeRow = Readonly<{envelope: unknown}>;
export type LockRow = Readonly<{locked: true}>;

export class AromaPreparationRowDecodeError extends Error {
  public readonly code = "AROMA_PREPARATION_DATABASE_ROW_INVALID" as const;
  public constructor() {super("AROMA_PREPARATION_DATABASE_ROW_INVALID"); this.name = "AromaPreparationRowDecodeError";}
}

const ajv = new Ajv2020({allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false});
for (const format of ["int64", "positive-int64"]) ajv.addFormat(format, {
  type: "string",
  validate: (value: string): boolean => {
    try {const number = BigInt(value); return number <= MAX_INT64 && (format !== "positive-int64" || number > 0n);} catch {return false;}
  },
});
const timestamp = {type: "string", minLength: 19, maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}(?::?\\d{2})?)?$"};
const hash = {type: "string", pattern: HASH, maxLength: 64};
const ref = (prefix: string) => ({type: "string", pattern: REF(prefix), maxLength: 30});
const int64 = {type: "string", pattern: INT64, format: "int64", maxLength: 19};
const positiveInt64 = {type: "string", pattern: POSITIVE_INT64, format: "positive-int64", maxLength: 19};
const object = (required: readonly string[], properties: Record<string, unknown>) => ({type: "object", additionalProperties: false, required, properties});
const foundItemProof = object(["itemRef", "found", "productRef", "variantRef", "offerRef", "grind", "quantity", "mappingOffer", "mappingRevision", "mappingState", "availability"], {
  itemRef: ref("itm"), found: {type: "boolean", const: true}, productRef: ref("prd"), variantRef: ref("var"), offerRef: ref("off"),
  grind: {anyOf: [hash, {type: "null"}]}, quantity: positiveInt64,
  mappingOffer: {anyOf: [ref("off"), {type: "null"}]}, mappingRevision: {anyOf: [int64, {type: "null"}]},
  mappingState: {anyOf: [{type: "string", enum: ["Active", "Missing", "Stopped"]}, {type: "null"}]},
  availability: {anyOf: [{type: "string", enum: ["Available", "Unavailable", "Stopped"]}, {type: "null"}]},
});
const missingItemProof = object(["itemRef", "found", "productRef", "variantRef", "offerRef", "grind", "quantity", "mappingOffer", "mappingRevision", "mappingState", "availability"], {
  itemRef: ref("itm"), found: {type: "boolean", const: false}, productRef: {type: "null"}, variantRef: {type: "null"},
  offerRef: {type: "null"}, grind: {type: "null"}, quantity: {type: "null"}, mappingOffer: {type: "null"},
  mappingRevision: {type: "null"}, mappingState: {type: "null"}, availability: {type: "null"},
});
const itemProof = {oneOf: [foundItemProof, missingItemProof]};
const cardSnapshot = object([
  "order_ref", "cart_scope_ref", "projection_version", "desired_revision", "desired_hash", "observed_revision", "observed_cart_fingerprint",
  "verified_desired_revision", "verified_desired_hash", "verified_observed_revision", "verified_cart_fingerprint",
  "attempt_ref", "verified_attempt_ref", "fence_epoch", "state", "blocker_codes", "last_observed_at", "updated_at", "source_message_id",
], {
  order_ref: ref("ord"), cart_scope_ref: {type: "string", const: "aroma-primary"}, projection_version: positiveInt64, desired_revision: int64,
  desired_hash: {anyOf: [hash, {type: "null"}]}, observed_revision: int64,
  observed_cart_fingerprint: {anyOf: [hash, {type: "null"}]}, verified_desired_revision: {anyOf: [positiveInt64, {type: "null"}]},
  verified_desired_hash: {anyOf: [hash, {type: "null"}]}, verified_observed_revision: {anyOf: [positiveInt64, {type: "null"}]},
  verified_cart_fingerprint: {anyOf: [hash, {type: "null"}]}, attempt_ref: {anyOf: [ref("att"), {type: "null"}]},
  verified_attempt_ref: {anyOf: [ref("att"), {type: "null"}]}, fence_epoch: {anyOf: [positiveInt64, {type: "null"}]},
  state: {type: "string", enum: ["PendingObservation", "UnknownOutcome", "Blocked", "Converging", "InSync", "OutOfSync"]},
  blocker_codes: {type: "array", items: {type: "string", minLength: 1, maxLength: 64}},
  last_observed_at: {anyOf: [timestamp, {type: "null"}]}, updated_at: timestamp,
  source_message_id: {type: "string", minLength: 1, maxLength: 128},
});

function decoder<T>(schema: object, refine?: (row: Record<string, unknown>) => boolean): (value: unknown) => T {
  const validate: ValidateFunction = ajv.compile(schema);
  return (value: unknown): T => {
    if (!validate(value) || (refine !== undefined && !refine(value as Record<string, unknown>))) throw new AromaPreparationRowDecodeError();
    return value as T;
  };
}
function jsonDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {toInstant(value.replace(" ", "T").replace(/([+-]\d{2})$/u, "$1:00")); return true;} catch {return false;}
}

export const decodePreparationLockRow = decoder<LockRow>(object(["locked"], {locked: {type: "boolean", const: true}}));
export const decodePreparationClockRow = decoder<ClockRow>(object(["now", "ms"], {now: timestamp, ms: positiveInt64}));
export const decodePreparationMappingRow = decoder<MappingRow>(object(["mapping_revision", "catalog_snapshot_revision", "payload_hash"], {
  mapping_revision: int64, catalog_snapshot_revision: int64, payload_hash: hash,
}));
export const decodePreparationContributionRow = decoder<Contribution>(object(["order_ref", "contribution_revision", "order_version"], {
  order_ref: ref("ord"), contribution_revision: positiveInt64, order_version: positiveInt64,
}));
export const decodePreparationContributionLine = decoder<ContributionSqlRow>(object([
  "order_ref", "contribution_revision", "offer_ref", "source_grind_key_hash", "quantity_milli", "contribution_hash", "item_refs", "items",
], {
  order_ref: ref("ord"), contribution_revision: positiveInt64, offer_ref: ref("off"),
  source_grind_key_hash: {anyOf: [hash, {type: "null"}]}, quantity_milli: positiveInt64, contribution_hash: hash,
  item_refs: {type: "array", minItems: 1, items: ref("itm")}, items: {type: "array", items: itemProof},
}));
export const decodePreparationDesiredRow = decoder<DesiredRow>(object(["desired_revision", "desired_hash", "created_at"], {
  desired_revision: positiveInt64, desired_hash: hash, created_at: timestamp,
}), row => jsonDate(row["created_at"]));
export const decodePreparationRevisionRow = decoder<RevisionRow>(object(["revision"], {revision: positiveInt64}));
export const decodePreparationSequenceRow = decoder<SequenceRow>(object(["sequence"], {sequence: positiveInt64}));
export const decodePreparationWorkRow = decoder<WorkRow>(object(["desired_revision", "dirty"], {
  desired_revision: {anyOf: [positiveInt64, {type: "null"}]}, dirty: {type: "boolean"},
}));
export const decodePreparationOrderRow = decoder<OrderRow>(object(["order_ref", "version", "status"], {
  order_ref: ref("ord"), version: positiveInt64, status: {type: "string", enum: ["Draft", "Confirmed"]},
}));
export const decodePreparationObservedRow = decoder<ObservationRow>(object(["observed_revision", "cart_fingerprint", "captured_at", "fresh"], {
  observed_revision: positiveInt64, cart_fingerprint: hash, captured_at: timestamp, fresh: {type: "boolean"},
}), row => jsonDate(row["captured_at"]));
export const decodePreparationLeaseRow = decoder<LeaseRow>(object(["fence_epoch", "owner_instance_id", "active"], {
  fence_epoch: positiveInt64, owner_instance_id: {type: "string", pattern: UUID, maxLength: 36}, active: {type: "boolean"},
}));
export const decodePreparationAttemptRow = decoder<AttemptSqlRow>(object([
  "attempt_ref", "desired_revision", "desired_hash", "fence_epoch", "state", "owner_instance_id", "observed_start_revision",
  "observed_end_revision", "failure_code", "blocker_codes",
], {
  attempt_ref: ref("att"), desired_revision: positiveInt64, desired_hash: hash, fence_epoch: positiveInt64,
  state: {type: "string", enum: ["Started", "Observed", "MutationReserved", "MutationDispatched", "VerifiedInSync", "NoOpInSync", "OutOfSync", "UnknownOutcome", "Blocked", "Failed"]},
  owner_instance_id: {type: "string", pattern: UUID, maxLength: 36},
  observed_start_revision: {anyOf: [positiveInt64, {type: "null"}]}, observed_end_revision: {anyOf: [positiveInt64, {type: "null"}]},
  failure_code: {anyOf: [{type: "string", minLength: 1, maxLength: 128}, {type: "null"}]},
  blocker_codes: {type: "array", items: {type: "string", minLength: 1, maxLength: 64}},
}));
export const decodePreparationBarrierRow = decoder<ReservationBarrierRow>(object(["unresolved", "unknown"], {
  unresolved: {type: "boolean"}, unknown: {type: "boolean"},
}));
export const decodePreparationExactRow = decoder<ExactRow>(object(["exact"], {exact: {type: "boolean"}}));
export const decodePreparationWrittenRow = decoder<WrittenRow>(object(["projection_version", "material_change", "snapshot"], {
  projection_version: positiveInt64, material_change: {type: "boolean"}, snapshot: cardSnapshot,
}), row => {
  const snapshot = row["snapshot"] as Record<string, unknown>;
  const isSync = snapshot["state"] === "InSync";
  const snapshotVersion = BigInt(snapshot["projection_version"] as string);
  const cardVersion = BigInt(row["projection_version"] as string);
  return (row["material_change"] ? snapshotVersion === cardVersion : snapshotVersion <= cardVersion) &&
    (snapshot["desired_revision"] === "0") === (snapshot["desired_hash"] === null) &&
    (snapshot["observed_revision"] === "0") === (snapshot["observed_cart_fingerprint"] === null) &&
    (snapshot["verified_desired_revision"] === null) === (snapshot["verified_desired_hash"] === null) &&
    (snapshot["verified_observed_revision"] === null) === (snapshot["verified_cart_fingerprint"] === null) &&
    (snapshot["attempt_ref"] === null) === (snapshot["fence_epoch"] === null) &&
    (!isSync || (snapshot["verified_attempt_ref"] === snapshot["attempt_ref"] && (snapshot["blocker_codes"] as unknown[]).length === 0));
});
export const decodePreparationBooleanRow = decoder<BooleanRow>(object(["valid"], {valid: {type: "boolean"}}));
export const decodePreparationPresenceRow = decoder<PresenceRow>(object(["present"], {present: {type: "boolean"}}));
export const decodePreparationEnvelopeRow = decoder<EnvelopeRow>(object(["envelope"], {envelope: {type: "object"}}), row => isAromaOwnerMessage(row["envelope"]));
