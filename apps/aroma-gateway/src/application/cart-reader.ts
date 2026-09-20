import {createHash} from "node:crypto";
import type {AromaCartSnapshot} from "@coffee-platform/contracts-aroma-v1";
import {nowInstant} from "@coffee-platform/platform-time";
import {ProviderError} from "../domain/provider-errors.js";
import {decodeCartSnapshot} from "../infrastructure/provider/decoder.js";
import {readProviderSafely, type ProviderCredentialScope, type ProviderSessionManager} from "../infrastructure/provider/session.js";
import {readProviderGrinds} from "./provider-grinds.js";
import type {SourceIdentityKey} from "../domain/source-identity.js";

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
  /** One bounded lookup for a complete provider cart, preserving request order. */
  resolveByProviderIdentities?: (identities: readonly CartProviderIdentity[], supplierRef: string, signal?: AbortSignal) => Promise<readonly (CartOfferBinding | undefined)[]>;

}

export type ProviderCartReaderOptions = Readonly<{
  sessions: ProviderSessionManager;
  credentials: ProviderCredentialScope;
  bindings: CartOfferBindingResolver;
  supplierRef: string;
  defaultPacking: string;
  sourceIdentityKey?: SourceIdentityKey;
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

function canonicalLines(lines: readonly Readonly<{offerRef: string; quantity: string; sourceGrindKeyHash?: string}>[]): Uint8Array {
  const ordered = [...lines].sort((left, right) => {
    const offerOrder = left.offerRef.localeCompare(right.offerRef);
    return offerOrder !== 0 ? offerOrder : (left.sourceGrindKeyHash ?? "").localeCompare(right.sourceGrindKeyHash ?? "");
  });
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

async function resolveCartBinding(
  resolver: CartOfferBindingResolver,
  identity: CartProviderIdentity,
  supplierRef: string | undefined,
  signal: AbortSignal,
): Promise<CartOfferBinding | undefined> {
  const binding = await resolver.resolveByRawProviderOfferId(identity.offerId, supplierRef ?? "", signal);
  return binding !== undefined &&
    (supplierRef === undefined || binding.supplierRef === undefined || binding.supplierRef === supplierRef) &&
    (binding.providerIdentity === undefined || binding.providerIdentity.offerId === identity.offerId) ? binding : undefined;
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
  readonly #supplierRef: string;
  readonly #defaultPacking: string;
  readonly #sourceIdentityKey: SourceIdentityKey | undefined;
  readonly #now: () => string;

  constructor(options: ProviderCartReaderOptions) {
    this.#sessions = options.sessions;
    this.#credentials = options.credentials;
    this.#bindings = options.bindings;
    this.#supplierRef = options.supplierRef;
    this.#defaultPacking = options.defaultPacking;
    this.#sourceIdentityKey = options.sourceIdentityKey;
    this.#now = options.now ?? (() => nowInstant().toString());
  }

  async read(signal: AbortSignal = new AbortController().signal): Promise<AromaCartSnapshot> {
    signal.throwIfAborted();
    const body = await collect(readProviderSafely(this.#sessions, this.#credentials, {kind: "cart"}, signal), signal);
    // Freshness is the provider observation boundary. Local decoding and DB work
    // must not move capturedAt forward and make an old provider body look fresh.
    const capturedAt = this.#now();
    const decoded = decodeCartSnapshot(body);
    const identities = decoded.lines.map((line): CartProviderIdentity => ({offerId: line.offerId, packing: line.packing, grindId: line.grindId}));
    const grindOptions = decoded.lines.some((line) => line.grindId !== null)
      ? this.#sourceIdentityKey === undefined
        ? (() => { throw new ProviderError("ProviderCartMappingMissing"); })()
        : await readProviderGrinds(this.#sessions, this.#credentials, this.#supplierRef, this.#sourceIdentityKey, signal)
      : [];
    const grindHashesByRawId = new Map(grindOptions.map((option) => [option.rawId, option.sourceGrindKeyHash]));
    let bindings: readonly (CartOfferBinding | undefined)[];
    if (identities.length === 0) {
      bindings = [];
    } else {
      const resolved: Array<CartOfferBinding | undefined> = [];
      for (const identity of identities) resolved.push(await resolveCartBinding(this.#bindings, identity, this.#supplierRef, signal));
      bindings = resolved;
    }
    const lines: Array<Readonly<{offerRef: string; quantity: string; sourceGrindKeyHash?: string}>> = [];
    const offerRefs = new Set<string>();
    for (const [index, line] of decoded.lines.entries()) {
      const binding = bindings[index];
      if (line.packing !== this.#defaultPacking || binding === undefined || (binding.supplierRef !== undefined && binding.supplierRef !== this.#supplierRef)) {
        throw new ProviderError("ProviderCartMappingMissing");
      }
      let sourceGrindKeyHash: string | undefined;
      if (line.grindId !== null) {
        sourceGrindKeyHash = grindHashesByRawId.get(line.grindId);
        if (sourceGrindKeyHash === undefined) throw new ProviderError("ProviderCartMappingMissing");
      }
      const lineKey = binding.offerRef + "\u0000" + (sourceGrindKeyHash ?? "");
      if (typeof binding.offerRef !== "string" || binding.offerRef.length === 0 || !binding.offerRef.isWellFormed() || binding.offerRef.includes("\u0000") || offerRefs.has(lineKey)) {
        throw new ProviderError("ProviderCartMappingAmbiguous");
      }
      offerRefs.add(lineKey);
      lines.push({offerRef: binding.offerRef, quantity: String(line.quantity), ...(sourceGrindKeyHash === undefined ? {} : {sourceGrindKeyHash})});
    }
    const providerSnapshotRef = `aroma-gateway:cart-body-sha256:${sha256(body)}`;
    return {
      cartScopeRef: "aroma-primary",
      providerSnapshotRef,
      capturedAt,
      cartFingerprint: sha256(canonicalLines(lines)),
      lines,
    };
  }
}
