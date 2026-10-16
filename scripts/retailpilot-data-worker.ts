import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DecisionStore } from '../packages/retail-domain/src/decisions';
import { exportInvestigation } from '../packages/retail-domain/src/investigation-export';
import { RetailStore } from '../packages/retail-domain/src/store.ts';
import { RetailRequestSchema } from '../packages/retail-domain/src/operations.ts';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store.ts';
import { SignalStore } from '../packages/retail-domain/src/signal-store.ts';
import { previewSignals, INVENTORY_EXECUTION_DEMO } from '../packages/retail-domain/src/signals.ts';
import type { InvestigationReport, Trace } from '../packages/retail-domain/src/investigations.ts';
import { z } from 'zod';
// Concurrent readers may initialize a new SQLite WAL/schema at the same time.
// Retry only opening/initializing stores, never replay a partially committed command.
function openStore<T>(create: () => T): T {
  const deadline = Date.now() + 5000;
  while (true) {
    try { return create(); }
    catch (error) {
      if (!(error instanceof Error) || !/database is locked|SQLITE_BUSY/i.test(error.message) || Date.now() >= deadline) throw error;
      Bun.sleepSync(25);
    }
  }
}
const file = process.argv[2];
if (!file) throw new Error('Missing trusted database path');
let store: RetailStore | undefined;
let investigations: InvestigationStore | undefined;
let signals: SignalStore | undefined;
let decisions: DecisionStore | undefined;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  store = openStore(() => new RetailStore(file, process.argv[3] || '当前 Workspace'));
  investigations = openStore(() => new InvestigationStore(file + '.investigations.sqlite'));
  // Internal worker protocol is not exposed by the renderer IPC whitelist.
  const internal = z.strictObject({ op: z.literal('investigation_update'), id: z.string().uuid(), event: z.custom<Trace>().optional(), report: z.custom<InvestigationReport>().optional(), error: z.string().max(1000).optional(), model: z.string().max(200).optional() }).safeParse(input);
  if (internal.success) {
    const { id, event, report, error, model } = internal.data;
    console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [investigations.update(id, { ...(event ? { event } : {}), ...(report ? { report } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}) })] }));
  } else {
    const request = RetailRequestSchema.parse(input);
    if (request.op === 'signals' || request.op === 'signals_demo' || request.op === 'signals_replenishment_demo' || request.op === 'signals_preview' || request.op === 'signals_import') {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      if (request.op === 'signals_preview') console.log(JSON.stringify({ ok: true, kind: 'signals_preview', data: previewSignals(request.kind, request.csv, request.mapping) }));
      else if (request.op === 'signals_import') { const result = signals.import(request.kind, request.csv, request.mapping, 'csv'); console.log(JSON.stringify({ ok: true, kind: 'signals', data: result.data, notice: result.notice })); }
      else if(request.op==='signals_replenishment_demo'){const result=signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo');console.log(JSON.stringify({ok:true,kind:'signals',data:result.data,notice:'已载入1天交期的合成补货流程演示；原5天样例可重新载入。'}));}
      else console.log(JSON.stringify({ ok: true, kind: 'signals', data: request.op === 'signals_demo' ? signals.demo() : signals.snapshot() }));
    }
    else if (request.op === 'investigation_export' || request.op === 'decisions' || request.op === 'approvals' || request.op === 'approval_resolve' || request.op === 'executions' || request.op === 'simulation_execute' || request.op === 'execution_reconcile' || request.op.startsWith('decision_')) {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      let evidence: import('../packages/retail-domain/src/decisions').DraftEvidence[] | undefined;
      const current = () => evidence ??= [...store!.snapshot().records, ...signals!.snapshot().records];
      const workspaceId = process.argv[4] || 'local-' + createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24);
      decisions = openStore(() => new DecisionStore(file, workspaceId, current));
      if (request.op === 'executions' || request.op === 'simulation_execute' || request.op === 'execution_reconcile') {
        let selectedId: string | undefined;
        const actor = process.argv[5] === 'local-simulation-executor' ? {id:'local-simulation-executor',role:'executor',environment:'simulation'} as const : null;
        if(request.op==='simulation_execute')selectedId=decisions.executeSimulation(request.id,request.expectedVersion,request.expectedActionHash,actor).job.id;
        if(request.op==='execution_reconcile')selectedId=decisions.reconcileExecution(request.id,actor).job.id;
        console.log(JSON.stringify({ok:true,kind:'executions',data:decisions.executions(),...(selectedId?{selectedId}:{})}));
      } else if (request.op === 'approvals' || request.op === 'approval_resolve') {
        let selectedId: string | undefined;
        if (request.op === 'approval_resolve') selectedId = decisions.resolveApproval(request.requestId, request.expectedVersion, request.expectedActionHash, request.choice, request.reason, process.argv[5] === 'local-simulation-approver' ? {id:'local-simulation-approver',role:'approver',environment:'simulation'} : null).id;
        console.log(JSON.stringify({ok:true,kind:'approvals',data:decisions.approvals(),...(selectedId?{selectedId}:{})}));
      } else if (request.op === 'investigation_export') {
        const run = investigations.get(request.id);
        const drafts=decisions.forInvestigation(run.id).flatMap(d=>decisions!.history(d.id));
        const ids=new Set(drafts.map(d=>d.id));
        console.log(JSON.stringify({ ok: true, kind: 'export', ...exportInvestigation(run, request.format, drafts, decisions.executions().filter(e=>ids.has(e.job.decisionId))) }));
      } else {
        let selectedId: string | undefined; let history;
        if (request.op === 'decision_create') selectedId = decisions.create(request.investigationId, request.kind, request.note).id;
        else if (request.op === 'decision_revise') selectedId = decisions.revise(request.id, request.expectedVersion, request.kind, request.note).id;
        else if (request.op === 'decision_submit') selectedId = decisions.submit(request.id, request.expectedVersion).id;
        else if (request.op === 'decision_history') { selectedId = request.id; history = decisions.history(request.id); }
        console.log(JSON.stringify({ ok: true, kind: 'decisions', data: decisions.list(), ...(selectedId ? { selectedId } : {}), ...(history ? { history } : {}) }));
      }
    }
    else if (request.op === 'investigations') console.log(JSON.stringify({ ok: true, kind: 'investigations', data: investigations.listAll(request.recordId) }));
    else if (request.op === 'investigate') {
      let result;
      if (request.scenario === 'inventory' || request.scenario === 'ads') {
        signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
        const evidence = signals.snapshot().records.find(r => r.id === request.recordId && r.kind === request.scenario);
        if (!evidence) throw new Error('场景快照不存在或已被新版替换，请刷新后重新选择');
        if (evidence.status === 'normal') throw new Error('请选择经营预警或待补证记录');
        result = investigations.createSignal(evidence, request.mode, request.retry);
      } else {
        const evidence = store.snapshot().records.find(r => r.id === request.recordId);
        if (!evidence) throw new Error('快照不存在或已被新版替换，请刷新后重新选择');
        if (evidence.status === 'normal') throw new Error('请选择毛利预警或待补证记录');
        result = investigations.create(evidence, request.mode, request.retry);
      }
      console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [result.run], created: result.created }));
    } else {
      const reply = store.request(request);
      if (reply.ok && reply.kind === 'snapshot') { signals = openStore(() => new SignalStore(file + '.signals.sqlite')); console.log(JSON.stringify({ ...reply, signals: request.op === 'demo' ? signals.demo() : signals.snapshot() })); }
      else console.log(JSON.stringify(reply));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally { decisions?.close(); signals?.close(); investigations?.close(); store?.close(); }
