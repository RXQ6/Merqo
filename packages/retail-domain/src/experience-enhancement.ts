import {z} from 'zod';
import type {MorningSnapshot} from './experience-contract';
import type {BusinessCase} from './workbench-contract';
export const Anomaly=z.enum(['low_margin','needs_evidence','inventory_warning','ads_warning']);
export const anomalyNames={low_margin:'毛利偏低',needs_evidence:'证据不足',inventory_warning:'库存风险',ads_warning:'广告回报异常'};
const tags=z.array(z.string().trim().min(1).max(30)).max(10).transform(v=>[...new Set(v)]);
const id=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),version=z.number().int().min(0);
export const CaseProfileFields=z.strictObject({category:z.string().trim().max(80),tags,anomalies:z.array(Anomaly).max(4),conditions:z.string().trim().max(2000),exclusions:z.string().trim().max(2000),validFrom:z.union([z.literal(''),z.string().date()]),validTo:z.union([z.literal(''),z.string().date()]),enabled:z.boolean()}).refine(v=>!v.validFrom||!v.validTo||v.validFrom<=v.validTo,'适用日期顺序错误');
export type CaseProfile=z.infer<typeof CaseProfileFields>&{version:number;updatedAt:string};
export interface ProductProfile{version:number;category:string;tags:string[];updatedAt:string;}
export const BriefOutput=z.strictObject({body:z.string().trim().min(1).max(6000).refine(v=>!/[0-9０-９¥￥%％]/.test(v),'AI 摘要仅允许定性说明，数值请查原始事项'),citations:z.array(hash).min(1).max(20)});
export const EnhancementSchemas=[
 z.strictObject({op:z.literal('wb_exp_product_profile'),entityId:hash,expectedVersion:version,category:z.string().trim().max(80),tags}),
 z.strictObject({op:z.literal('wb_exp_case_profile'),entityId:hash,caseId:id,expectedVersion:version,profile:CaseProfileFields}),
 z.strictObject({op:z.literal('wb_exp_case_history'),caseId:id}),
 z.strictObject({op:z.literal('wb_exp_briefs'),snapshotId:id}),
 z.strictObject({op:z.literal('wb_exp_brief_start'),snapshotId:id,requestId:id}),
 z.strictObject({op:z.literal('wb_exp_brief_edit'),id,expectedVersion:z.number().int().positive(),body:z.string().trim().min(1).max(6000)}),
] as const;
export type EnhancementRequest=z.infer<typeof EnhancementSchemas[number]>;
export interface MorningBrief{id:string;snapshotId:string;snapshotHash:string;version:number;status:'pending'|'completed'|'failed';body:string;originalBody:string;citations:string[];model:string|null;edited:boolean;createdAt:string;updatedAt:string;deadlineAt:string;error:string|null;}
export type EnhancementData={view:'briefs';items:MorningBrief[];versions:MorningBrief[];created?:boolean;context?:MorningSnapshot}|{view:'case_profile_history';items:CaseProfile[]};
export interface RankedCase {eligible:boolean;item:BusinessCase;profile:CaseProfile;profileHash:string;score:number;baseScore:number;feedbackAdjustment:number;reasons:string[];differences:string[];feedback?:{helpful:boolean;reason:string;current:boolean};}
