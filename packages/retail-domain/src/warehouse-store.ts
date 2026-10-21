import {Database} from 'bun:sqlite';import {mkdirSync} from 'node:fs';import {dirname} from 'node:path';import {createHash} from 'node:crypto';import {z} from 'zod';
import {WarehouseEventSchema,WarehouseQuerySchema,type WarehouseEvent,type WarehouseQuery,type WarehousePreview,type WarehouseReceipt,type WarehouseLine,type WarehouseView,type WarehouseReservation} from './warehouse-contract';
import type {ProcurementEvent} from './procurement-contract';import type {InspectionRow} from './return-inspection-contract';import type {TransactionEvent} from './transactions';
import {WarehousePickInputSchema,type WarehousePickInput,type WarehousePickPlan,type WarehousePickReceipt} from './warehouse-contract';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),day=(t:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
const eventKey=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.event_id]);
const bucket=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.warehouse_id,e.sku,e.spec,e.batch_id,e.state]);
const batch=(e:WarehouseEvent)=>JSON.stringify([e.source_id,e.shop_id,e.sku,e.spec,e.batch_id]);
const transferKey=(e:WarehouseEvent&{transfer_id:string})=>JSON.stringify([e.source_id,e.shop_id,e.transfer_id]);
interface References {purchases:ProcurementEvent[];inspections:InspectionRow[];transactions:TransactionEvent[];}
function replay(events:WarehouseEvent[],refs:References){
 const stocks=new Map<string,WarehouseLine>(),expiries=new Map<string,string>(),touched=new Set<string>(),consumed=new Map<string,number>(),transfers=new Map<string,{event:Extract<WarehouseEvent,{kind:'transfer_out'}>;received:number;lost:number;returned:number}>();
 const reservations=new Map<string,{event:Extract<WarehouseEvent,{kind:'reserve'}>;released:number;shipped:number}>();
 const purchases=new Map(refs.purchases.map(p=>[JSON.stringify([p.source_id,p.shop_id,p.event_id]),p])),inspections=new Map(refs.inspections.map(p=>[JSON.stringify([p.source_id,p.shop_id,p.channel,p.inspection_id]),p])),returns=new Map(refs.transactions.map(t=>[JSON.stringify([t.source_id,t.shop_id,t.channel,t.event_id]),t])),shipments=new Set<string>();
 const rank={opening:0,purchase_in:1,return_in:1,expiry_corrected:2,inventory_count:3,state_changed:4,reserve:5,release:6,transfer_out:7,transfer_in:8,transfer_loss:9,transfer_return:10,shipment:11};
 for(const e of [...events].sort((a,b)=>Date.parse(a.event_at)-Date.parse(b.event_at)||rank[a.kind]-rank[b.kind]||a.event_id.localeCompare(b.event_id))){
  if(e.kind==='expiry_corrected'){
   if(!stocks.has(bucket(e)))throw Error('效期更正须引用已存在的仓库商品批次状态');if((expiries.get(batch(e))??null)!==e.previous_expires_on)throw Error('效期更正的原效期与账本不一致');if(e.expires_on===e.previous_expires_on)throw Error('效期更正须声明不同的新效期');if(e.expires_on)expiries.set(batch(e),e.expires_on);else expiries.delete(batch(e));
  }else if(e.expires_on){const old=expiries.get(batch(e));if(old&&old!==e.expires_on)throw Error('同一来源店铺SKU规格批次的效期冲突');if(['opening','purchase_in','return_in'].includes(e.kind))expiries.set(batch(e),e.expires_on);else if(!old)throw Error('发货或调拨不能自行补出未知效期');}
  const k=bucket(e),line=stocks.get(k)??{sourceId:e.source_id,shop:e.shop_id,warehouse:e.warehouse_id,sku:e.sku,spec:e.spec,batchId:e.batch_id,state:e.state,quantity:0,reserved:0,expiresOn:null,available:null};
  const reservation=(reservationId:string)=>{const r=reservations.get(JSON.stringify([e.source_id,e.shop_id,reservationId]));if(!r||bucket(r.event)!==k)throw Error('预占引用不存在或仓库商品批次状态不匹配');return r;};
  const validExpiry=()=>{const expires=e.expires_on??expiries.get(batch(e));if(e.state==='sellable'&&(!expires||expires<day(Date.parse(e.event_at))))throw Error('缺少效期或已过期的可售状态库存不能预占、发货或调出');};
  const take=(reference:string,limit:number)=>{const used=(consumed.get(reference)??0)+e.quantity;if(used>limit)throw Error('累计入库超过来源到货或质检可入库数量');consumed.set(reference,used);};
  if(e.kind==='expiry_corrected'){
   // Batch-wide metadata correction changes neither physical stock nor reservations.
  }else if(e.kind==='inventory_count'){
   if(!stocks.has(k)||line.quantity!==e.expected_quantity)throw Error('盘点更正须匹配已存在库存桶的账面数量');if(e.quantity<line.reserved)throw Error('盘点实存少于预占，请先核对并释放相关预占');line.quantity=e.quantity;
  }else if(e.kind==='state_changed'){
   if(e.state===e.to_state||e.state==='scrap')throw Error('状态转换须改变状态，报废状态不能恢复');if(line.quantity-line.reserved<e.quantity)throw Error('状态转换不能挪用已预占库存或超过现存');if(e.to_state==='sellable'){const expires=expiries.get(batch(e));if(!expires||expires<day(Date.parse(e.event_at)))throw Error('缺少效期或已过期的库存不能转可售');}
   line.quantity-=e.quantity;const targetKey=JSON.stringify([e.source_id,e.shop_id,e.warehouse_id,e.sku,e.spec,e.batch_id,e.to_state]),target=stocks.get(targetKey)??{...line,state:e.to_state,quantity:0,reserved:0};target.quantity+=e.quantity;stocks.set(targetKey,target);touched.add(targetKey);
  }else if(e.kind==='transfer_loss'||e.kind==='transfer_return'){
   const t=transfers.get(transferKey(e));if(!t||bucket(t.event)!==k)throw Error('调拨异常须引用原调出仓库商品批次状态');if(t.received+t.lost+t.returned+e.quantity>t.event.quantity)throw Error('调拨到仓、丢失及退回合计超过已出库数量');if(e.kind==='transfer_loss')t.lost+=e.quantity;else{t.returned+=e.quantity;line.quantity+=e.quantity;}
  }else if(e.kind==='opening'){if(touched.has(k))throw Error('期初库存须先于该库存桶其他事件且只能声明一次');line.quantity=e.quantity;}
  else if(e.kind==='purchase_in'){
   const p=purchases.get(JSON.stringify([e.source_id,e.shop_id,e.receipt_event_id]));
   if(!p||p.kind!=='received'||p.warehouse_id!==e.warehouse_id||p.sku!==e.sku||p.spec!==e.spec||p.batch_id!==e.batch_id||p.expires_on!==e.expires_on||Date.parse(p.event_at)>Date.parse(e.event_at))throw Error('采购入库缺少同来源仓库商品批次效期的先前到货记录');
   if(e.state==='scrap')throw Error('采购到货不能直接推断报废入库');take(JSON.stringify(['purchase',p.source_id,p.shop_id,p.event_id,e.state]),e.state==='sellable'?p.accepted_qty:p.quarantined_qty);line.quantity+=e.quantity;
  }else if(e.kind==='return_in'){
   const p=inspections.get(JSON.stringify([e.source_id,e.shop_id,e.channel,e.inspection_id])),t=p&&returns.get(JSON.stringify([p.source_id,p.shop_id,p.channel,p.returned_event_id]));
   if(!p||!t||p.warehouse_id!==e.warehouse_id||t.sku_id!==e.sku||t.spec!==e.spec||Date.parse(p.observed_at)>Date.parse(e.event_at))throw Error('退回入库须引用同仓库商品的先前实物退回质检');
   take(JSON.stringify(['return',p.source_id,p.shop_id,p.channel,p.inspection_id,e.state]),e.state==='sellable'?p.passed_qty:e.state==='quarantine'?p.defective_qty:p.scrap_qty);line.quantity+=e.quantity;
  }else if(e.kind==='reserve'){
   if(e.state!=='sellable')throw Error('预占仅能使用可售状态库存');validExpiry();const rk=JSON.stringify([e.source_id,e.shop_id,e.reservation_id]);if(reservations.has(rk))throw Error('同一预占标识只能创建一次');if(line.quantity-line.reserved<e.quantity)throw Error('未预占可用库存不足');line.reserved+=e.quantity;reservations.set(rk,{event:e,released:0,shipped:0});
  }else if(e.kind==='release'){
   const r=reservation(e.reservation_id);if(e.quantity>r.event.quantity-r.released-r.shipped)throw Error('释放数量超过剩余预占');r.released+=e.quantity;line.reserved-=e.quantity;
  }else if(e.kind==='transfer_in'){
   const t=transfers.get(transferKey(e));if(!t||t.event.warehouse_id!==e.from_warehouse_id||t.event.to_warehouse_id!==e.warehouse_id||t.event.sku!==e.sku||t.event.spec!==e.spec||t.event.batch_id!==e.batch_id||t.event.state!==e.state)throw Error('调拨到仓缺少同批次状态的先前出库记录');t.received+=e.quantity;if(t.received+t.lost+t.returned>t.event.quantity)throw Error('调拨到仓累计超过已出库件数或剩余在途');line.quantity+=e.quantity;
  }else{
   if(e.kind==='shipment'){if(e.state!=='sellable')throw Error('发货仅能使用可售状态库存');const sk=JSON.stringify([e.source_id,e.shop_id,e.warehouse_id,e.shipment_ref,e.sku,e.spec,e.batch_id]);if(shipments.has(sk))throw Error('同一发货引用的仓库商品批次不能重复扣减');shipments.add(sk);}
   validExpiry();
   if(e.kind==='shipment'&&e.reservation_id){const r=reservation(e.reservation_id);if(e.quantity>r.event.quantity-r.released-r.shipped)throw Error('发货数量超过剩余预占');r.shipped+=e.quantity;line.reserved-=e.quantity;}else if(line.quantity-line.reserved<e.quantity)throw Error('未预占可用库存不足，不能挪用已预占库存');
   if(line.quantity<e.quantity)throw Error('库存不足，不能形成负库存');line.quantity-=e.quantity;
   if(e.kind==='transfer_out'){if(e.to_warehouse_id===e.warehouse_id)throw Error('调拨不能使用相同的出入仓库');const tk=transferKey(e);if(transfers.has(tk))throw Error('同一调拨标识只能有一次出库');transfers.set(tk,{event:e,received:0,lost:0,returned:0});}
  }
  touched.add(k);stocks.set(k,line);
 }
 for(const line of stocks.values())line.expiresOn=expiries.get(JSON.stringify([line.sourceId,line.shop,line.sku,line.spec,line.batchId]))??null;
 return{stocks:[...stocks.values()],reservations:[...reservations.values()].map((r):WarehouseReservation=>({sourceId:r.event.source_id,shop:r.event.shop_id,warehouse:r.event.warehouse_id,reservationId:r.event.reservation_id,orderRef:r.event.order_ref,sku:r.event.sku,spec:r.event.spec,batchId:r.event.batch_id,reserved:r.event.quantity,released:r.released,shipped:r.shipped,pending:r.event.quantity-r.released-r.shipped})),transfers:[...transfers.values()].map(t=>({sourceId:t.event.source_id,shop:t.event.shop_id,transferId:t.event.transfer_id,from:t.event.warehouse_id,to:t.event.to_warehouse_id,sent:t.event.quantity,received:t.received,lost:t.lost,returned:t.returned,pending:t.event.quantity-t.received-t.lost-t.returned}))};
}
export class WarehouseStore {
 private db:Database;
 constructor(file:string,private now=Date.now){mkdirSync(dirname(file),{recursive:true});this.db=new Database(file,{create:true,strict:true});try{this.db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS warehouse_events(key TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS warehouse_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL)');for(const t of['warehouse_events','warehouse_receipts'])for(const op of['UPDATE','DELETE'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${t}_no_${op} BEFORE ${op} ON ${t} BEGIN SELECT RAISE(ABORT,'immutable warehouse');END;`);}catch(e){this.db.close();throw e;}}
 close(){this.db.close();}
 private pickState(input:WarehousePickInput){
  const at=this.now(),today=day(at),stored=this.rows('warehouse_events'),refs=this.references(),events=stored.map(s=>JSON.parse(s) as WarehouseEvent),active=events.filter(e=>Date.parse(e.event_at)<=at);
  const lines=replay(active,refs).stocks.filter(l=>l.sourceId===input.sourceId&&l.shop===input.shop&&l.warehouse===input.warehouse&&l.sku===input.sku&&l.spec===input.spec);
  const usable=lines.filter(l=>l.state==='sellable'&&l.expiresOn!==null&&l.expiresOn>=today&&l.quantity>l.reserved).sort((a,b)=>a.expiresOn!<b.expiresOn!?-1:a.expiresOn!>b.expiresOn!?1:a.batchId<b.batchId?-1:a.batchId>b.batchId?1:0);
  const selections:WarehousePickPlan['selections']=[];let left=input.quantity;
  for(const l of usable){if(!left)break;const quantity=Math.min(left,l.quantity-l.reserved);selections.push({batchId:l.batchId,expiresOn:l.expiresOn!,quantity});left-=quantity;}
  const excluded={unknownExpiry:lines.filter(l=>l.state==='sellable'&&l.expiresOn===null).reduce((n,l)=>n+l.quantity-l.reserved,0),expired:lines.filter(l=>l.state==='sellable'&&l.expiresOn!==null&&l.expiresOn<today).reduce((n,l)=>n+l.quantity-l.reserved,0),quarantined:lines.filter(l=>l.state!=='sellable').reduce((n,l)=>n+l.quantity,0),reserved:lines.reduce((n,l)=>n+l.reserved,0)};
  return{at,today,stored,refs,events,selections,excluded,shortfall:left,knownAvailable:usable.reduce((n,l)=>n+l.quantity-l.reserved,0),hash:hash(JSON.stringify({input,today,stored,active,refs}))};
 }
 private pickEvents(plan:WarehousePickPlan,at:number):WarehouseEvent[]{return plan.selections.map((s,i)=>({source_id:plan.input.sourceId,event_id:`pick-${plan.id}-${i}`,shop_id:plan.input.shop,warehouse_id:plan.input.warehouse,sku:plan.input.sku,spec:plan.input.spec,batch_id:s.batchId,expires_on:s.expiresOn,event_at:new Date(at).toISOString(),state:'sellable',kind:'reserve',quantity:s.quantity,reservation_id:`pick-${plan.id}-${i}`,order_ref:plan.input.orderRef}));}
 pickPreview(input:WarehousePickInput):WarehousePickPlan {
  const value=WarehousePickInputSchema.parse(input);
  return this.db.transaction(()=>{
   this.db.exec('CREATE TABLE IF NOT EXISTS warehouse_pick_plans(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,json TEXT NOT NULL)');this.db.query('DELETE FROM warehouse_pick_plans WHERE created_at<?').run(this.now()-600000);
   const v=this.pickState(value),plan:WarehousePickPlan={id:crypto.randomUUID(),at:v.at,validUntil:v.at+600000,hash:v.hash,businessDay:v.today,input:value,status:v.shortfall?v.excluded.unknownExpiry?'needs_evidence':'insufficient':'ready',reasons:[],knownAvailable:v.knownAvailable,shortfall:v.shortfall,excluded:v.excluded,selections:v.selections};
   if(plan.shortfall)plan.reasons.push(`已知效期且未预占的库存不足，缺 ${plan.shortfall} 件；不自动部分预占`);
   if(v.excluded.unknownExpiry)plan.reasons.push(`效期未知 ${v.excluded.unknownExpiry} 件不参与分配；仅在效期明确的批次中按先到期顺序选择`);
   if(plan.selections.length>100){plan.status='blocked';plan.reasons.push('本次需要超过100个批次，请缩小本次数量或另行核对');plan.selections=[];}
   if(v.stored.length+plan.selections.length>50000){plan.status='blocked';plan.reasons.push('库存账本事件容量不足，不能新增本次预占');}
   if(plan.status==='ready')try{replay([...v.events,...this.pickEvents(plan,v.at)],v.refs);}catch(e){plan.status='blocked';plan.reasons.push(e instanceof Error?e.message:'现有事件链不允许新增预占');}
   if(this.db.query<{n:number},[]>('SELECT COUNT(*) n FROM warehouse_pick_plans').get()!.n>=1000)throw Error('短期拣货预览过多，请稍后重试');
   this.db.query('INSERT INTO warehouse_pick_plans VALUES(?,?,?)').run(plan.id,plan.at,JSON.stringify(plan));return plan;
  }).immediate();
 }
 pickConfirm(id:string,reviewHash:string):WarehousePickReceipt {
  return this.db.transaction(()=>{
   const receiptId='warehouse-pick-'+id,old=this.db.query<{json:string},[string]>('SELECT json FROM warehouse_receipts WHERE id=?').get(receiptId);if(old){const r=JSON.parse(old.json) as WarehousePickReceipt;if(r.plan.hash!==reviewHash)throw Error('拣货预览摘要不匹配');return{...r,replayed:true};}
   const exists=this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='warehouse_pick_plans'").get(),row=exists?this.db.query<{json:string},[string]>('SELECT json FROM warehouse_pick_plans WHERE id=?').get(id):null;if(!row)throw Error('拣货预览不存在或已过期，请重新生成');
   const plan=JSON.parse(row.json) as WarehousePickPlan;if(plan.hash!==reviewHash||plan.status!=='ready')throw Error('拣货预览不允许确认');if(this.now()>plan.validUntil||day(this.now())!==plan.businessDay)throw Error('拣货预览已过期或跨业务日，请重新生成');
   const current=this.pickState(plan.input);if(current.hash!==plan.hash)throw Error('库存或来源证据已变化，请重新生成拣货建议');
   const events=this.pickEvents(plan,this.now()),json=JSON.stringify(events),analysis=this.analyze(json);if(!analysis.canImport)throw Error(analysis.errors.join('；'));for(const e of analysis.fresh)this.db.query('INSERT INTO warehouse_events VALUES(?,?)').run(eventKey(e),JSON.stringify(e));
   const receipt:WarehousePickReceipt={id:receiptId,at:this.now(),accepted:analysis.newEvents,duplicates:analysis.duplicates,authority:'operator_declared',plan,reservationIds:events.map(e=>e.kind==='reserve'?e.reservation_id:'')};this.db.query('INSERT INTO warehouse_receipts VALUES(?,?)').run(receipt.id,JSON.stringify(receipt));return receipt;
  }).immediate();
 }
 private rows(table:string){return this.db.query<{json:string},[]>(`SELECT json FROM ${table} ORDER BY rowid`).all().map(r=>r.json);}
 private references():References{const tables=new Set(this.db.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name)),read=(table:string)=>tables.has(table)?this.rows(table).map(s=>JSON.parse(s)):[];return{purchases:read('procurement_events'),inspections:read('return_inspections'),transactions:tables.has('transaction_events')?this.db.query<{json:string},[]>("SELECT json FROM transaction_events WHERE source='csv' AND kind='returned'").all().map(r=>JSON.parse(r.json)):[]};}
 private analyze(json:string){const input=z.array(WarehouseEventSchema).min(1).max(2000).parse(JSON.parse(json)).map(e=>({...e,event_at:new Date(e.event_at).toISOString()})),stored=this.rows('warehouse_events'),refs=this.references(),map=new Map(stored.map(s=>[eventKey(JSON.parse(s)),s])),fresh:WarehouseEvent[]=[],errors:string[]=[];let duplicates=0;
  for(const e of input){if(Date.parse(e.event_at)>this.now()+300000)errors.push('库存事件时间超前');const key=eventKey(e),old=map.get(key),text=JSON.stringify(e);if(old){if(old===text)duplicates++;else errors.push('同一库存事件ID内容冲突');}else{map.set(key,text);fresh.push(e);}}
  if(map.size>50000)errors.push('库存账本达到50,000事件容量上限');try{replay([...map.values()].map(s=>JSON.parse(s)),refs);}catch(e){errors.push(e instanceof Error?e.message:'库存链无效');}
  return{hash:hash(JSON.stringify({json,stored,refs})),canImport:errors.length===0,newEvents:fresh.length,duplicates,errors,sample:input.slice(0,20),fresh};
 }
 preview(json:string):WarehousePreview{return this.db.transaction(()=>{const {fresh,...v}=this.analyze(json);return v;})();}
 import(json:string,previewHash:string):WarehouseReceipt{return this.db.transaction(()=>{const id='warehouse-'+hash(json),old=this.db.query<{json:string},[string]>('SELECT json FROM warehouse_receipts WHERE id=?').get(id);if(old)return{...JSON.parse(old.json) as WarehouseReceipt,replayed:true};const v=this.analyze(json);if(v.hash!==previewHash)throw Error('库存或来源证据已变化，请重新预览');if(!v.canImport)throw Error(v.errors.join('；'));for(const e of v.fresh)this.db.query('INSERT INTO warehouse_events VALUES(?,?)').run(eventKey(e),JSON.stringify(e));const receipt:WarehouseReceipt={id,at:this.now(),accepted:v.newEvents,duplicates:v.duplicates,authority:'operator_declared'};this.db.query('INSERT INTO warehouse_receipts VALUES(?,?)').run(id,JSON.stringify(receipt));return receipt;}).immediate();}
 view(input:WarehouseQuery):WarehouseView {
  const q=WarehouseQuerySchema.parse(input);if(q.asOf>day(this.now()))throw Error('不能查询未来库存');
  return this.db.transaction(()=>{
   const events=this.rows('warehouse_events').map(s=>JSON.parse(s) as WarehouseEvent).filter(e=>day(Date.parse(e.event_at))<=q.asOf),v=replay(events,this.references());
   const match=(s:{sourceId:string;shop:string})=>(!q.sourceId||s.sourceId===q.sourceId)&&(!q.shop||s.shop===q.shop);
   const lines=v.stocks.filter(l=>match(l)&&(!q.warehouse||l.warehouse===q.warehouse));
   for(const l of lines)l.available=l.state!=='sellable'?0:l.expiresOn===null?l.quantity===0?0:null:l.expiresOn<q.asOf?0:l.quantity-l.reserved;
   const sum=(state:WarehouseLine['state'])=>lines.filter(l=>l.state===state).reduce((n,l)=>n+l.quantity,0);
   const transfers=v.transfers.filter(t=>match(t)&&(!q.warehouse||t.from===q.warehouse||t.to===q.warehouse));
   const reservations=v.reservations.filter(r=>match(r)&&(!q.warehouse||r.warehouse===q.warehouse));
   const scopedEvents=events.filter(e=>(!q.sourceId||e.source_id===q.sourceId)&&(!q.shop||e.shop_id===q.shop)&&(!q.warehouse||e.warehouse_id===q.warehouse)).sort((a,b)=>Date.parse(b.event_at)-Date.parse(a.event_at)||b.event_id.localeCompare(a.event_id));
   return {query:q,authority:'operator_declared' as const,totalLines:lines.length,lines:lines.slice(0,100),eventCount:scopedEvents.length,recentEvents:scopedEvents.slice(0,30),totals:{sellableRecorded:sum('sellable'),reserved:lines.reduce((n,l)=>n+l.reserved,0),quarantined:sum('quarantine'),scrap:sum('scrap'),available:lines.some(l=>l.available===null)?null:lines.reduce((n,l)=>n+l.available!,0),unknownExpiryLines:lines.filter(l=>l.state==='sellable'&&l.quantity>0&&l.expiresOn===null).length,expiredRecorded:lines.filter(l=>l.state==='sellable'&&l.expiresOn!==null&&l.expiresOn<q.asOf).reduce((n,l)=>n+l.quantity,0),inTransit:transfers.reduce((n,t)=>n+t.pending,0)},totalReservations:reservations.length,reservations:reservations.slice(0,100),transfers:transfers.slice(0,100),recentWorkspaceReceipts:this.rows('warehouse_receipts').slice(-20).reverse().map(s=>JSON.parse(s))};
  })();
 }
}
