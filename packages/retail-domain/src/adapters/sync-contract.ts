import {z} from 'zod';

export const SyncConfigSchema=z.strictObject({
 name:z.string().trim().min(1).max(80),mode:z.enum(['fixture','live']),
 shopId:z.string().trim().max(128),appKey:z.string().trim().max(128),
 fixture:z.enum(['normal','rate_limit','invalid_response','quality_errors']).default('normal'),
}).superRefine((c,ctx)=>{if(c.mode==='live'&&(!c.shopId||!c.appKey))ctx.addIssue({code:'custom',message:'真实连接需要店铺 ID 和 App Key'});});
export const SyncWindowSchema=z.strictObject({start:z.number().int().positive().safe(),end:z.number().int().positive().safe(),size:z.number().int().min(1).max(100).default(50)}).refine(w=>w.start<w.end&&w.end-w.start<=86400,'同步窗口应大于0且不超过24小时');
export const SyncCredentialsSchema=z.strictObject({appSecret:z.string().min(1).max(4096),accessToken:z.string().min(1).max(4096),expiresAt:z.number().int().positive().safe()});
export const SyncPublicSchemas=[
 z.strictObject({op:z.literal('sync_view')}),
 z.strictObject({op:z.literal('sync_configure'),expectedRevision:z.number().int().min(0),config:SyncConfigSchema,credentials:SyncCredentialsSchema.optional()}),
 z.strictObject({op:z.literal('sync_check')}),
 z.strictObject({op:z.literal('sync_create'),expectedRevision:z.number().int().positive(),window:SyncWindowSchema}),
 z.strictObject({op:z.literal('sync_control'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0),action:z.enum(['pause','resume','retry'])}),
] as const;
export type SyncConfig=z.infer<typeof SyncConfigSchema>;
export type SyncWindow=z.infer<typeof SyncWindowSchema>;
export interface SyncConnection extends SyncConfig {revision:number;credentialRef?:string;expiresAt?:number;check?:{ok:boolean;at:number;message:string};}
export type SyncStatus='queued'|'running'|'retry_wait'|'paused'|'blocked'|'failed'|'fetched';
export interface SyncJob {
 id:string;connectionRevision:number;mode:'fixture'|'live';window:SyncWindow;status:SyncStatus;epoch:number;
 nextPage:number;received:number;reportedTotal:number|null;attempts:number;retryAt:number|null;
 error:string|null;createdAt:number;updatedAt:number;
 scope?:{shopId:string;appKey:string};
}
export interface SyncPageReceipt {page:number;count:number;responseSha256:string;at:number;}
export interface SyncView {connection:SyncConnection|null;jobs:SyncJob[];receipts:Record<string,SyncPageReceipt[]>;}
export const SyncInternalSchema=z.discriminatedUnion('op',[
 z.strictObject({op:z.literal('sync_store_view')}),
 z.strictObject({op:z.literal('sync_store_configure'),expectedRevision:z.number().int().min(0),config:SyncConfigSchema,credentialRef:z.string().uuid().optional(),expiresAt:z.number().int().positive().safe().optional()}),
 z.strictObject({op:z.literal('sync_store_check'),expectedRevision:z.number().int().positive(),ok:z.boolean(),message:z.string().max(200)}),
 z.strictObject({op:z.literal('sync_store_create'),expectedRevision:z.number().int().positive(),window:SyncWindowSchema}),
 z.strictObject({op:z.literal('sync_store_control'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0),action:z.enum(['pause','resume','retry'])}),
 z.strictObject({op:z.literal('sync_store_recover')}),
 z.strictObject({op:z.literal('sync_store_claim'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0)}),
 z.strictObject({op:z.literal('sync_store_page'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0),page:z.number().int().min(0),count:z.number().int().min(0).max(100),reportedTotal:z.number().int().nonnegative().safe(),responseSha256:z.string().regex(/^[a-f0-9]{64}$/),encrypted:z.string().min(1).max(24000000)}),
 z.strictObject({op:z.literal('sync_store_failure'),id:z.string().uuid(),expectedEpoch:z.number().int().min(0),message:z.string().max(200),retryable:z.boolean(),blocked:z.boolean().default(false)}),
]);
