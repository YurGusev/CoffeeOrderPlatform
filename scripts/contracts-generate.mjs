#!/usr/bin/env node
import { createClient } from '@hey-api/openapi-ts';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

for (const surface of ['client', 'internal']) {
  await createClient({
    input: resolve(root, `contracts/openapi/${surface}-v1.yaml`),
    output: {
      path: resolve(root, `packages/generated/${surface}-v1/src`),
      clean: true,
      module: { extension: '.js' },
      postProcess: [],
    },
    plugins: [{ name: '@hey-api/typescript', enums: false }],
  });
}
