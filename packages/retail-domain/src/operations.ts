import {ProcurementPublicSchemas,type ProcurementView,type ProcurementPreview,type ProcurementReceipt} from './procurement-contract';
import {BackupPublicSchemas,type BackupResult} from './backup-contract';
import type {CleanupView} from './adapters/sync-cleanup-contract';
import type {IngestionIssues} from './adapters/ingestion-issues-contract';
import {InspectionPublicSchemas,type InspectionView,type InspectionPreview,type InspectionReceipt} from './return-inspection-contract';
import {ContributionComparisonSchemas,type ContributionComparison} from './contribution-comparison';
import {ContributionPublicSchemas,type ContributionReport} from './contribution';
import {IngestPublicSchemas} from './adapters/ingestion-contract';
import type {IngestView} from './adapters/ingestion-contract';
import type {SyncJob} from './adapters/sync-contract';
import {parseCsv} from './csv';
import {SyncPublicSchemas} from './adapters/sync-contract';
import type {SyncView} from './adapters/sync-contract';
export {parseCsv} from './csv';
import {CatalogUpdateSchema} from './catalog';
import type {SupplementPreview} from './supplement';
import type {CatalogView} from './catalog';
import {TransactionPreviewRequest,TransactionImportRequest,TransactionPageRequest} from './transactions';
import type {TransactionPage,TransactionPreview} from './transactions';
import {SourceMetadataInputSchema} from './source-metadata';
import type {EvidenceProvenance} from './source-metadata';
import {PolicyUpdateSchema} from './business-policy';
import type {RuleSettings,FrozenPolicy,PolicyView} from './business-policy';
import type { ReviewView, ObservationPreview } from './outcome-reviews';
import type { BatchView } from './execution-batches';
import type { CompensationView } from './compensation';
import { z } from 'zod';
import type { ExecutionView } from './simulation';
import type { ApprovalView } from './approval-types';
import type { DecisionDraft } from './decisions';
import type { AnyInvestigation } from './investigations';
import type { SignalPreview, SignalSnapshot } from './signals';
import { SignalPageSchema } from './signal-page';
import type { SignalPage } from './signal-page';
import { CheckConfigSchema } from './check-types';
import { OfferSchema, selectOffers } from './offers';
import type { ChecksView } from './check-types';
import { RetailPageSchema } from './retail-query';
import type { RetailPagination } from './retail-query';

