import { callReadonlyTool } from './readonly-tools';
import { reviewDigest } from './outcome-reviews';
import { beforeEach, afterEach, test, expect, spyOn, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { DecisionStore } from './decisions';
import { runInvestigation, isSignalInvestigation } from './investigations';
import { runSignalInvestigation } from './signal-investigations';
import { exportInvestigation } from './investigation-export';
import { BUNDLE_DEMO_CSV, GIFT_DEMO_CSV, MEMBER_DEMO_CSV, OFFER_DEMO_CSV, DEMO_CSV, previewCsv, RetailRequestSchema, snapshotCsv } from './operations';
import { selectOffers } from './offers';
import type { SimulationExecutor } from './simulation';
import { ADS_DEMO, INVENTORY_EXECUTION_DEMO } from './signals';
import type { SimulationApprover } from './approval-types';
import type { AnyInvestigation, ModelPort, Scenario } from './investigations';
let dir: string; let file: string; let data: RetailStore; let signals: SignalStore; let runs: InvestigationStore; let decisions: DecisionStore;
const current=()=>[...data.snapshot().records,...signals.snapshot().records];
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'merqo-decisions-'));file=join(dir,'operations.sqlite');data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');signals=new SignalStore(file+'.signals.sqlite');signals.demo();runs=new InvestigationStore(file+'.investigations.sqlite');decisions=new DecisionStore(file,'test-workspace',current);});
afterEach(()=>{setSystemTime();decisions.close();runs.close();signals.close();data.close();rmSync(dir,{recursive:true,force:true});});
function modelFor(run:AnyInvestigation,verdict='passed'):ModelPort { return async(system,prompt)=>{
 if(system.includes('串行只读 Reviewer'))return JSON.stringify({verdict,notes:['本地契约测试，非真实模型评估']});
 const context=JSON.parse(prompt);const tools=['retail_get_data_health','retail_get_sku_context',run.scenario==='ads'?'retail_get_campaigns':run.scenario==='inventory'?'retail_get_inventory':'retail_get_promotions','retail_simulate_actions'];
 if(context.observations.length<4)return JSON.stringify({tool:tools[context.observations.length]});
 return JSON.stringify({report:{summary:'合成案例契约报告',observations:[],hypotheses:[],unknowns:['缺实时状态'],alternatives:['可能存在口径差异'],options:[{kind:'observe',rationale:'核验'},{kind:run.scenario==='ads'?'reduce_budget':run.scenario==='inventory'?'replenish_draft':'reduce_coupon',rationale:'仅作条件测算'}]}});
}; }
async function complete(scenario:'margin'|'ads'|'inventory'='margin',mode:'model'|'replay'='model',verdict='passed',sku='TEA-500',source:'demo'|'csv'='demo',retry=false):Promise<AnyInvestigation>{
 const run=scenario==='margin'?runs.create(data.snapshot().records.find(r=>r.source===source&&r.row.sku_id===sku)!,mode,retry).run:runs.createSignal(signals.snapshot().records.find(r=>r.source===source&&r.kind===scenario&&r.row.sku_id===sku)!,mode,retry).run;
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
test('expired draft, invalid import time and tampered action digest block submission',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');const db=new Database(file+'.investigations.sqlite');
 const expired={...d,expiresAt:'2000-01-01T00:00:00Z'};db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify(expired),d.id);expect(()=>decisions.submit(d.id,1)).toThrow('有效期');
 db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify({...d,after:{couponMinor:1}}),d.id);expect(()=>decisions.submit(d.id,1)).toThrow('参数摘要');
 db.query('UPDATE decisions SET json=? WHERE id=?').run(JSON.stringify(d),d.id);db.query('UPDATE investigations SET json=? WHERE id=?').run(JSON.stringify({...run,evidence:{...run.evidence,importedAt:'2999-01-01T00:00:00Z'}}),run.id);expect(()=>decisions.submit(d.id,1)).toThrow('导入时间');db.close();
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
 const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(7)');
 expect(()=>new DecisionStore(file,'test-workspace',current)).toThrow('版本高于');db.close();
});

test('calculation changes require a new reviewed investigation rather than only a fresh draft revision',async()=>{
 const run=await complete();const d=decisions.create(run.id,'reduce_coupon','');if(!run.report)throw new Error('fixture');run.report.scenarios[1]!.couponMinor=1;
 const db=new Database(file+'.investigations.sqlite');db.query('UPDATE investigations SET json=? WHERE id=?').run(JSON.stringify(run),run.id);db.close();
 expect(()=>decisions.revise(d.id,1,'reduce_coupon','new parameters')).toThrow('测算规则');expect(()=>decisions.submit(d.id,1)).toThrow('不能提交');expect(decisions.list()[0]?.submissionBlockers.join('')).toContain('重新调查');
});

const approver:SimulationApprover={id:'local-simulation-approver',role:'approver',environment:'simulation'};
async function pendingApproval(){const run=await complete();const d=decisions.create(run.id,'reduce_coupon','审批用例');return decisions.submit(d.id,1);}
test('approved exact-version resolution and audit survive restart and never change source business values',async()=>{
 const d=await pendingApproval();const before=data.snapshot();const r=d.request!;
 const approved=decisions.resolveApproval(r.id,1,r.actionHash,'approve','演示约束已核对',approver);
 expect(approved.status).toBe('approved');expect(approved.resolution?.actor).toEqual(approver);expect(approved.resolution?.evidenceHash).toBe(d.evidenceHash);expect(approved.audit.at(-1)?.event).toBe('approval_approved');
 const repeated=decisions.resolveApproval(r.id,1,r.actionHash,'approve','演示约束已核对',approver);expect(repeated.resolution?.id).toBe(approved.resolution?.id);expect(repeated.audit.filter(e=>e.event==='approval_approved')).toHaveLength(1);
 decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.approvals()[0]?.status).toBe('approved');expect(decisions.list()[0]?.state).toBe('approved');expect(data.snapshot()).toEqual(before);
});
test('rejection requires reason, is immutable, and cannot be overwritten by another connection',async()=>{
 const d=await pendingApproval();const r=d.request!;expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'reject',' ',approver)).toThrow('理由');
 const other=new DecisionStore(file,'test-workspace',current);try{const rejected=other.resolveApproval(r.id,1,r.actionHash,'reject','补齐逐单分摊后再评估',approver);expect(rejected.status).toBe('rejected');expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','换个结论',approver)).toThrow('不能覆盖');expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'reject','换个理由',approver)).toThrow('不能覆盖');}finally{other.close();}
 expect(decisions.approvals()[0]?.resolution?.reason).toBe('补齐逐单分摊后再评估');
});
test('new revision supersedes an already approved request and preserves its original conclusion',async()=>{
 const d=await pendingApproval();const r=d.request!;decisions.resolveApproval(r.id,1,r.actionHash,'approve','旧版本',approver);decisions.revise(d.id,1,'reduce_coupon','新版本');
 const old=decisions.approvals()[0]!;expect(old.status).toBe('superseded');expect(old.resolution?.decision).toBe('approved');expect(old.invalidation?.status).toBe('superseded');expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'reject','旧页',approver)).toThrow('不能覆盖');expect(decisions.history(d.id)[1]?.request?.status).toBe('superseded');
});
test('evidence changes invalidate pending request and persist even when attempted approval returns an error',async()=>{
 const d=await pendingApproval();const r=d.request!;data.import(DEMO_CSV.replace('10000,2000,1000','10000,1500,1000'),undefined,'demo');
 expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','旧页面',approver)).toThrow('不能处理');
 decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.approvals()[0]?.status).toBe('invalidated');expect(decisions.approvals()[0]?.resolution).toBeNull();expect(decisions.approvals()[0]?.audit.at(-1)?.actor).toBe('system-policy');
});
test('invalidated approval cannot resurrect when evidence callback later reports original values again',async()=>{
 const d=await pendingApproval();const r=d.request!;decisions.resolveApproval(r.id,1,r.actionHash,'approve','原证据',approver);const saved=current();
 const stale=new DecisionStore(file,'test-workspace',()=>[]);try{expect(stale.approvals()[0]?.status).toBe('invalidated');}finally{stale.close();}
 const restored=new DecisionStore(file,'test-workspace',()=>saved);try{const a=restored.approvals()[0]!;expect(a.status).toBe('invalidated');expect(a.resolution?.decision).toBe('approved');expect(a.audit.filter(e=>e.event==='approval_invalidated')).toHaveLength(1);}finally{restored.close();}
});
test('expired application latches expiry and never creates a resolution',async()=>{
 const d=await pendingApproval();const r=d.request!;const db=new Database(file+'.investigations.sqlite');db.query('UPDATE decision_requests SET json=? WHERE id=?').run(JSON.stringify({...r,expiresAt:'2000-01-01T00:00:00Z'}),r.id);
 expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','过期申请',approver)).toThrow('有效期');expect(decisions.approvals()[0]?.status).toBe('expired');expect(decisions.approvals()[0]?.resolution).toBeNull();
 db.query('UPDATE decision_requests SET json=? WHERE id=?').run(JSON.stringify(r),r.id);expect(decisions.approvals()[0]?.status).toBe('expired');db.close();
});
test('stale expected version or hash, missing server role and forged renderer identity reject',async()=>{
 const d=await pendingApproval();const r=d.request!;expect(()=>decisions.resolveApproval(r.id,2,r.actionHash,'approve','stale',approver)).toThrow('版本');expect(()=>decisions.resolveApproval(r.id,1,'a'.repeat(64),'approve','stale',approver)).toThrow('摘要');expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','no actor',null)).toThrow('服务端');
 const request={op:'approval_resolve',requestId:r.id,expectedVersion:1,expectedActionHash:r.actionHash,choice:'approve',reason:'ok'};
 expect(RetailRequestSchema.safeParse(request).success).toBe(true);for(const extra of [{actor:'admin'},{role:'approver'},{workspaceId:'other'},{approvedAt:'2026-01-01'},{after:{couponMinor:0}}])expect(RetailRequestSchema.safeParse({...request,...extra}).success).toBe(false);
 const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.resolveApproval(r.id,1,r.actionHash,'approve','cross scope',approver)).toThrow('工作空间');}finally{other.close();}
});
test('report changes invalidate an existing approval and retain the original report digest',async()=>{
 const d=await pendingApproval();const r=d.request!;const approved=decisions.resolveApproval(r.id,1,r.actionHash,'approve','核对',approver);const run=runs.get(d.investigationId);if(!run.report)throw new Error('fixture');run.report.reviewer.verdict='rejected';const db=new Database(file+'.investigations.sqlite');db.query('UPDATE investigations SET json=? WHERE id=?').run(JSON.stringify(run),run.id);db.close();
 const invalid=decisions.approvals()[0]!;expect(invalid.status).toBe('invalidated');expect(invalid.resolution?.reportHash).toBe(approved.resolution?.reportHash);
});
test('v1 migration creates a readable consistent backup and retains existing pending requests',async()=>{
 const d=await pendingApproval();const r=d.request!;decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DROP TABLE approval_resolutions;DROP TABLE approval_invalidations;DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(1)');db.close();
 decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.approvals()[0]?.id).toBe(r.id);const backups=readdirSync(dir).filter(f=>f.includes('.backup-v1-'));expect(backups).toHaveLength(1);
 const backup=new Database(join(dir,backups[0]!),{readonly:true});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(backup.query('SELECT max(version) AS version FROM decision_schema').get()).toEqual({version:1});expect(backup.query('SELECT id FROM decision_requests WHERE id=?').get(r.id)).toEqual({id:r.id});backup.close();
});

