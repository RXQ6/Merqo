import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {IngestionStore} from './ingestion-store';
import {fixtureMapping,MappingProfileSchema,StatementSchema} from './ingestion-contract';
import {mapOrders,inspectOrderFields,eventsCsv} from './ingestion';
import {ingestionFixture,fixtureControlTotals} from './ingestion-fixture';
import {TransactionStore} from '../transaction-store';
import type {SyncJob} from './sync-contract';
import {RetailRequestSchema} from '../operations';
function job(mode:'fixture'|'live'='fixture'):SyncJob{return{id:crypto.randomUUID(),connectionRevision:1,mode,status:'fetched',epoch:10,window:{start:1700000000,end:1700000100,size:2},nextPage:4,received:7,reportedTotal:7,attempts:0,retryAt:null,error:null,createdAt:Date.now(),updatedAt:Date.now(),scope:{shopId:'DEMO-SHOP',appKey:'declared-app'}};}
function setup(mode:'fixture'|'live'='fixture'){const dir=mkdtempSync(join(tmpdir(),'merqo-ingest-')),file=join(dir,'ledger.sqlite'),store=new IngestionStore(file);store.saveMapping(0,{...fixtureMapping,mode});return{dir,file,store,cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};}

test('duplicate source records are counted consistently in preview and receipt without duplicating events',()=>{
 const f=setup();try{
  const rows=ingestionFixture();rows.push(structuredClone(rows[0]!));const j={...job(),received:8};
  const p=f.store.preview(j,rows,'e'.repeat(64)).previews[0]!;
  expect(p).toMatchObject({newEvents:22,duplicateEvents:3,quarantinedRecords:0});
  const result=f.store.confirm(p.id,p.reviewHash,'e'.repeat(64));
  expect(result.receipts[0]).toMatchObject({accepted:22,duplicates:3});
  expect(f.store.reconcile(result.receipts[0]!.id).reconciliations[0]?.status).toBe('matched');
 }finally{f.cleanup();}
});

