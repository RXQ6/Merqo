import {z} from 'zod';
import {ProcurementQuerySchema} from './procurement-contract';
const id=z.string().trim().min(1).max(128),qty=z.number().int().min(0).max(1000000),date=ProcurementQuerySchema.shape.asOf;
const common={source_id:id,event_id:id,shop_id:id,warehouse_id:id,sku:id,spec:id,batch_id:id,expires_on:date.nullable(),event_at:z.string().datetime({offset:true}),state:z.enum(['sellable','quarantine','scrap'])};
export const WarehouseEventSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('opening'),quantity:qty,note:z.string().trim().min(10).max(500)}),
 z.strictObject({...common,kind:z.literal('purchase_in'),quantity:qty.positive(),receipt_event_id:id}),
 z.strictObject({...common,kind:z.literal('return_in'),quantity:qty.positive(),channel:id,inspection_id:id}),
 z.strictObject({...common,kind:z.literal('shipment'),quantity:qty.positive(),shipment_ref:id}),
 z.strictObject({...common,kind:z.literal('transfer_out'),quantity:qty.positive(),transfer_id:id,to_warehouse_id:id}),
 z.strictObject({...common,kind:z.literal('transfer_in'),quantity:qty.positive(),transfer_id:id,from_warehouse_id:id}),
]);
export type WarehouseEvent=z.infer<typeof WarehouseEventSchema>;
export const WarehouseQuerySchema=ProcurementQuerySchema;
export type WarehouseQuery=z.infer<typeof WarehouseQuerySchema>;
export interface WarehousePreview {hash:string;canImport:boolean;newEvents:number;duplicates:number;errors:string[];sample:WarehouseEvent[];}
export interface WarehouseReceipt {id:string;at:number;accepted:number;duplicates:number;replayed?:boolean;authority:'operator_declared';}
export interface WarehouseLine {sourceId:string;shop:string;warehouse:string;sku:string;spec:string;batchId:string;state:WarehouseEvent['state'];quantity:number;expiresOn:string|null;available:number|null;}
export interface WarehouseView {query:WarehouseQuery;authority:'operator_declared';totalLines:number;lines:WarehouseLine[];totals:{sellableRecorded:number;quarantined:number;scrap:number;available:number|null;unknownExpiryLines:number;expiredRecorded:number;inTransit:number};transfers:Array<{sourceId:string;shop:string;transferId:string;from:string;to:string;sent:number;received:number;pending:number}>;recentWorkspaceReceipts:WarehouseReceipt[];}
export const WarehousePublicSchemas=[z.strictObject({op:z.literal('warehouse_view'),query:WarehouseQuerySchema}),z.strictObject({op:z.literal('warehouse_preview'),json:z.string().min(1).max(8000000)}),z.strictObject({op:z.literal('warehouse_import'),json:z.string().min(1).max(8000000),previewHash:z.string().regex(/^[a-f0-9]{64}$/)})] as const;
const base={source_id:'warehouse-example',shop_id:'SHOP-S',warehouse_id:'WH-A',sku:'SKU-S',spec:'单件',batch_id:'B-S',expires_on:'2026-12-31',state:'sellable' as const};
export const WAREHOUSE_DEMO:WarehouseEvent[]=[{...base,event_id:'OPEN',kind:'opening',quantity:10,note:'人工盘点声明的期初库存，示例数据',event_at:'2026-10-14T10:00:00+08:00'},{...base,event_id:'OUT',kind:'transfer_out',quantity:3,transfer_id:'T1',to_warehouse_id:'WH-B',event_at:'2026-10-15T10:00:00+08:00'},{...base,event_id:'IN',kind:'transfer_in',warehouse_id:'WH-B',quantity:2,transfer_id:'T1',from_warehouse_id:'WH-A',event_at:'2026-10-16T10:00:00+08:00'}];
