import { readFile, stat } from "node:fs/promises";
import {
  loadPlatformConfig,
  type HealthConfig,
  type RuntimeName,
} from "@coffee-platform/config";
import {
  createCorrelationContext,
  isTraceparent,
  withCorrelationFields,
  type CorrelationContext,
} from "@coffee-platform/observability";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { load as parseYaml } from "js-yaml";

export type RuntimeReadinessCheck = Readonly<{
  name: string;
  check: (signal: AbortSignal) => Promise<boolean | void> | boolean | void;
}>;

export type RuntimeShutdownHook = (
  signal: NodeJS.Signals,
) => Promise<void> | void;

export type RuntimeIdentity = Readonly<{
  name: string;
  host: string;
  port: number;
  shutdownGraceMs: number;
  health?: HealthConfig;
  readinessChecks?: readonly RuntimeReadinessCheck[];
  shutdownHooks?: readonly RuntimeShutdownHook[];
}>;

export type RuntimePhase = "starting" | "ready" | "stopping" | "stopped";

export type RuntimeController = Readonly<{
  phase: () => RuntimePhase;
  markStarting: () => void;
  markReady: () => void;
  markStopping: () => void;
  markNotReady: () => void;
}>;

declare module "fastify" {
  interface FastifyRequest {
    correlationContext: CorrelationContext | null;
  }

