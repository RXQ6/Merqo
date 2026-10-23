import {beforeEach,afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {Database} from 'bun:sqlite';
import {RetailStore} from './store';import {SignalStore} from './signal-store';import {InvestigationStore} from './investigation-store';import {DecisionStore} from './decisions';
import {DEMO_CSV,RetailRequestSchema} from './operations';import {runInvestigation} from './investigations';
import {WorkbenchRequestSchema,type WorkbenchData} from './workbench-contract';import {WikiClient,type WikiTransport,publicWikiUrl} from './wiki-client';import type {WikiSource,WikiJob} from './wiki-contract';
import {backupInventory,captureBackup,restoreBackup} from './backup';
let dir:string,file:string,data:RetailStore,signals:SignalStore,runs:InvestigationStore,decisions:DecisionStore;
const wb=(r:unknown)=>decisions.workbench(WorkbenchRequestSchema.parse(r));
function view<T extends WorkbenchData['view']>(d:WorkbenchData,type:T){expect(d.view).toBe(type);return d as Extract<WorkbenchData,{view:T}>;}
const meta={category:'method' as const,status:'published' as const,directory:'毛利经营',shop:'',sku:'',validFrom:'',validTo:''};
function save(overrides:Record<string,unknown>={}){return view(wb({op:'wb_wiki_save',expectedVersion:0,title:'毛利排查方法',body:'# 先核来源\n\n- 核对成本\n- 核对退款',scenario:'margin',meta,...overrides}),'wiki_detail').item;}
const current=()=>[...data.snapshot().records,...signals.snapshot().records];
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'merqo-wiki-'));mkdirSync(join(dir,'retail'));file=join(dir,'retail/operations.sqlite');data=new RetailStore(file);data.import(DEMO_CSV,undefined,'demo');signals=new SignalStore(file+'.signals.sqlite');runs=new InvestigationStore(file+'.investigations.sqlite');decisions=new DecisionStore(file,'wiki-space',current);});
afterEach(()=>{decisions.close();runs.close();signals.close();data.close();if(!dir.startsWith(join(tmpdir(),'merqo-wiki-')))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});});
async function investigation(){const evidence=data.snapshot().records.find(e=>e.row.sku_id==='TEA-500')!;const r=runs.create(evidence,'replay',true).run;const report=await runInvestigation(r,null,async event=>{runs.update(r.id,{event});});runs.update(r.id,{report});return r;}
function source(){decisions.wikiInternal({action:'source_save',expectedVersion:0,config:{name:'测试文档源',provider:'markdown',endpoint:'https://docs.example.com/wiki.json',appId:'',spaceId:'',rootNode:'',scenario:'margin',intervalMinutes:60,enabled:true},credentialRef:null});return view(wb({op:'wb_wiki_sources'}),'wiki_sources').sources[0]!;}
test('W1 search, directories, drafts, trash, immutable history and optimistic conflicts',()=>{
 const item=save();expect(view(wb({op:'wb_wiki_list',search:'退款'}),'wiki_list').total).toBe(1);expect(view(wb({op:'wb_wiki_list',directory:'毛利经营'}),'wiki_list').directories).toContain('毛利经营');
 const edited=save({id:item.id,expectedVersion:1,body:'新方法',meta:{...meta,status:'draft'}});expect(edited.version).toBe(2);expect(edited.archived).toBe(true);expect(()=>save({id:item.id,expectedVersion:1})).toThrow('版本');
 expect(view(wb({op:'wb_wiki_get',id:item.id,version:1}),'wiki_detail').item.body).toBe(item.body);
 const restored=view(wb({op:'wb_wiki_revert',id:item.id,expectedVersion:2,version:1}),'wiki_detail');expect(restored.item.version).toBe(3);expect(restored.item.body).toBe(item.body);
 save({id:item.id,expectedVersion:3,meta:{...meta,status:'deleted'}});expect(view(wb({op:'wb_wiki_list'}),'wiki_list').total).toBe(0);expect(view(wb({op:'wb_wiki_list',status:'deleted'}),'wiki_list').total).toBe(1);
 expect(WorkbenchRequestSchema.safeParse({op:'wb_wiki_save',expectedVersion:0,title:'x',body:'x',scenario:'all',meta:{...meta,validFrom:'2026-12-01',validTo:'2026-01-01'}}).success).toBe(false);
});
test('W2 exact applicability, investigation citations freeze old versions and warn on retirement',async()=>{
 const run=await investigation(),item=save();save({title:'其他店铺',meta:{...meta,shop:'not-this-shop'}});save({title:'未发布',meta:{...meta,status:'draft'}});save({title:'过期',meta:{...meta,validTo:'2000-01-01'}});
 const related=view(wb({op:'wb_wiki_references',investigationId:run.id}),'wiki_references');expect(related.candidates.map(c=>c.item.id)).toEqual([item.id]);
 wb({op:'wb_wiki_reference',investigationId:run.id,itemId:item.id,expectedVersion:1});save({id:item.id,expectedVersion:1,body:'改变方法',meta:{...meta,status:'retired'}});
 const frozen=view(wb({op:'wb_wiki_references',investigationId:run.id}),'wiki_references');expect(frozen.references[0]!.item.body).toBe(item.body);expect(frozen.warnings).toHaveLength(1);expect(frozen.candidates).toHaveLength(0);
});
test('W2 method task creation and knowledge binding are atomic; completed task/case becomes draft',async()=>{
 const run=await investigation(),item=save();const request={op:'wb_wiki_task_create',itemId:item.id,expectedVersion:1,investigationId:run.id,title:'按方法复核',owner:'运营',dueAt:'2026-12-01T00:00:00Z'};
 const task=view(wb(request),'wiki_task').task;expect(task.description).toContain(item.body);expect(view(wb({op:'wb_bindings',taskId:task.id}),'bindings').items[0]!.item.version).toBe(1);
 expect(()=>wb({...request,expectedVersion:99})).toThrow('版本');expect(decisions.tasks({op:'tasks',status:'all',overdueOnly:false,search:'',offset:0,limit:30}).total).toBe(1);
 expect(()=>wb({op:'wb_wiki_from_task',taskId:task.id,expectedVersion:1})).toThrow('完成');decisions.mutateTask({op:'task_transition',id:task.id,expectedVersion:1,status:'done',note:'只读分析完成'});
 const draft=view(wb({op:'wb_wiki_from_task',taskId:task.id,expectedVersion:2}),'wiki_detail').item;expect(draft.wiki?.status).toBe('draft');expect(draft.body).toContain('不代表真实经营效果');
 const c=view(wb({op:'wb_archive',taskId:task.id,expectedTaskVersion:2,title:'复核案例',lesson:'先核成本',outcome:'结果待核'}),'case').item;
 const from=view(wb({op:'wb_wiki_from_case',id:c.id}),'wiki_detail');expect(from.item.wiki?.caseId).toBe(c.id);expect(view(wb({op:'wb_wiki_from_case',id:c.id}),'wiki_detail').item.id).toBe(from.item.id);
});
test('W2 assistant freezes relevant Wiki snapshots and accepts only corresponding citation IDs',async()=>{
 const run=await investigation(),item=save();const task=decisions.createTask({op:'task_create',origin:{kind:'investigation',id:run.id},purpose:'analysis_followup',title:'复核',owner:'运营',dueAt:'2026-12-01T00:00:00Z',priority:'normal',description:''}).detail.task;
 const id=randomUUID(),q=view(wb({op:'wb_ask',questionId:id,entityId:task.entityKey,period:{startDate:'2026-01-01',endDate:'2026-12-31'},question:'参考哪种排查方法',mode:'model'}),'conversations').selected!;expect(q.context.wiki?.[0]?.id).toBe(item.id);
 save({id:item.id,expectedVersion:1,body:'新内容'});const result=view(decisions.completeContext(id,q.context.hash,'请先核对成本来源',['wiki:'+item.id+':v1'],null),'conversations');expect(result.selected?.context.wiki?.[0]?.body).toBe(item.body);
});
test('W3 durable per-document checkpoint, no-op sync, deletion and source failure guards',async()=>{
 const s=source(),plan=[{key:'a',title:'规则甲',url:'https://docs.example.com/a.md',directory:'规则'},{key:'b',title:'规则乙',url:'https://docs.example.com/b.md',directory:'规则'}];
 let job=decisions.wikiInternal({action:'start',sourceId:s.id,plan}) as WikiJob;job=decisions.wikiInternal({action:'document',jobId:job.id,index:0,body:'# 甲'}) as WikiJob;expect(job.index).toBe(1);
 decisions.wikiInternal({action:'fail',jobId:job.id});decisions.close();decisions=new DecisionStore(file,'wiki-space',current);
 job=decisions.wikiInternal({action:'start',sourceId:s.id,plan:[]}) as WikiJob;expect(job.index).toBe(1);expect(job.plan).toHaveLength(2);decisions.wikiInternal({action:'document',jobId:job.id,index:1,body:'# 乙'});decisions.wikiInternal({action:'finish',jobId:job.id});
 expect(view(wb({op:'wb_wiki_list'}),'wiki_list').items).toHaveLength(2);
 job=decisions.wikiInternal({action:'start',sourceId:s.id,plan:[plan[0]]}) as WikiJob;decisions.wikiInternal({action:'document',jobId:job.id,index:0,body:'# 甲'});decisions.wikiInternal({action:'finish',jobId:job.id});
 const list=view(wb({op:'wb_wiki_list'}),'wiki_list');expect(list.items.find(i=>i.wiki?.external?.key==='a')?.version).toBe(1);expect(list.items.find(i=>i.wiki?.external?.key==='b')?.wiki?.external?.available).toBe(false);
 const run=await investigation();expect(view(wb({op:'wb_wiki_references',investigationId:run.id}),'wiki_references').candidates).toHaveLength(1);
 decisions.wikiInternal({action:'check',sourceId:s.id,ok:false});expect(view(wb({op:'wb_wiki_references',investigationId:run.id}),'wiki_references').candidates).toHaveLength(0);
 expect(()=>save({id:list.items.find(i=>i.wiki?.external?.key==='a')!.id,expectedVersion:1})).toThrow('只读');
});
test('W3 restart supersedes abandoned running jobs and permits later source edits',()=>{
 const s=source();const old=decisions.wikiInternal({action:'start',sourceId:s.id,plan:[]}) as WikiJob;const next=decisions.wikiInternal({action:'start',sourceId:s.id,plan:[],restart:true}) as WikiJob;
 expect((decisions.wikiInternal({action:'job',jobId:old.id}) as WikiJob).status).toBe('failed');decisions.wikiInternal({action:'finish',jobId:next.id});
 expect(()=>decisions.wikiInternal({action:'source_save',id:s.id,expectedVersion:1,config:{name:s.name,provider:s.provider,endpoint:s.endpoint,appId:'',spaceId:'',rootNode:'',scenario:s.scenario,intervalMinutes:0,enabled:false},credentialRef:null})).not.toThrow();
});
test('scope isolation and public request boundary prevent fabricated sync contents or secret reads',()=>{
 const item=save();source();const other=new DecisionStore(file,'other',current);try{expect(()=>other.workbench(WorkbenchRequestSchema.parse({op:'wb_wiki_get',id:item.id}))).toThrow('工作区');expect(view(other.workbench(WorkbenchRequestSchema.parse({op:'wb_wiki_sources'})),'wiki_sources').sources).toHaveLength(0);}finally{other.close();}
 expect(RetailRequestSchema.safeParse({op:'wiki_internal',payload:{action:'source'}}).success).toBe(false);expect(RetailRequestSchema.safeParse({op:'wb_wiki_save',expectedVersion:0,title:'x',body:'x',scenario:'all',meta:{...meta,external:{sourceId:randomUUID()}}}).success).toBe(false);
});
test('schema10 upgrade backs up, encrypted backup includes Wiki credentials and restores versions/sources',()=>{
 const item=save(),s=source(),ref=randomUUID();decisions.wikiInternal({action:'source_save',id:s.id,expectedVersion:1,config:{name:s.name,provider:s.provider,endpoint:s.endpoint,appId:'',spaceId:'',rootNode:'',scenario:s.scenario,intervalMinutes:0,enabled:true},credentialRef:ref});
 const inventory=backupInventory(join(dir,'retail'));expect(inventory.refs).toContain(ref);expect(()=>captureBackup(join(dir,'retail'),'wiki-space','Wiki',[],inventory.connectionHash)).toThrow('凭据');
 const payload=captureBackup(join(dir,'retail'),'wiki-space','Wiki',[{sourceId:ref,value:'fixture-token'}],inventory.connectionHash),target=join(dir,'restored');restoreBackup(payload,target);const restored=new DecisionStore(join(target,'retail/operations.sqlite'),'wiki-space',current);try{expect(view(restored.workbench(WorkbenchRequestSchema.parse({op:'wb_wiki_get',id:item.id})),'wiki_detail').item).toEqual(item);}finally{restored.close();}
 decisions.close();const db=new Database(file+'.investigations.sqlite');db.exec('DELETE FROM decision_schema;INSERT INTO decision_schema VALUES(10);PRAGMA user_version=10');db.close();decisions=new DecisionStore(file,'wiki-space',current);expect(readdirSync(join(dir,'retail')).some(f=>f.includes('.backup-v10-'))).toBe(true);
});
test('Markdown manifest pagination, same-origin fetch, bearer and content validation',async()=>{
 const s={...source(),credentialRef:null,state:'ready',lastError:null,lastSyncAt:null,nextSyncAt:null} as WikiSource;const calls:string[]=[];
 const transport:WikiTransport=async(url,options)=>{calls.push(url);expect(options?.headers?.Authorization).toBe('Bearer fixture');if(url.endsWith('wiki.json'))return JSON.stringify({version:1,documents:[{id:'a',title:'甲',url:'./a.md'}],next:'./page2.json'});if(url.endsWith('page2.json'))return JSON.stringify({version:1,documents:[]});return '# 文档内容';};
 const api=new WikiClient(s,'fixture',transport),result=await api.plan();expect(result.plan[0]!.url).toBe('https://docs.example.com/a.md');expect(await api.document(result.plan[0]!)).toContain('文档');expect(calls).toHaveLength(3);
 const bad=new WikiClient(s,null,async()=>JSON.stringify({version:1,documents:[{id:'a',title:'甲',url:'https://other.example/a.md'}]}));expect(bad.plan()).rejects.toThrow('同域');for(const url of ['http://localhost/x','file:///secret','https://user:pass@example.com/x','https://example.com/x?token=secret'])expect(()=>publicWikiUrl(url)).toThrow();
});
test('Feishu traversal/token/raw-content protocol handles nested docx, skips unsupported types and rejects permission failures',async()=>{
 const s={...source(),provider:'feishu',endpoint:'https://example.feishu.cn/wiki',appId:'cli_fixture',spaceId:'1234',rootNode:'',credentialRef:null,state:'ready',lastError:null,lastSyncAt:null,nextSyncAt:null} as WikiSource;
 let auth=0;const calls:string[]=[];const api=new WikiClient(s,'fixture-secret',async(url,options)=>{calls.push(url);if(url.includes('/auth/')){auth++;expect(JSON.parse(options!.body!).app_secret).toBe('fixture-secret');return JSON.stringify({code:0,tenant_access_token:'fixture-token'});}expect(options?.headers?.Authorization).toBe('Bearer fixture-token');if(url.includes('/raw_content'))return JSON.stringify({code:0,data:{content:'成本核对步骤'}});const items=url.includes('parent_node_token')?[{node_token:'child',obj_token:'doc-child',obj_type:'docx',title:'子文档',has_child:false}]:[{node_token:'parent',obj_token:'sheet',obj_type:'sheet',title:'目录',has_child:true}];return JSON.stringify({code:0,data:{items,has_more:false}});});
 const result=await api.plan();expect(result.skipped).toBe(1);expect(result.plan[0]!.directory).toBe('目录');expect(result.plan[0]!.url).toBe('https://example.feishu.cn/wiki/child');expect(await api.document(result.plan[0]!)).toBe('成本核对步骤');expect(auth).toBe(1);expect(calls).toHaveLength(4);
 const denied=new WikiClient(s,'secret',async()=>JSON.stringify({code:99991663}));expect(denied.plan()).rejects.toThrow('授权');
});
