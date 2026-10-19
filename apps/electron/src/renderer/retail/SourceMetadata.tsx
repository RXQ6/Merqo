import {SourceMetadataInputSchema} from '../../../../../packages/retail-domain/src/source-metadata';
import type {SourceMetadataInput,EvidenceProvenance} from '../../../../../packages/retail-domain/src/source-metadata';
export type SourceDraft=Record<'sourceId'|'sourceName'|'sourceObservedAt'|'coverageStartInclusive'|'completeThroughExclusive',string>&{completeness:'complete'|'partial'};
export const emptySourceDraft=():SourceDraft=>({sourceId:'',sourceName:'',sourceObservedAt:'',coverageStartInclusive:'',completeThroughExclusive:'',completeness:'complete'});
const fields=[['sourceId','来源标识'],['sourceName','来源名称'],['sourceObservedAt','来源观测时间'],['coverageStartInclusive','来源覆盖开始（包含）'],['completeThroughExclusive','来源完整截止（不包含）']] as const;
export function parseSourceDraft(draft:SourceDraft):SourceMetadataInput|undefined{
 if(fields.every(([key])=>!draft[key].trim()))return undefined;
 const time=(value:string)=>(value.length===16?value+':00':value)+'+08:00';
 const parsed=SourceMetadataInputSchema.safeParse({...draft,sourceObservedAt:time(draft.sourceObservedAt),coverageStartInclusive:time(draft.coverageStartInclusive),completeThroughExclusive:time(draft.completeThroughExclusive),timezone:'Asia/Shanghai'});
 if(!parsed.success)throw new Error('来源元数据不完整或时间范围无效：'+parsed.error.issues.map(i=>i.message).join('；'));
 return parsed.data;
}
export function SourceMetadataEditor({value,onChange}:{value:SourceDraft;onChange:(v:SourceDraft)=>void}){
 return <details className="retail-source-metadata"><summary>来源与完整水位（可选）</summary><p>时间统一为北京时间。这里只记录导出方声明；不能据此证明平台身份，CSV仍仅用于分析。</p><div className="retail-mappings">{fields.map(([key,label])=><label key={key}>{label}<input aria-label={label} type={key==='sourceId'||key==='sourceName'?'text':'datetime-local'} maxLength={key==='sourceId'?128:200} value={value[key]} onChange={e=>onChange({...value,[key]:e.target.value})}/></label>)}<label>来源窗口完整性<select aria-label="来源窗口完整性" value={value.completeness} onChange={e=>onChange({...value,completeness:e.target.value as SourceDraft['completeness']})}><option value="complete">声明已完整</option><option value="partial">尚未完整</option></select></label></div></details>;
}
export function SourceMetadataSummary({provenance}:{provenance:EvidenceProvenance|undefined}){
 if(!provenance)return <p className="retail-muted">未提供来源观测时刻和完整水位；导入时间不能替代。</p>;
 return <section aria-label="来源元数据"><strong>{provenance.sourceName}</strong><p>来源标识：{provenance.sourceId} · {provenance.origin==='builtin_synthetic'?'内置合成业务时钟':'操作者声明，平台身份未独立验证'}</p><p>源观测：{provenance.sourceObservedAt}</p><p>覆盖范围：[{provenance.coverageStartInclusive}, {provenance.completeThroughExclusive}) · {provenance.completeness==='complete'?'声明完整':'尚未完整'} · Asia/Shanghai</p><p className="retail-muted">CSV内容摘要：{provenance.contentHash}</p></section>;
}
