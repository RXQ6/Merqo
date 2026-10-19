import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RetailStore} from './store';
import {SignalStore} from './signal-store';
import {InvestigationStore} from './investigation-store';
import {DecisionStore} from './decisions';
import {DEMO_CSV,previewCsv,snapshotCsv,RetailRequestSchema} from './operations';
import {runInvestigation,readTool} from './investigations';
import type {ModelPort,Investigation} from './investigations';
import {simulatePrice} from './price-action';
import {callReadonlyTool} from './readonly-tools';
import {exportInvestigation} from './investigation-export';

const approver={id:'local-simulation-approver',role:'approver',environment:'simulation'} as const;
const executor={id:'local-simulation-executor',role:'executor',environment:'simulation'} as const;
const model:ModelPort=async(system,prompt)=>{
 if(system.includes('串行只读 Reviewer'))return JSON.stringify({verdict:'passed',notes:['仅本地协议夹具，不是真实模型评测']});
 const c=JSON.parse(prompt);if(c.responseContract.remainingTools.length)return JSON.stringify({tool:c.responseContract.remainingTools[0]});
 return JSON.stringify({report:{summary:'冻结标价条件分析',observations:[],hypotheses:[],unknowns:['需求响应未知'],alternatives:['成本存在差异'],options:[{kind:'observe',rationale:'继续核验'},{kind:c.responseContract.reportExample.report.options[1].kind,rationale:'按冻结约束比较标价'}]}});
};
function fixture(cost?:number,source:'demo'|'csv'='demo'){
 const dir=mkdtempSync(join(tmpdir(),'merqo-price-'));const file=join(dir,'data.sqlite');
 const data=new RetailStore(file);const signals=new SignalStore(file+'.signals.sqlite');
 const row=previewCsv(DEMO_CSV).valid.find(r=>r.sku_id==='TEA-500')!;
 if(cost!==undefined)row.cost_minor=cost;
 data.import(snapshotCsv(row),undefined,source);const runs=new InvestigationStore(file+'.investigations.sqlite');
 const decisions=new DecisionStore(file,'price-workspace',()=>data.snapshot().records);
 return {dir,file,data,signals,runs,decisions,record:()=>data.snapshot().records[0]!,close(){decisions.close();runs.close();signals.close();data.close();rmSync(dir,{recursive:true,force:true});}};
}
async function complete(f:ReturnType<typeof fixture>,mode:'model'|'replay'='model'){
 const run=f.runs.create(f.record(),mode,true,'set_price').run;
 const report=await runInvestigation(run,mode==='model'?model:null,async event=>{f.runs.update(run.id,{event});});
 return f.runs.update(run.id,{report}) as Investigation;
}
function approve(f:ReturnType<typeof fixture>,run:Investigation){const d=f.decisions.create(run.id,'set_price','价格测试');const s=f.decisions.submit(d.id,d.version);f.decisions.resolveApproval(s.request!.id,s.version,s.actionHash,'approve','本地模拟',approver);return f.decisions.executions().find(v=>v.job.decisionId===d.id)!;}

test('integer price target changes no discounts and rejects unsupported, excessive or no-op prices',()=>{
 const f=fixture();try{const e=f.record();const s=simulatePrice(e)[1]!;
 expect(s.kind).toBe('set_price');expect(s.couponMinor).toBe(e.row.coupon_minor);expect(s.values!.priceMinor).not.toBe(e.row.list_price_minor);expect(s.marginBps).toBeGreaterThanOrEqual(e.thresholdBps);
 const required=(BigInt(e.row.cost_minor!)*10000n+7999n)/8000n+BigInt(e.row.coupon_minor)+BigInt(e.row.full_reduction_minor)-BigInt(e.row.subsidy_minor);
 expect(s.values!.priceMinor).toBe(Number(required));
 expect(simulatePrice({...e,row:{...e.row,cost_minor:99999999}})[1]!.passed).toBe(false);
 expect(simulatePrice({...e,row:{...e.row,list_price_minor:s.values!.priceMinor!}})[1]!.constraints).toContain('目标价格与原价相同，无需执行');
 expect(RetailRequestSchema.safeParse({op:'decision_create',investigationId:crypto.randomUUID(),kind:'set_price',note:'',priceMinor:1}).success).toBe(false);
 }finally{f.close();}
});

