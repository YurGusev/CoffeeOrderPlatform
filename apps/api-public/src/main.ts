import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredCatalogOrigin, configuredCatalogTls, configuredCustomerOrigin, configuredCustomerTls, createConfiguredPublicAdapters, registerPublicRoutes} from "./index.js";

let customerClient: HttpClient | undefined;
let catalogClient: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-public runtime context is required");
    customerClient = createHttpClient({origin: configuredCustomerOrigin(context), tls: configuredCustomerTls(context)});
    catalogClient = createHttpClient({origin: configuredCatalogOrigin(context), tls: configuredCatalogTls(context)});
    registerPublicRoutes(app, createConfiguredPublicAdapters(context, customerClient, catalogClient));
  },
  resources: [{
    name: "public-http-clients",
    start: () => { if (customerClient === undefined || catalogClient === undefined) throw new Error("api-public clients are not configured"); },
    stop: async () => { await customerClient?.close(); await catalogClient?.close(); },
    destroy: () => { void customerClient?.close(); void catalogClient?.close(); },
  }],
};

await startConfiguredRuntime("api-public", composition);
