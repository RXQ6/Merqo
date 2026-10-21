import {z} from 'zod';
import {allocateOrders,distributeMinor} from './order-allocation';
const id=z.string().trim().min(1).max(128),minor=z.number().int().min(0).max(100_000_000),time=z.string().datetime({offset:true});
export const PromotionInputSchema=z.strictObject({
 orderId:id,currency:z.literal('CNY'),orderedAt:time,
 membership:z.strictObject({status:z.enum(['member','non_member','unknown']),segmentId:id.nullable()}),
 lines:z.array(z.strictObject({lineId:id,sku:id,spec:id,grossMinor:minor,goodsCostMinor:minor.nullable()})).min(1).max(200),
 rules:z.array(z.strictObject({id,name:id,kind:z.enum(['full_reduction','coupon','member']),startsAt:time,endsAt:time,eligibleLineIds:z.array(id).min(1).max(200),membership:z.enum(['any','member','segment']),segmentId:id.nullable(),thresholdBasis:z.enum(['original_gross','remaining_after_prior']),minSpendMinor:minor.nullable(),discountMinor:minor.positive().nullable(),stacksWith:z.array(id).max(20).nullable()})).max(20),
 selectedRuleIds:z.array(id).max(20),
 gifts:z.array(z.strictObject({id,sku:id,quantity:z.number().int().positive().max(10000),beneficiaryLineIds:z.array(id).min(1).max(200),costBasis:z.enum(['additional','included_in_goods','unknown']),totalCostMinor:minor.nullable()})).max(100),
}).superRefine((v,c)=>{
 for(const values of [v.lines.map(l=>l.lineId),v.rules.map(r=>r.id),v.selectedRuleIds,v.gifts.map(g=>g.id)])if(new Set(values).size!==values.length)c.addIssue({code:'custom',message:'订单行、活动、选择或赠品标识重复'});
 const lines=new Set(v.lines.map(l=>l.lineId)),rules=new Set(v.rules.map(r=>r.id));
 for(const r of v.rules){if(Date.parse(r.startsAt)>=Date.parse(r.endsAt))c.addIssue({code:'custom',message:'活动有效区间必须起点早于终点'});if(r.kind==='member'&&r.membership==='any')c.addIssue({code:'custom',message:'会员优惠须明确会员或分群资格'});if(r.membership==='segment'&&!r.segmentId)c.addIssue({code:'custom',message:'分群活动须明确会员分群'});for(const list of [r.eligibleLineIds,r.stacksWith??[]])if(new Set(list).size!==list.length)c.addIssue({code:'custom',message:'活动参与行或叠加标识重复'});if(r.eligibleLineIds.some(id=>!lines.has(id))||r.stacksWith?.some(id=>!rules.has(id)||id===r.id))c.addIssue({code:'custom',message:'活动引用不存在的订单行或活动，或引用自身叠加'});}
 if(v.selectedRuleIds.some(id=>!rules.has(id)))c.addIssue({code:'custom',message:'选择了不存在的活动'});
 for(const g of v.gifts)if(new Set(g.beneficiaryLineIds).size!==g.beneficiaryLineIds.length||g.beneficiaryLineIds.some(id=>!lines.has(id)))c.addIssue({code:'custom',message:'赠品归属行缺失或重复'});
});
export type PromotionInput=z.infer<typeof PromotionInputSchema>;
type Status='eligible'|'ineligible'|'needs_evidence';
export interface PromotionPreview {authority:'operator_declared';status:Status;reasons:string[];checks:Array<{id:string;name:string;status:Status;reasons:string[];thresholdMinor:number|null}>;lines:Array<{lineId:string;grossMinor:number;discountMinor:number;netSalesMinor:number;goodsCostMinor:number|null;giftCostMinor:number|null;contributionMinor:number|null}>|null;totals:{grossMinor:number;discountMinor:number;netSalesMinor:number;goodsCostMinor:number|null;giftCostMinor:number|null;contributionMinor:number|null}|null;}
function giftAllocation(rows:Array<{id:string;weight:number}>,total:number){if(!rows.some(r=>r.weight>0))return total===0?new Map(rows.map(r=>[r.id,0])):null;return distributeMinor(rows.map(r=>({line_id:r.id,gross_minor:r.weight,eligible:true})),total);}
export function previewPromotion(input:unknown):PromotionPreview{
 const v=PromotionInputSchema.parse(input),reasons:string[]=[],checks:PromotionPreview['checks']=[],remaining=new Map(v.lines.map(l=>[l.lineId,l.grossMinor]));
 const selected=v.selectedRuleIds.map(id=>v.rules.find(r=>r.id===id)!);let stopped=false;
 for(const r of selected){let status:Status='eligible';const why:string[]=[];const fail=(s:Status,text:string)=>{if(status!=='ineligible')status=s;why.push(text);};
  if(Date.parse(v.orderedAt)<Date.parse(r.startsAt)||Date.parse(v.orderedAt)>=Date.parse(r.endsAt))fail('ineligible','下单时刻不在活动有效区间内');
  for(const other of selected.filter(o=>o.id!==r.id)){if(r.stacksWith===null||other.stacksWith===null)fail('needs_evidence','活动叠加关系未明确');else if(!r.stacksWith.includes(other.id)||!other.stacksWith.includes(r.id))fail('ineligible','所选活动未双向允许叠加');}
  if(r.membership!=='any'){if(v.membership.status==='unknown')fail('needs_evidence','缺少下单时会员资格');else if(v.membership.status!=='member')fail('ineligible','下单时不是会员');else if(r.membership==='segment'){if(!v.membership.segmentId)fail('needs_evidence','缺少下单时会员分群');else if(v.membership.segmentId!==r.segmentId)fail('ineligible','会员分群不适用');}}
  const threshold=stopped&&r.thresholdBasis==='remaining_after_prior'?null:v.lines.filter(l=>r.eligibleLineIds.includes(l.lineId)).reduce((n,l)=>n+(r.thresholdBasis==='original_gross'?l.grossMinor:remaining.get(l.lineId)!),0);
  if(threshold===null)fail('needs_evidence','前序活动未通过，不能推算后续折后门槛');else if(r.minSpendMinor===null)fail('needs_evidence','活动门槛缺失');else if(threshold<r.minSpendMinor)fail('ineligible','参与行金额未达到活动门槛');
  if(r.discountMinor===null)fail('needs_evidence','活动优惠金额缺失');
  const available=r.eligibleLineIds.reduce((n,id)=>n+remaining.get(id)!,0);if(r.discountMinor!==null&&r.discountMinor>available)fail('ineligible','优惠超过参与行剩余金额');
  checks.push({id:r.id,name:r.name,status,reasons:why,thresholdMinor:threshold});
  if(status==='eligible'&&!stopped){const allocated=allocateOrders(v.lines.map(l=>({order_id:v.orderId,line_id:l.lineId,gross_minor:remaining.get(l.lineId)!,eligible:r.eligibleLineIds.includes(l.lineId),order_discount_minor:r.discountMinor!,order_subsidy_minor:0})));for(const line of allocated)remaining.set(line.line_id,line.settlement_minor);}else stopped=true;
 }
 const result:PromotionPreview={authority:'operator_declared',status:checks.some(c=>c.status==='ineligible')?'ineligible':checks.some(c=>c.status==='needs_evidence')?'needs_evidence':'eligible',reasons,checks,lines:null,totals:null};
 if(stopped){reasons.push('所选活动存在不适用或待补证项，未生成整单金额结果');return result;}
 const giftCosts=new Map<string,number|null>(v.lines.map(l=>[l.lineId,0]));
 for(const g of v.gifts){if(g.costBasis==='included_in_goods')continue;const allocation=g.costBasis==='additional'&&g.totalCostMinor!==null?giftAllocation(g.beneficiaryLineIds.map(id=>({id,weight:remaining.get(id)!})),g.totalCostMinor):null;
  if(!allocation){reasons.push(`赠品 ${g.id} 缺少成本口径/金额，或归属行净收入为零无法分摊`);for(const id of g.beneficiaryLineIds)giftCosts.set(id,null);}else for(const [id,cost]of allocation)if(giftCosts.get(id)!==null)giftCosts.set(id,giftCosts.get(id)!+cost);
 }
 const lines=v.lines.map(l=>{const net=remaining.get(l.lineId)!,gift=giftCosts.get(l.lineId)!;if(l.goodsCostMinor===null)reasons.push(`订单行 ${l.lineId} 缺少商品成本`);return{lineId:l.lineId,grossMinor:l.grossMinor,discountMinor:l.grossMinor-net,netSalesMinor:net,goodsCostMinor:l.goodsCostMinor,giftCostMinor:gift,contributionMinor:l.goodsCostMinor===null||gift===null?null:net-l.goodsCostMinor-gift};});
 const sum=(key:'grossMinor'|'discountMinor'|'netSalesMinor')=>lines.reduce((n,l)=>n+l[key],0),complete=lines.every(l=>l.contributionMinor!==null);
 result.lines=lines;result.totals={grossMinor:sum('grossMinor'),discountMinor:sum('discountMinor'),netSalesMinor:sum('netSalesMinor'),goodsCostMinor:lines.some(l=>l.goodsCostMinor===null)?null:lines.reduce((n,l)=>n+l.goodsCostMinor!,0),giftCostMinor:lines.some(l=>l.giftCostMinor===null)?null:lines.reduce((n,l)=>n+l.giftCostMinor!,0),contributionMinor:complete?lines.reduce((n,l)=>n+l.contributionMinor!,0):null};if(!complete)result.status='needs_evidence';return result;
}
export const PROMOTION_DEMO:PromotionInput={orderId:'PROMO-O1',currency:'CNY',orderedAt:'2026-10-14T10:00:00+08:00',membership:{status:'member',segmentId:'VIP'},lines:[{lineId:'A',sku:'SKU-A',spec:'单件',grossMinor:10000,goodsCostMinor:6000},{lineId:'B',sku:'SKU-B',spec:'单件',grossMinor:5000,goodsCostMinor:3000}],rules:[{id:'COUPON',name:'商家券',kind:'coupon',startsAt:'2026-10-01T00:00:00+08:00',endsAt:'2026-11-01T00:00:00+08:00',eligibleLineIds:['A','B'],membership:'member',segmentId:null,thresholdBasis:'original_gross',minSpendMinor:10000,discountMinor:1000,stacksWith:['REDUCTION']},{id:'REDUCTION',name:'折后满减',kind:'full_reduction',startsAt:'2026-10-01T00:00:00+08:00',endsAt:'2026-11-01T00:00:00+08:00',eligibleLineIds:['A','B'],membership:'any',segmentId:null,thresholdBasis:'remaining_after_prior',minSpendMinor:12000,discountMinor:1000,stacksWith:['COUPON']}],selectedRuleIds:['COUPON','REDUCTION'],gifts:[{id:'G1',sku:'GIFT-SKU',quantity:1,beneficiaryLineIds:['A','B'],costBasis:'additional',totalCostMinor:500}]};
