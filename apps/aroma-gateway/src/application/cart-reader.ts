import {createHash} from "node:crypto";
import type {AromaCartSnapshot} from "@coffee-platform/contracts-aroma-v1";
import {nowInstant} from "@coffee-platform/platform-time";
import {ProviderError} from "../domain/provider-errors.js";
import {decodeCartSnapshot} from "../infrastructure/provider/decoder.js";
import type {ProviderCredentialScope, ProviderSessionManager} from "../infrastructure/provider/session.js";

export type CartProviderIdentity = Readonly<{
  offerId: string;
  packing: string | null;
  grindId: string | null;
}>;

export type CartOfferBinding = Readonly<{
  offerRef: string;
  supplierRef?: string;
  /** A binding is usable for a cart line only when it proves this full identity. */
  providerIdentity?: CartProviderIdentity;
}>;

export interface CartOfferBindingResolver {
  resolveByRawProviderOfferId(rawProviderOfferId: string, supplierRef: string, signal?: AbortSignal): Promise<CartOfferBinding | undefined>;
  /** Optional full-identity lookup for mappings that can resolve variants directly. */
  resolveByProviderIdentity?: (identity: CartProviderIdentity, supplierRef: string, signal?: AbortSignal) => Promise<CartOfferBinding | undefined>;

}

export type ProviderCartReaderOptions = Readonly<{
  sessions: ProviderSessionManager;
  credentials: ProviderCredentialScope;
  bindings: CartOfferBindingResolver;
  supplierRef: string;
  now?: () => string;
}>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function collect(source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw new ProviderError("ProviderDecodeIncomplete", size > 0);
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  if (size === 0) throw new ProviderError("ProviderDecodeIncomplete");
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function canonicalLines(lines: readonly Readonly<{offerRef: string; quantity: string}>[]): Uint8Array {
  const ordered = [...lines].sort((left, right) => left.offerRef.localeCompare(right.offerRef));
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

function sameProviderIdentity(value: unknown, expected: CartProviderIdentity): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return identity["offerId"] === expected.offerId && identity["packing"] === expected.packing && identity["grindId"] === expected.grindId;
}

async function resolveCartBinding(
  resolver: CartOfferBindingResolver,
  identity: CartProviderIdentity,
  supplierRef: string | undefined,
  signal: AbortSignal,
): Promise<CartOfferBinding | undefined> {
  const binding = resolver.resolveByProviderIdentity === undefined
    ? await resolver.resolveByRawProviderOfferId(identity.offerId, supplierRef ?? "", signal)
    : await resolver.resolveByProviderIdentity(identity, supplierRef ?? "", signal);
  return binding !== undefined &&
    (supplierRef === undefined || binding.supplierRef === undefined || binding.supplierRef === supplierRef) &&
    sameProviderIdentity(binding.providerIdentity, identity) ? binding : undefined;
}

/**
 * Gateway-owned safe cart read. It never exposes provider IDs, prices, body
 * fields, cookies, or provider error text and never turns a failed read into an
 * empty observation.
 */
export class ProviderCartReader {
  readonly #sessions: ProviderSessionManager;
  readonly #credentials: ProviderCredentialScope;
  readonly #bindings: CartOfferBindingResolver;
  readonly #supplierRef: string | undefined;
  readonly #now: () => string;

  constructor(options: ProviderCartReaderOptions) {
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#bindings = options.bindings;
    this.#supplierRef = options.supplierRef;
    this.#now = options.now ?? (() => nowInstant().toString());
  }

  async read(signal: AbortSignal = new AbortController().signal): Promise<AromaCartSnapshot> {
    signal.throwIfAborted();
    const session = await this.#sessions.acquire(this.#credentials, signal);
    const body = await collect(session.read({kind: "cart"}, signal), signal);
    const decoded = decodeCartSnapshot(body);
    const lines: Array<Readonly<{offerRef: string; quantity: string}>> = [];
    const offerRefs = new Set<string>();
    for (const line of decoded.lines) {
      const identity: CartProviderIdentity = {offerId: line.offerId, packing: line.packing, grindId: line.grindId};
      const binding = await resolveCartBinding(this.#bindings, identity, this.#supplierRef, signal);
      if (binding === undefined) throw new ProviderError("ProviderCartMappingMissing");
      if (typeof binding.offerRef !== "string" || binding.offerRef.length === 0 || !binding.offerRef.isWellFormed() || binding.offerRef.includes("\u0000") || offerRefs.has(binding.offerRef)) {
        throw new ProviderError("ProviderCartMappingAmbiguous");
      }
      offerRefs.add(binding.offerRef);
      lines.push({offerRef: binding.offerRef, quantity: String(line.quantity)});
    }
    const providerSnapshotRef = `aroma-gateway:cart-body-sha256:${sha256(body)}`;
    return {
      cartScopeRef: "aroma-primary",
      providerSnapshotRef,
      capturedAt: this.#now(),
      cartFingerprint: sha256(canonicalLines(lines)),
      lines,
    };
  }
}
