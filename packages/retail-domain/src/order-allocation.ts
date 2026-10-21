import {z} from 'zod';
import {parseCsv} from './csv';

export const ALLOCATION_FIELDS=['order_id','line_id','gross_minor','eligible','order_discount_minor','order_subsidy_minor'] as const;
const minor=z.number().int().min(0).max(100_000_000);
const rowSchema=z.strictObject({order_id:z.string().trim().min(1).max(128),line_id:z.string().trim().min(1).max(128),gross_minor:minor,eligible:z.boolean(),order_discount_minor:minor,order_subsidy_minor:minor});
export type AllocationInput=z.infer<typeof rowSchema>;
export interface AllocationLine extends AllocationInput {allocated_discount_minor:number;platform_subsidy_minor:number;settlement_minor:number}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;

/** Largest remainder in integer fen. The explicit original gross is the weight for both pools. */
export function distributeMinor(rows:Array<Pick<AllocationInput,'line_id'|'eligible'|'gross_minor'>>,total:number):Map<string,number>{
 const eligible=rows.filter(r=>r.eligible&&r.gross_minor>0),weight=eligible.reduce((n,r)=>n+BigInt(r.gross_minor),0n);
 if(total&&weight===0n)throw Error('没有可分摊的正金额参与行');
 const values=eligible.map(r=>{const product=BigInt(total)*BigInt(r.gross_minor);return{id:r.line_id,value:weight?product/weight:0n,remainder:weight?product%weight:0n};});
 let rest=BigInt(total)-values.reduce((n,r)=>n+r.value,0n);
 values.sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:compare(a.id,b.id));
 for(const value of values){if(rest===0n)break;value.value++;rest--;}
 return new Map(values.map(v=>[v.id,Number(v.value)]));
}

export function allocateOrders(input:AllocationInput[]):AllocationLine[]{
 if(!input.length||input.length>10000)throw Error('分摊文件须为1至10,000行');
 const groups=new Map<string,AllocationInput[]>(),seen=new Set<string>();
 for(const raw of input){const row=rowSchema.parse(raw),key=JSON.stringify([row.order_id,row.line_id]);if(seen.has(key))throw Error('同一订单行重复，不能重复分摊');seen.add(key);const list=groups.get(row.order_id)??[];list.push(row);groups.set(row.order_id,list);}
 const output:AllocationLine[]=[];
 for(const [order,rows]of groups){
  const first=rows[0]!;
  if(rows.some(r=>r.order_discount_minor!==first.order_discount_minor||r.order_subsidy_minor!==first.order_subsidy_minor))throw Error(`${order}：订单优惠和补贴须在各行一致声明`);
  if(BigInt(first.order_discount_minor)>rows.filter(r=>r.eligible).reduce((n,r)=>n+BigInt(r.gross_minor),0n))throw Error(`${order}：商家优惠超过参与行标价合计`);
  const discounts=distributeMinor(rows,first.order_discount_minor),subsidies=distributeMinor(rows,first.order_subsidy_minor);
  for(const row of rows){const discount=discounts.get(row.line_id)??0,subsidy=subsidies.get(row.line_id)??0;output.push({...row,allocated_discount_minor:discount,platform_subsidy_minor:subsidy,settlement_minor:row.gross_minor-discount+subsidy});}
 }
 return output.sort((a,b)=>compare(a.order_id,b.order_id)||compare(a.line_id,b.line_id));
}

export function allocateOrderCsv(csv:string):AllocationLine[]{
 const rows=parseCsv(csv),headers=rows.shift()??[];
 if(headers.length!==ALLOCATION_FIELDS.length||new Set(headers).size!==headers.length||ALLOCATION_FIELDS.some(f=>!headers.includes(f)))throw Error('请使用订单优惠分摊模板，字段不完整或不支持');
 return allocateOrders(rows.map((cells,i)=>{
  if(cells.length!==headers.length)throw Error(`行${i+2}：列数不符`);
  const raw=Object.fromEntries(ALLOCATION_FIELDS.map(f=>{const value=cells[headers.indexOf(f)]!.trim();if(f==='eligible'){if(!['true','false'].includes(value))throw Error(`行${i+2}：eligible须为true或false`);return[f,value==='true'];}if(f.endsWith('_minor')){if(!/^\d+$/.test(value))throw Error(`行${i+2}：金额须为非负整数分`);return[f,Number(value)];}return[f,value];}));
  return rowSchema.parse(raw);
 }));
}
const escape=(v:string|number|boolean)=>'"'+String(v).replaceAll('"','""')+'"';
export function allocationCsv(lines:AllocationLine[]):string{
 const fields=[...ALLOCATION_FIELDS,'allocated_discount_minor','platform_subsidy_minor','settlement_minor'] as const;
 // Export identifiers as formula-safe text, matching the application's other CSV exports.
 const safe=(value:string|number|boolean)=>typeof value==='string'&&/^[\s]*[=+\-@\t\r]/.test(value)?"'"+value:value;
 return fields.join(',')+'\n'+lines.map(line=>fields.map(f=>escape(safe(line[f]))).join(',')).join('\n');
}
export const ALLOCATION_DEMO=ALLOCATION_FIELDS.join(',')+'\nO1,A,100,true,1,2\nO1,B,100,true,1,2\nO1,GIFT,0,false,1,2';
