import {test,expect} from 'bun:test';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {RetailStore} from './store';import {InvestigationStore} from './investigation-store';import {DEMO_CSV,RetailRequestSchema} from './operations';import {runInvestigation,isSignalInvestigation,readTool} from './investigations';import {freshSupplementEvidence} from './supplement';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'merqo-supplement-')),data=new RetailStore(join(dir,'data.sqlite')),runs=new InvestigationStore(join(dir,'runs.sqlite'));data.import(DEMO_CSV,undefined,'demo');const current=()=>data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;return{dir,data,runs,current,close(){runs.close();data.close();rmSync(dir,{recursive:true,force:true});}};}
test('supplement creates a new reviewed lineage, rejects stale preview and preserves parent and deduplicates repeated confirmation; only two rounds',async()=>{
 const f=fixture();try{const parent=f.runs.create(f.current(),'replay').run;
 const complete=async(id:string)=>{const run=f.runs.get(id);if(isSignalInvestigation(run))throw Error('fixture');const report=await runInvestigation(run,null,async event=>{f.runs.update(id,{event});});f.runs.update(id,{report});};
 await complete(parent.id);const before=f.runs.get(parent.id);expect(()=>f.runs.supplementPreview(parent.id,f.current())).toThrow('尚未更新');
 f.data.import(DEMO_CSV.replace('桂花乌龙冷萃茶','补证商品名'),undefined,'demo');const first=f.runs.supplementPreview(parent.id,f.current());expect(first.round).toBe(1);
 f.data.import(DEMO_CSV.replace('桂花乌龙冷萃茶','再次修订名称'),undefined,'demo');expect(()=>f.runs.supplement(parent.id,first.expectedEpoch,f.current(),first.hash)).toThrow('已变化');
 const preview=f.runs.supplementPreview(parent.id,f.current()),child=f.runs.supplement(parent.id,preview.expectedEpoch,f.current(),preview.hash);expect(child.created).toBe(true);expect(child.run.id).not.toBe(parent.id);expect(child.run.supplement).toEqual({parentRunId:parent.id,round:1,previewHash:preview.hash});expect(child.run.report).toBeNull();expect(child.run.trace).toEqual([]);expect(f.runs.supplement(parent.id,preview.expectedEpoch,f.current(),preview.hash)).toMatchObject({created:false,run:{id:child.run.id}});
 await complete(child.run.id);expect(f.runs.get(parent.id)).toEqual(before);f.data.import(DEMO_CSV.replace('桂花乌龙冷萃茶','第二轮补证名称'),undefined,'demo');const p2=f.runs.supplementPreview(child.run.id,f.current()),c2=f.runs.supplement(child.run.id,p2.expectedEpoch,f.current(),p2.hash);expect(c2.run.supplement?.round).toBe(2);await complete(c2.run.id);expect(()=>f.runs.supplementPreview(c2.run.id,f.current())).toThrow('两轮');expect(()=>f.runs.supplementPreview(parent.id,{...f.current(),source:'csv'})).toThrow('唯一新版');
 }finally{f.close();}
});
test('supplement refuses scope/spec/source swaps and running-parent replacement; renderer cannot submit arbitrary evidence',()=>{
 const f=fixture();try{const run=f.runs.create(f.current(),'replay').run;expect(()=>f.runs.supplementPreview(run.id,f.current())).toThrow('暂停');
 expect(()=>freshSupplementEvidence(run,[{...f.current(),row:{...f.current().row,shop_id:'elsewhere'}}])).toThrow('唯一新版');
 expect(()=>freshSupplementEvidence(run,[{...f.current(),row:{...f.current().row,spec:'other'}}])).toThrow('规格');
 expect(()=>freshSupplementEvidence(run,[{...f.current(),provenance:{...f.current().provenance!,sourceId:'other'}}])).toThrow('来源标识');
 expect(RetailRequestSchema.safeParse({op:'investigation_supplement',id:run.id,expectedEpoch:0,previewHash:'0'.repeat(64),evidence:f.current()}).success).toBe(false);
 }finally{f.close();}
});
test('persisted thirty-tool cap is independent of model budget and resume never resets consumed tools',async()=>{
 const f=fixture();try{const run=f.runs.create(f.current(),'replay').run;const event={at:run.createdAt,stage:'investigate' as const,tool:'retail_get_data_health',evidenceId:`${run.recordId}:retail_get_data_health`,data:readTool(run.evidence,'retail_get_data_health')};for(let i=0;i<30;i++)f.runs.update(run.id,{event});expect(()=>f.runs.update(run.id,{event})).toThrow('30次');f.runs.control(run.id,0,'pause');const resumed=f.runs.control(run.id,1,'resume');if(isSignalInvestigation(resumed))throw Error('fixture');let toolCalls=0;await expect(runInvestigation(resumed,null,async()=>{},undefined,async()=>{toolCalls++;return {};})).rejects.toThrow('30次');expect(toolCalls).toBe(0);expect(f.runs.get(run.id).trace.filter(t=>t.stage==='investigate')).toHaveLength(30);
 }finally{f.close();}
});
