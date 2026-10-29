import {
  isCatalogPricingInput,
  isCatalogProductRef,
  isCatalogVariantRef,
  type CatalogPricingInput,
} from "@coffee-platform/contracts-catalog-v1";

type HttpClient = Readonly<{
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
}>;
const MAX_CATALOG_BODY_BYTES = 64 * 1024;

export type CatalogPricingErrorCode =
  | "CATALOG_PRODUCT_NOT_FOUND"
  | "CATALOG_PRODUCT_UNAVAILABLE"
  | "CATALOG_UNAVAILABLE";

export class CatalogPricingError extends Error {
  public readonly code: CatalogPricingErrorCode;

  public constructor(code: CatalogPricingErrorCode) {
    super(code);
    this.name = "CatalogPricingError";
    this.code = code;
  }
}

export type CatalogPricingRequest = Readonly<{
  productRef: string;
  variantRef: string;
  delegation: string;
  correlationId: string;
  traceparent?: string;
  signal: AbortSignal;
}>;

export function createCatalogPricingClient(client: HttpClient): Readonly<{
  getPricingInput: (
    request: CatalogPricingRequest,
  ) => Promise<CatalogPricingInput>;
}> {
  return {
    async getPricingInput(request) {
      if (
        !isCatalogProductRef(request.productRef) ||
        !isCatalogVariantRef(request.variantRef)
      )
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      request.signal.throwIfAborted();
      const path = `/api/internal-v1/catalog/products/${encodeURIComponent(request.productRef)}/variants/${encodeURIComponent(request.variantRef)}/pricing-input`;
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(2_000),
      ]);
      let response: Response;
      try {
        response = await client.fetch(path, {
          method: "GET",
          headers: {
            "x-service-delegation": request.delegation,
            "x-correlation-id": request.correlationId,
            ...(request.traceparent === undefined
              ? {}
              : { traceparent: request.traceparent }),
          },
          signal,
        });
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      }
      if (response.status === 404) {
        await response.body?.cancel();
        throw new CatalogPricingError("CATALOG_PRODUCT_NOT_FOUND");
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      }
      if (response.body === null)
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener("abort", cancel, { once: true });
      let body: unknown;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_CATALOG_BODY_BYTES)
            throw new CatalogPricingError("CATALOG_UNAVAILABLE");
          chunks.push(chunk.value);
        }
        signal.throwIfAborted();
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      } finally {
        signal.removeEventListener("abort", cancel);
        try {
          await reader.cancel();
        } catch {
          /* response may already be aborted */
        }
        reader.releaseLock();
      }
      if (
        !isCatalogPricingInput(body) ||
        body.productRef !== request.productRef ||
        body.variantRef !== request.variantRef ||
        body.currency !== "RUB" ||
        !/^(0|[1-9][0-9]*)$/u.test(body.supplierUnitMinor) ||
        body.availability !== "Available"
      ) {
        if (isCatalogPricingInput(body) && body.availability !== "Available")
          throw new CatalogPricingError("CATALOG_PRODUCT_UNAVAILABLE");
        throw new CatalogPricingError("CATALOG_UNAVAILABLE");
      }
      return body;
    },
  };
}
