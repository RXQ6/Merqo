import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {Database} from 'bun:sqlite';
import {PolicyStore,readBusinessPolicy} from './policy-store';import {DEFAULT_RULE_SETTINGS,RuleSettingsSchema} from './business-policy';
import {RetailStore} from './store';import {SignalStore} from './signal-store';import {InvestigationStore} from './investigation-store';import {DecisionStore} from './decisions';
import {DEMO_CSV,snapshotCsv,RetailRequestSchema} from './operations';import {runInvestigation} from './investigations';import type {ModelPort} from './investigations';
import {simulateSignal,readSignalTool} from './signal-investigations';import {auditInventoryNumbers} from './inventory-numeric';import {auditAdsNumbers} from './ads-numeric';
const admin='local-simulation-admin';const approver={id:'local-simulation-approver',role:'approver',environment:'simulation'} as const;
const model:ModelPort=async(system,prompt)=>{if(system.includes('串行只读 Reviewer'))return JSON.stringify({verdict:'passed',notes:['仅本地配置协议夹具']});const c=JSON.parse(prompt);return c.responseContract.remainingTools.length?JSON.stringify({tool:c.responseContract.remainingTools[0]}):JSON.stringify({report:{summary:'核对冻结规则',observations:[],hypotheses:[],unknowns:['需求响应未知'],alternatives:['可能有活动变化'],options:[{kind:'observe',rationale:'核验'},{kind:'reduce_coupon',rationale:'条件比较'}]}});};
function fixture(){const dir=mkdtempSync(join(tmpdir(),'merqo-policy-'));const file=join(dir,'data.sqlite');const data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');const signals=new SignalStore(file+'.signals.sqlite');signals.demo();const policies=new PolicyStore(file);return{dir,file,data,signals,policies,close(){policies.close();signals.close();data.close();rmSync(dir,{recursive:true,force:true});}};}
const update=(f:ReturnType<typeof fixture>,settings=DEFAULT_RULE_SETTINGS,shopId:string|null=null,expectedRevision=f.policies.view().current.revision)=>f.policies.update({op:'policy_update',settings,shopId,expectedRevision,reason:'本地规则验收'},admin);

test('policy defaults, validation, server role, optimistic revision and immutable history survive reopen',()=>{
 const f=fixture();try{
  expect(readBusinessPolicy(f.file).revision).toBe(0);expect(f.policies.view().current.defaultSettings).toEqual(DEFAULT_RULE_SETTINGS);
  expect(()=>f.policies.update({op:'policy_update',settings:DEFAULT_RULE_SETTINGS,shopId:null,expectedRevision:0,reason:'伪造身份'},'local-analyst')).toThrow('管理员');
  expect(RuleSettingsSchema.safeParse({...DEFAULT_RULE_SETTINGS,approvalMinutes:0}).success).toBe(false);
  expect(RuleSettingsSchema.safeParse({...DEFAULT_RULE_SETTINGS,stockBufferDays:1.2}).success).toBe(false);
  expect(RetailRequestSchema.safeParse({op:'policy_update',settings:DEFAULT_RULE_SETTINGS,shopId:null,expectedRevision:0,reason:'',actor:admin}).success).toBe(false);
  update(f,{...DEFAULT_RULE_SETTINGS,marginFloorBps:1800});
  expect(()=>update(f,DEFAULT_RULE_SETTINGS,null,0)).toThrow('版本已变化');
  expect(readBusinessPolicy(f.file).revision).toBe(1);
  const db=new Database(f.file+'.policy.sqlite');try{expect(()=>db.exec("UPDATE policy_history SET json='{}'")).toThrow('immutable');}finally{db.close();}
  expect(f.policies.view().history).toHaveLength(1);
 }finally{f.close();}
});

test('global and per-shop rules rebuild both page projections without changing source batches',()=>{
 const f=fixture();try{
  const original=f.data.snapshot();const anchor=original.records.find(r=>r.row.sku_id==='TEA-500')!;
  const second={...anchor.row,shop_id:'policy-other'};f.data.import(snapshotCsv(second),undefined,'demo');
  const before=f.data.page({source:'demo'});f.signals.page({source:'demo'});
  update(f,{...DEFAULT_RULE_SETTINGS,marginFloorBps:1000},anchor.row.shop_id);
  const page=f.data.page({source:'demo'});const own=page.records.find(r=>r.id===anchor.id)!;const other=page.records.find(r=>r.row.shop_id==='policy-other')!;
  expect(own.status).toBe('normal');expect(own.thresholdBps).toBe(1000);expect(other.thresholdBps).toBe(2000);
  expect(own.ruleVersion).toContain('@policy:1');expect(own.snapshotHash).toBe(anchor.snapshotHash);expect(page.batches).toEqual(before.batches);
  expect(f.signals.page({source:'demo'}).ruleVersion).toContain('@policy:1');
  update(f,{...DEFAULT_RULE_SETTINGS,marginMinUnits:100000,minInventorySales:100000,minAdsClicks:100000,inventoryWindowDays:14,adsWindowDays:14});
  const margin=f.data.page({source:'demo'}).records.find(r=>r.row.shop_id==='policy-other')!;expect(margin.status).toBe('needs_evidence');
  expect(f.data.page({source:'demo'}).records.find(r=>r.id===anchor.id)!.policy!.settings.marginMinUnits).toBe(0);
  update(f,{...DEFAULT_RULE_SETTINGS,marginMinUnits:100000,minInventorySales:100000,minAdsClicks:100000,inventoryWindowDays:14,adsWindowDays:14},anchor.row.shop_id);
  const all=f.signals.page({source:'demo'});expect(all.records.every(r=>r.status==='needs_evidence')).toBe(true);expect(all.pagination.summary.inventory.missing).toBe(3);expect(all.pagination.summary.ads.missing).toBe(3);
  for(const record of all.records){const names=['retail_get_data_health','retail_get_sku_context',record.kind==='inventory'?'retail_get_inventory':'retail_get_campaigns','retail_simulate_actions'];const trace=names.map(tool=>({at:new Date().toISOString(),stage:'investigate',tool,evidenceId:`${record.id}:${tool}`,data:readSignalTool(record,tool)}));expect(()=>record.kind==='inventory'?auditInventoryNumbers(record,simulateSignal(record),trace):auditAdsNumbers(record,simulateSignal(record),trace)).not.toThrow();}
 }finally{f.close();}
});

test('configured expiry is frozen; a later policy change invalidates approved authorization and preserves old report',async()=>{
 const f=fixture();let runs:InvestigationStore|undefined,decisions:DecisionStore|undefined;
 try{
  update(f,{...DEFAULT_RULE_SETTINGS,approvalMinutes:1});runs=new InvestigationStore(f.file+'.investigations.sqlite');decisions=new DecisionStore(f.file,'policy-test',()=>[...f.data.snapshot().records,...f.signals.snapshot().records]);
  const e=f.data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;const run=runs.create(e,'model').run;const report=await runInvestigation(run,model,async event=>{runs!.update(run.id,{event});});runs.update(run.id,{report});
  const saved=JSON.stringify(runs.get(run.id).report);const d=decisions.create(run.id,'reduce_coupon','规则测试');expect(d.policyRevision).toBe(1);expect(d.approvalMinutes).toBe(1);
  expect(Date.parse(d.expiresAt)-Date.parse(d.createdAt)).toBeGreaterThanOrEqual(59000);expect(Date.parse(d.expiresAt)-Date.parse(d.createdAt)).toBeLessThan(61000);
  const pending=decisions.submit(d.id,1);decisions.resolveApproval(pending.request!.id,1,pending.actionHash,'approve','仅本地模拟',approver);
  update(f,{...DEFAULT_RULE_SETTINGS,approvalMinutes:5,stockBufferDays:3});
  const view=decisions.approvals().find(a=>a.id===pending.request!.id)!;expect(view.status).toBe('invalidated');expect(view.blockers.join('；')).toContain('规则');
  expect(JSON.stringify(runs.get(run.id).report)).toBe(saved);
  expect(decisions.executions()[0]!.blockers.length).toBeGreaterThan(0);
 }finally{decisions?.close();runs?.close();f.close();}
});

test('read-only defaults create no policy file and decision upgrade backs up version seven',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-policy-upgrade-'));const file=join(dir,'data.sqlite');
 try{expect(readBusinessPolicy(file).revision).toBe(0);expect(existsSync(file+'.policy.sqlite')).toBe(false);
 const data=new RetailStore(file),signals=new SignalStore(file+'.signals.sqlite'),runs=new InvestigationStore(file+'.investigations.sqlite');
 const db=new Database(file+'.investigations.sqlite');db.exec('CREATE TABLE decision_schema(version INTEGER PRIMARY KEY) STRICT;INSERT INTO decision_schema VALUES(7)');db.close();
 const decisions=new DecisionStore(file,'upgrade',()=>[]);try{expect(readdirSync(dir).some(n=>n.includes('backup-v7-'))).toBe(true);}finally{decisions.close();runs.close();signals.close();data.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
