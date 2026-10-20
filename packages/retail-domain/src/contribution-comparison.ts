import {z} from 'zod';
import {COST_CATEGORIES,type ContributionReport,type CostRow} from './contribution';
export const ContributionComparisonSchemas=[z.strictObject({op:z.literal('contribution_compare'),baselineId:z.string().uuid(),currentId:z.string().uuid()}),z.strictObject({op:z.literal('contribution_comparisons')})] as const;
export interface ContributionComparison {id:string;at:number;baselineId:string;currentId:string;baselineInputHash:string;currentInputHash:string;status:'compared'|'incomparable'|'needs_evidence';finding:'paid_up_contribution_down'|'other_change'|null;reasons:string[];scopeMix:'same'|'changed'|'unknown';paidDelta:number|null;contributionDelta:number|null;effects:Record<string,number>|null;}
export interface FrozenContribution {report:ContributionReport;normalizedCosts:CostRow[];}
const duration=(r:ContributionReport)=>(Date.parse(r.query.endDate)-Date.parse(r.query.startDate))/86400000+1;
const mix=(r:ContributionReport)=>r.lines.length===r.totalLines?JSON.stringify([...new Set(r.lines.map(l=>JSON.stringify([l.sourceId,l.shopId,l.channel,l.sku,l.spec])))].sort()):null;
export function compareContributions(base:FrozenContribution,current:FrozenContribution,now=Date.now()):ContributionComparison {
 const b=base.report,c=current.report,reasons:string[]=[],bm=mix(b),cm=mix(c),scopeMix=bm===null||cm===null?'unknown':bm===cm?'same':'changed';
 const result:ContributionComparison={id:crypto.randomUUID(),at:now,baselineId:b.id,currentId:c.id,baselineInputHash:b.inputHash,currentInputHash:c.inputHash,status:'incomparable',finding:null,reasons,scopeMix,paidDelta:null,contributionDelta:null,effects:null};
 if(b.id===c.id)reasons.push('基期和观察期不能选择同一报告');
 if(b.source!==c.source||b.query.shop!==c.query.shop||b.query.channel!==c.query.channel)reasons.push('两份报告的来源、店铺或渠道筛选不同');
 if(b.query.basis!=='order'||c.query.basis!=='order')reasons.push('须使用原订单归属口径');
 if(duration(b)!==duration(c))reasons.push('两个原订单窗口天数不同');
 if(c.query.startDate<=b.query.endDate)reasons.push('观察窗口须晚于基期且不能重叠');
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));if(c.query.endDate>=today||b.query.endDate>=today)reasons.push('不能比较尚未结束的业务日期');
 if(reasons.length)return result;
 if(b.totals.contributionMinor===null||c.totals.contributionMinor===null||b.needsEvidenceLines||c.needsEvidenceLines){result.status='needs_evidence';reasons.push('至少一份报告的费用缺失或观测过早，不能补零比较');return result;}
 const effects:Record<string,number>={paid:c.totals.paidMinor-b.totals.paidMinor,refund:-(c.totals.refundedMinor-b.totals.refundedMinor)};
 for(const category of COST_CATEGORIES){const sum=(v:FrozenContribution)=>v.normalizedCosts.filter(r=>r.category===category).reduce((n,r)=>n+r.amount_minor,0);effects[category]=-(sum(current)-sum(base));}
 const delta=c.totals.contributionMinor-b.totals.contributionMinor;if(Object.values(effects).reduce((n,v)=>n+v,0)!==delta)throw Error('费用快照与冻结报告不一致，不能生成比较');
 result.status='compared';result.paidDelta=effects.paid!;result.contributionDelta=delta;result.effects=effects;result.finding=result.paidDelta>0&&delta<0?'paid_up_contribution_down':'other_change';if(scopeMix==='changed')reasons.push('来源/店铺/渠道/SKU规格构成发生变化，整体变化不能直接归因于单项经营动作');if(scopeMix==='unknown')reasons.push('明细截断，未完整核对实体构成');return result;
}
