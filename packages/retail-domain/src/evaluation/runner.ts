import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { selectOffers } from '../offers';
import { RetailStore } from '../store';
import { SignalStore } from '../signal-store';
import { InvestigationStore } from '../investigation-store';
import { DecisionStore } from '../decisions';
import { DEMO_CSV, IMPORT_FIELDS, RetailRequestSchema, previewCsv, type EvidenceRecord } from '../operations';
import { ADS_FIELDS, INVENTORY_FIELDS, INVENTORY_EXECUTION_DEMO } from '../signals';
import { readTool, simulate, runInvestigation, isSignalInvestigation } from '../investigations';
import { runSignalInvestigation } from '../signal-investigations';
import type { AnyInvestigation, ModelPort, Trace } from '../investigations';
import { auditMarginNumbers } from '../margin-numeric';
import { evidenceTimeIssue } from '../evidence-policy';
import { BUSINESS_CASES, FAULT_CASES, PROTOCOL_FIXTURES, EVAL_VERSION, type BusinessCase, type Expected } from './catalog';

type CaseResult = {
  id: string; category: string; status: 'passed' | 'failed' | 'unsupported';
  expected: string; actual: unknown; evidence: unknown; durationMs: number;
};
const csv = (fields: readonly string[], rows: object[]): string => [fields.join(','), ...rows.map(row => fields.map(key => {
  const value = (row as Record<string, unknown>)[key];
  return '"' + (value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""') + '"';
}).join(','))].join('\n');
const TOOLS = ['retail_get_data_health', 'retail_get_sku_context', 'retail_get_promotions', 'retail_simulate_actions'] as const;
function auditTrace(record: EvidenceRecord): Trace[] {
  return TOOLS.map(tool => ({ at: '2026-10-17T04:00:00Z', stage: 'investigate', tool, evidenceId: `${record.id}:${tool}`, data: readTool(record, tool) }));
}

/** A protocol fixture only; never counted as a live-model evaluation. */
function protocolFixture(run: AnyInvestigation): ModelPort {
  return async (system, prompt) => {
    if (system.includes('串行只读 Reviewer')) return JSON.stringify({ verdict: 'passed', notes: ['评测协议夹具，不是真实模型质量'] });
    const context = JSON.parse(prompt) as { observations: unknown[] };
    const tools = ['retail_get_data_health', 'retail_get_sku_context', run.scenario === 'ads' ? 'retail_get_campaigns' : run.scenario === 'inventory' ? 'retail_get_inventory' : 'retail_get_promotions', 'retail_simulate_actions'];
    if (context.observations.length < 4) return JSON.stringify({ tool: tools[context.observations.length] });
    return JSON.stringify({ report: {
      summary: '合成案例契约报告', observations: run.scenario !== 'inventory' ? [] : [{ text: '核对工具证据', evidenceIds: [`${run.recordId}:${tools[2]}`] }],
      hypotheses: [], unknowns: ['缺实时状态'], alternatives: ['可能存在口径差异'], options: [
        { kind: 'observe', rationale: '核验' },
        { kind: run.scenario === 'ads' ? 'reduce_budget' : run.scenario === 'inventory' ? 'replenish_draft' : 'reduce_coupon', rationale: '仅作条件测算' },
      ],
    } });
  };
}
const approver = { id: 'local-simulation-approver', role: 'approver', environment: 'simulation' } as const;
const executor = { id: 'local-simulation-executor', role: 'executor', environment: 'simulation' } as const;

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'merqo-business-eval-'));
  readonly file = join(this.dir, 'operations.sqlite');
  readonly data = new RetailStore(this.file);
  readonly signals = new SignalStore(this.file + '.signals.sqlite');
  readonly runs = new InvestigationStore(this.file + '.investigations.sqlite');
  decisions = new DecisionStore(this.file, 'eval-workspace', () => this.current());
  current() { return [...this.data.snapshot().records, ...this.signals.snapshot().records]; }
  close(): void {
    this.decisions.close(); this.runs.close(); this.signals.close(); this.data.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
  seed(): void { this.data.import(DEMO_CSV, undefined, 'demo'); this.signals.demo(); this.signals.import('inventory', INVENTORY_EXECUTION_DEMO, undefined, 'demo'); }
  async pending(scenario: 'margin' | 'ads' | 'inventory' = 'margin') {
    const run = scenario === 'margin'
      ? this.runs.create(this.data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!, 'model', true).run
      : this.runs.createSignal(this.signals.snapshot().records.find(r => r.kind === scenario && r.row.sku_id === 'TEA-500')!, 'model', true).run;
    const emit = async (event: Trace) => { this.runs.update(run.id, { event }); };
    const model = protocolFixture(run);
    const report = isSignalInvestigation(run) ? await runSignalInvestigation(run, model, emit) : await runInvestigation(run, model, emit);
    this.runs.update(run.id, { report });
    const draft = this.decisions.create(run.id, scenario === 'ads' ? 'reduce_budget' : scenario === 'inventory' ? 'replenish_draft' : 'reduce_coupon', '评测协议夹具，仅模拟');
    return this.decisions.submit(draft.id, draft.version);
  }
  async approved(scenario: 'margin' | 'ads' | 'inventory' = 'margin') {
    const draft = await this.pending(scenario); const r = draft.request!;
    this.decisions.resolveApproval(r.id, r.decisionVersion, r.actionHash, 'approve', '本地评测', approver);
    return this.decisions.executions().find(e => e.job.requestId === r.id)!;
  }
  sql(action: (db: Database) => void): void {
    const db = new Database(this.file + '.investigations.sqlite'); try { action(db); } finally { db.close(); }
  }
}

