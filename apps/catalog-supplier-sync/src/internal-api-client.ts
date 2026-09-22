import {Readable} from "node:stream";
import type {AromaCatalogExportRequest} from "@coffee-platform/contracts-aroma-v1";
import type {HttpClient} from "@coffee-platform/platform-http";
import {readNdjson} from "./ndjson-reader.js";

export type CatalogExportContext = Readonly<{correlationId: string; signal: AbortSignal; traceparent?: string}>;

export class InternalCatalogClient {
  readonly #http: HttpClient;
  public constructor(http: HttpClient) { this.#http = http; }

  public async *export(request: AromaCatalogExportRequest, context: CatalogExportContext): AsyncGenerator<unknown> {
    const headers: Record<string, string> = {
      accept: "application/x-ndjson",
      "content-type": "application/json",
      "x-correlation-id": context.correlationId,
    };
    if (context.traceparent !== undefined) headers["traceparent"] = context.traceparent;
    const response = await this.#http.fetch("/api/internal-v1/aroma/catalog-exports", {
      method: "POST", headers, body: JSON.stringify(request), signal: context.signal,
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      throw new Error(`CATALOG_EXPORT_HTTP_${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/x-ndjson") {
      await response.body.cancel();
      throw new Error("CATALOG_EXPORT_INVALID_CONTENT_TYPE");
    }
    const source = Readable.fromWeb(response.body);
    yield* readNdjson(source, {signal: context.signal});
  }
}
