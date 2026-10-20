import {z} from 'zod';
import {parseCsv} from './csv';
import {SourceMetadataInputSchema} from './source-metadata';
import type {EvidenceProvenance} from './source-metadata';
const id=z.string().trim().min(1).max(128),text=z.string().trim().min(1).max(200);
const amount=z.number().int().min(0).max(100_000_000),time=z.string().datetime({offset:true});
export const TransactionEventSchema=z.strictObject({
 source_id:id,event_id:id,order_id:id,line_id:id,shop_id:id,channel:text,sku_id:id,spec:text,currency:z.literal('CNY'),
 kind:z.enum(['ordered','paid','shipped','refunded','cancelled','returned']),order_at:time,event_at:time,
 quantity:z.number().int().min(0).max(1_000_000),amount_minor:amount,allocated_discount_minor:amount,platform_subsidy_minor:amount,
 replaces_order_id:id.optional(),replaces_line_id:id.optional(),
}).superRefine((r,c)=>{
 if(Date.parse(r.event_at)<Date.parse(r.order_at))c.addIssue({code:'custom',message:'事件发生时间不能早于原订单时间'});
 if(r.kind==='ordered'&&Date.parse(r.event_at)!==Date.parse(r.order_at))c.addIssue({code:'custom',message:'下单事件时间必须等于原订单时间'});
 if(!['refunded','paid'].includes(r.kind)&&r.quantity===0)c.addIssue({code:'custom',message:'下单、发货、取消和实物退回数量须大于零'});
 if(r.kind==='paid'&&r.quantity===0&&r.amount_minor===0&&r.allocated_discount_minor===0&&r.platform_subsidy_minor===0)c.addIssue({code:'custom',message:'分次支付不能为空事件'});
 if(r.kind==='refunded'&&r.quantity===0&&r.amount_minor===0)c.addIssue({code:'custom',message:'退款不能同时零件数零金额'});
 if(r.kind!=='paid'&&(r.allocated_discount_minor!==0||r.platform_subsidy_minor!==0))c.addIssue({code:'custom',message:'优惠和平台结算补贴只在支付事件填写'});
 if(['shipped','cancelled','returned'].includes(r.kind)&&r.amount_minor!==0)c.addIssue({code:'custom',message:'发货、取消和实物退回不重复记收入，金额必须为零'});
 if(Boolean(r.replaces_order_id)!==Boolean(r.replaces_line_id)||r.replaces_order_id&&r.kind!=='ordered')c.addIssue({code:'custom',message:'换货关联只在新下单事件填写，须同时给出原订单及原行ID'});
});
export type TransactionEvent=z.infer<typeof TransactionEventSchema>;
export const TRANSACTION_FIELDS=['source_id','event_id','order_id','line_id','shop_id','channel','sku_id','spec','currency','kind','order_at','event_at','quantity','amount_minor','allocated_discount_minor','platform_subsidy_minor'] as const satisfies ReadonlyArray<keyof TransactionEvent>;
export const TRANSACTION_OPTIONAL_FIELDS=['replaces_order_id','replaces_line_id'] as const;
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
 totals:{orderedQty:number;paidQty:number;shippedQty:number;refundedQty:number;cancelledQty:number;returnedQty:number;exchangeQty:number;paidMinor:number;refundedMinor:number;retainedMinor:number;netPaidQty:number};
 limitation:string;
}
export const transactionEntity=(e:TransactionEvent)=>JSON.stringify([e.source_id,e.shop_id,e.channel,e.order_id,e.line_id]);
export const transactionKey=(e:TransactionEvent)=>JSON.stringify([e.source_id,e.shop_id,e.channel,e.event_id]);
export const exchangeTarget=(e:TransactionEvent)=>e.replaces_order_id&&e.replaces_line_id?JSON.stringify([e.source_id,e.shop_id,e.channel,e.replaces_order_id,e.replaces_line_id]):undefined;
export function decodeTransactionCsv(csv:string):Omit<TransactionPreview,'hash'|'canImport'>{
 const rows=parseCsv(csv),headers=rows.shift()??[],errors:TransactionPreview['errors']=[],events:TransactionEvent[]=[];let duplicateCount=0;
 const allFields:readonly string[]=[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS];
 if(new Set(headers).size!==headers.length||TRANSACTION_FIELDS.some(f=>!headers.includes(f))||headers.some(h=>!allFields.includes(h)))return{events,total:rows.length,errors:[{line:1,reason:'请使用交易事件模板，列名缺失、重复或不支持'}],duplicateCount};
 const seen=new Map<string,string>();
 for(const [i,cells]of rows.entries()){
  if(i>=100000)throw Error('单次交易导入最多100,000条事件');
  if(cells.length!==headers.length){errors.push({line:i+2,reason:'列数量与表头不符'});continue;}
  const raw=Object.fromEntries(headers.flatMap(f=>{const v=cells[headers.indexOf(f)]?.trim()??'';if((TRANSACTION_OPTIONAL_FIELDS as readonly string[]).includes(f)&&!v)return[];return[[f,['quantity','amount_minor','allocated_discount_minor','platform_subsidy_minor'].includes(f)?/^\d+$/.test(v)?Number(v):NaN:v]];}));
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
  if(new Set(payments.map(e=>Date.parse(e.event_at))).size!==payments.length){fail('分次支付的发生时间必须可区分，不能猜测先后');continue;}
  let cash=0,settledBasis=0,paidQty=0,shippedQty=0,refundedQty=0,refundedCash=0,cancelledQty=0,returnedQty=0,closed=false;
  // Equal timestamps across different phases retain the existing paid -> shipped -> refund convention.
  const rank={ordered:0,paid:1,cancelled:2,shipped:3,returned:4,refunded:5};
  for(const e of [...list].sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at)||rank[a.kind]-rank[b.kind]||a.event_id.localeCompare(b.event_id))){
   if(e.kind==='ordered')continue;
   if(e.kind==='paid'){
    if(closed||paidQty){fail('已取消或已结清的订单行不能继续支付');break;}
    cash+=e.amount_minor;settledBasis+=e.amount_minor+e.allocated_discount_minor-e.platform_subsidy_minor;
    if(settledBasis<0||settledBasis>order.amount_minor){fail('累计已分摊结算金额超过原订单或为负');break;}
    const final=settledBasis===order.amount_minor;
    if(final?e.quantity!==order.quantity:e.quantity!==0){fail('未结清数量须为零，结清时须一次确认原订单全部支付件数');break;}
    if(final)paidQty=e.quantity;
   }else if(e.kind==='cancelled'){
    if(!paidQty){if(closed||e.quantity!==order.quantity){fail('未结清订单只支持一次整行取消');break;}closed=true;}
    cancelledQty+=e.quantity;
    if(cancelledQty+shippedQty>order.quantity){fail('累计取消与发货件数超过原订单');break;}
   }else if(e.kind==='shipped'){
    if(!paidQty||closed){fail('缺少已结清的原支付事件，不能发货');break;}
    shippedQty+=e.quantity;if(shippedQty+cancelledQty>paidQty){fail('累计发货与取消件数超过支付件数');break;}
   }else if(e.kind==='returned'){
    returnedQty+=e.quantity;if(returnedQty>shippedQty){fail('实物退回不能早于发货或超过已发货件数');break;}
   }else{
    refundedQty+=e.quantity;refundedCash+=e.amount_minor;
    if(!payments.length||!cash&&e.amount_minor>0||refundedQty>paidQty||refundedCash>cash){fail('累计退款件数或金额超过当时支付');break;}
   }
  }
 }
 // Replacement is an explicit new order, never a financial netting shortcut. Count old returned units once.
 const replacements=events.filter(e=>e.kind==='ordered'&&exchangeTarget(e));
 const link=new Map(replacements.map(e=>[transactionEntity(e),exchangeTarget(e)!]));
 const checked=new Set<string>(),byTarget=new Map<string,TransactionEvent[]>();
 for(const e of replacements){
  const visited=new Set<string>();let next:string|undefined=transactionEntity(e);
  while(next&&!checked.has(next)){if(visited.has(next)){issues.push(`${e.order_id}/${e.line_id}：换货关联存在循环`);break;}visited.add(next);next=link.get(next);}
  for(const key of visited)checked.add(key);
  const target=exchangeTarget(e)!,list=byTarget.get(target)??[];list.push(e);byTarget.set(target,list);
 }
 for(const [target,orders]of byTarget){
  const original=groups.get(target);
  if(!original){issues.push(`${orders[0]!.order_id}/${orders[0]!.line_id}：缺少同来源店铺渠道的原换货订单行`);continue;}
  const returns=original.filter(r=>r.kind==='returned').sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at));
  let available=0,consumed=0,index=0;
  for(const e of orders.sort((a,b)=>Date.parse(a.order_at)-Date.parse(b.order_at))){
   while(index<returns.length&&Date.parse(returns[index]!.event_at)<=Date.parse(e.order_at))available+=returns[index++]!.quantity;
   consumed+=e.quantity;if(consumed>available)issues.push(`${e.order_id}/${e.line_id}：换货件数超过当时已实物退回的未关联件数`);
  }
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