function business(h: Harness, test: BusinessCase): { state: Expected; evidence: unknown } {
  const input = test.input;
  if (input.kind === 'offer') {
    const content = csv(IMPORT_FIELDS, [input.row]); const preview = previewCsv(content);
    if (!preview.valid.length) return { state: 'rejected', evidence: preview.rejected };
    h.data.import(content, undefined, 'demo'); const record = h.data.snapshot().records[0]!;
    const selection = selectOffers(record.row);
    if (test.expectedValues) for (const [key, value] of Object.entries(test.expectedValues)) assert.equal(selection[key as keyof typeof selection], value, key);
    const trace = auditTrace(record); const numericAudit = auditMarginNumbers(record, simulate(record), trace);
    if (selection.status === 'needs_evidence') assert.equal(record.calculation.profitMinor, null);
    else assert.equal(record.calculation.revenueMinor, 8000, '参考报价不得替换成交收入');
    return { state: selection.status === 'selected' ? 'accepted' : 'needs_evidence', evidence: { record, selection, trace, numericAudit } };
  }
  if (input.kind === 'margin') {
    const content = csv(IMPORT_FIELDS, input.rows); const preview = previewCsv(content);
    if (!preview.valid.length) return { state: 'rejected', evidence: preview.rejected };
    h.data.import(content, undefined, 'demo'); const records = h.data.snapshot().records;
    const r = records[0]!;
    if (test.expectedValues) for (const [key, value] of Object.entries(test.expectedValues)) assert.equal(r.calculation[key as keyof typeof r.calculation], value, key);
    return { state: records.some(r => r.status === 'needs_evidence') ? 'needs_evidence' : records.some(r => r.status === 'low_margin') ? 'warning' : 'normal', evidence: records };
  }
  if (input.kind === 'inventory' || input.kind === 'ads') {
    h.signals.import(input.kind, csv(input.kind === 'ads' ? ADS_FIELDS : INVENTORY_FIELDS, [input.row]), undefined, 'demo');
    const r = h.signals.snapshot().records[0]!; return { state: r.status, evidence: r };
  }
  if (input.kind === 'freshness') {
    const issue = evidenceTimeIssue(input, input.now); return { state: issue ? 'blocked' : 'accepted', evidence: { ...input, issue } };
  }
  if (input.kind === 'audit') {
    h.data.import(DEMO_CSV, undefined, 'demo'); const r = h.data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!;
    let trace = auditTrace(r);
    if (input.mutation === 'missing_context') trace = trace.filter(t => t.tool !== 'retail_get_sku_context');
    if (input.mutation === 'missing_promotions') trace = trace.filter(t => t.tool !== 'retail_get_promotions');
    const event = trace.find(t => t.tool === 'retail_get_sku_context');
    if (event && input.mutation === 'wrong_sku') event.data = { ...(event.data as object), sku: 'OTHER-SKU' };
    if (event && input.mutation === 'wrong_profit') {
      const data = event.data as { calculation: object };
      event.data = { ...data, calculation: { ...data.calculation, profitMinor: 999999 } };
    }
    try { const audit = auditMarginNumbers(r, simulate(r), trace); return { state: 'accepted', evidence: { audit, trace } }; }
    catch (error) { return { state: 'blocked', evidence: { rejection: String(error), trace } }; }
  }
  throw new Error('Unsupported input must be handled before execution');
}

