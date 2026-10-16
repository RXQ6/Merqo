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
import { ADS_DEMO } from './signals';
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
 const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(3)');
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