test('receipt failure rolls back both imported events and transaction batch; the same review can safely retry',()=>{
 const f=setup(),db=new Database(f.file);try{
  const p=f.store.preview(job(),ingestionFixture(),'f'.repeat(64)).previews[0]!;
  db.exec("CREATE TRIGGER reject_test_receipt BEFORE INSERT ON ingest_receipts BEGIN SELECT RAISE(ABORT,'receipt fault');END;");
  expect(()=>f.store.confirm(p.id,p.reviewHash,'f'.repeat(64))).toThrow('receipt fault');
  expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM transaction_events').get()!.n).toBe(0);
  expect(db.query<{n:number},[]>('SELECT COUNT(*) AS n FROM transaction_batches').get()!.n).toBe(0);
  expect(f.store.view().receipts).toHaveLength(0);
  db.exec('DROP TRIGGER reject_test_receipt');
  expect(f.store.confirm(p.id,p.reviewHash,'f'.repeat(64)).receipts[0]?.accepted).toBe(22);
 }finally{db.close();f.cleanup();}
});
test('reviewed import is atomic and idempotent, restart preserves receipts and independent fixture totals reconcile',()=>{
 const f=setup();try{
  const j=job(),preview=f.store.preview(j,ingestionFixture(),'a'.repeat(64)).previews[0]!;
  expect(preview).toMatchObject({newEvents:22,duplicateEvents:0,quarantinedRecords:0,canConfirm:true});
  expect(()=>f.store.confirm(preview.id,'b'.repeat(64),'a'.repeat(64))).toThrow('摘要');
  let result=f.store.confirm(preview.id,preview.reviewHash,'a'.repeat(64));expect(result.receipts[0]?.accepted).toBe(22);
  result=f.store.confirm(preview.id,preview.reviewHash,'a'.repeat(64));expect(result.receipts).toHaveLength(1);
  const second=new IngestionStore(f.file);try{expect(second.view().receipts[0]?.id).toBe(result.receipts[0]?.id);expect(second.reconcile(result.receipts[0]!.id).reconciliations[0]).toMatchObject({status:'matched',reference:'synthetic_control',ledgerIssues:0});}finally{second.close();}
  const repeat=f.store.preview(job(),ingestionFixture(),'c'.repeat(64)).previews[0]!;expect(repeat).toMatchObject({newEvents:0,duplicateEvents:22,canConfirm:true});
  expect(f.store.confirm(repeat.id,repeat.reviewHash,'c'.repeat(64)).receipts[0]?.accepted).toBe(0);
 }finally{f.cleanup();}
});
test('quality failures quarantine complete records; partial confirmation is explicit and later corrected batch imports only missing events',()=>{
 const f=setup();try{
  const preview=f.store.preview(job(),ingestionFixture(true),'a'.repeat(64)).previews[0]!;expect(preview).toMatchObject({quarantinedRecords:2,newEvents:16,canConfirm:true});
  expect(()=>f.store.confirm(preview.id,preview.reviewHash,'a'.repeat(64))).toThrow('部分入库');
  const result=f.store.confirm(preview.id,preview.reviewHash,'a'.repeat(64),true,'确认仅导入已校验记录并保留隔离数据');
  const diff=f.store.reconcile(result.receipts[0]!.id).reconciliations[0]!;expect(diff.status).toBe('mismatch');expect(diff.differences.some(d=>d.field==='eventCount'&&d.expected===22&&d.actual===16)).toBe(true);
  const corrected=f.store.preview(job(),ingestionFixture(),'b'.repeat(64)).previews[0]!;expect(corrected).toMatchObject({newEvents:6,duplicateEvents:16,quarantinedRecords:0});
  const receipt=f.store.confirm(corrected.id,corrected.reviewHash,'b'.repeat(64)).receipts[0]!;expect(receipt.accepted).toBe(6);expect(f.store.reconcile(receipt.id).reconciliations[0]?.status).toBe('matched');
 }finally{f.cleanup();}
});
test('mapping, staging or ledger changes invalidate an unconfirmed preview; conflicts never overwrite immutable events',()=>{
 const f=setup();try{
  const p=f.store.preview(job(),ingestionFixture(),'a'.repeat(64)).previews[0]!;
  expect(()=>f.store.confirm(p.id,p.reviewHash,'b'.repeat(64))).toThrow('暂存');
  f.store.saveMapping(1,{...fixtureMapping,name:'v2'});expect(()=>f.store.confirm(p.id,p.reviewHash,'a'.repeat(64))).toThrow('规则');
  const fresh=f.store.preview(job(),ingestionFixture(),'a'.repeat(64)).previews[0]!;
  const external=new TransactionStore(f.file);try{const events=mapOrders(ingestionFixture().slice(0,1),fixtureMapping,job()).events,csv=eventsCsv(events);external.import(csv,digestCsv(csv),'demo');}finally{external.close();}
  expect(()=>f.store.confirm(fresh.id,fresh.reviewHash,'a'.repeat(64))).toThrow('账本');
  const raw=ingestionFixture();(raw[0]!.events as Array<Record<string,unknown>>)[1]!.amount_minor=9000;(raw[0]!.events as Array<Record<string,unknown>>)[1]!.allocated_discount_minor=1000;
  const conflicting=f.store.preview(job(),raw,'c'.repeat(64)).previews[0]!;expect(conflicting.conflictEvents).toBe(1);expect(conflicting.canConfirm).toBe(false);expect(()=>f.store.confirm(conflicting.id,conflicting.reviewHash,'c'.repeat(64))).toThrow('不能入库');
 }finally{f.cleanup();}
});
import {createHash} from 'node:crypto';
const digestCsv=(s:string)=>createHash('sha256').update(s).digest('hex');
test('live-shaped mapping remains operator-declared, needs a separate reference and cannot claim authenticated platform reconciliation',()=>{
 const f=setup('live');try{
  const j=job('live'),p=f.store.preview(j,ingestionFixture(),'a'.repeat(64)).previews[0]!,r=f.store.confirm(p.id,p.reviewHash,'a'.repeat(64)).receipts[0]!;
  expect(r.source).toBe('csv');expect(f.store.reconcile(r.id).reconciliations[0]).toMatchObject({status:'unverified',reference:'missing'});
  const statement={label:'人工录入同批次控制总额',shopId:'DEMO-SHOP',currency:'CNY' as const,basis:'batch_event_set' as const,observedAt:new Date().toISOString(),totals:fixtureControlTotals};
  expect(f.store.reconcile(r.id,statement).reconciliations[0]).toMatchObject({status:'matched',reference:'operator_declared'});
  expect(()=>f.store.reconcile(r.id,{...statement,shopId:'other'})).toThrow('店铺');
  const ledger=new TransactionStore(f.file);try{const data=ledger.page({source:'csv',startDate:'2026-10-14',endDate:'2026-10-16',basis:'event',shop:'',channel:'',offset:0,limit:30});expect(data.total).toBe(22);expect(data.records[0]?.provenance).toMatchObject({origin:'operator_declared',identityAssurance:'unverified_declaration',completeness:'partial'});}finally{ledger.close();}
 }finally{f.cleanup();}
});
test('mapping does not infer events, units or unsafe IDs; field discovery never returns raw personal values',()=>{
 const rows=ingestionFixture();rows[0]!.buyer={phone:'private-phone-value'};
 const fields=inspectOrderFields(rows,'events');expect(fields.arrays).toContain('events');expect(fields.fields).toContain('event_id');expect(JSON.stringify(fields)).not.toContain('private-phone-value');
 expect(mapOrders([{order_status:'paid',pay_amount:10000}],fixtureMapping,{...job(),received:1}).events).toHaveLength(0);
 const unsafe=ingestionFixture();(unsafe[0]!.events as Array<Record<string,unknown>>)[0]!.order_id=Number.MAX_SAFE_INTEGER+1;expect(mapOrders(unsafe,fixtureMapping,job()).quarantine.length).toBeGreaterThan(0);
 const decimal=ingestionFixture();for(const row of decimal)for(const e of row.events as Array<Record<string,unknown>>)for(const key of['amount_minor','allocated_discount_minor','platform_subsidy_minor'])e[key]=String(Number(e[key])/100);
 expect(mapOrders(decimal,{...fixtureMapping,moneyUnit:'yuan_decimal'},job()).events[0]?.amount_minor).toBe(10000);
 expect(MappingProfileSchema.safeParse({...fixtureMapping,fields:{...fixtureMapping.fields,event_id:'__proto__.key'}}).success).toBe(false);
 expect(()=>mapOrders(rows,{...fixtureMapping,mode:'live'},job())).toThrow('模式');
 expect(StatementSchema.safeParse({totals:fixtureControlTotals}).success).toBe(false);
 for(const op of['ingest_store_confirm','sync_store_staging'])expect(RetailRequestSchema.safeParse({op,previewId:crypto.randomUUID(),id:crypto.randomUUID()}).success).toBe(false);
});
