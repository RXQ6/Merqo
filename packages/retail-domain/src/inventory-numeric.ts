import { isDeepStrictEqual } from 'node:util';
import { calculateSignal, InventorySchema } from './signals';
import type { InventoryRow, SignalRecord } from './signals';
import type { CaseMemory } from './outcome-reviews';
import type { Scenario, Trace } from './investigations';
import { readSignalTool, SIGNAL_TOOLS, simulateSignal } from './signal-investigations';

export interface InventoryNumericAudit {
  version: 'inventory-facts-v1'; calculationFieldsComplete: boolean; evidencePartial: true;
  facts: { key: string; label: string; value: number | null; unit: 'count' | 'days' | 'count_per_day' | 'bps'; fraction?: { numerator: number; denominator: number }; evidenceIds: string[] }[];
}

/** Validate frozen tool payloads and code plans before constructing any numeric narrative. */
export function auditInventoryNumbers(record: SignalRecord, scenarios: Scenario[], trace: Trace[], cases: CaseMemory[] = [], relatedEvidence?: import('./related-evidence').RelatedEvidence): InventoryNumericAudit {
  if (record.kind !== 'inventory' || !InventorySchema.safeParse(record.row).success || !isDeepStrictEqual(calculateSignal('inventory', record.row,record.policy?.settings), record.metrics)) throw new Error('库存指标与冻结字段不一致，数值核验拒绝');
  for (const tool of SIGNAL_TOOLS.inventory) {
    const events = trace.filter(t => t.tool === tool);
    if (!events.length || events.some(t => t.evidenceId !== `${record.id}:${tool}` || !isDeepStrictEqual(t.data, readSignalTool(record, tool, cases, relatedEvidence)))) throw new Error('库存工具证据与冻结快照不一致，数值核验拒绝');
  }
  if (!isDeepStrictEqual(scenarios, simulateSignal(record))) throw new Error('库存条件方案与代码不一致，数值核验拒绝');
  const row = record.row as InventoryRow, metrics = record.metrics, action = scenarios.find(s => s.kind === 'replenish_draft');
  const facts: InventoryNumericAudit['facts'] = [];
  const add = (key: string, label: string, value: number | null, unit: InventoryNumericAudit['facts'][number]['unit'], tool = 'retail_get_inventory', fraction?: { numerator: number; denominator: number }) => {
    if (value !== null && (!Number.isFinite(value) || ((unit === 'count' || unit === 'bps') && !Number.isSafeInteger(value)))) throw new Error('库存数值超出精度边界，核验拒绝');
    facts.push({ key, label, value, unit, ...(fraction ? { fraction } : {}), evidenceIds: [`${record.id}:${tool}`] });
  };
  add('onHand', '现存库存', row.on_hand, 'count'); add('reserved', '已占用库存', row.reserved, 'count'); add('available', '即时可售库存', metrics.available, 'count');
  add('inbound', '在途库存（非即时可售）', row.inbound_qty, 'count'); add('leadDays', '常规补货交期', row.lead_days, 'days');
  add('currentSales', '观察窗净销量', row.recent_sales_qty, 'count'); add('baselineSales', '对照窗净销量', row.baseline_sales_qty, 'count');
  add('windowDays', '观察窗长度', row.window_days, 'days'); add('baselineWindowDays', '对照窗长度', row.baseline_window_days, 'days');
  add('salesChange', '同口径销量相对变化', metrics.salesChangeBps, 'bps');
  const daily = row.recent_sales_qty !== null && row.window_days !== null ? { numerator: row.recent_sales_qty, denominator: row.window_days } : undefined;
  add('dailySales', '观察窗日均销量', action?.values?.dailySales ?? null, 'count_per_day', 'retail_simulate_actions', daily);
  const coverage = metrics.available !== null && row.window_days !== null && row.recent_sales_qty !== null && row.recent_sales_qty > 0 ? { numerator: metrics.available * row.window_days, denominator: row.recent_sales_qty } : undefined;
  add('coverageDays', '库存覆盖天数', metrics.coverageDays, 'days', 'retail_get_inventory', coverage);
  add('timelyInbound', '覆盖期内预计到货的在途（条件量）', action?.values?.timelyInbound ?? null, 'count', 'retail_simulate_actions');
  add('targetDays', '条件目标覆盖期（交期加缓冲）', action?.values?.targetDays ?? null, 'days', 'retail_simulate_actions');
  add('targetStock', '条件目标库存', action?.values?.targetStock ?? null, 'count', 'retail_simulate_actions');
  add('proposedQuantity', '条件补货草稿量', action?.values?.proposedQuantity ?? null, 'count', 'retail_simulate_actions');
  return { version: 'inventory-facts-v1', calculationFieldsComplete: metrics.issues.length === 0 && facts.every(f => f.value !== null), evidencePartial: true, facts };
}

export function inventoryNumericObservations(audit: InventoryNumericAudit, record: SignalRecord) {
  const groups = [['onHand', 'reserved', 'available', 'inbound'], ['currentSales', 'baselineSales', 'windowDays', 'baselineWindowDays', 'salesChange'], ['dailySales', 'coverageDays', 'leadDays'], ['timelyInbound', 'targetDays', 'targetStock', 'proposedQuantity']];
  const observations = groups.map(keys => {
    const facts = keys.map(key => audit.facts.find(f => f.key === key)!);
    return { text: facts.map(f => {
      const unit = f.unit === 'count' ? '件' : f.unit === 'days' ? '天' : f.unit === 'count_per_day' ? '件/天' : '%';
      const value = f.value === null ? '待补证' : f.unit === 'bps' ? `${(f.value / 100).toFixed(2)}${unit}` : f.fraction ? `${f.fraction.numerator}/${f.fraction.denominator} ${unit}（约 ${f.value.toPrecision(8)} ${unit}）` : `${f.value} ${unit}`;
      return `${f.label}：${value}`;
    }).join('；') + '。' + (keys.includes('proposedQuantity') ? '仅按冻结销量与交期作条件算术，约束未通过时不可执行；未创建采购单、未增加现货。' : ''), evidenceIds: [...new Set(facts.flatMap(f => f.evidenceIds))] };
  });
  observations.push({ text: `部分静态快照；${record.metrics.issues.length ? record.metrics.issues.join('；') : '已映射计算字段未发现阻断问题，不代表经营证据完整'}。${record.metrics.notes.join('；')}`, evidenceIds: [`${record.id}:retail_get_data_health`] });
  return observations;
}
