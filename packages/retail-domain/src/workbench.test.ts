import {beforeEach,afterEach,expect,test,setSystemTime} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {Database} from 'bun:sqlite';
import {RetailStore} from './store';import {SignalStore} from './signal-store';import {InvestigationStore} from './investigation-store';import {DecisionStore} from './decisions';
import {DEMO_CSV,RetailRequestSchema} from './operations';import {runInvestigation} from './investigations';import {ScheduledChecks} from './scheduled-checks';
import {WorkbenchRequestSchema,type WorkbenchData,type BusinessEvidence} from './workbench-contract';import {evidenceEntityId} from './business-identity';
import {backupInventory,captureBackup,restoreBackup} from './backup';
let dir:string,file:string,data:RetailStore,signals:SignalStore,runs:InvestigationStore,decisions:DecisionStore,extra:BusinessEvidence[];
const current=()=>[...data.snapshot().records,...signals.snapshot().records,...extra];
const wb=(r:unknown)=>decisions.workbench(WorkbenchRequestSchema.parse(r));
function as<T extends WorkbenchData['view']>(data:WorkbenchData,kind:T){expect(data.view).toBe(kind);return data as Extract<WorkbenchData,{view:T}>;}
beforeEach(()=>{setSystemTime(new Date('2026-10-22T03:00:00.000Z'));dir=mkdtempSync(join(tmpdir(),'merqo-workbench-'));mkdirSync(join(dir,'retail'));file=join(dir,'retail/operations.sqlite');data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');signals=new SignalStore(file+'.signals.sqlite');signals.demo();runs=new InvestigationStore(file+'.investigations.sqlite');extra=[];decisions=new DecisionStore(file,'workbench-space',current);});
afterEach(()=>{setSystemTime();decisions.close();runs.close();signals.close();data.close();if(!dir.startsWith(join(tmpdir(),'merqo-workbench-')))throw Error('Unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true});});
async function task(){const e=data.snapshot().records.find(e=>e.row.sku_id==='TEA-500')!;const run=runs.create(e,'replay',true).run;const report=await runInvestigation(run,null,async event=>{runs.update(run.id,{event});});runs.update(run.id,{report});return decisions.createTask({op:'task_create',origin:{kind:'investigation',id:run.id},purpose:'analysis_followup',title:'核对商品证据',owner:'运营',dueAt:'2026-10-21T00:00:00.000Z',priority:'normal',description:'冻结上下文'}).detail.task;}
const period={startDate:'2026-10-01',endDate:'2026-10-31'};

test('entity aggregation preserves exact declared scope, all history and paginated full counts',async()=>{
 const t=await task(),id=t.entityKey;const d=decisions.create(t.origin.investigationId,'observe','');
 const page=as(wb({op:'wb_entities',search:'TEA-500',limit:1}),'entities');expect(page.total).toBeGreaterThanOrEqual(1);expect(page.items).toHaveLength(1);
 const detail=as(wb({op:'wb_entity',entityId:id,period}),'entity').detail;expect(detail.investigationTotal).toBe(1);expect(detail.taskTotal).toBe(1);expect(detail.decisions[0]!.id).toBe(d.id);expect(detail.tasks[0]!.id).toBe(t.id);
 expect(detail.evidence.some(e=>e.row.sku_id!=='TEA-500')).toBe(false);expect(detail.hash).toHaveLength(64);
 const empty=as(wb({op:'wb_entity',entityId:id,period:{startDate:'2026-10-01',endDate:'2026-10-02'}}),'entity').detail;expect(empty.evidenceTotal).toBe(0);expect(empty.taskTotal).toBe(0);
});
test('unknown sources, different shops/specs and warehouse/campaign boundaries never silently merge',()=>{
 const base=data.snapshot().records[0]!;const a={...structuredClone(base),source:'csv' as const,snapshotHash:'a'.repeat(64)};delete a.provenance;const b={...structuredClone(a),snapshotHash:'b'.repeat(64)};extra=[a,b];
 expect(evidenceEntityId(a)).not.toBe(evidenceEntityId(b));
 expect(evidenceEntityId({...base,row:{...base.row,shop_id:'another'}})).not.toBe(evidenceEntityId(base));
 expect(evidenceEntityId({...base,row:{...base.row,spec:'different'}})).not.toBe(evidenceEntityId(base));
 const page=as(wb({op:'wb_entities',source:'csv'}),'entities');expect(page.total).toBe(2);expect(page.items.every(e=>e.unknownSource)).toBe(true);
});
test('context questions freeze evidence and same-window history, retry idempotently and retain failure truth',async()=>{
 const t=await task(),id=randomUUID(),input={op:'wb_ask',entityId:t.entityKey,period,questionId:id,question:'下一步核对什么？',mode:'model'};
 const created=as(wb(input),'conversations');expect(created.created).toBe(true);const q=created.selected!;expect(q.status).toBe('pending');
 expect(as(wb(input),'conversations').created).toBe(false);expect(()=>wb({...input,question:'偷偷换问题'})).toThrow('标识');
 extra=[{...structuredClone(q.context.evidence[0]!),id:'new-evidence',row:{...q.context.evidence[0]!.row,date:'2026-10-15'}} as BusinessEvidence];
 expect(()=>decisions.completeContext(id,q.context.hash,'请核对来源。',['foreign'],null)).toThrow('引用');
 expect(()=>decisions.completeContext(id,q.context.hash,'毛利提高50%。',[q.context.evidence[0]!.id],null)).toThrow('定性');
 const answer=as(decisions.completeContext(id,q.context.hash,'请核对成本来源和观察窗口，暂不能判断原因。',[q.context.evidence[0]!.id],null),'conversations').selected!;
 expect(answer.context.hash).toBe(q.context.hash);expect(answer.context.evidence.some(e=>e.id==='new-evidence')).toBe(false);expect(answer.status).toBe('answered');
 const next=as(wb({...input,questionId:randomUUID(),question:'还有哪些缺失？',mode:'replay'}),'conversations').selected!;expect(next.history).toHaveLength(1);expect(next.answer).toContain('没有调用模型');
 const other=as(wb({...input,questionId:randomUUID(),period:{startDate:'2026-10-14',endDate:'2026-10-14'},mode:'replay'}),'conversations').selected!;expect(other.history).toHaveLength(0);
});
test('expired context requests release their pending budget and reject late model results',async()=>{
 const t=await task(),r={op:'wb_ask',entityId:t.entityKey,period,question:'核对口径',mode:'model'};
 const first=as(wb({...r,questionId:randomUUID()}),'conversations').selected!;as(wb({...r,questionId:randomUUID()}),'conversations');
 expect(()=>wb({...r,questionId:randomUUID()})).toThrow('待完成');setSystemTime(new Date(Date.now()+121000));
 expect(as(wb({...r,questionId:randomUUID()}),'conversations').created).toBe(true);
 expect(as(decisions.completeContext(first.id,first.context.hash,'迟到说明',[first.context.evidence[0]!.id],null),'conversations').selected!.status).toBe('failed');
});
test('knowledge revisions freeze per-task bindings, enforce scenario and never rewrite archived versions',async()=>{
 const t=await task(),create={op:'wb_library_save',expectedVersion:0,kind:'method',title:'先核成本',scenario:'margin',body:'先核来源，再比较同窗方案',archived:false};
 const item=as(wb(create),'library').items[0]!;wb({op:'wb_bind',taskId:t.id,expectedTaskVersion:1,itemId:item.id});wb({...create,id:item.id,expectedVersion:1,body:'修订方法'});
 const tools=as(wb({op:'wb_task_tools',taskId:t.id}),'task_tools');expect(tools.bindings[0]!.item.version).toBe(1);expect(tools.bindings[0]!.item.body).toBe(create.body);
 expect(()=>wb({...create,id:item.id,expectedVersion:1})).toThrow('版本');expect(as(wb({op:'wb_library_links',itemId:item.id}),'library_links').items[0]!.id).toBe(t.id);
 const wrong=as(wb({...create,title:'库存方法',scenario:'inventory'}),'library').items.find(i=>i.title==='库存方法')!;expect(()=>wb({op:'wb_bind',taskId:t.id,expectedTaskVersion:1,itemId:wrong.id})).toThrow('场景');
});
test('deadline reminders deduplicate by task deadline across notes/restart and acknowledgements do not complete tasks',async()=>{
 const t=await task();let view=as(wb({op:'wb_tick'}),'followups');expect(view.unread).toBe(1);const id=view.reminders[0]!.id;
 decisions.mutateTask({op:'task_note',id:t.id,expectedVersion:1,note:'追加说明'});expect(as(wb({op:'wb_tick'}),'followups').reminders).toHaveLength(1);
 decisions.close();decisions=new DecisionStore(file,'workbench-space',current);expect(as(wb({op:'wb_tick'}),'followups').reminders[0]!.id).toBe(id);
 view=as(wb({op:'wb_ack',id,note:'已查看'}),'followups');expect(view.unread).toBe(0);expect(decisions.task(t.id).task.status).toBe('open');
});
test('review plans retain missing evidence, coalesce downtime, capture exact new scope and fence stale updates',async()=>{
 const t=await task();wb({op:'wb_plan',taskId:t.id,expectedTaskVersion:1,expectedVersion:0,dueAt:'2026-10-20T00:00:00Z',repeatDays:1,enabled:true});
 let v=as(wb({op:'wb_tick'}),'followups');expect(v.observations).toHaveLength(1);expect(v.observations[0]!.status).toBe('needs_evidence');expect(v.observations[0]!.skippedSlots).toBe(2);expect(Date.parse(v.plans[0]!.dueAt)).toBeGreaterThan(Date.now());
 expect(as(wb({op:'wb_tick'}),'followups').observations).toHaveLength(1);expect(()=>wb({op:'wb_plan',taskId:t.id,expectedTaskVersion:1,expectedVersion:1,dueAt:new Date().toISOString(),repeatDays:0,enabled:true})).toThrow('版本');
 const baseline=v.observations[0]!.baseline;extra=[{...structuredClone(baseline),snapshotHash:'c'.repeat(64),hash:'c'.repeat(64),id:'new-same-scope',row:{...baseline.row,date:'2026-10-15'}} as BusinessEvidence,{...structuredClone(baseline),id:'wrong-shop',row:{...baseline.row,shop_id:'wrong'}} as BusinessEvidence];
 setSystemTime(new Date(Date.parse(v.plans[0]!.dueAt)+1000));v=as(wb({op:'wb_tick'}),'followups');expect(v.observations[0]!.status).toBe('observed');expect(v.observations[0]!.evidence.map(e=>e.id)).toEqual(['new-same-scope']);
});
test('case archive requires completed task, is idempotent per version and freezes knowledge/observation/history',async()=>{
 const t=await task(),r={op:'wb_archive',taskId:t.id,expectedTaskVersion:1,title:'毛利核验案例',lesson:'核对原始成本',outcome:'人工声明：分析结束，未验证真实效果'};
 expect(()=>wb(r)).toThrow('完成');wb({op:'wb_plan',taskId:t.id,expectedTaskVersion:1,expectedVersion:0,dueAt:'2026-10-20T00:00:00Z',repeatDays:0,enabled:true});wb({op:'wb_tick'});
 decisions.mutateTask({op:'task_transition',id:t.id,expectedVersion:1,status:'done',note:'完成分析'});const c=as(wb({...r,expectedTaskVersion:2}),'case').item;
 expect(c.category).toBe('analysis');expect(c.observations).toHaveLength(1);expect(c.task.eventCount).toBe(2);
 expect(as(wb({op:'wb_entity',entityId:t.entityKey,period}),'entity').detail.cases[0]!.id).toBe(c.id);
 expect(as(wb({op:'wb_entity',entityId:t.entityKey,period:{startDate:'2026-10-01',endDate:'2026-10-02'}}),'entity').detail.cases).toHaveLength(0);
 expect(as(wb({...r,expectedTaskVersion:2,lesson:'不得覆盖'}),'case').item.id).toBe(c.id);
 decisions.mutateTask({op:'task_transition',id:t.id,expectedVersion:2,status:'open',note:'复核'});expect(as(wb({op:'wb_case',id:c.id}),'case').item.task.task.status).toBe('done');
 expect(as(wb({op:'wb_cases',search:'TEA-500'}),'cases').total).toBe(1);
});
test('public contracts reject fabricated model completions/authority and other workspace cannot read task knowledge or cases',async()=>{
 for(const op of ['context_completion_internal','wb_complete'])expect(RetailRequestSchema.safeParse({op,id:randomUUID(),answer:'fake'}).success).toBe(false);
 expect(RetailRequestSchema.safeParse({op:'wb_tick',workspaceId:'forged'}).success).toBe(false);
 const t=await task();const other=new DecisionStore(file,'other-workspace',current);try{expect(()=>other.workbench({op:'wb_task_tools',taskId:t.id})).toThrow('工作空间');expect(as(other.workbench({op:'wb_library'}),'library').items).toHaveLength(0);}finally{other.close();}
});
test('finding leases and task creation commit once, reject changed config and retain source events',async()=>{
 const t=await task(),config=as(wb({op:'wb_followups'}),'followups').config;wb({op:'wb_configure',expectedVersion:config.version,remindersEnabled:true,autoFindingTasks:true,owner:'巡检运营',dueHours:24});
 const c=decisions.findingConfig(),key='test-finding',token=decisions.claimFinding(key)!;expect(decisions.claimFinding(key)).toBeNull();
 const input={op:'task_create' as const,origin:{kind:'investigation' as const,id:t.origin.investigationId},purpose:'analysis_followup' as const,title:t.title,owner:t.owner,dueAt:t.dueAt,priority:t.priority,description:t.description};
 const linked=decisions.createFindingTask(key,token,input,c.version);expect(linked.detail.task.id).toBe(t.id);expect(decisions.doneFindingKeys().has(key)).toBe(true);expect(decisions.claimFinding(key)).toBeNull();
 const token2=decisions.claimFinding('another')!;wb({op:'wb_configure',expectedVersion:c.version,remindersEnabled:false,autoFindingTasks:false,owner:'停用',dueHours:24});expect(()=>decisions.createFindingTask('another',token2,input,c.version)).toThrow('配置');
 const checks=new ScheduledChecks(file+'.checks.sqlite','workbench-space',()=>current());try{checks.run('manual');expect([...checks.findingsSince('2026-10-22T00:00:00Z')].length).toBeGreaterThan(0);expect([...checks.findingsSince('2026-10-23T00:00:00Z')]).toHaveLength(0);}finally{checks.close();}
});
test('schema 9 migration backs up before schema10; backup/restore retains conversations, plans, cases and library',async()=>{
 const t=await task(),entityId=t.entityKey;wb({op:'wb_ask',entityId,period,questionId:randomUUID(),question:'核对来源',mode:'replay'});wb({op:'wb_library_save',expectedVersion:0,kind:'topic',title:'门店复查',scenario:'all',body:'核对业务证据',archived:false});wb({op:'wb_plan',taskId:t.id,expectedTaskVersion:1,expectedVersion:0,dueAt:'2026-10-23T00:00:00Z',repeatDays:0,enabled:true});
 decisions.mutateTask({op:'task_transition',id:t.id,expectedVersion:1,status:'done',note:'分析完成'});const c=as(wb({op:'wb_archive',taskId:t.id,expectedTaskVersion:2,title:'冻结案例',lesson:'只读复核',outcome:'无真实效果证明'}),'case').item;
 decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(9);PRAGMA user_version=9');db.close();decisions=new DecisionStore(file,'workbench-space',current);expect(readdirSync(join(dir,'retail')).some(n=>n.includes('.backup-v9-'))).toBe(true);
 const inventory=backupInventory(join(dir,'retail')),payload=captureBackup(join(dir,'retail'),'workbench-space','测试',[],inventory.connectionHash),target=join(dir,'restored');restoreBackup(payload,target);const restored=new DecisionStore(join(target,'retail/operations.sqlite'),'workbench-space',current);try{expect(as(restored.workbench({op:'wb_case',id:c.id}),'case').item).toEqual(c);expect(as(restored.workbench({op:'wb_conversations',entityId}),'conversations').items).toHaveLength(1);expect(as(restored.workbench({op:'wb_library'}),'library').items).toHaveLength(1);expect(as(restored.workbench({op:'wb_followups'}),'followups').plans).toHaveLength(1);}finally{restored.close();}
});

test('actual schema9 layout without any workbench tables upgrades while preserving the existing task and backup',async()=>{
 const original=await task();decisions.close();const old=new Database(file+'.investigations.sqlite');
 for(const row of old.query<{name:string},[]>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wb_%'").all()){
   if(!/^wb_[a-z_]+$/.test(row.name))throw Error('Unexpected fixture table');old.exec(`DROP TABLE ${row.name}`);
 }
 old.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(9);PRAGMA user_version=9');old.close();
 decisions=new DecisionStore(file,'workbench-space',current);expect(decisions.task(original.id).task).toEqual(original);
 expect(as(wb({op:'wb_followups'}),'followups').config.version).toBe(1);
 expect(as(wb({op:'wb_entity',entityId:original.entityKey,period}),'entity').detail.tasks[0]!.id).toBe(original.id);
 const backupName=readdirSync(join(dir,'retail')).find(n=>n.includes('.backup-v9-'))!;expect(backupName).toBeDefined();
 const backup=new Database(join(dir,'retail',backupName),{readonly:true});try{expect(backup.query('PRAGMA user_version').get()).toEqual({user_version:9});expect(backup.query("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'wb_%'").get()).toEqual({n:0});expect(backup.query('SELECT count(*) n FROM business_tasks').get()).toEqual({n:1});}finally{backup.close();}
});
