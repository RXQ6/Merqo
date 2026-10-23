import {beforeEach,afterEach,expect,test,setSystemTime} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {Database} from 'bun:sqlite';
import {RetailStore} from './store';import {SignalStore} from './signal-store';import {InvestigationStore} from './investigation-store';import {DecisionStore} from './decisions';
import {DEMO_CSV,RetailRequestSchema} from './operations';import {runInvestigation} from './investigations';
import {WorkbenchRequestSchema,type WorkbenchData,type BusinessEvidence} from './workbench-contract';import {evidenceEntityId} from './business-identity';
import {backupInventory,captureBackup,restoreBackup} from './backup';import {exportInvestigation} from './investigation-export';
let dir:string,file:string,data:RetailStore,signals:SignalStore,runs:InvestigationStore,decisions:DecisionStore,extra:BusinessEvidence[];
const current=()=>[...data.snapshot().records,...signals.snapshot().records,...extra];
const wb=(r:unknown)=>decisions.workbench(WorkbenchRequestSchema.parse(r));
function as<T extends WorkbenchData['view']>(data:WorkbenchData,kind:T){expect(data.view).toBe(kind);return data as Extract<WorkbenchData,{view:T}>;}
beforeEach(()=>{setSystemTime(new Date('2026-10-23T03:00:00.000Z'));dir=mkdtempSync(join(tmpdir(),'merqo-experience-'));mkdirSync(join(dir,'retail'));file=join(dir,'retail/operations.sqlite');data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');signals=new SignalStore(file+'.signals.sqlite');signals.demo();runs=new InvestigationStore(file+'.investigations.sqlite');extra=[];decisions=new DecisionStore(file,'experience-space',current);});
afterEach(()=>{setSystemTime();decisions.close();runs.close();signals.close();data.close();if(!dir.startsWith(join(tmpdir(),'merqo-experience-')))throw Error('Unsafe fixture cleanup');rmSync(dir,{recursive:true,force:true});});
const morning={op:'wb_exp_morning',day:'2026-10-23',source:'demo',shop:'',refresh:true};
async function run(){const e=data.snapshot().records.find(e=>e.row.sku_id==='TEA-500')!;const r=runs.create(e,'replay',true).run;const report=await runInvestigation(r,null,async event=>{runs.update(r.id,{event});});runs.update(r.id,{report});return runs.get(r.id)!;}
async function task(){const r=await run();return decisions.createTask({op:'task_create',origin:{kind:'investigation',id:r.id},purpose:'analysis_followup',title:'晨会问题跟进',owner:'运营',dueAt:'2026-10-23T00:00:00Z',priority:'high',description:'冻结证据'}).detail.task;}
test('morning freezes revisions, uses Shanghai day and reports missing/future data honestly',()=>{
 const a=as(wb(morning),'morning');expect(a.snapshot.items.length).toBeGreaterThan(0);expect(a.snapshot.warnings.join()).toContain('早于');expect(as(wb(morning),'morning').snapshot.id).toBe(a.snapshot.id);
 expect(()=>wb({...morning,day:'2026-10-24'})).toThrow('未来');expect(()=>wb({...morning,day:'2026-10-22'})).toThrow('过去');
 const empty=as(wb({...morning,source:'csv'}),'morning');expect(empty.snapshot.items).toHaveLength(0);expect(empty.snapshot.warnings.join()).toContain('没有经营证据');
 setSystemTime(new Date('2026-10-23T16:01:00Z'));expect(()=>wb({...morning,day:'2026-10-24'})).not.toThrow();
 expect(as(wb({...morning,snapshotId:a.snapshot.id}),'morning').live).toBe(false);
});
test('snooze writes a new snapshot, preserves prior history and can be restored',()=>{
 const a=as(wb(morning),'morning'),key=a.snapshot.items[0]!.key;
 const b=as(wb({op:'wb_exp_snooze',snapshotId:a.snapshot.id,key,until:'2026-10-24T03:00:00Z',reason:'等待新数据'}),'morning');expect(b.snapshot.id).not.toBe(a.snapshot.id);expect(b.snapshot.items.find(i=>i.key===key)!.snooze?.reason).toBe('等待新数据');
 expect(as(wb({...morning,snapshotId:a.snapshot.id}),'morning').snapshot.items.find(i=>i.key===key)!.snooze).toBeUndefined();
 expect(()=>wb({op:'wb_exp_snooze',snapshotId:a.snapshot.id,key:'0'.repeat(64),until:null,reason:'伪造'})).toThrow('事项');
 const c=as(wb({op:'wb_exp_snooze',snapshotId:b.snapshot.id,key,until:null,reason:'恢复'}),'morning');expect(c.snapshot.items.find(i=>i.key===key)!.snooze).toBeUndefined();
});
test('morning links existing tasks and reflects task progress only after refresh',async()=>{
 const t=await task(),a=as(wb(morning),'morning');expect(a.snapshot.items.find(i=>i.taskId===t.id&&i.kind==='task')!.priority).toBe(90);
 decisions.mutateTask({op:'task_transition',id:t.id,expectedVersion:1,status:'done',note:'完成核对'});
 expect(as(wb({...morning,refresh:false}),'morning').snapshot.id).toBe(a.snapshot.id);
 const b=as(wb(morning),'morning');expect(b.snapshot.items.find(i=>i.kind==='task')!.state).toBe('done');expect(as(wb({...morning,snapshotId:a.snapshot.id}),'morning').snapshot.items.find(i=>i.kind==='task')!.state).not.toBe('done');
 setSystemTime(new Date('2026-10-24T03:00:00Z'));const next=as(wb({...morning,day:'2026-10-24'}),'morning');expect(next.snapshot.progress.some(p=>p.taskId===t.id)).toBe(true);
});
test('product notes and timelines are scoped, idempotent and survive restart',async()=>{
 const t=await task(),requestId=randomUUID(),n={op:'wb_exp_note',entityId:t.entityKey,requestId,body:'包装已向供应商确认，人工记录'};wb(n);wb(n);expect(()=>wb({...n,body:'改写'})).toThrow('标识');
 decisions.close();decisions=new DecisionStore(file,'experience-space',current);
 const p=as(wb({op:'wb_exp_product',entityId:t.entityKey,start:'2026-10-01',end:'2026-10-31'}),'product');expect(p.notes).toHaveLength(1);expect(p.events.some(e=>e.type==='note')).toBe(true);expect(p.events.some(e=>e.type==='task')).toBe(true);expect(p.detail.evidence.every(e=>evidenceEntityId(e)===t.entityKey)).toBe(true);
 expect(()=>wb({op:'wb_exp_product',entityId:t.entityKey,start:'2026-10-31',end:'2026-10-01'})).toThrow();
});
test('case recommendations explain differences; references freeze into new task and exports',async()=>{
 const t=await task();decisions.mutateTask({op:'task_transition',id:t.id,expectedVersion:1,status:'done',note:'完成人工分析'});const c=as(wb({op:'wb_archive',taskId:t.id,expectedTaskVersion:2,title:'缺证核对案例',lesson:'先检查成本来源，再判断毛利',outcome:'人工声明已完成核对，未验证经营效果'}),'case').item;
 const r=await run(),entityId=evidenceEntityId(r.evidence),matches=as(wb({op:'wb_exp_cases',entityId,investigationId:r.id}),'similar_cases');expect(matches.items[0]!.reasons).toContain('相同商品标识');expect(matches.items[0]!.differences.join()).toContain('人工声明');
 wb({op:'wb_exp_reference',investigationId:r.id,caseId:c.id});wb({op:'wb_exp_reference',investigationId:r.id,caseId:c.id});expect(decisions.caseReferences(r.id)).toHaveLength(1);
 const next=decisions.createTask({op:'task_create',origin:{kind:'investigation',id:r.id},purpose:'analysis_followup',title:'借鉴案例',owner:'运营',dueAt:'2026-10-25T00:00:00Z',priority:'normal',description:'重新核对适用条件'}).detail.task;
 expect(next.caseReferences?.[0]!.item.lesson).toBe(c.lesson);
 const json=JSON.parse(exportInvestigation(r,'json',[],[],[],[],[],[],decisions.caseReferences(r.id)).content);expect(json.caseReferences[0].item.id).toBe(c.id);expect(exportInvestigation(r,'md',[],[],[],[],[],[],decisions.caseReferences(r.id)).content).toContain('冻结经营案例引用');
 wb({op:'wb_exp_feedback',entityId,caseId:c.id,helpful:false,reason:'当前来源不同，暂不能复用'});expect(as(wb({op:'wb_exp_cases',entityId}),'similar_cases').items[0]!.feedback?.helpful).toBe(false);
});
test('no matching cases stay empty; changed shops/specs remain independent',()=>{
 const e=current()[0]!,id=evidenceEntityId(e);expect(as(wb({op:'wb_exp_cases',entityId:id}),'similar_cases').items).toHaveLength(0);
 extra=[{...structuredClone(e),id:'other-shop',row:{...e.row,shop_id:'另一店'}} as BusinessEvidence];const other=evidenceEntityId(extra[0]!);wb({op:'wb_exp_note',entityId:id,requestId:randomUUID(),body:'原店备注'});expect(as(wb({op:'wb_exp_product',entityId:other,start:'2026-10-01',end:'2026-10-31'}),'product').notes).toHaveLength(0);
 const foreign=new DecisionStore(file,'other-workspace',current);try{expect(as(foreign.workbench(WorkbenchRequestSchema.parse({op:'wb_exp_product',entityId:id,start:'2026-10-01',end:'2026-10-31'})),'product').notes).toHaveLength(0);}finally{foreign.close();}
 expect(RetailRequestSchema.safeParse({...morning,workspaceId:'forged'}).success).toBe(false);
});
test('schema11 upgrades with backup; business backup includes new records',()=>{
 decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema WHERE version=13; INSERT OR IGNORE INTO decision_schema VALUES(11); PRAGMA user_version=11');db.close();decisions=new DecisionStore(file,'experience-space',current);expect(readdirSync(join(dir,'retail')).some(n=>n.includes('backup-v11'))).toBe(true);
 as(wb(morning),'morning');const inventory=backupInventory(join(dir,'retail'));const p=captureBackup(join(dir,'retail'),'experience-space','测试',[],inventory.connectionHash);const target=join(dir,'restored');restoreBackup(p,target);const restoredFile=new Database(join(target,'retail/operations.sqlite.investigations.sqlite'),{readonly:true});try{expect(restoredFile.query('SELECT count(*) n FROM wb_experience').get()).toEqual({n:1});}finally{restoredFile.close();}
});
