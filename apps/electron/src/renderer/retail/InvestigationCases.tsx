import {useEffect,useState} from 'react';
import type {AnyInvestigation} from '../../../../../packages/retail-domain/src/investigations';
import {workbenchRequest} from './workbench-api';
import {SimilarCases} from './SimilarCases';
export function InvestigationCases({run,onTask}:{run:AnyInvestigation;onTask:(id:string)=>void}){
 const [id,setId]=useState(''),[error,setError]=useState('');
 useEffect(()=>{let alive=true;setId('');setError('');void workbenchRequest({op:'wb_exp_resolve',recordId:run.evidence.id}).then(d=>{if(alive&&d.view==='resolved_product')setId(d.entity.id);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[run.id,run.evidence.id]);
 return error?<p role="alert">参考案例读取失败：{error}</p>:id?<SimilarCases key={run.id} entityId={id} investigationId={run.id} {...(run.report?{onTask}:{})}/>:null;
}
