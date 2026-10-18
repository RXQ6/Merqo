import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { AdsModelReportSchema, runReadonlyReview } from './investigations';
import { auditAdsNumbers, adsNumericObservations, SIGNAL_REVIEW_CRITERIA } from './ads-numeric';
import { readSignalTool, runSignalInvestigation, simulateSignal, SIGNAL_TOOLS } from './signal-investigations';
import type { DraftReport, Trace } from './investigations';
import type { SignalRecord } from './signals';

let dir: string, data: SignalStore, runs: InvestigationStore, record: SignalRecord;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-ads-facts-')); data = new SignalStore(join(dir, 'data.sqlite')); data.demo(); runs = new InvestigationStore(join(dir, 'runs.sqlite')); record = data.snapshot().records.find(r => r.kind === 'ads' && r.row.sku_id === 'TEA-500')!; });
afterEach(() => { runs.close(); data.close(); rmSync(dir, { recursive: true, force: true }); });
const traceFor = (r: SignalRecord): Trace[] => SIGNAL_TOOLS.ads.map(tool => ({ at: r.importedAt, stage: 'investigate', tool, evidenceId: `${r.id}:${tool}`, data: readSignalTool(r, tool) }));
const draft = (): DraftReport => ({ summary: '冻结快照仅支持同口径描述与条件算术，不构成预算建议', observations: [], hypotheses: [], unknowns: ['毛利、自然流量及需求响应尚缺'], alternatives: ['归因延迟或流量结构变化尚未核实'], options: [{ kind: 'observe', rationale: '核验缺失证据' }, { kind: 'reduce_budget', rationale: '仅比较条件算术，不主张实际变更或收益' }] });

test('real failed output is rejected across every model-authored numerical surface', () => {
  const failure = JSON.parse(readFileSync(new URL('../../../docs/verification/live-eval-2026-10-18/ads-2.json', import.meta.url), 'utf8'));
  expect(AdsModelReportSchema.safeParse({ ...draft(), summary: failure.run.report.summary }).success).toBe(false);
  for (const text of ['花费10万元', '花费十万元', '成交额１０００元', 'ROAS为1.8', '降预算百分之十']) {
    expect(AdsModelReportSchema.safeParse({ ...draft(), summary: text }).success).toBe(false);
    expect(AdsModelReportSchema.safeParse({ ...draft(), hypotheses: [{ text, evidenceIds: ['frozen'] }] }).success).toBe(false);
    expect(AdsModelReportSchema.safeParse({ ...draft(), unknowns: [text] }).success).toBe(false);
    expect(AdsModelReportSchema.safeParse({ ...draft(), alternatives: [text] }).success).toBe(false);
    expect(AdsModelReportSchema.safeParse({ ...draft(), options: [{ kind: 'observe', rationale: text }, draft().options[1]!] }).success).toBe(false);
  }
  expect(AdsModelReportSchema.safeParse(draft()).success).toBe(true);
});

test('CNY minor facts are displayed exactly once with correct yuan, ratio and percent units', () => {
  const audit = auditAdsNumbers(record, simulateSignal(record), traceFor(record));
  const text = adsNumericObservations(audit, record).map(o => o.text).join('\n');
  expect(audit.calculationFieldsComplete).toBe(true);
  expect(text).toContain('观察窗花费：¥1000.00（100000分）');
  expect(text).toContain('观察窗归因成交额：¥1800.00（180000分）');
  expect(text).toContain('条件方案花费：¥900.00（90000分）');
  expect(text).toContain('条件方案假设成交额：¥1620.00（162000分）');
  expect(text).toContain('观察窗ROAS：1.8'); expect(text).toContain('同口径ROAS相对变化：-40.00%');
  expect(text).not.toContain('万元');
});

test('missing, stale, altered evidence and wrong scenario do not reach a numeric report', () => {
  const events = traceFor(record), plans = simulateSignal(record);
  expect(() => auditAdsNumbers(record, plans, events.slice(1))).toThrow('核验拒绝');
  for (let i = 0; i < events.length; i++) {
    const bad = structuredClone(events); bad[i]!.data = { forged: true };
    expect(() => auditAdsNumbers(record, plans, bad)).toThrow('核验拒绝');
  }
  const bad = structuredClone(events); bad[0]!.evidenceId = 'other-scope';
  expect(() => auditAdsNumbers(record, plans, bad)).toThrow('核验拒绝');
  const stale = structuredClone(record); stale.metrics.roas = 100;
  expect(() => auditAdsNumbers(stale, plans, events)).toThrow('指标');
  expect(() => auditAdsNumbers(record, [{ ...plans[0]!, passed: false }], events)).toThrow('方案');
});

