import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AD_REFUND_DEMO as input,AD_REFUND_EVENTS as events,AD_REFUND_CSV,AdRefundInputSchema,calculateAdRefund} from './ad-refund';
import {TransactionStore} from './transaction-store';import {eventsCsv} from './adapters/ingestion';import {validateTransactionChains,type TransactionEvent} from './transactions';
import {backupInventory,captureBackup,writeBackup,readBackup,restoreBackup} from './backup';
test('explicit overlapping campaign shares conserve paid and refunded settlement without treating physical returns as refunds',()=>{
 expect(AdRefundInputSchema.safeParse(input).success).toBe(true);expect(validateTransactionChains(events)).toEqual([]);const r=calculateAdRefund(input,events);expect(r.totals).toEqual({paidMinor:10000,refundMinor:2000,retainedMinor:8000,spendMinor:2000});expect(r.campaigns[0]).toMatchObject({status:'declared_mature',paidMinor:6000,refundMinor:1200,retainedMinor:4800,refundAdjustedRoas:4.8});expect(r.campaigns[1]).toMatchObject({paidMinor:4000,refundMinor:800,retainedMinor:3200,refundAdjustedRoas:3.2});const physical:TransactionEvent={...events[2]!,kind:'returned',event_id:'PHYSICAL',amount_minor:0,event_at:'2026-10-17T10:00:00+08:00'};expect(calculateAdRefund(input,[...events,physical])).toEqual(r);
});
test('duplicate links, over/under attribution and future watermarks reject the declaration instead of normalizing silently',()=>{
 for(const links of [[...input.links,input.links[0]!],input.links.map(l=>({...l,shareBps:10000})),input.links.map(l=>({...l,shareBps:1000})),[{...input.links[0]!,campaignId:'missing'},input.links[1]!]])expect(AdRefundInputSchema.safeParse({...input,links}).success).toBe(false);
 expect(AdRefundInputSchema.safeParse({...input,campaigns:input.campaigns.map(c=>({...c,completeThrough:'2099-01-01T00:00:00Z'}))}).success).toBe(false);
});
test('maturity and declared current coverage remain separate from unknown links, invalid touch windows and zero denominator',()=>{
 const early={...input,observedAt:'2026-10-17T12:00:00+08:00',campaigns:input.campaigns.map(c=>({...c,completeThrough:'2026-10-17T12:00:00+08:00'}))};expect(calculateAdRefund(early,events).campaigns.every(c=>c.status==='provisional')).toBe(true);
 for(const props of [{completeThrough:null},{completeThrough:'2026-10-18T00:00:00+08:00'},{linksComplete:false}])expect(calculateAdRefund({...input,campaigns:input.campaigns.map(c=>({...c,...props}))},events).campaigns.every(c=>c.status==='provisional')).toBe(true);
 const bad=calculateAdRefund({...input,links:input.links.map(l=>({...l,touchAt:'2026-10-14T12:00:00+08:00'}))},events);expect(bad.campaigns.every(c=>c.status==='needs_evidence')).toBe(true);expect(bad.totals.retainedMinor).toBeNull();expect(calculateAdRefund(input,[]).totals.paidMinor).toBeNull();
 const zero=calculateAdRefund({...input,campaigns:input.campaigns.map(c=>({...c,spendMinor:0}))},events);expect(zero.totals.retainedMinor).toBe(8000);expect(zero.campaigns.every(c=>c.refundAdjustedRoas===null)).toBe(true);
 expect(calculateAdRefund(input,[...events,{...events[3]!,event_id:'LATE',event_at:'2026-10-22T10:00:00+08:00'}]).totals.retainedMinor).toBeNull();
});
test('integer tails across six overlapping campaigns preserve cents and never allocate more refund than campaign receipts',()=>{
 const shares=[2857,2857,1714,952,952,668],campaigns=shares.map((_,i)=>({...input.campaigns[0]!,id:'C'+i,name:'C'+i})),links=shares.map((shareBps,i)=>({...input.links[0]!,campaignId:'C'+i,shareBps}));
 for(const paid of [1,2,3,25,26,9999])for(const refund of [paid-1,paid]){const rows=events.map(e=>e.kind==='ordered'||e.kind==='paid'?{...e,amount_minor:paid}:e.kind==='refunded'?{...e,amount_minor:refund}:e);const r=calculateAdRefund({...input,campaigns,links},rows);expect(r.totals.paidMinor).toBe(paid);expect(r.totals.refundMinor).toBe(refund);expect(r.totals.retainedMinor).toBe(paid-refund);expect(r.campaigns.every(c=>c.refundMinor!<=c.paidMinor!&&c.retainedMinor!>=0)).toBe(true);}
});
test('frozen ledger-backed reports reopen and recover through encrypted backup while later events require a new report',()=>{
 const root=mkdtempSync(join(tmpdir(),'merqo-ad-refund-')),file=join(root,'operations.sqlite.transactions.sqlite'),s=new TransactionStore(file);try{const p=s.preview(AD_REFUND_CSV);expect(p.canImport).toBe(true);s.import(AD_REFUND_CSV,p.hash);const before=s.stateHash('csv'),first=s.adRefund(input)[0]!;expect(first.totals.retainedMinor).toBe(8000);expect(s.stateHash('csv')).toBe(before);
 const later:TransactionEvent={...events[3]!,event_id:'LATER',amount_minor:1000,event_at:'2026-10-20T10:00:00+08:00'},csv=eventsCsv([later]);s.import(csv,s.preview(csv).hash);const next=s.adRefund(input)[0]!;expect(next.totals.retainedMinor).toBe(7000);expect(next.ledgerHash).not.toBe(first.ledgerHash);expect(s.adRefundReports().find(r=>r.id===first.id)).toEqual(first);const reopened=new TransactionStore(file);try{expect(reopened.adRefundReports()).toEqual(s.adRefundReports());}finally{reopened.close();}
 const inventory=backupInventory(root),payload=captureBackup(root,'WS-AD','Ads',[],inventory.connectionHash),archive=join(root,'ad.merqo-backup');writeBackup(payload,'ad-refund-fixture-password',archive);restoreBackup(readBackup(archive,'ad-refund-fixture-password').payload,join(root,'restored'));const restored=new TransactionStore(join(root,'restored','retail','operations.sqlite.transactions.sqlite'));try{expect(restored.adRefundReports()).toEqual(s.adRefundReports());}finally{restored.close();}
 expect(()=>s.adRefund({...input,observedAt:'2099-01-01T00:00:00Z'})).toThrow('超前');
 }finally{s.close();rmSync(root,{recursive:true,force:true});}
});
