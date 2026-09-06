import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredCustomerOrigin, configuredCustomerTls, createConfiguredInternalAdapters, registerInternalRoutes} from "./index.js";

let client: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-internal runtime context is required");
    client = createHttpClient({origin: configuredCustomerOrigin(context), tls: configuredCustomerTls(context)});
    registerInternalRoutes(app, createConfiguredInternalAdapters(context, client));
  },
  resources: [{
    name: "customer-http",
    start: () => { if (client === undefined) throw new Error("api-internal customer client is not configured"); },
    stop: async () => { await client?.close(); },
    destroy: () => { void client?.close(); },
  }],
};

await startConfiguredRuntime("api-internal", composition);
