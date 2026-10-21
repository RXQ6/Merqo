import {z} from 'zod';
const id=z.string().trim().min(1).max(128),qty=z.number().int().min(0).max(1000000),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;},'业务日期无效');
const common={source_id:id,event_id:id,shop_id:id,warehouse_id:id,purchase_id:id,line_id:id,sku:id,spec:id,event_at:z.string().datetime({offset:true})};
export const ProcurementEventSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('planned'),quantity:qty.positive(),eta:date.nullable()}),
 z.strictObject({...common,kind:z.literal('eta_updated'),eta:date.nullable()}),
 z.strictObject({...common,kind:z.literal('cancelled'),quantity:qty.positive()}),
 z.strictObject({...common,kind:z.literal('received'),quantity:qty.positive(),accepted_qty:qty,quarantined_qty:qty,batch_id:id,expires_on:date.nullable()}).refine(r=>r.accepted_qty+r.quarantined_qty===r.quantity,'合格与待处理数量须等于到货件数'),
]);
export type ProcurementEvent=z.infer<typeof ProcurementEventSchema>;
export const ProcurementQuerySchema=z.strictObject({asOf:date,sourceId:z.string().max(128).default(''),shop:z.string().max(128).default(''),warehouse:z.string().max(128).default('')});
export type ProcurementQuery=z.infer<typeof ProcurementQuerySchema>;
export interface ProcurementPreview {hash:string;canImport:boolean;newEvents:number;duplicates:number;errors:string[];sample:ProcurementEvent[];}
export interface ProcurementReceipt {id:string;at:number;accepted:number;duplicates:number;inputHash:string;authority:'operator_declared';replayed?:boolean;}
export interface ProcurementLine {sourceId:string;shop:string;warehouse:string;purchaseId:string;lineId:string;sku:string;spec:string;planned:number;cancelled:number;received:number;accepted:number;quarantined:number;outstanding:number;eta:string|null;overdue:boolean;}
export interface ProcurementView {query:ProcurementQuery;asOf:string;authority:'operator_declared';totalLines:number;lines:ProcurementLine[];totals:{planned:number;cancelled:number;received:number;accepted:number;quarantined:number;outstanding:number;overdueQty:number;unknownEtaLines:number;expiredBatches:number;nearExpiryBatches:number;unknownExpiryBatches:number};batches:Array<{sourceId:string;shop:string;warehouse:string;sku:string;spec:string;batchId:string;expiresOn:string|null}>;recentWorkspaceReceipts:ProcurementReceipt[];}
export const ProcurementPublicSchemas=[z.strictObject({op:z.literal('procurement_view'),query:ProcurementQuerySchema}),z.strictObject({op:z.literal('procurement_preview'),json:z.string().min(1).max(8000000)}),z.strictObject({op:z.literal('procurement_import'),json:z.string().min(1).max(8000000),previewHash:z.string().regex(/^[a-f0-9]{64}$/)})] as const;
const base={source_id:'procurement-fixture',shop_id:'SHOP-P',warehouse_id:'WH-A',purchase_id:'PO-1',line_id:'L1',sku:'SKU-P',spec:'单件'};
export const PROCUREMENT_DEMO:ProcurementEvent[]=[{...base,event_id:'PLAN-1',kind:'planned',quantity:10,eta:'2026-10-16',event_at:'2026-10-14T10:00:00+08:00'},{...base,event_id:'ARRIVAL-1',kind:'received',quantity:4,accepted_qty:3,quarantined_qty:1,batch_id:'BATCH-1',expires_on:'2026-11-01',event_at:'2026-10-15T10:00:00+08:00'}];
