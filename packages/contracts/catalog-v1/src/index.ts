export type { CatalogProductSummary, CatalogSearchResponse } from '@coffee-platform/generated-client-v1';
export type { CatalogPricingInput } from '@coffee-platform/generated-internal-v1';

export const contractPackage = {
  id: '@coffee-platform/contracts-catalog-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml'],
    schemas: 'contracts/schemas',
  },
} as const;
