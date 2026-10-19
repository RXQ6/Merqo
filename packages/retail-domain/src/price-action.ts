import { calculate, marginCost } from './operations';
import type { EvidenceRecord } from './operations';
import type { Scenario } from './investigations';

export type MarginAction = 'reduce_coupon' | 'set_price';
export const PRICE_POLICY = 'merqo-price-v1';
/** Integer cents; target the minimum price meeting the frozen margin floor, keeping discounts fixed. */
export function simulatePrice(record: EvidenceRecord): Scenario[] {
  const r=record.row;const cost=marginCost(r);
  const denominator=10000-record.thresholdBps;
  const targetRevenue=cost===null||!Number.isSafeInteger(denominator)||denominator<=0?null:(BigInt(cost)*10000n+BigInt(denominator)-1n)/BigInt(denominator);
  const target=targetRevenue===null?null:targetRevenue+BigInt(r.coupon_minor)+BigInt(r.full_reduction_minor)-(r.subsidy_funder==='platform'?BigInt(r.subsidy_minor):0n);
  const price=target!==null&&target>0n&&target<=100000000n?Number(target):null;
  return (['observe','set_price'] as const).map(kind=>{
    const nextPrice=kind==='observe'?r.list_price_minor:price;
    const calc=nextPrice===null?null:calculate({...r,list_price_minor:nextPrice},record.calculation.issues.includes('同店铺同渠道 SKU 出现多种规格，须人工核对映射'),record.policy?.settings);
    const constraints=[...(calc?.issues??['缺少有效价格或成本'])];
    if(kind==='set_price'){
      if(r.membership!==undefined)constraints.push('会员价需独立价格策略，不能直接改普通售价');
      if(nextPrice===r.list_price_minor)constraints.push('目标价格与原价相同，无需执行');
      if(nextPrice!==null&&(BigInt(nextPrice)*10000n>BigInt(r.list_price_minor)*BigInt(10000+(record.policy?.settings.priceChangeLimitBps??2000))||BigInt(nextPrice)*10000n<BigInt(r.list_price_minor)*BigInt(10000-(record.policy?.settings.priceChangeLimitBps??2000))))constraints.push(`价格变动超过原价${(record.policy?.settings.priceChangeLimitBps??2000)/100}%的本地模拟限制`);
    }
    if(calc?.marginBps===null||!calc||calc.marginBps<record.thresholdBps)constraints.push('未达到冻结规则毛利阈值');
    return {kind,title:kind==='observe'?'不调整，补证并继续观察':'调整 SKU 标价（条件测算）',rationale:'',couponMinor:r.coupon_minor,revenueMinor:calc?.revenueMinor??null,profitMinor:calc?.profitMinor??null,marginBps:calc?.marginBps??null,values:{priceMinor:nextPrice,previousPriceMinor:r.list_price_minor},passed:!constraints.length,constraints,
      assumptions:['按最小货币单位向上取整计算满足毛利下限的标价','商家券、满减、补贴承担方、成本、赠品和规格保持不变','仅改本地模拟标价，不根据参考报价改价，不处理会员价格','未测算价格弹性、销量或真实经营收益',`规则 ${PRICE_POLICY}；同一商品的券与价格动作共享模拟目标版本`]};
  });
}
