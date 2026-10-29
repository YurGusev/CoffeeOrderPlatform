import {
  createSourceIdentity,
  type SourceIdentityKey,
} from "../domain/source-identity.js";
import { ProviderError } from "../domain/provider-errors.js";
import {
  readProviderSafely,
  type ProviderCredentialScope,
  type ProviderSessionManager,
} from "../infrastructure/provider/session.js";

export type ProviderGrindOption = Readonly<{
  rawId: string;
  sourceGrindKeyHash: string;
  displayName: string;
}>;

const MAX_GRINDS = 100;
const ID = /^[0-9]+$/u;

function invalid(): never {
  throw new ProviderError("ProviderDecodeInvalid");
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}
function providerId(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return String(value);
  if (typeof value === "string" && ID.test(value) && value !== "0")
    return value;
  return invalid();
}
function displayName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !value.isWellFormed() ||
    value.includes("\u0000")
  )
    return invalid();
  return value;
}

export function decodeProviderGrinds(
  body: unknown,
): readonly Readonly<{ rawId: string; displayName: string }>[] {
  const root = Array.isArray(body) ? body : record(body)["data"];
  if (!Array.isArray(root) || root.length === 0 || root.length > MAX_GRINDS)
    return invalid();
  const seen = new Set<string>();
  return root.map((entry) => {
    const value = record(entry);
    const rawId = providerId(value["id"]);
    const name = displayName(value["name"]);
    if (seen.has(rawId)) return invalid();
    seen.add(rawId);
    return { rawId, displayName: name };
  });
}

async function collect(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    signal.throwIfAborted();
    if (
      !(chunk instanceof Uint8Array) ||
      chunk.byteLength === 0 ||
      (size += chunk.byteLength) > 256 * 1024
    )
      throw new ProviderError("ProviderResponseTooLarge", size > 0);
    chunks.push(chunk);
  }
  if (size === 0) throw new ProviderError("ProviderReadIncomplete");
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readProviderGrinds(
  sessions: ProviderSessionManager,
  credentials: ProviderCredentialScope,
  supplierRef: string,
  sourceIdentityKey: SourceIdentityKey,
  signal: AbortSignal,
): Promise<readonly ProviderGrindOption[]> {
  const body = await collect(
    readProviderSafely(sessions, credentials, { kind: "grinds" }, signal),
    signal,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    throw new ProviderError("ProviderDecodeInvalid");
  }
  return decodeProviderGrinds(decoded).map((grind) => ({
    rawId: grind.rawId,
    sourceGrindKeyHash: createSourceIdentity({
      supplierRef,
      entityType: "grind",
      rawProviderIdentifier: grind.rawId,
      sourceIdentityKey,
    }).sourceIdentityHash,
    displayName: grind.displayName,
  }));
}
