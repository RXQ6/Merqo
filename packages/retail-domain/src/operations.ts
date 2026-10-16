import { z } from 'zod';
import type { AnyInvestigation } from './investigations';
import type { SignalPreview, SignalSnapshot } from './signals';

export const RULE_VERSION = 'retail-margin-v1';
export const FIELDS = ['date', 'shop_id', 'channel', 'sku_id', 'product_name', 'spec', 'currency', 'list_price_minor', 'coupon_minor', 'full_reduction_minor', 'subsidy_minor', 'subsidy_funder', 'cost_minor', 'sold_qty', 'on_hand', 'reserved', 'inbound_qty'] as const;
export type Field = typeof FIELDS[number];
export const FIELD_LABELS: Record<Field, string> = {
  date: '经营日期', shop_id: '店铺', channel: '渠道', sku_id: 'SKU 编号', product_name: '商品名称', spec: '规格', currency: '币种', list_price_minor: '单价（分）', coupon_minor: '商家券（分/件）', full_reduction_minor: '商家满减（分/件）', subsidy_minor: '额外结算补贴（分/件）', subsidy_funder: '补贴承担方', cost_minor: '成本（分/件）', sold_qty: '净成交件数', on_hand: '现存件数', reserved: '占用件数', inbound_qty: '在途件数',
};
const money = z.number().int().min(0).max(100_000_000);
export const RowSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(value + 'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, '日期不存在'),
  shop_id: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(80), sku_id: z.string().trim().min(1).max(100),
  product_name: z.string().trim().min(1).max(200), spec: z.string().trim().min(1).max(160), currency: z.literal('CNY'),
  list_price_minor: money.positive(), coupon_minor: money, full_reduction_minor: money, subsidy_minor: money,
  subsidy_funder: z.enum(['platform', 'merchant', 'unknown']), cost_minor: money.nullable(),
  sold_qty: z.number().int().min(0).max(1_000_000), on_hand: z.number().int().min(0).max(1_000_000), reserved: z.number().int().min(0).max(1_000_000), inbound_qty: z.number().int().min(0).max(1_000_000),
}).superRefine((row, ctx) => {
  if (row.reserved > row.on_hand) ctx.addIssue({ code: 'custom', message: '占用库存不能超过现存库存' });
  if (row.coupon_minor + row.full_reduction_minor > row.list_price_minor) ctx.addIssue({ code: 'custom', message: '商家优惠合计不能超过单价' });
});
export type RetailRow = z.infer<typeof RowSchema>;
export interface RejectedRow { line: number; reason: string }
export interface Preview { headers: string[]; mapping: Record<string, string>; sample: string[][]; valid: RetailRow[]; rejected: RejectedRow[]; duplicateCount: number; total: number }
export const MappingSchema = z.record(z.string(), z.string().max(200));
export const RetailRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('signals') }),
  z.strictObject({ op: z.literal('signals_demo') }),
  z.strictObject({ op: z.literal('signals_preview'), kind: z.enum(['inventory', 'ads']), csv: z.string().min(1).max(2_000_000), mapping: MappingSchema.optional() }),
  z.strictObject({ op: z.literal('signals_import'), kind: z.enum(['inventory', 'ads']), csv: z.string().min(1).max(2_000_000), mapping: MappingSchema }),
  z.strictObject({ op: z.literal('investigations'), recordId: z.string().max(64).optional() }),
  z.strictObject({ op: z.literal('investigate'), recordId: z.string().min(1).max(64), mode: z.enum(['model', 'replay']), scenario: z.enum(['margin', 'inventory', 'ads']).optional(), retry: z.boolean().optional() }),
  z.strictObject({ op: z.literal('snapshot') }),
  z.strictObject({ op: z.literal('demo') }),
  z.strictObject({ op: z.literal('preview'), csv: z.string().min(1).max(2_000_000), mapping: MappingSchema.optional() }),
  z.strictObject({ op: z.literal('import'), csv: z.string().min(1).max(2_000_000), mapping: MappingSchema }),
]);
export type RetailRequest = z.infer<typeof RetailRequestSchema>;

