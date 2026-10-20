import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Database} from 'bun:sqlite';import {createHash} from 'node:crypto';
import {TransactionStore} from './transaction-store';import {TRANSACTION_DEMO,TRANSACTION_FIELDS,TransactionEventSchema,decodeTransactionCsv,transactionWindow} from './transactions';import type {TransactionQuery,TransactionEvent} from './transactions';import {RetailRequestSchema} from './operations';
import {spawnSync} from 'node:child_process';
import {TRANSACTION_OPTIONAL_FIELDS,TRANSACTION_EXCHANGE_DEMO} from './transactions';
const query=(overrides:Partial<TransactionQuery>={}):TransactionQuery=>({source:'demo',startDate:'2026-10-14',endDate:'2026-10-16',basis:'event',shop:'',channel:'',offset:0,limit:30,...overrides});
const csv=(events:TransactionEvent[])=>TRANSACTION_FIELDS.join(',')+'\n'+events.map(e=>TRANSACTION_FIELDS.map(f=>e[f]).join(',')).join('\n');
const exchangeCsv=(events:TransactionEvent[])=>[[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS].join(','),...events.map(e=>[...TRANSACTION_FIELDS,...TRANSACTION_OPTIONAL_FIELDS].map(f=>e[f]??'').join(','))].join('\n');
test('actual data-worker imports and queries both date bases through strict IPC schemas',()=>{const dir=mkdtempSync(join(tmpdir(),'merqo-transaction-worker-'));try{const call=(input:unknown)=>{const r=spawnSync(process.execPath,['scripts/retailpilot-data-worker.ts',join(dir,'operations.sqlite'),'worker','test','local-analyst'],{cwd:process.cwd(),input:JSON.stringify(input),encoding:'utf8',windowsHide:true});const reply=JSON.parse(r.stdout);expect(reply.ok).toBe(true);return reply;};const preview=call({op:'transactions_preview',csv:TRANSACTION_DEMO});call({op:'transactions_import',csv:TRANSACTION_DEMO,previewHash:preview.data.hash});const result=call({op:'transactions_page',...query({source:'csv',endDate:'2026-10-14',basis:'order'})});expect(result.kind).toBe('transactions');expect(result.data.totals.retainedMinor).toBe(8500);expect(call({op:'transactions_page',...query({source:'csv',startDate:'2026-10-16'})}).data.totals.retainedMinor).toBe(-8500);}finally{rmSync(dir,{recursive:true,force:true});}});
function fixture(){const dir=mkdtempSync(join(tmpdir(),'merqo-transactions-')),file=join(dir,'transactions.sqlite'),store=new TransactionStore(file);return{dir,file,store,close(){store.close();rmSync(dir,{recursive:true,force:true});}};}

test('explicit replacement consumes returned units once, loads old lines and siblings across batches and persists after reopening',()=>{
 const f=fixture();try{
  const events=decodeTransactionCsv(TRANSACTION_EXCHANGE_DEMO).events,original=exchangeCsv(events.slice(0,-1)),p=f.store.preview(original);expect(p.canImport).toBe(true);f.store.import(original,p.hash);
  const replacement=events.at(-1)!,text=exchangeCsv([replacement]),rp=f.store.preview(text);expect(rp.canImport).toBe(true);f.store.import(text,rp.hash);
  expect(f.store.page(query({source:'csv'})).totals).toMatchObject({exchangeQty:1,returnedQty:1,paidQty:2,paidMinor:17000,retainedMinor:8500});
  const reopened=new TransactionStore(f.file);try{expect(reopened.page(query({source:'csv'})).records.some(r=>r.event.replaces_order_id==='O1')).toBe(true);}finally{reopened.close();}
  const sibling=exchangeCsv([{...replacement,order_id:'EXCHANGE-SECOND',event_id:'EXCHANGE-SECOND'}]);const sp=f.store.preview(sibling);expect(sp.canImport).toBe(false);expect(()=>f.store.import(sibling,sp.hash)).toThrow('未关联');
  const early=exchangeCsv([{...replacement,order_id:'early',event_id:'early',order_at:'2026-10-16T07:00:00+08:00',event_at:'2026-10-16T07:00:00+08:00'}]);expect(f.store.preview(early).canImport).toBe(false);
  const lateReturn=exchangeCsv([{...events.find(e=>e.kind==='returned')!,event_id:'extra-return'}]);expect(f.store.preview(lateReturn).canImport).toBe(false);
  expect(f.store.page(query({source:'csv'})).total).toBe(8);
 }finally{f.close();}
});

