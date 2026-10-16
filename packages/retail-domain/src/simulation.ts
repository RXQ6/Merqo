import type { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalResolution } from './approval-types';
import type { DecisionDraft } from './decisions';

export interface SimulationExecutor { id: 'local-simulation-executor'; role: 'executor'; environment: 'simulation' }
export interface SimulationState { resourceKey: string; version: number; evidenceHash: string; values: Record<string, number>; updatedAt: string }
export interface ExecutionJob {
  id: string; workspaceId: string; requestId: string; resolutionId: string; decisionId: string; decisionVersion: number;
  actionHash: string; evidenceHash: string; reportHash: string; policyVersion: string; expiresAt: string;
  scenario: DecisionDraft['scenario']; scope: DecisionDraft['scope']; resourceKey: string; expectedStateVersion: number; expectedStateHash: string | null;
  expectedBefore: Record<string, number>; expectedAfter: Record<string, number>; createdAt: string; explanation: string;
}
export interface ExecutionAttempt { id: number; jobId: string; at: string; status: 'failed' | 'succeeded'; reason: string; actor: SimulationExecutor }
export interface ExecutionReceipt { id: string; jobId: string; requestId: string; resolutionId: string; actionHash: string; evidenceHash: string; reportHash: string; decisionVersion: number; localRequestId: string; at: string; actor: SimulationExecutor; before: SimulationState; after: SimulationState }
export interface Reconciliation { id: number; jobId: string; at: string; matched: boolean; differences: string[]; actual: SimulationState | null; receiptId: string; actor: SimulationExecutor }
export interface ExecutionView { blockers: string[]; job: ExecutionJob; status: 'ready' | 'failed' | 'succeeded'; attempts: ExecutionAttempt[]; receipt: ExecutionReceipt | null; reconciliation: Reconciliation | null; current: SimulationState | null }
interface JsonRow { json: string }
const hash = (x: unknown): string => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function installSimulationSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS simulation_jobs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS simulation_jobs_recent ON simulation_jobs(json_extract(json,'$.createdAt'));
    CREATE TABLE IF NOT EXISTS simulation_states(resource_key TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE TABLE IF NOT EXISTS simulation_receipts(job_id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE TABLE IF NOT EXISTS simulation_attempts(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS simulation_attempts_job ON simulation_attempts(job_id,id);
    CREATE TABLE IF NOT EXISTS simulation_reconciliations(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
    CREATE INDEX IF NOT EXISTS simulation_checks_job ON simulation_reconciliations(job_id,id);`);
}
export function requireExecutor(actor: SimulationExecutor | null): asserts actor is SimulationExecutor {
  if (actor?.id !== 'local-simulation-executor' || actor.role !== 'executor' || actor.environment !== 'simulation') throw new Error('缺少服务端模拟执行角色');
}
/** All methods run inside the owning DecisionStore IMMEDIATE transaction. No external writes. */
export class SimulationLedger {
  constructor(private readonly db: Database, private readonly workspaceId: string) {}
  private parse<T>(row: JsonRow | null): T | null { return row ? JSON.parse(row.json) as T : null; }
  state(key: string): SimulationState | null { return this.parse(this.db.query<JsonRow, [string]>('SELECT json FROM simulation_states WHERE resource_key=?').get(key)); }
  job(id: string): ExecutionJob {
    const job = this.parse<ExecutionJob>(this.db.query<JsonRow, [string]>('SELECT json FROM simulation_jobs WHERE id=?').get(id));
    if (!job || job.workspaceId !== this.workspaceId) throw new Error('执行项不存在或不属于当前工作空间');
    return job;
  }
  private resource(d:DecisionDraft):string { return hash({workspace:this.workspaceId,scenario:d.scenario,source:d.scope.source,shop:d.scope.shop,channel:d.scope.channel,sku:d.scope.sku,warehouse:d.scope.warehouse,campaign:d.scope.campaign}); }
  private parameters(d: DecisionDraft): {before:Record<string,number>;after:Record<string,number>;explanation:string} {
    const pair = d.scenario === 'margin' ? {before:{couponMinor:d.before.couponMinor},after:{couponMinor:d.after.couponMinor},explanation:'仅调整模拟商家券，原经营快照不变。'}
      : d.scenario === 'ads' ? {before:{budgetMinor:d.before.spendMinor},after:{budgetMinor:d.after.spendMinor},explanation:'历史花费仅作为模拟预算初值，不代表平台真实预算，也不预测收入变化。'}
      : {before:{pendingPurchaseQuantity:0,leadDays:0},after:{pendingPurchaseQuantity:d.after.proposedQuantity,leadDays:d.after.leadDays},explanation:'仅创建模拟补货请求，待受理数量不计入现存、在途或立即可售库存。'};
    const checked=(values:Record<string,number|null|undefined>):Record<string,number>=>{const result:Record<string,number>={};for(const [key,value] of Object.entries(values)){if(value===null||value===undefined||!Number.isSafeInteger(value)||value<0)throw new Error('模拟动作缺少有效整数参数');result[key]=value;}return result;};
    return {before:checked(pair.before),after:checked(pair.after),explanation:pair.explanation};
  }
  assertBinding(job:ExecutionJob,d:DecisionDraft,resolution:ApprovalResolution):void {
    const pair=this.parameters(d);
    if(job.resourceKey!==this.resource(d)||JSON.stringify(pair.before)!==JSON.stringify(job.expectedBefore)||JSON.stringify(pair.after)!==JSON.stringify(job.expectedAfter)||job.scope.source!=='demo'||JSON.stringify(job.scope)!==JSON.stringify(d.scope)||job.scenario!==d.scenario||job.id!==hash({workspace:this.workspaceId,request:resolution.requestId,resolution:resolution.id,action:d.actionHash}))throw new Error('执行参数或范围与批准动作不一致');
  }
  queue(d: DecisionDraft, resolution: ApprovalResolution, legacy = false): string {
    const existing = this.db.query<{id: string}, [string]>('SELECT id FROM simulation_jobs WHERE request_id=?').get(resolution.requestId);
    if (existing) return existing.id;
    const resourceKey=this.resource(d);const state=legacy?null:this.state(resourceKey);
    const pair=this.parameters(d);
    const id = hash({workspace: this.workspaceId, request: resolution.requestId, resolution: resolution.id, action: d.actionHash});
    const job: ExecutionJob = {id, workspaceId: this.workspaceId, requestId: resolution.requestId, resolutionId: resolution.id, decisionId: d.id, decisionVersion: d.version, actionHash: d.actionHash, evidenceHash: d.evidenceHash, reportHash: d.reportHash, policyVersion: d.policyVersion, expiresAt: d.expiresAt, scenario: d.scenario, scope: d.scope, resourceKey, expectedStateVersion: state?.version ?? 0, expectedStateHash:state?hash(state):null, expectedBefore: pair.before, expectedAfter: pair.after, createdAt: resolution.resolvedAt, explanation: pair.explanation};
    this.db.query('INSERT INTO simulation_jobs VALUES(?,?,?)').run(id, resolution.requestId, JSON.stringify(job));
    return id;
  }
  view(id: string): ExecutionView {
    const job = this.job(id);
    const receipt = this.parse<ExecutionReceipt>(this.db.query<JsonRow, [string]>('SELECT json FROM simulation_receipts WHERE job_id=?').get(id));
    const attempts = this.db.query<{id:number;json:string}, [string]>('SELECT id,json FROM simulation_attempts WHERE job_id=? ORDER BY id DESC LIMIT 50').all(id).map(r=>({...JSON.parse(r.json) as ExecutionAttempt,id:r.id}));
    const check = this.db.query<{id:number;json:string}, [string]>('SELECT id,json FROM simulation_reconciliations WHERE job_id=? ORDER BY id DESC LIMIT 1').get(id);
    return {blockers:[],job,status:receipt?'succeeded':attempts.length?'failed':'ready',receipt,attempts,reconciliation:check?{...JSON.parse(check.json) as Reconciliation,id:check.id}:null,current:this.state(job.resourceKey)};
  }
  list(): ExecutionView[] { return this.db.query<{id:string}, []>("SELECT id FROM simulation_jobs ORDER BY json_extract(json,'$.createdAt') DESC,rowid DESC LIMIT 100").all().map(r=>this.view(r.id)); }
  private attempt(id: string, status: ExecutionAttempt['status'], reason: string, actor: SimulationExecutor): void {
    this.db.query('INSERT INTO simulation_attempts(job_id,json) VALUES(?,?)').run(id,JSON.stringify({jobId:id,at:new Date().toISOString(),status,reason,actor}));
  }
  fail(id: string, reason: string, actor: SimulationExecutor): ExecutionView { this.job(id); this.attempt(id,'failed',reason,actor); return this.view(id); }
  targetConflict(job:ExecutionJob):string|null {
    const stored=this.state(job.resourceKey);
    if((stored?.version??0)!==job.expectedStateVersion||(stored?hash(stored):null)!==job.expectedStateHash||(stored&&JSON.stringify(stored.values)!==JSON.stringify(job.expectedBefore)))return '模拟目标版本或前值冲突，旧批准不能覆盖当前状态；请重新调查并审批';
    return null;
  }
  execute(id: string, actor: SimulationExecutor): ExecutionView {
    const job=this.job(id); const existing=this.view(id); if(existing.receipt)return existing;
    this.db.exec('SAVEPOINT simulation_effect');
    try {
      const stored=this.state(job.resourceKey);
      const before: SimulationState=stored??{resourceKey:job.resourceKey,version:0,evidenceHash:job.evidenceHash,values:job.expectedBefore,updatedAt:job.createdAt};
      if(before.version!==job.expectedStateVersion||(stored?hash(stored):null)!==job.expectedStateHash||JSON.stringify(before.values)!==JSON.stringify(job.expectedBefore)) throw new Error('模拟目标版本或前值冲突，未写入；请重新调查并核对当前模拟状态');
      const after: SimulationState={...before,evidenceHash:job.evidenceHash,version:before.version+1,values:job.expectedAfter,updatedAt:new Date().toISOString()};
      this.db.query('INSERT INTO simulation_states VALUES(?,?) ON CONFLICT(resource_key) DO UPDATE SET json=excluded.json').run(job.resourceKey,JSON.stringify(after));
      const receipt: ExecutionReceipt={id:randomUUID(),jobId:id,requestId:job.requestId,resolutionId:job.resolutionId,actionHash:job.actionHash,evidenceHash:job.evidenceHash,reportHash:job.reportHash,decisionVersion:job.decisionVersion,localRequestId:'sim-'+id,at:after.updatedAt,actor,before,after};
      this.db.query('INSERT INTO simulation_receipts VALUES(?,?)').run(id,JSON.stringify(receipt));
      this.attempt(id,'succeeded','本地模拟状态和成功回执已原子提交',actor);
      this.reconcile(id,actor);
      this.db.exec('RELEASE simulation_effect');
    } catch(error) {
      this.db.exec('ROLLBACK TO simulation_effect; RELEASE simulation_effect');
      this.attempt(id,'failed',error instanceof Error?error.message:'本地模拟写入失败，副作用已回滚',actor);
    }
    return this.view(id);
  }
  reconcile(id: string, actor: SimulationExecutor): ExecutionView {
    const view=this.view(id);if(!view.receipt)throw new Error('尚无成功回执，不能核对执行结果');
    const actual=this.state(view.job.resourceKey);const expected=view.receipt.after;
    const differences:string[]=[];
    if(!actual)differences.push('模拟目标状态不存在');
    else {if(actual.version!==expected.version)differences.push('目标版本与回执不一致');if(actual.evidenceHash!==expected.evidenceHash)differences.push('来源证据摘要与回执不一致');for(const key of new Set([...Object.keys(expected.values),...Object.keys(actual.values)]))if(actual.values[key]!==expected.values[key])differences.push(key+' 与回执不一致');}
    this.db.query('INSERT INTO simulation_reconciliations(job_id,json) VALUES(?,?)').run(id,JSON.stringify({jobId:id,at:new Date().toISOString(),matched:differences.length===0,differences,actual,receiptId:view.receipt.id,actor}));
    return this.view(id);
  }
}
