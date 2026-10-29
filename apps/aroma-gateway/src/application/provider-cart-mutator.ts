import type { AromaMutationResponse } from "@coffee-platform/contracts-aroma-v1";
import { ProviderError } from "../domain/provider-errors.js";
import {
  PROVIDER_MUTATION_PREPARER,
  type DispatchPermit,
  type NormalizedMutationRequest,
  type PreparedProviderUnsafeMutator,
  type UnsafeMutationResult,
} from "../domain/mutation-journal.js";
import type {
  OfferBindingStore,
  ResolvedProviderOffer,
} from "../infrastructure/database/offer-binding-store.js";
import {
  readProviderSafely,
  type ProviderCredentialScope,
  type ProviderSessionManager,
} from "../infrastructure/provider/session.js";
import type { ProviderHttpClient } from "../infrastructure/provider/http-client.js";
import { decodeCartSnapshot } from "../infrastructure/provider/decoder.js";
import type { SourceIdentityKey } from "../domain/source-identity.js";
import { readProviderGrinds } from "./provider-grinds.js";

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

export type ProviderCartMutatorOptions = Readonly<{
  sessions: ProviderSessionManager;
  credentials: ProviderCredentialScope;
  bindings: Pick<OfferBindingStore, "resolveProviderOffer">;
  supplierRef: string;
  sourceIdentityKey?: SourceIdentityKey;
  defaultPacking: string;
  transport?: Pick<ProviderHttpClient, "mutate">;
}>;

function problem(status: number, code: string): Uint8Array {
  return json({
    type: "about:blank",
    title: code,
    status,
    code,
    detail: "Provider cart line is missing",
    instance: "/api/internal-v1/aroma/cart-lines",
    correlationId: "00000000-0000-4000-8000-000000000000",
    errors: [],
  });
}

type KnownProviderFacts = Readonly<{ packing: string; grindId: string | null }>;
type ProviderSession = Awaited<ReturnType<ProviderSessionManager["acquire"]>>;
type PreparedMutation = Readonly<{
  session: ProviderSession;
  identity: ResolvedProviderOffer;
  facts: KnownProviderFacts;
  line: readonly [string, number] | undefined;
  quantity: number | undefined;
}>;

class PreparationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "PreparationError";
    this.code = code;
  }
}

function knownProviderFacts(defaultPacking: string): KnownProviderFacts {
  if (defaultPacking.length === 0 || !defaultPacking.isWellFormed())
    throw new ProviderError("ProviderCartMappingMissing");
  return { packing: defaultPacking, grindId: null };
}

function exactLine(
  snapshot: ReturnType<typeof decodeCartSnapshot>,
  identity: ResolvedProviderOffer,
  facts: KnownProviderFacts,
): readonly [string, number] | undefined {
  const lines = snapshot.lines.filter(
    (line) =>
      line.offerId === identity.rawProviderOfferId &&
      line.packing === facts.packing &&
      line.grindId === facts.grindId,
  );
  if (lines.length > 1) throw new ProviderError("ProviderProtocolViolation");
  const line = lines[0];
  return line === undefined ? undefined : [line.cartLineId, line.quantity];
}

function assertMutationResponse(
  body: Uint8Array,
  request: NormalizedMutationRequest,
  identity: ResolvedProviderOffer,
  facts: KnownProviderFacts,
  quantity: number | undefined,
): void {
  const response = decodeCartSnapshot(body);
  const line = exactLine(response, identity, facts);
  const valid =
    request.operationKind === "RemoveLine"
      ? line === undefined
      : line !== undefined && line[1] === quantity;
  if (!valid) throw new ProviderError("ProviderProtocolViolation", true, 200);
}

function acknowledged(
  request: NormalizedMutationRequest,
): UnsafeMutationResult {
  const body = {
    operationRef: request.operationRef,
    cartScopeRef: "aroma-primary",
    offerRef: request.offerRef,
    state: "Acknowledged",
    ...(request.sourceGrindKeyHash === undefined
      ? {}
      : { sourceGrindKeyHash: request.sourceGrindKeyHash }),
  } as AromaMutationResponse;
  return {
    state: "Acknowledged",
    statusCode: 200,
    responseBodyBytes: json(body),
  };
}

