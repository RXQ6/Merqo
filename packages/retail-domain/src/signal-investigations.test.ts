import { beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { runSignalInvestigation, simulateSignal, readSignalTool, SIGNAL_TOOLS } from './signal-investigations';
import { loadReadonlyScope, callReadonlyTool } from './readonly-tools';
import { INVENTORY_DEMO } from './signals';
import type { SignalInvestigation, DraftReport, ModelPort } from './investigations';
let dir: string; let data: SignalStore; let runs: InvestigationStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-m2-')); mkdirSync(join(dir, 'retail')); data = new SignalStore(join(dir, 'retail/operations.sqlite.signals.sqlite')); data.demo(); runs = new InvestigationStore(join(dir, 'runs.sqlite')); });
afterEach(() => { data.close(); runs.close(); rmSync(dir, { recursive: true, force: true }); });
function create(kind: 'inventory' | 'ads', mode: 'model' | 'replay' = 'replay', sku = 'TEA-500') { return runs.createSignal(data.snapshot().records.find(r => r.kind === kind && r.row.sku_id === sku)!, mode).run; }
function fixture(run: SignalInvestigation, mutate?: (d: DraftReport) => void, verdict = 'passed'): ModelPort {
  let step = 0;
  return async system => {
    if (system.includes('串行只读 Reviewer')) return JSON.stringify({ verdict, notes: ['本地契约复核，非真实模型'] });
    const tool = SIGNAL_TOOLS[run.scenario][step++]; if (tool) return JSON.stringify({ tool });
    const draft: DraftReport = { summary: '有界调查', observations: [], hypotheses: [], unknowns: ['实时数据未知'], alternatives: ['归因或口径变化'], options: [{ kind: 'observe', rationale: '核验' }, { kind: run.scenario === 'ads' ? 'reduce_budget' : 'replenish_draft', rationale: '条件方案' }] };
    mutate?.(draft); return JSON.stringify({ report: draft });
  };
}
for (const kind of ['inventory', 'ads'] as const) {
  test(`${kind}: replay trace is explicit and frozen report survives restart`, async () => {
    const run = create(kind); const report = await runSignalInvestigation(run, null, async event => { runs.update(run.id, { event }); });
    runs.update(run.id, { report }); runs.close(); runs = new InvestigationStore(join(dir, 'runs.sqlite'));
    expect(report.summary).toContain('未调用模型'); expect(report.reviewer.mode).toBe('replay');
    expect(runs.listAll()[0]?.trace).toHaveLength(5); expect(runs.listAll()[0]?.report).toEqual(report); expect(runs.list()).toHaveLength(0);
  });
  test(`${kind}: model requires scoped evidence and correct options before serial review`, async () => {
    const run = create(kind, 'model'); const report = await runSignalInvestigation(run, fixture(run), async () => {});
    expect(report.reviewer.verdict).toBe('passed');
    await expect(runSignalInvestigation(run, fixture(run, d => { d.hypotheses = [{ text: '待验证解释', evidenceIds: ['fake'] }]; }), async () => {})).rejects.toThrow('不存在');
    await expect(runSignalInvestigation(run, fixture(run, d => { d.options[1]!.kind = 'reduce_coupon'; }), async () => {})).rejects.toThrow('report.options');
    expect((await runSignalInvestigation(run, fixture(run, undefined, 'rejected'), async () => {})).reviewer.verdict).toBe('rejected');
  });
  test(`${kind}: incomplete evidence blocks conditional quantities despite reviewer pass`, async () => {
    const run = create(kind, 'model', 'OAT-1000'); const report = await runSignalInvestigation(run, fixture(run), async () => {});
    expect(report.reviewer.verdict).toBe('needs_evidence'); expect(report.scenarios.every(s => !s.passed)).toBe(true);
    expect(kind === 'inventory' ? report.scenarios[1]?.values?.proposedQuantity : report.scenarios[1]?.values?.proposedSpendMinor).toBeNull();
  });
}
test('inventory: late inbound and lead cannot erase pre-arrival gap', () => {
  const plans = simulateSignal(create('inventory').evidence); expect(plans[1]?.values?.proposedQuantity).toBe(100);
  expect(plans[1]?.values?.timelyInbound).toBe(0); expect(plans[1]?.passed).toBe(false); expect(plans[1]?.constraints.join('')).toContain('到货前缺口');
});
test('ads: reduced spend scales attributed revenue without improving ROAS', () => {
  const plan = simulateSignal(create('ads').evidence)[1]!;
  expect(plan.values?.proposedSpendMinor).toBe(90000); expect(plan.values?.hypotheticalRevenueMinor).toBe(162000); expect(plan.values?.roas).toBe(1.8);
});
test('bounded loop, deadline, absent model and cross-scenario tools reject', async () => {
  const run = create('inventory', 'model'); let calls = 0;
  await expect(runSignalInvestigation(run, async () => { calls++; return '{"tool":"retail_get_inventory"}'; }, async () => {})).rejects.toThrow('12 次'); expect(calls).toBe(12);
  await expect(runSignalInvestigation({ ...run, deadlineAt: '2000-01-01' }, fixture(run), async () => {})).rejects.toThrow('5 分钟');
  await expect(runSignalInvestigation(run, null, async () => {})).rejects.toThrow('配置有效模型');
  expect(() => readSignalTool(run.evidence, 'retail_get_campaigns')).toThrow('不允许');
  await expect(runSignalInvestigation(run, async () => '{"tool":"retail_get_inventory","workspace":"other"}', async () => {})).rejects.toThrow();
});
test('readonly connector freezes launch evidence across later imports and denies writes', () => {
  const record = create('inventory').evidence; const scope = loadReadonlyScope(dir, 'inventory', record.id);
  data.import('inventory', INVENTORY_DEMO.replace(',50,10,100,', ',500,10,100,'), undefined, 'demo');
  expect(scope.evidence).toEqual(record); expect(JSON.stringify(callReadonlyTool(scope, 'retail_get_inventory'))).toContain(record.hash);
  expect(() => callReadonlyTool(scope, 'execute_purchase')).toThrow('白名单'); expect(() => loadReadonlyScope(dir, 'ads', record.id)).toThrow('无此场景');
  const readonly = new SignalStore(join(dir, 'retail/operations.sqlite.signals.sqlite'), true);
  try { expect(() => readonly.demo()).toThrow('只读'); } finally { readonly.close(); }
});

test('contract corrections are bounded, counted, and never execute malformed scope requests', async () => {
  const run = create('inventory', 'model'); const good = fixture(run); let first = true; const events: string[] = [];
  const report = await runSignalInvestigation(run, async (system, prompt) => {
    if (first) { first = false; return '{"tool":"retail_get_inventory","scope":{"shop":"other"}}'; }
    return good(system, prompt);
  }, async e => { events.push(e.tool); });
  expect(report.reviewer.verdict).toBe('passed'); expect(events.filter(t => t === 'output_contract')).toHaveLength(1); expect(events.filter(t => t === 'retail_get_inventory')).toHaveLength(1);
  let calls = 0; await expect(runSignalInvestigation(run, async () => { calls++; return 'invalid JSON'; }, async () => {})).rejects.toThrow(); expect(calls).toBe(3);
});

test('Reviewer format failure gets one scoped correction without rerunning investigation or accepting invalid verdict', async () => {
  const run = create('ads', 'model'); const good = fixture(run); let reviews = 0; const tools: string[] = [];
  const report = await runSignalInvestigation(run, async (system, prompt) => {
    if (system.includes('串行只读 Reviewer') && reviews++ === 0) return '{"verdict":"passed","notes":[{"text":"wrong shape"}]}';
    return good(system, prompt);
  }, async event => { tools.push(event.tool); });
  expect(reviews).toBe(2); expect(report.reviewer.verdict).toBe('passed'); expect(tools.filter(t => t === 'review_output_contract')).toHaveLength(1); expect(tools.filter(t => t === 'retail_get_campaigns')).toHaveLength(1);
});
test('repeated malformed review remains failed and explains the field instead of accepting a report', async () => {
  const run = create('ads', 'model'); const good = fixture(run); let reviews = 0;
  await expect(runSignalInvestigation(run, async (system, prompt) => {
    if (system.includes('串行只读 Reviewer')) { reviews++; return '{"verdict":"passed","notes":[{"secret_field":"untrusted-value"}]}'; }
    return good(system, prompt);
  }, async () => {})).rejects.toThrow('Reviewer复核输出格式校验失败（notes.[0]');
  expect(reviews).toBe(2);
});
test('missing evidence never upgrades a rejected Reviewer verdict', async () => {
  const run = create('ads', 'model', 'OAT-1000');
  const report = await runSignalInvestigation(run, fixture(run, undefined, 'rejected'), async () => {});
  expect(report.reviewer.verdict).toBe('rejected'); expect(report.scenarios.every(s => !s.passed)).toBe(true);
});
