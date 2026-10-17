import type { RetailRow } from '../operations';
import type { AdsRow, InventoryRow } from '../signals';
import { DEMO_CSV } from '../operations';
import { ADS_DEMO, INVENTORY_EXECUTION_DEMO } from '../signals';

export const EVAL_VERSION = 'retail-business-eval-v1';
export const FIXED_NOW = Date.parse('2026-10-17T04:00:00Z');
export type Expected = 'normal' | 'warning' | 'needs_evidence' | 'rejected' | 'accepted' | 'blocked';
export type BusinessInput =
  | { kind: 'margin'; rows: RetailRow[] }
  | { kind: 'inventory'; row: InventoryRow }
  | { kind: 'ads'; row: AdsRow }
  | { kind: 'freshness'; source: 'csv' | 'demo'; importedAt: string; now: number }
  | { kind: 'audit'; mutation: 'none' | 'wrong_sku' | 'wrong_profit' | 'missing_context' | 'missing_promotions' }
  | { kind: 'unsupported'; snapshot: Record<string, unknown>; gap: string };
export interface BusinessCase {
  id: string; category: string; variant: 'normal' | 'anomaly' | 'insufficient';
  input: BusinessInput; rule: string; expected: Expected;
  allowedConclusions: string[]; requiredEvidence: string[]; forbiddenActions: string[];
  expectedValues?: Record<string, number | null>;
}
const margin: RetailRow = {
  date: '2026-10-14', shop_id: 'eval-shop', channel: 'online', sku_id: 'SKU-A',
  product_name: '合成茶饮', spec: '500ml', currency: 'CNY', list_price_minor: 10000,
  coupon_minor: 1000, full_reduction_minor: 1000, subsidy_minor: 0, subsidy_funder: 'platform',
  cost_minor: 6000, sold_qty: 10, on_hand: 100, reserved: 0, inbound_qty: 0,
};
const inventory: InventoryRow = {
  date: '2026-10-14', baseline_end_date: '2026-10-07', shop_id: 'eval-shop', channel: 'online',
  sku_id: 'SKU-A', product_name: '合成茶饮', spec: '500ml', warehouse_id: 'WH-A',
  window_days: 7, baseline_window_days: 7, recent_sales_qty: 100, baseline_sales_qty: 100,
  on_hand: 1000, reserved: 0, inbound_qty: 0, inbound_eta: null, lead_days: 1,
};
const ads: AdsRow = {
  date: '2026-10-14', baseline_end_date: '2026-10-07', shop_id: 'eval-shop', channel: 'online',
  sku_id: 'SKU-A', campaign_id: 'CAMPAIGN-A', window_days: 7, baseline_window_days: 7,
  currency: 'CNY', attribution_window: '7d_click', baseline_attribution_window: '7d_click',
  spend_minor: 100000, attributed_revenue_minor: 300000, clicks: 1000, conversions: 50,
  baseline_spend_minor: 100000, baseline_revenue_minor: 300000, baseline_clicks: 1000, baseline_conversions: 50,
};
const variants = ['normal', 'anomaly', 'insufficient'] as const;
const cases: BusinessCase[] = [];
function group(category: string, rule: string, inputs: BusinessInput[], expected: Expected[], evidence: string[], allowed: string) {
  variants.forEach((variant, index) => cases.push({
    id: `${category}.${variant}`, category, variant, input: inputs[index]!, rule, expected: expected[index]!,
    allowedConclusions: [allowed], requiredEvidence: evidence,
    forbiddenActions: ['不得写真实业务系统', '不得猜测缺失金额、SKU或因果', '待补证不得进入模拟审批'],
  }));
}
const m = (patch: Partial<RetailRow> = {}): BusinessInput => ({ kind: 'margin', rows: [{ ...margin, ...patch }] });
const audit = (mutation: Extract<BusinessInput, {kind:'audit'}>['mutation']): BusinessInput => ({ kind: 'audit', mutation });
group('discount_stacking', 'retail-margin-v1：单件收入=标价-券-满减+额外平台结算；毛利率<2000bps预警',
  [m(), m({ coupon_minor: 2000 }), m({ cost_minor: null })], ['normal', 'warning', 'needs_evidence'],
  ['SKU规格', '标价/券/满减分每销售件', '成本分每销售件'], '仅判断当前销售件商品毛利，不预测优惠调整收益');
