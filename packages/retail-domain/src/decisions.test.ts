import { beforeEach, afterEach, test, expect, spyOn } from 'bun:test';
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
import { DEMO_CSV, RetailRequestSchema } from './operations';
import type { SimulationExecutor } from './simulation';
import { ADS_DEMO, INVENTORY_EXECUTION_DEMO } from './signals';
import type { SimulationApprover } from './approval-types';
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
 const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(4)');
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
