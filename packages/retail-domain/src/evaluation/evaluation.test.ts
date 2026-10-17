import { expect, test } from 'bun:test';
import { BUSINESS_CASES, FAULT_CASES } from './catalog';
import { runBusinessEvaluation, summarize } from './runner';

test('PRD catalog includes every mode and every variant with an inspectable contract', () => {
  expect(BUSINESS_CASES).toHaveLength(36);
  const categories = new Set(BUSINESS_CASES.map(c => c.category));
  expect(categories.size).toBe(12);
  for (const category of categories) {
    const cases = BUSINESS_CASES.filter(c => c.category === category);
    expect(cases.map(c => c.variant).sort()).toEqual(['anomaly', 'insufficient', 'normal']);
    expect(new Set(cases.map(c => JSON.stringify(c.input))).size).toBe(3);
  }
  expect(FAULT_CASES).toHaveLength(12);
  expect(new Set([...BUSINESS_CASES, ...FAULT_CASES].map(c => c.id)).size).toBe(48);
  for (const c of [...BUSINESS_CASES, ...FAULT_CASES]) {
    expect(c.rule.length).toBeGreaterThan(0);
    expect(c.requiredEvidence.length).toBeGreaterThan(0);
    expect(c.forbiddenActions.length).toBeGreaterThan(0);
    expect(c.allowedConclusions.length).toBeGreaterThan(0);
  }
});

test('unsupported and failed results never inflate passed count', () => {
  const base = { id: 'fixture', category: 'fixture', expected: 'normal', actual: 'unknown', evidence: null, durationMs: 0 };
  expect(summarize([{ ...base, status: 'passed' }, { ...base, status: 'failed' }, { ...base, status: 'unsupported' }]))
    .toEqual({ total: 3, passed: 1, failed: 1, unsupported: 1 });
});

test('fixed cases replay production rules and fault ledger, preserving release gaps', async () => {
  const report = await runBusinessEvaluation();
  const failures = report.results.filter(r => r.status === 'failed');
  expect(failures).toEqual([]);
  expect(report.summary).toEqual({ total: 48, passed: 36, failed: 0, unsupported: 12 });
  expect(report.releaseReady).toBe(false);
  expect(report.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  expect(report.results.filter(r => r.id.startsWith('fault.') && r.status === 'passed')).toHaveLength(12);
  expect(report.warningConfusion).toEqual({ truePositive: 3, falsePositive: 0, falseNegative: 0, trueNegative: 5, excluded: 7 });
  expect(Object.values(report.detectorMatrix).flatMap(row => Object.values(row)).reduce((a, b) => a + b, 0)).toBe(15);
}, 60000);
