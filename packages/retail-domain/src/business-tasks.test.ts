import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { DecisionStore } from './decisions';
import { DEMO_CSV, RetailRequestSchema } from './operations';
import { runInvestigation, type ModelPort, type AnyInvestigation } from './investigations';
import { backupInventory, captureBackup, restoreBackup } from './backup';
import { TaskQuerySchema, type TaskCreate } from './business-task-contract';

let dir: string, file: string, data: RetailStore, signals: SignalStore, runs: InvestigationStore, decisions: DecisionStore;
const current = () => [...data.snapshot().records, ...signals.snapshot().records];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merqo-business-tasks-')); mkdirSync(join(dir, 'retail'));
  file = join(dir, 'retail/operations.sqlite'); data = new RetailStore(file); data.import(DEMO_CSV, undefined, 'demo');
  signals = new SignalStore(file + '.signals.sqlite'); signals.demo(); runs = new InvestigationStore(file + '.investigations.sqlite'); decisions = new DecisionStore(file, 'task-space', current);
});
afterEach(() => {
  setSystemTime(); decisions.close(); runs.close(); signals.close(); data.close();
  if (!dir.startsWith(join(tmpdir(), 'merqo-business-tasks-'))) throw Error('Unsafe test cleanup target');
  rmSync(dir, { recursive: true, force: true });
});
const model: ModelPort = async (system, prompt) => {
  if (system.includes('串行只读 Reviewer')) return JSON.stringify({ verdict: 'passed', notes: ['任务测试协议夹具'] });
  const context = JSON.parse(prompt), tools = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'];
  if (context.observations.length < 4) return JSON.stringify({ tool: tools[context.observations.length] });
  return JSON.stringify({ report: { summary: '用于任务关联的合成报告', observations: [], hypotheses: [], unknowns: ['缺实时状态'], alternatives: ['可能存在口径差异'], options: [{ kind: 'observe', rationale: '核验' }, { kind: 'reduce_coupon', rationale: '仅作条件测算' }] } });
};
async function complete(mode: 'replay' | 'model' = 'replay') {
  const run = runs.create(data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!, mode, true).run;
  const report = await runInvestigation(run, mode === 'model' ? model : null, async event => { runs.update(run.id, { event }); });
  return runs.update(run.id, { report });
}
function createInput(run: AnyInvestigation): TaskCreate {
  return { op: 'task_create', origin: { kind: 'investigation', id: run.id }, purpose: 'analysis_followup', title: '核对商品毛利证据', description: '核对成本和优惠声明', owner: '门店运营', dueAt: new Date(Date.now() + 86400000).toISOString(), priority: 'normal' };
}
const page = () => decisions.tasks(TaskQuerySchema.parse({ op: 'tasks' }));