test('reviewed price binds independent values, approval, idempotent execution/readback and unsafe compensation refusal',async()=>{
 const f=fixture();try{
  const original=f.record();const run=await complete(f);expect(run.marginAction).toBe('set_price');
  expect(run.report!.numericAudit!.facts.find(x=>x.key==='proposedPrice')).toBeDefined();
  const v=approve(f,run);expect(v.job.expectedBefore).toEqual({priceMinor:original.row.list_price_minor,couponMinor:original.row.coupon_minor});
  const result=f.decisions.executeSimulation(v.job.id,v.job.decisionVersion,v.job.actionHash,executor);
  expect(result.status).toBe('succeeded');expect(result.reconciliation!.matched).toBe(true);
  expect(result.receipt!.after.values.couponMinor).toBe(original.row.coupon_minor);
  const proposed=run.report!.scenarios[1]!.values!.priceMinor;if(proposed==null)throw new Error('Missing price');
  expect(result.receipt!.after.values.priceMinor).toBe(proposed);
  expect(f.decisions.executeSimulation(v.job.id,v.job.decisionVersion,v.job.actionHash,executor).receipt!.id).toBe(result.receipt!.id);
  expect(f.record().row).toEqual(original.row);
  const compensation=f.decisions.createCompensation(v.job.id,'恢复原标价');
  expect(compensation.blockers.join('；')).toContain('恢复原SKU价格会低于当前毛利下限');
  const json=JSON.parse(exportInvestigation(run,'json').content);expect(json.investigation.marginAction).toBe('set_price');
 }finally{f.close();}
});

test('coupon and direct price share the resource version; later approved action cannot overwrite the first',async()=>{
 const f=fixture();try{
  const price=approve(f,await complete(f)).job;
  const coupon=f.runs.create(f.record(),'model',true,'reduce_coupon').run;
  const report=await runInvestigation(coupon,model,async event=>{f.runs.update(coupon.id,{event});});f.runs.update(coupon.id,{report});
  const draft=f.decisions.create(coupon.id,'reduce_coupon','同一商品另一动作');const pending=f.decisions.submit(draft.id,1);
  f.decisions.resolveApproval(pending.request!.id,1,pending.actionHash,'approve','仅模拟',approver);
  const job=f.decisions.executions().find(v=>v.job.decisionId===draft.id)!.job;
  expect(job.resourceKey).toBe(price.resourceKey);
  expect(f.decisions.executeSimulation(price.id,1,price.actionHash,executor).status).toBe('succeeded');
  const refused=f.decisions.executeSimulation(job.id,1,job.actionHash,executor);
  expect(refused.status).toBe('failed');expect(refused.receipt).toBeNull();
  expect(refused.attempts[0]!.reason).toContain('冲突');
 }finally{f.close();}
});

test('safe price reduction supports separately approved compensation and original coupon remains unchanged',async()=>{
 const initial=previewCsv(DEMO_CSV).valid.find(r=>r.sku_id==='TEA-500')!;
 const revenue=initial.list_price_minor-initial.coupon_minor-initial.full_reduction_minor+initial.subsidy_minor;
 const f=fixture(Math.floor(revenue*0.75));try{
  const run=await complete(f);const job=approve(f,run).job;
  expect(run.report!.scenarios[1]!.passed).toBe(true);
  const executed=f.decisions.executeSimulation(job.id,job.decisionVersion,job.actionHash,executor);expect(executed.status).toBe('succeeded');
  const c=f.decisions.createCompensation(job.id,'恢复安全原价');expect(c.blockers).toEqual([]);
  f.decisions.resolveCompensation(c.request.id,1,c.request.actionHash,'approve','仅模拟恢复',approver);
  const restored=f.decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);
  expect(restored.receipt!.after.values).toEqual(executed.receipt!.before.values);
  expect(restored.checks[0]!.matched).toBe(true);
 }finally{f.close();}
});

test('price investigation cannot reuse a coupon report, tamper tools or use CSV/offline approval',async()=>{
 for(const [source,mode] of [['demo','replay'],['csv','model']] as const){const f=fixture(undefined,source);try{const run=await complete(f,mode);const d=f.decisions.create(run.id,'set_price','');expect(()=>f.decisions.submit(d.id,1)).toThrow('不能提交');}finally{f.close();}}
 const f=fixture();try{
  const run=f.runs.create(f.record(),'model',true,'set_price').run;
  expect(()=>f.runs.create(f.record(),'model',true,'reduce_coupon')).toThrow('其他动作');
  await expect(runInvestigation(run,model,async()=>{},undefined,async tool=>readTool(run.evidence,tool as 'retail_simulate_actions'))).rejects.toThrow();
  expect(callReadonlyTool({scenario:'margin',evidence:run.evidence,marginAction:'set_price'},'retail_simulate_actions')).toMatchObject({data:simulatePrice(run.evidence)});
 }finally{f.close();}
});