/** Clock override is confined to a single awaited case and always restored. */
function atTime<T>(now: number, action: () => T): T {
  const original = Date.now; Date.now = () => now; try { return action(); } finally { Date.now = original; }
}
async function fault(h: Harness, id: string): Promise<unknown> {
  h.seed();
  if (id === 'fault.unapproved') {
    const d = await h.pending(); assert.equal(h.decisions.executions().length, 0);
    assert.throws(() => h.decisions.executeSimulation('0'.repeat(64), 1, d.actionHash, executor));
    assert.equal(h.decisions.executions().length, 0);
    return { state: 'pending_approval', tasks: 0, investigations: h.runs.listAll(), approvals: h.decisions.approvals() };
  }
  const item = await h.approved(); const j = item.job;
  const original = JSON.stringify(h.current());
  const execute = () => h.decisions.executeSimulation(j.id, j.decisionVersion, j.actionHash, executor);
  let evidence: unknown;
  switch (id) {
    case 'fault.expired': {
      const result = atTime(Date.parse(j.expiresAt), execute);
      assert.equal(result.receipt, null); assert.equal(result.current, null); assert.equal(result.status, 'failed');
      assert.match(result.attempts[0]!.reason, /有效期/); evidence = result; break;
    }
    case 'fault.hash_substitution':
      assert.throws(() => h.decisions.executeSimulation(j.id, j.decisionVersion, '0'.repeat(64), executor), /摘要/);
      assert.equal(h.decisions.executions()[0]!.receipt, null); evidence = { rejected: 'digest', receipt: null }; break;
    case 'fault.cross_workspace': {
      const other = new DecisionStore(h.file, 'other-workspace', () => h.current());
      try { assert.throws(() => other.executeSimulation(j.id, j.decisionVersion, j.actionHash, executor), /工作空间/); }
      finally { other.close(); } assert.equal(h.decisions.executions()[0]!.receipt, null); evidence = { rejected: 'workspace', receipt: null }; break;
    }
    case 'fault.forged_role': {
      assert.throws(() => h.decisions.executeSimulation(j.id, j.decisionVersion, j.actionHash, null), /角色/);
      const parsed = RetailRequestSchema.safeParse({ op: 'simulation_execute', id: j.id, expectedVersion: j.decisionVersion, expectedActionHash: j.actionHash, actor: executor, environment: 'production' });
      assert.equal(parsed.success, false); assert.equal(h.decisions.executions()[0]!.receipt, null); evidence = { roleRejected: true, rendererRejected: true, receipt: null }; break;
    }
    case 'fault.duplicate': {
      const first = execute(); const second = execute(); assert.ok(first.receipt); assert.equal(second.receipt?.id, first.receipt.id);
      assert.equal(second.current?.version, 1); assert.equal(second.attempts.length, 1); evidence = second; break;
    }
    case 'fault.superseded': {
      h.decisions.revise(j.decisionId, j.decisionVersion, 'reduce_coupon', '新版本'); const result = execute();
      assert.equal(result.receipt, null); assert.equal(result.current, null); evidence = result; break;
    }
    case 'fault.receipt_failure': {
      h.sql(db => db.exec("CREATE TRIGGER eval_disk_failure BEFORE INSERT ON simulation_receipts BEGIN SELECT RAISE(ABORT,'injected disk failure');END;"));
      const failed = execute(); assert.equal(failed.receipt, null); assert.equal(failed.current, null); assert.equal(failed.status, 'failed');
      h.sql(db => db.exec('DROP TRIGGER eval_disk_failure')); const done = execute(); assert.ok(done.receipt); assert.equal(done.current?.version, 1);
      evidence = { failed, done }; break;
    }
    case 'fault.restart': {
      const first = execute(); assert.ok(first.receipt); h.decisions.close();
      h.decisions = new DecisionStore(h.file, 'eval-workspace', () => h.current());
      const restored = execute(); assert.deepEqual(restored.receipt, first.receipt); assert.equal(restored.attempts.length, 1); evidence = restored; break;
    }
    case 'fault.reread_drift': {
      const done = execute(); assert.ok(done.receipt);
      const altered = { ...done.current!, version: 2, values: { couponMinor: 1000 } };
      h.sql(db => { db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify(altered), j.resourceKey); });
      const checked = h.decisions.reconcileExecution(j.id, executor); assert.equal(checked.reconciliation?.matched, false);
      assert.deepEqual(checked.current, altered); assert.deepEqual(checked.receipt, done.receipt); evidence = checked; break;
    }
    case 'fault.batch_partial':
    case 'fault.unknown': {
      const second = await h.approved('ads'); const jobs = [j, second.job];
      const b = h.decisions.createExecutionBatch(jobs.map(j => j.id), '隔离评测');
      if (id === 'fault.batch_partial') {
        // IDs are generated SHA-256 values; validate before using in DDL (SQLite cannot bind trigger predicates).
        assert.match(second.job.id, /^[a-f0-9]{64}$/);
        h.sql(db => db.exec(`CREATE TRIGGER eval_partial BEFORE INSERT ON simulation_receipts WHEN NEW.job_id='${second.job.id}' BEGIN SELECT RAISE(ABORT,'injected partial failure');END;`));
        const partial = h.decisions.runExecutionBatch(b.batch.id, executor); assert.equal(partial.status, 'partial');
        assert.ok(partial.items[0]!.receipt); assert.equal(partial.items[1]!.dispatch.status, 'failed');
        assert.throws(() => h.decisions.runExecutionBatch(b.batch.id, executor, j.id), /不能重放/);
        h.sql(db => db.exec('DROP TRIGGER eval_partial')); const done = h.decisions.runExecutionBatch(b.batch.id, executor, second.job.id);
        assert.equal(done.status, 'succeeded'); assert.deepEqual(done.items[0]!.receipt, partial.items[0]!.receipt); evidence = { partial, done };
      } else {
        const lease = h.decisions.claimBatchItem(b.batch.id, j.id, 'ready', executor);
        evidence = atTime(Date.now() + 16000, () => {
          const unknown = h.decisions.executionBatch(b.batch.id); assert.equal(unknown.status, 'unknown');
          assert.throws(() => h.decisions.runExecutionBatch(b.batch.id, executor), /待确认/);
          assert.throws(() => h.decisions.runExecutionBatch(b.batch.id, executor, j.id), /待确认/);
          const recovered = h.decisions.recoverExecutionBatch(b.batch.id, executor);
          assert.equal(recovered.items[0]!.dispatch.status, 'ready');
          assert.throws(() => h.decisions.executeSimulation(j.id, j.decisionVersion, j.actionHash, executor, lease), /租约已失效/);
          return { unknown, recovered, clock: 'synthetic +16000ms; no actual network timeout or process kill' };
        });
        assert.equal(h.decisions.runExecutionBatch(b.batch.id, executor).status, 'succeeded');
      }
      break;
    }
    default: throw new Error(`Unknown fault ${id}`);
  }
  assert.equal(JSON.stringify(h.current()), original, '原始经营快照不能被模拟执行修改');
  return { assertions: evidence, investigations: h.runs.listAll(), approvals: h.decisions.approvals(), executions: h.decisions.executions() };
}

