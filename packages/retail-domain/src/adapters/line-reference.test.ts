import {test,expect} from 'bun:test';
import {parseLineReference,compareLines,LINE_REFERENCE_FIELDS} from './line-reference';
import {mapOrders,eventsCsv} from './ingestion';
import {fixtureMapping} from './ingestion-contract';
import {ingestionFixture} from './ingestion-fixture';
import {IngestionStore} from './ingestion-store';
import type {SyncJob} from './sync-contract';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const job:SyncJob={id:crypto.randomUUID(),connectionRevision:1,mode:'fixture',status:'fetched',epoch:1,window:{start:1700000000,end:1700000100,size:100},nextPage:1,received:7,reportedTotal:7,attempts:0,retryAt:null,error:null,createdAt:Date.now(),updatedAt:Date.now()};
const events=mapOrders(ingestionFixture(),fixtureMapping,job).events;
const csv=(list=events)=>LINE_REFERENCE_FIELDS.join(',')+'\n'+list.map(e=>LINE_REFERENCE_FIELDS.map(f=>JSON.stringify(String(e[f]))).join(',')).join('\n');
test('line reconciliation detects equal-total swapped amounts, missing and extra IDs independently',()=>{
 const ref=structuredClone(events);ref[1]!.amount_minor+=1;ref[4]!.amount_minor-=1;ref.pop();ref.push({...events[0]!,event_id:'extra'});
 const parsed=parseLineReference(csv(ref),events[0]!.source_id,'DEMO-SHOP'),r=compareLines(events,parsed.events);expect(r.changed).toBe(2);expect(r.referenceOnly).toBe(1);expect(r.batchOnly).toBe(1);expect(r.issues.find(i=>i.type==='changed')?.fields).toContain('amount_minor');
 expect(compareLines(events,parseLineReference(csv(),events[0]!.source_id,'DEMO-SHOP').events).matched).toBe(22);
});
test('file validation rejects unsupported columns, wrong shop, ambiguous duplicates and invalid units; exact duplicates are counted',()=>{
 expect(()=>parseLineReference(eventsCsv(events),'s','DEMO-SHOP')).toThrow('模板');expect(()=>parseLineReference(csv(),'s','other')).toThrow('店铺');
 const duplicate=[...events,{...events[0]!,quantity:2}];expect(()=>parseLineReference(csv(duplicate),'s','DEMO-SHOP')).toThrow('冲突');
 expect(parseLineReference(csv([...events,events[0]!]),'s','DEMO-SHOP').duplicates).toBe(1);
 expect(()=>parseLineReference(csv([{...events[0]!,amount_minor:100.001}]),'s','DEMO-SHOP')).toThrow('无效');
});
test('file references persist separately from aggregate references and never import reference-only events',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-lines-')),s=new IngestionStore(join(dir,'ledger.sqlite'));try{s.saveMapping(0,fixtureMapping);const p=s.preview(job,ingestionFixture(),'a'.repeat(64)).previews[0]!;const r=s.confirm(p.id,p.reviewHash,'a'.repeat(64)).receipts[0]!;
 const reference={label:'独立合成文件',observedAt:new Date().toISOString(),csv:csv()};let v=s.reconcile(r.id,undefined,reference);expect(v.reconciliations[0]).toMatchObject({status:'matched',reference:'operator_file',lineReference:{matched:22}});
 v=s.reconcile(r.id,undefined,{...reference,csv:csv([...events,{...events[0]!,event_id:'reference-only'}])});expect(v.reconciliations[0]).toMatchObject({status:'mismatch',lineReference:{referenceOnly:1}});expect(s.preview({...job,id:crypto.randomUUID()},ingestionFixture(),'b'.repeat(64)).previews[0]?.duplicateEvents).toBe(22);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
