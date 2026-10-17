import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { RetailStore } from './store';
import { InvestigationStore } from './investigation-store';
import { runInvestigation, simulate, readTool } from './investigations';
import type { DraftReport, Investigation, ModelPort, Trace } from './investigations';
import { DEMO_CSV, RetailRequestSchema } from './operations';

let dir: string; let data: RetailStore; let store: InvestigationStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'retail-investigation-')); data = new RetailStore(join(dir, 'data.sqlite')); data.import(DEMO_CSV, undefined, 'demo'); store = new InvestigationStore(join(dir, 'runs.sqlite')); });
afterEach(() => { data.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
function create(mode: 'model' | 'replay' = 'replay', sku = 'TEA-500'): Investigation {
  const record = data.snapshot().records.find(r => r.row.sku_id === sku);
  if (!record) throw new Error('fixture missing');
  return store.create(record, mode).run;
}
const toolNames = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'];
function modelFor(_run: Investigation, mutate?: (draft: DraftReport) => void): ModelPort {
  let step = 0;
  return async system => {
    if (system.includes('串行只读 Reviewer')) return JSON.stringify({ verdict: 'passed', notes: ['引用与计算一致，仍需执行前核验'] });
    const tool = toolNames[step++];
    if (tool) return JSON.stringify({ tool });
    const draft: DraftReport = { summary: '商家优惠叠加压缩商品毛利，不能推断净利润或销量因果', observations: [], hypotheses: [], unknowns: ['缺实时数据'], alternatives: ['成本口径可能有误'], options: [{ kind: 'observe', rationale: '先补证' }, { kind: 'reduce_coupon', rationale: '仅做条件测算' }] };
    mutate?.(draft); return JSON.stringify({ report: draft });
  };
}
describe('bounded retail investigation', () => {
  test('offline replay is labeled and scenarios independently recover 20% margin', async () => {
    const run = create(); const trace: Trace[] = [];
    const report = await runInvestigation(run, null, async t => { trace.push(t); });
    expect(report.summary).toContain('未调用模型'); expect(report.reviewer.mode).toBe('replay');
    expect(report.scenarios[0]?.marginBps).toBe(1429); expect(report.scenarios[0]?.passed).toBe(false);
    expect(report.scenarios[1]?.couponMinor).toBe(1500); expect(report.scenarios[1]?.revenueMinor).toBe(7500);
    expect(report.scenarios[1]?.profitMinor).toBe(1500); expect(report.scenarios[1]?.marginBps).toBe(2000);
    expect(trace.length).toBe(5);
  });
  test('model chooses four scoped tools then produces cited report and sequential review', async () => {
    const run = create('model'); const trace: Trace[] = [];
    const report = await runInvestigation(run, modelFor(run), async t => { trace.push(t); });
    expect(report.reviewer.mode).toBe('model'); expect(report.reviewer.verdict).toBe('passed');
    expect(trace.map(t => t.tool)).toEqual([...toolNames, 'readonly_reviewer']);
  });
  test('rejects nonexistent citations and refuses unsupported tools', async () => {
    const run = create('model');
    await expect(runInvestigation(run, modelFor(run, d => { d.hypotheses.push({text:'尚待验证的假设',evidenceIds:['fabricated']}); }), async () => {})).rejects.toThrow('不存在的证据');
    await expect(runInvestigation(run, async () => '{"tool":"execute_price","price":1}', async () => {})).rejects.toThrow();
  });
  test('requires all evidence tools and two distinct plans', async () => {
    const run = create('model');
    await expect(runInvestigation(run, modelFor(run, d => { d.options[1]!.kind = 'observe'; }), async () => {})).rejects.toThrow('两个不同方案');
    await expect(runInvestigation(run, async () => '{"report":{}}', async () => {})).rejects.toThrow();
  });
  test('tool loops and expired investigations terminate explicitly', async () => {
    const run = create('model'); let calls = 0;
    await expect(runInvestigation(run, async () => { calls++; return '{"tool":"retail_get_data_health"}'; }, async () => {})).rejects.toThrow('12 次');
    expect(calls).toBe(12);
    await expect(runInvestigation({ ...run, deadlineAt: '2000-01-01T00:00:00Z' }, modelFor(run), async () => {})).rejects.toThrow('5 分钟');
  });
  test('missing costs remain unknown, all calculated options fail closed', async () => {
    const run = create('model', 'SNACK-300');
    const report = await runInvestigation(run, modelFor(run), async () => {});
    expect(report.reviewer.verdict).toBe('needs_evidence');
    expect(report.scenarios.every(s => s.revenueMinor === null && !s.passed)).toBe(true);
  });
  test('coupon limits cannot manufacture a feasible plan', () => {
    const run = create();
    const options = simulate({ ...run.evidence, row: { ...run.evidence.row, cost_minor: 9900, coupon_minor: 0 } });
    expect(options[1]?.passed).toBe(false); expect(options[1]?.constraints.join('')).toContain('不足');
  });
  test('no model is never silently converted to replay', async () => {
    await expect(runInvestigation(create('model'), null, async () => {})).rejects.toThrow('配置有效模型');
  });
  test('duplicates reuse one run; retries create history and immutable evidence survives restart', async () => {
    const run = create(); expect(create().id).toBe(run.id);
    const report = await runInvestigation(run, null, async event => { store.update(run.id, { event }); });
    store.update(run.id, { report });
    const next = store.create(run.evidence, 'replay', true).run; expect(next.id).not.toBe(run.id);
    store.close(); store = new InvestigationStore(join(dir, 'runs.sqlite'));
    expect(store.list().length).toBe(2); expect(store.list().find(r => r.id === run.id)?.report?.scenarios[1]?.marginBps).toBe(2000);
    expect(store.list().find(r => r.id === run.id)?.evidence.snapshotHash).toBe(run.evidence.snapshotHash);
  });
  test('expired lease recovers as failed and late completion cannot overwrite it', async () => {
    const run = create();
    const db = new Database(join(dir, 'runs.sqlite')); db.query('UPDATE investigations SET deadline_at=? WHERE id=?').run('2000-01-01T00:00:00Z', run.id); db.close();
    expect(store.list()[0]?.state).toBe('failed');
    const report = await runInvestigation(run, null, async () => {});
    expect(store.update(run.id, { report }).state).toBe('failed');
    expect(store.create(run.evidence, 'replay', true).created).toBe(true);
  });
  test('renderer cannot forge worker updates or workspace paths', () => {
    expect(RetailRequestSchema.safeParse({ op: 'investigation_update', id: 'x', report: {} }).success).toBe(false);
    expect(RetailRequestSchema.safeParse({ op: 'investigate', recordId: 'x', mode: 'replay', workspaceId: 'other' }).success).toBe(false);
  });
  test('workspace concurrency limit is enforced across independent store connections', () => {
    create('model'); create('replay');
    const second = new InvestigationStore(join(dir, 'runs.sqlite'));
    try {
      const other = data.snapshot().records.find(r => r.row.sku_id === 'RICE-2')!;
      expect(() => second.create(other, 'model')).toThrow('两项调查');
      expect(second.create(create().evidence, 'replay').created).toBe(false);
    } finally { second.close(); }
  });
});

test('exact investigation lookup remains available beyond recent-list limits',()=>{
 const old=create();store.update(old.id,{error:'测试失败保留'});
 for(let n=0;n<51;n++){const run=store.create(old.evidence,'model',true).run;store.update(run.id,{error:'测试失败保留'});}
 expect(store.listAll()).toHaveLength(50);expect(store.get(old.id).id).toBe(old.id);expect(()=>store.get('missing')).toThrow('调查不存在');
 expect(RetailRequestSchema.safeParse({op:'investigations',id:old.id}).success).toBe(true);expect(RetailRequestSchema.safeParse({op:'investigations',id:old.id,recordId:old.recordId}).success).toBe(false);expect(RetailRequestSchema.safeParse({op:'investigations',id:'../other',workspaceId:'other'}).success).toBe(false);
});
test('Reviewer receives analysis-only scope and may still request evidence or reject',async()=>{
 for(const verdict of ['needs_evidence','rejected'] as const){const run=create('model');const base=modelFor(run);const report=await runInvestigation(run,async(system,prompt)=>{
  if(system.includes('串行只读 Reviewer')){expect(system).toContain('不得为走通演示而给passed');expect(JSON.parse(prompt).context.source).toBe('demo');return JSON.stringify({verdict,notes:['保留复核判断']});}return base(system,prompt);
 },async()=>{});expect(report.reviewer.verdict).toBe(verdict);store.update(run.id,{report});}
});

test('margin tools state per-sales-unit versus snapshot totals without altering arithmetic',()=>{
 const run=create();const result=readTool(run.evidence,'retail_get_sku_context') as {soldQty:number;calculationGrain:{salesUnit:string};calculation:{revenueMinor:number;totalRevenueMinor:number;profitMinor:number;totalProfitMinor:number}};
 expect(result.calculationGrain.salesUnit).toContain('SKU规格');expect(result.calculation.totalRevenueMinor).toBe(result.calculation.revenueMinor*result.soldQty);expect(result.calculation.totalProfitMinor).toBe(result.calculation.profitMinor*result.soldQty);
});

test('contradictory MCP amounts terminate before Reviewer and preserve tool trace',async()=>{
 const run=create('model');const base=modelFor(run);let reviews=0;const events:Trace[]=[];
 await expect(runInvestigation(run,async(system,prompt)=>{if(system.includes('串行只读 Reviewer'))reviews++;return base(system,prompt);},async t=>{events.push(t);},undefined,async name=>{const data=structuredClone(readTool(run.evidence,name as Parameters<typeof readTool>[1]));if(name==='retail_get_promotions')(data as {couponMinor:number}).couponMinor=1234;return data;})).rejects.toThrow('不一致');
 expect(reviews).toBe(0);expect(events.filter(e=>e.stage==='investigate')).toHaveLength(4);expect(events.some(e=>e.stage==='review')).toBe(false);
});
test('numeric audit survives report storage and legacy reports are not backfilled',async()=>{
 const run=create('model');const report=await runInvestigation(run,modelFor(run),async()=>{});store.update(run.id,{report});store.close();store=new InvestigationStore(join(dir,'runs.sqlite'));expect(store.get(run.id).report?.numericAudit).toEqual(report.numericAudit);expect(report.observations[2]?.text).toContain('商家券减少额：¥5.00');
 const old=structuredClone(report);delete old.numericAudit;const previous=store.create(run.evidence,'replay',true).run;store.update(previous.id,{report:old});expect(store.get(previous.id).report?.numericAudit).toBeUndefined();
});

test('model numeric prose is corrected within the existing budget, not silently accepted',async()=>{
 const run=create('model');const base=modelFor(run);let malformed=false;const events:Trace[]=[];
 const report=await runInvestigation(run,async(system,prompt)=>{const output=await base(system,prompt);const parsed=JSON.parse(output);if(parsed.report&&!malformed){malformed=true;parsed.report.summary='商家券减少200分';return JSON.stringify(parsed);}return output;},async e=>{events.push(e);});
 expect(events.filter(e=>e.stage==='contract')).toHaveLength(1);expect(report.summary).not.toContain('200');expect(report.numericAudit?.facts.find(f=>f.key==='couponReduction')?.value).toBe(500);expect(report.reviewer.verdict).toBe('passed');
});
