import {z} from 'zod';
import {IngestionStore} from './ingestion-store';
import {MappingProfileSchema,StatementSchema} from './ingestion-contract';
import type {SyncJob} from './sync-contract';
const hex=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().uuid();
export const IngestInternalSchema=z.discriminatedUnion('op',[
 z.strictObject({op:z.literal('ingest_store_view')}),
 z.strictObject({op:z.literal('ingest_store_mapping'),expectedRevision:z.number().int().min(0),profile:MappingProfileSchema}),
 z.strictObject({op:z.literal('ingest_store_preview'),job:z.custom<SyncJob>(v=>v&&typeof v==='object'&&'status'in v&&v.status==='fetched'&&'mode'in v&&['fixture','live'].includes(String(v.mode))&&'id'in v&&typeof v.id==='string'),orders:z.array(z.record(z.string(),z.unknown())).max(10000),stageDigest:hex}),
 z.strictObject({op:z.literal('ingest_store_confirm'),previewId:id,reviewHash:hex,stageDigest:hex,allowPartial:z.boolean(),reason:z.string().max(500)}),
 z.strictObject({op:z.literal('ingest_store_reconcile'),receiptId:id,statement:StatementSchema.optional()}),
]);
export function ingestionRequest(file:string,input:unknown){const request=IngestInternalSchema.parse(input),store=new IngestionStore(file);try{
 switch(request.op){case'ingest_store_view':return store.view();case'ingest_store_mapping':return store.saveMapping(request.expectedRevision,request.profile);case'ingest_store_preview':return store.preview(request.job,request.orders,request.stageDigest);case'ingest_store_confirm':return store.confirm(request.previewId,request.reviewHash,request.stageDigest,request.allowPartial,request.reason);case'ingest_store_reconcile':return store.reconcile(request.receiptId,request.statement);}
 }finally{store.close();}}
