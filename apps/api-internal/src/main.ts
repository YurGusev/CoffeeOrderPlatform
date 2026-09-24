import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredAromaGatewayOrigin, configuredAromaGatewayTls, configuredCatalogOrigin, configuredCatalogTls, configuredCustomerOrigin, configuredCustomerTls, createConfiguredInternalAdapters, registerInternalRoutes} from "./index.js";

let customerClient: HttpClient | undefined;
let catalogClient: HttpClient | undefined;
let aromaGatewayClient: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-internal runtime context is required");
    customerClient = createHttpClient({origin: configuredCustomerOrigin(context), tls: configuredCustomerTls(context)});
    catalogClient = createHttpClient({origin: configuredCatalogOrigin(context), tls: configuredCatalogTls(context)});
    aromaGatewayClient = createHttpClient({origin: configuredAromaGatewayOrigin(context), tls: configuredAromaGatewayTls(context)});
    registerInternalRoutes(app, createConfiguredInternalAdapters(context, customerClient, aromaGatewayClient, catalogClient));
  },
  resources: [{
      name: "internal-http-clients",
    start: () => { if (customerClient === undefined || catalogClient === undefined || aromaGatewayClient === undefined) throw new Error("api-internal clients are not configured"); },
    stop: async () => { await customerClient?.close(); await catalogClient?.close(); await aromaGatewayClient?.close(); },
    destroy: () => { void customerClient?.close(); void catalogClient?.close(); void aromaGatewayClient?.close(); },
  }],
};

await startConfiguredRuntime("api-internal", composition);
