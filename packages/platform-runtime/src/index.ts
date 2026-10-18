import { readFile, stat } from "node:fs/promises";
import { monitorEventLoopDelay, PerformanceObserver, performance as nodePerformance } from "node:perf_hooks";
import type { Socket } from "node:net";
import {TLSSocket} from "node:tls";
import { Temporal } from "@js-temporal/polyfill";
import { context as otelContext, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  loadPlatformConfig,
  type HealthConfig,
  type PlatformConfig,
  type RuntimeName,
} from "@coffee-platform/config";
import { createDatabase, type Database } from "@coffee-platform/database";
import {
  createKafkaRuntime,
  type KafkaRuntime,
  type KafkaCredentials,
} from "@coffee-platform/kafka-runtime";
import {
  createPinoLogger,
  createCorrelationContext,
  createTelemetryResource,
  logRecordsDropped,
  recordRuntimeHttpRequest,
  setRuntimeReadiness,
  telemetryDiagnostics,
  withCorrelationFields,
  type CorrelationContext,
} from "@coffee-platform/observability";
import {
  createMutualTlsServerOptions,
  createPublicTlsServerOptions,
  parsePublicTlsMaterial,
  parsePublicTlsHostname,
  parseServiceTransportMaterial,
  verifyTransportPeer,
  type PublicTlsMaterial,
  type ServiceTransportMaterial,
  type TransportIdentity,
} from "@coffee-platform/security";
import type {TransportMode} from "@coffee-platform/config";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { load as parseYaml } from "js-yaml";

export type RuntimeReadinessCheck = Readonly<{
  name: string;
  check: (signal: AbortSignal) => Promise<boolean | void> | boolean | void;
}>;

// Владение регистрируется до start: destroy обязан закрыть и частично созданный ресурс.
export type RuntimeResource = Readonly<{
  name: string;
  start?: (signal: AbortSignal) => Promise<void> | void;
  stop: (signal: AbortSignal) => Promise<void> | void;
  destroy: () => void;
}>;

export type RuntimeComposition = Readonly<{
  readinessChecks?: readonly RuntimeReadinessCheck[];
  resources?: readonly RuntimeResource[];
  /** Additional bounded Prometheus lines owned by the composed runtime. */
  metrics?: () => readonly string[];
  /** Synchronous opt-in formatter for capacity rejection, never lifecycle/TLS failures. */
  admissionResponse?: (request: FastifyRequest, reply: FastifyReply) => boolean;
  /** Configured database owners receive their one opaque Database as `database`. */
  configure?: (
    app: FastifyInstance,
    signal: AbortSignal,
    database?: Database,
    kafka?: KafkaRuntime,
    context?: RuntimeCompositionContext,
  ) => Promise<void> | void;
}>;

/** Runtime-owned configuration and only the scoped secrets for this process. */
export type RuntimeCompositionContext = Readonly<{
  config: PlatformConfig;
  secrets: Readonly<Record<string, unknown>>;
}>;

export type RuntimeTransport = Readonly<{
  environment: string;
  runtime: string;
  mode: TransportMode;
  material?: ServiceTransportMaterial;
  publicTls?: PublicTlsMaterial;
  setupError?: string;
}>;

export type RuntimeIdentity = RuntimeComposition &
  Readonly<{
    name: string;
    host: string;
    port: number;
    shutdownGraceMs: number;
    health?: HealthConfig;
    deadlineMs?: number | null;
    deadlineProfiles?: Readonly<Record<string, number | null>>;
    concurrency?: number;
    bodyLimitBytes?: number;
    requiredDependencies?: readonly string[];
    transport?: RuntimeTransport;
    telemetryLogRecordBytes?: number;
    telemetryLogQueueCapacity?: number;
    telemetryLogDiagnosticIntervalMs?: number;
    releaseDigest?: string;
  }>;

const runtimeRequestStarts = new WeakMap<Span, number>();
const RUNTIME_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function completeRuntimeRequestTelemetry(request: Pick<FastifyRequest, "runtimeSpan" | "method" | "routeOptions">, statusCode: number): void {
  const span = request.runtimeSpan;
  if (span === null) return;
  span.setAttribute("http.response.status_code", statusCode);
  const startedAt = runtimeRequestStarts.get(span);
  runtimeRequestStarts.delete(span);
  if (startedAt !== undefined) {
    const attributes = {
      "http.request.method": RUNTIME_HTTP_METHODS.has(request.method) ? request.method : "_OTHER",
      "http.route": request.routeOptions.url ?? "unknown",
      "http.response.status_class": Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? `${Math.floor(statusCode / 100)}xx` : "other",
    };
    recordRuntimeHttpRequest(nodePerformance.now() - startedAt, attributes);
  }
  span.end();
  request.runtimeSpan = null;
}

