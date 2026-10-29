import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { isAromaOwnerMessage } from "@coffee-platform/contracts-aroma-v1";
import type { KafkaEnvelope } from "@coffee-platform/kafka-runtime";
import type { PhysicalLine } from "../cart-plan.js";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const REF = (prefix: string): string => `^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`;
const HASH = "^[0-9a-f]{64}$";
const POSITIVE_INT64 = "^[1-9][0-9]*$";
const NONNEGATIVE_INT64 = "^(?:0|[1-9][0-9]*)$";
const SIGNED_INT64 = "^-?(?:0|[1-9][0-9]*)$";
export type LockRow = Readonly<{ locked: true }>;
export type ClockRow = Readonly<{ now: string; ms: string }>;
export type WorkRow = Readonly<{
  desired_revision: string;
  desired_hash: string;
  wake_revision: string;
}>;
export type RevisionRow = Readonly<{ revision: string }>;
export type SequenceRow = Readonly<{ sequence: string }>;
export type ValidRow = Readonly<{ valid: boolean }>;
export type SafeRow = Readonly<{ safe: boolean }>;
export type FenceRow = Readonly<{ fence_epoch: string }>;
export type LineRow = PhysicalLine &
  Readonly<{
    offer_ref: string;
    source_grind_key_hash: string | null;
    quantity_milli: string;
  }>;
export type BlockerRow = Readonly<{ code: string }>;
export type ReservationRow = Readonly<{
  operation_ref: string;
  attempt_ref: string;
  offer_ref: string;
  source_grind_key_hash: string | null;
  desired_milli: string;
  observed_before_milli: string;
  observed_before_revision: string;
  action: "SetQuantity" | "Remove";
  state: string;
  window_ended: boolean;
  remaining_ms: string;
}>;
export type AbandonedRow = Readonly<{
  attempt_ref: string;
  desired_revision: string;
  observed_start_revision: string | null;
  state: "UnknownOutcome" | "Failed";
}>;
export type RemainingRow = Readonly<{ remaining_ms: string }>;
export type ProvenanceRow = Readonly<{ envelope: KafkaEnvelope }>;
export type CatalogSourceRow = Readonly<{
  product_ref: string;
  variant_ref: string;
  catalog_snapshot_revision: string;
  mapping_revision: string;
}>;

export class AromaConvergenceRowDecodeError extends Error {
  public readonly code = "AROMA_CONVERGENCE_DATABASE_ROW_INVALID" as const;
  public constructor() {
    super("AROMA_CONVERGENCE_DATABASE_ROW_INVALID");
    this.name = "AromaConvergenceRowDecodeError";
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
});
for (const format of ["positive-int64", "signed-int64", "nonnegative-int64"])
  ajv.addFormat(format, {
    type: "string",
    validate: (value: string): boolean => {
      try {
        const number = BigInt(value);
        return (
          number <= MAX_INT64 &&
          number >= (format === "nonnegative-int64" ? 0n : -MAX_INT64) &&
          (format !== "positive-int64" || number > 0n)
        );
      } catch {
        return false;
      }
    },
  });
const hash = { type: "string", pattern: HASH, maxLength: 64 };
const ref = (prefix: string) => ({
  type: "string",
  pattern: REF(prefix),
  maxLength: 30,
});
const positiveInt64 = {
  type: "string",
  pattern: POSITIVE_INT64,
  format: "positive-int64",
  maxLength: 19,
};
const nonnegativeInt64 = {
  type: "string",
  pattern: NONNEGATIVE_INT64,
  format: "nonnegative-int64",
  maxLength: 19,
};
const signedInt64 = {
  type: "string",
  pattern: SIGNED_INT64,
  format: "signed-int64",
  maxLength: 20,
};
const object = (
  required: readonly string[],
  properties: Record<string, unknown>,
) => ({ type: "object", additionalProperties: false, required, properties });
const lineSchema = object(
  ["offer_ref", "source_grind_key_hash", "quantity_milli"],
  {
    offer_ref: ref("off"),
    source_grind_key_hash: { anyOf: [hash, { type: "null" }] },
    quantity_milli: positiveInt64,
  },
);

