import { isIP } from "node:net";
import { Agent } from "undici";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  verifyTransportPeer,
  type ServiceTransportMaterial,
} from "@coffee-platform/security";

const DEFAULT_CONNECTIONS = 32;
const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const HTTP_TRACER = trace.getTracer("coffee-platform.http");
const SAFE_DEPENDENCIES = new Set([
  "api-internal",
  "customer-service",
  "catalog-service",
  "pricing-service",
  "orders-service",
  "aroma-gateway",
]);
const SAFE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function safeMethod(method: string | undefined): string {
  const normalized = (method ?? "GET").toUpperCase();
  return SAFE_METHODS.has(normalized) ? normalized : "OTHER";
}

function safeDependency(
  hostname: string,
  targetRuntime: string | undefined,
): string {
  return targetRuntime !== undefined &&
    SAFE_DEPENDENCIES.has(targetRuntime) &&
    hostname === targetRuntime
    ? targetRuntime
    : "external";
}

export type HttpClientOptions = Readonly<{
  origin: string;
  connections?: number;
  pipelining?: 1;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  tls?: Readonly<{
    material: ServiceTransportMaterial;
    targetEnvironment: string;
    targetRuntime: string;
  }>;
}>;

export type HttpRequestOptions = RequestInit &
  Readonly<{
    deadlineMs?: number;
  }>;

export class HttpOriginError extends Error {
  public readonly code = "HTTP_ORIGIN_NOT_ALLOWED";

  public constructor(message: string) {
    super(message);
    this.name = "HttpOriginError";
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${field} must be a positive integer`);
  return value;
}

function resolveOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new RangeError(
      "HTTP origin must not contain credentials, path, query, or fragment",
    );
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new RangeError("HTTP origin must use http or https");
  }
  return origin;
}

function resolveTarget(origin: URL, path: string): URL {
  if (!path.startsWith("/"))
    throw new HttpOriginError(
      "HTTP request path must be relative to the configured origin",
    );
  const target = new URL(path, origin);
  if (target.origin !== origin.origin)
    throw new HttpOriginError("HTTP request escaped the configured origin");
  return target;
}

function requestSignal(
  signal: AbortSignal | null | undefined,
  deadlineMs: number | undefined,
): AbortSignal | undefined {
  if (deadlineMs === undefined && signal == null) return undefined;
  if (deadlineMs !== undefined) positiveInteger(deadlineMs, "deadlineMs");
  const deadline =
    deadlineMs === undefined ? undefined : AbortSignal.timeout(deadlineMs);
  if (signal == null) return deadline;
  if (deadline === undefined) return signal;
  return AbortSignal.any([signal, deadline]);
}

export class HttpClient {
  #origin: URL;
  #dependency: string;
  #dispatcher: Agent;
  #closed = false;

  public constructor(options: HttpClientOptions) {
    this.#origin = resolveOrigin(options.origin);
    this.#dependency = safeDependency(
      this.#origin.hostname,
      options.tls?.targetRuntime,
    );
    if ((this.#origin.protocol === "https:") !== (options.tls !== undefined))
      throw new RangeError(
        "HTTPS service clients require scoped mTLS material",
      );
    const connections = options.connections ?? DEFAULT_CONNECTIONS;
    const pipelining = options.pipelining ?? 1;
    const connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    positiveInteger(connections, "connections");
    if (pipelining !== 1) throw new RangeError("pipelining must be 1");
    positiveInteger(connectTimeoutMs, "connectTimeoutMs");
    positiveInteger(idleTimeoutMs, "idleTimeoutMs");
    const tls = options.tls;
    const connect =
      tls === undefined
        ? { timeout: connectTimeoutMs }
        : {
            timeout: connectTimeoutMs,
            ca: tls.material.caPem,
            cert: tls.material.certPem,
            key: tls.material.keyPem,
            minVersion: "TLSv1.3" as const,
            rejectUnauthorized: true,
            servername:
              isIP(this.#origin.hostname) ||
              this.#origin.hostname.startsWith("[")
                ? ""
                : this.#origin.hostname,
            checkServerIdentity: (
              _hostname: string,
              certificate: Parameters<typeof verifyTransportPeer>[0],
            ) => {
              try {
                verifyTransportPeer(
                  certificate,
                  tls.targetEnvironment,
                  tls.targetRuntime,
                );
                return undefined;
              } catch (error) {
                return error instanceof Error
                  ? error
                  : new Error("transport peer identity is invalid");
              }
            },
          };
    this.#dispatcher = new Agent({
      connections,
      pipelining,
      connect,
      keepAliveTimeout: idleTimeoutMs,
    });
  }

  public async fetch(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<Response> {
    if (this.#closed) throw new Error("HTTP client is closed");
    const target = resolveTarget(this.#origin, path);
    const { deadlineMs, ...init } = options;
    const signal = requestSignal(init.signal, deadlineMs);
    const method = safeMethod(init.method);
    const span = HTTP_TRACER.startSpan(`HTTP ${method}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "http.request.method": method,
        "server.address": this.#dependency,
      },
    });
    const requestInit = {
      ...init,
      ...(signal === undefined ? {} : { signal }),
      dispatcher: this.#dispatcher,
    } as RequestInit & { dispatcher: Agent };
    try {
      return await context.with(
        trace.setSpan(context.active(), span),
        async () => {
          // W3C context remains caller-owned so signed delegation headers stay unchanged.
          const response = await globalThis.fetch(target, requestInit);
          try {
            span.setAttribute("http.response.status_code", response.status);
            if (response.status >= 500) {
              span.setAttribute("failure.class", "http_5xx");
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          } catch {
            /* Telemetry must not change the request result. */
          }
          return response;
        },
      );
    } catch (error) {
      try {
        const errorType = signal?.aborted
          ? signal.reason instanceof Error &&
            signal.reason.name === "TimeoutError"
            ? "timeout"
            : "aborted"
          : error instanceof HttpOriginError
            ? "origin_rejected"
            : error instanceof TypeError
              ? "transport"
              : "other";
        span.setAttribute("failure.class", errorType);
        span.setStatus({ code: SpanStatusCode.ERROR });
      } catch {
        /* Telemetry must not change the request result. */
      }
      throw error;
    } finally {
      try {
        span.end();
      } catch {
        /* Telemetry must not change the request result. */
      }
    }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#dispatcher.close();
  }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  return new HttpClient(options);
}
