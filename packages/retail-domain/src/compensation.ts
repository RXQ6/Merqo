import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { SimulationLedger, requireExecutor } from './simulation';
import type { SimulationState, SimulationExecutor, ExecutionJob, ExecutionReceipt } from './simulation';
import type { SimulationApprover } from './approval-types';
import type { DraftEvidence } from './decisions';
import { calculate } from './operations';

const POLICY='merqo-simulation-compensation-v1';
const digest=(x:unknown):string=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export interface CompensationRequest {
 id:string;version:number;workspaceId:string;sourceJobId:string;sourceReceiptId:string;sourceReceiptHash:string;
 scenario:ExecutionJob['scenario'];scope:ExecutionJob['scope'];resourceKey:string;before:SimulationState|null;target:Record<string,number>;
 evidence:{id:string;hash:string;ruleVersion:string;importedAt:string}|null;policyVersion:string;reason:string;createdAt:string;expiresAt:string;actionHash:string;
}
export interface CompensationResolution {id:string;compensationId:string;version:number;actionHash:string;choice:'approve'|'reject';reason:string;at:string;actor:SimulationApprover}
export interface CompensationReceipt {id:string;compensationId:string;version:number;actionHash:string;sourceJobId:string;sourceReceiptId:string;resolutionId:string;localRequestId:string;at:string;actor:SimulationExecutor;before:SimulationState;after:SimulationState}
export interface CompensationCheck {id:number;at:string;matched:boolean;differences:string[];actual:SimulationState|null;actor:SimulationExecutor}
export interface CompensationEvent {id:number;version:number;at:string;event:string;reason:string;actor:string}
export interface CompensationAttempt {id:number;version:number;at:string;status:'succeeded'|'failed';reason:string;actor:SimulationExecutor}
export type CompensationStatus='pending'|'blocked'|'approved'|'rejected'|'expired'|'invalidated'|'superseded'|'completed';
interface VersionView {request:CompensationRequest;status:CompensationStatus;blockers:string[];resolution:CompensationResolution|null;receipt:CompensationReceipt|null}
export interface CompensationView extends VersionView {attempts:CompensationAttempt[];checks:CompensationCheck[];audit:CompensationEvent[];history:VersionView[]}
interface JsonRow{json:string}
interface Invalidation{status:'expired'|'invalidated';reasons:string[];at:string}
const actionHash=(r:CompensationRequest):string=>digest({...r,actionHash:''});
export function installCompensationSchema(db:Database):void {
 db.exec(`CREATE TABLE IF NOT EXISTS compensation_heads(id TEXT PRIMARY KEY,source_job_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS compensation_recent ON compensation_heads(json_extract(json,'$.createdAt'));
 CREATE TABLE IF NOT EXISTS compensation_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
 CREATE TABLE IF NOT EXISTS compensation_resolutions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
 CREATE TABLE IF NOT EXISTS compensation_invalidations(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
 CREATE TABLE IF NOT EXISTS compensation_receipts(id TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE TABLE IF NOT EXISTS compensation_attempts(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS compensation_attempts_request ON compensation_attempts(id,seq);
 CREATE TABLE IF NOT EXISTS compensation_checks(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS compensation_checks_request ON compensation_checks(id,seq);
 CREATE TABLE IF NOT EXISTS compensation_events(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
 CREATE INDEX IF NOT EXISTS compensation_events_request ON compensation_events(id,seq);`);
}
/** Owner provides an IMMEDIATE transaction, trusted Workspace, and fresh attached source reads. */
export class CompensationLedger {
 private simulation:SimulationLedger;
 constructor(private db:Database,private workspaceId:string,private current:()=>DraftEvidence[]){this.simulation=new SimulationLedger(db,workspaceId);}
 private parse<T>(row:JsonRow|null):T|null{return row?JSON.parse(row.json) as T:null;}
 private head(id:string):CompensationRequest{const r=this.parse<CompensationRequest>(this.db.query<JsonRow,[string]>('SELECT json FROM compensation_heads WHERE id=?').get(id));if(!r||r.workspaceId!==this.workspaceId)throw new Error('补偿申请不存在或不属于当前工作空间');return r;}
 private event(id:string,event:string,reason:string,actor:string):void{this.db.query('INSERT INTO compensation_events(id,json) VALUES(?,?)').run(id,JSON.stringify({version:this.head(id).version,at:new Date().toISOString(),event,reason,actor}));}
 private origin(jobId:string):{job:ExecutionJob;receipt:ExecutionReceipt}{const view=this.simulation.view(jobId);if(!view.receipt)throw new Error('没有成功执行回执，不能申请补偿');return{job:view.job,receipt:view.receipt};}
 private evidence(job:ExecutionJob):DraftEvidence|null{return this.current().find(e=>e.source==='demo'&&e.row.shop_id===job.scope.shop&&e.row.channel===job.scope.channel&&e.row.sku_id===job.scope.sku&&e.row.date===job.scope.date&&(job.scenario==='margin'?!('metrics'in e):'kind'in e&&e.kind===job.scenario&&(job.scenario==='inventory'?'warehouse_id'in e.row&&e.row.warehouse_id===job.scope.warehouse:'campaign_id'in e.row&&e.row.campaign_id===job.scope.campaign)))??null;}
 private capture(job:ExecutionJob):CompensationRequest['evidence']{const e=this.evidence(job);return e?{id:e.id,hash:digest(e),ruleVersion:e.ruleVersion,importedAt:e.importedAt}:null;}
 private reason(value:string):string{value=value.trim();if(!value||value.length>2000)throw new Error('请填写1至2000字的理由');return value;}
 create(jobId:string,reason:string):CompensationView{
  reason=this.reason(reason);const origin=this.origin(jobId);const found=this.db.query<{id:string},[string]>('SELECT id FROM compensation_heads WHERE source_job_id=?').get(jobId);if(found)return this.view(found.id);
  const now=new Date().toISOString();const r:CompensationRequest={id:randomUUID(),version:1,workspaceId:this.workspaceId,sourceJobId:jobId,sourceReceiptId:origin.receipt.id,sourceReceiptHash:digest(origin.receipt),scenario:origin.job.scenario,scope:origin.job.scope,resourceKey:origin.job.resourceKey,before:this.simulation.state(origin.job.resourceKey),target:origin.receipt.before.values,evidence:this.capture(origin.job),policyVersion:POLICY,reason,createdAt:now,expiresAt:new Date(Date.now()+1800000).toISOString(),actionHash:''};r.actionHash=actionHash(r);this.save(r);this.event(r.id,'created',reason,'local-analyst');return this.view(r.id);
 }
 private save(r:CompensationRequest):void{this.db.query('INSERT INTO compensation_heads VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(r.id,r.sourceJobId,JSON.stringify(r));this.db.query('INSERT INTO compensation_versions VALUES(?,?,?)').run(r.id,r.version,JSON.stringify(r));}
 revise(id:string,expectedVersion:number,reason:string):CompensationView{
  const prior=this.head(id);if(prior.version!==expectedVersion)throw new Error('补偿申请版本冲突，请刷新');if(this.receipt(id))throw new Error('补偿已经完成，不能重新申请或再次执行');reason=this.reason(reason);const origin=this.origin(prior.sourceJobId);
  const r={...prior,version:prior.version+1,before:this.simulation.state(prior.resourceKey),evidence:this.capture(origin.job),reason,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1800000).toISOString(),actionHash:''};r.actionHash=actionHash(r);this.save(r);this.event(id,'revised',reason,'local-analyst');return this.view(id);
 }
 private receipt(id:string):CompensationReceipt|null{return this.parse(this.db.query<JsonRow,[string]>('SELECT json FROM compensation_receipts WHERE id=?').get(id));}
 private blockers(r:CompensationRequest):string[]{
  const reasons:string[]=[];let origin:ReturnType<CompensationLedger['origin']>;try{origin=this.origin(r.sourceJobId);}catch{return ['原执行回执无法核验'];}
  if(r.policyVersion!==POLICY||r.actionHash!==actionHash(r)||r.workspaceId!==this.workspaceId||r.scope.source!=='demo'||r.sourceReceiptId!==origin.receipt.id||r.sourceReceiptHash!==digest(origin.receipt)||r.resourceKey!==origin.job.resourceKey||r.scenario!==origin.job.scenario||JSON.stringify(r.scope)!==JSON.stringify(origin.job.scope)||JSON.stringify(r.target)!==JSON.stringify(origin.receipt.before.values))reasons.push('补偿动作、原回执或策略绑定不一致');
  const now=Date.now();if(!Number.isFinite(Date.parse(r.expiresAt))||now>=Date.parse(r.expiresAt))reasons.push('补偿申请30分钟有效期已过，请重新申请');
  const state=this.simulation.state(origin.job.resourceKey);
  if(!state||!r.before||digest(state)!==digest(r.before)||digest(r.before)!==digest(origin.receipt.after))reasons.push('模拟目标已被后续动作修改或状态不明，不能覆盖；请人工核查');
  const e=this.evidence(origin.job);if(!e||!r.evidence||JSON.stringify(this.capture(origin.job))!==JSON.stringify(r.evidence))reasons.push('当前演示证据或规则已变化，请重新申请并核验');
  if(e){const age=now-Date.parse(e.importedAt);if(!Number.isFinite(age)||age>86400000||age < -300000)reasons.push('演示证据导入超过24小时或时间异常');
   if(r.scenario==='margin'){
    if('metrics'in e)reasons.push('毛利证据类型不符');else{const coupon=r.target.couponMinor;if(coupon===undefined||!Number.isSafeInteger(coupon)||coupon<0)reasons.push('恢复商家券参数无效');else{const calc=calculate({...e.row,coupon_minor:coupon},e.calculation.issues.includes('同店铺同渠道 SKU 出现多种规格，须人工核对映射'));if(calc.issues.length)reasons.push(...calc.issues);if(calc.marginBps===null||calc.marginBps<e.thresholdBps)reasons.push('恢复原商家券会低于当前毛利下限，补偿不能绕过硬约束；请人工制定新方案');}}
   }else if('metrics'in e&&e.metrics.issues.length)reasons.push(...e.metrics.issues);
  }
  if(r.scenario==='inventory'&&(state?.purchaseRequestStatus==='accepted'||state?.purchaseRequestStatus==='cancelled'||(state?.purchaseRequestStatus!==undefined&&state.purchaseRequestStatus!=='pending')))reasons.push('补货请求已受理、取消或状态不明，不能直接取消；请人工处理');
  return [...new Set(reasons)];
 }
 private version(r:CompensationRequest):VersionView{
  const latest=this.head(r.id);const resolution=this.parse<CompensationResolution>(this.db.query<JsonRow,[string,number]>('SELECT json FROM compensation_resolutions WHERE id=? AND version=?').get(r.id,r.version));const receipt=this.receipt(r.id);
  if(receipt?.version===r.version)return{request:r,status:'completed',blockers:[],resolution,receipt};
  if(latest.version!==r.version)return{request:r,status:'superseded',blockers:['已保存新版本，旧补偿授权失效'],resolution,receipt:null};
  let blockers=this.blockers(r);let invalid=this.parse<Invalidation>(this.db.query<JsonRow,[string,number]>('SELECT json FROM compensation_invalidations WHERE id=? AND version=?').get(r.id,r.version));
  if(resolution&&(resolution.compensationId!==r.id||resolution.version!==r.version||resolution.actionHash!==r.actionHash))blockers.push('补偿审批结论绑定不一致');
  if(blockers.length&&!invalid){invalid={status:Date.now()>=Date.parse(r.expiresAt)?'expired':'invalidated',reasons:blockers,at:new Date().toISOString()};this.db.query('INSERT INTO compensation_invalidations VALUES(?,?,?)').run(r.id,r.version,JSON.stringify(invalid));this.event(r.id,'invalidated',blockers.join('；'),'system-policy');}
  if(invalid)blockers=[...new Set([...invalid.reasons,...blockers])];
  return{request:r,status:invalid?.status??(resolution?.choice==='reject'?'rejected':resolution?.choice==='approve'?'approved':blockers.length?'blocked':'pending'),blockers,resolution,receipt:null};
 }
 view(id:string):CompensationView{
  const head=this.head(id);const version=this.version(head);
  const rows=<T>(table:'compensation_attempts'|'compensation_checks'|'compensation_events',limit:number):T[]=>this.db.query<{seq:number;json:string},[string]>(`SELECT seq,json FROM ${table} WHERE id=? ORDER BY seq DESC LIMIT ${limit}`).all(id).map(r=>({...JSON.parse(r.json) as T,id:r.seq}));
  return{...version,attempts:rows<CompensationAttempt>('compensation_attempts',50),checks:rows<CompensationCheck>('compensation_checks',20),audit:rows<CompensationEvent>('compensation_events',100),history:this.db.query<JsonRow,[string]>('SELECT json FROM compensation_versions WHERE id=? ORDER BY version DESC LIMIT 30').all(id).map(row=>this.version(JSON.parse(row.json) as CompensationRequest))};
 }
 list():CompensationView[]{return this.db.query<{id:string},[]>("SELECT id FROM compensation_heads ORDER BY json_extract(json,'$.createdAt') DESC,rowid DESC LIMIT 100").all().map(r=>this.view(r.id));}
 resolve(id:string,version:number,expectedHash:string,choice:'approve'|'reject',reason:string,actor:SimulationApprover|null):{view:CompensationView;error:string|null}{
  if(actor?.id!=='local-simulation-approver'||actor.role!=='approver'||actor.environment!=='simulation')throw new Error('缺少服务端模拟审批角色');if(choice!=='approve'&&choice!=='reject')throw new Error('未知补偿审批选择');reason=this.reason(reason);
  const view=this.view(id);const r=view.request;if(r.version!==version||r.actionHash!==expectedHash)return{view,error:'补偿审批版本或动作摘要不匹配，请刷新'};
  if(view.resolution)return{view,error:view.resolution.choice===choice&&view.resolution.reason===reason?null:'该版本已有审批结论，不能覆盖，请重新申请'};
  if(view.status!=='pending'||view.blockers.length)return{view,error:'不能处理补偿审批：'+(view.blockers.join('；')||view.status)};
  const resolution:CompensationResolution={id:randomUUID(),compensationId:id,version,actionHash:r.actionHash,choice,reason,at:new Date().toISOString(),actor};this.db.query('INSERT INTO compensation_resolutions VALUES(?,?,?)').run(id,version,JSON.stringify(resolution));this.event(id,choice==='approve'?'approved':'rejected',reason,actor.id);return{view:this.view(id),error:null};
 }
 execute(id:string,version:number,expectedHash:string,actor:SimulationExecutor|null):CompensationView{
  requireExecutor(actor);const r=this.head(id);if(r.version!==version||r.actionHash!==expectedHash)throw new Error('补偿执行版本或动作摘要不匹配');const view=this.view(id);if(view.receipt)return view;
  const attempt=(status:CompensationAttempt['status'],reason:string):void=>{this.db.query('INSERT INTO compensation_attempts(id,json) VALUES(?,?)').run(id,JSON.stringify({version,at:new Date().toISOString(),status,reason,actor}));};
  if(view.status!=='approved'||!view.resolution||view.blockers.length){attempt('failed','补偿执行前检查失败：'+(view.blockers.join('；')||view.status));return this.view(id);}
  this.db.exec('SAVEPOINT compensation_effect');try{
   const before=this.simulation.state(r.resourceKey);if(!before||digest(before)!==digest(r.before))throw new Error('补偿目标版本冲突');const after:SimulationState={...before,version:before.version+1,values:r.target,updatedAt:new Date().toISOString(),...(r.scenario==='inventory'?{purchaseRequestStatus:'cancelled' as const}:{})};
   this.db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify(after),r.resourceKey);
   const receipt:CompensationReceipt={id:randomUUID(),compensationId:id,version,actionHash:r.actionHash,sourceJobId:r.sourceJobId,sourceReceiptId:r.sourceReceiptId,resolutionId:view.resolution.id,localRequestId:'sim-comp-'+id+'-v'+version,at:after.updatedAt,actor,before,after};this.db.query('INSERT INTO compensation_receipts VALUES(?,?,?)').run(id,version,JSON.stringify(receipt));attempt('succeeded','补偿与回执已原子保存');this.event(id,'completed','本地模拟补偿完成',actor.id);const checked=this.reconcile(id,actor);if(!checked.checks[0]?.matched)throw new Error('补偿后回读不一致，已回滚模拟状态');this.db.exec('RELEASE compensation_effect');
  }catch(error){this.db.exec('ROLLBACK TO compensation_effect; RELEASE compensation_effect');attempt('failed',error instanceof Error?error.message:'补偿失败，模拟副作用已回滚');}
  return this.view(id);
 }
 reconcile(id:string,actor:SimulationExecutor|null):CompensationView{
  requireExecutor(actor);const r=this.head(id);const receipt=this.receipt(id);if(!receipt)throw new Error('尚无成功补偿回执');const actual=this.simulation.state(r.resourceKey);const differences=digest(actual)===digest(receipt.after)?[]:['当前模拟版本或值与补偿回执不同，请人工核查，不能重复覆盖'];this.db.query('INSERT INTO compensation_checks(id,json) VALUES(?,?)').run(id,JSON.stringify({at:new Date().toISOString(),matched:!differences.length,differences,actual,actor}));return this.view(id);
 }
}
