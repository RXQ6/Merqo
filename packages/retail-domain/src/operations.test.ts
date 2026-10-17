import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calculate, DEMO_CSV, exportCsv, FIELDS, parseCsv, previewCsv, RowSchema } from './operations.ts';
import { RetailStore } from './store.ts';

const rows = previewCsv(DEMO_CSV).valid;
const tea = rows.find(row => row.sku_id === 'TEA-500');
if (!tea) throw new Error('Missing fixture');
describe('deterministic retail calculations', () => {
  test('stacked merchant discounts produce 70 yuan revenue, 10 yuan profit and 14.29% margin', () => {
    const result = calculate(tea);
    expect(result.revenueMinor).toBe(7000); expect(result.profitMinor).toBe(1000);
    expect(result.marginBps).toBe(1429); expect(result.totalRevenueMinor).toBe(280000);
    expect(result.available).toBe(110);
  });
  test('confirmed additional platform settlement is added once', () => {
    const coffee = rows.find(row => row.sku_id === 'COFFEE-12'); if (!coffee) throw new Error('fixture');
    expect(calculate(coffee).revenueMinor).toBe(9000); expect(calculate(coffee).marginBps).toBe(3333);
  });
  test('missing cost, ambiguous subsidy and SKU conflict cannot produce definite margin', () => {
    for (const row of [{ ...tea, cost_minor: null }, { ...tea, subsidy_minor: 500, subsidy_funder: 'unknown' as const }, { ...tea, subsidy_minor: 500, subsidy_funder: 'merchant' as const }]) {
      expect(calculate(row).revenueMinor).toBeNull(); expect(calculate(row).marginBps).toBeNull();
    }
    expect(calculate(tea, true).issues).toContain('同店铺同渠道 SKU 出现多种规格，须人工核对映射');
  });
  test('zero revenue refuses ratio and negative profit stays negative', () => {
    expect(calculate({ ...tea, coupon_minor: 10000, full_reduction_minor: 0 }).marginBps).toBeNull();
    expect(calculate({ ...tea, cost_minor: 8000 }).profitMinor).toBe(-1000);
  });
  test('calendar validity, money precision and physical stock constraints are enforced', () => {
    for (const row of [{ ...tea, date: '2026-02-30' }, { ...tea, date: '2026-99-99' }, { ...tea, list_price_minor: 1.1 }, { ...tea, reserved: 121 }, { ...tea, coupon_minor: 10001 }]) expect(RowSchema.safeParse(row).success).toBe(false);
  });
});
describe('CSV validation', () => {
  test('reads BOM, CRLF, quoted comma, escaped quotes and multiline cells', () => {
    expect(parseCsv('\uFEFFa,b\r\n"name, with ""quote""","line1\nline2"')).toEqual([['a','b'],['name, with "quote"','line1\nline2']]);
  });
  test('rejects unclosed quotes, duplicate headers and excess cells', () => {
    expect(() => parseCsv('a,b\n"unclosed')).toThrow();
    expect(() => previewCsv('a,a\n1,2')).toThrow('表头');
    expect(previewCsv(DEMO_CSV + '\n1,2,3').rejected.length).toBe(1);
  });
  test('quarantines invalid and duplicate rows without turning blanks into zero', () => {
    const header = FIELDS.join(',');
    const first = DEMO_CSV.split('\r\n')[1]; if (!first) throw new Error('fixture');
    const preview = previewCsv([header, first, first, first.replace(',CNY,10000,', ',USD,10000,')].join('\n'));
    expect(preview.valid.length).toBe(1); expect(preview.duplicateCount).toBe(1); expect(preview.rejected.length).toBe(2);
    expect(previewCsv(DEMO_CSV.replace(',CNY,10000,', ',CNY,,')).rejected.length).toBeGreaterThan(0);
  });
  test('supports explicit renamed-column mapping and rejects reused columns', () => {
    const csv = DEMO_CSV.replace('product_name', '商品名');
    const auto = previewCsv(csv); expect(auto.valid.length).toBe(0);
    expect(previewCsv(csv, { ...auto.mapping, product_name: '商品名' }).valid.length).toBe(6);
    expect(() => previewCsv(DEMO_CSV, { ...previewCsv(DEMO_CSV).mapping, spec: 'sku_id' })).toThrow('多个字段');
  });
});
describe('SQLite retail lifecycle', () => {
  let folder: string;
  let store: RetailStore;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'retail-m1-')); store = new RetailStore(join(folder, 'operations.sqlite'), '验收 Workspace'); });
  afterEach(() => { store.close(); rmSync(folder, { recursive: true, force: true }); });
  test('demo produces exactly 2 warnings, 2 evidence gaps, 2 normal rows and reproducible totals', () => {
    store.request({ op: 'demo' }); const data = store.snapshot();
    expect(data.records.length).toBe(6);
    expect(data.records.filter(row => row.status === 'low_margin').length).toBe(2);
    expect(data.records.filter(row => row.status === 'needs_evidence').length).toBe(2);
    const eligible = data.records.filter(row => row.status !== 'needs_evidence');
    expect(eligible.reduce((sum, row) => sum + (row.calculation.totalRevenueMinor ?? 0), 0)).toBe(712500);
    expect(eligible.reduce((sum, row) => sum + (row.calculation.totalProfitMinor ?? 0), 0)).toBe(176500);
  });
  test('repeated imports are idempotent and survive worker/database restart', () => {
    store.request({ op: 'demo' }); store.request({ op: 'demo' });
    expect(store.snapshot().batches.length).toBe(1);
    store.close(); store = new RetailStore(join(folder, 'operations.sqlite'));
    expect(store.snapshot().records.length).toBe(6); expect(store.snapshot().batches.length).toBe(1);
  });
  test('two concurrent workers importing the same CSV commit one batch', async () => {
    const worker = join(import.meta.dir, '../../..', 'scripts/retailpilot-data-worker.ts');
    const database = join(folder, 'operations.sqlite');
    const input = JSON.stringify({ op: 'import', csv: DEMO_CSV, mapping: previewCsv(DEMO_CSV).mapping });
    const execute = async () => {
      const process = Bun.spawn([Bun.which('bun') || 'bun', worker, database], { stdin: new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
      const output = await new Response(process.stdout).text();
      const errors = await new Response(process.stderr).text();
      const status = await process.exited;
      if (status !== 0) throw new Error(errors || output || 'worker failed');
      const reply = JSON.parse(output);
      expect(status).toBe(0); expect(reply.ok).toBe(true);
    };
    await Promise.all([execute(), execute()]);
    expect(store.snapshot().records.length).toBe(6); expect(store.snapshot().batches.length).toBe(1);
  });
  test('corrections replace current row while previous batch is retained', () => {
    store.import(DEMO_CSV, undefined, 'csv');
    const old = store.snapshot().records.find(row => row.row.sku_id === 'TEA-500');
    store.import(DEMO_CSV.replace(',CNY,10000,2000,1000,', ',CNY,10000,0,0,'), undefined, 'csv');
    const current = store.snapshot().records.find(row => row.row.sku_id === 'TEA-500');
    expect(current?.status).toBe('normal'); expect(current?.id).not.toBe(old?.id);
    expect(store.snapshot().records.length).toBe(6); expect(store.snapshot().batches.length).toBe(2);
  });
  test('explicit built-in reload restores corrected demo rows with new identity but retains CSV and history',()=>{
    store.request({op:'demo'});const original=store.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;store.import(DEMO_CSV,undefined,'csv');const csv=store.snapshot().records.filter(r=>r.source==='csv');store.import(DEMO_CSV.replace(',CNY,10000,2000,1000,',',CNY,10000,0,0,'),undefined,'demo');
    store.request({op:'demo'});const restored=store.snapshot().records.find(r=>r.source==='demo'&&r.row.sku_id==='TEA-500')!;expect(restored.row.coupon_minor).toBe(2000);expect(restored.id).not.toBe(original.id);expect(store.snapshot().records.filter(r=>r.source==='csv')).toEqual(csv);const count=store.snapshot().batches.length;store.request({op:'demo'});expect(store.snapshot().batches).toHaveLength(count);expect(()=>store.import(DEMO_CSV,undefined,'csv',true)).toThrow('仅内置');
  });
  test('all-invalid imports do not create batches, and demo stays separate from user CSV', () => {
    expect(() => store.import('x,y\n1,2', undefined, 'csv')).toThrow();
    expect(store.snapshot().batches.length).toBe(0);
    store.request({ op: 'demo' }); store.import(DEMO_CSV, undefined, 'csv');
    expect(store.snapshot().records.filter(row => row.source === 'demo').length).toBe(6);
    expect(store.snapshot().records.filter(row => row.source === 'csv').length).toBe(6);
  });
  test('partial rejection reports are persisted and exported values resist spreadsheet formulas', () => {
    const input = DEMO_CSV + '\ninvalid,row';
    store.import(input, undefined, 'csv'); const data = store.snapshot();
    expect(data.batches[0]?.errors[0]?.reason).toContain('列数');
    const row = data.records[0]; if (!row) throw new Error('fixture');
    expect(exportCsv([{ ...row, row: { ...row.row, product_name: '=HYPERLINK("bad")' } }])).toContain("'=HYPERLINK");
  });
  test('store paths isolate workspaces and SKU specification conflicts block calculations', () => {
    store.import(DEMO_CSV, undefined, 'csv');
    const other = new RetailStore(join(folder, 'other', 'operations.sqlite'));
    expect(other.snapshot().records.length).toBe(0); other.close();
    const changed = DEMO_CSV.replaceAll('2026-10-14', '2026-10-13').replace('500ml × 6瓶', '500ml × 12瓶');
    store.import(changed, undefined, 'csv');
    const conflicted = store.snapshot().records.filter(row => row.row.sku_id === 'TEA-500');
    expect(conflicted.length).toBe(2); expect(conflicted.every(row => row.status === 'needs_evidence')).toBe(true);
  });
});
