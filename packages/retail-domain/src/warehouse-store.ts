import {Database} from 'bun:sqlite';import {mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {createHash} from 'node:crypto';import {z} from 'zod';
import {WarehouseEventSchema,WarehouseQuerySchema,type WarehouseEvent,type WarehouseQuery,type WarehousePreview,type WarehouseReceipt,type WarehouseLine,type WarehouseView} from './warehouse-contract';
import type {ProcurementEvent} from './procurement-contract';import type {InspectionRow} from './return-inspection-contract';import type {TransactionEvent} from './transactions';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),day=(t:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const eventKey=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.event_id]);
const bucket=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.warehouse_id,e.sku,e.spec,e.batch_id,e.state]);
const batch=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.sku,e.spec,e.batch_id]);
const transferKey=(e:WarehouseEvent&{transfer_id:string})=>JSON.stringify([e.source_id,e.shop_id,e.transfer_id]);
interface References {purchases:ProcurementEvent[];inspections:InspectionRow[];transactions:TransactionEvent[];}
function replay(events:WarehouseEvent[],refs:References){
 const stocks=new Map<string,WarehouseLine>(),expiries=new Map<string,string>(),touched=new Set<string>(),consumed=new Map<string,number>(),transfers=new Map<string,{event:Extract<WarehouseEvent,{kind:'transfer_out'}>;received:number}>();
 const purchases=new Map(refs.purchases.map(p=>[JSON.stringify([p.source_id,p.shop_id,p.event_id]),p])),inspections=new Map(refs.inspections.map(p=>[JSON.stringify([p.source_id,p.shop_id,p.channel,p.inspection_id]),p])),returns=new Map(refs.transactions.map(t=>[JSON.stringify([t.source_id,t.shop_id,t.channel,t.event_id]),t])),shipments=new Set<string>();
 const rank={opening:0,purchase_in:1,return_in:1,transfer_out:2,transfer_in:3,shipment:4};
 for(const e of [...events].sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at)||rank[a.kind]-rank[b.kind]||a.event_id.localeCompare(b.event_id))){
  if(e.expires_on){const old=expiries.get(batch(e));if(old&&old!==e.expires_on)throw Error('同一来源店铺SKU规格批次的效期冲突');if(['opening','purchase_in','return_in'].includes(e.kind))expiries.set(batch(e),e.expires_on);else if(!old)throw Error('发货或调拨不能自行补出未知效期');}
  const k=bucket(e),line=stocks.get(k)??{sourceId:e.source_id,shop:e.shop_id,warehouse:e.warehouse_id,sku:e.sku,spec:e.spec,batchId:e.batch_id,state:e.state,quantity:0,expiresOn:null,available:null};
  const take=(reference:string,limit:number)=>{const used=(consumed.get(reference)??0)+e.quantity;if(used>limit)throw Error('累计入库超过来源到货或质检可入库数量');consumed.set(reference,used);};
  if(e.kind==='opening'){if(touched.has(k))throw Error('期初库存须先于该库存桶其他事件且只能声明一次');line.quantity=e.quantity;}
  else if(e.kind==='purchase_in'){
   const p=purchases.get(JSON.stringify([e.source_id,e.shop_id,e.receipt_event_id]));
   if(!p||p.kind!=='received'||p.warehouse_id!==e.warehouse_id||p.sku!==e.sku||p.spec!==e.spec||p.batch_id!==e.batch_id||p.expires_on!==e.expires_on||Date.parse(p.event_at)>Date.parse(e.event_at))throw Error('采购入库缺少同来源仓库商品批次效期的先前到货记录');
   if(e.state==='scrap')throw Error('采购到货不能直接推断报废入库');take(JSON.stringify(['purchase',p.source_id,p.shop_id,p.event_id,e.state]),e.state==='sellable'?p.accepted_qty:p.quarantined_qty);line.quantity+=e.quantity;
  }else if(e.kind==='return_in'){
   const p=inspections.get(JSON.stringify([e.source_id,e.shop_id,e.channel,e.inspection_id])),t=p&&returns.get(JSON.stringify([p.source_id,p.shop_id,p.channel,p.returned_event_id]));
   if(!p||!t||p.warehouse_id!==e.warehouse_id||t.sku_id!==e.sku||t.spec!==e.spec||Date.parse(p.observed_at)>Date.parse(e.event_at))throw Error('退回入库须引用同仓库商品的先前实物退回质检');
   take(JSON.stringify(['return',p.source_id,p.shop_id,p.channel,p.inspection_id,e.state]),e.state==='sellable'?p.passed_qty:e.state==='quarantine'?p.defective_qty:p.scrap_qty);line.quantity+=e.quantity;
  }else if(e.kind==='transfer_in'){
   const t=transfers.get(transferKey(e));if(!t||t.event.warehouse_id!==e.from_warehouse_id||t.event.to_warehouse_id!==e.warehouse_id||t.event.sku!==e.sku||t.event.spec!==e.spec||t.event.batch_id!==e.batch_id||t.event.state!==e.state||t.event.expires_on!==e.expires_on)throw Error('调拨到仓缺少同批次状态的先前出库记录');t.received+=e.quantity;if(t.received>t.event.quantity)throw Error('调拨到仓累计超过已出库件数');line.quantity+=e.quantity;
  }else{
   if(e.kind==='shipment'){if(e.state!=='sellable')throw Error('发货仅能使用可售状态库存');const sk=JSON.stringify([e.source_id,e.shop_id,e.warehouse_id,e.shipment_ref,e.sku,e.spec,e.batch_id]);if(shipments.has(sk))throw Error('同一发货引用的仓库商品批次不能重复扣减');shipments.add(sk);}
   const expires=e.expires_on??expiries.get(batch(e));if(e.state==='sellable'&&(!expires||expires<day(Date.parse(e.event_at))))throw Error('缺少效期或已过期的可售状态库存不能发货或调出');
   if(line.quantity<e.quantity)throw Error('库存不足，不能形成负库存');line.quantity-=e.quantity;
   if(e.kind==='transfer_out'){if(e.to_warehouse_id===e.warehouse_id)throw Error('调拨不能使用相同的出入仓库');const tk=transferKey(e);if(transfers.has(tk))throw Error('同一调拨标识只能有一次出库');transfers.set(tk,{event:e,received:0});}
  }
  touched.add(k);stocks.set(k,line);
 }
 for(const line of stocks.values())line.expiresOn=expiries.get(JSON.stringify([line.sourceId,line.shop,line.sku,line.spec,line.batchId]))??null;
 return{stocks:[...stocks.values()],transfers:[...transfers.values()].map(t=>({sourceId:t.event.source_id,shop:t.event.shop_id,transferId:t.event.transfer_id,from:t.event.warehouse_id,to:t.event.to_warehouse_id,sent:t.event.quantity,received:t.received,pending:t.event.quantity-t.received}))};
}
export class WarehouseStore {
 private db:Database;
 constructor(file:string,private now=Date.now){mkdirSync(dirname(file),{recursive:true});this.db=new Database(file,{create:true,strict:true});try{this.db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS warehouse_events(key TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS warehouse_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL)');for(const t of['warehouse_events','warehouse_receipts'])for(const op of['UPDATE','DELETE'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_${op} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT,'immutable warehouse');END;`);}catch(e){this.db.close();throw e;}}
 close(){this.db.close();}
 private rows(table:string){return this.db.query<{json:string},[]>(`SELECT json FROM ${table} ORDER BY rowid`).all().map(r=>r.json);}
 private references():References{const tables=new Set(this.db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)),read=(table:string)=>tables.has(table)?this.rows(table).map(s=>JSON.parse(s)):[];return{purchases:read('procurement_events'),inspections:read('return_inspections'),transactions:tables.has('transaction_events')?this.db.query<{json:string},[]>("SELECT json FROM transaction_events WHERE source='csv' AND kind='returned'").all().map(r=>JSON.parse(r.json)):[]};}
 private analyze(json:string){const input=z.array(WarehouseEventSchema).min(1).max(2000).parse(JSON.parse(json)).map(e=>({...e,event_at:new Date(e.event_at).toISOString()})),stored=this.rows('warehouse_events'),refs=this.references(),map=new Map(stored.map(s=>[eventKey(JSON.parse(s)),s])),fresh:WarehouseEvent[]=[],errors:string[]=[];let duplicates=0;
  for(const e of input){if(Date.parse(e.event_at)>this.now()+300000)errors.push('库存事件时间超前');const key=eventKey(e),old=map.get(key),text=JSON.stringify(e);if(old){if(old===text)duplicates++;else errors.push('同一库存事件ID内容冲突');}else{map.set(key,text);fresh.push(e);}}
  if(map.size>50000)errors.push('库存账本达到50,000事件容量上限');try{replay([...map.values()].map(s=>JSON.parse(s)),refs);}catch(e){errors.push(e instanceof Error?e.message:'库存链无效');}
  return{hash:hash(JSON.stringify({json,stored,refs})),canImport:errors.length===0,newEvents:fresh.length,duplicates,errors,sample:input.slice(0,20),fresh};
 }
 preview(json:string):WarehousePreview{return this.db.transaction(()=>{const {fresh,...v}=this.analyze(json);return v;})();}
 import(json:string,previewHash:string):WarehouseReceipt{return this.db.transaction(()=>{const id='warehouse-'+hash(json),old=this.db.query<{json:string},[string]>('SELECT json FROM warehouse_receipts WHERE id=?').get(id);if(old)return{...JSON.parse(old.json) as WarehouseReceipt,replayed:true};const v=this.analyze(json);if(v.hash!==previewHash)throw Error('库存或来源证据已变化，请重新预览');if(!v.canImport)throw Error(v.errors.join('；'));for(const e of v.fresh)this.db.query('INSERT INTO warehouse_events VALUES(?,?)').run(eventKey(e),JSON.stringify(e));const receipt:WarehouseReceipt={id,at:this.now(),accepted:v.newEvents,duplicates:v.duplicates,authority:'operator_declared'};this.db.query('INSERT INTO warehouse_receipts VALUES(?,?)').run(id,JSON.stringify(receipt));return receipt;}).immediate();}
 view(input:WarehouseQuery):WarehouseView {const q=WarehouseQuerySchema.parse(input);if(q.asOf>day(this.now()))throw Error('不能查询未来库存');return this.db.transaction(()=>{const events=this.rows('warehouse_events').map(s=>JSON.parse(s) as WarehouseEvent).filter(e=>day(Date.parse(e.event_at))<=q.asOf),v=replay(events,this.references()),match=(s:{sourceId:string;shop:string})=>(!q.sourceId||s.sourceId===q.sourceId)&&(!q.shop||s.shop===q.shop),lines=v.stocks.filter(l=>match(l)&&(!q.warehouse||l.warehouse===q.warehouse));for(const l of lines)l.available=l.state!=='sellable'?0:l.expiresOn===null?l.quantity===0?0:null:l.expiresOn<q.asOf?0:l.quantity;const sum=(state:WarehouseLine['state'])=>lines.filter(l=>l.state===state).reduce((n,l)=>n+l.quantity,0),transfers=v.transfers.filter(t=>match(t)&&(!q.warehouse||t.from===q.warehouse||t.to===q.warehouse));return{query:q,authority:'operator_declared' as const,totalLines:lines.length,lines:lines.slice(0,100),totals:{sellableRecorded:sum('sellable'),quarantined:sum('quarantine'),scrap:sum('scrap'),available:lines.some(l=>l.available===null)?null:lines.reduce((n,l)=>n+l.available!,0),unknownExpiryLines:lines.filter(l=>l.state==='sellable'&&l.quantity>0&&l.expiresOn===null).length,expiredRecorded:lines.filter(l=>l.state==='sellable'&&l.expiresOn!==null&&l.expiresOn<q.asOf).reduce((n,l)=>n+l.quantity,0),inTransit:transfers.reduce((n,t)=>n+t.pending,0)},transfers:transfers.slice(0,100),recentWorkspaceReceipts:this.rows('warehouse_receipts').slice(-20).reverse().map(s=>JSON.parse(s))};})();}
}
