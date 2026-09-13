import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredAromaGatewayOrigin, configuredAromaGatewayTls, configuredCustomerOrigin, configuredCustomerTls, createConfiguredInternalAdapters, registerInternalRoutes} from "./index.js";

let client: HttpClient | undefined;
let aromaGatewayClient: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-internal runtime context is required");
    client = createHttpClient({origin: configuredCustomerOrigin(context), tls: configuredCustomerTls(context)});
    aromaGatewayClient = createHttpClient({origin: configuredAromaGatewayOrigin(context), tls: configuredAromaGatewayTls(context)});
    registerInternalRoutes(app, createConfiguredInternalAdapters(context, client, aromaGatewayClient));
  },
  resources: [{
      name: "internal-http-clients",
    start: () => { if (client === undefined) throw new Error("api-internal customer client is not configured"); },
      stop: async () => { await client?.close(); await aromaGatewayClient?.close(); },
      destroy: () => { void client?.close(); void aromaGatewayClient?.close(); },
  }],
};

await startConfiguredRuntime("api-internal", composition);
