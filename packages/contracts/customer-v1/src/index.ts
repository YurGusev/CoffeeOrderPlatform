export const contractPackage = {
  id: '@coffee-platform/contracts-customer-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml'],
    schemas: 'contracts/schemas',
  },
} as const;
