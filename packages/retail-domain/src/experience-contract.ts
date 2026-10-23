import {z} from 'zod';
import {EnhancementSchemas,type EnhancementData,type ProductProfile,type CaseProfile} from './experience-enhancement';
import type {BusinessEvidence, BusinessCase, EntityDetail, EntitySummary} from './workbench-contract';
const hash=z.string().regex(/^[a-f0-9]{64}$/), id=z.string().uuid();
const scope={source:z.enum(['all','demo','csv']).default('all'),shop:z.string().trim().max(200).default('')};
export const ExperienceSchemas=[...EnhancementSchemas,
 z.strictObject({op:z.literal('wb_exp_resolve'),recordId:z.string().min(1).max(500)}),
 z.strictObject({op:z.literal('wb_exp_morning'),day:z.string().date(),...scope,refresh:z.boolean().default(false),snapshotId:id.optional()}),
 z.strictObject({op:z.literal('wb_exp_snooze'),snapshotId:id,key:hash,until:z.string().datetime({offset:true}).nullable(),reason:z.string().trim().min(1).max(500)}),
 z.strictObject({op:z.literal('wb_exp_product'),entityId:hash,start:z.string().date(),end:z.string().date()}),
 z.strictObject({op:z.literal('wb_exp_note'),entityId:hash,requestId:id,body:z.string().trim().min(1).max(2000)}),
 z.strictObject({op:z.literal('wb_exp_cases'),entityId:hash,investigationId:id.optional(),businessDate:z.string().date().optional(),search:z.string().trim().max(120).default(''),category:z.enum(['all','analysis','simulation']).default('all'),useFeedback:z.boolean().default(true),manage:z.boolean().default(false)}),
 z.strictObject({op:z.literal('wb_exp_reference'),investigationId:id,caseId:id}),
 z.strictObject({op:z.literal('wb_exp_feedback'),entityId:hash,caseId:id,helpful:z.boolean(),profileHash:hash.optional(),reason:z.string().trim().min(1).max(500)}),
] as const;
export type ExperienceRequest=z.infer<typeof ExperienceSchemas[number]>;
export interface MorningItem {key:string;kind:'risk'|'task'|'evidence';title:string;reason:string;priority:number;entityId:string;businessDate:string;source:'demo'|'csv';shop:string;taskId?:string;investigationId?:string;record?:BusinessEvidence;state:'new'|'ongoing'|'linked'|'done';snooze?:{until:string|null;reason:string};}
export interface MorningSnapshot {id:string;day:string;createdAt:string;source:'all'|'demo'|'csv';shop:string;items:MorningItem[];progress:Array<{taskId:string;title:string;status:string;at:string}>;warnings:string[];evidenceCount:number;latestDate:string|null;fingerprint:string;}
export interface ProductNote {id:string;entityId:string;body:string;at:string;actor:'本机操作人';}
export interface ProductEvent {id:string;at:string;businessDate:string;title:string;type:'evidence'|'investigation'|'decision'|'task'|'approval'|'execution'|'review'|'case'|'note';targetId:string;description:string;}
export interface CaseReference {investigationId:string;item:Pick<BusinessCase,'id'|'title'|'taskVersion'|'lesson'|'declaredOutcome'|'limitation'|'category'|'createdAt'>;profile?:CaseProfile;at:string;}
export interface CaseMatch {eligible:boolean;profile:CaseProfile;profileHash:string;baseScore:number;feedbackAdjustment:number;item:BusinessCase;score:number;reasons:string[];differences:string[];feedback?:{helpful:boolean;reason:string;current:boolean};}
export type ExperienceData=EnhancementData|
 {view:'resolved_product';entity:EntitySummary}|
 {view:'morning';snapshot:MorningSnapshot;history:Array<Pick<MorningSnapshot,'id'|'day'|'createdAt'>>;shops:string[];live:boolean}|
 {view:'product';profile:ProductProfile;detail:EntityDetail;notes:ProductNote[];events:ProductEvent[];entities:EntitySummary[]}|
 {view:'similar_cases';businessDate:string;items:CaseMatch[];references:CaseReference[];total:number};
