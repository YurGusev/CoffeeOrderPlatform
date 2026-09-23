import {createHash} from "node:crypto";

export type SourceIdentity = Readonly<{
  entityType: "product" | "variant" | "offer";
  sourceHash: string;
  parentHash?: string;
  unit?: string;
}>;

/** Identity is scoped by supplier + scheme + type + sourceHash in SQL; mutable
 * Catalog facts intentionally do not enter the collision fingerprint. */
export function semanticFingerprint(identity: SourceIdentity): string {
  const {entityType, parentHash, unit} = identity;
  let facts: Readonly<Record<string, string>>;
  if (entityType === "product") facts = {entityType};
  else if (entityType === "variant" && parentHash !== undefined && unit !== undefined) {
    facts = {entityType, parentHash, unit};
  } else if (entityType === "offer" && parentHash !== undefined) {
    facts = {entityType, parentHash};
  } else throw new Error("SOURCE_IDENTITY_COLLISION");
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}