export function summarize(results: readonly CaseResult[]) {
  return { total: results.length, passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length, unsupported: results.filter(r => r.status === 'unsupported').length };
}
export async function runBusinessEvaluation() {
  const startedAt = new Date().toISOString(); const results: CaseResult[] = [];
  for (const test of BUSINESS_CASES) {
    const start = performance.now();
    if (test.input.kind === 'unsupported') {
      results.push({ id: test.id, category: test.category, status: 'unsupported', expected: test.expected,
        actual: test.input.gap, evidence: { notExecuted: true, input: test.input }, durationMs: 0 }); continue;
    }
    const h = new Harness();
    try {
      const actual = business(h, test);
      results.push({ id: test.id, category: test.category, status: actual.state === test.expected ? 'passed' : 'failed', expected: test.expected, actual: actual.state, evidence: actual.evidence, durationMs: performance.now() - start });
    } catch (error) {
      results.push({ id: test.id, category: test.category, status: 'failed', expected: test.expected, actual: String(error), evidence: { input: test.input }, durationMs: performance.now() - start });
    } finally { h.close(); }
  }
  for (const test of FAULT_CASES) {
    const start = performance.now(); const h = new Harness();
    try { const evidence = await fault(h, test.id); results.push({ id: test.id, category: test.category, status: 'passed', expected: test.expected!, actual: 'assertions_satisfied', evidence, durationMs: performance.now() - start }); }
    catch (error) { results.push({ id: test.id, category: test.category, status: 'failed', expected: test.expected!, actual: String(error), evidence: { input: test.input }, durationMs: performance.now() - start }); }
    finally { h.close(); }
  }
  // Only actual detector outputs enter the confusion matrix. Audit/policy gates are separate.
  const labels = ['normal', 'warning', 'needs_evidence', 'rejected'] as const;
  const detectorCases = BUSINESS_CASES.filter(c => c.input.kind === 'margin' || c.input.kind === 'inventory' || c.input.kind === 'ads');
  const matrix = Object.fromEntries(labels.map(expected => [expected, Object.fromEntries([...labels, 'execution_error'].map(actual => [actual, 0]))]));
  for (const c of detectorCases) {
    const result = results.find(r => r.id === c.id)!;
    const actual = labels.includes(result.actual as typeof labels[number]) ? String(result.actual) : 'execution_error';
    matrix[c.expected]![actual]!++;
  }
  const binary = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, excluded: 0 };
  for (const c of detectorCases) {
    const r = results.find(r => r.id === c.id)!;
    if (!['normal', 'warning'].includes(c.expected) || !['normal', 'warning'].includes(String(r.actual))) { binary.excluded++; continue; }
    const key = c.expected === 'warning' ? r.actual === 'warning' ? 'truePositive' : 'falseNegative' : r.actual === 'warning' ? 'falsePositive' : 'trueNegative'; binary[key]++;
  }
  const summary = summarize(results);
  return {
    version: EVAL_VERSION, startedAt, finishedAt: new Date().toISOString(), runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
    datasetHash: createHash('sha256').update(JSON.stringify({ cases: [...BUSINESS_CASES, ...FAULT_CASES], protocolFixtures: PROTOCOL_FIXTURES })).digest('hex'),
    scope: '合成数据、领域规则及本地模拟账本；非真实模型质量、真实业务效果、安装或性能验收',
    summary, releaseReady: false,
    remainingGates: ['固定48例与三场景真实模型第三批已通过，但SKU匹配/异常销量/延迟事件仍仅窄范围；会员价/赠品/报价及一层组合装保留业务边界', '完整真实模型安全对抗仍待扩展；第三批禁止动作事件为0，不代表完整安全证明', '毛利十万行30次查询已测；库存/广告同规模、冷缓存/并发及内部全量路径未验收', 'Windows本机beta.1到beta.2升级/重装/卸载已通过；干净环境及其他Windows版本仍待外部验收（用户确认暂无测试环境）'],
    detectorMatrix: matrix, warningConfusion: binary, results,
  };
}
