import {isAromaOfferBindingRequest, isAromaOfferBindingResponse, type AromaOfferBindingRequest, type AromaOfferBindingResponse} from "@coffee-platform/contracts-aroma-v1";

const BINDING_PATH = "/api/internal-v1/aroma/offer-bindings";
const DEADLINE_MS = 5_000;

/** Minimal seam implemented by the platform HttpClient configured for api-internal. */
export type ApiInternalHttpClient = Readonly<{
  fetch(path: string, options: Readonly<RequestInit & {deadlineMs?: number}>): Promise<Response>;
}>;
export type BindingCallContext = Readonly<{correlationId: string; traceparent?: string; signal?: AbortSignal}>;

export class CatalogBindingClientError extends Error {
  public readonly code: string;
  public constructor(code: string) { super(code); this.name = "CatalogBindingClientError"; this.code = code; }
}

function fail(code: string): never { throw new CatalogBindingClientError(code); }

function timedOut(error: unknown): boolean {
  return error !== null && typeof error === "object" && "name" in error &&
    ((error as {name?: unknown}).name === "TimeoutError" || (error as {name?: unknown}).name === "AbortError");
}

/** Calls only the fixed api-internal Gateway binding route; no provider transport or credentials are accepted. */
export class CatalogActivationBindingClient {
  readonly #http: ApiInternalHttpClient;
  public constructor(http: ApiInternalHttpClient) { this.#http = http; }

  public async register(request: AromaOfferBindingRequest, context?: BindingCallContext): Promise<AromaOfferBindingResponse> {
    if (!isAromaOfferBindingRequest(request)) fail("GATEWAY_BINDING_INVALID_REQUEST");
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (context !== undefined) {
      headers["x-correlation-id"] = context.correlationId;
      if (context.traceparent !== undefined) headers["traceparent"] = context.traceparent;
    }

    let response: Response;
    try {
      response = await this.#http.fetch(BINDING_PATH, {
        method: "POST", headers, body: JSON.stringify(request), deadlineMs: DEADLINE_MS,
        ...(context?.signal === undefined ? {} : {signal: context.signal}),
      });
    } catch (error) {
      fail(timedOut(error) ? "GATEWAY_BINDING_DEADLINE_EXCEEDED" : "GATEWAY_BINDING_UNAVAILABLE");
    }

    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      fail("GATEWAY_BINDING_REJECTED");
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      await response.body?.cancel().catch(() => undefined);
      fail("GATEWAY_BINDING_INVALID_RESPONSE");
    }
    let value: unknown;
    try { value = await response.json(); }
    catch { fail("GATEWAY_BINDING_INVALID_RESPONSE"); }
    if (!isAromaOfferBindingResponse(value)) fail("GATEWAY_BINDING_INVALID_RESPONSE");
    return value;
  }
}
