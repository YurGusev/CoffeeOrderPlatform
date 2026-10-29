import {
  isAromaCartSnapshot,
  isAromaProblem,
  type AromaCartSnapshot,
} from "@coffee-platform/contracts-aroma-v1";
import type { HttpClient } from "@coffee-platform/platform-http";

export type GatewayCallContext = Readonly<{
  correlationId: string;
  signal: AbortSignal;
  traceparent?: string;
}>;
export type GatewayClientErrorKind =
  "InvalidRequest" | "TransportUnavailable" | "Rejected" | "InvalidResponse";

const ERROR_CODES = {
  InvalidRequest: "AROMA_GATEWAY_INVALID_REQUEST",
  TransportUnavailable: "AROMA_GATEWAY_TRANSPORT_UNAVAILABLE",
  Rejected: "AROMA_GATEWAY_REJECTED",
  InvalidResponse: "AROMA_GATEWAY_INVALID_RESPONSE",
} as const;
const PROBLEM_STATUSES: Readonly<Record<string, number>> = Object.freeze({
  VALIDATION_FAILED: 400,
  SERVICE_AUTHENTICATION_REQUIRED: 401,
  SERVICE_DELEGATION_INVALID: 403,
  AROMA_PROVIDER_UNAVAILABLE: 503,
});

/** Contains only stable private codes; never a raw body, URL, cause or credentials. */
export class GatewayClientError extends Error {
  public readonly kind: GatewayClientErrorKind;
  public readonly code: (typeof ERROR_CODES)[GatewayClientErrorKind];
  public readonly status?: number;
  public readonly problemCode?: string;
  public constructor(
    kind: GatewayClientErrorKind,
    status?: number,
    problemCode?: string,
  ) {
    super(ERROR_CODES[kind]);
    this.name = "GatewayClientError";
    this.kind = kind;
    this.code = ERROR_CODES[kind];
    if (status !== undefined) this.status = status;
    if (
      problemCode !== undefined &&
      Object.hasOwn(PROBLEM_STATUSES, problemCode)
    )
      this.problemCode = problemCode;
  }
}

function fail(kind: GatewayClientErrorKind): never {
  throw new GatewayClientError(kind);
}

function validateContext(context: GatewayCallContext): void {
  if (
    context === null ||
    typeof context !== "object" ||
    Object.keys(context).some(
      (key) => !["correlationId", "signal", "traceparent"].includes(key),
    ) ||
    !(context.signal instanceof AbortSignal) ||
    typeof context.correlationId !== "string" ||
    !/^[\x21-\x7e]{1,128}$/u.test(context.correlationId)
  )
    fail("InvalidRequest");
  const trace = context.traceparent;
  if (
    trace !== undefined &&
    (typeof trace !== "string" ||
      !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/u.test(trace) ||
      /^ff-|^[0-9a-f]{2}-0{32}-|^[0-9a-f]{2}-[0-9a-f]{32}-0{16}-/u.test(trace))
  )
    fail("InvalidRequest");
  if (context.signal.aborted) fail("TransportUnavailable");
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function boundedJson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body === null) fail("InvalidResponse");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancel pending body reads as well as the fetch; fake transports need not cooperate.
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) fail("TransportUnavailable");
      const chunk = await reader.read();
      if (signal.aborted) fail("TransportUnavailable");
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) fail("InvalidResponse");
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    if (signal.aborted) fail("TransportUnavailable");
    if (error instanceof GatewayClientError) throw error;
    fail("InvalidResponse");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Uses the composition-owned scoped api-internal transport; never signs delegation. */
export class AromaObserverGatewayClient {
  readonly #http: Pick<HttpClient, "fetch">;
  readonly #options: Readonly<{ deadlineMs: number; maxResponseBytes: number }>;

  public constructor(
    http: Pick<HttpClient, "fetch">,
    options: Readonly<{ deadlineMs: number; maxResponseBytes: number }>,
  ) {
    if (
      !Number.isSafeInteger(options.deadlineMs) ||
      options.deadlineMs <= 0 ||
      options.deadlineMs > 2_147_483_647 ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    )
      fail("InvalidRequest");
    this.#http = http;
    this.#options = { ...options };
  }

  public async read(context: GatewayCallContext): Promise<AromaCartSnapshot> {
    const value = await this.#request(
      "/api/internal-v1/aroma/cart-snapshots:read",
      { cartScopeRef: "aroma-primary" },
      context,
    );
    if (!isAromaCartSnapshot(value)) fail("InvalidResponse");
    return value;
  }

  async #request(
    path: string,
    body: unknown,
    context: GatewayCallContext,
  ): Promise<unknown> {
    validateContext(context);
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.deadlineMs,
    );
    const headers: Record<string, string> = {
      accept: "application/json, application/problem+json",
      "content-type": "application/json",
      "x-correlation-id": context.correlationId,
    };
    if (context.traceparent !== undefined)
      headers["traceparent"] = context.traceparent;
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new GatewayClientError("TransportUnavailable"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const operation = async (): Promise<unknown> => {
        let response: Response;
        try {
          // Exactly one fetch, including unsafe methods. Redirects must not dispatch again.
          response = await this.#http.fetch(path, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal,
            redirect: "error",
          });
        } catch {
          fail("TransportUnavailable");
        }
        if (signal.aborted) {
          cancelBody(response);
          fail("TransportUnavailable");
        }
        const contentType = response.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        if (
          contentType !==
          (response.status === 200
            ? "application/json"
            : "application/problem+json")
        ) {
          cancelBody(response);
          fail("InvalidResponse");
        }
        const value = await boundedJson(
          response,
          this.#options.maxResponseBytes,
          signal,
        );
        if (response.status === 200) return value;
        if (
          isAromaProblem(value) &&
          value.status === response.status &&
          Object.hasOwn(PROBLEM_STATUSES, value.code) &&
          PROBLEM_STATUSES[value.code] === response.status
        ) {
          throw new GatewayClientError("Rejected", response.status, value.code);
        }
        fail("InvalidResponse");
      };
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      fail("InvalidResponse");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
