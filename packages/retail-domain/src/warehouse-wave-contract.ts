import {z} from 'zod';import {WarehousePickInputSchema} from './warehouse-contract';
const text=z.string().trim().min(1).max(128),hash=z.string().regex(/^[a-f0-9]{64}$/),identity={sourceId:text,shop:text,warehouse:text,sku:text,spec:text};
export const LocationInputSchema=z.strictObject({...identity,barcode:text,binCode:text,enabled:z.boolean(),note:z.string().trim().min(10).max(500)});
export type LocationInput=z.infer<typeof LocationInputSchema>;
export interface WarehouseLocation extends LocationInput {key:string;version:number;at:string;}
export const WaveInputSchema=z.array(WarehousePickInputSchema).min(2).max(20).superRefine((rows,ctx)=>{const first=rows[0]!,seen=new Set<string>();for(const r of rows){if(r.sourceId!==first.sourceId||r.shop!==first.shop||r.warehouse!==first.warehouse)ctx.addIssue({code:'custom',message:'一个波次须使用同来源、店铺和仓库'});const key=JSON.stringify([r.orderRef,r.sku,r.spec]);if(seen.has(key))ctx.addIssue({code:'custom',message:'波次不能重复同一订单引用、SKU和规格'});seen.add(key);}});
export type WaveInput=z.infer<typeof WaveInputSchema>;
export const WaveScansSchema=z.array(z.strictObject({orderRef:text,barcode:text,binCode:text,quantity:z.number().int().positive().max(1000000)})).min(2).max(100);
export type WaveScans=z.infer<typeof WaveScansSchema>;
export interface WaveSelection {orderRef:string;sku:string;spec:string;barcode:string;binCode:string;batchId:string;expiresOn:string;quantity:number;reservationId:string;}
export interface WarehouseWavePlan {id:string;at:string;expiresAt:string;hash:string;stateHash:string;input:WaveInput;status:'ready'|'blocked';reasons:string[];selections:WaveSelection[];}
export interface WarehouseWaveReceipt {id:string;at:string;plan:WarehouseWavePlan;scans:WaveScans;authority:'operator_declared';replayed?:boolean;}
export interface WarehouseWaveView {locations:WarehouseLocation[];totalLocations:number;receipts:WarehouseWaveReceipt[];}
export const WarehouseWaveSchemas=[z.strictObject({op:z.literal('local_ops_wave_view')}),z.strictObject({op:z.literal('local_ops_location_save'),expectedVersion:z.number().int().min(0),input:LocationInputSchema}),z.strictObject({op:z.literal('local_ops_wave_preview'),input:WaveInputSchema}),z.strictObject({op:z.literal('local_ops_wave_confirm'),id:z.string().uuid(),reviewHash:hash,scans:WaveScansSchema})] as const;
export type WarehouseWaveRequest=z.infer<typeof WarehouseWaveSchemas[number]>;
export type WarehouseWaveData={view:'warehouse_workflow';data:WarehouseWaveView}|{view:'wave_plan';plan:WarehouseWavePlan}|{view:'wave_receipt';receipt:WarehouseWaveReceipt};
