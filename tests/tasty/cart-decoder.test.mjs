import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeTastyCartResponse, TastyCartDecodeError} from '../../apps/tasty-gateway/dist/infrastructure/provider/cart-decoder.js';

// Minimal derived fields from the observed empty and ordinary bean samples; IDs are synthetic.
const empty = () => ({data: [], meta: {price: 0, price_without_discount: 0, weight: 0, coffee_weight: 0, tea_weight: 0}});
const bean = () => ({id: 101, offer_id: 201, product: {id: 301}, quantity: 1, grinding_id: null, package_id: 401,
  is_gift: false, is_promocode: false, item_data: null, active: true, is_blocked: false, type: 'bean_coffee'});
const cart = (...rows) => ({data: rows, meta: {}});
const fails = (body, code) => assert.throws(() => decodeTastyCartResponse(body), error =>
  error instanceof TastyCartDecodeError && error.code === code && error.message === code);

void test('empty requires validated zero totals and never asserts completeness', () => {
  assert.deepEqual(decodeTastyCartResponse(empty()), {kind: 'empty', lines: [], completeness: 'Unproven'});
  for (const key of ['price', 'price_without_discount', 'weight', 'coffee_weight', 'tea_weight']) {
    const missing = empty(); delete missing.meta[key]; fails(missing, 'TASTY_CART_INCOMPLETE');
    const nonzero = empty(); nonzero.meta[key] = 1; fails(nonzero, 'TASTY_CART_INVALID');
    const wrong = empty(); wrong.meta[key] = '0'; fails(wrong, 'TASTY_CART_INVALID');
  }
});

void test('ordinary row retains only private identity and strips all unrelated data', () => {
  const row = bean(); row.product.email = 'private@example.invalid'; row.extra = 'private-body';
  const body = cart(row); body.meta.last_order_address = {address: 'private-address'};
  const result = decodeTastyCartResponse(body);
  assert.deepEqual(result, {kind: 'nonempty', completeness: 'Unproven', lines: [{rowId: '101', offerId: '201', productId: '301', quantity: 1, grindingId: null, packageId: '401'}]});
  assert.doesNotMatch(JSON.stringify(result), /private|address|email/);
});

void test('synthetic variants retain distinct grind and package and recreated row locator', () => {
  const ground = {...bean(), id: 102, offer_id: 202, type: 'ground_coffee', grinding_id: 1};
  const otherGrind = {...ground, id: 103, grinding_id: 2};
  const otherPackage = {...ground, id: 104, package_id: 402};
  const lines = decodeTastyCartResponse(cart(ground, otherGrind, otherPackage)).lines;
  assert.deepEqual(lines.map(({rowId, offerId, grindingId, packageId}) => [rowId, offerId, grindingId, packageId]), [
    ['102', '202', '1', '401'], ['103', '202', '2', '401'], ['104', '202', '1', '402'],
  ]);
  assert.equal(decodeTastyCartResponse(cart({...bean(), id: 105})).lines[0].rowId, '105');
  fails(cart(bean(), {...bean()}), 'TASTY_CART_INVALID');
});

void test('malformed and partial response never becomes empty or defaults identity', () => {
  for (const value of [null, [], {}, {data: []}, {data: [], meta: null}, {data: {}, meta: {}}, {data: [null], meta: {}}]) {
    assert.throws(() => decodeTastyCartResponse(value), TastyCartDecodeError);
  }
  for (const key of ['id', 'offer_id', 'product', 'quantity', 'grinding_id', 'package_id']) {
    const row = bean(); delete row[key]; fails(cart(row), 'TASTY_CART_INCOMPLETE');
  }
  fails(cart({...bean(), product: {}}), 'TASTY_CART_INCOMPLETE');
  for (const key of ['id', 'offer_id', 'quantity', 'grinding_id', 'package_id']) {
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) fails(cart({...bean(), [key]: value}), 'TASTY_CART_INVALID');
  }
  fails(cart({...bean(), product: {id: Number.MAX_SAFE_INTEGER + 1}}), 'TASTY_CART_INVALID');
});

void test('missing guards fail closed and special or unsupported lines are rejected without payload', () => {
  for (const key of ['is_gift', 'is_promocode', 'item_data', 'active', 'is_blocked', 'type']) {
    const row = bean(); delete row[key]; fails(cart(row), 'TASTY_CART_INCOMPLETE');
  }
  for (const [key, value] of [['is_gift', true], ['is_promocode', true], ['item_data', {secret: 'private'}], ['active', false], ['is_blocked', true], ['type', 'unknown']]) {
    fails(cart({...bean(), [key]: value}), 'TASTY_CART_UNSUPPORTED_LINE');
  }
  for (const key of ['is_gift', 'is_promocode', 'active', 'is_blocked']) fails(cart({...bean(), [key]: 'false'}), 'TASTY_CART_INVALID');
  fails(cart({...bean(), type: null}), 'TASTY_CART_INVALID');
});
