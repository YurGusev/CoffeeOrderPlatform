import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createHttpClient,
  type HttpClient,
} from "@coffee-platform/platform-http";
import type { RuntimeComposition } from "@coffee-platform/runtime";
import { DatabaseTransactionError } from "@coffee-platform/database";
import { parseServiceTransportMaterial } from "@coffee-platform/security";
import { createSqlOutboxStore } from "@coffee-platform/outbox";
import { AromaObserverGatewayClient } from "./infrastructure/gateway-client.js";
import { createAromaObservationStore } from "./infrastructure/observation-store.js";
import { AromaObserverTelemetry } from "./telemetry/index.js";

/** Scoped transport и bounded supervisor; network остаётся вне owner transaction. */
export function createAromaObserverComposition(): RuntimeComposition {
  let alive = false,
    recovered = false,
    workFailed = false,
    relayFailed = false;
  let controller: AbortController | undefined;
  let loop: Promise<void> | undefined;
  let http: HttpClient | undefined;
  let cycle: ((signal: AbortSignal) => Promise<void>) | undefined;
  let pollIntervalMs = 0;
  const telemetry = new AromaObserverTelemetry();
  return {
    readinessChecks: [
      {
        name: "aroma-observation-supervisor",
        check: () => alive && recovered && !workFailed && !relayFailed,
      },
      {
        name: "aroma-observation-internal-api",
        check: async (signal) => {
          if (http === undefined || signal.aborted) return false;
          const response = await http.fetch("/health/ready", {
            method: "GET",
            signal,
            redirect: "error",
          });
          void response.body?.cancel().catch(() => undefined);
          return response.status === 200;
        },
      },
    ],
    configure: (app, processSignal, database, kafka, context) => {
      if (
        database === undefined ||
        kafka === undefined ||
        context === undefined
      )
        throw new Error("AROMA_OBSERVATION_DEPENDENCIES_MISSING");
      const service = context.config.services["aroma-observer"];
      const config = service.aromaObservation;
      if (config === undefined)
        throw new Error("AROMA_OBSERVATION_CONFIG_MISSING");
      const { maxResponseBytes, ...storeConfig } = config;
      const target = service.outbound.find((entry) =>
        entry.startsWith("api-internal:"),
      );
      if (target === undefined)
        throw new Error("AROMA_INTERNAL_API_ORIGIN_MISSING");
      const security = context.secrets["security"];
      const transports =
        security !== null &&
        typeof security === "object" &&
        !Array.isArray(security)
          ? (security as Record<string, unknown>)["serviceTransportKeys"]
          : undefined;
      const secret =
        transports !== null &&
        typeof transports === "object" &&
        !Array.isArray(transports)
          ? (transports as Record<string, unknown>)["aroma-observer"]
          : undefined;
      const material = parseServiceTransportMaterial(
        secret,
        context.config.environment,
        "aroma-observer",
      );
      http = createHttpClient({
        origin: `https://${target}`,
        tls: {
          material,
          targetEnvironment: context.config.environment,
          targetRuntime: "api-internal",
        },
        connections: 2,
        pipelining: 1,
      });
      const gateway = new AromaObserverGatewayClient(http, {
        deadlineMs: service.deadlineMs!,
        maxResponseBytes,
      });
      const store = createAromaObservationStore(
        database,
        { ownerInstanceId: randomUUID(), ...storeConfig },
        telemetry,
      );
      const outbox = createSqlOutboxStore(database, {
        schema: "orders",
        envelopeBytes: true,
        topics: service.kafka.producers,
      });
      pollIntervalMs = config.pollIntervalMs;
      controller = new AbortController();
      const owned = controller;
      if (processSignal.aborted) owned.abort(processSignal.reason);
      else
        processSignal.addEventListener(
          "abort",
          () => owned.abort(processSignal.reason),
          { once: true },
        );
      cycle = async (signal) => {
        try {
          if (!recovered) {
            await store.recover(signal);
            recovered = true;
          }
          const result = await store.runOnce(gateway, signal);
          if (result !== "idle") workFailed = result === "failed";
        } catch (error) {
          workFailed = true;
          if (!signal.aborted)
            app.log.error({
              event: "aroma.observation.failed",
              reason: error instanceof Error ? error.name : "UNKNOWN",
              ...(error instanceof DatabaseTransactionError
                ? {
                    code: error.code,
                    ...(error.sqlState !== undefined &&
                    /^[0-9A-Z]{5}$/.test(error.sqlState)
                      ? { sqlState: error.sqlState }
                      : {}),
                    ...(error.previousCode !== undefined
                      ? { previousCode: error.previousCode }
                      : {}),
                  }
                : {}),
            });
        }
        // Relay уже committed фактов независим от нового provider failure.
        try {
          await kafka.relay(outbox, database, signal);
          relayFailed = false;
        } catch (error) {
          relayFailed = true;
          if (!signal.aborted)
            app.log.error({
              event: "aroma.observation.relay_failed",
              reason: error instanceof Error ? error.name : "UNKNOWN",
            });
        }
      };
    },
    resources: [
      {
        name: "aroma-observation-supervisor",
        start: () => {
          if (controller === undefined || cycle === undefined)
            throw new Error("AROMA_OBSERVATION_NOT_CONFIGURED");
          const owned = controller;
          const run = cycle;
          alive = true;
          loop = (async () => {
            try {
              while (!owned.signal.aborted) {
                await run(owned.signal);
                try {
                  await sleep(pollIntervalMs, undefined, {
                    signal: owned.signal,
                  });
                } catch (error) {
                  if (!owned.signal.aborted) throw error;
                }
              }
            } finally {
              alive = false;
            }
          })();
        },
        stop: async () => {
          alive = false;
          controller?.abort();
          try {
            await loop;
          } finally {
            await http?.close();
          }
        },
        destroy: () => {
          alive = false;
          controller?.abort();
          void http?.close();
        },
      },
    ],
    metrics: () => [
      ...telemetry.render(),
      "# TYPE coffee_aroma_observation_ready gauge",
      `coffee_aroma_observation_ready ${alive && recovered && !workFailed && !relayFailed ? 1 : 0}`,
    ],
  };
}
