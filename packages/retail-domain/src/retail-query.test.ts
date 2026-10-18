import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetailStore } from './store';
import { DEMO_CSV, RetailRequestSchema } from './operations';
import { RetailPageSchema } from './retail-query';

let dir: string, store: RetailStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-page-')); store = new RetailStore(join(dir, 'data.sqlite')); store.import(DEMO_CSV, undefined, 'demo'); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('page counts and exact global sums are independent of limit, search, status and offset', () => {
  const all = store.snapshot().records;
  const known = all.filter(r => r.status !== 'needs_evidence');
  const first = store.page({ source: 'demo', limit: 1 }); const second = store.page({ source: 'demo', limit: 1, offset: 1 });
  expect(first.records).toHaveLength(1); expect(second.records[0]!.id).not.toBe(first.records[0]!.id);
  expect(first.pagination!.summary).toEqual(second.pagination!.summary);
  expect(first.pagination!.summary.total).toBe(all.length);
  expect(first.pagination!.summary.revenueMinor).toBe(known.reduce((n, r) => n + BigInt(r.calculation.totalRevenueMinor!), 0n).toString());
  const tea = store.page({ source: 'demo', search: 'tea-500' }); expect(tea.records).toHaveLength(1); expect(tea.pagination!.total).toBe(1);
  expect(tea.pagination!.summary).toEqual(first.pagination!.summary);
  expect(store.page({ source: 'demo', search: '%' }).pagination!.total).toBe(0);
  expect(store.page({ source: 'csv' }).pagination!.summary.total).toBe(0);
  expect(store.page({ status: 'anomalies' }).records.every(r => r.status !== 'normal')).toBe(true);
});

test('projection invalidates on replaced evidence, survives restart and clamps stale page offsets', () => {
  const old = store.page({ source: 'demo', search: 'tea-500' }).records[0]!;
  store.import(DEMO_CSV.replace(',CNY,10000,2000,1000,', ',CNY,10000,0,0,'), undefined, 'demo');
  const changed = store.page({ source: 'demo', search: 'tea-500', offset: 90 });
  expect(changed.pagination!.offset).toBe(0); expect(changed.records[0]!.id).not.toBe(old.id);
  expect(changed.records[0]!.calculation.revenueMinor).toBe(10000);
  store.close(); store = new RetailStore(join(dir, 'data.sqlite'));
  expect(store.page({ source: 'demo', search: 'tea-500' }).records).toEqual(changed.records);
  expect(JSON.stringify(store.queryPlan())).toContain('retail_query_order');
});

test('bounded typed query rejects untrusted SQL, huge pages and out-of-range offsets', () => {
  for (const query of [{ limit: 10000 }, { offset: -1 }, { sql: 'DELETE FROM retail_records' }]) expect(RetailPageSchema.safeParse(query).success).toBe(false);
  expect(RetailRequestSchema.safeParse({ op: 'snapshot', source: 'csv', limit: 30, offset: 30 }).success).toBe(true);
  const preview = store.request({ op: 'preview', csv: DEMO_CSV });
  expect(preview.ok && preview.kind === 'preview' && preview.data.validCount).toBe(store.snapshot().records.length);
});
