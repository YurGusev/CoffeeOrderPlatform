import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredCustomerOrigin, createConfiguredPublicAdapters, registerPublicRoutes} from "./index.js";

let client: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-public runtime context is required");
    client = createHttpClient({origin: configuredCustomerOrigin(context)});
    registerPublicRoutes(app, createConfiguredPublicAdapters(context, client));
  },
  resources: [{
    name: "customer-http",
    start: () => { if (client === undefined) throw new Error("api-public customer client is not configured"); },
    stop: async () => { await client?.close(); },
    destroy: () => { void client?.close(); },
  }],
};

await startConfiguredRuntime("api-public", composition);