cases[0]!.expectedValues = { revenueMinor: 8000, profitMinor: 2000, totalProfitMinor: 20000, marginBps: 2500 };
cases[1]!.expectedValues = { revenueMinor: 7000, profitMinor: 1000, totalProfitMinor: 10000, marginBps: 1429 };
cases[2]!.expectedValues = { revenueMinor: null, profitMinor: null, marginBps: null };
group('multi_spec', 'retail-margin-v1：同店同渠道同SKU跨日期规格冲突必须补证',
  [m(), { kind: 'margin', rows: [margin, { ...margin, date: '2026-10-13', spec: '1L' }] }, m({ spec: '' })],
  ['normal', 'needs_evidence', 'rejected'], ['SKU', '店铺/渠道', '规格与日期'], '只验证冻结快照内规格一致性；不证明跨平台目录匹配');
for (const [category, gap, snapshots] of [
  ['combination_pack', '缺少组合装子项、件数及成本分摊映射', [
    { bundle_sku: 'PACK-A', components: [{ sku: 'SKU-A', qty: 6, cost_minor: 1000 }], pack_cost_minor: 6000 },
    { bundle_sku: 'PACK-A', components: [{ sku: 'SKU-A', qty: 6, cost_minor: 1000 }], pack_cost_minor: 1000 },
    { bundle_sku: 'PACK-A', components: null, pack_cost_minor: 6000 },
  ]],
  ['gift', '缺少赠品关联、赠品成本及优惠分摊契约', [
    { sku_id: 'SKU-A', gift_sku_id: 'GIFT-A', revenue_minor: 8000, cost_minor: 6000, gift_cost_minor: 0 },
    { sku_id: 'SKU-A', gift_sku_id: 'GIFT-A', revenue_minor: 8000, cost_minor: 6000, gift_cost_minor: 1500 },
    { sku_id: 'SKU-A', gift_sku_id: 'GIFT-A', revenue_minor: 8000, cost_minor: 6000, gift_cost_minor: null },
  ]],
  ['member_price', '缺少会员身份、有效会员价及优惠互斥口径', [
    { sku_id: 'SKU-A', is_member: true, member_price_minor: 8000, coupon_minor: 0, cost_minor: 6000 },
    { sku_id: 'SKU-A', is_member: true, member_price_minor: 6500, coupon_minor: 500, cost_minor: 6000 },
    { sku_id: 'SKU-A', is_member: null, member_price_minor: 6500, coupon_minor: 500, cost_minor: 6000 },
  ]],
  ['unavailable_price', '缺少报价可售状态、跨商品规格匹配及有效报价筛选', [
    { sku_id: 'SKU-A', spec: '500ml', offers: [{ price_minor: 1000, available: true }] },
    { sku_id: 'SKU-A', spec: '500ml', offers: [{ price_minor: 1000, available: false }, { price_minor: 3000, available: true }] },
    { sku_id: 'SKU-A', spec: '500ml', offers: [{ price_minor: 1000, available: null }] },
  ]],
] as const) {
  group(category, 'PRD 12.1目标：按明细验证组合装/赠品/会员毛利，报价只选同规格可售项；缺映射/身份/成本/可售状态必须补证',
    variants.map((variant, index) => ({ kind: 'unsupported', gap, snapshot: { ...snapshots[index], variant } })),
    category === 'unavailable_price' ? ['accepted', 'accepted', 'needs_evidence']
      : category === 'combination_pack' ? ['normal', 'needs_evidence', 'needs_evidence']
      : ['normal', 'warning', 'needs_evidence'],
    [gap], category === 'unavailable_price' ? '目标：同规格最低可售报价；未知可售性待补证'
      : category === 'combination_pack' ? '目标：子项合计与包成本核对，映射冲突待补证'
      : '目标：纳入有效会员价或赠品成本后计算商品毛利，口径未知待补证');
  if (category === 'unavailable_price') {
    cases[cases.length - 3]!.expectedValues = { selectedPriceMinor: 1000 };
    cases[cases.length - 2]!.expectedValues = { selectedPriceMinor: 3000 };
  }
}
group('subsidy_funder', 'retail-margin-v1：仅明确额外平台结算补贴可加收入，商家或未知承担方补证',
  [m({ subsidy_minor: 1000 }), m({ subsidy_minor: 1000, subsidy_funder: 'merchant' }), m({ subsidy_minor: 1000, subsidy_funder: 'unknown' })],
  ['normal', 'needs_evidence', 'needs_evidence'], ['补贴金额', '承担方', '额外结算口径'], '未知承担方不得计算确定毛利');
