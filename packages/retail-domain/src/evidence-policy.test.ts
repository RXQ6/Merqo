import { expect, test } from 'bun:test';
import { evidenceTimeIssue } from './evidence-policy';

test('synthetic age is exempt while real-source freshness and invalid clocks remain guarded', () => {
  const now=Date.parse('2026-10-17T00:00:00Z');
  expect(evidenceTimeIssue({source:'demo',importedAt:'2000-01-01T00:00:00Z'},now)).toBeNull();
  expect(evidenceTimeIssue({source:'csv',importedAt:'2000-01-01T00:00:00Z'},now)).toContain('24小时');
  expect(evidenceTimeIssue({source:'demo',importedAt:'invalid'},now)).toContain('时间无效');
  expect(evidenceTimeIssue({source:'demo',importedAt:'2999-01-01T00:00:00Z'},now)).toContain('超前');
  expect(evidenceTimeIssue({source:'demo',importedAt:new Date(now+300000).toISOString()},now)).toBeNull();
  expect(evidenceTimeIssue({source:'csv',importedAt:new Date(now).toISOString()},now)).toBeNull();
});
