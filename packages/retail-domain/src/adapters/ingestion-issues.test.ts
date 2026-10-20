import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {IngestionStore} from './ingestion-store';import {ingestionRequest} from './ingestion-worker';import {fixtureMapping} from './ingestion-contract';import {ingestionFixture} from './ingestion-fixture';import type {SyncJob} from './sync-contract';
const job=():SyncJob=>({id:crypto.randomUUID(),connectionRevision:1,mode:'fixture',status:'fetched',epoch:1,window:{start:1700000000,end:1700000100,size:100},nextPage:1,received:7,reportedTotal:7,attempts:0,retryAt:null,error:null,createdAt:Date.now(),updatedAt:Date.now()});
test('quarantine queue retains append-only reviews, rejects stale changes and links only later clean same-source receipts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-issues-')),file=join(dir,'ledger.sqlite'),s=new IngestionStore(file);try{s.saveMapping(0,fixtureMapping);const old=s.preview(job(),ingestionFixture(true),'a'.repeat(64)).previews[0]!;expect(s.issues().total).toBe(1);expect(s.issues().cases[0]?.review).toBeNull();
 let r=s.reviewIssue({previewId:old.id,expectedReviewId:null,action:'needs_source',reason:'等待来源重新提供准确金额及规格信息'}).cases[0]!.review!;expect(r.authority).toBe('local_operator');expect(()=>s.reviewIssue({previewId:old.id,expectedReviewId:null,action:'mapping_reviewed',reason:'检查映射已完成并等待后续验证数据'})).toThrow('已变化');
 const badReceipt=s.confirm(old.id,old.reviewHash,'a'.repeat(64),true,'确认保留来源错误并先导入有效记录').receipts[0]!;expect(()=>s.reviewIssue({previewId:old.id,expectedReviewId:r.id,action:'reprocess_linked',reason:'关联后续处理结果并保留原始隔离信息',receiptId:badReceipt.id})).toThrow('新入库回执');
 const fresh=s.preview(job(),ingestionFixture(),'b'.repeat(64)).previews[0]!,clean=s.confirm(fresh.id,fresh.reviewHash,'b'.repeat(64)).receipts[0]!;
 r=s.reviewIssue({previewId:old.id,expectedReviewId:r.id,action:'reprocess_linked',reason:'人工核对修正后记录并关联新的入库回执',receiptId:clean.id}).cases[0]!.review!;expect(r.receiptId).toBe(clean.id);expect(s.issues().cases[0]?.quarantinedRecords).toBe(2);
 const worker=ingestionRequest(file,{op:'ingest_store_issue_review',previewId:old.id,expectedReviewId:r.id,action:'mapping_reviewed',reason:'继续保留原问题并再次检查映射口径和结果'});expect('cases'in worker&&worker.cases[0]?.review?.action).toBe('mapping_reviewed');
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
