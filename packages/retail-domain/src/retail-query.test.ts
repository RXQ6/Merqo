import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
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

test('scope evidence covers the whole selected scope and never substitutes import time for business dates', () => {
  store.import(DEMO_CSV.replaceAll('demo-nanfeng','other-shop').replaceAll('2026-10-14','2026-10-15'),undefined,'csv');
  const first=store.page({source:'demo',limit:1});
  const searched=store.page({source:'demo',limit:1,search:'TEA-500',status:'anomalies'});
  expect(first.pagination!.scopeEvidence).toEqual(searched.pagination!.scopeEvidence);
  expect(first.pagination!.scopeEvidence!.businessStart).toBe('2026-10-14');
  expect(first.pagination!.scopeEvidence!.businessEnd).toBe('2026-10-14');
  expect(first.pagination!.scopeEvidence!.batches.reduce((n,b)=>n+b.count,0)).toBe(6);
  expect(first.pagination!.scopeEvidence!.batches).toHaveLength(1);
  expect(first.pagination!.scopeEvidence!.batches[0]!.count).toBe(6);
  expect(first.pagination!.scopeEvidence!.batches[0]!.provenance?.origin).toBe('builtin_synthetic');
  const imported=store.page({source:'csv',shop:'other-shop'}).pagination!.scopeEvidence!;
  expect(imported.businessEnd).toBe('2026-10-15');
  expect(imported.batches[0]!.provenance).toBeUndefined();
  const empty=store.page({source:'csv',shop:'demo-nanfeng'}).pagination!.scopeEvidence!;
  expect(empty.businessEnd).toBeNull();expect(empty.batches).toHaveLength(0);
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

test('clean legacy projection migrates batch indexing and rebuilds without touching source evidence', () => {
  const original=store.page({source:'demo'}).records;store.close();
  const db=new Database(join(dir,'data.sqlite'));
  db.exec('DROP TABLE retail_query_records; CREATE TABLE retail_query_records(id TEXT PRIMARY KEY,source TEXT NOT NULL,shop TEXT NOT NULL,channel TEXT NOT NULL,date TEXT NOT NULL,sku TEXT NOT NULL,status TEXT NOT NULL,search TEXT NOT NULL,revenue TEXT,profit TEXT,evidence_json TEXT NOT NULL); UPDATE retail_query_meta SET dirty=0 WHERE singleton=1');
  db.close();store=new RetailStore(join(dir,'data.sqlite'));
  const migrated=store.page({source:'demo'});
  expect(migrated.records).toEqual(original);
  expect(migrated.pagination!.scopeEvidence!.batches).toHaveLength(1);
  expect(migrated.pagination!.scopeEvidence!.batches[0]!.count).toBe(6);
});

test('batch metadata invalidates evidence and history, including an already-stale legacy projection', () => {
  store.page({ source: 'demo' });
  const db = new Database(join(dir, 'data.sqlite'));
  try {
    db.query("UPDATE retail_batches SET imported_at=? WHERE source='demo'").run('2000-01-01T00:00:00Z');
    const page = store.page({ source: 'demo' });
    expect(page.records.every(r => r.importedAt === '2000-01-01T00:00:00Z')).toBe(true);
    expect(page.batches.every(b => b.importedAt === '2000-01-01T00:00:00Z')).toBe(true);
    // Simulate a cache created by the earlier version, which had no batch UPDATE invalidation.
    db.exec('DROP TRIGGER retail_query_retail_batches_update');
    db.query("UPDATE retail_batches SET imported_at=? WHERE source='demo'").run('2001-01-01T00:00:00Z');
    store.close(); store = new RetailStore(join(dir, 'data.sqlite'));
    const upgraded = store.page({ source: 'demo' });
    expect(upgraded.records.every(r => r.importedAt === '2001-01-01T00:00:00Z')).toBe(true);
    expect(upgraded.batches.every(b => b.importedAt === '2001-01-01T00:00:00Z')).toBe(true);
    expect(upgraded.records).toEqual(store.snapshot().records.sort((a, b) => a.row.shop_id.localeCompare(b.row.shop_id) || b.row.date.localeCompare(a.row.date) || a.row.sku_id.localeCompare(b.row.sku_id) || a.id.localeCompare(b.id)));
  } finally { db.close(); }
});
