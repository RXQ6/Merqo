import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {WarehouseStore} from './warehouse-store';import {WAREHOUSE_MAINTENANCE_DEMO,WAREHOUSE_RESERVATION_DEMO,type WarehouseEvent} from './warehouse-contract';
import {backupInventory,captureBackup,writeBackup,readBackup,restoreBackup} from './backup';
const query={asOf:'2026-10-21',sourceId:'warehouse-maintenance-example',shop:'',warehouse:''};
function fixture(run:(s:WarehouseStore,root:string)=>void){const root=mkdtempSync(join(tmpdir(),'merqo-stock-maintain-')),s=new WarehouseStore(join(root,'operations.sqlite.transactions.sqlite'));try{run(s,root);}finally{s.close();rmSync(root,{recursive:true,force:true});}}
function write(s:WarehouseStore,events:WarehouseEvent[]){const json=JSON.stringify(events),p=s.preview(json);expect(p.errors).toEqual([]);return s.import(json,p.hash);}
const [opening,count,changed,expiry,outgoing,lost,returned]=WAREHOUSE_MAINTENANCE_DEMO;
if(!opening||count?.kind!=='inventory_count'||changed?.kind!=='state_changed'||expiry?.kind!=='expiry_corrected'||outgoing?.kind!=='transfer_out'||lost?.kind!=='transfer_loss'||returned?.kind!=='transfer_return')throw Error('fixture');
test('declared count/state/expiry/transfer exceptions replay with conserved quantities, scoped audit and encrypted backup recovery',()=>fixture((s,root)=>{
 write(s,WAREHOUSE_MAINTENANCE_DEMO);const view=s.view(query);expect(view.totals).toMatchObject({sellableRecorded:5,quarantined:2,available:5,inTransit:1});expect(view.transfers[0]).toMatchObject({sent:3,received:0,lost:1,returned:1,pending:1});expect(view.lines.every(l=>l.expiresOn==='2027-01-31')).toBe(true);expect(view.eventCount).toBe(7);expect(view.recentEvents[0]?.kind).toBe('transfer_return');expect(s.view({...query,asOf:'2026-10-16'}).lines.every(l=>l.expiresOn==='2026-12-31')).toBe(true);expect(s.view({...query,warehouse:'WH-B'}).eventCount).toBe(0);
 const inventory=backupInventory(root),payload=captureBackup(root,'WS-M','Maintenance',[],inventory.connectionHash),archive=join(root,'stock.merqo-backup');writeBackup(payload,'maintenance-fixture-password',archive);restoreBackup(readBackup(archive,'maintenance-fixture-password').payload,join(root,'restored'));
 const restored=new WarehouseStore(join(root,'restored','retail','operations.sqlite.transactions.sqlite'));try{expect(restored.view(query)).toEqual(view);}finally{restored.close();}
}));
test('count correction requires current expected stock and cannot hide a shortage below outstanding reservations',()=>fixture(s=>{
 write(s,WAREHOUSE_RESERVATION_DEMO.slice(0,2));const e={...count,source_id:'reservation-example'};expect(s.preview(JSON.stringify([{...e,expected_quantity:11}])).canImport).toBe(false);expect(s.preview(JSON.stringify([{...e,quantity:5}])).canImport).toBe(false);expect(s.preview(JSON.stringify([{...e,warehouse_id:'missing'}])).canImport).toBe(false);
 write(s,[{...e,event_at:'2026-10-16T10:00:00+08:00',quantity:6}]);expect(s.view({...query,sourceId:'reservation-example'}).totals).toMatchObject({sellableRecorded:6,reserved:6,available:0});
}));
test('state movement preserves total and forbids using held stock, reviving scrap, same-state or expired sellable conversion',()=>fixture(s=>{
 write(s,[opening,changed]);expect(s.view(query).totals).toMatchObject({sellableRecorded:8,quarantined:2});
 const back={...changed,event_id:'BACK',state:'quarantine' as const,to_state:'sellable' as const,event_at:'2026-10-17T10:00:00+08:00',quantity:1};write(s,[back]);expect(s.view(query).totals).toMatchObject({sellableRecorded:9,quarantined:1});
 expect(s.preview(JSON.stringify([{...back,event_id:'SAME',to_state:'quarantine'}])).canImport).toBe(false);
 write(s,[{...changed,event_id:'SCRAP',to_state:'scrap',quantity:1,event_at:'2026-10-18T10:00:00+08:00'}]);expect(s.preview(JSON.stringify([{...back,event_id:'REVIVE',state:'scrap',event_at:'2026-10-19T10:00:00+08:00'}])).canImport).toBe(false);
 write(s,WAREHOUSE_RESERVATION_DEMO.slice(0,2));expect(s.preview(JSON.stringify([{...changed,source_id:'reservation-example',event_id:'HELD',quantity:5,event_at:'2026-10-16T10:00:00+08:00'}])).canImport).toBe(false);
 const expiredSource='expired-state';write(s,[{...opening,source_id:expiredSource,expires_on:'2026-10-14',state:'quarantine'}]);expect(s.preview(JSON.stringify([{...back,source_id:expiredSource,expires_on:'2026-10-14'}])).canImport).toBe(false);
}));
test('batch-wide expiry corrections bind the old value, preserve historical dates, and allow corrected in-transit arrival without inventing expiry',()=>fixture(s=>{
 write(s,[opening,{...outgoing,event_at:'2026-10-15T10:00:00+08:00',expires_on:'2026-12-31'},expiry]);
 expect(s.preview(JSON.stringify([{...expiry,event_id:'STALE',event_at:'2026-10-18T10:00:00+08:00'}])).canImport).toBe(false);
 const incoming:WarehouseEvent={source_id:outgoing.source_id,event_id:'ARRIVE',shop_id:outgoing.shop_id,warehouse_id:'WH-B',sku:outgoing.sku,spec:outgoing.spec,batch_id:outgoing.batch_id,state:outgoing.state,expires_on:'2027-01-31',kind:'transfer_in',transfer_id:outgoing.transfer_id,from_warehouse_id:outgoing.warehouse_id,quantity:1,event_at:'2026-10-18T10:00:00+08:00'};write(s,[incoming]);expect(s.view(query).lines.every(l=>l.expiresOn==='2027-01-31')).toBe(true);
 write(s,[{...expiry,event_id:'UNKNOWN',previous_expires_on:'2027-01-31',expires_on:null,event_at:'2026-10-19T10:00:00+08:00'}]);expect(s.view(query).totals.available).toBeNull();
 expect(s.preview(JSON.stringify([{...outgoing,event_id:'FORGED',transfer_id:'FORGED',event_at:'2026-10-20T10:00:00+08:00',expires_on:'2027-01-31'}])).canImport).toBe(false);
}));
test('arrival, loss and physical return share a single remaining transit cap and reject wrong warehouse or stale confirmation',()=>fixture(s=>{
 write(s,WAREHOUSE_MAINTENANCE_DEMO);expect(s.preview(JSON.stringify([{...lost,event_id:'EXCESS',quantity:2,event_at:'2026-10-21T00:00:00+08:00'}])).canImport).toBe(false);expect(s.preview(JSON.stringify([{...returned,event_id:'WRONG',warehouse_id:'WH-B',event_at:'2026-10-21T00:00:00+08:00'}])).canImport).toBe(false);
 const json=JSON.stringify([{...lost,event_id:'LAST',event_at:'2026-10-21T00:00:00+08:00'}]),p=s.preview(json);write(s,[{...returned,event_id:'RETURN-LAST',event_at:'2026-10-20T11:00:00+08:00'}]);expect(()=>s.import(json,p.hash)).toThrow('变化');expect(s.preview(json).canImport).toBe(false);expect(s.view(query).totals).toMatchObject({sellableRecorded:6,quarantined:2,inTransit:0});
}));
