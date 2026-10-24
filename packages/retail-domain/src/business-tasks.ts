import { createHash, randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { AnyInvestigation } from './investigations';
import type { DecisionDraft } from './decisions';
import type { ExecutionView } from './simulation';
import { TaskCreateSchema, TaskQuerySchema, TaskPublicSchemas, type BusinessTask, type TaskCreate, type TaskQuery, type TaskMutation, type TaskView, type TaskEvent, type TaskDetail, type TaskPage } from './business-task-contract';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
interface Row { json: string }
export function installTaskSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS business_tasks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,origin_key TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,due_at TEXT NOT NULL,updated_at TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),UNIQUE(workspace_id,origin_key)) STRICT;
    CREATE INDEX IF NOT EXISTS business_tasks_due ON business_tasks(workspace_id,status,due_at,id);
    CREATE INDEX IF NOT EXISTS business_tasks_recent ON business_tasks(workspace_id,updated_at DESC,id);
    CREATE TABLE IF NOT EXISTS business_task_events(task_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(task_id,version)) STRICT;`);
}
/** Called inside DecisionStore's IMMEDIATE transaction; never submits, approves or executes a decision. */
export class TaskLedger {
  constructor(private db: Database, private workspaceId: string, private run: (id: string) => AnyInvestigation, private decision: (id: string) => DecisionDraft, private execution: (id: string, version: number) => ExecutionView | null) {}
  private raw(id: string): BusinessTask {
    const row = this.db.query<Row, [string, string]>('SELECT json FROM business_tasks WHERE id=? AND workspace_id=?').get(id, this.workspaceId);
    if (!row) throw Error('任务不存在或不属于当前工作空间');
    return JSON.parse(row.json);
  }
  private view(task: BusinessTask): TaskView {
    const link: TaskView['link'] = { decisionState: null, approvalId: null, executionId: null, receiptId: null, stale: false, warning: null };
    if (task.origin.decisionId) {
      try {
        const decision = this.decision(task.origin.decisionId);
        link.decisionState = decision.state;
        link.stale = decision.version !== task.origin.decisionVersion || decision.actionHash !== task.origin.actionHash;
        if (link.stale) link.warning = '原方案已有新版本，请从新版本创建任务；本任务保留旧版证据。';
        else {
          link.approvalId = decision.request?.id ?? null;
          if (['expired', 'invalidated', 'superseded', 'rejected'].includes(decision.state)) link.warning = '方案未获有效批准，请回到原方案核对；任务操作不能改变审批结论。';
        }
        const executed = this.execution(decision.id, task.origin.decisionVersion!);
        link.executionId = executed?.job.id ?? null;
        link.receiptId = executed?.status === 'succeeded' && executed.receipt?.actionHash === task.origin.actionHash ? executed.receipt.id : null;
      } catch { link.stale = true; link.warning = '原方案或执行记录暂不可读取，请核对原始记录。'; }
    }
    return { task, overdue: !['done', 'cancelled'].includes(task.status) && Date.parse(task.dueAt) < Date.now(), link };
  }
  detail(id: string): TaskDetail {
    const task = this.raw(id);
    const events = this.db.query<Row, [string]>('SELECT json FROM business_task_events WHERE task_id=? ORDER BY version DESC LIMIT 100').all(id).map(row => JSON.parse(row.json) as TaskEvent);
    const eventCount = this.db.query<{ n: number }, [string]>('SELECT count(*) n FROM business_task_events WHERE task_id=?').get(id)!.n;
    return { ...this.view(task), events, eventCount };
  }
  private event(task: BusinessTask, action: TaskEvent['action'], from: BusinessTask['status'] | null, note: string) {
    const event: TaskEvent = { version: task.version, at: task.updatedAt, action, from, to: task.status, note, actor: 'local-operator', snapshot: task };
    this.db.query('INSERT INTO business_task_events VALUES(?,?,?)').run(task.id, task.version, JSON.stringify(event));
  }
  create(input: TaskCreate): { detail: TaskDetail; created: boolean } {
    const request = TaskCreateSchema.parse(input);
    const originKey = JSON.stringify([request.origin.kind, request.origin.id, request.origin.kind === 'decision' ? request.origin.version : null, request.purpose]);
    const existing = this.db.query<{ id: string }, [string, string]>('SELECT id FROM business_tasks WHERE workspace_id=? AND origin_key=?').get(this.workspaceId, originKey);
    if (existing) return { detail: this.detail(existing.id), created: false };
    const decision = request.origin.kind === 'decision' ? this.decision(request.origin.id) : null;
    if (decision && decision.version !== (request.origin.kind === 'decision' ? request.origin.version : null)) throw Error('方案版本已变化，请刷新后创建任务');
    const run = this.run(decision?.investigationId ?? request.origin.id);
    if (!run.report || !['completed', 'needs_evidence'].includes(run.state)) throw Error('请等待调查形成报告后再创建任务');
    if (request.purpose === 'simulation_action' && (!decision || decision.environment !== 'simulation' || decision.selectedKind === 'observe')) throw Error('模拟方案处理任务必须关联可执行的本地模拟方案');
    const evidence = run.evidence, row = evidence.row, now = new Date().toISOString();
    const evidenceHash = 'hash' in evidence ? evidence.hash : evidence.snapshotHash;
    const scope: BusinessTask['scope'] = { source: evidence.source, sourceId: evidence.provenance?.sourceId ?? null, shop: row.shop_id, channel: row.channel, sku: row.sku_id, spec: 'spec' in row ? row.spec : null, date: row.date, scenario: run.scenario ?? 'margin', warehouse: 'warehouse_id' in row ? row.warehouse_id : null, campaign: 'campaign_id' in row ? row.campaign_id : null };
    const caseReferences=this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='wb_experience'").get()?this.db.query<Row,[string,string]>("SELECT json FROM wb_experience WHERE workspace_id=? AND kind='reference' AND scope=? ORDER BY at,id LIMIT 20").all(this.workspaceId,run.id).map(r=>JSON.parse(r.json)):[];
    const operational=run.relatedEvidence?.operational;
    const task: BusinessTask = { ...(operational?{operationalContext:{...operational,items:operational.items.map(({record,...ref})=>ref)}}:{}),caseReferences, id: randomUUID(), workspaceId: this.workspaceId, version: 1, title: request.title, description: request.description, owner: request.owner, dueAt: new Date(request.dueAt).toISOString(), priority: request.priority, purpose: request.purpose, status: 'open', createdAt: now, updatedAt: now,
      origin: { investigationId: run.id, decisionId: decision?.id ?? null, decisionVersion: decision?.version ?? null, actionHash: decision?.actionHash ?? null }, scope,
      entityKey: digest([scope.source, scope.sourceId ?? evidenceHash, scope.shop, scope.channel, scope.sku, scope.spec, scope.warehouse, scope.campaign]),
      evidence: { recordId: run.recordId, evidenceHash, reportHash: digest(run.report), summary: run.report.summary, reviewer: run.report.reviewer.verdict, mode: run.mode, ruleVersion: evidence.ruleVersion } };
    this.db.query('INSERT INTO business_tasks VALUES(?,?,?,?,?,?,?,?)').run(task.id, this.workspaceId, originKey, 1, task.status, task.dueAt, now, JSON.stringify(task));
    this.event(task, 'created', null, task.description || '从已保存调查或方案创建');
    return { detail: this.detail(task.id), created: true };
  }
  mutate(input: TaskMutation): TaskDetail {
    const request = input.op === 'task_edit' ? TaskPublicSchemas[3].parse(input) : input.op === 'task_transition' ? TaskPublicSchemas[4].parse(input) : TaskPublicSchemas[5].parse(input);
    const task = this.raw(request.id);
    if (task.version !== request.expectedVersion) throw Error('任务版本冲突，请刷新后重试');
    const from = task.status;
    if (request.op === 'task_edit') {
      if (['done', 'cancelled'].includes(task.status)) throw Error('请先重新打开任务，再修改跟进信息');
      Object.assign(task, { title: request.title, owner: request.owner, dueAt: new Date(request.dueAt).toISOString(), priority: request.priority });
    } else if (request.op === 'task_transition') {
      if (request.status === task.status) throw Error('任务已经处于该状态，请刷新后核对');
      if (['done', 'cancelled'].includes(task.status) && request.status !== 'open') throw Error('已结束任务只能先重新打开');
      if (request.status === 'done' && task.purpose === 'simulation_action') {
        const view = this.view(task);
        if (view.link.stale || !view.link.receiptId) throw Error('尚无当前绑定方案的成功模拟执行回执，不能标记处理完成');
      }
      task.status = request.status;
    }
    task.version++; task.updatedAt = new Date().toISOString();
    const result = this.db.query('UPDATE business_tasks SET version=?,status=?,due_at=?,updated_at=?,json=? WHERE id=? AND workspace_id=? AND version=?').run(task.version, task.status, task.dueAt, task.updatedAt, JSON.stringify(task), task.id, this.workspaceId, request.expectedVersion);
    if (result.changes !== 1) throw Error('任务版本冲突，请刷新后重试');
    this.event(task, request.op === 'task_edit' ? 'edited' : request.op === 'task_transition' ? 'transitioned' : 'noted', from, request.note);
    return this.detail(task.id);
  }
  page(input: TaskQuery): TaskPage {
    const query = TaskQuerySchema.parse(input), counts: TaskPage['counts'] = { open: 0, doing: 0, blocked: 0, done: 0, cancelled: 0, overdue: 0 };
    const now = new Date().toISOString();
    for (const row of this.db.query<{ status: BusinessTask['status']; n: number }, [string]>('SELECT status,count(*) n FROM business_tasks WHERE workspace_id=? GROUP BY status').all(this.workspaceId)) counts[row.status] = row.n;
    counts.overdue = this.db.query<{ n: number }, [string, string]>("SELECT count(*) n FROM business_tasks WHERE workspace_id=? AND status NOT IN ('done','cancelled') AND due_at<?").get(this.workspaceId, now)!.n;
    const where = "workspace_id=? AND (?='all' OR status=?) AND (?=0 OR (status NOT IN ('done','cancelled') AND due_at<?)) AND (?='' OR instr(lower(json_extract(json,'$.title')||' '||json_extract(json,'$.owner')||' '||json_extract(json,'$.scope.shop')||' '||json_extract(json,'$.scope.sku')),lower(?))>0)";
    const args = [this.workspaceId, query.status, query.status, query.overdueOnly ? 1 : 0, now, query.search, query.search] as const;
    const total = this.db.query(`SELECT count(*) n FROM business_tasks WHERE ${where}`).get(...args) as { n: number };
    const rows = this.db.query(`SELECT json FROM business_tasks WHERE ${where} ORDER BY CASE json_extract(json,'$.priority') WHEN 'high' THEN 0 ELSE 1 END,due_at,id LIMIT ? OFFSET ?`).all(...args, query.limit, query.offset) as Row[];
    return { items: rows.map(row => this.view(JSON.parse(row.json))), total: total.n, offset: query.offset, limit: query.limit, counts, checkedAt: now };
  }
}