/** Production-only bridge: one fresh GET, at most one provider mutation, no retry. */
export class ProviderCartMutator {
  readonly #sessions: ProviderSessionManager;
  readonly #credentials: ProviderCredentialScope;
  readonly #bindings: Pick<OfferBindingStore, "resolveProviderOffer">;
  readonly #supplierRef: string | undefined;
  readonly #sourceIdentityKey: SourceIdentityKey | undefined;
  readonly #defaultPacking: string;
  readonly #transport: Pick<ProviderHttpClient, "mutate"> | undefined;
  public constructor(options: ProviderCartMutatorOptions) {
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#bindings = options.bindings;
    this.#supplierRef = options.supplierRef;
    this.#sourceIdentityKey = options.sourceIdentityKey;
    this.#defaultPacking = options.defaultPacking;
    this.#transport = options.transport;
  }

  /** Safe provider preparation: identity, session and the preflight cart GET only. */
  public async prepare(
    request: NormalizedMutationRequest,
    signal: AbortSignal,
  ): Promise<PreparedMutation> {
    const identity = await this.#bindings.resolveProviderOffer(
      request.offerRef,
      this.#supplierRef ?? "",
      signal,
    );
    if (
      identity === undefined ||
      (this.#supplierRef !== undefined &&
        identity.supplierRef !== this.#supplierRef)
    )
      throw new ProviderError("ProviderCartMappingMissing");
    const bindingFacts = knownProviderFacts(this.#defaultPacking);
    let grindId = bindingFacts.grindId;
    if (request.sourceGrindKeyHash !== undefined) {
      if (
        this.#sourceIdentityKey === undefined ||
        this.#supplierRef === undefined
      )
        throw new ProviderError("ProviderCartMappingMissing");
      const matches = (
        await readProviderGrinds(
          this.#sessions,
          this.#credentials,
          this.#supplierRef,
          this.#sourceIdentityKey,
          signal,
        )
      ).filter(
        (grind) => grind.sourceGrindKeyHash === request.sourceGrindKeyHash,
      );
      if (matches.length !== 1)
        throw new ProviderError("ProviderCartMappingMissing");
      grindId = matches[0]!.rawId;
    }
    const facts: KnownProviderFacts = {
      packing: bindingFacts.packing,
      grindId,
    };
    const safeRead = (
      this.#sessions as ProviderSessionManager & {
        readSafe?: ProviderSessionManager["readSafe"];
      }
    ).readSafe;
    let session: ProviderSession;
    let body: Uint8Array;
    if (typeof safeRead === "function") {
      body = await this.#collect(
        readProviderSafely(
          this.#sessions,
          this.#credentials,
          { kind: "cart" },
          signal,
        ),
        signal,
      );
      session = await this.#sessions.acquire(this.#credentials, signal);
    } else {
      session = await this.#sessions.acquire(this.#credentials, signal);
      body = await this.#collect(
        session.read({ kind: "cart" }, signal),
        signal,
      );
    }
    const current = decodeCartSnapshot(body);
    const line = exactLine(current, identity, facts);
    const quantity =
      request.quantityMilli === null
        ? undefined
        : Number(request.quantityMilli);
    // Provider bounds beyond a positive integer are not proven. Do not encode the
    // observed test values (1/2) as a product maximum; the transport still
    // requires a lossless integer representation.
    if (
      quantity !== undefined &&
      (!Number.isSafeInteger(quantity) || quantity < 1)
    )
      throw new ProviderError("ProviderProtocolViolation");
    if (request.operationKind === "RemoveLine" && line === undefined)
      throw new PreparationError("ProviderCartItemNotFound");
    return { session, identity, facts, line, quantity };
  }

  /**
   * The getter carries the safe-preparation handoff through the existing
   * `mutator.execute.bind(mutator)` composition without changing main.ts.
   */
  public get execute(): PreparedProviderUnsafeMutator {
    const execute = ((
      request: NormalizedMutationRequest,
      permit: DispatchPermit,
      signal: AbortSignal,
      preparation?: unknown,
    ) =>
      this.#execute(
        request,
        permit,
        signal,
        preparation,
      )) as PreparedProviderUnsafeMutator;
    Object.defineProperty(execute, PROVIDER_MUTATION_PREPARER, {
      value: this.prepare.bind(this),
    });
    const nativeBind = Reflect.get(Function.prototype, "bind") as (
      thisArg: unknown,
      ...args: unknown[]
    ) => PreparedProviderUnsafeMutator;
    Object.defineProperty(execute, "bind", {
      value: (thisArg: unknown, ...boundArguments: unknown[]) => {
        const bound = Reflect.apply(nativeBind, execute, [
          thisArg,
          ...boundArguments,
        ]) as PreparedProviderUnsafeMutator;
        Object.defineProperty(bound, PROVIDER_MUTATION_PREPARER, {
          value: this.prepare.bind(this),
        });
        return bound;
      },
    });
    return execute;
  }

  async #execute(
    request: NormalizedMutationRequest,
    _permit: DispatchPermit,
    signal: AbortSignal,
    preparation?: unknown,
  ): Promise<UnsafeMutationResult> {
    let prepared: PreparedMutation;
    try {
      prepared =
        preparation === undefined
          ? await this.prepare(request, signal)
          : (preparation as PreparedMutation);
    } catch (error) {
      if (
        error instanceof PreparationError &&
        error.code === "ProviderCartItemNotFound"
      )
        return {
          state: "Rejected",
          statusCode: 404,
          failureCode: "AROMA_CART_ITEM_NOT_FOUND",
          responseBodyBytes: problem(404, "AROMA_CART_ITEM_NOT_FOUND"),
        };
      throw error;
    }
    const { session, identity, facts, line, quantity } = prepared;
    const result =
      session.mutate !== undefined
        ? await session.mutate(
            request.operationKind === "RemoveLine"
              ? { kind: "remove-cart-line", cartLineId: line![0] }
              : line === undefined
                ? {
                    kind: "add-cart-line",
                    offerId: identity.rawProviderOfferId,
                    quantity: quantity!,
                    packing: facts.packing,
                    ...(facts.grindId === null
                      ? {}
                      : { grindId: facts.grindId }),
                  }
                : {
                    kind: "set-cart-line-quantity",
                    cartLineId: line[0],
                    quantity: quantity!,
                    packing: facts.packing,
                    ...(facts.grindId === null
                      ? {}
                      : { grindId: facts.grindId }),
                  },
            signal,
          )
        : await this.#transport!.mutate(
            request.operationKind === "RemoveLine"
              ? { kind: "remove-cart-line", cartLineId: line![0] }
              : line === undefined
                ? {
                    kind: "add-cart-line",
                    offerId: identity.rawProviderOfferId,
                    quantity: quantity!,
                    packing: facts.packing,
                    ...(facts.grindId === null
                      ? {}
                      : { grindId: facts.grindId }),
                  }
                : {
                    kind: "set-cart-line-quantity",
                    cartLineId: line[0],
                    quantity: quantity!,
                    packing: facts.packing,
                    ...(facts.grindId === null
                      ? {}
                      : { grindId: facts.grindId }),
                  },
            signal,
            undefined,
          );
    if (result.statusCode === 404)
      throw new ProviderError(
        "ProviderProtocolViolation",
        result.body.byteLength > 0,
        result.statusCode,
      );
    if (result.statusCode !== 200)
      throw new ProviderError(
        "ProviderProtocolViolation",
        result.body.byteLength > 0,
        result.statusCode,
      );
    let mutationResponseError: ProviderError | undefined;
    try {
      assertMutationResponse(result.body, request, identity, facts, quantity);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      mutationResponseError = error;
    }
    // Always take the required fresh read, but never let it override an invalid
    // mutation response and turn the same dispatched operation into an ack.
    const verificationBody = await this.#collect(
      session.read({ kind: "cart" }, signal),
      signal,
    );
    const after = decodeCartSnapshot(verificationBody);
    const afterLine = exactLine(after, identity, facts);
    if (mutationResponseError !== undefined) throw mutationResponseError;
    if (
      request.operationKind === "RemoveLine"
        ? afterLine !== undefined
        : afterLine === undefined || afterLine[1] !== quantity
    )
      throw new ProviderError(
        "ProviderProtocolViolation",
        true,
        result.statusCode,
      );
    return acknowledged(request);
  }

  async #collect(
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of source) {
        signal.throwIfAborted();
        if (chunks.length > 256 || total + chunk.byteLength > 2 * 1024 * 1024)
          throw new ProviderError("ProviderResponseTooLarge", total > 0);
        chunks.push(chunk);
        total += chunk.byteLength;
      }
    } finally {
      const iterator = source as unknown as AsyncIterator<Uint8Array>;
      await iterator.return?.();
    }
    if (total === 0) throw new ProviderError("ProviderDecodeIncomplete");
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}
