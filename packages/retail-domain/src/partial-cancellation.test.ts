import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {TransactionStore} from './transaction-store';
import {decodeTransactionCsv,validateTransactionChains,TRANSACTION_PARTIAL_CANCEL_DEMO,TRANSACTION_FIELDS,TRANSACTION_OPTIONAL_FIELDS,type TransactionEvent} from './transactions';
import {eventsCsv,mapOrders} from './adapters/ingestion';import {fixtureMapping} from './adapters/ingestion-contract';import type {SyncJob} from './adapters/sync-contract';
import {parseLineReference,compareLines} from './adapters/line-reference';
const events=decodeTransactionCsv(TRANSACTION_PARTIAL_CANCEL_DEMO).events;
const query={source:'csv' as const,basis:'order' as const,startDate:'2026-10-14',endDate:'2026-10-14',shop:'',channel:'',offset:0,limit:30};
test('explicit uneven-price partial cancellation survives split imports, idempotency and restart; does not invent refund or stock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-partial-cancel-')),file=join(dir,'ledger.sqlite'),s=new TransactionStore(file);try{
  for(const group of [events.slice(0,3),events.slice(3)]){const text=eventsCsv(group),p=s.preview(text);expect(p.canImport).toBe(true);s.import(text,p.hash);}
  const all=eventsCsv(events);expect(s.import(all,s.preview(all).hash).accepted).toBe(0);
  expect(s.page(query).totals).toMatchObject({orderedQty:3,cancelledQty:1,paidQty:2,shippedQty:2,paidMinor:6668,refundedMinor:0,returnedQty:0,retainedMinor:6668});
  const other=new TransactionStore(file);try{expect(other.page(query).records.find(r=>r.event.kind==='cancelled')?.event.cancelled_basis_minor).toBe(3333);}finally{other.close();}
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancellation rejects absent guessed basis, excess, incompatible deposit, non-cancellation fields and invalid final quantities',()=>{
 const check=(list:TransactionEvent[])=>validateTransactionChains(list).length;
 const cancel=events[2]!,order=events[0]!,deposit=events[1]!,paid=events[3]!;
 expect(check([order,deposit,{...cancel,cancelled_basis_minor:undefined}])).toBeGreaterThan(0);
 expect(check([order,deposit,{...cancel,cancelled_basis_minor:9000}])).toBeGreaterThan(0);
 expect(check([order,deposit,{...cancel,quantity:4}])).toBeGreaterThan(0);
 expect(check([order,deposit,{...cancel,quantity:3,cancelled_basis_minor:3333}])).toBeGreaterThan(0);
 expect(check([order,deposit,cancel,{...paid,quantity:3}])).toBeGreaterThan(0);
 expect(check([...events,{...cancel,event_id:'POST',event_at:'2026-10-15T00:00:00+08:00'}])).toBeGreaterThan(0);
 expect(decodeTransactionCsv(eventsCsv([{...order,cancelled_basis_minor:0}])).errors.length).toBeGreaterThan(0);
 expect(decodeTransactionCsv(eventsCsv([{...cancel,cancelled_basis_minor:1.1}])).errors.length).toBeGreaterThan(0);
 expect(check([order,deposit,cancel,{...cancel,event_id:'REST',quantity:2,cancelled_basis_minor:undefined,event_at:'2026-10-14T10:03:00+08:00'},{...deposit,event_id:'REFUND',kind:'refunded',amount_minor:2000,event_at:'2026-10-14T10:04:00+08:00'}])).toBe(0);
 expect(check([order,deposit,cancel,{...cancel,event_id:'C2',cancelled_basis_minor:3334,event_at:'2026-10-14T10:02:01+08:00'},{...paid,quantity:1,amount_minor:1334}])).toBe(0);
 expect(check([order,deposit,cancel,{...paid,quantity:2,amount_minor:4668},{...cancel,cancelled_basis_minor:undefined,event_id:'AFTER',event_at:'2026-10-14T10:03:01+08:00'},{...events[4]!,quantity:1}])).toBe(0);
});
test('explicit optional cancellation amount passes mapped money units and independent line reconciliation without truncation',()=>{
 const shopEvents=events.map(e=>({...e,shop_id:'DEMO-SHOP'}));
 const job={mode:'fixture'} as SyncJob;
 const mapping={...fixtureMapping,eventArrayPath:'events',fields:{...Object.fromEntries(TRANSACTION_FIELDS.filter(f=>f!=='source_id').map(f=>[f,f])),cancelled_basis_minor:'cancelled_basis_minor'}};
 const mapped=mapOrders([{events:shopEvents}],mapping,job);expect(mapped.quarantine).toHaveLength(0);expect(mapped.events[2]?.cancelled_basis_minor).toBe(3333);
 const fields=[...TRANSACTION_FIELDS.filter(f=>f!=='source_id'),...TRANSACTION_OPTIONAL_FIELDS];
 const csv=fields.join(',')+'\n'+mapped.events.map(e=>fields.map(f=>e[f]??'').join(',')).join('\n');
 const parsed=parseLineReference(csv,'merqo-doudian-fixture','DEMO-SHOP');expect(compareLines(mapped.events,parsed.events).matched).toBe(5);
 const yuan=mapOrders([{events:shopEvents.map(e=>({...e,amount_minor:(e.amount_minor/100).toFixed(2),allocated_discount_minor:'0.00',platform_subsidy_minor:'0.00',...(e.cancelled_basis_minor===undefined?{}:{cancelled_basis_minor:'33.33'})}))}],{...mapping,moneyUnit:'yuan_decimal'},job);
 expect(yuan.quarantine).toHaveLength(0);expect(yuan.events[2]?.cancelled_basis_minor).toBe(3333);
});
