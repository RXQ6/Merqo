import { WikiLedger } from './wiki';
import {ExperienceLedger,installExperienceSchema} from './experience';
import type {ExperienceRequest} from './experience-contract';
import { WikiRequestSchema } from './wiki-contract';
import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { businessDigest, businessScope, evidenceEntityId, evidenceHash } from './business-identity';
import { evidenceTimeContext } from './evidence-policy';
import type { BusinessTask, TaskDetail } from './business-task-contract';
import type { AnyInvestigation } from './investigations';
import type { DecisionDraft } from './decisions';
import type { BusinessEvidence, EntitySummary, EntityDetail, ContextQuestion, LibraryItem, TaskBinding, FollowupConfig, FollowupPlan, Reminder, FollowupObservation, BusinessCase, WorkbenchRequest, WorkbenchData } from './workbench-contract';
type Row = { json: string };
const parse = <T>(r: Row) => JSON.parse(r.json) as T;
const limitation = '证据按来源、店铺、渠道、商品规格及仓库/活动分开；不跨快照求和，不证明实时完整性、因果、真实执行或完整利润。';
export function installWorkbenchSchema(db: Database) {
  installExperienceSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_library(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE TABLE IF NOT EXISTS wb_library_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(id,version)) STRICT;
  CREATE INDEX IF NOT EXISTS wb_library_scope ON wb_library(workspace_id);
  CREATE TABLE IF NOT EXISTS wb_bindings(task_id TEXT NOT NULL,item_id TEXT NOT NULL,item_version INTEGER NOT NULL,workspace_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(task_id,item_id,item_version)) STRICT;
  CREATE TABLE IF NOT EXISTS wb_config(workspace_id TEXT PRIMARY KEY,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE TABLE IF NOT EXISTS wb_plans(task_id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,version INTEGER NOT NULL,due_at TEXT NOT NULL,enabled INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE INDEX IF NOT EXISTS wb_plans_due ON wb_plans(workspace_id,enabled,due_at);
  CREATE TABLE IF NOT EXISTS wb_plan_events(task_id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(task_id,version)) STRICT;
  CREATE TABLE IF NOT EXISTS wb_reminders(key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,task_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE INDEX IF NOT EXISTS wb_reminders_scope ON wb_reminders(workspace_id,task_id);
  CREATE TABLE IF NOT EXISTS wb_observations(key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,plan_id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE INDEX IF NOT EXISTS wb_observations_scope ON wb_observations(workspace_id,plan_id);
  CREATE TABLE IF NOT EXISTS wb_cases(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,task_id TEXT NOT NULL,task_version INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),UNIQUE(workspace_id,task_id,task_version)) STRICT;
  CREATE INDEX IF NOT EXISTS wb_cases_scope ON wb_cases(workspace_id);
  CREATE TABLE IF NOT EXISTS wb_questions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,entity_id TEXT NOT NULL,status TEXT NOT NULL,deadline_at TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE INDEX IF NOT EXISTS wb_questions_entity ON wb_questions(workspace_id,entity_id);
  CREATE TABLE IF NOT EXISTS wb_finding_links(key TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,state TEXT NOT NULL,lease_at TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json))) STRICT;
  CREATE INDEX IF NOT EXISTS wb_finding_scope ON wb_finding_links(workspace_id,state);`);
}
/** Shares DecisionStore's transaction/physical workspace. No external tools or business execution. */
export class WorkbenchLedger {
  constructor(private db: Database, private workspaceId: string, private current: () => BusinessEvidence[], private task: (id: string) => TaskDetail) {}
  private now() { return new Date().toISOString(); }
  private runs() { return this.db.query<Row, []>('SELECT json FROM investigations ORDER BY updated_at DESC,id DESC').iterate(); }
  private drafts() { return this.db.query<Row, [string]>("SELECT json FROM decisions WHERE json_extract(json,'$.workspaceId')=? ORDER BY json_extract(json,'$.updatedAt') DESC,id DESC").iterate(this.workspaceId); }
  private tasks() { return this.db.query<Row, [string]>('SELECT json FROM business_tasks WHERE workspace_id=? ORDER BY updated_at DESC,id DESC').iterate(this.workspaceId); }
  private index() {
    const entities = new Map<string, EntitySummary>(), records = new Map<string, BusinessEvidence>();
    const add = (e: BusinessEvidence) => {
      const id = evidenceEntityId(e), unique = businessDigest([id, e.id, evidenceHash(e),e.ruleVersion]);
      if (records.has(unique)) return id;
      records.set(unique, e);
      let entity = entities.get(id);
      if (!entity) { entity = { id, scope: businessScope(e), name: 'product_name' in e.row ? e.row.product_name : e.row.sku_id, dates: { first: e.row.date, last: e.row.date }, records: 0, investigations: 0, decisions: 0, tasks: 0, unknownSource: !e.provenance?.sourceId }; entities.set(id, entity); }
      entity.records++; entity.dates.first = [entity.dates.first, e.row.date].sort()[0]!; entity.dates.last = [entity.dates.last, e.row.date].sort()[1]!;
      return id;
    };
    for (const e of this.current()) add(e);
    const runEntity = new Map<string, string>();
    for (const row of this.runs()) { const run = parse<AnyInvestigation>(row); const id = add(run.evidence); runEntity.set(run.id, id); entities.get(id)!.investigations++; }
    for (const row of this.drafts()) { const d = parse<DecisionDraft>(row), entity = entities.get(runEntity.get(d.investigationId) ?? ''); if (entity) entity.decisions++; }
    for (const row of this.tasks()) { const t = parse<BusinessTask>(row), entity = entities.get(t.entityKey); if (entity) entity.tasks++; }
    return { entities, records };
  }
  entity(id: string, period: EntityDetail['period']): EntityDetail {
    const index = this.index(), entity = index.entities.get(id); if (!entity) throw Error('业务实体不存在，请刷新实体列表');
    const inRange = (date: string) => date >= period.startDate && date <= period.endDate;
    const records = [...index.records.values()].filter(e => evidenceEntityId(e) === id && inRange(e.row.date)).sort((a,b) => b.row.date.localeCompare(a.row.date) || a.id.localeCompare(b.id));
    const runs = [...this.runs()].map(parse<AnyInvestigation>).filter(r => evidenceEntityId(r.evidence) === id && inRange(r.evidence.row.date));
    const runIds = new Set(runs.map(r => r.id));
    const drafts = [...this.drafts()].map(parse<DecisionDraft>).filter(d => runIds.has(d.investigationId));
    const tasks = [...this.tasks()].map(parse<BusinessTask>).filter(t => t.entityKey === id && inRange(t.scope.date));
    const knowledge:TaskBinding[]=[];
    for(const task of tasks.slice(0,30)){knowledge.push(...this.bindings(task.id));if(knowledge.length>=20)break;}
    const cases=this.db.query<Row,[string,string,string,string]>("SELECT json FROM wb_cases WHERE workspace_id=? AND json_extract(json,'$.task.task.entityKey')=? AND json_extract(json,'$.task.task.scope.date')>=? AND json_extract(json,'$.task.task.scope.date')<=? ORDER BY json_extract(json,'$.createdAt') DESC,id DESC LIMIT 10").all(this.workspaceId,id,period.startDate,period.endDate).map(parse<BusinessCase>);
    const warnings = [limitation];
    if (entity.unknownSource) warnings.push('来源身份未声明，此实体仅按原证据摘要隔离；新导入数据不能推定为同一来源。');
    if (!records.length) warnings.push('所选窗口无证据。');
    if (records.length > 30 || runs.length > 30 || drafts.length > 30 || tasks.length > 30) warnings.push('详情每类最多展示30项；计数为窗口完整范围，截断内容不进入助手。');
    if (records.some(e => e.source === 'csv' && evidenceTimeContext(e).businessTimeIssueAtImport)) warnings.push('存在导入时业务日期异常的历史证据，须核对时间口径。');
    const wikiLedger=new WikiLedger(this.db,this.workspaceId,this.task);
    let wikiBytes=0;
    const wiki=wikiLedger.eligible(entity.scope).filter(i=>!i.wiki?.validFrom||i.wiki.validFrom<=period.startDate).filter(i=>!i.wiki?.validTo||i.wiki.validTo>=period.endDate).filter(i=>{const bytes=Buffer.byteLength(JSON.stringify(i),'utf8');if(wikiBytes+bytes>50000)return false;wikiBytes+=bytes;return true;}).slice(0,10);
    const detail = { entity, period, wiki, evidence: records.slice(0,30), evidenceTotal: records.length,
      investigations: runs.slice(0,30).map(r => ({ id:r.id, state:r.state, mode:r.mode, createdAt:r.createdAt, summary:r.report?.summary ?? '尚无报告' })), investigationTotal:runs.length,
      decisions: drafts.slice(0,30).map(d => ({ id:d.id, version:d.version, state:d.state, selectedKind:d.selectedKind })), decisionTotal:drafts.length,
      tasks:tasks.slice(0,30), taskTotal:tasks.length, knowledge:knowledge.slice(0,20),cases:cases.map(c=>({id:c.id,title:c.title,lesson:c.lesson,declaredOutcome:c.declaredOutcome,category:c.category,limitation:c.limitation})), warnings:[...warnings,'上下文最多引用20个已绑定知识版本和10个同范围历史案例；过往经验不证明本次有效，不能作为执行授权。'] };
    return { ...detail, hash: businessDigest(detail) };
  }
  private config(): FollowupConfig {
    this.db.query('INSERT OR IGNORE INTO wb_config VALUES(?,?)').run(this.workspaceId, JSON.stringify({ version:1, remindersEnabled:true, autoFindingTasks:false, owner:'经营跟进人', dueHours:24, configuredAt:this.now() } satisfies FollowupConfig));
    return parse<FollowupConfig>(this.db.query<Row,[string]>('SELECT json FROM wb_config WHERE workspace_id=?').get(this.workspaceId)!);
  }
  private questions(entityId: string): ContextQuestion[] {
    const expired = this.db.query<Row,[string,string]>("SELECT json FROM wb_questions WHERE workspace_id=? AND status='pending' AND deadline_at<=?").all(this.workspaceId,this.now());
    for (const row of expired) { const q=parse<ContextQuestion>(row); q.status='failed';q.error='回答超时或应用退出，请重新提问；原问题与证据保留。';this.saveQuestion(q); }
    return this.db.query<Row,[string,string]>('SELECT json FROM wb_questions WHERE workspace_id=? AND entity_id=? ORDER BY json_extract(json,\'$.createdAt\') DESC,id DESC LIMIT 30').all(this.workspaceId,entityId).map(parse<ContextQuestion>);
  }
  private saveQuestion(q: ContextQuestion) { this.db.query('UPDATE wb_questions SET status=?,json=? WHERE id=? AND workspace_id=?').run(q.status,JSON.stringify(q),q.id,this.workspaceId); }
  completeQuestion(id:string, contextHash:string, answer:string|null, citations:string[], error:string|null): WorkbenchData {
    const row=this.db.query<Row,[string,string]>('SELECT json FROM wb_questions WHERE id=? AND workspace_id=?').get(id,this.workspaceId);if(!row)throw Error('问题不存在');
    const q=parse<ContextQuestion>(row);if(q.status!=='pending')return{view:'conversations',items:this.questions(q.entityId),selected:q};
    if(q.context.hash!==contextHash)throw Error('问题上下文摘要不符');
    if(Date.now()>=Date.parse(q.deadlineAt)){q.status='failed';q.error='模型回答已超过截止时间，未保存迟到结果。';}
    else if(error){q.status='failed';q.error='模型回答未完成，请核对模型连接后重新提问。';}
    else {const validated=ContextAnswer.parse({answer,citations});const ids=new Set([...q.context.evidence.map(e=>e.id),...(q.context.wiki??[]).map(i=>'wiki:'+i.id+':v'+i.version)]);if(validated.citations.some(c=>!ids.has(c)))throw Error('模型引用不属于冻结窗口');q.status='answered';q.answer=validated.answer;q.citations=validated.citations;}
    this.saveQuestion(q);return{view:'conversations',items:this.questions(q.entityId),selected:q};
  }
  private library(): LibraryItem[] { return this.db.query<Row,[string]>('SELECT json FROM wb_library WHERE workspace_id=? ORDER BY json_extract(json,\'$.updatedAt\') DESC,id DESC LIMIT 500').all(this.workspaceId).map(parse<LibraryItem>); }
  private bindings(taskId:string): TaskBinding[] { this.task(taskId);return this.db.query<Row,[string,string]>("SELECT json FROM wb_bindings WHERE workspace_id=? AND task_id=? ORDER BY json_extract(json,'$.at') DESC,item_id,item_version DESC LIMIT 200").all(this.workspaceId,taskId).map(parse<TaskBinding>); }
  private observations(taskId?:string) { return this.db.query<Row,[string,string,string]>("SELECT json FROM wb_observations WHERE workspace_id=? AND (?='' OR json_extract(json,'$.taskId')=?) ORDER BY json_extract(json,'$.observedAt') DESC,key DESC LIMIT 100").all(this.workspaceId,taskId??'',taskId??'').map(parse<FollowupObservation>); }
  private followups(): WorkbenchData {
    const reminders=this.db.query<Row,[string]>("SELECT json FROM wb_reminders WHERE workspace_id=? ORDER BY (json_extract(json,'$.acknowledgedAt') IS NOT NULL),json_extract(json,'$.createdAt') DESC,key DESC LIMIT 50").all(this.workspaceId).map(parse<Reminder>);
    return {view:'followups',config:this.config(),plans:this.db.query<Row,[string]>('SELECT json FROM wb_plans WHERE workspace_id=? ORDER BY enabled DESC,due_at,task_id LIMIT 100').all(this.workspaceId).map(parse<FollowupPlan>),reminders,unread:this.db.query<{n:number},[string]>("SELECT count(*) n FROM wb_reminders WHERE workspace_id=? AND json_extract(json,'$.acknowledgedAt') IS NULL").get(this.workspaceId)!.n,observations:this.observations(),pendingFindings:this.db.query<{n:number},[string]>("SELECT count(*) n FROM wb_finding_links WHERE workspace_id=? AND state!='done'").get(this.workspaceId)!.n};
  }
  private baseline(t:BusinessTask):BusinessEvidence {const row=this.db.query<Row,[string]>('SELECT json FROM investigations WHERE id=?').get(t.origin.investigationId);if(!row)throw Error('原调查缺失，不能复查');return parse<AnyInvestigation>(row).evidence;}
  tick(): WorkbenchData {
    const now=this.now(),config=this.config();
    if(config.remindersEnabled)for(const row of this.db.query<Row,[string,string]>("SELECT t.json FROM business_tasks t WHERE t.workspace_id=? AND t.status NOT IN ('done','cancelled') AND t.due_at<=? AND NOT EXISTS(SELECT 1 FROM wb_reminders r WHERE r.workspace_id=t.workspace_id AND r.task_id=t.id AND json_extract(r.json,'$.dueAt')=t.due_at) ORDER BY t.due_at,t.id LIMIT 500").all(this.workspaceId,now)){
      const t=parse<BusinessTask>(row),key=businessDigest([this.workspaceId,t.id,t.dueAt]);
      const reminder:Reminder={id:randomUUID(),taskId:t.id,title:t.title,dueAt:t.dueAt,createdAt:now,acknowledgedAt:null,note:null};
      this.db.query('INSERT OR IGNORE INTO wb_reminders VALUES(?,?,?,?)').run(key,this.workspaceId,t.id,JSON.stringify(reminder));
    }
    const current=this.current();
    for(const row of this.db.query<Row,[string,string]>('SELECT json FROM wb_plans WHERE workspace_id=? AND enabled=1 AND due_at<=? ORDER BY due_at,task_id LIMIT 50').all(this.workspaceId,now)){
      const plan=parse<FollowupPlan>(row),t=this.task(plan.taskId).task;
      if(t.status==='cancelled'){plan.enabled=false;plan.version++;plan.updatedAt=now;this.savePlan(plan);continue;}
      const baseline=this.baseline(t),same=current.filter(e=>evidenceEntityId(e)===t.entityKey&&e.row.date>=baseline.row.date&&evidenceHash(e)!==evidenceHash(baseline));
      const skippedSlots=plan.repeatDays?Math.max(0,Math.floor((Date.parse(now)-Date.parse(plan.dueAt))/(plan.repeatDays*86400000))):0;
      const observation:FollowupObservation={id:randomUUID(),planId:plan.id,taskId:t.id,dueAt:plan.dueAt,observedAt:now,status:same.length?'observed':'needs_evidence',baseline,evidence:same.slice(0,30),skippedSlots,warnings:[limitation,'这是运行时读取的快照对照，不还原停机期间历史，不证明经营动作造成变化。',...(!same.length?['未发现同一明确范围的新证据，保留待补证。']:[]),...(same.length>30?['最多冻结30条对照，未展示部分不参与结论。']:[])]};
      const key=businessDigest([this.workspaceId,plan.id,plan.dueAt]);
      this.db.query('INSERT OR IGNORE INTO wb_observations VALUES(?,?,?,?)').run(key,this.workspaceId,plan.id,JSON.stringify(observation));
      if(plan.repeatDays)plan.dueAt=new Date(Date.parse(plan.dueAt)+(skippedSlots+1)*plan.repeatDays*86400000).toISOString();else plan.enabled=false;
      plan.version++;plan.updatedAt=now;this.savePlan(plan);
    }
    return this.followups();
  }
  private savePlan(plan:FollowupPlan){this.db.query('INSERT INTO wb_plans VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,due_at=excluded.due_at,enabled=excluded.enabled,json=excluded.json').run(plan.taskId,this.workspaceId,plan.version,plan.dueAt,Number(plan.enabled),JSON.stringify(plan));this.db.query('INSERT INTO wb_plan_events VALUES(?,?,?)').run(plan.taskId,plan.version,JSON.stringify(plan));}
  findingConfig(){return this.config();}
  doneFindingKeys(){return new Set(this.db.query<Row,[string]>("SELECT json FROM wb_finding_links WHERE workspace_id=? AND state='done'").all(this.workspaceId).map(row=>String(JSON.parse(row.json).key)));}
  claimFinding(key:string):string|null{
    const scoped=businessDigest([this.workspaceId,key]),row=this.db.query<Row,[string]>('SELECT json FROM wb_finding_links WHERE key=?').get(scoped),prior=row?parse<{state:string;leaseAt:string}>(row):null;
    if(prior&&(prior.state==='done'||Date.now()-Date.parse(prior.leaseAt)<120000))return null;
    const token=randomUUID(),json=JSON.stringify({key,state:'processing',leaseAt:this.now(),token});
    this.db.query('INSERT INTO wb_finding_links VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,lease_at=excluded.lease_at,json=excluded.json').run(scoped,this.workspaceId,'processing',this.now(),json);return token;
  }
  finishFinding(key:string,token:string,taskId:string){const scoped=businessDigest([this.workspaceId,key]),row=this.db.query<Row,[string,string]>('SELECT json FROM wb_finding_links WHERE key=? AND workspace_id=?').get(scoped,this.workspaceId);if(!row||JSON.parse(row.json).token!==token)throw Error('巡检联动租约失效');this.task(taskId);this.db.query('UPDATE wb_finding_links SET state=?,json=? WHERE key=?').run('done',JSON.stringify({...JSON.parse(row.json),state:'done',taskId}),scoped);}
  experience(){return new ExperienceLedger(this.db,this.workspaceId,this.current,()=>[...this.index().entities.values()],(id,p)=>this.entity(id,p),this.task);}
  handle(r:WorkbenchRequest):WorkbenchData {
    if(r.op.startsWith('wb_exp_'))return this.experience().handle(r as ExperienceRequest);
    if(r.op.startsWith('wb_wiki_'))return new WikiLedger(this.db,this.workspaceId,this.task).handle(WikiRequestSchema.parse(r));
    switch(r.op){
      case 'wb_entities':{const items=[...this.index().entities.values()].filter(e=>(r.source==='all'||e.scope.source===r.source)&&`${e.name} ${e.scope.shop} ${e.scope.channel} ${e.scope.sku}`.toLowerCase().includes(r.search.toLowerCase())).sort((a,b)=>b.dates.last.localeCompare(a.dates.last)||a.id.localeCompare(b.id));return{view:'entities',items:items.slice(r.offset,r.offset+r.limit),total:items.length,offset:r.offset};}
      case 'wb_entity':return{view:'entity',detail:this.entity(r.entityId,r.period)};
      case 'wb_conversations':return{view:'conversations',items:this.questions(r.entityId)};
      case 'wb_ask':{
        this.questions(r.entityId);
        const previous=this.db.query<Row,[string]>('SELECT json FROM wb_questions WHERE id=?').get(r.questionId);if(previous){const q=parse<ContextQuestion>(previous);if(this.db.query<{workspace_id:string},[string]>('SELECT workspace_id FROM wb_questions WHERE id=?').get(r.questionId)!.workspace_id!==this.workspaceId||q.entityId!==r.entityId||q.question!==r.question||q.mode!==r.mode||JSON.stringify(q.context.period)!==JSON.stringify(r.period))throw Error('问题标识已被其他内容使用');return{view:'conversations',items:this.questions(r.entityId),selected:q,created:false};}
        if(this.db.query<{n:number},[string]>("SELECT count(*) n FROM wb_questions WHERE workspace_id=? AND status='pending'").get(this.workspaceId)!.n>=2)throw Error('已有待完成的上下文问题，请稍后重试');
        const context=this.entity(r.entityId,r.period);if(!context.evidence.length)throw Error('窗口内没有可引用证据');
        if(Buffer.byteLength(JSON.stringify(context),'utf8')>160000)throw Error('当前窗口证据体量过大，请缩小日期范围或从单条原始证据进入调查');
        const recent=this.questions(r.entityId).filter(q=>q.status==='answered'&&JSON.stringify(q.context.period)===JSON.stringify(r.period)).slice(0,8).reverse();
        const q:ContextQuestion={id:r.questionId,entityId:r.entityId,question:r.question,mode:r.mode,status:r.mode==='replay'?'answered':'pending',createdAt:this.now(),deadlineAt:new Date(Date.now()+120000).toISOString(),context,history:recent.map(q=>({question:q.question,answer:q.answer!})),answer:r.mode==='replay'?'离线证据导览：请先核对所选窗口的原始事实、来源与缺失项，再打开关联调查比较方案。此模式没有调用模型，不对自由问题生成经营判断。':null,citations:r.mode==='replay'?context.evidence.map(e=>e.id):[],error:null};
        this.db.query('INSERT INTO wb_questions VALUES(?,?,?,?,?,?)').run(q.id,this.workspaceId,q.entityId,q.status,q.deadlineAt,JSON.stringify(q));
        return{view:'conversations',items:this.questions(r.entityId),selected:q,created:true};
      }
      case 'wb_library':return{view:'library',items:this.library(),total:this.db.query<{n:number},[string]>('SELECT count(*) n FROM wb_library WHERE workspace_id=?').get(this.workspaceId)!.n};
      case 'wb_library_links':{const ids=this.db.query<{task_id:string},[string,string]>('SELECT DISTINCT task_id FROM wb_bindings WHERE workspace_id=? AND item_id=?').all(this.workspaceId,r.itemId);return{view:'library_links',items:ids.slice(0,100).map(row=>this.task(row.task_id).task),total:ids.length};}
      case 'wb_task_tools':{const bindings=this.bindings(r.taskId),row=this.db.query<Row,[string,string]>('SELECT json FROM wb_plans WHERE task_id=? AND workspace_id=?').get(r.taskId,this.workspaceId);return{view:'task_tools',bindings,plan:row?parse<FollowupPlan>(row):null,observations:this.observations(r.taskId)};}
      case 'wb_library_save':{
        const row=r.id?this.db.query<Row,[string,string]>('SELECT json FROM wb_library WHERE id=? AND workspace_id=?').get(r.id,this.workspaceId):null,old=row?parse<LibraryItem>(row):null;
        if(r.id&&!old)throw Error('知识条目不存在');if((old?.version??0)!==r.expectedVersion)throw Error('知识条目版本已变化，请刷新');if(old&&old.kind!==r.kind)throw Error('不能修改既有条目类型');if(old?.wiki)throw Error('请在知识中心维护此文档');
        if(!old&&this.library().length>=500)throw Error('最多500条知识条目，请维护既有内容');
        const item:LibraryItem={id:old?.id??randomUUID(),version:(old?.version??0)+1,kind:r.kind,title:r.title,scenario:r.scenario,body:r.body,archived:r.archived,updatedAt:this.now()};
        this.db.query('INSERT INTO wb_library VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,json=excluded.json').run(item.id,this.workspaceId,item.version,JSON.stringify(item));this.db.query('INSERT INTO wb_library_versions VALUES(?,?,?)').run(item.id,item.version,JSON.stringify(item));return{view:'library',items:this.library(),total:this.library().length};
      }
      case 'wb_bind':{const t=this.task(r.taskId).task;if(t.version!==r.expectedTaskVersion)throw Error('任务版本已变化');const row=this.db.query<Row,[string,string]>('SELECT json FROM wb_library WHERE id=? AND workspace_id=?').get(r.itemId,this.workspaceId);if(!row)throw Error('知识条目不存在');const item=parse<LibraryItem>(row);if(item.archived)throw Error('条目已停用，不能新关联');if(!new WikiLedger(this.db,this.workspaceId,this.task).eligible(t.scope).some(i=>i.id===item.id))throw Error('知识场景或适用范围不符，或来源不可用');if(item.scenario!=='all'&&item.scenario!==t.scope.scenario)throw Error('条目场景与任务不一致');const binding:TaskBinding={taskId:t.id,taskVersion:t.version,item,at:this.now()};this.db.query('INSERT OR IGNORE INTO wb_bindings VALUES(?,?,?,?,?)').run(t.id,item.id,item.version,this.workspaceId,JSON.stringify(binding));return{view:'bindings',items:this.bindings(t.id)};}
      case 'wb_bindings':return{view:'bindings',items:this.bindings(r.taskId)};
      case 'wb_followups':return this.followups();
      case 'wb_configure':{const old=this.config();if(old.version!==r.expectedVersion)throw Error('联动配置版本已变化');const config:FollowupConfig={version:old.version+1,remindersEnabled:r.remindersEnabled,autoFindingTasks:r.autoFindingTasks,owner:r.owner,dueHours:r.dueHours,configuredAt:r.autoFindingTasks&&!old.autoFindingTasks?this.now():old.configuredAt};this.db.query('UPDATE wb_config SET json=? WHERE workspace_id=?').run(JSON.stringify(config),this.workspaceId);return this.followups();}
      case 'wb_plan':{const t=this.task(r.taskId).task;if(t.version!==r.expectedTaskVersion)throw Error('任务版本已变化');const row=this.db.query<Row,[string,string]>('SELECT json FROM wb_plans WHERE task_id=? AND workspace_id=?').get(t.id,this.workspaceId),old=row?parse<FollowupPlan>(row):null;if((old?.version??0)!==r.expectedVersion)throw Error('复查计划版本已变化');const plan:FollowupPlan={id:old?.id??randomUUID(),taskId:t.id,version:(old?.version??0)+1,dueAt:new Date(r.dueAt).toISOString(),repeatDays:r.repeatDays,enabled:r.enabled,updatedAt:this.now()};this.savePlan(plan);return this.followups();}
      case 'wb_ack':{const row=this.db.query<Row,[string,string]>("SELECT json FROM wb_reminders WHERE workspace_id=? AND json_extract(json,'$.id')=?").get(this.workspaceId,r.id);if(!row)throw Error('提醒不存在');const reminder=parse<Reminder>(row);if(!reminder.acknowledgedAt){reminder.acknowledgedAt=this.now();reminder.note=r.note;this.db.query("UPDATE wb_reminders SET json=? WHERE workspace_id=? AND json_extract(json,'$.id')=?").run(JSON.stringify(reminder),this.workspaceId,r.id);}return this.followups();}
      case 'wb_tick':return this.tick();
      case 'wb_cases':{const where="workspace_id=? AND (?='' OR instr(lower(json_extract(json,'$.title')||' '||json_extract(json,'$.lesson')||' '||json_extract(json,'$.task.task.scope.sku')),lower(?))>0)";const rows=this.db.query<Row,[string,string,string,number]>(`SELECT json FROM wb_cases WHERE ${where} ORDER BY json_extract(json,'$.createdAt') DESC,id DESC LIMIT 30 OFFSET ?`).all(this.workspaceId,r.search,r.search,r.offset).map(parse<BusinessCase>);return{view:'cases',items:rows.map(c=>({id:c.id,title:c.title,category:c.category,createdAt:c.createdAt,taskId:c.taskId})),total:this.db.query<{n:number},[string,string,string]>(`SELECT count(*) n FROM wb_cases WHERE ${where}`).get(this.workspaceId,r.search,r.search)!.n,offset:r.offset};}
      case 'wb_case':{const row=this.db.query<Row,[string,string]>('SELECT json FROM wb_cases WHERE id=? AND workspace_id=?').get(r.id,this.workspaceId);if(!row)throw Error('案例不存在');return{view:'case',item:parse<BusinessCase>(row)};}
      case 'wb_archive':{const detail=this.task(r.taskId),t=detail.task;if(t.version!==r.expectedTaskVersion)throw Error('任务版本已变化');if(t.status!=='done')throw Error('请完成任务并核对证据后归档');const old=this.db.query<Row,[string,string,number]>('SELECT json FROM wb_cases WHERE workspace_id=? AND task_id=? AND task_version=?').get(this.workspaceId,t.id,t.version);if(old)return{view:'case',item:parse<BusinessCase>(old)};const item:BusinessCase={id:randomUUID(),taskId:t.id,taskVersion:t.version,title:r.title,lesson:r.lesson,declaredOutcome:r.outcome,createdAt:this.now(),category:t.purpose==='simulation_action'?'simulation':'analysis',caseReferences:this.experience().references(t.origin.investigationId),wikiReferences:new WikiLedger(this.db,this.workspaceId,this.task).references(t.origin.investigationId),task:detail,bindings:this.bindings(t.id),observations:this.observations(t.id),limitation:'人工跟进/本地模拟案例；结果为操作者声明，不代表已验证真实经营效果。保留原证据、截断提示和不确定性，不作为审批授权。'};this.db.query('INSERT INTO wb_cases VALUES(?,?,?,?,?)').run(item.id,this.workspaceId,t.id,t.version,JSON.stringify(item));return{view:'case',item};}
    }
    throw Error('未知工作台操作');
  }
}
export const ContextAnswer = z.strictObject({ answer:z.string().trim().min(1).max(4000).refine(s=>!/[0-9０-９]|百分之|[零〇一二三四五六七八九十百千万亿两]+\s*(?:元|件|天|倍|成|瓶|袋|盒|%|％)/.test(s),'助手正文只允许定性说明，数值须查看原证据事实卡'),citations:z.array(z.string().min(1).max(128)).min(1).max(30) });
