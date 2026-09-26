import {createHash} from "node:crypto";
import type {PricingQuoteResponse} from "@coffee-platform/contracts-pricing-v1";

type PublicQuote = Omit<PricingQuoteResponse, "hash">;

export type PricingProofLine = Readonly<{
  lineNumber: number;
  offerRef: string;
  mappingRevision: string;
  supplierUnitMinor: string;
  catalogSnapshotRevision: string;
  markupBasisPoints: string;
  minimumMarginMinor: string;
}>;

export type AppliedPricingPolicy = Readonly<{
  quoteTtlSeconds: number;
  quantityScale: number;
  roundingMode: "CEILING";
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function orderedPublicQuote(quote: PublicQuote) {
  return {
    quoteRef: quote.quoteRef,
    policyVersionRef: quote.policyVersionRef,
    catalogSnapshotRevision: quote.catalogSnapshotRevision,
    customerRef: quote.customerRef,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    currency: quote.currency,
    lines: [...quote.lines].sort((a, b) => a.lineNumber - b.lineNumber).map(line => ({
      lineNumber: line.lineNumber,
      productRef: line.productRef,
      variantRef: line.variantRef,
      productDisplayName: line.productDisplayName,
      quantity: line.quantity,
      unit: line.unit,
      unitMinor: line.unitMinor,
      lineTotalMinor: line.lineTotalMinor,
    })),
    totalMinor: quote.totalMinor,
  };
}

/** Hash only the persisted public facts, in the exact order of the Pricing specification. */
export function hashPublicQuote(quote: PublicQuote): string {
  return digest(orderedPublicQuote(quote));
}

/** The private proof commits to the public facts and every applied line/policy fact. */
export function hashInternalQuote(quote: PublicQuote, policy: AppliedPricingPolicy, proofLines: readonly PricingProofLine[]): string {
  const publicFacts = orderedPublicQuote(quote);
  const byNumber = new Map(proofLines.map(line => [line.lineNumber, line]));
  if (byNumber.size !== proofLines.length || byNumber.size !== publicFacts.lines.length) throw new TypeError("PRICING_PROOF_LINES_INVALID");
  return digest({
    ...publicFacts,
    lines: publicFacts.lines.map(line => {
      const proof = byNumber.get(line.lineNumber);
      if (proof === undefined) throw new TypeError("PRICING_PROOF_LINES_INVALID");
      return {
        ...line,
        offerRef: proof.offerRef,
        mappingRevision: proof.mappingRevision,
        supplierUnitMinor: proof.supplierUnitMinor,
        catalogSnapshotRevision: proof.catalogSnapshotRevision,
        markupBasisPoints: proof.markupBasisPoints,
        minimumMarginMinor: proof.minimumMarginMinor,
      };
    }),
    quoteTtlSeconds: policy.quoteTtlSeconds,
    quantityScale: policy.quantityScale,
    roundingMode: policy.roundingMode,
  });
}
