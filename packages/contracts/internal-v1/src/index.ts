export type * from "@coffee-platform/generated-internal-v1";

export const contractPackage = {
  id: "@coffee-platform/contracts-internal-v1",
  source: {
    manifest: "contracts/manifest.yaml",
    openapi: "contracts/openapi/internal-v1.yaml",
    schemas: "contracts/schemas",
  },
} as const;