export const RULE_VERSION = 'retail-margin-v6';
export const FIELDS = ['date', 'shop_id', 'channel', 'sku_id', 'product_name', 'spec', 'currency', 'list_price_minor', 'coupon_minor', 'full_reduction_minor', 'subsidy_minor', 'subsidy_funder', 'cost_minor', 'sold_qty', 'on_hand', 'reserved', 'inbound_qty'] as const;
export type Field = typeof FIELDS[number];
export const OPTIONAL_FIELDS = ['product_type', 'bundle_components', 'gift_policy', 'gift_cost_basis', 'gifts', 'membership', 'offers'] as const;
export const IMPORT_FIELDS = [...FIELDS, ...OPTIONAL_FIELDS] as const;
export const FIELD_LABELS: Record<typeof IMPORT_FIELDS[number], string> = {
  product_type: '商品类型（可选：single / bundle）', bundle_components: '组合装子项（可选：JSON）',
  gift_policy: '赠送规则（可选：none / free_per_unit / unknown）', gift_cost_basis: '赠品成本口径（可选：additional / included / unknown）', gifts: '赠品明细（可选：JSON）',
  membership: '会员价格上下文（可选：JSON）',
  offers: '参考报价（可选：JSON）',
  date: '经营日期', shop_id: '店铺', channel: '渠道', sku_id: 'SKU 编号', product_name: '商品名称', spec: '规格', currency: '币种', list_price_minor: '单价（分）', coupon_minor: '商家券（分/件）', full_reduction_minor: '商家满减（分/件）', subsidy_minor: '额外结算补贴（分/件）', subsidy_funder: '补贴承担方', cost_minor: '成本（分/件）', sold_qty: '净成交件数', on_hand: '现存件数', reserved: '占用件数', inbound_qty: '在途件数',
};
const money = z.number().int().min(0).max(100_000_000);
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(value + 'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, '日期不存在');
export const MembershipSchema = z.strictObject({
  status: z.enum(['member', 'non_member', 'unknown']).optional(),
  segment_id: z.string().trim().min(1).max(100).nullable().optional(),
  price_minor: money.positive().nullable().optional(),
  valid_from: businessDate.nullable().optional(),
  valid_to: businessDate.nullable().optional(),
  discount_policy: z.enum(['stackable', 'exclusive', 'unknown']).optional(),
});
export const BundleComponentSchema = z.strictObject({
  sku_id: z.string().trim().min(1).max(100),
  spec: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(1).max(10000),
  unit_cost_minor: money.nullable(),
});
export interface BundleNode {sku_id:string;spec:string;quantity:number;unit_cost_minor:number|null;children?:BundleNode[]|undefined}
const BundleNodeSchema:z.ZodType<BundleNode>=z.lazy(()=>BundleComponentSchema.extend({children:z.array(BundleNodeSchema).min(1).max(100).optional()}));
// Bound the raw tree before recursive schema parsing, including malformed or cyclic JS inputs.
const BundleTreeSchema=z.unknown().superRefine((value,ctx)=>{
 const stack:Array<{value:unknown;depth:number}>=Array.isArray(value)?value.map(value=>({value,depth:1})):[];let count=0;
 while(stack.length){const item=stack.pop()!;if(++count>500||item.depth>6){ctx.addIssue({code:'custom',message:'组合装最多6层、500个子项'});return;}if(typeof item.value==='object'&&item.value!==null&&'children'in item.value&&Array.isArray(item.value.children)){if(item.value.children.length>100){ctx.addIssue({code:'custom',message:'每层组合装最多100个直接子项'});return;}for(const child of item.value.children)stack.push({value:child,depth:item.depth+1});}}
}).pipe(z.array(BundleNodeSchema).max(100).nullable().optional());
export const RowSchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const date = new Date(value + 'T00:00:00Z'); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value; }, '日期不存在'),
  shop_id: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(80), sku_id: z.string().trim().min(1).max(100),
  product_name: z.string().trim().min(1).max(200), spec: z.string().trim().min(1).max(160), currency: z.literal('CNY'),
  list_price_minor: money.positive(), coupon_minor: money, full_reduction_minor: money, subsidy_minor: money,
  subsidy_funder: z.enum(['platform', 'merchant', 'unknown']), cost_minor: money.nullable(),
  product_type: z.enum(['single', 'bundle']).optional(),
  bundle_components: BundleTreeSchema,
  gift_policy: z.enum(['none', 'free_per_unit', 'unknown']).optional(),
  gift_cost_basis: z.enum(['additional', 'included', 'unknown']).optional(),
  gifts: z.array(BundleComponentSchema).max(100).nullable().optional(),
  membership: MembershipSchema.nullable().optional(),
  offers: z.array(OfferSchema).max(100).nullable().optional(),
  sold_qty: z.number().int().min(0).max(1_000_000), on_hand: z.number().int().min(0).max(1_000_000), reserved: z.number().int().min(0).max(1_000_000), inbound_qty: z.number().int().min(0).max(1_000_000),
}).superRefine((row, ctx) => {
  if (row.reserved > row.on_hand) ctx.addIssue({ code: 'custom', message: '占用库存不能超过现存库存' });
  if (row.coupon_minor + row.full_reduction_minor > row.list_price_minor) ctx.addIssue({ code: 'custom', message: '商家优惠合计不能超过单价' });
});
export type RetailRow = z.infer<typeof RowSchema>;
export interface RejectedRow { line: number; reason: string }
export interface Preview { headers: string[]; mapping: Record<string, string>; sample: string[][]; valid: RetailRow[]; validCount?: number; rejected: RejectedRow[]; duplicateCount: number; total: number }
export const MappingSchema = z.record(z.string(), z.string().max(200));
export const RetailRequestSchema = z.discriminatedUnion('op', [...ProcurementPublicSchemas,...BackupPublicSchemas,...SyncPublicSchemas,...IngestPublicSchemas,...ContributionPublicSchemas,...ContributionComparisonSchemas,...InspectionPublicSchemas,z.strictObject({op:z.literal('investigation_supplement_preview'),id:z.string().uuid()}),z.strictObject({op:z.literal('investigation_supplement'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}),CatalogUpdateSchema,z.strictObject({op:z.literal('catalog')}),TransactionPreviewRequest,TransactionImportRequest,TransactionPageRequest,z.strictObject({op:z.literal('transactions_demo')}),z.strictObject({op:z.literal('policy')}),PolicyUpdateSchema,
  z.strictObject({ op: z.literal('checks') }),
  z.strictObject({ op: z.literal('check_configure'), expectedRevision: z.number().int().min(1), config: CheckConfigSchema }),
  z.strictObject({ op: z.literal('check_run') }),
  z.strictObject({ op: z.literal('check_catchup') }),
  z.strictObject({ op: z.literal('check_retry'), id: z.string().uuid() }),
  z.strictObject({ op: z.literal('signals') }),
  SignalPageSchema.extend({ op: z.literal('signals_page') }),
  z.strictObject({ op: z.literal('signals_demo') }),
  z.strictObject({ op: z.literal('signals_replenishment_demo') }),
  z.strictObject({ op: z.literal('signals_preview'), kind: z.enum(['inventory', 'ads']), csv: z.string().min(1).max(32_000_000), mapping: MappingSchema.optional() }),
  z.strictObject({ op: z.literal('signals_import'), sourceMetadata:SourceMetadataInputSchema.optional(), kind: z.enum(['inventory', 'ads']), csv: z.string().min(1).max(32_000_000), mapping: MappingSchema }),
  z.strictObject({ op: z.literal('investigation_export'), id: z.string().uuid(), format: z.enum(['json', 'md']) }),
  z.strictObject({ op: z.literal('investigation_pause'), id: z.string().uuid(), expectedEpoch: z.number().int().min(0).max(1000) }),
  z.strictObject({ op: z.literal('investigation_resume'), id: z.string().uuid(), expectedEpoch: z.number().int().min(0).max(1000) }),
  z.strictObject({op:z.literal('review_followup'),id:z.string().uuid(),expectedCaseId:z.string().uuid(),mode:z.enum(['model','replay'])}),
  z.strictObject({op:z.literal('reviews')}),
  z.strictObject({op:z.literal('review_create'),jobId:z.string().regex(/^[a-f0-9]{64}$/)}),
  z.strictObject({op:z.literal('review_preview'),id:z.string().uuid(),csv:z.string().min(1).max(2_000_000)}),
  z.strictObject({op:z.literal('review_observe'),id:z.string().uuid(),expectedVersion:z.number().int().min(1).max(100000),synthetic:z.literal(true),csv:z.string().min(1).max(2_000_000),previewHash:z.string().regex(/^[a-f0-9]{64}$/)}),
  z.strictObject({op:z.literal('review_demo'),id:z.string().uuid(),expectedVersion:z.number().int().min(1).max(100000),synthetic:z.literal(true)}),
  z.strictObject({op:z.literal('review_finalize'),id:z.string().uuid(),expectedVersion:z.number().int().min(1).max(100000),observationHash:z.string().regex(/^[a-f0-9]{64}$/),conclusion:z.enum(['comparison_only','inconclusive']),note:z.string().trim().min(1).max(2000),confounders:z.string().trim().min(1).max(2000)}),
  z.strictObject({ op: z.literal('compensations') }),
  z.strictObject({ op: z.literal('compensation_create'), sourceJobId:z.string().regex(/^[a-f0-9]{64}$/), reason:z.string().trim().min(1).max(2000) }),
  z.strictObject({ op: z.literal('compensation_revise'), id:z.string().uuid(), expectedVersion:z.number().int().min(1).max(100000), reason:z.string().trim().min(1).max(2000) }),
  z.strictObject({ op: z.literal('compensation_resolve'), id:z.string().uuid(), expectedVersion:z.number().int().min(1).max(100000), expectedActionHash:z.string().regex(/^[a-f0-9]{64}$/), choice:z.enum(['approve','reject']), reason:z.string().trim().min(1).max(2000) }),
  z.strictObject({ op: z.literal('compensation_execute'), id:z.string().uuid(), expectedVersion:z.number().int().min(1).max(100000), expectedActionHash:z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ op: z.literal('compensation_reconcile'), id:z.string().uuid() }),
  z.strictObject({ op:z.literal('execution_batches') }),
  z.strictObject({ op:z.literal('batch_create'),jobIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2).max(10),reason:z.string().trim().min(1).max(2000) }),
  z.strictObject({ op:z.literal('batch_run'),id:z.string().uuid() }),
  z.strictObject({ op:z.literal('batch_retry_item'),id:z.string().uuid(),jobId:z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ op:z.literal('batch_recover'),id:z.string().uuid() }),
  z.strictObject({ op: z.literal('executions') }),
  z.strictObject({ op: z.literal('simulation_execute'), id: z.string().regex(/^[a-f0-9]{64}$/), expectedVersion: z.number().int().min(1).max(100000), expectedActionHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ op: z.literal('execution_reconcile'), id: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ op: z.literal('approvals') }),
  z.strictObject({ op: z.literal('approval_resolve'), requestId: z.string().uuid(), expectedVersion: z.number().int().min(1).max(100000), expectedActionHash: z.string().regex(/^[a-f0-9]{64}$/), choice: z.enum(['approve', 'reject']), reason: z.string().trim().min(1).max(2000) }),
  z.strictObject({ op: z.literal('decisions') }),
  z.strictObject({ op: z.literal('decision_create'), investigationId: z.string().uuid(), kind: z.enum(['observe', 'reduce_coupon', 'set_price', 'replenish_draft', 'reduce_budget']), note: z.string().trim().max(2000) }),
  z.strictObject({ op: z.literal('decision_revise'), id: z.string().uuid(), expectedVersion: z.number().int().min(1).max(100000), kind: z.enum(['observe', 'reduce_coupon', 'set_price', 'replenish_draft', 'reduce_budget']), note: z.string().trim().max(2000) }),
  z.strictObject({ op: z.literal('decision_submit'), id: z.string().uuid(), expectedVersion: z.number().int().min(1).max(100000) }),
  z.strictObject({ op: z.literal('decision_history'), id: z.string().uuid() }),
  z.strictObject({ op: z.literal('investigations'), recordId: z.string().max(64).optional(), id: z.string().min(1).max(64).optional() }).refine(r => !r.id || !r.recordId, '调查ID与快照筛选不能同时提供'),
  z.strictObject({ op: z.literal('investigate'), recordId: z.string().min(1).max(64), mode: z.enum(['model', 'replay']), marginAction:z.enum(['reduce_coupon','set_price']).optional(), scenario: z.enum(['margin', 'inventory', 'ads']).optional(), retry: z.boolean().optional() }),
  RetailPageSchema.extend({ op: z.literal('snapshot') }),
  z.strictObject({ op: z.literal('demo') }),
  z.strictObject({ op: z.literal('preview'), csv: z.string().min(1).max(32_000_000), mapping: MappingSchema.optional() }),
  z.strictObject({ op: z.literal('import'), sourceMetadata:SourceMetadataInputSchema.optional(), csv: z.string().min(1).max(32_000_000), mapping: MappingSchema }),
]);
export type RetailRequest = z.infer<typeof RetailRequestSchema>;

