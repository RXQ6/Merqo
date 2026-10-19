import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { cpus, totalmem, release } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ADS_DEMO, INVENTORY_DEMO } from '../packages/retail-domain/src/signals';
import type { SignalKind } from '../packages/retail-domain/src/signals';
import { requestRetailWorker } from '../apps/electron/src/main/retail-worker';

const resume = process.argv[2] === '--resume' && process.argv.length === 4;
if (process.argv.length > 2 && !resume) throw new Error('Only --resume <isolated .runtime/signal-performance-* directory> is accepted');
const out = resolve('artifacts/signal-performance', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const runtime = resolve('.runtime'); mkdirSync(runtime, {recursive:true});
const dir = resume ? resolve(process.argv[3]!) : mkdtempSync(join(runtime, 'signal-performance-'));
const taskRelative = relative(runtime, dir);
if (taskRelative.startsWith('..') || !taskRelative.startsWith('signal-performance-') || taskRelative.includes('/') || taskRelative.includes('\\')) throw new Error('Performance data must be an isolated direct child of .runtime');
if (!resume) mkdirSync(join(dir, 'retail'));
const request = (payload: unknown, operation: string) => requestRetailWorker({rootPath:dir,name:'Signal performance isolated synthetic'}, 'signal-performance', payload, operation);
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const totals = { total:100000, warning:33334, normal:33333, missing:33333 };
const datasets: Record<string, unknown> = {}, results: Record<string, unknown> = {};
let report: Record<string, unknown> = {passed:false};
try {
  for (const kind of ['inventory', 'ads'] as const) {
    const [header, ...samples] = (kind === 'inventory' ? INVENTORY_DEMO : ADS_DEMO).split('\n');
    const fields = header!.split(',');
    const lines = [header!];
    for (let i=0;i<100000;i++) {
      const row = samples[i%3]!.split(','); row[fields.indexOf('sku_id')] = `SKU-${String(i).padStart(6,'0')}`;
      row[fields.indexOf('shop_id')] = `shop-${i%20}`;
      lines.push(row.join(','));
    }
    const csv = lines.join('\n');
    datasets[kind] = {sha256:hash(csv),rows:100000,characters:csv.length,utf8Bytes:Buffer.byteLength(csv),expected:totals};
    const before = performance.now();
    const imported = resume ? await request({op:'signals_page',kind,source:'csv',limit:1},'signals_page') : await request({op:'signals_import',kind,csv,mapping:Object.fromEntries(fields.map(field=>[field,field]))}, 'signals_import');
    if (!imported.ok || (imported.kind !== 'signals' && imported.kind !== 'signals_page') || imported.data.records.length > 30 || imported.data.pagination?.summary[kind].total !== 100000) throw new Error(`${kind}: invalid import result`);
    results[kind] = resume ? {importSkippedExistingSource:true} : {importMs:performance.now()-before};
    console.log(JSON.stringify({phase:'imported',kind,rows:100000,...results[kind] as object}));
  }
  let passed = true;
  for (const kind of ['inventory', 'ads'] as const satisfies readonly SignalKind[]) {
    const timings: number[] = [];
    for (let i=0;i<30;i++) {
      const shop = i%3===2 ? 'shop-0' : undefined;
      const warningOnly = i%3===1;
      const before = performance.now();
      const reply = await request({op:'signals_page',kind,source:'csv',shop,status:warningOnly?'warning':'all',offset:i%3===0?90000:i*30,limit:30}, 'signals_page');
      timings.push(performance.now()-before);
      if (!reply.ok || reply.kind !== 'signals_page' || reply.data.records.length > 30) throw new Error(`${kind}: unbounded or invalid query result`);
      const summary = reply.data.pagination.summary[kind];
      // Generated indices establish the oracle independently of the domain calculator.
      const expected = shop ? {total:5000,warning:1667,normal:1666,missing:1667} : totals;
      if (JSON.stringify(summary) !== JSON.stringify({total:expected.total,normal:expected.normal,warning:expected.warning,missing:expected.missing})) throw new Error(`${kind}: incorrect full-scope counts`);
      if (reply.data.pagination.total !== (warningOnly?expected.warning:expected.total)) throw new Error(`${kind}: incorrect filtered count`);
      if (reply.data.records.some(row=>row.kind!==kind||row.source!=='csv'||(shop&&row.row.shop_id!==shop)||(warningOnly&&row.status!=='warning'))) throw new Error(`${kind}: scope leak`);
    }
    const sorted = [...timings].sort((a,b)=>a-b), p95Ms=sorted[Math.ceil(sorted.length*.95)-1]!;
    results[kind] = {...results[kind] as object,queries:30,timings,p95Ms,passed:p95Ms<=2000};
    passed &&= p95Ms<=2000;
    console.log(JSON.stringify({phase:'queried',kind,p95Ms,passed:p95Ms<=2000}));
  }
  const checkView=await request({op:'checks'},'checks');
  if(!checkView.ok||checkView.kind!=='checks')throw new Error('Missing check configuration');
  await request({op:'check_configure',expectedRevision:checkView.data.config.revision,config:{enabled:false,intervalMinutes:60,source:'csv'}}, 'check_configure');
  const interrupted=checkView.data.runs.find(run=>run.status==='interrupted'||run.status==='failed');
  const checkStart=performance.now(); const checked=await request(interrupted?{op:'check_retry',id:interrupted.id}:{op:'check_run'}, interrupted?'check_retry':'check_run');
  if (!checked.ok || checked.kind !== 'checks') throw new Error('Missing large-source check result');
  const run = checked.data.runs[0];
  if (run?.status!=='succeeded' || run.result?.checked!==200000 || run.result.anomalies!==133334 || run.result.findings.length!==200) throw new Error('Large-source scheduled check did not preserve full counts or bounded findings');
  const check = {elapsedMs:performance.now()-checkStart,checked:run.result.checked,anomalies:run.result.anomalies,newFindings:run.result.newFindings,previewRows:run.result.findings.length,truncated:run.result.truncated};
  // A full source permits corrections but rejects a new entity atomically.
  const extra = INVENTORY_DEMO.split('\n');
  const fields = extra[0]!.split(','); const cells=extra[1]!.split(','); cells[fields.indexOf('sku_id')]='OVER-CAPACITY';
  const overflow=await request({op:'signals_import',kind:'inventory',csv:[extra[0],cells.join(',')].join('\n'),mapping:Object.fromEntries(fields.map(field=>[field,field]))}, 'signals_import');
  if(overflow.ok || !overflow.error.includes('100,000')) throw new Error('Capacity overflow was not blocked');
  const unchanged=await request({op:'signals_page',kind:'inventory',source:'csv',limit:1}, 'signals_page');
  if(!unchanged.ok||unchanged.kind!=='signals_page'||unchanged.data.pagination.total!==100000)throw new Error('Overflow changed source contents');
  const db=new Database(join(dir,'retail/operations.sqlite.signals.sqlite'),{readonly:true});
  let queryPlan: unknown[];
  try { queryPlan=db.query("EXPLAIN QUERY PLAN SELECT evidence_json FROM signal_query_records WHERE kind='inventory' AND source='csv' ORDER BY kind,source,shop,date DESC,sku,id LIMIT 30 OFFSET 90000").all(); } finally {db.close();}
  const sourceFiles=['packages/retail-domain/src/signal-store.ts','packages/retail-domain/src/signal-query.ts','packages/retail-domain/src/signals.ts','packages/retail-domain/src/signal-page.ts','packages/retail-domain/src/operations.ts','packages/retail-domain/src/scheduled-checks.ts','scripts/retailpilot-data-worker.ts','apps/electron/src/main/retail-worker.ts'];
  report={passed,evaluatedAt:new Date().toISOString(),resumed:resume,datasets,results,check,overflowBlocked:true,queryPlan,sourceHashes:Object.fromEntries(sourceFiles.map(file=>[file,hash(readFileSync(file))])),machine:{platform:process.platform,arch:process.arch,osRelease:release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,memoryBytes:totalmem(),bun:Bun.version},cache:'OS/SQLite warm after actual worker CSV import and projection build; new process and connection for each of 30 measured requests per scenario',scope:'Inventory and ads full counts, warning filter, shop filter, deep/first pages. Includes worker launch and JSON transport. Fresh import includes initial projection; resumed runs do not measure import. No model calls, renderer timing, cold disk or concurrent write benchmark.'};
  if(!passed)process.exitCode=1;
} catch(error) {report={passed:false,datasets,results,error:error instanceof Error?error.message:String(error)};process.exitCode=1;}
finally {
  writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2));
  // Retain failures in the workspace for inspectable retry; command sandbox temp folders do not survive a run.
  if(report.passed) { try {rmSync(dir,{recursive:true,force:true});} catch(error) {console.log(JSON.stringify({cleanupPending:dir,error:String(error)}));} }
  console.log(JSON.stringify({out,passed:report.passed,error:report.error,...(!report.passed?{retainedDirectory:dir}:{})}));
}
