import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Database} from 'bun:sqlite';import {createHash} from 'node:crypto';
import {TransactionStore} from './transaction-store';import {TRANSACTION_DEMO,TRANSACTION_FIELDS,TransactionEventSchema,decodeTransactionCsv,transactionWindow} from './transactions';import type {TransactionQuery,TransactionEvent} from './transactions';import {RetailRequestSchema} from './operations';
import {spawnSync} from 'node:child_process';
const query=(overrides:Partial<TransactionQuery>={}):TransactionQuery=>({source:'demo',startDate:'2026-10-14',endDate:'2026-10-16',basis:'event',shop:'',channel:'',offset:0,limit:30,...overrides});
const csv=(events:TransactionEvent[])=>TRANSACTION_FIELDS.join(',')+'\n'+events.map(e=>TRANSACTION_FIELDS.map(f=>e[f]).join(',')).join('\n');
test('actual data-worker imports and queries both date bases through strict IPC schemas',()=>{const dir=mkdtempSync(join(tmpdir(),'merqo-transaction-worker-'));try{const call=(input:unknown)=>{const r=spawnSync(process.execPath,['scripts/retailpilot-data-worker.ts',join(dir,'operations.sqlite'),'worker','test','local-analyst'],{cwd:process.cwd(),input:JSON.stringify(input),encoding:'utf8',windowsHide:true});const reply=JSON.parse(r.stdout);expect(reply.ok).toBe(true);return reply;};const preview=call({op:'transactions_preview',csv:TRANSACTION_DEMO});call({op:'transactions_import',csv:TRANSACTION_DEMO,previewHash:preview.data.hash});const result=call({op:'transactions_page',...query({source:'csv',endDate:'2026-10-14',basis:'order'})});expect(result.kind).toBe('transactions');expect(result.data.totals.retainedMinor).toBe(8500);expect(call({op:'transactions_page',...query({source:'csv',startDate:'2026-10-16'})}).data.totals.retainedMinor).toBe(-8500);}finally{rmSync(dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'merqo-transactions-')),file=join(dir,'transactions.sqlite'),store=new TransactionStore(file);return{dir,file,store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}
test('cross-period refund has independent event and original-order views, exact midnight boundaries and negative event-period totals',()=>{
 const f=fixture();try{f.store.demo();const paid=f.store.page(query({endDate:'2026-10-14'}));expect(paid.totals).toEqual({orderedQty:2,paidQty:2,shippedQty:2,refundedQty:0,paidMinor:17000,refundedMinor:0,retainedMinor:17000,netPaidQty:2});
 const refund=f.store.page(query({startDate:'2026-10-16',endDate:'2026-10-16'}));expect(refund.totals.refundedQty).toBe(1);expect(refund.totals.retainedMinor).toBe(-8500);expect(refund.totals.netPaidQty).toBe(-1);
 const cohort=f.store.page(query({basis:'order',endDate:'2026-10-14'}));expect(cohort.totals.retainedMinor).toBe(8500);expect(cohort.total).toBe(4);expect(cohort.limitation).toContain('不是历史期末');expect(f.store.page(query({startDate:'2026-10-16',basis:'order'})).total).toBe(0);
 expect(transactionWindow('2026-10-14','2026-10-14')).toEqual({startInclusive:'2026-10-14T00:00:00+08:00',endExclusive:'2026-10-15T00:00:00+08:00'});
 const all=decodeTransactionCsv(TRANSACTION_DEMO).events;all[0]={...all[0]!,event_at:'2026-10-14T00:00:00+08:00',order_at:'2026-10-14T00:00:00+08:00'};
 const midnight=all.map(e=>({...e,source_id:'midnight',order_at:'2026-10-14T00:00:00+08:00'}));midnight[3]={...midnight[3]!,event_at:'2026-10-15T00:00:00+08:00'};const text=csv(midnight),p=f.store.preview(text);f.store.import(text,p.hash);expect(f.store.page(query({source:'csv',endDate:'2026-10-14'})).totals.refundedMinor).toBe(0);expect(f.store.page(query({source:'csv',startDate:'2026-10-15',endDate:'2026-10-15'})).totals.refundedMinor).toBe(8500);
 }finally{f.close();}
});
test('partial imports resolve original chains; identical events are idempotent and conflicting, orphan or excessive refunds roll back atomically',()=>{
 const f=fixture();try{const events=decodeTransactionCsv(TRANSACTION_DEMO).events;const first=csv(events.slice(0,3));const p=f.store.preview(first);expect(p.canImport).toBe(true);expect(f.store.import(first,p.hash).accepted).toBe(3);
 const rest=csv(events.slice(3)),rp=f.store.preview(rest);expect(rp.canImport).toBe(true);expect(f.store.import(rest,rp.hash).accepted).toBe(1);expect(f.store.import(rest,rp.hash).accepted).toBe(0);expect(f.store.page(query({source:'csv'})).total).toBe(4);
 const conflict=csv([{...events[3]!,amount_minor:8501}]);expect(f.store.preview(conflict).canImport).toBe(false);expect(()=>f.store.import(conflict,createHash('sha256').update(conflict).digest('hex'))).toThrow('冲突');
 const excess=csv([{...events[3]!,event_id:'refund-second',amount_minor:10000}]);const ep=f.store.preview(excess);expect(ep.canImport).toBe(false);expect(()=>f.store.import(excess,ep.hash)).toThrow('累计退款');expect(f.store.page(query({source:'csv'})).total).toBe(4);
 const orphan=csv([{...events[3]!,order_id:'missing',event_id:'orphan'}]);expect(f.store.preview(orphan).errors.some(e=>e.reason.includes('下单'))).toBe(true);
 expect(()=>f.store.import(rest,'0'.repeat(64))).toThrow('预览摘要');
 }finally{f.close();}
});
test('event contracts reject guessed allocation, time inversion, overshipment, split payments, malformed rows and cross-spec identity',()=>{
 const f=fixture();try{const events=decodeTransactionCsv(TRANSACTION_DEMO).events;
 for(const mutate of [
  (e:TransactionEvent[])=>{e[1]={...e[1]!,allocated_discount_minor:1};},
  (e:TransactionEvent[])=>{e[2]={...e[2]!,quantity:3};},
  (e:TransactionEvent[])=>{e[3]={...e[3]!,spec:'不同规格'};},
  (e:TransactionEvent[])=>{e[3]={...e[3]!,event_at:'2026-10-14T10:00:30+08:00'};},
  (e:TransactionEvent[])=>{e.push({...e[1]!,event_id:'second-payment'});},
 ]){const cloned=structuredClone(events);mutate(cloned);expect(f.store.preview(csv(cloned)).canImport).toBe(false);}
 expect(TransactionEventSchema.safeParse({...events[0],quantity:1.5}).success).toBe(false);expect(TransactionEventSchema.safeParse({...events[2],amount_minor:1}).success).toBe(false);
 const priceOnly=[...events,{...events[3]!,event_id:'price-only',quantity:0,amount_minor:100}];expect(f.store.preview(csv(priceOnly)).canImport).toBe(true);
 expect(f.store.preview(TRANSACTION_DEMO.replace('amount_minor','unsupported')).canImport).toBe(false);
 expect(RetailRequestSchema.safeParse({op:'transactions_page',...query(),startDate:'2026-02-30'}).success).toBe(false);
 expect(RetailRequestSchema.safeParse({op:'transactions_import',csv:TRANSACTION_DEMO,previewHash:'0'.repeat(64),actor:'admin'}).success).toBe(false);
 }finally{f.close();}
});
test('immutable ledger, provenance, workspace isolation and bounded indexed pagination survive reopening',()=>{
 const f=fixture();try{const p=f.store.preview(TRANSACTION_DEMO);f.store.import(TRANSACTION_DEMO,p.hash,'csv',{sourceId:'demo-transactions',sourceName:'CSV 声明',sourceObservedAt:'2026-10-17T00:00:00+08:00',coverageStartInclusive:'2026-10-14T00:00:00+08:00',completeThroughExclusive:'2026-10-17T00:00:00+08:00',completeness:'complete',timezone:'Asia/Shanghai'});
 const page=f.store.page(query({source:'csv',offset:1,limit:2}));expect(page.records).toHaveLength(2);expect(page.total).toBe(4);expect(page.totals.retainedMinor).toBe(8500);expect(page.records[0]?.provenance?.identityAssurance).toBe('unverified_declaration');expect(f.store.page(query({source:'csv',shop:'other'})).total).toBe(0);
 const db=new Database(f.file);try{expect(()=>db.exec('DELETE FROM transaction_events')).toThrow('immutable');expect(()=>db.exec("UPDATE transaction_batches SET hash='tamper'")).toThrow('immutable');const plan=db.query('EXPLAIN QUERY PLAN SELECT event_key FROM transaction_events WHERE source=? AND event_at>=? AND event_at<?').all('csv',0,Date.now());expect(JSON.stringify(plan)).toContain('transaction_event_time');}finally{db.close();}
 const reopened=new TransactionStore(f.file);try{expect(reopened.page(query({source:'csv'})).records[0]?.provenance?.sourceId).toBe('demo-transactions');}finally{reopened.close();}
 const other=new TransactionStore(join(f.dir,'other.sqlite'));try{expect(other.page(query({source:'csv'})).total).toBe(0);}finally{other.close();}
 }finally{f.close();}
});