test('replacement links reject missing scopes, self cycles, incomplete declarations and financial shortcuts',()=>{
 const f=fixture();try{
  const events=decodeTransactionCsv(TRANSACTION_EXCHANGE_DEMO).events,replacement=events.at(-1)!;
  for(const patch of [{replaces_order_id:'missing'},{source_id:'other-source'},{shop_id:'other-shop'},{quantity:2},{replaces_order_id:replacement.order_id}])expect(f.store.preview(exchangeCsv([...events.slice(0,-1),{...replacement,...patch}])).canImport).toBe(false);
  expect(TransactionEventSchema.safeParse({...replacement,replaces_line_id:undefined}).success).toBe(false);
  expect(TransactionEventSchema.safeParse({...replacement,kind:'paid'}).success).toBe(false);
  expect(f.store.preview(exchangeCsv([replacement])).canImport).toBe(false);
 }finally{f.close();}
});

function installments(){
 const [order,paid,shipped,refund]=decodeTransactionCsv(TRANSACTION_DEMO).events;
 return [order!,{...paid!,quantity:0,amount_minor:4000,allocated_discount_minor:0,platform_subsidy_minor:0},
 {...paid!,event_id:'balance',event_at:'2026-10-15T10:00:00+08:00',amount_minor:13000},
 {...shipped!,event_at:'2026-10-15T12:00:00+08:00'},refund!];
}

test('installments import incrementally, count paid units only on settlement and retain both date bases after restart',()=>{
 const f=fixture();try{
  const events=installments(),deposit=csv(events.slice(0,2)),p=f.store.preview(deposit);
  expect(p.canImport).toBe(true);f.store.import(deposit,p.hash);
  expect(f.store.page(query({source:'csv',endDate:'2026-10-14'})).totals).toMatchObject({paidQty:0,paidMinor:4000,retainedMinor:4000});
  const rest=csv(events.slice(2)),rp=f.store.preview(rest);expect(rp.canImport).toBe(true);expect(f.store.import(rest,rp.hash).accepted).toBe(3);
  expect(f.store.import(rest,rp.hash).accepted).toBe(0);
  expect(f.store.page(query({source:'csv',startDate:'2026-10-15',endDate:'2026-10-15'})).totals).toMatchObject({paidQty:2,paidMinor:13000,shippedQty:2});
  const all=f.store.page(query({source:'csv',basis:'order',endDate:'2026-10-14'}));
  expect(all.totals).toMatchObject({paidQty:2,paidMinor:17000,refundedMinor:8500,retainedMinor:8500});
  const reopened=new TransactionStore(f.file);try{expect(reopened.page(query({source:'csv',basis:'order',endDate:'2026-10-14'}))).toEqual(all);}finally{reopened.close();}
 }finally{f.close();}
});

test('unsettled full cancellation records cash refunds explicitly and cannot reopen fulfillment',()=>{
 const f=fixture();try{
  const events=installments(),cancel={...events[0]!,event_id:'cancel',kind:'cancelled' as const,event_at:'2026-10-14T11:00:00+08:00',amount_minor:0};
  const refund={...events[4]!,quantity:0,amount_minor:4000};
  const text=csv([...events.slice(0,2),cancel,refund]),p=f.store.preview(text);
  expect(p.canImport).toBe(true);f.store.import(text,p.hash);
  expect(f.store.page(query({source:'csv'})).totals).toMatchObject({paidQty:0,paidMinor:4000,cancelledQty:2,returnedQty:0,refundedMinor:4000,retainedMinor:0});
  const next=csv([events[2]!]);expect(f.store.preview(next).canImport).toBe(false);
  expect(()=>f.store.import(next,f.store.preview(next).hash)).toThrow('已取消');
  expect(f.store.page(query({source:'csv'})).total).toBe(4);
 }finally{f.close();}
});

