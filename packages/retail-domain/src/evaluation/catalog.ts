import type { RetailRow } from '../operations';
import type { AdsRow, InventoryRow } from '../signals';
import { DEMO_CSV } from '../operations';
import { ADS_DEMO, INVENTORY_EXECUTION_DEMO } from '../signals';

export const EVAL_VERSION = 'retail-business-eval-v6';
export const FIXED_NOW = Date.parse('2026-10-17T04:00:00Z');
export type Expected = 'normal' | 'warning' | 'needs_evidence' | 'rejected' | 'accepted' | 'blocked';
export type BusinessInput =
  | { kind: 'margin'; rows: RetailRow[] }
  | { kind: 'offer'; row: RetailRow }
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
group('discount_stacking', 'retail-margin-v6：单件收入=标价-券-满减+额外平台结算；毛利率<2000bps预警',
  [m(), m({ coupon_minor: 2000 }), m({ cost_minor: null })], ['normal', 'warning', 'needs_evidence'],
  ['SKU规格', '标价/券/满减分每销售件', '成本分每销售件'], '仅判断当前销售件商品毛利，不预测优惠调整收益');
cases[0]!.expectedValues = { revenueMinor: 8000, profitMinor: 2000, totalProfitMinor: 20000, marginBps: 2500 };
cases[1]!.expectedValues = { revenueMinor: 7000, profitMinor: 1000, totalProfitMinor: 10000, marginBps: 1429 };
cases[2]!.expectedValues = { revenueMinor: null, profitMinor: null, marginBps: null };
group('multi_spec', 'retail-margin-v6：同店同渠道同SKU跨日期规格冲突必须补证',
  [m(), { kind: 'margin', rows: [margin, { ...margin, date: '2026-10-13', spec: '1L' }] }, m({ spec: '' })],
  ['normal', 'needs_evidence', 'rejected'], ['SKU', '店铺/渠道', '规格与日期'], '只验证冻结快照内规格一致性；不证明跨平台目录匹配');
const bundle = { product_type: 'bundle' as const, sku_id: 'PACK-A', spec: 'A×2+B×4', bundle_components: [
  { sku_id: 'SKU-A', spec: '500ml', quantity: 2, unit_cost_minor: 1000 },
  { sku_id: 'SKU-B', spec: '250ml', quantity: 4, unit_cost_minor: 1000 },
] };
group('combination_pack', 'retail-margin-v6：显式一层子SKU/规格/数量/单位成本；子项合计须等于整包成本；缺失或冲突补证',
  [m(bundle), m({ ...bundle, cost_minor: 1000 }), m({ ...bundle, bundle_components: null })],
  ['normal', 'needs_evidence', 'needs_evidence'], ['整包SKU/规格', '子项SKU/规格/数量/单位成本', '整包成本与子项合计'],
  '仅判断每销售包毛利；不分摊子项收入/优惠，本固定组只覆盖平面组合装，嵌套树另见 bundles.test.ts；不证明外部目录匹配');
cases[cases.length - 3]!.expectedValues = { revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 };
for (const c of cases.slice(-2)) c.expectedValues = { revenueMinor: null, profitMinor: null, marginBps: null };

const gift = { gift_policy: 'free_per_unit' as const, gift_cost_basis: 'additional' as const };
const gifts = (unit_cost_minor: number | null): Partial<RetailRow> => ({ ...gift, gifts: [{ sku_id: 'GIFT-A', spec: '30ml', quantity: 1, unit_cost_minor }] });
group('gift', 'retail-margin-v6：每销售件免费赠送；主成本不含赠品；赠品零收入；全部优惠计主商品；缺成本或未知口径补证',
  [m(gifts(0)), m(gifts(1500)), m(gifts(null))], ['normal', 'warning', 'needs_evidence'],
  ['主商品SKU/成本', '赠品SKU/规格/数量/单位成本', 'free_per_unit赠送规则', 'additional成本口径'],
  '仅快照毛利；成本为主商品成本加赠品成本，不做订单门槛、逐单分摊或同SKU自赠');
cases[cases.length - 3]!.expectedValues = { revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 };
cases[cases.length - 2]!.expectedValues = { revenueMinor: 8000, profitMinor: 500, marginBps: 625, totalProfitMinor: 5000 };
cases[cases.length - 1]!.expectedValues = { revenueMinor: null, profitMinor: null, marginBps: null };

const membership = { status: 'member' as const, segment_id: 'gold', price_minor: 8000, valid_from: '2026-10-01', valid_to: '2026-11-01', discount_policy: 'exclusive' as const };
group('member_price', 'retail-margin-v6：明确会员分组与身份；业务日期在[from,to)内；会员价替代普通价；互斥优惠同时存在须补证',
  [m({ coupon_minor: 0, full_reduction_minor: 0, membership }),
   m({ coupon_minor: 500, full_reduction_minor: 0, membership: { ...membership, price_minor: 6500, discount_policy: 'stackable' } }),
   m({ coupon_minor: 0, full_reduction_minor: 0, membership: { ...membership, status: 'unknown' } })],
  ['normal', 'warning', 'needs_evidence'], ['会员身份/分组', 'SKU规格/店铺/渠道', '价格及业务有效期', '叠加或互斥规则'],
  '只核算单会员分组的业务日期快照；不证明真实会员认证，不混算分组，不自动选择冲突优惠');
cases[cases.length - 3]!.expectedValues = { revenueMinor: 8000, profitMinor: 2000, marginBps: 2500, totalProfitMinor: 20000 };
cases[cases.length - 2]!.expectedValues = { revenueMinor: 6000, profitMinor: 0, marginBps: 0, totalProfitMinor: 0 };
cases[cases.length - 1]!.expectedValues = { revenueMinor: null, profitMinor: null, marginBps: null };

const offer = (offer_id: string, price_minor: number, available: boolean | null) => ({
  offer_id, shop_id: margin.shop_id, channel: margin.channel, sku_id: margin.sku_id, spec: margin.spec,
  currency: 'CNY' as const, observed_on: margin.date, audience: 'public' as const, price_minor, available,
});
group('unavailable_price', 'retail-offers-v1：同范围/同规格/同业务日期公开报价；明确无货排除，可售或人群未知补证；不替换成交价',
  [ { kind: 'offer', row: { ...margin, offers: [offer('a', 1000, true)] } },
    { kind: 'offer', row: { ...margin, offers: [offer('a', 1000, false), offer('b', 3000, true)] } },
    { kind: 'offer', row: { ...margin, offers: [offer('a', 1000, null)] } } ],
  ['accepted', 'accepted', 'needs_evidence'], ['报价ID/范围/规格/币种', '业务日期与适用人群', '明确可售状态与标价', '冻结工具与选择结果'],
  '仅在已提供的同口径公开报价中筛选；不证明全网最低价、实时可售或真实经营效果，不授权改价');
cases[cases.length - 3]!.expectedValues = { selectedPriceMinor: 1000 };
cases[cases.length - 2]!.expectedValues = { selectedPriceMinor: 3000 };
cases[cases.length - 1]!.expectedValues = { selectedPriceMinor: null };

group('subsidy_funder', 'retail-margin-v6：仅明确额外平台结算补贴可加收入，商家或未知承担方补证',
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