/** RFC-style quoted fields, escaped quotes, BOM, CRLF and embedded newlines. */
export function parseCsv(input: string): string[][] {
  if (input.length > 2_000_000) throw new Error('CSV 超过 2 MB 限制');
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, endedQuote = false;
  const cell = () => { row.push(field); field = ''; endedQuote = false; };
  const record = () => { cell(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > 10001) throw new Error('最多导入 10,000 行'); };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') { quoted = false; endedQuote = true; }
      else field += ch;
    } else if (ch === '"') {
      if (field.length || endedQuote) throw new Error('CSV 引号格式错误');
      quoted = true;
    } else if (ch === ',') cell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; record(); }
    else { if (endedQuote) throw new Error('CSV 引号后只能出现分隔符'); field += ch; }
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  if (field || row.length || endedQuote) record();
  return rows;
}
export function rowKey(row: RetailRow): string { return JSON.stringify([row.shop_id, row.channel, row.sku_id, row.date]); }
export function previewCsv(csv: string, proposed?: Record<string, string>): Preview {
  const records = parseCsv(csv);
  const headers = records.shift()?.map(value => value.trim()) ?? [];
  if (headers.length === 0 || new Set(headers).size !== headers.length || headers.some(header => !header)) throw new Error('表头不能为空或重复');
  if (headers.length > 64) throw new Error('CSV 最多支持 64 列，请移除无关字段');
  const mapping: Record<string, string> = {};
  for (const key of FIELDS) mapping[key] = proposed?.[key] ?? (headers.includes(key) ? key : headers.includes(FIELD_LABELS[key]) ? FIELD_LABELS[key] : '');
  if (proposed) {
    const columns = FIELDS.map(key => mapping[key]);
    if (columns.some(value => !value || !headers.includes(value))) throw new Error('请为每个字段选择有效的 CSV 列');
    if (new Set(columns).size !== columns.length) throw new Error('同一 CSV 列不能映射到多个字段');
  }
  const valid: RetailRow[] = [], rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const [index, cells] of records.entries()) {
    if (cells.length !== headers.length) { rejected.push({ line: index + 2, reason: '列数与表头不一致' }); continue; }
    const raw: Record<string, unknown> = {};
    for (const key of FIELDS) {
      const value = cells[headers.indexOf(mapping[key] ?? '')]?.trim() ?? '';
      if (key.endsWith('_minor') || ['sold_qty', 'on_hand', 'reserved', 'inbound_qty'].includes(key)) raw[key] = key === 'cost_minor' && !value ? null : /^\d+$/.test(value) ? Number(value) : Number.NaN;
      else raw[key] = value;
    }
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) { rejected.push({ line: index + 2, reason: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }); continue; }
    if (seen.has(rowKey(parsed.data))) { duplicateCount++; rejected.push({ line: index + 2, reason: '店铺、渠道、SKU、日期重复，保留第一行' }); continue; }
    seen.add(rowKey(parsed.data)); valid.push(parsed.data);
  }
  return { headers, mapping, sample: records.slice(0, 4), valid, rejected, duplicateCount, total: records.length };
}
export interface Calculation { revenueMinor: number | null; profitMinor: number | null; marginBps: number | null; totalRevenueMinor: number | null; totalProfitMinor: number | null; available: number; issues: string[] }
export function calculate(row: RetailRow, specConflict = false): Calculation {
  const issues: string[] = [];
  if (row.cost_minor === null) issues.push('缺少商品成本');
  if (row.subsidy_minor > 0 && row.subsidy_funder !== 'platform') issues.push(row.subsidy_funder === 'unknown' ? '补贴承担方未知' : '商家承担的补贴须归入商家优惠，当前口径不支持');
  if (specConflict) issues.push('同店铺同渠道 SKU 出现多种规格，须人工核对映射');
  const revenue = row.list_price_minor - row.coupon_minor - row.full_reduction_minor + row.subsidy_minor;
  if (revenue <= 0) issues.push('商家商品收入不大于零');
  const ready = issues.length === 0;
  const profit = ready && row.cost_minor !== null ? revenue - row.cost_minor : null;
  return { revenueMinor: ready ? revenue : null, profitMinor: profit, marginBps: profit === null ? null : Math.round(profit * 10000 / revenue), totalRevenueMinor: ready ? revenue * row.sold_qty : null, totalProfitMinor: profit === null ? null : profit * row.sold_qty, available: row.on_hand - row.reserved, issues };
}
export interface EvidenceRecord { id: string; batchId: string; source: 'demo' | 'csv'; importedAt: string; snapshotHash: string; ruleVersion: string; row: RetailRow; calculation: Calculation; status: 'normal' | 'low_margin' | 'needs_evidence'; reasons: string[]; thresholdBps: number }
export interface BatchSummary { id: string; source: 'demo' | 'csv'; importedAt: string; accepted: number; rejected: number; hash: string; errors: RejectedRow[]; ruleVersion: string }
export interface Snapshot { workspaceName: string; records: EvidenceRecord[]; batches: BatchSummary[]; dbVersion: number; ruleVersion: string; thresholdBps: number }
export type RetailReply = { ok: true; kind: 'snapshot'; data: Snapshot; signals?: SignalSnapshot; notice?: string } | { ok: true; kind: 'preview'; data: Preview } | { ok: true; kind: 'investigations'; data: AnyInvestigation[]; created?: boolean } | { ok: true; kind: 'signals'; data: SignalSnapshot; notice?: string } | { ok: true; kind: 'signals_preview'; data: SignalPreview } | { ok: false; error: string };

