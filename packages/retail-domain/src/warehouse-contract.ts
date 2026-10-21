import {z} from 'zod';
import {ProcurementQuerySchema} from './procurement-contract';
const id=z.string().trim().min(1).max(128),qty=z.number().int().min(0).max(1000000),date=ProcurementQuerySchema.shape.asOf;
const common={source_id:id,event_id:id,shop_id:id,warehouse_id:id,sku:id,spec:id,batch_id:id,expires_on:date.nullable(),event_at:z.string().datetime({offset:true}),state:z.enum(['sellable','quarantine','scrap'])};
export const WarehouseEventSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('opening'),quantity:qty,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('purchase_in'),quantity:qty.positive(),receipt_event_id:id}),
 z.strictObject({...common,kind:z.literal('return_in'),quantity:qty.positive(),channel:id,inspection_id:id}),
 z.strictObject({...common,kind:z.literal('shipment'),quantity:qty.positive(),shipment_ref:id,reservation_id:id.optional()}),
 z.strictObject({...common,kind:z.literal('reserve'),quantity:qty.positive(),reservation_id:id,order_ref:id}),
 z.strictObject({...common,kind:z.literal('release'),quantity:qty.positive(),reservation_id:id,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('inventory_count'),quantity:qty,expected_quantity:qty,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('expiry_corrected'),quantity:z.literal(0),previous_expires_on:date.nullable(),note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('state_changed'),quantity:qty.positive(),to_state:z.enum(['sellable','quarantine','scrap']),note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('transfer_loss'),quantity:qty.positive(),transfer_id:id,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('transfer_return'),quantity:qty.positive(),transfer_id:id,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('transfer_out'),quantity:qty.positive(),transfer_id:id,to_warehouse_id:id}),
 z.strictObject({...common,kind:z.literal('transfer_in'),quantity:qty.positive(),transfer_id:id,from_warehouse_id:id}),
]);
export type WarehouseEvent=z.infer<typeof WarehouseEventSchema>;
export const WarehouseQuerySchema=ProcurementQuerySchema;
export type WarehouseQuery=z.infer<typeof WarehouseQuerySchema>;
export interface WarehousePreview {hash:string;canImport:boolean;newEvents:number;duplicates:number;errors:string[];sample:WarehouseEvent[];}
export interface WarehouseReceipt {id:string;at:number;accepted:number;duplicates:number;replayed?:boolean;authority:'operator_declared';}
export interface WarehouseLine {sourceId:string;shop:string;warehouse:string;sku:string;spec:string;batchId:string;state:WarehouseEvent['state'];quantity:number;reserved:number;expiresOn:string|null;available:number|null;}
export interface WarehouseReservation {sourceId:string;shop:string;warehouse:string;reservationId:string;orderRef:string;sku:string;spec:string;batchId:string;reserved:number;released:number;shipped:number;pending:number;}
export interface WarehouseView {query:WarehouseQuery;authority:'operator_declared';totalLines:number;lines:WarehouseLine[];eventCount:number;recentEvents:WarehouseEvent[];totals:{sellableRecorded:number;reserved:number;quarantined:number;scrap:number;available:number|null;unknownExpiryLines:number;expiredRecorded:number;inTransit:number};totalReservations:number;reservations:WarehouseReservation[];transfers:Array<{sourceId:string;shop:string;transferId:string;from:string;to:string;sent:number;received:number;lost:number;returned:number;pending:number}>;recentWorkspaceReceipts:WarehouseReceipt[];}
export const WarehousePickInputSchema=z.strictObject({sourceId:id,shop:id,warehouse:id,sku:id,spec:id,quantity:qty.positive(),orderRef:id});
export type WarehousePickInput=z.infer<typeof WarehousePickInputSchema>;
export interface WarehousePickPlan {id:string;at:number;validUntil:number;hash:string;businessDay:string;input:WarehousePickInput;status:'ready'|'insufficient'|'needs_evidence'|'blocked';reasons:string[];knownAvailable:number;shortfall:number;excluded:{unknownExpiry:number;expired:number;quarantined:number;reserved:number};selections:Array<{batchId:string;expiresOn:string;quantity:number}>;}
export interface WarehousePickReceipt extends WarehouseReceipt {plan:WarehousePickPlan;reservationIds:string[];}
export const WarehousePublicSchemas=[z.strictObject({op:z.literal('warehouse_pick_preview'),input:WarehousePickInputSchema}),z.strictObject({op:z.literal('warehouse_pick_confirm'),id:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/)}),z.strictObject({op:z.literal('warehouse_view'),query:WarehouseQuerySchema}),z.strictObject({op:z.literal('warehouse_preview'),json:z.string().min(1).max(8000000)}),z.strictObject({op:z.literal('warehouse_import'),json:z.string().min(1).max(8000000),previewHash:z.string().regex(/^[a-f0-9]{64}$/)})] as const;
const base={source_id:'warehouse-example',shop_id:'SHOP-S',warehouse_id:'WH-A',sku:'SKU-S',spec:'单件',batch_id:'B-S',expires_on:'2026-12-31',state:'sellable' as const};
export const WAREHOUSE_DEMO:WarehouseEvent[]=[{...base,event_id:'OPEN',kind:'opening',quantity:10,note:'人工盘点声明的期初库存，示例数据',event_at:'2026-10-14T10:00:00+08:00'},{...base,event_id:'OUT',kind:'transfer_out',quantity:3,transfer_id:'T1',to_warehouse_id:'WH-B',event_at:'2026-10-15T10:00:00+08:00'},{...base,event_id:'IN',kind:'transfer_in',warehouse_id:'WH-B',quantity:2,transfer_id:'T1',from_warehouse_id:'WH-A',event_at:'2026-10-16T10:00:00+08:00'}];
export const WAREHOUSE_RESERVATION_DEMO:WarehouseEvent[]=[{...base,source_id:'reservation-example',event_id:'R-OPEN',kind:'opening',quantity:10,note:'人工盘点声明的预占演练期初库存',event_at:'2026-10-14T10:00:00+08:00'},{...base,source_id:'reservation-example',event_id:'R-HOLD',kind:'reserve',quantity:6,reservation_id:'HOLD-1',order_ref:'DECLARED-ORDER-1',event_at:'2026-10-15T10:00:00+08:00'},{...base,source_id:'reservation-example',event_id:'R-RELEASE',kind:'release',quantity:2,reservation_id:'HOLD-1',note:'人工确认该订单部分不再需要预占',event_at:'2026-10-16T10:00:00+08:00'},{...base,source_id:'reservation-example',event_id:'R-SHIP',kind:'shipment',quantity:3,reservation_id:'HOLD-1',shipment_ref:'DECLARED-SHIP-1',event_at:'2026-10-17T10:00:00+08:00'}];
const maintenanceBase={...base,source_id:'warehouse-maintenance-example'};
export const WAREHOUSE_MAINTENANCE_DEMO:WarehouseEvent[]=[
 {...maintenanceBase,event_id:'M-OPEN',kind:'opening',quantity:10,note:'人工盘点声明的库存更正演练期初',event_at:'2026-10-14T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-COUNT',kind:'inventory_count',expected_quantity:10,quantity:9,note:'复盘盘点单确认实存九件，原数量十件',event_at:'2026-10-15T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-STATE',kind:'state_changed',to_state:'quarantine',quantity:2,note:'人工质量复核发现两件包装破损转隔离',event_at:'2026-10-16T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-EXPIRY',kind:'expiry_corrected',previous_expires_on:'2026-12-31',expires_on:'2027-01-31',quantity:0,note:'人工核对原包装及批次资料更正效期',event_at:'2026-10-17T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-OUT',kind:'transfer_out',expires_on:'2027-01-31',quantity:3,transfer_id:'M-T1',to_warehouse_id:'WH-B',event_at:'2026-10-18T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-LOSS',kind:'transfer_loss',expires_on:'2027-01-31',quantity:1,transfer_id:'M-T1',note:'人工核对物流异常凭证确认在途丢失一件',event_at:'2026-10-19T10:00:00+08:00'},
 {...maintenanceBase,event_id:'M-RETURN',kind:'transfer_return',expires_on:'2027-01-31',quantity:1,transfer_id:'M-T1',note:'人工确认调拨退回一件已经实际回到源仓',event_at:'2026-10-20T10:00:00+08:00'},
];