  interface FastifyInstance {
    runtimeController: RuntimeController;
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

const METRICS_RESPONSE_SCHEMA = { type: "string" } as const;

function errorName(value: unknown): string {
  return value instanceof Error ? value.name : "UnknownError";
}

function requestHeaders(
  request: FastifyRequest,
): Record<string, string | readonly string[] | undefined> {
  return request.headers as Record<
    string,
    string | readonly string[] | undefined
  >;
}

function healthPath(path: string): string {
  if (!path.startsWith("/"))
    throw new RangeError("health path must be absolute");
  return path;
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${field} must be a positive integer`);
}

function runtimeHealth(identity: RuntimeIdentity): HealthConfig {
  const health = identity.health ?? DEFAULT_HEALTH;
  healthPath(health.livePath);
  healthPath(health.readyPath);
  healthPath(health.metricsPath);
  positiveInteger(health.timeoutMs, "health.timeoutMs");
  positiveInteger(identity.shutdownGraceMs, "shutdownGraceMs");
  return health;
}

function setCorrelationResponseHeaders(
  reply: FastifyReply,
  context: CorrelationContext,
): void {
  reply.header("x-correlation-id", context.correlationId);
  if (context.traceparent !== undefined)
    reply.header("traceparent", context.traceparent);
}

function requestContext(request: FastifyRequest): CorrelationContext {
  const context = createCorrelationContext(requestHeaders(request), request.id);
  request.correlationContext = context;
  return context;
}

export async function createRuntime(
  identity: RuntimeIdentity,
): Promise<FastifyInstance> {
  const health = runtimeHealth(identity);
  const readinessChecks = identity.readinessChecks ?? [];
  let currentPhase: RuntimePhase = "ready";
  let explicitlyNotReady = false;

  const controller: RuntimeController = {
    phase: () => currentPhase,
    markStarting: () => {
      currentPhase = "starting";
      explicitlyNotReady = true;
    },
    markReady: () => {
      currentPhase = "ready";
      explicitlyNotReady = false;
    },
    markStopping: () => {
      currentPhase = "stopping";
      explicitlyNotReady = true;
    },
    markNotReady: () => {
      explicitlyNotReady = true;
    },
  };

  const app = Fastify({
    logger: {
      base: { runtime: identity.name },
      serializers: {
        req: (request: FastifyRequest) => {
          const context = request.correlationContext;
          const incomingTraceparent = request.headers["traceparent"];
          const traceparent =
            context?.traceparent ??
            (typeof incomingTraceparent === "string" &&
            isTraceparent(incomingTraceparent)
              ? incomingTraceparent
              : undefined);
          return {
            method: request.method,
            url: request.url,
            correlationId: context?.correlationId ?? request.id,
            ...(traceparent === undefined ? {} : { traceparent }),
          };
        },
      },
    },
    genReqId: (request) =>
      createCorrelationContext(
        request.headers as Record<string, string | string[] | undefined>,
      ).correlationId,
  });
  app.decorate("runtimeController", controller);
  app.decorateRequest("correlationContext", null);

  app.addHook("onRequest", (request, reply, done) => {
    const context = requestContext(request);
    setCorrelationResponseHeaders(reply, context);
    request.log = request.log.child(withCorrelationFields(context));
    done();
  });

  app.get(
    healthPath(health.livePath),
    {
      schema: { response: { 200: HEALTH_RESPONSE_SCHEMA } },
    },
    async () => ({ status: "live", runtime: identity.name }),
  );

  app.get(
    healthPath(health.readyPath),
    {
      schema: {
        response: { 200: HEALTH_RESPONSE_SCHEMA, 503: HEALTH_RESPONSE_SCHEMA },
      },
    },
    async (request, reply) => {
      const context = request.correlationContext;
      if (context !== null) setCorrelationResponseHeaders(reply, context);
      if (currentPhase === "stopping" || currentPhase === "stopped") {
        return reply
          .code(503)
          .send({ status: "stopping", runtime: identity.name });
      }
      if (explicitlyNotReady)
        return reply
          .code(503)
          .send({ status: "not-ready", runtime: identity.name });

      const checks = await Promise.all(
        readinessChecks.map(async (dependency) => {
          try {
            const result = await dependency.check(
              AbortSignal.timeout(health.timeoutMs),
            );
            return result !== false;
          } catch (error) {
            request.log.warn(
              { dependency: dependency.name, reason: errorName(error) },
              "runtime readiness check failed",
            );
            return false;
          }
        }),
      );
      const ready = checks.every(Boolean);
      return ready
        ? { status: "ready", runtime: identity.name }
        : reply.code(503).send({ status: "not-ready", runtime: identity.name });
    },
  );

  app.get(
    healthPath(health.metricsPath),
    {
      schema: { response: { 200: METRICS_RESPONSE_SCHEMA } },
    },
    async (_request, reply) =>
      reply.type("text/plain; version=0.0.4").send("# platform foundation\n"),
  );

  app.addHook("onClose", async () => {
    currentPhase = "stopped";
    explicitlyNotReady = true;
  });
  return app;
}

export function createShutdownController(
  app: FastifyInstance,
  identity: RuntimeIdentity,
): Readonly<{
  stop: (signal: NodeJS.Signals) => Promise<void>;
}> {
  positiveInteger(identity.shutdownGraceMs, "shutdownGraceMs");
  let stopPromise: Promise<void> | undefined;
  return {
    stop: (signal) => {
      if (stopPromise !== undefined) return stopPromise;
      app.runtimeController.markStopping();
      stopPromise = (async () => {
        app.log.info({ signal }, "runtime shutdown requested");
        const timeout = AbortSignal.timeout(identity.shutdownGraceMs);
        const closeRuntime = async (): Promise<void> => {
          await app.close();
          for (const hook of identity.shutdownHooks ?? []) await hook(signal);
        };
        try {
          await Promise.race([
            closeRuntime(),
            new Promise<never>((_resolve, reject) =>
              timeout.addEventListener("abort", () => reject(timeout.reason), {
                once: true,
              }),
            ),
          ]);
          app.log.info({ signal }, "runtime shutdown complete");
        } catch (error) {
          app.log.error(
            { signal, reason: errorName(error) },
            "runtime shutdown exceeded grace period",
          );
          throw error;
        }
      })();
      return stopPromise;
    },
  };
}

export async function startRuntime(identity: RuntimeIdentity): Promise<void> {
  const app = await createRuntime(identity);
  app.runtimeController.markStarting();
  const shutdown = createShutdownController(app, identity);
  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown.stop(signal).catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
  process.once("SIGINT", () => handleSignal("SIGINT"));
  try {
    await app.listen({ host: identity.host, port: identity.port });
    app.runtimeController.markReady();
  } catch (error) {
    app.log.error({ reason: errorName(error) }, "runtime listener failed");
    throw error;
  }
}

export async function startConfiguredRuntime(name: RuntimeName): Promise<void> {
  for (const key of Object.keys(process.env)) {
    if (
      (key.startsWith("COFFEE_") || key.startsWith("SOPS_")) &&
      key !== "COFFEE_CONFIG_FILE" &&
      key !== "COFFEE_RUNTIME_SECRETS_FILE"
    ) {
      throw new Error(
        `${key}: runtime accepts only configuration locator variables`,
      );
    }
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
  const runtime = config.services[name];
  const secretDocument = parseYaml(await readFile(secretsPath, "utf8"), {
    json: true,
  });
  assertScopedSecrets(
    secretDocument,
    name,
    config.environment,
    runtime.secretRefs,
  );
  const shutdownGraceMs = config.platform["shutdownGraceMs"];
  if (
    typeof shutdownGraceMs !== "number" ||
    !Number.isSafeInteger(shutdownGraceMs) ||
    shutdownGraceMs <= 0
  ) {
    throw new Error(
      "config.platform.shutdownGraceMs: positive integer is required",
    );
  }
  await startRuntime({
    name,
    host: runtime.listen.host,
    port: runtime.listen.port,
    shutdownGraceMs,
    health: runtime.health,
  });
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