function decoder<T>(
  schema: object,
  refine?: (row: Record<string, unknown>) => boolean,
): (value: unknown) => T {
  const validate: ValidateFunction = ajv.compile(schema);
  return (value: unknown): T => {
    if (
      !validate(value) ||
      (refine !== undefined && !refine(value as Record<string, unknown>))
    )
      throw new AromaConvergenceRowDecodeError();
    return value as T;
  };
}
const valid = { type: "boolean" };
const safe = { type: "boolean" };

export const decodeConvergenceLockRow = decoder<LockRow>(
  object(["locked"], { locked: { type: "boolean", const: true } }),
);
export const decodeConvergenceClockRow = decoder<ClockRow>(
  object(["now", "ms"], {
    now: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    },
    ms: positiveInt64,
  }),
);
export const decodeConvergenceWorkRow = decoder<WorkRow>(
  object(["desired_revision", "desired_hash", "wake_revision"], {
    desired_revision: positiveInt64,
    desired_hash: hash,
    wake_revision: positiveInt64,
  }),
);
export const decodeConvergenceRevisionRow = decoder<RevisionRow>(
  object(["revision"], { revision: positiveInt64 }),
);
export const decodeConvergenceSequenceRow = decoder<SequenceRow>(
  object(["sequence"], { sequence: positiveInt64 }),
);
export const decodeConvergenceValidRow = decoder<ValidRow>(
  object(["valid"], { valid }),
);
export const decodeConvergenceSafeRow = decoder<SafeRow>(
  object(["safe"], { safe }),
);
export const decodeConvergenceFenceRow = decoder<FenceRow>(
  object(["fence_epoch"], { fence_epoch: positiveInt64 }),
);
export const decodeConvergenceLineRow = decoder<LineRow>(lineSchema);
export const decodeConvergenceBlockerRow = decoder<BlockerRow>(
  object(["code"], {
    code: {
      type: "string",
      enum: [
        "MAPPING_CHANGED",
        "MAPPING_MISSING",
        "MAPPING_STOPPED",
        "PRODUCT_UNAVAILABLE",
        "AROMA_QUANTITY_NOT_SUPPORTED",
      ],
    },
  }),
);
export const decodeConvergenceReservationRow = decoder<ReservationRow>(
  object(
    [
      "operation_ref",
      "attempt_ref",
      "offer_ref",
      "source_grind_key_hash",
      "desired_milli",
      "observed_before_milli",
      "observed_before_revision",
      "action",
      "state",
      "window_ended",
      "remaining_ms",
    ],
    {
      operation_ref: ref("op"),
      attempt_ref: ref("att"),
      offer_ref: ref("off"),
      source_grind_key_hash: { anyOf: [hash, { type: "null" }] },
      desired_milli: nonnegativeInt64,
      observed_before_milli: nonnegativeInt64,
      observed_before_revision: positiveInt64,
      action: { type: "string", enum: ["SetQuantity", "Remove"] },
      state: {
        type: "string",
        enum: ["Reserved", "Dispatched", "Acknowledged", "UnknownOutcome"],
      },
      window_ended: { type: "boolean" },
      remaining_ms: signedInt64,
    },
  ),
);
export const decodeConvergenceAbandonedRow = decoder<AbandonedRow>(
  object(
    ["attempt_ref", "desired_revision", "observed_start_revision", "state"],
    {
      attempt_ref: ref("att"),
      desired_revision: positiveInt64,
      observed_start_revision: { anyOf: [positiveInt64, { type: "null" }] },
      state: { type: "string", enum: ["UnknownOutcome", "Failed"] },
    },
  ),
);
export const decodeConvergenceRemainingRow = decoder<RemainingRow>(
  object(["remaining_ms"], { remaining_ms: signedInt64 }),
);
export const decodeConvergenceCatalogSourceRow = decoder<CatalogSourceRow>(
  object(
    [
      "product_ref",
      "variant_ref",
      "catalog_snapshot_revision",
      "mapping_revision",
    ],
    {
      product_ref: ref("prd"),
      variant_ref: ref("var"),
      catalog_snapshot_revision: nonnegativeInt64,
      mapping_revision: nonnegativeInt64,
    },
  ),
);
export const decodeConvergenceProvenanceRow = decoder<ProvenanceRow>(
  object(["envelope"], { envelope: { type: "object" } }),
  (row) =>
    isAromaOwnerMessage(row["envelope"]) &&
    (row["envelope"] as { messageType?: unknown }).messageType ===
      "AromaConvergenceRequested.v1",
);