export type RuntimePhase = "starting" | "running" | "draining" | "stopped";
export type RuntimeShutdownResult = Readonly<{
  status: "stopped" | "fail-stop";
  pending: readonly string[];
}>;
export type RuntimeController = Readonly<{
  phase: () => RuntimePhase;
  whenStopped: Promise<RuntimeShutdownResult>;
  transition: (next: RuntimePhase) => void;
  start: () => Promise<void>;
  closeRuntime: (signal?: NodeJS.Signals) => Promise<RuntimeShutdownResult>;
}>;
export type RuntimeRequestContext = CorrelationContext &
  Readonly<{
    signal: AbortSignal;
    deadlineUtc: string | null;
    transportIdentity: TransportIdentity | null;
    // Вызывается владельцем только ПОСЛЕ известного durable commit, не перед COMMIT.
    acceptDurable: () => void;
  }>;

export class RuntimeError extends Error {
  public readonly code: string;
  public constructor(code: string) {
    super(code);
    this.name = "RuntimeError";
    this.code = code;
  }
}

type ScopedSecretDocument = Readonly<{
  secrets: Readonly<Record<string, unknown>>;
}>;

function secretRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secretAt(document: ScopedSecretDocument, ref: string): unknown {
  let value: unknown = document.secrets;
  for (const segment of ref.split(".")) value = secretRecord(value) ? value[segment] : undefined;
  return value;
}

function transportMaterial(document: ScopedSecretDocument, refs: readonly string[], optionalRefs: readonly string[], environment: string, runtime: RuntimeName, mode: TransportMode, publicHostname?: string): RuntimeTransport {
  const refsForTransport = refs.filter((ref) => ref === `security.serviceTransportKeys.${runtime}`);
  const ref = refsForTransport[0];
  if (refsForTransport.length !== 1 || ref === undefined) return {environment, runtime, mode, setupError: "RUNTIME_TRANSPORT_SECRET_SCOPE"};
  try {
    const material = parseServiceTransportMaterial(secretAt(document, ref), environment, runtime);
    if (mode !== "public-tls") return {environment, runtime, mode, material};
    if (publicHostname === undefined || refs.filter((value) => value === "edge.tlsPrivateKey").length !== 1 || refs.filter((value) => value === "edge.tlsCertificate").length !== 1) {
      return {environment, runtime, mode, material, setupError: "RUNTIME_PUBLIC_TLS_SECRET_SCOPE"};
    }
    const publicCaPem = optionalRefs.includes("edge.tlsCaBundle") ? secretAt(document, "edge.tlsCaBundle") : undefined;
    return {
      environment,
      runtime,
      mode,
      material,
      publicTls: parsePublicTlsMaterial(secretAt(document, "edge.tlsPrivateKey"), secretAt(document, "edge.tlsCertificate"), publicHostname, publicCaPem),
    };
  } catch (error) {
    return {environment, runtime, mode, setupError: error instanceof Error ? error.name : "TransportValidationError"};
  }
}

function publicHostname(config: PlatformConfig): string {
  const value = config.platform["publicBaseUrl"];
  try {
    return parsePublicTlsHostname(value);
  } catch {
    throw new RuntimeError("RUNTIME_PUBLIC_BASE_URL_INVALID");
  }
}

function ownDatabaseCredential(
  document: ScopedSecretDocument,
  runtime: RuntimeName,
  refs: readonly string[],
): Readonly<{ username: string; password: string }> {
  const databaseRefs = refs.filter((ref) => ref.startsWith("postgres."));
  const databaseRef = databaseRefs[0];
  if (databaseRefs.length !== 1 || databaseRef === undefined)
    throw new RuntimeError("RUNTIME_DATABASE_SECRET_SCOPE");
  let value: unknown = document.secrets;
  for (const segment of databaseRef.split(".")) {
    value = secretRecord(value) ? value[segment] : undefined;
  }
  const credential = secretRecord(value) ? value : undefined;
  if (
    credential === undefined ||
    Object.keys(credential).sort().join(",") !== "password,username" ||
    typeof credential["username"] !== "string" ||
    credential["username"].length === 0 ||
    typeof credential["password"] !== "string" ||
    credential["password"].length === 0
  )
    throw new RuntimeError(`RUNTIME_DATABASE_SECRET_INVALID:${runtime}`);
  return {
    username: credential["username"],
    password: credential["password"],
  };
}

function ownKafkaCredential(
  document: ScopedSecretDocument,
  refs: readonly string[],
): KafkaCredentials {
  const kafkaRefs = refs.filter((ref) => ref.startsWith("kafka."));
  if (kafkaRefs.length !== 1)
    throw new RuntimeError("RUNTIME_KAFKA_SECRET_SCOPE");
  let value: unknown = document.secrets;
  for (const segment of (kafkaRefs[0] ?? "").split("."))
    value = secretRecord(value) ? value[segment] : undefined;
  if (
    !secretRecord(value) ||
    !["password,username", "caPem,password,username"].includes(Object.keys(value).sort().join(",")) ||
    [value["username"], value["password"]].some(
      (field) => typeof field !== "string" || field.length === 0,
    ) || (value["caPem"] !== undefined && (typeof value["caPem"] !== "string" || value["caPem"].length === 0))
  )
    throw new RuntimeError("RUNTIME_KAFKA_SECRET_INVALID");
  return {
    username: value["username"] as string,
    password: value["password"] as string,
    ...(value["caPem"] === undefined ? {} : {caPem: value["caPem"] as string}),
  };
}