test('approved authorization expires at the exact deadline and remains expired after clock restoration',async()=>{
 const d=await pendingApproval();const r=d.request!;decisions.resolveApproval(r.id,1,r.actionHash,'approve','时效检查',approver);const clock=spyOn(Date,'now');
 try{clock.mockReturnValue(Date.parse(r.expiresAt)-1);expect(decisions.approvals()[0]?.status).toBe('approved');clock.mockReturnValue(Date.parse(r.expiresAt));expect(decisions.approvals()[0]?.status).toBe('expired');}finally{clock.mockRestore();}
 const a=decisions.approvals()[0]!;expect(a.status).toBe('expired');expect(a.resolution?.decision).toBe('approved');expect(a.audit.filter(e=>e.event==='approval_invalidated')).toHaveLength(1);
});
test('pending old version cannot be approved from a stale open page after revision',async()=>{
 const d=await pendingApproval();const r=d.request!;decisions.revise(d.id,1,'reduce_coupon','新参数版本');expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','旧窗口',approver)).toThrow('旧申请');expect(decisions.approvals()[0]?.resolution).toBeNull();
});

test('two independent worker processes racing approval and rejection produce one durable conclusion',async()=>{
 const d=await pendingApproval();const r=d.request!;
 const execute=async(choice:'approve'|'reject')=>{const payload={op:'approval_resolve',requestId:r.id,expectedVersion:1,expectedActionHash:r.actionHash,choice,reason:choice==='approve'?'并发批准':'并发驳回'};
  const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-simulation-approver'],{stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
  const [output,errors,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(!output)throw new Error(errors||String(code));return JSON.parse(output) as {ok:boolean};};
 const replies=await Promise.all([execute('approve'),execute('reject')]);expect(replies.filter(r=>r.ok)).toHaveLength(1);
 const a=decisions.approvals()[0]!;expect(['approved','rejected']).toContain(a.status);expect(a.audit.filter(e=>e.event==='approval_approved'||e.event==='approval_rejected')).toHaveLength(1);
},15000);

const executor:SimulationExecutor={id:'local-simulation-executor',role:'executor',environment:'simulation'};
async function approvedExecution(scenario:'margin'|'inventory'|'ads'='margin') {
 if(scenario==='inventory')signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo');
 const run=await complete(scenario,'model','passed','TEA-500','demo',true);const draft=decisions.create(run.id,action(run),'模拟执行测试');const submitted=decisions.submit(draft.id,1);const request=submitted.request!;
 decisions.resolveApproval(request.id,1,request.actionHash,'approve','核对本地模拟约束',approver);
 return decisions.executions().find(e=>e.job.requestId===request.id)!;
}
for(const scenario of ['margin','inventory','ads'] as const)test(`${scenario}: approved action writes isolated simulation state and immutable reconciled receipt`,async()=>{
 const job=await approvedExecution(scenario);const original=[data.snapshot(),signals.snapshot()];expect(job.status).toBe('ready');expect(job.current).toBeNull();
 const result=decisions.executeSimulation(job.job.id,1,job.job.actionHash,executor);expect(result.status).toBe('succeeded');expect(result.receipt?.before.version).toBe(0);expect(result.receipt?.after.version).toBe(1);expect(result.reconciliation?.matched).toBe(true);expect(result.receipt?.after.values).toEqual(job.job.expectedAfter);expect(result.receipt?.resolutionId).toBe(job.job.resolutionId);expect([data.snapshot(),signals.snapshot()]).toEqual(original);
 if(scenario==='margin')expect(result.current?.values.couponMinor).toBe(1500);if(scenario==='ads')expect(result.current?.values).toEqual({budgetMinor:90000});if(scenario==='inventory'){expect(result.current?.values).toEqual({pendingPurchaseQuantity:20,leadDays:1});expect(signals.snapshot().records.find(r=>r.kind==='inventory'&&r.row.sku_id==='TEA-500')?.metrics.available).toBe(40);}
});
test('simulation execution denies forged role, version/hash, scope and renderer amounts',async()=>{
 const item=await approvedExecution();const j=item.job;expect(()=>decisions.executeSimulation(j.id,1,j.actionHash,null)).toThrow('角色');expect(()=>decisions.executeSimulation(j.id,2,j.actionHash,executor)).toThrow('版本');expect(()=>decisions.executeSimulation(j.id,1,'0'.repeat(64),executor)).toThrow('摘要');
 const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.executeSimulation(j.id,1,j.actionHash,executor)).toThrow('工作空间');}finally{other.close();}
 const request={op:'simulation_execute',id:j.id,expectedVersion:1,expectedActionHash:j.actionHash};expect(RetailRequestSchema.safeParse(request).success).toBe(true);for(const extra of [{actor:executor},{workspaceId:'other'},{after:{couponMinor:1}},{idempotencyKey:'other'},{environment:'production'}])expect(RetailRequestSchema.safeParse({...request,...extra}).success).toBe(false);
 expect(decisions.executions()[0]?.receipt).toBeNull();
});
test('expired, superseded and replaced evidence stop approved execution and persist failed attempts',async()=>{
 const job=await approvedExecution();const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.parse(job.job.expiresAt));const failed=decisions.executeSimulation(job.job.id,1,job.job.actionHash,executor);expect(failed.status).toBe('failed');expect(failed.attempts[0]?.reason).toContain('有效期');expect(failed.current).toBeNull();}finally{clock.mockRestore();}
 const run=await complete('ads');const d=decisions.create(run.id,'reduce_budget','');const request=decisions.submit(d.id,1).request!;decisions.resolveApproval(request.id,1,request.actionHash,'approve','approve',approver);const ads=decisions.executions().find(e=>e.job.requestId===request.id)!;
 signals.import('ads',ADS_DEMO.replace(',180000,',',200000,'),undefined,'demo');expect(decisions.executeSimulation(ads.job.id,1,ads.job.actionHash,executor).attempts[0]?.reason).toContain('快照');
 const rev=await complete('margin','model','passed','TEA-500','demo',true);const draft=decisions.create(rev.id,'reduce_coupon','');const r=decisions.submit(draft.id,1).request!;decisions.resolveApproval(r.id,1,r.actionHash,'approve','approve',approver);const prior=decisions.executions().find(e=>e.job.requestId===r.id)!;decisions.revise(draft.id,1,'reduce_coupon','new');expect(decisions.executeSimulation(prior.job.id,1,prior.job.actionHash,executor).receipt).toBeNull();expect(decisions.approvals().find(a=>a.id===r.id)?.status).toBe('superseded');
});
test('two approved actions for one resource detect target version conflict rather than overwrite',async()=>{
 const first=await approvedExecution();const second=await approvedExecution();expect(second.job.id).not.toBe(first.job.id);expect(second.job.expectedStateVersion).toBe(0);
 const success=decisions.executeSimulation(first.job.id,1,first.job.actionHash,executor);const conflict=decisions.executeSimulation(second.job.id,1,second.job.actionHash,executor);expect(conflict.status).toBe('failed');expect(conflict.attempts[0]?.reason).toContain('冲突');expect(conflict.current).toEqual(success.current);expect(conflict.receipt).toBeNull();expect(decisions.approvals().find(a=>a.id===second.job.requestId)?.status).toBe('invalidated');
});
test('receipt insert failure rolls back effects while failure attempt persists and retry succeeds once',async()=>{
 const item=await approvedExecution();const j=item.job;const db=new Database(file+'.investigations.sqlite');db.exec("CREATE TRIGGER simulate_disk_failure BEFORE INSERT ON simulation_receipts BEGIN SELECT RAISE(ABORT,'injected receipt write failure');END;");
 const failed=decisions.executeSimulation(j.id,1,j.actionHash,executor);expect(failed.status).toBe('failed');expect(failed.current).toBeNull();expect(failed.receipt).toBeNull();expect(failed.attempts).toHaveLength(1);expect(failed.attempts[0]?.reason).toContain('injected receipt');db.exec('DROP TRIGGER simulate_disk_failure');db.close();
 const result=decisions.executeSimulation(j.id,1,j.actionHash,executor);expect(result.status).toBe('succeeded');expect(result.attempts).toHaveLength(2);expect(result.current?.version).toBe(1);
});
test('lost response and restart recover exact receipt; repeated success after expiry never executes twice',async()=>{
 const item=await approvedExecution();const j=item.job;const receipt=decisions.executeSimulation(j.id,1,j.actionHash,executor).receipt;
 decisions.close();decisions=new DecisionStore(file,'test-workspace',current);const recovered=decisions.executions()[0]!;expect(recovered.receipt).toEqual(receipt);
 const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.parse(j.expiresAt));const retry=decisions.executeSimulation(j.id,1,j.actionHash,executor);expect(retry.receipt).toEqual(receipt);expect(retry.attempts).toHaveLength(1);expect(retry.current?.version).toBe(1);}finally{clock.mockRestore();}
});
test('reread reconciliation reports later drift, preserves original receipt and never overwrites state',async()=>{
 const item=await approvedExecution();const j=item.job;const executed=decisions.executeSimulation(j.id,1,j.actionHash,executor);const altered={...executed.current!,version:2,values:{couponMinor:1000}};
 const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify(altered),j.resourceKey);db.close();const checked=decisions.reconcileExecution(j.id,executor);expect(checked.reconciliation?.matched).toBe(false);expect(checked.reconciliation?.differences.length).toBe(2);expect(checked.receipt).toEqual(executed.receipt);expect(checked.current).toEqual(altered);
});
test('two independent worker execution requests return one receipt and one side effect',async()=>{
 const item=await approvedExecution();const j=item.job;const execute=async()=>{const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-simulation-executor'],{stdin:new Blob([JSON.stringify({op:'simulation_execute',id:j.id,expectedVersion:1,expectedActionHash:j.actionHash})]),stdout:'pipe',stderr:'pipe'});const [text,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw new Error(err);return JSON.parse(text);};
 const [a,b]=await Promise.all([execute(),execute()]);expect(a.ok).toBe(true);expect(b.ok).toBe(true);expect(a.data[0].receipt.id).toBe(b.data[0].receipt.id);expect(decisions.executions()[0]?.attempts).toHaveLength(1);expect(decisions.executions()[0]?.current?.version).toBe(1);
},15000);
test('v2 migration backs up approvals and queues legacy valid approved decisions without effects',async()=>{
 const item=await approvedExecution();decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DROP TABLE simulation_jobs;DROP TABLE simulation_states;DROP TABLE simulation_receipts;DROP TABLE simulation_attempts;DROP TABLE simulation_reconciliations;DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(2)');db.close();decisions=new DecisionStore(file,'test-workspace',current);
 const restored=decisions.executions()[0]!;expect(restored.job.id).toBe(item.job.id);expect(restored.job.expectedStateVersion).toBe(0);expect(restored.receipt).toBeNull();const backups=readdirSync(dir).filter(f=>f.includes('.backup-v2-'));expect(backups).toHaveLength(1);const backup=new Database(join(dir,backups[0]!),{readonly:true});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(backup.query('SELECT count(*) AS count FROM approval_resolutions').get()).toEqual({count:1});backup.close();
});
test('tampered execution amounts cannot diverge from approved deterministic action',async()=>{
 const item=await approvedExecution();const j=item.job;const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_jobs SET json=? WHERE id=?').run(JSON.stringify({...j,expectedAfter:{couponMinor:0}}),j.id);db.close();expect(()=>decisions.executeSimulation(j.id,1,j.actionHash,executor)).toThrow('批准动作');expect(decisions.executions()[0]?.receipt).toBeNull();
});

test('abandoned uncommitted local write rolls back on process exit and ready job can recover',async()=>{
 const item=await approvedExecution();const j=item.job;
 const uncommitted={resourceKey:j.resourceKey,version:1,evidenceHash:j.evidenceHash,values:j.expectedAfter,updatedAt:new Date().toISOString()};
 const code=`import { Database } from 'bun:sqlite';const db=new Database(${JSON.stringify(file+'.investigations.sqlite')});db.exec('BEGIN IMMEDIATE');db.query('INSERT INTO simulation_states VALUES(?,?)').run(${JSON.stringify(j.resourceKey)},${JSON.stringify(JSON.stringify(uncommitted))});process.exit(19);`;
 const child=Bun.spawn([Bun.which('bun')||'bun','--eval',code],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(19);expect(decisions.executions()[0]?.current).toBeNull();expect(decisions.executions()[0]?.status).toBe('ready');expect(decisions.executeSimulation(j.id,1,j.actionHash,executor).status).toBe('succeeded');
},10000);
test('later reviewed evidence can start from the current simulated value without overwriting unrelated state',async()=>{
 const first=await approvedExecution('ads');decisions.executeSimulation(first.job.id,1,first.job.actionHash,executor);
 signals.import('ads',ADS_DEMO.replace(',100000,180000,',',90000,162000,'),undefined,'demo');
 const run=await complete('ads','model','passed','TEA-500','demo',true);const d=decisions.create(run.id,'reduce_budget','新证据核对当前模拟预算');const r=decisions.submit(d.id,1).request!;decisions.resolveApproval(r.id,1,r.actionHash,'approve','新版本检查',approver);const next=decisions.executions().find(v=>v.job.requestId===r.id)!;expect(next.job.expectedStateVersion).toBe(1);expect(next.job.expectedStateHash).toHaveLength(64);const applied=decisions.executeSimulation(next.job.id,1,next.job.actionHash,executor);expect(applied.status).toBe('succeeded');expect(applied.current?.version).toBe(2);expect(applied.current?.values.budgetMinor).toBe(81000);expect(decisions.reconcileExecution(first.job.id,executor).reconciliation?.matched).toBe(false);
});

test('built-in replenishment variant only changes demo lead time and preserves the blocked risk example',()=>{
 const before=signals.snapshot().records.find(r=>r.source==='demo'&&r.kind==='inventory'&&r.row.sku_id==='TEA-500')!;expect('lead_days' in before.row&&before.row.lead_days).toBe(5);signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo');const after=signals.snapshot().records.find(r=>r.source==='demo'&&r.kind==='inventory'&&r.row.sku_id==='TEA-500')!;expect('lead_days' in after.row&&after.row.lead_days).toBe(1);expect(after.metrics.available).toBe(40);expect(RetailRequestSchema.safeParse({op:'signals_replenishment_demo',csv:'arbitrary'}).success).toBe(false);
});

test('approval and ready item commit together; queue failure cannot leave an executable orphan approval',async()=>{
 const d=await pendingApproval();const r=d.request!;const db=new Database(file+'.investigations.sqlite');db.exec("CREATE TRIGGER queue_failure BEFORE INSERT ON simulation_jobs BEGIN SELECT RAISE(ABORT,'injected queue failure');END;");expect(()=>decisions.resolveApproval(r.id,1,r.actionHash,'approve','批准待执行事务',approver)).toThrow('queue failure');expect(decisions.approvals()[0]?.status).toBe('pending');expect(decisions.approvals()[0]?.resolution).toBeNull();expect(decisions.executions()).toHaveLength(0);db.exec('DROP TRIGGER queue_failure');db.close();
 decisions.resolveApproval(r.id,1,r.actionHash,'approve','批准待执行事务',approver);const job=decisions.executions()[0]!;decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.executions()[0]?.job.id).toBe(job.job.id);expect(decisions.executions()[0]?.status).toBe('ready');expect(decisions.executions()[0]?.current).toBeNull();
});

async function compensationOrigin(scenario:'margin'|'inventory'|'ads'='ads') {const item=await approvedExecution(scenario);return decisions.executeSimulation(item.job.id,1,item.job.actionHash,executor);}
function approveCompensation(id:string){const c=decisions.compensations().find(v=>v.request.id===id)!;return decisions.resolveCompensation(id,c.request.version,c.request.actionHash,'approve','核对恢复目标与当前版本',approver);}
test('compensation requires new approval, restores ads baseline, rereads and preserves original history and sources',async()=>{
 const origin=await compensationOrigin();const snapshots=[data.snapshot(),signals.snapshot()];const c=decisions.createCompensation(origin.job.id,'停止本地预算试验');expect(c.status).toBe('pending');expect(c.request.before?.values.budgetMinor).toBe(90000);expect(c.request.target.budgetMinor).toBe(100000);expect(decisions.createCompensation(origin.job.id,'重复点击').request.id).toBe(c.request.id);
 const refused=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(refused.receipt).toBeNull();expect(refused.attempts[0]?.reason).toContain('pending');expect(refused.request.before?.version).toBe(1);
 const approved=approveCompensation(c.request.id);expect(approved.status).toBe('approved');expect(approved.resolution?.id).not.toBe(origin.job.resolutionId);const result=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(result.status).toBe('completed');expect(result.receipt?.after.values.budgetMinor).toBe(100000);expect(result.receipt?.after.version).toBe(2);expect(result.checks[0]?.matched).toBe(true);expect(result.audit.some(e=>e.event==='completed')).toBe(true);expect(decisions.executions()[0]?.receipt).toEqual(origin.receipt);expect([data.snapshot(),signals.snapshot()]).toEqual(snapshots);expect(()=>decisions.reviseCompensation(c.request.id,1,'再次补偿')).toThrow('已经完成');
});
test('margin restoration below floor blocks, corrected fresh evidence can be reviewed without bypassing rules',async()=>{
 const origin=await compensationOrigin('margin');const blocked=decisions.createCompensation(origin.job.id,'申请恢复商家券');expect(blocked.blockers.join('')).toContain('毛利下限');expect(()=>approveCompensation(blocked.request.id)).toThrow('毛利下限');expect(decisions.executeCompensation(blocked.request.id,1,blocked.request.actionHash,executor).receipt).toBeNull();
 data.import(DEMO_CSV.replace(',6000,40,',',5500,40,'),undefined,'demo');const revised=decisions.reviseCompensation(blocked.request.id,1,'成本修正后重新核验恢复');expect(revised.status).toBe('pending');expect(revised.history[1]?.status).toBe('superseded');approveCompensation(revised.request.id);const success=decisions.executeCompensation(revised.request.id,2,revised.request.actionHash,executor);expect(success.receipt?.after.values.couponMinor).toBe(2000);
});
test('pending replenishment cancellation does not receive stock and legacy pending receipts remain cancellable',async()=>{
 const origin=await compensationOrigin('inventory');expect(origin.current?.purchaseRequestStatus).toBe('pending');const stock=signals.snapshot();const c=decisions.createCompensation(origin.job.id,'取消未受理演示请求');expect(c.status).toBe('pending');approveCompensation(c.request.id);const cancelled=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(cancelled.receipt?.after.purchaseRequestStatus).toBe('cancelled');expect(cancelled.receipt?.after.values).toEqual({pendingPurchaseQuantity:0,leadDays:0});expect(signals.snapshot()).toEqual(stock);
});
test('accepted replenishment or unknown state cannot be cancelled by compensation',async()=>{
 const origin=await compensationOrigin('inventory');const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify({...origin.current!,version:2,purchaseRequestStatus:'accepted'}),origin.job.resourceKey);db.close();const blocked=decisions.createCompensation(origin.job.id,'申请取消');expect(blocked.blockers.join('')).toContain('已受理');expect(()=>approveCompensation(blocked.request.id)).toThrow('不能处理');expect(decisions.executeCompensation(blocked.request.id,1,blocked.request.actionHash,executor).receipt).toBeNull();
});
test('compensation denies roles, stale version/hash, forged payload and cross-workspace access',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'身份校验');const r=c.request;expect(()=>decisions.resolveCompensation(r.id,1,r.actionHash,'approve','x',null)).toThrow('角色');expect(()=>decisions.executeCompensation(r.id,1,r.actionHash,null)).toThrow('角色');expect(()=>decisions.resolveCompensation(r.id,2,r.actionHash,'approve','x',approver)).toThrow('版本');expect(()=>decisions.executeCompensation(r.id,1,'0'.repeat(64),executor)).toThrow('摘要');
 const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.createCompensation(origin.job.id,'other')).toThrow('工作空间');expect(()=>other.resolveCompensation(r.id,1,r.actionHash,'approve','other',approver)).toThrow('工作空间');}finally{other.close();}
 const payload={op:'compensation_execute',id:r.id,expectedVersion:1,expectedActionHash:r.actionHash};expect(RetailRequestSchema.safeParse(payload).success).toBe(true);for(const extra of [{actor:executor},{target:{budgetMinor:1}},{workspaceId:'other'},{environment:'production'},{beforeVersion:2}])expect(RetailRequestSchema.safeParse({...payload,...extra}).success).toBe(false);expect(()=>decisions.createCompensation(origin.job.id,' ')).toThrow('理由');
});
test('compensation rejection and revisions retain immutable conclusions and invalidate the approved old version',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'恢复试验');const r=c.request;decisions.resolveCompensation(r.id,1,r.actionHash,'reject','继续观察',approver);expect(()=>decisions.resolveCompensation(r.id,1,r.actionHash,'approve','覆盖结论',approver)).toThrow('不能覆盖');const next=decisions.reviseCompensation(r.id,1,'新理由');expect(next.request.version).toBe(2);expect(next.history[1]?.resolution?.choice).toBe('reject');expect(next.history[1]?.status).toBe('superseded');approveCompensation(r.id);const third=decisions.reviseCompensation(r.id,2,'再次修改');expect(third.status).toBe('pending');expect(()=>decisions.executeCompensation(r.id,2,next.request.actionHash,executor)).toThrow('版本');expect(third.history[1]?.resolution?.choice).toBe('approve');
});
test('compensation approval and execution expire independently, invalidation persists after clock restoration',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'时效');approveCompensation(c.request.id);const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.parse(c.request.expiresAt));expect(decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor).receipt).toBeNull();expect(decisions.compensations()[0]?.status).toBe('expired');}finally{clock.mockRestore();}expect(decisions.compensations()[0]?.status).toBe('expired');expect(decisions.compensations()[0]?.resolution?.choice).toBe('approve');
});
test('compensation is a new grant and can restore historical success after original approval expiry',async()=>{
 const origin=await compensationOrigin();const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.parse(origin.job.expiresAt)+1000);expect(decisions.approvals()[0]?.status).toBe('expired');const c=decisions.createCompensation(origin.job.id,'独立新授权');expect(c.status).toBe('pending');approveCompensation(c.request.id);expect(decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor).status).toBe('completed');}finally{clock.mockRestore();}
});
test('source changes invalidate compensation approval even when failed resolve returns an error',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'证据绑定');signals.import('ads',ADS_DEMO.replace(',180000,',',200000,'),undefined,'demo');expect(()=>decisions.resolveCompensation(c.request.id,1,c.request.actionHash,'approve','旧证据',approver)).toThrow('证据');const invalid=decisions.compensations()[0]!;expect(invalid.status).toBe('invalidated');expect(invalid.audit.some(e=>e.event==='invalidated')).toBe(true);const renewed=decisions.reviseCompensation(c.request.id,1,'核验新证据');expect(renewed.status).toBe('pending');
});
test('later target modification including ABA cannot be overwritten or bypassed with a compensation revision',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'冲突检查');approveCompensation(c.request.id);const db=new Database(file+'.investigations.sqlite');const altered={...origin.current!,version:3};db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify(altered),origin.job.resourceKey);db.close();const refused=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(refused.status).toBe('invalidated');expect(refused.blockers.join('')).toContain('后续动作');expect(refused.receipt).toBeNull();const revised=decisions.reviseCompensation(c.request.id,1,'尝试重新绑定');expect(revised.status).toBe('invalidated');expect(decisions.executions()[0]?.current).toEqual(altered);
});
test('compensation receipt failure rolls back effect and audit; retry preserves failed attempt and succeeds once',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'故障');approveCompensation(c.request.id);const db=new Database(file+'.investigations.sqlite');db.exec("CREATE TRIGGER compensation_failure BEFORE INSERT ON compensation_receipts BEGIN SELECT RAISE(ABORT,'injected compensation failure');END;");const failed=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(failed.receipt).toBeNull();expect(failed.attempts).toHaveLength(1);expect(decisions.executions()[0]?.current).toEqual(origin.current);expect(failed.audit.some(e=>e.event==='completed')).toBe(false);db.exec('DROP TRIGGER compensation_failure');db.close();const success=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(success.attempts).toHaveLength(2);expect(success.receipt?.after.version).toBe(2);
});
test('compensation pending approval and lost-response success survive restart, repeated success never applies twice',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'重启');decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.compensations()[0]?.status).toBe('pending');approveCompensation(c.request.id);const done=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);decisions.close();decisions=new DecisionStore(file,'test-workspace',current);const retry=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(retry.receipt).toEqual(done.receipt);expect(retry.attempts.filter(a=>a.status==='succeeded')).toHaveLength(1);expect(decisions.executions()[0]?.current?.version).toBe(2);
});
test('compensation reread detects drift while retaining original execution and compensation receipts',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'核对');approveCompensation(c.request.id);const done=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify({...done.receipt!.after,version:3,values:{budgetMinor:110000}}),origin.job.resourceKey);db.close();const checked=decisions.reconcileCompensation(c.request.id,executor);expect(checked.checks[0]?.matched).toBe(false);expect(checked.checks).toHaveLength(2);expect(checked.receipt).toEqual(done.receipt);expect(decisions.executions()[0]?.receipt).toEqual(origin.receipt);
});
test('independent workers racing compensation execution produce one restoration and one receipt',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'并发');approveCompensation(c.request.id);const run=async()=>{const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-simulation-executor'],{stdin:new Blob([JSON.stringify({op:'compensation_execute',id:c.request.id,expectedVersion:1,expectedActionHash:c.request.actionHash})]),stdout:'pipe',stderr:'pipe'});const [output,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exit)throw new Error(err);return JSON.parse(output);};const [a,b]=await Promise.all([run(),run()]);expect(a.ok).toBe(true);expect(b.ok).toBe(true);expect(a.data[0].receipt.id).toBe(b.data[0].receipt.id);expect(decisions.compensations()[0]?.attempts.filter(a=>a.status==='succeeded')).toHaveLength(1);expect(decisions.executions()[0]?.current?.version).toBe(2);
},15000);
test('v3 migration backs up original execution ledger and supports legacy pending inventory compensation',async()=>{
 const origin=await compensationOrigin('inventory');const legacyState={...origin.current!};delete legacyState.purchaseRequestStatus;const legacyReceipt={...origin.receipt!,after:legacyState};decisions.close();const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_states SET json=? WHERE resource_key=?').run(JSON.stringify(legacyState),origin.job.resourceKey);db.query('UPDATE simulation_receipts SET json=? WHERE job_id=?').run(JSON.stringify(legacyReceipt),origin.job.id);db.exec('DROP TABLE compensation_heads;DROP TABLE compensation_versions;DROP TABLE compensation_resolutions;DROP TABLE compensation_invalidations;DROP TABLE compensation_receipts;DROP TABLE compensation_attempts;DROP TABLE compensation_checks;DROP TABLE compensation_events;DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(3)');db.close();decisions=new DecisionStore(file,'test-workspace',current);const backups=readdirSync(dir).filter(f=>f.includes('.backup-v3-'));expect(backups).toHaveLength(1);const backup=new Database(join(dir,backups[0]!),{readonly:true});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(backup.query('SELECT count(*) AS count FROM simulation_receipts').get()).toEqual({count:1});backup.close();const c=decisions.createCompensation(origin.job.id,'取消旧版pending请求');expect(c.status).toBe('pending');approveCompensation(c.request.id);expect(decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor).receipt?.after.purchaseRequestStatus).toBe('cancelled');
});

