import { Agent } from "undici";
import { ProviderError } from "../../domain/provider-errors.js";
import {
  decodeLoginSuccess,
  decodeProviderRejection,
  type ProviderRejection,
  type ProviderUser,
} from "./decoder.js";
import {finishGatewaySpan, type GatewayTelemetry} from "../observability.js";
import {
  parseSetCookieHeaders,
  cookieHeader,
  type ProviderCookie,
} from "./cookie-jar.js";

// Только Gateway-owned adapters выбирают эти операции. URL/headers/body caller
// не являются входами HTTP policy. Retry здесь отсутствует.
export type ReadOperation =
  | Readonly<{ kind: "cart" }>
  | Readonly<{ kind: "user" }>
  | Readonly<{ kind: "catalog-page"; page: number; pageSize: number }>;

export type MutationOperation =
  | Readonly<{
      kind: "add-cart-line";
      offerId: string;
      quantity: number;
      packing?: string;
      grindId?: string;
    }>
  | Readonly<{
      kind: "set-cart-line-quantity";
      cartLineId: string;
      quantity: number;
      packing?: string | null;
      grindId?: string | null;
    }>
  | Readonly<{ kind: "remove-cart-line"; cartLineId: string }>;

type ProviderFetch = (
  input: string,
  init: Omit<RequestInit, "dispatcher"> & { dispatcher: Agent },
) => Promise<Response>;

export type ProviderHttpOptions = Readonly<{
  origin: string;
  timeoutMs: number;
  maxResponseBytes: number;
  connections: number;
  telemetry?: GatewayTelemetry;
}>;

export type ProviderLoginResult = Readonly<{
  profile: ProviderUser;
  cookies: readonly ProviderCookie[];
}>;

export type ProviderMutationTransportResult = Readonly<{
  statusCode: number;
  body: Uint8Array;
  rejection?: ProviderRejection;
}>;

const SAFE_CART_READ_RETRY_DELAY_MS = 250;

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function providerId(value: string): boolean {
  return /^[0-9]+$/u.test(value) && value !== "0";
}

function operationPath(operation: ReadOperation): string {
  switch (operation.kind) {
    case "cart":
      return "/api/v1/cart/";
    case "user":
      return "/api/v1/user";
    case "catalog-page": {
      if (!positive(operation.page) || !positive(operation.pageSize))
        throw new ProviderError("ProviderProtocolViolation");
      return `/api/v1/catalog/wholesale/products?page=${operation.page}&per_page=${operation.pageSize}`;
    }
    default:
      throw new ProviderError("ProviderProtocolViolation");
  }
}

function mutationPath(operation: MutationOperation): string {
  if (operation.kind === "add-cart-line") return "/api/v1/cart/";
  if (!providerId(operation.cartLineId))
    throw new ProviderError("ProviderProtocolViolation");
  return `/api/v1/cart/${operation.cartLineId}`;
}

function combineSignal(
  signal: AbortSignal,
  shutdown: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([signal, shutdown, AbortSignal.timeout(timeoutMs)]);
}

/** Private transport: не экспортируется через capability DTO или application. */
export class ProviderHttpClient {
  readonly #origin: string;
  readonly #originHost: string;
  readonly #options: ProviderHttpOptions;
  readonly #agent: Agent;
  readonly #shutdown = new AbortController();

