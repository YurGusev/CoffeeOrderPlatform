export type { SseResourceInvalidated, SseStreamReady, SseStreamReset } from '@coffee-platform/generated-client-v1';

export const contractPackage = {
  id: '@coffee-platform/contracts-realtime-v1',
  source: {
    manifest: 'contracts/manifest.yaml',
    openapi: 'contracts/openapi/client-v1.yaml',
    schemas: 'contracts/schemas',
  },
} as const;
