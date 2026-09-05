import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

void test('generated TS7 types preserve real contract constructs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contracts-types-'));
  const client = join(root, 'packages/generated/client-v1/src/index.js');
  const internal = join(root, 'packages/generated/internal-v1/src/index.js');
  await writeFile(join(directory, 'check.ts'), `
import type { CustomerCreateRequest, CustomerSearchResponse, PricingQuoteCreateRequest } from '${client}';
import type { AromaCatalogExportRecord, AromaCartSnapshotReadRequest } from '${internal}';
const phone: CustomerCreateRequest = { displayName: 'Клиент', phone: '+79991234567' };
const email: CustomerCreateRequest = { displayName: 'Клиент', email: 'client@example.test' };
const both: CustomerCreateRequest = { ...phone, email: 'client@example.test' };
const nullable: CustomerSearchResponse = { items: [], nextCursor: null };
const discriminated: AromaCatalogExportRecord = { recordType: 'snapshot-started', streamVersion: '1', snapshotRef: 'snp_01ARZ3NDEKTSV4RRFFQ69G5FAY', supplierRef: 'sup_01ARZ3NDEKTSV4RRFFQ69G5FAY', providerSnapshotRef: 'provider-1', startedAt: '2026-09-05T10:00:00Z' };
const referenced: AromaCartSnapshotReadRequest = { cartScopeRef: 'aroma-primary' };
const quote: PricingQuoteCreateRequest = { customerRef: 'cus_01ARZ3NDEKTSV4RRFFQ69G5FAY', lines: [{ productRef: 'prd_01ARZ3NDEKTSV4RRFFQ69G5FAX', variantRef: 'var_01ARZ3NDEKTSV4RRFFQ69G5FAY', quantity: '1' }] };
// @ts-expect-error At least one contact remains required.
const missingContact: CustomerCreateRequest = { displayName: 'Клиент' };
// @ts-expect-error Nullable field accepts string or null, not number.
const invalidNullable: CustomerSearchResponse = { items: [], nextCursor: 1 };
// @ts-expect-error Discriminator remains a closed union.
const invalidRecord: AromaCatalogExportRecord = { ...discriminated, recordType: 'Unknown' };
// @ts-expect-error Referenced const is preserved.
const invalidRef: AromaCartSnapshotReadRequest = { cartScopeRef: 'other' };
void [phone, email, both, nullable, discriminated, referenced, quote, missingContact, invalidNullable, invalidRecord, invalidRef];
`);
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ extends: join(root, 'tsconfig.base.json'), compilerOptions: { noEmit: true, types: [], lib: ['ES2025', 'DOM'] }, include: ['check.ts'] }));
  const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', directory], { cwd: root, encoding: 'utf8' });
  await rm(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stdout || result.stderr);
});
