import { calculate } from './operations';
import type { EvidenceRecord } from './operations';
import type { Scenario, Trace } from './investigations';

export const MARGIN_GRAIN = { money: 'CNY minor units (分)', perSalesUnit: ['revenueMinor','profitMinor'], snapshotTotals: ['totalRevenueMinor','totalProfitMinor'], totalQuantityField: 'soldQty', marginBps: 'profitMinor / revenueMinor * 10000; rounded', salesUnit: 'SKU规格的一件，不等于单瓶' } as const;
export interface MarginFact { key:string; label:string; value:number|null; unit:'CNY_minor'|'bps'|'sales_unit'; grain:'per_sales_unit'|'snapshot_total'|'rule'; evidenceIds:string[] }
export interface MarginNumericAudit { version:'margin-facts-v1'; calculationFieldsComplete:boolean; evidencePartial:true; limitations:string[]; facts:MarginFact[] }
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('毛利工具证据结构异常，数值核验拒绝');return v as Record<string,unknown>;};
function equal(a:unknown,b:unknown):boolean {
 if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>equal(a[i],v));
 if(b!==null&&typeof b==='object'){if(a===null||typeof a!=='object'||Array.isArray(a))return false;const x=a as Record<string,unknown>;const y=b as Record<string,unknown>;return Object.keys(x).length===Object.keys(y).length&&Object.keys(y).every(k=>equal(x[k],y[k]));}
 return a===b;
}
/** Reject contradictory tool values before a Reviewer can grant any analysis verdict. */
export function auditMarginNumbers(record:EvidenceRecord,scenarios:Scenario[],trace:Trace[]):MarginNumericAudit {
 const evidence=(tool:string)=>{const events=trace.filter(t=>t.stage==='investigate'&&t.tool===tool);if(events.length!==1||events[0]!.evidenceId!==`${record.id}:${tool}`)throw new Error('毛利证据引用缺失、重复或范围错误，数值核验拒绝');return events[0]!;};
 const health=evidence('retail_get_data_health');const context=evidence('retail_get_sku_context');const promotions=evidence('retail_get_promotions');const simulation=evidence('retail_simulate_actions');
 const h=object(health.data),c=object(context.data),p=object(promotions.data);const r=record.row;
 const expected=calculate(r,record.calculation.issues.includes('同店铺同渠道 SKU 出现多种规格，须人工核对映射'));
 if(!equal(record.calculation,expected)||!equal(c.calculation,expected)||!equal(p.calculation,expected))throw new Error('毛利单件、合计或比例与冻结快照计算不一致，报告被拒绝');
 if(!equal(c.calculationGrain,MARGIN_GRAIN)||!equal(p.calculationGrain,MARGIN_GRAIN))throw new Error('毛利金额单位或计算粒度不一致，报告被拒绝');
 if(c.soldQty!==r.sold_qty||c.costMinor!==r.cost_minor||c.sku!==r.sku_id||c.spec!==r.spec||c.shop!==r.shop_id||c.channel!==r.channel||c.date!==r.date)throw new Error('毛利数量、成本或商品范围不一致，报告被拒绝');
 if(p.priceMinor!==r.list_price_minor||p.couponMinor!==r.coupon_minor||p.fullReductionMinor!==r.full_reduction_minor||p.subsidyMinor!==r.subsidy_minor||p.subsidyFunder!==r.subsidy_funder)throw new Error('毛利优惠字段与冻结快照不一致，报告被拒绝');
 const threshold=object(h.marginThreshold);
 if(h.source!==record.source||h.observedAt!==r.date||h.importedAt!==record.importedAt||h.hash!==record.snapshotHash||h.rule!==record.ruleVersion||threshold.bps!==record.thresholdBps||threshold.origin!=='versioned_rule'||h.partial!==true||typeof h.limitation!=='string'||!equal(h.issues,expected.issues))throw new Error('毛利规则阈值、来源或质量证据不一致，报告被拒绝');
 if(!equal(simulation.data,scenarios))throw new Error('毛利条件方案与代码测算不一致，报告被拒绝');
 const proposed=scenarios.find(s=>s.kind==='reduce_coupon');if(!proposed)throw new Error('缺少毛利条件测算');
 const facts:MarginFact[]=[];
 const add=(key:string,label:string,value:number|null,unit:MarginFact['unit'],grain:MarginFact['grain'],events:Trace[])=>{
  if(value!==null&&!Number.isSafeInteger(value))throw new Error('毛利数值超出整数精度，报告被拒绝');facts.push({key,label,value,unit,grain,evidenceIds:events.map(e=>e.evidenceId)});
 };
 add('unitRevenue','促销后单件商品收入',expected.revenueMinor,'CNY_minor','per_sales_unit',[promotions]);
 add('unitCost','单件商品成本',r.cost_minor,'CNY_minor','per_sales_unit',[context]);
 add('unitProfit','单件商品毛利',expected.profitMinor,'CNY_minor','per_sales_unit',[promotions]);
 add('margin','商品毛利率',expected.marginBps,'bps','per_sales_unit',[promotions]);
 add('quantity','净成交件数',r.sold_qty,'sales_unit','snapshot_total',[context]);
 add('totalRevenue','促销后合计商品收入',expected.totalRevenueMinor,'CNY_minor','snapshot_total',[context]);
 add('totalProfit','合计商品毛利',expected.totalProfitMinor,'CNY_minor','snapshot_total',[context]);
 add('currentCoupon','原商家券',r.coupon_minor,'CNY_minor','per_sales_unit',[promotions]);
 add('proposedCoupon','方案商家券',proposed.couponMinor,'CNY_minor','per_sales_unit',[simulation]);
 add('couponReduction','商家券减少额',proposed.couponMinor===null?null:r.coupon_minor-proposed.couponMinor,'CNY_minor','per_sales_unit',[promotions,simulation]);
 add('proposedRevenue','方案单件商品收入',proposed.revenueMinor,'CNY_minor','per_sales_unit',[simulation]);
 add('proposedProfit','方案单件商品毛利',proposed.profitMinor,'CNY_minor','per_sales_unit',[simulation]);
 add('proposedMargin','方案商品毛利率',proposed.marginBps,'bps','per_sales_unit',[simulation]);
 add('threshold','当前规则毛利阈值',record.thresholdBps,'bps','rule',[health]);
 return {version:'margin-facts-v1',calculationFieldsComplete:!expected.issues.length&&facts.every(f=>f.value!==null),evidencePartial:true,limitations:[String(h.limitation),'计算字段齐全不等于经营证据完整；不证明需求弹性、优惠因果或实际收益'],facts};
}
export function numericObservations(audit:MarginNumericAudit):Array<{text:string;evidenceIds:string[]}> {
 const groups=[['unitRevenue','unitCost','unitProfit','margin'],['quantity','totalRevenue','totalProfit'],['currentCoupon','proposedCoupon','couponReduction'],['proposedRevenue','proposedProfit','proposedMargin','threshold']];
 const observations=groups.map(keys=>{const facts=keys.map(k=>audit.facts.find(f=>f.key===k)!);return {text:facts.map(f=>`${f.label}：${f.value===null?'待补证':f.unit==='CNY_minor'?`¥${(f.value/100).toFixed(2)}`:f.unit==='bps'?`${(f.value/100).toFixed(2)}%`:`${f.value} 件（按SKU规格）`}`).join('；')+'。'+(keys.includes('threshold')?'阈值来自当前版本规则，方案仅为条件测算，不预测销量或实际收益。':''),evidenceIds:[...new Set(facts.flatMap(f=>f.evidenceIds))]};});
 const health=audit.facts.find(f=>f.key==='threshold')!;observations.push({text:'数据为部分冻结快照：'+audit.limitations.join('；')+'。',evidenceIds:health.evidenceIds});return observations;
}
