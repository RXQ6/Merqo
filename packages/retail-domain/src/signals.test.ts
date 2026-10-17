import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ADS_DEMO, INVENTORY_DEMO, INVENTORY_EXECUTION_DEMO, calculateSignal, previewSignals, InventorySchema, AdsSchema } from './signals';
import type { AdsRow, InventoryRow } from './signals';
import { SignalStore } from './signal-store';
import { RetailRequestSchema } from './operations';
const inv = () => InventorySchema.parse(previewSignals('inventory', INVENTORY_DEMO).valid[0]);
const ad = () => AdsSchema.parse(previewSignals('ads', ADS_DEMO).valid[0]);
function toCsv(r: InventoryRow | AdsRow): string { return Object.keys(r).join(',') + '\n' + Object.values(r).map(v => v ?? '').join(','); }
describe('inventory and advertising deterministic rules', () => {
  test('coverage excludes inbound and combines decline with lead time risk', () => {
    const m = calculateSignal('inventory', inv());
    expect(m.available).toBe(40); expect(m.coverageDays).toBe(2); expect(m.salesChangeBps).toBe(-3333);
    expect(m.flags.length).toBe(3); expect(m.issues).toEqual([]);
  });
  test('missing quantity, zero sales and unknown ETA never become zero certainty', () => {
    const row = inv();
    const unknown = calculateSignal('inventory', { ...row, recent_sales_qty: null, inbound_eta: null });
    expect(unknown.coverageDays).toBe(null); expect(unknown.issues.length).toBe(2);
    expect(calculateSignal('inventory', { ...row, recent_sales_qty: 0 }).coverageDays).toBe(null);
    expect(calculateSignal('inventory', { ...row, baseline_sales_qty: 0 }).salesChangeBps).toBe(null);
  });
  test('non-adjacent or unequal windows block sales and ROAS comparisons', () => {
    expect(calculateSignal('inventory', { ...inv(), baseline_end_date: '2026-10-01' }).salesChangeBps).toBe(null);
    expect(calculateSignal('ads', { ...ad(), baseline_window_days: 14 }).roasChangeBps).toBe(null);
  });
  test('very large stock coverage does not overflow date conversion', () => {
    const m = calculateSignal('inventory', { ...inv(), on_hand: 100000000, reserved: 0, recent_sales_qty: 1 });
    expect(m.coverageDays).toBe(700000000); expect(m.flags.some(f => f.startsWith('预计到货晚于'))).toBe(false);
  });
  test('ROAS 3 to 1.8 is a 40% relative drop, not a profit measure', () => {
    const m = calculateSignal('ads', ad());
    expect(m.roas).toBe(1.8); expect(m.baselineRoas).toBe(3); expect(m.roasChangeBps).toBe(-4000);
    expect(m.conversionBps).toBe(300); expect(m.baselineConversionBps).toBe(500); expect(m.flags.length).toBe(1);
  });
  test('mismatched attribution, missing revenue and zero denominator block conclusions', () => {
    for (const patch of [{ attribution_window: '1d_click' }, { attributed_revenue_minor: null }, { spend_minor: 0 }, { baseline_revenue_minor: 0 }]) {
      const m = calculateSignal('ads', { ...ad(), ...patch });
      expect(m.roasChangeBps).toBe(null); expect(m.flags.length).toBe(0); expect(m.issues.length).toBeGreaterThan(0);
    }
  });
  test('exact 20% boundary uses integer arithmetic even for large monetary values', () => {
    const row = { ...ad(), spend_minor: 100000000, baseline_spend_minor: 100000000, baseline_revenue_minor: 100000000, attributed_revenue_minor: 80000000 };
    expect(calculateSignal('ads', row).flags.length).toBe(1);
    expect(calculateSignal('ads', { ...row, attributed_revenue_minor: 80000001 }).flags.length).toBe(0);
  });
  test('currency and impossible counts are quarantined; missing numeric cells remain null', () => {
    expect(previewSignals('ads', toCsv({ ...ad(), currency: 'USD' } as unknown as AdsRow)).rejected.length).toBe(1);
    expect(previewSignals('ads', toCsv({ ...ad(), conversions: 1001 })).rejected.length).toBe(1);
    expect(previewSignals('inventory', toCsv({ ...inv(), reserved: 51 })).rejected.length).toBe(1);
    expect((previewSignals('inventory', toCsv({ ...inv(), recent_sales_qty: null })).valid[0] as InventoryRow).recent_sales_qty).toBe(null);
  });
  test('custom headers support manual mapping; duplicates are isolated', () => {
    const custom = INVENTORY_DEMO.replace('shop_id', '门店代码');
    const preview = previewSignals('inventory', custom); expect(preview.valid.length).toBe(0);
    const mapped = previewSignals('inventory', custom, { ...preview.mapping, shop_id: '门店代码' }); expect(mapped.valid.length).toBe(3);
    const lines = INVENTORY_DEMO.split('\n'); const repeated = previewSignals('inventory', [...lines, lines[1]].join('\n'));
    expect(repeated.valid.length).toBe(3); expect(repeated.rejected[0]?.reason).toContain('重复');
  });
  test('no renderer-specified database path or unsupported execution request', () => {
    expect(RetailRequestSchema.safeParse({ op: 'signals', path: 'other.sqlite' }).success).toBe(false);
    expect(RetailRequestSchema.safeParse({ op: 'signals_import', kind: 'execute', csv: 'x', mapping: {} }).success).toBe(false);
  });
});
let dir: string; let store: SignalStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retail-signals-')); store = new SignalStore(join(dir, 'signals.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
describe('signal persistence and evidence', () => {
  test('fresh concurrent worker initialization and duplicate scenario imports stay atomic', async () => {
    const worker = join(import.meta.dir, '../../..', 'scripts/retailpilot-data-worker.ts');
    const request = JSON.stringify({ op: 'signals_import', kind: 'inventory', csv: INVENTORY_DEMO, mapping: previewSignals('inventory', INVENTORY_DEMO).mapping });
    for (let attempt = 0; attempt < 3; attempt++) {
      const file = join(dir, `parallel-${attempt}.sqlite`);
      const run = async () => {
        const child = Bun.spawn([Bun.which('bun') || 'bun', worker, file], { stdin: new Blob([request]), stdout: 'pipe', stderr: 'pipe' });
        const raw = await new Response(child.stdout).text(); const error = await new Response(child.stderr).text();
        if (await child.exited !== 0) throw new Error(error || raw);
        expect(JSON.parse(raw).ok).toBe(true);
      };
      await Promise.all([run(), run()]);
      const persisted = new SignalStore(file + '.signals.sqlite');
      try { expect(persisted.snapshot().records.length).toBe(3); expect(persisted.snapshot().batches.length).toBe(1); }
      finally { persisted.close(); }
    }
  });
  test('demo has one warning, one normal and one evidence gap per scenario', () => {
    const s = store.demo(); expect(s.records.length).toBe(6);
    for (const kind of ['inventory', 'ads']) expect(s.records.filter(r => r.kind === kind).map(r => r.status).sort()).toEqual(['needs_evidence', 'normal', 'warning']);
    expect(s.records.every(r => r.hash.length === 64 && !!r.batchId && !!r.importedAt && !!r.ruleVersion)).toBe(true);
  });
  test('reimport is idempotent, source-separated and survives restart', () => {
    store.demo(); store.demo(); expect(store.snapshot().batches.length).toBe(2);
    store.import('inventory', INVENTORY_DEMO, undefined, 'csv'); store.close(); store = new SignalStore(join(dir, 'signals.sqlite'));
    expect(store.snapshot().records.length).toBe(9); expect(store.snapshot().records.filter(r => r.source === 'csv').length).toBe(3);
  });
  test('correction replaces current snapshot and retains immutable history', () => {
    store.import('inventory', toCsv(inv()), undefined, 'csv');
    store.import('inventory', toCsv({ ...inv(), on_hand: 1000, recent_sales_qty: 210, inbound_qty: 0, inbound_eta: null }), undefined, 'csv');
    const r = store.snapshot().records[0]!; expect(r.status).toBe('normal'); expect(r.metrics.available).toBe(990);
    const db = new Database(join(dir, 'signals.sqlite')); expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM signal_history').get()?.n).toBe(2); db.close();
  });
  test('partial rejection remains inspectable and invalid-only import creates no batch', () => {
    const lines = ADS_DEMO.split('\n'); const result = store.import('ads', [...lines, lines[1]].join('\n'), undefined, 'csv');
    expect(result.data.batches[0]?.rejected).toBe(1); expect(result.data.batches[0]?.errors[0]?.reason).toContain('重复');
    expect(() => store.import('ads', toCsv({ ...ad(), spend_minor: -1 }), undefined, 'csv')).toThrow('没有有效行'); expect(store.snapshot().batches.length).toBe(1);
  });
  test('SKU spec conflicts and different workspace databases stay isolated', () => {
    const other = new SignalStore(join(dir, 'other.sqlite'));
    try {
      store.import('inventory', toCsv(inv()), undefined, 'csv'); store.import('inventory', toCsv({ ...inv(), warehouse_id: 'WH-02', spec: '其他规格' }), undefined, 'csv');
      expect(store.snapshot().records.every(r => r.status === 'needs_evidence')).toBe(true); expect(other.snapshot().records).toEqual([]);
    } finally { other.close(); }
  });
});

