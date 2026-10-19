import {TOOL_CALL_LIMIT,SUPPLEMENT_ROUND_LIMIT} from './investigation-limits';
import {supplementDigest,freshSupplementEvidence} from './supplement';
import type {SupplementPreview} from './supplement';
import { ReviewLedger } from './outcome-reviews';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { SignalRecord } from './signals';
import { isSignalInvestigation } from './investigations';
import type { EvidenceRecord } from './operations';
import type { Investigation, AnyInvestigation, SignalInvestigation, InvestigationReport, Trace } from './investigations';

interface Stored { json: string }
export class InvestigationStore {
  private readonly db: Database;
  constructor(file: string, private readonly readOnly = false, private readonly workspaceId?: string, private readonly relatedReader?: (evidence: EvidenceRecord | SignalRecord) => import('./related-evidence').RelatedEvidence) {
    this.db = new Database(file, readOnly ? { readonly: true, strict: true } : { create: true, strict: true });
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=5000'); return; }
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS investigations(id TEXT PRIMARY KEY, record_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('model','replay')), state TEXT NOT NULL, updated_at TEXT NOT NULL, deadline_at TEXT NOT NULL, json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS investigations_active ON investigations(record_id,mode) WHERE state='running';
        CREATE INDEX IF NOT EXISTS investigations_recent ON investigations(updated_at DESC);`);
    } catch (error) { this.db.close(); throw error; }
  }
  get(id: string): AnyInvestigation { const row = this.db.query<Stored, [string]>('SELECT json FROM investigations WHERE id=?').get(id); if (!row) throw new Error('调查不存在'); return JSON.parse(row.json) as AnyInvestigation; }
  close(): void { this.db.close(); }
  private recover(): void {
    if (this.readOnly) throw new Error('只读调查连接不允许恢复写入');
    const expired = this.db.query<Stored, [string]>("SELECT json FROM investigations WHERE state='running' AND deadline_at<=?").all(new Date().toISOString());
    for (const item of expired) {
      const run = JSON.parse(item.json) as AnyInvestigation;
      run.state = 'failed'; run.error = '调查超时或应用已退出；已保留证据和中间过程，可重新调查'; run.updatedAt = new Date().toISOString();
      this.write(run);
    }
  }
  private write(run: AnyInvestigation): void {
    this.db.query('UPDATE investigations SET state=?,updated_at=?,deadline_at=?,json=? WHERE id=?').run(run.state, run.updatedAt, run.deadlineAt, JSON.stringify(run), run.id);
  }
  list(recordId?: string): Investigation[] { return this.listAll(recordId).filter((r): r is Investigation => !isSignalInvestigation(r)); }
  listAll(recordId?: string): AnyInvestigation[] {
    this.db.transaction(() => this.recover()).immediate();
    const rows = recordId
      ? this.db.query<Stored, [string]>('SELECT json FROM investigations WHERE record_id=? ORDER BY updated_at DESC,id DESC LIMIT 30').all(recordId)
      : this.db.query<Stored, []>('SELECT json FROM investigations ORDER BY updated_at DESC,id DESC LIMIT 50').all();
    return rows.map(r => JSON.parse(r.json) as AnyInvestigation);
  }
  create(evidence: EvidenceRecord, mode: Investigation['mode'], retry = false, marginAction:import('./price-action').MarginAction='reduce_coupon'): { run: Investigation; created: boolean } {
    return this.createAny(evidence, 'margin', mode, retry, marginAction) as { run: Investigation; created: boolean };
  }
  createSignal(evidence: SignalRecord, mode: Investigation['mode'], retry = false): { run: SignalInvestigation; created: boolean } {
    return this.createAny(evidence, evidence.kind, mode, retry) as { run: SignalInvestigation; created: boolean };
  }
  supplementPreview(id:string,evidence:EvidenceRecord|SignalRecord):SupplementPreview{const parent=this.get(id);freshSupplementEvidence(parent,[evidence]);if(parent.state==='running')throw Error('请先暂停或等待原调查结束后补证');const round=(parent.supplement?.round??0)+1;if(round>SUPPLEMENT_ROUND_LIMIT)throw Error('已达到两轮补证上限，请结束并核对未知项');const relatedEvidence=this.relatedReader?.(evidence);if(JSON.stringify(parent.evidence)===JSON.stringify(evidence)&&JSON.stringify(parent.relatedEvidence)===JSON.stringify(relatedEvidence))throw Error('证据与映射尚未更新，请先导入补充信息');return{parentId:id,expectedEpoch:parent.epoch??0,round,hash:supplementDigest(parent,evidence,relatedEvidence),before:parent.evidence,after:evidence,...(relatedEvidence?{relatedEvidence}:{}),notice:'新证据将创建独立补证调查并重新复核；旧报告、审批及执行不修改，不沿用旧审批。'};}
  supplement(id:string,epoch:number,evidence:EvidenceRecord|SignalRecord,hash:string):{run:AnyInvestigation;created:boolean}{if(this.readOnly)throw Error('只读调查连接不允许补证');return this.db.transaction(()=>{const parent=this.get(id);if((parent.epoch??0)!==epoch)throw Error('原调查版本已变化，请重新预览补证');const view=this.supplementPreview(id,evidence);if(view.hash!==hash)throw Error('补证证据或映射已变化，请重新预览');const child=this.db.query<Stored,[string]>("SELECT json FROM investigations WHERE json_extract(json,'$.supplement.parentRunId')=? LIMIT 1").get(id);if(child){const run=JSON.parse(child.json) as AnyInvestigation;if(run.supplement?.previewHash===hash)return{run,created:false};throw Error('已有补证子调查，请在该调查中继续下一轮');}return this.createAny(evidence,parent.scenario??'margin',parent.mode,true,parent.marginAction??'reduce_coupon',{lineage:{parentRunId:id,round:view.round,previewHash:hash},related:view.relatedEvidence});}).immediate();}
  private createAny(evidence: EvidenceRecord | SignalRecord, scenario: 'margin' | 'inventory' | 'ads', mode: Investigation['mode'], retry: boolean, marginAction:import('./price-action').MarginAction='reduce_coupon',supplement?:{lineage:NonNullable<AnyInvestigation['supplement']>;related:import('./related-evidence').RelatedEvidence|undefined}): { run: AnyInvestigation; created: boolean } {
    if (this.readOnly) throw new Error('只读调查连接不允许写入');
    return this.db.transaction(() => {
      this.recover();
      const existing = this.db.query<Stored, [string, string]>('SELECT json FROM investigations WHERE record_id=? AND mode=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(evidence.id, mode);
      if (existing&&!supplement) {
        const run = JSON.parse(existing.json) as AnyInvestigation;
        if(run.state==='running'&&(run.marginAction??'reduce_coupon')!==marginAction)throw new Error('该商品已有其他动作的调查进行中，请先完成或暂停');
        if ((run.marginAction??'reduce_coupon')===marginAction&&(run.state === 'running' || !retry)) return { run, created: false };
      }
      const active = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM investigations WHERE state='running'").get()?.n ?? 0;
      if (active >= 2) throw new Error('当前经营空间已有两项调查进行中，请等待完成或超时后重试');
      const now = new Date().toISOString();
      const hasCases=this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='retail_cases'").get();
      const caseContext=this.workspaceId&&hasCases?new ReviewLedger(this.db,this.workspaceId).search(evidence,scenario,now):[];
      const base = { ...(scenario==='margin'&&marginAction==='set_price'?{marginAction}:{}), epoch: 0, caseContext, ...(supplement?{supplement:supplement.lineage,...(supplement.related?{relatedEvidence:supplement.related}:{})}:this.relatedReader ? {relatedEvidence:this.relatedReader(evidence)} : {}), id: randomUUID(), recordId: evidence.id, mode, state: 'running', createdAt: now, updatedAt: now, deadlineAt: new Date(Date.now() + 300000).toISOString(), evidence, trace: [], report: null, error: null, model: null };
      const run: AnyInvestigation = scenario === 'margin' ? { ...base, state: 'running', evidence: evidence as EvidenceRecord } : { ...base, state: 'running', scenario, evidence: evidence as SignalRecord };
      this.db.query('INSERT INTO investigations(id,record_id,mode,state,updated_at,deadline_at,json) VALUES (?,?,?,?,?,?,?)').run(run.id, evidence.id, mode, run.state, now, run.deadlineAt, JSON.stringify(run));
      return { run, created: true };
    }).immediate();
  }
  control(id: string, expectedEpoch: number, action: 'pause' | 'resume'): AnyInvestigation {
    if (this.readOnly) throw new Error('只读调查连接不允许变更状态');
    return this.db.transaction(() => {
      this.recover(); const run = this.get(id);
      if ((run.epoch ?? 0) !== expectedEpoch) throw new Error('调查版本已变化，请刷新后重试');
      if (run.trace.length >= 256) throw new Error('调查事件预算耗尽，请重新调查');
      if (action === 'pause' && run.state !== 'running') throw new Error('仅进行中的调查可暂停');
      if (action === 'resume') {
        if (run.state !== 'paused' && !(run.state === 'failed' && run.error?.startsWith('调查超时或应用已退出'))) throw new Error('仅已暂停或中断的调查可继续');
        if (run.mode === 'model' && run.epoch === undefined && run.trace.length) throw new Error('旧版调查缺少持久化调用预算，请重新调查');
        const running = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM investigations WHERE state='running'").get()!.n;
        if (running >= 2 || this.db.query("SELECT id FROM investigations WHERE record_id=? AND mode=? AND state='running'").get(run.recordId, run.mode)) throw new Error('已有进行中的调查，请先完成或暂停');
        if (run.trace.filter(t => t.stage === 'budget' && t.tool === 'model_request').length >= 14) throw new Error('本调查模型调用预算已耗尽，请重新调查');
      }
      run.epoch = expectedEpoch + 1; run.state = action === 'pause' ? 'paused' : 'running'; run.updatedAt = new Date().toISOString(); run.error = null;
      if (action === 'resume') run.deadlineAt = new Date(Date.now() + 300000).toISOString();
      run.trace.push({ at: run.updatedAt, stage: 'control', tool: action, evidenceId: `${run.id}:epoch:${run.epoch}`, data: { epoch: run.epoch, additionalTimeBudgetMs: action === 'resume' ? 300000 : 0, modelCallBudgetRemains: 14 - run.trace.filter(t => t.stage === 'budget' && t.tool === 'model_request').length } });
      this.write(run); return run;
    }).immediate();
  }
  update(id: string, patch: { event?: Trace; report?: InvestigationReport; error?: string; model?: string; expectedEpoch?: number }): AnyInvestigation {
    if (this.readOnly) throw new Error('只读调查连接不允许写入');
    return this.db.transaction(() => {
      this.recover();
      const stored = this.db.query<Stored, [string]>('SELECT json FROM investigations WHERE id=?').get(id);
      if (!stored) throw new Error('调查不存在');
      const run = JSON.parse(stored.json) as AnyInvestigation;
      if ((patch.expectedEpoch ?? 0) !== (run.epoch ?? 0)) throw new Error('旧调查执行代次已失效，拒绝迟到结果');
      if (run.state !== 'running') return run;
      if (patch.event) {
        if(patch.event.stage==='investigate'&&run.trace.filter(t=>t.stage==='investigate').length>=TOOL_CALL_LIMIT)throw Error('本调查30次工具调用预算已耗尽');
        if (run.trace.length >= 256) throw new Error('调查事件预算耗尽');
        if (patch.event.stage === 'budget' && patch.event.tool === 'model_request' && run.trace.filter(t => t.stage === 'budget' && t.tool === 'model_request').length >= 14) throw new Error('本调查模型调用预算已耗尽');
        run.trace.push(patch.event);
      }
      if (patch.model) run.model = patch.model;
      if (patch.report) { run.report = patch.report; run.state = patch.report.reviewer.verdict === 'passed' ? 'completed' : 'needs_evidence'; }
      if (patch.error) { run.state = 'failed'; run.error = patch.error.slice(0, 1000); }
      run.updatedAt = new Date().toISOString(); this.write(run); return run;
    }).immediate();
  }
}
