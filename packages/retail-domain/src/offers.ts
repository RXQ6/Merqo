import { z } from 'zod';
import type { RetailRow } from './operations';

/** Explicit public offer snapshot; never a transaction price or a live availability guarantee. */
export const OfferSchema = z.strictObject({
  offer_id: z.string().trim().min(1).max(100),
  shop_id: z.string().trim().min(1).max(100),
  channel: z.string().trim().min(1).max(80),
  sku_id: z.string().trim().min(1).max(100),
  spec: z.string().trim().min(1).max(160),
  currency: z.literal('CNY'),
  observed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }, '日期不存在'),
  audience: z.enum(['public', 'member', 'unknown']),
  price_minor: z.number().int().min(1).max(100_000_000),
  available: z.boolean().nullable(),
});
export type Offer = z.infer<typeof OfferSchema>;
export function offerScope(row: RetailRow): string | null { return row.offers === undefined ? null : 'public_exact_scope_business_date_v1'; }
export interface OfferSelection {
  version: 'retail-offers-v1';
  status: 'not_provided' | 'selected' | 'needs_evidence';
  selectedOfferId: string | null;
  selectedPriceMinor: number | null;
  eligibleOfferIds: string[];
  excluded: { offerId: string; reason: string }[];
  issues: string[];
  limitation: string;
}

export function selectOffers(row: RetailRow): OfferSelection {
  const result: OfferSelection = { version: 'retail-offers-v1', status: 'not_provided', selectedOfferId: null, selectedPriceMinor: null, eligibleOfferIds: [], excluded: [], issues: [],
    limitation: '仅比较同店铺、渠道、SKU、规格、CNY和业务日期的公开标价；未含运费或逐单优惠，不证明实时可售，不替换成交收入，不授权改价',
  };
  if (row.offers === undefined) return result;
  const candidates: Offer[] = [];
  const seen = new Set<string>();
  for (const offer of row.offers ?? []) {
    if (seen.has(offer.offer_id)) result.issues.push('报价 ID 重复，须核对唯一来源');
    seen.add(offer.offer_id);
    const exclude = (reason: string) => result.excluded.push({ offerId: offer.offer_id, reason });
    if (offer.shop_id !== row.shop_id || offer.channel !== row.channel || offer.sku_id !== row.sku_id || offer.spec !== row.spec || offer.currency !== row.currency) {
      exclude('报价店铺、渠道、SKU、规格或币种不匹配'); continue;
    }
    if (offer.observed_on !== row.date) { exclude('报价业务日期不匹配，不能作为同日参考'); continue; }
    if (offer.available === false) { exclude('报价明确无货'); continue; }
    if (offer.audience === 'member') { exclude('会员专属报价不纳入公开报价比较'); continue; }
    if (offer.audience === 'unknown' || offer.available === null) { result.issues.push('同范围报价的可售状态或适用人群未知，不能确认最低可售价'); continue; }
    candidates.push(offer);
  }
  candidates.sort((a, b) => a.price_minor - b.price_minor || (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0));
  result.eligibleOfferIds = candidates.map(o => o.offer_id);
  if (!candidates.length) result.issues.push('缺少同范围、同业务日期的明确可售公开报价');
  result.issues = [...new Set(result.issues)];
  result.status = result.issues.length ? 'needs_evidence' : 'selected';
  if (result.status === 'selected') { result.selectedOfferId = candidates[0]!.offer_id; result.selectedPriceMinor = candidates[0]!.price_minor; }
  return result;
}
