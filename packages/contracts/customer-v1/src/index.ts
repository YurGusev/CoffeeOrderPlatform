export type { CustomerCreateRequest, CustomerResponse, CustomerSearchResponse, CustomerSummary } from '@coffee-platform/generated-client-v1';
export type { CustomerOrderInput } from '@coffee-platform/generated-internal-v1';

export const contractPackage = {
  id: '@coffee-platform/contracts-customer-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml'],
    schemas: 'contracts/schemas',
  },
} as const;
