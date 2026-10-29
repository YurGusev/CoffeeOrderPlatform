// Bootstrap fixture only: production main/composition, scheduler, recovery, store,
// typed HTTP client and mTLS transport run unchanged. Local DNS/config replace deployment.
import { mock } from "node:test";
import dns from "node:dns";
import { once } from "node:events";
import { createDatabase } from "../../packages/platform-database/dist/index.js";
import * as runtime from "../../packages/platform-runtime/dist/index.js";
const [input] = await once(process, "message");
const lookup = dns.lookup;
dns.lookup = (host, options, callback) =>
  host === "api-internal"
    ? lookup("127.0.0.1", options, callback)
    : lookup(host, options, callback);
let app;
let database;
let controller;
mock.module("../../packages/platform-runtime/dist/index.js", {
  namedExports: {
    ...runtime,
    startConfiguredRuntime: async (name, composition) => {
      database = createDatabase({ ...input.database, owner: name });
      controller = new AbortController();
      await database.resource.start(controller.signal);
      app = await runtime.createRuntime({
        name,
        host: "127.0.0.1",
        port: 0,
        deadlineMs: 30_000,
        shutdownGraceMs: 5000,
        resources: composition.resources,
        readinessChecks: composition.readinessChecks,
        metrics: composition.metrics,
      });
      await composition.configure(app, controller.signal, database, undefined, {
        config: {
          environment: "development",
          services: {
            [name]: {
              scheduler: { intervalMs: 3_600_000 },
              deadlineMs: 30_000,
              outbound: [`api-internal:${input.apiPort}`],
            },
          },
        },
        secrets: {
          security: {
            serviceTransportKeys: { [name]: JSON.stringify(input.material) },
          },
        },
      });
      await app.runtimeController.start();
      process.send({
        type: "booted",
        pid: process.pid,
        port: app.server.address().port,
      });
    },
  },
});
process.once("SIGTERM", async () => {
  controller?.abort();
  await app?.runtimeController.closeRuntime("SIGTERM");
  await database?.resource.stop(AbortSignal.timeout(5000));
  process.disconnect();
});
await import("../../apps/catalog-supplier-sync/dist/main.js");