test('paid partial cancellation and physical returns remain separate from financial refunds and stock',()=>{
 const f=fixture();try{
  const events=decodeTransactionCsv(TRANSACTION_DEMO).events;
  const cancel={...events[2]!,kind:'cancelled' as const,event_id:'cancel',quantity:1,event_at:'2026-10-14T11:00:00+08:00'};
  const returned={...events[2]!,kind:'returned' as const,event_id:'return',quantity:1,event_at:'2026-10-15T11:00:00+08:00'};
  const text=csv([events[0]!,events[1]!,cancel,{...events[2]!,quantity:1},returned,events[3]!]),p=f.store.preview(text);
  expect(p.canImport).toBe(true);f.store.import(text,p.hash);
  expect(f.store.page(query({source:'csv',endDate:'2026-10-15'})).totals).toMatchObject({paidQty:2,shippedQty:1,cancelledQty:1,returnedQty:1,refundedQty:0,refundedMinor:0,retainedMinor:17000});
  expect(f.store.page(query({source:'csv'})).totals).toMatchObject({refundedQty:1,returnedQty:1,refundedMinor:8500});
 }finally{f.close();}
});

test('payment, cancellation and return prefixes reject impossible cash or fulfillment atomically',()=>{
 const f=fixture();try{
  const events=installments();
  const cases:TransactionEvent[][]=[
   [events[0]!,{...events[1]!,quantity:2}],
   [events[0]!,events[1]!,{...events[2]!,quantity:0}],
   [events[0]!,events[1]!,{...events[2]!,amount_minor:13001}],
   [events[0]!,{...events[1]!,platform_subsidy_minor:4001}],
   [events[0]!,events[1]!,{...events[2]!,event_at:events[1]!.event_at}],
   [...events,{...events[2]!,event_id:'paid-again',event_at:'2026-10-17T00:00:00+08:00'}],
   [events[0]!,events[1]!,{...events[3]!,event_at:'2026-10-14T12:00:00+08:00'}],
   [events[0]!,events[1]!,{...events[4]!,quantity:0,amount_minor:4001,event_at:'2026-10-14T12:00:00+08:00'}],
   [events[0]!,events[1]!,{...events[3]!,kind:'cancelled',quantity:1}],
   [...events,{...events[3]!,kind:'cancelled',quantity:1,event_id:'cancel'}],
   [...events,{...events[3]!,kind:'returned',event_at:'2026-10-15T11:00:00+08:00',event_id:'return'}],
   [...events,{...events[3]!,kind:'returned',quantity:3,event_id:'return'}],
  ];
  for(const chain of cases){const text=csv(chain),p=f.store.preview(text);expect(p.canImport).toBe(false);expect(()=>f.store.import(text,p.hash)).toThrow();}
  expect(f.store.page(query({source:'csv'})).total).toBe(0);
  expect(TransactionEventSchema.safeParse({...events[1],quantity:0,amount_minor:0}).success).toBe(false);
  expect(TransactionEventSchema.safeParse({...events[3],kind:'cancelled',amount_minor:1}).success).toBe(false);
 }finally{f.close();}
});
test('cross-period refund has independent event and original-order views, exact midnight boundaries and negative event-period totals',()=>{
 const f=fixture();try{f.store.demo();const paid=f.store.page(query({endDate:'2026-10-14'}));expect(paid.totals).toEqual({orderedQty:2,paidQty:2,shippedQty:2,refundedQty:0,cancelledQty:0,returnedQty:0,exchangeQty:0,paidMinor:17000,refundedMinor:0,retainedMinor:17000,netPaidQty:2});
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
test('event contracts reject guessed allocation, time inversion, overshipment, duplicate settlement, malformed rows and cross-spec identity',()=>{
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
