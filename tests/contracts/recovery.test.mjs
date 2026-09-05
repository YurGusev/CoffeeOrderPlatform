import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';
import { clientCommandScope, validateClientCommandRequest } from '../../packages/contracts/client-v1/src/index.ts';
import { createRuntime } from '../../packages/platform-runtime/src/index.ts';

const vectors = [
  ['POST', '/api/client-v1/customers', '395896983d677f1748e2a35c7f4df146d27a0adbd4802f950bc553b6cf03e462'],
  ['POST', '/api/client-v1/pricing/quotes', 'e3e5d644a892254404adf22b5ad712e7f92274e5ac04c4e6e3ab4697070b48bf'],
  ['POST', '/api/client-v1/orders/drafts', '4a2f071cf9f7541f835d251b374f205721950245eef04183a25bd730bdca615c'],
  ['PUT', '/api/client-v1/orders/ord_01ARZ3NDEKTSV4RRFFQ69G5FAV/items/itm_01BX5ZZKBKACTAV9WEVGEMMVRY', 'e40e4d6357ef53266c0f55d9b4a870e58d1c1c80fa75bb12848135b434906915'],
  ['DELETE', '/api/client-v1/orders/ord_01ARZ3NDEKTSV4RRFFQ69G5FAV/items/itm_01BX5ZZKBKACTAV9WEVGEMMVRY', 'ab77df91975e07266e19b561f4a3580df682c76b4387cca6bcbb2c9fd9a41ffb'],
  ['POST', '/api/client-v1/orders/ord_01ARZ3NDEKTSV4RRFFQ69G5FAV/commands/confirm', '8bcc7e3102cce762da15250fb318cc9e3bba33724ac71c5a02bcf1545ff38fcf'],
  ['POST', '/api/client-v1/orders/ord_01BX5ZZKBKACTAV9WEVGEMMVRY/commands/request-aroma-reconciliation', 'f84356f3fdb6b04fe47cb09021388a965ac2c3aac9d3c6ae88030f7661c71403'],
];

void test('seven client command scope vectors are stable', () => {
  for (const [method, path, hash] of vectors) assert.equal(clientCommandScope(method, path), hash);
});

void test('normal and replay-only modes fail closed', () => {
  assert.equal(validateClientCommandRequest({ method: 'POST', path: vectors[0][1], hasBody: true }), 'command');
  assert.equal(validateClientCommandRequest({ method: 'POST', path: vectors[0][1], replayOnly: true, hasBody: false }), 'replay');
  assert.equal(validateClientCommandRequest({ method: 'DELETE', path: vectors[4][1], hasBody: false, ifMatchVersion: '12' }), 'command');
  for (const request of [
    { method: 'POST', path: vectors[0][1], hasBody: false },
    { method: 'POST', path: vectors[0][1], replayOnly: true, hasBody: true },
    { method: 'DELETE', path: vectors[4][1], replayOnly: true, hasBody: false, ifMatchVersion: '12' },
    { method: 'DELETE', path: vectors[4][1], hasBody: false },
    { method: 'GET', path: '/api/client-v1/customers', replayOnly: true, hasBody: false },
  ]) assert.throws(() => validateClientCommandRequest(request), /VALIDATION_FAILED/);
});

void test('Fastify applies the source replay header schema before command validation', async () => {
  const document = yaml.load(await readFile(new URL('../../contracts/openapi/client-v1.yaml', import.meta.url), 'utf8'));
  const replay = document.components.parameters.ReplayOnly.schema;
  const app = await createRuntime({ name: 'contracts-recovery-test', host: '127.0.0.1', port: 0, shutdownGraceMs: 500 });
  app.post('/probe', {
    schema: { headers: { type: 'object', required: ['idempotency-replay-only'], properties: { 'idempotency-replay-only': replay } } },
  }, async (request) => {
    const replayOnly = request.headers['idempotency-replay-only'];
    return { type: typeof replayOnly, mode: validateClientCommandRequest({ method: 'POST', path: vectors[0][1], replayOnly, hasBody: false }) };
  });
  await app.runtimeController.start();
  const valid = await app.inject({ method: 'POST', url: '/probe', headers: { 'idempotency-replay-only': 'true' } });
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(valid.json(), { type: 'boolean', mode: 'replay' });
  for (const value of ['false', 'TRUE', '1']) assert.equal((await app.inject({ method: 'POST', url: '/probe', headers: { 'idempotency-replay-only': value } })).statusCode, 400);
  await app.runtimeController.closeRuntime('test');
});

void test('recovery contract classifies completed variants and lookup errors by schema', async () => {
  const document = yaml.load(await readFile(new URL('../../contracts/openapi/client-v1.yaml', import.meta.url), 'utf8'));
  const protocol = document['x-command-recovery'];
  const commands = Object.values(document.paths).flatMap(Object.values).filter((operation) => operation?.['x-idempotency']);
  assert.deepEqual(new Set(Object.keys(protocol.terminalSchemas)), new Set(commands.map((operation) => operation.operationId)));
  const schemaRefs = (value, seen = new Set()) => {
    if (!value || typeof value !== 'object') return seen;
    if (value.$ref?.startsWith('#/components/schemas/')) seen.add(value.$ref.split('/').at(-1));
    else if (value.$ref?.startsWith('#/components/responses/')) schemaRefs(document.components.responses[value.$ref.split('/').at(-1)], seen);
    for (const child of Object.values(value)) schemaRefs(child, seen);
    return seen;
  };
  for (const [operationId, terminal] of Object.entries(protocol.terminalSchemas)) {
    const operation = Object.values(document.paths).flatMap(Object.values).find((item) => item?.operationId === operationId);
    const allowed = schemaRefs(operation.responses);
    for (const schema of [...terminal, ...protocol.lookupErrorSchemas]) assert.ok(allowed.has(schema), `${operationId}: ${schema} is not a response variant`);
    for (const response of Object.values(operation.responses)) {
      if (response.$ref) continue;
      const variants = schemaRefs(response);
      if ([...terminal, ...protocol.lookupErrorSchemas].some((schema) => variants.has(schema))) {
        for (const [name, header] of Object.entries(protocol.responseHeaders)) assert.deepEqual(response.headers?.[name], header, `${operationId}: ${name} recovery header drift`);
      }
    }
  }
  const fixtures = JSON.parse(await readFile(new URL('../../contracts/fixtures/positive/http/recovery.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const marker = fixture.headers['idempotency-replayed'] === 'true';
    assert.equal(marker && fixture.headers['cache-control'] === 'no-store', fixture.completed, fixture.case);
    if (protocol.lookupErrorSchemas.includes(fixture.schema)) assert.equal(marker, false, fixture.case);
  }
});
