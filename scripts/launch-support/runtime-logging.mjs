export const OBSERVABILITY_TARGETS = [
  "edge-nginx",
  "edge-gateway",
  "api-public",
  "api-internal",
  "customer-service",
  "catalog-service",
  "catalog-supplier-sync",
  "catalog-activation-worker",
  "pricing-service",
  "orders-service",
  "orders-aroma-preparation",
  "aroma-observer",
  "aroma-convergence",
  "aroma-gateway",
  "realtime-gateway",
];
export const LOGGED_SERVICES = [...OBSERVABILITY_TARGETS, "kafka"];

export function createRuntimeLoggingOverride({ config } = {}) {
  const logging = createDockerLogging(config);
  return {
    services: Object.fromEntries(
      LOGGED_SERVICES.map((service) => [service, { logging }]),
    ),
  };
}

export function createDockerLogging(config) {
  return {
    driver: "json-file",
    options: {
      "max-size": `${config.telemetry.logging.maxSizeMiB}m`,
      "max-file": String(config.telemetry.logging.maxFiles),
      mode: "non-blocking",
      "max-buffer-size": String(
        config.telemetry.producer.maxRecordBytes *
          config.telemetry.producer.queueCapacity,
      ),
    },
  };
}
