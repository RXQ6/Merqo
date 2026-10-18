import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFER_DEMO_CSV, DEMO_CSV, calculate, previewCsv, snapshotCsv } from './operations';
import { selectOffers } from './offers';
import { RetailStore } from './store';
import { auditMarginNumbers, numericObservations } from './margin-numeric';
import { readTool, simulate, type Trace } from './investigations';

const row = previewCsv(OFFER_DEMO_CSV).valid[0]!;
const quote = row.offers![0]!;

test('public offer selection excludes unavailable low prices and ties deterministically without mutating inputs', () => {
  const input = { ...row, offers: [{ ...quote, offer_id: 'out', price_minor: 100, available: false },
    { ...quote, offer_id: 'b', price_minor: 3000 }, { ...quote, offer_id: 'a', price_minor: 3000 }] };
  const original = structuredClone(input);
  const result = selectOffers(input);
  expect(result).toMatchObject({ status: 'selected', selectedOfferId: 'a', selectedPriceMinor: 3000, eligibleOfferIds: ['a', 'b'] });
  expect(result.excluded).toContainEqual({ offerId: 'out', reason: '报价明确无货' });
  expect(selectOffers({ ...input, offers: [...input.offers].reverse() })).toMatchObject({ selectedOfferId: 'a', selectedPriceMinor: 3000 });
  expect(input).toEqual(original); expect(calculate(input).revenueMinor).toBe(8000);
});

test('only exact scope/date public offers compare; unknown matched availability or audience blocks certainty', () => {
  const bad = [{ shop_id: 'other' }, { channel: 'other' }, { sku_id: 'other' }, { spec: 'different' },
    { observed_on: '2026-10-13' }, { audience: 'member' as const }];
  const offers = bad.map((patch, i) => ({ ...quote, ...patch, offer_id: `wrong-${i}`, price_minor: 1 }));
  const result = selectOffers({ ...row, offers: [...offers, quote] });
  expect(result.selectedPriceMinor).toBe(1000); expect(result.excluded).toHaveLength(6);
  for (const patch of [{ available: null }, { audience: 'unknown' as const }]) for (const price_minor of [100, 9999]) {
    const r = selectOffers({ ...row, offers: [quote, { ...quote, ...patch, price_minor, offer_id: 'unknown' }] });
    expect(r.status).toBe('needs_evidence'); expect(r.selectedPriceMinor).toBeNull(); expect(r.eligibleOfferIds).toEqual([quote.offer_id]);
  }
  expect(selectOffers({ ...row, offers: [quote, { ...quote, price_minor: 9999 }] }).status).toBe('needs_evidence');
  for (const offers of [[], null, [{ ...quote, available: false }], [{ ...quote, observed_on: '2026-10-13' }]]) {
    const r = { ...row, offers }; expect(selectOffers(r).status).toBe('needs_evidence'); expect(calculate(r).profitMinor).toBeNull();
  }
  const legacy = previewCsv(DEMO_CSV); expect(legacy.mapping).not.toHaveProperty('offers');
  expect(selectOffers(legacy.valid[0]!).status).toBe('not_provided');
  expect(previewCsv(DEMO_CSV, legacy.mapping).valid).toEqual(legacy.valid);
  const explicitUnknown = previewCsv(snapshotCsv({ ...row, offers: null })).valid[0]!;
  expect(explicitUnknown.offers).toBeNull(); expect(calculate(explicitUnknown).profitMinor).toBeNull();
});

test('invalid offer fields and hidden mappings quarantine rather than guess scope or prices', () => {
  for (const patch of [{ price_minor: 0 }, { price_minor: -1 }, { price_minor: 0.1 }, { price_minor: 100_000_001 },
    { available: 'true' }, { sku_id: undefined }, { spec: '' }, { offer_id: '' }, { currency: 'USD' },
    { observed_on: '2026-02-30' }, { observed_on: '2026-10-14T00:00:00Z' }, { audience: 'guess' }, { script: 'write' }]) {
    expect(previewCsv(snapshotCsv({ ...row, offers: [{ ...quote, ...patch }] })).rejected).toHaveLength(1);
  }
  expect(previewCsv(snapshotCsv({ ...row, offers: Array.from({ length: 101 }, (_, i) => ({ ...quote, offer_id: String(i) })) })).rejected).toHaveLength(1);
  expect(previewCsv(snapshotCsv(row).replace('[{', 'broken[{')).rejected[0]?.reason).toContain('有效 JSON');
  const mapping = previewCsv(OFFER_DEMO_CSV).mapping;
  expect(() => previewCsv(OFFER_DEMO_CSV, { ...mapping, offers: '' })).toThrow('必须保留');
});

test('production import, frozen tools, numeric audit and restart preserve selection without changing sales price', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merqo-offers-')); const file = join(dir, 'data.sqlite'); let store = new RetailStore(file);
  try {
    store.import(OFFER_DEMO_CSV, previewCsv(OFFER_DEMO_CSV).mapping, 'csv');
    const records = store.snapshot().records;
    expect(records.filter(r => r.status === 'normal')).toHaveLength(2);
    const filtered = records.find(r => r.row.sku_id === 'OFFER-FILTERED')!;
    const unknown = records.find(r => r.row.sku_id === 'OFFER-UNKNOWN')!;
    expect(selectOffers(filtered.row).selectedPriceMinor).toBe(3000);
    expect(filtered.calculation).toMatchObject({ revenueMinor: 8000, profitMinor: 2000, marginBps: 2500 });
    expect(unknown.status).toBe('needs_evidence'); expect(simulate(unknown).every(s => !s.passed)).toBe(true);
    const traces: Trace[] = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'].map(tool => ({
      at: new Date().toISOString(), stage: 'investigate', tool, evidenceId: `${filtered.id}:${tool}`, data: readTool(filtered, tool as Parameters<typeof readTool>[1]),
    }));
    const audit = auditMarginNumbers(filtered, simulate(filtered), traces);
    expect(audit.facts.find(f => f.key === 'referencePrice')?.value).toBe(3000);
    expect(numericObservations(audit).some(o => o.text.includes('参考可售报价（非成交价）：¥30.00'))).toBe(true);
    for (const patch of [{ offers: [] }, { offerSelection: { ...selectOffers(filtered.row), selectedPriceMinor: 1000 } },
      { offers: filtered.row.offers!.map(o => ({ ...o, available: true })) }]) {
      const trace = structuredClone(traces); const p = trace.find(t => t.tool === 'retail_get_promotions')!;
      p.data = { ...(p.data as object), ...patch };
      expect(() => auditMarginNumbers(filtered, simulate(filtered), trace)).toThrow('报价范围');
    }
    store.close(); store = new RetailStore(file); expect(store.snapshot().records).toEqual(records);
    store.import(OFFER_DEMO_CSV, undefined, 'csv'); expect(store.snapshot().batches).toHaveLength(1);
    store.import(snapshotCsv({ ...unknown.row, offers: unknown.row.offers!.map(o => ({ ...o, available: true })) }), undefined, 'csv');
    expect(store.snapshot().records.find(r => r.row.sku_id === 'OFFER-UNKNOWN')?.status).toBe('normal');
    expect(unknown.row.offers![0]?.available).toBeNull(); expect(unknown.calculation.profitMinor).toBeNull();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
