import { beforeEach, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { calculateSignal } from './signals';
import type { InventoryRow, SignalRecord } from './signals';
import type { DraftReport, Trace } from './investigations';
import { decisionContract, InventoryModelReportSchema } from './investigations';
import { auditInventoryNumbers, inventoryNumericObservations } from './inventory-numeric';
import { readSignalTool, runSignalInvestigation, SIGNAL_TOOLS, simulateSignal } from './signal-investigations';

let dir: string, store: SignalStore, runs: InvestigationStore, record: SignalRecord;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-inventory-facts-')); store = new SignalStore(join(dir, 'data.sqlite')); store.demo(); runs = new InvestigationStore(join(dir, 'runs.sqlite')); record = store.snapshot().records.find(r => r.kind === 'inventory' && r.row.sku_id === 'TEA-500')!; });
afterEach(() => { runs.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
const events = (r: SignalRecord): Trace[] => SIGNAL_TOOLS.inventory.map(tool => ({ at: r.importedAt, stage: 'investigate', tool, evidenceId: `${r.id}:${tool}`, data: readSignalTool(r, tool) }));
const draft = (): DraftReport => ({ summary: '冻结库存只支持范围核对与条件算术', observations: [], hypotheses: [], unknowns: ['缺少实时状态与供应商承诺'], alternatives: ['活动或流量变化仍待核查'], options: [{ kind: 'observe', rationale: '核对缺口' }, { kind: 'replenish_draft', rationale: '条件量不代表实际可执行' }] });

test('all model-authored surfaces reject fabricated inventory amounts, units and dates', () => {
  for (const text of ['可售库存100件', '库存一百件', '库存１００件', '交期五天', '已经入库两箱', '覆盖为0.5天']) {
    expect(InventoryModelReportSchema.safeParse({ ...draft(), summary: text }).success).toBe(false);
    expect(InventoryModelReportSchema.safeParse({ ...draft(), hypotheses: [{ text, evidenceIds: ['frozen'] }] }).success).toBe(false);
    expect(InventoryModelReportSchema.safeParse({ ...draft(), unknowns: [text] }).success).toBe(false);
    expect(InventoryModelReportSchema.safeParse({ ...draft(), alternatives: [text] }).success).toBe(false);
    expect(InventoryModelReportSchema.safeParse({ ...draft(), options: [{ kind: 'observe', rationale: text }, draft().options[1]!] }).success).toBe(false);
  }
  expect(InventoryModelReportSchema.safeParse({ ...draft(), observations: [{ text: '库存一百件', evidenceIds: ['frozen'] }] }).success).toBe(false);
  expect(InventoryModelReportSchema.safeParse(draft()).success).toBe(true);
  const contract = decisionContract('replenish_draft', [], null);
  expect(InventoryModelReportSchema.safeParse(contract.reportExample.report).success).toBe(true);
  expect(contract.numericPolicy).toContain('空数组');
});

test('verified facts keep on-hand, reserved and inbound separate, with exact fraction context', () => {
  const audit = auditInventoryNumbers(record, simulateSignal(record), events(record));
  const observations = inventoryNumericObservations(audit, record), text = observations.map(o => o.text).join('\n');
  expect(audit.calculationFieldsComplete).toBe(true);
  expect(text).toContain('现存库存：50 件'); expect(text).toContain('已占用库存：10 件');
  expect(text).toContain('即时可售库存：40 件'); expect(text).toContain('在途库存（非即时可售）：100 件');
  expect(text).toContain('库存覆盖天数：280/140 天'); expect(text).toContain('常规补货交期：5 天');
  expect(text).toContain('条件补货草稿量：100 件'); expect(text).toContain('未创建采购单、未增加现货');
  expect(observations.every(o => o.evidenceIds.every(id => events(record).some(e => e.evidenceId === id)))).toBe(true);
  expect(simulateSignal(record)[1]!.passed).toBe(false);
});

test('wrong identity, missing/altered tools, stale metrics and tampered scenario cannot produce facts', () => {
  const trace = events(record), plans = simulateSignal(record);
  expect(() => auditInventoryNumbers(record, plans, trace.slice(1))).toThrow('核验拒绝');
  for (let i = 0; i < trace.length; i++) {
    const forged = structuredClone(trace); forged[i]!.data = { fake: true };
    expect(() => auditInventoryNumbers(record, plans, forged)).toThrow('核验拒绝');
  }
  const wrongId = structuredClone(trace); wrongId[2]!.evidenceId = 'other-shop:retail_get_inventory';
  expect(() => auditInventoryNumbers(record, plans, wrongId)).toThrow('核验拒绝');
  const stale = structuredClone(record); stale.metrics.available = 140;
  expect(() => auditInventoryNumbers(stale, plans, trace)).toThrow('指标');
  const changed = structuredClone(plans); changed[1]!.values!.proposedQuantity = 999;
  expect(() => auditInventoryNumbers(record, changed, trace)).toThrow('方案');
  const inboundAsAvailable = structuredClone(trace); (inboundAsAvailable[2]!.data as { metrics: { available: number } }).metrics.available = 140;
  expect(() => auditInventoryNumbers(record, plans, inboundAsAvailable)).toThrow('核验拒绝');
  const invalid = structuredClone(record); (invalid.row as InventoryRow).reserved = 1000;
  expect(() => auditInventoryNumbers(invalid, simulateSignal(invalid), events(invalid))).toThrow('指标');
});

test('zero or missing sales remains unknown, never a zero-day coverage or purchase commitment', () => {
  for (const sales of [0, null]) {
    const changed = structuredClone(record); (changed.row as InventoryRow).recent_sales_qty = sales;
    changed.metrics = calculateSignal('inventory', changed.row);
    const audit = auditInventoryNumbers(changed, simulateSignal(changed), events(changed));
    expect(audit.calculationFieldsComplete).toBe(false);
    expect(audit.facts.find(f => f.key === 'coverageDays')!.value).toBeNull();
    expect(audit.facts.find(f => f.key === 'proposedQuantity')!.value).toBeNull();
    expect(inventoryNumericObservations(audit, changed).map(o => o.text).join('')).toContain('库存覆盖天数：待补证');
    expect(simulateSignal(changed).every(s => !s.passed)).toBe(true);
  }
});

test('target stock rounds the rational upward once, avoiding floating-point one-unit over-order', () => {
  // 7 / 3 * 27 is 63.00000000000001 in IEEE doubles; ceil must still be 63.
  const changed = structuredClone(record), row = changed.row as InventoryRow;
  row.recent_sales_qty = 7; row.window_days = 3; row.baseline_window_days = 3; row.baseline_end_date = '2026-10-11'; row.lead_days = 25; row.inbound_qty = 0; row.inbound_eta = null;
  changed.metrics = calculateSignal('inventory', row);
  expect(simulateSignal(changed)[1]!.values!.targetStock).toBe(63);
  const audit = auditInventoryNumbers(changed, simulateSignal(changed), events(changed));
  expect(audit.facts.find(f => f.key === 'dailySales')!.fraction).toEqual({ numerator: 7, denominator: 3 });
  expect(audit.facts.find(f => f.key === 'targetStock')!.value).toBe(63);
});

test('production report exposes the same generated facts to Reviewer, export and durable storage', async () => {
  const run = runs.createSignal(record, 'model').run; let step = 0; let reviewed: unknown;
  const report = await runSignalInvestigation(run, async (system, prompt) => {
    if (system.includes('串行只读 Reviewer')) { reviewed = JSON.parse(prompt).context; return JSON.stringify({ verdict: 'passed', notes: ['只核验条件算术，实际执行仍须独立补证'] }); }
    return JSON.stringify(step < 4 ? { tool: SIGNAL_TOOLS.inventory[step++] } : { report: draft() });
  }, async event => { runs.update(run.id, { event }); });
  const context = reviewed as { draft: DraftReport; inventoryNumericAudit: unknown };
  expect(context.draft.observations).toEqual(report.observations); expect(context.inventoryNumericAudit).toEqual(report.inventoryNumericAudit);
  expect(report.reviewer.verdict).toBe('passed'); expect(report.scenarios[1]!.passed).toBe(false);
  runs.update(run.id, { report }); runs.close(); runs = new InvestigationStore(join(dir, 'runs.sqlite'));
  expect(runs.get(run.id).report!.inventoryNumericAudit).toEqual(report.inventoryNumericAudit);
});

test('a fabricated narrative is corrected within budget and invalid Reviewer quantities are never accepted', async () => {
  const run = runs.createSignal(record, 'model').run; let step = 0, reports = 0, reviews = 0;
  const report = await runSignalInvestigation(run, async system => {
    if (system.includes('串行只读 Reviewer')) { reviews++; return JSON.stringify(reviews === 1 ? { verdict: 'passed', notes: ['库存一百件'] } : { verdict: 'rejected', notes: ['没有证据支持报告的实际执行结论'] }); }
    if (step < 4) return JSON.stringify({ tool: SIGNAL_TOOLS.inventory[step++] });
    return JSON.stringify({ report: reports++ === 0 ? { ...draft(), summary: '库存一百件' } : draft() });
  }, async () => {});
  expect(reports).toBe(2); expect(reviews).toBe(2); expect(report.reviewer.verdict).toBe('rejected');
  expect(report.observations.map(o => o.text).join('')).not.toContain('库存一百件');
});