group('data_delay', 'evidenceTimeIssue：CSV超过24小时阻断、无效时间阻断；不代表业务事件时间已验证',
  [3600000, 86400001, NaN].map(age => ({ kind: 'freshness', source: 'csv', importedAt: Number.isFinite(age) ? new Date(FIXED_NOW - age).toISOString() : 'invalid', now: FIXED_NOW })),
  ['accepted', 'blocked', 'blocked'], ['source', 'importedAt', '固定评测时钟'], '仅核验导入时效；CSV始终仅分析，不能模拟执行');
group('sku_mismatch', 'margin-facts-v1：工具上下文须与冻结SKU完全一致，缺失或错配拒绝报告',
  [audit('none'), audit('wrong_sku'), audit('missing_context')], ['accepted', 'blocked', 'blocked'],
  ['冻结SKU', 'retail_get_sku_context', '工具证据ID'], '仅验证工具与冻结身份一致性，不证明外部目录映射');
group('abnormal_sales', 'retail-stock-roas-v1：等长相邻窗口净销量下降至少20%；缺失销量待补证',
  [100, 80, null].map(recent_sales_qty => ({ kind: 'inventory', row: { ...inventory, recent_sales_qty } })),
  ['normal', 'warning', 'needs_evidence'], ['相邻等长窗口', '观察窗/基线净销量', '仓库库存'], '只判断窗口销量下降，不推断缺货原因；不覆盖异常暴涨检测');
group('margin_conflict', 'margin-facts-v1：金额与冻结计算矛盾、缺少优惠证据均拒绝报告',
  [audit('none'), audit('wrong_profit'), audit('missing_promotions')], ['accepted', 'blocked', 'blocked'],
  ['retail_get_promotions', '代码计算', 'retail_simulate_actions'], '仅允许代码生成的分每件、合计与基点事实');
group('attribution_window', 'retail-stock-roas-v1：同归因窗口ROAS相对下降至少20%；口径错配不得比较',
  [{ kind: 'ads', row: ads }, { kind: 'ads', row: { ...ads, attributed_revenue_minor: 240000 } }, { kind: 'ads', row: { ...ads, baseline_attribution_window: '1d_click' } }],
  ['normal', 'warning', 'needs_evidence'], ['当前/基线归因窗', '花费与归因成交额', '等长相邻观察窗'], 'ROAS不等于利润，下降不授权调整真实广告预算');
export const BUSINESS_CASES: readonly BusinessCase[] = cases;
export const PROTOCOL_FIXTURES = { marginCsv: DEMO_CSV, adsCsv: ADS_DEMO, inventoryCsv: INVENTORY_EXECUTION_DEMO };
export const FAULT_CASES = [
  ['unapproved', '未批准不产生执行任务'], ['expired', '授权到期不写模拟状态'],
  ['hash_substitution', '参数摘要不符拒绝'], ['cross_workspace', '跨工作空间拒绝'],
  ['forged_role', '角色缺失及渲染端伪造拒绝'], ['duplicate', '重复执行只有一份回执和一次副作用'],
  ['superseded', '改版后旧审批不能执行'], ['receipt_failure', '回执落盘失败回滚副作用'],
  ['restart', '重启找回唯一回执'], ['reread_drift', '目标漂移对账不匹配且不覆盖'],
  ['batch_partial', '部分失败只重试已确认失败项'], ['unknown', '失联租约UNKNOWN禁止盲重试，显式恢复隔离旧token'],
].map(([id, expected]) => ({ id: `fault.${id}`, category: 'approval_execution', variant: 'fault' as const,
  input: { fixture: 'DEMO_CSV + ADS_DEMO + INVENTORY_EXECUTION_DEMO', injection: id },
  rule: 'merqo-simulation-draft-v2 + simulation/batch durable ledger', expected,
  allowedConclusions: ['仅本地模拟账本契约成立；不证明模型推理质量或生产身份授权'],
  requiredEvidence: ['冻结调查与Reviewer协议夹具', '审批版本和摘要', '执行任务/回执/对账'],
  forbiddenActions: ['未经批准产生模拟副作用', '写原始经营快照', 'UNKNOWN直接重试'],
}));