test('explicit scenario reload restores archived variants without altering CSV or timestamping unchanged data',()=>{
 const folder=mkdtempSync(join(tmpdir(),'merqo-demo-reload-'));const store=new SignalStore(join(folder,'signals.sqlite'));try{store.demo();const original=store.snapshot().records.find(r=>r.kind==='inventory'&&r.row.sku_id==='TEA-500')!;store.import('inventory',INVENTORY_DEMO,undefined,'csv');const csv=store.snapshot().records.filter(r=>r.source==='csv');store.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo',true);expect((store.snapshot().records.find(r=>r.kind==='inventory'&&r.source==='demo'&&r.row.sku_id==='TEA-500')!.row as InventoryRow).lead_days).toBe(1);store.demo();const restored=store.snapshot().records.find(r=>r.kind==='inventory'&&r.source==='demo'&&r.row.sku_id==='TEA-500')!;expect((restored.row as InventoryRow).lead_days).toBe(5);expect(restored.id).not.toBe(original.id);const loaded=store.snapshot();store.demo();expect(store.snapshot()).toEqual(loaded);expect(store.snapshot().records.filter(r=>r.source==='csv')).toEqual(csv);expect(()=>store.import('inventory',INVENTORY_DEMO,undefined,'csv',true)).toThrow('仅内置');}finally{store.close();rmSync(folder,{recursive:true,force:true});}
});
