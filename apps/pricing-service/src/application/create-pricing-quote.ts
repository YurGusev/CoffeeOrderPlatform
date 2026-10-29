import {
  isCatalogPricingInput,
  type CatalogPricingInput,
} from "@coffee-platform/contracts-catalog-v1";
import {
  isPricingQuoteCreateRequest,
  type PricingQuoteCreateRequest,
} from "@coffee-platform/contracts-pricing-v1";
import {
  canonicalRequestHash,
  type IdempotencyKey,
} from "@coffee-platform/idempotency";
import {
  parseQuantity,
  parseCanonicalMinor,
} from "../domain/pricing-formula.js";
import {
  CatalogPricingError,
  type CatalogPricingRequest,
} from "../infrastructure/catalog-client.js";
import {
  type PricingCreateResult,
  type PricingStore,
} from "../infrastructure/database/pricing-store.js";

export type CreatePricingQuoteCommand = Readonly<{
  request: PricingQuoteCreateRequest;
  identity: IdempotencyKey;
  correlationId: string;
  traceparent?: string;
  signal?: AbortSignal;
  signDelegation: () => string;
  onCatalogRetry?: (outcome: "no_retry" | "recovered" | "mixed") => void;
}>;
export type CatalogPricingClient = Readonly<{
  getPricingInput: (
    request: CatalogPricingRequest,
  ) => Promise<CatalogPricingInput>;
}>;

export class CreatePricingQuoteError extends Error {
  public readonly code:
    | "VALIDATION_FAILED"
    | "CATALOG_REVISION_CHANGED"
    | "PRICING_GRIND_NOT_AVAILABLE"
    | "IDEMPOTENCY_CONFLICT"
    | "IDEMPOTENCY_REQUEST_IN_PROGRESS";
  public constructor(code: CreatePricingQuoteError["code"]) {
    super(code);
    this.name = "CreatePricingQuoteError";
    this.code = code;
  }
}

function normalizedRequest(
  request: PricingQuoteCreateRequest,
): PricingQuoteCreateRequest {
  if (!isPricingQuoteCreateRequest(request))
    throw new CreatePricingQuoteError("VALIDATION_FAILED");
  const seen = new Set<string>();
  const lines = request.lines.map((line) => {
    const pair = `${line.productRef}/${line.variantRef}/${line.sourceGrindKeyHash ?? ""}`;
    if (seen.has(pair)) throw new CreatePricingQuoteError("VALIDATION_FAILED");
    seen.add(pair);
    try {
      return {
        productRef: line.productRef,
        variantRef: line.variantRef,
        quantity: parseQuantity(line.quantity).quantity,
        ...(line.sourceGrindKeyHash === undefined
          ? {}
          : { sourceGrindKeyHash: line.sourceGrindKeyHash }),
      };
    } catch {
      throw new CreatePricingQuoteError("VALIDATION_FAILED");
    }
  });
  return { customerRef: request.customerRef, lines };
}

function checkedFact(
  value: CatalogPricingInput,
  line: PricingQuoteCreateRequest["lines"][number],
): CatalogPricingInput {
  if (
    !isCatalogPricingInput(value) ||
    value.productRef !== line.productRef ||
    value.variantRef !== line.variantRef ||
    value.currency !== "RUB" ||
    value.availability !== "Available"
  ) {
    if (isCatalogPricingInput(value) && value.availability !== "Available")
      throw new CatalogPricingError("CATALOG_PRODUCT_UNAVAILABLE");
    throw new CatalogPricingError("CATALOG_UNAVAILABLE");
  }
  try {
    parseCanonicalMinor(value.supplierUnitMinor);
  } catch {
    throw new CatalogPricingError("CATALOG_UNAVAILABLE");
  }
  const options = value.grindOptions;
  if (
    options !== undefined &&
    new Set(options.map((option) => option.sourceGrindKeyHash)).size !==
      options.length
  )
    throw new CatalogPricingError("CATALOG_UNAVAILABLE");
  if (
    line.sourceGrindKeyHash !== undefined &&
    !options?.some(
      (option) => option.sourceGrindKeyHash === line.sourceGrindKeyHash,
    )
  )
    throw new CreatePricingQuoteError("PRICING_GRIND_NOT_AVAILABLE");
  return value;
}

