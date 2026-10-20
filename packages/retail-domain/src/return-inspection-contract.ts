import {z} from 'zod';
import {TransactionQuerySchema} from './transactions';
const id=z.string().trim().min(1).max(128),qty=z.number().int().min(0).max(1000000);
export const InspectionRowSchema=z.strictObject({source_id:id,shop_id:id,channel:z.string().trim().min(1).max(200),inspection_id:id,returned_event_id:id,warehouse_id:id,passed_qty:qty,defective_qty:qty,scrap_qty:qty,observed_at:z.string().datetime({offset:true})}).refine(r=>r.passed_qty+r.defective_qty+r.scrap_qty>0,'质检件数须大于零');
export type InspectionRow=z.infer<typeof InspectionRowSchema>;
export const INSPECTION_FIELDS=['source_id','shop_id','channel','inspection_id','returned_event_id','warehouse_id','passed_qty','defective_qty','scrap_qty','observed_at'] as const;
export const INSPECTION_TEMPLATE=INSPECTION_FIELDS.join(',')+'\n';
export interface InspectionPreview {hash:string;rows:InspectionRow[];total:number;duplicates:number;errors:Array<{line:number;reason:string}>;canImport:boolean;}
export interface InspectionReceipt {id:string;at:number;accepted:number;duplicates:number;inputHash:string;reviewHash:string;authority:'operator_declared';}
export interface InspectionView {totalEvents:number;receivedQty:number;passedQty:number;defectiveQty:number;scrapQty:number;pendingQty:number;lines:Array<{eventId:string;orderId:string;lineId:string;receivedQty:number;passedQty:number;defectiveQty:number;scrapQty:number;pendingQty:number;warehouses:string[]}>;recentWorkspaceReceipts:InspectionReceipt[];}
export const InspectionPublicSchemas=[z.strictObject({op:z.literal('inspections_view'),query:TransactionQuerySchema}),z.strictObject({op:z.literal('inspections_preview'),csv:z.string().min(1).max(8000000)}),z.strictObject({op:z.literal('inspections_import'),csv:z.string().min(1).max(8000000),previewHash:z.string().regex(/^[a-f0-9]{64}$/)})] as const;
