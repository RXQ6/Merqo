import type {EvidenceProvenance} from './source-metadata';
import type {RuleSettings,FrozenPolicy} from './business-policy';
import { z } from 'zod';
import type { SignalPagination } from './signal-page';
import { parseCsv } from './operations';
export type SignalKind = 'inventory' | 'ads';
export const SIGNAL_RULE = 'retail-stock-roas-v1';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v + 'T00:00:00Z'); return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, '无效日期');
const name = z.string().trim().min(1).max(120);
const quantity = z.number().int().min(0).max(100000000).nullable();
const days = z.number().int().min(1).max(90).nullable();
const common = { date, baseline_end_date: date, shop_id: name, channel: name, sku_id: name, window_days: days, baseline_window_days: days };
export const InventorySchema = z.strictObject({ ...common, product_name: name, spec: name, warehouse_id: name,
  recent_sales_qty: quantity, baseline_sales_qty: quantity, on_hand: quantity, reserved: quantity, inbound_qty: quantity,
  inbound_eta: date.nullable(), lead_days: z.number().int().min(0).max(180).nullable(),
}).superRefine((r, c) => { if (r.on_hand !== null && r.reserved !== null && r.reserved > r.on_hand) c.addIssue({ code: 'custom', message: '占用库存超过现存库存' }); });
export const AdsSchema = z.strictObject({ ...common, campaign_id: name, currency: z.literal('CNY'),
  attribution_window: name.nullable(), baseline_attribution_window: name.nullable(),
  spend_minor: quantity, attributed_revenue_minor: quantity, clicks: quantity, conversions: quantity,
  baseline_spend_minor: quantity, baseline_revenue_minor: quantity, baseline_clicks: quantity, baseline_conversions: quantity,
}).superRefine((r, c) => { if ((r.clicks !== null && r.conversions !== null && r.conversions > r.clicks) || (r.baseline_clicks !== null && r.baseline_conversions !== null && r.baseline_conversions > r.baseline_clicks)) c.addIssue({ code: 'custom', message: '本口径每次点击最多一次转化，转化次数不能超过点击数' }); });
export type InventoryRow = z.infer<typeof InventorySchema>;
export type AdsRow = z.infer<typeof AdsSchema>;
export type SignalRow = InventoryRow | AdsRow;
export const INVENTORY_FIELDS = Object.keys(InventorySchema.shape);
export const ADS_FIELDS = Object.keys(AdsSchema.shape);
export const SIGNAL_LABELS: Record<string, string> = {
  date: '观察窗结束日期', baseline_end_date: '对照窗结束日期', shop_id: '店铺', channel: '渠道', sku_id: 'SKU', window_days: '观察窗天数', baseline_window_days: '对照窗天数', product_name: '商品名称', spec: '规格', warehouse_id: '仓库', recent_sales_qty: '观察窗净销量', baseline_sales_qty: '对照窗净销量', on_hand: '现存库存', reserved: '占用库存', inbound_qty: '在途库存', inbound_eta: '预计到货日期', lead_days: '补货交期天数', campaign_id: '广告活动', currency: '币种', attribution_window: '当前归因窗口', baseline_attribution_window: '对照归因窗口', spend_minor: '当前花费（分）', attributed_revenue_minor: '当前归因成交额（分）', clicks: '当前点击数', conversions: '当前转化数', baseline_spend_minor: '对照花费（分）', baseline_revenue_minor: '对照归因成交额（分）', baseline_clicks: '对照点击数', baseline_conversions: '对照转化数',
};
export interface SignalPreview { headers: string[]; mapping: Record<string, string>; valid: SignalRow[]; validCount?: number; rejected: { line: number; reason: string }[]; rejectedCount?: number; total: number }
export interface SignalMetrics {
  available: number | null; coverageDays: number | null; salesChangeBps: number | null;
  roas: number | null; baselineRoas: number | null; roasChangeBps: number | null;
  conversionBps: number | null; baselineConversionBps: number | null;
  flags: string[]; issues: string[]; notes: string[];
}
export interface SignalRecord { provenance?:EvidenceProvenance; policy?:FrozenPolicy; id: string; kind: SignalKind; source: 'demo' | 'csv'; row: SignalRow; metrics: SignalMetrics; status: 'normal' | 'warning' | 'needs_evidence'; importedAt: string; batchId: string; hash: string; ruleVersion: string }
export interface SignalBatch { provenance?:EvidenceProvenance; ruleVersion: string; id: string; kind: SignalKind; source: 'demo' | 'csv'; importedAt: string; accepted: number; rejected: number; hash: string; errors: { line: number; reason: string }[] }
export interface SignalSnapshot { records: SignalRecord[]; batches: SignalBatch[]; ruleVersion: string; pagination?: SignalPagination }
export const shiftDate = (value: string, days: number): string => new Date(Date.parse(value + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
export function signalKey(kind: SignalKind, row: SignalRow): string {
  return JSON.stringify([row.shop_id, row.channel, row.sku_id, row.date, kind === 'inventory' ? (row as InventoryRow).warehouse_id : (row as AdsRow).campaign_id]);
}
export function previewSignals(kind: SignalKind, csv: string, proposed?: Record<string, string>): SignalPreview {
  const rows = parseCsv(csv); const headers = rows.shift()?.map(s => s.trim()) ?? [];
  if (!headers.length || headers.length > 64 || headers.some(s => !s) || new Set(headers).size !== headers.length) throw new Error('表头不能为空或重复，最多 64 列');
  const fields = kind === 'inventory' ? INVENTORY_FIELDS : ADS_FIELDS;
  const mapping = Object.fromEntries(fields.map(f => [f, proposed?.[f] ?? (headers.includes(f) ? f : headers.includes(SIGNAL_LABELS[f] ?? '') ? SIGNAL_LABELS[f]! : '')]));
  const mapped = fields.map(f => mapping[f]);
  const incomplete = mapped.some(f => !f || !headers.includes(f)) || new Set(mapped).size !== mapped.length;
  if (proposed && incomplete) throw new Error('请映射所有字段，每列只能映射一次；未知数值请留空，不要填零');
  const textFields = new Set(['date', 'baseline_end_date', 'shop_id', 'channel', 'sku_id', 'product_name', 'spec', 'warehouse_id', 'campaign_id', 'currency', 'inbound_eta', 'attribution_window', 'baseline_attribution_window']);
  const nullableText = new Set(['inbound_eta', 'attribution_window', 'baseline_attribution_window']);
  const valid: SignalRow[] = []; const rejected: SignalPreview['rejected'] = []; const seen = new Set<string>();
  rows.forEach((cells, index) => {
    if (incomplete) { rejected.push({ line: index + 2, reason: '字段映射不完整，请选择列并重新校验' }); return; }
    if (cells.length !== headers.length) { rejected.push({ line: index + 2, reason: '列数与表头不一致' }); return; }
    const input = Object.fromEntries(fields.map(f => { const v = cells[headers.indexOf(mapping[f] ?? '')]?.trim() ?? ''; return [f, textFields.has(f) ? (!v && nullableText.has(f) ? null : v) : !v ? null : /^\d+$/.test(v) ? Number(v) : NaN]; }));
    const parsed = (kind === 'inventory' ? InventorySchema : AdsSchema).safeParse(input);
    if (!parsed.success) { rejected.push({ line: index + 2, reason: parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('；') }); return; }
    const key = signalKey(kind, parsed.data);
    if (seen.has(key)) { rejected.push({ line: index + 2, reason: '重复业务键，保留首行' }); return; }
    seen.add(key); valid.push(parsed.data);
  });
  return { headers, mapping, valid, rejected, total: rows.length };
}
export function calculateSignal(kind: SignalKind, row: SignalRow,rules?:RuleSettings): SignalMetrics {
  const m: SignalMetrics = { available: null, coverageDays: null, salesChangeBps: null, roas: null, baselineRoas: null, roasChangeBps: null, conversionBps: null, baselineConversionBps: null, flags: [], issues: [], notes: ['静态窗口快照，非实时监控；阈值为版本化演示规则', '观察窗与对照窗均按 Asia/Shanghai 日口径，数据须来自相同业务范围'] };
  if(rules){const required=kind==='inventory'?rules.inventoryWindowDays:rules.adsWindowDays;if(required!==null&&row.window_days!==required)m.issues.push('业务窗口不符合配置的可比天数');if(kind==='inventory'&&'recent_sales_qty'in row&&row.recent_sales_qty!==null&&row.recent_sales_qty<rules.minInventorySales)m.issues.push('观察窗销量低于配置的最小样本');if(kind==='ads'&&'clicks'in row&&row.clicks!==null&&row.clicks<rules.minAdsClicks)m.issues.push('点击数低于配置的最小样本');}
  if (row.window_days === null || row.baseline_window_days === null || row.window_days !== row.baseline_window_days || (row.window_days !== null && row.baseline_end_date !== shiftDate(row.date, -row.window_days))) m.issues.push('观察与对照必须为相邻、等长窗口');
  if (kind === 'inventory') {
    const r = row as InventoryRow;
    for (const f of ['recent_sales_qty', 'baseline_sales_qty', 'on_hand', 'reserved', 'inbound_qty', 'lead_days'] as const) if (r[f] === null) m.issues.push(`缺少${SIGNAL_LABELS[f]}`);
    if (r.on_hand !== null && r.reserved !== null) m.available = r.on_hand - r.reserved;
    if (r.recent_sales_qty === 0) m.issues.push('观察窗销量为零，无法估算库存覆盖天数');
    if (r.baseline_sales_qty === 0) m.issues.push('对照窗销量为零，无法计算销量下降比例');
    if (m.available !== null && r.recent_sales_qty !== null && r.recent_sales_qty > 0 && r.window_days !== null) m.coverageDays = m.available * r.window_days / r.recent_sales_qty;
    if (r.recent_sales_qty !== null && r.baseline_sales_qty !== null && r.baseline_sales_qty > 0 && !m.issues.includes('观察与对照必须为相邻、等长窗口')) m.salesChangeBps = Math.round((r.recent_sales_qty - r.baseline_sales_qty) * 10000 / r.baseline_sales_qty);
    if (r.inbound_qty !== null && r.inbound_qty > 0 && !r.inbound_eta) m.issues.push('在途数量已知但预计到货日期缺失');
    if (r.inbound_eta && r.inbound_eta < r.date) m.issues.push('在途预计到货早于快照日期，请核对状态');
    if (m.coverageDays !== null && r.lead_days !== null && m.available !== null && r.recent_sales_qty !== null && r.window_days !== null && BigInt(m.available) * BigInt(r.window_days) <= BigInt(r.recent_sales_qty) * BigInt(r.lead_days + (rules?.stockBufferDays??2))) m.flags.push(`库存覆盖不足补货交期加 ${rules?.stockBufferDays??2} 天缓冲`);
    if (m.salesChangeBps !== null && r.recent_sales_qty !== null && r.baseline_sales_qty !== null && r.baseline_sales_qty > 0 && BigInt(r.recent_sales_qty) * 10000n <= BigInt(r.baseline_sales_qty) * BigInt(10000-(rules?.salesDropBps??2000))) m.flags.push(`相邻等长窗口销量下降至少 ${(rules?.salesDropBps??2000)/100}%`);
    if (m.coverageDays !== null && r.inbound_eta && (Date.parse(r.inbound_eta + 'T00:00:00Z') - Date.parse(r.date + 'T00:00:00Z')) / 86400000 > Math.ceil(m.coverageDays)) m.flags.push('预计到货晚于当前销量下的库存覆盖期');
    m.notes.push('即时可售 = 现存 − 占用；在途不计入即时可售', '覆盖天数 = 即时可售 ÷（观察窗净销量 ÷ 天数），假设日均销量不变，不等于需求预测', '销量下降不能直接归因为缺货；在途受理不表示已经到账');
  } else {
    const r = row as AdsRow;
    for (const f of ['spend_minor', 'attributed_revenue_minor', 'clicks', 'conversions', 'baseline_spend_minor', 'baseline_revenue_minor', 'baseline_clicks', 'baseline_conversions'] as const) if (r[f] === null) m.issues.push(`缺少${SIGNAL_LABELS[f]}`);
    if (!r.attribution_window || !r.baseline_attribution_window || r.attribution_window !== r.baseline_attribution_window) m.issues.push('归因窗口缺失或不一致，禁止比较 ROAS');
    if (r.spend_minor === 0 || r.baseline_spend_minor === 0) m.issues.push('当前或对照广告花费为零，ROAS 不可比较');
    if (r.spend_minor !== null && r.spend_minor > 0 && r.attributed_revenue_minor !== null) m.roas = r.attributed_revenue_minor / r.spend_minor;
    if (r.baseline_spend_minor !== null && r.baseline_spend_minor > 0 && r.baseline_revenue_minor !== null) m.baselineRoas = r.baseline_revenue_minor / r.baseline_spend_minor;
    if (m.baselineRoas === 0) m.issues.push('对照 ROAS 为零，无法计算相对下降');
    if (r.clicks !== null && r.clicks > 0 && r.conversions !== null) m.conversionBps = Math.round(r.conversions * 10000 / r.clicks);
    if (r.baseline_clicks !== null && r.baseline_clicks > 0 && r.baseline_conversions !== null) m.baselineConversionBps = Math.round(r.baseline_conversions * 10000 / r.baseline_clicks);
    if (!m.issues.length && m.roas !== null && m.baselineRoas !== null && m.baselineRoas > 0) {
      m.roasChangeBps = Math.round((m.roas / m.baselineRoas - 1) * 10000);
      if (BigInt(r.attributed_revenue_minor!) * BigInt(r.baseline_spend_minor!) * 10000n <= BigInt(r.baseline_revenue_minor!) * BigInt(r.spend_minor!) * BigInt(10000-(rules?.adsRoasDropBps??2000))) m.flags.push(`同口径 ROAS 相对下降至少 ${(rules?.adsRoasDropBps??2000)/100}%`);
    }
    m.notes.push('ROAS = 归因成交额 ÷ 广告花费，不代表毛利或净利润', '点击转化率 = 转化数 ÷ 点击数；零点击时显示未知，不假定为零', '缺少库存、自然流量和完整费用证据，不能仅凭 ROAS 下降直接调整预算');
  }
  return m;
}
const csv = (fields: string[], values: Record<string, unknown>[]) => [fields.join(','), ...values.map(r => fields.map(f => String(r[f] ?? '')).join(','))].join('\n');
const shared = { date: '2026-10-14', baseline_end_date: '2026-10-07', shop_id: 'demo-nanfeng', channel: '线上商城', window_days: 7, baseline_window_days: 7 };
export const INVENTORY_DEMO = csv(INVENTORY_FIELDS, [
  { ...shared, sku_id: 'TEA-500', product_name: '桂花乌龙冷萃茶', spec: '500ml × 6瓶', warehouse_id: 'WH-01', recent_sales_qty: 140, baseline_sales_qty: 210, on_hand: 50, reserved: 10, inbound_qty: 100, inbound_eta: '2026-10-20', lead_days: 5 },
  { ...shared, sku_id: 'COFFEE-12', product_name: '醇香挂耳咖啡', spec: '12袋礼盒', warehouse_id: 'WH-01', recent_sales_qty: 70, baseline_sales_qty: 70, on_hand: 310, reserved: 10, inbound_qty: 0, inbound_eta: null, lead_days: 3 },
  { ...shared, sku_id: 'OAT-1000', product_name: '原味燕麦奶', spec: '1000ml', warehouse_id: 'WH-01', recent_sales_qty: null, baseline_sales_qty: 100, on_hand: 40, reserved: 5, inbound_qty: 60, inbound_eta: null, lead_days: 4 },
]);
export const INVENTORY_EXECUTION_DEMO = INVENTORY_DEMO.replace(',2026-10-20,5', ',2026-10-20,1');
export const ADS_DEMO = csv(ADS_FIELDS, [
  { ...shared, sku_id: 'TEA-500', campaign_id: 'CMP-TEA', currency: 'CNY', attribution_window: '7d_click', baseline_attribution_window: '7d_click', spend_minor: 100000, attributed_revenue_minor: 180000, clicks: 1000, conversions: 30, baseline_spend_minor: 100000, baseline_revenue_minor: 300000, baseline_clicks: 1000, baseline_conversions: 50 },
  { ...shared, sku_id: 'COFFEE-12', campaign_id: 'CMP-COFFEE', currency: 'CNY', attribution_window: '7d_click', baseline_attribution_window: '7d_click', spend_minor: 100000, attributed_revenue_minor: 320000, clicks: 1000, conversions: 60, baseline_spend_minor: 100000, baseline_revenue_minor: 300000, baseline_clicks: 1000, baseline_conversions: 50 },
  { ...shared, sku_id: 'OAT-1000', campaign_id: 'CMP-OAT', currency: 'CNY', attribution_window: '1d_click', baseline_attribution_window: '7d_click', spend_minor: 50000, attributed_revenue_minor: 60000, clicks: 500, conversions: 20, baseline_spend_minor: 50000, baseline_revenue_minor: 120000, baseline_clicks: 500, baseline_conversions: 40 },
]);
