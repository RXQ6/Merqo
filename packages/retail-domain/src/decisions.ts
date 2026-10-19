import {PolicyStore,readBusinessPolicy} from './policy-store';
import {freezePolicy} from './business-policy';
import { evidenceTimeIssue, evidenceTimeContext } from './evidence-policy';
import { ReviewLedger, installReviewSchema } from './outcome-reviews';
import type { ReviewView, ObservationPreview, CaseMemory } from './outcome-reviews';
import { ExecutionBatchLedger, installBatchSchema } from './execution-batches';
import type { BatchView, BatchLease } from './execution-batches';
import { CompensationLedger, installCompensationSchema } from './compensation';
import type { CompensationView } from './compensation';
import { Database } from 'bun:sqlite';
import { SimulationLedger, installSimulationSchema, requireExecutor } from './simulation';
import type { ExecutionView, SimulationExecutor } from './simulation';
import { createHash, randomUUID } from 'node:crypto';
import type { ApprovalStatus, ApprovalResolution, ApprovalInvalidation, ApprovalView, ApprovalAudit, SimulationApprover } from './approval-types';
import { simulate, isSignalInvestigation } from './investigations';
import { simulateSignal } from './signal-investigations';
import type { AnyInvestigation, Scenario } from './investigations';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
export type DraftEvidence = EvidenceRecord | SignalRecord;
export const DECISION_POLICY = 'merqo-simulation-draft-v2';
export interface ApprovalRequest { id: string; decisionId: string; decisionVersion: number; actionHash: string; policyVersion: string; requestedAt: string; expiresAt: string; requestedBy: 'local-analyst'; status: ApprovalStatus }
export interface DecisionDraft { policyRevision?:number; approvalMinutes?:number;
  id: string; version: number; workspaceId: string; investigationId: string; scenario: 'margin' | 'inventory' | 'ads';
  state: 'draft' | 'pending_approval' | 'superseded' | 'expired' | 'approved' | 'rejected' | 'invalidated'; environment: 'simulation' | 'analysis_only';
  selectedKind: Scenario['kind']; selected: Scenario; alternatives: Scenario[];
  scope: { shop: string; channel: string; sku: string; date: string; source: 'demo' | 'csv'; warehouse: string | null; campaign: string | null };
  before: Record<string, number | null>; after: Record<string, number | null>;
  note: string; evidenceIds: string[]; evidenceHash: string; recordId: string; ruleVersion: string; reportHash: string;
  policyVersion: string; actionHash: string; createdAt: string; updatedAt: string; expiresAt: string;
  submissionBlockers: string[]; request: ApprovalRequest | null; approvalResolution?: ApprovalResolution | null; approvalInvalidation?: ApprovalInvalidation | null;
}
interface JsonRow { json: string }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashOf = (e: DraftEvidence): string => 'hash' in e ? e.hash : e.snapshotHash;
function actionHash(draft: DecisionDraft): string { return digest({ ...(draft.policyRevision!==undefined?{policyRevision:draft.policyRevision,approvalMinutes:draft.approvalMinutes}:{}), id: draft.id, version: draft.version, workspace: draft.workspaceId, investigation: draft.investigationId, scope: draft.scope, kind: draft.selectedKind, before: draft.before, after: draft.after, selected: draft.selected, evidence: draft.evidenceHash, record: draft.recordId, report: draft.reportHash, policy: draft.policyVersion, expiresAt: draft.expiresAt, rule: draft.ruleVersion, note: draft.note }); }
/** Local single-user simulated decisions and approvals. No independent identity assurance or business execution. */
export class DecisionStore {
  private readonly db: Database;
  constructor(private readonly file: string, private readonly workspaceId: string, private readonly current: () => DraftEvidence[]) {
    this.db = new Database(file + '.investigations.sqlite', { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.db.query('ATTACH DATABASE ? AS business_scope').run(file);
      this.db.query('ATTACH DATABASE ? AS signals_scope').run(file + '.signals.sqlite');
      this.db.exec('CREATE TABLE IF NOT EXISTS decision_schema(version INTEGER PRIMARY KEY) STRICT');
      const schemaVersion = this.db.query<{version:number}, []>('SELECT max(version) AS version FROM decision_schema').get()?.version ?? 0;
      if (schemaVersion > 8) throw new Error('决策数据库版本高于当前程序');
      if (schemaVersion >= 1 && schemaVersion <= 7) this.db.query('VACUUM main INTO ?').run(file + '.investigations.backup-v' + schemaVersion + '-' + randomUUID() + '.sqlite');
      const policies=new PolicyStore(file);policies.close();this.db.query('ATTACH DATABASE ? AS policy_scope').run(file+'.policy.sqlite');
      this.db.transaction(() => { this.db.exec(`CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE TABLE IF NOT EXISTS decision_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
        CREATE TABLE IF NOT EXISTS decision_requests(id TEXT PRIMARY KEY,decision_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),UNIQUE(decision_id,version)) STRICT;
        CREATE TABLE IF NOT EXISTS decision_events(id INTEGER PRIMARY KEY,decision_id TEXT NOT NULL,version INTEGER NOT NULL,event TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS decisions_recent ON decisions(json_extract(json,'$.updatedAt'));
        CREATE INDEX IF NOT EXISTS decision_events_run ON decision_events(decision_id,version,id);`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS approval_resolutions(request_id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE TABLE IF NOT EXISTS approval_invalidations(request_id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE INDEX IF NOT EXISTS approval_requests_recent ON decision_requests(json_extract(json,'$.requestedAt'));`);
      installSimulationSchema(this.db);installCompensationSchema(this.db);installBatchSchema(this.db);installReviewSchema(this.db);
      this.db.exec('INSERT OR IGNORE INTO decision_schema VALUES(8)'); }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private run(id: string): AnyInvestigation { const row = this.db.query<JsonRow, [string]>('SELECT json FROM investigations WHERE id=?').get(id); if (!row) throw new Error('调查不存在'); return JSON.parse(row.json) as AnyInvestigation; }
  private raw(id: string): DecisionDraft { const row = this.db.query<JsonRow, [string]>('SELECT json FROM decisions WHERE id=?').get(id); if (!row) throw new Error('决策草稿不存在'); const d = JSON.parse(row.json) as DecisionDraft; if (d.workspaceId !== this.workspaceId) throw new Error('决策不属于当前工作空间'); return d; }
  private make(run: AnyInvestigation, kind: Scenario['kind'], note: string, previous?: DecisionDraft): DecisionDraft {
    if (!run.report || run.state === 'running' || run.state === 'failed') throw new Error('调查尚无有效报告，请完成调查后再保存草稿');
    const alternatives = (isSignalInvestigation(run) ? simulateSignal(run.evidence) : simulate(run.evidence,run.marginAction)).map(s => ({ ...s, rationale: run.report!.options.find(o => o.kind === s.kind)?.rationale ?? '' }));
    if (JSON.stringify(alternatives) !== JSON.stringify(run.report.scenarios)) throw new Error('调查测算规则或方案结果已变化，请重新调查');
    const selected = alternatives.find(s => s.kind === kind); if (!selected) throw new Error('方案不属于当前调查场景');
    const e = run.evidence; const row = e.row; const now = new Date().toISOString();
    const before: Record<string, number | null> = isSignalInvestigation(run) ? run.scenario === 'inventory' ? { available: run.evidence.metrics.available, coverageDays: run.evidence.metrics.coverageDays, proposedQuantity: 0 } : { spendMinor: 'spend_minor' in row ? row.spend_minor : null } : { ...(kind==='set_price'?{priceMinor:run.evidence.row.list_price_minor}:{}), couponMinor: run.evidence.row.coupon_minor, revenueMinor: run.evidence.calculation.revenueMinor, marginBps: run.evidence.calculation.marginBps };
    const after: Record<string, number | null> = (run.scenario ?? 'margin') === 'margin' ? { ...(kind==='set_price'?{priceMinor:selected.values?.priceMinor??null}:{}), couponMinor: selected.couponMinor, revenueMinor: selected.revenueMinor, marginBps: selected.marginBps } : run.scenario === 'inventory' ? { proposedQuantity: selected.values?.proposedQuantity ?? null, leadDays: selected.values?.leadDays ?? null } : { spendMinor: selected.values?.proposedSpendMinor ?? null, hypotheticalRevenueMinor: selected.values?.hypotheticalRevenueMinor ?? null, roas: selected.values?.roas ?? null };
    const policy=freezePolicy(readBusinessPolicy(this.file),row.shop_id);
    const draft: DecisionDraft = { ...(policy.revision?{policyRevision:policy.revision,approvalMinutes:policy.settings.approvalMinutes}:{}), id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, workspaceId: this.workspaceId, investigationId: run.id, scenario: run.scenario ?? 'margin', state: 'draft', environment: e.source === 'demo' ? 'simulation' : 'analysis_only', selectedKind: kind, selected, alternatives, scope: { shop: row.shop_id, channel: row.channel, sku: row.sku_id, date: row.date, source: e.source, warehouse: 'warehouse_id' in row ? row.warehouse_id : null, campaign: 'campaign_id' in row ? row.campaign_id : null }, before, after, note, evidenceIds: [...new Set([...run.report.observations, ...run.report.hypotheses].flatMap(c => c.evidenceIds))], evidenceHash: hashOf(e), recordId: e.id, ruleVersion: e.ruleVersion, reportHash: digest(run.report), policyVersion: DECISION_POLICY, actionHash: '', createdAt: previous?.createdAt ?? now, updatedAt: now, expiresAt: new Date(Date.now() + policy.settings.approvalMinutes*60000).toISOString(), submissionBlockers: [], request: null };
    draft.actionHash = actionHash(draft); return draft;
  }
  private blockers(d: DecisionDraft): string[] {
    const reasons: string[] = []; const run = this.run(d.investigationId); const e = run.evidence;
    if (d.selectedKind === 'observe') reasons.push('观察方案无需动作审批；可保存并继续补证');
    if (d.environment !== 'simulation' || e.source !== 'demo') reasons.push('当前仅支持演示数据的模拟审批；CSV经营数据需实时Adapter与业务权限校验');
    if (run.mode !== 'model' || run.report?.reviewer.mode !== 'model') reasons.push('离线演示没有模型Reviewer审核，请先进行模型调查；不能提交模拟审批');
    else if (run.report.reviewer.verdict === 'rejected') reasons.push('模型Reviewer已驳回，请查看原调查的复核意见并修正；不能提交');
    else if (run.report.reviewer.verdict !== 'passed' || run.state !== 'completed') reasons.push('模型Reviewer待补证或调查未完成，请查看原调查的未知项和复核意见；不能提交');
    if (!d.selected.passed) reasons.push(...d.selected.constraints, '所选方案未通过硬约束');
    if (('metrics' in e ? e.metrics.issues : e.calculation.issues).length) reasons.push('冻结证据缺少关键字段或口径冲突');
    const timeIssue=evidenceTimeIssue(e);if(timeIssue)reasons.push(timeIssue);
    if (Date.now() >= Date.parse(d.expiresAt)) reasons.push(`草稿${d.approvalMinutes??30}分钟有效期已过，请保存新版本`);
    if((d.policyRevision??0)!==readBusinessPolicy(this.file).revision)reasons.push('经营规则配置已变化，请重新调查并审批');
    const current = this.current().find(r => r.id === e.id);
    if (!current || hashOf(current) !== d.evidenceHash || current.ruleVersion !== d.ruleVersion || JSON.stringify(current.row) !== JSON.stringify(e.row) || ('metrics' in current ? current.metrics.issues : current.calculation.issues).length) reasons.push('当前业务快照、规则或质量已变化，请重新调查');
    if (d.policyVersion !== DECISION_POLICY || d.actionHash !== actionHash(d) || d.reportHash !== digest(run.report)) reasons.push('参数摘要、复核或规则版本变化，需重新生成草稿');
    try { const recalculated = this.make(run, d.selectedKind, d.note); recalculated.id = d.id; recalculated.version = d.version; recalculated.expiresAt = d.expiresAt;
      if (actionHash(recalculated) !== d.actionHash) reasons.push('方案计算规则发生变化，请重新生成草稿');
    } catch { reasons.push('调查方案与当前测算不一致，请重新调查'); }
    return [...new Set(reasons)];
  }
  private requestFor(d: DecisionDraft): ApprovalRequest | null {
    const row=this.db.query<JsonRow,[string,number]>('SELECT json FROM decision_requests WHERE decision_id=? AND version=?').get(d.id,d.version);
    return row ? JSON.parse(row.json) as ApprovalRequest : null;
  }
  private projection(d: DecisionDraft, request: ApprovalRequest): { status: ApprovalStatus; resolution: ApprovalResolution | null; invalidation: ApprovalInvalidation | null; blockers: string[] } {
    const latest=this.raw(d.id);
    const resolved=this.db.query<JsonRow,[string]>('SELECT json FROM approval_resolutions WHERE request_id=?').get(request.id);
    const resolution=resolved ? JSON.parse(resolved.json) as ApprovalResolution : null;
    const invalid=this.db.query<JsonRow,[string]>('SELECT json FROM approval_invalidations WHERE request_id=?').get(request.id);
    let invalidation=invalid ? JSON.parse(invalid.json) as ApprovalInvalidation : null;
    let blockers: string[];
    try { blockers=this.blockers(d); } catch { blockers=['原调查证据无法校验，请重新调查']; }
    if(request.decisionId!==d.id||request.decisionVersion!==d.version||request.actionHash!==d.actionHash||request.policyVersion!==d.policyVersion||request.expiresAt!==d.expiresAt) blockers.push('申请与决策版本、摘要或有效期绑定不一致');
    if(resolution&&(resolution.actionHash!==request.actionHash||resolution.decisionVersion!==request.decisionVersion||resolution.decisionId!==d.id||resolution.policyVersion!==d.policyVersion||resolution.evidenceHash!==d.evidenceHash||resolution.reportHash!==d.reportHash||resolution.expiresAt!==d.expiresAt)) blockers.push('审批结论与当前申请绑定不一致');
    if(resolution?.decision==='approved') {
      const jobRow=this.db.query<{id:string},[string]>('SELECT id FROM simulation_jobs WHERE request_id=?').get(request.id);
      if(jobRow){const ledger=new SimulationLedger(this.db,this.workspaceId);const view=ledger.view(jobRow.id);if(!view.receipt){const conflict=ledger.targetConflict(view.job);if(conflict)blockers.push(conflict);}}
    }
    let cause: ApprovalInvalidation['status'] | null=null;
    if(latest.version!==d.version) {cause='superseded';blockers.unshift('决策已保存新版本，旧申请与批准已失效');}
    else if(!Number.isFinite(Date.parse(request.expiresAt))||Date.now()>=Date.parse(request.expiresAt)) {cause='expired';blockers.unshift('申请有效期已过，需要保存新版本并重新提交');}
    else if(blockers.length) cause='invalidated';
    if(cause&&!invalidation) {
      invalidation={requestId:request.id,status:cause,reasons:[...new Set(blockers)],at:new Date().toISOString()};
      this.db.query('INSERT INTO approval_invalidations VALUES(?,?)').run(request.id,JSON.stringify(invalidation));
      this.db.query('INSERT INTO decision_events(decision_id,version,event,at,actor) VALUES(?,?,?,?,?)').run(d.id,d.version,'approval_invalidated',invalidation.at,'system-policy');
    }
    if(invalidation) blockers=[...new Set([...invalidation.reasons,...blockers])];
    return {status:latest.version!==d.version?'superseded':invalidation?.status??resolution?.decision??'pending',resolution,invalidation,blockers};
  }
  private view(d: DecisionDraft): DecisionDraft {
    const request=this.requestFor(d);
    if(request) {const p=this.projection(d,request);return {...d,state:p.status==='pending'?'pending_approval':p.status,request:{...request,status:p.status},submissionBlockers:p.blockers,approvalResolution:p.resolution,approvalInvalidation:p.invalidation};}
    const latest=this.raw(d.id);return {...d,state:latest.version!==d.version?'superseded':Date.now()>=Date.parse(d.expiresAt)?'expired':'draft',request:null,submissionBlockers:this.blockers(d)};
  }
  list(): DecisionDraft[] { return this.db.transaction(()=>this.db.query<JsonRow, []>("SELECT json FROM decisions ORDER BY json_extract(json,'$.updatedAt') DESC,rowid DESC LIMIT 50").all().map(r => this.view(JSON.parse(r.json) as DecisionDraft))).immediate(); }
  forInvestigation(runId: string): DecisionDraft[] { return this.db.transaction(()=>{const row = this.db.query<JsonRow, [string]>('SELECT json FROM decisions WHERE run_id=?').get(runId); return row ? [this.view(JSON.parse(row.json) as DecisionDraft)] : [];}).immediate(); }
  history(id: string): DecisionDraft[] { return this.db.transaction(()=>{this.raw(id); return this.db.query<JsonRow, [string]>('SELECT json FROM decision_versions WHERE id=? ORDER BY version DESC LIMIT 30').all(id).map(r => this.view(JSON.parse(r.json) as DecisionDraft));}).immediate(); }
  private approvalView(request: ApprovalRequest): ApprovalView {
    this.raw(request.decisionId);
    const row=this.db.query<JsonRow,[string,number]>('SELECT json FROM decision_versions WHERE id=? AND version=?').get(request.decisionId,request.decisionVersion);
    if(!row) throw new Error('申请对应的决策版本不存在');
    const d=JSON.parse(row.json) as DecisionDraft;if(d.workspaceId!==this.workspaceId)throw new Error('申请不属于当前工作空间');
    const p=this.projection(d,request);
    const audit=this.db.query<ApprovalAudit,[string,number]>('SELECT id,event,at,actor FROM decision_events WHERE decision_id=? AND version=? ORDER BY id LIMIT 100').all(d.id,d.version).map(e=>({...e,...(e.event==='approval_invalidated'?{reason:p.invalidation?.reasons.join('；')??''}:e.event==='approval_approved'||e.event==='approval_rejected'?{reason:p.resolution?.reason??''}:{})}));
    let evidence: ApprovalView['evidence']=null;try{const run=this.run(d.investigationId);evidence={timeContext:evidenceTimeContext(run.evidence),observedAt:run.evidence.row.date,importedAt:run.evidence.importedAt,source:run.evidence.source,reviewer:run.report?.reviewer.verdict??'unknown',mode:run.mode};}catch{/* invalidation is already persisted */}
    return {evidence,id:request.id,status:p.status,decision:{...d,state:p.status==='pending'?'pending_approval':p.status,request:{...request,status:p.status},submissionBlockers:p.blockers,approvalResolution:p.resolution,approvalInvalidation:p.invalidation},resolution:p.resolution,invalidation:p.invalidation,blockers:p.blockers,audit};
  }
  approvals(): ApprovalView[] { return this.db.transaction(()=>this.db.query<JsonRow,[]>("SELECT json FROM decision_requests ORDER BY json_extract(json,'$.requestedAt') DESC,rowid DESC LIMIT 100").all().map(r=>this.approvalView(JSON.parse(r.json) as ApprovalRequest))).immediate(); }
  resolveApproval(requestId:string,expectedVersion:number,expectedActionHash:string,choice:'approve'|'reject',reason:string,actor:SimulationApprover|null): ApprovalView {
    if(actor?.id!=='local-simulation-approver'||actor.role!=='approver'||actor.environment!=='simulation')throw new Error('缺少服务端模拟审批角色');
    if(choice!=='approve'&&choice!=='reject')throw new Error('未知审批选择');
    reason=reason.trim();if(!reason||reason.length>2000)throw new Error('请填写1至2000字的审批理由');
    const outcome=this.db.transaction(()=>{
      const row=this.db.query<JsonRow,[string]>('SELECT json FROM decision_requests WHERE id=?').get(requestId);if(!row)throw new Error('审批申请不存在');
      const request=JSON.parse(row.json) as ApprovalRequest;if(request.id!==requestId)throw new Error('申请标识绑定不一致');
      const view=this.approvalView(request);
      if(request.decisionVersion!==expectedVersion||request.actionHash!==expectedActionHash)return {error:'审批版本或参数摘要已变化，请刷新申请',view};
      if(view.resolution) {if(view.resolution.decision===(choice==='approve'?'approved':'rejected')&&view.resolution.reason===reason)return {error:null,view};return {error:'该申请已有审批结论，不能覆盖，请保存新版本再提交',view};}
      if(view.status!=='pending'||view.blockers.length)return {error:'不能处理审批：'+(view.blockers.join('；')||view.status),view};
      const d=view.decision;const resolution:ApprovalResolution={id:randomUUID(),requestId,decisionId:d.id,decisionVersion:d.version,actionHash:d.actionHash,policyVersion:d.policyVersion,evidenceHash:d.evidenceHash,reportHash:d.reportHash,expiresAt:d.expiresAt,decision:choice==='approve'?'approved':'rejected',reason,resolvedAt:new Date().toISOString(),actor};
      this.db.query('INSERT INTO approval_resolutions VALUES(?,?)').run(requestId,JSON.stringify(resolution));
      if(resolution.decision==='approved')new SimulationLedger(this.db,this.workspaceId).queue(d,resolution);
      this.db.query('INSERT INTO decision_events(decision_id,version,event,at,actor) VALUES(?,?,?,?,?)').run(d.id,d.version,choice==='approve'?'approval_approved':'approval_rejected',resolution.resolvedAt,actor.id);
      return {error:null,view:this.approvalView(request)};
    }).immediate();
    // Keep invalidation/audit writes even when processing is refused.
    if(outcome.error)throw new Error(outcome.error);return outcome.view;
  }
  executions(): ExecutionView[] {
    return this.db.transaction(()=>{
      const ledger=new SimulationLedger(this.db,this.workspaceId);
      for(const row of this.db.query<JsonRow,[]>("SELECT json FROM decision_requests WHERE id IN (SELECT request_id FROM approval_resolutions) AND id NOT IN (SELECT request_id FROM simulation_jobs)").all()) {
        const approval=this.approvalView(JSON.parse(row.json) as ApprovalRequest);
        if(approval.status==='approved'&&approval.resolution)ledger.queue(approval.decision,approval.resolution,true);
      }
      return ledger.list().map(view=>{
        const row=this.db.query<JsonRow,[string]>('SELECT json FROM decision_requests WHERE id=?').get(view.job.requestId);
        if(!row)return {...view,blockers:['原审批申请不存在']};
        const approval=this.approvalView(JSON.parse(row.json) as ApprovalRequest);
        return {...view,batchId:new ExecutionBatchLedger(this.db,this.workspaceId).owner(view.job.id),blockers:view.receipt?[]:approval.status==='approved'?approval.blockers:[...approval.blockers,'当前审批状态：'+approval.status]};
      });
    }).immediate();
  }
  executeSimulation(id:string,expectedVersion:number,expectedActionHash:string,actor:SimulationExecutor|null,lease?:BatchLease):ExecutionView {
    requireExecutor(actor);
    return this.db.transaction(()=>{
      const ledger=new SimulationLedger(this.db,this.workspaceId);const job=ledger.job(id);
      const batches=new ExecutionBatchLedger(this.db,this.workspaceId);const owner=batches.owner(id);if(owner){if(lease){if(lease.jobId!==id||lease.batchId!==owner)throw new Error('执行项与批次租约不匹配');batches.guard(lease);}else if(!ledger.view(id).receipt)throw new Error('动作已纳入执行批次，请从批次处理');}else if(lease)throw new Error('动作不属于该批次');
      if(job.decisionVersion!==expectedVersion||job.actionHash!==expectedActionHash)throw new Error('执行版本或动作摘要不匹配，请刷新执行项');
      const row=this.db.query<JsonRow,[string]>('SELECT json FROM decision_requests WHERE id=?').get(job.requestId);if(!row)throw new Error('执行申请不存在');
      const approval=this.approvalView(JSON.parse(row.json) as ApprovalRequest);const d=approval.decision;const resolution=approval.resolution;
      if(!resolution||resolution.id!==job.resolutionId||resolution.decision!=='approved'||job.decisionId!==d.id||job.evidenceHash!==d.evidenceHash||job.reportHash!==d.reportHash||job.policyVersion!==d.policyVersion||job.expiresAt!==d.expiresAt||job.actionHash!==d.actionHash)throw new Error('执行项与原批准绑定不一致');
      ledger.assertBinding(job,d,resolution);
      // A stored success is historical proof, never a new grant; retry does not write again.
      if(ledger.view(id).receipt)return ledger.view(id);
      if(approval.status!=='approved'||approval.blockers.length)return ledger.fail(id,'执行前校验失败：'+(approval.blockers.join('；')||approval.status),actor);
      return ledger.execute(id,actor);
    }).immediate();
  }
  reconcileExecution(id:string,actor:SimulationExecutor|null):ExecutionView {
    requireExecutor(actor);return this.db.transaction(()=>new SimulationLedger(this.db,this.workspaceId).reconcile(id,actor)).immediate();
  }
  private decorateBatch(view:BatchView):BatchView {
    return {...view,items:view.items.map(item=>{const row=this.db.query<JsonRow,[string]>('SELECT json FROM decision_requests WHERE id=?').get(item.job.requestId);if(!row)return{...item,blockers:['原审批申请不存在']};const approval=this.approvalView(JSON.parse(row.json) as ApprovalRequest);return{...item,blockers:item.receipt?[]:approval.status==='approved'?approval.blockers:[...approval.blockers,'当前审批状态：'+approval.status]};})};
  }
  executionBatches():BatchView[]{return this.db.transaction(()=>new ExecutionBatchLedger(this.db,this.workspaceId).list().map(v=>this.decorateBatch(v))).immediate();}
  executionBatch(id:string):BatchView{return this.db.transaction(()=>this.decorateBatch(new ExecutionBatchLedger(this.db,this.workspaceId).view(id))).immediate();}
  createExecutionBatch(jobIds:string[],reason:string):BatchView{
    return this.db.transaction(()=>{const available=this.executions();const selected=jobIds.map(id=>{const item=available.find(v=>v.job.id===id);if(!item)throw new Error('批次动作不在当前可选列表中，请刷新');return item;});return new ExecutionBatchLedger(this.db,this.workspaceId).create(selected,reason);}).immediate();
  }
  claimBatchItem(id:string,jobId:string,mode:'ready'|'failed',actor:SimulationExecutor|null):BatchLease{return this.db.transaction(()=>new ExecutionBatchLedger(this.db,this.workspaceId).claim(id,jobId,mode,actor)).immediate();}
  settleBatchItem(lease:BatchLease,actor:SimulationExecutor|null):BatchView{return this.db.transaction(()=>new ExecutionBatchLedger(this.db,this.workspaceId).settle(lease,actor)).immediate();}
  recoverExecutionBatch(id:string,actor:SimulationExecutor|null):BatchView{return this.db.transaction(()=>new ExecutionBatchLedger(this.db,this.workspaceId).recover(id,actor)).immediate();}
  runExecutionBatch(id:string,actor:SimulationExecutor|null,retryJobId?:string):BatchView{
    requireExecutor(actor);const before=this.executionBatch(id);if(before.items.some(v=>v.dispatch.status==='running'||v.dispatch.status==='unknown'))throw new Error('批次仍有执行中或待确认项，先查询确认');
    const candidates=retryJobId?before.items.filter(v=>v.item.jobId===retryJobId&&v.dispatch.status==='failed'):before.items.filter(v=>v.dispatch.status==='ready');if(retryJobId&&candidates.length!==1)throw new Error('只能单独重试已确认失败项，不能重放成功或待确认项');
    for(const item of candidates){const lease=this.claimBatchItem(id,item.item.jobId,retryJobId?'failed':'ready',actor);try{this.executeSimulation(item.item.jobId,item.item.version,item.item.actionHash,actor,lease);}catch{/* Query the durable ledger; exceptions are never assumed to mean not executed. */}const settled=this.settleBatchItem(lease,actor);if(settled.items.some(v=>v.dispatch.status==='unknown'))break;}
    return this.executionBatch(id);
  }
  review(id:string):ReviewView{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).view(id)).immediate();}
  reviews():ReviewView[]{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).list()).immediate();}
  createReview(jobId:string):ReviewView{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).create(jobId)).immediate();}
  previewObservation(id:string,csv:string):ObservationPreview{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).preview(id,csv)).immediate();}
  observeReview(id:string,version:number,input:{csv:string;hash:string}|null):ReviewView{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).observe(id,version,input)).immediate();}
  finalizeReview(id:string,version:number,hash:string,conclusion:'comparison_only'|'inconclusive',note:string,confounders:string,actor:string):ReviewView{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).finalize(id,version,hash,conclusion,note,confounders,actor)).immediate();}
  searchCases(e:DraftEvidence,scenario:DecisionDraft['scenario'],asOf:string):CaseMemory[]{return this.db.transaction(()=>new ReviewLedger(this.db,this.workspaceId).search(e,scenario,asOf)).immediate();}
  compensations():CompensationView[]{return this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).list()).immediate();}
  createCompensation(jobId:string,reason:string):CompensationView{return this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).create(jobId,reason)).immediate();}
  reviseCompensation(id:string,expectedVersion:number,reason:string):CompensationView{return this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).revise(id,expectedVersion,reason)).immediate();}
  resolveCompensation(id:string,version:number,hash:string,choice:'approve'|'reject',reason:string,actor:SimulationApprover|null):CompensationView{
    const result=this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).resolve(id,version,hash,choice,reason,actor)).immediate();if(result.error)throw new Error(result.error);return result.view;
  }
  executeCompensation(id:string,version:number,hash:string,actor:SimulationExecutor|null):CompensationView{return this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).execute(id,version,hash,actor)).immediate();}
  reconcileCompensation(id:string,actor:SimulationExecutor|null):CompensationView{return this.db.transaction(()=>new CompensationLedger(this.db,this.workspaceId,this.current,shop=>freezePolicy(readBusinessPolicy(this.file),shop).settings.approvalMinutes).reconcile(id,actor)).immediate();}
  private save(d: DecisionDraft, event: string): void {
    this.db.query('INSERT INTO decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json').run(d.id, d.investigationId, d.version, JSON.stringify(d));
    this.db.query('INSERT INTO decision_versions VALUES(?,?,?)').run(d.id, d.version, JSON.stringify(d));
    this.db.query('INSERT INTO decision_events(decision_id,version,event,at,actor) VALUES(?,?,?,?,?)').run(d.id, d.version, event, d.updatedAt, 'local-analyst');
  }
  create(runId: string, kind: Scenario['kind'], note: string): DecisionDraft {
    return this.db.transaction(() => { const existing = this.db.query<{id:string}, [string]>('SELECT id FROM decisions WHERE run_id=?').get(runId); if (existing) return this.view(this.raw(existing.id)); const d = this.make(this.run(runId), kind, note); this.save(d, 'created'); return this.view(d); }).immediate();
  }
  revise(id: string, expectedVersion: number, kind: Scenario['kind'], note: string): DecisionDraft {
    return this.db.transaction(() => { const old = this.raw(id); if (old.version !== expectedVersion) throw new Error('版本冲突：草稿已更新，请刷新后重试'); const d = this.make(this.run(old.investigationId), kind, note, old); this.save(d, 'revised'); const oldRequest=this.requestFor(old);if(oldRequest)this.projection(old,oldRequest); return this.view(d); }).immediate();
  }
  submit(id: string, expectedVersion: number): DecisionDraft {
    // IMMEDIATE locks all three attached databases while source evidence and approval request are checked/written.
    return this.db.transaction(() => {
      const d = this.raw(id); if (d.version !== expectedVersion) throw new Error('版本冲突：只能提交当前版本');
      const blockers = this.blockers(d); if (blockers.length) throw new Error('不能提交模拟审批：' + blockers.join('；'));
      if (!this.db.query('SELECT id FROM decision_requests WHERE decision_id=? AND version=?').get(id, d.version)) {
        const request: ApprovalRequest = { id: randomUUID(), decisionId: id, decisionVersion: d.version, actionHash: d.actionHash, policyVersion: d.policyVersion, requestedAt: new Date().toISOString(), expiresAt: d.expiresAt, requestedBy: 'local-analyst', status: 'pending' };
        this.db.query('INSERT INTO decision_requests VALUES(?,?,?,?)').run(request.id, id, d.version, JSON.stringify(request));
        this.db.query('INSERT INTO decision_events(decision_id,version,event,at,actor) VALUES(?,?,?,?,?)').run(id, d.version, 'submitted', request.requestedAt, 'local-analyst');
      }
      return this.view(d);
    }).immediate();
  }
}
