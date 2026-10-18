import { beforeEach, afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { RetailStore } from './store';
import { InvestigationStore } from './investigation-store';
import { DEMO_CSV, RetailRequestSchema } from './operations';
import { readTool, runInvestigation, isSignalInvestigation } from './investigations';
let dir: string, file: string, data: RetailStore, runs: InvestigationStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'merqo-resume-')); file = join(dir, 'runs.sqlite'); data = new RetailStore(join(dir,'data.sqlite')); data.import(DEMO_CSV,undefined,'demo'); runs = new InvestigationStore(file); });
afterEach(() => { runs.close(); data.close(); rmSync(dir,{recursive:true,force:true}); });
const create = (mode: 'model'|'replay' = 'replay') => runs.create(data.snapshot().records.find(r => r.row.sku_id==='TEA-500')!,mode).run;

test('pause is durable, exact-epoch resume fences all late writes and preserves frozen evidence', async () => {
  const run = create();
  for (const tool of ['retail_get_data_health','retail_get_sku_context'] as const) runs.update(run.id,{event:{at:run.createdAt,stage:'investigate',tool,evidenceId:`${run.recordId}:${tool}`,data:readTool(run.evidence,tool)}});
  const paused=runs.control(run.id,0,'pause'); expect(paused.state).toBe('paused'); expect(paused.epoch).toBe(1);
  expect(()=>runs.update(run.id,{expectedEpoch:0,error:'late error'})).toThrow('旧调查');
  runs.close(); runs=new InvestigationStore(file);
  expect(runs.get(run.id).state).toBe('paused');
  data.import(DEMO_CSV.replace(',CNY,10000,2000,1000,',',CNY,10000,0,0,'),undefined,'demo');
  const resumed=runs.control(run.id,1,'resume'); if(isSignalInvestigation(resumed))throw new Error('fixture');
  expect(resumed.evidence).toEqual(run.evidence); expect(resumed.epoch).toBe(2);
  const report=await runInvestigation(resumed,null,async event=>{runs.update(run.id,{expectedEpoch:2,event});});
  runs.update(run.id,{expectedEpoch:2,report});
  expect(runs.get(run.id).state).toBe('needs_evidence'); expect(report.scenarios[0]!.marginBps).toBe(1429);
  expect(runs.get(run.id).trace.filter(t=>t.stage==='investigate')).toHaveLength(4);
  expect(()=>runs.control(run.id,1,'resume')).toThrow('版本');
  expect(()=>runs.update(run.id,{expectedEpoch:0,report})).toThrow('旧调查');
});

test('resume never resets call budget or duplicates an active investigation', () => {
  const run=create('model');
  for(let i=0;i<14;i++)runs.update(run.id,{event:{at:run.createdAt,stage:'budget',tool:'model_request',evidenceId:`call:${i}`,data:{index:i+1}}});
  expect(()=>runs.update(run.id,{event:{at:run.createdAt,stage:'budget',tool:'model_request',evidenceId:'call:15',data:{}}})).toThrow('预算');
  runs.control(run.id,0,'pause'); expect(()=>runs.control(run.id,1,'resume')).toThrow('预算');
  const another=create();runs.control(another.id,0,'pause');runs.create(another.evidence,'replay',true);
  expect(()=>runs.control(another.id,1,'resume')).toThrow('进行中');
});

test('interrupted lease can explicitly continue with a new deadline, while completed reports cannot resume', () => {
  const run=create(); const db=new Database(file); db.query('UPDATE investigations SET deadline_at=? WHERE id=?').run('2000-01-01T00:00:00Z',run.id);db.close();
  expect(runs.listAll()[0]!.state).toBe('failed');
  const resumed=runs.control(run.id,0,'resume');expect(resumed.state).toBe('running');expect(Date.parse(resumed.deadlineAt)).toBeGreaterThan(Date.now());
  expect(runs.listAll()[0]!.state).toBe('running');
  expect(()=>runs.control(run.id,0,'pause')).toThrow('版本');
  expect(RetailRequestSchema.safeParse({op:'investigation_resume',id:run.id,expectedEpoch:1,workspace:'other'}).success).toBe(false);
});