export function rowKey(row: RetailRow): string { return JSON.stringify([row.shop_id, row.channel, row.sku_id, row.date]); }
export function previewCsv(csv: string, proposed?: Record<string, string>): Preview {
  const records = parseCsv(csv);
  const headers = records.shift()?.map(value => value.trim()) ?? [];
  if (headers.length === 0 || new Set(headers).size !== headers.length || headers.some(header => !header)) throw new Error('表头不能为空或重复');
  if (headers.length > 64) throw new Error('CSV 最多支持 64 列，请移除无关字段');
  const mapping: Record<string, string> = {};
  for (const key of IMPORT_FIELDS) {
    const column = proposed?.[key] ?? (headers.includes(key) ? key : headers.includes(FIELD_LABELS[key]) ? FIELD_LABELS[key] : '');
    if (column || (FIELDS as readonly string[]).includes(key)) mapping[key] = column;
  }
  if (proposed) {
    const columns = IMPORT_FIELDS.map(key => mapping[key]).filter((column): column is string => Boolean(column));
    if (FIELDS.some(key => !mapping[key]) || columns.some(value => !headers.includes(value))) throw new Error('请为每个必填字段选择有效的 CSV 列');
    if (new Set(columns).size !== columns.length) throw new Error('同一 CSV 列不能映射到多个字段');
  }
  // A recognized business column must never silently disappear through a blank/custom mapping.
  for (const key of OPTIONAL_FIELDS) {
    const header = headers.includes(key) ? key : headers.includes(FIELD_LABELS[key]) ? FIELD_LABELS[key] : undefined;
    if (header && mapping[key] !== header) throw new Error(`${key} 业务列必须保留原字段映射`);
  }
  const valid: RetailRow[] = [], rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (const [index, cells] of records.entries()) {
    if (cells.length !== headers.length) { rejected.push({ line: index + 2, reason: '列数与表头不一致' }); continue; }
    const raw: Record<string, unknown> = {};
    let malformedBundle = false;
    for (const key of IMPORT_FIELDS) {
      const value = cells[headers.indexOf(mapping[key] ?? '')]?.trim() ?? '';
      if (key === 'product_type' || key === 'gift_policy' || key === 'gift_cost_basis') { if (value) raw[key] = value; }
      else if (key === 'bundle_components' || key === 'gifts' || key === 'membership' || key === 'offers') {
        if (value) { try { raw[key] = JSON.parse(value); } catch { malformedBundle = true; } }
      }
      else if (key.endsWith('_minor') || ['sold_qty', 'on_hand', 'reserved', 'inbound_qty'].includes(key)) raw[key] = key === 'cost_minor' && !value ? null : /^\d+$/.test(value) ? Number(value) : Number.NaN;
      else raw[key] = value;
    }
    if (malformedBundle) { rejected.push({ line: index + 2, reason: 'bundle_components / gifts / membership / offers: 业务上下文必须是有效 JSON' }); continue; }
    const parsed = RowSchema.safeParse(raw);
    if (!parsed.success) { rejected.push({ line: index + 2, reason: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('；') }); continue; }
    if (seen.has(rowKey(parsed.data))) { duplicateCount++; rejected.push({ line: index + 2, reason: '店铺、渠道、SKU、日期重复，保留第一行' }); continue; }
    seen.add(rowKey(parsed.data)); valid.push(parsed.data);
  }
  return { headers, mapping, sample: records.slice(0, 4), valid, rejected, duplicateCount, total: records.length };
}
export interface Calculation { revenueMinor: number | null; profitMinor: number | null; marginBps: number | null; totalRevenueMinor: number | null; totalProfitMinor: number | null; available: number; issues: string[] }
export function membershipIdentity(row: RetailRow): string | null {
  if (row.membership === undefined) return null;
  const m = row.membership;
  return JSON.stringify([m?.status ?? null, m?.segment_id ?? null, m?.status === 'member' ? m.discount_policy ?? null : null]);
}
export function membershipIssues(row: RetailRow): string[] {
  if (row.membership === undefined) return [];
  const m = row.membership;
  if (m?.status === 'non_member') return [];
  if (m?.status !== 'member') return ['会员身份未知或未声明，不能选择会员价'];
  const issues: string[] = [];
  if (!m.segment_id) issues.push('缺少会员分组，须补充身份范围');
  if (m.price_minor == null) issues.push('缺少会员价');
  else if (m.price_minor > row.list_price_minor) issues.push('会员价高于普通价，须核对报价口径');
  if (!m.valid_from || !m.valid_to) issues.push('缺少会员价有效期');
  else if (m.valid_from >= m.valid_to || row.date < m.valid_from || row.date >= m.valid_to) issues.push('会员价在业务日期无效，有效期为左闭右开');
  if (!m.discount_policy || m.discount_policy === 'unknown') issues.push('会员价与优惠叠加规则未知');
  if (m.discount_policy === 'exclusive' && (row.coupon_minor > 0 || row.full_reduction_minor > 0)) issues.push('会员价与券或满减互斥，不能同时计价');
  if (m.price_minor != null && row.coupon_minor + row.full_reduction_minor > m.price_minor) issues.push('商家优惠合计超过会员价');
  return issues;
}
export function effectivePrice(row: RetailRow): number | null {
  if (membershipIssues(row).length) return null;
  return row.membership?.status === 'member' ? row.membership.price_minor! : row.list_price_minor;
}
export function bundleIdentity(row: RetailRow): string | null {
  if (row.product_type !== 'bundle') return null;
  const identity=(parts:BundleNode[]):unknown[]=>parts.map(p=>p.children?[p.sku_id,p.spec,p.quantity,identity(p.children)]:[p.sku_id,p.spec,p.quantity]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(row.bundle_components?identity(row.bundle_components):null);
}
export function hasGiftFields(row: RetailRow): boolean {
  return row.gift_policy !== undefined || row.gift_cost_basis !== undefined || row.gifts !== undefined;
}
export function giftIdentity(row: RetailRow): string | null {
  if (!hasGiftFields(row) || (row.gift_policy === 'none' && !row.gifts?.length && row.gift_cost_basis === undefined)) return null;
  return JSON.stringify([row.gift_policy ?? null, row.gift_cost_basis ?? null, row.gifts?.map(p => [p.sku_id, p.spec, p.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) ?? null]);
}
export function giftIssues(row: RetailRow): string[] {
  if (!hasGiftFields(row)) return [];
  if (row.gift_policy === 'none') return row.gifts?.length || row.gift_cost_basis !== undefined ? ['无赠品声明与赠品明细或成本口径冲突'] : [];
  const issues: string[] = [];
  if (row.gift_policy !== 'free_per_unit') issues.push('赠送规则未知或未声明，须明确每销售件免费赠送');
  if (row.gift_cost_basis !== 'additional') issues.push('赠品成本须明确不含在主商品成本中；已含或未知口径待补证');
  if (!row.gifts?.length) issues.push('缺少赠品关联明细');
  const seen = new Set<string>(); let total = 0;
  for (const gift of row.gifts ?? []) {
    if (gift.sku_id === row.sku_id) issues.push('同 SKU 自赠须另行核对成交与赠送数量，当前不支持');
    if (seen.has(gift.sku_id)) issues.push('赠品 SKU 重复或规格映射冲突');
    seen.add(gift.sku_id);
    if (gift.unit_cost_minor === null) issues.push('缺少赠品单位成本');
    else total += gift.quantity * gift.unit_cost_minor;
  }
  if (total > 100_000_000 || (row.cost_minor !== null && total + row.cost_minor > 100_000_000)) issues.push('主商品与赠品合计成本超过金额上限');
  return [...new Set(issues)];
}
export function giftCost(row: RetailRow): number | null {
  if (giftIssues(row).length) return null;
  return (row.gifts ?? []).reduce((total, gift) => total + gift.quantity * gift.unit_cost_minor!, 0);
}
export function marginCost(row: RetailRow): number | null {
  const extra = giftCost(row);
  return row.cost_minor === null || extra === null ? null : row.cost_minor + extra;
}
/** Explicit bounded tree, per sellable pack. Parent unit costs must match their direct children. */
export function bundleIssues(row: RetailRow): string[] {
  const parts = row.bundle_components;
  if (row.product_type !== 'bundle') return parts !== undefined ? ['组合装子项必须明确声明 product_type=bundle'] : [];
  if (!parts?.length) return ['组合装缺少子项映射'];
  const issues: string[] = [];
  const identities=new Map<string,string>();let count=0;
  const sumParts=(children:BundleNode[],ancestors:Set<string>,depth:number):bigint=>{
    if(depth>6){issues.push('组合装最多6层、500个子项');return 0n;}
    const seen=new Set<string>();let sum=0n;
    for(const part of children){
      if(++count>500){issues.push('组合装最多6层、500个子项');return 0n;}
      if(ancestors.has(part.sku_id)){issues.push('组合装不能包含自身 SKU 或祖先 SKU');continue;}
      if(seen.has(part.sku_id))issues.push('组合装子 SKU 重复或规格映射冲突');seen.add(part.sku_id);
      const identity=JSON.stringify([part.spec,part.unit_cost_minor,part.children?bundleIdentity({...row,bundle_components:part.children}):null]);
      if(identities.has(part.sku_id)&&identities.get(part.sku_id)!==identity)issues.push('组合装同 SKU 的规格、成本或子项映射冲突');identities.set(part.sku_id,identity);
      if(part.unit_cost_minor===null)issues.push('组合装缺少子项单位成本');
      if(part.children){const nested=sumParts(part.children,new Set([...ancestors,part.sku_id]),depth+1);if(!part.children.length||part.unit_cost_minor!==null&&nested!==BigInt(part.unit_cost_minor))issues.push('组合装嵌套子项合计与父项单位成本不一致');}
      sum+=BigInt(part.quantity)*BigInt(part.unit_cost_minor??0);
    }
    if(sum>100_000_000n)issues.push('组合装子项合计成本超过金额上限');
    return sum;
  };
  const sum=sumParts(parts,new Set([row.sku_id]),1);
  if(row.cost_minor!==null&&sum!==BigInt(row.cost_minor))issues.push('组合装子项合计与整包成本不一致');
  return [...new Set(issues)];
}
export function calculate(row: RetailRow, specConflict = false, rules?:RuleSettings): Calculation {
  const issues: string[] = [...bundleIssues(row), ...giftIssues(row), ...membershipIssues(row), ...selectOffers(row).issues];
  if(rules&&row.sold_qty<rules.marginMinUnits)issues.push('净成交件数低于配置的最小样本要求');
  if (row.cost_minor === null) issues.push('缺少商品成本');
  if (row.subsidy_minor > 0 && row.subsidy_funder !== 'platform') issues.push(row.subsidy_funder === 'unknown' ? '补贴承担方未知' : '商家承担的补贴须归入商家优惠，当前口径不支持');
  if (specConflict) issues.push('同店铺同渠道 SKU 出现多种规格，须人工核对映射');
  const price = effectivePrice(row);
  const revenue = (price ?? 0) - row.coupon_minor - row.full_reduction_minor + row.subsidy_minor;
  if (price !== null && revenue <= 0) issues.push('商家商品收入不大于零');
  const ready = issues.length === 0;
  const cost = marginCost(row);
  const profit = ready && cost !== null ? revenue - cost : null;
  return { revenueMinor: ready ? revenue : null, profitMinor: profit, marginBps: profit === null ? null : Math.round(profit * 10000 / revenue), totalRevenueMinor: ready ? revenue * row.sold_qty : null, totalProfitMinor: profit === null ? null : profit * row.sold_qty, available: row.on_hand - row.reserved, issues };
}
export interface EvidenceRecord { provenance?:EvidenceProvenance; policy?:FrozenPolicy; id: string; batchId: string; source: 'demo' | 'csv'; importedAt: string; snapshotHash: string; ruleVersion: string; row: RetailRow; calculation: Calculation; status: 'normal' | 'low_margin' | 'needs_evidence'; reasons: string[]; thresholdBps: number }
export interface BatchSummary { provenance?:EvidenceProvenance; id: string; source: 'demo' | 'csv'; importedAt: string; accepted: number; rejected: number; hash: string; errors: RejectedRow[]; ruleVersion: string }
export interface Snapshot { workspaceName: string; records: EvidenceRecord[]; batches: BatchSummary[]; dbVersion: number; ruleVersion: string; thresholdBps: number; pagination?: RetailPagination }
export type RetailReply = {ok:true;kind:'procurement';data:ProcurementView}|{ok:true;kind:'procurement_preview';data:ProcurementPreview}|{ok:true;kind:'procurement_receipt';data:ProcurementReceipt}| {ok:true;kind:'backup';data:BackupResult}| {ok:true;kind:'contribution_comparisons';data:ContributionComparison[]}| {ok:true;kind:'sync_cleanup';data:CleanupView}| {ok:true;kind:'inspections';data:InspectionView}|{ok:true;kind:'inspections_preview';data:InspectionPreview}|{ok:true;kind:'inspections_import';data:InspectionReceipt}| {ok:true;kind:'contribution_reports';data:ContributionReport[]}| {ok:true;kind:'ingest_issues';data:IngestionIssues}| {ok:true;kind:'ingest_fields';data:{arrays:string[];fields:string[];totalRecords:number}}| {ok:true;kind:'ingestion';data:IngestView}|{ok:true;kind:'sync_staging';data:{job:SyncJob;pages:Array<{page:number;receipt:string;encrypted:string}>}}| {ok:true;kind:'sync';data:SyncView}| {ok:true;kind:'supplement_preview';data:SupplementPreview}| {ok:true;kind:'catalog';data:CatalogView}| {ok:true;kind:'transactions_preview';data:TransactionPreview}|{ok:true;kind:'transactions';data:TransactionPage;notice?:string}|{ok:true;kind:'transactions_import';data:{accepted:number;duplicateCount:number;batchId:string}}| {ok:true;kind:'policy';data:PolicyView} | { ok: true; kind: 'signals_page'; data: SignalPage } | { ok: true; kind: 'checks'; data: ChecksView } | {ok:true;kind:'reviews';data:ReviewView[];selectedId?:string} | {ok:true;kind:'review_preview';data:ObservationPreview} | {ok:true;kind:'execution_batches';data:BatchView[];selectedId?:string} | {ok:true;kind:'compensations';data:CompensationView[];selectedId?:string} | { ok: true; kind: 'executions'; data: ExecutionView[]; selectedId?: string } | { ok: true; kind: 'approvals'; data: ApprovalView[]; selectedId?: string } | { ok: true; kind: 'export'; filename: string; mime: string; content: string } | { ok: true; kind: 'decisions'; data: DecisionDraft[]; selectedId?: string; history?: DecisionDraft[] } | { ok: true; kind: 'snapshot'; data: Snapshot; signals?: SignalSnapshot; notice?: string } | { ok: true; kind: 'preview'; data: Preview } | { ok: true; kind: 'investigations'; data: AnyInvestigation[]; created?: boolean } | { ok: true; kind: 'signals'; data: SignalSnapshot; notice?: string } | { ok: true; kind: 'signals_preview'; data: SignalPreview } | { ok: false; error: string };

const demoRows: RetailRow[] = [
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'TEA-500', product_name: '桂花乌龙冷萃茶', spec: '500ml × 6瓶', currency: 'CNY', list_price_minor: 10000, coupon_minor: 2000, full_reduction_minor: 1000, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 6000, sold_qty: 40, on_hand: 120, reserved: 10, inbound_qty: 60 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'COFFEE-12', product_name: '醇香挂耳咖啡', spec: '12袋礼盒', currency: 'CNY', list_price_minor: 10000, coupon_minor: 2000, full_reduction_minor: 0, subsidy_minor: 1000, subsidy_funder: 'platform', cost_minor: 6000, sold_qty: 30, on_hand: 80, reserved: 5, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'SNACK-300', product_name: '每日坚果分享装', spec: '300g', currency: 'CNY', list_price_minor: 5000, coupon_minor: 500, full_reduction_minor: 0, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: null, sold_qty: 20, on_hand: 45, reserved: 0, inbound_qty: 30 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'OAT-1000', product_name: '原味燕麦奶', spec: '1L × 3盒', currency: 'CNY', list_price_minor: 6000, coupon_minor: 1000, full_reduction_minor: 500, subsidy_minor: 500, subsidy_funder: 'unknown', cost_minor: 3500, sold_qty: 25, on_hand: 30, reserved: 4, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'HONEY-250', product_name: '山花蜂蜜', spec: '250g', currency: 'CNY', list_price_minor: 8000, coupon_minor: 500, full_reduction_minor: 0, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 4000, sold_qty: 15, on_hand: 50, reserved: 0, inbound_qty: 0 },
  { date: '2026-10-14', shop_id: 'demo-nanfeng', channel: '线上商城', sku_id: 'RICE-2', product_name: '五常鲜米', spec: '2kg', currency: 'CNY', list_price_minor: 4000, coupon_minor: 1000, full_reduction_minor: 500, subsidy_minor: 0, subsidy_funder: 'platform', cost_minor: 2800, sold_qty: 20, on_hand: 60, reserved: 10, inbound_qty: 100 },
];
function csvCell(value: unknown): string { const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value); return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text; }
/** Preserve explicit unknown JSON contexts while numeric nulls keep the CSV blank convention. */
export function snapshotCsv(row: object): string {
  const entries = Object.entries(row);
  return [entries.map(([key]) => key).join(','), entries.map(([key, value]) => csvCell(value === null && ['membership', 'bundle_components', 'gifts', 'offers'].includes(key) ? 'null' : value)).join(',')].join('\n');
}
export const DEMO_CSV = [FIELDS.join(','), ...demoRows.map(row => FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
const bundleRow: RetailRow = { ...demoRows[0]!, sku_id: 'PACK-NORMAL', product_name: '组合装合成验收', spec: '茶饮×2+咖啡×4', coupon_minor: 1000, sold_qty: 10, product_type: 'bundle', bundle_components: [
  { sku_id: 'TEA-UNIT', spec: '500ml', quantity: 2, unit_cost_minor: 1000 },
  { sku_id: 'COFFEE-UNIT', spec: '250ml', quantity: 4, unit_cost_minor: 1000 },
] };
export const BUNDLE_DEMO_CSV = [IMPORT_FIELDS.join(','), ...[
  bundleRow, { ...bundleRow, sku_id: 'PACK-CONFLICT', cost_minor: 1000 },
  { ...bundleRow, sku_id: 'PACK-MISSING', bundle_components: null },
].map(row => IMPORT_FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
const nestedBundle:RetailRow={...bundleRow,sku_id:'NESTED-PACK',spec:'茶饮子包×2+咖啡×2',bundle_components:[
 {sku_id:'TEA-PAIR',spec:'500ml×2',quantity:2,unit_cost_minor:2000,children:[{sku_id:'TEA-UNIT',spec:'500ml',quantity:2,unit_cost_minor:1000}]},
 {sku_id:'COFFEE-UNIT',spec:'250ml',quantity:2,unit_cost_minor:1000},
]};
export const NESTED_BUNDLE_DEMO_CSV=[IMPORT_FIELDS.join(','),IMPORT_FIELDS.map(key=>csvCell(nestedBundle[key])).join(',')].join('\r\n');
const giftRow: RetailRow = { ...demoRows[0]!, sku_id: 'GIFT-NORMAL', product_name: '买赠合成验收', spec: '主商品500ml', coupon_minor: 1000, sold_qty: 10, gift_policy: 'free_per_unit', gift_cost_basis: 'additional', gifts: [
  { sku_id: 'GIFT-SAMPLE', spec: '30ml', quantity: 1, unit_cost_minor: 0 },
] };
export const GIFT_DEMO_CSV = [IMPORT_FIELDS.join(','), ...[
  giftRow, { ...giftRow, sku_id: 'GIFT-WARNING', gifts: [{ ...giftRow.gifts![0]!, unit_cost_minor: 1500 }] },
  { ...giftRow, sku_id: 'GIFT-MISSING', gifts: [{ ...giftRow.gifts![0]!, unit_cost_minor: null }] },
].map(row => IMPORT_FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
const memberRow: RetailRow = { ...demoRows[0]!, sku_id: 'MEMBER-NORMAL', product_name: '会员价合成验收', spec: '500ml', coupon_minor: 0, full_reduction_minor: 0, sold_qty: 10,
  membership: { status: 'member', segment_id: 'gold', price_minor: 8000, valid_from: '2026-10-01', valid_to: '2026-11-01', discount_policy: 'exclusive' },
};
export const MEMBER_DEMO_CSV = [IMPORT_FIELDS.join(','), ...[
  memberRow, { ...memberRow, sku_id: 'MEMBER-WARNING', coupon_minor: 500, membership: { ...memberRow.membership!, price_minor: 6500, discount_policy: 'stackable' as const } },
  { ...memberRow, sku_id: 'MEMBER-MISSING', membership: { ...memberRow.membership!, status: 'unknown' as const } },
].map(row => IMPORT_FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
const offerRow: RetailRow = { ...demoRows[0]!, sku_id: 'OFFER-NORMAL', product_name: '可售报价合成验收', coupon_minor: 1000, sold_qty: 10 };
const offer = (sku: string, id: string, price: number, available: boolean | null) => ({ offer_id: id, shop_id: offerRow.shop_id, channel: offerRow.channel, sku_id: sku, spec: offerRow.spec, currency: 'CNY' as const, observed_on: offerRow.date, audience: 'public' as const, price_minor: price, available });
export const OFFER_DEMO_CSV = [IMPORT_FIELDS.join(','), ...[
  { ...offerRow, offers: [offer('OFFER-NORMAL', 'public-a', 1000, true)] },
  { ...offerRow, sku_id: 'OFFER-FILTERED', offers: [offer('OFFER-FILTERED', 'out-of-stock', 1000, false), offer('OFFER-FILTERED', 'available-b', 3000, true)] },
  { ...offerRow, sku_id: 'OFFER-UNKNOWN', offers: [offer('OFFER-UNKNOWN', 'unknown-stock', 1000, null)] },
].map(row => IMPORT_FIELDS.map(key => csvCell(row[key])).join(','))].join('\r\n');
export function exportCsv(records: EvidenceRecord[]): string {
  const safe = (value: unknown) => { const text = String(value ?? ''); return csvCell(/^[=+\-@\t\r]/.test(text) ? "'" + text : text); };
  return '\uFEFF' + [['店铺', '渠道', '日期', 'SKU', '商品', '规格', '状态', '商家收入分每件', '毛利分每件', '毛利率基点', '证据ID', '快照SHA256', '规则版本'], ...records.map(record => [record.row.shop_id, record.row.channel, record.row.date, record.row.sku_id, record.row.product_name, record.row.spec, record.status, record.calculation.revenueMinor, record.calculation.profitMinor, record.calculation.marginBps, record.id, record.snapshotHash, record.ruleVersion])].map(row => row.map(safe).join(',')).join('\r\n');
}
