export type { OrderCardResponse, OrderConfirmRequest, OrderDraftCreateRequest, OrderItemPutRequest, ReconciliationRequest } from '@coffee-platform/generated-client-v1';

export const contractPackage = {
  id: '@coffee-platform/contracts-orders-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: ['contracts/openapi/client-v1.yaml', 'contracts/openapi/internal-v1.yaml'],
    schemas: 'contracts/schemas',
  },
} as const;
