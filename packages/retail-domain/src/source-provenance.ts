import {createHash} from 'node:crypto';
import {evidenceTimeContext} from './evidence-policy';
import {SourceMetadataInputSchema} from './source-metadata';
import type {SourceMetadataInput,EvidenceProvenance} from './source-metadata';
type Row={date:string;window_days?:number|null;baseline_end_date?:string;baseline_window_days?:number|null};
/** CSV metadata is a bounded declaration, never upgraded to authenticated platform evidence. */
export function freezeSourceMetadata(source:'demo'|'csv',scenario:'margin'|'inventory'|'ads'|'transactions',csv:string,rows:Row[],importedAt:string,input?:SourceMetadataInput):EvidenceProvenance|undefined{
 const contentHash=createHash('sha256').update(csv).digest('hex');
 if(source==='csv'){
  if(!input)return undefined;const parsed=SourceMetadataInputSchema.parse(input);
  if(Date.parse(parsed.sourceObservedAt)>Date.parse(importedAt)+300000)throw new Error('源观测时间超前，请核对时区和导出时间');
  return {...parsed,origin:'operator_declared',identityAssurance:'unverified_declaration',contentHash};
 }
 if(input)throw new Error('内置演示来源由程序生成，不能提交外部来源声明');
 const periods=rows.flatMap(row=>{const time=evidenceTimeContext({source:'demo',importedAt,row});return[time.period,time.baselinePeriod].filter(p=>p!==null);});
 if(!periods.length)return undefined;
 const start=periods.reduce((a,p)=>Date.parse(p.startInclusive)<Date.parse(a)?p.startInclusive:a,periods[0]!.startInclusive);
 const end=periods.reduce((a,p)=>Date.parse(p.endExclusive)>Date.parse(a)?p.endExclusive:a,periods[0]!.endExclusive);
 return {sourceId:`merqo:demo:${scenario}`,sourceName:'Merqo内置合成数据',sourceObservedAt:end,coverageStartInclusive:start,completeThroughExclusive:end,completeness:'complete',timezone:'Asia/Shanghai',origin:'builtin_synthetic',identityAssurance:'builtin_fixture',contentHash};
}
