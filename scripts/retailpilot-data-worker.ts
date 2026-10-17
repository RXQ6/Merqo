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
const workspaceId = process.argv[4] || 'local-' + createHash('sha256').update(resolve(file)).digest('hex').slice(0, 24);
let store: RetailStore | undefined;
let investigations: InvestigationStore | undefined;
let signals: SignalStore | undefined;
let decisions: DecisionStore | undefined;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  store = openStore(() => new RetailStore(file, process.argv[3] || '当前 Workspace'));
  investigations = openStore(() => new InvestigationStore(file + '.investigations.sqlite', false, workspaceId));
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
      else if(request.op==='signals_replenishment_demo'){const result=signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo',true);console.log(JSON.stringify({ok:true,kind:'signals',data:result.data,notice:'已载入1天交期的合成补货流程演示；原5天样例可重新载入。'}));}
      else console.log(JSON.stringify({ ok: true, kind: 'signals', data: request.op === 'signals_demo' ? signals.demo() : signals.snapshot(),...(request.op==='signals_demo'?{notice:'已重新载入内置库存与广告样例；合成演示不受24小时限制，历史与CSV数据保留。'}:{}) }));
    }
    else if (request.op === 'reviews' || request.op.startsWith('review_') || request.op === 'investigation_export' || request.op === 'decisions' || request.op === 'approvals' || request.op === 'approval_resolve' || request.op === 'executions' || request.op === 'simulation_execute' || request.op === 'execution_reconcile' || request.op === 'compensations' || request.op === 'execution_batches' || request.op.startsWith('batch_') || request.op.startsWith('compensation_') || request.op.startsWith('decision_')) {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      // Batches release locks between items: every action must re-read current source evidence.
      const current = () => [...store!.snapshot().records, ...signals!.snapshot().records];
      decisions = openStore(() => new DecisionStore(file, workspaceId, current));
      if(request.op==='review_followup'){
        const view=decisions.review(request.id);const r=view.review;
        if(!view.case||view.case.id!==request.expectedCaseId||!r.final||r.observation?.origin!=='builtin_synthetic')throw new Error('仅已复核的内置合成观察可明确载入后续演示调查；请刷新核对Case');
        const row=r.observation.row;const cells=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';const csv=[Object.keys(row).join(','),Object.values(row).map(cells).join(',')].join('\n');
        let result;
        if(r.job.scenario==='margin'){store.import(csv,undefined,'demo',true);const e=store.snapshot().records.find(e=>e.source==='demo'&&e.row.date===row.date&&e.row.shop_id===row.shop_id&&e.row.channel===row.channel&&e.row.sku_id===row.sku_id);if(!e)throw new Error('后续合成记录未载入');result=investigations.create(e,request.mode,true);}
        else {signals.import(r.job.scenario,csv,undefined,'demo',true);const e=signals.snapshot().records.find(e=>e.source==='demo'&&e.kind===r.job.scenario&&e.row.date===row.date&&e.row.shop_id===row.shop_id&&e.row.channel===row.channel&&e.row.sku_id===row.sku_id&&('warehouse_id' in e.row?e.row.warehouse_id===r.job.scope.warehouse:'campaign_id' in e.row&&e.row.campaign_id===r.job.scope.campaign));if(!e)throw new Error('后续合成记录未载入');result=investigations.createSignal(e,request.mode,true);}
        console.log(JSON.stringify({ok:true,kind:'investigations',data:[result.run],created:result.created}));
      }else if(request.op==='reviews'||request.op==='review_create'||request.op==='review_preview'||request.op==='review_demo'||request.op==='review_observe'||request.op==='review_finalize'){
        if(request.op==='review_preview')console.log(JSON.stringify({ok:true,kind:'review_preview',data:decisions.previewObservation(request.id,request.csv)}));
        else {let selectedId:string|undefined;
          if(request.op==='review_create')selectedId=decisions.createReview(request.jobId).review.id;
          if(request.op==='review_demo')selectedId=decisions.observeReview(request.id,request.expectedVersion,null).review.id;
          if(request.op==='review_observe')selectedId=decisions.observeReview(request.id,request.expectedVersion,{csv:request.csv,hash:request.previewHash}).review.id;
          if(request.op==='review_finalize')selectedId=decisions.finalizeReview(request.id,request.expectedVersion,request.observationHash,request.conclusion,request.note,request.confounders,process.argv[5]||'').review.id;
          console.log(JSON.stringify({ok:true,kind:'reviews',data:decisions.reviews(),...(selectedId?{selectedId}:{})}));}
      }else if(request.op==='execution_batches'||request.op==='batch_create'||request.op==='batch_run'||request.op==='batch_retry_item'||request.op==='batch_recover') {
        let selectedId:string|undefined;const actor=process.argv[5]==='local-simulation-executor'?{id:'local-simulation-executor',role:'executor',environment:'simulation'} as const:null;
        if(request.op==='batch_create')selectedId=decisions.createExecutionBatch(request.jobIds,request.reason).batch.id;
        if(request.op==='batch_run')selectedId=decisions.runExecutionBatch(request.id,actor).batch.id;
        if(request.op==='batch_retry_item')selectedId=decisions.runExecutionBatch(request.id,actor,request.jobId).batch.id;
        if(request.op==='batch_recover')selectedId=decisions.recoverExecutionBatch(request.id,actor).batch.id;
        console.log(JSON.stringify({ok:true,kind:'execution_batches',data:decisions.executionBatches(),...(selectedId?{selectedId}:{})}));
      }else if(request.op==='compensations'||request.op==='compensation_create'||request.op==='compensation_revise'||request.op==='compensation_resolve'||request.op==='compensation_execute'||request.op==='compensation_reconcile') {
        let selectedId:string|undefined;
        const approver=process.argv[5]==='local-simulation-approver'?{id:'local-simulation-approver',role:'approver',environment:'simulation'} as const:null;
        const executor=process.argv[5]==='local-simulation-executor'?{id:'local-simulation-executor',role:'executor',environment:'simulation'} as const:null;
        if(request.op==='compensation_create')selectedId=decisions.createCompensation(request.sourceJobId,request.reason).request.id;
        if(request.op==='compensation_revise')selectedId=decisions.reviseCompensation(request.id,request.expectedVersion,request.reason).request.id;
        if(request.op==='compensation_resolve')selectedId=decisions.resolveCompensation(request.id,request.expectedVersion,request.expectedActionHash,request.choice,request.reason,approver).request.id;
        if(request.op==='compensation_execute')selectedId=decisions.executeCompensation(request.id,request.expectedVersion,request.expectedActionHash,executor).request.id;
        if(request.op==='compensation_reconcile')selectedId=decisions.reconcileCompensation(request.id,executor).request.id;
        console.log(JSON.stringify({ok:true,kind:'compensations',data:decisions.compensations(),...(selectedId?{selectedId}:{})}));
      } else if (request.op === 'executions' || request.op === 'simulation_execute' || request.op === 'execution_reconcile') {
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
        const executionViews=decisions.executions().filter(e=>ids.has(e.job.decisionId));const executionIds=new Set(executionViews.map(e=>e.job.id));
        console.log(JSON.stringify({ ok: true, kind: 'export', ...exportInvestigation(run, request.format, drafts, executionViews, decisions.compensations().filter(c=>executionIds.has(c.request.sourceJobId)), decisions.executionBatches().filter(b=>b.batch.items.some(i=>executionIds.has(i.jobId))),decisions.reviews().filter(r=>executionIds.has(r.review.job.id))) }));
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
      if (reply.ok && reply.kind === 'snapshot') { signals = openStore(() => new SignalStore(file + '.signals.sqlite')); console.log(JSON.stringify({ ...reply, signals: request.op === 'demo' ? signals.demo() : signals.snapshot(),...(request.op==='demo'?{notice:'已载入内置样例；合成演示不受24小时限制。'+(reply.notice??'')+'；库存与广告样例亦已载入。'}:{}) })); }
      else console.log(JSON.stringify(reply));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally { decisions?.close(); signals?.close(); investigations?.close(); store?.close(); }