function appendOwnedComposition(
  composition: RuntimeComposition,
  database?: Database,
  kafka?: KafkaRuntime,
  context?: RuntimeCompositionContext,
): RuntimeComposition {
  const owned = [...(database ? [database] : []), ...(kafka ? [kafka] : [])];
  for (const owner of owned) {
    if (
      composition.resources?.some(
        (resource) => resource.name === owner.resource.name,
      ) ||
      composition.readinessChecks?.some(
        (check) => check.name === owner.readiness.name,
      )
    )
      throw new RuntimeError("RUNTIME_DUPLICATE_COMPOSITION");
  }
  return {
    ...composition,
    configure: (app: FastifyInstance, signal: AbortSignal, ownedDatabase?: Database, ownedKafka?: KafkaRuntime, ownedContext?: RuntimeCompositionContext) => {
      if (kafka)
        void kafka.whenFailed.then(() => app.runtimeController.closeRuntime());
      return composition.configure?.(app, signal, database ?? ownedDatabase, kafka ?? ownedKafka, context ?? ownedContext);
    },
    resources: [
      ...owned.map((owner) => owner.resource),
      ...(composition.resources ?? []),
    ],
    readinessChecks: [
      ...owned.map((owner) => owner.readiness),
      ...(composition.readinessChecks ?? []),
    ],
  };
}

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: CorrelationContext | null;
    runtimeContext: RuntimeRequestContext | null;
    runtimeSpan: Span | null;
  }
  interface FastifyInstance {
    runtimeController: RuntimeController;
  }
  interface FastifyContextConfig {
    runtimeDeadlineProfile?: string;
  }
}