test('creation binds server evidence, entity scope and durable origin; retries do not duplicate or overwrite', async () => {
  const run = await complete(), input = createInput(run), created = decisions.createTask(input);
  expect(created.created).toBe(true); expect(created.detail.task.scope.sku).toBe('TEA-500'); expect(created.detail.task.scope.shop).toBe(run.evidence.row.shop_id);
  expect(created.detail.task.evidence.evidenceHash).toBe('hash' in run.evidence ? run.evidence.hash : run.evidence.snapshotHash); expect(created.detail.task.entityKey).toHaveLength(64);
  const repeated = decisions.createTask({ ...input, owner: '重复请求不应覆盖', title: '重复' });
  expect(repeated.created).toBe(false); expect(repeated.detail.task.id).toBe(created.detail.task.id); expect(repeated.detail.task.owner).toBe('门店运营'); expect(repeated.detail.eventCount).toBe(1);
  expect(page().total).toBe(1);
});
test('unreported investigation and forged authority/scope fields cannot create business tasks', async () => {
  const run = runs.create(data.snapshot().records[0]!, 'replay', true).run;
  expect(() => decisions.createTask(createInput(run))).toThrow('报告');
  const finished = await complete();
  for (const field of ['workspaceId', 'evidence', 'actor', 'scope', 'receiptId']) expect(RetailRequestSchema.safeParse({ ...createInput(finished), [field]: 'forged' }).success).toBe(false);
  expect(() => decisions.createTask({ ...createInput(finished), purpose: 'simulation_action' })).toThrow('模拟方案');
});
test('edit, notes, completion and reopen retain history and enforce expected version across connections', async () => {
  const run = await complete(), original = decisions.createTask(createInput(run)).detail.task;
  const other = new DecisionStore(file, 'task-space', current);
  try {
    const edited = other.mutateTask({ op: 'task_edit', id: original.id, expectedVersion: 1, title: original.title, owner: '库存跟进人', priority: 'high', dueAt: original.dueAt, note: '明确跟进人' });
    expect(edited.task.version).toBe(2); expect(edited.events[1]?.snapshot.owner).toBe('门店运营');
    expect(() => decisions.mutateTask({ op: 'task_transition', id: original.id, expectedVersion: 1, status: 'done', note: '过期版本' })).toThrow('版本冲突');
    const completed = decisions.mutateTask({ op: 'task_transition', id: original.id, expectedVersion: 2, status: 'done', note: '证据核对结束，不代表业务执行' });
    expect(completed.task.status).toBe('done'); expect(() => decisions.mutateTask({ op: 'task_transition', id: original.id, expectedVersion: 3, status: 'doing', note: '跳过重新打开' })).toThrow('重新打开');
    const reopened = decisions.mutateTask({ op: 'task_transition', id: original.id, expectedVersion: 3, status: 'open', note: '需要再跟进新疑点' });
    const noted = decisions.mutateTask({ op: 'task_note', id: original.id, expectedVersion: reopened.task.version, note: '保留新的核对记录' });
    expect(noted.eventCount).toBe(5); expect(noted.events[0]?.action).toBe('noted'); expect(noted.events.at(-1)?.snapshot.version).toBe(1);
  } finally { other.close(); }
});
test('simulated action completion requires exact approval and successful receipt; tasks never execute for the user', async () => {
  const run = await complete('model'), draft = decisions.create(run.id, 'reduce_coupon', '测试方案');
  const task = decisions.createTask({ ...createInput(run), origin: { kind: 'decision', id: draft.id, version: 1 }, purpose: 'simulation_action' }).detail.task;
  expect(() => decisions.mutateTask({ op: 'task_transition', id: task.id, expectedVersion: 1, status: 'done', note: '无回执' })).toThrow('成功模拟执行回执');
  expect(decisions.forInvestigation(run.id)[0]?.request).toBeNull(); expect(decisions.executions()).toHaveLength(0);
  const pending = decisions.submit(draft.id, 1); expect(decisions.task(task.id).link.approvalId).toBe(pending.request!.id);
  decisions.resolveApproval(pending.request!.id, 1, draft.actionHash, 'approve', '核验模拟方案', { id: 'local-simulation-approver', role: 'approver', environment: 'simulation' });
  expect(() => decisions.mutateTask({ op: 'task_transition', id: task.id, expectedVersion: 1, status: 'done', note: '仅批准尚未执行' })).toThrow('成功模拟执行回执');
  const job = decisions.executions()[0]!;
  const executed = decisions.executeSimulation(job.job.id, 1, draft.actionHash, { id: 'local-simulation-executor', role: 'executor', environment: 'simulation' });
  const done = decisions.mutateTask({ op: 'task_transition', id: task.id, expectedVersion: 1, status: 'done', note: '已核对本机模拟回执' });
  expect(done.link.receiptId).toBe(executed.receipt!.id); expect(done.task.status).toBe('done'); expect(data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!.row.coupon_minor).toBe(2000);
});
test('revised decision is not silently rebound to an old task, and different task purposes are distinct', async () => {
  const run = await complete('model'), d = decisions.create(run.id, 'reduce_coupon', '');
  const input = { ...createInput(run), origin: { kind: 'decision' as const, id: d.id, version: 1 } };
  const followup = decisions.createTask(input), action = decisions.createTask({ ...input, purpose: 'simulation_action' });
  expect(action.detail.task.id).not.toBe(followup.detail.task.id);
  decisions.revise(d.id, 1, 'observe', '保留旧版记录');
  const old = decisions.task(action.detail.task.id); expect(old.link.stale).toBe(true); expect(old.task.origin.decisionVersion).toBe(1);
  expect(() => decisions.mutateTask({ op: 'task_transition', id: old.task.id, expectedVersion: 1, status: 'done', note: '旧版不能借新版回执完成' })).toThrow('回执');
  expect(() => decisions.createTask({ ...input, purpose: 'simulation_action' })).not.toThrow(); // Idempotent retry opens the original task.
});
test('overdue, status, literal search and pagination counts stay scoped and independent', async () => {
  const a = await complete(), first = decisions.createTask({ ...createInput(a), dueAt: new Date(Date.now() - 3600000).toISOString(), owner: '运营%一' }).detail;
  const b = await complete(), second = decisions.createTask({ ...createInput(b), title: '另一项', priority: 'high' }).detail;
  expect(page().counts.overdue).toBe(1);
  const limited = decisions.tasks(TaskQuerySchema.parse({ op: 'tasks', limit: 1 })); expect(limited.total).toBe(2); expect(limited.items[0]?.task.id).toBe(second.task.id);
  const literal = decisions.tasks(TaskQuerySchema.parse({ op: 'tasks', search: '%' })); expect(literal.total).toBe(1); expect(literal.counts.open).toBe(2);
  decisions.mutateTask({ op: 'task_transition', id: first.task.id, expectedVersion: 1, status: 'cancelled', note: '人工取消' }); expect(page().counts.overdue).toBe(0);
  expect(decisions.tasks(TaskQuerySchema.parse({ op: 'tasks', overdueOnly: true })).total).toBe(0);
});
test('workspace-scoped detail and mutation reject a task owned by a different workspace', async () => {
  const run = await complete(), task = decisions.createTask(createInput(run)).detail.task;
  const other = new DecisionStore(file, 'other-space', current);
  try { expect(other.tasks(TaskQuerySchema.parse({ op: 'tasks' })).total).toBe(0); expect(() => other.task(task.id)).toThrow('当前工作空间'); expect(() => other.mutateTask({ op: 'task_note', id: task.id, expectedVersion: 1, note: '越界' })).toThrow('当前工作空间'); } finally { other.close(); }
});
test('restart retains task evidence, history and entity identity; backup restore retains the task tables', async () => {
  const run = await complete(), before = decisions.createTask(createInput(run)).detail;
  decisions.close(); decisions = new DecisionStore(file, 'task-space', current); expect(decisions.task(before.task.id)).toEqual(before);
  const inventory = backupInventory(join(dir, 'retail')), payload = captureBackup(join(dir, 'retail'), 'task-space', '任务备份', [], inventory.connectionHash);
  const target = join(dir, 'restored'); restoreBackup(payload, target);
  const restored = new DecisionStore(join(target, 'retail/operations.sqlite'), 'task-space', current);
  try { expect(restored.task(before.task.id)).toEqual(before); } finally { restored.close(); }
});
test('schema 8 upgrades with a backup before installing task and workbench tables and declaring schema 10', () => {
  decisions.close(); const db = new Database(file + '.investigations.sqlite'); db.exec('DELETE FROM decision_schema; INSERT INTO decision_schema VALUES(8); PRAGMA user_version=8; DROP TABLE business_task_events; DROP TABLE business_tasks;'); db.close();
  decisions = new DecisionStore(file, 'task-space', current); expect(page().total).toBe(0);
  expect(readdirSync(join(dir, 'retail')).some(name => name.includes('.investigations.backup-v8-'))).toBe(true);
  const check = new Database(file + '.investigations.sqlite', { readonly: true }); try { expect(check.query('PRAGMA user_version').get()).toEqual({ user_version: 10 }); } finally { check.close(); }
});
