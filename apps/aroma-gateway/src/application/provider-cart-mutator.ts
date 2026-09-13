import type {AromaMutationResponse} from "@coffee-platform/contracts-aroma-v1";
import {ProviderError} from "../domain/provider-errors.js";
import type {DispatchPermit, NormalizedMutationRequest, UnsafeMutationResult} from "../domain/mutation-journal.js";
import type {OfferBindingStore, ResolvedProviderOffer} from "../infrastructure/database/offer-binding-store.js";
import type {ProviderCredentialScope, ProviderSessionManager} from "../infrastructure/provider/session.js";
import type {ProviderHttpClient} from "../infrastructure/provider/http-client.js";
import {decodeCartSnapshot} from "../infrastructure/provider/decoder.js";

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

export type ProviderCartMutatorOptions = Readonly<{
  sessions: ProviderSessionManager;
  credentials: ProviderCredentialScope;
  bindings: Pick<OfferBindingStore, "resolveProviderOffer">;
  supplierRef: string;
  transport?: Pick<ProviderHttpClient, "mutate">;
}>;

function problem(status: number, code: string): Uint8Array {
  return json({type: "about:blank", title: code, status, code, detail: "Provider cart line is missing", instance: "/api/internal-v1/aroma/cart-lines", correlationId: "00000000-0000-4000-8000-000000000000", errors: []});
}

type KnownProviderFacts = Readonly<{packing: string | null; grindId: string | null}>;

function knownProviderFacts(identity: ResolvedProviderOffer): KnownProviderFacts {
  if (!Object.hasOwn(identity, "packing") || identity.packing === undefined || !Object.hasOwn(identity, "grindId") || identity.grindId === undefined) {
    throw new ProviderError("ProviderCartMappingMissing");
  }
  return {packing: identity.packing, grindId: identity.grindId};
}

function exactLine(snapshot: ReturnType<typeof decodeCartSnapshot>, identity: ResolvedProviderOffer, facts: KnownProviderFacts): readonly [string, number] | undefined {
  const lines = snapshot.lines.filter(line => line.offerId === identity.rawProviderOfferId && line.packing === facts.packing && line.grindId === facts.grindId);
  if (lines.length > 1) throw new ProviderError("ProviderProtocolViolation");
  const line = lines[0];
  return line === undefined ? undefined : [line.cartLineId, line.quantity];
}

function assertMutationResponse(body: Uint8Array, request: NormalizedMutationRequest, identity: ResolvedProviderOffer, facts: KnownProviderFacts, quantity: number | undefined): void {
  const response = decodeCartSnapshot(body);
  const line = exactLine(response, identity, facts);
  const valid = request.operationKind === "RemoveLine"
    ? line === undefined
    : line !== undefined && line[1] === quantity;
  if (!valid) throw new ProviderError("ProviderProtocolViolation", true, 200);
}

function acknowledged(request: NormalizedMutationRequest): UnsafeMutationResult {
  const body: AromaMutationResponse = {operationRef: request.operationRef, cartScopeRef: "aroma-primary", offerRef: request.offerRef, state: "Acknowledged"};
  return {state: "Acknowledged", statusCode: 200, responseBodyBytes: json(body)};
}

