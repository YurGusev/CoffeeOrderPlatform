import type { AromaCartSnapshot } from "@coffee-platform/generated-internal-v1";

export type NormalizedAromaCartLine = Readonly<{
  offerRef: string;
  sourceGrindKeyHash?: string;
  quantityMilli: string;
  sanitizedLineHash: string;
}>;
export type NormalizedAromaCartSnapshot = Readonly<{
  snapshot: AromaCartSnapshot;
  lines: readonly NormalizedAromaCartLine[];
}>;
export class AromaCartNormalizationError extends Error {
  public constructor() {
    super("AROMA_OBSERVATION_INVALID");
    this.name = "AromaCartNormalizationError";
  }
}
