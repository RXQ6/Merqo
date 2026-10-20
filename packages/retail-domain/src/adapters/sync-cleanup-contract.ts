import {z} from 'zod';
export interface CleanupPlan {id:string;at:number;before:number;reviewHash:string;jobs:Array<{id:string;createdAt:number;pages:number;bytes:number}>;bytes:number;more:boolean;}
export interface CleanupReceipt {id:string;planId:string;reviewHash:string;at:number;jobs:number;pages:number;bytes:number;}
export interface CleanupView {stagedJobs:number;stagedBytes:number;plan:CleanupPlan|null;receipts:CleanupReceipt[];}
export const CleanupPublicSchemas=[z.strictObject({op:z.literal('sync_cleanup_view')}),z.strictObject({op:z.literal('sync_cleanup_preview'),before:z.number().int().positive().safe()}),z.strictObject({op:z.literal('sync_cleanup_confirm'),planId:z.string().uuid(),reviewHash:z.string().regex(/^[a-f0-9]{64}$/)})] as const;