test('missing ads data remains unknown and no fixture Reviewer pass removes its blockers', async () => {
  const missing = data.snapshot().records.find(r => r.kind === 'ads' && r.row.sku_id === 'OAT-1000')!;
  const audit = auditAdsNumbers(missing, simulateSignal(missing), traceFor(missing));
  expect(audit.calculationFieldsComplete).toBe(false); expect(audit.facts.some(f => f.value === null)).toBe(true);
  const run = runs.createSignal(missing, 'model').run; let step = 0;
  const report = await runSignalInvestigation(run, async system => system.includes('串行只读 Reviewer') ? JSON.stringify({ verdict: 'passed', notes: ['unit fixture'] }) : JSON.stringify(step < 4 ? { tool: SIGNAL_TOOLS.ads[step++] } : { report: draft() }), async () => {});
  expect(report.reviewer.verdict).toBe('needs_evidence'); expect(report.scenarios.every(s => !s.passed)).toBe(true);
});

test('numeric Reviewer notes get one correction; rejected and needs-evidence verdicts remain independent', async () => {
  for (const verdict of ['rejected', 'needs_evidence', 'passed'] as const) {
    let calls = 0;
    const review = await runReadonlyReview(async () => JSON.stringify(calls++ === 0 ? { verdict: 'passed', notes: ['花费10万元'] } : { verdict, notes: ['缺口影响实际建议，分析与执行分开核验'] }), SIGNAL_REVIEW_CRITERIA, {}, () => {}, async () => {}, 'test', true);
    expect(calls).toBe(2); expect(review.verdict).toBe(verdict);
  }
  let calls = 0;
  await expect(runReadonlyReview(async () => { calls++; return JSON.stringify({ verdict: 'passed', notes: ['花费十万元'] }); }, SIGNAL_REVIEW_CRITERIA, {}, () => {}, async () => {}, 'test', true)).rejects.toThrow('notes');
  expect(calls).toBe(2);
});

test('persisted/exportable ads report uses the exact facts and disclosures seen by Reviewer', async () => {
  const run = runs.createSignal(record, 'model').run; let step = 0; let reviewed: DraftReport | undefined;
  const report = await runSignalInvestigation(run, async (system, prompt) => {
    if (system.includes('串行只读 Reviewer')) { reviewed = JSON.parse(prompt).context.draft; return JSON.stringify({ verdict: 'passed', notes: ['unit fixture'] }); }
    return JSON.stringify(step < 4 ? { tool: SIGNAL_TOOLS.ads[step++] } : { report: draft() });
  }, async event => { runs.update(run.id, { event }); });
  runs.update(run.id, { report }); runs.close(); runs = new InvestigationStore(join(dir, 'runs.sqlite'));
  const saved = runs.get(run.id).report!;
  expect(saved.adsNumericAudit).toEqual(report.adsNumericAudit); expect(saved.observations).toEqual(reviewed!.observations); expect(saved.unknowns).toEqual(reviewed!.unknowns);
  expect(saved.unknowns.some(t => t.includes('历史Case为空'))).toBe(true);
});

test('forged MCP amounts terminate before Reviewer; repeated model numeric prose cannot bypass the correction budget', async () => {
  const run = runs.createSignal(record, 'model').run; let step = 0, reviews = 0;
  const model = async (system: string) => {
    if (system.includes('串行只读 Reviewer')) { reviews++; return JSON.stringify({ verdict: 'passed', notes: ['unit fixture'] }); }
    return JSON.stringify(step < 4 ? { tool: SIGNAL_TOOLS.ads[step++] } : { report: draft() });
  };
  await expect(runSignalInvestigation(run, model, async () => {}, undefined, async tool => tool === 'retail_get_campaigns' ? { wrongUnits: true } : readSignalTool(record, tool))).rejects.toThrow('数值核验拒绝');
  expect(reviews).toBe(0);
  step = 0; let calls = 0;
  await expect(runSignalInvestigation(run, async () => {
    calls++;
    return JSON.stringify(step < 4 ? { tool: SIGNAL_TOOLS.ads[step++] } : { report: { ...draft(), summary: '花费十万元' } });
  }, async () => {})).rejects.toThrow('summary');
  expect(calls).toBe(7);
});
