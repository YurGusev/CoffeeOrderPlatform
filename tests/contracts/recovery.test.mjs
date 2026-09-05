import assert from 'node:assert/strict';
import test from 'node:test';
import { clientCommandScope, validateClientCommandRequest } from '../../packages/contracts/client-v1/src/index.ts';

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
  assert.equal(validateClientCommandRequest({ method: 'POST', path: vectors[0][1], replayOnly: 'true', hasBody: false }), 'replay');
  assert.equal(validateClientCommandRequest({ method: 'DELETE', path: vectors[4][1], hasBody: false, ifMatchVersion: '12' }), 'command');
  for (const request of [
    { method: 'POST', path: vectors[0][1], hasBody: false },
    { method: 'POST', path: vectors[0][1], replayOnly: 'true', hasBody: true },
    { method: 'DELETE', path: vectors[4][1], replayOnly: 'true', hasBody: false, ifMatchVersion: '12' },
    { method: 'DELETE', path: vectors[4][1], hasBody: false },
    { method: 'GET', path: '/api/client-v1/customers', replayOnly: 'true', hasBody: false },
  ]) assert.throws(() => validateClientCommandRequest(request), /VALIDATION_FAILED/);
});
