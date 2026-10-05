import {toInstant} from "@coffee-platform/platform-time";
import {Ajv2020} from "ajv/dist/2020.js";
import type {ValidateFunction} from "ajv";

const MAX_INT64 = 9_223_372_036_854_775_807n;
const POSITIVE_INT64 = "^[1-9][0-9]*$";
export type LockRow = Readonly<{locked: true}>;
export type PermitRow = Readonly<{lease_until: string}>;
export type BooleanRow = Readonly<{valid: boolean}>;
export type RevisionRow = Readonly<{revision: string}>;
export type SequenceRow = Readonly<{sequence: string}>;
export type ClockRow = Readonly<{now: string}>;

export class AromaObserverRowDecodeError extends Error {
  public readonly code = "AROMA_OBSERVER_DATABASE_ROW_INVALID" as const;
  public constructor() {super("AROMA_OBSERVER_DATABASE_ROW_INVALID"); this.name = "AromaObserverRowDecodeError";}
}

const ajv = new Ajv2020({allErrors: true, strict: true, coerceTypes: false, removeAdditional: false, useDefaults: false});
ajv.addFormat("positive-int64", {
  type: "string",
  validate: (value: string): boolean => {
    try {const number = BigInt(value); return number > 0n && number <= MAX_INT64;} catch {return false;}
  },
});
const positiveInt64 = {type: "string", pattern: POSITIVE_INT64, format: "positive-int64", maxLength: 19};
const object = (required: readonly string[], properties: Record<string, unknown>) => ({type: "object", additionalProperties: false, required, properties});
function decoder<T>(schema: object, refine?: (row: Record<string, unknown>) => boolean): (value: unknown) => T {
  const validate: ValidateFunction = ajv.compile(schema);
  return (value: unknown): T => {
    if (!validate(value) || (refine !== undefined && !refine(value as Record<string, unknown>))) throw new AromaObserverRowDecodeError();
    return value as T;
  };
}
function timestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {toInstant(value.replace(" ", "T").replace(/([+-]\d{2})$/u, "$1:00")); return true;} catch {return false;}
}

export const decodeObserverLockRow = decoder<LockRow>(object(["locked"], {locked: {type: "boolean", const: true}}));
export const decodeObserverPermitRow = decoder<PermitRow>(object(["lease_until"], {lease_until: {type: "string", minLength: 20, maxLength: 40}}), row => timestamp(row["lease_until"]));
export const decodeObserverBooleanRow = decoder<BooleanRow>(object(["valid"], {valid: {type: "boolean"}}));
export const decodeObserverRevisionRow = decoder<RevisionRow>(object(["revision"], {revision: positiveInt64}));
export const decodeObserverSequenceRow = decoder<SequenceRow>(object(["sequence"], {sequence: positiveInt64}));
export const decodeObserverClockRow = decoder<ClockRow>(object(["now"], {
  now: {type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"},
}));
