import {compareContributions,type ContributionComparison,type FrozenContribution} from './contribution-comparison';
import {ContributionInputSchema,parseCosts,calculateContribution,type ContributionInput,type ContributionReport} from './contribution';
import {Database} from 'bun:sqlite';import {createHash} from 'node:crypto';import {mkdirSync} from 'node:fs';import {dirname} from 'node:path';
import {decodeTransactionCsv,validateTransactionChains,transactionKey,transactionEntity,exchangeTarget,transactionWindow,TransactionQuerySchema,TRANSACTION_DEMO} from './transactions';
import type {TransactionEvent,TransactionPreview,TransactionPage,TransactionQuery} from './transactions';
import {freezeSourceMetadata} from './source-provenance';import type {SourceMetadataInput,EvidenceProvenance} from './source-metadata';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
interface Stored{json:string;source:'demo'|'csv';batch_id:string;imported_at:string;provenance:string|null}
export class TransactionStore{
 private readonly db:Database;
 private readonly ownsConnection:boolean;
 constructor(file:string,connection?:Database){mkdirSync(dirname(file),{recursive:true});this.ownsConnection=!connection;this.db=connection??new Database(file,{create:true,strict:true});this.db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS contribution_comparisons(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS contribution_comparisons_no_update BEFORE UPDATE ON contribution_comparisons BEGIN SELECT RAISE(ABORT,'immutable comparisons');END;
 CREATE TRIGGER IF NOT EXISTS contribution_comparisons_no_delete BEFORE DELETE ON contribution_comparisons BEGIN SELECT RAISE(ABORT,'immutable comparisons');END;
 CREATE TABLE IF NOT EXISTS contribution_reports(id TEXT PRIMARY KEY,json TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS contribution_reports_immutable_update BEFORE UPDATE ON contribution_reports BEGIN SELECT RAISE(ABORT,'immutable contribution reports');END;
 CREATE TRIGGER IF NOT EXISTS contribution_reports_immutable_delete BEFORE DELETE ON contribution_reports BEGIN SELECT RAISE(ABORT,'immutable contribution reports');END;
 CREATE TABLE IF NOT EXISTS transaction_batches(id TEXT PRIMARY KEY,source TEXT NOT NULL,hash TEXT NOT NULL,imported_at TEXT NOT NULL,provenance TEXT CHECK(provenance IS NULL OR json_valid(provenance))) STRICT;
 CREATE TABLE IF NOT EXISTS transaction_events(source TEXT NOT NULL,event_key TEXT NOT NULL,entity_key TEXT NOT NULL,event_at INTEGER NOT NULL,order_at INTEGER NOT NULL,shop_id TEXT NOT NULL,channel TEXT NOT NULL,kind TEXT NOT NULL,quantity INTEGER NOT NULL,amount_minor INTEGER NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),batch_id TEXT NOT NULL REFERENCES transaction_batches(id),PRIMARY KEY(source,event_key)) STRICT;
 CREATE INDEX IF NOT EXISTS transaction_event_time ON transaction_events(source,event_at);
 CREATE INDEX IF NOT EXISTS transaction_order_time ON transaction_events(source,order_at);
 CREATE INDEX IF NOT EXISTS transaction_entity ON transaction_events(source,entity_key);
 CREATE TRIGGER IF NOT EXISTS transaction_events_immutable_update BEFORE UPDATE ON transaction_events BEGIN SELECT RAISE(ABORT,'immutable transaction events');END;
 CREATE TRIGGER IF NOT EXISTS transaction_events_immutable_delete BEFORE DELETE ON transaction_events BEGIN SELECT RAISE(ABORT,'immutable transaction events');END;
 CREATE TRIGGER IF NOT EXISTS transaction_batches_immutable_update BEFORE UPDATE ON transaction_batches BEGIN SELECT RAISE(ABORT,'immutable transaction batches');END;
 CREATE TRIGGER IF NOT EXISTS transaction_batches_immutable_delete BEFORE DELETE ON transaction_batches BEGIN SELECT RAISE(ABORT,'immutable transaction batches');END;`);
 if(!this.db.query<{name:string},[]>('PRAGMA table_info(transaction_events)').all().some(c=>c.name==='replaces_entity'))this.db.exec('ALTER TABLE transaction_events ADD COLUMN replaces_entity TEXT');
 this.db.exec('CREATE INDEX IF NOT EXISTS transaction_replacements ON transaction_events(source,replaces_entity)');}
 close(){if(this.ownsConnection)this.db.close();}
 contributionComparisons():ContributionComparison[]{return this.db.query<{json:string},[]>('SELECT json FROM contribution_comparisons ORDER BY rowid DESC LIMIT 20').all().map(row=>JSON.parse(row.json));}
 compareContributionReports(baselineId:string,currentId:string){return this.db.transaction(()=>{const read=(id:string)=>{const row=this.db.query<{json:string},[string]>('SELECT json FROM contribution_reports WHERE id=?').get(id);if(!row)throw Error('费用报告不存在');return JSON.parse(row.json) as FrozenContribution;};const result=compareContributions(read(baselineId),read(currentId));this.db.query('INSERT INTO contribution_comparisons VALUES(?,?)').run(result.id,JSON.stringify(result));return this.contributionComparisons();}).immediate();}
 contributionReports():ContributionReport[]{return this.db.query<{json:string},[]>('SELECT json FROM contribution_reports ORDER BY rowid DESC LIMIT 20').all().map(row=>JSON.parse(row.json).report);}
 contribution(input:ContributionInput):ContributionReport[]{const value=ContributionInputSchema.parse(input);return this.db.transaction(()=>{
  const q=value.query,range=transactionWindow(q.startDate,q.endDate),parsed=parseCosts(value.csv),events=this.db.query<{json:string},[string,number,number,string,string,string,string]>('SELECT json FROM transaction_events WHERE source=? AND order_at>=? AND order_at<? AND (?=\'\' OR shop_id=?) AND (?=\'\' OR channel=?) ORDER BY event_key').all(q.source,Date.parse(range.startInclusive),Date.parse(range.endExclusive),q.shop,q.shop,q.channel,q.channel).map(row=>JSON.parse(row.json) as TransactionEvent);
  if(!events.length)throw Error('当前原订单归属范围没有交易事件，请先导入交易或调整范围');
  const report:ContributionReport={id:crypto.randomUUID(),at:Date.now(),label:value.label,source:q.source,query:q,inputHash:hash(value.csv),ledgerHash:this.stateHash(q.source),authority:'operator_declared',duplicates:parsed.duplicates,...calculateContribution(events,parsed.rows)};
  this.db.query('INSERT INTO contribution_reports VALUES(?,?)').run(report.id,JSON.stringify({report,normalizedCosts:parsed.rows}));return this.contributionReports();
 }).immediate();}
 stateHash(source:'demo'|'csv'){const h=createHash('sha256');for(const row of this.db.query<{event_key:string;json:string},[string]>('SELECT event_key,json FROM transaction_events WHERE source=? ORDER BY event_key').iterate(source)){h.update(row.event_key);h.update(row.json);}return h.digest('hex');}
 match(event:TransactionEvent,source:'demo'|'csv'):'new'|'duplicate'|'conflict'{const old=this.db.query<{json:string},[string,string]>('SELECT json FROM transaction_events WHERE source=? AND event_key=?').get(source,transactionKey(event));return !old?'new':old.json===JSON.stringify(event)?'duplicate':'conflict';}
 preview(csv:string,source:'demo'|'csv'='csv'):TransactionPreview{
  const parsed=decodeTransactionCsv(csv);const errors=[...parsed.errors];const combined=new Map<string,TransactionEvent>();let duplicateCount=parsed.duplicateCount;
  const load=this.db.query<{json:string},[string,string]>('SELECT json FROM transaction_events WHERE source=? AND entity_key=?');
  const reverse=this.db.query<{json:string},[string,string]>('SELECT json FROM transaction_events WHERE source=? AND replaces_entity=?');
  const queue=new Set(parsed.events.flatMap(e=>[transactionEntity(e),...(exchangeTarget(e)?[exchangeTarget(e)!]:[])]));
  // Load the connected lineage, including siblings that may already consume the same returned units.
  for(const entity of queue){for(const r of [...load.all(source,entity),...reverse.all(source,entity)]){const e=JSON.parse(r.json) as TransactionEvent;combined.set(transactionKey(e),e);queue.add(transactionEntity(e));const target=exchangeTarget(e);if(target)queue.add(target);}}
  const find=this.db.query<{json:string},[string,string]>('SELECT json FROM transaction_events WHERE source=? AND event_key=?');
  for(const e of parsed.events){const old=find.get(source,transactionKey(e));if(old){if(old.json!==JSON.stringify(e))errors.push({line:0,reason:`事件 ${e.event_id} 已存在且内容冲突，不能覆盖`});else duplicateCount++;}combined.set(transactionKey(e),e);}
  errors.push(...validateTransactionChains([...combined.values()]).map(reason=>({line:0,reason})));
  return{...parsed,errors,duplicateCount,hash:hash(csv),canImport:parsed.events.length>0&&errors.length===0};
 }
 import(csv:string,previewHash:string,source:'demo'|'csv'='csv',metadata?:SourceMetadataInput):{accepted:number;duplicateCount:number;batchId:string}{
  if(hash(csv)!==previewHash)throw Error('交易预览摘要已变化，请重新预览');
  return this.db.transaction(()=>{
   const preview=this.preview(csv,source);if(!preview.canImport)throw Error(preview.errors.slice(0,10).map(e=>e.reason).join('；'));
   const at=new Date().toISOString();if(source==='csv'&&preview.events.some(e=>Date.parse(e.event_at)>Date.parse(at)+300000))throw Error('交易事件时间超前，请核对来源时钟');
   if(metadata&&preview.events.some(e=>e.source_id!==metadata.sourceId))throw Error('来源声明标识必须与交易 source_id 一致');
   const rows=preview.events.flatMap(e=>[e.event_at,e.order_at].map(t=>({date:new Date(Date.parse(t)+8*3600000).toISOString().slice(0,10)})));
   const provenance=freezeSourceMetadata(source,'transactions',csv,rows,at,metadata);
   const digest=hash(JSON.stringify({csv,source,provenance})),batchId='transactions-'+digest;
   const existing=this.db.query('SELECT 1 FROM transaction_batches WHERE id=?').get(batchId);if(existing)return{accepted:0,duplicateCount:preview.events.length,batchId};
   const insert=this.db.query('INSERT OR IGNORE INTO transaction_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
   const count=this.db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM transaction_events').get()!.n;
   const existingEvent=this.db.query('SELECT 1 FROM transaction_events WHERE source=? AND event_key=?');
   if(count+preview.events.filter(e=>!existingEvent.get(source,transactionKey(e))).length>100000)throw Error('交易账本最多保留100,000条事件');
   this.db.query('INSERT INTO transaction_batches VALUES(?,?,?,?,?)').run(batchId,source,digest,at,provenance?JSON.stringify(provenance):null);
   let accepted=0;for(const e of preview.events)accepted+=insert.run(source,transactionKey(e),transactionEntity(e),Date.parse(e.event_at),Date.parse(e.order_at),e.shop_id,e.channel,e.kind,e.quantity,e.amount_minor,JSON.stringify(e),batchId,exchangeTarget(e)??null).changes;
   return{accepted,duplicateCount:preview.events.length-accepted,batchId};
  }).immediate();
 }
 demo(){const csv=TRANSACTION_DEMO;return this.import(csv,hash(csv),'demo');}
 page(input:TransactionQuery):TransactionPage{
  const q=TransactionQuerySchema.parse(input),range=transactionWindow(q.startDate,q.endDate),clock=q.basis==='event'?'event_at':'order_at';
  const where=`e.source=? AND e.${clock}>=? AND e.${clock}<? AND (?='' OR e.shop_id=?) AND (?='' OR e.channel=?)`;
  const params:[string,number,number,string,string,string,string]=[q.source,Date.parse(range.startInclusive),Date.parse(range.endExclusive),q.shop,q.shop,q.channel,q.channel];
  return this.db.transaction(()=>{
   const totals=this.db.query<{total:number;orderedQty:number;paidQty:number;shippedQty:number;refundedQty:number;cancelledQty:number;returnedQty:number;exchangeQty:number;paidMinor:number;refundedMinor:number},typeof params>(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN kind='ordered' THEN quantity ELSE 0 END),0) AS orderedQty,COALESCE(SUM(CASE WHEN kind='paid' THEN quantity ELSE 0 END),0) AS paidQty,COALESCE(SUM(CASE WHEN kind='shipped' THEN quantity ELSE 0 END),0) AS shippedQty,COALESCE(SUM(CASE WHEN kind='refunded' THEN quantity ELSE 0 END),0) AS refundedQty,COALESCE(SUM(CASE WHEN kind='cancelled' THEN quantity ELSE 0 END),0) AS cancelledQty,COALESCE(SUM(CASE WHEN kind='returned' THEN quantity ELSE 0 END),0) AS returnedQty,COALESCE(SUM(CASE WHEN kind='ordered' AND replaces_entity IS NOT NULL THEN quantity ELSE 0 END),0) AS exchangeQty,COALESCE(SUM(CASE WHEN kind='paid' THEN amount_minor ELSE 0 END),0) AS paidMinor,COALESCE(SUM(CASE WHEN kind='refunded' THEN amount_minor ELSE 0 END),0) AS refundedMinor FROM transaction_events e WHERE ${where}`).get(...params)!;
   const records=this.db.query<Stored,[...typeof params,number,number]>(`SELECT e.json,e.source,e.batch_id,b.imported_at,b.provenance FROM transaction_events e JOIN transaction_batches b ON b.id=e.batch_id WHERE ${where} ORDER BY e.${clock},e.event_at,e.event_key LIMIT ? OFFSET ?`).all(...params,q.limit,q.offset).map(r=>({event:JSON.parse(r.json) as TransactionEvent,source:r.source,batchId:r.batch_id,importedAt:r.imported_at,...(r.provenance?{provenance:JSON.parse(r.provenance) as EvidenceProvenance}:{})}));
   const {total,...values}=totals;return{records,total,offset:q.offset,limit:q.limit,basis:q.basis,...range,totals:{...values,retainedMinor:values.paidMinor-values.refundedMinor,netPaidQty:values.paidQty-values.refundedQty},limitation:q.basis==='order'?'按原订单归属，包含当前已导入的后续退款；不是历史期末当时已知结果。退款不等于实物退回，结算保留额不等于净利润。':'按事件发生期统计；跨期退款可使本期净件数或保留结算额为负。退款不等于实物退回，结算保留额不等于净利润。'};
  })();
 }
}
