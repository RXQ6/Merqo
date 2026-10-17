/** Opt-in live model evaluation. Uses existing encrypted credentials; submits synthetic demo records only. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RetailStore } from '../packages/retail-domain/src/store';
import { SignalStore } from '../packages/retail-domain/src/signal-store';
import { InvestigationStore } from '../packages/retail-domain/src/investigation-store';
import type { AnyInvestigation, Trace } from '../packages/retail-domain/src/investigations';
import { runInvestigation, isSignalInvestigation } from '../packages/retail-domain/src/investigations';
import { runSignalInvestigation } from '../packages/retail-domain/src/signal-investigations';
import { connectRetailMcp } from '../apps/electron/src/main/retail-mcp';
import { DecisionStore } from '../packages/retail-domain/src/decisions';
import { INVENTORY_EXECUTION_DEMO, ADS_DEMO } from '../packages/retail-domain/src/signals';
import { DEMO_CSV } from '../packages/retail-domain/src/operations';
const workflow=process.argv.includes('--workflow');
const scenarioName=process.argv.includes('--scenario')?process.argv[process.argv.indexOf('--scenario')+1]:null;
const output=workflow?`artifacts/m4-live-workflow${scenarioName?'-'+scenarioName:''}.json`:'artifacts/m2/live-model-check.json';
// Explicit synthetic business-date replay; never advances the system clock.
const replay=(csv:string)=>workflow?csv.replace(/2026-10-\d{2}/g,date=>new Date(Date.parse(date+'T00:00:00Z')-14*86400000).toISOString().slice(0,10)):csv;
const scenarioFlag=process.argv.indexOf('--scenario');if(scenarioFlag>=0&&!['margin','inventory','ads'].includes(process.argv[scenarioFlag+1]??''))throw new Error('Invalid scenario');
if (!process.argv.includes('--live')) throw new Error('Real model calls require explicit --live (uses configured provider quota).');
process.env.CRAFT_CONFIG_DIR = resolve('.runtime/config');
process.env.CRAFT_RESOURCES_BASE = resolve('apps/electron');
const { createInvestigationModel } = await import('../apps/electron/src/main/retail-investigation');
const dir = mkdtempSync(join(tmpdir(), 'merqo-live-')); mkdirSync(join(dir,'retail')); const file=join(dir,'retail/operations.sqlite'); const data = new RetailStore(file); const signals = new SignalStore(file+'.signals.sqlite'); const runs = new InvestigationStore(file+'.investigations.sqlite');
const decisions=new DecisionStore(file,'live-synthetic-validation',()=>[...data.snapshot().records,...signals.snapshot().records]);
const results: Array<{ scenario: 'margin' | 'inventory' | 'ads'; state: AnyInvestigation['state']; model: string | null; modelCalls: number; elapsedMs: number; error: string | null; trace: Trace[]; workflow?: unknown; evidence: AnyInvestigation['evidence']; report: AnyInvestigation['report'] }> = []; mkdirSync('artifacts/m2', { recursive: true });
try {
  data.import(replay(DEMO_CSV), undefined, 'demo');
  if(workflow){signals.import('inventory',replay(INVENTORY_EXECUTION_DEMO),undefined,'demo');signals.import('ads',replay(ADS_DEMO),undefined,'demo');}else signals.demo();
  for (const scenario of ['margin', 'inventory', 'ads'] as const) {
    const selected = process.argv.indexOf('--scenario'); if (selected >= 0 && process.argv[selected + 1] !== scenario) continue;
    const run = scenario === 'margin' ? runs.create(data.snapshot().records.find(r => r.row.sku_id === 'TEA-500')!, 'model').run : runs.createSignal(signals.snapshot().records.find(r => r.kind === scenario && r.row.sku_id === 'TEA-500')!, 'model').run;
    const start = Date.now(); let modelCalls = 0; console.log(`Starting synthetic ${scenario} model evaluation`);
    try {
      const adapter = await createInvestigationModel(dir, run.deadlineAt); runs.update(run.id, { model: adapter.name });
      const responses: string[] = [];
      const model = async (system: string, prompt: string) => { modelCalls++; const response = await adapter.model(system, prompt); responses.push(response); if (process.argv.includes('--diagnostics')) writeFileSync(`artifacts/m2/live-${scenario}-responses.json`, JSON.stringify(responses, null, 2)); return response; };
      const emit = async (event: Trace) => { runs.update(run.id, { event }); };
      const mcp = await connectRetailMcp(run,dir);
      try { const report = isSignalInvestigation(run) ? await runSignalInvestigation(run, model, emit, mcp.skill, mcp.tool) : await runInvestigation(run, model, emit, mcp.skill, mcp.tool); runs.update(run.id, { report }); } finally { await mcp.close(); }
    } catch (error) { runs.update(run.id, { error: error instanceof Error ? error.message : 'Evaluation failed' }); }
    const result = runs.listAll().find(r => r.id === run.id)!;
    let flow:unknown;
    if(workflow&&result.report){
      try{
        const kind=scenario==='margin'?'reduce_coupon':scenario==='inventory'?'replenish_draft':'reduce_budget';
        const draft=decisions.create(run.id,kind,'真实模型合成验收；非经营动作');
        if(draft.submissionBlockers.length)flow={status:'blocked',draftId:draft.id,blockers:draft.submissionBlockers};
        else{
          const submitted=decisions.submit(draft.id,draft.version);const request=submitted.request!;
          const approval=decisions.resolveApproval(request.id,draft.version,request.actionHash,'approve','自动化验收的本地模拟角色；不代表真实人员审批',{id:'local-simulation-approver',role:'approver',environment:'simulation'});
          const job=decisions.executions().find(e=>e.job.requestId===request.id)!.job;
          const executed=decisions.executeSimulation(job.id,job.decisionVersion,job.actionHash,{id:'local-simulation-executor',role:'executor',environment:'simulation'});
          if(!executed.receipt||!executed.reconciliation?.matched)throw new Error('模拟执行或回读失败');
          const created=decisions.createReview(job.id);const observed=decisions.observeReview(created.review.id,created.review.version,null);
          const reviewed=observed.state==='ready'?decisions.finalizeReview(observed.review.id,observed.review.version,observed.review.observation!.hash,'comparison_only','自动化合成窗口比较，不证明因果或收益','合成指标保持原值，未接入真实平台或真实执行后观测','local-simulation-reviewer'):observed;
          flow={status:reviewed.case?'completed':'awaiting_review',draftId:draft.id,approval:approval.status,execution:executed,review:reviewed};
        }
      }catch(error){flow={status:'failed',error:error instanceof Error?error.message:'Workflow failed'};}
    }
    results.push({ ...(workflow?{workflow:flow}:{}),evidence:result.evidence, scenario, state: result.state, model: result.model, modelCalls, elapsedMs: Date.now() - start, error: result.error, trace: result.trace, report: result.report });
    writeFileSync(output, JSON.stringify({ evaluatedAt: new Date().toISOString(), syntheticOnly: true, workflow, businessDateReplay:workflow?'builtin dates minus 14 days; inventory lead 1 day':null, automatedSimulationRoles:workflow, results }, null, 2));
    console.log(JSON.stringify({ scenario, state: result.state, modelCalls, traceEvents: result.trace.length, error: result.error, reviewer: result.report?.reviewer.verdict, ...(workflow?{workflow:(flow as {status?:string}|undefined)?.status}: {}) }));
  }
  if (results.some(r => !r.report || r.state === 'failed' || (workflow && (r.workflow as {status?:string}|undefined)?.status!=='completed'))) process.exitCode = 1;
} finally { decisions.close(); data.close(); signals.close(); runs.close(); rmSync(dir, { recursive: true, force: true }); }
