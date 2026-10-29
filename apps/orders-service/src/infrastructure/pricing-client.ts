import {
  isPricingProblem,
  isPricingQuoteVerificationResponse,
  isPricingQuoteVerifyRequest,
  type PricingQuoteVerificationResponse,
} from "@coffee-platform/contracts-pricing-v1";
import { observe } from "../observability.js";

type HttpClient = Readonly<{
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
}>;
type PricingQuoteClientRequest = Readonly<{
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
}>;
export type PricingQuoteClientErrorCode =
  "PRICING_STALE" | "PRICING_SCOPE_MISMATCH" | "PRICING_UNAVAILABLE";

export class PricingQuoteClientError extends Error {
  public readonly code: PricingQuoteClientErrorCode;

  public constructor(code: PricingQuoteClientErrorCode) {
    super(code);
    this.name = "PricingQuoteClientError";
    this.code = code;
  }
}

const MAX_BODY_BYTES = 256 * 1024;
const DEADLINE_MS = 1_000;
const PRICING_ERROR_STATUS: Readonly<Record<string, number>> = {
  VALIDATION_FAILED: 400,
  SERVICE_AUTHENTICATION_REQUIRED: 401,
  SERVICE_DELEGATION_INVALID: 403,
  PRICING_QUOTE_NOT_FOUND: 404,
  PRICING_QUOTE_HASH_MISMATCH: 409,
  PRICING_QUOTE_EXPIRED: 409,
  PRICING_QUOTE_SCOPE_MISMATCH: 409,
  PRICING_POLICY_UNAVAILABLE: 503,
};

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function mediaType(response: Response): string | undefined {
  return response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) throw new Error("empty response body");
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    await response.body.cancel();
    throw new Error("invalid response length");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("response body exceeds limit");
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await reader.cancel();
    } catch {
      /* response may already be consumed or aborted */
    }
    reader.releaseLock();
  }
}

function unavailableUnlessCallerCancelled(
  error: unknown,
  request: PricingQuoteClientRequest,
): never {
  if (request.signal.aborted) throw request.signal.reason ?? error;
  throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
}

function exactScope(
  response: PricingQuoteVerificationResponse,
  request: PricingQuoteClientRequest,
): boolean {
  const temporal = (
    globalThis as {
      Temporal?: {
        Instant: { from: (value: string) => { epochMilliseconds: number } };
        Now: { instant: () => { epochMilliseconds: number } };
      };
    }
  ).Temporal;
  if (temporal === undefined) return false;
  let fresh = false;
  try {
    fresh =
      temporal.Instant.from(response.expiresAt).epochMilliseconds >
      temporal.Now.instant().epochMilliseconds;
  } catch {
    return false;
  }
  return (
    response.quoteRef === request.quoteRef &&
    response.customerRef === request.customerRef &&
    response.currency === "RUB" &&
    response.line.lineNumber === request.quoteLineNumber &&
    response.line.productRef === request.productRef &&
    response.line.variantRef === request.variantRef &&
    response.line.quantity === request.quantity &&
    response.line.currency === "RUB" &&
    response.line.sourceGrindKeyHash === request.sourceGrindKeyHash &&
    fresh
  );
}

export function createPricingQuoteClient(client: HttpClient): Readonly<{
  verify: (
    request: PricingQuoteClientRequest,
  ) => Promise<PricingQuoteVerificationResponse>;
}> {
  return {
    verify(request) {
      return observe(
        "orders.pricing.verify",
        async () => {
          const body = {
            quoteRef: request.quoteRef,
            hash: request.hash,
            customerRef: request.customerRef,
            quoteLineNumber: request.quoteLineNumber,
            productRef: request.productRef,
            variantRef: request.variantRef,
            quantity: request.quantity,
            ...(request.sourceGrindKeyHash === undefined
              ? {}
              : { sourceGrindKeyHash: request.sourceGrindKeyHash }),
          };
          if (!isPricingQuoteVerifyRequest(body))
            throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
          request.signal.throwIfAborted();
          const signal = AbortSignal.any([
            request.signal,
            AbortSignal.timeout(DEADLINE_MS),
          ]);
          let response: Response;
          try {
            response = await client.fetch(
              "/api/internal-v1/pricing/quotes:verify",
              {
                method: "POST",
                headers: {
                  accept: "application/json, application/problem+json",
                  "content-type": "application/json",
                  "x-service-delegation": request.delegation,
                  "x-correlation-id": request.correlationId,
                  ...(request.traceparent === undefined
                    ? {}
                    : { traceparent: request.traceparent }),
                },
                body: JSON.stringify(body),
                signal,
                redirect: "error",
              },
            );
          } catch (error) {
            return unavailableUnlessCallerCancelled(error, request);
          }
          if (request.signal.aborted) throw request.signal.reason;
          if (signal.aborted)
            throw new PricingQuoteClientError("PRICING_UNAVAILABLE");

          if (response.status === 200) {
            if (mediaType(response) !== "application/json") {
              cancelBody(response);
              throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
            }
            let parsed: unknown;
            try {
              parsed = await readJson(response, signal);
            } catch (error) {
              return unavailableUnlessCallerCancelled(error, request);
            }
            if (
              !isPricingQuoteVerificationResponse(parsed) ||
              !exactScope(parsed, request)
            ) {
              throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
            }
            return parsed;
          }

          if (
            !Object.values(PRICING_ERROR_STATUS).includes(response.status) ||
            mediaType(response) !== "application/problem+json"
          ) {
            cancelBody(response);
            throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
          }
          let parsed: unknown;
          try {
            parsed = await readJson(response, signal);
          } catch (error) {
            return unavailableUnlessCallerCancelled(error, request);
          }
          if (
            !isPricingProblem(parsed) ||
            parsed.status !== response.status ||
            PRICING_ERROR_STATUS[parsed.code] !== response.status
          ) {
            throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
          }
          if (parsed.code === "PRICING_QUOTE_SCOPE_MISMATCH")
            throw new PricingQuoteClientError("PRICING_SCOPE_MISMATCH");
          if (
            parsed.code === "PRICING_QUOTE_NOT_FOUND" ||
            parsed.code === "PRICING_QUOTE_HASH_MISMATCH" ||
            parsed.code === "PRICING_QUOTE_EXPIRED"
          ) {
            throw new PricingQuoteClientError("PRICING_STALE");
          }
          throw new PricingQuoteClientError("PRICING_UNAVAILABLE");
        },
        request.signal,
      );
    },
  };
}
