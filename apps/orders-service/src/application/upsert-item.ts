import { isPricingQuoteVerificationResponse } from "@coffee-platform/contracts-pricing-v1";
import type {
  OrderStore,
  OrderCommandResult,
  OrderPutPreflightResult,
} from "../infrastructure/database/order-store.js";
import { hashOrderItemPutRequest } from "../infrastructure/database/order-store.js";
import { observe } from "../telemetry/index.js";
import {
  failure,
  lookupReplay,
  type CommandContext,
  type CommandOutcome,
} from "./create-draft.js";

type Pricing = Readonly<{
  verify: (
    request: Readonly<{
      quoteRef: string;
      hash: string;
      customerRef: string;
      quoteLineNumber: number;
      productRef: string;
      variantRef: string;
      quantity: string;
      sourceGrindKeyHash?: string;
      delegation: string;
      correlationId: string;
      traceparent?: string;
      signal: AbortSignal;
    }>,
  ) => Promise<
    import("@coffee-platform/contracts-pricing-v1").PricingQuoteVerificationResponse
  >;
}>;
type Sign = (
  request: Readonly<{
    operationId: "getCustomerOrderInput" | "verifyPricingQuote";
    correlationId: string;
    traceparent?: string;
    deadlineUtc: string | null;
  }>,
) => string;
type Input = CommandContext &
  Readonly<{
    orderRef: string;
    itemRef: string;
    request: Parameters<OrderStore["putItem"]>[0]["request"] | undefined;
  }>;
export async function upsertItem(
  deps: Readonly<{
    store: Pick<OrderStore, "replay" | "preflightPut" | "putItem">;
    pricing: Pricing;
    signInternalDelegation: Sign;
  }>,
  input: Input,
): Promise<CommandOutcome<OrderCommandResult>> {
  return observe(
    "orders.use_case.put",
    async () => {
      if (input.replayOnly) return lookupReplay(deps.store, input);
      const itemRequest = input.request;
      if (itemRequest === undefined) throw failure("VALIDATION_FAILED");
      let hash: string;
      try {
        hash = hashOrderItemPutRequest(itemRequest);
      } catch {
        throw failure("VALIDATION_FAILED");
      }
      const checked: OrderPutPreflightResult = await deps.store.preflightPut(
        input.identity,
        hash,
        input.orderRef,
        input.permissions,
        input.correlationId,
        input.signal,
      );
      if (checked.kind === "lookup_unavailable")
        throw failure("IDEMPOTENCY_LOOKUP_UNAVAILABLE");
      if (checked.kind !== "proceed") return checked;
      const customerRef = checked.customerRef;
      const pricing = await deps.pricing.verify({
        quoteRef: itemRequest.quoteRef,
        hash: itemRequest.quoteHash,
        customerRef,
        quoteLineNumber: itemRequest.quoteLineNumber,
        productRef: itemRequest.productRef,
        variantRef: itemRequest.variantRef,
        quantity: itemRequest.quantity,
        ...(itemRequest.sourceGrindKeyHash === undefined
          ? {}
          : { sourceGrindKeyHash: itemRequest.sourceGrindKeyHash }),
        delegation: deps.signInternalDelegation({
          operationId: "verifyPricingQuote",
          correlationId: input.correlationId,
          ...(input.traceparent === undefined
            ? {}
            : { traceparent: input.traceparent }),
          deadlineUtc: input.deadlineUtc,
        }),
        correlationId: input.correlationId,
        ...(input.traceparent === undefined
          ? {}
          : { traceparent: input.traceparent }),
        signal: input.signal,
      });
      if (
        !isPricingQuoteVerificationResponse(pricing) ||
        pricing.customerRef !== customerRef ||
        pricing.quoteRef !== itemRequest.quoteRef
      )
        throw failure("PRICING_UNAVAILABLE");
      const line = pricing.line;
      if (
        line.lineNumber !== itemRequest.quoteLineNumber ||
        line.productRef !== itemRequest.productRef ||
        line.variantRef !== itemRequest.variantRef ||
        line.quantity !== itemRequest.quantity ||
        line.sourceGrindKeyHash !== itemRequest.sourceGrindKeyHash
      )
        throw failure("ORDER_QUOTE_SCOPE_MISMATCH");
      const item = {
        productRef: line.productRef,
        variantRef: line.variantRef,
        productDisplayName: line.productDisplayName,
        unit: line.unit,
        quantityMilli: (
          BigInt(itemRequest.quantity.split(".")[0] ?? "0") * 1000n +
          BigInt(
            ((itemRequest.quantity.split(".")[1] ?? "") + "000").slice(0, 3),
          )
        ).toString(),
        quoteRef: pricing.quoteRef,
        quoteLineNumber: line.lineNumber,
        quoteHash: itemRequest.quoteHash,
        internalProofHash: line.internalProofHash,
        quoteExpiresAt: pricing.expiresAt,
        policyVersionRef: pricing.policyVersionRef,
        catalogSnapshotRevision: pricing.catalogSnapshotRevision,
        mappingRevision: line.mappingRevision,
        offerRef: line.offerRef,
        ...(line.sourceGrindKeyHash === undefined
          ? {}
          : {
              sourceGrindKeyHash: line.sourceGrindKeyHash,
              grindDisplayName: line.grindDisplayName,
            }),
        unitMinor: line.unitMinor,
        lineTotalMinor: line.lineTotalMinor,
        currency: "RUB" as const,
      };
      return deps.store.putItem({
        actorRef: input.actorRef,
        identity: input.identity,
        correlationId: input.correlationId,
        signal: input.signal,
        cardPermissions: input.permissions,
        orderRef: input.orderRef,
        itemRef: input.itemRef,
        expectedVersion: itemRequest.expectedVersion,
        request: itemRequest,
        item,
      });
    },
    input.signal,
  );
}
