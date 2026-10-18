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
  constructor(file: string, private readonly readOnly = false, private readonly workspaceId?: string) {
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
  create(evidence: EvidenceRecord, mode: Investigation['mode'], retry = false): { run: Investigation; created: boolean } {
    return this.createAny(evidence, 'margin', mode, retry) as { run: Investigation; created: boolean };
  }
  createSignal(evidence: SignalRecord, mode: Investigation['mode'], retry = false): { run: SignalInvestigation; created: boolean } {
    return this.createAny(evidence, evidence.kind, mode, retry) as { run: SignalInvestigation; created: boolean };
  }
  private createAny(evidence: EvidenceRecord | SignalRecord, scenario: 'margin' | 'inventory' | 'ads', mode: Investigation['mode'], retry: boolean): { run: AnyInvestigation; created: boolean } {
    if (this.readOnly) throw new Error('只读调查连接不允许写入');
    return this.db.transaction(() => {
      this.recover();
      const existing = this.db.query<Stored, [string, string]>('SELECT json FROM investigations WHERE record_id=? AND mode=? ORDER BY updated_at DESC,id DESC LIMIT 1').get(evidence.id, mode);
      if (existing) {
        const run = JSON.parse(existing.json) as AnyInvestigation;
        if (run.state === 'running' || !retry) return { run, created: false };
      }
      const active = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM investigations WHERE state='running'").get()?.n ?? 0;
      if (active >= 2) throw new Error('当前经营空间已有两项调查进行中，请等待完成或超时后重试');
      const now = new Date().toISOString();
      const hasCases=this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='retail_cases'").get();
      const caseContext=this.workspaceId&&hasCases?new ReviewLedger(this.db,this.workspaceId).search(evidence,scenario,now):[];
      const base = { epoch: 0, caseContext, id: randomUUID(), recordId: evidence.id, mode, state: 'running', createdAt: now, updatedAt: now, deadlineAt: new Date(Date.now() + 300000).toISOString(), evidence, trace: [], report: null, error: null, model: null };
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
