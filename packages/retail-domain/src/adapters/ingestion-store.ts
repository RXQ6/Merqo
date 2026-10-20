import {Database} from 'bun:sqlite';
import {IssueReviewSchema,type IssueReviewInput,type IssueReview,type IngestionIssues} from './ingestion-issues-contract';
import {LineReferenceSchema,parseLineReference,compareLines,type LineReference} from './line-reference';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';
import {TransactionStore} from '../transaction-store';
import type {TransactionEvent} from '../transactions';
import type {SyncJob} from './sync-contract';
import {MappingProfileSchema,StatementSchema,mapOrders,eventsCsv,sourceIdentity,digest,totals} from './ingestion';
import type {SavedMapping,MappingProfile,IngestView,IngestPreview,IngestReceipt,Reconciliation,Statement} from './ingestion';
import {fixtureControlTotals} from './ingestion-fixture';

interface FrozenPreview {inputDuplicates?:number;view:IngestPreview;events:TransactionEvent[];ledgerHash:string;csv:string;csvHash:string;job:SyncJob;}
export class IngestionStore {
 private db:Database;private ledger:TransactionStore;
 constructor(file:string,private now=Date.now){mkdirSync(dirname(file),{recursive:true});this.db=new Database(file,{create:true,strict:true});this.ledger=new TransactionStore(file,this.db);
  this.db.exec(`CREATE TABLE IF NOT EXISTS ingest_issue_reviews(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL,json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS ingest_issue_preview ON ingest_issue_reviews(preview_id);
   CREATE TABLE IF NOT EXISTS ingest_mappings(revision INTEGER PRIMARY KEY,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ingest_previews(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ingest_receipts(id TEXT PRIMARY KEY,preview_id TEXT NOT NULL UNIQUE,json TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS ingest_preview_job ON ingest_previews(job_id);
   CREATE INDEX IF NOT EXISTS ingest_receipt_job ON ingest_receipts(json_extract(json,'$.jobId'));
   CREATE TABLE IF NOT EXISTS ingest_reconciliations(id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL,json TEXT NOT NULL);`);
  for(const table of['ingest_issue_reviews','ingest_mappings','ingest_previews','ingest_receipts','ingest_reconciliations'])for(const op of['UPDATE','DELETE'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable ingestion history');END;`);
 }
 close(){this.db.close();}
 lookup(previewId:string){return this.view(this.frozen(previewId).view.jobId);}
 private issueReview(previewId:string):IssueReview|null{const row=this.db.query<{json:string},[string]>('SELECT json FROM ingest_issue_reviews WHERE preview_id=? ORDER BY rowid DESC LIMIT 1').get(previewId);return row?JSON.parse(row.json):null;}
 issues(offset=0,limit=20):IngestionIssues{
  return this.db.transaction(()=>{const where="json_extract(json,'$.view.quarantinedRecords')>0",total=this.db.query<{n:number},[]>(`SELECT COUNT(*) AS n FROM ingest_previews WHERE ${where}`).get()!.n;
   const cases=this.db.query<{json:string},[number,number]>(`SELECT json FROM ingest_previews WHERE ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit,offset).map(row=>{const p=(JSON.parse(row.json) as FrozenPreview).view;return{previewId:p.id,jobId:p.jobId,createdAt:p.createdAt,mappingRevision:p.mappingRevision,quarantinedRecords:p.quarantinedRecords,quarantine:p.quarantine,review:this.issueReview(p.id)};});return{total,offset,limit,cases};})();
 }
 reviewIssue(input:IssueReviewInput):IngestionIssues{
  const r=IssueReviewSchema.parse(input);return this.db.transaction(()=>{const old=this.frozen(r.previewId);if(!old.view.quarantinedRecords)throw Error('该预览没有隔离记录');if((this.issueReview(r.previewId)?.id??null)!==r.expectedReviewId)throw Error('处理记录已变化，请刷新');
   if(r.receiptId){const receipt=this.receipt(r.receiptId),next=this.frozen(receipt.previewId);if(next.view.createdAt<old.view.createdAt||receipt.quarantinedRecords||next.view.id===old.view.id)throw Error('请选择此后无隔离记录的新入库回执');if(next.job.mode!==old.job.mode||sourceIdentity(next.job)!==sourceIdentity(old.job))throw Error('重处理回执与原来源范围不一致');}
   const record:IssueReview={...r,id:crypto.randomUUID(),at:this.now(),authority:'local_operator'};this.db.query('INSERT INTO ingest_issue_reviews VALUES(?,?,?)').run(record.id,r.previewId,JSON.stringify(record));return this.issues();
  }).immediate();
 }
 private mapping():SavedMapping|null{const r=this.db.query<{json:string},[]>('SELECT json FROM ingest_mappings ORDER BY revision DESC LIMIT 1').get();return r?JSON.parse(r.json):null;}
 private previews(jobId?:string):FrozenPreview[]{return this.db.query<{json:string},string[]>('SELECT json FROM ingest_previews'+(jobId?' WHERE job_id=?':'')+' ORDER BY rowid DESC LIMIT 30').all(...(jobId?[jobId]:[])).map(r=>JSON.parse(r.json));}
 private frozen(id:string):FrozenPreview {const r=this.db.query<{json:string},[string]>('SELECT json FROM ingest_previews WHERE id=?').get(id);if(!r)throw Error('入库预览不存在');return JSON.parse(r.json);}
 private receipt(id:string):IngestReceipt {const r=this.db.query<{json:string},[string]>('SELECT json FROM ingest_receipts WHERE id=?').get(id);if(!r)throw Error('入库回执不存在');return JSON.parse(r.json);}
 view(jobId?:string):IngestView{return{mapping:this.mapping(),previews:this.previews(jobId).map(p=>p.view),receipts:this.db.query<{json:string},string[]>("SELECT json FROM ingest_receipts"+(jobId?" WHERE json_extract(json,'$.jobId')=?":'')+' ORDER BY rowid DESC LIMIT 30').all(...(jobId?[jobId]:[])).map(r=>JSON.parse(r.json)),reconciliations:this.db.query<{json:string},string[]>("SELECT c.json FROM ingest_reconciliations c"+(jobId?" JOIN ingest_receipts r ON r.id=c.receipt_id WHERE json_extract(r.json,'$.jobId')=?":'')+' ORDER BY c.rowid DESC LIMIT 50').all(...(jobId?[jobId]:[])).map(r=>JSON.parse(r.json))};}
 saveMapping(expectedRevision:number,input:MappingProfile):IngestView {const profile=MappingProfileSchema.parse(input);return this.db.transaction(()=>{const old=this.mapping();if((old?.revision??0)!==expectedRevision)throw Error('映射版本已变化，请刷新');const saved:SavedMapping={revision:expectedRevision+1,profile,hash:digest(profile),at:this.now()};this.db.query('INSERT INTO ingest_mappings VALUES(?,?)').run(saved.revision,JSON.stringify(saved));return this.view();}).immediate();}
 preview(job:SyncJob,orders:Record<string,unknown>[],stageDigest:string):IngestView {
  if(job.status!=='fetched'||!orders.length||orders.length!==job.received)throw Error('暂存记录为空或与任务计数不一致，不能生成入库预览');
  z.string().regex(/^[a-f0-9]{64}$/).parse(stageDigest);if(orders.length>10000)throw Error('单次映射最多10,000条来源记录');
  return this.db.transaction(()=>{
   const mapping=this.mapping();if(!mapping)throw Error('请先保存事件映射规则');
   const mapped=mapOrders(orders,mapping.profile,job);if(mapped.events.length>100000)throw Error('单次映射最多100,000条事件');
   const source=job.mode==='fixture'?'demo' as const:'csv' as const,csv=eventsCsv(mapped.events),transaction=this.ledger.preview(csv,source);
   let newEvents=0,duplicateEvents=mapped.duplicates,conflictEvents=0;
   for(const event of mapped.events){const state=this.ledger.match(event,source);if(state==='new')newEvents++;else if(state==='duplicate')duplicateEvents++;else conflictEvents++;}
   const quarantinedRecords=new Set(mapped.quarantine.map(q=>q.record)).size;
   const blockingIssues=transaction.errors.map(e=>e.reason).slice(0,30);
   const ledgerHash=this.ledger.stateHash(source);
   const view:IngestPreview={id:crypto.randomUUID(),jobId:job.id,mode:job.mode,source,mappingRevision:mapping.revision,mappingName:mapping.profile.name,stageDigest,reviewHash:'',createdAt:this.now(),totalRecords:orders.length,newEvents,duplicateEvents,conflictEvents,quarantinedRecords,quarantine:mapped.quarantine.slice(0,100),blockingIssues,sample:mapped.events.slice(0,30),totals:totals(mapped.events),canConfirm:transaction.canImport&&conflictEvents===0};
   view.reviewHash=digest({jobId:job.id,stageDigest,mappingHash:mapping.hash,mappingRevision:mapping.revision,ledgerHash,events:mapped.events,quarantine:mapped.quarantine});
   const frozen:FrozenPreview={inputDuplicates:mapped.duplicates,view,events:mapped.events,ledgerHash,csv,csvHash:transaction.hash,job};
   this.db.query('INSERT INTO ingest_previews VALUES(?,?,?)').run(view.id,job.id,JSON.stringify(frozen));return this.view(job.id);
  }).immediate();
 }
 confirm(previewId:string,reviewHash:string,stageDigest:string,allowPartial=false,reason=''):IngestView {
  return this.db.transaction(()=>{
   const p=this.frozen(previewId);if(p.view.reviewHash!==reviewHash)throw Error('预览摘要不一致');
   const existing=this.db.query<{id:string},[string]>('SELECT id FROM ingest_receipts WHERE preview_id=?').get(previewId);if(existing)return this.view(p.view.jobId);
   if(stageDigest!==p.view.stageDigest)throw Error('来源暂存已变化，请重新预览');
   if(this.mapping()?.revision!==p.view.mappingRevision)throw Error('映射规则已变化，请重新预览');
   if(!p.view.canConfirm)throw Error('当前预览不能入库，请先处理隔离或事件链错误');
   if(p.view.quarantinedRecords&&(!allowPartial||reason.trim().length<10))throw Error('部分入库需要明确确认并填写至少10字的原因；隔离记录不会丢弃');
   if(this.ledger.stateHash(p.view.source)!==p.ledgerHash)throw Error('交易账本已变化，请重新预览');
   const metadata=p.view.source==='csv'?{sourceId:sourceIdentity(p.job),sourceName:'抖店批次人工映射（未独立认证）',sourceObservedAt:new Date(this.now()).toISOString(),coverageStartInclusive:new Date(p.job.window.start*1000).toISOString(),completeThroughExclusive:new Date(p.job.window.end*1000).toISOString(),completeness:'partial' as const,timezone:'Asia/Shanghai' as const}:undefined;
   const result=this.ledger.import(p.csv,p.csvHash,p.view.source,metadata);
   const receipt:IngestReceipt={id:crypto.randomUUID(),previewId,jobId:p.view.jobId,reviewHash,mappingRevision:p.view.mappingRevision,at:this.now(),accepted:result.accepted,duplicates:result.duplicateCount+(p.inputDuplicates??0),quarantinedRecords:p.view.quarantinedRecords,batchId:result.batchId,source:p.view.source,totals:p.view.totals};
   this.db.query('INSERT INTO ingest_receipts VALUES(?,?,?)').run(receipt.id,previewId,JSON.stringify({...receipt,...(allowPartial?{partialReason:reason.trim()}:{})}));return this.view(p.view.jobId);
  }).immediate();
 }
 reconcile(receiptId:string,input?:Statement,lineInput?:LineReference):IngestView {
  return this.db.transaction(()=>{
   const receipt=this.receipt(receiptId),p=this.frozen(receipt.previewId);
   let statement:Statement|undefined,reference:Reconciliation['reference']='missing';
   if(input){statement=StatementSchema.parse(input);if(Date.parse(statement.observedAt)>this.now()+300000)throw Error('对账来源观测时间超前');if(statement.shopId!==(p.job.mode==='fixture'?'DEMO-SHOP':p.job.scope?.shopId))throw Error('对账来源店铺与冻结任务不一致');reference='operator_declared';}
   else if(!lineInput&&p.job.mode==='fixture'){reference='synthetic_control';statement={label:'独立合成控制总额（非真实后台）',shopId:'DEMO-SHOP',currency:'CNY',basis:'batch_event_set',observedAt:new Date(this.now()).toISOString(),totals:fixtureControlTotals};}
   let lineReference:Reconciliation['lineReference'];
   if(lineInput){if(input)throw Error('请选择合计或逐行参考，不能混用');const ref=LineReferenceSchema.parse(lineInput);if(Date.parse(ref.observedAt)>this.now()+300000)throw Error('参考文件观测时间超前');const parsed=parseLineReference(ref.csv,sourceIdentity(p.job),p.job.mode==='fixture'?'DEMO-SHOP':p.job.scope!.shopId);lineReference={...compareLines(p.events,parsed.events,parsed.duplicates),label:ref.label,observedAt:ref.observedAt,fileHash:digest(ref.csv)};reference='operator_file';}
   const present=p.events.filter(e=>this.ledger.match(e,p.view.source)==='duplicate'),ledgerIssues=p.events.length-present.length,actual=totals(present);
   const differences:Reconciliation['differences']=[];
   if(statement)for(const key of Object.keys(actual) as Array<keyof typeof actual>)if(actual[key]!==statement.totals[key])differences.push({field:key,expected:statement.totals[key],actual:actual[key]});
   const result:Reconciliation={id:crypto.randomUUID(),receiptId,at:this.now(),status:!statement&&!lineReference?'unverified':differences.length||ledgerIssues||receipt.quarantinedRecords||lineReference&&(lineReference.referenceOnly||lineReference.batchOnly||lineReference.changed)?'mismatch':'matched',reference,...(lineReference?{lineReference}:{}),differences,ledgerIssues,quarantinedRecords:receipt.quarantinedRecords,statementHash:statement?digest(statement):null};
   this.db.query('INSERT INTO ingest_reconciliations VALUES(?,?,?)').run(result.id,receiptId,JSON.stringify({...result,statement:statement??null,lineReferenceInput:lineInput?{label:lineInput.label,observedAt:lineInput.observedAt,csv:lineInput.csv}:null}));return this.view(p.view.jobId);
  }).immediate();
 }
}
