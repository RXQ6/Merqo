import type { ReviewView } from './outcome-reviews';
import type { BatchView } from './execution-batches';
import type { AnyInvestigation } from './investigations';
import type { CompensationView } from './compensation';
import type { ExecutionView } from './simulation';
import type { DecisionDraft } from './decisions';
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|])/g, '\\$1').replace(/\r?\n/g, ' ');
export function exportInvestigation(run: AnyInvestigation, format: 'json' | 'md', decisions: DecisionDraft[] = [], executions: ExecutionView[] = [], compensations: CompensationView[] = [], batches: BatchView[] = [], reviews: ReviewView[] = []): { filename: string; mime: string; content: string } {
  const evidenceIndex = run.trace.filter(t => t.stage === 'investigate').map(t => ({ id: t.evidenceId, tool: t.tool, transport: t.transport ?? 'legacy_in_process', at: t.at }));
  const bundle = { schemaVersion: 1, exportedAt: new Date().toISOString(), runId: run.id, scenario: run.scenario ?? 'margin', source: run.evidence.source, mode: run.mode, warning: '历史证据与模型观点，不构成批准或经营执行授权。', evidenceIndex, investigation: run, decisions, executions, compensations, batches, reviews };
  const filename = `merqo-investigation-${run.id}.${format}`;
  if (format === 'json') return { filename, mime: 'application/json', content: JSON.stringify(bundle, null, 2) };
  const report = run.report;
  const lines = ['# Merqo 经营调查报告', '', `运行 ID：${run.id}`, `场景：${run.scenario ?? 'margin'}；来源：${run.evidence.source}；模式：${run.mode}；状态：${run.state}`, '', '> 历史证据与模型观点，不构成批准或经营执行授权。', '', '## 调查摘要', '', escape(report?.summary ?? run.error ?? '调查尚未生成报告')];
  if (report) {
    if (report.evidenceAssessment) {
      lines.push('', '## 证据与补证清单', '', '范围：冻结快照与条件测算；清单不代表 Reviewer 通过、归因证明或真实执行授权。', '');
      for (const r of report.evidenceAssessment.requirements) lines.push(`- ${escape(r.label)}（${r.purpose} / ${r.status}）：${escape(r.detail)} 下一步：${escape(r.nextStep)} 引用：${r.evidenceIds.map(escape).join(', ')}`);
    }
    for (const [title, claims] of [['观察与证据', report.observations], ['原因假设（尚未证实）', report.hypotheses]] as const) lines.push('', `## ${title}`, '', ...claims.map(c => `- ${escape(c.text)} — ${c.evidenceIds.map(escape).join(', ')}`));
    for (const [title, texts] of [['替代解释', report.alternatives], ['未知项与待补证', report.unknowns]] as const) lines.push('', `## ${title}`, '', ...texts.map(t => `- ${escape(t)}`));
    lines.push('', '## 条件方案', '');
    for (const s of report.scenarios) lines.push(`### ${escape(s.title)}`, '', escape(s.rationale), '', `约束检查：${s.passed ? '条件通过，仍需执行前补证' : '未通过'}`, '', ...[...s.assumptions, ...s.constraints].map(t => `- ${escape(t)}`));
    lines.push('', '## Reviewer', '', `模式：${report.reviewer.mode}；结论：${report.reviewer.verdict}`, '', ...report.reviewer.notes.map(t => `- ${escape(t)}`));
  }
  lines.push('', '## 证据索引', '', ...evidenceIndex.map(e => `- ${escape(e.id)} — ${e.transport} — ${e.at}`), '', '## 完整证据、测算与草稿快照', '');
  // Pick a fence longer than any run of backticks in untrusted business/model text.
  const json = JSON.stringify(bundle, null, 2); const fence = '`'.repeat(Math.max(3, ...Array.from(json.matchAll(/`+/g), m => m[0].length + 1)));
  lines.push(fence + 'json', json, fence, '');
  return { filename, mime: 'text/markdown', content: lines.join('\n') };
}
