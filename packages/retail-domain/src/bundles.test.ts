import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLE_DEMO_CSV, DEMO_CSV, IMPORT_FIELDS, RowSchema, calculate, previewCsv } from './operations';
import { RetailStore } from './store';
import { readTool, simulate, type Trace } from './investigations';
import { auditMarginNumbers } from './margin-numeric';

const row = previewCsv(BUNDLE_DEMO_CSV).valid[0]!;
const content = (r: object) => [IMPORT_FIELDS.join(','), IMPORT_FIELDS.map(key => {
  const value = (r as Record<string, unknown>)[key];
  return '"' + (value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""') + '"';
}).join(',')].join('\n');

test('bundle import computes pack totals and retains conflict/missing rows as evidence gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merqo-bundle-'));
  const file = join(dir, 'data.sqlite'); let store = new RetailStore(file);
  try {
    store.import(BUNDLE_DEMO_CSV, previewCsv(BUNDLE_DEMO_CSV).mapping, 'csv');
    const normal = store.snapshot().records.find(r => r.row.sku_id === 'PACK-NORMAL')!;
    expect(normal.calculation).toMatchObject({ revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 });
    for (const r of store.snapshot().records.filter(r => r.row.sku_id !== 'PACK-NORMAL')) {
      expect(r.status).toBe('needs_evidence'); expect(r.calculation.profitMinor).toBeNull();
      expect(simulate(r).every(s => !s.passed)).toBe(true);
    }
    const trace: Trace[] = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'].map(tool => ({
      at: new Date().toISOString(), stage: 'investigate', tool, evidenceId: `${normal.id}:${tool}`, data: readTool(normal, tool as Parameters<typeof readTool>[1]),
    }));
    expect(() => auditMarginNumbers(normal, simulate(normal), trace)).not.toThrow();
    const context = trace.find(t => t.tool === 'retail_get_sku_context')!;
    context.data = { ...(context.data as object), bundleComponents: [] };
    expect(() => auditMarginNumbers(normal, simulate(normal), trace)).toThrow('组合装子项');
    store.close(); store = new RetailStore(file);
    expect(store.snapshot().records.find(r => r.id === normal.id)).toEqual(normal);
    store.import(BUNDLE_DEMO_CSV, undefined, 'csv'); expect(store.snapshot().batches).toHaveLength(1);
    const corrected = { ...row, sku_id: 'PACK-CONFLICT' };
    store.import(content(corrected), undefined, 'csv');
    expect(store.snapshot().records.find(r => r.row.sku_id === corrected.sku_id)?.status).toBe('normal');
    expect(normal.row.bundle_components).toEqual(row.bundle_components);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bundle cost gaps, duplicate identities, self references and missing declaration never produce profit', () => {
  const part = row.bundle_components![0]!;
  for (const patch of [
    { bundle_components: [] }, { bundle_components: null }, { cost_minor: null },
    { bundle_components: [{ ...part, unit_cost_minor: null }] },
    { bundle_components: [part, { ...part, spec: 'different' }] },
    { bundle_components: [{ ...part, sku_id: row.sku_id }] },
    { bundle_components: [{ ...part, quantity: 10000, unit_cost_minor: 100_000_000 }] },
    { product_type: 'single' as const }, { product_type: undefined },
  ]) {
    const r = { ...row, ...patch };
    expect(RowSchema.safeParse(r).success).toBe(true);
    expect(calculate(r).profitMinor).toBeNull(); expect(calculate(r).issues.length).toBeGreaterThan(0);
  }
});

test('invalid bundle JSON, quantities, fractional costs, unknown fields and currencies are quarantined', () => {
  const part = row.bundle_components![0]!;
  for (const invalid of [
    { ...part, quantity: 0 }, { ...part, quantity: 1.5 }, { ...part, unit_cost_minor: -1 },
    { ...part, unit_cost_minor: 0.1 }, { ...part, currency: 'USD' }, { ...part, spec: '' },
    { ...part, components: [part] }, { ...part, unit_cost_minor: undefined },
  ]) expect(previewCsv(content({ ...row, bundle_components: [invalid] })).rejected).toHaveLength(1);
  const malformed = content(row).replace('[{', 'broken[{');
  expect(previewCsv(malformed).rejected[0]?.reason).toContain('有效 JSON');
  const mapping = previewCsv(BUNDLE_DEMO_CSV).mapping;
  expect(() => previewCsv(BUNDLE_DEMO_CSV, { ...mapping, bundle_components: '' })).toThrow('必须保留');
  const old = previewCsv(DEMO_CSV);
  expect(old.valid).toHaveLength(6); expect(old.mapping).not.toHaveProperty('product_type');
  expect(previewCsv(DEMO_CSV, old.mapping).valid).toEqual(old.valid);
});

test('changing bundle composition across dates without changing the SKU requires identity review', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merqo-bundle-scope-')); const store = new RetailStore(join(dir, 'data.sqlite'));
  try {
    store.import(content(row), undefined, 'csv');
    store.import(content({ ...row, date: '2026-10-13', bundle_components: [{ sku_id: 'OTHER', spec: '500ml', quantity: 6, unit_cost_minor: 1000 }] }), undefined, 'csv');
    expect(store.snapshot().records.every(r => r.status === 'needs_evidence')).toBe(true);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
