import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from './signal-store';
import { SignalPageSchema } from './signal-query';
import { INVENTORY_DEMO } from './signals';

let dir: string, file: string, store: SignalStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-signal-query-')); file = join(dir, 'signals.sqlite'); store = new SignalStore(file); store.demo(); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('both scenarios page without truncating scope counts or losing records', () => {
  const all = store.snapshot().records;
  const first = store.page({ source: 'demo', limit: 1 });
  expect(first.records).toHaveLength(1);
  expect(first.pagination.total).toBe(all.length);
  for (const kind of ['inventory', 'ads'] as const) {
    const rows = all.filter(r => r.kind === kind);
    expect(first.pagination.summary[kind]).toEqual({ total: rows.length, normal: rows.filter(r => r.status === 'normal').length, warning: rows.filter(r => r.status === 'warning').length, missing: rows.filter(r => r.status === 'needs_evidence').length });
  }
  const ids = Array.from({ length: all.length }, (_, offset) => store.page({ source: 'demo', limit: 1, offset }).records[0]!.id);
  expect(new Set(ids).size).toBe(all.length);
  expect(ids.toSorted()).toEqual(all.map(r => r.id).toSorted());
  expect(store.page({ status: 'warning' }).pagination.summary).toEqual(first.pagination.summary);
  expect(store.page({ status: 'anomalies' }).records.every(r => r.status !== 'normal')).toBe(true);
});

test('kind, source, shop, channel, date, literal search and empty pages stay scoped', () => {
  store.import('inventory', INVENTORY_DEMO, undefined, 'csv');
  const row = store.snapshot().records.find(r => r.kind === 'inventory' && r.source === 'demo')!;
  const page = store.page({ kind: 'inventory', source: 'demo', shop: row.row.shop_id, channel: row.row.channel, date: row.row.date, search: row.row.sku_id, limit: 1 });
  expect(page.pagination.total).toBe(1); expect(page.records[0]!.id).toBe(row.id);
  expect(page.pagination.summary.ads.total).toBe(0);
  expect(store.page({ source: 'csv' }).records.every(r => r.source === 'csv')).toBe(true);
  expect(store.page({ search: '%' }).pagination.total).toBe(0);
  expect(store.page({ search: "' OR 1=1 --" }).records).toEqual([]);
  expect(store.page({ shop: 'missing', offset: 90 }).pagination).toMatchObject({ total: 0, offset: 0 });
  expect(store.page({ limit: 2, offset: 200000 }).pagination.offset).toBe(8);
});

test('another connection import, batch time and restart invalidate cached evidence', () => {
  const old = store.page({ kind: 'inventory' }).records;
  const other = new SignalStore(file);
  try { other.import('inventory', INVENTORY_DEMO, undefined, 'csv'); } finally { other.close(); }
  expect(store.page({ kind: 'inventory', source: 'csv' }).pagination.total).toBe(old.length);
  const db = new Database(file);
  try { db.query("UPDATE signal_batches SET imported_at=? WHERE source='csv'").run('2000-01-01T00:00:00Z'); } finally { db.close(); }
  const page = store.page({ source: 'csv' });
  expect(page.records.every(r => r.importedAt === '2000-01-01T00:00:00Z')).toBe(true);
  store.close(); store = new SignalStore(file);
  expect(store.page({ source: 'csv' })).toEqual(page);
});

test('replacement recalculates counts and removes stale evidence after cache creation', () => {
  const before = store.page({ kind: 'inventory', source: 'csv' });
  expect(before.pagination.total).toBe(0);
  store.import('inventory', INVENTORY_DEMO, undefined, 'csv');
  const cached = store.page({ kind: 'inventory', source: 'csv' });
  const lines = INVENTORY_DEMO.split('\n'), headers = lines[0]!.split(',');
  const cells = lines[1]!.split(',');
  cells[headers.indexOf('recent_sales_qty')] = '';
  const old = cached.records.find(r => r.row.sku_id === cells[headers.indexOf('sku_id')])!;
  const other = new SignalStore(file);
  try { other.import('inventory', [lines[0], cells.join(',')].join('\n'), undefined, 'csv'); } finally { other.close(); }
  const changed = store.page({ kind: 'inventory', source: 'csv', search: old.row.sku_id });
  expect(changed.records[0]!.id).not.toBe(old.id);
  expect(changed.records[0]!.status).toBe('needs_evidence');
  expect(changed.pagination.summary.inventory.total).toBe(cached.pagination.summary.inventory.total);
  expect(changed.pagination.summary.inventory.missing).toBe(cached.pagination.summary.inventory.missing + (old.status === 'needs_evidence' ? 0 : 1));
});

test('cross-date specification conflicts remain visible even with one-row filtering', () => {
  const lines = INVENTORY_DEMO.split('\n');
  const cells = lines[1]!.split(',');
  const headers = lines[0]!.split(',');
  cells[headers.indexOf('spec')] = 'conflicting-spec';
  cells[headers.indexOf('date')] = '2026-10-15';
  store.import('inventory', [lines[0], cells.join(',')].join('\n'), undefined, 'demo');
  const sku = cells[headers.indexOf('sku_id')]!;
  const page = store.page({ kind: 'inventory', search: sku, limit: 1 });
  expect(page.records[0]!.status).toBe('needs_evidence');
  expect(page.records[0]!.metrics.issues.join(' ')).toContain('规格冲突');
});

test('query contract bounds pages, denies SQL and readonly connections do not mutate', () => {
  for (const input of [{ limit: 201 }, { offset: -1 }, { kind: 'margin' }, { sql: 'DELETE FROM signal_current' }]) expect(SignalPageSchema.safeParse(input).success).toBe(false);
  const readonly = new SignalStore(file, true);
  try { expect(() => readonly.page()).toThrow('只读'); expect(readonly.snapshot().records.length).toBeGreaterThan(0); } finally { readonly.close(); }
});

test('source cursor preserves evidence and releases its read transaction when stopped early', () => {
  store.import('inventory', INVENTORY_DEMO, undefined, 'csv');
  const cursor = store.records('csv');
  const first = cursor.next().value!;
  expect(first.source).toBe('csv');
  cursor.return(undefined);
  const other = new SignalStore(file);
  try { other.import('inventory', INVENTORY_DEMO.replace('桂花乌龙冷萃茶', '改名后的商品'), undefined, 'csv'); } finally { other.close(); }
  expect([...store.records('csv')]).toEqual(store.snapshot().records.filter(row => row.source === 'csv'));
  expect(store.page({ source: 'csv', search: '改名后的商品' }).pagination.total).toBe(1);
});
