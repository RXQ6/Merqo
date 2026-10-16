import { beforeEach, afterEach, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { DecisionStore } from './decisions';
import { runInvestigation, isSignalInvestigation } from './investigations';
import { runSignalInvestigation } from './signal-investigations';
import { exportInvestigation } from './investigation-export';
import { DEMO_CSV, RetailRequestSchema } from './operations';
import { ADS_DEMO } from './signals';
import type { AnyInvestigation, ModelPort, Scenario } from './investigations';
let dir: string; let file: string; let data: RetailStore; let signals: SignalStore; let runs: InvestigationStore; let decisions: DecisionStore;
const current=()=>[...data.snapshot().records,...signals.snapshot().records];
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'merqo-decisions-'));file=join(dir,'operations.sqlite');data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');signals=new SignalStore(file+'.signals.sqlite');signals.demo();runs=new InvestigationStore(file+'.investigations.sqlite');decisions=new DecisionStore(file,'test-workspace',current);});
afterEach(()=>{decisions.close();runs.close();signals.close();data.close();rmSync(dir,{recursive:true,force:true});});
function modelFor(run:AnyInvestigation,verdict='passed'):ModelPort { return async(system,prompt)=>{
 if(system.includes('串行只读 Reviewer'))return JSON.stringify({verdict,notes:['本地契约测试，非真实模型评估']});
 const context=JSON.parse(prompt);const tools=['retail_get_data_health','retail_get_sku_context',run.scenario==='ads'?'retail_get_campaigns':run.scenario==='inventory'?'retail_get_inventory':'retail_get_promotions','retail_simulate_actions'];
 if(context.observations.length<4)return JSON.stringify({tool:tools[context.observations.length]});
 return JSON.stringify({report:{summary:'合成案例契约报告',observations:[{text:'核对工具证据',evidenceIds:[`${run.recordId}:${tools[2]}`]}],hypotheses:[],unknowns:['缺实时状态'],alternatives:['可能存在口径差异'],options:[{kind:'observe',rationale:'核验'},{kind:run.scenario==='ads'?'reduce_budget':run.scenario==='inventory'?'replenish_draft':'reduce_coupon',rationale:'仅作条件测算'}]}});
}; }
async function complete(scenario:'margin'|'ads'|'inventory'='margin',mode:'model'|'replay'='model',verdict='passed',sku='TEA-500',source:'demo'|'csv'='demo'):Promise<AnyInvestigation>{
 const run=scenario==='margin'?runs.create(data.snapshot().records.find(r=>r.source===source&&r.row.sku_id===sku)!,mode).run:runs.createSignal(signals.snapshot().records.find(r=>r.source===source&&r.kind===scenario&&r.row.sku_id===sku)!,mode).run;
 const emit=async(event:import('./investigations').Trace)=>{runs.update(run.id,{event});};
 const report=isSignalInvestigation(run)?await runSignalInvestigation(run,mode==='model'?modelFor(run,verdict):null,emit):await runInvestigation(run,mode==='model'?modelFor(run,verdict):null,emit);
 return runs.update(run.id,{report});
}
const action=(run:AnyInvestigation):Scenario['kind']=>run.scenario==='ads'?'reduce_budget':run.scenario==='inventory'?'replenish_draft':'reduce_coupon';
test('deterministic draft binds amounts, scope, evidence and digest; create is idempotent',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','先核验');
 expect(d.version).toBe(1);expect(d.before.couponMinor).toBe(2000);expect(d.after.couponMinor).toBe(1500);expect(d.after.marginBps).toBe(2000);expect(d.actionHash).toHaveLength(64);expect(d.submissionBlockers).toEqual([]);
 expect(decisions.create(run.id,'reduce_coupon','重复请求').id).toBe(d.id);expect(decisions.history(d.id)).toHaveLength(1);expect(decisions.forInvestigation(run.id)[0]?.id).toBe(d.id);expect(decisions.forInvestigation('other-run')).toEqual([]);
 expect(()=>decisions.create(run.id+'x','reduce_coupon','')).toThrow('不存在');
});
test('submission is idempotent, does not mutate business values, revisions supersede exact old requests',async()=>{
 const run=await complete('ads');const before=signals.snapshot();const d=decisions.create(run.id,'reduce_budget','v1');const pending=decisions.submit(d.id,1);
 expect(pending.state).toBe('pending_approval');expect(pending.request?.actionHash).toBe(d.actionHash);expect(decisions.submit(d.id,1).request?.id).toBe(pending.request?.id);
 const v2=decisions.revise(d.id,1,'reduce_budget','v2');expect(v2.version).toBe(2);expect(v2.actionHash).not.toBe(d.actionHash);expect(v2.request).toBeNull();
 expect(decisions.history(d.id)[1]?.request?.status).toBe('superseded');expect(()=>decisions.submit(d.id,1)).toThrow('版本冲突');expect(decisions.submit(d.id,2).request?.id).not.toBe(pending.request?.id);expect(signals.snapshot()).toEqual(before);
});
test('two connections enforce optimistic revision version and durable restart history',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');const other=new DecisionStore(file,'test-workspace',current);
 try {other.revise(d.id,1,'observe','continue');expect(()=>decisions.revise(d.id,1,'reduce_coupon','late')).toThrow('版本冲突');}finally{other.close();}
 decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.history(d.id).map(d=>d.version)).toEqual([2,1]);expect(decisions.list()[0]?.selectedKind).toBe('observe');
});
for(const scenario of ['inventory','ads'] as const)test(`${scenario}: evidence gaps block submission even if a draft is saved`,async()=>{
 const run=await complete(scenario,'model','passed','OAT-1000');const d=decisions.create(run.id,action(run),'');expect(d.submissionBlockers.length).toBeGreaterThan(0);expect(()=>decisions.submit(d.id,1)).toThrow('不能提交');
});
test('late replenishment, offline replay and reviewer refusal never enter pending approval',async()=>{
 for(const [scenario,mode,verdict] of [['inventory','model','passed'],['margin','replay','passed'],['ads','model','rejected']] as const){const run=await complete(scenario,mode,verdict);const d=decisions.create(run.id,action(run),'');expect(()=>decisions.submit(d.id,1)).toThrow('不能提交');}
});
test('cross-scenario action, incomplete investigation and no-op observation fail safely',async()=>{
 const run=await complete();expect(()=>decisions.create(run.id,'reduce_budget','')).toThrow('场景');const d=decisions.create(run.id,'observe','');expect(()=>decisions.submit(d.id,1)).toThrow('观察方案');
 const running=runs.createSignal(signals.snapshot().records.find(r=>r.kind==='ads')!,'model').run;expect(()=>decisions.create(running.id,'reduce_budget','')).toThrow('有效报告');
});
test('current snapshot replacement and quality conflicts block a previously valid draft',async()=>{
 const run=await complete('ads');const d=decisions.create(run.id,'reduce_budget','');signals.import('ads',ADS_DEMO.replace(',180000,',',200000,'),undefined,'demo');expect(()=>decisions.submit(d.id,1)).toThrow('快照');expect(decisions.history(d.id)[0]?.evidenceHash).toBe(d.evidenceHash);
});
test('CSV is analysis only and cannot use demo simulation exception',async()=>{
 data.import(DEMO_CSV,undefined,'csv');const run=await complete('margin','model','passed','TEA-500','csv');const d=decisions.create(run.id,'reduce_coupon','');expect(d.environment).toBe('analysis_only');expect(()=>decisions.submit(d.id,1)).toThrow('CSV');
});
test('expired draft, aged evidence and tampered action digest block submission',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');const db=new Database(file+'.investigations.sqlite');
 const expired={...d,expiresAt:'2000-01-01T00:00:00Z'};db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify(expired),d.id);expect(()=>decisions.submit(d.id,1)).toThrow('有效期');
 db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify({...d,after:{couponMinor:1}}),d.id);expect(()=>decisions.submit(d.id,1)).toThrow('参数摘要');
 db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify(d),d.id);db.query('UPDATE investigations SET json=? WHERE id=?').run(JSON.stringify({...run,evidence:{...run.evidence,importedAt:'2000-01-01T00:00:00Z'}}),run.id);expect(()=>decisions.submit(d.id,1)).toThrow('24小时');db.close();
});
test('workspace mismatch and renderer-supplied actor, amounts, approval and paths reject',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.history(d.id)).toThrow('工作空间');}finally{other.close();}
 for(const forged of [{op:'decision_create',investigationId:run.id,kind:'reduce_coupon',note:'',after:{couponMinor:1}},{op:'decision_submit',id:d.id,expectedVersion:1,actor:'approver'},{op:'decision_approve',id:d.id},{op:'investigation_export',id:run.id,format:'json',path:'C:/other'}])expect(RetailRequestSchema.safeParse(forged).success).toBe(false);
});
test('JSON and Markdown exports retain all evidence and contain untrusted text safely',async()=>{
 const run=await complete();if(!run.report)throw new Error('fixture');run.report.summary='<script>bad()</script> [x](https://evil.invalid) ```';
 const json=JSON.parse(exportInvestigation(run,'json').content);expect(json.runId).toBe(run.id);expect(json.evidenceIndex).toHaveLength(4);expect(json.investigation.evidence).toEqual(run.evidence);
 const md=exportInvestigation(run,'md').content;expect(md).toContain('&lt;script&gt;');expect(md).toContain('````json');expect(md).toContain(run.recordId);expect(exportInvestigation({...run,report:null,error:'failed'},'json').content).toContain('failed');
});

test('future decision schema refuses downgrade before creating new business tables',()=>{
 const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(2)');
 expect(()=>new DecisionStore(file,'test-workspace',current)).toThrow('版本高于');db.close();
});

test('calculation changes require a new reviewed investigation rather than only a fresh draft revision',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');if(!run.report)throw new Error('fixture');run.report.scenarios[1]!.couponMinor=1;
 const db=new Database(file+'.investigations.sqlite');db.query('UPDATE investigations SET json=? WHERE id=?').run(JSON.stringify(run),run.id);db.close();
 expect(()=>decisions.revise(d.id,1,'reduce_coupon','new parameters')).toThrow('测算规则');expect(()=>decisions.submit(d.id,1)).toThrow('不能提交');expect(decisions.list()[0]?.submissionBlockers.join('')).toContain('重新调查');
});
