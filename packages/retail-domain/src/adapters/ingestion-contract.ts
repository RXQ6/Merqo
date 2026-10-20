import {z} from 'zod';
import {TRANSACTION_FIELDS,TRANSACTION_OPTIONAL_FIELDS} from '../transactions';
import type {TransactionEvent} from '../transactions';
export const mappedFields=TRANSACTION_FIELDS.filter(f=>f!=='source_id');
const path=z.string().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/).refine(p=>!p.split('.').some(k=>['__proto__','constructor','prototype'].includes(k)),'不允许原型路径');
export const MappingProfileSchema=z.strictObject({name:z.string().trim().min(1).max(100),mode:z.enum(['fixture','live']),eventArrayPath:path.nullable(),fields:z.record(z.string(),path),kindMap:z.record(z.string().max(80),z.enum(['ordered','paid','shipped','refunded','cancelled','returned'])),moneyUnit:z.enum(['minor_integer','yuan_decimal']),timeUnit:z.enum(['iso_offset','unix_seconds','unix_millis']),semanticsConfirmed:z.literal(true)}).superRefine((p,c)=>{
 for(const f of mappedFields)if(!p.fields[f])c.addIssue({code:'custom',message:`缺少字段映射：${f}`});
 for(const f of Object.keys(p.fields))if(![...mappedFields,...TRANSACTION_OPTIONAL_FIELDS].includes(f as never))c.addIssue({code:'custom',message:`不支持映射字段：${f}`});
});
export type MappingProfile=z.infer<typeof MappingProfileSchema>;
export interface SavedMapping {revision:number;profile:MappingProfile;hash:string;at:number;}
export const fixtureMapping:MappingProfile={name:'合成交易事件 v1',mode:'fixture',eventArrayPath:'events',fields:Object.fromEntries(mappedFields.map(f=>[f,f])),kindMap:Object.fromEntries(['ordered','paid','shipped','refunded','cancelled','returned'].map(k=>[k,k])) as MappingProfile['kindMap'],moneyUnit:'minor_integer',timeUnit:'iso_offset',semanticsConfirmed:true};
export interface Quarantine {record:number;event:number|null;reason:string;}
export interface ControlTotals {eventCount:number;orderedQty:number;paidQty:number;refundedQty:number;paidMinor:number;refundedMinor:number;discountMinor:number;subsidyMinor:number;}
const n=z.number().int().nonnegative().safe();
export const StatementSchema=z.strictObject({label:z.string().trim().min(1).max(100),shopId:z.string().min(1).max(128),currency:z.literal('CNY'),basis:z.literal('batch_event_set'),observedAt:z.string().datetime({offset:true}),totals:z.strictObject({eventCount:n,orderedQty:n,paidQty:n,refundedQty:n,paidMinor:n,refundedMinor:n,discountMinor:n,subsidyMinor:n})});
export type Statement=z.infer<typeof StatementSchema>;
export interface IngestPreview {id:string;jobId:string;mode:'fixture'|'live';source:'demo'|'csv';mappingRevision:number;mappingName:string;stageDigest:string;reviewHash:string;createdAt:number;totalRecords:number;newEvents:number;duplicateEvents:number;conflictEvents:number;quarantinedRecords:number;quarantine:Quarantine[];blockingIssues:string[];sample:TransactionEvent[];totals:ControlTotals;canConfirm:boolean;}
export interface IngestReceipt {id:string;previewId:string;jobId:string;reviewHash:string;mappingRevision:number;at:number;accepted:number;duplicates:number;quarantinedRecords:number;batchId:string;source:'demo'|'csv';totals:ControlTotals;}
export interface Reconciliation {id:string;receiptId:string;at:number;status:'matched'|'mismatch'|'unverified';reference:'synthetic_control'|'operator_declared'|'missing';differences:Array<{field:string;expected:number|null;actual:number|null}>;ledgerIssues:number;quarantinedRecords:number;statementHash:string|null;}
export interface IngestView {mapping:SavedMapping|null;previews:IngestPreview[];receipts:IngestReceipt[];reconciliations:Reconciliation[];}
export const IngestPublicSchemas=[z.strictObject({op:z.literal('ingest_inspect'),jobId:z.string().uuid(),eventArrayPath:path.nullable()}),z.strictObject({op:z.literal('ingest_view')}),z.strictObject({op:z.literal('ingest_mapping_save'),expectedRevision:z.number().int().min(0),profile:MappingProfileSchema}),z.strictObject({op:z.literal('ingest_preview'),jobId:z.string().uuid()}),z.strictObject({op:z.literal('ingest_confirm'),previewId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/),allowPartial:z.boolean().default(false),reason:z.string().max(500).default('')}),z.strictObject({op:z.literal('ingest_reconcile'),receiptId:z.string().uuid(),statement:StatementSchema.optional()})] as const;
