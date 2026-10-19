import {z} from 'zod';

const timestamp=z.string().datetime({offset:true});
export const SourceMetadataInputSchema=z.strictObject({
 sourceId:z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).refine(s=>!s.startsWith('merqo:demo:'),'内置演示来源标识保留'),
 sourceName:z.string().trim().min(1).max(200),sourceObservedAt:timestamp,
 coverageStartInclusive:timestamp,completeThroughExclusive:timestamp,
 completeness:z.enum(['complete','partial']),timezone:z.literal('Asia/Shanghai'),
}).refine(m=>Date.parse(m.coverageStartInclusive)<Date.parse(m.completeThroughExclusive),{message:'来源覆盖开始必须早于完整截止时间',path:['completeThroughExclusive']})
 .refine(m=>Date.parse(m.completeThroughExclusive)<=Date.parse(m.sourceObservedAt),{message:'完整水位不能晚于来源观测时间',path:['completeThroughExclusive']});
export type SourceMetadataInput=z.infer<typeof SourceMetadataInputSchema>;
export interface EvidenceProvenance extends SourceMetadataInput {origin:'builtin_synthetic'|'operator_declared';contentHash:string;identityAssurance:'builtin_fixture'|'unverified_declaration'}
export function sourceMetadataIssues(p:EvidenceProvenance|undefined,period:{startInclusive:string;endExclusive:string}|null,baseline?:{startInclusive:string;endExclusive:string}|null):string[]{
 if(!p)return ['缺少独立来源标识、源观测时间与完整水位'];
 const issues:string[]=[];
 if(p.completeness!=='complete')issues.push('来源声明窗口数据尚未完整');
 if(!period)issues.push('业务窗口未知，不能核对来源覆盖范围');
 else if(Date.parse(p.coverageStartInclusive)>Date.parse(period.startInclusive)||Date.parse(p.completeThroughExclusive)<Date.parse(period.endExclusive))issues.push('来源水位未覆盖本次完整业务窗口');
 if(baseline&&(Date.parse(p.coverageStartInclusive)>Date.parse(baseline.startInclusive)||Date.parse(p.completeThroughExclusive)<Date.parse(baseline.endExclusive)))issues.push('来源水位未覆盖基线业务窗口');
 if(p.origin==='operator_declared')issues.push('CSV来源元数据由操作者声明，未独立验证平台身份或结算完整性');
 return issues;
}
