import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetailStore } from './store';
import { SignalStore } from './signal-store';
import { InvestigationStore } from './investigation-store';
import { matchRelatedEvidence } from './related-evidence';
import { callReadonlyTool, loadReadonlyRunScope } from './readonly-tools';
import { exportInvestigation } from './investigation-export';
import { runInvestigation, isSignalInvestigation, readTool } from './investigations';
import { runSignalInvestigation, readSignalTool } from './signal-investigations';
import { INVENTORY_DEMO } from './signals';
import type { SignalRecord } from './signals';

test('cross-scenario boundary, unknown spec, period mismatch, ambiguity and truncation remain explicit', () => {
  const dir=mkdtempSync(join(tmpdir(),'merqo-related-'));
  const data=new RetailStore(join(dir,'data'));const signals=new SignalStore(join(dir,'signals'));
  try {
    data.request({op:'demo'});signals.demo();
    const anchor=data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;
    const inv=signals.snapshot().records.find(r=>r.kind==='inventory'&&r.row.sku_id==='TEA-500')!;
    const ads=signals.snapshot().records.find(r=>r.kind==='ads'&&r.row.sku_id==='TEA-500')!;
    const foreign=(field:string,value:string):SignalRecord=>({...inv,id:field,row:{...inv.row,[field]:value}});
    const bundle=matchRelatedEvidence(anchor,[inv,ads,foreign('shop_id','elsewhere'),foreign('channel','other'),foreign('sku_id','OTHER'),foreign('date','2020-01-01'),{...inv,source:'csv'}]);
    expect(bundle.items).toHaveLength(2);
    expect(bundle.missingScenarios).toEqual([]);
    expect(bundle.items.every(i=>i.status==='context_only')).toBe(true);
    expect(bundle.items.find(i=>i.scenario==='inventory')!.reasons).toContain('业务窗口缺失或不一致，禁止合并');
    expect(bundle.items.find(i=>i.scenario==='ads')!.reasons).toContain('缺少可核对规格');
    const daily={...inv,row:{...inv.row,window_days:1,spec:anchor.row.spec},status:'normal' as const};
    expect(matchRelatedEvidence({...anchor,status:'normal'},[daily]).items[0]!.status).toBe('aligned');
    expect(matchRelatedEvidence(anchor,[{...daily,row:{...daily.row,spec:'wrong'}}]).items[0]!.reasons).toContain('规格不一致，禁止合并');
    const many=matchRelatedEvidence(anchor,Array.from({length:21},(_,n)=>({...daily,id:String(n)})));
    expect(many.items).toHaveLength(20);expect(many.truncated).toBe(true);
    expect(many.items.every(i=>i.status==='context_only'&&i.reasons.some(s=>s.includes('多条记录')))).toBe(true);
    expect(matchRelatedEvidence(anchor,[]).missingScenarios).toEqual(['inventory','ads']);
  } finally {data.close();signals.close();rmSync(dir,{recursive:true,force:true});}
});

test('worker-created bundle survives source correction, restart, MCP scope and exports; all three audits consume frozen context', async () => {
  const dir=mkdtempSync(join(tmpdir(),'merqo-related-worker-'));mkdirSync(join(dir,'retail'));
  const file=join(dir,'retail','operations.sqlite');const data=new RetailStore(file);const signals=new SignalStore(file+'.signals.sqlite');
  let runs:InvestigationStore|undefined;
  try {
    data.request({op:'demo'});signals.demo();
    for(const kind of ['margin','inventory','ads'] as const){
      const anchor=kind==='margin'?data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!:signals.snapshot().records.find(r=>r.kind===kind&&r.row.sku_id==='TEA-500')!;
      // Use the real trusted worker rather than constructing the bundle in this test.
      const proc=Bun.spawn(['bun','scripts/retailpilot-data-worker.ts',file],{stdin:'pipe',stdout:'pipe',stderr:'pipe'});
      proc.stdin.write(JSON.stringify({op:'investigate',recordId:anchor.id,scenario:kind,mode:'replay'}));proc.stdin.end();
      const output=await new Response(proc.stdout).text();const err=await new Response(proc.stderr).text();
      expect(await proc.exited,err+output).toBe(0);
      const reply=JSON.parse(output);expect(reply.ok,output).toBe(true);
      const run=reply.data[0];expect(run.relatedEvidence.items).toHaveLength(2);
      const context=structuredClone(run.relatedEvidence);
      runs=new InvestigationStore(file+'.investigations.sqlite');
      const saved=runs.get(run.id);
      const forged=async (name:string)=>{
        const body=isSignalInvestigation(saved)?readSignalTool(saved.evidence,name,saved.caseContext,saved.relatedEvidence):readTool(saved.evidence,name as 'retail_get_sku_context',saved.caseContext,saved.relatedEvidence);
        return name==='retail_get_sku_context'?{...(body as Record<string,unknown>),relatedEvidence:{...context,items:[]}}:body;
      };
      const rejected=isSignalInvestigation(saved)?runSignalInvestigation(saved,null,async()=>{},undefined,forged):runInvestigation(saved,null,async()=>{},undefined,forged);
      await expect(rejected).rejects.toThrow();
      const emit=async (event:import('./investigations').Trace)=>{runs!.update(run.id,{event});};
      const report=isSignalInvestigation(saved)?await runSignalInvestigation(saved,null,emit):await runInvestigation(saved,null,emit);
      runs.update(run.id,{report});runs.close();runs=undefined;
      signals.import('inventory',INVENTORY_DEMO.replace('桂花乌龙冷萃茶','修订库存名称'),undefined,'demo',true);
      const scope=loadReadonlyRunScope(dir,run.id);
      expect(scope.relatedEvidence).toEqual(context);
      expect(callReadonlyTool(scope,'retail_get_sku_context')).toMatchObject({data:{relatedEvidence:context}});
      runs=new InvestigationStore(file+'.investigations.sqlite',true);
      const restored=runs.get(run.id);
      expect(JSON.parse(exportInvestigation(restored,'json').content).relatedEvidence).toEqual(context);
      expect(exportInvestigation(restored,'md').content).toContain('跨场景旁证匹配');
      runs.close();runs=undefined;
    }
  } finally {runs?.close();data.close();signals.close();rmSync(dir,{recursive:true,force:true});}
},30000);
