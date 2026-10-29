import type { Readable } from "node:stream";
import { CATALOG_MAX_STREAM_LINE_BYTES } from "@coffee-platform/contracts-aroma-v1";

export class CatalogStreamError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(code);
    this.name = "CatalogStreamError";
    this.code = code;
  }
}

export type NdjsonReaderOptions = Readonly<{
  maxLineBytes?: number;
  signal?: AbortSignal;
}>;

export async function* readNdjson(
  source: Readable,
  options: NdjsonReaderOptions = {},
): AsyncGenerator<unknown> {
  const maxLineBytes = options.maxLineBytes ?? CATALOG_MAX_STREAM_LINE_BYTES;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)
    throw new RangeError("maxLineBytes must be positive");
  const signal = options.signal;
  const abort = (): void => {
    source.destroy(
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("aborted", "AbortError"),
    );
  };
  if (signal?.aborted === true) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  // One reusable bounded slab for fragmented lines; never copy an accumulated
  // prefix or retain a list of tiny fragment views. Complete lines are zero-copy.
  let slab: Buffer | undefined;
  let pendingBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const chunk of source) {
      signal?.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(0x0a, offset);
        const end = newline < 0 ? bytes.length : newline;
        const fragmentBytes = end - offset;
        // Check BEFORE any framing allocation/copy, including a huge final fragment.
        if (fragmentBytes > maxLineBytes - pendingBytes)
          throw new CatalogStreamError("CATALOG_STREAM_LINE_TOO_LARGE");
        let line: Uint8Array;
        if (pendingBytes !== 0 || newline < 0) {
          slab ??= Buffer.allocUnsafe(maxLineBytes);
          bytes.copy(slab, pendingBytes, offset, end);
          pendingBytes += fragmentBytes;
          line = slab.subarray(0, pendingBytes);
        } else line = bytes.subarray(offset, end);
        offset = end + 1;
        if (newline < 0) break;
        pendingBytes = 0;
        if (line.length === 0)
          throw new CatalogStreamError("CATALOG_STREAM_EMPTY_LINE");
        let text: string;
        try {
          text = decoder.decode(line);
        } catch {
          throw new CatalogStreamError("CATALOG_STREAM_INVALID_UTF8");
        }
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new CatalogStreamError("CATALOG_STREAM_INVALID_JSON");
        }
        yield value;
      }
    }
    signal?.throwIfAborted();
    if (pendingBytes !== 0)
      throw new CatalogStreamError("CATALOG_STREAM_INCOMPLETE");
  } finally {
    signal?.removeEventListener("abort", abort);
    source.destroy();
  }
}
