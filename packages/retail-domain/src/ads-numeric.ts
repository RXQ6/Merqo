import { isDeepStrictEqual } from 'node:util';
import { calculateSignal } from './signals';
import type { AdsRow, SignalRecord } from './signals';
import type { CaseMemory } from './outcome-reviews';
import type { Scenario, Trace } from './investigations';
import { readSignalTool, SIGNAL_TOOLS } from './signal-investigations';

export interface AdsNumericAudit {
  version: 'ads-facts-v1'; calculationFieldsComplete: boolean; evidencePartial: true;
  facts: { key: string; label: string; value: number | null; unit: 'CNY_minor' | 'bps' | 'ratio' | 'count'; evidenceIds: string[] }[];
}
/** Validate every consumed tool payload before deriving display facts. No model-authored amounts survive. */
export function auditAdsNumbers(record: SignalRecord, scenarios: Scenario[], trace: Trace[], cases: CaseMemory[] = []): AdsNumericAudit {
  if (record.kind !== 'ads' || !isDeepStrictEqual(calculateSignal('ads', record.row), record.metrics)) throw new Error('广告指标与冻结字段不一致，数值核验拒绝');
  for (const tool of SIGNAL_TOOLS.ads) {
    const events = trace.filter(t => t.tool === tool);
    if (!events.length || events.some(t => t.evidenceId !== `${record.id}:${tool}` || !isDeepStrictEqual(t.data, readSignalTool(record, tool, cases)))) throw new Error('广告工具证据与冻结快照不一致，数值核验拒绝');
  }
  const simulation = trace.find(t => t.tool === 'retail_simulate_actions')!;
  if (!isDeepStrictEqual(simulation.data, scenarios)) throw new Error('广告条件方案与代码不一致，数值核验拒绝');
  const r = record.row as AdsRow, m = record.metrics;
  const facts: AdsNumericAudit['facts'] = [];
  const add = (key: string, label: string, value: number | null, unit: AdsNumericAudit['facts'][number]['unit'], tool = 'retail_get_campaigns') => {
    if (value !== null && (!Number.isFinite(value) || (unit !== 'ratio' && !Number.isSafeInteger(value)))) throw new Error('广告数值超出精度边界，核验拒绝');
    facts.push({ key, label, value, unit, evidenceIds: [`${record.id}:${tool}`] });
  };
  add('spend', '观察窗花费', r.spend_minor, 'CNY_minor'); add('baselineSpend', '对照窗花费', r.baseline_spend_minor, 'CNY_minor');
  add('revenue', '观察窗归因成交额', r.attributed_revenue_minor, 'CNY_minor'); add('baselineRevenue', '对照窗归因成交额', r.baseline_revenue_minor, 'CNY_minor');
  add('roas', '观察窗ROAS', m.roas, 'ratio'); add('baselineRoas', '对照窗ROAS', m.baselineRoas, 'ratio'); add('roasChange', '同口径ROAS相对变化', m.roasChangeBps, 'bps');
  add('clicks', '观察窗点击数', r.clicks, 'count'); add('baselineClicks', '对照窗点击数', r.baseline_clicks, 'count');
  add('conversions', '观察窗转化数', r.conversions, 'count'); add('baselineConversions', '对照窗转化数', r.baseline_conversions, 'count');
  add('conversion', '观察窗点击转化率', m.conversionBps, 'bps'); add('baselineConversion', '对照窗点击转化率', m.baselineConversionBps, 'bps');
  const action = scenarios.find(s => s.kind === 'reduce_budget');
  add('proposedSpend', '条件方案花费', action?.values?.proposedSpendMinor ?? null, 'CNY_minor', 'retail_simulate_actions');
  add('proposedRevenue', '条件方案假设成交额', action?.values?.hypotheticalRevenueMinor ?? null, 'CNY_minor', 'retail_simulate_actions');
  add('proposedRoas', '条件方案ROAS', action?.values?.roas ?? null, 'ratio', 'retail_simulate_actions');
  return { version: 'ads-facts-v1', calculationFieldsComplete: m.issues.length === 0 && facts.every(f => f.value !== null), evidencePartial: true, facts };
}
export function adsNumericObservations(audit: AdsNumericAudit, record: SignalRecord) {
  const groups = [['spend', 'baselineSpend', 'revenue', 'baselineRevenue'], ['roas', 'baselineRoas', 'roasChange'], ['clicks', 'baselineClicks', 'conversions', 'baselineConversions'], ['conversion', 'baselineConversion'], ['proposedSpend', 'proposedRevenue', 'proposedRoas']];
  const observations = groups.map(keys => {
    const facts = keys.map(key => audit.facts.find(f => f.key === key)!);
    return { text: facts.map(f => `${f.label}：${f.value === null ? '待补证' : f.unit === 'CNY_minor' ? `¥${(f.value / 100).toFixed(2)}（${f.value}分）` : f.unit === 'bps' ? `${(f.value / 100).toFixed(2)}%` : f.unit === 'ratio' ? String(f.value) : `${f.value} 次`}`).join('；') + '。' + (keys.includes('proposedSpend') ? '归因效率不变的条件算术，不预测需求、利润或实际收益，不保证提高ROAS；未修改Campaign。' : ''), evidenceIds: [...new Set(facts.flatMap(f => f.evidenceIds))] };
  });
  observations.push({ text: `部分静态快照，非实时监控；${record.metrics.issues.length ? record.metrics.issues.join('；') : '已映射计算字段未发现阻断问题，不代表经营证据完整'}。${record.metrics.notes.join('；')}`, evidenceIds: [`${record.id}:retail_get_data_health`] });
  return observations;
}

export const SIGNAL_REVIEW_CRITERIA = `
本轮范围是冻结快照的描述与条件算术，不是经营动作建议或执行授权。scenarios[].passed只表示该方案的代码约束，不是Reviewer结论；observe不授予写权限。
按报告实际主张检查所需证据：销量或ROAS变化可由同口径快照描述；条件算术可在假设明确时核验；声称归因、盈利、需求响应或推荐实际变更，才需要相应对照、费用、库存、弹性等证据。不得以报告未主张的结论所需证据否决已限定的快照描述，也不得放过披露之外的越界结论。
广告金额单位为CNY分，事实观察由代码核对工具后生成；必须检查模型定性说明是否与事实、未知项或替代解释矛盾，引用存在不等于支持结论。缺计算字段或口径冲突必须needs_evidence；伪造、矛盾或承诺收益应rejected。任何实际预算/补货动作必须独立补证和审批。
needs_evidence需指出具体哪句主张缺哪项证据；不得为演示改判。保持独立判断，不输出金额、比例或数量的复述，notes只给定性理由，具体数值以代码事实为准。`;
