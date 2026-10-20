import {z} from 'zod';
import {parseCsv} from '../csv';
import {TRANSACTION_FIELDS,TRANSACTION_OPTIONAL_FIELDS,TransactionEventSchema,transactionKey,type TransactionEvent} from '../transactions';
export const LINE_REFERENCE_FIELDS=TRANSACTION_FIELDS.filter(f=>f!=='source_id');
export const LINE_REFERENCE_TEMPLATE=[...LINE_REFERENCE_FIELDS,...TRANSACTION_OPTIONAL_FIELDS].join(',')+'\n';
export const LineReferenceSchema=z.strictObject({label:z.string().trim().min(1).max(100),observedAt:z.string().datetime({offset:true}),csv:z.string().min(1).max(8000000)});
export type LineReference=z.infer<typeof LineReferenceSchema>;
export interface LineIssue {type:'reference_only'|'batch_only'|'changed';eventId:string;orderId:string;lineId:string;fields:string[];}
export interface LineComparison {rows:number;duplicates:number;matched:number;referenceOnly:number;batchOnly:number;changed:number;issues:LineIssue[];truncated:boolean;}
export function parseLineReference(csv:string,sourceId:string,shopId:string){
 const rows=parseCsv(csv),headers=rows.shift()??[],allowed:readonly string[]=[...LINE_REFERENCE_FIELDS,...TRANSACTION_OPTIONAL_FIELDS];
 if(new Set(headers).size!==headers.length||LINE_REFERENCE_FIELDS.some(f=>!headers.includes(f))||headers.some(f=>!allowed.includes(f)))throw Error('请使用逐行对账模板：必填列缺失、重复或包含未知列');
 if(!rows.length||rows.length>10000)throw Error('逐行参考须包含1至10,000条事件');
 const events:TransactionEvent[]=[],seen=new Map<string,string>();let duplicates=0;
 for(const [index,cells]of rows.entries()){
  if(cells.length!==headers.length)throw Error(`对账文件第${index+2}行列数不一致`);
  const raw:Record<string,unknown>={source_id:sourceId};for(const [col,f]of headers.entries()){const v=cells[col]!.trim();if((TRANSACTION_OPTIONAL_FIELDS as readonly string[]).includes(f)&&!v)continue;raw[f]=['quantity','amount_minor','allocated_discount_minor','platform_subsidy_minor','cancelled_basis_minor'].includes(f)?/^\d+$/.test(v)?Number(v):NaN:['order_at','event_at'].includes(f)&&z.string().datetime({offset:true}).safeParse(v).success?new Date(v).toISOString():v;}
  const p=TransactionEventSchema.safeParse(raw);if(!p.success)throw Error(`对账文件第${index+2}行字段、金额或时间无效`);if(p.data.shop_id!==shopId)throw Error(`对账文件第${index+2}行店铺不匹配`);
  const key=transactionKey(p.data),json=JSON.stringify(p.data),old=seen.get(key);if(old&&old!==json)throw Error(`对账文件第${index+2}行同一事件内容冲突`);if(old){duplicates++;continue;}seen.set(key,json);events.push(p.data);
 }
 return{events,duplicates};
}
export function compareLines(batch:TransactionEvent[],reference:TransactionEvent[],duplicates=0):LineComparison{
 const a=new Map(batch.map(e=>[transactionKey(e),e])),b=new Map(reference.map(e=>[transactionKey(e),e]));
 const result:LineComparison={rows:reference.length,duplicates,matched:0,referenceOnly:0,batchOnly:0,changed:0,issues:[],truncated:false};
 const add=(type:LineIssue['type'],e:TransactionEvent,fields:string[])=>{if(result.issues.length<200)result.issues.push({type,eventId:e.event_id,orderId:e.order_id,lineId:e.line_id,fields});else result.truncated=true;};
 for(const [key,e]of b){const other=a.get(key);if(!other){result.referenceOnly++;add('reference_only',e,[]);continue;}const fields=([...LINE_REFERENCE_FIELDS,...TRANSACTION_OPTIONAL_FIELDS] as Array<keyof TransactionEvent>).filter(f=>e[f]!==other[f]);if(fields.length){result.changed++;add('changed',e,fields);}else result.matched++;}
 for(const [key,e]of a)if(!b.has(key)){result.batchOnly++;add('batch_only',e,[]);}
 return result;
}
