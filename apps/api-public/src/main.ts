import {createHttpClient, type HttpClient} from "@coffee-platform/platform-http";
import {startConfiguredRuntime, type RuntimeComposition} from "@coffee-platform/runtime";
import {configuredCatalogOrigin, configuredCatalogTls, configuredCustomerOrigin, configuredCustomerTls, configuredPricingOrigin, configuredPricingTls, createConfiguredPublicAdapters, registerPublicRoutes} from "./index.js";

let customerClient: HttpClient | undefined;
let catalogClient: HttpClient | undefined;
let pricingClient: HttpClient | undefined;
const composition: RuntimeComposition = {
  configure: (app, _signal, _database, _kafka, context) => {
    if (context === undefined) throw new Error("api-public runtime context is required");
    customerClient = createHttpClient({origin: configuredCustomerOrigin(context), tls: configuredCustomerTls(context)});
    catalogClient = createHttpClient({origin: configuredCatalogOrigin(context), tls: configuredCatalogTls(context)});
    pricingClient = createHttpClient({origin: configuredPricingOrigin(context), tls: configuredPricingTls(context)});
    registerPublicRoutes(app, createConfiguredPublicAdapters(context, customerClient, catalogClient, pricingClient));
  },
  resources: [{
    name: "public-http-clients",
    start: () => { if (customerClient === undefined || catalogClient === undefined || pricingClient === undefined) throw new Error("api-public clients are not configured"); },
    stop: async () => { await customerClient?.close(); await catalogClient?.close(); await pricingClient?.close(); },
    destroy: () => { void customerClient?.close(); void catalogClient?.close(); void pricingClient?.close(); },
  }],
};

await startConfiguredRuntime("api-public", composition);
