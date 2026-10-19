import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RetailStore } from './store';
import { InvestigationStore } from './investigation-store';
import { DEMO_CSV } from './operations';
import { readTool, runInvestigation } from './investigations';
import { callReadonlyTool } from './readonly-tools';
import { exportInvestigation } from './investigation-export';
import { evidenceTimeContext, evidenceTimeIssue } from './evidence-policy';

test('real import, frozen tools, persistence and both exports retain business time independently of reimport', async () => {
  const dir=mkdtempSync(join(tmpdir(),'merqo-business-time-'));
  const data=new RetailStore(join(dir,'data.sqlite'));
  let runs=new InvestigationStore(join(dir,'runs.sqlite'));
  try {
    const csv=DEMO_CSV.replaceAll('2026-10-14','2020-01-14');
    data.import(csv,undefined,'csv');
    const record=data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!;
    const context=evidenceTimeContext(record);
    expect(evidenceTimeIssue(record)).toContain('业务日期');
    const tool=callReadonlyTool({scenario:'margin',evidence:record},'retail_get_data_health');
    if(!tool||typeof tool!=='object'||!('timeContext' in tool)||!('retrievedAt' in tool)||!('observedAt' in tool))throw new Error('Missing time envelope');
    expect(tool.timeContext).toEqual(context);
    expect(tool.retrievedAt).not.toBe(tool.observedAt);
    expect(readTool(record,'retail_get_data_health')).toMatchObject({timeContext:context});
    const run=runs.create(record,'replay').run;
    const report=await runInvestigation(run,null,async event=>{runs.update(run.id,{event});});
    runs.update(run.id,{report});
    data.import(csv.replace('桂花乌龙冷萃茶','修订商品名称'),undefined,'csv');
    expect(evidenceTimeIssue(data.snapshot().records.find(r=>r.row.sku_id==='TEA-500')!)).toContain('业务日期');
    runs.close(); runs=new InvestigationStore(join(dir,'runs.sqlite'));
    const saved=runs.get(run.id)!;
    const json=JSON.parse(exportInvestigation(saved,'json').content);
    expect(json.timeContext).toEqual(context);
    expect(json.investigation.evidence).toEqual(record);
    expect(exportInvestigation(saved,'md').content).toContain('源系统观测时刻：未知');
    expect(exportInvestigation(saved,'md').content).toContain('2020-01-15T00:00:00+08:00');
  } finally {runs.close();data.close();rmSync(dir,{recursive:true,force:true});}
});
