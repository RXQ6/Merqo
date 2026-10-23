import {WarehouseStore} from '../packages/retail-domain/src/warehouse-store';
import {existsSync} from 'node:fs';
import {runInvestigation,isSignalInvestigation} from '../packages/retail-domain/src/investigations';
import {runSignalInvestigation} from '../packages/retail-domain/src/signal-investigations';
import {evidenceHash} from '../packages/retail-domain/src/business-identity';
import {ProcurementStore} from '../packages/retail-domain/src/procurement-store';
import {freshSupplementEvidence} from '../packages/retail-domain/src/supplement';
import {ReturnInspectionStore} from '../packages/retail-domain/src/return-inspection-store';
import {SyncCleanupStore} from '../packages/retail-domain/src/adapters/sync-cleanup';
import {SyncStore} from '../packages/retail-domain/src/adapters/sync-store';
import {ingestionRequest} from '../packages/retail-domain/src/adapters/ingestion-worker';
import {CatalogStore,readCatalog} from '../packages/retail-domain/src/catalog-store';
import {catalogCandidateSkus} from '../packages/retail-domain/src/catalog';
import {TransactionStore} from '../packages/retail-domain/src/transaction-store';
import {PolicyStore} from '../packages/retail-domain/src/policy-store';
import { matchRelatedEvidence } from '../packages/retail-domain/src/related-evidence';
import { ScheduledChecks } from '../packages/retail-domain/src/scheduled-checks';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DecisionStore } from '../packages/retail-domain/src/decisions';
import { exportInvestigation } from '../packages/retail-domain/src/investigation-export';
import { RetailStore } from '../packages/retail-domain/src/store.ts';
import { RetailRequestSchema, snapshotCsv } from '../packages/retail-domain/src/operations.ts';
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
let transactions:TransactionStore|undefined;
let store: RetailStore | undefined;
let investigations: InvestigationStore | undefined;
let signals: SignalStore | undefined;
let decisions: DecisionStore | undefined;
let checks: ScheduledChecks | undefined;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  const tick = z.strictObject({op:z.literal('check_tick')}).safeParse(input);
  const checkOp = typeof input === 'object' && input !== null && 'op' in input && ['checks','check_configure','check_run','check_catchup','check_retry'].includes(String(input.op));
  const transactionRequest=typeof input==='object'&&input!==null&&'op'in input&&(String(input.op).startsWith('ad_refund_')||String(input.op).startsWith('exchange_')||String(input.op).startsWith('transactions_')||String(input.op).startsWith('contribution_'));
  const catalogRequest=typeof input==='object'&&input!==null&&'op'in input&&['catalog','catalog_update'].includes(String(input.op));
  if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('sync_cleanup_store_')){const r=z.discriminatedUnion('op',[z.strictObject({op:z.literal('sync_cleanup_store_view')}),z.strictObject({op:z.literal('sync_cleanup_store_preview'),before:z.number().int().positive().safe()}),z.strictObject({op:z.literal('sync_cleanup_store_confirm'),planId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/)})]).parse(input),cleanup=openStore(()=>new SyncCleanupStore(file+'.sync.sqlite',file+'.transactions.sqlite'));try{console.log(JSON.stringify({ok:true,kind:'sync_cleanup',data:r.op==='sync_cleanup_store_view'?cleanup.view():r.op==='sync_cleanup_store_preview'?cleanup.preview(r.before):cleanup.confirm(r.planId,r.reviewHash)}));}finally{cleanup.close();}}
  else if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('sync_store_')){
    const sync=openStore(()=>new SyncStore(file+'.sync.sqlite'));try{const staging=z.strictObject({op:z.literal('sync_store_staging'),id:z.string().uuid()}).safeParse(input);console.log(JSON.stringify(staging.success?{ok:true,kind:'sync_staging',data:sync.staging(staging.data.id)}:{ok:true,kind:'sync',data:sync.request(input)}));}finally{sync.close();}
  }else if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('ingest_store_')){console.log(JSON.stringify({ok:true,kind:String(input.op).includes('_issue')?'ingest_issues':'ingestion',data:ingestionRequest(file+'.transactions.sqlite',input)}));}
  else if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('procurement_')){const r=RetailRequestSchema.parse(input),p=openStore(()=>new ProcurementStore(file+'.transactions.sqlite'));try{console.log(JSON.stringify(r.op==='procurement_view'?{ok:true,kind:'procurement',data:p.view(r.query)}:r.op==='procurement_preview'?{ok:true,kind:'procurement_preview',data:p.preview(r.json)}:r.op==='procurement_import'?{ok:true,kind:'procurement_receipt',data:p.import(r.json,r.previewHash)}:{ok:false,error:'采购操作无效'}));}finally{p.close();}}
  else if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('warehouse_')){const r=RetailRequestSchema.parse(input),s=openStore(()=>new WarehouseStore(file+'.transactions.sqlite'));try{console.log(JSON.stringify(r.op==='warehouse_pick_preview'?{ok:true,kind:'warehouse_pick_plan',data:s.pickPreview(r.input)}:r.op==='warehouse_pick_confirm'?{ok:true,kind:'warehouse_pick_receipt',data:s.pickConfirm(r.id,r.reviewHash)}:r.op==='warehouse_view'?{ok:true,kind:'warehouse',data:s.view(r.query)}:r.op==='warehouse_preview'?{ok:true,kind:'warehouse_preview',data:s.preview(r.json)}:r.op==='warehouse_import'?{ok:true,kind:'warehouse_receipt',data:s.import(r.json,r.previewHash)}:{ok:false,error:'仓库操作无效'}));}finally{s.close();}}
  else if(catalogRequest){const r=RetailRequestSchema.parse(input);const catalog=openStore(()=>new CatalogStore(file));try{console.log(JSON.stringify({ok:true,kind:'catalog',data:r.op==='catalog_update'?catalog.update(r,process.argv[5]??''):catalog.view()}));}finally{catalog.close();}}
  else if(typeof input==='object'&&input!==null&&'op'in input&&String(input.op).startsWith('inspections_')){const r=RetailRequestSchema.parse(input),inspection=openStore(()=>new ReturnInspectionStore(file+'.transactions.sqlite'));try{if(r.op==='inspections_view')console.log(JSON.stringify({ok:true,kind:'inspections',data:inspection.view(r.query)}));else if(r.op==='inspections_preview')console.log(JSON.stringify({ok:true,kind:'inspections_preview',data:inspection.preview(r.csv)}));else if(r.op==='inspections_import')console.log(JSON.stringify({ok:true,kind:'inspections_import',data:inspection.import(r.csv,r.previewHash)}));else throw Error('质检操作无效');}finally{inspection.close();}}
  else if(transactionRequest){const r=RetailRequestSchema.parse(input);transactions=openStore(()=>new TransactionStore(file+'.transactions.sqlite'));if(r.op==='ad_refund_reports')console.log(JSON.stringify({ok:true,kind:'ad_refund_reports',data:transactions.adRefundReports()}));else if(r.op==='ad_refund_analyze')console.log(JSON.stringify({ok:true,kind:'ad_refund_reports',data:transactions.adRefund(r.input)}));else if(r.op==='exchange_reports')console.log(JSON.stringify({ok:true,kind:'exchange_reports',data:transactions.exchangeReports()}));else if(r.op==='exchange_analyze')console.log(JSON.stringify({ok:true,kind:'exchange_reports',data:transactions.exchange(r.input)}));else if(r.op==='contribution_comparisons')console.log(JSON.stringify({ok:true,kind:'contribution_comparisons',data:transactions.contributionComparisons()}));else if(r.op==='contribution_compare')console.log(JSON.stringify({ok:true,kind:'contribution_comparisons',data:transactions.compareContributionReports(r.baselineId,r.currentId)}));else if(r.op==='contribution_reports')console.log(JSON.stringify({ok:true,kind:'contribution_reports',data:transactions.contributionReports()}));else if(r.op==='contribution_analyze')console.log(JSON.stringify({ok:true,kind:'contribution_reports',data:transactions.contribution((({op,...v})=>v)(r))}));else if(r.op==='transactions_preview')console.log(JSON.stringify({ok:true,kind:'transactions_preview',data:(()=>{const p=transactions!.preview(r.csv);return {...p,events:p.events.slice(0,30),errors:p.errors.slice(0,200)};})()}));else if(r.op==='transactions_import')console.log(JSON.stringify({ok:true,kind:'transactions_import',data:transactions.import(r.csv,r.previewHash,'csv',r.sourceMetadata)}));else if(r.op==='transactions_demo')console.log(JSON.stringify({ok:true,kind:'transactions_import',data:transactions.demo()}));else if(r.op==='transactions_page')console.log(JSON.stringify({ok:true,kind:'transactions',data:transactions.page((({op,...query})=>query)(r))}));else throw Error('无效交易操作');}
  else if (tick.success || checkOp) {
    const readChecks = function* (source: 'demo' | 'csv') {
      store ??= openStore(() => new RetailStore(file, process.argv[3] || '当前 Workspace'));
      signals ??= openStore(() => new SignalStore(file + '.signals.sqlite'));
      yield* store.snapshot().records;
      yield* signals.records(source);
    };
    // Open the ledger before source data, so source failures remain inspectable.
    checks = openStore(() => new ScheduledChecks(file + '.checks.sqlite', workspaceId, readChecks));
    let result;
    if(tick.success) result = checks.run('scheduled');
    else {
      const request = RetailRequestSchema.parse(input);
      result = request.op === 'check_configure' ? checks.configure(request.expectedRevision,request.config) : request.op === 'check_retry' ? checks.retry(request.id) : request.op === 'check_run' ? checks.run('manual') : request.op === 'check_catchup' ? checks.run('catchup') : checks.view();
    }
    console.log(JSON.stringify({ok:true,kind:'checks',data:result}));
  } else {
    store = openStore(() => new RetailStore(file, process.argv[3] || '当前 Workspace'));
    investigations = openStore(() => new InvestigationStore(file + '.investigations.sqlite', false, workspaceId, evidence => {
      signals ??= openStore(() => new SignalStore(file + '.signals.sqlite'));
      const catalog=readCatalog(file);return matchRelatedEvidence(evidence,(function*(){for(const sku_id of catalogCandidateSkus(evidence,catalog)){const scope={source:evidence.source,row:{...evidence.row,sku_id}};yield* store!.snapshot(scope).records;yield* signals!.records(evidence.source,scope);}})(),catalog);
    }));
    // Internal worker protocol is not exposed by the renderer IPC whitelist.
    const internal = z.strictObject({ op: z.literal('investigation_update'), id: z.string().uuid(), expectedEpoch: z.number().int().min(0).optional(), event: z.custom<Trace>().optional(), report: z.custom<InvestigationReport>().optional(), error: z.string().max(1000).optional(), model: z.string().max(200).optional() }).safeParse(input);
    if (internal.success) {
    const { id, event, report, error, model, expectedEpoch } = internal.data;
    console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [investigations.update(id, { expectedEpoch, ...(event ? { event } : {}), ...(report ? { report } : {}), ...(error ? { error } : {}), ...(model ? { model } : {}) })] }));
    } else if(typeof input==='object'&&input!==null&&'op'in input&&input.op==='wiki_internal'){
      const r=z.strictObject({op:z.literal('wiki_internal'),payload:z.unknown()}).parse(input);signals=openStore(()=>new SignalStore(file+'.signals.sqlite'));decisions=openStore(()=>new DecisionStore(file,workspaceId,()=>[...store!.snapshot().records,...signals!.snapshot().records]));console.log(JSON.stringify({ok:true,kind:'workbench',data:decisions.wikiInternal(r.payload)}));
    } else if(typeof input==='object'&&input!==null&&'op'in input&&input.op==='context_completion_internal'){
      const r=z.strictObject({op:z.literal('context_completion_internal'),id:z.string().uuid(),contextHash:z.string().regex(/^[a-f0-9]{64}$/),answer:z.string().max(4000).nullable(),citations:z.array(z.string().max(128)).max(30),error:z.string().max(100).nullable()}).parse(input);
      signals=openStore(()=>new SignalStore(file+'.signals.sqlite'));decisions=openStore(()=>new DecisionStore(file,workspaceId,()=>[...store!.snapshot().records,...signals!.snapshot().records]));
      console.log(JSON.stringify({ok:true,kind:'workbench',data:decisions.completeContext(r.id,r.contextHash,r.answer,r.citations,r.error)}));
    } else {
      const request = RetailRequestSchema.parse(input);
    if(request.op==='policy'||request.op==='policy_update'){const policies=new PolicyStore(file);try{const data=request.op==='policy_update'?policies.update(request,process.argv[5]||''):policies.view();console.log(JSON.stringify({ok:true,kind:'policy',data}));}finally{policies.close();}}
    else if (request.op === 'investigation_pause' || request.op === 'investigation_resume') {
      console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [investigations.control(request.id, request.expectedEpoch, request.op === 'investigation_pause' ? 'pause' : 'resume')], created: request.op === 'investigation_resume' }));
    }
    else if (request.op === 'signals_page') {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      const { op, ...query } = request;
      console.log(JSON.stringify({ ok: true, kind: 'signals_page', data: signals.page(query) }));
    }
    else if (request.op === 'signals' || request.op === 'signals_demo' || request.op === 'signals_replenishment_demo' || request.op === 'signals_preview' || request.op === 'signals_import') {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      if (request.op === 'signals_preview') {
        const preview = previewSignals(request.kind, request.csv, request.mapping);
        console.log(JSON.stringify({ ok: true, kind: 'signals_preview', data: { ...preview, validCount: preview.valid.length, valid: preview.valid.slice(0,30), rejectedCount: preview.rejected.length, rejected: preview.rejected.slice(0,30) } }));
      }
      else if (request.op === 'signals_import') { const result = signals.import(request.kind, request.csv, request.mapping, 'csv',false,request.sourceMetadata); console.log(JSON.stringify({ ok: true, kind: 'signals', data: signals.page({source:'csv'}), notice: result.notice })); }
      else if(request.op==='signals_replenishment_demo'){signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo',true);console.log(JSON.stringify({ok:true,kind:'signals',data:signals.page({source:'demo'}),notice:'已载入1天交期的合成补货流程演示；原5天样例可重新载入。'}));}
      else {
        if (request.op === 'signals_demo') signals.demo();
        console.log(JSON.stringify({ ok: true, kind: 'signals', data: signals.page({source:request.op==='signals_demo'?'demo':undefined}),...(request.op==='signals_demo'?{notice:'已重新载入内置库存与广告样例；合成演示不受24小时限制，历史与CSV数据保留。'}:{}) }));
      }
    }
    else if (request.op.startsWith('wb_') || request.op === 'tasks' || request.op.startsWith('task_') || request.op === 'reviews' || request.op.startsWith('review_') || request.op === 'investigation_export' || request.op === 'decisions' || request.op === 'approvals' || request.op === 'approval_resolve' || request.op === 'executions' || request.op === 'simulation_execute' || request.op === 'execution_reconcile' || request.op === 'compensations' || request.op === 'execution_batches' || request.op.startsWith('batch_') || request.op.startsWith('compensation_') || request.op.startsWith('decision_')) {
      signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
      // Batches release locks between items: every action must re-read current source evidence.
      const current = () => [...store!.snapshot().records, ...signals!.snapshot().records];
      decisions = openStore(() => new DecisionStore(file, workspaceId, current));
      if(request.op==='wb_tick'){
        decisions.workbench(request);
        const config=decisions.findingConfig(),done=decisions.doneFindingKeys();
        if(config.autoFindingTasks&&existsSync(file+'.checks.sqlite')){
          const scan=openStore(()=>new ScheduledChecks(file+'.checks.sqlite',workspaceId,()=>[]));
          try{let claimed=0;for(const {finding,runId}of scan.findingsSince(config.configuredAt)){
            if(done.has(finding.key))continue;if(claimed>=5)break;
            const token=decisions.claimFinding(finding.key);if(!token)continue;claimed++;
            try{
              const created='kind'in finding.record?investigations.createSignal(finding.record,'replay',true):investigations.create(finding.record,'replay',true),run=created.run;
              if(!created.created&&!run.report)throw Error('已有离线调查运行中，请等待原调查完成');
              if(evidenceHash(run.evidence)!==evidenceHash(finding.record)||run.evidence.ruleVersion!==finding.record.ruleVersion)throw Error('已有不同证据的调查正在运行');
              if(!run.report){const save=async(event:Trace)=>{investigations!.update(run.id,{event});};const report=isSignalInvestigation(run)?await runSignalInvestigation(run,null,save):await runInvestigation(run,null,save);investigations.update(run.id,{report});}
              decisions.createFindingTask(finding.key,token,{op:'task_create',origin:{kind:'investigation',id:run.id},purpose:'analysis_followup',title:finding.record.row.sku_id+' 巡检跟进',owner:config.owner,dueAt:new Date(Date.now()+config.dueHours*3600000).toISOString(),priority:'normal',description:'巡检 '+runId+' 发现 '+finding.key+'；由离线规则创建跟进任务，未调用模型，不代表已执行业务。'},config.version);
            }catch{/* A failed/interrupted lease is retried after two minutes; it never approves or executes. */}
          }}finally{scan.close();}
        }
        console.log(JSON.stringify({ok:true,kind:'workbench',data:decisions.workbench({op:'wb_followups'})}));
      }
      else if(request.op.startsWith('wb_')) console.log(JSON.stringify({ok:true,kind:'workbench',data:decisions.workbench(request as import('../packages/retail-domain/src/workbench-contract').WorkbenchRequest)}));
      else if(request.op==='tasks') console.log(JSON.stringify({ok:true,kind:'tasks',data:decisions.tasks(request)}));
      else if(request.op==='task_get') console.log(JSON.stringify({ok:true,kind:'task',data:decisions.task(request.id)}));
      else if(request.op==='task_create'){const result=decisions.createTask(request);console.log(JSON.stringify({ok:true,kind:'task',data:result.detail,created:result.created}));}
      else if(request.op==='task_edit'||request.op==='task_transition'||request.op==='task_note') console.log(JSON.stringify({ok:true,kind:'task',data:decisions.mutateTask(request)}));
      else if(request.op==='review_followup'){
        const view=decisions.review(request.id);const r=view.review;
        if(!view.case||view.case.id!==request.expectedCaseId||!r.final||r.observation?.origin!=='builtin_synthetic')throw new Error('仅已复核的内置合成观察可明确载入后续演示调查；请刷新核对Case');
        const row=r.observation.row;const csv=snapshotCsv(row);
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
        console.log(JSON.stringify({ ok: true, kind: 'export', ...exportInvestigation(run, request.format, drafts, executionViews, decisions.compensations().filter(c=>executionIds.has(c.request.sourceJobId)), decisions.executionBatches().filter(b=>b.batch.items.some(i=>executionIds.has(i.jobId))),decisions.reviews().filter(r=>executionIds.has(r.review.job.id)),(()=>{const v=decisions.workbench({op:'wb_wiki_references',investigationId:run.id});return v.view==='wiki_references'?v.references:[];})(),decisions.caseReferences(run.id)) }));
      } else {
        let selectedId: string | undefined; let history;
        if (request.op === 'decision_create') selectedId = decisions.create(request.investigationId, request.kind, request.note).id;
        else if (request.op === 'decision_revise') selectedId = decisions.revise(request.id, request.expectedVersion, request.kind, request.note).id;
        else if (request.op === 'decision_submit') selectedId = decisions.submit(request.id, request.expectedVersion).id;
        else if (request.op === 'decision_history') { selectedId = request.id; history = decisions.history(request.id); }
        console.log(JSON.stringify({ ok: true, kind: 'decisions', data: decisions.list(), ...(selectedId ? { selectedId } : {}), ...(history ? { history } : {}) }));
      }
    }
    else if(request.op==='investigation_supplement_preview'||request.op==='investigation_supplement'){const parent=investigations.get(request.id);signals??=openStore(()=>new SignalStore(file+'.signals.sqlite'));const evidence=freshSupplementEvidence(parent,[...store.snapshot(parent.evidence).records,...signals.records(parent.evidence.source,parent.evidence)]);if(request.op==='investigation_supplement_preview')console.log(JSON.stringify({ok:true,kind:'supplement_preview',data:investigations.supplementPreview(parent.id,evidence)}));else {const result=investigations.supplement(parent.id,request.expectedEpoch,evidence,request.previewHash);console.log(JSON.stringify({ok:true,kind:'investigations',data:[result.run],created:result.created}));}}
    else if (request.op === 'investigations') console.log(JSON.stringify({ ok: true, kind: 'investigations', data: request.id ? [investigations.get(request.id)] : investigations.listAll(request.recordId) }));
    else if (request.op === 'investigate') {
      let result;
      if (request.scenario === 'inventory' || request.scenario === 'ads') {
        if(request.marginAction)throw new Error('价格动作只能用于毛利场景');
        signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
        const evidence = signals.snapshot().records.find(r => r.id === request.recordId && r.kind === request.scenario);
        if (!evidence) throw new Error('场景快照不存在或已被新版替换，请刷新后重新选择');
        if (evidence.status === 'normal') throw new Error('请选择经营预警或待补证记录');
        result = investigations.createSignal(evidence, request.mode, request.retry);
      } else {
        const evidence = store.snapshot().records.find(r => r.id === request.recordId);
        if (!evidence) throw new Error('快照不存在或已被新版替换，请刷新后重新选择');
        if (evidence.status === 'normal'&&request.marginAction!=='set_price') throw new Error('请选择毛利预警或待补证记录');
        result = investigations.create(evidence, request.mode, request.retry,request.marginAction);
      }
      console.log(JSON.stringify({ ok: true, kind: 'investigations', data: [result.run], created: result.created }));
    } else {
      const reply = store.request(request);
      if (reply.ok && reply.kind === 'snapshot') {
        signals = openStore(() => new SignalStore(file + '.signals.sqlite'));
        if (request.op === 'demo') signals.demo();
        const scope = request.op === 'snapshot' ? { source: request.source, shop: request.shop, channel: request.channel, date: request.date } : { source: request.op === 'demo' ? 'demo' as const : 'csv' as const };
        console.log(JSON.stringify({ ...reply, signals: signals.page(scope),...(request.op==='demo'?{notice:'已载入内置样例；合成演示不受24小时限制。'+(reply.notice??'')+'；库存与广告样例亦已载入。'}:{}) }));
      }
      else console.log(JSON.stringify(reply));
    }
  }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '经营数据处理失败' }));
  process.exitCode = 1;
} finally {transactions?.close(); checks?.close(); decisions?.close(); signals?.close(); investigations?.close(); store?.close(); }