  constructor(options: ProviderHttpOptions) {
    let origin: URL;
    try {
      origin = new URL(options.origin);
    } catch {
      throw new ProviderError("ProviderProtocolViolation");
    }
    if (
      origin.protocol !== "https:" ||
      origin.port !== "" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !positive(options.timeoutMs) ||
      !positive(options.maxResponseBytes) ||
      !positive(options.connections)
    ) {
      throw new ProviderError("ProviderProtocolViolation");
    }
    this.#origin = origin.origin;
    this.#originHost = origin.hostname.toLowerCase();
    this.#options = { ...options };

    this.#agent = new Agent({
      connections: options.connections,
      pipelining: 1,
      connect: { timeout: options.timeoutMs },
      maxHeaderSize: 16_384,
    });
  }

  /** Local transport readiness only; no provider request is made. */
  isReady(): boolean {
    return !this.#shutdown.signal.aborted && this.#origin.startsWith("https://") && this.#agent !== undefined;
  }

  async *read(
    operation: ReadOperation,
    signal: AbortSignal,
    cookies?: readonly ProviderCookie[],
  ): AsyncGenerator<Uint8Array, readonly ProviderCookie[]> {
    const path = operationPath(operation);
    return yield* this.#stream(
      path,
      "GET",
      undefined,
      signal,
      cookies,
      operation.kind === "cart",
    );
  }

  async login(
    credentials: Readonly<{ email: string; password: string }>,
    signal: AbortSignal,
  ): Promise<ProviderLoginResult> {
    if (
      typeof credentials.email !== "string" ||
      credentials.email.length === 0 ||
      typeof credentials.password !== "string" ||
      credentials.password.length === 0 ||
      !credentials.email.isWellFormed() ||
      !credentials.password.isWellFormed()
    ) {
      throw new ProviderError("ProviderProtocolViolation");
    }
    const startedAt = performance.now();
    const span = this.#options.telemetry?.startSpan("aroma.gateway.provider.login");
    let failure: unknown;
    const combined = combineSignal(
      signal,
      this.#shutdown.signal,
      this.#options.timeoutMs,
    );
    let body: Uint8Array;
    let response: Response | undefined;
    try {
      combined.throwIfAborted();
      const providerFetch = globalThis.fetch as unknown as ProviderFetch;
      response = await providerFetch(`${this.#origin}/api/v1/auth/login`, {
        method: "POST",
        redirect: "manual",
        signal: combined,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
        dispatcher: this.#agent,
      });
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError(
          "ProviderProtocolViolation",
          false,
          response.status,
        );
      body = await this.#readBody(response, combined);
      if (response.status === 401 || response.status === 422) {
        try {
          decodeProviderRejection(response.status, body);
        } catch {
          throw new ProviderError(
            "ProviderProtocolViolation",
            body.byteLength > 0,
            response.status,
          );
        }
        throw new ProviderError(
          "ProviderAuthenticationFailed",
          body.byteLength > 0,
          response.status,
        );
      }
      if (response.status === 403)
        throw new ProviderError(
          "ProviderAuthorizationFailed",
          body.byteLength > 0,
          response.status,
        );
      if (response.status !== 200)
        throw new ProviderError(
          "ProviderUnavailable",
          body.byteLength > 0,
          response.status,
        );
      this.#assertJson(response);
      const profile = decodeLoginSuccess(body);
      const cookies = parseSetCookieHeaders(response.headers, this.#originHost);
      return { profile, cookies };
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("ProviderUnavailable");
      throw failure;
    } finally {
      try {
        await response?.body?.cancel();
      } catch {
        /* typed error is retained */
      }
      this.#options.telemetry?.observeProviderLatency(performance.now() - startedAt);
      if (span !== undefined) finishGatewaySpan(span, failure);
    }
  }

  /** Typed cart transport for the Gateway adapter; there is no generic request escape hatch. */
  async mutate(
    operation: MutationOperation,
    signal: AbortSignal,
    cookies?: readonly ProviderCookie[],
  ): Promise<ProviderMutationTransportResult> {
    const path = mutationPath(operation);
    let method: "POST" | "PUT" | "DELETE";
    let body: string | undefined;
    let contentType: string | undefined;
    if (operation.kind === "add-cart-line") {
      if (
        !providerId(operation.offerId) ||
        !positive(operation.quantity) ||
        (operation.packing !== undefined &&
          !operation.packing.isWellFormed()) ||
        (operation.grindId !== undefined && !operation.grindId.isWellFormed())
      )
        throw new ProviderError("ProviderProtocolViolation");
      method = "POST";
      const form = new URLSearchParams({
        offer_id: operation.offerId,
        quantity: String(operation.quantity),
      });
      if (operation.packing !== undefined)
        form.set("packing", operation.packing);
      if (operation.grindId !== undefined)
        form.set("grind_id", operation.grindId);
      body = form.toString();
      contentType = "application/x-www-form-urlencoded";
    } else if (operation.kind === "set-cart-line-quantity") {
      if (!positive(operation.quantity))
        throw new ProviderError("ProviderProtocolViolation");
      method = "PUT";
      const payload: Record<string, unknown> = {quantity: operation.quantity};
      if (operation.packing !== undefined && operation.packing !== null) payload["packing"] = operation.packing;
      if (operation.grindId !== undefined && operation.grindId !== null) payload["grind_id"] = operation.grindId;
      body = JSON.stringify(payload);
      contentType = "application/json";
    } else {
      method = "DELETE";
    }
    const startedAt = performance.now();
    const span = this.#options.telemetry?.startSpan("aroma.gateway.provider.mutation", {method});
    let failure: unknown;
    const combined = combineSignal(
      signal,
      this.#shutdown.signal,
      this.#options.timeoutMs,
    );
    let response: Response | undefined;
    try {
      combined.throwIfAborted();
      const providerFetch = globalThis.fetch as unknown as ProviderFetch;
      response = await providerFetch(`${this.#origin}${path}`, {
        method,
        redirect: "manual",
        signal: combined,
        headers: {
          accept: "application/json",
          ...(contentType === undefined ? {} : { "content-type": contentType }),
          ...(cookies === undefined
            ? {}
            : { cookie: cookieHeader(cookies, this.#originHost) }),
        },
        ...(body === undefined ? {} : { body }),
        dispatcher: this.#agent,
      });
      if (response.status >= 300 && response.status < 400)
        throw new ProviderError(
          "ProviderProtocolViolation",
          false,
          response.status,
        );
      const bytes = await this.#readBody(response, combined);
      this.#assertJson(response);
      if (response.status >= 400) {
        try {
          return {
            statusCode: response.status,
            body: bytes,
            rejection: decodeProviderRejection(response.status, bytes),
          };
        } catch {
          throw new ProviderError(
            "ProviderProtocolViolation",
            bytes.byteLength > 0,
            response.status,
          );
        }
      }
      if (response.status < 200 || response.status > 299)
        throw new ProviderError(
          "ProviderUnavailable",
          bytes.byteLength > 0,
          response.status,
        );
      return { statusCode: response.status, body: bytes };
    } catch (error) {
      failure = error instanceof ProviderError ? error : new ProviderError("ProviderUnavailable");
      throw failure;
    } finally {
      try {
        await response?.body?.cancel();
      } catch {
        /* typed error is retained */
      }
      this.#options.telemetry?.observeProviderLatency(performance.now() - startedAt);
      if (span !== undefined) finishGatewaySpan(span, failure);
    }
  }

  async *#stream(
    path: string,
    method: "GET",
    body: string | undefined,
    signal: AbortSignal,
    cookies: readonly ProviderCookie[] | undefined,
    allowCartRetry: boolean,
  ): AsyncGenerator<Uint8Array, readonly ProviderCookie[]> {
    const providerFetch = globalThis.fetch as unknown as ProviderFetch;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const startedAt = performance.now();
      const span = this.#options.telemetry?.startSpan("aroma.gateway.provider.read", {method});
      const combined = combineSignal(
        signal,
        this.#shutdown.signal,
        this.#options.timeoutMs,
      );
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let received = 0;
      let retryError: ProviderError | undefined;
      let failure: unknown;
      try {
        combined.throwIfAborted();
        response = await providerFetch(`${this.#origin}${path}`, {
          method,
          redirect: "manual",
          signal: combined,
          headers: {
            accept: "application/json",
            ...(cookies === undefined
              ? {}
              : { cookie: cookieHeader(cookies, this.#originHost) }),
          },
          ...(body === undefined ? {} : { body }),
          dispatcher: this.#agent,
        });
        if (response.status >= 300 && response.status < 400)
          throw new ProviderError(
            "ProviderProtocolViolation",
            false,
            response.status,
          );
        if (response.status === 401)
          throw new ProviderError(
            "ProviderAuthenticationFailed",
            false,
            response.status,
          );
        if (response.status === 403)
          throw new ProviderError(
            "ProviderAuthorizationFailed",
            false,
            response.status,
          );
        if (response.status !== 200)
          throw new ProviderError(
            "ProviderUnavailable",
            false,
            response.status,
          );
        this.#assertJson(response);
        const length = response.headers.get("content-length");
        if (
          length !== null &&
          (!/^\d+$/u.test(length) ||
            BigInt(length) > BigInt(this.#options.maxResponseBytes))
        ) {
          throw new ProviderError(
            "ProviderResponseTooLarge",
            false,
            response.status,
          );
        }
        if (response.body === null)
          throw new ProviderError(
            "ProviderProtocolViolation",
            false,
            response.status,
          );
        const cookieUpdates = parseSetCookieHeaders(
          response.headers,
          this.#originHost,
        );
        reader = response.body.getReader();
        while (true) {
          combined.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > this.#options.maxResponseBytes)
            throw new ProviderError(
              "ProviderResponseTooLarge",
              true,
              response.status,
            );
          yield chunk.value;
        }
        if (received === 0)
          throw new ProviderError(
            "ProviderReadIncomplete",
            false,
            response.status,
          );
        return cookieUpdates;
      } catch (error) {
        const typed =
          error instanceof ProviderError
            ? error
            : new ProviderError(
                received > 0 ? "ProviderReadIncomplete" : "ProviderUnavailable",
                received > 0,
              );
        const retryable =
          allowCartRetry &&
          received === 0 &&
          (typed.code === "ProviderUnavailable" ||
            typed.code === "ProviderReadIncomplete") &&
          attempt < 2;
        failure = typed;
        if (!retryable) throw typed;
        retryError = typed;
      } finally {
        if (reader !== undefined) {
          try {
            await reader.cancel();
          } catch {
            /* cleanup never replaces the typed provider error */
          }
          reader.releaseLock();
        } else {
          try {
            await response?.body?.cancel();
          } catch {
            /* preserve the original typed error */
          }
        }
        this.#options.telemetry?.observeProviderLatency(performance.now() - startedAt);
        if (span !== undefined) finishGatewaySpan(span, failure);
      }
      try {
        await this.#waitForCartReadRetry(signal);
      } catch {
        throw retryError ?? new ProviderError("ProviderUnavailable");
      }
    }
    throw new ProviderError("ProviderUnavailable");
  }

  async #waitForCartReadRetry(signal: AbortSignal): Promise<void> {
    const cancellation = AbortSignal.any([signal, this.#shutdown.signal]);
    cancellation.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cancellation.removeEventListener("abort", onAbort);
        resolve();
      }, SAFE_CART_READ_RETRY_DELAY_MS);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellation.removeEventListener("abort", onAbort);
        reject(cancellation.reason);
      };
      cancellation.addEventListener("abort", onAbort, { once: true });
      if (cancellation.aborted) onAbort();
    });
    cancellation.throwIfAborted();
  }

  async #readBody(
    response: Response,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (response.body === null)
      throw new ProviderError("ProviderReadIncomplete", false, response.status);
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/u.test(length) ||
        BigInt(length) > BigInt(this.#options.maxResponseBytes))
    ) {
      throw new ProviderError(
        "ProviderResponseTooLarge",
        false,
        response.status,
      );
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > this.#options.maxResponseBytes)
          throw new ProviderError(
            "ProviderResponseTooLarge",
            true,
            response.status,
          );
        chunks.push(chunk.value);
      }
      if (received === 0)
        throw new ProviderError(
          "ProviderReadIncomplete",
          false,
          response.status,
        );
      const result = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* cleanup never replaces typed error */
      }
      reader.releaseLock();
    }
  }

  #assertJson(response: Response): void {
    if (
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    ) {
      throw new ProviderError(
        "ProviderProtocolViolation",
        false,
        response.status,
      );
    }
  }

  async close(): Promise<void> {
    this.#shutdown.abort();
    await this.#agent.destroy();
  }
}
