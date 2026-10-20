import {MappingProfileSchema,mappedFields} from './ingestion-contract';
import type {MappingProfile,Quarantine,ControlTotals} from './ingestion-contract';
export * from './ingestion-contract';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {TransactionEventSchema,TRANSACTION_FIELDS,TRANSACTION_OPTIONAL_FIELDS,transactionKey} from '../transactions';
import type {TransactionEvent} from '../transactions';
import type {SyncJob} from './sync-contract';

export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function inspectOrderFields(orders:Record<string,unknown>[],eventArrayPath:string|null){
 const arrays=new Set<string>(),fields=new Set<string>();
 const walk=(value:unknown,prefix:string,depth:number,target:Set<string>,includeArrays:boolean)=>{if(depth>5||!value||typeof value!=='object')return;for(const key of Object.keys(value).slice(0,100)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||['__proto__','constructor','prototype'].includes(key))continue;const p=prefix?prefix+'.'+key:key,child=(value as Record<string,unknown>)[key];if(Array.isArray(child)){if(includeArrays)arrays.add(p);}else if(child!==null&&typeof child==='object')walk(child,p,depth+1,target,includeArrays);else target.add(p);}};
 for(const order of orders.slice(0,30)){walk(order,'',0,new Set(),true);const events=eventArrayPath?read(order,eventArrayPath):[order];if(Array.isArray(events))for(const event of events.slice(0,10))walk(event,'',0,fields,false);}
 return{arrays:[...arrays].sort().slice(0,200),fields:[...fields].sort().slice(0,500),totalRecords:orders.length};
}
export function sourceIdentity(job:SyncJob):string {if(job.mode==='fixture')return'merqo-doudian-fixture';if(!job.scope?.shopId)throw Error('旧任务缺少冻结店铺范围，请重新拉取');return'doudian-shop-'+digest(job.scope.shopId).slice(0,32);}
function read(record:unknown,p:string):unknown {let value=record;for(const key of p.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))return undefined;value=(value as Record<string,unknown>)[key];}return value;}
function integer(value:unknown):number {if(typeof value==='string'&&/^\d+$/.test(value))value=Number(value);if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('必须是非负安全整数');return value;}
function money(value:unknown,unit:MappingProfile['moneyUnit']):number{
 if(unit==='minor_integer')return integer(value);
 if(typeof value!=='string'||!/^\d+(\.\d{1,2})?$/.test(value))throw Error('元金额须为最多两位小数的字符串，禁止浮点猜测');
 const [whole,fraction='']=value.split('.');const amount=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));if(amount>100000000n)throw Error('金额超出范围');return Number(amount);
}
function identifier(value:unknown):string {if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw Error('标识精度不安全，请提供原始字符串');return String(value);}if(typeof value!=='string'||!value.trim())throw Error('缺少明确标识或文本');return value.trim();}
function timestamp(value:unknown,unit:MappingProfile['timeUnit']):string {if(unit==='iso_offset'){if(typeof value!=='string'||!z.string().datetime({offset:true}).safeParse(value).success)throw Error('需要带时区的 ISO 时间');return new Date(value).toISOString();}const n=integer(value)*(unit==='unix_seconds'?1000:1);if(!Number.isSafeInteger(n)||!Number.isFinite(new Date(n).getTime()))throw Error('时间超出范围');return new Date(n).toISOString();}
export function mapOrders(orders:Record<string,unknown>[],mapping:MappingProfile,job:SyncJob):{events:TransactionEvent[];quarantine:Quarantine[];duplicates:number}{
 MappingProfileSchema.parse(mapping);if(mapping.mode!==job.mode)throw Error('映射模式与来源不一致，演练映射不能用于真实数据');
 const sourceId=sourceIdentity(job),quarantine:Quarantine[]=[],candidates:Array<{record:number;event:TransactionEvent}>=[];
 for(const [index,order]of orders.entries()){
  const raw=mapping.eventArrayPath?read(order,mapping.eventArrayPath):[order];
  if(!Array.isArray(raw)||!raw.length||raw.length>1000){quarantine.push({record:index+1,event:null,reason:'缺少明确事件数组或事件数超出范围；订单快照不自动推断支付/退款'});continue;}
  const local:TransactionEvent[]=[];let bad=false;
  for(const [eventIndex,input]of raw.entries()){
   try{
    const event:Record<string,unknown>={source_id:sourceId};
    for(const field of [...mappedFields,...TRANSACTION_OPTIONAL_FIELDS]){
     const p=mapping.fields[field];if(!p){if((TRANSACTION_OPTIONAL_FIELDS as readonly string[]).includes(field))continue;throw Error(`缺少字段 ${field}`);}
     const value=read(input,p);
     try{event[field]=field==='kind'?mapping.kindMap[identifier(value)]:field==='quantity'?integer(value):['amount_minor','allocated_discount_minor','platform_subsidy_minor'].includes(field)?money(value,mapping.moneyUnit):['event_at','order_at'].includes(field)?timestamp(value,mapping.timeUnit):identifier(value);}catch{throw Error(`${field} 缺失或格式/单位不符合映射契约`);}
    }
    const parsed=TransactionEventSchema.safeParse(event);if(!parsed.success)throw Error(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；'));
    if(parsed.data.shop_id!==(job.mode==='fixture'?'DEMO-SHOP':job.scope?.shopId))throw Error('事件店铺与任务冻结店铺不一致');
    local.push(parsed.data);
   }catch(e){bad=true;quarantine.push({record:index+1,event:eventIndex+1,reason:e instanceof Error?e.message:'事件映射失败'});}
  }
  if(!bad)for(const event of local)candidates.push({record:index+1,event});
 }
 const seen=new Map<string,string>(),conflicts=new Set<string>();let duplicates=0;
 for(const row of candidates){const key=transactionKey(row.event),json=JSON.stringify(row.event),old=seen.get(key);if(old&&old!==json)conflicts.add(key);else if(!old)seen.set(key,json);}
 const badRecords=new Set(candidates.filter(r=>conflicts.has(transactionKey(r.event))).map(r=>r.record));
 for(const record of badRecords)quarantine.push({record,event:null,reason:'同一事件 ID 存在不同内容，整条来源记录隔离'});
 const events:TransactionEvent[]=[],keys=new Set<string>();for(const row of candidates){const key=transactionKey(row.event);if(badRecords.has(row.record))continue;if(keys.has(key))duplicates++;else{keys.add(key);events.push(row.event);}}
 return{events,quarantine,duplicates};
}
export function eventsCsv(events:TransactionEvent[]):string {const fields=[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS];const cell=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';return fields.join(',')+'\n'+events.map(e=>fields.map(f=>cell(e[f])).join(',')).join('\n');}
export function totals(events:TransactionEvent[]):ControlTotals {const t:ControlTotals={eventCount:events.length,orderedQty:0,paidQty:0,refundedQty:0,paidMinor:0,refundedMinor:0,discountMinor:0,subsidyMinor:0};for(const e of events){if(e.kind==='ordered')t.orderedQty+=e.quantity;if(e.kind==='paid'){t.paidQty+=e.quantity;t.paidMinor+=e.amount_minor;t.discountMinor+=e.allocated_discount_minor;t.subsidyMinor+=e.platform_subsidy_minor;}if(e.kind==='refunded'){t.refundedQty+=e.quantity;t.refundedMinor+=e.amount_minor;}}return t;}
