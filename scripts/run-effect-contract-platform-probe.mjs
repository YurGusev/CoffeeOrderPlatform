#!/usr/bin/env node

import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

class AuthorityGroup extends HttpApiGroup.make("authority", { topLevel: true }).add(
  HttpApiEndpoint.get("effectContractPlatformProbe", "/__authority/contract-platform", {
    success: HttpApiSchema.NoContent,
  }),
) {}

class AuthorityApi extends HttpApi.make("coffee-effect-contract-platform-probe")
  .add(AuthorityGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "CoffeeOrderPlatform Effect Contract Platform Probe",
      version: "1.0.0",
    }),
  ) {}

const firstOpenApi = OpenApi.fromApi(AuthorityApi);
const secondOpenApi = OpenApi.fromApi(AuthorityApi);
if (firstOpenApi.openapi !== "3.1.0") {
  throw new Error(`expected generated OpenAPI 3.1.0, got ${firstOpenApi.openapi}`);
}
if (canonical(firstOpenApi) !== canonical(secondOpenApi)) {
  throw new Error("Effect HttpApi OpenAPI output is not deterministic");
}

const AuthorityEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  surface: Schema.Literals(["client-v1", "internal-v1", "events"]),
  contractId: Schema.String,
});
const firstJsonSchema = Schema.toJsonSchemaDocument(AuthorityEnvelope);
const secondJsonSchema = Schema.toJsonSchemaDocument(AuthorityEnvelope);
if (firstJsonSchema.dialect !== "draft-2020-12") {
  throw new Error(`expected JSON Schema draft-2020-12, got ${firstJsonSchema.dialect}`);
}
if (canonical(firstJsonSchema) !== canonical(secondJsonSchema)) {
  throw new Error("Effect Schema JSON Schema output is not deterministic");
}

const encoded = Schema.encodeUnknownSync(AuthorityEnvelope)({
  schemaVersion: 1,
  surface: "client-v1",
  contractId: "authority-probe",
});
if (encoded.contractId !== "authority-probe") {
  throw new Error("Effect Schema encode/decode authority probe failed");
}

console.log(
  JSON.stringify({
    status: "ok",
    sourceAuthority: "effect-schema-httpapi",
    openapi: firstOpenApi.openapi,
    jsonSchema: firstJsonSchema.dialect,
    surfaces: ["client-v1", "internal-v1", "events"],
  }),
);
