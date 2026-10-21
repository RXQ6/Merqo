import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WarehouseStore} from './warehouse-store';
import {WAREHOUSE_RESERVATION_DEMO,type WarehouseEvent} from './warehouse-contract';
const query={asOf:'2026-10-21',sourceId:'reservation-example',shop:'',warehouse:''};
function fixture(run:(s:WarehouseStore,file:string)=>void){const root=mkdtempSync(join(tmpdir(),'merqo-reserve-')),file=join(root,'stock.sqlite'),s=new WarehouseStore(file);try{run(s,file);}finally{s.close();rmSync(root,{recursive:true,force:true});}}
function write(s:WarehouseStore,events:WarehouseEvent[]){const json=JSON.stringify(events),p=s.preview(json);expect(p.errors).toEqual([]);return s.import(json,p.hash);}
const [opening,hold,release,shipment]=WAREHOUSE_RESERVATION_DEMO;
if(!opening||hold?.kind!=='reserve'||release?.kind!=='release'||shipment?.kind!=='shipment')throw Error('fixture');

test('partial release and reserved shipment conserve physical stock; historical scope and reopened store retain remaining reservation',()=>fixture((s,file)=>{
 write(s,WAREHOUSE_RESERVATION_DEMO);
 expect(s.view(query).totals).toMatchObject({sellableRecorded:7,reserved:1,available:6});
 expect(s.view(query).reservations[0]).toMatchObject({reserved:6,released:2,shipped:3,pending:1,orderRef:'DECLARED-ORDER-1'});
 expect(s.view({...query,asOf:'2026-10-15'}).totals).toMatchObject({sellableRecorded:10,reserved:6,available:4});
 expect(s.view({...query,warehouse:'other'}).totalReservations).toBe(0);
 expect(s.view({...query,sourceId:'other'}).totals.reserved).toBe(0);
 expect(s.import(JSON.stringify(WAREHOUSE_RESERVATION_DEMO),'x'.repeat(64)).replayed).toBe(true);
 const reopened=new WarehouseStore(file);try{expect(reopened.view(query)).toEqual(s.view(query));}finally{reopened.close();}
}));

test('unreserved shipment and transfers cannot consume held stock; excess release, wrong bucket and reservation reuse are rejected atomically',()=>fixture(s=>{
 write(s,[opening,hold]);
 const ship={...shipment,event_id:'UNRESERVED',shipment_ref:'UNRESERVED-SHIP',reservation_id:undefined,quantity:5};
 expect(s.preview(JSON.stringify([ship])).canImport).toBe(false);
 const {note:_,...stock}=opening as Extract<WarehouseEvent,{kind:'opening'}>;
 const transfer:WarehouseEvent={...stock,kind:'transfer_out',event_id:'MOVE',quantity:5,transfer_id:'MOVE-1',to_warehouse_id:'WH-B',event_at:shipment.event_at};
 expect(s.preview(JSON.stringify([transfer])).canImport).toBe(false);
 for(const e of [{...release,quantity:7},{...release,warehouse_id:'WH-B'},{...release,source_id:'other'},{...hold,event_id:'REUSE',event_at:shipment.event_at},{...shipment,quantity:7}])expect(s.preview(JSON.stringify([e])).canImport).toBe(false);
 write(s,[{...ship,quantity:4}]);expect(s.view(query).totals).toMatchObject({sellableRecorded:6,reserved:6,available:0});
 write(s,[release,shipment]);expect(s.view(query).totals).toMatchObject({sellableRecorded:3,reserved:1,available:2});
 expect(s.preview(JSON.stringify([{...release,event_id:'TOO-LATE',event_at:'2026-10-18T10:00:00+08:00'}])).canImport).toBe(false);
}));

test('new holds need valid sellable expiry and free stock; expired holds remain auditable and can be explicitly released',()=>fixture(s=>{
 for(const props of [{expires_on:null},{expires_on:'2026-10-14'},{state:'quarantine'}])expect(s.preview(JSON.stringify([{...opening,...props},{...hold,...props}])).canImport).toBe(false);
 expect(s.preview(JSON.stringify([opening,{...hold,quantity:11}])).canImport).toBe(false);
 const expiry='2026-10-16';write(s,[{...opening,expires_on:expiry},{...hold,expires_on:expiry}]);
 expect(s.view(query).totals).toMatchObject({sellableRecorded:10,reserved:6,available:0,expiredRecorded:10});
 expect(s.preview(JSON.stringify([{...shipment,expires_on:expiry}])).canImport).toBe(false);
 write(s,[{...release,event_at:'2026-10-20T10:00:00+08:00',quantity:6,expires_on:expiry}]);
 expect(s.view(query).totals).toMatchObject({sellableRecorded:10,reserved:0,available:0});
}));

test('concurrent preview is invalidated by another hold and a backdated hold cannot make an existing shipment overdraw free stock',()=>fixture(s=>{
 write(s,[opening]);const first=JSON.stringify([hold]),second=JSON.stringify([{...hold,event_id:'HOLD-2',reservation_id:'HOLD-2'}]);const a=s.preview(first),b=s.preview(second);s.import(first,a.hash);expect(()=>s.import(second,b.hash)).toThrow('变化');expect(s.preview(second).canImport).toBe(false);
 write(s,[{...shipment,reservation_id:undefined,quantity:4}]);
 expect(s.preview(JSON.stringify([{...hold,event_id:'BACKDATED',reservation_id:'HOLD-3',quantity:1,event_at:'2026-10-16T09:00:00+08:00'}])).canImport).toBe(false);
 expect(s.view(query).totals).toMatchObject({sellableRecorded:6,reserved:6,available:0});
}));
