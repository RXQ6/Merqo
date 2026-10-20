import {z} from 'zod';
import {parseCsv} from './csv';
import {TransactionQuerySchema,transactionEntity,type TransactionEvent} from './transactions';
export const COST_CATEGORIES=['goods','platform_fee','shipping','return_shipping','other'] as const;
export const COST_LABELS:Record<typeof COST_CATEGORIES[number],string>={goods:'商品净成本',platform_fee:'平台净费用',shipping:'发货净运费',return_shipping:'退货净运费',other:'其他净费用'};
export const COST_FIELDS=['source_id','shop_id','channel','order_id','line_id','category','amount_minor','currency','observed_at'] as const;
export const COST_TEMPLATE=COST_FIELDS.join(',')+'\n';
export const ContributionInputSchema=z.strictObject({label:z.string().trim().min(1).max(100),query:TransactionQuerySchema.refine(q=>q.basis==='order','费用核对须按原订单归属查询'),csv:z.string().min(1).max(8000000)});
export const ContributionPublicSchemas=[ContributionInputSchema.safeExtend({op:z.literal('contribution_analyze')}),z.strictObject({op:z.literal('contribution_reports')})] as const;
export type ContributionInput=z.infer<typeof ContributionInputSchema>;
const id=z.string().trim().min(1).max(128);
export const CostRowSchema=z.strictObject({source_id:id,shop_id:id,channel:z.string().trim().min(1).max(200),order_id:id,line_id:id,category:z.enum(COST_CATEGORIES),amount_minor:z.number().int().min(0).max(100000000),currency:z.literal('CNY'),observed_at:z.string().datetime({offset:true})});
export type CostRow=z.infer<typeof CostRowSchema>;
export interface ContributionLine {sourceId:string;shopId:string;channel:string;orderId:string;lineId:string;sku:string;spec:string;paidMinor:number;refundedMinor:number;retainedMinor:number;costs:Record<typeof COST_CATEGORIES[number],number|null>;costMinor:number|null;contributionMinor:number|null;missing:string[];}
export interface ContributionReport {id:string;at:number;label:string;source:'demo'|'csv';query:ContributionInput['query'];inputHash:string;ledgerHash:string;authority:'operator_declared';lines:ContributionLine[];totalLines:number;readyLines:number;needsEvidenceLines:number;duplicates:number;totals:{paidMinor:number;refundedMinor:number;retainedMinor:number;costMinor:number|null;contributionMinor:number|null};}
export function parseCosts(csv:string,now=Date.now()):{rows:CostRow[];duplicates:number}{
 const table=parseCsv(csv),headers=table.shift()??[];if(headers.length!==COST_FIELDS.length||new Set(headers).size!==headers.length||COST_FIELDS.some(f=>!headers.includes(f)))throw Error('费用文件列名缺失、重复或不支持，请使用模板');if(!table.length||table.length>10000)throw Error('费用文件须包含1至10,000行');
 const rows:CostRow[]=[],seen=new Map<string,string>();let duplicates=0;
 for(const [index,cells]of table.entries()){
  if(cells.length!==headers.length)throw Error(`费用文件第${index+2}行列数不符`);const raw=Object.fromEntries(headers.map((h,i)=>[h,h==='amount_minor'?/^\d+$/.test(cells[i]!.trim())?Number(cells[i]):NaN:cells[i]!.trim()])),p=CostRowSchema.safeParse(raw);if(!p.success)throw Error(`费用文件第${index+2}行金额、币种、时间或标识无效`);if(Date.parse(p.data.observed_at)>now+300000)throw Error(`费用文件第${index+2}行观测时间超前`);const row={...p.data,observed_at:new Date(p.data.observed_at).toISOString()},key=JSON.stringify([transactionEntity(row),row.category]),json=JSON.stringify(row),old=seen.get(key);if(old&&old!==json)throw Error(`费用文件第${index+2}行同一订单行费用类别冲突`);if(old){duplicates++;continue;}seen.set(key,json);rows.push(row);
 }
 return{rows,duplicates};
}
export function calculateContribution(events:TransactionEvent[],costs:CostRow[]):Omit<ContributionReport,'id'|'at'|'label'|'source'|'query'|'inputHash'|'ledgerHash'|'authority'|'duplicates'>{
 const groups=new Map<string,TransactionEvent[]>();for(const e of events){const key=transactionEntity(e),list=groups.get(key)??[];list.push(e);groups.set(key,list);}
 const mapped=new Map<string,Map<CostRow['category'],CostRow>>();for(const row of costs){const key=transactionEntity(row);if(!groups.has(key))throw Error('费用文件存在当前交易来源、原订单窗口或店铺渠道范围之外的订单行');const group=mapped.get(key)??new Map();group.set(row.category,row);mapped.set(key,group);}
 const lines:ContributionLine[]=[];let readyLines=0,paidMinor=0,refundedMinor=0,costMinor=0;
 for(const [key,group]of groups){const first=group[0]!,latest=group.reduce((t,e)=>Math.max(t,Date.parse(e.event_at)),0),provided=mapped.get(key),missing:string[]=[];const values=Object.fromEntries(COST_CATEGORIES.map(category=>{const row=provided?.get(category);if(!row||Date.parse(row.observed_at)<latest){missing.push(category);return[category,null];}return[category,row.amount_minor];})) as ContributionLine['costs'];const paid=group.filter(e=>e.kind==='paid').reduce((s,e)=>s+e.amount_minor,0),refunded=group.filter(e=>e.kind==='refunded').reduce((s,e)=>s+e.amount_minor,0),net=missing.length?null:Object.values(values).reduce<number>((s,n)=>s+(n??0),0);paidMinor+=paid;refundedMinor+=refunded;if(net!==null){readyLines++;costMinor+=net;}if(lines.length<200)lines.push({sourceId:first.source_id,shopId:first.shop_id,channel:first.channel,orderId:first.order_id,lineId:first.line_id,sku:first.sku_id,spec:first.spec,paidMinor:paid,refundedMinor:refunded,retainedMinor:paid-refunded,costs:values,costMinor:net,contributionMinor:net===null?null:paid-refunded-net,missing});
 }
 const incomplete=readyLines!==groups.size;return{lines,totalLines:groups.size,readyLines,needsEvidenceLines:groups.size-readyLines,totals:{paidMinor,refundedMinor,retainedMinor:paidMinor-refundedMinor,costMinor:incomplete?null:costMinor,contributionMinor:incomplete?null:paidMinor-refundedMinor-costMinor}};
}
