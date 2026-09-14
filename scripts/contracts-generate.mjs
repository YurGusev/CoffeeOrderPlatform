#!/usr/bin/env node
import { createClient } from '@hey-api/openapi-ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const runtimeSchemaSelection = {
  client: {
    components: ['CustomerAddress', 'CustomerCreateRequest', 'CustomerResponse', 'CustomerSummary', 'CustomerSearchResponse', 'CustomerRef', 'ProblemDetails'],
    parameters: ['CustomerQuery', 'PageLimit', 'CustomerCursor', 'Cursor', 'IdempotencyKey', 'ReplayOnly'],
  },
  internal: {
    components: ['CustomerOrderInput', 'CustomerRef', 'ProblemDetails', 'AromaCatalogExportRequest', 'AromaOfferBindingRequest', 'AromaOfferBindingResponse', 'AromaMutationResponse', 'AromaCartSnapshotReadRequest', 'AromaCartSnapshot', 'AromaSetQuantityRequest', 'AromaRemoveLineRequest'],
    parameters: ['CustomerRef'],
  },
};

async function loadDocument(path) {
  const source = await readFile(path, 'utf8');
  return path.endsWith('.json') ? JSON.parse(source) : yaml.load(source);
}

function resolvePointer(document, fragment) {
  if (!fragment || fragment === '#') return document;
  return fragment.slice(2).split('/').reduce((value, part) => value?.[part.replaceAll('~1', '/').replaceAll('~0', '~')], document);
}

async function inlineSchema(value, sourcePath, stack = []) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => inlineSchema(item, sourcePath, stack)));
  if (typeof value.$ref === 'string') {
    const [relativePath = '', fragment = ''] = value.$ref.split('#');
    const targetPath = relativePath ? resolve(dirname(sourcePath), relativePath) : sourcePath;
    const key = `${targetPath}#${fragment}`;
    if (stack.includes(key)) throw new Error(`cyclic runtime schema reference: ${key}`);
    const targetDocument = await loadDocument(targetPath);
    const target = resolvePointer(targetDocument, fragment ? `#${fragment}` : '#');
    if (target === undefined) throw new Error(`unresolved runtime schema reference: ${value.$ref}`);
    return inlineSchema(target, targetPath, [...stack, key]);
  }
  return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await inlineSchema(item, sourcePath, stack)])));
}

async function writeRuntimeSchemas(surface) {
  const sourcePath = resolve(root, `contracts/openapi/${surface}-v1.yaml`);
  const document = await loadDocument(sourcePath);
  const selection = runtimeSchemaSelection[surface];
  const schemas = {};
  const parameters = {};
  for (const name of selection.components) {
    schemas[name] = await inlineSchema(document.components.schemas[name], sourcePath);
  }
  for (const name of selection.parameters) {
    parameters[name] = await inlineSchema(document.components.parameters[name]?.schema, sourcePath);
  }
  const target = resolve(root, `packages/generated/${surface}-v1/src/runtime-schemas.gen.ts`);
  await mkdir(dirname(target), { recursive: true });
  const source = `// This file is auto-generated from contracts/openapi/${surface}-v1.yaml.\n\nexport const ${surface}V1Schemas = ${JSON.stringify(schemas, null, 2)} as const;\n\nexport const ${surface}V1ParameterSchemas = ${JSON.stringify(parameters, null, 2)} as const;\n`;
  await writeFile(target, source);
}

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
  await writeRuntimeSchemas(surface);
}
