import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MEMBER_DEMO_CSV, DEMO_CSV, BUNDLE_DEMO_CSV, IMPORT_FIELDS, calculate, effectivePrice, previewCsv, snapshotCsv } from './operations';
import { RetailStore } from './store';
import { readTool, simulate, type Trace } from './investigations';
import { auditMarginNumbers, numericObservations } from './margin-numeric';

const row = previewCsv(MEMBER_DEMO_CSV).valid[0]!;
const member = row.membership!;
function csv(r: object): string {
  return [IMPORT_FIELDS.join(','), IMPORT_FIELDS.map(key => {
    const value = (r as Record<string, unknown>)[key];
    return '"' + (key === 'membership' && value === null ? 'null' : value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""') + '"';
  }).join(',')].join('\n');
}

test('membership imports select eligible price, persist and retain frozen identity on correction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merqo-member-')); const file = join(dir, 'data.sqlite'); let store = new RetailStore(file);
  try {
    store.import(MEMBER_DEMO_CSV, previewCsv(MEMBER_DEMO_CSV).mapping, 'csv');
    const records = store.snapshot().records;
    const normal = records.find(r => r.row.sku_id === 'MEMBER-NORMAL')!;
    const warning = records.find(r => r.row.sku_id === 'MEMBER-WARNING')!;
    const missing = records.find(r => r.row.sku_id === 'MEMBER-MISSING')!;
    expect(normal.calculation).toMatchObject({ revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 });
    expect(warning.calculation).toMatchObject({ revenueMinor: 6000, profitMinor: 0, marginBps: 0, totalProfitMinor: 0 });
    expect(warning.status).toBe('low_margin'); expect(missing.status).toBe('needs_evidence'); expect(missing.calculation.profitMinor).toBeNull();
    expect(simulate(missing).every(s => !s.passed)).toBe(true);
    const traces: Trace[] = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'].map(tool => ({
      at: new Date().toISOString(), stage: 'investigate', tool, evidenceId: `${normal.id}:${tool}`, data: readTool(normal, tool as Parameters<typeof readTool>[1]),
    }));
    const audit = auditMarginNumbers(normal, simulate(normal), traces);
    expect(audit.facts.find(f => f.key === 'effectivePrice')?.value).toBe(8000);
    expect(numericObservations(audit).some(o => o.text.includes('本快照适用单价：¥80.00'))).toBe(true);
    for (const patch of [{ membership: null }, { membership: { ...member, status: 'non_member' } }, { membership: { ...member, price_minor: 9000 } }, { effectivePriceMinor: 10000 }]) {
      const modified = structuredClone(traces); const p = modified.find(t => t.tool === 'retail_get_promotions')!;
      p.data = { ...(p.data as object), ...patch };
      expect(() => auditMarginNumbers(normal, simulate(normal), modified)).toThrow('会员身份');
    }
    store.close(); store = new RetailStore(file); expect(store.snapshot().records).toEqual(records);
    store.import(MEMBER_DEMO_CSV, undefined, 'csv'); expect(store.snapshot().batches).toHaveLength(1);
    store.import(csv({ ...missing.row, membership: member }), undefined, 'csv');
    expect(store.snapshot().records.find(r => r.row.sku_id === 'MEMBER-MISSING')?.status).toBe('normal');
    expect(missing.row.membership?.status).toBe('unknown'); expect(missing.calculation.profitMinor).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unknown identity, invalid windows, missing price and discount conflicts never fall back to ordinary price', () => {
  for (const membership of [null, {}, { ...member, status: 'unknown' }, { ...member, segment_id: null },
    { ...member, price_minor: null }, { ...member, price_minor: 10001 }, { ...member, valid_from: null },
    { ...member, valid_to: null }, { ...member, valid_from: '2026-10-15' }, { ...member, valid_to: row.date },
    { ...member, valid_from: '2026-11-01', valid_to: '2026-10-01' }, { ...member, discount_policy: 'unknown' },
  ]) {
    const input = csv({ ...row, membership }); const r = previewCsv(input).valid[0]!;
    expect(r).toBeDefined(); expect(effectivePrice(r)).toBeNull(); expect(calculate(r).profitMinor).toBeNull();
  }
  for (const patch of [{ coupon_minor: 100 }, { full_reduction_minor: 100 }]) {
    const result = calculate({ ...row, ...patch }); expect(result.issues).toContain('会员价与券或满减互斥，不能同时计价');
    expect(result.profitMinor).toBeNull();
  }
  expect(calculate({ ...row, coupon_minor: 8001, membership: { ...member, discount_policy: 'stackable' } }).profitMinor).toBeNull();
  expect(effectivePrice({ ...row, membership: { ...member, valid_from: row.date, valid_to: '2026-10-15' } })).toBe(8000);
  expect(effectivePrice({ ...row, membership: { status: 'non_member' } })).toBe(10000);
  const old = previewCsv(DEMO_CSV); expect(old.mapping).not.toHaveProperty('membership');
  expect(previewCsv(DEMO_CSV, old.mapping).valid).toEqual(old.valid);
  const unknown = previewCsv(snapshotCsv({ ...row, membership: null })).valid[0]!;
  expect(unknown.membership).toBeNull(); expect(calculate(unknown).profitMinor).toBeNull();
});

test('malformed membership evidence and hidden columns are quarantined; same-key cohorts do not aggregate', () => {
  for (const membership of [[], { ...member, price_minor: 0 }, { ...member, price_minor: -1 }, { ...member, price_minor: 1.5 },
    { ...member, valid_from: '2026-02-30' }, { ...member, valid_to: '2026-13-01' }, { ...member, status: true },
    { ...member, currency: 'USD' }, { ...member, discount_policy: 'guess' }, { ...member, segment_id: '' }]) {
    expect(previewCsv(csv({ ...row, membership })).rejected).toHaveLength(1);
  }
  expect(previewCsv(csv(row).replace('{', 'broken{')).rejected[0]?.reason).toContain('有效 JSON');
  const mapping = previewCsv(MEMBER_DEMO_CSV).mapping;
  expect(() => previewCsv(MEMBER_DEMO_CSV, { ...mapping, membership: '' })).toThrow('必须保留');
  const second = csv({ ...row, membership: { ...member, segment_id: 'silver' } }).split('\n')[1];
  const duplicate = previewCsv(csv(row) + '\n' + second);
  expect(duplicate.valid).toHaveLength(1); expect(duplicate.duplicateCount).toBe(1);
});

test('member price replaces rather than discounts ordinary price; gift and pack costs are still counted once', () => {
  const bundle = previewCsv(BUNDLE_DEMO_CSV).valid[0]!;
  const r = { ...bundle, coupon_minor: 0, full_reduction_minor: 0, membership: { ...member, price_minor: 9000 },
    gift_policy: 'free_per_unit' as const, gift_cost_basis: 'additional' as const,
    gifts: [{ sku_id: 'SAMPLE', spec: '30ml', quantity: 2, unit_cost_minor: 500 }],
  };
  expect(calculate(r)).toMatchObject({ revenueMinor: 9000, profitMinor: 2000, marginBps: 2222 });
  const dir = mkdtempSync(join(tmpdir(), 'merqo-member-plan-')); const store = new RetailStore(join(dir, 'data.sqlite'));
  try {
    store.import(csv({ ...row, coupon_minor: 1000, membership: { ...member, discount_policy: 'stackable' } }), undefined, 'csv');
    expect(simulate(store.snapshot().records[0]!).find(s => s.kind === 'reduce_coupon')).toMatchObject({ couponMinor: 500, revenueMinor: 7500, profitMinor: 1500, marginBps: 2000, passed: true });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
