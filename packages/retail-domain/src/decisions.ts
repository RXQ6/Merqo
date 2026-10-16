import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { simulate, isSignalInvestigation } from './investigations';
import { simulateSignal } from './signal-investigations';
import type { AnyInvestigation, Scenario } from './investigations';
import type { EvidenceRecord } from './operations';
import type { SignalRecord } from './signals';
export type DraftEvidence = EvidenceRecord | SignalRecord;
export const DECISION_POLICY = 'merqo-simulation-draft-v1';
export interface ApprovalRequest { id: string; decisionId: string; decisionVersion: number; actionHash: string; policyVersion: string; requestedAt: string; expiresAt: string; requestedBy: 'local-analyst'; status: 'pending' | 'superseded' | 'expired' }
export interface DecisionDraft {
  id: string; version: number; workspaceId: string; investigationId: string; scenario: 'margin' | 'inventory' | 'ads';
  state: 'draft' | 'pending_approval' | 'superseded' | 'expired'; environment: 'simulation' | 'analysis_only';
  selectedKind: Scenario['kind']; selected: Scenario; alternatives: Scenario[];
  scope: { shop: string; channel: string; sku: string; date: string; source: 'demo' | 'csv'; warehouse: string | null; campaign: string | null };
  before: Record<string, number | null>; after: Record<string, number | null>;
  note: string; evidenceIds: string[]; evidenceHash: string; recordId: string; ruleVersion: string; reportHash: string;
  policyVersion: string; actionHash: string; createdAt: string; updatedAt: string; expiresAt: string;
  submissionBlockers: string[]; request: ApprovalRequest | null;
}
interface JsonRow { json: string }
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashOf = (e: DraftEvidence): string => 'hash' in e ? e.hash : e.snapshotHash;
function actionHash(draft: DecisionDraft): string { return digest({ id: draft.id, version: draft.version, workspace: draft.workspaceId, investigation: draft.investigationId, scope: draft.scope, kind: draft.selectedKind, before: draft.before, after: draft.after, selected: draft.selected, evidence: draft.evidenceHash, record: draft.recordId, report: draft.reportHash, policy: draft.policyVersion, expiresAt: draft.expiresAt, rule: draft.ruleVersion, note: draft.note }); }
/** Local single-user simulation inbox only. No approver identity, approval resolution or business execution. */
export class DecisionStore {
  private readonly db: Database;
  constructor(file: string, private readonly workspaceId: string, private readonly current: () => DraftEvidence[]) {
    this.db = new Database(file + '.investigations.sqlite', { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.db.query('ATTACH DATABASE ? AS business_scope').run(file);
      this.db.query('ATTACH DATABASE ? AS signals_scope').run(file + '.signals.sqlite');
      this.db.exec('CREATE TABLE IF NOT EXISTS decision_schema(version INTEGER PRIMARY KEY) STRICT');
      if ((this.db.query<{version:number}, []>('SELECT max(version) AS version FROM decision_schema').get()?.version ?? 0) > 1) throw new Error('决策数据库版本高于当前程序');
      this.db.exec(`CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
        CREATE TABLE IF NOT EXISTS decision_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
        CREATE TABLE IF NOT EXISTS decision_requests(id TEXT PRIMARY KEY,decision_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),UNIQUE(decision_id,version)) STRICT;
        CREATE TABLE IF NOT EXISTS decision_events(id INTEGER PRIMARY KEY,decision_id TEXT NOT NULL,version INTEGER NOT NULL,event TEXT NOT NULL,at TEXT NOT NULL,actor TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS decisions_recent ON decisions(json_extract(json,'$.updatedAt'));
        CREATE INDEX IF NOT EXISTS decision_events_run ON decision_events(decision_id,version,id);`);
      this.db.exec('INSERT OR IGNORE INTO decision_schema VALUES(1)');
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private run(id: string): AnyInvestigation { const row = this.db.query<JsonRow, [string]>('SELECT json FROM investigations WHERE id=?').get(id); if (!row) throw new Error('调查不存在'); return JSON.parse(row.json) as AnyInvestigation; }
  private raw(id: string): DecisionDraft { const row = this.db.query<JsonRow, [string]>('SELECT json FROM decisions WHERE id=?').get(id); if (!row) throw new Error('决策草稿不存在'); const d = JSON.parse(row.json) as DecisionDraft; if (d.workspaceId !== this.workspaceId) throw new Error('决策不属于当前工作空间'); return d; }
  private make(run: AnyInvestigation, kind: Scenario['kind'], note: string, previous?: DecisionDraft): DecisionDraft {
    if (!run.report || run.state === 'running' || run.state === 'failed') throw new Error('调查尚无有效报告，请完成调查后再保存草稿');
    const alternatives = (isSignalInvestigation(run) ? simulateSignal(run.evidence) : simulate(run.evidence)).map(s => ({ ...s, rationale: run.report!.options.find(o => o.kind === s.kind)?.rationale ?? '' }));
    if (JSON.stringify(alternatives) !== JSON.stringify(run.report.scenarios)) throw new Error('调查测算规则或方案结果已变化，请重新调查');
    const selected = alternatives.find(s => s.kind === kind); if (!selected) throw new Error('方案不属于当前调查场景');
    const e = run.evidence; const row = e.row; const now = new Date().toISOString();
    const before: Record<string, number | null> = isSignalInvestigation(run) ? run.scenario === 'inventory' ? { available: run.evidence.metrics.available, coverageDays: run.evidence.metrics.coverageDays, proposedQuantity: 0 } : { spendMinor: 'spend_minor' in row ? row.spend_minor : null } : { couponMinor: run.evidence.row.coupon_minor, revenueMinor: run.evidence.calculation.revenueMinor, marginBps: run.evidence.calculation.marginBps };
    const after: Record<string, number | null> = (run.scenario ?? 'margin') === 'margin' ? { couponMinor: selected.couponMinor, revenueMinor: selected.revenueMinor, marginBps: selected.marginBps } : run.scenario === 'inventory' ? { proposedQuantity: selected.values?.proposedQuantity ?? null, leadDays: selected.values?.leadDays ?? null } : { spendMinor: selected.values?.proposedSpendMinor ?? null, hypotheticalRevenueMinor: selected.values?.hypotheticalRevenueMinor ?? null, roas: selected.values?.roas ?? null };
    const draft: DecisionDraft = { id: previous?.id ?? randomUUID(), version: (previous?.version ?? 0) + 1, workspaceId: this.workspaceId, investigationId: run.id, scenario: run.scenario ?? 'margin', state: 'draft', environment: e.source === 'demo' ? 'simulation' : 'analysis_only', selectedKind: kind, selected, alternatives, scope: { shop: row.shop_id, channel: row.channel, sku: row.sku_id, date: row.date, source: e.source, warehouse: 'warehouse_id' in row ? row.warehouse_id : null, campaign: 'campaign_id' in row ? row.campaign_id : null }, before, after, note, evidenceIds: [...new Set([...run.report.observations, ...run.report.hypotheses].flatMap(c => c.evidenceIds))], evidenceHash: hashOf(e), recordId: e.id, ruleVersion: e.ruleVersion, reportHash: digest(run.report), policyVersion: DECISION_POLICY, actionHash: '', createdAt: previous?.createdAt ?? now, updatedAt: now, expiresAt: new Date(Date.now() + 1800000).toISOString(), submissionBlockers: [], request: null };
    draft.actionHash = actionHash(draft); return draft;
  }
  private blockers(d: DecisionDraft): string[] {
    const reasons: string[] = []; const run = this.run(d.investigationId); const e = run.evidence;
    if (d.selectedKind === 'observe') reasons.push('观察方案无需动作审批；可保存并继续补证');
    if (d.environment !== 'simulation' || e.source !== 'demo') reasons.push('当前仅支持演示数据的模拟审批；CSV经营数据需实时Adapter与业务权限校验');
    if (run.mode !== 'model' || run.report?.reviewer.mode !== 'model' || run.report.reviewer.verdict !== 'passed' || run.state !== 'completed') reasons.push('需要真实模型Reviewer通过，离线演示或待补证报告不能提交');
    if (!d.selected.passed) reasons.push(...d.selected.constraints, '所选方案未通过硬约束');
    if (('metrics' in e ? e.metrics.issues : e.calculation.issues).length) reasons.push('冻结证据缺少关键字段或口径冲突');
    const age = Date.now() - Date.parse(e.importedAt); if (!Number.isFinite(age) || age > 86400000 || age < -300000) reasons.push('演示证据导入时间超过24小时或时间异常，请更新证据并重新调查');
    if (Date.now() >= Date.parse(d.expiresAt)) reasons.push('草稿30分钟有效期已过，请保存新版本');
    const current = this.current().find(r => r.id === e.id);
    if (!current || hashOf(current) !== d.evidenceHash || current.ruleVersion !== d.ruleVersion || JSON.stringify(current.row) !== JSON.stringify(e.row) || ('metrics' in current ? current.metrics.issues : current.calculation.issues).length) reasons.push('当前业务快照、规则或质量已变化，请重新调查');
    if (d.policyVersion !== DECISION_POLICY || d.actionHash !== actionHash(d) || d.reportHash !== digest(run.report)) reasons.push('参数摘要、复核或规则版本变化，需重新生成草稿');
    try { const recalculated = this.make(run, d.selectedKind, d.note); recalculated.id = d.id; recalculated.version = d.version; recalculated.expiresAt = d.expiresAt;
      if (actionHash(recalculated) !== d.actionHash) reasons.push('方案计算规则发生变化，请重新生成草稿');
    } catch { reasons.push('调查方案与当前测算不一致，请重新调查'); }
    return [...new Set(reasons)];
  }
  private view(d: DecisionDraft): DecisionDraft {
    const latest = this.raw(d.id); const stored = this.db.query<JsonRow, [string, number]>('SELECT json FROM decision_requests WHERE decision_id=? AND version=?').get(d.id, d.version);
    const request = stored ? JSON.parse(stored.json) as ApprovalRequest : null;
    const expired = Date.now() >= Date.parse(d.expiresAt);
    if (request) request.status = latest.version !== d.version ? 'superseded' : expired ? 'expired' : 'pending';
    return { ...d, state: latest.version !== d.version ? 'superseded' : expired ? 'expired' : request ? 'pending_approval' : 'draft', request, submissionBlockers: this.blockers(d) };
  }
  list(): DecisionDraft[] { return this.db.query<JsonRow, []>("SELECT json FROM decisions ORDER BY json_extract(json,'$.updatedAt') DESC,rowid DESC LIMIT 50").all().map(r => this.view(JSON.parse(r.json) as DecisionDraft)); }
  forInvestigation(runId: string): DecisionDraft[] { const row = this.db.query<JsonRow, [string]>('SELECT json FROM decisions WHERE run_id=?').get(runId); return row ? [this.view(JSON.parse(row.json) as DecisionDraft)] : []; }
  history(id: string): DecisionDraft[] { this.raw(id); return this.db.query<JsonRow, [string]>('SELECT json FROM decision_versions WHERE id=? ORDER BY version DESC LIMIT 30').all(id).map(r => this.view(JSON.parse(r.json) as DecisionDraft)); }
  private save(d: DecisionDraft, event: string): void {
    this.db.query('INSERT INTO decisions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json').run(d.id, d.investigationId, d.version, JSON.stringify(d));
    this.db.query('INSERT INTO decision_versions VALUES(?,?,?)').run(d.id, d.version, JSON.stringify(d));
    this.db.query('INSERT INTO decision_events(decision_id,version,event,at,actor) VALUES(?,?,?,?,?)').run(d.id, d.version, event, d.updatedAt, 'local-analyst');
  }
  create(runId: string, kind: Scenario['kind'], note: string): DecisionDraft {
    return this.db.transaction(() => { const existing = this.db.query<{id:string}, [string]>('SELECT id FROM decisions WHERE run_id=?').get(runId); if (existing) return this.view(this.raw(existing.id)); const d = this.make(this.run(runId), kind, note); this.save(d, 'created'); return this.view(d); }).immediate();
  }
  revise(id: string, expectedVersion: number, kind: Scenario['kind'], note: string): DecisionDraft {
    return this.db.transaction(() => { const old = this.raw(id); if (old.version !== expectedVersion) throw new Error('版本冲突：草稿已更新，请刷新后重试'); const d = this.make(this.run(old.investigationId), kind, note, old); this.save(d, 'revised'); return this.view(d); }).immediate();
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