const example=decodeTransactionCsv(TRANSACTION_DEMO).events;
const extendedEvents:TransactionEvent[]=[
 example[0]!,
 {...example[1]!,quantity:0,amount_minor:4000,allocated_discount_minor:0,platform_subsidy_minor:0},
 {...example[1]!,event_id:'E5',event_at:'2026-10-15T10:00:00+08:00',amount_minor:13000},
 {...example[2]!,event_id:'E6',kind:'cancelled' as const,quantity:1,event_at:'2026-10-15T11:00:00+08:00'},
 {...example[2]!,quantity:1,event_at:'2026-10-15T12:00:00+08:00'},
 {...example[2]!,event_id:'E7',kind:'returned' as const,quantity:1,event_at:'2026-10-16T08:00:00+08:00'},
 example[3]!,
].map(e=>({...e,source_id:'example-installments'}));
export const TRANSACTION_EXTENDED_DEMO=TRANSACTION_FIELDS.join(',')+'\n'+extendedEvents.map(e=>TRANSACTION_FIELDS.map(f=>e[f]).join(',')).join('\n');
const exchangeOrder:TransactionEvent={...example[0]!,source_id:'example-installments',order_id:'EXCHANGE-O1',event_id:'EXCHANGE-E1',sku_id:'TEA-NEW',spec:'替换品500ml×6瓶',quantity:1,amount_minor:10000,order_at:'2026-10-16T10:00:00+08:00',event_at:'2026-10-16T10:00:00+08:00',replaces_order_id:'O1',replaces_line_id:'L1'};
const exchangeFields=[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS];
export const TRANSACTION_EXCHANGE_DEMO=exchangeFields.join(',')+'\n'+[...extendedEvents,exchangeOrder].map(e=>exchangeFields.map(f=>e[f]??'').join(',')).join('\n');
