export type { PricingQuoteCreateRequest, PricingQuoteResponse } from '@coffee-platform/generated-client-v1';
export type { PricingQuoteVerifyRequest, PricingQuoteVerificationResponse } from '@coffee-platform/generated-internal-v1';

export const contractPackage = {
  id: '@coffee-platform/contracts-pricing-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml'],
    schemas: 'contracts/schemas',
  },
} as const;