async function fetchGroup(
  lines: PricingQuoteCreateRequest["lines"],
  catalog: CatalogPricingClient,
  command: CreatePricingQuoteCommand,
  signal: AbortSignal,
): Promise<CatalogPricingInput[]> {
  const group = new AbortController();
  const childSignal = AbortSignal.any([signal, group.signal]);
  const facts: CatalogPricingInput[] = [];
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      childSignal.throwIfAborted();
      const index = next++;
      const line = lines[index];
      if (line === undefined)
        throw new CreatePricingQuoteError("VALIDATION_FAILED");
      try {
        facts[index] = checkedFact(
          await catalog.getPricingInput({
            productRef: line.productRef,
            variantRef: line.variantRef,
            delegation: command.signDelegation(),
            correlationId: command.correlationId,
            ...(command.traceparent === undefined
              ? {}
              : { traceparent: command.traceparent }),
            signal: childSignal,
          }),
          line,
        );
      } catch (error) {
        group.abort(error);
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(8, lines.length) }, worker);
  try {
    await Promise.all(workers);
  } catch (error) {
    // Wait for every in-flight child to observe cancellation before completing this group.
    await Promise.allSettled(workers);
    if (command.signal?.aborted) throw command.signal.reason;
    if (signal.aborted) throw new CatalogPricingError("CATALOG_UNAVAILABLE");
    throw error;
  }
  return facts;
}

/** All remote reads finish before entering the owner's atomic create transaction. */
export async function createPricingQuote(
  store: Pick<PricingStore, "precheck" | "readActivePolicy" | "create">,
  catalog: CatalogPricingClient,
  command: CreatePricingQuoteCommand,
): Promise<PricingCreateResult> {
  const signal =
    command.signal === undefined
      ? AbortSignal.timeout(5_000)
      : AbortSignal.any([command.signal, AbortSignal.timeout(5_000)]);
  const request = normalizedRequest(command.request);
  const requestHash = canonicalRequestHash(request);
  signal.throwIfAborted();
  const precheck = await store.precheck(command.identity, requestHash, signal);
  signal.throwIfAborted();
  if (precheck.kind === "completed")
    return { status: 201, body: precheck.body, replayed: true };
  if (precheck.kind === "conflict")
    throw new CreatePricingQuoteError("IDEMPOTENCY_CONFLICT");
  if (precheck.kind === "in_progress")
    throw new CreatePricingQuoteError("IDEMPOTENCY_REQUEST_IN_PROGRESS");
  const policy = await store.readActivePolicy(signal);
  signal.throwIfAborted();
  let facts = await fetchGroup(request.lines, catalog, command, signal);
  if (
    facts.some((value) => value.snapshotRevision !== facts[0]?.snapshotRevision)
  ) {
    facts = await fetchGroup(request.lines, catalog, command, signal);
    if (
      facts.some(
        (value) => value.snapshotRevision !== facts[0]?.snapshotRevision,
      )
    ) {
      command.onCatalogRetry?.("mixed");
      throw new CreatePricingQuoteError("CATALOG_REVISION_CHANGED");
    }
    command.onCatalogRetry?.("recovered");
  } else command.onCatalogRetry?.("no_retry");
  signal.throwIfAborted();
  const first = facts[0];
  if (first === undefined)
    throw new CreatePricingQuoteError("VALIDATION_FAILED");
  return store.create({
    identity: command.identity,
    requestHash,
    correlationId: command.correlationId,
    policy,
    customerRef: request.customerRef,
    catalogSnapshotRevision: first.snapshotRevision,
    lines: request.lines.map((line, index) => {
      const fact = facts[index];
      if (fact === undefined)
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      return {
        productRef: line.productRef,
        variantRef: line.variantRef,
        quantity: line.quantity,
        productDisplayName: fact.displayName,
        unit: fact.unit,
        offerRef: fact.offerRef,
        mappingRevision: fact.mappingRevision,
        supplierUnitMinor: fact.supplierUnitMinor,
        catalogSnapshotRevision: fact.snapshotRevision,
        ...(line.sourceGrindKeyHash === undefined
          ? {}
          : {
              sourceGrindKeyHash: line.sourceGrindKeyHash,
              grindDisplayName:
                fact.grindOptions?.find(
                  (option) =>
                    option.sourceGrindKeyHash === line.sourceGrindKeyHash,
                )?.displayName ?? "",
            }),
      };
    }),
    signal,
  });
}
