import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {RetailStore} from './store';import {SignalStore} from './signal-store';import {InvestigationStore} from './investigation-store';
import {DEMO_CSV,RetailRequestSchema} from './operations';import {INVENTORY_DEMO,ADS_DEMO} from './signals';
import {SourceMetadataInputSchema} from './source-metadata';import type {SourceMetadataInput} from './source-metadata';
import {freezeSourceMetadata} from './source-provenance';import {evidenceTimeContext,evidenceTimeIssue} from './evidence-policy';
import {runInvestigation} from './investigations';import {callReadonlyTool} from './readonly-tools';import {exportInvestigation} from './investigation-export';
const metadata:SourceMetadataInput={sourceId:'export:shop:test',sourceName:'测试店铺导出声明',sourceObservedAt:'2026-10-15T09:00:00+08:00',coverageStartInclusive:'2026-09-01T00:00:00+08:00',completeThroughExclusive:'2026-10-15T00:00:00+08:00',completeness:'complete',timezone:'Asia/Shanghai'};
const now='2026-10-15T10:00:00+08:00';
test('source metadata validates bounded identity, ordered watermarks and observation clock without accepting authenticity claims',()=>{
 expect(SourceMetadataInputSchema.safeParse(metadata).success).toBe(true);
 for(const invalid of [{sourceId:'merqo:demo:margin'},{completeThroughExclusive:'2026-10-16T00:00:00+08:00'},{coverageStartInclusive:metadata.completeThroughExclusive},{identityAssurance:'authenticated'},{timezone:'UTC'}])expect(SourceMetadataInputSchema.safeParse({...metadata,...invalid}).success).toBe(false);
 expect(()=>freezeSourceMetadata('csv','margin','csv',[],now,{...metadata,sourceObservedAt:'2026-10-16T09:00:00+08:00'})).toThrow('超前');
 expect(()=>freezeSourceMetadata('demo','margin','csv',[],now,metadata)).toThrow('演示');
 expect(RetailRequestSchema.safeParse({op:'import',csv:DEMO_CSV,mapping:{},sourceMetadata:metadata}).success).toBe(true);
 expect(RetailRequestSchema.safeParse({op:'import',csv:DEMO_CSV,mapping:{},sourceMetadata:{...metadata,origin:'builtin_synthetic'}}).success).toBe(false);
});
test('CSV provenance binds content, deduplicates full declarations, persists frozen tool/report metadata and never backfills old imports',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-source-')),file=join(dir,'data.sqlite');let data=new RetailStore(file);const runsFile=join(dir,'runs.sqlite');let runs=new InvestigationStore(runsFile);
 try{
  data.import(DEMO_CSV,undefined,'csv');const legacy=data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;expect(legacy.provenance).toBeUndefined();expect(evidenceTimeContext(legacy).sourceObservedAt).toBeNull();
  const legacyRun=runs.create(legacy,'replay').run;
  data.import(DEMO_CSV,undefined,'csv',false,metadata);const record=data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;
  expect(record.provenance).toMatchObject({...metadata,origin:'operator_declared',identityAssurance:'unverified_declaration',contentHash:createHash('sha256').update(DEMO_CSV).digest('hex')});expect(record.batchId).not.toBe(legacy.batchId);
  data.import(DEMO_CSV,undefined,'csv',false,metadata);expect(data.snapshot().batches).toHaveLength(2);expect(data.snapshot().records.find(r=>r.id===record.id)?.importedAt).toBe(record.importedAt);
  const run=runs.create(record,'replay').run;const report=await runInvestigation(run,null,async event=>{runs.update(run.id,{event});});runs.update(run.id,{report});
  expect(report.unknowns.some(u=>u.includes('未独立验证'))).toBe(true);
  expect(callReadonlyTool({scenario:'margin',evidence:record},'retail_get_data_health')).toMatchObject({timeContext:{sourceObservedAt:metadata.sourceObservedAt,sourceMetadata:record.provenance}});
  data.import(DEMO_CSV,undefined,'csv',false,{...metadata,sourceName:'修订声明'});expect(data.snapshot().batches).toHaveLength(3);
  runs.close();runs=new InvestigationStore(runsFile);data.close();data=new RetailStore(file);
  expect(runs.get(legacyRun.id)!.evidence.provenance).toBeUndefined();expect(runs.get(run.id)!.evidence.provenance).toEqual(record.provenance);
  expect(data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')?.provenance?.sourceName).toBe('修订声明');
  const saved=runs.get(run.id)!;expect(JSON.parse(exportInvestigation(saved,'json').content).timeContext.sourceMetadata).toEqual(record.provenance);
  const md=exportInvestigation(saved,'md').content;expect(md).toContain('来源与完整水位');expect(md).toContain(metadata.sourceObservedAt);expect(md).toContain('unverified_declaration');
  const before=data.snapshot().batches.length;expect(()=>data.import(DEMO_CSV,undefined,'csv',false,{...metadata,sourceObservedAt:'2099-01-01T00:00:00+08:00'})).toThrow('超前');expect(data.snapshot().batches).toHaveLength(before);
 }finally{runs.close();data.close();rmSync(dir,{recursive:true,force:true});}
});
test('all scene imports persist declarations while builtin clocks are explicitly synthetic and stable across reload',()=>{
 const dir=mkdtempSync(join(tmpdir(),'merqo-source-scenes-'));const data=new RetailStore(join(dir,'data.sqlite'));let signals=new SignalStore(join(dir,'signals.sqlite'));
 try{
  for(const [kind,csv] of [['inventory',INVENTORY_DEMO],['ads',ADS_DEMO]] as const){signals.import(kind,csv,undefined,'csv',false,metadata);const row=signals.snapshot().records.find(r=>r.kind===kind)!;expect(row.provenance?.sourceId).toBe(metadata.sourceId);expect(row.provenance?.contentHash).toBe(createHash('sha256').update(csv).digest('hex'));}
  signals.close();signals=new SignalStore(join(dir,'signals.sqlite'));expect(signals.snapshot().records.every(r=>r.provenance?.identityAssurance==='unverified_declaration')).toBe(true);
  data.import(DEMO_CSV,undefined,'demo');const first=data.snapshot().records[0]!;expect(first.provenance?.origin).toBe('builtin_synthetic');expect(first.provenance?.sourceObservedAt).not.toBe(first.importedAt);expect(first.provenance?.sourceObservedAt).toBe(first.provenance?.completeThroughExclusive);
  data.import(DEMO_CSV,undefined,'demo',true);expect(data.snapshot().batches).toHaveLength(1);expect(data.snapshot().records[0]?.provenance).toEqual(first.provenance);
  signals.demo();for(const record of signals.snapshot().records.filter(r=>r.source==='demo')){expect(evidenceTimeContext(record).sourceMetadataIssues).toEqual([]);expect(evidenceTimeContext(record).limitation).toContain('合成业务时钟');}
 }finally{data.close();signals.close();rmSync(dir,{recursive:true,force:true});}
});
test('observed age, partial watermarks, current and baseline coverage stay independent of import time',()=>{
 const p=freezeSourceMetadata('csv','margin',DEMO_CSV,[],now,metadata)!;const evidence={source:'csv' as const,importedAt:now,row:{date:'2026-10-14'},provenance:p};const clock=Date.parse(now);
 expect(evidenceTimeIssue(evidence,clock)).toBeNull();
 expect(evidenceTimeIssue({...evidence,provenance:{...p,sourceObservedAt:'2026-10-13T09:00:00+08:00'}},clock)).toContain('来源观测超过24小时');
 expect(evidenceTimeIssue({...evidence,provenance:{...p,completeness:'partial'}},clock)).toContain('尚未完整');
 expect(evidenceTimeIssue({...evidence,provenance:{...p,completeThroughExclusive:'2026-10-14T12:00:00+08:00'}},clock)).toContain('未覆盖完整业务窗口');
 const baseline={...evidence,row:{date:'2026-10-14',window_days:1,baseline_end_date:'2026-10-13',baseline_window_days:1},provenance:{...p,coverageStartInclusive:'2026-10-14T00:00:00+08:00'}};
 expect(evidenceTimeIssue(baseline,clock)).toContain('基线');expect(evidenceTimeContext(baseline).sourceMetadataIssues).toContain('来源水位未覆盖基线业务窗口');
 expect(evidenceTimeContext({source:evidence.source,importedAt:evidence.importedAt,row:evidence.row}).sourceObservedAtStatus).toBe('not_provided');
});
