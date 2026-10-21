import {z} from 'zod';
export const BackupPassword=z.string().min(12,'备份密码至少12个字符').max(256);
export const BackupPublicSchemas=[
 z.strictObject({op:z.literal('backup_create'),password:BackupPassword}),
 z.strictObject({op:z.literal('backup_preview'),password:BackupPassword}),
 z.strictObject({op:z.literal('backup_restore'),token:z.string().uuid(),password:BackupPassword,name:z.string().trim().min(1).max(80),confirmed:z.literal(true)}),
] as const;
export interface BackupSummary {id:string;createdAt:number;workspaceName:string;files:Array<{name:string;bytes:number;sha256:string}>;credentialCount:number;bytes:number;}
export interface BackupResult {action:'created'|'preview'|'restored'|'cancelled';summary?:BackupSummary;token?:string;path?:string;workspaceId?:string;}
