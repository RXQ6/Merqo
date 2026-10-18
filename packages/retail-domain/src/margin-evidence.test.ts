import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import cases from '../../../fixtures/retail/margin-review-cases.json';
import { RetailStore } from './store';
import { InvestigationStore } from './investigation-store';
import { DEMO_CSV } from './operations';
import { runInvestigation, runReadonlyReview } from './investigations';
import { exportInvestigation } from './investigation-export';
import type { EvidenceRecord } from './operations';
import { marginReviewInput, MARGIN_REVIEW_SYSTEM } from './margin-review-evaluation';
import { assessMarginEvidence } from './margin-evidence';
import type { MarginReviewCase } from './margin-review-evaluation';
let dir: string, data: RetailStore, runs: InvestigationStore, record: EvidenceRecord;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-evidence-')); data = new RetailStore(join(dir, 'data.sqlite')); data.import(DEMO_CSV, undefined, 'demo'); record = data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!; runs = new InvestigationStore(join(dir, 'runs.sqlite')); });
afterEach(() => { data.close(); runs.close(); rmSync(dir, { recursive: true, force: true }); });
const input = (id: string) => marginReviewInput(record, cases.find(c => c.id === id) as MarginReviewCase);

test('historical disclosure distinguishes empty and present Case context without manufacturing causal support', () => {
  const audit = input('bounded-conditional').numericAudit;
  for (const present of [false, true]) {
    const assessment = assessMarginEvidence(audit, present);
    const history = assessment.requirements.find(r => r.id === 'historical_comparison')!;
    expect(history.detail).toContain(present ? '已有冻结历史 Case' : '冻结历史 Case 为空');
    expect(history.status).toBe('missing'); expect(assessment.causalReady).toBe(false); expect(assessment.realExecutionReady).toBe(false);
  }
});

test('complete snapshot supports arithmetic without manufacturing causal or execution evidence', () => {
  const context = input('bounded-conditional'), a = context.evidenceAssessment;
  expect(a.calculationReady).toBe(true); expect(a.causalReady).toBe(false); expect(a.realExecutionReady).toBe(false);
  expect(a.requirements).toHaveLength(6);
  expect(a.requirements.filter(r => r.status === 'supported').map(r => r.purpose)).toEqual(['calculation', 'calculation']);
  const ids = new Set(context.evidence.map(t => t.evidenceId));
  expect(a.requirements.every(r => r.evidenceIds.length && r.evidenceIds.every(id => ids.has(id)))).toBe(true);
});
test('missing calculation fields remain missing while infeasible plans remain distinguishable', () => {
  const missing = input('missing-cost');
  expect(missing.evidenceAssessment.calculationReady).toBe(false);
  expect(missing.evidenceAssessment.requirements[0]!.detail).toContain('单件商品成本');
  expect(missing.numericAudit.facts.find(f => f.key === 'unitCost')!.value).toBeNull();
  const infeasible = input('infeasible-is-still-analysis');
  expect(infeasible.evidenceAssessment.calculationReady).toBe(true);
  expect(infeasible.scenarios.every(s => !s.passed)).toBe(true);
  expect(infeasible.evidenceAssessment.realExecutionReady).toBe(false);
});
test('evaluation cases hide expected answers and keep citations inside frozen scope', () => {
  expect(cases).toHaveLength(10); expect(new Set(cases.map(c => c.id)).size).toBe(10);
  for (const sample of cases as MarginReviewCase[]) {
    const context = marginReviewInput(record, sample);
    expect(Object.hasOwn(context, 'expected')).toBe(false);
    expect(JSON.stringify(context)).not.toContain('"patch"');
    const ids = new Set(context.evidence.map(t => t.evidenceId));
    expect([...context.draft.observations, ...context.draft.hypotheses].every(c => c.evidenceIds.every(id => ids.has(id)))).toBe(true);
  }
});
test('review context does not override rejected or needs-evidence verdicts', async () => {
  for (const verdict of ['rejected', 'needs_evidence'] as const) {
    const review = await runReadonlyReview(async (_system, prompt) => {
      const payload = JSON.parse(prompt); expect(payload.context.evidenceAssessment.scope).toBe('conditional_snapshot_analysis');
      return JSON.stringify({ verdict, notes: ['具体结论缺乏证据'] });
    }, MARGIN_REVIEW_SYSTEM, input('bounded-conditional'), () => {}, async () => {}, 'test');
    expect(review.verdict).toBe(verdict);
  }
});
test('new replay reports persist assessment without upgrading old historical reports', async () => {
  const run = runs.create(record, 'replay').run;
  const report = await runInvestigation(run, null, async () => {});
  runs.update(run.id, { report }); runs.close(); runs = new InvestigationStore(join(dir, 'runs.sqlite'));
  expect(runs.listAll()[0]!.report!.evidenceAssessment).toEqual(report.evidenceAssessment);
  const saved = runs.listAll()[0]!;
  expect(JSON.parse(exportInvestigation(saved, 'json').content).investigation.report.evidenceAssessment).toEqual(report.evidenceAssessment);
  expect(exportInvestigation(saved, 'md').content).toContain('## 证据与补证清单');
  expect(report.reviewer.verdict).toBe('needs_evidence'); expect(report.reviewer.mode).toBe('replay');
  const { evidenceAssessment: _, ...legacy } = report;
  const old = runs.create(record, 'replay', true).run; runs.update(old.id, { report: legacy });
  expect(runs.listAll().find(r => r.id === old.id)!.report!.evidenceAssessment).toBeUndefined();
});
test('Reviewer sees the same final unknown disclosures that are persisted', async () => {
  const run = runs.create(record, 'model').run;
  const context = input('bounded-conditional'); let seen: string[] = []; let step = 0;
  const tools = ['retail_get_data_health','retail_get_sku_context','retail_get_promotions','retail_simulate_actions'];
  const report = await runInvestigation(run, async (system, prompt) => {
    if (system.includes('串行只读 Reviewer')) {
      seen = JSON.parse(prompt).context.draft.unknowns;
      return JSON.stringify({ verdict: 'needs_evidence', notes: ['保持待补证结论'] });
    }
    if (step < tools.length) return JSON.stringify({ tool: tools[step++] });
    return JSON.stringify({ report: { ...context.draft, observations: [] } });
  }, async () => {});
  expect(seen).toEqual(report.unknowns);
  expect(seen.some(t => t.startsWith('逐单优惠分摊：'))).toBe(true);
  expect(seen.some(t => t.includes('当前 CSV 仅支持快照字段'))).toBe(true);
  expect(report.reviewer.verdict).toBe('needs_evidence');
});
