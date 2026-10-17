import type { MarginNumericAudit } from './margin-numeric';

export interface MarginEvidenceRequirement {
  id: 'calculation_inputs' | 'conditional_arithmetic' | 'order_allocation' | 'historical_comparison' | 'demand_response' | 'execution_state';
  purpose: 'calculation' | 'causal' | 'execution';
  label: string;
  status: 'supported' | 'missing';
  detail: string;
  nextStep: string;
  evidenceIds: string[];
}
export interface MarginEvidenceAssessment {
  version: 'margin-evidence-v1';
  scope: 'conditional_snapshot_analysis';
  calculationReady: boolean;
  causalReady: false;
  realExecutionReady: false;
  requirements: MarginEvidenceRequirement[];
}

/** Only call after the numeric audit has validated all four frozen tool results.
 * Supported means internally calculable from this snapshot, not verified real-world truth.
 * No current import adapter supplies causal or live-execution evidence.
 */
export function assessMarginEvidence(audit: MarginNumericAudit): MarginEvidenceAssessment {
  const refs = (...keys: string[]) => [...new Set(audit.facts.filter(f => keys.includes(f.key)).flatMap(f => f.evidenceIds))];
  const missing = audit.facts.filter(f => f.value === null).map(f => f.label);
  const calculationReady = audit.calculationFieldsComplete;
  return {
    version: 'margin-evidence-v1', scope: 'conditional_snapshot_analysis', calculationReady,
    causalReady: false, realExecutionReady: false,
    requirements: [
      { id: 'calculation_inputs', purpose: 'calculation', label: '快照字段与商品毛利计算', status: calculationReady ? 'supported' : 'missing',
        detail: calculationReady ? '冻结字段、单件与合计口径及引用已核对；仅表示本快照可计算。' : `存在缺字段或口径问题${missing.length ? '：' + missing.join('、') : '，请核对数据质量观察'}。`,
        nextStep: calculationReady ? '核对原始账单；计算一致不等于已验证真实经营事实。' : '前往数据与导入，修正成本、补贴归属或规格等字段，导入后从最新快照重新调查。',
        evidenceIds: refs('unitRevenue', 'unitCost', 'totalRevenue', 'threshold') },
      { id: 'conditional_arithmetic', purpose: 'calculation', label: '优惠调整的条件测算', status: calculationReady ? 'supported' : 'missing',
        detail: '只核对其他条件不变时的算术；约束通过与否见方案比较，不预测销量或真实收益。',
        nextStep: '将测算作为条件方案；缺计算字段时先补字段，不能以假设填充未知值。', evidenceIds: refs('proposedCoupon', 'proposedRevenue', 'proposedMargin') },
      { id: 'order_allocation', purpose: 'causal', label: '逐单优惠分摊', status: 'missing', detail: '只有规格件的日快照，没有逐单账单及优惠实际承担明细。',
        nextStep: '需逐单账单和分摊规则；当前 CSV 仅支持快照字段，尚不接收这类证据。', evidenceIds: refs('currentCoupon', 'threshold') },
      { id: 'historical_comparison', purpose: 'causal', label: '同口径历史与对照', status: 'missing', detail: '历史 Case 仅为合成比较，不能证明本次促销导致毛利变化，也不能排除成本、流量等解释。',
        nextStep: '需同店铺、渠道、规格及可比窗口的原始对照；当前调查未接入该证据。', evidenceIds: refs('threshold') },
      { id: 'demand_response', purpose: 'causal', label: '需求弹性与销量响应', status: 'missing', detail: '没有优惠变更后的销量观测或可识别的对照试验。',
        nextStep: '保留为未知项；不得承诺减券后销量不变、净利润增长或实际收益。', evidenceIds: refs('proposedMargin') },
      { id: 'execution_state', purpose: 'execution', label: '真实平台当前状态与权限', status: 'missing', detail: '本项目当前只提供本地隔离模拟，未获得真实改价或优惠写入权限。',
        nextStep: '真实执行适配器尚未接入；本地模拟仍需通过草稿硬约束及独立审批。', evidenceIds: refs('threshold') },
    ],
  };
}

export const MARGIN_REVIEW_CRITERIA = `
本次任务范围为 conditional_snapshot_analysis。evidenceAssessment 是代码根据已核验冻结工具生成的证据清单，不是模型的审批结论。
calculation 类缺口阻止相关数值结论；causal 类缺口阻止确证归因、排除替代解释、承诺需求响应；execution 类缺口阻止真实执行。不得把这些用途混为一谈。
逐单分摊和历史对照尚缺时，可以复核明确标注假设和限制的快照算术与条件方案，但不能确认促销是历史变化的主因，也不能替真实平台授权。引用存在不等于支持该语义结论。
检查 summary、hypotheses、options.rationale 是否与代码观察、unknowns、alternatives 自相矛盾；把未知说成已证实、把商品毛利说成净利润或将条件方案说成确定收益，应拒绝。
如果 verdict=needs_evidence，notes 应具体指出缺哪项、影响哪句结论、为什么本次分析需要该证据；如果只是执行前置条件，记录为边界。保持独立判断，不得为演示或预设答案改判。`;
