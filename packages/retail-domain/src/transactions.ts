import {z} from 'zod';
import {parseCsv} from './csv';
import {SourceMetadataInputSchema} from './source-metadata';
import type {EvidenceProvenance} from './source-metadata';
const id=z.string().trim().min(1).max(128),text=z.string().trim().min(1).max(200);
const amount=z.number().int().min(0).max(100_000_000),time=z.string().datetime({offset:true});
export const TransactionEventSchema=z.strictObject({
 source_id:id,event_id:id,order_id:id,line_id:id,shop_id:id,channel:text,sku_id:id,spec:text,currency:z.literal('CNY'),
 kind:z.enum(['ordered','paid','shipped','refunded']),order_at:time,event_at:time,
 quantity:z.number().int().min(0).max(1_000_000),amount_minor:amount,allocated_discount_minor:amount,platform_subsidy_minor:amount,
}).superRefine((r,c)=>{
 if(Date.parse(r.event_at)<Date.parse(r.order_at))c.addIssue({code:'custom',message:'事件发生时间不能早于原订单时间'});
 if(r.kind==='ordered'&&Date.parse(r.event_at)!==Date.parse(r.order_at))c.addIssue({code:'custom',message:'下单事件时间必须等于原订单时间'});
 if(r.kind!=='refunded'&&r.quantity===0)c.addIssue({code:'custom',message:'下单、支付和发货数量须大于零'});
 if(r.kind==='refunded'&&r.quantity===0&&r.amount_minor===0)c.addIssue({code:'custom',message:'退款不能同时零件数零金额'});
 if(r.kind!=='paid'&&(r.allocated_discount_minor!==0||r.platform_subsidy_minor!==0))c.addIssue({code:'custom',message:'优惠和平台结算补贴只在支付事件填写'});
 if(r.kind==='shipped'&&r.amount_minor!==0)c.addIssue({code:'custom',message:'发货事件不重复记收入，金额必须为零'});
});
export type TransactionEvent=z.infer<typeof TransactionEventSchema>;
export const TRANSACTION_FIELDS=['source_id','event_id','order_id','line_id','shop_id','channel','sku_id','spec','currency','kind','order_at','event_at','quantity','amount_minor','allocated_discount_minor','platform_subsidy_minor'] as const satisfies ReadonlyArray<keyof TransactionEvent>;
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s;},'无效业务日期');
export const TransactionQuerySchema=z.strictObject({source:z.enum(['demo','csv']).default('csv'),startDate:date,endDate:date,basis:z.enum(['event','order']).default('event'),shop:z.string().max(128).default(''),channel:z.string().max(200).default(''),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(100).default(30)}).refine(q=>q.startDate<=q.endDate,{message:'开始日期不能晚于结束日期'});
export type TransactionQuery=z.infer<typeof TransactionQuerySchema>;
export const TransactionPreviewRequest=z.strictObject({op:z.literal('transactions_preview'),csv:z.string().min(1).max(32_000_000)});
export const TransactionImportRequest=z.strictObject({op:z.literal('transactions_import'),csv:z.string().min(1).max(32_000_000),previewHash:z.string().regex(/^[a-f0-9]{64}$/),sourceMetadata:SourceMetadataInputSchema.optional()});
export const TransactionPageRequest=TransactionQuerySchema.safeExtend({op:z.literal('transactions_page')});
export interface TransactionPreview{events:TransactionEvent[];total:number;errors:Array<{line:number;reason:string}>;duplicateCount:number;hash:string;canImport:boolean}
export interface TransactionPage{
 records:Array<{event:TransactionEvent;source:'demo'|'csv';batchId:string;importedAt:string;provenance?:EvidenceProvenance}>;
 total:number;offset:number;limit:number;basis:TransactionQuery['basis'];startInclusive:string;endExclusive:string;
 totals:{orderedQty:number;paidQty:number;shippedQty:number;refundedQty:number;paidMinor:number;refundedMinor:number;retainedMinor:number;netPaidQty:number};
 limitation:string;
}
export const transactionEntity=(e:TransactionEvent)=>JSON.stringify([e.source_id,e.shop_id,e.channel,e.order_id,e.line_id]);
export const transactionKey=(e:TransactionEvent)=>JSON.stringify([e.source_id,e.shop_id,e.channel,e.event_id]);
export function decodeTransactionCsv(csv:string):Omit<TransactionPreview,'hash'|'canImport'>{
 const rows=parseCsv(csv),headers=rows.shift()??[],errors:TransactionPreview['errors']=[],events:TransactionEvent[]=[];let duplicateCount=0;
 if(new Set(headers).size!==headers.length||TRANSACTION_FIELDS.some(f=>!headers.includes(f))||headers.some(h=>!TRANSACTION_FIELDS.includes(h as typeof TRANSACTION_FIELDS[number])))return{events,total:rows.length,errors:[{line:1,reason:'请使用交易事件模板，列名缺失、重复或不支持'}],duplicateCount};
 const seen=new Map<string,string>();
 for(const [i,cells]of rows.entries()){
  if(i>=100000)throw Error('单次交易导入最多100,000条事件');
  if(cells.length!==headers.length){errors.push({line:i+2,reason:'列数量与表头不符'});continue;}
  const raw=Object.fromEntries(TRANSACTION_FIELDS.map(f=>{const v=cells[headers.indexOf(f)]?.trim()??'';return[f,['quantity','amount_minor','allocated_discount_minor','platform_subsidy_minor'].includes(f)?/^\d+$/.test(v)?Number(v):NaN:v];}));
  const parsed=TransactionEventSchema.safeParse(raw);if(!parsed.success){errors.push({line:i+2,reason:parsed.error.issues.map(i=>i.message).join('；')});continue;}
  const key=transactionKey(parsed.data),value=JSON.stringify(parsed.data),old=seen.get(key);
  if(old){if(old===value)duplicateCount++;else errors.push({line:i+2,reason:'同一事件ID存在冲突内容'});continue;}
  seen.set(key,value);events.push(parsed.data);
 }
 if(!rows.length)errors.push({line:1,reason:'没有事件数据'});
 if(new Set(events.map(e=>e.source_id)).size>1)errors.push({line:1,reason:'每批次只允许一个独立来源标识'});
 return{events,total:rows.length,errors,duplicateCount};
}
/** Validate complete affected line chains; never infer missing paid events or refund ownership. */
export function validateTransactionChains(events:TransactionEvent[]):string[]{
 const groups=new Map<string,TransactionEvent[]>(),issues:string[]=[];
 for(const e of events){const key=transactionEntity(e);const list=groups.get(key)??[];list.push(e);groups.set(key,list);}
 for(const list of groups.values()){
  const first=list[0]!;const fail=(s:string)=>issues.push(`${first.order_id}/${first.line_id}：${s}`);
  if(list.some(e=>e.sku_id!==first.sku_id||e.spec!==first.spec||e.currency!==first.currency||Date.parse(e.order_at)!==Date.parse(first.order_at))){fail('商品规格、币种或原订单时间不一致');continue;}
  const orders=list.filter(e=>e.kind==='ordered'),payments=list.filter(e=>e.kind==='paid');
  if(orders.length!==1){fail('须有且仅有一个原下单事件');continue;}const order=orders[0]!;
  if(payments.length>1){fail('当前契约不支持分次支付');continue;}
  const paid=payments[0];if(!paid){if(list.some(e=>e.kind==='shipped'||e.kind==='refunded'))fail('缺少原支付事件，不能发货或退款');continue;}
  if(paid.quantity!==order.quantity||paid.amount_minor+paid.allocated_discount_minor!==order.amount_minor+paid.platform_subsidy_minor){fail('支付件数或已分摊结算金额与原订单不一致');continue;}
  const shipped=list.filter(e=>e.kind==='shipped'),refunds=list.filter(e=>e.kind==='refunded');
  if([...shipped,...refunds].some(e=>Date.parse(e.event_at)<Date.parse(paid.event_at)))fail('发货或退款不能早于支付');
  if(shipped.reduce((n,e)=>n+e.quantity,0)>paid.quantity)fail('累计发货件数超过支付件数');
  if(refunds.reduce((n,e)=>n+e.quantity,0)>paid.quantity||refunds.reduce((n,e)=>n+e.amount_minor,0)>paid.amount_minor)fail('累计退款件数或金额超过支付');
 }
 return issues;
}
export function transactionWindow(start:string,end:string):{startInclusive:string;endExclusive:string}{const next=new Date(Date.parse(end+'T00:00:00Z')+86400000).toISOString().slice(0,10);return{startInclusive:start+'T00:00:00+08:00',endExclusive:next+'T00:00:00+08:00'};}
const demoRows=[
 ['O1','L1','E1','ordered','2026-10-14T10:00:00+08:00',2,20000,0,0],
 ['O1','L1','E2','paid','2026-10-14T10:01:00+08:00',2,17000,4000,1000],
 ['O1','L1','E3','shipped','2026-10-14T12:00:00+08:00',2,0,0,0],
 ['O1','L1','E4','refunded','2026-10-16T09:00:00+08:00',1,8500,0,0],
] as const;
export const TRANSACTION_DEMO=TRANSACTION_FIELDS.join(',')+'\n'+demoRows.map(([order,line,id,kind,at,qty,amount,discount,subsidy])=>['demo-transactions',id,order,line,'demo-nanfeng','线上商城','TEA-500','500ml×6瓶','CNY',kind,'2026-10-14T10:00:00+08:00',at,qty,amount,discount,subsidy].join(',')).join('\n');
