import type {WikiReference} from './wiki-contract';
import type { ReviewView } from './outcome-reviews';
import { evidenceTimeContext } from './evidence-policy';
import type { BatchView } from './execution-batches';
import type { AnyInvestigation } from './investigations';
import type { CompensationView } from './compensation';
import type { ExecutionView } from './simulation';
import type { DecisionDraft } from './decisions';
const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#!|])/g, '\\$1').replace(/\r?\n/g, ' ');
export function exportInvestigation(run: AnyInvestigation, format: 'json' | 'md', decisions: DecisionDraft[] = [], executions: ExecutionView[] = [], compensations: CompensationView[] = [], batches: BatchView[] = [], reviews: ReviewView[] = [], wikiReferences: WikiReference[] = []): { filename: string; mime: string; content: string } {
  const evidenceIndex = run.trace.filter(t => t.stage === 'investigate').map(t => ({ id: t.evidenceId, tool: t.tool, transport: t.transport ?? 'legacy_in_process', at: t.at }));
  const timeContext = evidenceTimeContext(run.evidence);
  const bundle = { schemaVersion: 1, wikiReferences, exportedAt: new Date().toISOString(), runId: run.id, scenario: run.scenario ?? 'margin', source: run.evidence.source, timeContext, relatedEvidence:run.relatedEvidence??null, mode: run.mode, warning: '历史证据与模型观点，不构成批准或经营执行授权。', evidenceIndex, investigation: run, decisions, executions, compensations, batches, reviews };
  const filename = `merqo-investigation-${run.id}.${format}`;
  if (format === 'json') return { filename, mime: 'application/json', content: JSON.stringify(bundle, null, 2) };
  const report = run.report;
  const lines = ['# Merqo 经营调查报告', '', `运行 ID：${run.id}`, `场景：${run.scenario ?? 'margin'}；来源：${run.evidence.source}；模式：${run.mode}；状态：${run.state}`, '', '> 历史证据与模型观点，不构成批准或经营执行授权。', '', '## 调查摘要', '', escape(report?.summary ?? run.error ?? '调查尚未生成报告')];
  if(wikiReferences.length)lines.push('', '## 调查补充知识引用（冻结版本）', '', ...wikiReferences.flatMap(r=>['### '+escape(r.item.title)+' · v'+r.item.version,'',escape(r.item.body),'','> 参考资料，不替代原始经营证据；引用在调查报告之后补充时不改写原模型结论。']));
  lines.push('', '## 数据时间与精度', '', `业务日期：${escape(timeContext.businessDate ?? '未知')}（期间末日，包含当天）；导入时间：${escape(timeContext.importedAt)}`, timeContext.sourceObservedAt ? `源系统观测时刻：${escape(timeContext.sourceObservedAt)}；${escape(timeContext.limitation)}` : '源系统观测时刻：未知；工具读取时间不是业务观测时间。', timeContext.period ? `业务期间：[${timeContext.period.startInclusive}, ${timeContext.period.endExclusive})，Asia/Shanghai。` : '业务期间：缺少有效窗口，不能推定。', escape(timeContext.businessTimeIssueAtImport ?? timeContext.limitation));
  if(run.evidence.provenance){const p=run.evidence.provenance;lines.push('', '## 来源与完整水位', '', `来源：${escape(p.sourceId)} / ${escape(p.sourceName)}；身份核验：${p.identityAssurance}`, `覆盖范围：[${escape(p.coverageStartInclusive)}, ${escape(p.completeThroughExclusive)})；完整性：${p.completeness}；SHA-256：${p.contentHash}`, ...(timeContext.sourceMetadataIssues??[]).map(i=>`- ${escape(i)}`));}
  if(run.relatedEvidence?.joint){const j=run.relatedEvidence.joint;lines.push('', '## 联合窗口与映射', '', `状态：${j.status}；商品：${escape(j.canonicalSku)} / ${escape(j.canonicalSpec??'未知')}；映射版本：${j.catalogRevision}`, `共同窗口：${j.commonPeriod?escape(JSON.stringify(j.commonPeriod)):'未知或不一致'}；共同完整截止：${escape(j.completeThroughExclusive??'未知')}`, escape(j.limitation),...j.issues.map(s=>`- ${escape(s)}`));}
  if(run.relatedEvidence) lines.push('', '## 跨场景旁证匹配', '', escape(run.relatedEvidence.limitation), ...run.relatedEvidence.items.map(i=>`- ${escape(i.scenario)} / ${escape(i.evidence.id)}：${i.status}；${escape(i.reasons.join('；') || '已提供字段对齐，仍需补充源系统身份与完整水位')}`), `缺少场景：${run.relatedEvidence.missingScenarios.join(', ') || '无'}；截断：${run.relatedEvidence.truncated}`);
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
