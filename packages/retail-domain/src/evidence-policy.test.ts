import { expect, test } from 'bun:test';
import { evidenceTimeIssue, evidenceTimeContext } from './evidence-policy';

test('synthetic age is exempt while real-source freshness and invalid clocks remain guarded', () => {
  const now=Date.parse('2026-10-17T00:00:00Z');
  expect(evidenceTimeIssue({source:'demo',importedAt:'2000-01-01T00:00:00Z'},now)).toBeNull();
  expect(evidenceTimeIssue({source:'csv',importedAt:'2000-01-01T00:00:00Z'},now)).toContain('24小时');
  expect(evidenceTimeIssue({source:'demo',importedAt:'invalid'},now)).toContain('时间无效');
  expect(evidenceTimeIssue({source:'demo',importedAt:'2999-01-01T00:00:00Z'},now)).toContain('超前');
  expect(evidenceTimeIssue({source:'demo',importedAt:new Date(now+300000).toISOString()},now)).toBeNull();
  expect(evidenceTimeIssue({source:'csv',importedAt:new Date(now).toISOString()},now)).toBeNull();
});

test('reimporting an old business date cannot refresh source freshness', () => {
  const now=Date.parse('2026-10-19T12:00:00+08:00');
  const record={source:'csv' as const,importedAt:new Date(now).toISOString(),row:{date:'2020-01-01'}};
  expect(evidenceTimeIssue(record,now)).toContain('业务日期');
  expect(evidenceTimeContext(record).businessTimeIssueAtImport).toContain('重新导入');
  expect(evidenceTimeContext(record).sourceObservedAt).toBeNull();
  expect(evidenceTimeIssue({...record,source:'demo'},now)).toBeNull();
});

test('Shanghai day boundary uses latest possible day end, not UTC midnight or import time', () => {
  const evidence={source:'csv' as const,importedAt:'2026-10-19T00:00:00+08:00',row:{date:'2026-10-17'}};
  expect(evidenceTimeIssue(evidence,Date.parse('2026-10-19T00:00:00+08:00'))).toBeNull();
  expect(evidenceTimeIssue(evidence,Date.parse('2026-10-19T00:00:00.001+08:00'))).toContain('业务日期');
  expect(evidenceTimeIssue({...evidence,row:{date:'2026-10-20'}},Date.parse('2026-10-19T12:00:00+08:00'))).toContain('超前');
  expect(evidenceTimeIssue({...evidence,row:{date:'2026-02-30'}},Date.parse(evidence.importedAt))).toContain('业务日期无效');
});

test('date precision, adjacent windows and unknown observation time remain explicit and deterministic', () => {
  const evidence={source:'csv' as const,importedAt:'2026-10-19T12:00:00+08:00',row:{date:'2026-10-18',window_days:7,baseline_end_date:'2026-10-11',baseline_window_days:7}};
  const time=evidenceTimeContext(evidence);
  expect(time.period).toEqual({startInclusive:'2026-10-12T00:00:00+08:00',endExclusive:'2026-10-19T00:00:00+08:00',timezone:'Asia/Shanghai'});
  expect(time.baselinePeriod?.endExclusive).toBe(time.period?.startInclusive);
  expect(time.precision).toBe('business_day_only'); expect(time.sourceObservedAtStatus).toBe('not_provided');
  expect(evidenceTimeContext(evidence)).toEqual(time);
  expect(evidenceTimeContext({...evidence,row:{...evidence.row,window_days:null}}).period).toBeNull();
});
