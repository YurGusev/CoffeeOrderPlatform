#!/usr/bin/env node
import { createClient } from '@hey-api/openapi-ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import yaml from 'js-yaml';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const runtimeSchemaSelection = {
  client: {
    components: ['CustomerAddress', 'CustomerCreateRequest', 'CustomerResponse', 'CustomerSummary', 'CustomerSearchResponse', 'CustomerRef', 'ProblemDetails', 'PricingQuoteCreateRequest', 'PricingQuoteResponse', 'QuoteRef', 'OrderDraftCreateRequest', 'OrderItemPutRequest', 'OrderConfirmRequest', 'ReconciliationRequest', 'OrderCardResponse', 'ReconciliationAcceptedResponse', 'OrderRef', 'ItemRef', 'ProductRef', 'VariantRef', 'ErrorOrderConfirmationRejected', 'ErrorOrderEmpty', 'ErrorOrderDesiredOverflow', 'ErrorOrderItemLimitExceeded', 'ErrorOrderQuoteScopeMismatch'],
    parameters: ['CustomerQuery', 'PageLimit', 'CustomerCursor', 'Cursor', 'IdempotencyKey', 'ReplayOnly', 'IfMatchVersion'],
  },
  internal: {
    components: ['CustomerOrderInput', 'CustomerRef', 'ProblemDetails', 'AromaCatalogExportRequest', 'AromaCatalogExportRecord', 'AromaOfferBindingRequest', 'AromaOfferBindingResponse', 'AromaMutationResponse', 'AromaCartSnapshotReadRequest', 'AromaCartSnapshot', 'AromaSetQuantityRequest', 'AromaRemoveLineRequest', 'PricingQuoteVerifyRequest', 'PricingQuoteVerificationResponse'],
    parameters: ['CustomerRef'],
  },
  'edge-auth': {
    components: ['BrowserSession', 'ProblemDetails'],
    parameters: [],
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
  const prefix = surface === 'edge-auth' ? 'edgeAuth' : surface;
  const source = `// This file is auto-generated from contracts/openapi/${surface}-v1.yaml.\n\nexport const ${prefix}V1Schemas = ${JSON.stringify(schemas, null, 2)} as const;\n\nexport const ${prefix}V1ParameterSchemas = ${JSON.stringify(parameters, null, 2)} as const;\n`;
  await writeFile(target, source);
}

async function writeClientV1BrowserOperations() {
  const document = await loadDocument(resolve(root, 'contracts/openapi/client-v1.yaml'));
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
  const operations = Object.entries(document.paths ?? {})
    .flatMap(([path, pathItem]) => Object.entries(pathItem ?? {})
      .filter(([method]) => methods.has(method.toLowerCase()))
      .map(([method, operation]) => ({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        audience: operation['x-audience'],
        ...(operation['x-permission'] === undefined ? {} : { permission: operation['x-permission'] }),
      })))
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
  const target = resolve(root, 'apps/edge-gateway/src/client-operations.gen.ts');
  await mkdir(dirname(target), { recursive: true });
  const source = `// This file is auto-generated from contracts/openapi/client-v1.yaml.\n\nexport const clientV1BrowserOperations = ${JSON.stringify(operations, null, 2)} as const;\n`;
  await writeFile(target, source);
}

async function writeOrdersAromaMessageSchemas() {
  const files = [
    'order-confirmed.v1', 'order-reconciliation-requested.v1', 'catalog-mapping-changed.v2',
    'aroma-convergence-requested.v1', 'aroma-observation-changed.v1', 'aroma-convergence-changed.v1',
    'realtime-invalidated.v1',
  ];
  const documents = new Map();
  async function collect(path) {
    if (documents.has(path)) return;
    const schema = await loadDocument(path);
    if (typeof schema.$id !== 'string') throw new Error(`message schema lacks $id: ${path}`);
    documents.set(path, schema);
    async function references(value) {
      if (!value || typeof value !== 'object') return;
      if (typeof value.$ref === 'string') {
        const [relativePath] = value.$ref.split('#');
        if (relativePath) {
          if (/^[a-z]+:/i.test(relativePath)) throw new Error(`non-local message schema reference: ${value.$ref}`);
          await collect(resolve(dirname(path), relativePath));
        }
      }
      for (const item of Object.values(value)) await references(item);
    }
    await references(schema);
  }
  for (const name of files) await collect(resolve(root, `contracts/schemas/events/${name}.schema.json`));
  const schemas = Object.fromEntries([...documents.values()].sort((a, b) => a.$id.localeCompare(b.$id)).map(schema => [schema.$id, schema]));
  const target = resolve(root, 'packages/generated/internal-v1/src/message-schemas.gen.ts');
  await writeFile(target, `// This file is auto-generated from canonical contracts/schemas events and their dependencies.\n\nexport const ordersAromaMessageSchemas = ${JSON.stringify(schemas, null, 2)} as const;\n`);
}

const requestedSurface = process.argv.includes('--surface') ? process.argv[process.argv.indexOf('--surface') + 1] : undefined;
if (requestedSurface && !['client', 'internal', 'edge-auth'].includes(requestedSurface)) throw new Error(`unsupported contract surface: ${requestedSurface}`);
for (const surface of requestedSurface ? [requestedSurface] : ['client', 'internal', 'edge-auth']) {
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
  if (surface === 'internal') await writeOrdersAromaMessageSchemas();
}

if (!requestedSurface) await writeClientV1BrowserOperations();