const DEFAULT_HEALTH: HealthConfig = Object.freeze({
  livePath: "/health/live",
  readyPath: "/health/ready",
  metricsPath: "/metrics",
  intervalMs: 5_000,
  timeoutMs: 1_000,
  startupGraceMs: 30_000,
  failureThreshold: 3,
  successThreshold: 1,
});
const HEALTH_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "runtime"],
  properties: {
    status: {
      type: "string",
      enum: ["live", "ready", "not-ready", "stopping"],
    },
    runtime: { type: "string", minLength: 1 },
  },
} as const;

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : "UnknownError";
}
function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${field} must be a positive integer`);
}
function setCorrelationResponseHeaders(
  reply: FastifyReply,
  context: CorrelationContext,
): void {
  reply.header("x-correlation-id", context.correlationId);
  if (context.traceparent !== undefined)
    reply.header("traceparent", context.traceparent);
}

// Ограничивает ожидание, но не объявляет native Promise отменённым.
// Незавершённая работа остаётся в pending до settlement и требует fail-stop при shutdown.
function observeUntil<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export async function createRuntime(
  identity: RuntimeIdentity,
): Promise<FastifyInstance> {
  const health = identity.health ?? DEFAULT_HEALTH;
  for (const path of [health.livePath, health.readyPath, health.metricsPath]) {
    if (!path.startsWith("/"))
      throw new RangeError("health path must be absolute");
  }
  positiveInteger(health.timeoutMs, "health.timeoutMs");
  positiveInteger(health.startupGraceMs, "health.startupGraceMs");
  positiveInteger(identity.shutdownGraceMs, "shutdownGraceMs");
  const deadlineMs =
    identity.deadlineMs === undefined ? 5_000 : identity.deadlineMs;
  if (deadlineMs !== null) positiveInteger(deadlineMs, "deadlineMs");
  for (const value of Object.values(identity.deadlineProfiles ?? {})) {
    if (value !== null) positiveInteger(value, "deadlineProfiles");
  }
  if (identity.concurrency !== undefined)
    positiveInteger(identity.concurrency, "concurrency");
  if (identity.bodyLimitBytes !== undefined)
    positiveInteger(identity.bodyLimitBytes, "bodyLimitBytes");
  const checks = identity.readinessChecks ?? [];
  const resources = identity.resources ?? [];
  for (const names of [
    checks.map((check) => check.name),
    resources.map((resource) => resource.name),
  ]) {
    if (
      names.some((name) => !/^[a-z][a-z0-9-]{0,63}$/.test(name)) ||
      new Set(names).size !== names.length
    )
      throw new RuntimeError("RUNTIME_INVALID_RESOURCE_NAMES");
  }
  let phase: RuntimePhase = "starting";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<RuntimeShutdownResult> | undefined;
  let admissionRejected = 0;
  const lifetime = new AbortController();
  const closing = new AbortController();
  const sockets = new Set<Socket>();
  const requests = new Set<AbortController>();
  const handlers = new Set<Promise<unknown>>();
  const requestCleanup = new WeakMap<FastifyRequest, () => void>();
  const pending = new Set<string>();
  const eventLoopDelay = monitorEventLoopDelay({resolution: 20});
  eventLoopDelay.enable();
  let gcPauseCount = 0;
  let gcPauseTotalMs = 0;
  const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcPauseCount += 1;
      gcPauseTotalMs += entry.duration;
    }
  });
  gcObserver.observe({entryTypes: ["gc"]});
  let previousEventLoopUtilization = nodePerformance.eventLoopUtilization();
  const runtimeMetrics = (): readonly string[] => {
    const utilization = nodePerformance.eventLoopUtilization(previousEventLoopUtilization);
    previousEventLoopUtilization = nodePerformance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const delayMs = (percentile: number): number => eventLoopDelay.count === 0 ? 0 : Number((eventLoopDelay.percentile(percentile) / 1e6).toFixed(3));
    const lines = [
      `runtime_event_loop_utilization ${Number(utilization.utilization.toFixed(6))}`,
      `runtime_event_loop_delay_p50_ms ${delayMs(50)}`,
      `runtime_event_loop_delay_p95_ms ${delayMs(95)}`,
      `runtime_event_loop_delay_p99_ms ${delayMs(99)}`,
      `runtime_event_loop_delay_samples ${eventLoopDelay.count}`,
      `runtime_process_rss_bytes ${memory.rss}`,
      `runtime_process_heap_used_bytes ${memory.heapUsed}`,
      `runtime_process_heap_total_bytes ${memory.heapTotal}`,
      `runtime_process_external_bytes ${memory.external}`,
      `runtime_process_array_buffers_bytes ${memory.arrayBuffers}`,
      `runtime_gc_pause_count_total ${gcPauseCount}`,
      `runtime_gc_pause_total_ms ${Number(gcPauseTotalMs.toFixed(3))}`,
    ];
    eventLoopDelay.reset();
    return lines;
  };
  const acquired: RuntimeResource[] = [];
  const runningChecks = new Map<string, Promise<boolean>>();
  const stopped = Promise.withResolvers<RuntimeShutdownResult>();
  let transportError: string | undefined;
  if (identity.transport !== undefined) {
    transportError = identity.transport.setupError;
    if (transportError === undefined && identity.transport.material === undefined) transportError = "RUNTIME_TRANSPORT_MATERIAL_MISSING";
    if (transportError === undefined && identity.transport.mode === "public-tls" && identity.transport.publicTls === undefined) transportError = "RUNTIME_PUBLIC_TLS_MATERIAL_MISSING";
  }
  const httpsOptions = identity.transport?.mode === "mtls"
    ? identity.transport.material === undefined ? undefined : createMutualTlsServerOptions(identity.transport.material)
    : identity.transport?.mode === "public-tls"
      ? identity.transport.publicTls === undefined ? undefined : createPublicTlsServerOptions(identity.transport.publicTls)
      : undefined;
  const loggerInstance = createPinoLogger({runtime: identity.name, ...(identity.releaseDigest === undefined ? {} : {releaseDigest: identity.releaseDigest})}, identity.telemetryLogRecordBytes, undefined, identity.telemetryLogQueueCapacity, identity.telemetryLogDiagnosticIntervalMs);
  const app = Fastify({
    // Admission ниже сохраняет live/ready для уже принятого transport во время drain.
    return503OnClosing: false,
    ...(identity.bodyLimitBytes === undefined
      ? {}
      : { bodyLimit: identity.bodyLimitBytes }),
    ...(httpsOptions === undefined
      ? {}
      : {https: httpsOptions}),
    loggerInstance: loggerInstance as unknown as FastifyBaseLogger,
    childLoggerFactory: (logger, bindings, options, request) => logger.child({
      ...bindings,
      ...withCorrelationFields(createCorrelationContext(
        request.headers,
        typeof bindings["reqId"] === "string" ? bindings["reqId"] : undefined,
      )),
    }, options),
    genReqId: (request) =>
      createCorrelationContext(request.headers).correlationId,
  });
  const transition = (next: RuntimePhase): void => {
    if (phase === next) return;
    const valid =
      (phase === "starting" && (next === "running" || next === "draining")) ||
      (phase === "running" && next === "draining") ||
      (phase === "draining" && next === "stopped");
    if (!valid) {
      app.log.error(
        { event: "runtime.transition.invalid", from: phase, to: next },
        "invalid runtime transition",
      );
      throw new RuntimeError("RUNTIME_INVALID_TRANSITION");
    }
    app.log.info(
      { event: "runtime.phase", from: phase, to: next },
      "runtime phase changed",
    );
    phase = next;
    setRuntimeReadiness(false);
  };
  const track = <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    pending.add(name);
    return Promise.resolve()
      .then(work)
      .finally(() => pending.delete(name));
  };
  const destroy = (): void => {
    for (const request of requests)
      request.abort(new RuntimeError("RUNTIME_SHUTDOWN_DEADLINE"));
    for (const socket of sockets) socket.destroy();
    app.server.close();
    for (const resource of [...acquired].reverse()) {
      try {
        resource.destroy();
      } catch (error) {
        app.log.error(
          {
            event: "runtime.destroy.failed",
            resource: resource.name,
            reason: errorName(error),
          },
          "resource destroy failed",
        );
      }
    }
  };
  const closeRuntime = (
    signal?: NodeJS.Signals,
  ): Promise<RuntimeShutdownResult> => {
    if (stopPromise !== undefined) return stopPromise;
    stopPromise = Promise.resolve().then(async () => {
      const started = performance.now();
      const timer = setTimeout(
        () => closing.abort(new RuntimeError("RUNTIME_SHUTDOWN_DEADLINE")),
        identity.shutdownGraceMs,
      );
      let failed = false;
      try {
        await observeUntil(
          track("server-close", () => app.close()),
          closing.signal,
        );
        if (pending.size > 0 || requests.size > 0 || handlers.size > 0)
          failed = true;
      } catch (error) {
        failed = true;
        app.log.error(
          { event: "runtime.shutdown.failed", reason: errorName(error) },
          "runtime shutdown failed",
        );
      } finally {
        clearTimeout(timer);
      }
      const unfinished = [
        ...pending,
        ...(requests.size > 0 ? ["requests"] : []),
        ...(handlers.size > 0 ? ["handlers"] : []),
      ];
      if (failed) {
        closing.abort(new RuntimeError("RUNTIME_FAIL_STOP"));
        destroy();
      }
      transition("stopped");
      const status = failed ? "fail-stop" : "stopped";
      app.log.info(
        {
          event: "runtime.shutdown",
          signal,
          status,
          pending: unfinished,
          durationMs: performance.now() - started,
        },
        "runtime shutdown finished",
      );
      try { loggerInstance.flush(); } catch { /* Shutdown logging is best effort and must not delay callers. */ }
      const result: RuntimeShutdownResult = { status, pending: unfinished };
      stopped.resolve(result);
      return result;
    });
    transition("draining");
    lifetime.abort(new RuntimeError("RUNTIME_DRAINING"));
    return stopPromise;
  };
  const start = (): Promise<void> => {
    if (phase === "draining" || phase === "stopped") transition("starting");
    if (startPromise !== undefined) return startPromise;
    if (phase !== "starting")
      throw new RuntimeError("RUNTIME_INVALID_TRANSITION");
    startPromise = (async () => {
      const startup = new AbortController();
      const signal = AbortSignal.any([startup.signal, lifetime.signal]);
      const timer = setTimeout(
        () => startup.abort(new RuntimeError("RUNTIME_STARTUP_DEADLINE")),
        health.startupGraceMs,
      );
      try {
        await observeUntil(
          track("startup", async () => {
            signal.throwIfAborted();
            await identity.configure?.(app, signal);
            signal.throwIfAborted();
            if (transportError !== undefined) throw new RuntimeError(`RUNTIME_TRANSPORT_NOT_CONFIGURED:${transportError}`);
            await app.listen({ host: identity.host, port: identity.port });
            signal.throwIfAborted();
            for (const resource of resources) {
              acquired.push(resource);
              await resource.start?.(signal);
              signal.throwIfAborted();
            }
            transition("running");
          }),
          signal,
        );
      } catch (error) {
        await closeRuntime();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();
    return startPromise;
  };
  app.decorate("runtimeController", {
    phase: () => phase,
    whenStopped: stopped.promise,
    transition,
    start,
    closeRuntime,
  });
  app.decorateRequest("correlationContext", null);
  app.decorateRequest("runtimeContext", null);
  app.decorateRequest("runtimeSpan", null);
  app.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    if (phase === "draining" || phase === "stopped") socket.destroy();
  });
  app.server.on("listening", () => {
    if (phase === "draining" || phase === "stopped") destroy();
  });
  app.addHook("onRoute", (route) => {
    const profile = route.config?.runtimeDeadlineProfile;
    if (
      profile !== undefined &&
      !Object.hasOwn(identity.deadlineProfiles ?? {}, profile)
    )
      throw new RuntimeError("RUNTIME_UNKNOWN_DEADLINE_PROFILE");
    const handler = route.handler;
    route.handler = function (request, reply) {
      const work = Promise.resolve().then(() =>
        handler.call(this, request, reply),
      );
      handlers.add(work);
      return work.finally(() => {
        handlers.delete(work);
        if (reply.raw.destroyed) requestCleanup.get(request)?.();
      });
    };
  });
  app.addHook("onRequest", (request, reply, done) => {
    const correlation = createCorrelationContext(request.headers, request.id);
    request.correlationContext = correlation;
    setCorrelationResponseHeaders(reply, correlation);
    let parent = otelContext.active();
    if (correlation.traceparent !== undefined) {
      const [version, traceId, spanId, flags] = correlation.traceparent.split("-");
      if (version === "00" && traceId !== undefined && spanId !== undefined && flags !== undefined)
        parent = trace.setSpanContext(parent, {traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true});
    }
    const method = RUNTIME_HTTP_METHODS.has(request.method) ? request.method : "_OTHER";
    const span = trace.getTracer("coffee-platform.runtime").startSpan(`HTTP ${method}`, {
      kind: SpanKind.SERVER,
      attributes: {"http.request.method": method, "http.route": request.routeOptions.url ?? "unknown"},
    }, parent);
    request.runtimeSpan = span;
    runtimeRequestStarts.set(span, nodePerformance.now());
    const active = trace.setSpan(parent, span);
    let transportIdentity: TransportIdentity | null = null;
    if (identity.transport?.mode === "mtls" && identity.transport.material !== undefined) {
      const socket = request.raw.socket;
      try {
        if (!(socket instanceof TLSSocket) || !socket.authorized) throw new Error("unauthorized TLS peer");
        transportIdentity = verifyTransportPeer(socket.getPeerCertificate(), identity.transport.environment);
      } catch {
        void reply.code(401).send();
        return;
      }
    }
    const isHealth = [
      health.livePath,
      health.readyPath,
      health.metricsPath,
    ].includes(request.routeOptions.url ?? "");
    if (
      !isHealth &&
      (phase !== "running" ||
        requests.size >= (identity.concurrency ?? Infinity))
    ) {
      admissionRejected += 1;
      if (phase === "running" && identity.admissionResponse?.(request, reply) === true) return;
      void reply.code(503).send();
      return;
    }
    const abort = new AbortController();
    if (!isHealth) requests.add(abort);
    const profile = request.routeOptions.config.runtimeDeadlineProfile;
    const budget = isHealth
      ? null
      : profile === undefined
        ? deadlineMs
        : (identity.deadlineProfiles?.[profile] ?? null);
    let accepted = false;
    const cleanup = (): void => {
      if (!reply.raw.writableFinished) completeRuntimeRequestTelemetry(request, reply.statusCode);
      clearTimeout(timer);
      requests.delete(abort);
      requestCleanup.delete(request);
      request.raw.removeListener("aborted", inputClosed);
      request.raw.removeListener("close", inputClosed);
      reply.raw.removeListener("close", responseClosed);
      reply.raw.removeListener("finish", cleanup);
    };
    const inputClosed = (): void => {
      if (!request.raw.complete && !accepted) {
        abort.abort(new RuntimeError("RUNTIME_CLIENT_DISCONNECTED"));
        cleanup();
      }
    };
    const responseClosed = (): void => {
      if (reply.raw.writableFinished) cleanup();
      else if (!accepted) {
        abort.abort(new RuntimeError("RUNTIME_CLIENT_DISCONNECTED"));
        cleanup();
      }
    };
    const timer =
      budget === null
        ? undefined
        : setTimeout(() => {
            abort.abort(new RuntimeError("RUNTIME_REQUEST_DEADLINE"));
            reply.raw.destroy();
            cleanup();
          }, budget);
    timer?.unref();
    request.runtimeContext = {
      ...correlation,
      signal: abort.signal,
      transportIdentity,
      deadlineUtc:
        budget === null
          ? null
          : Temporal.Now.instant().add({ milliseconds: budget }).toString(),
      acceptDurable: () => {
        accepted = true;
      },
    };
    requestCleanup.set(request, cleanup);
    request.raw.once("aborted", inputClosed);
    request.raw.once("close", inputClosed);
    reply.raw.once("close", responseClosed);
    reply.raw.once("finish", cleanup);
    otelContext.with(active, done);
  });
  app.addHook("onError", (request, _reply, error, done) => {
    request.runtimeSpan?.setAttribute("error.type", errorName(error));
    request.runtimeSpan?.setStatus({code: SpanStatusCode.ERROR});
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    completeRuntimeRequestTelemetry(request, reply.statusCode);
    done();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.raw.destroyed) requestCleanup.get(request)?.();
    return payload;
  });
  const checkDependency = (
    dependency: RuntimeReadinessCheck,
  ): Promise<boolean> => {
    const existing = runningChecks.get(dependency.name);
    if (existing !== undefined) return existing;
    const timeout = new AbortController();
    const signal = AbortSignal.any([timeout.signal, lifetime.signal]);
    const timer = setTimeout(
      () => timeout.abort(new RuntimeError("RUNTIME_READINESS_DEADLINE")),
      health.timeoutMs,
    );
    const work = track(`readiness:${dependency.name}`, () =>
      dependency.check(signal),
    );
    const result = observeUntil(work, signal)
      .then(
        (value) => {
          if (value === false)
            app.log.warn(
              {
                event: "runtime.readiness.failed",
                dependency: dependency.name,
                reason: "NotReady",
              },
              "runtime readiness failed",
            );
          return value !== false;
        },
        (error: unknown) => {
          app.log.warn(
            {
              event: "runtime.readiness.failed",
              dependency: dependency.name,
              reason: errorName(error),
              ...(error instanceof RuntimeError ? {code: error.code} : {}),
            },
            "runtime readiness failed",
          );
          return false;
        },
      )
      .finally(() => clearTimeout(timer));
    runningChecks.set(dependency.name, result);
    // Не создавать новые blackhole promises на каждом probe; разрешить новый check только после settlement.
    void work.then(
      () => runningChecks.delete(dependency.name),
      () => runningChecks.delete(dependency.name),
    );
    return result;
  };
  app.get(
    health.livePath,
    { schema: { response: { 200: HEALTH_RESPONSE_SCHEMA } } },
    async () => ({ status: "live", runtime: identity.name }),
  );
  app.get(
    health.readyPath,
    {
      schema: {
        response: { 200: HEALTH_RESPONSE_SCHEMA, 503: HEALTH_RESPONSE_SCHEMA },
      },
    },
    async (_request, reply) => {
      let ready =
        phase === "running" &&
        app.server.listening &&
        (identity.requiredDependencies ?? []).every((name) =>
          checks.some((check) => check.name === name),
        );
      if (ready)
        ready =
          (await Promise.all(checks.map(checkDependency))).every(Boolean) &&
          phase === "running" &&
          app.server.listening;
      setRuntimeReadiness(ready);
      return ready
        ? { status: "ready", runtime: identity.name }
        : reply.code(503).send({
            status:
              phase === "draining" || phase === "stopped"
                ? "stopping"
                : "not-ready",
            runtime: identity.name,
          });
    },
  );
  app.get(
    health.metricsPath,
    { schema: { response: { 200: { type: "string" } } } },
    async (_request, reply) =>
      reply
        .type("text/plain; version=0.0.4")
        .send(
          [
            "# platform foundation",
            `runtime_admission_rejected_total ${admissionRejected}`,
            `telemetry_log_records_dropped_total ${logRecordsDropped()}`,
            `telemetry_records_dropped_total ${telemetryDiagnostics().dropped}`,
            `telemetry_export_failures_total ${telemetryDiagnostics().exportFailures}`,
            `telemetry_serialization_rejections_total ${telemetryDiagnostics().serializationRejected}`,
            `telemetry_queue_overflows_total ${telemetryDiagnostics().queueOverflows}`,
            `telemetry_shutdown_losses_total ${telemetryDiagnostics().shutdownLoss}`,
            ...runtimeMetrics(),
            ...(identity.metrics?.() ?? []),
            "",
          ].join("\n"),
        ),
  );
  app.addHook("preClose", async () => {
    if (phase !== "stopped") transition("draining");
    lifetime.abort(new RuntimeError("RUNTIME_DRAINING"));
  });
  app.addHook("onClose", async () => {
    eventLoopDelay.disable();
    gcObserver.disconnect();
    let stopFailed = false;
    for (const resource of [...acquired].reverse()) {
      closing.signal.throwIfAborted();
      try {
        await observeUntil(
          track(`stop:${resource.name}`, () => resource.stop(closing.signal)),
          closing.signal,
        );
      } catch (error) {
        stopFailed = true;
        app.log.error(
          {
            event: "runtime.stop.failed",
            resource: resource.name,
            reason: errorName(error),
          },
          "resource stop failed",
        );
      }
    }
    if (stopFailed) throw new RuntimeError("RUNTIME_RESOURCE_STOP_FAILED");
  });
  return app;
}

export async function startRuntime(
  identity: RuntimeIdentity,
): Promise<FastifyInstance> {
  const app = await createRuntime(identity);
  const terminate = (): void => {
    void app.runtimeController.closeRuntime("SIGTERM");
  };
  const interrupt = (): void => {
    void app.runtimeController.closeRuntime("SIGINT");
  };
  const removeSignals = (): void => {
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGINT", interrupt);
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", interrupt);
  void app.runtimeController.whenStopped.then((result) => {
    removeSignals();
    if (result.status === "fail-stop") process.exit(1);
  });
  try {
    await app.runtimeController.start();
  } catch (error) {
    removeSignals();
    await app.runtimeController.closeRuntime();
    throw error;
  }
  return app;
}

export function configuredRuntimeIdentity(
  config: PlatformConfig,
  name: RuntimeName,
  composition: RuntimeComposition = {},
): RuntimeIdentity {
  const runtime = config.services[name];
  const shutdownGraceMs = runtime.realtime?.shutdownGraceMs ?? config.platform["shutdownGraceMs"];
  const bodyLimitBytes = config.platform["bodyLimitBytes"];
  if (typeof shutdownGraceMs !== "number" || typeof bodyLimitBytes !== "number")
    throw new RuntimeError("RUNTIME_INVALID_PLATFORM_CONFIG");
  return {
    ...composition,
    name,
    host: runtime.listen.host,
    port: runtime.listen.port,
    shutdownGraceMs,
    health: runtime.health,
    deadlineMs: runtime.deadlineMs,
    deadlineProfiles: runtime.deadlineProfiles,
    concurrency: runtime.concurrency,
    bodyLimitBytes,
    telemetryLogRecordBytes: config.telemetry.producer.maxRecordBytes,
    telemetryLogQueueCapacity: config.telemetry.producer.queueCapacity,
    telemetryLogDiagnosticIntervalMs: config.telemetry.producer.diagnosticIntervalMs,
    releaseDigest: config.telemetry.releaseDigest,
    requiredDependencies: [
      ...(runtime.database === null ? [] : ["database"]),
      ...(runtime.kafka.producers.length === 0 &&
      runtime.kafka.consumers.length === 0
        ? []
        : ["kafka"]),
    ],
  };
}

export async function startConfiguredRuntime(
  name: RuntimeName,
  composition: RuntimeComposition = {},
): Promise<FastifyInstance> {
  for (const key of Object.keys(process.env)) {
    if (
      (key.startsWith("COFFEE_") || key.startsWith("SOPS_")) &&
      key !== "COFFEE_CONFIG_FILE" &&
      key !== "COFFEE_RUNTIME_SECRETS_FILE"
    )
      throw new Error(
        `${key}: runtime accepts only configuration locator variables`,
      );
  }
  const configPath = process.env["COFFEE_CONFIG_FILE"];
  const secretsPath = process.env["COFFEE_RUNTIME_SECRETS_FILE"];
  if (!configPath) throw new Error("COFFEE_CONFIG_FILE: locator is required");
  if (!secretsPath)
    throw new Error("COFFEE_RUNTIME_SECRETS_FILE: locator is required");
  const config = await loadPlatformConfig(configPath, (text) =>
    parseYaml(text, { json: true }),
  );
  const secretStat = await stat(secretsPath);
  if ((secretStat.mode & 0o777) !== 0o400)
    throw new Error(`${secretsPath}: scoped secrets mode must be 0400`);
  const secretDocument = parseYaml(await readFile(secretsPath, "utf8"), {
    json: true,
  });
  assertScopedSecrets(
    secretDocument,
    name,
    config.environment,
    config.services[name].secretRefs,
  );
  const service = config.services[name];
  const shutdownGraceMs = service.realtime?.shutdownGraceMs ?? config.platform["shutdownGraceMs"];
  if (typeof shutdownGraceMs !== "number")
    throw new RuntimeError("RUNTIME_INVALID_PLATFORM_CONFIG");
  let database: Database | undefined;
  let kafka: KafkaRuntime | undefined;
  let transport: RuntimeTransport | undefined;
  try {
    transport = transportMaterial(secretDocument as ScopedSecretDocument, service.secretRefs, service.optionalSecretRefs, config.environment, name, service.transportMode, service.transportMode === "public-tls" ? publicHostname(config) : undefined);
    if (service.database !== null) {
      if (service.dbPool === null)
        throw new RuntimeError("RUNTIME_DATABASE_CONFIG_MISMATCH");
      const credential = ownDatabaseCredential(
        secretDocument as ScopedSecretDocument,
        name,
        service.secretRefs,
      );
      database = createDatabase({
        owner: name,
        database: service.database,
        allowedDatabase: service.database,
        host: config.postgres.host,
        port: config.postgres.port,
        user: credential.username,
        password: credential.password,
        ssl: config.postgres.sslMode === "prefer" ? "prefer" : true,
        pool: service.dbPool,
        shutdownGraceMs,
      });
    }
    if (
      service.kafka.producers.length > 0 ||
      service.kafka.consumers.length > 0
    ) {
      kafka = createKafkaRuntime({
        runtime: name,
        config: config.kafka,
        service: service.kafka,
        credentials: ownKafkaCredential(
          secretDocument as ScopedSecretDocument,
          service.secretRefs,
        ),
      });
    }
    const exporterToken = secretAt(secretDocument as ScopedSecretDocument, "telemetry.exporterToken");
    if (typeof exporterToken !== "string" || exporterToken.length === 0 || !service.secretRefs.includes("telemetry.exporterToken"))
      throw new RuntimeError("RUNTIME_TELEMETRY_SECRET_SCOPE");
    const telemetry = createTelemetryResource({...config.telemetry, environment: config.environment}, name, exporterToken, () => composition.metrics?.() ?? []);
    const ownedComposition = appendOwnedComposition(composition, database, kafka, {
      config,
      secrets: (secretDocument as ScopedSecretDocument).secrets,
    });
    const telemetryComposition: RuntimeComposition = {
      ...ownedComposition,
      resources: [telemetry, ...(ownedComposition.resources ?? [])],
    };
    return await startRuntime(
      {
        ...configuredRuntimeIdentity(config, name, telemetryComposition),
        transport,
      },
    );
  } catch (error) {
    kafka?.resource.destroy();
    database?.resource.destroy();
    throw error;
  }
}

export function assertScopedSecrets(
  value: unknown,
  runtime: RuntimeName,
  environment: string,
  refs: readonly string[],
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("scoped secrets: object is required");
  const document = value as Record<string, unknown>;
  const keys = Object.keys(document).sort((left, right) =>
    left.localeCompare(right),
  );
  if (keys.join(",") !== "environment,runtime,schemaVersion,secrets")
    throw new Error("scoped secrets: unknown or missing metadata key");
  if (
    document["schemaVersion"] !== 1 ||
    document["runtime"] !== runtime ||
    document["environment"] !== environment
  ) {
    throw new Error("scoped secrets: runtime or environment identity mismatch");
  }
  const secrets = document["secrets"];
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets))
    throw new Error("scoped secrets: secrets object is required");
  for (const ref of refs) {
    let current: unknown = secrets;
    for (const segment of ref.split(".")) {
      current =
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
          ? (current as Record<string, unknown>)[segment]
          : undefined;
    }
    if (current === undefined)
      throw new Error(`scoped secrets: required ref ${ref} is missing`);
  }
}