/** Production-only bridge: one fresh GET, at most one provider mutation, no retry. */
export class ProviderCartMutator {
  readonly #sessions: ProviderSessionManager;
  readonly #credentials: ProviderCredentialScope;
  readonly #bindings: Pick<OfferBindingStore, "resolveProviderOffer">;
  readonly #supplierRef: string | undefined;
  readonly #transport: Pick<ProviderHttpClient, "mutate"> | undefined;
  public constructor(options: ProviderCartMutatorOptions) { this.#sessions = options.sessions; this.#credentials = options.credentials; this.#bindings = options.bindings; this.#supplierRef = options.supplierRef; this.#transport = options.transport; }

  public async execute(request: NormalizedMutationRequest, _permit: DispatchPermit, signal: AbortSignal): Promise<UnsafeMutationResult> {
    const identity = await this.#bindings.resolveProviderOffer(request.offerRef, this.#supplierRef ?? "", signal);
    if (identity === undefined || (this.#supplierRef !== undefined && identity.supplierRef !== this.#supplierRef)) throw new ProviderError("ProviderCartMappingMissing");
    const facts = knownProviderFacts(identity);
    const session = await this.#sessions.acquire(this.#credentials, signal);
    const body = await this.#collect(session.read({kind: "cart"}, signal), signal);
    const current = decodeCartSnapshot(body);
    const line = exactLine(current, identity, facts);

    if (request.operationKind === "RemoveLine" && line === undefined) return {state: "Rejected", statusCode: 404, failureCode: "AROMA_CART_ITEM_NOT_FOUND", responseBodyBytes: problem(404, "AROMA_CART_ITEM_NOT_FOUND")};
    const quantity = request.quantityMilli === null ? undefined : Number(request.quantityMilli);
    // Provider bounds beyond a positive integer are not proven. Do not encode the
    // observed test values (1/2) as a product maximum; the transport still
    // requires a lossless integer representation.
    if (quantity !== undefined && (!Number.isSafeInteger(quantity) || quantity < 1)) throw new ProviderError("ProviderProtocolViolation");
    const result = session.mutate !== undefined
      ? await session.mutate(
          request.operationKind === "RemoveLine"
            ? {kind: "remove-cart-line", cartLineId: line![0]}
            : line === undefined
              ? {kind: "add-cart-line", offerId: identity.rawProviderOfferId, quantity: quantity!, ...(facts.packing === null ? {} : {packing: facts.packing}), ...(facts.grindId === null ? {} : {grindId: facts.grindId})}
              : {kind: "set-cart-line-quantity", cartLineId: line[0], quantity: quantity!, ...(facts.packing === null ? {} : {packing: facts.packing}), ...(facts.grindId === null ? {} : {grindId: facts.grindId})},
          signal,
        )
      : await this.#transport!.mutate(
          request.operationKind === "RemoveLine"
            ? {kind: "remove-cart-line", cartLineId: line![0]}
            : line === undefined
              ? {kind: "add-cart-line", offerId: identity.rawProviderOfferId, quantity: quantity!, ...(facts.packing === null ? {} : {packing: facts.packing}), ...(facts.grindId === null ? {} : {grindId: facts.grindId})}
              : {kind: "set-cart-line-quantity", cartLineId: line[0], quantity: quantity!, ...(facts.packing === null ? {} : {packing: facts.packing}), ...(facts.grindId === null ? {} : {grindId: facts.grindId})},
          signal,
          undefined,
        );
    if (result.statusCode === 404) throw new ProviderError("ProviderProtocolViolation", result.body.byteLength > 0, result.statusCode);
    if (result.statusCode !== 200) throw new ProviderError("ProviderProtocolViolation", result.body.byteLength > 0, result.statusCode);
    let mutationResponseError: ProviderError | undefined;
    try {
      assertMutationResponse(result.body, request, identity, facts, quantity);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      mutationResponseError = error;
    }
    // Always take the required fresh read, but never let it override an invalid
    // mutation response and turn the same dispatched operation into an ack.
    const verificationBody = await this.#collect(session.read({kind: "cart"}, signal), signal);
    const after = decodeCartSnapshot(verificationBody);
    const afterLine = exactLine(after, identity, facts);
    if (mutationResponseError !== undefined) throw mutationResponseError;
    if (request.operationKind === "RemoveLine" ? afterLine !== undefined : afterLine === undefined || afterLine[1] !== quantity) throw new ProviderError("ProviderProtocolViolation", true, result.statusCode);
    return acknowledged(request);
  }

  async #collect(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []; let total = 0;
    try { for await (const chunk of source) { signal.throwIfAborted(); if (chunks.length > 256 || total + chunk.byteLength > 2 * 1024 * 1024) throw new ProviderError("ProviderResponseTooLarge", total > 0); chunks.push(chunk); total += chunk.byteLength; } }
    finally { const iterator = source as unknown as AsyncIterator<Uint8Array>; await iterator.return?.(); }
    if (total === 0) throw new ProviderError("ProviderDecodeIncomplete");
    const output = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; } return output;
  }
}