test('compensation initial reread mismatch cannot be recorded as successful restoration',async()=>{
 const origin=await compensationOrigin();const c=decisions.createCompensation(origin.job.id,'验证回读');approveCompensation(c.request.id);const db=new Database(file+'.investigations.sqlite');db.exec("CREATE TRIGGER ignore_simulation_update BEFORE UPDATE ON simulation_states BEGIN SELECT RAISE(IGNORE);END;");const result=decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor);expect(result.receipt).toBeNull();expect(result.attempts[0]?.reason).toContain('回读不一致');expect(result.checks).toHaveLength(0);expect(result.audit.some(a=>a.event==='completed')).toBe(false);expect(decisions.executions()[0]?.current).toEqual(origin.current);db.exec('DROP TRIGGER ignore_simulation_update');db.close();expect(decisions.executeCompensation(c.request.id,1,c.request.actionHash,executor).status).toBe('completed');
});

async function twoBatchJobs(){const ads=await approvedExecution('ads');const stock=await approvedExecution('inventory');return[ads,stock] as const;}
test('batch freezes individually approved actions; successful run remains idempotent and source isolated',async()=>{
 const jobs=await twoBatchJobs();const originals=[data.snapshot(),signals.snapshot()];const batch=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'两个独立经营动作');expect(batch.status).toBe('ready');expect(batch.batch.items.map(i=>i.resolutionId)).toEqual(jobs.map(j=>j.job.resolutionId));expect(decisions.createExecutionBatch(jobs.map(j=>j.job.id),'两个独立经营动作').batch.id).toBe(batch.batch.id);expect(()=>decisions.executeSimulation(jobs[0].job.id,1,jobs[0].job.actionHash,executor)).toThrow('批次');
 const result=decisions.runExecutionBatch(batch.batch.id,executor);expect(result.status).toBe('succeeded');expect(result.items.every(i=>i.dispatch.status==='succeeded')).toBe(true);expect(decisions.runExecutionBatch(batch.batch.id,executor).items.map(i=>i.receipt?.id)).toEqual(result.items.map(i=>i.receipt?.id));expect(decisions.executions().every(v=>v.attempts.filter(a=>a.status==='succeeded').length===1)).toBe(true);expect([data.snapshot(),signals.snapshot()]).toEqual(originals);
});
test('batch partial success retains first receipt; only confirmed failed item may be retried',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'部分成功验证');const db=new Database(file+'.investigations.sqlite');db.exec(`CREATE TRIGGER one_item_failure BEFORE INSERT ON simulation_receipts WHEN NEW.job_id='${jobs[1].job.id}' BEGIN SELECT RAISE(ABORT,'injected batch item failure');END;`);const partial=decisions.runExecutionBatch(b.batch.id,executor);expect(partial.status).toBe('partial');expect(partial.items[0]?.dispatch.status).toBe('succeeded');expect(partial.items[1]?.dispatch.status).toBe('failed');const firstReceipt=partial.items[0]?.receipt;expect(()=>decisions.runExecutionBatch(b.batch.id,executor,jobs[0].job.id)).toThrow('不能重放');db.exec('DROP TRIGGER one_item_failure');db.close();const done=decisions.runExecutionBatch(b.batch.id,executor,jobs[1].job.id);expect(done.status).toBe('succeeded');expect(done.items[0]?.receipt).toEqual(firstReceipt);expect(decisions.executions().find(j=>j.job.id===jobs[0].job.id)?.attempts).toHaveLength(1);expect(decisions.executions().find(j=>j.job.id===jobs[1].job.id)?.attempts).toHaveLength(2);
});
test('unknown after abandoned claim blocks retries; local proof fences old token and permits explicit continue',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'租约恢复');const lease=decisions.claimBatchItem(b.batch.id,jobs[0].job.id,'ready',executor);expect(()=>decisions.recoverExecutionBatch(b.batch.id,executor)).toThrow('租约仍有效');const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.now()+16000);expect(decisions.executionBatch(b.batch.id).status).toBe('unknown');expect(()=>decisions.runExecutionBatch(b.batch.id,executor)).toThrow('待确认');expect(()=>decisions.runExecutionBatch(b.batch.id,executor,jobs[0].job.id)).toThrow('待确认');const recovered=decisions.recoverExecutionBatch(b.batch.id,executor);expect(recovered.items[0]?.dispatch.status).toBe('ready');expect(recovered.events.some(e=>e.event==='recovered_ready')).toBe(true);expect(()=>decisions.executeSimulation(jobs[0].job.id,1,jobs[0].job.actionHash,executor,lease)).toThrow('租约已失效');}finally{clock.mockRestore();}expect(decisions.runExecutionBatch(b.batch.id,executor).status).toBe('succeeded');
});
test('committed action with lost checkpoint recovers from exact receipt without applying it again',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'提交后响应丢失');const lease=decisions.claimBatchItem(b.batch.id,jobs[0].job.id,'ready',executor);const applied=decisions.executeSimulation(jobs[0].job.id,1,jobs[0].job.actionHash,executor,lease);decisions.close();decisions=new DecisionStore(file,'test-workspace',current);const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.now()+16000);const recovered=decisions.recoverExecutionBatch(b.batch.id,executor);expect(recovered.items[0]?.dispatch.receiptId).toBe(applied.receipt?.id);expect(recovered.status).toBe('partial');}finally{clock.mockRestore();}const done=decisions.runExecutionBatch(b.batch.id,executor);expect(done.status).toBe('succeeded');expect(decisions.executions().find(j=>j.job.id===jobs[0].job.id)?.attempts).toHaveLength(1);
});
test('partial batch still revalidates evidence and current approval on each action',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'证据变化');signals.import('inventory',INVENTORY_EXECUTION_DEMO.replace(',2026-10-20,1',',2026-10-20,4'),undefined,'demo');const result=decisions.runExecutionBatch(b.batch.id,executor);expect(result.status).toBe('partial');expect(result.items[0]?.receipt).not.toBeNull();expect(result.items[1]?.receipt).toBeNull();expect(result.items[1]?.dispatch.reason).toContain('快照');
});
test('batch rejects unapproved, cross-workspace, repeated resource, malformed and forged-role requests',async()=>{
 const jobs=await twoBatchJobs();expect(()=>decisions.createExecutionBatch([jobs[0].job.id],'少于两项')).toThrow('2至10');expect(()=>decisions.createExecutionBatch([jobs[0].job.id,jobs[0].job.id],'重复')).toThrow('不同');const secondAds=await approvedExecution('ads');expect(()=>decisions.createExecutionBatch([jobs[0].job.id,secondAds.job.id],'同一目标')).toThrow('同一模拟目标');const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'身份校验');expect(()=>decisions.runExecutionBatch(b.batch.id,null)).toThrow('角色');expect(()=>decisions.recoverExecutionBatch(b.batch.id,null)).toThrow('角色');const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.executionBatch(b.batch.id)).toThrow('工作空间');}finally{other.close();}const payload={op:'batch_run',id:b.batch.id};expect(RetailRequestSchema.safeParse(payload).success).toBe(true);for(const extra of [{actor:executor},{force:true},{transport:'external'},{jobIds:jobs.map(j=>j.job.id)},{leaseSeconds:1}])expect(RetailRequestSchema.safeParse({...payload,...extra}).success).toBe(false);
});
test('batch lease and failed work survive restart; recovery never trusts an unbound receipt',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'绑定核对');const lease=decisions.claimBatchItem(b.batch.id,jobs[0].job.id,'ready',executor);const applied=decisions.executeSimulation(jobs[0].job.id,1,jobs[0].job.actionHash,executor,lease);const db=new Database(file+'.investigations.sqlite');db.query('UPDATE simulation_receipts SET json=? WHERE job_id=?').run(JSON.stringify({...applied.receipt!,actionHash:'0'.repeat(64)}),jobs[0].job.id);db.close();const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.now()+16000);const unknown=decisions.recoverExecutionBatch(b.batch.id,executor);expect(unknown.status).toBe('unknown');expect(unknown.items[0]?.dispatch.reason).toContain('绑定');expect(()=>decisions.runExecutionBatch(b.batch.id,executor)).toThrow('待确认');}finally{clock.mockRestore();}
});
test('actual worker process exit after claiming leaves durable unknown intent and no business effect',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'进程退出');const code=`import {DecisionStore} from ${JSON.stringify(resolve(import.meta.dir,'decisions.ts'))};const store=new DecisionStore(${JSON.stringify(file)},'test-workspace',()=>[]);store.claimBatchItem(${JSON.stringify(b.batch.id)},${JSON.stringify(jobs[0].job.id)},'ready',{id:'local-simulation-executor',role:'executor',environment:'simulation'});process.exit(23);`;const child=Bun.spawn([Bun.which('bun')||'bun','--eval',code],{stdout:'pipe',stderr:'pipe'});expect(await child.exited).toBe(23);expect(decisions.executions().find(j=>j.job.id===jobs[0].job.id)?.receipt).toBeNull();const clock=spyOn(Date,'now');try{clock.mockReturnValue(Date.now()+16000);expect(decisions.executionBatch(b.batch.id).status).toBe('unknown');expect(decisions.recoverExecutionBatch(b.batch.id,executor).items[0]?.dispatch.status).toBe('ready');}finally{clock.mockRestore();}
},15000);
test('independent batch runners never duplicate success even when one sees a busy claim',async()=>{
 const jobs=await twoBatchJobs();const b=decisions.createExecutionBatch(jobs.map(j=>j.job.id),'并发执行');const run=async()=>{const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-simulation-executor'],{stdin:new Blob([JSON.stringify({op:'batch_run',id:b.batch.id})]),stdout:'pipe',stderr:'pipe'});const [output,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(!output)throw new Error(err||String(exit));return JSON.parse(output);};const replies=await Promise.all([run(),run()]);expect(replies.some(r=>r.ok)).toBe(true);const view=decisions.executionBatch(b.batch.id);if(view.items.some(i=>i.dispatch.status==='ready'))decisions.runExecutionBatch(b.batch.id,executor);expect(decisions.executionBatch(b.batch.id).status).toBe('succeeded');for(const job of jobs)expect(decisions.executions().find(v=>v.job.id===job.job.id)?.attempts.filter(a=>a.status==='succeeded')).toHaveLength(1);
},15000);
test('v4 migration preserves compensation receipts and adds batch tables with a consistent backup',async()=>{
 const origin=await compensationOrigin();const comp=decisions.createCompensation(origin.job.id,'迁移前补偿');approveCompensation(comp.request.id);const restored=decisions.executeCompensation(comp.request.id,1,comp.request.actionHash,executor);const jobs=await twoBatchJobs();decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DROP TABLE execution_batches;DROP TABLE execution_batch_items;DROP TABLE execution_dispatches;DROP TABLE execution_batch_events;DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(4)');db.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.createExecutionBatch(jobs.map(j=>j.job.id),'迁移后批次').items).toHaveLength(2);const backups=readdirSync(dir).filter(f=>f.includes('.backup-v4-'));expect(backups).toHaveLength(1);const backup=new Database(join(dir,backups[0]!),{readonly:true});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(backup.query('SELECT count(*) AS count FROM compensation_receipts').get()).toEqual({count:1});backup.close();expect(decisions.compensations()[0]?.receipt).toEqual(restored.receipt);
});
test('forward simulation reread mismatch rolls back the effect and success receipt',async()=>{
 const item=await approvedExecution();const db=new Database(file+'.investigations.sqlite');db.exec("CREATE TRIGGER ignore_forward BEFORE INSERT ON simulation_states BEGIN SELECT RAISE(IGNORE);END;");const failed=decisions.executeSimulation(item.job.id,1,item.job.actionHash,executor);expect(failed.receipt).toBeNull();expect(failed.current).toBeNull();expect(failed.attempts[0]?.reason).toContain('回读不一致');db.exec('DROP TRIGGER ignore_forward');db.close();
});

function observationCsv(row:object):string {const data=row as Record<string,unknown>;const keys=Object.keys(data);return [keys.join(','),keys.map(k=>{const raw=data[k];const v=raw==null?'':typeof raw==='object'?JSON.stringify(raw):String(raw);return '"'+v.replaceAll('"','""')+'"';}).join(',')].join('\n');}
async function observedReview(scenario:'margin'|'inventory'|'ads'='margin') {const origin=await compensationOrigin(scenario);const opened=decisions.createReview(origin.job.id);const observed=decisions.observeReview(opened.review.id,opened.review.version,null);return {origin,observed};}
for(const scenario of ['margin','inventory','ads'] as const)test(`${scenario}: outcome replay freezes source, compares actual input values and persists reviewed Case`,async()=>{
 const {origin,observed}=await observedReview(scenario);const snapshots=[data.snapshot(),signals.snapshot()];expect(observed.review.clockBasis).toBe('synthetic_business_date');expect(observed.metrics.every(m=>m.delta===0||m.delta===null)).toBe(true);expect(observed.review.receipt).toEqual(origin.receipt!);expect(decisions.createReview(origin.job.id).review.id).toBe(observed.review.id);
 setSystemTime(new Date('2026-11-01T00:00:00Z'));const r=observed.review;const done=decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','仅比较合成窗口，不归因','同期活动未核实；没有真实观测','local-simulation-reviewer');expect(done.state).toBe('reviewed');expect(done.case?.refs.receiptId).toBe(origin.receipt?.id);expect(done.case?.warning).toContain('合成');expect(done.history.map(h=>h.version)).toEqual([3,2,1]);expect([data.snapshot(),signals.snapshot()]).toEqual(snapshots);
 expect(decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','仅比较合成窗口，不归因','同期活动未核实；没有真实观测','local-simulation-reviewer').case?.id).toBe(done.case?.id);expect(()=>decisions.finalizeReview(r.id,3,r.observation!.hash,'comparison_only','改写结论','其他','local-simulation-reviewer')).toThrow('不可覆盖');decisions.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.reviews()[0]?.case).toEqual(done.case);
 const bundle=JSON.parse(exportInvestigation(runs.get(r.investigationId),'json',[],[],[],[],[done]).content);expect(bundle.reviews[0].case.refs.observationHash).toBe(r.observation!.hash);expect(exportInvestigation(runs.get(r.investigationId),'md',[],[],[],[],[done]).content).toContain(done.case!.id);
});
test('future window and missing observation cannot be finalized; waiting state survives clock changes',async()=>{
 const {observed}=await observedReview('ads');setSystemTime(new Date(observed.review.windowEnd+'T12:00:00+08:00'));const r=observed.review;expect(decisions.reviews()[0]?.state).toBe('awaiting_window');expect(()=>decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','比较','未知','local-simulation-reviewer')).toThrow('窗口未结束');setSystemTime(new Date('2026-11-01T00:00:00Z'));expect(decisions.reviews()[0]?.state).toBe('ready');
});
test('observation preview checks exact scope, window, baseline values, attribution and checksum',async()=>{
 const {observed}=await observedReview('ads');const r=observed.review;const row=r.observation!.row;const csv=observationCsv(row);const p=decisions.previewObservation(r.id,csv);expect(p.blockers).toEqual([]);expect(()=>decisions.observeReview(r.id,r.version,{csv,hash:'0'.repeat(64)})).toThrow('预览摘要');
 for(const patch of [{shop_id:'other'},{sku_id:'other'},{campaign_id:'other'},{window_days:3},{baseline_spend_minor:1},{attribution_window:'different'},{date:'2026-11-10'}]){const bad=observationCsv({...row,...patch});const preview=decisions.previewObservation(r.id,bad);expect(preview.blockers.length).toBeGreaterThan(0);expect(()=>decisions.observeReview(r.id,r.version,{csv:bad,hash:preview.hash})).toThrow();}
 expect(()=>decisions.previewObservation(r.id,csv+'\n'+csv.split('\n')[1])).toThrow('恰好一条');expect(()=>decisions.previewObservation(r.id,'wrong\n1')).toThrow('恰好一条');
});
test('missing costs remain unknown, require inconclusive result and preserve earlier versions',async()=>{
 const {observed}=await observedReview();const r=observed.review;const csv=observationCsv({...r.observation!.row,cost_minor:null});const p=decisions.previewObservation(r.id,csv);expect(p.metrics.find(m=>m.key==='profit')?.after).toBeNull();const changed=decisions.observeReview(r.id,r.version,{csv,hash:p.hash});expect(changed.state).toBe('needs_evidence');expect(()=>decisions.finalizeReview(r.id,changed.review.version,changed.review.observation!.hash,'comparison_only','比较','未知','local-simulation-reviewer')).toThrow('只能保存无法判断');expect(decisions.finalizeReview(r.id,changed.review.version,changed.review.observation!.hash,'inconclusive','成本缺失，无法判断','活动未核实','local-simulation-reviewer').case?.conclusion).toBe('inconclusive');expect(changed.history[1]?.observation?.origin).toBe('builtin_synthetic');
});
test('review role, version, observation hash and unexecuted job are enforced server-side',async()=>{
 const ready=await approvedExecution();expect(()=>decisions.createReview(ready.job.id)).toThrow('成功');const origin=decisions.executeSimulation(ready.job.id,1,ready.job.actionHash,executor);const opened=decisions.createReview(origin.job.id);expect(()=>decisions.finalizeReview(opened.review.id,1,'0'.repeat(64),'inconclusive','待补证','未知','local-simulation-reviewer')).toThrow();const r=decisions.observeReview(opened.review.id,1,null).review;
 expect(()=>decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','结论','未知','local-analyst')).toThrow('角色');expect(()=>decisions.finalizeReview(r.id,1,r.observation!.hash,'comparison_only','结论','未知','local-simulation-reviewer')).toThrow('版本');const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.observeReview(r.id,2,null)).toThrow('工作空间');}finally{other.close();}
 expect(RetailRequestSchema.safeParse({op:'review_finalize',id:r.id,expectedVersion:2,observationHash:r.observation!.hash,conclusion:'comparison_only',note:'结论',confounders:'未知',actor:'local-simulation-reviewer'}).success).toBe(false);expect(RetailRequestSchema.safeParse({op:'review_demo',id:r.id,expectedVersion:2,synthetic:false}).success).toBe(false);
});
test('reviewed cases are scoped by source, business date, review time, dimensions and frozen at investigation creation',async()=>{
 const {observed}=await observedReview();const r=observed.review;const finalized=decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','保持原值的回放','没有因果证据','local-simulation-reviewer');const e=structuredClone(r.baseline);if(!('calculation' in e))throw new Error('margin fixture expected');e.row.date=r.windowEnd;const asOf=new Date(Date.now()+1000).toISOString();expect(decisions.searchCases(e,'margin',asOf).map(c=>c.id)).toEqual([finalized.case!.id]);
 expect(decisions.searchCases(r.baseline,'margin',asOf)).toEqual([]);expect(decisions.searchCases({...e,source:'csv'},'margin',asOf)).toEqual([]);expect(decisions.searchCases(e,'ads',asOf)).toEqual([]);expect(decisions.searchCases(e,'margin','2000-01-01T00:00:00Z')).toEqual([]);for(const patch of [{shop_id:'other'},{channel:'other'},{sku_id:'other'},{spec:'other'}])expect(decisions.searchCases({...e,row:{...e.row,...patch}},'margin',asOf)).toEqual([]);
 runs.close();runs=new InvestigationStore(file+'.investigations.sqlite',false,'test-workspace');const next=runs.create(e as import('./operations').EvidenceRecord,'model',true).run;expect(next.caseContext?.[0]?.id).toBe(finalized.case?.id);const tool=callReadonlyTool({scenario:'margin',evidence:next.evidence,caseContext:next.caseContext??[]},'retail_get_sku_context') as {data:{historicalCases:unknown[]};caseContextHash:string};expect(tool.data.historicalCases).toEqual(next.caseContext??[]);expect(tool.caseContextHash).toBe(reviewDigest(next.caseContext));
 const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM retail_cases');db.close();expect(runs.get(next.id).caseContext).toEqual(next.caseContext??[]);expect((callReadonlyTool({scenario:'margin',evidence:next.evidence,caseContext:next.caseContext??[]},'retail_get_sku_context') as {data:{historicalCases:unknown[]}}).data.historicalCases).toEqual(next.caseContext??[]);
});
test('concurrent reviewers preserve a single immutable Case and cannot overwrite each other',async()=>{
 const {observed}=await observedReview();const r=observed.review;const invoke=async(note:string)=>{const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-simulation-reviewer'],{stdin:new Blob([JSON.stringify({op:'review_finalize',id:r.id,expectedVersion:r.version,observationHash:r.observation!.hash,conclusion:'comparison_only',note,confounders:'没有真实因果证明'})]),stdout:'pipe',stderr:'pipe'});const output=await new Response(child.stdout).text();await child.exited;return JSON.parse(output);};const replies=await Promise.all([invoke('复核甲'),invoke('复核乙')]);expect(replies.filter(r=>r.ok)).toHaveLength(1);expect(decisions.reviews()[0]?.history).toHaveLength(3);const db=new Database(file+'.investigations.sqlite');expect(db.query('SELECT count(*) AS n FROM retail_cases').get()).toEqual({n:1});db.close();
});
test('v5 migration backs up a real execution batch and receipt before adding reviews',async()=>{
 const {observed}=await observedReview();const jobs=await twoBatchJobs();const originalBatch=decisions.createExecutionBatch(jobs.map(v=>v.job.id),'升级前批次');decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DROP TABLE outcome_reviews;DROP TABLE outcome_review_versions;DROP TABLE retail_cases;DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(5)');db.close();decisions=new DecisionStore(file,'test-workspace',current);expect(decisions.createReview(observed.review.job.id).review.version).toBe(1);expect(decisions.executionBatch(originalBatch.batch.id).batch).toEqual(originalBatch.batch);const backups=readdirSync(dir).filter(n=>n.includes('.backup-v5-'));expect(backups).toHaveLength(1);const backup=new Database(join(dir,backups[0]!),{readonly:true});expect(backup.query('PRAGMA integrity_check').get()).toEqual({integrity_check:'ok'});expect(backup.query('SELECT count(*) AS n FROM simulation_receipts').get()).toEqual({n:1});expect(backup.query('SELECT count(*) AS n FROM execution_batches').get()).toEqual({n:1});expect(backup.query('SELECT count(*) AS n FROM execution_batch_items').get()).toEqual({n:2});backup.close();
});

for(const scenario of ['inventory','ads'] as const)test(`${scenario}: historical Case filters exact warehouse or Campaign and workspace`,async()=>{
 const {observed}=await observedReview(scenario);const r=observed.review;setSystemTime(new Date('2026-11-01T00:00:00Z'));const done=decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','仅比较','没有因果证据','local-simulation-reviewer');const e=structuredClone(r.baseline);if(!('metrics' in e))throw new Error('signal fixture expected');e.row.date=r.windowEnd;const at=new Date(Date.now()+1000).toISOString();expect(decisions.searchCases(e,scenario,at)[0]?.id).toBe(done.case?.id);const wrong=structuredClone(e);if('warehouse_id' in wrong.row)wrong.row.warehouse_id='other';else wrong.row.campaign_id='other';expect(decisions.searchCases(wrong,scenario,at)).toEqual([]);const other=new DecisionStore(file,'other-workspace',current);try{expect(other.searchCases(e,scenario,at)).toEqual([]);}finally{other.close();}
});
test('explicit follow-up loads only reviewed built-in synthetic observation and freezes Case without execution',async()=>{
 const {observed}=await observedReview();const r=observed.review;const done=decisions.finalizeReview(r.id,r.version,r.observation!.hash,'comparison_only','比较','未核实活动','local-simulation-reviewer');const receipts=decisions.executions().map(v=>v.receipt?.id);const invoke=async(expectedCaseId:string)=>{const child=Bun.spawn([Bun.which('bun')||'bun',resolve(import.meta.dir,'../../../scripts/retailpilot-data-worker.ts'),file,'Test','test-workspace','local-analyst'],{stdin:new Blob([JSON.stringify({op:'review_followup',id:r.id,expectedCaseId,mode:'replay'})]),stdout:'pipe',stderr:'pipe'});const output=await new Response(child.stdout).text();await child.exited;return JSON.parse(output);};expect((await invoke('00000000-0000-4000-8000-000000000000')).ok).toBe(false);const next=await invoke(done.case!.id);expect(next.ok).toBe(true);expect(next.data[0].caseContext[0].id).toBe(done.case!.id);expect(next.data[0].evidence.row.date).toBe(r.windowEnd);expect(next.data[0].mode).toBe('replay');expect(decisions.executions().map(v=>v.receipt?.id)).toEqual(receipts);expect(runs.get(r.investigationId).caseContext??[]).toEqual([]);
});

for(const scenario of ['margin','inventory','ads'] as const)test(`${scenario}: old synthetic import remains eligible while new draft and approval gates still apply`,async()=>{
 if(scenario==='inventory')signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo');
 const old='2000-01-01T00:00:00Z';const db=new Database(file);db.query("UPDATE retail_batches SET imported_at=? WHERE source='demo'").run(old);db.close();const sdb=new Database(file+'.signals.sqlite');sdb.query("UPDATE signal_batches SET imported_at=?,json=json_set(json,'$.importedAt',?) WHERE source='demo'").run(old,old);sdb.close();
 const run=await complete(scenario,'model','passed','TEA-500','demo',true);expect(run.evidence.importedAt).toBe(old);const d=decisions.create(run.id,action(run),'历史合成样例仍可模拟');expect(d.submissionBlockers).toEqual([]);const pending=decisions.submit(d.id,1);expect(pending.state).toBe('pending_approval');decisions.resolveApproval(pending.request!.id,1,pending.actionHash,'approve','仅本地模拟',approver);const job=decisions.executions().find(v=>v.job.decisionId===d.id)!.job;expect(decisions.executeSimulation(job.id,1,job.actionHash,executor).receipt).not.toBeNull();expect(current().find(e=>e.id===run.recordId)?.importedAt).toBe(old);
 if(scenario==='ads'){const comp=decisions.createCompensation(job.id,'历史合成演示恢复');expect(comp.blockers).toEqual([]);approveCompensation(comp.request.id);expect(decisions.executeCompensation(comp.request.id,1,comp.request.actionHash,executor).receipt).not.toBeNull();}
});
test('explicit sample restore creates a new evidence revision and never revives prior approval after a round trip',async()=>{
 const ready=await approvedExecution('inventory');const initial=ready.job.evidenceHash;signals.demo();signals.import('inventory',INVENTORY_EXECUTION_DEMO,undefined,'demo',true);const now=signals.snapshot().records.find(e=>e.kind==='inventory'&&e.row.sku_id==='TEA-500')!;expect(now.hash).not.toBe(initial);expect(decisions.approvals().find(v=>v.id===ready.job.requestId)?.status).toBe('invalidated');const result=decisions.executeSimulation(ready.job.id,1,ready.job.actionHash,executor);expect(result.receipt).toBeNull();expect(result.attempts[0]?.reason).toContain('快照');
});

test('draft blockers distinguish offline, needs-evidence and rejection without granting approval',async()=>{
 for(const [scenario,mode,verdict,reason] of [['margin','replay','passed','离线演示没有模型Reviewer'],['ads','model','needs_evidence','Reviewer待补证'],['margin','model','rejected','Reviewer已驳回']] as const){
  const run=await complete(scenario,mode,verdict,'TEA-500','demo',true);const d=decisions.create(run.id,action(run),'');expect(d.submissionBlockers.some(s=>s.includes(reason))).toBe(true);expect(()=>decisions.submit(d.id,1)).toThrow('不能提交');expect(decisions.approvals()).toHaveLength(0);
 }
});


test('bundle evidence gaps cannot enter approval even with a protocol Reviewer pass', async () => {
 data.import(BUNDLE_DEMO_CSV, undefined, 'demo');
 for (const sku of ['PACK-CONFLICT', 'PACK-MISSING']) {
  const run = await complete('margin', 'model', 'passed', sku);
  const draft = decisions.create(run.id, 'reduce_coupon', '仅协议夹具');
  expect(draft.submissionBlockers.length).toBeGreaterThan(0);
  expect(() => decisions.submit(draft.id, 1)).toThrow('不能提交');
 }
 expect(decisions.executions()).toHaveLength(0);
});

test('bundle simulation, observation identity and Case matching preserve the component contract', async () => {
 const row = { ...previewCsv(BUNDLE_DEMO_CSV).valid[0]!, coupon_minor: 2000 };
 data.import(observationCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '组合装协议夹具');
 const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 const executed = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(executed.reconciliation?.matched).toBe(true);
 const opened = decisions.createReview(job.id);
 const observed = decisions.observeReview(opened.review.id, 1, null);
 const r = observed.review;
 const observation = r.observation!.row;
 if (!('list_price_minor' in observation)) throw new Error('margin expected');
 expect(observation.bundle_components).toEqual(row.bundle_components);
 for (const patch of [
  { product_type: 'single', bundle_components: undefined },
  { bundle_components: [{ sku_id: 'OTHER', spec: '500ml', quantity: 6, unit_cost_minor: 1000 }] },
 ]) {
  const csv = observationCsv({ ...observation, ...patch });
  const p = decisions.previewObservation(r.id, csv);
  expect(p.blockers).toContain('组合装子项映射与原快照不一致');
  expect(() => decisions.observeReview(r.id, r.version, { csv, hash: p.hash })).toThrow('不一致');
 }
 const finalized = decisions.finalizeReview(r.id, r.version, r.observation!.hash, 'comparison_only', '仅比较', '未确认因果', 'local-simulation-reviewer');
 const e = data.snapshot().records.find(e => e.row.sku_id === row.sku_id)!;
 const later = { ...e, row: { ...e.row, date: r.windowEnd } };
 const asOf = new Date(Date.now() + 1000).toISOString();
 expect(decisions.searchCases(later, 'margin', asOf).map(c => c.id)).toEqual([finalized.case!.id]);
 expect(decisions.searchCases({ ...later, row: { ...later.row, product_type: 'single', bundle_components: undefined } }, 'margin', asOf)).toEqual([]);
 expect(decisions.searchCases({ ...later, row: { ...later.row, bundle_components: [{ sku_id: 'OTHER', spec: '500ml', quantity: 6, unit_cost_minor: 1000 }] } }, 'margin', asOf)).toEqual([]);
 const csv = observationCsv(observation);
 expect(previewCsv(csv).valid[0]?.bundle_components).toEqual(row.bundle_components);
});


test('gift uncertainty and CSV origin cannot enter approval despite a protocol Reviewer pass', async () => {
 const row = previewCsv(GIFT_DEMO_CSV).valid[1]!;
 for (const patch of [ { gifts: [{ ...row.gifts![0]!, unit_cost_minor: null }] }, { gift_cost_basis: 'included' as const }, { gift_policy: 'unknown' as const } ]) {
  data.import(observationCsv({ ...row, ...patch }), undefined, 'demo');
  const run = await complete('margin', 'model', 'passed', row.sku_id, 'demo', true);
  const draft = decisions.create(run.id, 'reduce_coupon', '赠品缺口协议测试');
  expect(draft.submissionBlockers.length).toBeGreaterThan(0);
  expect(() => decisions.submit(draft.id, 1)).toThrow('不能提交');
 }
 const usable = { ...row, gifts: [{ ...row.gifts![0]!, unit_cost_minor: 1000 }] };
 data.import(observationCsv(usable), undefined, 'csv');
 const csvRun = await complete('margin', 'model', 'passed', row.sku_id, 'csv');
 const draft = decisions.create(csvRun.id, 'reduce_coupon', 'CSV仍然只分析');
 expect(() => decisions.submit(draft.id, 1)).toThrow('不能提交'); expect(decisions.executions()).toHaveLength(0);
});

test('gift-inclusive coupon target executes once and keeps observation/Case/follow-up association', async () => {
 const row = { ...previewCsv(GIFT_DEMO_CSV).valid[1]! };
 row.gifts = [{ ...row.gifts![0]!, unit_cost_minor: 1000 }];
 data.import(observationCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '赠品协议夹具，仅模拟');
 expect(draft.after).toMatchObject({ couponMinor: 250, revenueMinor: 8750, marginBps: 2000 });
 expect(draft.selected.profitMinor).toBe(1750);
 const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 const executed = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(executed.reconciliation?.matched).toBe(true);
 expect(decisions.executeSimulation(job.id, 1, job.actionHash, executor).receipt?.id).toBe(executed.receipt?.id);
 const opened = decisions.createReview(job.id); const observed = decisions.observeReview(opened.review.id, 1, null); const r = observed.review;
 const observation = r.observation!.row; if (!('list_price_minor' in observation)) throw new Error('margin expected');
 expect(observation.gifts).toEqual(row.gifts);
 for (const patch of [
  { gift_policy: undefined, gift_cost_basis: undefined, gifts: undefined },
  { gift_policy: 'none' }, { gifts: [{ ...row.gifts[0]!, quantity: 2 }] },
  { gifts: [{ ...row.gifts[0]!, sku_id: 'OTHER-GIFT' }] }, { gift_cost_basis: 'included' },
 ]) {
  const csv = observationCsv({ ...observation, ...patch }); const p = decisions.previewObservation(r.id, csv);
  expect(p.blockers).toContain('赠品关联、数量或口径与原快照不一致');
  expect(() => decisions.observeReview(r.id, r.version, { csv, hash: p.hash })).toThrow('不一致');
 }
 const final = decisions.finalizeReview(r.id, r.version, r.observation!.hash, 'comparison_only', '仅比较', '赠品成本已计入，未确认因果', 'local-simulation-reviewer');
 const e = data.snapshot().records.find(e => e.row.sku_id === row.sku_id)!; const later = { ...e, row: { ...e.row, date: r.windowEnd } };
 const asOf = new Date(Date.now() + 1000).toISOString();
 expect(decisions.searchCases(later, 'margin', asOf).map(c => c.id)).toEqual([final.case!.id]);
 expect(decisions.searchCases({ ...later, row: { ...later.row, gifts: [{ ...row.gifts[0]!, quantity: 2 }] } }, 'margin', asOf)).toEqual([]);
 const child = Bun.spawn([Bun.which('bun') || 'bun', resolve(import.meta.dir, '../../../scripts/retailpilot-data-worker.ts'), file, 'Test', 'test-workspace', 'local-analyst'], {
  stdin: new Blob([JSON.stringify({ op: 'review_followup', id: r.id, expectedCaseId: final.case!.id, mode: 'replay' })]), stdout: 'pipe', stderr: 'pipe',
 });
 const next = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(0);
 expect(next.ok).toBe(true); expect(next.data[0].evidence.row.gifts).toEqual(row.gifts);
 expect(next.data[0].caseContext[0].id).toBe(final.case!.id);
 expect(decisions.executions().map(e => e.receipt?.id)).toEqual([executed.receipt!.id]);
});


test('membership unknown/expired/conflicting policy and CSV origin cannot enter approval', async () => {
 const row = previewCsv(MEMBER_DEMO_CSV).valid[0]!;
 for (const patch of [
  { membership: null }, { membership: { ...row.membership!, status: 'unknown' as const } },
  { membership: { ...row.membership!, valid_to: row.date } }, { coupon_minor: 500 },
  { membership: { ...row.membership!, discount_policy: 'unknown' as const } },
 ]) {
  data.import(snapshotCsv({ ...row, ...patch }), undefined, 'demo');
  const run = await complete('margin', 'model', 'passed', row.sku_id, 'demo', true);
  const draft = decisions.create(run.id, 'reduce_coupon', '会员门禁协议测试');
  expect(draft.submissionBlockers.length).toBeGreaterThan(0);
  expect(() => decisions.submit(draft.id, 1)).toThrow('不能提交');
 }
 const eligible = { ...row, coupon_minor: 1000, membership: { ...row.membership!, discount_policy: 'stackable' as const } };
 data.import(snapshotCsv(eligible), undefined, 'csv');
 const run = await complete('margin', 'model', 'passed', row.sku_id, 'csv');
 expect(() => decisions.submit(decisions.create(run.id, 'reduce_coupon', 'CSV仍仅分析').id, 1)).toThrow('不能提交');
 expect(decisions.executions()).toHaveLength(0);
});

test('membership coupon simulation preserves cohort, effective price and frozen Case through a real worker', async () => {
 const row = { ...previewCsv(MEMBER_DEMO_CSV).valid[0]!, coupon_minor: 1000 };
 row.membership = { ...row.membership!, discount_policy: 'stackable' };
 data.import(snapshotCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '会员协议夹具，仅模拟');
 expect(draft.after).toMatchObject({ couponMinor: 500, revenueMinor: 7500, marginBps: 2000 });
 const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 const executed = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(executed.reconciliation?.matched).toBe(true);
 expect(decisions.executeSimulation(job.id, 1, job.actionHash, executor).receipt?.id).toBe(executed.receipt?.id);
 const r = decisions.observeReview(decisions.createReview(job.id).review.id, 1, null).review;
 const observation = r.observation!.row; if (!('list_price_minor' in observation)) throw new Error('margin expected');
 expect(observation.membership).toEqual(row.membership);
 for (const membership of [undefined, null, { ...row.membership, status: 'non_member' as const }, { ...row.membership, segment_id: 'silver' }, { ...row.membership, discount_policy: 'exclusive' as const }]) {
  const csv = snapshotCsv({ ...observation, membership }); const p = decisions.previewObservation(r.id, csv);
  expect(p.blockers).toContain('会员分组、身份或叠加规则与原快照不一致');
  expect(() => decisions.observeReview(r.id, r.version, { csv, hash: p.hash })).toThrow('不一致');
 }
 const final = decisions.finalizeReview(r.id, r.version, r.observation!.hash, 'comparison_only', '仅比较', '会员价变化与销量响应未核实', 'local-simulation-reviewer');
 const e = data.snapshot().records.find(e => e.row.sku_id === row.sku_id)!; const later = { ...e, row: { ...e.row, date: r.windowEnd } };
 const asOf = new Date(Date.now() + 1000).toISOString();
 expect(decisions.searchCases(later, 'margin', asOf).map(c => c.id)).toEqual([final.case!.id]);
 expect(decisions.searchCases({ ...later, row: { ...later.row, membership: { ...row.membership, segment_id: 'silver' } } }, 'margin', asOf)).toEqual([]);
 const child = Bun.spawn([Bun.which('bun') || 'bun', resolve(import.meta.dir, '../../../scripts/retailpilot-data-worker.ts'), file, 'Test', 'test-workspace', 'local-analyst'], {
  stdin: new Blob([JSON.stringify({ op: 'review_followup', id: r.id, expectedCaseId: final.case!.id, mode: 'replay' })]), stdout: 'pipe', stderr: 'pipe',
 });
 const next = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(0);
 expect(next.ok).toBe(true); expect(next.data[0].evidence.row.membership).toEqual(row.membership);
 expect(next.data[0].evidence.calculation.revenueMinor).toBe(7000); // Observation retains original coupon, no invented effect.
 expect(next.data[0].caseContext[0].id).toBe(final.case!.id);
 expect(decisions.executions().map(e => e.receipt?.id)).toEqual([executed.receipt!.id]);
});

test('changed membership evidence invalidates an approval before any simulation side effect', async () => {
 const row = { ...previewCsv(MEMBER_DEMO_CSV).valid[0]!, coupon_minor: 1000 };
 row.membership = { ...row.membership!, discount_policy: 'stackable' };
 data.import(snapshotCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '批准版本绑定');
 const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 data.import(snapshotCsv({ ...row, membership: { ...row.membership, segment_id: 'silver' } }), undefined, 'demo');
 const result = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(result.receipt).toBeNull(); expect(result.current).toBeNull(); expect(result.status).toBe('failed');
});


test('unknown or unavailable reference offers block approval and CSV cannot gain execution privileges', async () => {
 const row = { ...previewCsv(OFFER_DEMO_CSV).valid[0]!, coupon_minor: 2000 };
 for (const offers of [null, row.offers!.map(o => ({ ...o, available: null })), row.offers!.map(o => ({ ...o, available: false })), row.offers!.map(o => ({ ...o, spec: 'other' }))]) {
  data.import(snapshotCsv({ ...row, offers }), undefined, 'demo');
  const run = await complete('margin', 'model', 'passed', row.sku_id, 'demo', true);
  const draft = decisions.create(run.id, 'reduce_coupon', '报价门禁协议测试');
  expect(draft.submissionBlockers.length).toBeGreaterThan(0);
  expect(() => decisions.submit(draft.id, 1)).toThrow('不能提交');
 }
 data.import(snapshotCsv(row), undefined, 'csv');
 const run = await complete('margin', 'model', 'passed', row.sku_id, 'csv');
 expect(() => decisions.submit(decisions.create(run.id, 'reduce_coupon', '报价不能授予CSV执行权限').id, 1)).toThrow('不能提交');
 expect(decisions.executions()).toHaveLength(0);
});

test('offer reference never becomes sale price, survives synthetic observation and freezes scoped Case through worker', async () => {
 const row = { ...previewCsv(OFFER_DEMO_CSV).valid[1]!, coupon_minor: 2000 };
 data.import(snapshotCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '报价仅参考，仍需批准');
 expect(draft.after).toMatchObject({ couponMinor: 1500, revenueMinor: 7500, marginBps: 2000 });
 const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 const executed = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(executed.reconciliation?.matched).toBe(true);
 expect(decisions.executeSimulation(job.id, 1, job.actionHash, executor).receipt?.id).toBe(executed.receipt?.id);
 const r = decisions.observeReview(decisions.createReview(job.id).review.id, 1, null).review;
 const observation = r.observation!.row; if (!('list_price_minor' in observation)) throw new Error('margin expected');
 expect(observation.offers!.every(o => o.observed_on === r.windowEnd)).toBe(true);
 expect(selectOffers(observation).selectedPriceMinor).toBe(3000);
 expect(observation.list_price_minor).toBe(10000);
 const stripped = snapshotCsv({ ...observation, offers: undefined }); const p = decisions.previewObservation(r.id, stripped);
 expect(p.blockers).toContain('参考报价上下文与原快照不一致，不能静默移除');
 expect(() => decisions.observeReview(r.id, r.version, { csv: stripped, hash: p.hash })).toThrow('不一致');
 const final = decisions.finalizeReview(r.id, r.version, r.observation!.hash, 'comparison_only', '仅比较', '合成报价，非实时可售或执行收益', 'local-simulation-reviewer');
 const e = data.snapshot().records.find(e => e.row.sku_id === row.sku_id)!;
 const later = { ...e, row: { ...e.row, date: r.windowEnd, offers: observation.offers } };
 const asOf = new Date(Date.now() + 1000).toISOString();
 expect(decisions.searchCases(later, 'margin', asOf).map(c => c.id)).toEqual([final.case!.id]);
 expect(decisions.searchCases({ ...later, row: { ...later.row, offers: undefined } }, 'margin', asOf)).toEqual([]);
 const child = Bun.spawn([Bun.which('bun') || 'bun', resolve(import.meta.dir, '../../../scripts/retailpilot-data-worker.ts'), file, 'Test', 'test-workspace', 'local-analyst'], {
  stdin: new Blob([JSON.stringify({ op: 'review_followup', id: r.id, expectedCaseId: final.case!.id, mode: 'replay' })]), stdout: 'pipe', stderr: 'pipe',
 });
 const next = JSON.parse(await new Response(child.stdout).text()); expect(await child.exited).toBe(0);
 expect(next.ok).toBe(true); expect(next.data[0].evidence.row.offers).toEqual(observation.offers);
 expect(next.data[0].evidence.calculation.revenueMinor).toBe(7000);
 expect(next.data[0].caseContext[0].id).toBe(final.case!.id);
 expect(decisions.executions().map(e => e.receipt?.id)).toEqual([executed.receipt!.id]);
});

test('changed reference availability invalidates exact approval before any simulation side effect', async () => {
 const row = { ...previewCsv(OFFER_DEMO_CSV).valid[0]!, coupon_minor: 2000 };
 data.import(snapshotCsv(row), undefined, 'demo');
 const run = await complete('margin', 'model', 'passed', row.sku_id);
 const draft = decisions.create(run.id, 'reduce_coupon', '批准绑定冻结报价'); const request = decisions.submit(draft.id, 1).request!;
 decisions.resolveApproval(request.id, 1, request.actionHash, 'approve', '仅模拟', approver);
 const job = decisions.executions().find(e => e.job.requestId === request.id)!.job;
 data.import(snapshotCsv({ ...row, offers: row.offers!.map(o => ({ ...o, available: false })) }), undefined, 'demo');
 const result = decisions.executeSimulation(job.id, 1, job.actionHash, executor);
 expect(result.receipt).toBeNull(); expect(result.current).toBeNull(); expect(result.status).toBe('failed');
});
