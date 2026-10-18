import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLE_DEMO_CSV, DEMO_CSV, GIFT_DEMO_CSV, IMPORT_FIELDS, calculate, giftCost, marginCost, previewCsv } from './operations';
import { RetailStore } from './store';
import { readTool, simulate, type Trace } from './investigations';
import { auditMarginNumbers, numericObservations } from './margin-numeric';

const row = previewCsv(GIFT_DEMO_CSV).valid[0]!;
const gift = row.gifts![0]!;
function csv(r: object): string {
  return [IMPORT_FIELDS.join(','), IMPORT_FIELDS.map(key => {
    const value = (r as Record<string, unknown>)[key];
    return '"' + (value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""') + '"';
  }).join(',')].join('\n');
}

test('gift imports distinguish zero, paid cost and unknown, persist and preserve frozen evidence on correction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merqo-gifts-')); const file = join(dir, 'data.sqlite'); let store = new RetailStore(file);
  try {
    store.import(GIFT_DEMO_CSV, previewCsv(GIFT_DEMO_CSV).mapping, 'csv');
    const records = store.snapshot().records;
    const normal = records.find(r => r.row.sku_id === 'GIFT-NORMAL')!;
    const warning = records.find(r => r.row.sku_id === 'GIFT-WARNING')!;
    const missing = records.find(r => r.row.sku_id === 'GIFT-MISSING')!;
    expect(normal.calculation).toMatchObject({ revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 });
    expect(warning.calculation).toMatchObject({ revenueMinor: 8000, profitMinor: 500, marginBps: 625, totalProfitMinor: 5000 });
    expect(warning.status).toBe('low_margin'); expect(missing.status).toBe('needs_evidence'); expect(missing.calculation.profitMinor).toBeNull();
    expect(simulate(missing).every(s => !s.passed)).toBe(true);
    expect(simulate(warning).find(s => s.kind === 'reduce_coupon')?.passed).toBe(false); // Max revenue 90 < 75 / .8.
    const traces: Trace[] = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'].map(tool => ({
      at: new Date().toISOString(), stage: 'investigate', tool, evidenceId: `${warning.id}:${tool}`, data: readTool(warning, tool as Parameters<typeof readTool>[1]),
    }));
    const audit = auditMarginNumbers(warning, simulate(warning), traces);
    expect(audit.facts.find(f => f.key === 'unitCost')?.value).toBe(7500);
    expect(audit.facts.find(f => f.key === 'giftUnitCost')?.value).toBe(1500);
    expect(numericObservations(audit).some(o => o.text.includes('每销售件附赠成本：¥15.00'))).toBe(true);
    for (const patch of [{ gifts: [] }, { giftPolicy: 'none' }, { giftCostBasis: 'included' }, { giftCostMinor: 0 }, { effectiveCostMinor: 6000 }]) {
      const modified = structuredClone(traces); const c = modified.find(t => t.tool === 'retail_get_sku_context')!;
      c.data = { ...(c.data as object), ...patch };
      expect(() => auditMarginNumbers(warning, simulate(warning), modified)).toThrow('赠品明细');
    }
    store.close(); store = new RetailStore(file);
    expect(store.snapshot().records).toEqual(records);
    store.import(GIFT_DEMO_CSV, undefined, 'csv'); expect(store.snapshot().batches).toHaveLength(1);
    store.import(csv({ ...missing.row, gifts: [gift] }), undefined, 'csv');
    expect(store.snapshot().records.find(r => r.row.sku_id === 'GIFT-MISSING')?.status).toBe('normal');
    expect(missing.row.gifts![0]?.unit_cost_minor).toBeNull(); expect(missing.calculation.profitMinor).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('gift rules require explicit association and non-overlapping cost basis before calculating margin', () => {
  for (const patch of [
    { gift_policy: undefined }, { gift_policy: 'unknown' as const }, { gift_policy: 'none' as const },
    { gift_cost_basis: undefined }, { gift_cost_basis: 'unknown' as const }, { gift_cost_basis: 'included' as const },
    { gifts: null }, { gifts: [] }, { gifts: [{ ...gift, unit_cost_minor: null }] },
    { gifts: [gift, { ...gift, spec: 'different' }] }, { gifts: [{ ...gift, sku_id: row.sku_id }] },
    { gifts: [{ ...gift, quantity: 10000, unit_cost_minor: 100_000_000 }] }, { cost_minor: null },
  ]) {
    const r = { ...row, ...patch };
    expect(previewCsv(csv(r)).valid).toHaveLength(1);
    expect(calculate(r).profitMinor).toBeNull(); expect(calculate(r).issues.length).toBeGreaterThan(0);
  }
  const old = previewCsv(DEMO_CSV); expect(old.valid).toHaveLength(6); expect(old.mapping).not.toHaveProperty('gifts');
  expect(previewCsv(DEMO_CSV, old.mapping).valid).toEqual(old.valid);
  expect(calculate({ ...old.valid[0]!, gift_policy: 'none' })).toEqual(calculate(old.valid[0]!));
});

test('invalid gift shape and hidden mapped columns are rejected instead of losing cost', () => {
  for (const invalid of [{ ...gift, quantity: 0 }, { ...gift, quantity: 1.5 }, { ...gift, unit_cost_minor: -1 },
    { ...gift, unit_cost_minor: 0.01 }, { ...gift, unit_cost_minor: undefined }, { ...gift, spec: '' },
    { ...gift, currency: 'USD' }, { ...gift, revenue_minor: 100 }, { ...gift, gifts: [gift] }]) {
    expect(previewCsv(csv({ ...row, gifts: [invalid] })).rejected).toHaveLength(1);
  }
  expect(previewCsv(csv(row).replace('[{', 'broken[{')).rejected[0]?.reason).toContain('有效 JSON');
  const mapping = previewCsv(GIFT_DEMO_CSV).mapping;
  for (const key of ['gift_policy', 'gift_cost_basis', 'gifts']) expect(() => previewCsv(GIFT_DEMO_CSV, { ...mapping, [key]: '' })).toThrow('必须保留');
});

test('gift quantities enter actual cost and coupon target, including a bundle with additional gifts', () => {
  const r = { ...row, gifts: [{ ...gift, quantity: 2, unit_cost_minor: 500 }] };
  expect(giftCost(r)).toBe(1000); expect(marginCost(r)).toBe(7000);
  expect(calculate(r).profitMinor).toBe(1000);
  const dir = mkdtempSync(join(tmpdir(), 'merqo-gift-target-')); const store = new RetailStore(join(dir, 'data.sqlite'));
  try {
    store.import(csv(r), undefined, 'csv');
    const proposed = simulate(store.snapshot().records[0]!).find(s => s.kind === 'reduce_coupon')!;
    expect(proposed).toMatchObject({ couponMinor: 250, revenueMinor: 8750, profitMinor: 1750, marginBps: 2000, passed: true });
    const bundle = { ...previewCsv(BUNDLE_DEMO_CSV).valid[0]!, gift_policy: r.gift_policy, gift_cost_basis: r.gift_cost_basis, gifts: r.gifts };
    expect(calculate(bundle).profitMinor).toBe(1000); // 80 - bundle 60 - gifts 10, no double subtraction.
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