const demoRows: RetailRow[] = [
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'TEA-500', product_name: '桂花乌龙冷萃茶', spec: '500ml × 6瓶', currency: 'CNY', list_price_minor: 10000, coupon_minor: 2000, full_reduction_minor: 1000, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 6000, sold_qty: 40, on_hand: 120, reserved: 10, inbound_qty: 60 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'COFFEE-12', product_name: '醇香挂耳咖啡', spec: '12袋礼盒', currency: 'CNY', list_price_minor: 10000, coupon_minor: 2000, full_reduction_minor: 0, subsidy_minor: 1000, subsidy_funder: 'platform', cost_minor: 6000, sold_qty: 30, on_hand: 80, reserved: 5, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'SNACK-300', product_name: '每日坚果分享装', spec: '300g', currency: 'CNY', list_price_minor: 5000, coupon_minor: 500, full_reduction_minor: 0, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: null, sold_qty: 20, on_hand: 45, reserved: 0, inbound_qty: 30 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'OAT-1000', product_name: '原味燕麦奶', spec: '1L × 3盒', currency: 'CNY', list_price_minor: 6000, coupon_minor: 1000, full_reduction_minor: 500, subsidy_minor: 500, subsidy_funder: 'unknown', cost_minor: 3500, sold_qty: 25, on_hand: 30, reserved: 4, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'HONEY-250', product_name: '山花蜂蜜', spec: '250g', currency: 'CNY', list_price_minor: 8000, coupon_minor: 500, full_reduction_minor: 0, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 4000, sold_qty: 15, on_hand: 50, reserved: 0, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'RICE-2', product_name: '五常鲜米', spec: '2kg', currency: 'CNY', list_price_minor: 4000, coupon_minor: 1000, full_reduction_minor: 500, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 2800, sold_qty: 20, on_hand: 60, reserved: 10, inbound_qty: 100 },
];
function csvCell(value: unknown): string { const text = value === null ? '' : String(value); return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; }
export const DEMO_CSV = [FIELDS.join(','), ...demoRows.map(row => FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
export function exportCsv(records: EvidenceRecord[]): string {
  const safe = (value: unknown) => { const text = String(value ?? ''); return csvCell(/^[=+\-@\t\r]/.test(text) ? "'" + text : text); };
  return '\uFEFF' + [['店铺', '渠道', '日期', 'SKU', '商品', '规格', '状态', '商家收入分每件', '毛利分每件', '毛利率基点', '证据ID', '快照SHA256', '规则版本'], ...records.map(record => [record.row.shop_id, record.row.channel, record.row.date, record.row.sku_id, record.row.product_name, record.row.spec, record.status, record.calculation.revenueMinor, record.calculation.profitMinor, record.calculation.marginBps, record.id, record.snapshotHash, record.ruleVersion])].map(row => row.map(safe).join(',')).join('\r\n');
}
