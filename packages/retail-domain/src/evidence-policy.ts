import {sourceMetadataIssues} from './source-metadata';
import type {EvidenceProvenance} from './source-metadata';
interface DatedEvidence {
  provenance?:EvidenceProvenance;
  source: 'demo' | 'csv'; importedAt: string;
  row?: { date: string; window_days?: number | null; baseline_end_date?: string; baseline_window_days?: number | null };
}
const DAY = 86400000;
function dateMillis(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date ? value : null;
}
function period(lastDate: string | undefined, days: number | null | undefined): { startInclusive: string; endExclusive: string; timezone: 'Asia/Shanghai' } | null {
  const last = lastDate ? dateMillis(lastDate) : null;
  if (last === null || !Number.isInteger(days) || !days || days < 1 || days > 90) return null;
  return { startInclusive: new Date(last - (days - 1) * DAY).toISOString().split('T')[0] + 'T00:00:00+08:00', endExclusive: new Date(last + DAY).toISOString().split('T')[0] + 'T00:00:00+08:00', timezone: 'Asia/Shanghai' };
}
/** Pure frozen metadata: business dates do not invent source-observation timestamps. */
export function evidenceTimeContext(evidence: DatedEvidence) {
  const row = evidence.row;
  const businessPeriod=row?period(row.date,'window_days' in row?row.window_days:1):null;
  const provenance=evidence.provenance;
  return {
    version: 'business-time-v1' as const,
    source: evidence.source, importedAt: evidence.importedAt,
    businessDate: row?.date ?? null,
    dateSemantics: 'last_inclusive_business_day' as const,
    sourceObservedAt: provenance?.sourceObservedAt??null,
    sourceObservedAtStatus: provenance?provenance.origin:'not_provided' as const,
    ...(provenance?{sourceMetadata:provenance,sourceMetadataIssues:sourceMetadataIssues(provenance,businessPeriod,row?period(row.baseline_end_date,row.baseline_window_days):null)}:{}),
    precision: 'business_day_only' as const,
    period: businessPeriod,
    baselinePeriod: row ? period(row.baseline_end_date, row.baseline_window_days) : null,
    businessTimeIssueAtImport: evidenceTimeIssue(evidence, Date.parse(evidence.importedAt)),
    limitation: provenance?provenance.origin==='builtin_synthetic'?'来源为内置合成数据；观测时刻和水位采用合成业务时钟，不代表真实平台观测或结算。':'CSV来源时刻和水位是操作者声明，未独立验证平台身份或完整结算；导入与读取不能刷新源数据。':'业务日期来自快照字段；源系统观测时刻未知，导入和工具读取时间不能证明源数据新鲜，也不证明窗口已完整结算。',
  };
}
export type EvidenceTimeContext = ReturnType<typeof evidenceTimeContext>;

/** Synthetic replay is exempt; CSV import age and its latest possible business-day age are independent. */
export function evidenceTimeIssue(evidence: DatedEvidence, now = Date.now()): string | null {
  const age = now - Date.parse(evidence.importedAt);
  if (!Number.isFinite(age) || age < -300000) return '证据导入时间无效或超前，请检查本机时间并重新载入数据';
  if (evidence.source !== 'demo' && age > 86400000) return '经营证据导入超过24小时，请更新证据并重新调查';
  if(evidence.source==='csv'&&evidence.provenance){
    const p=evidence.provenance;const observedAge=now-Date.parse(p.sourceObservedAt);
    if(!Number.isFinite(observedAge)||observedAge< -300000)return '来源观测时间无效或超前';
    if(observedAge>DAY)return '来源观测超过24小时，重新导入不会刷新源观测时刻';
    if(p.completeness!=='complete')return '来源窗口数据尚未完整，请更新完整水位';
    const range=evidence.row?period(evidence.row.date,'window_days'in evidence.row?evidence.row.window_days:1):null;
    if(!range||Date.parse(p.coverageStartInclusive)>Date.parse(range.startInclusive)||Date.parse(p.completeThroughExclusive)<Date.parse(range.endExclusive))return '来源水位未覆盖完整业务窗口';
    const baseline=evidence.row?period(evidence.row.baseline_end_date,evidence.row.baseline_window_days):null;
    if(baseline&&(Date.parse(p.coverageStartInclusive)>Date.parse(baseline.startInclusive)||Date.parse(p.completeThroughExclusive)<Date.parse(baseline.endExclusive)))return '来源水位未覆盖基线业务窗口';
  }
  if (evidence.source === 'csv' && evidence.row) {
    const day = dateMillis(evidence.row.date);
    if (day === null) return '业务日期无效，无法判断经营证据时效';
    const start = day - 8 * 3600000;
    if (start > now + 300000) return '业务日期超前，请核对来源和业务时区';
    // Date precision only: even the latest possible instant of that day is stale.
    if (now - (start + DAY) > DAY) return '经营证据业务日期超过24小时历史容限；重新导入不会刷新源数据，请补充新的业务证据';
  }
  return null;
}
