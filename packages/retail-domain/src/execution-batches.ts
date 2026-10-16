import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { SimulationLedger, requireExecutor } from './simulation';
import type { ExecutionJob, ExecutionView, SimulationExecutor, ExecutionReceipt } from './simulation';
const hash=(x:unknown):string=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const LEASE_MS=15000;
export interface BatchItem {jobId:string;version:number;actionHash:string;resolutionId:string;requestId:string;position:number}
export interface ExecutionBatch {id:string;workspaceId:string;reason:string;createdAt:string;shop:string;channel:string;items:BatchItem[];hash:string;transport:'local_atomic'}
export type DispatchStatus='ready'|'running'|'unknown'|'failed'|'succeeded';
export interface Dispatch {status:DispatchStatus;token:string|null;leaseUntil:string|null;attemptBase:number;receiptId:string|null;reason:string}
export interface BatchEvent {id:number;jobId:string;event:string;at:string;reason:string;actor:string}
export interface BatchItemView {item:BatchItem;job:ExecutionJob;dispatch:Dispatch;receipt:ExecutionReceipt|null;blockers:string[]}
export interface BatchView {batch:ExecutionBatch;status:'ready'|'running'|'unknown'|'partial'|'failed'|'succeeded';items:BatchItemView[];events:BatchEvent[]}
export interface BatchLease {batchId:string;jobId:string;token:string}
interface JsonRow{json:string}
export function installBatchSchema(db:Database):void{
 db.exec(`CREATE TABLE IF NOT EXISTS execution_batches(id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS execution_batches_recent ON execution_batches(json_extract(json,'$.createdAt'));
 CREATE TABLE IF NOT EXISTS execution_batch_items(batch_id TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(batch_id,job_id)) STRICT;
 CREATE TABLE IF NOT EXISTS execution_dispatches(job_id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE TABLE IF NOT EXISTS execution_batch_events(seq INTEGER PRIMARY KEY,batch_id TEXT NOT NULL,job_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS execution_batch_events_run ON execution_batch_events(batch_id,seq);`);
}
/** Every method is called under the owning store's IMMEDIATE transaction. */
export class ExecutionBatchLedger{
 private simulation:SimulationLedger;
 constructor(private db:Database,private workspaceId:string){this.simulation=new SimulationLedger(db,workspaceId);}
 private parse<T>(r:JsonRow|null):T|null{return r?JSON.parse(r.json) as T:null;}
 private event(batchId:string,jobId:string,event:string,reason:string,actor:string):void{this.db.query('INSERT INTO execution_batch_events(batch_id,job_id,json) VALUES(?,?,?)').run(batchId,jobId,JSON.stringify({event,reason,actor,at:new Date().toISOString()}));}
 private save(jobId:string,d:Dispatch):void{this.db.query('INSERT INTO execution_dispatches VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET json=excluded.json').run(jobId,JSON.stringify(d));}
 private dispatch(jobId:string):Dispatch{const d=this.parse<Dispatch>(this.db.query<JsonRow,[string]>('SELECT json FROM execution_dispatches WHERE job_id=?').get(jobId));if(!d)throw new Error('批次执行意图不存在');return d;}
 owner(jobId:string):string|null{return this.db.query<{batch_id:string},[string]>('SELECT batch_id FROM execution_batch_items WHERE job_id=?').get(jobId)?.batch_id??null;}
 definition(id:string):ExecutionBatch{const b=this.parse<ExecutionBatch>(this.db.query<JsonRow,[string]>('SELECT json FROM execution_batches WHERE id=?').get(id));if(!b||b.workspaceId!==this.workspaceId)throw new Error('执行批次不存在或不属于当前工作空间');if(b.transport!=='local_atomic'||b.hash!==hash({...b,hash:''}))throw new Error('批次摘要或执行协议不符，需人工核查');return b;}
 create(views:ExecutionView[],reason:string):BatchView{
  reason=reason.trim();if(!reason||reason.length>2000)throw new Error('请填写1至2000字的批次说明');if(views.length<2||views.length>10||new Set(views.map(v=>v.job.id)).size!==views.length)throw new Error('请选择2至10个不同的已批准动作');
  const owners=views.map(v=>this.owner(v.job.id));if(owners[0]&&owners.every(id=>id===owners[0])){const existing=this.definition(owners[0]);if(existing.reason===reason&&JSON.stringify(existing.items.map(i=>i.jobId))===JSON.stringify(views.map(v=>v.job.id)))return this.view(existing.id);}
  if(new Set(views.map(v=>v.job.resourceKey)).size!==views.length)throw new Error('同一模拟目标不能重复纳入独立动作批次');
  const first=views[0]!.job;for(const v of views){if(v.job.workspaceId!==this.workspaceId||v.job.scope.source!=='demo'||v.job.scope.shop!==first.scope.shop||v.job.scope.channel!==first.scope.channel)throw new Error('批次仅支持同工作空间、店铺和渠道的模拟动作');if(v.receipt||v.blockers.length)throw new Error('批次包含已成功或当前不可执行的动作');if(this.owner(v.job.id))throw new Error('动作已有执行批次，请在原批次处理');}
  const b:ExecutionBatch={id:randomUUID(),workspaceId:this.workspaceId,reason,createdAt:new Date().toISOString(),shop:first.scope.shop,channel:first.scope.channel,transport:'local_atomic',hash:'',items:views.map((v,position)=>({jobId:v.job.id,version:v.job.decisionVersion,actionHash:v.job.actionHash,resolutionId:v.job.resolutionId,requestId:v.job.requestId,position}))};b.hash=hash({...b,hash:''});this.db.query('INSERT INTO execution_batches VALUES(?,?)').run(b.id,JSON.stringify(b));
  for(const item of b.items){this.db.query('INSERT INTO execution_batch_items VALUES(?,?,?)').run(b.id,item.jobId,JSON.stringify(item));this.save(item.jobId,{status:'ready',token:null,leaseUntil:null,attemptBase:0,receiptId:null,reason:'等待人工确认执行'});}this.event(b.id,'','created',reason,'local-analyst');return this.view(b.id);
 }
 private binding(b:ExecutionBatch,item:BatchItem):ExecutionView{const v=this.simulation.view(item.jobId);const stored=this.parse<BatchItem>(this.db.query<JsonRow,[string,string]>('SELECT json FROM execution_batch_items WHERE batch_id=? AND job_id=?').get(b.id,item.jobId));if(!stored||JSON.stringify(stored)!==JSON.stringify(item)||v.job.decisionVersion!==item.version||v.job.actionHash!==item.actionHash||v.job.resolutionId!==item.resolutionId||v.job.requestId!==item.requestId||this.owner(item.jobId)!==b.id)throw new Error('批次动作版本、批准或归属绑定不一致');return v;}
 view(id:string):BatchView{
  const batch=this.definition(id);const items=batch.items.map(item=>{const v=this.binding(batch,item);let d=this.dispatch(item.jobId);if(d.status==='running'&&(!d.leaseUntil||!Number.isFinite(Date.parse(d.leaseUntil))||Date.now()>=Date.parse(d.leaseUntil))){d={...d,status:'unknown',reason:'执行租约已到期，结果待确认；必须先查询账本'};this.save(item.jobId,d);this.event(id,item.jobId,'lease_expired',d.reason,'system-policy');}return{item,job:v.job,dispatch:d,receipt:v.receipt,blockers:[]};});
  const states=items.map(v=>v.dispatch.status);const status=states.includes('unknown')?'unknown':states.includes('running')?'running':states.every(s=>s==='succeeded')?'succeeded':states.includes('succeeded')?'partial':states.every(s=>s==='failed')?'failed':'ready';
  const events=this.db.query<{seq:number;job_id:string;json:string},[string]>('SELECT seq,job_id,json FROM execution_batch_events WHERE batch_id=? ORDER BY seq DESC LIMIT 100').all(id).map(r=>({...JSON.parse(r.json) as BatchEvent,id:r.seq,jobId:r.job_id}));return{batch,status,items,events};
 }
 list():BatchView[]{return this.db.query<{id:string},[]>("SELECT id FROM execution_batches ORDER BY json_extract(json,'$.createdAt') DESC,rowid DESC LIMIT 50").all().map(r=>this.view(r.id));}
 claim(id:string,jobId:string,mode:'ready'|'failed',actor:SimulationExecutor|null):BatchLease{
  requireExecutor(actor);const view=this.view(id);if(view.items.some(v=>v.dispatch.status==='running'||v.dispatch.status==='unknown'))throw new Error('批次仍有执行中或待确认项，请先查询确认');const item=view.items.find(v=>v.item.jobId===jobId);if(!item||item.dispatch.status!==mode)throw new Error('只能继续待执行项或单独重试已确认失败项，成功项不可重放');
  const attemptBase=this.db.query<{id:number},[string]>('SELECT max(id) AS id FROM simulation_attempts WHERE job_id=?').get(jobId)?.id??0;const token=randomUUID();this.save(jobId,{...item.dispatch,status:'running',token,attemptBase,leaseUntil:new Date(Date.now()+LEASE_MS).toISOString(),reason:'已领取本地模拟执行，等待结果登记'});this.event(id,jobId,'claimed','已记录执行意图与租约',actor.id);return{batchId:id,jobId,token};
 }
 guard(lease:BatchLease):void{
  const b=this.definition(lease.batchId);const item=b.items.find(v=>v.jobId===lease.jobId);if(!item)throw new Error('执行租约不属于批次');this.binding(b,item);const d=this.dispatch(lease.jobId);if(d.status!=='running'||d.token!==lease.token||!d.leaseUntil||!Number.isFinite(Date.parse(d.leaseUntil))||Date.now()>=Date.parse(d.leaseUntil))throw new Error('执行租约已失效，旧进程不得继续写入');
 }
 private proof(id:string,item:BatchItem,d:Dispatch):Dispatch{
  const v=this.binding(this.definition(id),item);
  if(v.receipt){const r=v.receipt;if(r.jobId!==item.jobId||r.actionHash!==item.actionHash||r.decisionVersion!==item.version||r.resolutionId!==item.resolutionId||r.requestId!==item.requestId||r.evidenceHash!==v.job.evidenceHash||r.reportHash!==v.job.reportHash||r.localRequestId!=='sim-'+item.jobId) return{...d,status:'unknown',reason:'回执绑定不符，需人工核查'};return{...d,status:'succeeded',token:null,leaseUntil:null,receiptId:r.id,reason:'已从唯一回执确认历史成功，不会重复执行'};}
  const failure=this.db.query<{id:number;json:string},[string,number]>('SELECT id,json FROM simulation_attempts WHERE job_id=? AND id>? ORDER BY id DESC LIMIT 1').get(item.jobId,d.attemptBase);
  if(failure){const attempt=JSON.parse(failure.json) as {status:string;reason:string};if(attempt.status==='failed')return{...d,status:'failed',token:null,leaseUntil:null,reason:attempt.reason};return{...d,status:'unknown',reason:'存在无回执的非失败记录，结果不一致，需人工核查'};}
  return{...d,status:'ready',token:null,leaseUntil:null,reason:'本地原子账本无成功回执，旧租约已冻结，已确认未执行；可人工继续'};
 }
 settle(lease:BatchLease,actor:SimulationExecutor|null):BatchView{
  requireExecutor(actor);const b=this.definition(lease.batchId);const item=b.items.find(v=>v.jobId===lease.jobId);if(!item)throw new Error('执行项不属于批次');const d=this.dispatch(item.jobId);if(d.token!==lease.token)throw new Error('执行结果登记租约已被替代');let result=this.proof(b.id,item,d);if(result.status==='ready')result={...d,status:'unknown',reason:'执行返回但缺少结果证明，必须先查询确认'};this.save(item.jobId,result);this.event(b.id,item.jobId,result.status,result.reason,actor.id);return this.view(b.id);
 }
 recover(id:string,actor:SimulationExecutor|null):BatchView{
  requireExecutor(actor);const view=this.view(id);for(const v of view.items){if(v.dispatch.status!=='unknown'&&v.dispatch.status!=='running')continue;if(v.dispatch.status==='running'&&v.dispatch.leaseUntil&&Date.now()<Date.parse(v.dispatch.leaseUntil))throw new Error('执行租约仍有效，稍后刷新再查询，不得抢占');const result=this.proof(id,v.item,v.dispatch);this.save(v.item.jobId,{...result,token:result.status==='unknown'?v.dispatch.token:null});this.event(id,v.item.jobId,'recovered_'+result.status,result.reason,actor.id);}return this.view(id);
 }
}
