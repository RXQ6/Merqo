import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestRetailWorker } from '../apps/electron/src/main/retail-worker';
import { RetailRequestSchema } from '../packages/retail-domain/src/operations';
import { ADS_DEMO, INVENTORY_DEMO, previewSignals } from '../packages/retail-domain/src/signals';
import { SignalStore } from '../packages/retail-domain/src/signal-store';

let root: string;
const dataset = (csv: string, count = 65): string => {
  const [header, ...rows] = csv.split('\n'); const fields = header!.split(',');
  return [header, ...Array.from({length:count}, (_, i) => {
    const row = rows[i % rows.length]!.split(',');
    row[fields.indexOf('sku_id')] = `PAGE-${String(i).padStart(3,'0')}`;
    row[fields.indexOf('shop_id')] = i === 64 ? 'tail-only-shop' : 'page-shop';
    return row.join(',');
  })].join('\n');
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'merqo-signal-worker-')); mkdirSync(join(root, 'retail'));
  const store = new SignalStore(join(root, 'retail/operations.sqlite.signals.sqlite'));
  try { store.import('inventory', dataset(INVENTORY_DEMO), undefined, 'csv'); store.import('ads', dataset(ADS_DEMO), undefined, 'csv'); } finally { store.close(); }
});
afterAll(() => rmSync(root, {recursive:true,force:true}));
const request = (input: unknown, op = 'signals_page') => requestRetailWorker({rootPath:root,name:'Isolated pagination check'}, 'pagination-test', input, op);

test('actual Bun worker returns a bounded page, full counts, and facets beyond that page', async () => {
  const reply = await request({op:'signals_page',kind:'inventory',source:'csv',limit:30});
  expect(reply.ok && reply.kind).toBe('signals_page');
  if (!reply.ok || reply.kind !== 'signals_page') throw new Error('Missing paged response');
  expect(reply.data.records).toHaveLength(30);
  expect(reply.data.pagination.total).toBe(65);
  expect(reply.data.pagination.summary.inventory).toEqual({total:65,normal:22,warning:22,missing:21});
  expect(reply.data.pagination.facets.shops).toContain('tail-only-shop');
  const second = await request({op:'signals_page',kind:'inventory',source:'csv',offset:30,limit:30});
  if (!second.ok || second.kind !== 'signals_page') throw new Error('Missing second page');
  expect(second.data.pagination.offset).toBe(30);
  expect(second.data.records.some(row=>reply.data.records.some(first=>first.id===row.id))).toBe(false);
}, 15000);

test('normal snapshot does not transport all signal rows and keeps both scope totals', async () => {
  const reply = await request({op:'snapshot',source:'csv',limit:30,offset:0,status:'all',search:''}, 'snapshot');
  if (!reply.ok || reply.kind !== 'snapshot') throw new Error('Missing snapshot');
  expect(reply.signals?.records).toHaveLength(30);
  expect(reply.signals?.pagination?.summary.inventory.total).toBe(65);
  expect(reply.signals?.pagination?.summary.ads.total).toBe(65);
}, 15000);

test('ads search and status use the full scope while invalid renderer fields reject', async () => {
  const reply = await request({op:'signals_page',kind:'ads',source:'csv',search:'PAGE-064',status:'normal',limit:30});
  if (!reply.ok || reply.kind !== 'signals_page') throw new Error('Missing ads page');
  expect(reply.data.pagination.total).toBe(1);
  expect(reply.data.records[0]!.row.sku_id).toBe('PAGE-064');
  expect(reply.data.pagination.summary.ads.total).toBe(65);
  for (const input of [{workspaceId:'other'}, {limit:10000}, {sql:'DELETE FROM signal_current'}]) {
    expect(RetailRequestSchema.safeParse({op:'signals_page',...input}).success).toBe(false);
  }
}, 15000);

test('import response remains bounded and legacy signal read retains scope counts', async () => {
  const csv = dataset(INVENTORY_DEMO);
  const imported = await request({op:'signals_import',kind:'inventory',csv,mapping:previewSignals('inventory',csv).mapping}, 'signals_import');
  if (!imported.ok || imported.kind !== 'signals') throw new Error('Missing import result');
  expect(imported.data.records).toHaveLength(30);
  expect(imported.notice).toContain('未重复写入');
  const legacy = await request({op:'signals'}, 'signals');
  if (!legacy.ok || legacy.kind !== 'signals') throw new Error('Missing signals result');
  expect(legacy.data.records).toHaveLength(30);
  expect(legacy.data.pagination?.total).toBe(130);
}, 15000);

test('large preview transports only samples while retaining full acceptance and rejection counts', async () => {
  const csv = dataset(INVENTORY_DEMO);
  const reply = await request({op:'signals_preview',kind:'inventory',csv}, 'signals_preview');
  if (!reply.ok || reply.kind !== 'signals_preview') throw new Error('Missing preview');
  expect(reply.data.valid).toHaveLength(30); expect(reply.data.validCount).toBe(65);
  const lines = csv.split('\n');
  const rejected = await request({op:'signals_preview',kind:'inventory',csv:lines.concat(Array(40).fill(lines[1]!)).join('\n')}, 'signals_preview');
  if (!rejected.ok || rejected.kind !== 'signals_preview') throw new Error('Missing rejection preview');
  expect(rejected.data.rejected).toHaveLength(30); expect(rejected.data.rejectedCount).toBe(40);
}, 15000);

test('100000-row preview fits the actual worker deadline and returns only 30 samples per scenario', async () => {
  for (const kind of ['inventory','ads'] as const) {
    const csv=dataset(kind==='inventory'?INVENTORY_DEMO:ADS_DEMO,100000);
    expect(csv.length).toBeGreaterThan(2000000);
    const reply=await request({op:'signals_preview',kind,csv},'signals_preview');
    if(!reply.ok||reply.kind!=='signals_preview')throw new Error('Missing capacity preview');
    expect(reply.data.validCount).toBe(100000); expect(reply.data.valid).toHaveLength(30);
    expect(reply.data.rejectedCount).toBe(0);
  }
}, 60000);
