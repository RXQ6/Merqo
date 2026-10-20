import {z} from 'zod';
import type {Quarantine} from './ingestion-contract';
export const IssueReviewSchema=z.strictObject({previewId:z.string().uuid(),expectedReviewId:z.string().uuid().nullable(),action:z.enum(['needs_source','mapping_reviewed','reprocess_linked']),reason:z.string().trim().min(10).max(1000),receiptId:z.string().uuid().optional()}).superRefine((v,c)=>{if(v.action==='reprocess_linked'&&!v.receiptId)c.addIssue({code:'custom',message:'关联重处理需要选择新入库回执'});if(v.action!=='reprocess_linked'&&v.receiptId)c.addIssue({code:'custom',message:'此动作不接受入库回执'});});
export type IssueReviewInput=z.infer<typeof IssueReviewSchema>;
export interface IssueReview extends IssueReviewInput {id:string;at:number;authority:'local_operator';}
export interface IngestionIssues {total:number;offset:number;limit:number;cases:Array<{previewId:string;jobId:string;createdAt:number;mappingRevision:number;quarantinedRecords:number;quarantine:Quarantine[];review:IssueReview|null}>;}
export const IngestionIssuePublicSchemas=[z.strictObject({op:z.literal('ingest_issues'),offset:z.number().int().min(0).max(100000).default(0),limit:z.number().int().min(1).max(30).default(20)}),IssueReviewSchema.safeExtend({op:z.literal('ingest_issue_review')})] as const;
